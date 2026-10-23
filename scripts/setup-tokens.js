'use strict';

/**
 * One-off setup, run once per database (SQLite, then Postgres), in production mode like the
 * real runs:
 *   NODE_ENV=production DATABASE_CLIENT=sqlite   node scripts/setup-tokens.js
 *   NODE_ENV=production DATABASE_CLIENT=postgres node scripts/setup-tokens.js
 *
 * It creates the admin account, a test user for the login scenario and three API tokens,
 * checks that the Public and Authenticated roles have no content permissions, and writes
 * every secret to .generated/ (git-ignored). Nothing secret is printed.
 *
 * Why once per database: SQLite and Postgres are separate databases, so each has its own
 * admin, users and tokens. A token created on one does not work on the other.
 * Run it with Strapi stopped: it boots its own Strapi instance and exits.
 *
 * Order matters: run this first, then the data generator, then save the reset snapshot.
 * A snapshot taken before this script would wipe the tokens when restored.
 *
 * Do not re-run this script after taking the reset snapshot. A re-run rotates the token
 * keys and the login user's password, so a restored snapshot would no longer match the
 * files. If you do re-run it, take a new snapshot afterwards.
 *
 * API_TOKEN_SALT in strapi-app/.env must not change afterwards: token keys are hashed
 * with it, so a new salt makes every token invalid.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { createRequire } = require('module');

const REPO_ROOT = path.join(__dirname, '..');
const APP_DIR = path.join(REPO_ROOT, 'strapi-app');
const OUT_DIR = path.join(REPO_ROOT, '.generated');

// This script lives outside strapi-app, so packages are resolved from there.
// Strapi also treats the current folder as the app folder.
const appRequire = createRequire(path.join(APP_DIR, 'package.json'));
const { createStrapi, compileStrapi } = appRequire('@strapi/strapi');
appRequire('dotenv').config({ path: path.join(APP_DIR, '.env') });
process.chdir(APP_DIR);

const database = process.env.DATABASE_CLIENT || 'sqlite';
if (!['sqlite', 'postgres'].includes(database)) {
  throw new Error(`DATABASE_CLIENT must be sqlite or postgres, got "${database}".`);
}
// The real runs use production mode, so the setup loads the same configuration.
if (process.env.NODE_ENV !== 'production') {
  throw new Error('Run this with NODE_ENV=production, as the real runs do.');
}

const ADMIN_EMAIL = 'admin@example.com';
const LOGIN_USER_EMAIL = 'loadtest-user@example.com';

// The three files this script writes for the chosen database.
const ADMIN_FILE = `admin-${database}.json`;
const LOGIN_USER_FILE = `login-user-${database}.json`;
const TOKENS_FILE = `tokens-${database}.json`;

// Least privilege: the readers can only read, the writers can only create and update
// Articles. The seed token is for the data generator only and is never given to k6.
const TOKENS = [
  {
    key: 'readOnly',
    name: 'Load test - read only',
    description: 'Read access to every content type. Used by the reader scenarios and the read-back.',
    type: 'read-only',
  },
  {
    key: 'writer',
    name: 'Load test - writer',
    description: 'Create and update Articles, and link an Author and a Category.',
    type: 'custom',
    // Strapi refuses a relation in an Article payload unless the token can also "find" the
    // target type. Only find is checked, so no findOne and no delete.
    permissions: [
      'api::article.article.create',
      'api::article.article.update',
      'api::author.author.find',
      'api::category.category.find',
    ],
  },
  {
    key: 'seed',
    name: 'Seed - data generator only',
    description: 'Creates the test data. Never given to k6.',
    type: 'custom',
    permissions: [
      'api::article.article.create',
      'api::article.article.update',
      'api::author.author.create',
      'api::author.author.update',
      'api::category.category.create',
      'api::category.category.update',
      // Same reason as the writer: linking an Author or Category needs find on that type.
      'api::author.author.find',
      'api::category.category.find',
      'plugin::upload.content-api.upload',
    ],
  },
];

// Letters and a digit are added so the password meets Strapi's admin password rules.
const randomPassword = () => crypto.randomBytes(18).toString('base64url') + 'Aa1';

// Checked for every file BEFORE Strapi boots, so nothing is created if a file would be
// tracked. Otherwise the admin could exist in the database with a password nobody saved.
function assertIgnored(fileName) {
  const relative = path.posix.join('.generated', fileName);
  try {
    execFileSync('git', ['check-ignore', '-q', relative], { cwd: REPO_ROOT });
  } catch {
    throw new Error(`${relative} is not git-ignored, refusing to run.`);
  }
}

function writeSecret(fileName, data) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, fileName), JSON.stringify(data, null, 2));
  console.log(`Wrote .generated/${fileName}`);
}

// Public and Authenticated must not grant content access, so that only tokens can read.
// Login actions (auth) are allowed and must stay: without them login returns 403.
function assertNoContentAccess(role) {
  const actions = role.permissions.map((p) => p.action);
  const content = actions.filter((a) => a.startsWith('api::') || a.startsWith('plugin::upload'));
  if (content.length > 0) {
    throw new Error(`${role.type} role has content permissions: ${content.join(', ')}`);
  }
  console.log(`${role.type} role: ${actions.length} actions, none on content types: ${actions.join(', ')}`);
}

async function run() {
  console.log(`Database: ${database}`);
  [ADMIN_FILE, LOGIN_USER_FILE, TOKENS_FILE].forEach(assertIgnored);

  const app = await createStrapi(await compileStrapi()).load();

  try {
    // --- Admin ---
    const adminService = app.service('admin::user');
    if (await adminService.exists()) {
      console.log('Admin account already exists: left alone, its file is not rewritten');
    } else {
      const password = randomPassword();
      await adminService.createFirstAdmin({
        firstname: 'Load',
        lastname: 'Test',
        email: ADMIN_EMAIL,
        password,
      });
      writeSecret(ADMIN_FILE, { database, email: ADMIN_EMAIL, password });
    }

    // --- Roles ---
    const roleQuery = app.db.query('plugin::users-permissions.role');
    const publicRole = await roleQuery.findOne({ where: { type: 'public' }, populate: ['permissions'] });
    const authRole = await roleQuery.findOne({ where: { type: 'authenticated' }, populate: ['permissions'] });
    assertNoContentAccess(publicRole);
    assertNoContentAccess(authRole);

    // --- Login user: the account the login scenario signs in with ---
    // The user service hashes the password itself, so it is passed in plain here.
    const userService = app.plugin('users-permissions').service('user');
    const existingUser = await app.db
      .query('plugin::users-permissions.user')
      .findOne({ where: { email: LOGIN_USER_EMAIL } });
    const userPassword = randomPassword();
    if (existingUser) {
      await userService.edit(existingUser.id, { password: userPassword });
    } else {
      await userService.add({
        username: 'loadtest-user',
        email: LOGIN_USER_EMAIL,
        password: userPassword,
        provider: 'local',
        confirmed: true,
        blocked: false,
        role: authRole.id,
      });
    }
    writeSecret(LOGIN_USER_FILE, { database, email: LOGIN_USER_EMAIL, password: userPassword });

    // --- API tokens ---
    // Strapi creates its own "Read Only" and "Full Access" tokens on first start. They are
    // left alone, and the full-access one is never used here: it can delete content.
    const known = new Set(app.contentAPI.permissions.providers.action.keys());
    const tokenService = app.service('admin::api-token');
    const keys = {};
    for (const t of TOKENS) {
      for (const action of t.permissions || []) {
        if (!known.has(action)) throw new Error(`Unknown token action: ${action}`);
      }
      const existing = await tokenService.getByName(t.name);
      // An existing token keeps the permissions it was created with, and regenerate() only
      // rotates the key. So the permissions are synced first: update() adds the missing
      // actions and removes any that are no longer listed, which keeps this file the
      // single source of truth. The read-only token has no list, so it is skipped.
      if (existing && t.permissions) {
        await tokenService.update(existing.id, { permissions: t.permissions });
      }
      // regenerate() rotates the key, so the file always matches what the database holds.
      const token = existing
        ? await tokenService.regenerate(existing.id)
        : await tokenService.create({
            kind: 'content-api',
            name: t.name,
            description: t.description,
            type: t.type,
            permissions: t.permissions,
            lifespan: null,
          });
      keys[t.key] = token.accessKey;
      console.log(`Token ready: ${t.name} (key length ${token.accessKey.length})`);
      // Read the token back from the database and print what is really stored, so a sync
      // that did not apply shows up here and not only later in a failed check. This is
      // names only, never keys: getByName leaves the key out.
      const stored = await tokenService.getByName(t.name);
      const actions = [...stored.permissions].sort();
      console.log(`  stored type: ${stored.type}, ${actions.length} actions${actions.length ? ':' : ''}`);
      actions.forEach((a) => console.log(`    ${a}`));
    }
    writeSecret(TOKENS_FILE, { database, ...keys });
  } finally {
    await app.destroy();
  }
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });

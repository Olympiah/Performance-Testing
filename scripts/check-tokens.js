'use strict';

/**
 * Checks the tokens, roles and login user made by setup-tokens.js.
 *   node scripts/check-tokens.js sqlite|postgres            Strapi RUNNING in production mode
 *   NODE_ENV=production DATABASE_CLIENT=sqlite|postgres \
 *     node scripts/check-tokens.js sqlite|postgres --cleanup   Strapi STOPPED
 *
 * The checks leave test records behind, because the writer and seed tokens correctly cannot
 * delete. All of them start with "__token-check__", and --cleanup removes them by booting
 * Strapi directly. Run the cleanup before the data generator. Secrets are never printed.
 *
 * The argument only picks which token files to read. The real database comes from
 * DATABASE_CLIENT, so --cleanup compares the two and stops if they differ.
 */

const path = require('path');
const fs = require('fs');
const { createRequire } = require('module');

const REPO_ROOT = path.join(__dirname, '..');
const APP_DIR = path.join(REPO_ROOT, 'strapi-app');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:1337';
const PREFIX = '__token-check__';

const database = process.argv[2];
if (!['sqlite', 'postgres'].includes(database)) {
  throw new Error('Usage: check-tokens.js sqlite|postgres [--cleanup]');
}
const read = (name) =>
  JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.generated', `${name}-${database}.json`), 'utf8'));

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: got ${actual}, expected ${expected}`);
}

async function call(method, urlPath, { token, body, headers = {} } = {}) {
  const res = await fetch(BASE + urlPath, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function runChecks() {
  const { readOnly, writer, seed } = read('tokens');
  const user = read('login-user');
  const id = `${PREFIX}-${Date.now()}`;

  check('no token: list Articles', (await call('GET', '/api/articles')).status, 403);
  check('read-only: list Articles', (await call('GET', '/api/articles?pagination[pageSize]=1', { token: readOnly })).status, 200);
  check('read-only: create Article', (await call('POST', '/api/articles', { token: readOnly, body: { data: { title: id, slug: id } } })).status, 403);

  const created = await call('POST', '/api/articles', { token: writer, body: { data: { title: id, slug: id } } });
  check('writer: create Article', created.status, 201);
  const docId = created.json?.data?.documentId;
  check('writer: list Articles', (await call('GET', '/api/articles', { token: writer })).status, 403);
  check('writer: update Article', (await call('PUT', `/api/articles/${docId}`, { token: writer, body: { data: { title: `${id}-u` } } })).status, 200);
  check('writer: delete Article', (await call('DELETE', `/api/articles/${docId}`, { token: writer })).status, 403);
  check('read-only: read back the new Article', (await call('GET', `/api/articles/${docId}`, { token: readOnly })).status, 200);

  const author = await call('POST', '/api/authors', { token: seed, body: { data: { name: id } } });
  check('seed: create Author', author.status, 201);
  check('seed: delete Author', (await call('DELETE', `/api/authors/${author.json?.data?.documentId}`, { token: seed })).status, 403);

  const login = await call('POST', '/api/auth/local', {
    body: { identifier: user.email, password: user.password },
    headers: { 'X-Forwarded-Proto': 'https' },
  });
  check('login with X-Forwarded-Proto: https', login.status, 200);
  check('login returns a jwt', Boolean(login.json?.jwt), true);
  check('logged-in user: list Articles (only tokens read)', (await call('GET', '/api/articles', { token: login.json?.jwt })).status, 403);

  // Information only, not counted as a pass or fail. My first project saw 500 here in
  // production mode. A newer Strapi might fix that, which would not be a failure of ours.
  const plain = await call('POST', '/api/auth/local', { body: { identifier: user.email, password: user.password } });
  console.log(`INFO  login over plain HTTP, no header: got ${plain.status} (500 was seen before)`);

  console.log(failures === 0 ? 'All checks passed' : `${failures} check(s) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

async function cleanup() {
  // The argument must match the real database, otherwise this would clean the wrong one.
  const real = process.env.DATABASE_CLIENT || 'sqlite';
  if (real !== database) {
    throw new Error(`Argument says ${database} but DATABASE_CLIENT says ${real}. Stopping.`);
  }
  if (process.env.NODE_ENV !== 'production') throw new Error('Run the cleanup with NODE_ENV=production.');

  const appRequire = createRequire(path.join(APP_DIR, 'package.json'));
  const { createStrapi, compileStrapi } = appRequire('@strapi/strapi');
  appRequire('dotenv').config({ path: path.join(APP_DIR, '.env') });
  process.chdir(APP_DIR);

  const app = await createStrapi(await compileStrapi()).load();
  try {
    // Second check, after .env is loaded: what Strapi really connected to.
    const actual = app.config.get('database.connection.client');
    if (actual !== database) {
      throw new Error(`Argument says ${database} but Strapi connected to ${actual}. Stopping.`);
    }
    console.log(`Cleaning the ${actual} database`);
    for (const [uid, field] of [['api::article.article', 'title'], ['api::author.author', 'name']]) {
      const filters = { [field]: { $startsWith: PREFIX } };
      const rows = await app.documents(uid).findMany({ filters });
      for (const row of rows) await app.documents(uid).delete({ documentId: row.documentId });
      const left = await app.documents(uid).count({ filters });
      console.log(`${uid}: deleted ${rows.length}, ${left} left`);
    }
  } finally {
    await app.destroy();
  }
}

(process.argv.includes('--cleanup') ? cleanup() : runChecks())
  .then(() => process.exit(process.exitCode || 0))
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });

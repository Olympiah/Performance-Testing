'use strict';

/**
 * Fills a running Strapi with the test data, through the REST API:
 *   node scripts/generate-data.js sqlite
 *   node scripts/generate-data.js postgres
 *   node scripts/generate-data.js sqlite --limit 20     (trial: only the first 20 Articles)
 *
 * Start the matching server first (scripts/start-sqlite.sh or start-postgres.sh), in
 * production mode. Run this after scripts/setup-tokens.js and before the reset snapshot.
 *
 * It writes with the seed token and reads with the read-only token. The seed token can only
 * create and update, so it cannot look up what already exists. Nothing secret is printed.
 *
 * The data is fixed: one seed and one fixed order, so every run builds the same records.
 * Re-running is safe: anything that already exists is skipped, so an interrupted run
 * continues where it stopped. It does not repair a record someone changed afterwards.
 * --limit uses the first N Articles of the same fixed list, so a trial is never extra data.
 *
 * Uploaded images are files in strapi-app/public/uploads, not rows in the database. The
 * reset snapshot restores only the rows, so never empty that folder.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const GEN_DIR = path.join(REPO_ROOT, '.generated');
// 127.0.0.1 and not "localhost", the same as check-tokens.js: "localhost" has to be looked
// up first and may resolve to IPv6, and this script sends thousands of requests.
const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:1337';

// One fixed seed: the same seed always gives the same "random" numbers, so every run
// (and both databases) get identical content.
const SEED = 20261023;
const COUNTS = { articles: 2000, authors: 20, categories: 10, images: 6 };
const PUBLISHED = 1700; // the other 300 are drafts
const LENGTH_CLASSES = { short: 300, typical: 1660, long: 40 }; // Articles per length class
const PARAGRAPHS = { short: [1, 2], typical: [3, 5], long: [20, 30] }; // min and max per class
const IMAGE_SIZE = { width: 800, height: 600 };

// --- Arguments -------------------------------------------------------------------------

// process.argv is [node, script, ...your arguments], so slice(2) keeps only your arguments.
const args = process.argv.slice(2);

// The first argument names the database. It only picks which token file to read; the
// server itself decides which database is really used (see the preflight below).
const database = args[0];
if (!['sqlite', 'postgres'].includes(database)) {
  throw new Error('Usage: node scripts/generate-data.js <sqlite|postgres> [--limit N]');
}

// Optional "--limit N": create only the first N Articles (for a trial run). indexOf gives
// -1 when the flag is absent, and then the limit is the full 2,000. The number is the
// argument right after the flag. Number("abc") is NaN, which isInteger rejects.
const limitAt = args.indexOf('--limit');
const limit = limitAt === -1 ? COUNTS.articles : Number(args[limitAt + 1]);
if (!Number.isInteger(limit) || limit < 1 || limit > COUNTS.articles) {
  throw new Error(`--limit must be a whole number from 1 to ${COUNTS.articles}.`);
}

const TOKENS_FILE = `tokens-${database}.json`;
const DATA_FILE = `data-${database}.json`;

// Asks git whether a file would be ignored. If not, stop before anything is written, so a
// file with ids or secrets can never end up in a commit by accident. Same check as
// setup-tokens.js.
function assertIgnored(fileName) {
  const relative = path.posix.join('.generated', fileName);
  try {
    execFileSync('git', ['check-ignore', '-q', relative], { cwd: REPO_ROOT });
  } catch {
    throw new Error(`${relative} is not git-ignored, refusing to run.`);
  }
}

// --- Seeded random numbers -------------------------------------------------------------

// Math.random() cannot be seeded, so I use a small, well-known seeded generator
// (mulberry32). It returns a function; each call gives the next number between 0 and 1.
// The bit operations only scramble the number well. What matters is that the sequence is
// fully decided by the seed.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// One shared generator for all content. The data stays the same only as long as the
// calls below happen in the same order, so don't reorder buildPlan() without a reason.
const rand = mulberry32(SEED);
const int = (min, max) => min + Math.floor(rand() * (max - min + 1)); // whole number, both ends included
const pick = (list) => list[Math.floor(rand() * list.length)];

// Fisher-Yates shuffle: walk from the end and swap each item with a random earlier one.
// Every order is equally likely, and the seed makes it repeatable.
function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

// --- Made-up content -------------------------------------------------------------------

// Nothing here is copied from anywhere: random words from this list make the filler text.
const WORDS = (
  'river market window garden signal harvest bridge lantern pattern journey morning village ' +
  'engine mirror forest ladder season harbor canvas whisper compass meadow thunder orchard ' +
  'pocket ribbon castle valley anchor blanket candle copper desert feather glacier hammer ' +
  'island jungle kettle lemon magnet needle ocean pebble quilt rocket saddle tunnel umbrella ' +
  'velvet wagon yellow zipper carries builds follows keeps shows turns opens holds finds ' +
  'makes brings leaves moves changes shares with from over under near across and while ' +
  'before after often slowly quietly simple quiet bright old new small wide steady careful ' +
  'gentle sudden common rare'
).split(' ');

const FIRST_NAMES = [
  'Amina', 'Brian', 'Chloe', 'Daniel', 'Esther', 'Felix', 'Grace', 'Hassan', 'Irene', 'Jonas',
  'Kezia', 'Liam', 'Mercy', 'Nathan', 'Olivia', 'Peter', 'Queenie', 'Rafael', 'Sara', 'Tobias',
];
const LAST_NAMES = [
  'Adams', 'Barasa', 'Chege', 'Dlamini', 'Evans', 'Farah', 'Gitau', 'Hughes', 'Ismail', 'Juma',
  'Kamau', 'Lopez', 'Mwangi', 'Njeri', 'Otieno', 'Patel', 'Quinn', 'Rossi', 'Sharma', 'Thomas',
];
const CATEGORY_NAMES = [
  'Travel', 'Food', 'Technology', 'Health', 'Finance', 'Sports', 'Music', 'Science', 'Education',
  'Culture',
];

const capitalise = (text) => text.charAt(0).toUpperCase() + text.slice(1);
// "Hello, World!" becomes "hello-world": lower case, runs of other characters become one dash.
const slugify = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
// A sentence is 6 to 14 random words with a capital letter and a full stop.
const sentence = () => capitalise(Array.from({ length: int(6, 14) }, () => pick(WORDS)).join(' ')) + '.';
// A paragraph is 3 to 6 sentences, so about 50 words.
const paragraph = () => Array.from({ length: int(3, 6) }, sentence).join(' ');

// Strapi's Blocks format: a list of blocks, each paragraph holding text pieces.
const blocks = (count) =>
  Array.from({ length: count }, () => ({
    type: 'paragraph',
    children: [{ type: 'text', text: paragraph() }],
  }));

// The whole plan is built up front, in a fixed order, so --limit only cuts it short.
// Nothing is sent to the server here.
function buildPlan() {
  const authors = FIRST_NAMES.map((first, i) => {
    // Step 7 through the last names so the pairs differ from the first-name order.
    // 7 and 20 share no factor, so no last name repeats.
    const last = LAST_NAMES[(i * 7) % LAST_NAMES.length];
    return {
      name: `${first} ${last}`,
      email: `${first}.${last}@example.com`.toLowerCase(),
      bio: `${sentence()} ${sentence()}`,
    };
  });
  const categories = CATEGORY_NAMES.map((name) => ({ name, slug: slugify(name) }));

  // Exact counts: build a list with the right number of each class, then shuffle it.
  // Rolling a dice per Article would only give about the right counts.
  const lengths = shuffle(
    Object.entries(LENGTH_CLASSES).flatMap(([cls, count]) => Array(count).fill(cls)),
  );
  // Same idea for published versus draft: 1,700 true and 300 false, shuffled.
  const published = shuffle(
    Array.from({ length: COUNTS.articles }, (_, i) => i < PUBLISHED),
  );

  const articles = Array.from({ length: COUNTS.articles }, (_, i) => {
    const title = capitalise(Array.from({ length: int(4, 8) }, () => pick(WORDS)).join(' ')).slice(0, 120); // 120 is the title limit in the schema
    const [min, max] = PARAGRAPHS[lengths[i]];
    return {
      title,
      // The number keeps slugs unique even when two random titles match. The script also
      // uses the slug to recognise an Article it has already created.
      slug: `${slugify(title)}-${String(i + 1).padStart(4, '0')}`,
      content: blocks(int(min, max)),
      published: published[i],
      // Author cycles fastest and category changes every 20 Articles, so all 200
      // author and category pairs appear equally often (10 times each). Using i % 20
      // and i % 10 together would lock each author to a single category.
      author: i % COUNTS.authors,
      category: Math.floor(i / COUNTS.authors) % COUNTS.categories,
      cover: i % COUNTS.images, // the 6 images are shared across all Articles
    };
  });
  return { authors, categories, articles };
}

// --- Cover images ----------------------------------------------------------------------

// A PNG file is a signature followed by "chunks". Each chunk is: length, 4-letter type,
// data, and a CRC (a checksum over the type and data) that readers use to detect damage.
function crc32Chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, crc]);
}

// A plain PNG written by hand, so no image library is needed: a colour gradient with
// waves and a little noise, so it compresses like a picture and not like a flat colour.
// Each image gets its own colours. Its own seeded generator (SEED + 100 + index) means
// the images don't disturb the text sequence above.
function makePng(index) {
  const { width, height } = IMAGE_SIZE;
  const r = mulberry32(SEED + 100 + index);
  const from = [0, 1, 2].map(() => int(30, 200)); // red, green, blue at the top left
  const to = [0, 1, 2].map(() => int(30, 200)); // red, green, blue at the bottom right
  const phase = [0, 1, 2].map(() => int(0, 100)); // shifts the waves per colour channel
  const rowSize = width * 3 + 1; // 3 bytes per pixel, plus one filter byte per row (0 = none)
  const raw = Buffer.alloc(rowSize * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = (x / width + y / height) / 2; // 0 at the top left, 1 at the bottom right
      for (let c = 0; c < 3; c++) {
        const wave = 18 * Math.sin((x + phase[c]) / 40) + 12 * Math.sin((y + phase[c]) / 25);
        const noise = (r() * 2 - 1) * 10; // -10 to +10
        const value = from[c] + (to[c] - from[c]) * t + wave + noise;
        raw[y * rowSize + 1 + x * 3 + c] = Math.max(0, Math.min(255, Math.round(value)));
      }
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // 8 bits per colour
  header[9] = 2; // colour type 2 = RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // the fixed PNG signature
    crc32Chunk('IHDR', header), // image size and format
    crc32Chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), // the pixels, compressed
    crc32Chunk('IEND', Buffer.alloc(0)), // end marker
  ]);
}

// --- API helpers -----------------------------------------------------------------------

// One place for every request: adds the token, sends JSON or an upload form, and turns any
// non-2xx answer into an error that names the request and Strapi's reason.
async function api(method, urlPath, token, body) {
  const isForm = body instanceof FormData;
  const headers = { Authorization: `Bearer ${token}` };
  // For a form, fetch sets its own Content-Type (it must include the form boundary).
  if (body && !isForm) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE_URL + urlPath, {
    method,
    headers,
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON: the status below is enough
  }
  if (!res.ok) {
    const reason = json && json.error && json.error.message ? json.error.message : text.slice(0, 200);
    throw new Error(`${method} ${urlPath} returned ${res.status}: ${reason}`);
  }
  return json;
}

// Strapi returns at most 100 items per page, so keep asking for the next page until the
// last one. The sort keeps the order stable between requests, so no item is missed or
// read twice.
async function listAll(urlPath, token) {
  const sep = urlPath.includes('?') ? '&' : '?';
  const all = [];
  for (let page = 1; ; page++) {
    const json = await api(
      'GET',
      `${urlPath}${sep}sort=id&pagination[page]=${page}&pagination[pageSize]=100`,
      token,
    );
    all.push(...json.data);
    if (page >= json.meta.pagination.pageCount) return all;
  }
}

// --- Run -------------------------------------------------------------------------------

async function run() {
  assertIgnored(TOKENS_FILE);
  assertIgnored(DATA_FILE);
  const tokens = JSON.parse(fs.readFileSync(path.join(GEN_DIR, TOKENS_FILE), 'utf8'));
  const { readOnly, seed } = tokens;
  const started = Date.now();
  console.log(`Database: ${database}, server: ${BASE_URL}, Articles wanted: ${limit}`);

  // Preflight: two harmless reads before anything is written. The tokens differ per
  // database, so a 401 here almost always means the server is on the other database.
  try {
    await api('GET', '/api/articles?pagination[pageSize]=1', readOnly);
    await api('GET', '/api/upload/files?pagination[pageSize]=1', readOnly);
  } catch (err) {
    throw new Error(
      `Preflight failed (${err.message}). A 401 means the server is on the other database ` +
        'or the tokens changed. A 403 on /api/upload/files means the read-only token cannot ' +
        'list uploaded files, so I cannot check for existing images safely.',
    );
  }

  const plan = buildPlan();

  // --- Authors and categories: matched by name ---
  // For each planned Author: reuse the one already in the database, or create it. Either
  // way its documentId goes into authorIds at the same position, so the Articles can link
  // to authorIds[n] later.
  const authorIds = [];
  const existingAuthors = new Map((await listAll('/api/authors', readOnly)).map((a) => [a.name, a.documentId]));
  for (const author of plan.authors) {
    if (!existingAuthors.has(author.name)) {
      const created = await api('POST', '/api/authors', seed, { data: author });
      existingAuthors.set(author.name, created.data.documentId);
    }
    authorIds.push(existingAuthors.get(author.name));
  }

  // Categories work the same way. A Category name is also unique in the schema, so a
  // duplicate would be rejected by Strapi anyway.
  const categoryIds = [];
  const existingCategories = new Map((await listAll('/api/categories', readOnly)).map((c) => [c.name, c.documentId]));
  for (const category of plan.categories) {
    if (!existingCategories.has(category.name)) {
      const created = await api('POST', '/api/categories', seed, { data: category });
      existingCategories.set(category.name, created.data.documentId);
    }
    categoryIds.push(existingCategories.get(category.name));
  }
  console.log(`Authors: ${authorIds.length}, Categories: ${categoryIds.length}`);

  // --- Images: matched by file name, uploaded with the seed token ---
  // A cover is linked by its numeric id (not documentId), so the ids are kept in order.
  const imageIds = [];
  for (let i = 0; i < COUNTS.images; i++) {
    const name = `seed-cover-${i + 1}.png`;
    const found = await api('GET', `/api/upload/files?filters[name][$eq]=${name}`, readOnly);
    if (found.length > 0) {
      imageIds.push(found[0].id);
      continue;
    }
    const png = makePng(i);
    const form = new FormData();
    form.append('files', new Blob([png], { type: 'image/png' }), name);
    form.append('fileInfo', JSON.stringify({ name, alternativeText: `Cover image ${i + 1}` }));
    const uploaded = await api('POST', '/api/upload', seed, form);
    imageIds.push(uploaded[0].id);
    console.log(`Uploaded ${name}: ${(png.length / 1024).toFixed(0)} KB`);
  }

  // --- Articles: matched by slug ---
  // status=draft lists every document (drafts and published ones), so this is the full set
  // of Articles already there. A Set makes each "already exists?" check instant.
  const existing = new Set((await listAll('/api/articles?status=draft&fields[0]=slug', readOnly)).map((a) => a.slug));
  let created = 0;
  for (const article of plan.articles.slice(0, limit)) {
    if (existing.has(article.slug)) continue;
    // Create publishes by default, so a draft has to ask for it.
    const urlPath = article.published ? '/api/articles' : '/api/articles?status=draft';
    await api('POST', urlPath, seed, {
      data: {
        title: article.title,
        slug: article.slug,
        content: article.content,
        cover: imageIds[article.cover],
        author: authorIds[article.author],
        category: categoryIds[article.category],
      },
    });
    created++;
    if (created % 100 === 0) console.log(`  ${created} Articles created`);
  }
  console.log(`Articles created this run: ${created}`);

  // --- Check the result against what the plan says it should be ---
  // Re-read from the server instead of trusting the loop above. Any mismatch, including
  // extra records nobody planned, fails the run. Better to stop here than to measure the
  // wrong data set later.
  const wanted = plan.articles.slice(0, limit);
  const wantedPublished = wanted.filter((a) => a.published).length;
  const everything = await listAll('/api/articles?status=draft&fields[0]=slug', readOnly);
  const publishedNow = await listAll('/api/articles?fields[0]=slug', readOnly); // default = published only
  const problems = [];
  if (everything.length !== wanted.length) problems.push(`Articles: ${everything.length}, expected ${wanted.length}`);
  if (publishedNow.length !== wantedPublished) problems.push(`published: ${publishedNow.length}, expected ${wantedPublished}`);
  if (existingAuthors.size !== COUNTS.authors) problems.push(`Authors: ${existingAuthors.size}, expected ${COUNTS.authors}`);
  if (existingCategories.size !== COUNTS.categories) problems.push(`Categories: ${existingCategories.size}, expected ${COUNTS.categories}`);
  console.log(
    `Now in the database: ${everything.length} Articles (${publishedNow.length} published, ` +
      `${everything.length - publishedNow.length} drafts)`,
  );
  if (problems.length > 0) throw new Error(`Counts do not match the plan:\n  ${problems.join('\n  ')}`);

  // --- The ids k6 needs ---
  // documentIds are made by Strapi, so they differ between SQLite and Postgres. The k6
  // readers ask for these ids, which keeps every run asking for the same things.
  // "complete" tells k6 whether this was a trial (--limit) or the full data set.
  fs.mkdirSync(GEN_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(GEN_DIR, DATA_FILE),
    JSON.stringify(
      {
        database,
        complete: limit === COUNTS.articles,
        publishedArticleIds: publishedNow.map((a) => a.documentId),
        authorIds,
        categories: plan.categories.map((c, i) => ({ documentId: categoryIds[i], name: c.name })),
      },
      null,
      2,
    ),
  );
  console.log(`Wrote .generated/${DATA_FILE}`);
  console.log(`Done in ${Math.round((Date.now() - started) / 1000)} s`);
}

// Any error stops the run with a message and a non-zero exit code, so a failed seed is
// never mistaken for a good one.
run().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

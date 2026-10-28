// The writer journey: create an Article, update it, then read it back.
// The create and update use the writer token. The read-back uses the read-only token and is
// tagged "readback", so it stays out of the write limit (S3) but still counts in the failure
// rate and the check pass rate. A profile runs it with exec: 'writer'.
import http from 'k6/http';
import { sleep } from 'k6';
import { BASE_URL, JOURNEY } from '../lib/config.js';
import { readParams, writeParams } from '../lib/auth.js';
import { writerAuthorId, writerCategoryId, writerSlug } from '../lib/data.js';
import { checkCreate, checkUpdate, checkReadback } from '../lib/checks.js';

// Same random pause as the reader, and none after the last step.
const think = () => sleep(1 + Math.random() * 2);

// Article content is Blocks, so this is one short paragraph. The text is the same every time,
// so the size of the body does not change from one create to the next.
const CONTENT = [
  {
    type: 'paragraph',
    children: [{ type: 'text', text: 'Made-up text written by the load test. It says nothing.' }],
  },
];

export function writer() {
  // The slug counter is fixed for the whole iteration, so the title and slug stay in step.
  // No cover on purpose: the cover is a file id, and the writer token can't look files up.
  const slug = writerSlug();
  const title = `Load test ${slug}`;
  const updatedTitle = `${title} (updated)`;

  // Step 1: create. Relations go in as a documentId, as the generator does. Strapi publishes
  // on create by default, so every iteration adds one published Article.
  const created = http.post(
    `${BASE_URL}/articles`,
    JSON.stringify({
      data: {
        title,
        slug,
        content: CONTENT,
        author: writerAuthorId(),
        category: writerCategoryId(),
      },
    }),
    writeParams('POST /articles'),
  );
  const ok = checkCreate(created);
  // Without an id the next two steps have nothing to ask for. The failed check is already
  // counted, so stopping here does not hide the failure.
  if (!ok) return;
  const id = created.json().data.documentId;
  think();

  // Step 2: update the title. A partial body is enough, Strapi keeps the other fields.
  const updated = http.put(
    `${BASE_URL}/articles/${id}`,
    JSON.stringify({ data: { title: updatedTitle } }),
    writeParams('PUT /articles/:documentId'),
  );
  checkUpdate(updated, updatedTitle);
  think();

  // Step 3: read it back with the read-only token. The new title proves the update was saved
  // and is visible to a reader.
  const back = http.get(
    `${BASE_URL}/articles/${id}`,
    readParams(JOURNEY.readback, 'GET /articles/:documentId (readback)'),
  );
  checkReadback(back, updatedTitle);
}

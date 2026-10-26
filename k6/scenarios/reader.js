// The reader journey: list a page of Articles, open one with its relations, then list Categories.
// Read-only token. A profile runs it with exec: 'reader' and sets the rate and the VUs.
import http from 'k6/http';
import { sleep } from 'k6';
import { BASE_URL, JOURNEY } from '../lib/config.js';
import { readParams } from '../lib/auth.js';
import { articleId, listPage } from '../lib/data.js';
import { checkList, checkOne } from '../lib/checks.js';

const PAGE_SIZE = 25;
const CATEGORY_COUNT = 10; // the generator makes exactly 10, and the default page size of 25 holds them all

// Think time. The pause is random on purpose, because users don't click on a clock. It doesn't
// change which requests are sent, only when, so the runs still ask for the same things.
const think = () => sleep(1 + Math.random() * 2);

export function reader() {
  // Step 1: one page of the list. The page number moves with the iteration, so the list
  // is not the same cached page every time.
  const list = http.get(
    `${BASE_URL}/articles?pagination[pageSize]=${PAGE_SIZE}&pagination[page]=${listPage(PAGE_SIZE)}`,
    readParams(JOURNEY.reader, 'GET /articles'),
  );
  checkList(list, JOURNEY.reader, PAGE_SIZE);
  think();

  // Step 2: one Article with author, category and cover.
  const one = http.get(
    `${BASE_URL}/articles/${articleId()}?populate[author]=true&populate[category]=true&populate[cover]=true`,
    readParams(JOURNEY.reader, 'GET /articles/:documentId'),
  );
  checkOne(one);
  think();

  // Step 3: the Categories. There is no pause after the last step.
  const categories = http.get(
    `${BASE_URL}/categories`,
    readParams(JOURNEY.reader, 'GET /categories'),
  );
  checkList(categories, JOURNEY.reader, CATEGORY_COUNT);
}

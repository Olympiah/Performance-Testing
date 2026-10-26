// The ids and names the scenarios ask for, read once from the generator's data file.
// A pick depends only on the iteration number, never on random numbers, so every run asks
// for the same things in the same order, whichever VU happens to run the iteration.
import { SharedArray } from 'k6/data';
import { scenario } from 'k6/execution';
import { DB } from './config.js';

const FILE = `../../.generated/data-${DB}.json`;

// SharedArray keeps one copy in memory for all VUs. Each one parses the file, which is small
// (about 56 KB), and the function runs once per array, not once per VU.
function load(field) {
  return new SharedArray(field, () => {
    const data = JSON.parse(open(FILE));
    // The generator only writes "complete": true after its final counts matched the plan.
    if (data.database !== DB || data.complete !== true || data[field].length === 0) {
      throw new Error(`.generated/data-${DB}.json is not a finished data set for ${DB}`);
    }
    return data[field];
  });
}

const articleIds = load('publishedArticleIds');
const authorIds = load('authorIds');
const categories = load('categories'); // objects with documentId and name

// iterationInTest counts iterations across all VUs within one scenario, so VUs never repeat
// or skip a number. __ITER would count per VU and break that.
const n = () => scenario.iterationInTest;

// A sweep through the 1,700 published Articles, not a hot set. That is my choice, and it means
// a repeated read of the same Article is rarer than in real traffic.
export const articleId = () => articleIds[n() % articleIds.length];

// Page number for list requests. 1,700 published Articles fill exactly 68 pages of 25,
// so every page is full and the expected length in checkList holds for all of them.
export const listPage = (pageSize) => (n() % Math.floor(articleIds.length / pageSize)) + 1;

// The category name the heavy reader filters on.
export const categoryName = () => categories[n() % categories.length].name;

// The writer's relations use the generator's rule (author i % 20, category floor(i / 20) % 10),
// so all 200 pairs come up equally often.
export const writerAuthorId = () => authorIds[n() % authorIds.length];
export const writerCategoryId = () =>
  categories[Math.floor(n() / authorIds.length) % categories.length].documentId;

// Writer slugs. The counter restarts at 0 in every scenario, so the scenario name is part of the
// slug, or two stress steps would both try to create "lt-0". There is no run id on purpose:
// a rerun on data that was not restored fails with 400, instead of quietly adding different records.
export const writerSlug = () => `lt-${scenario.name}-${n()}`;

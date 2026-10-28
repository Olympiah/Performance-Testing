// The heavy reader journey: one big list request, to show what the expensive query shape costs.
// It has all three relations populated, a filter on the category name, a sort on title and the
// largest page Strapi allows (100). Read-only token. A profile runs it with exec: 'heavyReader'.
import http from 'k6/http';
import { BASE_URL, JOURNEY } from '../lib/config.js';
import { readParams } from '../lib/auth.js';
import { categoryName } from '../lib/data.js';
import { checkHeavy } from '../lib/checks.js';

const PAGE_SIZE = 100; // the cap (maxLimit), so this is the biggest page a client can ask for

// One request per iteration and no think time. The journey is about a single expensive query,
// so a pause would only make each VU idle (about 0.3 s per iteration, see the sizing in the plan).
export function heavyReader() {
  // The category rotates with the iteration, so every run asks for the same names in the same
  // order. Each category has about 170 published Articles, more than one page of 100, so a full
  // page is expected. Page 1 only, so the response size stays the same from one iteration to the next.
  // Sorting on title (a text column with no index) makes the database sort the whole match.
  // Drafts are left out by default in Strapi 5, so only published Articles count.
  const url =
    `${BASE_URL}/articles` +
    `?filters[category][name][$eq]=${encodeURIComponent(categoryName())}` +
    `&populate[author]=true&populate[category]=true&populate[cover]=true` +
    `&sort=title:asc` +
    `&pagination[pageSize]=${PAGE_SIZE}&pagination[page]=1`;

  const res = http.get(url, readParams(JOURNEY.heavy, 'GET /articles (heavy)'));
  checkHeavy(res, PAGE_SIZE);
}

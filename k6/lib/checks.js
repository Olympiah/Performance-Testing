// One check per kind of response. Each one tests the body as well as the status, because Strapi
// can answer 200 with an empty list, and that is a broken test, not a pass.
// The check names start with the journey, so the pass rate can be read per journey.
import { check } from 'k6';

// res.json() throws on a body that is not JSON, which would crash the iteration and hide the status.
function body(res) {
  try {
    return res.json();
  } catch (e) {
    return null;
  }
}

// The caller says how many items the page must hold, so a short page counts as a failure.
export function checkList(res, journey, expected) {
  const b = body(res);
  return check(res, {
    [`${journey}: list status 200`]: (r) => r.status === 200,
    [`${journey}: list has ${expected} items`]: () =>
      !!b && Array.isArray(b.data) && b.data.length === expected,
  });
}

// The heavy reader's page is large, and k6 shares two cores with Strapi, so parsing it with
// res.json() would cost the load generator real CPU. This looks at the text instead: the
// status, a body that is not tiny, and the page size Strapi echoes back in "meta".
// It does not count the items, so it is weaker than checkList. The category filter matches
// well over 100 published Articles, so a full page is expected, but this check can't prove it.
const HEAVY_MIN_BYTES = 10000;
export function checkHeavy(res, pageSize) {
  return check(res, {
    'heavy: list status 200': (r) => r.status === 200,
    'heavy: list is not tiny': (r) => typeof r.body === 'string' && r.body.length > HEAVY_MIN_BYTES,
    'heavy: list echoes the page size': (r) =>
      typeof r.body === 'string' && r.body.includes(`"pageSize":${pageSize}`),
  });
}

// Readers only ask for seeded Articles, and every one has an author, category and cover.
export function checkOne(res) {
  const b = body(res);
  return check(res, {
    'reader: article status 200': (r) => r.status === 200,
    'reader: article has relations': () =>
      !!b && !!b.data && !!b.data.author && !!b.data.category && !!b.data.cover,
  });
}

export function checkCreate(res) {
  const b = body(res);
  return check(res, {
    'write: create status 201': (r) => r.status === 201,
    'write: create returned documentId': () => !!b && !!b.data && !!b.data.documentId,
  });
}

// The update and the read-back both compare the title, so the read-back proves the update was saved.
export function checkUpdate(res, title) {
  const b = body(res);
  return check(res, {
    'write: update status 200': (r) => r.status === 200,
    'write: update kept the new title': () => !!b && !!b.data && b.data.title === title,
  });
}

export function checkReadback(res, title) {
  const b = body(res);
  return check(res, {
    'readback: status 200': (r) => r.status === 200,
    'readback: has the updated title': () => !!b && !!b.data && b.data.title === title,
  });
}

export function checkLogin(res) {
  const b = body(res);
  return check(res, {
    'login: status 200': (r) => r.status === 200,
    'login: returned a jwt': () => !!b && typeof b.jwt === 'string' && b.jwt.length > 0,
  });
}

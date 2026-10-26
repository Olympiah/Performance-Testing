// Settings every scenario shares. Importing this file loads the credentials, so the
// database choice is made here once and a run can never mix one database's ids with the other's tokens.
const DB = __ENV.DB;
if (DB !== 'sqlite' && DB !== 'postgres') {
  throw new Error('Set -e DB=sqlite or -e DB=postgres');
}

// Paths are relative to this file. open() only works while k6 is loading the script.
const GENERATED = '../../.generated';

// The tokens file also holds the seed token, which belongs to the data generator alone.
// open() can only return the whole file, and JSON.parse turns all of it into one object.
// That object lives only inside this function. Only the read-only token, the writer token
// and the login user leave it, so the seed token is never used, exported or kept anywhere.
function loadCredentials() {
  const tokens = JSON.parse(open(`${GENERATED}/tokens-${DB}.json`));
  const user = JSON.parse(open(`${GENERATED}/login-user-${DB}.json`));

  // A file written for the other database would pass every request on the wrong data, so check the label.
  if (tokens.database !== DB || user.database !== DB) {
    throw new Error(`The credential files in .generated/ are not for ${DB}`);
  }

  return {
    readToken: tokens.readOnly,
    writeToken: tokens.writer,
    loginUser: { identifier: user.email, password: user.password },
  };
}

const credentials = loadCredentials();

export { DB };
// 127.0.0.1, not localhost: on Windows localhost can resolve to the IPv6 address first,
// which adds a failed attempt if Strapi listens on IPv4 only.
export const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:1337/api';
export const READ_TOKEN = credentials.readToken;
export const WRITE_TOKEN = credentials.writeToken;
export const LOGIN_USER = credentials.loginUser;

// Values of the "journey" tag. Thresholds filter on these, so S1 can leave out "readback".
export const JOURNEY = {
  reader: 'reader',
  heavy: 'heavy',
  write: 'write',
  readback: 'readback',
  login: 'login',
};

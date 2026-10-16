/**
 * Live tests change rows in the connected database, so they only run against a local test database.
 * A non-local host is refused unless SEEFIX_TEST_DB_CONFIRM repeats it exactly as "<host>/<database>"
 * (for a deliberate run on a disposable Neon branch). Never point live tests at production.
 */
export function requireTestDatabase(url = process.env.DATABASE_URL) {
  if (!url) throw new Error("Live tests need DATABASE_URL pointing at a local test database.");
  const u = new URL(url);
  const target = `${u.hostname}${u.pathname}`;
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(u.hostname);
  if (!local && process.env.SEEFIX_TEST_DB_CONFIRM !== target) {
    throw new Error(`Refusing live tests against non-local database ${target}. Use a local test database, or set SEEFIX_TEST_DB_CONFIRM=${target} for a disposable copy.`);
  }
  return target;
}

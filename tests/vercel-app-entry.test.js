import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

// Vercel's Express preset runs src/app.js (the file that imports express) as the function, not server.js.
// Without a default export every request fails with "Invalid export found in module /var/task/src/app.js".
test("src/app.js default-exports the Express app and checks config on Vercel", () => {
  const app = read("src/app.js");
  assert.match(app, /^export default app;$/m);
  assert.match(app, /if \(process\.env\.VERCEL\) validateRuntimeConfig\(\);/);
});

test("vercel.json function settings target the real entry", () => {
  const { functions } = JSON.parse(read("vercel.json"));
  assert.deepEqual(Object.keys(functions), ["src/app.js"]);
  assert.equal(functions["src/app.js"].maxDuration, 60);
});

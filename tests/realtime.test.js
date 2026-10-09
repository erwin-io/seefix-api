import test from "node:test";
import assert from "node:assert/strict";

process.env.PUSHER_APP_ID = "1";
process.env.PUSHER_KEY = "test-key";
process.env.PUSHER_SECRET = "test-secret";
process.env.PUSHER_CLUSTER = "ap1";
const { realtimeEnabled, userChannel, authorizeChannel } = await import("../src/realtime.js");

test("realtime is enabled only when all Pusher settings exist", () => {
  assert.equal(realtimeEnabled, true);
});

test("private user channel auth is signed with the public key", () => {
  const channel = userChannel("abc");
  assert.equal(channel, "private-user-abc");
  const { auth } = authorizeChannel("123.456", channel);
  assert.match(auth, /^test-key:[0-9a-f]{64}$/);
});

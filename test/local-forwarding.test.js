import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import app from "../server.js";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("POST /api/analyze forwards one image to the local agent", async () => {
  let receivedMultipart = false;
  const upstream = http.createServer((request, response) => {
    receivedMultipart = request.headers["content-type"]?.startsWith(
      "multipart/form-data; boundary=",
    );
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ analysis_status: "Assessed" }));
    });
  });
  const upstreamPort = await listen(upstream);

  const previousProvider = process.env.AGENT_PROVIDER;
  const previousUrl = process.env.LOCAL_AGENT_URL;
  process.env.AGENT_PROVIDER = "local";
  process.env.LOCAL_AGENT_URL = `http://127.0.0.1:${upstreamPort}`;

  const api = http.createServer(app);
  const apiPort = await listen(api);

  try {
    const form = new FormData();
    form.append("image", new Blob(["fake-image"], { type: "image/jpeg" }), "test.jpg");

    const response = await fetch(`http://127.0.0.1:${apiPort}/api/analyze`, {
      method: "POST",
      body: form,
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { analysis_status: "Assessed" });
    assert.equal(receivedMultipart, true);
  } finally {
    await close(api);
    await close(upstream);

    if (previousProvider === undefined) delete process.env.AGENT_PROVIDER;
    else process.env.AGENT_PROVIDER = previousProvider;

    if (previousUrl === undefined) delete process.env.LOCAL_AGENT_URL;
    else process.env.LOCAL_AGENT_URL = previousUrl;
  }
});

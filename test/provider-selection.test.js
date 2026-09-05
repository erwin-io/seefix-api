import test from "node:test";
import assert from "node:assert/strict";

import { AgentClientError, resolveAgentProvider } from "../src/agent-client.js";

test("auto uses the local agent during development", () => {
  assert.equal(resolveAgentProvider({ AGENT_PROVIDER: "auto" }), "local");
});

test("auto uses Hugging Face on Vercel", () => {
  assert.equal(
    resolveAgentProvider({ AGENT_PROVIDER: "auto", VERCEL: "1" }),
    "huggingface",
  );
});

test("an explicit provider overrides automatic selection", () => {
  assert.equal(
    resolveAgentProvider({ AGENT_PROVIDER: "huggingface" }),
    "huggingface",
  );
});

test("an unsupported provider fails configuration validation", () => {
  assert.throws(
    () => resolveAgentProvider({ AGENT_PROVIDER: "unknown" }),
    AgentClientError,
  );
});

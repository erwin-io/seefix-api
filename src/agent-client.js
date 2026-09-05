import { Blob } from "node:buffer";

import { Client } from "@gradio/client";

const VALID_PROVIDERS = new Set(["auto", "local", "huggingface"]);

export class AgentClientError extends Error {
  constructor(message, { code = "AGENT_ERROR", cause } = {}) {
    super(message, { cause });
    this.name = "AgentClientError";
    this.code = code;
  }
}

export function resolveAgentProvider(environment = process.env) {
  const configured = (environment.AGENT_PROVIDER || "auto").toLowerCase();

  if (!VALID_PROVIDERS.has(configured)) {
    throw new AgentClientError(
      "AGENT_PROVIDER must be auto, local, or huggingface.",
      { code: "CONFIGURATION_ERROR" },
    );
  }

  if (configured !== "auto") {
    return configured;
  }

  return environment.VERCEL ? "huggingface" : "local";
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function timeoutAfter(promise, timeoutMs, provider) {
  let timer;

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new AgentClientError(
          `${provider} agent exceeded the ${Math.ceil(timeoutMs / 1000)}-second timeout.`,
          { code: "AGENT_TIMEOUT" },
        ),
      );
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function normalizeBaseUrl(url) {
  return url.replace(/\/+$/, "");
}

let huggingFaceClientPromise;
let connectedSpaceId;

async function getHuggingFaceClient(spaceId) {
  if (!huggingFaceClientPromise || connectedSpaceId !== spaceId) {
    connectedSpaceId = spaceId;
    huggingFaceClientPromise = Client.connect(spaceId).catch((error) => {
      huggingFaceClientPromise = undefined;
      connectedSpaceId = undefined;
      throw error;
    });
  }

  return huggingFaceClientPromise;
}

async function analyzeWithLocalAgent(file, environment, timeoutMs) {
  const baseUrl = normalizeBaseUrl(
    environment.LOCAL_AGENT_URL || "http://127.0.0.1:8000",
  );
  const form = new FormData();
  form.append(
    "image",
    new Blob([file.buffer], { type: file.mimetype }),
    file.originalname || "facility-image",
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}/api/analyze`, {
      method: "POST",
      body: form,
      signal: controller.signal,
    });

    const contentType = response.headers.get("content-type") || "";
    const payload = contentType.includes("application/json")
      ? await response.json()
      : { detail: await response.text() };

    if (!response.ok) {
      const message = payload?.detail || `Local agent returned HTTP ${response.status}.`;
      throw new AgentClientError(message, { code: "LOCAL_AGENT_RESPONSE_ERROR" });
    }

    return payload;
  } catch (error) {
    if (error instanceof AgentClientError) {
      throw error;
    }

    if (error?.name === "AbortError") {
      throw new AgentClientError(
        `Local agent exceeded the ${Math.ceil(timeoutMs / 1000)}-second timeout.`,
        { code: "AGENT_TIMEOUT", cause: error },
      );
    }

    throw new AgentClientError(
      `Unable to reach the local agent at ${baseUrl}. Start FastAPI/Ollama first.`,
      { code: "AGENT_UNAVAILABLE", cause: error },
    );
  } finally {
    clearTimeout(timer);
  }
}

async function analyzeWithHuggingFace(file, environment, timeoutMs) {
  const spaceId = environment.HF_SPACE_ID || "erwinramirez220/seefix-agents";

  try {
    const client = await timeoutAfter(
      getHuggingFaceClient(spaceId),
      timeoutMs,
      "Hugging Face",
    );
    const imageBlob = new Blob([file.buffer], { type: file.mimetype });
    const result = await timeoutAfter(
      client.predict("/analyze", [imageBlob]),
      timeoutMs,
      "Hugging Face",
    );

    if (!result || !Array.isArray(result.data) || result.data.length === 0) {
      throw new AgentClientError("The Hugging Face agent returned an empty response.", {
        code: "INVALID_AGENT_RESPONSE",
      });
    }

    return result.data[0];
  } catch (error) {
    if (error instanceof AgentClientError) {
      throw error;
    }

    // Reconnect on the next request if the Space restarted or the client became stale.
    huggingFaceClientPromise = undefined;
    connectedSpaceId = undefined;

    throw new AgentClientError("The Hugging Face agent request failed.", {
      code: "AGENT_UPSTREAM_ERROR",
      cause: error,
    });
  }
}

export async function analyzeImage(file, environment = process.env) {
  const provider = resolveAgentProvider(environment);
  const timeoutMs = positiveInteger(environment.AGENT_TIMEOUT_MS, 240_000);

  if (provider === "local") {
    return analyzeWithLocalAgent(file, environment, timeoutMs);
  }

  return analyzeWithHuggingFace(file, environment, timeoutMs);
}

import {
  Blob,
  File,
} from "node:buffer";

import {
  Client,
  handle_file,
} from "@gradio/client";


const VALID_PROVIDERS =
  new Set([
    "auto",
    "local",
    "huggingface",
  ]);


/*
|--------------------------------------------------------------------------
| Agent Error
|--------------------------------------------------------------------------
*/

export class AgentClientError extends Error {

  constructor(
    message,
    {
      code = "AGENT_ERROR",
      cause,
      upstreamDetail,
    } = {},
  ) {

    super(
      message,
      {
        cause,
      },
    );

    this.name =
      "AgentClientError";

    this.code =
      code;

    this.upstreamDetail =
      upstreamDetail;
  }

}


/*
|--------------------------------------------------------------------------
| Provider Resolution
|--------------------------------------------------------------------------
|
| Current SEEFIX architecture:
|
| Local development:
|
|   Node
|     ↓
|   http://127.0.0.1:8000
|     ↓
|   FastAPI
|     ↓
|   Ollama / Qwen
|
| Vercel:
|
|   Vercel
|     ↓
|   Cloudflare Tunnel
|     ↓
|   local FastAPI
|     ↓
|   Ollama / Qwen
|
| Hugging Face support remains available only when explicitly selected.
|
*/

export function resolveAgentProvider(
  environment = process.env,
) {

  const configured =
    (
      environment.AGENT_PROVIDER ||
      "auto"
    )
      .trim()
      .toLowerCase();


  if (
    !VALID_PROVIDERS.has(
      configured,
    )
  ) {

    throw new AgentClientError(
      "AGENT_PROVIDER must be auto, local, or huggingface.",
      {
        code:
          "CONFIGURATION_ERROR",
      },
    );

  }


  /*
   * Explicit provider always wins.
   */

  if (
    configured !== "auto"
  ) {

    return configured;

  }


  /*
   * SEEFIX now uses the local FastAPI/Ollama
   * agent as the default provider everywhere.
   *
   * On Vercel, LOCAL_AGENT_URL must point to
   * the public Cloudflare Tunnel URL.
   */

  return "local";

}


/*
|--------------------------------------------------------------------------
| Utility
|--------------------------------------------------------------------------
*/

function positiveInteger(
  value,
  fallback,
) {

  const parsed =
    Number.parseInt(
      value ?? "",
      10,
    );


  return (
    Number.isFinite(
      parsed,
    ) &&
    parsed > 0
  )
    ? parsed
    : fallback;

}


/*
|--------------------------------------------------------------------------
| Normalize URL
|--------------------------------------------------------------------------
*/

function normalizeBaseUrl(
  url,
) {

  return String(
    url || "",
  )
    .trim()
    .replace(
      /\/+$/,
      "",
    );

}


/*
|--------------------------------------------------------------------------
| Resolve Local Agent URL
|--------------------------------------------------------------------------
*/

function resolveLocalAgentBaseUrl(
  environment,
) {

  const configuredUrl =
    environment
      .LOCAL_AGENT_URL
      ?.trim();


  /*
   * Vercel cannot use its own 127.0.0.1 to
   * reach your Windows PC.
   *
   * A public Cloudflare Tunnel URL must be
   * configured.
   */

  if (
    environment.VERCEL &&
    !configuredUrl
  ) {

    throw new AgentClientError(
      "LOCAL_AGENT_URL is required on Vercel. "
      +
      "Set it to the public Cloudflare Tunnel URL.",
      {
        code:
          "CONFIGURATION_ERROR",
      },
    );

  }


  return normalizeBaseUrl(
    configuredUrl ||
    "http://127.0.0.1:8000",
  );

}


/*
|--------------------------------------------------------------------------
| Local Agent Secret
|--------------------------------------------------------------------------
|
| Python FastAPI expects:
|
|   X-SEEFIX-AGENT-KEY
|
| The browser must NEVER receive this secret.
|
| It is stored only in:
|
|   Python:
|       SEEFIX_AGENT_API_KEY
|
|   Vercel:
|       LOCAL_AGENT_SECRET
|
*/

function requireLocalAgentSecret(
  environment,
) {

  const secret =
    environment
      .LOCAL_AGENT_SECRET
      ?.trim();


  if (!secret) {

    throw new AgentClientError(
      "LOCAL_AGENT_SECRET is required when using the local SEEFIX agent.",
      {
        code:
          "CONFIGURATION_ERROR",
      },
    );

  }


  return secret;

}


/*
|--------------------------------------------------------------------------
| Build Local Agent Headers
|--------------------------------------------------------------------------
|
| X-SEEFIX-AGENT-KEY:
|     Protects FastAPI itself.
|
| CF-Access-*:
|     Optional.
|
|     These can be enabled later when the permanent
|     Cloudflare Tunnel is protected with Cloudflare Access.
|
*/

function buildLocalAgentHeaders(
  environment,
) {

  const secret =
    requireLocalAgentSecret(
      environment,
    );


  const headers = {

    "X-SEEFIX-AGENT-KEY":
      secret,

  };


  const cloudflareClientId =
    environment
      .CLOUDFLARE_ACCESS_CLIENT_ID
      ?.trim();


  const cloudflareClientSecret =
    environment
      .CLOUDFLARE_ACCESS_CLIENT_SECRET
      ?.trim();


  /*
   * Prevent half-configured Cloudflare Access.
   */

  if (
    Boolean(
      cloudflareClientId,
    )
    !==
    Boolean(
      cloudflareClientSecret,
    )
  ) {

    throw new AgentClientError(
      "Both CLOUDFLARE_ACCESS_CLIENT_ID and "
      +
      "CLOUDFLARE_ACCESS_CLIENT_SECRET must be configured together.",
      {
        code:
          "CONFIGURATION_ERROR",
      },
    );

  }


  if (
    cloudflareClientId &&
    cloudflareClientSecret
  ) {

    headers[
      "CF-Access-Client-Id"
    ] =
      cloudflareClientId;


    headers[
      "CF-Access-Client-Secret"
    ] =
      cloudflareClientSecret;

  }


  return headers;

}


/*
|--------------------------------------------------------------------------
| Extract Useful Upstream Error
|--------------------------------------------------------------------------
*/

function getErrorDetail(
  error,
) {

  const parts = [];

  let current =
    error;

  let depth =
    0;


  while (
    current &&
    depth < 4
  ) {

    if (
      typeof current ===
        "object" &&
      typeof current.message ===
        "string" &&
      current.message.trim()
    ) {

      parts.push(
        current.message.trim(),
      );

    } else if (
      typeof current ===
        "string" &&
      current.trim()
    ) {

      parts.push(
        current.trim(),
      );

    }


    current =
      typeof current ===
        "object"
        ? current.cause
        : undefined;


    depth += 1;

  }


  return [
    ...new Set(
      parts,
    ),
  ].join(
    " | ",
  );

}


/*
|--------------------------------------------------------------------------
| Promise Timeout
|--------------------------------------------------------------------------
*/

function timeoutAfter(
  promise,
  timeoutMs,
  provider,
) {

  let timer;


  const timeout =
    new Promise(
      (
        _,
        reject,
      ) => {

        timer =
          setTimeout(
            () => {

              reject(
                new AgentClientError(
                  `${provider} agent exceeded the ${Math.ceil(
                    timeoutMs / 1000,
                  )}-second timeout.`,
                  {
                    code:
                      "AGENT_TIMEOUT",
                  },
                ),
              );

            },
            timeoutMs,
          );

      },
    );


  return Promise
    .race([
      promise,
      timeout,
    ])
    .finally(
      () => {

        clearTimeout(
          timer,
        );

      },
    );

}


/*
|--------------------------------------------------------------------------
| Hugging Face Authentication
|--------------------------------------------------------------------------
|
| Legacy provider support only.
|
*/

function requireHuggingFaceToken(
  environment,
) {

  const token =
    environment
      .HF_TOKEN
      ?.trim();


  if (!token) {

    throw new AgentClientError(
      "HF_TOKEN is required when using the Hugging Face agent.",
      {
        code:
          "CONFIGURATION_ERROR",
      },
    );

  }


  if (
    !token.startsWith(
      "hf_",
    )
  ) {

    throw new AgentClientError(
      "HF_TOKEN is present but does not look like a Hugging Face access token.",
      {
        code:
          "CONFIGURATION_ERROR",
      },
    );

  }


  return token;

}


/*
|--------------------------------------------------------------------------
| Hugging Face Client Cache
|--------------------------------------------------------------------------
*/

let huggingFaceClientPromise;

let connectedSpaceId;


/*
|--------------------------------------------------------------------------
| Clear Cached Hugging Face Client
|--------------------------------------------------------------------------
*/

function clearHuggingFaceClient() {

  huggingFaceClientPromise =
    undefined;

  connectedSpaceId =
    undefined;

}


/*
|--------------------------------------------------------------------------
| Connect Hugging Face
|--------------------------------------------------------------------------
*/

async function getHuggingFaceClient(
  spaceId,
  hfToken,
) {

  if (
    !huggingFaceClientPromise ||
    connectedSpaceId !== spaceId
  ) {

    connectedSpaceId =
      spaceId;


    huggingFaceClientPromise =
      Client.connect(
        spaceId,
        {
          hf_token:
            hfToken,
        },
      )
        .catch(
          (error) => {

            clearHuggingFaceClient();

            throw error;

          },
        );

  }


  return huggingFaceClientPromise;

}


/*
|--------------------------------------------------------------------------
| Local / Cloudflare FastAPI Analysis
|--------------------------------------------------------------------------
|
| Local Node development:
|
|   LOCAL_AGENT_URL=http://127.0.0.1:8000
|
| Vercel:
|
|   LOCAL_AGENT_URL=https://xxxxx.trycloudflare.com
|
| or later:
|
|   LOCAL_AGENT_URL=https://agent.your-domain.com
|
*/

async function analyzeWithLocalAgent(
  file,
  environment,
  timeoutMs,
) {

  const baseUrl =
    resolveLocalAgentBaseUrl(
      environment,
    );


  const headers =
    buildLocalAgentHeaders(
      environment,
    );


  const form =
    new FormData();


  form.append(
    "image",

    new Blob(
      [
        file.buffer,
      ],
      {
        type:
          file.mimetype,
      },
    ),

    file.originalname ||
      "facility-image",
  );


  const controller =
    new AbortController();


  const timer =
    setTimeout(
      () => {

        controller.abort();

      },
      timeoutMs,
    );


  try {

    const response =
      await fetch(
        `${baseUrl}/api/analyze`,
        {
          method:
            "POST",

          headers,

          body:
            form,

          signal:
            controller.signal,
        },
      );


    const contentType =
      response
        .headers
        .get(
          "content-type",
        ) || "";


    const payload =
      contentType.includes(
        "application/json",
      )
        ? await response.json()
        : {
            detail:
              await response.text(),
          };


    if (
      !response.ok
    ) {

      const message =
        payload?.detail ||
        `SEEFIX FastAPI agent returned HTTP ${response.status}.`;


      throw new AgentClientError(
        message,
        {
          code:
            "LOCAL_AGENT_RESPONSE_ERROR",

          upstreamDetail:
            JSON.stringify(
              payload,
            ),
        },
      );

    }


    return payload;

  } catch (
    error
  ) {

    if (
      error instanceof
        AgentClientError
    ) {

      throw error;

    }


    if (
      error?.name ===
        "AbortError"
    ) {

      throw new AgentClientError(
        `SEEFIX FastAPI agent exceeded the ${Math.ceil(
          timeoutMs / 1000,
        )}-second timeout.`,
        {
          code:
            "AGENT_TIMEOUT",

          cause:
            error,
        },
      );

    }


    throw new AgentClientError(
      `Unable to reach the SEEFIX FastAPI agent at ${baseUrl}.`,
      {
        code:
          "AGENT_UNAVAILABLE",

        cause:
          error,

        upstreamDetail:
          getErrorDetail(
            error,
          ),
      },
    );

  } finally {

    clearTimeout(
      timer,
    );

  }

}


/*
|--------------------------------------------------------------------------
| Hugging Face Analysis
|--------------------------------------------------------------------------
|
| Kept only as an optional legacy provider.
|
*/

async function analyzeWithHuggingFace(
  file,
  environment,
  timeoutMs,
) {

  const spaceId =
    (
      environment
        .HF_SPACE_ID ||
      "erwinramirez220/seefix-agents"
    )
      .trim();


  const hfToken =
    requireHuggingFaceToken(
      environment,
    );


  try {

    const client =
      await timeoutAfter(
        getHuggingFaceClient(
          spaceId,
          hfToken,
        ),

        timeoutMs,

        "Hugging Face",
      );


    const imageFile =
      new File(
        [
          file.buffer,
        ],

        file.originalname ||
          "facility-image.jpg",

        {
          type:
            file.mimetype ||
            "image/jpeg",
        },
      );


    const result =
      await timeoutAfter(

        client.predict(
          "/analyze",
          [
            handle_file(
              imageFile,
            ),
          ],
        ),

        timeoutMs,

        "Hugging Face",
      );


    if (
      !result ||
      !Array.isArray(
        result.data,
      ) ||
      result.data.length === 0
    ) {

      throw new AgentClientError(
        "The Hugging Face agent returned an empty response.",
        {
          code:
            "INVALID_AGENT_RESPONSE",
        },
      );

    }


    return result.data[0];

  } catch (
    error
  ) {

    if (
      error instanceof
        AgentClientError
    ) {

      throw error;

    }


    clearHuggingFaceClient();


    const upstreamDetail =
      getErrorDetail(
        error,
      );


    throw new AgentClientError(
      "The Hugging Face agent request failed.",
      {
        code:
          "AGENT_UPSTREAM_ERROR",

        cause:
          error,

        upstreamDetail,
      },
    );

  }

}


/*
|--------------------------------------------------------------------------
| Local / Cloudflare FastAPI Health Probe
|--------------------------------------------------------------------------
*/

async function probeLocalAgent(
  environment,
  timeoutMs,
) {

  const baseUrl =
    resolveLocalAgentBaseUrl(
      environment,
    );


  /*
   * FastAPI /health is currently public,
   * but sending the agent header here makes this
   * compatible if /health is protected later.
   *
   * It also allows the same optional Cloudflare
   * Access service-token headers.
   */

  const headers =
    buildLocalAgentHeaders(
      environment,
    );


  const controller =
    new AbortController();


  const timer =
    setTimeout(
      () => {

        controller.abort();

      },
      timeoutMs,
    );


  try {

    const response =
      await fetch(
        `${baseUrl}/health`,
        {
          method:
            "GET",

          headers,

          signal:
            controller.signal,
        },
      );


    const contentType =
      response
        .headers
        .get(
          "content-type",
        ) || "";


    const payload =
      contentType.includes(
        "application/json",
      )
        ? await response.json()
        : {
            detail:
              await response.text(),
          };


    if (
      !response.ok
    ) {

      throw new AgentClientError(
        payload?.detail ||
        `FastAPI health endpoint returned HTTP ${response.status}.`,
        {
          code:
            "LOCAL_AGENT_RESPONSE_ERROR",

          upstreamDetail:
            JSON.stringify(
              payload,
            ),
        },
      );

    }


    return {
      url:
        baseUrl,

      response:
        payload,
    };

  } catch (
    error
  ) {

    if (
      error instanceof
        AgentClientError
    ) {

      throw error;

    }


    if (
      error?.name ===
        "AbortError"
    ) {

      throw new AgentClientError(
        `SEEFIX agent health check exceeded ${Math.ceil(
          timeoutMs / 1000,
        )} seconds.`,
        {
          code:
            "AGENT_TIMEOUT",

          cause:
            error,
        },
      );

    }


    throw new AgentClientError(
      `Unable to reach the SEEFIX FastAPI agent at ${baseUrl}.`,
      {
        code:
          "AGENT_UNAVAILABLE",

        cause:
          error,

        upstreamDetail:
          getErrorDetail(
            error,
          ),
      },
    );

  } finally {

    clearTimeout(
      timer,
    );

  }

}


/*
|--------------------------------------------------------------------------
| Hugging Face Health Probe
|--------------------------------------------------------------------------
*/

async function probeHuggingFaceAgent(
  environment,
  timeoutMs,
) {

  const spaceId =
    (
      environment
        .HF_SPACE_ID ||
      "erwinramirez220/seefix-agents"
    )
      .trim();


  const hfToken =
    requireHuggingFaceToken(
      environment,
    );


  try {

    const client =
      await timeoutAfter(
        getHuggingFaceClient(
          spaceId,
          hfToken,
        ),

        timeoutMs,

        "Hugging Face",
      );


    const result =
      await timeoutAfter(

        client.predict(
          "/health",
          [
            "vercel-probe",
          ],
        ),

        timeoutMs,

        "Hugging Face",
      );


    return {
      space_id:
        spaceId,

      response:
        result?.data?.[0] ??
        result?.data ??
        null,
    };

  } catch (
    error
  ) {

    if (
      error instanceof
        AgentClientError
    ) {

      throw error;

    }


    clearHuggingFaceClient();


    throw new AgentClientError(
      "Unable to reach the Hugging Face Space health endpoint.",
      {
        code:
          "AGENT_UPSTREAM_ERROR",

        cause:
          error,

        upstreamDetail:
          getErrorDetail(
            error,
          ),
      },
    );

  }

}


/*
|--------------------------------------------------------------------------
| Analyze Image
|--------------------------------------------------------------------------
*/

export async function analyzeImage(
  file,
  environment = process.env,
) {

  const provider =
    resolveAgentProvider(
      environment,
    );


  const timeoutMs =
    positiveInteger(
      environment
        .AGENT_TIMEOUT_MS,

      240_000,
    );


  if (
    provider === "local"
  ) {

    return analyzeWithLocalAgent(
      file,
      environment,
      timeoutMs,
    );

  }


  return analyzeWithHuggingFace(
    file,
    environment,
    timeoutMs,
  );

}


/*
|--------------------------------------------------------------------------
| Probe Agent
|--------------------------------------------------------------------------
*/

export async function probeAgent(
  environment = process.env,
) {

  const provider =
    resolveAgentProvider(
      environment,
    );


  const timeoutMs =
    positiveInteger(
      environment
        .AGENT_HEALTH_TIMEOUT_MS,

      20_000,
    );


  if (
    provider === "local"
  ) {

    return {
      provider,

      upstream:
        await probeLocalAgent(
          environment,
          timeoutMs,
        ),
    };

  }


  return {
    provider,

    upstream:
      await probeHuggingFaceAgent(
        environment,
        timeoutMs,
      ),
  };

}
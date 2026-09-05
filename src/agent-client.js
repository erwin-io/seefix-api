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


  if (
    configured !== "auto"
  ) {

    return configured;

  }


  /*
   * Local computer:
   *     local FastAPI/Ollama
   *
   * Vercel:
   *     Hugging Face Space
   */

  return environment.VERCEL
    ? "huggingface"
    : "local";

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


function normalizeBaseUrl(
  url,
) {

  return url.replace(
    /\/+$/,
    "",
  );

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

  let depth = 0;


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
    ...new Set(parts),
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
      "HF_TOKEN is required when using the Hugging Face ZeroGPU agent.",
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
| Clear Cached Client
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

          /*
           * @gradio/client 2.5.1
           *
           * The project currently uses:
           *
           * "@gradio/client": "2.5.1"
           *
           * Version 2.5.1 supports hf_token.
           *
           * This is important for ZeroGPU.
           */

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
| Local Agent
|--------------------------------------------------------------------------
*/

async function analyzeWithLocalAgent(
  file,
  environment,
  timeoutMs,
) {

  const baseUrl =
    normalizeBaseUrl(
      environment
        .LOCAL_AGENT_URL ||
      "http://127.0.0.1:8000",
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
        `Local agent returned HTTP ${response.status}.`;


      throw new AgentClientError(
        message,
        {
          code:
            "LOCAL_AGENT_RESPONSE_ERROR",
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
        `Local agent exceeded the ${Math.ceil(
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
      `Unable to reach the local agent at ${baseUrl}. Start FastAPI/Ollama first.`,
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


  /*
   * Do not make anonymous ZeroGPU
   * requests from Vercel.
   */

  const hfToken =
    requireHuggingFaceToken(
      environment,
    );


  try {

    /*
     * Connect to the Space.
     */

    const client =
      await timeoutAfter(
        getHuggingFaceClient(
          spaceId,
          hfToken,
        ),

        timeoutMs,

        "Hugging Face",
      );


    /*
     * Preserve:
     *
     * - image bytes
     * - MIME type
     * - filename
     *
     * File works better than sending an
     * anonymous Blob directly.
     */

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


    /*
     * IMPORTANT:
     *
     * Gradio image inputs use FileData
     * internally.
     *
     * handle_file() uploads the file and
     * converts it to the structure expected
     * by the remote Gradio application.
     */

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


    /*
     * Validate Gradio response.
     */

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


    /*
     * gr.JSON output is the first output.
     */

    return result.data[0];

  } catch (
    error
  ) {

    /*
     * Preserve our own known errors.
     */

    if (
      error instanceof
        AgentClientError
    ) {

      throw error;

    }


    /*
     * Space may restart/rebuild/sleep.
     *
     * Never keep a stale connection after
     * an upstream failure.
     */

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
| Local Health Probe
|--------------------------------------------------------------------------
*/

async function probeLocalAgent(
  environment,
  timeoutMs,
) {

  const baseUrl =
    normalizeBaseUrl(
      environment
        .LOCAL_AGENT_URL ||
      "http://127.0.0.1:8000",
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

      throw new Error(
        payload?.detail ||
        `HTTP ${response.status}`,
      );

    }


    return payload;

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
|
| Your Space already has:
|
|     gr.api(
|         health_check,
|         api_name="health",
|     )
|
| This call does NOT request ZeroGPU.
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


  /*
   * Health check should fail quickly.
   *
   * This does not run image inference.
   */

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
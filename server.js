import "dotenv/config";

import path from "node:path";

import {
  fileURLToPath,
  pathToFileURL,
} from "node:url";

import express from "express";
import multer from "multer";

import {
  AgentClientError,
  analyzeImage,
  probeAgent,
  resolveAgentProvider,
} from "./src/agent-client.js";


const app =
  express();


const port =
  Number.parseInt(
    process.env.PORT ||
      "3000",
    10,
  );


const maxUploadMb =
  Number.parseFloat(
    process.env.MAX_UPLOAD_MB ||
      "4",
  );


const maxUploadBytes =
  Math.floor(
    maxUploadMb *
      1024 *
      1024,
  );


const allowedImageTypes =
  new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
  ]);


/*
|--------------------------------------------------------------------------
| Paths
|--------------------------------------------------------------------------
*/

const __dirname =
  path.dirname(
    fileURLToPath(
      import.meta.url,
    ),
  );


const publicDir =
  path.join(
    __dirname,
    "public",
  );


/*
|--------------------------------------------------------------------------
| Upload
|--------------------------------------------------------------------------
*/

const upload =
  multer({

    storage:
      multer.memoryStorage(),

    limits: {

      fileSize:
        maxUploadBytes,

      files: 1,

    },

  });


app.disable(
  "x-powered-by",
);


app.use(
  express.json({
    limit:
      "1mb",
  }),
);


/*
|--------------------------------------------------------------------------
| Redact Secrets
|--------------------------------------------------------------------------
*/

function redactSecrets(
  value,
) {

  if (!value) {
    return undefined;
  }


  return String(
    value,
  )
    .replace(
      /hf_[A-Za-z0-9._-]+/g,
      "hf_[REDACTED]",
    )
    .slice(
      0,
      1500,
    );

}


/*
|--------------------------------------------------------------------------
| Agent Error Response
|--------------------------------------------------------------------------
*/

function agentErrorPayload(
  error,
) {

  const knownError =
    error instanceof
      AgentClientError;


  const code =
    knownError
      ? error.code
      : "UNEXPECTED_ERROR";


  /*
   * Only expose upstream details when
   * explicitly enabled.
   *
   * Enable temporarily in Vercel:
   *
   * AGENT_DEBUG_ERRORS=true
   */

  const debugEnabled =
    process.env
      .AGENT_DEBUG_ERRORS ===
    "true";


  const payload = {

    detail:
      knownError
        ? error.message
        : "The facility inspection agent failed unexpectedly.",

    code,

  };


  if (
    debugEnabled &&
    knownError &&
    error.upstreamDetail
  ) {

    payload.upstream_detail =
      redactSecrets(
        error.upstreamDetail,
      );

  }


  return payload;

}


/*
|--------------------------------------------------------------------------
| Agent HTTP Status
|--------------------------------------------------------------------------
*/

function statusForAgentError(
  error,
) {

  const code =
    error instanceof
      AgentClientError
      ? error.code
      : "UNEXPECTED_ERROR";


  if (
    code ===
    "AGENT_TIMEOUT"
  ) {

    return 504;

  }


  if (
    code ===
    "AGENT_UNAVAILABLE"
  ) {

    return 503;

  }


  if (
    code ===
    "CONFIGURATION_ERROR"
  ) {

    return 500;

  }


  return 502;

}


/*
|--------------------------------------------------------------------------
| Web UI
|--------------------------------------------------------------------------
*/

app.get(
  "/",
  (
    _req,
    res,
  ) => {

    res.sendFile(
      path.join(
        publicDir,
        "index.html",
      ),
    );

  },
);


app.use(
  express.static(
    publicDir,
  ),
);


/*
|--------------------------------------------------------------------------
| Application Health
|--------------------------------------------------------------------------
*/

app.get(
  "/health",
  (
    _req,
    res,
  ) => {

    try {

      const provider =
        resolveAgentProvider();


      res
        .status(
          200,
        )
        .json({

          status:
            "ok",

          service:
            "seefix-api",

          agent_provider:
            provider,

          runtime:
            process.env.VERCEL
              ? "vercel"
              : "local",

          huggingface: {

            space_id:
              process.env
                .HF_SPACE_ID ||
              "erwinramirez220/seefix-agents",

            /*
             * Do NOT expose the token itself.
             */

            token_configured:
              Boolean(
                process.env
                  .HF_TOKEN,
              ),

          },

        });

    } catch (
      error
    ) {

      res
        .status(
          500,
        )
        .json({

          status:
            "configuration_error",

          detail:
            error.message,

        });

    }

  },
);


/*
|--------------------------------------------------------------------------
| Upstream Agent Health
|--------------------------------------------------------------------------
|
| This checks:
|
| Vercel
|   ↓
| Hugging Face
|   ↓
| Gradio /health
|
| The Hugging Face health function does not request GPU inference.
|--------------------------------------------------------------------------
*/

app.get(
  "/health/agent",
  async (
    _req,
    res,
  ) => {

    try {

      const result =
        await probeAgent();


      return res
        .status(
          200,
        )
        .json({

          status:
            "ok",

          ...result,

        });

    } catch (
      error
    ) {

      const status =
        statusForAgentError(
          error,
        );


      console.error(
        "SEEFIX upstream health error",
        {

          code:
            error instanceof
              AgentClientError
              ? error.code
              : "UNEXPECTED_ERROR",

          message:
            redactSecrets(
              error instanceof
                Error
                ? error.message
                : String(
                    error,
                  ),
            ),

          upstream:
            redactSecrets(
              error instanceof
                AgentClientError
                ? error
                    .upstreamDetail
                : undefined,
            ),

        },
      );


      return res
        .status(
          status,
        )
        .json(
          agentErrorPayload(
            error,
          ),
        );

    }

  },
);


/*
|--------------------------------------------------------------------------
| Assessment API
|--------------------------------------------------------------------------
*/

app.post(
  "/api/analyze",

  upload.single(
    "image",
  ),

  async (
    req,
    res,
  ) => {

    /*
     * Image required.
     */

    if (
      !req.file
    ) {

      return res
        .status(
          400,
        )
        .json({

          detail:
            "An image file is required.",

        });

    }


    /*
     * Validate MIME type.
     */

    if (
      !allowedImageTypes.has(
        req.file.mimetype,
      )
    ) {

      return res
        .status(
          415,
        )
        .json({

          detail:
            "The image must be JPEG, PNG, or WebP.",

        });

    }


    try {

      /*
       * Forward to the selected
       * facility inspection agent.
       */

      const assessment =
        await analyzeImage(
          req.file,
        );


      return res
        .status(
          200,
        )
        .json(
          assessment,
        );

    } catch (
      error
    ) {

      const status =
        statusForAgentError(
          error,
        );


      /*
       * Vercel Functions logs will now contain
       * the real upstream Gradio error.
       *
       * HF tokens are redacted.
       */

      console.error(
        "SEEFIX agent error",
        {

          code:
            error instanceof
              AgentClientError
              ? error.code
              : "UNEXPECTED_ERROR",

          message:
            redactSecrets(
              error instanceof
                Error
                ? error.message
                : String(
                    error,
                  ),
            ),

          upstream:
            redactSecrets(
              error instanceof
                AgentClientError
                ? error
                    .upstreamDetail
                : undefined,
            ),

        },
      );


      return res
        .status(
          status,
        )
        .json(
          agentErrorPayload(
            error,
          ),
        );

    }

  },
);


/*
|--------------------------------------------------------------------------
| Multer / Unhandled Error
|--------------------------------------------------------------------------
*/

app.use(
  (
    error,
    _req,
    res,
    _next,
  ) => {

    if (
      error instanceof
        multer.MulterError
    ) {

      if (
        error.code ===
        "LIMIT_FILE_SIZE"
      ) {

        return res
          .status(
            413,
          )
          .json({

            detail:
              `The image exceeds the ${maxUploadMb} MB limit.`,

          });

      }


      return res
        .status(
          400,
        )
        .json({

          detail:
            error.message,

        });

    }


    console.error(
      "Unhandled API error",
      error,
    );


    return res
      .status(
        500,
      )
      .json({

        detail:
          "Internal server error.",

      });

  },
);


/*
|--------------------------------------------------------------------------
| Local Server
|--------------------------------------------------------------------------
*/

const isDirectRun =
  process.argv[1] &&
  import.meta.url ===
    pathToFileURL(
      process.argv[1],
    ).href;


if (
  !process.env.VERCEL &&
  isDirectRun
) {

  app.listen(
    port,
    "127.0.0.1",
    () => {

      console.log(
        `SEEFIX running at http://127.0.0.1:${port} (${resolveAgentProvider()} agent)`,
      );

    },
  );

}


export default app;
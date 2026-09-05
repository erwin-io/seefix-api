import "dotenv/config";

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import express from "express";
import multer from "multer";

import {
  AgentClientError,
  analyzeImage,
  resolveAgentProvider,
} from "./src/agent-client.js";

const app = express();
const port = Number.parseInt(process.env.PORT || "3000", 10);
const maxUploadMb = Number.parseFloat(process.env.MAX_UPLOAD_MB || "4");
const maxUploadBytes = Math.floor(maxUploadMb * 1024 * 1024);

const allowedImageTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: maxUploadBytes,
    files: 1,
  },
});

app.disable("x-powered-by");

app.use(
  express.json({
    limit: "1mb",
  }),
);

/*
|--------------------------------------------------------------------------
| Web UI
|--------------------------------------------------------------------------
*/

app.get("/", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.use(express.static(publicDir));

/*
|--------------------------------------------------------------------------
| Health
|--------------------------------------------------------------------------
*/

app.get("/health", (_req, res) => {
  try {
    res.status(200).json({
      status: "ok",
      service: "seefix-api",
      agent_provider: resolveAgentProvider(),
      runtime: process.env.VERCEL ? "vercel" : "local",
    });
  } catch (error) {
    res.status(500).json({
      status: "configuration_error",
      detail: error.message,
    });
  }
});

/*
|--------------------------------------------------------------------------
| Assessment API
|--------------------------------------------------------------------------
*/

app.post(
  "/api/analyze",
  upload.single("image"),
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({
        detail: "An image file is required.",
      });
    }

    if (!allowedImageTypes.has(req.file.mimetype)) {
      return res.status(415).json({
        detail: "The image must be JPEG, PNG, or WebP.",
      });
    }

    try {
      const assessment = await analyzeImage(req.file);

      return res.status(200).json(assessment);
    } catch (error) {
      const knownError = error instanceof AgentClientError;
      const code = knownError
        ? error.code
        : "UNEXPECTED_ERROR";

      const status =
        code === "AGENT_TIMEOUT"
          ? 504
          : code === "AGENT_UNAVAILABLE"
            ? 503
            : code === "CONFIGURATION_ERROR"
              ? 500
              : 502;

      console.error("SEEFIX agent error", {
        code,
        message:
          error instanceof Error
            ? error.message
            : String(error),
        cause:
          error instanceof Error
            ? error.cause?.message
            : undefined,
      });

      return res.status(status).json({
        detail: knownError
          ? error.message
          : "The facility inspection agent failed unexpectedly.",
        code,
      });
    }
  },
);

/*
|--------------------------------------------------------------------------
| Error Handler
|--------------------------------------------------------------------------
*/

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        detail: `The image exceeds the ${maxUploadMb} MB limit.`,
      });
    }

    return res.status(400).json({
      detail: error.message,
    });
  }

  console.error("Unhandled API error", error);

  return res.status(500).json({
    detail: "Internal server error.",
  });
});

/*
|--------------------------------------------------------------------------
| Local Server
|--------------------------------------------------------------------------
*/

const isDirectRun =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (!process.env.VERCEL && isDirectRun) {
  app.listen(port, "127.0.0.1", () => {
    console.log(
      `SEEFIX running at http://127.0.0.1:${port} (${resolveAgentProvider()} agent)`,
    );
  });
}

export default app;
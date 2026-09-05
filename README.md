# SEEFIX API

Express API gateway for the SEEFIX facility inspection agent. Applications make one multipart request to this API regardless of where the AI agent runs.

## Request flow

- Local development: Express forwards the image to the local FastAPI/Ollama endpoint.
- Vercel production: Express sends the image to the Hugging Face Gradio Space.
- Client contract: `POST /api/analyze` with one `image` file in both environments.

`AGENT_PROVIDER=auto` performs the environment switch. It selects `local` normally and `huggingface` when the `VERCEL` environment variable is present.

## Requirements

- Node.js 20 or newer
- For local AI inference, the SEEFIX Python agent running at `http://127.0.0.1:8000`

## Local setup

```cmd
npm install
copy .env.example .env
npm run dev
```

Keep this setting in `.env`:

```dotenv
AGENT_PROVIDER=auto
LOCAL_AGENT_URL=http://127.0.0.1:8000
```

Start the Python agent separately on port 8000. Express runs on port 3000.

## One-call test

Windows Command Prompt:

```cmd
curl --location "http://127.0.0.1:3000/api/analyze" ^
  --form "image=@C:\Users\Erwin\Downloads\sample.jpeg"
```

PowerShell:

```powershell
curl.exe --location "http://127.0.0.1:3000/api/analyze" `
  --form "image=@C:\Users\Erwin\Downloads\sample.jpeg"
```

Postman configuration:

1. Method: `POST`
2. URL: `http://127.0.0.1:3000/api/analyze`
3. Body → `form-data`
4. Key: `image`, type: File
5. Select the image and send the request.

Do not manually add a `Content-Type` header; Postman/curl supplies the multipart boundary.

## Test the hosted agent through local Express

Set this temporarily in `.env` and restart Node:

```dotenv
AGENT_PROVIDER=huggingface
HF_SPACE_ID=erwinramirez220/seefix-agents
```

Use the same `POST /api/analyze` request. Set it back to `auto` for ordinary development.

## Deploy to Vercel

1. Push this project to GitHub.
2. Import the repository into Vercel as a new project.
3. Use the default framework detection and build settings.
4. Add these environment variables in Vercel Project Settings → Environment Variables:

```dotenv
AGENT_PROVIDER=auto
HF_SPACE_ID=erwinramirez220/seefix-agents
AGENT_TIMEOUT_MS=240000
MAX_UPLOAD_MB=4
```

5. Deploy. Vercel sets `VERCEL=1`, so `auto` selects Hugging Face.

Production test:

```cmd
curl --location "https://YOUR-PROJECT.vercel.app/api/analyze" ^
  --form "image=@C:\Users\Erwin\Downloads\sample.jpeg"
```

The Hugging Face Space is public, so no access token is required. If it is changed to private later, authenticated client support must be added before deployment.

## API responses

| Status | Meaning |
| --- | --- |
| `200` | Assessment returned |
| `400` | Missing image or invalid multipart request |
| `413` | File is larger than the configured limit |
| `415` | Unsupported image format |
| `502` | Agent returned an error or invalid response |
| `503` | Local agent is not reachable |
| `504` | Agent processing exceeded the timeout |

The Vercel upload limit is 4.5 MB for the entire request body. `MAX_UPLOAD_MB=4` leaves room for multipart overhead. Compress larger mobile photos before uploading. For larger originals in the complete system, upload the image directly to object storage and pass a signed URL to a separate protected agent endpoint.

## Health check

```cmd
curl "http://127.0.0.1:3000/health"
```

Local automatic mode returns `"agent_provider":"local"`. A Vercel deployment returns `"agent_provider":"huggingface"`.

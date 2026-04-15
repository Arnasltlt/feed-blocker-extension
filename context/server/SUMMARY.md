# Server (`server/`)

Canonical code: [`server/server.py`](../../server/server.py), dependencies: [`server/requirements.txt`](../../server/requirements.txt).

## Endpoints

| Route | Method | Purpose |
|-------|--------|---------|
| `/rerank` | POST | Body: `{ "videos": [{ "title", "url", "channel", ... }] }` → grouped categories via Groq structured output (with heuristics if API fails) |
| `/summarize` | POST | Body: normalized cross-platform feed items → “Talk of the Town” style brief via OpenRouter (with caching, rate limits, heuristics) |

## Environment variables (typical)

| Variable | Role |
|----------|------|
| `GROQ_API_KEY` | Required for Groq `/rerank` path |
| `GROQ_MODEL` | Default `openai/gpt-oss-20b` (see `server.py`) |
| `OPENROUTER_API_KEY` | For `/summarize` |
| `OPENROUTER_SUMMARY_MODEL` | Default Gemini-class preview model (allowlist in `server.py`) |
| `CUSTOM_FEED_MAX_VIDEOS` | Cap for rerank input |
| `CUSTOM_FEED_SERVER_PORT` | Local dev port (default `11400`; Fly uses `PORT`) |

## Deployment

- Container: root [`Dockerfile`](../../Dockerfile) — Python 3.12-slim, installs `server/requirements.txt`, runs `server.py`.
- Fly.io: [`fly.toml`](../../fly.toml) — app `feed-blocking-server`, internal port 8080.

## Extension integration

Background/content scripts call `http://127.0.0.1:11400` or `https://feed-blocking-server.fly.dev` for rerank/summarize (see [`extension/background.js`](../../extension/background.js) and [`extension/feed.js`](../../extension/feed.js)).

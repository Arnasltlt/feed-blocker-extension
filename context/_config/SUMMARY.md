# Config and constraints

Canonical files live at repo paths below; this folder only routes.

| Topic | File | Notes |
|-------|------|--------|
| User-facing setup | [`README.md`](../../README.md) | Install, local Groq server, how blocking works |
| Chrome “Load unpacked” | [`CHROME-LOAD-UNPACKED.txt`](../../CHROME-LOAD-UNPACKED.txt) | Must load `extension/` only (no repo root / `__pycache__`) |
| Git ignore rules | [`.gitignore`](../../.gitignore) | venv, `__pycache__`, `.env`, etc. |
| Docker build context | [`.dockerignore`](../../.dockerignore) | What the image excludes |
| Fly app | [`fly.toml`](../../fly.toml) | `feed-blocking-server`, region, HTTP service |
| Container image | [`Dockerfile`](../../Dockerfile) | Python 3.12, Flask app entrypoint |

**Secrets:** never commit `GROQ_API_KEY` or `OPENROUTER_API_KEY`; set in shell locally or Fly secrets for production.

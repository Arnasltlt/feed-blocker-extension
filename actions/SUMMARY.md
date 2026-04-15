# Repeatable procedures

## Load the extension in Chrome

1. `chrome://extensions/` → enable Developer mode.
2. **Load unpacked** → select **only** [`extension/`](../extension/) (folder containing `manifest.json`).
3. If the repo root was selected by mistake, Chrome may error on `__pycache__` — see [`CHROME-LOAD-UNPACKED.txt`](../CHROME-LOAD-UNPACKED.txt).

## Stage a clean copy for Chrome (optional)

```bash
bash scripts/stage-chrome-extension.sh
```

Use the printed `/tmp/...` path as **Load unpacked** target (no venv cruft).

## Run the Python server locally

From repo root (after `pip install -r server/requirements.txt` in a venv):

```bash
export GROQ_API_KEY=...
# optional: OPENROUTER_API_KEY, GROQ_MODEL, CUSTOM_FEED_SERVER_PORT, etc.
python server/server.py
```

Default local port in code is typically `11400` (see `server/server.py`).

## Deploy server to Fly.io

Use [`Dockerfile`](../Dockerfile) and [`fly.toml`](../fly.toml). Set secrets (e.g. API keys) via `fly secrets set` as required. App name: `feed-blocking-server`.

# Feed Blocker Extension

A browser extension that blocks distracting feeds on YouTube, LinkedIn, and X (Twitter) to help you stay focused.

## Features

- **YouTube**: Removes the home page recommendation feed and (when the local Groq server is running) replaces it with a custom, learning-focused list grouped by topic; falls back to the simple title list if the server is offline.
- **LinkedIn**: Blocks home feed and notification bell across all pages
- **X (Twitter)**: Removes home timeline feeds (For You/Following) and sidebar recommendations

## Installation

1. Clone this repository
2. Open Chrome/Chromium and navigate to `chrome://extensions/`
3. Enable "Developer mode" (toggle in top right)
4. Click "Load unpacked"
5. Select this directory

## Supported Browsers

- Google Chrome
- Chromium-based browsers (including ChatGPT Atlas)

## Local Groq-Powered Custom Feed (YouTube)

1. Install dependencies: `python -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt`
2. Export your Groq API key: `export GROQ_API_KEY=your_key_here`
3. (Optional) Override defaults: `GROQ_MODEL` (default `openai/gpt-oss-20b` for the fastest Structured Output support), `CUSTOM_FEED_MAX_VIDEOS` (default `30`), `CUSTOM_FEED_SERVER_PORT` (default `11400`). The server enables Groq’s **Structured Outputs**, so stick to models that support JSON schema decoding (the default does).
4. Start the server: `python server.py`
5. Keep the server running while you browse YouTube. The content script will call `http://127.0.0.1:11400/rerank` via the extension’s background service worker and render the grouped, reordered list.

If the server is unreachable or the key is missing, the extension automatically falls back to the original (blocked) title list.

## How It Works

The extension uses content scripts to detect and hide feed elements on each platform. There is **no easy bypass** - the only way to disable blocking is to turn off the extension in `chrome://extensions`.

## Files

- `manifest.json` - Extension configuration
- `youtube-home-blocker.js` - YouTube feed blocking logic
- `linkedin-feed-blocker.js` - LinkedIn feed blocking logic
- `x-feed-blocker.js` - X/Twitter feed blocking logic

## License

MIT


# Feed Blocker Extension

A browser extension that blocks distracting feeds on YouTube, LinkedIn, and X (Twitter) to help you stay focused.

## Features

- **YouTube**: Removes home page recommendation feed, displays video titles only as clickable links
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

## How It Works

The extension uses content scripts to detect and hide feed elements on each platform. There is **no easy bypass** - the only way to disable blocking is to turn off the extension in `chrome://extensions`.

## Files

- `manifest.json` - Extension configuration
- `youtube-home-blocker.js` - YouTube feed blocking logic
- `linkedin-feed-blocker.js` - LinkedIn feed blocking logic
- `x-feed-blocker.js` - X/Twitter feed blocking logic

## License

MIT


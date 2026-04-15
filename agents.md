# Agent operating contract — Feed Blocking Extension

## What this project is

A Chrome extension (“Focus Feed”) that blocks distracting feeds on YouTube, LinkedIn, and X/Twitter, with optional AI-backed reranking (Groq) and cross-platform feed summarization (OpenRouter) via a Flask server deployable on Fly.io.

## How to navigate (authoritative path)

1. Read this file (`agents.md`).
2. Read [`list.yml`](list.yml) for the current task queue.
3. Read [`context/SUMMARY.md`](context/SUMMARY.md) to pick a domain.
4. Read that domain’s `SUMMARY.md` under `context/<domain>/`.
5. Open the **real** source files under `extension/` and `server/` (and root config files) as needed.

`context/` holds **routing knowledge** about the codebase. It does **not** duplicate or replace source code; canonical implementation lives in `extension/` and `server/`.

## Editable vs stable

- **Editable for features:** `extension/`, `server/`, root deploy config (`Dockerfile`, `fly.toml`), [`README.md`](README.md).
- **Stable constraints / identity:** summarized under [`context/_config/`](context/_config/SUMMARY.md) (pointing to files on disk).
- **Non-authoritative / scratch / samples:** [`context/_drafts/`](context/_drafts/SUMMARY.md).

## Task tracking

Work items belong in [`list.yml`](list.yml). Do not use `list.yml` as a knowledge dump; put facts in `context/` leaf routing or in code comments when appropriate.

## Repeatable procedures

See [`actions/SUMMARY.md`](actions/SUMMARY.md).

## Outputs and history

Put generated artifacts, session notes, or exports under [`log/`](log/) rather than mixing them into `context/`.

## Tech stack (short)

| Layer | Stack |
|--------|--------|
| Extension | Chrome Manifest V3, vanilla JS, `storage` / `tabs` / `declarativeNetRequest` |
| Server | Python 3.12, Flask, Flask-CORS, `requests` |
| AI | Groq (OpenAI-compatible) for `/rerank`; OpenRouter for `/summarize` |
| Deploy | Docker, Fly.io (`feed-blocking-server`) |

## Learned User Preferences

- Prefer the full My Feed / “Talk of the Town” view to stay sparse: one short headline-style line per topic by default; defer richer detail to a later “Explore” action.
- For grouped topics, avoid copy that reads like one article plus “N more of the same story” when the bucket is only loosely related; prefer theme-level wording and honest sample vs. total counts.
- On `facebook.com/messages`, prefer the tab title to remain “Messenger” (no unread count in the title) and suppress bottom-left notification toasts on that surface.

## Learned Workspace Facts

- Chrome “Load unpacked” must target `extension/` (or a clean copy from `scripts/stage-chrome-extension.sh`), not the repository root; roots that contain Python virtualenvs include `__pycache__`, which Chrome refuses.
- Cross-site feed signal in the extension comes from visible feed DOM plus `chrome.storage` (and optional `/summarize` / `/rerank`), not official platform ranking APIs.

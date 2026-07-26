# AGENTS.md

## Overview
Firefox MV3 extension. No build step, no dependencies. Files are loaded directly by Firefox.

## Loading the extension
1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…**
3. Select `manifest.json`

## Architecture

```
background.js (module)       →  message router + LLM streamer (expand + chat)
content.js                   →  injected into all frames, renders inline bubble UI, persists per-page state
dashboard/                   →  settings, Chat panel, Knowledge Base management
popup/                       →  extension toolbar status popup
src/shared/                  →  prompts, expand-prompt builder, model registry, per-page bubble store
src/background/
├── provider.js              →  streaming LLM client (SSE/Gemini)
├── config.js                →  browser.storage.local wrapper
├── expansion-records.js     →  persist expand history for KB analysis (kept after analysis, only marked fed)
├── conversations.js         →  CRUD for chat conversations
└── kb.js                    →  Knowledge Base analyzer (builds personalization prompt + keywords)
```

- **Background script is an ESM module** (`"type": "module"` in manifest). Uses `import`, not `importScripts`.
- **Content script injected into all frames** (`all_frames: true`) with a guard (`window.__deltaExpandInjected`) to prevent double injection.
- **Uses `browser.*` API**, not `chrome.*`. This is Firefox-only (see `browser_specific_settings.gecko` in manifest).
- **Context menus are re-registered on every background script startup**, not just `onInstalled`.
- **No Chrome compatibility** — uses `browser.*`, gecko-specific manifest key, and `browser.tabs.sendMessage` with `frameId` option.
- **`ref_src/`** is in `.gitignore`. It contains TypeScript reference files ported from another project. The source of truth is the JS files.
- **Dashboard is the options_ui** — opens as a full tab (`open_in_tab: true`). Contains three tabs: Chat, Knowledge Base, Settings.

## Per-page bubble persistence
- Every bubble (and its sub-bubbles) is persisted under `(url, frameId)` in `'deltaPageBubbles'` so it reappears when the user revisits the page.
- Anchors are hybrid: a serialized XPath for stable pages, with a text-search fallback if the XPath no longer resolves.
- Rehydrate runs at content-script init, after `pageshow`, and on `pushState`/`replaceState`/`popstate` (SPA route changes).
- Dismissed bubbles are removed from storage immediately. Records expire after 30 days of inactivity.
- Persist calls are fire-and-forget and suppressed during rehydrate to avoid writing what we just read.

## Provider flow
- Gemini uses its own SSE endpoint (`streamGenerateContent`). Google AI Studio with `webSearchEnabled=false` falls back to OpenAI-compatible endpoint.
- All other providers (OpenAI, OpenRouter, Ollama, OpenAI Compatible) use `/v1/chat/completions` with SSE streaming.
- Ollama is mapped to OpenAI-compatible at `{host}/v1`.
- Web search is enabled by passing `tools: [{ type: 'web_search' }]` for OpenAI-compatible and `tools: [{ googleSearch: {} }]` for Gemini.
- Config persisted in `browser.storage.local` under key `deltaConfig`. `loadConfig` merges stored config onto `createDefaultConfig()`.

## Knowledge Base
- KB analyzes expansion records to build a personalization prompt that is injected into every LLM call.
- KB analysis can use a separate LLM provider (`kbProviderType` / `kbApiKey` / etc.) if configured.
- Analysis is non-streaming — iterates the full generator via `callProviderNonStream()`.
- Storage: `'deltaKbData'` in `browser.storage.local` — shape `{ prompt: string, keywords: [] }`.
- The prompt is loaded in both `streamExpand()` and `streamChat()` and appended to the system message.
- **Expansion records are kept in storage after KB analysis** — only the `kbFed` flag is set. Records are only removed by the explicit KB "Clear" button, or when the 200-record cap evicts the oldest. (This differs from the ref_src's `markConversationKbFed` which deletes `source: 'lookup'` conversations after analysis.)

## Chat
- Chat lives entirely in the dashboard — no content script involvement.
- Conversations are stored under `'deltaConversations'` in `browser.storage.local`, capped at 100.
- Transfer-to-Chat (`transferExpansion`) creates a `source: 'expansion'` conversation from a bubble's selection + response, then opens the dashboard to it.
- Streaming uses `chatStreamChunk` messages (background → dashboard).

## No tooling
- **No package.json, no npm, no Node.js.**
- **No tests, no lint, no typecheck.** Do not invent or run these commands.
- `.vscode/` config is user-level (includes C++ settings) — ignore it.

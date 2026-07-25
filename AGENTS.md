# AGENTS.md

## Overview
Firefox MV3 extension. No build step, no dependencies. Files are loaded directly by Firefox.

## Loading the extension
1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…**
3. Select `manifest.json`

## Architecture

```
background.js (module)       →  message router + LLM streamer
content.js                   →  injected into all frames, renders popup UI
src/shared/                  →  prompts, expand-prompt builder, model registry
src/background/              →  provider streamer (SSE/Gemini), config (browser.storage)
popup/                       →  extension toolbar settings page
```

- **Background script is an ESM module** (`"type": "module"` in manifest). Uses `import`, not `importScripts`.
- **Content script injected into all frames** (`all_frames: true`) with a guard (`window.__deltaExpandInjected`) to prevent double injection.
- **Uses `browser.*` API**, not `chrome.*`. This is Firefox-only (see `browser_specific_settings.gecko` in manifest).
- **Context menus are re-registered on every background script startup**, not just `onInstalled`.
- **No Chrome compatibility** — uses `browser.*`, gecko-specific manifest key, and `browser.tabs.sendMessage` with `frameId` option.
- **`ref_src/`** is in `.gitignore`. It contains TypeScript reference files ported from another project. The source of truth is the JS files.

## Provider flow
- Gemini uses its own SSE endpoint (`streamGenerateContent`). Google AI Studio with `webSearchEnabled=false` falls back to OpenAI-compatible endpoint.
- All other providers (OpenAI, OpenRouter, Ollama, OpenAI Compatible) use `/v1/chat/completions` with SSE streaming.
- Ollama is mapped to OpenAI-compatible at `{host}/v1`.
- Web search is enabled by passing `tools: [{ type: 'web_search' }]` for OpenAI-compatible and `tools: [{ googleSearch: {} }]` for Gemini.
- Config persisted in `browser.storage.local` under key `deltaConfig`. `loadConfig` merges stored config onto `createDefaultConfig()`.

## No tooling
- **No package.json, no npm, no Node.js.**
- **No tests, no lint, no typecheck.** Do not invent or run these commands.
- `.vscode/` config is user-level (includes C++ settings) — ignore it.

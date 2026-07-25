# Delta AI Expand — Architecture

## Overview

Delta AI Expand is a **Firefox Manifest V3 extension** that lets users right-click any text on any page and get an inline definition or explanation streamed from a configurable LLM provider. There is no build step, no npm dependencies, and no Node.js tooling — Firefox loads the JS files directly.

The extension consists of two main scripts — a persistent **background module** (ESM) that acts as a message router and LLM streamer, and a **content script** injected into all frames that handles selection tracking, popup UI rendering, and prompt input. Communication between them uses the `browser.runtime.sendMessage` / `browser.tabs.sendMessage` API with a small set of typed messages.

## Directory structure

```
manifest.json                  # Firefox MV3 manifest (ESM background, all_frames content)
background.js                  # Background module — message router + LLM streaming orchestrator
content.js                     # Content script — selection tracking, popup UI, prompt input
content.css                    # Dark-themed CSS custom properties and overlay styles

dashboard/
├── dashboard.html             # Full-page settings ("options_ui", opens in a tab)
├── dashboard.js               # Provider/shortcut configuration (ESM module)
└── dashboard.css

popup/
├── popup.html                 # Toolbar button status popup
├── popup.js                   # Config readout and shortcut display (ESM module)
└── popup.css

src/
├── background/
│   ├── config.js              # browser.storage.local wrapper (load/save/resolve)
│   └── provider.js            # Streaming LLM client — SSE, Gemini, multi-provider dispatch
└── shared/
    ├── models.js              # Provider registry + createDefaultConfig()
    ├── prompts.js             # System prompts + expand instruction templates
    └── expand-prompt.js       # Builds OpenAI-format message arrays for expand requests

icons/
└── icon.svg

ref_src/                       # .gitignored — original TypeScript reference files from the desktop app
    ├── shared/
    │   ├── conversation.ts    # Turn/segment types, tokenizer, nested expansion insertion
    │   ├── expand-prompt.ts   # Original TS expand message builder
    │   ├── models.ts          # Original provider/role registry (schema v2)
    │   └── prompts.ts         # Original system prompts + constraints
    └── main/
        ├── config.ts          # Original Electron config (file IO, IPC, kb persistence)
        ├── provider.ts        # Original TS provider streaming (with non-streaming fallback)
        └── models/registries.ts
```

## Manifest

`manifest.json:1-47` — Key decisions:

| Field | Value | Rationale |
|---|---|---|
| `manifest_version` | `3` | Firefox MV3 extension |
| `browser_specific_settings.gecko.id` | `delta-ai-expand@example.com` | Firefox add-on identifier |
| `browser_specific_settings.gecko.strict_min_version` | `115.0` | Minimum Firefox version |
| `permissions` | `storage`, `contextMenus`, `clipboardWrite`, `tabs` | Storage for config, context menu registration, clipboard, tab access |
| `host_permissions` | `<all_urls>` | Content script must inject everywhere |
| `background.type` | `module` | Enables ES module `import`/`export` in the background script |
| `content_scripts.all_frames` | `true` | Context menu must work in iframes |
| `content_scripts.run_at` | `document_idle` | Ensure DOM is ready before injection |
| `commands.expand` | `Ctrl+E` (default) | Keyboard shortcut for the expand action |
| `action.default_popup` | `popup/popup.html` | Toolbar button shows status popup |
| `options_ui.open_in_tab` | `true` | Settings page opens as a full tab |

**Firefox-only**: Uses `browser.*` API (not `chrome.*`), the gecko-specific manifest key, and `browser.tabs.sendMessage` with the `frameId` option. No Chrome compatibility is maintained.

## Architecture layers

### Layer 1: Background script (`background.js`)

The background script is a persistent **ES module** (`"type": "module"` in the manifest) that runs for the lifetime of the browser. It has four concerns:

1. **Stream orchestration** — `streamExpand()` (`background.js:22-73`) loads config, builds prompt messages, calls `callProviderStream()`, iterates the async generator, and pushes each accumulated chunk to the content script via `browser.tabs.sendMessage`. Each inflight stream is tracked in an `activeStreams` Map keyed by `requestId`, backed by `AbortController` for cancellation.

2. **Context menu registration** — `registerContextMenus()` (`background.js:77-87`) runs on every background script startup (not just `onInstalled`). It calls `browser.contextMenus.removeAll()` first, then creates a single menu item with id `delta-expand`, title `Expand…`, appearing for `contexts: ['selection']`.

3. **Entry points** — Two triggers initiate the expand flow:
   - **Context menu click** (`background.js:94-105`): Sends `expandPromptedFromMenu` to the origin frame with a `frameId`.
   - **Keyboard shortcut** (`background.js:109-120`): `commands.onCommand` sends the same message to the active tab's top-level frame (no `frameId`).

4. **Message routing** (`background.js:124-156`) — Dispatches 5 message types (`expandRequest`, `loadConfig`, `saveConfig`, `abort`, `openSettings`). See Message protocol below.

### Layer 2: Content script (`content.js`)

Injected into **all frames** (`all_frames: true`), guarded by `window.__deltaExpandInjected` to prevent double injection. The content script is the sole UI layer — it manages position, visibility, and lifecycle of all popups and prompt inputs.

**State** (`content.js:9-20`):
- `popups` — `Map<requestId, { el }>` of active popups (supports multiple coexisting).
- `promptInputEl` — single reference to the floating "Expand on…" input.
- `lastClickX`, `lastClickY` — captured on `contextmenu` event, used for positioning.
- `lastExpandData` — `{ selection, context, rect }` from the most recent selection.
- `popupCounter` — increments for each new popup; used for z-index stacking.

**Selection tracking** (`content.js:28-96`):
- `getSurroundingText(node, maxLen)` walks from the selection anchor node to the nearest block-level ancestor (`P`, `DIV`, `SECTION`, etc.), extracts its text, and returns up to `maxLen` characters centered on the selection.
- `captureExpandData()` reads `window.getSelection()` and returns `{ selection, context, rect }`.
- Event listeners on `contextmenu` (capture phase) and `mouseup` (with `setTimeout(0)`) passively track the last selected text — no `preventDefault` is called, so the native context menu still appears.

**Popup lifecycle** (`content.js:100-207`):
- `createPopup(rect, requestId)` — constructs a fixed-position DOM tree: header ("Expand" + close button), body ("Thinking…"), positioned near the selection. Uses off-screen measuring for height-based overflow, constrains to viewport, and applies stacking offset (20px per popup).
- `updatePopup(requestId, text, done, error)` — updates the body `textContent`. Sets `.delta-error` class on error.
- `dismissPopup(requestId)` — removes the DOM element, sends `abort` to the background, deletes from the Map.
- `dismissTopPopup()` — finds the popup with the highest z-index and dismisses it (Esc key).
- Z-index formula: `2147483646 + popupCounter` ensures new popups render above older ones while staying within the safe integer range.

**Prompt input** (`content.js:211-265`):
- `showPromptInput(requestId, data)` creates a floating `<input>` near the selection. On Enter, generates a fresh `crypto.randomUUID()` as the `requestId`, creates a popup, and sends `expandRequest` to the background. On Esc or outside click, dismisses the prompt.

**Cleanup** (`content.js:294-299`): On `window.unload`, sends `abort` for every active popup.

### Layer 3: Shared modules (`src/shared/`)

Three modules imported by both the background and UI scripts:

**`models.js:1-53`** — `providerRegistry` and `createDefaultConfig()`:
- `providerRegistry` — maps provider type keys (`google-ai-studio`, `openai-compatible`, `openai`, `ollama`, `openrouter`) to descriptor objects containing `label`, `authShape` (`apiKey` or `host`), `defaultBaseUrl`, `capabilities.webSearch`, `knownModels` array.
- `createDefaultConfig()` — returns `{ providerType: 'openai-compatible', apiKey: '', baseUrl: '', host: '', model: '', webSearchEnabled: false, contextChars: 1500 }`.

**`prompts.js:1-42`** — System prompts and expand instructions:
- `LOOKUP_SYSTEM_PROMPT` — instructs the LLM to use web search when context is insufficient, acknowledges OCR errors but asks not to mention them, answers simply and concisely.
- `CHAT_SYSTEM_PROMPT` — simpler prompt for the chat window.
- `getSystemPrompt(role)` — returns the appropriate system prompt.
- `buildExpandUserInstruction(selection)` — builds the default "define" user instruction with constraints (no intro phrases, no word repetition, bare noun phrase output, provides good/bad examples).
- `buildExpandPromptedInstruction(selection, prompt)` — builds a custom "Expand on…" instruction: `The user wants to know "{verb}" about "{selection}"...`.

**`expand-prompt.js:1-16`** — `buildExpandMessages(input)`:
- Pushes a simulated *assistant* message containing the surrounding context text (or `'(empty answer)'` fallback).
- Pushes a *user* message with the appropriate instruction (custom or default).
- Returns the two-message array for appending to the system prompt.

The pattern is deliberate: the LLM receives the context as if it already "read" it (assistant role), followed by the user's question about the selection.

### Layer 4: Background services (`src/background/`)

**`config.js:1-27`** — `browser.storage.local` wrapper:
- `STORAGE_KEY` = `'deltaConfig'` — all config is stored under this single key.
- `loadConfig()` — reads from storage, spreads defaults first then overlays stored values (so new default fields are never missing).
- `saveConfig(config)` — merges incoming config onto defaults and writes to storage.
- `resolveProvider()` — convenience wrapper (returns the config object).

**`provider.js:1-175`** — Streaming LLM client:
- `fetchWithTimeout(url, options)` — wraps `fetch()` with an `AbortController` that fires after 30s. On abort, throws a human-readable timeout error.
- `sseStream(res, extract)` — async generator that processes SSE from a `ReadableStream`. Accumulates chunks into a buffer, splits on `\n`, strips the `data: ` prefix, handles `[DONE]`, parses JSON, and yields extracted chunks.
- `callOpenAICompatibleStream(apiKey, model, messages, baseUrl, webSearchEnabled)` — POSTs to `{baseUrl}/chat/completions` with `{ model, messages, stream: true }`. Adds `tools: [{ type: 'web_search' }]` when `webSearchEnabled` is true. Sets `Authorization: Bearer {apiKey}` if an API key is provided.
- `callGeminiWithSearchStream(apiKey, model, messages)` — POSTs to `models/{model}:streamGenerateContent`. Converts message roles: first `system` → `system_instruction`, subsequent `system` → `user`, `assistant` → `model`. Always adds `tools: [{ googleSearch: {} }]`.
- `callProviderStream(messages, config)` — the main dispatch function. Routes based on `config.providerType`.

### Layer 5: UI pages

**Toolbar popup** (`popup/popup.html`, `popup/popup.js`, `popup/popup.css`):
- Reads config from `browser.storage.local` directly and displays Provider, Model, and Shortcut.
- Applies a `.missing` CSS class (red text) when the model or shortcut is unset.
- "Settings" button sends `openSettings` message to the background, which opens `dashboard/dashboard.html` in a new tab.

**Dashboard** (`dashboard/dashboard.html`, `dashboard/dashboard.js`, `dashboard/dashboard.css`):
- Full-page settings form with provider selection, API key (password field), conditional fields (Base URL for OpenAI Compatible/OpenRouter, Host for Ollama), model input with datalist suggestions, web search toggle.
- `updateFieldVisibility(providerType)` hides/shows fields based on the selected provider's `authShape` and `capabilities.webSearch`.
- `updateSuggestions(providerType)` repopulates the model datalist from `knownModels`.
- Shortcut configuration: captures keyboard input via `keydown`, formats into Firefox-compatible shortcut strings (`Ctrl+E`, `Command+K` on Mac), calls `browser.commands.update()`. Reset button calls `browser.commands.reset()`. Mac modifier mapping: `metaKey` → `Command`, `ctrlKey` → `MacCtrl`.

## Message protocol

### Background → Content script

Messages are sent via `browser.tabs.sendMessage(tabId, message, { frameId })`:

| Type | Fields | Purpose |
|---|---|---|
| `expandPromptedFromMenu` | `requestId` (string) | Triggered by context menu or keyboard shortcut. Content script shows the "Expand on…" prompt input. |
| `expandChunk` | `requestId` (string), `text` (string), `done` (boolean) | Streams the **accumulated** LLM response. `done: true` on final chunk. On error: includes `error` (string) with `done: true`. |

### Content script → Background

Messages are sent via `browser.runtime.sendMessage(message)`:

| Type | Fields | Purpose |
|---|---|---|
| `expandRequest` | `requestId` (string), `selection` (string), `context` (string), `prompt` (string \| undefined) | User submitted the prompt. Background starts LLM streaming. |
| `abort` | `requestId` (string) | Popup dismissed. Background calls `AbortController.abort()` and cleans up. |
| `loadConfig` | *(none)* | Returns a Promise resolving to the config object. |
| `saveConfig` | `config` (object) | Persists config to storage. Returns a Promise resolving to `true`. |
| `openSettings` | *(none)* | Opens `dashboard/dashboard.html` in a new tab. |

### End-to-end message flow

```
User selects text → right-click → "Expand…" in context menu
    │
    ▼
background.js: contextMenus.onClicked
    │ sends { type: 'expandPromptedFromMenu', requestId }
    ▼
content.js: onMessage → showPromptInput()
    │ User types optional prompt, presses Enter
    │ creates popup, sends { type: 'expandRequest', requestId, selection, context, prompt }
    ▼
background.js: onMessage → streamExpand()
    │ loadConfig() → buildExpandMessages() → callProviderStream()
    │ for each chunk: sends { type: 'expandChunk', requestId, text: fullResponse, done: false }
    ▼
content.js: onMessage → updatePopup()
    │ On final chunk (done: true) → popup shows complete text
    │ User clicks close / presses Esc → dismissPopup()
    │ sends { type: 'abort', requestId }
    ▼
background.js: onMessage → abortStream()
    │ AbortController.abort() → activeStreams.delete(requestId)
```

### Key protocol details

- **`requestId` is generated twice**: First by `genRequestId()` in the background (`rx_{timestamp}_{counter}`) for the menu trigger. Then replaced by `crypto.randomUUID()` in the content script when the user submits the prompt. The stream uses the latter.
- **Full accumulated text is sent each chunk**, not incremental deltas. This is simpler and handles dropped chunks gracefully at the cost of bandwidth.
- **`frameId` is explicit** in `sendMessage` from background → content. The keyboard shortcut path does not use `frameId` (targets the active tab's top-level frame).
- **Fire-and-forget streaming**: The background pushes chunks without waiting for acknowledgment. Every `sendMessage` call is wrapped in try/catch because the content script's frame may have been navigated away or destroyed.

## Provider streaming architecture

```
callProviderStream(messages, config)
    │
    ├── providerType === 'google-ai-studio'
    │   ├── webSearchEnabled === true
    │   │   └── callGeminiWithSearchStream()
    │   │       └── SSE → extract: candidates[0].content.parts[0].text
    │   └── webSearchEnabled === false
    │       └── callOpenAICompatibleStream()  (fallback to Google's OpenAI-compatible endpoint)
    │
    ├── providerType === 'openai-compatible'
    │   └── callOpenAICompatibleStream(apiKey, model, messages, baseUrl, webSearchEnabled)
    │
    ├── providerType === 'openai'
    │   └── callOpenAICompatibleStream(apiKey, model, messages, 'https://api.openai.com/v1', webSearchEnabled)
    │
    ├── providerType === 'openrouter'
    │   └── callOpenAICompatibleStream(apiKey, model, messages, 'https://openrouter.ai/api/v1', webSearchEnabled)
    │
    └── providerType === 'ollama'
        └── callOpenAICompatibleStream('', model, messages, '{host}/v1', false)
```

### Web search tool configuration

| Provider | Web search capability | Tool format |
|---|---|---|
| OpenAI | Yes | `tools: [{ type: 'web_search' }]` |
| OpenAI Compatible | Yes | `tools: [{ type: 'web_search' }]` |
| OpenRouter | Yes | `tools: [{ type: 'web_search' }]` |
| Google AI Studio | Yes | `tools: [{ googleSearch: {} }]` (native Gemini endpoint) |
| Ollama | **No** | N/A (web search toggle hidden in dashboard) |

**Google AI Studio special case**: When `webSearchEnabled` is `false`, the Gemini native endpoint is not used. Instead, the code falls back to `callOpenAICompatibleStream()` pointed at Google's OpenAI-compatible endpoint (`https://generativelanguage.googleapis.com/v1beta/chat/completions`) **without** the web search tool. When `webSearchEnabled` is `true`, it uses the native Gemini SSE endpoint with `tools: [{ googleSearch: {} }]`.

### SSE streaming implementation

`sseStream(res, extract)` (`provider.js:27-56`):
1. Gets the `ReadableStream` reader from the response body.
2. Accumulates decoded chunks into a buffer.
3. Splits on `\n` to get individual lines.
4. For each line starting with `data: `, strips the prefix.
5. If data is `[DONE]`, returns (OpenAI SSE termination).
6. Otherwise, parses as JSON and calls the `extract` callback.
7. Malformed JSON lines are silently skipped.

**Extractors**:
- OpenAI-compatible: `parsed.choices?.[0]?.delta?.content`
- Gemini: `parsed.candidates?.[0]?.content?.parts?.[0]?.text`

### Gemini message role conversion

Gemini uses a different message format than OpenAI. `callGeminiWithSearchStream()` (`provider.js:85-125`) converts:
- The **first** `system` message → `system_instruction.parts[{ text }]` at the root of the body.
- **Subsequent** `system` messages → `{ role: 'user', parts: [{ text }] }` (since Gemini only allows one `system_instruction`).
- `assistant` → `{ role: 'model', parts: [{ text }] }`.
- All other roles → `{ role: 'user', parts: [{ text }] }`.

### Fetch timeout

`fetchWithTimeout()` (`provider.js:10-25`) wraps `fetch()` with a 30-second `AbortController`. On timeout, throws `Request timed out after 30s. Check your API endpoint and network connection.`

## Config persistence

All configuration is stored in `browser.storage.local` under a single key: `'deltaConfig'`.

### Default config shape

```js
{
  providerType: 'openai-compatible',   // key in providerRegistry
  apiKey: '',                          // provider API key
  baseUrl: '',                         // custom endpoint (openai-compatible / openrouter)
  host: '',                            // Ollama host
  model: '',                           // model name
  webSearchEnabled: false,             // web search toggle
  contextChars: 1500                   // (reserved, not currently used by content script)
}
```

### Merging strategy

All `loadConfig()` calls use the pattern: `{ ...createDefaultConfig(), ...stored }` — defaults first, stored values on top. This guarantees that any new fields added to the default config in future versions are present even if the stored config is from an older version.

### Access patterns

- **Background**: Uses `loadConfig()` / `saveConfig()` from `src/background/config.js`.
- **Toolbar popup**: Reads `browser.storage.local` directly with its own inline defaults.
- **Dashboard**: Reads/writes `browser.storage.local` directly with its own `createDefaultConfig()`. The dashboard is a standalone page and does not use the background's config module.

## Context menu management

- Registered on **every background script startup** (`background.js:87`), not just `onInstalled`. This is because Firefox may reload the background script between debugging sessions or updates.
- `browser.contextMenus.removeAll()` is called first to clear stale menus, then a single item (`delta-expand`) is created.
- The item appears only when text is selected (`contexts: ['selection']`).
- On click, the background sends `expandPromptedFromMenu` to the **specific frame** where the click occurred, using `info.frameId`.

## UI theming

`content.css:1-111` defines a dark theme using CSS custom properties scoped to `.delta-popup` and `#delta-expandPrompt`:

| Variable | Value | Usage |
|---|---|---|
| `--delta-bg` | `#20212a` | Page background |
| `--delta-surface-2` | `#2c2d36` | Popup background |
| `--delta-accent` | `#8aa0b8` | Popup border color |
| `--delta-text-1` | `rgba(238,238,245,0.92)` | Primary text |
| `--delta-text-3` | `rgba(228,230,240,0.4)` | Header muted text |
| `--delta-error` | `#cf7b6e` | Error text color |
| `--delta-shadow-2` | `0 6px 22px rgba(0,0,0,0.22)` | Popup shadow |

Popups use a subtle fade-in animation (`delta-fade-in`), `pre-wrap` whitespace for streaming text, and `break-word` to prevent overflow. The prompt input inherits the same dark theme and has a transparent background with muted placeholder text.

## ref_src/ — Reference TypeScript files

The `ref_src/` directory is **gitignored** and contains the original TypeScript source files from a desktop Electron application that the extension was ported from. Key differences from the extension:

- **Desktop model config** (`ref_src/shared/models.ts`) uses a much richer schema (`ModelConfig` v2) with multiple `Connection` objects, role-based model assignments (`chat`, `lookup`, `kb-maintenance`), and `RoleAssignment` per role.
- **Desktop provider** (`ref_src/main/provider.ts`) has both streaming and non-streaming methods, plus `callGeminiWithSearch` (non-streaming).
- **Desktop config** (`ref_src/main/config.ts`) uses Electron `app`, `ipcMain`, `globalShortcut`, file I/O (JSON files), and Wayland detection.
- **`conversation.ts`** (414 lines) has extensive data structures for nested expandable segments, tokenization, recursive expansion insertion, and markdown flattening — all of which were stripped from the extension.

The extension simplified all of this to: a single config object (not connections + roles), streaming-only, `browser.storage.local` persistence, and no nested expansions.

## Design decisions

1. **No build step, no dependencies** — Files are loaded directly by Firefox. No `package.json`, npm, webpack, or bundler. This keeps the extension lightweight and easy to load for development.

2. **Background script as ESM module** — Uses `import`/`export` for clean dependency management between the background script and its submodules. The `"type": "module"` manifest field enables this.

3. **`all_frames: true` with injection guard** — The content script must run in all frames to support right-click expand in iframes. The `window.__deltaExpandInjected` guard prevents double injection. Each frame's content script is independent and manages its own popups.

4. **Full accumulated text in streaming** — Each `expandChunk` message sends the complete response so far, not just the delta. This is simpler, tolerates dropped messages, and avoids issues with chunk ordering. The tradeoff is higher message size.

5. **Two requestId generations** — The initial `requestId` from the background's context menu handler is replaced by `crypto.randomUUID()` in the content script when the user submits. This ensures the streaming requestId is truly unique and not tied to the menu trigger lifecycle.

6. **Defensive sendMessage** — Every `browser.tabs.sendMessage` call in the background is wrapped in try/catch because the target frame may have been navigated away, destroyed, or the content script may have been reloaded.

7. **Context menu re-registration on every start** — Not just on `onInstalled`, because Firefox may reload the background script independently of extension installation events.

8. **Firefox-only** — No Chrome compatibility. Uses `browser.*` API, the `browser_specific_settings.gecko` manifest key, and Firefox-specific features like `frameId` in `sendMessage`. This eliminates polyfills and compatibility abstractions.

9. **Zero-external-dependency UI** — Popups are built entirely from DOM APIs (no React, no libraries). CSS custom properties provide theming. This avoids any dependency on page CSS or JavaScript.

10. **Passive selection tracking** — The content script listens on `contextmenu` (capture phase) and `mouseup` events without calling `preventDefault()`, so the native browser context menu still appears alongside the extension's custom menu item. The extension's "Expand…" menu item is added by the background script via `browser.contextMenus`.

# Delta AI Expand — Architecture

## Overview

Delta AI Expand is a **Firefox Manifest V3 extension** that lets users right-click any text on any page and get an inline definition or explanation streamed from a configurable LLM provider. There is no build step, no npm dependencies, and no Node.js tooling — Firefox loads the JS files directly.

The extension consists of two main scripts — a persistent **background module** (ESM) that acts as a message router and LLM streamer, and a **content script** injected into all frames that handles selection tracking, inline bubble UI rendering, fold/re-expand, and theme detection. Communication between them uses the `browser.runtime.sendMessage` / `browser.tabs.sendMessage` API with a small set of typed messages.

## Directory structure

```
manifest.json                  # Firefox MV3 manifest (ESM background, all_frames content)
background.js                  # Background module — message router + LLM streaming orchestrator
content.js                     # Content script — selection tracking, inline bubble UI, fold/re-expand, theme detection
content.css                    # CSS custom properties and inline bubble styles (light + dark themes)

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
│   ├── provider.js            # Streaming LLM client — SSE, Gemini, multi-provider dispatch
│   └── expansion-records.js   # Persistence for unfed expansion records
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

1. **Stream orchestration** — `streamExpand()` loads config, builds prompt messages, calls `callProviderStream()`, iterates the async generator, and pushes each accumulated chunk to the content script via `browser.tabs.sendMessage`. Each inflight stream is tracked in an `activeStreams` Map keyed by `requestId`, backed by `AbortController` for cancellation.

2. **Context menu registration** — `registerContextMenus()` runs on every background script startup (not just `onInstalled`). It calls `browser.contextMenus.removeAll()` first, then creates a single menu item with id `delta-expand`, title `Expand…`, appearing for `contexts: ['selection']`.

3. **Entry points** — Two triggers initiate the expand flow:
   - **Context menu click**: Sends `expandPromptedFromMenu` to the origin frame with a `frameId`.
   - **Keyboard shortcut**: `commands.onCommand` sends the same message to the active tab's top-level frame (no `frameId`).

4. **Message routing** — Dispatches 6 message types (`expandRequest`, `loadConfig`, `saveConfig`, `abort`, `openSettings`, `transferExpansion`). See Message protocol below.

### Layer 2: Content script (`content.js`)

Injected into **all frames** (`all_frames: true`), guarded by `window.__deltaExpandInjected` to prevent double injection. The content script manages the **inline bubble UI** — expansions are rendered as `inline-block` elements embedded directly in the page's DOM, replacing the selected text.

**State**:
- `bubbleEntries` — `Map<requestId, { el, marker, data }>` — active expanded bubbles.
- `foldedEntries` — `Map<requestId, { marker, data }>` — folded (collapsed) bubbles.
- `lastSubParentEntry` — reference to the parent entry for sub-expansion routing.
- `lastClickX`, `lastClickY` — captured on `contextmenu` event for positioning.
- `lastExpandData` — `{ selection, context, rect }` from the most recent selection.

**Selection tracking** — `getSurroundingText(node, maxLen)` walks from the selection anchor node to the nearest block-level ancestor, extracts text, returns up to `maxLen` characters centered on the selection. Events on `contextmenu` (capture phase) and `mouseup` passively track selections.

**Inline bubble creation** (`createBubble`):
- Creates a `.delta-bubble` div with header (title + close/transfer buttons) and body (`.delta-bubble-body`).
- Replaces the selected text node (or marker) with the bubble as a child of the page DOM.
- Bubbles are `inline-block`, `width: fit-content`, `max-width: min(420px, 100%)`.
- Sub-bubbles are nested inside the parent's `.delta-bubble-body` and `display: block` with `width: fit-content`.

**Fold/re-expand**:
- **Fold** (right-click on bubble header): Detaches the cached bubble `el`, inserts a `.delta-bubble-marker` span with the original selection text, colored to indicate the bubble type.
- **Re-expand** (left-click or right-click on marker): Swaps the marker back for the cached `el` — no AI call, no DOM recreation. Sub-bubble markers are preserved inside the parent's cached `el`.

**Punctuation suppression** — Punctuation-only text nodes adjacent to a bubble are wrapped in `.delta-adj-hidden` (`display: none`) so the bubble sits flush with surrounding text.

**Theme detection**:
- `detectPageTheme()` walks up the DOM from `document.body` to find the first non-transparent background color, computes Rec.709 luminance. Falls back to `prefers-color-scheme`.
- Applied via `:root.delta-theme-light` class on `<html>`.
- Re-applied on `pageshow` and `visibilitychange → visible`.

**Font size**: `font-size: calc(1em - 1px)` — the bubble text is 1px smaller than the surrounding page text. Sub-bubbles inherit the parent bubble's size, compounding the subtraction.

**Prompt input**: `showPromptInput()` creates a floating input near the selection. On Enter, generates a `crypto.randomUUID()` as the `requestId`, creates a bubble, and sends `expandRequest` to the background. On Esc or outside click, dismisses the prompt.

**Cleanup**: On `window.unload`, sends `abort` for every active stream.

### Layer 3: Shared modules (`src/shared/`)

**`models.js`** — `providerRegistry` and `createDefaultConfig()`. Maps provider type keys to descriptor objects with `label`, `authShape`, `defaultBaseUrl`, `capabilities.webSearch`, `knownModels`.

**`prompts.js`** — System prompts (`LOOKUP_SYSTEM_PROMPT`, `CHAT_SYSTEM_PROMPT`) and expand instruction builders (`buildExpandUserInstruction`, `buildExpandPromptedInstruction`).

**`expand-prompt.js`** — `buildExpandMessages(input)` builds a two-message array: simulated assistant message with surrounding context, followed by the user's question about the selection.

### Layer 4: Background services (`src/background/`)

**`config.js:1-27`** — `browser.storage.local` wrapper. Stores config under `'deltaConfig'`. `loadConfig()` merges stored config onto `createDefaultConfig()` defaults.

**`provider.js`** — Streaming LLM client. Routes based on `config.providerType`:
- OpenAI-compatible: POST to `{baseUrl}/chat/completions` with SSE streaming.
- Gemini: `streamGenerateContent` endpoint with `tools: [{ googleSearch: {} }]` when web search enabled.
- Gemini with `webSearchEnabled=false`: falls back to Google's OpenAI-compatible endpoint.

**`expansion-records.js`** — Persistence for unfed expansion records. Stores selection data so expansions can be retried or re-expanded across page loads.

### Layer 5: UI pages

**Toolbar popup** (`popup/`) — Shows Provider, Model, and Shortcut from config. "Settings" button opens dashboard.

**Dashboard** (`dashboard/`) — Full settings form with provider selection, API key, model, web search toggle, shortcut configuration.

## Message protocol

### Background → Content script

| Type | Fields | Purpose |
|---|---|---|
| `expandPromptedFromMenu` | `requestId` (string) | Triggered by context menu or keyboard shortcut. Content script shows the prompt input. |
| `expandChunk` | `requestId` (string), `text` (string), `done` (boolean) | Streams the accumulated LLM response. `done: true` on final chunk. On error: includes `error` with `done: true`. |

### Content script → Background

| Type | Fields | Purpose |
|---|---|---|
| `expandRequest` | `requestId`, `selection`, `context`, `prompt` (optional) | User submitted the prompt. Background starts LLM streaming. |
| `transferExpansion` | `requestId`, `selection`, `context`, `parentRequestId` | User initiated a sub-expansion from within a bubble. Background streams into the parent bubble's context. |
| `abort` | `requestId` | Bubble dismissed. Background calls `AbortController.abort()` and cleans up. |
| `loadConfig` | *(none)* | Returns a Promise resolving to the config object. |
| `saveConfig` | `config` (object) | Persists config to storage. |
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
    │ creates inline bubble, sends { type: 'expandRequest', requestId, selection, context, prompt }
    ▼
background.js: onMessage → streamExpand()
    │ loadConfig() → buildExpandMessages() → callProviderStream()
    │ for each chunk: sends { type: 'expandChunk', requestId, text: fullResponse, done: false }
    ▼
content.js: onMessage → updateBubbleBody()
    │ On final chunk (done: true) → bubble shows complete text
    │ User can right-click bubble header → fold into marker
    │ User can left/right-click marker → re-expand
    │ User can select text inside bubble → right-click → sub-expand
    ▼
content.js: context menu on bubble text → captureSubExpand()
    │ sends { type: 'expandRequest', requestId, selection, context, prompt, parentRequestId }
    ▼
background.js: onMessage → streamExpand()
    │ streams into new sub-bubble inside parent bubble body
```

### Key protocol details

- **`requestId` is generated twice**: First by `genRequestId()` for the menu trigger. Then replaced by `crypto.randomUUID()` when the user submits. The stream uses the latter.
- **Full accumulated text is sent each chunk**, not incremental deltas.
- **`frameId` is explicit** in `sendMessage` from background → content.
- **Fire-and-forget streaming**: The background pushes chunks without waiting for acknowledgment. Every `sendMessage` is wrapped in try/catch.

## Inline bubble UI

### Bubble DOM structure

```
.delta-bubble (inline-block, font-size: calc(1em - 1px))
├── .delta-bubble-header
│   ├── .delta-bubble-title ("Expand" / "Chat")
│   └── .delta-bubble-actions
│       ├── .delta-bubble-transfer (SVG speech-bubble icon, root bubbles only)
│       └── .delta-bubble-close (×)
├── .delta-bubble-spinner (italic text, shown while streaming)
└── .delta-bubble-body (expanded content, white-space: pre-wrap)
    └── .delta-bubble (sub-bubble, nested)
        ├── .delta-bubble-header (same structure, no transfer button)
        └── .delta-bubble-body
```

### Fold/re-expand

- **Fold**: Right-click on `.delta-bubble-header` → detaches `el` from DOM, stores on `entry.el`. Inserts `.delta-bubble-marker` with the original selection text. Marker uses the bubble's accent color.
- **Re-expand**: Left-click or right-click on `.delta-bubble-marker` → reads `entry.el` from `foldedEntries`, replaces marker with `el`. No DOM recreation — the cached element includes any sub-bubbles and their state.

### Punctuation suppression

Adjacent punctuation-only text nodes (`. , ! ? ; :`) are detected and wrapped in `.delta-adj-hidden` (`display: none`) so the inline bubble doesn't have awkward spacing gaps. Restored when the bubble is folded.

### Theme detection

`applyPageTheme()` walks up from `document.body` to find the first non-transparent `background-color`, computes Rec.709 luminance: `luminance = 0.2126*R + 0.7152*G + 0.0722*B`. If luminance > 0.5, adds `class="delta-theme-light"` to `<html>`. Otherwise removes it. Falls back to `matchMedia('prefers-color-scheme: light')`. Applied on init, `pageshow`, and `visibilitychange → visible`.

### CSS variables

| Variable | Dark | Light | Usage |
|---|---|---|---|
| `--delta-surface-2` | `#2c2d36` | `#ffffff` | Bubble background |
| `--delta-surface-3` | `#353640` | `#f3f4f6` | Sub-bubble background |
| `--delta-border-strong` | `rgba(138,160,184,0.45)` | `rgba(107,114,128,0.35)` | Bubble border |
| `--delta-border` | `rgba(138,160,184,0.2)` | `rgba(107,114,128,0.15)` | Header bottom border |
| `--delta-text-1` | `rgba(238,238,245,0.92)` | `#1f2937` | Primary text |
| `--delta-text-2` | `rgba(228,230,240,0.55)` | `#6b7280` | Header title |
| `--delta-text-3` | `rgba(228,230,240,0.4)` | `#9ca3af` | Spinner text |
| `--delta-shadow-2` | `0 4px 14px rgba(0,0,0,0.25)` | `0 4px 14px rgba(0,0,0,0.1)` | Bubble shadow |
| `--delta-radius-sm` | `6px` | `6px` | Border radius |

## Config persistence

All configuration is stored in `browser.storage.local` under a single key: `'deltaConfig'`. `loadConfig()` uses `{ ...createDefaultConfig(), ...stored }` to merge defaults.

## Context menu management

- Registered on every background script startup, not just `onInstalled`.
- `browser.contextMenus.removeAll()` is called first, then a single item (`delta-expand`) is created.
- On click, sends `expandPromptedFromMenu` to the specific frame using `info.frameId`.
- The content script's `contextmenu` listener on bubble headers triggers sub-expansion capture (captures selection within bubble text, stores parent requestId).

## Design decisions

1. **No build step, no dependencies** — Files loaded directly by Firefox.

2. **Background script as ESM module** — Uses `import`/`export` for clean dependency management.

3. **Inline bubbles instead of floating popups** — Bubbles are `inline-block` elements embedded in the page DOM. This avoids z-index fighting, overflow clipping, and repositioning logic. Sub-bubbles nest naturally inside parent bubble bodies.

4. **EL-preserving fold/re-expand** — Folding caches the DOM element so re-expand is instant and preserves all sub-bubble state. No API calls on re-expand.

5. **Auto-detected light/dark theme** — Walks the DOM to detect page background luminance. No manual theme toggle needed.

6. **Full accumulated text in streaming** — Each `expandChunk` sends the complete response so far, not deltas.

7. **Two requestId generations** — Menu trigger ID replaced by `crypto.randomUUID()` on submit.

8. **Defensive sendMessage** — Every `browser.tabs.sendMessage` is wrapped in try/catch.

9. **Context menu re-registration on every start** — Not just `onInstalled`.

10. **Firefox-only** — No Chrome compatibility.

11. **Zero-external-dependency UI** — DOM APIs only. CSS custom properties for theming.

12. **Font size 1px smaller than page text** — `font-size: calc(1em - 1px)` ensures bubble text is subtly smaller than surrounding page text, visually distinguishing it. Sub-bubbles compound the subtraction (nested = smaller).

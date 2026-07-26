# Delta AI Expand — Architecture

## Overview

Delta AI Expand is a **Firefox Manifest V3 extension** that lets users right-click any text on any page and get an inline definition or explanation streamed from a configurable LLM provider. It also includes a full **Chat** panel (persistent threaded conversations) and a **Knowledge Base** that learns the user's interests over time by analyzing expansion history and injecting a personalization prompt into every LLM call. There is no build step, no npm dependencies, and no Node.js tooling — Firefox loads the JS files directly.

The extension consists of three main scripts — a persistent **background module** (ESM) that acts as a message router, LLM streamer, and KB analyzer; a **content script** injected into all frames that handles selection tracking, inline bubble UI rendering, fold/re-expand, and theme detection; and a **dashboard** that provides settings, a Chat panel, and a Knowledge Base management UI. Communication between them uses the `browser.runtime.sendMessage` / `browser.tabs.sendMessage` API with a set of typed messages.

## Directory structure

```
manifest.json                  # Firefox MV3 manifest (ESM background, all_frames content)
background.js                  # Background module — message router + LLM streaming orchestrator
content.js                     # Content script — selection tracking, inline bubble UI, fold/re-expand, theme detection
content.css                    # CSS custom properties and inline bubble styles (light + dark themes)

dashboard/
├── dashboard.html             # Full-page settings + Chat + KB ("options_ui", opens in a tab)
├── dashboard.js               # Provider/shortcut/KB config + Chat UI + KB management (ESM module)
└── dashboard.css

popup/
├── popup.html                 # Toolbar button status popup
├── popup.js                   # Config readout, shortcut display, KB status (ESM module)
└── popup.css

src/
├── background/
│   ├── config.js              # browser.storage.local wrapper (load/save/resolve)
│   ├── provider.js            # Streaming LLM client — SSE, Gemini, multi-provider dispatch
│   ├── expansion-records.js   # Persistence for expansion records (fed to KB)
│   ├── conversations.js       # CRUD for chat conversation storage
│   └── kb.js                  # Knowledge Base — analyzes expansions, builds prompt + keywords
└── shared/
    ├── models.js              # Provider registry + createDefaultConfig() + KB config defaults
    ├── prompts.js             # System prompts + expand/KB analysis instruction templates
    ├── expand-prompt.js       # Builds OpenAI-format message arrays for expand requests
    └── bubble-store.js        # Per-page bubble persistence (load/upsert/remove)

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

4. **Stream chat** — `streamChat()` uses the chat system prompt (`CHAT_SYSTEM_PROMPT`), injected with any KB prompt, and streams responses via `chatStreamChunk` messages (sent to the dashboard, not the content script).

5. **Message routing** — Dispatches 20+ message types covering expand, chat, KB, config, and settings. See Message protocol below.

### Layer 2: Content script (`content.js`)

Injected into **all frames** (`all_frames: true`), guarded by `window.__deltaExpandInjected` to prevent double injection. The content script manages the **inline bubble UI** — expansions are rendered as `inline-block` elements embedded directly in the page's DOM, replacing the selected text.

**State**:
- `bubbles` — `Map<bubbleId, { id, el, marker, range, data, responseText, children, parent, folded }>` — all bubble entries (expanded or folded).
- `pendingChunks` — `Map<requestId, bubbleId>` — maps in-flight stream requestIds to their bubble entry.
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

**Prompt input**: `showPromptInput()` creates a floating input near the selection. On Enter, generates a `genId()` (timestamp-based + counter) as the `requestId`, creates a bubble, and sends `expandRequest` to the background. On Esc or outside click, dismisses the prompt.

**Cleanup**: On `window.unload`, sends `abort` for every active stream.

### Layer 3: Shared modules (`src/shared/`)

**`models.js`** — `providerRegistry` and `createDefaultConfig()`. Maps provider type keys to descriptor objects with `label`, `authShape`, `defaultBaseUrl`, `capabilities.webSearch`, `knownModels`.

**`prompts.js`** — System prompts (`LOOKUP_SYSTEM_PROMPT`, `CHAT_SYSTEM_PROMPT`) and expand instruction builders (`buildExpandUserInstruction`, `buildExpandPromptedInstruction`).

**`expand-prompt.js`** — `buildExpandMessages(input)` builds a two-message array: simulated assistant message with surrounding context, followed by the user's question about the selection.

### Layer 4: Background services (`src/background/`)

**`config.js:1-27`** — `browser.storage.local` wrapper. Stores config under `'deltaConfig'`. `loadConfig()` merges stored config onto `createDefaultConfig()` defaults. Config includes KB provider settings (`kbProviderType`, `kbApiKey`, `kbBaseUrl`, `kbHost`, `kbModel`) that can be set independently from the main provider.

**`provider.js`** — Streaming LLM client. Routes based on `config.providerType`:
- OpenAI-compatible: POST to `{baseUrl}/chat/completions` with SSE streaming.
- Gemini: `streamGenerateContent` endpoint with `tools: [{ googleSearch: {} }]` when web search enabled.
- Gemini with `webSearchEnabled=false`: falls back to Google's OpenAI-compatible endpoint.

Also provides `callProviderNonStream` (used by `kb.js`) via `callProviderStream` — iterates the full async generator and returns the concatenated response.

**`expansion-records.js`** — Persistence for expansion records. Each record stores `{ id, timestamp, selection, context, prompt, response, kbFed }`. `kbFed: false` records are fed to the Knowledge Base analyzer. Capped at 200 records.

**`conversations.js`** — CRUD for chat conversations. Each conversation has `{ id, title, createdAt, updatedAt, source ('chat' | 'expansion'), turns[] }`. Turns are `{ id, role ('user' | 'assistant'), content, error }`. Stored under `'deltaConversations'`, capped at 100.

**`kb.js`** — Knowledge Base analysis engine. On demand, analyzes unfed expansion records to build a personalization prompt (`kbPrompt`) and extract categorized keywords (`topic`, `knowledge_area`, `learning_preference`). Uses `KB_ANALYSIS_SYSTEM_PROMPT` to generate a paragraph of learning preferences, then `KB_KEYWORD_SYSTEM_PROMPT` to extract 6–12 keywords. Runs non-streaming LLM calls via `callProviderNonStream()`. Can use a separate KB provider config if set.

The KB prompt is injected into every expand and chat system prompt (`'\n\n' + kbPrompt` appended to `system` message) to personalize responses.

### Layer 5: Chat subsystem

**Background side** (`background.js:95-145` — `streamChat()`):
- Uses `CHAT_SYSTEM_PROMPT` with KB prompt injection.
- Receives `chatSend` from the dashboard with the full conversation turn history.
- Streams via `chatStreamChunk` messages (sent to the dashboard, not the content script).

**Dashboard side** (`dashboard.js:71-329`):
- **`chatLoadConversations`** — loads all conversations from background storage.
- **`chatCreateConversation`** — creates a new conversation, auto-titled from the first message.
- **`chatDeleteConversation`** — deletes a conversation by id.
- **`chatUpdateConversation`** — persists turn updates after streaming completes.
- **`chatSend`** — sends the turn history to background for streaming.
- **`chatStreamChunk`** (listener) — renders streaming chunks into the assistant turn element.
- **`chatSelectConversation`** (listener) — activates a specific conversation (used by `transferExpansion`).

**Transfer expansion to Chat** (`background.js:289-314`):
- When the user clicks "Send to Chat" on a bubble, the background creates a new `source: 'expansion'` conversation with the selection context and response as turns, then navigates the dashboard to that conversation.

### Layer 6: UI pages

**Toolbar popup** (`popup/`) — Shows Provider, Model, Shortcut, and KB status from config. "Settings" button opens dashboard. KB shows pending expansion count or "Active" / "(not set)".

**Dashboard** (`dashboard/`) — Tab-based UI with three panels:
- **Chat** (`#tab-chat`): Conversation list (left sidebar), message area, input bar. Supports streaming rendering, conversation switching, delete, and new conversation creation.
- **Knowledge Base** (`#tab-kb`): Status display (total/unfed expansions), Analyze / Re-Analyze / Clear buttons, editable KB prompt textarea, categorized keyword tags with occurrence counts (Topics / Knowledge / Preferences).
- **Settings** (`#tab-settings`): Provider selection, API key, base URL, host, model, web search toggle, shortcut configuration. Separate KB provider settings (optional override for KB analysis calls).

## Message protocol

### Background → Content script (inline bubbles)

| Type | Fields | Purpose |
|---|---|---|
| `expandPromptedFromMenu` | `requestId` (string) | Triggered by context menu or keyboard shortcut. Content script shows the prompt input. |
| `expandChunk` | `requestId` (string), `text` (string), `done` (boolean) | Streams the accumulated LLM response. `done: true` on final chunk. On error: includes `error` with `done: true`. |

### Background → Dashboard (Chat)

| Type | Fields | Purpose |
|---|---|---|
| `chatStreamChunk` | `conversationId`, `turnId`, `text`, `done`, `error` | Streams chat response to the dashboard's active conversation. |
| `chatSelectConversation` | `conversationId` | Navigates dashboard to a specific conversation (used by `transferExpansion`). |

### Content script → Background

| Type | Fields | Purpose |
|---|---|---|
| `expandRequest` | `requestId`, `selection`, `context`, `prompt` (optional) | User submitted the prompt. Background starts LLM streaming. |
| `abort` | `requestId` | Bubble dismissed. Background calls `AbortController.abort()` and cleans up. |
| `bubbleLoad` | `url` | Returns persisted bubble records for `(url, frameId)` (frameId is stamped by the background from `sender.frameId`). |
| `bubblePersist` | `url`, `bubble` | Upsert one bubble record. Same frameId resolution. |
| `bubbleRemove` | `url`, `bubbleId` | Drop one bubble + descendants. |
| `bubbleClearPage` | `url` | Wipe all bubbles for a page (rare). |

### Dashboard ↔ Background

| Type | Fields | Purpose |
|---|---|---|
| `loadConfig` | *(none)* | Returns a Promise resolving to the config object. |
| `saveConfig` | `config` (object) | Persists config to storage. |
| `openSettings` | *(none)* | Opens `dashboard/dashboard.html` in a new tab. |
| `transferExpansion` | `selection`, `context`, `prompt`, `response` | Creates a `source: 'expansion'` chat conversation from a bubble and navigates to it. |
| `chatLoadConversations` | *(none)* | Returns all conversations from storage. |
| `chatCreateConversation` | `title` (optional) | Creates a new conversation, returns it. |
| `chatDeleteConversation` | `conversationId` | Deletes a conversation. |
| `chatUpdateConversation` | `conversationId`, `updates` | Merges updates onto a conversation. |
| `chatSend` | `conversationId`, `turnId`, `messages` | Sends turn history for streaming. Background responds with `chatStreamChunk`. |
| `kbLoadData` | *(none)* | Returns `{ prompt, keywords }` from KB storage. |
| `kbGetStatus` | *(none)* | Returns `{ total, unfed }` expansion record counts. |
| `kbAnalyze` | *(none)* | Analyzes all unfed expansions, updates KB prompt and keywords. Returns `{ newPrompt, keywords, conversationsAnalyzed }`. |
| `kbReanalyze` | `count` (number) | Re-analyzes the last N expansions (without marking fed). Returns same shape. |
| `kbClear` | *(none)* | Clears expansion records, KB prompt, and keywords. |

### End-to-end message flow

```
 ┌────────────── EXPAND FLOW ──────────────┐

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
    │ loadConfig() → loadKbPrompt() → getSystemPrompt() + kbPrompt → buildExpandMessages() → callProviderStream()
    │ for each chunk: sends { type: 'expandChunk', requestId, text: fullResponse, done: false }
    ▼
content.js: onMessage → updateBubbleBody()
    │ On final chunk (done: true) → bubble shows complete text, transfer button appears
    │ User can right-click bubble header → fold into marker
    │ User can left/right-click marker → re-expand
    │ User can select text inside bubble → right-click → sub-expand (same flow, nested)
    │ User can click "Send to Chat" → transferExpansion
    ▼
content.js: transferExpansion button → browser.runtime.sendMessage({ type: 'transferExpansion' })
    ▼
background.js: creates source:'expansion' conversation, opens/navigates dashboard tab
    ▼
dashboard.js: chatSelectConversation → loads and selects the new conversation

 ┌────────────── CHAT FLOW ────────────────┐

User types message in dashboard Chat panel
    │
    ▼
dashboard.js: sendChatMessage()
    │ creates/updates conversation → browser.runtime.sendMessage({ type: 'chatSend', messages })
    ▼
background.js: streamChat()
    │ getSystemPrompt('chat') + kbPrompt → chat messages → callProviderStream()
    │ sends { type: 'chatStreamChunk', conversationId, turnId, text, done }
    ▼
dashboard.js: onMessage → appendStreamingChunk() / finalizeStreamingChunk()
    │ On done: saves conversation via chatUpdateConversation

 ┌────────────── KB FLOW ──────────────────┐

User clicks "Analyze" in dashboard KB tab
    │
    ▼
dashboard.js: → browser.runtime.sendMessage({ type: 'kbAnalyze' })
    ▼
background.js: listUnfedExpansions() → analyzeExpansions()
    │ for each record: callProviderNonStream(KB_ANALYSIS_SYSTEM_PROMPT + record)
    │ → accumulates personalization prompt
    │ → callProviderNonStream(KB_KEYWORD_SYSTEM_PROMPT) → parseKeywords()
    │ → mergeKeywords() → trimByCategory()
    │ → saveKbPrompt() + saveKbKeywords()
    ▼
dashboard.js: refreshKbUI() — shows updated prompt + keyword tags
```

### Key protocol details

- **`requestId` is generated twice**: First by `genRequestId()` for the menu trigger. Then replaced by `genId()` in the content script when the user submits. The stream uses the latter.
- **Full accumulated text is sent each chunk**, not incremental deltas.
- **`frameId` is explicit** in `sendMessage` from background → content.
- **Fire-and-forget streaming**: The background pushes chunks without waiting for acknowledgment. Every `sendMessage` is wrapped in try/catch.
- **KB prompt injection**: Every expand and chat call loads the KB prompt and appends it to the system message. No additional round-trip.
- **Separate KB provider**: If `kbProviderType` is set, KB analysis LLM calls use a different provider config than the main expand/chat calls.

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
- The content script's `contextmenu` listener on bubble bodies captures selection for sub-expansion (stores parent entry in `lastSubParentEntry`). The native menu event then fires through the normal flow with the parent entry set.

## Per-page bubble persistence

Every inline bubble on a page is persisted under `(url, frameId)` in `'deltaPageBubbles'` so it reappears when the user revisits the page — even after a reload. Sub-bubbles are stored as separate records with `parentId` pointing at the parent's id.

**Storage module** (`src/shared/bubble-store.js`):
- Pure storage helpers — no message routing. The content script is the only writer; the background just reads/writes on its behalf.
- Each page key holds an array of bubble records: `{ id, parentId, selection, response, prompt, context, folded, xpath, timestamp }`.
- Records expire after 30 days of inactivity (`pruneExpired`, called lazily on read).
- `removeBubble` cascades to all descendants so dismissing a parent clears its sub-tree in one call.

**Anchor strategy** (in `content.js`):
- **XPath** preferred: positional path from a text node up to the document root, e.g. `/html/body/main[1]/article[2]/p[3]/text()[1]`. Structural — works across reloads as long as the surrounding DOM tree is intact.
- **Text fallback**: if the XPath no longer resolves, the content script walks `document.body` for a text node containing the selection string. Skips our own `.delta-bubble`/`.delta-bubble-marker`/`.delta-adj-hidden` nodes so it doesn't recurse into restored bubbles.
- If neither resolves, the record is dropped (orphan cleanup).

**Rehydrate** (`content.js:rehydrateFromStorage`):
- On content-script init, the script sends `{ type: 'bubbleLoad', url }`. The background responds with the array of records for the current `(url, frameId)`.
- Records are processed in tree order: top-level bubbles first, then children. Each is anchored, re-created via the existing `createBubble()` path, the response text is set directly (no streaming round-trip), and the bubble is folded if it was folded.
- The `isRestoring` flag suppresses persist hooks during rehydrate so we don't write what we just read.

**SPA routes**:
- `history.pushState` and `history.replaceState` are monkey-patched at init; `popstate` is also listened for. On any of these, `currentUrl` updates and rehydrate runs again for the new URL.
- Bubbles from the previous URL are abandoned in their old storage key (not migrated). They expire after 30 days.

**Persistence points** in `content.js`:
- `createBubble` → persist (parent + empty response)
- `updateBubble` with `done: true` → persist with full response
- `foldBubble` → persist with `folded: true`
- `reexpandBubble` → persist with `folded: false`
- `dismissBubble` → remove from storage (cascades to sub-bubbles)

**Edge cases handled**:
- Dismissed bubbles are removed from storage immediately (no tombstones).
- Re-expanding a bubble that was folded mid-stream (no cached response) re-issues the `expandRequest` — the existing reexpand flow already does this.
- `bubbleRemove` cascades to descendants via the `removeBubble` helper.
- Records that fail to anchor on rehydrate are silently dropped from storage.

## Knowledge Base

The Knowledge Base learns the user's interests by analyzing expansion records and building a personalization prompt.

**Storage**: Under `'deltaKbData'` in `browser.storage.local`, shape `{ prompt: string, keywords: [] }`.

**Analysis pipeline** (`kb.js:177-215`):
1. Load unfed expansion records (those with `kbFed: false`).
2. For each record, call the LLM with `KB_ANALYSIS_SYSTEM_PROMPT` + current prompt + the record's selection/context/prompt. The LLM returns a revised personalization paragraph.
3. After all records are processed, call the LLM with `KB_KEYWORD_SYSTEM_PROMPT` + the final prompt to extract 6–12 categorized keywords (`topic`, `knowledge_area`, `learning_preference`).
4. Merge new keywords with existing ones (incrementing counts for matches), trim to top 20 per category.
5. Save the prompt and keywords.

**Injection**: `loadKbPrompt()` is called in both `streamExpand()` and `streamChat()`. If non-empty, it is appended to the system prompt with a `'\n\n'` separator. There is no additional round-trip or performance cost.

**Separate provider**: KB analysis can use a different LLM provider (`kbProviderType`, `kbApiKey`, etc.) if configured. Falls back to the main provider config otherwise.

**Records kept after analysis**: `markExpansionKbFed(id)` only sets the `kbFed` flag — it does not delete. This differs from the ref_src's `markConversationKbFed` (in `ref_src/main/conversations.ts:72-80`), which deletes `source: 'lookup'` conversations after analysis. Expansion records here are only removed by the explicit KB "Clear" button (`kbClear` → `clearExpansionRecords()`) or by the 200-record cap evicting the oldest.

## Chat conversations

**Storage**: Under `'deltaConversations'` in `browser.storage.local`, capped at 100 conversations.

**Conversation structure**:
```json
{
  "id": "uuid",
  "title": "string",
  "createdAt": "timestamp",
  "updatedAt": "timestamp",
  "source": "chat" | "expansion",
  "turns": [
    { "id": "uuid", "role": "user" | "assistant", "content": "string", "error": false }
  ]
}
```

**Source `'expansion'`**: Created by `transferExpansion` when the user sends a bubble's content to Chat. The selection context becomes the first user turn, the response becomes the assistant turn. This opens the dashboard pre-loaded with that conversation.

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

13. **KB prompt injection without extra round-trips** — The KB personalization prompt is loaded once per request and appended to the system message. No separate LLM call, no latency overhead.

14. **Separate KB provider config** — Users can route expensive KB analysis calls to a cheaper/faster model while using a more powerful model for inline expansions.

15. **Chat as a dashboard tab, not a content script** — Chat lives entirely in the dashboard's options_ui page. The content script only handles inline bubbles. This keeps the content script focused and avoids DOM conflicts.

16. **`transferExpansion` creates a persistent conversation** — Sending a bubble to Chat converts it to a `source: 'expansion'` conversation, preserving the selection context and AI response as turn history. The user can continue the conversation from there.

17. **Non-streaming LLM for KB analysis** — KB analysis uses `callProviderNonStream()` (iterates the full generator) since it needs the complete response to build the prompt. Expand and Chat both stream.

18. **Per-page bubble persistence** — Every bubble is persisted under `(url, frameId)` in `deltaPageBubbles` and restored on reload. Anchors are XPath-first with a text-search fallback. The user gets the same inline expansions back when revisiting a page.

19. **Hybrid XPath + text anchor** — XPath is stable for static pages, but breaks when the surrounding DOM mutates (A/B tests, ad injection, framework rerenders). The text fallback trades precision for resilience: if the selection text appears in the body, the bubble is restored. If neither resolves, the record is dropped silently.

20. **History API monkey-patched for SPA routes** — `pushState` and `replaceState` are wrapped at init so we can re-anchor bubbles when an SPA navigates without a full page reload. `popstate` covers back/forward.

21. **Persist hooks suppressed during rehydrate** — The `isRestoring` flag prevents the bubble lifecycle hooks from writing what we just read. Without this, every rehydrate would re-write all records and could lose concurrent updates from other tabs.

22. **Storage scoped to `(url, frameId)` shared across tabs** — Two tabs on the same page+frame see the same bubbles. This is simpler than per-tab isolation, and matches user expectation that "the page" remembers. The trade-off is concurrent edits can clobber each other; in practice this is rare since the user only edits one tab at a time.

23. **KB records kept, not deleted, after analysis** — Unlike the ref_src's `markConversationKbFed` (which deletes `source: 'lookup'` conversations), `markExpansionKbFed` only sets the `kbFed` flag. Records survive analysis so the user retains a full audit trail and can re-analyze at will. The 200-record cap and the explicit "Clear" button are the only deletion paths.

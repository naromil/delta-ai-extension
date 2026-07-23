# Delta AI Expand

Firefox browser extension that expands and defines any plain text inline using a configurable LLM provider.

Right-click a word or phrase on any page, click **Expand**, and a definition or explanation streams inline near the selection. Add a custom prompt with **Expand on…** to ask *why*, *how*, or any other question about the selected text.

![Firefox 115+](https://img.shields.io/badge/Firefox-115%2B-orange)

## Installation (Development)

1. Clone this repository.
2. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on…**.
4. Select `manifest.json` from the repo root.

The extension will be active for the current browser session. To install permanently, [package it as an unsigned `.xpi`](https://extensionworkshop.com/documentation/develop/getting-started-with-web-ext/) or submit it to [addons.mozilla.org](https://addons.mozilla.org/).

## Configuration

Click the **Δ Delta AI Expand** toolbar button to open the settings popup.

| Field | Description |
|-------|-------------|
| **Provider** | LLM service: OpenAI, OpenAI Compatible, Google AI Studio, OpenRouter, or Ollama |
| **API Key** | Your provider API key (not required for Ollama) |
| **Base URL** | Custom endpoint (required for OpenAI Compatible / OpenRouter) |
| **Host** | Ollama host, e.g. `http://localhost:11434` |
| **Model** | Model name, e.g. `gpt-4o-mini`, `gemini-2.5-flash`, `qwen3:4b` |
| **Web search** | Enable web search capability if the provider supports it |

Settings are persisted in `browser.storage.local`.

## Supported Providers

| Provider | Streaming | Web Search | Auth |
|----------|-----------|------------|------|
| OpenAI | yes | yes | API key |
| OpenAI Compatible | yes | yes | API key |
| Google AI Studio | yes | yes | API key |
| OpenRouter | yes | yes | API key |
| Ollama | yes | no | host |

## How It Works

1. **Right-click** any plain text on any page.
2. A custom context menu appears with **Expand**, **Expand on…**, and **Copy**.
3. **Expand** sends the selected text plus surrounding context to your configured LLM and streams the definition into a floating popup near the selection.
4. **Expand on…** shows a prompt input where you can type a custom instruction (e.g. `explain like I'm five`), then streams the tailored result.
5. Dismiss the popup by clicking outside or pressing Escape.

The content script intercepts the `contextmenu` event in all frames, renders the overlay UI with zero external dependencies, and communicates with the background script via WebExtension runtime messaging. The background script streams LLM responses back chunk-by-chunk using the OpenAI-compatible server-sent-events protocol (or Gemini's `streamGenerateContent` for Google AI Studio).

## Project Structure

```
├── manifest.json             # Firefox MV3 manifest
├── background.js             # Message router → provider streamer
├── content.js                # Right-click interception + popup UI
├── content.css               # Dark-themed overlay styles
├── popup/
│   ├── popup.html            # Settings page
│   ├── popup.js              # Config load/save module
│   └── popup.css             # Settings page styling
├── src/
│   ├── shared/
│   │   ├── prompts.js        # Expand instruction templates + system prompts
│   │   ├── expand-prompt.js  # LLM message builder for expand requests
│   │   └── models.js         # Provider registry + default config
│   └── background/
│       ├── provider.js       # Streaming LLM client (SSE / Gemini)
│       └── config.js         # browser.storage.local wrapper
└── icons/
    └── icon.svg
```

No build step. No dependencies. Just load the extension and configure a provider.

## License

MIT — see [LICENSE.md](LICENSE.md).

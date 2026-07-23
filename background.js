/* background.js — module script (manifest "type": "module")
 * Registers native context menu items "Expand" and "Expand on…".
 * Routes menu clicks to the content script which handles all UI.
 * Accepts expandRequest from content script and streams LLM chunks back.
 */

import { callProviderStream } from './src/background/provider.js';
import { loadConfig, saveConfig } from './src/background/config.js';
import { buildExpandMessages } from './src/shared/expand-prompt.js';
import { getSystemPrompt } from './src/shared/prompts.js';

const activeStreams = new Map();

function abortStream(requestId) {
  const ac = activeStreams.get(requestId);
  if (ac) {
    ac.abort();
    activeStreams.delete(requestId);
  }
}

async function streamExpand(tabId, frameId, requestId, selection, context, prompt) {
  abortStream(requestId);

  const config = await loadConfig();
  const messages = [
    { role: 'system', content: getSystemPrompt('lookup') },
    ...buildExpandMessages({ answer: context, selection, prompt })
  ];

  const ac = new AbortController();
  activeStreams.set(requestId, ac);

  try {
    let fullResponse = '';
    for await (const chunk of callProviderStream(messages, config)) {
      if (ac.signal.aborted) break;
      fullResponse += chunk;
      try {
        await browser.tabs.sendMessage(tabId, {
          type: 'expandChunk',
          requestId,
          text: fullResponse,
          done: false
        }, { frameId });
      } catch {
        break;
      }
    }

    if (!ac.signal.aborted) {
      try {
        await browser.tabs.sendMessage(tabId, {
          type: 'expandChunk',
          requestId,
          text: fullResponse,
          done: true
        }, { frameId });
      } catch { /* tab gone */ }
    }
  } catch (err) {
    try {
      await browser.tabs.sendMessage(tabId, {
        type: 'expandChunk',
        requestId,
        error: err?.message || 'Unknown error',
        done: true
      }, { frameId });
    } catch { /* tab gone */ }
  } finally {
    activeStreams.delete(requestId);
  }
}

/* ---- Register native context menu items (every startup, not just onInstalled) ---- */

function registerContextMenus() {
  browser.contextMenus.removeAll().then(() => {
    browser.contextMenus.create({
      id: 'delta-expand',
      title: 'Expand',
      contexts: ['selection']
    });
    browser.contextMenus.create({
      id: 'delta-expand-prompted',
      title: 'Expand on\u2026',
      contexts: ['selection']
    });
  });
}

registerContextMenus();

let reqCtr = 0;
function genRequestId() {
  return 'rx_' + Date.now() + '_' + (reqCtr++);
}

browser.contextMenus.onClicked.addListener((info, tab) => {
  const tabId = tab.id;
  const frameId = typeof info.frameId === 'number' ? info.frameId : 0;
  const requestId = genRequestId();

  if (info.menuItemId === 'delta-expand') {
    browser.tabs.sendMessage(tabId, {
      type: 'expandFromMenu',
      requestId
    }, { frameId });
  } else if (info.menuItemId === 'delta-expand-prompted') {
    browser.tabs.sendMessage(tabId, {
      type: 'expandPromptedFromMenu',
      requestId
    }, { frameId });
  }
});

/* ---- Message handler ---- */

browser.runtime.onMessage.addListener((message, sender) => {
  if (message.type === 'expandRequest') {
    const tabId = sender.tab?.id;
    if (!tabId) return false;
    streamExpand(
      tabId,
      typeof sender.frameId === 'number' ? sender.frameId : 0,
      message.requestId,
      message.selection,
      message.context,
      message.prompt
    );
    return false;
  }

  if (message.type === 'loadConfig') {
    return loadConfig();
  }

  if (message.type === 'saveConfig') {
    return saveConfig(message.config);
  }

  if (message.type === 'abort') {
    abortStream(message.requestId);
    return false;
  }
});

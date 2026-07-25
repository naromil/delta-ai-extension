/* background.js — module script (manifest "type": "module")
 * Registers a native context menu item "Expand…".
 * Routes menu clicks to the content script which handles all UI.
 * Accepts expandRequest from content script and streams LLM chunks back.
 */

import { callProviderStream } from './src/background/provider.js';
import { loadConfig, saveConfig } from './src/background/config.js';
import { buildExpandMessages } from './src/shared/expand-prompt.js';
import { getSystemPrompt } from './src/shared/prompts.js';
import { loadKbPrompt, loadKbData, saveKbPrompt, saveKbKeywords, analyzeExpansions } from './src/background/kb.js';
import { saveExpansionRecord, loadExpansionRecords, listUnfedExpansions, markExpansionKbFed, clearExpansionRecords } from './src/background/expansion-records.js';

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
  const kbPrompt = await loadKbPrompt();
  let systemContent = getSystemPrompt('lookup');
  if (kbPrompt) {
    systemContent = systemContent + '\n\n' + kbPrompt;
  }

  const messages = [
    { role: 'system', content: systemContent },
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

      if (fullResponse && !ac.signal.aborted) {
        saveExpansionRecord({
          id: requestId,
          timestamp: Date.now(),
          selection,
          context,
          prompt: prompt || '',
          response: fullResponse
        }).catch(() => {});
      }
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
      title: 'Expand\u2026',
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
      type: 'expandPromptedFromMenu',
      requestId
    }, { frameId });
  }
});

/* ---- Keyboard shortcut (Ctrl+E) ---- */

browser.commands.onCommand.addListener((command) => {
  if (command !== 'expand') return;
  browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
    const tab = tabs[0];
    if (!tab) return;
    const requestId = genRequestId();
    browser.tabs.sendMessage(tab.id, {
      type: 'expandPromptedFromMenu',
      requestId
    });
  });
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

  if (message.type === 'openSettings') {
    browser.tabs.create({ url: 'dashboard/dashboard.html' });
    return false;
  }

  if (message.type === 'kbLoadData') {
    return loadKbData();
  }

  if (message.type === 'kbGetStatus') {
    return (async () => {
      const records = await loadExpansionRecords();
      const unfed = records.filter(r => !r.kbFed);
      return { total: records.length, unfed: unfed.length };
    })();
  }

  if (message.type === 'kbAnalyze') {
    return (async () => {
      const unfed = await listUnfedExpansions();
      return analyzeExpansions(unfed, markExpansionKbFed);
    })();
  }

  if (message.type === 'kbReanalyze') {
    return (async () => {
      const all = await loadExpansionRecords();
      const n = message.count || all.length;
      const subset = all.slice(-Math.min(n, all.length));
      return analyzeExpansions(subset, null);
    })();
  }

  if (message.type === 'kbClear') {
    return (async () => {
      await clearExpansionRecords();
      await saveKbPrompt('');
      await saveKbKeywords([]);
      return { ok: true };
    })();
  }
});

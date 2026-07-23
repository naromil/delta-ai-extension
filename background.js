/* background.js — module script (manifest "type": "module")
 * Message handler: receives expand requests from the content script,
 * builds LLM messages using shared prompts, calls the configured
 * provider, and streams chunks back to the content script tab.
 */

import { callProviderStream } from './src/background/provider.js';
import { loadConfig, saveConfig } from './src/background/config.js';
import { buildExpandMessages } from './src/shared/expand-prompt.js';
import { getSystemPrompt } from './src/shared/prompts.js';

const activeStreams = new Map();

function abortActiveStream(requestId) {
  const ac = activeStreams.get(requestId);
  if (ac) {
    ac.abort();
    activeStreams.delete(requestId);
  }
}

async function handleExpand(message, sender) {
  const { selection, context, prompt, requestId, role } = message;
  const tabId = sender.tab?.id;
  if (!tabId) return;

  // Abort any previous stream with the same requestId
  abortActiveStream(requestId);

  const config = await loadConfig();
  const messages = [
    { role: 'system', content: getSystemPrompt(role) },
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
        });
      } catch {
        // Tab may have closed
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
        });
      } catch { /* ignore */ }
    }
  } catch (err) {
    const errorMsg = err?.message || 'An unknown error occurred';
    try {
      await browser.tabs.sendMessage(tabId, {
        type: 'expandChunk',
        requestId,
        text: errorMsg,
        error: errorMsg,
        done: true
      });
    } catch { /* ignore */ }
  } finally {
    activeStreams.delete(requestId);
  }
}

browser.runtime.onMessage.addListener((message, sender) => {
  if (message.type === 'expand') {
    handleExpand(message, sender);
    // We don't return true — streaming sends async messages back
    return false;
  }

  if (message.type === 'loadConfig') {
    return loadConfig();
  }

  if (message.type === 'saveConfig') {
    return saveConfig(message.config);
  }

  if (message.type === 'abort') {
    abortActiveStream(message.requestId);
    return false;
  }
});

import { providerRegistry } from '../src/shared/models.js';

const STORAGE_KEY = 'deltaConfig';
const COMMAND_NAME = 'expand';
const isMac = navigator.platform.includes('Mac');

const KNOWN_MODELS = {};
for (const [ptype, reg] of Object.entries(providerRegistry)) {
  if (reg.knownModels) {
    KNOWN_MODELS[ptype] = reg.knownModels;
  }
}

function showStatus(elId, msg, error) {
  const el = document.getElementById(elId);
  el.textContent = msg;
  el.className = error ? 'error' : 'ok';
  setTimeout(() => { el.className = ''; el.textContent = ''; }, 2500);
}

/* ---- Tab Switching ---- */

let activeTab = 'chat';

function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.sidebar-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  document.querySelectorAll('.tab-panel').forEach(p => {
    p.classList.toggle('active', p.id === 'tab-' + tab);
  });
  if (tab === 'chat') {
    document.getElementById('chat-input').focus();
  }
}

document.querySelectorAll('.sidebar-tab').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

/* ---- Config Helpers ---- */

async function loadConfig() {
  try {
    const obj = await browser.storage.local.get(STORAGE_KEY);
    const stored = obj[STORAGE_KEY];
    if (stored && typeof stored === 'object') {
      return { ...createDefaultConfig(), ...stored };
    }
  } catch { /* ignore */ }
  return createDefaultConfig();
}

function createDefaultConfig() {
  return {
    providerType: 'openai-compatible',
    apiKey: '',
    baseUrl: '',
    host: '',
    model: '',
    webSearchEnabled: false
  };
}

/* ================================================================
   CHAT
   ================================================================ */

let activeConversationId = null;
let conversations = [];
let isStreaming = false;

async function saveConversation(conv) {
  await browser.runtime.sendMessage({
    type: 'chatUpdateConversation',
    conversationId: conv.id,
    updates: { title: conv.title, turns: conv.turns }
  });
}

async function loadChatConversations() {
  conversations = await browser.runtime.sendMessage({ type: 'chatLoadConversations' });
  conversations.sort((a, b) => b.updatedAt - a.updatedAt);
  renderConversationList();
  if (conversations.length > 0 && !activeConversationId) {
    selectConversation(conversations[0].id, false);
  } else if (conversations.length === 0) {
    activeConversationId = null;
    renderMessages();
  }
}

function renderConversationList() {
  const list = document.getElementById('chat-conv-list');
  list.innerHTML = '';
  conversations.forEach(conv => {
    const item = document.createElement('div');
    item.className = 'chat-conv-item' + (conv.id === activeConversationId ? ' active' : '');
    item.dataset.convId = conv.id;

    const titleSpan = document.createElement('span');
    titleSpan.textContent = conv.title || 'New Chat';
    titleSpan.style.overflow = 'hidden';
    titleSpan.style.textOverflow = 'ellipsis';
    item.appendChild(titleSpan);

    const delBtn = document.createElement('span');
    delBtn.className = 'conv-delete';
    delBtn.textContent = '\u00d7';
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await browser.runtime.sendMessage({ type: 'chatDeleteConversation', conversationId: conv.id });
      if (activeConversationId === conv.id) activeConversationId = null;
      loadChatConversations();
    });
    item.appendChild(delBtn);

    item.addEventListener('click', () => selectConversation(conv.id, true));
    list.appendChild(item);
  });
}

function selectConversation(id, save) {
  activeConversationId = id;
  renderConversationList();
  renderMessages();

  if (save) {
    const conv = conversations.find(c => c.id === id);
    if (conv) {
      conversations = conversations.map(c =>
        c.id === id ? { ...conv, updatedAt: Date.now() } : c
      );
    }
  }
}

async function newConversation() {
  const conv = await browser.runtime.sendMessage({ type: 'chatCreateConversation', title: 'New Chat' });
  loadChatConversations();
}

function renderMessages() {
  const container = document.getElementById('chat-messages');
  container.innerHTML = '';

  const conv = conversations.find(c => c.id === activeConversationId);
  if (!conv || !conv.turns || conv.turns.length === 0) {
    container.innerHTML = '<div class="chat-empty">Start a new chat</div>';
    return;
  }

  conv.turns.forEach((turn, idx) => {
    const div = document.createElement('div');
    div.className = 'chat-turn ' + turn.role;

    const avatar = document.createElement('div');
    avatar.className = 'chat-turn-avatar';
    avatar.textContent = turn.role === 'user' ? 'U' : 'D';

    const content = document.createElement('div');
    content.className = 'chat-turn-content';
    if (turn.error) content.classList.add('error');

    if (turn.role === 'assistant' && idx === conv.turns.length - 1 && isStreaming && activeConversationId === conv.id) {
      content.classList.add('chat-streaming');
    }
    content.textContent = turn.content || '';

    div.appendChild(avatar);
    div.appendChild(content);
    container.appendChild(div);
  });

  container.scrollTop = container.scrollHeight;
}

function appendStreamingChunk(turnId, text) {
  const container = document.getElementById('chat-messages');
  let turnEl = container.querySelector('[data-turn-id="' + turnId + '"]');
  if (!turnEl) {
    const div = document.createElement('div');
    div.className = 'chat-turn assistant';
    div.dataset.turnId = turnId;

    const avatar = document.createElement('div');
    avatar.className = 'chat-turn-avatar';
    avatar.textContent = 'D';

    const content = document.createElement('div');
    content.className = 'chat-turn-content chat-streaming';
    content.textContent = text;

    div.appendChild(avatar);
    div.appendChild(content);
    container.appendChild(div);
  } else {
    const content = turnEl.querySelector('.chat-turn-content');
    content.textContent = text;
  }
  container.scrollTop = container.scrollHeight;
}

function finalizeStreamingChunk(turnId, text, error) {
  const container = document.getElementById('chat-messages');
  const turnEl = container.querySelector('[data-turn-id="' + turnId + '"]');
  if (turnEl) {
    const content = turnEl.querySelector('.chat-turn-content');
    content.classList.remove('chat-streaming');
    if (error) {
      content.classList.add('error');
      content.textContent = text;
    }
  }

  const conv = conversations.find(c => c.id === activeConversationId);
  if (conv) {
    const turn = conv.turns.find(t => t.id === turnId);
    if (turn) {
      turn.content = text;
      if (error) turn.error = true;
    }
  }
}

async function sendChatMessage() {
  if (isStreaming) return;

  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;

  input.value = '';
  input.style.height = 'auto';

  let conv = conversations.find(c => c.id === activeConversationId);
  if (!conv) {
    conv = await browser.runtime.sendMessage({ type: 'chatCreateConversation', title: text.slice(0, 50) });
    loadChatConversations();
    await new Promise(r => setTimeout(r, 50));
  }

  const userTurn = { id: crypto.randomUUID(), role: 'user', content: text };
  conv.turns.push(userTurn);
  if (!conv.title || conv.title === 'New Chat') {
    conv.title = text.slice(0, 50);
  }
  saveConversation(conv);
  renderMessages();
  renderConversationList();

  const assistantTurnId = crypto.randomUUID();
  const assistantTurn = { id: assistantTurnId, role: 'assistant', content: '' };
  conv.turns.push(assistantTurn);
  isStreaming = true;

  const chatMessages = conv.turns
    .filter(t => t.id !== assistantTurnId)
    .map(t => ({ role: t.role, content: t.content }));

  try {
    await browser.runtime.sendMessage({
      type: 'chatSend',
      conversationId: conv.id,
      turnId: assistantTurnId,
      messages: chatMessages
    });
  } catch (err) {
    assistantTurn.content = err?.message || 'Send failed';
    assistantTurn.error = true;
    isStreaming = false;
    renderMessages();
  }
}

function initChat() {
  document.getElementById('chat-new-btn').addEventListener('click', newConversation);

  const input = document.getElementById('chat-input');
  const sendBtn = document.getElementById('chat-send-btn');

  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    sendBtn.disabled = !input.value.trim() || isStreaming;
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  });

  sendBtn.addEventListener('click', sendChatMessage);

  browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'chatStreamChunk') {
      if (msg.conversationId !== activeConversationId) return;
      if (msg.done) {
        isStreaming = false;
        finalizeStreamingChunk(msg.turnId, msg.text, msg.error);
        const conv = conversations.find(c => c.id === activeConversationId);
        if (conv) saveConversation(conv);
        renderMessages();
      } else {
        appendStreamingChunk(msg.turnId, msg.text);
      }
    }

    if (msg.type === 'chatSelectConversation') {
      switchTab('chat');
      loadChatConversations().then(() => {
        const conv = conversations.find(c => c.id === msg.conversationId);
        if (conv) {
          selectConversation(conv.id, false);
        }
      });
    }
  });

  loadChatConversations();
}

/* ================================================================
   KNOWLEDGE BASE
   ================================================================ */

function showKbStatus(msg, error) {
  const el = document.getElementById('kb-result');
  el.textContent = msg;
  el.className = error ? 'error' : 'ok';
}

async function refreshKbUI() {
  const statusText = document.getElementById('kb-status-text');
  const analyzeBtn = document.getElementById('kb-analyze-btn');
  const reanalyzeBtn = document.getElementById('kb-reanalyze-btn');
  const promptText = document.getElementById('kb-prompt-text');
  const keywordsGrid = document.getElementById('kb-keywords');

  try {
    const [status, kbData] = await Promise.all([
      browser.runtime.sendMessage({ type: 'kbGetStatus' }),
      browser.runtime.sendMessage({ type: 'kbLoadData' })
    ]);

    const unfed = status.unfed;
    const total = status.total;

    if (total === 0) {
      statusText.textContent = 'No expansion history yet.';
    } else if (unfed > 0) {
      statusText.textContent = `${unfed} / ${total} expansion(s) ready for analysis`;
    } else {
      statusText.textContent = `${total} expansion(s) analyzed`;
    }

    analyzeBtn.disabled = unfed === 0;
    reanalyzeBtn.disabled = total === 0;

    promptText.value = kbData.prompt || '';

    const keywords = kbData.keywords || [];
    renderKeywords(keywords, keywordsGrid);
  } catch (err) {
    statusText.textContent = 'Error loading KB data.';
    console.error('KB refresh error:', err);
  }
}

function renderKeywords(keywords, container) {
  container.innerHTML = '';

  if (keywords.length === 0) {
    container.innerHTML = '<span style="color: rgba(228,230,240,0.35); font-size: 12px;">No keywords yet. Run analysis to extract them.</span>';
    return;
  }

  const categories = [
    { key: 'topic', label: 'Topics', cssClass: 'blue' },
    { key: 'knowledge_area', label: 'Knowledge', cssClass: 'green' },
    { key: 'learning_preference', label: 'Preferences', cssClass: 'purple' }
  ];

  for (const cat of categories) {
    const group = keywords.filter(kw => kw.category === cat.key).sort((a, b) => b.count - a.count);
    if (group.length === 0) continue;

    const catDiv = document.createElement('div');
    const label = document.createElement('div');
    label.className = 'kb-cat-label';
    label.textContent = cat.label;
    catDiv.appendChild(label);

    const tagsDiv = document.createElement('div');
    tagsDiv.className = 'kb-tags';

    for (const kw of group) {
      const tag = document.createElement('span');
      tag.className = `kb-tag ${cat.cssClass}`;
      tag.title = `${kw.keyword} (${kw.count}×)`;

      const nameSpan = document.createElement('span');
      nameSpan.className = 'kb-tag-keyword';
      nameSpan.textContent = kw.keyword;
      tag.appendChild(nameSpan);

      if (kw.count > 1) {
        const countSpan = document.createElement('span');
        countSpan.className = 'kb-tag-count';
        countSpan.textContent = `×${kw.count}`;
        tag.appendChild(countSpan);
      }

      tagsDiv.appendChild(tag);
    }

    catDiv.appendChild(tagsDiv);
    container.appendChild(catDiv);
  }
}

function initKnowledgeBase() {
  // Listen for analysis progress updates from background
  browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'kbAnalyzeProgress') {
      const progressEl = document.getElementById('kb-progress');
      const fillEl = document.getElementById('kb-progress-fill');
      const textEl = document.getElementById('kb-progress-text');

      if (!progressEl) return;
      progressEl.style.display = 'flex';
      const pct = msg.total > 0 ? (msg.done / msg.total) * 100 : 0;
      fillEl.style.width = Math.round(pct) + '%';
      textEl.textContent = `${msg.done} / ${msg.total}`;

      if (msg.done >= msg.total) {
        setTimeout(() => {
          progressEl.style.display = 'none';
          fillEl.style.width = '0%';
        }, 1200);
      }
    }
  });

  refreshKbUI();

  const analyzeBtn = document.getElementById('kb-analyze-btn');
  const reanalyzeBtn = document.getElementById('kb-reanalyze-btn');
  const reanalyzeRow = document.getElementById('kb-reanalyze-row');
  const reanalyzeCount = document.getElementById('kb-reanalyze-count');
  const reanalyzeGo = document.getElementById('kb-reanalyze-go');
  const reanalyzeCancel = document.getElementById('kb-reanalyze-cancel');
  const clearBtn = document.getElementById('kb-clear-btn');

  analyzeBtn.addEventListener('click', async () => {
    analyzeBtn.disabled = true;
    analyzeBtn.textContent = 'Analyzing…';
    showKbStatus('', false);

    try {
      const result = await browser.runtime.sendMessage({ type: 'kbAnalyze' });
      if (result.conversationsAnalyzed === 0) {
        showKbStatus('No unfed expansions to analyze.', false);
      } else {
        showKbStatus(`Analyzed ${result.conversationsAnalyzed} expansion(s).`, false);
      }
      await refreshKbUI();
    } catch (err) {
      showKbStatus(err?.message || 'Analysis failed.', true);
    } finally {
      analyzeBtn.textContent = 'Analyze';
      analyzeBtn.disabled = false;
    }
  });

  reanalyzeBtn.addEventListener('click', () => {
    reanalyzeRow.style.display = 'flex';
    setTimeout(() => reanalyzeCount.focus(), 0);
  });

  reanalyzeGo.addEventListener('click', async () => {
    const n = parseInt(reanalyzeCount.value, 10);
    if (isNaN(n) || n < 1) return;

    reanalyzeRow.style.display = 'none';
    reanalyzeBtn.disabled = true;
    reanalyzeBtn.textContent = 'Re-analyzing…';
    showKbStatus('', false);

    try {
      const result = await browser.runtime.sendMessage({ type: 'kbReanalyze', count: n });
      if (result.conversationsAnalyzed === 0) {
        showKbStatus('No expansions found.', false);
      } else {
        showKbStatus(`Re-analyzed ${result.conversationsAnalyzed} expansion(s).`, false);
      }
      await refreshKbUI();
    } catch (err) {
      showKbStatus(err?.message || 'Re-analysis failed.', true);
    } finally {
      reanalyzeBtn.textContent = 'Re-Analyze';
      reanalyzeBtn.disabled = false;
    }
  });

  reanalyzeCancel.addEventListener('click', () => {
    reanalyzeRow.style.display = 'none';
  });

  reanalyzeCount.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') reanalyzeGo.click();
    if (e.key === 'Escape') reanalyzeCancel.click();
  });

  clearBtn.addEventListener('click', async () => {
    if (!confirm('Delete all expansion history and Knowledge Base data? This cannot be undone.')) return;
    try {
      await browser.runtime.sendMessage({ type: 'kbClear' });
      showKbStatus('All KB data cleared.', false);
      await refreshKbUI();
    } catch (err) {
      showKbStatus(err?.message || 'Clear failed.', true);
    }
  });
}

/* ================================================================
   SETTINGS
   ================================================================ */

function updateSuggestions(providerType) {
  const datalist = document.getElementById('model-suggestions');
  datalist.innerHTML = '';
  const models = KNOWN_MODELS[providerType] || [];
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m;
    datalist.appendChild(opt);
  }
}

function updateFieldVisibility(providerType) {
  const reg = providerRegistry[providerType];
  const authShape = reg ? reg.authShape : 'apiKey';

  document.getElementById('field-apiKey').style.display = authShape === 'apiKey' ? '' : 'none';
  document.getElementById('field-baseUrl').style.display = (providerType === 'openai-compatible' || providerType === 'openrouter') ? '' : 'none';
  document.getElementById('field-host').style.display = authShape === 'host' ? '' : 'none';

  const wsCheck = document.getElementById('webSearchEnabled');
  const wsLabel = wsCheck.parentElement;
  wsLabel.style.display = reg && reg.capabilities && reg.capabilities.webSearch ? '' : 'none';
}

async function initProviderConfig() {
  const providerSelect = document.getElementById('providerType');
  const modelInput = document.getElementById('model');

  const config = await loadConfig();
  providerSelect.value = config.providerType || 'openai-compatible';
  document.getElementById('apiKey').value = config.apiKey || '';
  document.getElementById('baseUrl').value = config.baseUrl || '';
  document.getElementById('host').value = config.host || '';
  modelInput.value = config.model || '';
  document.getElementById('webSearchEnabled').checked = !!config.webSearchEnabled;
  updateFieldVisibility(config.providerType || 'openai-compatible');
  updateSuggestions(config.providerType || 'openai-compatible');

  providerSelect.addEventListener('change', () => {
    const ptype = providerSelect.value;
    updateFieldVisibility(ptype);
    updateSuggestions(ptype);
    modelInput.value = '';
  });

  document.getElementById('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();

    const newConfig = {
      providerType: providerSelect.value,
      apiKey: document.getElementById('apiKey').value.trim(),
      baseUrl: document.getElementById('baseUrl').value.trim(),
      host: document.getElementById('host').value.trim(),
      model: modelInput.value.trim(),
      webSearchEnabled: document.getElementById('webSearchEnabled').checked
    };

    try {
      await browser.storage.local.set({ [STORAGE_KEY]: { ...createDefaultConfig(), ...newConfig } });
      showStatus('status', 'Saved.', false);
    } catch {
      showStatus('status', 'Save failed.', true);
    }
  });
}

function updateKbSuggestions(providerType) {
  const datalist = document.getElementById('kb-model-suggestions');
  datalist.innerHTML = '';
  const models = KNOWN_MODELS[providerType] || [];
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m;
    datalist.appendChild(opt);
  }
}

function updateKbFieldVisibility(providerType) {
  if (!providerType) {
    document.getElementById('kb-field-apiKey').style.display = 'none';
    document.getElementById('kb-field-baseUrl').style.display = 'none';
    document.getElementById('kb-field-host').style.display = 'none';
    return;
  }
  const reg = providerRegistry[providerType];
  const authShape = reg ? reg.authShape : 'apiKey';
  document.getElementById('kb-field-apiKey').style.display = authShape === 'apiKey' ? '' : 'none';
  document.getElementById('kb-field-baseUrl').style.display = (providerType === 'openai-compatible' || providerType === 'openrouter') ? '' : 'none';
  document.getElementById('kb-field-host').style.display = authShape === 'host' ? '' : 'none';
}

const KB_CONFIG_STORAGE_KEY = 'deltaKbConfig';

function createDefaultKbProviderConfig() {
  return {
    providerType: '',
    apiKey: '',
    baseUrl: '',
    host: '',
    model: ''
  };
}

async function initKbProviderConfig() {
  const providerSelect = document.getElementById('kbProviderType');
  const modelInput = document.getElementById('kbModel');

  // Load from separate KB config key
  async function loadKbProviderConfig() {
    try {
      const obj = await browser.storage.local.get(KB_CONFIG_STORAGE_KEY);
      const stored = obj[KB_CONFIG_STORAGE_KEY];
      if (stored && typeof stored === 'object') {
        return { ...createDefaultKbProviderConfig(), ...stored };
      }
    } catch { /* ignore */ }
    return createDefaultKbProviderConfig();
  }

  const kbConfig = await loadKbProviderConfig();
  providerSelect.value = kbConfig.providerType || '';
  document.getElementById('kbApiKey').value = kbConfig.apiKey || '';
  document.getElementById('kbBaseUrl').value = kbConfig.baseUrl || '';
  document.getElementById('kbHost').value = kbConfig.host || '';
  modelInput.value = kbConfig.model || '';
  updateKbFieldVisibility(kbConfig.providerType || '');
  if (kbConfig.providerType) {
    updateKbSuggestions(kbConfig.providerType);
  } else {
    updateKbSuggestions(document.getElementById('providerType').value || 'openai-compatible');
  }

  providerSelect.addEventListener('change', () => {
    const ptype = providerSelect.value;
    updateKbFieldVisibility(ptype);
    if (ptype) {
      updateKbSuggestions(ptype);
    } else {
      updateKbSuggestions(document.getElementById('providerType').value || 'openai-compatible');
    }
    modelInput.value = '';
  });

  document.getElementById('kb-settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();

    const newKbConfig = {
      providerType: providerSelect.value,
      apiKey: document.getElementById('kbApiKey').value.trim(),
      baseUrl: document.getElementById('kbBaseUrl').value.trim(),
      host: document.getElementById('kbHost').value.trim(),
      model: modelInput.value.trim()
    };

    try {
      await browser.storage.local.set({ [KB_CONFIG_STORAGE_KEY]: { ...createDefaultKbProviderConfig(), ...newKbConfig } });
      showStatus('kb-status', 'Saved.', false);
    } catch {
      showStatus('kb-status', 'Save failed.', true);
    }
  });
}

function formatShortcut(e) {
  const parts = [];
  if (isMac && e.metaKey) parts.push('Command');
  if (e.ctrlKey) parts.push(isMac ? 'MacCtrl' : 'Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');

  let key = e.key;
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) return null;

  if (key === ' ') key = 'Space';
  else if (key.length === 1) key = key.toUpperCase();

  const isFuncKey = /^F([1-9]|1[0-9])$/.test(key);
  if (!isFuncKey && parts.length === 0) return null;

  parts.push(key);
  return parts.join('+');
}

async function initShortcutConfig() {
  const shortcutInput = document.getElementById('shortcut');
  const statusEl = document.getElementById('shortcut-status');
  const resetBtn = document.getElementById('reset-shortcut');

  async function loadCurrent() {
    const commands = await browser.commands.getAll();
    const cmd = commands.find(c => c.name === COMMAND_NAME);
    if (cmd && cmd.shortcut) {
      shortcutInput.value = cmd.shortcut;
    } else {
      shortcutInput.value = '(not set)';
    }
  }

  await loadCurrent();

  shortcutInput.addEventListener('keydown', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const formatted = formatShortcut(e);
    if (!formatted) return;

    try {
      await browser.commands.update({ name: COMMAND_NAME, shortcut: formatted });
      shortcutInput.value = formatted;
      showStatus('shortcut-status', 'Shortcut updated.', false);
    } catch (err) {
      showStatus('shortcut-status', 'Invalid shortcut: ' + (err?.message || err), true);
    }
  });

  shortcutInput.addEventListener('click', () => {
    shortcutInput.focus();
  });

  resetBtn.addEventListener('click', async () => {
    try {
      await browser.commands.reset(COMMAND_NAME);
      await loadCurrent();
      showStatus('shortcut-status', 'Reset to default.', false);
    } catch (err) {
      showStatus('shortcut-status', 'Reset failed: ' + (err?.message || err), true);
    }
  });
}

/* ================================================================
   INIT
   ================================================================ */

initChat();
initProviderConfig();
initKbProviderConfig();
initShortcutConfig();
initKnowledgeBase();

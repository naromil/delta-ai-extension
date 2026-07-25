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

/* ---- Provider config ---- */

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

/* ---- Shortcut config ---- */

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

/* ---- Init ---- */

initProviderConfig();
initShortcutConfig();
initKnowledgeBase();

/* ---- Knowledge Base ---- */

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

async function initKnowledgeBase() {
  await refreshKbUI();

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
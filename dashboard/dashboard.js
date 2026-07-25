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
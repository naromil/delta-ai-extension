import { providerRegistry } from '../src/shared/models.js';

const STORAGE_KEY = 'deltaConfig';
const COMMAND_NAME = 'expand';

document.getElementById('settings-btn').addEventListener('click', () => {
  browser.runtime.sendMessage({ type: 'openSettings' });
});

async function loadConfig() {
  try {
    const obj = await browser.storage.local.get(STORAGE_KEY);
    const stored = obj[STORAGE_KEY];
    if (stored && typeof stored === 'object') {
      return { providerType: 'openai-compatible', apiKey: '', baseUrl: '', host: '', model: '', webSearchEnabled: false, ...stored };
    }
  } catch { /* ignore */ }
  return null;
}

async function loadShortcut() {
  try {
    const commands = await browser.commands.getAll();
    const cmd = commands.find(c => c.name === COMMAND_NAME);
    return cmd?.shortcut || '';
  } catch { /* ignore */ }
  return '';
}

function setMissing(elId, missing) {
  const el = document.getElementById(elId);
  if (missing) el.classList.add('missing');
  else el.classList.remove('missing');
}

(async () => {
  const config = await loadConfig();
  const shortcut = await loadShortcut();

  const providerEl = document.getElementById('provider-label');
  const modelEl = document.getElementById('model-label');
  const shortcutEl = document.getElementById('shortcut-label');

  if (config) {
    const reg = providerRegistry[config.providerType];
    providerEl.textContent = reg ? reg.label : config.providerType;
    modelEl.textContent = config.model || '(not set)';
    setMissing(modelEl, !config.model);
  } else {
    providerEl.textContent = 'Not configured';
    setMissing(providerEl, true);
    modelEl.textContent = '—';
  }

  shortcutEl.textContent = shortcut || '(not set)';
  setMissing(shortcutEl, !shortcut);

  try {
    const { unfed } = await browser.runtime.sendMessage({ type: 'kbGetStatus' });
    const kbEl = document.getElementById('kb-label');
    if (unfed > 0) {
      kbEl.textContent = `${unfed} pending`;
    } else {
      const { prompt } = await browser.runtime.sendMessage({ type: 'kbLoadData' });
      kbEl.textContent = prompt ? 'Active' : '(not set)';
      setMissing(kbEl, !prompt);
    }
  } catch {
    document.getElementById('kb-label').textContent = '—';
  }
})();
import { providerRegistry } from '../src/shared/models.js';

const KNOWN_MODELS = {};

// Flatten knownModels from providerRegistry for datalist suggestions
for (const [ptype, reg] of Object.entries(providerRegistry)) {
  if (reg.knownModels) {
    KNOWN_MODELS[ptype] = reg.knownModels;
  }
}

async function loadConfig() {
  try {
    return await browser.runtime.sendMessage({ type: 'loadConfig' });
  } catch {
    return null;
  }
}

async function saveConfig(config) {
  try {
    const result = await browser.runtime.sendMessage({ type: 'saveConfig', config });
    return result;
  } catch {
    return false;
  }
}

function showStatus(msg, error) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = error ? 'error' : 'ok';
  setTimeout(() => { el.className = ''; el.textContent = ''; }, 2500);
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

  const apiField = document.getElementById('field-apiKey');
  const urlField = document.getElementById('field-baseUrl');
  const hostField = document.getElementById('field-host');

  apiField.style.display = authShape === 'apiKey' ? '' : 'none';
  urlField.style.display = (providerType === 'openai-compatible' || providerType === 'openrouter') ? '' : 'none';
  hostField.style.display = authShape === 'host' ? '' : 'none';

  // Show web search toggle based on capability
  const wsCheck = document.getElementById('webSearchEnabled');
  const wsLabel = wsCheck.parentElement;
  wsLabel.style.display = reg && reg.capabilities && reg.capabilities.webSearch ? '' : 'none';
}

(async () => {
  const form = document.getElementById('settings-form');
  const providerSelect = document.getElementById('providerType');
  const modelInput = document.getElementById('model');

  const config = await loadConfig();
  if (config) {
    providerSelect.value = config.providerType || 'openai-compatible';
    document.getElementById('apiKey').value = config.apiKey || '';
    document.getElementById('baseUrl').value = config.baseUrl || '';
    document.getElementById('host').value = config.host || '';
    modelInput.value = config.model || '';
    document.getElementById('webSearchEnabled').checked = !!config.webSearchEnabled;
    updateFieldVisibility(config.providerType || 'openai-compatible');
    updateSuggestions(config.providerType || 'openai-compatible');
  } else {
    updateFieldVisibility('openai-compatible');
    updateSuggestions('openai-compatible');
  }

  providerSelect.addEventListener('change', () => {
    const ptype = providerSelect.value;
    updateFieldVisibility(ptype);
    updateSuggestions(ptype);
    modelInput.value = '';
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const newConfig = {
      providerType: providerSelect.value,
      apiKey: document.getElementById('apiKey').value.trim(),
      baseUrl: document.getElementById('baseUrl').value.trim(),
      host: document.getElementById('host').value.trim(),
      model: modelInput.value.trim(),
      webSearchEnabled: document.getElementById('webSearchEnabled').checked
    };

    const ok = await saveConfig(newConfig);
    if (ok && ok.success !== false) {
      showStatus('Saved.', false);
    } else {
      showStatus('Save failed. Check the console.', true);
    }
  });
})();

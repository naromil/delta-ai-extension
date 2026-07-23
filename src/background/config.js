// Storage-backed config (WebExtension browser.storage.local replaces ref_src/main/config.ts file IO).
import { createDefaultConfig } from '../shared/models.js';

const STORAGE_KEY = 'deltaConfig';

export async function loadConfig() {
  try {
    const obj = await browser.storage.local.get(STORAGE_KEY);
    const stored = obj[STORAGE_KEY];
    if (stored && typeof stored === 'object') {
      return { ...createDefaultConfig(), ...stored };
    }
  } catch {
    // ignore
  }
  return createDefaultConfig();
}

export async function saveConfig(config) {
  await browser.storage.local.set({ [STORAGE_KEY]: { ...createDefaultConfig(), ...config } });
  return true;
}

export async function resolveProvider() {
  const config = await loadConfig();
  return config;
}

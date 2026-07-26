// Ported from ref_src/shared/models.ts — runtime registry used by config.js / provider.js.

export const providerRegistry = {
  'google-ai-studio': {
    label: 'Google AI Studio',
    authShape: 'apiKey',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    capabilities: { webSearch: true },
    implemented: true,
    knownModels: ['gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemma-4-31b-it']
  },
  'openai-compatible': {
    label: 'OpenAI Compatible',
    authShape: 'apiKey',
    capabilities: { webSearch: true },
    implemented: true
  },
  openai: {
    label: 'OpenAI',
    authShape: 'apiKey',
    defaultBaseUrl: 'https://api.openai.com/v1',
    capabilities: { webSearch: true },
    implemented: true,
    knownModels: ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4o']
  },
  ollama: {
    label: 'Ollama',
    authShape: 'host',
    capabilities: { webSearch: false },
    implemented: true,
    knownModels: ['qwen3:4b', 'gemma4:31b', 'llama3.2:1b', 'llama3.2:3b']
  },
  openrouter: {
    label: 'OpenRouter',
    authShape: 'apiKey',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    capabilities: { webSearch: true },
    implemented: true,
    knownModels: ['google/gemini-3.6-flash', 'openai/gpt-4o-mini', 'openai/gpt-4.1-mini']
  }
};

export const MAX_KEYWORDS_PER_CATEGORY = 20;

export function createDefaultConfig() {
  return {
    providerType: 'openai-compatible',
    apiKey: '',
    baseUrl: '',
    host: '',
    model: '',
    webSearchEnabled: false,
    contextChars: 1500,
    kbProviderType: '',
    kbApiKey: '',
    kbBaseUrl: '',
    kbHost: '',
    kbModel: ''
  };
}

export function createDefaultKbConfig() {
  return {
    prompt: '',
    keywords: []
  };
}

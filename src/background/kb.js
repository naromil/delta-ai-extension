import { KB_ANALYSIS_SYSTEM_PROMPT, KB_KEYWORD_SYSTEM_PROMPT } from '../shared/prompts.js';
import { MAX_KEYWORDS_PER_CATEGORY, createDefaultKbProviderConfig } from '../shared/models.js';
import { callProviderStream } from './provider.js';
import { loadConfig } from './config.js';

const KB_STORAGE_KEY = 'deltaKbData';
const KB_CONFIG_STORAGE_KEY = 'deltaKbConfig';

export async function loadKbPrompt() {
  try {
    const obj = await browser.storage.local.get(KB_STORAGE_KEY);
    return (obj[KB_STORAGE_KEY] && obj[KB_STORAGE_KEY].prompt) || '';
  } catch {
    return '';
  }
}

export async function saveKbPrompt(content) {
  const obj = await browser.storage.local.get(KB_STORAGE_KEY);
  const data = obj[KB_STORAGE_KEY] || { prompt: '', keywords: [] };
  data.prompt = content;
  await browser.storage.local.set({ [KB_STORAGE_KEY]: data });
}

export async function loadKbKeywords() {
  try {
    const obj = await browser.storage.local.get(KB_STORAGE_KEY);
    return (obj[KB_STORAGE_KEY] && obj[KB_STORAGE_KEY].keywords) || [];
  } catch {
    return [];
  }
}

export async function saveKbKeywords(keywords) {
  const obj = await browser.storage.local.get(KB_STORAGE_KEY);
  const data = obj[KB_STORAGE_KEY] || { prompt: '', keywords: [] };
  data.keywords = keywords;
  await browser.storage.local.set({ [KB_STORAGE_KEY]: data });
}

export async function loadKbData() {
  try {
    const obj = await browser.storage.local.get(KB_STORAGE_KEY);
    return obj[KB_STORAGE_KEY] || { prompt: '', keywords: [] };
  } catch {
    return { prompt: '', keywords: [] };
  }
}

export async function loadKbProviderConfig() {
  try {
    const obj = await browser.storage.local.get(KB_CONFIG_STORAGE_KEY);
    const stored = obj[KB_CONFIG_STORAGE_KEY];
    if (stored && typeof stored === 'object') {
      return { ...createDefaultKbProviderConfig(), ...stored };
    }
  } catch { /* ignore */ }
  return createDefaultKbProviderConfig();
}

export async function saveKbProviderConfig(config) {
  await browser.storage.local.set({ [KB_CONFIG_STORAGE_KEY]: { ...createDefaultKbProviderConfig(), ...config } });
  return true;
}

function buildSingleMaterial(record) {
  const parts = [];
  parts.push(`Selection: "${record.selection}"`);
  if (record.prompt) {
    parts.push(`Prompt: "${record.prompt}"`);
  }
  parts.push(`Context: `);
  parts.push(record.context);
  return parts.join('\n');
}

function buildKbMaterials(records) {
  const materials = [];
  for (const record of records) {
    materials.push(buildSingleMaterial(record));
  }
  return materials.join('\n\n=====\n\n');
}

function buildKbAnalysisMessages(currentPrompt, materialsText) {
  return [
    { role: 'system', content: KB_ANALYSIS_SYSTEM_PROMPT },
    {
      role: 'user',
      content: currentPrompt
        ? [
            'Current personalization prompt:',
            '',
            currentPrompt,
            '',
            'Below are new expansion summaries. Rewrite/adjust the prompt above with new insights from these expansions:',
            '',
            materialsText
          ].join('\n')
        : [
            "Analyze these expansion summaries and generate a personalization prompt describing the user's learning preferences:",
            '',
            materialsText
          ].join('\n')
    }
  ];
}

function buildKbKeywordMessages(learningPreference, existingKeywords) {
  const existingLines = existingKeywords.map(
    kw => `${kw.keyword} [${kw.category}] (count: ${kw.count})`
  );
  const existingBlock = existingLines.length > 0
    ? ['', 'Existing keywords (reuse where still applicable; increment count by re-emiting):', ...existingLines].join('\n')
    : '';

  return [
    { role: 'system', content: KB_KEYWORD_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        "Extract categorized keywords from this user's learning preference description:",
        '',
        learningPreference,
        existingBlock
      ].join('\n')
    }
  ];
}

function parseKeywords(raw) {
  return raw
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => {
      const match = line.match(/^(.+?)\s*\[(topic|knowledge_area|learning_preference)\]$/);
      if (!match) return null;
      return { keyword: match[1].trim(), category: match[2], count: 1 };
    })
    .filter(kw => kw !== null);
}

function mergeKeywords(existing, incoming) {
  const map = new Map();
  for (const kw of existing) {
    const key = `${kw.category}:${kw.keyword.toLowerCase()}`;
    map.set(key, { ...kw });
  }
  for (const kw of incoming) {
    const key = `${kw.category}:${kw.keyword.toLowerCase()}`;
    const prev = map.get(key);
    if (prev) {
      prev.count += 1;
    } else {
      map.set(key, { ...kw });
    }
  }
  return Array.from(map.values());
}

function trimByCategory(keywords) {
  const categories = ['topic', 'knowledge_area', 'learning_preference'];
  const result = [];
  for (const cat of categories) {
    const group = keywords
      .filter(kw => kw.category === cat)
      .sort((a, b) => b.count - a.count)
      .slice(0, MAX_KEYWORDS_PER_CATEGORY);
    result.push(...group);
  }
  return result;
}

async function callProviderNonStream(messages) {
  const [config, kbConfig] = await Promise.all([loadConfig(), loadKbProviderConfig()]);
  const effectiveConfig = (kbConfig.providerType || kbConfig.model)
    ? {
        providerType: kbConfig.providerType || config.providerType,
        apiKey: kbConfig.apiKey || config.apiKey,
        model: kbConfig.model || config.model,
        baseUrl: kbConfig.baseUrl || config.baseUrl,
        host: kbConfig.host || config.host,
        webSearchEnabled: false
      }
    : config;
  let fullResponse = '';
  for await (const chunk of callProviderStream(messages, effectiveConfig)) {
    fullResponse += chunk;
  }
  return fullResponse.trim();
}

export async function analyzeExpansions(records, markFedFn) {
  let currentPrompt = await loadKbPrompt();
  let analyzed = 0;

  for (const record of records) {
    const material = buildSingleMaterial(record);
    const analysisMessages = buildKbAnalysisMessages(currentPrompt, material);
    currentPrompt = await callProviderNonStream(analysisMessages);
    analyzed++;

    if (markFedFn) {
      await markFedFn(record.id);
    }
  }

  if (analyzed === 0) {
    return {
      newPrompt: currentPrompt,
      keywords: await loadKbKeywords(),
      conversationsAnalyzed: 0
    };
  }

  await saveKbPrompt(currentPrompt);

  const existingKeywords = await loadKbKeywords();
  const keywordMessages = buildKbKeywordMessages(currentPrompt, existingKeywords);
  const rawKeywords = await callProviderNonStream(keywordMessages);
  const parsed = parseKeywords(rawKeywords);
  const merged = mergeKeywords(existingKeywords, parsed);
  const trimmed = trimByCategory(merged);
  await saveKbKeywords(trimmed);

  return {
    newPrompt: currentPrompt,
    keywords: trimmed,
    conversationsAnalyzed: analyzed
  };
}

/* Ported from ref_src/main/provider.ts.
 * Background-side provider that streams LLM responses.
 * Used by the background script message handler.
 */

import { providerRegistry } from '../shared/models.js';

const FETCH_TIMEOUT_MS = 30000;

async function fetchWithTimeout(url, options) {
  const timeout = options.timeout ?? FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeout / 1000}s. Check your API endpoint and network connection.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function* sseStream(res, extract) {
  const reader = res.body?.getReader();
  if (!reader) throw new Error('Response body is not readable');

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6).trim();
        if (data === '[DONE]') return;
        try {
          const parsed = JSON.parse(data);
          const chunk = extract(parsed);
          if (chunk) yield chunk;
        } catch {
          // skip malformed JSON
        }
      }
    }
  }
}

async function* callOpenAICompatibleStream(apiKey, model, messages, baseUrl, webSearchEnabled = false) {
  const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const url = `${normalizedBaseUrl}/chat/completions`;

  const body = { model, messages, stream: true };
  if (webSearchEnabled) {
    body.tools = [{ type: 'web_search' }];
  }

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const res = await fetchWithTimeout(url, { method: 'POST', headers, body: JSON.stringify(body) });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`API error ${res.status}: ${errText}`);
  }

  yield* sseStream(res, (parsed) => {
    const choice = parsed?.choices?.[0];
    return choice?.delta?.content;
  });
}

async function* callGeminiWithSearchStream(apiKey, model, messages) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?key=${apiKey}&alt=sse`;

  let systemInstruction = null;
  const contents = [];

  for (const msg of messages) {
    if (msg.role === 'system' && !systemInstruction) {
      systemInstruction = msg.content;
    } else if (msg.role === 'system') {
      contents.push({ role: 'user', parts: [{ text: msg.content }] });
    } else {
      contents.push({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }]
      });
    }
  }

  const body = { contents, tools: [{ googleSearch: {} }] };
  if (systemInstruction) {
    body.system_instruction = { parts: [{ text: systemInstruction }] };
  }

  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${errText}`);
  }

  yield* sseStream(res, (parsed) => {
    const candidate = parsed?.candidates?.[0];
    const parts = candidate?.content?.parts;
    return parts?.[0]?.text;
  });
}

export async function* callProviderStream(messages, config) {
  const { providerType, apiKey, model, baseUrl, host, webSearchEnabled } = config;

  const reg = providerRegistry[providerType];
  if (!reg) throw new Error(`Provider "${providerType}" is not supported.`);

  if (!apiKey && providerType !== 'ollama') {
    throw new Error('No API key configured. Open the extension popup to add your API key.');
  }

  switch (providerType) {
    case 'google-ai-studio':
      if (webSearchEnabled) {
        yield* callGeminiWithSearchStream(apiKey, model, messages);
      } else {
        yield* callOpenAICompatibleStream(
          apiKey, model, messages,
          reg.defaultBaseUrl || 'https://generativelanguage.googleapis.com/v1beta',
          false
        );
      }
      break;
    case 'openai-compatible':
      if (!baseUrl) throw new Error('Base URL is required for OpenAI Compatible provider.');
      yield* callOpenAICompatibleStream(apiKey, model, messages, baseUrl, webSearchEnabled);
      break;
    case 'openai':
      yield* callOpenAICompatibleStream(
        apiKey, model, messages,
        baseUrl || 'https://api.openai.com/v1',
        webSearchEnabled
      );
      break;
    case 'openrouter':
      yield* callOpenAICompatibleStream(
        apiKey, model, messages,
        baseUrl || 'https://openrouter.ai/api/v1',
        webSearchEnabled
      );
      break;
    case 'ollama': {
      const h = (host || 'http://localhost:11434').replace(/\/+$/, '');
      yield* callOpenAICompatibleStream('', model, messages, `${h}/v1`, false);
      break;
    }
    default:
      throw new Error(`Provider "${providerType}" is not supported.`);
  }
}

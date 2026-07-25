const STORAGE_KEY = 'deltaConversations';
const MAX_CONVERSATIONS = 100;

export async function loadConversations() {
  try {
    const obj = await browser.storage.local.get(STORAGE_KEY);
    return Array.isArray(obj[STORAGE_KEY]) ? obj[STORAGE_KEY] : [];
  } catch {
    return [];
  }
}

async function saveConversations(conversations) {
  const trimmed = conversations.slice(-MAX_CONVERSATIONS);
  await browser.storage.local.set({ [STORAGE_KEY]: trimmed });
  return trimmed;
}

export async function getConversation(id) {
  const conversations = await loadConversations();
  return conversations.find(c => c.id === id) || null;
}

export async function createConversation(title, turns, source) {
  const conversations = await loadConversations();
  const conv = {
    id: crypto.randomUUID(),
    title: title || 'New Chat',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    source: source || 'chat',
    turns: turns || []
  };
  conversations.push(conv);
  await saveConversations(conversations);
  return conv;
}

export async function updateConversation(id, updates) {
  const conversations = await loadConversations();
  const idx = conversations.findIndex(c => c.id === id);
  if (idx === -1) return null;
  conversations[idx] = { ...conversations[idx], ...updates, updatedAt: Date.now() };
  await saveConversations(conversations);
  return conversations[idx];
}

export async function deleteConversation(id) {
  const conversations = await loadConversations();
  const filtered = conversations.filter(c => c.id !== id);
  if (filtered.length === conversations.length) return false;
  await saveConversations(filtered);
  return true;
}

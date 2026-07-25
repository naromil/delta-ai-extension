const STORAGE_KEY = 'deltaExpansionRecords';
const MAX_RECORDS = 200;

export async function saveExpansionRecord(record) {
  const records = await loadExpansionRecords();
  records.push({ ...record, kbFed: false });
  const trimmed = records.slice(-MAX_RECORDS);
  await browser.storage.local.set({ [STORAGE_KEY]: trimmed });
  return trimmed.length;
}

export async function loadExpansionRecords() {
  try {
    const obj = await browser.storage.local.get(STORAGE_KEY);
    return Array.isArray(obj[STORAGE_KEY]) ? obj[STORAGE_KEY] : [];
  } catch {
    return [];
  }
}

export async function listUnfedExpansions() {
  const records = await loadExpansionRecords();
  return records.filter(r => !r.kbFed);
}

export async function markExpansionKbFed(id) {
  const records = await loadExpansionRecords();
  const record = records.find(r => r.id === id);
  if (record) record.kbFed = true;
  await browser.storage.local.set({ [STORAGE_KEY]: records });
}

export async function clearExpansionRecords() {
  await browser.storage.local.remove(STORAGE_KEY);
}

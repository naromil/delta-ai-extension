/* Per-page bubble persistence.
 *
 * Stores inline bubbles keyed by (url, frameId) so they can be restored when
 * the user revisits a page. Each entry is an array of bubble records:
 *
 *   {
 *     id: 'dx_xxx',
 *     parentId: 'dx_yyy' | null,  // for sub-bubbles nested in a parent body
 *     selection: 'HKUMed',
 *     response: 'Li Ka Shing Faculty...',
 *     prompt: 'more' | '',
 *     context: 'surrounding paragraph...',
 *     folded: false,
 *     xpath: '/html/body/main/article[2]/p[3]/text()[1]' | null,
 *     timestamp: 1700000000000
 *   }
 *
 * The xpath anchors the bubble to a specific text node in the page. If the
 * xpath fails to resolve on rehydrate, the content script falls back to a
 * text search for `selection`.
 *
 * Records are evicted after EXPIRY_MS so storage doesn't grow forever.
 */

const STORAGE_KEY = 'deltaPageBubbles';
const EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function pageKey(url, frameId) {
  return `${url}|${frameId}`;
}

function isAlive(record, now) {
  return now - (record.timestamp || 0) < EXPIRY_MS;
}

async function loadAll() {
  try {
    const obj = await browser.storage.local.get(STORAGE_KEY);
    const all = obj[STORAGE_KEY];
    if (all && typeof all === 'object') return all;
  } catch {
    // ignore
  }
  return {};
}

async function saveAll(all) {
  await browser.storage.local.set({ [STORAGE_KEY]: all });
}

export async function loadPageBubbles(url, frameId, now = Date.now()) {
  const all = await loadAll();
  const records = all[pageKey(url, frameId)] || [];
  return records.filter(r => isAlive(r, now));
}

export async function savePageBubbles(url, frameId, bubbles) {
  const all = await loadAll();
  if (!bubbles || bubbles.length === 0) {
    delete all[pageKey(url, frameId)];
  } else {
    all[pageKey(url, frameId)] = bubbles;
  }
  await saveAll(all);
}

export async function addOrUpdateBubble(url, frameId, bubble) {
  const all = await loadAll();
  const key = pageKey(url, frameId);
  const records = all[key] || [];
  const idx = records.findIndex(r => r.id === bubble.id);
  if (idx >= 0) {
    records[idx] = { ...records[idx], ...bubble };
  } else {
    records.push(bubble);
  }
  all[key] = records;
  await saveAll(all);
}

export async function removeBubble(url, frameId, bubbleId) {
  const all = await loadAll();
  const key = pageKey(url, frameId);
  const records = all[key] || [];

  const toRemove = new Set([bubbleId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const r of records) {
      if (r.parentId && toRemove.has(r.parentId) && !toRemove.has(r.id)) {
        toRemove.add(r.id);
        changed = true;
      }
    }
  }

  const filtered = records.filter(r => !toRemove.has(r.id));
  if (filtered.length === 0) {
    delete all[key];
  } else {
    all[key] = filtered;
  }
  await saveAll(all);
}

export async function clearPageBubbles(url, frameId) {
  const all = await loadAll();
  delete all[pageKey(url, frameId)];
  await saveAll(all);
}

export async function pruneExpired(now = Date.now()) {
  const all = await loadAll();
  let changed = false;
  for (const key of Object.keys(all)) {
    const before = all[key].length;
    all[key] = all[key].filter(r => isAlive(r, now));
    if (all[key].length === 0) {
      delete all[key];
    }
    if (all[key].length !== before) changed = true;
  }
  if (changed) await saveAll(all);
  return changed;
}

/* ---- Per-page persistence ----
 * Every bubble on a page is persisted under (location.href, frameId) so
 * the user gets the same bubbles back when they revisit the page.
 * Content script sends its own URL with every persist/load call; the
 * background script stamps the message with sender.frameId.
 */

function persistBubble(entry) {
  if (!entry || !entry.id) return;
  if (isRestoring) return;

  // Sub-bubbles persist through the parent — the parent's persist call
  // includes all children recursively. This keeps the storage tree-shaped
  // and avoids the fragile two-pass rehydrate for parent/child lookups.
  if (entry.parent) {
    persistBubble(entry.parent);
    return;
  }

  var record = buildBubbleRecord(entry);
  try {
    browser.runtime.sendMessage({
      type: 'bubblePersist',
      url: currentUrl,
      bubble: record
    }).catch(function () {});
  } catch (e) { /* extension context invalidated */ }
}

function buildBubbleRecord(entry) {
  var data = entry.data || {};
  var xpathRecord = entry._savedXpath || buildAnchorXPath(entry);
  var record = {
    id: entry.id,
    parentId: null,
    selection: data.selection || '',
    response: entry.responseText || '',
    prompt: data.prompt || '',
    context: data.context || '',
    folded: !!entry.folded,
    timestamp: Date.now(),
    children: []
  };
  if (xpathRecord) {
    record.xpath = xpathRecord.xpath;
    record.textOffset = xpathRecord.offset;
  }
  entry.children.forEach(function (child) {
    record.children.push(buildChildRecord(child));
  });
  return record;
}

function buildChildRecord(entry) {
  var cd = entry.data || {};
  var cr = entry._savedXpath || buildAnchorXPath(entry);
  var rec = {
    id: entry.id,
    parentId: entry.parent ? entry.parent.id : null,
    selection: cd.selection || '',
    response: entry.responseText || '',
    prompt: cd.prompt || '',
    context: cd.context || '',
    folded: !!entry.folded,
    timestamp: Date.now(),
    children: []
  };
  if (cr) {
    rec.xpath = cr.xpath;
    rec.textOffset = cr.offset;
  }
  entry.children.forEach(function (gc) {
    rec.children.push(buildChildRecord(gc));
  });
  return rec;
}

function removePersistedBubble(bubbleId) {
  if (!bubbleId) return;
  try {
    browser.runtime.sendMessage({
      type: 'bubbleRemove',
      url: currentUrl,
      bubbleId: bubbleId
    }).catch(function () {});
  } catch (e) { /* extension context invalidated */ }
}

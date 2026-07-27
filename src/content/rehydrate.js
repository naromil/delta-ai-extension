/* ---- Rehydrate bubbles from storage on init ----
 * On content script start, ask the background for any persisted bubbles
 * for this (url, frameId). Re-anchor them in the DOM in tree order:
 * top-level bubbles first, then their sub-bubbles. Set the response
 * text directly so no streaming round-trip is needed.
 *
 * isRestoring suppresses the persist hooks inside createBubble etc. so
 * we don't write what we just read.
 */

function rehydrateFromStorage() {
  var loadPromise;
  try {
    loadPromise = browser.runtime.sendMessage({ type: 'bubbleLoad', url: currentUrl });
  } catch (e) { return; }
  if (!loadPromise || typeof loadPromise.then !== 'function') return;

  loadPromise.then(function (records) {
    if (!Array.isArray(records) || records.length === 0) return;
      isRestoring = true;
      try {
        // Convert flat records (old format) into nested tree format.
      // Records with parentId are children that need to be nested under
      // their parent. New saves already store children nested.
      var top = records.filter(function (r) { return !r.parentId; });
      var flatChildren = records.filter(function (r) { return r.parentId; });

      // Nest flat children into their parents, deduplicating by id.
      var topById = {};
      top.forEach(function (r) {
        topById[r.id] = r;
        if (!r.children) r.children = [];
      });
      var cleanedChildIds = [];
      flatChildren.forEach(function (child) {
        var parent = topById[child.parentId];
        if (parent) {
          var exists = parent.children.some(function (c) { return c.id === child.id; });
          if (!exists) {
            parent.children.push(child);
          }
          topById[child.id] = child;
          cleanedChildIds.push(child.id);
        }
      });
      cleanedChildIds.forEach(function (cid) {
        try {
          browser.runtime.sendMessage({
            type: 'bubbleRemove', url: currentUrl, bubbleId: cid
          }).catch(function () {});
        } catch (e) { /* ignore */ }
      });

      // Restore top-level bubbles (with their nested children).
      // Children that need folding are deferred until after isRestoring
      // so the parent DOM is stable before we manipulate children.
      pendingFolds = [];
      top.forEach(function (r) { restoreOne(r, null); });
    } finally {
      isRestoring = false;
      // Apply deferred folds now that the document is stable.
      var toFold = pendingFolds;
      pendingFolds = [];
      toFold.forEach(function (childEntry) {
        foldBubble(childEntry.id);
      });
    }
  }).catch(function () {});
}

function restoreOne(record, parentEntry) {
  if (!record || !record.id || !record.selection) return;
  if (bubbles.has(record.id)) return; // already there

  // Resolve anchor: try XPath first, then text search.
  var anchor = null;
  var anchorNode = resolveAnchorXPath(record.xpath);
  if (anchorNode) {
    anchor = { node: anchorNode, offset: typeof record.textOffset === 'number' ? record.textOffset : 0 };
  } else {
    anchor = findAnchorByText(record.selection, record.context);
  }
  if (!anchor) {
    // Anchor gone — drop the record so we don't accumulate orphans.
    removePersistedBubble(record.id);
    return;
  }
  var range = rangeAtTextNode(anchor.node, record.selection, anchor.offset);
  if (!range) {
    removePersistedBubble(record.id);
    return;
  }

  var data = {
    selection: record.selection,
    context: record.context || '',
    prompt: record.prompt || '',
    range: range
  };

  // Compute XPath NOW, before wrapRangeWithMarker detaches the range.
  var savedXpath = buildXPathFromNode(range.startContainer, range.startOffset, document);
  var marker = wrapRangeWithMarker(range);

  var container = marker ? marker.parentNode : null;

  var entry = createBubble({
    id: record.id,
    range: range,
    data: data,
    parent: parentEntry || null,
    marker: marker,
    container: container,
    _savedXpath: savedXpath
  });

  if (!entry) return;

  setBubbleResponse(entry, record.response);

  // Restore children (sub-bubbles) recursively inside this bubble.
  // Children are stored as nested `children` in the record tree.
  if (record.children && record.children.length > 0) {
    record.children.forEach(function (childRecord) {
      restoreSubBubble(childRecord, entry);
    });
  }

  // Defer folding until after ALL bubbles are restored. Other top-level
  // bubbles whose XPath anchors resolve inside THIS bubble's body need
  // the body to be in the DOM to re-anchor. Folding here would detach
  // this bubble's el, breaking their anchor resolution.
  if (record.folded) {
    pendingFolds.push(entry);
  }
}

function restoreSubBubble(record, parentEntry) {
  // Restore a sub-bubble directly inside the parent's body.
  // No anchor resolution needed — the text is in the parent's response.
  var container = parentEntry.el && parentEntry.el.querySelector('.delta-bubble-body');
  if (!container) return;

  var data = {
    selection: record.selection || '',
    context: record.context || '',
    prompt: record.prompt || '',
    range: null
  };

  var entry = createBubble({
    id: record.id,
    range: null,
    data: data,
    parent: parentEntry,
    marker: null,
    container: container
  });

  if (!entry) return;

  setBubbleResponse(entry, record.response);

  // Recursively restore grandchildren
  if (record.children && record.children.length > 0) {
    record.children.forEach(function (gc) {
      restoreSubBubble(gc, entry);
    });
  }

  // Defer folding until after rehydrate completes, so the parent's DOM
  // is stable (folded parents have their entry.el safely detached).
  if (record.folded) {
    pendingFolds.push(entry);
  }
}

function setBubbleResponse(entry, responseText) {
  if (!entry || !entry.el || !responseText) return;
  entry.responseText = responseText;
  var body = entry.el.querySelector('.delta-bubble-body');
  if (!body) return;
  var spinner = body.querySelector('.delta-bubble-spinner');
  if (spinner) removeEl(spinner);
  var contentEl = body.querySelector('.delta-bubble-content');
  if (!contentEl) {
    contentEl = document.createElement('span');
    contentEl.className = 'delta-bubble-content';
    body.appendChild(contentEl);
  }
  contentEl.textContent = responseText;
  var transferBtn = entry.el.querySelector('.delta-bubble-transfer');
  if (transferBtn) transferBtn.style.display = '';
}

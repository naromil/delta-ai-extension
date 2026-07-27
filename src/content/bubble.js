/* ---- Bubble creation ---- */

/**
 * Create an expanded bubble. The bubble is inserted INLINE in place of the
 * given marker element (which is removed). The marker loses its parent —
 * we keep a reference so fold() can put a fresh marker back.
 *
 * @param {Object} opts
 * @param {Range}  opts.range        Saved Range of the original selection
 * @param {Object} opts.data         { selection, context, prompt }
 * @param {Entry|null} opts.parent  parent bubble entry (for sub-bubbles)
 * @param {string} opts.marker       initial marker element to replace (if any)
 * @param {string} [opts.id]         bubble id (preserved across re-expand)
 * @param {HTMLElement} [opts.container] container to append into (for sub-bubbles). Defaults to marker.parentNode.
 * @returns {Object} the new bubble entry
 */
function createBubble(opts) {
  var id = opts.id || genId();
  var range = opts.range;
  var data = opts.data || {};
  var parent = opts.parent || null;
  var marker = opts.marker || null;
  var container = opts.container || (marker ? marker.parentNode : null);

  var entry = {
    id: id,
    el: null,
    marker: null,
    range: range,
    data: data,
    responseText: '',
    children: new Map(),
    parent: parent,
    folded: false,
    _savedXpath: opts._savedXpath || null
  };

  /* Build bubble DOM */
  var el = document.createElement('div');
  el.className = 'delta-bubble';
  el.setAttribute('data-bubble-id', id);

  var header = document.createElement('div');
  header.className = 'delta-bubble-header';

  var title = document.createElement('span');
  title.className = 'delta-bubble-title';
  var titleText = (data.prompt ? (data.prompt + ' / ') : '') + (data.selection || '');
  title.textContent = titleText.length > 60 ? titleText.slice(0, 57) + '\u2026' : titleText;
  title.title = data.selection || '';

  var actions = document.createElement('div');
  actions.className = 'delta-bubble-actions';

  /* Send-to-Chat is only offered on bubbles directly embedded in the page
   * (or future top-level frames). Sub-expansions nested inside a parent
   * bubble skip it — they have no separate "Chat" destination, since
   * sending the whole parent's expansion is enough.
   */
  var transferBtn = null;
  if (!parent) {
    transferBtn = document.createElement('button');
    transferBtn.className = 'delta-bubble-transfer';
    transferBtn.title = 'Send to Chat';
    transferBtn.setAttribute('aria-label', 'Send to Chat');
    transferBtn.type = 'button';
    /* Inline SVG: speech-bubble glyph. Inherits currentColor. */
    transferBtn.innerHTML =
      '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">' +
      '<path fill="none" stroke="currentColor" stroke-width="1.4" ' +
      'stroke-linecap="round" stroke-linejoin="round" ' +
      'd="M2.5 3.5h11a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H6.5L4 13.5V11.5H2.5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z"/>' +
      '</svg>';
    transferBtn.style.display = 'none';
    transferBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var responseData = entry.data || {};
      browser.runtime.sendMessage({
        type: 'transferExpansion',
        selection: responseData.selection || '',
        context: responseData.context || '',
        prompt: responseData.prompt || '',
        response: entry.responseText || ''
      });
      transferBtn.classList.add('delta-bubble-transfer-done');
      transferBtn.style.pointerEvents = 'none';
    });
  }

  var close = document.createElement('button');
  close.className = 'delta-bubble-close';
  close.textContent = '\u00d7';
  close.title = 'Close (or right-click to fold)';
  close.setAttribute('aria-label', 'Close');
  close.type = 'button';
  close.addEventListener('click', function (e) {
    e.stopPropagation();
    dismissBubble(id);
  });

  if (transferBtn) actions.appendChild(transferBtn);
  actions.appendChild(close);
  header.appendChild(title);
  header.appendChild(actions);

  /* Right-click anywhere on header folds the bubble */
  header.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    e.stopPropagation();
    foldBubble(id);
  });

  var body = document.createElement('div');
  body.className = 'delta-bubble-body';
  var spinner = document.createElement('span');
  spinner.className = 'delta-bubble-spinner';
  spinner.textContent = 'Thinking\u2026';
  body.appendChild(spinner);

  el.appendChild(header);
  el.appendChild(body);

  /* Wire the body to allow sub-expansions inside it:
   * We intercept selections that start/end within the body and route
   * "expand" menu events back through the same showPromptInput flow, but
   * with parent=this entry so the resulting bubble renders inside this body.
   *
   * We track the most recent in-body selection so showPromptInput can use it.
   */
  body.addEventListener('mouseup', function () {
    // Let the selection settle, then capture if it's within this body.
    setTimeout(function () {
      var sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      var r = sel.getRangeAt(0);
      if (!body.contains(r.startContainer) || !body.contains(r.endContainer)) return;
      var text = sel.toString().trim();
      if (!text) return;
      var ctx = getSurroundingText(r.startContainer, 2000) || entry.responseText;
      body.__deltaLastSubData = {
        selection: text,
        context: ctx,
        range: r.cloneRange()
      };
    }, 0);
  }, true);

  /* Insert: replace marker with bubble, or append to container.
   * If the marker isn't actually a child of `container` (e.g., because
   * the marker was placed in a deeper descendant by wrapRangeWithMarker),
   * fall back to the marker's real parentNode so we never strand a
   * marker in the DOM — that would leave the user looking at a colored
   * span with no click handler (the "always folded" symptom). */
  if (marker && container) {
    try {
      container.replaceChild(el, marker);
    } catch (err) {
      var realParent = marker.parentNode;
      if (realParent) {
        realParent.replaceChild(el, marker);
      } else {
        document.body.appendChild(el);
      }
    }
  } else if (container) {
    container.appendChild(el);
  } else {
    // No marker — last resort, append at end of body
    document.body.appendChild(el);
  }

  entry.el = el;

  /* If the original text had punctuation immediately before/after, hide it
   * so the frame sits flush. */
  hideAdjacentPunctuation(el);

  /* Register the bubble so chunks can find it */
  bubbles.set(id, entry);
  if (parent) {
    parent.children.set(id, entry);
    /* The parent body now hosts a sub-bubble — drop its bottom padding so
     * the sub-bubble's top edge sits flush with the parent's text area.
     * (Re-applied when the last sub-bubble is dismissed.) */
    var parentBody = parent.el && parent.el.querySelector('.delta-bubble-body');
    if (parentBody) parentBody.classList.remove('delta-bubble-body--text-only');
  } else {
    /* Top-level bubble: if its body has no sub-bubbles it should keep the
     * small bottom padding so the text doesn't kiss the frame edge. */
    var body = el.querySelector('.delta-bubble-body');
    if (body) body.classList.add('delta-bubble-body--text-only');
  }

  /* Persist (suppressed during rehydrate by isRestoring). */
  persistBubble(entry);

  return entry;
}

/* ---- Bubble updates / streaming ---- */

function updateBubble(id, text, done, error) {
  var entry = bubbles.get(id);
  if (!entry) return;
  var body = entry.el.querySelector('.delta-bubble-body');
  if (!body) return;

  /* Find (or create) a content node after the spinner */
  var content = body.querySelector('.delta-bubble-content');
  var spinner = body.querySelector('.delta-bubble-spinner');
  if (!content) {
    if (spinner) removeEl(spinner);
    content = document.createElement('span');
    content.className = 'delta-bubble-content';
    body.appendChild(content);
  }

  if (error) {
    body.className = 'delta-bubble-body delta-error';
    content.textContent = text || error;
  } else {
    body.className = 'delta-bubble-body';
    content.textContent = text || '\u200b';
    entry.responseText = text || '';
  }

  if (done) {
    var transferBtn = entry.el.querySelector('.delta-bubble-transfer');
    if (transferBtn) transferBtn.style.display = '';
    /* Persist the now-complete response so a reload can restore it
     * without re-issuing the LLM call. */
    persistBubble(entry);
  }
}

/* ---- Fold / re-expand ----
 * Fold detaches the bubble element from the DOM and stores it on the entry.
 * A colored marker over the original selection text takes its place. The
 * nested subtree inside the bubble el (including folded sub-bubble markers
 * and their click handlers) is preserved, so re-expand is just a DOM
 * swap of the marker back for the cached el — no re-creation needed.
 *
 * This also means sub-bubbles that were folded before the parent folded
 * remain folded markers inside the saved el; clicking them later (after
 * the parent re-expands) re-expands them via their own marker handlers,
 * using their own cached responses.
 */

function foldBubble(id) {
  var entry = bubbles.get(id);
  if (!entry || entry.folded) return;

  /* Tell background to stop streaming if in-flight */
  var pendingId = null;
  pendingChunks.forEach(function (bid, rid) {
    if (bid === id) pendingId = rid;
  });
  if (pendingId) {
    browser.runtime.sendMessage({ type: 'abort', requestId: pendingId });
    pendingChunks.delete(pendingId);
  }

  /* Recursively fold all children first so their el is also detached and
   * stored on their own entry, keeping the parent el's sub-tree consistent. */
  entry.children.forEach(function (child) { if (!child.folded) foldBubble(child.id); });

  /* Create the colored marker over the original selection text. */
  var isLight = document.documentElement.classList.contains('delta-theme-light');
  var markerBg = isLight ? 'rgba(74,111,165,0.15)' : 'rgba(138,160,184,0.28)';
  var markerBorder = isLight ? '#4a6fa5' : '#8aa0b8';
  var markerTriangle = isLight ? '#4a6fa5' : '#8aa0b8';
  var markerBgHover = isLight ? 'rgba(74,111,165,0.32)' : 'rgba(138,160,184,0.50)';

  var marker = document.createElement('span');
  marker.className = 'delta-bubble-marker';
  // Apply all styling inline so the marker is always visible regardless
  // of whether the content CSS loads successfully (Firefox content script
  // CSS can fail to apply in sandboxed/cross-origin frames).
  marker.style.cssText =
    'display:inline;' +
    'background:' + markerBg + ';' +
    'border-bottom:1px dashed ' + markerBorder + ';' +
    'border-radius:3px;' +
    'padding:0 3px;' +
    'margin:0 1px;' +
    'cursor:pointer;' +
    'vertical-align:baseline;' +
    'user-select:text;';
  // Triangle prefix for visual distinction
  var triangleSpan = document.createElement('span');
  triangleSpan.style.fontSize = '0.85em';
  triangleSpan.style.color = markerTriangle;
  triangleSpan.style.marginRight = '3px';
  triangleSpan.textContent = '\u25B8';
  marker.appendChild(triangleSpan);
  marker.appendChild(document.createTextNode(entry.data.selection || ''));
  // Hover darkening
  marker.addEventListener('mouseenter', function () { marker.style.background = markerBgHover; });
  marker.addEventListener('mouseleave', function () { marker.style.background = markerBg; });

  /* Insert marker before the bubble, then detach the bubble. */
  if (entry.el && entry.el.parentNode) {
    entry.el.parentNode.insertBefore(marker, entry.el);
    entry.el.parentNode.removeChild(entry.el);
  } else if (entry.marker) {
    /* Already a marker in place (e.g. double fold) — replace it. */
    entry.marker.parentNode.replaceChild(marker, entry.marker);
  } else {
    document.body.appendChild(marker);
  }

  /* Wire click + right-click to re-expand this bubble. */
  marker.addEventListener('click', function (e) {
    e.preventDefault();
    e.stopPropagation();
    reexpandBubble(id);
  });
  marker.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    e.stopPropagation();
    reexpandBubble(id);
  });

  entry.marker = marker;
  entry.folded = true;
  /* entry.el is intentionally kept (detached) for re-expand swap back. */

  /* Restore any punctuation that was hidden around the bubble before fold
   * (it's no longer adjacent to the marker — wait, actually it IS still
   * adjacent; the marker took the bubble's slot). Re-run the check on the
   * marker so punctuation still gets hidden when the bubble becomes a
   * marker. */
  hideAdjacentPunctuation(marker);

  /* Persist the folded state. */
  persistBubble(entry);
}

/**
 * Re-expand: swap the marker back for the cached bubble element (no AI call,
 * no DOM recreation). Nested sub-bubbles that were folded remain as markers
 * inside `entry.el`; clicking them re-expands each via its own marker
 * handler using its cached response.
 *
 * Three cases for where the marker might be:
 *  (a) Live in the document, with a real parentNode — simple swap.
 *  (b) Detached (no parentNode). Re-insert the cached el at a sensible
 *      location: into the parent bubble's body if this is a sub-bubble,
 *      otherwise at the end of document.body.
 *  (c) Completely lost (entry.marker is null). Same fallback as (b).
 */
function reexpandBubble(id) {
  var entry = bubbles.get(id);
  if (!entry || !entry.folded) return;
  if (!entry.el) {
    /* We somehow lost the cached element. Best we can do is mark unfolded
     * so the next fold() call isn't a no-op. */
    entry.folded = false;
    entry.marker = null;
    return;
  }

  var marker = entry.marker;
  if (marker && marker.parentNode) {
    /* Case (a): marker is live. Swap it for the cached el. */
    marker.parentNode.replaceChild(entry.el, marker);
  } else {
    /* Case (b)/(c): re-insert the cached el into the parent body if we
     * have one, otherwise at end of document.body. */
    var target = null;
    if (entry.parent && entry.parent.el) {
      target = entry.parent.el.querySelector('.delta-bubble-body');
    }
    if (!target) target = document.body;
    target.appendChild(entry.el);
  }

  entry.marker = null;
  entry.folded = false;

  /* Hide adjacent punctuation that should sit flush with the frame. */
  hideAdjacentPunctuation(entry.el);

  /* If we never had a response (e.g. folded mid-stream), re-issue the
   * request by sending expandRequest again. */
  if (!entry.responseText && entry.data && entry.data.selection && !hasPendingChunk(id)) {
    var requestId = genId();
    pendingChunks.set(requestId, id);
    browser.runtime.sendMessage({
      type: 'expandRequest',
      requestId: requestId,
      selection: entry.data.selection,
      context: entry.data.context,
      prompt: entry.data.prompt
    }).catch(function (err) {
      updateBubble(id, 'Failed to send expand request: ' + (err && err.message ? err.message : err), true, true);
    });
  }

  /* Persist the unfolded state. */
  persistBubble(entry);
}

function hasPendingChunk(bubbleId) {
  var found = false;
  pendingChunks.forEach(function (bid) { if (bid === bubbleId) found = true; });
  return found;
}

/* ---- Dismiss (for explicit close) ---- */

function dismissBubble(id) {
  var entry = bubbles.get(id);
  if (!entry) return;

  /* Abort in-flight stream */
  var pendingId = null;
  pendingChunks.forEach(function (bid, rid) { if (bid === id) pendingId = rid; });
  if (pendingId) {
    browser.runtime.sendMessage({ type: 'abort', requestId: pendingId });
    pendingChunks.delete(pendingId);
  }

  /* Recursively dismiss children */
  entry.children.forEach(function (child) { dismissBubble(child.id); });

  /* Restore any hidden adjacent punctuation so we don't strand wrappers
   * in the document when the bubble is removed. */
  if (entry.el) restoreAdjacentPunctuation(entry.el);
  if (entry.marker) restoreAdjacentPunctuation(entry.marker);

  /* Restore original DOM if we have a saved range and the marker/bubble is
   * still attached. We do this by unwrapping — replace the bubble (or
   * marker) with its original text only if the bubble was folded, otherwise
   * the bubble contains the result not the original text.
   *
   * The simplest correct behavior: just remove our elements and leave the
   * original text intact (the marker wraps the original text; the bubble
   * replaced it but didn't destroy it). For dismissed bubbles we unwrap
   * the marker back to its text children. For expanded bubbles we leave
   * the bubble's removal as-is; the original text was already inside the
   * marker that we replaced — to restore it, we re-extract from range.
   */
  if (entry.marker) {
    unwrapMarker(entry.marker);
    entry.marker = null;
  }
  if (entry.el) {
    /* Put the original text back as a plain text node. This is best-effort. */
    if (entry.range) {
      try {
        var container = entry.el.parentNode;
        var textNode = document.createTextNode(entry.data.selection || '');
        if (container) container.replaceChild(textNode, entry.el);
      } catch (err) { /* ignore */ }
    } else {
      removeEl(entry.el);
    }
    entry.el = null;
  }

  bubbles.delete(id);
  if (entry.parent) {
    entry.parent.children.delete(id);
    /* If the parent no longer hosts any sub-bubbles, restore its body's
     * bottom padding so the text doesn't kiss the frame edge. */
    if (entry.parent.children.size === 0 && entry.parent.el) {
      var pbody = entry.parent.el.querySelector('.delta-bubble-body');
      if (pbody) pbody.classList.add('delta-bubble-body--text-only');
    }
  }

  /* Drop the persisted record so the bubble doesn't reappear on the
   * next page load. Sub-bubbles are removed first via the recursive
   * call above, so this single remove() cascades to them all. */
  removePersistedBubble(id);
}

function dismissTopBubble() {
  if (bubbles.size === 0) return;
  /* No z-index anymore (inline bubbles) — fold the most recently created */
  var lastId = null;
  bubbles.forEach(function (entry) {
    if (!entry.folded) lastId = entry.id;
  });
  if (lastId) foldBubble(lastId);
}

/* content.js — runs in every page/frame (all_frames: true).
 * Passively tracks selection/click-coords on contextmenu/mouseup
 * (no preventDefault — native menu still appears).
 * Handles messages from background: expandPromptedFromMenu and expandChunk.
 *
 * Expansion rendering:
 *   - Bubbles are rendered INLINE in the document, embedded into the
 *     surrounding HTML where the selection was made. Text wraps around them.
 *   - Sub-expansions render as nested sub-bubbles inside a parent bubble.
 *   - Right-click on a bubble header (or the marker) FOLDS the bubble back
 *     to a colored inline marker over the original queried text.
 *   - Left-click on a marker RE-EXPANDS the bubble using the cached result
 *     (no new AI call). Recovered sub-bubbles are restored too.
 */

(function () {
  if (window.__deltaExpandInjected) return;
  window.__deltaExpandInjected = true;

  /* ---- State ---- */

  /* Each bubble lifecycle:
   *   {
   *     id:              unique expanded-bubble id,
   *     el:              root bubble element (.delta-bubble),
   *     marker:          folded marker element (.delta-bubble-marker) — set when folded, cleared when expanded,
   *     range:           Range object surrounding the original selection (saved across fold/expand),
   *     data:            { selection, context, prompt } used to (re)issue requests,
   *     responseText:    full streamed response text (cached for re-expand),
   *     children:        Map<childId, childEntry> — tracks sub-bubbles rendered inside this bubble's body,
   *     parent:          parent bubble entry | null,
   *     folded:          boolean
   *   }
   */
  var bubbles = new Map(); // bubbleId -> entry
  var pendingChunks = new Map(); // requestId -> bubbleId (chunks from background)
  var promptInputEl = null;
  var lastClickX = 0;
  var lastClickY = 0;
  var lastExpandData = null;
  var lastSubParentEntry = null; // bubble body whose selection should host the next sub-expand
  var idCounter = 0;

  /* ---- DOM Helpers ---- */

  function removeEl(el) {
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function genId() {
    return 'dx_' + Date.now().toString(36) + '_' + (idCounter++).toString(36);
  }

  /** Walk up from node to nearest block-level ancestor and extract its text. */
  function getSurroundingText(node, maxLen) {
    maxLen = maxLen || 2000;
    var el = node;
    var blockTags = new Set([
      'P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'LI', 'TD', 'TH',
      'BLOCKQUOTE', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BODY'
    ]);
    while (el && el.nodeType !== 1) el = el.parentElement;
    while (el && !blockTags.has(el.tagName) && el !== document.body) {
      el = el.parentElement;
    }
    if (!el) el = document.body;
    var text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (text.length <= maxLen) return text;

    var sel = window.getSelection();
    var selText = sel ? sel.toString().trim() : '';
    var idx = text.indexOf(selText);
    if (idx >= 0) {
      var half = Math.floor(maxLen / 2);
      var start = Math.max(0, idx - half);
      var end = Math.min(text.length, idx + selText.length + half);
      var slice = text.slice(start, end);
      if (start > 0) slice = '\u2026' + slice;
      if (end < text.length) slice = slice + '\u2026';
      return slice;
    }
    return text.slice(0, maxLen) + '\u2026';
  }

  /** Capture current selection text, surrounding context, and a saved Range.
   *  We return a copy of the live Range so it remains valid after the user
   *  selection changes — we use cloneRange() so insertion can still happen
   *  at the original location.
   */
  function captureExpandData() {
    var sel = window.getSelection();
    var text = sel ? sel.toString().trim() : '';
    if (!text || !sel || sel.rangeCount === 0) return null;

    var range = sel.getRangeAt(0).cloneRange();
    var rect = range.getBoundingClientRect();
    var anchor = range.startContainer;
    var context = getSurroundingText(anchor || document.body, 2000);
    if (!context) return null;

    return {
      selection: text,
      context: context,
      range: range,
      rect: {
        left: rect.left,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height
      }
    };
  }

  /* ---- Selection tracking (passive — no preventDefault) ---- */

  document.addEventListener('contextmenu', function (e) {
    lastClickX = e.clientX;
    lastClickY = e.clientY;
    lastExpandData = captureExpandData() || null;
    /* If the click is inside a bubble body, remember that body as parent
     * for any upcoming sub-expand. Otherwise clear.
     */
    var bubbleEl = e.target.closest ? e.target.closest('.delta-bubble') : null;
    if (bubbleEl && !e.target.closest('.delta-bubble-header')) {
      var bid = bubbleEl.getAttribute('data-bubble-id');
      lastSubParentEntry = bubbles.get(bid) || null;
    } else {
      lastSubParentEntry = null;
    }
  }, true);

  document.addEventListener('mouseup', function () {
    setTimeout(function () {
      lastExpandData = captureExpandData() || null;
    }, 0);
  }, true);

  /* ---- Bubble creation ---- */

  /**
   * Wrap the original selection Range with a <span class="delta-bubble-marker">
   * for now, so we have a stable insertion anchor in the live DOM. The actual
   * bubble element replaces the marker when expanded.
   *
   * Returns the marker element if wrapping succeeded (or null if the range
   * is invalid).
   */
  function wrapRangeWithMarker(range) {
    try {
      var marker = document.createElement('span');
      marker.className = 'delta-bubble-marker';
      range.surroundContents(marker);
      return marker;
    } catch (err) {
      // surroundContents throws if the range crosses element boundaries.
      // Fall back to extracting the range nodes into a wrapper.
      try {
        var fragment = range.extractContents();
        var marker2 = document.createElement('span');
        marker2.className = 'delta-bubble-marker';
        marker2.appendChild(fragment);
        range.insertNode(marker2);
        return marker2;
      } catch (err2) {
        return null;
      }
    }
  }

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
      folded: false
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

    var transferBtn = document.createElement('span');
    transferBtn.className = 'delta-bubble-transfer';
    transferBtn.textContent = 'Send to Chat';
    transferBtn.title = 'Send this expansion to the Chat tab';
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
      transferBtn.textContent = 'Sent';
      transferBtn.style.pointerEvents = 'none';
    });

    var close = document.createElement('span');
    close.className = 'delta-bubble-close';
    close.textContent = '\u00d7';
    close.title = 'Close (or right-click to fold)';
    close.addEventListener('click', function (e) {
      e.stopPropagation();
      dismissBubble(id);
    });

    actions.appendChild(transferBtn);
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

    /* Insert: replace marker with bubble, or append to container */
    if (marker && container) {
      container.replaceChild(el, marker);
    } else if (container) {
      container.appendChild(el);
    } else {
      // No marker — last resort, append at end of body
      document.body.appendChild(el);
    }

    entry.el = el;

    /* Register the bubble so chunks can find it */
    bubbles.set(id, entry);
    if (parent) parent.children.set(id, entry);

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
    var marker = document.createElement('span');
    marker.className = 'delta-bubble-marker';
    marker.textContent = entry.data.selection || '';

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
  }

  /**
   * Re-expand: swap the marker back for the cached bubble element (no AI call,
   * no DOM recreation). Nested sub-bubbles that were folded remain as markers
   * inside `entry.el`; clicking them re-expands each via its own marker
   * handler using its cached response.
   */
  function reexpandBubble(id) {
    var entry = bubbles.get(id);
    if (!entry || !entry.folded) return;

    var marker = entry.marker;
    if (!marker || !marker.parentNode) {
      /* Marker lost (e.g. parent fold detached it from the live DOM, leaving
       * it dangling inside the cached parent el). In that case the parent
       * re-expand will re-attach the parent el — and with it this marker —
       * so the user clicks it then and we'll get a real parent node here.
       * For safety, if we have no parent node, we just attach the bubble
       * at end of body. */
      entry.folded = false;
      if (entry.el) document.body.appendChild(entry.el);
      entry.marker = null;
      return;
    }

    var parent = marker.parentNode;
    parent.replaceChild(entry.el, marker);
    entry.marker = null;
    entry.folded = false;

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
    if (entry.parent) entry.parent.children.delete(id);
  }

  /** Replace a marker element with its own child text (i.e., unwrap). */
  function unwrapMarker(marker) {
    if (!marker || !marker.parentNode) return;
    var parent = marker.parentNode;
    while (marker.firstChild) {
      parent.insertBefore(marker.firstChild, marker);
    }
    parent.removeChild(marker);
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

  /* ---- Esc key handler ----
   * Esc folds the top expanded bubble.
   */
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (promptInputEl) {
      removeEl(promptInputEl);
      promptInputEl = null;
      return;
    }
    dismissTopBubble();
  });

  /* ---- Prompt Input ----
   * Renders near the selection; on submit, creates the inline bubble in
   * place of the selection. If a parent bubble body triggered this prompt
   * (sub-expansion), the new bubble appends into that body.
   */
  function showPromptInput(requestId, data, parentEntry) {
    removeEl(promptInputEl);

    var el = document.createElement('div');
    el.id = 'delta-expandPrompt';
    el.style.left = (data.rect.left || lastClickX) + 'px';
    el.style.top = (data.rect.bottom || lastClickY) + 'px';

    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'delta-expand-prompt-input';
    input.placeholder = 'Expand on\u2026';
    input.autocomplete = 'off';

    function submit() {
      var val = (input.value || '').trim();
      removeEl(el);
      promptInputEl = null;

      var fullData = {
        selection: data.selection,
        context: data.context,
        prompt: val || undefined,
        range: data.range
      };

      /* For sub-bubbles: parent entry passes its body as the target container.
       * We still need a marker to anchor at the original selection inside
       * the parent body.
       */
      var marker = null;
      var container = null;
      if (parentEntry) {
        var pbody = parentEntry.el.querySelector('.delta-bubble-body');
        if (pbody && data.range) {
          try {
            marker = wrapRangeWithMarker(data.range);
          } catch (err) {
            marker = null;
          }
          if (!marker) {
            marker = document.createElement('span');
            marker.className = 'delta-bubble-marker';
            marker.textContent = data.selection;
            pbody.appendChild(marker);
          }
          container = pbody;
        }
      } else if (data.range) {
        marker = wrapRangeWithMarker(data.range);
        container = marker ? marker.parentNode : document.body;
      }

      var rid = genId();
      var entry = createBubble({
        range: data.range,
        data: fullData,
        parent: parentEntry,
        marker: marker,
        container: container
      });
      pendingChunks.set(rid, entry.id);

      browser.runtime.sendMessage({
        type: 'expandRequest',
        requestId: rid,
        selection: fullData.selection,
        context: fullData.context,
        prompt: fullData.prompt
      }).catch(function (err) {
        updateBubble(entry.id, 'Failed to send expand request: ' + (err && err.message ? err.message : err), true, true);
      });
    }

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
      if (e.key === 'Escape') {
        removeEl(el);
        promptInputEl = null;
      }
    });

    el.appendChild(input);
    document.body.appendChild(el);
    promptInputEl = el;

    setTimeout(function () { input.focus(); }, 0);

    var onDown = function (e) {
      if (!el.contains(e.target)) {
        removeEl(el);
        promptInputEl = null;
        document.removeEventListener('mousedown', onDown, true);
      }
    };
    document.addEventListener('mousedown', onDown, true);
  }

  /* ---- Message handler ---- */

  browser.runtime.onMessage.addListener(function (msg) {
    if (msg.type === 'expandPromptedFromMenu') {
      var data = lastExpandData;
      if (!data) return;
      var parent = lastSubParentEntry;
      lastSubParentEntry = null;
      showPromptInput(msg.requestId, data, parent);
      return;
    }

    if (msg.type === 'expandChunk') {
      var bubbleId = pendingChunks.get(msg.requestId);
      if (!bubbleId) return;
      if (msg.error) {
        updateBubble(bubbleId, msg.error, msg.done, true);
        if (msg.done) pendingChunks.delete(msg.requestId);
        return;
      }
      updateBubble(bubbleId, msg.text, msg.done, false);
      if (msg.done) pendingChunks.delete(msg.requestId);
      return;
    }
  });

  /* ---- Sub-expansion via context menu inside a bubble body ----
   * We hook 'contextmenu' on each bubble body. If the browser's native
   * menu fires and the user picks "Expand…", the menu event is delivered to
   * the background, which sends expandPromptedFromMenu back with the original
   * lastExpandData — but that gets captured by our top-level listener BEFORE
   * the bubble body listener runs, because we used `true` (capture). To
   * disambiguate sub-expansions, we intercept contextmenu in capture phase on
   * bubble bodies FIRST and stash the parent entry, then let
   * expandPromptedFromMenu pick up the parentEntry.
   *
   * For simplicity and correctness we use a per-body capture listener set at
   * createBubble time below — handled inline via body.addEventListener with
   * capture=true inside createBubble (see body.__deltaParentEntry).
   */

  /* ---- Cleanup on page unload ---- */
  window.addEventListener('unload', function () {
    var pendingIds = [];
    pendingChunks.forEach(function (bid, rid) { pendingIds.push(rid); });
    pendingIds.forEach(function (rid) {
      browser.runtime.sendMessage({ type: 'abort', requestId: rid });
    });
    bubbles.clear();
    pendingChunks.clear();
  });
})();

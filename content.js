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

  /* ---- Per-page persistence ----
   * Every bubble on a page is persisted under (location.href, frameId) so
   * the user gets the same bubbles back when they revisit the page.
   * Content script sends its own URL with every persist/load call; the
   * background script stamps the message with sender.frameId.
   */
  var currentUrl = (typeof location !== 'undefined' && location.href) || '';
  var isRestoring = false; // suppress persist calls during rehydrate

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

  /* ---- XPath anchor serialization ----
   * Build a positional XPath from a given DOM node up to the document root,
   * e.g. /html/body/main/article[2]/p[3]/text()[1]. Returns null if the
   * node is detached or the document is not the ownerDocument.
   */
  /* Build an XPath + offset from a Range's startContainer.
   * Works on both live and detached ranges as long as the startContainer
   * still has a parentNode chain to the document root.
   * Returns { xpath: string, offset: number } or null.
   */
  function buildXPathFromNode(node, offset, fallbackDoc) {
    if (!node) return null;
    try {
      var cur = node;
      var doc = (node.nodeType === 9 ? node : node.ownerDocument) || fallbackDoc;
      if (!doc || !doc.documentElement) return null;
      // If node is a text node but detached, we can still walk up from
      // its element parent if the element is still connected. Bail
      // silently if disconnected.
      var parts = [];
      var startOffset = offset;
      var seenRoot = false;
      while (cur && cur.nodeType !== 9) {
        if (cur.nodeType === 3) {
          var parent = cur.parentNode;
          if (!parent) {
            // Text node is detached. If the range was passed through
            // wrapRangeWithMarker, the element sibling of the marker
            // still has a valid ancestor chain. But there's nothing
            // we can do from a detached text node.
            return null;
          }
          var textIndex = 1;
          var sib = parent.firstChild;
          while (sib && sib !== cur) {
            if (sib.nodeType === 3) textIndex++;
            sib = sib.nextSibling;
          }
          parts.unshift('text()[' + textIndex + ']');
          cur = parent;
        } else if (cur.nodeType === 1) {
          var tag = cur.tagName.toLowerCase();
          var sameTag = 1;
          var ps = cur.previousSibling;
          while (ps) {
            if (ps.nodeType === 1 && ps.tagName === cur.tagName) sameTag++;
            ps = ps.previousSibling;
          }
          parts.unshift(tag + '[' + sameTag + ']');
          cur = cur.parentNode;
        } else {
          break;
        }
        if (cur === doc.documentElement || cur === doc) seenRoot = true;
      }
      if (!seenRoot) return null;
      return { xpath: '/' + parts.join('/'), offset: startOffset };
    } catch (e) {
      return null;
    }
  }

  function buildAnchorXPath(entry) {
    if (!entry || !entry.range) return null;
    return buildXPathFromNode(
      entry.range.startContainer,
      entry.range.startOffset,
      entry.el && entry.el.ownerDocument
    );
  }

  /* Try to resolve an xpath like /html/body/main/article[2]/p[3]/text()[1]
   * against the current document. Returns the matching node or null.
   * The xpath is structural-only, so this works across page loads as long
   * as the surrounding DOM tree is intact.
   */
  function resolveAnchorXPath(xpath) {
    if (!xpath || typeof xpath !== 'string') return null;
    try {
      var result = document.evaluate(
        xpath, document, null,
        XPathResult.FIRST_ORDERED_NODE_TYPE, null
      );
      return result.singleNodeValue || null;
    } catch (e) {
      return null;
    }
  }

  /* Text fallback: walk the document body looking for a text node whose
   * content includes the given selection string. Returns the text node and
   * the character offset where the selection begins within it.
   */
  function findAnchorByText(selection, contextHint) {
    if (!selection || !document.body) return null;
    var needle = String(selection);
    var walker = document.createTreeWalker(document.body, 4 /* SHOW_TEXT */, {
      acceptNode: function (node) {
        var p = node.parentNode;
        while (p) {
          if (p.nodeType === 1 &&
              p.classList &&
              (p.classList.contains('delta-bubble') ||
               p.classList.contains('delta-bubble-marker') ||
               p.classList.contains('delta-adj-hidden'))) {
            return 2; // FILTER_REJECT
          }
          p = p.parentNode;
        }
        return 1; // FILTER_ACCEPT
      }
    });
    var best = null;
    var bestScore = -1;
    var node;
    while ((node = walker.nextNode())) {
      var idx = node.nodeValue ? node.nodeValue.indexOf(needle) : -1;
      if (idx === -1) continue;

      // Score by how much the surrounding block text overlaps with the stored context.
      var score = 0;
      if (contextHint) {
        var blockText = (getSurroundingText(node, 500) || '').toLowerCase();
        var hint = String(contextHint).toLowerCase().slice(0, 500);
        var common = 0;
        var limit = Math.min(blockText.length, hint.length);
        for (var ci = 0; ci < limit; ci++) {
          if (blockText[ci] === hint[ci]) common++;
        }
        score = common / Math.max(blockText.length, 1);
      }

      if (score > bestScore) {
        bestScore = score;
        best = { node: node, offset: idx };
      }

      // If no context hint, or if two nodes tie, prefer the one where the
      // selection text appears earliest (less chance of being a long tail match).
      if (!contextHint && !best) {
        best = { node: node, offset: idx };
      }
    }
    return best;
  }

  /* Build a Range covering exactly `selection.length` characters starting
   * at `textOffset` within the given text node. Returns null on failure.
   */
  function rangeAtTextNode(textNode, selection, textOffset) {
    var len = (selection || '').length;
    if (!textNode || textNode.nodeType !== 3) return null;
    var off = textOffset || 0;
    var cap = Math.min(off + len, textNode.nodeValue.length);
    if (off >= textNode.nodeValue.length) return null;
    var range = document.createRange();
    try {
      range.setStart(textNode, off);
      range.setEnd(textNode, cap);
    } catch (e) {
      return null;
    }
    return range;
  }



  /* ---- Theme detection ----
   * We pick a theme per host page (light vs dark) so our bubbles blend in.
   * Detection priority:
   *   1. The host page's effective body background color (most reliable — it
   *      reflects whatever the page actually rendered).
   *   2. Falls back to `prefers-color-scheme` when the body has a transparent
   *      background (e.g., a page that paints its background on a child
   *      element or via an image we can't easily inspect here).
   *
   * The detected theme is applied once on init via a class on
   * `document.documentElement`. CSS switches the delta-* variables when the
   * class is present. Both existing and future bubbles inherit the variables.
   */

  /** Parse "rgb(r,g,b)" or "rgba(r,g,b,a)" into {r,g,b} or null. */
  function parseRgb(str) {
    if (!str) return null;
    var m = String(str).match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
    if (!m) return null;
    return { r: +m[1], g: +m[2], b: +m[3] };
  }

  /** Relative luminance per Rec. 709 — good enough to pick a theme. */
  function rgbLuminance(rgb) {
    if (!rgb) return null;
    return (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
  }

  /** Walk up from a node to find the first ancestor (including itself) that
   *  has a non-transparent background color. */
  function effectiveBackgroundOf(node) {
    var el = node;
    while (el && el.nodeType === 1) {
      try {
        var bg = window.getComputedStyle(el).backgroundColor;
        var rgb = parseRgb(bg);
        if (rgb && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
          return rgb;
        }
      } catch (e) { /* cross-origin or detached — keep walking */ }
      el = el.parentElement;
    }
    return null;
  }

  /** Returns 'light' or 'dark' based on the host page's theme. */
  function detectPageTheme() {
    try {
      var rgb = effectiveBackgroundOf(document.body) ||
                effectiveBackgroundOf(document.documentElement);
      if (rgb) {
        return rgbLuminance(rgb) > 0.5 ? 'light' : 'dark';
      }
    } catch (e) { /* ignore */ }
    // Fallback: OS preference.
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
      return 'light';
    }
    return 'dark';
  }

  /** Apply the detected theme by toggling a class on <html>. Idempotent. */
  function applyPageTheme() {
    var theme = detectPageTheme();
    var root = document.documentElement;
    if (theme === 'light') {
      root.classList.add('delta-theme-light');
    } else {
      root.classList.remove('delta-theme-light');
    }
  }

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

  document.addEventListener('mouseup', function (e) {
    lastClickX = e.clientX;
    lastClickY = e.clientY;
    lastExpandData = captureExpandData() || null;
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

  /* Whitespace + ASCII/typographic punctuation. If a text node adjacent to
   * a frame contains only these characters (in any order, optionally with
   * leading/trailing whitespace), we collapse it so the frame sits flush
   * against its neighbor text. We never touch alphabetic/digit content. */
  var HIDE_PUNCT_RE = /^[\s\u00a0.,;:!?\u2026\u2014\u2013\-—–'"‘’“”()\[\]{}<>\/\\|@#\$%\^&\*_+=`~]*$/;

  /** If the given text node contains only punctuation/whitespace, wrap it in
   *  a hidden span so the frame flush-mates with its surrounding text. The
   *  wrap is reversible: we restore the original text node when adjacent
   *  punctuation is no longer applicable (e.g., on dismiss). */
  function hideIfPunctuationOnly(textNode) {
    if (!textNode || textNode.nodeType !== 3) return;
    if (textNode.parentNode && textNode.parentNode.classList &&
        textNode.parentNode.classList.contains('delta-adj-hidden')) {
      return; // already wrapped
    }
    var txt = textNode.nodeValue;
    if (!txt) return;
    if (HIDE_PUNCT_RE.test(txt) && /\S/.test(txt)) {
      var wrapper = document.createElement('span');
      wrapper.className = 'delta-adj-hidden';
      textNode.parentNode.insertBefore(wrapper, textNode);
      wrapper.appendChild(textNode);
    }
  }

  /** Reverse of hideIfPunctuationOnly: unwrap a single hidden span if present. */
  function unhideIfWrapped(textNode) {
    var parent = textNode && textNode.parentNode;
    if (parent && parent.classList && parent.classList.contains('delta-adj-hidden')) {
      var grand = parent.parentNode;
      if (!grand) return;
      grand.insertBefore(textNode, parent);
      if (!parent.firstChild) grand.removeChild(parent);
    }
  }

  /** Scan the text-node siblings immediately before and after `el` and hide
   *  them if they contain only punctuation. Operates within a single parent
   *  so it doesn't cross element boundaries. */
  function hideAdjacentPunctuation(el) {
    if (!el || !el.parentNode) return;
    var prev = el.previousSibling;
    if (prev && prev.nodeType === 3) hideIfPunctuationOnly(prev);
    var next = el.nextSibling;
    if (next && next.nodeType === 3) hideIfPunctuationOnly(next);
  }

  /** Restore any hidden adjacent punctuation around the given element.
   *  Called on dismiss so we don't strand wrapped text nodes. */
  function restoreAdjacentPunctuation(el) {
    if (!el || !el.parentNode) return;
    var prev = el.previousSibling;
    if (prev && prev.nodeType === 3) unhideIfWrapped(prev);
    var next = el.nextSibling;
    if (next && next.nodeType === 3) unhideIfWrapped(next);
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
    marker.innerHTML = '<span style="font-size:0.85em;color:' + markerTriangle + ';margin-right:3px;">\u25B8</span>';
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
    // Set position and z-index inline — the content CSS may not always apply
    // (same scoping issue that affected .delta-bubble-marker).
    el.style.cssText =
      'position:fixed;' +
      'z-index:2147483647;' +
      'background:var(--delta-surface-2,#2c2d36);' +
      'border:1px solid var(--delta-accent,#8aa0b8);' +
      'border-radius:6px;' +
      'box-shadow:0 4px 14px rgba(0,0,0,0.18);' +
      'padding:6px 10px;' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;';

    // Position at the live selection's end so the input appears just below
    // the text the user selected.
    var posLeft = 0;
    var posTop = 0;
    try {
      var liveSel = window.getSelection();
      if (liveSel && liveSel.rangeCount > 0) {
        var liveRect = liveSel.getRangeAt(0).getBoundingClientRect();
        if (liveRect && liveRect.width > 0 && liveRect.height > 0) {
          posLeft = liveRect.left;
          posTop = liveRect.bottom;
        }
      }
    } catch (e) { /* ignore */ }

    // Fallback to captured rect from lastExpandData
    if (posTop <= 0 && data && data.rect) {
      if (data.rect.left != null) posLeft = data.rect.left;
      if (data.rect.bottom != null) posTop = data.rect.bottom;
    }
    // Last resort: click coordinates
    if (posTop <= 0) { posLeft = lastClickX || 0; posTop = lastClickY || 0; }

    el.style.left = posLeft + 'px';
    el.style.top = posTop + 'px';
    el.style.left = posLeft + 'px';
    el.style.top = posTop + 'px';

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
      var savedXpath = null;
      if (parentEntry) {
        var pbody = parentEntry.el.querySelector('.delta-bubble-body');
        if (pbody && data.range) {
          savedXpath = buildXPathFromNode(data.range.startContainer, data.range.startOffset, document);
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
          container = marker && marker.parentNode ? marker.parentNode : pbody;
        }
      } else if (data.range) {
        savedXpath = buildXPathFromNode(data.range.startContainer, data.range.startOffset, document);
        marker = wrapRangeWithMarker(data.range);
        container = marker ? marker.parentNode : document.body;
      }

      var rid = genId();
      var entry = createBubble({
        range: data.range,
        data: fullData,
        parent: parentEntry,
        marker: marker,
        container: container,
        _savedXpath: savedXpath
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

  /* ---- Rehydrate bubbles from storage on init ----
   * On content script start, ask the background for any persisted bubbles
   * for this (url, frameId). Re-anchor them in the DOM in tree order:
   * top-level bubbles first, then their sub-bubbles. Set the response
   * text directly so no streaming round-trip is needed.
   *
   * isRestoring suppresses the persist hooks inside createBubble etc. so
   * we don't write what we just read.
   */
  var pendingFolds = [];

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

  /* ---- Init: apply theme + re-apply on visibility/page-show ----
   * The content script runs at document_idle so the page is already painted
   * by the time we read backgroundColor. We also re-apply on `pageshow` for
   * bfcache restores and on `visibilitychange` in case the OS theme changed
   * while the tab was hidden. */
  applyPageTheme();
  window.addEventListener('pageshow', applyPageTheme);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') applyPageTheme();
  });

  /* ---- SPA route handling ----
   * Many sites (React, Vue, etc.) navigate via history.pushState/replaceState
   * without a full page reload. We monkey-patch those to detect route
   * changes, and also listen for popstate (back/forward). On route change
   * we update currentUrl and re-anchor bubbles for the new URL.
   *
   * Old bubbles are left in their previous storage key — abandoned, not
   * migrated. They expire after 30 days.
   */
  function onRouteChange() {
    var newUrl = (typeof location !== 'undefined' && location.href) || '';
    if (newUrl === currentUrl) return;
    currentUrl = newUrl;
    rehydrateFromStorage();
  }

  (function patchHistory() {
    if (!window.history) return;
    var origPush = window.history.pushState;
    var origReplace = window.history.replaceState;
    if (typeof origPush === 'function') {
      window.history.pushState = function () {
        var rv = origPush.apply(this, arguments);
        onRouteChange();
        return rv;
      };
    }
    if (typeof origReplace === 'function') {
      window.history.replaceState = function () {
        var rv = origReplace.apply(this, arguments);
        onRouteChange();
        return rv;
      };
    }
    window.addEventListener('popstate', onRouteChange);
  })();

  rehydrateFromStorage();

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

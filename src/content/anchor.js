/* ---- XPath anchor serialization ----
 * Build a positional XPath from a given DOM node up to the document root,
 * e.g. /html/body/main/article[2]/p[3]/text()[1]. Returns null if the
 * node is detached or the document is not the ownerDocument.
 */

/* Whitespace + ASCII/typographic punctuation. If a text node adjacent to
 * a frame contains only these characters (in any order, optionally with
 * leading/trailing whitespace), we collapse it so the frame sits flush
 * against its neighbor text. We never touch alphabetic/digit content. */
var HIDE_PUNCT_RE = /^[\s\u00a0.,;:!?\u2026\u2014\u2013\-—–'"‘’“”()\[\]{}<>\/\\|@#\$%\^&\*_+=`~]*$/;

/** Replace a marker element with its own child text (i.e., unwrap). */
function unwrapMarker(marker) {
  if (!marker || !marker.parentNode) return;
  var parent = marker.parentNode;
  while (marker.firstChild) {
    parent.insertBefore(marker.firstChild, marker);
  }
  parent.removeChild(marker);
}

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

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

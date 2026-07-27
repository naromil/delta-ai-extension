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

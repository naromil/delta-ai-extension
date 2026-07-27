/* Initialization and event wiring for the content script.
 * Called once from content.js after the double-injection guard passes.
 * All event listeners, theme init, SPA routing, and cleanup go here.
 */
function initContentScript() {

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

  /* ---- Esc key handler ---- */

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (promptInputEl) {
      removeEl(promptInputEl);
      promptInputEl = null;
      return;
    }
    dismissTopBubble();
  });

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

  /* ---- Theme init ----
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

}

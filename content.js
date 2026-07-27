/* content.js — Entry point for content script.
 * Module files in src/content/ are loaded first (state, utilities,
 * business logic), then this file guards against double injection
 * and kicks off initialization.
 */
(function () {
  if (window.__deltaExpandInjected) return;
  window.__deltaExpandInjected = true;
  if (typeof initContentScript === 'function') {
    initContentScript();
  }
})();

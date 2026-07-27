/* Shared state for content script modules.
 * Uses window.__deltaStateLoaded guard to prevent re-initialization
 * if the script list somehow runs twice (defensive).
 */
if (!window.__deltaStateLoaded) {
  window.__deltaStateLoaded = true;

  var bubbles = new Map(); // bubbleId -> entry
  var pendingChunks = new Map(); // requestId -> bubbleId (chunks from background)
  var promptInputEl = null;
  var lastClickX = 0;
  var lastClickY = 0;
  var lastExpandData = null;
  var lastSubParentEntry = null; // bubble body whose selection should host the next sub-expand
  var idCounter = 0;
  var currentUrl = (typeof location !== 'undefined' && location.href) || '';
  var isRestoring = false;
  var pendingFolds = [];
}

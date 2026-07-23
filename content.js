/* content.js — runs in every page/frame (all_frames: true).
 * Passively tracks selection/click-coords on contextmenu/mouseup
 * (no preventDefault — native menu still appears).
 * Handles messages from background: expandFromMenu, expandPromptedFromMenu,
 * and expandChunk.
 */

(function () {
  if (window.__deltaExpandInjected) return;
  window.__deltaExpandInjected = true;

  /* ---- State ---- */

  let popupEl = null;
  let promptInputEl = null;
  let activeRequestId = null;
  let lastClickX = 0;
  let lastClickY = 0;
  let lastExpandData = null;
  // lastExpandData: { selection, context, rect: { left, top, bottom, width, height } } | null

  /* ---- DOM Helpers ---- */

  function removeEl(el) {
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  /** Walk up from node to nearest block-level ancestor and extract its text. */
  function getSurroundingText(node, maxLen) {
    maxLen = maxLen || 2000;
    let el = node;
    const blockTags = new Set([
      'P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'LI', 'TD', 'TH',
      'BLOCKQUOTE', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BODY'
    ]);
    while (el && el.nodeType !== 1) el = el.parentElement;
    while (el && !blockTags.has(el.tagName) && el !== document.body) {
      el = el.parentElement;
    }
    if (!el) el = document.body;
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (text.length <= maxLen) return text;

    const sel = window.getSelection();
    const selText = sel ? sel.toString().trim() : '';
    const idx = text.indexOf(selText);
    if (idx >= 0) {
      const half = Math.floor(maxLen / 2);
      const start = Math.max(0, idx - half);
      const end = Math.min(text.length, idx + selText.length + half);
      let slice = text.slice(start, end);
      if (start > 0) slice = '\u2026' + slice;
      if (end < text.length) slice = slice + '\u2026';
      return slice;
    }
    return text.slice(0, maxLen) + '\u2026';
  }

  /** Capture current selection text, surrounding context, and bounding rect. */
  function captureExpandData() {
    const sel = window.getSelection();
    const text = sel ? sel.toString().trim() : '';
    if (!text || !sel || sel.rangeCount === 0) return null;

    const range = sel.getRangeAt(0).cloneRange();
    const rect = range.getBoundingClientRect();
    const anchor = range.startContainer;
    const context = getSurroundingText(anchor || document.body, 2000);
    if (!context) return null;

    return {
      selection: text,
      context,
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
  }, true);

  document.addEventListener('mouseup', function () {
    setTimeout(function () {
      lastExpandData = captureExpandData() || null;
    }, 0);
  }, true);

  /* ---- Popup ---- */

  function createPopup(rect, requestId) {
    dismissPopup();

    const el = document.createElement('div');
    el.id = 'delta-popup';
    el.setAttribute('data-request-id', requestId);
    el.innerHTML =
      '<div class="delta-popup-header"><span class="delta-popup-title">Expand</span><span class="delta-popup-close">&times;</span></div>' +
      '<div class="delta-popup-body">Thinking\u2026</div>';

    function positionPopup() {
      var pad = 8;
      var left = rect.left + window.scrollX;
      var top = rect.bottom + window.scrollY + pad;
      var maxW = Math.min(420, window.innerWidth - 16);

      if (left + maxW > window.scrollX + window.innerWidth - pad) {
        left = Math.max(pad, window.scrollX + window.innerWidth - maxW - pad);
      }
      if (left < window.scrollX + pad) left = window.scrollX + pad;

      if (top + el.offsetHeight > window.scrollY + window.innerHeight - pad) {
        top = rect.top + window.scrollY - el.offsetHeight - pad;
      }
      if (top < window.scrollY + pad) top = window.scrollY + pad;

      el.style.left = left + 'px';
      el.style.top = top + 'px';
    }

    document.body.appendChild(el);
    positionPopup();
    popupEl = el;

    el.querySelector('.delta-popup-close').addEventListener('click', function () {
      dismissPopup();
    });

    var onDown = function (e) {
      if (!el.contains(e.target)) {
        dismissPopup();
        document.removeEventListener('mousedown', onDown, true);
      }
    };
    document.addEventListener('mousedown', onDown, true);

    return el;
  }

  function updatePopup(text, done, error) {
    if (!popupEl) return;
    var body = popupEl.querySelector('.delta-popup-body');
    if (!body) return;
    if (error) {
      body.className = 'delta-popup-body delta-error';
      body.textContent = text || error;
    } else {
      body.className = 'delta-popup-body';
      body.textContent = text || '\u200b';
    }
  }

  function dismissPopup() {
    if (activeRequestId) {
      browser.runtime.sendMessage({ type: 'abort', requestId: activeRequestId });
      activeRequestId = null;
    }
    removeEl(popupEl);
    popupEl = null;
  }

  /* ---- Prompt Input ---- */

  function showPromptInput(requestId, data) {
    dismissPopup();
    removeEl(promptInputEl);

    var el = document.createElement('div');
    el.id = 'delta-expandPrompt';
    el.style.left = lastClickX + 'px';
    el.style.top = lastClickY + 'px';

    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'delta-expand-prompt-input';
    input.placeholder = 'Expand on\u2026';
    input.autocomplete = 'off';

    function submit() {
      var val = (input.value || '').trim();
      removeEl(el);
      promptInputEl = null;

      createPopup(data.rect, requestId);
      activeRequestId = requestId;
      browser.runtime.sendMessage({
        type: 'expandRequest',
        requestId: requestId,
        selection: data.selection,
        context: data.context,
        prompt: val || undefined
      }).catch(function (err) {
        updatePopup('Failed to send expand request: ' + (err && err.message ? err.message : err), true, true);
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
    if (msg.type === 'expandFromMenu') {
      var data = lastExpandData;
      if (!data) return;
      createPopup(data.rect, msg.requestId);
      activeRequestId = msg.requestId;
      browser.runtime.sendMessage({
        type: 'expandRequest',
        requestId: msg.requestId,
        selection: data.selection,
        context: data.context
      }).catch(function (err) {
        updatePopup('Failed to send expand request: ' + (err && err.message ? err.message : err), true, true);
      });
      return;
    }

    if (msg.type === 'expandPromptedFromMenu') {
      var data = lastExpandData;
      if (!data) return;
      showPromptInput(msg.requestId, data);
      return;
    }

    if (msg.type === 'expandChunk') {
      if (msg.requestId !== activeRequestId) return;
      updatePopup(msg.text, msg.done, msg.error);
      return;
    }
  });
})();

/* content.js — runs in every page/frame (all_frames: true).
 * Passively tracks selection/click-coords on contextmenu/mouseup
 * (no preventDefault — native menu still appears).
 * Handles messages from background: expandPromptedFromMenu and expandChunk.
 * Supports multiple coexisting popups (infinitely recursive expand).
 * Popups close only via Esc key or close button (no blur dismissal).
 */

(function () {
  if (window.__deltaExpandInjected) return;
  window.__deltaExpandInjected = true;

  /* ---- State ---- */

  var popups = new Map(); // requestId -> { el: HTMLElement }
  var popupResponseText = new Map(); // requestId -> full response text
  var promptInputEl = null;
  var lastClickX = 0;
  var lastClickY = 0;
  var lastExpandData = null;
  var popupCounter = 0;

  /* ---- DOM Helpers ---- */

  function removeEl(el) {
    if (el && el.parentNode) el.parentNode.removeChild(el);
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

  /** Capture current selection text, surrounding context, and bounding rect. */
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

  /* ---- Multiple Popups ---- */

  function createPopup(rect, requestId, expandData) {
    popupCounter++;

    var el = document.createElement('div');
    el.className = 'delta-popup';
    el.id = 'delta-popup-' + requestId;
    el.setAttribute('data-request-id', requestId);

    var header = document.createElement('div');
    header.className = 'delta-popup-header';
    var title = document.createElement('span');
    title.className = 'delta-popup-title';
    title.textContent = 'Expand';
    var transferBtn = document.createElement('span');
    transferBtn.className = 'delta-popup-transfer';
    transferBtn.textContent = 'Send to Chat';
    transferBtn.title = 'Send this expansion to the Chat tab';
    transferBtn.style.display = 'none';
    transferBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var data = expandData || {};
      var responseText = popupResponseText.get(requestId) || '';
      browser.runtime.sendMessage({
        type: 'transferExpansion',
        selection: data.selection || '',
        context: data.context || '',
        prompt: data.prompt || '',
        response: responseText
      });
      transferBtn.textContent = 'Sent';
      transferBtn.style.pointerEvents = 'none';
    });
    var close = document.createElement('span');
    close.className = 'delta-popup-close';
    close.textContent = '\u00d7';
    close.addEventListener('click', function () {
      dismissPopup(requestId);
    });
    header.appendChild(title);
    header.appendChild(transferBtn);
    header.appendChild(close);
    el.appendChild(header);

    var body = document.createElement('div');
    body.className = 'delta-popup-body';
    body.textContent = 'Thinking\u2026';
    el.appendChild(body);

    /* Position with stacking offset */
    var offset = (popupCounter - 1) * 20;
    var pad = 8;
    var left = rect.left + offset;
    var top = rect.bottom + offset + pad;
    var maxW = Math.min(420, window.innerWidth - 16);

    if (left + maxW > window.innerWidth - pad) {
      left = Math.max(pad, window.innerWidth - maxW - pad);
    }
    if (left < pad) left = pad;

    /* Append off-screen, measure height, then finalize position */
    el.style.position = 'fixed';
    el.style.left = '-9999px';
    el.style.top = '-9999px';
    el.style.maxWidth = maxW + 'px';
    document.body.appendChild(el);

    var popupH = el.offsetHeight;
    if (top + popupH > window.innerHeight - pad) {
      top = Math.max(pad, rect.top - popupH - pad);
    }
    if (top < pad) top = pad;
    el.style.left = left + 'px';
    el.style.top = top + 'px';
    el.style.zIndex = 2147483646 + popupCounter;

    popups.set(requestId, { el: el });

    return el;
  }

  function updatePopup(requestId, text, done, error) {
    var entry = popups.get(requestId);
    if (!entry) return;
    var body = entry.el.querySelector('.delta-popup-body');
    if (!body) return;
    if (error) {
      body.className = 'delta-popup-body delta-error';
      body.textContent = text || error;
    } else {
      body.className = 'delta-popup-body';
      body.textContent = text || '\u200b';
      popupResponseText.set(requestId, text || '');
    }
    if (done) {
      var transferBtn = entry.el.querySelector('.delta-popup-transfer');
      if (transferBtn) transferBtn.style.display = '';
    }
  }

  function dismissPopup(requestId) {
    var entry = popups.get(requestId);
    if (!entry) return;
    browser.runtime.sendMessage({ type: 'abort', requestId: requestId });
    removeEl(entry.el);
    popups.delete(requestId);
    popupResponseText.delete(requestId);
  }

  function dismissTopPopup() {
    if (popups.size === 0) return;
    var topId = null;
    var topZ = -1;
    popups.forEach(function (entry, id) {
      var z = parseInt(entry.el.style.zIndex) || 0;
      if (z > topZ) {
        topZ = z;
        topId = id;
      }
    });
    if (topId) dismissPopup(topId);
  }

  /* ---- Esc key handler ---- */

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (promptInputEl) {
      removeEl(promptInputEl);
      promptInputEl = null;
      return;
    }
    dismissTopPopup();
  });

  /* ---- Prompt Input ---- */

  function showPromptInput(requestId, data) {
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

      requestId = crypto.randomUUID();
      createPopup(data.rect, requestId, {
        selection: data.selection,
        context: data.context,
        prompt: val || undefined
      });
      browser.runtime.sendMessage({
        type: 'expandRequest',
        requestId: requestId,
        selection: data.selection,
        context: data.context,
        prompt: val || undefined
      }).catch(function (err) {
        updatePopup(requestId, 'Failed to send expand request: ' + (err && err.message ? err.message : err), true, true);
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
      showPromptInput(msg.requestId, data);
      return;
    }

    if (msg.type === 'expandChunk') {
      var entry = popups.get(msg.requestId);
      if (!entry) return;
      if (msg.error) {
        updatePopup(msg.requestId, msg.error, msg.done, true);
        return;
      }
      updatePopup(msg.requestId, msg.text, msg.done, false);
      return;
    }
  });

  /* ---- Cleanup on page unload ---- */
  window.addEventListener('unload', function () {
    popups.forEach(function (entry, id) {
      browser.runtime.sendMessage({ type: 'abort', requestId: id });
    });
    popups.clear();
  });
})();

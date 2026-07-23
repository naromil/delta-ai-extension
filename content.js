/* content.js — runs in every page, intercepts right-click,
 * renders custom context menu, expand prompt, and inline popup overlay.
 */

(function () {
  if (window.__deltaExpandInjected) return;
  window.__deltaExpandInjected = true;

  /* ---- State ---- */

  let popupEl = null;
  let ctxMenuEl = null;
  let promptInputEl = null;
  let activeRequestId = null;

  /** Last contextmenu data captured before the menu appeared. */
  let pendingExpand = null;
  // shape: { text, rect: {x,y,width,height}, context, range: Range, x, y }

  let cachedPopups = {}; // requestId -> { text, rect }

  /* ---- Helpers ---- */

  let reqCtr = 0;
  function genRequestId() {
    return 'rx_' + Date.now() + '_' + (reqCtr++);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /** Walk up from node to find nearest block-level ancestor and extract its text. */
  function getSurroundingText(node, maxLen) {
    maxLen = maxLen || 2000;
    // Walk up to find a block-level container
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
    // Truncate around the selection
    const sel = window.getSelection();
    const selText = sel ? sel.toString().trim() : '';
    const idx = text.indexOf(selText);
    if (idx >= 0) {
      const half = Math.floor(maxLen / 2);
      const start = Math.max(0, idx - half);
      const end = Math.min(text.length, idx + selText.length + half);
      let slice = text.slice(start, end);
      if (start > 0) slice = '…' + slice;
      if (end < text.length) slice = slice + '…';
      return slice;
    }
    return text.slice(0, maxLen) + '…';
  }

  /** Detect the word at (clientX, clientY) when there's no text selection. */
  function getWordAtPoint(x, y) {
    if (document.caretRangeFromPoint) {
      const cr = document.caretRangeFromPoint(x, y);
      if (!cr || !cr.startContainer) return null;
      const node = cr.startContainer;
      if (node.nodeType !== Node.TEXT_NODE || !node.textContent) return null;

      // Expand to word boundaries
      const text = node.textContent;
      let start = cr.startOffset;
      let end = start;
      const wordRe = /[\w\u00C0-\u024F'-]/;
      while (start > 0 && wordRe.test(text[start - 1])) start--;
      while (end < text.length && wordRe.test(text[end])) end++;
      if (start === end) return null;

      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, end);
      return {
        text: range.toString(),
        rect: range.getBoundingClientRect(),
        node: node
      };
    }
    // Fallback for browsers without caretRangeFromPoint
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    const textNode = el.childNodes[0];
    if (!textNode || textNode.nodeType !== Node.TEXT_NODE || !textNode.textContent) return null;
    const words = textNode.textContent.trim().split(/\s+/);
    if (words.length === 0) return null;
    return {
      text: words[0],
      rect: el.getBoundingClientRect(),
      node: textNode
    };
  }

  /* ---- DOM Utilities ---- */

  function removeEl(el) {
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function dismissAll() {
    removeEl(ctxMenuEl);
    ctxMenuEl = null;
    removeEl(promptInputEl);
    promptInputEl = null;
    pendingExpand = null;
  }

  function dismissPopup() {
    if (popupEl) {
      if (activeRequestId && popupEl.querySelector('.delta-popup-body')?.textContent) {
        cachedPopups[activeRequestId] = {
          text: popupEl.querySelector('.delta-popup-body').textContent || '',
          rect: pendingExpand ? pendingExpand.rect : null
        };
      }
      browser.runtime.sendMessage({ type: 'abort', requestId: activeRequestId });
      activeRequestId = null;
      removeEl(popupEl);
      popupEl = null;
    }
  }

  /* ---- Context Menu ---- */

  function createCtxMenu(state) {
    dismissAll();

    const el = document.createElement('div');
    el.id = 'delta-ctxMenu';
    el.style.left = state.x + 'px';
    el.style.top = state.y + 'px';

    function item(label, action, disabled) {
      const div = document.createElement('div');
      div.className = 'delta-item' + (disabled ? ' delta-disabled' : '');
      div.textContent = label;
      if (!disabled) {
        div.addEventListener('mousedown', (e) => {
          e.preventDefault();
          e.stopPropagation();
          action();
          removeEl(el);
        });
      }
      el.appendChild(div);
    }

    function sep() {
      const div = document.createElement('div');
      div.className = 'delta-sep';
      el.appendChild(div);
    }

    item('Expand', state.onExpand, !state.canExpand);
    item('Expand on\u2026', state.onExpandPrompted, !state.canExpand);
    sep();
    item('Copy', state.onCopy, false);

    document.body.appendChild(el);
    ctxMenuEl = el;

    // Close on outside click
    const onDown = (e) => {
      if (!el.contains(e.target)) {
        removeEl(el);
        ctxMenuEl = null;
        document.removeEventListener('mousedown', onDown, true);
      }
    };
    document.addEventListener('mousedown', onDown, true);
    // Close on escape
    const onKey = (e) => {
      if (e.key === 'Escape') {
        removeEl(el);
        ctxMenuEl = null;
        document.removeEventListener('keydown', onKey);
      }
    };
    document.addEventListener('keydown', onKey);
  }

  /* ---- Expand Prompt Input ---- */

  function createPromptInput(x, y, onSubmit) {
    dismissAll();
    removeEl(promptInputEl);

    const el = document.createElement('div');
    el.id = 'delta-expandPrompt';
    el.style.left = x + 'px';
    el.style.top = y + 'px';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'delta-expand-prompt-input';
    input.placeholder = 'Expand on\u2026';
    input.autocomplete = 'off';

    function submit() {
      const val = input.value || '';
      onSubmit(val);
      removeEl(el);
      promptInputEl = null;
    }

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      }
      if (e.key === 'Escape') {
        removeEl(el);
        promptInputEl = null;
      }
    });

    el.appendChild(input);
    document.body.appendChild(el);
    promptInputEl = el;

    setTimeout(() => input.focus(), 0);

    // Close on outside click
    const onDown = (e) => {
      if (!el.contains(e.target)) {
        removeEl(el);
        promptInputEl = null;
        document.removeEventListener('mousedown', onDown, true);
      }
    };
    document.addEventListener('mousedown', onDown, true);
  }

  /* ---- Inline Popup ---- */

  function createPopup(rect, requestId) {
    dismissPopup();

    const el = document.createElement('div');
    el.id = 'delta-popup';
    el.setAttribute('data-request-id', requestId);
    el.innerHTML =
      '<div class="delta-popup-header"><span class="delta-popup-title">Expand</span><span class="delta-popup-close">&times;</span></div>' +
      '<div class="delta-popup-body">Thinking\u2026</div>';

    function position() {
      const padding = 8;
      let left = rect.left + window.scrollX;
      let top = rect.bottom + window.scrollY + padding;

      const elH = el.offsetHeight;
      const winW = window.innerWidth;
      const winH = window.innerHeight;

      // Keep within viewport horizontally
      if (left + 320 > winW) left = Math.max(8, winW - 320);
      if (left < 8) left = 8;

      // Flip above if below viewport
      if (top + elH > window.scrollY + winH - padding) {
        top = rect.top + window.scrollY - elH - padding;
      }
      if (top < window.scrollY + padding) top = window.scrollY + padding;

      el.style.left = left + 'px';
      el.style.top = top + 'px';
    }

    document.body.appendChild(el);
    position();
    popupEl = el;

    // Close button
    el.querySelector('.delta-popup-close').addEventListener('click', () => {
      dismissPopup();
    });

    // Click outside to close
    const onDown = (e) => {
      if (!el.contains(e.target) && !(ctxMenuEl && ctxMenuEl.contains(e.target))) {
        dismissPopup();
        document.removeEventListener('mousedown', onDown, true);
      }
    };
    document.addEventListener('mousedown', onDown, true);

    return el;
  }

  function updatePopup(text, done, error) {
    if (!popupEl) return;
    const body = popupEl.querySelector('.delta-popup-body');
    if (!body) return;
    if (error) {
      body.className = 'delta-popup-body delta-error';
      body.textContent = text || error;
    } else {
      body.className = 'delta-popup-body';
      body.textContent = text || '\u200b'; // zero-width space to prevent empty collapse
    }
  }

  /* ---- Selection Capturing ---- */

  function captureSelection(e) {
    const sel = window.getSelection();
    let text = sel ? sel.toString().trim() : '';
    let range = null;
    let rect = null;
    let anchorNode = null;

    if (text && sel && sel.rangeCount > 0) {
      // Check if click is within the selection range
      const clickEl = document.elementFromPoint(e.clientX, e.clientY);
      let isInSelection = false;
      for (let i = 0; i < sel.rangeCount; i++) {
        const r = sel.getRangeAt(i);
        if (r.intersectsNode(clickEl)) {
          isInSelection = true;
          range = r;
          break;
        }
      }
      if (!isInSelection) {
        // Clear selection if click is outside
        text = '';
        range = null;
      } else {
        if (!range) {
          range = sel.getRangeAt(0).cloneRange();
        }
        rect = range.getBoundingClientRect();
        anchorNode = range.startContainer;
      }
    }

    // Fallback: word under cursor
    if (!text) {
      const word = getWordAtPoint(e.clientX, e.clientY);
      if (word) {
        text = word.text;
        rect = word.rect;
        anchorNode = word.node;
      }
    }

    if (!text || !rect) return null;

    // Get surrounding context
    const context = getSurroundingText(anchorNode || document.body, 2000);

    return { text, rect, context, range };
  }

  /* ---- Expand action ---- */

  async function doExpand(data, prompt) {
    const requestId = genRequestId();
    activeRequestId = requestId;

    // Create the popup
    createPopup(data.rect, requestId);

    // Send to background
    browser.runtime.sendMessage({
      type: 'expand',
      selection: data.text,
      context: data.context,
      prompt: prompt || undefined,
      requestId: requestId,
      role: 'lookup'
    });
  }

  function doCopy(text) {
    navigator.clipboard.writeText(text).catch(() => {
      // Fallback: use a textarea
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    });
  }

  /* ---- Event: Context Menu ---- */

  function handleContextMenu(e) {
    const data = captureSelection(e);
    if (!data) return; // Let browser show native menu
    pendingExpand = data;

    e.preventDefault();
    e.stopPropagation();

    const ctxState = {
      x: e.clientX,
      y: e.clientY,
      canExpand: true,
      onExpand() {
        const d = pendingExpand;
        pendingExpand = null;
        if (d) doExpand(d);
      },
      onExpandPrompted() {
        const d = pendingExpand;
        pendingExpand = null;
        if (!d) return;
        createPromptInput(e.clientX, e.clientY, (prompt) => {
          doExpand(d, prompt);
        });
      },
      onCopy() {
        const text = data.text;
        pendingExpand = null;
        if (text) doCopy(text);
      }
    };

    createCtxMenu(ctxState);
  }

  document.addEventListener('contextmenu', handleContextMenu, true);

  /* ---- Message listener (chunks from background) ---- */

  browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'expandChunk') {
      if (msg.requestId !== activeRequestId) {
        // Result for a different request — ignore or cache
        return;
      }
      if (popupEl) {
        updatePopup(msg.text, msg.done, msg.error);
      }
    }
  });
})();

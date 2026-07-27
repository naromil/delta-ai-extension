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

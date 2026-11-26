(function () {
  if (window.__ibInjected) return;
  window.__ibInjected = true;

  let overlay, selBox, hint;
  let startX, startY, dragging = false;

  function removeUI() {
    [overlay, selBox, hint].forEach(el => el && el.remove());
    overlay = selBox = hint = null;
  }

  function startCapture() {
    removeUI();
    overlay = document.createElement('div'); overlay.id = 'ib-overlay';
    selBox  = document.createElement('div'); selBox.id  = 'ib-selection';
    ['tl','tr','bl','br'].forEach(c => {
      const s = document.createElement('span');
      s.className = `ib-corner ib-corner-${c}`;
      selBox.appendChild(s);
    });
    hint    = document.createElement('div'); hint.id    = 'ib-hint';
    hint.textContent = '🖱  Drag to select area  •  ESC to cancel';
    document.body.append(overlay, selBox, hint);
    overlay.addEventListener('mousedown', onDown);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
    document.addEventListener('keydown',   onKey);
  }

  function onKey(e) { if (e.key === 'Escape') { removeUI(); cleanup(); } }

  function onDown(e) {
    dragging = true; startX = e.clientX; startY = e.clientY;
    Object.assign(selBox.style, { left: startX+'px', top: startY+'px', width: '0', height: '0', display: 'block' });
  }

  function onMove(e) {
    if (!dragging) return;
    selBox.style.left   = Math.min(e.clientX, startX) + 'px';
    selBox.style.top    = Math.min(e.clientY, startY) + 'px';
    selBox.style.width  = Math.abs(e.clientX - startX) + 'px';
    selBox.style.height = Math.abs(e.clientY - startY) + 'px';
  }

  function onUp(_e) {
    if (!dragging) return; dragging = false; cleanup();
    const rect = {
      x: parseInt(selBox.style.left), y: parseInt(selBox.style.top),
      w: parseInt(selBox.style.width), h: parseInt(selBox.style.height)
    };
    removeUI();
    if (rect.w < 10 || rect.h < 10) {
      // Mobile tap / single click — capture the element at that point
      const el = document.elementFromPoint(startX, startY);
      if (!el || el === document.body || el === document.documentElement) return;
      const b = el.getBoundingClientRect();
      if (b.width < 5 || b.height < 5) return;
      rect.x = Math.round(b.left);
      rect.y = Math.round(b.top);
      rect.w = Math.round(b.width);
      rect.h = Math.round(b.height);
    }
    let logs = [], events = [], requests = [];
    try {
      const bridge = document.getElementById('__mdev_bridge');
      if (bridge) {
        logs     = JSON.parse(bridge.getAttribute('data-logs')     || '[]');
        events   = JSON.parse(bridge.getAttribute('data-events')   || '[]');
        requests = JSON.parse(bridge.getAttribute('data-requests') || '[]');
      }
    } catch {}
    chrome.runtime.sendMessage({
      type: 'CAPTURE_AREA',
      rect,
      dpr: window.devicePixelRatio || 1,
      url: window.location.href,
      title: document.title,
      logs,
      events,
      requests
    });
  }

  function cleanup() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup',   onUp);
    document.removeEventListener('keydown',   onKey);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'START_CAPTURE') startCapture();
  });
})();

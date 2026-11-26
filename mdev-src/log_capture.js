// Runs in MAIN world at document_start
if (window.__mdevVersion !== '3') {
  window.__mdevVersion  = '3';
  window.__mdevActive   = true;
  window.__mdevLogs     = [];
  window.__mdevEvents   = [];
  window.__mdevRequests = [];

  function syncBridge() {
    try {
      let el = document.getElementById('__mdev_bridge');
      if (!el) {
        el = document.createElement('meta');
        el.id = '__mdev_bridge';
        (document.documentElement || document.head || document.body).appendChild(el);
      }
      el.setAttribute('data-logs',     JSON.stringify(window.__mdevLogs));
      el.setAttribute('data-events',   JSON.stringify(window.__mdevEvents));
      el.setAttribute('data-requests', JSON.stringify(window.__mdevRequests));
    } catch {}
  }

  function pushRequest(entry) {
    try {
      window.__mdevRequests.push(entry);
      if (window.__mdevRequests.length > 200) window.__mdevRequests.shift();
      syncBridge();
    } catch {}
  }

  /* ── Fetch interception ── */
  try {
    const _fetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const url    = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
      const method = (args[1]?.method || 'GET').toUpperCase();
      const start  = Date.now();
      let response;
      try {
        response = await _fetch(...args);
      } catch (err) {
        pushRequest({ time: new Date().toISOString(), type: 'fetch', method, url, status: 0, duration: Date.now() - start });
        throw err;
      }
      pushRequest({ time: new Date().toISOString(), type: 'fetch', method, url, status: response.status, duration: Date.now() - start });
      return response;
    };
  } catch {}

  /* ── XHR interception (prototype patch — works with jQuery, axios, etc.) ── */
  try {
    const _open = XMLHttpRequest.prototype.open;
    const _send = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this._mMethod = (method || 'GET').toUpperCase();
      this._mUrl    = String(url || '');
      return _open.apply(this, [method, url, ...rest]);
    };

    XMLHttpRequest.prototype.send = function (...args) {
      const start = Date.now();
      this.addEventListener('loadend', () => {
        pushRequest({
          time:     new Date().toISOString(),
          type:     'xhr',
          method:   this._mMethod || 'GET',
          url:      this._mUrl    || '',
          status:   this.status   || 0,
          duration: Date.now() - start
        });
      });
      return _send.apply(this, args);
    };
  } catch {}

  /* ── Console capture ── */
  ['log', 'error', 'warn', 'info'].forEach(level => {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      try {
        const message = args.map(a => {
          try { return typeof a === 'object' ? JSON.stringify(a) : String(a); }
          catch { return '[unserializable]'; }
        }).join(' ');
        window.__mdevLogs.push({ level, message, time: new Date().toISOString() });
        if (window.__mdevLogs.length > 300) window.__mdevLogs.shift();
        syncBridge();
      } catch {}
      orig(...args);
    };
  });

  /* ── Click tracking ── */
  document.addEventListener('click', e => {
    try {
      const el = e.target;
      // Skip sensitive inputs and extension overlay elements
      if (el.closest('input[type="password"]')) return;
      if (['ib-overlay', 'ib-selection', 'ib-hint'].includes(el.id)) return;

      const tag     = el.tagName.toLowerCase();
      const id      = el.id            ? `#${el.id}`                                : '';
      const cls     = el.classList.length ? `.${[...el.classList].slice(0, 2).join('.')}` : '';
      const isInput = ['input', 'textarea', 'select'].includes(tag);
      const text    = isInput
        ? (el.placeholder ? `[${el.placeholder}]` : null)
        : el.innerText?.trim().replace(/\s+/g, ' ').slice(0, 60) || null;

      window.__mdevEvents.push({
        time:    new Date().toISOString(),
        type:    'click',
        element: `${tag}${id}${cls}`,
        text,
        url:     location.pathname + location.search
      });
      if (window.__mdevEvents.length > 100) window.__mdevEvents.shift();
      syncBridge();
    } catch {}
  }, true);

  /* ── SPA navigation tracking ── */
  ['pushState', 'replaceState'].forEach(method => {
    const orig = history[method].bind(history);
    history[method] = (...args) => {
      orig(...args);
      try {
        window.__mdevEvents.push({
          time: new Date().toISOString(),
          type: 'navigate',
          url:  location.pathname + location.search
        });
        if (window.__mdevEvents.length > 100) window.__mdevEvents.shift();
        syncBridge();
      } catch {}
    };
  });

  window.addEventListener('popstate', () => {
    try {
      window.__mdevEvents.push({
        time: new Date().toISOString(),
        type: 'navigate',
        url:  location.pathname + location.search
      });
      if (window.__mdevEvents.length > 100) window.__mdevEvents.shift();
      syncBridge();
    } catch {}
  });
}

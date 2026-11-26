// Full screenshot is kept in memory (too large for session storage)
let _fullScreenshot = null;

// Keep service worker alive while the editor tab is open
chrome.runtime.onConnect.addListener(port => {
  if (port.name === 'editor-keepalive') {
    port.onDisconnect.addListener(() => { _fullScreenshot = null; });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_FULL_SCREENSHOT') {
    sendResponse({ url: _fullScreenshot });
    return true;
  }

  if (msg.type !== 'CAPTURE_AREA') return;
  const { rect, dpr, logs, events, requests, title } = msg;

  chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' }, (fullDataUrl) => {
    _fullScreenshot = fullDataUrl;

    fetch(fullDataUrl)
      .then(r => r.blob())
      .then(blob => createImageBitmap(blob))
      .then(bmp => {
        const oc = new OffscreenCanvas(rect.w * dpr, rect.h * dpr);
        const cx = oc.getContext('2d');
        cx.drawImage(bmp, rect.x*dpr, rect.y*dpr, rect.w*dpr, rect.h*dpr, 0, 0, rect.w*dpr, rect.h*dpr);
        return oc.convertToBlob({ type: 'image/png' });
      })
      .then(blob => new Promise(res => {
        const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob);
      }))
      .then(croppedDataUrl => {
        chrome.storage.session.set({
          pendingScreenshot: croppedDataUrl,
          pendingRect: { x: rect.x * dpr, y: rect.y * dpr, w: rect.w * dpr, h: rect.h * dpr },
          pendingUrl:    msg.url || sender.tab.url,
          pendingTitle:  title   || sender.tab.title || '',
          pendingLogs:      logs     || [],
          pendingEvents:    events   || [],
          pendingRequests:  requests || []
        }, () => {
          chrome.tabs.create({ url: chrome.runtime.getURL('editor.html') });
        });
      });
  });
});

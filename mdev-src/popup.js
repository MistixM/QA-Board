document.getElementById('capture-btn').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }).catch(() => {});
  chrome.tabs.sendMessage(tab.id, { type: 'START_CAPTURE' });
  window.close();
});

/* Accepts either a raw Doc ID or a full Google Docs URL */
function extractGoogleDocId(input) {
  const trimmed = input.trim();
  const match = trimmed.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : trimmed;
}

const gdocInput  = document.getElementById('gdoc-input');
const gdocStatus = document.getElementById('gdoc-status');

chrome.storage.sync.get(['gdocId'], ({ gdocId }) => {
  if (gdocId) gdocInput.value = gdocId;
});

let saveTimer;
gdocInput.addEventListener('input', () => {
  clearTimeout(saveTimer);
  gdocStatus.textContent = '';
  gdocStatus.classList.remove('saved');
  saveTimer = setTimeout(() => {
    const id = extractGoogleDocId(gdocInput.value);
    chrome.storage.sync.set({ gdocId: id }, () => {
      gdocStatus.textContent = id ? 'Saved' : '';
      gdocStatus.classList.add('saved');
    });
  }, 400);
});

const aiWorkerUrlInput = document.getElementById('ai-worker-url');
const aiWorkerTokenInput = document.getElementById('ai-worker-token');
const aiSettingsStatus = document.getElementById('ai-settings-status');
const aiSaveBtn = document.getElementById('ai-save-btn');

chrome.storage.local.get(['aiWorkerUrl', 'aiWorkerToken']).then(settings => {
  aiWorkerUrlInput.value = settings.aiWorkerUrl || '';
  aiWorkerTokenInput.value = settings.aiWorkerToken || '';
}).catch(() => {
  aiSettingsStatus.textContent = 'Could not load AI settings. Reopen the popup to retry.';
});

document.getElementById('ai-settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  aiSaveBtn.disabled = true;
  aiSettingsStatus.textContent = '';
  try {
    const aiWorkerUrl = MdevAi.normalizeWorkerUrl(aiWorkerUrlInput.value);
    const aiWorkerToken = aiWorkerTokenInput.value.trim();
    if (!aiWorkerToken || /\s/.test(aiWorkerToken)) throw new Error('Enter the endpoint token without spaces.');
    // Request access to this specific Worker while handling the user's click.
    const granted = await chrome.permissions.request({ origins: [`${aiWorkerUrl}/*`] });
    if (!granted) throw new Error('Allow access to your Worker to save AI settings.');
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    await chrome.storage.local.set({ aiWorkerUrl, aiWorkerToken });
    aiWorkerUrlInput.value = aiWorkerUrl;
    aiSettingsStatus.textContent = 'AI settings saved on this device.';
  } catch (error) {
    aiSettingsStatus.textContent = error.message;
  } finally {
    aiSaveBtn.disabled = false;
  }
});

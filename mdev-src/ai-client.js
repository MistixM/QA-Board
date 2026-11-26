/* Shared by the popup and report editor. */
globalThis.MdevAi = (() => {
  function normalizeWorkerUrl(value) {
    let url;
    try {
      url = new URL(value.trim());
    } catch {
      throw new Error('Enter your HTTPS workers.dev URL in the extension popup.');
    }
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.workers.dev') ||
        url.username || url.password || url.port || url.search || url.hash ||
        !['', '/', '/generate', '/generate/'].includes(url.pathname)) {
      throw new Error('Use your HTTPS workers.dev URL, optionally ending in /generate.');
    }
    return url.origin;
  }

  async function generate(task, description, settings, signal) {
    const workerUrl = normalizeWorkerUrl(settings.aiWorkerUrl || '');
    const token = settings.aiWorkerToken?.trim();
    if (!token) throw new Error('Save your AI endpoint token in the extension popup.');

    let response;
    try {
      response = await fetch(`${workerUrl}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ task, description }),
        signal,
        redirect: 'error',
        credentials: 'omit'
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new Error('Could not reach the AI Worker. Check its URL, deployment, and site permission in the popup.');
    }

    let data;
    try {
      data = await response.json();
    } catch (error) {
      if (signal.aborted) throw error;
      if (response.ok) throw new Error(`The AI Worker returned an invalid response (HTTP ${response.status}).`);
    }
    if (!response.ok) {
      if (response.status === 401) throw new Error('AI authentication failed. Check the endpoint token in the popup.');
      if (response.status === 403) throw new Error('The AI Worker rejected this extension. Check its ALLOWED_ORIGIN setting.');
      if (typeof data?.error === 'string') throw new Error(data.error);
      if (response.status === 429) throw new Error('Cloudflare usage is limited. Check your daily allocation and try again later.');
      if (response.status === 504) throw new Error('Cloudflare AI generation timed out. Please try again.');
      throw new Error(`AI Worker error (HTTP ${response.status}).`);
    }
    if (typeof data?.text !== 'string' || !data.text.trim()) {
      throw new Error('The AI Worker returned empty or malformed generated text.');
    }
    return data.text.trim();
  }

  return Object.freeze({ normalizeWorkerUrl, generate });
})();

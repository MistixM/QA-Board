/* Environment is read in the trusted extension editor, not from page content.
   Timestamp denotes the start of this submission attempt, before uploads. */
const MdevReportMetadata = (() => {
  function detect(nav, hints = {}) {
    const ua = nav.userAgent || '';
    const brands = hints.fullVersionList || nav.userAgentData?.brands || [];
    // Prefer product brands over their shared Chromium engine; ignore GREASE brands.
    const known = ['Microsoft Edge', 'Opera', 'Brave', 'Google Chrome', 'Chromium'];
    const brand = known.map(name => brands.find(item => item.brand === name)).find(Boolean);
    const uaBrowser = [
      ['Microsoft Edge', /Edg(?:A|iOS)?\/([\d.]+)/],
      ['Opera', /(?:OPR|Opera)\/([\d.]+)/],
      ['Firefox', /(?:Firefox|FxiOS)\/([\d.]+)/],
      ['Google Chrome', /(?:Chrome|CriOS)\/([\d.]+)/],
      ['Safari', /Version\/([\d.]+).*Safari\//]
    ].map(([name, pattern]) => { const match = ua.match(pattern); return match && `${name} ${match[1]}`; }).find(Boolean);
    let os = hints.platform || nav.userAgentData?.platform;
    if (!os) {
      if (/Android/.test(ua)) os = 'Android';
      else if (/iPhone|iPad|iPod/.test(ua) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1)) os = 'iOS';
      else if (/CrOS/.test(ua)) os = 'Chrome OS';
      else if (/Windows/.test(ua)) os = 'Windows';
      else if (/Macintosh|Mac OS X/.test(ua)) os = 'macOS';
      else if (/Linux/.test(ua)) os = 'Linux';
    }
    return { browser: brand ? `${brand.brand} ${brand.version || 'Unknown version'}` : uaBrowser || 'Unknown', os: os || 'Unknown' };
  }

  async function collect(nav = navigator, now = new Date()) {
    const submittedAt = now.toISOString();
    let hints = {}, timer;
    try {
      if (nav.userAgentData?.getHighEntropyValues) {
        hints = await Promise.race([
          nav.userAgentData.getHighEntropyValues(['fullVersionList', 'platform']),
          new Promise(resolve => { timer = setTimeout(() => resolve({}), 1500); })
        ]) || {};
      }
    } catch { /* Restricted hints must not prevent submission. */ }
    finally { clearTimeout(timer); }
    return { ...detect(nav, hints), submittedAt };
  }

  function lines(metadata) {
    const date = metadata?.submittedAt ? new Date(metadata.submittedAt) : null;
    const time = date && Number.isFinite(date.getTime())
      ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'Europe/Kyiv' }).format(date)
      : 'Unknown';
    return [`Browser: ${metadata?.browser || 'Unknown'}`, `OS: ${metadata?.os || 'Unknown'}`, `Submitted: ${time}`];
  }
  return { collect, detect, lines };
})();

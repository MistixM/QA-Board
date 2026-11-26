const NOTION_API_KEY = globalThis.MDEV_CONFIG?.notionApiKey?.trim() || '';
const NOTION_DB_ID = globalThis.MDEV_CONFIG?.notionDatabaseId?.trim() || '';
const NOTION_SETUP_ERROR = 'Configure notionApiKey in mdev-src/config.local.js, then reload the extension.';

/* Target Google Doc for reports is set via the extension popup, not hardcoded here. */
function getGdocId() {
  return new Promise(resolve => {
    chrome.storage.sync.get(['gdocId'], ({ gdocId }) => resolve(gdocId || ''));
  });
}

/* ─────────────────── Database picker ─────────────────── */
/* Auto-pick the database whose title best matches the captured site's
   hostname / page title, so the right report destination is pre-selected. */
function pickBestDatabase(results) {
  const tokens = new Set();
  try {
    const host = new URL(pageUrl).hostname.replace(/^www\./, '');
    host.split('.').forEach(part => { if (part.length > 2) tokens.add(part.toLowerCase()); });
  } catch {}
  (pageTitle || '').split(/[\s\-–—|·:]+/).forEach(word => {
    const t = word.trim().toLowerCase();
    if (t.length > 2) tokens.add(t);
  });
  if (!tokens.size) return null;

  let best = null, bestScore = 0;
  results.forEach(db => {
    const title = (db.title?.map(t => t.plain_text).join('') || '').toLowerCase();
    if (!title) return;
    let score = 0;
    tokens.forEach(tok => { if (title.includes(tok)) score++; });
    if (score > bestScore) { bestScore = score; best = db; }
  });
  return best;
}

async function loadDatabases() {
  const sel = document.getElementById('f-database');
  if (!NOTION_API_KEY) {
    sel.innerHTML = '<option value="">Notion setup required</option>';
    sel.title = NOTION_SETUP_ERROR;
    return;
  }
  try {
    const res = await fetch('https://api.notion.com/v1/search', {
      method: 'POST',
      headers: notionHeaders(),
      body: JSON.stringify({
        filter: { value: 'database', property: 'object' },
        sort:   { direction: 'descending', timestamp: 'last_edited_time' }
      })
    });
    if (!res.ok) throw new Error(`${res.status}`);
    const { results } = await res.json();

    sel.innerHTML = '';
    if (!results.length) {
      sel.innerHTML = '<option value="">No databases found</option>';
      return;
    }

    const match = pickBestDatabase(results);
    let preselectId;
    if (match) preselectId = match.id.replace(/-/g, '');
    else if (results.some(db => db.id.replace(/-/g, '') === NOTION_DB_ID)) preselectId = NOTION_DB_ID;
    else preselectId = results[0].id.replace(/-/g, '');

    results.forEach(db => {
      const title = db.title?.map(t => t.plain_text).join('') || 'Untitled';
      const icon  = db.icon?.emoji ? db.icon.emoji + ' ' : '';
      const opt   = document.createElement('option');
      opt.value       = db.id.replace(/-/g, '');
      opt.textContent = `${icon}${title}`;
      if (opt.value === preselectId) opt.selected = true;
      sel.appendChild(opt);
    });

    sel.disabled = false;
  } catch (err) {
    sel.innerHTML = `<option value="${NOTION_DB_ID}">Default database</option>`;
    sel.disabled = false;
    console.warn('[MDEV] Could not load databases:', err.message);
  }
}

function notionHeaders() {
  if (!NOTION_API_KEY) throw new Error(NOTION_SETUP_ERROR);
  return {
    'Authorization': `Bearer ${NOTION_API_KEY}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json'
  };
}

/* ─────────────────── Destination switcher ─────────────────── */
function setDestinationUi(destination) {
  document.getElementById('f-database-label').hidden = destination === 'gdocs';
}

function initDestinationSwitcher() {
  const sel = document.getElementById('f-destination');
  const defaultCheckbox = document.getElementById('f-destination-default');

  chrome.storage.sync.get(['defaultDestination'], ({ defaultDestination }) => {
    if (defaultDestination) {
      sel.value = defaultDestination;
      defaultCheckbox.checked = true;
    }
    setDestinationUi(sel.value);
  });

  sel.addEventListener('change', () => setDestinationUi(sel.value));
}

/* ─────────────────── Google auth ─────────────────── */
function getGoogleAuthToken(interactive = true) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, token => {
      if (chrome.runtime.lastError || !token) {
        reject(new Error(chrome.runtime.lastError?.message || 'Google sign-in failed'));
        return;
      }
      resolve(token);
    });
  });
}

/* ─────────────────── Canvas ─────────────────── */
const canvas = document.getElementById('main-canvas');
const ctx    = canvas.getContext('2d', { willReadFrequently: true });
let img = new Image();

/* ── Annotation state ── */
let annotations = [];
const annotationHistory = [];
let annotationTool = null;
let annotationColor = '#FF3333';
let annotationDrag = null;
let annotationDraft = null;
let textAnchor = null;
const annotationTools = document.querySelectorAll('.annotation-tool');
const colorButton = document.getElementById('annotation-color-btn');
const colorPalette = document.getElementById('annotation-palette');
const colorSwatches = colorPalette.querySelectorAll('[data-color]');
const customColor = document.getElementById('annotation-custom-color');
const textDialog = document.getElementById('annotation-text-dialog');
const textInput = document.getElementById('annotation-text-input');
const clearAnnotationsButton = document.getElementById('clear-ann-btn');

function drawAnnotation(annotation, preview = false) {
  const { type, x, y, color, lineWidth } = annotation;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (preview) ctx.setLineDash([lineWidth * 2, lineWidth]);

  if (type === 'box') {
    ctx.globalAlpha = 0.1;
    ctx.fillRect(x, y, annotation.w, annotation.h);
    ctx.globalAlpha = 1;
    ctx.strokeRect(x, y, annotation.w, annotation.h);
  } else if (type === 'text') {
    ctx.font = `600 ${annotation.fontSize}px Arial, sans-serif`;
    ctx.textBaseline = 'top';
    annotation.text.split('\n').forEach((line, index) => {
      ctx.fillText(line, x, y + index * annotation.fontSize * 1.25);
    });
  } else {
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(annotation.endX, annotation.endY);
    ctx.stroke();
    if (type === 'arrow') {
      const angle = Math.atan2(annotation.endY - y, annotation.endX - x);
      const headLength = Math.min(lineWidth * 5, Math.hypot(annotation.endX - x, annotation.endY - y) * 0.5);
      ctx.beginPath();
      ctx.moveTo(annotation.endX - headLength * Math.cos(angle - Math.PI / 6), annotation.endY - headLength * Math.sin(angle - Math.PI / 6));
      ctx.lineTo(annotation.endX, annotation.endY);
      ctx.lineTo(annotation.endX - headLength * Math.cos(angle + Math.PI / 6), annotation.endY - headLength * Math.sin(angle + Math.PI / 6));
      ctx.stroke();
    }
  }
  ctx.restore();
}

function redrawCanvas(includeDraft = true) {
  if (!img.src) return;
  ctx.fillStyle = '#0A0A0A';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0);
  annotations.forEach(annotation => drawAnnotation(annotation));
  if (includeDraft && annotationDraft) drawAnnotation(annotationDraft, true);
}

function canvasPoint(e) {
  const r  = canvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(canvas.width, (e.clientX - r.left) * (canvas.width / r.width))),
    y: Math.max(0, Math.min(canvas.height, (e.clientY - r.top) * (canvas.height / r.height)))
  };
}

function cancelAnnotationDrag() {
  const pointerId = annotationDrag?.pointerId;
  annotationDrag = null;
  annotationDraft = null;
  if (pointerId !== undefined && canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
  redrawCanvas();
}

function updateAnnotationDraft(e) {
  const point = canvasPoint(e);
  const { start, type, color, lineWidth } = annotationDrag;
  annotationDraft = { type, color, lineWidth, x: start.x, y: start.y, endX: point.x, endY: point.y };
  if (type === 'box') {
    annotationDraft.x = Math.min(start.x, point.x);
    annotationDraft.y = Math.min(start.y, point.y);
    annotationDraft.w = Math.abs(point.x - start.x);
    annotationDraft.h = Math.abs(point.y - start.y);
  }
}

canvas.addEventListener('pointerdown', e => {
  if (!annotationTool || !img.complete || !img.naturalWidth || e.button !== 0 || annotationDrag) return;
  e.preventDefault();
  canvas.focus({ preventScroll: true });
  colorPalette.hidden = true;
  colorButton.setAttribute('aria-expanded', 'false');
  const point = canvasPoint(e);
  const scale = canvas.width / canvas.getBoundingClientRect().width;
  if (annotationTool === 'text') {
    textAnchor = { ...point, color: annotationColor, fontSize: 20 * scale };
    textInput.value = '';
    textInput.setCustomValidity('');
    textDialog.showModal();
    textInput.focus();
    return;
  }
  annotationDrag = { pointerId: e.pointerId, start: point, type: annotationTool, color: annotationColor, lineWidth: 3 * scale };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', e => {
  if (!annotationDrag || e.pointerId !== annotationDrag.pointerId) return;
  updateAnnotationDraft(e);
  redrawCanvas();
});
canvas.addEventListener('pointerup', e => {
  if (!annotationDrag || e.pointerId !== annotationDrag.pointerId) return;
  updateAnnotationDraft(e);
  const draft = annotationDraft;
  const minimumSize = draft.lineWidth;
  const size = draft.type === 'box' ? Math.min(draft.w, draft.h) : Math.hypot(draft.endX - draft.x, draft.endY - draft.y);
  if (size >= minimumSize) {
    annotationHistory.push(annotations.slice());
    annotations.push(draft);
    clearAnnotationsButton.hidden = false;
  }
  cancelAnnotationDrag();
});
canvas.addEventListener('pointercancel', cancelAnnotationDrag);
canvas.addEventListener('lostpointercapture', () => {
  if (annotationDrag) cancelAnnotationDrag();
});

annotationTools.forEach(button => button.addEventListener('click', () => {
  cancelAnnotationDrag();
  annotationTool = annotationTool === button.dataset.tool ? null : button.dataset.tool;
  annotationTools.forEach(tool => tool.setAttribute('aria-pressed', String(tool.dataset.tool === annotationTool)));
  canvas.style.cursor = annotationTool === 'text' ? 'text' : annotationTool ? 'crosshair' : 'default';
}));

function setAnnotationColor(color) {
  annotationColor = color.toUpperCase();
  document.getElementById('annotation-color-preview').style.backgroundColor = annotationColor;
  customColor.value = annotationColor.toLowerCase();
  colorSwatches.forEach(swatch => swatch.setAttribute('aria-pressed', String(swatch.dataset.color === annotationColor)));
}

colorButton.addEventListener('click', () => {
  colorPalette.hidden = !colorPalette.hidden;
  colorButton.setAttribute('aria-expanded', String(!colorPalette.hidden));
  if (!colorPalette.hidden) colorSwatches[0].focus();
});
colorSwatches.forEach(swatch => swatch.addEventListener('click', () => {
  setAnnotationColor(swatch.dataset.color);
  colorPalette.hidden = true;
  colorButton.setAttribute('aria-expanded', 'false');
  colorButton.focus();
}));
customColor.addEventListener('input', () => setAnnotationColor(customColor.value));
document.addEventListener('pointerdown', e => {
  if (!document.getElementById('annotation-color-control').contains(e.target)) {
    colorPalette.hidden = true;
    colorButton.setAttribute('aria-expanded', 'false');
  }
});
document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !e.shiftKey && !e.altKey) {
    if (e.defaultPrevented || e.isComposing || textDialog.open || e.target?.isContentEditable ||
        e.target?.closest?.('input, textarea, select, [role="textbox"]')) return;
    if (!annotationDrag && !annotationHistory.length) return;
    e.preventDefault();
    if (annotationDrag) {
      cancelAnnotationDrag();
      return;
    }
    annotations = annotationHistory.pop();
    clearAnnotationsButton.hidden = annotations.length === 0;
    redrawCanvas();
    return;
  }
  if (e.key !== 'Escape') return;
  cancelAnnotationDrag();
  if (!colorPalette.hidden) {
    colorPalette.hidden = true;
    colorButton.setAttribute('aria-expanded', 'false');
    colorButton.focus();
  }
});

textInput.addEventListener('input', () => textInput.setCustomValidity(''));
document.getElementById('annotation-text-form').addEventListener('submit', e => {
  if (e.submitter?.value !== 'add' || !textAnchor) return;
  const text = textInput.value.trim();
  if (!text) {
    e.preventDefault();
    textInput.setCustomValidity('Enter annotation text.');
    textInput.reportValidity();
    return;
  }
  const { color, fontSize } = textAnchor;
  ctx.save();
  ctx.font = `600 ${fontSize}px Arial, sans-serif`;
  const lines = text.split('\n');
  const width = Math.max(...lines.map(line => ctx.measureText(line).width));
  ctx.restore();
  annotationHistory.push(annotations.slice());
  annotations.push({
    type: 'text', text, color, fontSize, lineWidth: 0,
    x: Math.max(0, Math.min(textAnchor.x, canvas.width - width)),
    y: Math.max(0, Math.min(textAnchor.y, canvas.height - lines.length * fontSize * 1.25))
  });
  clearAnnotationsButton.hidden = false;
  redrawCanvas();
});
textDialog.addEventListener('close', () => { textAnchor = null; });

clearAnnotationsButton.addEventListener('click', () => {
  cancelAnnotationDrag();
  if (annotations.length) annotationHistory.push(annotations.slice());
  annotations = [];
  redrawCanvas();
  clearAnnotationsButton.hidden = true;
});

function loadImage(src) {
  canvas.classList.remove('loaded');
  img.onload = () => {
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    redrawCanvas();
    requestAnimationFrame(() => canvas.classList.add('loaded'));
  };
  img.src = src;
}

let pageUrl   = '';
let pageTitle = '';
let consoleLogs  = [];
let userEvents   = [];
let userRequests = [];
let fullScreenshotUrl = null;
let selectedRect = null;

/* ─────────────────── Overall area image ─────────────────── */
async function generateOverallImage() {
  if (!fullScreenshotUrl || !selectedRect) return null;
  const img = new Image();
  await new Promise(res => { img.onload = res; img.src = fullScreenshotUrl; });

  const oc = document.createElement('canvas');
  oc.width  = img.naturalWidth;
  oc.height = img.naturalHeight;
  const cx  = oc.getContext('2d');
  cx.drawImage(img, 0, 0);

  const { x, y, w, h } = selectedRect;
  cx.fillStyle   = 'rgba(255, 0, 0, 0.12)';
  cx.fillRect(x, y, w, h);
  cx.strokeStyle = '#FF2222';
  cx.lineWidth   = Math.max(3, Math.round(Math.min(oc.width, oc.height) * 0.003));
  cx.strokeRect(x, y, w, h);

  return new Promise(res => oc.toBlob(res, 'image/png'));
}

/* ─────────────────── AI complete ─────────────────── */
const aiBtn  = document.getElementById('ai-gen-btn');
const descEl = document.getElementById('f-desc');
let aiGenerating = false;

function updateAiBtnState() {
  aiBtn.disabled = aiGenerating || descEl.value.trim().length <= 10;
}
descEl.addEventListener('input', updateAiBtnState);
updateAiBtnState();

aiBtn.addEventListener('click', async () => {
  const desc = descEl.value.trim();
  if (aiGenerating || desc.length <= 10) return;

  aiGenerating = true;
  aiBtn.disabled = true;
  aiBtn.classList.add('generating');
  aiBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z"/></svg> Generating<span class="ai-dots"><span></span><span></span><span></span></span>`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  try {
    const settings = await chrome.storage.local.get(['aiWorkerUrl', 'aiWorkerToken']);
    const [title, brief, severity] = await Promise.all([
      MdevAi.generate('title', desc, settings, controller.signal),
      MdevAi.generate('brief', desc, settings, controller.signal),
      MdevAi.generate('severity', desc, settings, controller.signal)
    ]);
    const validSeverity = ['Low', 'Medium', 'High'].find(value => value.toLowerCase() === severity.toLowerCase());
    if (!validSeverity) throw new Error('AI returned an invalid severity. Please try again.');

    document.getElementById('f-title').value = title;
    document.getElementById('f-brief').value = brief;
    document.getElementById('f-severity').value = validSeverity;
  } catch (err) {
    const message = controller.signal.aborted ? 'AI generation timed out. Please try again.' : err.message;
    alert('Could not generate content: ' + message);
  } finally {
    clearTimeout(timeout);
    controller.abort();
    aiGenerating = false;
    aiBtn.classList.remove('generating');
    aiBtn.disabled = aiGenerating || descEl.value.trim().length <= 10;
    aiBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z"/></svg> Complete with AI`;
  }
});

/* ─────────────────── Extra files ─────────────────── */
let extraFiles = [];

const dropZone  = document.getElementById('drop-zone');
const fileInput = document.getElementById('extra-files');
const fileList  = document.getElementById('file-list');

let pickerBusy = false;
function openFilePicker() {
  if (pickerBusy) return;
  pickerBusy = true;
  fileInput.value = '';
  fileInput.click();
  setTimeout(() => { pickerBusy = false; }, 500);
}

document.getElementById('browse-link').addEventListener('click', e => { e.stopPropagation(); openFilePicker(); });
dropZone.addEventListener('click', openFilePicker);
fileInput.addEventListener('change', () => addFiles([...fileInput.files]));

descEl.addEventListener('paste', e => {
  const images = [...(e.clipboardData?.items || [])].filter(i => i.type.startsWith('image/'));
  if (!images.length) return;
  e.preventDefault();
  addFiles(images.map((item, idx) => {
    const blob = item.getAsFile();
    return new File([blob], `paste-${Date.now()}-${idx}.png`, { type: blob.type || 'image/png' });
  }));
});
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault(); dropZone.classList.remove('drag-over');
  addFiles([...e.dataTransfer.files].filter(f => f.type.startsWith('image/')));
});

function addFiles(files) {
  files.forEach(f => {
    if (extraFiles.find(x => x.name === f.name && x.size === f.size)) return;
    extraFiles.push(f);
    renderFileList();
  });
}

function renderFileList() {
  fileList.innerHTML = '';
  extraFiles.forEach((f, i) => {
    const chip = document.createElement('div');
    chip.className = 'file-chip';
    chip.innerHTML = `
      <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>
      </svg>
      <span title="${f.name}">${f.name}</span>
      <button data-i="${i}" title="Remove">✕</button>`;
    chip.querySelector('button').addEventListener('click', () => { extraFiles.splice(i, 1); renderFileList(); });
    fileList.appendChild(chip);
  });
}

/* ─────────────────── Notion file upload ─────────────────── */
async function toJpeg(blob, quality = 0.9) {
  const bmp = await createImageBitmap(blob);
  const oc  = document.createElement('canvas');
  oc.width  = bmp.width;
  oc.height = bmp.height;
  oc.getContext('2d').drawImage(bmp, 0, 0);
  return new Promise(res => oc.toBlob(res, 'image/jpeg', quality));
}

async function uploadFileToNotion(blob, filename) {
  try {
    // Convert images to JPEG to stay within Notion's file size limits
    const isImage = blob.type.startsWith('image/');
    const upload  = isImage ? await toJpeg(blob) : blob;
    const fname   = isImage ? filename.replace(/\.\w+$/, '.jpg') : filename;
    const mime    = upload.type || 'image/jpeg';

    const initRes = await fetch('https://api.notion.com/v1/file_uploads', {
      method: 'POST',
      headers: notionHeaders(),
      body: JSON.stringify({ mode: 'single_part', filename: fname, content_type: mime })
    });
    if (!initRes.ok) {
      const err = await initRes.json().catch(() => ({}));
      console.error('[MDEV] file_uploads init failed:', initRes.status, err);
      return null;
    }
    const { id, upload_url } = await initRes.json();

    const formData = new FormData();
    formData.append('file', upload, fname);
    const uploadRes = await fetch(upload_url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_API_KEY}`,
        'Notion-Version': '2022-06-28'
      },
      body: formData
    });
    if (!uploadRes.ok) {
      const err = await uploadRes.json().catch(() => ({}));
      console.error('[MDEV] file_uploads send failed:', uploadRes.status, err);
      return null;
    }
    return id;
  } catch (e) {
    console.error('[MDEV] uploadFileToNotion error:', e);
    return null;
  }
}

/* ─────────────────── Notion block helpers ─────────────────── */
function textBlock(text) {
  return {
    object: 'block', type: 'paragraph',
    paragraph: { rich_text: [{ type: 'text', text: { content: text } }] }
  };
}

function h2Block(text) {
  return {
    object: 'block', type: 'heading_2',
    heading_2: { rich_text: [{ type: 'text', text: { content: text } }] }
  };
}

function codeBlock(text) {
  return {
    object: 'block', type: 'code',
    code: {
      rich_text: [{ type: 'text', text: { content: text.slice(0, 2000) } }],
      language: 'plain text'
    }
  };
}

/* Split long text into multiple 2000-char code blocks, breaking at newlines */
function splitCodeBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  let chunk = '';
  for (const line of lines) {
    if (chunk.length + line.length + 1 > 1900) {
      if (chunk) blocks.push(codeBlock(chunk));
      chunk = line;
    } else {
      chunk = chunk ? `${chunk}\n${line}` : line;
    }
  }
  if (chunk) blocks.push(codeBlock(chunk));
  return blocks;
}

function formatRequest(r) {
  const method = (r.method || 'GET').padEnd(7);
  const status = r.status ? String(r.status).padEnd(5) : 'ERR  ';
  const dur    = `${r.duration}ms`.padEnd(8);
  return `${method} ${status} ${dur} ${r.url}`;
}

function formatEvent(e) {
  const t = new Date(e.time).toLocaleTimeString();
  if (e.type === 'navigate') return `${t} — Navigated to ${e.url}`;
  const label = e.text ? ` "${e.text}"` : '';
  return `${t} — Clicked <${e.element}>${label}  ${e.url}`;
}

function dividerBlock() {
  return { object: 'block', type: 'divider', divider: {} };
}

function imageFileBlock(uploadId) {
  return {
    object: 'block', type: 'image',
    image: { type: 'file_upload', file_upload: { id: uploadId } }
  };
}

/* ─────────────────── Google Docs section builder ─────────────────── */
/* Uploads a blob to Drive and makes it link-viewable, since insertInlineImage
   requires a publicly fetchable URI (Docs can't read authenticated Drive links). */
async function uploadImageToDrive(token, blob, filename) {
  const boundary = 'mdev-' + Date.now();
  const metadata = { name: filename, mimeType: blob.type || 'image/png' };
  const bodyParts = [
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
    `--${boundary}\r\nContent-Type: ${metadata.mimeType}\r\n\r\n`
  ];
  const multipartBody = new Blob([bodyParts[0], bodyParts[1], blob, `\r\n--${boundary}--`]);

  const createRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body: multipartBody
  });
  if (!createRes.ok) throw new Error(`Drive upload failed: ${createRes.status}`);
  const { id: fileId } = await createRes.json();

  await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'reader', type: 'anyone' })
  });

  return `https://drive.google.com/uc?export=view&id=${fileId}`;
}

async function appendReportToGoogleDoc(docId, report) {
  const token = await getGoogleAuthToken(true);

  const docRes = await fetch(`https://docs.googleapis.com/v1/documents/${docId}?fields=body(content(endIndex))`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!docRes.ok) throw new Error(`Could not read target Doc: ${docRes.status}`);
  const { body } = await docRes.json();
  const content = body.content || [];
  const docEndIndex = content.length ? content[content.length - 1].endIndex : 1;
  const insertAt = Math.max(1, docEndIndex - 1);
  const isFirstEntry = insertAt === 1;

  // Upload images up front so their Drive URIs are ready by the time we build requests.
  const screenshotUri = report.screenshotBlob ? await uploadImageToDrive(token, report.screenshotBlob, 'screenshot.png') : null;
  const overallUri = report.overallBlob ? await uploadImageToDrive(token, report.overallBlob, 'overall-area.png') : null;

  // Build the entry as a sequence of lines, tracking which are semantic
  // headings (2 = title, 3 = section label) and which are image placeholders.
  const lines = [];
  const push = (text, heading = null, placeholder = null) => lines.push({ text, heading, placeholder });

  push(report.title, 2);
  push(`Severity: ${report.severity}    Status: ${report.status}`);
  if (report.pageUrl) push(`Page URL: ${report.pageUrl}`);
  if (report.brief) push(`Brief: ${report.brief}`);
  push('');

  if (report.desc) {
    push('Description', 3);
    push(report.desc);
    push('');
  }

  const textSections = [
    ['Steps to Reproduce', report.stepsText],
    ['Console Logs', report.logsText],
    ['Network Requests', report.requestsText]
  ];
  textSections.forEach(([label, text]) => {
    if (!text) return;
    push(label, 3);
    push(text);
    push('');
  });

  if (screenshotUri) {
    push('Screenshot', 3);
    push('', null, 'screenshot');
    push('');
  }
  if (overallUri) {
    push('Overall Area', 3);
    push('', null, 'overall');
    push('');
  }

  push('Report Details', 3);
  MdevReportMetadata.lines(report.metadata).forEach(line => push(line));

  if (lines.length && lines[lines.length - 1].text === '' && !lines[lines.length - 1].placeholder) lines.pop();

  const prefix = isFirstEntry ? '' : '\n\n';
  let pos = insertAt + prefix.length;
  const headingRanges = [];
  const resetRanges = [];
  const placeholders = {};

  lines.forEach(line => {
    const start = pos;
    const end = start + line.text.length;
    if (line.heading) headingRanges.push({ start, end, heading: line.heading });
    else if (end > start) resetRanges.push({ start, end });
    if (line.placeholder) placeholders[line.placeholder] = start;
    pos = end + 1; // account for the '\n' joining this line to the next
  });

  const text = prefix + lines.map(l => l.text).join('\n') + '\n';

  const requests = [{ insertText: { location: { index: insertAt }, text } }];

  // Strip any stray inherited formatting/highlighting from body text, leaving
  // heading paragraphs untouched so they keep the named style's own look.
  resetRanges.forEach(({ start, end }) => {
    requests.push({
      updateTextStyle: {
        range: { startIndex: start, endIndex: end },
        textStyle: {
          bold: false, italic: false, underline: false, strikethrough: false,
          backgroundColor: {}, foregroundColor: {}
        },
        fields: 'bold,italic,underline,strikethrough,backgroundColor,foregroundColor'
      }
    });
  });

  headingRanges.forEach(({ start, end, heading }) => {
    requests.push({
      updateParagraphStyle: {
        range: { startIndex: start, endIndex: end },
        paragraphStyle: { namedStyleType: heading === 2 ? 'HEADING_2' : 'HEADING_3' },
        fields: 'namedStyleType'
      }
    });
  });

  // Insert images last, in position order — each occupies one character, so
  // later placeholders shift by the count of images already inserted before them.
  const orderedPlaceholders = Object.entries(placeholders).sort((a, b) => a[1] - b[1]);
  orderedPlaceholders.forEach(([key, idx], i) => {
    requests.push({
      insertInlineImage: {
        location: { index: idx + i },
        uri: key === 'screenshot' ? screenshotUri : overallUri,
        objectSize: { width: { magnitude: 400, unit: 'PT' } }
      }
    });
  });

  const batchRes = await fetch(`https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests })
  });
  if (!batchRes.ok) {
    const err = await batchRes.json().catch(() => ({}));
    throw new Error(err.error?.message || `Docs API error ${batchRes.status}`);
  }
}

/* ─────────────────── Submit ─────────────────── */
async function submitToNotion(f) {
  const { title, desc, brief, status, severity, includeLogs, includeSteps, includeRequests, canvasBlob, overallBlob } = f;

  // Build inner page body
  const children = [];

  if (desc) {
      children.push(h2Block('Description'));
      const chunks = desc.match(/.{1,2000}/gs) || [desc];
      chunks.forEach(c => children.push(textBlock(c)));
    }

    if (includeSteps) {
      children.push(dividerBlock());
      children.push(h2Block('Steps to Reproduce'));
      if (userEvents.length > 0) {
        const stepsText = userEvents
          .map((e, i) => `${i + 1}. ${formatEvent(e)}`)
          .join('\n');
        children.push(...splitCodeBlocks(stepsText));
      } else {
        children.push(textBlock('No interaction steps were captured. Reload the page after installing/updating the extension to enable step tracking.'));
      }
    }

    if (includeLogs) {
      children.push(dividerBlock());
      children.push(h2Block('Console Logs'));
      if (consoleLogs.length > 0) {
        const logText = consoleLogs
          .map(l => `[${l.level.toUpperCase()}] ${l.time} — ${l.message}`)
          .join('\n');
        children.push(...splitCodeBlocks(logText));
      } else {
        children.push(textBlock('No console output was captured for this session. Reload the page after installing/updating the extension to enable log capture.'));
      }
    }

    if (includeRequests) {
      children.push(dividerBlock());
      children.push(h2Block('Network Requests'));
      if (userRequests.length > 0) {
        const reqText = userRequests.map(formatRequest).join('\n');
        children.push(...splitCodeBlocks(reqText));
      } else {
        children.push(textBlock('No network requests were captured. Reload the page after installing/updating the extension to enable request tracking.'));
      }
    }

    // Upload screenshot
    const screenshotId = await uploadFileToNotion(canvasBlob, 'screenshot.png');
    if (screenshotId) {
      children.push(dividerBlock());
      children.push(h2Block('Screenshot'));
      children.push(imageFileBlock(screenshotId));
    }

    // Upload overall area (full page with red rectangle)
    if (overallBlob) {
      const overallId = await uploadFileToNotion(overallBlob, 'overall-area.png');
      if (overallId) {
        children.push(dividerBlock());
        children.push(h2Block('Overall Area'));
        children.push(imageFileBlock(overallId));
      }
    }

    // Upload extra attachments
    for (const file of extraFiles) {
      if (file.type.startsWith('image/')) {
        const uploadId = await uploadFileToNotion(file, file.name);
        if (uploadId) children.push(imageFileBlock(uploadId));
      }
    }

    children.push(dividerBlock());
    children.push(h2Block('Report Details'));
    children.push(...MdevReportMetadata.lines(f.metadata).map(textBlock));

    // Build Notion page properties
    const properties = {
      'Title': { title: [{ type: 'text', text: { content: title } }] },
      'Status': { status: { name: status } },
      'Severity': { status: { name: severity } }
    };
    if (brief) {
      properties['Brief description'] = { rich_text: [{ type: 'text', text: { content: brief } }] };
    }
    if (pageUrl) {
      properties['Page URL'] = { url: pageUrl };
    }

    // Create Notion page
    const res = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: notionHeaders(),
      body: JSON.stringify({
        parent: { database_id: document.getElementById('f-database').value || NOTION_DB_ID },
        properties,
        children
      })
    });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.message || `Notion API error ${res.status}`);
  }
}

async function submitToGoogleDocs(f) {
  const { title, desc, brief, status, severity, includeLogs, includeSteps, includeRequests, canvasBlob, overallBlob } = f;

  const docId = await getGdocId();
  if (!docId) throw new Error('No Google Doc set — add one in the extension popup.');

  const stepsText = includeSteps
    ? (userEvents.length
        ? userEvents.map((e, i) => `${i + 1}. ${formatEvent(e)}`).join('\n')
        : 'No interaction steps were captured.')
    : '';
  const logsText = includeLogs
    ? (consoleLogs.length
        ? consoleLogs.map(l => `[${l.level.toUpperCase()}] ${l.time} — ${l.message}`).join('\n')
        : 'No console output was captured.')
    : '';
  const requestsText = includeRequests
    ? (userRequests.length ? userRequests.map(formatRequest).join('\n') : 'No network requests were captured.')
    : '';

  await appendReportToGoogleDoc(docId, {
    title, desc, brief, status, severity, pageUrl, metadata: f.metadata,
    stepsText, logsText, requestsText,
    screenshotBlob: canvasBlob,
    overallBlob
  });
}

document.getElementById('submit-btn').addEventListener('click', async () => {
  const title        = document.getElementById('f-title').value.trim();
  const desc         = document.getElementById('f-desc').value.trim();
  const brief        = document.getElementById('f-brief').value.trim();
  const status       = document.getElementById('f-status').value;
  const severity     = document.getElementById('f-severity').value;
  const includeLogs     = document.getElementById('f-logs').checked;
  const includeSteps    = document.getElementById('f-events').checked;
  const includeRequests = document.getElementById('f-requests').checked;
  const urlInput    = document.getElementById('f-url').value.trim();
  if (urlInput) pageUrl = urlInput;

  if (!title) { alert('Title is required.'); return; }

  const destination = document.getElementById('f-destination').value;
  if (destination === 'notion' && !NOTION_API_KEY) {
    alert(NOTION_SETUP_ERROR);
    return;
  }
  if (document.getElementById('f-destination-default').checked) {
    chrome.storage.sync.set({ defaultDestination: destination });
  }

  const btn = document.getElementById('submit-btn');
  btn.disabled = true; btn.textContent = 'Submitting…';

  try {
    const metadata = await MdevReportMetadata.collect();
    redrawCanvas(false);
    const canvasBlob = await new Promise(res => canvas.toBlob(res, 'image/png'));
    const overallBlob = await generateOverallImage();
    const fields = { metadata, title, desc, brief, status, severity, includeLogs, includeSteps, includeRequests, canvasBlob, overallBlob };

    if (destination === 'gdocs') {
      await submitToGoogleDocs(fields);
    } else {
      await submitToNotion(fields);
    }

    showToast(title, destination);
    setTimeout(() => window.close(), 2500);

  } catch (err) {
    alert('Error: ' + err.message);
    btn.disabled = false;
    btn.innerHTML = `<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M22 2L11 13"/><path d="M22 2L15 22 11 13 2 9l20-7z"/></svg> Submit Report`;
  }
});

function showToast(title, destination) {
  const toast = document.getElementById('toast');
  const label = destination === 'gdocs' ? 'Google Docs' : 'Notion';
  document.getElementById('toast-msg').textContent = `"${title}" has been added to ${label}.`;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 4000);
}

window.addEventListener('load', () => {
  // Keep background service worker alive while editor is open
  chrome.runtime.connect({ name: 'editor-keepalive' });

  // Full screenshot lives in background memory (avoids session storage size limits)
  chrome.runtime.sendMessage({ type: 'GET_FULL_SCREENSHOT' }, response => {
    if (response?.url) fullScreenshotUrl = response.url;
  });

  chrome.storage.session.get(['pendingScreenshot', 'pendingRect', 'pendingUrl', 'pendingTitle', 'pendingLogs', 'pendingEvents', 'pendingRequests'], (data) => {
    if (data.pendingScreenshot) loadImage(data.pendingScreenshot);
    if (data.pendingRect)       selectedRect = data.pendingRect;
    if (data.pendingUrl) {
      pageUrl = data.pendingUrl;
      document.getElementById('f-url').value = pageUrl;
    }
    if (data.pendingTitle) pageTitle = data.pendingTitle;
    if (data.pendingLogs)      consoleLogs  = data.pendingLogs;
    if (data.pendingEvents)    userEvents   = data.pendingEvents;
    if (data.pendingRequests)  userRequests = data.pendingRequests;

    // Run after pageUrl/pageTitle are known so the matching logic has data to work with
    loadDatabases();
    initDestinationSwitcher();

    const logsLabel     = document.getElementById('f-logs').nextElementSibling;
    const stepsLabel    = document.getElementById('f-events').nextElementSibling;
    const requestsLabel = document.getElementById('f-requests').nextElementSibling;
    if (logsLabel) {
      const c = consoleLogs.length;
      logsLabel.textContent = c > 0
        ? `Attach console logs to report (${c} captured)`
        : 'Attach console logs to report (0 captured — reload page to enable)';
    }
    if (stepsLabel) {
      const c = userEvents.length;
      stepsLabel.textContent = c > 0
        ? `Attach steps to reproduce (${c} steps captured)`
        : 'Attach steps to reproduce (0 captured — reload page to enable)';
    }
    if (requestsLabel) {
      const c = userRequests.length;
      requestsLabel.textContent = c > 0
        ? `Attach network requests (${c} captured)`
        : 'Attach network requests (0 captured — reload page to enable)';
    }
  });
});

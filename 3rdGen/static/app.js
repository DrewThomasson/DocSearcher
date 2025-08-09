/* Front-end logic with robust overlay lifecycle */
console.log("[app] build version:", window.APP_CONFIG?.buildVersion);

const pdfInput = document.getElementById('pdfInput');
const fileInfo = document.getElementById('fileInfo');
const wordsInput = document.getElementById('wordsInput');
const searchBtn = document.getElementById('searchBtn');
const resultsList = document.getElementById('resultsList');
const pageText = document.getElementById('pageText');
const legend = document.getElementById('legend');
const pagesDiv = document.getElementById('pages');
const statusMsg = document.getElementById('statusMsg');
const zoomIn = document.getElementById('zoomIn');
const zoomOut = document.getElementById('zoomOut');
const zoomVal = document.getElementById('zoomVal');
const divider = document.getElementById('divider');
const loadAllBtn = document.getElementById('loadAllBtn');
const ocrToggle = document.getElementById('ocrToggle');
const ocrLang = document.getElementById('ocrLang');
const downloadOcrLink = document.getElementById('downloadOcrLink');
const ocrStatusNote = document.getElementById('ocrStatusNote');

const processingOverlay = document.getElementById('processingOverlay');
const processingTitle = document.getElementById('processingTitle');
const processingDetail = document.getElementById('processingDetail');
const processingHint = document.getElementById('processingHint');
const processingError = document.getElementById('processingError');
const overlayCloseBtn = document.getElementById('overlayCloseBtn');
const processingSpinner = document.getElementById('processingSpinner');

ocrToggle.checked = false;
ocrLang.value = 'eng';

let currentDoc = null;
let currentWords = [];
let searchResults = [];
let currentSelectedPage = null;
let pageCache = {};
let currentScale = 1.0;
const MIN_SCALE = 0.5;
const MAX_SCALE = 2.5;
const SCALE_STEP = 0.15;

let matchPageSet = new Set();
let seamlessHighlightActive = false;

// Loading strategy
const LARGE_DOC_THRESHOLD = 80;
const AUTO_LOAD_PAGES_LARGE = 10;
const AUTO_LOAD_PAGES_SMALL = Infinity;

// Overlay state
let overlayCompletedTimestamp = null;
let overlayForceHideTimer = null;

function setStatus(msg) {
  statusMsg.textContent = msg;
}

function parseWords(raw) {
  return raw.trim()
    .split(/[,\s;]+/)
    .filter(Boolean)
    .map(w => w.toLowerCase())
    .filter((v,i,a)=>a.indexOf(v)===i);
}

/* Overlay helpers */
function showProcessingOverlay(title, detail, showHint=true) {
  processingTitle.textContent = title;
  processingDetail.textContent = detail || '';
  processingHint.style.display = showHint ? 'block' : 'none';
  processingError.style.display = 'none';
  overlayCloseBtn.style.display = 'none';
  processingSpinner.style.display = 'block';
  processingOverlay.classList.remove('hidden');
  overlayCompletedTimestamp = null;
  if (overlayForceHideTimer) {
    clearTimeout(overlayForceHideTimer);
    overlayForceHideTimer = null;
  }
}

function markOverlayCompleted(successMsg) {
  processingTitle.textContent = 'Completed';
  processingDetail.textContent = successMsg || 'Done.';
  processingHint.style.display = 'none';
  processingSpinner.style.display = 'none';
  overlayCompletedTimestamp = performance.now();

  // Show a manual close option if something delays automatic hiding
  setTimeout(() => {
    if (!processingOverlay.classList.contains('hidden')) {
      overlayCloseBtn.style.display = 'inline-flex';
    }
  }, 2500);
}

function showOverlayError(msg) {
  processingError.textContent = msg;
  processingError.style.display = 'block';
  processingSpinner.style.display = 'none';
  processingTitle.textContent = 'Error';
  processingHint.style.display = 'none';
  overlayCloseBtn.style.display = 'inline-flex';
}

function hideProcessingOverlay() {
  processingOverlay.classList.add('hidden');
  if (overlayForceHideTimer) {
    clearTimeout(overlayForceHideTimer);
    overlayForceHideTimer = null;
  }
}

overlayCloseBtn.addEventListener('click', hideProcessingOverlay);

/* Upload */
pdfInput.addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  resetAll();

  const wantsOCR = ocrToggle.checked;
  showProcessingOverlay(
    wantsOCR ? 'Performing OCR...' : 'Processing PDF...',
    wantsOCR
      ? 'Running OCR (deskew + text extraction). Please wait...'
      : 'Indexing document text. Please wait...',
    wantsOCR
  );

  setStatus("Uploading...");
  const fd = new FormData();
  fd.append("pdf", f);
  fd.append("ocr", String(wantsOCR));
  fd.append("lang", ocrLang.value.trim() || 'eng');

  let json;
  try {
    const res = await fetch("/api/upload", { method: "POST", body: fd });
    json = await res.json();
    if (!res.ok) {
      throw new Error(json.error || "Upload / processing failed");
    }
  } catch (err) {
    console.error("[upload] error:", err, json);
    setStatus(err.message || "Upload error");
    showOverlayError((json && json.error) ? json.error : err.message);
    return;
  }

  currentDoc = json;
  fileInfo.textContent = `${json.filename} (${json.pages} pages)`;
  enableZoom();
  enableLoadAllIfNeeded();

  // OCR status
  if (json.ocr_performed) {
    ocrStatusNote.style.display = 'block';
    if (json.ocr_failed) {
      ocrStatusNote.textContent = `OCR failed: ${json.ocr_message || 'Unknown error.'}`;
    } else {
      ocrStatusNote.textContent = json.ocr_message || 'OCR completed.';
    }
  } else {
    ocrStatusNote.style.display = 'none';
    ocrStatusNote.textContent = '';
  }

  // Download link
  if (json.ocr_performed && !json.ocr_failed && json.used_ocr_pdf) {
    try {
      const metaRes = await fetch(`/api/doc/${json.doc_id}/meta`);
      const metaJ = await metaRes.json();
      if (metaRes.ok && metaJ.download_ocr_url) {
        downloadOcrLink.href = metaJ.download_ocr_url;
        downloadOcrLink.style.display = 'inline-flex';
      }
    } catch (e) {
      console.warn("[meta] fetch failed:", e);
    }
  } else {
    downloadOcrLink.style.display = 'none';
  }

  // Let user know we’re now rendering
  markOverlayCompleted(
    (json.ocr_performed && !json.ocr_failed)
      ? `OCR finished in ${(json.ocr_time_seconds || 0).toFixed(1)}s. Rendering pages...`
      : (json.ocr_performed && json.ocr_failed)
        ? `Rendering original pages (OCR failed).`
        : `Rendering pages...`
  );

  // Render pages with safety
  try {
    setStatus("Rendering pages...");
    await autoRenderInitialPages();
    setStatus("Pages ready. Enter words & press Search.");
  } catch (renderErr) {
    console.error("[render] error:", renderErr);
    setStatus("Render error: " + renderErr.message);
    showOverlayError("Render error: " + renderErr.message);
    return;
  } finally {
    // Make sure overlay disappears even if something partially failed
    setTimeout(hideProcessingOverlay, 400); // small delay so user sees Completed
    // Absolute failsafe: force hide after 15s
    overlayForceHideTimer = setTimeout(() => {
      if (!processingOverlay.classList.contains('hidden')) {
        console.warn("[overlay] force hiding after timeout");
        hideProcessingOverlay();
      }
    }, 15000);
  }
});

/* Load All Pages */
loadAllBtn.addEventListener('click', async () => {
  if (!currentDoc) return;
  loadAllBtn.disabled = true;
  setStatus("Loading remaining pages...");
  const start = performance.now();
  for (let p = 1; p <= currentDoc.pages; p++) {
    if (!pageCache[p]) {
      await safeEnsurePage(p);
    }
    if (p % 5 === 0) setStatus(`Loading remaining pages ${p}/${currentDoc.pages}...`);
  }
  const dur = (performance.now() - start)/1000;
  setStatus(`All pages loaded (${dur.toFixed(1)}s).`);
  if (seamlessHighlightActive) highlightAllMatchPages();
});

function enableLoadAllIfNeeded() {
  if (!currentDoc) {
    loadAllBtn.disabled = true;
    return;
  }
  loadAllBtn.disabled = currentDoc.pages <= LARGE_DOC_THRESHOLD;
}

/* Initial pages */
async function autoRenderInitialPages() {
  if (!currentDoc) return;
  const total = currentDoc.pages;
  const limit = (total > LARGE_DOC_THRESHOLD) ? AUTO_LOAD_PAGES_LARGE : AUTO_LOAD_PAGES_SMALL;
  const toLoad = Math.min(limit, total);
  for (let p = 1; p <= toLoad; p++) {
    await safeEnsurePage(p);
    if (p % 3 === 0 || p === toLoad) {
      setStatus(`Rendering pages ${p}/${toLoad}${toLoad < total ? ' (preview)' : ''}...`);
    }
  }
  if (toLoad < total) {
    setStatus(`Preview loaded (${toLoad}/${total}). Load All Pages or search.`);
  }
}

async function safeEnsurePage(pageNum) {
  try {
    await ensurePageLoaded(pageNum);
  } catch (e) {
    console.error(`[page ${pageNum}] load error:`, e);
    setStatus(`Page ${pageNum} load error: ${e.message}`);
  }
}

/* Search */
searchBtn.addEventListener('click', runSearch);
wordsInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') runSearch();
});

async function runSearch() {
  if (!currentDoc) {
    setStatus("Upload a PDF first.");
    return;
  }
  const raw = wordsInput.value;
  const words = parseWords(raw);
  currentWords = words;
  updateLegend(words);

  clearAllHighlights();
  seamlessHighlightActive = false;
  matchPageSet.clear();

  if (!words.length) {
    resultsList.innerHTML = '';
    pageText.value = '';
    setStatus("No words entered.");
    return;
  }

  setStatus("Searching...");
  let data;
  try {
    const res = await fetch(`/api/doc/${currentDoc.doc_id}/search`, {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({words: raw})
    });
    data = await res.json();
    if (!res.ok) throw new Error(data.error || "Search failed");
  } catch (err) {
    console.error("[search] error:", err, data);
    setStatus(err.message);
    return;
  }
  searchResults = data.results || [];
  populateResults();
  if (!searchResults.length) {
    setStatus("No pages found.");
    pageText.value = '';
    return;
  }
  setStatus(`Found ${searchResults.length} page(s). Loading matches...`);
  matchPageSet = new Set(searchResults.map(r => r.page));
  await preloadMatchPagesWithProgress();
  seamlessHighlightActive = true;
  highlightAllMatchPages();
  selectResultIndex(0, {preserveHighlights:true});
  setStatus(`Highlights across ${searchResults.length} page(s). Scroll freely.`);
}

function updateLegend(words) {
  legend.innerHTML = '';
  if (!words.length) {
    legend.innerHTML = '<span class="dim">No words</span>';
    return;
  }
  const sw = document.createElement('div');
  sw.className = 'swatch';
  legend.appendChild(sw);
  const txt = document.createElement('div');
  txt.textContent = words.join(', ');
  legend.appendChild(txt);
}

async function preloadMatchPagesWithProgress() {
  const pages = Array.from(matchPageSet).sort((a,b)=>a-b);
  const total = pages.length;
  for (let i=0; i<pages.length; i++) {
    await safeEnsurePage(pages[i]);
    if ((i+1)%5===0 || i===total-1) {
      setStatus(`Loading match pages ${i+1}/${total}...`);
    }
    await new Promise(r=>requestAnimationFrame(r));
  }
}

function populateResults() {
  resultsList.innerHTML = '';
  if (!searchResults.length) {
    const li = document.createElement('li');
    li.textContent = '[No pages]';
    li.classList.add('dim');
    resultsList.appendChild(li);
    return;
  }
  searchResults.forEach((r, idx) => {
    const li = document.createElement('li');
    const parts = [];
    currentWords.forEach(w => {
      const c = r.counts[w] || 0;
      if (c) parts.push(`${w}:${c}`);
    });
    li.innerHTML = `<span>Pg ${r.page}</span><span style="opacity:.75">${parts.join(', ')}</span>`;
    li.addEventListener('click', async () => {
      await safeEnsurePage(r.page);
      selectResultIndex(idx, {preserveHighlights:true});
    });
    resultsList.appendChild(li);
  });
}

async function selectResultIndex(idx, opts = {}) {
  if (idx < 0 || idx >= searchResults.length) return;
  [...resultsList.children].forEach((li,i)=>li.classList.toggle('active', i===idx));
  const r = searchResults[idx];
  currentSelectedPage = r.page;
  await safeEnsurePage(r.page);
  showPageText(r.page);
  if (seamlessHighlightActive) {
    highlightPageMatches(r.page, {append:true});
  } else if (!opts.preserveHighlights) {
    clearAllHighlights();
    highlightPageMatches(r.page);
  }
  scrollPageIntoView(r.page);
}

function scrollPageIntoView(pageNum) {
  const el = document.querySelector(`.page[data-page="${pageNum}"]`);
  if (el) el.scrollIntoView({behavior:'smooth', block:'start'});
}

async function ensurePageLoaded(pageNum) {
  if (pageCache[pageNum]) return;
  if (!currentDoc) return;
  const res = await fetch(`/api/doc/${currentDoc.doc_id}/page/${pageNum}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Failed to load page ${pageNum}`);

  const pageEl = document.createElement('div');
  pageEl.className = 'page';
  pageEl.dataset.page = pageNum;

  const img = document.createElement('img');
  img.src = data.image_url;
  img.alt = `Page ${pageNum}`;
  img.decoding = 'async';
  img.loading = 'lazy';
  pageEl.appendChild(img);

  const label = document.createElement('div');
  label.className = 'page-label';
  label.textContent = `Page ${pageNum}`;
  pageEl.appendChild(label);

  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.style.position = 'absolute';
  overlay.style.inset = '0';
  overlay.style.pointerEvents = 'none';
  pageEl.appendChild(overlay);

  insertPageInOrder(pageEl);

  pageCache[pageNum] = {
    tokens: data.tokens,
    text: data.text,
    imageLoadedPromise: new Promise(resolve => {
      img.onload = () => resolve();
      img.onerror = () => resolve();
    }),
    overlay
  };
  await pageCache[pageNum].imageLoadedPromise;

  if (seamlessHighlightActive && matchPageSet.has(pageNum)) {
    highlightPageMatches(pageNum, {append:true});
  }
}

function insertPageInOrder(pageEl) {
  const num = parseInt(pageEl.dataset.page,10);
  const existing = [...pagesDiv.querySelectorAll('.page')];
  if (!existing.length) {
    pagesDiv.appendChild(pageEl);
    return;
  }
  for (let el of existing) {
    const p = parseInt(el.dataset.page,10);
    if (num < p) {
      pagesDiv.insertBefore(pageEl, el);
      return;
    }
  }
  pagesDiv.appendChild(pageEl);
}

function showPageText(pageNum) {
  const cache = pageCache[pageNum];
  if (!cache) return;
  const entry = searchResults.find(r=>r.page===pageNum);
  let summary = '';
  if (entry) {
    const parts = currentWords
      .map(w => `${w}=${entry.counts[w] || 0}`)
      .filter(x => !x.endsWith('=0'));
    if (parts.length) summary = 'Matches: '+parts.join(', ')+'\n'+'-'.repeat(40)+'\n';
  }
  pageText.value = summary + cache.text;
}

/* Highlighting */
function clearAllHighlights() {
  document.querySelectorAll('.hl-box').forEach(el => el.remove());
}
function clearHighlightsOnPage(pageNum) {
  const pageEl = document.querySelector(`.page[data-page="${pageNum}"]`);
  if (!pageEl) return;
  pageEl.querySelectorAll('.hl-box').forEach(el => el.remove());
}
function highlightPageMatches(pageNum, {append=false} = {}) {
  const cache = pageCache[pageNum];
  if (!cache || !currentWords.length) return;
  if (!append) clearHighlightsOnPage(pageNum);
  const targets = new Set(currentWords);
  const overlay = cache.overlay;
  const img = overlay.parentElement.querySelector('img');
  if (!img || !img.naturalWidth) return;
  const w = img.naturalWidth, h = img.naturalHeight;
  const scale = img.clientWidth / w;

  for (const tok of cache.tokens) {
    const lt = tok.text.toLowerCase();
    if (targets.has(lt)) {
      const [x0,y0,x1,y1] = tok.bbox;
      const box = document.createElement('div');
      box.className = 'hl-box';
      box.style.left = (x0 * w * scale) + 'px';
      box.style.top = (y0 * h * scale) + 'px';
      box.style.width = Math.max(2,(x1 - x0) * w * scale) + 'px';
      box.style.height = Math.max(2,(y1 - y0) * h * scale) + 'px';
      overlay.appendChild(box);
    }
  }
}
function highlightAllMatchPages() {
  for (const p of matchPageSet) {
    if (pageCache[p]) {
      clearHighlightsOnPage(p);
      highlightPageMatches(p, {append:true});
    }
  }
}

window.addEventListener('resize', () => {
  if (seamlessHighlightActive) highlightAllMatchPages();
  else if (currentSelectedPage) {
    clearHighlightsOnPage(currentSelectedPage);
    highlightPageMatches(currentSelectedPage);
  }
});

/* Zoom */
function enableZoom() {
  zoomIn.disabled = false;
  zoomOut.disabled = false;
}
function disableZoom() {
  zoomIn.disabled = true;
  zoomOut.disabled = true;
  currentScale = 1.0;
  zoomVal.textContent = '100%';
  pagesDiv.style.transform = '';
}
zoomIn.addEventListener('click', ()=>applyZoom(currentScale + SCALE_STEP));
zoomOut.addEventListener('click', ()=>applyZoom(currentScale - SCALE_STEP));

function applyZoom(newScale) {
  if (!currentDoc) return;
  newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, newScale));
  if (Math.abs(newScale - currentScale) < 0.001) return;
  currentScale = newScale;
  zoomVal.textContent = Math.round(currentScale * 100) + '%';
  pagesDiv.style.transformOrigin = 'top center';
  pagesDiv.style.transform = `scale(${currentScale})`;
}

/* Sidebar resize */
(function enableDivider() {
  let dragging = false;
  divider.addEventListener('mousedown', () => {
    dragging = true;
    document.body.style.userSelect = 'none';
    document.documentElement.style.cursor = 'col-resize';
  });
  window.addEventListener('mouseup', () => {
    if (dragging) {
      dragging = false;
      document.body.style.userSelect = '';
      document.documentElement.style.cursor = '';
      if (seamlessHighlightActive) highlightAllMatchPages();
      else if (currentSelectedPage) {
        clearHighlightsOnPage(currentSelectedPage);
        highlightPageMatches(currentSelectedPage);
      }
    }
  });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    const min = 220;
    const max = Math.min(window.innerWidth * 0.6, 700);
    const w = Math.max(min, Math.min(max, e.clientX));
    document.documentElement.style.setProperty('--sidebar-width', w + 'px');
  });
})();

/* Reset */
function resetAll() {
  currentDoc = null;
  currentWords = [];
  searchResults = [];
  currentSelectedPage = null;
  pageCache = {};
  matchPageSet.clear();
  seamlessHighlightActive = false;
  fileInfo.textContent = '';
  resultsList.innerHTML = '';
  pageText.value = '';
  legend.innerHTML = '<span class="dim">No words</span>';
  pagesDiv.innerHTML = '';
  disableZoom();
  loadAllBtn.disabled = true;
  pagesDiv.style.transform = '';
  downloadOcrLink.style.display = 'none';
  ocrStatusNote.style.display = 'none';
  setStatus("Ready.");
}

setStatus("Ready.");
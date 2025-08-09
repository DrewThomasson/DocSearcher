/* Front-end logic with buffered, on-demand highlight lifecycle + duplicate load guard + fast jump preloading */
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

/* Track in-flight page loads to prevent duplicates */
const pageLoadPromises = {};  // pageNum -> Promise

let matchPageSet = new Set();
let seamlessHighlightActive = false;

/* Buffered Highlight Configuration */
const HIGHLIGHT_BUFFER_BEFORE = 2;
const HIGHLIGHT_BUFFER_AFTER  = 2;
const PREFETCH_EXTRA_AHEAD    = 1;
let bufferedHighlightMode = true;

/* Buffered highlight state */
let currentCenterPage = null;
let highlightedPages = new Set();
let scrollDirection = 0; // -1 up, +1 down
let programmaticScrollInProgress = false;
let pageObserver = null;

/* Jump control */
let currentJumpToken = 0;

/* Loading strategy */
const LARGE_DOC_THRESHOLD = 80;
const AUTO_LOAD_PAGES_LARGE = 10;
const AUTO_LOAD_PAGES_SMALL = Infinity;

/* Overlay state */
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

  markOverlayCompleted(
    (json.ocr_performed && !json.ocr_failed)
      ? `OCR finished in ${(json.ocr_time_seconds || 0).toFixed(1)}s. Rendering pages...`
      : (json.ocr_performed && json.ocr_failed)
        ? `Rendering original pages (OCR failed).`
        : `Rendering pages...`
  );

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
    setTimeout(hideProcessingOverlay, 400);
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
    await safeEnsurePage(p);
    if (p % 5 === 0) setStatus(`Loading remaining pages ${p}/${currentDoc.pages}...`);
  }
  const dur = (performance.now() - start)/1000;
  setStatus(`All pages loaded (${dur.toFixed(1)}s).`);
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

/* Preload surrounding buffer for fast jumps */
async function preloadJumpWindow(centerPage) {
  const tasks = [];
  const start = Math.max(1, centerPage - HIGHLIGHT_BUFFER_BEFORE);
  const end   = Math.min(currentDoc.pages, centerPage + HIGHLIGHT_BUFFER_AFTER);
  for (let p = start; p <= end; p++) {
    if (!pageCache[p]) {
      tasks.push(safeEnsurePage(p));
    }
  }
  if (tasks.length) {
    await Promise.all(tasks);
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
  highlightedPages.clear();
  currentCenterPage = null;

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
  matchPageSet = new Set(searchResults.map(r => r.page));

  const firstPage = searchResults[0].page;
  await safeEnsurePage(firstPage);
  currentJumpToken++; // reset jump token context
  await preloadJumpWindow(firstPage);
  setCenterPage(firstPage, { fromClick:true });
  seamlessHighlightActive = true;
  selectResultIndex(0, {preserveHighlights:true, skipScroll:true}); // we'll scroll explicitly after window built
  scrollPageIntoView(firstPage);
  setStatus(`Ready. Highlight window centered at page ${firstPage}.`);
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
      const token = ++currentJumpToken;
      setStatus(`Jumping to page ${r.page}...`);
      // Load target + its highlight window first to avoid layout shift AFTER scroll
      await safeEnsurePage(r.page);
      await preloadJumpWindow(r.page);
      if (token !== currentJumpToken) return; // aborted by newer click
      await selectResultIndex(idx, {preserveHighlights:true, skipScroll:true});
      setCenterPage(r.page, { fromClick:true });
      // highlight window already loaded; updateHighlightWindow will just highlight
      scrollPageIntoView(r.page);
      setStatus(`Centered on page ${r.page}.`);
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

  if (!bufferedHighlightMode) {
    if (seamlessHighlightActive) {
      highlightPageMatches(r.page, {append:true});
    } else if (!opts.preserveHighlights) {
      clearAllHighlights();
      highlightPageMatches(r.page);
    }
  }

  if (!opts.skipScroll) {
    scrollPageIntoView(r.page);
  }
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

function scrollPageIntoView(pageNum) {
  const el = document.querySelector(`.page[data-page="${pageNum}"]`);
  if (el) {
    el.scrollIntoView({behavior:'smooth', block:'start'});
  }
}

/* Observer */
function ensurePageObserver() {
  if (pageObserver) return;
  pageObserver = new IntersectionObserver(handlePageIntersections, {
    root: document.getElementById('pagesWrap'),
    rootMargin: '0px',
    threshold: [0.25, 0.5, 0.75]
  });
}

function handlePageIntersections(entries) {
  if (!bufferedHighlightMode || !entries.length) return;
  if (programmaticScrollInProgress) return;

  let best = null;
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    if (!best || e.intersectionRatio > best.intersectionRatio) {
      best = e;
    }
  }
  if (!best) return;
  const pageNum = parseInt(best.target.dataset.page, 10);
  if (currentCenterPage !== pageNum) {
    if (currentCenterPage != null) {
      scrollDirection = pageNum > currentCenterPage ? 1 : -1;
    }
    setCenterPage(pageNum);
  }
}

function setCenterPage(pageNum, { fromClick=false } = {}) {
  currentCenterPage = pageNum;
  updateHighlightWindow();
  if (fromClick) {
    programmaticScrollInProgress = true;
    setTimeout(() => { programmaticScrollInProgress = false; }, 800);
  }
}

function updateHighlightWindow() {
  if (!currentDoc || !bufferedHighlightMode) return;
  if (currentCenterPage == null) return;

  const start = Math.max(1, currentCenterPage - HIGHLIGHT_BUFFER_BEFORE);
  const end   = Math.min(currentDoc.pages, currentCenterPage + HIGHLIGHT_BUFFER_AFTER);

  for (const p of Array.from(highlightedPages)) {
    if (p < start || p > end) {
      clearHighlightsOnPage(p);
      highlightedPages.delete(p);
    }
  }

  const activatePage = async (p) => {
    if (!matchPageSet.has(p)) return;
    await safeEnsurePage(p);
    highlightPageMatches(p, { append:false });
    highlightedPages.add(p);
  };

  const promises = [];
  for (let p = start; p <= end; p++) {
    if (matchPageSet.has(p) && !highlightedPages.has(p)) {
      if (pageCache[p]) {
        highlightPageMatches(p, { append:false });
        highlightedPages.add(p);
      } else {
        promises.push(activatePage(p));
      }
    } else if (!pageCache[p] && matchPageSet.has(p)) {
      promises.push(safeEnsurePage(p).then(()=>{
        highlightPageMatches(p,{append:false});
        highlightedPages.add(p);
      }));
    }
  }

  if (scrollDirection !== 0) {
    const aheadStart = scrollDirection > 0 ? end + 1 : start - PREFETCH_EXTRA_AHEAD;
    const aheadEnd = scrollDirection > 0
      ? Math.min(currentDoc.pages, end + PREFETCH_EXTRA_AHEAD)
      : Math.max(1, start - 1);
    for (let p = aheadStart; scrollDirection > 0 ? p <= aheadEnd : p >= aheadEnd; p += scrollDirection > 0 ? 1 : -1) {
      if (matchPageSet.has(p) && !pageCache[p]) {
        promises.push(safeEnsurePage(p));
      }
    }
  }

  Promise.all(promises).catch(e=>console.warn('[buffer] window update error', e));
}

/* Duplicate prevention + dedupe logic */
function dedupePageDom(pageNum) {
  const nodes = pagesDiv.querySelectorAll(`.page[data-page="${pageNum}"]`);
  if (nodes.length <= 1) return;
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].remove();
}

async function ensurePageLoaded(pageNum) {
  if (pageCache[pageNum]) return;
  if (pageLoadPromises[pageNum]) return pageLoadPromises[pageNum];

  pageLoadPromises[pageNum] = (async () => {
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
    dedupePageDom(pageNum);

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

    ensurePageObserver();
    pageObserver.observe(pageEl);

    if (bufferedHighlightMode && matchPageSet.has(pageNum)) {
      const inWindow =
        currentCenterPage != null &&
        pageNum >= currentCenterPage - HIGHLIGHT_BUFFER_BEFORE &&
        pageNum <= currentCenterPage + HIGHLIGHT_BUFFER_AFTER;
      if (inWindow) {
        highlightPageMatches(pageNum, { append:false });
        highlightedPages.add(pageNum);
      }
    } else if (seamlessHighlightActive && !bufferedHighlightMode && matchPageSet.has(pageNum)) {
      highlightPageMatches(pageNum, {append:true});
    }
  })();

  try {
    await pageLoadPromises[pageNum];
  } finally {
    delete pageLoadPromises[pageNum];
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
  const frag = document.createDocumentFragment();
  for (const tok of cache.tokens) {
    const lt = tok.text.toLowerCase();
    if (targets.has(lt)) {
      const [x0,y0,x1,y1] = tok.bbox;
      const box = document.createElement('div');
      box.className = 'hl-box';
      box.style.left   = (x0 * 100) + '%';
      box.style.top    = (y0 * 100) + '%';
      box.style.width  = ((x1 - x0) * 100) + '%';
      box.style.height = ((y1 - y0) * 100) + '%';
      frag.appendChild(box);
    }
  }
  overlay.appendChild(frag);
}

/* Resize (no-op) */
window.addEventListener('resize', () => {});

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
  highlightedPages.clear();
  currentCenterPage = null;
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
  if (pageObserver) {
    pageObserver.disconnect();
    pageObserver = null;
  }
  for (const k in pageLoadPromises) {
    // Best-effort; cannot actually cancel fetch.
  }
}

setStatus("Ready.");
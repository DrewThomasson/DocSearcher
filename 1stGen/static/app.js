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

let currentDoc = null;
let currentWords = [];
let searchResults = [];
let currentSelectedPage = null;
let pageCache = {};
let currentScale = 1.0;
const MIN_SCALE = 0.5;
const MAX_SCALE = 2.5;
const SCALE_STEP = 0.15;

// Auto load strategy
const LARGE_DOC_THRESHOLD = 80;
const AUTO_LOAD_PAGES_LARGE = 10; // first N pages if large
const AUTO_LOAD_PAGES_SMALL = Infinity; // load all if small

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

// ---------------- Upload Handling ----------------
pdfInput.addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  resetAll();
  setStatus("Uploading PDF...");
  const fd = new FormData();
  fd.append("pdf", f);
  try {
    const res = await fetch("/api/upload", { method: "POST", body: fd });
    const j = await res.json();
    if (!res.ok) {
      setStatus(j.error || "Upload failed.");
      return;
    }
    currentDoc = j;
    fileInfo.textContent = `${j.filename} (${j.pages} pages)`;
    enableZoom();
    enableLoadAllIfNeeded();
    setStatus(`Loaded '${j.filename}'. Rendering pages...`);
    await autoRenderInitialPages();
    setStatus(`Pages ready. Enter words & press Search.`);
  } catch (err) {
    console.error(err);
    setStatus("Upload error.");
  }
});

function enableLoadAllIfNeeded() {
  if (!currentDoc) {
    loadAllBtn.disabled = true;
    return;
  }
  if (currentDoc.pages > LARGE_DOC_THRESHOLD) {
    loadAllBtn.disabled = false;
  } else {
    loadAllBtn.disabled = true;
  }
}

loadAllBtn.addEventListener('click', async () => {
  if (!currentDoc) return;
  loadAllBtn.disabled = true;
  setStatus("Loading remaining pages...");
  const start = performance.now();
  for (let p = 1; p <= currentDoc.pages; p++) {
    if (!pageCache[p]) {
      await ensurePageLoaded(p);
    }
    if (p % 5 === 0) setStatus(`Loading remaining pages ${p}/${currentDoc.pages}...`);
  }
  const dur = (performance.now() - start) / 1000;
  setStatus(`All pages loaded (${dur.toFixed(1)}s).`);
});

// ---------------- Initial Rendering Strategy ----------------
async function autoRenderInitialPages() {
  if (!currentDoc) return;
  const total = currentDoc.pages;
  const limit = (total > LARGE_DOC_THRESHOLD) ? AUTO_LOAD_PAGES_LARGE : AUTO_LOAD_PAGES_SMALL;
  const toLoad = Math.min(limit, total);
  for (let p = 1; p <= toLoad; p++) {
    await ensurePageLoaded(p);
    if (p % 3 === 0 || p === toLoad) {
      setStatus(`Rendering pages ${p}/${toLoad}${toLoad < total ? ` (partial preview)` : ''}...`);
    }
  }
  if (toLoad < total) {
    setStatus(`Preview loaded (${toLoad}/${total}). Click 'Load All Pages' or run a search.`);
  }
}

// ---------------- Search ----------------
searchBtn.addEventListener('click', () => {
  runSearch();
});
wordsInput.addEventListener('keydown', (e) => {
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
  legend.innerHTML = '';
  if (words.length === 0) {
    legend.innerHTML = '<span class="dim">No words</span>';
    resultsList.innerHTML = '';
    pageText.value = '';
    clearPageHighlights();
    setStatus("No words entered.");
    return;
  }
  // Legend
  const sw = document.createElement('div');
  sw.className = 'swatch';
  legend.appendChild(sw);
  const txt = document.createElement('div');
  txt.textContent = words.join(', ');
  legend.appendChild(txt);

  setStatus("Searching...");
  try {
    const res = await fetch(`/api/doc/${currentDoc.doc_id}/search`, {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({words: raw})
    });
    const j = await res.json();
    if (!res.ok) {
      setStatus(j.error || "Search failed.");
      return;
    }
    searchResults = j.results || [];
    populateResults();
    clearPageHighlights();
    if (searchResults.length > 0) {
      setStatus(`Found ${searchResults.length} page(s).`);
      // Ensure first result page is loaded (even if not in initial preview)
      await ensurePageLoaded(searchResults[0].page);
      selectResultIndex(0);
    } else {
      setStatus("No pages found.");
      pageText.value = '';
    }
  } catch (err) {
    console.error(err);
    setStatus("Search error.");
  }
}

function populateResults() {
  resultsList.innerHTML = '';
  if (searchResults.length === 0) {
    const li = document.createElement('li');
    li.textContent = '[No pages]';
    li.classList.add('dim');
    resultsList.appendChild(li);
    return;
  }
  searchResults.forEach((r, idx) => {
    const li = document.createElement('li');
    const countsParts = [];
    currentWords.forEach(w => {
      const c = r.counts[w] || 0;
      if (c) countsParts.push(`${w}:${c}`);
    });
    li.innerHTML = `<span>Pg ${r.page}</span><span style="opacity:.75">${countsParts.join(', ')}</span>`;
    li.addEventListener('click', async () => {
      await ensurePageLoaded(r.page);
      selectResultIndex(idx);
    });
    resultsList.appendChild(li);
  });
}

// ---------------- Page Loading & Display ----------------
async function selectResultIndex(idx) {
  if (idx < 0 || idx >= searchResults.length) return;
  [...resultsList.children].forEach((li, i) => {
    li.classList.toggle('active', i === idx);
  });
  const r = searchResults[idx];
  currentSelectedPage = r.page;
  await ensurePageLoaded(r.page);
  showPageText(r.page);
  highlightPageMatches(r.page);
  scrollPageIntoView(r.page);
}

function scrollPageIntoView(pageNum) {
  const pageDiv = document.querySelector(`.page[data-page="${pageNum}"]`);
  if (pageDiv) {
    pageDiv.scrollIntoView({behavior: 'smooth', block:'start'});
  }
}

async function ensurePageLoaded(pageNum) {
  if (pageCache[pageNum]) return;
  if (!currentDoc) return;
  try {
    const metaRes = await fetch(`/api/doc/${currentDoc.doc_id}/page/${pageNum}`);
    const data = await metaRes.json();
    if (!metaRes.ok) {
      setStatus(data.error || `Failed to load page ${pageNum}.`);
      return;
    }
    // Create page element
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
      imageLoadedPromise: new Promise((resolve) => {
        img.onload = () => resolve();
        img.onerror = () => resolve(); // still resolve to avoid blocking
      }),
      overlay
    };
    await pageCache[pageNum].imageLoadedPromise;
  } catch (err) {
    console.error(err);
    setStatus(`Page ${pageNum} load error.`);
  }
}

function insertPageInOrder(pageEl) {
  const pageNum = parseInt(pageEl.dataset.page, 10);
  const existing = [...pagesDiv.querySelectorAll('.page')];
  if (existing.length === 0) {
    pagesDiv.appendChild(pageEl);
    return;
  }
  for (let el of existing) {
    const p = parseInt(el.dataset.page, 10);
    if (pageNum < p) {
      pagesDiv.insertBefore(pageEl, el);
      return;
    }
  }
  pagesDiv.appendChild(pageEl);
}

function showPageText(pageNum) {
  const cache = pageCache[pageNum];
  if (!cache) return;
  const summaryEntry = searchResults.find(r => r.page === pageNum);
  let summary = '';
  if (summaryEntry) {
    const parts = currentWords
      .map(w => `${w}=${summaryEntry.counts[w] || 0}`)
      .filter(s => !s.endsWith('=0'));
    if (parts.length) summary = 'Matches: ' + parts.join(', ') + '\n' + '-'.repeat(40) + '\n';
  }
  pageText.value = summary + cache.text;
}

// ---------------- Highlighting ----------------
function clearPageHighlights() {
  document.querySelectorAll('.hl-box').forEach(el => el.remove());
}

function highlightPageMatches(pageNum) {
  clearPageHighlights();
  const cache = pageCache[pageNum];
  if (!cache) return;
  if (!currentWords.length) return;
  const targets = new Set(currentWords);
  const overlay = cache.overlay;
  const imgEl = overlay.parentElement.querySelector('img');
  if (!imgEl || !imgEl.naturalWidth) return;

  const w = imgEl.naturalWidth;
  const h = imgEl.naturalHeight;
  const renderedW = imgEl.clientWidth;
  const scale = renderedW / w;

  overlay.innerHTML = '';
  for (const tok of cache.tokens) {
    const lt = tok.text.toLowerCase();
    if (targets.has(lt)) {
      const [x0,y0,x1,y1] = tok.bbox;
      const box = document.createElement('div');
      box.className = 'hl-box';
      box.style.left = (x0 * w * scale) + 'px';
      box.style.top = (y0 * h * scale) + 'px';
      box.style.width = Math.max(2, (x1 - x0) * w * scale) + 'px';
      box.style.height = Math.max(2, (y1 - y0) * h * scale) + 'px';
      overlay.appendChild(box);
    }
  }
}

// Recompute highlights on window resize
window.addEventListener('resize', () => {
  if (currentSelectedPage) highlightPageMatches(currentSelectedPage);
});

// ---------------- Zoom ----------------
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

zoomIn.addEventListener('click', ()=> applyZoom(currentScale + SCALE_STEP));
zoomOut.addEventListener('click', ()=> applyZoom(currentScale - SCALE_STEP));

async function applyZoom(newScale) {
  if (!currentDoc) return;
  newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, newScale));
  if (Math.abs(newScale - currentScale) < 0.001) return;
  currentScale = newScale;
  zoomVal.textContent = Math.round(currentScale * 100) + '%';
  pagesDiv.style.transformOrigin = 'top center';
  pagesDiv.style.transform = `scale(${currentScale})`;
  // Recompute highlight sizes (they scale via transform; if you want pixel-perfect, recalc)
  if (currentSelectedPage) highlightPageMatches(currentSelectedPage);
}

// ---------------- Sidebar Resize ----------------
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
      if (currentSelectedPage) highlightPageMatches(currentSelectedPage);
    }
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const min = 220;
    const max = Math.min(window.innerWidth * 0.6, 700);
    const w = Math.max(min, Math.min(max, e.clientX));
    document.documentElement.style.setProperty('--sidebar-width', w + 'px');
  });
})();

// ---------------- Reset ----------------
function resetAll() {
  currentDoc = null;
  currentWords = [];
  searchResults = [];
  currentSelectedPage = null;
  pageCache = {};
  fileInfo.textContent = '';
  resultsList.innerHTML = '';
  pageText.value = '';
  legend.innerHTML = '<span class="dim">No words</span>';
  pagesDiv.innerHTML = '';
  disableZoom();
  loadAllBtn.disabled = true;
  pagesDiv.style.transform = '';
  setStatus("Ready.");
}

// ---------------- Init ----------------
setStatus("Ready.");
import io
import os
import time
import uuid
import threading
import argparse
from dataclasses import dataclass, field
from typing import Dict, List, Tuple, Optional

from flask import (
    Flask, render_template, request, jsonify, send_file, abort
)
from PIL import Image
import fitz  # PyMuPDF

# -----------------------------------------
# Configuration
# -----------------------------------------
IMAGE_DPI_SCALE = 1.6       # Page rendering zoom (1.0 = 72dpi). 1.6 ≈ 115dpi.
PAGE_IMAGE_FORMAT = "PNG"
HIGHLIGHT_COLOR = "#FFA800"
DOC_EXPIRY_SECONDS = 60 * 60  # 1 hour inactivity auto-clean
CLEAN_INTERVAL_SECONDS = 600  # 10 min cleanup frequency
MAX_PAGES = 3000              # Safety limit
MAX_FILE_SIZE_MB = 200        # Safety limit

app = Flask(__name__)

# -----------------------------------------
# Data Structures
# -----------------------------------------
@dataclass
class PageWord:
    text: str
    bbox: Tuple[float, float, float, float]  # normalized (x0,y0,x1,y1)

@dataclass
class DocumentData:
    doc_id: str
    filename: str
    pages: int
    uploaded_at: float
    last_access: float
    pdf_path: str
    page_text: Dict[int, str] = field(default_factory=dict)
    page_words: Dict[int, List[PageWord]] = field(default_factory=dict)
    page_image_cache: Dict[int, bytes] = field(default_factory=dict)  # page -> PNG bytes

    def touch(self):
        self.last_access = time.time()

# -----------------------------------------
# In-Memory Store
# -----------------------------------------
class DocumentStore:
    def __init__(self):
        self._docs: Dict[str, DocumentData] = {}
        self._lock = threading.Lock()
        self._last_clean = 0.0

    def add(self, doc: DocumentData):
        with self._lock:
            self._docs[doc.doc_id] = doc

    def get(self, doc_id: str) -> Optional[DocumentData]:
        with self._lock:
            doc = self._docs.get(doc_id)
            if doc:
                doc.touch()
        return doc

    def cleanup(self):
        now = time.time()
        if now - self._last_clean < CLEAN_INTERVAL_SECONDS:
            return
        with self._lock:
            remove_ids = [
                k for k, v in self._docs.items()
                if now - v.last_access > DOC_EXPIRY_SECONDS
            ]
            for rid in remove_ids:
                try:
                    os.remove(self._docs[rid].pdf_path)
                except Exception:
                    pass
                del self._docs[rid]
            self._last_clean = now

store = DocumentStore()

# -----------------------------------------
# PDF Processing
# -----------------------------------------
def extract_pdf(pdf_path: str) -> Tuple[Dict[int, str], Dict[int, List[PageWord]]]:
    page_text = {}
    page_words = {}
    doc = fitz.open(pdf_path)
    try:
        if len(doc) > MAX_PAGES:
            raise ValueError(f"PDF exceeds page limit ({MAX_PAGES}).")
        for pidx, page in enumerate(doc, start=1):
            page_text[pidx] = page.get_text()
            w, h = page.rect.width, page.rect.height
            words_raw = page.get_text("words")
            tokens: List[PageWord] = []
            for wr in words_raw:
                if len(wr) >= 5:
                    x0, y0, x1, y1, wtext = wr[0], wr[1], wr[2], wr[3], wr[4]
                    if not wtext.strip():
                        continue
                    tokens.append(PageWord(text=wtext, bbox=(x0 / w, y0 / h, x1 / w, y1 / h)))
            page_words[pidx] = tokens
    finally:
        doc.close()
    return page_text, page_words

def render_page_image(pdf_path: str, page_number: int, zoom: float) -> bytes:
    doc = fitz.open(pdf_path)
    try:
        page = doc[page_number - 1]
        mat = fitz.Matrix(zoom, zoom)
        pix = page.get_pixmap(matrix=mat, alpha=False)
        img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
        buf = io.BytesIO()
        img.save(buf, format=PAGE_IMAGE_FORMAT)
        return buf.getvalue()
    finally:
        doc.close()

# -----------------------------------------
# Helpers
# -----------------------------------------
def parse_query_words(raw: str) -> List[str]:
    import re
    tokens = re.split(r"[,\s;]+", raw.strip())
    out = []
    seen = set()
    for t in tokens:
        if not t:
            continue
        norm = t.lower()
        if norm not in seen:
            seen.add(norm)
            out.append(norm)
    return out

def find_pages_with_words(doc_data: DocumentData, words: List[str]):
    results = []
    targets = set(words)
    for page_num, tokens in doc_data.page_words.items():
        counts = {w: 0 for w in words}
        any_match = False
        for tok in tokens:
            low = tok.text.lower()
            if low in targets:
                counts[low] += 1
                any_match = True
        if any_match:
            total = sum(counts.values())
            results.append({
                "page": page_num,
                "counts": counts,
                "total_matches": total
            })
    results.sort(key=lambda r: r["page"])
    return results

# -----------------------------------------
# Routes
# -----------------------------------------
@app.route("/")
def index():
    store.cleanup()
    return render_template("index.html",
                           highlight_color=HIGHLIGHT_COLOR)

@app.post("/api/upload")
def api_upload():
    store.cleanup()
    f = request.files.get("pdf")
    if not f:
        return jsonify({"error": "No file uploaded."}), 400
    if not f.filename.lower().endswith(".pdf"):
        return jsonify({"error": "File must be a PDF."}), 400
    f.seek(0, os.SEEK_END)
    size_mb = f.tell() / (1024 * 1024)
    f.seek(0)
    if size_mb > MAX_FILE_SIZE_MB:
        return jsonify({"error": f"File too large (> {MAX_FILE_SIZE_MB} MB)."}), 400

    doc_id = uuid.uuid4().hex
    pdf_path = os.path.join("temp_" + doc_id + ".pdf")
    f.save(pdf_path)

    try:
        page_text, page_words = extract_pdf(pdf_path)
    except Exception as e:
        try:
            os.remove(pdf_path)
        except Exception:
            pass
        return jsonify({"error": f"Failed to process PDF: {e}"}), 500

    doc_data = DocumentData(
        doc_id=doc_id,
        filename=f.filename,
        pages=len(page_text),
        uploaded_at=time.time(),
        last_access=time.time(),
        pdf_path=pdf_path,
        page_text=page_text,
        page_words=page_words
    )
    store.add(doc_data)
    return jsonify({
        "doc_id": doc_id,
        "filename": f.filename,
        "pages": doc_data.pages
    })

@app.get("/api/doc/<doc_id>/meta")
def api_doc_meta(doc_id):
    doc = store.get(doc_id)
    if not doc:
        return jsonify({"error": "Not found"}), 404
    return jsonify({
        "doc_id": doc.doc_id,
        "filename": doc.filename,
        "pages": doc.pages
    })

@app.post("/api/doc/<doc_id>/search")
def api_search(doc_id):
    doc = store.get(doc_id)
    if not doc:
        return jsonify({"error": "Not found"}), 404
    data = request.get_json(silent=True) or {}
    raw_words = data.get("words", "")
    words = parse_query_words(raw_words)
    if not words:
        return jsonify({"pages": [], "words": []})
    results = find_pages_with_words(doc, words)
    return jsonify({
        "words": words,
        "results": results
    })

@app.get("/api/doc/<doc_id>/page/<int:page_num>")
def api_page(doc_id, page_num: int):
    doc = store.get(doc_id)
    if not doc:
        return jsonify({"error": "Not found"}), 404
    if page_num < 1 or page_num > doc.pages:
        return jsonify({"error": "Invalid page."}), 400

    # Render page image (cached)
    if page_num not in doc.page_image_cache:
        try:
            img_bytes = render_page_image(doc.pdf_path, page_num, IMAGE_DPI_SCALE)
            doc.page_image_cache[page_num] = img_bytes
        except Exception as e:
            return jsonify({"error": f"Failed to render page: {e}"}), 500

    # Provide bounding boxes & text
    token_list = [{
        "text": pw.text,
        "bbox": pw.bbox  # normalized
    } for pw in doc.page_words[page_num]]

    return jsonify({
        "page": page_num,
        "tokens": token_list,
        "text": doc.page_text.get(page_num, ""),
        "image_url": f"/api/doc/{doc_id}/page/{page_num}/image"
    })

@app.get("/api/doc/<doc_id>/page/<int:page_num>/image")
def api_page_image(doc_id, page_num):
    doc = store.get(doc_id)
    if not doc:
        abort(404)
    if page_num < 1 or page_num > doc.pages:
        abort(400)
    if page_num not in doc.page_image_cache:
        try:
            img_bytes = render_page_image(doc.pdf_path, page_num, IMAGE_DPI_SCALE)
            doc.page_image_cache[page_num] = img_bytes
        except Exception:
            abort(500)
    return send_file(
        io.BytesIO(doc.page_image_cache[page_num]),
        mimetype="image/png",
        as_attachment=False,
        download_name=f"{doc_id}_page_{page_num}.png"
    )

# -----------------------------------------
# CLI Entrypoint
# -----------------------------------------
def main():
    parser = argparse.ArgumentParser(description="Run PDF Word Finder Flask app.")
    parser.add_argument("--host", default="127.0.0.1", help="Host (use 0.0.0.0 for LAN).")
    parser.add_argument("--port", default=8000, type=int, help="Port number.")
    parser.add_argument("--debug", action="store_true", help="Enable Flask debug.")
    args = parser.parse_args()
    app.run(host=args.host, port=args.port, debug=args.debug)

if __name__ == "__main__":
    main()
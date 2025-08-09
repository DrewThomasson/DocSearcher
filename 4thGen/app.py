import io
import os
import time
import uuid
import argparse
import tempfile
import traceback
from dataclasses import dataclass, field
from typing import Dict, List, Tuple, Optional

from flask import (
    Flask, render_template, request, jsonify, send_file, abort
)
from PIL import Image
import fitz  # PyMuPDF
import ocrmypdf  # OCR engine

# -----------------------------------------
# Configuration
# -----------------------------------------
IMAGE_DPI_SCALE = 1.6          # Page rendering zoom (1.0 = 72dpi)
PAGE_IMAGE_FORMAT = "PNG"
HIGHLIGHT_COLOR = "#FFA800"
DOC_EXPIRY_SECONDS = 60 * 60    # 1 hour inactivity
CLEAN_INTERVAL_SECONDS = 600    # Cleanup frequency
MAX_PAGES = 3000                # Indexing safety
MAX_FILE_SIZE_MB = 800          # Raised size limit (adjust as desired)

# OCR configuration
OCR_DESKEW = True
OCR_OPTIMIZE = 3
OCR_SKIP_TEXT = True
OCR_MAX_PAGES = 5000
OCR_TIMEOUT_SECONDS = 1800
OCR_ROTATE_PAGES = True
OCR_ROTATE_PAGES_THRESHOLD = 1.0
DEBUG_OCR_ERRORS = True

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = MAX_FILE_SIZE_MB * 1024 * 1024

# -----------------------------------------
# Data Structures
# -----------------------------------------
@dataclass
class PageWord:
    text: str
    bbox: Tuple[float, float, float, float]  # normalized

@dataclass
class DocumentData:
    doc_id: str
    filename: str
    pages: int
    uploaded_at: float
    last_access: float
    original_pdf_path: str
    ocr_pdf_path: Optional[str]
    active_pdf_path: str
    ocr_performed: bool
    ocr_failed: bool
    ocr_message: Optional[str] = None
    ocr_time: Optional[float] = None
    page_text: Dict[int, str] = field(default_factory=dict)
    page_words: Dict[int, List[PageWord]] = field(default_factory=dict)
    page_image_cache: Dict[int, bytes] = field(default_factory=dict)

    def touch(self):
        self.last_access = time.time()

# -----------------------------------------
# In-Memory Store
# -----------------------------------------
class DocumentStore:
    def __init__(self):
        self._docs: Dict[str, DocumentData] = {}
        self._last_clean = 0.0

    def add(self, doc: DocumentData):
        self._docs[doc.doc_id] = doc

    def get(self, doc_id: str) -> Optional[DocumentData]:
        doc = self._docs.get(doc_id)
        if doc:
            doc.touch()
        return doc

    def cleanup(self):
        now = time.time()
        if now - self._last_clean < CLEAN_INTERVAL_SECONDS:
            return
        stale = [k for k, v in self._docs.items() if now - v.last_access > DOC_EXPIRY_SECONDS]
        for sid in stale:
            d = self._docs[sid]
            try:
                if os.path.exists(d.original_pdf_path):
                    os.remove(d.original_pdf_path)
            except Exception:
                pass
            if d.ocr_pdf_path:
                try:
                    if os.path.exists(d.ocr_pdf_path):
                        os.remove(d.ocr_pdf_path)
                except Exception:
                    pass
            del self._docs[sid]
        self._last_clean = now

store = DocumentStore()

# -----------------------------------------
# PDF / OCR Helpers
# -----------------------------------------
def extract_pdf(pdf_path: str) -> Tuple[Dict[int, str], Dict[int, List[PageWord]]]:
    page_text: Dict[int, str] = {}
    page_words: Dict[int, List[PageWord]] = {}
    doc = fitz.open(pdf_path)
    try:
        if len(doc) > MAX_PAGES:
            raise ValueError(f"PDF exceeds page limit ({MAX_PAGES}).")
        for idx, page in enumerate(doc, start=1):
            page_text[idx] = page.get_text()
            w, h = page.rect.width, page.rect.height
            words_raw = page.get_text("words")
            tokens: List[PageWord] = []
            for wr in words_raw:
                if len(wr) >= 5:
                    x0, y0, x1, y1, txt = wr[0], wr[1], wr[2], wr[3], wr[4]
                    if txt.strip():
                        tokens.append(PageWord(txt, (x0 / w, y0 / h, x1 / w, y1 / h)))
            page_words[idx] = tokens
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

def parse_query_words(raw: str) -> List[str]:
    import re
    tokens = re.split(r"[,\s;]+", raw.strip())
    out = []
    seen = set()
    for t in tokens:
        if not t:
            continue
        lt = t.lower()
        if lt not in seen:
            seen.add(lt)
            out.append(lt)
    return out

def find_pages_with_words(doc_data: DocumentData, words: List[str]):
    results = []
    targets = set(words)
    for pnum, toks in doc_data.page_words.items():
        counts = {w: 0 for w in words}
        any_match = False
        for tok in toks:
            low = tok.text.lower()
            if low in targets:
                counts[low] += 1
                any_match = True
        if any_match:
            results.append({
                "page": pnum,
                "counts": counts,
                "total_matches": sum(counts.values())
            })
    results.sort(key=lambda r: r["page"])
    return results

def perform_ocr(original_path: str, doc_id: str, lang: str):
    try:
        with fitz.open(original_path) as probe:
            if len(probe) > OCR_MAX_PAGES:
                return original_path, False, True, f"OCR aborted: exceeds {OCR_MAX_PAGES} pages.", None, 0.0
    except Exception as e:
        return original_path, False, True, f"OCR inspection failed: {e}", None, 0.0

    out_path = os.path.join(tempfile.gettempdir(), f"{doc_id}_ocr.pdf")
    if os.path.exists(out_path):
        try:
            os.remove(out_path)
        except Exception:
            pass

    ocr_args = dict(
        language=lang or "eng",
        deskew=OCR_DESKEW,
        optimize=OCR_OPTIMIZE,
        skip_text=OCR_SKIP_TEXT,
        tesseract_timeout=OCR_TIMEOUT_SECONDS,
        rotate_pages=OCR_ROTATE_PAGES,
        rotate_pages_threshold=OCR_ROTATE_PAGES_THRESHOLD,
    )
    start = time.time()
    try:
        ocrmypdf.ocr(original_path, out_path, **ocr_args)
        elapsed = time.time() - start
        if not os.path.exists(out_path) or os.path.getsize(out_path) == 0:
            return original_path, True, True, "OCR produced no output.", None, elapsed
        return out_path, True, False, f"OCR (rotate+deskew) completed in {elapsed:.1f}s.", out_path, elapsed
    except Exception as e:
        elapsed = time.time() - start
        tb = traceback.format_exc()
        msg = f"OCR failed after {elapsed:.1f}s: {e}"
        if DEBUG_OCR_ERRORS:
            msg += f"\n{tb}"
        return original_path, True, True, msg, None, elapsed

# -----------------------------------------
# Routes
# -----------------------------------------
@app.route("/")
def index():
    store.cleanup()
    return render_template("index.html", highlight_color=HIGHLIGHT_COLOR)

@app.post("/api/upload")
def api_upload():
    store.cleanup()
    up = request.files.get("pdf")
    if not up:
        return jsonify({"error": "No file uploaded"}), 400
    if not up.filename.lower().endswith(".pdf"):
        return jsonify({"error": "File must be a PDF"}), 400

    up.seek(0, os.SEEK_END)
    size_mb = up.tell() / (1024 * 1024)
    up.seek(0)
    if size_mb > MAX_FILE_SIZE_MB:
        return jsonify({"error": f"File too large (> {MAX_FILE_SIZE_MB} MB)"}), 400

    do_ocr = request.form.get("ocr", "false").lower() == "true"
    lang = request.form.get("lang", "eng").strip() or "eng"

    doc_id = uuid.uuid4().hex
    orig_path = os.path.join(tempfile.gettempdir(), f"upload_{doc_id}.pdf")
    up.save(orig_path)

    if do_ocr:
        active_path, ocr_performed, ocr_failed, ocr_message, ocr_pdf_path, ocr_time = perform_ocr(
            orig_path, doc_id, lang
        )
    else:
        active_path = orig_path
        ocr_performed = False
        ocr_failed = False
        ocr_message = None
        ocr_pdf_path = None
        ocr_time = None

    try:
        page_text, page_words = extract_pdf(active_path)
    except Exception as e:
        try:
            os.remove(orig_path)
        except Exception:
            pass
        if ocr_pdf_path:
            try:
                os.remove(ocr_pdf_path)
            except Exception:
                pass
        return jsonify({"error": f"Failed to process PDF: {e}"}), 500

    doc_data = DocumentData(
        doc_id=doc_id,
        filename=up.filename,
        pages=len(page_text),
        uploaded_at=time.time(),
        last_access=time.time(),
        original_pdf_path=orig_path,
        ocr_pdf_path=ocr_pdf_path,
        active_pdf_path=active_path,
        ocr_performed=ocr_performed,
        ocr_failed=ocr_failed,
        ocr_message=ocr_message,
        ocr_time=ocr_time,
        page_text=page_text,
        page_words=page_words
    )
    store.add(doc_data)

    return jsonify({
        "doc_id": doc_id,
        "filename": up.filename,
        "pages": doc_data.pages,
        "ocr_performed": ocr_performed,
        "ocr_failed": ocr_failed,
        "ocr_message": ocr_message,
        "ocr_time_seconds": ocr_time,
        "used_ocr_pdf": (active_path != orig_path),
        "rotate_pages": OCR_ROTATE_PAGES if do_ocr else False,
        "rotate_threshold": OCR_ROTATE_PAGES_THRESHOLD if do_ocr else None
    })

@app.get("/api/doc/<doc_id>/meta")
def api_doc_meta(doc_id):
    d = store.get(doc_id)
    if not d:
        return jsonify({"error": "Not found"}), 404
    return jsonify({
        "doc_id": d.doc_id,
        "filename": d.filename,
        "pages": d.pages,
        "ocr_performed": d.ocr_performed,
        "ocr_failed": d.ocr_failed,
        "ocr_message": d.ocr_message,
        "ocr_time_seconds": d.ocr_time,
        "download_ocr_url": f"/api/doc/{doc_id}/download/ocr"
            if d.ocr_performed and not d.ocr_failed and d.ocr_pdf_path else None
    })

@app.get("/api/doc/<doc_id>/download/ocr")
def api_download_ocr(doc_id):
    d = store.get(doc_id)
    if not d:
        return jsonify({"error": "Not found"}), 404
    if not d.ocr_pdf_path or not os.path.exists(d.ocr_pdf_path):
        return jsonify({"error": "No OCR PDF available"}), 404
    return send_file(d.ocr_pdf_path, mimetype="application/pdf", as_attachment=True,
                     download_name=f"{d.doc_id}_ocr.pdf")

@app.post("/api/doc/<doc_id>/search")
def api_search(doc_id):
    d = store.get(doc_id)
    if not d:
        return jsonify({"error": "Not found"}), 404
    payload = request.get_json(silent=True) or {}
    words = parse_query_words(payload.get("words", ""))
    if not words:
        return jsonify({"words": [], "results": []})
    results = find_pages_with_words(d, words)
    return jsonify({"words": words, "results": results})

@app.get("/api/doc/<doc_id>/page/<int:page_num>")
def api_page(doc_id, page_num: int):
    d = store.get(doc_id)
    if not d:
        return jsonify({"error": "Not found"}), 404
    if page_num < 1 or page_num > d.pages:
        return jsonify({"error": "Invalid page"}), 400

    if page_num not in d.page_image_cache:
        try:
            d.page_image_cache[page_num] = render_page_image(d.active_pdf_path, page_num, IMAGE_DPI_SCALE)
        except Exception as e:
            return jsonify({"error": f"Failed to render page: {e}"}), 500

    tokens = [{"text": w.text, "bbox": w.bbox} for w in d.page_words[page_num]]

    return jsonify({
        "page": page_num,
        "tokens": tokens,
        "text": d.page_text.get(page_num, ""),
        "image_url": f"/api/doc/{doc_id}/page/{page_num}/image"
    })

@app.get("/api/doc/<doc_id>/page/<int:page_num>/image")
def api_page_image(doc_id, page_num):
    d = store.get(doc_id)
    if not d:
        abort(404)
    if page_num < 1 or page_num > d.pages:
        abort(400)
    if page_num not in d.page_image_cache:
        try:
            d.page_image_cache[page_num] = render_page_image(d.active_pdf_path, page_num, IMAGE_DPI_SCALE)
        except Exception:
            abort(500)
    return send_file(
        io.BytesIO(d.page_image_cache[page_num]),
        mimetype="image/png",
        as_attachment=False,
        download_name=f"{doc_id}_page_{page_num}.png"
    )

def main():
    parser = argparse.ArgumentParser(description="Run PDF Word Finder with OCR (auto-rotate).")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()
    app.run(host=args.host, port=args.port, debug=args.debug)

if __name__ == "__main__":
    main()
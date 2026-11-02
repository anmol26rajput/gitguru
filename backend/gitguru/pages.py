"""Index a web page's text: one `files` row, chunked by headings then ~1,500-char paragraphs."""
import re
import time
from urllib.parse import urldefrag, urlsplit

from psycopg.types.json import Jsonb

from gitguru.chunk import Chunk
from gitguru.index import MAX_CHUNKS, Progress, _noop, store_chunks
from gitguru.ingest import IngestError

PAGE_PATH = "page.md"
PAGE_CHARS = 1500
MAX_TEXT = 200_000
HEADING = re.compile(r"#{1,6}\s+\S")


def page_source(url: str) -> str:
    """The URL without its #fragment (the repo's `source`)."""
    return urldefrag(url.strip()).url


CONTROL = re.compile("[\x00-\x1f\x7f\ud800-\udfff]")  # control chars and lone surrogates (a valid pair is one char)
SURROGATE = re.compile("[\ud800-\udfff]")
HOST = re.compile(r"(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?")  # host[:port]; no user@ part


def valid_url(url: str) -> bool:
    """Untrusted (the extension sends it): no control chars, whitespace or lone surrogates; a plain host."""
    if CONTROL.search(url) or any(c.isspace() for c in url):
        return False
    parts = urlsplit(url)
    return parts.scheme in ("http", "https") and bool(HOST.fullmatch(parts.netloc))


def clean_title(title: str) -> str:
    """One line of printable text: control chars and lone surrogates out, whitespace collapsed."""
    return " ".join(CONTROL.sub(" ", title).split())


def clean_text(text: str) -> str:
    """LF line ends, no NUL bytes (Postgres rejects them) or lone surrogates (not UTF-8), trimmed."""
    return SURROGATE.sub("", text).replace("\x00", "").replace("\r\n", "\n").replace("\r", "\n").strip()


def _pieces(start: int, lines: list[str]) -> list[tuple[int, int, str]]:
    """Cut an oversized paragraph into <= PAGE_CHARS pieces: by lines, and a long line by slices (same line number)."""
    out, cur, cur_start, size = [], [], start, 0
    for n, line in enumerate(lines, start):
        if len(line) > PAGE_CHARS:
            if cur:
                out.append((cur_start, n - 1, "\n".join(cur)))
            out += [(n, n, line[i:i + PAGE_CHARS]) for i in range(0, len(line), PAGE_CHARS)]
            cur, cur_start, size = [], n + 1, 0
        elif cur and size + len(line) + 1 > PAGE_CHARS:
            out.append((cur_start, n - 1, "\n".join(cur)))
            cur, cur_start, size = [line], n, len(line)
        else:
            cur, size = cur + [line], size + len(line) + 1
    if cur:
        out.append((cur_start, start + len(lines) - 1, "\n".join(cur)))
    return out


def _paragraphs(lines: list[str]) -> list[tuple[int, int, bool]]:
    """(start, end, starts_with_heading), 1-based inclusive: blank lines and heading lines both start a paragraph."""
    out: list[tuple[int, int, bool]] = []
    start = None
    for n, line in enumerate(lines, 1):
        blank, heading = not line.strip(), bool(HEADING.match(line))
        if start is not None and (blank or heading):
            out.append((start, n - 1, bool(HEADING.match(lines[start - 1]))))
            start = None
        if not blank and start is None:
            start = n
    if start is not None:
        out.append((start, len(lines), bool(HEADING.match(lines[start - 1]))))
    return out


def chunk_page(text: str, path: str = PAGE_PATH) -> list[Chunk]:
    """A new heading starts a new chunk; paragraphs are packed up to PAGE_CHARS. Line ranges point into `text`."""
    lines = text.split("\n")
    chunks: list[Chunk] = []
    cur: list[tuple[int, int]] = []  # packed paragraphs (start, end)
    cur_symbol: str | None = None
    heading: str | None = None

    def flush() -> None:
        if cur:
            s, e = cur[0][0], cur[-1][1]
            chunks.append(Chunk(path, s, e, "markdown", cur_symbol, "\n".join(lines[s - 1:e])))
            cur.clear()

    for s, e, is_heading in _paragraphs(lines):
        if is_heading:
            heading = lines[s - 1].lstrip("#").strip()[:100]
            flush()
        length = sum(map(len, lines[s - 1:e])) + (e - s)
        if length > PAGE_CHARS:
            flush()
            chunks += [Chunk(path, ps, pe, "markdown", heading, c) for ps, pe, c in _pieces(s, lines[s - 1:e])]
            continue
        if cur and sum(map(len, lines[cur[0][0] - 1:e])) + (e - cur[0][0]) > PAGE_CHARS:
            flush()
        if not cur:
            cur_symbol = heading
        cur.append((s, e))
    flush()
    return chunks


def index_page(conn, repo_id: int, text: str, progress: Progress = _noop) -> int:
    started = time.monotonic()
    conn.execute("UPDATE repos SET status = 'indexing' WHERE id = %s", (repo_id,))
    try:
        text = clean_text(text)
        if not text:
            raise IngestError("this page has no readable text")
        progress(10, "chunking the page")
        chunks = chunk_page(text)
        if len(chunks) > MAX_CHUNKS:
            raise IngestError(f"page too large for GitGuru v1 ({len(chunks)} chunks > {MAX_CHUNKS})")
        with conn.transaction():
            for table in ("chunks", "files", "repo_artifacts"):
                conn.execute(f"DELETE FROM {table} WHERE repo_id = %s", (repo_id,))
            conn.execute("INSERT INTO files (repo_id, path, lang, content) VALUES (%s, %s, 'markdown', %s)",
                         (repo_id, PAGE_PATH, text))
        progress(30, f"embedding {len(chunks)} chunks")
        store_chunks(conn, repo_id, chunks, "ast", progress)  # "ast" is the strategy retrieval reads
        stats = {"files": 1, "chunks": len(chunks), "skipped": 0, "seconds": round(time.monotonic() - started, 1)}
        conn.execute("UPDATE repos SET status = 'ready', stats = %s, last_used_at = now() WHERE id = %s",
                     (Jsonb(stats), repo_id))
        progress(100, "ready")
        return repo_id
    except Exception as e:
        conn.execute("UPDATE repos SET status = 'failed', stats = %s WHERE id = %s",
                     (Jsonb({"error": str(e)}), repo_id))
        raise

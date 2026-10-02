"""Index a source: ingest -> chunk -> embed -> store, reporting progress."""
import tempfile
import time
from collections.abc import Callable
from pathlib import Path

from psycopg.types.json import Jsonb

from gitguru.chunk import Chunk, chunk_file, detect_lang
from gitguru.embed import embed_texts
from gitguru.ingest import (IngestError, clone, github_check, local_head, normalize_github,
                            remote_head, walk)
from gitguru.search import split_identifiers

Progress = Callable[[int, str], None]
EMBED_BATCH = 32
MAX_CHUNKS = 20_000


def _noop(pct: int, msg: str) -> None:
    pass


def source_key(source: str) -> tuple[str, str]:
    if "github.com" in source:
        return "github", normalize_github(source)
    return "local", str(Path(source).expanduser().resolve())


def _search_text(c: Chunk) -> str:
    return f"{c.path} {c.symbol or ''} {c.content} {split_identifiers(c.path + ' ' + c.content)}"


def _embed_input(c: Chunk) -> str:
    return f"{c.path}\n{c.symbol or ''}\n{c.content}"


def store_chunks(conn, repo_id, chunks, strategy, progress, lo=30, hi=95) -> None:
    for i in range(0, len(chunks), EMBED_BATCH):
        batch = chunks[i:i + EMBED_BATCH]
        vectors = embed_texts([_embed_input(c) for c in batch])
        with conn.transaction():
            conn.cursor().executemany(
                "INSERT INTO chunks (repo_id, strategy, path, start_line, end_line, lang, symbol,"
                " content, search_text, embedding) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                [(repo_id, strategy, c.path, c.start_line, c.end_line, c.lang, c.symbol,
                  c.content, _search_text(c), v) for c, v in zip(batch, vectors)],
            )
        done = min(i + EMBED_BATCH, len(chunks))
        progress(lo + (hi - lo) * done // len(chunks), f"embedded {done}/{len(chunks)} chunks")


def index_source(conn, source: str, progress: Progress = _noop) -> int:
    started = time.monotonic()
    kind, key = source_key(source)
    if kind == "github":
        github_check(key)
        sha, title = remote_head(key), key.removeprefix("https://github.com/")
    else:
        if not Path(key).is_dir():
            raise IngestError(f"not a folder: {key}")
        sha, title = local_head(Path(key)), Path(key).name

    row = conn.execute("SELECT id, commit_sha, status FROM repos WHERE source = %s", (key,)).fetchone()
    if row and sha and row[1] == sha and row[2] == "ready":
        conn.execute("UPDATE repos SET last_used_at = now() WHERE id = %s", (row[0],))
        progress(100, "already indexed at this commit")
        return row[0]

    repo_id = conn.execute(
        "INSERT INTO repos (kind, source, title, status) VALUES (%s, %s, %s, 'indexing')"
        " ON CONFLICT (source) DO UPDATE SET status = 'indexing', title = EXCLUDED.title"
        " RETURNING id",
        (kind, key, title),
    ).fetchone()[0]
    try:
        progress(2, "fetching source")
        with tempfile.TemporaryDirectory() as tmp:
            root = clone(key, Path(tmp) / "repo") if kind == "github" else Path(key)
            files, skipped = walk(root)
        if not files:
            raise IngestError("no indexable files found")
        progress(10, f"chunking {len(files)} files")
        chunks = [c for f in files for c in chunk_file(f.path, f.text)]
        if len(chunks) > MAX_CHUNKS:
            raise IngestError(f"repo too large for GitGuru v1 ({len(chunks)} chunks > {MAX_CHUNKS})")
        with conn.transaction():
            conn.execute("DELETE FROM chunks WHERE repo_id = %s", (repo_id,))
            conn.execute("DELETE FROM files WHERE repo_id = %s", (repo_id,))
            conn.execute("DELETE FROM repo_artifacts WHERE repo_id = %s", (repo_id,))
            conn.cursor().executemany(
                "INSERT INTO files (repo_id, path, lang, content) VALUES (%s, %s, %s, %s)",
                [(repo_id, f.path, detect_lang(f.path), f.text) for f in files],
            )
        progress(30, f"embedding {len(chunks)} chunks")
        store_chunks(conn, repo_id, chunks, "ast", progress)
        stats = {"files": len(files), "chunks": len(chunks), "skipped": skipped,
                 "seconds": round(time.monotonic() - started, 1)}
        conn.execute(
            "UPDATE repos SET status = 'ready', commit_sha = %s, stats = %s, last_used_at = now()"
            " WHERE id = %s",
            (sha, Jsonb(stats), repo_id),
        )
        progress(100, "ready")
        return repo_id
    except Exception as e:
        conn.execute("UPDATE repos SET status = 'failed', stats = %s WHERE id = %s",
                     (Jsonb({"error": str(e)}), repo_id))
        raise

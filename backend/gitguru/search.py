"""Find the chunks most relevant to a question."""
import re
from dataclasses import dataclass

from gitguru.embed import embed_query

COLS = "id, path, start_line, end_line, symbol, content"


@dataclass
class Hit:
    chunk_id: int
    path: str
    start_line: int
    end_line: int
    symbol: str | None
    content: str
    score: float


def split_identifiers(text: str) -> str:
    words = []
    for ident in re.findall(r"[A-Za-z][A-Za-z0-9_]*", text):
        for part in ident.split("_"):
            words += re.findall(r"[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|[0-9]+", part)
    return " ".join(w.lower() for w in words)


def _hits(rows) -> list[Hit]:
    return [Hit(r[0], r[1], r[2], r[3], r[4], r[5], float(r[6])) for r in rows]


def vector_search(conn, repo_id, query_vec, strategy="ast", limit=30) -> list[Hit]:
    rows = conn.execute(
        f"SELECT {COLS}, 1 - (embedding <=> %s) FROM chunks"
        " WHERE repo_id = %s AND strategy = %s ORDER BY embedding <=> %s LIMIT %s",
        (query_vec, repo_id, strategy, query_vec, limit),
    ).fetchall()
    return _hits(rows)


def retrieve(conn, repo_id, query, mode="vector", strategy="ast", k=6) -> list[Hit]:
    if mode != "vector":
        raise ValueError(f"unknown mode: {mode}")
    return vector_search(conn, repo_id, embed_query(query), strategy, k)

"""Find the chunks most relevant to a question."""
import re
from dataclasses import dataclass, replace

from gitguru.embed import embed_query, rerank

COLS = "id, path, start_line, end_line, symbol, content"
MODES = ("keyword", "vector", "hybrid", "hybrid_rerank")
CANDIDATES, FUSED, RRF_K = 30, 20, 60
STOPWORDS = set("""a an and are as at be by can do does for from how i in is it its of on or
that the this to was what when where which who why will with we you me my our does did there
their they them then than into about use used using work works""".split())


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


def keyword_query(text: str) -> str:
    words = re.findall(r"[a-z0-9]+", text.lower()) + split_identifiers(text).split()
    terms = dict.fromkeys(w for w in words if len(w) > 1 and w not in STOPWORDS)
    return " | ".join(terms)


def keyword_search(conn, repo_id, question, strategy="ast", limit=CANDIDATES) -> list[Hit]:
    q = keyword_query(question)
    if not q:
        return []
    rows = conn.execute(
        f"SELECT {COLS}, ts_rank_cd(tsv, q) FROM chunks, to_tsquery('simple', %s) q"
        " WHERE repo_id = %s AND strategy = %s AND tsv @@ q ORDER BY 7 DESC LIMIT %s",
        (q, repo_id, strategy, limit),
    ).fetchall()
    return _hits(rows)


def rrf(rankings: list[list[int]], k: int = RRF_K) -> list[tuple[int, float]]:
    scores: dict[int, float] = {}
    for ranking in rankings:
        for rank, chunk_id in enumerate(ranking, 1):
            scores[chunk_id] = scores.get(chunk_id, 0.0) + 1 / (k + rank)
    return sorted(scores.items(), key=lambda kv: kv[1], reverse=True)


def retrieve(conn, repo_id, query, mode="hybrid_rerank", strategy="ast", k=6) -> list[Hit]:
    if mode not in MODES:
        raise ValueError(f"unknown mode: {mode}")
    if mode == "keyword":
        return keyword_search(conn, repo_id, query, strategy, k)
    vec = embed_query(query)
    if mode == "vector":
        return vector_search(conn, repo_id, vec, strategy, k)
    kw = keyword_search(conn, repo_id, query, strategy)
    vs = vector_search(conn, repo_id, vec, strategy, CANDIDATES)
    by_id = {h.chunk_id: h for h in kw + vs}
    fused = [replace(by_id[i], score=s) for i, s in
             rrf([[h.chunk_id for h in kw], [h.chunk_id for h in vs]])[:FUSED]]
    if mode == "hybrid" or not fused:
        return fused[:k]
    scores = rerank(query, [f"{h.path}\n{h.content}" for h in fused])
    reranked = [replace(h, score=s) for h, s in zip(fused, scores)]
    return sorted(reranked, key=lambda h: h.score, reverse=True)[:k]

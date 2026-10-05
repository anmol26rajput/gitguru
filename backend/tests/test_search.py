import numpy as np

from gitguru.search import split_identifiers, vector_search


def test_split_identifiers():
    out = split_identifiers("parseConfigFile(snake_case_name, HTTPServer)")
    for word in ["parse", "config", "file", "snake", "case", "name", "http", "server"]:
        assert word in out.split()


def _add_chunk(conn, repo_id, path, vec):
    conn.execute(
        "INSERT INTO chunks (repo_id, strategy, path, start_line, end_line, content, search_text, embedding)"
        " VALUES (%s, 'ast', %s, 1, 2, 'code', 'code', %s)",
        (repo_id, path, vec),
    )


def test_vector_search_orders_by_similarity_and_filters_repo(conn):
    r1 = conn.execute("INSERT INTO repos (kind, source, title) VALUES ('local','/a','a') RETURNING id").fetchone()[0]
    r2 = conn.execute("INSERT INTO repos (kind, source, title) VALUES ('local','/b','b') RETURNING id").fetchone()[0]
    base = np.zeros(768, dtype=np.float32); base[0] = 1
    near = base.copy(); near[1] = 0.1
    far = np.zeros(768, dtype=np.float32); far[2] = 1
    _add_chunk(conn, r1, "far.py", far)
    _add_chunk(conn, r1, "near.py", near)
    _add_chunk(conn, r2, "other_repo.py", base)
    hits = vector_search(conn, r1, base, limit=5)
    assert [h.path for h in hits] == ["near.py", "far.py"]
    assert hits[0].score > hits[1].score


from gitguru.index import index_source
from gitguru.search import MODES, keyword_query, keyword_search, retrieve, rrf
from tests.conftest import FIXTURE_REPO


def test_keyword_query_drops_stopwords_and_splits_identifiers():
    q = keyword_query("How does parseConfig handle the retries?")
    terms = set(q.split(" | "))
    assert {"parseconfig", "parse", "config", "handle", "retries"} <= terms
    assert "the" not in terms and "how" not in terms


def test_keyword_query_empty_for_stopwords_only():
    assert keyword_query("how does it work??") == ""


def test_keyword_search_empty_query_returns_nothing(conn):
    repo_id = index_source(conn, str(FIXTURE_REPO))
    assert keyword_search(conn, repo_id, "what is it??") == []


def test_keyword_search_finds_exact_identifier(conn):
    repo_id = index_source(conn, str(FIXTURE_REPO))
    hits = keyword_search(conn, repo_id, "compute_backoff_delay")
    assert hits[0].symbol == "compute_backoff_delay"


def test_rrf_rewards_agreement():
    fused = rrf([[1, 2, 3], [3, 1, 4]])
    ids = [i for i, _ in fused]
    assert ids[0] == 1           # rank 1 + rank 2
    assert ids[1] == 3           # rank 3 + rank 1
    assert set(ids) == {1, 2, 3, 4}
    assert abs(dict(fused)[4] - 1 / 63) < 1e-9


def test_every_mode_finds_password_hashing(conn):
    repo_id = index_source(conn, str(FIXTURE_REPO))
    for mode in MODES:
        hits = retrieve(conn, repo_id, "hash_password salt sha256", mode=mode, k=3)
        assert any(h.symbol == "hash_password" for h in hits), mode


def test_hybrid_rerank_ranks_best_chunk_first(conn):
    repo_id = index_source(conn, str(FIXTURE_REPO))
    hits = retrieve(conn, repo_id, "Which middleware rejects requests without a token?")
    assert hits[0].symbol == "requireAuth"
    assert hits == sorted(hits, key=lambda h: h.score, reverse=True)

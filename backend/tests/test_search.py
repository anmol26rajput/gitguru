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

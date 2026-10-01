def test_schema_creates_all_tables(conn):
    rows = conn.execute(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
    ).fetchall()
    names = {r[0] for r in rows}
    assert {"repos", "files", "chunks", "jobs", "eval_questions", "eval_runs", "repo_artifacts"} <= names


def test_connect_is_idempotent(conn):
    from tests.conftest import TEST_DB
    from gitguru.db import connect
    connect(TEST_DB).close()  # applying schema twice must not fail


def test_vector_roundtrip(conn):
    import numpy as np
    repo = conn.execute(
        "INSERT INTO repos (kind, source, title) VALUES ('local', '/x', 'x') RETURNING id"
    ).fetchone()[0]
    vec = np.ones(768, dtype=np.float32)
    conn.execute(
        "INSERT INTO chunks (repo_id, strategy, path, start_line, end_line, content, search_text, embedding)"
        " VALUES (%s, 'ast', 'a.py', 1, 2, 'x', 'x', %s)",
        (repo, vec),
    )
    dist = conn.execute("SELECT embedding <=> %s FROM chunks", (vec,)).fetchone()[0]
    assert abs(dist) < 1e-6

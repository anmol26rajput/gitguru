import shutil
import subprocess

import pytest

from gitguru.index import index_source, source_key
from gitguru.ingest import IngestError
from tests.conftest import FIXTURE_REPO


def test_index_local_fixture(conn):
    events = []
    repo_id = index_source(conn, str(FIXTURE_REPO), lambda pct, msg: events.append(pct))
    status, stats = conn.execute("SELECT status, stats FROM repos WHERE id = %s", (repo_id,)).fetchone()
    assert status == "ready"
    assert stats["files"] == 5
    paths = {r[0] for r in conn.execute("SELECT path FROM files WHERE repo_id = %s", (repo_id,))}
    assert paths == {"auth.py", "retry.py", "server.js", "utils/strings.go", "README.md"}
    symbols = {r[0] for r in conn.execute("SELECT symbol FROM chunks WHERE repo_id = %s", (repo_id,))}
    assert {"hash_password", "verify_login", "SessionStore", "requireAuth", "Slugify"} <= symbols
    assert events[-1] == 100 and events == sorted(events)


def test_search_text_contains_split_identifiers(conn):
    repo_id = index_source(conn, str(FIXTURE_REPO))
    text = conn.execute(
        "SELECT search_text FROM chunks WHERE repo_id = %s AND symbol = 'compute_backoff_delay'", (repo_id,)
    ).fetchone()[0]
    assert "backoff delay" in text and "retry.py" in text


def test_empty_repo_fails_clearly(conn, tmp_path):
    (tmp_path / "logo.png").write_bytes(b"\x00\x01binary")
    with pytest.raises(IngestError, match="no indexable files"):
        index_source(conn, str(tmp_path))
    status = conn.execute("SELECT status FROM repos").fetchone()[0]
    assert status == "failed"


def _git(cwd, *args):
    subprocess.run(["git", "-c", "user.email=t@t", "-c", "user.name=t", *args], cwd=cwd, check=True, capture_output=True)


def test_same_commit_is_skipped_and_new_commit_replaces_chunks(conn, tmp_path):
    repo = tmp_path / "r"
    shutil.copytree(FIXTURE_REPO, repo)
    _git(repo, "init", "-q"); _git(repo, "add", "."); _git(repo, "commit", "-qm", "one")
    first = index_source(conn, str(repo))
    count = conn.execute("SELECT count(*) FROM chunks").fetchone()[0]

    calls = []
    assert index_source(conn, str(repo), lambda p, m: calls.append(m)) == first
    assert calls == ["already indexed at this commit"]

    (repo / "retry.py").unlink()
    _git(repo, "commit", "-qam", "two")
    assert index_source(conn, str(repo)) == first
    new_count = conn.execute("SELECT count(*) FROM chunks").fetchone()[0]
    assert 0 < new_count < count
    assert conn.execute("SELECT count(*) FROM files WHERE path = 'retry.py'").fetchone()[0] == 0


def test_source_key():
    assert source_key("https://github.com/psf/requests/tree/main") == ("github", "https://github.com/psf/requests")
    kind, path = source_key(".")
    assert kind == "local" and path.startswith("/")


def test_embed_input_is_truncated_to_bound_memory():
    from gitguru.chunk import Chunk
    from gitguru.index import EMBED_CHARS, _embed_input
    big = Chunk("a.py", 1, 120, "python", "big", "x = 1\n" * 2000)
    text = _embed_input(big)
    assert len(text) <= EMBED_CHARS
    assert text.startswith("a.py\nbig\nx = 1")

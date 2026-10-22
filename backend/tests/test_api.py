from gitguru import config
from tests.conftest import make_client


def test_health_needs_no_token(client):
    assert client.get("/health", headers={"X-GitGuru-Token": ""}).json() == {"ok": True}


def test_missing_or_wrong_token_is_401(client):
    assert client.get("/repos", headers={"X-GitGuru-Token": ""}).status_code == 401
    assert client.get("/repos", headers={"X-GitGuru-Token": "nope"}).status_code == 401


def test_empty_app_token_rejects_everything(client, monkeypatch):
    monkeypatch.setattr(config, "APP_TOKEN", "")
    assert client.get("/repos", headers={"X-GitGuru-Token": ""}).status_code == 401


def test_body_over_1mb_is_413(client):
    assert client.post("/repos", content=b"x" * 1_000_001,
                       headers={"Content-Type": "application/json"}).status_code == 413


def test_startup_marks_interrupted_jobs_failed(conn, monkeypatch):
    rid = conn.execute("INSERT INTO repos (kind, source, title, status) VALUES "
                       "('github', 'https://github.com/a/b', 'a/b', 'indexing') RETURNING id").fetchone()[0]
    jid = conn.execute("INSERT INTO jobs (repo_id, kind, status) VALUES (%s, 'index', 'running') RETURNING id",
                       (rid,)).fetchone()[0]
    with make_client(monkeypatch):  # same helper the fixture uses
        pass
    assert conn.execute("SELECT status, message FROM jobs WHERE id = %s", (jid,)).fetchone() == \
        ("failed", "interrupted, please retry")
    assert conn.execute("SELECT status FROM repos WHERE id = %s", (rid,)).fetchone()[0] == "failed"


def test_non_ascii_token_is_401(client):
    assert client.get("/repos", headers={"X-GitGuru-Token": "é".encode("latin-1")}).status_code == 401

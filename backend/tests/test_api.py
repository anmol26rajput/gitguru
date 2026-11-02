from gitguru import config
from tests.conftest import TEST_DB, make_client


def test_health_needs_no_token_and_says_who_is_the_owner(client):
    assert client.get("/health", headers={"X-GitGuru-Token": ""}).json() == {"ok": True, "owner": False}
    assert client.get("/health", headers={"X-GitGuru-Token": "nope"}).json() == {"ok": True, "owner": False}
    assert client.get("/health").json() == {"ok": True, "owner": True}  # the fixture client sends the token


def test_405_keeps_its_allow_header(client):
    r = client.put("/health")
    assert r.status_code == 405 and r.headers["allow"] == "GET" and r.json() == {"detail": "Method Not Allowed"}


def test_delete_with_missing_or_wrong_token_is_401(client):
    assert client.delete("/repos/1", headers={"X-GitGuru-Token": ""}).status_code == 401
    assert client.delete("/repos/1", headers={"X-GitGuru-Token": "nope"}).status_code == 401


def test_empty_app_token_rejects_every_delete(client, monkeypatch):
    monkeypatch.setattr(config, "APP_TOKEN", "")
    assert client.delete("/repos/1", headers={"X-GitGuru-Token": ""}).status_code == 401


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
    assert client.delete("/repos/1", headers={"X-GitGuru-Token": "é".encode("latin-1")}).status_code == 401


def test_lone_surrogate_in_source_is_400_not_500(client):
    # the client can't encode a lone surrogate, so the body is built by hand: \ud83d is a valid JSON escape
    r = client.post("/repos", content=b'{"source": "https://github.com/o\\ud83d/r"}',
                    headers={"Content-Type": "application/json"})
    assert r.status_code == 400
    assert r.content.isascii() and "\\ud83d" in r.text  # echoed back, escaped


def test_json_responses_are_compact_ascii_and_error_bodies_keep_their_shape(client):
    assert client.get("/health").content == b'{"ok":true,"owner":true}'
    r = client.get("/repos/999")
    assert r.status_code == 404 and r.json() == {"detail": "repo not found"}
    r = client.delete("/repos/1", headers={"X-GitGuru-Token": ""})
    assert r.status_code == 401 and r.json() == {"detail": "missing or invalid token"}
    r = client.post("/repos", json={})
    assert r.status_code == 422 and r.json()["detail"][0]["type"] == "missing"
    assert client.post("/pages", json={"url": "https://e.com/é", "title": "é", "text": "é"}).content.isascii()


def test_pool_size_comes_from_config(monkeypatch):
    from gitguru.db import make_pool
    assert config.POOL_MAX == 15
    monkeypatch.setattr(config, "POOL_MAX", 3)
    pool = make_pool(TEST_DB)
    try:
        assert pool.max_size == 3
    finally:
        pool.close()

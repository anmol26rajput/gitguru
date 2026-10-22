from gitguru import jobs
from gitguru.db import make_pool
from gitguru.ingest import IngestError
from tests.conftest import TEST_DB, parse_sse

URL = "https://github.com/acme/tiny"


def events(client, job_id) -> list[dict]:
    return parse_sse(client.get(f"/jobs/{job_id}/events").text)


def test_add_repo_streams_progress_then_done(client, fake_github):
    r = client.post("/repos", json={"source": URL + "/blob/main/auth.py"})
    assert r.status_code == 200
    body = r.json()
    evs = events(client, body["job_id"])
    assert evs[0]["event"] == "progress" and evs[-1] == {"event": "done", "data": {"repo_id": body["repo_id"]}}
    repo = client.get(f"/repos/{body['repo_id']}").json()
    assert repo["status"] == "ready" and repo["title"] == "acme/tiny" and repo["stats"]["chunks"] > 0


def test_same_repo_twice_while_queued_returns_same_job(client, monkeypatch):
    monkeypatch.setattr(jobs.EXECUTOR, "submit", lambda *a, **k: None)  # keep it queued
    a = client.post("/repos", json={"source": URL}).json()
    b = client.post("/repos", json={"source": URL + "/tree/main"}).json()
    assert a == b


def test_non_github_and_bad_urls_are_400(client):
    assert client.post("/repos", json={"source": "/etc"}).status_code == 400
    assert client.post("/repos", json={"source": "https://gitlab.com/a/b"}).status_code == 400


def test_eleventh_index_job_today_is_429(client, conn, monkeypatch):
    monkeypatch.setattr(jobs.EXECUTOR, "submit", lambda *a, **k: None)
    conn.execute("INSERT INTO jobs (kind, status) SELECT 'index', 'done' FROM generate_series(1, 10)")
    r = client.post("/repos", json={"source": URL})
    assert r.status_code == 429 and "tomorrow" in r.json()["detail"]


def test_twenty_first_repo_evicts_least_recently_used(client, conn, monkeypatch):
    monkeypatch.setattr(jobs.EXECUTOR, "submit", lambda *a, **k: None)
    for i in range(20):
        conn.execute("INSERT INTO repos (kind, source, title, status, last_used_at) VALUES "
                     "('github', %s, %s, 'ready', now() - make_interval(days => %s))",
                     (f"https://github.com/o/r{i}", f"o/r{i}", i))
    client.post("/repos", json={"source": URL})
    titles = [r["title"] for r in client.get("/repos").json()]
    assert len(titles) == 20 and "o/r19" not in titles and "acme/tiny" in titles


def test_failed_job_ends_stream_with_error(client, conn):
    jid = conn.execute("INSERT INTO jobs (kind, status, message) VALUES ('index', 'failed', 'boom') "
                       "RETURNING id").fetchone()[0]
    assert events(client, jid) == [{"event": "error", "data": {"message": "boom"}}]


def test_unknown_job_is_404_and_delete_repo(client, fake_github):
    assert client.get("/jobs/999999/events").status_code == 404
    body = client.post("/repos", json={"source": URL}).json()
    assert events(client, body["job_id"])[-1]["event"] == "done"  # drain: no job outlives the test
    assert client.delete(f"/repos/{body['repo_id']}").status_code == 204
    assert client.get(f"/repos/{body['repo_id']}").status_code == 404
    assert client.delete(f"/repos/{body['repo_id']}").status_code == 404


def test_job_events_returns_connection_between_polls(conn):
    jid = conn.execute("INSERT INTO jobs (kind, status) VALUES ('index', 'queued') RETURNING id").fetchone()[0]
    pool = make_pool(TEST_DB)
    pool.wait()  # min_size connection opens in the background; without this the pool can grow to 2 mid-test
    try:
        gen = jobs.job_events(pool, jid, poll_s=0)
        assert next(gen)["event"] == "progress"  # suspended mid-stream
        stats = pool.get_stats()
        assert stats["pool_available"] == stats["pool_size"]  # nothing pinned by the watcher
        gen.close()
    finally:
        pool.close()


def test_index_failure_marks_job_and_repo_failed_and_ends_stream(client, monkeypatch):
    def boom(key):
        raise IngestError("repo not found")
    monkeypatch.setattr("gitguru.index.github_check", boom)
    body = client.post("/repos", json={"source": URL}).json()
    assert events(client, body["job_id"]) == [{"event": "error", "data": {"message": "repo not found"}}]
    assert client.get(f"/repos/{body['repo_id']}").json()["status"] == "failed"

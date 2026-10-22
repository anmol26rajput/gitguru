import json

import psycopg

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


def _repo(conn, title, status="ready"):
    return conn.execute("INSERT INTO repos (kind, source, title, status) VALUES ('github', %s, %s, %s) RETURNING id",
                        (f"https://github.com/{title}", title, status)).fetchone()[0]


def _overview(conn, repo_id, summary):
    content = json.dumps({"summary": summary, "how_it_works": [], "parts": [], "glossary": []})
    conn.execute("INSERT INTO repo_artifacts (repo_id, kind, content) VALUES (%s, 'overview', %s)", (repo_id, content))


def test_list_repos_summary_present_absent_long_and_invalid(client, conn):
    ok, none, long_, bad = (_repo(conn, t) for t in ("o/ok", "o/none", "o/long", "o/bad"))
    _overview(conn, ok, "Tiny auth for web apps. It also does more. And more.")
    _overview(conn, long_, "word " * 60 + "ends here. Second.")
    conn.execute("INSERT INTO repo_artifacts (repo_id, kind, content) VALUES (%s, 'overview', '{\"nope\": 1}')", (bad,))
    by_id = {r["id"]: r for r in client.get("/repos").json()}
    assert by_id[ok]["summary"] == "Tiny auth for web apps."
    assert by_id[none]["summary"] is None and by_id[bad]["summary"] is None
    s = by_id[long_]["summary"]
    assert len(s) <= 120 and s.endswith("…") and s[:-1].rstrip().split(" ")[-1] == "word"


def test_list_repos_progress_and_message_from_latest_index_job(client, conn):
    failed, fresh, indexing = _repo(conn, "o/failed", "failed"), _repo(conn, "o/fresh", "ready"), _repo(conn, "o/busy", "indexing")
    for rid, kind, status, pct, msg in [(failed, "index", "failed", 40, "clone failed: boom"),
                                        (indexing, "index", "failed", 10, "old attempt"),  # older, superseded
                                        (indexing, "index", "running", 55, "embedding"),
                                        (indexing, "eval", "running", 99, "eval is not an index job")]:
        conn.execute("INSERT INTO jobs (repo_id, kind, status, progress, message) VALUES (%s, %s, %s, %s, %s)",
                     (rid, kind, status, pct, msg))
    by_id = {r["id"]: r for r in client.get("/repos").json()}
    assert (by_id[failed]["progress"], by_id[failed]["message"]) == (40, "clone failed: boom")
    assert (by_id[indexing]["progress"], by_id[indexing]["message"]) == (55, "embedding")
    assert by_id[fresh]["progress"] is None and by_id[fresh]["message"] is None


def test_list_repos_is_one_query(client, conn, monkeypatch):
    for i in range(5):
        _overview(conn, _repo(conn, f"o/r{i}"), "Hello there.")
    seen = []
    orig = psycopg.Connection.execute
    monkeypatch.setattr(psycopg.Connection, "execute", lambda self, q, *a, **k: seen.append(str(q)) or orig(self, q, *a, **k))
    assert len(client.get("/repos").json()) == 5
    assert len([q for q in seen if q]) == 1  # pool housekeeping runs an empty statement

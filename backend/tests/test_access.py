"""Open access (D48): guests use everything but DELETE, capped per visitor and across all guests."""
import hashlib

import pytest

from gitguru import config, jobs, tts
from tests.test_jobs_api import URL, events

GUEST = {"X-GitGuru-Token": ""}
PER_VISITOR = "You can add 5 repos or pages a day. Try again tomorrow."
ALL_GUESTS = "GitGuru's daily limit for visitors is reached. Try again tomorrow."
ME = hashlib.sha256(b"testclient" + b"test-token").hexdigest()[:16]  # TestClient's host + APP_TOKEN


@pytest.fixture
def queued(monkeypatch):
    monkeypatch.setattr(jobs.EXECUTOR, "submit", lambda *a, **k: None)  # jobs stay queued, nothing runs


def _done_jobs(conn, n, client):
    conn.execute("INSERT INTO jobs (kind, status, client) SELECT 'index', 'done', %s FROM generate_series(1, %s)",
                 (client, n))


def _page(client, n=0, headers=GUEST):
    return client.post("/pages", json={"url": f"https://example.com/p{n}", "title": "P", "text": "Some text."},
                       headers=headers)


def test_guest_needs_no_token_for_anything_but_delete(client, ready_repo, monkeypatch, queued):
    monkeypatch.setattr(tts, "_fetch", lambda text, voice: b"mp3")
    tts._synth.cache_clear()
    rid = ready_repo
    assert client.get("/repos", headers=GUEST).status_code == 200
    assert client.get(f"/repos/{rid}", headers=GUEST).status_code == 200
    assert client.get(f"/repos/{rid}/file", params={"path": "auth.py"}, headers=GUEST).status_code == 200
    assert client.get(f"/repos/{rid}/evals", headers=GUEST).status_code == 200
    assert client.post(f"/repos/{rid}/ask", json={"question": "q"}, headers=GUEST).status_code == 200
    assert client.post("/tts", json={"text": "Hi"}, headers=GUEST).status_code == 200
    # the fake LLM can't build these, so they fail, but never on auth
    assert client.get(f"/repos/{rid}/diagram", headers=GUEST).status_code != 401
    assert client.post(f"/repos/{rid}/walkthrough", json={}, headers=GUEST).status_code != 401
    assert client.post(f"/repos/{rid}/evals", json={"generate": False}, headers=GUEST).status_code == 200
    assert _page(client).status_code == 200
    assert client.post("/repos", json={"source": "https://github.com/a/b"}, headers=GUEST).status_code == 200
    tts._synth.cache_clear()


def test_guest_jobs_store_the_visitor_key_and_owner_jobs_store_null(client, conn, queued):
    _page(client, 1)
    _page(client, 2, headers={})  # the fixture client sends the owner token
    assert conn.execute("SELECT client FROM jobs ORDER BY id").fetchall() == [(ME,), (None,)]


def test_sixth_job_from_one_visitor_is_429(client, conn, queued):
    _done_jobs(conn, 4, ME)
    conn.execute("INSERT INTO jobs (kind, status, client) VALUES ('index', 'done', 'someone-else')")
    assert _page(client, 1).status_code == 200  # 5th
    for r in (_page(client, 2), client.post("/repos", json={"source": URL}, headers=GUEST)):
        assert r.status_code == 429 and r.json()["detail"] == PER_VISITOR


def test_eval_jobs_count_toward_the_visitor_cap(client, ready_repo, conn, queued):
    _done_jobs(conn, 5, ME)
    r = client.post(f"/repos/{ready_repo}/evals", json={"generate": False}, headers=GUEST)
    assert r.status_code == 429 and r.json()["detail"] == PER_VISITOR


def test_twenty_first_guest_job_across_visitors_is_429(client, conn, queued):
    for i in range(5):
        _done_jobs(conn, 4, f"visitor-{i}")  # 20 guest jobs, nobody at their own cap
    _done_jobs(conn, 30, None)  # the owner's jobs never count
    r = _page(client)
    assert r.status_code == 429 and r.json()["detail"] == ALL_GUESTS


def test_owner_passes_both_caps(client, conn, queued):
    _done_jobs(conn, 25, ME)
    assert _page(client, headers={}).status_code == 200
    assert client.post("/repos", json={"source": URL}).status_code == 200


def test_reused_queued_job_counts_nothing(client, conn, queued):
    _done_jobs(conn, 4, ME)
    first = client.post("/repos", json={"source": URL}, headers=GUEST).json()  # 5th: at the cap now
    assert client.post("/repos", json={"source": URL}, headers=GUEST).json() == first
    assert conn.execute("SELECT count(*) FROM jobs").fetchone()[0] == 5


def test_yesterdays_jobs_do_not_count(client, conn, queued):
    _done_jobs(conn, 5, ME)
    conn.execute("UPDATE jobs SET created_at = date_trunc('day', now()) - interval '1 second'")
    assert _page(client).status_code == 200


def test_caps_come_from_config(client, conn, queued, monkeypatch):
    monkeypatch.setattr(config, "GUEST_DAILY_JOBS", 2)
    monkeypatch.setattr(config, "GUEST_TOTAL_DAILY_JOBS", 3)
    _done_jobs(conn, 2, ME)
    assert _page(client).json()["detail"] == "You can add 2 repos or pages a day. Try again tomorrow."
    conn.execute("UPDATE jobs SET client = 'other'")
    _done_jobs(conn, 1, "third")
    assert _page(client).json()["detail"] == ALL_GUESTS


def test_delete_needs_the_owner_token(client, conn):
    rid = conn.execute("INSERT INTO repos (kind, source, title) VALUES ('github', 'x', 'x') RETURNING id").fetchone()[0]
    assert client.delete(f"/repos/{rid}", headers=GUEST).status_code == 401
    assert client.delete(f"/repos/{rid}", headers={"X-GitGuru-Token": "nope"}).status_code == 401
    assert client.delete(f"/repos/{rid}").status_code == 204


def test_unset_app_token_means_nobody_can_delete(client, conn, monkeypatch):
    rid = conn.execute("INSERT INTO repos (kind, source, title) VALUES ('github', 'x', 'x') RETURNING id").fetchone()[0]
    monkeypatch.setattr(config, "APP_TOKEN", "")
    assert client.delete(f"/repos/{rid}", headers=GUEST).status_code == 401
    assert client.delete(f"/repos/{rid}").status_code == 401  # even with the old token
    assert client.get("/repos", headers=GUEST).status_code == 200  # everything else stays open


FULL = "GitGuru is full right now. Try again later."


def _fill(conn, owner_slots, guest_slots):
    """MAX_REPOS repos, oldest first: owner-indexed ones (a NULL-client index job), then guest-indexed ones."""
    for i in range(owner_slots + guest_slots):
        rid = conn.execute("INSERT INTO repos (kind, source, title, last_used_at) VALUES ('github', %s, %s,"
                           " now() - make_interval(days => %s)) RETURNING id",
                           (f"https://github.com/o/r{i}", f"o/r{i}", 100 - i)).fetchone()[0]
        conn.execute("INSERT INTO jobs (repo_id, kind, status, client, created_at) VALUES"
                     " (%s, 'index', 'done', %s, now() - interval '2 days')",
                     (rid, None if i < owner_slots else "guest"))


def _titles(conn):
    return {t for (t,) in conn.execute("SELECT title FROM repos").fetchall()}


def test_guest_evicts_only_guest_repos(client, conn, queued):
    _fill(conn, 18, 2)  # the owner's repos are the least recently used, the guest ones newer
    conn.execute("INSERT INTO repos (kind, source, title, last_used_at) VALUES"  # no jobs at all (CLI-indexed)
                 " ('github', 'https://github.com/cli/x', 'cli/x', now() - interval '1 year')")
    conn.execute("DELETE FROM repos WHERE title = 'o/r0'")  # still 20 repos
    assert client.post("/repos", json={"source": URL}, headers=GUEST).status_code == 200
    assert _page(client).status_code == 200
    names = {f"o/r{i}" for i in range(20)} | {"cli/x", "acme/tiny", "P"}
    assert names - _titles(conn) == {"o/r0", "o/r18", "o/r19"}  # o/r0 was removed above


def test_guest_gets_429_when_every_slot_is_the_owners(client, conn, queued):
    _fill(conn, 20, 0)
    before = _titles(conn)
    for r in (client.post("/repos", json={"source": URL}, headers=GUEST), _page(client)):
        assert r.status_code == 429 and r.json()["detail"] == FULL
    assert _titles(conn) == before and conn.execute("SELECT count(*) FROM jobs").fetchone()[0] == 20


def test_owner_can_still_evict_any_repo(client, conn, queued):
    _fill(conn, 20, 0)
    assert client.post("/repos", json={"source": URL}).status_code == 200
    assert "o/r0" not in _titles(conn) and "acme/tiny" in _titles(conn)


def test_unset_app_token_salts_the_visitor_key_with_a_process_secret(client, conn, queued, monkeypatch):
    monkeypatch.setattr(config, "APP_TOKEN", "")
    _page(client)
    key = conn.execute("SELECT client FROM jobs").fetchone()[0]
    assert len(key) == 16 and key != hashlib.sha256(b"testclient").hexdigest()[:16]


def test_only_the_owner_sets_eval_questions(client, ready_repo, conn, queued):
    q = [{"question": "q", "gold_path": "auth.py", "gold_start": 1, "gold_end": 2}]
    r = client.post(f"/repos/{ready_repo}/evals", json={"questions": q, "generate": False}, headers=GUEST)
    assert r.status_code == 403 and r.json()["detail"] == "Only the owner can set eval questions."
    assert conn.execute("SELECT count(*) FROM jobs WHERE kind = 'eval'").fetchone()[0] == 0
    assert client.post(f"/repos/{ready_repo}/evals", json={"generate": True}, headers=GUEST).status_code == 200
    assert client.post(f"/repos/{ready_repo}/evals", json={"questions": q, "generate": False}).status_code == 200


def _counts(conn):
    return conn.execute("SELECT (SELECT count(*) FROM jobs), (SELECT count(*) FROM jobs WHERE client IS NOT NULL),"
                        " (SELECT string_agg(content, '|' ORDER BY id) FROM chunks)").fetchone()


def test_guest_re_adding_a_ready_repo_gets_its_job_and_spends_nothing(client, ready_repo, conn, queued):
    _done_jobs(conn, 5, ME)  # at the cap: a new job would be a 429
    job = conn.execute("SELECT id FROM jobs WHERE repo_id = %s", (ready_repo,)).fetchone()[0]
    before = _counts(conn)
    r = client.post("/repos", json={"source": URL + "/tree/main"}, headers=GUEST)
    assert r.status_code == 200 and r.json() == {"repo_id": ready_repo, "job_id": job}
    assert _counts(conn) == before
    assert events(client, job)[-1] == {"event": "done", "data": {"repo_id": ready_repo}}
    assert client.get(f"/repos/{ready_repo}").json()["status"] == "ready"


def test_owner_re_adding_a_ready_repo_still_re_indexes(client, ready_repo, conn, queued):
    r = client.post("/repos", json={"source": URL})
    assert r.status_code == 200 and r.json()["repo_id"] == ready_repo
    assert conn.execute("SELECT status FROM jobs WHERE id = %s", (r.json()["job_id"],)).fetchone()[0] == "queued"


def test_guest_re_adding_a_ready_page_keeps_its_text_and_title(client, conn):
    first = _page(client, 7, headers={})  # the owner adds it
    assert events(client, first.json()["job_id"])[-1]["event"] == "done"
    _done_jobs(conn, 5, ME)
    before = _counts(conn)
    r = client.post("/pages", json={"url": "https://example.com/p7", "title": "Defaced", "text": "Other text."},
                    headers=GUEST)
    assert r.status_code == 200 and r.json() == first.json()
    assert _counts(conn) == before and _titles(conn) == {"P"}
    # the owner can still refresh it
    again = client.post("/pages", json={"url": "https://example.com/p7", "title": "New", "text": "New text."})
    assert again.json()["job_id"] != first.json()["job_id"]
    assert events(client, again.json()["job_id"])[-1]["event"] == "done" and _titles(conn) == {"New"}


def test_guest_re_adding_a_jobless_cli_repo_gets_a_done_owner_job(client, conn, queued):
    rid = conn.execute("INSERT INTO repos (kind, source, title, status) VALUES ('github', %s, 'acme/tiny', 'ready')"
                       " RETURNING id", (URL,)).fetchone()[0]
    _done_jobs(conn, 5, ME)
    r = client.post("/repos", json={"source": URL}, headers=GUEST)
    assert r.status_code == 200 and r.json()["repo_id"] == rid
    assert conn.execute("SELECT kind, status, client FROM jobs WHERE id = %s", (r.json()["job_id"],)).fetchone() == \
        ("index", "done", None)  # owner-owned, so it costs no guest slot and the repo stays protected
    assert events(client, r.json()["job_id"])[-1] == {"event": "done", "data": {"repo_id": rid}}


def test_guests_stop_when_the_database_is_full(client, conn, queued, monkeypatch):
    monkeypatch.setattr(config, "GUEST_DB_MAX_BYTES", 0)
    for r in (_page(client), client.post("/repos", json={"source": URL}, headers=GUEST)):
        assert r.status_code == 429 and r.json()["detail"] == FULL
    assert conn.execute("SELECT count(*) FROM jobs").fetchone()[0] == 0
    assert _page(client, headers={}).status_code == 200  # the owner is unaffected

import json

from gitguru import evals, jobs
from tests.conftest import FIXTURE_REPO
from tests.test_jobs_api import events

QFILE = FIXTURE_REPO.parent / "tiny_repo_questions.json"


def test_eval_job_with_manual_questions(client, ready_repo):
    qs = json.loads(QFILE.read_text())
    job = client.post(f"/repos/{ready_repo}/evals", json={"questions": qs, "generate": False}).json()["job_id"]
    assert events(client, job)[-1]["event"] == "done"
    runs = client.get(f"/repos/{ready_repo}/evals").json()
    assert len(runs) == 8 and {r["strategy"] for r in runs} == {"ast", "line"} and all(r["n"] == len(qs) for r in runs)
    assert set(runs[0]) == {"id", "mode", "strategy", "n", "hit_at_5", "mrr_at_10", "p50_ms", "created_at"}
    assert [r["id"] for r in runs] == sorted((r["id"] for r in runs), reverse=True)


def test_manual_questions_replace_earlier_ones(client, ready_repo, conn):
    qs = json.loads(QFILE.read_text())
    for sent in (qs, qs[:2]):
        job = client.post(f"/repos/{ready_repo}/evals", json={"questions": sent, "generate": False}).json()["job_id"]
        assert events(client, job)[-1]["event"] == "done"
    assert conn.execute("SELECT count(*) FROM eval_questions WHERE repo_id = %s AND origin = 'manual'",
                        (ready_repo,)).fetchone()[0] == 2


def test_same_eval_twice_while_queued_returns_same_job(client, ready_repo, monkeypatch):
    monkeypatch.setattr(jobs.EXECUTOR, "submit", lambda *a, **k: None)
    a = client.post(f"/repos/{ready_repo}/evals", json={"generate": False}).json()
    b = client.post(f"/repos/{ready_repo}/evals", json={"generate": False}).json()
    assert a == b


def test_eval_without_questions_fails_the_job(client, ready_repo):
    job = client.post(f"/repos/{ready_repo}/evals", json={"generate": False}).json()["job_id"]
    last = events(client, job)[-1]
    assert last["event"] == "error" and "no eval questions" in last["data"]["message"]


def test_generate_flag_calls_generator(client, ready_repo, monkeypatch):
    calls = []
    monkeypatch.setattr(evals, "generate_questions", lambda conn, repo_id: calls.append(repo_id) or 0)
    job = client.post(f"/repos/{ready_repo}/evals", json={"generate": True}).json()["job_id"]
    last = events(client, job)[-1]
    assert calls == [ready_repo] and last["event"] == "error" and "no eval questions" in last["data"]["message"]


def test_eval_counts_toward_daily_job_cap(client, ready_repo, conn, monkeypatch):
    monkeypatch.setattr(jobs.EXECUTOR, "submit", lambda *a, **k: None)
    # ready_repo made 1 index job: 1 + 8 index + 1 eval = 10 → the next job is over the cap
    conn.execute("INSERT INTO jobs (kind, status) SELECT 'index', 'done' FROM generate_series(1, 8)")
    conn.execute("INSERT INTO jobs (kind, status) VALUES ('eval', 'done')")
    r = client.post(f"/repos/{ready_repo}/evals", json={"generate": False})
    assert r.status_code == 429 and r.json()["detail"] == "daily limit of 10 jobs (index + eval) reached, try again tomorrow"
    # one fewer job and it goes through
    conn.execute("DELETE FROM jobs WHERE id = (SELECT max(id) FROM jobs)")
    assert client.post(f"/repos/{ready_repo}/evals", json={"generate": False}).status_code == 200


def test_eval_routes_404_and_409(client, conn):
    assert client.post("/repos/999/evals", json={}).status_code == 404
    assert client.get("/repos/999/evals").status_code == 404
    rid = conn.execute("INSERT INTO repos (kind, source, title, status) VALUES ('github', 'x', 'x', 'pending')"
                       " RETURNING id").fetchone()[0]
    assert client.post(f"/repos/{rid}/evals", json={}).status_code == 409

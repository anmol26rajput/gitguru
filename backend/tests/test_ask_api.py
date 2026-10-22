from gitguru import api
from tests.conftest import parse_sse


def ask(client, repo_id, question, history=()) -> list[dict]:
    r = client.post(f"/repos/{repo_id}/ask", json={"question": question, "history": list(history)})
    assert r.status_code == 200
    return parse_sse(r.text)


def test_ask_streams_sources_tokens_done(client, ready_repo):
    evs = ask(client, ready_repo, "How are passwords hashed?")
    assert [e["event"] for e in evs][0] == "sources" and evs[-1]["event"] == "done"
    assert evs[0]["data"][0]["path"] == "auth.py"
    assert "".join(e["data"] for e in evs if e["event"] == "token") == "Fake answer citing [1]."


def test_ask_bumps_last_used_at(client, conn, ready_repo):
    conn.execute("UPDATE repos SET last_used_at = now() - interval '1 day' WHERE id = %s", (ready_repo,))
    ask(client, ready_repo, "How are passwords hashed?")
    age = conn.execute("SELECT now() - last_used_at FROM repos WHERE id = %s", (ready_repo,)).fetchone()[0]
    assert age.total_seconds() < 60


def test_ask_not_ready_repo_is_409(client, conn):
    rid = conn.execute("INSERT INTO repos (kind, source, title, status) VALUES "
                       "('github', 'https://github.com/a/b', 'a/b', 'indexing') RETURNING id").fetchone()[0]
    r = client.post(f"/repos/{rid}/ask", json={"question": "q"})
    assert r.status_code == 409 and "indexing" in r.json()["detail"]


def test_ask_validation(client, ready_repo):
    assert client.post(f"/repos/{ready_repo}/ask", json={"question": "x" * 1001}).status_code == 422
    assert client.post(f"/repos/{ready_repo}/ask", json={"question": ""}).status_code == 422
    seven = [{"role": "user", "content": "hi"}] * 7
    assert client.post(f"/repos/{ready_repo}/ask", json={"question": "q", "history": seven}).status_code == 422
    bad_role = [{"role": "system", "content": "hi"}]
    assert client.post(f"/repos/{ready_repo}/ask", json={"question": "q", "history": bad_role}).status_code == 422
    assert client.post("/repos/999999/ask", json={"question": "q"}).status_code == 404


def test_question_rate_limit(client, ready_repo, monkeypatch):
    monkeypatch.setattr(api, "MAX_QUESTIONS_PER_HOUR", 1)
    api._asked.clear()
    ask(client, ready_repo, "first")
    r = client.post(f"/repos/{ready_repo}/ask", json={"question": "second"})
    assert r.status_code == 429 and "question limit reached (1/hour)" in r.json()["detail"]


def test_file_only_serves_stored_paths(client, ready_repo):
    f = client.get(f"/repos/{ready_repo}/file", params={"path": "auth.py"}).json()
    assert f["path"] == "auth.py" and f["lang"] == "python" and "def " in f["content"]
    for bad in ("../../etc/passwd", "/etc/passwd", "nope.py"):
        assert client.get(f"/repos/{ready_repo}/file", params={"path": bad}).status_code == 404
    assert client.get("/repos/999999/file", params={"path": "auth.py"}).status_code == 404

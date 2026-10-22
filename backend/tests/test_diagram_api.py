from collections import Counter

from gitguru import diagram, llm, overview
from gitguru.diagram import folder_tree, verify_paths


def test_verify_paths_unwraps_invented_files():
    md, n = verify_paths("See `src/app.py`, `lib/` and `ghost.py` and `npm install`.", {"src/app.py", "lib/x.js"})
    assert "`src/app.py`" in md and "`lib/`" in md and "npm install`" in md and n == 1
    assert "`ghost.py`" not in md and "and ghost.py and" in md


def test_verify_paths_leading_slash_mime_and_title():
    md, n = verify_paths("`/src/app.py` `application/json` `I/O` `o/r`", {"src/app.py"}, title="o/r")
    assert md == "`/src/app.py` application/json I/O `o/r`" and n == 2


def test_folder_tree_depth_2():
    assert folder_tree(["a/b/c/d.py", "a/e.py", "f.md"]) == "a/\n  b/"


def fixed_overview():
    return overview.Overview(
        summary="Tiny auth.", how_it_works=[overview.FlowStep(label="Check", detail="checks"), overview.FlowStep(label="Reply", detail="replies")],
        parts=[overview.Part(name="Auth", path="auth.py", what="logins"), overview.Part(name="Ghost", path="nope.py", what="invented")],
        glossary=[overview.Term(term="Hash", meaning="scramble"), overview.Term(term="hash", meaning="dup")])


def test_diagram_endpoint_builds_then_caches(client, ready_repo, conn, monkeypatch):
    calls = []
    monkeypatch.setattr(diagram.llm, "complete_json", lambda m, schema: calls.append(m) or fixed_overview())
    first = client.get(f"/repos/{ready_repo}/diagram").json()
    assert first["mermaid"] == ""  # fixture repo has no internal imports
    o = first["overview"]
    assert set(o) == {"summary", "flow_mermaid", "how_it_works", "parts", "glossary"} and "tour_md" not in first
    assert o["summary"] == "Tiny auth." and [p["name"] for p in o["parts"]] == ["Auth"] and len(o["glossary"]) == 1
    assert o["flow_mermaid"].startswith("graph LR") and "s0 --> s1" in o["flow_mermaid"]
    assert client.get(f"/repos/{ready_repo}/diagram").json() == first and len(calls) == 1
    kinds = {k for (k,) in conn.execute("SELECT kind FROM repo_artifacts WHERE repo_id = %s", (ready_repo,))}
    assert kinds == {"diagram", "overview"}


def test_diagram_llm_failure_is_503_but_diagram_cached(client, ready_repo, conn, monkeypatch):
    def boom(m, schema): raise llm.LLMError("AI providers are busy, try again in a minute")
    monkeypatch.setattr(diagram.llm, "complete_json", boom)
    r = client.get(f"/repos/{ready_repo}/diagram")
    assert r.status_code == 503 and "busy" in r.json()["detail"]
    assert conn.execute("SELECT count(*) FROM repo_artifacts WHERE repo_id = %s AND kind = 'diagram'", (ready_repo,)).fetchone()[0] == 1


def test_diagram_invalid_overview_json_is_503(client, ready_repo, monkeypatch):
    monkeypatch.setattr(diagram.llm, "complete", lambda m: "not json at all")
    r = client.get(f"/repos/{ready_repo}/diagram")
    assert r.status_code == 503 and "overview" in r.json()["detail"]


def test_diagram_not_ready_is_409(client, conn):
    rid = conn.execute("INSERT INTO repos (kind, source, title, status) VALUES "
                       "('github', 'https://github.com/a/b', 'a/b', 'indexing') RETURNING id").fetchone()[0]
    assert client.get(f"/repos/{rid}/diagram").status_code == 409
    assert client.get("/repos/999999/diagram").status_code == 404


def test_diagram_takes_question_slot_only_when_overview_uncached(client, ready_repo, monkeypatch):
    monkeypatch.setattr(diagram.llm, "complete_json", lambda m, schema: fixed_overview())
    from gitguru import api
    api._asked.clear()
    client.get(f"/repos/{ready_repo}/diagram")
    client.get(f"/repos/{ready_repo}/diagram")
    assert len(api._asked) == 1


def test_get_artifacts_returns_stored_row_when_a_concurrent_request_won(ready_repo, conn, monkeypatch):
    winner = overview.Overview(summary="winner", how_it_works=[], parts=[], glossary=[])

    def racing(title, files, edges):
        conn.execute("INSERT INTO repo_artifacts (repo_id, kind, content) VALUES (%s, 'overview', %s)",
                     (ready_repo, winner.model_dump_json()))
        return overview.Overview(summary="loser", how_it_works=[], parts=[], glossary=[])
    monkeypatch.setattr(overview, "build_overview", racing)
    got = diagram.get_artifacts(conn, ready_repo)["overview"]
    assert got["summary"] == "winner" and got["flow_mermaid"] == ""


def test_stale_cached_overview_is_rebuilt_and_takes_a_slot(client, ready_repo, conn, monkeypatch):
    from gitguru import api
    api._asked.clear()
    conn.execute("INSERT INTO repo_artifacts (repo_id, kind, content) VALUES (%s, 'overview', '{\"old\": 1}')", (ready_repo,))
    monkeypatch.setattr(diagram.llm, "complete_json", lambda m, schema: fixed_overview())
    r = client.get(f"/repos/{ready_repo}/diagram")
    assert r.status_code == 200 and r.json()["overview"]["summary"] == "Tiny auth." and len(api._asked) == 1

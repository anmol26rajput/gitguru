from collections import Counter

from gitguru import diagram, llm
from gitguru.diagram import build_tour, folder_tree, verify_paths


def test_verify_paths_unwraps_invented_files():
    md, n = verify_paths("See `src/app.py`, `lib/` and `ghost.py` and `npm install`.", {"src/app.py", "lib/x.js"})
    assert "`src/app.py`" in md and "`lib/`" in md and "npm install`" in md and n == 1
    assert "`ghost.py`" not in md and "and ghost.py and" in md


def test_verify_paths_leading_slash_mime_and_title():
    md, n = verify_paths("`/src/app.py` `application/json` `I/O` `o/r`", {"src/app.py"}, title="o/r")
    assert md == "`/src/app.py` application/json I/O `o/r`" and n == 2


def test_folder_tree_depth_2():
    assert folder_tree(["a/b/c/d.py", "a/e.py", "f.md"]) == "a/\n  b/"


def test_build_tour_prompt_has_readme_tree_edges_and_verifies(monkeypatch):
    seen = []
    monkeypatch.setattr(diagram.llm, "complete", lambda m: seen.append(m) or "## What it is\n`a/x.py` `ghost.py`")
    files = {"README.md": "R" * 4000, "readme.txt": "no", "a/x.py": "pass"}
    out = build_tour("o/r", files, Counter({("a", "b"): 2}))
    assert out == "## What it is\n`a/x.py` ghost.py"
    user = seen[0][-1]["content"]
    assert "R" * 3000 in user and "R" * 3001 not in user and "a/" in user and "a -> b" in user
    system = seen[0][0]["content"]
    assert "untrusted" in system and "## How a request flows" in system


def test_diagram_endpoint_builds_then_caches(client, ready_repo, conn, monkeypatch):
    calls = []
    monkeypatch.setattr(diagram.llm, "complete", lambda m: calls.append(m) or "## What it is\nUses `auth.py` and `nope.py`.")
    first = client.get(f"/repos/{ready_repo}/diagram").json()
    assert first["mermaid"] == ""  # fixture repo has no internal imports
    assert "`auth.py`" in first["tour_md"] and "`nope.py`" not in first["tour_md"] and "nope.py" in first["tour_md"]
    assert client.get(f"/repos/{ready_repo}/diagram").json() == first and len(calls) == 1
    kinds = {k for (k,) in conn.execute("SELECT kind FROM repo_artifacts WHERE repo_id = %s", (ready_repo,))}
    assert kinds == {"diagram", "tour"}


def test_diagram_llm_failure_is_503_but_diagram_cached(client, ready_repo, conn, monkeypatch):
    def boom(m): raise llm.LLMError("AI providers are busy, try again in a minute")
    monkeypatch.setattr(diagram.llm, "complete", boom)
    r = client.get(f"/repos/{ready_repo}/diagram")
    assert r.status_code == 503 and "busy" in r.json()["detail"]
    assert conn.execute("SELECT count(*) FROM repo_artifacts WHERE repo_id = %s AND kind = 'diagram'", (ready_repo,)).fetchone()[0] == 1


def test_diagram_not_ready_is_409(client, conn):
    rid = conn.execute("INSERT INTO repos (kind, source, title, status) VALUES "
                       "('github', 'https://github.com/a/b', 'a/b', 'indexing') RETURNING id").fetchone()[0]
    assert client.get(f"/repos/{rid}/diagram").status_code == 409
    assert client.get("/repos/999999/diagram").status_code == 404


def test_diagram_takes_question_slot_only_when_tour_uncached(client, ready_repo):
    from gitguru import api
    api._asked.clear()
    client.get(f"/repos/{ready_repo}/diagram")
    client.get(f"/repos/{ready_repo}/diagram")
    assert len(api._asked) == 1


def test_get_artifacts_returns_stored_row_when_a_concurrent_request_won(ready_repo, conn, monkeypatch):
    def racing_tour(title, files, edges):
        conn.execute("INSERT INTO repo_artifacts (repo_id, kind, content) VALUES (%s, 'tour', 'winner')", (ready_repo,))
        return "loser"
    monkeypatch.setattr(diagram, "build_tour", racing_tour)
    assert diagram.get_artifacts(conn, ready_repo)["tour_md"] == "winner"

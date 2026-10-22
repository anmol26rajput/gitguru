import json
import re

import pytest

from gitguru import walkthrough
from gitguru.llm import LLMError
from gitguru.search import Hit
from gitguru.style import PLAIN_LANGUAGE as PLAIN
from gitguru.walkthrough import Step, Walkthrough, is_code, valid_steps


def test_valid_steps_drops_invented_and_out_of_range():
    counts = {"auth.py": 33}
    steps = [Step(path="auth.py", start_line=8, end_line=10, narration="Hashes passwords."),
             Step(path="ghost.py", start_line=1, end_line=2, narration="x"),
             Step(path="auth.py", start_line=30, end_line=99, narration="x"),
             Step(path="auth.py", start_line=1, end_line=2, narration="")]
    assert [s.path for s in valid_steps(steps, counts)] == ["auth.py"]
    assert len(valid_steps([steps[0]] * 12, counts)) == 10


def test_valid_steps_strips_backticks_from_narration():
    s = Step(path="auth.py", start_line=8, end_line=10, narration="Calls `hash()` first.")
    assert valid_steps([s], {"auth.py": 33})[0].narration == "Calls hash() first."


def test_narration_limit_is_1200_chars():
    counts = {"auth.py": 33}
    step = lambda n: Step(path="auth.py", start_line=8, end_line=10, narration="x" * n)  # noqa: E731
    assert len(valid_steps([step(1200), step(1201)], counts)) == 1


def test_prompt_asks_for_how_the_code_runs(client, ready_repo, monkeypatch):
    seen = _capture(monkeypatch)
    client.post(f"/repos/{ready_repo}/walkthrough", json={})
    system = seen[0][0]["content"].lower()
    for fragment in ["at most 10 steps", "3 to 6 sentences", "what it receives and what it gives back or changes",
                     "what happens inside, in order", "which function or step runs next",
                     "only together with a plain explanation", "whole function"]:
        assert fragment in system, fragment


def test_walkthrough_endpoint_returns_valid_steps(client, ready_repo, monkeypatch):
    good = Walkthrough(steps=[Step(path="auth.py", start_line=8, end_line=10, narration="Hashing."),
                              Step(path="retry.py", start_line=1, end_line=5, narration="Retries."),
                              Step(path="nope.py", start_line=1, end_line=2, narration="Fake.")])
    monkeypatch.setattr(walkthrough, "complete_json", lambda m, s: good)
    r = client.post(f"/repos/{ready_repo}/walkthrough", json={"topic": "how login works"})
    assert r.status_code == 200 and [s["path"] for s in r.json()["steps"]] == ["auth.py", "retry.py"]


def test_walkthrough_retries_once_then_422(client, ready_repo, monkeypatch):
    calls = []
    bad = Walkthrough(steps=[Step(path="nope.py", start_line=1, end_line=2, narration="x")])
    monkeypatch.setattr(walkthrough, "complete_json", lambda m, s: calls.append(m) or bad)
    r = client.post(f"/repos/{ready_repo}/walkthrough", json={})
    assert r.status_code == 422 and "try a more specific topic" in r.json()["detail"] and len(calls) == 2
    assert "nope.py" in calls[1][-1]["content"] and "not a file" in calls[1][-1]["content"]


def _overview(conn, repo_id, content):
    conn.execute("INSERT INTO repo_artifacts (repo_id, kind, content) VALUES (%s, 'overview', %s)", (repo_id, content))


def _hit(path, i=0):
    return Hit(chunk_id=i, path=path, start_line=1, end_line=5, symbol=None, content=f"CONTENT-OF-{path}", score=1.0)


def _capture(monkeypatch):
    seen = []
    monkeypatch.setattr(walkthrough, "complete_json", lambda m, s: seen.append(m) or Walkthrough(steps=[]))
    return seen


def test_walkthrough_prompt_marks_untrusted_and_uses_cached_overview(client, ready_repo, conn, monkeypatch):
    _overview(conn, ready_repo, json.dumps({"summary": "SUMMARY-TEXT", "parts": [], "glossary": [],
                                            "how_it_works": [{"label": "Check login", "detail": "DETAIL-TEXT"}]}))
    seen = _capture(monkeypatch)
    client.post(f"/repos/{ready_repo}/walkthrough", json={})
    system, user = seen[0][0]["content"], seen[0][-1]["content"]
    assert "untrusted" in system and PLAIN in system
    assert "SUMMARY-TEXT" in user and "Check login" in user and "DETAIL-TEXT" in user


@pytest.mark.parametrize("bad", ["not json", "[1, 2]", '{"summary": 5, "how_it_works": "x", "parts": [1]}'])
def test_walkthrough_tolerates_missing_or_malformed_overview(client, ready_repo, conn, monkeypatch, bad):
    seen = _capture(monkeypatch)
    assert client.post(f"/repos/{ready_repo}/walkthrough", json={}).status_code == 422  # no overview row
    _overview(conn, ready_repo, bad)
    assert client.post(f"/repos/{ready_repo}/walkthrough", json={}).status_code == 422
    assert len(seen) == 4  # both requests reached the model


def test_is_code_truth_table():
    for p in ["auth.py", "utils/strings.go", "src/app.ts", "a/docs_helper.py", "pkg/security.py", "AUTHORS.py"]:
        assert is_code(p), p
    for p in ["LICENSE", "AUTHORS.rst", ".github/SECURITY.md", ".github/ci.py", "docs/x.py", "doc/x.py",
              "README.md", "CODE_OF_CONDUCT.md", "CONTRIBUTING.rst", "notes.txt"]:
        assert not is_code(p), p


def test_only_code_hits_reach_the_model(client, ready_repo, monkeypatch):
    hits = [_hit("AUTHORS.rst", 1), _hit("LICENSE", 2), _hit(".github/SECURITY.md", 3), _hit("auth.py", 4),
            _hit("README.md", 5), _hit("retry.py", 6), _hit("tests/test_auth.py", 7), _hit("server.js", 8)]
    asked = []
    monkeypatch.setattr(walkthrough, "retrieve", lambda *a, **kw: asked.append(kw) or hits)
    seen = _capture(monkeypatch)
    client.post(f"/repos/{ready_repo}/walkthrough", json={"topic": "how this repo works"})
    user = seen[0][-1]["content"]
    assert asked[0]["k"] == 30
    for kept in ["auth.py", "retry.py", "server.js"]:
        assert f"CONTENT-OF-{kept}" in user
    for dropped in ["AUTHORS", "LICENSE", "SECURITY", "README", "test_auth"]:
        assert f"CONTENT-OF-{dropped}" not in user and f"CONTENT-OF-.github/{dropped}" not in user


def test_keeps_first_twelve_code_hits(client, ready_repo, monkeypatch):
    monkeypatch.setattr(walkthrough, "retrieve", lambda *a, **kw: [_hit(f"m{i}.py", i) for i in range(30)])
    seen = _capture(monkeypatch)
    client.post(f"/repos/{ready_repo}/walkthrough", json={})
    user = seen[0][-1]["content"]
    assert "CONTENT-OF-m11.py" in user and "CONTENT-OF-m12.py" not in user


def test_offered_chunk_text_is_capped_but_keeps_min_hits(client, ready_repo, monkeypatch):
    big = lambda i, n: Hit(chunk_id=i, path=f"m{i}.py", start_line=1, end_line=5, symbol=None, content=f"B{i}" + "x" * n, score=1.0)  # noqa: E731
    monkeypatch.setattr(walkthrough, "retrieve", lambda *a, **kw: [big(i, 4000) for i in range(12)])
    seen = _capture(monkeypatch)
    client.post(f"/repos/{ready_repo}/walkthrough", json={})
    user = seen[0][-1]["content"]
    offered = [i for i in range(12) if f"B{i}x" in user]
    assert offered == list(range(len(offered))) and len(offered) < 12  # kept in order, tail dropped
    assert sum(4002 for _ in offered) <= walkthrough.CHUNK_CHARS + 4002  # at most one chunk over budget
    # the floor: five huge chunks all stay even though they exceed the budget
    monkeypatch.setattr(walkthrough, "retrieve", lambda *a, **kw: [big(i, 15000) for i in range(8)])
    seen = _capture(monkeypatch)
    client.post(f"/repos/{ready_repo}/walkthrough", json={})
    user = seen[0][-1]["content"]
    assert [i for i in range(8) if f"B{i}x" in user] == list(range(walkthrough.MIN_HITS))


def test_prompt_states_the_narration_cap(client, ready_repo, monkeypatch):
    seen = _capture(monkeypatch)
    client.post(f"/repos/{ready_repo}/walkthrough", json={})
    assert "at most 1,000 characters" in seen[0][0]["content"]


def test_test_files_only_when_topic_mentions_test(client, ready_repo, monkeypatch):
    hits = [_hit("auth.py", 1), _hit("tests/test_auth.py", 2), _hit("a_test.go", 3), _hit("b.spec.ts", 4), _hit("c.test.js", 5)]
    monkeypatch.setattr(walkthrough, "retrieve", lambda *a, **kw: hits)
    seen = _capture(monkeypatch)
    client.post(f"/repos/{ready_repo}/walkthrough", json={"topic": "how it works"})
    client.post(f"/repos/{ready_repo}/walkthrough", json={"topic": "how are the Tests run"})
    plain, with_tests = seen[0][-1]["content"], seen[2][-1]["content"]
    assert "CONTENT-OF-auth.py" in plain and not any(n in plain for n in ["test_auth", "a_test", "b.spec", "c.test"])
    assert all(n in with_tests for n in ["test_auth", "a_test", "b.spec", "c.test"])


def test_test_inside_another_word_does_not_count(client, ready_repo, monkeypatch):
    monkeypatch.setattr(walkthrough, "retrieve", lambda *a, **kw: [_hit("auth.py", 1), _hit("tests/test_auth.py", 2)])
    seen = _capture(monkeypatch)
    client.post(f"/repos/{ready_repo}/walkthrough", json={"topic": "the latest and fastest code paths"})
    client.post(f"/repos/{ready_repo}/walkthrough", json={"topic": "how testing works"})
    assert "test_auth" not in seen[0][-1]["content"] and "test_auth" in seen[2][-1]["content"]


def test_falls_back_to_chunks_under_overview_parts(client, ready_repo, conn, monkeypatch):
    # retrieval only finds docs; the overview points at a folder (utils) and a file (auth.py), plus a bogus and a docs part
    monkeypatch.setattr(walkthrough, "retrieve", lambda *a, **kw: [_hit("AUTHORS.rst", 1), _hit("auth.py", 2)])
    parts = [{"name": "Strings", "path": "utils", "what": "x"}, {"name": "Login", "path": "auth.py", "what": "x"},
             {"name": "Readme", "path": "README.md", "what": "x"}, {"name": "Ghost", "path": "ghost", "what": "x"}]
    _overview(conn, ready_repo, json.dumps({"summary": "s", "how_it_works": [], "parts": parts, "glossary": []}))
    seen = _capture(monkeypatch)
    client.post(f"/repos/{ready_repo}/walkthrough", json={})
    user = seen[0][-1]["content"]
    assert "utils/strings.go" in user and "AUTHORS" not in user and "README.md:" not in user


def test_no_top_up_when_five_code_hits(client, ready_repo, conn, monkeypatch):
    monkeypatch.setattr(walkthrough, "retrieve", lambda *a, **kw: [_hit(f"m{i}.py", i) for i in range(5)])
    _overview(conn, ready_repo, json.dumps({"summary": "s", "how_it_works": [], "glossary": [],
                                            "parts": [{"name": "S", "path": "utils", "what": "x"}]}))
    seen = _capture(monkeypatch)
    client.post(f"/repos/{ready_repo}/walkthrough", json={})
    assert "utils/strings.go" not in seen[0][-1]["content"]


def test_tops_up_to_at_least_five_code_chunks_in_part_order(client, ready_repo, conn, monkeypatch):
    monkeypatch.setattr(walkthrough, "retrieve", lambda *a, **kw: [_hit("auth.py", 1), _hit("LICENSE", 2), _hit("retry.py", 3)])
    parts = [{"name": n, "path": p, "what": "x"} for n, p in
             [("Server", "server.js"), ("Strings", "utils"), ("Login", "auth.py"), ("Retry", "retry.py")]]
    _overview(conn, ready_repo, json.dumps({"summary": "s", "how_it_works": [], "parts": parts, "glossary": []}))
    seen = _capture(monkeypatch)
    client.post(f"/repos/{ready_repo}/walkthrough", json={})
    user = seen[0][-1]["content"]
    labels = re.findall(r"^\[\d+\] (\S+?):\d+-\d+", user, re.M)
    assert len(labels) >= 5 and labels[:2] == ["auth.py", "retry.py"]  # retrieved code first
    full = re.findall(r"^\[\d+\] (\S+)", user, re.M)
    assert len(full) == len(set(full))  # no chunk offered twice
    assert labels.index("server.js") < labels.index("utils/strings.go")  # then parts in the overview's order
    assert len(labels) <= 12


def test_folder_part_prefers_a_real_module_over_init(client, ready_repo, conn, monkeypatch):
    vec = "[" + ",".join(["0"] * 768) + "]"
    for path, sym, body in [("pkg/__init__.py", None, "from .core import run  # re-export"),
                            ("pkg/aaa.py", None, "x = 1"),
                            ("pkg/core.py", "run", "def run():\n    return do_the_real_work()\n" * 5)]:
        conn.execute("INSERT INTO chunks (repo_id, strategy, path, start_line, end_line, lang, symbol, content, search_text, embedding) "
                     "VALUES (%s, 'ast', %s, 1, 5, 'python', %s, %s, %s, %s::vector)", (ready_repo, path, sym, body, body, vec))
    monkeypatch.setattr(walkthrough, "retrieve", lambda *a, **kw: [])
    _overview(conn, ready_repo, json.dumps({"summary": "s", "how_it_works": [], "glossary": [],
                                            "parts": [{"name": "Pkg", "path": "pkg", "what": "x"}]}))
    seen = _capture(monkeypatch)
    client.post(f"/repos/{ready_repo}/walkthrough", json={})
    user = seen[0][-1]["content"]
    assert "pkg/core.py" in user and "__init__" not in user and "pkg/aaa.py" not in user
    # glue is still used when it is all there is
    conn.execute("DELETE FROM chunks WHERE path IN ('pkg/core.py', 'pkg/aaa.py')")
    client.post(f"/repos/{ready_repo}/walkthrough", json={})
    assert "pkg/__init__.py" in seen[2][-1]["content"]


def test_overlapping_parts_do_not_repeat_a_chunk(client, ready_repo, conn, monkeypatch):
    monkeypatch.setattr(walkthrough, "retrieve", lambda *a, **kw: [])
    parts = [{"name": "Utils", "path": "utils", "what": "x"}, {"name": "Strings", "path": "utils/strings.go", "what": "x"}]
    _overview(conn, ready_repo, json.dumps({"summary": "s", "how_it_works": [], "parts": parts, "glossary": []}))
    seen = _capture(monkeypatch)
    client.post(f"/repos/{ready_repo}/walkthrough", json={})
    labels = re.findall(r"^\[\d+\] (\S+)", seen[0][-1]["content"], re.M)
    assert len(labels) == 1 and labels[0].startswith("utils/strings.go:"), labels  # folder and file picked the same chunk


def test_non_code_step_is_dropped(client, ready_repo, monkeypatch):
    good = Walkthrough(steps=[Step(path="README.md", start_line=1, end_line=2, narration="Intro."),
                              Step(path="auth.py", start_line=8, end_line=10, narration="Hashing."),
                              Step(path="retry.py", start_line=1, end_line=5, narration="Retries.")])
    monkeypatch.setattr(walkthrough, "complete_json", lambda m, s: good)
    r = client.post(f"/repos/{ready_repo}/walkthrough", json={})
    assert [s["path"] for s in r.json()["steps"]] == ["auth.py", "retry.py"]
    assert walkthrough._problem(good.steps[0], {"README.md": 9}) == "not a code file"


def test_walkthrough_unknown_repo_404_and_topic_too_long_422(client, ready_repo):
    assert client.post("/repos/9999/walkthrough", json={}).status_code == 404
    assert client.post(f"/repos/{ready_repo}/walkthrough", json={"topic": "x" * 201}).status_code == 422


def test_walkthrough_schema_failure_retries_then_422(client, ready_repo, monkeypatch):
    calls = []

    def broken(m, s):
        calls.append(m)
        return Walkthrough.model_validate_json("{}")  # raises ValidationError

    monkeypatch.setattr(walkthrough, "complete_json", broken)
    r = client.post(f"/repos/{ready_repo}/walkthrough", json={})
    assert r.status_code == 422 and "try a more specific topic" in r.json()["detail"] and len(calls) == 2


def test_walkthrough_llm_error_is_503(client, ready_repo, monkeypatch):
    def down(m, s):
        raise LLMError("AI providers are busy")

    monkeypatch.setattr(walkthrough, "complete_json", down)
    r = client.post(f"/repos/{ready_repo}/walkthrough", json={})
    assert r.status_code == 503 and "busy" in r.json()["detail"]

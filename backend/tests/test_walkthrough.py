from gitguru import walkthrough
from gitguru.llm import LLMError
from gitguru.walkthrough import Step, Walkthrough, valid_steps


def test_valid_steps_drops_invented_and_out_of_range():
    counts = {"auth.py": 33}
    steps = [Step(path="auth.py", start_line=8, end_line=10, narration="Hashes passwords."),
             Step(path="ghost.py", start_line=1, end_line=2, narration="x"),
             Step(path="auth.py", start_line=30, end_line=99, narration="x"),
             Step(path="auth.py", start_line=1, end_line=2, narration="")]
    assert [s.path for s in valid_steps(steps, counts)] == ["auth.py"]
    assert len(valid_steps([steps[0]] * 12, counts)) == 8


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


def test_walkthrough_prompt_marks_untrusted_and_uses_cached_tour(client, ready_repo, conn, monkeypatch):
    conn.execute("INSERT INTO repo_artifacts (repo_id, kind, content) VALUES (%s, 'tour', 'TOUR-TEXT')", (ready_repo,))
    seen = []
    monkeypatch.setattr(walkthrough, "complete_json", lambda m, s: seen.append(m) or Walkthrough(steps=[]))
    client.post(f"/repos/{ready_repo}/walkthrough", json={})
    client.post(f"/repos/{ready_repo}/walkthrough", json={"topic": "login"})
    assert "untrusted" in seen[0][0]["content"] and "TOUR-TEXT" in seen[0][-1]["content"]
    assert "TOUR-TEXT" not in seen[2][-1]["content"]  # topic given: no tour (calls 0,1 = first request + its retry)


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

import json

from gitguru import evals
from gitguru.evals import EvalQuestion, add_questions, is_hit, metrics, run_eval
from gitguru.index import index_source
from gitguru.search import Hit
from tests.conftest import FIXTURE_REPO

QUESTIONS = [EvalQuestion(**q) for q in json.loads(
    (FIXTURE_REPO.parent / "tiny_repo_questions.json").read_text())]


def test_is_hit_uses_line_overlap():
    q = EvalQuestion(question="?", gold_path="a.py", gold_start=10, gold_end=20)
    assert is_hit(Hit(1, "a.py", 18, 40, None, "", 0), q)
    assert not is_hit(Hit(1, "a.py", 21, 40, None, "", 0), q)
    assert not is_hit(Hit(1, "b.py", 10, 20, None, "", 0), q)


def test_metrics():
    m = metrics([1, 2, None, 6], [10, 20, 30, 40])
    assert m["hit_at_5"] == 0.5
    assert abs(m["mrr_at_10"] - (1 + 0.5 + 0 + 1 / 6) / 4) < 1e-9
    assert m["p50_ms"] == 25


def test_generate_questions_validates_llm_json(conn, monkeypatch):
    repo_id = index_source(conn, str(FIXTURE_REPO))
    monkeypatch.setattr(evals, "complete_json",
                        lambda messages, schema: schema(question="What does this code do?"))
    monkeypatch.setattr(evals.time, "sleep", lambda s: None)
    created = evals.generate_questions(conn, repo_id, n=3)
    assert created == 3
    assert evals.generate_questions(conn, repo_id, n=3) == 0  # already generated
    rows = conn.execute("SELECT origin, gold_path FROM eval_questions").fetchall()
    assert all(origin == "synthetic" for origin, _ in rows)


def test_run_eval_quality_gate(conn):
    """Regression gate: retrieval on the fixture repo must stay good."""
    repo_id = index_source(conn, str(FIXTURE_REPO))
    add_questions(conn, repo_id, QUESTIONS, "manual")
    rows = run_eval(conn, repo_id)
    assert len(rows) == len(evals.STRATEGIES) * 4
    best = next(r for r in rows if r["mode"] == "hybrid_rerank" and r["strategy"] == "ast")
    assert best["hit_at_5"] >= 0.8
    assert conn.execute("SELECT count(*) FROM eval_runs").fetchone()[0] == len(rows)
    line_chunks = conn.execute("SELECT count(*) FROM chunks WHERE strategy = 'line'").fetchone()[0]
    assert line_chunks > 0


def test_suggest_threshold(conn):
    repo_id = index_source(conn, str(FIXTURE_REPO))
    add_questions(conn, repo_id, QUESTIONS, "manual")
    s = evals.suggest_threshold(conn, repo_id)
    assert s["answerable_median"] > s["off_topic_median"]
    assert s["off_topic_median"] < s["suggested"] < s["answerable_median"]

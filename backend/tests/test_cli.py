import json

from gitguru import cli
from tests.conftest import FIXTURE_REPO, TEST_DB


def run(monkeypatch, *argv):
    monkeypatch.setattr(cli.config, "DATABASE_URL", TEST_DB)
    return cli.main(list(argv))


def test_index_ask_repos(conn, monkeypatch, capsys):
    assert run(monkeypatch, "index", str(FIXTURE_REPO)) == 0
    assert "ready" in capsys.readouterr().out

    assert run(monkeypatch, "ask", str(FIXTURE_REPO), "How are passwords hashed?") == 0
    out = capsys.readouterr().out
    assert "Fake answer citing [1]." in out and "[1] auth.py:" in out

    assert run(monkeypatch, "ask", "1", "How are passwords hashed?") == 0  # by id

    assert run(monkeypatch, "repos") == 0
    assert "tiny_repo" in capsys.readouterr().out


def test_unknown_repo_is_an_error(conn, monkeypatch, capsys):
    assert run(monkeypatch, "ask", "/nope", "q") == 1
    assert "not indexed" in capsys.readouterr().err


def test_bad_source_is_an_error(conn, monkeypatch, capsys):
    assert run(monkeypatch, "index", "https://gitlab.com/a/b") == 1
    assert "error:" in capsys.readouterr().err


def test_eval_command(conn, monkeypatch, capsys):
    run(monkeypatch, "index", str(FIXTURE_REPO))
    qfile = FIXTURE_REPO.parent / "tiny_repo_questions.json"
    assert run(monkeypatch, "eval", str(FIXTURE_REPO), "--questions", str(qfile), "--no-generate", "--tune") == 0
    out = capsys.readouterr().out
    assert "hybrid_rerank" in out and "Hit@5" in out and "suggested threshold" in out
    n = len(json.loads(qfile.read_text()))
    assert f"(n={n})" in out

    # rerunning replaces the manual questions instead of duplicating them
    assert run(monkeypatch, "eval", str(FIXTURE_REPO), "--questions", str(qfile), "--no-generate") == 0
    assert f"(n={n})" in capsys.readouterr().out


def test_eval_without_questions_is_an_error(conn, monkeypatch, capsys):
    run(monkeypatch, "index", str(FIXTURE_REPO))
    assert run(monkeypatch, "eval", str(FIXTURE_REPO), "--no-generate") == 1
    assert "no eval questions" in capsys.readouterr().err

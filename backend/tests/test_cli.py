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

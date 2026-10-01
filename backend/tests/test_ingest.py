import pytest

from gitguru.ingest import IngestError, normalize_github, walk


@pytest.mark.parametrize("url", [
    "https://github.com/psf/requests",
    "https://github.com/psf/requests/",
    "https://github.com/psf/requests.git",
    "http://www.github.com/psf/requests/blob/main/src/requests/api.py",
    "github.com/psf/requests/tree/main",
])
def test_normalize_github(url):
    assert normalize_github(url) == "https://github.com/psf/requests"


@pytest.mark.parametrize("url", ["https://gitlab.com/a/b", "https://github.com/psf", "not a url"])
def test_normalize_github_rejects(url):
    with pytest.raises(IngestError):
        normalize_github(url)


def _write(root, rel, data):
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data if isinstance(data, bytes) else data.encode())


def test_walk_keeps_code_and_skips_junk(tmp_path):
    _write(tmp_path, "src/app.py", "print('hi')\n")
    _write(tmp_path, "README.md", "# Demo\n")
    _write(tmp_path, "node_modules/lib/index.js", "x")
    _write(tmp_path, ".git/config", "x")
    _write(tmp_path, "package-lock.json", "{}")
    _write(tmp_path, "logo.png", b"\x89PNG\x00\x00binary")
    _write(tmp_path, "big.txt", "a" * 600_000)
    _write(tmp_path, "latin1.txt", "caf\xe9".encode("latin-1"))
    files, skipped = walk(tmp_path)
    assert [f.path for f in files] == ["README.md", "src/app.py"]
    assert skipped == 4  # lockfile, png, big.txt, latin1.txt (skipped dirs are not counted)


def test_walk_skips_minified_and_sourcemaps(tmp_path):
    _write(tmp_path, "app.min.js", "var a=1;")
    _write(tmp_path, "app.js.map", "{}")
    _write(tmp_path, "bundle.js", "x" * 3000)  # one giant line
    _write(tmp_path, "ok.js", "const a = 1;\n")
    files, _ = walk(tmp_path)
    assert [f.path for f in files] == ["ok.js"]


def test_walk_normalizes_crlf(tmp_path):
    _write(tmp_path, "win.py", "a = 1\r\nb = 2\r\n")
    files, _ = walk(tmp_path)
    assert files[0].text == "a = 1\nb = 2\n"


def test_walk_rejects_too_many_files(tmp_path, monkeypatch):
    import gitguru.ingest as ingest
    monkeypatch.setattr(ingest, "MAX_FILES", 2)
    for i in range(3):
        _write(tmp_path, f"f{i}.py", "x = 1\n")
    with pytest.raises(IngestError, match="too many files"):
        walk(tmp_path)

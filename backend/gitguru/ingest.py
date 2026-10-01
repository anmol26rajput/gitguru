"""Get source files from a GitHub repo or a local folder, skipping junk."""
import os
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

import httpx

from gitguru import config

MAX_FILES = 5000
MAX_FILE_BYTES = 500_000
MAX_LINE_CHARS = 2000          # longer lines mean minified/generated code
MAX_REPO_KB = 200_000          # GitHub reports size in KB
SKIP_DIRS = {".git", "node_modules", "vendor", "dist", "build", "target", ".venv", "venv",
             "__pycache__", ".next", ".mypy_cache", ".pytest_cache", ".idea", ".vscode"}
LOCKFILES = {"package-lock.json", "yarn.lock", "pnpm-lock.yaml", "poetry.lock", "uv.lock",
             "Cargo.lock", "go.sum", "Gemfile.lock", "composer.lock"}
SKIP_SUFFIXES = (".min.js", ".min.css", ".map")
GITHUB_RE = re.compile(r"^(?:https?://)?(?:www\.)?github\.com/([\w.-]+)/([\w.-]+?)(?:\.git)?(?:/.*)?$")


class IngestError(Exception):
    pass


@dataclass
class SourceFile:
    path: str
    text: str


def normalize_github(url: str) -> str:
    m = GITHUB_RE.match(url.strip())
    if not m:
        raise IngestError(f"not a GitHub repository URL: {url}")
    return f"https://github.com/{m.group(1)}/{m.group(2)}"


def _read(path: Path) -> str | None:
    """Return normalized text, or None if the file should be skipped."""
    if path.name in LOCKFILES or path.name.endswith(SKIP_SUFFIXES):
        return None
    if path.stat().st_size > MAX_FILE_BYTES:
        return None
    data = path.read_bytes()
    if b"\x00" in data[:8192]:
        return None
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return None
    text = text.replace("\r\n", "\n")
    if any(len(line) > MAX_LINE_CHARS for line in text.split("\n")):
        return None
    return text


def walk(root: Path) -> tuple[list[SourceFile], int]:
    files, skipped = [], 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            full = Path(dirpath) / name
            if full.is_symlink():
                skipped += 1
                continue
            text = _read(full)
            if text is None:
                skipped += 1
                continue
            files.append(SourceFile(full.relative_to(root).as_posix(), text))
            if len(files) > MAX_FILES:
                raise IngestError(f"too many files (more than {MAX_FILES}) for GitGuru v1")
    files.sort(key=lambda f: f.path)
    return files, skipped


def github_check(url: str) -> None:
    owner_repo = url.removeprefix("https://github.com/")
    headers = {"Authorization": f"Bearer {config.GITHUB_TOKEN}"} if config.GITHUB_TOKEN else {}
    r = httpx.get(f"https://api.github.com/repos/{owner_repo}", headers=headers, timeout=15)
    if r.status_code == 404:
        raise IngestError("repository not found or private")
    r.raise_for_status()
    info = r.json()
    if info.get("private"):
        raise IngestError("private repositories are not supported yet")
    if info.get("size", 0) > MAX_REPO_KB:
        raise IngestError(f"repository is larger than {MAX_REPO_KB // 1000} MB")


def _git(*args: str, cwd: Path | None = None) -> str:
    result = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        raise IngestError(f"git {args[0]} failed: {result.stderr.strip()[:300]}")
    return result.stdout.strip()


def remote_head(url: str) -> str:
    return _git("ls-remote", url, "HEAD").split()[0]


def local_head(root: Path) -> str | None:
    if not (root / ".git").exists():
        return None
    return _git("rev-parse", "HEAD", cwd=root)


def clone(url: str, dest: Path) -> Path:
    _git("clone", "--depth", "1", "--quiet", url, str(dest))
    return dest

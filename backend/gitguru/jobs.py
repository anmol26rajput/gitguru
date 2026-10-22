"""Index and eval jobs: one at a time (D25), progress kept in the `jobs` table so SSE survives restarts."""
import threading
import time
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor

from gitguru import evals
from gitguru.index import Progress, index_source, source_key
from gitguru.ingest import IngestError

DAILY_JOBS = 10
MAX_REPOS = 20
EXECUTOR = ThreadPoolExecutor(max_workers=1)  # the one-job-at-a-time lock; queued jobs wait here
_create_lock = threading.Lock()  # makes check-then-insert in create_*_job atomic


class LimitError(Exception):
    pass


def _check_daily_cap(conn) -> None:
    today = conn.execute("SELECT count(*) FROM jobs WHERE kind IN ('index', 'eval')"
                         " AND created_at >= date_trunc('day', now())").fetchone()[0]
    if today >= DAILY_JOBS:
        raise LimitError(f"daily limit of {DAILY_JOBS} jobs (index + eval) reached, try again tomorrow")


def create_index_job(conn, source: str) -> tuple[int, int]:
    """Return (repo_id, job_id); an already queued/running job for this repo is reused."""
    kind, key = source_key(source)
    if kind != "github":
        raise IngestError("GitHub URLs only")
    with _create_lock:
        row = conn.execute(
            "SELECT j.repo_id, j.id FROM jobs j JOIN repos r ON r.id = j.repo_id"
            " WHERE r.source = %s AND j.kind = 'index' AND j.status IN ('queued', 'running')"
            " ORDER BY j.id DESC LIMIT 1", (key,)).fetchone()
        if row:
            return row[0], row[1]
        _check_daily_cap(conn)
        known = conn.execute("SELECT 1 FROM repos WHERE source = %s", (key,)).fetchone()
        if not known and conn.execute("SELECT count(*) FROM repos").fetchone()[0] >= MAX_REPOS:
            conn.execute("DELETE FROM repos WHERE id = (SELECT id FROM repos"
                         " ORDER BY last_used_at ASC LIMIT 1)")
        # Existing rows keep their status, so an unchanged ready repo still takes index_source's fast path.
        repo_id = conn.execute(
            "INSERT INTO repos (kind, source, title, status) VALUES ('github', %s, %s, 'pending')"
            " ON CONFLICT (source) DO UPDATE SET last_used_at = now() RETURNING id",
            (key, key.removeprefix("https://github.com/"))).fetchone()[0]
        job_id = conn.execute("INSERT INTO jobs (repo_id, kind, status) VALUES (%s, 'index', 'queued')"
                              " RETURNING id", (repo_id,)).fetchone()[0]
        return repo_id, job_id


def create_eval_job(conn, repo_id: int) -> int:
    """Return the job id; an already queued/running eval job for this repo is reused."""
    with _create_lock:
        row = conn.execute("SELECT id FROM jobs WHERE repo_id = %s AND kind = 'eval'"
                           " AND status IN ('queued', 'running') ORDER BY id DESC LIMIT 1", (repo_id,)).fetchone()
        if row:
            return row[0]
        _check_daily_cap(conn)
        return conn.execute("INSERT INTO jobs (repo_id, kind, status) VALUES (%s, 'eval', 'queued')"
                            " RETURNING id", (repo_id,)).fetchone()[0]


def _run_job(pool, job_id: int, work: Callable, on_fail: Callable = lambda conn: None) -> None:
    """queued -> running -> done/failed; work(conn, progress) does the job."""
    with pool.connection() as conn:
        def progress(pct: int, msg: str) -> None:
            conn.execute("UPDATE jobs SET progress = %s, message = %s WHERE id = %s", (pct, msg, job_id))

        # A double-click reuses the queued job and submits it twice; only the first run proceeds.
        if conn.execute("UPDATE jobs SET status = 'running' WHERE id = %s AND status = 'queued'"
                        " RETURNING id", (job_id,)).fetchone() is None:
            return
        try:
            work(conn, progress)
            conn.execute("UPDATE jobs SET status = 'done', progress = 100, finished_at = now()"
                         " WHERE id = %s", (job_id,))
        except Exception as e:
            conn.execute("UPDATE jobs SET status = 'failed', message = %s, finished_at = now()"
                         " WHERE id = %s", (str(e), job_id))
            on_fail(conn)


def run_index_job(pool, job_id: int, source: str) -> None:
    def fail_repo(conn) -> None:
        # index_source marks the repo failed only once it has started; cover earlier failures.
        conn.execute("UPDATE repos SET status = 'failed' WHERE status IN ('pending', 'indexing')"
                     " AND id = (SELECT repo_id FROM jobs WHERE id = %s)", (job_id,))

    _run_job(pool, job_id, lambda conn, progress: index_source(conn, source, progress), fail_repo)


def run_eval_job(pool, job_id: int, repo_id: int, generate: bool) -> None:
    def work(conn, progress: Progress) -> None:
        if generate:
            progress(0, "generating questions")
            evals.generate_questions(conn, repo_id)
            progress(10, "questions ready")
        # run_eval reports 0-100; map it onto the remaining 10-100
        evals.run_eval(conn, repo_id, lambda pct, msg: progress(10 + pct * 9 // 10, msg))

    _run_job(pool, job_id, work)


def job_events(pool, job_id: int, poll_s: float = 0.5) -> Iterator[dict]:
    """Yield progress when the row changes, then one done/error event, then stop."""
    last = None
    while True:
        with pool.connection() as conn:  # per poll, never for the whole job (D25)
            row = conn.execute("SELECT status, progress, message, repo_id FROM jobs WHERE id = %s",
                               (job_id,)).fetchone()
        if row is None:
            yield {"event": "error", "data": {"message": "job not found"}}
            return
        status, pct, message, repo_id = row
        if status == "failed":
            yield {"event": "error", "data": {"message": message}}
            return
        if (pct, message) != last:
            last = (pct, message)
            yield {"event": "progress", "data": {"pct": pct, "message": message}}
        if status == "done":
            yield {"event": "done", "data": {"repo_id": repo_id}}
            return
        time.sleep(poll_s)

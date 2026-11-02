"""Index and eval jobs: one at a time (D25), progress kept in the `jobs` table so SSE survives restarts."""
import threading
import time
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor

from gitguru import config, evals, pages
from gitguru.index import Progress, index_source, source_key
from gitguru.ingest import IngestError

MAX_REPOS = 20
EXECUTOR = ThreadPoolExecutor(max_workers=1)  # the one-job-at-a-time lock; queued jobs wait here
_create_lock = threading.Lock()  # makes check-then-insert in create_*_job atomic


class LimitError(Exception):
    pass


class ConflictError(IngestError):
    """The source is already indexed as the other kind (a repo vs a web page): HTTP 409."""


def _check_daily_cap(conn, client: str | None) -> None:
    """Guests (client = visitor key) get a daily cap each and one across all guests; the owner (None) has none.
    Guests also stop once the database passes GUEST_DB_MAX_BYTES (Neon's free tier is 0.5 GB)."""
    if client is None:
        return
    # ponytail: a big repo still blocks the single executor and can overshoot the limit; the upgrade is a size
    # estimate (GitHub's repo size) before indexing
    if conn.execute("SELECT pg_database_size(current_database())").fetchone()[0] > config.GUEST_DB_MAX_BYTES:
        raise LimitError("GitGuru is full right now. Try again later.")
    mine, guests = conn.execute(
        "SELECT count(*) FILTER (WHERE client = %s), count(*) FROM jobs WHERE client IS NOT NULL"
        " AND kind IN ('index', 'eval') AND created_at >= date_trunc('day', now())", (client,)).fetchone()
    if mine >= config.GUEST_DAILY_JOBS:
        raise LimitError(f"You can add {config.GUEST_DAILY_JOBS} repos or pages a day. Try again tomorrow.")
    if guests >= config.GUEST_TOTAL_DAILY_JOBS:
        raise LimitError("GitGuru's daily limit for visitors is reached. Try again tomorrow.")


# Repos only guests ever indexed: a guest index job and no owner (NULL-client) one. Job-less (CLI) repos stay.
_GUEST_ONLY = (" WHERE EXISTS (SELECT 1 FROM jobs WHERE repo_id = r.id AND kind = 'index' AND client IS NOT NULL)"
               " AND NOT EXISTS (SELECT 1 FROM jobs WHERE repo_id = r.id AND kind = 'index' AND client IS NULL)")


def _ready_job(conn, key: str, client: str | None) -> tuple[int, int] | None:
    """A guest re-adding a ready source gets (repo_id, its latest done index job): no new job, no slot spent.
    Guests can't refresh a ready source (re-index it or overwrite a page's text/title); the owner can."""
    if client is None:
        return None
    repo = conn.execute("UPDATE repos SET last_used_at = now() WHERE source = %s AND status = 'ready'"
                        " RETURNING id", (key,)).fetchone()
    if repo is None:
        return None
    job = conn.execute("SELECT id FROM jobs WHERE repo_id = %s AND kind = 'index' AND status = 'done'"
                       " ORDER BY id DESC LIMIT 1", repo).fetchone()
    if job is None:  # indexed by the CLI: a done owner (NULL-client) row, so the web has a job to stream
        job = conn.execute("INSERT INTO jobs (repo_id, kind, status, progress, message, finished_at)"
                           " VALUES (%s, 'index', 'done', 100, 'already indexed', now()) RETURNING id", repo).fetchone()
    return repo[0], job[0]


def _make_room(conn, key: str, client: str | None) -> None:
    """A new repo past MAX_REPOS evicts the least recently used one; a guest may only evict guest-only repos."""
    known = conn.execute("SELECT 1 FROM repos WHERE source = %s", (key,)).fetchone()
    if known or conn.execute("SELECT count(*) FROM repos").fetchone()[0] < MAX_REPOS:
        return
    only = "" if client is None else _GUEST_ONLY
    if conn.execute(f"DELETE FROM repos WHERE id = (SELECT id FROM repos r{only} ORDER BY last_used_at ASC LIMIT 1)"
                    " RETURNING id").fetchone() is None:
        raise LimitError("GitGuru is full right now. Try again later.")


def create_index_job(conn, source: str, client: str | None = None) -> tuple[int, int]:
    """Return (repo_id, job_id); an already queued/running job for this repo is reused."""
    kind, key = source_key(source)
    if kind != "github":
        raise IngestError("GitHub URLs only")
    with _create_lock:
        known = conn.execute("SELECT kind FROM repos WHERE source = %s", (key,)).fetchone()
        if known and known[0] == "page":  # a repo must never take over a page that has the same source
            raise ConflictError("this URL is already indexed as a web page")
        row = conn.execute(
            "SELECT j.repo_id, j.id FROM jobs j JOIN repos r ON r.id = j.repo_id"
            " WHERE r.source = %s AND j.kind = 'index' AND j.status IN ('queued', 'running')"
            " ORDER BY j.id DESC LIMIT 1", (key,)).fetchone()
        if row:
            return row[0], row[1]
        if ready := _ready_job(conn, key, client):
            return ready
        _check_daily_cap(conn, client)
        _make_room(conn, key, client)
        # Existing rows keep their status, so an unchanged ready repo still takes index_source's fast path.
        repo_id = conn.execute(
            "INSERT INTO repos (kind, source, title, status) VALUES ('github', %s, %s, 'pending')"
            " ON CONFLICT (source) DO UPDATE SET last_used_at = now() RETURNING id",
            (key, key.removeprefix("https://github.com/"))).fetchone()[0]
        job_id = conn.execute("INSERT INTO jobs (repo_id, kind, status, client) VALUES (%s, 'index', 'queued', %s)"
                              " RETURNING id", (repo_id, client)).fetchone()[0]
        return repo_id, job_id


def create_page_job(conn, source: str, title: str, client: str | None = None) -> tuple[int, int]:
    """Return (repo_id, job_id) for a web page; a queued/running job for the same URL is reused."""
    with _create_lock:
        row = conn.execute(
            "SELECT j.repo_id, j.id FROM jobs j JOIN repos r ON r.id = j.repo_id"
            " WHERE r.source = %s AND r.kind = 'page' AND j.kind = 'index' AND j.status IN ('queued', 'running')"
            " ORDER BY j.id DESC LIMIT 1", (source,)).fetchone()
        if row:
            return row[0], row[1]
        known = conn.execute("SELECT kind FROM repos WHERE source = %s", (source,)).fetchone()
        if known and known[0] != "page":  # a page must never overwrite a repo that has the same source
            raise ConflictError("this URL is already indexed as a repository")
        if ready := _ready_job(conn, source, client):
            return ready
        _check_daily_cap(conn, client)
        _make_room(conn, source, client)
        repo_id = conn.execute(
            "INSERT INTO repos (kind, source, title, status) VALUES ('page', %s, %s, 'pending')"
            " ON CONFLICT (source) DO UPDATE SET title = EXCLUDED.title, last_used_at = now() RETURNING id",
            (source, title)).fetchone()[0]
        job_id = conn.execute("INSERT INTO jobs (repo_id, kind, status, client) VALUES (%s, 'index', 'queued', %s)"
                              " RETURNING id", (repo_id, client)).fetchone()[0]
        return repo_id, job_id


def create_eval_job(conn, repo_id: int, client: str | None = None) -> int:
    """Return the job id; an already queued/running eval job for this repo is reused."""
    with _create_lock:
        row = conn.execute("SELECT id FROM jobs WHERE repo_id = %s AND kind = 'eval'"
                           " AND status IN ('queued', 'running') ORDER BY id DESC LIMIT 1", (repo_id,)).fetchone()
        if row:
            return row[0]
        _check_daily_cap(conn, client)
        return conn.execute("INSERT INTO jobs (repo_id, kind, status, client) VALUES (%s, 'eval', 'queued', %s)"
                            " RETURNING id", (repo_id, client)).fetchone()[0]


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


def _fail_repo(job_id: int) -> Callable:
    def fail_repo(conn) -> None:
        # index_source marks the repo failed only once it has started; cover earlier failures.
        conn.execute("UPDATE repos SET status = 'failed' WHERE status IN ('pending', 'indexing')"
                     " AND id = (SELECT repo_id FROM jobs WHERE id = %s)", (job_id,))
    return fail_repo


def run_index_job(pool, job_id: int, source: str) -> None:
    _run_job(pool, job_id, lambda conn, progress: index_source(conn, source, progress), _fail_repo(job_id))


def run_page_job(pool, job_id: int, repo_id: int, text: str) -> None:
    _run_job(pool, job_id, lambda conn, progress: pages.index_page(conn, repo_id, text, progress), _fail_repo(job_id))


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

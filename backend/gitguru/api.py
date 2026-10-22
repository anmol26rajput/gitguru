"""HTTP API: pool, token auth, CORS, body limit. Routes live below the auth router."""
import json
import logging
import math
import secrets
import threading
import time
from collections import deque
from collections.abc import Iterable, Iterator
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import APIRouter, Depends, FastAPI, Header, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field, ValidationError

from gitguru import config, diagram, evals, jobs, llm, overview, tts, walkthrough
from gitguru.ask import answer
from gitguru.db import make_pool
from gitguru.ingest import IngestError

log = logging.getLogger(__name__)
MAX_BODY_BYTES = 1_000_000
MAX_QUESTIONS_PER_HOUR = 60
_asked: deque[float] = deque()  # time.monotonic() of each ask in the last hour; in-memory, per process
_asked_lock = threading.Lock()


def recover_interrupted(pool) -> None:
    """Jobs and repos left mid-flight by a dead server can never finish; fail them."""
    with pool.connection() as conn:
        conn.execute("UPDATE jobs SET status = 'failed', message = 'interrupted, please retry', "
                     "finished_at = now() WHERE status IN ('queued', 'running')")
        conn.execute("UPDATE repos SET status = 'failed' WHERE status IN ('pending', 'indexing')")


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.pool = make_pool()
    recover_interrupted(app.state.pool)
    yield
    app.state.pool.close()


def require_token(x_gitguru_token: str = Header("")) -> None:
    """Fail closed: an unset APP_TOKEN rejects everything."""
    if not config.APP_TOKEN or not secrets.compare_digest(x_gitguru_token.encode(), config.APP_TOKEN.encode()):
        raise HTTPException(status_code=401, detail="missing or invalid token")


app = FastAPI(title="GitGuru", lifespan=lifespan)


@app.middleware("http")
async def limit_body(request: Request, call_next):
    # ponytail: trusts Content-Length; chunked uploads bypass it, add a streaming counter if that matters
    length = request.headers.get("content-length", "0")
    if length.isdigit() and int(length) > MAX_BODY_BYTES:
        return JSONResponse({"detail": "request body too large"}, status_code=413)
    return await call_next(request)


# Added after limit_body so CORS is outermost and 413/401 responses carry CORS headers.
app.add_middleware(CORSMiddleware, allow_origins=config.CORS_ORIGINS, allow_methods=["*"],
                   allow_headers=["X-GitGuru-Token", "Content-Type"])

protected = APIRouter(dependencies=[Depends(require_token)])


@app.get("/health")
def health() -> dict:
    return {"ok": True}


def sse(events: Iterable[dict]) -> Iterator[str]:
    for e in events:
        yield f"event: {e['event']}\ndata: {json.dumps(e['data'])}\n\n"


class AddRepo(BaseModel):
    source: str


REPO_COLS = "id, kind, source, title, status, stats, last_used_at"


def repo_json(row) -> dict:
    return dict(zip(("id", "kind", "source", "title", "status", "stats", "last_used_at"), row))


@protected.post("/repos")
def add_repo(body: AddRepo, request: Request) -> dict:
    pool = request.app.state.pool
    try:
        with pool.connection() as conn:
            repo_id, job_id = jobs.create_index_job(conn, body.source)
    except IngestError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except jobs.LimitError as e:
        raise HTTPException(status_code=429, detail=str(e))
    # A reused job is submitted again; run_index_job skips it unless still queued.
    jobs.EXECUTOR.submit(jobs.run_index_job, pool, job_id, body.source)
    return {"repo_id": repo_id, "job_id": job_id}


@protected.get("/repos")
def list_repos(request: Request) -> list:
    cols = ", ".join(f"r.{c}" for c in REPO_COLS.split(", "))
    with request.app.state.pool.connection() as conn:  # one query: latest index job + cached overview per repo
        rows = conn.execute(
            f"SELECT {cols}, j.progress, j.message, a.content FROM repos r "
            "LEFT JOIN LATERAL (SELECT progress, message FROM jobs WHERE repo_id = r.id AND kind = 'index' "
            "ORDER BY created_at DESC, id DESC LIMIT 1) j ON true "
            "LEFT JOIN repo_artifacts a ON a.repo_id = r.id AND a.kind = 'overview' "
            "ORDER BY r.last_used_at DESC").fetchall()
    out = []
    for *repo, progress, message, content in rows:
        o = diagram._valid_overview(content)
        out.append({**repo_json(repo), "summary": overview.blurb(o) if o else None, "progress": progress, "message": message})
    return out


@protected.get("/repos/{repo_id}")
def get_repo(repo_id: int, request: Request) -> dict:
    with request.app.state.pool.connection() as conn:
        row = conn.execute(f"SELECT {REPO_COLS} FROM repos WHERE id = %s", (repo_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="repo not found")
    return repo_json(row)


@protected.delete("/repos/{repo_id}", status_code=204)
def delete_repo(repo_id: int, request: Request) -> Response:
    with request.app.state.pool.connection() as conn:
        gone = conn.execute("DELETE FROM repos WHERE id = %s RETURNING id", (repo_id,)).fetchone()
    if gone is None:
        raise HTTPException(status_code=404, detail="repo not found")
    return Response(status_code=204)


@protected.get("/jobs/{job_id}/events")
def job_stream(job_id: int, request: Request) -> StreamingResponse:
    pool = request.app.state.pool
    with pool.connection() as conn:
        if conn.execute("SELECT 1 FROM jobs WHERE id = %s", (job_id,)).fetchone() is None:
            raise HTTPException(status_code=404, detail="job not found")
    return StreamingResponse(sse(jobs.job_events(pool, job_id)), media_type="text/event-stream")


class Message(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=4000)


class Ask(BaseModel):
    question: str = Field(min_length=1, max_length=1000)
    history: list[Message] = Field(default_factory=list, max_length=6)


def take_question_slot() -> None:
    """Count one ask against the hourly limit, or raise 429."""
    now = time.monotonic()
    with _asked_lock:
        while _asked and now - _asked[0] > 3600:
            _asked.popleft()
        if len(_asked) >= MAX_QUESTIONS_PER_HOUR:
            minutes = math.ceil((_asked[0] + 3600 - now) / 60)
            raise HTTPException(status_code=429, detail=f"question limit reached "
                                f"({MAX_QUESTIONS_PER_HOUR}/hour), try again in {minutes} min")
        _asked.append(now)


def _ready_repo(conn, repo_id: int) -> str:
    """The repo's title; 404 if unknown, 409 if not ready."""
    row = conn.execute("SELECT title, status FROM repos WHERE id = %s", (repo_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="repo not found")
    if row[1] != "ready":
        raise HTTPException(status_code=409, detail=f"repo is not ready (status: {row[1]})")
    return row[0]


@protected.post("/repos/{repo_id}/ask")
def ask(repo_id: int, body: Ask, request: Request) -> StreamingResponse:
    pool = request.app.state.pool
    with pool.connection() as conn:  # real HTTP errors must happen before the stream starts
        _ready_repo(conn, repo_id)
        take_question_slot()
        conn.execute("UPDATE repos SET last_used_at = now() WHERE id = %s", (repo_id,))
    history = [m.model_dump() for m in body.history]

    def stream() -> Iterator[str]:
        with pool.connection() as conn:
            yield from sse(answer(conn, repo_id, body.question, history))

    return StreamingResponse(stream(), media_type="text/event-stream")


@protected.get("/repos/{repo_id}/diagram")
def get_diagram(repo_id: int, request: Request) -> dict:
    with request.app.state.pool.connection() as conn:
        _ready_repo(conn, repo_id)
        if diagram.needs_overview(conn, repo_id):
            take_question_slot()  # only an overview that needs the LLM counts
        try:
            return diagram.get_artifacts(conn, repo_id)
        except llm.LLMError as e:
            raise HTTPException(status_code=503, detail=str(e))
        except ValidationError:  # the model's JSON was still invalid after the repair retry
            raise HTTPException(status_code=503, detail="I couldn't build the overview, try again")


class WalkthroughRequest(BaseModel):
    topic: str | None = Field(default=None, max_length=200)


@protected.post("/repos/{repo_id}/walkthrough")
def post_walkthrough(repo_id: int, body: WalkthroughRequest, request: Request) -> dict:
    with request.app.state.pool.connection() as conn:
        _ready_repo(conn, repo_id)
        take_question_slot()
        try:
            steps = walkthrough.make_walkthrough(conn, repo_id, body.topic)
        except walkthrough.WalkthroughError as e:
            raise HTTPException(status_code=422, detail=str(e))
        except llm.LLMError as e:
            raise HTTPException(status_code=503, detail=str(e))
    return {"steps": [s.model_dump() for s in steps]}


class EvalRequest(BaseModel):
    questions: list[evals.EvalQuestion] | None = None
    generate: bool = True


@protected.post("/repos/{repo_id}/evals")
def post_eval(repo_id: int, body: EvalRequest, request: Request) -> dict:
    pool = request.app.state.pool
    with pool.connection() as conn:
        _ready_repo(conn, repo_id)
        try:
            job_id = jobs.create_eval_job(conn, repo_id)
        except jobs.LimitError as e:
            raise HTTPException(status_code=429, detail=str(e))
        if body.questions is not None:  # after the cap check, before the job can start
            evals.replace_manual_questions(conn, repo_id, body.questions)
    # A reused job is submitted again; run_eval_job skips it unless still queued.
    jobs.EXECUTOR.submit(jobs.run_eval_job, pool, job_id, repo_id, body.generate)
    return {"job_id": job_id}


@protected.get("/repos/{repo_id}/evals")
def list_evals(repo_id: int, request: Request) -> list:
    with request.app.state.pool.connection() as conn:
        if conn.execute("SELECT 1 FROM repos WHERE id = %s", (repo_id,)).fetchone() is None:
            raise HTTPException(status_code=404, detail="repo not found")
        rows = conn.execute("SELECT id, mode, strategy, n, hit_at_5, mrr_at_10, p50_ms, created_at"
                            " FROM eval_runs WHERE repo_id = %s ORDER BY id DESC", (repo_id,)).fetchall()
    return [dict(zip(("id", "mode", "strategy", "n", "hit_at_5", "mrr_at_10", "p50_ms", "created_at"), r))
            for r in rows]


@protected.get("/repos/{repo_id}/file")
def get_file(repo_id: int, path: str, request: Request) -> dict:
    with request.app.state.pool.connection() as conn:
        row = conn.execute("SELECT path, lang, content FROM files WHERE repo_id = %s AND path = %s",
                           (repo_id, path)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="file not found")
    return dict(zip(("path", "lang", "content"), row))


class TTSRequest(BaseModel):
    text: str = Field(min_length=1, max_length=1500)


@protected.post("/tts")
def post_tts(body: TTSRequest) -> Response:
    # sync def: FastAPI runs it in a worker thread, so asyncio.run inside tts is safe and never blocks the loop
    try:
        return Response(content=tts.synthesize(body.text, config.TTS_VOICE), media_type="audio/mpeg")
    except tts.TTSError as e:
        log.warning("tts failed: %s", e)
        raise HTTPException(status_code=503, detail="voice service unavailable")


app.include_router(protected)

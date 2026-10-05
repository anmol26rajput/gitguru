"""Measure retrieval quality: Hit@5, MRR@10, latency, per search mode and chunking strategy."""
import statistics
import time
from collections import Counter

from pydantic import BaseModel

from gitguru.chunk import chunk_file
from gitguru.index import Progress, store_chunks
from gitguru.llm import complete_json
from gitguru.search import MODES, Hit, retrieve

STRATEGIES = ("ast", "line")
PER_FILE = 3
OFF_TOPIC = [
    "How does this connect to Kafka?", "Where is the payment refund logic?",
    "How are Kubernetes pods autoscaled?", "What is the recipe for chocolate cake?",
    "How does the GraphQL federation gateway work?", "Where are push notifications sent to iOS?",
    "How is the machine learning model trained on GPUs?", "Which SQL migration adds the invoices table?",
    "How does the game engine render shadows?", "Where is the Bluetooth pairing handled?",
]


class EvalQuestion(BaseModel):
    question: str
    gold_path: str
    gold_start: int
    gold_end: int


class _Generated(BaseModel):
    question: str


def _noop(pct: int, msg: str) -> None:
    pass


def is_hit(hit: Hit, q: EvalQuestion) -> bool:
    return hit.path == q.gold_path and hit.start_line <= q.gold_end and hit.end_line >= q.gold_start


def metrics(ranks: list[int | None], latencies_ms: list[float]) -> dict:
    n = len(ranks)
    return {
        "hit_at_5": sum(1 for r in ranks if r and r <= 5) / n,
        "mrr_at_10": sum(1 / r for r in ranks if r and r <= 10) / n,
        "p50_ms": statistics.median(latencies_ms),
    }


def add_questions(conn, repo_id, questions: list[EvalQuestion], origin: str) -> None:
    conn.cursor().executemany(
        "INSERT INTO eval_questions (repo_id, question, gold_path, gold_start, gold_end, origin)"
        " VALUES (%s, %s, %s, %s, %s, %s)",
        [(repo_id, q.question, q.gold_path, q.gold_start, q.gold_end, origin) for q in questions],
    )


def _questions(conn, repo_id) -> list[EvalQuestion]:
    rows = conn.execute(
        "SELECT question, gold_path, gold_start, gold_end FROM eval_questions WHERE repo_id = %s ORDER BY id",
        (repo_id,),
    ).fetchall()
    return [EvalQuestion(question=r[0], gold_path=r[1], gold_start=r[2], gold_end=r[3]) for r in rows]


def generate_questions(conn, repo_id, n=50) -> int:
    exists = conn.execute(
        "SELECT 1 FROM eval_questions WHERE repo_id = %s AND origin = 'synthetic' LIMIT 1", (repo_id,)
    ).fetchone()
    if exists:
        return 0
    rows = conn.execute(
        "SELECT path, start_line, end_line, content FROM chunks"
        " WHERE repo_id = %s AND strategy = 'ast' AND symbol IS NOT NULL ORDER BY random()",
        (repo_id,),
    ).fetchall()
    per_file, picked = Counter(), []
    for row in rows:
        if per_file[row[0]] < PER_FILE:
            per_file[row[0]] += 1
            picked.append(row)
        if len(picked) == n:
            break
    created = []
    for path, start, end, content in picked:
        gen = complete_json([{"role": "user", "content": (
            f"Here is code from {path}:\n```\n{content}\n```\n"
            "Write ONE question a developer might ask whose answer is this code. "
            "Paraphrase: do not copy function, class or variable names. "
            'Reply with only JSON: {"question": "..."}')}], _Generated)
        created.append(EvalQuestion(question=gen.question, gold_path=path, gold_start=start, gold_end=end))
        time.sleep(2.1)  # ponytail: stays under ~30 requests/min free-tier limits; batch if limits grow
    add_questions(conn, repo_id, created, "synthetic")
    return len(created)


def ensure_line_chunks(conn, repo_id, progress: Progress) -> None:
    if conn.execute("SELECT 1 FROM chunks WHERE repo_id = %s AND strategy = 'line' LIMIT 1",
                    (repo_id,)).fetchone():
        return
    files = conn.execute("SELECT path, content FROM files WHERE repo_id = %s ORDER BY path", (repo_id,)).fetchall()
    chunks = [c for path, text in files for c in chunk_file(path, text, strategy="line")]
    store_chunks(conn, repo_id, chunks, "line", progress, lo=0, hi=40)


def _first_hit_rank(hits: list[Hit], q: EvalQuestion) -> int | None:
    return next((i for i, h in enumerate(hits, 1) if is_hit(h, q)), None)


def run_eval(conn, repo_id, progress: Progress = _noop) -> list[dict]:
    questions = _questions(conn, repo_id)
    if not questions:
        raise ValueError("no eval questions: generate or add some first")
    ensure_line_chunks(conn, repo_id, progress)
    results, combos = [], [(s, m) for s in STRATEGIES for m in MODES]
    for done, (strategy, mode) in enumerate(combos):
        ranks, latencies = [], []
        for q in questions:
            t0 = time.perf_counter()
            hits = retrieve(conn, repo_id, q.question, mode=mode, strategy=strategy, k=10)
            latencies.append((time.perf_counter() - t0) * 1000)
            ranks.append(_first_hit_rank(hits, q))
        row = {"mode": mode, "strategy": strategy, "n": len(questions), **metrics(ranks, latencies)}
        conn.execute(
            "INSERT INTO eval_runs (repo_id, mode, strategy, n, hit_at_5, mrr_at_10, p50_ms)"
            " VALUES (%s, %s, %s, %s, %s, %s, %s)",
            (repo_id, mode, strategy, row["n"], row["hit_at_5"], row["mrr_at_10"], row["p50_ms"]),
        )
        results.append(row)
        progress(40 + 60 * (done + 1) // len(combos), f"evaluated {strategy}/{mode}")
    return results


def suggest_threshold(conn, repo_id) -> dict:
    def top(question: str) -> float:
        hits = retrieve(conn, repo_id, question, mode="hybrid_rerank", k=1)
        return hits[0].score if hits else float("-inf")

    answerable = statistics.median(top(q.question) for q in _questions(conn, repo_id))
    off_topic = statistics.median(top(q) for q in OFF_TOPIC)
    return {"answerable_median": answerable, "off_topic_median": off_topic,
            "suggested": (answerable + off_topic) / 2}

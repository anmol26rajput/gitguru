"""Command line: gitguru index | ask | repos | eval."""
import argparse
import json
import sys
from pathlib import Path

from gitguru import config
from gitguru.ask import answer
from gitguru.db import connect
from gitguru.evals import EvalQuestion, generate_questions, replace_manual_questions, run_eval, suggest_threshold
from gitguru.index import index_source, source_key
from gitguru.ingest import IngestError


class CLIError(Exception):
    pass


def resolve_repo(conn, ref: str) -> int:
    if ref.isdigit():
        row = conn.execute("SELECT id FROM repos WHERE id = %s", (int(ref),)).fetchone()
    else:
        row = conn.execute("SELECT id FROM repos WHERE source = %s", (source_key(ref)[1],)).fetchone()
    if not row:
        raise CLIError(f"repo not indexed: {ref} (run: gitguru index {ref})")
    return row[0]


def _progress(pct: int, msg: str) -> None:
    print(f"\r[{pct:3d}%] {msg:<60}", end="", file=sys.stderr, flush=True)


def cmd_index(conn, args) -> None:
    repo_id = index_source(conn, args.source, _progress)
    print(file=sys.stderr)
    title, stats = conn.execute("SELECT title, stats FROM repos WHERE id = %s", (repo_id,)).fetchone()
    print(f"#{repo_id} {title} ready: {stats.get('files')} files, {stats.get('chunks')} chunks")


def cmd_ask(conn, args) -> None:
    sources = []
    for event in answer(conn, resolve_repo(conn, args.repo), args.question):
        if event["event"] == "sources":
            sources = event["data"]
        elif event["event"] == "token":
            print(event["data"], end="", flush=True)
        elif event["event"] == "error":
            raise CLIError(event["data"]["message"])
        else:
            print(f"\n\nSources ({event['data']['provider']}):")
            for s in sources:
                print(f"  [{s['n']}] {s['path']}:{s['start_line']}-{s['end_line']}")


def cmd_repos(conn, args) -> None:
    for rid, title, status, stats in conn.execute(
        "SELECT id, title, status, stats FROM repos ORDER BY last_used_at DESC"
    ):
        print(f"#{rid:<4} {status:<9} {title}  ({stats.get('chunks', 0)} chunks)")


def cmd_eval(conn, args) -> None:
    repo_id = resolve_repo(conn, args.repo)
    if args.questions:  # the file is the source of truth: replace earlier manual questions, never duplicate
        data = json.loads(Path(args.questions).read_text())
        replace_manual_questions(conn, repo_id, [EvalQuestion(**q) for q in data])
    if not args.no_generate:  # generate_questions is a no-op once a repo has synthetic questions
        print(f"generated {generate_questions(conn, repo_id)} synthetic questions", file=sys.stderr)
    try:
        rows = run_eval(conn, repo_id, _progress)
    except ValueError as e:
        raise CLIError(str(e)) from e
    print(file=sys.stderr)
    print(f"{'strategy':<9}{'mode':<15}{'Hit@5':>7}{'MRR@10':>8}{'p50 ms':>8}   (n={rows[0]['n']})")
    for r in rows:
        print(f"{r['strategy']:<9}{r['mode']:<15}{r['hit_at_5']:>7.2f}{r['mrr_at_10']:>8.2f}{r['p50_ms']:>8.0f}")
    if args.tune:
        t = suggest_threshold(conn, repo_id)
        print(f"\nanswerable median {t['answerable_median']:.2f} | off-topic median "
              f"{t['off_topic_median']:.2f} | suggested threshold {t['suggested']:.2f}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="gitguru", description="Talk to any codebase.")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("index", help="index a GitHub URL or local folder")
    p.add_argument("source")
    p.set_defaults(func=cmd_index)
    p = sub.add_parser("ask", help="ask a question about an indexed repo")
    p.add_argument("repo", help="repo id, GitHub URL or folder path")
    p.add_argument("question")
    p.set_defaults(func=cmd_ask)
    sub.add_parser("repos", help="list indexed repos").set_defaults(func=cmd_repos)
    p = sub.add_parser("eval", help="measure retrieval quality")
    p.add_argument("repo")
    p.add_argument("--questions", help="JSON list of {question, gold_path, gold_start, gold_end}")
    p.add_argument("--no-generate", action="store_true", help="skip LLM-generated questions")
    p.add_argument("--tune", action="store_true", help="suggest the not-found threshold")
    p.set_defaults(func=cmd_eval)
    args = parser.parse_args(argv)
    conn = connect(config.DATABASE_URL)
    try:
        args.func(conn, args)
        return 0
    except (CLIError, IngestError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())

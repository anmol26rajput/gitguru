"""Command line: gitguru index | ask | repos."""
import argparse
import sys

from gitguru import config
from gitguru.ask import answer
from gitguru.db import connect
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

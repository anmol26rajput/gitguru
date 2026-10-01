"""Database connection. Every connection applies the (idempotent) schema."""
from pathlib import Path

import psycopg
from pgvector.psycopg import register_vector

from gitguru import config

SCHEMA = (Path(__file__).parent / "schema.sql").read_text()


def connect(url: str | None = None) -> psycopg.Connection:
    conn = psycopg.connect(url or config.DATABASE_URL, autocommit=True)
    conn.execute("CREATE EXTENSION IF NOT EXISTS vector")
    register_vector(conn)
    conn.execute(SCHEMA)
    # HNSW filters after scanning; keep scanning until enough rows match the repo.
    conn.execute("SET hnsw.iterative_scan = relaxed_order")
    return conn

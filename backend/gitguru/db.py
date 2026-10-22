"""Database connections. connect() applies the (idempotent) schema; make_pool() serves the API."""
from pathlib import Path

import psycopg
from pgvector.psycopg import register_vector
from psycopg_pool import ConnectionPool

from gitguru import config

SCHEMA = (Path(__file__).parent / "schema.sql").read_text()


def configure(conn: psycopg.Connection) -> None:
    """Per-connection setup: pgvector types and HNSW scan mode."""
    register_vector(conn)
    # HNSW filters after scanning; keep scanning until enough rows match the repo.
    conn.execute("SET hnsw.iterative_scan = relaxed_order")


def connect(url: str | None = None) -> psycopg.Connection:
    conn = psycopg.connect(url or config.DATABASE_URL, autocommit=True)
    conn.execute("CREATE EXTENSION IF NOT EXISTS vector")
    conn.execute(SCHEMA)
    configure(conn)
    return conn


def make_pool(url: str | None = None) -> ConnectionPool:
    """Apply the schema once, then open a small pool of configured autocommit connections."""
    url = url or config.DATABASE_URL
    connect(url).close()
    return ConnectionPool(url, kwargs={"autocommit": True}, configure=configure,
                          check=ConnectionPool.check_connection, min_size=1, max_size=5, open=True)

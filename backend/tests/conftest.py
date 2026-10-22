import json
import os
import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from gitguru import config
from gitguru import api
from gitguru.api import app
from gitguru.db import connect

TEST_DB = os.getenv("TEST_DATABASE_URL", "postgresql://localhost:5433/gitguru_test")
FIXTURE_REPO = Path(__file__).parent / "fixtures" / "tiny_repo"


@pytest.fixture
def conn():
    c = connect(TEST_DB)
    c.execute("TRUNCATE repos, jobs RESTART IDENTITY CASCADE")
    yield c
    c.close()


@pytest.fixture(autouse=True)
def fake_llm(monkeypatch):
    """Tests never call real LLM providers."""
    monkeypatch.setattr(config, "LLM_CHAIN", ["fake"])


@pytest.fixture
def fake_github(monkeypatch):
    monkeypatch.setattr("gitguru.index.github_check", lambda key: None)
    monkeypatch.setattr("gitguru.index.remote_head", lambda key: "sha1")
    monkeypatch.setattr("gitguru.index.clone", lambda url, dest: shutil.copytree(FIXTURE_REPO, dest))


def parse_sse(text: str) -> list[dict]:
    """Parse a whole SSE body into [{event, data}]."""
    out = []
    for block in text.strip().split("\n\n"):
        name, data = block.split("\n")
        out.append({"event": name.removeprefix("event: "), "data": json.loads(data.removeprefix("data: "))})
    return out


def make_client(monkeypatch) -> TestClient:
    """TestClient on the test DB with a known token; enter it so the lifespan runs."""
    monkeypatch.setattr(config, "DATABASE_URL", TEST_DB)
    monkeypatch.setattr(config, "APP_TOKEN", "test-token")
    return TestClient(app, headers={"X-GitGuru-Token": "test-token"})


@pytest.fixture
def client(conn, monkeypatch):
    api._asked.clear()  # tests must not share the hourly question counter
    with make_client(monkeypatch) as c:
        yield c


@pytest.fixture
def ready_repo(client, fake_github):
    from tests.test_jobs_api import URL, events  # lazy: test_jobs_api imports this module
    body = client.post("/repos", json={"source": URL}).json()
    assert events(client, body["job_id"])[-1]["event"] == "done"
    return body["repo_id"]

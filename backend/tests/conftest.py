import os
from pathlib import Path

import pytest

from gitguru import config
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

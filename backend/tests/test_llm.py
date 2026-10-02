import httpx
import pytest
from openai import APIConnectionError
from pydantic import BaseModel

from gitguru import config, llm


def test_fake_provider_streams():
    name, tokens = llm.stream_chat([{"role": "user", "content": "hi"}])
    assert name == "fake"
    assert "".join(tokens) == "Fake answer citing [1]."


def _conn_error():
    return APIConnectionError(request=httpx.Request("POST", "http://test"))


def test_falls_back_before_first_token(monkeypatch):
    monkeypatch.setattr(config, "LLM_CHAIN", ["groq", "gemini"])
    monkeypatch.setattr(config, "GROQ_API_KEY", "k")
    monkeypatch.setattr(config, "GEMINI_API_KEY", "k")
    monkeypatch.setattr(llm.time, "sleep", lambda s: None)

    def fake_open(name, messages):
        if name == "groq":
            raise _conn_error()
        return iter(["from ", "gemini"])

    monkeypatch.setattr(llm, "_open_stream", fake_open)
    name, tokens = llm.stream_chat([])
    assert name == "gemini" and "".join(tokens) == "from gemini"


def test_skips_unconfigured_providers(monkeypatch):
    monkeypatch.setattr(config, "LLM_CHAIN", ["groq", "gemini"])
    monkeypatch.setattr(config, "GROQ_API_KEY", "")
    monkeypatch.setattr(config, "GEMINI_API_KEY", "k")
    monkeypatch.setattr(llm, "_open_stream", lambda name, m: iter([name]))
    assert llm.stream_chat([])[0] == "gemini"


def test_all_providers_failing_raises(monkeypatch):
    monkeypatch.setattr(config, "LLM_CHAIN", ["groq"])
    monkeypatch.setattr(config, "GROQ_API_KEY", "k")
    monkeypatch.setattr(llm.time, "sleep", lambda s: None)

    def boom(name, messages):
        raise _conn_error()

    monkeypatch.setattr(llm, "_open_stream", boom)
    with pytest.raises(llm.LLMError, match="busy"):
        llm.stream_chat([])


def test_mid_stream_failure_is_not_retried(monkeypatch):
    monkeypatch.setattr(config, "LLM_CHAIN", ["groq", "gemini"])
    monkeypatch.setattr(config, "GROQ_API_KEY", "k")
    monkeypatch.setattr(config, "GEMINI_API_KEY", "k")
    opened = []

    def half_stream(name, messages):
        opened.append(name)
        yield "partial "
        raise _conn_error()

    monkeypatch.setattr(llm, "_open_stream", half_stream)
    name, tokens = llm.stream_chat([])
    assert next(tokens) == "partial "
    with pytest.raises(APIConnectionError):
        next(tokens)
    assert opened == ["groq"]


class Step(BaseModel):
    question: str


def test_complete_json_retries_once(monkeypatch):
    replies = iter(["not json", '```json\n{"question": "ok?"}\n```'])
    monkeypatch.setattr(llm, "complete", lambda messages: next(replies))
    assert llm.complete_json([], Step).question == "ok?"

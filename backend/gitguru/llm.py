"""One OpenAI-compatible client for every provider, with a fallback chain."""
import re
import time
from collections.abc import Iterator
from itertools import chain

from openai import APIConnectionError, APIStatusError, APITimeoutError, OpenAI
from pydantic import BaseModel, ValidationError

from gitguru import config

BASE_URLS = {
    "groq": "https://api.groq.com/openai/v1",
    "gemini": "https://generativelanguage.googleapis.com/v1beta/openai/",
    "ollama": "http://localhost:11434/v1",
}


class LLMError(Exception):
    pass


def _settings(name: str) -> tuple[str, str] | None:
    """(api_key, model) for a provider, or None when it isn't configured."""
    if name == "groq" and config.GROQ_API_KEY:
        return config.GROQ_API_KEY, config.GROQ_MODEL
    if name == "gemini" and config.GEMINI_API_KEY:
        return config.GEMINI_API_KEY, config.GEMINI_MODEL
    if name == "ollama":
        return "ollama", config.OLLAMA_MODEL
    return None


def _open_stream(name: str, messages: list[dict]) -> Iterator[str]:
    key, model = _settings(name)
    client = OpenAI(base_url=BASE_URLS[name], api_key=key, timeout=30, max_retries=0)
    stream = client.chat.completions.create(model=model, messages=messages, stream=True, temperature=0.1)
    return (ev.choices[0].delta.content for ev in stream if ev.choices and ev.choices[0].delta.content)


def _fake_stream() -> Iterator[str]:
    yield from ["Fake answer ", "citing [1]."]


def stream_chat(messages: list[dict]) -> tuple[str, Iterator[str]]:
    errors = []
    for name in config.LLM_CHAIN:
        if name == "fake":
            return "fake", _fake_stream()
        if _settings(name) is None:
            continue
        for attempt in range(2):
            try:
                tokens = iter(_open_stream(name, messages))
                first = next(tokens, "")  # fail over only before any token reaches the user
                return name, chain([first], tokens)
            except (APIConnectionError, APITimeoutError, APIStatusError) as e:
                errors.append(f"{name}: {type(e).__name__}")
                status = getattr(e, "status_code", None) or 500
                if status < 500 and status != 429:
                    break  # bad request/auth: retrying the same provider won't help
                if attempt == 0:
                    time.sleep(2)
    raise LLMError("AI providers are busy, try again in a minute (" + "; ".join(errors) + ")")


def complete(messages: list[dict]) -> str:
    return "".join(stream_chat(messages)[1])


def _json_text(reply: str) -> str:
    m = re.search(r"\{.*\}", reply, re.S)
    return m.group(0) if m else reply


def complete_json(messages: list[dict], schema: type[BaseModel]) -> BaseModel:
    reply = complete(messages)
    try:
        return schema.model_validate_json(_json_text(reply))
    except ValidationError as e:
        retry = messages + [
            {"role": "assistant", "content": reply},
            {"role": "user", "content": f"That was not valid JSON for the schema: {e}. Reply with only the JSON."},
        ]
        return schema.model_validate_json(_json_text(complete(retry)))

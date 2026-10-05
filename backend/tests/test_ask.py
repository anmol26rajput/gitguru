from gitguru import ask, llm
from gitguru.ask import answer, build_messages, parse_citations
from gitguru.index import index_source
from gitguru.search import Hit
from tests.conftest import FIXTURE_REPO


def test_parse_citations_keeps_valid_unique_sorted():
    assert parse_citations("See [2] and [1], also [2] and [9] [0]", 6) == [1, 2]


def test_fancy_citations_become_plain_even_when_split_across_tokens():
    tokens = ["Uses Retry【5", "†L684-L7", "43】 and 【2†L1】.", " Unclosed 【"]
    assert "".join(ask._plain_citations(tokens)) == "Uses Retry[5] and [2]. Unclosed 【"


def test_build_messages_numbers_sources_and_keeps_last_three_turns():
    hit = Hit(1, "auth.py", 8, 10, "hash_password", "def hash_password(): ...", 0.9)
    history = [{"role": "user", "content": f"q{i}"} for i in range(10)]
    msgs = build_messages("tiny", [hit], "How?", history)
    assert msgs[0]["role"] == "system" and "tiny" in msgs[0]["content"]
    assert msgs[1:-1] == history[-6:]
    assert "[1] auth.py:8-10 (hash_password)" in msgs[-1]["content"]
    assert msgs[-1]["content"].rstrip().endswith("How?")


def test_answer_streams_sources_tokens_done(conn):
    repo_id = index_source(conn, str(FIXTURE_REPO))
    events = list(answer(conn, repo_id, "How are passwords hashed?"))
    kinds = [e["event"] for e in events]
    assert kinds[0] == "sources" and kinds[-1] == "done" and "token" in kinds
    assert events[0]["data"][0]["path"] == "auth.py"
    assert len(events[0]["data"]) <= ask.MAX_SOURCES
    assert events[-1]["data"] == {"provider": "fake", "cited": [1]}


def test_follow_up_uses_previous_question(conn, monkeypatch):
    repo_id = index_source(conn, str(FIXTURE_REPO))
    seen = {}

    def spy(conn_, rid, query, **kw):
        seen["query"] = query
        return []

    monkeypatch.setattr(ask, "retrieve", spy)
    list(answer(conn, repo_id, "and its tests?", [{"role": "user", "content": "How does retry work?"},
                                                  {"role": "assistant", "content": "..."}]))
    assert seen["query"] == "and its tests? How does retry work?"


def test_no_hits_answers_not_found_without_llm(conn, monkeypatch):
    repo_id = index_source(conn, str(FIXTURE_REPO))
    monkeypatch.setattr(ask, "retrieve", lambda *a, **k: [])
    monkeypatch.setattr(ask, "stream_chat", lambda m: (_ for _ in ()).throw(AssertionError("LLM called")))
    events = list(answer(conn, repo_id, "anything"))
    assert events[1] == {"event": "token", "data": ask.NOT_FOUND}
    assert events[-1]["data"]["provider"] is None


def test_llm_failure_becomes_error_event(conn, monkeypatch):
    repo_id = index_source(conn, str(FIXTURE_REPO))

    def broken(messages):
        def gen():
            yield "partial "
            raise RuntimeError("connection dropped")
        return "groq", gen()

    monkeypatch.setattr(ask, "stream_chat", broken)
    events = list(answer(conn, repo_id, "How are passwords hashed?"))
    assert [e["event"] for e in events] == ["sources", "token", "error"]
    assert "connection dropped" in events[-1]["data"]["message"]


def test_all_providers_busy_becomes_error_event(conn, monkeypatch):
    repo_id = index_source(conn, str(FIXTURE_REPO))
    monkeypatch.setattr(ask, "stream_chat", lambda m: (_ for _ in ()).throw(llm.LLMError("AI providers are busy")))
    events = list(answer(conn, repo_id, "How are passwords hashed?"))
    assert events[-1] == {"event": "error", "data": {"message": "AI providers are busy"}}

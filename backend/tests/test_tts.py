import pytest

from gitguru import tts

H = {"X-GitGuru-Token": "test-token"}


@pytest.fixture(autouse=True)
def fresh_cache():
    tts._synth.cache_clear()
    yield
    tts._synth.cache_clear()


def test_tts_returns_mpeg_bytes(client, monkeypatch):
    seen = []
    monkeypatch.setattr(tts, "_fetch", lambda text, voice: seen.append((text, voice)) or b"ID3audio")
    r = client.post("/tts", json={"text": "Hello there."}, headers=H)
    assert r.status_code == 200 and r.headers["content-type"] == "audio/mpeg" and r.content == b"ID3audio"
    assert seen == [("Hello there.", "en-US-AvaNeural")]


def test_tts_failure_is_503_and_not_cached(client, monkeypatch, caplog):
    calls = []

    def flaky(text, voice):
        calls.append(1)
        if len(calls) == 1:
            raise tts.TTSError("no audio")
        return b"ok"
    monkeypatch.setattr(tts, "_fetch", flaky)
    r = client.post("/tts", json={"text": "Hi"}, headers=H)
    assert r.status_code == 503 and r.json()["detail"] == "voice service unavailable"
    assert "tts failed: no audio" in caplog.text  # the cause is logged, not swallowed
    assert client.post("/tts", json={"text": "Hi"}, headers=H).content == b"ok" and len(calls) == 2


def test_tts_text_length_validated(client, monkeypatch):
    monkeypatch.setattr(tts, "_fetch", lambda t, v: b"x")
    assert client.post("/tts", json={"text": "a" * 1501}, headers=H).status_code == 422
    assert client.post("/tts", json={"text": ""}, headers=H).status_code == 422
    assert client.post("/tts", json={"text": "a" * 1500}, headers=H).status_code == 200


def test_tts_requires_token(client):
    assert client.post("/tts", json={"text": "Hi"}, headers={"X-GitGuru-Token": ""}).status_code == 401


def test_tts_cache_skips_second_fetch(client, monkeypatch):
    calls = []
    monkeypatch.setattr(tts, "_fetch", lambda t, v: calls.append(1) or b"mp3")
    for _ in range(2):
        assert client.post("/tts", json={"text": "Same"}, headers=H).content == b"mp3"
    assert len(calls) == 1
    client.post("/tts", json={"text": "Other"}, headers=H)
    assert len(calls) == 2


def test_fetch_empty_audio_and_errors_raise_ttserror(monkeypatch):
    class Empty:
        def __init__(self, *a, **k): pass
        async def stream(self):
            yield {"type": "WordBoundary"}

    class Boom(Empty):
        async def stream(self):
            raise RuntimeError("refused")
            yield

    class Hang(Empty):
        async def stream(self):
            import asyncio
            await asyncio.sleep(5)
            yield {"type": "audio", "data": b"x"}

    class Good(Empty):
        async def stream(self):
            yield {"type": "audio", "data": b"ab"}
            yield {"type": "WordBoundary"}
            yield {"type": "audio", "data": b"cd"}

    for cls in (Empty, Boom):
        monkeypatch.setattr(tts.edge_tts, "Communicate", cls)
        with pytest.raises(tts.TTSError):
            tts._fetch("hi", "v")
    monkeypatch.setattr(tts, "TIMEOUT_S", 0.05)
    monkeypatch.setattr(tts.edge_tts, "Communicate", Hang)
    with pytest.raises(tts.TTSError):
        tts._fetch("hi", "v")
    monkeypatch.setattr(tts.edge_tts, "Communicate", Good)
    assert tts._fetch("hi", "v") == b"abcd"

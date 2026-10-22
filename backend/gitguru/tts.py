"""Natural voice: Microsoft's free neural voices via the unofficial edge-tts package (D46)."""
import asyncio
from functools import lru_cache

import edge_tts

TIMEOUT_S = 15


class TTSError(Exception):
    pass


async def _collect(text: str, voice: str) -> bytes:
    return b"".join([c["data"] async for c in edge_tts.Communicate(text, voice).stream() if c["type"] == "audio"])


def _fetch(text: str, voice: str) -> bytes:
    """One network call. Any failure (no audio, refused voice, timeout) becomes TTSError."""
    try:
        audio = asyncio.run(asyncio.wait_for(_collect(text, voice), TIMEOUT_S))
    except Exception as e:
        raise TTSError(f"{type(e).__name__}: {e}") from e
    if not audio:
        raise TTSError("no audio")
    return audio


@lru_cache(maxsize=64)  # exceptions are never cached, only successful audio
def _synth(text: str, voice: str) -> bytes:
    return _fetch(text, voice)


def synthesize(text: str, voice: str) -> bytes:
    return _synth(text, voice)

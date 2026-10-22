"""Local CPU models: code embeddings and a cross-encoder reranker (fastembed/ONNX)."""
from functools import cache

import numpy as np

from gitguru import config


@cache
def _embedder():
    from fastembed import TextEmbedding
    return TextEmbedding(model_name=config.EMBED_MODEL)


@cache
def _reranker():
    from fastembed.rerank.cross_encoder import TextCrossEncoder
    return TextCrossEncoder(model_name=config.RERANK_MODEL)


def embed_texts(texts: list[str]) -> list[np.ndarray]:
    # Batches pad to the longest chunk; 32 x 4000-char chunks peaked at 11.9 GB and froze the Mac.
    # batch_size=2 peaks at 3.4 GB and is faster (no swap). See DECISIONS D40.
    return list(_embedder().embed(texts, batch_size=2))


def embed_query(text: str) -> np.ndarray:
    return embed_texts([text])[0]


def rerank(query: str, docs: list[str]) -> list[float]:
    return [float(s) for s in _reranker().rerank(query, docs)]

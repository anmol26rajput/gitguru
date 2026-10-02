import numpy as np

from gitguru.embed import embed_query, embed_texts, rerank


def cos(a, b):
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))


def test_embedding_dimensions():
    vecs = embed_texts(["def add(a, b): return a + b"])
    assert len(vecs) == 1 and vecs[0].shape == (768,)


def test_similar_meaning_scores_higher():
    q = embed_query("hash a password")
    code_hash = embed_texts(["def hash_password(p): return sha256(SALT + p).hexdigest()"])[0]
    code_slug = embed_texts(["def slugify(t): return t.lower().replace(' ', '-')"])[0]
    assert cos(q, code_hash) > cos(q, code_slug)


def test_rerank_prefers_relevant_doc():
    scores = rerank("how are passwords hashed?", [
        "def slugify(t): return t.lower().replace(' ', '-')",
        "def hash_password(p): return sha256(SALT + p).hexdigest()",
    ])
    assert len(scores) == 2 and scores[1] > scores[0]

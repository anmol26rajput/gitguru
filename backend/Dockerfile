# GitGuru API for Hugging Face Docker Spaces (also used by docker-compose and CI).
# Layer order: OS packages, deps, models, grammars, then code, so a code edit rebuilds only the last layers.
FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Keep the uv version in sync with CI (astral-sh/setup-uv).
COPY --from=ghcr.io/astral-sh/uv:0.12.21 /uv /usr/local/bin/uv

# HF Spaces runs the container as uid 1000, so build and run as that user.
RUN useradd -m -u 1000 user && mkdir /app && chown user:user /app
USER user
ENV HOME=/home/user \
    PATH=/app/.venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_NO_CACHE=1 \
    UV_PYTHON_DOWNLOADS=never \
    FASTEMBED_CACHE_PATH=/app/models \
    TREE_SITTER_LANGUAGE_PACK_CACHE_DIR=/app/grammars \
    EMBED_MODEL=jinaai/jina-embeddings-v2-base-code \
    RERANK_MODEL=Xenova/ms-marco-MiniLM-L-6-v2
WORKDIR /app

# 1. Dependencies (cached until pyproject.toml or uv.lock change).
COPY --chown=user pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

# 2. Models, baked in so startup needs no download (EMBED_MODEL/RERANK_MODEL must match config.py).
RUN python -c "import os; \
from fastembed import TextEmbedding; \
from fastembed.rerank.cross_encoder import TextCrossEncoder; \
TextEmbedding(os.environ['EMBED_MODEL']); \
TextCrossEncoder(os.environ['RERANK_MODEL'])"

# 3. Tree-sitter grammars are downloaded on first use, not bundled in the wheel.
# Warm chunk.AST_LANGS (diagram.py's languages are a subset).
RUN python -c "from tree_sitter_language_pack import prefetch; \
prefetch(['python','javascript','typescript','tsx','go','java','rust','c','cpp','ruby','php'])"

# 4. The app. pyproject.toml's readme needs README.md at install time.
COPY --chown=user README.md ./
COPY --chown=user gitguru ./gitguru
RUN uv sync --frozen --no-dev

EXPOSE 7860
CMD ["uvicorn", "gitguru.api:app", "--host", "0.0.0.0", "--port", "7860", "--workers", "1", "--proxy-headers", "--forwarded-allow-ips", "*"]

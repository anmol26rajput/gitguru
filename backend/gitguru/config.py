"""All settings, read once from the environment (and gitguru/.env if present)."""
import os

from dotenv import load_dotenv

load_dotenv()


def _list(name: str, default: str) -> list[str]:
    return [p.strip() for p in os.getenv(name, default).split(",") if p.strip()]


DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://localhost:5433/gitguru")
APP_TOKEN = os.getenv("APP_TOKEN", "")
CORS_ORIGINS = _list("CORS_ORIGINS", "http://localhost:3000")
LLM_CHAIN = _list("LLM_CHAIN", "groq,gemini,ollama")
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
GROQ_MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "qwen2.5-coder:3b")
EMBED_MODEL = os.getenv("EMBED_MODEL", "jinaai/jina-embeddings-v2-base-code")
RERANK_MODEL = os.getenv("RERANK_MODEL", "Xenova/ms-marco-MiniLM-L-6-v2")
GITHUB_TOKEN = os.getenv("GITHUB_TOKEN", "")

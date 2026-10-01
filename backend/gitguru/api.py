"""HTTP API. M0: health only; routes are added in M3."""
from fastapi import FastAPI

app = FastAPI(title="GitGuru")


@app.get("/health")
def health() -> dict:
    return {"ok": True}

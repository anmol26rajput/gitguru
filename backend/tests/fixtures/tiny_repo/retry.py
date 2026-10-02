import random
import time


def compute_backoff_delay(attempt: int, base: float = 0.5, cap: float = 30.0) -> float:
    """Exponential backoff with jitter: base * 2**attempt, capped."""
    delay = min(cap, base * (2 ** attempt))
    return delay * random.uniform(0.5, 1.0)


def retry_with_backoff(func, retries: int = 3):
    """Call func, retrying failed calls with exponential backoff."""
    for attempt in range(retries + 1):
        try:
            return func()
        except ConnectionError:
            if attempt == retries:
                raise
            time.sleep(compute_backoff_delay(attempt))

"""Authentication helpers."""
import hashlib
import hmac

SALT = b"gitguru-demo"


def hash_password(password: str) -> str:
    """Hash a password with a fixed salt (demo only)."""
    return hashlib.sha256(SALT + password.encode()).hexdigest()


def verify_login(username: str, password: str, users: dict) -> bool:
    """Return True when the user exists and the password matches."""
    stored = users.get(username)
    if stored is None:
        return False
    return hmac.compare_digest(stored, hash_password(password))


class SessionStore:
    """Keeps logged-in sessions in memory."""

    def __init__(self):
        self.sessions = {}

    def create(self, username: str) -> str:
        token = hashlib.sha1(username.encode()).hexdigest()
        self.sessions[token] = username
        return token

    def revoke(self, token: str) -> None:
        self.sessions.pop(token, None)

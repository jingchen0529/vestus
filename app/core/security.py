"""Password hashing, signed access tokens and proxy-credential encryption.

The signing key and the proxy encryption key both come from
:mod:`app.core.config`.  There is no in-process random fallback: a deployment
without ``VESTUS_SECRET_KEY`` is refused at startup by
``validate_startup_settings()`` rather than silently signing tokens with a key
that dies with the worker.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import secrets
import time
from typing import Any, Dict, Optional, Tuple

from cryptography.fernet import Fernet, InvalidToken

from app.core.config import ConfigurationError, get_settings

try:  # Argon2id is the production implementation.
    from argon2 import PasswordHasher
    from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

    # ``Any`` because the fallback below rebinds this to ``None`` when argon2-cffi
    # is missing, and the fallback branch has no ``PasswordHasher`` to name.
    _ARGON2: Any = PasswordHasher()
except ImportError:  # pragma: no cover - local dependency-free test fallback
    _ARGON2 = None
    InvalidHashError = VerificationError = VerifyMismatchError = Exception  # type: ignore[misc,assignment]


PASSWORD_ALGORITHM = "pbkdf2_sha256"
PASSWORD_ITERATIONS = 310_000
TOKEN_VERSION = 1


def _encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))

def hash_password(password: str) -> str:
    """Hash a password with Argon2id; PBKDF2 is only a test fallback."""
    if not isinstance(password, str) or not password:
        raise ValueError("password must not be empty")
    if _ARGON2 is not None:
        return _ARGON2.hash(password)
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PASSWORD_ITERATIONS)
    return f"{PASSWORD_ALGORITHM}${PASSWORD_ITERATIONS}${_encode(salt)}${_encode(digest)}"


def verify_password(password: str, encoded: str) -> bool:
    if not isinstance(password, str) or not isinstance(encoded, str):
        return False
    if encoded.startswith("$argon2") and _ARGON2 is not None:
        try:
            return bool(_ARGON2.verify(encoded, password))
        except (InvalidHashError, VerificationError, VerifyMismatchError, ValueError):
            return False
    try:
        algorithm, iterations, salt, expected = encoded.split("$", 3)
        if algorithm != PASSWORD_ALGORITHM:
            return False
        actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), _decode(salt), int(iterations))
        return hmac.compare_digest(actual, _decode(expected))
    except (TypeError, ValueError, binascii.Error):
        return False


def password_needs_rehash(encoded: str) -> bool:
    if encoded.startswith("$argon2"):
        return _ARGON2 is not None and _ARGON2.check_needs_rehash(encoded)
    return True

def _secret() -> bytes:
    value = get_settings().token_signing_secret
    if not value:
        raise ConfigurationError(
            "VESTUS_SECRET_KEY 未配置，无法签发或校验访问令牌；请在 .env 中设置稳定密钥"
        )
    return value.encode("utf-8")


def _proxy_fernet() -> Fernet:
    """Build the stable-at-runtime key used for proxy credential storage.

    Fernet requires a 32-byte urlsafe-base64 key.  Deployment secrets are
    deliberately hashed first so operators may use the same arbitrary-length
    secret format as access-token signing.  ``VESTUS_PROXY_SECRET_KEY`` lets a
    deployment rotate/isolate proxy encryption independently; otherwise the
    existing application secret is used.
    """
    value = get_settings().proxy_encryption_secret
    if not value:
        raise ConfigurationError(
            "VESTUS_PROXY_SECRET_KEY / VESTUS_SECRET_KEY 均未配置，无法加解密代理密码"
        )
    key = base64.urlsafe_b64encode(hashlib.sha256(value.encode("utf-8")).digest())
    return Fernet(key)


def encrypt_proxy_password(password: str) -> bytes:
    """Encrypt a proxy password for database storage."""
    if not isinstance(password, str):
        raise ValueError("proxy password must be a string")
    return _proxy_fernet().encrypt(password.encode("utf-8"))


def decrypt_proxy_password(ciphertext: bytes | str) -> str:
    """Decrypt a stored proxy password, rejecting malformed/wrong-key data."""
    raw = ciphertext.encode("ascii") if isinstance(ciphertext, str) else ciphertext
    try:
        return _proxy_fernet().decrypt(raw).decode("utf-8")
    except (InvalidToken, UnicodeDecodeError, ValueError, TypeError) as exc:
        raise ValueError("proxy password cannot be decrypted") from exc

def create_access_token(
    account_type: str,
    account_id: int | str,
    token_version: int = 1,
    ttl_seconds: int = 900,
    *,
    now: Optional[int] = None,
) -> Tuple[str, int]:
    """Create a compact HMAC-SHA256 signed token (no extra session table)."""
    if account_type not in {"admin", "user"}:
        raise ValueError("account_type must be admin or user")
    issued = int(time.time() if now is None else now)
    expires = issued + max(int(ttl_seconds), 1)
    payload = {
        "v": TOKEN_VERSION,
        "typ": account_type,
        "sub": str(account_id),
        "tv": int(token_version),
        "iat": issued,
        "exp": expires,
        "jti": secrets.token_urlsafe(12),
    }
    body = _encode(json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
    signature = _encode(hmac.new(_secret(), body.encode("ascii"), hashlib.sha256).digest())
    return f"{body}.{signature}", expires

def decode_access_token(token: str, *, now: Optional[int] = None) -> Dict[str, Any]:
    """Validate a token and return claims, raising ``ValueError`` if invalid."""
    if not isinstance(token, str):
        raise ValueError("invalid token")
    secret = _secret()
    try:
        body, encoded_signature = token.split(".", 1)
        expected = hmac.new(secret, body.encode("ascii"), hashlib.sha256).digest()
        if not hmac.compare_digest(expected, _decode(encoded_signature)):
            raise ValueError("invalid token signature")
        payload = json.loads(_decode(body).decode("utf-8"))
    except (ValueError, TypeError, UnicodeDecodeError, json.JSONDecodeError, binascii.Error) as exc:
        raise ValueError("invalid token") from exc
    if not isinstance(payload, dict) or payload.get("v") != TOKEN_VERSION:
        raise ValueError("invalid token version")
    if payload.get("typ") not in {"admin", "user"} or not payload.get("sub"):
        raise ValueError("invalid token subject")
    try:
        now_value = int(time.time() if now is None else now)
        if int(payload["exp"]) <= now_value:
            raise ValueError("token expired")
        payload["tv"] = int(payload["tv"])
        payload["iat"] = int(payload["iat"])
        payload["exp"] = int(payload["exp"])
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError("invalid token claims") from exc
    return payload


# Compatibility helpers retained for early consumers.  New code uses the
# account-scoped access-token functions above.
def create_token() -> Tuple[str, str]:
    raw, _ = create_access_token("user", secrets.token_urlsafe(8), 1, 900)
    return raw, token_digest(raw)


def token_digest(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()

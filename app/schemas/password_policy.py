"""Visible-ASCII password policy for desktop-user credential writes.

Login and current-password verification retain their existing behavior so
historical credentials can be verified without silently changing them.
"""

from __future__ import annotations

PASSWORD_CHARSET_MESSAGE = "密码只能包含可见 ASCII 字符（不含中文、空格或全角符号）"


def validate_password_charset(password: str) -> str:
    """Reject anything the desktop client's password field cannot contain."""
    if password and any(not "\x21" <= char <= "\x7e" for char in password):
        raise ValueError(PASSWORD_CHARSET_MESSAGE)
    return password


__all__ = ["PASSWORD_CHARSET_MESSAGE", "validate_password_charset"]

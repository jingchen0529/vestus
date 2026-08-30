"""Domain failures raised by the service layer.

Services never import FastAPI.  They raise one of these instead, and a single
handler in :mod:`app.main` turns it into ``{"detail": ...}`` with the
``status_code`` declared here -- the exact response the previous inline
``HTTPException`` produced.  The status codes are part of the published HTTP
contract: the web and desktop clients branch on them.

``BadRequestError`` also subclasses :class:`ValueError` because the pre-refactor
database layer signalled invalid input that way, and callers (including the
test suite) still catch ``ValueError``.
"""

from __future__ import annotations


class ServiceError(Exception):
    """Base class for every expected, client-visible service failure."""

    status_code = 400

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


class BadRequestError(ServiceError, ValueError):
    """Invalid input that validation could not reject on its own."""

    status_code = 400


class LastSuperAdminError(BadRequestError):
    """The last active super administrator may not be removed or demoted."""

    status_code = 400


class AuthenticationError(ServiceError):
    """Credentials were rejected.  Deliberately carries no hint about why."""

    status_code = 401


class AccountUnavailableError(ServiceError):
    """The account exists and the password matched, but it may not be used."""

    status_code = 403


class NotFoundError(ServiceError):
    status_code = 404


class ConflictError(ServiceError):
    """A uniqueness constraint rejected the write."""

    status_code = 409


__all__ = [
    "AccountUnavailableError",
    "AuthenticationError",
    "BadRequestError",
    "ConflictError",
    "LastSuperAdminError",
    "NotFoundError",
    "ServiceError",
]

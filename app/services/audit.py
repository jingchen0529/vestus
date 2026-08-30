"""Audit-log writing.

Two shapes, and the difference matters:

``record`` joins the caller's transaction.  Every mutation writes its audit row
through it, so a committed change can no longer end up unlogged -- the previous
implementation opened a second transaction and swallowed
:class:`~sqlalchemy.exc.SQLAlchemyError`, which turned a failed audit write into
silence.  The row is added **last** so the statement order of the business write
itself is unchanged.

``record_standalone`` is for events with no business transaction to join: read
accesses and rejected logins.  It still must not fail the request, but a lost
row is now reported through ``logging`` instead of being discarded.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, replace
from typing import Any, Dict, Optional

from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.db.session import Database
from app.repositories import logs as logs_repo

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class AuditContext:
    """Who did it and from where, captured once per request."""

    actor_type: str = "system"
    actor_id: Optional[int] = None
    actor_username: Optional[str] = None
    actor_role: Optional[str] = None
    ip: Optional[str] = None
    user_agent: Optional[str] = None
    request_id: Optional[str] = None

    def for_account(self, account_type: str, model: Any) -> "AuditContext":
        """Attach an actor that was only identified mid-request (login)."""

        return replace(
            self,
            actor_type=account_type,
            actor_id=getattr(model, "id", None),
            actor_username=getattr(model, "username", None),
            actor_role=getattr(model, "role", None),
        )


def record(
    session: Session,
    audit: Optional[AuditContext],
    action: str,
    summary: str,
    *,
    status: str = "SUCCESS",
    target_type: Optional[str] = None,
    target_id: Optional[int] = None,
    target_name: Optional[str] = None,
    details: Optional[Dict[str, Any]] = None,
) -> None:
    """Add the audit row to ``session``; a missing context writes nothing.

    ``audit`` is ``None`` when a service is driven directly (tests, scripts)
    rather than by a request, which has no actor to attribute the change to.
    """

    if audit is None:
        return
    logs_repo.create(
        session,
        actor_type=audit.actor_type,
        actor_id=audit.actor_id,
        actor_username=audit.actor_username,
        actor_role=audit.actor_role,
        action=action,
        summary=summary,
        ip=audit.ip,
        user_agent=audit.user_agent,
        status=status,
        target_type=target_type,
        target_id=target_id,
        target_name=target_name,
        details=details,
        request_id=audit.request_id,
    )


def record_standalone(
    database: Database,
    audit: Optional[AuditContext],
    action: str,
    summary: str,
    *,
    status: str = "SUCCESS",
    target_type: Optional[str] = None,
    target_id: Optional[int] = None,
    target_name: Optional[str] = None,
    details: Optional[Dict[str, Any]] = None,
) -> None:
    """Write an audit row in its own transaction, never failing the request."""

    if audit is None:
        return
    try:
        with database.session() as session:
            record(
                session,
                audit,
                action,
                summary,
                status=status,
                target_type=target_type,
                target_id=target_id,
                target_name=target_name,
                details=details,
            )
    except SQLAlchemyError:
        # The request itself succeeded, so it must not fail now -- but the lost
        # audit row has to be visible somewhere.
        logger.error(
            "审计日志写入失败：action=%s status=%s actor=%s/%s request_id=%s",
            action,
            status,
            audit.actor_type,
            audit.actor_id,
            audit.request_id,
            exc_info=True,
        )


__all__ = ["AuditContext", "record", "record_standalone"]

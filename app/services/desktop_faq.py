"""Desktop FAQ document: admin editing and the client-facing assembly.

The document is two flat tables (groups, items).  Saving replaces every row in
one transaction -- the editor is a draft-then-publish flow, so half-saved
documents must never reach a client.  Rows carry a ``status`` so an operator
can park one bad answer without deleting it; the client payload only ever
contains ``active`` rows.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from app.db.base import iso_datetime
from app.db.models import DesktopFaqGroup, DesktopFaqItem
from app.db.models.desktop_faq import STATUS_ACTIVE
from app.db.session import Database
from app.repositories import desktop_faq as desktop_faq_repo
from app.services.audit import AuditContext, record

EMPTY_DOCUMENT = {"faq": None, "updatedAt": None}


def _item_dict(item: DesktopFaqItem) -> Dict[str, Any]:
    return {
        "id": item.id,
        "question": item.question,
        "answer": item.answer,
        "status": item.status,
    }


def _group_dict(group: DesktopFaqGroup, items: List[DesktopFaqItem]) -> Dict[str, Any]:
    return {
        "id": group.id,
        "title": group.title,
        "status": group.status,
        "items": [_item_dict(item) for item in items],
    }


def _assemble(
    groups: List[DesktopFaqGroup],
    items: List[DesktopFaqItem],
    *,
    only_active: bool,
) -> Optional[List[Dict[str, Any]]]:
    """Group items under their group, in display order.

    ``only_active`` (the desktop payload) drops disabled rows and then groups
    left without a single active item -- an all-disabled document reads as
    "not configured" to the client.
    """

    if only_active:
        items = [item for item in items if item.status == STATUS_ACTIVE]
    by_group: Dict[int, List[DesktopFaqItem]] = {}
    for item in items:
        by_group.setdefault(item.group_id, []).append(item)
    document: List[Dict[str, Any]] = []
    for group in groups:
        if only_active and group.status != STATUS_ACTIVE:
            continue
        group_items = by_group.get(group.id, [])
        if only_active and not group_items:
            continue
        document.append(_group_dict(group, group_items))
    # 保存接口要求至少一个分组，所以空文档只可能来自「一张行都没有」——
    # 也就是未自定义，管理端与客户端统一读作 null。
    if not document:
        return None
    return document


def _latest_update_at(groups: List[DesktopFaqGroup], items: List[DesktopFaqItem]) -> Optional[str]:
    stamps = [group.updated_at for group in groups] + [item.updated_at for item in items]
    return iso_datetime(max(stamps)) if stamps else None


def get_admin_document(database: Database) -> Dict[str, Any]:
    """Everything, including parked rows -- the editor needs the full picture."""

    with database.session() as session:
        groups, items = desktop_faq_repo.load_all(session)
        document = _assemble(groups, items, only_active=False)
        return {
            "faq": document,
            "updatedAt": _latest_update_at(groups, items) if document else None,
        }


def get_user_document(database: Database) -> Dict[str, Any]:
    """The client payload: active rows only, ``None`` when effectively empty."""

    with database.session() as session:
        groups, items = desktop_faq_repo.load_all(session)
        return {"faq": _assemble(groups, items, only_active=True)}


def save_document(
    database: Database,
    groups: List[Dict[str, Any]],
    *,
    audit: Optional[AuditContext] = None,
) -> Dict[str, Any]:
    """Replace the whole document and return the saved admin view."""

    with database.session() as session:
        desktop_faq_repo.replace_all(session, groups)
        saved_groups, saved_items = desktop_faq_repo.load_all(session)
        document = _assemble(saved_groups, saved_items, only_active=False)
        record(
            session,
            audit,
            "DESKTOP_FAQ_UPDATED",
            f"更新客户端帮助内容：{len(groups)} 组 / {len(saved_items)} 条",
            target_type="desktop_faq",
            target_name="客户端帮助内容",
        )
        return {"faq": document, "updatedAt": _latest_update_at(saved_groups, saved_items)}


def clear_document(database: Database, *, audit: Optional[AuditContext] = None) -> Dict[str, Any]:
    """Reset to "not configured"; clients fall back to their bundled baseline."""

    with database.session() as session:
        desktop_faq_repo.clear(session)
        record(
            session,
            audit,
            "DESKTOP_FAQ_RESET",
            "恢复默认客户端帮助内容（清空自定义 Q&A）",
            target_type="desktop_faq",
            target_name="客户端帮助内容",
        )
        return dict(EMPTY_DOCUMENT)


__all__ = [
    "clear_document",
    "get_admin_document",
    "get_user_document",
    "save_document",
]

"""Advertiser index and scoped queries over recorded pages, not current credentials."""
from __future__ import annotations

from typing import Any, Optional, Sequence

from sqlalchemy import Select, String, bindparam, case, cast, func, or_, select, tuple_
from sqlalchemy.dialects.mysql import insert as mysql_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session
from sqlalchemy.sql import visitors
from sqlalchemy.sql.elements import BindParameter

from app.db.base import parse_datetime
from app.db.models import BrowserPageAdvertiser, BrowserPageVisit, BrowserSession

A = BrowserPageAdvertiser
P = BrowserPageVisit
S = BrowserSession


def ensure_index(session: Session, page_id: int, advertiser_id: str) -> None:
    values = {"page_id": page_id, "advertiser_id": advertiser_id}
    dialect = session.get_bind().dialect.name
    statement: Any
    if dialect == "sqlite":
        statement = sqlite_insert(A).values(**values).on_conflict_do_nothing(index_elements=[A.page_id])
    elif dialect == "mysql":
        statement = mysql_insert(A).values(**values).on_duplicate_key_update(page_id=page_id)
    else:
        if session.get(A, page_id) is None:
            session.add(A(**values))
            session.flush()
        return
    session.execute(statement)


def scoped_pages(
    *, user_ids: Optional[Sequence[int]] = None, user_id: Optional[int] = None,
    session_id: Optional[int] = None,
    platform_id: Optional[int] = None, managed_account_id: Optional[int] = None,
    advertiser_id: Optional[str] = None, exact_advertiser: bool = False,
    direct_mode: Optional[bool] = None, start_at: Any = None, end_at: Any = None,
) -> Any:
    statement = (
        select(
            A.advertiser_id, S.platform_id, S.platform_name, S.user_id, S.username,
            S.id.label("session_id"), S.managed_account_id, S.managed_account_name,
            S.remote_account_id, S.remote_display_name, S.credential_version, S.bootstrap_session_id,
            S.identity_snapshot_at, P.id.label("page_id"), P.url, P.url_params,
            P.visits, P.clicks, P.inputs, P.submits, P.first_seen_at, P.last_seen_at,
        )
        .join(P, A.page_id == P.id).join(S, P.session_id == S.id)
    )
    if user_ids is not None:
        statement = statement.where(S.user_id.in_(user_ids))
    elif user_id is not None:
        statement = statement.where(S.user_id == user_id)
    if session_id is not None:
        statement = statement.where(S.id == session_id)
    if platform_id is not None:
        statement = statement.where(S.platform_id == platform_id)
    if managed_account_id is not None:
        statement = statement.where(S.managed_account_id == managed_account_id)
    if advertiser_id:
        condition = (
            A.advertiser_id == advertiser_id if exact_advertiser
            else A.advertiser_id.contains(advertiser_id, autoescape=True)
        )
        statement = statement.where(condition)
    if direct_mode is not None:
        statement = statement.where(S.direct_mode.is_(direct_mode))
    if start_at:
        statement = statement.where(P.last_seen_at >= parse_datetime(start_at))
    if end_at:
        statement = statement.where(P.first_seen_at <= parse_datetime(end_at, end_of_day=True))
    return statement.subquery()


def identity_source(rows: Any) -> Any:
    return case(
        (rows.c.managed_account_id.is_(None), "unassociated"),
        (rows.c.identity_snapshot_at.isnot(None), "bootstrap"),
        else_="historical",
    )


def paginate(session: Session, statement: Any, *, page: int, page_size: int) -> tuple[list[Any], int]:
    total = int(session.scalar(select(func.count()).select_from(statement.order_by(None).subquery())) or 0)
    return list(session.execute(statement.offset((page - 1) * page_size).limit(page_size)).mappings()), total


def list_accounts(session: Session, rows: Any, *, page: int, page_size: int) -> tuple[list[Any], int]:
    c = rows.c
    statement = (
        select(
            c.advertiser_id, c.platform_id, func.max(c.platform_name).label("platform_name"),
            func.count(func.distinct(c.managed_account_id)).label("managed_account_count"),
            func.count(func.distinct(c.user_id)).label("user_count"),
            func.count(func.distinct(c.session_id)).label("session_count"),
            func.count(c.page_id).label("page_count"), func.sum(c.visits).label("total_visits"),
            func.count(func.distinct(case((c.managed_account_id.is_(None), c.session_id))))
            .label("unassociated_session_count"),
            func.min(c.first_seen_at).label("first_seen_at"), func.max(c.last_seen_at).label("last_seen_at"),
        ).group_by(c.platform_id, c.advertiser_id)
        .order_by(func.max(c.last_seen_at).desc(), c.platform_id, c.advertiser_id)
    )
    return paginate(session, statement, page=page, page_size=page_size)


def name_summaries(
    session: Session, rows: Any, keys: list[tuple[int, str]], *, managed: bool,
) -> dict[tuple[int, str], list[str]]:
    if not keys:
        return {}
    c = rows.c
    column = c.managed_account_name if managed else c.username
    distinct_statement = select(c.platform_id, c.advertiser_id, column.label("name")).where(
        tuple_(c.platform_id, c.advertiser_id).in_(keys), column.isnot(None),
    ).distinct()
    distinct_names = distinct_statement.subquery()
    d = distinct_names.c
    binding_index = 0

    def independent_binding(element: Any, **kw: Any) -> Any:
        nonlocal binding_index
        if isinstance(element, BindParameter):
            binding_index += 1
            return bindparam(
                f"preceding_name_{binding_index}", value=element.value, type_=element.type, expanding=element.expanding,
            )
        return None

    # A positional driver cannot expand the same IN bind twice. Clone bindings,
    # not scope values, so both sides keep identical authorization predicates.
    preceding_statement = visitors.replacement_traverse(distinct_statement, {}, independent_binding)
    assert isinstance(preceding_statement, Select)
    preceding = preceding_statement.subquery("preceding_names")
    # MySQL 5.7 has no window functions. Count earlier distinct names within the
    # same scoped key, so the database still returns at most three per account.
    earlier_count = select(func.count()).select_from(preceding).where(
        preceding.c.platform_id == d.platform_id,
        preceding.c.advertiser_id == d.advertiser_id,
        preceding.c.name < d.name,
    ).correlate(distinct_names).scalar_subquery()
    found = session.execute(select(distinct_names).where(earlier_count < 3).order_by(
        d.platform_id, d.advertiser_id, d.name,
    ))
    result: dict[tuple[int, str], list[str]] = {}
    for row in found:
        result.setdefault((row.platform_id, row.advertiser_id), []).append(row.name)
    return result


def associations(session: Session, rows: Any, *, page: int, page_size: int) -> tuple[list[Any], int]:
    c = rows.c
    source = identity_source(rows)
    keys = [
        c.managed_account_id, c.managed_account_name, c.remote_account_id,
        c.remote_display_name, c.credential_version, source,
    ]
    statement = select(
        *keys[:-1], source.label("identity_source"),
        func.count(func.distinct(c.user_id)).label("user_count"),
        func.count(func.distinct(c.session_id)).label("session_count"),
        func.min(c.first_seen_at).label("first_seen_at"), func.max(c.last_seen_at).label("last_seen_at"),
    ).group_by(*keys).order_by(func.max(c.last_seen_at).desc(), *keys)
    return paginate(session, statement, page=page, page_size=page_size)


def sources(session: Session, rows: Any, *, page: int, page_size: int) -> tuple[list[Any], int]:
    statement = select(rows, identity_source(rows).label("identity_source")).order_by(
        rows.c.last_seen_at.desc(), rows.c.page_id
    )
    return paginate(session, statement, page=page, page_size=page_size)


def options(
    session: Session, rows: Any, *, page: int, page_size: int, search: Optional[str] = None,
) -> dict[str, Any]:
    c = rows.c

    def option_page(id_column: Any, name_column: Any) -> list[dict[str, Any]]:
        statement = select(id_column.label("id"), func.max(name_column).label("name")).where(id_column.isnot(None))
        if search:
            statement = statement.where(or_(name_column.contains(search, autoescape=True),
                                             cast(id_column, String).contains(search, autoescape=True)))
        statement = statement.group_by(id_column).order_by(id_column).offset((page - 1) * page_size)
        statement = statement.limit(page_size + 1)
        return [{"id": row.id, "name": row.name or f"#{row.id}"} for row in session.execute(statement)]

    managed = option_page(c.managed_account_id, c.managed_account_name)
    platforms = option_page(c.platform_id, c.platform_name)
    return {
        "managedAccounts": managed[:page_size], "platforms": platforms[:page_size],
        "managedAccountsHasMore": len(managed) > page_size, "platformsHasMore": len(platforms) > page_size,
        "page": page, "pageSize": page_size,
    }

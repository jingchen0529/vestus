"""Administrator-managed Ark/platform login routes."""

from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from app.api.deps import audit_context, get_db, super_admin_auth, user_auth
from app.api.envelope import EnvelopeRoute
from app.db.session import Database
from app.schemas.managed_platforms import (
    ManagedAccountBindingCreate,
    ManagedBindingCreate,
    ManagedBootstrapConsumeRequest,
    ManagedBootstrapRequest,
    ManagedPlatformAccountCreate,
    ManagedPlatformAccountUpdate,
    ManagedPlatformUserAccountCreate,
    ManagedPlatformUserAccountUpdate,
    ManagedPlatformUserConfig,
    ManagedSessionExpiredRequest,
)
from app.services import managed_platforms as managed_service

NO_FIELDS_DETAIL = "至少提供一个待更新字段"

router = APIRouter(route_class=EnvelopeRoute)


@router.get("/api/admin/managed-platform-accounts", tags=["managed-platforms"])
def list_managed_accounts(
    _auth: Dict[str, Any] = Depends(super_admin_auth), db: Database = Depends(get_db)
) -> Dict[str, Any]:
    return {"items": managed_service.list_accounts(db)}


@router.post("/api/admin/managed-platform-accounts", status_code=201, tags=["managed-platforms"])
def create_managed_account(
    payload: ManagedPlatformAccountCreate,
    request: Request,
    auth: Dict[str, Any] = Depends(super_admin_auth),
    db: Database = Depends(get_db),
) -> Dict[str, Any]:
    values = payload.model_dump(by_alias=False)
    values["created_by"] = auth["id"]
    return managed_service.create_account(db, values, audit=audit_context(request, auth))


@router.get("/api/admin/managed-platform-accounts/{account_id}", tags=["managed-platforms"])
def get_managed_account(
    account_id: int,
    _auth: Dict[str, Any] = Depends(super_admin_auth),
    db: Database = Depends(get_db),
) -> Dict[str, Any]:
    result = managed_service.get_account(db, account_id)
    if result is None:
        raise HTTPException(status_code=404, detail=managed_service.MANAGED_ACCOUNT_NOT_FOUND)
    return result


@router.patch("/api/admin/managed-platform-accounts/{account_id}", tags=["managed-platforms"])
def update_managed_account(
    account_id: int,
    payload: ManagedPlatformAccountUpdate,
    request: Request,
    auth: Dict[str, Any] = Depends(super_admin_auth),
    db: Database = Depends(get_db),
) -> Dict[str, Any]:
    values = payload.model_dump(exclude_unset=True, by_alias=False)
    if not values:
        raise HTTPException(status_code=400, detail=NO_FIELDS_DETAIL)
    return managed_service.update_account(
        db, account_id, values, audit=audit_context(request, auth)
    )


@router.get("/api/admin/managed-bindings", tags=["managed-platforms"])
def list_all_managed_bindings(
    request: Request,
    auth: Dict[str, Any] = Depends(super_admin_auth),
    db: Database = Depends(get_db),
) -> Dict[str, Any]:
    """全部用户的托管绑定总览，含会话失效状态与计数。"""
    return managed_service.list_all_bindings(db)


@router.delete("/api/admin/managed-platform-accounts/{account_id}", tags=["managed-platforms"])
def revoke_managed_account(
    account_id: int,
    request: Request,
    auth: Dict[str, Any] = Depends(super_admin_auth),
    db: Database = Depends(get_db),
) -> None:
    managed_service.delete_account(db, account_id, audit=audit_context(request, auth))


@router.post(
    "/api/admin/managed-platform-accounts/{account_id}/identity-check",
    tags=["managed-platforms"],
)
def check_managed_account_identity(
    account_id: int,
    request: Request,
    auth: Dict[str, Any] = Depends(super_admin_auth),
    db: Database = Depends(get_db),
) -> Dict[str, Any]:
    """实时校验账号 Cookie 的平台登录态并刷新远端身份信息。"""
    return managed_service.check_account_identity(
        db, account_id, audit=audit_context(request, auth)
    )




@router.post(
    "/api/admin/managed-platform-accounts/{account_id}/bindings",
    status_code=201,
    tags=["managed-platforms"],
)
def bind_managed_account(
    account_id: int,
    payload: ManagedBindingCreate,
    request: Request,
    auth: Dict[str, Any] = Depends(super_admin_auth),
    db: Database = Depends(get_db),
) -> Dict[str, Any]:
    return managed_service.bind_account(
        db,
        account_id,
        payload.user_id,
        audit=audit_context(request, auth),
    )


@router.delete(
    "/api/admin/managed-platform-accounts/{account_id}/bindings/{user_id}",
    tags=["managed-platforms"],
)
def unbind_managed_account(
    account_id: int,
    user_id: int,
    request: Request,
    auth: Dict[str, Any] = Depends(super_admin_auth),
    db: Database = Depends(get_db),
) -> None:
    managed_service.unbind_account(
        db,
        account_id,
        user_id,
        audit=audit_context(request, auth),
    )


@router.get("/api/admin/users/{user_id}/managed-account", tags=["managed-platforms"])
def get_user_managed_account(
    user_id: int,
    _auth: Dict[str, Any] = Depends(super_admin_auth),
    db: Database = Depends(get_db),
) -> Dict[str, Any]:
    result = managed_service.get_user_account(db, user_id)
    if result is None:
        raise HTTPException(status_code=404, detail=managed_service.MANAGED_BINDING_NOT_FOUND)
    return result


@router.get("/api/admin/users/{user_id}/managed-accounts", tags=["managed-platforms"])
def list_user_managed_accounts(
    user_id: int,
    _auth: Dict[str, Any] = Depends(super_admin_auth),
    db: Database = Depends(get_db),
) -> Dict[str, Any]:
    return {"items": managed_service.list_user_accounts(db, user_id)}


@router.post(
    "/api/admin/users/{user_id}/managed-accounts",
    status_code=201,
    tags=["managed-platforms"],
)
def add_user_managed_account(
    user_id: int,
    payload: ManagedAccountBindingCreate | ManagedPlatformUserAccountCreate,
    request: Request,
    auth: Dict[str, Any] = Depends(super_admin_auth),
    db: Database = Depends(get_db),
) -> Dict[str, Any]:
    if isinstance(payload, ManagedAccountBindingCreate):
        return managed_service.bind_account(
            db,
            payload.managed_account_id,
            user_id,
            audit=audit_context(request, auth),
        )
    return managed_service.create_user_bound_account(
        db,
        user_id,
        payload.model_dump(by_alias=False),
        audit=audit_context(request, auth),
    )


@router.get(
    "/api/admin/users/{user_id}/managed-accounts/{managed_account_id}",
    tags=["managed-platforms"],
)
def get_user_bound_managed_account(
    user_id: int,
    managed_account_id: int,
    _auth: Dict[str, Any] = Depends(super_admin_auth),
    db: Database = Depends(get_db),
) -> Dict[str, Any]:
    return managed_service.get_user_bound_account(db, user_id, managed_account_id)


@router.patch(
    "/api/admin/users/{user_id}/managed-accounts/{managed_account_id}",
    tags=["managed-platforms"],
)
def patch_user_bound_managed_account(
    user_id: int,
    managed_account_id: int,
    payload: ManagedPlatformUserAccountUpdate,
    request: Request,
    auth: Dict[str, Any] = Depends(super_admin_auth),
    db: Database = Depends(get_db),
) -> Dict[str, Any]:
    values = payload.model_dump(exclude_unset=True, by_alias=False)
    if not values:
        raise HTTPException(status_code=400, detail=NO_FIELDS_DETAIL)
    return managed_service.update_user_bound_account(
        db,
        user_id,
        managed_account_id,
        values,
        audit=audit_context(request, auth),
    )


@router.delete(
    "/api/admin/users/{user_id}/managed-accounts/{managed_account_id}",
    tags=["managed-platforms"],
)
def remove_user_managed_account(
    user_id: int,
    managed_account_id: int,
    request: Request,
    auth: Dict[str, Any] = Depends(super_admin_auth),
    db: Database = Depends(get_db),
) -> None:
    managed_service.unbind_account(
        db,
        managed_account_id,
        user_id,
        audit=audit_context(request, auth),
    )


@router.put("/api/admin/users/{user_id}/managed-account", tags=["managed-platforms"])
def save_user_managed_account(
    user_id: int,
    payload: ManagedPlatformUserConfig,
    request: Request,
    auth: Dict[str, Any] = Depends(super_admin_auth),
    db: Database = Depends(get_db),
) -> Dict[str, Any]:
    return managed_service.upsert_user_account(
        db,
        user_id,
        payload.model_dump(by_alias=False),
        audit=audit_context(request, auth),
    )


@router.delete("/api/admin/users/{user_id}/managed-account", tags=["managed-platforms"])
def delete_user_managed_account(
    user_id: int,
    request: Request,
    auth: Dict[str, Any] = Depends(super_admin_auth),
    db: Database = Depends(get_db),
) -> None:
    managed_service.delete_user_account(db, user_id, audit=audit_context(request, auth))


@router.post(
    "/api/user/managed-platforms/{platform_id}/bootstrap",
    tags=["managed-platforms"],
)
def issue_managed_bootstrap(
    platform_id: int,
    payload: ManagedBootstrapRequest,
    request: Request,
    response: Response,
    auth: Dict[str, Any] = Depends(user_auth),
    db: Database = Depends(get_db),
) -> Dict[str, Any]:
    response.headers["Cache-Control"] = "no-store"
    return managed_service.issue_bootstrap(
        db,
        auth["id"],
        platform_id,
        payload.device_id,
        managed_account_id=payload.managed_account_id,
        audit=audit_context(request, auth),
    )


@router.post(
    "/api/user/managed-platforms/{platform_id}/bootstrap/consume",
    tags=["managed-platforms"],
)
def consume_managed_bootstrap(
    platform_id: int,
    payload: ManagedBootstrapConsumeRequest,
    request: Request,
    response: Response,
    auth: Dict[str, Any] = Depends(user_auth),
    db: Database = Depends(get_db),
) -> Dict[str, Any]:
    response.headers["Cache-Control"] = "no-store"
    return managed_service.consume_bootstrap(
        db,
        auth["id"],
        platform_id,
        payload.bootstrap_token,
        payload.device_id,
        audit=audit_context(request, auth),
    )


@router.post(
    "/api/user/managed-platforms/{platform_id}/session-expired",
    tags=["managed-platforms"],
)
def report_managed_session_expired(
    platform_id: int,
    payload: ManagedSessionExpiredRequest,
    request: Request,
    response: Response,
    auth: Dict[str, Any] = Depends(user_auth),
    db: Database = Depends(get_db),
) -> Dict[str, Any]:
    """桌面端检测到用户在平台页面退出登录后上报，本地托管会话随之作废。"""
    response.headers["Cache-Control"] = "no-store"
    return managed_service.report_session_expired(
        db,
        auth["id"],
        platform_id,
        payload.managed_account_id,
        payload.credential_version,
        payload.session_id,
        payload.device_id,
        audit=audit_context(request, auth),
    )


__all__ = ["router"]

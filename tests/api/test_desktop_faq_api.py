"""Desktop FAQ configuration API: permissions, replace-on-save, assembly."""

from __future__ import annotations

from typing import Any

from sqlalchemy import select

from tests.envelope import payload


def _login(client: Any, path: str, username: str, password: str) -> str:
    response = client.post(path, json={"username": username, "password": password})
    assert response.status_code == 200, response.text
    return payload(response)["accessToken"]


def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _super_admin(client: Any) -> str:
    return _login(client, "/api/admin/auth/login", "test-admin", "test-admin-password")


def _plain_admin(client: Any, super_token: str, username: str) -> str:
    response = client.post(
        "/api/admin/admins",
        headers=_bearer(super_token),
        json={
            "username": username,
            "password": f"{username}-password",
            "name": username,
            "role": "admin",
        },
    )
    assert response.status_code == 201, response.text
    return _login(client, "/api/admin/auth/login", username, f"{username}-password")


def _desktop_user(client: Any, super_token: str, username: str) -> str:
    response = client.post(
        "/api/admin/users",
        headers=_bearer(super_token),
        json={
            "username": username,
            "password": f"{username}-password",
            "name": username,
            "expiresAt": "2099-12-31",
        },
    )
    assert response.status_code == 201, response.text
    return _login(client, "/api/user/auth/login", username, f"{username}-password")


def _document() -> dict[str, Any]:
    return {
        "groups": [
            {
                "title": "日常使用",
                "status": "active",
                "items": [
                    {
                        "question": "重复点击方舟入口，会打开多个窗口吗？",
                        "answer": "不会，再次点击只会切回已有的方舟页面。",
                        "status": "active",
                    },
                    {
                        "question": "关掉方舟窗口会退出登录吗？",
                        "answer": "不会，下次点击仍然是自动登录。",
                        "status": "active",
                    },
                ],
            },
            {
                "title": "多个方舟账号",
                "status": "active",
                "items": [
                    {
                        "question": "我可以看到多个「方舟」入口卡片，是正常的吗？",
                        "answer": "正常。管理员绑定了多个方舟账号时会展开成多张卡片。",
                        "status": "active",
                    }
                ],
            },
        ]
    }


def _audit_actions(module: Any, action: str) -> list[Any]:
    with module.db.session() as session:
        return list(
            session.scalars(select(module.UserLog).where(module.UserLog.action == action))
        )


def test_unset_document_reads_as_null_everywhere(api: Any) -> None:
    client, module = api
    super_token = _super_admin(client)
    admin = _plain_admin(client, super_token, "faq-admin")
    user = _desktop_user(client, super_token, "faq-user")

    assert payload(client.get("/api/admin/desktop-faq", headers=_bearer(super_token))) == {
        "faq": None,
        "updatedAt": None,
    }
    assert payload(client.get("/api/admin/desktop-faq", headers=_bearer(admin))) == {
        "faq": None,
        "updatedAt": None,
    }
    assert payload(client.get("/api/user/desktop-faq", headers=_bearer(user))) == {"faq": None}


def test_faq_permissions_split_read_and_write(api: Any) -> None:
    client, _module = api
    super_token = _super_admin(client)
    admin = _plain_admin(client, super_token, "faq-admin")

    # 普通管理员可读、不可写；超管可写。
    admin_put = client.put("/api/admin/desktop-faq", headers=_bearer(admin), json=_document())
    assert admin_put.status_code == 403, admin_put.text
    admin_delete = client.delete("/api/admin/desktop-faq", headers=_bearer(admin))
    assert admin_delete.status_code == 403, admin_delete.text

    saved = client.put("/api/admin/desktop-faq", headers=_bearer(super_token), json=_document())
    assert saved.status_code == 200, saved.text

    # 桌面用户不能访问管理端接口。
    user = _desktop_user(client, super_token, "faq-user")
    forbidden = client.get("/api/admin/desktop-faq", headers=_bearer(user))
    assert forbidden.status_code == 403, forbidden.text


def test_save_replaces_whole_document_and_lands_in_audit(api: Any) -> None:
    client, module = api
    super_token = _super_admin(client)

    saved = payload(
        client.put("/api/admin/desktop-faq", headers=_bearer(super_token), json=_document())
    )
    assert len(saved["faq"]) == 2
    assert saved["faq"][0]["title"] == "日常使用"
    assert len(saved["faq"][0]["items"]) == 2
    assert saved["updatedAt"] is not None

    # 保存一份更小的文档：旧行必须整体消失，不能残留。
    smaller = {"groups": _document()["groups"][:1]}
    replaced = payload(
        client.put("/api/admin/desktop-faq", headers=_bearer(super_token), json=smaller)
    )
    assert len(replaced["faq"]) == 1
    with module.db.session() as session:
        assert len(list(session.scalars(select(module.DesktopFaqGroup)))) == 1
        assert len(list(session.scalars(select(module.DesktopFaqItem)))) == 2

    actions = _audit_actions(module, "DESKTOP_FAQ_UPDATED")
    assert len(actions) == 2
    assert "1 组 / 2 条" in actions[-1].summary


def test_client_payload_only_contains_active_rows(api: Any) -> None:
    client, _module = api
    super_token = _super_admin(client)
    user = _desktop_user(client, super_token, "faq-user")

    document = _document()
    document["groups"][0]["items"][1]["status"] = "disabled"
    document["groups"][1]["status"] = "disabled"
    client.put("/api/admin/desktop-faq", headers=_bearer(super_token), json=document)

    # 管理端看到全部行（含停用），客户端只看到启用的。
    admin_view = payload(client.get("/api/admin/desktop-faq", headers=_bearer(super_token)))
    assert len(admin_view["faq"]) == 2
    assert len(admin_view["faq"][0]["items"]) == 2

    user_view = payload(client.get("/api/user/desktop-faq", headers=_bearer(user)))
    assert user_view["faq"] is not None
    assert [group["title"] for group in user_view["faq"]] == ["日常使用"]
    assert [item["question"] for item in user_view["faq"][0]["items"]] == [
        "重复点击方舟入口，会打开多个窗口吗？"
    ]

    # 全部停用后，客户端读作未配置。
    all_disabled = _document()
    for group in all_disabled["groups"]:
        group["status"] = "disabled"
        for item in group["items"]:
            item["status"] = "disabled"
    client.put("/api/admin/desktop-faq", headers=_bearer(super_token), json=all_disabled)
    assert payload(client.get("/api/user/desktop-faq", headers=_bearer(user))) == {"faq": None}


def test_reset_clears_everything_and_audits(api: Any) -> None:
    client, module = api
    super_token = _super_admin(client)
    user = _desktop_user(client, super_token, "faq-user")
    client.put("/api/admin/desktop-faq", headers=_bearer(super_token), json=_document())

    assert payload(client.delete("/api/admin/desktop-faq", headers=_bearer(super_token))) == {
        "faq": None,
        "updatedAt": None,
    }
    assert payload(client.get("/api/admin/desktop-faq", headers=_bearer(super_token))) == {
        "faq": None,
        "updatedAt": None,
    }
    assert payload(client.get("/api/user/desktop-faq", headers=_bearer(user))) == {"faq": None}
    with module.db.session() as session:
        assert len(list(session.scalars(select(module.DesktopFaqGroup)))) == 0
        assert len(list(session.scalars(select(module.DesktopFaqItem)))) == 0
    assert len(_audit_actions(module, "DESKTOP_FAQ_RESET")) == 1


def test_template_is_readable_by_plain_admins(api: Any) -> None:
    client, _module = api
    super_token = _super_admin(client)
    admin = _plain_admin(client, super_token, "faq-admin")

    template = payload(client.get("/api/admin/desktop-faq/template", headers=_bearer(admin)))
    assert template["faq"]["groups"]
    for group in template["faq"]["groups"]:
        assert group["items"], "模板分组不允许为空"


def test_validation_rejects_broken_documents(api: Any) -> None:
    client, _module = api
    super_token = _super_admin(client)

    def _expect_unprocessable(document: dict[str, Any], fragment: str) -> None:
        response = client.put(
            "/api/admin/desktop-faq", headers=_bearer(super_token), json=document
        )
        assert response.status_code == 422, response.text
        assert fragment in response.json()["msg"], response.json()["msg"]

    # 空文档
    _expect_unprocessable({"groups": []}, "至少保留一个分组")
    # 组内重复问题
    _expect_unprocessable(
        {
            "groups": [
                {
                    "title": "重复",
                    "items": [
                        {"question": "同一个问题？", "answer": "第一个答案"},
                        {"question": "同一个问题？", "answer": "第二个答案"},
                    ],
                }
            ]
        },
        "问题重复",
    )
    # 答案超长
    _expect_unprocessable(
        {
            "groups": [
                {
                    "title": "超长",
                    "items": [{"question": "答案超长会怎样？", "answer": "长" * 5001}],
                }
            ]
        },
        "答案不能超过 5000 字",
    )
    # 控制字符
    _expect_unprocessable(
        {
            "groups": [
                {
                    "title": "控制字符",
                    "items": [{"question": "答案带制表符\t行吗？", "answer": "不行"}],
                }
            ]
        },
        "控制字符",
    )
    # 非法状态枚举
    _expect_unprocessable(
        {
            "groups": [
                {
                    "title": "非法状态",
                    "items": [
                        {
                            "question": "状态能随便填吗？",
                            "answer": "不能",
                            "status": "archived",
                        }
                    ],
                }
            ]
        },
        "status",
    )


def test_empty_group_is_allowed_but_hidden_from_clients(api: Any) -> None:
    client, _module = api
    super_token = _super_admin(client)
    user = _desktop_user(client, super_token, "faq-user")

    # 「分组先建、问答后补」：管理端允许空分组，否则列表化交互必须先编一条内容。
    draft = {
        "groups": [
            {"title": "还没写内容的分组", "items": []},
            {
                "title": "日常使用",
                "items": [{"question": "能先建分组吗？", "answer": "可以，问答随后补。"}],
            },
        ]
    }
    saved = payload(
        client.put("/api/admin/desktop-faq", headers=_bearer(super_token), json=draft)
    )
    assert [group["title"] for group in saved["faq"]] == ["还没写内容的分组", "日常使用"]
    assert saved["faq"][0]["items"] == []

    # 客户端只收到有启用条目的分组，空分组不会露出来。
    user_view = payload(client.get("/api/user/desktop-faq", headers=_bearer(user)))
    assert [group["title"] for group in user_view["faq"]] == ["日常使用"]


def test_user_read_is_audited_standalone(api: Any) -> None:
    client, module = api
    super_token = _super_admin(client)
    user = _desktop_user(client, super_token, "faq-user")

    client.get("/api/user/desktop-faq", headers=_bearer(user))
    assert len(_audit_actions(module, "DESKTOP_FAQ_READ")) == 1

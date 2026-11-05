"""Desktop FAQ document request body.

Style follows :mod:`app.schemas.settings`: camelCase aliases on the wire,
``field_validator``s that transform-and-refuse, and Chinese error messages the
admin console can toast verbatim.  Validation errors carry the group/item
position so the editor can scroll the operator to the offending field.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

#: The whole saved document; the editor works well below this, the cap only
#: exists so a runaway paste cannot stall the API process.
MAX_DOCUMENT_BYTES = 512 * 1024
MAX_GROUPS = 20
MAX_ITEMS_PER_GROUP = 50
MAX_ITEMS_TOTAL = 200

_STATUS_VALUES = ("active", "disabled")


def _reject_control_characters(text: str, label: str) -> None:
    """Refuse control characters other than the newline the answers need."""

    for character in text:
        if character == "\n":
            continue
        if not character.isprintable():
            raise ValueError(f"{label}包含不允许的控制字符")


class FaqItemIn(BaseModel):
    question: str = Field(max_length=255)
    answer: str = Field(max_length=6000)
    status: Literal["active", "disabled"] = "active"
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    @field_validator("question")
    @classmethod
    def validate_question(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("问题不能为空")
        if len(text) > 200:
            raise ValueError("问题不能超过 200 字")
        _reject_control_characters(text, "问题")
        return text

    @field_validator("answer")
    @classmethod
    def validate_answer(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("答案不能为空")
        if len(text) > 5000:
            raise ValueError("答案不能超过 5000 字")
        _reject_control_characters(text, "答案")
        return text


class FaqGroupIn(BaseModel):
    title: str = Field(max_length=100)
    status: Literal["active", "disabled"] = "active"
    items: list[FaqItemIn] = Field(default_factory=list)
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    @field_validator("title")
    @classmethod
    def validate_title(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("分组标题不能为空")
        if len(text) > 50:
            raise ValueError("分组标题不能超过 50 字")
        _reject_control_characters(text, "分组标题")
        return text

    @field_validator("items")
    @classmethod
    def validate_items(cls, value: list[FaqItemIn]) -> list[FaqItemIn]:
        # 空分组是合法状态：管理端「帮助分组」先建栏、「帮助内容」再逐条加问答，
        # 列表化的交互不该被「必须先写一条」卡住。客户端 payload 会丢掉没有任何
        # 启用条目的分组（见 services.desktop_faq._assemble），空分组不会露给用户。
        if len(value) > MAX_ITEMS_PER_GROUP:
            raise ValueError(f"每个分组最多 {MAX_ITEMS_PER_GROUP} 个问题")
        return value

    @model_validator(mode="after")
    def validate_unique_questions(self) -> "FaqGroupIn":
        seen: dict[str, int] = {}
        for index, item in enumerate(self.items, start=1):
            first = seen.setdefault(item.question, index)
            if first != index:
                raise ValueError(f"第 {first} 条与第 {index} 条问题重复，请修改后再保存")
        return self


class DesktopFaqDocument(BaseModel):
    groups: list[FaqGroupIn] = Field(default_factory=list)
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    @field_validator("groups")
    @classmethod
    def validate_groups(cls, value: list[FaqGroupIn]) -> list[FaqGroupIn]:
        if not value:
            raise ValueError("至少保留一个分组；要下线全部内容请使用「恢复默认」")
        if len(value) > MAX_GROUPS:
            raise ValueError(f"最多 {MAX_GROUPS} 个分组")
        total = sum(len(group.items) for group in value)
        if total > MAX_ITEMS_TOTAL:
            raise ValueError(f"全部问题总数不能超过 {MAX_ITEMS_TOTAL} 条")
        return value


__all__ = [
    "MAX_DOCUMENT_BYTES",
    "MAX_GROUPS",
    "MAX_ITEMS_PER_GROUP",
    "MAX_ITEMS_TOTAL",
    "DesktopFaqDocument",
    "FaqGroupIn",
    "FaqItemIn",
]

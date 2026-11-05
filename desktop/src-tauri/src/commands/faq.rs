//! 客户端「常见问题」帮助内容：读取、结构校验与 IPC 视图。
//!
//! 内容是管理员在后台配置的公开 Q&A 文本。这里沿用桌面配置的下发约束：响应
//! 只反序列化进白名单结构，超过本文件上限（服务端 schema 之上的容错余量）或
//! 含换行之外控制字符的内容整体拒绝，前端按「拉取失败」走本地缓存/内置基线。

use serde::Deserialize;

use crate::auth::DesktopAuthState;

use super::*;

/// 服务端 schema 上限是 20 组 / 每组 50 条 / 2000 字答案；这里给向前兼容留
/// 余量，只拦截荒谬载荷，不重复业务规则。
const MAX_GROUPS: usize = 50;
const MAX_ITEMS_PER_GROUP: usize = 100;
const MAX_TITLE_CHARS: usize = 100;
const MAX_QUESTION_CHARS: usize = 255;
const MAX_ANSWER_CHARS: usize = 6000;

#[derive(Deserialize)]
pub(crate) struct DesktopFaqWire {
    /// 服务端 ``data.faq`` 直接是分组数组（``services.desktop_faq._assemble`` 的返回），
    /// 不是 ``{ groups }`` 包裹。这层形状与 IPC 出口（``DesktopFaqView { groups }``）不同：
    /// 前者是 HTTP 契约，后者是给前端用的包装，别合并成一种。
    #[serde(default)]
    pub(crate) faq: Option<Vec<DesktopFaqGroupWire>>,
}

#[derive(Deserialize)]
pub(crate) struct DesktopFaqGroupWire {
    #[serde(default)]
    pub(crate) title: String,
    #[serde(default = "default_faq_status")]
    pub(crate) status: String,
    #[serde(default)]
    pub(crate) items: Vec<DesktopFaqItemWire>,
}

#[derive(Deserialize)]
pub(crate) struct DesktopFaqItemWire {
    #[serde(default)]
    pub(crate) question: String,
    #[serde(default)]
    pub(crate) answer: String,
    #[serde(default = "default_faq_status")]
    pub(crate) status: String,
}

pub(crate) fn default_faq_status() -> String {
    "active".into()
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct DesktopFaqView {
    pub groups: Vec<DesktopFaqGroupView>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct DesktopFaqGroupView {
    pub title: String,
    pub items: Vec<DesktopFaqItemView>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct DesktopFaqItemView {
    pub question: String,
    pub answer: String,
}

fn faq_status_valid(status: &str) -> bool {
    matches!(status, "active" | "disabled")
}

/// 换行是答案的合法组成部分；其余控制字符说明内容被污染，整体拒绝。
fn faq_text_valid(text: &str, max_chars: usize) -> bool {
    text.chars().count() <= max_chars
        && !text
            .chars()
            .any(|character| character != '\n' && character.is_control())
}

pub(crate) fn validate_desktop_faq(
    wire_groups: Vec<DesktopFaqGroupWire>,
) -> CmdResult<DesktopFaqView> {
    if wire_groups.len() > MAX_GROUPS {
        return Err(CommandError::new(
            "管理员下发的帮助内容分组过多",
            "invalid_desktop_faq",
        ));
    }
    let mut groups = Vec::with_capacity(wire_groups.len());
    for group in wire_groups {
        if !faq_status_valid(&group.status) {
            return Err(CommandError::new(
                "管理员下发的帮助内容分组状态无效",
                "invalid_desktop_faq",
            ));
        }
        if group.items.len() > MAX_ITEMS_PER_GROUP {
            return Err(CommandError::new(
                "管理员下发的帮助内容单组问题过多",
                "invalid_desktop_faq",
            ));
        }
        let mut items = Vec::with_capacity(group.items.len());
        for item in group.items {
            if !faq_status_valid(&item.status) {
                return Err(CommandError::new(
                    "管理员下发的帮助内容问题状态无效",
                    "invalid_desktop_faq",
                ));
            }
            if !faq_text_valid(&item.question, MAX_QUESTION_CHARS)
                || !faq_text_valid(&item.answer, MAX_ANSWER_CHARS)
            {
                return Err(CommandError::new(
                    "管理员下发的帮助内容文本无效",
                    "invalid_desktop_faq",
                ));
            }
            items.push(DesktopFaqItemView {
                question: item.question,
                answer: item.answer,
            });
        }
        let title = group.title.trim().to_string();
        if title.chars().count() > MAX_TITLE_CHARS || title.chars().any(char::is_control) {
            return Err(CommandError::new(
                "管理员下发的帮助内容分组标题无效",
                "invalid_desktop_faq",
            ));
        }
        groups.push(DesktopFaqGroupView { title, items });
    }
    Ok(DesktopFaqView { groups })
}

/// 拉取客户端帮助内容；未配置（`faq: null`）返回 `None`，由前端回退内置基线。
#[tauri::command]
pub async fn desktop_faq(
    auth: tauri::State<'_, DesktopAuthState>,
) -> CmdResult<Option<DesktopFaqView>> {
    require_desktop_auth(&auth)?;
    let wire: DesktopFaqWire = auth.fetch_desktop_faq().await.map_err(auth_command_error)?;
    let Some(wire_groups) = wire.faq else {
        return Ok(None);
    };
    let view = validate_desktop_faq(wire_groups)?;
    if view.groups.is_empty() {
        return Ok(None);
    }
    Ok(Some(view))
}

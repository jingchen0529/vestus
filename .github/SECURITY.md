# 安全报告指南

## 私密报告渠道与当前状态

本项目选择 GitHub 的 **Private vulnerability reporting（私密漏洞报告）** 作为安全报告渠道，仓库为 [jingchen0529/vestus](https://github.com/jingchen0529/vestus)。

**截至 2026-11-20，只读仓库设置核验返回 `enabled: false`，该功能尚未启用。** 维护者需在仓库 **Settings → Code security → Private vulnerability reporting → Enable** 启用；若设置导航名称变化，可在 Settings 中查找该功能。启用后仍须到 **Security → Advisories** 核验是否出现 **Report a vulnerability** 入口；以实际入口为准，本文不代表设置已完成，也不会自动启用功能。

入口可用后，请从 [Security → Advisories](https://github.com/jingchen0529/vestus/security/advisories) 点击 **Report a vulnerability** 提交私密报告。入口不可用时，只在公开 Issue 询问“如何取得私密安全报告渠道”，**不要披露漏洞详情、受影响接口、复现步骤、攻击代码或敏感数据**；等待维护者提供可用私密渠道后再报告。不要用公开 PR、Issue 或评论提交漏洞材料。

## 报告内容

在已确认的私密渠道中尽量说明：

- 受影响的版本或提交、组件、操作系统及部署方式。
- 问题影响、触发前提、最小复现步骤、预期与实际行为。
- 使用测试账号和脱敏数据的证据，以及已知的临时缓解建议。

不得上传真实密钥、令牌、账号密码、Cookie、完整会话、浏览器 profile、客户数据或生产日志。测试只针对自己拥有或已获授权的环境，不访问他人数据、不破坏服务；若证据包含敏感信息，先脱敏再提交。协商披露方式前，不公开漏洞细节。

## 边界与处理

本指南只说明报告流程，不承诺响应时限、修复时限或特定版本的支持周期。维护者需根据实际版本与部署范围核验影响；未验证内容应明确标注“未验证”。

不要把“受控浏览器”理解为能对抗完全控制本机的使用者；本机 profile 或改动后的客户端可能暴露会话。本指南也不声称所有凭据、会话或客户数据均已加密。现有边界与限制见 [README 的安全边界](../README.md#关键行为与安全边界)，实际部署配置需单独核验。

修复仍按 [贡献指南](CONTRIBUTING.md) 验证。涉及版本化安装包或发布时，遵守 [AGENTS.md](../AGENTS.md) 的中文说明、展示批准、校验、同提交构建顺序；安全报告或普通 PR 本身不授权打 tag、部署或对外发布。

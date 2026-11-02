# 更新记录

## 0.1.0 — 2026-11-02

首个可用版本。基于 `dsh-connect-doubao@0.3.1` + macOS Safe Storage 补丁。

### 新增

- **账号卡片**：读 `<profile>/Preferences` 的 `saman.last_user` 给出本地登录账号，
  再用 `passport/account/info/v2` 校验会话是否还有效；离线时退化为本地信息。
- **会话列表**：官方 IM `chain/recent_conv`（cmd=3200），带条数、相对时间与
  最后一条摘要（`fetchConversationMeta` 二次回填）。
- **消息正文**：官方 IM `chain/single`（cmd=3100），按 `index_in_conv` 往回翻页，
  文本从 `content_block` 还原，附件只留元数据不下载。
- **Markdown 导出**：`/export` 路由落 `~/doubao-exports/`，含角色、时间、附件链接。
- **设置页面板**：`ChatPanel`（左侧会话 / 右侧正文 / 导出按钮），宿主没暴露 slot
  注册表时静默不渲染。

### 修复（相对上游，都是 macOS 上会直接失败的点）

- `device_id` 超过 2^53 时 `String()` 丢精度 → 网关 `712017020`；改用 BigInt。
- `conv_version` 传字符串 → `712017020`；固定发数字 0。
- `pull_singe_chain_uplink_body` 拼写（网关少一个 `l`）被"纠正" → `712010202`。
- 消息 `content` 是字符串化 JSON，先当纯文本用会把整段 JSON 当正文显示。
- 角色从 `sender_id` 猜、按 `message_id` 去重 → 吃掉用户首条提问；改看 `user_type`。
- `apply` 里直接调 `ctx.workingDirectory()` 会让 fiber 崩掉、路由全部挂不上。

### 已知限制

- 额度卡片恒为空：`/alice/commerce/sale/subscription/quota/summary/` 对 macOS 会话
  返回 404（不带 cookie 也是 404，端点绑 Windows 渠道）。
- 设置页面板依赖宿主 `__DSH_UI_SLOTS__`；当前 DSH 0.1.5-rc.1 web 宿主未暴露，
  面板不显示，路由照常可用。
- 单次导出上限约 300 条消息（30 条 × 10 页）。

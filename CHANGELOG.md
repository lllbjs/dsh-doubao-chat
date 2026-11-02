# 更新记录

## 0.2.0 — 2026-11-03

**多账号支持**：本机登录过的每个豆包账号都能独立浏览自己的会话。

### 新增

- **`GET /accounts`** 路由：枚举本机登录过的所有账号（每个带 `available` 标记凭据
  是否可解密、`reason` 说明不可用原因）。
- **`?account=<profile>` 参数**：`account` / `conversations` / `messages` / `export`
  四个路由都接受，指定看哪个账号；省略时回落到默认账号（第一个有登录的 profile）。
- **按 profile 精确解密**：新增 `loadDoubaoCredentialsForProfile(profileDir)`，按
  profile 读各自的 Cookie 库并解密。上游 `loadDoubaoCredentials` 遍历 profile 后只
  返回第一个成功的，多账号时会一直拿到同一个账号的 Cookie。
- **面板账号下拉**：`ChatPanel` 顶部多一个账号切换下拉，选中后 `?account=` 贯穿
  后续所有请求；切换账号会重置已选中的会话与正文。
- **导出归因**：导出的 Markdown 头部多一行「> 账号：…」，文件名把 profile 名编进
  前缀（`<profile>-<title>-<id>.md`），两个账号同名会话不会互相覆盖。

### 修复

- **`web_id` 串号**：`readDeviceIdentity` 原来写死取 `Default` profile 的 `web_id`，
  多账号时会把 A 账号的 `web_id` 塞进 B 账号的 IM 请求。改为
  `readDeviceIdentity(dataDir, profileDir)` 按 profile 读取。
- **`node:sqlite` 在 ESM 下加载失败**：per-profile 解密读 Cookie 库时
  `require("node:sqlite")` 拿不到（ESM 无 `require`），改用 `createRequire(import.meta.url)`。

### 验收

- 冒烟脚本末尾新增「多账号隔离」检查：枚举本机账号、逐个解密 + 拉会话，任意两个
  账号的会话 id 集合完全相同即视为串号、以非 0 退出码失败。
- 本机实测（`15号` 521600394069955 / `16号` 2613964397094219）：`Default` 拉到 7 个
  会话、`Profile 2` 拉到 3 个会话，内容各自独立，隔离检查通过。

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

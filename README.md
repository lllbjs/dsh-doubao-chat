# dsh-doubao-chat

在本机已登录的豆包桌面端之上，浏览**账号 / 会话 / 消息**，并把任意会话导出成
Markdown。**支持多账号**——本机登录过的每个账号都能独立浏览自己的会话。同时完整
继承上游 `dsh-connect-doubao` 的模型 provider 能力（豆包快速、豆包 2.1 Turbo ·
专家、Seedream 生图、额度卡片、模型清单）。

只读：不发消息、不改会话、不写豆包目录。

## 装在哪

```
~/.dsh/profiles/desktop/node_modules/dsh-doubao-chat/     # 本体
~/.dsh/profiles/desktop/package.json                      # dsh.profile.bundles 里登记
```

`package.json` 的 `dependencies` 里是 `file:node_modules/dsh-doubao-chat`，
`bundles` 里是 `dsh-doubao-chat`。原来那两个 `dsh-connect-doubao` /
`dsh-connect-doubao-macos` 已从 `bundles` 摘掉（上游代码作为 `lib/upstream/` 内置，
不需要再单独装一份）。

## 路由

全部挂在 `/plugins/dsh-doubao-chat/*`，只接受回环来源（`Origin` 必须是
127.0.0.1 / localhost）。宿主 Web UI 还要带自己的 Bearer token，和别的插件路由一致。

**多账号：**除了 `/accounts` 之外，每个路由都接受 `?account=<profile 名>` 参数。
省略时后端回落到默认账号（第一个有登录的 profile）。

| 路由 | 说明 | 返回 |
|---|---|---|
| `GET /accounts` | 本机登录过的**所有账号**（每个带凭据是否可用） | `{ok, dataDir, accounts:[{profile, userId, name, avatarUrl, available, reason}]}` |
| `GET /account?account=` | 单账号身份 + 会话是否有效 | `{ok, dataDir, verified, accountName, account:{userId,name,avatarUrl}}` |
| `GET /conversations?account=&limit=30` | 该账号的会话列表 | `{ok, accountName, items:[{id,title,kind,messageCount,lastMessage,...}]}` |
| `GET /messages?account=&id=&kind=3` | 该账号的会话正文 | `{ok, conversationId, accountName, items:[{id,role,createTime,text,attachments}]}` |
| `GET /export?account=&id=&kind=3&title=` | 导出 Markdown，文件名带账号名 | `{ok, file, accountName, bytes, messages}` |

加 `?refresh=1` 绕过 60 秒缓存（对 accounts / account / conversations 有效）。

## 多账号是怎么隔离的

一个 `dataDir` 下有多个 Chromium profile，每个 profile 各自登录一个账号（共用同一
把钥匙串密钥，但 Cookie 密文不同）。上游 `loadDoubaoCredentials` 遍历 profile 后
返回**第一个**成功的，本插件的 `loadDoubaoCredentialsForProfile(profileDir)` 按
profile 精确读各自的库、各自解密，两个账号的 `sessionid` 不一样——所以 IM 请求带
各自的 Cookie，拉到的会话列表也各自独立。

`web_id` 同样按 profile 读取（`readDeviceIdentity(dataDir, profileDir)`），避免
把 A 账号的 `web_id` 塞进 B 账号的请求。

面板的账号下拉走 `/accounts` 枚举，选中后把 `profile` 名编进后续所有请求的
`?account=` 参数。导出的 Markdown 头部和文件名里都带账号名，归因不会错。

## 数据从哪来

```
<dataDir>/<profile>/Preferences        → saman.last_user（明文本地账号）
<dataDir>/<profile>/Cookies            → 登录态（macOS Safe Storage 解密）
  └→ /im/chain/recent_conv  cmd=3200   → 会话列表 + 条数 + 最后一条
  └→ /im/chain/single       cmd=3100   → 消息正文
https://www.doubao.com/passport/account/info/v2/  → 会话是否还活着
```

`dataDir` 由设置卡片的「豆包数据目录」决定，留空则自动探测
（macOS：`~/Library/Application Support/Doubao`、`DoubaoWork`）。

## 踩过的坑（改代码前先读）

1. **`device_id` 是 int64**。`Local State` 里 `aha.device.device_id` 超过 2^53，
   Chromium 通常存成字符串；有的版本存成数字，直接 `String()` 会丢精度，
   网关回 `712017020 数据序列化反序列化错误`。必须 `BigInt(raw).toString()`。
2. **`pull_singe_chain_uplink_body`** 少一个 `l`。这是网关自己的拼写错误，
   纠正成 `single` 会被当成缺字段，回 `712010202`。
3. **`conv_version` 必须是数字 0**。给字符串（哪怕是 `"0"`）同样是 `712017020`。
4. **消息正文在 `content_block`**，而 `content` 是同一份的字符串化 JSON。
   先读 `content_block`，再 parse `content`，最后才当纯文本——顺序反了会把
   一整段 JSON 当消息显示。
5. **角色看 `user_type`**（1=用户，2=bot），不要从 `sender_id` 猜：一个会话里
   user / bot 两条消息的 `message_id` 可能相同，按 id 去重会吃掉用户的首条提问。
6. **不能在 `apply` 里调 `ctx.workingDirectory`**，那是另一个 inject 的服务，
   直接调用会让整个 fiber 崩掉、路由一条都挂不上（报
   `cannot get property "workingDirectory" without inject`）。
7. **两个插件同时注册 provider 会抢同一个 provider id**。本插件内置上游代码，
   所以 `dsh-connect-doubao` 不能同时留在 `bundles` 里。

## 已知限制

- **额度卡片恒为空**。`/alice/commerce/sale/subscription/quota/summary/` 在
  macOS 会话下返回 404，且**不带 cookie 也是 404**——它绑的是 Windows 客户端渠道。
  聊天、会话、账号都不受影响。
- **设置页面板依赖宿主 slot 注册表**。拿不到 `__DSH_UI_SLOTS__` 或 React 时面板
  静默不渲染（路由仍然可用）。当前 DSH 0.1.5-rc.1 的 web 宿主没暴露这个注册表，
  面板需要宿主侧支持才能显示。
- **会话历史深度**。`chain/single` 每次最多 30 条、`pages` 上限 10，
  一次导出最多约 300 条，够常见会话；更长的历史需要按 `index_in_conv` 继续往回翻。

## 用法

浏览器里：

```
http://127.0.0.1:<port>/plugins/dsh-doubao-chat/conversations
```

命令行（带宿主的 token）：

```bash
TOKEN=...  # 启动日志里 ?token= 后面那串
curl -s "http://127.0.0.1:PORT/plugins/dsh-doubao-chat/conversations?limit=10" \
  -H "Origin: http://127.0.0.1:PORT" -H "Authorization: Bearer $TOKEN"
```

## 自测

```bash
node --test __tests__/collect.test.mjs   # 6 个用例：归一化 / 正文提取 / 截断 / device_id
node scripts/smoke.mjs            # 真机打一遍：账号 → 列表 → 正文 → 导出 → 多账号隔离
```

`scripts/smoke.mjs` 会真的读本机豆包、真的发 IM 请求，跑之前确认豆包客户端
已登录、钥匙串里已有 `Doubao Safe Storage`。本机登录多个账号时，末尾会额外枚举
每个账号并校验「会话列表确实不同」——两个账号列表完全相同就说明解密没按 profile
隔离（会串号），会以非 0 退出码失败。

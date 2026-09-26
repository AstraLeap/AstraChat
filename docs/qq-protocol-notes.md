# QQ 开放平台 Bot API 协议取证（实现依据）

本文是 D 阶段实现的**事实依据**。所有条目都标注了来源页面；凡是文档没写、由我推断的，
一律放在 §9「不确定与坑」里，不混进事实区。

取证日期：2026-09-26。官方文档站：<https://bot.q.qq.com/wiki/develop/api-v2/>

> ⚠️ 除 §9 明确标注的项外，本文内容均为官方文档原文摘录（字段名、URL、op 码、位值均原样抄写）。
> 若官方文档更新，需重新核对。

---

## 1. 访问凭证（access_token）

来源：[获取访问凭证](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html)

| 项 | 值 |
|---|---|
| URL | `https://api.bot.qq.com/app/getAppAccessToken` |
| Method | `POST` |
| Content-Type | `application/json` |

**请求体**：`{ appId, clientSecret }` —— 注意官方字段名是 **`clientSecret`**，
不是 `appSecret`。我们数据库里的 `app_secret` 列在发请求时必须映射成 `clientSecret`。

**成功响应**：`{ access_token, expires_in }`，`expires_in` 文档标注类型为 `number`，
单位**秒**，当前是 7200 秒以内的值。但**返回示例写的是字符串** `"7200"` ——
解析时必须同时接受数字与字符串。

**失败响应**：`{ code, message }`，且官方特别提醒：

> 该接口的业务错误通过响应体的 `code` 返回，**即使调用失败，HTTP 返回码仍为 `200`**。
> 请优先依据 `code` 判断请求是否成功，不要只依赖 HTTP 返回码。

**业务错误码**：

| code | message | 含义 |
|---|---|---|
| 100001 | Too many requests | 请求过于频繁 |
| 100007 | appid invalid | AppID 无效或机器人状态不正常（封禁/删除） |
| 100016 | invalid appid or secret | AppID 或 ClientSecret 不正确 |
| 10004 | 机器人不存在 | AppID 对应的机器人不存在 |

**有效期与刷新**（原文要点）：

- 生命周期默认 `7200` 秒（2 小时），开发者需自行刷新。
- **有效期内重复获取会返回相同的值**，每次请求不会刷新出新 token。
- **在接近过期时间 60 秒内获取时，会返回一个新 token，老 token 在这 60 秒内仍有效。**

→ 因此「按需取 + 缓存到 `expires_at - 安全余量`」是正确策略；由于重复请求返回同一个
token，偶尔多取一次也不会造成失效。安全余量取 60 秒对齐官方语义。

**调用其他接口时的请求头**：

| 名称 | 值 |
|---|---|
| `Authorization` | `QQBot ACCESS_TOKEN` |

（值与 token 之间是**一个空格**，前缀是 `QQBot`。）

---

## 2. REST 域名与路径

来源：上述凭证页的调用示例，以及 [发送群聊消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html) 示例。

- REST base：**`https://api.bot.qq.com`**
- 业务接口带版本前缀：如 `POST /v2/groups/{group_openid}/messages`
- 凭证接口**不带** `/v2`：`POST /app/getAppAccessToken`

> ⚠️ **WebSocket 的域名不等于 REST 域名。** 2026-09-26 用真实账号实测，
> `/gateway/bot` 返回的是 `wss://api.sgroup.qq.com/websocket`，而文档示例写的是
> `wss://api.bot.qq.com/websocket/`。**因此网关地址必须用接口返回值，绝不能硬编码**
> —— 实现里就是这么做的（`getGatewayUrl` 每次连接前重新取）。

> 沙箱环境：本次取证未拿到沙箱与正式环境域名差异的确切说明（见 §9）。目前实现只支持
> 正式环境 base，沙箱与否通过配置保留位置。

---

## 3. Gateway 接入点

来源：[获取带分片 WSS 接入点](https://bot.q.qq.com/wiki/develop/api-v2/openapi/wss/shard_url_get.html)

```
GET /gateway/bot
Content-Type: application/json
```

**返回**：

| 字段 | 类型 | 描述 |
|---|---|---|
| `url` | string | WebSocket 连接地址（示例：`wss://api.bot.qq.com/websocket/`） |
| `shards` | int | 建议的 shard 数 |
| `session_start_limit.total` | int | 每 24 小时可创建 Session 数 |
| `session_start_limit.remaining` | int | 目前还可创建的 Session 数 |
| `session_start_limit.reset_after` | int | 重置计数的剩余时间（ms） |
| `session_start_limit.max_concurrency` | int | 每 5 秒可创建的 Session 数 |

另有不带分片信息的 `GET /gateway`（来源：[获取通用 WSS 接入点](https://bot.q.qq.com/wiki/develop/api-v2/openapi/wss/url_get.html)）。
实现采用 `/gateway/bot`，因为顺便拿到分片数与连接额度。

### 3.1 真实账号实测到的值（2026-09-26，`scripts/qq-probe.mjs`）

| 项 | 文档示例 | 实测 |
|---|---|---|
| `url` | `wss://api.bot.qq.com/websocket/` | **`wss://api.sgroup.qq.com/websocket`** |
| `shards` | 9 / 1 | 1 |
| `session_start_limit.total` | 1000 | **1500** |
| `session_start_limit.remaining` | 999 | 1500 |
| `session_start_limit.max_concurrency` | 1 | 1 |
| Hello 的 `heartbeat_interval` | 45000 | **41250** |

**结论：这些值都是服务端下发的，文档示例只是示例。** 心跳周期必须用 Hello 给的值
（不是常量 45 秒），网关地址必须用接口返回值（不是常量域名）—— 两处实现都已照做，
测试也覆盖了「用 Hello 给的周期发心跳」。

---

## 4. WebSocket 协议

来源：[WebSocket 方式](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/websocket.html)、[通用数据结构](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/payload.html)

### 4.1 上行/下行信封

网关上下行共用一个结构：

```json
{ "id": "event_id", "op": 0, "d": {}, "s": 42, "t": "GATEWAY_EVENT_NAME" }
```

| 字段 | 说明 |
|---|---|
| `id` | 事件 id（**可作为发送接口的 `event_id`**） |
| `op` | opcode |
| `s` | 下行消息序列号；**心跳要携带客户端收到的最新的 `s`** |
| `t` | 事件类型，仅在 `op = 0` Dispatch 时有意义 |
| `d` | 事件内容，各事件不同 |

### 4.2 OpCode 全表

| CODE | 名称 | 方向 | 描述 |
|---|---|---|---|
| 0 | Dispatch | 服务端→客户端 | 服务端推送 |
| 1 | Heartbeat | 双向 | 心跳 |
| 2 | Identify | 客户端→服务端 | 鉴权 |
| 6 | Resume | 客户端→服务端 | 恢复连接 |
| 7 | **Reconnect** | 服务端→客户端 | **服务端通知客户端重新连接** |
| 9 | **Invalid Session** | 服务端→客户端 | identify / resume 参数有错时返回 |
| 10 | Hello | 服务端→客户端 | 建立连接后下发的第一条消息 |
| 11 | Heartbeat ACK | 双向 | 心跳成功 |

（12 / 13 是 webhook 模式专用，与 WebSocket 无关。）

### 4.3 Hello（op 10）

```json
{ "op": 10, "d": { "heartbeat_interval": 45000 } }
```

心跳周期单位 **毫秒**。

### 4.4 Identify（op 2）

```json
{
  "op": 2,
  "d": {
    "token": "QQBot {AccessToken}",
    "intents": 513,
    "shard": [0, 4],
    "properties": { "$os": "linux", "$browser": "my_library", "$device": "my_library" }
  }
}
```

| 字段 | 说明 |
|---|---|
| `token` | 格式为 `"QQBot {AccessToken}"` |
| `intents` | 需要接收的事件位掩码 |
| `shard` | 两元素数组 `[当前片, 总片数]`；**无需分片时用 `[0, 1]`** |
| `properties` | 目前**无实际作用**，可填可空 |

**鉴权成功后下发 READY**：

```json
{ "op": 0, "s": 1, "t": "READY",
  "d": { "version": 1, "session_id": "...", "user": { "id": "...", "username": "...", "bot": true }, "shard": [0, 0] } }
```

→ `session_id` 与 `d.user` 要留存：`session_id` 用于 Resume。

### 4.5 Heartbeat（op 1）

```json
{ "op": 1, "d": 251 }
```

`d` 是**客户端收到的最新消息的 `s`**；**首次连接时为 `null`**。成功收到 `{ "op": 11 }`。

### 4.6 Resume（op 6）

```json
{ "op": 6, "d": { "token": "my_token", "session_id": "session_id_i_stored", "seq": 1337 } }
```

- 断线重连 gateway 后**不需要**重新 Identify，发 Resume 即可。
- `seq` 是处理事件时记录的 `s`，网关会**补发该 seq 之后遗漏的事件**。
- 补发完成后下发 `{ "op": 0, "s": 2002, "t": "RESUMED", "d": "" }`。

### 4.7 分片

- `shard_id = (guild_id >> 22) % num_shards`（按频道 id 哈希，同一频道固定落在同一连接）。
- 每个机器人**创建的连接数不能超过 `session_start_limit.remaining`**。

> 我们是 QQ 群/单聊场景，不分片，用 `[0, 1]`。

### 4.8 关闭码（close code）与重试策略

**这是官方给出的重连依据**（不是靠 op 7/9 判断）：

| 值 | 含义 | 可 Resume？ | 可 Identify？ |
|---|---|---|---|
| 4001 | 无效的 opcode | 否 | 否 |
| 4002 | 无效的 payload | 否 | 否 |
| 4006 | 无效的 session id，无法继续 resume | 否 | **是** |
| 4007 | seq 错误 | 否 | **是** |
| 4008 | 发送 payload 过快 | **是** | **是** |
| 4009 | 连接过期 | **是** | **是** |
| 4010 | 无效的 shard | 否 | 否 |
| 4011 | 连接需要处理的 guild 过多 | 否 | 否 |
| 4012 | 无效的 version | 否 | 否 |
| 4013 | 无效的 intent | 否 | 否 |
| 4014 | **intent 无权限** | 否 | 否 |
| 4900~4913 | 内部错误 | 否 | **是** |
| 4914 | 机器人已下架，只允许连沙箱环境 | 否 | 否 |
| 4915 | 机器人已封禁 | 否 | 否 |

文档给出的简单处理逻辑（原文）：

- `4009` 可以重新发起 resume
- `4914`、`4915` 不可以连接
- 其他错误，请重新发起 identify

---

## 5. Intents

来源：[通用数据结构 §事件订阅 Intents](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/payload.html)

**与我们相关的**：

```
GROUP_AND_C2C_EVENT (1 << 25)
  - C2C_MESSAGE_CREATE      // 用户单聊发消息给机器人时候
  - FRIEND_ADD / FRIEND_DEL
  - C2C_MSG_REJECT / C2C_MSG_RECEIVE
  - GROUP_AT_MESSAGE_CREATE // 用户在群里@机器人时收到的消息
  - GROUP_ADD_ROBOT / GROUP_DEL_ROBOT
  - GROUP_MSG_REJECT / GROUP_MSG_RECEIVE
```

其他位值（备查）：`GUILDS (1<<0)`、`GUILD_MEMBERS (1<<1)`、`GUILD_MESSAGES (1<<9)`、
`GUILD_MESSAGE_REACTIONS (1<<10)`、`DIRECT_MESSAGE (1<<12)`、`INTERACTION (1<<26)`、
`MESSAGE_AUDIT (1<<27)`、`FORUMS_EVENT (1<<28)`、`AUDIO_ACTION (1<<29)`、
`PUBLIC_GUILD_MESSAGES (1<<30)`。

### 5.1 全量群消息的事件类型（**已实测**）

> ✅ **2026-09-26 实测结论：开启全量模式后，@ 消息也以 `GROUP_MESSAGE_CREATE` 到达。**
>
> 实验：开启全量模式后监听 60 秒，期间发 5 条消息，其中两条是 `@笙澜`。
> 结果 **5 条全部是 `GROUP_MESSAGE_CREATE`**，一条 `GROUP_AT_MESSAGE_CREATE` 都没有。
>
> 因此 `GROUP_AT_MESSAGE_CREATE` 不是「@ 消息的类型」，而是
> **「全量模式关闭时才会出现的事件类型」**：
>
> | 模式 | @ 消息 | 非 @ 群消息 |
> |---|---|---|
> | 全量关闭 | `GROUP_AT_MESSAGE_CREATE` | 收不到 |
> | **全量开启** | **`GROUP_MESSAGE_CREATE`** | `GROUP_MESSAGE_CREATE` |
>
> **实现含义**：判定「这条消息有没有指向机器人」**不能看事件类型**，
> 开启全量后只能看载荷里的 `mentions` 是否含机器人 id
> （实现见 `src/services/qq/events.ts` 的 `addressedToBot`）。
>
> ⚠️ **但仍有一个未验证的高风险假设**：上面这个实验只打出了事件名，
> 没有打印载荷，所以**「@ 消息的 `GROUP_MESSAGE_CREATE` 一定带 `mentions`」尚未验证**。
> 若官方不填这个字段，`mentions` 判定会全面失效 —— 机器人要么对每条群消息都插嘴、
> 要么永远沉默，**两种情况都不会报错**（最危险的一类 bug：行为不对但无错误信号）。
>
> 验证方法：`node scripts/qq-probe.mjs --listen 60 --dump`，
> 看 `本项目解析：… 指向机器人=是 ✅` 是否对 @ 消息成立。

原始文档记载（保留备查，注意与实测冲突）：

| 来源 | 关于全量群消息 intent 的说法 |
|---|---|
| [群消息（全量模式）事件页](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_message_create.html) | `GROUP_MESSAGE_CREATE` 的 Intent 是 `GROUP_AND_C2C_EVENT (1<<25)` |
| [通用数据结构 intents 列表](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/payload.html) | `1<<25` 下**只列了 `GROUP_AT_MESSAGE_CREATE`，没有 `GROUP_MESSAGE_CREATE`** |

两处对不上。实现上按**事件页**的说法：订阅 `1<<25`，并额外留意是否还需要其它位。
这只能靠真实账号 + 已开启「接收所有消息」的群来确认。

### 5.2 intents 权限（会导致**直接断连**）

文档原文：

> 除了 `GUILDS`，`PUBLIC_GUILD_MESSAGES`，`GUILD_MEMBERS` 事件是基础的事件，默认有权限订阅之外，
> 其他的特殊事件，**都需要经过申请才能够使用**，如果在鉴权的时候传递了无权限的 `intents`，
> `websocket` 会报错，并**直接关闭连接**。

> 如果拥有的某个特殊事件类型的权限被取消，则在当前连接上不会报错，但是将不会收到对应的事件类型，
> 如果重新连接，则报错。

`GROUP_AND_C2C_EVENT (1<<25)` **不在**基础事件列表里，即可能需要申请。

> ✅ **2026-09-26 实测：`1<<25` 有权限，无需额外申请。**
> 用真实账号以 `intents = 33554432` 发 Identify，网关直接返回 READY
> （机器人「笙澜」鉴权成功）。所以这一条**不构成阻塞**。
>
> 两处官方文档关于「全量群消息属于哪个 intent」的矛盾仍未解（§5.1），
> 但那是**事件归属**问题，不是**权限**问题——权限这关已经过了。

**实现含义**（仍然照做，因为其它 intents 位值或将来权限变更都可能触发）：
1. 订阅的 intents 必须可配置（我们已有 `qq_config.intents`）。
2. 收到 close code `4013` / `4014` 时，必须给出**明确可操作**的提示
   （「intents 无权限，请到开放平台申请」），而不是笼统的「连接失败」。
3. 因为无权限会立刻断连，客户端**不能无限重连**打转 —— 应识别为**不可重试**并停止。

---

## 6. 发送群聊消息

来源：[发送群聊消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html)

| 项 | 值 |
|---|---|
| HTTP URL | `POST /v2/groups/{group_openid}/messages` |
| 接口频率限制 | **100 QPS** |

**时效与频控（原文）**：

- 被动消息有效时间 **5 分钟**，每个消息最多回复 **5 次**
- 主动消息频控：Bot 维度企业/个人认证 **60/qpm**、未认证 **30/qpm**；
  单关系维度（接收方）**20/qpm**，每个群 1 天最多接收 **1000** 条

**请求体**：

| 名称 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `msg_type` | integer | 否 | `0`=纯文本(`content`) `2`=Markdown(`markdown`) `7`=富媒体(`media`) |
| `content` | string | 否 | 文本内容。**传了 markdown 后此字段必须为空** |
| `markdown` | object | 否 | `msg_type=2` 时必填；填了它 `content`/`ark` 必须全空 |
| `keyboard` | object | 否 | 内嵌键盘 |
| `msg_id` | string | 否 | **被动回复**的消息 ID，取自事件的 `d.id`，**5 分钟内有效** |
| `event_id` | string | 否 | 被动回复的事件 ID，取自**事件最外层的 `id`**；与 `msg_id` 二选一 |
| `msg_seq` | integer | 否 | 回复序号，与 `msg_id` 联合使用；**不填默认 1**；**相同 `msg_id` + `msg_seq` 重复发送会失败** |
| `media` | object | 否 | `msg_type=7` 时填 `{ file_info }` |
| `message_reference` | object | 否 | 引用回复，`{ message_id }` |

**响应**：`{ id, timestamp, ext_info: { ref_idx } }`

### 6.1 对我们的两个直接结论

1. **多段回复必须用递增的 `msg_seq`**。我们把长回复切成多段发送，若都用默认 `1`，
   第二段就会命中 `40054005 消息被去重`。因此第 i 段用 `msg_seq = i + 1`（从 1 开始）。
2. **`content` 与 `markdown` 不能同时传**。我们发纯文本（`msg_type=0` + `content`），
   所以绝不能带 `markdown` 字段 —— 这也印证了「Markdown 必须转纯文本」的必要性。

### 6.2 错误码（择要）

| 错误码 | 描述 | 实现含义 |
|---|---|---|
| `304103` / `40034005` | 消息 ID 已过期 / 回复 msg_id 已过期 | 被动回复窗口过了 → **不可重试**，丢弃并记日志 |
| `40034024` | msg_id 无效或越权 | 不可重试 |
| `40034100` | 主动消息发送超过频控限制 | 可等待后重试 |
| `40034128` | 被动回复时间或次数超限 | 不可重试 |
| `40054005` | 消息被去重 | msg_seq 冲突 → 递增后重试 |
| `40054007` | 消息长度超限 | 需缩短（我们的切分上限应留足余量） |
| `40054010` | **不允许发送 URL** | ⚠️ 见下 |
| `40054002` | 机器人被禁言 | 不可重试（等解禁） |
| `40034101` / `40054003` | 机器人非群成员 | 不可重试 |
| `40034006` | 消息内容违规 | 不可重试 |
| `40054016` | 机器人已下线 | 不可重试 |
| `50055001` | 消息发送异常，请稍后重试 | 可重试 |
| `50055006` | ARK 消息发送异常，请稍后重试 | 可重试 |

### ⚠️ 6.3 `40054010 不允许发送URL` 与我们的纯文本转换冲突

`src/services/qq/plain-text.ts` 把 `[文字](url)` 转成 `文字 (url)`，**保留了 URL**。
若该错误码在我们场景下确实生效，则带 URL 的回复会被**整个拒绝发送**。

处理方式（待真实账号确认后定）：

- 短期：把 `40054010` 归类为**不可重试的发送失败**，并在界面上给出可读原因。
- 可选：加一个「发送前去掉 URL」的开关（纯文本转换已有实现，加参数即可）。
- 不建议默认删 URL —— 用户可能确实想发链接；先如实报错比静默丢内容好。

---

## 7. 单聊（C2C）

来源：[消息收发概述](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html) 与群事件页的 `User` schema。

- 发送：`POST /v2/users/{openid}/messages`（与群发送同构；本次未逐字段取证）

  > 群事件页的 `User` schema 注明：`user_openid` = 用户 OpenID（**单聊场景使用**），
  > `member_openid` = 群成员 OpenID（**群聊场景使用**）。因此单聊来源标识取
  > `author.user_openid`，群聊取 `author.member_openid`。
- 被动消息有效期 **60 分钟**，每条消息最多回复 **4 次**（群聊是 5 分钟 / 5 次）。

---

## 8. 事件字段

来源：[群消息（全量模式）](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_message_create.html)

`d` 的字段：

| 字段 | 说明 |
|---|---|
| `id` | 消息 ID，**可用于被动回复与撤回** |
| `author` | `User` 对象 |
| `content` | 消息文本（已去除 @ 机器人的前缀） |
| `group_openid` | 群 OpenID |
| `timestamp` | RFC3339 |
| `message_type` | integer：`0`=普通文本 `3`=结构化卡片 `101`=并行消息 `102`=聊天记录 `103`=引用消息 |
| `message_scene` | `{ source, ext[] }`，`ext` 形如 `["msg_idx=...","auth_token=...","ref_msg_idx=..."]` |
| `attachments` | `[]{ url, filename, width, height, size, content_type, voice_wav_url, asr_refer_text }` |
| `mentions` | `[]User` |
| `ark_data` | `{ prompt, ark_type, ark_name, fields }` |
| `msg_elements` | `[]MsgElement`（`message_type=103` 的递归结构：`msg_idx, author, message_type, content, attachments, ark_data, msg_elements`） |

`User` 对象：`id`、`username`、`bot`、`union_openid`、`union_user_account`、
`user_openid`（单聊用）、`member_openid`（群聊用）、`member_role`（`member`/`admin`/`owner`）。

`attachments[].content_type` 取值：`voice`、`image/jpeg`、`image/png`、`image/gif`、
`video/mp4`、`file`。

**事件名**（`t` 字段）：
- `GROUP_MESSAGE_CREATE` —— 全量群消息（需机器人开启「接收所有消息」）
- `GROUP_AT_MESSAGE_CREATE` —— 群里 @ 机器人
- `C2C_MESSAGE_CREATE` —— 单聊

---

## 9. 不确定与坑（**必须真实账号验证，不要当成事实**）

1. **`GROUP_MESSAGE_CREATE` 是否带 `mentions`** —— 全量模式下判定「有没有 @ 机器人」
   的唯一依据（见 §5.1）。**这是目前最高风险的一项**：假设不成立会让机器人
   对每条群消息都插嘴或永远沉默，且**不产生任何错误信号**。
   用 `node scripts/qq-probe.mjs --listen 60 --dump` 验证：@ 消息应显示「指向机器人=是 ✅」。
2. ~~**全量群消息的事件类型是哪个**~~ —— ✅ 已实测：全量开启后 @ 消息也走
   `GROUP_MESSAGE_CREATE`，`GROUP_AT_MESSAGE_CREATE` 只在全量关闭时出现（§5.1）。
3. ~~**`GROUP_AND_C2C_EVENT (1<<25)` 是否需要申请**~~ —— ✅ 实测**不需要**，已解。
3. **沙箱环境的域名** —— 本次未取证到沙箱 REST / WSS 域名差异。配置里有 `sandbox` 字段但
   目前未参与 URL 选择。
4. **单聊发送接口的字段细节** —— 未逐字段取证，按与群发送同构实现。
5. **`C2C_MESSAGE_CREATE` 事件 `d` 的字段名** —— 未直接取证；按群事件同构 + `User` schema
   推断用 `author.user_openid`。**首版实现应对缺失字段做容错而不是崩溃。**
6. **`40054010 不允许发送URL` 的适用条件** —— 不确定是所有场景禁用 URL，还是特定消息类型。
7. **`msg_seq` 的上限与耗尽行为** —— 文档说同 `msg_id` 最多回复 5 次（群），
   所以 `msg_seq` 实际有效范围是 1..5；我们在切分前就应把段数限制在上限内，
   超出部分**不发**并记录（而不是发出去被拒）。
8. **心跳超时判定** —— 文档未给出「多久没收到心跳 ACK 视为断线」。实现采用保守办法：
   按 `heartbeat_interval` 定时发送，若连续 N 次未收到 ACK 则主动重连。

---

## 10. 参考来源汇总

- [获取访问凭证](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html)
- [通用数据结构（op 码 / intents）](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/payload.html)
- [WebSocket 方式（Hello/Identify/Resume/关闭码）](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/websocket.html)
- [获取带分片 WSS 接入点](https://bot.q.qq.com/wiki/develop/api-v2/openapi/wss/shard_url_get.html)
- [消息收发概述（时效与频控）](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html)
- [发送群聊消息（请求体与错误码）](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html)
- [群消息（全量模式）（事件字段）](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_message_create.html)

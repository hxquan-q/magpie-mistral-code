# Mistral Vibe Code for magpie / OpenCode

> 把你的 **Mistral Vibe Code 订阅**接进 [magpie](https://github.com/yetone/magpie) 与 OpenCode，让 Claude Code、Codex、OpenCode 等 agent 使用套餐内的月度 Vibe Code 额度。

非官方插件，与 Mistral AI 无隶属关系。Provider id：`mistral-vibe`。

---

## 为什么需要它

Vibe Code 会先使用套餐包含的月度额度。每个组织的额度和超额付费设置由 Mistral 管理，实际扣账可在 Mistral 的用量页面核对。 [Mistral 订阅说明](https://docs.mistral.ai/admin/billing-usage/subscriptions)

## 安装

```powershell
magpie plugin add github:hxquan-q/magpie-mistral-code
magpie plugin login mistral-vibe          # 浏览器登录；窗口别关，链接出现后立刻点
```

装完在 agent 里挑 `mistral-vibe/<模型>` 即可。

## 登录与套餐确认

- **浏览器登录。** 在 Magpie 添加账号时选 `Sign in with Mistral (browser)`。打开链接后，用你的 Mistral 订阅账号登录。链接有效期为 10 分钟。
- **手动输入 Vibe CLI Key。** 到 Mistral 控制台的 `Code > Vibe CLI` 创建 Key，再在 Magpie 选 `Vibe Code API key` 粘贴。 [Vibe CLI 登录与 Key](https://docs.mistral.ai/vibe/code/cli/api-keys-profiles)

在 Magpie 的额度页刷新后，`whoami` 确认为 `CHAT / INDIVIDUAL` 的账号会显示 **Mistral Pro**。识别到 Studio API Key 时，额度卡会提示到哪里创建 Vibe CLI Key。显示 `Plan not confirmed` 时，可稍后刷新核对。

## 额度展示

额度卡以 Mistral 返回的额度和重置时间为准。在 Magpie 的额度页可以切换已用和剩余显示。`Pay as you go` 显示 Mistral 的超额付费设置。Magpie 依据已确认账号的月度额度做路由限额判定。只想用套餐内额度时，可以到 Mistral 订阅页确认 PAYG 已关闭。

`Budget unavailable` 表示本次未拿到可用的额度读数。`No monthly budget` 表示 Mistral 返回的月度额度为零。已有额度用完时会显示已用 100% 或剩余 0%，重置时间可用于确认何时恢复。身份未确认时，组织额度作为参考显示。有独立平台额度时，`Platform API credits` 也可供参考。

命令行核对：

```powershell
magpie quota mistral-vibe --json
```

对应上游端点：

| 用途 | 端点 |
| --- | --- |
| 套餐名 / PAYG 状态 | `GET api.mistral.ai/v1/billing/subscription` |
| 两本预算与重置时间 | `GET api.mistral.ai/v1/billing/budget` |
| 账号身份与权益 | `GET console.mistral.ai/api/vibe/whoami` |

## 模型

模型表来自 `GET /v1/models`（共 62 个，含 Codestral / Mistral / Ministral / GLM / DeepSeek 系列），上下文长度取接口的 `max_context_length`，名称与输出上限优先取 models.dev，价格用插件内置的官方定价表做估算。TTS、OCR、embedding 这类不产出文本的模型不会进入聊天模型列表。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `MISTRAL_VIBE_API_BASE` | 覆盖 LLM 基址（默认 `https://api.mistral.ai/v1`） |
| `MISTRAL_VIBE_CONSOLE_API` | 覆盖 console API 基址（默认 `https://console.mistral.ai/api`） |
| `MISTRAL_VIBE_UA` | 覆盖出站 User-Agent（默认 `mistral-client-python/Mistral-Vibe/3.1.3`） |

## 请求适配（为什么能直连）

agent 回传历史时会带 `reasoning_content` / `reasoning` / `reasoning_details`，而 Mistral 对未知字段返回 `422 Extra inputs are not permitted`。插件把这些思考内容改写成 Mistral 的 typed content part（thinking 块）放到该轮文本之前，因此带思考轮的会话不会中断。

出站请求的 `User-Agent` 与官方客户端一致：`mistral-client-python/Mistral-Vibe/3.1.3`（对应 Vibe Desktop 1.2.0 内置的 `mistral_vibe-3.1.3`）。

## 排错

| 现象 | 处理 |
| --- | --- |
| `sign-in could not start (429)` | 登录发起端点有频率限制，停 15–30 分钟后**只试一次**，不要连点 |
| `ECONNRESET: The socket connection was closed unexpectedly` | 连接池里的旧 keep-alive 套接字被 Cloudflare 关掉了。插件已自动换连接重试（发起/轮询/交换各 3 次，轮询与交换在链接 10 分钟有效期内对 429、5xx、断网继续退避重试），无需手动处理；若仍出现，重跑 `magpie plugin login mistral-vibe` 即可 |
| `context deadline exceeded` / poll 429 | 链接 10 分钟内没点，重新 `magpie plugin login mistral-vibe` |
| `Budget unavailable` | 刷新额度页，或到 Mistral 用量页确认组织额度 |
| `Studio API key` | 用浏览器重新登录，或换成在 `Code > Vibe CLI` 创建的 Key |
| 模型列表为空 | 未登录成功；先 `magpie plugin list --json` 看 `signedIn` |

## 关于风控

个人自用（单账号、单 key、交互式使用）在应用层与官方 CLI 一致：端点、鉴权方式、请求体语义、模型 id、User-Agent 全部对齐。建议避免：

- 高并发/批量化调用（套餐有 fair-use 条款，先兆通常是限速而非封禁）
- 在同一订阅上轮换多个 key（会被看作 key farming）
- 频繁重复登录（登录端点有频率统计）

## 致谢

本 fork 增加了套餐身份确认、额度与 PAYG 状态展示、客户端 UA 对齐，以及失效 keep-alive 连接的重试。 [上游仓库](https://github.com/songlairui/magpie-mistral-code)

## License

MIT，见 [LICENSE](LICENSE)。Mistral、Vibe 等名称与商标归 Mistral AI 所有。

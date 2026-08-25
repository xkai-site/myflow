# pi-codex-official

在 Pi 中复用 CC Switch 当前生效的 OpenAI Codex（ChatGPT OAuth）账号。

扩展逐次读取 Codex live auth：

```text
~/.codex/auth.json
```

CC Switch 切换 OpenAI Official 账号并完成 live 配置投影后，Pi 的下一次请求会直接使用新账号，无需再次执行 `/login`，也无需重启 Pi。

扩展使用 Pi 内置的 `openai-codex-responses` API 访问 ChatGPT Codex 后端。本项目不保存 token、不实现独立 OAuth 登录，也不刷新或回写 CC Switch 凭据。

## 前置条件

- 已安装 Pi 和 CC Switch。
- 已在 CC Switch 中配置并选中 OpenAI Official / ChatGPT OAuth 账号。
- `~/.codex/auth.json` 是有效的 ChatGPT 登录，包含 `access_token`、`refresh_token` 和 `account_id`。
- 网络能够访问 `chatgpt.com`。

如果设置了 `CODEX_HOME`，扩展读取 `$CODEX_HOME/auth.json`，否则读取 `~/.codex/auth.json`。

## 安装

如果曾安装同名 npm 包，先移除，避免重复注册 provider：

```bash
pi remove npm:pi-codex-official
```

在扩展目录的上一级执行：

```bash
pi install ./pi-codex-official
```

确认安装结果：

```bash
pi list
```

修改扩展或模型配置后，重启 Pi，或在已有 Pi 会话中执行：

```text
/reload
```

## 首次使用

首次安装后，在 Pi 中执行 `/login`，选择：

```text
OpenAI Codex (CC Switch 当前账号)
```

这一步只为 Pi 建立 OAuth provider 缓存，使模型可被选择。实际请求 token 仍会逐次从 Codex live auth 读取。

然后选择 `openai-codex` provider 下的模型。

## 两个 auth.json 的职责

| 文件 | 职责 | 是否决定实际请求账号 |
| --- | --- | --- |
| `~/.codex/auth.json` | CC Switch/Codex 当前生效的 live 登录 | 是 |
| `~/.pi/agent/auth.json` | 标记 `openai-codex` 已登录，并保存 Pi 的 OAuth 缓存 | 否 |

Pi 的缓存并非无效：缺少对应的 `openai-codex` OAuth 项时，Pi 可能认为 provider 尚未登录，因此首次使用仍需执行 `/login`。但是，缓存中的 `access`、`refresh` 和 `accountId` 不决定实际请求账号。

一次请求的认证流程是：

```text
Pi 确认 openai-codex 已登录
  -> 扩展执行 getApiKey()
  -> 重新读取 ~/.codex/auth.json
  -> 校验 live 凭据
  -> 使用 live access token 发起请求
```

## 多账号切换

1. 在 CC Switch 中切换到另一个 OpenAI Official 账号。
2. 等待 CC Switch 完成切换。
3. 直接在当前 Pi 会话中发送下一条请求。

扩展的 OAuth 凭据解析每次请求都会重新读取 live auth，因此：

- CC Switch 更新 `~/.codex/auth.json` 后，Pi 下一次请求立即使用新账号。
- 不需要执行 `/login`、`/reload` 或重启 Pi。
- 已经发出的请求不会中途切换账号。
- `~/.pi/agent/auth.json` 可能仍显示旧账号，这是正常的，不影响实际请求。

CC Switch 切换账号不会使 Pi 缓存文件立即同步。Pi 缓存通常只会在以下情况更新：

- 重新执行 `/login`。
- Pi 缓存临近过期并调用扩展的 `refreshToken()`；扩展会从 live auth 重新读取凭据。

因此可能暂时出现：

```text
~/.pi/agent/auth.json 显示账号 A
~/.codex/auth.json 是账号 B
Pi 实际请求使用账号 B
```

如果需要让 Pi 缓存中显示的账号也立即变为 B，可以重新执行一次 `/login`，但这不是实际请求切换的必要步骤。

如果 CC Switch 只切换了 provider 配置但没有更新 `~/.codex/auth.json`，Pi 也不会切换账号。此时应先在 CC Switch/Codex 中修复 live 登录状态。

## 凭据与刷新策略

扩展是只读凭据消费者：

- 读取 `~/.codex/auth.json` 或 `$CODEX_HOME/auth.json`。
- 校验 `auth_mode == "chatgpt"`。
- 校验 `tokens.account_id` 与 access token 的 `chatgpt_account_id` 一致。
- 校验 access token 至少还有 60 秒有效期。
- 不读取 `~/.cc-switch/codex_oauth_auth.json`。
- 不调用 OpenAI refresh token 端点。
- 不修改 Codex live auth、CC Switch 数据库或托管 OAuth 文件。

refresh token 轮换由 CC Switch 或 Codex 负责。这样可避免 Pi、CC Switch 和 Codex 同时刷新同一个一次性 refresh token，导致多份存储相互覆盖或出现 `refresh_token_reused`。

## Token 过期处理

如果 Pi 提示 access token 已过期或将在 60 秒内过期：

1. 在 CC Switch 中重新选择或刷新当前 OpenAI Official 账号，或者让 Codex 完成一次官方登录刷新。
2. 确认 `~/.codex/auth.json` 已更新。
3. 直接重试 Pi 请求。

通常不需要执行 Pi `/login`。只有首次建立 provider 缓存，或需要同步更新 Pi 中显示的缓存账号时，才需要重新执行 `/login`。

## 模型配置

模型清单位于：

```text
config/models.json
```

字段说明参见 [`config/README.md`](config/README.md)。修改后执行 `/reload`。

## 测试

```bash
npm test
```

测试使用临时构造的 auth 文件和 JWT，不读取真实用户凭据。

## 安全说明

以下内容不会存入本项目：

- access token
- refresh token
- CC Switch 账号数据
- Pi OAuth 缓存

扩展错误信息不会输出 token。`~/.codex/auth.json` 与 `~/.pi/agent/auth.json` 都包含敏感凭据，不要提交、复制或分享其内容。

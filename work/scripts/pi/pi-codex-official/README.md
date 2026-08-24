# pi-codex-official

在 Pi 中复用 cc-switch 已登录的 OpenAI Codex（ChatGPT OAuth）账号。

扩展从 cc-switch 获取 OAuth `refresh_token`，通过 OpenAI 官方 OAuth 端点取得 `access_token`，并使用 Pi 内置的 `openai-codex-responses` API 访问 ChatGPT Codex 后端。本项目不保存任何用户 token，也不实现独立的 OAuth 登录体系。

## 前置条件

- 已安装 Pi 和 cc-switch。
- 已在 cc-switch 中完成 Codex / OpenAI Official 登录。
- cc-switch 已设置当前默认 Codex 账号，即以下文件中存在有效的 `default_account_id`：

  ```text
  ~/.cc-switch/codex_oauth_auth.json
  ```

- 网络能够访问 `auth.openai.com` 和 `chatgpt.com`。

## 安装

如果曾安装同名 npm 包，先移除，避免重复注册 provider：

```bash
pi remove npm:pi-codex-official
```

安装当前本地目录：

```bash
pi install D:/XuKai/Project/myflow/work/scripts/pi/pi-codex-official
```

确认安装结果：

```bash
pi list
```

修改扩展或模型配置后，重启 Pi，或在已有 Pi 会话中执行：

```text
/reload
```

## 使用

在 Pi 中执行 `/login`，选择：

```text
OpenAI Codex (ChatGPT 账号, cc-switch 令牌)
```

然后选择 `openai-codex` provider 下的模型即可。

## 凭据策略

扩展使用两级凭据来源：

1. `~/.pi/agent/auth.json` 是一级缓存。access token 到期后，优先使用其中的 refresh token。
2. 只有 Pi 缓存的 refresh token 被 OpenAI 明确认定失效时，才读取 cc-switch 当前 `default_account_id` 对应账号的 refresh token。

刷新成功后，扩展会：

- 将最新凭据返回给 Pi，更新其缓存。
- 使用旧 token 作为比较条件，将轮换后的 refresh token 原子回写到 cc-switch 对应账号。
- 如果发现 cc-switch 已写入另一代 token，则不会覆盖，并输出警告。

扩展不会：

- 遍历或尝试 cc-switch 中的其他账号。
- 从 `cc-switch.db` 搜索备用 token。
- 因网络错误、超时、429 或 5xx 响应而切换到其他 token。

## 多账号与切换

cc-switch 有多个 Codex 账号时，扩展只将 `default_account_id` 视为当前账号。

Pi 已缓存的 access token 在过期前仍属于原账号。因此，在 cc-switch 切换默认账号后，如果希望 Pi 立即切换，请在 Pi 中重新执行 `/login`。

## 并发限制

OpenAI refresh token 可能在刷新后轮换并使旧 token 失效。Pi 与 cc-switch 同时刷新同一账号时，仍可能发生跨进程竞争。

扩展通过条件回写和失效恢复降低冲突风险，但无法让 cc-switch 参与同一把跨进程锁。建议避免两端在同一时间刷新同一个账号。

## 模型配置

模型清单位于：

```text
config/models.json
```

字段说明参见 [`config/README.md`](config/README.md)。修改后执行 `/reload`。

## 安全说明

以下内容不会存入本项目：

- access token
- refresh token
- cc-switch 账号数据
- Pi 的 OAuth 缓存

OAuth 凭据仅存在于用户目录：

```text
~/.cc-switch/codex_oauth_auth.json
~/.pi/agent/auth.json
```

`CLIENT_ID` 是公开的 OAuth 应用标识，不是用户密码或私有凭据。

## 常见问题

### cc-switch 尚未设置默认账号

确认 cc-switch 已登录 Codex 账号并选中默认账号，然后重新执行 Pi `/login`。

### refresh token 同步警告

通常表示 cc-switch 与 Pi 同时刷新，或者 cc-switch 文件在刷新过程中发生了变化。扩展不会覆盖检测到的更新凭据；必要时在 cc-switch 中确认当前账号状态，再重新执行 Pi `/login`。

### 模型配置加载失败

检查 `config/models.json` 是否为有效 JSON，并确认模型 ID 不重复、窗口参数为正数。扩展加载时会校验主要字段和类型。

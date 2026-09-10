# pi-codex-official

在 Pi 中只读复用 Codex 的 ChatGPT OAuth 登录和模型缓存，注册 **`openai-codex` provider**。

- **不是生成工具**：没有注册 LLM 工具，Agent 不能直接 tool call 本插件；也没有插件专属斜杠命令或参数解析器。
- `/login`、`/model`、`/thinking`、`/reload` 都是 **Pi 内置交互命令**，在 Pi 编辑器中输入，不是 shell 命令。
- 选中模型后，普通提示词由 Pi 经内置 `openai-codex-responses` 协议直接发送到 `https://chatgpt.com/backend-api`，不是 Codex CLI 代发。
- 插件不启动 Codex、不发现线上模型、不刷新 token、不写回 Codex 文件，也不读取 CC Switch 数据库。CC Switch 不是必装依赖，使用它切账号也不会自动让请求经过其代理。

## 必要前提与配置

需要已安装的 Pi、可用的 Codex CLI，以及有权使用 Codex 的 ChatGPT 账号。实际模型权限、额度和传输兼容性以服务端为准；本地缓存存在不保证线上可用。

若尚未安装 Pi：

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

插件没有独立配置文件、API key 参数或手工模型清单。启动 Pi 前确认以下输入：

| 输入 / 配置 | 要求与默认值 | 读取时机 |
| --- | --- | --- |
| `CODEX_HOME` | Codex 目录；未设置或全空白时为 `~/.codex`，Windows 默认 `%USERPROFILE%\.codex` | 加载时确定凭据路径 |
| `auth.json` | 位于 Codex 目录；必须是 ChatGPT OAuth 登录，不接受 API key 登录 | 每次认证解析 / 请求重新读取 |
| `models_cache.json` | 与上述 auth 同目录；有效且至少有一个可见、API 可用模型 | 启动或 `/reload` |
| `PI_CODING_AGENT_DIR` | Pi 配置目录，默认 `~/.pi/agent`；不改变 Codex 目录 | 由 Pi 管理 |
| 网络 | 请求时能访问 `https://chatgpt.com/backend-api` | 由 Pi 发请求 |

非空 `CODEX_HOME` 会去除首尾空白并解析为路径，建议使用绝对路径。Codex 和 Pi 必须使用同一个目录；改变环境变量后重新启动 Pi。

`auth.json` 必须满足：`auth_mode` 为 `chatgpt`，`tokens` 中有 `access_token`、`refresh_token`、`account_id`；access token 的 JWT 账号标识与 account ID 一致，有效期**超过 60 秒**。不要手写或分享这些字段。

## 首次调用

### 1. 让 Codex 准备登录和缓存

尚未登录时，在终端执行：

```bash
codex login
```

使用 ChatGPT 登录，而非 API key。然后在联网状态下启动 `codex`，让 Codex 加载模型信息，并确认 Codex 目录已生成 `auth.json` 和 `models_cache.json`；无需发送模型测试请求。

**仅登录成功不代表缓存已生成。** 缓存生成取决于所用 Codex 版本与运行状态；若未生成，请先在 Codex 侧排查。本插件不会补建缓存。若 CC Switch 已把有效登录写入同一 `auth.json`，无需重复登录。

### 2. 安装本地插件并启动 Pi

在仓库根目录执行：

```bash
pi install ./work/scripts/pi/pi-codex-official
pi list
pi
```

本地安装直接引用源目录，不复制文件，请保留该目录。若曾安装同名 npm 包，先执行 `pi remove npm:pi-codex-official`，避免重复注册。已运行的 Pi 安装后执行 `/reload`。

### 3. 在 Pi 中登录、选模型、发送提示词

在 Pi 编辑器输入 `/login`，选择：

```text
OpenAI Codex (Codex 本地凭据)
```

这一步不会开启新的 OAuth 授权，只校验 Codex 登录并让 Pi 建立自己的 OAuth 缓存。已有该 provider 的 OAuth 登录标记时，通常无需再次登录。

然后输入 `/model`，选择 `openai-codex` 下的可用模型；不要把登录显示名称当成模型 ID。最后在编辑器粘贴并按 Enter：

```text
请只回复“连接成功”，不要调用工具。
```

这会发起真实模型请求并消耗账号额度。回复出现在 Pi 对话区；插件不会创建独立生成文件或返回任务 ID。

## 调用入口、参数与结果

以下均为 Pi 的入口，插件本身没有工具参数 schema。

| 入口 | 输入 / 参数 | 作用 |
| --- | --- | --- |
| Pi 编辑器普通消息 | 提示词；图片仅在所选模型支持 `image` 时可用 | 使用当前模型生成回复 |
| `/login` | 在选择器中选“Codex 本地凭据” | 建立 Pi OAuth 登录缓存 |
| `/model` | 选择 `openai-codex` 的模型 | 切换当前模型；选择器中 Ctrl+S 保存启动默认值 |
| `/thinking` | 选择当前模型支持的推理等级 | 切换推理等级；插件不改默认值 |
| `/reload` | 无 | 重读磁盘模型缓存，不刷新 Codex 登录或线上列表 |
| `pi --list-models openai-codex`（终端） | 搜索词 `openai-codex` | 列出可用模型；空列表也可能是未登录 |
| `/session` | 无 | 查看当前会话文件路径、token 用量和费用 |
| `/copy` | 无 | 复制最后一条助手回复 |

正常持久化会话由 Pi 自动保存在 `~/.pi/agent/sessions/` 下，按工作目录组织为 JSONL；以 `/session` 显示的实际路径为准。Pi 配置目录、会话目录覆盖或临时会话设置会影响落盘位置 / 是否保存。插件不改变回复、usage 或会话日志。

## 账号切换与模型更新

| 要做什么 | 最少操作 | 生效范围 |
| --- | --- | --- |
| 切换账号 | 用 Codex 或 CC Switch 更新当前 Codex `auth.json`，再发下一条请求 | 下一请求使用新账号；已发请求不变，无需 `/login` 或 `/reload` |
| token 过期 / 即将过期 | 在 Codex 更新登录，或用 CC Switch 刷新并写入该 auth 文件，再重试 | 插件只重读，不调用 refresh 端点、不轮换或回写 token |
| 更新模型列表 | 先让 Codex 更新 `models_cache.json`，再在 Pi `/reload` | 启动 / reload 才同步；切账号本身不更新列表 |
| 更新 Pi 内置模型元数据 | 升级 Pi 后重启 | 可能补齐新模型输出上限；不替代 Codex 更新缓存 |

**Codex auth 决定实际请求账号，Pi auth 只满足 OAuth 生命周期。** Pi 缓存仍显示旧账号不影响下一请求读取新账号；仅希望同步缓存显示时可重新 `/login`。CC Switch 若未更新 Codex auth，切换不会生效。

## 模型边界与失败恢复

模型列表只来自缓存的 `models` 数组：仅注册 `visibility == "list"` 且 `supported_in_api === true` 的条目，模型 ID 为 `slug`。输入能力、上下文和推理等级以缓存适配结果为准；不会把 Codex 提示词或专属工具模式注入 Pi。

输出上限优先采用 Pi 内置同 ID 元数据；缺失时用 **16384**，且不超过缓存上下文。它是注册元数据补值，**不是官方最大输出限制**。缓存没有账号归属校验或强制过期检查，同步磁盘内容不代表服务端最新列表。

| 现象 | 恢复方式 |
| --- | --- |
| 缓存缺失、损坏、候选字段无效 / ID 重复，或过滤后为空 | 按错误路径检查 `CODEX_HOME`，让 Codex 重建 / 更新缓存后 `/reload`；不手写替代模型清单 |
| 报缓存错误但仍看得到模型 | 可能是 Pi 内置同名 provider；先处理 `[pi-codex-official]` 错误，不要据此认为插件加载成功 |
| 缓存正常但模型不可选 / 未登录 | `/login` 选择“Codex 本地凭据”，再 `/model` |
| 登录模式不对、账号不一致或 token 有效期不足 | 在 Codex 侧修复登录，确认写入同一目录，再重试 |
| 切账号后模型无权限或新模型未出现 | 让 Codex 为当前账号更新缓存，再 `/reload` 并选可用模型；线上权限仍由服务端决定 |

缓存校验失败时不部分注册、不保留插件旧快照或使用备用列表；reload 会先撤销上轮覆盖。Pi 自带 provider 仍可能出现，且 `--list-models` 可能在 stderr 报错后仍以退出码 0 列出内置模型。只开 `/model`、重新 `/login` 或 `pi update --models` 都不能替代 Codex 更新缓存。

## 费用与凭据风险

- **Pi 显示 `$0` 只是插件四项价格全零的占位，不表示免费，也不表示未消耗订阅额度。** token 用量仍由 Pi 按上游响应记录。
- 如用 CC Switch 导入 Pi 会话估价，需自行配置扫描和模型价格表；本插件不提供价格同步。估算金额不是订阅额度的真实美元账单，价格缺失也可能显示零。
- 插件只读 Codex 凭据，但 **Pi 会把 OAuth 缓存写入自己的 `auth.json`**。两个 auth 文件都含敏感凭据，不要提交、复制或分享；排错也不要上传整份模型缓存或未经脱敏的日志。

接口依据：[入口](extensions/index.ts)、[凭据读取](extensions/codex-auth.ts)、[模型缓存适配](extensions/codex-models.ts)。

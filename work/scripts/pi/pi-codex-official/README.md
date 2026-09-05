# pi-codex-official

**在 Pi 中只读复用 Codex 已有的 ChatGPT OAuth 凭据，并自动读取 Codex 模型缓存。**

无需维护插件模型清单或价格表。插件不实现独立登录、不刷新凭据、不启动 Codex、不请求模型发现接口，也不读写 CC Switch 数据库。

## 职责边界

| 组件 | 负责什么 |
| --- | --- |
| Codex | 生成本地登录凭据与模型缓存，更新登录和模型信息 |
| 本插件 | 逐请求读取现有凭据；启动 / `/reload` 时将模型缓存适配为 Pi 注册信息 |
| Pi | 使用内置 `openai-codex-responses` 协议请求 ChatGPT Codex 后端，记录响应 token 用量与会话 |
| CC Switch（可选） | 管理账号、维护模型价格、导入会话并展示用量和估算费用 |

请求由 **Pi 直接发出**，不是由 Codex CLI 代发，也不因使用 CC Switch 管理的账号而自动经过 CC Switch 代理。

## 前置条件

- 已安装 Pi；本实现核验于 **Pi 0.85.1、Node.js 22.23.1**，模型缓存结构核验于 Codex CLI **0.153.4**。
- Codex 本地已有有效的 **ChatGPT OAuth** 登录，而非 API key 登录。
- 同一个 Codex 目录下存在有效的 `auth.json` 和 `models_cache.json`。
- 发起模型请求时，网络能够访问 `https://chatgpt.com/backend-api`。

CC Switch **不是必装依赖**。可使用 Codex 自己登录；也可通过 CC Switch 切换官方账号，前提是它已经把当前凭据写入 Codex 的 `auth.json`。

### 文件位置

| 文件 | 用途 | 读取时机 |
| --- | --- | --- |
| `$CODEX_HOME/auth.json` | 实际请求账号与 token | 每次认证解析 / 请求 |
| `$CODEX_HOME/models_cache.json` | 唯一模型列表来源 | 插件加载，包括启动及 `/reload` |
| `~/.pi/agent/auth.json` | Pi 的 OAuth 登录标记和缓存 | 由 Pi 管理 |

未设置 `CODEX_HOME` 或其值为空白时，前两个文件位于 `~/.codex/`（Windows 默认 `%USERPROFILE%\.codex\`）。非空 `CODEX_HOME` 去除首尾空白后解析为路径；建议使用绝对路径。Pi 自己的配置目录可由 `PI_CODING_AGENT_DIR` 改写，不影响 Codex 目录。

## 安装与首次使用

### 1. 准备 Codex 登录和模型缓存

如果尚未登录，先执行 `codex login`，选择 ChatGPT 账号登录。已有 Codex 登录或已由 CC Switch 写入有效凭据时，无需重复登录。

在联网状态下启动一次 `codex`，让它加载模型信息；确认上文所列 Codex 目录中已有 `auth.json` 和 `models_cache.json`。仅登录成功不代表模型缓存已经生成。无需向模型发送测试请求，也不要手写缓存。

### 2. 安装本插件

若曾安装同名 npm 包，先移除，避免重复注册：

```bash
pi remove npm:pi-codex-official
```

在本插件目录的上一级执行：

```bash
pi install ./pi-codex-official
pi list
```

本地目录安装直接引用源文件，请保留该目录。安装完成后启动 Pi；如果 Pi 已在运行，先执行 `/reload`。以后修改插件也无需重新安装。

### 3. 在 Pi 中启用并选择模型

首次在 Pi 中执行 `/login`，选择：

```text
OpenAI Codex (Codex 本地凭据)
```

这一步**不会打开新的 OAuth 登录流程**，只校验并复用 Codex 现有登录，让 Pi 建立 provider 登录缓存。然后执行 `/model`，选择 `openai-codex` 下的模型。

可用以下命令查看模型：

```bash
pi --list-models openai-codex
```

模型可用性可能受 Pi 登录状态影响，空列表不一定表示缓存为空。插件保持 provider ID `openai-codex` 不变；已有用户不必因显示名称变化重新登录，也不会被修改默认模型或推理等级。

## 日常操作速查

| 想做什么 | 最少操作 |
| --- | --- |
| 切换请求账号 | 用 Codex / CC Switch 更新 Codex 登录，直接发送下一条请求 |
| 同步新增或移除的模型 | 先让 Codex 更新模型缓存，再在 Pi 中 `/reload` |
| 更换当前使用的模型 | 在 Pi 中 `/model` 选择；这不会刷新 Codex 缓存 |
| 使用修改后的插件代码 | `/reload`；无需重新安装或重新登录 |
| 升级 Pi 本体 | 升级后重启 Pi，加载新版运行时和内置模型元数据 |
| 查看估算费用 | 在 CC Switch 中查看；Pi 的零价格占位不会随之改变 |

## 模型自动同步

正常使用不需要编辑任何插件配置文件。旧的 `config/models.json` 已移除，不再读取。

```text
Codex 更新 models_cache.json
  → Pi 启动或 /reload
  → 读取并校验整份缓存
  → 注册缓存中可见且 API 可用的模型
```

### 同步规则

- 缓存根节点必须包含 `models` 数组。
- 仅注册 `visibility == "list"` 且 `supported_in_api === true` 的条目，保持缓存顺序。
- 使用 `slug` 作为模型 ID；显示名来自 `display_name`，缺失时使用 ID。
- 输入能力从 `input_modalities` 提取 Pi 支持的 `text` / `image`，不会猜测图像能力。
- 上下文取 `context_window`；不会自动扩大到 `max_context_window`，也不会再次应用 Codex 的有效上下文百分比。
- 推理等级按缓存映射到 Pi 支持的等级；`none` 对应 `off`，未支持的等级不开放。缓存只提供 low 而未提供 minimal 时保留 `minimal → low` 适配。未知等级如 `ultra` 不会被改写成 `max`。
- 缓存中的 Codex 提示词、专属工具模式等不会注入 Pi。

### 缓存没有提供的信息

Pi 注册要求提供输出上限和费用等字段，但 Codex 缓存并不提供完整元数据。插件仅做以下最小适配：

| 字段 | 适配方式 |
| --- | --- |
| 输出上限 `maxTokens` | 精确匹配 Pi 内置同 ID 模型的输出上限；Pi 尚未收录的新模型使用 **16384** 补值，并且不超过缓存上下文 |
| 可选工具协议能力 | 仅复用 Pi 内置同 ID 模型的 Grammar Tools、Additional Tools、Tool Search 标记；未知模型使用普通工具协议，不猜测可选优化能力 |
| 价格 `cost` | 固定四项全零，仅满足 Pi 注册要求；不继承 Pi 内置定价 |

**16384 是 Pi 所需元数据的保守补值，不是官方最大输出限制。** Pi 内置元数据只补充已在缓存中的模型，不会增加备用模型。升级 Pi 后应重启 Pi，加载新版内置元数据；新模型能否使用仍取决于账号权限与 Pi 的传输兼容性。

### 缓存过时或不可用

先通过 Codex 完成登录并让 Codex 在联网状态下更新模型缓存，再回到 Pi 执行 `/reload`。确保两者使用同一个 `CODEX_HOME`。

插件不刷新缓存、不按时间强制过期，也不判断缓存属于哪个账号。**同步的是磁盘上的最新内容，不保证它等于服务端最新列表。** 切换账号后如需重新发现可用模型，应先让 Codex 更新缓存。

仅打开 `/model`、重新执行 Pi `/login` 或运行 `pi update --models`，都不保证更新 Codex 缓存。插件没有监听、轮询或独立同步命令。

如果缓存缺失、不可读、损坏、候选模型字段无效/ID 重复，或过滤后没有模型：

- reload 前先清理本插件上一轮的动态注册；校验失败时明确报错，**不注册本插件 provider**，不部分注册，不使用旧快照或备用列表。
- 诊断包含缓存路径、错误原因与恢复建议，不打印原始缓存内容。
- 修复缓存后执行 `/reload`，无需重新安装。

**宿主边界：** Pi 自带的同名 `openai-codex` 仍可能可见，扩展错误也不一定令 Pi 退出。特别是 `--list-models`，可能输出错误到 stderr 后仍以退出码 0 列出内置模型。看到模型不代表本插件加载成功；应先处理 `[pi-codex-official]` 错误，再使用本插件。插件不会清空内置 provider 或拦截其认证行为。

## 账号切换与凭据刷新

两个 auth 文件的职责不同：

- **Codex `auth.json` 决定实际请求账号。** 插件要求 `auth_mode == "chatgpt"`，存在 access/refresh token 和 account ID，JWT 中的账号标识一致，且 access token 至少还有超过 60 秒有效期。
- **Pi `auth.json` 用于满足 OAuth 生命周期。** 首次缺少登录标记时需要 `/login`。其中缓存的旧 token / account ID 不决定本插件的实际请求账号。

```text
Pi 确认 provider 已登录
  → 插件重新读取 Codex auth.json
  → 校验当前凭据
  → Pi 使用当前 access token 发起请求
```

### 切换账号

1. 在 Codex 或 CC Switch 中切换官方账号。
2. 确认 Codex `auth.json` 已更新。
3. 直接发送下一条 Pi 请求。

**账号变化在下一次请求生效，无需 `/login` 或 `/reload`；模型列表变化需要 `/reload`。** 已发出的请求不会中途切换账号。CC Switch 如果只改了 provider 配置却没有更新该 auth 文件，插件不会切换账号。

Pi 缓存暂时仍显示旧账号属于正常情况。若仅希望其显示也同步，可重新执行 `/login`，但这不是请求切换的必要步骤。

### 凭据过期

通过 Codex 更新登录，或在 CC Switch 中重新选择/刷新 OpenAI Official 账号，待 Codex `auth.json` 更新后直接重试。

插件的 `refreshToken()` 只是**重新读取已有凭据**，不会调用 OpenAI refresh 端点、轮换 token 或回写文件，避免多个工具同时刷新同一 refresh token。它不读取 CC Switch 的托管账号库。

## 价格、用量与 CC Switch

**Pi 显示 `$0` 表示本插件不估价，不表示请求免费或不消耗订阅额度。**

- Pi 仍按上游响应记录输入、输出、缓存等 token 用量；插件不改写 usage 或会话日志。
- 使用支持 Pi 会话导入的 CC Switch（3.20.0 起），启用会话扫描并确认能发现 Pi 日志。通常日志位于 `~/.pi/agent/sessions/`。
- CC Switch 导入 Pi 日志时，若日志费用全零，会用自己的模型价格表估算；价格缺失时仍可能为零。
- 插件不会读取、同步、补齐 CC Switch 的价格，也不会将费用反写到 Pi。
- 美元金额是按 token 单价的**参考估算**，不是 ChatGPT 订阅额度的真实美元账单；账号剩余额度以服务端查询为准。
- workflow / 子 Agent 没有落盘的会话无法被日志扫描发现，其持久化设置由对应插件管理，不属于本插件职责。

## 常见问题

| 现象 | 处理方式 |
| --- | --- |
| 模型缓存不存在、损坏或为空 | 检查错误中的路径和 `CODEX_HOME`，让 Codex 更新缓存后 `/reload`；不要手写另一份插件模型清单 |
| Codex 有新模型，但 Pi 没出现 | 确认缓存已更新且模型可见/API 可用，再 `/reload`；模型发现不等于重新登录 |
| 新模型显示 max-out 16.4K | Pi 内置目录尚无同 ID 输出元数据，16384 是适配补值；可更新 Pi 后重启 |
| 提示缓存错误，却仍能看到 Codex 模型 | 那可能是 Pi 内置 provider，不是本插件注册成功；先修复缓存再 reload |
| 看不到模型 / 提示未登录 | 缓存正常后，执行 `/login` 并选择“Codex 本地凭据”，建立 Pi 登录标记 |
| access token 已过期或将在 60 秒内过期 | 用 Codex 或 CC Switch 更新 live 登录，然后重试；通常不需要 Pi `/login` |
| 切账号后 Pi 缓存仍显示旧账号 | 以 Codex live auth 为准；无需通过查看/分享 token 验证 |
| Pi 金额仍为零 | 正常；到 CC Switch 查看估算费用并维护其价格表 |
| CC Switch 缺少某些请求 | 检查 CC Switch 版本、扫描设置、会话目录和子 Agent 持久化，不需要修改本插件价格 |
| 启动默认模型没变化 | 插件不管理默认模型；`/model` 选择用于当前会话，按 Ctrl+S 保存 Pi 启动默认值 |

## 测试

在**本插件目录**运行：

```bash
npm test
```

使用 Node 内置测试框架，无需安装额外测试框架。测试覆盖凭据只读复用、账号切换、路径一致性、模型过滤与映射、必需元数据补值、全零价格、异常缓存以及重复读取。

测试数据为合成缓存、临时 auth 文件和 JWT；不读取真实账号凭据、不请求模型、不依赖 CC Switch 数据库。

另有使用已安装 Pi SDK 的宿主集成测试，验证同一进程的启动及 `AgentSession.reload()`：缓存 A → B → 损坏 → 修复 → 缺失，同时检查旧注册被清理、价格全零和凭据未被改写：

```bash
npm run test:host
```

此命令需要 Node 能解析已安装的 `@earendil-works/pi-coding-agent`。如果 Pi 是全局安装、Node 在插件目录找不到该包，可传入它的 SDK 入口 **file URL**，例如：

```bash
npm run test:host -- file:///D:/Nodejs/node_modules/@earendil-works/pi-coding-agent/dist/index.js
```

将路径替换成自己的 Pi 安装位置；无需另装或复制 Pi。测试创建隔离临时目录、使用合成登录标记、关闭模型联网刷新，不发送提示词；过程中两条缓存错误是预期的失败用例。

SDK 验证覆盖 reload 底层流程，但不代替交互终端 `/reload` 命令及错误显示的手动验收。

## 安全说明

插件不直接保存或回写 token，但 **Pi 会把 OAuth 缓存保存到自己的 auth.json**。Codex 和 Pi 的两个 auth 文件都包含敏感凭据，不要提交、复制或分享其内容。

本项目不包含真实 token、账号数据、Pi OAuth 缓存或真实 Codex 缓存。模型错误不回显原始 JSON；不应为了排错上传整份模型缓存，其中可能包含与本插件无关的提示或元数据。

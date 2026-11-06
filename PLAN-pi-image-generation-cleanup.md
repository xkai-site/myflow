# pi-image-generation 收敛治理计划

## Context

- 目标：退役已完成的 M1/S1 在线验收执行器，精简长期文档和测试维护面，不改变生产行为。
- 当前分支 `main`，HEAD 为任务指定的 `fccfbec6f81e3ea9aa7e9eec0ba82d798eeb10d3`；初始工作区干净。
- 范围限定 `work/scripts/pi/pi-image-generation/`；本计划文件仅用于审批，不作为插件长期文档。
- 规划期间只读检查，不运行可能写入工作区的测试，不改代码、不安装依赖、不发在线图片请求。实施须等待计划批准。

## Approach

优先删除一次性在线执行器及其独占 Guard、测试和 Fixture；README 成为唯一长期用户文档；保留正式离线回归与安全边界测试。生产配置、依赖、认证、协议及实验开关均保持不变。

## Files to modify

- 重写插件 `README.md`，删除 `ADVANCED-CAPABILITIES.md`、`CODEX-ONLINE-ACCEPTANCE.md`。
- 删除 `test/codex-online-acceptance.mjs`、`test/acceptance-guard.mjs`、`test/acceptance-guard.test.ts`；Guard 仅由执行器和其专项测试导入，生产及正式宿主链路未引用。
- 修改 `test/markup.test.ts`：删除只验证一次性验收样本哈希、布局的用例和专用 `createHash` 导入；删除 `test/fixtures/codex-acceptance-{original,markup}.png`。这些样本的另一消费者就是在线执行器；通用离线样本已覆盖透明像素、原图保真、方向与独立图层，故无需迁移样本。
- `src/markup.ts`：删除将一次服务端尺寸观察写成固定规则的 TODO，不替换成新推断。
- 删除 `test/clash-https-probe.mjs`：未被自动测试/其他代码调用，固定依赖本机 Clash 7897 和 openssl，属于环境专项诊断；移除 README 中的相应引用。
- 保留 `test/host-dispatcher-probe.mjs`：自建回环 HTTP/CONNECT 服务，独立检查真实宿主 Dispatcher 长等待行为，具有通用故障排查价值；不接入普通测试、不在本次执行。
- 不改 `package.json`（现有测试入口已足够）；不为整理而重命名稳定宿主模块或引入新 Helper。

## Reuse

- 保留现有 `package.json` 的两个离线入口：`node --test test/*.test.ts test/sdk.test.mjs`、`node test/host-lifecycle.mjs`。
- `test/config-helpers.ts`：`readTestConfig()` 负责模型倒序内存副本，`getModel()` / `getProvider()` 按稳定 key/id 查找。
- `test/image-fixtures.mjs`：真实静态 PNG/JPEG/WebP；`test/advanced-fixtures.mjs`：`advancedFixtures()` 提供透明/不透明、EXIF 方向与独立原图/图层，`svgXml` / `svgImage` 提供静态 SVG。
- `test/tui-host.mjs` 现有 `harness()` 向专项宿主检查传入环境；`test/sdk.mjs` 定位已安装 SDK，不下载依赖。
- 模拟 JWT 虽重复，但多数仅一行，且诊断测试使用不同敏感值验证脱敏；保持用例局部、显式，不抽象成凭据系统。

## README 收敛内容

当前三份 Markdown 合计 **734 行 / 91,707 字节**：README 282 行 / 36,340 字节，高级能力报告 324 行 / 41,403 字节，在线验收报告 128 行 / 13,964 字节。目标收敛为插件内唯一 `README.md`，约 150–200 行，不为凑行数删必要说明。

| 章节 | 保留内容 |
| --- | --- |
| 简介 | 轻量 Pi 图像适配器；官方资料定义上游协议，配置声明当前能力，代码/测试定义客户端行为；不保证上游账户权限 |
| 安装 | Pi/Node 要求、当前安装加载命令、`/reload`；sharp 平台可选包要求 |
| 认证 | 原生 `/login openai-codex`；设置仅预填命令；区别普通 OpenAI / Codex CLI；千问 Key 优先级、明文文件路径和安全输入；不复制 token |
| 使用方法 | TUI 向导与 RPC 选项解析区别；`/image`、`--settings`、`--help`；常用参数表、编辑路径和 Windows 转义；RPC 附件不自动用于编辑 |
| RPC 结果 | 一个 JSONL 请求示例；从 notify 取路径而非 response.success/agent_end；错误通知、串行调用、300 秒超时；file URI 只对应 Pi 所在机器 |
| 模型与配置 | 链接 models.jsonc，保留当前 key 和账户默认值的紧凑说明；参数/尺寸/输入上限查配置及帮助，不复制完整能力矩阵；未知/不支持参数拒绝 |
| 实验能力 | 简短四项：Markup 编辑、SVG 矢量、GIF 动画均默认关闭且按模型 opt-in；Streaming 只有离线适配、生产禁止开启；最少必要图层条件与文件预览限制，不复制协议 |
| 输出与排错 | 项目 `.pi/generated-images/`；真实格式不一致不保存/不重试；透明请求不等于逐像素透明保证；安全历史链接、SVG/GIF 只显示文件；取消后忙碌保护与 reload 边界；日志路径、认证/额度/网络/保存错误的恢复要点和费用风险 |
| 测试 | 两条离线测试命令、倒序运行方式、已安装 SDK / `PI_SDK` 定位；只用 Mock 或回环服务；保留通用 Dispatcher 手工诊断的一句说明；任何在线验收必须另建独立批次并重新明确授权，不复用历史批准 |
| 官方参考资料 | 用户提供的生成指南、Generate/Edit Reference、Codex 官方仓库；简短维护责任说明：配置、适配代码、回归、用户可见变化；Git 保留过程 |

不保留 M1/S1 参数、旧批准语句、样本摘要、阶段/日期/Commit、测试计数、API 研究报告或服务端观察矩阵；不新建 archive/history/架构文档。

## 测试职责与保留清单

以下路径均相对插件 `test/`。同一行为跨单元、适配器、Runtime、宿主的验证不是当然重复，不删独立边界断言。

| 文件 | 主要职责与处理 |
| --- | --- |
| `command.test.ts` | 参数解析、生成/编辑请求映射、默认选择与禁用模型拒绝；保留 |
| `model-config.test.ts` | 模型能力/默认值、JSONC 严格校验与重载；保留 |
| `credentials.test.ts` | Provider/OAuth 状态、Key 来源优先级、安全错误与秘密输入；保留 |
| `input-limits.test.ts` | 文件/count/data URL 边界及认证前校验；保留 |
| `output-options.test.ts` | 格式/背景配置与互斥、请求映射及菜单过滤；保留 |
| `transport.test.ts` | 凭据脱敏、重定向、原子保存/回滚/取消；保留 |
| `image-formats.test.ts` | PNG/JPEG/WebP 真实字节、MIME、Alpha 元数据、保存及取消；保留 |
| `diagnostics.test.ts` | 异常链、日志脱敏/原子写入、取消、不重试；保留 |
| `network-trace.test.ts`、`network-close.test.ts` | 并发诊断隔离与真实回环 HTTP 的完成/断连区别；保留 |
| `markup.test.ts` | 保留独立字段、真实透明像素、16 位、APNG 拒绝、EXIF、大小/像素/取消、安全门禁；仅删验收样本专用用例 |
| `svg.test.ts` | 静态 XML 安全、资源限制、路由、真实文件保存/回滚；保留 |
| `native-capabilities.test.ts` | 按模型实验门禁、GIF 容器/帧/时长与取消；保留 |
| `image-sse.test.ts` | 分块/UTF-8、partial/completed、错误/取消及预算；保留 |
| `tui-options.test.ts` | 稳定 key、菜单默认值、输入/取消与任务参数；保留 |
| `sdk.test.mjs`、`sdk.mjs` | 离线 SDK 路径解析及定位；保留 |
| `host-lifecycle.mjs`、`tui-host.mjs` | 已安装 SDK 集成、真实原生组件、深浅主题/窄终端、设置、路径/通知契约；保留入口和 harness |
| `native-host.mjs`、`advanced-host.mjs` | GIF/SVG/Markup 的 Runtime、TUI/RPC、门禁、文件历史与 SSE 离线边界；保留 |
| `history-security-host.mjs` | 真实 OSC 8/URI、危险/篡改历史、符号链接/junction、目录替换、增长与描述符关闭；保留 |
| `lifecycle-host.mjs`、`hanging-lifecycle-host.mjs` | 认证/请求/body 挂起、跨 reload 锁、重复提交、迟到响应与子进程隔离；保留 |
| `config-helpers.ts`、`image-fixtures.mjs`、`advanced-fixtures.mjs` | 已复用的离线构造与查找；保留 |
| `acceptance-guard.test.ts` | 7 个只保护已删除一次性 Guard 的用例；整文件删除 |
| `codex-online-acceptance.mjs`、`acceptance-guard.mjs` | 一次性在线工具及历史授权语义；删除 |
| `clash-https-probe.mjs` / `host-dispatcher-probe.mjs` | 删除固定环境专项，保留通用手工离线诊断；都不执行 |

现有单行假凭据与按用例模型副本不值得抽取复杂通用层。除上表明确删除项外，暂不删正式测试、不重命名模块、不重建宿主。

## Steps

- [x] 只读确认基准、工作区、文档内容、引用及正式测试依赖，形成明确清单。
- [x] 批准后复核状态，保留届时出现的用户修改；记录插件文档体积和配置/锁文件基准。
- [x] 先检查纯离线调用链，再运行 `npm test`、`npm run test:host`，记录真实基线数量、失败/跳过及退出码；不拿历史文档数字替代执行。
- [x] 删除执行器、Guard、Guard 专项测试、验收 PNG 与对应样本用例/无用导入；不访问、改写或删除 `.pi/` 内账本、日志及既有结果，不执行退役工具（包括 --offline）。
- [x] 按职责表删除 Clash 专项诊断，保留正式回归和通用 Dispatcher 探测；不新增依赖/测试框架。
- [x] 重写 README，删除两份历史文档，修复所有相关调用/Markdown 引用；确认无插件外正式引用需要更改。
- [x] 删除 markup.ts 过时 TODO，复核 diff 确保生产源码仅注释变化；其余源码、extensions、models.jsonc、package.json、package-lock.json 保持原样。
- [x] 执行完整正序/倒序回归、引用/链接/范围检查，输出会话内清理与验收报告，不新增永久 Markdown 报告、不提交/推送。

## Verification

- 运行测试前先检查测试链路的网络隔离，绝不执行在线验收或网络探测脚本。
- 批准后在插件目录执行下列 PowerShell 命令；环境变量先记录原状态、使用 `finally` 恢复（原本未设置则移除），不污染用户环境：

  ```powershell
  npm test
  npm run test:host
  $env:PI_IMAGE_TEST_REVERSE_MODELS = "1"
  npm test
  npm run test:host
  Remove-Item Env:PI_IMAGE_TEST_REVERSE_MODELS
  ```

- 保存每条命令真实退出码、总数、通过/失败/跳过/取消数；历史报告暗示基线 108 个单元、52 个宿主，但尚未实际重跑。按明确删除范围预计减少 8 个单元（7 Guard + 1 验收样本），宿主数量不变；最终只报告实测。
- 任何基线失败先区分环境/已有问题，不能删测试、降低校验或扩大功能范围来使结果变绿；发现真正缺陷仅在会话报告记录。
- 对跟踪文本仓库范围搜索删除文件名、`createAcceptanceFetch`、历史批准原文、续行选项及账本初始化语义（排除审批计划的删除清单、Git 历史和私有结果）；生产功能入口保留，旧授权工具入口为零。删除/重建账本无需实际试验：执行代码和批准源均已不存在。
- 逐一核对剩余 Fixture 消费者、README 相对链接和章节锚点；三条官方文档链接已通过只读公开页面获取成功，不做图片 API 请求或账户检查。
- 使用定向 diff 确认 models.jsonc、package.json、package-lock.json、extensions 和除注释外的 src 未改；检查无新增包、无其他插件变更，无历史私有产物变化。审批计划独立于插件交付，不计入插件长期文档数量。
- 执行 `git -c core.safecrlf=false diff --check` 与 `git status --short`；最终报告列出删除/保留理由、旧授权退役证据、文档字节变化、前后测试数与退出码、生产行为不变及四类维护位置。

## Findings

- 在线执行器读取旧批准文档，缺账本时创建内置历史授权，并可调用真实 SDK/OAuth 和图片接口；删除执行器、Guard 及批准文档，而不是增加账本机制。
- 宿主调用链为 `host-lifecycle.mjs → tui-host.mjs → native-host.mjs / advanced-host.mjs / lifecycle-host.mjs / history-security-host.mjs`；均为正式离线回归，不是一次性在线验收。
- 两个探测脚本均只访问回环服务、不读取账号；根据通用性保留 Dispatcher 探测，删除固定本机环境的 Clash 探测；本次两个都不运行。
- Fixture 仅四个：两张验收 PNG 待删除；`markup-two-frame.png` 为 APNG 拒绝测试所需，`native-two-frame.gif` 为动画容器与宿主测试所需，必须保留。
- 两份历史文档已逐节读取：稳定使用约束在 README、配置、实现/测试中已有归属；不搬运研究矩阵、旧批准原文、SHA、日期、费用讨论或历次计数。
- 已核实 `src/http.ts:readJsonResponse()` 的实际大小校验在 `arrayBuffer()` 后，属于基准已有资源局限；只在会话报告记录，不借清理改造 HTTP，也不把独立 Guard 的删除说成生产安全边界被删除。
- 本机 Node 为 v24.22.1、npm 为 11.19.1；依赖目录已存在，不安装。正式测试仅假凭据/Mock；真实 HTTP 测试绑定 127.0.0.1，挂起请求使用 Mock 子进程，SDK helper 仅定位本地包。
- 全仓库跟踪内容没有插件外引用待删除项。无需求歧义需要另行确认；实施仅等待此计划审批。

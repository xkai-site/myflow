# 通知插件模块与数据流

通知插件把 Pi 的公开会话事件转换为人类通知和独立 HTTP 消息。用户配置、默认值和接收协议见[插件 README](../README.md)；本文用于定位实现与测试。下表路径均相对于该插件目录。

## 事件与投递

| 模块 | 输入与输出 |
| --- | --- |
| `extensions/index.ts` | 注册 `/notify`、`--no-notify` 及会话/运行/工具/压缩/UI 事件，将宿主数据转换为信号 |
| `src/lifecycle.ts` 的 `createLifecycle` | 按会话与运行跟踪状态、工具失败、成本和输入对话；产生事实、快照与最终结果 |
| `src/runtime.ts` 的 `createRuntime` | 将事实分别交给通知规则与消息发布器，维护序号并处理配置切换与退出 |
| `src/rules.ts` | 按配置把运行结果、工具失败、压缩失败或等待输入转换为通知请求，解析统一/独立接收方式 |
| `src/service.ts` 的 `createService` | 同步接收请求，筛选、去重、合并与排队，再异步投递；`flush` 按预算等待 |
| `src/providers/registry.ts`、各渠道实现与 `decorators.ts` | 创建本机、Webhook、邮箱等渠道，处理超时、重试、熔断与错误清洗 |
| `src/messages.ts`、`src/api.ts` | 构造带完整快照的消息，独立排队并发送到配置的 HTTP 端点 |

最终运行结果来自 `agent_settled`。取消标记优先；证据不足时保留 `unknown`。工具失败默认并入运行结果，配置为 immediate 时按阈值提交独立请求；`custom` UI 对话不计为等待输入。

人类通知的 `enabled` 与 API 的 `api.enabled` 分别控制输出；`--no-notify` 或 `PI_NOTIFY_DISABLE=1` 同时关闭外发。API 按同一 stream 的递增序号发送事实与快照，使用有界队列和有限重试；接收方按事件 ID 去重，并处理丢失与迟到消息。

## 设置与凭据

| 模块 | 当前职责 |
| --- | --- |
| `src/config.ts` | 内置默认、用户文件解析与校验、损坏降级、稀疏写入和按字段删除 |
| `src/patch.ts` | 配置路径操作与补丁合并，过滤原型相关键 |
| `src/settings.ts` | 字段定义、会话覆盖、单项保存/恢复、接收例外与邮箱就绪状态 |
| `src/ui.ts` | 控制中心导航、日常原地开关、逐规则候选、返回栈及异步测试反馈 |
| `src/ui-model.ts` | 无 IO 的生效状态/邮箱下一步模型、去重的待保存字段与批量补丁 |
| `src/ui-primitives.ts` | Pi 原生 SelectList/Input 适配、独立的批量保存范围确认与分页 |
| `src/ui-secret.ts` | 独立遮蔽输入、有限分块粘贴、取消/销毁清理；私有状态不进入普通 JSON |
| `src/commands.ts` | 连接界面动作、配置读写、投递测试及非 TUI 状态展示 |
| `src/mail/credentials.ts`、`smtp.ts` | 环境变量/系统凭据库与 QQ SMTP；授权码独立于配置 JSON |
| `src/log.ts` | 控制字符清洗、错误脱敏和可选诊断日志 |

配置顺序为内置默认 → 用户配置 → 本对话覆盖。Enter 修改本对话，Ctrl+S 保存当前项已生效值；重载/恢复保留所属会话覆盖，new/fork 使用各自会话状态。用户文件损坏时保留原文，通知降级为本机失败提醒，API 关闭。

首页先显示生效状态、阻断原因与未保存数量，再提供总开关、提醒时机、接收方式、测试通知、更多设置和批量保存。日常开关 Enter/Space 原地切换；专业字段仍可通过搜索与详情编辑。未保存数量比较实际字段与以后默认，而非简单统计覆盖存在性；复合项与逐规则入口按底层字段去重。批量确认默认取消，`writeUserDefault` 一次验证/原子落盘，仅写确认过的字段，不固化无关渠道开关、API 或 JSON 专业参数。保存不删除会话覆盖。

统一接收方式是顶层 `channels`，规则使用 `"inherit"` 跟随，显式数组保留单独选择，空数组停止该类投递。确认统一时只修改规则路由。

测试通知可跳过等级、免打扰与频率筛选，仍服从强制静默、总开关及渠道开关。反馈区分拒收、排队、投递和失败；接收服务接受后，实际可见性仍由终端、系统或邮箱决定。Windows 界面可保存授权码到用户凭据管理器，测试使用替身凭据库。

## 验证入口

纯状态、配置和投递测试分别位于 `lifecycle-state.mjs`、`config-validation.mjs`、`settings-patch.mjs`、`routing-contract.mjs`、`service-coalesce.mjs`。`settings-ui.mjs` 检查真实组件、任务闭环、模拟凭据安全与 40/70/110 列快照；`host-lifecycle.mjs` 检查真实会话，`cli-smoke.mjs` 检查真实进程。完整映射与环境见[开发与测试](../README.md#开发与测试)。

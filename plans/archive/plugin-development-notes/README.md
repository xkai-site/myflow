# 插件开发历史记录（已归档）

原仓库根目录的三份工作记录原样迁入此目录，包含归档前尚未提交的内容；不再追加维护。它们用于追溯历史，不代表当前实现、待办清单或最新测试结果。

- [findings.md](findings.md)：调查发现、设计依据与结论修正。
- [progress.md](progress.md)：执行过程与当时的验证记录。
- [task_plan.md](task_plan.md)：历史任务计划（不是独立的 Test Plan）。

## 后续开发从哪里开始

优先阅读目标插件的当前说明，再检查源码与可执行测试：

- [pi-codex-official](../../../work/scripts/pi/pi-codex-official/README.md)
- [pi-image-generation](../../../work/scripts/pi/pi-image-generation/README.md)
- [pi-video-generation](../../../work/scripts/pi/pi-video-generation/README.md)

## 值得保留的历史结论

以下是检索线索，不是新增的线上验证或永久不变的接口保证：

- **认证与传输边界**：Codex 插件只读复用登录，不自行刷新 token；图片插件通过 `openai-codex` 获取认证。把该 provider 改成普通网关地址或本地 API Key，不是无缝替换。涉及网关时先检查当前认证和端点契约。
- **网关路线不能混同**：CC Switch v3.20.3 的 Codex Official 认证透传与 Claude-tab Codex OAuth Messages 桥接不是同一种行为。历史中关于占位 API Key 的泛化建议已被后续调查纠正；其他版本需重新核实。
- **网络故障尚无定论**：历史图片请求约 60 秒断连未确定根因。合成直连/CONNECT 的 70 秒测试通过，不代表真实 Clash/TLS/上游路径通过；另一次 HTTP 429 也不能解释先前断连。详见 [请求调查](../pi-image-generation/openai-image-request-investigation.md)。
- **测试证据有边界**：离线 mock、请求基线比较、宿主渲染检查与真实后端调用是不同层次的证据。历史通过数量不能作为当前测试状态；应在目标插件重新运行适用测试。真实生成可能消耗额度，不属于归档操作或默认离线验证。

## 容易误读的旧记录

- HTML 图片画廊曾实现，后来已移除；不要按旧计划恢复它。
- Sunburst/Flare 曾默认禁用，随后启用；当前配置及插件 README 优先于旧的禁用结论。
- “Current”、Scope、Verification、完成/阻塞标记均属于当时任务；文件中存在多轮相互修正的记录。
- 原文中的 `plans/...`、`work/...` 等路径按当时的仓库根目录理解，不相对于本归档目录。临时目录、会话及子代理产物路径可能已失效。

## 维护约定

不为每次改动同步更新这三份归档。当前用法、限制和必要开发说明维护在插件 README，行为约束优先落实为测试；只有重要设计取舍才另写简短设计记录。复杂任务确需跨会话恢复时，在 `plans/` 按任务建立临时计划，完成后归档，不再累计为根目录的全局流水账。

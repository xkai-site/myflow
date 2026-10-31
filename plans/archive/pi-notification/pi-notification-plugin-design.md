# 通知事件与模块结构

插件入口将公开事件交给 `createRuntime`，由 `createLifecycle` 产生运行事实与快照。通知规则和 HTTP 消息分别处理输出；最终运行结果依据 `agent_settled`。

实现从 `extensions/index.ts`、`src/runtime.ts`、`src/lifecycle.ts` 开始。完整模块输入输出与配置关系见 [模块说明](../../../wiki/tech/pi-notification-architecture.md)，字段与接收协议见 [插件 README](../../../work/scripts/pi/pi-notification/README.md)。

旧设计中的阶段号和 0.86.1 接口研究属于历史依据，原实测修订保存在 [历史验证摘录](verification-history.md)。当前兼容声明以包清单为准。

# 图片配置改造的历史验证记录

以下执行记录从原 `image-generation-model-config.md` 原样保留。计数、SDK 路径和验证边界对应当时的三个模型，不代表当前五模型清单的测试结果。当前入口见[插件测试说明](../../../work/scripts/pi/pi-image-generation/README.md#测试)。

## Execution log
- Step 5: 添加单一 models.jsonc、严格 JSONC 校验、尺寸策略及显式依赖。`npm install --ignore-scripts --no-audit --no-fund` 完成；`npm test` 5/5 通过，未访问真实凭据或生图服务。
- Step 6: 命令、菜单、默认值、输入图片限制已统一读取配置，运行时生成链路提取到 src/runtime.ts 便于测试。`npm test` 8/8 通过；生产代码具体模型 ID 搜索无匹配。
- Step 7: 完成双认证、独立凭据存储、账户设置及不回显输入；测试覆盖来源优先级、损坏拒绝、并发更新及 OpenAI 逐请求读取。
- Step 8: `npm test` 14/14 通过；`npm run test:host -- file:///D:/Nodejs/node_modules/@earendil-works/pi-coding-agent/dist/index.js` 通过，覆盖三模型共 6 个 mock 生成/编辑请求、运行时注册、命令/设置及重新初始化。git diff --check 无错误；生产 src/extensions 内具体模型 ID 搜索无匹配（rg 退出码 1 表示无匹配）。README 已更新。
- 宿主测试首次因 ESM-only Pi AI 无 require 导出失败，改用测试专用的已安装 SDK 相对路径加载后通过；生产代码不使用该路径。
- 验证边界：未进行实际 TUI/终端秘密输入人工验收，未运行完整 AgentSession.reload 集成流程、POSIX 权限或所有符号链接故障场景，也未做 TypeScript 全量类型检查。配置 A/B/损坏/修复有离线测试；宿主测试仅验证重新实例化而非完整 /reload。
- 未读取真实凭据、未发送真实生图请求、未消耗生图额度、未提交 Git；其他两个插件及既有无关目录未修改。


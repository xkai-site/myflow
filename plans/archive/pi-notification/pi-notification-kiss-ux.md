# 通知接收方式与测试反馈

顶层 `channels` 定义统一接收方式；规则的 `channels: "inherit"` 跟随统一设置，显式数组保留独立路由，`[]` 停止该规则投递。确认“让所有提醒跟随统一接收方式”后才修改六条路由。

`src/settings.ts` 生成路由例外、邮箱就绪状态与单项补丁，`src/commands.ts` 连接测试动作，`src/service.ts` 返回投递进度。具体配置与反馈语义见 [插件 README](../../../work/scripts/pi/pi-notification/README.md)。

`test/routing-contract.mjs` 检查继承、独立选择、测试筛选和邮箱就绪；UI、patch 和 service 专项检查交互与投递。命令见 [插件测试说明](../../../work/scripts/pi/pi-notification/README.md#开发与测试)。原方案中的用户动机是产品假设，尚无访谈证据。

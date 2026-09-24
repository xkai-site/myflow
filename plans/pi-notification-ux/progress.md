# 进度记录

## 2025-09-23
- 开始审视 `/notify` 体验并设定 JTBD 假设及安全约束。
- 检出既有工作区删除：`plans/archive/plugin-development-notes/README.md`，未触碰。
- 已读插件 README、`ui.ts` 开头、`commands.ts` 主逻辑。
- 完成当前 UI、配置表、README、邮件凭据逻辑和 54 项纯组件回归的盘点。
- JTBD 属于产品假设（没有访谈证据）；按「收到结果提醒、送达位置、快速验证」重排主路，并将内容/免打扰/级别/重试/诊断渐进放入更多设置。
- 测试基线通过：`MSYS_NO_PATHCONV=1 node test/settings-ui.mjs`（54 项）。
- 当前进入实施：首页精简、更多设置页重组、场景 Space 开关、渠道标签/邮箱说明友好化，随后更新测试和 README。

## 实施完成
- 首页重排为总开关、提醒时机、接收方式、测试通知、更多设置；普通配置决策收敛到更多设置。提醒场景支持 Space 快速开关，Enter 仍进入详细配置。
- 内置渠道值/开关使用友好名称；更多设置承载级别、提醒内容、免打扰、投递与频率、状态/重读/搜索；返回父级时刷新摘要。
- 邮箱状态提示具体缺项和下一步；授权码明确不是登录密码，界面保存仅 Windows 提供；测试文案说明“已提交”不代表已送达。
- 更新 `README.md`、设置组件及 host 集成测试，保留 schema、Enter/Ctrl+S 范围、遮蔽和安全边界。

## 验证
- `cd work/scripts/pi/pi-notification && MSYS_NO_PATHCONV=1 npm test`：通过（配置/patch/日志/生命周期/渠道/服务/UI/host/CLI 全量回归；UI 54 项）。
- `git diff --check`：通过。
- 类型检查：插件没有 tsconfig 或 typecheck 脚本；环境中的 `tsc` 不支持项目需要的 TS 导入选项。测试运行时用 Jiti 加载并执行相关 TS 源码。
- 未触碰既有删除 `plans/archive/plugin-development-notes/README.md`。

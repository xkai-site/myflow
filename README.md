# myflow

个人 AI 工作流与 Pi 插件集合。各插件独立使用、测试和维护，本仓库用于集中存放与导航。

## 插件

每个插件目录包含自身的源码、配置、依赖声明、测试、使用说明和 MIT 许可证。选择所需插件后，按它的 README 在该目录内安装和操作。

- [pi-usage-openai](work/scripts/pi/pi-usage-openai/README.md)
- [pi-image-generation](work/scripts/pi/pi-image-generation/README.md)
- [pi-video-generation](work/scripts/pi/pi-video-generation/README.md)
- [pi-notification](work/scripts/pi/pi-notification/README.md)
- [pi-edit-fallback](work/scripts/pi/pi-edit-fallback/README.md)

## 维护资料

[插件开发与维护](wiki/tech/pi-extension-development.md)说明共用目录结构、职责边界与验证原则，不维护具体插件清单。功能、安装、配置、凭据及测试说明维护在各插件目录中；每次整理或验证的记录放在 [`work/tasks/`](work/tasks/)。

# myflow

个人 AI 工作流与 Pi 插件集合。

## 插件

插件用法见各自 README；开发约定见[扩展开发手册](wiki/tech/pi-extension-development.md)。

- [pi-usage-openai](work/scripts/pi/pi-usage-openai/README.md)
- [pi-image-generation](work/scripts/pi/pi-image-generation/README.md)
- [pi-video-generation](work/scripts/pi/pi-video-generation/README.md)
- [pi-notification](work/scripts/pi/pi-notification/README.md)

## 安装与卸载

在仓库根目录执行，将 `<插件目录>` 替换为 `work/scripts/pi/` 下的目录名：

```bash
pi install ./work/scripts/pi/<插件目录>
pi list
pi remove ./work/scripts/pi/<插件目录>
```

卸载不会删除源码。操作后重启 Pi，或执行 `/reload`。npm 插件使用 `npm:<包名>` 作为安装或卸载目标。

维护以插件 README 和测试为准；复杂任务规划记入 `plans/`。

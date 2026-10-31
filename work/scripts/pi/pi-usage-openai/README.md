# pi-usage-openai

Pi 扩展：通过当前 Codex ChatGPT 登录查询 OpenAI 用量。仅提供 `/usage-openai` 命令，不注册对话模型 provider、工具或 OAuth 登录流程。

## 安装

在本插件目录运行 PowerShell：

```powershell
pi install .
```

Pi 本地安装引用该源码目录，后续加载仍需保留此路径。已运行的 Pi 执行 `/reload`，或重启 Pi。

## 使用

在 Pi 中运行：

```text
/usage-openai
```

扩展读取当前 `CODEX_HOME/auth.json`（默认 `~/.codex/auth.json`）中的 ChatGPT access token 与账号 ID，向 `https://chatgpt.com/backend-api/wham/usage` 发起只读查询。`CODEX_HOME` 应与 Codex 当前使用的目录一致。凭据须为有效 ChatGPT 登录，token 账号 ID 必须匹配且有效期超过 60 秒。凭据失效时，请通过 Codex 更新登录后重试；扩展不会刷新或写回 token。

命令显示接口可识别的套餐、用量窗口及重置时间；不会发起模型生成请求，也不会输出原始响应或凭据。接口为 ChatGPT 未公开内部接口，结构和可用性可能变化，显示结果不保证代表所有订阅额度。

## 开发与测试

在本插件目录执行 PowerShell：

```powershell
npm test
```

测试使用临时登录文件、合成 token 与模拟 fetch，覆盖认证读取、用量解析和命令注册。使用支持直接运行 TypeScript 的 Node.js，本插件已在 Node.js 24.22.1 验证；运行测试无需真实账号、Pi SDK 或编译步骤。源码与测试均包含在本插件目录中。

## 许可证

MIT，见 [LICENSE](LICENSE)。

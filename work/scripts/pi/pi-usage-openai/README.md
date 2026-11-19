# pi-usage-openai

Pi 扩展：使用现有 Codex ChatGPT 登录查询 ChatGPT / Codex 订阅用量，不查询 OpenAI Platform API 用量或账单。仅提供 `/usage-openai` 命令，不注册对话模型 provider、工具或 OAuth 登录流程。

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

扩展读取当前 `CODEX_HOME/auth.json`（默认 `~/.codex/auth.json`）中的 ChatGPT 凭据，校验 access token 中的账号 ID 与文件一致，再向 `https://chatgpt.com/backend-api/wham/usage` 查询。查询和续期均不启动 Codex CLI；无需续期时不写文件。

- Access token 到期或距到期不超过 60 秒时，使用同文件中的 refresh token 自动续期。若查询先返回 401，则至多续期一次并重查一次；服务明确报告会话已撤销或失效时，不尝试续期。
- 续期成功后会将新 token 和 `last_refresh` 原子写回同一 `auth.json`，以保留轮换后的 refresh token。无需改配置，但续期需要登录文件目录可写。插件不处理系统钥匙串；首次登录或凭据真正失效后，仍须通过 Codex 登录。网络错误、未知 401 和 refresh token 过期、已使用或撤销会分别提示。
- 插件会重读文件，尽量避免覆盖其他进程写入的新登录，并在同一 Pi 进程内合并并发续期；它与 Codex 或其他 Pi 进程没有共享锁。避免多个进程同时续期同一份凭据，以免发生轮换冲突。

命令显示接口可识别的套餐、用量窗口及重置时间；不会发起模型生成请求，也不会输出原始响应或凭据。`wham/usage`、Codex OAuth 客户端及其凭据文件格式都不是面向第三方插件的稳定契约，可能随上游变化；结果也不保证涵盖全部订阅额度。

## 开发与测试

在本插件目录执行 PowerShell：

```powershell
npm test
```

测试使用临时登录文件、合成 token 与模拟 fetch，覆盖认证读取、续期及错误处理、用量解析和命令注册。使用支持直接运行 TypeScript 的 Node.js，本插件已在 Node.js 24.22.1 验证；运行测试无需真实账号、Pi SDK 或编译步骤。源码与测试均包含在本插件目录中。

## 许可证

MIT，见 [LICENSE](LICENSE)。

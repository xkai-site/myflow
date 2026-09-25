# pi-usage-openai

Pi 扩展：通过当前 Codex ChatGPT 登录查询 OpenAI 用量。仅提供 `/usage-openai` 命令，不注册对话模型 provider、工具或 OAuth 登录流程。

## 安装

在仓库根目录运行：

```bash
pi install ./work/scripts/pi/pi-usage-openai
```

Pi 本地安装会引用该源码目录；不要在安装后移动或删除目录。已运行的 Pi 执行 `/reload`，或重启 Pi。

## 使用

在 Pi 中运行：

```text
/usage-openai
```

扩展读取当前 `CODEX_HOME/auth.json`（默认 `~/.codex/auth.json`）中的 ChatGPT access token 与账号 ID，向 `https://chatgpt.com/backend-api/wham/usage` 发起只读查询。`CODEX_HOME` 应与 Codex 当前使用的目录一致。凭据须为有效 ChatGPT 登录，token 账号 ID 必须匹配且有效期超过 60 秒。凭据失效时，请通过 Codex 更新登录后重试；扩展不会刷新或写回 token。

命令显示接口可识别的套餐、用量窗口及重置时间；不会发起模型生成请求，也不会输出原始响应或凭据。接口为 ChatGPT 未公开内部接口，结构和可用性可能变化，显示结果不保证代表所有订阅额度。

## 与其他插件的边界

本插件不注册 `openai-codex` provider，不提供 Pi 的模型登录、模型列表或 Codex OAuth provider 功能。它不保证其他扩展（包括图片生成扩展）可使用 Codex provider；这些功能须由独立 provider 或相应插件提供。

## 开发与测试

```bash
npm test
```

测试使用本地 fixtures / fake fetch，不访问真实账号或用量接口。

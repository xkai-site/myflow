# `/usage-openai` 用量查询扩展计划

## Context
在 `pi-codex-official` 中增加 Pi 斜杠命令 `/usage-openai`，通过现有 Codex ChatGPT OAuth 登录查询 `https://chatgpt.com/backend-api/wham/usage`，并在 Pi 中展示用量。该地址是未公开内部接口，字段与可用性可能变化。

## Approach
- 复用插件的本地凭据读取和 `CODEX_HOME` 规则，不新增登录流程、不输出或持久化 token。
- 注册无参数 Pi 命令 `/usage-openai`，调用内部 `GET /backend-api/wham/usage`；以简洁摘要显示套餐及所有可识别限额窗口的已用百分比、重置时间，不输出原始 JSON。
- 对接口响应做容错解析；不识别的字段不阻断已知字段显示。凭据缺失/过期或请求失败时给出可操作提示，建议用 Codex 更新登录，不自动刷新 token。
- 将结果表述为该内部接口报告的用量，而非完整 ChatGPT 全功能额度；请求中不记录或展示凭据。

## Files to modify
- `work/scripts/pi/pi-codex-official/extensions/index.ts`（注册命令）
- `work/scripts/pi/pi-codex-official/extensions/` 下新增用量请求/格式化模块（隔离接口与解析逻辑）
- `work/scripts/pi/pi-codex-official/test/` 下新增测试
- `work/scripts/pi/pi-codex-official/README.md`（记录用法与非官方接口限制）

## Reuse
- `extensions/codex-auth.ts`: `readLiveCodexCredential()` 校验并读取 Codex OAuth token 与账号 ID；不刷新 token。
- `extensions/index.ts`: 已配置 `https://chatgpt.com/backend-api`，但目前只注册 provider，尚无扩展命令。
- 插件现有测试采用 `node:test`，可对解析、格式化及错误情形做单测。

## Steps
- [x] 确认输出为简洁摘要（套餐、所有可识别用量窗口的已用比例与重置时间）；错误时提示用户检查/更新 Codex 登录。
- [x] 在独立模块实现带 OAuth Bearer token（及账号 ID）的 `/wham/usage` GET 请求；设置合理超时，并对非 2xx/无效 JSON 给出安全错误。
- [x] 对已知响应结构作防御式解析与格式化；测试窗口缺失、未知字段、重置时间和已用比例边界。
- [x] 在扩展入口注册 `/usage-openai`，用 Pi 命令上下文显示结果；命令不触发 LLM 生成或消耗模型额度。
- [x] 更新 README，说明用法、凭据来源及接口非公开/可能变化。
- [x] 运行插件测试，并在已登录 Pi 会话中手动验证真实查询。

## Verification
- 单测通过注入/替换 fetch，不访问真实网络、不使用真实凭据；覆盖成功、401/其他非 2xx、网络超时、无效 JSON、字段缺失及未知字段。
- 确认日志/错误提示不含 access token，令牌不被写盘；旧 token 情况按现有验证逻辑提示通过 Codex 更新登录。
- 手动在 Pi 输入 `/usage-openai`，确认摘要格式正确、失败提示可操作，且不发起模型生成请求。

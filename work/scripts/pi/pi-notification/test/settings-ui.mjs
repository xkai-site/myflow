/** Keyboard/visual task regression for the simplified UI. Temp JSON, fake vault and fake deliveries only. */
import "./fixtures/isolate-keyring.cjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { resolvePiPackageEntry, resolveSdkEntry } from "./sdk-path.mjs";
const sdkEntry = resolveSdkEntry();
const { createJiti } = createRequire(sdkEntry)("jiti");
const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false, alias: {
  "@earendil-works/pi-coding-agent": sdkEntry,
  "@earendil-works/pi-ai": resolvePiPackageEntry("@earendil-works/pi-ai", { sdkEntry }),
  "@earendil-works/pi-tui": resolvePiPackageEntry("@earendil-works/pi-tui", { sdkEntry }),
} });
const tui = await jiti.import("@earendil-works/pi-tui");
const { getThemeByName } = await jiti.import(path.join(path.dirname(sdkEntry), "modes/interactive/theme/theme.js"));
const plain = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");
const config = await jiti.import("../src/config.ts");
const settings = await jiti.import("../src/settings.ts");
const settingState = await jiti.import("../src/settings-state.ts");
const channels = await jiti.import("../src/channels.ts");
const model = await jiti.import("../src/ui-model.ts");
const { createQqCredentials } = await jiti.import("../src/mail/credentials.ts");
const { NotifySettingsComponent } = await jiti.import("../src/ui.ts");
const { createService } = await jiti.import("../src/service.ts");
const { resolveChannels, evaluateRunOutcome } = await jiti.import("../src/rules.ts");
const K = { up: "\x1b[A", down: "\x1b[B", enter: "\r", esc: "\x1b", space: " ", save: "\x13", test: "\x14", reload: "\x12", status: "\x0f" };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "notify-ui-"));
let serial = 0, passed = 0;
const failures = [];
async function step(name, run) { try { await run(); passed++; console.log(`  ✓ ${name}`); } catch (error) { failures.push({ name, error }); console.error(`  ✗ ${name}: ${error.stack}`); } }
function harness(raw, options = {}) {
  const dir = path.join(tmp, String(++serial));
  fs.mkdirSync(path.dirname(config.userConfigPath(dir)), { recursive: true });
  if (raw !== undefined) fs.writeFileSync(config.userConfigPath(dir), JSON.stringify(raw));
  let overlay = settingState.emptyOverlay(), done = false, renders = 0;
  const calls = { set: [], save: [], test: [], reload: 0, credential: [], unsubscribe: 0 };
  const effective = () => settingState.applyOverlay(config.loadConfig({ agentDir: dir }).config, overlay).config;
  const host = {
    config: effective, userRaw: () => config.readUserConfigRaw(dir).raw,
    runtimeState: () => ({ degraded: config.loadConfig({ agentDir: dir }).degraded, configError: config.loadConfig({ agentDir: dir }).errors.length > 0, quiet: options.quiet, terminalIssue: options.terminalIssue, channelIssues: options.channelIssues }),
    saveChanges(items) {
      calls.save.push(...items.map((item) => item.id));
      const current = effective();
      const result = config.writeUserDefault(dir, (raw) => settingState.settingUserFilePatch(raw, current, settingState.pendingPatch(items, current)));
      return { ok: result.ok, message: result.ok ? `已保存 ${items.length} 项为以后默认` : "批量保存失败：文件未改动" };
    },
    sessionOverride: (item) => settingState.sessionOverrideValue(overlay, item),
    restrictions: () => options.restrictions ?? [],
    setValue(item, value) {
      calls.set.push({ id: item.id, value });
      const next = settingState.applySettingPatch(overlay, item, item.patch(value));
      const checked = settingState.applyOverlay(config.loadConfig({ agentDir: dir }).config, next);
      if (checked.problems.length) return { ok: false, message: "输入有误，未应用" };
      overlay = next;
      return { ok: true, message: "已应用，仅本对话；Ctrl+S 保存为以后默认" };
    },
    channelActivation: (id) => channels.channelActivation(effective(), id, !!options.vault?.value, options.channelIssues),
    enableChannel(id) {
      const plan = host.channelActivation(id);
      if (plan.kind !== "ready") return { ok: false, message: "无法开启" };
      const item = settings.buildSettingItems(effective()).find((item) => item.providerId === id && !item.providerOptionPath);
      const patch = { kind: "compound", operations: [{ kind: "providers", id, value: true },
        ...(plan.addUnified ? [{ kind: "path", path: "channels", value: [...effective().channels, id] }] : [])] };
      overlay = settingState.applySettingPatch(overlay, item, patch);
      calls.set.push({ id: item.id, value: true });
      return { ok: true, message: "" };
    },
    saveDefault(item) {
      calls.save.push(item.id);
      const current = effective();
      const result = config.writeUserDefault(dir, (raw) => settingState.settingUserFilePatch(raw, current, settingState.settingSnapshot(item, current)));
      return { ok: result.ok, message: result.ok ? "已保存为以后默认，其他修改未保存" : "保存失败，文件未改动" };
    },
    followUserDefault(item) { overlay = settingState.clearItemOverride(overlay, item); return { ok: true, message: "已使用以后默认" }; },
    restoreBuiltinDefault(item) {
      const result = config.deleteUserDefault(dir, settingState.itemRemovals(item, effective(), overlay));
      if (result.ok) overlay = settingState.clearItemOverride(overlay, item);
      return { ok: result.ok, message: result.ok ? "已恢复初始设置" : "恢复失败" };
    },
    itemScope: (item) => item.paths ? [item.label] : [item.label],
    credentialStatus: () => options.canManageCredentials === false ? "安全存储不可用。可通过 PI_NOTIFY_QQ_SMTP_AUTH_CODE 或外部安全凭据服务注入。" : options.vault?.value ? "已保存于系统安全存储" : "未设置",
    credentialState: () => ({ source: options.vault?.value ? "vault" : "missing", state: options.vault?.value ? "configured" : options.canManageCredentials === false ? "unavailable" : "missing", storage: options.canManageCredentials === false ? { available: false, reason: "离线测试无系统服务" } : { available: true }, revision: calls.credential.length, message: host.credentialStatus() }),
    saveCredential(value) { options.vault.value = value; calls.credential.push("save"); return { ok: true, message: "授权码已安全保存（所有对话可用）" }; },
    deleteCredential() { delete options.vault.value; calls.credential.push("delete"); return { ok: true, message: "已移除授权码" }; },
    openQqSettings: () => ({ ok: true, message: "请打开或复制 https://mail.qq.com/ 获取 SMTP 授权码。" }),
    test(channels, onProgress) {
      calls.test.push({ channels, onProgress });
      if (options.immediateTest) options.immediateTest(onProgress);
      return { ok: true, message: "已排队，尚未发送", unsubscribe: () => { calls.unsubscribe++; } };
    },
    testEmail(onProgress) { return host.test(["email"], onProgress); },
    reload() { calls.reload++; return { ok: true, message: "已重读，保留本对话修改" }; },
    statusLines: () => ["状态与诊断", ...Array.from({ length: 24 }, (_, i) => `诊断行 ${i}`)],
    preview: () => ({ ok: true, message: "示例，不会发送", lines: ["任务完成 / 示例会话", "固定数据，不读取真实回复"] }),
  };
  if (options.credentials) Object.assign(host, {
    credentialState: () => options.credentials.status(), credentialStatus: () => options.credentials.status().message,
    saveCredential: (value) => options.credentials.save(value), deleteCredential: () => options.credentials.delete(),
  });
  const bindings = { "tui.select.up": K.up, "tui.select.down": K.down, "tui.select.confirm": K.enter, "tui.select.cancel": K.esc, "tui.select.pageUp": "\x1b[5~", "tui.select.pageDown": "\x1b[6~" };
  const component = new NotifySettingsComponent({ host, theme: options.theme ?? { fg: (_, text) => text, bold: (text) => text },
    keybindings: { matches: (data, key) => bindings[key] === data }, requestRender: () => { renders++; }, done: () => { done = true; } });
  return { host, component, calls, dir, state: () => component.debugState(), press: (key) => component.handleInput(key),
    frame: (width = 80) => component.render(width), raw: host.userRaw, overlay: () => overlay, done: () => done, renders: () => renders };
}
const focusedLine = (h) => h.frame().find((line) => line.startsWith("→ ")) ?? "";
function focus(h, label) {
  // Drive the actual list and its scrolling; no row keys, candidate table or editor access.
  for (let i = 0; i < 80; i++) h.press(K.up);
  for (let i = 0; i < 100; i++) {
    const line = focusedLine(h).replace(/^→ [✓ ]*\s*/, "");
    if (line === label || line.startsWith(`${label}  `) || line.startsWith(`${label} ›`)) return;
    h.press(K.down);
  }
  assert.fail(`Missing visible option ${label}:\n${h.frame().join("\n")}`);
}
function row(h, label, open = false) { focus(h, label); if (open) h.press(K.enter); }
function home(h) {
  for (let i = 0; i < 20 && h.frame()[0] !== "通知设置"; i++) h.press(K.esc);
  assert.equal(h.frame()[0], "通知设置");
}
function reception(h) {
  home(h); row(h, "更多设置", true); row(h, "专业设置", true); row(h, "接收方式", true);
}
function searchItem(h, id) {
  home(h); h.press("/"); h.press(id); h.press(K.enter);
}
function confirm(h) {
  assert.match(h.frame().join(""), /↑↓ 选择.*Enter 确认/);
  h.press(K.down); h.press(K.enter);
}
function choose(h, label) { row(h, label, true); }
try {
  await step("首页是紧凑控制中心：生效状态、常用任务与明确保存入口", () => {
    const h = harness();
    assert.match(h.frame().join(""), /通知总开关.*提醒时机.*本机通知.*邮箱通知.*发送测试通知.*更多设置/);
    assert.match(h.frame().join(""), /通知已开启/);
    assert.ok(h.frame().length < 12);
    assert.doesNotMatch(h.frame().join(""), /未保存|Ctrl\+|Enter|仅本对话/);
    assert.doesNotMatch(h.frame().join(""), /provider|inherit|minLevel|coalesce|overlay/);
    row(h, "更多设置", true); assert.match(h.frame().join(""), /内容与隐私.*免打扰时段.*专业设置/);
  });
  await step("常用提醒时机仅完成/失败/等待输入，默认不改变", () => {
    const h = harness(); row(h, "提醒时机", true);
    assert.match(h.frame().join(""), /执行完成.*执行失败.*等待输入/);
    assert.equal(h.host.config().rules.waitingForUser.enabled, false);
    assert.equal(h.host.config().content.includeAssistantExcerpt, false);
  });
  await step("失败混合状态可保存但不强制归一", () => {
    const h = harness({ rules: { compactFailed: { enabled: false } } }); searchItem(h, "reminders.failed");
    h.press(K.save); assert.equal(h.raw().rules.runFailed.enabled, true); assert.equal(h.raw().rules.compactFailed.enabled, false);
    choose(h, "关闭"); assert.equal(h.host.config().rules.runFailed.enabled, false); assert.equal(h.raw().rules.runFailed.enabled, true);
  });
  await step("Enter/Space 不写文件；Ctrl+S 只保存已生效而非悬停候选", () => {
    const h = harness(); searchItem(h, "enabled"); h.press(K.down); h.press(K.save);
    assert.equal(h.raw().enabled, true); assert.equal(h.calls.set.length, 0);
    h.press(K.enter); assert.equal(h.host.config().enabled, false); assert.equal(h.raw().enabled, true);
    h.press(K.save); assert.equal(h.raw().enabled, false); assert.deepEqual(Object.keys(h.raw()), ["enabled"]);
  });
  await step("保存失败不回滚本对话值、不改坏 JSON", () => {
    const h = harness(); row(h, "通知总开关"); h.press(K.space);
    fs.writeFileSync(config.userConfigPath(h.dir), "{bad"); h.press(K.save);
    assert.match(h.frame().join(""), /保存失败/); assert.equal(h.overlay().patch.enabled, false);
    assert.equal(fs.readFileSync(config.userConfigPath(h.dir), "utf8"), "{bad");
  });
  await step("专业参数不在设置表或搜索，逐规则开关/等级/接收仍可编辑", () => {
    const h = harness();
    h.press("/"); h.press("delivery"); assert.match(h.frame().join(""), /没有匹配的设置/);
    searchItem(h, "rules.toolFailed.channels"); assert.match(h.frame().join(""), /工具失败：接收方式/);
  });
  await step("返回保留焦点，重读保持本对话修改", () => {
    const h = harness(); row(h, "提醒时机", true); row(h, "执行失败", true);
    assert.equal(h.frame()[0], "提醒时机", "日常开关 Enter 原地切换，不打开候选编辑器");
    h.press(K.reload); assert.equal(h.host.config().rules.runFailed.enabled, false);
    h.press("?"); h.press(K.esc); assert.match(focusedLine(h), /执行失败/);
    h.press(K.esc); assert.match(focusedLine(h), /提醒时机/);
  });
  await step("旧规则自定义不被统一接收设置覆盖", () => {
    const h = harness({ rules: { runFailed: { channels: [] } } });
    reception(h); assert.match(h.frame().join(""), /自定义|单独/);
    row(h, "统一接收选择", true); choose(h, "本机通知"); assert.deepEqual(h.host.config().channels, []);
    assert.deepEqual(h.host.config().rules.runFailed.channels, []);
  });
  await step("归一默认取消；确认只改六个接收数组，结果可单项保存", () => {
    const h = harness({ rules: { runFailed: { channels: [], enabled: false, level: "warning" } } });
    searchItem(h, "routes.unify"); h.press(K.enter); assert.match(focusedLine(h), /取消/); h.press(K.enter);
    assert.deepEqual(h.host.config().rules.runFailed.channels, []);
    h.press(K.enter); confirm(h); h.press(K.save);
    assert.equal(h.raw().rules.runFailed.channels, "inherit"); assert.equal(h.raw().rules.runFailed.enabled, false); assert.equal(h.raw().rules.runFailed.level, "warning");
    assert.equal(Object.keys(h.raw().rules).length, 6);
  });
  await step("逐规则接收方式：跟随统一 / 显式多选 / 空集合", () => {
    const h = harness(); searchItem(h, "rules.runCompleted.channels");
    choose(h, "本机通知"); assert.deepEqual(h.host.config().rules.runCompleted.channels, ["terminal"]);
    choose(h, "本机通知"); assert.deepEqual(h.host.config().rules.runCompleted.channels, []);
    choose(h, "跟随统一设置"); assert.equal(h.host.config().rules.runCompleted.channels, "inherit");
  });
  await step("缺凭据时统一选择只修改路由，首页启用才进入配置页", () => {
    const h = harness(undefined, { vault: {} }); searchItem(h, "channels"); choose(h, "邮箱通知");
    assert.equal(h.frame()[0], "统一接收选择"); assert.equal(h.calls.test.length, 0);
    assert.deepEqual(h.host.config().channels, ["terminal", "email"]); assert.equal(h.host.config().providers.find((p) => p.id === "email").enabled, false);
    home(h); row(h, "邮箱通知", true);
    assert.equal(h.frame()[0], "邮箱通知");
  });
  await step("配置齐全的邮箱选择路由也不隐式开启，不产生外发", () => {
    const h = harness({ providers: [{ id: "email", type: "email", options: { from: "sender@qq.com", to: ["reader@example.com"] } }] }, { vault: { value: "fake" } });
    searchItem(h, "channels"); choose(h, "邮箱通知"); h.press(K.save);
    assert.deepEqual(h.host.config().channels, ["terminal", "email"]);
    assert.deepEqual(h.raw().channels, ["terminal", "email"]); assert.equal(h.host.config().providers.find((p) => p.id === "email").enabled, false);
    assert.equal(h.calls.test.length, 0);
  });
  await step("邮箱启用步骤可以重新启用已选但关闭的邮箱", () => {
    const h = harness({ channels: ["terminal", "email"], providers: [{ id: "email", type: "email", enabled: false, options: { from: "sender@qq.com", to: ["reader@example.com"] } }] }, { vault: { value: "fake" } });
    reception(h); row(h, "邮箱配置", true); row(h, "邮箱通知", true);
    assert.equal(h.host.config().providers.find((p) => p.id === "email").enabled, true);
  });
  await step("数字自定义及非法输入；时间自定义严格校验", () => {
    const h = harness(); searchItem(h, "content.maxMessageChars"); choose(h, "自定义…");
    h.press("\x7f"); h.press("\x7f"); h.press("\x7f"); h.press("1"); h.press(K.enter);
    assert.match(h.frame().join(""), /Enter 应用.*Esc 取消/); assert.equal(h.host.config().content.maxMessageChars, 300);
    h.press(K.esc); home(h); searchItem(h, "quietHours.start"); choose(h, "自定义…");
    for (let i = 0; i < 5; i++) h.press("\x7f"); h.press("25:00"); h.press(K.enter); assert.match(h.frame().join(""), /Enter 应用.*Esc 取消/);
  });
  await step("a/d 单项还原：默认取消，确认才删，其他字段保留", () => {
    const h = harness({ enabled: false, content: { includeCost: false } }); row(h, "通知总开关"); h.press(K.space); h.press("?"); h.press("a");
    assert.equal(h.host.config().enabled, false); h.press("d"); assert.match(focusedLine(h), /取消/); h.press(K.enter); assert.equal(h.raw().enabled, false);
    h.press("d"); confirm(h); assert.equal(h.raw().enabled, undefined); assert.equal(h.raw().content.includeCost, false);
  });
  await step("窄屏/宽字符/标记/页数不超宽，详情可以分页", () => {
    const h = harness(); searchItem(h, "channels");
    for (const width of [0, 1, 8, 20, 24, 40, 80, 200]) for (const line of h.frame(width)) assert.ok(tui.visibleWidth(line) <= width);
    h.press("?"); for (let i = 0; i < 10; i++) { for (const line of h.frame(20)) assert.ok(tui.visibleWidth(line) <= 20); h.press(K.down); }
    h.press(K.esc); assert.equal(h.frame()[0], "统一接收选择");
  });
  await step("免打扰折叠与提醒预览不发送", () => {
    const h = harness(); row(h, "更多设置", true); row(h, "免打扰时段", true);
    row(h, "静默时间与例外", true); assert.match(h.frame().join(""), /开始时间/);
    home(h); row(h, "更多设置", true); row(h, "内容与隐私", true); row(h, "通知预览", true);
    assert.equal(h.frame()[0], "通知预览"); assert.equal(h.calls.test.length, 0);
  });
  await step("强制静默是额外限制；关闭组件不写盘", () => {
    const h = harness(undefined, { restrictions: [{ label: "强制静默", reason: "--no-notify" }] });
    assert.match(h.frame().join(""), /强制静默.*通知已停止/); h.press(K.esc); assert.equal(h.done(), true); assert.equal(h.raw(), undefined);
  });
  await step("测试按页面选择接收方式，结果部分成功且不宣称已收到", () => {
    const h = harness({ rules: { runFailed: { channels: ["terminal", "email"] } } });
    searchItem(h, "rules.runFailed.level"); h.press(K.test);
    assert.deepEqual(h.calls.test[0].channels, ["terminal", "email"]);
    const callback = h.calls.test[0].onProgress;
    callback({ id: "t1", stage: "result", result: { providerId: "terminal", ok: true } });
    callback({ id: "t1", stage: "result", result: { providerId: "email", ok: false, error: "测试失败" } });
    callback({ id: "t1", stage: "finished" });
    assert.match(h.frame().join(""), /本机通知：服务已接受.*邮箱通知：发送失败/);
    choose(h, "测试结果与详情 ›"); assert.match(h.frame().join(""), /服务接受不代表实际送达/);
  });
  await step("旧测试与关闭后回调不访问旧页面；新结果不串线", () => {
    const h = harness(); h.press(K.test); const old = h.calls.test[0].onProgress;
    h.press(K.test); assert.equal(h.calls.unsubscribe, 1);
    old({ id: "old", stage: "cancelled", reason: "new" }); assert.doesNotMatch(h.frame().join(""), /测试已停止/);
    const latest = h.calls.test[1].onProgress;
    const focus = focusedLine(h); latest({ id: "new", stage: "sending" }); assert.equal(focusedLine(h), focus);
    h.press(K.esc); const before = h.renders(); latest({ id: "new", stage: "result", result: { providerId: "terminal", ok: true } });
    assert.equal(h.renders(), before); assert.equal(h.calls.unsubscribe, 2);
  });
  await step("同步完成的结果不被已排队提示覆盖", () => {
    const h = harness(undefined, { immediateTest(callback) {
      callback({ id: "sync", stage: "result", result: { providerId: "terminal", ok: true } });
      callback({ id: "sync", stage: "finished" });
    } });
    h.press(K.test); assert.match(h.frame().join(""), /服务已接受/); assert.doesNotMatch(h.frame().join(""), /已排队/);
    h.press(K.esc); assert.equal(h.calls.unsubscribe, 0);
  });
  await step("未知接收方式可见且可取消，旧规则不被改写", () => {
    const h = harness({ channels: ["terminal", "missing"], rules: { runFailed: { channels: ["missing"] } } });
    searchItem(h, "channels"); choose(h, "missing（未找到，可取消选择）");
    assert.deepEqual(h.host.config().channels, ["terminal"]);
    assert.deepEqual(h.host.config().rules.runFailed.channels, ["missing"]);
  });
  await step("邮箱结果不冒充地址或授权码修改后的新配置测试", () => {
    const h = harness({ channels: ["email"], providers: [{ id: "email", type: "email", enabled: true, options: { from: "sender@qq.com", to: ["reader@example.com"] } }] }, { vault: { value: "fake" } });
    reception(h); row(h, "邮箱配置", true); row(h, "发送邮箱测试", true);
    h.calls.test[0].onProgress({ id: "mail", stage: "result", result: { providerId: "email", ok: true } });
    h.calls.test[0].onProgress({ id: "mail", stage: "finished" });
    assert.match(h.frame().slice(0, 14).join(""), /服务已接受/);
    row(h, "QQ 邮箱授权码", true); h.press("fake-new-code"); h.press(K.enter);
    assert.doesNotMatch(h.frame().slice(0, 14).join(""), /服务已接受/);
    assert.doesNotMatch(JSON.stringify(h.overlay()), /fake-new-code/);
    row(h, "发件 QQ 邮箱", true);
    for (const _ of "sender@qq.com") h.press("\x7f");
    h.press("different@qq.com"); h.press(K.enter);
    assert.doesNotMatch(h.frame().slice(0, 14).join(""), /服务已接受/);
  });
  await step("主题变化后 invalidate 重绘，宽度变化不复用旧缓存", () => {
    let changed = false;
    const h = harness(undefined, { theme: { fg: (_, text) => changed ? `\x1b[32m${text}\x1b[0m` : text, bold: (text) => text } });
    assert.doesNotMatch(h.frame().join(""), /\x1b\[32m/);
    changed = true; h.component.invalidate(); assert.match(h.frame().join(""), /\x1b\[32m/);
    for (const line of h.frame(20)) assert.ok(tui.visibleWidth(line) <= 20);
  });
  await step("任务旅程：仅普通页面配置失败时本机+邮箱，真实服务管线用假渠道验收", async () => {
    const vault = {}, h = harness(undefined, { vault });
    const frames = [["首页", h.frame().join("\n")]];
    row(h, "提醒时机", true); row(h, "执行完成"); h.press(K.space);
    row(h, "执行失败"); h.press(K.space); h.press(K.space);
    frames.push(["提醒时机", h.frame().join("\n")]);
    assert.equal(h.raw(), undefined);
    home(h); reception(h); row(h, "邮箱配置", true);
    for (const [label, text] of [["发件 QQ 邮箱", "sender@qq.com"], ["收件邮箱（多个）", "reader@example.com"]]) {
      row(h, label, true); h.press(text); h.press(K.enter);
    }
    row(h, "QQ 邮箱授权码", true); h.press("fake-journey-code"); h.press(K.enter);
    assert.equal(h.calls.test.length, 0); assert.equal(h.raw(), undefined);
    assert.equal(h.host.config().providers.find((p) => p.id === "email").enabled, false);
    row(h, "邮箱通知", true);
    assert.deepEqual(h.host.config().channels, ["terminal"]);
    searchItem(h, "channels"); choose(h, "邮箱通知");
    const current = h.host.config();
    assert.deepEqual(resolveChannels(current, current.rules.runFailed), ["terminal", "email"]);
    assert.equal(current.rules.waitingForUser.enabled, false); assert.equal(current.content.includeAssistantExcerpt, false);
    frames.push(["邮箱就绪", h.frame().join("\n")]);
    const deliveries = [];
    let journeyReceipt;
    const journeyEvents = [];
    const service = createService({ config: current, now: () => Date.now(), log: { record(entry) { journeyEvents.push({ record: entry }); }, log(...args) { journeyEvents.push({ log: args }); } }, registry: { create(id, type) {
      return { id, type, validate: () => undefined, send: async (req) => { deliveries.push({ id, req }); }, dispose: async () => {} };
    } } });
    try {
      h.host.test = (channels, onProgress) => {
        journeyReceipt = service.submit({ level: "info", kind: "run_completed", title: "固定测试", body: "固定测试，不是真实回复", dedupeKey: "journey-test", channels, meta: {} }, { manualTest: true, onProgress: (event) => { journeyEvents.push(event); onProgress(event); } });
        return journeyReceipt.accepted ? { ok: true, message: "已排队", unsubscribe: journeyReceipt.unsubscribe } : { ok: false, message: journeyReceipt.reason };
      };
      home(h); h.press(K.test); await service.flush(1000);
      assert.equal(journeyReceipt?.accepted, true, `test submission rejected: ${JSON.stringify(journeyReceipt)} config=${JSON.stringify({ enabled: current.enabled, providers: current.providers.map((p) => [p.id, p.enabled]), channels: current.channels })}`);
      assert.deepEqual(deliveries.map((d) => d.id), ["terminal", "email"], `${h.frame().join("")}; events=${JSON.stringify(journeyEvents)}`);
      assert.match(h.frame().join(""), /本机通知：服务已接受.*邮箱通知：服务已接受/);
      frames.push(["测试结果", h.frame().join("\n")]);
      reception(h); row(h, "统一接收选择"); h.press(K.save);
      const future = config.loadConfig({ agentDir: h.dir }).config;
      assert.deepEqual(future.channels, ["terminal", "email"]);
      assert.equal(future.rules.runCompleted.enabled, true, "未保存的完成开关不应成为以后默认");
      assert.deepEqual(future.providers.find((p) => p.id === "email").options.to, [], "接收方式保存不能夹带地址");
      assert.doesNotMatch(JSON.stringify(h.raw()), /fake-journey-code|sender@qq.com|reader@example.com/);
      if (process.env.PI_NOTIFY_ACCEPTANCE_FRAMES === "1") for (const [label, frame] of frames) console.log(`\n[验收画面：${label}]\n${frame}`);
    } finally { h.press(K.esc); h.component.dispose(); await service.dispose(); }
  });
  await step("未保存数量按真实差异计数、别名去重；撤回和单项保存后归零", () => {
    const h = harness();
    row(h, "提醒时机", true); row(h, "执行失败"); h.press(K.space);
    const pending = () => model.pendingSettings(h.host.config(), h.raw(), h.host.sessionOverride);
    assert.equal(pending().length, 2, "失败控制对应两个实际字段，不重复计算复合项");
    assert.deepEqual(pending().map((item) => item.id), ["rules.runFailed.enabled", "rules.compactFailed.enabled"]);
    h.press(K.save); assert.equal(pending().length, 0);
    assert.notEqual(h.host.sessionOverride(settings.buildSettingItems(h.host.config()).find((item) => item.id === "reminders.failed")), undefined);
    h.press(K.space); assert.equal(pending().length, 2);
    h.press(K.space); assert.equal(pending().length, 0);
  });
  await step("批量保存默认取消、Esc 原焦点返回；确认原子写入所有修改", () => {
    const h = harness({ api: { enabled: false }, future: "keep" });
    row(h, "通知总开关"); h.press(K.space);
    searchItem(h, "content.includeCost"); choose(h, "关闭"); home(h);
    row(h, "保存为默认设置", true);
    assert.match(h.frame().join(""), /将保存以下修改.*其他已打开对话不变/);
    assert.doesNotMatch(h.frame().join(""), /JSON|API|授权码/);
    h.press(K.test); assert.equal(h.calls.test.length, 0, "范围确认中快捷键不得外发");
    h.press(K.enter); assert.deepEqual(h.raw(), { api: { enabled: false }, future: "keep" });
    row(h, "保存为默认设置", true); h.press(K.esc);
    assert.match(focusedLine(h), /保存为默认设置/);
    h.press(K.enter); h.press(K.down); h.press(K.enter);
    assert.deepEqual(h.raw(), { api: { enabled: false }, future: "keep", enabled: false, content: { includeCost: false } });
    assert.doesNotMatch(h.frame().join(""), /保存为默认设置|查看问题详情|测试结果与详情/);
    assert.equal(h.calls.save.length, 2);
  });
  await step("批量写入损坏 JSON 全部拒绝且保留本对话修改，首页直说降级", () => {
    const h = harness(); row(h, "通知总开关"); h.press(K.space);
    fs.writeFileSync(config.userConfigPath(h.dir), "{broken"); h.press(K.reload);
    assert.match(h.frame().join(""), /配置异常.*请查看诊断/);
    row(h, "保存为默认设置", true); h.press(K.down); h.press(K.enter);
    assert.match(h.frame().join(""), /批量保存失败/);
    assert.equal(fs.readFileSync(config.userConfigPath(h.dir), "utf8"), "{broken");
    assert.equal(h.overlay().patch.enabled, false);
  });
  await step("邮箱完成闭环：地址、模拟凭据、明确启用、手动测试、只保存邮箱范围", () => {
    const h = harness(undefined, { vault: {} });
    row(h, "提醒时机", true); row(h, "执行完成"); h.press(K.space); home(h);
    reception(h); row(h, "邮箱配置", true);
    assert.match(h.frame().join(""), /下一步：填写发件/);
    for (const [label, value] of [["发件 QQ 邮箱", "fake@qq.com"], ["收件邮箱（多个）", "reader@example.com"]]) {
      row(h, label, true);
      assert.match(h.frame().join(""), /Enter 应用/); h.press(value); h.press(K.enter);
      assert.equal(h.frame()[0], "邮箱通知");
    }
    assert.match(h.frame().join(""), /下一步：设置 QQ 邮箱授权码/);
    row(h, "QQ 邮箱授权码", true); h.press("fake-only-code"); h.press(K.enter);
    assert.match(h.frame().join(""), /配置已就绪/);
    assert.doesNotMatch(h.frame().join(""), /查看问题详情|授权码已安全保存/);
    assert.equal(h.calls.test.length, 0); assert.equal(h.raw(), undefined);
    row(h, "邮箱通知", true);
    searchItem(h, "channels"); choose(h, "邮箱通知");
    reception(h); row(h, "邮箱配置", true);
    h.press(K.test); assert.deepEqual(h.calls.test[0].channels, ["email"], "邮箱页快捷测试只能发邮箱");
    h.calls.test[0].onProgress({ id: "mail", stage: "result", result: { providerId: "email", ok: true } });
    h.calls.test[0].onProgress({ id: "mail", stage: "finished" });
    assert.match(h.frame().join(""), /服务已接受，尚未确认收件/);
    row(h, "保存为默认设置", true); h.press(K.down); h.press(K.enter);
    const future = config.loadConfig({ agentDir: h.dir }).config;
    assert.equal(future.providers.find((p) => p.id === "email").options.from, "fake@qq.com");
    assert.deepEqual(future.providers.find((p) => p.id === "email").options.to, ["reader@example.com"]);
    assert.equal(future.providers.find((p) => p.id === "email").enabled, true);
    assert.deepEqual(future.channels, ["terminal", "email"]);
    assert.equal(future.rules.runCompleted.enabled, true, "不夹带其它任务的修改");
    assert.equal(h.host.config().rules.runCompleted.enabled, false);
    assert.doesNotMatch(JSON.stringify(h.raw()) + JSON.stringify(h.overlay()), /fake-only-code/);
    assert.doesNotMatch(h.frame().join(""), /保存为默认设置|测试结果与详情|查看问题详情/);
  });
  await step("安全存储不可用仍保留一致管理入口，Enter 明确反馈安全注入方式", () => {
    const h = harness(undefined, { vault: {}, canManageCredentials: false });
    reception(h); row(h, "邮箱配置", true);
    assert.match(h.frame().join(""), /QQ 邮箱授权码  未配置/);
    row(h, "QQ 邮箱授权码", true);
    assert.equal(h.frame()[0], "邮箱通知");
    assert.match(h.frame().join(""), /安全存储不可用.*PI_NOTIFY_QQ_SMTP_AUTH_CODE/);
    assert.equal(h.calls.credential.length, 0);
    assert.equal(model.emailSetup(h.host.config(), true, "发送失败").test, "发送失败");
    const ready = h.host.config(); const p = ready.providers.find((p) => p.id === "email");
    Object.assign(p, { enabled: true, options: { from: "a@qq.com", to: ["b@example.com"] } }); ready.channels = ["email"];
    assert.equal(model.emailSetup(ready, true, "发送失败").test, "发送失败");
  });
  await step("获取授权码始终展示可复制的官方网址，宿主打开失败明确反馈", async () => {
    const h = harness(undefined, { vault: {} });
    row(h, "邮箱通知", true);
    h.host.openQqSettings = async () => ({ ok: false, message: "当前宿主无法打开浏览器，请复制官方 URL。" });
    row(h, "获取授权码：QQ 邮箱设置 ↗", true);
    await Promise.resolve(); await Promise.resolve();
    for (const width of [40, 70, 110]) {
      assert.match(h.frame(width).join(""), /https:\/\/mail\.qq\.com\//);
      assert.match(h.frame(width).join(""), /无法打开浏览器/);
    }
    assert.equal(h.calls.test.length, 0); assert.equal(h.calls.set.length, 0);
  });
  await step("真实凭据核心的读写删失败在 TUI 明确反馈且不泄漏，不改变开关或路由", () => {
    for (const operation of ["read", "write", "delete"]) {
      const fail = () => { throw new Error("fake-native-private"); };
      const credentials = createQqCredentials({ status: () => ({ available: true }),
        get: operation === "read" ? fail : () => "fake-existing-code",
        set: operation === "write" ? fail : () => {}, delete: operation === "delete" ? fail : () => {},
      }, () => undefined);
      const h = harness({ channels: ["email"], providers: [{ id: "email", type: "email", enabled: false,
        options: { from: "fake@qq.com", to: ["reader@example.com"] } }] }, { credentials });
      const before = JSON.stringify(h.host.config());
      reception(h); row(h, "邮箱配置", true);
      if (operation === "read") assert.match(h.frame().join(""), /凭据读取失败/);
      if (operation === "delete") {
        row(h, "移除已保存的邮箱授权码", true); h.press(K.down); h.press(K.enter);
        assert.match(h.frame().join(""), /删除.*失败/);
      } else {
        row(h, "QQ 邮箱授权码", true); h.press("fake-submitted-code"); h.press(K.enter);
        assert.match(h.frame().join(""), /保存.*失败/);
      }
      assert.equal(JSON.stringify(h.host.config()), before);
      assert.equal(h.calls.test.length, 0);
      assert.doesNotMatch(JSON.stringify(h.frame()) + JSON.stringify(h.state()) + JSON.stringify(h.overlay()), /fake-native-private|fake-submitted-code|fake-existing-code/);
    }
  });
  await step("有效状态集中解释强制静默、全关、缺渠道、免打扰、等级和例外", () => {
    const state = (raw, options = {}) => { const h = harness(raw, options); return h.frame().join(""); };
    assert.match(state({ enabled: false }), /通知已暂停/);
    assert.match(state({ channels: [] }), /未选择接收方式/);
    assert.match(state({ providers: [{ id: "terminal", type: "terminal", enabled: false }] }), /暂无可用接收方式/);
    assert.match(state(undefined, { quiet: true }), /免打扰中/);
    assert.match(state(undefined, { restrictions: [{ label: "强制静默", reason: "PI_NOTIFY_DISABLE" }] }), /强制静默/);
    assert.match(channels.controlStatus(config.defaultConfig(), { restrictions: [], hasCredential: false, terminalIssue: "PI_NOTIFY_CHANNEL=off" }).label, /暂无可用/);
    assert.doesNotMatch(state({ minLevel: "error", rules: { runFailed: { channels: [] } } }), /配置键|接收例外：|等级筛选：/);
  });
  await step("原生输入：焦点传播、长地址横向滚动、光标移动及粘贴；取消不改值", () => {
    const h = harness(undefined, { vault: {} }); h.component.focused = true;
    reception(h); row(h, "邮箱配置", true); row(h, "发件 QQ 邮箱", true);
    h.press("\x1b[200~long-fake-address@qq.com\x1b[201~");
    assert.ok(h.frame(40).join("").includes(tui.CURSOR_MARKER));
    h.press("\x1b[D"); h.press("\x7f");
    h.component.focused = false;
    assert.ok(!h.frame(40).join("").includes(tui.CURSOR_MARKER));
    h.press(K.esc); assert.equal(h.host.config().providers.find((p) => p.id === "email").options.from, "");
  });
  await step("授权码分块粘贴、错误与取消不会泄漏明文到渲染/快照/配置", () => {
    const h = harness(undefined, { vault: {} }); h.component.focused = true;
    reception(h); row(h, "邮箱配置", true); row(h, "QQ 邮箱授权码", true);
    h.press("\x1b[20"); h.press("0~fake-secret-"); h.press("only\x1b[201~");
    assert.doesNotMatch(h.frame(40).join("") + JSON.stringify(h.state()), /fake-secret-only/);
    assert.match(h.frame(40).join(""), /●/);
    h.press(K.enter); assert.deepEqual(h.calls.credential, ["save"]);
    assert.doesNotMatch(JSON.stringify(h.raw()) + JSON.stringify(h.overlay()), /fake-secret-only/);
    row(h, "QQ 邮箱授权码", true); h.press("\x1b[200~bad\nsecret\x1b[201~"); h.press(K.enter);
    assert.equal(h.frame()[0], "QQ 邮箱授权码"); assert.match(h.frame(40).join(""), /控制字符/);
    h.press(K.esc); assert.equal(h.calls.credential.length, 1);
    row(h, "QQ 邮箱授权码", true); h.press("fake-disposed"); h.component.dispose();
    assert.doesNotMatch(JSON.stringify(h.state()), /fake-disposed/);
  });
  await step("范围确认超过五项可分页，未查看项目也不重复或遗漏保存", () => {
    const h = harness();
    for (const id of ["content.includeCost", "content.includeDuration", "content.includeSessionLabel", "content.includeToolFailureNames", "content.includeAssistantExcerpt", "rules.waitingForUser.enabled"]) {
      searchItem(h, id); choose(h, id === "content.includeAssistantExcerpt" || id === "rules.waitingForUser.enabled" ? "开启" : "关闭");
    }
    home(h); row(h, "保存为默认设置", true);
    assert.match(h.frame(40).join(""), /1–5\/6/);
    h.press("\x1b[6~"); assert.match(h.frame(40).join(""), /2–6\/6/);
    h.press(K.down); h.press(K.enter);
    assert.equal(h.calls.save.length, 6); assert.doesNotMatch(h.frame().join(""), /保存为默认设置/);
  });
  await step("首页渠道开关直接操作，约束统一与逐规则真实投递且保留路由", async () => {
    const h = harness({ channels: ["terminal"], providers: [{ id: "terminal", type: "terminal" }, { id: "hook", type: "debug" }],
      rules: { runFailed: { channels: ["terminal", "hook"] } }, coalesce: { windowMs: 0, cooldownMs: 0 } });
    const deliver = async (status) => {
      const cfg = h.host.config(), sent = [];
      const service = createService({ config: cfg, now: () => Date.now(), log: { record() {}, log() {} }, registry: { create(id, type) {
        return { id, type, validate: () => undefined, send: async () => { sent.push(id); }, dispose: async () => {} };
      } } });
      try {
        const req = evaluateRunOutcome({ outcome: { sessionId: "fake", runId: `fake-${status}`, status, startedAt: 0, durationMs: 1, stopReason: "end_turn", toolFailures: [] } }, cfg);
        if (req) service.submit(req);
        await service.flush(1000); return sent;
      } finally { await service.dispose(); }
    };
    assert.deepEqual(await deliver("failed"), ["terminal", "hook"]);
    row(h, "本机通知", true);
    assert.equal(h.frame()[0], "通知设置"); assert.doesNotMatch(h.frame().join(""), /查看问题详情/);
    assert.deepEqual(h.host.config().channels, ["terminal"]);
    assert.deepEqual(h.host.config().rules.runFailed.channels, ["terminal", "hook"]);
    assert.deepEqual(await deliver("completed"), []);
    assert.deepEqual(await deliver("failed"), ["hook"]);
    assert.match(h.frame().join(""), /通知部分可用/);
    row(h, "本机通知", true);
    assert.equal(h.frame()[0], "通知设置");
    assert.equal(h.host.config().providers.find((p) => p.id === "terminal").enabled, true);
    assert.deepEqual(await deliver("failed"), ["terminal", "hook"]);
    assert.deepEqual(h.host.config().rules.runFailed.channels, ["terminal", "hook"]);
    assert.deepEqual(h.host.config().channels, ["terminal"]);
    assert.equal(h.calls.test.length, 0); assert.equal(h.raw().channels[0], "terminal");
  });
  await step("统一取消不冒充渠道关闭，规则例外继续使用；首页关闭才停止该渠道", () => {
    const h = harness({ channels: ["terminal"], rules: { runFailed: { channels: ["terminal"] } } });
    searchItem(h, "channels"); choose(h, "本机通知"); home(h);
    assert.deepEqual(h.host.config().channels, []);
    assert.equal(h.host.config().providers.find((p) => p.id === "terminal").enabled, true);
    assert.match(h.frame().join(""), /本机通知  开启/);
    row(h, "本机通知", true); row(h, "本机通知", true);
    assert.doesNotMatch(h.frame().join(""), /将加入统一|适用规则：/);
    assert.equal(h.frame()[0], "通知设置");
    assert.equal(h.host.config().providers.find((p) => p.id === "terminal").enabled, true);
    assert.deepEqual(h.host.config().channels, []);
    assert.deepEqual(h.host.config().rules.runFailed.channels, ["terminal"]);
  });
  await step("统一选择不重新开启关闭渠道，逐规则路由保持不变", () => {
    const h = harness({ channels: [], providers: [{ id: "terminal", type: "terminal", enabled: false }], rules: { runFailed: { channels: ["terminal"] } } });
    searchItem(h, "channels"); choose(h, "本机通知");
    assert.equal(h.frame()[0], "统一接收选择");
    assert.equal(h.host.config().providers.find((p) => p.id === "terminal").enabled, false);
    assert.deepEqual(h.host.config().channels, ["terminal"]);
    assert.deepEqual(h.host.config().rules.runFailed.channels, ["terminal"]);
  });
  await step("未使用渠道开启需确认加入统一选择，不改逐规则空集合或关闭规则", () => {
    const h = harness({ channels: [], providers: [{ id: "terminal", type: "terminal", enabled: false }], rules: { runFailed: { channels: [] } } });
    row(h, "本机通知", true);
    assert.match(focusedLine(h), /取消/);
    for (const width of [40, 70, 110]) {
      const frame = h.frame(width);
      assert.match(frame.join(""), /开启后加入统一接收选择。跟随统一设置的提醒将使用此渠道，单独设置不变/);
      assert.match(frame.join(""), /→ 取消[\s\S]*开启并加入统一接收/);
      for (const line of frame) assert.ok(tui.visibleWidth(line) <= width);
    }
    assert.doesNotMatch(h.frame().join(""), /适用规则：/);
    h.press(K.enter); assert.deepEqual(h.host.config().channels, []);
    row(h, "本机通知", true); confirm(h);
    assert.deepEqual(h.host.config().channels, ["terminal"]);
    assert.deepEqual(h.host.config().rules.runFailed.channels, []);
    assert.equal(h.host.config().rules.waitingForUser.enabled, false);
    assert.equal(h.calls.test.length, 0);
  });
  await step("恢复默认可能重新开启渠道时也须确认，取消保留关闭状态", () => {
    const h = harness(); row(h, "本机通知", true); h.press("?"); h.press("a");
    assert.match(h.frame()[0], /使用默认设置/); assert.match(focusedLine(h), /取消/);
    h.press(K.enter); assert.equal(h.host.config().providers.find((p) => p.id === "terminal").enabled, false);
    h.press("a"); confirm(h); assert.equal(h.host.config().providers.find((p) => p.id === "terminal").enabled, true);
  });
  await step("首页缺邮箱配置直接进入配置，已配置的邮箱可关闭且不发送测试", () => {
    const h = harness(undefined, { vault: {} }); row(h, "邮箱通知", true);
    assert.equal(h.frame()[0], "邮箱通知"); assert.equal(h.calls.set.length, 0);
    assert.doesNotMatch(h.frame().join(""), /\b[1-5]\. /);
    assert.match(h.frame().join(""), /QQ 邮箱授权码  未配置/);
    const ready = harness({ channels: ["email"], providers: [{ id: "email", type: "email", enabled: true, options: { from: "fake@qq.com", to: ["reader@example.com"] } }] }, { vault: { value: "fake" } });
    row(ready, "邮箱通知", true);
    assert.equal(ready.host.config().providers.find((p) => p.id === "email").enabled, false);
    assert.equal(ready.calls.test.length, 0);
    h.host.testEmail = () => ({ ok: false, message: "未发送：请先开启通知总开关。", feedback: { kind: "blocked", next: "home" } });
    h.press(K.test); assert.match(h.frame().join(""), /返回通知设置 ›/);
    row(h, "返回通知设置", true); assert.equal(h.frame()[0], "通知设置");
  });
  await step("Enter/Space 均能关闭已启用但缺地址或授权码的邮箱，关闭后再次操作进入配置", () => {
    for (const key of [K.enter, K.space]) for (const missing of ["from", "to", "credential"]) {
      const options = { from: "fake@qq.com", to: ["reader@example.com"] };
      if (missing === "from") options.from = "";
      if (missing === "to") options.to = [];
      const h = harness({ channels: ["email"], providers: [{ id: "email", type: "email", enabled: true, options }] },
        { vault: missing === "credential" ? {} : { value: "fake" } });
      assert.match(h.frame().join(""), /邮箱通知  开启（缺/);
      row(h, "邮箱通知"); h.press(key);
      assert.equal(h.frame()[0], "通知设置");
      assert.match(h.frame().join(""), /邮箱通知  关闭/);
      assert.doesNotMatch(h.frame().join(""), /缺发件地址|缺收件地址|缺授权码/);
      assert.equal(h.host.config().providers.find((p) => p.id === "email").enabled, false);
      assert.deepEqual(h.host.config().channels, ["email"]);
      h.press(key);
      assert.equal(h.frame()[0], "邮箱通知");
      assert.match(h.frame().join(""), /配置未完成/);
      assert.equal(h.calls.set.length, 1); assert.equal(h.calls.test.length, 0);
    }
  });
  await step("候选自定义与邮箱页开关的 Enter/Space 使用同一入口", () => {
    for (const key of [K.enter, K.space]) {
      const h = harness({ providers: [{ id: "email", type: "email", enabled: false,
        options: { from: "fake@qq.com", to: ["reader@example.com"] } }] }, { vault: { value: "fake" } });
      reception(h); row(h, "邮箱配置", true); row(h, "邮箱通知"); h.press(key);
      assert.doesNotMatch(h.frame().join(""), /加入统一接收选择/);
      assert.equal(h.host.config().providers.find((p) => p.id === "email").enabled, true);
      assert.deepEqual(h.host.config().channels, ["terminal"]);
      searchItem(h, "content.maxMessageChars"); row(h, "自定义…"); h.press(key);
      assert.match(h.frame().join(""), /范围：.*Enter 应用/);
    }
  });
  await step("错误与异步反馈仅留在操作上下文，不跟随导航或回流到旧页面", async () => {
    const h = harness();
    h.host.reload = () => ({ ok: false, message: "模拟旧页面错误", feedback: { kind: "recoverable" } });
    h.press(K.reload); assert.match(h.frame().join(""), /模拟旧页面错误/);
    row(h, "提醒时机", true); assert.doesNotMatch(h.frame().join(""), /模拟旧页面错误|查看问题详情/);
    h.press(K.esc); assert.doesNotMatch(h.frame().join(""), /模拟旧页面错误|查看问题详情/);
    h.press(K.test); const cb = h.calls.test.at(-1).onProgress;
    row(h, "更多设置", true);
    cb({ id: "late", stage: "result", result: { providerId: "terminal", ok: false, error: "fake" } });
    cb({ id: "late", stage: "finished" });
    assert.doesNotMatch(h.frame().join(""), /发送失败|测试结果与详情/);
    h.press(K.esc); assert.doesNotMatch(h.frame().join(""), /发送失败|测试结果与详情/);
    let resolve;
    h.host.openQqSettings = () => new Promise((done) => { resolve = done; });
    reception(h); row(h, "邮箱配置", true); row(h, "获取授权码：QQ 邮箱设置 ↗", true);
    h.press(K.esc); resolve({ ok: false, message: "模拟链接错误" }); await Promise.resolve();
    assert.doesNotMatch(h.frame().join(""), /模拟链接错误/);
  });
  await step("原生输入编辑后的提交值通过 Host 验证，不依赖内部编辑器", () => {
    const h = harness(undefined, { vault: {} });
    reception(h); row(h, "邮箱配置", true); row(h, "发件 QQ 邮箱", true);
    h.press("\x1b[200~long-fake-address@qq.com\x1b[201~"); h.press("\x1b[D"); h.press("\x7f"); h.press(K.enter);
    assert.deepEqual(h.calls.set.at(-1), { id: "provider:email:from", value: "long-fake-address@qq.cm" });
  });
  await step("焦点移动布局稳定，常规修改/撤销/保存不输出横幅，快捷键仅在帮助", () => {
    for (const width of [40, 70, 110]) {
      const h = harness(); const height = h.frame(width).length;
      for (let i = 0; i < 6; i++) {
        assert.equal(h.frame(width).length, height);
        assert.doesNotMatch(h.frame(width).join(""), /Ctrl\+|Enter|↑↓|来源：|仅本对话/); h.press(K.down);
      }
      row(h, "通知总开关", true); assert.doesNotMatch(h.frame(width).join(""), /已应用|仅本对话/);
      assert.match(h.frame(width).join(""), /当前对话.*未保存修改/);
      h.press(K.enter); assert.doesNotMatch(h.frame().join(""), /保存为默认设置/);
      row(h, "更多设置", true); h.press("?");
      assert.match(h.frame(width).join(""), /Ctrl\+S/);
    }
  });
  await step("服务接受/跳过/失败独立表达，技术错误只在详情且脱敏、不丢失尾部", () => {
    const h = harness(); h.press(K.test); const cb = h.calls.test[0].onProgress;
    cb({ id: "fake", stage: "sending" }); assert.match(h.frame().join(""), /发送中/);
    cb({ id: "fake", stage: "result", result: { providerId: "terminal", ok: false, error: `FAKE_INTERNAL password=fake-private ${"诊断片段 ".repeat(100)}完整诊断尾部` } });
    cb({ id: "fake", stage: "finished" });
    assert.match(h.frame().join(""), /发送失败/);
    assert.doesNotMatch(h.frame().join(""), /FAKE_INTERNAL|fake-private|诊断片段/);
    row(h, "测试结果与详情", true);
    let pages = "";
    for (let i = 0; i < 60; i++) { pages += h.frame(40).join(""); h.press(K.down); }
    assert.match(pages, /FAKE_INTERNAL/); assert.match(pages, /完整诊断尾部/); assert.doesNotMatch(pages, /fake-private/);
    home(h); h.press(K.test);
    h.calls.test[1].onProgress({ id: "skip", stage: "result", result: { providerId: "terminal", ok: true, skipped: true } });
    assert.match(h.frame().join(""), /未发送/); assert.doesNotMatch(h.frame().join(""), /服务已接受/);
  });
  await step("邮箱测试取消、删除地址/凭据与迟到结果不构成当前验证", () => {
    const h = harness({ channels: ["email"], providers: [{ id: "email", type: "email", enabled: true, options: { from: "fake@qq.com", to: ["reader@example.com"] } }] }, { vault: { value: "fake" } });
    reception(h); row(h, "邮箱配置", true); h.press(K.test);
    const cb = h.calls.test[0].onProgress;
    cb({ id: "cancel", stage: "cancelled", reason: "disposed" });
    assert.match(h.frame().join(""), /测试：未发送/);
    h.press(K.test); const accepted = h.calls.test.at(-1).onProgress;
    accepted({ id: "accepted", stage: "result", result: { providerId: "email", ok: true } });
    accepted({ id: "accepted", stage: "cancelled", reason: "disposed" });
    assert.match(h.frame().join(""), /测试：服务已接受，尚未确认收件/);
    h.press(K.test); const stopped = h.calls.test.at(-1).onProgress;
    stopped({ id: "stopped", stage: "sending" }); stopped({ id: "stopped", stage: "cancelled", reason: "disposed" });
    assert.match(h.frame().join(""), /测试：结果未知/);
    assert.doesNotMatch(h.frame().join(""), /未发送/);
    h.press(K.test); h.calls.test.at(-1).onProgress({ id: "no-result", stage: "finished" });
    assert.match(h.frame().join(""), /测试：结果未知/);
    h.press(K.test); const late = h.calls.test.at(-1).onProgress;
    row(h, "收件邮箱（多个）", true); for (const _ of "reader@example.com") h.press("\x7f"); h.press(K.enter);
    late({ id: "late", stage: "result", result: { providerId: "email", ok: true } });
    assert.match(h.frame().join(""), /测试：未测试/);
    row(h, "移除已保存的邮箱授权码", true); h.press(K.down); h.press(K.enter);
    assert.match(h.frame().join(""), /QQ 邮箱授权码  未配置/);
    assert.match(h.frame().join(""), /测试：未测试/);
    row(h, "邮箱通知", true);
    assert.equal(h.host.config().providers.find((p) => p.id === "email").enabled, false, "不完整配置也必须可以关闭渠道");
  });
  await step("有效状态不把空路由例外、缺凭据、本机不可用或等级过滤称为全面开启", () => {
    const label = (raw, options = {}) => channels.controlStatus(harness(raw).host.config(), { restrictions: [], hasCredential: false, ...options }).label;
    assert.equal(label({ rules: { runFailed: { channels: [] } } }), "通知部分可用");
    assert.match(label({ channels: ["email"], providers: [{ id: "email", type: "email", enabled: true }] }), /暂无可用/);
    assert.match(label(undefined, { terminalIssue: "fake-unavailable" }), /暂无可用/);
    assert.match(label({ minLevel: "error", rules: { runFailed: { enabled: false }, compactFailed: { enabled: false } } }), /等级筛选暂停/);
    assert.match(label(undefined, { configError: true }), /配置异常/);
    assert.match(label({ channels: ["hook"], providers: [{ id: "hook", type: "webhook", enabled: true }] }, { channelIssues: ["hook"] }), /暂无可用/);
    assert.match(label(undefined, { restrictions: [{ label: "强制静默", reason: "fake" }] }), /通知已停止/);
    assert.match(label({ providers: [{ id: "terminal", type: "noop", enabled: true }] }), /暂无可用/);
  });
  await step("普通渠道开关 Enter/Space 均直接恢复，Esc 不撤销；不夹带统一选择", () => {
    for (const key of [K.enter, K.space]) {
      const h = harness({ channels: [], providers: [{ id: "terminal", type: "terminal", enabled: false }],
        rules: { runFailed: { channels: ["terminal"], enabled: false } } });
      row(h, "本机通知"); h.press(key);
      assert.equal(h.frame()[0], "通知设置");
      assert.equal(h.host.config().providers.find((p) => p.id === "terminal").enabled, true);
      assert.deepEqual(h.host.config().channels, []);
      assert.equal(h.host.config().rules.runFailed.enabled, false);
      assert.equal(h.calls.test.length, 0); assert.equal(h.calls.save.length, 0);
      h.press(K.esc); assert.equal(h.done(), true);
      assert.equal(h.host.config().providers.find((p) => p.id === "terminal").enabled, true);
    }
  });
  await step("统一接收选择增删直接应用，只改路由不改变渠道开关", () => {
    const h = harness({ channels: [] });
    searchItem(h, "channels"); choose(h, "本机通知");
    assert.equal(h.frame()[0], "统一接收选择");
    assert.deepEqual(h.host.config().channels, ["terminal"]);
    h.press(K.space); assert.deepEqual(h.host.config().channels, []);
    assert.equal(h.host.config().providers.find((p) => p.id === "terminal").enabled, true);
  });
  await step("字段详情优先当前值、默认值和还原操作，全局帮助有独立入口", () => {
    for (const width of [40, 70, 110]) {
      const h = harness({ enabled: false });
      row(h, "通知总开关"); h.press("?");
      const details = h.frame(width).join("");
      assert.match(details, /^设置详情：通知总开关当前值：关闭默认值：关闭内置默认：开启/);
      assert.match(details, /a 使用默认值.*d 恢复内置默认/);
      assert.doesNotMatch(details, /Ctrl\+|↑↓|Enter|邮箱授权码/);
      h.press("?"); assert.equal(h.frame(width)[0], "操作帮助");
      h.press(K.esc); assert.match(h.frame(width)[0], /设置详情/);
      home(h); row(h, "更多设置", true); row(h, "操作帮助", true);
      assert.equal(h.frame(width)[0], "操作帮助");
      h.press(K.esc); assert.match(focusedLine(h), /操作帮助/);
    }
  });
  await step("长邮箱与中英文混排保留页面标记，焦点不改变行宽", () => {
    const h = harness({ providers: [{ id: "email", type: "email", options: { from: "long-sender-address@qq.com", to: ["long-reader-address@example.com"] } }] }, { vault: {} });
    reception(h); row(h, "邮箱配置", true);
    for (const width of [40, 70, 110]) {
      const addressRows = h.frame(width).filter((line) => /发件 QQ 邮箱|收件邮箱（多个）/.test(line));
      assert.equal(addressRows.length, 2);
      for (const line of addressRows) {
        assert.ok(line.endsWith(" ›"), `页面标记不应被原生列表二次裁切：${line}`);
        assert.ok(tui.visibleWidth(line) <= width - 2);
      }
    }
  });
  await step("删除授权码明确说明全对话影响，默认取消且不外发", () => {
    const h = harness(undefined, { vault: { value: "fake-delete-only" } });
    reception(h); row(h, "邮箱配置", true); row(h, "移除已保存的邮箱授权码", true);
    for (const width of [40, 70, 110]) {
      const frame = h.frame(width);
      assert.match(frame.join(""), /影响所有对话.*环境注入需在来源单独移除/);
      for (const line of frame) assert.ok(tui.visibleWidth(line) <= width);
    }
    h.press(K.enter); assert.deepEqual(h.calls.credential, []);
    row(h, "移除已保存的邮箱授权码", true); h.press(K.esc);
    assert.match(focusedLine(h), /移除已保存/);
    assert.equal(h.calls.test.length, 0);
  });
  await step("40/70/110 列主要页面布局快照、重复渲染、焦点和滚动回归", () => {
    const frames = {};
    const h = harness(undefined, { vault: {} });
    const capture = (name) => {
      for (const width of [40, 70, 110]) {
        const frame = h.frame(width);
        assert.deepEqual(h.frame(width), frame);
        h.component.invalidate(); assert.deepEqual(h.frame(width), frame);
        for (const line of frame) assert.ok(tui.visibleWidth(line) <= width, `${name}: ${line}`);
        assert.doesNotMatch(frame.join(""), /·/, `${name}: 不使用中点分隔文案`);
        if (!["help", "field-details"].includes(name)) assert.ok(frame.some((line) => line.includes("→ ")), `${name} focus missing`);
        assert.ok(frame.every((line, index) => index === 0 || line !== "" || frame[index - 1] !== ""), "不应有固定空白");
        frames[`${name}-${width}`] = frame;
      }
    };
    capture("home");
    row(h, "通知总开关", true); capture("home-paused-pending"); h.press(K.enter);
    row(h, "本机通知", true); capture("home-unavailable"); h.press(K.enter);
    row(h, "提醒时机", true); capture("reminders"); home(h);
    reception(h); row(h, "邮箱配置", true); capture("email");
    row(h, "发件 QQ 邮箱", true); h.press("fake@qq.com"); h.press(K.enter);
    row(h, "保存为默认设置", true); capture("save-review"); h.press(K.esc);
    h.press(K.status); for (let i = 0; i < 24; i++) h.press(K.down); capture("diagnostics-bottom");
    assert.match(h.frame(40).join(""), /诊断行 23/);
    h.press(K.esc); assert.match(focusedLine(h), /保存为默认设置/);
    row(h, "收件邮箱（多个）", true); h.press("reader@example.com"); h.press(K.enter);
    row(h, "QQ 邮箱授权码", true); h.press("fake-layout-only"); h.press(K.enter);
    row(h, "邮箱通知", true); capture("email-ready");
    h.press(K.test);
    h.calls.test[0].onProgress({ id: "snapshot", stage: "result", result: { providerId: "email", ok: false, error: "FAKE_FAILURE password=fake-layout-private" } });
    h.calls.test[0].onProgress({ id: "snapshot", stage: "finished" }); capture("email-test-failed");
    h.host.saveChanges = () => ({ ok: false, message: "保存失败：默认设置未改动，当前对话修改仍保留。", feedback: { kind: "unknown", next: "diagnostics", details: ["模拟写入失败"] } });
    row(h, "保存为默认设置", true); h.press(K.down); h.press(K.enter); capture("save-failed");
    home(h); row(h, "更多设置", true); row(h, "操作帮助", true); capture("help"); h.press(K.esc);
    home(h); row(h, "通知总开关"); h.press("?"); capture("field-details"); h.press(K.esc);
    searchItem(h, "content.maxMessageChars"); h.press(K.save); capture("candidates"); home(h);
    const unused = harness({ channels: [], providers: [{ id: "terminal", type: "terminal", enabled: false }] });
    row(unused, "本机通知", true);
    for (const width of [40, 70, 110]) frames[`enable-review-${width}`] = unused.frame(width);
    const file = new URL("./fixtures/notification-layout.json", import.meta.url);
    if (process.env.PI_NOTIFY_UPDATE_LAYOUTS === "1") fs.writeFileSync(file, JSON.stringify(frames, null, 2) + "\n");
    assert.deepEqual(frames, JSON.parse(fs.readFileSync(file, "utf8")));
  });
  await step("Pi 亮色/暗色主题在 40/70/110 列保持相同可见布局，标题中性且焦点突出", () => {
    const frames = JSON.parse(fs.readFileSync(new URL("./fixtures/notification-layout.json", import.meta.url), "utf8"));
    for (const name of ["light", "dark"]) {
      const theme = getThemeByName(name); assert.ok(theme, `Pi 内置主题 ${name}`);
      const h = harness(undefined, { theme, vault: {} });
      const check = (page, source = h) => {
        for (const width of [40, 70, 110]) {
          const frame = source.frame(width);
          assert.deepEqual(frame.map(plain), frames[`${page}-${width}`].map(plain), `${name} ${page} ${width}`);
          for (const line of frame) assert.ok(tui.visibleWidth(line) <= width);
          assert.equal(frame[0], theme.bold(plain(frame[0])), "标题仅使用主题字重，不叠加强调色（非 TTY 时字重可为空）");
          if (!["help", "field-details"].includes(page)) assert.ok(frame.some((line) => plain(line).startsWith("→ ") && line.includes("\x1b[")), "焦点保持主题样式");
          assert.doesNotMatch(frame.join(""), /·/);
        }
      };
      const themedRow = (label, open = false) => {
        for (let i = 0; i < 80; i++) h.press(K.up);
        for (let i = 0; i < 100; i++) {
          const focused = h.frame().map(plain).find((line) => line.startsWith("→ ")) ?? "";
          if (focused === `→ ${label}` || focused.startsWith(`→ ${label}  `) || focused.startsWith(`→ ${label} ›`)) {
            if (open) h.press(K.enter); return;
          }
          h.press(K.down);
        }
        assert.fail(`Missing themed row ${label}`);
      };
      h.press(K.enter); h.press(K.enter); // Match the snapshot's explicit session override at its default value.
      check("home"); themedRow("提醒时机", true); check("reminders"); h.press(K.esc);
      themedRow("更多设置", true); themedRow("邮箱配置", true); check("email");
      themedRow("发件 QQ 邮箱", true); h.press("fake@qq.com"); h.press(K.enter);
      themedRow("保存为默认设置", true); check("save-review"); h.press(K.esc);
      themedRow("收件邮箱（多个）", true); h.press("reader@example.com"); h.press(K.enter);
      themedRow("QQ 邮箱授权码", true); h.press("fake-layout-only"); h.press(K.enter);
      themedRow("邮箱通知", true); check("email-ready");
      h.press(K.test);
      h.calls.test[0].onProgress({ id: "themed", stage: "result", result: { providerId: "email", ok: false, error: "FAKE_FAILURE password=fake-layout-private" } });
      h.calls.test[0].onProgress({ id: "themed", stage: "finished" }); check("email-test-failed");
      assert.ok(h.frame().includes(theme.fg("error", "测试：发送失败")), "测试失败使用语义错误色");
      h.press(K.esc); themedRow("操作帮助", true); check("help");
      h.press(K.esc); h.press(K.esc); themedRow("通知总开关"); h.press("?"); check("field-details");
      h.press(K.esc); h.press("/"); h.press("content.maxMessageChars"); h.press(K.enter); h.press(K.save); check("candidates");
      const unused = harness({ channels: [], providers: [{ id: "terminal", type: "terminal", enabled: false }] }, { theme });
      unused.press(K.down); unused.press(K.down); unused.press(K.enter); check("enable-review", unused);
    }
  });
  await step("Ctrl+O 可分页、重读动作可见，Ctrl+T 独立于业务开关", () => {
    const h = harness({ enabled: false }); h.press(K.status); assert.equal(h.frame()[0], "状态与诊断"); row(h, "重新读取配置", true); assert.equal(h.calls.reload, 1);
    h.press(K.esc); h.press(K.test); assert.equal(h.calls.test.length, 1);
  });
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
console.log(`UI: ${passed} passed, ${failures.length} failed`);
if (failures.length) process.exitCode = 1;

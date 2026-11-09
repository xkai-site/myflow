/** Keyboard/visual task regression for the simplified UI. Temp JSON, fake vault and fake deliveries only. */
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
const config = await jiti.import("../src/config.ts");
const settings = await jiti.import("../src/settings.ts");
const settingState = await jiti.import("../src/settings-state.ts");
const channels = await jiti.import("../src/channels.ts");
const model = await jiti.import("../src/ui-model.ts");
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
    canManageCredentials: () => options.canManageCredentials ?? true,
    credentialStatus: () => options.vault?.value ? "已保存于 Windows 凭据管理器" : "未设置",
    saveCredential(value) { options.vault.value = value; calls.credential.push("save"); return { ok: true, message: "授权码已安全保存（所有对话可用）" }; },
    deleteCredential() { delete options.vault.value; calls.credential.push("delete"); return { ok: true, message: "已移除授权码" }; },
    openQqSettings: () => ({ ok: true, message: "已打开邮箱设置" }),
    test(channels, onProgress) {
      calls.test.push({ channels, onProgress });
      if (options.immediateTest) options.immediateTest(onProgress);
      return { ok: true, message: "已排队，尚未发送", unsubscribe: () => { calls.unsubscribe++; } };
    },
    testEmail(onProgress) { return host.test(["email"], onProgress); },
    reload() { calls.reload++; return { ok: true, message: "已重读，保留本对话修改" }; },
    statusLines: () => ["状态与诊断", ...Array.from({ length: 24 }, (_, i) => `诊断行 ${i}`)],
    preview: () => ({ ok: true, message: "示例，不会发送", lines: ["任务完成 · 示例会话", "固定数据，不读取真实回复"] }),
  };
  const bindings = { "tui.select.up": K.up, "tui.select.down": K.down, "tui.select.confirm": K.enter, "tui.select.cancel": K.esc, "tui.select.pageUp": "\x1b[5~", "tui.select.pageDown": "\x1b[6~" };
  const component = new NotifySettingsComponent({ host, theme: options.theme ?? { fg: (_, text) => text, bold: (text) => text },
    keybindings: { matches: (data, key) => bindings[key] === data }, requestRender: () => { renders++; }, done: () => { done = true; } });
  return { host, component, calls, dir, state: () => component.debugState(), press: (key) => component.handleInput(key),
    frame: (width = 80) => component.render(width), raw: host.userRaw, overlay: () => overlay, done: () => done, renders: () => renders };
}
function row(h, key, open = false) {
  // Advanced routing remains reachable, but is deliberately not a home destination page.
  if (key === "category:channels" && h.state().view.id === "home") {
    row(h, "category:more", true); row(h, "category:professional", true);
  }
  const state = h.state(); const target = state.rows.indexOf(key);
  assert.ok(target >= 0, `Missing ${key}: ${state.rows}`);
  for (let i = state.focus; i !== target; i += i < target ? 1 : -1) h.press(i < target ? K.down : K.up);
  if (open) h.press(K.enter);
}
function home(h) { for (let i = 0; i < 20 && h.state().view.id !== "home"; i++) h.press(K.esc); }
function searchItem(h, id) {
  home(h); h.press("/"); h.press(id);
  row(h, `item:${id}`, true);
  assert.equal(h.state().view.kind, "detail");
}
function confirm(h) { assert.equal(h.state().view.kind, "confirm"); h.press(K.down); h.press(K.enter); }
function choose(h, label) {
  const itemId = h.state().view.itemId;
  const item = settings.buildSettingItems(h.host.config()).find((item) => item.id === itemId);
  const candidates = h.component.candidates(item);
  const index = candidates.findIndex((candidate) => candidate.label === label);
  assert.ok(index >= 0, label);
  while (h.state().focus !== index) h.press(h.state().focus < index ? K.down : K.up);
  h.press(K.enter);
}
try {
  await step("首页是紧凑控制中心：生效状态、常用任务与明确保存入口", () => {
    const h = harness(); assert.deepEqual(h.state().rows, ["item:enabled", "category:rules", "channel:terminal", "channel:email", "action:test", "category:more"]);
    assert.match(h.frame().join(""), /通知已开启/);
    assert.ok(h.frame().length < 12);
    assert.doesNotMatch(h.frame().join(""), /未保存|Ctrl\+|Enter|仅本对话/);
    assert.doesNotMatch(h.frame().join(""), /provider|inherit|minLevel|coalesce|overlay/);
    row(h, "category:more", true); assert.deepEqual(h.state().rows.slice(0, 3), ["category:content", "category:quietHours", "category:professional"]);
  });
  await step("常用提醒时机仅完成/失败/等待输入，默认不改变", () => {
    const h = harness(); row(h, "category:rules", true);
    assert.deepEqual(h.state().rows, ["item:reminders.completed", "item:reminders.failed", "item:reminders.waiting"]);
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
    const h = harness(); row(h, "item:enabled"); h.press(K.space);
    fs.writeFileSync(config.userConfigPath(h.dir), "{bad"); h.press(K.save);
    assert.match(h.state().message.text, /保存失败/); assert.equal(h.overlay().patch.enabled, false);
    assert.equal(fs.readFileSync(config.userConfigPath(h.dir), "utf8"), "{bad");
  });
  await step("专业参数不在设置表或搜索，逐规则开关/等级/接收仍可编辑", () => {
    const h = harness(); assert.ok(h.state().items.includes("rules.toolFailed.channels"));
    for (const id of ["delivery.timeoutMs", "coalesce.windowMs", "rules.toolFailed.mode", "rules.toolFailed.threshold", "rules.waitingForUser.kinds"]) assert.ok(!h.state().items.includes(id));
    h.press("/"); h.press("delivery"); assert.deepEqual(h.state().rows, []);
  });
  await step("返回保留焦点，重读保持本对话修改", () => {
    const h = harness(); row(h, "category:rules", true); row(h, "item:reminders.failed", true);
    assert.equal(h.state().view.id, "category:rules", "日常开关 Enter 原地切换，不打开候选编辑器");
    h.press(K.reload); assert.equal(h.host.config().rules.runFailed.enabled, false);
    h.press("?"); h.press(K.esc); assert.equal(h.state().rows[h.state().focus], "item:reminders.failed");
    h.press(K.esc); assert.equal(h.state().rows[h.state().focus], "category:rules");
  });
  await step("旧规则自定义不被统一接收设置覆盖", () => {
    const h = harness({ rules: { runFailed: { channels: [] } } });
    row(h, "category:channels", true); assert.match(h.frame().join(""), /自定义|单独/);
    row(h, "item:channels", true); choose(h, "本机通知"); assert.deepEqual(h.host.config().channels, []);
    assert.deepEqual(h.host.config().rules.runFailed.channels, []);
  });
  await step("归一默认取消；确认只改六个接收数组，结果可单项保存", () => {
    const h = harness({ rules: { runFailed: { channels: [], enabled: false, level: "warning" } } });
    searchItem(h, "routes.unify"); h.press(K.enter); assert.equal(h.state().focus, 0); h.press(K.enter);
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
  await step("邮箱缺配置时进入步骤页，不先开启或测试", () => {
    const h = harness(undefined, { vault: {} }); searchItem(h, "channels"); choose(h, "邮箱通知");
    assert.equal(h.state().view.id, "email-config"); assert.equal(h.calls.test.length, 0);
    assert.deepEqual(h.host.config().channels, ["terminal"]); assert.equal(h.host.config().providers.find((p) => p.id === "email").enabled, false);
    assert.ok(!h.state().rows.includes("item:provider:email:subjectPrefix"));
  });
  await step("配置齐全的邮箱仍需明确确认；取消不产生外发", () => {
    const h = harness({ providers: [{ id: "email", type: "email", options: { from: "sender@qq.com", to: ["reader@example.com"] } }] }, { vault: { value: "fake" } });
    searchItem(h, "channels"); choose(h, "邮箱通知"); assert.equal(h.state().view.kind, "confirm"); h.press(K.enter);
    assert.deepEqual(h.host.config().channels, ["terminal"]);
    choose(h, "邮箱通知"); confirm(h); h.press(K.save);
    assert.deepEqual(h.raw().channels, ["terminal", "email"]); assert.equal(h.raw().providers.find((p) => p.id === "email").enabled, true);
    assert.equal(h.calls.test.length, 0);
  });
  await step("邮箱启用步骤可以重新启用已选但关闭的邮箱", () => {
    const h = harness({ channels: ["terminal", "email"], providers: [{ id: "email", type: "email", enabled: false, options: { from: "sender@qq.com", to: ["reader@example.com"] } }] }, { vault: { value: "fake" } });
    row(h, "category:channels", true); row(h, "email-config", true); row(h, "action:email-enable", true); confirm(h);
    assert.equal(h.host.config().providers.find((p) => p.id === "email").enabled, true);
  });
  await step("数字自定义及非法输入；时间自定义严格校验", () => {
    const h = harness(); searchItem(h, "content.maxMessageChars"); choose(h, "自定义…");
    h.press("\x7f"); h.press("\x7f"); h.press("\x7f"); h.press("1"); h.press(K.enter);
    assert.equal(h.state().view.kind, "input"); assert.equal(h.host.config().content.maxMessageChars, 300);
    h.press(K.esc); home(h); searchItem(h, "quietHours.start"); choose(h, "自定义…");
    for (let i = 0; i < 5; i++) h.press("\x7f"); h.press("25:00"); h.press(K.enter); assert.equal(h.state().view.kind, "input");
  });
  await step("a/d 单项还原：默认取消，确认才删，其他字段保留", () => {
    const h = harness({ enabled: false, content: { includeCost: false } }); row(h, "item:enabled"); h.press(K.space); h.press("?"); h.press("a");
    assert.equal(h.host.config().enabled, false); h.press("d"); assert.equal(h.state().focus, 0); h.press(K.enter); assert.equal(h.raw().enabled, false);
    h.press("d"); confirm(h); assert.equal(h.raw().enabled, undefined); assert.equal(h.raw().content.includeCost, false);
  });
  await step("窄屏/宽字符/标记/页数不超宽，详情可以分页", () => {
    const h = harness(); searchItem(h, "channels");
    for (const width of [0, 1, 8, 20, 24, 40, 80, 200]) for (const line of h.frame(width)) assert.ok(tui.visibleWidth(line) <= width);
    h.press("?"); for (let i = 0; i < 10; i++) { for (const line of h.frame(20)) assert.ok(tui.visibleWidth(line) <= 20); h.press(K.down); }
    h.press(K.esc); assert.equal(h.state().view.kind, "detail");
  });
  await step("免打扰折叠与提醒预览不发送", () => {
    const h = harness(); row(h, "category:more", true); row(h, "category:quietHours", true);
    assert.ok(h.state().rows.includes("subgroup:quietHours")); row(h, "subgroup:quietHours", true); assert.ok(h.state().rows.includes("item:quietHours.start"));
    home(h); row(h, "category:more", true); row(h, "category:content", true); row(h, "action:preview", true);
    assert.equal(h.state().view.kind, "preview"); assert.equal(h.calls.test.length, 0);
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
    assert.match(h.state().message.text, /本机通知：服务已接受.*邮箱通知：发送失败/);
    choose(h, "测试结果与详情 ›"); assert.match(h.frame().join(""), /服务接受不代表实际送达/);
  });
  await step("旧测试与关闭后回调不访问旧页面；新结果不串线", () => {
    const h = harness(); h.press(K.test); const old = h.calls.test[0].onProgress;
    h.press(K.test); assert.equal(h.calls.unsubscribe, 1);
    old({ id: "old", stage: "cancelled", reason: "new" }); assert.doesNotMatch(h.state().message.text, /已取消/);
    const latest = h.calls.test[1].onProgress;
    const focus = h.state().focus; latest({ id: "new", stage: "sending" }); assert.equal(h.state().focus, focus);
    h.press(K.esc); const before = h.renders(); latest({ id: "new", stage: "result", result: { providerId: "terminal", ok: true } });
    assert.equal(h.renders(), before); assert.equal(h.calls.unsubscribe, 2);
  });
  await step("同步完成的结果不被已排队提示覆盖", () => {
    const h = harness(undefined, { immediateTest(callback) {
      callback({ id: "sync", stage: "result", result: { providerId: "terminal", ok: true } });
      callback({ id: "sync", stage: "finished" });
    } });
    h.press(K.test); assert.match(h.state().message.text, /服务已接受/); assert.doesNotMatch(h.state().message.text, /已排队/);
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
    row(h, "category:channels", true); row(h, "email-config", true); row(h, "action:email-test", true);
    h.calls.test[0].onProgress({ id: "mail", stage: "result", result: { providerId: "email", ok: true } });
    h.calls.test[0].onProgress({ id: "mail", stage: "finished" });
    assert.match(h.frame().slice(0, 14).join(""), /服务已接受/);
    row(h, "action:credential-save", true); h.press("fake-new-code"); h.press(K.enter);
    assert.doesNotMatch(h.frame().slice(0, 14).join(""), /服务已接受/);
    assert.doesNotMatch(JSON.stringify(h.overlay()), /fake-new-code/);
    row(h, "item:provider:email:from", true);
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
    row(h, "category:rules", true); row(h, "item:reminders.completed"); h.press(K.space);
    row(h, "item:reminders.failed"); h.press(K.space); h.press(K.space);
    frames.push(["提醒时机", h.frame().join("\n")]);
    assert.equal(h.raw(), undefined);
    home(h); row(h, "category:channels", true); row(h, "email-config", true);
    for (const [id, text] of [["provider:email:from", "sender@qq.com"], ["provider:email:to", "reader@example.com"]]) {
      row(h, `item:${id}`, true); h.press(text); h.press(K.enter);
    }
    row(h, "action:credential-save", true); h.press("fake-journey-code"); h.press(K.enter);
    assert.equal(h.calls.test.length, 0); assert.equal(h.raw(), undefined);
    assert.equal(h.host.config().providers.find((p) => p.id === "email").enabled, false);
    row(h, "action:email-enable", true); confirm(h);
    assert.deepEqual(h.host.config().channels, ["terminal", "email"]);
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
      assert.deepEqual(deliveries.map((d) => d.id), ["terminal", "email"], `${h.state().message.text}; events=${JSON.stringify(journeyEvents)}`);
      assert.match(h.state().message.text, /本机通知：服务已接受.*邮箱通知：服务已接受/);
      frames.push(["测试结果", h.frame().join("\n")]);
      row(h, "category:channels", true); row(h, "item:channels"); h.press(K.save);
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
    row(h, "category:rules", true); row(h, "item:reminders.failed"); h.press(K.space);
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
    row(h, "item:enabled"); h.press(K.space);
    searchItem(h, "content.includeCost"); choose(h, "关闭"); home(h);
    row(h, "action:save-all", true);
    assert.match(h.frame().join(""), /将保存以下修改.*其他已打开对话不变/);
    assert.doesNotMatch(h.frame().join(""), /JSON|API|授权码/);
    h.press(K.test); assert.equal(h.calls.test.length, 0, "范围确认中快捷键不得外发");
    h.press(K.enter); assert.deepEqual(h.raw(), { api: { enabled: false }, future: "keep" });
    row(h, "action:save-all", true); h.press(K.esc);
    assert.equal(h.state().rows[h.state().focus], "action:save-all");
    h.press(K.enter); h.press(K.down); h.press(K.enter);
    assert.deepEqual(h.raw(), { api: { enabled: false }, future: "keep", enabled: false, content: { includeCost: false } });
    assert.ok(!h.state().rows.includes("action:save-all"));
    assert.equal(h.state().message, undefined);
    assert.equal(h.calls.save.length, 2);
  });
  await step("批量写入损坏 JSON 全部拒绝且保留本对话修改，首页直说降级", () => {
    const h = harness(); row(h, "item:enabled"); h.press(K.space);
    fs.writeFileSync(config.userConfigPath(h.dir), "{broken"); h.press(K.reload);
    assert.match(h.frame().join(""), /配置异常.*请查看诊断/);
    row(h, "action:save-all", true); h.press(K.down); h.press(K.enter);
    assert.match(h.state().message.text, /批量保存失败/);
    assert.equal(fs.readFileSync(config.userConfigPath(h.dir), "utf8"), "{broken");
    assert.equal(h.overlay().patch.enabled, false);
  });
  await step("邮箱完成闭环：地址、模拟凭据、明确启用、手动测试、只保存邮箱范围", () => {
    const h = harness(undefined, { vault: {} });
    row(h, "category:rules", true); row(h, "item:reminders.completed"); h.press(K.space); home(h);
    row(h, "category:channels", true); row(h, "email-config", true);
    assert.match(h.frame().join(""), /下一步：填写发件/);
    for (const [id, value] of [["from", "fake@qq.com"], ["to", "reader@example.com"]]) {
      row(h, `item:provider:email:${id}`, true);
      assert.equal(h.state().view.kind, "input"); h.press(value); h.press(K.enter);
      assert.equal(h.state().view.id, "email-config");
    }
    assert.match(h.frame().join(""), /下一步：设置 QQ 邮箱授权码/);
    row(h, "action:credential-save", true); h.press("fake-only-code"); h.press(K.enter);
    assert.match(h.frame().join(""), /配置已就绪/);
    assert.equal(h.state().message, undefined);
    assert.equal(h.calls.test.length, 0); assert.equal(h.raw(), undefined);
    row(h, "action:email-enable", true); confirm(h);
    h.press(K.test); assert.deepEqual(h.calls.test[0].channels, ["email"], "邮箱页快捷测试只能发邮箱");
    h.calls.test[0].onProgress({ id: "mail", stage: "result", result: { providerId: "email", ok: true } });
    h.calls.test[0].onProgress({ id: "mail", stage: "finished" });
    assert.match(h.frame().join(""), /服务已接受，尚未确认收件/);
    row(h, "action:save-email", true); h.press(K.down); h.press(K.enter);
    const future = config.loadConfig({ agentDir: h.dir }).config;
    assert.equal(future.providers.find((p) => p.id === "email").options.from, "fake@qq.com");
    assert.deepEqual(future.providers.find((p) => p.id === "email").options.to, ["reader@example.com"]);
    assert.equal(future.providers.find((p) => p.id === "email").enabled, true);
    assert.deepEqual(future.channels, ["terminal", "email"]);
    assert.equal(future.rules.runCompleted.enabled, true, "不夹带其它任务的修改");
    assert.equal(h.host.config().rules.runCompleted.enabled, false);
    assert.doesNotMatch(JSON.stringify(h.raw()) + JSON.stringify(h.overlay()), /fake-only-code/);
    assert.ok(!h.state().rows.includes("action:save-email"));
    assert.equal(h.state().message, undefined);
  });
  await step("邮箱失败测试引导重试，非 Windows 显示环境变量步骤而非不可执行存储", () => {
    const h = harness(undefined, { vault: {}, canManageCredentials: false });
    row(h, "category:channels", true); row(h, "email-config", true);
    assert.ok(!h.state().rows.includes("action:credential-save"));
    assert.doesNotMatch(h.frame().join(""), /PI_NOTIFY_QQ_SMTP_AUTH_CODE/);
    row(h, "qq:settings"); h.press("?");
    for (let i = 0; i < 10; i++) h.press(K.down);
    assert.match(h.frame().join(""), /PI_NOTIFY_QQ_SMTP_AUTH_CODE/);
    assert.equal(model.emailSetup(h.host.config(), true, "发送失败").test, "发送失败");
    const ready = h.host.config(); const p = ready.providers.find((p) => p.id === "email");
    Object.assign(p, { enabled: true, options: { from: "a@qq.com", to: ["b@example.com"] } }); ready.channels = ["email"];
    assert.equal(model.emailSetup(ready, true, "发送失败").test, "发送失败");
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
    row(h, "category:channels", true); row(h, "email-config", true); row(h, "item:provider:email:from", true);
    h.press("\x1b[200~long-fake-address@qq.com\x1b[201~");
    assert.ok(h.state().view.editor.focused);
    assert.ok(h.frame(40).join("").includes(tui.CURSOR_MARKER));
    h.press("\x1b[D"); h.press("\x7f");
    assert.equal(h.state().view.editor.getValue(), "long-fake-address@qq.cm");
    h.component.focused = false; assert.equal(h.state().view.editor.focused, false);
    assert.ok(!h.frame(40).join("").includes(tui.CURSOR_MARKER));
    h.press(K.esc); assert.equal(h.host.config().providers.find((p) => p.id === "email").options.from, "");
  });
  await step("授权码分块粘贴、错误与取消不会泄漏明文到渲染/快照/配置", () => {
    const h = harness(undefined, { vault: {} }); h.component.focused = true;
    row(h, "category:channels", true); row(h, "email-config", true); row(h, "action:credential-save", true);
    h.press("\x1b[20"); h.press("0~fake-secret-"); h.press("only\x1b[201~");
    assert.doesNotMatch(h.frame(40).join("") + JSON.stringify(h.state()), /fake-secret-only/);
    assert.match(h.frame(40).join(""), /●/);
    h.press(K.enter); assert.deepEqual(h.calls.credential, ["save"]);
    assert.doesNotMatch(JSON.stringify(h.raw()) + JSON.stringify(h.overlay()), /fake-secret-only/);
    row(h, "action:credential-save", true); h.press("\x1b[200~bad\nsecret\x1b[201~"); h.press(K.enter);
    assert.equal(h.state().view.kind, "secret"); assert.match(h.frame(40).join(""), /控制字符/);
    h.press(K.esc); assert.equal(h.calls.credential.length, 1);
    row(h, "action:credential-save", true); h.press("fake-disposed"); h.component.dispose();
    assert.doesNotMatch(JSON.stringify(h.state()), /fake-disposed/);
  });
  await step("范围确认超过五项可分页，未查看项目也不重复或遗漏保存", () => {
    const h = harness();
    for (const id of ["content.includeCost", "content.includeDuration", "content.includeSessionLabel", "content.includeToolFailureNames", "content.includeAssistantExcerpt", "rules.waitingForUser.enabled"]) {
      searchItem(h, id); choose(h, id === "content.includeAssistantExcerpt" || id === "rules.waitingForUser.enabled" ? "开启" : "关闭");
    }
    home(h); row(h, "action:save-all", true);
    assert.match(h.frame(40).join(""), /1–5\/6/);
    h.press("\x1b[6~"); assert.match(h.frame(40).join(""), /2–6\/6/);
    h.press(K.down); h.press(K.enter);
    assert.equal(h.calls.save.length, 6); assert.ok(!h.state().rows.includes("action:save-all"));
  });
  await step("首页渠道开关约束统一与逐规则真实投递，开启前确认且保留路由", async () => {
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
    row(h, "channel:terminal", true);
    assert.equal(h.state().view.id, "home"); assert.equal(h.state().message, undefined);
    assert.deepEqual(h.host.config().channels, ["terminal"]);
    assert.deepEqual(h.host.config().rules.runFailed.channels, ["terminal", "hook"]);
    assert.deepEqual(await deliver("completed"), []);
    assert.deepEqual(await deliver("failed"), ["hook"]);
    assert.match(h.frame().join(""), /通知部分可用/);
    row(h, "channel:terminal", true);
    assert.match(h.frame().join(""), /关闭[\s\S]*开启/);
    assert.doesNotMatch(h.frame().join(""), /适用规则：/);
    h.press(K.enter); assert.equal(h.host.config().providers.find((p) => p.id === "terminal").enabled, false);
    row(h, "channel:terminal", true); confirm(h);
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
    row(h, "channel:terminal", true); row(h, "channel:terminal", true);
    assert.doesNotMatch(h.frame().join(""), /将加入统一|适用规则：/);
    assert.match(h.frame().join(""), /关闭[\s\S]*开启/);
    confirm(h); assert.deepEqual(h.host.config().channels, []);
    assert.deepEqual(h.host.config().rules.runFailed.channels, ["terminal"]);
  });
  await step("统一选择重新开启关闭的渠道前审查逐规则恢复范围", () => {
    const h = harness({ channels: [], providers: [{ id: "terminal", type: "terminal", enabled: false }], rules: { runFailed: { channels: ["terminal"] } } });
    searchItem(h, "channels"); choose(h, "本机通知");
    assert.equal(h.state().view.kind, "confirm");
    assert.match(h.frame().join(""), /同时开启本机通知，恢复原有规则：运行失败/);
    assert.match(h.frame().join(""), /逐规则接收选择不变/);
    h.press(K.enter); assert.equal(h.host.config().providers.find((p) => p.id === "terminal").enabled, false);
    choose(h, "本机通知"); confirm(h);
    assert.equal(h.host.config().providers.find((p) => p.id === "terminal").enabled, true);
    assert.deepEqual(h.host.config().rules.runFailed.channels, ["terminal"]);
  });
  await step("未使用渠道开启需确认加入统一选择，不改逐规则空集合或关闭规则", () => {
    const h = harness({ channels: [], providers: [{ id: "terminal", type: "terminal", enabled: false }], rules: { runFailed: { channels: [] } } });
    row(h, "channel:terminal", true);
    assert.match(h.frame().join(""), /关闭[\s\S]*开启/);
    for (const width of [40, 70, 110]) {
      const frame = h.frame(width);
      assert.match(frame.join(""), /开启后加入统一接收选择；逐规则例外不变/);
      assert.match(frame.join(""), /→ 关闭[\s\S]*开启/);
      for (const line of frame) assert.ok(tui.visibleWidth(line) <= width);
    }
    assert.doesNotMatch(h.frame().join(""), /适用规则：/);
    h.press(K.enter); assert.deepEqual(h.host.config().channels, []);
    row(h, "channel:terminal", true); confirm(h);
    assert.deepEqual(h.host.config().channels, ["terminal"]);
    assert.deepEqual(h.host.config().rules.runFailed.channels, []);
    assert.equal(h.host.config().rules.waitingForUser.enabled, false);
    assert.equal(h.calls.test.length, 0);
  });
  await step("恢复默认可能重新开启渠道时也须确认，取消保留关闭状态", () => {
    const h = harness(); row(h, "channel:terminal", true); h.press("?"); h.press("a");
    assert.equal(h.state().view.kind, "confirm"); assert.equal(h.state().focus, 0);
    h.press(K.enter); assert.equal(h.host.config().providers.find((p) => p.id === "terminal").enabled, false);
    h.press("a"); confirm(h); assert.equal(h.host.config().providers.find((p) => p.id === "terminal").enabled, true);
  });
  await step("首页缺邮箱配置直接进入配置，已配置的邮箱可关闭且不发送测试", () => {
    const h = harness(undefined, { vault: {} }); row(h, "channel:email", true);
    assert.equal(h.state().view.id, "email-config"); assert.equal(h.calls.set.length, 0);
    assert.doesNotMatch(h.frame().join(""), /\b[1-5]\. /);
    assert.match(h.frame().join(""), /QQ 邮箱授权码  未设置/);
    const ready = harness({ channels: ["email"], providers: [{ id: "email", type: "email", enabled: true, options: { from: "fake@qq.com", to: ["reader@example.com"] } }] }, { vault: { value: "fake" } });
    row(ready, "channel:email", true);
    assert.equal(ready.host.config().providers.find((p) => p.id === "email").enabled, false);
    assert.equal(ready.calls.test.length, 0);
    h.host.testEmail = () => ({ ok: false, message: "未发送：请先开启通知总开关。", feedback: { kind: "blocked", next: "home" } });
    h.press(K.test); assert.match(h.frame().join(""), /返回通知设置 ›/);
    row(h, "feedback", true); assert.equal(h.state().view.id, "home");
  });
  await step("焦点移动布局稳定，常规修改/撤销/保存不输出横幅，快捷键仅在帮助", () => {
    for (const width of [40, 70, 110]) {
      const h = harness(); const height = h.frame(width).length;
      for (let i = 0; i < h.state().rows.length; i++) {
        assert.equal(h.frame(width).length, height);
        assert.doesNotMatch(h.frame(width).join(""), /Ctrl\+|Enter|↑↓|来源：|仅本对话/); h.press(K.down);
      }
      row(h, "item:enabled", true); assert.equal(h.state().message, undefined);
      assert.match(h.frame(width).join(""), /当前对话.*未保存修改/);
      h.press(K.enter); assert.ok(!h.state().rows.includes("action:save-all"));
      row(h, "category:more", true); h.press("?");
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
    row(h, "feedback", true);
    let pages = "";
    for (let i = 0; i < 60; i++) { pages += h.frame(40).join(""); h.press(K.down); }
    assert.match(pages, /FAKE_INTERNAL/); assert.match(pages, /完整诊断尾部/); assert.doesNotMatch(pages, /fake-private/);
    home(h); h.press(K.test);
    h.calls.test[1].onProgress({ id: "skip", stage: "result", result: { providerId: "terminal", ok: true, skipped: true } });
    assert.match(h.state().message.text, /未发送/); assert.doesNotMatch(h.state().message.text, /服务已接受/);
  });
  await step("邮箱测试取消、删除地址/凭据与迟到结果不构成当前验证", () => {
    const h = harness({ channels: ["email"], providers: [{ id: "email", type: "email", enabled: true, options: { from: "fake@qq.com", to: ["reader@example.com"] } }] }, { vault: { value: "fake" } });
    row(h, "category:channels", true); row(h, "email-config", true); h.press(K.test);
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
    assert.doesNotMatch(h.state().message.text, /未发送/);
    h.press(K.test); h.calls.test.at(-1).onProgress({ id: "no-result", stage: "finished" });
    assert.match(h.frame().join(""), /测试：结果未知/);
    h.press(K.test); const late = h.calls.test.at(-1).onProgress;
    row(h, "item:provider:email:to", true); for (const _ of "reader@example.com") h.press("\x7f"); h.press(K.enter);
    late({ id: "late", stage: "result", result: { providerId: "email", ok: true } });
    assert.match(h.frame().join(""), /测试：未测试/);
    row(h, "action:credential-delete", true); h.press(K.down); h.press(K.enter);
    assert.match(h.frame().join(""), /QQ 邮箱授权码  未设置/);
    assert.match(h.frame().join(""), /测试：未测试/);
    row(h, "action:email-enable", true);
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
  await step("40/70/110 列主要页面布局快照、重复渲染、焦点和滚动回归", () => {
    const frames = {};
    const h = harness(undefined, { vault: {} });
    const capture = (name) => {
      for (const width of [40, 70, 110]) {
        const frame = h.frame(width);
        assert.deepEqual(h.frame(width), frame);
        h.component.invalidate(); assert.deepEqual(h.frame(width), frame);
        for (const line of frame) assert.ok(tui.visibleWidth(line) <= width, `${name}: ${line}`);
        assert.ok(frame.some((line) => line.includes("→ ")), `${name} focus missing`);
        assert.ok(frame.every((line, index) => index === 0 || line !== "" || frame[index - 1] !== ""), "不应有固定空白");
        frames[`${name}-${width}`] = frame;
      }
    };
    capture("home");
    row(h, "item:enabled", true); capture("home-paused-pending"); h.press(K.enter);
    row(h, "channel:terminal", true); capture("home-unavailable"); h.press(K.enter); confirm(h);
    row(h, "category:rules", true); capture("reminders"); home(h);
    row(h, "category:channels", true); row(h, "email-config", true); capture("email");
    row(h, "item:provider:email:from", true); h.press("fake@qq.com"); h.press(K.enter);
    row(h, "action:save-email", true); capture("save-review"); h.press(K.esc);
    h.press(K.status); for (let i = 0; i < 24; i++) h.press(K.down); capture("diagnostics-bottom");
    assert.match(h.frame(40).join(""), /诊断行 23/);
    h.press(K.esc); assert.equal(h.state().rows[h.state().focus], "action:save-email");
    row(h, "item:provider:email:to", true); h.press("reader@example.com"); h.press(K.enter);
    row(h, "action:credential-save", true); h.press("fake-layout-only"); h.press(K.enter);
    row(h, "action:email-enable", true); confirm(h); capture("email-ready");
    h.press(K.test);
    h.calls.test[0].onProgress({ id: "snapshot", stage: "result", result: { providerId: "email", ok: false, error: "FAKE_FAILURE password=fake-layout-private" } });
    h.calls.test[0].onProgress({ id: "snapshot", stage: "finished" }); capture("email-test-failed");
    h.host.saveChanges = () => ({ ok: false, message: "保存失败：默认设置未改动，当前对话修改仍保留。", feedback: { kind: "unknown", next: "diagnostics", details: ["模拟写入失败"] } });
    row(h, "action:save-email", true); h.press(K.down); h.press(K.enter); capture("save-failed");
    const file = new URL("./fixtures/notification-layout.json", import.meta.url);
    if (process.env.PI_NOTIFY_UPDATE_LAYOUTS === "1") fs.writeFileSync(file, JSON.stringify(frames, null, 2) + "\n");
    assert.deepEqual(frames, JSON.parse(fs.readFileSync(file, "utf8")));
  });
  await step("Ctrl+O 可分页、重读动作可见，Ctrl+T 独立于业务开关", () => {
    const h = harness({ enabled: false }); h.press(K.status); assert.equal(h.state().view.id, "status"); row(h, "action:reload", true); assert.equal(h.calls.reload, 1);
    h.press(K.esc); h.press(K.test); assert.equal(h.calls.test.length, 1);
  });
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
console.log(`UI: ${passed} passed, ${failures.length} failed`);
if (failures.length) process.exitCode = 1;

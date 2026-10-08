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
const { NotifySettingsComponent } = await jiti.import("../src/ui.ts");
const { createService } = await jiti.import("../src/service.ts");
const { resolveChannels } = await jiti.import("../src/rules.ts");
const K = { up: "\x1b[A", down: "\x1b[B", enter: "\r", esc: "\x1b", space: " ", save: "\x13", test: "\x14", reload: "\x12", status: "\x0f" };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "notify-ui-kiss-"));
let serial = 0, passed = 0;
const failures = [];
async function step(name, run) { try { await run(); passed++; console.log(`  ✓ ${name}`); } catch (error) { failures.push({ name, error }); console.error(`  ✗ ${name}: ${error.stack}`); } }
function harness(raw, options = {}) {
  const dir = path.join(tmp, String(++serial));
  fs.mkdirSync(path.dirname(config.userConfigPath(dir)), { recursive: true });
  if (raw !== undefined) fs.writeFileSync(config.userConfigPath(dir), JSON.stringify(raw));
  let overlay = settings.emptyOverlay(), done = false, renders = 0;
  const calls = { set: [], save: [], test: [], reload: 0, credential: [], unsubscribe: 0 };
  const effective = () => settings.applyOverlay(config.loadConfig({ agentDir: dir }).config, overlay).config;
  const host = {
    config: effective, userRaw: () => config.readUserConfigRaw(dir).raw,
    sessionOverride: (item) => settings.sessionOverrideValue(overlay, item),
    restrictions: () => options.restrictions ?? [],
    setValue(item, value) {
      calls.set.push({ id: item.id, value });
      const next = settings.applySettingPatch(overlay, item, item.patch(value));
      const checked = settings.applyOverlay(config.loadConfig({ agentDir: dir }).config, next);
      if (checked.problems.length) return { ok: false, message: "输入有误，未应用" };
      overlay = next;
      return { ok: true, message: "已应用，仅本对话；Ctrl+S 保存为以后默认" };
    },
    saveDefault(item) {
      calls.save.push(item.id);
      const current = effective();
      const result = config.writeUserDefault(dir, (raw) => settings.settingUserFilePatch(raw, current, settings.settingSnapshot(item, current)));
      return { ok: result.ok, message: result.ok ? "已保存为以后默认，其他修改未保存" : "保存失败，文件未改动" };
    },
    followUserDefault(item) { overlay = settings.clearItemOverride(overlay, item); return { ok: true, message: "已使用以后默认" }; },
    restoreBuiltinDefault(item) {
      const result = config.deleteUserDefault(dir, settings.itemRemovals(item, effective(), overlay));
      if (result.ok) overlay = settings.clearItemOverride(overlay, item);
      return { ok: result.ok, message: result.ok ? "已恢复初始设置" : "恢复失败" };
    },
    itemScope: (item) => item.paths ? [item.label] : [item.label],
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
  await step("首页只有五个任务入口；用户语言，不暴露配置键", () => {
    const h = harness(); assert.deepEqual(h.state().rows, ["item:enabled", "category:rules", "category:channels", "action:test", "category:more"]);
    assert.match(h.frame().join(""), /仅本对话/);
    assert.doesNotMatch(h.frame().join(""), /provider|inherit|minLevel|coalesce|overlay/);
    row(h, "category:more", true); assert.deepEqual(h.state().rows.slice(0, 3), ["category:content", "category:quietHours", "category:professional"]);
  });
  await step("普通提醒仅完成/失败/等我回复，默认不改变", () => {
    const h = harness(); row(h, "category:rules", true);
    assert.deepEqual(h.state().rows, ["item:reminders.completed", "item:reminders.waiting", "item:reminders.failed"]);
    assert.equal(h.host.config().rules.waitingForUser.enabled, false);
    assert.equal(h.host.config().content.includeAssistantExcerpt, false);
  });
  await step("失败混合状态可保存但不强制归一", () => {
    const h = harness({ rules: { compactFailed: { enabled: false } } }); searchItem(h, "reminders.failed");
    h.press(K.save); assert.equal(h.raw().rules.runFailed.enabled, true); assert.equal(h.raw().rules.compactFailed.enabled, false);
    choose(h, "关闭"); assert.equal(h.host.config().rules.runFailed.enabled, false); assert.equal(h.raw().rules.runFailed.enabled, true);
  });
  await step("Enter/Space 不写文件；Ctrl+S 只保存已生效而非悬停候选", () => {
    const h = harness(); row(h, "item:enabled", true); h.press(K.down); h.press(K.save);
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
    choose(h, "关闭"); h.press(K.reload); assert.equal(h.host.config().rules.runFailed.enabled, false);
    h.press(K.esc); assert.equal(h.state().rows[h.state().focus], "item:reminders.failed");
    h.press(K.esc); assert.equal(h.state().rows[h.state().focus], "category:rules");
  });
  await step("旧规则自定义不被统一接收设置覆盖", () => {
    const h = harness({ rules: { runFailed: { channels: [] } } });
    row(h, "category:channels", true); assert.match(h.frame().join(""), /自定义|单独/);
    row(h, "item:channels", true); choose(h, "本机提醒"); assert.deepEqual(h.host.config().channels, []);
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
    choose(h, "本机提醒"); assert.deepEqual(h.host.config().rules.runCompleted.channels, ["terminal"]);
    choose(h, "本机提醒"); assert.deepEqual(h.host.config().rules.runCompleted.channels, []);
    choose(h, "跟随统一设置"); assert.equal(h.host.config().rules.runCompleted.channels, "inherit");
  });
  await step("邮箱缺配置时进入步骤页，不先开启或测试", () => {
    const h = harness(undefined, { vault: {} }); searchItem(h, "channels"); choose(h, "邮箱");
    assert.equal(h.state().view.id, "email-config"); assert.equal(h.calls.test.length, 0);
    assert.deepEqual(h.host.config().channels, ["terminal"]); assert.equal(h.host.config().providers.find((p) => p.id === "email").enabled, false);
    assert.ok(!h.state().rows.includes("item:provider:email:subjectPrefix"));
  });
  await step("配置齐全的邮箱仍需明确确认；取消不产生外发", () => {
    const h = harness({ providers: [{ id: "email", type: "email", options: { from: "sender@qq.com", to: ["reader@example.com"] } }] }, { vault: { value: "fake" } });
    searchItem(h, "channels"); choose(h, "邮箱"); assert.equal(h.state().view.kind, "confirm"); h.press(K.enter);
    assert.deepEqual(h.host.config().channels, ["terminal"]);
    choose(h, "邮箱"); confirm(h); h.press(K.save);
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
    assert.match(h.frame().join(""), /额外限制.*强制静默/); h.press(K.esc); assert.equal(h.done(), true); assert.equal(h.raw(), undefined);
  });
  await step("测试按页面选择接收方式，结果部分成功且不宣称已收到", () => {
    const h = harness({ rules: { runFailed: { channels: ["terminal", "email"] } } });
    searchItem(h, "rules.runFailed.level"); h.press(K.test);
    assert.deepEqual(h.calls.test[0].channels, ["terminal", "email"]);
    const callback = h.calls.test[0].onProgress;
    callback({ id: "t1", stage: "result", result: { providerId: "terminal", ok: true } });
    callback({ id: "t1", stage: "result", result: { providerId: "email", ok: false, error: "测试失败" } });
    callback({ id: "t1", stage: "finished" });
    assert.match(h.state().message.text, /本机提醒：已提交.*邮箱：发送失败/);
    assert.match(h.state().message.text, /不代表实际收到/);
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
    h.press(K.test); assert.match(h.state().message.text, /已提交给接收服务/); assert.doesNotMatch(h.state().message.text, /已排队/);
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
    assert.match(h.frame().slice(0, 14).join(""), /已提交给邮箱服务/);
    row(h, "action:credential-save", true); h.press("fake-new-code"); h.press(K.enter);
    assert.doesNotMatch(h.frame().slice(0, 14).join(""), /已提交给邮箱服务/);
    assert.doesNotMatch(JSON.stringify(h.overlay()), /fake-new-code/);
    row(h, "item:provider:email:from", true); choose(h, "自定义…");
    for (const _ of "sender@qq.com") h.press("\x7f");
    h.press("different@qq.com"); h.press(K.enter); h.press(K.esc);
    assert.doesNotMatch(h.frame().slice(0, 14).join(""), /已提交给邮箱服务/);
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
      row(h, `item:${id}`, true); choose(h, "自定义…"); h.press(text); h.press(K.enter); h.press(K.esc);
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
      assert.match(h.state().message.text, /本机提醒：已提交.*邮箱：已提交/);
      assert.match(h.state().message.text, /不代表实际收到/);
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
  await step("Ctrl+O 可分页、重读动作可见，Ctrl+T 独立于业务开关", () => {
    const h = harness({ enabled: false }); h.press(K.status); assert.equal(h.state().view.id, "status"); row(h, "action:reload", true); assert.equal(h.calls.reload, 1);
    h.press(K.esc); h.press(K.test); assert.equal(h.calls.test.length, 1);
  });
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
console.log(`UI: ${passed} passed, ${failures.length} failed`);
if (failures.length) process.exitCode = 1;

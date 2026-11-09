/**
 * Notification control center and navigation controller.
 * - ui-model.ts: effective state, email next steps, canonical pending changes and save scope.
 * - ui-primitives.ts: native list/input rendering and the isolated batch-save review.
 * - ui-secret.ts: bounded, masked credential input with no serializable secret state.
 *
 * Home is compact; advanced categories, per-rule candidates and source/restore details remain
 * independently reachable. Esc restores the parent's exact focus. No fixed-height blank padding.
 * All persistence, activation and silence checks stay in commands.ts; rendering never sends.
 * Ctrl+S saves only the effective focused item, not a hovered candidate or the entire page.
 */

import { Input, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import {
  CUSTOM_ROW_LABEL,
  RULE_INFOS,
  SETTING_CATEGORIES,
  buildSettingItems,
  builtinDefaultValue,
  categoryPageItems,
  collectionValue,
  hasUserDefault,
  isCurrentValue,
  providerDefinitionSource,
  ruleSummary,
  patchOperations,
  emailReadiness,
  channelLabel,
  testBlockMessage,
  routingExceptions,
  userDefaultValue,
  type SettingCategory,
  type SettingItem,
  type SettingValue,
} from "./settings.ts";
import type { NotificationConfig, TestProgress, DeliveryResult } from "./types.ts";
import { resolveChannels } from "./rules.ts";
import { sanitizeError } from "./log.ts";
import { controlStatus, emailSetup, pendingSettings, type SaveScope } from "./ui-model.ts";
import { menuList, SaveReview, textInput } from "./ui-primitives.ts";
import { SecretPrompt } from "./ui-secret.ts";

/** Only the theme capabilities used here, as method signatures, to stay SDK-palette agnostic. */
export interface SettingsTheme {
  fg(color: "accent" | "muted" | "dim" | "success" | "error" | "warning" | "text", text: string): string;
  bold(text: string): string;
}

/** Injected key parser: the host passes its keybindings manager, tests pass a stub. */
export interface SettingsKeybindings {
  matches(data: string, keybinding: string): boolean;
}

export type ItemValue = SettingValue | SettingValue[];

/**
 * Session-level restriction that overrides the user's own setting, such as forced silence.
 * Kept separate from the three value layers so the UI shows it as an extra limit instead of
 * reporting it as a user default that was turned off.
 */
export interface SettingsRestriction {
  label: string;
  reason: string;
}

export interface SettingsTestResult { ok: boolean; message: string; unsubscribe?: () => void }

export interface SettingsHost {
  /** Effective config, including this conversation's overlay. */
  config(): NotificationConfig;
  /** Raw user file, used for the presence and value of sparse user defaults. */
  userRaw(): unknown;
  runtimeState?(): { degraded?: boolean; configError?: boolean; quiet?: boolean; terminalIssue?: string };
  /** One atomic sparse write, only the reviewed canonical leaves. */
  saveChanges(items: readonly SettingItem[]): { ok: boolean; message: string };
  /**
   * Value this conversation's overlay set for the item, or undefined when Enter never touched it.
   * Presence decides "this conversation changed it"; comparing values cannot tell an override that
   * happens to equal the user default from an inherited one.
   */
  sessionOverride(item: SettingItem): unknown;
  /** Session-level restrictions that override the user's setting; empty when none apply. */
  restrictions(): SettingsRestriction[];
  /** Enter: writes the per-conversation overlay, effective immediately. */
  setValue(item: SettingItem, value: ItemValue): { ok: boolean; message: string };
  /** Ctrl+S: freezes the value as a user default with a single sparse write. */
  saveDefault(item: SettingItem, value: ItemValue): { ok: boolean; message: string };
  /** Ctrl+T: sends a test notification. */
  test(channels?: string[], onProgress?: (progress: TestProgress) => void): SettingsTestResult;
  testEmail(onProgress?: (progress: TestProgress) => void): SettingsTestResult;
  credentialStatus(): string;
  canManageCredentials?(): boolean;
  saveCredential(value: string): { ok: boolean; message: string };
  deleteCredential(): { ok: boolean; message: string };
  openQqSettings(): { ok: boolean; message: string };
  /** Ctrl+R: re-reads the config without reloading the extension. */
  reload(): { ok: boolean; message: string };
  /** Ctrl+O: read-only, paged status text. */
  statusLines(): string[];
  followUserDefault(item: SettingItem): { ok: boolean; message: string };
  restoreBuiltinDefault(item: SettingItem): { ok: boolean; message: string };
  itemScope?(item: SettingItem): string[];
  preview(): { ok: boolean; message: string; lines: string[] };
}

/** Visible list rows; the component sizes itself instead of reading the terminal height. */
const BODY_ROWS = 12;
/**
 * Content column cap: rows stop at this width even on a very wide terminal, so a label and its
 * value stay together instead of drifting apart across a 200-column window. The component still
 * respects the caller's width when the terminal is narrower.
 */
const MAX_CONTENT_WIDTH = 80;
/** Focus and current-value cells are two display columns each and stay reserved when unset. */
const FOCUS_CELL = (focused: boolean): string => (focused ? "→ " : "  ");
const CURRENT_CELL = (current: boolean): string => (current ? "✓ " : "  ");
/** Below this width the trailing ` · 默认` is dropped so the value label keeps its room. */
const DEFAULT_SUFFIX_MIN_WIDTH = 24;
/** Trailing marker of a row that opens another page. */
const OPEN_MARK = " ›";

const ACTION_LABELS: Record<"saveAll" | "saveEmail" | "test" | "emailTest" | "emailEnable" | "credentialSave" | "credentialDelete" | "status" | "reload" | "search" | "preview", string> = {
  saveAll: "保存本次修改为以后默认",
  saveEmail: "5. 保存邮箱设置为默认",
  test: "发送测试通知",
  emailTest: "4. 发送邮箱测试",
  emailEnable: "3. 确认启用邮箱并加入统一接收方式",
  credentialSave: "2. 设置邮箱授权码（遮蔽输入）",
  credentialDelete: "移除已保存的邮箱授权码",
  status: "状态与诊断",
  reload: "重新读取配置",
  search: "搜索设置",
  preview: "通知预览",
};

/** One row of a menu page (home, a category, or a rule's fields). */
type MenuRow =
  | { key: string; kind: "field"; item: SettingItem; label: string }
  | { key: string; kind: "rule"; rule: { key: string; label: string } }
  | { key: string; kind: "category"; category: SettingCategory }
  /** One row that opens the parameters a disabled feature collapsed. */
  | { key: string; kind: "subgroup"; category: SettingCategory }
  | { key: string; kind: "emailConfig"; label: string; summary: string }
  | { key: string; kind: "qqLink"; label: string }
  /** Read-only information row on the status page. */
  | { key: string; kind: "text"; text: string }
  | { key: string; kind: "action"; action: "saveAll" | "saveEmail" | "test" | "emailTest" | "emailEnable" | "credentialSave" | "credentialDelete" | "status" | "reload" | "search" | "preview" };

/** Pages that are a list of rows; `id` is stable so a refresh can rebuild the same page. */
interface MenuPage {
  kind: "menu";
  id: string;
  title: string;
  rows: MenuRow[];
  focus: number;
}

type View =
  | MenuPage
  | { kind: "detail"; itemId: string; focus: number }
  | { kind: "input"; itemId: string; buffer: string; error?: string; editor?: Input }
  | { kind: "secret"; prompt: SecretPrompt }
  | { kind: "secretConfirm"; focus: number }
  /** Read-only, pageable full field details; `a`/`d` run the restore actions. */
  | { kind: "help"; itemId: string; offset: number }
  /** Search over the complete field table; Enter opens a result even when it is otherwise hidden. */
  | { kind: "search"; query: string; focus: number; editor?: Input }
  /** Confirmation page for the destructive restore; default focus is cancel. */
  | { kind: "confirm"; itemId: string; focus: number; applyValue?: ItemValue; enableEmail?: boolean }
  /** Read-only example notification body. */
  | { kind: "preview"; lines: string[]; offset: number };

type Tone = "info" | "success" | "error";

interface Candidate {
  value: ItemValue;
  label: string;
  custom?: boolean;
  inherit?: boolean;
}

export interface NotifySettingsComponentOptions {
  theme: SettingsTheme;
  keybindings: SettingsKeybindings;
  host: SettingsHost;
  requestRender(): void;
  done(summary?: NotifySettingsSummary): void;
}

export interface NotifySettingsSummary {
  /** Number of successful Ctrl+S writes. */
  savedDefaults: number;
  /** Number of values changed in this conversation. */
  changed: number;
}

export class NotifySettingsComponent {
  private readonly theme: SettingsTheme;
  private readonly keybindings: SettingsKeybindings;
  private readonly host: SettingsHost;
  private readonly requestRender: () => void;
  private readonly finish: (summary?: NotifySettingsSummary) => void;

  private items: SettingItem[] = [];
  private view: View;
  /** Parent pages, most recent last; Esc pops so a page returns with its exact focus. */
  private history: View[] = [];
  private message?: { text: string; tone: Tone };
  private summary: NotifySettingsSummary = { savedDefaults: 0, changed: 0 };
  private cachedWidth?: number;
  private cachedLines?: string[];
  /** Content column of the last render; input handling clamps paging against it. */
  private contentWidth = MAX_CONTENT_WIDTH;
  private closed = false;
  private testGeneration = 0;
  private unsubscribeTest?: () => void;
  private emailTestLabel?: string;
  private emailTestKey?: string;
  private credentialRevision = 0;
  private saveReview?: SaveReview;
  private hasFocus = false;
  readonly capturesViewportInput = true;

  get focused(): boolean { return this.hasFocus; }
  set focused(value: boolean) {
    this.hasFocus = value;
    if (this.view?.kind === "input" || this.view?.kind === "search") this.editor().focused = value;
    this.invalidate();
  }

  private editor(): Input {
    if (this.view.kind !== "input" && this.view.kind !== "search") throw new Error("Not a text view");
    const view = this.view;
    view.editor ??= textInput(view.kind === "input" ? view.buffer : view.query);
    view.editor.focused = this.hasFocus;
    return view.editor;
  }

  private pending(scope: SaveScope = "all"): SettingItem[] {
    return pendingSettings(this.host.config(), this.host.userRaw(), (item) => this.host.sessionOverride(item), scope);
  }

  private openSaveReview(scope: SaveScope): void {
    const items = this.pending(scope);
    if (!items.length) { this.report({ ok: true, message: "没有尚未保存的修改；当前值与以后默认一致。" }); return; }
    this.saveReview = new SaveReview(items.map((item) => `${item.label}：${item.format(this.value(item))}`), this.keybindings, (save) => {
      this.saveReview = undefined;
      if (save) {
        const result = this.host.saveChanges(items);
        if (result.ok) this.summary.savedDefaults += items.length;
        this.refresh();
        this.report(result);
      }
    });
    this.message = undefined;
    this.invalidate(); this.requestRender();
  }

  private emailStateKey(): string {
    const provider = this.host.config().providers.find((entry) => entry.id === "email");
    return JSON.stringify([provider?.enabled, provider?.options.from, provider?.options.to, provider?.options.subjectPrefix, this.credentialRevision]);
  }

  /** Pi calls dispose when closing custom UI; late deliveries can only update service diagnostics. */
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.testGeneration++;
    this.unsubscribeTest?.();
    this.unsubscribeTest = undefined;
    // Drop navigation references and scrub the credential-only buffer on custom UI teardown.
    this.history = [];
    if (this.view.kind === "secret") { this.view.prompt.clear(); this.view = this.buildEmailPage(); }
    this.saveReview = undefined;
    this.invalidate();
  }

  private startTest(emailOnly = false): void {
    emailOnly ||= this.view.kind === "menu" && this.view.id === "email-config";
    this.unsubscribeTest?.();
    this.unsubscribeTest = undefined;
    const generation = ++this.testGeneration;
    const config = this.host.config();
    const field = this.focusedFieldItem();
    const ruleKey = field?.rule?.key ?? (this.view.kind === "menu" && this.view.id.startsWith("rule:") ? this.view.id.slice(5) : undefined);
    const channels = emailOnly ? ["email"] : ruleKey ? resolveChannels(config, config.rules[ruleKey as keyof NotificationConfig["rules"]]) : [...config.channels];
    const emailKey = this.emailStateKey();
    const results = new Map<string, DeliveryResult>();
    let latest: { text: string; tone: Tone } | undefined;
    let finished = false;
    const onProgress = (event: TestProgress): void => {
      if (this.closed || generation !== this.testGeneration) return;
      if (event.result) {
        results.set(event.result.providerId, event.result);
        if (event.result.providerId === "email" && emailKey === this.emailStateKey()) {
          this.emailTestKey = emailKey;
          this.emailTestLabel = event.result.ok ? "已提交给邮箱服务，请确认收件" : "邮箱测试未成功，请查看测试结果";
        }
      }
      if (event.stage === "queued") latest = { text: "测试已排队，等待发送。", tone: "info" };
      else if (event.stage === "sending") latest = { text: "测试发送中，请稍候；你可以继续配置其他项。", tone: "info" };
      else if (event.stage === "cancelled") latest = { text: testBlockMessage(event.reason ?? "disposed"), tone: "error" };
      else if (event.stage === "result" || event.stage === "finished") {
        const text = [...results.values()].map((result) => `${channelLabel(result.providerId)}：${result.skipped ? "未发送" : result.ok ? "已提交给接收服务" : "发送失败"}${result.error ? `（${sanitizeError(result.error, 160)}）` : ""}`).join("；");
        latest = { text: text ? `${text}。请确认是否看到；已提交不代表实际收到。` : "测试已结束，尚无发送结果；请查看状态与诊断。", tone: [...results.values()].some((result) => !result.ok) || !results.size ? "error" : "success" };
      }
      if (event.stage === "finished" || event.stage === "cancelled") { finished = true; this.unsubscribeTest = undefined; }
      if (latest) this.message = latest;
      if (this.view.kind === "menu" && this.view.id === "email-config") this.refresh(); else this.invalidate();
      this.requestRender();
    };
    const result = emailOnly ? this.host.testEmail(onProgress) : this.host.test(channels, onProgress);
    if (!finished) this.unsubscribeTest = result.unsubscribe;
    if (latest && result.ok) { this.message = latest; this.invalidate(); this.requestRender(); }
    else this.report(result);
  }

  constructor(options: NotifySettingsComponentOptions) {
    this.theme = options.theme;
    this.keybindings = options.keybindings;
    this.host = options.host;
    this.requestRender = options.requestRender;
    this.finish = options.done;
    this.items = buildSettingItems(this.host.config());
    this.view = this.buildHomePage();
  }

  /** Rebuilds the setting list and the current page: Ctrl+R may have changed providers or values. */
  private refresh(): void {
    this.items = buildSettingItems(this.host.config());
    if (this.view.kind === "menu") this.view = this.rebuildPage(this.view);
    else if ((this.view.kind === "detail" || this.view.kind === "input" || this.view.kind === "help" || this.view.kind === "confirm")
      && this.itemById(this.view.itemId) === undefined) {
      // The field or provider disappeared (config edited on disk): return to a valid page rather
      // than leaving a focus on a row that no longer exists.
      this.history = [];
      this.view = this.buildHomePage();
    }
    this.invalidate();
  }

  private itemById(id: string): SettingItem | undefined {
    return this.items.find((item) => item.id === id);
  }

  /** Current value, as effective in this conversation. */
  private value(item: SettingItem): unknown {
    return item.read(this.host.config());
  }

  private hasDefault(item: SettingItem): boolean {
    return hasUserDefault(this.host.userRaw(), item);
  }

  private defaultValue(item: SettingItem): unknown {
    return userDefaultValue(this.host.userRaw(), item);
  }

  private sessionValue(item: SettingItem): unknown {
    return this.host.sessionOverride(item);
  }

  // -------------------------------------------------------------------------
  // Page construction
  // -------------------------------------------------------------------------

  private buildHomePage(): MenuPage {
    const rows: MenuRow[] = [];
    const enabled = this.itemById("enabled");
    if (enabled) rows.push({ key: `item:${enabled.id}`, kind: "field", item: enabled, label: enabled.label });
    for (const id of ["rules", "channels"]) {
      const category = SETTING_CATEGORIES.find((candidate) => candidate.id === id);
      if (category) rows.push({ key: `category:${category.id}`, kind: "category", category });
    }
    rows.push({ key: "action:test", kind: "action", action: "test" });
    const more = SETTING_CATEGORIES.find((candidate) => candidate.id === "more");
    if (more) rows.push({ key: `category:${more.id}`, kind: "category", category: more });
    rows.push({ key: "action:save-all", kind: "action", action: "saveAll" });
    return { kind: "menu", id: "home", title: "通知控制中心", rows, focus: 0 };
  }

  private buildCategoryPage(category: SettingCategory): MenuPage {
    if (category.kind === "sections") {
      const rows: MenuRow[] = [];
      const threshold = this.itemById("minLevel");
      if (threshold && category.id === "professional") rows.push({ key: `item:${threshold.id}`, kind: "field", item: threshold, label: "提醒级别" });
      for (const id of category.sections ?? []) {
        const child = SETTING_CATEGORIES.find((candidate) => candidate.id === id);
        if (child) rows.push({ key: `category:${child.id}`, kind: "category", category: child });
      }
      for (const action of category.actions ?? []) rows.push({ key: action.key, kind: "action", action: action.action });
      return { kind: "menu", id: `category:${category.id}`, title: category.label, rows, focus: 0 };
    }
    if (category.kind === "rules") {
      const rows: MenuRow[] = RULE_INFOS.map((rule) => ({ key: `rule:${rule.key}`, kind: "rule", rule }));
      return { kind: "menu", id: `category:${category.id}`, title: category.label, rows, focus: 0 };
    }
    const { items, collapsed } = categoryPageItems(category, this.items, this.host.config());
    const channelItems = items;
    const rows: MenuRow[] = channelItems.map((item) => ({ key: `item:${item.id}`, kind: "field", item, label: item.label }));
    if (category.id === "channels" && !routingExceptions(this.host.config()).length) {
      const index = rows.findIndex((row) => row.key === "item:routes.unify");
      if (index >= 0) rows.splice(index, 1);
    }
    if (category.id === "channels" && this.items.some((item) => item.id === "provider:email:from")) {
      const state = emailReadiness(this.host.config(), this.host.credentialStatus() !== "未设置");
      const summary = `${state.label} · ${state.usedBy} 类提醒使用`;
      rows.push({ key: "email-config", kind: "emailConfig", label: "邮箱提醒", summary });
    }
    if (category.collapsed && collapsed.length > 0) {
      rows.push({ key: `subgroup:${category.id}`, kind: "subgroup", category });
    }
    for (const action of category.actions ?? []) rows.push({ key: action.key, kind: "action", action: action.action });
    return { kind: "menu", id: `category:${category.id}`, title: category.label, rows, focus: 0 };
  }

  /** Sub-page of the parameters a disabled feature collapsed; the rows are the hidden fields. */
  private buildSubgroupPage(category: SettingCategory): MenuPage {
    const ids = new Set(category.collapsed?.ids ?? []);
    const rows: MenuRow[] = this.items
      .filter((item) => ids.has(item.id))
      .map((item) => ({ key: `item:${item.id}`, kind: "field", item, label: item.label }));
    const label = category.collapsed?.label ?? category.label;
    return { kind: "menu", id: `subgroup:${category.id}`, title: label, rows, focus: 0 };
  }

  private canManageCredentials(): boolean { return this.host.canManageCredentials?.() ?? process.platform === "win32"; }

  private buildEmailPage(): MenuPage {
    const rows: MenuRow[] = this.items.filter((item) => item.providerId === "email" && item.group === "邮箱")
      .map((item) => ({ key: `item:${item.id}`, kind: "field" as const, item, label: `1. ${item.label}` }));
    if (this.canManageCredentials()) rows.push({ key: "action:credential-save", kind: "action", action: "credentialSave" });
    rows.push({ key: "action:email-enable", kind: "action", action: "emailEnable" });
    rows.push({ key: "action:email-test", kind: "action", action: "emailTest" });
    rows.push({ key: "action:save-email", kind: "action", action: "saveEmail" });
    rows.push({ key: "qq:settings", kind: "qqLink", label: "获取授权码：QQ 邮箱设置 ↗" });
    if (this.canManageCredentials() && this.host.credentialStatus() !== "未设置") rows.push({ key: "action:credential-delete", kind: "action", action: "credentialDelete" });
    return { kind: "menu", id: "email-config", title: "邮箱提醒", rows, focus: 0 };
  }

  /** Read-only status page: one actionable row (reload) plus the host's status lines as text rows. */
  private buildStatusPage(): MenuPage {
    const rows: MenuRow[] = [{ key: "action:reload", kind: "action", action: "reload" }];
    this.host.statusLines().forEach((text, index) => rows.push({ key: `text:${index}`, kind: "text", text }));
    return { kind: "menu", id: "status", title: "状态与诊断", rows, focus: 0 };
  }

  private buildRulePage(rule: { key: string; label: string }): MenuPage {
    const rows: MenuRow[] = this.items
      .filter((item) => item.rule?.key === rule.key)
      // The page title already names the rule, so the row label drops the repeated prefix.
      .map((item) => ({ key: `item:${item.id}`, kind: "field" as const, item, label: item.label.replace(`${rule.label} · `, "") }));
    rows.push({ key: "action:test", kind: "action", action: "test" });
    return { kind: "menu", id: `rule:${rule.key}`, title: rule.label, rows, focus: 0 };
  }

  /** Rebuilds a menu page from its stable id and keeps the focused row key when it still exists. */
  private rebuildPage(page: MenuPage): MenuPage {
    const focusedKey = page.rows[page.focus]?.key;
    let rebuilt: MenuPage;
    if (page.id === "home") rebuilt = this.buildHomePage();
    else if (page.id === "status") rebuilt = this.buildStatusPage();
    else if (page.id === "email-config") rebuilt = this.buildEmailPage();
    else if (page.id.startsWith("category:")) {
      const category = SETTING_CATEGORIES.find((candidate) => `category:${candidate.id}` === page.id);
      rebuilt = category ? this.buildCategoryPage(category) : this.buildHomePage();
    } else if (page.id.startsWith("subgroup:")) {
      const category = SETTING_CATEGORIES.find((candidate) => `subgroup:${candidate.id}` === page.id);
      rebuilt = category ? this.buildSubgroupPage(category) : this.buildHomePage();
    } else {
      const rule = RULE_INFOS.find((candidate) => `rule:${candidate.key}` === page.id);
      rebuilt = rule ? this.buildRulePage(rule) : this.buildHomePage();
    }
    const index = focusedKey === undefined ? -1 : rebuilt.rows.findIndex((row) => row.key === focusedKey);
    rebuilt.focus = index >= 0 ? index : Math.min(page.focus, Math.max(0, rebuilt.rows.length - 1));
    return rebuilt;
  }

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------

  private push(view: View): void {
    this.history.push(this.view);
    this.view = view;
    this.invalidate();
    this.requestRender();
  }

  private pop(): void {
    const previous = this.history.pop();
    if (!previous) {
      this.dispose();
      this.finish(this.summary);
      return;
    }
    this.view = previous.kind === "menu" ? this.rebuildPage(previous) : previous;
    this.invalidate();
    this.requestRender();
  }

  /** Field item the focus currently sits on: a field row on a menu page, or the open field. */
  private focusedFieldItem(): SettingItem | undefined {
    if (this.view.kind === "menu") {
      const row = this.view.rows[this.view.focus];
      return row?.kind === "field" ? row.item : undefined;
    }
    if (this.view.kind === "detail" || this.view.kind === "input" || this.view.kind === "help") {
      return this.itemById(this.view.itemId);
    }
    return undefined;
  }

  private openFocusedRow(): void {
    const view = this.view;
    if (view.kind !== "menu") return;
    const row = view.rows[view.focus];
    if (!row) return;
    if (row.kind === "field") {
      if ((view.id === "home" || view.id === "category:rules") && row.item.kind === "boolean") {
        this.commit(row.item, this.value(row.item) !== true, false);
        this.requestRender();
        return;
      }
      if (view.id === "email-config" && row.item.providerOptionPath) {
        const value = this.value(row.item);
        this.push({ kind: "input", itemId: row.item.id, buffer: Array.isArray(value) ? value.join(", ") : String(value ?? "") });
      } else this.push({ kind: "detail", itemId: row.item.id, focus: this.initialDetailFocus(row.item) });
      return;
    }
    if (row.kind === "rule") {
      this.push(this.buildRulePage(row.rule));
      return;
    }
    if (row.kind === "category") {
      this.push(this.buildCategoryPage(row.category));
      return;
    }
    if (row.kind === "subgroup") {
      this.push(this.buildSubgroupPage(row.category));
      return;
    }
    if (row.kind === "emailConfig") {
      this.push(this.buildEmailPage());
      return;
    }
    if (row.kind === "qqLink") {
      this.report(this.host.openQqSettings());
      return;
    }
    if (row.kind === "text") return;
    if (row.action === "saveAll" || row.action === "saveEmail") {
      this.openSaveReview(row.action === "saveAll" ? "all" : "email");
      return;
    }
    if (row.action === "credentialSave") {
      this.push({ kind: "secret", prompt: new SecretPrompt() });
      return;
    }
    if (row.action === "credentialDelete") {
      this.push({ kind: "secretConfirm", focus: 0 });
      return;
    }
    if (row.action === "emailEnable") {
      const config = this.host.config();
      const provider = config.providers.find((entry) => entry.id === "email");
      if (!provider?.options.from || !Array.isArray(provider.options.to) || !provider.options.to.length || this.host.credentialStatus() === "未设置") {
        this.report({ ok: false, message: "请先填写发件/收件地址并设置授权码；这些操作本身不会开启外发。" });
        return;
      }
      this.push({ kind: "confirm", itemId: "channels", focus: 0, applyValue: [...new Set([...config.channels, "email"])], enableEmail: true });
      return;
    }
    if (row.action === "emailTest") {
      this.startTest(true);
      return;
    }
    if (row.action === "status") {
      this.push(this.buildStatusPage());
      return;
    }
    if (row.action === "reload") {
      const result = this.host.reload();
      this.refresh();
      this.report(result);
      return;
    }
    if (row.action === "search") {
      this.openSearch();
      return;
    }
    if (row.action === "preview") {
      const result = this.host.preview();
      this.push({ kind: "preview", lines: result.lines, offset: 0 });
      return;
    }
    this.startTest();
  }

  private openSearch(): void {
    this.push({ kind: "search", query: "", focus: 0 });
  }

  /**
   * Space: quick toggle. Boolean fields and reminder-rule rows flip in place; a collection or
   * other complex field opens its candidate list. Other navigation and action rows do nothing.
   */
  private quickToggle(): void {
    if (this.view.kind === "menu") {
      const row = this.view.rows[this.view.focus];
      if (row?.kind === "rule") {
        const item = this.itemById(`rules.${row.rule.key}.enabled`);
        if (item) {
          this.commit(item, this.value(item) !== true, false);
          this.requestRender();
        }
        return;
      }
    }
    const item = this.focusedFieldItem();
    if (!item) return;
    if (this.view.kind === "detail") {
      const row = this.view;
      const focused = this.candidates(item)[row.focus];
      if (!focused || focused.custom) return;
      this.selectCandidate(item, focused);
      return;
    }
    if (item.kind === "boolean") {
      this.commit(item, this.value(item) !== true, false);
      this.requestRender();
      return;
    }
    this.push({ kind: "detail", itemId: item.id, focus: this.initialDetailFocus(item) });
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    // Never wider than the caller's width; the cap only shortens wide terminals. A non-positive
    // width yields a single empty row so the row-width contract still holds.
    const content = Math.min(width, MAX_CONTENT_WIDTH);
    if (content <= 0) {
      this.cachedWidth = width;
      this.cachedLines = [""];
      return this.cachedLines;
    }
    this.contentWidth = content;
    const lines: string[] = [];
    lines.push(truncateToWidth(this.theme.fg("accent", this.theme.bold(this.saveReview ? "保存为以后默认 · 确认范围" : this.titleText())), content));
    if (this.saveReview) return [lines[0], ...this.saveReview.render(content, this.theme)];
    lines.push(...this.contextLines(content));
    lines.push(...this.bodyLines(content));
    lines.push(...this.helpLines(content));
    const position = this.positionInfo();
    if (position && !(this.view.kind === "menu")) lines.push(this.theme.fg("dim", position));
    for (const line of this.restrictionLines(content)) lines.push(line);
    for (const hint of this.footerHints(content)) lines.push(...wrapTextWithAnsi(this.theme.fg("dim", hint), content));
    const message = this.message;
    const paint = message ? this.colorForTone(message.tone) : (text: string) => this.theme.fg("dim", text);
    const messageText = message?.text ?? "";
    // Bounded and wrapped, so the item name, scope and failure text stay readable without a long
    // message pushing the list off screen.
    if (messageText) for (const line of this.boundedWrap(messageText, content, 3)) lines.push(truncateToWidth(paint(line), content));
    this.cachedWidth = width;
    this.cachedLines = lines.map((line) => truncateToWidth(line, content));
    return this.cachedLines;
  }

  private contextLines(width: number): string[] {
    if (this.view.kind !== "menu") return [];
    const config = this.host.config();
    const lines: string[] = [];
    if (this.view.id === "home") {
      const state = controlStatus(config, { ...this.host.runtimeState?.(), restrictions: this.host.restrictions(), hasCredential: this.host.credentialStatus() !== "未设置" });
      lines.push(...wrapTextWithAnsi(this.theme.fg(state.tone, `当前：${state.label}`), width));
      for (const note of state.notes) lines.push(...wrapTextWithAnsi(this.theme.fg("warning", note), width));
      lines.push(...wrapTextWithAnsi(this.theme.fg("dim", `修改仅本对话即时生效 · ${this.pending().length} 项尚未保存`), width));
    }
    if (this.view.id === "email-config") {
      const setup = emailSetup(config, this.host.credentialStatus() !== "未设置", this.emailTestKey === this.emailStateKey() ? this.emailTestLabel : undefined, this.pending("email").length);
      for (const text of [setup.conditions, `下一步：${setup.next}`, `测试：${setup.test}`]) lines.push(...wrapTextWithAnsi(this.theme.fg("muted", text), width));
      if (!this.canManageCredentials()) lines.push(...wrapTextWithAnsi(this.theme.fg("dim", "授权码：用 PI_NOTIFY_QQ_SMTP_AUTH_CODE 注入；界面安全存储仅支持 Windows。"), width));
      if (routingExceptions(config).length) lines.push(...wrapTextWithAnsi(this.theme.fg("warning", "有提醒单独设置接收方式；启用邮箱不会改写这些例外。"), width));
    }
    return lines;
  }

  /**
   * Wraps `text` and keeps at most `maxLines` rows. A very long channel id or a long collection
   * value therefore cannot turn the help into dozens of rows and squeeze out the interaction area;
   * the clipped tail ends in an ellipsis.
   */
  private boundedWrap(text: string, width: number, maxLines: number): string[] {
    const limit = Math.max(1, maxLines * width - 2);
    const clipped = truncateToWidth(text, limit, "…");
    return wrapTextWithAnsi(clipped, width).slice(0, maxLines);
  }

  private colorForTone(tone: Tone): (text: string) => string {
    if (tone === "success") return (text) => this.theme.fg("success", text);
    if (tone === "error") return (text) => this.theme.fg("error", text);
    return (text) => this.theme.fg("muted", text);
  }

  /**
   * Footer keys available for the current focus: a category/rule/text row cannot be saved or
   * toggled, so its footer does not advertise those keys.
   */
  private footerHints(width: number): string[] {
    const view = this.view;
    if (view.kind === "input") return ["Enter 应用   Esc 取消"];
    if (view.kind === "secret") return ["输入不显示明文   Enter 保存到 Windows 凭据管理器   Esc 取消"];
    if (view.kind === "secretConfirm") return ["↑↓ 选择   Enter 确认   Esc 取消（默认取消）"];
    if (view.kind === "search") return ["输入以筛选   ↑↓ 选择   Enter 打开   Esc 返回"];
    if (view.kind === "confirm") return ["↑↓ 选择   Enter 确认   Esc 取消（默认取消）"];
    if (view.kind === "preview") return ["↑↓ 滚动   Esc 返回"];
    if (view.kind === "help") return ["a 沿用以后默认 · d 恢复内置默认", "↑↓ 滚动 · Esc 返回"];
    if (view.kind === "menu" && view.id === "status") return ["↑↓ / PgUp/PgDn 滚动 · Esc 返回", "Ctrl+R 重读 · Ctrl+T 测试通知"];
    if (view.kind === "menu" && view.rows[view.focus]?.kind === "rule") {
      return ["↑↓ 移动 · Space 开关 · Enter 详情 · Esc 返回"];
    }
    if (view.kind === "menu" && view.rows[view.focus]?.kind !== "field") {
      return ["↑↓ 移动 · Enter 打开 / 执行 · Esc 返回", ...(view.id === "home" ? ["/ 搜索 · Ctrl+T 测试通知 · Ctrl+O 诊断"] : [])];
    }
    const item = this.focusedFieldItem();
    if (view.kind === "menu" && (view.id === "home" || view.id === "category:rules") && item?.kind === "boolean") {
      return ["↑↓ 移动 · Enter/Space 开关 · Esc 返回", "Ctrl+S 设为以后默认 · ? 来源与恢复"];
    }
    const toggle = item?.kind === "boolean" ? "Space 开关" : this.view.kind === "detail" && item?.kind === "collection" ? "Space 多选" : "";
    if (width < 50) return ["↑↓ 移动 · Enter 修改 · Esc 返回", ...(toggle ? [toggle] : []), "Ctrl+S 设为以后默认 · ? 来源与恢复"];
    return [`↑↓ 移动 · Enter 修改${toggle ? ` · ${toggle}` : ""} · Esc 返回`, "Ctrl+S 设为以后默认 · ? 来源与恢复"];
  }

  /**
   * Always-visible extra restrictions (forced silence). They override the switches below, so they
   * are labelled as limits instead of being folded into the value or reported as a user default.
   */
  private restrictionLines(width: number): string[] {
    const restrictions = this.host.restrictions();
    if (restrictions.length === 0) return [];
    const text = `额外限制：${restrictions.map((item) => `${item.label}（${item.reason}）`).join("、")} — 会话级限制，覆盖开关，不代表你的默认被关闭`;
    return this.boundedWrap(text, width, 2).map((line) => truncateToWidth(this.theme.fg("warning", line), width));
  }

  private titleText(): string {
    const view = this.view;
    if (view.kind === "menu") return view.title;
    if (view.kind === "search") return "搜索设置";
    if (view.kind === "preview") return "通知预览";
    if (view.kind === "secret") return "设置邮箱授权码";
    if (view.kind === "secretConfirm") return "移除邮箱授权码";
    const item = this.itemById(view.itemId);
    if (!item) return "通知";
    if (view.kind === "input") return `${item.providerOptionPath ? "填写" : "修改"}${item.label}`;
    if (view.kind === "help") return `字段说明 · ${item.label}`;
    if (view.kind === "confirm") return `${view.applyValue === undefined ? "恢复默认" : "确认应用（仅本对话）"} · ${item.label}`;
    return item.label;
  }

  /**
   * Only the source below a field; do not repeat its label/value or the keyboard footer.
   * Full three-layer details remain pageable via `?`.
   */
  private helpLines(width: number): string[] {
    const view = this.view;
    if (view.kind === "help" || view.kind === "input" || view.kind === "secret" || view.kind === "secretConfirm" || view.kind === "search" || view.kind === "confirm" || view.kind === "preview") return [];
    const lines: string[] = [];
    if (view.kind === "menu" && view.id.startsWith("rule:")) {
      const ruleKey = view.id.slice("rule:".length);
      const rule = (this.host.config().rules as Record<string, { enabled?: boolean }>)[ruleKey];
      // A disabled rule keeps its fields editable; the note explains when they take effect instead
      // of hiding them or implying they do something right now.
      if (rule && rule.enabled !== true) lines.push("该规则已关闭：下面的开关与参数仍可配置，启用后生效");
    }
    const item = this.focusedFieldItem();
    if (item) {
      const source = this.sessionValue(item) === undefined ? "以后默认" : this.sessionValue(item) === "partial" ? "部分本对话覆盖" : "本对话覆盖";
      if (!(view.kind === "menu" && view.id === "home")) lines.push(`来源：${source}`);
    }
    if (lines.length === 0) return [];
    return this.dim(this.boundedWrap(lines.join("  "), width, 3), width);
  }

  private dim(lines: string[], width: number): string[] {
    return lines.map((line) => truncateToWidth(this.theme.fg("dim", line), width));
  }

  /**
   * Logical rows of the read-only field details. Every layer is spelled out; the rows are wrapped
   * at render time without truncation (a long channel id breaks across rows but is never cut), and
   * paging shows them a page at a time.
   */
  private helpTextLines(item: SettingItem): string[] {
    const current = item.format(this.value(item));
    const override = this.sessionValue(item);
    const lines = [
      `设置项：${item.group} · ${item.label}`,
      `当前值：${current}`,
      override === undefined
        ? "本对话：使用以后默认"
        : `本对话：${override === "partial" ? "部分已修改" : "已修改"}（${item.format(override)}），只影响这次对话`,
      this.hasDefault(item)
        ? `用户默认：${item.format(this.defaultValue(item))}（已写入用户文件，Enter 改本对话、Ctrl+S 更新用户默认）`
        : "用户默认：未设置（跟随内置默认；Ctrl+S 把当前值写为以后默认）",
      `内置默认：${item.format(builtinDefaultValue(item))}`,
    ];
    if (item.id === "enabled") {
      // Forced silence is a session-level limit over the switch, not a user default of "off"; the
      // detail view says so instead of letting the two read as one setting.
      for (const restriction of this.host.restrictions()) {
        lines.push(`额外限制：${restriction.label}（${restriction.reason}）—— 会话级限制，覆盖上面的开关，不等于你把通知默认关掉了`);
      }
    }
    if (item.providerId !== undefined) {
      const fromUser = providerDefinitionSource(item, this.host.userRaw()) === "user";
      lines.push(`渠道定义：${fromUser ? "由用户配置（用户文件中定义，可能与同名内置渠道不同）" : "出厂默认"}`);
      lines.push("说明：渠道凭据（URL、headers、密钥引用）只存在于配置文件，界面不显示也不写入");
    }
    if (item.paths || item.destinations) lines.push(`影响范围：${(this.host.itemScope?.(item) ?? item.paths ?? [item.userPath]).join("、")}`);
    if (item.destinations) lines.push(`自定义例外：${routingExceptions(this.host.config()).join("、") || "无"}；取消统一选择不会关闭例外使用的渠道。`);
    if (item.id === "reminders.completed") lines.push("执行完成只表示 Pi 停止自动执行，不保证业务目标成功。");
    if (item.id === "reminders.failed") lines.push("包含运行失败和上下文压缩失败，不包括每次可恢复工具失败。");
    if (item.inputHint) lines.push(`输入：${item.inputHint}`);
    // “Not effective right now” is spelled out instead of hiding the field: search and the restored
    // pages must be able to reach a parameter a disabled feature currently ignores.
    const inactive = this.inactiveReason(item);
    if (inactive !== undefined) lines.push(`尚未生效：${inactive}`);
    // Independent action area of the field detail page.
    const overridden = this.sessionValue(item) !== undefined;
    lines.push(`操作：a 沿用以后默认（只清除本对话覆盖${overridden ? "" : "；当前未覆盖"}）`);
    lines.push("操作：d 恢复此项内置默认（确认后同时清除用户默认与本对话覆盖）");
    return lines;
  }

  /** Why an item is currently ignored, or undefined when it is live. */
  private inactiveReason(item: SettingItem): string | undefined {
    const config = this.host.config();
    if (item.visible && !item.visible(config)) {
      return item.id === "coalesce.toolFailureWindowMs"
        ? "当前工具失败策略为“并入结果”，此参数只在“立即提醒”下生效"
        : "当前配置下此参数不生效";
    }
    if (item.rule) {
      const rule = (config.rules as Record<string, { enabled?: boolean }>)[item.rule.key];
      if (rule && rule.enabled !== true) return `所属规则“${item.rule.label}”已关闭，启用后生效`;
    }
    if (item.id.startsWith("quietHours.") && item.id !== "quietHours.enabled" && !config.quietHours.enabled) {
      return "免打扰未开启，启用后生效";
    }
    return undefined;
  }

  /** Full-detail rows wrapped to `width`; nothing is truncated here. */
  private helpRows(item: SettingItem, width: number): string[] {
    const rows: string[] = [];
    const wrapWidth = Math.max(1, width);
    for (const logical of this.helpTextLines(item)) {
      for (const line of wrapTextWithAnsi(logical, wrapWidth)) rows.push(line);
    }
    return rows;
  }

  /** Position hint, present only when the list overflows; it never takes row width. */
  private positionInfo(): string | undefined {
    const total = this.totalRows();
    if (total <= BODY_ROWS) return undefined;
    const visible = Math.min(BODY_ROWS, total);
    const start = Math.min(Math.max(0, this.scrollOf()), Math.max(0, total - BODY_ROWS));
    return `${start + 1}–${start + visible}/${total}`;
  }

  private totalRows(): number {
    if (this.view.kind === "menu") return this.view.rows.length;
    if (this.view.kind === "detail") {
      const item = this.itemById(this.view.itemId);
      return item ? this.candidates(item).length : 0;
    }
    if (this.view.kind === "help") {
      const item = this.itemById(this.view.itemId);
      return item ? this.helpRows(item, this.contentWidth).length : 0;
    }
    if (this.view.kind === "search") return this.searchResults().length;
    if (this.view.kind === "confirm" || this.view.kind === "secretConfirm") return 2;
    if (this.view.kind === "preview") return this.view.lines.length;
    return 0;
  }

  private scrollOf(): number {
    if (this.view.kind === "menu") return this.centeredScroll(this.view.focus, this.totalRows());
    if (this.view.kind === "detail") return this.centeredScroll(this.view.focus, this.totalRows());
    if (this.view.kind === "search") return this.centeredScroll(this.view.focus, this.totalRows());
    if (this.view.kind === "help") return this.view.offset;
    if (this.view.kind === "preview") return this.view.offset;
    return 0;
  }

  private bodyLines(width: number): string[] {
    if (this.view.kind === "menu") return this.menuLines(width);
    if (this.view.kind === "detail") return this.detailLines(width);
    if (this.view.kind === "input") return this.inputLines(width);
    if (this.view.kind === "secret") return this.secretLines(width);
    if (this.view.kind === "secretConfirm") return this.secretConfirmLines(width);
    if (this.view.kind === "help") return this.helpViewLines(width);
    if (this.view.kind === "search") return this.searchLines(width);
    if (this.view.kind === "confirm") return this.confirmLines(width);
    if (this.view.kind === "preview") return this.previewLines(width);
    return [];
  }

  /** Complete-table search: id, group, label, provider id, rule label and the input hint. */
  private searchResults(): SettingItem[] {
    const view = this.view;
    if (view.kind !== "search") return [];
    const query = view.query.trim().toLowerCase();
    if (query === "") return this.items;
    return this.items.filter((item) => [item.id, item.group, item.label, item.providerId ?? "", item.rule?.label ?? "", item.inputHint ?? ""]
      .join(" ")
      .toLowerCase()
      .includes(query));
  }

  private searchLines(width: number): string[] {
    const view = this.view;
    if (view.kind !== "search") return [];
    const results = this.searchResults();
    const lines: string[] = [
      ...this.editor().render(width),
      truncateToWidth(this.theme.fg("dim", results.length === 0 ? "没有匹配的设置" : `${results.length} 项匹配（含当前不生效的字段）`), width),
    ];
    const rows = results.map((item, index) => {
      const path = item.rule ? `通知规则 › ${item.rule.label}` : item.group;
      const inactive = this.inactiveReason(item);
      const mark = inactive === undefined ? "" : " · 未生效";
      const head = `${FOCUS_CELL(index === view.focus)}${item.label}${mark}`;
      const tail = `  ${path}`;
      const room = width - visibleWidth(tail);
      const text = visibleWidth(head) > room ? truncateToWidth(head, Math.max(3, room), "…") : head;
      return truncateToWidth(`${text}${tail}`, width);
    });
    return [...lines, ...this.window(rows, this.centeredScroll(view.focus, rows.length))];
  }

  /** Confirmation page: field, current value, resulting value, then cancel (default) and confirm. */
  private confirmLines(width: number): string[] {
    const view = this.view;
    if (view.kind !== "confirm") return [];
    const item = this.itemById(view.itemId);
    if (!item) return [];
    if (view.applyValue !== undefined) {
      const scope = item.id === "routes.unify" ? ["六类提醒的接收方式"] : ["统一接收方式", "新选中的接收方式开关"];
      const text = item.id === "routes.unify" ? `将统一设置：${routingExceptions(this.host.config()).join("、") || "全部提醒"}；不改变提醒时机和重要程度。`
        : "提醒将发送到你选中的接收方式；单独设置了接收方式的提醒保持不变。";
      return [...this.boundedWrap(text, width, 5), ...this.boundedWrap(`影响范围：${scope.join("、")}；仅本对话，Ctrl+S 才保存长期默认。`, width, 4),
        `${FOCUS_CELL(view.focus === 0)}取消`, `${FOCUS_CELL(view.focus === 1)}确认应用`].slice(0, BODY_ROWS);
    }
    const lines = [
      `字段：${item.group} · ${item.label}`,
      `当前值：${item.format(this.value(item))}`,
      item.providerId !== undefined
        ? `恢复后：内置默认（${item.format(builtinDefaultValue(item))}），并清除用户文件里此项与本对话覆盖`
        : `恢复后：${item.format(builtinDefaultValue(item))}，并清除用户默认与本对话覆盖`,
      `影响范围：${(this.host.itemScope?.(item) ?? item.paths ?? [item.userPath]).join("、")}；其他字段与渠道定义不动`,
      "",
      `${FOCUS_CELL(view.focus === 0)}取消`,
      `${FOCUS_CELL(view.focus === 1)}确认恢复`,
    ];
    return lines.slice(0, BODY_ROWS).map((line) => truncateToWidth(line, width));
  }

  private previewLines(width: number): string[] {
    const view = this.view;
    if (view.kind !== "preview") return [];
    const rows = view.lines.map((line) => truncateToWidth(line, width));
    return this.window(rows, view.offset);
  }

  /** Read-only details page: the wrapped rows, windowed by the stored offset. */
  private helpViewLines(width: number): string[] {
    const view = this.view;
    if (view.kind !== "help") return [];
    const item = this.itemById(view.itemId);
    if (!item) return [];
    const rows = this.helpRows(item, width).map((line) => truncateToWidth(line, width));
    return this.window(rows, view.offset);
  }

  private menuLines(width: number): string[] {
    const view = this.view;
    if (view.kind !== "menu") return [];
    const labels = view.rows.map((row) => this.menuRow(row, false, Math.max(5, width)).slice(2));
    return menuList(labels, view.focus, width, BODY_ROWS, this.theme);
  }

  private detailLines(width: number): string[] {
    const view = this.view;
    if (view.kind !== "detail") return [];
    const item = this.itemById(view.itemId);
    if (!item) return [];
    const rows = this.candidates(item).map((candidate, index) => this.candidateRow(item, candidate, index, view.focus, width));
    return this.window(rows, this.centeredScroll(view.focus, rows.length));
  }

  /** Scroll offset that keeps the focused row visible, roughly centered below the first rows. */
  private centeredScroll(focus: number, total: number): number {
    if (total <= BODY_ROWS) return 0;
    const half = Math.floor(BODY_ROWS / 2);
    return Math.min(Math.max(0, focus - half), total - BODY_ROWS);
  }

  private secretLines(width: number): string[] {
    const view = this.view;
    if (view.kind !== "secret") return [];
    return view.prompt.render(width, this.hasFocus);
  }

  private secretConfirmLines(width: number): string[] {
    const view = this.view;
    if (view.kind !== "secretConfirm") return [];
    return ["取消", "确认移除（环境变量仍可作为回退）"]
      .map((label, index) => truncateToWidth(`${FOCUS_CELL(index === view.focus)}${label}`, width));
  }

  private inputLines(width: number): string[] {
    const view = this.view;
    if (view.kind !== "input") return [];
    const item = this.itemById(view.itemId);
    if (!item) return [];
    const lines: string[] = [];
    // Field name and the unit/range are rendered as their own wrapped rows, never as a single
    // truncatable title, so the constraint stays reachable at any width.
    const heading = [`字段：${item.group} · ${item.label}`, `范围：${item.inputHint ?? "自由输入"}`];
    for (const logical of heading) {
      for (const line of wrapTextWithAnsi(logical, Math.max(1, width))) {
        lines.push(truncateToWidth(this.theme.fg("muted", line), width));
      }
    }
    lines.push(...this.editor().render(width));
    if (view.error) {
      for (const line of wrapTextWithAnsi(view.error, width)) lines.push(truncateToWidth(this.theme.fg("error", line), width));
    }
    return lines.slice(0, BODY_ROWS);
  }

  /** Slice around the focused row; the position hint lives in the hint line, not on these rows. */
  private window(rows: string[], scroll: number): string[] {
    if (rows.length <= BODY_ROWS) return rows;
    const start = Math.min(Math.max(0, scroll), Math.max(0, rows.length - BODY_ROWS));
    return rows.slice(start, start + BODY_ROWS);
  }

  /** Marker of a row that opens another page, appended after the label. */
  private openMark(row: MenuRow): string {
    if (row.kind === "category" || row.kind === "rule" || row.kind === "subgroup" || row.kind === "emailConfig") return OPEN_MARK;
    if (row.kind === "action" && row.action === "status") return OPEN_MARK;
    return "";
  }

  /**
   * Menu row: `→ label   summary ›`.
   *
   * The label wins the width: the summary yields first and is truncated with an ellipsis, so at a
   * narrow terminal a category or rule is still identifiable instead of every row starting with
   * `…`. The value/summary sits directly after the label rather than at the terminal edge.
   */
  private menuRow(row: MenuRow, focused: boolean, width: number): string {
    const focus = FOCUS_CELL(focused);
    const mark = this.openMark(row);
    if (row.kind === "action") {
      const scope = row.action === "saveAll" ? "all" : row.action === "saveEmail" ? "email" : undefined;
      const label = scope ? `${ACTION_LABELS[row.action]} · ${this.pending(scope).length} 项` : ACTION_LABELS[row.action];
      return truncateToWidth(`${focus}${label}${mark}`, width);
    }
    if (row.kind === "qqLink") {
      const label = truncateToWidth(row.label, Math.max(0, width - 2));
      return `${focus}${label}`;
    }
    if (row.kind === "text") {
      return truncateToWidth(`${focus}${row.text}`, width);
    }
    const summary = row.kind === "field"
      ? row.item.format(this.value(row.item))
      : row.kind === "rule"
        ? ruleSummary(this.host.config(), this.items, row.rule.key)
        : row.kind === "subgroup"
          ? row.category.collapsed?.note ?? ""
          : row.kind === "emailConfig" ? row.summary : row.category.summary(this.host.config());
    const label = row.kind === "field"
      ? row.label
      : row.kind === "rule"
        ? row.rule.label
        : row.kind === "subgroup"
          ? row.category.collapsed?.label ?? row.category.label
          : row.kind === "emailConfig" ? row.label : row.category.label;
    const gap = "  ";
    if (row.kind === "field") {
      // A field's current value is its headline: the value keeps its room and the label yields.
      const head = `${focus}${label}`;
      const suffix = `${gap}${summary}`;
      const available = Math.max(Math.min(visibleWidth(head), Math.floor(width * 0.55)), width - visibleWidth(suffix) - visibleWidth(mark));
      const text = visibleWidth(head) > available ? truncateToWidth(head, Math.max(3, available), "…") : head;
      return truncateToWidth(`${text}${suffix}${mark}`, width);
    }
    // Category/rule/subgroup rows: the label is the identity and wins; the summary is auxiliary and
    // is the part that gets truncated.
    const head = `${focus}${label}`;
    const labelText = visibleWidth(head) > width - visibleWidth(mark)
      ? truncateToWidth(head, Math.max(3, width - visibleWidth(mark)), "…")
      : head;
    const remaining = width - visibleWidth(labelText) - visibleWidth(mark);
    let tail = summary === "" ? "" : `${gap}${summary}`;
    if (visibleWidth(tail) > remaining) {
      const room = remaining - visibleWidth(gap);
      tail = room <= 1 ? "" : `${gap}${truncateToWidth(summary, room, "…")}`;
    }
    return truncateToWidth(`${labelText}${tail}${mark}`, width);
  }

  /**
   * Candidate row: focus and current-value cells (two columns each, always reserved), then the
   * readable value label, then a trailing ` · 默认`. Markers and suffix are given width
   * first; the label takes what is left and is truncated with an ellipsis.
   */
  private candidateRow(item: SettingItem, candidate: Candidate, index: number, focusIndex: number, width: number): string {
    const current = this.value(item);
    const isCurrent = !candidate.custom && (candidate.inherit ? current === "inherit" : isCurrentValue(item.kind, current, candidate.value as SettingValue));
    const isDefault = !candidate.custom && this.isDefaultCandidate(item, candidate, current);
    const suffix = isDefault && width >= DEFAULT_SUFFIX_MIN_WIDTH ? " · 默认" : "";
    const reserved = visibleWidth(suffix);
    let label = candidate.label;
    const room = Math.max(2, width - 4 - reserved - 1);
    if (visibleWidth(label) > room) label = truncateToWidth(label, room, "…");
    const head = `${FOCUS_CELL(index === focusIndex)}${CURRENT_CELL(isCurrent)}${label}`;
    const pad = Math.max(1, width - reserved - visibleWidth(head));
    const line = truncateToWidth(`${head}${" ".repeat(pad)}${suffix}`, width);
    return index === focusIndex ? this.theme.fg("accent", line) : line;
  }

  /** True when this candidate is the saved user default; collections match by membership. */
  private isDefaultCandidate(item: SettingItem, candidate: Candidate, current: unknown): boolean {
    if (!this.hasDefault(item)) return false;
    const fallback = this.defaultValue(item);
    if (candidate.inherit) return fallback === "inherit";
    if (item.kind === "collection") {
      return Array.isArray(fallback) && fallback.includes(candidate.value as SettingValue);
    }
    if (fallback === candidate.value) return true;
    // Numbers and times: the saved default may be outside the preset list, so align by the
    // formatted text; rows added for exactly that case land here.
    return current !== undefined && item.format(fallback) === candidate.label && isCurrentValue(item.kind, current, candidate.value as SettingValue);
  }

  private candidates(item: SettingItem): Candidate[] {
    const config = this.host.config();
    const rows: Candidate[] = item.candidates(config).map((candidate) => ({ value: candidate.value, label: candidate.label }));
    if (item.id.startsWith("rules.") && item.id.endsWith(".channels")) rows.unshift({ value: "inherit", label: "跟随统一设置", inherit: true });
    if (item.kind !== "collection" && !item.paths) {
      // The current value or the saved default may be outside the preset list: add a row so the
      // marker column always has somewhere to land.
      const known = new Set(rows.map((row) => String(row.value)));
      for (const extra of [this.value(item), this.defaultValue(item)]) {
        if (extra === undefined || known.has(String(extra))) continue;
        known.add(String(extra));
        rows.push({ value: extra as SettingValue, label: item.format(extra) });
      }
    }
    if (item.parseInput) rows.push({ value: "", label: CUSTOM_ROW_LABEL, custom: true });
    return rows;
  }

  /** On entering the detail view, focus the row holding the current value: that is what users
   * most often want to change. */
  private initialDetailFocus(item: SettingItem): number {
    const current = this.value(item);
    const index = this.candidates(item)
      .findIndex((row) => !row.custom && isCurrentValue(item.kind, current, row.value as SettingValue));
    return index >= 0 ? index : 0;
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  handleInput(data: string): void {
    if (this.closed) return;
    if (this.saveReview) {
      this.saveReview.handleInput(data);
      this.invalidate(); this.requestRender();
      return;
    }
    if (this.view.kind === "secret") {
      this.handleSecretInput(data);
      return;
    }
    if (this.view.kind === "secretConfirm") {
      this.handleSecretConfirmInput(data);
      return;
    }
    if (this.view.kind === "input") {
      this.handleInputView(data);
      return;
    }
    if (this.view.kind === "search") {
      // A text field: Ctrl+S/T/R/O are not handled here, so typing a query can never save or send.
      this.handleSearchInput(data);
      return;
    }
    if (this.view.kind === "confirm") {
      this.handleConfirmInput(data);
      return;
    }
    if (this.view.kind === "preview") {
      this.handlePreviewInput(data);
      return;
    }
    if (this.view.kind === "help") {
      // Read-only paging plus the two restore actions; nothing here writes unless a/d is pressed.
      this.handleHelpInput(data);
      return;
    }
    if (data === "/") {
      // `/` is a local shortcut inside the component (no global shortcut is registered).
      this.openSearch();
      return;
    }
    if (matchesKey(data, Key.ctrl("s"))) {
      this.saveFocusedDefault();
      return;
    }
    if (matchesKey(data, Key.ctrl("t"))) {
      this.startTest();
      return;
    }
    if (matchesKey(data, Key.ctrl("r"))) {
      // Re-reading changes the effective config, so the page is rebuilt while the current view
      // and focus are preserved.
      const result = this.host.reload();
      this.refresh();
      this.report(result);
      return;
    }
    if (matchesKey(data, Key.ctrl("o"))) {
      this.push(this.buildStatusPage());
      return;
    }
    if (data === "?") {
      // Explicit entry to the pageable field details; this view is kept on the history stack so
      // Esc restores it.
      const item = this.focusedFieldItem();
      if (item) {
        this.push({ kind: "help", itemId: item.id, offset: 0 });
        return;
      }
    }
    if (data === " ") {
      this.quickToggle();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.pop();
      return;
    }
    if (this.view.kind === "menu") this.handleMenuInput(data);
    else this.handleDetailInput(data);
  }

  /** Search is a text input: characters filter, Enter opens the focused result, Esc returns. */
  private handleSearchInput(data: string): void {
    const view = this.view;
    if (view.kind !== "search") return;
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.pop();
      return;
    }
    const results = this.searchResults();
    if (this.keybindings.matches(data, "tui.select.up")) this.moveSearch(view.focus - 1, results.length);
    else if (this.keybindings.matches(data, "tui.select.down")) this.moveSearch(view.focus + 1, results.length);
    else if (this.keybindings.matches(data, "tui.select.pageUp")) this.moveSearch(view.focus - BODY_ROWS, results.length);
    else if (this.keybindings.matches(data, "tui.select.pageDown")) this.moveSearch(view.focus + BODY_ROWS, results.length);
    else if (this.keybindings.matches(data, "tui.select.confirm")) {
      const item = results[view.focus];
      if (item) this.push({ kind: "detail", itemId: item.id, focus: this.initialDetailFocus(item) });
    } else {
      const editor = this.editor();
      editor.handleInput(data);
      this.setSearchQuery(editor.getValue());
    }
  }

  private setSearchQuery(query: string): void {
    if (this.view.kind !== "search") return;
    this.view = { ...this.view, query, focus: 0 };
    this.invalidate();
    this.requestRender();
  }

  private moveSearch(next: number, total: number): void {
    if (this.view.kind !== "search") return;
    this.view = { ...this.view, focus: Math.min(Math.max(0, next), Math.max(0, total - 1)) };
    this.invalidate();
    this.requestRender();
  }

  /** Confirmation page: default focus is cancel, so Enter never destroys anything by accident. */
  private handleConfirmInput(data: string): void {
    const view = this.view;
    if (view.kind !== "confirm") return;
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.pop();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up")) this.setConfirmFocus(0);
    else if (this.keybindings.matches(data, "tui.select.down")) this.setConfirmFocus(1);
    else if (this.keybindings.matches(data, "tui.select.confirm")) {
      if (view.focus === 0) {
        this.pop();
        return;
      }
      const item = this.itemById(view.itemId);
      this.pop();
      if (item) {
        if (view.applyValue !== undefined) {
          // The explicit email enable action can also re-enable a previously selected disabled channel.
          const target: SettingItem = view.enableEmail ? { ...item, patch: (value) => ({ kind: "compound", operations: [
            ...patchOperations(item.patch(value)), { kind: "providers", id: "email", value: true },
          ] }) } : item;
          this.commit(target, view.applyValue, false);
        } else {
          const result = this.host.restoreBuiltinDefault(item);
          this.refresh();
          this.report(result);
        }
        this.requestRender();
      }
    }
  }

  private setConfirmFocus(focus: number): void {
    if (this.view.kind !== "confirm") return;
    this.view = { ...this.view, focus: focus === 0 ? 0 : 1 };
    this.invalidate();
    this.requestRender();
  }

  private handlePreviewInput(data: string): void {
    const view = this.view;
    if (view.kind !== "preview") return;
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.pop();
      return;
    }
    const maxOffset = Math.max(0, view.lines.length - BODY_ROWS);
    let next: number | undefined;
    if (this.keybindings.matches(data, "tui.select.up")) next = view.offset - 1;
    else if (this.keybindings.matches(data, "tui.select.down")) next = view.offset + 1;
    else if (this.keybindings.matches(data, "tui.select.pageUp")) next = view.offset - BODY_ROWS;
    else if (this.keybindings.matches(data, "tui.select.pageDown")) next = view.offset + BODY_ROWS;
    if (next === undefined) return;
    this.view = { ...view, offset: Math.min(Math.max(0, next), maxOffset) };
    this.invalidate();
    this.requestRender();
  }

  private report(result: { ok: boolean; message: string }): void {
    this.message = { text: result.message, tone: result.ok ? "success" : "error" };
    this.invalidate();
    this.requestRender();
  }

  private handleMenuInput(data: string): void {
    const view = this.view;
    if (view.kind !== "menu" || view.rows.length === 0) return;
    if (this.keybindings.matches(data, "tui.select.up")) this.moveMenu(view.focus - 1);
    else if (this.keybindings.matches(data, "tui.select.down")) this.moveMenu(view.focus + 1);
    else if (this.keybindings.matches(data, "tui.select.pageUp")) this.moveMenu(view.focus - BODY_ROWS);
    else if (this.keybindings.matches(data, "tui.select.pageDown")) this.moveMenu(view.focus + BODY_ROWS);
    else if (this.keybindings.matches(data, "tui.select.confirm")) this.openFocusedRow();
  }

  private moveMenu(next: number): void {
    const view = this.view;
    if (view.kind !== "menu") return;
    this.view = { ...view, focus: Math.min(Math.max(0, next), Math.max(0, view.rows.length - 1)) };
    this.invalidate();
    this.requestRender();
  }

  private handleDetailInput(data: string): void {
    const view = this.view;
    if (view.kind !== "detail") return;
    const item = this.itemById(view.itemId);
    if (!item) return;
    const rows = this.candidates(item);
    if (rows.length === 0) return;
    if (this.keybindings.matches(data, "tui.select.up")) this.moveDetail(item, view.focus - 1, rows.length);
    else if (this.keybindings.matches(data, "tui.select.down")) this.moveDetail(item, view.focus + 1, rows.length);
    else if (this.keybindings.matches(data, "tui.select.pageUp")) this.moveDetail(item, view.focus - BODY_ROWS, rows.length);
    else if (this.keybindings.matches(data, "tui.select.pageDown")) this.moveDetail(item, view.focus + BODY_ROWS, rows.length);
    else if (this.keybindings.matches(data, "tui.select.confirm")) {
      const candidate = rows[view.focus];
      if (!candidate) return;
      if (candidate.custom) {
        this.push({ kind: "input", itemId: item.id, buffer: String(this.value(item) ?? "") });
        return;
      }
      this.selectCandidate(item, candidate);
    }
  }

  private selectCandidate(item: SettingItem, candidate: Candidate): void {
    const current = this.value(item);
    const value = candidate.inherit ? "inherit" : item.kind === "collection"
      ? collectionValue(current, candidate.value as SettingValue)
      : candidate.value;
    if (item.id === "routes.unify") {
      this.push({ kind: "confirm", itemId: item.id, focus: 0, applyValue: value });
      return;
    }
    if (item.destinations && Array.isArray(value)) {
      const added = value.filter((id) => !this.host.config().channels.includes(String(id)));
      if (added.includes("email")) {
        const email = this.host.config().providers.find((entry) => entry.id === "email");
        if (!email?.options.from || !Array.isArray(email.options.to) || !email.options.to.length || this.host.credentialStatus() === "未设置") {
          this.push(this.buildEmailPage());
          return;
        }
      }
      if (added.some((id) => this.host.config().providers.find((entry) => entry.id === id)?.type !== "terminal")) {
        this.push({ kind: "confirm", itemId: item.id, focus: 0, applyValue: value });
        return;
      }
    }
    this.commit(item, value, false);
    this.requestRender();
  }

  private moveDetail(item: SettingItem, next: number, total: number): void {
    const view = this.view;
    if (view.kind !== "detail") return;
    this.view = { ...view, itemId: item.id, focus: Math.min(Math.max(0, next), total - 1) };
    this.invalidate();
    this.requestRender();
  }

  /** Read-only details page: paging only; Esc returns to the page it was opened from. */
  private handleHelpInput(data: string): void {
    const view = this.view;
    if (view.kind !== "help") return;
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.pop();
      return;
    }
    const item = this.itemById(view.itemId);
    if (data === "a") {
      // “follow the user default again”: clears only this conversation's override.
      if (!item) return;
      const result = this.host.followUserDefault(item);
      this.refresh();
      this.report(result);
      this.requestRender();
      return;
    }
    if (data === "d") {
      // Destructive, so it goes through the confirmation page (default focus: cancel).
      if (!item) return;
      this.push({ kind: "confirm", itemId: item.id, focus: 0 });
      return;
    }
    const maxOffset = Math.max(0, this.totalRows() - BODY_ROWS);
    let next: number | undefined;
    if (this.keybindings.matches(data, "tui.select.up")) next = view.offset - 1;
    else if (this.keybindings.matches(data, "tui.select.down")) next = view.offset + 1;
    else if (this.keybindings.matches(data, "tui.select.pageUp")) next = view.offset - BODY_ROWS;
    else if (this.keybindings.matches(data, "tui.select.pageDown")) next = view.offset + BODY_ROWS;
    if (next === undefined) return;
    this.view = { ...view, offset: Math.min(Math.max(0, next), maxOffset) };
    this.invalidate();
    this.requestRender();
  }

  private handleSecretInput(data: string): void {
    if (this.view.kind !== "secret") return;
    const event = this.view.prompt.handleInput(data, this.keybindings);
    if (event.cancelled) { this.pop(); return; }
    if (event.submitted !== undefined) {
      const result = this.host.saveCredential(event.submitted);
      if (result.ok) this.credentialRevision++;
      this.pop();
      this.refresh();
      this.report(result);
      return;
    }
    this.invalidate(); this.requestRender();
  }

  private handleSecretConfirmInput(data: string): void {
    const view = this.view;
    if (view.kind !== "secretConfirm") return;
    if (this.keybindings.matches(data, "tui.select.cancel")) { this.pop(); return; }
    if (this.keybindings.matches(data, "tui.select.up")) view.focus = 0;
    else if (this.keybindings.matches(data, "tui.select.down")) view.focus = 1;
    else if (this.keybindings.matches(data, "tui.select.confirm")) {
      const confirmed = view.focus === 1;
      this.pop();
      if (confirmed) {
        const result = this.host.deleteCredential();
        if (result.ok) this.credentialRevision++;
        if (this.view.kind === "menu") this.view = this.rebuildPage(this.view);
        this.report(result);
      }
      return;
    }
    this.invalidate(); this.requestRender();
  }

  private handleInputView(data: string): void {
    const view = this.view;
    if (view.kind !== "input") return;
    const item = this.itemById(view.itemId);
    if (!item?.parseInput) {
      this.pop();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.pop();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm") || data === "\n") {
      const parsed = item.parseInput(view.buffer);
      if (!parsed.ok) {
        this.view = { ...view, error: parsed.message };
        this.invalidate();
        this.requestRender();
        return;
      }
      this.pop();
      this.commit(item, parsed.value, false);
      this.requestRender();
      return;
    }
    const editor = this.editor();
    editor.handleInput(data);
    view.buffer = editor.getValue();
    view.error = undefined;
    this.invalidate();
    this.requestRender();
  }

  /** Enter: submits the value; collection kinds are turned into an array by the callers. */
  private commit(item: SettingItem, value: ItemValue, viaSave: boolean): void {
    const result = viaSave ? this.host.saveDefault(item, value) : this.host.setValue(item, value);
    if (result.ok) {
      if (viaSave) this.summary.savedDefaults += 1;
      else this.summary.changed += 1;
    }
    this.message = { text: result.message, tone: result.ok ? "success" : "error" };
    this.refresh();
  }

  /**
   * Ctrl+S: freezes the focused field's **already effective** value as the user default. It never
   * saves a candidate the cursor merely hovers over, and it does nothing on a category, rule or
   * action row (those rows are navigation, not settings).
   */
  private saveFocusedDefault(): void {
    const item = this.focusedFieldItem();
    if (!item) return;
    this.commit(item, this.value(item) as ItemValue, true);
    this.requestRender();
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  /** Current view, focus, row keys and message; used by tests and for debugging. */
  debugState(): {
    view: View;
    focus: number;
    rows: string[];
    items: string[];
    message?: { text: string; tone: Tone };
  } {
    const focus = this.view.kind === "menu" || this.view.kind === "detail" || this.view.kind === "search" || this.view.kind === "confirm"
      ? this.view.focus
      : this.view.kind === "help" || this.view.kind === "preview"
        ? this.view.offset
        : 0;
    return {
      view: this.view,
      focus,
      rows: this.view.kind === "menu"
        ? this.view.rows.map((row) => row.key)
        : this.view.kind === "search"
          ? this.searchResults().map((item) => `item:${item.id}`)
          : [],
      items: this.items.map((item) => item.id),
      ...(this.message ? { message: this.message } : {}),
    };
  }
}

/** Factory handed to `ctx.ui.custom()` by the command layer. */
export function createNotifySettingsComponent(
  options: NotifySettingsComponentOptions,
): NotifySettingsComponent {
  return new NotifySettingsComponent(options);
}

/**
 * Notification control center and navigation controller.
 * - ui-model.ts: effective state, email next steps, canonical pending changes and save scope.
 * - ui-candidates.ts: pure candidate generation, default/current markers and initial focus.
 * - ui-test.ts: test progress, aggregation and subscription lifecycle.
 * - ui-primitives.ts: native list/input rendering and the isolated batch-save review.
 * - ui-secret.ts: bounded, masked credential input with no serializable secret state.
 *
 * Home is compact; advanced categories, per-rule candidates and source/restore details remain
 * independently reachable. Esc restores the parent's exact focus. No fixed-height blank padding.
 * Persistence, activation and silence checks stay in settings-actions.ts; rendering never sends.
 * Ctrl+S saves only the effective focused item, not a hovered candidate or the entire page.
 */

import { Input, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import {
  RULE_INFOS,
  SETTING_CATEGORIES,
  buildSettingItems,
  categoryPageItems,
  collectionValue,
  ruleSummary,
  channelLabel,
  routingExceptions,
  type SettingCategory,
  type SettingItem,
  type SettingValue,
} from "./settings.ts";
import type { NotificationConfig } from "./types.ts";
import { resolveChannels } from "./rules.ts";
import { channelRules, emailMissing, emailSetup, pendingSettings, type SaveScope } from "./ui-model.ts";
import { builtinDefaultValue, hasUserDefault, providerDefinitionSource, userDefaultValue } from "./settings-state.ts";
import { channelState, controlStatus, emailReadiness, emailRequirement } from "./channels.ts";
import type { ActionResult, ItemValue, SettingsHost } from "./settings-actions.ts";
import { candidateIsCurrent, candidateIsDefault, initialCandidateFocus, settingCandidates, type Candidate } from "./ui-candidates.ts";
import { emailTestKey, SettingsTestRun } from "./ui-test.ts";
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
  saveAll: "保存为默认设置",
  saveEmail: "保存为默认设置",
  test: "发送测试通知",
  emailTest: "发送邮箱测试",
  emailEnable: "邮箱通知",
  credentialSave: "QQ 邮箱授权码",
  credentialDelete: "移除已保存的邮箱授权码",
  status: "状态与诊断",
  reload: "重新读取配置",
  search: "搜索设置",
  preview: "通知预览",
};

/** One row of a menu page (home, a category, or a rule's fields). */
type MenuRow =
  | { key: string; kind: "field"; item: SettingItem; label: string }
  | { key: string; kind: "channel"; item: SettingItem }
  | { key: string; kind: "feedback" }
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

type Confirmation =
  | { kind: "enableChannel"; id: string; addUnified: boolean }
  | { kind: "apply"; value: ItemValue }
  | { kind: "followDefault" }
  | { kind: "restoreBuiltin" };

type View =
  | MenuPage
  | { kind: "detail"; itemId: string; focus: number }
  | { kind: "input"; itemId: string; error?: string; editor: Input }
  | { kind: "secret"; prompt: SecretPrompt }
  | { kind: "secretConfirm"; focus: number }
  /** Read-only, pageable full field details; `a`/`d` run the restore actions. */
  | { kind: "help"; itemId: string; offset: number }
  /** Search over the complete field table; Enter opens a result even when it is otherwise hidden. */
  | { kind: "search"; focus: number; editor: Input }
  /** Confirmation page for the destructive restore; default focus is cancel. */
  | { kind: "confirm"; itemId: string; focus: number; action: Confirmation }
  /** Read-only example notification body. */
  | { kind: "preview"; lines: string[]; offset: number; title?: string };

type Tone = "info" | "success" | "error";

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
  private feedback?: ActionResult;
  private get message(): { text: string; tone: Tone } | undefined {
    return this.feedback ? { text: this.feedback.message, tone: this.feedback.ok ? "info" : "error" } : undefined;
  }
  private summary: NotifySettingsSummary = { savedDefaults: 0, changed: 0 };
  private cachedWidth?: number;
  private cachedLines?: string[];
  /** Content column of the last render; input handling clamps paging against it. */
  private contentWidth = MAX_CONTENT_WIDTH;
  private closed = false;
  private readonly testRun = new SettingsTestRun();
  /** Navigation-scoped feedback: asynchronous operations cannot publish onto a different page. */
  private context = 0;
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
    view.editor.focused = this.hasFocus;
    return view.editor;
  }

  private pending(scope: SaveScope = "all"): SettingItem[] {
    return pendingSettings(this.host.config(), this.host.userRaw(), (item) => this.host.sessionOverride(item), scope);
  }

  private openSaveReview(scope: SaveScope): void {
    const items = this.pending(scope);
    if (!items.length) return;
    this.saveReview = new SaveReview(items.map((item) => `${item.label}：${item.format(this.value(item))}`), this.keybindings, (save) => {
      this.saveReview = undefined;
      if (save) {
        const result = this.host.saveChanges(items);
        if (result.ok) this.summary.savedDefaults += items.length;
        this.report(result);
      }
    });
    this.invalidate(); this.requestRender();
  }

  private emailStateKey(): string {
    return emailTestKey(this.host.config(), this.host.credentialStatus(), this.credentialRevision);
  }

  /** Pi calls dispose when closing custom UI; late deliveries can only update service diagnostics. */
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.testRun.stop();
    // Drop navigation references and scrub the credential-only buffer on custom UI teardown.
    this.history = [];
    if (this.view.kind === "secret") { this.view.prompt.clear(); this.view = this.buildEmailPage(); }
    this.saveReview = undefined;
    this.invalidate();
  }

  private startTest(emailOnly = false): void {
    emailOnly ||= this.view.kind === "menu" && this.view.id === "email-config";
    const config = this.host.config();
    const field = this.focusedFieldItem();
    const ruleKey = field?.rule?.key ?? (this.view.kind === "menu" && this.view.id.startsWith("rule:") ? this.view.id.slice(5) : undefined);
    const channels = emailOnly ? ["email"] : ruleKey ? resolveChannels(config, config.rules[ruleKey as keyof NotificationConfig["rules"]]) : [...config.channels];
    const emailKey = this.emailStateKey();
    const context = this.context;
    this.testRun.start((progress) => emailOnly ? this.host.testEmail(progress) : this.host.test(channels, progress), {
      emailOnly,
      valid: () => !this.closed && (!emailOnly || emailKey === this.emailStateKey()),
      update: ({ result, emailLabel }) => {
        if (emailLabel && emailKey === this.emailStateKey()) { this.emailTestKey = emailKey; this.emailTestLabel = emailLabel; }
        if (context === this.context) this.report(result);
        else { this.invalidate(); this.requestRender(); }
      },
    });
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
    for (const id of ["rules"]) {
      const category = SETTING_CATEGORIES.find((candidate) => candidate.id === id);
      if (category) rows.push({ key: `category:${category.id}`, kind: "category", category });
    }
    for (const item of this.items.filter((item) => item.providerId && !item.providerOptionPath)) {
      rows.push({ key: `channel:${item.providerId}`, kind: "channel", item });
    }
    rows.push({ key: "action:test", kind: "action", action: "test" });
    const more = SETTING_CATEGORIES.find((candidate) => candidate.id === "more");
    if (more) rows.push({ key: `category:${more.id}`, kind: "category", category: more });
    if (this.pending().length) rows.push({ key: "action:save-all", kind: "action", action: "saveAll" });
    return { kind: "menu", id: "home", title: "通知设置", rows, focus: 0 };
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
      if (category.id === "more" && this.itemById("provider:email:from")) rows.push({ key: "email-config", kind: "emailConfig", label: "邮箱配置", summary: emailSetup(this.host.config(), this.host.credentialStatus() !== "未设置").conditions });
      for (const action of category.actions ?? []) rows.push({ key: action.key, kind: "action", action: action.action });
      return { kind: "menu", id: `category:${category.id}`, title: category.label, rows, focus: 0 };
    }
    if (category.kind === "rules") {
      const rows: MenuRow[] = RULE_INFOS.map((rule) => ({ key: `rule:${rule.key}`, kind: "rule", rule }));
      return { kind: "menu", id: `category:${category.id}`, title: category.label, rows, focus: 0 };
    }
    const { items, collapsed } = categoryPageItems(category, this.items, this.host.config());
    const rows: MenuRow[] = items.map((item) => ({ key: `item:${item.id}`, kind: "field", item, label: item.label }));
    if (category.id === "channels" && !routingExceptions(this.host.config()).length) {
      const index = rows.findIndex((row) => row.key === "item:routes.unify");
      if (index >= 0) rows.splice(index, 1);
    }
    if (category.id === "channels" && this.items.some((item) => item.id === "provider:email:from")) {
      const state = emailReadiness(this.host.config(), this.host.credentialStatus() !== "未设置");
      const summary = `${state.label} · ${state.usedBy} 类提醒使用`;
      rows.push({ key: "email-config", kind: "emailConfig", label: "邮箱配置", summary });
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

  private canManageCredentials(): boolean { return this.host.canManageCredentials(); }

  private buildEmailPage(): MenuPage {
    const rows: MenuRow[] = this.items.filter((item) => item.providerId === "email" && item.group === "邮箱")
      .map((item) => ({ key: `item:${item.id}`, kind: "field" as const, item, label: item.label }));
    if (this.canManageCredentials()) rows.push({ key: "action:credential-save", kind: "action", action: "credentialSave" });
    if (!emailMissing(this.host.config(), this.host.credentialStatus() !== "未设置") || this.value(this.itemById("provider:email")!) === true) rows.push({ key: "action:email-enable", kind: "action", action: "emailEnable" });
    rows.push({ key: "action:email-test", kind: "action", action: "emailTest" });
    if (this.pending("email").length) rows.push({ key: "action:save-email", kind: "action", action: "saveEmail" });
    rows.push({ key: "qq:settings", kind: "qqLink", label: "获取授权码：QQ 邮箱设置 ↗" });
    if (this.canManageCredentials() && !["未设置", "由启动环境提供"].includes(this.host.credentialStatus())) rows.push({ key: "action:credential-delete", kind: "action", action: "credentialDelete" });
    return { kind: "menu", id: "email-config", title: "邮箱通知", rows, focus: 0 };
  }

  /** Read-only status page: one actionable row (reload) plus the host's status lines as text rows. */
  private buildStatusPage(): MenuPage {
    const rows: MenuRow[] = [{ key: "action:reload", kind: "action", action: "reload" }];
    this.host.statusLines().forEach((text, index) => wrapTextWithAnsi(text, Math.max(1, this.contentWidth - 2))
      .forEach((part, line) => rows.push({ key: `text:${index}:${line}`, kind: "text", text: part })));
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
    if (this.feedback) rebuilt.rows.push({ key: "feedback", kind: "feedback" });
    const index = focusedKey === undefined ? -1 : rebuilt.rows.findIndex((row) => row.key === focusedKey);
    rebuilt.focus = index >= 0 ? index : Math.min(page.focus, Math.max(0, rebuilt.rows.length - 1));
    return rebuilt;
  }

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------

  private push(view: View): void {
    this.history.push(this.view);
    this.clearFeedback();
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
    this.clearFeedback();
    this.view = previous;
    this.refresh();
    this.requestRender();
  }

  /** Field item the focus currently sits on: a field row on a menu page, or the open field. */
  private focusedFieldItem(): SettingItem | undefined {
    if (this.view.kind === "menu") {
      const row = this.view.rows[this.view.focus];
      return row?.kind === "field" || row?.kind === "channel" ? row.item : undefined;
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
    if (row.kind === "feedback") { this.openFeedback(); return; }
    if (row.kind === "channel") {
      this.toggleChannel(row.item);
      return;
    }
    if (row.kind === "field") {
      if (row.item.kind === "boolean") {
        if (row.item.providerId) { this.toggleChannel(row.item); return; }
        this.commit(row.item, this.value(row.item) !== true, false);
        this.requestRender();
        return;
      }
      if (view.id === "email-config" && row.item.providerOptionPath) {
        const value = this.value(row.item);
        this.push({ kind: "input", itemId: row.item.id, editor: textInput(Array.isArray(value) ? value.join(", ") : String(value ?? "")) });
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
      const context = this.context;
      void Promise.resolve(this.host.openQqSettings()).then((result) => { if (!this.closed && context === this.context) this.report(result); });
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
      const item = this.itemById("provider:email");
      if (item) this.toggleChannel(item);
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
      this.report(this.host.reload());
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

  private feedbackLabel(): string {
    if (this.feedback?.feedback?.next === "email") return "配置邮箱";
    if (this.feedback?.feedback?.next === "home") return "返回通知设置";
    return this.feedback?.feedback?.kind === "delivery" ? "测试结果与详情" : this.feedback?.feedback?.kind === "progress" ? "测试详情" : "查看问题详情";
  }

  private openFeedback(): void {
    const result = this.feedback;
    if (!result) return;
    if (result.feedback?.next === "email") { this.push(this.buildEmailPage()); return; }
    if (result.feedback?.next === "home") { this.push(this.buildHomePage()); return; }
    this.push({ kind: "preview", title: "操作详情", offset: 0,
      lines: [result.message, ...(result.feedback?.details ?? []), ...this.host.statusLines()] });
  }

  private openSearch(): void {
    this.push({ kind: "search", editor: textInput(""), focus: 0 });
  }

  /** A channel gate is never implemented by removing a unified destination: explicit rule routes
   * must stop too. Re-enabling is reviewed, and never rewrites any rule route. */
  private toggleChannel(item: SettingItem): void {
    const id = item.providerId!;
    if (this.value(item) === true) { this.commit(item, false, false); return; }
    const plan = this.host.channelActivation(id);
    if (plan.kind === "blocked") {
      this.report({ ok: false, message: plan.message, feedback: { kind: "blocked", next: "diagnostics" } });
      return;
    }
    if (plan.kind === "email") {
      if (this.view.kind === "menu" && this.view.id === "email-config") {
        const target = plan.field === "credential" ? "action:credential-save" : `item:provider:email:${plan.field}`;
        const index = this.view.rows.findIndex((row) => row.key === target);
        if (index >= 0) { this.view.focus = index; this.openFocusedRow(); }
      } else this.push(this.buildEmailPage());
      return;
    }
    this.push({ kind: "confirm", itemId: item.id, focus: 0, action: { kind: "enableChannel", id, addUnified: plan.addUnified } });
  }

  /**
   * Space: quick toggle. Boolean fields and reminder-rule rows flip in place; a collection or
   * other complex field uses the same entry as Enter. Other navigation/action rows do nothing,
   * except the email channel switch, which is also a configuration item.
   */
  private quickToggle(): void {
    if (this.view.kind === "menu") {
      const row = this.view.rows[this.view.focus];
      if (row?.kind === "field" || row?.kind === "channel" || (row?.kind === "action" && row.action === "emailEnable")) {
        this.openFocusedRow();
        return;
      }
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
    if (this.view.kind === "detail") this.activateCandidate(item);
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
    const resized = this.contentWidth !== content;
    this.contentWidth = content;
    if (resized && this.view.kind === "menu" && this.view.id === "status") this.refresh();
    const lines: string[] = [];
    lines.push(truncateToWidth(this.theme.fg("accent", this.theme.bold(this.saveReview ? "保存为默认设置 · 确认范围" : this.titleText())), content));
    if (this.saveReview) return [lines[0], ...this.saveReview.render(content, this.theme)];
    lines.push(...this.contextLines(content));
    lines.push(...this.bodyLines(content));

    const position = this.positionInfo();
    if (position && !(this.view.kind === "menu")) lines.push(this.theme.fg("dim", position));
    for (const hint of this.footerHints()) lines.push(...wrapTextWithAnsi(this.theme.fg("dim", hint), content));
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
      const state = controlStatus(config, { ...this.host.runtimeState(), restrictions: this.host.restrictions(), hasCredential: this.host.credentialStatus() !== "未设置" });
      lines.push(...wrapTextWithAnsi(this.theme.fg(state.tone, state.label), width));
      if (this.pending().length) lines.push(...wrapTextWithAnsi(this.theme.fg("dim", "当前对话 · 有未保存修改"), width));
    }
    if (this.view.id === "email-config") {
      const setup = emailSetup(config, this.host.credentialStatus() !== "未设置", this.emailTestKey === this.emailStateKey() ? this.emailTestLabel : undefined);
      const enabled = config.providers.find((entry) => entry.id === "email")?.enabled;
      for (const text of [`${enabled ? "开启" : "关闭"} · ${setup.conditions}`, ...(setup.next ? [`下一步：${setup.next}`] : []), `测试：${setup.test}`]) lines.push(...wrapTextWithAnsi(this.theme.fg("muted", text), width));
      if (!this.canManageCredentials() && this.host.credentialStatus() === "未设置") lines.push(...wrapTextWithAnsi(this.theme.fg("dim", "此系统需在启动前配置授权码，详见帮助。"), width));
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

  /** Instructions appear only while entering text or reviewing an explicit confirmation. */
  private footerHints(): string[] {
    const view = this.view;
    if (view.kind === "input") return ["Enter 应用   Esc 取消"];
    if (view.kind === "secret") return ["Enter 安全保存   Esc 取消"];
    if (view.kind === "secretConfirm" || view.kind === "confirm") return ["↑↓ 选择   Enter 确认   Esc 取消"];
    if (view.kind === "search") return ["输入以筛选   ↑↓ 选择   Enter 打开   Esc 返回"];
    return [];
  }

  private shortcutHelp(): string[] {
    return ["↑↓ 选择，Enter 切换开关或进入页面，Esc 返回。",
      "修改立即用于当前对话；保存为默认设置后用于以后对话，其他已打开对话不变。",
      "Ctrl+S 保存当前设置项的已生效值，不保存悬停选项。",
      "Ctrl+T 发送测试，Ctrl+O 状态与诊断，Ctrl+R 重新读取配置。",
      "/ 搜索全部设置，PgUp/PgDn 翻页，Space 切换开关或多选项。",
      "在设置项按 ? 查看当前值、默认值及恢复操作。",
      "渠道开关约束所有通知，包括单独设置的规则。统一接收选择只影响跟随它的规则。",
      "QQ 邮箱授权码：邮箱生成的专用发送凭据，不是登录密码。",
      ...(!this.canManageCredentials() ? ["此系统通过启动环境变量 PI_NOTIFY_QQ_SMTP_AUTH_CODE 配置授权码，不在界面输入。"] : [])];
  }

  private titleText(): string {
    const view = this.view;
    if (view.kind === "menu") return view.title;
    if (view.kind === "search") return "搜索设置";
    if (view.kind === "preview") return view.title ?? "通知预览";
    if (view.kind === "secret") return "QQ 邮箱授权码";
    if (view.kind === "secretConfirm") return "移除邮箱授权码";
    const item = this.itemById(view.itemId);
    if (!item) return "通知";
    if (view.kind === "input") return `${item.providerOptionPath ? "填写" : "修改"}${item.label}`;
    if (view.kind === "help") return `字段说明 · ${item.label}`;
    if (view.kind === "confirm") return `${view.action.kind === "followDefault" ? "使用默认设置" : view.action.kind === "restoreBuiltin" ? "恢复默认" : "确认应用"} · ${item.label}`;
    return item.label;
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
      ...this.shortcutHelp(),
      `设置项：${item.group} · ${item.label}`,
      `当前值：${current}`,
      override === undefined ? "当前对话：使用默认设置" : "当前对话：已单独修改",
      this.hasDefault(item) ? `默认设置：${item.format(this.defaultValue(item))}` : "默认设置：使用内置默认",
      `内置默认：${item.format(builtinDefaultValue(item))}`,
    ];
    if (item.id === "enabled") {
      // Forced silence is a session-level limit over the switch, not a user default of "off"; the
      // detail view says so instead of letting the two read as one setting.
      for (const restriction of this.host.restrictions()) {
        lines.push(`当前限制：${restriction.label}，优先于通知总开关。详见状态与诊断。`);
      }
    }
    if (item.providerId !== undefined) {
      const fromUser = providerDefinitionSource(item, this.host.userRaw()) === "user";
      lines.push(`接收方式配置：${fromUser ? "自定义配置" : "内置默认"}`);
      lines.push("连接凭据不在此界面显示，保存开关不会修改连接配置。");
    }
    if (item.paths || item.destinations) lines.push(`影响范围：${this.host.itemScope(item).join("、")}`);
    if (item.destinations) lines.push(`自定义例外：${routingExceptions(this.host.config()).join("、") || "无"}；取消统一选择不会关闭例外使用的渠道。`);
    if (item.id === "reminders.completed") lines.push("执行完成只表示 Pi 停止自动执行，不保证业务目标成功。");
    if (item.id === "reminders.failed") lines.push("包含运行失败和上下文压缩失败，不包括每次可恢复工具失败。");
    if (item.inputHint) lines.push(`输入：${item.inputHint}`);
    // “Not effective right now” is spelled out instead of hiding the field: search and the restored
    // pages must be able to reach a parameter a disabled feature currently ignores.
    const inactive = this.inactiveReason(item);
    if (inactive !== undefined) lines.push(`尚未生效：${inactive}`);
    // Independent action area of the field detail page.
    lines.push("a 使用默认设置：撤销此项的当前对话修改。");
    lines.push("d 恢复内置默认：确认后重置此项的默认设置和当前对话修改。");
    return lines;
  }

  /** Why an item is currently ignored, or undefined when it is live. */
  private inactiveReason(item: SettingItem): string | undefined {
    const config = this.host.config();
    if (item.rule) {
      const rule = config.rules[item.rule.key];
      if (!rule.enabled) return `所属规则“${item.rule.label}”已关闭，启用后生效`;
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
    if (this.view.kind === "preview") return this.view.lines.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, this.contentWidth))).length;
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
    const query = view.editor.getValue().trim().toLowerCase();
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
    if (view.action.kind === "followDefault") return [...wrapTextWithAnsi(`使用${item.label}的默认设置，可能恢复该接收方式的通知。`, width),
      ...wrapTextWithAnsi(`适用规则：${channelRules(this.host.config(), item.providerId!).join("、") || "无"}。接收选择不变。`, width),
      `${FOCUS_CELL(view.focus === 0)}取消`, `${FOCUS_CELL(view.focus === 1)}确认使用默认设置`];
    if (view.action.kind === "enableChannel") {
      return [...(view.action.addUnified ? wrapTextWithAnsi("开启后加入统一接收选择，跟随统一设置的提醒将使用此渠道；逐规则例外不变。", width) : []),
        `${FOCUS_CELL(view.focus === 0)}关闭`, `${FOCUS_CELL(view.focus === 1)}开启`];
    }
    if (view.action.kind === "apply") {
      const config = this.host.config();
      const selected = Array.isArray(view.action.value) ? view.action.value.map(String) : [];
      const restored = selected.filter((id) => !config.channels.includes(id) && config.providers.find((entry) => entry.id === id)?.enabled === false);
      const text = item.id === "routes.unify"
        ? [`将以下规则改为跟随统一接收选择：${routingExceptions(config).join("、") || "全部规则"}。`, "提醒时机和重要程度不变。"]
        : [`统一接收选择：${selected.map(channelLabel).join("、") || "无"}。`,
          `适用规则：${RULE_INFOS.filter((entry) => config.rules[entry.key as keyof NotificationConfig["rules"]].channels === "inherit").map((entry) => entry.label).join("、") || "无"}。`,
          ...restored.map((id) => `同时开启${channelLabel(id)}，恢复原有规则：${channelRules(config, id).join("、") || "无"}。`),
          "逐规则接收选择不变，仅已开启的规则发送。"];
      return [...text.flatMap((line) => wrapTextWithAnsi(line, width)), `${FOCUS_CELL(view.focus === 0)}取消`, `${FOCUS_CELL(view.focus === 1)}确认应用`];
    }
    const lines = [
      `字段：${item.group} · ${item.label}`,
      `当前值：${item.format(this.value(item))}`,
      `恢复后：${item.format(builtinDefaultValue(item))}；重置此项的默认设置和当前对话修改`,
      ...(item.providerId && !item.providerOptionPath ? [`适用规则：${channelRules(this.host.config(), item.providerId).join("、") || "无"}。接收选择不变。`] : []),
      `影响范围：${this.host.itemScope(item).join("、")}；其他设置不变`,
      "",
      `${FOCUS_CELL(view.focus === 0)}取消`,
      `${FOCUS_CELL(view.focus === 1)}确认恢复`,
    ];
    return lines.slice(0, BODY_ROWS).map((line) => truncateToWidth(line, width));
  }

  private previewLines(width: number): string[] {
    const view = this.view;
    if (view.kind !== "preview") return [];
    const rows = view.lines.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
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
    const start = this.centeredScroll(view.focus, view.rows.length);
    const rows = view.rows.slice(start, start + BODY_ROWS);
    const labels = rows.map((row) => this.menuRow(row, false, Math.max(5, width)).slice(2));
    const lines = menuList(labels, view.focus - start, width, BODY_ROWS, this.theme);
    if (view.id === "home") {
      const first = rows.findIndex((row) => row.kind === "channel");
      if (first >= 0) lines.splice(first, 0, this.theme.fg("muted", "  接收方式"));
    }
    if (view.rows.length > BODY_ROWS) lines.push(this.theme.fg("dim", `${start + 1}–${Math.min(start + BODY_ROWS, view.rows.length)}/${view.rows.length}`));
    return lines;
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
    if (row.kind === "feedback" || (row.kind === "action" && ["status", "saveAll", "saveEmail", "credentialSave"].includes(row.action))) return OPEN_MARK;
    if (row.kind === "channel" && this.value(row.item) !== true && row.item.providerId === "email" && emailMissing(this.host.config(), this.host.credentialStatus() !== "未设置")) return OPEN_MARK;
    if (row.kind === "field" && row.item.kind !== "boolean") return OPEN_MARK;
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
      const label = scope ? `${ACTION_LABELS[row.action]}  ${this.pending(scope).length} 项更改` : row.action === "credentialSave"
        ? `${ACTION_LABELS[row.action]}  ${this.host.credentialStatus() === "未设置" ? "未设置" : this.host.credentialStatus() === "由启动环境提供" ? "启动环境已提供" : "已设置"}`
        : row.action === "emailEnable" ? `${ACTION_LABELS[row.action]}  ${this.host.config().providers.find((entry) => entry.id === "email")?.enabled ? "开启" : "关闭"}` : ACTION_LABELS[row.action];
      return truncateToWidth(`${focus}${label}${mark}`, width);
    }
    if (row.kind === "qqLink") {
      const label = truncateToWidth(row.label, Math.max(0, width - 2));
      return `${focus}${label}`;
    }
    if (row.kind === "text") {
      return truncateToWidth(`${focus}${row.text}`, width);
    }
    if (row.kind === "feedback") return truncateToWidth(`${focus}${this.feedbackLabel()}${OPEN_MARK}`, width);
    if (row.kind === "channel") return truncateToWidth(`${focus}${row.item.label}  ${channelState(this.host.config(), row.item.providerId!, this.host.credentialStatus() !== "未设置", this.host.runtimeState().terminalIssue, this.host.runtimeState().channelIssues)}${mark}`, width);
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
      // Reserve the page marker even for long addresses; identity and value share the width.
      const head = `${focus}${label}`;
      const limit = Math.max(3, Math.min(visibleWidth(head), Math.floor(width * 0.55)));
      const text = truncateToWidth(head, limit, "…");
      const room = Math.max(0, width - visibleWidth(text) - visibleWidth(gap) - visibleWidth(mark));
      return truncateToWidth(`${text}${gap}${truncateToWidth(summary, room, "…")}${mark}`, width);
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
    const isCurrent = candidateIsCurrent(item, candidate, current);
    const isDefault = candidateIsDefault(item, candidate, current, this.defaultValue(item), this.hasDefault(item));
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

  private candidates(item: SettingItem): Candidate[] {
    const rows = settingCandidates(item, this.host.config(), this.defaultValue(item));
    if (this.feedback) rows.push({ value: "", label: `${this.feedbackLabel()} ›`, feedback: true });
    return rows;
  }

  private initialDetailFocus(item: SettingItem): number {
    return initialCandidateFocus(item, this.candidates(item), this.value(item));
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
      this.handlePagedInput(data);
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
      this.report(this.host.reload());
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
      if (item) this.push({ kind: "help", itemId: item.id, offset: 0 });
      else this.push({ kind: "preview", title: "操作帮助", lines: this.shortcutHelp(), offset: 0 });
      return;
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
      view.focus = 0;
      this.invalidate();
      this.requestRender();
    }
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
        if (view.action.kind === "followDefault") {
          this.report(this.host.followUserDefault(item));
        } else if (view.action.kind === "enableChannel") {
          const result = this.host.enableChannel(view.action.id);
          if (result.ok) this.summary.changed++;
          this.report(result);
        } else if (view.action.kind === "apply") {
          this.commit(item, view.action.value, false);
        } else {
          this.report(this.host.restoreBuiltinDefault(item));
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

  /** Shared navigation for read-only help and preview pages; help actions stay below. */
  private handlePagedInput(data: string): void {
    const view = this.view;
    if (view.kind !== "preview" && view.kind !== "help") return;
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.pop();
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

  private clearFeedback(): void {
    this.context++;
    this.feedback = undefined;
  }

  private report(result: ActionResult): void {
    this.feedback = !result.ok || result.feedback ? result : undefined;
    this.refresh();
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
    else if (this.keybindings.matches(data, "tui.select.confirm")) this.activateCandidate(item);
  }

  private activateCandidate(item: SettingItem): void {
    if (this.view.kind !== "detail") return;
    const candidate = this.candidates(item)[this.view.focus];
    if (!candidate) return;
    if (candidate.custom) this.push({ kind: "input", itemId: item.id, editor: textInput(String(this.value(item) ?? "")) });
    else this.selectCandidate(item, candidate);
  }

  private selectCandidate(item: SettingItem, candidate: Candidate): void {
    if (candidate.feedback) { this.openFeedback(); return; }
    const current = this.value(item);
    const value = candidate.inherit ? "inherit" : item.kind === "collection"
      ? collectionValue(current, candidate.value as SettingValue)
      : candidate.value;
    if (item.providerId && !item.providerOptionPath && value === true && this.value(item) !== true) {
      this.toggleChannel(item);
      return;
    }
    if (item.id === "routes.unify") {
      this.push({ kind: "confirm", itemId: item.id, focus: 0, action: { kind: "apply", value } });
      return;
    }
    if (item.destinations && Array.isArray(value)) {
      const added = value.filter((id) => !this.host.config().channels.includes(String(id)));
      if (added.includes("email")) {
        const email = this.host.config().providers.find((entry) => entry.id === "email");
        if (emailRequirement(email, this.host.credentialStatus() !== "未设置")) {
          this.push(this.buildEmailPage());
          return;
        }
      }
      if (added.length) {
        this.push({ kind: "confirm", itemId: item.id, focus: 0, action: { kind: "apply", value } });
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
    const item = this.itemById(view.itemId);
    if (data === "a") {
      // “follow the user default again”: clears only this conversation's override.
      if (!item) return;
      if (item.providerId && !item.providerOptionPath && this.value(item) !== true
        && (this.hasDefault(item) ? this.defaultValue(item) : builtinDefaultValue(item)) === true) {
        this.push({ kind: "confirm", itemId: item.id, focus: 0, action: { kind: "followDefault" } });
        return;
      }
      this.report(this.host.followUserDefault(item));
      return;
    }
    if (data === "d") {
      // Destructive, so it goes through the confirmation page (default focus: cancel).
      if (!item) return;
      this.push({ kind: "confirm", itemId: item.id, focus: 0, action: { kind: "restoreBuiltin" } });
      return;
    }
    this.handlePagedInput(data);
  }

  private handleSecretInput(data: string): void {
    if (this.view.kind !== "secret") return;
    const event = this.view.prompt.handleInput(data, this.keybindings);
    if (event.cancelled) { this.pop(); return; }
    if (event.submitted !== undefined) {
      const result = this.host.saveCredential(event.submitted);
      if (result.ok) this.credentialRevision++;
      this.pop();
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
      const parsed = item.parseInput(view.editor.getValue());
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
    view.error = undefined;
    this.invalidate();
    this.requestRender();
  }

  /** Enter: submits the value; collection kinds are turned into an array by the callers. */
  private commit(item: SettingItem, value: ItemValue, viaSave: boolean): void {
    const result = viaSave ? this.host.saveDefault(item) : this.host.setValue(item, value);
    if (result.ok) {
      if (viaSave) this.summary.savedDefaults += 1;
      else this.summary.changed += 1;
    }
    this.report(result);
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

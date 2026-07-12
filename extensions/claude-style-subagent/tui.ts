import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { getDisplayRunStatus, type RunSnapshot, type SubagentRegistry } from "./runner.ts";

/** How long finished runs linger in the persistent list before fading out. */
export const FINISHED_LINGER_MS = 30_000;
/** Keep elapsed times moving even when a run emits no registry events. */
export const ELAPSED_REFRESH_MS = 1_000;

function padLine(line: string, width: number): string {
  const truncated = truncateToWidth(line, width);
  return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

function age(ms: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

function statusIcon(status: string): string {
  switch (status) {
    case "running": return "⏳";
    case "complete": return "✓";
    case "idle": return "●";
    case "needs_attention": return "⚠";
    case "starting": return "…";
    case "killed": return "■";
    case "error": return "✗";
    case "exited": return "✓";
    default: return "?";
  }
}

function shortModel(model?: string): string | undefined {
  if (!model) return undefined;
  const parts = model.split("/");
  return parts.at(-1) || model;
}

function statusColor(theme: any, status: ReturnType<typeof getDisplayRunStatus>, text: string = status): string {
  if (status === "error" || status === "killed") return theme.fg("error", text);
  if (status === "needs_attention") return theme.fg("warning", text);
  if (status === "complete" || status === "exited") return theme.fg("success", text);
  if (status === "running" || status === "starting") return theme.fg("accent", text);
  return theme.fg("muted", text);
}

function stringifyPreview(value: unknown, maxLength = 140): string {
  if (value === undefined) return "";
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try { text = JSON.stringify(value); } catch { text = String(value); }
  }
  text = text.replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function latestActivity(run: RunSnapshot): string {
  const status = getDisplayRunStatus(run);
  // Render-event deltas describe what WAS happening. Once a run is no longer
  // active, "writing response…" / "tool running" are stale and contradict the
  // terminal status shown on the same row. Prefer its final output/error.
  if (!isActiveDisplayStatus(status)) {
    if (run.lastError) return run.lastError;
    if (status === "complete" || status === "exited") return "completed";
    if (status === "killed" || status === "error") return status;
    return "waiting…";
  }
  for (let i = (run.renderEvents?.length ?? 0) - 1; i >= 0; i--) {
    const event = run.renderEvents[i] as any;
    if (!event) continue;
    if (event.type === "tool_execution_start" || event.type === "tool_execution_update" || event.type === "tool_execution_end" || event.type === "tool_result") {
      const args = stringifyPreview(event.args ?? event.input ?? event.partialResult?.details, 120);
      const suffix = args ? ` ${args}` : "";
      const state = event.type === "tool_execution_end" || event.type === "tool_result" ? (event.isError ? "error" : "done") : "running";
      return `${event.toolName ?? "tool"}${suffix} · ${state}`;
    }
    if (event.type === "message_update") {
      const delta = event.assistantMessageEvent;
      if (delta?.type === "text_delta") return "writing response…";
      if (delta?.type === "thinking_delta") return "thinking…";
    }
    if (event.type === "agent_start") return "agent started";
  }
  if (run.lastAssistantText?.trim()) return run.lastAssistantText.trim().split("\n").find(Boolean)?.slice(0, 160) ?? "assistant output";
  if (run.task) return run.task.replace(/\s+/g, " ").slice(0, 160);
  return "waiting…";
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatUsageShort(run: RunSnapshot): string | undefined {
  const usage = run.usage;
  if (!usage || usage.totalTokens <= 0) return undefined;
  const cost = usage.cost > 0 ? ` $${usage.cost.toFixed(2)}` : "";
  return `${formatTokens(usage.totalTokens)} tok${cost}`;
}

function runStats(run: RunSnapshot): string[] {
  return [
    shortModel(run.model),
    run.turns ? `${run.turns} turns` : undefined,
    formatUsageShort(run),
    age(run.startedAt),
  ].filter((item): item is string => Boolean(item));
}

function isActiveDisplayStatus(status: string): boolean {
  return status === "starting" || status === "running" || status === "needs_attention";
}

/** Single-line row: prefix + icon + agent + id + status + stats + latest activity. */
function runRow(theme: any, run: RunSnapshot, prefix: string, foreground: boolean): string {
  const status = getDisplayRunStatus(run);
  const stats = runStats(run).join(" · ");
  const fgMark = foreground ? theme.fg("accent", "▶ ") : "";
  return `${prefix}${fgMark}${statusColor(theme, status, statusIcon(status))} ${theme.bold(run.agent)} ${theme.fg("muted", run.id)} ${statusColor(theme, status)}${stats ? ` ${theme.fg("dim", `· ${stats}`)}` : ""} ${theme.fg("dim", "—")} ${theme.fg("muted", latestActivity(run))}`;
}

export type ListEntry = { kind: "main" } | { kind: "run"; run: RunSnapshot };

export type ListAction =
  | { type: "foreground"; id: string }
  | { type: "blur" };

/**
 * Persistent Claude-Code-style agent list under the editor (belowEditor
 * widget). Registered by every session instance (main and each subagent) on
 * its own UI context, so it is visible no matter which agent owns the
 * terminal. Rendering is driven by the shared registry singleton.
 *
 * Focus is managed by index.ts: when the editor is empty, ↓ (or alt+a) focuses
 * the list; while focused, all input is routed to handleInput().
 */
export class SubagentList implements Component {
  private selected = 0;
  private focused = false;
  private elapsedTimer: ReturnType<typeof setInterval> | undefined;
  private fadeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly registry: SubagentRegistry,
    private readonly theme: any,
    private readonly getForeground: () => string,
    private readonly onAction: (action: ListAction) => void,
    private readonly requestRender: () => void,
  ) {}

  /** Live runs shown in the list: active ones + finished within the linger window. */
  private visibleRuns(): RunSnapshot[] {
    const now = Date.now();
    const foreground = this.getForeground();
    const runs = this.registry.list().filter((run) => {
      // Never fade the current child: main + current are the permanent escape
      // route while a child owns the terminal, even if it has been idle for
      // hours. Other completed runs retain the normal 30-second linger.
      if (run.id === foreground) return true;
      const status = getDisplayRunStatus(run);
      if (isActiveDisplayStatus(status)) return true;
      return run.updatedAt > now - FINISHED_LINGER_MS;
    });
    return [
      ...runs.filter((run) => isActiveDisplayStatus(getDisplayRunStatus(run))),
      ...runs.filter((run) => !isActiveDisplayStatus(getDisplayRunStatus(run))).sort((a, b) => b.updatedAt - a.updatedAt),
    ].slice(0, 8);
  }

  private entries(): ListEntry[] {
    const runs = this.visibleRuns();
    if (runs.length === 0) return [];
    return [{ kind: "main" }, ...runs.map((run) => ({ kind: "run" as const, run }))];
  }

  get isEmpty(): boolean {
    return this.entries().length === 0;
  }

  get isFocused(): boolean {
    return this.focused;
  }

  focus(): boolean {
    const entries = this.entries();
    if (entries.length === 0) return false;
    this.focused = true;
    // Default to the first entry that is not already foreground: pressing
    // enter immediately does the most likely switch (main ⇄ busiest run).
    const foreground = this.getForeground();
    const index = entries.findIndex((entry) => (entry.kind === "main" ? "main" : entry.run.id) !== foreground);
    this.selected = index >= 0 ? index : 0;
    this.requestRender();
    return true;
  }

  blur(): void {
    if (!this.focused) return;
    this.focused = false;
    this.requestRender();
  }

  handleInput(data: string): void {
    const entries = this.entries();
    if (entries.length === 0) { this.blur(); this.onAction({ type: "blur" }); return; }
    this.selected = Math.min(this.selected, entries.length - 1);
    const current = entries[this.selected]!;

    if (matchesKey(data, Key.escape) || data === "q") { this.blur(); this.onAction({ type: "blur" }); return; }
    if (matchesKey(data, Key.up)) this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, Key.down)) this.selected = Math.min(entries.length - 1, this.selected + 1);
    else if (matchesKey(data, Key.enter)) {
      const id = current.kind === "main" ? "main" : current.run.id;
      this.blur();
      this.onAction({ type: "foreground", id });
      return;
    } else if (data === "a" && current.kind === "run") {
      this.registry.get(current.run.id)?.abort().catch(() => undefined);
    } else if (data === "k" && current.kind === "run") {
      this.registry.get(current.run.id)?.kill("killed from agent list");
    }
    this.requestRender();
  }

  render(width: number): string[] {
    this.scheduleFade();
    const entries = this.entries();
    this.syncElapsedTimer(entries.length > 0);
    if (entries.length === 0) {
      if (this.focused) { this.focused = false; this.onAction({ type: "blur" }); }
      return [];
    }

    const theme = this.theme;
    const foreground = this.getForeground();
    const runs = this.registry.list();
    const active = runs.filter((run) => isActiveDisplayStatus(getDisplayRunStatus(run))).length;
    const hint = this.focused
      ? "↑↓ move · enter switch · a abort · k kill · esc back"
      : "↓ focus (empty input) · /agents manage";
    const titleColor = this.focused ? "accent" : active > 0 ? "accent" : "dim";
    const lines: string[] = [
      `${theme.fg(titleColor, active > 0 ? "⏳" : "○")} ${theme.fg(titleColor, theme.bold("Agents"))} ${theme.fg("dim", `· ${active} running · ${hint}`)}`,
    ];

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      const prefix = this.focused && i === this.selected ? theme.fg("accent", "› ") : "  ";
      if (entry.kind === "main") {
        const isFg = foreground === "main";
        const mark = isFg ? theme.fg("accent", "▶ ") : "";
        lines.push(`${prefix}${mark}${theme.fg("accent", "★")} ${theme.bold("main")} ${theme.fg("dim", isFg ? "· current" : "· your primary session")}`);
      } else {
        lines.push(runRow(theme, entry.run, prefix, foreground === entry.run.id));
      }
    }
    return lines.map((line) => truncateToWidth(line, width));
  }

  /** Re-render every second while the list is visible, including quiet tool runs. */
  private syncElapsedTimer(visible: boolean): void {
    if (visible) {
      if (!this.elapsedTimer) {
        this.elapsedTimer = setInterval(() => this.requestRender(), ELAPSED_REFRESH_MS);
      }
      return;
    }
    if (this.elapsedTimer) clearInterval(this.elapsedTimer);
    this.elapsedTimer = undefined;
  }

  /** Re-render when the next finished run is due to fade out of the list. */
  private scheduleFade(): void {
    if (this.fadeTimer) return;
    const now = Date.now();
    let next = Number.POSITIVE_INFINITY;
    for (const run of this.registry.list()) {
      if (isActiveDisplayStatus(getDisplayRunStatus(run))) continue;
      const expiry = run.updatedAt + FINISHED_LINGER_MS;
      if (expiry > now && expiry < next) next = expiry;
    }
    if (!Number.isFinite(next)) return;
    this.fadeTimer = setTimeout(() => {
      this.fadeTimer = undefined;
      this.requestRender();
    }, Math.max(50, next - now + 50));
  }

  dispose(): void {
    if (this.elapsedTimer) clearInterval(this.elapsedTimer);
    this.elapsedTimer = undefined;
    if (this.fadeTimer) clearTimeout(this.fadeTimer);
    this.fadeTimer = undefined;
  }

  invalidate(): void {}
}

type PopupEntry = { kind: "main" } | { kind: "run"; run: RunSnapshot; live: boolean };

/**
 * Management panel (/agents). Replaces the editor slot (non-overlay): the
 * chat history stays visible above, the input area becomes the manager until
 * it closes. Shows current runs by default; `h` toggles history (finished +
 * runs restored from runs.json). Abort/kill/cleanup are handled in place;
 * enter resolves with a foreground switch request.
 */
class SubagentPopup implements Component {
  private selected = 0;
  private showHistory = false;
  private note?: string;

  constructor(
    private readonly registry: SubagentRegistry,
    private readonly theme: any,
    private readonly getForeground: () => string,
    private readonly done: (action: { type: "foreground"; id: string } | undefined) => void,
    private readonly requestRender: () => void,
    private readonly getHeight: () => number,
  ) {}

  private entries(): PopupEntry[] {
    const now = Date.now();
    const all = this.registry.list().sort((a, b) => b.updatedAt - a.updatedAt);
    const current: PopupEntry[] = [];
    const history: PopupEntry[] = [];
    for (const run of all) {
      const status = getDisplayRunStatus(run);
      const managed = this.registry.get(run.id);
      const live = Boolean(managed?.isAlive && managed?.agentSession);
      const recent = isActiveDisplayStatus(status) || run.updatedAt > now - FINISHED_LINGER_MS;
      if (live && recent) current.push({ kind: "run", run, live });
      else history.push({ kind: "run", run, live });
    }
    return [{ kind: "main" }, ...current, ...(this.showHistory ? history : [])];
  }

  handleInput(data: string): void {
    const entries = this.entries();
    this.selected = Math.min(this.selected, Math.max(0, entries.length - 1));
    const current = entries[this.selected];
    this.note = undefined;

    if (matchesKey(data, Key.escape) || data === "q") { this.done(undefined); return; }
    if (matchesKey(data, Key.up)) this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, Key.down)) this.selected = Math.min(entries.length - 1, this.selected + 1);
    else if (data === "h") this.showHistory = !this.showHistory;
    else if (data === "c") {
      const removed = this.registry.removeExited();
      this.note = `cleaned ${removed} finished run${removed === 1 ? "" : "s"}`;
    } else if (matchesKey(data, Key.enter) && current) {
      if (current.kind === "main") { this.done({ type: "foreground", id: "main" }); return; }
      // Non-live entries (history / killed) are revived from their session
      // file by switchForeground — same mechanism as pi's session resume.
      if (current.live || current.run.sessionFile) { this.done({ type: "foreground", id: current.run.id }); return; }
      this.note = "no session file recorded — cannot revive this entry";
    } else if (data === "a" && current?.kind === "run" && current.live) {
      this.registry.get(current.run.id)?.abort().catch(() => undefined);
    } else if (data === "k" && current?.kind === "run" && current.live) {
      this.registry.get(current.run.id)?.kill("killed from /agents");
    }
    this.requestRender();
  }

  render(width: number): string[] {
    const theme = this.theme;
    const entries = this.entries();
    this.selected = Math.min(this.selected, Math.max(0, entries.length - 1));
    const foreground = this.getForeground();

    const header = [
      truncateToWidth(theme.fg("accent", theme.bold(" Claude-style Subagent ")) + theme.fg("accent", "─".repeat(Math.max(0, width))), width),
      truncateToWidth(theme.fg("dim", ` ↑↓ move · enter switch · a abort · k kill · c cleanup · h ${this.showHistory ? "hide" : "show"} history · esc close`), width),
      "",
    ];
    if (this.note) header.push(truncateToWidth(theme.fg("warning", ` ${this.note}`), width));

    const rows: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      const prefix = i === this.selected ? theme.fg("accent", "› ") : "  ";
      if (entry.kind === "main") {
        const isFg = foreground === "main";
        rows.push(`${prefix}${isFg ? theme.fg("accent", "▶ ") : ""}${theme.fg("accent", "★")} ${theme.bold("main")} ${theme.fg("dim", isFg ? "· current" : "· your primary session")}`);
      } else {
        const line = runRow(theme, entry.run, prefix, foreground === entry.run.id);
        rows.push(entry.live ? line : theme.fg("dim", `${prefix}◌ `) + line.slice(visibleWidth(prefix)));
      }
    }
    if (entries.length === 1) rows.push(theme.fg("dim", "  no subagents — spawn one with the agents tool"));

    // Natural height (editor-slot component): window the rows around the
    // selection so long lists stay compact instead of filling the screen.
    const maxRows = Math.max(3, this.getHeight());
    let start = 0;
    if (rows.length > maxRows) {
      start = Math.min(Math.max(0, this.selected - Math.floor(maxRows / 2)), rows.length - maxRows);
    }
    const visible = rows.slice(start, start + maxRows);
    const hidden = rows.length - visible.length;
    if (hidden > 0) visible.push(theme.fg("dim", `  +${hidden} more ↑↓`));

    return [...header, ...visible].map((line) => padLine(truncateToWidth(line, width), width));
  }

  invalidate(): void {}
}

/**
 * Open the /agents manager in the editor slot (non-overlay): it REPLACES
 * the input area until closed. Resolves with a foreground request or
 * undefined.
 */
export async function openSubagentPopup(
  ctx: ExtensionContext,
  registry: SubagentRegistry,
  getForeground: () => string,
): Promise<{ type: "foreground"; id: string } | undefined> {
  if (ctx.mode !== "tui") { ctx.ui.notify("/agents requires TUI mode.", "warning"); return undefined; }
  return await ctx.ui.custom<{ type: "foreground"; id: string } | undefined>((tui, theme, _kb, done) => {
    let unsub: (() => void) | undefined;
    const finish = (action: { type: "foreground"; id: string } | undefined) => { unsub?.(); done(action); };
    const popup = new SubagentPopup(
      registry, theme, getForeground, finish, () => tui.requestRender(),
      () => Math.min(14, Math.max(6, (tui.terminal.rows || process.stdout.rows || 30) - 12)),
    );
    unsub = registry.onChange(() => tui.requestRender());
    return popup;
  });
}

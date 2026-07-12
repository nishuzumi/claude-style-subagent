import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { isKeyRelease, Key, Markdown, matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentScope, describeAgents, discoverAgents } from "./agents.ts";
import { getDisplayRunStatus, SubagentRegistry, type RunSnapshot } from "./runner.ts";
import { installForegroundRuntimePatches } from "./runtime-patches.ts";
import type { ForegroundAgentsApi } from "./runtime-types.ts";
import { openSubagentPopup, SubagentList, type ListAction } from "./tui.ts";
import { waitForSubagents } from "./wait.ts";

// The registry MUST be shared between the primary session's extension
// instance and every child (subagent) session's instance — but module-level
// state cannot do that: pi loads extensions through jiti with its own module
// graph per loader, so the parent instance and each child instance get
// SEPARATE copies of this module. globalThis is the only reliable
// process-level channel, so the singleton lives there (versioned key).
const REGISTRY_KEY = "__piSubagentPlusRegistry_v1";
const registry: SubagentRegistry = ((globalThis as any)[REGISTRY_KEY] ??= new SubagentRegistry());

// Custom message type for messages this extension injected into the main chat.
// New code no longer injects these (foreground switching shows the real
// conversation), but old session files may still contain them, so the renderer
// and the context filter stay registered for backward compatibility.
const SUBAGENT_VIEW_TYPE = "subagent-plus-view";
const SUBAGENT_NOTIFICATION_TYPE = "subagent-plus";

// Subagents run in-process. Each subagent session ALSO loads this extension
// (inherited / auto-discovered), re-runs the factory in ITS OWN module copy
// (see REGISTRY_KEY above), and fires its own session_start against the
// host-managed SessionUiProxy that runner.ts tags at adopt time (or against
// the fake headless context when running un-adopted). `primaryPi` is the
// top-level session's API; child instances never touch the notify wiring
// (isChild guards), so these per-module-copy variables are parent-only.
let primaryPi: ExtensionAPI | undefined;
let globalListenersWired = false;

function isChildSession(ctx: ExtensionContext): boolean {
  return Boolean((ctx.ui as any)?.__subagentPlusChild);
}
function childDepthOf(ctx: ExtensionContext): number {
  return Number((ctx.ui as any)?.__subagentPlusDepth) || 0;
}
function childRunIdOf(ctx: ExtensionContext): string | undefined {
  const id = (ctx.ui as any)?.__subagentPlusRunId;
  return typeof id === "string" && id ? id : undefined;
}

/** Replace pi's startup banner in child sessions with live agent identity. */
function setupChildHeader(ctx: ExtensionContext): void {
  if (!ctx.hasUI || ctx.mode !== "tui" || !isChildSession(ctx)) return;
  const id = childRunIdOf(ctx);
  if (!id) return;
  ctx.ui.setHeader((_tui: any, theme: any) => ({
    render(width: number): string[] {
      const run = registry.get(id)?.snapshot();
      const agent = run?.agent ?? id.split("-")[0] ?? "subagent";
      const status = run ? getDisplayRunStatus(run) : "starting";
      const model = run?.model?.split("/").at(-1);
      const statusTone = status === "error" || status === "killed"
        ? "error"
        : status === "needs_attention"
          ? "warning"
          : status === "running" || status === "starting"
            ? "accent"
            : status === "complete" || status === "exited"
              ? "success"
              : "muted";
      const lines = [
        theme.fg("accent", "─".repeat(Math.max(0, width))),
        `${theme.bold(theme.fg("accent", "Claude-style Subagent"))} ${theme.fg("dim", "›")} ${theme.bold(agent)}`,
        theme.fg("dim", "↓ focus agent list · enter switch · esc interrupt · /agents manage"),
        `${theme.fg(statusTone, status)} ${theme.fg("dim", "·")} ${theme.fg("muted", id)}`,
        theme.fg("dim", `model=${model ?? "default"}`),
        "",
      ];
      // Header lines are extension-owned (not Markdown), so keep them within
      // terminal width explicitly to prevent physical wrapping from pushing
      // the identity title out of a short viewport after resize.
      return lines.map((line) => truncateToWidth(line, width));
    },
    invalidate() {},
  }));
}

/** Foreground API supplied natively by the host or by this extension's stock-Pi runtime patch. */
function agentsOf(ctx: ExtensionContext): ForegroundAgentsApi | undefined {
  return (ctx.ui as any)?.agents;
}

/**
 * Switch the terminal to `id` ("main" or a run id) and surface queued dialogs.
 * Non-live targets (history restored from runs.json, killed runs) are revived
 * from their persisted session file first — the full conversation comes back
 * and the run can take follow-ups again.
 */
async function switchForeground(ctx: ExtensionContext, id: string): Promise<void> {
  const agents = agentsOf(ctx);
  if (!agents) { ctx.ui.notify("Foreground switching requires interactive TUI mode.", "warning"); return; }
  try {
    if (id !== "main") {
      const run = registry.get(id);
      if (run && (!run.isAlive || !run.agentSession)) {
        // Re-discover the agent so the revived session gets a fresh system
        // prompt (persisted history records don't carry it).
        const agent = discoverAgents(ctx.cwd, "user").agents.find((candidate) => candidate.name === run.agent.name);
        await registry.revive(id, { adopt: agents.adopt, agent });
      }
    }
    await agents.setForeground(id);
    // Dialogs that queued while the run was backgrounded (needs_attention) are
    // replayed onto the now-active proxy so the user answers them natively.
    if (id !== "main") await registry.get(id)?.surfacePendingUiRequests();
  } catch (error: any) {
    ctx.ui.notify(String(error?.message ?? error), "error");
  }
}

const Action = StringEnum([
  "list_agents",
  "spawn",
  "list",
  "status",
  "transcript",
  "prompt",
  "steer",
  "follow_up",
  "abort",
  "kill",
  "last_output",
  "reply_ui",
  "cleanup",
] as const, { description: "Subagent operation." });

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
  description: 'Agent directories to search. Default: "user". Use "both" to include trusted project agents.',
  default: "user",
});

type ActionName =
  | "list_agents"
  | "spawn"
  | "list"
  | "status"
  | "transcript"
  | "prompt"
  | "steer"
  | "follow_up"
  | "abort"
  | "kill"
  | "last_output"
  | "reply_ui"
  | "cleanup";

function formatSnapshot(run: RunSnapshot): string {
  const parts = [
    `${run.id}`,
    `agent=${run.agent}`,
    `status=${getDisplayRunStatus(run)}`,
  ];
  if (run.model) parts.push(`model=${run.model}`);
  if (run.turns) parts.push(`turns=${run.turns}`);
  if (run.usage && run.usage.totalTokens > 0) {
    parts.push(`tokens=${run.usage.totalTokens}`);
    if (run.usage.cost > 0) parts.push(`cost=$${run.usage.cost.toFixed(4)}`);
  }
  if (run.lastError) parts.push(`error=${run.lastError}`);
  return parts.join(" ");
}

function resolveRun(id: string | undefined) {
  if (!id) throw new Error("id is required for this action");
  const run = registry.get(id);
  if (!run) throw new Error(`Subagent not found or ambiguous id prefix: ${id}`);
  return run;
}

function isNeedsAttention(run: RunSnapshot): boolean {
  return run.status === "needs_attention" || (run.pendingUiRequests?.length ?? 0) > 0;
}

function isTerminalRun(run: RunSnapshot): boolean {
  const display = getDisplayRunStatus(run);
  return display === "complete" || run.status === "exited" || run.status === "error" || run.status === "killed";
}

// Notification counts describe execution, not retained session liveness. An
// idle follow-up-capable run is available but is NOT "still running".
function runningCount(runs: RunSnapshot[]): number {
  return runs.filter((run) => {
    const status = getDisplayRunStatus(run);
    return status === "starting" || status === "running" || status === "needs_attention";
  }).length;
}

// We only ever notify the user on three meaningful, one-shot transitions per
// run: it starts needing attention (pending child UI request), it finishes
// (complete/exited), or it errors (error/killed). Everything else that flows
// through registry.onChange (streaming deltas, turn/tool events, token updates)
// is intentionally silent. We track the last notable state per run and only
// notify when a run transitions INTO a new notable state.
type NotableState = "none" | "needs_attention" | "finished" | "error";

function notableState(run: RunSnapshot): NotableState {
  if (run.status === "error" || run.status === "killed") return "error";
  if (isTerminalRun(run)) return "finished";
  if (isNeedsAttention(run)) return "needs_attention";
  return "none";
}

// First observation of any run (fresh spawn or history restored from disk) just
// records its current notable state without notifying, which avoids stale or
// duplicate notifications across reloads and restores.
const lastNotableSeen = new Map<string, NotableState>();
let notifyReady = false;
// (Plan B) Notable transitions are delivered to the main agent via triggerTurn.
// They are buffered and flushed on a short debounce so a BURST (e.g. a bulk
// kill/cleanup, or many runs finishing at once) coalesces into ONE notification
// instead of one per subagent.
const notableBuffer: Array<{ summary: string; state: NotableState }> = [];
let notableFlushTimer: ReturnType<typeof setTimeout> | undefined;

// Record the current notable state of all runs without notifying, then arm
// notifications. Called once per session_start after persistence is restored.
function seedNotableRuns(): void {
  lastNotableSeen.clear();
  for (const run of registry.list()) lastNotableSeen.set(run.id, notableState(run));
  notifyReady = true;
}

function notifyNotable(pi: ExtensionAPI): void {
  if (!notifyReady) return;
  const runs = registry.list();
  const remaining = runningCount(runs);
  const liveIds = new Set<string>();
  for (const run of runs) {
    liveIds.add(run.id);
    const state = notableState(run);
    const prev = lastNotableSeen.get(run.id);
    lastNotableSeen.set(run.id, state);
    // First observation, no change, or a return to a non-notable state: skip.
    if (prev === undefined || prev === state || state === "none") continue;

    let summary: string;
    if (state === "needs_attention") {
      summary = `Subagent ${run.agent} (${run.id}) needs attention: waiting on a UI request. Use agents action=status then reply_ui.`;
    } else {
      const usage = run.usage && run.usage.totalTokens > 0
        ? ` · ${run.usage.totalTokens} tok${run.usage.cost > 0 ? ` $${run.usage.cost.toFixed(4)}` : ""}`
        : "";
      if (state === "error") {
        const verb = run.status === "killed" ? "was killed" : "failed";
        const errorInfo = run.lastError ? ` (${run.lastError})` : "";
        summary = `Subagent ${run.agent} (${run.id}) ${verb}${usage}${errorInfo}. ${remaining} subagent(s) still running.`;
      } else {
        summary = `Subagent ${run.agent} (${run.id}) completed${usage}. ${remaining} subagent(s) still running.`;
      }
    }

    // Buffer the transition; a debounced flush coalesces bursts into a single
    // notification to the main agent (see flushNotable).
    notableBuffer.push({ summary, state });
  }
  // Drop bookkeeping for runs removed via cleanup so ids can't leak memory.
  for (const id of lastNotableSeen.keys()) {
    if (!liveIds.has(id)) lastNotableSeen.delete(id);
  }
  scheduleNotableFlush(pi);
}

function scheduleNotableFlush(pi: ExtensionAPI): void {
  if (notableFlushTimer) return;
  notableFlushTimer = setTimeout(() => { notableFlushTimer = undefined; flushNotable(pi); }, 150);
}

// Deliver buffered notable transitions to the main agent as ONE message. A
// single update keeps its full text; a burst becomes a compact count so a bulk
// kill/cleanup doesn't spam the agent (or the user) one line per subagent.
function flushNotable(pi: ExtensionAPI): void {
  if (notableBuffer.length === 0) return;
  const items = notableBuffer.splice(0);
  let content: string;
  if (items.length === 1) {
    content = items[0]!.summary;
  } else {
    const finished = items.filter((i) => i.state === "finished").length;
    const errored = items.filter((i) => i.state === "error").length;
    const needsAttention = items.filter((i) => i.state === "needs_attention").length;
    const parts: string[] = [];
    if (finished) parts.push(`${finished} completed`);
    if (errored) parts.push(`${errored} stopped/failed`);
    if (needsAttention) parts.push(`${needsAttention} need attention`);
    const remaining = runningCount(registry.list());
    content = `${items.length} subagents updated: ${parts.join(", ")}. ${remaining} still running.`;
  }
  try {
    pi.sendMessage({ customType: SUBAGENT_NOTIFICATION_TYPE, content, display: true }, { triggerTurn: true });
  } catch {
    // No active/committable session yet — nothing to deliver.
  }
}

// Wire the shared registry listeners exactly once, and only for the primary
// (top-level) session. Child subagent sessions never call this, so they can't
// duplicate the listeners or redirect notifications into their own session.
// (No footer counts anymore — the persistent agent list IS the status UI.)
function wireGlobalListeners(): void {
  if (globalListenersWired) return;
  globalListenersWired = true;
  // Notify the main agent on notable transitions (needs_attention/finished/error).
  registry.onChange(() => { if (primaryPi) notifyNotable(primaryPi); });
}

async function waitForIdle(run: ReturnType<typeof resolveRun>, timeoutSeconds: number): Promise<RunSnapshot> {
  const deadline = Date.now() + Math.max(0, timeoutSeconds) * 1000;
  let snapshot = await run.refreshState().catch(() => run.snapshot());
  while (Date.now() < deadline) {
    snapshot = run.snapshot();
    if (!run.isAlive || (snapshot.status === "idle" && !snapshot.isStreaming && snapshot.pendingMessageCount === 0)) {
      return snapshot;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return run.snapshot();
}

function toolText(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

/**
 * True when this Pi process runs in a non-interactive single-shot mode
 * (`pi -p` / `--print`, or `--mode json`) — one turn, then the process exits and
 * tears down in-process subagents on session_shutdown. Detected from argv at
 * load time (no ctx yet). Interactive `tui` and long-lived `rpc` return false.
 */
function isSingleShotMode(argv: string[] = process.argv): boolean {
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-p" || arg === "--print") return true;
    if (arg === "--mode" && (argv[i + 1] === "print" || argv[i + 1] === "json")) return true;
    if (arg === "--mode=print" || arg === "--mode=json") return true;
  }
  return false;
}

export default async function (pi: ExtensionAPI) {
  await installForegroundRuntimePatches();
  // The shared registry listeners (notifications) are wired lazily from the
  // primary session's session_start via wireGlobalListeners() — never from a
  // child subagent session — so in-process subagents can't clobber or duplicate
  // them.
  //
  // Per-INSTANCE UI state: this factory runs once per session (the primary
  // session AND every in-process subagent session). Each instance wires the
  // persistent agent list onto its OWN ui context; the host proxy parks and
  // replays that footprint on foreground switches, so the list is visible no
  // matter which agent currently owns the terminal.
  let list: SubagentList | undefined;
  let listTui: { requestRender(force?: boolean): void } | undefined;
  let unsubListChange: (() => void) | undefined;
  let unsubListInput: (() => void) | undefined;
  // While the /agents manager owns the editor slot, the raw list input
  // handler MUST stand down: the editor is replaced, so getEditorText() is
  // empty and ↓ would be hijacked away from the manager — leaving a stale
  // focused component behind after a foreground switch.
  let popupOpen = false;

  function cleanupListUi(ctx: ExtensionContext): void {
    unsubListChange?.(); unsubListChange = undefined;
    unsubListInput?.(); unsubListInput = undefined;
    list?.dispose(); list = undefined;
    listTui = undefined;
    if (ctx.hasUI) {
      try { ctx.ui.setWidget("subagent-list", undefined, { placement: "belowEditor" }); } catch { /* ignore */ }
    }
  }

  function isListActionKey(data: string): boolean {
    return matchesKey(data, Key.up) || matchesKey(data, Key.down) || matchesKey(data, Key.enter) || matchesKey(data, Key.escape)
      || data === "q" || data === "a" || data === "k";
  }

  function setupListUi(ctx: ExtensionContext): void {
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    const agents = agentsOf(ctx);
    if (!agents) return; // un-adopted child or non-interactive host: no foreground UI
    cleanupListUi(ctx);

    ctx.ui.setWidget("subagent-list", (tui: any, theme: any) => {
      // Finished runs fading out shrink the widget; clear vacated rows.
      try { tui.setClearOnShrink?.(true); } catch { /* ignore */ }
      const component = new SubagentList(
        registry,
        theme,
        () => { try { return agents.getForeground(); } catch { return "main"; } },
        (action: ListAction) => {
          if (action.type === "foreground") void switchForeground(ctx, action.id);
          else { try { tui.requestRender(); } catch { /* ignore */ } }
        },
        () => { try { tui.requestRender(); } catch { /* ignore */ } },
      );
      list = component;
      listTui = tui;
      return component;
    }, { placement: "belowEditor" });

    unsubListChange = registry.onChange(() => { try { listTui?.requestRender(); } catch { /* ignore */ } });
    unsubListInput = ctx.ui.onTerminalInput((data: string) => {
      if (!list || popupOpen) return undefined;
      if (list.isFocused) {
        if (isKeyRelease(data)) return { consume: true };
        if (matchesKey(data, "alt+a")) { list.blur(); return { consume: true }; }
        if (isListActionKey(data)) { list.handleInput(data); return { consume: true }; }
        list.blur(); // any other key (typing) falls through to the editor
        return undefined;
      }
      if (isKeyRelease(data)) return undefined;
      // ↓ on an empty editor (Claude-Code style) or alt+a focuses the list.
      if (matchesKey(data, "alt+a")) {
        if (list.focus()) return { consume: true };
        return undefined;
      }
      if (matchesKey(data, Key.down)) {
        let editorEmpty = false;
        try { editorEmpty = ctx.ui.getEditorText().trim() === ""; } catch { /* ignore */ }
        if (editorEmpty && list.focus()) return { consume: true };
      }
      return undefined;
    });
  }

  // Leave notification chrome to the active presentation extension.
  pi.registerMessageRenderer(SUBAGENT_NOTIFICATION_TYPE, (message, _options, _theme) =>
    new Text(String(message.content ?? ""), 0, 0),
  );

  // Render legacy injected subagent-view messages as native markdown.
  pi.registerMessageRenderer(SUBAGENT_VIEW_TYPE, (message, _options, _theme) =>
    new Markdown(String(message.content ?? ""), 1, 0, getMarkdownTheme()),
  );

  // Keep legacy injected subagent-view messages out of the MAIN agent's LLM context.
  pi.on("context", async (event) => {
    const filtered = event.messages.filter((m: any) => m?.customType !== SUBAGENT_VIEW_TYPE);
    if (filtered.length !== event.messages.length) return { messages: filtered };
  });

  // `/agents <id|main>` switches foreground directly; bare `/agents` opens
  // the manager. Registered in child sessions too, so it remains the escape
  // hatch while a subagent owns the terminal.
  const agentsCommand = async (args: string | undefined, ctx: any) => {
    const arg = (args ?? "").trim();
    if (arg) {
      const id = arg === "main" ? "main" : registry.get(arg)?.id;
      if (!id) { ctx.ui.notify(`Subagent not found: ${arg}`, "warning"); return; }
      await switchForeground(ctx, id);
      return;
    }
    list?.blur();
    popupOpen = true;
    let action: { type: "foreground"; id: string } | undefined;
    try {
      action = await openSubagentPopup(ctx, registry, () => {
        try { return agentsOf(ctx)?.getForeground() ?? "main"; } catch { return "main"; }
      });
    } finally {
      popupOpen = false;
    }
    // The popup is CLOSED before any switch — a live focused component must
    // never survive a foreground switch (it would keep eating keystrokes).
    if (action) await switchForeground(ctx, action.id);
  };

  pi.registerCommand("agents", {
    description: "Open the agent manager or switch foreground (`/agents <id|main>`)",
    handler: agentsCommand,
  });

  // Listed in /hotkeys; actual handling happens in the raw terminal-input
  // listener above, which also works when other extensions replace the editor
  // component (e.g. pi-powerline-footer) and extension shortcut routing breaks.
  pi.registerShortcut("alt+a", {
    description: "Focus the agent list",
    handler: async () => { list?.focus(); },
  });

  pi.on("session_start", (_event, ctx) => {
    // Global (shared) wiring belongs to the primary session only.
    if (!isChildSession(ctx)) {
      primaryPi = pi;
      wireGlobalListeners();
      registry.configurePersistence(ctx.cwd);
      seedNotableRuns();
    }
    // Every session instance (main and children) renders the agent list on its
    // own ui context so it survives foreground switches. Children additionally
    // replace pi's generic startup banner with their live run identity.
    setupChildHeader(ctx);
    setupListUi(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    cleanupListUi(ctx);
    // A child (subagent) session shutting down must NOT tear down the shared
    // registry or kill the whole fleet.
    if (isChildSession(ctx)) return;
    // Suppress completion notifications for the killAll below during shutdown.
    notifyReady = false;
    registry.killAll("parent pi session shutdown");
  });

  pi.registerTool({
    name: "agents",
    label: "Agents",
    description: [
      "Spawn and control first-class in-process Pi subagent sessions.",
      "Use action=list_agents to discover agents, action=spawn to start one, then status/transcript/steer/follow_up/abort/kill with its id.",
      "Unlike one-shot delegation, spawned subagents stay registered until killed/exited/cleanup.",
      `Default user agents directory: ${path.join(getAgentDir(), "agents")}. Project agents live in ${CONFIG_DIR_NAME}/agents when agentScope allows them.`,
    ].join(" "),
    promptSnippet: "Spawn and manage controllable Pi subagent sessions with status, transcript, steer, follow_up, abort, and kill actions.",
    promptGuidelines: [
      "Use agents when work should run in an isolated Pi agent session that may need later status checks or steering.",
      "Call agents with action=list_agents before spawning an unfamiliar agent name.",
      "Do not use agents recursively unless maxDepth is explicitly increased by the user.",
      "After spawning subagents with wait:false in an interactive session, do NOT sleep, poll, or run bash/shell commands to wait for them. If you have no other work, just end your turn: pi automatically wakes you with a message the moment any subagent finishes, fails, or needs attention.",
      "The only correct way to block on subagents is the agent_wait tool, which exists only in non-interactive single-shot runs (pi -p / --mode json). Never use `sleep` as a substitute for waiting.",
    ],
    parameters: Type.Object({
      action: Action,
      agent: Type.Optional(Type.String({ description: "Agent name for spawn." })),
      task: Type.Optional(Type.String({ description: "Initial task/prompt for spawn, or prompt text for prompt/steer/follow_up when message is omitted." })),
      id: Type.Optional(Type.String({ description: "Subagent id or unique id prefix for status/control actions." })),
      message: Type.Optional(Type.String({ description: "Message for prompt/steer/follow_up, or value text for reply_ui." })),
      requestId: Type.Optional(Type.String({ description: "Pending child UI request id for reply_ui." })),
      value: Type.Optional(Type.Any({ description: "Value for reply_ui. For confirm use boolean; for input/editor use string; for select use selected string." })),
      cwd: Type.Optional(Type.String({ description: "Working directory for spawned subagent. Defaults to current cwd." })),
      model: Type.Optional(Type.String({ description: "Override model for spawned subagent, e.g. provider/model or configured model pattern." })),
      thinking: Type.Optional(Type.String({ description: "Optional thinking level suffix for --model, e.g. off/low/medium/high." })),
      tools: Type.Optional(Type.Array(Type.String(), { description: "Legacy exact tool allowlist override for spawned subagent. Equivalent to allowTools, and takes precedence when set." })),
      allowTools: Type.Optional(Type.Array(Type.String(), { description: "Tool allowlist for the child subagent. Passed as --tools. If omitted, the agent file's tools are used when present; otherwise Pi's defaults apply." })),
      denyTools: Type.Optional(Type.Array(Type.String(), { description: "Tool denylist for the child subagent. Passed as --exclude-tools and applied after allowTools/tools/defaults." })),
      extensions: Type.Optional(Type.Array(Type.String(), { description: "Extra Pi extension paths to load in the child subagent process. Passed as repeated --extension flags. Relative paths resolve from the child cwd." })),
      inheritExtensions: Type.Optional(Type.Boolean({ description: "Inherit parent CLI --extension/-e and --no-extensions flags. Default true. Auto-discovered user/project/package extensions are loaded by Pi normally unless noExtensions is true.", default: true })),
      noExtensions: Type.Optional(Type.Boolean({ description: "Disable Pi extension auto-loading in the child subagent process. Extra extensions are still passed if extensions is set. If omitted, parent --no-extensions is inherited when inheritExtensions is true.", default: false })),
      name: Type.Optional(Type.String({ description: "Session display name for spawned subagent." })),
      sessionDir: Type.Optional(Type.String({ description: "Optional custom Pi session directory for spawned subagent." })),
      noSession: Type.Optional(Type.Boolean({ description: "Disable child session persistence. Default false.", default: false })),
      agentScope: Type.Optional(AgentScopeSchema),
      wait: Type.Optional(Type.Boolean({ description: "For spawn/prompt/steer/follow_up, wait for child to become idle before returning. Default false.", default: false })),
      waitSeconds: Type.Optional(Type.Number({ description: "Maximum seconds to wait when wait=true. Default 180.", default: 180 })),
      maxDepth: Type.Optional(Type.Number({ description: "Maximum nested subagent depth. Default 1 (children cannot spawn grandchildren).", default: 1 })),
      lines: Type.Optional(Type.Number({ description: "Transcript lines to return. Default 80.", default: 80 })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const action = params.action as ActionName;
      const agentScope: AgentScope = params.agentScope ?? "user";
      const discovery = discoverAgents(ctx.cwd, agentScope, ctx.isProjectTrusted());
      const waitSeconds = params.waitSeconds ?? 180;

      if (action === "list_agents") {
        return toolText(describeAgents(discovery.agents), {
          agents: discovery.agents.map((agent) => ({
            name: agent.name,
            description: agent.description,
            source: agent.source,
            filePath: agent.filePath,
            model: agent.model,
            tools: agent.tools,
          })),
          packageAgentsDir: discovery.packageAgentsDir,
          userAgentsDir: discovery.userAgentsDir,
          projectAgentsDir: discovery.projectAgentsDir,
          agentScope,
        });
      }

      if (action === "spawn") {
        const maxDepth = params.maxDepth ?? 1;
        // Real in-process depth of the caller: 0 for the top-level session, ≥1
        // when a subagent tries to spawn its own subagent.
        const callerDepth = childDepthOf(ctx);
        if (callerDepth >= maxDepth) {
          return toolText(`Refusing to spawn nested subagent at depth ${callerDepth}; maxDepth=${maxDepth}.`, { currentDepth: callerDepth, maxDepth });
        }
        if (!params.agent) return toolText("agent is required for spawn", { error: "missing_agent" });
        const agent = discovery.agents.find((candidate) => candidate.name === params.agent);
        if (!agent) {
          return toolText(`Unknown agent: ${params.agent}\n\nAvailable agents:\n${describeAgents(discovery.agents)}`, {
            error: "unknown_agent",
            agents: discovery.agents.map((candidate) => candidate.name),
          });
        }
        const run = await registry.spawn({
          agent,
          task: params.task,
          cwd: params.cwd ?? ctx.cwd,
          model: params.model,
          thinking: params.thinking,
          tools: params.tools,
          allowTools: params.allowTools,
          denyTools: params.denyTools,
          extensions: params.extensions,
          inheritExtensions: params.inheritExtensions,
          noExtensions: params.noExtensions,
          name: params.name ?? `subagent:${agent.name}`,
          sessionDir: params.sessionDir,
          noSession: params.noSession,
          depth: callerDepth + 1,
          // Adopt the child session as a background agent so the user can
          // foreground it (↓ list / /agents). Undefined on non-TUI hosts →
          // the child runs headless exactly as before.
          adopt: agentsOf(ctx)?.adopt,
        });
        const snapshot = params.wait ? await waitForIdle(run, waitSeconds) : run.snapshot();
        // Reinforce the right waiting model right where the agent decides what to
        // do next, so it doesn't reach for `sleep`/bash to poll.
        const hint = params.wait
          ? ""
          : isSingleShotMode()
            ? "\nRunning in the background. Call the agent_wait tool to block until it finishes; do not use sleep."
            : "\nRunning in the background. Do NOT sleep or poll. If you have nothing else to do, end your turn now — you will be automatically notified when it finishes, fails, or needs attention.";
        return toolText(`Spawned ${snapshot.id}\n${formatSnapshot(snapshot)}${hint}`, { run: snapshot });
      }

      if (action === "list") {
        const runs = registry.list();
        const text = runs.length === 0 ? "No subagents." : runs.map(formatSnapshot).join("\n");
        return toolText(text, { runs });
      }

      if (action === "cleanup") {
        const removed = registry.removeExited();
        return toolText(`Removed ${removed} exited subagent(s).`, { removed, runs: registry.list() });
      }

      const run = resolveRun(params.id);

      if (action === "status") {
        const snapshot = await run.refreshState();
        return toolText(formatSnapshot(snapshot), { run: snapshot });
      }

      if (action === "transcript") {
        const lines = Math.max(1, Math.min(500, params.lines ?? 80));
        const transcript = run.transcript.slice(-lines);
        return toolText(transcript.join("\n") || "(no transcript)", { run: run.snapshot(), transcript });
      }

      if (action === "prompt" || action === "steer" || action === "follow_up") {
        const message = params.message ?? params.task;
        if (!message) return toolText("message or task is required", { error: "missing_message" });
        if (action === "prompt") await run.prompt(message);
        else if (action === "steer") await run.steer(message);
        else await run.followUp(message);
        const snapshot = params.wait ? await waitForIdle(run, waitSeconds) : run.snapshot();
        return toolText(`${action} queued for ${run.id}\n${formatSnapshot(snapshot)}`, { run: snapshot });
      }

      if (action === "abort") {
        await run.abort();
        const snapshot = run.snapshot();
        return toolText(`Abort requested for ${run.id}.`, { run: snapshot });
      }

      if (action === "kill") {
        run.kill("killed by agents tool");
        const snapshot = run.snapshot();
        return toolText(`Killed ${run.id}.`, { run: snapshot });
      }

      if (action === "last_output") {
        const text = await run.getLastAssistantText().catch(() => run.lastAssistantText);
        return toolText(text || "(no assistant output yet)", { run: run.snapshot() });
      }

      if (action === "reply_ui") {
        const requestId = params.requestId;
        if (!requestId) return toolText("requestId is required for reply_ui", { error: "missing_request_id", run: run.snapshot() });
        const value = params.value ?? params.message;
        const ok = typeof (run as any).replyUi === "function" ? (run as any).replyUi(requestId, value) : false;
        return toolText(ok ? `Replied to UI request ${requestId}.` : `UI request not found or unsupported: ${requestId}`, { ok, run: run.snapshot() });
      }

      return toolText(`Unknown action: ${action}`, { error: "unknown_action" });
    },

    renderCall(args, theme) {
      const action = args.action ?? "?";
      const target = args.agent ?? args.id ?? "";
      return new Text(`${theme.fg("toolTitle", theme.bold("agents"))} ${theme.fg("accent", action)} ${theme.fg("muted", target)}`, 0, 0);
    },

    renderResult(result, _options, theme) {
      const text = result.content[0];
      const content = text?.type === "text" ? text.text : "(no output)";
      return new Text(theme.fg("toolOutput", content), 0, 0);
    },
  });

  // ── agent_wait ──────────────────────────────────────────────────────
  // A blocking companion to agents: keeps the current turn alive until
  // background subagents (spawned with wait:false) finish or need attention.
  //
  // Only registered in non-interactive single-shot modes (`pi -p` / `--mode
  // json`). There the turn ends → session_shutdown → killAll tears down the
  // still-running in-process subagents before they finish, so the agent must be
  // able to block and let them complete. Interactive (tui) sessions never
  // auto-exit between turns, so a finishing subagent is surfaced by the
  // triggerTurn notification in notifyNotable — wait is unnecessary and is not
  // registered there.
  if (isSingleShotMode()) pi.registerTool({
    name: "agent_wait",
    label: "Agent Wait",
    description: [
      "Block until background subagent runs started in this session finish, then return.",
      "Use after spawning subagents with wait:false when you have no independent work left and must not end your turn — e.g. inside a skill that must run to completion, or a non-interactive `pi -p` run where the whole task is a single turn.",
      "{ } — return as soon as the FIRST active run finishes (good for a rolling fleet: spawn N, wait, replace the finished one, wait again).",
      "{ all:true } — block until EVERY active run is finished.",
      "{ id:\"...\" } — wait for one specific run (id or unique prefix).",
      "{ timeoutMs:600000 } — stop waiting after N ms (runs keep going; default 30 min).",
      "Also returns when a run needs attention (idle-blocked on a child UI request), so a stuck child never stalls the loop — the summary names the run(s) to inspect with agents action=status then reply_ui / steer / abort.",
    ].join(" "),
    promptSnippet: "Block the current turn until background subagents finish or need attention (use in skills / `pi -p` after spawning wait:false subagents).",
    promptGuidelines: [
      "Call agent_wait after launching subagents with wait:false when the turn would otherwise end with children still running.",
      "Prefer agent_wait over ending the turn in skills and non-interactive runs; there is no next turn to receive completion notifications there.",
    ],
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Run id or unique id prefix to wait for. Omit to wait across every active run in this session." })),
      all: Type.Optional(Type.Boolean({ description: "When true (and no id), block until EVERY active run finishes. Default false: return on the first finish.", default: false })),
      timeoutMs: Type.Optional(Type.Number({ description: "Give up after this many milliseconds. Runs keep going regardless. Default 1800000 (30 min).", default: 1_800_000 })),
    }),

    async execute(_toolCallId, params, signal) {
      return waitForSubagents(
        registry,
        { id: params.id, all: params.all, timeoutMs: params.timeoutMs },
        signal ?? undefined,
      );
    },

    renderCall(args, theme) {
      const scope = args.id ? `#${args.id}` : args.all ? "all" : "first";
      return new Text(`${theme.fg("toolTitle", theme.bold("agent_wait"))} ${theme.fg("muted", scope)}`, 0, 0);
    },

    renderResult(result, _options, theme) {
      const text = result.content[0];
      const content = text?.type === "text" ? text.text : "(no output)";
      return new Text(theme.fg("toolOutput", content), 0, 0);
    },
  });
}

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
  withFileMutationQueue,
  type AgentSession,
  type AgentSessionRuntime,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentConfig } from "./agents.ts";
import type { ForegroundAgentsApi, RuntimePatchedAgentSession } from "./runtime-types.ts";

export type RunStatus = "starting" | "idle" | "running" | "needs_attention" | "exited" | "killed" | "error";
export type RpcEvent = Record<string, any>;

export interface RunUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  totalTokens: number;
  cost: number;
}

function emptyUsage(): RunUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: 0 };
}

function accumulateUsage(target: RunUsage, usage: any): void {
  if (!usage || typeof usage !== "object") return;
  target.input += Number(usage.input ?? 0) || 0;
  target.output += Number(usage.output ?? 0) || 0;
  target.cacheRead += Number(usage.cacheRead ?? 0) || 0;
  target.cacheWrite += Number(usage.cacheWrite ?? 0) || 0;
  target.reasoning += Number(usage.reasoning ?? 0) || 0;
  target.totalTokens += Number(usage.totalTokens ?? 0) || 0;
  target.cost += Number(usage.cost?.total ?? 0) || 0;
}

/**
 * Host adopt hook supplied natively or by the stock-pi runtime patch. When provided, the child
 * session is adopted as a background agent BEFORE bindExtensions, so its
 * extension UI footprint lands on the host-managed SessionUiProxy and is
 * replayed whenever the subagent is foregrounded.
 */
export type AdoptSessionFn = ForegroundAgentsApi["adopt"];

export interface SpawnRunOptions {
  agent: AgentConfig;
  task?: string;
  cwd: string;
  model?: string;
  thinking?: string;
  tools?: string[];
  allowTools?: string[];
  denyTools?: string[];
  extensions?: string[];
  inheritExtensions?: boolean;
  noExtensions?: boolean;
  name?: string;
  sessionDir?: string;
  noSession?: boolean;
  depth?: number;
  onChange?: () => void;
  adopt?: AdoptSessionFn;
  /** Reuse an existing run id (revive keeps the registry identity stable). */
  id?: string;
  /** Resume an existing session file instead of creating a fresh session. */
  resumeSessionFile?: string;
}

export interface RunSnapshot {
  id: string;
  agent: string;
  agentSource: AgentConfig["source"];
  task?: string;
  cwd: string;
  status: RunStatus;
  startedAt: number;
  updatedAt: number;
  exitedAt?: number;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  model?: string;
  isStreaming?: boolean;
  pendingMessageCount?: number;
  turns: number;
  usage: RunUsage;
  lastAssistantText?: string;
  lastError?: string;
  transcriptPreview: string[];
  renderEvents: RpcEvent[];
  eventCount: number;
  pendingUiRequests?: PendingUiRequestSnapshot[];
}

export interface PendingUiRequestSnapshot {
  id: string;
  method: "select" | "confirm" | "input" | "editor" | "custom";
  title?: string;
  message?: string;
  options?: unknown;
  createdAt: number;
}

export function getDisplayRunStatus(run: Pick<RunSnapshot, "status" | "turns" | "isStreaming" | "pendingMessageCount">): RunStatus | "complete" {
  if (run.status === "idle" && run.turns > 0 && !run.isStreaming && (run.pendingMessageCount ?? 0) === 0) return "complete";
  return run.status;
}

function makeRunId(agent: string): string {
  const safe = agent.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "agent";
  return `${safe}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function getParentCliExtensionOptions(): { extensions: string[]; noExtensions: boolean } {
  const extensions: string[] = [];
  let noExtensions = false;

  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if ((arg === "--extension" || arg === "-e") && i + 1 < process.argv.length) {
      extensions.push(process.argv[++i]!);
    } else if (arg?.startsWith("--extension=")) {
      extensions.push(arg.slice("--extension=".length));
    } else if (arg === "--no-extensions" || arg === "-ne") {
      noExtensions = true;
    }
  }

  return { extensions, noExtensions };
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0)));
}

async function writeSystemPrompt(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "claude-style-subagent-"));
  const safe = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(dir, `${safe}-system.md`);
  await withFileMutationQueue(filePath, async () => {
    await fs.promises.writeFile(filePath, prompt, { encoding: "utf8", mode: 0o600 });
  });
  return { dir, filePath };
}

function extractAssistantText(message: any): string | undefined {
  if (!message || message.role !== "assistant") return undefined;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return undefined;
  return message.content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n") || undefined;
}

function extractContentText(value: any): string | undefined {
  if (typeof value === "string") return value;
  if (!value) return undefined;

  if (Array.isArray(value)) {
    const text = value.map(extractContentText).filter(Boolean).join("\n");
    return text || undefined;
  }

  if (typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    if (typeof value.output === "string") return value.output;
    if (typeof value.stdout === "string") return value.stdout;
    if (typeof value.stderr === "string") return value.stderr;
    if (value.content !== undefined) {
      const inner = extractContentText(value.content);
      if (inner) return inner;
    }
    // MCP tool results: text may live in structuredContent, a resource part,
    // or a json payload rather than a plain { type: "text", text } part.
    if (value.structuredContent !== undefined) {
      const structured = extractContentText(value.structuredContent);
      if (structured) return structured;
    }
    if (value.resource && typeof value.resource.text === "string") return value.resource.text;
    if (value.json !== undefined) {
      try { return JSON.stringify(value.json); } catch { /* ignore */ }
    }
  }

  return undefined;
}

// Last-resort: never leave a tool result blank in the transcript. If we could
// not pull readable text out (common for MCP tools with non-text payloads),
// fall back to a compact JSON dump so the dock still shows the actual content.
function extractToolOutput(raw: any): string | undefined {
  const text = extractContentText(raw);
  if (text) return text;
  if (raw && typeof raw === "object") {
    try {
      const json = JSON.stringify(raw);
      if (json && json !== "{}" && json !== "[]") return json;
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

function previewText(text: string, maxLines = 12, maxChars = 2000): string[] {
  const normalized = text.replace(/\r/g, "").trimEnd();
  if (!normalized) return [];
  const lines = normalized.split("\n").slice(0, maxLines);
  const preview = lines.join("\n").slice(0, maxChars);
  const result = preview.split("\n");
  if (normalized.length > preview.length || normalized.split("\n").length > maxLines) result.push("…");
  return result;
}

function normalizeThinkingLevel(value: string | undefined): ThinkingLevel | undefined {
  if (!value) return undefined;
  if (["off", "minimal", "low", "medium", "high", "xhigh"].includes(value)) return value as ThinkingLevel;
  return undefined;
}

function compactArgs(args: any): string {
  if (!args || typeof args !== "object" || Object.keys(args).length === 0) return "";
  try {
    const json = JSON.stringify(args);
    return json.length > 100 ? `${json.slice(0, 100)}…` : json;
  } catch {
    return "";
  }
}

// Build a clean, pi-like transcript straight from the structured session
// messages. This is the preferred path (SDK backend) because the message
// objects are complete and coherent: full assistant text, collapsed thinking,
// tool calls with args, and tool results (including MCP payloads). No event
// deltas, no fragments, no duplication.
function messagesToTranscript(messages: any[]): string[] {
  const lines: string[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;

    // Tool results are their own messages; show the output indented under the
    // preceding `→ tool` call line.
    if (message.role === "toolResult") {
      const out = extractToolOutput(message.content);
      const marker = message.isError ? "✗" : "✓";
      if (out) {
        const preview = previewText(out, 8, 1200);
        lines.push(`  ${marker} ${preview[0] ?? ""}`.trimEnd());
        for (const extra of preview.slice(1)) lines.push(`    ${extra}`);
      }
      continue;
    }

    const parts = typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : Array.isArray(message.content) ? message.content : [];

    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      if (part.type === "thinking") {
        const first = previewText(String(part.thinking ?? part.text ?? ""), 1, 160)[0];
        if (first) lines.push(`💡 ${first}`);
      } else if (part.type === "text") {
        const text = String(part.text ?? "");
        if (text.trim()) lines.push(...previewText(text, 40, 4000));
      } else if (part.type === "toolCall" || part.type === "tool_use" || part.type === "toolcall") {
        const name = part.name ?? part.toolName ?? "tool";
        const args = compactArgs(part.arguments ?? part.args ?? part.input);
        lines.push(`→ ${name}${args ? ` ${args}` : ""}`);
      }
    }
  }
  return lines;
}

interface ManagedSubagentRun {
  readonly id: string;
  readonly agent: AgentConfig;
  readonly cwd: string;
  readonly task?: string;
  readonly startedAt: number;
  status: RunStatus;
  lastAssistantText?: string;
  lastError?: string;
  readonly transcript: string[];
  get isAlive(): boolean;
  prompt(message: string): Promise<RpcEvent>;
  steer(message: string): Promise<RpcEvent>;
  followUp(message: string): Promise<RpcEvent>;
  abort(): Promise<RpcEvent>;
  refreshState(): Promise<RunSnapshot>;
  getLastAssistantText(): Promise<string | undefined>;
  kill(reason?: string): void;
  snapshot(): RunSnapshot;
  /** Live in-process session, when this run is backed by one (SDK runs only). */
  readonly agentSession?: AgentSession;
  /** Replay dialogs that queued up while backgrounded onto the (now-active) UI. */
  surfacePendingUiRequests(): Promise<void>;
}

interface PendingUiRequestInternal extends PendingUiRequestSnapshot {
  resolve: (value: any) => void;
}

class SdkSubagentRun implements ManagedSubagentRun {
  readonly id: string;
  readonly agent: AgentConfig;
  readonly cwd: string;
  readonly task?: string;
  readonly depth: number;
  readonly startedAt = Date.now();
  updatedAt = this.startedAt;
  exitedAt?: number;
  status: RunStatus = "starting";
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  model?: string;
  isStreaming = false;
  pendingMessageCount = 0;
  turns = 0;
  usage: RunUsage = emptyUsage();
  lastAssistantText?: string;
  lastError?: string;

  readonly events: RpcEvent[] = [];
  readonly transcript: string[] = [];
  private pendingUiRequests = new Map<string, PendingUiRequestInternal>();
  private runtime?: AgentSessionRuntime;
  private session?: RuntimePatchedAgentSession;
  private detachFromHost?: () => void;
  private unsubscribe?: () => void;
  private onChange: () => void;
  private activeRuns = new Set<Promise<void>>();

  private constructor(id: string, options: SpawnRunOptions) {
    this.id = id;
    this.agent = options.agent;
    this.cwd = options.cwd;
    this.task = options.task;
    this.onChange = options.onChange ?? (() => {});
    this.model = options.model ?? options.agent.model;
    this.sessionName = options.name;
    this.depth = options.depth ?? 1;
  }

  static async spawn(options: SpawnRunOptions): Promise<SdkSubagentRun> {
    const run = new SdkSubagentRun(options.id ?? makeRunId(options.agent.name), options);
    await run.initialize(options);
    if (options.task) await run.prompt(options.task);
    return run;
  }

  get isAlive(): boolean { return this.status !== "exited" && this.status !== "killed" && this.status !== "error"; }
  get agentSession(): AgentSession | undefined { return this.session; }

  private async initialize(options: SpawnRunOptions): Promise<void> {
    const allowTools = options.tools ?? options.allowTools ?? options.agent.tools;
    const excludeTools = options.denyTools;
    const inheritExtensions = options.inheritExtensions ?? true;
    const parentExtensionOptions = inheritExtensions ? getParentCliExtensionOptions() : { extensions: [], noExtensions: false };
    const noExtensions = options.noExtensions ?? parentExtensionOptions.noExtensions;
    const additionalExtensionPaths = uniqueStrings([...parentExtensionOptions.extensions, ...(options.extensions ?? [])]);
    const agentDir = getAgentDir();

    const tmp = options.agent.systemPrompt.trim() ? await writeSystemPrompt(options.agent.name, options.agent.systemPrompt) : undefined;
    const appendSystemPrompt = tmp ? [tmp.filePath] : undefined;

    const createRuntime = async ({ cwd, sessionManager, sessionStartEvent }: { cwd: string; sessionManager: SessionManager; sessionStartEvent?: any }) => {
      const services = await createAgentSessionServices({
        cwd,
        agentDir,
        resourceLoaderOptions: {
          additionalExtensionPaths,
          noExtensions,
          appendSystemPrompt,
        },
      });

      let model = undefined;
      const modelName = options.model ?? options.agent.model;
      if (modelName) {
        const [provider, ...rest] = modelName.split("/");
        if (provider && rest.length > 0) model = services.modelRegistry.find(provider, rest.join("/"));
        if (!model) {
          for (const candidate of services.modelRegistry.getAvailable()) {
            if (candidate.id === modelName || `${candidate.provider}/${candidate.id}` === modelName) { model = candidate; break; }
          }
        }
      }

      return {
        ...(await createAgentSessionFromServices({
          services,
          sessionManager,
          sessionStartEvent,
          model,
          thinkingLevel: normalizeThinkingLevel(options.thinking ?? options.agent.thinking),
          tools: allowTools ? uniqueStrings(allowTools) : undefined,
          excludeTools: excludeTools ? uniqueStrings(excludeTools) : undefined,
        })),
        services,
        diagnostics: services.diagnostics,
      };
    };

    const sessionManager = options.resumeSessionFile
      ? SessionManager.open(options.resumeSessionFile, options.sessionDir, options.cwd)
      : options.noSession
        ? SessionManager.inMemory(options.cwd)
        : SessionManager.create(options.cwd, options.sessionDir);
    this.runtime = await createAgentSessionRuntime(createRuntime, {
      cwd: options.cwd,
      agentDir,
      sessionManager,
    });
    this.session = this.runtime.session as RuntimePatchedAgentSession;

    // Headless fallback context. Also reused as the dormant-UI delegate when the
    // host adopts this session: dialogs raised while backgrounded become pending
    // requests (needs_attention) instead of auto-cancelling.
    const fallbackUi = this.createUiContext();
    let adopted = false;
    if (options.adopt) {
      try {
        this.detachFromHost = options.adopt(this.id, this.session, {
          label: this.id,
          dormantUi: {
            select: fallbackUi.select,
            confirm: fallbackUi.confirm,
            input: fallbackUi.input,
            editor: fallbackUi.editor,
            custom: fallbackUi.custom,
            notify: fallbackUi.notify,
          },
        });
        adopted = true;
      } catch {
        // Host refused (duplicate id, no terminal, ...): run headless as before.
      }
    }
    if (adopted) {
      // adopt() swapped in the host's SessionUiProxy via setExtensionUiContext.
      // Tag the proxy (a stable, bind-once object) so this extension's child
      // instance recognizes the session as a subagent, then bind WITHOUT a
      // uiContext so session_start runs against the proxy and the child's UI
      // footprint is recorded for foreground replay.
      const proxy = this.session.extensionUiContext;
      if (proxy) {
        (proxy as any).__subagentPlusChild = true;
        (proxy as any).__subagentPlusDepth = this.depth;
        (proxy as any).__subagentPlusRunId = this.id;
      }
      await this.session.bindExtensions({ mode: "tui" });
    } else {
      await this.session.bindExtensions({ uiContext: fallbackUi, mode: "tui" });
    }
    if (options.name) this.session.setSessionName(options.name);
    this.sessionFile = this.session.sessionFile;
    this.sessionId = this.session.sessionId;
    this.sessionName = this.session.sessionName;
    this.model = this.session.model ? `${this.session.model.provider}/${this.session.model.id}` : this.model;
    this.status = "idle";
    this.unsubscribe = this.session.subscribe((event) => this.applyEvent(event as RpcEvent));
    this.notifyChange();
  }

  private createUiContext(): ExtensionUIContext {
    const makePending = <T,>(method: PendingUiRequestSnapshot["method"], title?: string, message?: string, options?: unknown): Promise<T | undefined> => {
      const id = `${this.id}-ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      this.status = "needs_attention";
      this.pendingUiRequests.set(id, { id, method, title, message, options, createdAt: Date.now(), resolve: (value) => value });
      this.notifyChange();
      return new Promise<T | undefined>((resolve) => {
        const existing = this.pendingUiRequests.get(id);
        if (existing) existing.resolve = resolve;
      });
    };

    const noop = () => undefined;
    const uiContext: ExtensionUIContext = {
      select: (title, options) => makePending<string>("select", title, undefined, options),
      confirm: (title, message, options) => makePending<boolean>("confirm", title, message, options).then(Boolean),
      input: (title, placeholder, options) => makePending<string>("input", title, placeholder, options),
      editor: (title, prefill) => makePending<string>("editor", title, prefill),
      custom: async () => makePending<any>("custom", "Custom UI request"),
      // Only surface the child's user-facing notifications. Chrome updates
      // (setStatus/setWidget/footer/etc.) are child-extension internals and must
      // not pollute the subagent transcript.
      // Child-extension notifications are chrome, not the subagent's own
      // conversation, so they are not added to the message-derived transcript.
      notify: () => { this.notifyChange(); },
      onTerminalInput: () => noop,
      setStatus: noop,
      setWorkingMessage: noop,
      setWorkingVisible: noop,
      setWorkingIndicator: noop,
      setHiddenThinkingLabel: noop,
      setWidget: noop,
      setFooter: noop,
      setHeader: noop,
      setTitle: noop,
      pasteToEditor: noop,
      setEditorText: noop,
      getEditorText: () => "",
      addAutocompleteProvider: noop,
      setEditorComponent: noop,
      getEditorComponent: () => undefined,
      theme: {
        fg: (_color: string, text: string) => text,
        bg: (_color: string, text: string) => text,
        bold: (text: string) => text,
        italic: (text: string) => text,
        strikethrough: (text: string) => text,
      } as any,
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: "Subagent UI is not interactive" }),
      getToolsExpanded: () => true,
      setToolsExpanded: noop,
    };
    // Tag the fake context so the parent extension instance can recognize this
    // as a subagent (child) session and skip its top-level UI/footer/notify
    // wiring and refuse nested spawns. Subagents run in-process and share the
    // parent's module singletons, so this per-context marker is how we tell
    // child sessions apart from the real top-level one.
    (uiContext as any).__subagentPlusChild = true;
    (uiContext as any).__subagentPlusDepth = this.depth;
    (uiContext as any).__subagentPlusRunId = this.id;
    return uiContext;
  }

  replyUi(requestId: string, value: unknown): boolean {
    const request = this.pendingUiRequests.get(requestId);
    if (!request) return false;
    this.pendingUiRequests.delete(requestId);
    request.resolve(value);
    if (this.status === "needs_attention") this.status = this.isStreaming ? "running" : "idle";
    this.notifyChange();
    return true;
  }

  async prompt(message: string): Promise<RpcEvent> {
    if (!this.session) throw new Error(`subagent ${this.id} is not initialized`);
    this.status = "running";
    this.notifyChange();
    const promise = this.session.prompt(message, { source: "extension" }).catch((error) => this.fail(error));
    this.trackRun(promise);
    return { success: true, type: "response", command: "prompt" };
  }

  async steer(message: string): Promise<RpcEvent> {
    if (!this.session) throw new Error(`subagent ${this.id} is not initialized`);
    // steer/followUp only queue against an active agent loop. When the subagent
    // is idle, there is nothing to steer, so send a fresh prompt to trigger a
    // new turn (this is what the user means when typing into an idle subagent).
    if (!this.isStreaming) return this.prompt(message);
    const promise = this.session.steer(message).catch((error) => this.fail(error));
    this.trackRun(promise);
    return { success: true, type: "response", command: "steer" };
  }

  async followUp(message: string): Promise<RpcEvent> {
    if (!this.session) throw new Error(`subagent ${this.id} is not initialized`);
    if (!this.isStreaming) return this.prompt(message);
    await this.session.followUp(message).catch((error) => this.fail(error));
    return { success: true, type: "response", command: "follow_up" };
  }

  async abort(): Promise<RpcEvent> {
    await this.session?.abort().catch((error) => this.fail(error));
    if (this.status !== "error" && this.status !== "killed") this.status = "idle";
    this.notifyChange();
    return { success: true, type: "response", command: "abort" };
  }

  async refreshState(): Promise<RunSnapshot> { return this.snapshot(); }
  async getLastAssistantText(): Promise<string | undefined> { return this.lastAssistantText; }

  kill(reason = "killed by parent"): void {
    if (!this.isAlive) return;
    this.status = "killed";
    this.lastError = reason;
    // Detach BEFORE dispose: if this run is the foreground agent, the host
    // returns the terminal to main and drops the background registration.
    try { this.detachFromHost?.(); } catch { /* host may already be gone */ }
    this.detachFromHost = undefined;
    this.unsubscribe?.();
    this.session?.dispose();
    this.runtime?.dispose().catch(() => undefined);
    this.notifyChange();
  }

  snapshot(): RunSnapshot {
    return {
      id: this.id,
      agent: this.agent.name,
      agentSource: this.agent.source,
      task: this.task,
      cwd: this.cwd,
      status: this.status,
      startedAt: this.startedAt,
      updatedAt: this.updatedAt,
      exitedAt: this.exitedAt,
      sessionFile: this.sessionFile,
      sessionId: this.sessionId,
      sessionName: this.sessionName,
      model: this.model,
      isStreaming: this.isStreaming,
      pendingMessageCount: this.pendingMessageCount,
      turns: this.turns,
      usage: { ...this.usage },
      lastAssistantText: this.lastAssistantText,
      lastError: this.lastError,
      transcriptPreview: this.transcript.slice(-300),
      renderEvents: this.events.slice(-300),
      eventCount: this.events.length,
      pendingUiRequests: Array.from(this.pendingUiRequests.values()).map(({ resolve: _resolve, ...request }) => request),
    };
  }

  /**
   * Replay dialogs that queued while this run was backgrounded. Call right
   * after foregrounding: the proxy is active, so select/confirm/input/editor
   * forward to the real terminal. `custom` requests cannot be replayed and stay
   * pending for reply_ui.
   */
  async surfacePendingUiRequests(): Promise<void> {
    const ui = this.session?.extensionUiContext;
    if (!ui) return;
    for (const [id, request] of Array.from(this.pendingUiRequests)) {
      if (!this.pendingUiRequests.has(id)) continue;
      try {
        let value: unknown;
        if (request.method === "select") value = await ui.select(request.title ?? "Select", (request.options as string[]) ?? []);
        else if (request.method === "confirm") value = await ui.confirm(request.title ?? "Confirm", request.message ?? "");
        else if (request.method === "input") value = await ui.input(request.title ?? "Input", request.message);
        else if (request.method === "editor") value = await ui.editor(request.title ?? "Editor", request.message);
        else continue;
        this.replyUi(id, value);
      } catch {
        // Leave the request pending; reply_ui can still answer it.
      }
    }
  }

  private trackRun(promise: Promise<void>): void {
    this.activeRuns.add(promise);
    promise.finally(() => {
      this.activeRuns.delete(promise);
      if (this.status === "running" && !this.isStreaming && this.pendingUiRequests.size === 0) this.status = "idle";
      this.notifyChange();
    }).catch(() => undefined);
  }

  private fail(error: unknown): void {
    this.status = "error";
    this.lastError = error instanceof Error ? error.message : String(error);
    this.transcript.push(`✗ ${this.lastError}`);
    this.notifyChange();
  }

  private applyEvent(event: RpcEvent): void {
    this.events.push(event);
    // Derive the transcript from the structured session messages (clean and
    // complete) rather than from event fragments. See rebuildTranscript().
    this.rebuildTranscript();

    switch (event.type) {
      case "agent_start":
        this.status = "running";
        this.isStreaming = true;
        this.lastError = undefined;
        break;
      case "agent_end":
        if (this.pendingUiRequests.size > 0) this.status = "needs_attention";
        else this.status = "idle";
        this.isStreaming = false;
        break;
      case "turn_end":
        this.turns++;
        break;
      case "message_update": {
        const delta = event.assistantMessageEvent;
        if (delta?.type === "text_delta" && typeof delta.delta === "string") {
          this.lastAssistantText = (this.lastAssistantText ?? "") + delta.delta;
        }
        break;
      }
      case "message_end": {
        const text = extractAssistantText(event.message);
        if (text) this.lastAssistantText = text;
        if (event.message?.role === "assistant" && event.message?.usage) accumulateUsage(this.usage, event.message.usage);
        if (event.message?.model) this.model = event.message.model;
        if (event.message?.stopReason === "error") this.lastError = event.message.errorMessage ?? "assistant error";
        break;
      }
      case "auto_retry_end":
        // Pi recovered from a transient provider error (e.g. undici "terminated").
        if (event.success) this.lastError = undefined;
        break;
      case "queue_update":
        this.pendingMessageCount = (event.steering?.length ?? 0) + (event.followUp?.length ?? 0);
        break;
      case "extension_error":
        this.lastError = event.error ?? "extension error";
        break;
    }
    this.updatedAt = Date.now();
    this.trimBuffers();
    this.notifyChange();
  }

  private trimBuffers(): void {
    if (this.events.length > 1000) this.events.splice(0, this.events.length - 1000);
    if (this.transcript.length > 1000) this.transcript.splice(0, this.transcript.length - 1000);
  }

  private rebuildTranscript(): void {
    const lines = messagesToTranscript(this.session?.messages ?? []);
    this.transcript.length = 0;
    this.transcript.push(...lines);
  }

  private notifyChange(): void {
    try { this.onChange(); } catch { /* ignore */ }
  }
}

// Persisted runs.json holds only lightweight state metadata, not the
// conversation itself. The real transcript lives in each run's session file
// (see `sessionFile`), so we deliberately omit transcript/render buffers here.
type PersistedRunRecord = Omit<RunSnapshot, "transcriptPreview" | "renderEvents">;

class PersistedSubagentRun implements ManagedSubagentRun {
  readonly id: string;
  readonly agent: AgentConfig;
  readonly cwd: string;
  readonly task?: string;
  readonly startedAt: number;
  status: RunStatus;
  lastAssistantText?: string;
  lastError?: string;
  readonly transcript: string[];
  private readonly snapshotData: RunSnapshot;

  constructor(record: PersistedRunRecord) {
    this.id = record.id;
    this.agent = {
      name: record.agent,
      description: "Restored subagent run",
      systemPrompt: "",
      source: record.agentSource,
      filePath: record.sessionFile ?? "<persisted>",
    };
    this.cwd = record.cwd;
    this.task = record.task;
    this.startedAt = record.startedAt;
    this.status = record.status;
    this.lastAssistantText = record.lastAssistantText;
    this.lastError = record.lastError;
    this.transcript = [];
    this.snapshotData = { ...record, transcriptPreview: [], renderEvents: [] };
  }

  get isAlive(): boolean { return false; }
  get agentSession(): AgentSession | undefined { return undefined; }
  async surfacePendingUiRequests(): Promise<void> { /* history has no live UI */ }

  async prompt(): Promise<RpcEvent> { throw new Error(`subagent ${this.id} is restored history and cannot receive prompts`); }
  async steer(): Promise<RpcEvent> { throw new Error(`subagent ${this.id} is restored history and cannot be steered`); }
  async followUp(): Promise<RpcEvent> { throw new Error(`subagent ${this.id} is restored history and cannot receive follow-up`); }
  async abort(): Promise<RpcEvent> { return { success: false, error: "restored history cannot be aborted" }; }
  async refreshState(): Promise<RunSnapshot> { return this.snapshot(); }
  async getLastAssistantText(): Promise<string | undefined> { return this.lastAssistantText; }
  kill(): void { /* persisted history is already inactive */ }

  snapshot(): RunSnapshot {
    return {
      ...this.snapshotData,
      status: this.status,
      usage: this.snapshotData.usage ?? emptyUsage(),
      transcriptPreview: [],
      renderEvents: [],
      eventCount: this.snapshotData.eventCount ?? 0,
    };
  }
}

// Per-project state lives under Pi's agent config dir, never in the project
// itself. The cwd is encoded with the same convention pi uses for
// its own per-project session directories (session-manager.ts).
function encodeCwdDirName(cwd: string): string {
  const resolved = path.resolve(cwd);
  return `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function defaultPersistenceDir(cwd: string): string {
  // Preserve the pre-rename directory so existing run history remains visible.
  return path.join(getAgentDir(), "subagent-plus", encodeCwdDirName(cwd));
}

export function defaultSubagentSessionDir(cwd: string): string {
  return path.join(defaultPersistenceDir(cwd), "sessions");
}

export class SubagentRegistry {
  private runs = new Map<string, ManagedSubagentRun>();
  private listeners = new Set<() => void>();
  private persistenceFile?: string;
  private suppressPersistence = false;

  configurePersistence(cwd: string): void {
    const dir = defaultPersistenceDir(cwd);
    this.persistenceFile = path.join(dir, "runs.json");
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.mkdirSync(defaultSubagentSessionDir(cwd), { recursive: true });
    } catch { return; }
    this.restorePersistedRuns();
    this.persistNow();
  }

  persistNow(): void {
    if (!this.persistenceFile || this.suppressPersistence) return;
    // runs.json stores only lightweight state metadata. The full conversation
    // lives in each run's session file (`sessionFile`), so we drop the transcript
    // and render-event buffers here to avoid duplicating the conversation and to
    // keep this file small (it is rewritten on every change). We keep a single
    // clamped `lastAssistantText` as a quick at-a-glance result summary.
    const MAX_SUMMARY_TEXT = 2_000;
    const records: PersistedRunRecord[] = Array.from(this.runs.values()).map((run) => {
      const { transcriptPreview: _preview, renderEvents: _events, ...state } = run.snapshot();
      if (state.lastAssistantText && state.lastAssistantText.length > MAX_SUMMARY_TEXT) {
        state.lastAssistantText = `${state.lastAssistantText.slice(0, MAX_SUMMARY_TEXT)}\n…[truncated]`;
      }
      return state;
    });
    try {
      fs.mkdirSync(path.dirname(this.persistenceFile), { recursive: true });
      fs.writeFileSync(this.persistenceFile, JSON.stringify({ version: 1, updatedAt: Date.now(), runs: records }, null, 2));
    } catch {
      // Persistence must not break subagent control.
    }
  }

  private restorePersistedRuns(): void {
    if (!this.persistenceFile || !fs.existsSync(this.persistenceFile)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.persistenceFile, "utf8"));
      const records = Array.isArray(parsed?.runs) ? parsed.runs as PersistedRunRecord[] : [];
      for (const record of records) {
        if (!record?.id || this.runs.has(record.id)) continue;
        this.runs.set(record.id, new PersistedSubagentRun(record));
      }
    } catch {
      // Ignore corrupt persistence; future writes will replace it.
    }
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyChange = (): void => {
    this.persistNow();
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Listener errors should not affect registry state.
      }
    }
  };

  /**
   * Revive a non-live run (history restored from runs.json, or a killed live
   * run) by opening its persisted session file as a fresh live session under
   * the SAME id. The full conversation comes back (pi session resume), the run
   * becomes foregroundable and can take follow-ups again.
   */
  async revive(idOrPrefix: string, options: { adopt?: AdoptSessionFn; agent?: AgentConfig } = {}): Promise<ManagedSubagentRun> {
    const existing = this.get(idOrPrefix);
    if (!existing) throw new Error(`Subagent not found: ${idOrPrefix}`);
    if (existing.isAlive && existing.agentSession) return existing;
    const snapshot = existing.snapshot();
    if (!snapshot.sessionFile || !fs.existsSync(snapshot.sessionFile)) {
      throw new Error(`No session file recorded for ${existing.id}; cannot revive`);
    }
    // A dead-but-live object (killed/error) may still hold resources and a
    // stale host registration; kill() is idempotent and detaches from the host.
    existing.kill("replaced by revive");
    const run = await SdkSubagentRun.spawn({
      agent: options.agent ?? existing.agent,
      cwd: snapshot.cwd,
      model: snapshot.model,
      name: snapshot.sessionName,
      sessionDir: path.dirname(snapshot.sessionFile),
      resumeSessionFile: snapshot.sessionFile,
      id: existing.id,
      depth: 1,
      adopt: options.adopt,
      onChange: this.notifyChange,
    });
    this.runs.set(run.id, run);
    this.notifyChange();
    return run;
  }

  async spawn(options: SpawnRunOptions): Promise<ManagedSubagentRun> {
    const sessionDir = options.noSession ? options.sessionDir : (options.sessionDir ?? defaultSubagentSessionDir(options.cwd));
    // The child session writer opens files under sessionDir without creating it,
    // so ensure it exists (configurePersistence only makes the parent dir).
    if (sessionDir) {
      try { fs.mkdirSync(sessionDir, { recursive: true }); } catch { /* best effort */ }
    }
    const run = await SdkSubagentRun.spawn({ ...options, sessionDir, onChange: this.notifyChange });
    this.runs.set(run.id, run);
    this.notifyChange();
    return run;
  }

  list(): RunSnapshot[] {
    return Array.from(this.runs.values()).map((run) => run.snapshot());
  }

  get(idOrPrefix: string): ManagedSubagentRun | undefined {
    if (this.runs.has(idOrPrefix)) return this.runs.get(idOrPrefix);
    const matches = Array.from(this.runs.values()).filter((run) => run.id.startsWith(idOrPrefix));
    return matches.length === 1 ? matches[0] : undefined;
  }

  /**
   * Remove finished runs: exited/killed/error, plus "complete" runs (idle with
   * at least one finished turn and nothing pending). SDK complete runs are still
   * technically alive (the session sits in memory ready for follow-up), so we
   * dispose them before dropping the entry.
   */
  removeExited(): number {
    let removed = 0;
    for (const [id, run] of this.runs) {
      const snapshot = run.snapshot();
      const display = getDisplayRunStatus(snapshot);
      const finished = !run.isAlive || display === "complete";
      if (!finished) continue;
      if (run.isAlive) run.kill("cleared from subagent dock");
      this.runs.delete(id);
      removed++;
    }
    if (removed > 0) this.notifyChange();
    return removed;
  }

  killAll(reason = "parent session shutdown"): void {
    // Preserve the pre-shutdown history on disk; child disposals may mark runs killed.
    this.persistNow();
    this.suppressPersistence = true;
    try {
      for (const run of this.runs.values()) run.kill(reason);
    } finally {
      this.suppressPersistence = false;
    }
  }
}

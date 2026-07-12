import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  AssistantMessageComponent,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { SessionUiProxy } from "./runtime-session-ui-proxy.ts";
import type {
  ForegroundAgentsApi,
  RuntimePatchedAgentSession,
} from "./runtime-types.ts";

// Keep the pre-rename symbol keys stable so old and new package aliases cannot
// install the same process-wide runtime patch twice.
const PATCH_FLAG = Symbol.for("pi-subagent-plus:foreground-runtime-patch:v1");
const HOST_GUARD_FLAG = Symbol.for("pi-subagent-plus:foreground-runtime-host-guards:v1");

type BackgroundEntry = {
  session: RuntimePatchedAgentSession;
  proxy: SessionUiProxy;
  label?: string;
};

type HostState = {
  foregroundId: string;
  mainSession: RuntimePatchedAgentSession;
  mainProxy: SessionUiProxy;
  background: Map<string, BackgroundEntry>;
  agentsApi: ForegroundAgentsApi;
  filler: Component;
};

type Host = Record<PropertyKey, any>;
type SessionInternal = Record<PropertyKey, any>;

const states = new WeakMap<object, HostState>();
let HostAssistantMessageComponent: typeof AssistantMessageComponent;

type HostModule = {
  AgentSession: { prototype: object };
  AssistantMessageComponent: typeof AssistantMessageComponent;
  InteractiveMode: { prototype: object };
};

async function resolveHostModule(): Promise<HostModule> {
  const argvEntry = process.argv[1];
  if (argvEntry && existsSync(argvEntry)) {
    const cliPath = realpathSync(argvEntry);
    const extension = cliPath.endsWith(".ts") ? ".ts" : ".js";
    const indexPath = join(dirname(cliPath), `index${extension}`);
    if (existsSync(indexPath)) return await import(pathToFileURL(indexPath).href) as HostModule;
  }
  return await import("@earendil-works/pi-coding-agent") as HostModule;
}

function addAgentsApi(context: ExtensionUIContext, agentsApi: ForegroundAgentsApi): void {
  Object.defineProperty(context, "agents", {
    configurable: true,
    enumerable: true,
    get: () => agentsApi,
  });
}

function currentProxy(state: HostState): SessionUiProxy | undefined {
  if (state.foregroundId === "main") return state.mainProxy;
  return state.background.get(state.foregroundId)?.proxy;
}

function currentSession(state: HostState): RuntimePatchedAgentSession {
  if (state.foregroundId === "main") return state.mainSession;
  return state.background.get(state.foregroundId)?.session ?? state.mainSession;
}

function renderRows(component: Component, width: number): number {
  try {
    return component.render(width).length;
  } catch {
    return 0;
  }
}

function installViewportFiller(host: Host, state: HostState): Component {
  const filler: Component = {
    render(width: number): string[] {
      if (state.foregroundId === "main") return [];
      const ui = host.ui as { children?: Component[]; terminal?: { rows?: number } };
      const height = ui.terminal?.rows ?? process.stdout.rows ?? 24;
      const occupied = (ui.children ?? []).reduce(
        (total, child) => total + (child === filler ? 0 : renderRows(child, width)),
        0,
      );
      return Array.from({ length: Math.max(0, height - occupied) }, () => "");
    },
    invalidate() {},
  };

  const children = (host.ui as { children?: Component[] }).children;
  if (children && !children.includes(filler)) {
    const editorIndex = children.indexOf(host.editorContainer as Component);
    children.splice(editorIndex >= 0 ? editorIndex : children.length, 0, filler);
  }
  return filler;
}

function reconcileStatus(host: Host): void {
  host.clearStatusIndicator();
  if (host.workingVisible && host.session.isStreaming) {
    host.setWorkingVisible(true);
  }
}

function seedStreamingComponent(host: Host): void {
  const partial = host.session.agent.state.streamingMessage;
  if (!partial || partial.role !== "assistant") return;
  const component = new HostAssistantMessageComponent(
    undefined,
    host.hideThinkingBlock,
    host.getMarkdownThemeWithSettings(),
    host.hiddenThinkingLabel,
    host.outputPad,
  );
  host.streamingComponent = component;
  host.streamingMessage = partial;
  host.chatContainer.addChild(component);
  component.updateContent(partial);
}

function setForeground(host: Host, id: string): void {
  const state = states.get(host);
  if (!state || id === state.foregroundId) return;
  if (id !== "main" && !state.background.has(id)) throw new Error(`Unknown agent: ${id}`);

  host.unsubscribe?.();
  host.unsubscribe = undefined;
  currentProxy(state)?.deactivate();
  host.autocompleteProviderWrappers = [];
  host.streamingComponent = undefined;
  host.streamingMessage = undefined;
  host.pendingTools.clear();

  state.foregroundId = id;
  host.applyRuntimeSettings();
  host.renderCurrentSessionState();
  host.subscribeToAgent();
  seedStreamingComponent(host);
  reconcileStatus(host);
  currentProxy(state)?.activate();
  host.setupAutocompleteProvider();
  host.updatePendingMessagesDisplay();
  host.updateEditorBorderColor();
  host.updateTerminalTitle();
  host.ui.requestRender(true);
}

function ensureMain(host: Host): void {
  const state = states.get(host);
  if (state && state.foregroundId !== "main") setForeground(host, "main");
}

function createAgentsApi(
  host: Host,
  createDirectContext: () => ExtensionUIContext,
): ForegroundAgentsApi {
  return {
    adopt(id, session, options) {
      const state = states.get(host);
      if (!state) throw new Error("Foreground host is not initialized");
      if (id === "main") throw new Error('Agent id "main" is reserved for the primary session');
      if (state.background.has(id)) throw new Error(`Agent id already registered: ${id}`);

      const direct = createDirectContext();
      addAgentsApi(direct, state.agentsApi);
      const proxy = new SessionUiProxy(id, direct, { dormantDelegate: options?.dormantUi });
      const patchedSession = session as RuntimePatchedAgentSession;
      patchedSession.setExtensionUiContext(proxy);
      state.background.set(id, { session: patchedSession, proxy, label: options?.label });

      return () => {
        if (state.foregroundId === id) setForeground(host, "main");
        state.background.delete(id);
      };
    },
    async setForeground(id) {
      setForeground(host, id);
    },
    getForeground() {
      return states.get(host)?.foregroundId ?? "main";
    },
    list() {
      const state = states.get(host);
      if (!state) return [];
      return [
        { id: "main", label: "main", isForeground: state.foregroundId === "main" },
        ...Array.from(state.background.entries(), ([id, entry]) => ({
          id,
          label: entry.label,
          isForeground: state.foregroundId === id,
        })),
      ];
    },
  };
}

function installRuntimeHostGuards(host: Host): void {
  const runtimeHost = host.runtimeHost as Record<PropertyKey, any>;
  if (runtimeHost[HOST_GUARD_FLAG]) return;
  runtimeHost[HOST_GUARD_FLAG] = true;
  for (const name of ["newSession", "fork"] as const) {
    const original = runtimeHost[name];
    if (typeof original !== "function") continue;
    runtimeHost[name] = function (...args: unknown[]) {
      ensureMain(host);
      return original.apply(this, args);
    };
  }
}

function patchAgentSession(AgentSessionClass: HostModule["AgentSession"]): void {
  const prototype = AgentSessionClass.prototype as unknown as SessionInternal;
  if (typeof prototype.setExtensionUiContext !== "function") {
    prototype.setExtensionUiContext = function (uiContext: ExtensionUIContext): void {
      this._extensionUIContext = uiContext;
      this._applyExtensionBindings(this._extensionRunner);
    };
  }
  if (!Object.getOwnPropertyDescriptor(prototype, "extensionUiContext")) {
    Object.defineProperty(prototype, "extensionUiContext", {
      configurable: true,
      get(this: SessionInternal): ExtensionUIContext | undefined {
        return this._extensionUIContext;
      },
    });
  }
}

function wrapMainGuard(prototype: Record<string, any>, name: string): void {
  const original = prototype[name];
  if (typeof original !== "function") return;
  prototype[name] = function (...args: unknown[]) {
    ensureMain(this as Host);
    return original.apply(this, args);
  };
}

export async function installForegroundRuntimePatches(): Promise<"native" | "patched"> {
  const hostModule = await resolveHostModule();
  HostAssistantMessageComponent = hostModule.AssistantMessageComponent;
  const prototype = hostModule.InteractiveMode.prototype as unknown as Host;
  const sessionPrototype = hostModule.AgentSession.prototype as unknown as SessionInternal;
  if (typeof prototype.setForegroundAgent === "function" && typeof sessionPrototype.setExtensionUiContext === "function") {
    return "native";
  }
  if (prototype[PATCH_FLAG]) return "patched";
  prototype[PATCH_FLAG] = true;

  patchAgentSession(hostModule.AgentSession);

  const sessionDescriptor = Object.getOwnPropertyDescriptor(prototype, "session");
  const originalSessionGetter = sessionDescriptor?.get;
  if (!originalSessionGetter) throw new Error("Unsupported pi version: InteractiveMode.session getter not found");
  Object.defineProperty(prototype, "session", {
    configurable: true,
    get(this: Host) {
      const state = states.get(this);
      return state ? currentSession(state) : originalSessionGetter.call(this);
    },
  });

  const originalCreateContext = prototype.createExtensionUIContext;
  if (typeof originalCreateContext !== "function") {
    throw new Error("Unsupported pi version: InteractiveMode.createExtensionUIContext not found");
  }

  prototype.createExtensionUIContext = function (this: Host): ExtensionUIContext {
    let state = states.get(this);
    if (!state) {
      const direct = originalCreateContext.call(this) as ExtensionUIContext;
      const mainSession = this.runtimeHost.session as RuntimePatchedAgentSession;
      const placeholder = {} as HostState;
      const agentsApi = createAgentsApi(this, () => originalCreateContext.call(this) as ExtensionUIContext);
      addAgentsApi(direct, agentsApi);
      const mainProxy = new SessionUiProxy("main", direct);
      Object.assign(placeholder, {
        foregroundId: "main",
        mainSession,
        mainProxy,
        background: new Map<string, BackgroundEntry>(),
        agentsApi,
      });
      states.set(this, placeholder);
      placeholder.filler = installViewportFiller(this, placeholder);
      mainProxy.activate();
      installRuntimeHostGuards(this);
      state = placeholder;
    }
    return currentProxy(state) ?? state.mainProxy;
  };

  prototype.setForegroundAgent = function (this: Host, id: string): void {
    setForeground(this, id);
  };

  for (const name of ["rebindCurrentSession", "shutdown", "handleResumeSession", "handleReloadCommand"]) {
    wrapMainGuard(prototype, name);
  }

  return "patched";
}

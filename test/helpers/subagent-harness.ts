import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type AssistantMessage,
  type Context,
  type FauxResponseFactory,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
  AuthStorage,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";

const here = dirname(fileURLToPath(import.meta.url));
export const projectRoot = resolve(here, "../..");
export const extensionIndex = join(projectRoot, "extensions/claude-style-subagent/index.ts");
const codingAgentIndex = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const codingAgentCli = join(dirname(codingAgentIndex), "cli.js");

const CALL_PREFIX = "__PI_SUBAGENT_TEST_CALL__ ";

export function toolPrompt(request: ToolCallRequest): string {
  return `${CALL_PREFIX}${JSON.stringify(request)}`;
}

export interface SubagentHarnessOptions {
  singleShot?: boolean;
  projectTrusted?: boolean;
  tokensPerSecond?: number;
  tokenSize?: { min?: number; max?: number };
}

export interface ToolCallRequest {
  tool: "agents" | "agent_wait";
  args: Record<string, unknown>;
}

export interface SubagentHarness {
  tempDir: string;
  projectDir: string;
  agentDir: string;
  session: AgentSession;
  runtime: AgentSessionRuntime;
  fauxCallCount: () => number;
  callTool(request: ToolCallRequest): Promise<ToolResultMessage>;
  callSubagent(args: Record<string, unknown>): Promise<ToolResultMessage>;
  callWait(args?: Record<string, unknown>): Promise<ToolResultMessage>;
  waitFor<T>(read: () => T | undefined, timeoutMs?: number): Promise<T>;
  cleanup(): Promise<void>;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } =>
      Boolean(part && typeof part === "object" && (part as { type?: string }).type === "text" && typeof (part as { text?: unknown }).text === "string"))
    .map((part) => part.text)
    .join("\n");
}

function lastUser(messages: Context["messages"]): { index: number; text: string } | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "user") return { index, text: contentText(message.content) };
  }
  return undefined;
}

function parseCall(text: string): ToolCallRequest | undefined {
  if (!text.startsWith(CALL_PREFIX)) return undefined;
  return JSON.parse(text.slice(CALL_PREFIX.length)) as ToolCallRequest;
}

function makeRouter(onCall: () => void): FauxResponseFactory {
  return (context) => {
    onCall();
    const user = lastUser(context.messages);
    const isChild = String(context.systemPrompt ?? "").includes("TAG:CHILD");
    if (!user) return fauxAssistantMessage(isChild ? "CHILD:NO_USER" : "MAIN:NO_USER");

    const afterUser = context.messages.slice(user.index + 1);
    const toolResult = [...afterUser].reverse().find((message) => message.role === "toolResult");
    if (toolResult?.role === "toolResult") {
      return fauxAssistantMessage(`TOOL_DONE:${toolResult.toolName}`);
    }

    const call = parseCall(user.text);
    if (call) {
      return fauxAssistantMessage(
        fauxToolCall(call.tool, call.args),
        { stopReason: "toolUse" },
      );
    }

    if (isChild && user.text.startsWith("NESTED_CALL ")) {
      const args = JSON.parse(user.text.slice("NESTED_CALL ".length)) as Record<string, unknown>;
      return fauxAssistantMessage(
        fauxToolCall("agents", args),
        { stopReason: "toolUse" },
      );
    }

    if (isChild && user.text === "ASK_CONFIRM") {
      return fauxAssistantMessage(
        fauxToolCall("ask_ui", {}),
        { stopReason: "toolUse" },
      );
    }

    if (isChild && user.text.startsWith("LONG_RESPONSE")) {
      const length = user.text === "LONG_RESPONSE_SHORT" ? 2_000
        : user.text === "LONG_RESPONSE_SLOW" ? 10_000
          : 5_000;
      return fauxAssistantMessage(`CHILD_LONG:${"x".repeat(length)}`);
    }

    return fauxAssistantMessage(`${isChild ? "CHILD" : "MAIN"}_REPLY:${user.text}`);
  };
}

function writeFixtureFiles(
  agentDir: string,
  projectDir: string,
  routerKey: string,
  handleKey: string,
  options: SubagentHarnessOptions,
): void {
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  mkdirSync(join(projectDir, ".pi", "agents"), { recursive: true });

  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({ quietStartup: true, terminal: { clearOnShrink: true } }),
  );
  writeFileSync(
    join(agentDir, "agents/echo.md"),
    [
      "---",
      "name: echo",
      "description: deterministic faux child",
      "model: faux/faux-1",
      "---",
      "You are the CHILD agent. TAG:CHILD",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(projectDir, ".pi/agents/echo.md"),
    [
      "---",
      "name: echo",
      "description: project override for echo",
      "model: faux/faux-1",
      "---",
      "You are the PROJECT OVERRIDE agent. TAG:CHILD",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(projectDir, ".pi/agents/project-echo.md"),
    [
      "---",
      "name: project-echo",
      "description: deterministic project child",
      "model: faux/faux-1",
      "---",
      "You are the PROJECT CHILD agent. TAG:CHILD",
      "",
    ].join("\n"),
  );

  writeFileSync(
    join(agentDir, "extensions/faux-provider.ts"),
    `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxProvider } from "@earendil-works/pi-ai";
export default function (pi: ExtensionAPI) {
  const route = (globalThis as any)[${JSON.stringify(routerKey)}];
  if (typeof route !== "function") throw new Error("Missing faux response router");
  const faux = fauxProvider({
    provider: "faux",
    api: "faux",
    models: [{ id: "faux-1", reasoning: false }],
    tokensPerSecond: ${JSON.stringify(options.tokensPerSecond)},
    tokenSize: ${JSON.stringify(options.tokenSize)},
  });
  faux.setResponses(Array.from({ length: 500 }, () => route));
  (globalThis as any)[${JSON.stringify(handleKey)}] = faux;
  pi.registerProvider("faux", {
    baseUrl: "http://localhost:0",
    apiKey: "faux-key",
    api: faux.api,
    streamSimple: faux.provider.streamSimple,
    models: [{
      id: "faux-1",
      name: "Faux Model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100000,
      maxTokens: 4096,
    }],
  } as never);
}
`,
  );
  writeFileSync(
    join(agentDir, "extensions/ask-ui.ts"),
    `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_ui",
    label: "Ask UI",
    description: "Ask a deterministic confirmation",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const accepted = await ctx.ui.confirm("Continue?", "Approve child action?");
      return { content: [{ type: "text", text: accepted ? "accepted" : "declined" }], details: { accepted } };
    },
  });
}
`,
  );
  writeFileSync(
    join(agentDir, "extensions/claude-style-subagent.ts"),
    `export { default } from ${JSON.stringify(extensionIndex)};\n`,
  );
}

export async function createSubagentHarness(options: SubagentHarnessOptions = {}): Promise<SubagentHarness> {
  const tempDir = realpathSync(mkdtempSync(join(tmpdir(), "claude-style-subagent-test-")));
  const projectDir = join(tempDir, "project");
  const agentDir = join(tempDir, "agent-home");
  const globalSuffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const routerKey = `__piSubagentTestRouter_${globalSuffix}`;
  const handleKey = `__piSubagentTestFauxHandle_${globalSuffix}`;
  const globals = globalThis as unknown as Record<string, unknown>;
  let fauxCallCount = 0;
  globals[routerKey] = makeRouter(() => { fauxCallCount++; });
  mkdirSync(projectDir, { recursive: true });
  writeFixtureFiles(agentDir, projectDir, routerKey, handleKey, options);

  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousOffline = process.env.PI_OFFLINE;
  const previousArgv = [...process.argv];
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = "1";
  process.argv[1] = codingAgentCli;
  if (options.singleShot) process.argv.push("--mode=json");

  const authStorage = AuthStorage.inMemory();
  authStorage.setRuntimeApiKey("faux", "faux-key");
  const settingsManager = SettingsManager.inMemory(
    { quietStartup: true, theme: "dark" },
    { projectTrusted: options.projectTrusted ?? true },
  );

  const createRuntime: CreateAgentSessionRuntimeFactory = async ({
    cwd,
    sessionManager,
    sessionStartEvent,
  }) => {
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      authStorage,
      settingsManager,
      resourceLoaderOptions: {
        noSkills: true,
        noPromptTemplates: true,
        noContextFiles: true,
      },
    });
    const model = services.modelRegistry.find("faux", "faux-1");
    if (!model) throw new Error("Faux model was not registered by the fixture extension");
    return {
      ...(await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        model,
      })),
      services,
      diagnostics: services.diagnostics,
    };
  };

  let runtime: AgentSessionRuntime;
  try {
    runtime = await createAgentSessionRuntime(createRuntime, {
      cwd: projectDir,
      agentDir,
      sessionManager: SessionManager.inMemory(projectDir),
    });
    await runtime.session.bindExtensions({ mode: options.singleShot ? "json" : "tui" });
  } catch (error) {
    const fauxHandle = globals[handleKey] as { unregister?: () => void } | undefined;
    fauxHandle?.unregister?.();
    delete globals[handleKey];
    delete globals[routerKey];
    process.argv.splice(0, process.argv.length, ...previousArgv);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousOffline;
    rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }

  const session = runtime.session;

  const callTool = async (request: ToolCallRequest): Promise<ToolResultMessage> => {
    await session.agent.waitForIdle();
    const start = session.messages.length;
    await session.prompt(toolPrompt(request));
    await session.agent.waitForIdle();
    const result = session.messages
      .slice(start)
      .find((message): message is ToolResultMessage =>
        message.role === "toolResult" && message.toolName === request.tool);
    if (!result) {
      throw new Error(`No ${request.tool} result found after call. Messages: ${JSON.stringify(session.messages.slice(start))}`);
    }
    return result;
  };

  const waitFor = async <T>(read: () => T | undefined, timeoutMs = 5_000): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = read();
      if (value !== undefined) return value;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out after ${timeoutMs}ms`);
  };

  return {
    tempDir,
    projectDir,
    agentDir,
    session,
    runtime,
    fauxCallCount: () => fauxCallCount,
    callTool,
    callSubagent: (args) => callTool({ tool: "agents", args }),
    callWait: (args = {}) => callTool({ tool: "agent_wait", args }),
    waitFor,
    async cleanup() {
      try {
        await runtime.dispose();
      } finally {
        const fauxHandle = globals[handleKey] as { unregister?: () => void } | undefined;
        fauxHandle?.unregister?.();
        delete globals[handleKey];
        delete globals[routerKey];
        process.argv.splice(0, process.argv.length, ...previousArgv);
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        if (previousOffline === undefined) delete process.env.PI_OFFLINE;
        else process.env.PI_OFFLINE = previousOffline;
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  };
}

export function toolText(result: ToolResultMessage): string {
  return result.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

export function assistantText(message: AssistantMessage | undefined): string {
  if (!message) return "";
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

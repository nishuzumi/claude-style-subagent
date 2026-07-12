import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "../..");
const extensionIndex = join(projectRoot, "extensions/claude-style-subagent/index.ts");
const codingAgentIndex = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const cliPath = join(dirname(codingAgentIndex), "cli.js");

type ProcessResult = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };

function run(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<ProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI timed out after ${options.timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, options.timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, stdout, stderr });
    });
  });
}

describe("stock pi CLI subprocess", () => {
  let tempDir: string;
  let projectDir: string;
  let agentDir: string;
  let fauxExtension: string;
  let subagentExtension: string;
  let probeExtension: string;

  beforeAll(() => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "claude-style-subagent-cli-")));
    projectDir = join(tempDir, "project");
    agentDir = join(tempDir, "agent-home");
    const extensionDir = join(tempDir, "extensions");
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    mkdirSync(extensionDir, { recursive: true });

    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ quietStartup: true, theme: "dark" }));
    writeFileSync(join(agentDir, "agents/echo.md"), [
      "---",
      "name: echo",
      "description: stock CLI faux child",
      "model: faux/faux-1",
      "---",
      "TAG:CLI_CHILD",
      "",
    ].join("\n"));

    fauxExtension = join(extensionDir, "00-faux-provider.ts");
    writeFileSync(fauxExtension, `
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";

function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join("\\n");
}

export default function (pi: ExtensionAPI) {
  const faux = fauxProvider({ provider: "faux", api: "faux", models: [{ id: "faux-1", reasoning: false }] });
  const route = (context: any) => {
    if (String(context.systemPrompt ?? "").includes("TAG:CLI_CHILD")) {
      return fauxAssistantMessage("CLI_CHILD_OK");
    }
    const results = context.messages.filter((message: any) => message.role === "toolResult");
    const probe = results.find((message: any) => message.toolName === "runtime_probe");
    if (!probe) return fauxAssistantMessage(fauxToolCall("runtime_probe", {}), { stopReason: "toolUse" });
    if (!text(probe.content).includes("PATCH_OK")) return fauxAssistantMessage("CLI_PATCH_FAILED");
    const spawned = results.find((message: any) => message.toolName === "agents");
    if (!spawned) {
      return fauxAssistantMessage(fauxToolCall("agents", {
        action: "spawn",
        agent: "echo",
        task: "run-child",
        wait: true,
        waitSeconds: 10,
        noSession: true,
      }), { stopReason: "toolUse" });
    }
    const childOutput = spawned.details?.run?.lastAssistantText;
    return fauxAssistantMessage(childOutput === "CLI_CHILD_OK" ? "CLI_SMOKE_OK" : "CLI_CHILD_FAILED:" + JSON.stringify(spawned.details));
  };
  faux.setResponses(Array.from({ length: 100 }, () => route));
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
`);

    subagentExtension = join(extensionDir, "10-claude-style-subagent.ts");
    writeFileSync(subagentExtension, `export { default } from ${JSON.stringify(extensionIndex)};\n`);

    probeExtension = join(extensionDir, "20-runtime-probe.ts");
    writeFileSync(probeExtension, `
import { AgentSession, InteractiveMode, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "runtime_probe",
    label: "Runtime Probe",
    description: "Verify stock-pi foreground runtime patches",
    parameters: Type.Object({}),
    async execute() {
      const patched = typeof (InteractiveMode.prototype as any).setForegroundAgent === "function"
        && typeof (AgentSession.prototype as any).setExtensionUiContext === "function";
      return {
        content: [{ type: "text", text: patched ? "PATCH_OK" : "PATCH_MISSING" }],
        details: { patched },
      };
    },
  });
}
`);
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("patches stock pi and completes a real child run with no network", async () => {
    const result = await run(process.execPath, [
      cliPath,
      "--print",
      "--offline",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--provider", "faux",
      "--model", "faux-1",
      "--api-key", "faux-key",
      "--extension", fauxExtension,
      "--extension", subagentExtension,
      "--extension", probeExtension,
      "RUN_CLI_SMOKE",
    ], {
      cwd: projectDir,
      timeoutMs: 30_000,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_OFFLINE: "1",
        NO_COLOR: "1",
        FORCE_COLOR: "0",
      },
    });

    expect(result, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`).toMatchObject({ code: 0, signal: null });
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe("CLI_SMOKE_OK");
  });
});

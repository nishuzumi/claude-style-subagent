import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { TUI } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSubagentHarness,
  toolPrompt,
  toolText,
  type SubagentHarness,
} from "../helpers/subagent-harness.ts";
import { VirtualTerminal } from "../helpers/virtual-terminal.ts";

type InteractiveInternals = {
  ui: TUI;
  defaultEditor: { tui: TUI };
  editor: { tui?: TUI };
  themeController: { ui: TUI };
};

type Run = {
  id: string;
  status: string;
  lastAssistantText?: string;
};

function attachTerminal(
  mode: InteractiveMode,
  terminal: VirtualTerminal,
  onRenderRequest: (force: boolean | undefined) => void,
): TUI {
  const ui = new TUI(terminal, false);
  const requestRender = ui.requestRender.bind(ui);
  ui.requestRender = (force?: boolean) => {
    onRenderRequest(force);
    requestRender(force);
  };
  ui.setClearOnShrink(true);
  const internals = mode as unknown as InteractiveInternals;
  internals.ui = ui;
  internals.defaultEditor.tui = ui;
  if (internals.editor) internals.editor.tui = ui;
  internals.themeController.ui = ui;
  return ui;
}

describe.sequential("first-class subagents in InteractiveMode", () => {
  let harness: SubagentHarness;
  let terminal: VirtualTerminal;
  let mode: InteractiveMode;
  let modeError: unknown;
  let runId = "";
  const renderRequests: Array<boolean | undefined> = [];

  beforeAll(async () => {
    harness = await createSubagentHarness({
      tokensPerSecond: 1_000,
      tokenSize: { min: 20, max: 20 },
    });
    terminal = new VirtualTerminal(100, 30);
    mode = new InteractiveMode(harness.runtime, { verbose: false });
    attachTerminal(mode, terminal, (force) => renderRequests.push(force));
    void mode.run().catch((error) => { modeError = error; });
    await waitForViewport((text) => text.includes("faux-1"));
  });

  afterAll(async () => {
    mode.stop();
    await harness.cleanup();
    if (modeError) throw modeError;
  });

  async function viewport(): Promise<string> {
    await terminal.waitForRender();
    return terminal.getViewport().join("\n");
  }

  async function waitForViewport(predicate: (text: string) => boolean, timeoutMs = 10_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let text = "";
    while (Date.now() < deadline) {
      text = await viewport();
      if (predicate(text)) return text;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Viewport condition timed out. Last viewport:\n${text}`);
  }

  async function submit(text: string): Promise<void> {
    terminal.sendInput(text);
    terminal.sendInput("\r");
  }

  async function submitTool(args: Record<string, unknown>): Promise<ToolResultMessage> {
    const start = harness.session.messages.length;
    await submit(toolPrompt({ tool: "agents", args }));
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const result = harness.session.messages.slice(start).find(
        (message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "agents",
      );
      if (result) return result;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Tool submit timed out. Messages: ${JSON.stringify(harness.session.messages.slice(start))}\nViewport:\n${await viewport()}`);
  }

  it("renders the persistent agent list after a background spawn", async () => {
    const result = await submitTool({
      action: "spawn",
      agent: "echo",
      task: "LONG_RESPONSE_SLOW",
      wait: false,
    });
    runId = (result.details as { run: Run }).run.id;

    const text = await waitForViewport((screen) => screen.includes("Agents") && screen.includes(runId));
    expect(text).toContain("running");
    expect(text).toContain("↓ focus (empty input)");
  });

  it("switches to a child from the keyboard while it is streaming", async () => {
    terminal.sendInput("\x1b[B");
    const focused = await waitForViewport((screen) => screen.includes("enter switch") && screen.includes(`› ⏳ echo ${runId}`));
    expect(focused).toContain("↑↓ move");

    terminal.sendInput("\r");
    const child = await waitForViewport((screen) => screen.includes("Claude-style Subagent") && screen.includes(runId));
    expect(child).toContain("› echo");
    expect(child).toContain("running");
  });

  it("routes editor input to the foreground child during its active stream", async () => {
    await submit("child-steer");
    const text = await waitForViewport((screen) => screen.includes("CHILD_REPLY:child-steer"), 15_000);
    expect(text).toContain(`▶ ✓ echo ${runId}`);
    expect(text).toContain("complete");
  });

  it("switches back and routes the next editor submission to main", async () => {
    terminal.sendInput("\x1b[B");
    await waitForViewport((screen) => screen.includes("enter switch") && screen.includes("› ★ main"));
    terminal.sendInput("\r");
    await waitForViewport((screen) => screen.includes("▶ ★ main") && !screen.includes("Claude-style Subagent"));

    const start = harness.session.messages.length;
    await submit("main-input");
    const reply = await harness.waitFor(() => harness.session.messages.slice(start).find((message) =>
      message.role === "assistant"
      && message.content.some((part) => part.type === "text" && part.text.includes("MAIN_REPLY:main-input"))), 10_000);
    expect(reply.role).toBe("assistant");
    expect(await waitForViewport((screen) => screen.includes("MAIN_REPLY:main-input"))).toContain("Agents");
  });

  it("ticks elapsed time once per second without forcing a full-screen repaint", async () => {
    const rowAge = async (): Promise<number> => {
      const lines = (await viewport()).split("\n");
      const row = [...lines].reverse().find((line) => line.includes(runId));
      if (!row) throw new Error(`Missing run row in viewport:\n${lines.join("\n")}`);
      const matches = [...row.matchAll(/(\d+)s/g)];
      if (!matches.length) throw new Error(`Missing elapsed age in row: ${row}`);
      return Number(matches.at(-1)![1]);
    };

    const beforeAge = await rowAge();
    const beforeClears = terminal.clearScreenCount;
    const requestStart = renderRequests.length;
    await new Promise((resolve) => setTimeout(resolve, 1_150));
    const afterAge = await rowAge();
    const tickRequests = renderRequests.slice(requestStart);

    expect(afterAge).toBeGreaterThan(beforeAge);
    expect(tickRequests.length).toBeGreaterThan(0);
    expect(tickRequests).not.toContain(true);
    expect(terminal.clearScreenCount).toBe(beforeClears);
  });

  it("keeps the /agents manager usable across terminal resize", async () => {
    await submit("/agents");
    await waitForViewport((screen) => screen.includes("Claude-style Subagent") && screen.includes("show history"));

    terminal.resize(58, 20);
    const resized = await waitForViewport((screen) => screen.includes("Claude-style Subagent") && screen.includes("enter switch"));
    expect(resized).toContain("main");
    expect(resized).toContain("echo");
    expect(terminal.getViewport()).toHaveLength(20);

    terminal.sendInput("\x1b");
    await waitForViewport((screen) => screen.includes("Agents") && !screen.includes(" Claude-style Subagent "));
    terminal.resize(100, 30);
    await terminal.waitForRender();
  });

  it("revives a killed child from its session history and accepts new input", async () => {
    const killed = await submitTool({ action: "kill", id: runId });
    expect((killed.details as { run: Run }).run.status).toBe("killed");
    await waitForViewport((screen) => screen.includes(runId) && screen.includes("killed"));

    terminal.sendInput("\x1b[B");
    await waitForViewport((screen) => screen.includes("enter switch") && screen.includes(runId));
    terminal.sendInput("\r");
    await waitForViewport((screen) => screen.split("\n").some((line) => line.includes("▶") && line.includes(runId)), 15_000);

    await submit("revived-input");
    const revived = await waitForViewport((screen) => screen.includes("CHILD_REPLY:revived-input"), 10_000);
    expect(revived).toContain(runId);

    terminal.sendInput("\x1b[B");
    await waitForViewport((screen) => screen.includes("enter switch") && screen.includes("› ★ main"));
    terminal.sendInput("\r");
    await waitForViewport((screen) => screen.includes("▶ ★ main"));

    const transcript = await submitTool({ action: "transcript", id: runId, lines: 200 });
    expect(toolText(transcript)).toContain("CHILD_REPLY:child-steer");
    expect(toolText(transcript)).toContain("CHILD_REPLY:revived-input");
  });
});

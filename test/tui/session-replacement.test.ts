import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSubagentHarness,
  type SubagentHarness,
} from "../helpers/subagent-harness.ts";
import { VirtualTerminal } from "../helpers/virtual-terminal.ts";

type InteractiveInternals = {
  ui: TUI;
  defaultEditor: { tui: TUI };
  editor: { tui?: TUI };
  themeController: { ui: TUI };
};

function attachTerminal(mode: InteractiveMode, terminal: VirtualTerminal): void {
  const ui = new TUI(terminal, false);
  ui.setClearOnShrink(true);
  const internals = mode as unknown as InteractiveInternals;
  internals.ui = ui;
  internals.defaultEditor.tui = ui;
  if (internals.editor) internals.editor.tui = ui;
  internals.themeController.ui = ui;
}

async function waitFor(
  terminal: VirtualTerminal,
  predicate: (text: string) => boolean,
  timeoutMs = 10_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let text = "";
  while (Date.now() < deadline) {
    await terminal.waitForRender();
    text = terminal.getViewport().join("\n");
    if (predicate(text)) return text;
  }
  throw new Error(`Viewport condition timed out. Last viewport:\n${text}`);
}

describe.sequential("main session replacement", () => {
  let harness: SubagentHarness | undefined;
  let mode: InteractiveMode | undefined;
  let modeError: unknown;

  afterEach(async () => {
    mode?.stop();
    await harness?.cleanup();
    if (modeError) throw modeError;
  });

  it("rebinds extensions to the new main session after /new", async () => {
    harness = await createSubagentHarness();
    const terminal = new VirtualTerminal(160, 60);
    mode = new InteractiveMode(harness.runtime, { verbose: false });
    attachTerminal(mode, terminal);
    void mode.run().catch((error) => { modeError = error; });
    await waitFor(terminal, (text) => text.includes("faux-1"));

    const previousSession = harness.runtime.session;
    terminal.sendInput("/new");
    terminal.sendInput("\r");

    await harness.waitFor(() => harness?.runtime.session !== previousSession ? true : undefined);
    await waitFor(terminal, (text) => text.includes("New session started"));

    const terminalOutput = terminal.getScrollBuffer().join("\n");
    expect(terminalOutput).not.toContain("This extension ctx is stale after session replacement or reload");
  });
});

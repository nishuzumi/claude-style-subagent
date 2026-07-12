import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createSubagentHarness,
  toolText,
  type SubagentHarness,
} from "../helpers/subagent-harness.ts";

type Run = {
  id: string;
  status: string;
  pendingUiRequests?: Array<{ id: string }>;
};

type WaitDetails = {
  mode?: "first" | "all";
  initialCount?: number;
  finished?: string[];
  stillActive?: string[];
  needsAttention?: string[];
};

describe.sequential("agent_wait through a real single-shot AgentSession", () => {
  let harness: SubagentHarness;

  beforeAll(async () => {
    harness = await createSubagentHarness({
      singleShot: true,
      tokensPerSecond: 500,
      tokenSize: { min: 20, max: 20 },
    });
  });

  afterEach(async () => {
    const listed = await harness.callSubagent({ action: "list" });
    const runs = (listed.details as { runs: Run[] }).runs;
    for (const run of runs) {
      await harness.callSubagent({ action: "kill", id: run.id });
    }
    await harness.callSubagent({ action: "cleanup" });
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  async function spawn(task: string): Promise<string> {
    const result = await harness.callSubagent({
      action: "spawn",
      agent: "echo",
      task,
      wait: false,
      noSession: true,
    });
    return (result.details as { run: Run }).run.id;
  }

  it("returns when the first fleet member finishes, then waits for the remainder", async () => {
    const slow = await spawn("LONG_RESPONSE_SLOW");
    const fast = await spawn("LONG_RESPONSE_SHORT");

    const first = await harness.callWait();
    const firstDetails = first.details as WaitDetails;
    expect(firstDetails).toMatchObject({ mode: "first", initialCount: 2 });
    expect(firstDetails.finished).toContain(fast);
    expect(firstDetails.stillActive).toContain(slow);
    expect(toolText(first)).toContain("still in flight");

    const all = await harness.callWait({ all: true });
    const allDetails = all.details as WaitDetails;
    expect(allDetails.mode).toBe("all");
    expect(allDetails.finished).toContain(slow);
    expect(allDetails.stillActive).toEqual([]);
  });

  it("waits for one run selected by a unique id prefix", async () => {
    const id = await spawn("LONG_RESPONSE");
    const result = await harness.callWait({ id: id.slice(0, 14) });
    const details = result.details as WaitDetails;
    expect(details.mode).toBe("all");
    expect(details.initialCount).toBe(1);
    expect(details.finished).toContain(id);
  });

  it("reports ambiguous prefixes without blocking", async () => {
    await spawn("LONG_RESPONSE_SLOW");
    await spawn("LONG_RESPONSE_SLOW");
    const result = await harness.callWait({ id: "echo-" });
    expect(toolText(result)).toContain("Ambiguous id prefix");
  });

  it("times out without killing the child", async () => {
    const id = await spawn("LONG_RESPONSE_SLOW");
    const result = await harness.callWait({ id, timeoutMs: 100 });
    expect(toolText(result)).toContain("Wait timed out after 100ms");

    const status = await harness.callSubagent({ action: "status", id });
    expect((status.details as { run: Run }).run.status).toBe("running");
  });

  it("returns immediately when a child needs UI attention", async () => {
    const id = await spawn("ASK_CONFIRM");
    const result = await harness.callWait({ all: true });
    const details = result.details as WaitDetails;
    expect(details.needsAttention).toContain(id);
    expect(toolText(result)).toContain("need attention");
  });

  it("returns a no-op result when there are no active runs", async () => {
    const result = await harness.callWait();
    expect(result.isError).toBe(false);
    expect(toolText(result)).toBe("No active subagent runs. Nothing to wait for.");
  });

  it("observes cancellation from the parent agent abort signal", async () => {
    await spawn("LONG_RESPONSE_SLOW");
    const waiting = harness.callWait({ all: true, timeoutMs: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await harness.session.abort();
    const result = await waiting;
    expect(toolText(result)).toContain("Wait aborted after");
  });
});

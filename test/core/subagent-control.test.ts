import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSubagentHarness, type SubagentHarness } from "../helpers/subagent-harness.ts";

type Run = {
  id: string;
  status: string;
  isStreaming?: boolean;
  turns: number;
  lastAssistantText?: string;
};

type RunDetails = { run: Run };

describe.sequential("live subagent controls", () => {
  let harness: SubagentHarness;
  let runId = "";

  beforeAll(async () => {
    harness = await createSubagentHarness({
      tokensPerSecond: 500,
      tokenSize: { min: 10, max: 10 },
    });
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  async function waitUntilRunning(): Promise<Run> {
    for (let attempt = 0; attempt < 100; attempt++) {
      const status = await harness.callSubagent({ action: "status", id: runId });
      const run = (status.details as RunDetails).run;
      if (run.status === "running" && run.isStreaming) return run;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Run ${runId} never entered streaming state`);
  }

  async function startLongTurn(): Promise<void> {
    await harness.callSubagent({
      action: runId ? "prompt" : "spawn",
      ...(runId ? { id: runId, message: "LONG_RESPONSE" } : { agent: "echo", task: "LONG_RESPONSE", noSession: true }),
      wait: false,
    });
    if (!runId) {
      const listed = await harness.callSubagent({ action: "list" });
      const runs = (listed.details as { runs: Run[] }).runs;
      runId = runs.find((run) => run.status === "running" || run.isStreaming)?.id ?? runs[0]!.id;
    }
    await waitUntilRunning();
  }

  it("steers a child that is actively streaming", async () => {
    await startLongTurn();
    const result = await harness.callSubagent({
      action: "steer",
      id: runId,
      message: "live-steer",
      wait: true,
      waitSeconds: 10,
    });
    const run = (result.details as RunDetails).run;
    expect(run.status).toBe("idle");
    expect(run.lastAssistantText).toBe("CHILD_REPLY:live-steer");
  });

  it("queues a follow-up behind an active child turn", async () => {
    await startLongTurn();
    const result = await harness.callSubagent({
      action: "follow_up",
      id: runId,
      message: "live-follow-up",
      wait: true,
      waitSeconds: 10,
    });
    const run = (result.details as RunDetails).run;
    expect(run.status).toBe("idle");
    expect(run.lastAssistantText).toBe("CHILD_REPLY:live-follow-up");
  });

  it("aborts an active child without killing its reusable session", async () => {
    await startLongTurn();
    const result = await harness.callSubagent({ action: "abort", id: runId });
    const run = (result.details as RunDetails).run;
    expect(run.status).toBe("idle");
    expect(run.isStreaming).toBe(false);
  });

  it("kills and cleans up a managed child", async () => {
    await startLongTurn();
    const killed = await harness.callSubagent({ action: "kill", id: runId });
    expect((killed.details as RunDetails).run.status).toBe("killed");

    const cleaned = await harness.callSubagent({ action: "cleanup" });
    expect(cleaned.details).toMatchObject({ removed: 1, runs: [] });
  });
});

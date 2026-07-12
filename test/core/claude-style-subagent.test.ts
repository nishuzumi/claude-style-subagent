import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSubagentHarness,
  toolText,
  type SubagentHarness,
} from "../helpers/subagent-harness.ts";

type RunDetails = {
  run: {
    id: string;
    status: string;
    turns: number;
    lastAssistantText?: string;
    pendingUiRequests?: Array<{ id: string; method: string }>;
  };
};

describe.sequential("agents tool through a real AgentSession", () => {
  let harness: SubagentHarness;
  let runId = "";

  beforeAll(async () => {
    harness = await createSubagentHarness();
  });

  afterAll(async () => {
    await harness.cleanup();
  });

  it("discovers package and user agents through list_agents", async () => {
    const result = await harness.callSubagent({ action: "list_agents", agentScope: "user" });
    const details = result.details as { agents: Array<{ name: string; source: string }> };

    expect(details.agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "echo", source: "user" }),
      expect.objectContaining({ name: "reviewer", source: "package" }),
    ]));
  });

  it("applies package < user < project precedence for agent discovery", async () => {
    const result = await harness.callSubagent({ action: "list_agents", agentScope: "both" });
    const details = result.details as { agents: Array<{ name: string; source: string }> };
    expect(details.agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "echo", source: "project" }),
      expect.objectContaining({ name: "project-echo", source: "project" }),
    ]));
  });

  it("does not discover or run profiles from an untrusted project", async () => {
    const untrusted = await createSubagentHarness({ projectTrusted: false });
    try {
      const listed = await untrusted.callSubagent({ action: "list_agents", agentScope: "both" });
      const details = listed.details as { agents: Array<{ name: string; source: string }> };
      expect(details.agents).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "echo", source: "user" }),
      ]));
      expect(details.agents.some((agent) => agent.source === "project")).toBe(false);

      const spawned = await untrusted.callSubagent({
        action: "spawn",
        agent: "project-echo",
        agentScope: "project",
      });
      expect(spawned.details).toMatchObject({ error: "unknown_agent" });
    } finally {
      await untrusted.cleanup();
    }
  });

  it("returns actionable validation errors through the tool result", async () => {
    const missing = await harness.callSubagent({ action: "spawn" });
    expect(missing.details).toMatchObject({ error: "missing_agent" });

    const unknown = await harness.callSubagent({ action: "spawn", agent: "does-not-exist" });
    expect(unknown.details).toMatchObject({ error: "unknown_agent" });
    expect(toolText(unknown)).toContain("Available agents");

    const missingId = await harness.callSubagent({ action: "status" });
    expect(missingId.isError).toBe(true);
    expect(toolText(missingId)).toContain("id is required");
  });

  it("spawns a real child session and waits for its faux response", async () => {
    const result = await harness.callSubagent({
      action: "spawn",
      agent: "echo",
      task: "hello-child",
      wait: true,
      waitSeconds: 5,
      noSession: true,
    });
    const { run } = result.details as RunDetails;
    runId = run.id;

    expect(run.id).toMatch(/^echo-/);
    expect(run.status).toBe("idle");
    expect(run.turns).toBe(1);
    expect(run.lastAssistantText).toBe("CHILD_REPLY:hello-child");
    expect(toolText(result)).toContain(`Spawned ${run.id}`);
    expect(toolText(result)).toContain("status=complete");
  });

  it("delivers a one-shot completion notification to the main session", async () => {
    const notification = await harness.waitFor(() => harness.session.messages.find((message) =>
      message.role === "custom" && message.customType === "subagent-plus"));
    expect(notification.role).toBe("custom");
    if (notification.role === "custom") {
      expect(String(notification.content)).toContain(runId);
      expect(String(notification.content)).toContain("completed");
    }
  });

  it("lists and resolves the run by a unique id prefix", async () => {
    const listed = await harness.callSubagent({ action: "list" });
    const listDetails = listed.details as { runs: Array<{ id: string }> };
    expect(listDetails.runs.map((run) => run.id)).toContain(runId);

    const status = await harness.callSubagent({ action: "status", id: runId.slice(0, 12) });
    expect((status.details as RunDetails).run.id).toBe(runId);
    expect(toolText(status)).toContain("status=complete");
  });

  it("returns the child transcript and last assistant output", async () => {
    const transcript = await harness.callSubagent({ action: "transcript", id: runId, lines: 20 });
    expect(toolText(transcript)).toContain("CHILD_REPLY:hello-child");

    const lastOutput = await harness.callSubagent({ action: "last_output", id: runId });
    expect(toolText(lastOutput)).toBe("CHILD_REPLY:hello-child");
  });

  it("spawns an explicitly approved project agent", async () => {
    const result = await harness.callSubagent({
      action: "spawn",
      agent: "project-echo",
      agentScope: "project",
      task: "project-task",
      wait: true,
      noSession: true,
    });
    const { run } = result.details as RunDetails;
    expect(run.lastAssistantText).toBe("CHILD_REPLY:project-task");
  });

  it.each([
    ["prompt", "second-prompt", 2],
    ["steer", "idle-steer", 3],
    ["follow_up", "idle-follow-up", 4],
  ] as const)("%s drives another child turn", async (action, message, turns) => {
    const result = await harness.callSubagent({
      action,
      id: runId,
      message,
      wait: true,
      waitSeconds: 5,
    });
    const { run } = result.details as RunDetails;
    expect(run.turns).toBe(turns);
    expect(run.lastAssistantText).toBe(`CHILD_REPLY:${message}`);
  });

  it("prevents recursive spawning at the default maxDepth", async () => {
    await harness.callSubagent({
      action: "prompt",
      id: runId,
      message: `NESTED_CALL ${JSON.stringify({ action: "spawn", agent: "echo" })}`,
      wait: true,
      waitSeconds: 5,
    });
    const transcript = await harness.callSubagent({ action: "transcript", id: runId, lines: 100 });
    expect(toolText(transcript)).toContain("Refusing to spawn nested subagent at depth 1; maxDepth=1.");
  });

  it("surfaces child UI requests and resumes after reply_ui", async () => {
    await harness.callSubagent({
      action: "prompt",
      id: runId,
      message: "ASK_CONFIRM",
      wait: false,
    });

    let pending: RunDetails["run"] | undefined;
    for (let attempt = 0; attempt < 50; attempt++) {
      const status = await harness.callSubagent({ action: "status", id: runId });
      const run = (status.details as RunDetails).run;
      if (run.pendingUiRequests?.length) {
        pending = run;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(pending?.status).toBe("needs_attention");
    expect(pending?.pendingUiRequests?.[0]).toMatchObject({ method: "confirm" });
    const requestId = pending!.pendingUiRequests![0]!.id;

    const reply = await harness.callSubagent({
      action: "reply_ui",
      id: runId,
      requestId,
      value: true,
    });
    expect(reply.details).toMatchObject({ ok: true });

    let completed: RunDetails["run"] | undefined;
    for (let attempt = 0; attempt < 50; attempt++) {
      const status = await harness.callSubagent({ action: "status", id: runId });
      const run = (status.details as RunDetails).run;
      if (run.status === "idle" && !run.pendingUiRequests?.length) {
        completed = run;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(completed).toBeDefined();

    const transcript = await harness.callSubagent({ action: "transcript", id: runId, lines: 100 });
    expect(toolText(transcript)).toContain("accepted");
  });

  it("routes abort, kill, and cleanup through the managed run lifecycle", async () => {
    const aborted = await harness.callSubagent({ action: "abort", id: runId });
    expect(toolText(aborted)).toContain(`Abort requested for ${runId}`);

    const killed = await harness.callSubagent({ action: "kill", id: runId });
    expect((killed.details as RunDetails).run.status).toBe("killed");

    const cleaned = await harness.callSubagent({ action: "cleanup" });
    const cleanupDetails = cleaned.details as { removed: number; runs: Array<{ id: string }> };
    expect(cleanupDetails.removed).toBeGreaterThanOrEqual(2);
    expect(cleanupDetails.runs.map((run) => run.id)).not.toContain(runId);
  });
});

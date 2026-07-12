/**
 * `agent_wait` tool core — block the current turn until outstanding
 * subagent runs finish (or one needs attention).
 *
 * Why this exists
 * ---------------
 * A subagent spawned with `wait:false` runs concurrently while the parent keeps
 * working. In an interactive TUI session the parent can end its turn and Pi
 * later delivers a completion notification (see index.ts `notifyNotable` /
 * `deliverAs:"nextTurn"`). That passive delivery does NOT work when:
 *   - the parent is a skill / command that must run to completion, or
 *   - the run is non-interactive (`pi -p ...`), where the whole task is a single
 *     turn — once it ends there is no "next turn" left to receive the notice.
 *
 * `agent_wait` closes that gap: it keeps the turn alive until a tracked run
 * reaches a terminal state (complete / exited / error / killed), a run needs
 * attention (idle-blocked on a child UI request), the timeout elapses, or the
 * turn is aborted. Because it awaits INSIDE the turn, the completion the model
 * was told to wait for is actually observed before the tool returns.
 *
 * In-process advantage
 * --------------------
 * Unlike a child-process design that must scan lifecycle artifacts on disk,
 * this reads the live `SubagentRegistry` directly and wakes on its `onChange`
 * pub/sub. `onChange` is chatty (it fires on every child event, including token
 * deltas), so we wake on it but re-evaluate at most a few times per second via a
 * throttle floor; a poll cap remains as a reconciliation fallback and to drive
 * the timeout.
 */

import { getDisplayRunStatus, type RunSnapshot, type SubagentRegistry } from "./runner.ts";

export interface WaitParams {
  /** Run id / unique id prefix to wait for. Omit to wait across every active run. */
  id?: string;
  /**
   * When true (and no `id`), block until EVERY currently-active run is done.
   * Default false: return as soon as the FIRST active run finishes — lets a
   * fleet manager spawn a replacement and wait again, keeping N in flight.
   * Ignored when `id` targets a single run (that always waits for that one).
   */
  all?: boolean;
  /** Give up after this many milliseconds. Default 30 minutes. */
  timeoutMs?: number;
}

export interface WaitDeps {
  now?: () => number;
  /** Max ms between re-evaluations (also the timeout granularity). Default 1000. */
  pollIntervalMs?: number;
  /** Minimum ms between re-evaluations, so chatty onChange bursts can't busy-loop. Default 150. */
  floorIntervalMs?: number;
  /** Injectable sleep for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface WaitToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  details: Record<string, unknown>;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_FLOOR_INTERVAL_MS = 150;
const MIN_POLL_INTERVAL_MS = 200;

/** In flight = actively doing work (starting up or streaming a turn). */
function isActive(run: RunSnapshot): boolean {
  return run.status === "starting" || run.status === "running";
}

/** Blocked waiting on a child UI request — the parent must act, so wait breaks. */
function needsAttention(run: RunSnapshot): boolean {
  return run.status === "needs_attention" || (run.pendingUiRequests?.length ?? 0) > 0;
}

/** A run that can make a wait call return, including one already blocked on UI. */
function isWaitable(run: RunSnapshot): boolean {
  return isActive(run) || needsAttention(run);
}

/** Finished for good: nothing more will happen without a new prompt. */
function isTerminal(run: RunSnapshot): boolean {
  const display = getDisplayRunStatus(run);
  return display === "complete" || run.status === "exited" || run.status === "error" || run.status === "killed";
}

function matchesId(run: RunSnapshot, id: string): boolean {
  return run.id === id || run.id.startsWith(id);
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Resolve on the first registry change, after `ms`, or on abort — whichever is
 * first. The main loop adds a leading floor sleep so continuous onChange bursts
 * (token deltas) cannot spin this into a busy loop.
 */
function waitForChangeOrTimeout(
  registry: SubagentRegistry,
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      try { unsubscribe?.(); } catch { /* best effort */ }
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    if (signal?.aborted) return finish();
    signal?.addEventListener("abort", finish, { once: true });
    unsubscribe = registry.onChange(finish);
    timer = setTimeout(finish, ms);
  });
}

function durationText(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds ? `${minutes}m${seconds}s` : `${minutes}m`;
}

/** Count how the finished runs came out, for the summary line. */
function summarizeOutcome(runs: RunSnapshot[]): string {
  let complete = 0;
  let failed = 0;
  for (const run of runs) {
    if (run.status === "error" || run.status === "killed") failed++;
    else complete++;
  }
  const parts: string[] = [];
  if (complete) parts.push(`${complete} complete`);
  if (failed) parts.push(`${failed} failed`);
  return parts.join(", ");
}

function result(text: string, isError = false, details: Record<string, unknown> = {}): WaitToolResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}), details };
}

/**
 * Block until the targeted subagent runs finish, one needs attention, the
 * timeout elapses, or the turn is aborted. Resolves with a short human-readable
 * summary either way. Never throws for normal conditions.
 */
export async function waitForSubagents(
  registry: SubagentRegistry,
  params: WaitParams,
  signal: AbortSignal | undefined,
  deps: WaitDeps = {},
): Promise<WaitToolResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const pollIntervalMs = Math.max(MIN_POLL_INTERVAL_MS, deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  const floorIntervalMs = Math.min(deps.floorIntervalMs ?? DEFAULT_FLOOR_INTERVAL_MS, pollIntervalMs);
  const timeoutMs = params.timeoutMs !== undefined && params.timeoutMs > 0 ? params.timeoutMs : DEFAULT_TIMEOUT_MS;
  const startedAt = now();

  const activeNow = (): RunSnapshot[] => {
    const runs = registry.list().filter(isWaitable);
    return params.id ? runs.filter((run) => matchesId(run, params.id!)) : runs;
  };

  let active = activeNow();

  if (active.length === 0) {
    return result(
      params.id
        ? `No active subagent run matched "${params.id}". Nothing to wait for.`
        : "No active subagent runs. Nothing to wait for.",
    );
  }

  // Disambiguate an id prefix that matched more than one active run.
  if (params.id && active.length > 1) {
    const exact = active.filter((run) => run.id === params.id);
    if (exact.length === 1) active = exact;
    else {
      return result(
        `Ambiguous id prefix "${params.id}" matched ${active.length} active runs: ${active.map((r) => r.id).join(", ")}. Pass a longer id.`,
        true,
      );
    }
  }

  // A named id always means "wait for that one fully"; otherwise `all` decides.
  const waitForAll = params.id ? true : params.all === true;
  const initialIds = new Set(active.map((run) => run.id));
  const initialCount = initialIds.size;

  // Snapshot of the runs we are tracking, refreshed each iteration.
  const trackedNow = (): RunSnapshot[] => registry.list().filter((run) => initialIds.has(run.id));

  const isDone = (): boolean => {
    const tracked = trackedNow();
    // A run needing attention always breaks the wait, in either mode: the caller
    // has to nudge/resume/reply, and blocking longer helps nothing.
    if (tracked.some(needsAttention)) return true;
    const stillActive = tracked.filter((run) => isActive(run) && !needsAttention(run));
    if (waitForAll) return stillActive.length === 0;
    // First-completion: satisfied once any initially-active run left the active set.
    return stillActive.length < initialCount;
  };

  while (!isDone()) {
    if (signal?.aborted) {
      const stillActive = trackedNow().filter(isActive).map((r) => `${r.id} (${getDisplayRunStatus(r)})`);
      return result(
        `Wait aborted after ${durationText(now() - startedAt)}. Still active: ${stillActive.join(", ") || "none"}.`,
        true,
      );
    }
    if (now() - startedAt >= timeoutMs) {
      const stillActive = trackedNow().filter(isActive).map((r) => `${r.id} (${getDisplayRunStatus(r)})`);
      return result(
        `Wait timed out after ${durationText(timeoutMs)} with ${stillActive.length} run(s) still active: ${stillActive.join(", ")}. `
          + `The runs keep going; call agent_wait again or check with agents action=status.`,
        true,
      );
    }
    // Throttle floor first (so chatty onChange bursts can't busy-loop), then
    // wake on the next meaningful change or the poll cap.
    await sleep(floorIntervalMs, signal);
    await waitForChangeOrTimeout(registry, Math.max(0, pollIntervalMs - floorIntervalMs), signal);
  }

  // Build the summary.
  const tracked = trackedNow();
  const attention = tracked.filter(needsAttention);
  const finished = tracked.filter((run) => isTerminal(run) && !needsAttention(run));
  const stillActive = tracked.filter((run) => isActive(run) && !needsAttention(run));
  const elapsed = durationText(now() - startedAt);
  const outcome = finished.length ? ` Outcome: ${summarizeOutcome(finished)}.` : "";
  const attentionNote = attention.length
    ? ` ${attention.length} run(s) need attention: ${attention.map((r) => r.id).join(", ")} — check with agents action=status, then reply_ui / steer / follow_up / abort.`
    : "";

  const details = {
    waited: elapsed,
    mode: waitForAll ? "all" : "first",
    initialCount,
    finished: finished.map((r) => r.id),
    needsAttention: attention.map((r) => r.id),
    stillActive: stillActive.map((r) => r.id),
    runs: tracked,
  };

  if (waitForAll) {
    const scope = params.id ? `run "${params.id}"` : `${initialCount} run(s)`;
    const status = attention.length ? "attention required" : "done";
    return result(`Waited ${elapsed} for ${scope}; ${status}.${outcome}${attentionNote}`, false, details);
  }

  const remainder = stillActive.length
    ? ` ${stillActive.length} run(s) still in flight — call agent_wait again to catch the next one.`
    : attention.length
      ? " No other runs are waitable until attention is handled."
      : " No runs remain in flight.";
  const progress = attention.length && finished.length === 0
    ? `${attention.length} of ${initialCount} run(s) need attention`
    : `${finished.length} of ${initialCount} run(s) finished`;
  return result(`Waited ${elapsed}; ${progress}.${outcome}${attentionNote}${remainder}`, false, details);
}

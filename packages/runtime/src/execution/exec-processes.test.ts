// Unit tests for the process-group exec runner and its live-execution
// registry / crash-recovery sidecar. Uses real short-lived processes
// with poll-based checks (no fixed sleeps) per the fast-test rules.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __liveExecSnapshot,
  __resetLiveExecRegistry,
  killTrackedExecProcesses,
  reapOrphanedExecProcesses,
  runExecProcess
} from "./exec-processes";
import { instanceRoot } from "../paths";

let root: string;
let workspaceRoot: string;
let prevState: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gini-exec-proc-"));
  workspaceRoot = mkdtempSync(join(tmpdir(), "gini-exec-proc-ws-"));
  prevState = process.env.GINI_STATE_ROOT;
  process.env.GINI_STATE_ROOT = root;
  __resetLiveExecRegistry();
});

afterEach(async () => {
  // Kill anything a failed assertion left behind before removing dirs.
  await killTrackedExecProcesses({ graceMs: 200 });
  __resetLiveExecRegistry();
  if (prevState === undefined) delete process.env.GINI_STATE_ROOT;
  else process.env.GINI_STATE_ROOT = prevState;
  rmSync(root, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
});

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function pollUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(25);
  }
  return predicate();
}

function sidecarDir(instance: string): string {
  return join(instanceRoot(instance), "exec-live");
}

test("completes a normal command, returns output, and clears registry + sidecar", async () => {
  const result = await runExecProcess({
    instance: "exec-normal",
    spawnArgs: ["sh", "-c", "echo out-line; echo err-line 1>&2"],
    cwd: workspaceRoot,
    command: "echo out-line",
    timeoutMs: 5_000
  });
  expect(result.exitCode).toBe(0);
  expect(result.timedOut).toBe(false);
  expect(result.winner).toBe("exited");
  expect(result.stdout).toContain("out-line");
  expect(result.stderr).toContain("err-line");
  expect(__liveExecSnapshot("exec-normal")).toEqual([]);
  const dir = sidecarDir("exec-normal");
  expect(!existsSync(dir) || readdirSync(dir).length === 0).toBe(true);
});

test("timeoutMs kills the entire process group including forked children", async () => {
  const pidFile = join(workspaceRoot, "child.pid");
  const started = Date.now();
  const result = await runExecProcess({
    instance: "exec-timeout",
    spawnArgs: ["sh", "-c", `sleep 30 & echo $! > ${pidFile}; sleep 30`],
    cwd: workspaceRoot,
    command: "sleep 30 & sleep 30",
    timeoutMs: 50
  });
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(result.timedOut).toBe(true);
  expect(result.exitCode).not.toBe(0);
  const childPid = Number(readFileSync(pidFile, "utf8").trim());
  expect(await pollUntil(() => !pidAlive(childPid), 5_000)).toBe(true);
  expect(__liveExecSnapshot("exec-timeout")).toEqual([]);
});

test("abort signal kills the group and reports winner aborted with the reason", async () => {
  const controller = new AbortController();
  const pidFile = join(workspaceRoot, "abort-child.pid");
  const running = runExecProcess({
    instance: "exec-abort",
    spawnArgs: ["sh", "-c", `sleep 30 & echo $! > ${pidFile}; wait`],
    cwd: workspaceRoot,
    command: "sleep 30 & wait",
    timeoutMs: 60_000,
    signal: controller.signal
  });
  expect(await pollUntil(() => existsSync(pidFile), 5_000)).toBe(true);
  controller.abort("task.cancelled");
  const result = await running;
  expect(result.winner).toBe("aborted");
  expect(result.abortReason).toBe("task.cancelled");
  const childPid = Number(readFileSync(pidFile, "utf8").trim());
  expect(await pollUntil(() => !pidAlive(childPid), 5_000)).toBe(true);
});

test("post-exit drain is bounded: a stray pipe-holding child is killed instead of wedging the runner", async () => {
  const pidFile = join(workspaceRoot, "stray.pid");
  const started = Date.now();
  // The shell exits 0 immediately; the backgrounded sleep inherits the
  // stdout pipe and would block a Response.text()-style drain for 30s.
  const result = await runExecProcess({
    instance: "exec-drain",
    spawnArgs: ["sh", "-c", `sleep 30 & echo $! > ${pidFile}; echo done; exit 0`],
    cwd: workspaceRoot,
    command: "stray child",
    timeoutMs: 60_000,
    drainGraceMs: 60
  });
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(result.exitCode).toBe(0);
  expect(result.timedOut).toBe(false);
  expect(result.stdout).toContain("done");
  const strayPid = Number(readFileSync(pidFile, "utf8").trim());
  expect(await pollUntil(() => !pidAlive(strayPid), 5_000)).toBe(true);
});

test("a stray pipe-holder past the budget boundary does not mark an in-budget exit as timed out", async () => {
  const pidFile = join(workspaceRoot, "stray-budget.pid");
  // The shell exits immediately — well inside the 50ms budget — but the
  // backgrounded sleep holds the stdout pipe so the bounded drain runs
  // PAST the budget boundary. The budget timer is disarmed at exit;
  // were it still armed it would fire mid-drain and falsely flag
  // timedOut on a command that finished in time.
  const result = await runExecProcess({
    instance: "exec-drain-budget",
    spawnArgs: ["sh", "-c", `sleep 30 & echo $! > ${pidFile}; echo done; exit 0`],
    cwd: workspaceRoot,
    command: "stray past budget",
    timeoutMs: 50,
    drainGraceMs: 120
  });
  expect(result.timedOut).toBe(false);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("done");
  // The drain kill still fires: the stray dies even though the budget
  // timer never did.
  const strayPid = Number(readFileSync(pidFile, "utf8").trim());
  expect(await pollUntil(() => !pidAlive(strayPid), 5_000)).toBe(true);
});

test("killTrackedExecProcesses kills live groups at shutdown", async () => {
  const pidFile = join(workspaceRoot, "shutdown-child.pid");
  const running = runExecProcess({
    instance: "exec-shutdown",
    spawnArgs: ["sh", "-c", `sleep 30 & echo $! > ${pidFile}; wait`],
    cwd: workspaceRoot,
    command: "sleep 30 & wait",
    timeoutMs: 60_000
  });
  expect(await pollUntil(() => __liveExecSnapshot("exec-shutdown").length === 1, 5_000)).toBe(true);
  expect(await pollUntil(() => existsSync(pidFile), 5_000)).toBe(true);
  const killed = await killTrackedExecProcesses({ graceMs: 300 });
  expect(killed).toBe(1);
  const result = await running;
  expect(result.exitCode).not.toBe(0);
  const childPid = Number(readFileSync(pidFile, "utf8").trim());
  expect(await pollUntil(() => !pidAlive(childPid), 5_000)).toBe(true);
  expect(__liveExecSnapshot("exec-shutdown")).toEqual([]);
});

test("reapOrphanedExecProcesses kills an orphan whose sidecar identity matches", async () => {
  const instance = "exec-reap";
  // Start a long-running exec, then simulate a runtime crash by
  // clearing the in-memory registry while the sidecar stays on disk.
  const pidFile = join(workspaceRoot, "orphan-child.pid");
  const running = runExecProcess({
    instance,
    spawnArgs: ["sh", "-c", `sleep 30 & echo $! > ${pidFile}; wait`],
    cwd: workspaceRoot,
    command: "orphaned sleep",
    timeoutMs: 60_000
  });
  expect(await pollUntil(() => __liveExecSnapshot(instance).length === 1, 5_000)).toBe(true);
  const files = readdirSync(sidecarDir(instance));
  expect(files.length).toBe(1);
  const sidecarPath = join(sidecarDir(instance), files[0]!);
  const record = JSON.parse(readFileSync(sidecarPath, "utf8")) as { pid: number };
  __resetLiveExecRegistry(instance); // "restart": in-memory registry gone, sidecar remains.

  const result = await reapOrphanedExecProcesses(instance, { graceMs: 500 });
  expect(result.reaped.map((r) => r.pid)).toEqual([record.pid]);
  expect(result.dropped).toBe(0);
  expect(await pollUntil(() => !pidAlive(record.pid), 5_000)).toBe(true);
  expect(readdirSync(sidecarDir(instance))).toEqual([]);
  // The runner's own promise settles once the group dies.
  const settled = await running;
  expect(settled.exitCode).not.toBe(0);
});

test("reap drops an identity-mismatched record WITHOUT killing the process (pid reuse guard)", async () => {
  const instance = "exec-reap-mismatch";
  const pidFile = join(workspaceRoot, "mismatch-child.pid");
  const running = runExecProcess({
    instance,
    spawnArgs: ["sh", "-c", `echo $$ > ${pidFile}; sleep 30`],
    cwd: workspaceRoot,
    command: "mismatch target",
    timeoutMs: 60_000
  });
  expect(await pollUntil(() => __liveExecSnapshot(instance).length === 1, 5_000)).toBe(true);
  const files = readdirSync(sidecarDir(instance));
  const sidecarPath = join(sidecarDir(instance), files[0]!);
  const record = JSON.parse(readFileSync(sidecarPath, "utf8")) as Record<string, unknown>;
  // Doctor the identity: same pid, different recorded start time — the
  // shape a recycled pid would present after a crash.
  writeFileSync(sidecarPath, JSON.stringify({ ...record, psLstart: "Mon Jan  1 00:00:00 1990" }));
  __resetLiveExecRegistry(instance);

  const result = await reapOrphanedExecProcesses(instance, { graceMs: 200 });
  expect(result.reaped).toEqual([]);
  expect(result.dropped).toBe(1);
  // Record dropped, process NOT killed.
  expect(readdirSync(sidecarDir(instance))).toEqual([]);
  const pid = Number(record.pid);
  expect(pidAlive(pid)).toBe(true);
  // Clean up the intentionally-surviving process.
  try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
  await running;
});

test("reap drops a doctored-pgid record without killing anything", async () => {
  const instance = "exec-reap-bad-pgid";
  const pidFile = join(workspaceRoot, "bad-pgid-child.pid");
  const running = runExecProcess({
    instance,
    spawnArgs: ["sh", "-c", `echo $$ > ${pidFile}; sleep 30`],
    cwd: workspaceRoot,
    command: "bad pgid target",
    timeoutMs: 60_000
  });
  expect(await pollUntil(() => __liveExecSnapshot(instance).length === 1, 5_000)).toBe(true);
  const files = readdirSync(sidecarDir(instance));
  const sidecarPath = join(sidecarDir(instance), files[0]!);
  const record = JSON.parse(readFileSync(sidecarPath, "utf8")) as Record<string, unknown>;
  // Doctor ONLY the pgid: pid alive + identity matching, so the pgid
  // guard is the only thing between this record and kill(0)/kill(-1).
  writeFileSync(sidecarPath, JSON.stringify({ ...record, pgid: 0 }));
  __resetLiveExecRegistry(instance);

  const result = await reapOrphanedExecProcesses(instance, { graceMs: 200 });
  expect(result.reaped).toEqual([]);
  expect(result.dropped).toBe(1);
  // Record dropped, process NOT killed.
  expect(readdirSync(sidecarDir(instance))).toEqual([]);
  const pid = Number(record.pid);
  expect(pidAlive(pid)).toBe(true);
  // Clean up the intentionally-surviving process.
  try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
  await running;
});

test("reap drops records for dead pids without error", async () => {
  const instance = "exec-reap-dead";
  await runExecProcess({
    instance,
    spawnArgs: ["sh", "-c", "true"],
    cwd: workspaceRoot,
    command: "true",
    timeoutMs: 5_000
  });
  // Settled runs clear their sidecar; fabricate one for a dead pid to
  // model a crash that raced the exit.
  const dir = sidecarDir(instance);
  const fabricated = { pid: 999999, pgid: 999999, startedAt: new Date().toISOString(), command: "gone" };
  writeFileSync(join(dir, "999999.json"), JSON.stringify(fabricated));
  const result = await reapOrphanedExecProcesses(instance, { graceMs: 200 });
  expect(result.reaped).toEqual([]);
  expect(result.dropped).toBe(1);
  expect(readdirSync(dir)).toEqual([]);
});

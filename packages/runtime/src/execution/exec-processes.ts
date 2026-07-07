// Process-group execution for terminal.exec side effects.
//
// Every approved (or allowlist-auto-approved) shell command is spawned
// DETACHED so the child becomes its own process-group leader (pgid ===
// pid). That makes three guarantees possible that a plain child-only
// `proc.kill()` cannot provide (live-QA bug: an approved
// `... || find / -name ...` ran 75+ minutes past its 60s timeoutMs, and
// runtime restarts orphaned the scan):
//
//   1. timeoutMs is enforced against the WHOLE tree: on timeout the
//      entire group receives SIGTERM, escalating to SIGKILL after a
//      short grace, so forked grandchildren (`sleep 30 &`) die with the
//      shell instead of surviving as orphans that also keep the
//      stdout/stderr pipes open (which is what blocked the executor —
//      and the approve HTTP response awaiting it — for the grandchild's
//      full lifetime).
//   2. Runtime shutdown kills every live executor group via the
//      in-process registry (`killTrackedExecProcesses`), so `gini run`
//      going down never strands approved commands.
//   3. Crashed runtimes leave a per-execution sidecar record
//      (pid/pgid/identity) under the instance dir; the next boot reaps
//      groups whose identity still matches (`reapOrphanedExecProcesses`)
//      and drops records whose pid was reused — identity is verified via
//      the ps start time + command line before any kill.
//
// Stream collection is incremental (chunk reader, not
// `new Response(stream).text()`), and the post-exit drain is BOUNDED:
// once the direct child has exited, any remaining pipe writer is a
// stray group member; after `drainGraceMs` the group is SIGKILLed and
// the output collected so far is returned. This closes the second half
// of the QA hang — a group escapee can no longer wedge the executor.

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "bun";
import { instanceRoot } from "../paths";

// TERM → KILL escalation grace. Long enough for a shell to run its EXIT
// traps, short enough that a TERM-ignoring child can't stretch the
// timeout budget meaningfully.
const DEFAULT_KILL_GRACE_MS = 1_500;
// Post-exit stream-drain bound. The direct child has already exited by
// the time this applies; legitimate foreground output is long flushed.
const DEFAULT_DRAIN_GRACE_MS = 2_000;

export interface ExecProcessOptions {
  instance: string;
  spawnArgs: string[];
  cwd: string;
  // Human-readable command for the sidecar record / reap logs.
  command: string;
  timeoutMs: number;
  signal?: AbortSignal;
  killGraceMs?: number;
  drainGraceMs?: number;
}

export interface ExecProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  // True when the timeoutMs budget elapsed and the group was killed.
  timedOut: boolean;
  // "aborted" when the AbortSignal won the race against proc.exited.
  winner: "exited" | "aborted";
  abortReason: string | undefined;
}

interface LiveExecEntry {
  pid: number;
  pgid: number;
  command: string;
  startedAt: string;
  sidecarPath: string;
}

// Sidecar record persisted at spawn, cleared on settle. `psLstart` /
// `psCommand` are the identity captured from `ps` right after the
// spawn; a reap only kills when BOTH still match, so a pid recycled by
// the OS after a crash is never killed by mistake.
interface ExecSidecarRecord {
  pid: number;
  pgid: number;
  startedAt: string;
  command: string;
  psLstart?: string;
  psCommand?: string;
}

// In-process registry of live executor process groups, keyed by pid.
// One runtime process serves one instance, but the instance key keeps
// test isolation honest (same pattern as approval-execution.ts).
const liveExecs = new Map<string, Map<number, LiveExecEntry>>();

function execLiveDir(instance: string): string {
  return join(instanceRoot(instance), "exec-live");
}

function psField(pid: number, field: "lstart" | "command"): string | undefined {
  try {
    const out = spawnSync(["ps", "-o", `${field}=`, "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
    const text = out.stdout ? new TextDecoder().decode(out.stdout).trim() : "";
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists but belongs to another user — alive
    // (and the identity check below will refuse to kill it anyway).
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function killGroup(pgid: number, sig: "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(-pgid, sig);
  } catch {
    // Group already gone (or never became a leader) — best-effort.
  }
}

function registerExec(instance: string, pid: number, command: string): LiveExecEntry {
  const dir = execLiveDir(instance);
  mkdirSync(dir, { recursive: true });
  const sidecarPath = join(dir, `${pid}.json`);
  const record: ExecSidecarRecord = {
    pid,
    pgid: pid, // detached spawn: the child is its own group leader.
    startedAt: new Date().toISOString(),
    command,
    psLstart: psField(pid, "lstart"),
    psCommand: psField(pid, "command")
  };
  try {
    writeFileSync(sidecarPath, JSON.stringify(record));
  } catch {
    // Sidecar is the crash-recovery net, not the execution path — a
    // write failure must not block the command.
  }
  const entry: LiveExecEntry = { pid, pgid: pid, command, startedAt: record.startedAt, sidecarPath };
  let m = liveExecs.get(instance);
  if (!m) {
    m = new Map();
    liveExecs.set(instance, m);
  }
  m.set(pid, entry);
  return entry;
}

function unregisterExec(instance: string, pid: number): void {
  const m = liveExecs.get(instance);
  const entry = m?.get(pid);
  if (m) {
    m.delete(pid);
    if (m.size === 0) liveExecs.delete(instance);
  }
  const sidecarPath = entry?.sidecarPath ?? join(execLiveDir(instance), `${pid}.json`);
  try {
    rmSync(sidecarPath, { force: true });
  } catch {
    // Best-effort — a stale sidecar for a dead pid is dropped at reap.
  }
}

// Incrementally collect a stream into chunks so a bounded drain bail
// can still return everything read so far (Response.text() is
// all-or-nothing and was the hang point pre-fix).
function collectStream(stream: ReadableStream<Uint8Array>): { done: Promise<void>; read: () => string; cancel: () => void } {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  const done = (async () => {
    try {
      for (;;) {
        const { done: finished, value } = await reader.read();
        if (finished) break;
        if (value) chunks.push(value);
      }
    } catch {
      // Stream errored on kill — keep what we have.
    }
  })();
  return {
    done,
    read: () => {
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        merged.set(c, offset);
        offset += c.length;
      }
      return new TextDecoder().decode(merged);
    },
    cancel: () => {
      void reader.cancel().catch(() => {});
    }
  };
}

function readSignalReason(signal: AbortSignal): string | undefined {
  if (!signal.aborted) return undefined;
  return typeof signal.reason === "string" ? signal.reason : undefined;
}

// Spawn a shell command in its own process group and run it under the
// timeout / abort / drain rules documented at the top of this module.
export async function runExecProcess(opts: ExecProcessOptions): Promise<ExecProcessResult> {
  const killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const drainGraceMs = opts.drainGraceMs ?? DEFAULT_DRAIN_GRACE_MS;
  const proc = spawn(opts.spawnArgs, {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
    detached: true
  });
  registerExec(opts.instance, proc.pid, opts.command);

  let timedOut = false;
  let abortReason: string | undefined;
  const timers: Timer[] = [];
  const killGroupEscalating = (): void => {
    killGroup(proc.pid, "SIGTERM");
    timers.push(setTimeout(() => killGroup(proc.pid, "SIGKILL"), killGraceMs));
  };

  const stdoutCollector = collectStream(proc.stdout);
  const stderrCollector = collectStream(proc.stderr);

  try {
    const budgetTimer = setTimeout(() => {
      timedOut = true;
      killGroupEscalating();
    }, opts.timeoutMs);
    timers.push(budgetTimer);

    // Race proc.exited against the abort signal to pick the audit-row
    // name (same microtask-ordering rationale as the pre-group-kill
    // executor: whichever promise settles first wins, no side-flag).
    const procExitedSentinel = proc.exited.then(() => "exited" as const);
    const winner = opts.signal
      ? await Promise.race([
          procExitedSentinel,
          new Promise<"aborted">((resolve) => {
            const sig = opts.signal!;
            if (sig.aborted) {
              abortReason = readSignalReason(sig);
              resolve("aborted");
              return;
            }
            sig.addEventListener(
              "abort",
              () => {
                abortReason = readSignalReason(sig);
                resolve("aborted");
              },
              { once: true }
            );
          })
        ])
      : await procExitedSentinel;
    if (winner === "aborted") killGroupEscalating();

    const exitCode = await proc.exited;
    // The child exited on its own — the budget no longer applies.
    // Disarm the budget timer BEFORE the bounded drain: a stray group
    // member holding the pipe past the budget boundary must not flip
    // timedOut on a command that exited in time (the drain's own
    // SIGKILL below still fires).
    clearTimeout(budgetTimer);

    // Bounded drain: the direct child has exited; any pipe writer still
    // alive is a stray group member. Give the streams a grace to flush,
    // then SIGKILL the group and return what was collected.
    const collectorsDone = Promise.all([stdoutCollector.done, stderrCollector.done]);
    const DRAIN_TIMED_OUT = Symbol("drain-timed-out");
    const first = await Promise.race([collectorsDone, Bun.sleep(drainGraceMs).then(() => DRAIN_TIMED_OUT)]);
    if (first === DRAIN_TIMED_OUT) {
      killGroup(proc.pid, "SIGKILL");
      await Promise.race([collectorsDone, Bun.sleep(500)]);
      stdoutCollector.cancel();
      stderrCollector.cancel();
    }

    return {
      stdout: stdoutCollector.read(),
      stderr: stderrCollector.read(),
      exitCode,
      timedOut,
      winner,
      abortReason
    };
  } finally {
    for (const t of timers) clearTimeout(t);
    unregisterExec(opts.instance, proc.pid);
  }
}

// Kill every live executor process group tracked by this process.
// Called from the runtime shutdown drain so approved commands never
// outlive `gini run`. TERM first, then poll, then KILL survivors.
export async function killTrackedExecProcesses(opts: { graceMs?: number } = {}): Promise<number> {
  const graceMs = opts.graceMs ?? DEFAULT_KILL_GRACE_MS;
  const entries: Array<{ instance: string; entry: LiveExecEntry }> = [];
  for (const [instance, m] of liveExecs) {
    for (const entry of m.values()) entries.push({ instance, entry });
  }
  if (entries.length === 0) return 0;
  for (const { entry } of entries) killGroup(entry.pgid, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && entries.some(({ entry }) => groupAlive(entry.pgid))) {
    await Bun.sleep(50);
  }
  for (const { entry } of entries) {
    if (groupAlive(entry.pgid)) killGroup(entry.pgid, "SIGKILL");
  }
  for (const { instance, entry } of entries) unregisterExec(instance, entry.pid);
  return entries.length;
}

export interface ReapResult {
  // Sidecar records whose process identity matched and whose group was
  // killed.
  reaped: Array<{ pid: number; command: string; startedAt: string }>;
  // Records dropped without a kill: dead pid, unreadable record, or an
  // identity mismatch (pid reuse).
  dropped: number;
}

// Boot-time sweep: kill orphaned executor groups left by a previous
// runtime process (crash or hard kill — clean shutdown already killed
// and cleared them). Identity is verified BEFORE any kill: the pid must
// still be alive AND both ps identity fields captured at spawn must
// match the current process, otherwise the record is dropped untouched.
export async function reapOrphanedExecProcesses(instance: string, opts: { graceMs?: number } = {}): Promise<ReapResult> {
  const graceMs = opts.graceMs ?? DEFAULT_KILL_GRACE_MS;
  const dir = execLiveDir(instance);
  const result: ReapResult = { reaped: [], dropped: 0 };
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return result; // No sidecar dir — nothing ever ran.
  }
  for (const file of files) {
    const path = join(dir, file);
    let record: ExecSidecarRecord | undefined;
    try {
      record = JSON.parse(readFileSync(path, "utf8")) as ExecSidecarRecord;
    } catch {
      record = undefined;
    }
    // pgid is validated alongside pid: a doctored or absent pgid must
    // never reach `kill(-pgid)` — pgid 0 would signal the runtime's own
    // process group and pgid 1 would signal every process we can reach.
    if (
      !record ||
      !Number.isInteger(record.pid) ||
      record.pid <= 1 ||
      !Number.isInteger(record.pgid) ||
      record.pgid <= 1 ||
      !pidAlive(record.pid)
    ) {
      rmSync(path, { force: true });
      result.dropped += 1;
      continue;
    }
    // Identity check: without a captured spawn-time identity we cannot
    // prove the live pid is ours — drop the record, never kill.
    const lstartNow = psField(record.pid, "lstart");
    const commandNow = psField(record.pid, "command");
    const identityMatches =
      record.psLstart !== undefined &&
      record.psCommand !== undefined &&
      lstartNow === record.psLstart &&
      commandNow === record.psCommand;
    if (!identityMatches) {
      rmSync(path, { force: true });
      result.dropped += 1;
      continue;
    }
    killGroup(record.pgid, "SIGTERM");
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline && groupAlive(record.pgid)) {
      await Bun.sleep(50);
    }
    if (groupAlive(record.pgid)) killGroup(record.pgid, "SIGKILL");
    rmSync(path, { force: true });
    result.reaped.push({ pid: record.pid, command: record.command, startedAt: record.startedAt });
  }
  return result;
}

// Test-only helpers (same convention as approval-execution.ts).
export function __liveExecSnapshot(instance?: string): Array<{ pid: number; command: string }> {
  const out: Array<{ pid: number; command: string }> = [];
  const visit = (m: Map<number, LiveExecEntry>): void => {
    for (const entry of m.values()) out.push({ pid: entry.pid, command: entry.command });
  };
  if (instance) {
    const m = liveExecs.get(instance);
    if (m) visit(m);
  } else {
    for (const m of liveExecs.values()) visit(m);
  }
  return out;
}

export function __resetLiveExecRegistry(instance?: string): void {
  if (!instance) {
    liveExecs.clear();
    return;
  }
  liveExecs.delete(instance);
}

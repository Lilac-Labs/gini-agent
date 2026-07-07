// Regression tests for terminal.exec timeout enforcement (live-QA bug):
// an approved command whose payload carried timeoutMs was only ever
// SIGTERMed at its immediate child (`zsh -lc`), so
//   (a) grandchildren (`find / &`, `sleep 30 &`) survived the kill, and
//   (b) the stdout/stderr drain blocked on the surviving grandchild's
//       inherited pipe FDs — the executor (and the approve HTTP call
//       awaiting it) hung for the grandchild's full lifetime.
// The executor now spawns the command in its own process group
// (detached) and kills the ENTIRE group on timeout (TERM → KILL
// escalation), so both the child and any forked grandchildren are gone
// and the result returns within the budget, reported truthfully as a
// timeout.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAuthorization } from "../agent";
import { mutateState, readState } from "../state";
import { createAuthorization } from "../state/records";
import type { RuntimeConfig } from "../types";

let root: string;
let workspaceRoot: string;
let prevState: string | undefined;
let prevLog: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gini-term-timeout-"));
  workspaceRoot = mkdtempSync(join(tmpdir(), "gini-term-timeout-ws-"));
  prevState = process.env.GINI_STATE_ROOT;
  prevLog = process.env.GINI_LOG_ROOT;
  process.env.GINI_STATE_ROOT = root;
  process.env.GINI_LOG_ROOT = `${root}-logs`;
});

afterEach(() => {
  if (prevState === undefined) delete process.env.GINI_STATE_ROOT;
  else process.env.GINI_STATE_ROOT = prevState;
  if (prevLog === undefined) delete process.env.GINI_LOG_ROOT;
  else process.env.GINI_LOG_ROOT = prevLog;
  rmSync(root, { recursive: true, force: true });
  rmSync(`${root}-logs`, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
});

function buildConfig(instance: string): RuntimeConfig {
  return {
    instance,
    port: 7341,
    token: "test",
    provider: { name: "echo", model: "" },
    workspaceRoot,
    stateRoot: root,
    logRoot: `${root}-logs`
  };
}

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

test("terminal.exec timeoutMs kills the whole process group and reports the timeout truthfully", async () => {
  const config = buildConfig("term-timeout-group");
  const pidFile = join(workspaceRoot, "grandchild.pid");
  // The backgrounded sleep is a grandchild that inherits the stdout pipe;
  // pre-fix it survived the child-only SIGTERM and the drain blocked on it.
  const command = `sleep 15 & echo $! > ${pidFile}; wait`;
  const approval = await mutateState(config.instance, (state) =>
    createAuthorization(state, {
      action: "terminal.exec",
      target: command,
      risk: "high",
      reason: "test",
      payload: { command, timeoutMs: 200 }
    })
  );

  const started = Date.now();
  const { toolResult } = await resolveAuthorization(config, approval.id, {
    actor: "runtime",
    resumeChatTask: false
  });
  const elapsed = Date.now() - started;

  // The executor must return within the budget + kill escalation grace,
  // never the grandchild's 15s lifetime.
  expect(elapsed).toBeLessThan(5_000);
  expect(String(toolResult)).toContain("timed out");
  expect(String(toolResult)).toContain("200ms");

  // The grandchild recorded its own pid before the timeout fired; both it
  // and the shell must be gone (group kill), polled — no fixed sleeps.
  expect(existsSync(pidFile)).toBe(true);
  const grandchildPid = Number(readFileSync(pidFile, "utf8").trim());
  expect(Number.isInteger(grandchildPid)).toBe(true);
  expect(await pollUntil(() => !pidAlive(grandchildPid), 5_000)).toBe(true);

  // The side-effect audit row is still the regular `terminal.exec` row
  // (the command DID execute), stamped with the approvalId and a truthful
  // timedOut marker — the wedge-heal's executed-proof semantics depend on
  // the row being present at execution time.
  const audit = readState(config.instance).audit.find(
    (a) => a.action === "terminal.exec" && a.approvalId === approval.id
  );
  expect(audit).toBeDefined();
  expect(audit?.evidence?.timedOut).toBe(true);
  expect(audit?.evidence?.timeoutMs).toBe(200);
}, 20_000);

test("terminal.exec defaults the timeout budget to 60s when the payload omits timeoutMs", async () => {
  const config = buildConfig("term-timeout-default");
  const approval = await mutateState(config.instance, (state) =>
    createAuthorization(state, {
      action: "terminal.exec",
      target: "echo ok",
      risk: "high",
      reason: "test",
      payload: { command: "echo ok" }
    })
  );
  const { toolResult } = await resolveAuthorization(config, approval.id, {
    actor: "runtime",
    resumeChatTask: false
  });
  expect(String(toolResult)).toContain("exit 0");
  // The tool schema promises a 60s default; the command finished inside
  // it, so the audit row carries no timedOut marker (non-timeout rows
  // omit the timedOut/timeoutMs evidence fields entirely).
  const audit = readState(config.instance).audit.find(
    (a) => a.action === "terminal.exec" && a.approvalId === approval.id
  );
  expect(audit).toBeDefined();
  expect(audit?.evidence?.timedOut).toBeUndefined();
}, 20_000);

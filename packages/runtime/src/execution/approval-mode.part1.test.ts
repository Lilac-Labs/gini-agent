// End-to-end tests for `approvalMode` across the chat-task dispatcher
// and the legacy imperative path.
//
// The matrix covers `{strict, auto, yolo}` x the five approval-eligible
// tools (`file_write`, `file_patch`, `terminal_exec` safe + dangerous,
// `code_exec`, `browser_upload_file`). We use the echo provider with
// stubbed tool-calling responses to drive the chat-task loop end-to-end
// without a real LLM, then verify both the task outcome and the audit
// trail (authorization.requested -> authorization.approved -> <action>) carries
// the expected `autoApprovedReason`.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearEchoToolCallingResponses,
  setEchoToolCallingResponse,
  normalizeProvider
} from "../provider";
import { submitTask, resolveAuthorization, decideApproval } from "../agent";
import { readState, mutateState, createAuthorization } from "../state";
import type { RuntimeConfig, Task } from "../types";

function buildConfig(workspaceRoot: string, instance: string, opts: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    instance,
    port: 7338,
    token: "test",
    provider: { name: "echo", model: "" },
    workspaceRoot,
    stateRoot: process.env.GINI_STATE_ROOT ?? "/tmp/gini-approval-mode-test",
    logRoot: process.env.GINI_LOG_ROOT ?? "/tmp/gini-approval-mode-test-logs",
    ...opts
  };
}

// Poll granularity is deliberately tight (5ms): the echo-provider dispatch
// settles in ~25ms for a single-turn pause and ~30-140ms for a two-turn
// completion, so a coarse 20ms tick spends most of its budget in dead wait
// between the task flipping terminal and this loop observing it. 5ms keeps
// the observation responsive without changing the 5000ms deadline — the
// task genuinely completes fast, we just stop over-sleeping past it.
const POLL_TICK_MS = 5;

async function waitForTerminal(config: RuntimeConfig, taskId: string, timeoutMs = 5000): Promise<Task> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = readState(config.instance);
    const task = state.tasks.find((t) => t.id === taskId);
    if (task && (task.status === "completed" || task.status === "failed" || task.status === "cancelled" || task.status === "waiting_approval")) {
      return task;
    }
    await Bun.sleep(POLL_TICK_MS);
  }
  throw new Error(`Task ${taskId} did not reach terminal state within ${timeoutMs}ms`);
}

// Variant that waits specifically for a non-waiting_approval terminal
// state. The imperative auto-resolve path briefly flips the task to
// `waiting_approval` inside requestShell/requestFileWrite before
// `resolveAuthorization` runs and flips it to `completed`; callers that
// expect the final state need to poll past the intermediate one.
async function waitForFinalTerminal(config: RuntimeConfig, taskId: string, timeoutMs = 5000): Promise<Task> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = readState(config.instance);
    const task = state.tasks.find((t) => t.id === taskId);
    if (task && (task.status === "completed" || task.status === "failed" || task.status === "cancelled")) {
      return task;
    }
    await Bun.sleep(POLL_TICK_MS);
  }
  throw new Error(`Task ${taskId} did not reach a final terminal state within ${timeoutMs}ms`);
}

describe("approvalMode dispatch matrix", () => {
  let root: string;
  let prevState: string | undefined;
  let prevLog: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gini-approval-mode-"));
    prevState = process.env.GINI_STATE_ROOT;
    prevLog = process.env.GINI_LOG_ROOT;
    process.env.GINI_STATE_ROOT = root;
    process.env.GINI_LOG_ROOT = `${root}-logs`;
    clearEchoToolCallingResponses();
  });

  afterEach(() => {
    if (prevState === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = prevState;
    if (prevLog === undefined) delete process.env.GINI_LOG_ROOT;
    else process.env.GINI_LOG_ROOT = prevLog;
    rmSync(root, { recursive: true, force: true });
    clearEchoToolCallingResponses();
  });

  // ---------------- strict ----------------

  describe("strict mode", () => {
    test("file_write pauses for approval", async () => {
      const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-approval-mode-ws-"));
      const config = buildConfig(workspaceRoot, "strict-fw", { approvalMode: "strict" });
      const provider = normalizeProvider(config.provider);

      setEchoToolCallingResponse({
        provider,
        text: "",
        toolCalls: [
          { id: "call_w", type: "function", function: { name: "file_write", arguments: JSON.stringify({ path: "x.txt", content: "x" }) } }
        ],
        finishReason: "tool_calls"
      });

      const task = await submitTask(config, "write x.txt", { mode: "chat" });
      const paused = await waitForTerminal(config, task.id);
      expect(paused.status).toBe("waiting_approval");
      expect(existsSync(join(workspaceRoot, "x.txt"))).toBe(false);

      rmSync(workspaceRoot, { recursive: true, force: true });
    });

    test("file_patch pauses for approval", async () => {
      const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-approval-mode-ws-"));
      writeFileSync(join(workspaceRoot, "p.txt"), "old");
      const config = buildConfig(workspaceRoot, "strict-fp", { approvalMode: "strict" });
      const provider = normalizeProvider(config.provider);

      setEchoToolCallingResponse({
        provider,
        text: "",
        toolCalls: [
          { id: "call_p", type: "function", function: { name: "file_patch", arguments: JSON.stringify({ path: "p.txt", oldText: "old", newText: "new" }) } }
        ],
        finishReason: "tool_calls"
      });

      const task = await submitTask(config, "patch p.txt", { mode: "chat" });
      const paused = await waitForTerminal(config, task.id);
      expect(paused.status).toBe("waiting_approval");

      rmSync(workspaceRoot, { recursive: true, force: true });
    });

    test("terminal_exec pauses for approval even on safe commands", async () => {
      const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-approval-mode-ws-"));
      const config = buildConfig(workspaceRoot, "strict-term", { approvalMode: "strict" });
      const provider = normalizeProvider(config.provider);

      setEchoToolCallingResponse({
        provider,
        text: "",
        toolCalls: [
          { id: "call_t", type: "function", function: { name: "terminal_exec", arguments: JSON.stringify({ command: "echo hi" }) } }
        ],
        finishReason: "tool_calls"
      });

      const task = await submitTask(config, "run echo", { mode: "chat" });
      const paused = await waitForTerminal(config, task.id);
      expect(paused.status).toBe("waiting_approval");

      rmSync(workspaceRoot, { recursive: true, force: true });
    });

    test("code_exec pauses for approval", async () => {
      const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-approval-mode-ws-"));
      const config = buildConfig(workspaceRoot, "strict-code", { approvalMode: "strict" });
      const provider = normalizeProvider(config.provider);

      setEchoToolCallingResponse({
        provider,
        text: "",
        toolCalls: [
          { id: "call_c", type: "function", function: { name: "code_exec", arguments: JSON.stringify({ language: "js", code: "console.log(1)" }) } }
        ],
        finishReason: "tool_calls"
      });

      const task = await submitTask(config, "run code", { mode: "chat" });
      const paused = await waitForTerminal(config, task.id);
      expect(paused.status).toBe("waiting_approval");

      rmSync(workspaceRoot, { recursive: true, force: true });
    });

    test("browser_upload_file pauses for approval", async () => {
      const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-approval-mode-ws-"));
      writeFileSync(join(workspaceRoot, "u.txt"), "u");
      const config = buildConfig(workspaceRoot, "strict-upload", { approvalMode: "strict" });
      const provider = normalizeProvider(config.provider);

      // browser_upload_file is a deferred tool, so the model must load it
      // before calling it; calling it directly would (correctly) be nudged by
      // the loop's deferred-tool gate. Load it on the first turn, then call it.
      setEchoToolCallingResponse({
        provider,
        text: "",
        toolCalls: [
          { id: "call_load", type: "function", function: { name: "load_tools", arguments: JSON.stringify({ names: ["browser_upload_file"] }) } }
        ],
        finishReason: "tool_calls"
      });
      setEchoToolCallingResponse({
        provider,
        text: "",
        toolCalls: [
          { id: "call_u", type: "function", function: { name: "browser_upload_file", arguments: JSON.stringify({ ref: "stub-ref", path: "u.txt" }) } }
        ],
        finishReason: "tool_calls"
      });

      const task = await submitTask(config, "upload", { mode: "chat" });
      const paused = await waitForTerminal(config, task.id);
      expect(paused.status).toBe("waiting_approval");

      rmSync(workspaceRoot, { recursive: true, force: true });
    });

    test("browser_download pauses for approval", async () => {
      const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-approval-mode-ws-"));
      const config = buildConfig(workspaceRoot, "strict-download", { approvalMode: "strict" });
      const provider = normalizeProvider(config.provider);

      // Same deferred-tool dance as browser_upload_file: load it first.
      setEchoToolCallingResponse({
        provider,
        text: "",
        toolCalls: [
          { id: "call_load", type: "function", function: { name: "load_tools", arguments: JSON.stringify({ names: ["browser_download"] }) } }
        ],
        finishReason: "tool_calls"
      });
      setEchoToolCallingResponse({
        provider,
        text: "",
        toolCalls: [
          { id: "call_d", type: "function", function: { name: "browser_download", arguments: JSON.stringify({ ref: "@e1" }) } }
        ],
        finishReason: "tool_calls"
      });

      const task = await submitTask(config, "download", { mode: "chat" });
      const paused = await waitForTerminal(config, task.id);
      expect(paused.status).toBe("waiting_approval");

      const state = readState(config.instance);
      const approval = state.authorizations.find((a) => a.taskId === task.id);
      expect(approval?.action).toBe("browser.download");
      expect(approval?.payload.ref).toBe("@e1");

      rmSync(workspaceRoot, { recursive: true, force: true });
    });
  });
  // ---------------- auto ----------------

  describe("auto mode", () => {
    test("file_write auto-approves with approval-mode-auto reason", async () => {
      const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-approval-mode-ws-"));
      const config = buildConfig(workspaceRoot, "auto-fw", { approvalMode: "auto" });
      const provider = normalizeProvider(config.provider);

      setEchoToolCallingResponse({
        provider,
        text: "",
        toolCalls: [
          { id: "call_w", type: "function", function: { name: "file_write", arguments: JSON.stringify({ path: "auto.txt", content: "auto" }) } }
        ],
        finishReason: "tool_calls"
      });
      setEchoToolCallingResponse({ provider, text: "done", toolCalls: [], finishReason: "stop" });

      const task = await submitTask(config, "write auto.txt", { mode: "chat" });
      const finished = await waitForTerminal(config, task.id);
      expect(finished.status).toBe("completed");
      expect(await Bun.file(join(workspaceRoot, "auto.txt")).text()).toBe("auto");

      const state = readState(config.instance);
      const approvals = state.authorizations.filter((a) => a.taskId === task.id);
      expect(approvals).toHaveLength(1);
      expect(approvals[0]?.status).toBe("approved");
      const writeAudits = state.audit.filter((a) => a.action === "file.write" && a.taskId === task.id);
      expect(writeAudits[0]?.evidence?.autoApprovedReason).toBe("approval-mode-auto");

      rmSync(workspaceRoot, { recursive: true, force: true });
    });

    test("file_patch auto-approves with approval-mode-auto reason", async () => {
      const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-approval-mode-ws-"));
      writeFileSync(join(workspaceRoot, "p.txt"), "old");
      const config = buildConfig(workspaceRoot, "auto-fp", { approvalMode: "auto" });
      const provider = normalizeProvider(config.provider);

      setEchoToolCallingResponse({
        provider,
        text: "",
        toolCalls: [
          { id: "call_p", type: "function", function: { name: "file_patch", arguments: JSON.stringify({ path: "p.txt", oldText: "old", newText: "new" }) } }
        ],
        finishReason: "tool_calls"
      });
      setEchoToolCallingResponse({ provider, text: "done", toolCalls: [], finishReason: "stop" });

      const task = await submitTask(config, "patch p.txt", { mode: "chat" });
      const finished = await waitForTerminal(config, task.id);
      expect(finished.status).toBe("completed");
      expect(await Bun.file(join(workspaceRoot, "p.txt")).text()).toBe("new");

      const state = readState(config.instance);
      const patchAudits = state.audit.filter((a) => a.action === "file.patch" && a.taskId === task.id);
      expect(patchAudits[0]?.evidence?.autoApprovedReason).toBe("approval-mode-auto");

      rmSync(workspaceRoot, { recursive: true, force: true });
    });

    test("terminal_exec auto-approves safe commands with approval-mode-auto reason", async () => {
      const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-approval-mode-ws-"));
      const config = buildConfig(workspaceRoot, "auto-term-safe", { approvalMode: "auto" });
      const provider = normalizeProvider(config.provider);

      setEchoToolCallingResponse({
        provider,
        text: "",
        toolCalls: [
          { id: "call_t", type: "function", function: { name: "terminal_exec", arguments: JSON.stringify({ command: "echo safe" }) } }
        ],
        finishReason: "tool_calls"
      });
      setEchoToolCallingResponse({ provider, text: "ran it", toolCalls: [], finishReason: "stop" });

      const task = await submitTask(config, "run echo", { mode: "chat" });
      const finished = await waitForTerminal(config, task.id);
      expect(finished.status).toBe("completed");

      const state = readState(config.instance);
      const execAudits = state.audit.filter((a) => a.action === "terminal.exec" && a.taskId === task.id);
      expect(execAudits[0]?.evidence?.autoApprovedReason).toBe("approval-mode-auto");

      rmSync(workspaceRoot, { recursive: true, force: true });
    });

    test("terminal_exec gates dangerous commands (rm -rf /)", async () => {
      const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-approval-mode-ws-"));
      const config = buildConfig(workspaceRoot, "auto-term-danger", { approvalMode: "auto" });
      const provider = normalizeProvider(config.provider);

      setEchoToolCallingResponse({
        provider,
        text: "",
        toolCalls: [
          { id: "call_t", type: "function", function: { name: "terminal_exec", arguments: JSON.stringify({ command: "rm -rf /" }) } }
        ],
        finishReason: "tool_calls"
      });

      const task = await submitTask(config, "delete world", { mode: "chat" });
      const paused = await waitForTerminal(config, task.id);
      expect(paused.status).toBe("waiting_approval");

      rmSync(workspaceRoot, { recursive: true, force: true });
    });

    test("terminal_exec gates sudo", async () => {
      const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-approval-mode-ws-"));
      const config = buildConfig(workspaceRoot, "auto-term-sudo", { approvalMode: "auto" });
      const provider = normalizeProvider(config.provider);

      setEchoToolCallingResponse({
        provider,
        text: "",
        toolCalls: [
          { id: "call_t", type: "function", function: { name: "terminal_exec", arguments: JSON.stringify({ command: "sudo apt update" }) } }
        ],
        finishReason: "tool_calls"
      });

      const task = await submitTask(config, "elevate", { mode: "chat" });
      const paused = await waitForTerminal(config, task.id);
      expect(paused.status).toBe("waiting_approval");

      rmSync(workspaceRoot, { recursive: true, force: true });
    });

    test("autoApproveCommands allowlist short-circuits the dangerous-pattern blocklist", async () => {
      const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-approval-mode-ws-"));
      // Operator explicitly allows a `sudo` command — the allowlist must
      // win over the built-in `sudo ` block. The command is a
      // non-interactive no-op (`sudo -n true`) rather than a real package
      // command so the auto-approved exec runs instantly and offline; the
      // gate-vs-allowlist decision is identical regardless of the payload.
      const config = buildConfig(workspaceRoot, "auto-allowlist-wins", {
        approvalMode: "auto",
        autoApproveCommands: ["sudo -n true"]
      });
      const provider = normalizeProvider(config.provider);

      setEchoToolCallingResponse({
        provider,
        text: "",
        toolCalls: [
          { id: "call_t", type: "function", function: { name: "terminal_exec", arguments: JSON.stringify({ command: "sudo -n true" }) } }
        ],
        finishReason: "tool_calls"
      });
      setEchoToolCallingResponse({ provider, text: "ok", toolCalls: [], finishReason: "stop" });

      const task = await submitTask(config, "update", { mode: "chat" });
      const finished = await waitForTerminal(config, task.id);
      expect(finished.status).toBe("completed");

      const state = readState(config.instance);
      // Allowlist fast-path bypasses approval-row creation entirely.
      expect(state.authorizations.filter((a) => a.taskId === task.id)).toHaveLength(0);
      const execAudits = state.audit.filter((a) => a.action === "terminal.exec" && a.taskId === task.id);
      expect(execAudits[0]?.evidence?.autoApprovedReason).toBe("sudo -n true");

      rmSync(workspaceRoot, { recursive: true, force: true });
    });

    test("code_exec auto-approves under auto mode (safe snippet)", async () => {
      const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-approval-mode-ws-"));
      const config = buildConfig(workspaceRoot, "auto-code", { approvalMode: "auto" });
      const provider = normalizeProvider(config.provider);

      setEchoToolCallingResponse({
        provider,
        text: "",
        toolCalls: [
          { id: "call_c", type: "function", function: { name: "code_exec", arguments: JSON.stringify({ language: "js", code: "console.log(1+1)" }) } }
        ],
        finishReason: "tool_calls"
      });
      setEchoToolCallingResponse({ provider, text: "ran", toolCalls: [], finishReason: "stop" });

      const task = await submitTask(config, "run code", { mode: "chat" });
      const finished = await waitForTerminal(config, task.id);
      expect(finished.status).toBe("completed");

      const state = readState(config.instance);
      const approvals = state.authorizations.filter((a) => a.taskId === task.id);
      expect(approvals).toHaveLength(1);
      expect(approvals[0]?.status).toBe("approved");
      const execAudits = state.audit.filter((a) => a.action === "terminal.exec" && a.taskId === task.id);
      expect(execAudits[0]?.evidence?.autoApprovedReason).toBe("approval-mode-auto");

      rmSync(workspaceRoot, { recursive: true, force: true });
    });

    test("code_exec gates argv-style dangerous source (Bun.spawn sudo)", async () => {
      // Argv-style payload is invisible to a substring check against
      // the wrapper alone (the wrapper contains "sudo" without the
      // trailing space). The policy seam must check the raw source
      // too and gate.
      const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-approval-mode-ws-"));
      const config = buildConfig(workspaceRoot, "auto-code-argv-sudo", { approvalMode: "auto" });
      const provider = normalizeProvider(config.provider);

      setEchoToolCallingResponse({
        provider,
        text: "",
        toolCalls: [
          { id: "call_c", type: "function", function: { name: "code_exec", arguments: JSON.stringify({ language: "js", code: `Bun.spawn(["sudo", "apt", "update"])` }) } }
        ],
        finishReason: "tool_calls"
      });

      const task = await submitTask(config, "spawn sudo", { mode: "chat" });
      const paused = await waitForTerminal(config, task.id);
      expect(paused.status).toBe("waiting_approval");

      // The approval row's reason should carry the matched-pattern id,
      // not the generic per-action copy.
      const state = readState(config.instance);
      const approvals = state.authorizations.filter((a) => a.taskId === task.id);
      expect(approvals[0]?.reason).toContain("dangerous-pattern:");
      expect(approvals[0]?.reason).toContain("sudo");

      rmSync(workspaceRoot, { recursive: true, force: true });
    });

    test("code_exec gates argv-style dangerous source (python subprocess sudo)", async () => {
      const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-approval-mode-ws-"));
      const config = buildConfig(workspaceRoot, "auto-code-argv-py", { approvalMode: "auto" });
      const provider = normalizeProvider(config.provider);

      setEchoToolCallingResponse({
        provider,
        text: "",
        toolCalls: [
          { id: "call_c", type: "function", function: { name: "code_exec", arguments: JSON.stringify({ language: "python", code: `import subprocess\nsubprocess.run(["sudo", "apt", "update"])` }) } }
        ],
        finishReason: "tool_calls"
      });

      const task = await submitTask(config, "subprocess sudo", { mode: "chat" });
      const paused = await waitForTerminal(config, task.id);
      expect(paused.status).toBe("waiting_approval");

      rmSync(workspaceRoot, { recursive: true, force: true });
    });

    test("approval row reason carries the matched dangerous-pattern id", async () => {
      // Pin Fix 4 directly on the dispatch-level surface: the policy
      // decision must flow into the persisted approval row's reason
      // field so the operator sees WHY they're being asked rather
      // than the generic per-action copy.
      const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-approval-mode-ws-"));
      const config = buildConfig(workspaceRoot, "auto-reason-on-row", { approvalMode: "auto" });
      const provider = normalizeProvider(config.provider);

      setEchoToolCallingResponse({
        provider,
        text: "",
        toolCalls: [
          { id: "call_t", type: "function", function: { name: "terminal_exec", arguments: JSON.stringify({ command: "rm -rf /" }) } }
        ],
        finishReason: "tool_calls"
      });

      const task = await submitTask(config, "wipe", { mode: "chat" });
      const paused = await waitForTerminal(config, task.id);
      expect(paused.status).toBe("waiting_approval");

      const state = readState(config.instance);
      const approvals = state.authorizations.filter((a) => a.taskId === task.id);
      expect(approvals[0]?.reason).toContain("dangerous-pattern:");
      expect(approvals[0]?.reason).toContain("rm-rf-dangerous-target");

      rmSync(workspaceRoot, { recursive: true, force: true });
    });

    test("browser_upload_file auto-approves under auto mode", async () => {
      // Use resolveApprovalPolicy directly here rather than running
      // the full chat-task loop: the actual setInputFiles call would
      // spin up a real playwright browser (no live session exists in
      // unit tests). The policy decision is what this case actually
      // pins — the per-action dispatcher is wired up identically to
      // file.write / file.patch above.
      const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-approval-mode-ws-"));
      const config = buildConfig(workspaceRoot, "auto-upload", { approvalMode: "auto" });
      const { resolveApprovalPolicy } = await import("./policy");
      const decision = resolveApprovalPolicy(config, "browser.upload_file");
      expect(decision).toEqual({ mode: "auto", reason: "approval-mode-auto" });

      rmSync(workspaceRoot, { recursive: true, force: true });
    });
  });
});

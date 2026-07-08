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

  // ---------------- yolo ----------------

  describe("yolo mode", () => {
    test("file_write auto-approves with approval-mode-yolo reason", async () => {
      const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-approval-mode-ws-"));
      const config = buildConfig(workspaceRoot, "yolo-fw", { approvalMode: "yolo" });
      const provider = normalizeProvider(config.provider);

      setEchoToolCallingResponse({
        provider,
        text: "",
        toolCalls: [
          { id: "call_w", type: "function", function: { name: "file_write", arguments: JSON.stringify({ path: "y.txt", content: "y" }) } }
        ],
        finishReason: "tool_calls"
      });
      setEchoToolCallingResponse({ provider, text: "done", toolCalls: [], finishReason: "stop" });

      const task = await submitTask(config, "write y.txt", { mode: "chat" });
      const finished = await waitForTerminal(config, task.id);
      expect(finished.status).toBe("completed");

      const state = readState(config.instance);
      const writeAudits = state.audit.filter((a) => a.action === "file.write" && a.taskId === task.id);
      expect(writeAudits[0]?.evidence?.autoApprovedReason).toBe("approval-mode-yolo");
      const approveAudits = state.audit.filter((a) => a.action === "authorization.approved" && a.taskId === task.id);
      expect(approveAudits[0]?.evidence?.autoApprovedReason).toBe("approval-mode-yolo");

      rmSync(workspaceRoot, { recursive: true, force: true });
    });

    test("terminal_exec auto-approves a command that would have been blocked under auto", async () => {
      // Using `echo would-have-been-sudo: sudo apt` so the substring
      // `sudo ` matches the dangerous list (under auto this would gate)
      // but the actual command is harmless. Under yolo it must auto-run.
      const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-approval-mode-ws-"));
      const config = buildConfig(workspaceRoot, "yolo-term-danger", { approvalMode: "yolo" });
      const provider = normalizeProvider(config.provider);

      setEchoToolCallingResponse({
        provider,
        text: "",
        toolCalls: [
          { id: "call_t", type: "function", function: { name: "terminal_exec", arguments: JSON.stringify({ command: "echo would-have-been-blocked: sudo apt" }) } }
        ],
        finishReason: "tool_calls"
      });
      setEchoToolCallingResponse({ provider, text: "ok", toolCalls: [], finishReason: "stop" });

      const task = await submitTask(config, "run", { mode: "chat" });
      const finished = await waitForTerminal(config, task.id);
      expect(finished.status).toBe("completed");

      const state = readState(config.instance);
      const execAudits = state.audit.filter((a) => a.action === "terminal.exec" && a.taskId === task.id);
      expect(execAudits[0]?.evidence?.autoApprovedReason).toBe("approval-mode-yolo");

      rmSync(workspaceRoot, { recursive: true, force: true });
    });

    test("code_exec auto-approves under yolo", async () => {
      const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-approval-mode-ws-"));
      const config = buildConfig(workspaceRoot, "yolo-code", { approvalMode: "yolo" });
      const provider = normalizeProvider(config.provider);

      setEchoToolCallingResponse({
        provider,
        text: "",
        toolCalls: [
          { id: "call_c", type: "function", function: { name: "code_exec", arguments: JSON.stringify({ language: "js", code: "console.log(2)" }) } }
        ],
        finishReason: "tool_calls"
      });
      setEchoToolCallingResponse({ provider, text: "ran", toolCalls: [], finishReason: "stop" });

      const task = await submitTask(config, "run code", { mode: "chat" });
      const finished = await waitForTerminal(config, task.id);
      expect(finished.status).toBe("completed");

      const state = readState(config.instance);
      const execAudits = state.audit.filter((a) => a.action === "terminal.exec" && a.taskId === task.id);
      expect(execAudits[0]?.evidence?.autoApprovedReason).toBe("approval-mode-yolo");

      rmSync(workspaceRoot, { recursive: true, force: true });
    });

    test("code_exec auto-approves argv-style dangerous source under yolo", async () => {
      // Yolo mode bypasses the dangerous-source check: the operator
      // explicitly opted into "run everything." The approval row
      // still records the bypass reason.
      const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-approval-mode-ws-"));
      const config = buildConfig(workspaceRoot, "yolo-code-argv-sudo", { approvalMode: "yolo" });
      const provider = normalizeProvider(config.provider);

      setEchoToolCallingResponse({
        provider,
        text: "",
        toolCalls: [
          { id: "call_c", type: "function", function: { name: "code_exec", arguments: JSON.stringify({ language: "js", code: `Bun.spawn(["sudo", "-n", "true"])` }) } }
        ],
        finishReason: "tool_calls"
      });
      setEchoToolCallingResponse({ provider, text: "ran", toolCalls: [], finishReason: "stop" });

      const task = await submitTask(config, "spawn sudo yolo", { mode: "chat" });
      const finished = await waitForTerminal(config, task.id);
      // Yolo auto-approves the policy decision. The argv still trips the
      // `sudo` dangerous-source pattern, but `sudo -n true` is
      // non-interactive (never prompts) and a no-op — it terminates in
      // milliseconds on any runner regardless of sudo/network, so the
      // task settles well inside the wait cap. The gate behavior is what
      // we're pinning, not the exec outcome.
      expect(["completed", "failed"]).toContain(finished.status);

      const state = readState(config.instance);
      const approvals = state.authorizations.filter((a) => a.taskId === task.id);
      expect(approvals[0]?.status).toBe("approved");
      const approveAudits = state.audit.filter((a) => a.action === "authorization.approved" && a.approvalId === approvals[0]?.id);
      expect(approveAudits[0]?.evidence?.autoApprovedReason).toBe("approval-mode-yolo");

      rmSync(workspaceRoot, { recursive: true, force: true });
    });

    test("browser_upload_file auto-approves under yolo", async () => {
      // See the auto-mode equivalent above for why this exercises
      // the policy seam directly rather than the full chat-task
      // loop.
      const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-approval-mode-ws-"));
      const config = buildConfig(workspaceRoot, "yolo-upload", { approvalMode: "yolo" });
      const { resolveApprovalPolicy } = await import("./policy");
      const decision = resolveApprovalPolicy(config, "browser.upload_file");
      expect(decision).toEqual({ mode: "auto", reason: "approval-mode-yolo" });

      rmSync(workspaceRoot, { recursive: true, force: true });
    });
  });
  // ---------------- back-compat: legacy dangerouslyAutoApprove alias ----------------

  test("legacy dangerouslyAutoApprove: true behaves like approvalMode: yolo", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-approval-mode-ws-"));
    // No approvalMode set; only the legacy flag. Audit reason should be
    // "approval-mode-yolo" because the policy seam aliases the legacy
    // flag at runtime.
    const config = buildConfig(workspaceRoot, "legacy-flag", { dangerouslyAutoApprove: true });
    const provider = normalizeProvider(config.provider);

    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_w", type: "function", function: { name: "file_write", arguments: JSON.stringify({ path: "legacy.txt", content: "legacy" }) } }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({ provider, text: "ok", toolCalls: [], finishReason: "stop" });

    const task = await submitTask(config, "write legacy.txt", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id);
    expect(finished.status).toBe("completed");

    const state = readState(config.instance);
    const writeAudits = state.audit.filter((a) => a.action === "file.write" && a.taskId === task.id);
    expect(writeAudits[0]?.evidence?.autoApprovedReason).toBe("approval-mode-yolo");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // ---------------- shared invariants ----------------

  test("allowlist match keeps no-approval-row fast path with matched pattern as reason", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-approval-mode-ws-"));
    const config = buildConfig(workspaceRoot, "allowlist-fast", {
      approvalMode: "strict", // even strict respects the allowlist fast path
      autoApproveCommands: ["echo *"]
    });
    const provider = normalizeProvider(config.provider);

    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_t", type: "function", function: { name: "terminal_exec", arguments: JSON.stringify({ command: "echo allowlist-hit" }) } }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({ provider, text: "ok", toolCalls: [], finishReason: "stop" });

    const task = await submitTask(config, "run via allowlist", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id);
    expect(finished.status).toBe("completed");

    const state = readState(config.instance);
    // Allowlist path bypasses approval rows entirely.
    expect(state.authorizations.filter((a) => a.taskId === task.id)).toHaveLength(0);
    const execAudits = state.audit.filter((a) => a.action === "terminal.exec" && a.taskId === task.id);
    expect(execAudits[0]?.evidence?.autoApprovedReason).toBe("echo *");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("decideApproval still completes a paused task end-to-end (human path)", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-approval-mode-ws-"));
    const config = buildConfig(workspaceRoot, "human-path", { approvalMode: "strict" });
    const provider = normalizeProvider(config.provider);

    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_w", type: "function", function: { name: "file_write", arguments: JSON.stringify({ path: "human.txt", content: "human" }) } }
      ],
      finishReason: "tool_calls"
    });
    setEchoToolCallingResponse({ provider, text: "wrote it", toolCalls: [], finishReason: "stop" });

    const task = await submitTask(config, "write human.txt", { mode: "chat" });
    const paused = await waitForTerminal(config, task.id);
    expect(paused.status).toBe("waiting_approval");

    // decideApproval returns at decision durability; the side effect +
    // resume run detached, so wait for the final status (the parked
    // status would satisfy waitForTerminal immediately).
    await decideApproval(config, paused.approvalIds[0]!, "approve");
    const finished = await waitForFinalTerminal(config, task.id);
    expect(finished.status).toBe("completed");

    const state = readState(config.instance);
    const approveAudits = state.audit.filter((a) => a.action === "authorization.approved" && a.taskId === task.id);
    expect(approveAudits[0]?.actor).toBe("user");
    expect(approveAudits[0]?.evidence?.autoApprovedReason).toBeUndefined();

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("rejects file_write that escapes the workspace via in-workspace symlink (yolo)", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-approval-mode-ws-"));
    const outside = mkdtempSync(join(tmpdir(), "gini-approval-mode-outside-"));
    symlinkSync(outside, join(workspaceRoot, "escape"));
    const config = buildConfig(workspaceRoot, "yolo-symlink", { approvalMode: "yolo" });
    const provider = normalizeProvider(config.provider);

    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_w", type: "function", function: { name: "file_write", arguments: JSON.stringify({ path: "escape/pwned.txt", content: "no" }) } }
      ],
      finishReason: "tool_calls"
    });

    const task = await submitTask(config, "escape", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id);
    expect(finished.status).toBe("failed");
    expect(existsSync(join(outside, "pwned.txt"))).toBe(false);
    expect(finished.error ?? "").toContain("escapes workspace");

    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  test("approved side-effect failure fails the task instead of being swallowed", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-approval-mode-ws-"));
    const config = buildConfig(workspaceRoot, "yolo-fail", { approvalMode: "yolo" });
    const provider = normalizeProvider(config.provider);

    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        { id: "call_w", type: "function", function: { name: "file_write", arguments: JSON.stringify({ path: ".", content: "no" }) } }
      ],
      finishReason: "tool_calls"
    });

    const task = await submitTask(config, "write to a dir", { mode: "chat" });
    const finished = await waitForTerminal(config, task.id);
    expect(finished.status).toBe("failed");
    const state = readState(config.instance);
    const approvals = state.authorizations.filter((a) => a.taskId === task.id);
    expect(approvals[0]?.status).toBe("approved");
    const writeAudits = state.audit.filter((a) => a.action === "file.write" && a.taskId === task.id);
    expect(writeAudits).toHaveLength(0);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });
});

describe("imperative dispatch path", () => {
  let root: string;
  let prevState: string | undefined;
  let prevLog: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gini-approval-mode-imp-"));
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
  });

  test("imperative write under auto mode auto-resolves", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-approval-mode-ws-"));
    const config = buildConfig(workspaceRoot, "imp-auto", { approvalMode: "auto" });

    const task = await submitTask(config, "write imp.txt :: from-imperative");
    const finished = await waitForFinalTerminal(config, task.id);
    expect(finished.status).toBe("completed");
    expect(await Bun.file(join(workspaceRoot, "imp.txt")).text()).toBe("from-imperative");

    const state = readState(config.instance);
    const writeAudits = state.audit.filter((a) => a.action === "file.write" && a.taskId === task.id);
    expect(writeAudits[0]?.evidence?.autoApprovedReason).toBe("approval-mode-auto");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("imperative write under strict mode still pauses", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-approval-mode-ws-"));
    const config = buildConfig(workspaceRoot, "imp-strict", { approvalMode: "strict" });

    const task = await submitTask(config, "write s.txt :: wait");
    const paused = await waitForTerminal(config, task.id);
    expect(paused.status).toBe("waiting_approval");
    expect(existsSync(join(workspaceRoot, "s.txt"))).toBe(false);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("imperative shell under auto mode gates dangerous commands", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-approval-mode-ws-"));
    const config = buildConfig(workspaceRoot, "imp-auto-danger", { approvalMode: "auto" });

    // shapeShell needs a shell-like metacharacter to claim the
    // dispatch slot, so use `chmod 777 ./x` which both matches the
    // shape gate (path token) AND the dangerous-pattern blocklist.
    const task = await submitTask(config, "shell chmod 777 ./x");
    const paused = await waitForTerminal(config, task.id);
    expect(paused.status).toBe("waiting_approval");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("imperative shell under auto mode auto-runs safe commands", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-approval-mode-ws-"));
    const config = buildConfig(workspaceRoot, "imp-auto-safe", { approvalMode: "auto" });

    // shapeShell requires a shell-like token; -l flag satisfies it.
    const task = await submitTask(config, "shell echo -n hello");
    const finished = await waitForFinalTerminal(config, task.id);
    expect(finished.status).toBe("completed");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("imperative code under auto mode gates argv-style dangerous source", async () => {
    // The wrapper command `bun -e "..."` is auto-approve-shaped on
    // its face — the dangerous bits are inside the quoted JS source.
    // A wrapper-only policy decision would auto-approve and execute
    // `sudo apt update`. The persisted approval payload must carry
    // `source` so the imperative re-resolve recognizes this as
    // code.exec and scans the raw source for the sudo pattern.
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-approval-mode-ws-"));
    const config = buildConfig(workspaceRoot, "imp-auto-code-argv", { approvalMode: "auto" });

    const task = await submitTask(
      config,
      `code js :: Bun.spawn(["sudo", "apt", "update"])`
    );
    const paused = await waitForTerminal(config, task.id);
    expect(paused.status).toBe("waiting_approval");

    const state = readState(config.instance);
    const approvals = state.authorizations.filter((a) => a.taskId === task.id);
    expect(approvals[0]?.reason).toContain("dangerous-pattern:");
    expect(approvals[0]?.reason).toContain("sudo");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("legacy dangerouslyAutoApprove flag still drives imperative bypass", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-approval-mode-ws-"));
    const config = buildConfig(workspaceRoot, "imp-legacy-flag", { dangerouslyAutoApprove: true });

    const task = await submitTask(config, "write legacy-imp.txt :: from-legacy");
    const finished = await waitForFinalTerminal(config, task.id);
    expect(finished.status).toBe("completed");
    expect(await Bun.file(join(workspaceRoot, "legacy-imp.txt")).text()).toBe("from-legacy");

    const state = readState(config.instance);
    const writeAudits = state.audit.filter((a) => a.action === "file.write" && a.taskId === task.id);
    expect(writeAudits[0]?.evidence?.autoApprovedReason).toBe("approval-mode-yolo");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });
});

describe("resolveAuthorization direct unit", () => {
  let root: string;
  let prevState: string | undefined;
  let prevLog: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gini-approval-mode-direct-"));
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
  });

  test("resolveAuthorization returns the per-action result string the dispatcher relays back to the model", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "gini-approval-mode-ws-"));
    const config = buildConfig(workspaceRoot, "direct-resolve");

    const approval = await mutateState(config.instance, (state) =>
      createAuthorization(state, {
        action: "file.write",
        target: "direct.txt",
        risk: "high",
        reason: "Direct resolveAuthorization unit test.",
        payload: { path: "direct.txt", content: "direct" }
      })
    );

    const { approval: resolved, toolResult } = await resolveAuthorization(config, approval.id, {
      actor: "runtime",
      resumeChatTask: false,
      evidenceExtra: { autoApproved: true, autoApprovedReason: "test-marker" }
    });

    expect(resolved.status).toBe("approved");
    expect(toolResult).toBe("File write completed: direct.txt");
    expect(await Bun.file(join(workspaceRoot, "direct.txt")).text()).toBe("direct");

    const state = readState(config.instance);
    const writeAudits = state.audit.filter((a) => a.action === "file.write" && a.approvalId === approval.id);
    expect(writeAudits[0]?.evidence?.autoApprovedReason).toBe("test-marker");

    rmSync(workspaceRoot, { recursive: true, force: true });
  });
});

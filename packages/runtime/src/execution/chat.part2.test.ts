// Integration tests for the chat session view, focused on the
// waiting-approval placeholder behavior.
//
// Before the fix, syncChatTaskResult accepted waiting_approval as a sync
// trigger and persisted a real ChatMessageRecord with content like
// "Waiting for approval". A short-circuit then prevented updates, so the
// placeholder text never refreshed once the approval was granted and the
// task completed.
//
// After the fix:
//   - syncChatTaskResult only writes a real assistant message for
//     completed / failed / cancelled.
//   - waiting_approval is rendered as a synthetic (ephemeral) assistant
//     message synthesized in getChatSession; once the task transitions to
//     completed and the real synced message lands, the synthetic one
//     disappears and the UI shows the final summary.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProviderAuthError,
  clearEchoStructuredResponses,
  clearEchoToolCallingResponses,
  setEchoStructuredResponse,
  setEchoToolCallingResponse,
  normalizeProvider
} from "../provider";
import { decideApproval, failTask } from "../agent";
import { __setTransformersLoaderForTests } from "../stt";
import { createChatMessage, createChatSession, insertChatBlock, listChatBlocks, mutateState, readState } from "../state";
import { storeUpload } from "../state/uploads";
import { createScheduledJob } from "../jobs";
import {
  getChatSession,
  listChatSessions,
  submitChatMessage as submitChatMessageRaw,
  submitThreadReply,
  syncChatTaskResult,
  createChat,
  deleteChat
} from "./chat";
import { settleSubmittedChatMessage, type SettledDispatch } from "./chat-test-support";
import type { Authorization, RuntimeConfig, SetupRequest, Task } from "../types";

// Most tests here submit on idle sessions, which always run immediately.
// Settle the echo-first ack into the dispatched turn and narrow to the
// run-now branch so the existing `.taskId` reads stay typed (a queued result
// here is a test-setup bug). See ADR chat-message-queue.md.
async function submitChatMessage(
  ...args: Parameters<typeof submitChatMessageRaw>
): Promise<Extract<SettledDispatch, { taskId: string }>> {
  const result = await submitChatMessageRaw(...args);
  const settled = await settleSubmittedChatMessage(
    args[0],
    args[1],
    result,
    String(args[2].content ?? "")
  );
  if ("queued" in settled) throw new Error("expected run-now submission, got queued");
  return settled;
}

// Minimal valid 16 kHz mono 16-bit PCM WAV so decodeWav succeeds and the
// stubbed transcriber actually runs (a malformed buffer would fail in the
// decoder before the provider is reached).
function makeWav(samples: number[]): Uint8Array {
  const dataLength = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);
  const writeTag = (offset: number, tag: string) => {
    for (let i = 0; i < tag.length; i++) view.setUint8(offset + i, tag.charCodeAt(i));
  };
  writeTag(0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeTag(8, "WAVE");
  writeTag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 16000 * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeTag(36, "data");
  view.setUint32(40, dataLength, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i]!, true);
  return new Uint8Array(buffer);
}

function buildConfig(workspaceRoot: string, instance: string): RuntimeConfig {
  return {
    instance,
    port: 7340,
    token: "test",
    provider: { name: "echo", model: "" },
    workspaceRoot,
    stateRoot: process.env.GINI_STATE_ROOT ?? "/tmp/gini-chat-test",
    logRoot: process.env.GINI_LOG_ROOT ?? "/tmp/gini-chat-test-logs",
    // Pin the gated path so these waiting-approval placeholder tests
    // remain meaningful under the new default-auto approval policy.
    approvalMode: "strict"
  };
}

async function waitForStatus(
  config: RuntimeConfig,
  taskId: string,
  match: (task: Task) => boolean,
  timeoutMs = 5000
): Promise<Task> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = readState(config.instance);
    const task = state.tasks.find((t) => t.id === taskId);
    if (task && match(task)) return task;
    await Bun.sleep(20);
  }
  throw new Error(`Task ${taskId} did not reach the expected state within ${timeoutMs}ms`);
}

// listChatSessions enriches each session with `pendingApprovalCount` so the
// sidebar can render an "awaiting approval" indicator without a second
// round-trip. The count joins state.authorizations and state.setupRequests
// (both pending) against the session's taskIds.
describe("chat list pendingApprovalCount enrichment", () => {
  let root: string;
  let workspaceRoot: string;
  let prevState: string | undefined;
  let prevLog: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gini-chat-list-"));
    workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-list-ws-"));
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
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  async function seedTask(config: RuntimeConfig, sessionId: string, taskId: string): Promise<void> {
    await mutateState(config.instance, (state) => {
      const task: Task = {
        id: taskId,
        title: taskId,
        input: "",
        status: "running",
        instance: state.instance,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tracePath: "",
        auditIds: [],
        approvalIds: [],
        skillIds: [],
        chatSessionId: sessionId
      };
      state.tasks.push(task);
      const sessionRecord = state.chatSessions.find((s) => s.id === sessionId);
      if (sessionRecord) sessionRecord.taskIds.push(taskId);
    });
  }

  async function seedAuthorization(
    config: RuntimeConfig,
    overrides: Partial<Authorization> & Pick<Authorization, "id" | "taskId" | "status">
  ): Promise<void> {
    await mutateState(config.instance, (state) => {
      const at = new Date().toISOString();
      const authorization: Authorization = {
        instance: state.instance,
        createdAt: at,
        updatedAt: at,
        action: "file.write",
        target: "out.txt",
        risk: "medium",
        reason: "test authorization",
        payload: {},
        ...overrides
      };
      state.authorizations.push(authorization);
    });
  }

  async function seedSetupRequest(
    config: RuntimeConfig,
    overrides: Partial<SetupRequest> & Pick<SetupRequest, "id" | "taskId" | "status">
  ): Promise<void> {
    await mutateState(config.instance, (state) => {
      const at = new Date().toISOString();
      const setupRequest: SetupRequest = {
        instance: state.instance,
        createdAt: at,
        updatedAt: at,
        action: "browser.connect",
        target: "https://example.com",
        reason: "test setup",
        payload: {},
        ...overrides
      };
      state.setupRequests.push(setupRequest);
    });
  }

  test("returns 0 when the session has no approvals", async () => {
    const config = buildConfig(workspaceRoot, "chat-list-no-approvals");
    const session = await createChat(config, { title: "plain" });

    const rows = listChatSessions(config);
    const row = rows.find((s) => s.id === session.id);
    expect(row?.pendingApprovalCount).toBe(0);
  });

  test("counts a pending Authorization linked to one of the session's tasks", async () => {
    const config = buildConfig(workspaceRoot, "chat-list-auth-pending");
    const session = await createChat(config, { title: "needs auth" });
    await seedTask(config, session.id, "task_auth_1");
    await seedAuthorization(config, { id: "authz_1", taskId: "task_auth_1", status: "pending" });

    const row = listChatSessions(config).find((s) => s.id === session.id);
    expect(row?.pendingApprovalCount).toBe(1);
  });

  test("counts a pending SetupRequest linked to one of the session's tasks", async () => {
    const config = buildConfig(workspaceRoot, "chat-list-setup-pending");
    const session = await createChat(config, { title: "needs setup" });
    await seedTask(config, session.id, "task_setup_1");
    await seedSetupRequest(config, { id: "setup_1", taskId: "task_setup_1", status: "pending" });

    const row = listChatSessions(config).find((s) => s.id === session.id);
    expect(row?.pendingApprovalCount).toBe(1);
  });

  test("sums pending Authorizations and SetupRequests on the same session", async () => {
    const config = buildConfig(workspaceRoot, "chat-list-both-pending");
    const session = await createChat(config, { title: "needs both" });
    await seedTask(config, session.id, "task_both_1");
    await seedTask(config, session.id, "task_both_2");
    await seedAuthorization(config, { id: "authz_a", taskId: "task_both_1", status: "pending" });
    await seedAuthorization(config, { id: "authz_b", taskId: "task_both_2", status: "pending" });
    await seedSetupRequest(config, { id: "setup_a", taskId: "task_both_1", status: "pending" });

    const row = listChatSessions(config).find((s) => s.id === session.id);
    expect(row?.pendingApprovalCount).toBe(3);
  });

  test("ignores resolved Authorizations and SetupRequests", async () => {
    const config = buildConfig(workspaceRoot, "chat-list-resolved");
    const session = await createChat(config, { title: "resolved" });
    await seedTask(config, session.id, "task_resolved_1");
    await seedAuthorization(config, { id: "authz_approved", taskId: "task_resolved_1", status: "approved" });
    await seedAuthorization(config, { id: "authz_denied", taskId: "task_resolved_1", status: "denied" });
    await seedSetupRequest(config, { id: "setup_completed", taskId: "task_resolved_1", status: "completed" });
    await seedSetupRequest(config, { id: "setup_cancelled", taskId: "task_resolved_1", status: "cancelled" });

    const row = listChatSessions(config).find((s) => s.id === session.id);
    expect(row?.pendingApprovalCount).toBe(0);
  });

  test("ignores approvals whose taskId is not in the session's taskIds", async () => {
    const config = buildConfig(workspaceRoot, "chat-list-other-session");
    const target = await createChat(config, { title: "target" });
    const other = await createChat(config, { title: "other" });
    await seedTask(config, other.id, "task_other_1");
    await seedAuthorization(config, { id: "authz_other", taskId: "task_other_1", status: "pending" });
    await seedSetupRequest(config, { id: "setup_other", taskId: "task_other_1", status: "pending" });

    const rows = listChatSessions(config);
    expect(rows.find((s) => s.id === target.id)?.pendingApprovalCount).toBe(0);
    expect(rows.find((s) => s.id === other.id)?.pendingApprovalCount).toBe(2);
  });

  test("truncates lastMessagePreview when the latest block exceeds the cap", async () => {
    // Sibling-branch coverage for the existing preview-truncation ternary
    // — exercises the long-text path that runs alongside the new
    // pendingApprovalCount enrichment in the same map().
    const config = buildConfig(workspaceRoot, "chat-list-long-preview");
    const session = await createChat(config, { title: "long preview" });
    const longText = "x".repeat(300);
    insertChatBlock(config.instance, {
      kind: "user_text",
      sessionId: session.id,
      text: longText,
      agentId: null
    });

    const row = listChatSessions(config).find((s) => s.id === session.id);
    expect(row?.lastMessagePreview).toBeTruthy();
    expect(row?.lastMessagePreview?.endsWith("…")).toBe(true);
    expect(row?.lastMessagePreview?.length).toBeLessThan(longText.length);
  });

  test("ignores approvals with no taskId", async () => {
    const config = buildConfig(workspaceRoot, "chat-list-no-task-link");
    const session = await createChat(config, { title: "untargeted" });
    await mutateState(config.instance, (state) => {
      const at = new Date().toISOString();
      state.authorizations.push({
        id: "authz_no_task",
        instance: state.instance,
        status: "pending",
        createdAt: at,
        updatedAt: at,
        action: "file.write",
        target: "out.txt",
        risk: "low",
        reason: "no task linkage",
        payload: {}
      });
      state.setupRequests.push({
        id: "setup_no_task",
        instance: state.instance,
        status: "pending",
        createdAt: at,
        updatedAt: at,
        action: "browser.connect",
        target: "https://example.com",
        reason: "no task linkage",
        payload: {}
      });
    });

    const row = listChatSessions(config).find((s) => s.id === session.id);
    expect(row?.pendingApprovalCount).toBe(0);
  });
});

// Client-surface resolution on message submit. UI clients tag each POST with
// a `client` body field; bridge sessions derive the surface from
// `source.kind`; anything else resolves to unknown (no clientSurface on the
// task) — never a submit error. See ADR client-surface-context.md.
describe("chat message client surface", () => {
  let root: string;
  let workspaceRoot: string;
  let prevState: string | undefined;
  let prevLog: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gini-chat-surface-"));
    workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-surface-ws-"));
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
    rmSync(workspaceRoot, { recursive: true, force: true });
    clearEchoToolCallingResponses();
  });

  function stubTurn(config: RuntimeConfig): void {
    setEchoToolCallingResponse({
      provider: normalizeProvider(config.provider),
      text: "ok",
      toolCalls: [],
      finishReason: "stop"
    });
  }

  function taskSurface(config: RuntimeConfig, taskId: string): string | undefined {
    return readState(config.instance).tasks.find((t) => t.id === taskId)?.clientSurface;
  }

  test("stores each valid client value on the spawned task", async () => {
    const config = buildConfig(workspaceRoot, "chat-surface-valid");
    for (const client of ["web", "mobile", "cli"] as const) {
      stubTurn(config);
      const session = await createChat(config, { title: `surface-${client}` });
      const submitted = await submitChatMessage(config, session.id, { content: "hi", client });
      expect(taskSurface(config, submitted.taskId)).toBe(client);
    }
  });

  test("treats an unrecognized client value as unknown without rejecting the message", async () => {
    const config = buildConfig(workspaceRoot, "chat-surface-invalid");
    stubTurn(config);
    const session = await createChat(config, { title: "surface-invalid" });
    const submitted = await submitChatMessage(config, session.id, { content: "hi", client: "smartwatch" });
    expect(taskSurface(config, submitted.taskId)).toBeUndefined();
  });

  test("treats an absent client field as unknown", async () => {
    const config = buildConfig(workspaceRoot, "chat-surface-absent");
    stubTurn(config);
    const session = await createChat(config, { title: "surface-absent" });
    const submitted = await submitChatMessage(config, session.id, { content: "hi" });
    expect(taskSurface(config, submitted.taskId)).toBeUndefined();
  });

  test("stamps the client surface on a thread reply's spawned task", async () => {
    const config = buildConfig(workspaceRoot, "chat-surface-thread");
    stubTurn(config);
    const session = await createChat(config, { title: "surface-thread" });
    // Root the new thread on a main-chat block — the message being
    // branched from.
    const parent = insertChatBlock(config.instance, {
      kind: "user_text",
      sessionId: session.id,
      text: "original message",
      agentId: null
    });
    const submitted = await submitThreadReply(config, session.id, "thread_surface", {
      content: "reply from my phone",
      client: "mobile",
      parentBlockId: parent.id
    });
    if ("queued" in submitted) throw new Error("idle session should run the thread reply now");
    expect(taskSurface(config, submitted.taskId)).toBe("mobile");
  });

  test("derives the surface from a bridge session source without a client field", async () => {
    const config = buildConfig(workspaceRoot, "chat-surface-bridge");
    const sources = [
      { kind: "telegram" as const, bridgeId: "b1", chatId: 7, target: "7" },
      { kind: "discord" as const, bridgeId: "b2", channelId: "c1", target: "c1" },
      { kind: "openclaw" as const, openclawSessionId: "s1", openclawAgentId: "a1" }
    ];
    for (const source of sources) {
      stubTurn(config);
      const session = await mutateState(config.instance, (state) =>
        createChatSession(state, `bridge-${source.kind}`, source)
      );
      const submitted = await submitChatMessage(config, session.id, { content: "hi" });
      expect(taskSurface(config, submitted.taskId)).toBe(source.kind);
    }
  });
});

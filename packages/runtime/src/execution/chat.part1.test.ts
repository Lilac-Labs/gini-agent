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

describe("chat session waiting-approval placeholder", () => {
  let root: string;
  let workspaceRoot: string;
  let prevState: string | undefined;
  let prevLog: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gini-chat-svc-"));
    workspaceRoot = mkdtempSync(join(tmpdir(), "gini-chat-svc-ws-"));
    prevState = process.env.GINI_STATE_ROOT;
    prevLog = process.env.GINI_LOG_ROOT;
    process.env.GINI_STATE_ROOT = root;
    process.env.GINI_LOG_ROOT = `${root}-logs`;
    clearEchoToolCallingResponses();
    clearEchoStructuredResponses();
  });

  afterEach(() => {
    if (prevState === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = prevState;
    if (prevLog === undefined) delete process.env.GINI_LOG_ROOT;
    else process.env.GINI_LOG_ROOT = prevLog;
    rmSync(root, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
    clearEchoToolCallingResponses();
    clearEchoStructuredResponses();
  });

  test("synthesizes a placeholder for waiting_approval and swaps it for the real summary on completion", async () => {
    const config = buildConfig(workspaceRoot, "chat-placeholder-fix");
    const provider = normalizeProvider(config.provider);

    // Turn 1: model requests an approval-gated tool (file write).
    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        {
          id: "call_w",
          type: "function",
          function: { name: "file_write", arguments: JSON.stringify({ path: "out.txt", content: "ok" }) }
        }
      ],
      finishReason: "tool_calls"
    });
    // Turn 2 (after approval resolves): model emits the final answer.
    setEchoToolCallingResponse({
      provider,
      text: "All done.",
      toolCalls: [],
      finishReason: "stop"
    });

    const session = await createChat(config, { title: "placeholder-test" });
    const submission = await submitChatMessage(config, session.id, {
      content: "please write out.txt"
    });
    const taskId = submission.taskId;

    const paused = await waitForStatus(config, taskId, (t) => t.status === "waiting_approval");
    expect(paused.status).toBe("waiting_approval");

    // No real persisted assistant summary ChatMessageRecord while
    // waiting_approval. The model-facing tool_transcript rows (the assistant
    // tool_calls row persisted before the pause) are excluded — they are
    // replay state, not the terminal summary the UI renders.
    let stateNow = readState(config.instance);
    let realAssistant = stateNow.chatMessages.find(
      (m) => m.taskId === taskId && m.role === "assistant" && m.kind !== "tool_transcript"
    );
    expect(realAssistant).toBeUndefined();

    // getChatSession should still surface a placeholder via the synthetic
    // path so the UI can show "Waiting for approval".
    let view = getChatSession(config, session.id);
    let assistantMsgs = view.messages.filter((m) => m.role === "assistant" && m.taskId === taskId);
    expect(assistantMsgs).toHaveLength(1);
    expect(assistantMsgs[0]?.id).toBe(`${taskId}-streaming`);
    expect(assistantMsgs[0]?.content).toContain("Waiting for approval");

    // Calling syncChatTaskResult while waiting_approval should now refuse
    // — the real synced message must wait until the task is terminal.
    await expect(syncChatTaskResult(config, session.id, taskId)).rejects.toThrow(/not ready/);

    // Approve the action; the loop completes the task with a real summary.
    const approvalId = paused.approvalIds[0]!;
    await decideApproval(config, approvalId, "approve");
    await waitForStatus(config, taskId, (t) => t.status === "completed");

    // Now sync writes the real assistant message with the final summary.
    await syncChatTaskResult(config, session.id, taskId);

    stateNow = readState(config.instance);
    realAssistant = stateNow.chatMessages.find(
      (m) => m.taskId === taskId && m.role === "assistant" && m.kind !== "tool_transcript"
    );
    expect(realAssistant).toBeDefined();
    expect(realAssistant?.content).toBe("All done.");

    // getChatSession returns only the real assistant message — the
    // synthetic placeholder has dropped because the task is terminal AND
    // a real synced message exists.
    view = getChatSession(config, session.id);
    assistantMsgs = view.messages.filter((m) => m.role === "assistant" && m.taskId === taskId);
    expect(assistantMsgs).toHaveLength(1);
    expect(assistantMsgs[0]?.id).not.toBe(`${taskId}-streaming`);
    expect(assistantMsgs[0]?.content).toBe("All done.");
  });

  test("surfaces the connector.request approval reason as a durable assistant bubble (kind:approval_reason)", async () => {
    // requestConnectorTool persists the model's `reason` as a real
    // ChatMessageRecord at approval-creation time, tagged kind:"approval_reason".
    // This durable row is what the user sees as the chat bubble above the
    // inline form (with rendered URLs), AND what stays in history after the
    // form is submitted and the approval resolves.
    //
    // Bypassing dispatchToolCall in this test — we set up the state shape
    // dispatchToolCall produces and assert getChatSession returns the
    // persisted row (not a synthesized placeholder) and that the row
    // carries the kind tag.
    const config = buildConfig(workspaceRoot, "chat-placeholder-connector");

    const session = await createChat(config, { title: "connector-placeholder" });

    const reasonText = [
      "To connect Google OAuth Desktop client, you need a Client ID and Client secret.",
      "",
      "1. Open https://console.cloud.google.com/apis/credentials",
      "2. Create OAuth client ID -> Desktop app",
      "3. Paste the values below."
    ].join("\n");

    const taskId = await mutateState(config.instance, (state) => {
      const task: Task = {
        id: "task_connreq",
        title: "connect provider",
        input: "please connect google",
        status: "waiting_approval",
        instance: state.instance,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tracePath: "",
        auditIds: [],
        approvalIds: [],
        skillIds: [],
        chatSessionId: session.id,
        currentStep: "running tool"
      };
      state.tasks.push(task);
      const sessionRecord = state.chatSessions.find((s) => s.id === session.id);
      if (sessionRecord) sessionRecord.taskIds.push(task.id);
      // connector.request is a SetupRequest (user-actor) — no risk field.
      const approval = {
        id: "approval_connreq",
        instance: state.instance,
        status: "pending" as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        taskId: task.id,
        action: "connector.request" as const,
        target: "google",
        reason: reasonText,
        payload: {
          provider: "google",
          providerLabel: "Google OAuth Desktop client",
          fields: [
            { name: "client_id", label: "Client ID", secret: false, required: true },
            { name: "client_secret", label: "Client secret", secret: true, required: true }
          ]
        }
      };
      state.setupRequests.push(approval);
      task.approvalIds.push(approval.id);
      // Mirror what requestConnectorTool does at dispatch time: persist
      // the reason as a real assistant message tagged approval_reason.
      createChatMessage(state, {
        sessionId: session.id,
        role: "assistant",
        content: reasonText,
        taskId: task.id,
        kind: "approval_reason"
      });
      return task.id;
    });

    const view = getChatSession(config, session.id);
    const assistantMsgs = view.messages.filter((m) => m.role === "assistant" && m.taskId === taskId);
    // Exactly one assistant row for this task while waiting_approval:
    // the persisted approval_reason. No synthesized placeholder layered
    // on top of it.
    expect(assistantMsgs).toHaveLength(1);
    expect(assistantMsgs[0]?.id).toMatch(/^msg_/);
    expect(assistantMsgs[0]?.kind).toBe("approval_reason");
    expect(assistantMsgs[0]?.content).toBe(reasonText);
    expect(assistantMsgs[0]?.content).toContain("https://console.cloud.google.com/apis/credentials");
  });

  test("approval_reason bubble survives task progress: partial-summary streaming renders alongside it", async () => {
    // After the user submits the inline form, the task resumes and the
    // model starts working again (gws install, gws auth login, etc.).
    // partialSummary on the task should still synthesize a streaming
    // bubble — the approval_reason row must NOT suppress it, otherwise
    // the user sees no progress until the task finishes.
    const config = buildConfig(workspaceRoot, "chat-placeholder-progress");
    const session = await createChat(config, { title: "approval-then-progress" });
    const reasonText = "Last step: paste your Client ID and Client Secret below.";

    const taskId = await mutateState(config.instance, (state) => {
      const task: Task = {
        id: "task_progress",
        title: "post-approval progress",
        input: "calendar today",
        status: "running",
        instance: state.instance,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tracePath: "",
        auditIds: [],
        approvalIds: [],
        skillIds: [],
        chatSessionId: session.id,
        partialSummary: "Running gws auth login..."
      };
      state.tasks.push(task);
      const sessionRecord = state.chatSessions.find((s) => s.id === session.id);
      if (sessionRecord) sessionRecord.taskIds.push(task.id);
      createChatMessage(state, {
        sessionId: session.id,
        role: "assistant",
        content: reasonText,
        taskId: task.id,
        kind: "approval_reason"
      });
      return task.id;
    });

    const view = getChatSession(config, session.id);
    const assistantMsgs = view.messages.filter((m) => m.role === "assistant" && m.taskId === taskId);
    // Two assistant rows: the persisted approval_reason AND the
    // synthesized partial-summary placeholder.
    expect(assistantMsgs).toHaveLength(2);
    const reasonRow = assistantMsgs.find((m) => m.kind === "approval_reason");
    const streamingRow = assistantMsgs.find((m) => m.id === `${taskId}-streaming`);
    expect(reasonRow?.content).toBe(reasonText);
    expect(streamingRow?.content).toBe("Running gws auth login...");
  });

  test("falls back to the generic placeholder when no connector.request approval is linked", async () => {
    // Sanity check: other approval types (e.g. file.write) still get the
    // existing currentStep / "Waiting for approval" placeholder. We don't
    // want this fix to silently change other approval flows.
    const config = buildConfig(workspaceRoot, "chat-placeholder-fallback");

    const session = await createChat(config, { title: "fallback-placeholder" });

    const taskId = await mutateState(config.instance, (state) => {
      const task: Task = {
        id: "task_filewrite",
        title: "write a file",
        input: "write x.txt",
        status: "waiting_approval",
        instance: state.instance,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tracePath: "",
        auditIds: [],
        approvalIds: [],
        skillIds: [],
        chatSessionId: session.id,
        currentStep: "preparing file write"
      };
      state.tasks.push(task);
      const sessionRecord = state.chatSessions.find((s) => s.id === session.id);
      if (sessionRecord) sessionRecord.taskIds.push(task.id);
      const approval = {
        id: "approval_filewrite",
        instance: state.instance,
        status: "pending" as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        taskId: task.id,
        action: "file.write" as const,
        target: "x.txt",
        risk: "medium" as const,
        reason: "About to write a file",
        payload: { path: "x.txt", content: "x" }
      };
      state.authorizations.push(approval);
      task.approvalIds.push(approval.id);
      return task.id;
    });

    const view = getChatSession(config, session.id);
    const assistantMsgs = view.messages.filter((m) => m.role === "assistant" && m.taskId === taskId);
    expect(assistantMsgs).toHaveLength(1);
    // file.write approvals don't trigger the new branch — falls through to
    // currentStep, exactly as before.
    expect(assistantMsgs[0]?.content).toBe("preparing file write");
  });

  test("syncChatTaskResult writes the failure message for failed tasks", async () => {
    // Sanity check that the trimmed sync-trigger set still routes
    // failures into a real assistant message (was always the case;
    // verifying we didn't accidentally remove failed too).
    const config = buildConfig(workspaceRoot, "chat-placeholder-fail-sync");
    const provider = normalizeProvider(config.provider);

    setEchoToolCallingResponse({
      provider,
      text: "",
      toolCalls: [
        {
          id: "call_w",
          type: "function",
          function: { name: "file_write", arguments: JSON.stringify({ path: "x.txt", content: "X" }) }
        }
      ],
      finishReason: "tool_calls"
    });

    const session = await createChat(config, { title: "fail-sync" });
    const submission = await submitChatMessage(config, session.id, { content: "do it" });
    const paused = await waitForStatus(config, submission.taskId, (t) => t.status === "waiting_approval");
    const approvalId = paused.approvalIds[0]!;
    // Deny → failTask runs.
    await decideApproval(config, approvalId, "deny");
    const failed = await waitForStatus(config, submission.taskId, (t) => t.status === "failed");
    expect(failed.status).toBe("failed");

    const message = await syncChatTaskResult(config, session.id, submission.taskId);
    expect(message).not.toBeNull();
    expect(message?.role).toBe("assistant");
    expect(message?.content).toContain("Approval denied");
  });

  test("transcribes an audio-only message and persists the voice attachment", async () => {
    const config = buildConfig(workspaceRoot, "chat-voice-message");
    const provider = normalizeProvider(config.provider);
    setEchoToolCallingResponse({ provider, text: "Heard you.", toolCalls: [], finishReason: "stop" });

    // Echo STT keeps the test fast + offline — no whisper download.
    process.env.GINI_STT_PROVIDER = "echo";
    try {
      const ref = storeUpload(config.instance, new Uint8Array([1, 2, 3, 4]), "audio/wav", "voice.wav");
      const session = await createChat(config, { title: "voice" });
      const submission = await submitChatMessage(config, session.id, {
        content: "",
        audio: { id: ref.id, mimeType: ref.mimeType, size: ref.size, durationMs: 1200 }
      });
      await waitForStatus(config, submission.taskId, (t) => t.status === "completed");

      const blocks = listChatBlocks(config.instance, session.id);
      const userBlock = blocks.find((b) => b.kind === "user_text");
      expect(userBlock?.kind).toBe("user_text");
      if (userBlock?.kind === "user_text") {
        expect(userBlock.text).toBe("[voice message]");
        expect(userBlock.audio?.id).toBe(ref.id);
        expect(userBlock.audio?.mimeType).toBe("audio/wav");
        expect(userBlock.audio?.durationMs).toBe(1200);
      }

      const stateNow = readState(config.instance);
      const userMsg = stateNow.chatMessages.find((m) => m.role === "user" && m.taskId === submission.taskId);
      expect(userMsg?.content).toBe("[voice message]");
      expect(userMsg?.audio?.id).toBe(ref.id);
    } finally {
      delete process.env.GINI_STT_PROVIDER;
    }
  });

  test("rejects an audio attachment whose stored upload is not audio/*", async () => {
    const config = buildConfig(workspaceRoot, "chat-voice-mime-mismatch");

    // A client can claim mimeType audio/wav on the request while pointing at a
    // non-audio upload id. Validation reads the STORED mime, so the mismatched
    // upload is rejected before any task or block is created.
    process.env.GINI_STT_PROVIDER = "echo";
    try {
      const ref = storeUpload(config.instance, new Uint8Array([1, 2, 3, 4]), "image/png", "not-audio.png");
      const session = await createChat(config, { title: "voice-mime" });
      await expect(
        submitChatMessage(config, session.id, {
          content: "here is a clip",
          audio: { id: ref.id, mimeType: "audio/wav", size: ref.size, durationMs: 1200 }
        })
      ).rejects.toThrow(/audio attachment must be audio\/\*/);

      const stateNow = readState(config.instance);
      expect(stateNow.tasks).toHaveLength(0);
      expect(stateNow.chatMessages).toHaveLength(0);
      expect(listChatBlocks(config.instance, session.id)).toHaveLength(0);
    } finally {
      delete process.env.GINI_STT_PROVIDER;
    }
  });

  test("rejects a voice message when transcription fails, creating no task or block", async () => {
    const config = buildConfig(workspaceRoot, "chat-voice-stt-failure");

    // Force the local provider to fail at load via the transformers seam — a
    // transcription error must surface to the client, not silently land an
    // empty-prompt task.
    process.env.GINI_STT_PROVIDER = "local";
    __setTransformersLoaderForTests(async () => {
      throw new Error("model load failed");
    });
    try {
      const ref = storeUpload(config.instance, makeWav([0, 1, -1]), "audio/wav", "voice.wav");
      const session = await createChat(config, { title: "voice-fail" });
      await expect(
        submitChatMessage(config, session.id, {
          content: "",
          audio: { id: ref.id, mimeType: ref.mimeType, size: ref.size, durationMs: 1200 }
        })
      ).rejects.toThrow(/Could not transcribe/);

      const stateNow = readState(config.instance);
      expect(stateNow.tasks).toHaveLength(0);
      expect(stateNow.chatMessages).toHaveLength(0);
      expect(listChatBlocks(config.instance, session.id)).toHaveLength(0);
    } finally {
      delete process.env.GINI_STT_PROVIDER;
      __setTransformersLoaderForTests(null);
    }
  });

  test("rejects a silent voice message (empty transcript) with no speech detected", async () => {
    const config = buildConfig(workspaceRoot, "chat-voice-silent");

    // A successful transcription that yields no words (silence) must not
    // create a do-nothing task either.
    process.env.GINI_STT_PROVIDER = "local";
    __setTransformersLoaderForTests(async () => ({
      env: {},
      pipeline: async () => async () => ({ text: "   " })
    }));
    try {
      const ref = storeUpload(config.instance, makeWav([0, 1, -1]), "audio/wav", "voice.wav");
      const session = await createChat(config, { title: "voice-silent" });
      await expect(
        submitChatMessage(config, session.id, {
          content: "",
          audio: { id: ref.id, mimeType: ref.mimeType, size: ref.size, durationMs: 800 }
        })
      ).rejects.toThrow(/No speech detected/);

      const stateNow = readState(config.instance);
      expect(stateNow.tasks).toHaveLength(0);
      expect(stateNow.chatMessages).toHaveLength(0);
      expect(listChatBlocks(config.instance, session.id)).toHaveLength(0);
    } finally {
      delete process.env.GINI_STT_PROVIDER;
      __setTransformersLoaderForTests(null);
    }
  });

  test("rejects a voice message whose session is deleted during transcription, creating no task or block", async () => {
    const config = buildConfig(workspaceRoot, "chat-voice-deleted-mid-stt");

    const session = await createChat(config, { title: "voice-deleted" });

    // Transcription can run a long time (the first voice message downloads
    // the model); the chat can be deleted in that window. Simulate it by
    // deleting the session from inside the transcriber await, then assert the
    // submit rejects and lands nothing for the gone session.
    process.env.GINI_STT_PROVIDER = "local";
    __setTransformersLoaderForTests(async () => ({
      env: {},
      pipeline: async () => async () => {
        await deleteChat(config, session.id);
        return { text: "hello there" };
      }
    }));
    try {
      const ref = storeUpload(config.instance, makeWav([0, 1, -1]), "audio/wav", "voice.wav");
      await expect(
        submitChatMessage(config, session.id, {
          content: "",
          audio: { id: ref.id, mimeType: ref.mimeType, size: ref.size, durationMs: 900 }
        })
      ).rejects.toThrow(/Chat session not found/);

      const stateNow = readState(config.instance);
      expect(stateNow.tasks).toHaveLength(0);
      expect(stateNow.chatMessages).toHaveLength(0);
      expect(listChatBlocks(config.instance, session.id)).toHaveLength(0);
    } finally {
      delete process.env.GINI_STT_PROVIDER;
      __setTransformersLoaderForTests(null);
    }
  });

  test("failTask surfaces a re-auth note when the provider credential expired", async () => {
    // A turn that dies on an expired/invalid provider token must render an
    // actionable system note (provider name + re-auth metadata) rather than
    // passing the raw provider line through verbatim. See issue #205.
    const config = {
      ...buildConfig(workspaceRoot, "chat-fail-auth-note"),
      provider: { name: "codex" as const, model: "gpt-5-codex" }
    };
    const session = await createChat(config, { title: "auth-fail" });
    const taskId = "task_authfail";
    await mutateState(config.instance, (state) => {
      const task: Task = {
        id: taskId,
        title: "chat turn",
        input: "do it",
        status: "running",
        instance: state.instance,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tracePath: "",
        auditIds: [],
        approvalIds: [],
        skillIds: [],
        chatSessionId: session.id,
        currentStep: "Thinking"
      };
      state.tasks.push(task);
      const record = state.chatSessions.find((s) => s.id === session.id);
      if (record) record.taskIds.push(task.id);
    });

    // Provider auth failures arrive as a ProviderAuthError (thrown at the
    // provider-call site, tagging the provider that served the turn).
    await failTask(
      config,
      taskId,
      new ProviderAuthError("codex", "Provided authentication token is expired. Please try signing in again.")
    );

    const note = listChatBlocks(config.instance, session.id).find((b) => b.kind === "system_note");
    if (note?.kind !== "system_note") throw new Error("expected a system_note block");
    expect(note.authError).toEqual({
      provider: "codex",
      providerLabel: "Codex",
      detail: "Provided authentication token is expired. Please try signing in again.",
      reauthKind: "docs",
      reauthUrl: "https://gini.lilaclabs.ai/docs/providers/codex#re-authentication"
    });
    expect(note.text).toBe("Codex authentication failed. Re-authenticate Codex to continue.");

    // The failed provider is recorded on the task so text-only clients
    // (messaging/CLI) get the same actionable line via syncChatTaskResult —
    // for codex, the docs link inline since there's no CTA button.
    const failedTask = readState(config.instance).tasks.find((t) => t.id === taskId);
    expect(failedTask?.authErrorProvider).toBe("codex");

    // The failure also lands the persistent per-provider record (issue #233)
    // so Settings/connector surfaces stop claiming "Connected", plus the
    // transition audit row.
    const stateAfterFail = readState(config.instance);
    expect(stateAfterFail.providerAuthFailures?.codex).toMatchObject({
      provider: "codex",
      detail: "Provided authentication token is expired. Please try signing in again.",
      taskId
    });
    expect(typeof stateAfterFail.providerAuthFailures?.codex?.at).toBe("string");
    expect(
      stateAfterFail.audit.find((a) => a.action === "provider.auth.needs_reauth" && a.target === "codex")
    ).toBeDefined();
    const synced = await syncChatTaskResult(config, session.id, taskId);
    expect(synced?.content).toBe(
      "Codex authentication failed. Re-authenticate Codex to continue: https://gini.lilaclabs.ai/docs/providers/codex#re-authentication"
    );

    // A non-auth failure must NOT carry authError — the raw message passes
    // through as before. (A plain Error whose text merely mentions "401" must
    // also not be misread as a provider re-auth — only ProviderAuthError is.)
    const plainTaskId = "task_plainfail";
    await mutateState(config.instance, (state) => {
      const task: Task = {
        id: plainTaskId,
        title: "chat turn",
        input: "do it",
        status: "running",
        instance: state.instance,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tracePath: "",
        auditIds: [],
        approvalIds: [],
        skillIds: [],
        chatSessionId: session.id,
        currentStep: "Thinking"
      };
      state.tasks.push(task);
      const record = state.chatSessions.find((s) => s.id === session.id);
      if (record) record.taskIds.push(task.id);
    });
    // Auth-shaped text on a PLAIN Error (e.g. a tool hitting a 401) must stay
    // raw — only a ProviderAuthError triggers the provider re-auth card.
    await failTask(config, plainTaskId, new Error("Tool failed: HTTP 401 Unauthorized from example.com"));
    const plainNote = listChatBlocks(config.instance, session.id)
      .filter((b) => b.kind === "system_note")
      .at(-1);
    if (plainNote?.kind !== "system_note") throw new Error("expected a system_note block");
    expect(plainNote.authError).toBeUndefined();
    expect(plainNote.text).toBe("Tool failed: HTTP 401 Unauthorized from example.com");
    // A plain Error must not write a persistent needs-reauth record either —
    // the only key still present is the codex one from the typed failure above.
    expect(Object.keys(readState(config.instance).providerAuthFailures ?? {})).toEqual(["codex"]);
  });

  test("failTask records the needs-reauth state even when the task already went terminal", async () => {
    // A concurrent cancel (user Stop racing a just-rejected 401) or a sibling
    // approval denial can flip the task terminal before failTask's mutation
    // runs. The task-lifecycle idempotency guard must still skip the status
    // flip and the task.failed audit — but the credential record is
    // independent of task lifecycle and must land regardless, or Settings
    // keeps claiming "Connected" against a dead credential (issue #233).
    const config = {
      ...buildConfig(workspaceRoot, "chat-fail-auth-terminal"),
      provider: { name: "openai" as const, model: "gpt-5.4-mini" }
    };
    const session = await createChat(config, { title: "auth-fail-terminal" });
    const taskId = "task_authfail_terminal";
    await mutateState(config.instance, (state) => {
      const task: Task = {
        id: taskId,
        title: "chat turn",
        input: "do it",
        status: "cancelled",
        instance: state.instance,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tracePath: "",
        auditIds: [],
        approvalIds: [],
        skillIds: [],
        chatSessionId: session.id,
        currentStep: "Cancelled"
      };
      state.tasks.push(task);
      const record = state.chatSessions.find((s) => s.id === session.id);
      if (record) record.taskIds.push(task.id);
    });

    await failTask(config, taskId, new ProviderAuthError("openai", "Incorrect API key provided"));

    const state = readState(config.instance);
    // The credential record landed despite the terminal short-circuit.
    expect(state.providerAuthFailures?.openai).toMatchObject({
      provider: "openai",
      detail: "Incorrect API key provided",
      taskId
    });
    expect(
      state.audit.find((a) => a.action === "provider.auth.needs_reauth" && a.target === "openai")
    ).toBeDefined();
    // The task-lifecycle guard still holds: status untouched, no failure
    // bookkeeping on the already-terminal task.
    const task = state.tasks.find((t) => t.id === taskId);
    expect(task?.status).toBe("cancelled");
    expect(task?.authErrorProvider).toBeUndefined();
    expect(state.audit.find((a) => a.action === "task.failed" && a.target === taskId)).toBeUndefined();
  });

  test("ProviderAuthError names the provider that served the turn, not the active one", async () => {
    // The model-call site tags the failure with the provider it actually used.
    // failTask must trust that over re-resolving the (possibly since-changed)
    // active provider, so the CTA points at the right credential. See #205.
    const config = {
      ...buildConfig(workspaceRoot, "chat-fail-auth-provider"),
      provider: { name: "codex" as const, model: "gpt-5-codex" }
    };
    const session = await createChat(config, { title: "auth-provider" });
    const taskId = "task_authprovider";
    await mutateState(config.instance, (state) => {
      const task: Task = {
        id: taskId,
        title: "chat turn",
        input: "do it",
        status: "running",
        instance: state.instance,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tracePath: "",
        auditIds: [],
        approvalIds: [],
        skillIds: [],
        chatSessionId: session.id,
        currentStep: "Thinking"
      };
      state.tasks.push(task);
      const record = state.chatSessions.find((s) => s.id === session.id);
      if (record) record.taskIds.push(task.id);
    });

    // Instance provider is codex, but the turn ran on openai — the tagged
    // error wins. The message carries a key fragment that must be redacted.
    await failTask(
      config,
      taskId,
      new ProviderAuthError("openai", "Incorrect API key provided: sk-proj-ABC123def456ghi")
    );

    const note = listChatBlocks(config.instance, session.id).find((b) => b.kind === "system_note");
    if (note?.kind !== "system_note") throw new Error("expected a system_note block");
    expect(note.authError?.provider).toBe("openai");
    // openai is API-key, so the CTA routes to the in-app Settings form, not docs.
    expect(note.authError?.reauthKind).toBe("settings");
    expect(note.authError?.reauthUrl).toBe("/settings");
    // The key fragment is redacted in the rendered detail and in task.error.
    expect(note.authError?.detail).toBe("Incorrect API key provided: sk-***");
    expect(readState(config.instance).tasks.find((t) => t.id === taskId)?.error).toBe(
      "Incorrect API key provided: sk-***"
    );
    // The persistent record stores the SAME redacted detail (issue #233) —
    // the raw key fragment never lands in state.json.
    const persisted = readState(config.instance).providerAuthFailures?.openai;
    expect(persisted?.detail).toBe("Incorrect API key provided: sk-***");
    expect(JSON.stringify(persisted)).not.toContain("ABC123def456ghi");
    expect(note.text).toBe("OpenAI authentication failed. Re-authenticate OpenAI to continue.");

    // Text-only clients get the Settings-form line for an API-key provider.
    const synced = await syncChatTaskResult(config, session.id, taskId);
    expect(synced?.content).toBe(
      "OpenAI authentication failed. Update your OpenAI API key in Settings → Providers."
    );
  });

  test("auto-renames a default chat with a provider-generated title after two synced turns", async () => {
    const config = buildConfig(workspaceRoot, "chat-auto-title-default");
    setEchoStructuredResponse("chat-title", { title: "Low Maintenance Garden Plan" });

    const session = await createChat(config, { title: "" });
    const first = await submitChatMessage(config, session.id, { content: "plan a small garden" });
    await waitForStatus(config, first.taskId, (t) => t.status === "completed");
    await syncChatTaskResult(config, session.id, first.taskId);

    let stateNow = readState(config.instance);
    expect(stateNow.chatSessions.find((item) => item.id === session.id)?.title).toBe("Untitled chat");

    const second = await submitChatMessage(config, session.id, { content: "make it lower maintenance" });
    await waitForStatus(config, second.taskId, (t) => t.status === "completed");
    await syncChatTaskResult(config, session.id, second.taskId);

    stateNow = readState(config.instance);
    expect(stateNow.chatSessions.find((item) => item.id === session.id)?.title).toBe("Low Maintenance Garden Plan");
  });

  test("does not auto-rename manually titled chats", async () => {
    const config = buildConfig(workspaceRoot, "chat-auto-title-manual");
    setEchoStructuredResponse("chat-title", { title: "Should Not Apply" });

    const session = await createChat(config, { title: "Manual title" });
    const first = await submitChatMessage(config, session.id, { content: "plan a small garden" });
    await waitForStatus(config, first.taskId, (t) => t.status === "completed");
    await syncChatTaskResult(config, session.id, first.taskId);
    const second = await submitChatMessage(config, session.id, { content: "make it lower maintenance" });
    await waitForStatus(config, second.taskId, (t) => t.status === "completed");
    await syncChatTaskResult(config, session.id, second.taskId);

    const stateNow = readState(config.instance);
    expect(stateNow.chatSessions.find((item) => item.id === session.id)?.title).toBe("Manual title");
  });

  test("does not auto-rename chats bound to scheduled-job delivery", async () => {
    const config = buildConfig(workspaceRoot, "chat-auto-title-job-delivery");
    setEchoStructuredResponse("chat-title", { title: "Should Not Apply" });

    const session = await createChat(config, { title: "" });
    await createScheduledJob(config, {
      name: "garden reminder",
      prompt: "check the garden",
      intervalSeconds: 60,
      chatSessionId: session.id
    });

    const first = await submitChatMessage(config, session.id, { content: "plan a small garden" });
    await waitForStatus(config, first.taskId, (t) => t.status === "completed");
    await syncChatTaskResult(config, session.id, first.taskId);
    const second = await submitChatMessage(config, session.id, { content: "make it lower maintenance" });
    await waitForStatus(config, second.taskId, (t) => t.status === "completed");
    await syncChatTaskResult(config, session.id, second.taskId);

    const stateNow = readState(config.instance);
    expect(stateNow.chatSessions.find((item) => item.id === session.id)?.title).toBe("Untitled chat");
  });
});

// Unit coverage for the request_google_account branch of dispatchToolCall.
//
// The dispatcher emits ONE system_note block whose `cta` renders as an
// inline button to /integrations, with the label decided by the live
// per-account Google sign-in status. The status provider is swapped via
// setRequestGoogleAccountStatusProvider so no test ever spawns a real
// `gws auth status` subprocess.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChatSession, createTask, listChatBlocks, mutateState, upsertTask } from "../state";
import type { GoogleAccountStatus, RuntimeConfig } from "../types";
import { dispatchToolCall, setRequestGoogleAccountStatusProvider } from "./tool-dispatch";

const ROOT = mkdtempSync(join(tmpdir(), "gini-google-cta-dispatch-"));
process.env.GINI_STATE_ROOT = ROOT;
process.env.GINI_LOG_ROOT = `${ROOT}/logs`;

function buildConfig(instance: string): RuntimeConfig {
  return {
    instance,
    port: 0,
    token: "t",
    provider: { name: "echo", model: "" },
    workspaceRoot: `${ROOT}/${instance}/workspace`,
    stateRoot: ROOT,
    logRoot: `${ROOT}/logs`
  };
}

// Task bound to a live chat session so resolveEmitContext lands the
// system_note in a real block stream (same shape as tool-dispatch.test.ts).
async function newTask(config: RuntimeConfig): Promise<{ taskId: string; sessionId: string }> {
  const task = createTask(config.instance, "google cta dispatch test");
  let sessionId = "";
  await mutateState(config.instance, (state) => {
    const session = createChatSession(state, "google cta session");
    sessionId = session.id;
    task.chatSessionId = sessionId;
    upsertTask(state, task);
  });
  return { taskId: task.id, sessionId };
}

function account(opts: { tag: string; email?: string; signedIn?: boolean; tokenRevoked?: boolean }): GoogleAccountStatus {
  return {
    id: `gacct_${opts.tag}`,
    tag: opts.tag,
    email: opts.email ?? `${opts.tag}@example.com`,
    configDir: `/home/u/.gini/google-accounts/gacct_${opts.tag}`,
    addedAt: "2026-01-01T00:00:00.000Z",
    signedIn: opts.signedIn ?? true,
    tokenRevoked: opts.tokenRevoked ?? false,
    services: {},
    message: ""
  };
}

let restoreProvider: (() => void) | undefined;

afterEach(() => {
  restoreProvider?.();
  restoreProvider = undefined;
});

describe("request_google_account dispatch", () => {
  test("revoked account → one system_note with a Reconnect cta naming the account", async () => {
    const instance = `google-cta-revoked-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    restoreProvider = setRequestGoogleAccountStatusProvider(async () => [
      account({ tag: "personal", email: "me@gmail.com", signedIn: false, tokenRevoked: true }),
      account({ tag: "work", email: "work@corp.com" })
    ]);
    const { taskId, sessionId } = await newTask(config);

    const result = await dispatchToolCall(config, taskId, "request_google_account", "call_1", "{}");
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      // The steer hands off to the user and forbids agent-driven OAuth.
      expect(result.result).toContain("Integrations page");
      expect(result.result).toContain("wait");
      expect(result.result).toContain("gws auth login");
    }

    const notes = listChatBlocks(instance, sessionId).filter((b) => b.kind === "system_note");
    expect(notes.length).toBe(1);
    const note = notes[0];
    if (note?.kind !== "system_note") throw new Error("expected a system_note block");
    expect(note.cta).toEqual({ href: "/integrations", label: "Reconnect Google account" });
    expect(note.text).toContain("me@gmail.com");
    expect(note.authError).toBeUndefined();
  });

  test("no revoked account → Connect label and the generic connect line", async () => {
    const instance = `google-cta-connect-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    restoreProvider = setRequestGoogleAccountStatusProvider(async () => []);
    const { taskId, sessionId } = await newTask(config);

    await dispatchToolCall(config, taskId, "request_google_account", "call_1", "{}");

    const notes = listChatBlocks(instance, sessionId).filter((b) => b.kind === "system_note");
    expect(notes.length).toBe(1);
    const note = notes[0];
    if (note?.kind !== "system_note") throw new Error("expected a system_note block");
    expect(note.cta).toEqual({ href: "/integrations", label: "Connect Google account" });
    expect(note.text).toContain("Connect a Google account");
  });

  test("agent-supplied message overrides the composed note text", async () => {
    const instance = `google-cta-message-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    restoreProvider = setRequestGoogleAccountStatusProvider(async () => [
      account({ tag: "personal", signedIn: false, tokenRevoked: true })
    ]);
    const { taskId, sessionId } = await newTask(config);

    await dispatchToolCall(
      config,
      taskId,
      "request_google_account",
      "call_1",
      JSON.stringify({ message: "Your work Gmail sign-in expired while I was labeling." })
    );

    const notes = listChatBlocks(instance, sessionId).filter((b) => b.kind === "system_note");
    expect(notes.length).toBe(1);
    const note = notes[0];
    if (note?.kind !== "system_note") throw new Error("expected a system_note block");
    expect(note.text).toBe("Your work Gmail sign-in expired while I was labeling.");
    // Status (not the message) still decides the label.
    expect(note.cta?.label).toBe("Reconnect Google account");
  });

  test("a failing status probe degrades to the Connect wording instead of throwing", async () => {
    const instance = `google-cta-degrade-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    restoreProvider = setRequestGoogleAccountStatusProvider(async () => {
      throw new Error("gws unavailable");
    });
    const { taskId, sessionId } = await newTask(config);

    const result = await dispatchToolCall(config, taskId, "request_google_account", "call_1", "{}");
    expect(result.kind).toBe("sync");

    const notes = listChatBlocks(instance, sessionId).filter((b) => b.kind === "system_note");
    expect(notes.length).toBe(1);
    const note = notes[0];
    if (note?.kind !== "system_note") throw new Error("expected a system_note block");
    expect(note.cta).toEqual({ href: "/integrations", label: "Connect Google account" });
  });
});

import { describe, expect, test } from "bun:test";
import {
  parseDraftSendResult,
  resolveDraftSendConfigDir,
  sendGmailDraft,
  setAccountsProvider
} from "./gmail-draft-send";

// parseDraftSendResult is the pure half of sendGmailDraft (the subprocess
// boundary is the injectable runner). These tests pin the success/failure
// derivation: a sent message JSON (with `.id`) → ok + messageId; a gws API
// error envelope → ok:false with the message; non-JSON / object-less output →
// ok:false. A keyring preamble before the JSON is sliced off.

describe("parseDraftSendResult", () => {
  test("a sent message (id + SENT label) yields ok + messageId", () => {
    const result = parseDraftSendResult(
      JSON.stringify({ id: "19f120b4e14dd2b5", labelIds: ["SENT", "INBOX"], threadId: "t1" })
    );
    expect(result).toEqual({ ok: true, messageId: "19f120b4e14dd2b5" });
  });

  test("a keyring preamble before the JSON is sliced off", () => {
    const result = parseDraftSendResult(`Using keyring backend: keyring\n${JSON.stringify({ id: "m1" })}`);
    expect(result).toEqual({ ok: true, messageId: "m1" });
  });

  test("a gws API error envelope yields ok:false with the message", () => {
    const result = parseDraftSendResult(JSON.stringify({ error: { code: 400, message: "Invalid draft" } }));
    expect(result).toEqual({ ok: false, message: "Invalid draft" });
  });

  test("an error envelope with no message falls back to a generic reason", () => {
    const result = parseDraftSendResult(JSON.stringify({ error: { code: 400 } }));
    expect(result.ok).toBe(false);
    expect(result.message).toBe("Gmail rejected the draft send.");
  });

  test("non-JSON output is a failure", () => {
    const result = parseDraftSendResult("not json at all");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("parseable");
  });

  test("a JSON value that is not an object is a failure", () => {
    const result = parseDraftSendResult("42");
    expect(result.ok).toBe(false);
  });

  test("a success-shaped object with no id is a failure (no send confirmed)", () => {
    const result = parseDraftSendResult(JSON.stringify({ labelIds: ["SENT"] }));
    expect(result.ok).toBe(false);
    expect(result.message).toContain("confirm");
  });
});

describe("sendGmailDraft", () => {
  test("passes the draft id + configDir to the runner and parses its stdout", async () => {
    let seen: { draftId: string; configDir?: string } | undefined;
    const result = await sendGmailDraft({ draftId: "r123", configDir: "/cfg/dir" }, async (args) => {
      seen = args;
      return { stdout: JSON.stringify({ id: "sent-1" }), exitCode: 0 };
    });
    expect(seen).toEqual({ draftId: "r123", configDir: "/cfg/dir" });
    expect(result).toEqual({ ok: true, messageId: "sent-1" });
  });

  test("a runner that throws resolves to ok:false (never marks sent)", async () => {
    const result = await sendGmailDraft({ draftId: "r123" }, async () => {
      throw new Error("spawn failed");
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("reach Gmail");
  });
});

describe("resolveDraftSendConfigDir", () => {
  test("scopes the account lookup to the requested instance", async () => {
    let requestedInstance: string | undefined;
    const restore = setAccountsProvider(async (instance) => {
      requestedInstance = instance;
      return [{ email: "me@example.com", configDir: "/cfg/me", signedIn: true }];
    });
    try {
      expect(await resolveDraftSendConfigDir("me@example.com", "inst-a")).toBe("/cfg/me");
      expect(requestedInstance).toBe("inst-a");
    } finally {
      restore();
    }
  });
});

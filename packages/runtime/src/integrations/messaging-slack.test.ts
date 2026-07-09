import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { RuntimeConfig } from "../types";
import { isTerminalTaskStatus, readState } from "../state";
import {
  addMessagingBridge,
  checkMessagingBridge,
  findSlackChatSession,
  readBridgeAppToken,
  readBridgeBotToken,
  receiveMessagingInput,
  resetMessagingDeps,
  sendMessagingOutput,
  setMessagingDeps
} from "./messaging";
import type { SlackClient } from "./slack";

function testConfig(instance: string): RuntimeConfig {
  const root = "/tmp/gini-messaging-slack-tests";
  process.env.GINI_STATE_ROOT = root;
  process.env.GINI_LOG_ROOT = `${root}-logs`;
  rmSync(`${root}/instances/${instance}`, { recursive: true, force: true });
  return {
    instance,
    port: 7342,
    token: "test-token",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: "/tmp",
    stateRoot: `${root}/instances/${instance}`,
    logRoot: `${root}-logs/${instance}`
  };
}

// Wait for spawned chat tasks to settle before the test returns —
// submitTask runs runTask detached, and a task still in flight when
// the next test file rebinds GINI_STATE_ROOT would land its state
// write against the wrong instance directory.
async function waitForTasksSettled(config: RuntimeConfig, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tasks = readState(config.instance).tasks;
    if (tasks.every((t) => isTerminalTaskStatus(t.status))) return;
    await Bun.sleep(10);
  }
  throw new Error("Tasks did not settle in time");
}

interface StubCall { method: string; args: unknown[] }

function stubSlackClient(overrides: Partial<SlackClient> = {}): { client: SlackClient; calls: StubCall[] } {
  const calls: StubCall[] = [];
  const client: SlackClient = {
    authTest: async () => {
      calls.push({ method: "authTest", args: [] });
      return { userId: "UBOT", user: "gini", teamId: "T1", team: "Acme" };
    },
    postMessage: async (channel, text, options) => {
      calls.push({ method: "postMessage", args: [channel, text, options] });
      return { channel, ts: "1700000000.000200" };
    },
    addReaction: async (channel, timestamp, name) => {
      calls.push({ method: "addReaction", args: [channel, timestamp, name] });
      return true as const;
    },
    removeReaction: async (channel, timestamp, name) => {
      calls.push({ method: "removeReaction", args: [channel, timestamp, name] });
      return true as const;
    },
    ...overrides
  };
  return { client, calls };
}

describe("messaging slack wiring", () => {
  afterEach(() => resetMessagingDeps());

  test("addMessagingBridge requires BOTH a botToken and an appToken and persists each via the secret store", async () => {
    const config = testConfig("slack-add");

    await expect(
      addMessagingBridge(config, { name: "slk", kind: "slack", deliveryTargets: [] })
    ).rejects.toThrow(/botToken/);
    await expect(
      addMessagingBridge(config, { name: "slk", kind: "slack", deliveryTargets: [], botToken: "xoxb-SECRET" })
    ).rejects.toThrow(/appToken/);

    const bridge = await addMessagingBridge(config, {
      name: "slk",
      kind: "slack",
      deliveryTargets: [],
      botToken: "xoxb-SECRET",
      appToken: "xapp-SECRET"
    });

    expect(bridge.kind).toBe("slack");
    const purposes = (bridge.secretRefs ?? []).map((ref) => ref.purpose).sort();
    expect(purposes).toEqual(["app-token", "bot-token"]);
    // Both plaintexts round-trip through the encrypted store but never
    // land on the bridge record itself.
    expect(JSON.stringify(bridge)).not.toContain("SECRET");
    expect(readBridgeBotToken(config, bridge)).toBe("xoxb-SECRET");
    expect(readBridgeAppToken(config, bridge)).toBe("xapp-SECRET");
  });

  test("addMessagingBridge rejects header-unsafe tokens for BOTH credentials at create time", async () => {
    const config = testConfig("slack-add-header-safe");
    await expect(
      addMessagingBridge(config, {
        name: "slk",
        kind: "slack",
        deliveryTargets: [],
        botToken: "bad\ntoken",
        appToken: "xapp-ok"
      })
    ).rejects.toThrow(/bot token contains invalid characters/);
    await expect(
      addMessagingBridge(config, {
        name: "slk",
        kind: "slack",
        deliveryTargets: [],
        botToken: "xoxb-ok",
        appToken: "bad\ntoken"
      })
    ).rejects.toThrow(/app-level token contains invalid characters/);
  });

  test("checkMessagingBridge probes auth.test and stamps the bot identity metadata", async () => {
    const config = testConfig("slack-health");
    const { client, calls } = stubSlackClient();
    setMessagingDeps({ slackClientFactory: () => client });

    const bridge = await addMessagingBridge(config, {
      name: "slk",
      kind: "slack",
      deliveryTargets: [],
      botToken: "xoxb-TOK",
      appToken: "xapp-TOK"
    });

    const checked = await checkMessagingBridge(config, bridge.id);
    expect(checked.status).toBe("configured");
    expect(checked.message).toBe("Connected as @gini in Acme.");
    expect(checked.metadata?.botUserId).toBe("UBOT");
    expect(checked.metadata?.botUsername).toBe("gini");
    expect(checked.metadata?.teamId).toBe("T1");
    expect(checked.metadata?.teamName).toBe("Acme");
    expect(calls.map((c) => c.method)).toEqual(["authTest"]);
  });

  test("checkMessagingBridge flips to error with a sanitized message when auth.test fails", async () => {
    const config = testConfig("slack-health-error");
    const { client } = stubSlackClient({
      authTest: async () => {
        throw new Error("Slack auth.test failed: invalid_auth (token xoxb-1234-abcd)");
      }
    });
    setMessagingDeps({ slackClientFactory: () => client });

    const bridge = await addMessagingBridge(config, {
      name: "slk",
      kind: "slack",
      deliveryTargets: [],
      botToken: "xoxb-TOK",
      appToken: "xapp-TOK"
    });

    const checked = await checkMessagingBridge(config, bridge.id);
    expect(checked.status).toBe("error");
    expect(String(checked.message)).toContain("invalid_auth");
    // The echoed token must be scrubbed by the shared sanitizer.
    expect(String(checked.message)).not.toContain("xoxb-1234-abcd");
    expect(String(checked.message)).toContain("xox<redacted>");
  });

  test("sendMessagingOutput threads the reply via thread_ts and converts Markdown to mrkdwn", async () => {
    const config = testConfig("slack-send-thread");
    const { client, calls } = stubSlackClient();
    setMessagingDeps({ slackClientFactory: () => client });

    const bridge = await addMessagingBridge(config, {
      name: "slk",
      kind: "slack",
      deliveryTargets: [],
      botToken: "xoxb-TOK",
      appToken: "xapp-TOK"
    });

    const record = await sendMessagingOutput(config, bridge.id, {
      text: "done — **bold** result",
      target: "D1",
      threadTs: "1700000000.000100"
    });
    expect(record.status).toBe("sent");
    const post = calls.find((c) => c.method === "postMessage");
    expect(post?.args[0]).toBe("D1");
    expect(post?.args[1]).toBe("done — *bold* result");
    expect((post?.args[2] as { threadTs?: string }).threadTs).toBe("1700000000.000100");
  });

  test("sendMessagingOutput parseMode 'none' sends the literal text", async () => {
    const config = testConfig("slack-send-literal");
    const { client, calls } = stubSlackClient();
    setMessagingDeps({ slackClientFactory: () => client });

    const bridge = await addMessagingBridge(config, {
      name: "slk",
      kind: "slack",
      deliveryTargets: [],
      botToken: "xoxb-TOK",
      appToken: "xapp-TOK"
    });

    await sendMessagingOutput(config, bridge.id, {
      text: "**literal**",
      target: "D1",
      parseMode: "none"
    });
    const post = calls.find((c) => c.method === "postMessage");
    expect(post?.args[1]).toBe("**literal**");
  });

  test("sendMessagingOutput rejects photo sends with an explicit failed record", async () => {
    const config = testConfig("slack-send-photo");
    const { client, calls } = stubSlackClient();
    setMessagingDeps({ slackClientFactory: () => client });

    const bridge = await addMessagingBridge(config, {
      name: "slk",
      kind: "slack",
      deliveryTargets: [],
      botToken: "xoxb-TOK",
      appToken: "xapp-TOK"
    });

    const record = await sendMessagingOutput(config, bridge.id, {
      text: "caption",
      target: "D1",
      photo: { url: "https://example.com/x.png" }
    });
    expect(record.status).toBe("failed");
    expect(record.error).toContain("photo");
    expect(calls.filter((c) => c.method === "postMessage")).toEqual([]);
  });

  test("sendMessagingOutput records a sanitized failure when chat.postMessage errors", async () => {
    const config = testConfig("slack-send-error");
    const { client } = stubSlackClient({
      postMessage: async () => {
        throw new Error("Slack chat.postMessage failed: channel_not_found");
      }
    });
    setMessagingDeps({ slackClientFactory: () => client });

    const bridge = await addMessagingBridge(config, {
      name: "slk",
      kind: "slack",
      deliveryTargets: [],
      botToken: "xoxb-TOK",
      appToken: "xapp-TOK"
    });

    const record = await sendMessagingOutput(config, bridge.id, { text: "hi", target: "D1" });
    expect(record.status).toBe("failed");
    expect(record.error).toContain("channel_not_found");
  });

  test("receiveMessagingInput keys the session on (bridge, channel, threadTs) and stamps lastInboundMessageId", async () => {
    const config = testConfig("slack-receive");
    const { client } = stubSlackClient();
    setMessagingDeps({ slackClientFactory: () => client });

    const bridge = await addMessagingBridge(config, {
      name: "slk",
      kind: "slack",
      deliveryTargets: [],
      botToken: "xoxb-TOK",
      appToken: "xapp-TOK"
    });

    await expect(
      receiveMessagingInput(config, bridge.id, { text: "hi" })
    ).rejects.toThrow(/channel id/);
    await expect(
      receiveMessagingInput(config, bridge.id, { text: "hi", target: "D1" })
    ).rejects.toThrow(/threadTs/);

    // Top-level message: the socket loop passes threadTs === ts.
    await receiveMessagingInput(config, bridge.id, {
      text: "first",
      target: "D1",
      messageId: "1700000001.000100",
      threadTs: "1700000001.000100"
    });
    // Thread reply: same threadTs, newer messageId → SAME session,
    // lastInboundMessageId advances.
    await receiveMessagingInput(config, bridge.id, {
      text: "follow-up",
      target: "D1",
      messageId: "1700000002.000200",
      threadTs: "1700000001.000100"
    });

    const session = findSlackChatSession(config, bridge.id, "D1", "1700000001.000100");
    expect(session).toBeDefined();
    expect(session?.source?.kind === "slack" && session.source.threadTs).toBe("1700000001.000100");
    expect(session?.source?.kind === "slack" && session.source.lastInboundMessageId).toBe("1700000002.000200");
    const slackSessions = readState(config.instance).chatSessions.filter((s) => s.source?.kind === "slack");
    expect(slackSessions.length).toBe(1);

    // A different thread root mints a distinct session.
    await receiveMessagingInput(config, bridge.id, {
      text: "second question",
      target: "D1",
      messageId: "1700000003.000300",
      threadTs: "1700000003.000300"
    });
    expect(readState(config.instance).chatSessions.filter((s) => s.source?.kind === "slack").length).toBe(2);
    expect(findSlackChatSession(config, bridge.id, "D1", "1700000003.000300")).toBeDefined();

    await waitForTasksSettled(config);
  });

  test("receiveMessagingInput derives threadTs from messageId when only messageId is supplied (top-level semantics)", async () => {
    const config = testConfig("slack-receive-derive");
    const { client } = stubSlackClient();
    setMessagingDeps({ slackClientFactory: () => client });

    const bridge = await addMessagingBridge(config, {
      name: "slk",
      kind: "slack",
      deliveryTargets: [],
      botToken: "xoxb-TOK",
      appToken: "xapp-TOK"
    });

    await receiveMessagingInput(config, bridge.id, {
      text: "hello",
      target: "D1",
      messageId: "1700000005.000500"
    });
    expect(findSlackChatSession(config, bridge.id, "D1", "1700000005.000500")).toBeDefined();

    await waitForTasksSettled(config);
  });
});

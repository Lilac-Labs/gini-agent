import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { RuntimeConfig } from "../types";
import { mutateState, readState } from "../state";
import { addMessagingBridge, resetMessagingDeps, setMessagingDeps } from "./messaging";
import { createSlackBridgeSupervisor } from "./slack-bridge";
import { setMaxTaskWaitMsForTests } from "./messaging-poller-helpers";
import type { PollerSupervisor } from "./discord-poller";
import type { SlackClient } from "./slack";
import type { SlackSocketEnvelope, SlackSocketHandle } from "./slack-socket";

function testConfig(instance: string): RuntimeConfig {
  const root = "/tmp/gini-slack-bridge-tests";
  process.env.GINI_STATE_ROOT = root;
  process.env.GINI_LOG_ROOT = `${root}-logs`;
  rmSync(`${root}/instances/${instance}`, { recursive: true, force: true });
  return {
    instance,
    port: 7341,
    token: "test-token",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: "/tmp",
    stateRoot: `${root}/instances/${instance}`,
    logRoot: `${root}-logs/${instance}`
  };
}

// Programmable Slack client. postMessage / addReaction capture their
// inputs so the reply mirror + reaction ack can be observed; authTest
// returns a fixed bot identity the loop uses for self-drop filtering.
function programmableClient(): {
  client: SlackClient;
  postCalls: Array<{ channel: string; text: string; threadTs?: string }>;
  reactionCalls: Array<{ channel: string; timestamp: string; name: string }>;
} {
  const postCalls: Array<{ channel: string; text: string; threadTs?: string }> = [];
  const reactionCalls: Array<{ channel: string; timestamp: string; name: string }> = [];
  const client: SlackClient = {
    async authTest() {
      return { userId: "UBOT", user: "gini", teamId: "T1", team: "Acme" };
    },
    async postMessage(channel, text, options) {
      postCalls.push({ channel, text, ...(options?.threadTs ? { threadTs: options.threadTs } : {}) });
      return { channel, ts: `${Date.now() / 1000}` };
    },
    async addReaction(channel, timestamp, name) {
      reactionCalls.push({ channel, timestamp, name });
      return true as const;
    }
  };
  return { client, postCalls, reactionCalls };
}

// Socket connector stub: captures the `onEvent` callback so tests push
// synthetic envelopes, and exposes `resolveDone` so the give-up path
// (apps.connections.open rejected the app token) can be simulated.
function capturingSocket(slot: {
  fire?: (envelope: SlackSocketEnvelope) => void;
  resolveDone?: () => void;
  closes?: number;
}) {
  slot.closes = 0;
  return (options: { onEvent: (envelope: SlackSocketEnvelope) => void }): SlackSocketHandle => {
    slot.fire = options.onEvent;
    const { promise, resolve } = Promise.withResolvers<void>();
    slot.resolveDone = resolve;
    return {
      done: promise,
      close: () => {
        slot.closes = (slot.closes ?? 0) + 1;
        resolve();
      }
    };
  };
}

// Message-event envelope factory. Defaults model a plain top-level DM.
function makeEnvelope(overrides: {
  eventId?: string;
  event?: Record<string, unknown>;
}): SlackSocketEnvelope {
  return {
    eventId: overrides.eventId ?? `Ev-${Math.random().toString(36).slice(2)}`,
    event: {
      type: "message",
      channel: "D1",
      channel_type: "im",
      user: "U1",
      text: "hi gini",
      ts: "1700000001.000100",
      ...(overrides.event ?? {})
    }
  };
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

function slackSessions(config: RuntimeConfig) {
  return readState(config.instance).chatSessions.filter((s) => s.source?.kind === "slack");
}

describe("slack bridge supervisor", () => {
  // Track every supervisor a test creates so a failed assertion before
  // the in-body stopAll() can't strand a loop polling against the next
  // test's GINI_STATE_ROOT — same guard as the discord poller tests.
  const liveSupervisors: PollerSupervisor[] = [];
  function createTrackedSupervisor(
    ...args: Parameters<typeof createSlackBridgeSupervisor>
  ): PollerSupervisor {
    const s = createSlackBridgeSupervisor(...args);
    liveSupervisors.push(s);
    return s;
  }

  afterEach(async () => {
    while (liveSupervisors.length > 0) {
      const s = liveSupervisors.pop();
      if (s) {
        try { await s.stopAll(); } catch { /* shutdown best-effort */ }
      }
    }
    resetMessagingDeps();
    setMaxTaskWaitMsForTests(undefined);
  });

  async function addSlackBridge(config: RuntimeConfig) {
    return addMessagingBridge(config, {
      name: "slk",
      kind: "slack",
      deliveryTargets: [],
      botToken: "xoxb-TOK",
      appToken: "xapp-TOK"
    });
  }

  test("reconcile starts a loop for a configured bridge; stopAll cancels it and closes the socket", async () => {
    const config = testConfig("slk-start-stop");
    const { client } = programmableClient();
    setMessagingDeps({ slackClientFactory: () => client });
    await addSlackBridge(config);

    const slot: Parameters<typeof capturingSocket>[0] = {};
    const supervisor = createTrackedSupervisor(config, {
      clientFactory: () => client,
      socketConnector: capturingSocket(slot),
      statusCheckIntervalMs: 20
    });
    supervisor.reconcile();
    expect(supervisor.size()).toBe(1);
    await waitFor(() => slot.fire !== undefined, "socket connector to capture onEvent");

    await supervisor.stopAll();
    expect(supervisor.size()).toBe(0);
    // The loop's finally reaped the socket so the WebSocket doesn't
    // keep routing events after the bridge is gone.
    expect(slot.closes).toBeGreaterThanOrEqual(1);
  });

  test("shouldRun requires BOTH secret refs — a bridge missing the app-token ref is not picked up", async () => {
    const config = testConfig("slk-missing-app-token");
    const { client } = programmableClient();
    setMessagingDeps({ slackClientFactory: () => client });
    const bridge = await addSlackBridge(config);
    await mutateState(config.instance, (state) => {
      const live = state.messagingBridges.find((b) => b.id === bridge.id);
      if (live) live.secretRefs = (live.secretRefs ?? []).filter((ref) => ref.purpose !== "app-token");
    });

    const slot: Parameters<typeof capturingSocket>[0] = {};
    const supervisor = createTrackedSupervisor(config, {
      clientFactory: () => client,
      socketConnector: capturingSocket(slot),
      statusCheckIntervalMs: 20
    });
    supervisor.reconcile();
    expect(supervisor.size()).toBe(0);
  });

  test("a top-level DM starts a NEW per-thread session, reacts with eyes, and mirrors the reply threaded on the message's own ts", async () => {
    const config = testConfig("slk-top-level");
    const { client, postCalls, reactionCalls } = programmableClient();
    setMessagingDeps({ slackClientFactory: () => client });
    const bridge = await addSlackBridge(config);

    const slot: Parameters<typeof capturingSocket>[0] = {};
    const supervisor = createTrackedSupervisor(config, {
      clientFactory: () => client,
      socketConnector: capturingSocket(slot),
      statusCheckIntervalMs: 20
    });
    supervisor.reconcile();
    await waitFor(() => slot.fire !== undefined, "socket connector to capture onEvent");

    // Top-level message: no thread_ts. Its own ts anchors the thread.
    slot.fire!(makeEnvelope({ event: { ts: "1700000001.000100" } }));

    await waitFor(
      () => readState(config.instance).messagingMessages.some((m) => m.direction === "inbound" && m.target === "D1"),
      "inbound message to land"
    );
    await waitFor(() => postCalls.length >= 1, "reply dispatch after task settles");

    // Session keyed by the message's own ts (thread root).
    const sessions = slackSessions(config);
    expect(sessions.length).toBe(1);
    const source = sessions[0]?.source;
    expect(source?.kind === "slack" && source.threadTs).toBe("1700000001.000100");
    expect(source?.kind === "slack" && source.channelId).toBe("D1");
    expect(source?.kind === "slack" && source.lastInboundMessageId).toBe("1700000001.000100");

    // Eyes-reaction ack on the inbound message.
    expect(reactionCalls[0]).toEqual({ channel: "D1", timestamp: "1700000001.000100", name: "eyes" });

    // Reply lands inside the thread anchored on the user's message.
    expect(postCalls[0]?.channel).toBe("D1");
    expect(postCalls[0]?.threadTs).toBe("1700000001.000100");
    expect(postCalls[0]?.text.length).toBeGreaterThan(0);

    void bridge;
    await supervisor.stopAll();
  });

  test("a reply typed inside a thread continues the SAME session and threads on the ROOT ts, not the reply's ts", async () => {
    const config = testConfig("slk-thread-reply");
    const { client, postCalls } = programmableClient();
    setMessagingDeps({ slackClientFactory: () => client });
    await addSlackBridge(config);

    const slot: Parameters<typeof capturingSocket>[0] = {};
    const supervisor = createTrackedSupervisor(config, {
      clientFactory: () => client,
      socketConnector: capturingSocket(slot),
      statusCheckIntervalMs: 20
    });
    supervisor.reconcile();
    await waitFor(() => slot.fire !== undefined, "socket connector to capture onEvent");

    // Top-level message, then a follow-up typed inside its thread.
    slot.fire!(makeEnvelope({ event: { ts: "1700000001.000100", text: "first" } }));
    await waitFor(() => postCalls.length >= 1, "first reply");
    slot.fire!(makeEnvelope({
      event: { ts: "1700000009.000900", thread_ts: "1700000001.000100", text: "follow-up" }
    }));
    await waitFor(() => postCalls.length >= 2, "second reply");

    // One session — the thread reply routed into the existing one.
    expect(slackSessions(config).length).toBe(1);
    // BOTH replies anchor on the thread ROOT ts. Threading the second
    // reply on the follow-up's own ts (1700000009.000900) would fork a
    // broken second thread in Slack.
    expect(postCalls[0]?.threadTs).toBe("1700000001.000100");
    expect(postCalls[1]?.threadTs).toBe("1700000001.000100");

    await supervisor.stopAll();
  });

  test("each top-level message gets its OWN session (thread-per-message)", async () => {
    const config = testConfig("slk-thread-per-message");
    const { client, postCalls } = programmableClient();
    setMessagingDeps({ slackClientFactory: () => client });
    await addSlackBridge(config);

    const slot: Parameters<typeof capturingSocket>[0] = {};
    const supervisor = createTrackedSupervisor(config, {
      clientFactory: () => client,
      socketConnector: capturingSocket(slot),
      statusCheckIntervalMs: 20
    });
    supervisor.reconcile();
    await waitFor(() => slot.fire !== undefined, "socket connector to capture onEvent");

    slot.fire!(makeEnvelope({ event: { ts: "1700000001.000100", text: "first question" } }));
    slot.fire!(makeEnvelope({ event: { ts: "1700000002.000200", text: "second question" } }));
    await waitFor(() => postCalls.length >= 2, "both replies to dispatch");

    const sessions = slackSessions(config);
    expect(sessions.length).toBe(2);
    const threadKeys = sessions
      .map((s) => (s.source?.kind === "slack" ? s.source.threadTs : undefined))
      .sort();
    expect(threadKeys).toEqual(["1700000001.000100", "1700000002.000200"]);

    await supervisor.stopAll();
  });

  test("drops: subtype, bot_id, self-authored, and non-im channel events never route", async () => {
    const config = testConfig("slk-drops");
    const { client, postCalls, reactionCalls } = programmableClient();
    setMessagingDeps({ slackClientFactory: () => client });
    await addSlackBridge(config);

    const slot: Parameters<typeof capturingSocket>[0] = {};
    const supervisor = createTrackedSupervisor(config, {
      clientFactory: () => client,
      socketConnector: capturingSocket(slot),
      statusCheckIntervalMs: 20
    });
    supervisor.reconcile();
    await waitFor(() => slot.fire !== undefined, "socket connector to capture onEvent");

    // Subtyped message (edit) — plain user messages carry no subtype.
    slot.fire!(makeEnvelope({ event: { subtype: "message_changed" } }));
    // Bot-authored (including our own replies, which arrive with bot_id).
    slot.fire!(makeEnvelope({ event: { bot_id: "B99" } }));
    // The bridge bot's own user id (authTest returned UBOT).
    slot.fire!(makeEnvelope({ event: { user: "UBOT" } }));
    // Channel / group message — the bridge is DM-only.
    slot.fire!(makeEnvelope({ event: { channel: "C7", channel_type: "channel" } }));
    // Attachment-only (empty text).
    slot.fire!(makeEnvelope({ event: { text: "" } }));

    // Give the loop a couple of ticks to (incorrectly) route anything.
    await Bun.sleep(100);
    expect(readState(config.instance).messagingMessages).toEqual([]);
    expect(readState(config.instance).tasks).toEqual([]);
    expect(postCalls).toEqual([]);
    expect(reactionCalls).toEqual([]);

    await supervisor.stopAll();
  });

  test("a retried envelope (same event_id) routes exactly once", async () => {
    const config = testConfig("slk-dedupe");
    const { client, postCalls } = programmableClient();
    setMessagingDeps({ slackClientFactory: () => client });
    await addSlackBridge(config);

    const slot: Parameters<typeof capturingSocket>[0] = {};
    const supervisor = createTrackedSupervisor(config, {
      clientFactory: () => client,
      socketConnector: capturingSocket(slot),
      statusCheckIntervalMs: 20
    });
    supervisor.reconcile();
    await waitFor(() => slot.fire !== undefined, "socket connector to capture onEvent");

    const envelope = makeEnvelope({ eventId: "Ev-retry", event: { ts: "1700000001.000100" } });
    slot.fire!(envelope);
    // Slack redelivers an envelope it never saw acked — same event_id.
    slot.fire!(envelope);

    await waitFor(() => postCalls.length >= 1, "reply for the deduped message");
    await Bun.sleep(100);
    const inbound = readState(config.instance).messagingMessages.filter((m) => m.direction === "inbound");
    expect(inbound.length).toBe(1);

    await supervisor.stopAll();
  });

  test("socket give-up (rejected app token) flips the bridge to error so reconcile drops it", async () => {
    const config = testConfig("slk-giveup");
    const { client } = programmableClient();
    setMessagingDeps({ slackClientFactory: () => client });
    const bridge = await addSlackBridge(config);

    const slot: Parameters<typeof capturingSocket>[0] = {};
    const supervisor = createTrackedSupervisor(config, {
      clientFactory: () => client,
      socketConnector: capturingSocket(slot),
      statusCheckIntervalMs: 20
    });
    supervisor.reconcile();
    await waitFor(() => slot.fire !== undefined, "socket connector to capture onEvent");

    // Simulate the socket's terminal give-up (done self-resolves only
    // on a non-recoverable apps.connections.open failure).
    slot.resolveDone!();

    await waitFor(
      () => readState(config.instance).messagingBridges.find((b) => b.id === bridge.id)?.status === "error",
      "bridge to flip to error after socket give-up"
    );
    await waitFor(() => supervisor.size() === 0, "loop to exit after give-up");
    const live = readState(config.instance).messagingBridges.find((b) => b.id === bridge.id);
    expect(String(live?.message)).toContain("Socket Mode");

    await supervisor.stopAll();
  });

  test("runLoop self-exits when the bridge status flips between ticks (no reconcile)", async () => {
    const config = testConfig("slk-self-exit");
    const { client } = programmableClient();
    setMessagingDeps({ slackClientFactory: () => client });
    const bridge = await addSlackBridge(config);

    const slot: Parameters<typeof capturingSocket>[0] = {};
    const supervisor = createTrackedSupervisor(config, {
      clientFactory: () => client,
      socketConnector: capturingSocket(slot),
      statusCheckIntervalMs: 20
    });
    supervisor.reconcile();
    expect(supervisor.size()).toBe(1);

    await mutateState(config.instance, (state) => {
      const live = state.messagingBridges.find((b) => b.id === bridge.id);
      if (live) live.status = "disabled";
    });

    // No reconcile() call — the loop's top-of-iteration guard observes
    // the flip on its next status-check tick and self-exits.
    await waitFor(() => supervisor.size() === 0, "loop to self-exit without reconcile");

    await supervisor.stopAll();
  });
});

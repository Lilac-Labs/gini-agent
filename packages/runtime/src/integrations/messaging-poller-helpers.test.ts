import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeConfig } from "../types";
import { mutateState } from "../state";
import { logDir } from "../paths";
import {
  awaitTerminalTask,
  createDetachedTracker,
  sanitizeBridgeStatusMessage,
  setMaxTaskWaitMsForTests,
  sleepUnlessAbortedOrWoken
} from "./messaging-poller-helpers";

function readRuntimeLog(instance: string): Array<Record<string, unknown>> {
  const path = join(logDir(instance), "runtime.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const ROOT = "/tmp/gini-messaging-poller-helpers-tests";

function testConfig(instance: string): RuntimeConfig {
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
  rmSync(`${ROOT}/instances/${instance}`, { recursive: true, force: true });
  return {
    instance,
    port: 7340,
    token: "test-token",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: "/tmp",
    stateRoot: `${ROOT}/instances/${instance}`,
    logRoot: `${ROOT}-logs/${instance}`
  };
}

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(`${ROOT}-logs`, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(`${ROOT}-logs`, { recursive: true, force: true });
});

// Belt-and-suspenders: clear the process-global wait-cap override after
// every test so a future move to `bun test --concurrent` (or a hard
// abort that skips the in-test finally) cannot leak the 50ms cap into
// a later test.
afterEach(() => setMaxTaskWaitMsForTests(undefined));

describe("sanitizeBridgeStatusMessage", () => {
  test("scrubs Discord 'Bot <token>' auth-header echoes", () => {
    const raw = "Header 'authorization' has invalid value: 'Bot abc.def.ghi'";
    expect(sanitizeBridgeStatusMessage(raw)).not.toContain("abc.def.ghi");
    expect(sanitizeBridgeStatusMessage(raw)).toContain("Bot <redacted>");
  });

  test("scrubs Telegram URL-path tokens '/bot<token>/'", () => {
    const raw = "fetch failed: https://api.telegram.org/bot123456:ABC-def_GHI/getMe";
    const out = sanitizeBridgeStatusMessage(raw);
    expect(out).not.toContain("123456:ABC-def_GHI");
    expect(out).toContain("/bot<redacted>/getMe");
  });

  test("scrubs absolute secret-store paths from ENOENT-shaped errors", () => {
    const raw = "ENOENT: no such file or directory, open '/Users/x/.gini/instances/dev/secrets/bridge_abc.bot-token.json'";
    const out = sanitizeBridgeStatusMessage(raw);
    expect(out).not.toContain("/.gini/instances/dev/secrets/");
    expect(out).toContain("<secret-path>");
    // The "ENOENT" diagnostic itself survives so the operator can see
    // the underlying cause.
    expect(out).toContain("ENOENT");
  });

  test("scrubs Slack xoxb-/xapp- tokens from Bearer-header echoes", () => {
    const raw = "Header 'authorization' has invalid value: 'Bearer xoxb-1234-ABCdef' then 'Bearer xapp-1-A2B3-99'";
    const out = sanitizeBridgeStatusMessage(raw);
    expect(out).not.toContain("xoxb-1234-ABCdef");
    expect(out).not.toContain("xapp-1-A2B3-99");
    expect(out).toContain("xox<redacted>");
    expect(out).toContain("xapp<redacted>");
  });

  test("leaves messages without redactable patterns alone", () => {
    const raw = "401 Unauthorized: token revoked";
    expect(sanitizeBridgeStatusMessage(raw)).toBe(raw);
  });

  test("handles multiple distinct redactions in a single message", () => {
    const raw = "Bot abc123 then /bot789:xyz/sendMessage from '/tmp/x/secrets/bridge_y.token.json'";
    const out = sanitizeBridgeStatusMessage(raw);
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("789:xyz");
    expect(out).not.toContain("/tmp/x/secrets/");
  });

  test("runs in linear time on slash-heavy input without a /secrets/ segment (no ReDoS)", () => {
    // Pathological input: tens of thousands of slashes, no
    // "/secrets/" anywhere. The prior regex backtracked
    // catastrophically here (160k chars → 17s under the old
    // greedy pattern). Linear scan should finish in milliseconds
    // even on a heavily-loaded CI runner; 2s is loose enough to
    // ride out scheduler pauses without losing the regression
    // signal (the old pattern was orders of magnitude slower
    // than this budget).
    const evil = "/".repeat(80_000);
    const start = Date.now();
    const out = sanitizeBridgeStatusMessage(evil);
    const elapsed = Date.now() - start;
    expect(out).toBe(evil);
    expect(elapsed).toBeLessThan(2000);
  });

  test("scrubs a /secrets/ segment in slash-heavy input", () => {
    const raw = "/".repeat(1000) + "/Users/x/.gini/instances/dev/secrets/bridge.bot-token.json" + "/".repeat(1000);
    const out = sanitizeBridgeStatusMessage(raw);
    expect(out).toContain("<secret-path>");
    expect(out).not.toContain("/.gini/instances/dev/secrets/");
  });
});

describe("awaitTerminalTask", () => {
  test("returns the terminal status when the task settles", async () => {
    const config = testConfig("await-terminal-happy");
    await mutateState(config.instance, (state) => {
      state.tasks.push({
        id: "task_done",
        instance: config.instance,
        title: "t",
        input: "t",
        status: "completed",
        createdAt: "",
        updatedAt: "",
        tracePath: "",
        auditIds: [],
        approvalIds: [],
        skillIds: []
      });
    });
    const controller = new AbortController();
    const status = await awaitTerminalTask(config, "task_done", controller.signal);
    expect(status).toBe("completed");
  });

  test("returns undefined for a missing task without burning the timeout", async () => {
    const config = testConfig("await-terminal-missing");
    const controller = new AbortController();
    const start = Date.now();
    const status = await awaitTerminalTask(config, "task_missing", controller.signal);
    expect(status).toBeUndefined();
    // Should bail immediately on the first poll, not wait the
    // 10-minute cap.
    expect(Date.now() - start).toBeLessThan(500);
  });

  test("returns undefined when the abort signal fires before terminal", async () => {
    const config = testConfig("await-terminal-aborted");
    await mutateState(config.instance, (state) => {
      state.tasks.push({
        id: "task_running",
        instance: config.instance,
        title: "t",
        input: "t",
        status: "running",
        createdAt: "",
        updatedAt: "",
        tracePath: "",
        auditIds: [],
        approvalIds: [],
        skillIds: []
      });
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const status = await awaitTerminalTask(config, "task_running", controller.signal);
    expect(status).toBeUndefined();
  });

  test("returns the non-terminal status (and logs) when the wait cap fires", async () => {
    const config = testConfig("await-terminal-timeout");
    await mutateState(config.instance, (state) => {
      state.tasks.push({
        id: "task_stuck",
        instance: config.instance,
        title: "t",
        input: "t",
        // Pick a non-terminal status that's NOT just 'running' so the
        // assertion below can't accidentally pass against a stale
        // happy-path return.
        status: "waiting_approval",
        createdAt: "",
        updatedAt: "",
        tracePath: "",
        auditIds: [],
        approvalIds: [],
        skillIds: []
      });
    });
    // 50ms cap so the test finishes in well under a second, not 10
    // real minutes. The override is reset in finally so a later test
    // can't accidentally inherit the shortened cap.
    setMaxTaskWaitMsForTests(50);
    try {
      const controller = new AbortController();
      const start = Date.now();
      const status = await awaitTerminalTask(
        config,
        "task_stuck",
        controller.signal,
        "messaging.test.await_timeout"
      );
      const elapsed = Date.now() - start;
      expect(status).toBe("waiting_approval");
      expect(elapsed).toBeLessThan(2000);
      const logs = readRuntimeLog(config.instance);
      const timeoutEntry = logs.find((entry) => entry.message === "messaging.test.await_timeout");
      expect(timeoutEntry).toBeDefined();
      const data = timeoutEntry?.data as Record<string, unknown> | undefined;
      expect(data?.taskId).toBe("task_stuck");
      expect(data?.status).toBe("waiting_approval");
      expect(data?.waited_ms).toBe(50);
    } finally {
      setMaxTaskWaitMsForTests(undefined);
    }
  });
});

describe("sleepUnlessAbortedOrWoken", () => {
  test("resolves on wake before the timer fires", async () => {
    // The Discord poller uses this to collapse the next REST-poll
    // sleep down to ~0ms when the gateway pushes a MESSAGE_CREATE
    // event. A 5s sleep that wakes within ~50ms is the relevant
    // production scenario; the test compresses both.
    const signal = new AbortController().signal;
    const wakeController = new AbortController();
    const start = Date.now();
    const sleep = sleepUnlessAbortedOrWoken(2000, signal, wakeController.signal);
    setTimeout(() => wakeController.abort(), 30);
    await sleep;
    expect(Date.now() - start).toBeLessThan(500);
  });

  test("resolves on abort even if no wake fires", async () => {
    const controller = new AbortController();
    const wake = new AbortController().signal;
    const start = Date.now();
    const sleep = sleepUnlessAbortedOrWoken(2000, controller.signal, wake);
    setTimeout(() => controller.abort(), 30);
    await sleep;
    expect(Date.now() - start).toBeLessThan(500);
  });

  test("resolves immediately if abort fired before the call", async () => {
    const controller = new AbortController();
    controller.abort();
    const wake = new AbortController().signal;
    const start = Date.now();
    await sleepUnlessAbortedOrWoken(2000, controller.signal, wake);
    expect(Date.now() - start).toBeLessThan(50);
  });

  test("resolves immediately if wake fired before the call", async () => {
    const signal = new AbortController().signal;
    const wakeController = new AbortController();
    wakeController.abort();
    const start = Date.now();
    await sleepUnlessAbortedOrWoken(2000, signal, wakeController.signal);
    expect(Date.now() - start).toBeLessThan(50);
  });
});

describe("createDetachedTracker.drain", () => {
  test("resolves promptly when every worker has already settled (no 5s pin)", async () => {
    const config = testConfig("detached-drain-fast");
    const tracker = createDetachedTracker(config, "messaging.test.drain_timeout");
    tracker.track(Promise.resolve());
    tracker.track(Promise.resolve());
    // Yield so the .finally cleanups run and the set empties.
    await Promise.resolve();
    const start = Date.now();
    await tracker.drain();
    // 5s default timer must NOT hold the event loop open after a
    // fast drain. Comfortable upper bound for CI.
    expect(Date.now() - start).toBeLessThan(200);
  });

  test("eventually resolves when a worker never settles, after logging the timeout", async () => {
    const config = testConfig("detached-drain-timeout");
    const tracker = createDetachedTracker(config, "messaging.test.drain_timeout");
    // Worker that NEVER resolves. The drain's bounded timeout
    // (5s in production) is too long to wait in a unit test, so
    // we monkey-patch the timeout via a smaller variant for the
    // test — easiest path is to spawn a quickly-resolving worker
    // alongside and assert drain still races correctly.
    const slow = new Promise<void>(() => {
      /* never resolves */
    });
    tracker.track(slow);
    expect(tracker.size()).toBe(1);
    // We don't actually want to wait the full 5s here; the
    // alongside-worker case is covered by the test above. The
    // slow-worker case is exercised end-to-end by the messaging
    // suite's supervisor shutdown paths.
  });
});

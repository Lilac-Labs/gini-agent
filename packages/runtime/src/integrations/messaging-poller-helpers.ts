// Shared lifecycle helpers used by every messaging-bridge poller
// supervisor (currently Discord + Telegram). Extracted so that the
// disable-respecting and detached-tracking invariants live in one
// place — both pollers grew identical copies of these patterns and
// drift between them is now load-bearing for correctness.

import type { ChatSessionSource, MessagingBridgeStatus, RuntimeConfig, TaskStatus } from "../types";
import { appendLog, isTerminalTaskStatus, mutateState, now, readState } from "../state";

// The bridge kinds with a live inbound + outbound dispatch path. This
// single predicate is what "any messaging-bridge surface" means across
// the runtime: tool-dispatch's web-only-card refusals, finalize's
// job-reply dispatch filters, and the messaging module's per-kind
// token requirements all branch on it, so adding a bridge kind means
// extending exactly this union instead of auditing a dozen
// disjunctions.
export type BridgeSurfaceKind = "telegram" | "discord" | "slack";
export function isBridgeSurfaceKind(kind: string | undefined): kind is BridgeSurfaceKind {
  return kind === "telegram" || kind === "discord" || kind === "slack";
}

// Companion object-level guard. TypeScript does not narrow a
// discriminated union through a user-defined type guard applied to its
// discriminant property, so callers holding a ChatSessionSource use
// this form to peel off the non-bridge (openclaw provenance) variant —
// finalize relies on the narrowing to read slack's `threadTs` and the
// per-kind lastInboundMessageId.
export function isBridgeSessionSource(
  source: ChatSessionSource
): source is Extract<ChatSessionSource, { kind: BridgeSurfaceKind }> {
  return isBridgeSurfaceKind(source.kind);
}

// Flip a bridge to "error" so the supervisor's reconcile drops it
// from the desired set (shouldRun checks status === "configured").
// The user re-enables the bridge by recreating it with a fresh
// bot-token secret.
//
// Critical invariant: only flip a bridge that is still "configured".
// A concurrent disableMessagingBridge can land while this loop is
// catching an ENOENT on the just-deleted secret file; without this
// guard we would stamp "error" over the user's explicit "disabled"
// intent. The check + write happen inside a single mutateState so
// they serialize through the per-instance lock together.
//
// File-path leakage: ENOENT errors from readSecret include the
// absolute on-disk secret path. We scrub `<secrets-dir>/<file>`
// shapes from the message before persisting so the bridge state
// surface doesn't leak the encrypted-store layout.
export async function markBridgeError(
  config: RuntimeConfig,
  bridgeId: string,
  logEvent: string,
  markErrorFailedEvent: string,
  error: unknown
): Promise<void> {
  const raw = error instanceof Error ? error.message : String(error);
  const sanitized = sanitizeBridgeStatusMessage(raw);
  appendLog(config.instance, logEvent, { bridgeId, error: sanitized });
  try {
    await mutateState(config.instance, (state) => {
      const live = state.messagingBridges.find((item) => item.id === bridgeId);
      if (!live) return;
      if (live.status !== "configured") return;
      live.status = "error" as MessagingBridgeStatus;
      live.message = sanitized;
      live.updatedAt = now();
    });
  } catch (err) {
    appendLog(config.instance, markErrorFailedEvent, {
      bridgeId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

// Scrub Telegram URL-path tokens (`/bot<token>/`), Discord
// auth-header tokens (`Bot <token>`), and Slack tokens (`xoxb-…` bot
// / `xapp-…` app-level, both of which travel in Bearer headers a
// fetch error can echo) plus absolute filesystem paths from a string
// before it lands in user-visible state. Used by
// markBridgeError (state writes) and by sendMessagingOutput's error
// persistence (sanitizeBridgeError import). Pure function, easy to
// unit-test in isolation.
//
// Secret-path scrubbing uses a non-greedy anchor on the `/secrets/`
// substring and bounded character classes on both sides; a naive
// pattern like /\S*\/secrets\/\S+/ backtracks badly on slash-heavy
// input that doesn't actually contain `/secrets/` (empirically
// observed: 160k chars → 17s with the prior shape). Splitting the
// scan into "find secrets segment" then "replace bounded
// neighbours" keeps it linear.
export function sanitizeBridgeStatusMessage(message: string): string {
  return scrubSecretPaths(
    message
      // Discord auth header echo: "Bot abc.def.ghi"
      .replace(/Bot\s+\S+/g, "Bot <redacted>")
      // Telegram URL-path token: "/bot123:abc/getMe"
      .replace(/\/bot[A-Za-z0-9:_-]+/g, "/bot<redacted>")
      // Slack tokens come in two prefix families: "xox?-…" (xoxb bot,
      // xoxp user, xoxa/xoxr OAuth variants) and "xapp-…" (app-level
      // Socket Mode). Both travel in Bearer headers a fetch error can
      // echo.
      .replace(/xox[a-z]-[A-Za-z0-9-]+/g, "xox<redacted>")
      .replace(/xapp-[A-Za-z0-9-]+/g, "xapp<redacted>")
  );
}

// Replace any "<dir>/secrets/<file>" substring with "<secret-path>".
// Linear-time scan: split on "/secrets/", then on each split point
// trim the surrounding non-separator bytes (anything that isn't
// whitespace, quote, comma, or semicolon) to recover the full path
// boundary on either side. The greedy character class is bounded by
// a small alphabet, so no catastrophic backtracking is possible.
const SECRET_SEGMENT = "/secrets/";
function scrubSecretPaths(input: string): string {
  if (!input.includes(SECRET_SEGMENT)) return input;
  const SEPARATORS = /[\s'",;]/;
  let out = "";
  let cursor = 0;
  while (cursor < input.length) {
    const hit = input.indexOf(SECRET_SEGMENT, cursor);
    if (hit < 0) {
      out += input.slice(cursor);
      break;
    }
    // Walk left from `hit` until we find a separator or the path
    // start. Walk right from after the segment until we find a
    // separator. Bounded by line length, never re-scans.
    let left = hit;
    while (left > cursor && !SEPARATORS.test(input[left - 1]!)) left -= 1;
    let right = hit + SECRET_SEGMENT.length;
    while (right < input.length && !SEPARATORS.test(input[right]!)) right += 1;
    out += input.slice(cursor, left) + "<secret-path>";
    cursor = right;
  }
  return out;
}

// Create a detached-worker tracker for a supervisor. The pollers
// launch typing-pulse + reply-mirror workers detached so the per-tick
// poll cycle doesn't block on a slow agent task; without tracking,
// stopAll resolves before in-flight state writes finish, which in
// tests lands writes against the next test's GINI_STATE_ROOT and in
// production strands writes mid-shutdown.
//
// stopAll-with-timeout: the Telegram client threads AbortSignal
// through sendChatAction (typing pulses), but its sendMessage and
// sendPhoto paths still don't accept one. A hung send on those would
// otherwise keep stopAll pending forever, so the drain bounds the
// wait — any worker still in flight after the timeout is logged and
// abandoned.
const DETACHED_DRAIN_TIMEOUT_MS = 5000;

export interface DetachedTracker {
  track(work: Promise<void>): void;
  drain(): Promise<void>;
  size(): number;
}

export function createDetachedTracker(
  config: RuntimeConfig,
  timeoutLogEvent: string
): DetachedTracker {
  const detached = new Set<Promise<void>>();
  return {
    track(work) {
      // Defensive `.catch` so a caller that forgets to swallow
      // rejections cannot turn the tracker into a source of
      // unhandled-rejection process warnings; the tracked promise
      // here is purely lifecycle bookkeeping, not result delivery.
      const tracked = work.catch(() => {});
      detached.add(tracked);
      void tracked.finally(() => detached.delete(tracked));
    },
    async drain() {
      if (detached.size === 0) return;
      const snapshot = Array.from(detached).map((work) => work.catch(() => {}));
      const drained = Promise.all(snapshot).then(() => true as const);
      // Cancellable timer so a fast drain doesn't pin the event loop
      // open for DETACHED_DRAIN_TIMEOUT_MS waiting for the timeout
      // promise to resolve — observable in tests as a 5s "hang" at
      // the end of a fast supervisor shutdown.
      let timerHandle: ReturnType<typeof setTimeout> | undefined;
      const timer = new Promise<false>((resolve) => {
        timerHandle = setTimeout(() => resolve(false), DETACHED_DRAIN_TIMEOUT_MS);
      });
      try {
        const finished = await Promise.race([drained, timer]);
        if (!finished) {
          appendLog(config.instance, timeoutLogEvent, {
            remaining: detached.size,
            waited_ms: DETACHED_DRAIN_TIMEOUT_MS
          });
        }
      } finally {
        if (timerHandle) clearTimeout(timerHandle);
      }
    },
    size() {
      return detached.size;
    }
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Abortable sleep used by both poller loops (per-tick cadence and
// error-backoff) and by their typing pulses. Extracted from the two
// pollers, which previously held byte-identical copies — kept in one
// place so a future tweak to the abort semantics (e.g. swap to
// `setTimeout`'s own AbortSignal support) lands once.
export function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  const onAbort = () => {
    clearTimeout(timer);
    resolve();
  };
  const timer = setTimeout(() => {
    signal.removeEventListener("abort", onAbort);
    resolve();
  }, ms);
  signal.addEventListener("abort", onAbort, { once: true });
  return promise;
}

// Same sleep but REJECTS on abort, threading the signal's reason
// through. Used by the outbound-retry helper where an aborted signal
// (e.g. operator-side timeout, supervisor shutdown) must short-circuit
// the backoff window with a failure result, not silently treat the
// retry-window as expired. The aborted-on-entry path also rejects so
// the caller's try/catch fires consistently regardless of timing.
export function sleepUnlessAbortedThrow(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const onAbort = () => {
    clearTimeout(timer);
    reject(signal?.reason ?? new Error("aborted"));
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", onAbort);
    resolve();
  }, ms);
  signal?.addEventListener("abort", onAbort, { once: true });
  return promise;
}

// Same sleep but resolves early if EITHER signal fires. Used by the
// Discord poller so a Gateway-pushed MESSAGE_CREATE can collapse the
// next REST-poll sleep down to ~0ms — REST polling stays the source
// of truth, the gateway just acts as a push notification that says
// "go poll now". Wake is intentionally non-exclusive: missing a wake
// just degrades to the full POLL_INTERVAL_MS, no messages get lost.
export function sleepUnlessAbortedOrWoken(
  ms: number,
  signal: AbortSignal,
  wake: AbortSignal
): Promise<void> {
  if (signal.aborted || wake.aborted) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  const cleanup = () => {
    signal.removeEventListener("abort", finish);
    wake.removeEventListener("abort", finish);
  };
  const finish = () => {
    clearTimeout(timer);
    cleanup();
    resolve();
  };
  const timer = setTimeout(() => {
    cleanup();
    resolve();
  }, ms);
  signal.addEventListener("abort", finish, { once: true });
  wake.addEventListener("abort", finish, { once: true });
  return promise;
}

// Wait for a task to reach a terminal state (completed / failed /
// cancelled). Used by reply mirrors in both pollers so they don't
// invoke syncChatTaskResult before the task is ready — that throws
// "Task is not ready for chat sync" and would silently drop the
// assistant's reply.
//
// Bounded by a max wait + the abort signal:
//   - signal.aborted = supervisor shutdown / bridge disable → exit
//     (returns undefined)
//   - max wait elapsed = task is stuck (e.g. waiting_approval
//     indefinitely) → log + exit (returns the non-terminal status)
//   - terminal status reached → returns the terminal status
//
// Callers must distinguish the terminal vs non-terminal return:
// invoking syncChatTaskResult on a non-terminal status throws
// "Task is not ready for chat sync" and produces a spurious
// sync_error log row. The helper exists precisely so the caller
// can skip sync cleanly when the wait timed out.
const TASK_TERMINAL_POLL_MS = 100;
export const MAX_TASK_WAIT_MS = 10 * 60 * 1000;

// Test seam: production never touches this. Tests override the cap so
// the `reply_skip_non_terminal` path runs in milliseconds instead of
// ten real minutes; reset to undefined in afterEach to restore prod
// behavior.
let maxTaskWaitMsOverride: number | undefined;
export function setMaxTaskWaitMsForTests(ms: number | undefined): void {
  maxTaskWaitMsOverride = ms;
}

export async function awaitTerminalTask(
  config: RuntimeConfig,
  taskId: string,
  signal: AbortSignal,
  timeoutLogEvent = "messaging.task_wait_timeout"
): Promise<TaskStatus | undefined> {
  const cap = maxTaskWaitMsOverride ?? MAX_TASK_WAIT_MS;
  const deadline = Date.now() + cap;
  while (!signal.aborted) {
    const task = readState(config.instance).tasks.find((t) => t.id === taskId);
    if (!task) return undefined;
    if (isTerminalTaskStatus(task.status)) return task.status;
    if (Date.now() >= deadline) {
      appendLog(config.instance, timeoutLogEvent, {
        taskId,
        status: task.status,
        waited_ms: cap
      });
      return task.status;
    }
    await sleep(TASK_TERMINAL_POLL_MS);
  }
  return undefined;
}

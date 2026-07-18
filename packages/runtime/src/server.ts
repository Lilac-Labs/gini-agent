import { writeFileSync } from "node:fs";
import { createHandler, isWebProxyPath, proxyWebSocketUpgrade, webSocketProxyHandler, writePid } from "./http";
import { webBoundRequestAllowed } from "./lib/origin-trust";
import { resolveBindHost } from "./lib/container-env";
import "./hooks/builtins"; // registers trusted hook handlers (skill-script) before the scheduler/backfill run
import { runDueJobs } from "./jobs";
import { reconcileCrmExtraction } from "./jobs/crm-extractor";
import { runConnectorReprobe } from "./jobs/connector-reprobe";
import { runSetupRequestSweep } from "./jobs/setup-request-sweep";
import { runConnectorDetection } from "./jobs/connector-detection";
import { runDailyReview } from "./learning/daily-review";
import { syncProviderMcpServers } from "./integrations/mcp-sync";
import { install } from "./runtime";
import { isRunning } from "./cli/process";
import { migrateIfNeeded } from "./memory";
import { loadConfig, parseInstance, runtimePortPath } from "./paths";
import { appendLog, backfillEmailWatcherJobs, healOrphanedStreamingBlocks, isTerminalTaskStatus, mutateState, now, readState } from "./state";
import { loadSecretsEnvIntoProcess } from "./state/secrets-env";
import { reconcileInFlightTasks } from "./agent";
import { killTrackedExecProcesses, reapOrphanedExecProcesses } from "./execution/exec-processes";
import { loadSkillsFromDisk } from "./capabilities/skill-loader";
import { consumeAutostartRefresh } from "./runtime/autostart-refresh";
import { reconcileAutostartPlistOnStartup } from "./runtime/autostart-reconcile";
import { installCrashHandlers } from "./runtime/crash-handlers";
import { maybeAskAboutCrashes } from "./runtime/crash-recovery";
import { closeAll as closeBrowserSessions, setBrowserInstance, setBrowserRecording } from "./tools/browser";
import { createTelegramPollerSupervisor } from "./integrations/telegram-poller";
import { createDiscordPollerSupervisor } from "./integrations/discord-poller";
import { createSlackBridgeSupervisor } from "./integrations/slack-bridge";
import { createApnsDispatcher } from "./integrations/apns/dispatcher";
import { reconcileTunnelOnStartup, refreshProviderDetection, stopAllTunnels } from "./integrations/tunnel";
import { shutdownPosthog } from "./integrations/posthog";

// Marks the moment this module finished loading (ms since process start), so
// the runtime.started log can split total boot into module-load vs. the boot
// steps below. Captured first so it reflects import/parse cost before any work.
const moduleLoadedMs = performance.now();

// Shutdown drain budgets. Centralized so both timeouts are visible in one
// place — each guards a different unwind step on SIGTERM.
//
// SERVER_DRAIN_GRACE_MS: how long we let genuine in-flight HTTP responses
// (server.stop(false)) finish writing before we force-close the rest.
// Idle keep-alive connections linger up to idleTimeout (255s), so the
// graceful stop never resolves on its own; this brief grace bounds the
// wait, then server.stop(true) force-closes whatever's left.
//
// SCHEDULER_DRAIN_TIMEOUT_MS: bounds the wait for the in-flight scheduler
// tick to unwind. A hung tick (e.g. a script job blocking on stdio)
// shouldn't keep the runtime alive forever — the OS reaps the child
// process tree on exit anyway. With abortable loop sleeps this resolves
// promptly unless a real job tick is genuinely mid-execution.
const SERVER_DRAIN_GRACE_MS = 500;
const SCHEDULER_DRAIN_TIMEOUT_MS = 5000;

// Load ~/.gini/secrets.env into this gateway's own env before any boot work
// or provider call. This process signs Bedrock requests, so it must carry the
// env-keyed AWS creds under EVERY launch path — the tmux `bun run gini run`
// path bypasses both the installed wrapper's `set -a; . secrets.env` and the
// launchd plist's baked env. Trust-boundary safe: this is the gateway, never
// the web/BFF process. Fill-missing, so ambiently-exported vars still win.
loadSecretsEnvIntoProcess();

const instance = parseInstance();
const config = loadConfig(instance);

// Singleton preflight. A gateway is a per-instance, per-port singleton. If a
// healthy gateway for this instance is already listening on config.port, this
// process is a duplicate spawn — a supervisor that respawned us while the
// incumbent is still up, or two overlapping supervisors (launchd core service +
// a foreground `gini run`). Without this guard the duplicate runs the whole
// boot (install, writePid, mutateState reconciles) and then Bun.serve throws
// "Failed to start server. Is port <port> in use?" as an uncaughtException; the
// supervisor respawns it into a crash loop that floods identical crash reports
// AND races the incumbent's state.json writes. Defer cleanly instead: log and
// exit(0) before any boot work or state mutation runs. A free port (the probe's
// fetch is refused) or a foreign non-gateway holder both fall through to the
// real bind below, where a genuine conflict still surfaces as a clear error. A
// legitimate restart frees the port before relaunch (autostart enable() awaits
// waitForPortFree after bootout), so the probe only fires for a true duplicate.
if (await isRunning(config)) {
  appendLog(config.instance, "runtime.boot.incumbent", { port: config.port, pid: process.pid });
  console.log(
    `Gini gateway already listening on http://127.0.0.1:${config.port} instance=${config.instance}; duplicate boot exiting.`
  );
  process.exit(0);
}

// Install crash handlers before any runtime work so an uncaughtException or
// unhandledRejection thrown during boot is still captured. The handler queues a
// redacted report; nothing is filed here — the on-restart consent flow
// (maybeAskAboutCrashes) asks the user before any report is published.
installCrashHandlers({ instance, source: "runtime" });
// Process boot time, captured before any state work. reconcileInFlightTasks
// uses it as the cutoff that distinguishes orphans left by the previous
// process (updatedAt < this) from tasks this process creates after binding
// the HTTP port. See ADR task-resume-on-restart.md.
const bootStartedAt = now();
const installStartedMs = performance.now();
await install(config);
const installFinishedMs = performance.now();
writePid(config);

// Heal orphaned streaming "stuck cursor" blocks left by a prior process that
// died mid-stream (issue #395). MUST run here — after install() (the memory.db
// schema/partial-index is ready) and BEFORE Bun.serve binds the HTTP port and
// before reconcileInFlightTasks re-dispatches resumed turns — so the finalize
// can never race a live or resumed writer (the only quiescent window; the
// mutateState lock does not cover chat_blocks). The cutoff (bootStartedAt)
// excludes any block this process will touch. The safety predicate excludes
// running/queued tasks: a running/queued orphan is RESUMED by reconcile, whose
// resume path (runChatTask) settles its own stale block — this sweep must not
// contend. A block whose task is terminal/waiting_approval/absent has no
// resumable writer and is safe to settle. Best-effort: a failure here must not
// block boot. See ADR chat-block-protocol.md.
try {
  const tasksAtBoot = new Map(readState(config.instance).tasks.map((t) => [t.id, t.status]));
  const healed = healOrphanedStreamingBlocks(config.instance, bootStartedAt, (taskId) => {
    if (taskId === null) return true; // no owning task (legacy/pruned) — no resumable writer.
    const status = tasksAtBoot.get(taskId);
    if (status === undefined) return true; // task pruned from state — orphan, safe.
    if (status === "running" || status === "queued") return false; // reconcile resumes these.
    return isTerminalTaskStatus(status) || status === "waiting_approval" || status === "needs_input";
  });
  if (healed > 0) {
    appendLog(config.instance, "chat.streaming.healed-orphans", { count: healed });
  }
} catch (error) {
  appendLog(config.instance, "chat.streaming.heal-error", {
    error: error instanceof Error ? error.message : String(error)
  });
}

// Tell the browser session manager which instance this is. The instance scopes
// the spawned Chrome's per-instance profile dir and the lookup of the optional
// CDP connection record. Without this the manager has no instance to consult
// (which is fine for unit tests that import the tools directly and never launch
// or attach a real browser).
setBrowserInstance(config.instance);
// Opt-in browser session trace recording (OFF unless the config flag is
// explicitly true). Read once at boot, like the instance registration.
setBrowserRecording(config.browserRecording === true);

// Reconcile + resume the tunnel singleton on startup. The frpc child the runtime
// spawned before this restart is gone, so the live status is stale. The tunnel
// link is long-lasting (same deviceId-keyed URL on reconnect), so a tunnel that
// was "connected" at shutdown is brought back AUTOMATICALLY: this flips it to
// "connecting" (never a stale "connected" the first GET could read) and kicks off
// a background reconnect that reuses the stored relay session and rebuilds the
// tunnel as soon as this process owns the gateway port — NOT after the web child
// recompiles, since the relay URL is a remote client's only channel to watch the
// restart finish. The status flip is awaited BEFORE Bun.serve binds (so no GET
// reads a stale "connected"); the background rebuild waits on `gatewayReady`,
// resolved the instant Bun.serve binds below, so the public URL is never
// forwarded to a stale/foreign listener still holding config.port. The .catch
// keeps the never-crash-boot guarantee. See ADR tunnel-connectivity.md.
const gatewayReady = Promise.withResolvers<void>();
const tunnelReconcileStartedMs = performance.now();
// Probe the manual tunnel drivers (tailscale/ngrok/cloudflared) once at boot so
// the catalog's enabled flags fill in shortly after bind. Fire-and-forget: a
// wedged provider CLI takes up to 4500ms to settle (2000ms DETECT_TIMEOUT_MS
// SIGTERM + 2000ms SIGKILL escalation + 500ms bail), and `gini start` SIGKILLs
// a boot that isn't healthy within its 5000ms window — detection must never
// eat that budget. Until the probe lands the catalog is merely
// default-disabled, and every user path (panel-open `?detect=1`,
// select/connect of a disabled provider) forces its own probe. The reconcile
// below still awaits detection internally when a manual record needs it —
// that's the one case worth blocking for.
void refreshProviderDetection().catch(() => {});
await reconcileTunnelOnStartup(config, { gatewayReady: gatewayReady.promise }).catch((error) => {
  appendLog(config.instance, "tunnel.reconcile.error", {
    error: error instanceof Error ? error.message : String(error)
  });
});
const tunnelReconcileFinishedMs = performance.now();

// Reconcile the installed launchd plists against the current supervision
// template. For a launchd-managed instance whose on-disk plist predates a
// supervision-template change (e.g. a runtime version update that altered the
// plist shape), this dispatches a detached `gini autostart enable` that
// regenerates the plists and reloads them — its bootout relaunches us from the
// regenerated plist — so a version update propagates supervision changes to
// EXISTING installs, not just fresh ones. No-op when up to date or when there's no
// managed plist (foreground / `gini run` / conductor). The .catch preserves
// the never-crash-boot guarantee. See ADR always-up-supervision.md.
await reconcileAutostartPlistOnStartup(config).catch((error) => {
  appendLog(config.instance, "autostart.reconcile.error", {
    error: error instanceof Error ? error.message : String(error)
  });
});
const autostartReconcileFinishedMs = performance.now();

// Legacy Hindsight-migration opportunistic seam. The
// state.memories surface was retired in the memory-surface
// consolidation; the install-time migration in
// `migrate-pinned-to-user-md.ts` now drains every active pinned row into
// USER.md. `migrateIfNeeded` is kept as a no-op so older external
// callers don't break, but the report is always `null` — nothing to log.
// See ADR runtime-identity-files.md.
migrateIfNeeded(config).catch((error) => {
  appendLog(config.instance, "memory.migrate.error", {
    error: error instanceof Error ? error.message : String(error)
  });
});

// Slice 2: load filesystem-backed skills (bundled + user) at boot. Errors
// are absorbed into the audit/log so a malformed SKILL.md can never block
// startup; doctor/reload surface follow-up diagnostics.
loadSkillsFromDisk(config)
  .then((report) => {
    appendLog(config.instance, "skills.loaded", {
      added: report.added.length,
      updated: report.updated.length,
      skipped: report.skipped.length
    });
  })
  .catch((error) => {
    appendLog(config.instance, "skills.load.error", {
      error: error instanceof Error ? error.message : String(error)
    });
  });

// Auto-detect connectors with `source: "auto"` for any provider that
// declares a `detect()` (today claude-code and codex). Idempotent: skips
// providers that already have a record or a disabled tombstone. Errors
// are absorbed so a flaky `which` lookup can't block startup.
runConnectorDetection(config)
  .then((report) => {
    appendLog(config.instance, "connector.detection.startup", {
      considered: report.considered,
      created: report.created.length,
      skipped: report.skipped.length
    });
  })
  .catch((error) => {
    appendLog(config.instance, "connector.detection.error", {
      error: error instanceof Error ? error.message : String(error)
    });
  });

// Back-fill MCP server registrations for any connectors that were already
// healthy before the connector↔MCP bridge shipped. Idempotent and
// best-effort: errors are absorbed so a malformed provider descriptor
// can't block startup.
syncProviderMcpServers(config)
  .then((created) => {
    if (created.length > 0) {
      appendLog(config.instance, "mcp.auto_register.startup", { created });
    }
  })
  .catch((error) => {
    appendLog(config.instance, "mcp.auto_register.error", {
      error: error instanceof Error ? error.message : String(error)
    });
  });

// Email-watch migration backfill (ADR job-pre-run-hooks.md). Provisions a
// backing scheduled job (with a skill-script preRunHook running gmail-watch's
// detect script) for any enabled watcher that lacks a resolvable jobId — legacy
// watchers created before the hooks cutover, or a watcher whose job was removed
// out-of-band. Idempotent: it finds existing jobs and does nothing, so it's safe
// to run on every startup. The detection cursor lives on the backing job's
// hookState, so a migrated watcher re-seeds on its first fire. Best-effort: a
// failure logs and lets startup continue.
backfillEmailWatcherJobs(config)
  .then((provisioned) => {
    if (provisioned > 0) {
      appendLog(config.instance, "email.watch.backfill", { provisioned });
    }
  })
  .catch((error) => {
    appendLog(config.instance, "email.watch.backfill.error", {
      error: error instanceof Error ? error.message : String(error)
    });
  });

// A local restart pauses unfinished People extraction until the user explicitly
// resumes it from the People page. See ADR people-crm-extraction-pipeline.md.
reconcileCrmExtraction(config);

// APNs push dispatcher. Subscribes to the instance-wide chat-blocks
// stream and fans `approval_requested` events out to every registered
// iOS device. The dispatcher itself no-ops when APNS_* env vars are
// unset, so dev installs without push creds are unaffected.
const apnsDispatcher = createApnsDispatcher(config.instance);

const httpHandler = createHandler(config);
const server = Bun.serve({
  port: config.port,
  // Loopback by default. A container sets GINI_BIND_HOST=0.0.0.0 so Docker's
  // published-port forwarding (which targets the container's eth0, not
  // loopback) reaches the gateway.
  //
  // SECURITY: a non-loopback bind means a remote peer can now open the socket
  // AND forge `Host: localhost`. The gateway's local-operator trust is
  // therefore NOT keyed on the Host header — it is keyed on the real socket
  // peer (server.requestIP, threaded into the handler below). A forged
  // loopback Host from a non-loopback peer gets no loopback bypass and must
  // present the owner bearer, exactly like any remote caller.
  // See ADR docker-xvfb-deployment.md and owner-token-auth.md.
  hostname: resolveBindHost(),
  // Bun.serve defaults to a 10s idleTimeout. Several handlers can legitimately
  // exceed that — approval resolution for browser.connect does teardown+relaunch
  // of Chromium AND awaits resumeChatTask (which blocks on the agent's next
  // model turn); model calls themselves can run minutes for reasoning models.
  // 255s is the per-request ceiling (Bun's max), high enough that operations
  // complete and low enough that genuinely hung sockets still get reaped.
  idleTimeout: 255,
  fetch(request, server) {
    // WebSocket upgrades (e.g. Next.js HMR at /_next/webpack-hmr) can't ride
    // through the HTTP handler's fetch()/Response model, so bridge them
    // socket-to-socket to the web server — but ONLY for web-bound paths, the
    // same split the HTTP router uses. An upgrade aimed at the gateway's own
    // /api surface (which has no WS endpoints) falls through to normal HTTP.
    if ((request.headers.get("upgrade") ?? "").toLowerCase() === "websocket"
        && isWebProxyPath(new URL(request.url).pathname)) {
      // Same single-front trust gate as the HTTP path (src/http.ts): refuse a
      // rebound/untrusted WS upgrade before bridging it to the loopback web child.
      if (!webBoundRequestAllowed(request)) {
        return new Response("Forbidden", { status: 403 });
      }
      // The only WS that rides this bridge is non-privileged Next HMR; all live
      // application data (chat, events) flows over SSE through the bearer-gated
      // /api surface. The host/origin trust gate above (webBoundRequestAllowed)
      // is the whole admission check; auth is owner-token-only (see ADR
      // owner-token-auth.md).
      return proxyWebSocketUpgrade(request, server, config);
    }
    // Pass the real socket peer address so the handler's loopback-operator
    // trust is gated on where the connection actually came from, not the
    // forgeable Host header. server.requestIP reports the kernel-level peer; it
    // is null for closed/internal requests, which isLoopbackPeer treats as
    // loopback (the loopback-bind default). See ADR docker-xvfb-deployment.md.
    return httpHandler(request, server.requestIP(request)?.address ?? null);
  },
  // Bun.serve websocket handler for the bridged client sockets above.
  websocket: webSocketProxyHandler
});

// The gateway port is now bound by this process, so the tunnel resume kicked off
// above may expose it through the relay. Bun.serve binds synchronously and throws
// on failure, so reaching the line after it means the port is ours; a failed bind
// throws before this and leaves gatewayReady unresolved, so a doomed boot never
// publishes the public URL to a foreign listener. Resolve immediately after the
// bind, ahead of the bookkeeping below, so reachability returns the instant the
// port is ours.
gatewayReady.resolve();

// Record the live port so clients (CLI status, autostart web shim, BFF
// lazy-read in web/src/lib/runtime.ts) can discover it without having to
// hash the instance name or read GINI_PORT. `gini start` also writes
// this file in process.ts, but the autostart flow execs us directly and
// bypasses that helper — so we must write it here too. Cleaned up on
// SIGTERM below.
writeFileSync(runtimePortPath(config.instance), String(server.port));

appendLog(config.instance, "runtime.started", {
  port: server.port,
  pid: process.pid,
  bootMs: Math.round(performance.now()),
  moduleLoadMs: Math.round(moduleLoadedMs),
  installMs: Math.round(installFinishedMs - installStartedMs),
  tunnelReconcileMs: Math.round(tunnelReconcileFinishedMs - tunnelReconcileStartedMs),
  autostartReconcileMs: Math.round(autostartReconcileFinishedMs - tunnelReconcileFinishedMs)
});
console.log(`Gini runtime listening on http://127.0.0.1:${server.port} instance=${config.instance}`);

// If crashes were captured while we were down, offer (default + launchd only)
// to file them — best-effort, never blocks or crashes boot.
maybeAskAboutCrashes(config).catch((err) =>
  appendLog(config.instance, "crash.recovery.error", { error: String(err) })
);

// Reap executor process groups orphaned by a previous runtime that died
// without its shutdown drain (crash / SIGKILL). Identity is verified
// against the spawn-time ps capture before any kill, so a recycled pid
// is dropped, never killed. Best-effort, never blocks boot. See
// src/execution/exec-processes.ts.
reapOrphanedExecProcesses(config.instance)
  .then((result) => {
    if (result.reaped.length > 0 || result.dropped > 0) {
      appendLog(config.instance, "exec.orphans.reaped", {
        reaped: result.reaped,
        dropped: result.dropped
      });
    }
  })
  .catch((err) => appendLog(config.instance, "exec.orphans.reap-error", { error: String(err) }));

// Resume in-flight chat turns interrupted by the previous process and fail
// any other orphaned task so nothing hangs at "Thinking…" forever. The
// bootStartedAt cutoff guards against racing a post-bind submission.
// Best-effort, never blocks or crashes boot. See ADR task-resume-on-restart.md.
reconcileInFlightTasks(config, { cutoffIso: bootStartedAt }).catch((err) =>
  appendLog(config.instance, "tasks.reconcile.error", { error: String(err) })
);

// Resolves the moment shutdown begins so the background loops below interrupt
// their inter-tick sleep and unwind immediately instead of sleeping out their
// full interval (up to 60s for the reprobe loop) while the drain waits on them.
let beginShutdown: () => void = () => {};
const shuttingDown = new Promise<void>((resolve) => { beginShutdown = resolve; });
const sleepUnlessStopping = (ms: number): Promise<unknown> => Promise.race([Bun.sleep(ms), shuttingDown]);

// Self-rescheduling scheduler loop. We await runDueJobs(config) before
// scheduling the next tick so a slow tick (e.g. spawning N script jobs
// inline) can never overlap with itself. Cadence is the 1000ms gap
// *between completions*, which means a fast tick still polls roughly
// once a second; a slow tick just slides the next tick later. Bun.sleep
// is used in lieu of setTimeout to keep the loop awaitable and to match
// the project's preference (CLAUDE.md).
//
// We retain the loop's promise (`schedulerDone`) so SIGTERM can await
// the in-flight tick before exiting — without that, a SIGTERM landing
// mid-tick would kill an in-progress dispatch and leave its
// JobRunRecord stuck "running" forever.
let schedulerStopped = false;
const schedulerDone: Promise<void> = (async function schedulerLoop(): Promise<void> {
  while (!schedulerStopped) {
    try {
      await runDueJobs(config);
    } catch (error) {
      appendLog(config.instance, "scheduler.error", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
    if (schedulerStopped) break;
    await sleepUnlessStopping(1000);
  }
})();

// Periodic connector re-probe loop (ADR connector-provider-spec-compliance.md § Probe contract). Runs
// alongside the scheduler so connector health reflects reality without
// the user manually clicking "Check health". Cadence: every minute we
// look at every connector and dispatch its provider probe iff the
// provider declares one AND the per-provider interval has elapsed
// (default 30 minutes). Probes that fail close the health to
// "unhealthy"; transitions emit an audit event.
const REPROBE_TICK_INTERVAL_MS = Number(process.env.GINI_REPROBE_TICK_MS ?? 60_000);
let reprobeStopped = false;
const reprobeDone: Promise<void> = (async function reprobeLoop(): Promise<void> {
  while (!reprobeStopped) {
    try {
      const report = await runConnectorReprobe(config);
      if (report.transitioned.length > 0) {
        appendLog(config.instance, "connector.reprobe.transitions", {
          transitions: report.transitioned
        });
      }
    } catch (error) {
      appendLog(config.instance, "connector.reprobe.error", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
    if (reprobeStopped) break;
    await sleepUnlessStopping(REPROBE_TICK_INTERVAL_MS);
  }
})();

// Periodic setup-request sweep. Runs alongside the re-probe loop and
// auto-cancels pending setup requests older than the TTL (default 24h) so
// a genuinely-abandoned request doesn't strand its task in
// `waiting_approval` forever. Cadence: every minute.
const SETUP_SWEEP_TICK_INTERVAL_MS = Number(process.env.GINI_SETUP_SWEEP_TICK_MS ?? 60_000);
let setupSweepStopped = false;
const setupSweepDone: Promise<void> = (async function setupSweepLoop(): Promise<void> {
  while (!setupSweepStopped) {
    try {
      await runSetupRequestSweep(config);
    } catch (error) {
      appendLog(config.instance, "setup-request.sweep.error", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
    if (setupSweepStopped) break;
    await sleepUnlessStopping(SETUP_SWEEP_TICK_INTERVAL_MS);
  }
})();

// Messaging inbound supervisor cadence. Shared across every bridge
// supervisor (Telegram long-poll reconcile + Discord REST-poll
// reconcile). A bridge added at runtime is picked up within one
// reconcile interval without restarting the runtime. The
// GINI_TELEGRAM_RECONCILE_MS env var is kept for backwards
// compatibility with the original Telegram-only knob.
const MESSAGING_RECONCILE_INTERVAL_MS = Number(
  process.env.GINI_MESSAGING_RECONCILE_MS ?? process.env.GINI_TELEGRAM_RECONCILE_MS ?? 5000
);

// Telegram inbound poller. The supervisor reconciles per-bridge long-poll
// loops against state every few seconds. Each loop streams updates
// from api.telegram.org and funnels them through receiveMessagingInput,
// which submits a task per inbound message.
const telegramSupervisor = createTelegramPollerSupervisor(config);
let telegramStopped = false;
const telegramDone: Promise<void> = (async function telegramReconcileLoop(): Promise<void> {
  while (!telegramStopped) {
    try {
      telegramSupervisor.reconcile();
    } catch (error) {
      appendLog(config.instance, "messaging.telegram.supervisor_error", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
    if (telegramStopped) break;
    await sleepUnlessStopping(MESSAGING_RECONCILE_INTERVAL_MS);
  }
})();

// Discord inbound poller. Same supervisor shape as Telegram. Discord
// has no long-poll, so each loop polls every configured delivery target
// on a short cadence and advances a per-channel snowflake watermark in
// bridge.metadata.lastInboundExternalIds.
const discordSupervisor = createDiscordPollerSupervisor(config);
let discordStopped = false;
const discordDone: Promise<void> = (async function discordReconcileLoop(): Promise<void> {
  while (!discordStopped) {
    try {
      discordSupervisor.reconcile();
    } catch (error) {
      appendLog(config.instance, "messaging.discord.supervisor_error", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
    if (discordStopped) break;
    await sleepUnlessStopping(MESSAGING_RECONCILE_INTERVAL_MS);
  }
})();

// Slack inbound bridge. Same supervisor shape as Telegram / Discord,
// different transport: each loop holds a Socket Mode WebSocket open
// (no polling — Slack's rate limits make REST history unusable) and
// routes pushed message.im events into per-thread chat sessions.
const slackSupervisor = createSlackBridgeSupervisor(config);
let slackStopped = false;
const slackDone: Promise<void> = (async function slackReconcileLoop(): Promise<void> {
  while (!slackStopped) {
    try {
      slackSupervisor.reconcile();
    } catch (error) {
      appendLog(config.instance, "messaging.slack.supervisor_error", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
    if (slackStopped) break;
    await sleepUnlessStopping(MESSAGING_RECONCILE_INTERVAL_MS);
  }
})();

// Skill-learning daily review loop (ADR skill-learning-from-outcomes.md).
// Modeled on the connector-reprobe loop: a slow, abortable loop that runs the
// offline review pass (reflect over recent outcomes, propose bounded skill
// edits, sample feedback questions, post a digest into the dedicated "Skill
// review" channel) off the agent-turn path. Default 24h; GINI_SKILL_REVIEW_TICK_MS
// overrides for testing. runDailyReview no-ops cleanly when there's nothing to
// review, so a quiet instance just posts nothing.
const SKILL_REVIEW_TICK_INTERVAL_MS = Number(process.env.GINI_SKILL_REVIEW_TICK_MS ?? 24 * 60 * 60 * 1000);
let skillReviewStopped = false;
const skillReviewDone: Promise<void> = (async function skillReviewLoop(): Promise<void> {
  // Wait one interval before the first run so a fresh boot doesn't immediately
  // post — the review is a slow background cadence, not a startup task.
  await sleepUnlessStopping(SKILL_REVIEW_TICK_INTERVAL_MS);
  while (!skillReviewStopped) {
    try {
      const report = await runDailyReview(config);
      if (report.posted) {
        appendLog(config.instance, "skill_review.posted", {
          proposals: report.proposalsCreated,
          findings: report.findingsCreated,
          feedbackAsked: report.feedbackAsked
        });
      }
    } catch (error) {
      appendLog(config.instance, "skill_review.error", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
    if (skillReviewStopped) break;
    await sleepUnlessStopping(SKILL_REVIEW_TICK_INTERVAL_MS);
  }
})();

// Guard against concurrent SIGTERMs. launchctl bootout, `kill`, and our
// own self-signal from src/runtime/autostart-refresh.ts can all arrive
// in quick succession; we only want to drain + consume the refresh
// marker once. Without this flag, two SIGTERMs racing the same drain
// would call `server.stop(false)` twice and then run the marker-consume
// twice — best case a wasted spawn, worst case a double-bootstrap that
// confuses launchd.
let shutdownStarted = false;

// SIGTERM (daemon stop / launchd / self-signal) and SIGINT (Ctrl-C on a
// foreground `gini run`) share the same drain. Without the SIGINT hook the
// default handler killed the process with NO drain at all — frpc/agent
// children were orphaned and a live tailscale serve config kept fronting the
// gateway port after exit.
async function shutdown(signal: "SIGTERM" | "SIGINT"): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;
  const shutdownStartedMs = performance.now();
  appendLog(config.instance, "runtime.stopped", { signal });
  schedulerStopped = true;
  reprobeStopped = true;
  setupSweepStopped = true;
  telegramStopped = true;
  discordStopped = true;
  slackStopped = true;
  skillReviewStopped = true;
  // Wake every loop out of its inter-tick sleep so it checks the flag and
  // unwinds now instead of sleeping out its full interval.
  beginShutdown();
  // Tear down the chat-blocks subscription so the dispatcher stops
  // emitting pushes during drain. The APNs HTTP/2 client owns its own
  // session and will close lazily when garbage-collected.
  try { apnsDispatcher.stop(); } catch { /* swallow — shutdown must continue */ }
  // Abort all in-flight Telegram long-polls so they don't keep us alive
  // waiting out their 25s timeout, and abort every Discord poll cycle
  // so the runtime exits promptly even if a fetch is in-flight. The
  // .catch below swallows the abort rejection — it's expected.
  void telegramSupervisor.stopAll().catch(() => {});
  void discordSupervisor.stopAll().catch(() => {});
  // Abort the Slack loops too so their Socket Mode connections close
  // instead of holding the process open.
  void slackSupervisor.stopAll().catch(() => {});
  // Drain in-flight HTTP responses BEFORE we start tearing the process
  // down. `server.stop(false)` only resolves once every connection has
  // closed, but idle keep-alive connections linger up to idleTimeout
  // (255s), so the graceful stop never resolves and shutdown burned the
  // full timeout. Give genuine in-flight responses a brief grace to finish
  // writing, then force-close the rest with server.stop(true). The
  // in-flight setup POST (/api/update) that triggered the SIGTERM (see
  // src/runtime/autostart-refresh.ts) is already flushed by here — the
  // handler returns its response before scheduling the self-SIGTERM — so
  // force-closing doesn't truncate it.
  try {
    await Promise.race([server.stop(false), Bun.sleep(SERVER_DRAIN_GRACE_MS)]);
    server.stop(true);
  } catch (error) {
    appendLog(config.instance, "runtime.stop.error", {
      error: error instanceof Error ? error.message : String(error)
    });
  }
  // Wait for the in-flight tick before exiting so we don't kill a job
  // mid-execution and leave its JobRunRecord stuck "running". The tick
  // catches its own errors, so schedulerDone shouldn't reject — but we
  // attach a no-op .catch() defensively (any error already landed in
  // appendLog from the loop itself).
  //
  // Bound the wait at SCHEDULER_DRAIN_TIMEOUT_MS: a hung tick (e.g. a
  // script job that spawned a child blocking on stdio) shouldn't block
  // shutdown forever. After the timeout we proceed even if the tick hasn't
  // unwound. NOTE: children that survive are NOT reliably reaped on exit —
  // in daemon mode (`gini start` spawns the runtime detached, its own
  // process group) an orphan is reparented and keeps running, which is why
  // stopAllTunnels kills in-flight tunnel agents explicitly before this
  // deadline can fire.
  const SCHEDULER_DRAIN_TIMED_OUT = Symbol("scheduler-drain-timed-out");
  const drained = Promise.race([
    Promise.all([
      schedulerDone.catch(() => {}),
      reprobeDone.catch(() => {}),
      setupSweepDone.catch(() => {}),
      skillReviewDone.catch(() => {}),
      telegramDone.catch(() => {}),
      telegramSupervisor.stopAll().catch(() => {}),
      discordDone.catch(() => {}),
      discordSupervisor.stopAll().catch(() => {}),
      slackDone.catch(() => {}),
      slackSupervisor.stopAll().catch(() => {}),
      // Close any live headless browser contexts so Chromium child
      // processes exit cleanly with the runtime instead of being reaped
      // by the OS at the very end. Errors are swallowed — a stuck
      // close shouldn't block runtime shutdown.
      closeBrowserSessions().catch(() => {}),
      // Stop any live frpc tunnel child so it's torn down gracefully (its
      // relay registration severed) with the runtime instead of left
      // forwarding to a server that's going down. Errors swallowed — a stuck
      // stop shouldn't block shutdown; the OS reaps the child on exit.
      stopAllTunnels().catch(() => {}),
      // Kill live executor process groups (approved terminal.exec runs)
      // so approved commands never outlive the runtime as orphans. The
      // sidecar records they leave are cleared on kill; a crash that
      // skips this drain is covered by the boot-time reap. Errors
      // swallowed — a stuck kill must not block shutdown.
      killTrackedExecProcesses().catch(() => {}),
      // Flush any buffered PostHog MCP-analytics events so trailing tool-call
      // metadata isn't dropped on shutdown. No-op when analytics is disabled.
      shutdownPosthog().catch(() => {})
    ]),
    Bun.sleep(SCHEDULER_DRAIN_TIMEOUT_MS).then(() => SCHEDULER_DRAIN_TIMED_OUT)
  ]).then((result) => {
    // With abortable loop sleeps the drain resolves promptly; the timeout is
    // now a rarely-hit failsafe for a genuinely hung in-flight tick. Surface
    // it when it does fire so the cost is visible in the event stream.
    if (result === SCHEDULER_DRAIN_TIMED_OUT) {
      appendLog(config.instance, "runtime.stop.scheduler-timeout", {
        waited_ms: SCHEDULER_DRAIN_TIMEOUT_MS
      });
    }
  });
  // Print a stable shutdown marker so the foreground log capture (and any
  // human tailing the file) can see that the runtime is going down. Without
  // this, the SIGTERM path emits no stdio at all and observability of clean
  // shutdowns rests entirely on the structured runtime.jsonl event stream.
  // This is also the marker run.test.ts asserts on to guard the
  // `awaitForegroundLogFlush()` call in admin.ts:runForeground.
  //
  // Use process.stdout.write with the exit-in-callback pattern so that when
  // stdout is a pipe (foreground mode pipes child stdout into the parent for
  // tee-ing), the write completes before we exit. console.log is async on
  // pipes and process.exit doesn't wait for pending writes — that race would
  // drop the shutdown marker.
  drained.finally(() => {
    // Browser-driven autostart refresh: if /api/setup/provider just
    // wrote a refresh marker for this instance, consume it and spawn
    // the detached `gini autostart enable --kind gateway` child. The
    // drain above guarantees the response to that POST has been
    // fully flushed before we get here — `server.stop(false)` waits
    // for all in-flight responses to finish writing. The marker →
    // spawn step is the LAST thing we do before exiting, so the
    // connection has closed and the client has the response in hand
    // by the time launchctl bootstrap fires in the child.
    try {
      consumeAutostartRefresh(config.instance);
    } catch (error) {
      appendLog(config.instance, "autostart.refresh.error", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
    process.stdout.write(`Gini runtime shutting down (${signal}) instance=${config.instance}\n`, () => {
      appendLog(config.instance, "runtime.stop.drained", {
        drainMs: Math.round(performance.now() - shutdownStartedMs)
      });
      process.exit(0);
    });
  });
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

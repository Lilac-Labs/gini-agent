// `gini autostart enable|disable|status` — macOS LaunchAgent integration.
//
// What this does for the user: after `gini install` (or by hand on an
// existing instance), enabling autostart writes ~/Library/LaunchAgents/
// ai.lilac.gini.<instance>.plist, registers it with launchctl, and from
// then on the runtime is up at login and respawned on crash (KeepAlive is
// `true`, so launchd respawns on any exit). A deliberate `gini stop` runs
// `launchctl bootout` to unload the service so it stays down.
//
// macOS only in v1. Linux systemd --user is a follow-up, but invoking
// `gini autostart ...` on Linux prints a clear platform message rather
// than failing silently.

import { existsSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { CliContext } from "../context";
import { defaultRuntimePort, defaultWebPort, parseInstance } from "../../paths";
import { print } from "../output";
import { flagValue } from "../args";
import { recordedRuntimePortForInstance, recordedWebPortForInstance, waitForPortFree } from "../process";
import {
  bootout,
  bootoutTarget,
  bootstrap,
  isLoaded,
  isLoadedTarget,
  isUsableGiniCheckout,
  kickstart,
  labelFor,
  legacyHandlesFor,
  loadedLastExitStatus,
  loadedPid,
  platformIsSupported,
  plistPathFor,
  serviceTarget,
  supervisedServices,
  unsupportedPlatformMessage,
  writePlist,
  type LaunchctlResult,
  type PlistKind,
  type SupervisedService
} from "../autostart";

// All three supervised kinds, in deterministic order. enable/disable/status/
// kick iterate this; rollback bootouts out earlier kinds, so watchdog last
// means a watchdog failure never tears down the gateway/web already up.
const KINDS: PlistKind[] = ["gateway", "web", "watchdog"];

// The CORE kinds whose failure means the instance can't serve. The watchdog is
// supplementary (revives a dead/hung core service) — its bootstrap failing is
// a degraded-but-running state, NOT a reason to bootout the working
// gateway/web. enable() only rolls the earlier bootstraps back when a CORE
// kind fails.
const CORE_KINDS: readonly PlistKind[] = ["gateway", "web"];

function isCoreKind(kind: PlistKind): boolean {
  return CORE_KINDS.includes(kind);
}

// The localhost port a kind binds, used by enable's post-bootout port-free
// wait. Prefers the port recorded at the instance's last start (the runtime
// walks ports under contention) and falls back to the per-instance default.
// The watchdog binds nothing — null means "no wait needed".
function portForKind(instance: string, kind: PlistKind): number | null {
  if (kind === "gateway") return recordedRuntimePortForInstance(instance) ?? defaultRuntimePort(instance);
  if (kind === "web") return recordedWebPortForInstance(instance) ?? defaultWebPort(instance);
  return null;
}

// Narrow a raw --kind flag value to a PlistKind. Used to validate the flag
// and to decide single-kind vs all-kinds for enable/kick.
function isPlistKind(value: string | undefined): value is PlistKind {
  return value === "gateway" || value === "web" || value === "watchdog";
}

export interface StopBootoutDeps {
  // Boot out a fully-qualified service target string (gui/<uid>/<label>).
  // Injectable so unit tests can record the targets without shelling out
  // to a real launchctl. Defaults to the real bootoutTarget shellout.
  bootoutTarget: typeof bootoutTarget;
}

export interface PerKindStopResult {
  kind: string;
  serviceTarget: string;
  // True when the bootout succeeded OR the service simply wasn't loaded
  // ("Could not find service" — a deliberate stop on a target that's
  // already down is still a successful stop).
  bootedOut: boolean;
  stderr?: string;
}

export interface StopBootoutResult {
  ok: boolean;
  instance: string;
  results: PerKindStopResult[];
}

// A bootout of a target that isn't loaded is, for stop purposes, a
// success: the service is already down. launchctl phrases "not loaded"
// differently across macOS releases — "Could not find service" on older
// systems, "No such process" on macOS 26 (Tahoe) — so we accept both.
// This matters for any instance that was already stopped (or where the
// watchdog was never enabled): every stop would otherwise report ok:false
// on that target alone.
function isBootoutNotLoaded(stderr: string): boolean {
  return stderr.includes("Could not find service") || stderr.includes("No such process");
}

// `gini stop` for a launchd-supervised instance. KeepAlive is `true`, so a
// plain SIGTERM would just be respawned — the only way to actually stop a
// supervised service is `launchctl bootout`, which unloads it. We boot out
// the gateway, web, and watchdog targets. A target that isn't loaded is
// treated as a successful stop (see isBootoutNotLoaded).
export function stopViaBootout(instance: string, deps: StopBootoutDeps = { bootoutTarget }): StopBootoutResult {
  const results: PerKindStopResult[] = [];
  let allOk = true;
  for (const kind of KINDS) {
    const target = serviceTarget(instance, kind);
    const out: LaunchctlResult = deps.bootoutTarget(target);
    const bootedOut = out.ok || isBootoutNotLoaded(out.stderr);
    if (!bootedOut) allOk = false;
    results.push({
      kind,
      serviceTarget: target,
      bootedOut,
      ...(bootedOut ? {} : { stderr: out.stderr.trim() })
    });
  }
  return { ok: allOk, instance, results };
}

export async function autostart(ctx: CliContext): Promise<void> {
  const sub = ctx.cliArgs[1];
  // No subcommand → show usage. We render it as JSON-like output to match
  // the rest of the CLI, but with a help payload so it's still actionable.
  if (!sub) {
    print(usage());
    return;
  }

  if (sub === "help" || sub === "--help" || sub === "-h") {
    print(usage());
    return;
  }

  if (!platformIsSupported()) {
    print({ ok: false, error: unsupportedPlatformMessage(), platform: process.platform });
    process.exitCode = 1;
    return;
  }

  // Resolve the instance NAME without materializing its state. Reading
  // `ctx.config` would call loadConfig(), which scaffolds the full instance
  // dir (config.json with a fresh token/port, logs, skills, …) as a side
  // effect. autostart only operates on launchd services keyed by name and
  // never reads config values, so a stray `autostart status|kick|disable
  // --instance <typo>` must not conjure a phantom instance on disk.
  const instance = parseInstance(ctx.rawArgs);
  // `--test-root <dir>` opts the resulting plists into a scratch state-root
  // (and matching log-root if specified). Used by GINI_AUTOSTART_E2E tests
  // so they can run against a private state dir without touching the
  // developer's real install. Plain GINI_STATE_ROOT in the shell env does
  // NOT leak into the plist — only this explicit flag (or
  // GINI_AUTOSTART_E2E=1 + the env vars actually set) does.
  const testRootFlag = flagValue(ctx.rawArgs, "--test-root");
  const testLogRootFlag = flagValue(ctx.rawArgs, "--test-log-root");
  const e2eMode = process.env.GINI_AUTOSTART_E2E === "1";
  const testRoot = testRootFlag
    ? { stateRoot: testRootFlag, logRoot: testLogRootFlag ?? process.env.GINI_LOG_ROOT }
    : e2eMode
      ? { stateRoot: process.env.GINI_STATE_ROOT, logRoot: process.env.GINI_LOG_ROOT }
      : undefined;

  if (sub === "enable") {
    const kindFlag = flagValue(ctx.rawArgs, "--kind");
    // Validate --kind explicitly. Without this, a typo like
    // `--kind gatway` silently falls through to "all kinds", which is
    // surprising and hides intent. A bad value is a clear non-zero
    // exit with a descriptive error instead.
    if (kindFlag !== undefined && !isPlistKind(kindFlag)) {
      print({
        ok: false,
        error: `Invalid --kind value '${kindFlag}'. Allowed: gateway, web, watchdog (or omit for all).`
      });
      process.exitCode = 1;
      return;
    }
    const kinds: PlistKind[] = isPlistKind(kindFlag) ? [kindFlag] : KINDS;
    // `--home <dir>` pins the services' WorkingDirectory to an explicit
    // checkout — the only way to move an already-homed instance between
    // checkouts, since plist regeneration otherwise PRESERVES the existing
    // home (see resolveLaunchSpecPair). Validate up front so a typo'd path
    // fails with a clear error before anything touches launchd, and resolve
    // to a realpath so the plist (and the stamp folded over
    // WorkingDirectory) doesn't flap between symlinked spellings of the
    // same directory.
    const homeFlag = flagValue(ctx.rawArgs, "--home");
    let homeDir: string | undefined;
    if (homeFlag !== undefined) {
      if (!isUsableGiniCheckout(homeFlag)) {
        print({
          ok: false,
          error: `--home '${homeFlag}' is not a usable gini-agent checkout (needs a package.json with name "gini-agent" and packages/runtime/src/server.ts).`
        });
        process.exitCode = 1;
        return;
      }
      homeDir = realpathSync(homeFlag);
    }
    const result = await enable({ instance, testRoot, kinds, homeDir });
    print(result);
    // When rollback itself failed, emit a clear stderr warning so the
    // operator sees the honest state at a glance instead of having to
    // dig through the JSON. The result JSON already has all the
    // per-kind detail; this is purely a "look here" pointer.
    if (result.rollbackState === "rollback_failed") {
      const lines = (result.rollbackFailures ?? []).map(
        (f) => `  - ${f.kind}: ${f.stderr || f.error}`
      );
      process.stderr.write(
        `autostart enable: rollback FAILED for instance '${instance}'.\n` +
        `The gateway service may still be loaded with stale env.\n` +
        `Run \`gini autostart status --instance ${instance}\` and clean up manually with \`launchctl bootout\`.\n` +
        `${lines.join("\n")}\n`
      );
    }
    // Exit code reflects ok:false so install.sh's `if … then` shell
    // guard sees the failure. Without this, soft failures (e.g.
    // partial bootstrap) would return exit 0 even though the JSON
    // body had ok:false — the shell side would never know.
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (sub === "disable") {
    const result = await disable(instance);
    print(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (sub === "status") {
    print(status(instance));
    return;
  }
  if (sub === "kick") {
    // Validate --kind the same way `enable` does — a typo like
    // `--kind gatway` would otherwise silently fall through to
    // "all kinds", hiding the operator's intent.
    const kindFlag = flagValue(ctx.rawArgs, "--kind");
    if (kindFlag !== undefined && !isPlistKind(kindFlag)) {
      print({
        ok: false,
        error: `Invalid --kind value '${kindFlag}'. Allowed: gateway, web, watchdog (or omit for all).`
      });
      process.exitCode = 1;
      return;
    }
    const result = kick(instance, ctx.rawArgs);
    print(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  print({
    ok: false,
    error: `Unknown autostart subcommand: ${sub}. Run \`gini autostart\` for usage.`
  });
  process.exitCode = 1;
}

function usage(): Record<string, unknown> {
  return {
    usage: [
      "gini autostart enable  [--instance <name>] [--home <dir>] [--test-root <dir>]",
      "gini autostart disable [--instance <name>]",
      "gini autostart status  [--instance <name>]",
      "gini autostart kick    [--instance <name>] [--kind gateway|web|watchdog]  # force respawn (see notes)"
    ],
    notes: [
      "macOS only in v1 (Linux systemd --user is a follow-up).",
      "Three services per instance: <prefix>.<instance>.gateway (Bun runtime), <prefix>.<instance>.web (Next.js), and <prefix>.<instance>.watchdog (long-lived health-probe loop that revives a dead/hung gateway or web).",
      "The watchdog is a long-lived KeepAlive loop probing every 10s: it checks the gateway /api/status and web /api/runtime/__healthz, kickstarts whichever is down, and queues a deduped crash report when web is down. (It was a 30s StartInterval one-shot, but launchd's spawn deferral gapped its ticks during the very outages it covers.)",
      "`gini stop` runs `launchctl bootout` to unload the service (KeepAlive is `true` — launchd always respawns on exit, so a clean exit alone won't keep it down). The web service is torn down the same way.",
      "macOS 26 (Tahoe): launchd often defers auto-respawn after SIGKILL indefinitely (`pended nondemand spawn = inefficient`). Use `gini autostart kick` to force a respawn when this happens; RunAtLoad still fires at login.",
      "Secrets in ~/.gini/secrets.env are merged into the gateway plist's EnvironmentVariables only (the web plist is the BFF and never talks to providers directly). If you change a key (e.g. `gini provider set`), re-run `autostart enable` to refresh the plist for future respawns.",
      "The instance's home (plist WorkingDirectory) is sticky: re-running `enable` preserves the home already recorded in the gateway plist, regardless of the directory you run it from. `--home <dir>` pins the services onto an explicit gini-agent checkout; `gini update` re-homes a wrongly-homed instance onto ~/.gini/runtime.",
      "`--test-root <dir>` is an E2E-test escape hatch: scoped state/log roots are embedded in the plist. Plain GINI_STATE_ROOT in your shell does NOT leak into a permanent plist."
    ]
  };
}

interface PerKindEnableResult {
  kind: PlistKind;
  label: string;
  plistPath: string;
  serviceTarget: string;
  alreadyLoaded: boolean;
  enabled: boolean;
  error?: string;
  stderr?: string;
  // On macOS 26 (Tahoe), `RunAtLoad` in the plist is best-effort —
  // after `launchctl bootstrap`, services frequently end up registered
  // but never spawn (`state = not running`, last exit code
  // `(never exited)`). We always `kickstart` after a successful
  // bootstrap so the service actually launches immediately,
  // regardless of macOS version. If kickstart itself fails, the
  // bootstrap succeeded — the user can still run `gini autostart kick`
  // manually — so we surface it as a soft failure on the per-kind
  // result instead of failing the whole enable.
  kickstartError?: string;
  kickstartStderr?: string;
}

// When a later kind in the enable sequence fails (e.g. web bootstrap
// fails after gateway succeeds), we attempt to roll back the earlier
// successful bootstraps via `bootout`. That rollback can itself fail —
// and silently ignoring its failure leaves the operator with a
// misleading `ok:false` while the gateway is still loaded. We surface
// the rollback state explicitly:
//
//   - "clean": no rollback was needed (either everything succeeded or
//     nothing was bootstrapped before failure).
//   - "rolled_back": a rollback was needed and it succeeded — no
//     half-loaded services remain.
//   - "rollback_failed": a rollback was needed and at least one bootout
//     during rollback returned non-zero. Per-kind details are in the
//     rollbackFailures array. The operator must clean up manually.
export type RollbackState = "clean" | "rolled_back" | "rollback_failed";

interface RollbackFailure {
  kind: PlistKind;
  error: string;
  stderr: string;
}

interface EnableResult {
  ok: boolean;
  enabled: boolean;
  instance: string;
  resolution: "installed" | "source";
  results: PerKindEnableResult[];
  rollbackState: RollbackState;
  rollbackFailures?: RollbackFailure[];
  error?: string;
}

// Compute the plist's StandardOutPath/StandardErrorPath log root WITHOUT
// honoring process.env.GINI_LOG_ROOT. logDir() in paths.ts returns
// join(GINI_LOG_ROOT, instance) when that env var is set, so a
// developer who runs `autostart enable` from a shell with GINI_LOG_ROOT
// set would otherwise bake scratch paths into the permanent plist.
// When not in testRoot opt-in, compute the log root from instance state
// root directly. When testRoot.logRoot is provided (E2E), embed that.
function resolveLogRoot(instance: string, testRoot?: { stateRoot?: string; logRoot?: string }): string {
  if (testRoot?.logRoot) return join(testRoot.logRoot, instance);
  if (testRoot?.stateRoot) return join(testRoot.stateRoot, "instances", instance, "logs");
  // Production path: derive from $HOME/.gini regardless of whether
  // GINI_LOG_ROOT or GINI_STATE_ROOT are set in the invoking shell.
  // We use HOME directly so a stray env-set GINI_STATE_ROOT also doesn't
  // leak into the plist via instanceRoot() → baseStateRoot().
  const home = process.env.HOME ?? "";
  return join(home, ".gini", "instances", instance, "logs");
}

// Test seam: rollback-failure surfacing has no other reachable path —
// we can't easily make a real `launchctl bootout` fail without
// holding launchd hostage. Tests inject mocks here to assert the
// rollbackState bookkeeping. Production callers omit the `launchctl`
// option and get the real launchctl shellouts.
export interface EnableLaunchctlDeps {
  isLoaded: typeof isLoaded;
  bootout: typeof bootout;
  bootstrap: typeof bootstrap;
  kickstart: typeof kickstart;
  // Poll until a freshly-booted-out port-binding kind has actually released
  // its socket before we re-bootstrap, so the reload can't double-bind
  // (EADDRINUSE). Injectable so tests can stub it and assert it's awaited
  // without polling a real port. Defaults to the real waitForPortFree.
  waitForPortFree: typeof waitForPortFree;
}

export interface EnableOptions {
  instance: string;
  // Opt-in scratch state/log root for E2E tests. See ResolveLaunchOptions
  // for the leak-prevention rationale.
  testRoot?: { stateRoot?: string; logRoot?: string };
  // Which kinds to bootstrap. Defaults to all three (gateway + web + watchdog).
  // `--kind gateway` from the CLI narrows this for setup-api's refresh
  // path so it doesn't kill the web service the browser is talking to.
  kinds?: PlistKind[];
  // Launchctl shellout injection seam — tests substitute mocks so the
  // rollback-failure branch can be exercised without holding real
  // launchd hostage. Omitted in production.
  launchctl?: EnableLaunchctlDeps;
  // Explicit home (plist WorkingDirectory) for the regenerated plists.
  // Threaded to resolveLaunchSpecPair, which validates it as a usable
  // gini-agent checkout (throws otherwise) and — when omitted — PRESERVES
  // the home already recorded in the instance's gateway plist. Set by
  // `gini autostart enable --home <dir>` and by `gini update`'s re-home
  // onto the installed runtime.
  homeDir?: string;
}

// Exported so tests can drive the rollback-failure path via injected
// launchctl deps. Production CLI dispatch still goes through
// `autostart()` at the top of this file.
export async function enable(options: EnableOptions): Promise<EnableResult> {
  const { instance, testRoot } = options;
  const kinds = options.kinds ?? KINDS;
  const deps: EnableLaunchctlDeps = options.launchctl ?? { isLoaded, bootout, bootstrap, kickstart, waitForPortFree };
  // Only the enable path opts in to spawning the user's login shell to
  // merge nvm/asdf/volta dirs into the plist. status / disable / kick
  // (further down this file) don't pass mergeShellPath, so they keep
  // returning the base launchd PATH without paying the shell-spawn
  // cost or risking a hung rc file.
  const services = supervisedServices({ instance, testRoot, kinds, mergeShellPath: true, homeDir: options.homeDir });
  const resolution = services[0]?.resolution ?? "installed";
  const logRoot = resolveLogRoot(instance, testRoot);
  const results: PerKindEnableResult[] = [];
  let allOk = true;

  // Migrate from any prior LABEL_PREFIX (e.g. the original
  // `ai.lilac.gini` → `ai.lilaclabs.gini` rename). For each legacy
  // prefix we ship the single-plist and split-pair shapes, boot out
  // anything launchd still has registered, and delete the plist file
  // from disk. Done unconditionally and silently — `bootout` on an
  // unknown label is a no-op (we ignore "Could not find service").
  if (kinds.includes("gateway")) {
    for (const handle of legacyHandlesFor(instance)) {
      if (isLoadedTarget(handle.serviceTarget)) {
        const out = bootoutTarget(handle.serviceTarget);
        if (!out.ok && !out.stderr.includes("Could not find service")) {
          // Worst case the old service stays loaded and the user has
          // to clean it up by hand — but the new pair can still
          // bootstrap, so don't fail the whole enable on a stuck
          // legacy plist. Surface via stderr so it's visible.
          process.stderr.write(
            `autostart: legacy bootout failed for ${handle.label}: ${out.stderr.trim()}\n`
          );
        }
      }
      if (existsSync(handle.plistPath)) {
        try { rmSync(handle.plistPath, { force: true }); } catch { /* best-effort */ }
      }
    }
  }

  // Clean up the older single-plist `<currentPrefix>.<instance>` (no
  // kind suffix) BEFORE bootstrapping the gateway/web split pair.
  // Without this, an upgrade from the pre-split shape leaves the
  // legacy service running alongside the new pair, which either
  // fights for the gateway port or wedges launchd. `bootout` on an
  // unknown label is a no-op (we ignore "Could not find service"),
  // so it's safe to always run.
  if (deps.isLoaded(instance) && kinds.includes("gateway")) {
    const out = deps.bootout(instance);
    if (!out.ok && !out.stderr.includes("Could not find service")) {
      // Surface as a top-level error and bail — running both legacy
      // and new gateway simultaneously is worse than failing the
      // enable.
      return {
        ok: false,
        enabled: false,
        instance,
        resolution,
        results: [],
        rollbackState: "clean",
        error: `legacy bootout failed: ${out.stderr.trim()}`
      };
    }
  }
  // Remove the legacy plist file too so a future `disable` doesn't
  // bother re-cleaning it (and so `ls ~/Library/LaunchAgents/` shows
  // only the current gateway/web split files).
  const legacyPlist = plistPathFor(instance);
  if (existsSync(legacyPlist) && kinds.includes("gateway")) {
    try { rmSync(legacyPlist, { force: true }); } catch { /* best-effort */ }
  }

  // Track which kinds we successfully bootstrapped so we can roll
  // them back if a later kind fails. Leaving a half-loaded service
  // set is worse than nothing loaded — `gini status` would report
  // the gateway up but the user can't reach the webapp.
  const bootstrapped: PlistKind[] = [];

  // Rollback bookkeeping: populated when a later kind fails and we
  // attempt to bootout the earlier successful ones. Each entry
  // represents a rollback bootout that itself returned non-zero — the
  // operator must clean it up manually because the service is still
  // loaded.
  let rollbackState: RollbackState = "clean";
  const rollbackFailures: RollbackFailure[] = [];

  for (const svc of services) {
    const stdoutPath = join(logRoot, svc.stdoutLogFilename);
    // launchd routes stderr to its own file by default — we keep that
    // separate so an autostart-only crash log doesn't get tangled with the
    // user-driven `gini run` stdout tee.
    const stderrPath = join(logRoot, svc.stderrLogFilename);
    const path = writePlist({
      instance,
      kind: svc.kind,
      spec: svc.spec,
      stdoutPath,
      stderrPath,
      // No current descriptor sets this (all three kinds are KeepAlive
      // long-lived jobs); the plumbing stays for a future periodic kind.
      ...(svc.startIntervalSeconds !== undefined ? { startIntervalSeconds: svc.startIntervalSeconds } : {})
    });
    const wasLoaded = deps.isLoaded(instance, svc.kind);

    if (wasLoaded) {
      // Idempotent re-enable: the plist on disk may have changed, so we
      // bootout the old registration first, then bootstrap the new one.
      // `kickstart -k` alone wouldn't pick up the new plist contents.
      const out = deps.bootout(instance, svc.kind);
      if (!out.ok && !out.stderr.includes("Could not find service")) {
        results.push({
          kind: svc.kind,
          label: svc.label,
          plistPath: path,
          serviceTarget: svc.serviceTarget,
          alreadyLoaded: wasLoaded,
          enabled: false,
          error: "launchctl bootout failed",
          stderr: out.stderr.trim()
        });
        allOk = false;
        continue;
      }
      // `bootout` returns once launchd ACCEPTS the unload, not after the
      // process has died and released its socket. Re-bootstrapping (which
      // RunAtLoad + our kickstart immediately relaunch) into a still-bound
      // port yields EADDRINUSE — the exact crash loop a stale-plist reload
      // can trigger. For port-binding kinds (gateway/web) we wait for the
      // port to actually free before bootstrap. The watchdog binds nothing,
      // so it has no port to wait on. We only wait when something was loaded
      // (a bootout happened); a fresh enable never had a binder.
      const port = portForKind(instance, svc.kind);
      if (port !== null) {
        const freed = await deps.waitForPortFree(port);
        if (!freed) {
          // The port never freed within the wait. We bootstrap anyway (the
          // wait is best-effort), but surface it so a resulting EADDRINUSE is
          // diagnosable rather than silent — a still-bound port here usually
          // means an orphaned process holds it outside launchd's control.
          process.stderr.write(
            `autostart: ${svc.kind} port ${port} still bound after waiting; bootstrapping anyway\n`
          );
        }
      }
    }

    // Bootstrap with a short retry. macOS launchd sometimes returns
    // "Bootstrap failed: 5: Input/output error" when the previous
    // bootout hasn't fully flushed yet — typically clears within ~1s.
    // We retry up to 3 times with 500ms backoff to ride out the gap.
    let res = deps.bootstrap(instance, path);
    let attempts = 1;
    while (!res.ok && attempts < 3 && res.stderr.includes("Input/output error")) {
      await Bun.sleep(500);
      res = deps.bootstrap(instance, path);
      attempts += 1;
    }
    if (!res.ok) {
      results.push({
        kind: svc.kind,
        label: svc.label,
        plistPath: path,
        serviceTarget: svc.serviceTarget,
        alreadyLoaded: wasLoaded,
        enabled: false,
        error: "launchctl bootstrap failed",
        stderr: res.stderr.trim()
      });
      allOk = false;
      // Only a CORE kind (gateway/web) failure rolls back the earlier
      // bootstraps — a half-loaded CORE set (gateway up but no web) is worse
      // than nothing. The watchdog is supplementary: if it fails to bootstrap
      // (it's last in the sequence, after gateway/web are up), tearing down a
      // working gateway/web to "clean up" would take the instance offline over
      // a missing health-prober. Treat that as a surfaced partial failure
      // (allOk already false, per-kind error recorded above) and leave the
      // core services loaded.
      if (!isCoreKind(svc.kind)) {
        continue;
      }
      // Roll back any kinds we already bootstrapped in this call so
      // we don't leave a half-loaded service set behind. Skip kinds
      // that were `wasLoaded:true` on entry — those are the user's
      // prior state, not something this call created. If the rollback
      // bootout itself fails, capture the per-kind error and flip
      // rollbackState to "rollback_failed" so the operator sees the
      // honest state: the gateway is still loaded but the web never
      // came up, and we couldn't clean up either. Silently swallowing
      // rollback failures (returning ok:false with the gateway still
      // loaded) is misleading; the operator needs to see it so they
      // can clean up by hand.
      let allRolledBack = bootstrapped.length > 0;
      for (const earlier of bootstrapped) {
        const r = deps.bootout(instance, earlier);
        if (!r.ok && !r.stderr.includes("Could not find service")) {
          allRolledBack = false;
          rollbackFailures.push({
            kind: earlier,
            error: "rollback bootout failed",
            stderr: r.stderr.trim()
          });
        }
      }
      if (bootstrapped.length > 0) {
        rollbackState = allRolledBack ? "rolled_back" : "rollback_failed";
      }
      continue;
    }
    bootstrapped.push(svc.kind);
    // macOS 26 frequently registers the service via `launchctl
    // bootstrap` but never actually spawns it — `RunAtLoad` is honored
    // as best-effort, not a guarantee. The symptom: `state = not
    // running`, `last exit code = (never exited)`, indefinitely. We
    // `kickstart` immediately after every successful bootstrap so the
    // service actually runs regardless of macOS version. `-k` is
    // idempotent on a not-running service (it's a no-op kill + start);
    // it doesn't matter that the service hasn't launched yet.
    //
    // If kickstart itself returns non-zero we surface it as a soft
    // failure on the per-kind result and keep `enabled: true` — the
    // bootstrap succeeded, the user can manually run
    // `gini autostart kick` to recover. Failing the whole enable on a
    // kickstart error would needlessly roll back a working bootstrap.
    const kickRes = deps.kickstart(instance, svc.kind);
    const perKind: PerKindEnableResult = {
      kind: svc.kind,
      label: svc.label,
      plistPath: path,
      serviceTarget: svc.serviceTarget,
      alreadyLoaded: wasLoaded,
      enabled: true
    };
    if (!kickRes.ok) {
      perKind.kickstartError = "launchctl kickstart failed";
      perKind.kickstartStderr = kickRes.stderr.trim();
    }
    results.push(perKind);
  }

  return {
    ok: allOk,
    enabled: allOk,
    instance,
    resolution,
    results,
    rollbackState,
    ...(rollbackFailures.length > 0 ? { rollbackFailures } : {})
  };
}

interface PerKindDisableResult {
  kind: PlistKind;
  label: string;
  plistPath: string;
  wasLoaded: boolean;
  bootoutOk: boolean;
  plistRemoved: boolean;
  bootoutStderr?: string;
  rmError?: string;
}

interface DisableResult {
  ok: boolean;
  disabled: boolean;
  instance: string;
  alreadyDisabled: boolean;
  results: PerKindDisableResult[];
  // Legacy single-plist fields kept for tests / shell scripts that grep
  // for them. Each reflects the AGGREGATE across kinds.
  label?: string;
  plistPath?: string;
  plistRemoved: boolean;
  stderr?: string;
}

async function disable(instance: string): Promise<DisableResult> {
  // Pull the older single-plist into the cleanup loop too. If a user
  // upgrades from the pre-split shape and runs `autostart disable`,
  // we want to clean up the old `<prefix>.<instance>` plist as well.
  // It's safe to call bootout on a label that isn't loaded — launchctl
  // returns "Could not find service".
  const legacyPath = plistPathFor(instance);
  const results: PerKindDisableResult[] = [];
  const stderrParts: string[] = [];

  // Handle legacy plist if it's present.
  if (existsSync(legacyPath) || isLoaded(instance)) {
    const wasLoaded = isLoaded(instance);
    let bootoutOk = true;
    let bootoutStderr: string | undefined;
    if (wasLoaded) {
      const out = bootout(instance);
      if (!out.ok && !out.stderr.includes("Could not find service")) {
        bootoutOk = false;
        bootoutStderr = out.stderr.trim();
        stderrParts.push(`legacy bootout: ${bootoutStderr}`);
      }
    }
    let plistRemoved = false;
    let rmError: string | undefined;
    if (existsSync(legacyPath)) {
      try {
        rmSync(legacyPath, { force: true });
        plistRemoved = true;
      } catch (error) {
        rmError = error instanceof Error ? error.message : String(error);
        stderrParts.push(`legacy rm: ${rmError}`);
      }
    }
    results.push({
      kind: "gateway",
      label: labelFor(instance),
      plistPath: legacyPath,
      wasLoaded,
      bootoutOk,
      plistRemoved,
      ...(bootoutStderr ? { bootoutStderr } : {}),
      ...(rmError ? { rmError } : {})
    });
  }

  // Iterate the supervised service table so this loop stays in lockstep
  // with enable/status/kick — any per-kind difference (label, path) is
  // encoded in the descriptor, not re-derived here.
  for (const svc of supervisedServices({ instance })) {
    const path = svc.plistPath;
    const wasLoaded = isLoaded(instance, svc.kind);

    if (!wasLoaded && !existsSync(path)) {
      continue;
    }

    let bootoutOk = true;
    let bootoutStderr: string | undefined;
    if (wasLoaded) {
      const out = bootout(instance, svc.kind);
      if (!out.ok && !out.stderr.includes("Could not find service")) {
        bootoutOk = false;
        bootoutStderr = out.stderr.trim();
        stderrParts.push(`${svc.kind} bootout: ${bootoutStderr}`);
      }
    }

    let plistRemoved = false;
    let rmError: string | undefined;
    if (existsSync(path)) {
      try {
        rmSync(path, { force: true });
        plistRemoved = true;
      } catch (error) {
        rmError = error instanceof Error ? error.message : String(error);
        stderrParts.push(`${svc.kind} rm plist: ${rmError}`);
      }
    }

    results.push({
      kind: svc.kind,
      label: svc.label,
      plistPath: path,
      wasLoaded,
      bootoutOk,
      plistRemoved,
      ...(bootoutStderr ? { bootoutStderr } : {}),
      ...(rmError ? { rmError } : {})
    });
  }

  if (results.length === 0) {
    return {
      ok: true,
      disabled: false,
      instance,
      alreadyDisabled: true,
      results: [],
      label: labelFor(instance),
      plistPath: legacyPath,
      plistRemoved: false
    };
  }

  const allOk = results.every((r) => r.bootoutOk && !r.rmError);
  const anyPlistRemoved = results.some((r) => r.plistRemoved);
  const aggregateStderr = stderrParts.join("; ");
  return {
    ok: allOk,
    disabled: allOk,
    instance,
    alreadyDisabled: false,
    results,
    label: labelFor(instance),
    plistPath: legacyPath,
    plistRemoved: anyPlistRemoved,
    ...(aggregateStderr ? { stderr: aggregateStderr } : {})
  };
}

interface PerKindStatus {
  kind: PlistKind;
  label: string;
  plistPath: string;
  plistExists: boolean;
  loaded: boolean;
  pid: number | null;
  lastExitStatus: string | null;
}

interface StatusResult {
  ok: true;
  instance: string;
  services: PerKindStatus[];
  // Legacy single-plist fields from before the gateway/web split,
  // surfaced for compatibility (some tests and user scripts grep on
  // them). Reflects the gateway service.
  label: string;
  plistPath: string;
  plistExists: boolean;
  loaded: boolean;
  pid: number | null;
  lastExitStatus: string | null;
  limitations: string[];
}

function status(instance: string): StatusResult {
  const services: PerKindStatus[] = [];
  for (const svc of supervisedServices({ instance })) {
    const loaded = isLoaded(instance, svc.kind);
    const pid = loaded ? loadedPid(instance, svc.kind) : null;
    const lastExit = loaded ? loadedLastExitStatus(instance, svc.kind) : null;
    services.push({
      kind: svc.kind,
      label: svc.label,
      plistPath: svc.plistPath,
      plistExists: existsSync(svc.plistPath),
      loaded,
      pid,
      lastExitStatus: lastExit
    });
  }
  const gateway = services[0]!;
  return {
    ok: true,
    instance,
    services,
    label: gateway.label,
    plistPath: gateway.plistPath,
    plistExists: gateway.plistExists,
    loaded: gateway.loaded,
    pid: gateway.pid,
    lastExitStatus: gateway.lastExitStatus,
    limitations: [
      "macOS 26+: launchd auto-respawn after SIGKILL is unreliable. The watchdog's 10s probe loop kickstarts a dead/hung service; `gini autostart kick` forces it on demand.",
      "macOS only in v1.",
      "Three services per instance: <prefix>.<instance>.gateway, <prefix>.<instance>.web, and <prefix>.<instance>.watchdog (long-lived health-probe loop that revives a wedged-but-alive or cleanly-exited gateway/web). `gini status` aggregates web/runtime health."
    ]
  };
}

interface PerKindKickResult {
  kind: PlistKind;
  label: string;
  loaded: boolean;
  kicked: boolean;
  error?: string;
  stderr?: string;
}

interface KickResult {
  ok: boolean;
  instance: string;
  results: PerKindKickResult[];
}

// `kick` is a manual respawn trigger. macOS 26 (Tahoe) sometimes refuses to
// auto-respawn a launchd job after a SIGKILL, leaving it stuck in
// `pended nondemand spawn = inefficient` indefinitely. `gini autostart kick`
// runs `launchctl kickstart -k` to force a stop+start.
//
// Defaults: kick BOTH gateway and web. `--kind gateway` or `--kind web`
// narrows it to one. Practical use: a healthcheck loop discovers a wedged
// runtime and runs `gini autostart kick --kind gateway`.
function kick(instance: string, rawArgs: string[]): KickResult {
  const kindFlag = flagValue(rawArgs, "--kind");
  const kinds: PlistKind[] = isPlistKind(kindFlag) ? [kindFlag] : KINDS;
  const results: PerKindKickResult[] = [];
  let allOk = true;
  for (const svc of supervisedServices({ instance, kinds })) {
    const loaded = isLoaded(instance, svc.kind);
    if (!loaded) {
      results.push({
        kind: svc.kind,
        label: svc.label,
        loaded: false,
        kicked: false,
        error: `Autostart is not enabled for ${svc.kind} on instance '${instance}'. Run \`gini autostart enable\` first.`
      });
      allOk = false;
      continue;
    }
    const res = kickstart(instance, svc.kind);
    if (!res.ok) {
      results.push({
        kind: svc.kind,
        label: svc.label,
        loaded: true,
        kicked: false,
        error: "launchctl kickstart failed",
        stderr: res.stderr.trim()
      });
      allOk = false;
      continue;
    }
    results.push({ kind: svc.kind, label: svc.label, loaded: true, kicked: true });
  }
  return { ok: allOk, instance, results };
}

// Best-effort autostart-disable for use by `gini uninstall --instance`.
// Tries to tear down BOTH plists (gateway + web), but surfaces failures
// rather than swallowing them — a broken plist must not block uninstall
// of state, but the user deserves to know launchctl couldn't unload
// something. State deletion proceeds either way; the caller prints any
// warnings.
export interface UninstallAutostartResult {
  removed: boolean;
  alreadyDisabled: boolean;
  reason?: string;
  // Per-kind audit so the uninstall command can print exactly which
  // service had trouble unloading.
  failures: Array<{ kind: PlistKind | "legacy"; error: string }>;
}

// Called from CLI paths that touch creds (gini provider set, gini setup
// after writing secrets.env). If a gateway plist already exists for the
// instance, re-run `enable` so the launchd registration picks up the
// fresh secrets.env / config values. Bails on non-macOS or when no
// plist is present — both are common, expected states.
//
// Returns the refresh outcome (or a "skipped" reason) so the caller can
// surface it in their output. The refresh DOES bootout + bootstrap, so
// it will briefly stop and respawn the running gateway/web. That's fine
// in a CLI context because the user typed the command and expects it.
// (Never call this from inside the gateway process — it would kill
// itself mid-call. See setup-api.maybeRefreshAutostartPlist.)
export async function maybeRefreshAutostart(instance: string): Promise<{ refreshed: boolean; reason?: string }> {
  if (!platformIsSupported()) return { refreshed: false, reason: "not macOS" };
  const gatewayPlist = plistPathFor(instance, "gateway");
  if (!existsSync(gatewayPlist)) return { refreshed: false, reason: "no autostart plist on disk" };
  try {
    const result = await enable({ instance });
    return { refreshed: result.ok, ...(result.ok ? {} : { reason: result.error ?? "autostart enable failed" }) };
  } catch (error) {
    return { refreshed: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function disableForUninstall(instance: string): Promise<UninstallAutostartResult> {
  if (!platformIsSupported()) {
    return { removed: false, alreadyDisabled: false, reason: "not macOS", failures: [] };
  }
  try {
    const result = await disable(instance);
    const failures: UninstallAutostartResult["failures"] = [];
    for (const r of result.results) {
      if (!r.bootoutOk) failures.push({ kind: r.kind, error: r.bootoutStderr ?? "launchctl bootout failed" });
      if (r.rmError) failures.push({ kind: r.kind, error: `rm plist: ${r.rmError}` });
    }
    return {
      removed: result.disabled || result.plistRemoved,
      alreadyDisabled: result.alreadyDisabled,
      reason: result.alreadyDisabled ? "already disabled" : undefined,
      failures
    };
  } catch (error) {
    return {
      removed: false,
      alreadyDisabled: false,
      reason: error instanceof Error ? error.message : String(error),
      failures: [{ kind: "legacy", error: error instanceof Error ? error.message : String(error) }]
    };
  }
}

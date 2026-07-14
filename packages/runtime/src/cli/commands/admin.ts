// Lifecycle and instance-admin commands: install, start, stop, status, doctor, reset, run.
import type { ChildProcess } from "node:child_process";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as readline from "node:readline/promises";
import type { RuntimeConfig } from "../../types";
import type { CliContext } from "../context";
import type { WebOptions } from "../process";
import { hasFlag } from "../args";
import { install, resetInstance, uninstallAll, uninstallInstance } from "../../runtime";
import { configPath, loadConfig, parseInstance, pidPath, runtimePortPath, webPortPath, writeRuntimeConfig } from "../../paths";
import {
  awaitForegroundLogFlush,
  doctor,
  existingWebUrl,
  isRunning,
  operatorWebUrl,
  remoteOrLocalStatus,
  start as startLifecycle,
  stopRuntime,
  waitForRuntimeStopped
} from "../process";
import { print, printStartBanner } from "../output";
import { COLOR, header, footer, step, info, warn, tildify } from "../styling";
import { disableForUninstall, enable, stopViaBootout } from "./autostart";
import { isLaunchdManaged, isLoaded, kickstart, plistPathFor, readPlistWorkingDirectory, supervisor, type LaunchdManagedDeps, type PlistKind } from "../autostart";
import { installedRuntimeDir, sameRealPath, updateRuntime } from "../../runtime/update";
import { api, url } from "../api";

// How long the foreground parent waits for a runtime child to exit on its own
// after forwarding SIGTERM, before escalating to SIGKILL. This MUST exceed the
// child's own shutdown budget: src/server.ts drains in-flight work bounded by
// SCHEDULER_DRAIN_TIMEOUT_MS (5000ms) and writes its "shutting down (SIGTERM)"
// marker to runtime-stdout.log only AFTER that drain completes. A grace equal
// to the child's 5000ms drain leaves no room for the marker write+flush, so
// under parallel-CI CPU starvation the parent can SIGKILL the child mid-drain
// and drop the marker entirely. The 2500ms of headroom here lets a cleanly
// draining child reach its own exit first. Kept below the 8000ms teardown
// budget the run command honors on terminal close / Ctrl-C (7500ms grace plus
// the 50ms post-SIGKILL reap wait = 7550ms, under 8000ms), so the SIGKILL
// stays a failsafe rather than a routine wait.
const RUNTIME_CHILD_SIGKILL_GRACE_MS = 7500;

export async function install_(ctx: CliContext): Promise<void> {
  // Provider configuration is optional at install time. The piped-curl
  // install path (`curl … | bash`) has no GINI_PROVIDER env, and the
  // browser /setup flow is responsible for picking a provider when the
  // user lands on a fresh instance without env vars set. When no env
  // is set the platform default in defaultConfig() (codex/gpt-5.5)
  // takes over for a brand-new instance; `gini setup --yes` and the
  // browser /setup page can still rewrite that later.
  //
  // GINI_PROVIDER=openai|codex (optionally with GINI_MODEL) always
  // wins when set, whether or not a config already exists on disk. This
  // is load-bearing for the conductor `setup` script: if a worktree's
  // instance dir was materialized earlier (e.g. by a tmux `gini run`
  // racing the install, or by a legacy `~/.gini/lanes/<inst>/config.json`
  // that loadConfig migrates into place) the existing config would
  // otherwise pin a stale provider and the env vars in `setup` would
  // be silently ignored. We unconditionally apply the env override
  // after ctx.config: on a fresh install defaultConfig() already used
  // the env vars so the rewrite is a no-op; on a pre-existing or
  // migrated config it brings the on-disk shape into agreement with
  // the env.
  //
  // GINI_MODEL alone (no GINI_PROVIDER) on an existing config also
  // wins — defaultConfig() honors GINI_MODEL on a fresh install, so the
  // existing-config path must match that contract or users get an
  // asymmetric "model env ignored after first install" surprise.
  //
  // The validator and override branch deliberately reject `echo`. Echo
  // is a test-only provider: it's reachable through the ephemeral smoke
  // path (src/cli/args.ts pins GINI_PROVIDER=echo and smoke bypasses
  // install_), but not as a user-facing install option. The allow-list
  // in defaultConfig() is wider than this one for that reason.
  const instance = parseInstance(ctx.rawArgs);
  const envProvider = process.env.GINI_PROVIDER;
  if (envProvider !== undefined && envProvider !== "openai" && envProvider !== "codex") {
    throw new Error(
      `GINI_PROVIDER='${envProvider}' is not a recognized provider. ` +
      `Use 'openai' or 'codex', leave it unset to accept the platform default, ` +
      `or run \`gini provider set <name> [model]\` after install.`
    );
  }
  const { config } = ctx;
  const envModel = process.env.GINI_MODEL;
  if (envProvider === "openai" || envProvider === "codex") {
    // Mirror defaultConfig()'s provider field shape so the on-disk form
    // is identical whether the env vars hit the fresh-config branch in
    // defaultConfig() or this rewrite path on a pre-existing/migrated
    // config. Model resolution:
    //   - GINI_MODEL set → use it.
    //   - GINI_MODEL unset AND provider changed → use new provider's
    //     default (mirrors defaultConfig).
    //   - GINI_MODEL unset AND provider unchanged → preserve the
    //     existing model so a user with codex/gpt-custom doesn't get
    //     clobbered to gpt-5.5 by a re-run of `gini install` with the
    //     same GINI_PROVIDER.
    const providerChanged = config.provider?.name !== envProvider;
    const providerDefaultModel = envProvider === "codex" ? "gpt-5.5" : "gpt-5.4-mini";
    const model = envModel
      ?? (providerChanged ? providerDefaultModel : (config.provider?.model ?? providerDefaultModel));
    config.provider = {
      name: envProvider,
      model,
      apiKeyEnv: envProvider === "openai" ? "OPENAI_API_KEY" : undefined
    };
    writeRuntimeConfig(config);
  } else if (envModel !== undefined && config.provider) {
    // Asymmetry fix: fresh configs honor GINI_MODEL alone via
    // defaultConfig(), but the existing-config branch above only fires
    // when GINI_PROVIDER is set. If only GINI_MODEL is set on an
    // existing config, apply the model update in place — keep the
    // current provider name and apiKeyEnv untouched so a stale
    // OPENAI_API_KEY value (or absence) survives the rewrite.
    config.provider = { ...config.provider, model: envModel };
    writeRuntimeConfig(config);
  }
  await install(config);
  print({ installed: true, instance: config.instance, stateRoot: config.stateRoot, port: config.port });
}

export async function start(ctx: CliContext): Promise<boolean> {
  const { banner, runtimeStarted } = await startInstance(ctx.config, ctx.web);
  printStartBanner(banner);
  return runtimeStarted;
}

// The launchd-state predicate `isLaunchdManaged` lives in
// src/integrations/launchd.ts (re-exported through ../autostart) so runtime
// modules — notably scheduleRuntimeRestart in src/runtime/update.ts — can route
// on it without importing this CLI command surface. The deps shape is the same;
// keep the old name as an alias so existing call sites and tests are unchanged.
export type ShouldStopViaBootoutDeps = LaunchdManagedDeps;
export { isLaunchdManaged };

// Decide whether `gini stop` must use `launchctl bootout` instead of a
// SIGTERM. KeepAlive is `true` on a launchd instance, so a SIGTERM would just
// be respawned — we bootout whenever launchd manages the instance.
export function shouldStopViaBootout(
  instance: string,
  deps: ShouldStopViaBootoutDeps = { isLoaded, plistExists: existsSync, plistPathFor }
): boolean {
  return isLaunchdManaged(instance, deps);
}

// Injectable seams for startViaLaunchd so a unit test runs instantly without
// real launchctl, fetch, or wall-clock waits. Defaults are the real impls.
export interface StartViaLaunchdDeps {
  isRunning: typeof isRunning;
  existingWebUrl: typeof existingWebUrl;
  isLoaded: (instance: string, kind?: PlistKind) => boolean;
  kickstart: (instance: string, kind?: PlistKind) => unknown;
  enable: (options: { instance: string; kinds: PlistKind[] }) => Promise<unknown>;
  sleep: (ms: number) => Promise<void>;
  // Health-wait budget. A kind is "up" once both isRunning() and
  // existingWebUrl() succeed; we poll until then or this deadline.
  healthDeadlineMs: number;
  healthIntervalMs: number;
}

const DEFAULT_START_VIA_LAUNCHD_DEPS: StartViaLaunchdDeps = {
  isRunning,
  existingWebUrl,
  isLoaded,
  kickstart,
  enable,
  sleep: (ms) => Bun.sleep(ms),
  healthDeadlineMs: 45_000,
  healthIntervalMs: 500
};

// Ensure a launchd-managed instance's services are up VIA launchd, mirroring
// the watchdog's revive shape (kickstart a loaded-but-down kind, bootstrap a
// not-loaded one with `autostart enable`) instead of spawning a competing
// detached daemon. Returns the same { banner, runtimeStarted } shape as
// startLifecycle so printStartBanner and the desktop app's health-wait + web
// URL read work unchanged. The happy path — everything already healthy, the
// common case where launchd started it at login — is a zero-churn no-op.
export async function startViaLaunchd(
  config: RuntimeConfig,
  web: WebOptions,
  deps: StartViaLaunchdDeps = DEFAULT_START_VIA_LAUNCHD_DEPS
): Promise<{ banner: Record<string, unknown>; runtimeStarted: boolean }> {
  const instance = config.instance;
  const runtimeUp = await deps.isRunning(config);
  const webUrl = runtimeUp ? await deps.existingWebUrl(config, web.webPort) : null;
  const watchdogLoaded = deps.isLoaded(instance, "watchdog");

  if (runtimeUp && webUrl && watchdogLoaded) {
    // Happy-path no-op: launchd already started everything (e.g. at login or a
    // desktop relaunch). Do NOT bootout/kickstart/enable — zero launchd churn.
    return {
      banner: { running: true, url: url(config), instance, webUrl: operatorWebUrl(config) },
      runtimeStarted: false
    };
  }

  // Revive only what's down, gateway BEFORE web (the web plist shim waits on
  // the gateway): a loaded-but-down kind is kickstarted; a not-loaded kind is
  // bootstrapped via `autostart enable`.
  const ensureUp = async (kind: PlistKind): Promise<void> => {
    if (deps.isLoaded(instance, kind)) deps.kickstart(instance, kind);
    else await deps.enable({ instance, kinds: [kind] });
  };
  if (!runtimeUp) await ensureUp("gateway");
  if (!webUrl) await ensureUp("web");
  if (!watchdogLoaded) await ensureUp("watchdog");

  // Wait for health: both the gateway and the web must come up. Poll until
  // both succeed or the deadline passes.
  let healthyWebUrl: string | null = null;
  const deadline = Date.now() + deps.healthDeadlineMs;
  for (;;) {
    const healthyRuntime = await deps.isRunning(config);
    healthyWebUrl = healthyRuntime ? await deps.existingWebUrl(config, web.webPort) : null;
    if (healthyRuntime && healthyWebUrl) break;
    if (Date.now() >= deadline) break;
    await deps.sleep(deps.healthIntervalMs);
  }

  // Mirror startLifecycle's banner contract (src/cli/process.ts): the verb is
  // `started` only when the runtime was actually down and brought up, else
  // `running`; webUrl and webError are mutually exclusive — set webUrl only
  // when the web is healthy, otherwise carry a webError string (no throw).
  const runtimeStarted = !runtimeUp;
  const banner: Record<string, unknown> = runtimeStarted
    ? { started: true, url: url(config), instance }
    : { running: true, url: url(config), instance };
  if (healthyWebUrl) banner.webUrl = operatorWebUrl(config);
  else banner.webError = `Web did not become healthy within ${Math.round(deps.healthDeadlineMs / 1000)}s.`;
  return { banner, runtimeStarted };
}

// Route `gini start` on the TARGET INSTANCE's launchd state, symmetric to
// `gini stop`. A launchd-managed instance is started via launchd (no competing
// detached daemon); everything else takes the existing daemon/foreground path.
export async function startInstance(
  config: RuntimeConfig,
  web: WebOptions
): Promise<{ banner: Record<string, unknown>; runtimeStarted: boolean }> {
  return isLaunchdManaged(config.instance)
    ? startViaLaunchd(config, web)
    : startLifecycle(config, web);
}

// After a `launchctl bootout`, the runtime/web were SIGKILLed by launchctl and
// never wrote their pid/port files on the way out — sweep the same four files
// stopRuntime removes so `gini status` doesn't misreport a stale instance.
function cleanupRuntimeFiles(config: RuntimeConfig): void {
  const instance = config.instance;
  rmSync(pidPath(instance), { force: true });
  rmSync(runtimePortPath(instance), { force: true });
  rmSync(join(config.stateRoot, "web.pid"), { force: true });
  rmSync(webPortPath(instance), { force: true });
}

export function stop(ctx: CliContext): void {
  // Under launchd, KeepAlive is `true`, so a SIGTERM to the runtime pid
  // would just be respawned. The only way to actually stop a supervised
  // instance is `launchctl bootout`, which unloads the service. We decide
  // on the TARGET INSTANCE's launchd state (services loaded / plist on disk)
  // rather than the calling process's env — a user-run `gini stop` from a
  // terminal has no GINI_SUPERVISOR, so an env-only check would miss a
  // launchd instance and SIGTERM-then-respawn it. `supervisor()==="launchd"`
  // (the gateway calling stop on itself) is an additional fast path. The
  // foreground / `gini run` path falls through to SIGTERM-based stopRuntime.
  const instance = ctx.config.instance;
  if (supervisor() === "launchd" || shouldStopViaBootout(instance)) {
    const result = stopViaBootout(instance);
    cleanupRuntimeFiles(ctx.config);
    print(result);
    return;
  }
  print(stopRuntime(ctx.config));
}

export async function statusCmd(ctx: CliContext): Promise<void> {
  print(await remoteOrLocalStatus(ctx.config, ctx.web));
}

export async function doctorCmd(ctx: CliContext): Promise<void> {
  print(await doctor(ctx.config, ctx.web));
}

export async function reset(ctx: CliContext): Promise<void> {
  await resetInstance(ctx.config);
  print({ reset: true, instance: ctx.config.instance, stateRoot: ctx.config.stateRoot });
}

export async function update(ctx: CliContext): Promise<void> {
  // GINI_STATE_ROOT is the test-mode signal — same convention as `uninstall`.
  // Skip every step that would touch the real $HOME so the command stays
  // exercisable from subprocess tests without clobbering the developer's
  // installed runtime.
  if (process.env.GINI_STATE_ROOT) {
    console.log("gini update: skipped (GINI_STATE_ROOT set; not touching ~/.gini/runtime)");
    return;
  }

  let result;
  try {
    result = await updateRuntime(installedRuntimeDir());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  refreshInstalledWrapper();
  step(formatUpdateSummary(result));

  await convergeUpdatedInstance(ctx.config, ctx.web, result);
}

// Injectable seams for convergeUpdatedInstance so the rehome-vs-restart
// ordering is unit-testable without real launchctl, git, or waits.
// Defaults are the real impls.
export interface UpdateConvergeDeps {
  rehomeUpdatedInstance: (config: RuntimeConfig, web: WebOptions) => Promise<boolean>;
  runningRuntimeNeedsRestart: (config: RuntimeConfig, result: UpdateRestartInput) => Promise<boolean>;
  restartUpdatedInstance: (config: RuntimeConfig, web: WebOptions) => Promise<void>;
}

const DEFAULT_UPDATE_CONVERGE_DEPS: UpdateConvergeDeps = {
  rehomeUpdatedInstance,
  runningRuntimeNeedsRestart,
  restartUpdatedInstance
};

// After the installed runtime is updated, converge the running instance onto
// it. Two legs, in order:
//
//   1. Re-home: a launchd instance whose gateway plist home is not the
//      installed runtime is re-homed onto it (which restarts its services on
//      the new home). This is deliberately INDEPENDENT of the sha comparison
//      below — a wrongly-homed checkout can sit at the very same sha as the
//      freshly updated runtime (so `upToDate` and the /api/status sha both
//      look clean) while every future respawn keeps executing the wrong
//      checkout. `gini update`'s contract is "run the latest installed
//      runtime", so the home converges even when no code changed. A re-home
//      already restarted everything; the second leg is skipped.
//   2. Restart: the existing sha-based check — restart the running instance
//      when the update changed code or the runtime can't prove it's on the
//      new sha.
export async function convergeUpdatedInstance(
  config: RuntimeConfig,
  web: WebOptions,
  result: UpdateRestartInput,
  deps: UpdateConvergeDeps = DEFAULT_UPDATE_CONVERGE_DEPS
): Promise<void> {
  if (await deps.rehomeUpdatedInstance(config, web)) return;
  if (await deps.runningRuntimeNeedsRestart(config, result)) {
    step("Restarting running instance");
    await deps.restartUpdatedInstance(config, web);
    step("Running instance restarted");
  }
}

// Injectable seams for rehomeUpdatedInstance so a unit test runs instantly
// without real plists, launchctl, fetch, or wall-clock waits. Defaults are
// the real impls.
export interface RehomeUpdatedInstanceDeps {
  // Reads the instance's gateway plist WorkingDirectory; null when the
  // instance has no gateway plist (foreground / `gini run` / conductor —
  // never re-homed).
  gatewayPlistHome: (instance: string) => string | null;
  installedRuntimeDir: typeof installedRuntimeDir;
  enable: (options: { instance: string; kinds: PlistKind[]; homeDir: string }) => Promise<{ ok: boolean; error?: string }>;
  isRunning: typeof isRunning;
  existingWebUrl: typeof existingWebUrl;
  sleep: (ms: number) => Promise<void>;
  // Health-wait budget after the re-home's restart, mirroring
  // startViaLaunchd's gate.
  healthDeadlineMs: number;
  healthIntervalMs: number;
}

const DEFAULT_REHOME_UPDATED_INSTANCE_DEPS: RehomeUpdatedInstanceDeps = {
  gatewayPlistHome: (instance) => readPlistWorkingDirectory(plistPathFor(instance, "gateway")),
  installedRuntimeDir,
  enable,
  isRunning,
  existingWebUrl,
  sleep: (ms) => Bun.sleep(ms),
  healthDeadlineMs: 45_000,
  healthIntervalMs: 500
};

// Re-home a launchd instance whose plists point anywhere other than the
// installed runtime. `gini update` mutates ~/.gini/runtime, but a plist
// homed on some other checkout keeps executing THAT checkout's code across
// every respawn — the update never reaches the running instance. The plist
// home is sticky by design (see resolveLaunchSpecPair in
// src/cli/autostart.ts), so this is the one sanctioned mover:
// enable({homeDir: installedRuntimeDir()}) regenerates the plists on the
// installed runtime and restarts the services (bootout + bootstrap +
// kickstart), then we wait for the gateway and web to come back healthy the
// way startViaLaunchd does. The compare is realpath-based (a symlinked
// ~/.gini/runtime must not read as wrongly homed), and a recorded home that
// no longer exists fails the compare, so an instance homed on a deleted
// checkout self-heals here too. Returns whether a re-home happened — the
// caller then skips its own restart, because enable already restarted the
// services.
export async function rehomeUpdatedInstance(
  config: RuntimeConfig,
  web: WebOptions,
  deps: RehomeUpdatedInstanceDeps = DEFAULT_REHOME_UPDATED_INSTANCE_DEPS
): Promise<boolean> {
  const instance = config.instance;
  const currentHome = deps.gatewayPlistHome(instance);
  if (currentHome === null) return false;
  const installed = deps.installedRuntimeDir();
  if (sameRealPath(currentHome, installed)) return false;
  step(`Re-homing instance '${instance}' onto the installed runtime (was ${tildify(currentHome)}, now ${tildify(installed)})`);
  const enabled = await deps.enable({ instance, kinds: ["gateway", "web", "watchdog"], homeDir: installed });
  if (!enabled.ok) {
    warn(`Re-home failed: ${enabled.error ?? "autostart enable failed"}. Recover with \`gini autostart enable --instance ${instance} --home ${installed}\`.`);
    return true;
  }
  // enable's bootout+bootstrap+kickstart already restarted the services on
  // the new home; wait for the gateway and web to answer again so the
  // command doesn't report success while the instance is still booting.
  const deadline = Date.now() + deps.healthDeadlineMs;
  for (;;) {
    const runtimeUp = await deps.isRunning(config);
    const webUrl = runtimeUp ? await deps.existingWebUrl(config, web.webPort) : null;
    if (runtimeUp && webUrl) {
      step("Running instance restarted on the installed runtime");
      return true;
    }
    if (Date.now() >= deadline) break;
    await deps.sleep(deps.healthIntervalMs);
  }
  warn(`Instance did not report healthy within ${Math.round(deps.healthDeadlineMs / 1000)}s after re-home. Check \`gini status --instance ${instance}\`.`);
  return true;
}

// Injectable seams for restartUpdatedInstance so the launchd-vs-foreground
// restart branch is unit-testable without real launchctl, SIGTERM, or
// wall-clock waits. Defaults are the real impls.
export interface RestartUpdatedInstanceDeps {
  isGatewayLoaded: (instance: string) => boolean;
  stopViaBootout: typeof stopViaBootout;
  cleanupRuntimeFiles: (config: RuntimeConfig) => void;
  stopRuntime: typeof stopRuntime;
  waitForRuntimeStopped: typeof waitForRuntimeStopped;
  startInstance: typeof startInstance;
}

const DEFAULT_RESTART_UPDATED_INSTANCE_DEPS: RestartUpdatedInstanceDeps = {
  isGatewayLoaded: (instance) => isLoaded(instance, "gateway"),
  stopViaBootout,
  cleanupRuntimeFiles,
  stopRuntime,
  waitForRuntimeStopped,
  startInstance
};

// Stop the running instance and start it on the fresh code, routing on whether
// the gateway is actively LOADED under launchd. Bootout only stops a loaded
// launchd job, so a not-loaded/foreground gateway takes the SIGTERM path. On a
// loaded launchd gateway KeepAlive respawns a plain SIGTERM, so stopRuntime +
// waitForRuntimeStopped would time out; bootout unloads the service (KeepAlive
// no longer applies), then we sweep the pid/port files the launchctl-killed
// runtime never wrote and wait until the booted-out gateway stops answering.
// The non-launchd path keeps the SIGTERM-based stop. startInstance (already
// launchd-aware) brings it back up either way.
export async function restartUpdatedInstance(
  config: RuntimeConfig,
  web: WebOptions,
  deps: RestartUpdatedInstanceDeps = DEFAULT_RESTART_UPDATED_INSTANCE_DEPS
): Promise<void> {
  const instance = config.instance;
  if (deps.isGatewayLoaded(instance)) {
    deps.stopViaBootout(instance);
    deps.cleanupRuntimeFiles(config);
    const stopped = await deps.waitForRuntimeStopped(config);
    if (!stopped) {
      throw new Error(`Timed out waiting for instance '${instance}' to stop before restart.`);
    }
  } else {
    const stopResult = deps.stopRuntime(config);
    const stopped = await deps.waitForRuntimeStopped(config, typeof stopResult.pid === "number" ? stopResult.pid : undefined);
    if (!stopped) {
      throw new Error(`Timed out waiting for instance '${instance}' to stop before restart.`);
    }
  }
  await deps.startInstance(config, web);
}

interface UpdateRestartInput {
  upToDate: boolean;
  afterSha: string;
}

export function updateRequiresRuntimeRestart(result: UpdateRestartInput, runningStatus: unknown): boolean {
  if (!result.upToDate) return true;
  return statusVersionSha(runningStatus) !== result.afterSha;
}

export function formatUpdateSummary(result: UpdateRestartInput & { commitCount: string }): string {
  const commitLabel = `${result.commitCount} commit${result.commitCount === "1" ? "" : "s"}`;
  const shortSha = result.afterSha.slice(0, 7);
  return result.upToDate
    ? `Gini already up to date at ${shortSha} (${commitLabel})`
    : `Gini updated to ${shortSha} (${commitLabel})`;
}

async function runningRuntimeNeedsRestart(config: RuntimeConfig, result: UpdateRestartInput): Promise<boolean> {
  if (!await isRunning(config)) return false;
  if (!result.upToDate) return true;
  try {
    return updateRequiresRuntimeRestart(result, await api(config, "/api/status"));
  } catch {
    return false;
  }
}

function statusVersionSha(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const version = (value as { version?: unknown }).version;
  if (!version || typeof version !== "object") return null;
  const git = (version as { git?: unknown }).git;
  if (!git || typeof git !== "object") return null;
  const sha = (git as { sha?: unknown }).sha;
  return typeof sha === "string" && sha.length > 0 ? sha : null;
}

function refreshInstalledWrapper(): void {
  const wrapperPath = join(homedir(), ".local", "bin", "gini");
  if (!existsSync(wrapperPath)) return;
  let contents: string;
  try {
    contents = readFileSync(wrapperPath, "utf8");
  } catch {
    return;
  }
  if (!contents.includes("gini-agent-installer-managed")) return;
  const next = `#!/usr/bin/env bash
# gini-agent-installer-managed
set -euo pipefail
if [ -f "$HOME/.gini/secrets.env" ]; then
  set +e
  set -a
  . "$HOME/.gini/secrets.env" || printf 'gini: warning — failed to source ~/.gini/secrets.env, continuing without it\\n' >&2
  set +a
  set -e
fi
export GINI_INSTANCE="\${GINI_INSTANCE:-default}"
cd "$HOME/.gini/runtime"
exec bun --silent run gini "$@"
`;
  if (contents === next) return;
  try {
    writeFileSync(wrapperPath, next, { mode: 0o755 });
  } catch {
    // Best-effort. The update itself succeeded; a stale wrapper only affects
    // whether Bun prints the script command before future CLI output.
  }
}

export async function uninstall(ctx: CliContext): Promise<void> {
  const yes = hasFlag(ctx.rawArgs, "--yes");
  const purge = hasFlag(ctx.rawArgs, "--purge");

  if (ctx.explicitInstance) {
    // Disable autostart FIRST so launchd doesn't respawn the runtime
    // mid-uninstall. Bootout failures are surfaced via warn() so a broken
    // plist doesn't get silently dropped; state deletion still proceeds.
    const autostart = await disableForUninstall(ctx.config.instance);
    if (autostart.failures.length > 0) {
      for (const f of autostart.failures) {
        warn(`autostart unload (${f.kind}): ${f.error}`);
      }
      warn("Continuing with uninstall — you may need to clean up the plist manually.");
    }
    // Stop the runtime first if it's running — otherwise removing stateRoot
    // out from under a live process leaves the daemon writing to a deleted
    // directory until it crashes.
    if (await isRunning(ctx.config)) stopRuntime(ctx.config);
    uninstallInstance(ctx.config);
    print({ uninstalled: true, instance: ctx.config.instance, stateRoot: ctx.config.stateRoot, logRoot: ctx.config.logRoot, autostart });
    return;
  }

  await fullUninstall({ yes, purge });
}

interface FullUninstallFlags {
  yes: boolean;
  purge: boolean;
}

async function fullUninstall(flags: FullUninstallFlags): Promise<void> {
  const skipPrompts = flags.yes || flags.purge;
  if (!skipPrompts && !process.stdin.isTTY) {
    console.error("Refusing to run interactively without a TTY. Pass --yes or --purge to proceed.");
    process.exit(1);
  }

  let deleteInstances = flags.purge;

  if (!skipPrompts) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const proceed = await rl.question(`${COLOR.cyan}?${COLOR.reset} This will uninstall gini-agent. Continue? [y/N] `);
      if (!isYes(proceed, false)) {
        console.log("Aborted.");
        return;
      }
      const keep = await rl.question(`${COLOR.cyan}?${COLOR.reset} Keep your instance state at ~/.gini/instances/? [Y/n] `);
      deleteInstances = !isYes(keep, true);
    } finally {
      rl.close();
    }
  }

  console.log("");
  header("Uninstalling gini-agent");

  // Collect autostart bootout warnings across all instances; surface them
  // after uninstallAll completes so the warn lines don't get interleaved
  // with the per-instance "Stopped N/M" summary lines printed below.
  const autostartWarnings: string[] = [];
  const result = await uninstallAll({
    deleteInstances,
    stopInstance: async (name) => {
      // Disable autostart before stopping the runtime so launchd doesn't
      // respawn it the instant we send SIGTERM. Bootout failures are
      // captured for a post-loop warn() pass — a stale plist with no
      // service is still better than a half-uninstalled instance.
      const autostartResult = await disableForUninstall(name);
      for (const f of autostartResult.failures) {
        autostartWarnings.push(`autostart unload [${name}] (${f.kind}): ${f.error}`);
      }
      const cfg = loadConfig(name);
      if (!(await isRunning(cfg))) return;
      const outcome = stopRuntime(cfg);
      if (!outcome.stopped) {
        const reason = outcome.error ?? outcome.reason ?? "unknown error";
        throw new Error(reason);
      }
    }
  });
  for (const w of autostartWarnings) warn(w);

  // GINI_STATE_ROOT is the test-mode signal. When set, the user is not actually
  // tearing down their real install — they're exercising the code path against
  // a scratch directory — so we skip everything that touches the real $HOME
  // (rc files, wrapper, runtime checkout, model cache).
  const testMode = Boolean(process.env.GINI_STATE_ROOT);

  const rcEdits = testMode ? [] : removePathBlockFromRc();

  const home = homedir();
  const wrapperPath = join(home, ".local", "bin", "gini");
  const runtimeDir = join(home, ".gini", "runtime");
  const modelsDir = join(home, ".gini", "models");

  const wrapperOutcome = testMode
    ? { message: "skipped (GINI_STATE_ROOT set)", shouldRemove: false }
    : describeWrapper(wrapperPath);
  const modelsNote = testMode ? undefined : describeModels(modelsDir);

  if (result.instances.length > 0) {
    const stoppedCount = result.stopped.length;
    const total = result.instances.length;
    if (result.stopErrors.length > 0) {
      warn(`Stopped ${stoppedCount}/${total} instance${total === 1 ? "" : "s"} (${result.stopErrors.length} had errors)`);
      for (const f of result.stopErrors) console.error(`    - ${f.instance}: ${f.error}`);
    } else if (stoppedCount > 0) {
      step(`Stopped ${stoppedCount} instance${stoppedCount === 1 ? "" : "s"}`);
    }

    if (deleteInstances) {
      step(`Deleted instance state (${total} instance${total === 1 ? "" : "s"})`);
      if (result.stopErrors.length > 0) {
        warn("Deleted state even though one or more instances did not stop cleanly.");
      }
    } else {
      info(`Kept instance state (${total} instance${total === 1 ? "" : "s"})`);
    }
  }

  if (rcEdits.length > 0) {
    for (const file of rcEdits) step(`Cleaned shell rc (${tildify(file)})`);
  }

  if (wrapperOutcome.shouldRemove) {
    step(`Removed wrapper (${tildify(wrapperPath)})`);
    try { rmSync(wrapperPath, { force: true }); } catch (error) {
      warn(`Failed to remove wrapper: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else if (!testMode && wrapperOutcome.message.startsWith("kept")) {
    warn(`Wrapper not removed: ${wrapperOutcome.message}`);
  }

  if (!testMode && existsSync(runtimeDir)) {
    step(`Removed runtime (${tildify(runtimeDir)})`);
    // Unix keeps file handles alive on unlinked inodes so this is safe even
    // though we may be executing from runtimeDir right now.
    try { rmSync(runtimeDir, { recursive: true, force: true }); } catch (error) {
      warn(`Failed to remove runtime: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  footer("gini-agent uninstalled.");
  if (modelsNote) console.log(modelsNote);
  console.log("");
}

function isYes(input: string, defaultYes: boolean): boolean {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === "") return defaultYes;
  return trimmed === "y" || trimmed === "yes";
}

const RC_MARKER = "# Added by gini-agent installer";
const EXPECTED_PATH_LINES = new Set([
  'export PATH="$HOME/.local/bin:$PATH"',
  'fish_add_path "$HOME/.local/bin"'
]);

function removePathBlockFromRc(): string[] {
  const home = homedir();
  const candidates: string[] = [];
  const zdotdir = process.env.ZDOTDIR;
  if (zdotdir) candidates.push(join(zdotdir, ".zshrc"));
  candidates.push(
    join(home, ".zshrc"),
    join(home, ".bashrc"),
    join(home, ".bash_profile"),
    join(home, ".config", "fish", "config.fish")
  );
  const edited: string[] = [];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    let contents: string;
    try { contents = readFileSync(file, "utf8"); } catch { continue; }
    const lines = contents.split("\n");
    const next: string[] = [];
    let removed = false;
    let skippedMismatched = false;
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i]?.trim() === RC_MARKER) {
        const followup = lines[i + 1]?.trim() ?? "";
        if (EXPECTED_PATH_LINES.has(followup)) {
          i += 1;
          removed = true;
          continue;
        }
        skippedMismatched = true;
      }
      next.push(lines[i] ?? "");
    }
    if (skippedMismatched) {
      console.error(`Warning: found installer marker in ${file} but the following line didn't match the expected PATH update. Skipping rc cleanup for ${file}.`);
    }
    if (!removed) continue;
    try {
      writeFileSync(file, next.join("\n"));
      edited.push(file);
    } catch (error) {
      console.error(`Could not edit ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return edited;
}

interface WrapperOutcome {
  message: string;
  shouldRemove: boolean;
}

function describeWrapper(path: string): WrapperOutcome {
  if (!existsSync(path)) return { message: "absent", shouldRemove: false };
  let contents = "";
  try { contents = readFileSync(path, "utf8"); } catch { return { message: `unreadable at ${path}`, shouldRemove: false }; }
  const lines = contents.split("\n");
  const hasMarker = lines.some((line) => line.trim() === "# gini-agent-installer-managed");
  if (!hasMarker) {
    return { message: `kept (not installer-managed at ${path})`, shouldRemove: false };
  }
  return { message: `will remove ${path}`, shouldRemove: true };
}

function describeModels(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  let size = "unknown size";
  try {
    // 30s cap so a stuck filesystem can't block the whole uninstall on a
    // best-effort cosmetic measurement.
    const result = spawnSync("du", ["-sh", path], { encoding: "utf8", timeout: 30_000 });
    const out = result.stdout?.trim();
    if (out) {
      const first = out.split(/\s+/)[0];
      if (first) size = first;
    }
  } catch {
    // best-effort
  }
  return `${COLOR.dim}•${COLOR.reset} Model cache at ${tildify(path)} (${size}) kept. Remove with: rm -rf ${tildify(path)}`;
}

// Foreground twin of `start`. Runs the runtime (and optionally Next.js)
// attached to this CLI process: stdio inherits, no detach, signals tear the
// children down. Use this from worktrees and CI where the instance should die
// when the launching session ends. `gini start` remains the daemon path.
export async function runForeground(ctx: CliContext): Promise<void> {
  // Refuse to attach to a runtime we did not spawn. If the instance is already up
  // (likely a previous `gini start`), our signal handlers cannot govern its
  // lifetime — that's exactly the bug `gini run` was created to avoid.
  if (await isRunning(ctx.config)) {
    throw new Error(`Instance '${ctx.config.instance}' already has a runtime running. Stop it with \`gini stop --instance ${ctx.config.instance}\` before running in foreground.`);
  }
  // Install signal handlers BEFORE start() so a Ctrl-C during startup still
  // tears down any partially-launched child.
  let shuttingDown = false;
  let runtimeChild: ChildProcess | null = null;
  let webChild: ChildProcess | null = null;
  let exitCode = 0;
  // Resolve when both children we own have exited (or when shutdown completes
  // for a started-then-failed case).
  let resolveDone: (() => void) | null = null;
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });

  function aliveChildren(): ChildProcess[] {
    const list: ChildProcess[] = [];
    if (runtimeChild && runtimeChild.exitCode === null && runtimeChild.signalCode === null) list.push(runtimeChild);
    if (webChild && webChild.exitCode === null && webChild.signalCode === null) list.push(webChild);
    return list;
  }

  function maybeResolve(): void {
    if (aliveChildren().length === 0 && shuttingDown) {
      // Stop files written by start()/startWeb(). The pid/port files are not
      // load-bearing for the foreground path (parent owns the children
      // directly), but cleaning them keeps `gini status` from misreporting
      // a stale instance after we exit.
      stopRuntime(ctx.config);
      resolveDone?.();
    }
  }

  async function shutdown(reason: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`gini run: shutting down (${reason})`);
    const children = aliveChildren();
    for (const child of children) {
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
    }
    // Escalate to SIGKILL only after the child's own bounded drain has had room
    // to finish (see RUNTIME_CHILD_SIGKILL_GRACE_MS), so a cleanly draining
    // runtime can write its shutdown marker before we force-kill it.
    const deadline = Date.now() + RUNTIME_CHILD_SIGKILL_GRACE_MS;
    while (aliveChildren().length > 0 && Date.now() < deadline) {
      await Bun.sleep(100);
    }
    for (const child of aliveChildren()) {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }
    // Give the OS a tick to reap, then resolve.
    await Bun.sleep(50);
    maybeResolve();
  }

  process.on("SIGINT", () => { exitCode = 130; void shutdown("SIGINT"); });
  process.on("SIGTERM", () => { exitCode = 143; void shutdown("SIGTERM"); });
  process.on("SIGHUP", () => { exitCode = 129; void shutdown("SIGHUP"); });

  try {
    const { banner, children } = await startLifecycle(ctx.config, { ...ctx.web, foreground: true });
    runtimeChild = children.runtime;
    webChild = children.web;
    printStartBanner(banner);
  } catch (error) {
    // Startup failed — clean up any partial state and surface the error.
    // Do NOT pre-set shuttingDown: shutdown() early-returns when the flag is
    // already set, which would turn this cleanup into a no-op and skip the
    // stopRuntime() state-file sweep (a leaked child from a failed start()
    // is reaped inside start() itself; see process.ts).
    await shutdown("startup-error");
    throw error;
  }

  // Wire child-exit watchers AFTER we've captured handles. If either child
  // exits unexpectedly (i.e. we're not already shutting down), tear the other
  // one down and exit non-zero so the user notices.
  function watch(child: ChildProcess | null, label: string): void {
    if (!child) return;
    child.on("exit", (code, signal) => {
      if (!shuttingDown) {
        console.error(`gini run: ${label} exited (code=${code ?? "null"} signal=${signal ?? "null"}); tearing down`);
        exitCode = code && code !== 0 ? code : 1;
        void shutdown(`${label}-exit`);
      } else {
        maybeResolve();
      }
    });
  }
  watch(runtimeChild, "runtime");
  watch(webChild, "web");

  // A signal that landed while startLifecycle was still running found
  // aliveChildren() empty (the handles weren't assigned yet), so its
  // shutdown() killed nothing and already resolved `done`. Reap the
  // now-known children before falling through to the resolved await.
  if (shuttingDown) {
    for (const child of aliveChildren()) {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }
  }

  // Edge: --no-web AND runtime was already running (we'd have thrown above) —
  // so at least one child must exist by here. Defensive fallback for typing.
  if (!runtimeChild && !webChild) {
    stopRuntime(ctx.config);
    return;
  }

  await done;
  // Flush foreground log tee streams before exiting so the tail of a crashing
  // child's output isn't lost on signal-driven exits (SIGINT/SIGTERM/SIGHUP /
  // non-zero child exit). `process.exit` does not wait for write streams to
  // finish, so we explicitly await `'finish'` on each registered stream.
  await awaitForegroundLogFlush();
  if (exitCode !== 0) process.exit(exitCode);
}

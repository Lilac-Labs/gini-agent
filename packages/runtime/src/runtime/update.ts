import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { logDir, projectRoot, updateInProgressMarkerPath } from "../paths";
import { isLoaded, supervisor } from "../integrations/launchd";
import type { Instance } from "../types";

const EXPECTED_ORIGIN = "https://github.com/Open-Curiosity/gini-agent";
// Origins from before the GitHub org rename. GitHub redirects these to the
// current location, so a runtime whose origin still names the old org fetches
// fine — keep accepting them so `gini update` doesn't refuse on installs that
// predate the rename.
const LEGACY_ORIGINS: readonly string[] = ["https://github.com/Lilac-Labs/gini-agent"];
const MAX_INSTALL_FAILURE_OUTPUT = 4000;

// Sha-keyed production web bundles. The update/install flows build the
// Next.js app into packages/web/<prefix><sha12>, where <sha12> is `git rev-parse
// --short=12 HEAD` of the checkout that was built. Every serving path (the
// launchd web shim in src/cli/autostart.ts and startWeb in
// src/cli/process.ts) serves `next start` from that dir iff it exists with a
// BUILD_ID for the CURRENT checkout, falling back to `next dev` otherwise.
// The sha key pins a bundle to the commit it was built from — note it sees
// HEAD, not the working tree, so only the installed runtime (kept clean by
// `git reset --hard`) is stale-proof by construction; a repo checkout with
// uncommitted edits and a hand-built bundle for its HEAD serves that bundle
// anyway. See ADR web-production-serving.md.
export const WEB_PROD_DIST_PREFIX = ".next-prod-";

export interface GiniVersionInfo {
  packageVersion: string;
  runtimeDir: string;
  git: {
    sha: string | null;
    shortSha: string | null;
    branch: string | null;
    origin: string | null;
    upstreamSha: string | null;
    updateAvailable: boolean;
  };
  installedRuntimePresent: boolean;
  update: {
    supported: boolean;
    reason?: string;
  };
}

export interface GiniUpdateResult {
  beforeSha: string;
  afterSha: string;
  commitCount: string;
  upToDate: boolean;
  runtimeDir: string;
  version: GiniVersionInfo;
}

export function installedRuntimeDir(): string {
  return join(process.env.HOME || homedir(), ".gini", "runtime");
}

export function currentVersionInfo(runtimeDir = projectRoot()): GiniVersionInfo {
  const packageVersion = readPackageVersion(runtimeDir);
  const sha = git(runtimeDir, ["rev-parse", "HEAD"]);
  const branch = git(runtimeDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const origin = git(runtimeDir, ["remote", "get-url", "origin"]);
  const upstreamSha = git(runtimeDir, ["rev-parse", "--verify", "origin/HEAD"]);
  return {
    packageVersion,
    runtimeDir,
    git: {
      sha,
      shortSha: sha ? sha.slice(0, 7) : null,
      branch,
      origin,
      upstreamSha,
      updateAvailable: Boolean(sha && upstreamSha && sha !== upstreamSha)
    },
    installedRuntimePresent: existsSync(join(installedRuntimeDir(), ".git")),
    update: updateSupport(runtimeDir)
  };
}

export async function refreshVersionInfo(runtimeDir = projectRoot()): Promise<GiniVersionInfo> {
  const support = updateSupport(runtimeDir);
  if (!support.supported) return currentVersionInfo(runtimeDir);
  if (existsSync(join(runtimeDir, ".git"))) {
    const fetchRes = await runStep("git", ["-C", runtimeDir, "fetch", "origin"], { stdio: "pipe" });
    if (fetchRes.status !== 0) {
      const stderr = fetchRes.stderr.trim();
      throw new Error(`gini update check: git fetch origin failed${stderr ? `: ${stderr}` : "."}`);
    }
  }
  return currentVersionInfo(runtimeDir);
}

// Outcome of an awaited subprocess step.
export interface RunStepResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

// Awaited async runner for the update's long steps (the git fetch, both bun
// installs, and the web production build). Together these can take 40-90s+;
// running them via spawnSync inside the gateway's POST /api/update handler
// blocked the event loop for the whole window — the gateway couldn't answer
// /api/status, so the watchdog read a healthy-but-updating gateway as dead
// and force-killed it mid-update. spawn + await keeps the loop free.
// Injectable seam for tests (mirrors the spawnImpl seam in
// src/runtime/autostart-refresh.ts) so no real subprocess runs.
export type RunStepImpl = (
  cmd: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; stdio: "inherit" | "pipe" }
) => Promise<RunStepResult>;

function runStep(
  cmd: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; stdio: "inherit" | "pipe" }
): Promise<RunStepResult> {
  const { promise, resolve } = Promise.withResolvers<RunStepResult>();
  const child = spawn(cmd, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: options.stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
  // A spawn failure (e.g. ENOENT) emits "error" and may never emit "close";
  // resolve with a null status so callers surface it like a non-zero exit.
  child.on("error", (error) => { resolve({ status: null, stdout, stderr: stderr || error.message }); });
  child.on("close", (code) => { resolve({ status: code, stdout, stderr }); });
  return promise;
}

export interface UpdateRuntimeOptions {
  stdio?: "inherit" | "pipe";
  runStepImpl?: RunStepImpl;
}

// Single-flight guard: at most one update mutates the runtime at a time.
// Two interleaved updates would race `git reset --hard` against each
// other's bun installs / build and could leave a half-installed tree, so a
// second caller is rejected with a stable message that the HTTP layer maps
// to 409 (statusFromErrorMessage in src/http.ts). Module-level, so
// process-local: it serializes the gateway's own update entry points but
// not a concurrent CLI `gini update` from another process, which still
// races against the same ~/.gini/runtime.
let updateInFlight: Promise<GiniUpdateResult> | null = null;

// Whether THIS process currently has an update in flight (the single-flight
// guard above is held). Surfaced as `updateInProgress` on GET /api/version
// so the browser's UpdateGate can tell a still-working update from a hung
// one and extend its blur deadline only while work is actually happening.
export function isUpdateInFlight(): boolean {
  return updateInFlight !== null;
}

export function updateRuntime(runtimeDir = installedRuntimeDir(), options: UpdateRuntimeOptions = {}): Promise<GiniUpdateResult> {
  if (updateInFlight) {
    return Promise.reject(new Error("gini update already in progress."));
  }
  const run = performUpdate(runtimeDir, options);
  updateInFlight = run;
  return run.finally(() => { updateInFlight = null; });
}

async function performUpdate(runtimeDir: string, options: UpdateRuntimeOptions): Promise<GiniUpdateResult> {
  assertUpdateTarget(runtimeDir);
  const stdio = options.stdio ?? "pipe";
  const runStepImpl = options.runStepImpl ?? runStep;

  // Mark the update window on disk for the watchdog: while this marker is
  // fresh it suppresses revive actions, because probe misses are EXPECTED
  // here — the bun installs swap node_modules under the live web server and
  // the build pegs the CPU, so a 2s health probe can time out against a
  // healthy-but-busy service. Removed in the finally below. The body carries
  // OUR pid so the watchdog can tell a live update from a dead one: if the
  // updating process is gone (it crashed, or was killed, before the finally
  // ran), the marker is stale immediately rather than muting the safety net
  // for the full 15-minute mtime backstop. Advisory only — a marker I/O
  // failure never fails the update.
  const marker = updateInProgressMarkerPath();
  try {
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, `${JSON.stringify({ pid: process.pid })}\n`);
  } catch {
    // Advisory marker; proceed without watchdog suppression.
  }

  try {
    const beforeSha = requireGit(runtimeDir, ["rev-parse", "HEAD"], "could not read current HEAD");
    const fetchRes = await runStepImpl("git", ["-C", runtimeDir, "fetch", "origin"], { stdio: "pipe" });
    if (fetchRes.status !== 0) {
      const stderr = fetchRes.stderr.trim();
      throw new Error(`gini update: git fetch origin failed${stderr ? `: ${stderr}` : "."}`);
    }

    const resetRes = spawnSync("git", ["-C", runtimeDir, "reset", "--hard", "origin/HEAD"], { encoding: "utf8" });
    if (resetRes.status !== 0) {
      const stderr = (resetRes.stderr ?? "").trim();
      throw new Error(`gini update: git reset --hard origin/HEAD failed${stderr ? `: ${stderr}` : "."}`);
    }

    const afterSha = requireGit(runtimeDir, ["rev-parse", "HEAD"], "could not read new HEAD");
    await runBunInstall(runtimeDir, "bun install", stdio, runStepImpl);

    const webDir = join(runtimeDir, "packages", "web");
    if (existsSync(join(webDir, "package.json"))) {
      await runBunInstall(webDir, "bun install in packages/web/", stdio, runStepImpl);
      // Build the sha-keyed production bundle for the NEW head so the
      // restarted web service serves prebuilt assets via `next start` instead
      // of JIT-compiling every route under `next dev` (the cause of the
      // post-update outage when a Next version bump invalidates the dev
      // cache). On failure this throws like the install steps above, so the
      // caller never schedules a restart and the old server keeps serving.
      const sha12 = requireGit(runtimeDir, ["rev-parse", "--short=12", "HEAD"], "could not read new HEAD short sha");
      // Preserve the previous HEAD's bundle through the GC: the old web
      // server is still serving from it until the restart lands, so deleting
      // it would 500 the live server on not-yet-loaded routes. The old commit
      // is still reachable after the reset, so its short-12 form resolves. A
      // later update GCs it once it's two generations old.
      const beforeSha12 = git(runtimeDir, ["rev-parse", "--short=12", beforeSha]);
      const preserveDistDirs = beforeSha12 && beforeSha12 !== sha12 ? [`${WEB_PROD_DIST_PREFIX}${beforeSha12}`] : [];
      await buildWebProdBundle(runtimeDir, sha12, stdio, { runStepImpl, preserveDistDirs });
    }

    const upToDate = beforeSha === afterSha;
    const commitCount = upToDate
      ? "0"
      : git(runtimeDir, ["rev-list", "--count", `${beforeSha}..${afterSha}`]) ?? "?";

    return {
      beforeSha,
      afterSha,
      commitCount,
      upToDate,
      runtimeDir,
      version: currentVersionInfo(runtimeDir)
    };
  } finally {
    try {
      rmSync(marker, { force: true });
    } catch {
      // Best-effort: a leftover marker goes stale after 15 minutes anyway.
    }
  }
}

// Test seams for scheduleRuntimeRestart. Production callers (http.ts POST
// /api/update) pass nothing and get the real child_process.spawn and
// process.kill — tests inject recorders so they neither spawn a real
// subprocess nor SIGTERM the test runner. Mirrors the spawnImpl seam in
// src/runtime/autostart-refresh.ts.
export interface ScheduleRestartOptions {
  spawnImpl?: typeof spawn;
  killImpl?: (pid: number, signal: NodeJS.Signals | number) => void;
  gatewayLoadedImpl?: (instance: Instance) => boolean;
}

export function scheduleRuntimeRestart(instance: Instance, options: ScheduleRestartOptions = {}): boolean {
  const root = projectRoot();
  const oldPid = process.pid;
  const logFile = join(logDir(instance), "update-restart.log");
  const spawnFn = options.spawnImpl ?? spawn;
  const killFn = options.killImpl ?? ((pid: number, signal: NodeJS.Signals | number) => { process.kill(pid, signal); });
  const gatewayLoaded = options.gatewayLoadedImpl ?? ((i: Instance) => isLoaded(i, "gateway"));
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    appendFileSync(logFile, `[${new Date().toISOString()}] restart requested cwd=${root} supervisor=${supervisor() ?? "none"}\n`);
  } catch {
    // Logging is best-effort; restart should still be attempted.
  }

  let outFd: number | "ignore" = "ignore";
  let errFd: number | "ignore" = "ignore";
  try {
    outFd = openSync(logFile, "a");
    errFd = openSync(logFile, "a");
  } catch {
    // Fall back to ignored stdio.
  }

  // Route on whether the GATEWAY is actively LOADED under launchd, not solely
  // the gateway's own GINI_SUPERVISOR env. This branch's restart relies on
  // KeepAlive respawning the self-SIGTERM, which only happens for a loaded
  // launchd gateway. The common case is a launchd-spawned gateway
  // (supervisor()==="launchd"); but a foreground gateway running on an
  // instance whose launchd gateway is ALSO loaded (dual supervision) must take
  // this same path: its self-SIGTERM frees the canonical port, the launchd
  // gateway service binds it, and web/watchdog are kicked. Falling through to
  // the foreground stop+start helper there could spawn a competing detached
  // daemon and walk the canonical port to an offset. A booted-out-plist or
  // pure-foreground instance (gatewayLoaded false) takes the foreground branch
  // instead, where the launchd-aware `gini start` bootstraps the gateway from
  // its plist — there is no loaded job for KeepAlive to respawn here.
  //
  // updateRuntime has already been awaited to completion (`git reset --hard`
  // + `bun install` + the web build) by the time we get here, so the working
  // tree is the fresh code with no install/respawn race. We:
  //   1. Spawn detached, unref'd `gini autostart kick` children for the web
  //      service (re-execs with any new web/ deps) AND the watchdog. The
  //      watchdog is a long-lived KeepAlive loop, so nothing else replaces
  //      its process on a code-only update — neither KeepAlive (it never
  //      exits) nor the plist-stamp reconcile (the template is unchanged);
  //      without the kick it would run the old code until logout. Both
  //      children must survive our own exit, so they're detached and we
  //      self-SIGTERM after. The gateway is NOT kicked — a kickstart -k
  //      would force-kill it mid-drain; its restart is the self-SIGTERM.
  //   2. Self-SIGTERM. The server's SIGTERM handler drains and exits 0;
  //      KeepAlive:true respawns the gateway with the fresh code.
  // This keeps the gateway under launchd supervision (no detached
  // stop+start helper that would reparent the respawn to PID 1 and orphan
  // it outside KeepAlive).
  if (supervisor() === "launchd" || gatewayLoaded(instance)) {
    try {
      for (const kind of ["web", "watchdog"] as const) {
        const child = spawnFn(process.execPath, [
          "run", "gini", "autostart", "kick",
          "--instance", instance,
          "--kind", kind
        ], {
          cwd: root,
          detached: true,
          stdio: ["ignore", outFd, errFd],
          env: { ...process.env, GINI_INSTANCE: instance }
        });
        if (typeof child.unref === "function") child.unref();
      }
    } catch (error) {
      try {
        appendFileSync(logFile, `[${new Date().toISOString()}] kick spawn failed: ${error instanceof Error ? error.message : String(error)}\n`);
      } catch { /* swallowed */ }
    } finally {
      // Parent's FD copies aren't needed after spawn — the child got
      // dup'd copies. Close them so the test runner (which reuses the
      // process) doesn't leak FDs.
      if (typeof outFd === "number") { try { closeSync(outFd); } catch { /* ignore */ } }
      if (typeof errFd === "number") { try { closeSync(errFd); } catch { /* ignore */ } }
    }
    setImmediate(() => {
      try {
        killFn(oldPid, "SIGTERM");
      } catch {
        // If self-signaling fails, KeepAlive won't respawn until the next
        // crash/login; the kick child has already been dispatched.
      }
    });
    return true;
  }

  // No loaded launchd gateway (true foreground / `gini run`, or a booted-out
  // plist): no launchd KeepAlive to respawn us, so keep the detached bash
  // helper that waits for our exit then stop+starts the instance itself. Its
  // `gini start` is launchd-aware, so a booted-out plist is bootstrapped back
  // up from disk there.
  const script = `
cd ${shellQuote(root)}
old_pid=${oldPid}
for i in {1..100}; do
  kill -0 "$old_pid" 2>/dev/null || break
  sleep 0.1
done
if kill -0 "$old_pid" 2>/dev/null; then
  bun run packages/runtime/src/cli.ts stop --instance ${shellQuote(instance)} || true
  for i in {1..100}; do
    kill -0 "$old_pid" 2>/dev/null || break
    sleep 0.1
  done
fi
bun run packages/runtime/src/cli.ts start --instance ${shellQuote(instance)}
`;

  const child = spawnFn("bash", ["-lc", script], {
    cwd: root,
    detached: true,
    stdio: ["ignore", outFd, errFd]
  });
  child.unref();

  setImmediate(() => {
    try {
      killFn(oldPid, "SIGTERM");
    } catch {
      // If self-signaling fails, the helper still tries to stop/start.
    }
  });
  return true;
}

export function formatInstallFailure(
  label: string,
  status: number | null,
  stdout?: string | Buffer | null,
  stderr?: string | Buffer | null
): string {
  const output = [toText(stdout), toText(stderr)].filter(Boolean).join("\n").trim();
  const base = `gini update: ${label} failed (exit ${status ?? "null"}).`;
  if (!output) return base;
  return `${base}\n\n----- ${label} output -----\n${truncateOutput(output)}`;
}

// Resolve the production dist dir to serve for the checkout at repoDir:
// packages/web/<prefix><sha12> with a BUILD_ID (next build's completion marker — a
// dir without one is an aborted build and must not be served). Returns the
// dir NAME (relative, the shape GINI_DIST_DIR wants) or null when no bundle
// matches the current HEAD — the caller falls back to `next dev`.
export function resolveWebProdDistDir(repoDir: string): string | null {
  const sha12 = git(repoDir, ["rev-parse", "--short=12", "HEAD"]);
  if (!sha12) return null;
  const distDir = `${WEB_PROD_DIST_PREFIX}${sha12}`;
  return existsSync(join(repoDir, "packages", "web", distDir, "BUILD_ID")) ? distDir : null;
}

// Test seam for buildWebProdBundle: tests inject an async runner recorder so
// no real `next build` runs. preserveDistDirs names extra prod bundle dirs
// (the <prefix><sha12> shape GINI_DIST_DIR uses) to keep through the GC —
// the update flow passes the previous HEAD's bundle here so it isn't pulled
// out from under a still-running server.
export interface BuildWebProdOptions {
  runStepImpl?: RunStepImpl;
  preserveDistDirs?: string[];
}

// next build type-checks the project with packages/web/tsconfig.base.json, whose
// `include` globs (".next-*/types/**/*.ts", ".next-*/dev/types/**/*.ts") pull
// generated route-type validators from EVERY dist dir, not just the one being
// built. A validator left behind by a past `next dev` run or an older build
// still imports the routes that existed then; once such a route is deleted
// from source, that stale validator fails the type-check and aborts `next
// build` — which aborts the whole self-update (buildWebProdBundle throws
// before any restart is scheduled), silently stranding the user on old code.
// These `types`/`dev/types` dirs are type-check-only generated artifacts (never
// loaded by `next start`), so we delete them across all dist dirs before
// building: this build regenerates the active dist's `types`, and `next dev`
// regenerates `dev/types` on demand. Served bundles' runtime files and each
// dist's build `cache/` are left intact.
function pruneStaleGeneratedRouteTypes(webDir: string): void {
  let entries: string[];
  try {
    entries = readdirSync(webDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!/^\.next(-.*)?$/.test(entry)) continue;
    for (const sub of ["types", join("dev", "types")]) {
      try {
        rmSync(join(webDir, entry, sub), { recursive: true, force: true });
      } catch {
        // Best-effort: a leftover types dir can only cause the very build
        // failure we're preventing, never a serving problem.
      }
    }
  }
}

// Build the production web bundle for sha12 into packages/web/<prefix><sha12>.
// Idempotent: a dir that already carries a BUILD_ID is kept as-is (re-update
// onto the same head). On success, the new dir AND any dirs named in
// preserveDistDirs (the previous HEAD's bundle, so a still-running server
// isn't pulled out from under it) are kept; every other <prefix><sha> dir is
// deleted — a strictly-older bundle can never be served again (the sha no
// longer matches) and each one holds a full Next build. The preserved
// previous bundle is reclaimed by a LATER update once it's two generations
// old. On build failure this throws so updateRuntime aborts before any
// restart is scheduled. GC is best-effort: a leftover dir wastes disk but is
// never served.
export async function buildWebProdBundle(
  runtimeDir: string,
  sha12: string,
  stdio: "inherit" | "pipe",
  options: BuildWebProdOptions = {}
): Promise<{ distDir: string; built: boolean }> {
  const runStepImpl = options.runStepImpl ?? runStep;
  const webDir = join(runtimeDir, "packages", "web");
  const distDir = `${WEB_PROD_DIST_PREFIX}${sha12}`;
  const alreadyBuilt = existsSync(join(webDir, distDir, "BUILD_ID"));
  if (!alreadyBuilt) {
    pruneStaleGeneratedRouteTypes(webDir);
    const env = { ...process.env, GINI_DIST_DIR: distDir };
    const result = await runStepImpl("bun", ["run", "build"], { cwd: webDir, env, stdio });
    if (result.status !== 0) {
      throw new Error(formatInstallFailure("bun run build in packages/web/", result.status, result.stdout, result.stderr));
    }
  }
  const preserve = new Set(options.preserveDistDirs ?? []);
  for (const entry of readdirSync(webDir)) {
    // GC only dirs shaped like OUR sha-keyed bundles (<prefix> + a hex sha
    // of >=12 chars, matching `git rev-parse --short=12`, which lengthens
    // on ambiguity). A bare prefix match would also delete the `next dev`
    // dist dir of an instance literally named e.g. `prod-foo`
    // (`.next-prod-foo`).
    if (entry === distDir || preserve.has(entry) || !PROD_DIST_GC_PATTERN.test(entry)) continue;
    try {
      rmSync(join(webDir, entry), { recursive: true, force: true });
    } catch {
      // GC is best-effort: a leftover dir wastes disk but can never be
      // served (its sha doesn't match), so it must not fail the update.
    }
  }
  return { distDir, built: !alreadyBuilt };
}

// Shape of a GC-able sha-keyed bundle dir name. Must agree with
// WEB_PROD_DIST_PREFIX; the trailing hex run is the short sha.
const PROD_DIST_GC_PATTERN = /^\.next-prod-[0-9a-f]{12,}$/;

async function runBunInstall(cwd: string, label: string, stdio: "inherit" | "pipe", runStepImpl: RunStepImpl): Promise<void> {
  const result = await runStepImpl("bun", ["install"], { cwd, stdio });
  if (result.status !== 0) {
    throw new Error(formatInstallFailure(label, result.status, result.stdout, result.stderr));
  }
}

function toText(value: string | Buffer | null | undefined): string {
  if (!value) return "";
  return typeof value === "string" ? value : value.toString("utf8");
}

function truncateOutput(value: string): string {
  if (value.length <= MAX_INSTALL_FAILURE_OUTPUT) return value;
  return `${value.slice(0, MAX_INSTALL_FAILURE_OUTPUT)}\n... output truncated ...`;
}

export function assertCurrentRuntimeUpdateSupported(runtimeDir = projectRoot()): void {
  const support = updateSupport(runtimeDir);
  if (!support.supported) {
    throw new Error(support.reason ?? "Runtime update is not available from this checkout.");
  }
}

function assertUpdateTarget(runtimeDir: string): void {
  if (!existsSync(runtimeDir) || !existsSync(join(runtimeDir, ".git"))) {
    throw new Error(
      "gini update operates on the installed runtime at ~/.gini/runtime, which is not present. " +
      "Reinstall with: curl -fsSL https://raw.githubusercontent.com/Open-Curiosity/gini-agent/main/scripts/install.sh | bash"
    );
  }
  const actualOrigin = requireGit(runtimeDir, ["remote", "get-url", "origin"], "could not read git origin");
  const normalize = (url: string): string => url.replace(/\.git$/, "");
  const isExpectedRemote = [EXPECTED_ORIGIN, ...LEGACY_ORIGINS].some(
    (o) => normalize(actualOrigin) === normalize(o)
  );
  const isLocalCheckout = actualOrigin.startsWith("/") && existsSync(join(actualOrigin, ".git"));
  if (!isExpectedRemote && !isLocalCheckout) {
    throw new Error(
      `gini update refuses to touch ~/.gini/runtime because its git origin is ${actualOrigin} ` +
      `(expected ${EXPECTED_ORIGIN} or a local repo path). Move that directory aside and reinstall.`
    );
  }
}

function updateSupport(runtimeDir: string): { supported: boolean; reason?: string } {
  if (!existsSync(join(installedRuntimeDir(), ".git"))) {
    return { supported: false, reason: "Installer-managed runtime is not present. Use git pull from this checkout." };
  }
  if (!sameRealPath(runtimeDir, installedRuntimeDir())) {
    // The installed runtime exists but THIS process runs from somewhere
    // else. For a development worktree that's the expected state (git pull
    // is the workflow), but it is also exactly what a wrongly-homed launchd
    // instance looks like — and telling that user "use git pull" points
    // them away from the fix. `gini update` both updates ~/.gini/runtime
    // and re-homes a launchd instance onto it, so name the running
    // directory and point there. The message must keep its
    // "Web update is only available" prefix — statusFromErrorMessage in
    // src/http.ts maps that prefix to a 400.
    return {
      supported: false,
      reason: `Web update is only available when the gateway runs from the installer-managed runtime (~/.gini/runtime); this gateway is running from ${runtimeDir}. ` +
        "Run `gini update` in a terminal to update the installed runtime and re-home a launchd-supervised instance onto it; a development checkout should use git pull instead."
    };
  }
  try {
    assertUpdateTarget(runtimeDir);
    return { supported: true };
  } catch (error) {
    return { supported: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

// Realpath-compare two directories (symlinked spellings of the installed
// runtime must read as the installed runtime). Returns false when either
// path can't be resolved — a home that no longer exists is by definition
// not the installed runtime. Also used by the `gini update` re-home check
// in src/cli/commands/admin.ts.
export function sameRealPath(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

function readPackageVersion(runtimeDir: string): string {
  try {
    const parsed = JSON.parse(readFileSync(join(runtimeDir, "package.json"), "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function requireGit(runtimeDir: string, args: string[], label: string): string {
  const value = git(runtimeDir, args);
  if (value) return value;
  throw new Error(`gini update ${label}.`);
}

function git(runtimeDir: string, args: string[]): string | null {
  if (!existsSync(join(runtimeDir, ".git"))) return null;
  const result = spawnSync("git", ["-C", runtimeDir, ...args], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const value = (result.stdout ?? "").trim();
  return value.length > 0 ? value : null;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// macOS LaunchAgent integration: write a per-instance plist set (gateway +
// web), register them with `launchctl bootstrap gui/<uid>`, and tear them
// down with `launchctl bootout`.
//
// What this exists for: after `gini install` runs, the user expects BOTH the
// runtime gateway AND the Next.js webapp to be running and to stay running
// across crashes and logins. On macOS the supported way to achieve that for
// a per-user, foreground-session service is a user-domain LaunchAgent under
// ~/Library/LaunchAgents/. System daemons (~/.../Library/LaunchDaemons/)
// can't reach the user's Keychain, which would break Codex auth.
//
// Three plists per instance:
//   - `<prefix>.<instance>.gateway`  — the Bun runtime (src/server.ts)
//   - `<prefix>.<instance>.web`      — Next.js dev server, gated on the
//                                      gateway's /api/healthz coming up
//   - `<prefix>.<instance>.watchdog` — long-lived health-probe loop that
//                                      revives a dead/hung gateway/web
//
// Scope notes:
//   - macOS only in v1. Linux systemd --user parity is a follow-up.
//   - KeepAlive only reacts to process exit, so the watchdog covers the gaps
//     it can't: a wedged-but-alive runtime (hits /api/status and
//     /api/runtime/__healthz, kickstarts whatever is hung) and a clean exit
//     that launchd defers respawning. See ADR always-up-supervision.md.
//   - KeepAlive is `true`: launchd always respawns the service on exit, so
//     the runtime stays up across crashes AND clean exits (an auto-update
//     self-SIGTERM respawns with the fresh code). Stopping is done out of
//     band: `gini stop` runs `launchctl bootout` to unload the service.
//
// Layering: the label/path/service-target derivation and the thin shellouts
// to `launchctl` live in src/integrations/launchd.ts so src/runtime/* can
// import them without depending on src/cli/*. This module re-exports them
// for back-compat with existing test imports.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Instance } from "../types";
import { defaultWebPort, projectRoot } from "../paths";
import {
  GINI_SUPERVISOR_VALUE,
  LABEL_PREFIX,
  LEGACY_LABEL_PREFIXES,
  THROTTLE_INTERVAL_SECONDS,
  labelFor,
  labelForKind,
  plistPathFor,
  serviceTarget,
  type PlistKind
} from "../integrations/launchd";
import { mergeShellPath, readLoginShellPath, type LoginShellReader } from "../runtime/path-bootstrap";
// Shared with the openclaw migrator and the CLI setup readback so all
// three call sites agree on how to decode the value half of a
// secrets.env line. parseSecretsEnv lives in src/state/secrets-env.ts
// (next to unquoteSecretsValue, which it uses, and the writer whose form
// it inverts); re-exported below so existing importers of it against
// src/cli/autostart keep resolving.
import { parseSecretsEnv } from "../state/secrets-env";
export { parseSecretsEnv } from "../state/secrets-env";

// Re-export the shared launchd primitives so existing imports against
// src/cli/autostart keep resolving (CLI commands, tests). New runtime
// code should import directly from src/integrations/launchd.ts to avoid
// pulling in this CLI-flavored surface.
export {
  GINI_SUPERVISOR_VALUE,
  LABEL_PREFIX,
  LEGACY_LABEL_PREFIXES,
  THROTTLE_INTERVAL_SECONDS,
  type PlistKind,
  type LegacyHandle,
  type LaunchctlResult,
  supervisor,
  legacyHandlesFor,
  labelFor,
  labelForKind,
  plistPathFor,
  guiDomain,
  serviceTarget,
  isLoaded,
  loadedPid,
  loadedLastExitStatus,
  isLaunchdManaged,
  type LaunchdManagedDeps,
  bootstrap,
  bootout,
  bootoutTarget,
  isLoadedTarget,
  kickstart,
  platformIsSupported,
  unsupportedPlatformMessage
} from "../integrations/launchd";

// Web shim wait budget. The shim polls the gateway port file and then
// /api/status before exec'ing `bun run dev`. WEB_SHIM_WAIT_ATTEMPTS * the
// per-attempt sleep of WEB_SHIM_WAIT_INTERVAL_SECONDS bounds the total
// time we'll wait for the gateway to come up. Default budget: 120 * 0.5s
// = 60s. The gateway typically lands in under 3s on warm caches.
//
// Contract with scripts/install.sh: install.sh polls
// ~/.gini/instances/<inst>/web.port (which the shim writes after
// finishing its own wait + exec'ing bun) for INSTALL_READ_WEB_PORT_TIMEOUT
// seconds. That budget MUST exceed the shim's total wait so install.sh
// doesn't give up before the shim has even started writing web.port. See
// scripts/install.sh:read_web_port for the matching value.
export const WEB_SHIM_WAIT_ATTEMPTS = 120;
export const WEB_SHIM_WAIT_INTERVAL_SECONDS = 0.5;

export interface LaunchSpec {
  // What launchd will exec. In installed-flow this is just the wrapper plus
  // run + --instance; in source-flow it's bun + entry script + run + flags.
  programArguments: string[];
  // Directory the runtime resolves project paths from. In installed-flow
  // that's ~/.gini/runtime (so `bun run` uses the right package.json);
  // in source-flow it's the repo root.
  workingDirectory: string;
  // PATH must include bun's dir so the wrapper can find it. We avoid bare
  // exec of a brittle absolute path so users who upgrade bun keep working.
  environment: Record<string, string>;
}

export interface LaunchSpecPair {
  gateway: LaunchSpec;
  web: LaunchSpec;
  // The health watchdog (a long-lived KeepAlive probe loop). Carries no
  // provider secrets — it only probes localhost health endpoints and shells
  // out to launchctl.
  watchdog: LaunchSpec;
  // Recorded for `status`/diagnostics: which working-directory path
  // resolution picked (installed vs source).
  resolution: "installed" | "source";
}

export interface ResolveLaunchOptions {
  instance: Instance;
  // Test seam: override the file-existence checks. Defaults wired to the
  // real filesystem in resolveLaunchSpec.
  fileExists?: (path: string) => boolean;
  // Test seam / production: provide the file body of ~/.gini/secrets.env
  // so we can merge OPENAI_API_KEY (and friends) into the plist's
  // EnvironmentVariables. Defaults to reading the file from disk.
  readSecretsFile?: () => string | null;
  // Test seam: pretend $HOME is somewhere else. Defaults to process.env.HOME
  // or os.homedir().
  homeOverride?: string;
  // Test seam: pretend a different bun is on PATH. Defaults to
  // process.execPath, which is correct under both `bun run` and a compiled
  // bun-driven entry.
  bunPathOverride?: string;
  // Test seam: pretend a different project root. Defaults to projectRoot().
  projectRootOverride?: string;
  // Test seam: pretend a different cwd when deciding source-vs-installed.
  // Defaults to process.cwd().
  cwdOverride?: string;
  // Opt-in scratch state/log root for E2E tests. When set, GINI_STATE_ROOT
  // (and GINI_LOG_ROOT) are embedded in the plist's EnvironmentVariables
  // so launchd-spawned runtime + web both point at the scratch dirs. In
  // production this is undefined and the plist gets a minimal env — no
  // leak of shell-level GINI_STATE_ROOT into a permanent launchd record.
  testRoot?: { stateRoot?: string; logRoot?: string };
  // Test seam: override the login-shell PATH lookup used to extend the
  // plist's PATH with the user's interactive PATH (nvm, asdf, volta, …).
  // Defaults to reading $SHELL via readLoginShellPath. Production callers
  // don't pass this.
  loginShellReader?: LoginShellReader;
  // Test seam: override $SHELL. Defaults to process.env.SHELL.
  loginShell?: string;
  // Opt-in: actually run the user's login shell to capture their PATH.
  // Defaults to false so non-write callers (status, disable, kick) don't
  // spend up to 3s spawning the user's shell just to compute metadata
  // they don't need. The enable / write paths pass true.
  mergeShellPath?: boolean;
  // Explicit home (plist WorkingDirectory) for the generated specs. Set by
  // `gini autostart enable --home <dir>` and by `gini update`'s re-home
  // onto the installed runtime. Must be a usable gini-agent checkout —
  // resolveLaunchSpecPair throws otherwise, because silently homing the
  // instance somewhere else instead would be exactly the bug the sticky
  // home exists to prevent. When omitted, an existing gateway plist's
  // WorkingDirectory is preserved (see resolveLaunchSpecPair).
  homeDir?: string;
  // Test seam: override how the existing gateway plist's WorkingDirectory
  // is read for the sticky-home preservation, mirroring the fileExists
  // seam so unit tests stay hermetic. Defaults to readPlistWorkingDirectory
  // against the on-disk plist.
  readPlistWorkingDirectory?: (plistPath: string) => string | null;
}

// Build the launchd command line. We exec the Bun-driven runtime *directly*
// — `bun run src/server.ts --instance <name>` — instead of going through the
// `~/.local/bin/gini` wrapper or `gini run`. The reason: single-process job.
// The wrapper/CLI path spawns a chain (bash → bun → bun → bun-server), so the
// launchd-tracked PID is the bash head, not the runtime. Direct exec
// collapses the tree to one process, so the launchd-tracked PID IS the
// runtime — `launchctl bootout` / `kickstart -k` target the right process,
// and KeepAlive respawns that single process reliably on any exit.
//
// WorkingDirectory resolution: a supervised instance's home is STICKY.
// Plists are regenerated from many different cwds — the startup reconcile,
// the provider-key refresh, `gini start`'s bootstrap of a not-loaded kind,
// `gini update`'s restart — so deciding the home from the invoking
// process's cwd would let any one of those silently MOVE the instance onto
// whatever checkout the caller happened to be in. Once that happens the
// instance executes that checkout's code on every respawn, and `gini
// update`'s work on ~/.gini/runtime never reaches it (worse, the startup
// reconcile then cements the wrong home: the running gateway's own project
// root IS the plist's WorkingDirectory). So an existing gateway plist's
// WorkingDirectory is preserved whenever it still points at a usable
// checkout; moving requires explicit intent — `--home <dir>` /
// enable({homeDir}) — and `gini update` re-homes a wrongly-homed instance
// onto the installed runtime. Only the FIRST enable (no plist yet), or a
// self-heal when the recorded home is gone (a deleted worktree), decides
// fresh: a gini-agent source checkout at cwd/projectRoot wins (a developer
// enabling from a worktree means that worktree), then `~/.gini/runtime`
// when usable, then the resolved project root.
export function resolveLaunchSpec(options: ResolveLaunchOptions): LaunchSpec {
  const pair = resolveLaunchSpecPair(options);
  return pair.gateway;
}

export function resolveLaunchSpecPair(options: ResolveLaunchOptions): LaunchSpecPair {
  const fileExists = options.fileExists ?? existsSync;
  const home = options.homeOverride ?? process.env.HOME ?? homedir();
  const bunPath = options.bunPathOverride ?? process.execPath;
  const repoRoot = options.projectRootOverride ?? projectRoot();
  const cwd = options.cwdOverride ?? process.cwd();
  const runtimeDir = join(home, ".gini", "runtime");

  const runtimeUsable = fileExists(join(runtimeDir, "package.json"))
    && fileExists(join(runtimeDir, "packages", "runtime", "src", "server.ts"));

  // Home resolution, in priority order (the home is STICKY — see the
  // comment block above resolveLaunchSpec):
  //
  //   1. An explicit homeDir (`--home` / a programmatic enable({homeDir}),
  //      how `gini update` converges a wrongly-homed instance onto the
  //      installed runtime). A bad value fails loudly instead of silently
  //      homing the instance somewhere the caller didn't ask for.
  //   2. The existing gateway plist's WorkingDirectory, when it still
  //      points at a usable checkout. Preserving it means regenerating a
  //      plist can never move the instance to a different checkout as a
  //      side effect of the invoking process's cwd — and because this
  //      lives HERE, the stamp's write side (generatePlist via enable) and
  //      check side (the startup reconcile via supervisedServices) agree
  //      by construction.
  //   3. First-enable defaults (no plist, or its recorded home is no
  //      longer usable — a deleted checkout self-heals through here): a
  //      source checkout at cwd/projectRoot wins, then the installed
  //      runtime, then the resolved project root.
  let workingDirectory: string;
  if (options.homeDir !== undefined) {
    if (!isUsableGiniCheckout(options.homeDir, fileExists)) {
      throw new Error(
        `autostart: homeDir '${options.homeDir}' is not a usable gini-agent checkout ` +
        `(needs a package.json with name "gini-agent" and packages/runtime/src/server.ts).`
      );
    }
    workingDirectory = options.homeDir;
  } else {
    // The gateway plist is the canonical record of the instance's home
    // (all three kinds share one WorkingDirectory). The path is derived
    // from the resolved `home` rather than plistPathFor() so
    // homeOverride-driven unit tests stay hermetic; in production `home`
    // IS $HOME, so the two derivations agree.
    const readWorkingDirectory = options.readPlistWorkingDirectory ?? readPlistWorkingDirectory;
    const gatewayPlist = join(home, "Library", "LaunchAgents", `${labelForKind(options.instance, "gateway")}.plist`);
    const preservedHome = readWorkingDirectory(gatewayPlist);
    if (preservedHome !== null && isUsableGiniCheckout(preservedHome, fileExists)) {
      workingDirectory = preservedHome;
    } else {
      // Source-flow detection: cwd is a gini-agent checkout (package.json
      // declares name "gini-agent"). We check both cwd and repoRoot because
      // someone could `bun run gini autostart enable` with cwd in a sub-dir
      // and projectRoot() would still be the repo root.
      const cwdIsSource = isGiniAgentCheckout(cwd, fileExists);
      const repoRootIsSource = isGiniAgentCheckout(repoRoot, fileExists);
      // Prefer source flow when invoked from a source checkout — that's the
      // developer's intent. Fall back to installed flow otherwise.
      const preferSource = cwdIsSource || repoRootIsSource;
      const useSource = preferSource || !runtimeUsable;
      workingDirectory = useSource ? (cwdIsSource ? cwd : repoRoot) : runtimeDir;
    }
  }
  // `resolution` stays a two-value union external consumers (install.sh)
  // read: "installed" iff the resolved home IS the installed runtime,
  // whichever branch above picked it.
  const resolution: "installed" | "source" = sameDir(workingDirectory, runtimeDir) ? "installed" : "source";

  // Always make bun's directory available on PATH so child invocations
  // (e.g. `bun install` triggers from inside the runtime) can resolve it.
  // macOS launchd hands the service a minimal PATH; we explicitly extend
  // it with two layers:
  //
  //   1. The hard-coded base — bun's dir, ~/.local/bin, and the standard
  //      macOS dirs. Guaranteed present regardless of the user's shell
  //      setup.
  //   2. The user's interactive-shell PATH read via `$SHELL -ilc 'echo
  //      $PATH'`. Picks up nvm / asdf / volta / pyenv / rbenv shims so
  //      the launchd-spawned gateway can see the same npm-globals
  //      (codex, claude, …) the user sees in their terminal.
  //
  // Best-effort: if the shell isn't set or the read fails, we fall back
  // to (1) alone. Bun's `spawnSync` snapshots PATH at process start, so
  // there's no useful runtime fix for this — the plist is the right
  // place to bake the PATH in.
  // SHELL is baked into the plist so launchd-spawned children (notably
  // the autostart-refresh path that runs `gini autostart enable
  // --kind gateway` after an OpenAI key change) start with $SHELL set
  // and can re-read the same shell PATH. Without this, refresh
  // regenerates the plist with the bare launchd PATH and silently
  // wipes the nvm/asdf merge we did at first enable. We only persist
  // it when the path resolves to an existing file on disk — a stale
  // or garbage $SHELL would otherwise survive in launchd's
  // EnvironmentVariables and confuse every future child process.
  const shellRaw = options.loginShell ?? process.env.SHELL ?? "";
  const shell = shellRaw && fileExists(shellRaw) ? shellRaw : "";
  const baseEnv: Record<string, string> = {
    PATH: buildLaunchAgentPath(bunPath, home, {
      loginShellReader: options.loginShellReader,
      loginShell: options.loginShell,
      mergeShellPath: options.mergeShellPath ?? false,
      home
    }),
    HOME: home,
    LANG: process.env.LANG ?? "en_US.UTF-8"
  };
  if (shell) baseEnv.SHELL = shell;
  // Opt-in: only propagate GINI_STATE_ROOT / GINI_LOG_ROOT into the plist
  // when an explicit testRoot is passed. Reading them from process.env
  // would bake whatever scratch path the developer's shell currently has
  // into the persistent plist — a footgun. Tests that need the override
  // pass testRoot explicitly.
  if (options.testRoot?.stateRoot) baseEnv.GINI_STATE_ROOT = options.testRoot.stateRoot;
  if (options.testRoot?.logRoot) baseEnv.GINI_LOG_ROOT = options.testRoot.logRoot;

  // Merge ~/.gini/secrets.env into the GATEWAY plist environment only.
  // The installed `gini` wrapper sources this file at the top of every
  // invocation, but the autostart plist execs `bun run src/server.ts`
  // directly (no shell sourcing) — so without this merge the launchd-
  // spawned runtime has no OPENAI_API_KEY in its env and the provider
  // throws. We read the file every time `autostart enable` is called,
  // so `gini provider set` → re-enable picks up new keys automatically.
  //
  // The WEB plist deliberately does NOT receive these secrets. The
  // Next.js BFF only proxies to the gateway over /api/*; it never
  // invokes a provider directly. Putting provider keys in the web
  // process's env would widen the secret-exposure surface for zero gain — any
  // future client-side compromise or accidental log statement in the
  // web layer could expose a key the BFF has no business holding.
  const secretsBody = options.readSecretsFile
    ? options.readSecretsFile()
    : readSecretsEnvFile(home);
  const secretsEnv = secretsBody ? parseSecretsEnv(secretsBody) : {};

  const gatewayEnv: Record<string, string> = {
    ...baseEnv,
    ...secretsEnv,
    GINI_INSTANCE: options.instance,
    // Marks the launchd-spawned runtime so supervisor() reports "launchd"
    // at runtime. Drives launchd-native stop/restart behavior (bootout as
    // stop, KeepAlive respawn after a self-SIGTERM on auto-update).
    GINI_SUPERVISOR: GINI_SUPERVISOR_VALUE
  };

  const gateway: LaunchSpec = {
    programArguments: [bunPath, "run", "packages/runtime/src/server.ts", "--instance", options.instance],
    workingDirectory,
    environment: gatewayEnv
  };

  // Web plist: same working directory (the repo or installed runtime),
  // but exec'd via an inline `sh -c` shim that polls /api/healthz on the
  // gateway port before starting Next.js. Without the gate, the web
  // process boots before the gateway, the BFF's first requests fail
  // (ECONNREFUSED), and the user sees a broken UI for the first ~5s
  // after every login. The shim's final `exec` (next start from the
  // sha-keyed prod bundle when one matches the checkout, next dev
  // otherwise — see buildWebShim) collapses the shell into Next.js so
  // the launchd-tracked PID is the server, not the wrapper.
  //
  // Web env intentionally omits secretsEnv (see comment above the
  // gateway env block) — the BFF doesn't talk to providers.
  const webEnv: Record<string, string> = {
    ...baseEnv,
    GINI_INSTANCE: options.instance,
    // Same launchd marker as the gateway (see gatewayEnv) so the web shim's
    // child also reports supervisor()==="launchd".
    GINI_SUPERVISOR: GINI_SUPERVISOR_VALUE,
    // The `bun run dev` invocation otherwise defaults to Next.js's 3000.
    // For instances other than `main`/`dev`, that would collide with
    // whatever else is using 3000. Pin to the per-instance default that
    // `gini start` would have picked.
    PORT: String(defaultWebPort(options.instance)),
    // Per-instance Next.js dist dir. `gini start` already sets
    // GINI_DIST_DIR=.next-<instance> in src/cli/process.ts so two
    // instances from the same checkout don't race each other's build
    // artifacts in `.next/`. The autostart web plist execs `bun run dev`
    // from the same web/ subdir, so it MUST mirror that env or two
    // autostarted instances (e.g. `dev` and `main`) corrupt each
    // other's compile caches. Same slug rule as process.ts: only
    // [A-Za-z0-9_-] in the dist-dir path; anything else gets replaced
    // with `_` because Next.js rejects non-relative paths. This is the
    // DEV-fallback dist dir: when the shim serves the sha-keyed production
    // bundle it exports GINI_DIST_DIR=.next-prod-<sha> over this value.
    GINI_DIST_DIR: `.next-${options.instance.replace(/[^a-zA-Z0-9_-]/g, "_")}`
  };
  // sh -c arg vector. We exec `bun run dev` from the web/ subdir, after
  // polling the gateway runtime port file or 127.0.0.1:<port>/api/status.
  // The port for the instance is recorded at <stateRoot>/instances/<inst>/runtime.port
  // (written by the gateway at startup). We can't easily compute the
  // default-by-instance hash from sh, so we read the file the gateway
  // writes; until it appears (cold boot), we fall back to the default
  // gateway port for instance 'main' and to a 30s timeout overall.
  const shim = buildWebShim(options.instance, bunPath);
  const web: LaunchSpec = {
    programArguments: ["/bin/sh", "-c", shim],
    workingDirectory,
    environment: webEnv
  };

  // Watchdog plist: a long-lived KeepAlive job (see generatePlist) that
  // runs `gini watchdog --instance <name>` — an in-process probe loop over
  // the gateway + web health endpoints that kickstarts whichever is
  // dead/hung. It needs
  // NO provider secrets (it only hits localhost health endpoints and shells
  // out to launchctl), so the env is the base PATH/HOME/LANG plus the
  // launchd marker and GINI_INSTANCE — same minimal surface as the web env
  // minus the Next.js knobs.
  const watchdogEnv: Record<string, string> = {
    ...baseEnv,
    GINI_INSTANCE: options.instance,
    GINI_SUPERVISOR: GINI_SUPERVISOR_VALUE
  };
  const watchdog: LaunchSpec = {
    programArguments: [bunPath, "run", "gini", "watchdog", "--instance", options.instance],
    workingDirectory,
    environment: watchdogEnv
  };

  return { gateway, web, watchdog, resolution };
}

// Per-instance descriptor for a supervised LaunchAgent service. Encodes
// everything that varies per kind (label, plist path, service target,
// spec, per-kind log filenames) so command implementations
// (enable/disable/status/kick) can iterate uniformly instead of
// scattering `kind === "gateway" ? … : …` ternaries.
//
// `resolution` is recorded on every descriptor (rather than once per
// instance) so callers that pass a single descriptor around still have
// the source-vs-installed answer in hand.
export interface SupervisedService {
  kind: PlistKind;
  label: string;
  plistPath: string;
  serviceTarget: string;
  spec: LaunchSpec;
  // Per-kind launchd stdio destinations. Different filenames per kind
  // keep autostart crash logs distinguishable from user-driven `gini run`
  // stdout tees.
  stdoutLogFilename: string;
  stderrLogFilename: string;
  // Reserved for a periodic one-shot kind: the interval (seconds) that drives
  // the plist's StartInterval. All three current kinds leave this undefined
  // (they are KeepAlive long-lived jobs) — the watchdog used to be a
  // StartInterval one-shot, but launchd's spawn deferral on macOS 26 gapped
  // its ticks in exactly the outage windows it exists to cover,
  // so it now runs its own probe loop in one long-lived process.
  startIntervalSeconds?: number;
  resolution: "installed" | "source";
}

export interface SupervisedServicesOptions extends ResolveLaunchOptions {
  // Narrow to a subset of kinds. Defaults to all three
  // ["gateway","web","watchdog"]. The `--kind` CLI flag and the setup-api
  // refresh path pass a one-element array so they don't touch the others.
  kinds?: PlistKind[];
}

// Returns the descriptors that drive every per-kind launchctl interaction.
// The order matches `kinds` (defaults to ["gateway","web","watchdog"]) so
// enable's rollback semantics ("kinds bootstrapped earlier in the loop")
// stay deterministic — watchdog is last so a watchdog failure never rolls
// back the gateway/web that are already up.
export function supervisedServices(options: SupervisedServicesOptions): SupervisedService[] {
  const kinds = options.kinds ?? (["gateway", "web", "watchdog"] satisfies PlistKind[]);
  const pair = resolveLaunchSpecPair(options);
  const specForKind: Record<PlistKind, LaunchSpec> = {
    gateway: pair.gateway,
    web: pair.web,
    watchdog: pair.watchdog
  };
  const stdoutForKind: Record<PlistKind, string> = {
    gateway: "runtime-stdout.log",
    web: "web.log",
    watchdog: "watchdog.log"
  };
  const stderrForKind: Record<PlistKind, string> = {
    gateway: "runtime-launchd.err.log",
    web: "web-launchd.err.log",
    watchdog: "watchdog-launchd.err.log"
  };
  return kinds.map((kind): SupervisedService => ({
    kind,
    label: labelForKind(options.instance, kind),
    plistPath: plistPathFor(options.instance, kind),
    serviceTarget: serviceTarget(options.instance, kind),
    spec: specForKind[kind],
    stdoutLogFilename: stdoutForKind[kind],
    stderrLogFilename: stderrForKind[kind],
    resolution: pair.resolution
  }));
}

// Read ~/.gini/secrets.env. Returns null when missing; never throws on
// read errors (a quarantined file would otherwise block `autostart enable`).
function readSecretsEnvFile(home: string): string | null {
  const path = join(home, ".gini", "secrets.env");
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function isGiniAgentCheckout(dir: string, fileExists: (path: string) => boolean): boolean {
  const pkg = join(dir, "package.json");
  if (!fileExists(pkg)) return false;
  try {
    const body = readFileSync(pkg, "utf8");
    const parsed = JSON.parse(body) as { name?: unknown };
    return typeof parsed.name === "string" && parsed.name === "gini-agent";
  } catch {
    return false;
  }
}

// A directory usable as a supervised instance's home: a gini-agent checkout
// (package.json name "gini-agent") that actually carries the runtime entry
// the gateway plist execs. Both the explicit homeDir validation and the
// preserved-home check in resolveLaunchSpecPair gate on this, so a home
// pointing at a deleted or gutted checkout is never written into a plist —
// launchd would spawn-fail it in a loop.
export function isUsableGiniCheckout(dir: string, fileExists: (path: string) => boolean = existsSync): boolean {
  return isGiniAgentCheckout(dir, fileExists)
    && fileExists(join(dir, "packages", "runtime", "src", "server.ts"));
}

// Realpath-compare two directories so a symlinked spelling of the installed
// runtime still reads as "installed". Falls back to string equality when
// either path can't be resolved (a not-yet-existing dir, synthetic test
// paths) — a missing dir can only equal the installed runtime textually.
function sameDir(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return left === right;
  }
}

// Build the sh -c body that gates the Next.js launch on the gateway becoming
// healthy. Polls the runtime port file (written by src/server.ts on boot)
// and then /api/status until it returns 200 OR a 60s budget elapses. We
// poll the port file rather than guessing the port from instance hashing
// because the runtime walks ports under contention. The final exec — `bun
// run start` from the sha-keyed production bundle when one matches the
// current checkout, `bun run dev` otherwise (see step 4 below) — replaces
// the shell with Next.js so launchd tracks the server's PID directly.
//
// HOME is set by launchd from EnvironmentVariables; we expand it inline so
// the script doesn't depend on a parent process env. The instance dir
// path matches `src/paths.ts` (instances/<inst>/runtime.port).
function buildWebShim(instance: Instance, bunPath: string): string {
  // Reject suspicious instance names defensively. CLI validation (and the
  // dir-name layout) already restricts instances to alphanumerics, dashes,
  // and underscores, but we'd rather fail at write time than emit a shim
  // that could be coerced. A hostile instance name that slips past CLI
  // validation here would land inside a shell-double-quoted path and could
  // break out via `$(...)` or `${...}`; we forbid those characters.
  if (!/^[A-Za-z0-9._-]+$/.test(instance)) {
    throw new Error(`autostart: refusing to embed instance name '${instance}' in launchd shim — name must match [A-Za-z0-9._-]+`);
  }
  // Same constraint applies to bunPath — it gets embedded in the shim and
  // exec'd. Reject paths with shell-meaningful characters so a malformed
  // override can't break out of the exec line.
  if (!/^[A-Za-z0-9._\/-]+$/.test(bunPath)) {
    throw new Error(`autostart: refusing to embed bunPath '${bunPath}' in launchd shim — path must match [A-Za-z0-9._/-]+`);
  }
  // GINI_STATE_ROOT is propagated into the env via the plist when --test-root
  // is passed; absent that, the runtime uses ~/.gini. We honor the same
  // logic here so the web shim talks to the same state dir as the gateway:
  // ${GINI_STATE_ROOT:-$HOME/.gini}.
  // WEB_SHIM_WAIT_ATTEMPTS * WEB_SHIM_WAIT_INTERVAL_SECONDS bounds total
  // wait (default 60s). The gateway typically lands in under 3s on warm
  // caches.
  return [
    // Propagate SIGTERM during the polling phase. Without this, launchctl
    // bootout while the shim is sleeping in the poll loop would interrupt
    // the sleep, walk to the next iteration, and only exit when the
    // overall loop completes. Trapping → exit 0 makes the shim exit
    // promptly when bootout (the stop mechanism) signals it, instead of
    // finishing the whole poll loop first.
    // Once `exec <bunPath> run dev` runs, the shell is gone and bun
    // handles SIGTERM directly. We exec the absolute bunPath (the
    // same one the gateway's programArguments uses) instead of bare
    // `bun` so the gateway and the web dev server always run under
    // the same Bun even if the launchd PATH starts with a different
    // bun (e.g. one provided by the user's interactive shell PATH).
    `trap 'exit 0' TERM INT`,
    `cd packages/web 2>/dev/null || true`,
    `state_root="\${GINI_STATE_ROOT:-$HOME/.gini}"`,
    `port_file="$state_root/instances/${instance}/runtime.port"`,
    `instance_root="$state_root/instances/${instance}"`,
    // 1) Wait for the gateway port file to appear and have a value.
    `port=""`,
    `for i in $(seq 1 ${WEB_SHIM_WAIT_ATTEMPTS}); do`,
    `  if [ -f "$port_file" ]; then`,
    `    port=$(cat "$port_file" 2>/dev/null | tr -d '[:space:]')`,
    `    if [ -n "$port" ]; then break; fi`,
    `  fi`,
    `  sleep ${WEB_SHIM_WAIT_INTERVAL_SECONDS}`,
    `done`,
    // 2) If we have a port, poll the gateway until it responds at all.
    // /api/status returns 401 without auth, but we don't need a 2xx —
    // any HTTP response means the runtime is up. -sS without -f keeps
    // curl from failing on the 401; -o /dev/null + --max-time 2 stops
    // a hung gateway from blocking the loop forever.
    `if [ -n "$port" ]; then`,
    `  for i in $(seq 1 ${WEB_SHIM_WAIT_ATTEMPTS}); do`,
    `    if curl -sS --max-time 2 -o /dev/null "http://127.0.0.1:$port/api/status" 2>/dev/null; then break; fi`,
    `    sleep ${WEB_SHIM_WAIT_INTERVAL_SECONDS}`,
    `  done`,
    `fi`,
    // 3) Record the *future* bun PID so `gini stop` can SIGTERM it.
    // We use $$ — the current shell's PID — which `exec` will reuse for
    // the bun process below (exec replaces the shell with bun, keeping
    // the same PID). Also record the web port so install.sh and other
    // clients can discover the actual listening port without re-hashing
    // the instance name (PORT is set by the plist EnvironmentVariables).
    `mkdir -p "$instance_root" 2>/dev/null || true`,
    `echo $$ > "$instance_root/web.pid"`,
    `if [ -n "$PORT" ]; then echo "$PORT" > "$instance_root/web.port"; fi`,
    // 4) Hand off to Next.js — production when a sha-keyed bundle exists,
    // dev otherwise. exec so launchd tracks the server PID either way.
    //
    // The update/install flows build web/.next-prod-<sha12> (<sha12> =
    // `git rev-parse --short=12 HEAD`); we serve `next start` from it iff
    // it matches the CURRENT checkout and carries a BUILD_ID (next build's
    // completion marker). The sha key pins a bundle to its commit — any
    // non-matching checkout (worktree, fresh clone, moved HEAD) falls back
    // to `next dev`, which always compiles the current source. The key sees
    // HEAD, not the working tree; the installed runtime is `reset --hard`
    // clean, so only there is the bundle guaranteed in sync with the source.
    // Mirrors webLaunchPlan in src/cli/process.ts; both paths must agree.
    //
    // SECURITY: `-H 127.0.0.1` is mandatory on BOTH branches — `next
    // start` and `next dev` alike default to binding 0.0.0.0, and the BFF
    // trusts a loopback Host for its owner-bearer injection (see the
    // binding comment in src/cli/process.ts), so an all-interfaces bind
    // would hand owner access to any LAN peer. The port comes from the
    // plist's PORT env, which both honor. GINI_DIST_DIR is exported on the
    // prod branch to override the plist's dev dist dir (`.next-<instance>`)
    // with the prod bundle.
    `sha=$(git rev-parse --short=12 HEAD 2>/dev/null || true)`,
    `if [ -n "$sha" ] && [ -f ".next-prod-$sha/BUILD_ID" ]; then`,
    `  export GINI_DIST_DIR=".next-prod-$sha"`,
    `  exec "${bunPath}" run start -- -H 127.0.0.1`,
    `fi`,
    `exec "${bunPath}" run dev -- -H 127.0.0.1`
  ].join("\n");
}

interface BuildPathOptions {
  loginShellReader?: LoginShellReader;
  loginShell?: string;
  // Opt-in: when true, spawn the user's login shell and merge its PATH
  // into the base. Default false because most call sites
  // (`resolveLaunchSpecPair` from status / disable / kick) only want
  // metadata and shouldn't pay the 100-500ms shell spawn or risk a
  // hung rc file. The enable path passes true.
  mergeShellPath?: boolean;
  home?: string;
}

function buildLaunchAgentPath(
  bunPath: string,
  home: string,
  options: BuildPathOptions = {}
): string {
  const bunDir = dirname(resolve(bunPath));
  // Standard macOS PATH plus bun's dir. ~/.local/bin is included so the
  // wrapper itself is findable.
  const segments = [
    bunDir,
    `${home}/.local/bin`,
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin"
  ];
  // Dedupe while preserving order.
  const seen = new Set<string>();
  const base = segments.filter((s) => {
    if (seen.has(s)) return false;
    seen.add(s);
    return true;
  }).join(":");

  // Merge in the user's interactive-shell PATH so version-manager dirs
  // (nvm, asdf, volta, …) make it into the plist. Three gates apply:
  //
  //   1. `mergeShellPath: true` must be set by the caller. The default
  //      is false so non-write call sites (status / disable / kick)
  //      don't spend 100-500ms spawning a shell to compute a PATH that
  //      gets thrown away.
  //   2. Skipped under bun:test (and NODE_ENV=test) unless an explicit
  //      loginShellReader is provided. The existing autostart suite
  //      asserts on the PATH; live shell reads would make assertions
  //      flaky across developer machines.
  //   3. Missing $SHELL or a failing read leaves the base PATH alone.
  // mergeShellPath is the single gate. Tests must opt in with
  // mergeShellPath: true AND pass a loginShellReader; a reader alone
  // does not override the default-off behavior, so test cases that
  // verify "no shell read happened" can pass a counting reader and
  // assert it was never called.
  if (options.mergeShellPath !== true) return base;
  const explicitReader = options.loginShellReader !== undefined;
  if (!explicitReader && isTestEnv()) return base;
  const shell = options.loginShell ?? process.env.SHELL;
  if (!shell) return base;
  const read = options.loginShellReader ?? readLoginShellPath;
  let shellPath: string | null;
  try {
    shellPath = read(shell, { home });
  } catch {
    shellPath = null;
  }
  if (!shellPath) return base;
  // pinFirst: 1 keeps bunDir at the head of PATH even when the user's
  // shell provides a different bun. Without this, a shell-provided bun
  // could shadow the launchd-baked bunDir and the web shim's
  // `exec <bunPath> run dev` would still execute the right bun (we
  // pass the absolute bunPath) but any other PATH-relative `bun` would
  // not. Treating the first base entry (bunDir) as fixed avoids that
  // class of surprise.
  return mergeShellPath(base, shellPath, { pinFirst: 1 }).merged;
}

function isTestEnv(): boolean {
  return (
    process.env.NODE_ENV === "test"
    || process.env.BUN_TEST === "1"
    || process.env.BUN_TEST === "true"
  );
}

// The env key under which each generated plist carries its own
// supervision-template fingerprint. The startup reconcile reads this back
// off disk and compares it to the stamp the current code would generate;
// drift means the installed plist predates a supervision-template change
// (e.g. a new env marker, a KeepAlive shape switch, a bun-path move) and
// must be rewritten + reloaded. See ADR always-up-supervision.md.
export const GINI_PLIST_STAMP_KEY = "GINI_PLIST_STAMP";

// The ONLY env keys folded into the stamp. Deliberately excludes PATH,
// HOME, LANG, SHELL, GINI_STATE_ROOT/GINI_LOG_ROOT, and every secret value
// from secrets.env — those vary legitimately between machines and between
// the merge/no-merge code paths, so hashing them would make the stamp
// non-deterministic and trigger a false-positive reconcile loop. We hash
// only the supervision-critical keys, whose VALUES are fixed by the
// template (the marker, the instance, the web/watchdog port, the dist dir).
const STAMP_ENV_KEYS = ["GINI_SUPERVISOR", "GINI_INSTANCE", "PORT", "GINI_DIST_DIR"] as const;

// The stable supervision-critical subset of a plist, in a FIXED key order.
// Hashing this (and nothing else) yields a stamp that changes iff the
// supervision template changes. Built identically at plist-generation time
// (generatePlist) and at startup-check time (the reconcile module), so the
// two sides always agree without spawning the login shell or reading secrets.
export interface PlistStampInput {
  kind: PlistKind | "legacy";
  label: string;
  programArguments: string[];
  workingDirectory: string;
  processType: string;
  // The scheduling shape. A periodic kind would carry startIntervalSeconds
  // and keepAlive=false; the long-lived kinds (gateway/web/watchdog — all
  // three today) carry keepAlive=true and a throttleIntervalSeconds. We
  // record both numbers explicitly so a change to either interval re-stamps.
  keepAlive: boolean;
  throttleIntervalSeconds: number | null;
  startIntervalSeconds: number | null;
  runAtLoad: boolean;
  // Only the supervision env keys (STAMP_ENV_KEYS), filtered + ordered.
  supervisionEnv: Record<string, string>;
}

// Extract the stamp input from a resolved LaunchSpec. Pulls out only the
// enumerated stable fields; everything variable (PATH, secrets, HOME, log
// paths) is dropped. Used by both generatePlist and the reconcile check so
// they hash the same bytes.
export function plistStampInput(args: {
  kind: PlistKind | "legacy";
  label: string;
  spec: LaunchSpec;
  processType: string;
  throttleIntervalSeconds: number | null;
  startIntervalSeconds: number | null;
}): PlistStampInput {
  const periodic = args.startIntervalSeconds !== null;
  const supervisionEnv: Record<string, string> = {};
  for (const key of STAMP_ENV_KEYS) {
    const value = args.spec.environment[key];
    if (value !== undefined) supervisionEnv[key] = value;
  }
  return {
    kind: args.kind,
    label: args.label,
    programArguments: [...args.spec.programArguments],
    workingDirectory: args.spec.workingDirectory,
    processType: args.processType,
    keepAlive: !periodic,
    throttleIntervalSeconds: periodic ? null : args.throttleIntervalSeconds,
    startIntervalSeconds: periodic ? args.startIntervalSeconds : null,
    runAtLoad: true,
    supervisionEnv
  };
}

// Hash the stable supervision subset into a short hex fingerprint. The input
// is serialized in a fixed field order (and supervisionEnv keys are emitted in
// STAMP_ENV_KEYS order) so the same template always hashes to the same value.
export function computePlistStamp(input: PlistStampInput): string {
  const orderedEnv = STAMP_ENV_KEYS
    .filter((key) => input.supervisionEnv[key] !== undefined)
    .map((key) => [key, input.supervisionEnv[key]!] as const);
  const canonical = JSON.stringify([
    input.kind,
    input.label,
    input.programArguments,
    input.workingDirectory,
    input.processType,
    input.keepAlive,
    input.throttleIntervalSeconds,
    input.startIntervalSeconds,
    input.runAtLoad,
    orderedEnv
  ]);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}

// Parse the GINI_PLIST_STAMP value out of an on-disk plist. The plist is
// written by generatePlist as a <key>GINI_PLIST_STAMP</key> immediately
// followed by its <string>VALUE</string> inside EnvironmentVariables, so we
// match that pair directly. Returns null when the file is missing, unreadable,
// or carries no stamp (a pre-stamp plist — which the reconcile treats as drift).
export function readPlistStamp(plistPath: string): string | null {
  if (!existsSync(plistPath)) return null;
  let body: string;
  try {
    body = readFileSync(plistPath, "utf8");
  } catch {
    return null;
  }
  const match = body.match(
    /<key>GINI_PLIST_STAMP<\/key>\s*<string>([^<]*)<\/string>/
  );
  return match && match[1] !== undefined ? match[1] : null;
}

// Parse the WorkingDirectory out of an on-disk plist — the record of a
// supervised instance's home that resolveLaunchSpecPair preserves across
// plist regenerations (and that `gini update` compares against the
// installed runtime). Written by generatePlist as <key>WorkingDirectory</key>
// immediately followed by its <string>VALUE</string>, so we match that pair
// directly (same shape as readPlistStamp above). Unlike the stamp (hex), the
// value is a path that escapeXml may have entity-encoded at write time, so
// it is unescaped on the way out to round-trip. Returns null when the file
// is missing, unreadable, or carries no WorkingDirectory.
export function readPlistWorkingDirectory(plistPath: string): string | null {
  if (!existsSync(plistPath)) return null;
  let body: string;
  try {
    body = readFileSync(plistPath, "utf8");
  } catch {
    return null;
  }
  const match = body.match(
    /<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/
  );
  if (!match || match[1] === undefined || match[1] === "") return null;
  return unescapeXml(match[1]);
}

export interface PlistOptions {
  instance: Instance;
  spec: LaunchSpec;
  // Which member of the (gateway, web) pair this plist is. Defaults to
  // omitted, which preserves the legacy single-plist label
  // `ai.lilac.gini.<instance>` — kept for compatibility with tests that
  // assert the historical shape. New code should always pass a kind.
  kind?: PlistKind;
  // Where stdout/stderr go. Defaults are derived from the project's per-
  // instance log dir (runtime-stdout.log), matching what `gini start` writes.
  stdoutPath: string;
  stderrPath: string;
  // ThrottleInterval bounds how aggressively launchd respawns a crashing
  // service. 10s keeps a crashloop from melting CPU without making clean-stop
  // recovery painfully slow.
  throttleIntervalSeconds?: number;
  // When set, emit a periodic one-shot plist instead of a long-lived one:
  // `StartInterval` (launchd relaunches every N seconds) + `RunAtLoad`, and
  // NO `KeepAlive`. No current kind uses this; when omitted, the plist is a
  // KeepAlive long-lived job (all three kinds today).
  startIntervalSeconds?: number;
}

// ProcessType baked into every plist. Folded into the stamp so a future
// change to this value re-stamps existing installs on next startup.
const PLIST_PROCESS_TYPE = "Interactive";

// The single source of truth for a generated plist's stamp. Both
// generatePlist (write side) and the startup reconcile (check side) call
// this so they hash byte-identical input. Mirrors generatePlist's
// throttle-default and periodic-vs-long-lived resolution exactly.
export function stampForGeneratedPlist(args: {
  instance: Instance;
  kind?: PlistKind;
  spec: LaunchSpec;
  throttleIntervalSeconds?: number;
  startIntervalSeconds?: number;
}): string {
  const throttle = args.throttleIntervalSeconds ?? THROTTLE_INTERVAL_SECONDS;
  const periodic = args.startIntervalSeconds !== undefined;
  const label = args.kind ? labelForKind(args.instance, args.kind) : labelFor(args.instance);
  return computePlistStamp(
    plistStampInput({
      kind: args.kind ?? "legacy",
      label,
      spec: args.spec,
      processType: PLIST_PROCESS_TYPE,
      throttleIntervalSeconds: periodic ? null : throttle,
      startIntervalSeconds: periodic ? args.startIntervalSeconds! : null
    })
  );
}

export function generatePlist(options: PlistOptions): string {
  const throttle = options.throttleIntervalSeconds ?? THROTTLE_INTERVAL_SECONDS;
  const periodic = options.startIntervalSeconds !== undefined;
  const label = options.kind ? labelForKind(options.instance, options.kind) : labelFor(options.instance);
  const args = options.spec.programArguments.map(escapeXml).map((a) => `        <string>${a}</string>`).join("\n");
  // Stamp the plist with a fingerprint of its own supervision-critical subset
  // (computed from the SAME extraction the startup reconcile uses). Inject it
  // into EnvironmentVariables so it persists in the on-disk plist; the stamp
  // value itself is never part of what we hash.
  const stamp = stampForGeneratedPlist({
    instance: options.instance,
    kind: options.kind,
    spec: options.spec,
    throttleIntervalSeconds: options.throttleIntervalSeconds,
    startIntervalSeconds: options.startIntervalSeconds
  });
  const stampedEnvironment: Record<string, string> = {
    ...options.spec.environment,
    [GINI_PLIST_STAMP_KEY]: stamp
  };
  const envEntries = Object.entries(stampedEnvironment)
    .map(([key, value]) => `        <key>${escapeXml(key)}</key>\n        <string>${escapeXml(value)}</string>`)
    .join("\n");

  // KeepAlive contract:
  //   - KeepAlive is a plain <true/>: launchd ALWAYS respawns the service
  //     when it exits, regardless of exit code. The runtime must be "always
  //     up", so a clean exit (e.g. an auto-update self-SIGTERM) is treated
  //     as "respawn with the fresh code", not "the user is done".
  //   - Stopping is therefore an out-of-band action: `gini stop` runs
  //     `launchctl bootout` to unload the service so KeepAlive no longer
  //     applies. We never rely on a clean exit to keep the service down.
  //   - ThrottleInterval:10 caps crashloop CPU — KeepAlive:true means a
  //     crash loop would otherwise respawn as fast as the process dies.
  //   - RunAtLoad:true means it starts at user login.
  //
  // NetworkState was considered (would gate first-boot launches until the
  // network came up) but launchd treats NetworkState as a *pended-spawn
  // semaphore*: even after a non-zero exit, the next spawn waits for a
  // network-state transition, which doesn't fire when the network was
  // already up. Empirically that prevents respawn-after-SIGKILL entirely.
  // The runtime tolerates a network-not-yet-up startup (provider auth
  // retries with backoff), so dropping NetworkState gets us reliable
  // crash respawn.
  //
  // Scheduling block differs by job shape:
  //   - Long-lived (gateway/web/watchdog): KeepAlive:true + ThrottleInterval.
  //     launchd always respawns on exit; bootout is the stop. The watchdog is
  //     long-lived too — its probe cadence is an in-process loop, NOT launchd
  //     StartInterval respawns, because launchd's spawn deferral (macOS 26)
  //     gapped StartInterval ticks during the very gateway outages the
  //     watchdog exists to cover.
  //   - Periodic (startIntervalSeconds set): StartInterval + RunAtLoad and NO
  //     KeepAlive — for a short-lived job that exits after each run, where
  //     KeepAlive would respawn it in a tight loop. No current kind uses this
  //     shape; the machinery stays for future periodic jobs.
  const scheduling = periodic
    ? `    <key>RunAtLoad</key>
    <true/>
    <key>StartInterval</key>
    <integer>${options.startIntervalSeconds}</integer>`
    : `    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>${throttle}</integer>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${escapeXml(label)}</string>
    <key>ProgramArguments</key>
    <array>
${args}
    </array>
    <key>WorkingDirectory</key>
    <string>${escapeXml(options.spec.workingDirectory)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${envEntries}
    </dict>
${scheduling}
    <key>StandardOutPath</key>
    <string>${escapeXml(options.stdoutPath)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(options.stderrPath)}</string>
    <key>ProcessType</key>
    <string>${escapeXml(PLIST_PROCESS_TYPE)}</string>
</dict>
</plist>
`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Inverse of escapeXml for values read back out of a generated plist
// (readPlistWorkingDirectory). &amp; is decoded LAST — escapeXml encoded it
// first, so decoding it earlier would double-decode e.g. "&amp;lt;".
function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export interface WritePlistOptions {
  instance: Instance;
  spec: LaunchSpec;
  kind?: PlistKind;
  stdoutPath: string;
  stderrPath: string;
  throttleIntervalSeconds?: number;
  // Forwarded to generatePlist: when set, writes a periodic (StartInterval,
  // no KeepAlive) plist instead of a long-lived one. No current kind sets it.
  startIntervalSeconds?: number;
}

export function writePlist(options: WritePlistOptions): string {
  const path = plistPathFor(options.instance, options.kind);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, generatePlist(options));
  return path;
}

export const __testing = {
  buildLaunchAgentPath,
  escapeXml,
  buildWebShim,
  isGiniAgentCheckout
};

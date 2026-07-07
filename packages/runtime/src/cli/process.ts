// Lifecycle helpers: start/stop the runtime + Next.js web, doctor, status.
//
// These were previously inline in src/cli.ts. They depend on a few runtime
// flags (the resolved web port and whether the user pinned a port or
// suppressed the web launch). Those flags are passed via WebOptions rather
// than read from module scope, which keeps each helper testable in
// isolation.

import { createWriteStream, existsSync, openSync, readFileSync, rmSync, writeFileSync, type WriteStream } from "node:fs";
import { createServer } from "node:net";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import type { RuntimeConfig } from "../types";
import { install, status } from "../runtime";
import { providerHealth } from "../provider";
import { readState } from "../state";
import { probeMemoryDb } from "../state/memory-db";
import { legacyMigrationStatus } from "../memory";
import { embeddingStatus, listBanksWithModelMismatch } from "../memory/embedding";
import { rerankerStatus } from "../memory/reranker";
import { defaultRuntimePort, defaultWebPort, ensureDir, logDir, pidPath, projectRoot, runtimePortPath, webPortPath } from "../paths";
import { resolveWebProdDistDir } from "../runtime/update";
import { api, auth, url } from "./api";

export interface WebOptions {
  webPort: number;
  webPortPinned: boolean;
  noWeb: boolean;
  // True when the runtime port came from --port or GINI_PORT. Pinned ports
  // strict-fail on collision (the user asked for that exact port; silently
  // walking would surprise them). Unpinned uses the instance default and walks.
  runtimePortPinned?: boolean;
  // Foreground mode: don't detach/unref children, inherit their stdio so the
  // user sees logs live. Caller (gini run) attaches signal handlers and is
  // responsible for tearing the children down. start()/startWeb() return the
  // child handles in this mode so the caller can wait on / signal them.
  foreground?: boolean;
}

export interface ForegroundChildren {
  runtime: ChildProcess | null;
  web: ChildProcess | null;
}

// Capture stdout/stderr from a spawned child to <logPath>, tee'ing also to the
// caller's terminal in foreground mode. Daemon mode opens the file once and
// hands the FD to spawn() as stdio so writes survive the parent unref. We keep
// the helpers separate because the call sites have different setup (FD-based
// stdio must be configured BEFORE spawn; pipes are wired up AFTER spawn).
//
// Returns { stdio, onSpawned } so callers can drop the result straight into
// their spawn options object and run a one-line post-spawn hook for foreground
// pipe wiring (no-op in daemon mode).
interface ChildLogPlumbing {
  stdio: ["ignore" | "inherit", number | "pipe", number | "pipe"];
  onSpawned: (child: ChildProcess) => void;
}

// Foreground tee streams registered by setupChildLog so the run command can
// await their `'finish'` event before `process.exit` — otherwise tail bytes
// from a crashing child's stderr burst can be lost on signal-driven exits.
const foregroundLogStreams: Set<WriteStream> = new Set();

export async function awaitForegroundLogFlush(): Promise<void> {
  // `'finish'` fires after `.end()` has flushed all queued writes. Streams that
  // are already finished are skipped so we don't hang waiting for an event
  // that's never coming. Per-stream errors (ENOSPC/EACCES/NFS hiccups) are
  // swallowed: a logging failure must never override the child's exit code.
  await Promise.all(
    [...foregroundLogStreams].map((stream) =>
      stream.writableFinished
        ? Promise.resolve()
        : once(stream, "finish").then(() => undefined).catch(() => undefined)
    )
  );
}

export function setupChildLog(instance: string, fileName: string, foreground: boolean): ChildLogPlumbing {
  const dir = logDir(instance);
  ensureDir(dir);
  const logPath = join(dir, fileName);
  if (foreground) {
    // Foreground: open a write stream and tee child.stdout/stderr to both the
    // user's terminal and the log file. Stream is closed when the child's stdio
    // fully drains (`close` event) so the tail is flushed and we don't leak FDs
    // across instance restarts. We register on the module-level Set so the run
    // command can await `'finish'` before process.exit (see awaitForegroundLogFlush).
    const stream: WriteStream = createWriteStream(logPath, { flags: "a" });
    foregroundLogStreams.add(stream);
    stream.once("finish", () => { foregroundLogStreams.delete(stream); });
    // Without an `'error'` listener the stream stays registered after a
    // failure (ENOSPC/EACCES/NFS), so a later `awaitForegroundLogFlush()`
    // would hang waiting for a `'finish'` that never fires. Cleaning up here
    // also prevents an unhandled-error abort.
    stream.once("error", () => { foregroundLogStreams.delete(stream); });
    return {
      stdio: ["inherit", "pipe", "pipe"],
      onSpawned: (child) => {
        child.stdout?.on("data", (chunk: Buffer | string) => {
          process.stdout.write(chunk);
          stream.write(chunk);
        });
        child.stderr?.on("data", (chunk: Buffer | string) => {
          process.stderr.write(chunk);
          stream.write(chunk);
        });
        const close = () => {
          try { stream.end(); } catch { /* ignore */ }
        };
        // `close` (not `exit`) fires after stdio has fully drained. Using `exit`
        // here let late `data` events arrive after the stream had been ended,
        // which truncates the tail.
        child.once("close", close);
        child.once("error", close);
      }
    };
  }
  // Daemon: hand the FD directly to the child so writes go straight to the
  // file from the kernel's perspective. This survives `child.unref()` and the
  // parent CLI exiting (a JS-level pipe would not — the parent owns the pipe
  // and an active `'data'` listener keeps the parent's event loop alive,
  // breaking the daemon-exit contract).
  const fd = openSync(logPath, "a");
  return {
    stdio: ["ignore", fd, fd],
    onSpawned: () => { /* nothing to wire; FDs go to the kernel */ }
  };
}

function readRecordedPort(path: string): number | null {
  if (!existsSync(path)) return null;
  const value = Number(readFileSync(path, "utf8").trim());
  return Number.isFinite(value) && value > 0 ? value : null;
}

// Read the recorded port from the on-disk file by instance NAME, without
// materializing a RuntimeConfig. The config-based readers below delegate
// here; callers that only have the instance name (e.g. `autostart enable`,
// which deliberately never loads config) use these directly.
export function recordedRuntimePortForInstance(instance: string): number | null {
  return readRecordedPort(runtimePortPath(instance));
}

export function recordedWebPortForInstance(instance: string): number | null {
  return readRecordedPort(webPortPath(instance));
}

export function recordedRuntimePort(config: RuntimeConfig): number | null {
  return recordedRuntimePortForInstance(config.instance);
}

export function recordedWebPort(config: RuntimeConfig): number | null {
  return recordedWebPortForInstance(config.instance);
}

export async function start(config: RuntimeConfig, options: WebOptions): Promise<{ runtimeStarted: boolean; banner: Record<string, unknown>; children: ForegroundChildren }> {
  const foreground = options.foreground === true;
  const children: ForegroundChildren = { runtime: null, web: null };
  const alreadyRunning = await isRunning(config);
  let runtimeStarted = false;
  if (!alreadyRunning) {
    await install(config);
    const requestedRuntimePort = config.port;
    // When the user pinned a port (--port / GINI_PORT) we trust the choice
    // and skip the probe-and-walk: probing is only useful for the unpinned
    // default, where we want to roll forward to the next free port. A
    // pinned port that's actually busy will surface a clean EADDRINUSE
    // from the real bind below, which is a more accurate failure than
    // synthesizing one from net.createServer probes. Skipping the probe
    // also dodges a class of CI failures where canListen() returns false
    // for every port in the search window even on an idle host.
    const claimedPort = options.runtimePortPinned
      ? requestedRuntimePort
      : await availablePort(requestedRuntimePort);
    config.port = claimedPort;
    await install(config);
    writeFileSync(runtimePortPath(config.instance), String(config.port));
    // Foreground mode keeps the child attached to the CLI: no detached process
    // group, and stdio is tee'd to both the user's terminal and runtime-stdout.log.
    // Daemon mode (gini start) preserves detach + unref but hands a log-file FD
    // to the child so its stdio survives parent exit (kept separate from the
    // structured runtime.jsonl event stream).
    const runtimeLog = setupChildLog(config.instance, "runtime-stdout.log", foreground);
    // Absolute server path: the CLI can be invoked from any cwd (worktree
    // root, a subdir, the installed wrapper), so don't make bun resolve the
    // entry relative to process.cwd().
    const child = spawn(process.execPath, ["run", join(projectRoot(), "packages", "runtime", "src", "server.ts"), "--instance", config.instance], {
      cwd: process.cwd(),
      detached: !foreground,
      stdio: runtimeLog.stdio,
      env: { ...process.env, GINI_INSTANCE: config.instance, GINI_PORT: String(config.port) }
    });
    runtimeLog.onSpawned(child);
    if (!foreground) child.unref();
    if (foreground) children.runtime = child;
    let healthy = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (await isRunning(config)) { healthy = true; break; }
      await Bun.sleep(100);
    }
    if (!healthy) {
      // Reap the child we just spawned before surfacing the error. The
      // caller never receives the handle on this path (we throw before
      // returning `children`), so nothing downstream can kill it — without
      // this, a slow-booting runtime outlives the CLI as an orphan bun
      // process that binds the port and runs its scheduler loops forever
      // (issue #289's orphan shape). SIGKILL is deliberate: the runtime
      // never served /api/status, so it has no state worth a graceful
      // drain, and the CLI is about to exit and cannot wait for one.
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      throw new Error("Runtime did not become healthy within 5 seconds.");
    }
    runtimeStarted = true;
  } else {
    // Even if the runtime was already up, refresh the recorded port so
    // status/stop/doctor read the live value.
    const recorded = recordedRuntimePort(config);
    if (recorded !== config.port) {
      writeFileSync(runtimePortPath(config.instance), String(config.port));
    }
  }
  // Web launch runs whether or not the runtime was already up — a user whose
  // web crashed should be able to recover with `gini start` without first stopping.
  let webUrlValue: string | null = null;
  if (!options.noWeb) {
    const existing = await existingWebUrl(config, options.webPort);
    if (existing) {
      webUrlValue = existing;
    } else {
      try {
        const result = await startWeb(config, options);
        webUrlValue = result.webUrl;
        if (foreground) children.web = result.child ?? null;
      } catch (error) {
        return {
          runtimeStarted,
          banner: {
            started: runtimeStarted,
            running: alreadyRunning,
            url: url(config),
            instance: config.instance,
            webError: error instanceof Error ? error.message : String(error)
          },
          children
        };
      }
    }
  }
  const banner: Record<string, unknown> = runtimeStarted
    ? { started: true, url: url(config), instance: config.instance }
    : { running: true, url: url(config), instance: config.instance };
  // Advertise the GATEWAY origin as the operator's Web link, not the inner
  // Next port: the gateway is the single front that serves the UI for every
  // front. The inner port is kept only for liveness detection (webUrlValue).
  if (webUrlValue) banner.webUrl = operatorWebUrl(config);
  if (foreground) banner.foreground = true;
  return { runtimeStarted, banner, children };
}

// The web URL shown to the operator: the GATEWAY origin (it reverse-proxies the
// UI), not the inner Next port. localhost is
// friendlier than 127.0.0.1 and resolves to the loopback the gateway binds.
export function operatorWebUrl(config: RuntimeConfig): string {
  return `http://localhost:${config.port}`;
}

/**
 * Returns the live web URL if the recorded pid is both alive AND serving
 * Next.js (via /api/runtime/__healthz). Cleans up stale pidfiles when the
 * process is gone or hung. Returns null when nothing usable is running.
 *
 * Probe order:
 *   1. The persisted `web.port` recorded at startup (always correct when present).
 *   2. The caller-supplied `webPort` and the next 9 candidates (covers the
 *      case where the port file is missing — e.g. pre-upgrade install — but
 *      the user is likely on the default or an explicit --web-port).
 */
export async function existingWebUrl(config: RuntimeConfig, webPort: number): Promise<string | null> {
  const path = join(config.stateRoot, "web.pid");
  if (!existsSync(path)) return null;
  const pid = Number(readFileSync(path, "utf8"));
  if (!processAlive(pid)) {
    rmSync(path, { force: true });
    rmSync(webPortPath(config.instance), { force: true });
    return null;
  }
  const recorded = recordedWebPort(config);
  const candidates: number[] = [];
  if (recorded !== null) candidates.push(recorded);
  for (let candidate = webPort; candidate < webPort + 10; candidate += 1) {
    if (!candidates.includes(candidate)) candidates.push(candidate);
  }
  for (const candidate of candidates) {
    const candidateUrl = `http://127.0.0.1:${candidate}`;
    try {
      const response = await fetch(`${candidateUrl}/api/runtime/__healthz`, { redirect: "manual" });
      if (!response.ok) continue;
      const body = (await response.json().catch(() => null)) as { ok?: boolean; service?: string; instance?: string } | null;
      // Instance match is required: the healthz route returns the instance the web
      // process was spawned for. Without this check, a different instance's web
      // (or a stray Gini web from a previous session) is treated as healthy
      // for THIS instance — which leads to "running" banners that point at the
      // wrong runtime.
      if (body && body.ok === true && body.service === "gini-web" && body.instance === config.instance) {
        // Probe over IPv4 (127.0.0.1) but advertise the localhost form to the
        // user. Next.js dev's `allowedDevOrigins` defaults to `localhost`, so
        // opening the IPv4 URL would block HMR/chunk fetches and break
        // hydration. See web/next.config.ts.
        return `http://localhost:${candidate}`;
      }
    } catch { /* try next port */ }
  }
  // Pid is alive but nothing healthy on the expected ports — treat as stale.
  rmSync(path, { force: true });
  rmSync(webPortPath(config.instance), { force: true });
  return null;
}

// The bun command + GINI_DIST_DIR pair startWeb spawns the inner Next server
// with. Prod (a current-sha bundle exists): `next start` from that bundle.
// Dev (no bundle): `next dev` with a per-instance `.next-<instance>` dist dir
// — without the namespacing, two parallel `next dev` instances in the same
// web/ refuse to start (Next.js grabs an exclusive lock at `<distDir>/lock`;
// `next start` is read-only on the dist dir, so prod instances can share a
// bundle). The dist dir must stay inside the project (Next.js rejects
// `../`-style paths), so the instance name is sanitized to [A-Za-z0-9_-].
// Standalone `bun run dev` still defaults to `.next` because the env var is
// unset there. Both modes carry `-H 127.0.0.1` — see the security note at
// the call site. Exported for tests pinning the prod-vs-dev pick.
export function webLaunchPlan(
  prodDistDir: string | null,
  instance: string,
  port: number
): { command: string[]; distDir: string } {
  const flags = ["--", "-H", "127.0.0.1", "-p", String(port)];
  if (prodDistDir) return { command: ["run", "start", ...flags], distDir: prodDistDir };
  return { command: ["run", "dev", ...flags], distDir: `.next-${instance.replace(/[^a-zA-Z0-9_-]/g, "_")}` };
}

export async function startWeb(config: RuntimeConfig, options: WebOptions): Promise<{ webUrl: string; child?: ChildProcess }> {
  const webRoot = join(projectRoot(), "packages", "web");
  if (!existsSync(join(webRoot, "package.json"))) {
    throw new Error("Web app not found at packages/web/. Cannot start the Next.js control plane.");
  }
  // Worktrees and fresh clones don't have node_modules. Auto-install once
  // so `gini run` / `gini start` works without a separate manual step. Detected
  // by the presence of next's binary stub; a partial install (lockfile only)
  // also triggers a re-install. The workspace install hoists next's stub to
  // the root node_modules/.bin, so probe both there and the package-local
  // .bin before deciding an install is needed.
  const nextStubMissing =
    !existsSync(join(webRoot, "node_modules", ".bin", "next")) &&
    !existsSync(join(projectRoot(), "node_modules", ".bin", "next"));
  if (nextStubMissing) {
    process.stderr.write("Installing web dependencies (one-time)... \n");
    // cwd anywhere inside the workspace installs the whole workspace against
    // the root lockfile, which covers packages/web.
    const result = spawnSync("bun", ["install"], { cwd: webRoot, stdio: "inherit" });
    if (result.status !== 0) {
      throw new Error("Failed to install web dependencies. Run `bun install` from the checkout root manually.");
    }
  }
  // We require the chosen port to be claimable BEFORE spawning. If
  // `availablePort` hands us a free port but a foreign process binds it
  // between then and now, the child will fail to listen and we'll detect that
  // via the healthz probe. We do NOT silently roll up to the next port —
  // foreign-server squatting should fail loudly so the user knows.
  const requestedPort = options.webPort;
  const port = await availablePort(requestedPort);
  if (port !== requestedPort && options.webPortPinned) {
    // User pinned a port (via --web-port or GINI_WEB_PORT); refuse to silently
    // roll forward to a neighbor. They asked for a specific port, so the right
    // behavior is to fail loudly so they can stop the squatter or pick another.
    throw new Error(`Requested web port ${requestedPort} is busy. Stop the other process or pick a different --web-port.`);
  }
  // Serve the sha-keyed production bundle when one exists for the CURRENT
  // checkout (web/.next-prod-<sha12> with a BUILD_ID, <sha12> = `git
  // rev-parse --short=12 HEAD`); fall back to `next dev` otherwise. Only the
  // update/install flows create these dirs, and the sha key pins a bundle to
  // the commit it was built from — a fresh clone, a worktree, or a checkout
  // that moved past its last build all miss the key and land on dev mode,
  // which compiles on demand and always reflects the current source. The key
  // sees HEAD, not the working tree: the installed runtime is `reset --hard`
  // clean so its bundle always matches the source, but a repo checkout with
  // uncommitted edits and a hand-built bundle for its HEAD serves that
  // bundle anyway. The launchd web shim (src/cli/autostart.ts buildWebShim)
  // applies the same rule in sh.
  // Bind the inner Next server to loopback (-H 127.0.0.1). Next defaults to
  // 0.0.0.0 (all interfaces) in BOTH modes, which would make the web port
  // LAN-reachable; the BFF trusts a loopback `Host` for its owner-bearer
  // injection, and a Host header is forgeable by a non-browser client, so a
  // LAN peer hitting the inner port directly could obtain owner access and
  // bypass the gateway's Host/Origin + relay-session gate. The gateway (the
  // only intended ingress) already binds 127.0.0.1 and reverse-proxies to
  // this child over loopback.
  const prodDistDir = resolveWebProdDistDir(projectRoot());
  const { command, distDir } = webLaunchPlan(prodDistDir, config.instance, port);
  // detached: true puts the child in its own process group so we can SIGTERM
  // the entire group on stop (`bun run dev` re-execs into Next.js, leaving an
  // orphaned grandchild if we only kill the recorded pid).
  const foreground = options.foreground === true;
  // Foreground: keep the web child attached and tee dev-server stdio to both
  // the user's terminal and web.log. Daemon (gini start) keeps the historic
  // detached group but writes stdio into web.log via an FD so the dev-server
  // output is recoverable after the CLI exits.
  const webLog = setupChildLog(config.instance, "web.log", foreground);
  const child = spawn("bun", command, {
    cwd: webRoot,
    detached: !foreground,
    stdio: webLog.stdio,
    env: {
      ...process.env,
      GINI_RUNTIME_URL: url(config),
      GINI_TOKEN: config.token,
      GINI_INSTANCE: config.instance,
      GINI_DIST_DIR: distDir,
      PORT: String(port)
    }
  });
  webLog.onSpawned(child);
  if (!foreground) child.unref();
  if (typeof child.pid === "number") {
    writeFileSync(join(config.stateRoot, "web.pid"), String(child.pid));
  }
  // Persist the actual port so status/stop/doctor and `existingWebUrl` find
  // it without having to scan a port range. Cleared on stop and on stale-pid
  // detection above.
  writeFileSync(webPortPath(config.instance), String(port));
  // Probe over IPv4 for determinism, advertise localhost to the user. Next.js
  // dev's `allowedDevOrigins` defaults to `localhost`, so opening the IPv4
  // form in a browser blocks HMR/chunk fetches and breaks hydration.
  const probeUrl = `http://127.0.0.1:${port}`;
  const webUrl = `http://localhost:${port}`;
  try {
    await waitForWebHealthz(probeUrl, child.pid, config.instance);
    return foreground ? { webUrl, child } : { webUrl };
  } catch (error) {
    // Kill the child group so we don't leak processes on failure. In foreground
    // mode there is no separate group (we did not pass detached), so signal
    // the child pid directly.
    if (typeof child.pid === "number") {
      try {
        if (foreground) process.kill(child.pid, "SIGTERM");
        else process.kill(-child.pid, "SIGTERM");
      } catch { /* ignore */ }
    }
    rmSync(join(config.stateRoot, "web.pid"), { force: true });
    rmSync(webPortPath(config.instance), { force: true });
    throw error;
  }
}

/**
 * Probes /api/runtime/__healthz on the spawned Next.js child.
 *
 * Why this is non-trivial:
 *  - HEAD `/` returns success against ANY HTTP server (Python's http.server, a
 *    random Bun.serve, etc), so any port-squatter satisfies it. False positive.
 *  - `availablePort` only checks IPv4 127.0.0.1 binding, but Next.js dual-
 *    stacks; a port that succeeds on net.createServer can still collide with
 *    something listening on ::.
 *
 * The healthz route returns a marker JSON identifying the runtime+instance. We
 * verify both that we get the marker AND that the spawned child PID is still
 * alive — that combination tells us "the server we spawned is the one
 * answering on this port".
 */
export async function waitForWebHealthz(webUrl: string, childPid: number | undefined, expectedInstance: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let sawInstanceMismatch = false;
  while (Date.now() < deadline) {
    if (childPid !== undefined && !processAlive(childPid)) {
      throw new Error(`Next.js process exited before becoming healthy. webUrl=${webUrl}`);
    }
    try {
      const response = await fetch(`${webUrl}/api/runtime/__healthz`, { redirect: "manual" });
      if (response.ok) {
        const body = await response.json().catch(() => null) as { ok?: boolean; service?: string; instance?: string } | null;
        if (body && body.ok === true && body.service === "gini-web") {
          // Instance must match the instance we spawned the child with. Mismatch means
          // we're talking to a different Gini web (different instance on the same
          // port — e.g. user has instance A's web running and started instance B that
          // bound to a port we then probed). Reject and keep waiting in case
          // the spawned child is still coming up.
          if (body.instance === expectedInstance) return;
          sawInstanceMismatch = true;
        }
      }
    } catch { /* keep waiting */ }
    await Bun.sleep(250);
  }
  if (sawInstanceMismatch) {
    throw new Error(`Next.js healthz on ${webUrl} reports a different instance than expected (${expectedInstance}). Another Gini web is using this port.`);
  }
  throw new Error(`Next.js did not become healthy within 30s on ${webUrl}.`);
}

// Walk up to 1000 ports forward from `preferred` looking for a free
// one. The previous range of 100 turned out to be too tight in CI:
// multiple parallel `gini run` tests can each roll a random base in
// the 7400-8399 window (src/cli/args.ts GINI_PORT default), and with
// runners that also have other services holding ports, the 100-wide
// search regularly saturated. 1000 ports gives 10x the room without
// noticeably increasing local-dev startup time (each canListen probe
// returns sub-millisecond when the port is free).
const PORT_SEARCH_WINDOW = 1000;

export async function availablePort(preferred: number): Promise<number> {
  for (let port = preferred; port < preferred + PORT_SEARCH_WINDOW; port += 1) {
    if (await canListen(port)) return port;
  }
  throw new Error(`No available port found from ${preferred} to ${preferred + PORT_SEARCH_WINDOW - 1}.`);
}

// Detect IPv6 availability ONCE per process by attempting to bind
// ::1 on an OS-assigned port. Ubuntu CI runners ship with IPv6
// disabled, and without this gate the per-port ::1 probe below
// returns false on every port (EADDRNOTAVAIL), exhausting the
// 1000-port search on a totally idle host. Promise resolves to
// true if ::1 is bindable, false otherwise. Memoized so the
// detection cost is paid once.
const ipv6AvailablePromise: Promise<boolean> = new Promise((resolve) => {
  const server = createServer()
    .once("error", () => resolve(false))
    .once("listening", () => server.close(() => resolve(true)))
    .listen(0, "::1");
});

async function canListen(port: number): Promise<boolean> {
  // Probe every host we (or downstream Next.js) might bind to.
  // Wildcard probes alone are insufficient on macOS: binding
  // 0.0.0.0:N succeeds even when 127.0.0.1:N is already taken
  // (different addresses, kernel doesn't refuse). On v4-only
  // hosts (CI), the ::1 probe is skipped — a v6 squatter can't
  // exist on a host that doesn't have v6 enabled.
  //
  // Probe SEQUENTIALLY, not in parallel. On Linux the kernel refuses a
  // wildcard 0.0.0.0:N bind while 127.0.0.1:N is held, so a parallel
  // Promise.all batch has the 127.0.0.1 probe collide with the sibling
  // 0.0.0.0 probe on the SAME port — every candidate then fails and the
  // walk exhausts (observed in a Linux container; macOS's permissive
  // dual-stack binding masked it). Binding and closing each address in
  // turn removes the self-collision while still detecting a real squatter
  // on any address. The cost is a few extra serial binds per candidate,
  // each sub-millisecond on a free port.
  const ipv6Available = await ipv6AvailablePromise;
  const hosts = ipv6Available
    ? ["127.0.0.1", "::1", "0.0.0.0"]
    : ["127.0.0.1", "0.0.0.0"];
  for (const host of hosts) {
    if (!(await probe(port, host))) return false;
  }
  return true;
}

function probe(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
      .once("error", () => resolve(false))
      .once("listening", () => server.close(() => resolve(true)))
      .listen(port, host);
  });
}

export function stopRuntime(config: RuntimeConfig) {
  const webResult = stopWeb(config);
  const path = pidPath(config.instance);
  if (!existsSync(path)) {
    // Clean up any orphaned port file even when there's no pidfile — keeps
    // the instance root tidy across upgrades and aborted starts.
    rmSync(runtimePortPath(config.instance), { force: true });
    return { stopped: false, reason: "No pid file", instance: config.instance, web: webResult };
  }
  const pid = Number(readFileSync(path, "utf8"));
  // Process already dead → stale pidfile, treat as a successful stop. The
  // user just wanted "make sure it's not running"; surfacing an error here
  // makes them re-run stop or rm the pidfile by hand.
  if (!processAlive(pid)) {
    rmSync(path, { force: true });
    rmSync(runtimePortPath(config.instance), { force: true });
    return { stopped: true, pid, reason: "process already dead", instance: config.instance, web: webResult };
  }
  try {
    process.kill(pid, "SIGTERM");
    rmSync(path, { force: true });
    rmSync(runtimePortPath(config.instance), { force: true });
    return { stopped: true, pid, instance: config.instance, web: webResult };
  } catch (error) {
    return { stopped: false, pid, error: error instanceof Error ? error.message : String(error), web: webResult };
  }
}

function stopWeb(config: RuntimeConfig): { stopped: boolean; pid?: number; reason?: string } {
  const path = join(config.stateRoot, "web.pid");
  if (!existsSync(path)) {
    rmSync(webPortPath(config.instance), { force: true });
    return { stopped: false, reason: "No web pid" };
  }
  const pid = Number(readFileSync(path, "utf8"));
  if (!processAlive(pid)) {
    rmSync(path, { force: true });
    rmSync(webPortPath(config.instance), { force: true });
    return { stopped: true, pid, reason: "process already dead" };
  }
  let groupKilled = false;
  // The web pid is the group leader (we spawned with detached: true). Killing
  // the group with -pid reaches every descendant: bun run -> next dev -> the
  // actual server process. Falling back to a plain kill keeps us robust if the
  // platform somehow rejects the group signal.
  try {
    process.kill(-pid, "SIGTERM");
    groupKilled = true;
  } catch {
    try { process.kill(pid, "SIGTERM"); } catch { /* fall through */ }
  }
  try {
    rmSync(path, { force: true });
    rmSync(webPortPath(config.instance), { force: true });
    return { stopped: true, pid, ...(groupKilled ? { reason: "group SIGTERM" } : {}) };
  } catch (error) {
    return { stopped: false, pid, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function waitForRuntimeStopped(config: RuntimeConfig, pid?: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pidAlive = typeof pid === "number" ? processAlive(pid) : false;
    if (!pidAlive && !(await isRunning(config))) return true;
    await Bun.sleep(100);
  }
  return false;
}

// Poll until a specific port is bindable (the prior holder has released it) or
// the deadline passes. `launchctl bootout` returns as soon as the unload is
// ACCEPTED, not after the process has died and freed its socket — so a
// bootout→bootstrap reload can race the kernel's TIME_WAIT/teardown and hit
// EADDRINUSE. Callers that bootout a port-binding service await this before the
// re-bootstrap so the port is actually free first. Probes the single host
// (127.0.0.1 by default) the gateway/web bind to; returns whether it became
// free within the budget. Timeout/interval are parameters so tests don't poll
// for real.
export async function waitForPortFree(
  port: number,
  host = "127.0.0.1",
  timeoutMs = 10_000,
  intervalMs = 100
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe(port, host)) return true;
    await Bun.sleep(intervalMs);
  }
  return false;
}

export async function isRunning(config: RuntimeConfig): Promise<boolean> {
  try {
    const response = await fetch(`${url(config)}/api/status`, { headers: auth(config) });
    return response.ok;
  } catch {
    return false;
  }
}

export async function remoteOrLocalStatus(config: RuntimeConfig, options: WebOptions) {
  // R2-m1: include the web URL/health alongside the runtime status so a single
  // `gini status` invocation tells the user where the UI is. We probe via the
  // healthz route (rather than just trusting the pidfile) because that's the
  // only signal that distinguishes "Next.js really running" from "stale pid".
  const webUrl = await existingWebUrl(config, options.webPort);
  try {
    const remote = await api(config, "/api/status");
    // The gateway answered, so it's up — safe to advertise its URL as the web front.
    return { ...remote, web: { running: Boolean(webUrl), url: webUrl ? operatorWebUrl(config) : null } };
  } catch {
    // The gateway is unreachable; the gateway URL would only mislead. Report the
    // inner web's liveness but no operator URL (the single front is down).
    return { ...status(config), ok: false, running: false, web: { running: Boolean(webUrl), url: null } };
  }
}

export async function doctor(config: RuntimeConfig, options: WebOptions) {
  const running = await isRunning(config);
  const state = readState(config.instance);
  const webPidFile = join(config.stateRoot, "web.pid");
  const webPid = existsSync(webPidFile) ? Number(readFileSync(webPidFile, "utf8")) : undefined;
  const webPidAlive = webPid ? processAlive(webPid) : false;
  const webHealthyUrl = webPidAlive ? await existingWebUrl(config, options.webPort) : null;
  const recommendations: string[] = [];
  if (!running) recommendations.push("Run `bun run gini start` to launch the local runtime.");
  if (running && !webHealthyUrl && !options.noWeb) recommendations.push("Next.js control plane not healthy — re-run `gini start` to relaunch.");
  // Probe the per-instance SQLite memory store. Phase 1 surfaces row counts so a
  // user (or `gini doctor` consumer) can confirm the schema is in place; phases
  // 2+ will add retain/recall metrics on top of the same probe.
  const memory = probeMemoryDb(config.instance);
  // The legacy MemoryRecord migration panel was removed alongside the
  // state.memories consolidation — `legacyMigrationStatus` now returns
  // `fullyMigrated: true` unconditionally, so there's nothing left to
  // surface. See ADR runtime-identity-files.md.
  const legacyMigration = legacyMigrationStatus(undefined);
  // Embedding-provider snapshot. Surfaces the active provider/model + cache
  // size, and warns if any active unit is embedded with a model other than
  // the current provider's model (recall's semantic channel skips those).
  const embedding = embeddingStatus(config);
  const mismatches = listBanksWithModelMismatch(config);
  if (mismatches.length > 0) {
    const banks = [...new Set(mismatches.map((m) => m.bankId))].join(", ");
    recommendations.push(
      `Some banks (${banks}) have units embedded with a different model than the active provider (${embedding.provider.model}). Run \`gini embedding reembed --bank <id>\` to refresh.`
    );
  }
  // Cross-encoder reranker snapshot. Surfaces the active provider/model and
  // the top-N. Default is local; smoke pins echo. The reranker shares the
  // ~/.gini/models cache with embeddings, so size is reported on the same dir.
  const reranker = rerankerStatus(config);
  return {
    ok: true,
    bun: Bun.version,
    instance: config.instance,
    running,
    stateRoot: config.stateRoot,
    workspaceRoot: config.workspaceRoot,
    port: config.port,
    // Surface instance defaults vs. the actual recorded port so users can see
    // when a port walk happened (e.g. another instance already grabbed the
    // default). `recorded` is null when nothing has been started for this instance.
    ports: {
      runtime: {
        default: defaultRuntimePort(config.instance),
        configured: config.port,
        recorded: recordedRuntimePort(config)
      },
      web: {
        default: defaultWebPort(config.instance),
        configured: options.webPort,
        recorded: recordedWebPort(config)
      }
    },
    // Advertise the gateway URL only when the gateway is actually up (running) —
    // it's the single front, so a healthy inner web process behind a down
    // gateway has no usable operator URL.
    web: { running: webPidAlive, pid: webPid ?? null, url: running && webHealthyUrl ? operatorWebUrl(config) : null },
    tokenConfigured: Boolean(config.token),
    provider: providerHealth(config),
    tasks: state.tasks.length,
    pendingApprovals:
      state.authorizations.filter((item) => item.status === "pending").length +
      state.setupRequests.filter((item) => item.status === "pending").length,
    memory,
    legacyMigration,
    embedding,
    reranker,
    recommendations
  };
}

export async function waitForTask(config: RuntimeConfig, taskId: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const detail = await api(config, `/api/tasks/${taskId}`);
    if (["completed", "failed", "waiting_approval", "needs_input"].includes(detail.task.status)) return;
    await Bun.sleep(100);
  }
  throw new Error(`Task did not settle: ${taskId}`);
}

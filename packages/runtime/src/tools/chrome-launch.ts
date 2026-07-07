// Spawned Chrome launcher. The agent's default browser is launched by driving
// a real branded Chrome ourselves — `--headless=new` plus the shared stealth
// args, a clean (non-"HeadlessChrome") User-Agent, the caller-supplied
// `--user-data-dir` profile, and a free-picked `--remote-debugging-port`.
//
// Transport: chromium.launchPersistentContext, which drives the self-launched
// context over Playwright's PIPE transport (`--remote-debugging-pipe`) — the
// natural transport for a browser we spawn ourselves, no TCP debug socket
// needed for automation. (For attaching to a user's ALREADY-running Chrome the
// cdp provider uses connectOverCDP over a TCP WebSocket, which works under Bun
// via patches/playwright-core@1.61.1.patch.) We still inject a free
// `--remote-debugging-port` into the launch args so the spawned Chrome ALSO
// exposes a debug endpoint — the sign-in screencast bridge attaches to it over
// raw CDP — without routing the agent's automation through that endpoint.
//
// This launcher free-picks the debug port and owns the launch directly. The
// caller (the spawned BrowserSessionProvider in browser.ts) passes the
// per-instance profile dir, so there is one shared browser per instance. The
// user's own Chrome on the conventional :9222 is never launched onto, attached
// to, or killed — we pick a port strictly above it.
//
// Everything above this seam (the @eN snapshot walker, secret redaction,
// SSRF/domain-policy gating, approvals, traces) runs in-process against the
// Playwright client exactly as before. See ADR browser-automation-engine.md.
import { createServer } from "node:net";
import { mkdirSync } from "node:fs";
import type { BrowserContext } from "playwright-core";
import {
  CHROME_LAUNCH_ARGS,
  cleanChromeUserAgent,
  findChromePath,
  resolveBrowserLaunchTarget
} from "./chrome-discovery";
import { containerChromeArgs } from "../lib/container-env";
import { ensureChromiumInstalled } from "./chrome-install";

// First port we probe for the spawned Chrome's debug endpoint. Deliberately well
// above 9222 so we never probe (let alone bind) the port a user's personal
// debugging Chrome conventionally uses. The free-port walk rolls forward.
export const DEFAULT_CDP_PORT_BASE = 9333;
// How far the free-port walk searches before giving up. Mirrors the runtime's
// existing port walker window (src/cli/process.ts) so the behavior is familiar.
const PORT_SEARCH_WINDOW = 1000;

type LaunchPersistentContextFn = (
  dataDir: string,
  options: Record<string, unknown>
) => Promise<BrowserContext>;

// Injection seam. Every external effect (the Playwright launch, the free-port
// probe, binary resolution, UA derivation) is overridable so the launch
// orchestration can be unit-tested without a real Chrome.
export interface ChromeLaunchDeps {
  launchPersistentContext: LaunchPersistentContextFn;
  findFreePort: (base: number) => Promise<number>;
  resolveLaunchTarget: typeof resolveBrowserLaunchTarget;
  cleanUserAgent: typeof cleanChromeUserAgent;
  // Bundled-first fallback chain, used only when a BRANDED launch fails.
  findChromePath: typeof findChromePath;
  // Download Playwright's Chromium when no binary is present at all. Returns
  // true when a browser is now installed. Single-flight + bounded internally.
  ensureChromiumInstalled: typeof ensureChromiumInstalled;
}

async function loadLaunchPersistentContext(): Promise<LaunchPersistentContextFn> {
  const mod = (await import("playwright-core")) as typeof import("playwright-core");
  return (dataDir, options) =>
    mod.chromium.launchPersistentContext(dataDir, options) as unknown as Promise<BrowserContext>;
}

export function defaultDeps(): ChromeLaunchDeps {
  return {
    // Resolved lazily through the dynamic import so callers that never launch
    // don't eagerly pull in playwright-core.
    launchPersistentContext: async (dataDir, options) =>
      (await loadLaunchPersistentContext())(dataDir, options),
    findFreePort,
    resolveLaunchTarget: resolveBrowserLaunchTarget,
    cleanUserAgent: cleanChromeUserAgent,
    findChromePath,
    ensureChromiumInstalled
  };
}

// Probe a single TCP port for bindability on loopback. Resolves true when the
// port is free, false when something already holds it OR the port number is
// invalid (out of range), so the free-port walk treats unbindable numbers as
// "not free" and keeps moving rather than rejecting.
function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const server = createServer()
        .once("error", () => resolve(false))
        .once("listening", () => server.close(() => resolve(true)))
        .listen(port, "127.0.0.1");
    } catch {
      // .listen() throws synchronously for an out-of-range port number.
      resolve(false);
    }
  });
}

// Walk forward from `base` and return the first bindable port. Used to pick a
// fresh debug port for the spawned Chrome. There is an inherent TOCTOU gap
// between probing free and Chrome binding it; a collision just means that
// Chrome's debug endpoint is unavailable — the automation itself runs over the
// pipe and is unaffected.
export async function findFreePort(base: number = DEFAULT_CDP_PORT_BASE): Promise<number> {
  for (let port = base; port < base + PORT_SEARCH_WINDOW; port += 1) {
    if (await probePort(port)) return port;
  }
  throw new Error(`No free CDP port found from ${base} to ${base + PORT_SEARCH_WINDOW - 1}.`);
}

// A launched spawned Chrome: the persistent BrowserContext the agent drives,
// the binary that backed it, and the debug port it bound.
export interface SpawnedChrome {
  // Persistent BrowserContext backed by the profile dir on disk.
  // Closing it (context.close()) terminates the Chrome Playwright launched.
  context: BrowserContext;
  // The free debug port injected into the launch args.
  port: number;
  // Absolute path of the Chrome binary that backed the launch (UI display).
  chromePath: string | null;
  // The profile dir the launch used (for profile-dir-scoped reaping).
  profileDir: string;
}

export interface LaunchSpawnedChromeOptions {
  // Profile dir. Created if absent. Cookies, localStorage, and any
  // cf_clearance token persist here across launches.
  profileDir: string;
  // Always true in the agent's default path; the param exists so a future
  // visible-launch caller can reuse this module. Headless launches get the
  // clean UA rewrite; a headed launch keeps Chrome's native UA.
  headless?: boolean;
  // Explicit debug port. Omit to free-pick one above DEFAULT_CDP_PORT_BASE.
  port?: number;
  // Extra Playwright context options (e.g. acceptDownloads, downloadsPath).
  extraOptions?: Record<string, unknown>;
  // Test/seam overrides; production callers pass nothing.
  deps?: Partial<ChromeLaunchDeps>;
}

// Launch a branded Chrome with the stealth identity against the given profile
// dir, over Playwright's pipe transport. Resolves the binary, applies the
// shared stealth args plus a free `--remote-debugging-port`, normalizes the
// headless UA, and returns the live persistent context.
export async function launchSpawnedChrome(options: LaunchSpawnedChromeOptions): Promise<SpawnedChrome> {
  const deps: ChromeLaunchDeps = { ...defaultDeps(), ...options.deps };
  const headless = options.headless !== false;

  mkdirSync(options.profileDir, { recursive: true });

  let target = await deps.resolveLaunchTarget();
  if (!target.executablePath) {
    // No branded Chrome AND no bundled Chromium on disk (a fresh machine that
    // never ran `playwright install`). Download Playwright's Chromium on demand
    // and re-resolve, so the browser feature self-provisions instead of dead-
    // ending. The install is single-flight and bounded; on failure we fall
    // through to the original error.
    const installed = await deps.ensureChromiumInstalled();
    if (installed) target = await deps.resolveLaunchTarget();
  }
  if (!target.executablePath) {
    throw new Error(
      "No Chrome binary found to launch, and automatic Chromium download failed. " +
        "Install Google Chrome, set GINI_CHROME_PATH, or run `bunx playwright install chromium`."
    );
  }
  const port = options.port ?? (await deps.findFreePort(DEFAULT_CDP_PORT_BASE));

  // Build options per binary so a bundled fallback recomputes the headless UA
  // from the bundled binary rather than reusing the branded binary's UA.
  const buildOptions = async (execPath: string): Promise<Record<string, unknown>> => {
    const userAgent = headless ? await deps.cleanUserAgent(execPath) : undefined;
    // extraOptions is spread FIRST so the launch invariants below always win —
    // a caller-supplied `args` (or headless/executablePath/userAgent) can never
    // silently drop the stealth flags or the --remote-debugging-port the
    // screencast bridge attaches to.
    // containerChromeArgs() is empty off a normal host; inside a container
    // (GINI_CHROME_NO_SANDBOX set) it appends --no-sandbox +
    // --disable-dev-shm-usage, which Chrome needs to start under a default
    // container's restricted sandbox and 64MB /dev/shm. Neither is
    // web-observable, so the stealth identity is unaffected. See ADR
    // docker-xvfb-deployment.md.
    return {
      ...(options.extraOptions ?? {}),
      headless,
      executablePath: execPath,
      args: [...CHROME_LAUNCH_ARGS, ...containerChromeArgs(), `--remote-debugging-port=${port}`],
      ...(userAgent ? { userAgent } : {})
    };
  };

  try {
    const context = await deps.launchPersistentContext(
      options.profileDir,
      await buildOptions(target.executablePath)
    );
    return { context, port, chromePath: target.executablePath, profileDir: options.profileDir };
  } catch (error) {
    // Only a BRANDED launch retries on the bundled Chromium: a too-new system
    // Chrome can drift from playwright-core's pinned CDP protocol and fail to
    // drive. An override or already-bundled target has no better fallback, so
    // it rethrows.
    if (!target.branded) throw error instanceof Error ? error : new Error(String(error));
    const fallback = await deps.findChromePath();
    if (!fallback) throw error instanceof Error ? error : new Error(String(error));
    const context = await deps.launchPersistentContext(options.profileDir, await buildOptions(fallback));
    return { context, port, chromePath: fallback, profileDir: options.profileDir };
  }
}

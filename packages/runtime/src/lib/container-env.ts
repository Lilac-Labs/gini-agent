// Container-deployment env seams. Three runtime knobs that only ever change
// when Gini runs inside a container (Docker + Xvfb); on a normal host install
// every default here reproduces the historical hard-coded behavior, so a
// non-container run is byte-for-byte unaffected.
//
// Kept as pure functions of an injected `env` bag (not module-scope reads of
// process.env) so each is unit-testable in isolation and the call sites stay a
// one-liner. See ADR docker-xvfb-deployment.md.
// Truthy-string parse shared by the boolean knobs. Accepts the conventional
// affirmatives case-insensitively; everything else (including unset) is false.
// Exported so a test can pin the exact accepted set.
export function isTruthyEnv(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

// Host the gateway's Bun.serve binds. Defaults to loopback (127.0.0.1) exactly
// as before, so a host install is never exposed beyond loopback by accident. A
// container sets GINI_BIND_HOST=0.0.0.0 so Docker's published-port forwarding
// (which targets the container's eth0, not loopback) can reach the gateway.
//
// This does NOT weaken the trust model: the gateway's Host/Origin gate
// (src/lib/origin-trust.ts) keys on the request Host header, and a browser
// hitting http://localhost:<published-port> still sends `Host: localhost`,
// which isLoopbackHost() trusts. Binding 0.0.0.0 only changes which network
// interface accepts the TCP connection, not which Host values are trusted.
// An empty/whitespace value falls back to the loopback default rather than
// binding nothing.
export function resolveBindHost(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.GINI_BIND_HOST;
  if (raw === undefined) return "127.0.0.1";
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : "127.0.0.1";
}

// Whether the agent's spawned Chrome launches headless. Defaults to TRUE — the
// historical hard-coded value at the spawned-session call site. A container
// running Xvfb sets GINI_BROWSER_HEADLESS=false so Chrome launches HEADED
// against the virtual display (DISPLAY=:99): a real headed Chrome under Xvfb
// presents far fewer automation signals than --headless=new, which complements
// the stealth-identity work (see ADR browser-stealth-identity.md). Only an
// explicit falsy value flips it; anything else (including unset) stays headless.
export function resolveBrowserHeadless(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.GINI_BROWSER_HEADLESS;
  if (raw === undefined) return true;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }
  return true;
}

// Extra Chromium launch args required ONLY inside a container, gated behind
// GINI_CHROME_NO_SANDBOX so they never leak into a host launch (where they
// would needlessly drop the sandbox). Empty array off a normal host.
//
//   --no-sandbox            Chrome's setuid/namespace sandbox can't initialize
//                           in a default container (no SYS_ADMIN, restrictive
//                           seccomp). Without this Chrome exits immediately.
//                           Not a web-observable signal, so stealth is intact.
//   --disable-dev-shm-usage Containers default to a 64MB /dev/shm; Chrome
//                           writes large shared-memory segments there and
//                           crashes ("Target closed") when it fills. This routes
//                           those writes to /tmp instead. The alternative is
//                           running the container with a larger --shm-size, in
//                           which case this flag is unnecessary — but defaulting
//                           it on is the safe, portable choice.
export function containerChromeArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  if (!isTruthyEnv(env.GINI_CHROME_NO_SANDBOX)) return [];
  return ["--no-sandbox", "--disable-dev-shm-usage"];
}

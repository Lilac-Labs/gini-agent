import { spawn } from "bun";

// Google Workspace sign-in liveness, derived from `gws auth status`.
//
// This is a SEPARATE signal from the google-oauth-desktop connector's
// `health` field. Connector health == "OAuth *client* creds provisioned"
// (the client_id/secret the user pasted; they never expire) and is
// load-bearing for first-time setup: the connector.request /complete path
// DELETES any connector whose probe isn't "healthy" at creation. A
// sign-in probe is unhealthy before `gws auth login` runs, so it cannot be
// folded into `health` without breaking setup. Sign-in liveness — whether
// the *user session* token from `gws auth login` is still valid — lives
// here instead.
//
// `gws auth status` prints JSON to stdout, e.g. after a Google-side revoke:
//   { "client_config_exists": false, "token_valid": false,
//     "token_error": "Token has been expired or revoked.",
//     "has_refresh_token": true, ... }
// (a reauth challenge instead reads "reauth related error (invalid_rapt)").
// signedIn := token_valid === true; clientConfigured := client_config_exists.

export interface GwsSessionStatus {
  // Whether the `gws` CLI is on PATH and produced parseable JSON.
  installed: boolean;
  // Whether OAuth client config (client_id/secret) is present for gws.
  clientConfigured: boolean;
  // Whether the user session token is currently valid (the live signal).
  signedIn: boolean;
  // Whether the gws token was actively revoked (vs never signed in). True when
  // signedIn is false AND gws still holds a refresh token that no longer yields
  // a session (has_refresh_token with a token_error), or token_error matches a
  // known revoke/reauth signal. This separates a revoked/expired grant (the user
  // must re-authenticate) from a never-signed-in account (no refresh token yet).
  // Always set by parseGwsAuthStatus.
  tokenRevoked?: boolean;
  // Per-service grant derived from the granted OAuth scopes, keyed by the
  // google-* skill suffix. A partial consent (e.g. only Gmail) is still
  // signedIn:true but lights up only its own keys.
  services: Record<GwsService, boolean>;
  // Signed-in account email (from `gws auth status` `.user`). Omitted when gws
  // doesn't report one (signed out / not installed).
  email?: string;
  // The granted OAuth scopes (from `.scopes`); [] when absent.
  scopes: string[];
  // Short human string for the UI / model.
  message: string;
}

// The seven Workspace services the google-* skills cover, keyed by skill
// suffix, mapped to the scope substrings that imply the service is granted.
// (docs→documents, sheets→spreadsheets, meet→meetings on Google's side.)
const SERVICE_SCOPES = {
  calendar: ["/auth/calendar"],
  gmail: ["/auth/gmail", "mail.google.com"],
  drive: ["/auth/drive"],
  docs: ["/auth/documents"],
  sheets: ["/auth/spreadsheets"],
  forms: ["/auth/forms"],
  meet: ["/auth/meetings"]
} as const;
export type GwsService = keyof typeof SERVICE_SCOPES;

function servicesFromScopes(scopes: string[]): Record<GwsService, boolean> {
  const out = {} as Record<GwsService, boolean>;
  for (const service of Object.keys(SERVICE_SCOPES) as GwsService[]) {
    out[service] = SERVICE_SCOPES[service].some((needle) =>
      scopes.some((scope) => scope.includes(needle))
    );
  }
  return out;
}

// Parse the JSON `gws auth status` emits into a session status. Pure and
// unit-testable: the subprocess boundary is isolated in `gwsSessionStatus`.
// Any parse failure / non-object output yields the not-installed shape, so a
// garbled CLI is treated the same as a missing one (we can't trust it).
export function parseGwsAuthStatus(stdout: string): GwsSessionStatus {
  // gws can prefix its JSON with a non-JSON preamble (keyring notice, etc.) on
  // stdout; slice from the first "{" so a preamble doesn't degrade a live
  // session to installed:false. Pure JSON input still starts at index 0.
  const start = stdout.indexOf("{");
  let parsed: unknown;
  try {
    parsed = JSON.parse(start >= 0 ? stdout.slice(start) : stdout);
  } catch {
    return notInstalled();
  }
  if (!parsed || typeof parsed !== "object") return notInstalled();
  const obj = parsed as Record<string, unknown>;
  const clientConfigured = obj.client_config_exists === true;
  const signedIn = obj.token_valid === true;
  const tokenError = typeof obj.token_error === "string" ? obj.token_error : "";
  // A stored refresh token that no longer yields a session means the grant was
  // revoked (or expired) and the user must re-authenticate. gws reports why in
  // token_error — "Token has been expired or revoked." after a Google-side
  // revoke, "reauth related error (invalid_rapt)" for a reauth challenge. Match
  // structurally (a present-but-dead refresh token gws explained) so detection
  // doesn't hinge on Google's exact wording, and keep the known error strings as
  // a fallback for any gws build that omits has_refresh_token.
  const hasRefreshToken = obj.has_refresh_token === true;
  const tokenRevoked =
    !signedIn &&
    ((hasRefreshToken && tokenError.length > 0) ||
      /invalid_grant|invalid_rapt|expired or revoked/i.test(tokenError));
  // gws reports `scopes` only for a live session; when signed out it's absent,
  // so every service resolves false.
  const scopes = Array.isArray(obj.scopes)
    ? obj.scopes.filter((s): s is string => typeof s === "string")
    : [];
  const email = typeof obj.user === "string" && obj.user.length > 0 ? obj.user : undefined;
  return {
    installed: true,
    clientConfigured,
    signedIn,
    tokenRevoked,
    services: servicesFromScopes(scopes),
    scopes,
    ...(email ? { email } : {}),
    message: signedIn
      ? "Signed in to Google"
      : tokenRevoked || clientConfigured
      ? "Google sign-in expired — re-auth needed"
      : "Google sign-in needed"
  };
}

function notInstalled(): GwsSessionStatus {
  return {
    installed: false,
    clientConfigured: false,
    signedIn: false,
    tokenRevoked: false,
    services: servicesFromScopes([]),
    scopes: [],
    message: "gws not installed"
  };
}

// Machine-global cache. Sign-in liveness is a property of the local gws
// install, not of any one instance or connector, so a single ~15s-TTL cache
// keeps repeated /api/connectors and list_connectors calls from spawning gws
// on every request. We cache the in-flight PROMISE (not just the resolved
// value) so a burst of concurrent callers shares one spawn instead of forking
// one `gws` each.
const TTL_MS = 15_000;
// `gws auth status` is a local status read — sub-second in practice. Bound it
// anyway: a token-refresh network call, a wedged child, or a slow `zsh -lc`
// profile could otherwise hang the connectors list until the HTTP idle timeout.
const SPAWN_TIMEOUT_MS = 4_000;
let cached: { at: number; promise: Promise<GwsSessionStatus> } | undefined;
// Per-config-dir cache for multi-account status. Same TTL + in-flight-promise
// sharing as `cached`, keyed by configDir so each tagged account spawns at most
// one `gws auth status` per ~15s window even under concurrent /api/connectors
// and /api/google/accounts reads.
const cachedByDir = new Map<string, { at: number; promise: Promise<GwsSessionStatus> }>();

// Resolve the current Google Workspace sign-in liveness. Cached ~15s. gws
// missing / command error / timeout / non-JSON output → installed:false. Never
// rejects, so callers (GET /api/connectors, list_connectors) stay best-effort.
export function gwsSessionStatus(): Promise<GwsSessionStatus> {
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) return cached.promise;
  const promise = runGwsAuthStatus();
  cached = { at: now, promise };
  return promise;
}

// Sign-in liveness for a specific gws config dir (a tagged account). Same spawn
// + cache semantics as `gwsSessionStatus`, but passes GOOGLE_WORKSPACE_CLI_CONFIG_DIR
// so gws reads that account's token instead of the default ~/.config/gws.
// Never rejects (best-effort, like the no-arg variant).
export function gwsSessionStatusForDir(configDir: string): Promise<GwsSessionStatus> {
  const now = Date.now();
  const hit = cachedByDir.get(configDir);
  if (hit && now - hit.at < TTL_MS) return hit.promise;
  const promise = runGwsAuthStatus(configDir);
  cachedByDir.set(configDir, { at: now, promise });
  return promise;
}

// Runs `gws auth status` through a login shell so gws is on PATH (mirroring how
// terminal_exec spawns in src/agent.ts), bounded by a kill-on-timeout. stdin is
// ignored so neither the login shell nor gws can block waiting on input. When
// `configDir` is supplied, GOOGLE_WORKSPACE_CLI_CONFIG_DIR is set so gws reads
// that account's token; otherwise it reads the default config dir.
async function runGwsAuthStatus(configDir?: string): Promise<GwsSessionStatus> {
  try {
    const proc = spawn(["zsh", "-lc", "gws auth status"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: configDir
        ? { ...process.env, GOOGLE_WORKSPACE_CLI_CONFIG_DIR: configDir }
        : { ...process.env }
    });
    const timeout = setTimeout(() => {
      try { proc.kill(); } catch { /* already exited */ }
    }, SPAWN_TIMEOUT_MS);
    try {
      // Drain stdout AND stderr concurrently: an unread piped stream can fill
      // its OS buffer (~64KB) and deadlock the child until the kill timer
      // fires. gws emits its keyring preamble to stderr, so it always has
      // bytes waiting there.
      const [stdout] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited
      ]);
      return parseGwsAuthStatus(stdout);
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return notInstalled();
  }
}

// Drop one config dir's cached status so the next read re-spawns `gws auth
// status`. Called after a register/remove changes a dir's session, so a freshly
// signed-in (or removed) dir isn't served a stale entry from before the change.
export function invalidateGwsSessionDir(configDir: string): void {
  cachedByDir.delete(configDir);
}

// Test seam: drop both caches so a unit test can assert fresh behavior.
export function resetGwsSessionCache(): void {
  cached = undefined;
  cachedByDir.clear();
}

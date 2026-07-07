import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useMemo, useState } from "react";

// Stored under a stable key so a future migration (pairing-claim flow,
// multiple instances) can read the older record without an app reset.
const STORAGE_KEY = "gini.auth.v1";

export interface AuthCredentials {
  baseUrl: string;
  token: string;
}

interface AuthState {
  status: "loading" | "ready";
  credentials: AuthCredentials | null;
}

// Listener fan-out so every mounted useAuth hook sees the same value
// (AsyncStorage doesn't broadcast change events). Saving on one screen
// must wake the auth gate on another without remounting.
type Listener = (next: AuthCredentials | null) => void;
const listeners = new Set<Listener>();
let cached: AuthCredentials | null | undefined = undefined;
let inflightLoad: Promise<AuthCredentials | null> | null = null;

async function loadFromStorage(): Promise<AuthCredentials | null> {
  if (inflightLoad) return inflightLoad;
  inflightLoad = (async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<AuthCredentials> | null;
      if (!parsed || typeof parsed.baseUrl !== "string" || typeof parsed.token !== "string") {
        return null;
      }
      return { baseUrl: parsed.baseUrl, token: parsed.token };
    } catch {
      return null;
    } finally {
      inflightLoad = null;
    }
  })();
  return inflightLoad;
}

function broadcast(next: AuthCredentials | null) {
  cached = next;
  for (const listener of listeners) listener(next);
}

// True when `hostname` is a host on the user's own machine or a private
// network they control. Used to gate plaintext `http://` base URLs:
// iOS ATS is globally disabled (NSAllowsArbitraryLoads=true) so any
// http:// destination would otherwise transmit the bearer in cleartext.
// Recognised:
//   - loopback: `localhost`, `127.0.0.1`, `::1`
//   - RFC1918:  10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
//   - CGNAT:    100.64.0.0/10  (Tailscale's default address pool)
//   - mDNS:     any `*.local` host
// Anything else falls through as false — including TEST-NET ranges
// (e.g. 203.0.113.x) and public hosts.
export function isLocalGatewayHost(hostname: string): boolean {
  if (!hostname) return false;
  // WHATWG URL exposes IPv6 hostnames in bracket form (e.g. "[::1]"), but
  // the loopback literal in the allowlist below is bracket-less ("::1").
  // Strip a single surrounding pair so both shapes match.
  const host = hostname.toLowerCase().replace(/^\[(.+)\]$/, "$1");
  if (host === "localhost") return true;
  if (host === "127.0.0.1") return true;
  if (host === "::1") return true;
  // `.local` must be the trailing label so `my.local.evil.com` (where
  // `local` is just a label inside a public DNS name) doesn't match.
  if (host.endsWith(".local")) return true;
  const octets = host.split(".");
  if (octets.length !== 4) return false;
  const parsed: number[] = [];
  for (const part of octets) {
    if (part.length === 0 || part.length > 3) return false;
    if (!/^[0-9]+$/.test(part)) return false;
    const num = Number(part);
    if (!Number.isInteger(num) || num < 0 || num > 255) return false;
    parsed.push(num);
  }
  const [a, b] = parsed as [number, number, number, number];
  // 10.0.0.0/8
  if (a === 10) return true;
  // 172.16.0.0/12  (172.16.x – 172.31.x)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 100.64.0.0/10  (100.64.x – 100.127.x — Tailscale CGNAT range)
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

// Error surfaced when a plaintext `http://` base URL points at a host
// outside the local-network allowlist. Exposed so callers (e.g. api.ts'
// runtime guard) can reuse the exact wording.
export const PUBLIC_HTTP_REJECTION =
  "Gateway must use https:// or http:// to a local network host " +
  "(127.0.0.1, 10.x, 172.16-31.x, 192.168.x, 100.64-127.x, or *.local). " +
  "Public http:// would expose your bearer in plaintext.";

// Reduce a user-supplied base URL to scheme + host + port. The gateway
// accepts `?token=...` as an auth fallback, so a pasted URL like
// `http://host:7421?token=leaked` would otherwise be concatenated into
// every request and silently authenticate that way. Reject anything
// that doesn't parse so a malformed value can't be saved.
//
// Plaintext `http://` is restricted to the local-network allowlist
// because iOS ATS is globally disabled — a public http:// URL would
// ship the bearer in cleartext.
export function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Base URL is required.");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Invalid base URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Base URL must use http or https.");
  }
  if (parsed.protocol === "http:" && !isLocalGatewayHost(parsed.hostname)) {
    throw new Error(PUBLIC_HTTP_REJECTION);
  }
  return parsed.origin;
}

export async function saveCredentials(creds: AuthCredentials): Promise<void> {
  // Funnel all writes through normalizeBaseUrl so query strings, paths,
  // and trailing slashes can't sneak in via either connect flow (login or setup) or
  // a future re-save path.
  const normalized: AuthCredentials = {
    baseUrl: normalizeBaseUrl(creds.baseUrl),
    token: creds.token.trim()
  };
  // Detect a real credential SWAP (vs re-saving the same identity) BEFORE the
  // broadcast updates `cached`, so we only churn push state when the gateway/token
  // actually changed. `hadPrior` is captured here too: a swap that replaces an
  // existing identity must deregister the OLD device before `cached` is overwritten.
  const changed =
    !cached || cached.baseUrl !== normalized.baseUrl || cached.token !== normalized.token;
  const hadPrior = Boolean(cached);
  if (changed && hadPrior) {
    // Real swap: deregister the old device from the OLD gateway (tryDeregister
    // reads the still-cached old creds + token to DELETE /push/devices/:token, then
    // re-arms registration). MUST run before broadcast() overwrites `cached`, or the
    // DELETE would target the new gateway. Best-effort + bounded — never blocks the
    // swap. Without it the old gateway keeps a live device row and pushes stale
    // notifications to this device (the APNs token doesn't rotate on a swap, so the
    // old row never gets a 410 to prune it).
    await tryDeregisterCachedDevice();
  }
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  broadcast(normalized);
  // Mirror the gateway base URL + bearer into the App Group shared
  // container so the iOS Notification Service Extension can fetch the
  // notification preview on-device. Best-effort; the device token is
  // folded in later by push registration. Lazy require keeps the
  // auth → shared-credentials → react-native chain out of non-RN bundles.
  writeSharedCredentialsForAuth(normalized);
  // First-time sign-in (no prior creds, nothing to deregister): just re-arm push so
  // the new gateway gets a fresh registration. Without this the in-process "already
  // registered" guard in push.ts would suppress re-registration. The swap path above
  // already re-armed via tryDeregisterCachedDevice.
  if (changed && !hadPrior) resetPushRegistrationForSwap();
}

// Mirror credentials into the App Group shared container for the NSE.
// Lazy require (mirroring resetPushRegistrationForSwap) keeps the auth
// module free of a static react-native / expo-file-system import so
// non-RN test/web bundles that import auth.ts don't pull the native
// surface at load time. Best-effort: never throws into the auth flow.
function writeSharedCredentialsForAuth(creds: AuthCredentials): void {
  try {
    const shared = require("./shared-credentials") as {
      writeSharedCredentials?: (c: { baseUrl: string; token: string; deviceToken?: string }) => void;
    };
    // Fold in the cached device token when push registration already ran
    // for this credential, so a credential re-save doesn't drop it.
    const pushModule = require("./push") as { getCachedDeviceToken?: () => string | null };
    const deviceToken = pushModule.getCachedDeviceToken?.() ?? undefined;
    shared.writeSharedCredentials?.({
      baseUrl: creds.baseUrl,
      token: creds.token,
      deviceToken: deviceToken || undefined
    });
  } catch {
    // require can throw in non-RN envs — best effort.
  }
}

// Re-arm push registration after a credential swap. Lazy `require` (mirroring
// tryDeregisterCachedDevice) keeps the auth → push import graph acyclic and lets
// non-RN test/web bundles that never load push.ts skip this path entirely.
function resetPushRegistrationForSwap(): void {
  try {
    const pushModule = require("./push") as {
      resetRegistrationForCredentialSwap?: () => void;
    };
    pushModule.resetRegistrationForCredentialSwap?.();
  } catch {
    // require("./push") can throw in non-RN envs — best effort.
  }
}

export async function clearCredentials(): Promise<void> {
  // Best-effort deregister the cached APNs token from the gateway
  // before dropping the bearer. Without this the device row outlives
  // the sign-out — the user re-pairing with a different credential
  // would orphan the old row, and the next push for the old
  // credential would still wake this device. Failures are swallowed:
  // the sign-out itself must always succeed, and an orphaned row is
  // a recoverable annoyance (the gateway prunes on the next 410
  // Unregistered from APNs once the app uninstalls).
  await tryDeregisterCachedDevice();
  await AsyncStorage.removeItem(STORAGE_KEY);
  broadcast(null);
  // Drop the shared-container credentials so a backgrounded NSE can't keep
  // fetching previews with the signed-out bearer. Best-effort; lazy require
  // keeps non-RN bundles clean.
  try {
    const shared = require("./shared-credentials") as { clearSharedCredentials?: () => void };
    shared.clearSharedCredentials?.();
  } catch {
    // require can throw in non-RN envs — best effort.
  }
}

export async function tryDeregisterCachedDevice(): Promise<void> {
  try {
    // Lazy require: keeps the import graph free of an auth → push
    // cycle (push.ts imports api.ts which depends on cached
    // credentials), and lets tests / web bundles that never load
    // push.ts skip this path entirely.
    const pushModule = require("./push") as {
      getCachedDeviceToken?: () => string | null;
      awaitRegistrationInFlight?: () => Promise<void>;
      __resetRegistrationForSignOut?: () => void;
    };
    // Drain any in-flight registration before reading the cached
    // token. Without this wait, a sign-out that races a registration
    // POST would see cachedDeviceToken=null, skip the DELETE, and
    // leave an orphaned token alive on the gateway once the
    // registration's POST settles a moment later. Bounded by a 2s
    // timeout so a stuck network can't block sign-out indefinitely —
    // the registration's own generation guard will short-circuit any
    // late resolution that arrives after we bump.
    const inFlight = pushModule.awaitRegistrationInFlight?.();
    if (inFlight) {
      await Promise.race([
        inFlight,
        new Promise<void>((resolve) => setTimeout(resolve, 2000))
      ]);
    }
    const token = pushModule.getCachedDeviceToken?.();
    if (token) {
      const apiModule = require("./api") as {
        api: (path: string, init?: { method?: string }) => Promise<unknown>;
      };
      try {
        await apiModule.api(`/push/devices/${encodeURIComponent(token)}`, { method: "DELETE" });
      } catch {
        // 401 (already-invalid bearer), 404 (orphaned), or network
        // failure — log and continue; we still need to clear local
        // creds.
      }
    }
    // Reset the in-process registration guard so a sign-in with a
    // different credential rebuilds permission + token + POST. This
    // also bumps the generation counter so any registration work
    // that resolves after this point (e.g. a POST whose response
    // landed after our 2s race timed out) short-circuits its own
    // cache write.
    pushModule.__resetRegistrationForSignOut?.();
  } catch {
    // require("./push") can throw in non-RN test envs.
  }
}

export function useAuth(): AuthState & {
  save: (creds: AuthCredentials) => Promise<void>;
  clear: () => Promise<void>;
} {
  const [credentials, setCredentials] = useState<AuthCredentials | null>(
    cached ?? null
  );
  const [status, setStatus] = useState<"loading" | "ready">(
    cached === undefined ? "loading" : "ready"
  );

  useEffect(() => {
    let active = true;
    if (cached === undefined) {
      loadFromStorage().then((value) => {
        if (!active) return;
        cached = value;
        setCredentials(value);
        setStatus("ready");
      });
    } else {
      setCredentials(cached);
      setStatus("ready");
    }
    const listener: Listener = (next) => {
      if (!active) return;
      setCredentials(next);
    };
    listeners.add(listener);
    return () => {
      active = false;
      listeners.delete(listener);
    };
  }, []);

  const save = useCallback((creds: AuthCredentials) => saveCredentials(creds), []);
  const clear = useCallback(() => clearCredentials(), []);

  return useMemo(
    () => ({ status, credentials, save, clear }),
    [status, credentials, save, clear]
  );
}

// Read-only accessor for the fetcher in api.ts. The api() call has to be
// callable from React Query queryFn / mutationFn closures, so it can't
// take the credentials as an argument from every call site — instead it
// pulls them from this module's cache, which mirrors AsyncStorage.
export function readCachedCredentials(): AuthCredentials | null {
  return cached ?? null;
}

// Used by the auth-gate effect in the root layout to pre-warm the cache
// before the first render that depends on it.
export async function primeCredentials(): Promise<AuthCredentials | null> {
  if (cached !== undefined) return cached;
  const value = await loadFromStorage();
  cached = value;
  return value;
}

// Re-mirror the cached credentials into the App Group shared container on
// cold start. The shared container is otherwise written only on sign-in
// (saveCredentials) and after push registration — neither of which runs on
// a plain relaunch of an already-signed-in user who doesn't open a chat. An
// existing user (or anyone signed in before this feature shipped) would then
// have an empty container and the NSE would silently fall back to the generic
// banner. Call this from the root-layout prime sequence AFTER the device
// token has been primed so writeSharedCredentialsForAuth folds it in. No-op
// when signed out; best-effort (writeSharedCredentialsForAuth never throws).
export function mirrorCachedCredentialsToSharedContainer(): void {
  if (cached) writeSharedCredentialsForAuth(cached);
}

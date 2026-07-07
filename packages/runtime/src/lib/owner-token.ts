import { readFileSync, statSync } from "node:fs";
import { configPath } from "../paths";
import type { Instance } from "../types";

// Restore-aware owner-token resolution (hosted mode only).
//
// A hosted guest can be RESTORED from a shared Firecracker base snapshot: the
// base runtime is booted warm ONCE, snapshotted, and every tenant is resumed
// from that image. The base runtime already read and cached its config token
// before the snapshot was taken, but each tenant's real token is written into
// its own reflinked config.json AFTER the snapshot — so the cached base token
// would reject the tenant's bearer and break per-credential routes (the SSE
// chat stream most visibly). Restarting the runtime to re-read would forfeit
// the whole point of restore (a warm, already-listening runtime).
//
// Instead the auth gate resolves the owner token from config.json on demand,
// cached by mtime so the read happens at most once per identity swap. When the
// per-tenant config.json lands (a fresh mtime), the next request picks up the
// tenant token with no restart. Gated on GINI_HOSTED=1: the local single-user
// path keeps using the cached config.token verbatim, so its behavior and cost
// are unchanged.
let cache: { path: string; mtimeMs: number; token: string } | null = null;

export function currentOwnerToken(instance: Instance, fallback: string): string {
  if (process.env.GINI_HOSTED !== "1") return fallback;
  try {
    const path = configPath(instance);
    const { mtimeMs } = statSync(path);
    if (cache && cache.path === path && cache.mtimeMs === mtimeMs) return cache.token;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { token?: unknown };
    const token = typeof parsed.token === "string" && parsed.token.length > 0 ? parsed.token : fallback;
    cache = { path, mtimeMs, token };
    return token;
  } catch {
    // Missing/corrupt config.json during a swap window: fall back to the token
    // the runtime booted with rather than locking every caller out.
    return fallback;
  }
}

// Test seam only: drop the mtime cache so a test can simulate a fresh process.
export function _resetOwnerTokenCache(): void {
  cache = null;
}

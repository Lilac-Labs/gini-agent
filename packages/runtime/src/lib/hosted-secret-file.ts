import { readFileSync, statSync } from "node:fs";

// Restore-aware secret resolution for hosted guests (companion to owner-token.ts).
//
// A guest RESTORED from a shared base snapshot resumes with a FROZEN process.env
// (the base's placeholder secrets), so a per-tenant secret read from an env var
// — most importantly the model-router key the guest sends upstream — would stay
// the base value and every model call would fail account resolution at the edge.
//
// The in-guest identity agent writes the tenant's secret to a tmpfs FILE after
// restore (tmpfs, so there is no guest-page-cache staleness), and the runtime
// reads it here, cached by mtime. When `<ENV>_FILE` points at that file in
// hosted mode, its contents win over the frozen `process.env[<ENV>]`; otherwise
// (local, or no file configured) the env value is returned unchanged.
const caches = new Map<string, { mtimeMs: number; value: string }>();

export function hostedSecretFromFile(
  fileEnvVar: string,
  fallback: string | undefined
): string | undefined {
  if (process.env.GINI_HOSTED !== "1") return fallback;
  const path = process.env[fileEnvVar];
  if (!path) return fallback;
  try {
    const { mtimeMs } = statSync(path);
    const hit = caches.get(path);
    if (hit && hit.mtimeMs === mtimeMs) return hit.value;
    const value = readFileSync(path, "utf8").trim();
    if (!value) return fallback;
    caches.set(path, { mtimeMs, value });
    return value;
  } catch {
    return fallback;
  }
}

// Test seam only: drop the mtime caches so a test can simulate a fresh process.
export function _resetHostedSecretCache(): void {
  caches.clear();
}

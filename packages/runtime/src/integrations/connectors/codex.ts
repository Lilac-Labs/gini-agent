import { spawnSync } from "node:child_process";
import type { CodexCredentialProbe } from "../../provider";
import type { ProviderConfig } from "../../types";
import type { ProbeResult, ProviderModule } from "./types";

// Codex CLI provider. No managed secrets — auth lives in the codex CLI's
// auth.json (CODEX_AUTH_JSON-overridable, default ~/.codex/auth.json) or the
// OPENAI_API_KEY env var. The probe resolves credentials through the SAME
// path the codex model provider uses (probeCodexCredentials in
// src/provider.ts) so connector health can never disagree with what a chat
// turn would actually read, and it additionally decodes the OAuth access
// token's JWT `exp` claim locally — an already-expired token reports
// unhealthy with the expiry time instead of staying "healthy" on file
// presence alone (issue #233). No network calls: the probe must stay safe to
// run on the 30-minute re-probe cadence.

function which(bin: string): string | null {
  const r = spawnSync("which", [bin], { encoding: "utf8" });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  return null;
}

// PATH lookup used by probe/detect, exported for direct tests and replaceable
// so probe-level tests can pin both the found and not-found branches without
// depending on whether the host has codex installed.
export function whichBinary(bin: string): string | null {
  return which(bin);
}

let whichImpl: (bin: string) => string | null = whichBinary;

export function __setCodexWhichForTests(impl: ((bin: string) => string | null) | null): void {
  whichImpl = impl ?? whichBinary;
}

// ISO timestamp at which a probe's OAuth access token provably expired, or
// undefined when it is not provably expired: api_key-shaped credentials carry
// no exp, unparseable tokens are "expiry unknown" (decodeJwtExp already
// returns undefined for those), and a future exp is healthy. The single
// expiry threshold shared by the connector probe and the setup Verify gate —
// the two surfaces must never disagree about the same credential.
export function codexAccessTokenExpiredAt(
  creds: CodexCredentialProbe,
  nowMs: number
): string | undefined {
  if (typeof creds.accessTokenExp !== "number") return undefined;
  if (creds.accessTokenExp * 1000 > nowMs) return undefined;
  return new Date(creds.accessTokenExp * 1000).toISOString();
}

// Pure auth evaluation, shared by probe() and exercised directly in tests.
//
//   - usable OAuth token with a PAST JWT `exp` → not ok, message names the
//     expiry time and instructs `codex login` (re-auth is a terminal flow).
//   - usable OAuth token with a future / undecodable `exp` → ok. An
//     unparseable token means the expiry is UNKNOWN, not that the token is
//     bad — only the backend can decide that, and the probe makes no calls.
//   - api_key-shaped credentials carry no exp → presence-only ok.
//   - no usable file credentials but OPENAI_API_KEY in env → ok (the same
//     fallback the codex CLI itself honors).
//   - nothing anywhere → not ok with the resolver's own message (it names
//     the path it looked at).
export function evaluateCodexAuth(
  creds: CodexCredentialProbe,
  env: { OPENAI_API_KEY?: string },
  nowMs: number
): ProbeResult {
  if (creds.ok) {
    const expiredAt = codexAccessTokenExpiredAt(creds, nowMs);
    if (expiredAt) {
      return {
        ok: false,
        message: `Codex access token expired at ${expiredAt}. Run \`codex login\` to re-authenticate.`
      };
    }
    return { ok: true, message: `codex available; auth via ${creds.authPath}` };
  }
  if (env.OPENAI_API_KEY) {
    return { ok: true, message: "codex available; auth via OPENAI_API_KEY" };
  }
  return { ok: false, message: creds.message };
}

// Test seam for the transient-read retry delay below; null means "use the
// provider's CODEX_RETRY_REWRITE_DELAY_MS".
let retryDelayMsOverride: number | null = null;

export function __setCodexRetryDelayForTests(ms: number | null): void {
  retryDelayMsOverride = ms;
}

// Resolve credentials through the provider's own reader. Imported lazily:
// provider.ts → src/state → connectors/registry.ts → this module is a static
// cycle, and registry.ts touches `codexProvider` at module-eval time — a
// static import here would TDZ-crash any entry point that loads codex.ts
// first. probe/detect run long after startup, so the dynamic import is safe
// and resolves from the module cache after the first call.
//
// A `transient` failure means the read plausibly raced the codex CLI's
// non-atomic auth.json rewrite (truncate + write), so retry exactly once
// after the rewrite-settle delay — the same single-retry contract the chat
// path's withCodexSessionRetry applies. Without it, a re-probe or detect
// pass landing inside the rewrite window would report a fully-authenticated
// install as having no credentials.
async function readCredentialProbe(provider?: ProviderConfig): Promise<CodexCredentialProbe> {
  const { probeCodexCredentials, CODEX_RETRY_REWRITE_DELAY_MS } = await import("../../provider");
  const first = probeCodexCredentials(provider);
  if (first.ok || !first.transient) return first;
  await new Promise<void>((resolve) =>
    setTimeout(resolve, retryDelayMsOverride ?? CODEX_RETRY_REWRITE_DELAY_MS)
  );
  return probeCodexCredentials(provider);
}

export const codexProvider: ProviderModule = {
  id: "codex",
  label: "Codex",
  description: "Delegate coding work to the Codex CLI. No secrets stored — auth lives in your host install.",
  // Credential name so canonicalCredentialName resolves and skills with
  // `requires: connectors: codex` gate on this connector's health.
  credentialName: "codex",
  fields: [],
  async probe(ctx) {
    const path = whichImpl("codex");
    if (!path) return { ok: false, message: "codex not found on PATH." };
    // Thread the instance's configured provider through so a codex setup with
    // a custom apiKeyEnv auth-path probes the SAME file a chat turn reads —
    // codexAuthPath only honors apiKeyEnv when provider.name === "codex", so
    // a non-codex active provider (or a context without one) degrades to the
    // default CODEX_AUTH_JSON / ~/.codex/auth.json resolution.
    return evaluateCodexAuth(
      await readCredentialProbe(ctx.config?.provider),
      { OPENAI_API_KEY: process.env.OPENAI_API_KEY },
      Date.now()
    );
  },
  async detect() {
    // Detect when both the binary is on PATH AND at least one auth surface
    // exists (the codex CLI's auth.json via the provider's own resolution,
    // or the OPENAI_API_KEY env var). Without the auth check, a fresh
    // `codex` install would seed an unhealthy auto-connector that does
    // nothing useful. Expiry is deliberately NOT consulted here — an
    // expired token should still materialize the connector so its
    // unhealthy probe state is visible.
    const path = whichImpl("codex");
    if (!path) return { detected: false };
    const creds = await readCredentialProbe();
    const hasEnv = Boolean(process.env.OPENAI_API_KEY);
    if (!creds.ok && !hasEnv) {
      return { detected: false, message: `codex found at ${path} but no auth source.` };
    }
    const via = creds.ok ? creds.authPath : "OPENAI_API_KEY";
    return { detected: true, suggestedName: "Codex", message: `Found codex at ${path}; auth via ${via}.` };
  }
};

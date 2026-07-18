// Browser-facing setup endpoints.
//
// Onboarding used to be a terminal-only affair (`gini setup`). The
// current headline flow is "curl … | bash" → autostart → browser opens
// to /setup. The webapp's setup page calls these endpoints to read the
// current provider state and to write OpenAI / verify Codex creds.
//
// Behavior:
//   - GET /api/setup/status reflects the live provider config plus the
//     available picker options (SUPPORTED_PROVIDERS: openai, codex, openrouter,
//     deepseek, local, anthropic, bedrock, azure). `current` is the active
//     provider name when configured; null otherwise. `providerConfigured` is
//     true when the active provider has valid creds — same definition
//     `providerHealth` uses.
//   - POST /api/setup/provider accepts {provider, apiKey?, model?, baseUrl?}
//     for the env-keyed providers (openai/openrouter/deepseek/local/anthropic/
//     azure) — plus apiVersion/deployment/authScheme for azure's
//     deployment-scoped routing; {provider: "bedrock", model?, awsRegion?,
//     awsAccessKeyId?, awsSecretAccessKey?}, which SigV4-signs with the entered
//     AWS keys (written to secrets.env under the AWS_* names); or
//     {provider: "codex"}. An env-keyed flow writes the key to
//     ~/.gini/secrets.env (under the provider's apiKeyEnv) and updates
//     process.env so the running gateway picks it up on the very next provider
//     call (no restart needed — readOpenAIBearer in src/provider.ts reads from
//     env on each call). The runtime config is rewritten to the chosen provider
//     so status calls reflect the new active provider. The field is named
//     `provider` (not `kind`) to match the CLI surface — `gini provider
//     set <name>` already uses this terminology. Note: this is the model
//     provider, distinct from the connector provider concept introduced by ADR
//     connector-provider-spec-compliance.md.
//
// What this DOES do for plist refresh: when an OpenAI key is written
// and a gateway plist exists on disk, this module calls
// requestAutostartRefresh (src/runtime/autostart-refresh.ts), which
// writes a marker file and self-signals SIGTERM. The gateway's SIGTERM
// handler then drains in-flight responses, consumes the marker, and
// execs a detached `gini autostart enable --kind gateway` as the last
// thing before process.exit(0). That child re-registers the plist
// with fresh EnvironmentVariables read from secrets.env.
//
// The hand-off goes via marker + SIGTERM rather than a direct
// in-process spawn for two reasons: (1) we need Bun's `server.stop`
// drain to finish writing this very response before launchctl
// bootouts the gateway, and (2) the in-process gate in
// autostart-refresh.ts ensures only self-signaled SIGTERMs trigger a
// respawn — an external `gini stop` must NOT bring the gateway back.
// We keep the module API-thin: no shelling out from the request
// handler itself; the actual launchctl interaction is the detached
// child's responsibility.

import { writeRuntimeConfig } from "../paths";
import { anthropicNeedsHttps, azureNeedsBaseUrl, azureNeedsHttps, CODEX_RETRY_REWRITE_DELAY_MS, hasUsableAwsCredentials, hasUsableCodexCredentials, isValidAwsRegion, normalizeProvider, probeCodexCredentials, providerCatalog, providerHealth, resolveDispatchProvider } from "../provider";
import { codexAccessTokenExpiredAt } from "../integrations/connectors/codex";
import { clearProviderAuthFailureIfPresent } from "../state";
import { isValidEnvVarName, removeKeyFromSecretsEnv, writeKeyToSecretsEnv } from "../state/secrets-env";
import { requestAutostartRefresh } from "./autostart-refresh";
import type { ProviderConfig, ProviderName, RuntimeConfig } from "../types";

const SUPPORTED_PROVIDERS = ["openai", "codex", "openrouter", "deepseek", "local", "anthropic", "bedrock", "azure"] as const;
type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

// Env-keyed providers that authenticate via an env var written to
// ~/.gini/secrets.env. `local` allows an empty key because many local
// gateways (Ollama, LM Studio) accept no-auth requests. Codex is excluded
// because it uses its own OAuth/auth.json flow. `anthropic` is env-keyed but
// speaks the native Messages API, not an OpenAI-compatible surface. `azure` is
// the Azure OpenAI resource key (api-key header by default); it additionally
// requires a per-resource baseUrl, enforced by the azureNeeds* guards below.
// (bedrock is NOT here — it stores an AWS access key + secret under two fixed
// names via its own branch, not the single-envVar shape this map models.)
const ENV_KEY_PROVIDERS: Record<string, { envVar: string; allowEmptyKey: boolean; defaultModel: string }> = {
  openai: { envVar: "OPENAI_API_KEY", allowEmptyKey: false, defaultModel: "gpt-5.4-mini" },
  openrouter: { envVar: "OPENROUTER_API_KEY", allowEmptyKey: false, defaultModel: "openrouter/auto" },
  deepseek: { envVar: "DEEPSEEK_API_KEY", allowEmptyKey: false, defaultModel: "deepseek-v4-flash" },
  local: { envVar: "GINI_LOCAL_API_KEY", allowEmptyKey: true, defaultModel: "local/default" },
  // First-party Anthropic Messages API key.
  anthropic: { envVar: "ANTHROPIC_API_KEY", allowEmptyKey: false, defaultModel: "claude-opus-4-8" },
  azure: { envVar: "AZURE_OPENAI_API_KEY", allowEmptyKey: false, defaultModel: "gpt-5.5" }
};

export interface SetupStatus {
  ok: true;
  providerConfigured: boolean;
  providers: SupportedProvider[];
  current: string | null;
  // The user's SELECTED active provider (config.provider.name). Equals
  // `current`; surfaced under a stable name so the fallback fields read
  // unambiguously alongside `activeProvider`.
  selectedProvider: string | null;
  // The provider actually dispatching turns — the selected one when it's
  // configured, otherwise the transient fallback resolveDispatchProvider picks.
  activeProvider: string | null;
  // True when the selected provider is unconfigured but a real configured
  // fallback is serving turns. The web reads this to show the "finish setup"
  // banner; providerConfigured stays true so the /setup gate doesn't fire.
  usingFallback: boolean;
  // Echoed from providerHealth so the browser knows why setup is needed
  // (e.g. "Set OPENAI_API_KEY to use the openai provider").
  message: string;
}

export function getSetupStatus(config: RuntimeConfig): SetupStatus {
  const health = providerHealth(config);
  const current = typeof config.provider?.name === "string" ? config.provider.name : null;
  // Echo is "configured" in the providerHealth sense (no creds needed)
  // but it's a stub that does nothing useful — it's not a valid choice
  // for browser onboarding. Anyone on echo needs to pick a real
  // provider in /setup. Other configured providers (openai with key,
  // codex with auth.json) pass through.
  const isRealProvider = current === "openai" || current === "codex" || current === "openrouter" || current === "local" || current === "deepseek" || current === "anthropic" || current === "bedrock" || current === "azure";
  // A graceful, transient fallback (the selected provider is unconfigured but
  // another real one is) keeps the app usable instead of bouncing to /setup:
  // resolveDispatchProvider returns usingFallback when a configured fallback
  // exists. providerConfigured is what the proxy setup gate reads, so it must
  // be true whenever turns can actually dispatch — directly OR via fallback —
  // and only flips false→true when a REAL fallback exists (genuinely
  // unconfigured instances still drive /setup, preserving the fail-open gate).
  const dispatch = resolveDispatchProvider(config);
  const usingFallback = dispatch.usingFallback;
  const providerConfigured = isRealProvider && (Boolean(health.configured) || usingFallback);
  return {
    ok: true,
    providerConfigured,
    providers: [...SUPPORTED_PROVIDERS],
    current,
    selectedProvider: current,
    activeProvider: usingFallback ? dispatch.provider.name : current,
    usingFallback,
    message: typeof health.message === "string" ? health.message : ""
  };
}

export interface SetSetupProviderResult {
  ok: boolean;
  provider: ReturnType<typeof providerHealth>;
  // True when a future-respawn plist refresh is needed. The CLI layer
  // listens on this hint (in admin / provider commands) to re-run
  // `autostart enable` so the new key lands in EnvironmentVariables
  // for the next launchd respawn. The running gateway already has the
  // new key in env so this round-trip is purely about surviving the
  // next plist start.
  plistRefreshNeeded: boolean;
  error?: string;
}

export async function setSetupProvider(
  config: RuntimeConfig,
  payload: Record<string, unknown>,
  // clearAuthFailureOnSuccess (default true): a successful write normally
  // drops the provider's needs-reauth record (issue #233). Selection-only
  // callers (setDefaultModel) opt out — a model pick proves nothing about
  // the credential.
  options?: { clearAuthFailureOnSuccess?: boolean }
): Promise<SetSetupProviderResult> {
  // Field name is `provider` to match the CLI (`gini provider set ...`).
  const providerName = typeof payload.provider === "string" ? payload.provider : "";
  if (!SUPPORTED_PROVIDERS.includes(providerName as SupportedProvider)) {
    return {
      ok: false,
      provider: providerHealth(config),
      plistRefreshNeeded: false,
      error: `Unsupported provider '${providerName}'. Allowed: ${SUPPORTED_PROVIDERS.join(", ")}.`
    };
  }
  const envKeySpec = ENV_KEY_PROVIDERS[providerName];
  if (envKeySpec) {
    // Resolve the env var this config actually reads from: for an edit of the
    // already-active provider, honor its configured apiKeyEnv (e.g. a CLI-set
    // custom var); otherwise the canonical default. Routing the "already set?"
    // probe, the key write, and the preserved apiKeyEnv all through one
    // targetEnvVar keeps write-target == stored-config == read-source, so a
    // custom-apiKeyEnv provider can be edited/rotated from the web without
    // being rejected or silently flipped back to the canonical var.
    const existing = config.provider?.name === providerName ? config.provider : undefined;
    const targetEnvVar = existing?.apiKeyEnv ?? envKeySpec.envVar;
    const apiKey = typeof payload.apiKey === "string" ? payload.apiKey.trim() : "";
    // On a same-provider edit, preserve transport config the caller didn't
    // resend. A partial caller — the Settings model picker or the set_provider
    // tool — posts only { provider, model? }, so without this fallback a
    // model-only save would wipe a configured baseUrl, apiKeyEnv, and the Azure
    // routing fields (apiVersion / deployment / authScheme). A provider SWITCH
    // (different name) starts clean — `existing` is undefined — matching the
    // cross-provider non-inheritance rule resolveEffectiveContext enforces.
    // A persisted apiKeyEnv flows into the secrets.env writer; reject a
    // malformed name (it would otherwise be caught by the writer's guard and
    // surface as an unhandled 500) rather than try to write it.
    if (!isValidEnvVarName(targetEnvVar)) {
      return {
        ok: false,
        provider: providerHealth(config),
        plistRefreshNeeded: false,
        error: `The configured apiKeyEnv (${targetEnvVar}) is not a valid environment variable name.`
      };
    }
    // Accept a no-key payload when the env var is already set — the Edit
    // Provider dialog uses this to update the model or transport config (base
    // URL, Azure routing) without re-typing the key. Initial Add still requires
    // a key because the env var is empty there.
    const envAlreadySet = Boolean(process.env[targetEnvVar]);
    if (!apiKey && !envKeySpec.allowEmptyKey && !envAlreadySet) {
      return {
        ok: false,
        provider: providerHealth(config),
        plistRefreshNeeded: false,
        error: `apiKey is required for the ${providerName} provider.`
      };
    }
    // Field resolution: a key PRESENT in the payload (even blank) is applied,
    // with blank clearing the field; a key ABSENT preserves the existing value.
    // The full web Edit form posts every transport field (blank = clear), while
    // a partial { provider, model } save preserves transport config it didn't
    // resend. normalizeProvider carries apiVersion/deployment/authScheme only
    // for the azure provider, so they are inert for everyone else.
    const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(payload, key);
    const trimmedString = (value: unknown): string | undefined =>
      typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
    const model = typeof payload.model === "string" && payload.model.length > 0
      ? payload.model
      : (existing?.model || envKeySpec.defaultModel);
    const baseUrl = has("baseUrl") ? trimmedString(payload.baseUrl) : existing?.baseUrl;
    const apiVersion = has("apiVersion") ? trimmedString(payload.apiVersion) : existing?.apiVersion;
    const deployment = has("deployment") ? trimmedString(payload.deployment) : existing?.deployment;
    const authScheme = has("authScheme")
      ? (payload.authScheme === "api-key" || payload.authScheme === "bearer" ? payload.authScheme : undefined)
      : existing?.authScheme;
    // Preserve a custom apiKeyEnv (set via `gini provider set --api-key-env`)
    // and a CLI-set extraBody across a same-provider edit; no web surface sends
    // them, so a model-only save must not silently drop them.
    const apiKeyEnv = existing?.apiKeyEnv;
    const extraBody = existing?.extraBody;

    // Azure needs a real https resource endpoint. Reject BEFORE persisting the
    // key so we never half-apply an impossible config whose deployment URL
    // would fail. Covers the set_provider tool too, which funnels through here.
    // Both guards no-op for non-azure providers.
    if (azureNeedsBaseUrl(providerName, baseUrl)) {
      return {
        ok: false,
        provider: providerHealth(config),
        plistRefreshNeeded: false,
        error: "Azure OpenAI requires a baseUrl of https://<resource>.openai.azure.com."
      };
    }
    if (azureNeedsHttps(providerName, baseUrl)) {
      return {
        ok: false,
        provider: providerHealth(config),
        plistRefreshNeeded: false,
        error: "Azure OpenAI requires an https:// endpoint (the credential is sent on every request)."
      };
    }
    // anthropic sends its API key on every request, so refuse a plaintext custom
    // baseUrl (loopback proxies excepted). No-op for non-anthropic providers.
    if (anthropicNeedsHttps(providerName, baseUrl)) {
      return {
        ok: false,
        provider: providerHealth(config),
        plistRefreshNeeded: false,
        error: "The anthropic provider requires an https:// baseUrl (the API key is sent on every request). Use http only for a localhost proxy."
      };
    }

    if (apiKey) {
      // Persist to secrets.env so the wrapper-sourced env carries it on
      // future shell launches. The shared writer lives in src/state/ —
      // both CLI and runtime are allowed to depend on src/state/.
      writeKeyToSecretsEnv(targetEnvVar, apiKey);
      // Make the running gateway use the new key on its very next
      // provider call. readOpenAIBearer reads process.env on each call,
      // so this assignment is enough — no restart needed.
      process.env[targetEnvVar] = apiKey;
    }

    config.provider = normalizeProvider({
      name: providerName as ProviderConfig["name"],
      model,
      ...(baseUrl ? { baseUrl } : {}),
      ...(apiKeyEnv ? { apiKeyEnv } : {}),
      ...(extraBody ? { extraBody } : {}),
      ...(apiVersion ? { apiVersion } : {}),
      ...(deployment ? { deployment } : {}),
      ...(authScheme ? { authScheme } : {})
    });
    writeRuntimeConfig(config);

    // A key-carrying write supersedes any persistent needs-reauth record —
    // a rotated key is the user re-establishing the credential (issue #233).
    // A keyless edit (the dialog leaves the key field blank to keep the saved
    // key, so a model/baseUrl-only save reaches here) proves nothing about
    // the credential and must NOT clear, or the amber row flips back to a
    // stale "Connected" on the same dead key — mirrors the set_provider
    // self-tool gate. The next provider call re-records if it still fails.
    // Cleared BEFORE the plist-refresh SIGTERM below so the write can't be
    // lost to the restart.
    if (options?.clearAuthFailureOnSuccess !== false && apiKey) {
      await clearProviderAuthFailureIfPresent(config.instance, providerName as ProviderName, {
        reason: "provider configuration updated"
      });
    }

    // Request plist refresh via a marker file + SIGTERM. A simpler
    // approach (setImmediate → setTimeout(200ms) → detached spawn)
    // would be a heuristic — a slow client could still be mid-read
    // when launchctl bootouts the gateway, breaking the user's POST
    // response mid-flush. Hooking the actual response lifecycle
    // instead: we self-signal SIGTERM so Bun's `server.stop(false)`
    // drains in-flight responses (including this one) before our
    // SIGTERM handler reads the marker and execs the refresh as the
    // very last thing on the way out. See
    // src/runtime/autostart-refresh.ts.
    const refreshed = apiKey ? requestAutostartRefresh(config.instance) : false;

    return {
      ok: true,
      provider: providerHealth(config),
      plistRefreshNeeded: refreshed
    };
  }
  if (providerName === "bedrock") {
    // Bedrock signs each Converse request with AWS SigV4 over the user's AWS
    // access key + secret. Gini does NOT read ~/.aws — the keys are entered here
    // and written to ~/.gini/secrets.env under the standard AWS_* names, exactly
    // like the env-keyed providers persist their bearer. Config holds only model
    // + region.
    const existing = config.provider?.name === "bedrock" ? config.provider : undefined;
    const trimmedSecret = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
    const awsAccessKeyId = trimmedSecret(payload.awsAccessKeyId);
    const awsSecretAccessKey = trimmedSecret(payload.awsSecretAccessKey);
    // Reject a half-entered pair (one field filled, the other blank) before the
    // "need keys" gate: a user who filled exactly one field clearly meant to
    // enter credentials and botched it — don't let it silently fall back to a
    // previously-stored key or to the generic "enter your keys" message.
    if ((awsAccessKeyId.length > 0) !== (awsSecretAccessKey.length > 0)) {
      return {
        ok: false,
        provider: providerHealth(config),
        plistRefreshNeeded: false,
        error: "Enter BOTH the AWS Access Key ID and the Secret Access Key (or leave both blank to keep the saved credentials)."
      };
    }
    // The access key + secret are required unless usable AWS credentials already
    // resolve from the environment — whether from a prior add (the common case:
    // a model/region-only edit shouldn't force a re-type) or from ambient AWS_*
    // vars the user exported in their shell. Mirrors the env-keyed branch's
    // envAlreadySet check; the gate is purely "are creds present?", not
    // same-provider status.
    const credsResolveNow = hasUsableAwsCredentials();
    const hasNewPair = awsAccessKeyId.length > 0 && awsSecretAccessKey.length > 0;
    if (!hasNewPair && !credsResolveNow) {
      return {
        ok: false,
        provider: providerHealth(config),
        plistRefreshNeeded: false,
        error:
          "Enter your AWS Access Key ID and Secret Access Key to use the bedrock provider."
      };
    }
    const model = typeof payload.model === "string" && payload.model.length > 0
      ? payload.model
      : existing?.model;
    // Present-clears, like the env-keyed transport fields: a blank awsRegion in
    // the payload CLEARS the region (the host then resolves from AWS_REGION /
    // AWS_DEFAULT_REGION / the us-east-1 default), while an OMITTED awsRegion
    // preserves the existing one so a partial { provider, model } save from the
    // model picker or set_provider tool doesn't silently reset it.
    const awsRegion = Object.prototype.hasOwnProperty.call(payload, "awsRegion")
      ? (typeof payload.awsRegion === "string" && payload.awsRegion.trim().length > 0 ? payload.awsRegion.trim() : undefined)
      : existing?.awsRegion;
    // The region lands in the Converse request host, so reject a malformed one
    // here (the self-tool can supply it) before it ever persists.
    if (awsRegion !== undefined && !isValidAwsRegion(awsRegion)) {
      return {
        ok: false,
        provider: providerHealth(config),
        plistRefreshNeeded: false,
        error: `awsRegion is invalid: '${awsRegion}' (must match /^[a-z0-9-]+$/, e.g. us-east-1).`
      };
    }
    // Persist a freshly-entered key pair to secrets.env (so future shell launches
    // carry it) and into process.env (so the running gateway signs with it on the
    // very next call — resolveAwsCredentials reads process.env each time).
    if (hasNewPair) {
      writeKeyToSecretsEnv("AWS_ACCESS_KEY_ID", awsAccessKeyId);
      writeKeyToSecretsEnv("AWS_SECRET_ACCESS_KEY", awsSecretAccessKey);
      process.env.AWS_ACCESS_KEY_ID = awsAccessKeyId;
      process.env.AWS_SECRET_ACCESS_KEY = awsSecretAccessKey;
    }
    config.provider = normalizeProvider({
      name: "bedrock",
      model: model ?? "",
      ...(awsRegion ? { awsRegion } : {}),
      // Preserve a CLI-set extraBody across an edit/save (no web surface sends it,
      // so a model-only save must not silently drop it).
      ...(existing?.extraBody ? { extraBody: existing.extraBody } : {})
    });
    writeRuntimeConfig(config);
    // A key-carrying write supersedes the needs-reauth record — re-entering the
    // access key + secret is the user re-establishing the credential. Gate on
    // hasNewPair, mirroring the env-keyed branch's `&& apiKey`: a keyless
    // model/region edit proves nothing about the credential (hasUsableAwsCredentials
    // checks presence, not validity), so a dead-but-present key would otherwise
    // flip the amber row back to a stale "Connected". Cleared BEFORE the plist
    // refresh so the write can't be lost to the restart.
    if (options?.clearAuthFailureOnSuccess !== false && hasNewPair) {
      await clearProviderAuthFailureIfPresent(config.instance, "bedrock", {
        reason: "provider configuration updated"
      });
    }
    // A key write must survive the next launchd respawn — refresh the plist so
    // the new AWS_* values land in EnvironmentVariables (same hand-off the
    // env-keyed branch uses). No refresh on a keyless model/region edit.
    const refreshed = hasNewPair ? requestAutostartRefresh(config.instance) : false;
    return { ok: true, provider: providerHealth(config), plistRefreshNeeded: refreshed };
  }
  // providerName === "codex"
  // Pin the provider across the retry: the 50ms wait is a real macrotask, so
  // a concurrent provider switch could otherwise make the retry resolve a
  // different auth file (apiKeyEnv) than the first attempt — the same
  // resolved-at-entry pinning the connector probe and call attribution use.
  const verifyProvider = config.provider;
  let codexProbe = probeCodexCredentials(verifyProvider);
  if (!codexProbe.ok && codexProbe.transient) {
    // Mid-rewrite torn read of auth.json — same single-retry contract as the
    // connector probe (readCredentialProbe) and the chat path's
    // withCodexSessionRetry, so Verify can't falsely report "not found" to a
    // fully-authenticated user (or an unattended set_provider flow) that
    // raced the codex CLI's non-atomic rewrite.
    await new Promise<void>((resolve) => setTimeout(resolve, CODEX_RETRY_REWRITE_DELAY_MS));
    codexProbe = probeCodexCredentials(verifyProvider);
  }
  if (!codexProbe.ok) {
    return {
      ok: false,
      provider: providerHealth(config),
      plistRefreshNeeded: false,
      error: "Codex credentials not found. Run `codex login` in your terminal, then retry."
    };
  }
  // Presence is not enough to Verify: the runtime can decode the OAuth JWT's
  // exp locally (zero network), and the connector probe already reports an
  // expired token as unhealthy — a button named "Verify" must not bless the
  // very credential the probe calls dead, or the amber row flips back to a
  // stale "Connected" until the next failed turn. api_key-shaped and
  // exp-unknown credentials stay presence-only (no exp to consult).
  const codexExpiredAt = codexAccessTokenExpiredAt(codexProbe, Date.now());
  if (codexExpiredAt) {
    return {
      ok: false,
      provider: providerHealth(config),
      plistRefreshNeeded: false,
      error: `Codex access token expired at ${codexExpiredAt}. Run \`codex login\` to re-authenticate, then retry.`
    };
  }
  const codexCatalog = providerCatalog().find((p) => p.id === "codex");
  const existingCodex = config.provider?.name === "codex" ? config.provider : undefined;
  const model = typeof payload.model === "string" && payload.model.length > 0
    ? payload.model
    : (existingCodex?.model ? existingCodex.model : codexCatalog?.models[0] ?? "gpt-5.5");
  // Preserve a same-provider apiKeyEnv (a CODEX_AUTH_JSON-style path env) and
  // baseUrl across the write: the Verify gate above probed THROUGH that
  // resolution, so dropping it would sever the very credential source just
  // validated — and then clear the amber record on the strength of a config
  // that now points somewhere unprobed. Mirrors the env-keyed and bedrock
  // branches' preservation of CLI-set fields a web save never carries.
  config.provider = normalizeProvider({
    name: "codex",
    model,
    ...(existingCodex?.apiKeyEnv ? { apiKeyEnv: existingCodex.apiKeyEnv } : {}),
    ...(existingCodex?.baseUrl ? { baseUrl: existingCodex.baseUrl } : {})
  } as ProviderConfig);
  writeRuntimeConfig(config);
  // The gate above passed — credentials are present AND not provably expired
  // (locally-decoded JWT exp) — so the user has (re-)established codex
  // credentials; this is the setup Verify seam. Clear the needs-reauth
  // record; the next codex call re-records if the token is still dead.
  if (options?.clearAuthFailureOnSuccess !== false) {
    await clearProviderAuthFailureIfPresent(config.instance, "codex", {
      reason: "provider configuration updated"
    });
  }
  // Codex switching DOES require a plist refresh: the gateway's config.json
  // is the source of truth for which provider it boots with, and that's
  // already updated. But the plist still has GINI_INSTANCE etc — no env
  // change. The reason to refresh is if a prior openai run wrote
  // OPENAI_API_KEY into the plist env and the user has now switched to
  // codex; the stale key is harmless (codex ignores it). So we skip the
  // refresh on codex.
  return {
    ok: true,
    provider: providerHealth(config),
    plistRefreshNeeded: false
  };
}

export interface RemoveSetupProviderResult {
  ok: boolean;
  provider: ReturnType<typeof providerHealth>;
  // True when removal flipped the gateway off the named provider, so the
  // active row in /api/status now reflects whatever we fell back to.
  switched: boolean;
  error?: string;
}

// Disconnect a provider that holds a gini-managed secret: scrub it from
// process.env + secrets.env, and, when removing the currently-active provider,
// fall back to codex if codex auth is available so the gateway stays usable.
// Codex itself isn't removable through the UI because ~/.codex/auth.json
// is owned by the `codex` CLI — the user manages it via codex logout.
// Local has no key to remove; the gate below mirrors that. Bedrock is removable
// because gini now stores its AWS access key + secret — disconnect must be able
// to scrub them.
export async function removeSetupProvider(
  config: RuntimeConfig,
  providerName: string
): Promise<RemoveSetupProviderResult> {
  if (providerName === "codex") {
    return {
      ok: false,
      provider: providerHealth(config),
      switched: false,
      error: "Codex is managed by the codex CLI. Run `codex logout` to sign out."
    };
  }
  // Set of secrets.env / process.env vars this removal must scrub.
  const scrubVars = new Set<string>();
  if (providerName === "bedrock") {
    // Bedrock holds the AWS access key + secret gini wrote on add — scrub both.
    scrubVars.add("AWS_ACCESS_KEY_ID");
    scrubVars.add("AWS_SECRET_ACCESS_KEY");
  } else {
    const envKeySpec = ENV_KEY_PROVIDERS[providerName];
    if (!envKeySpec || providerName === "local") {
      return {
        ok: false,
        provider: providerHealth(config),
        switched: false,
        error: `Cannot remove provider '${providerName}'.`
      };
    }
    // Wipe the bearer from both stores so the running process and future shell
    // launches stop seeing it. Scrub the env var the active config actually used
    // (a custom apiKeyEnv like AZURE_OPENAI_API_KEY) as well as the provider
    // default — the write path stores the key under `apiKeyEnv ?? envKeySpec.envVar`,
    // so disconnect must clear the same target or the secret survives.
    scrubVars.add(envKeySpec.envVar);
    if (config.provider?.name === providerName && config.provider.apiKeyEnv && isValidEnvVarName(config.provider.apiKeyEnv)) {
      scrubVars.add(config.provider.apiKeyEnv);
    }
  }
  // removeKeyFromSecretsEnv / delete are no-ops when the var is already absent.
  for (const envVar of scrubVars) {
    removeKeyFromSecretsEnv(envVar);
    delete process.env[envVar];
  }

  // The credential is gone — a stale needs-reauth record would otherwise
  // survive the disconnect and resurface as soon as the provider is re-added.
  await clearProviderAuthFailureIfPresent(config.instance, providerName as ProviderName, {
    reason: "provider removed"
  });

  let switched = false;
  if (config.provider?.name === providerName) {
    // The instance was using this provider — falling back to codex when
    // its OAuth is on disk keeps the gateway in a working state. Otherwise
    // we drop to echo, which is harmless (deterministic stub) and at least
    // doesn't crash on the next call.
    if (hasUsableCodexCredentials()) {
      const codexCatalog = providerCatalog().find((p) => p.id === "codex");
      config.provider = normalizeProvider({
        name: "codex",
        model: codexCatalog?.models[0] ?? "gpt-5.5"
      } as ProviderConfig);
    } else {
      config.provider = normalizeProvider({ name: "echo", model: "gini-echo-v0" });
    }
    writeRuntimeConfig(config);
    switched = true;
  }

  return {
    ok: true,
    provider: providerHealth(config),
    switched
  };
}

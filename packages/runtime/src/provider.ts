import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { buildAgentSystemContext, renderEphemeralContext } from "./system-prompt";
import { hostedSecretFromFile } from "./lib/hosted-secret-file";
import { loadInstructions, loadSoul, loadUserProfile } from "./runtime/identity-files";
import { readState } from "./state";
import { appendTrace } from "./state/trace";
import { bedrockSupportsStreamingWithTools, bedrockSupportsToolUse, claudeSupportsFineGrainedToolStreaming, estimateUsd, FALLBACK_MAX_OUTPUT_TOKENS, resolveMaxOutputTokens, resolveProviderContextWindowTokens, resolveProviderModality } from "./provider-capabilities";
import { estimateTextTokens, estimateToolCallingMessagesTokens } from "./execution/context-window";
import { resolveAwsCredentials, signAwsRequest } from "./aws-sigv4";
import { anthropicMirrorModelId } from "./model-routes";
import type { CostRecord, ProviderAuthFailureRecord, ProviderAuthStatus, ProviderCatalogItem, ProviderConfig, ProviderName, ProviderReauthInfo, ProviderResult, RuntimeConfig, SystemNoteAuthError } from "./types";

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
const DEFAULT_CODEX_MODEL = "gpt-5.5";
const DEFAULT_CODEX_AUTH_PATH = "~/.codex/auth.json";
const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";
const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash";
// Anthropic Messages API (first-party Claude). The default baseUrl is the bare
// host (no /v1) — callAnthropicMessages appends /v1/messages. Auth is the
// ANTHROPIC_API_KEY (sk-ant…) in the x-api-key header. Amazon Bedrock is a
// SEPARATE provider (`bedrock`) that speaks the same Messages wire shape but
// signs with AWS SigV4; see the bedrock constants below.
const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const DEFAULT_ANTHROPIC_MODEL = "claude-opus-4-8";
// Amazon Bedrock via the model-agnostic Converse API. The `bedrock` provider is
// NOT Anthropic-specific: Converse (`bedrock-runtime.{region}.amazonaws.com`,
// SigV4 service "bedrock") speaks one request/response shape across every
// Bedrock model family — Claude, Amazon Nova, Meta Llama, Mistral, DeepSeek, …
// It signs with the AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (and optional
// AWS_SESSION_TOKEN) the user enters when adding the provider; those are stored
// in ~/.gini/secrets.env, not read from ~/.aws. The model id is a cross-region
// inference-profile id (e.g. "us.amazon.nova-pro-v1:0") sent verbatim in the
// request path.
const DEFAULT_BEDROCK_REGION = "us-east-1";
const DEFAULT_BEDROCK_MODEL = "us.anthropic.claude-opus-4-8";
function bedrockRuntimeBaseUrl(region: string): string {
  return `https://bedrock-runtime.${region}.amazonaws.com`;
}
const DEFAULT_BEDROCK_BASE_URL = bedrockRuntimeBaseUrl(DEFAULT_BEDROCK_REGION);
// Pinned API version sent on every Messages request. Verified current on the
// live versioning docs (newest entry; the SSE-named-events format). Honored by
// both the first-party API and Claude in Amazon Bedrock.
const ANTHROPIC_VERSION = "2023-06-01";
// Anthropic beta flag that enables fine-grained tool streaming (tool_use input
// JSON streamed incrementally instead of buffered whole). Carried two different
// ways depending on the send path: the first-party Anthropic Messages path
// sends it as the HTTP `anthropic-beta` request header (callAnthropicMessages),
// while the Bedrock Converse path carries it as an `anthropic_beta` entry inside
// the `additionalModelRequestFields` body object (callBedrockConverse) — Bedrock
// takes no HTTP beta header. See the Anthropic "fine-grained tool streaming"
// docs and the AWS Bedrock "Anthropic Claude tool use" docs.
const FINE_GRAINED_TOOL_STREAMING_BETA = "fine-grained-tool-streaming-2025-05-14";
// The Messages API REQUIRES max_tokens. The streaming send-path resolves the
// model's real output ceiling via resolveMaxOutputTokens so a large tool-call
// argument isn't truncated mid-JSON; this flat floor is the NON-streaming
// budget (structured output) and the fallback when no model-specific ceiling
// resolves. A non-streaming request with a large max_tokens trips the
// first-party Anthropic "streaming is required for long requests" guard, so the
// non-streaming path must stay small. Vision passes its own smaller per-call
// budget via maxTokensOverride. Re-exported from provider-capabilities as
// FALLBACK_MAX_OUTPUT_TOKENS so the two stay in lockstep.
const DEFAULT_ANTHROPIC_MAX_TOKENS = FALLBACK_MAX_OUTPUT_TOKENS;
// Azure OpenAI has no universal base URL — it is per-resource
// (https://<resource>.openai.azure.com), so there is no default and a config
// without one is rejected at the entry boundaries (CLI / setup API /
// set_provider tool). The default model matches the azure catalog's first
// model so the no-model default agrees with the UI's pre-selected model (the
// same `default == models[0]` invariant every other provider keeps); deployment
// names on most resources match the model id.
const DEFAULT_AZURE_MODEL = "gpt-5.5";
// Default Azure data-plane api-version. 2024-10-21 is the latest dated GA for
// deployment-scoped chat completions and is universally supported across
// regions and SDKs (per learn.microsoft.com Azure OpenAI reference). Defaulted
// so an azure config needs only a base URL + key to route correctly.
const DEFAULT_AZURE_API_VERSION = "2024-10-21";

export function providerHealth(config: RuntimeConfig) {
  const provider = normalizeProvider(config.provider);
  if (provider.name === "echo") {
    return {
      ok: true,
      provider,
      configured: true,
      message: "Echo provider is deterministic and does not require credentials."
    };
  }

  if (provider.name === "codex") {
    const credentials = readCodexCredentials(provider);
    return {
      ok: credentials.ok,
      provider,
      configured: credentials.ok,
      authPath: credentials.authPath,
      credentialType: credentials.credentialType,
      message: credentials.ok
        ? `Codex credentials are available from ${credentials.authPath}.`
        : credentials.message
    };
  }

  if (provider.name === "bedrock") {
    const configured = Boolean(resolveAwsCredentials());
    // Surface the live request-time host (region resolved env-aware via
    // bedrockRegion) so the displayed baseUrl can't drift from where requests
    // are actually signed and sent. This is display-only — config.json still
    // persists just an explicit region, so reading env here introduces no leak.
    const displayed = { ...provider, baseUrl: bedrockRuntimeBaseUrl(bedrockRegion(provider)) };
    return {
      ok: configured,
      provider: displayed,
      configured,
      message: configured
        ? "bedrock provider is configured (AWS SigV4)."
        : "Set AWS credentials (enter your AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY when adding the bedrock provider) to use the bedrock provider."
    };
  }

  const envName = provider.apiKeyEnv ?? "OPENAI_API_KEY";
  if (provider.name === "azure") {
    // Azure needs a valid https resource endpoint in addition to the key — match
    // the isProviderConfigured azure gate so /api/setup/status agrees with the
    // catalog and never advertises an azure config with no/invalid baseUrl as
    // ready (the deployment URL would otherwise fail to build).
    const hasKey = Boolean(process.env[envName]);
    const endpointOk = !azureNeedsBaseUrl("azure", provider.baseUrl) && !azureNeedsHttps("azure", provider.baseUrl);
    const azureReady = hasKey && endpointOk;
    return {
      ok: azureReady,
      provider,
      configured: azureReady,
      message: azureReady
        ? "azure provider is configured."
        : hasKey
          ? "Set a valid https Azure resource baseUrl (https://<resource>.openai.azure.com) to use the azure provider."
          : `Set ${envName} to use the azure provider.`
    };
  }
  const configured = provider.name === "local" || Boolean(process.env[envName]);
  return {
    ok: configured,
    provider,
    configured,
    message: configured ? `${provider.name} provider is configured.` : `Set ${envName} to use the ${provider.name} provider.`
  };
}

// Per-provider env var that holds the bearer token. Mirrors the apiKeyEnv
// defaults in normalizeProvider, and is the single source of truth for
// the "is this provider configured?" gate the settings UI uses to decide
// which rows to render.
const PROVIDER_API_KEY_ENV: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  local: "GINI_LOCAL_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  azure: "AZURE_OPENAI_API_KEY"
};

// Whether AWS credentials resolve for the `bedrock` provider from the env
// (AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY[/AWS_SESSION_TOKEN]). The keys are
// entered on provider add and sourced from ~/.gini/secrets.env into the
// environment; "configured" means they're present.
export function hasUsableAwsCredentials(): boolean {
  return Boolean(resolveAwsCredentials());
}

// Whether a provider has usable credentials in the current process env.
// echo is dev-only and never reported as configured. codex consults
// readCodexCredentials so we honor CODEX_AUTH_JSON and the default path.
// local is a special case: most local gateways (Ollama, LM Studio)
// accept no-auth requests so the env var is optional — we still gate
// the row on the user having explicitly opted in by either setting the
// env var or making local the active provider.
export function isProviderConfigured(
  name: string,
  activeProviderName?: string,
  activeApiKeyEnv?: string,
  activeBaseUrl?: string
): boolean {
  if (name === "echo") return false;
  if (name === "codex") return hasUsableCodexCredentials();
  // bedrock signs with the AWS keys the user entered (stored in secrets.env,
  // read from the AWS_* env) — configured when they resolve.
  if (name === "bedrock") return hasUsableAwsCredentials();
  // Azure has no default endpoint, so an env key alone is NOT a usable config —
  // it counts as configured only when azure is the ACTIVE provider AND carries a
  // valid persisted https resource baseUrl. RuntimeConfig persists a single
  // provider, so a non-active azure row's baseUrl is unknown; surfacing it as
  // "configured" would render a Settings row whose radio-switch can only ever
  // fail (the switch payload carries no baseUrl). Gating on active + valid
  // endpoint keeps the row truthful and removes that dead-end affordance.
  if (name === "azure") {
    if (name !== activeProviderName) return false;
    if (azureNeedsBaseUrl(name, activeBaseUrl) || azureNeedsHttps(name, activeBaseUrl)) return false;
    const azureEnv = activeApiKeyEnv || PROVIDER_API_KEY_ENV[name];
    return Boolean(azureEnv && process.env[azureEnv]);
  }
  // local is a no-auth opt-in: as the active provider it counts as
  // configured even without a key (most local gateways accept no-auth).
  // Kept ahead of the custom-apiKeyEnv branch so local never gates on a key.
  if (name === "local" && activeProviderName === "local") return true;
  // For the active provider, honor a custom apiKeyEnv (e.g. a custom env var set
  // via `gini provider set --api-key-env`) — the same var readOpenAIBearer /
  // providerHealth / readAnthropicKey read at call time — so a custom-env config
  // isn't reported unconfigured and silently hidden by the settings UI. Non-active
  // rows carry no stored config, so they fall back to the per-provider default.
  const envVar = name === activeProviderName && activeApiKeyEnv
    ? activeApiKeyEnv
    : PROVIDER_API_KEY_ENV[name];
  if (envVar && process.env[envVar]) return true;
  return false;
}

// Transient dispatch-provider resolution. When the configured active provider
// has usable credentials it dispatches verbatim (no fallback). When it does
// NOT — e.g. an instance pinned to bedrock with no AWS creds — but ANOTHER
// real provider IS configured (e.g. deepseek via DEEPSEEK_API_KEY), this
// returns that fallback so a chat turn still completes instead of throwing.
// The fallback is computed per-call and NEVER persisted: config.provider stays
// the user's selection so the setup banner persists until they finish wiring
// it. When nothing is configured the active provider is returned unchanged
// (usingFallback:false) — a genuinely-unconfigured instance still drives the
// /setup gate.
//
// Candidate selection reuses providerCatalogWithStatus: echo always reports
// unconfigured (never a candidate), and azure/local report configured only
// when they're the active provider (so they're never picked as a fallback for
// a DIFFERENT active provider). The catalog's first model is the fallback
// model — the same `default == models[0]` invariant normalizeProvider keeps.
export type DispatchProviderResolution =
  | { provider: ProviderConfig; usingFallback: false }
  | { provider: ProviderConfig; usingFallback: true; selected: ProviderName; using: ProviderName };

export function resolveDispatchProvider(config: RuntimeConfig): DispatchProviderResolution {
  const active = normalizeProvider(config.provider);
  if (providerHealth(config).configured) {
    return { provider: active, usingFallback: false };
  }
  const catalog = providerCatalogWithStatus(active.name, active.apiKeyEnv, active.baseUrl);
  const fallback = catalog.find((item) => item.configured && item.name !== active.name);
  if (!fallback) {
    return { provider: active, usingFallback: false };
  }
  // Every catalog entry's name is a real ProviderName (the `| string` widening
  // on ProviderCatalogItem covers external ids the runtime never emits here).
  const fallbackName = fallback.name as ProviderName;
  return {
    provider: normalizeProvider({
      name: fallbackName,
      model: fallback.models[0] ?? ""
    }),
    usingFallback: true,
    selected: active.name,
    using: fallbackName
  };
}

// Catalog enriched with the per-provider configured flag. Used by the
// settings UI to hide rows the user hasn't connected; the static
// providerCatalog() stays in place for callers that just need the list of
// known provider shapes (e.g. setup-api default-model resolution). Pass the
// active provider's apiKeyEnv so a custom-env active provider reads as
// configured rather than being hidden.
export function providerCatalogWithStatus(
  activeProviderName?: string,
  activeApiKeyEnv?: string,
  activeBaseUrl?: string
): Array<ProviderCatalogItem & { configured: boolean }> {
  return providerCatalog().map((item) => ({
    ...item,
    configured: isProviderConfigured(item.name, activeProviderName, activeApiKeyEnv, activeBaseUrl)
  }));
}

// Catalog enrichment with the persistent per-provider auth status (issue
// #233). `authStatus: "needs_reauth"` plus a `reauth` payload (redacted
// detail, failure timestamp, and the same reauthKind/reauthUrl routing the
// chat note carries — derived via providerReauth at read time) when a
// needs-reauth record exists for the provider; `authStatus: "ok"` otherwise.
// Layered on top of providerCatalogWithStatus by the /api/providers/catalog
// handler — the records live in runtime state, which the pure catalog
// builders deliberately don't read.
export function withProviderAuthStatus<T extends { name: ProviderCatalogItem["name"] }>(
  items: T[],
  providerAuthFailures: Partial<Record<ProviderName, ProviderAuthFailureRecord>> | undefined
): Array<T & { authStatus: ProviderAuthStatus; reauth?: ProviderReauthInfo }> {
  return items.map((item) => {
    const record = providerAuthFailures?.[item.name as ProviderName];
    if (!record) return { ...item, authStatus: "ok" as const };
    const target = providerReauth(record.provider);
    return {
      ...item,
      authStatus: "needs_reauth" as const,
      reauth: { detail: record.detail, at: record.at, reauthKind: target.kind, reauthUrl: target.url }
    };
  });
}

export function providerCatalog(): ProviderCatalogItem[] {
  const items: ProviderCatalogItem[] = [
    {
      id: "echo",
      name: "echo",
      displayName: "Gini Echo",
      auth: "none",
      models: ["gini-echo-v0"],
      capabilities: ["deterministic", "smoke", "tests"],
      costHint: "free"
    },
    {
      id: "codex",
      name: "codex",
      displayName: "Codex OAuth",
      baseUrl: DEFAULT_CODEX_BASE_URL,
      auth: "codex-oauth",
      models: [DEFAULT_CODEX_MODEL],
      capabilities: ["responses", "streaming", "oauth"],
      costHint: "external"
    },
    {
      id: "openai",
      name: "openai",
      displayName: "OpenAI Compatible",
      baseUrl: DEFAULT_OPENAI_BASE_URL,
      auth: "env",
      models: ["gpt-5.4-mini", "gpt-5.4"],
      capabilities: ["responses", "tool-calling"],
      costHint: "external"
    },
    {
      // First-party Claude API: ANTHROPIC_API_KEY (sk-ant…) in x-api-key against
      // api.anthropic.com. Amazon Bedrock is the separate `bedrock` entry below.
      id: "anthropic",
      name: "anthropic",
      displayName: "Anthropic Compatible",
      baseUrl: DEFAULT_ANTHROPIC_BASE_URL,
      auth: "env",
      models: ["claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5"],
      capabilities: ["messages", "tool-calling", "streaming", "vision"],
      costHint: "external"
    },
    {
      // Amazon Bedrock via the model-agnostic Converse API — Claude, Amazon
      // Nova, Meta Llama, Mistral, DeepSeek, and more behind one transport.
      // Signed with AWS SigV4 from the AWS access key + secret the user enters
      // when adding the provider (stored in ~/.gini/secrets.env, not an API
      // key), so its `auth` is "aws", distinct from the env-key providers.
      // Models are cross-region inference-profile ids sent verbatim to Converse.
      // The list below is what the picker offers, grouped by family in the UI and
      // covering the common us/eu/apac geos; the picker also has a custom-id
      // escape hatch and the runtime accepts any id, so this isn't a hard allowlist.
      id: "bedrock",
      name: "bedrock",
      displayName: "Amazon Bedrock",
      baseUrl: DEFAULT_BEDROCK_BASE_URL,
      auth: "aws",
      models: [
        "us.anthropic.claude-opus-4-8",
        "us.anthropic.claude-opus-4-7",
        "us.anthropic.claude-sonnet-4-6",
        "us.anthropic.claude-haiku-4-5-20251001-v1:0",
        "eu.anthropic.claude-sonnet-4-6",
        "apac.anthropic.claude-sonnet-4-6",
        "global.anthropic.claude-sonnet-4-6",
        "us.amazon.nova-premier-v1:0",
        "us.amazon.nova-pro-v1:0",
        "us.amazon.nova-lite-v1:0",
        "us.amazon.nova-micro-v1:0",
        "eu.amazon.nova-pro-v1:0",
        "eu.amazon.nova-lite-v1:0",
        "apac.amazon.nova-pro-v1:0",
        "apac.amazon.nova-lite-v1:0",
        "us.meta.llama3-3-70b-instruct-v1:0",
        "us.meta.llama4-maverick-17b-instruct-v1:0",
        "us.meta.llama4-scout-17b-instruct-v1:0",
        "us.mistral.pixtral-large-2502-v1:0",
        "us.mistral.mistral-large-2407-v1:0",
        "us.deepseek.r1-v1:0"
      ],
      capabilities: ["converse", "tool-calling", "streaming", "vision"],
      costHint: "external"
    },
    {
      id: "openrouter",
      name: "openrouter",
      displayName: "OpenRouter Compatible",
      baseUrl: "https://openrouter.ai/api/v1",
      auth: "env",
      models: ["openrouter/auto"],
      capabilities: ["chat-completions", "model-routing"],
      costHint: "external"
    },
    {
      id: "deepseek",
      name: "deepseek",
      displayName: "DeepSeek",
      baseUrl: DEFAULT_DEEPSEEK_BASE_URL,
      auth: "env",
      models: ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-chat", "deepseek-reasoner"],
      capabilities: ["chat-completions", "tool-calling"],
      costHint: "external"
    },
    {
      id: "azure",
      name: "azure",
      displayName: "Azure OpenAI",
      // No catalog baseUrl: Azure is per-resource, supplied by the user as
      // https://<resource>.openai.azure.com. The models below are the common
      // chat-capable deployments; any Azure deployment name works at config time.
      auth: "env",
      models: ["gpt-5.5", "gpt-5.4", "gpt-4o", "gpt-4o-mini", "o3-mini"],
      capabilities: ["chat-completions", "tool-calling", "deployment-scoped"],
      costHint: "external"
    },
    {
      id: "local",
      name: "local",
      displayName: "Local OpenAI-Compatible",
      baseUrl: "http://127.0.0.1:11434/v1",
      auth: "env",
      models: ["local/default"],
      capabilities: ["chat-completions", "local"],
      costHint: "unknown"
    }
  ];
  // Attach the hosted setup guide by convention (<base>/providers/<id>), the
  // same path scheme the re-auth CTA uses. echo is a dev/test provider with no
  // guide, so it stays without one.
  return items.map((item) =>
    item.id === "echo" ? item : { ...item, setupDocUrl: `${DOCS_BASE_URL}/providers/${item.id}` }
  );
}

// Short brand label for a provider, used in user-facing copy (e.g. the
// re-authenticate note surfaced when a credential expires). Mirrors the web
// settings labels: drops the catalog's "Compatible"/"OAuth" suffixes so the
// brand reads cleanly on its own.
export function providerDisplayLabel(name: ProviderName): string {
  switch (name) {
    case "codex":
      return "Codex";
    case "openai":
      return "OpenAI";
    case "openrouter":
      return "OpenRouter";
    case "deepseek":
      return "DeepSeek";
    case "anthropic":
      return "Anthropic";
    case "bedrock":
      return "Amazon Bedrock";
    case "azure":
      return "Azure OpenAI";
    case "local":
      return "Local";
    case "echo":
      return "Gini Echo";
  }
}

// Detects provider errors that mean the user's credential must be
// re-established — an expired/invalid/revoked/incorrect token, a bare 401/
// unauthorized, or an explicit "sign in again" / "log in again" /
// "re-authenticate" instruction. Deliberately broader than
// CODEX_SESSION_EXPIRED_RE (which gates retries and must avoid retrying generic
// failures): here a false positive only adds a re-auth hint to a note we were
// already going to show, so the matcher favors recall. An auth noun and an
// expiry/invalidity verb must sit within the same sentence ([^.]{0,40}) and in
// either order, so unrelated failures ("the cached file is invalid") don't trip
// it. The noun uses `auth\w*` so both "authentication" and "authorization"
// match. The connector after each noun/verb is `(?:[\s_-]|\b)` rather than a
// bare `\b` so the snake_case enum forms the backend emits (`token_expired`,
// `session_expired`) match too — `_` is a word char, so `\b` alone would miss
// them.
const AUTH_NOUN = "(?:auth\\w*|session|token|credential|api[\\s_-]*key|access[\\s_-]*token)";
const AUTH_VERB =
  "(?:expired|invalid|revoked|rejected|incorrect|missing|failed|disabled|deactivated|suspended)";
const AUTH_EXPIRED_RE = new RegExp(
  [
    "\\b40[13]\\b",
    "\\b(?:unauthorized|forbidden)\\b",
    "not[\\s_-]+authori[sz]ed",
    "(?:sign|log)(?:ing|ging)?[\\s-]*in[\\s-]*again",
    "login[\\s-]*again",
    "re-?authenticate",
    `\\b${AUTH_NOUN}(?:[\\s_-]|\\b)[^.]{0,40}?${AUTH_VERB}\\b`,
    `\\b${AUTH_VERB}(?:[\\s_-]|\\b)[^.]{0,40}?${AUTH_NOUN}\\b`
  ].join("|"),
  "i"
);

// Classifies provider auth failures. Called ONLY at provider-call sites (the
// chat-task model call and the iteration-cap summary call), where a match
// definitively means the credential failed — so a tool/browser/terminal error
// that merely mentions "401" can never be misread as a provider re-auth. The
// matcher therefore favors recall: expired/invalid/revoked/disabled tokens,
// 401/403, "not authorized", and "sign/log in again".
export function isAuthExpiredError(message: string | undefined): boolean {
  if (!message) return false;
  return AUTH_EXPIRED_RE.test(message);
}

// Detects provider errors that mean the request prompt exceeded the model's
// context window — the only provider failure the chat-task loop is allowed to
// compact-and-retry (see runLoop). Deliberately a conservative, reviewable
// marker list rather than a broad regex: a false positive would silently
// shrink a healthy conversation, so each entry mirrors a documented provider
// message:
//   - "context_length_exceeded"               OpenAI-compatible error code
//   - "maximum context length"                OpenAI: "This model's maximum context length is …"
//   - "prompt is too long"                    Anthropic: "prompt is too long: X tokens > Y maximum"
//   - "exceed context limit"                  Anthropic: "input length and max_tokens exceed context limit"
//   - "input is too long for requested model" Bedrock ValidationException
//   - "exceeds the available context size"    llama.cpp server: "the request exceeds the available context size"
const CONTEXT_OVERFLOW_MARKERS = [
  "context_length_exceeded",
  "maximum context length",
  "prompt is too long",
  "exceed context limit",
  "input is too long for requested model",
  "exceeds the available context size"
];

export function isContextOverflowError(message: string | undefined): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  return CONTEXT_OVERFLOW_MARKERS.some((marker) => lower.includes(marker));
}

// True when an error is an AbortSignal-triggered abort, i.e. the in-flight
// model call (fetch + stream reader) was cancelled via the turn AbortController
// (see src/execution/turn-abort.ts). An aborted fetch rejects its `reader.read()`
// with a DOMException named "AbortError"; our own abortable-sleep helper throws
// the same shape via signal.reason. The chat-task loop classifies this distinctly
// so a cancelled turn bails to the terminal "cancelled" path rather than being
// misread as an auth failure (re-auth note) or a context overflow (compact +
// retry). Pure inspection — never matches an ordinary provider error string.
export function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  return error instanceof Error && error.name === "AbortError";
}

// Sleep that rejects promptly when `signal` aborts, instead of running the full
// duration. Used by the echo provider's injected `delayMs` (so a test can abort
// a turn mid-call and observe the same deterministic AbortError a real provider
// fetch would raise) and by withCodexSessionRetry's pre-retry wait (so a cancel
// during the 50 ms settle window skips the second attempt at the source).
// Rejects with the signal's reason (an AbortError-shaped DOMException) so
// isAbortError classifies it. Both branches go through setTimeout so the delay
// stays observable to tests that spy on it.
async function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, ms);
  const onAbort = (): void => {
    clearTimeout(timer);
    reject(signal!.reason ?? new DOMException("Aborted", "AbortError"));
  };
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  try {
    await promise;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

// Idle window for a streaming model call: if a single reader.read() delivers no
// new bytes for this long, treat the stream as wedged and abort. Sized to sit
// far above a healthy inter-chunk gap (fine-grained streaming emits deltas a
// couple of seconds apart at most) yet well under the multi-minute OS socket
// timeout a genuinely dead connection would otherwise hang on. The real failure
// this catches is a provider that opens the stream, emits a little, then stalls
// forever mid tool-arg generation — the read just never resolves, so a turn
// would hang indefinitely without this. Module-level so tests can reference the
// exact value.
export const IDLE_STREAM_TIMEOUT_MS = 120_000;

// Resolve the idle window at use time (not module load) so it can be overridden
// via GINI_IDLE_STREAM_TIMEOUT_MS — an operability knob (a slow self-hosted
// model may legitimately pause longer than 2 min) and the seam that lets a live
// test trigger the stall path in well under a second. Mirrors transientRetryBaseMs
// in chat-task.ts. Production (env unset) uses IDLE_STREAM_TIMEOUT_MS; a 0 or
// invalid override falls back to the default rather than disabling the guard.
function resolveIdleStreamTimeoutMs(): number {
  const raw = process.env.GINI_IDLE_STREAM_TIMEOUT_MS;
  if (raw === undefined) return IDLE_STREAM_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : IDLE_STREAM_TIMEOUT_MS;
}

// Thrown when a streaming read stalls past IDLE_STREAM_TIMEOUT_MS. A DISTINCT
// name (not "AbortError") on purpose: the chat-task loop must NOT mistake this
// for a user cancel (isAbortError stays false) nor for a context overflow — it
// is a transient stall the retry layer is free to re-attempt. The retry
// classifier keys off this name; the message also carries the stable substring
// "stream idle timeout" as a fallback marker.
export class StreamIdleTimeoutError extends Error {
  constructor(ms: number) {
    super(`Model stream idle timeout: no data for ${ms}ms`);
    this.name = "StreamIdleTimeoutError";
  }
}

// True when an error is a streaming idle/stall timeout (see StreamIdleTimeoutError).
// Exposed so the chat-task retry layer can classify it as a transient failure
// worth re-attempting, distinct from a user cancel (isAbortError) or a context
// overflow (isContextOverflowError). Matches by name first, then the stable
// message substring as a defensive fallback if the error is reconstructed.
export function isStreamIdleTimeoutError(error: unknown): boolean {
  if (error instanceof StreamIdleTimeoutError) return true;
  if (!(error instanceof Error)) return false;
  return error.name === "StreamIdleTimeoutError" || error.message.includes("stream idle timeout");
}

// Race a single reader.read() against the idle window. On a normal read the
// timer is cleared and the chunk returned unchanged, so the happy path is
// untouched. If the window elapses first, cancel the reader (tearing down the
// underlying fetch/socket — no leak) and throw a StreamIdleTimeoutError. The
// turn AbortSignal still aborts immediately and independently: the loop's
// pre-read signal.aborted guard plus the aborted fetch rejecting read() with an
// AbortError both win the race, and that AbortError stays classified as a user
// cancel. The timer is always cleared in finally so a fast read never leaves a
// dangling handle.
async function readWithIdleTimeout<T>(
  reader: ReadableStreamDefaultReader<T>,
  idleMs: number = resolveIdleStreamTimeoutMs()
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<T>["read"]>>> {
  const { promise: timeout, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    // Reject FIRST, then cancel. Ordering matters: reader.cancel() settles the
    // still-pending reader.read() with {done:true}, and that resolution would
    // win the Promise.race over a reject scheduled after it — silently ending
    // the stream as "done" instead of surfacing the stall. Rejecting before the
    // cancel makes the StreamIdleTimeoutError the value the race adopts. The
    // cancel still runs to tear down the fetch so the stalled socket is released.
    reject(new StreamIdleTimeoutError(idleMs));
    reader.cancel().catch(() => {});
  }, idleMs);
  try {
    return await Promise.race([reader.read(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// Mask credential-shaped substrings before a provider's raw error is stored or
// rendered — some providers echo a partial key in their auth error. Conservative
// on purpose: only well-known key/token shapes, so ordinary prose is untouched.
export function redactSecrets(text: string): string {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, "sk-***")
    // Bedrock Mantle bearer tokens (minted by aws-bedrock-token-generator,
    // carried in x-api-key) are `bedrock-api-key-<base64>&Version=1` — the
    // `&`/`=` fall outside the value class below, so match the whole token by
    // its prefix to mask the base64 body and the &Version tail in one shot.
    .replace(/\bbedrock-api-key-[^\s"']+/gi, "bedrock-api-key-***")
    // Long-term Bedrock API keys (IAM service-specific credentials, also carried
    // in x-api-key) are a single base64 blob beginning `ABSK…` — a different
    // shape from the short-term token above, so match the prefix and mask the
    // base64 body. See AWS "Securing Amazon Bedrock API keys".
    .replace(/\bABSK[A-Za-z0-9+\/]{16,}={0,2}/g, "ABSK***")
    // AWS SigV4 wire exposure (aws-sigv4 Bedrock path): the access key id
    // (AKIA…/ASIA…) rides in the Authorization `Credential=`, and the per-request
    // signature in `Signature=`. Mask both. The secret access key never goes on
    // the wire — it only derives the signature locally — so it can't leak here.
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "AWS-ACCESS-KEY-***")
    .replace(/Signature=[0-9a-f]{64}/gi, "Signature=***")
    .replace(/\bBearer\s+[A-Za-z0-9._-]{6,}/gi, "Bearer ***")
    .replace(/\b(api[_-]?key|token|secret|password)(["'\s:=]+)[A-Za-z0-9._-]{6,}/gi, "$1$2***");
}

// Thrown in place of the raw provider error when a tool-calling / model call
// fails on an auth error, tagging the provider that actually served the turn.
// failTask reads `provider` off this so the re-auth note names the right
// credential even if the active agent changed mid-call (issue #205).
export class ProviderAuthError extends Error {
  constructor(
    readonly provider: ProviderName,
    message: string
  ) {
    super(message);
    this.name = "ProviderAuthError";
  }
}

export type ProviderReauth = { kind: "docs" | "settings" | "aws"; url: string };

// Hosted documentation root. Re-auth step-throughs for OAuth/CLI providers live
// here so the instructions have a single source and never drift from code.
const DOCS_BASE_URL = "https://gini.lilaclabs.ai/docs";

// Where to send the user to re-establish a failed provider credential. OAuth/
// CLI providers (codex) have no in-app form and a non-obvious terminal flow, so
// they link to the hosted step-through docs. AWS providers (bedrock) sign with
// AWS credentials and have no in-app key form either, so they point at Settings
// but describe credentials rather than a key. API-key providers link straight to
// the Settings → Providers key form — the specific cause is already in the
// provider's own 401/403 message (surfaced as the note's detail), so no doc is
// needed. The auth split is read from the catalog's `auth` field, not re-encoded
// here. See ADR provider-reauth-guidance.md.
export function providerReauth(name: ProviderName): ProviderReauth {
  const entry = providerCatalog().find((item) => item.name === name);
  if (entry?.auth === "codex-oauth") {
    // `#re-authentication` is the natural GitHub/standard-renderer slug for the
    // "## Re-authentication" heading in docs/providers/<id>.md, so the anchor
    // resolves both in-repo and on the hosted docs site.
    return { kind: "docs", url: `${DOCS_BASE_URL}/providers/${name}#re-authentication` };
  }
  if (entry?.auth === "aws") return { kind: "aws", url: "/settings" };
  return { kind: "settings", url: "/settings" };
}

// Build the chat system-note payload for a provider auth failure — the
// provider-named line plus the structured metadata the web renders as a CTA.
// Shared by failTask and the iteration-cap summary path so both surface
// identical notes. `detail` should already be redacted by the caller.
export function providerAuthNote(
  provider: ProviderName,
  detail: string
): { text: string; authError: SystemNoteAuthError } {
  const providerLabel = providerDisplayLabel(provider);
  const reauth = providerReauth(provider);
  return {
    text: providerAuthFailureText(providerLabel),
    authError: { provider, providerLabel, detail, reauthKind: reauth.kind, reauthUrl: reauth.url }
  };
}

// Actionable copy for a failed provider credential, shared by the chat system
// note and the legacy assistant message so every client surface says the same
// thing. Neutral on the failure mode (the classifier matches expired, invalid,
// revoked, 401, …). Pass `reauth` for text-only clients (CLI/messaging) that
// can't render a CTA button — the actionable target is appended inline; omit it
// for the web note, which renders the CTA separately.
export function providerAuthFailureText(providerLabel: string, reauth?: ProviderReauth): string {
  const base = `${providerLabel} authentication failed.`;
  // AWS providers sign with credentials, not an API key — never tell the user to
  // "update a key" they don't have.
  if (reauth?.kind === "aws") {
    return `${base} Re-enter your AWS credentials (AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY) in Settings → Providers to continue.`;
  }
  if (!reauth) return `${base} Re-authenticate ${providerLabel} to continue.`;
  return reauth.kind === "docs"
    ? `${base} Re-authenticate ${providerLabel} to continue: ${reauth.url}`
    : `${base} Update your ${providerLabel} API key in Settings → Providers.`;
}

// OpenAI tool-calling shapes. We mirror the chat-completions API surface
// directly so tool specs can be authored once and shipped to any compat
// provider (OpenAI, OpenRouter, local) without an intermediate adapter.
export interface ToolFunctionSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON schema
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON-encoded args; callers parse
  };
}

export type ChatMessageRole = "system" | "user" | "assistant" | "tool";

// Vision-capable content part. user-role messages can carry a content
// array mixing text and image_url parts so the provider sees both. The
// image_url.url field carries a data URL (data:image/png;base64,...) inlined
// at dispatch time — we do not pass a fetchable URL because the runtime
// auth-gates upload reads and the provider can't authenticate.
export type MessageContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  // Native document part for providers that ingest files directly (PDF →
  // text + page-images on the provider side). `data` is raw base64 with no
  // `data:` prefix; serializers re-wrap it into the per-endpoint data-URL
  // shape. Only ever produced upstream when the resolved provider's
  // `nativeDocs === true` (see src/provider-capabilities.ts), so it never
  // reaches echo/deepseek/local; serializers still drop it defensively.
  | { type: "document"; document: { mimeType: string; data: string; filename?: string } };

export interface ToolCallingMessage {
  role: ChatMessageRole;
  content: string | MessageContentPart[] | null;
  // tool result messages carry the originating call id; assistant messages
  // that triggered tool calls carry `tool_calls`.
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

// Defensive guard at the request-build boundary: a `document` content part is
// only ever produced upstream when the resolved provider's `nativeDocs` is
// true (see src/provider-capabilities.ts). But a task that paused for approval
// can resume after the active provider changed (openai → deepseek/local), and
// resumeChatTask replays the persisted message snapshot without re-resolving
// modality — so a stale `document` part can reach a provider that 400s on it.
// Strip document parts from every parts-array message when the resolved
// provider can't ingest documents. Text/image_url parts pass through; a
// message left with no parts keeps a single empty-text part so `content` is
// never an empty array.
function stripDocumentPartsIfUnsupported(
  messages: ToolCallingMessage[],
  provider: ProviderConfig
): ToolCallingMessage[] {
  if (resolveProviderModality(provider).nativeDocs) return messages;
  return messages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    if (!message.content.some((part) => part.type === "document")) return message;
    const kept = message.content.filter((part) => part.type !== "document");
    return {
      ...message,
      content: kept.length > 0 ? kept : [{ type: "text", text: "" }]
    };
  });
}

// Drop unpaired tool-calling messages so the tool-pairing-strict providers
// (Anthropic Messages, Bedrock Converse) never 400 on a malformed history.
// Both APIs require every assistant `tool_use` block to be answered by a
// `tool_result` in the immediately-following message, and reject an orphan
// `tool_result` with no preceding `tool_use`. A history can carry an unpaired
// pair when an inline-handled tool (load_tools, the deferred-not-loaded nudge)
// pushed its result into the live turn but never persisted a
// transcript row — so a later replay reconstructs the assistant tool_use
// without its result. chat-task's priorChatMessages does a similar pass, but
// this is the request-build backstop that catches ANY path (resume snapshots,
// in-turn compaction, future callers) regardless of how the gap arose.
//
// Pairing is TURN-WINDOW-bounded, not global: each assistant tool_use turn is
// answered only by the `tool` results in its own turn window — the rows that
// follow it up to, but not including, the next user message (a turn boundary)
// or the next assistant tool_use turn. A global "id answered anywhere later"
// check is wrong because synthesized text-backstop ids (synthesizeToolCallId
// hashes name:args:index, and index resets each turn) can recur across turns:
// a turn-1 result would then falsely satisfy a turn-2 dangling tool_use with
// the same id, leaving an unanswered tool_use on the wire. Interleaved plain
// assistant text inside the window is skipped (a gated tool persists an
// approval_reason / text row between its tool_use and its on-resume result),
// but a user row or the next tool round ends the window. An assistant turn is
// kept only when EVERY id it carries is answered in its window; otherwise the
// turn and its partial results drop together (a partial tool_use set still
// 400s). A `tool` row survives only as a matched result of a kept turn; any
// other `tool` row is an orphan and is dropped.
//
// Matched results are emitted IMMEDIATELY after their assistant tool_use turn,
// hoisting them over any interleaved approval_reason / plain-text row that sat
// between the call and its result. Bedrock Converse requires the toolResult to
// lead the very next message after the toolUse turn (an interposed assistant
// text turn 400s with "toolResult blocks ... exceeds the number of toolUse
// blocks of previous turn"); the interleaved row is re-emitted in its original
// order right after the hoisted results. This mirrors priorChatMessages so the
// rebuild-time and request-build guards agree.
function pairToolCallingMessages(messages: ToolCallingMessage[]): ToolCallingMessage[] {
  const isToolUseTurn = (m: ToolCallingMessage): boolean =>
    m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
  const out: ToolCallingMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    if (isToolUseTurn(message)) {
      const ids = message.tool_calls!.map((call) => call.id);
      const idSet = new Set(ids);
      const resultIndexById = new Map<string, number>();
      for (let j = i + 1; j < messages.length; j++) {
        const next = messages[j]!;
        if (next.role === "user") break; // turn boundary
        if (isToolUseTurn(next)) break; // next tool round
        if (next.role !== "tool") continue; // skip interleaved approval_reason / plain text
        const id = next.tool_call_id;
        if (typeof id === "string" && idSet.has(id) && !resultIndexById.has(id)) {
          resultIndexById.set(id, j);
        }
      }
      if (!ids.every((id) => resultIndexById.has(id))) continue; // drop the unanswered turn
      out.push(message);
      // Emit results in the assistant turn's id order, immediately adjacent —
      // hoisted over any interleaved row, which the outer loop re-emits after.
      for (const id of ids) out.push(messages[resultIndexById.get(id)!]!);
      continue;
    }
    // A `tool` row reached directly by the outer loop is either an orphan or a
    // result already emitted next to its (kept) assistant turn above — drop it
    // so no result leads without its tool_use and none double-emits.
    if (message.role === "tool") continue;
    out.push(message);
  }
  return out;
}

export interface ToolCallingResult {
  provider: ProviderConfig;
  text: string;
  toolCalls: ToolCall[];
  finishReason: "stop" | "tool_calls" | "length" | "content_filter" | "unknown";
  responseId?: string;
  usage?: Record<string, unknown>;
  cost?: CostRecord;
  // Headlines of any server-side native web searches the provider ran during
  // the call (Responses API `web_search_call` items: a search's `query` or a
  // page-open's `url`). These never become dispatchable tool calls — the search
  // already executed on the provider — so the chat-task loop surfaces each as a
  // display-only "Web search" chip. Absent for every non-Responses path. See
  // ADR web-search-connectors.md.
  webSearches?: string[];
}

// Echo provider stub registry for tool-calling. Tests register a sequence
// of canned responses (each is the next ToolCallingResult to return) keyed
// by an optional tag — useful for end-to-end chat-task tests where the
// loop calls the provider multiple times. A stub with `error` set makes
// the echo call throw instead, exercising callers' provider-failure paths
// (context-overflow retries, auth tagging, task failure).
const echoToolCallingStubs: Array<{ tag?: string; result?: ToolCallingResult; nonStreaming?: boolean; error?: string; streamTextBeforeFailure?: string; delayMs?: number; streamAfterAbort?: boolean }> = [];
// Capture the messages each echo call was invoked with. Tests inspect this
// to assert that the chat-task loop built the expected system prompt /
// conversation transcript. The buffer is cleared by
// clearEchoToolCallingResponses so the per-test setup also resets it.
const echoToolCallingCalls: ToolCallingMessage[][] = [];
// Capture the tool names advertised on each echo call. Tests inspect this
// to assert which (deferred) tool schemas were live in the provider tools
// array on a given turn. Cleared alongside echoToolCallingCalls.
const echoToolCallingToolNames: string[][] = [];

// `nonStreaming` suppresses the synthesized onDelta below, mirroring a
// provider that returns the whole string at once — callers' no-delta
// paths (one-shot block emission, route finalization without a stream)
// are unreachable otherwise, since echo streams every non-empty text.
// `streamAfterAbort`: deliver this stub's text through onDelta and RETURN
// normally even if the turn was aborted during its delayMs hold, instead of
// the abortable sleep rejecting. This models a real provider that had already
// buffered deltas on the wire when the abort fired — they arrive on a later
// macrotask before the stream unwinds. It is the only way to exercise the
// loop's defense-in-depth flush / route terminal-status guards (which drop
// post-cancel deltas), since the normal abortable-sleep path rejects before
// any delta and never reaches them. Has no effect when the turn isn't aborted.
export function setEchoToolCallingResponse(
  result: ToolCallingResult,
  tag?: string,
  opts?: { nonStreaming?: boolean; delayMs?: number; streamAfterAbort?: boolean }
): void {
  echoToolCallingStubs.push({
    tag,
    result,
    nonStreaming: opts?.nonStreaming,
    delayMs: opts?.delayMs,
    streamAfterAbort: opts?.streamAfterAbort
  });
}

// Queue an echo tool-calling FAILURE: the next echo-backed
// generateToolCallingResponse call throws `new Error(message)` instead of
// returning a result. The call is still recorded in echoToolCallingCalls so
// tests can assert what payload the failed attempt carried. When
// `streamTextBeforeFailure` is set, the failing call first delivers that
// text through `onDelta` — mirroring a real provider that streams part of
// a response before erroring — so callers' stream-reset paths can be
// exercised.
export function setEchoToolCallingFailure(message: string, opts?: { streamTextBeforeFailure?: string }): void {
  echoToolCallingStubs.push({ error: message, streamTextBeforeFailure: opts?.streamTextBeforeFailure });
}

export function clearEchoToolCallingResponses(): void {
  echoToolCallingStubs.length = 0;
  echoToolCallingCalls.length = 0;
  echoToolCallingToolNames.length = 0;
}

// Test-only accessor: returns the messages array passed to every
// echo-backed `generateToolCallingResponse` call since the last clear.
// Each entry is the full transcript at the moment of the call.
export function getEchoToolCallingCalls(): ToolCallingMessage[][] {
  return echoToolCallingCalls.map((messages) => messages.slice());
}

// Test-only accessor: returns the tool names in the `tools` array passed to
// every echo-backed `generateToolCallingResponse` call since the last clear.
export function getEchoToolCallingToolNames(): string[][] {
  return echoToolCallingToolNames.map((names) => names.slice());
}

function nextEchoToolCallingResult(
  provider: ProviderConfig,
  lastUserText: string,
  onDelta?: (text: string) => void
): { result: ToolCallingResult; nonStreaming: boolean; delayMs?: number; streamAfterAbort: boolean } {
  const stub = echoToolCallingStubs.shift();
  if (stub?.error !== undefined) {
    if (stub.streamTextBeforeFailure && onDelta) {
      try {
        onDelta(stub.streamTextBeforeFailure);
      } catch {
        // never let onDelta crash the test path.
      }
    }
    throw new Error(stub.error);
  }
  if (stub?.result) {
    return {
      result: stub.result,
      nonStreaming: Boolean(stub.nonStreaming),
      delayMs: stub.delayMs,
      streamAfterAbort: Boolean(stub.streamAfterAbort)
    };
  }
  // Default: behave like generateTaskSummary's echo branch — finish with a
  // canned text response so callers that don't pre-register stubs still see
  // a deterministic shape.
  return {
    result: {
      provider,
      text: `Gini handled: ${lastUserText}`,
      toolCalls: [],
      finishReason: "stop"
    },
    nonStreaming: false,
    streamAfterAbort: false
  };
}

// Native tool-calling entry point. Calls the provider's chat-completions
// endpoint (or codex `/responses`) with a `tools` array. Used by the chat-task
// agent loop.
//
// For codex with no tools (legacy callers), we fall back to the text-only
// `/responses` path via `callOpenAIResponses` so older code paths still work.
// With tools present, codex now uses the native function-call surface of the
// responses API (see `callToolCallingResponses`). The echo provider keeps its
// stub-driven behavior so unit tests stay deterministic.
export async function generateToolCallingResponse(
  config: RuntimeConfig,
  messages: ToolCallingMessage[],
  tools: ToolFunctionSpec[],
  onDelta?: (text: string) => void,
  // Optional per-call override. Resolved by the chat-task loop from the
  // active agent's providerName/model via resolveEffectiveContext. We do
  // NOT mutate config.provider — embeddings and the reranker still read
  // from config and must not be retargeted by agent switches. When
  // omitted, behavior matches the legacy single-provider path.
  providerOverride?: ProviderConfig,
  // Optional per-turn abort signal. Threaded into the underlying fetch + SSE
  // stream reader so cancelTask can stop the in-flight model call at the
  // source (see src/execution/turn-abort.ts). When the signal aborts mid-call
  // the fetch body read rejects with an AbortError, surfaced to the caller for
  // classification via isAbortError. Omitted callers (CLI/tests) are unaffected.
  signal?: AbortSignal,
  // Fired once per native (server-side) web search as it completes, mid-call,
  // carrying the query/url headline. Only the hosted Responses path emits these;
  // the chat-task loop turns each into a display-only "Web search" chip that must
  // land before the answer streams. Omitted callers are unaffected.
  onWebSearch?: (query: string) => void
): Promise<ToolCallingResult> {
  const provider = normalizeProvider(providerOverride ?? config.provider);
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const lastUserText = typeof lastUser?.content === "string" ? lastUser.content : "";

  if (provider.name === "echo") {
    echoToolCallingCalls.push(messages.map((m) => ({ ...m })));
    echoToolCallingToolNames.push(tools.map((t) => t.function.name));
    const { result, nonStreaming, delayMs, streamAfterAbort } = nextEchoToolCallingResult(provider, lastUserText, onDelta);
    // Optional injected latency so concurrency tests can measure overlap:
    // a serial dispatch of N delayed children costs ~N*delay wall time; a
    // concurrent dispatch costs ~delay. Defaults to no delay (instant). The
    // sleep honors the abort signal so a test can cancel a turn mid-call and
    // observe the same AbortError a real provider fetch would raise — UNLESS
    // the stub set streamAfterAbort, which models a real provider that already
    // had buffered deltas on the wire: it swallows the abort and still streams
    // + returns, so the loop's defense-in-depth post-cancel flush/route guards
    // are exercised (they're unreachable via the rejecting path).
    if (delayMs && delayMs > 0) {
      if (streamAfterAbort) {
        await abortableSleep(delayMs, signal).catch(() => {});
      } else {
        await abortableSleep(delayMs, signal);
      }
    }
    // Replay any registered native web searches through onWebSearch BEFORE the
    // text delta, mirroring the real Responses stream (searches complete first),
    // so echo-backed tests exercise the chip-before-answer ordering.
    if (onWebSearch && Array.isArray(result.webSearches)) {
      for (const query of result.webSearches) {
        try {
          onWebSearch(query);
        } catch {
          // never let onWebSearch crash the test path.
        }
      }
    }
    if (result.text && onDelta && !nonStreaming) {
      // Synthesize a single streamed delta so callers exercise their
      // streaming pipelines in echo-backed tests.
      try {
        onDelta(result.text);
      } catch {
        // never let onDelta crash the test path.
      }
    }
    return result;
  }

  const dispatch = async (): Promise<ToolCallingResult> => {
    // Codex/responses API. Route to the native function-calling responses
    // path whenever tools are present OR the message history already
    // contains tool-calling traffic (assistant tool_calls / tool results).
    // The latter matters for the graceful-exhaustion summary call: it
    // passes `tools: []` but needs the prior tool transcript preserved so
    // the model can summarize what it learned. Falling back to the text-
    // only `/responses` path here would strip that transcript.
    if (provider.name === "codex") {
      if (tools.length > 0 || messagesContainToolTraffic(messages)) {
        return callToolCallingResponses(provider, messages, tools, onDelta, signal);
      }
      const systemContext = stitchSystemFromMessages(messages);
      const userInput = lastUserText || "";
      const text = await callOpenAIResponses(provider, userInput, systemContext, onDelta, undefined, signal);
      return {
        provider: text.provider,
        text: text.text,
        toolCalls: [],
        finishReason: "stop",
        responseId: text.responseId,
        usage: text.usage,
        cost: text.cost
      };
    }

    if (provider.name === "anthropic") {
      return callAnthropicMessages(provider, messages, tools, onDelta, undefined, signal);
    }

    if (provider.name === "bedrock") {
      // Bedrock is the failure-prone leg of the chat loop (region capacity, 5xx,
      // throttling, mid-stream resets). When a first-party Anthropic key is on
      // hand and the model has an Anthropic-API mirror, race the two so a turn
      // never stalls on a Bedrock hiccup; otherwise this is a plain Converse call.
      return raceBedrockWithAnthropic(provider, messages, tools, onDelta, signal);
    }

    // Hosted gini (openai/azure at the edge): run the turn on the Responses API
    // so the built-in web_search tool is on by default — the model searches the
    // live web mid-turn and cites sources, with no tenant search key. Everything
    // else stays on Chat Completions.
    if (shouldUseResponsesWebSearch(provider)) {
      return callResponsesWithWebSearch(provider, messages, tools, onDelta, signal, onWebSearch);
    }

    // Chat Completions is the default openai/azure tool-calling path. A gpt-5.x
    // deployment rejects function tools + reasoning_effort here and demands the
    // Responses API (a 400 whose message names /v1/responses). That surfaces on
    // the hosted edge for a guest whose GINI_HOSTED marker is unset — older
    // provisioning that the /app-only fleet roll can't rewrite. Retry that exact
    // failure on the Responses path so the turn succeeds instead of hard-failing;
    // only openai/azure providers can hit it, and the error is specific enough
    // that a normal turn is never re-routed.
    try {
      return await callToolCallingChatCompletions(provider, messages, tools, onDelta, signal);
    } catch (error) {
      if (
        (provider.name === "openai" || provider.name === "azure") &&
        isResponsesApiRequiredError(error)
      ) {
        return callResponsesWithWebSearch(provider, messages, tools, onDelta, signal, onWebSearch);
      }
      throw error;
    }
  };
  try {
    return await dispatch();
  } catch (error) {
    // A turn-abort (cancelTask aborted the in-flight call) must pass through
    // untouched: it is neither an auth failure nor a context overflow, and the
    // chat-task loop classifies it via isAbortError to bail to the cancelled
    // terminal path. Re-tagging it as ProviderAuthError would falsely record a
    // needs-reauth state on a perfectly healthy credential.
    if (isAbortError(error)) throw error;
    // Pin auth attribution to the provider resolved at THIS call's entry.
    // The chat-task wraps tag with the loop's effective-context snapshot,
    // but an instance-sourced call late-binds config.provider above — a
    // provider switch landing mid-turn (Settings POST or the agent's own
    // set_provider) would otherwise let an untyped 401 from the OLD
    // provider be recorded under the NEW provider's needs-reauth key.
    // Typed errors (anthropic/bedrock/codex local throws, codex session
    // errors) already carry the correct hard-coded name and pass through.
    const message = error instanceof Error ? error.message : String(error);
    if (!(error instanceof ProviderAuthError) && isAuthExpiredError(message)) {
      throw new ProviderAuthError(provider.name, message);
    }
    throw error;
  }
}

// Bedrock↔Anthropic failover for the chat tool-calling path.
//
// Why: Amazon Bedrock is the flakiest leg of the chat loop — regional capacity
// shortfalls, 5xx storms, throttling, and mid-stream connection resets all show
// up as a stalled or crashed turn. The first-party Anthropic Messages API serves
// the exact same Claude models (Bedrock's us/eu/apac/global ids are inference
// profiles over the identical model), so when an ANTHROPIC_API_KEY is available
// we can run both and let whichever succeeds answer the turn.
//
// Primitive: Promise.any, NOT Promise.race. Promise.race settles on the FIRST
// promise to *settle* — a fast Bedrock rejection would lose us the turn even
// though Anthropic was about to succeed. Promise.any resolves on the first to
// *succeed* and only rejects if BOTH reject, which is exactly the failover we
// want: a fast failure on one provider is absorbed as long as the other answers.
//
// Both calls run to completion. We deliberately do NOT abort the other provider
// the moment one starts streaming: a stream-leader that crashes mid-stream still
// needs a live backup that ran far enough to return a complete result. We only
// abort both in the finally — once the turn has its answer (or both failed),
// the loser is pure waste and gets cancelled to free the socket.
//
// Stream gating: with two providers potentially emitting deltas, the visible
// token stream must come from exactly one of them or it interleaves into
// garbage. The first provider to emit a delta claims the stream; the other's
// deltas are dropped. onDelta is also fully shielded — a throw from the caller's
// delta sink can never escape into a child call and turn a healthy provider into
// a spurious rejection.
//
// Generality: the mirror model is resolved via anthropicMirrorModelId (the
// MODEL_ALIASES table in model-routes.ts), so this covers every aliased Claude
// model + region profile, not a single hardcoded id. A Bedrock model with no
// first-party equivalent simply falls through to a plain Converse call.
//
// No-op fallback (plain callBedrockConverse, zero behavior change) unless ALL of:
//   1. the provider is bedrock,
//   2. ANTHROPIC_API_KEY is set (the mirror leg can authenticate), and
//   3. the Bedrock model has an Anthropic-API mirror in MODEL_ALIASES.
async function raceBedrockWithAnthropic(
  provider: ProviderConfig,
  messages: ToolCallingMessage[],
  tools: ToolFunctionSpec[],
  onDelta?: (text: string) => void,
  signal?: AbortSignal
): Promise<ToolCallingResult> {
  const mirrorModel = anthropicMirrorModelId(provider.model);
  // Gate: only race when a first-party key exists AND the model has a mirror.
  // Otherwise behave exactly like the legacy single-provider Bedrock path.
  if (!process.env.ANTHROPIC_API_KEY || !mirrorModel) {
    return callBedrockConverse(provider, messages, tools, onDelta, undefined, signal);
  }

  const anthropicProvider: ProviderConfig = {
    name: "anthropic",
    model: mirrorModel,
    baseUrl: DEFAULT_ANTHROPIC_BASE_URL,
    apiKeyEnv: "ANTHROPIC_API_KEY"
  };

  // One controller per leg so the finally can cancel the loser independently of
  // the outer turn. The outer signal (cancelTask) aborts BOTH at once.
  const bedrockController = new AbortController();
  const anthropicController = new AbortController();
  const onOuterAbort = (): void => {
    bedrockController.abort(signal?.reason);
    anthropicController.abort(signal?.reason);
  };
  if (signal) {
    if (signal.aborted) onOuterAbort();
    else signal.addEventListener("abort", onOuterAbort, { once: true });
  }

  // Stream gate: the first leg to emit claims the visible stream; the other's
  // deltas are dropped so the two providers never interleave on the wire. The
  // wrapper also swallows any onDelta throw so a caller-side sink error can't
  // reject the child call (which would falsely fail a healthy provider).
  let streamOwner: "bedrock" | "anthropic" | null = null;
  const gatedDelta = (leg: "bedrock" | "anthropic"): ((text: string) => void) | undefined => {
    if (!onDelta) return undefined;
    return (text: string): void => {
      if (streamOwner === null) streamOwner = leg;
      if (streamOwner !== leg) return;
      try {
        onDelta(text);
      } catch {
        // Never let a delta-sink throw escape into the child call.
      }
    };
  };

  const bedrockPromise = callBedrockConverse(
    provider,
    messages,
    tools,
    gatedDelta("bedrock"),
    undefined,
    bedrockController.signal
  );
  const anthropicPromise = callAnthropicMessages(
    anthropicProvider,
    messages,
    tools,
    gatedDelta("anthropic"),
    undefined,
    anthropicController.signal
  );
  // Settle the loser's rejection so it can't surface as an unhandled rejection
  // once Promise.any has already resolved from the winner.
  bedrockPromise.catch(() => {});
  anthropicPromise.catch(() => {});

  try {
    return await Promise.any([bedrockPromise, anthropicPromise]);
  } catch (error) {
    // Promise.any only throws once BOTH legs reject, wrapped in an AggregateError.
    // If the outer turn was cancelled, surface the abort so the chat-task loop
    // routes to its cancelled terminal path rather than a provider failure.
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException("Aborted", "AbortError");
    }
    const errors = error instanceof AggregateError ? error.errors : [error];
    // Prefer the first non-abort error, and prefer the Bedrock one: the existing
    // auth/region classifier keys on a ProviderAuthError tagged "bedrock", and a
    // genuine Bedrock failure is the more actionable signal for a bedrock turn.
    const nonAbort = errors.filter((e) => !isAbortError(e));
    const bedrockErr = nonAbort.find((e) => e instanceof ProviderAuthError && e.provider === "bedrock");
    throw bedrockErr ?? nonAbort[0] ?? errors[0] ?? error;
  } finally {
    if (signal) signal.removeEventListener("abort", onOuterAbort);
    // The turn is decided (won or both-failed): cancel the loser to free its
    // socket. Aborting an already-settled call is a no-op.
    bedrockController.abort();
    anthropicController.abort();
  }
}

// True when the message array carries assistant `tool_calls` entries or
// `tool` result messages. Used to decide whether the codex routing must
// preserve the full Responses-API tool transcript even when the caller
// passes an empty tools list (e.g. the iteration-cap summary turn).
function messagesContainToolTraffic(messages: ToolCallingMessage[]): boolean {
  for (const message of messages) {
    if (message.role === "tool") return true;
    if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      return true;
    }
  }
  return false;
}

// When falling back to the responses API for codex, collapse all `system`
// messages into one instructions block. tool/assistant messages are dropped
// since the responses path doesn't model them.
function stitchSystemFromMessages(messages: ToolCallingMessage[]): string {
  return messages
    .filter((m) => m.role === "system" && typeof m.content === "string")
    .map((m) => m.content as string)
    .join("\n\n");
}

async function callToolCallingChatCompletions(
  provider: ProviderConfig,
  messages: ToolCallingMessage[],
  tools: ToolFunctionSpec[],
  onDelta?: (text: string) => void,
  signal?: AbortSignal
): Promise<ToolCallingResult> {
  const envName = provider.apiKeyEnv ?? "OPENAI_API_KEY";
  const apiKey = provider.name === "local" ? process.env[envName] : readOpenAIBearer(provider);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...chatCompletionsAuthHeader(provider, apiKey),
    ...(provider.name === "openrouter" ? { "HTTP-Referer": "http://127.0.0.1:7337", "X-Title": "Gini Agent" } : {})
  };
  const baseUrl = resolveBaseUrl(provider.baseUrl, defaultBaseUrl(provider));
  const wantStream = Boolean(onDelta);
  const safeMessages = stripDocumentPartsIfUnsupported(messages, provider);
  const body: Record<string, unknown> = {
    ...sanitizeExtraBody(provider.extraBody),
    model: provider.model,
    messages: safeMessages.map(serializeChatMessage),
    stream: wantStream,
    // Pin the default (non-extended) prompt cache tier on every
    // OpenAI-compatible chat-completions call. "in_memory" is what the
    // OpenAI docs document for prompts ≥ 1024 tokens (5–10 min idle, 1
    // hour max) — explicitly NOT "24h", which is documented as not
    // Zero Data Retention eligible. openrouter / deepseek / local
    // accept-but-ignore unknown fields, so the value is a no-op there.
    // Codex never hits this builder.
    ...promptCacheRetentionBody(provider)
  };
  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  const response = await fetch(chatCompletionsUrl(provider, baseUrl), {
    method: "POST",
    headers: { ...headers, ...(wantStream ? { accept: "text/event-stream" } : {}) },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {})
  });

  if (wantStream) {
    return readToolCallingStream(response, provider, onDelta, signal);
  }

  const rawPayload = await response.text();
  const payload = parseJsonObject(rawPayload);
  if (!response.ok) {
    const fallback = rawPayload.slice(0, 500) || `Tool-calling request failed with HTTP ${response.status}`;
    throw new Error(readOpenAIError(payload) ?? fallback);
  }
  return extractToolCallingResult(payload, provider);
}

function serializeChatMessage(message: ToolCallingMessage): Record<string, unknown> {
  // OpenAI chat-completions accepts the wire shape directly. Strip
  // undefined fields so they don't leak into the JSON body. A content
  // array carrying `document` parts is the one shape that doesn't map
  // 1:1 — translate those into the OpenAI/OpenRouter `file` part shape
  // (text/image_url pass through unchanged).
  const content = Array.isArray(message.content)
    ? serializeChatContentParts(message.content)
    : message.content;
  const out: Record<string, unknown> = { role: message.role, content };
  if (message.name !== undefined) out.name = message.name;
  if (message.tool_call_id !== undefined) out.tool_call_id = message.tool_call_id;
  if (message.tool_calls !== undefined) out.tool_calls = message.tool_calls;
  return out;
}

function serializeChatContentParts(parts: MessageContentPart[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const part of parts) {
    if (part.type === "document") {
      out.push({
        type: "file",
        file: {
          filename: part.document.filename,
          file_data: `data:${part.document.mimeType};base64,${part.document.data}`
        }
      });
      continue;
    }
    // text / image_url already match the chat-completions wire shape.
    out.push(part as unknown as Record<string, unknown>);
  }
  return out;
}

function extractToolCallingResult(
  payload: Record<string, unknown>,
  provider: ProviderConfig
): ToolCallingResult {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const first = choices.find(isRecord);
  const message = first && isRecord(first.message) ? first.message : undefined;
  const text = typeof message?.content === "string" ? message.content : "";
  const toolCalls = extractToolCalls(message);
  const finishReason = normalizeFinishReason(typeof first?.finish_reason === "string" ? first.finish_reason : undefined);
  return {
    provider,
    text,
    toolCalls,
    finishReason,
    responseId: typeof payload.id === "string" ? payload.id : undefined,
    usage: isRecord(payload.usage) ? payload.usage : undefined,
    cost: estimateCost(provider, isRecord(payload.usage) ? payload.usage : undefined)
  };
}

function extractToolCalls(message: Record<string, unknown> | undefined): ToolCall[] {
  if (!message) return [];
  const raw = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const out: ToolCall[] = [];
  for (const call of raw) {
    if (!isRecord(call)) continue;
    const id = typeof call.id === "string" ? call.id : "";
    const fn = isRecord(call.function) ? call.function : undefined;
    const name = fn && typeof fn.name === "string" ? fn.name : "";
    const args = fn && typeof fn.arguments === "string" ? fn.arguments : "";
    if (!id || !name) continue;
    out.push({ id, type: "function", function: { name, arguments: args } });
  }
  return out;
}

function normalizeFinishReason(value: string | undefined): ToolCallingResult["finishReason"] {
  if (value === "stop" || value === "tool_calls" || value === "length" || value === "content_filter") return value;
  return "unknown";
}

// Map the Responses API's incomplete_details.reason to a finishReason. A turn
// cut short by the output cap arrives as status "incomplete" with reason
// "max_output_tokens" and must surface as "length"; a filtered one as
// "content_filter". Without this a truncated Responses turn with no tool calls
// would be synthesized as a clean "stop", hiding the truncation from the loop
// (OPE-67). Any other/absent reason falls back to "stop".
function mapResponsesIncompleteReason(reason: string | undefined): ToolCallingResult["finishReason"] {
  if (reason === "max_output_tokens") return "length";
  if (reason === "content_filter") return "content_filter";
  return "stop";
}

// Streaming tool-calling: many compat providers send tool_call argument
// chunks across multiple SSE events. We accumulate per-index buffers and
// emit completed tool calls only when the stream finishes.
async function readToolCallingStream(
  response: Response,
  provider: ProviderConfig,
  onDelta?: (text: string) => void,
  signal?: AbortSignal
): Promise<ToolCallingResult> {
  if (!response.ok) {
    const raw = await response.text();
    const payload = parseJsonObject(raw);
    const fallback = raw.slice(0, 500) || `Tool-calling stream failed with HTTP ${response.status}`;
    throw new Error(readOpenAIError(payload) ?? fallback);
  }
  const body = response.body;
  if (!body) throw new Error("Tool-calling stream returned no response body.");
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  const textParts: string[] = [];
  // Index → in-progress tool call. The chat-completions stream sends
  // tool_calls as deltas indexed by position. Final id/name arrive in the
  // first delta for that index; arguments stream in subsequent deltas.
  const callsByIndex = new Map<number, ToolCall>();
  let finishReason: ToolCallingResult["finishReason"] = "unknown";
  let responseId: string | undefined;
  let usage: Record<string, unknown> | undefined;

  const handleEvent = (block: string): void => {
    const lines = block.split(/\r?\n/);
    const dataLines = lines.filter((line) => line.startsWith("data:"));
    if (dataLines.length === 0) return;
    const data = dataLines.map((line) => line.slice("data:".length).trim()).join("\n");
    if (!data || data === "[DONE]") return;
    const payload = parseJsonObject(data);
    if (!responseId && typeof payload.id === "string") responseId = payload.id;
    if (isRecord(payload.usage)) usage = payload.usage;
    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    for (const choice of choices) {
      if (!isRecord(choice)) continue;
      if (typeof choice.finish_reason === "string") {
        finishReason = normalizeFinishReason(choice.finish_reason);
      }
      const delta = isRecord(choice.delta) ? choice.delta : undefined;
      if (!delta) continue;
      if (typeof delta.content === "string" && delta.content.length > 0) {
        textParts.push(delta.content);
        if (onDelta) {
          try {
            onDelta(delta.content);
          } catch {
            // never abort the stream consumer on a UI-side error
          }
        }
      }
      const tcs = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      for (const tc of tcs) {
        if (!isRecord(tc)) continue;
        const idx = typeof tc.index === "number" ? tc.index : 0;
        const existing = callsByIndex.get(idx) ?? { id: "", type: "function" as const, function: { name: "", arguments: "" } };
        if (typeof tc.id === "string" && tc.id.length > 0) existing.id = tc.id;
        const fn = isRecord(tc.function) ? tc.function : undefined;
        if (fn) {
          if (typeof fn.name === "string" && fn.name.length > 0) existing.function.name = fn.name;
          if (typeof fn.arguments === "string") existing.function.arguments += fn.arguments;
        }
        callsByIndex.set(idx, existing);
      }
    }
  };

  // try/finally so an abort (reader.read() rejects with AbortError) or a throw
  // from handleEvent releases the reader lock on the response body, matching
  // the codex/anthropic/bedrock readers. The top-of-loop guard makes a
  // pending abort deterministic; the finally covers the in-flight-read abort.
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      const { value, done } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (block.trim().length > 0) handleEvent(block);
        boundary = buffer.indexOf("\n\n");
      }
      if (done) break;
    }
    buffer += decoder.decode();
    if (buffer.trim().length > 0) handleEvent(buffer);

    const toolCalls: ToolCall[] = [];
    // Preserve original index ordering.
    const sortedIndices = [...callsByIndex.keys()].sort((a, b) => a - b);
    for (const idx of sortedIndices) {
      const call = callsByIndex.get(idx)!;
      if (call.id && call.function.name) toolCalls.push(call);
    }

    return {
      provider,
      text: textParts.join("").trim(),
      toolCalls,
      finishReason,
      responseId,
      usage,
      cost: estimateCost(provider, usage)
    };
  } finally {
    try {
      await reader.cancel();
    } catch {}
  }
}

// Codex/Responses-API tool-calling. Translates the chat-completions message
// shape used by the rest of the loop into the Responses API input shape:
//   - All `system` messages → concatenated `instructions` field
//   - `user` messages → { role: "user", content: [{ type: "input_text", text }] }
//   - `assistant` text → { role: "assistant", content: [{ type: "output_text", text }] }
//   - `assistant` tool_calls → { type: "function_call", call_id, name, arguments }
//   - `tool` results → { type: "function_call_output", call_id, output }
// Tools are flattened from the chat-completions `{ type, function: {...} }`
// shape into the Responses API `{ type: "function", name, description,
// parameters, strict: false }` shape.
async function callToolCallingResponses(
  provider: ProviderConfig,
  messages: ToolCallingMessage[],
  tools: ToolFunctionSpec[],
  onDelta?: (text: string) => void,
  signal?: AbortSignal
): Promise<ToolCallingResult> {
  // The retry closure re-reads the bearer on every attempt so a token
  // rotation between attempts (the codex CLI just wrote a new auth.json)
  // gets picked up automatically. translateMessagesToResponsesInput is
  // deterministic and cheap; recomputing on retry is fine.
  return withCodexSessionRetry(async () => {
    const bearer = readCodexBearer(provider);
    const baseUrl = resolveBaseUrl(provider.baseUrl, defaultBaseUrl(provider));
    const safeMessages = stripDocumentPartsIfUnsupported(messages, provider);
    const { instructions, input } = translateMessagesToResponsesInput(safeMessages);
    const responsesTools = tools.map((tool) => ({
      type: "function" as const,
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
      strict: false
    }));
    const body: Record<string, unknown> = {
      model: provider.model,
      store: false,
      stream: true,
      instructions,
      input
    };
    if (responsesTools.length > 0) body.tools = responsesTools;

    const response = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
        accept: "text/event-stream",
        ...codexHeaders(bearer)
      },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {})
    });

    return readResponsesToolCallingStream(response, provider, onDelta, signal);
  }, signal);
}

interface ResponsesInputShape {
  instructions: string;
  input: Array<Record<string, unknown>>;
}

function translateMessagesToResponsesInput(messages: ToolCallingMessage[]): ResponsesInputShape {
  const systemParts: string[] = [];
  const input: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === "system") {
      if (typeof message.content === "string" && message.content.length > 0) {
        systemParts.push(message.content);
      }
      continue;
    }
    if (message.role === "user") {
      // Vision-capable user messages arrive as a parts array (text +
      // image_url). Map text parts → input_text and image_url parts →
      // input_image, mirroring the OpenAI Responses API content schema.
      if (Array.isArray(message.content)) {
        const parts: Array<Record<string, unknown>> = [];
        for (const part of message.content) {
          if (part.type === "text") parts.push({ type: "input_text", text: part.text });
          else if (part.type === "image_url") parts.push({ type: "input_image", image_url: part.image_url.url });
          else if (part.type === "document") {
            parts.push({
              type: "input_file",
              filename: part.document.filename,
              file_data: `data:${part.document.mimeType};base64,${part.document.data}`
            });
          }
        }
        input.push({ role: "user", content: parts });
        continue;
      }
      const text = typeof message.content === "string" ? message.content : "";
      input.push({
        role: "user",
        content: [{ type: "input_text", text }]
      });
      continue;
    }
    if (message.role === "assistant") {
      // Emit any tool calls first as discrete function_call items so the
      // model sees the same item ordering it produced.
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      if (toolCalls.length === 0) {
        const text = typeof message.content === "string" ? message.content : "";
        if (text.length > 0) {
          input.push({
            role: "assistant",
            content: [{ type: "output_text", text }]
          });
        }
        continue;
      }
      // Some assistants emit text + tool_calls in the same message. Preserve
      // the text first if present, then the function_call entries.
      const text = typeof message.content === "string" ? message.content : "";
      if (text.length > 0) {
        input.push({
          role: "assistant",
          content: [{ type: "output_text", text }]
        });
      }
      for (const call of toolCalls) {
        input.push({
          type: "function_call",
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments ?? ""
        });
      }
      continue;
    }
    if (message.role === "tool") {
      const callId = message.tool_call_id ?? "";
      const output = typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "");
      input.push({
        type: "function_call_output",
        call_id: callId,
        output
      });
      continue;
    }
  }
  return { instructions: systemParts.join("\n\n"), input };
}

// The headline text for a native web_search_call, read from its `action`:
// a `search` action carries `query` (or a `queries[]` list); a page-open or
// find action carries `url`/`pattern`. Empty string when the action has no
// such field (a search still happened — the chip just has no headline) so the
// caller always records the call; undefined only when there's no action object
// at all (an in-progress item), which the caller skips.
function webSearchCallHeadline(action: unknown): string | undefined {
  if (!isRecord(action) || Array.isArray(action)) return undefined;
  if (typeof action.query === "string" && action.query.length > 0) return action.query;
  if (Array.isArray(action.queries) && typeof action.queries[0] === "string" && action.queries[0].length > 0) {
    return action.queries[0];
  }
  if (typeof action.url === "string" && action.url.length > 0) return action.url;
  if (typeof action.pattern === "string" && action.pattern.length > 0) return action.pattern;
  return "";
}

// Consume the Responses API SSE stream. Tracks text deltas
// (`response.output_text.delta`), function-call lifecycle events
// (`response.output_item.added` / `response.function_call_arguments.delta` /
// `response.output_item.done`), and native web-search activity
// (`web_search_call` items — collected into result.webSearches AND announced via
// onWebSearch as each completes, never surfaced as dispatchable tool calls).
// Falls back to the final `response.completed` event's `response.output` array
// if any tool calls or web searches were missed during streaming.
async function readResponsesToolCallingStream(
  response: Response,
  provider: ProviderConfig,
  onDelta?: (text: string) => void,
  signal?: AbortSignal,
  // Fired once per native web_search_call the moment it completes — which the
  // Responses API always streams BEFORE the assistant message's text deltas.
  // The chat-task loop emits a "Web search" chip here so the chip's block lands
  // ahead of the answer block (born lazily on the first text delta); a trailing
  // chip would push the answer out of its standalone bubble in group-exchanges.
  onWebSearch?: (query: string) => void
): Promise<ToolCallingResult> {
  if (!response.ok) {
    const raw = await response.text();
    const payload = parseJsonObject(raw);
    const fallback = raw.slice(0, 500) || `Codex tool-calling stream failed with HTTP ${response.status}`;
    const message = readOpenAIError(payload) ?? fallback;
    // Initial 401 with a session-expired body comes from auth.json holding
    // a token that was rotated before the request even left gini. Surface
    // it as the retryable sentinel so withCodexSessionRetry picks up the
    // freshly-rotated token on its second attempt.
    if (response.status === 401 && isCodexSessionExpiredMessage(message)) {
      throw new CodexSessionExpiredError(message);
    }
    throw new Error(message);
  }
  const body = response.body;
  if (!body) throw new Error("Codex tool-calling stream returned no response body.");
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  const textParts: string[] = [];
  // item_id → in-progress function call. The Responses API streams
  // function-call argument deltas keyed by item_id; we accumulate into
  // these entries and surface the final list when the stream completes.
  const callsById = new Map<string, { id: string; name: string; arguments: string; order: number }>();
  let nextOrder = 0;
  // Native web_search activity. The Responses API runs the search server-side
  // and emits `web_search_call` items (never `function_call`), so the loop never
  // dispatches them — each is collected into result.webSearches AND announced via
  // onWebSearch the moment it completes, so the chat-task loop can emit a "Web
  // search" chip before the answer streams. The fired set dedupes an item that
  // arrives both as an `output_item.done` event and again in the
  // `response.completed` backstop below.
  const webSearches: string[] = [];
  const firedWebSearchItems = new Set<string>();
  const noteWebSearchCall = (itemId: string, action: unknown): void => {
    if (!itemId || firedWebSearchItems.has(itemId)) return;
    const headline = webSearchCallHeadline(action);
    if (headline === undefined) return;
    firedWebSearchItems.add(itemId);
    webSearches.push(headline);
    if (onWebSearch) {
      try {
        onWebSearch(headline);
      } catch {
        // never abort the stream consumer on a UI-side error
      }
    }
  };
  let responseId: string | undefined;
  let usage: Record<string, unknown> | undefined;
  let finalOutput: unknown[] | undefined;
  // Set when a terminal event reports status "incomplete" (e.g. output-cap
  // truncation). Drives the finishReason so a cut-off turn isn't mislabeled a
  // clean stop. See mapResponsesIncompleteReason (OPE-67).
  let incompleteReason: string | undefined;
  // True once onDelta has actually fired with a text chunk. textParts
  // and callsById are internal accumulation — nothing in them reaches
  // the caller until this function returns successfully — so they
  // do NOT count as emitted output for the safe-retry decision.
  let emittedToCaller = false;

  const handleEvent = (block: string): void => {
    const lines = block.split(/\r?\n/);
    let eventType: string | undefined;
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventType = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trim());
      }
    }
    if (dataLines.length === 0) return;
    const data = dataLines.join("\n");
    if (!data || data === "[DONE]") return;
    const payload = parseJsonObject(data);
    const type = typeof payload.type === "string" ? payload.type : eventType;
    if (!type) return;

    // Capture top-level metadata when present.
    if (typeof payload.response_id === "string") responseId = payload.response_id;
    if (isRecord(payload.response)) {
      const resp = payload.response;
      if (!responseId && typeof resp.id === "string") responseId = resp.id;
      if (isRecord(resp.usage)) usage = resp.usage;
      if (Array.isArray(resp.output)) finalOutput = resp.output;
      if (isRecord(resp.incomplete_details) && typeof resp.incomplete_details.reason === "string") {
        incompleteReason = resp.incomplete_details.reason;
      }
    }

    // Backend-emitted error events (session rotation mid-stream, request-
    // level failures, content-policy aborts). Throwing here unwinds the
    // SSE consumer loop; if onDelta has not yet fired (no caller-visible
    // bytes), withCodexSessionRetry can re-read auth.json and retry
    // transparently. Once a delta has landed in the caller's UI we can't
    // safely retry without double-emitting, so the generic Error path
    // runs even on session-expired mid-stream.
    if (eventType === "error" || type === "error" || type === "response.failed") {
      const message = extractStreamErrorMessage(payload)
        ?? `Codex tool-calling stream errored before completion (${type ?? "unknown"}).`;
      if (isCodexSessionExpiredMessage(message) && !emittedToCaller) {
        throw new CodexSessionExpiredError(message);
      }
      throw new Error(message);
    }

    if (type === "response.output_text.delta") {
      const delta = typeof payload.delta === "string" ? payload.delta : "";
      if (delta.length > 0) {
        textParts.push(delta);
        if (onDelta) {
          emittedToCaller = true;
          try {
            onDelta(delta);
          } catch {
            // never abort the stream consumer on a UI-side error
          }
        }
      }
      return;
    }

    if (type === "response.output_item.added") {
      const item = isRecord(payload.item) ? payload.item : undefined;
      if (item && item.type === "function_call") {
        const itemId = typeof item.id === "string" ? item.id : (typeof payload.item_id === "string" ? payload.item_id : "");
        const callId = typeof item.call_id === "string" ? item.call_id : itemId;
        const name = typeof item.name === "string" ? item.name : "";
        const args = typeof item.arguments === "string" ? item.arguments : "";
        const key = itemId || callId;
        if (key && !callsById.has(key)) {
          callsById.set(key, { id: callId, name, arguments: args, order: nextOrder++ });
        }
      }
      return;
    }

    if (type === "response.function_call_arguments.delta") {
      const delta = typeof payload.delta === "string" ? payload.delta : "";
      const itemId = typeof payload.item_id === "string" ? payload.item_id : "";
      if (itemId) {
        const existing = callsById.get(itemId) ?? { id: itemId, name: "", arguments: "", order: nextOrder++ };
        existing.arguments += delta;
        callsById.set(itemId, existing);
      }
      return;
    }

    if (type === "response.function_call_arguments.done") {
      const itemId = typeof payload.item_id === "string" ? payload.item_id : "";
      const finalArgs = typeof payload.arguments === "string" ? payload.arguments : undefined;
      if (itemId && finalArgs !== undefined) {
        const existing = callsById.get(itemId);
        if (existing) {
          existing.arguments = finalArgs;
          callsById.set(itemId, existing);
        } else {
          callsById.set(itemId, { id: itemId, name: "", arguments: finalArgs, order: nextOrder++ });
        }
      }
      return;
    }

    if (type === "response.output_item.done") {
      const item = isRecord(payload.item) ? payload.item : undefined;
      // Native web search: the completed item carries the `action` (query/url);
      // the earlier `added` event does not, so record it from the done event.
      if (item && item.type === "web_search_call") {
        const itemId = typeof item.id === "string" ? item.id : (typeof payload.item_id === "string" ? payload.item_id : "");
        noteWebSearchCall(itemId, item.action);
        return;
      }
      if (item && item.type === "function_call") {
        const itemId = typeof item.id === "string" ? item.id : (typeof payload.item_id === "string" ? payload.item_id : "");
        const callId = typeof item.call_id === "string" ? item.call_id : itemId;
        const name = typeof item.name === "string" ? item.name : "";
        const args = typeof item.arguments === "string" ? item.arguments : "";
        const key = itemId || callId;
        if (key) {
          const existing = callsById.get(key) ?? { id: callId, name, arguments: args, order: nextOrder++ };
          if (callId) existing.id = callId;
          if (name) existing.name = name;
          if (args.length > 0) existing.arguments = args;
          callsById.set(key, existing);
        }
      }
      return;
    }

    if (type === "response.completed") {
      // Backstop: the final completed event carries the full `response.output`
      // array. Capture it for fallback reconstruction below.
      if (isRecord(payload.response) && Array.isArray(payload.response.output)) {
        finalOutput = payload.response.output;
      }
      return;
    }
  };

  // Stream consumption wraps in try/finally so a throw from handleEvent
  // (e.g. session-expired classification mid-stream) cancels the reader
  // before withCodexSessionRetry constructs attempt 2. Without this,
  // attempt 1's reader stays locked to the response body and the
  // underlying socket can linger while a parallel attempt is already
  // in flight.
  try {
    while (true) {
      // Turn-abort: the fetch cancels and reader.read() rejects with an
      // AbortError; this guard makes the stop deterministic and releases the
      // reader (the finally below also cancels on throw).
      if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      const { value, done } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (block.trim().length > 0) handleEvent(block);
        boundary = buffer.indexOf("\n\n");
      }
      if (done) break;
    }
    buffer += decoder.decode();
    if (buffer.trim().length > 0) handleEvent(buffer);

    // Backstop: if SSE delivery missed function_call items but the final
    // `response.completed` event carries them, reconstruct from there.
    if (finalOutput) {
      let backstopText = "";
      for (const item of finalOutput) {
        if (!isRecord(item)) continue;
        if (item.type === "function_call") {
          const itemId = typeof item.id === "string" ? item.id : "";
          const callId = typeof item.call_id === "string" ? item.call_id : itemId;
          const name = typeof item.name === "string" ? item.name : "";
          const args = typeof item.arguments === "string" ? item.arguments : "";
          const key = itemId || callId;
          if (!key) continue;
          const existing = callsById.get(key);
          if (!existing) {
            callsById.set(key, { id: callId, name, arguments: args, order: nextOrder++ });
          } else {
            if (!existing.id && callId) existing.id = callId;
            if (!existing.name && name) existing.name = name;
            if (existing.arguments.length === 0 && args.length > 0) existing.arguments = args;
          }
        }
        // Backstop for native web searches whose `output_item.done` was missed
        // mid-stream — the fired set makes this a no-op for ones already surfaced.
        if (item.type === "web_search_call") {
          const itemId = typeof item.id === "string" ? item.id : "";
          noteWebSearchCall(itemId, item.action);
        }
        // Some responses also embed assistant text in output items as
        // { type: "message", content: [{ type: "output_text", text }] }
        if (item.type === "message" && Array.isArray(item.content)) {
          for (const c of item.content) {
            if (isRecord(c) && c.type === "output_text" && typeof c.text === "string") {
              backstopText += c.text;
            }
          }
        }
      }
      // Only use backstop text if streaming missed all of it.
      if (textParts.length === 0 && backstopText.length > 0) {
        textParts.push(backstopText);
      }
    }

    const ordered = [...callsById.values()].sort((a, b) => a.order - b.order);
    const toolCalls: ToolCall[] = [];
    for (const call of ordered) {
      if (!call.id || !call.name) continue;
      toolCalls.push({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments }
      });
    }

    // Backstop: codex sometimes emits tool calls as literal `<tool_call>`
    // markup in the assistant text channel instead of (or in addition to)
    // structured function_call items. Recover those so the chat-task loop
    // can dispatch them. The structured shape wins on dedup, so a model
    // that emits both an SSE function_call and a text mirror only fires
    // the call once.
    const joinedText = textParts.join("");
    const extracted = extractTextToolCallsFromAssistantText(joinedText, toolCalls);
    for (const call of extracted.calls) {
      toolCalls.push(call);
    }
    const finalText = extracted.residual;

    const finishReason: ToolCallingResult["finishReason"] =
      toolCalls.length > 0 ? "tool_calls" : mapResponsesIncompleteReason(incompleteReason);
    return {
      provider,
      text: finalText.trim(),
      toolCalls,
      finishReason,
      responseId,
      usage,
      cost: estimateCost(provider, usage),
      ...(webSearches.length > 0 ? { webSearches } : {})
    };
  } finally {
    try { await reader.cancel(); } catch {}
  }
}

// ---------------- Anthropic Messages API ----------------
//
// Native /v1/messages provider. ONE builder serves both the first-party
// Claude API and Claude in Amazon Bedrock — they share an identical wire
// shape and both authenticate with a token in the x-api-key header. The only
// per-target differences are the configured baseUrl (the user includes the
// "/anthropic" path prefix for Bedrock Mantle) and which env var holds the
// token (apiKeyEnv). We deliberately do NOT use the OpenAI-compatibility shim
// (api.anthropic.com/v1/chat/completions): it drops prompt caching and ignores
// tool `strict`, and Bedrock Mantle doesn't expose it at all.
//
// Mirrors callToolCallingChatCompletions/callToolCallingResponses: stream when
// onDelta is present, otherwise parse the JSON body. No codex-style session
// retry — an env-var key has no rotation surface.

// Streaming raises max_tokens to the model's full output ceiling so a tool call
// isn't truncated mid-JSON — but on a near-full prompt that ceiling can push
// input_tokens + max_tokens past the context window and the request 400s before
// a single token streams. Clamp the streaming ceiling DOWN so it always fits the
// window, leaving the prior-context replay untouched (we shrink the *output*
// budget, never the messages). The estimate mirrors chat-task's send-time
// budgeting: estimateToolCallingMessagesTokens(messages) + serialized tool tokens.
// Only ever clamps DOWN — it never raises `resolved`, so a deliberately small
// caller value (a user-pinned extraBody.max_tokens) passes through untouched.
// The STREAM_MAX_TOKENS_FLOOR bounds the WINDOW-FIT ceiling, not the caller's
// request: on a near-full prompt where `fits` is small/negative we send at least
// the floor rather than zero/negative (that overshoot is the context-overflow
// retry path's job), but the floor can never lift a value the caller chose.
const STREAM_MAX_TOKENS_CONTEXT_MARGIN = 256;
const STREAM_MAX_TOKENS_FLOOR = 1024;
function clampStreamingMaxTokens(
  resolved: number,
  provider: ProviderConfig,
  messages: ToolCallingMessage[],
  tools: ToolFunctionSpec[]
): number {
  const contextWindow = resolveProviderContextWindowTokens(provider);
  const estimatedInputTokens =
    estimateToolCallingMessagesTokens(messages) + estimateTextTokens(JSON.stringify(tools));
  const fits = contextWindow - estimatedInputTokens - STREAM_MAX_TOKENS_CONTEXT_MARGIN;
  return Math.min(resolved, Math.max(STREAM_MAX_TOKENS_FLOOR, fits));
}

async function callAnthropicMessages(
  provider: ProviderConfig,
  messages: ToolCallingMessage[],
  tools: ToolFunctionSpec[],
  onDelta?: (text: string) => void,
  // Per-call output-token override. Vision passes its small budget; the chat
  // loop omits it and the default (or extraBody.max_tokens) applies.
  maxTokensOverride?: number,
  signal?: AbortSignal
): Promise<ToolCallingResult> {
  const baseUrl = resolveBaseUrl(provider.baseUrl, defaultBaseUrl(provider));
  // The builder owns the /v1/messages path. Tolerate a baseUrl that already
  // carries it (a common habit from OpenAI-style baseUrls that include /v1) by
  // stripping a trailing /v1 or /v1/messages first, so it never doubles into
  // /v1/v1/messages. This normalization applies to every anthropic-path target,
  // including a Bedrock Mantle Messages baseUrl.
  const messagesUrl = `${baseUrl.replace(/\/v1(\/messages)?$/, "")}/v1/messages`;
  const wantStream = Boolean(onDelta);
  const safeMessages = pairToolCallingMessages(stripDocumentPartsIfUnsupported(messages, provider));
  const { system, messages: anthropicMessages } = translateMessagesToAnthropic(safeMessages);
  const extras = sanitizeExtraBody(provider.extraBody, ANTHROPIC_RESERVED_EXTRA_BODY_KEYS);
  // Precedence: explicit per-call override (vision) > user-pinned
  // extraBody.max_tokens > model default. The model default is the model's full
  // output ceiling ONLY when streaming (a truncated tool call mid-JSON is the
  // bug this fixes); a non-streaming request keeps the conservative floor so it
  // can't trip the first-party "streaming is required for long requests" guard.
  const modelDefaultMaxTokens = wantStream ? resolveMaxOutputTokens(provider) : DEFAULT_ANTHROPIC_MAX_TOKENS;
  const resolvedMaxTokens =
    maxTokensOverride ?? (typeof extras.max_tokens === "number" ? extras.max_tokens : modelDefaultMaxTokens);
  // The raised streaming ceiling must still fit the window; clamp down only on
  // the streaming path (the non-streaming floor is already small and safe).
  const maxTokens = wantStream
    ? clampStreamingMaxTokens(resolvedMaxTokens, provider, messages, tools)
    : resolvedMaxTokens;
  const body: Record<string, unknown> = {
    ...extras,
    model: provider.model,
    messages: anthropicMessages,
    max_tokens: maxTokens,
    stream: wantStream
  };
  // `system` is stripped from extras by ANTHROPIC_RESERVED_EXTRA_BODY_KEYS, so
  // the hoisted system prompt is the only source of body.system. On a turn with
  // no system messages, body.system is simply omitted — a stray
  // extraBody.system can no longer leak through, independent of spread order.
  if (system.length > 0) body.system = system;
  const anthropicTools = translateToolsToAnthropic(tools);
  if (anthropicTools.length > 0) {
    body.tools = anthropicTools;
    body.tool_choice = { type: "auto" };
  }
  // Fine-grained tool streaming, symmetric with the Bedrock path: without it the
  // first-party Messages API also buffers a tool_use block's input JSON
  // server-side and emits nothing until the whole argument is generated, so a
  // large inline tool argument idles the stream past the socket timeout and
  // fails the turn. Here the mechanism is the HTTP `anthropic-beta` header (NOT
  // the body field Converse uses, and verified more effective than the per-tool
  // `eager_input_streaming` property). Only on a streaming Claude-4-family tool
  // turn — the beta is rejected with a 400 on models that don't support it.
  const wantFineGrainedToolStreaming =
    wantStream && anthropicTools.length > 0 && claudeSupportsFineGrainedToolStreaming(provider.model);

  const bodyJson = JSON.stringify(body);
  const response = await fetch(messagesUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": ANTHROPIC_VERSION,
      ...(wantFineGrainedToolStreaming ? { "anthropic-beta": FINE_GRAINED_TOOL_STREAMING_BETA } : {}),
      ...(wantStream ? { accept: "text/event-stream" } : {}),
      ...anthropicAuthHeaders(provider)
    },
    body: bodyJson,
    ...(signal ? { signal } : {})
  });

  if (wantStream) {
    return readAnthropicMessagesStream(response, provider, onDelta, signal);
  }

  const rawPayload = await response.text();
  const payload = parseJsonObject(rawPayload);
  if (!response.ok) {
    const fallback = rawPayload.slice(0, 500) || `Anthropic request failed with HTTP ${response.status}`;
    throw new Error(readOpenAIError(payload) ?? fallback);
  }
  return parseAnthropicMessage(payload, provider);
}

// First-party Anthropic auth: the sk-ant key in `x-api-key`. (Amazon Bedrock is
// the separate `bedrock` provider, which SigV4-signs the Converse API instead —
// see callBedrockConverse.)
function anthropicAuthHeaders(provider: ProviderConfig): Record<string, string> {
  return { "x-api-key": readAnthropicKey(provider) };
}

// Read the token for the x-api-key header from the configured env var
// (default ANTHROPIC_API_KEY). For a Bedrock Mantle target this env var holds
// a bearer minted by aws-bedrock-token-generator; the same header carries it.
// Mirrors readOpenAIBearer, but the value is NOT an Authorization: Bearer.
function readAnthropicKey(provider: ProviderConfig): string {
  const envName = provider.apiKeyEnv ?? "ANTHROPIC_API_KEY";
  const apiKey = process.env[envName];
  if (!apiKey) {
    // Typed so the chat-task classifier routes a key unset mid-turn to the
    // provider reauth CTA instead of a generic failure (mirrors bedrock).
    throw new ProviderAuthError("anthropic", `Anthropic provider is configured but ${envName} is not set.`);
  }
  return apiKey;
}


interface AnthropicTranslation {
  system: string;
  messages: Array<Record<string, unknown>>;
}

// Translate the OpenAI-shaped tool-calling transcript into the Messages API
// shape: hoist every system message to the top-level `system` string, map
// user/assistant content, fold assistant tool_calls into tool_use blocks, and
// group consecutive tool-result messages into a single user message whose
// content begins with tool_result blocks (the API requires tool_result blocks
// to lead and to immediately follow the assistant tool_use turn).
function translateMessagesToAnthropic(messages: ToolCallingMessage[]): AnthropicTranslation {
  const systemParts: string[] = [];
  const out: Array<Record<string, unknown>> = [];
  let i = 0;
  while (i < messages.length) {
    const message = messages[i];
    if (message.role === "system") {
      if (typeof message.content === "string" && message.content.length > 0) {
        systemParts.push(message.content);
      }
      i++;
      continue;
    }
    if (message.role === "tool") {
      // Collapse a run of tool results into one user message.
      const blocks: Array<Record<string, unknown>> = [];
      while (i < messages.length && messages[i].role === "tool") {
        const toolMessage = messages[i];
        blocks.push({
          type: "tool_result",
          tool_use_id: toolMessage.tool_call_id ?? "",
          content:
            typeof toolMessage.content === "string"
              ? toolMessage.content
              : JSON.stringify(toolMessage.content ?? "")
        });
        i++;
      }
      out.push({ role: "user", content: blocks });
      continue;
    }
    if (message.role === "user") {
      out.push({ role: "user", content: translateUserContent(message.content) });
      i++;
      continue;
    }
    // assistant
    const blocks: Array<Record<string, unknown>> = [];
    if (typeof message.content === "string" && message.content.length > 0) {
      blocks.push({ type: "text", text: message.content });
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === "text") blocks.push({ type: "text", text: part.text });
      }
    }
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    for (const call of toolCalls) {
      blocks.push({
        type: "tool_use",
        id: call.id,
        name: call.function.name,
        input: parseJsonObject(call.function.arguments || "{}")
      });
    }
    // A Messages assistant turn must carry at least one block.
    if (blocks.length === 0) blocks.push({ type: "text", text: "" });
    out.push({ role: "assistant", content: blocks });
    i++;
  }
  return { system: systemParts.join("\n\n"), messages: mergeConsecutiveSameRole(out) };
}

// The Messages API requires strict user/assistant alternation and rejects two
// consecutive same-role turns. Replay can legitimately produce adjacent user
// turns — a prior turn the user cancelled persists its prompt with no assistant
// answer, and the interrupt-context marker (see cancelTask) is a separate
// user-role row — so before sending we merge any run of same-role messages into
// one, concatenating their content blocks in order. (Adjacent tool-result runs
// are already collapsed above; this is the general guard for the remaining
// user/assistant cases.) Each merged message keeps the block shape the API
// expects: a string content is wrapped as a text block so heterogeneous
// (string + blocks) runs combine cleanly.
function mergeConsecutiveSameRole(
  messages: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  const merged: Array<Record<string, unknown>> = [];
  const toBlocks = (content: unknown): Array<Record<string, unknown>> => {
    if (typeof content === "string") return [{ type: "text", text: content }];
    if (Array.isArray(content)) return content as Array<Record<string, unknown>>;
    return [];
  };
  for (const message of messages) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === message.role) {
      prev.content = [...toBlocks(prev.content), ...toBlocks(message.content)];
      continue;
    }
    merged.push({ ...message, content: message.content });
  }
  return merged;
}

// Map a user message's content to the Messages content shape. A plain string
// passes through (the API accepts a bare string); a parts array maps text →
// text, image_url data URLs → base64 image blocks, and document parts →
// base64 document blocks.
function translateUserContent(
  content: string | MessageContentPart[] | null
): string | Array<Record<string, unknown>> {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const blocks: Array<Record<string, unknown>> = [];
  for (const part of content) {
    if (part.type === "text") {
      blocks.push({ type: "text", text: part.text });
    } else if (part.type === "image_url") {
      const parsed = parseDataUrl(part.image_url.url);
      if (parsed) {
        blocks.push({ type: "image", source: { type: "base64", media_type: parsed.mediaType, data: parsed.data } });
      }
    } else if (part.type === "document") {
      blocks.push({
        type: "document",
        source: { type: "base64", media_type: part.document.mimeType, data: part.document.data }
      });
    }
  }
  return blocks;
}

// Split a `data:<mime>;base64,<payload>` URL into its media type and raw
// base64 payload. Returns undefined for any other URL shape (the runtime only
// ever inlines base64 data URLs at dispatch time).
function parseDataUrl(url: string): { mediaType: string; data: string } | undefined {
  const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(url);
  if (!match) return undefined;
  return { mediaType: match[1] ?? "", data: match[2] ?? "" };
}

// Map the chat-completions tool spec to the Messages tool shape:
// {name, description, input_schema}.
function translateToolsToAnthropic(tools: ToolFunctionSpec[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters
  }));
}

// Normalize a Messages stop_reason to the loop's finishReason vocabulary.
function mapAnthropicStopReason(value: string | undefined): ToolCallingResult["finishReason"] {
  switch (value) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    default:
      return "unknown";
  }
}

// Parse a non-streamed Messages response into a ToolCallingResult: join text
// blocks, convert tool_use blocks to ToolCall (re-encoding `input` to the JSON
// arguments string the loop expects), and map stop_reason/usage.
function parseAnthropicMessage(payload: Record<string, unknown>, provider: ProviderConfig): ToolCallingResult {
  const content = Array.isArray(payload.content) ? payload.content : [];
  const textParts: string[] = [];
  const toolCalls: ToolCall[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
    } else if (block.type === "tool_use") {
      const id = typeof block.id === "string" ? block.id : "";
      const name = typeof block.name === "string" ? block.name : "";
      if (!id || !name) continue;
      toolCalls.push({
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(isRecord(block.input) ? block.input : {}) }
      });
    }
  }
  const usage = isRecord(payload.usage) ? payload.usage : undefined;
  return {
    provider,
    text: textParts.join("").trim(),
    toolCalls,
    finishReason: mapAnthropicStopReason(typeof payload.stop_reason === "string" ? payload.stop_reason : undefined),
    responseId: typeof payload.id === "string" ? payload.id : undefined,
    usage,
    cost: estimateCost(provider, usage)
  };
}

// Consume the Messages SSE stream. Events are NAMED (event: <name>) and each
// data payload repeats its own `type`. We stream text deltas (text_delta →
// onDelta) and accumulate tool_use argument fragments (input_json_delta) per
// content-block index, finalizing tool calls when the stream ends. stop_reason
// and the cumulative output token count arrive on message_delta.
async function readAnthropicMessagesStream(
  response: Response,
  provider: ProviderConfig,
  onDelta?: (text: string) => void,
  signal?: AbortSignal
): Promise<ToolCallingResult> {
  if (!response.ok) {
    const raw = await response.text();
    const payload = parseJsonObject(raw);
    const fallback = raw.slice(0, 500) || `Anthropic stream failed with HTTP ${response.status}`;
    throw new Error(readOpenAIError(payload) ?? fallback);
  }
  const body = response.body;
  if (!body) throw new Error("Anthropic stream returned no response body.");
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  const textParts: string[] = [];
  // index → in-progress content block. Only tool_use blocks accumulate (their
  // input arrives as input_json_delta fragments); text streams into textParts.
  const blocks = new Map<number, { type: string; id: string; name: string; jsonBuf: string }>();
  let finishReason: ToolCallingResult["finishReason"] = "unknown";
  let responseId: string | undefined;
  let usage: Record<string, unknown> | undefined;

  const handleEvent = (eventText: string): void => {
    const lines = eventText.split(/\r?\n/);
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trim());
    }
    if (dataLines.length === 0) return;
    const data = dataLines.join("\n");
    if (!data) return;
    const payload = parseJsonObject(data);
    const type = typeof payload.type === "string" ? payload.type : undefined;
    if (!type) return;

    if (type === "error") {
      const message =
        isRecord(payload.error) && typeof payload.error.message === "string"
          ? payload.error.message
          : "Anthropic stream errored before completion.";
      throw new Error(message);
    }
    if (type === "message_start") {
      if (isRecord(payload.message)) {
        if (typeof payload.message.id === "string") responseId = payload.message.id;
        if (isRecord(payload.message.usage)) usage = payload.message.usage;
      }
      return;
    }
    if (type === "content_block_start") {
      const index = typeof payload.index === "number" ? payload.index : 0;
      const cb = isRecord(payload.content_block) ? payload.content_block : undefined;
      blocks.set(index, {
        type: cb && typeof cb.type === "string" ? cb.type : "text",
        id: cb && typeof cb.id === "string" ? cb.id : "",
        name: cb && typeof cb.name === "string" ? cb.name : "",
        jsonBuf: ""
      });
      return;
    }
    if (type === "content_block_delta") {
      const index = typeof payload.index === "number" ? payload.index : 0;
      const delta = isRecord(payload.delta) ? payload.delta : undefined;
      if (!delta) return;
      if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
        textParts.push(delta.text);
        if (onDelta) {
          try {
            onDelta(delta.text);
          } catch {
            // never abort the stream consumer on a UI-side error
          }
        }
      } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        const existing = blocks.get(index);
        if (existing) existing.jsonBuf += delta.partial_json;
      }
      return;
    }
    if (type === "message_delta") {
      const delta = isRecord(payload.delta) ? payload.delta : undefined;
      if (delta && typeof delta.stop_reason === "string") {
        finishReason = mapAnthropicStopReason(delta.stop_reason);
      }
      if (isRecord(payload.usage)) usage = { ...(usage ?? {}), ...payload.usage };
      return;
    }
    // content_block_stop / message_stop / ping / unknown: nothing to do — tool
    // calls are finalized from the accumulated block map below.
  };

  try {
    while (true) {
      // Turn-abort: the fetch cancels and reader.read() rejects with an
      // AbortError; this guard makes the stop deterministic (the finally
      // cancels the reader on the throw).
      if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      // Idle-timeout guard: a wedged stream that stops emitting would otherwise
      // hang this await forever. readWithIdleTimeout cancels the reader and
      // throws a transient StreamIdleTimeoutError once the window elapses.
      const { value, done } = await readWithIdleTimeout(reader);
      if (value) buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (chunk.trim().length > 0) handleEvent(chunk);
        boundary = buffer.indexOf("\n\n");
      }
      if (done) break;
    }
    buffer += decoder.decode();
    if (buffer.trim().length > 0) handleEvent(buffer);

    const toolCalls: ToolCall[] = [];
    const orderedIndices = [...blocks.keys()].sort((a, b) => a - b);
    for (const index of orderedIndices) {
      const block = blocks.get(index)!;
      if (block.type !== "tool_use" || !block.id || !block.name) continue;
      toolCalls.push({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: block.jsonBuf.length > 0 ? block.jsonBuf : "{}" }
      });
    }

    return {
      provider,
      text: textParts.join("").trim(),
      toolCalls,
      finishReason,
      responseId,
      usage,
      cost: estimateCost(provider, usage)
    };
  } finally {
    try {
      await reader.cancel();
    } catch {}
  }
}

// Anthropic structured-output path. The Messages API has no
// response_format=json_object, so we prompt for JSON-only, call non-stream,
// strip a stray ```json fence, parse, and validate — mirroring
// callStructuredCodex.
async function callAnthropicStructured<T>(
  provider: ProviderConfig,
  request: StructuredRequest<T>
): Promise<StructuredResult<T>> {
  const result = await callAnthropicMessages(
    provider,
    [
      { role: "system", content: request.system },
      {
        role: "user",
        content: `${request.user}\n\nReturn ONLY valid JSON matching the ${request.schemaName} schema. No prose, no markdown fences.`
      }
    ],
    []
  );
  const cleaned = stripJsonFences(result.text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (error) {
    throw new Error(
      `Anthropic structured response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return {
    data: request.validator.parse(parsed),
    raw: cleaned,
    usage: result.usage,
    cost: estimateCost(provider, result.usage),
    provider
  };
}

// ---------------- Amazon Bedrock (Converse API) ----------------
//
// The bedrock provider speaks the model-agnostic Converse API
// (bedrock-runtime.{region}.amazonaws.com, SigV4 service "bedrock"), so one
// transport serves every Bedrock family — Claude, Amazon Nova, Meta Llama,
// Mistral, DeepSeek, … The model id is a cross-region inference-profile id sent
// verbatim in the request path. Auth is SigV4 over the AWS_ACCESS_KEY_ID /
// AWS_SECRET_ACCESS_KEY (and optional AWS_SESSION_TOKEN) the user entered,
// never an API key. Converse maps cleanly onto the same
// OpenAI-shaped transcript the rest of the runtime uses (translate in,
// parse out), so dispatch differs only by the transport.

interface ConverseTranslation {
  system: Array<{ text: string }>;
  messages: Array<Record<string, unknown>>;
}

// An AWS region token is lowercase letters, digits, and hyphens (e.g.
// us-east-1). Guard it because the bedrock region is interpolated into the
// request host — and the model-callable set_provider can supply it — so a value
// containing '/', '@', or '.' could repoint the request off-AWS or inject a path.
export function isValidAwsRegion(region: string): boolean {
  return /^[a-z0-9-]+$/.test(region);
}

// Signing region for a bedrock provider, resolved at request time so a later
// AWS_REGION change still takes effect: explicit config region → AWS_REGION →
// AWS_DEFAULT_REGION → built-in default. normalizeProvider persists only an
// explicit region, so this fallback chain is the single source of truth.
function bedrockRegion(provider: ProviderConfig): string {
  return provider.awsRegion || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || DEFAULT_BEDROCK_REGION;
}

// Build the Converse[Stream] URL. The modelId carries ':' (e.g.
// "us.amazon.nova-pro-v1:0") and is a single path segment, so encodeURIComponent
// it (':' -> %3A). signAwsRequest canonicalizes url.pathname verbatim and fetch
// sends the same encoded path, so the SigV4 signature matches the wire request.
function bedrockConverseUrl(region: string, modelId: string, stream: boolean): string {
  // Defense in depth: setup rejects a malformed region before persisting, but
  // also refuse to build a host from an unvalidated region here (it lands in the
  // URL authority).
  if (!isValidAwsRegion(region)) {
    throw new Error(`bedrock awsRegion is invalid: '${region}' (must match /^[a-z0-9-]+$/).`);
  }
  return `${bedrockRuntimeBaseUrl(region)}/model/${encodeURIComponent(modelId)}/${stream ? "converse-stream" : "converse"}`;
}

// SigV4-sign a Converse request (service "bedrock"). content-type is folded into
// the signature because fetch sends it.
function bedrockAuthHeaders(region: string, url: string, body: string): Record<string, string> {
  const credentials = resolveAwsCredentials();
  if (!credentials) {
    // Typed so the chat-task classifier routes it to the AWS reauth CTA
    // (providerReauth("bedrock") → kind "aws") instead of a generic failure.
    throw new ProviderAuthError(
      "bedrock",
      "bedrock provider needs AWS credentials but none resolved (enter your AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY when adding the bedrock provider)."
    );
  }
  return signAwsRequest({
    method: "POST",
    url,
    body,
    region,
    service: "bedrock",
    credentials,
    extraSignedHeaders: { "content-type": "application/json" }
  });
}

// Read the human-readable message out of a Converse error body ({message}, or
// the legacy {Message} casing).
function readBedrockError(payload: Record<string, unknown>): string | undefined {
  if (typeof payload.message === "string") return payload.message;
  if (typeof payload.Message === "string") return payload.Message;
  return undefined;
}

// Converse image `format` is a bare token (png/jpeg/gif/webp), not a MIME type.
function converseImageFormat(mediaType: string): string | undefined {
  const m = mediaType.toLowerCase();
  if (m === "image/png") return "png";
  if (m === "image/jpeg" || m === "image/jpg") return "jpeg";
  if (m === "image/gif") return "gif";
  if (m === "image/webp") return "webp";
  return undefined;
}

// Map a user message's content to Converse content blocks. Text → {text};
// image_url data URLs → {image:{format, source:{bytes}}} (the base64 string is
// the blob in JSON). Document parts are dropped here — Converse documents need a
// name+format the transcript doesn't carry, and support is model-specific.
function converseUserContent(content: string | MessageContentPart[] | null): Array<Record<string, unknown>> {
  if (typeof content === "string") return [{ text: content }];
  if (!Array.isArray(content)) return [{ text: "" }];
  const blocks: Array<Record<string, unknown>> = [];
  for (const part of content) {
    if (part.type === "text") {
      blocks.push({ text: part.text });
    } else if (part.type === "image_url") {
      const parsed = parseDataUrl(part.image_url.url);
      const format = parsed ? converseImageFormat(parsed.mediaType) : undefined;
      if (parsed && format) blocks.push({ image: { format, source: { bytes: parsed.data } } });
    }
  }
  // Converse rejects an empty content array; keep at least one block.
  if (blocks.length === 0) blocks.push({ text: "" });
  return blocks;
}

// Translate the OpenAI-shaped transcript into Converse's {system, messages}:
// hoist system messages to the top-level system array, fold assistant tool_calls
// into toolUse blocks, and collapse consecutive tool results into one user
// message of toolResult blocks (Converse requires tool results to lead a user
// turn that immediately follows the assistant toolUse turn).
//
// `stripToolBlocks` flattens tool_calls and tool results to plain text instead of
// structured toolUse/toolResult blocks. Converse hard-rejects tool blocks unless
// the request also carries a toolConfig ("The toolConfig field must be defined
// when using toolUse and toolResult content blocks"), and toolConfig itself
// rejects an empty tools array — so a tool-less call (e.g. the iteration-cap
// summary turn, which intentionally advertises no tools) over a history that
// contains tool blocks has no valid structured representation. Rendering the
// history as text keeps the model grounded in what it did without re-opening the
// tool channel it was told is closed.
function translateMessagesToConverse(
  messages: ToolCallingMessage[],
  stripToolBlocks = false
): ConverseTranslation {
  const system: Array<{ text: string }> = [];
  const out: Array<Record<string, unknown>> = [];
  let i = 0;
  while (i < messages.length) {
    const message = messages[i];
    if (message.role === "system") {
      if (typeof message.content === "string" && message.content.length > 0) system.push({ text: message.content });
      i++;
      continue;
    }
    if (message.role === "tool") {
      const blocks: Array<Record<string, unknown>> = [];
      while (i < messages.length && messages[i].role === "tool") {
        const toolMessage = messages[i];
        const text = typeof toolMessage.content === "string" ? toolMessage.content : JSON.stringify(toolMessage.content ?? "");
        if (stripToolBlocks) {
          blocks.push({ text: text.length > 0 ? `Tool result: ${text}` : "Tool result: (empty)" });
        } else {
          blocks.push({
            toolResult: {
              toolUseId: toolMessage.tool_call_id ?? "",
              // Converse rejects an empty tool_result content; pad an empty result.
              content: [{ text: text.length > 0 ? text : " " }]
            }
          });
        }
        i++;
      }
      out.push({ role: "user", content: blocks });
      continue;
    }
    if (message.role === "user") {
      out.push({ role: "user", content: converseUserContent(message.content) });
      i++;
      continue;
    }
    // assistant
    const blocks: Array<Record<string, unknown>> = [];
    if (typeof message.content === "string" && message.content.length > 0) {
      blocks.push({ text: message.content });
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) if (part.type === "text") blocks.push({ text: part.text });
    }
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    for (const call of toolCalls) {
      if (stripToolBlocks) {
        const args = call.function.arguments || "{}";
        blocks.push({ text: `Called tool ${call.function.name}(${args})` });
      } else {
        blocks.push({
          toolUse: { toolUseId: call.id, name: call.function.name, input: parseJsonObject(call.function.arguments || "{}") }
        });
      }
    }
    if (blocks.length === 0) blocks.push({ text: "" });
    out.push({ role: "assistant", content: blocks });
    i++;
  }
  // Converse, like the Anthropic Messages API, requires strict user/assistant
  // alternation. Merge any run of same-role messages (the cancelled-prompt +
  // interrupt-marker replay case produces adjacent user turns). Converse text
  // blocks use the `{ text }` shape, and content here is always a block array.
  const mergedConverse: Array<Record<string, unknown>> = [];
  for (const message of out) {
    const prev = mergedConverse[mergedConverse.length - 1];
    const blocks = (message.content as Array<Record<string, unknown>>) ?? [];
    if (prev && prev.role === message.role) {
      prev.content = [...(prev.content as Array<Record<string, unknown>>), ...blocks];
      continue;
    }
    mergedConverse.push(message);
  }
  return { system, messages: mergedConverse };
}

// Map tools to Converse's toolConfig. Returns undefined when there are no tools
// (Converse rejects an empty tools array).
function translateToolsToConverse(tools: ToolFunctionSpec[]): Record<string, unknown> | undefined {
  if (tools.length === 0) return undefined;
  return {
    tools: tools.map((tool) => ({
      toolSpec: {
        name: tool.function.name,
        description: tool.function.description,
        inputSchema: { json: tool.function.parameters }
      }
    })),
    toolChoice: { auto: {} }
  };
}

// Normalize Converse stopReason to the loop's finishReason vocabulary.
function mapConverseStopReason(value: string | undefined): ToolCallingResult["finishReason"] {
  switch (value) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "length";
    case "tool_use":
      return "tool_calls";
    default:
      return "unknown";
  }
}

// Converse reports usage as {inputTokens,outputTokens,totalTokens}; mirror those
// into the snake_case keys estimateCost reads so cost/usage records match the
// other providers (the original camelCase keys are kept too).
function normalizeConverseUsage(usage: unknown): Record<string, unknown> | undefined {
  if (!isRecord(usage)) return undefined;
  const out: Record<string, unknown> = { ...usage };
  if (typeof usage.inputTokens === "number") out.input_tokens = usage.inputTokens;
  if (typeof usage.outputTokens === "number") out.output_tokens = usage.outputTokens;
  if (typeof usage.totalTokens === "number") out.total_tokens = usage.totalTokens;
  return out;
}

async function callBedrockConverse(
  provider: ProviderConfig,
  messages: ToolCallingMessage[],
  tools: ToolFunctionSpec[],
  onDelta?: (text: string) => void,
  maxTokensOverride?: number,
  signal?: AbortSignal
): Promise<ToolCallingResult> {
  const region = bedrockRegion(provider);
  // Omit toolConfig for models that reject it (e.g. DeepSeek R1) so a normal
  // tool-loaded chat turn degrades to text-only instead of a ValidationException.
  const toolConfig = bedrockSupportsToolUse(provider.model) ? translateToolsToConverse(tools) : undefined;
  // Llama 4 streams fine and uses tools fine, but NOT both at once — AWS returns
  // "This model doesn't support tool use in streaming mode" for a Llama 4
  // ConverseStream carrying toolConfig. Fall back to non-stream Converse only
  // when we're actually attaching tools to such a model; tool-less Llama 4 turns
  // (and every other model) still stream.
  const wantStream =
    Boolean(onDelta) && !(toolConfig && !bedrockSupportsStreamingWithTools(provider.model));
  const url = bedrockConverseUrl(region, provider.model, wantStream);
  const safeMessages = pairToolCallingMessages(stripDocumentPartsIfUnsupported(messages, provider));
  // No toolConfig (tool-less turn, or a model that rejects tool use) ⟹ the
  // request must not carry tool blocks either, or Converse 400s. Flatten any
  // history tool blocks to text in that case.
  const { system, messages: converseMessages } = translateMessagesToConverse(safeMessages, !toolConfig);
  const extraMax =
    isRecord(provider.extraBody) && typeof provider.extraBody.max_tokens === "number" ? provider.extraBody.max_tokens : undefined;
  // Same precedence + streaming rule as the Anthropic path: a streaming turn
  // gets the model's full output ceiling so a large tool-call argument fits;
  // non-streaming keeps the floor. (Bedrock Converse non-streaming actually
  // tolerates a large max_tokens, but matching the Anthropic path keeps one
  // rule for both.)
  const modelDefaultMaxTokens = wantStream ? resolveMaxOutputTokens(provider) : DEFAULT_ANTHROPIC_MAX_TOKENS;
  const resolvedMaxTokens = maxTokensOverride ?? extraMax ?? modelDefaultMaxTokens;
  // The raised streaming ceiling must still fit the window; clamp down only on
  // the streaming path (the non-streaming floor is already small and safe).
  const maxTokens = wantStream
    ? clampStreamingMaxTokens(resolvedMaxTokens, provider, messages, tools)
    : resolvedMaxTokens;
  const body: Record<string, unknown> = {
    messages: converseMessages,
    inferenceConfig: { maxTokens }
  };
  if (system.length > 0) body.system = system;
  if (toolConfig) body.toolConfig = toolConfig;
  // Fine-grained tool streaming. Without it, Bedrock buffers a tool_use block's
  // entire input JSON server-side and emits nothing on the wire until the whole
  // argument is generated; a large argument (e.g. a long file body written
  // inline) leaves the stream idle past the socket timeout, surfacing as
  // "The operation timed out." and failing the turn. The beta flag streams the
  // tool input incrementally (field-by-field) so the connection stays fed.
  // Only meaningful on a streaming tool turn. On Converse the flag is the
  // anthropic_beta entry inside additionalModelRequestFields — the tool-level
  // `eager_input_streaming` property used by the first-party Messages API is
  // silently ignored here. See AWS Bedrock "Anthropic Claude tool use" docs.
  if (wantStream && toolConfig && claudeSupportsFineGrainedToolStreaming(provider.model)) {
    body.additionalModelRequestFields = { anthropic_beta: [FINE_GRAINED_TOOL_STREAMING_BETA] };
  }

  const bodyJson = JSON.stringify(body);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...bedrockAuthHeaders(region, url, bodyJson)
    },
    body: bodyJson,
    ...(signal ? { signal } : {})
  });

  if (wantStream) return readConverseStream(response, provider, onDelta, signal);

  const rawPayload = await response.text();
  const payload = parseJsonObject(rawPayload);
  if (!response.ok) {
    const fallback = rawPayload.slice(0, 500) || `Bedrock Converse request failed with HTTP ${response.status}`;
    throw new Error(readBedrockError(payload) ?? fallback);
  }
  return parseConverseResponse(payload, provider);
}

// Parse a non-streamed Converse response: join output.message text blocks,
// convert toolUse blocks to ToolCall, map stopReason/usage.
function parseConverseResponse(payload: Record<string, unknown>, provider: ProviderConfig): ToolCallingResult {
  const output = isRecord(payload.output) ? payload.output : undefined;
  const message = output && isRecord(output.message) ? output.message : undefined;
  const content = message && Array.isArray(message.content) ? message.content : [];
  const textParts: string[] = [];
  const toolCalls: ToolCall[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (typeof block.text === "string") {
      textParts.push(block.text);
    } else if (isRecord(block.toolUse)) {
      const tu = block.toolUse;
      const id = typeof tu.toolUseId === "string" ? tu.toolUseId : "";
      const name = typeof tu.name === "string" ? tu.name : "";
      if (!id || !name) continue;
      toolCalls.push({
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(isRecord(tu.input) ? tu.input : {}) }
      });
    }
  }
  const usage = normalizeConverseUsage(payload.usage);
  return {
    provider,
    text: textParts.join("").trim(),
    toolCalls,
    finishReason: mapConverseStopReason(typeof payload.stopReason === "string" ? payload.stopReason : undefined),
    usage,
    cost: estimateCost(provider, usage)
  };
}

function bytesConcat(a: Uint8Array<ArrayBufferLike>, b: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBufferLike> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function readUint32BE(b: Uint8Array<ArrayBufferLike>, offset: number): number {
  return ((b[offset]! << 24) | (b[offset + 1]! << 16) | (b[offset + 2]! << 8) | b[offset + 3]!) >>> 0;
}

// Parse one AWS event-stream frame:
//   [4B totalLen][4B headersLen][4B preludeCRC][headers][payload][4B msgCRC]
// We pull the `:event-type` / `:message-type` / `:exception-type` string headers
// to route the JSON payload; CRCs aren't validated (the length framing already
// delimits the message). Bedrock's event-stream headers are all string-typed
// (value type 7); a non-string header (unexpected) stops header parsing.
function parseEventStreamFrame(
  msg: Uint8Array<ArrayBufferLike>,
  decoder: TextDecoder
): { eventType: string; messageType: string; payload: string } | undefined {
  if (msg.length < 16) return undefined;
  const headersLen = readUint32BE(msg, 4);
  const headersStart = 12;
  const headersEnd = headersStart + headersLen;
  const payloadEnd = msg.length - 4;
  if (headersEnd > payloadEnd) return undefined;
  let eventType = "";
  let messageType = "";
  let exceptionType = "";
  let off = headersStart;
  while (off + 1 <= headersEnd) {
    const nameLen = msg[off]!;
    off += 1;
    const name = decoder.decode(msg.subarray(off, off + nameLen));
    off += nameLen;
    const valueType = msg[off]!;
    off += 1;
    if (valueType !== 7) break;
    const valueLen = (msg[off]! << 8) | msg[off + 1]!;
    off += 2;
    const value = decoder.decode(msg.subarray(off, off + valueLen));
    off += valueLen;
    if (name === ":event-type") eventType = value;
    else if (name === ":message-type") messageType = value;
    else if (name === ":exception-type") exceptionType = value;
  }
  const payload = decoder.decode(msg.subarray(headersEnd, payloadEnd));
  return { eventType: eventType || exceptionType, messageType, payload };
}

// Consume the Converse event stream (application/vnd.amazon.eventstream). Stream
// text deltas (contentBlockDelta.delta.text → onDelta), accumulate tool-use
// input fragments per contentBlockIndex, capture stopReason (messageStop) and
// usage (metadata), and surface any exception frame as a thrown error.
async function readConverseStream(
  response: Response,
  provider: ProviderConfig,
  onDelta?: (text: string) => void,
  signal?: AbortSignal
): Promise<ToolCallingResult> {
  if (!response.ok) {
    const raw = await response.text();
    const payload = parseJsonObject(raw);
    const fallback = raw.slice(0, 500) || `Bedrock Converse stream failed with HTTP ${response.status}`;
    throw new Error(readBedrockError(payload) ?? fallback);
  }
  const bodyStream = response.body;
  if (!bodyStream) throw new Error("Bedrock Converse stream returned no response body.");
  const reader = bodyStream.getReader();
  const decoder = new TextDecoder("utf-8");
  const textParts: string[] = [];
  const toolBlocks = new Map<number, { toolUseId: string; name: string; jsonBuf: string }>();
  let finishReason: ToolCallingResult["finishReason"] = "unknown";
  let usage: Record<string, unknown> | undefined;
  let buf: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

  const handle = (eventType: string, messageType: string, payload: Record<string, unknown>): void => {
    if (messageType === "exception" || /exception|error/i.test(eventType)) {
      throw new Error(readBedrockError(payload) ?? `Bedrock Converse stream error (${eventType || "unknown"}).`);
    }
    if (eventType === "contentBlockStart") {
      const index = typeof payload.contentBlockIndex === "number" ? payload.contentBlockIndex : 0;
      const start = isRecord(payload.start) ? payload.start : undefined;
      if (start && isRecord(start.toolUse)) {
        const tu = start.toolUse;
        toolBlocks.set(index, {
          toolUseId: typeof tu.toolUseId === "string" ? tu.toolUseId : "",
          name: typeof tu.name === "string" ? tu.name : "",
          jsonBuf: ""
        });
      }
      return;
    }
    if (eventType === "contentBlockDelta") {
      const index = typeof payload.contentBlockIndex === "number" ? payload.contentBlockIndex : 0;
      const delta = isRecord(payload.delta) ? payload.delta : undefined;
      if (!delta) return;
      if (typeof delta.text === "string" && delta.text.length > 0) {
        textParts.push(delta.text);
        if (onDelta) {
          try {
            onDelta(delta.text);
          } catch {
            // never abort the stream consumer on a UI-side error
          }
        }
      } else if (isRecord(delta.toolUse) && typeof delta.toolUse.input === "string") {
        const block = toolBlocks.get(index);
        if (block) block.jsonBuf += delta.toolUse.input;
      }
      return;
    }
    if (eventType === "messageStop") {
      if (typeof payload.stopReason === "string") finishReason = mapConverseStopReason(payload.stopReason);
      return;
    }
    if (eventType === "metadata") {
      usage = normalizeConverseUsage(payload.usage) ?? usage;
      return;
    }
    // messageStart / contentBlockStop / unknown: nothing to accumulate.
  };

  try {
    while (true) {
      // Turn-abort: the fetch cancels and reader.read() rejects with an
      // AbortError; this guard makes the stop deterministic (the finally
      // cancels the reader on the throw).
      if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      // Idle-timeout guard: a wedged stream that stops emitting would otherwise
      // hang this await forever. readWithIdleTimeout cancels the reader and
      // throws a transient StreamIdleTimeoutError once the window elapses.
      const { value, done } = await readWithIdleTimeout(reader);
      if (value) buf = bytesConcat(buf, value);
      while (buf.length >= 12) {
        const totalLen = readUint32BE(buf, 0);
        if (totalLen < 16 || buf.length < totalLen) break;
        const frame = parseEventStreamFrame(buf.subarray(0, totalLen), decoder);
        buf = buf.subarray(totalLen);
        if (frame) handle(frame.eventType, frame.messageType, parseJsonObject(frame.payload));
      }
      if (done) break;
    }

    const toolCalls: ToolCall[] = [];
    for (const index of [...toolBlocks.keys()].sort((a, b) => a - b)) {
      const block = toolBlocks.get(index)!;
      if (!block.toolUseId || !block.name) continue;
      toolCalls.push({
        id: block.toolUseId,
        type: "function",
        function: { name: block.name, arguments: block.jsonBuf.length > 0 ? block.jsonBuf : "{}" }
      });
    }
    return {
      provider,
      text: textParts.join("").trim(),
      toolCalls,
      finishReason,
      usage,
      cost: estimateCost(provider, usage)
    };
  } finally {
    try {
      await reader.cancel();
    } catch {}
  }
}

// Bedrock structured-output path. Converse has no response_format=json_object,
// so prompt for JSON-only, call non-stream, strip a stray fence, parse, validate
// — mirroring callAnthropicStructured.
async function callBedrockStructured<T>(
  provider: ProviderConfig,
  request: StructuredRequest<T>
): Promise<StructuredResult<T>> {
  const result = await callBedrockConverse(
    provider,
    [
      { role: "system", content: request.system },
      {
        role: "user",
        content: `${request.user}\n\nReturn ONLY valid JSON matching the ${request.schemaName} schema. No prose, no markdown fences.`
      }
    ],
    []
  );
  const cleaned = stripJsonFences(result.text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (error) {
    throw new Error(
      `Bedrock structured response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return {
    data: request.validator.parse(parsed),
    raw: cleaned,
    usage: result.usage,
    cost: estimateCost(provider, result.usage),
    provider
  };
}

// Codex tool-call-as-text backstop. The Responses-API parser handles the
// structured `function_call` items; this complements it by scanning the
// final assistant text for literal `<tool_call>...</tool_call>` markup.
// Each successfully parsed block is emitted as a synthetic ToolCall and
// the markup is stripped from the residual text so the user never sees
// the raw XML/JSON in chat. Two body shapes are recognized:
//   1. XML: `<tool_call name="X"><arg name="Y">v</arg>...</tool_call>`
//   2. JSON: `<tool_call>{"name":"X","arguments":{...}}</tool_call>`
// A third hybrid form (XML `name=` attribute with a JSON inner body) is
// handled by trying JSON first and falling back to XML <arg> children.
// `structuredCalls` is the list of natively-decoded function_calls; any
// text block that matches one by (name, arguments-shape) is dropped to
// avoid double-dispatch.
export function extractTextToolCallsFromAssistantText(
  text: string,
  structuredCalls: ToolCall[]
): { calls: ToolCall[]; residual: string } {
  if (!text || !text.includes("<tool_call")) {
    return { calls: [], residual: text };
  }
  // Build a sorted list of code-block (` ``` ` fenced or single-backtick
  // span) ranges so we can skip `<tool_call>` substrings that appear
  // inside them — the model is probably explaining its own syntax.
  const codeRanges = collectCodeRanges(text);
  const calls: ToolCall[] = [];
  const seenDedupKeys = new Set<string>();
  for (const call of structuredCalls) {
    seenDedupKeys.add(toolCallDedupKey(call.function.name, call.function.arguments));
  }
  let residual = "";
  let cursor = 0;
  const re = /<tool_call(\s[^>]*)?>([\s\S]*?)<\/tool_call>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (isRangeInsideAny(start, end, codeRanges)) {
      continue;
    }
    const attrs = match[1] ?? "";
    const inner = match[2] ?? "";
    const parsed = parseTextToolCallBlock(attrs, inner);
    if (!parsed) {
      // Malformed body — keep the original text in place. The chat-task
      // loop will surface the broken response to the user rather than
      // silently dispatching a corrupt call.
      continue;
    }
    const dedup = toolCallDedupKey(parsed.name, parsed.arguments);
    // Always strip the markup from the residual so the user doesn't see
    // raw XML/JSON in the reply, even when the structured channel already
    // covered the call.
    residual += text.slice(cursor, start);
    cursor = end;
    if (seenDedupKeys.has(dedup)) {
      continue;
    }
    seenDedupKeys.add(dedup);
    calls.push({
      id: synthesizeToolCallId(parsed.name, parsed.arguments, calls.length),
      type: "function",
      function: { name: parsed.name, arguments: parsed.arguments }
    });
  }
  residual += text.slice(cursor);
  return { calls, residual };
}

// Parse a single `<tool_call ...>...</tool_call>` body. Returns the tool
// name and a JSON-encoded arguments string (the ToolCall wire format),
// or undefined when the body is unrecoverable.
function parseTextToolCallBlock(
  attrs: string,
  inner: string
): { name: string; arguments: string } | undefined {
  // Name comes from the outer attribute when present, otherwise from a
  // JSON `name` field in the inner body (the legacy shape).
  let name = readXmlAttribute(attrs, "name");
  const trimmedInner = inner.trim();
  // JSON body. Tolerate either `arguments` or `parameters` for the args
  // bag; tolerate string or object values.
  if (trimmedInner.startsWith("{")) {
    try {
      const payload = JSON.parse(trimmedInner) as unknown;
      if (isRecord(payload)) {
        if (!name && typeof payload.name === "string") name = payload.name;
        const args = payload.arguments ?? payload.parameters;
        const argsJson = serializeArgs(args);
        if (name && argsJson !== undefined) {
          return { name, arguments: argsJson };
        }
      }
    } catch {
      // Fall through to XML parsing.
    }
  }
  // XML body with <arg name="X">value</arg> children.
  if (name) {
    const xmlArgs = parseXmlArgChildren(inner);
    if (xmlArgs) {
      return { name, arguments: JSON.stringify(xmlArgs) };
    }
    // Empty body with a name attribute still counts as a zero-arg call.
    if (trimmedInner.length === 0) {
      return { name, arguments: "{}" };
    }
  }
  return undefined;
}

// Coerce an args bag into the JSON-encoded string the ToolCall shape
// requires. Strings are passed through (the model already serialized);
// objects/arrays/primitives are JSON-encoded; null/undefined become "{}".
function serializeArgs(value: unknown): string | undefined {
  if (value === undefined || value === null) return "{}";
  if (typeof value === "string") {
    // A pre-serialized JSON string. Validate it parses; if not, fall back
    // to wrapping it as a literal — better to fail JSON-parse downstream
    // than to claim success on a corrupt args payload.
    try {
      JSON.parse(value);
      return value;
    } catch {
      return undefined;
    }
  }
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

// Extract a single attribute value from an XML-style attribute string.
// Supports both double- and single-quoted values. Returns undefined when
// the attribute is absent.
function readXmlAttribute(attrs: string, key: string): string | undefined {
  if (!attrs) return undefined;
  const re = new RegExp(`\\b${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);
  const m = re.exec(attrs);
  if (!m) return undefined;
  return m[1] ?? m[2];
}

// Parse `<arg name="X">value</arg>` children into a flat record. Returns
// undefined when no <arg> children are present (so the caller can decide
// whether to treat the call as zero-arg or malformed).
function parseXmlArgChildren(inner: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  const re = /<arg(\s[^>]*)?>([\s\S]*?)<\/arg>/g;
  let saw = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner)) !== null) {
    const argAttrs = m[1] ?? "";
    const argInner = m[2] ?? "";
    const argName = readXmlAttribute(argAttrs, "name");
    if (!argName) continue;
    saw = true;
    out[argName] = decodeXmlEntities(argInner.trim());
  }
  return saw ? out : undefined;
}

// Minimal entity decoder for the subset that codex emits inside <arg>
// bodies: &amp;, &lt;, &gt;, &quot;, &apos;. Numeric entities are passed
// through unchanged since tool args are user-facing strings the dispatch
// layer will treat as literal text.
function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// Dedup key for matching a text-extracted call against a structured one.
// Args are normalized through JSON.parse → JSON.stringify so that whitespace
// and key-order differences don't defeat the match.
function toolCallDedupKey(name: string, argsJson: string): string {
  let normalized = argsJson;
  try {
    const parsed = JSON.parse(argsJson) as unknown;
    normalized = JSON.stringify(parsed);
  } catch {
    // Leave as-is — non-JSON arguments are vanishingly rare and the raw
    // string is still a stable key for dedup.
  }
  return `${name}\0${normalized}`;
}

// Synthesize a deterministic call id for a text-extracted call. Using a
// content-derived id (not a random one) means a retry that re-receives
// the same text won't dispatch a second time when the upstream loop's
// idempotency check is keyed on call id.
function synthesizeToolCallId(name: string, argsJson: string, index: number): string {
  const fingerprint = textBackstopFingerprint(`${name}:${argsJson}:${index}`);
  return `call_textbackstop_${fingerprint}`;
}

// Stable, short fingerprint over the call key. Sticks to a 32-bit FNV-1a
// variant so the result is deterministic without needing Node's crypto.
function textBackstopFingerprint(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

// Collect ranges of `text` that fall inside a triple-backtick fenced
// code block or a single-backtick inline-code span. Used to skip
// `<tool_call>` substrings the model is quoting in a code block rather
// than emitting as an actual call.
function collectCodeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  // Fenced blocks first — these can span newlines and contain backticks.
  const fenced = /```[\s\S]*?```/g;
  let m: RegExpExecArray | null;
  while ((m = fenced.exec(text)) !== null) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  // Inline spans. Walk in two passes so fenced ranges win; the inline
  // regex is greedy-shy to avoid bridging across paragraphs.
  const inline = /`[^`\n]+`/g;
  while ((m = inline.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (!isRangeInsideAny(start, end, ranges)) {
      ranges.push([start, end]);
    }
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}

function isRangeInsideAny(start: number, end: number, ranges: Array<[number, number]>): boolean {
  for (const [rs, re] of ranges) {
    if (start >= rs && end <= re) return true;
  }
  return false;
}

export async function generateTaskSummary(
  config: RuntimeConfig,
  input: string,
  recalledContext?: string,
  onDelta?: (text: string) => void,
  // Optional per-call override. Resolved by callers from the active agent's
  // providerName/model via resolveEffectiveContext. Embeddings/reranker still
  // read config.provider — do NOT mutate config here.
  providerOverride?: ProviderConfig,
  // Optional owning task id. When present, identity-file scan blocks
  // emit a runtime trace warning on the task — matches the chat-task
  // path's onBlocked plumbing. When absent (no task context — e.g.
  // tests calling generateTaskSummary directly), the [BLOCKED: ...]
  // notice in the prompt is the only signal.
  taskId?: string
): Promise<ProviderResult> {
  const provider = normalizeProvider(providerOverride ?? config.provider);
  if (provider.name === "echo") {
    return {
      provider,
      text: `Gini handled: ${input}`
    };
  }

  // Runtime identity files. The legacy single-shot path doesn't carry
  // the chat-task identity block, but it still benefits from a
  // user-curated INSTRUCTIONS.md / USER.md and the active agent's
  // SOUL.md. Active-agent lookup is best-effort — when no agent is
  // active the SOUL.md block is elided. See ADR runtime-identity-files.md.
  const activeAgentId = resolveActiveAgentId(config);
  const onBlocked = taskId
    ? (filename: string, findings: string[]): void => {
        appendTrace(config.instance, taskId, {
          type: "model",
          message: `identity file blocked: ${filename}`,
          data: { filename, findings }
        });
      }
    : undefined;
  const loadOpts = onBlocked ? { onBlocked } : undefined;
  const instructionsOverride = loadInstructions(config.instance, loadOpts) ?? undefined;
  const soulBlock = loadSoul(config.instance, activeAgentId, loadOpts) ?? undefined;
  const userProfileBlock = loadUserProfile(config.instance, loadOpts) ?? undefined;
  // The legacy single-shot path is one system + one user message with no
  // prior transcript and no cross-turn cache prefix to preserve, so recalled
  // memory stays appended to its system context (the stable-prefix tail only
  // applies to the multi-turn chat-task loop). renderEphemeralContext
  // single-sources the "Long-term memory…" header. See ADR
  // stable-system-prefix.md.
  const stablePrefix = buildAgentSystemContext({
    instructionsOverride,
    soul: soulBlock,
    userProfile: userProfileBlock
  });
  const recalledBlock = renderEphemeralContext(undefined, recalledContext);
  const systemContext = recalledBlock.length > 0
    ? `${stablePrefix}\n\n${recalledBlock}`
    : stablePrefix;
  const dispatch = async (): Promise<ProviderResult> => {
    if (provider.name === "anthropic" || provider.name === "bedrock") {
      const result = provider.name === "bedrock"
        ? await callBedrockConverse(
            provider,
            [
              { role: "system", content: systemContext },
              { role: "user", content: input }
            ],
            [],
            onDelta
          )
        : await callAnthropicMessages(
            provider,
            [
              { role: "system", content: systemContext },
              { role: "user", content: input }
            ],
            [],
            onDelta
          );
      return {
        provider: result.provider,
        text: result.text || "The model returned no text output.",
        responseId: result.responseId,
        usage: result.usage,
        cost: result.cost
      };
    }
    if (
      provider.name === "openrouter" ||
      provider.name === "local" ||
      provider.name === "deepseek" ||
      // Azure OpenAI exposes deployment-scoped chat/completions, not the flat
      // /responses surface this path uses for standard OpenAI — route it through
      // the chat-completions builder so the URL + api-key header come out right.
      provider.name === "azure"
    ) {
      return callChatCompletions(provider, input, systemContext);
    }
    return callOpenAIResponses(provider, input, systemContext, onDelta);
  };
  try {
    return await dispatch();
  } catch (error) {
    // Same resolved-provider auth tagging as generateToolCallingResponse:
    // this is the imperative path's model call (runTask → failTask), and
    // failTask records the needs-reauth state only for typed errors — an
    // untyped 401 here would leave sessionless tasks invisible to the
    // amber Settings row (issue #233).
    const message = error instanceof Error ? error.message : String(error);
    if (!(error instanceof ProviderAuthError) && isAuthExpiredError(message)) {
      throw new ProviderAuthError(provider.name, message);
    }
    throw error;
  }
}

// Best-effort active-agent resolution for the legacy single-shot path.
// Reads state once; failures (missing state file in tests, etc.) leave
// the SOUL.md block elided. The modern chat-task path threads the
// agent through resolveEffectiveContext and never falls back to this.
function resolveActiveAgentId(config: RuntimeConfig): string | undefined {
  try {
    return readState(config.instance).activeAgentId;
  } catch {
    return undefined;
  }
}

// Hindsight phase 2 — structured-output helper.
//
// Calls the LLM with a JSON-only output contract and parses the result. Two
// implementations:
//   - echo: tests register stub responders by tag (or globally by index).
//           Deterministic by construction.
//   - openai/codex: uses the Responses API with `text.format = { type:
//           "json_object" }`. The caller passes a Zod-like validator; if
//           the model returns invalid JSON we return a structured error
//           (the retain pipeline retries once with a "Reply with JSON only"
//           clarifier, then gives up).
//
// The Validator interface is intentionally tiny so domain modules don't need
// to depend on Zod — they pass a parse callback.
export interface StructuredValidator<T> {
  parse(value: unknown): T;
}

export interface StructuredResult<T> {
  data: T;
  raw: string;
  usage?: Record<string, unknown>;
  cost?: CostRecord;
  provider: ProviderConfig;
}

export interface StructuredRequest<T> {
  system: string;
  user: string;
  schemaName: string;
  validator: StructuredValidator<T>;
  // Echo provider key — tests register stub data keyed by `echoTag`.
  echoTag?: string;
}

// Echo stub registry: tests call `setEchoStructuredResponse(tag, data)` to
// preconfigure the response for a given `echoTag`. If no exact match exists,
// the resolver falls back to the longest registered prefix (so a stub
// registered as "observation:" matches every `observation:<entityId>` call).
// If still no match, an empty object is returned and the validator parses
// it to whatever the schema's default is.
const echoStructuredStubs = new Map<string, unknown>();

export function setEchoStructuredResponse(tag: string, data: unknown): void {
  echoStructuredStubs.set(tag, data);
}

export function clearEchoStructuredResponses(): void {
  echoStructuredStubs.clear();
}

function resolveEchoStub(tag: string): unknown {
  if (echoStructuredStubs.has(tag)) return echoStructuredStubs.get(tag);
  // Longest-prefix match. Lets tests register "observation:" once and have
  // it cover all entity-keyed observation calls in a single retain call.
  let bestKey: string | null = null;
  for (const key of echoStructuredStubs.keys()) {
    if (key.endsWith(":") && tag.startsWith(key)) {
      if (bestKey === null || key.length > bestKey.length) bestKey = key;
    }
  }
  return bestKey !== null ? echoStructuredStubs.get(bestKey) : undefined;
}

export async function generateStructured<T>(
  config: RuntimeConfig,
  request: StructuredRequest<T>,
  // Optional per-call override. Resolved by callers from the active agent's
  // providerName/model via resolveEffectiveContext. Used by retain/reflect/
  // reinforce so Hindsight extraction follows the agent's provider just like
  // chat-task inference does. Embeddings/reranker stay on config.provider.
  providerOverride?: ProviderConfig
): Promise<StructuredResult<T>> {
  const provider = normalizeProvider(providerOverride ?? config.provider);
  if (provider.name === "echo") {
    const tag = request.echoTag ?? request.schemaName;
    const stub = resolveEchoStub(tag);
    const raw = JSON.stringify(stub ?? {});
    return {
      data: request.validator.parse(stub ?? {}),
      raw,
      usage: { input_tokens: request.system.length + request.user.length, output_tokens: raw.length },
      cost: estimateCost(provider, { input_tokens: request.system.length + request.user.length, output_tokens: raw.length }),
      provider
    };
  }

  // Anthropic has no response_format=json_object field, so it gets its own JSON
  // path: prompt for JSON-only, call Messages non-stream, strip fences, parse,
  // validate (mirrors callStructuredCodex).
  if (provider.name === "anthropic") {
    return callAnthropicStructured(provider, request);
  }
  // Bedrock Converse likewise has no response_format; same prompt-for-JSON path
  // over the Converse transport.
  if (provider.name === "bedrock") {
    return callBedrockStructured(provider, request);
  }

  // OpenAI / OpenRouter / local OpenAI-compatible: chat-completions with
  // response_format json_object. We deliberately don't push json_schema —
  // many compat providers reject the field. Validator re-checks shape.
  if (
    provider.name === "openrouter" ||
    provider.name === "local" ||
    provider.name === "openai" ||
    provider.name === "deepseek" ||
    provider.name === "azure"
  ) {
    return callStructuredChatCompletions(provider, request);
  }
  // Codex doesn't expose /chat/completions and the /responses API doesn't
  // support response_format=json_object. We prompt for JSON, stream the
  // /responses endpoint with codex auth, and validate the parsed output.
  return callStructuredCodex(provider, request);
}

async function callStructuredCodex<T>(
  provider: ProviderConfig,
  request: StructuredRequest<T>
): Promise<StructuredResult<T>> {
  // Retry the fetch+stream pair on session-expired so Hindsight extraction
  // (retain/reflect/reinforce) doesn't lose a whole structured turn to a
  // mid-stream rotation. The JSON parsing afterward stays outside the
  // retry because a malformed payload is a model failure, not an auth one.
  const streamed = await withCodexSessionRetry(async () => {
    const bearer = readCodexBearer(provider);
    const baseUrl = resolveBaseUrl(provider.baseUrl, defaultBaseUrl(provider));
    const response = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
        accept: "text/event-stream",
        ...codexHeaders(bearer)
      },
      body: JSON.stringify({
        model: provider.model,
        store: false,
        stream: true,
        instructions: request.system,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: `${request.user}\n\nReturn ONLY valid JSON matching the ${request.schemaName} schema. No prose, no markdown fences.`
              }
            ]
          }
        ]
      })
    });
    // readCodexStream already handles non-OK and empty-output as throws.
    return readCodexStream(response, provider);
  });
  const cleaned = stripJsonFences(streamed.text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (error) {
    throw new Error(`Codex structured response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    data: request.validator.parse(parsed),
    raw: cleaned,
    usage: streamed.usage,
    cost: estimateCost(provider, streamed.usage),
    provider
  };
}

// Models occasionally wrap JSON in ```json fences despite the prompt. Strip
// once before parsing so a single rogue fence doesn't fail an otherwise good
// extraction.
function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  const withoutOpen = trimmed.replace(/^```(?:json)?\s*\n?/, "");
  return withoutOpen.replace(/\n?```\s*$/, "").trim();
}

async function callStructuredChatCompletions<T>(
  provider: ProviderConfig,
  request: StructuredRequest<T>
): Promise<StructuredResult<T>> {
  const envName = provider.apiKeyEnv ?? "OPENAI_API_KEY";
  const apiKey = provider.name === "local" ? process.env[envName] : readOpenAIBearer(provider);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...chatCompletionsAuthHeader(provider, apiKey),
    ...(provider.name === "openrouter" ? { "HTTP-Referer": "http://127.0.0.1:7337", "X-Title": "Gini Agent" } : {})
  };
  const baseUrl = resolveBaseUrl(provider.baseUrl, defaultBaseUrl(provider));
  const response = await fetch(chatCompletionsUrl(provider, baseUrl), {
    method: "POST",
    headers,
    body: JSON.stringify({
      ...sanitizeExtraBody(provider.extraBody),
      model: provider.model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: `${request.user}\n\nReturn ONLY valid JSON matching the ${request.schemaName} schema.` }
      ],
      stream: false,
      ...promptCacheRetentionBody(provider)
    })
  });
  const rawPayload = await response.text();
  const payload = parseJsonObject(rawPayload);
  if (!response.ok) {
    const fallback = rawPayload.slice(0, 500) || `Structured request failed with HTTP ${response.status}`;
    throw new Error(readOpenAIError(payload) ?? fallback);
  }
  const text = extractChatText(payload) || "{}";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Structured response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    data: request.validator.parse(parsed),
    raw: text,
    usage: isRecord(payload.usage) ? payload.usage : undefined,
    cost: estimateCost(provider, isRecord(payload.usage) ? payload.usage : undefined),
    provider
  };
}

// Treat both nullish and whitespace-only as missing so persisted
// `baseUrl: ""` doesn't slip through normalize and end up resolving against
// the wrong provider's default at the call site.
function pickBaseUrl(persisted: string | undefined, fallback: string): string {
  return persisted && persisted.trim().length > 0 ? persisted : fallback;
}

// DeepSeek V4 family + deepseek-reasoner (R1) accept a top-level
// `thinking: {type: "enabled"|"disabled"}` flag plus
// `reasoning_effort: "low"|"medium"|"high"|"max"` on their OpenAI-compat
// chat-completions endpoint. The API defaults to thinking-on for these
// models, which then enforces a `reasoning_content` echo-back contract on
// subsequent turns. We default-on explicitly so the wire shape matches
// what DeepSeek expects, and crank `reasoning_effort` to "max" so callers
// pick the strongest setting without extra config. User-supplied
// extraBody wins on conflicts.
function deepseekSupportsThinking(model: string): boolean {
  const m = model.trim().toLowerCase();
  if (!m) return false;
  if (m === "deepseek-reasoner") return true;
  // deepseek-v4-*, deepseek-v5-*, ...  Excludes V3 explicitly.
  return m.startsWith("deepseek-v") && !m.startsWith("deepseek-v3");
}

function withDeepSeekThinkingDefaults(
  model: string,
  extraBody: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!deepseekSupportsThinking(model)) {
    return extraBody;
  }
  const merged: Record<string, unknown> = { thinking: { type: "enabled" }, reasoning_effort: "max" };
  if (extraBody) {
    for (const [key, value] of Object.entries(extraBody)) {
      merged[key] = value;
    }
  }
  return merged;
}

export function normalizeProvider(provider: ProviderConfig): ProviderConfig {
  if (provider.name === "openai") {
    return {
      name: "openai",
      model: provider.model || "gpt-5.4-mini",
      baseUrl: pickBaseUrl(provider.baseUrl, DEFAULT_OPENAI_BASE_URL),
      apiKeyEnv: provider.apiKeyEnv ?? "OPENAI_API_KEY",
      ...(provider.extraBody ? { extraBody: provider.extraBody } : {})
    };
  }
  if (provider.name === "azure") {
    const apiVersion = provider.apiVersion?.trim();
    const deployment = provider.deployment?.trim();
    return {
      name: "azure",
      model: provider.model || DEFAULT_AZURE_MODEL,
      // No universal default — Azure is per-resource. A blank/missing baseUrl is
      // carried through as-is (the config-entry boundaries reject it); the empty
      // fallback keeps normalizeProvider a pure, non-throwing transform that also
      // hydrates persisted configs and resolves per-agent overrides.
      baseUrl: pickBaseUrl(provider.baseUrl, ""),
      apiKeyEnv: provider.apiKeyEnv ?? "AZURE_OPENAI_API_KEY",
      // api-version is required on every Azure data-plane call; default it so a
      // config carrying only a base URL + key still routes.
      apiVersion: apiVersion && apiVersion.length > 0 ? apiVersion : DEFAULT_AZURE_API_VERSION,
      // deployment defaults to the model id at the call site (chatCompletionsUrl),
      // so only carry an explicit override here.
      ...(deployment && deployment.length > 0 ? { deployment } : {}),
      // Default to Azure's resource-key `api-key` header; "bearer" opts into an
      // Entra access token instead.
      authScheme: provider.authScheme === "bearer" ? "bearer" : "api-key",
      ...(provider.extraBody ? { extraBody: provider.extraBody } : {})
    };
  }
  if (provider.name === "openrouter") {
    return {
      name: "openrouter",
      model: provider.model || "openrouter/auto",
      baseUrl: pickBaseUrl(provider.baseUrl, "https://openrouter.ai/api/v1"),
      apiKeyEnv: provider.apiKeyEnv ?? "OPENROUTER_API_KEY",
      ...(provider.extraBody ? { extraBody: provider.extraBody } : {})
    };
  }
  if (provider.name === "local") {
    return {
      name: "local",
      model: provider.model || "local/default",
      baseUrl: pickBaseUrl(provider.baseUrl, "http://127.0.0.1:11434/v1"),
      apiKeyEnv: provider.apiKeyEnv ?? "GINI_LOCAL_API_KEY",
      ...(provider.extraBody ? { extraBody: provider.extraBody } : {})
    };
  }
  if (provider.name === "deepseek") {
    const model = provider.model || DEFAULT_DEEPSEEK_MODEL;
    const extraBody = withDeepSeekThinkingDefaults(model, provider.extraBody);
    return {
      name: "deepseek",
      model,
      baseUrl: pickBaseUrl(provider.baseUrl, DEFAULT_DEEPSEEK_BASE_URL),
      apiKeyEnv: provider.apiKeyEnv ?? "DEEPSEEK_API_KEY",
      ...(extraBody ? { extraBody } : {})
    };
  }
  if (provider.name === "codex") {
    return {
      name: "codex",
      model: provider.model || DEFAULT_CODEX_MODEL,
      baseUrl: pickBaseUrl(provider.baseUrl, DEFAULT_CODEX_BASE_URL),
      apiKeyEnv: provider.apiKeyEnv
    };
  }
  if (provider.name === "anthropic") {
    return {
      name: "anthropic",
      model: provider.model || DEFAULT_ANTHROPIC_MODEL,
      baseUrl: pickBaseUrl(provider.baseUrl, DEFAULT_ANTHROPIC_BASE_URL),
      apiKeyEnv: provider.apiKeyEnv ?? "ANTHROPIC_API_KEY",
      ...(provider.extraBody ? { extraBody: provider.extraBody } : {})
    };
  }
  if (provider.name === "bedrock") {
    // Persist only an EXPLICIT region. The env/default fallback (explicit →
    // AWS_REGION → AWS_DEFAULT_REGION → built-in default) is resolved at request
    // time by bedrockRegion, so config.json never freezes whatever AWS_REGION
    // happened to be set when `provider set` ran (a later env change still wins).
    const awsRegion = provider.awsRegion?.trim();
    return {
      name: "bedrock",
      model: provider.model || DEFAULT_BEDROCK_MODEL,
      // Informational: the regional Converse runtime host, for inspection/trace
      // — callBedrockConverse builds the real /model/{id}/converse[-stream] URL
      // from the request-time region. Derive it from the explicit region or the
      // built-in default with NO env read, so the displayed host can't drift from
      // the signed host and the persisted file embeds no environment state.
      baseUrl: bedrockRuntimeBaseUrl(awsRegion || DEFAULT_BEDROCK_REGION),
      ...(awsRegion ? { awsRegion } : {}),
      ...(provider.extraBody ? { extraBody: provider.extraBody } : {})
    };
  }
  return {
    name: "echo",
    model: provider.model || "gini-echo-v0"
  };
}

async function callOpenAIResponses(
  provider: ProviderConfig,
  input: string,
  systemContext: string,
  onDelta?: (text: string) => void,
  // Per-call output-token cap. Aux side-calls pass a small budget; the
  // chat paths omit it and the model default applies.
  maxOutputTokens?: number,
  signal?: AbortSignal
): Promise<ProviderResult> {
  const baseUrl = resolveBaseUrl(provider.baseUrl, defaultBaseUrl(provider));
  const tokenCapField = maxOutputTokens !== undefined ? { max_output_tokens: maxOutputTokens } : {};

  // Codex and OpenAI share the /responses surface but differ on auth,
  // streaming, and retry. Codex needs withCodexSessionRetry so a token
  // rotation mid-stream (or an initial 401 on a stale token) gets a
  // second attempt after readCodexBearer re-reads auth.json. OpenAI uses
  // an env-var key with no rotation surface, so a retry would just
  // re-fail with the same bearer.
  if (provider.name === "codex") {
    return withCodexSessionRetry(async () => {
      const bearer = readCodexBearer(provider);
      const response = await fetch(`${baseUrl}/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearer}`,
          "content-type": "application/json",
          accept: "text/event-stream",
          ...codexHeaders(bearer)
        },
        body: JSON.stringify({
          model: provider.model,
          store: false,
          stream: true,
          instructions: systemContext,
          input: [
            {
              role: "user",
              content: [
                { type: "input_text", text: input }
              ]
            }
          ],
          ...tokenCapField
        }),
        ...(signal ? { signal } : {})
      });
      return readCodexStream(response, provider, onDelta, signal);
    }, signal);
  }

  const bearer = readOpenAIBearer(provider);
  const response = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
      accept: "application/json"
    },
    body: JSON.stringify({
      model: provider.model,
      store: false,
      stream: false,
      instructions: systemContext,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: input }
          ]
        }
      ],
      ...tokenCapField,
      ...promptCacheRetentionBody(provider)
    }),
    ...(signal ? { signal } : {})
  });

  const rawPayload = await response.text();
  const payload = parseJsonObject(rawPayload);
  if (!response.ok) {
    const fallback = rawPayload.slice(0, 500) || `OpenAI API request failed with HTTP ${response.status}`;
    const error = readOpenAIError(payload) ?? fallback;
    throw new Error(error);
  }

  return {
    provider,
    text: extractOutputText(payload) || "The model returned no text output.",
    responseId: typeof payload.id === "string" ? payload.id : undefined,
    usage: isRecord(payload.usage) ? payload.usage : undefined,
    cost: estimateCost(provider, isRecord(payload.usage) ? payload.usage : undefined)
  };
}

// The Responses API surface. `${baseUrl}/responses` for OpenAI-compatible
// providers — including the hosted guest, whose baseUrl is the edge (the edge
// exposes /responses as a router twin of /chat/completions). Azure routes the v1
// Responses surface under /openai/v1.
function responsesUrl(provider: ProviderConfig, baseUrl: string): string {
  if (provider.name === "azure") return `${baseUrl}/openai/v1/responses`;
  return `${baseUrl}/responses`;
}

// Whether this provider's tool-calling turn should run through the Responses API
// with the built-in web_search tool instead of Chat Completions. Gated on the
// hosted marker so web search is on by default for the gini model (openai/azure
// pointed at the edge, which grounds the search on the service's Azure resource
// with no tenant search key) while a plain local openai/azure user keeps the
// Chat Completions path. See ADR web-search-connectors.md.
export function shouldUseResponsesWebSearch(provider: ProviderConfig): boolean {
  if (provider.name !== "openai" && provider.name !== "azure") return false;
  return process.env.GINI_HOSTED === "1";
}

// A gpt-5.x deployment rejects function tools + reasoning_effort on Chat
// Completions with a 400 whose message names the Responses API as the remedy
// ("Please use /v1/responses instead"). Detect that specific error so a
// tool-calling turn can retry on the Responses path instead of hard-failing.
export function isResponsesApiRequiredError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes("/v1/responses");
}

// Route an OpenAI/Azure tool-calling turn through the Responses API so the
// built-in web_search tool (Bing-grounded on Azure) is available inline — the
// model searches server-side mid-turn and returns cited prose, all in one turn,
// with no tenant search key. The runtime's own function tools ride along as
// Responses function tools; the now-redundant brave/exa `web_search` function
// tool is dropped in favor of the built-in one. Reuses the same request
// translation and stream reader as the codex responses path — its tool-call
// handlers key on `function_call` items, so the server-side `web_search_call`
// items never become dispatchable calls; they're announced via onWebSearch (and
// collected into result.webSearches) for the chat-task loop to surface as
// display-only "Web search" chips while the cited answer streams as text.
async function callResponsesWithWebSearch(
  provider: ProviderConfig,
  messages: ToolCallingMessage[],
  tools: ToolFunctionSpec[],
  onDelta?: (text: string) => void,
  signal?: AbortSignal,
  onWebSearch?: (query: string) => void
): Promise<ToolCallingResult> {
  const bearer = readOpenAIBearer(provider);
  const baseUrl = resolveBaseUrl(provider.baseUrl, defaultBaseUrl(provider));
  const safeMessages = stripDocumentPartsIfUnsupported(messages, provider);
  const { instructions, input } = translateMessagesToResponsesInput(safeMessages);
  const responsesTools: Array<Record<string, unknown>> = tools
    .filter((tool) => tool.function.name !== "web_search")
    .map((tool) => ({
      type: "function",
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
      strict: false
    }));
  responsesTools.push({ type: "web_search" });
  const model = provider.name === "azure" ? (provider.deployment?.trim() || provider.model) : provider.model;
  const response = await fetch(responsesUrl(provider, baseUrl), {
    method: "POST",
    headers: {
      ...chatCompletionsAuthHeader(provider, bearer),
      "content-type": "application/json",
      accept: "text/event-stream"
    },
    body: JSON.stringify({ model, store: false, stream: true, instructions, input, tools: responsesTools }),
    ...(signal ? { signal } : {})
  });
  return readResponsesToolCallingStream(response, provider, onDelta, signal, onWebSearch);
}

async function callChatCompletions(
  provider: ProviderConfig,
  input: string,
  systemContext: string,
  // Per-call output-token cap (aux side-calls). Azure serves OpenAI
  // models whose newer o-series reject `max_tokens` and require
  // `max_completion_tokens`; other compat gateways keep the legacy field
  // (mirrors callVisionChatCompletions).
  maxTokens?: number,
  signal?: AbortSignal
): Promise<ProviderResult> {
  const envName = provider.apiKeyEnv ?? "OPENAI_API_KEY";
  const apiKey = provider.name === "local" ? process.env[envName] : readOpenAIBearer(provider);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...chatCompletionsAuthHeader(provider, apiKey),
    ...(provider.name === "openrouter" ? { "HTTP-Referer": "http://127.0.0.1:7337", "X-Title": "Gini Agent" } : {})
  };
  const baseUrl = resolveBaseUrl(provider.baseUrl, defaultBaseUrl(provider));
  const tokenCapField = maxTokens === undefined
    ? {}
    : provider.name === "azure"
      ? { max_completion_tokens: maxTokens }
      : { max_tokens: maxTokens };
  const response = await fetch(chatCompletionsUrl(provider, baseUrl), {
    method: "POST",
    headers,
    body: JSON.stringify({
      ...sanitizeExtraBody(provider.extraBody),
      model: provider.model,
      messages: [
        { role: "system", content: systemContext },
        { role: "user", content: input }
      ],
      stream: false,
      ...tokenCapField,
      ...promptCacheRetentionBody(provider)
    }),
    ...(signal ? { signal } : {})
  });
  const rawPayload = await response.text();
  const payload = parseJsonObject(rawPayload);
  if (!response.ok) {
    const fallback = rawPayload.slice(0, 500) || `Chat completions request failed with HTTP ${response.status}`;
    throw new Error(readOpenAIError(payload) ?? fallback);
  }
  return {
    provider,
    text: extractChatText(payload) || "The model returned no text output.",
    responseId: typeof payload.id === "string" ? payload.id : undefined,
    usage: isRecord(payload.usage) ? payload.usage : undefined,
    cost: estimateCost(provider, isRecord(payload.usage) ? payload.usage : undefined)
  };
}

async function readCodexStream(
  response: Response,
  provider: ProviderConfig,
  onDelta?: (text: string) => void,
  signal?: AbortSignal
): Promise<ProviderResult> {
  if (!response.ok) {
    // Error path: drain the body fully so we can surface the API's error
    // message. Streaming codex endpoints sometimes return JSON for errors.
    const raw = await response.text();
    const payload = parseJsonObject(raw);
    const fallback = raw.slice(0, 500) || `Codex API request failed with HTTP ${response.status}`;
    const error = readOpenAIError(payload) ?? fallback;
    // Initial 401 with a session-expired body comes from auth.json holding
    // a token that was rotated before the request even left gini. Surface
    // it as the retryable sentinel so withCodexSessionRetry picks up the
    // freshly-rotated token on its second attempt.
    if (response.status === 401 && isCodexSessionExpiredMessage(error)) {
      throw new CodexSessionExpiredError(error);
    }
    throw new Error(error);
  }

  const body = response.body;
  if (!body) {
    throw new Error("Codex stream returned no response body.");
  }

  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  const deltaTextParts: string[] = [];
  const finalTextParts: string[] = [];
  let responseId: string | undefined;
  let usage: Record<string, unknown> | undefined;
  // True once onDelta has actually fired with a delta chunk.
  // deltaTextParts and finalTextParts are internal accumulation —
  // nothing in them reaches the caller until this function returns —
  // so they do NOT count as emitted output for the safe-retry decision.
  let emittedToCaller = false;

  // Consume the SSE stream incrementally. Each event is delimited by `\n\n`;
  // we split off complete events from the rolling buffer and push the rest
  // back. `delta` events fire `onDelta` so callers can surface partial text
  // to UI. The full response text is still returned at the end so the
  // existing ProviderResult contract holds.
  const handleEvent = (block: string): void => {
    const lines = block.split(/\r?\n/);
    let eventType: string | undefined;
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventType = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trim());
      }
    }
    if (dataLines.length === 0) return;
    const data = dataLines.join("\n");
    if (!data || data === "[DONE]") return;
    const payload = parseJsonObject(data);
    const payloadType = typeof payload.type === "string" ? payload.type : eventType;

    // Backend-emitted error events (session rotation, request-level
    // failures, content-policy aborts). Throwing here unwinds the SSE
    // consumer loop; if onDelta has not yet fired (no caller-visible
    // bytes), withCodexSessionRetry can re-read auth.json and retry
    // transparently. Otherwise we'd risk double-emitting partial output,
    // so the generic Error path runs even on session-expired mid-stream.
    if (eventType === "error" || payloadType === "error" || payloadType === "response.failed") {
      const message = extractStreamErrorMessage(payload)
        ?? `Codex stream errored before completion (${payloadType ?? "unknown"}).`;
      if (isCodexSessionExpiredMessage(message) && !emittedToCaller) {
        throw new CodexSessionExpiredError(message);
      }
      throw new Error(message);
    }

    if (!responseId && typeof payload.response_id === "string") responseId = payload.response_id;
    if (!responseId && isRecord(payload.response) && typeof payload.response.id === "string") responseId = payload.response.id;
    if (isRecord(payload.response) && isRecord(payload.response.usage)) usage = payload.response.usage;
    if (typeof payload.delta === "string") {
      deltaTextParts.push(payload.delta);
      if (onDelta) {
        emittedToCaller = true;
        try {
          onDelta(payload.delta);
        } catch {
          // onDelta is fire-and-forget for UI updates; never let it abort
          // the stream consumer.
        }
      }
    }
    if (isRecord(payload.item) && Array.isArray(payload.item.content)) {
      for (const content of payload.item.content) {
        if (isRecord(content) && typeof content.text === "string") finalTextParts.push(content.text);
      }
    }
  };

  // Stream consumption wraps in try/finally so a throw from handleEvent
  // (e.g. session-expired classification mid-stream) cancels the reader
  // before withCodexSessionRetry constructs attempt 2. Without this,
  // attempt 1's reader stays locked to the response body and the
  // underlying socket can linger while a parallel attempt is already
  // in flight.
  try {
    while (true) {
      // Turn-abort: the fetch cancels and reader.read() rejects with an
      // AbortError; this guard makes the stop deterministic (the finally
      // cancels the reader on the throw).
      if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      const { value, done } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (block.trim().length > 0) handleEvent(block);
        boundary = buffer.indexOf("\n\n");
      }
      if (done) break;
    }
    // Flush any trailing event that wasn't followed by a blank-line terminator.
    buffer += decoder.decode();
    if (buffer.trim().length > 0) handleEvent(buffer);

    const text = (deltaTextParts.length > 0 ? deltaTextParts.join("") : finalTextParts.join("")).trim();
    if (!text) {
      throw new Error("Codex stream completed without text output.");
    }

    return {
      provider,
      text,
      responseId,
      usage,
      cost: estimateCost(provider, usage)
    };
  } finally {
    try { await reader.cancel(); } catch {}
  }
}

function codexHeaders(accessToken: string): Record<string, string> {
  // Mirror the codex CLI's request shape exactly — same User-Agent and
  // originator, no daemon-identifying suffix. The previous header carried
  // a parenthetical " (Gini Agent)" tail, which made gini's traffic
  // trivially distinguishable from real codex CLI use of the same session
  // token. OpenAI's backend can fingerprint that tail and selectively
  // 401 gini's requests while leaving the interactive CLI alone, which
  // exactly matches the failure mode we're recovering from above. Keep
  // the version pinned to the same placeholder the codex CLI shipped
  // with at the time we copied this shape — if the upstream version
  // ever drifts enough that the backend starts rejecting it, bump here.
  const headers: Record<string, string> = {
    "User-Agent": "codex_cli_rs/0.0.0",
    originator: "codex_cli_rs"
  };
  const accountId = chatgptAccountId(accessToken);
  if (accountId) headers["ChatGPT-Account-ID"] = accountId;
  return headers;
}

function chatgptAccountId(accessToken: string): string | undefined {
  try {
    const [, payload] = accessToken.split(".");
    if (!payload) return undefined;
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    const auth = isRecord(decoded["https://api.openai.com/auth"]) ? decoded["https://api.openai.com/auth"] : undefined;
    return typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
  } catch {
    return undefined;
  }
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readOpenAIBearer(provider: ProviderConfig): string {
  const envName = provider.apiKeyEnv ?? "OPENAI_API_KEY";
  // Hosted restore: a guest resumed from the base snapshot has a frozen
  // process.env, so the per-tenant router key is read from the tmpfs file the
  // in-guest identity agent writes (via `<ENV>_FILE`), falling back to the env
  // value everywhere else. See lib/hosted-secret-file.ts.
  const apiKey = hostedSecretFromFile(`${envName}_FILE`, process.env[envName]);
  if (!apiKey) {
    // Typed so failTask records the needs-reauth state and renders the named
    // re-auth CTA for a key unset mid-turn (mirrors readAnthropicKey and
    // bedrock) — the message itself never matches the chat-task classifier
    // ("is not set" carries no auth verb, and `_` is a word char so the env
    // var name hides the api-key noun), so an untyped throw here would leave
    // the whole OpenAI-compatible family invisible to the amber Settings row.
    throw new ProviderAuthError(
      provider.name,
      `${providerDisplayLabel(provider.name)} provider is configured but ${envName} is not set.`
    );
  }
  return apiKey;
}

function extractChatText(payload: Record<string, unknown>): string {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const first = choices.find(isRecord);
  if (!first || !isRecord(first.message)) return "";
  return typeof first.message.content === "string" ? first.message.content.trim() : "";
}

function estimateCost(provider: ProviderConfig, usage?: Record<string, unknown>) {
  const inputTokens = numberField(usage, "input_tokens") ?? numberField(usage, "prompt_tokens");
  const outputTokens = numberField(usage, "output_tokens") ?? numberField(usage, "completion_tokens");
  const calculatedTokens = inputTokens || outputTokens ? (inputTokens ?? 0) + (outputTokens ?? 0) : undefined;
  const totalTokens = numberField(usage, "total_tokens") ?? calculatedTokens;
  return {
    provider: provider.name,
    model: provider.model,
    inputTokens,
    outputTokens,
    totalTokens,
    estimatedUsd: estimateUsd(provider, inputTokens, outputTokens)
  };
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" ? value : undefined;
}

function readCodexBearer(provider: ProviderConfig): string {
  const credentials = readCodexCredentials(provider);
  if (!credentials.ok || !credentials.bearer) {
    if (credentials.transient) {
      throw new CodexAuthRaceError(credentials.message);
    }
    // Steady-state credential absence (file missing — the post-`codex logout`
    // state — or a file without OPENAI_API_KEY / tokens.access_token) is
    // typed so failTask names the codex credential and emits the re-auth CTA
    // note directly — typed errors bypass the chat-task message classifier
    // (mirrors anthropic/bedrock; issue #233).
    throw new ProviderAuthError("codex", credentials.message);
  }
  return credentials.bearer;
}

// Thrown when the codex /responses backend reports the ChatGPT session was
// rotated or invalidated. Carries a single-retry contract: callers wrap
// codex requests in `withCodexSessionRetry`, which retries once on this
// error so a freshly-rotated token in ~/.codex/auth.json (written by the
// codex CLI's own refresh path) gets a chance to land before we surface
// the failure. Only raised when no caller-visible bytes have been emitted —
// once onDelta has fired, a transparent retry would double-deliver, so
// the stream readers fall through to the generic Error path in that
// case. Internal buffers (text accumulation, tool-call argument deltas)
// do NOT count as emitted output; see emittedToCaller in the readers.
class CodexSessionExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexSessionExpiredError";
  }
}

// Thrown when reading ~/.codex/auth.json observably races the codex CLI's
// non-atomic rewrite — readFileSync returns an empty or partial document
// and JSON.parse fails. Carries the same single-retry contract as
// CodexSessionExpiredError so withCodexSessionRetry can wait out the
// writer and re-read. Distinct error class so the retry helper can
// distinguish "backend rejected the token" from "we couldn't read the
// file" without conflating the two semantically.
class CodexAuthRaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexAuthRaceError";
  }
}

// The codex backend uses several phrasings for the same condition — the
// SSE error event ("Your ChatGPT session expired before this request
// finished"), a `response.failed` event with `incomplete_details.reason`
// carrying snake_case enum codes like `session_expired` / `token_expired`,
// and an initial 401 with body shapes like {"error":{"message":"invalid
// access token"}}. Keep the matcher broad enough to cover all of them
// but anchored on substrings only the auth path produces, so we don't
// retry generic model failures. The separator class `[_\s-]+` accepts
// whitespace, underscores, and hyphens so the human-readable and
// enum-coded forms both match.
const CODEX_SESSION_EXPIRED_RE =
  /session[_\s-]+expired|expired[_\s-]+session|invalid[_\s-]?(?:access[_\s-]?)?token|token[_\s-]+expired|unauthorized/i;

function isCodexSessionExpiredMessage(message: string | undefined): boolean {
  if (!message) return false;
  return CODEX_SESSION_EXPIRED_RE.test(message);
}

// Pull a human-readable error message out of a streamed SSE `error` /
// `response.failed` payload. Tries the shapes the codex backend uses in
// the wild: top-level `message`, nested `error.message`, the
// `response.error.message` slot inside a `response.failed` envelope, and
// `response.incomplete_details.reason` (which the backend uses for
// session rotation in particular). Returns undefined when no field
// matches — callers fall back to a generic stream-error string.
function extractStreamErrorMessage(payload: Record<string, unknown>): string | undefined {
  if (typeof payload.message === "string") return payload.message;
  if (isRecord(payload.error) && typeof payload.error.message === "string") {
    return payload.error.message;
  }
  if (isRecord(payload.response)) {
    const resp = payload.response;
    if (isRecord(resp.error) && typeof resp.error.message === "string") return resp.error.message;
    if (isRecord(resp.incomplete_details) && typeof resp.incomplete_details.reason === "string") {
      return resp.incomplete_details.reason;
    }
  }
  return undefined;
}

// Brief pause before a codex retry. The codex CLI writes
// ~/.codex/auth.json non-atomically (truncate + write, no temp+rename —
// see codex-rs/login/src/auth/storage.rs FileAuthStorage::save), so a
// reader observing the file between the truncate and the flush can
// see an empty or partial JSON document. An immediate retry would race
// that writer; a small wait lets the rewrite settle so the second
// attempt reads a complete file. Exported so other auth.json readers
// (the codex connector probe) can wait out the same window.
export const CODEX_RETRY_REWRITE_DELAY_MS = 50;

// Single-retry wrapper for codex /responses calls. The codex CLI rotates
// access tokens out-of-band; a request in flight at the moment of
// rotation gets a server-side "session expired before this request
// finished" error, even though ~/.codex/auth.json on disk now holds a
// valid new token. `readCodexBearer` re-reads the file on every call, so
// a second attempt picks up the freshly-rotated token without any other
// plumbing. We retry exactly once — a second consecutive session-expired
// usually means the CLI hasn't yet refreshed, and looping would just
// burn quota. A short delay before the retry avoids racing the writer
// (see CODEX_RETRY_REWRITE_DELAY_MS).
//
// Two errors trigger the retry:
//   - CodexSessionExpiredError — the backend rejected the token (401 or
//     SSE error event matching the session-expired regex).
//   - CodexAuthRaceError — local readCodexBearer observed a partial /
//     empty auth.json mid-rewrite. Without this branch the parse failure
//     surfaces as a permanent generic Error and the user sees a hard
//     failure from a transient mid-write read.
async function withCodexSessionRetry<T>(make: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  try {
    return await make();
  } catch (err) {
    if (!(err instanceof CodexSessionExpiredError) && !(err instanceof CodexAuthRaceError)) {
      throw err;
    }
    // Honor the turn's cancellation during the pre-retry wait: abortableSleep
    // rejects with the signal's reason (an AbortError) the moment the user
    // cancels, so attempt 2 is never constructed. Without the signal the wait
    // would run to its full 50 ms and then fire a fresh fetch whose
    // already-aborted signal rejects it — correct outcome, but a wasted
    // round-trip. The throw propagates as an abort, which isAbortError
    // classifies upstream (it is not a session/auth error, so it bypasses the
    // second-failure credential handling below).
    await abortableSleep(CODEX_RETRY_REWRITE_DELAY_MS, signal);
    try {
      return await make();
    } catch (retryErr) {
      // A second consecutive auth.json read failure is no longer a mid-write
      // race — the file is persistently unreadable or corrupt, which is a
      // credential problem the user must fix. Surface it typed so failTask
      // renders the codex re-auth CTA directly (issue #233); typed errors
      // bypass the chat-task message classifier. A second
      // CodexSessionExpiredError stays untouched: its backend message
      // already matches isAuthExpiredError downstream.
      if (retryErr instanceof CodexAuthRaceError) {
        throw new ProviderAuthError("codex", retryErr.message);
      }
      throw retryErr;
    }
  }
}

function readCodexCredentials(provider: ProviderConfig): {
  ok: boolean;
  bearer?: string;
  authPath: string;
  credentialType?: "api_key" | "access_token";
  message: string;
  // True when the failure is plausibly a mid-rewrite read of auth.json
  // (readFileSync threw, or JSON.parse failed). Distinguishes the
  // retryable race window from steady-state "no credentials" states like
  // "file is missing" or "tokens block is absent".
  transient?: boolean;
} {
  const authPath = codexAuthPath(provider);
  if (!existsSync(authPath)) {
    return {
      ok: false,
      authPath,
      message: `No Codex credentials found at ${authPath}. Run codex login or set CODEX_AUTH_JSON.`
    };
  }

  try {
    const raw = readFileSync(authPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const apiKey = typeof parsed.OPENAI_API_KEY === "string" ? parsed.OPENAI_API_KEY : undefined;
    if (apiKey) {
      return {
        ok: true,
        bearer: apiKey,
        authPath,
        credentialType: "api_key",
        message: "Codex generated API key is available."
      };
    }

    const tokens = isRecord(parsed.tokens) ? parsed.tokens : undefined;
    const accessToken = tokens && typeof tokens.access_token === "string" ? tokens.access_token : undefined;
    if (accessToken) {
      return {
        ok: true,
        bearer: accessToken,
        authPath,
        credentialType: "access_token",
        message: "Codex OAuth access token is available."
      };
    }

    return {
      ok: false,
      authPath,
      message: `Codex auth file exists at ${authPath}, but it does not contain OPENAI_API_KEY or tokens.access_token.`
    };
  } catch (error) {
    return {
      ok: false,
      authPath,
      transient: true,
      message: `Could not read Codex credentials at ${authPath}: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

// Public helper for callers that need a yes/no on "are codex credentials
// usable?" without the full credential record. Routes through the same
// codexAuthPath() resolution providerHealth uses so CODEX_AUTH_JSON is
// interpreted consistently (filesystem path, not raw JSON) everywhere.
//
// Pass a ProviderConfig if available; an empty {name:"codex"} is enough
// when the caller just wants to gate a UI flow on credential presence.
export function hasUsableCodexCredentials(provider?: ProviderConfig): boolean {
  const probe = provider ?? { name: "codex" as const, model: DEFAULT_CODEX_MODEL };
  return readCodexCredentials(probe).ok;
}

// Bearer-free view of the codex credential state for health probes (the codex
// connector module). Routes through the same readCodexCredentials resolution
// the provider uses — CODEX_AUTH_JSON honored as a filesystem path, default
// ~/.codex/auth.json otherwise — and additionally decodes the JWT `exp` claim
// off an OAuth access token so a probe can call out an already-expired token
// WITHOUT a network round-trip. Deliberately never exposes the bearer itself.
export interface CodexCredentialProbe {
  ok: boolean;
  authPath: string;
  credentialType?: "api_key" | "access_token";
  message: string;
  // Unix epoch seconds from the access token's JWT `exp` claim. Undefined for
  // api_key-shaped credentials (no expiry to read) and for tokens that don't
  // parse as a JWT — an unparseable token is UNKNOWN, not unhealthy.
  accessTokenExp?: number;
  // True when the failure is plausibly a mid-rewrite read of auth.json
  // (readFileSync threw, or JSON.parse failed) — the same retryable race
  // window readCodexCredentials flags. Probes should retry once after
  // CODEX_RETRY_REWRITE_DELAY_MS instead of reporting unhealthy.
  transient?: boolean;
}

export function probeCodexCredentials(provider?: ProviderConfig): CodexCredentialProbe {
  const probe = provider ?? { name: "codex" as const, model: DEFAULT_CODEX_MODEL };
  const credentials = readCodexCredentials(probe);
  return {
    ok: credentials.ok,
    authPath: credentials.authPath,
    ...(credentials.credentialType ? { credentialType: credentials.credentialType } : {}),
    message: credentials.message,
    ...(credentials.transient ? { transient: true } : {}),
    ...(credentials.credentialType === "access_token" && credentials.bearer
      ? (() => {
          const exp = decodeJwtExp(credentials.bearer);
          return exp === undefined ? {} : { accessTokenExp: exp };
        })()
      : {})
  };
}

// Local, network-free read of a JWT's `exp` claim: split on ".", base64url-
// decode the payload segment, read a finite numeric `exp`. Any deviation from
// that shape (wrong segment count, bad base64, bad JSON, missing/non-numeric
// exp) returns undefined — callers must treat that as "expiry unknown", never
// as "expired".
function decodeJwtExp(token: string): number | undefined {
  const segments = token.split(".");
  if (segments.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(segments[1]!, "base64url").toString("utf8")) as unknown;
    if (!isRecord(payload)) return undefined;
    return typeof payload.exp === "number" && Number.isFinite(payload.exp) ? payload.exp : undefined;
  } catch {
    return undefined;
  }
}

function codexAuthPath(provider: ProviderConfig): string {
  // apiKeyEnv only makes sense for codex providers (where it would point at
  // a CODEX_AUTH_JSON-style path env). For non-codex providers the field
  // typically holds an OpenAI key env name (e.g. "OPENAI_API_KEY") whose
  // value is an `sk-...` secret, not a filesystem path. Honoring it
  // unconditionally would resolve to a nonsense path during openai→codex
  // credential probes and produce false negatives. Gate on provider.name so
  // hasUsableCodexCredentials() reads the real codex auth source regardless
  // of which provider the caller's config currently names.
  const apiKeyEnv = provider.name === "codex" ? provider.apiKeyEnv : undefined;
  const raw = apiKeyEnv && process.env[apiKeyEnv]
    ? process.env[apiKeyEnv]
    : process.env.CODEX_AUTH_JSON ?? DEFAULT_CODEX_AUTH_PATH;
  const path = raw ?? DEFAULT_CODEX_AUTH_PATH;
  return resolve(path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
}

function extractOutputText(payload: Record<string, unknown>): string {
  if (typeof payload.output_text === "string") return payload.output_text;
  const output = Array.isArray(payload.output) ? payload.output : [];
  const parts: string[] = [];
  for (const item of output) {
    if (!isRecord(item)) continue;
    const content = Array.isArray(item.content) ? item.content : [];
    for (const contentItem of content) {
      if (isRecord(contentItem) && typeof contentItem.text === "string") {
        parts.push(contentItem.text);
      }
    }
  }
  return parts.join("\n").trim();
}

function readOpenAIError(payload: Record<string, unknown>): string | undefined {
  if (!isRecord(payload.error)) return undefined;
  return typeof payload.error.message === "string" ? payload.error.message : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Reserved fields that the runtime must own — never let `extraBody` overwrite
// them. Without this, a poisoned config (or a careless --extra-body argument)
// could redirect the call to a different model, smuggle in extra tools, flip
// stream mode and break response parsing, or change data-retention behavior.
// The denylist is the single source of truth so every chat-completions call
// site stays consistent.
//
// Maintainer note: when you add a runtime-owned chat-completions request
// field (e.g. another tool-shape variant, a new structured-output mode), add
// it here too. Vision's `max_tokens`/`max_completion_tokens` are NOT in the
// list — vision spreads its `tokenBudgetField` AFTER the sanitized extras so
// vision callers still win, while non-vision callers can put their own
// `max_tokens` in extraBody legitimately.
//
// `functions` and `function_call` cover OpenAI's deprecated legacy
// function-calling API. The runtime ignores `message.function_call` in
// responses (extractToolCalls only walks `tool_calls`), so a poisoned
// extraBody using the legacy schema would silently drop function results.
//
// `store` controls whether the provider persists the chat completion for
// distillation/evals. The /responses path pins `store: false` explicitly;
// chat-completions paths must stay consistent.
//
// Also block `__proto__`/`constructor`/`prototype` to defend against
// prototype-pollution-style payloads — Object.entries already returns
// __proto__ as an own key when JSON.parse produced it, so without an
// explicit drop the spread would forward it to the API.
//
// `toJSON` is blocked as a defense-in-depth measure. JSON-loaded extraBody
// (the only documented entry point) cannot carry functions, so this is
// dormant in practice. But if a future internal caller constructs
// ProviderConfig programmatically with a callable `toJSON`, the final
// `JSON.stringify({ ...sanitized, model, ... })` would invoke it and could
// return an arbitrary replacement object — including reserved fields.
// Stripping `toJSON` keeps that escape hatch shut.
const RESERVED_EXTRA_BODY_KEYS: ReadonlySet<string> = new Set([
  "model",
  "messages",
  "stream",
  "tools",
  "tool_choice",
  "response_format",
  "functions",
  "function_call",
  "store",
  // Pinned at "in_memory" on every OpenAI-compatible chat-completions
  // builder. Defense-in-depth: a future refactor that reorders the
  // body spread so the typed field comes BEFORE sanitizeExtraBody
  // would silently let extraBody.prompt_cache_retention shadow our
  // explicit opt-out of the "24h" extended tier (documented as not
  // Zero Data Retention eligible). Stripping the key here keeps the
  // protection independent of spread order. See ADR prompt-cache-in-memory-tier.md.
  "prompt_cache_retention",
  "__proto__",
  "constructor",
  "prototype",
  "toJSON"
]);

function sanitizeExtraBody(
  extraBody: Record<string, unknown> | undefined,
  // Per-call extension to the base denylist. Vision passes its token-budget
  // keys (`max_tokens`, `max_completion_tokens`) here so a poisoned extraBody
  // can't smuggle the OTHER token field alongside the runtime-set one — a
  // real bug that broke OpenAI o-series vision (which rejects requests with
  // `max_tokens` present) and could defeat the cap on local/openrouter
  // gateways. Non-vision callers leave this empty so users can legitimately
  // set `max_tokens` via extraBody for chat/structured/tool-calling.
  extraDeny?: ReadonlySet<string>
): Record<string, unknown> {
  if (!extraBody) return {};
  // `Object.create(null)` for the output so future spreads can't be
  // surprised by an inherited prototype. Object.entries on the input only
  // yields own enumerable string-keyed properties, which is what we want.
  const out: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(extraBody)) {
    if (RESERVED_EXTRA_BODY_KEYS.has(key)) continue;
    if (extraDeny && extraDeny.has(key)) continue;
    out[key] = value;
  }
  return out;
}

// Token-budget fields owned by callVisionChatCompletions. Centralized so the
// runtime never accidentally allows extraBody to set the OTHER budget field
// alongside the runtime-set one (e.g. extraBody.max_tokens leaking through
// when openai vision sets max_completion_tokens, or vice versa).
const VISION_RESERVED_EXTRA_BODY_KEYS: ReadonlySet<string> = new Set([
  "max_tokens",
  "max_completion_tokens"
]);

// `system` is owned by the Anthropic Messages builder, which hoists every
// system message into the top-level `system` field. Deny it in extraBody so a
// stray `extraBody.system` can't shadow the runtime-built system prompt — nor
// silently become it on a turn that carries no system message. Scoped to the
// anthropic path via extraDeny because `system` is not a top-level field on the
// OpenAI chat-completions wire shape, where it stays a normal message.
const ANTHROPIC_RESERVED_EXTRA_BODY_KEYS: ReadonlySet<string> = new Set(["system"]);

// Strip trailing slashes from a baseUrl so callers can write either
// `http://x/v1` or `http://x/v1/` and the resulting request URL stays
// `http://x/v1/chat/completions` (not `http://x/v1//chat/completions` —
// some OpenAI-compatible servers reject the doubled slash). The `+`
// collapses runs of trailing slashes; src/embeddings.ts has a similar
// `/\/$/` strip but only catches a single slash.
function trimBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

// Resolve a persisted baseUrl to a request-ready URL. `provider.baseUrl`
// is technically optional but a persisted empty string would also slip
// past `?? DEFAULT`. resolveBaseUrl treats nullish AND whitespace-only
// as missing so neither produces a relative `/chat/completions` URL,
// then trims trailing slashes via trimBaseUrl.
function resolveBaseUrl(baseUrl: string | undefined, fallback: string): string {
  const candidate = baseUrl && baseUrl.trim().length > 0 ? baseUrl : fallback;
  return trimBaseUrl(candidate);
}

// Per-provider default baseUrl. Use this at call sites instead of hardcoding
// DEFAULT_OPENAI_BASE_URL — otherwise an unnormalized provider (or one whose
// persisted baseUrl somehow slipped through normalize as empty) would send
// codex /responses traffic to api.openai.com, or local/Ollama traffic to
// OpenAI. Mirrors the per-provider defaults set by normalizeProvider so the
// call-site fallback agrees with the persisted-config fallback.
function defaultBaseUrl(provider: ProviderConfig): string {
  if (provider.name === "codex") return DEFAULT_CODEX_BASE_URL;
  if (provider.name === "openrouter") return "https://openrouter.ai/api/v1";
  if (provider.name === "local") return "http://127.0.0.1:11434/v1";
  if (provider.name === "deepseek") return DEFAULT_DEEPSEEK_BASE_URL;
  if (provider.name === "anthropic") return DEFAULT_ANTHROPIC_BASE_URL;
  if (provider.name === "bedrock") return bedrockRuntimeBaseUrl(provider.awsRegion ?? DEFAULT_BEDROCK_REGION);
  // Azure has no universal default — it is per-resource. Return empty so a
  // config that slipped through without a baseUrl fails loudly at fetch time
  // instead of silently sending Azure traffic to api.openai.com (a 404).
  if (provider.name === "azure") return "";
  return DEFAULT_OPENAI_BASE_URL;
}

// ---------------- Azure OpenAI routing ----------------
//
// Azure is a first-class provider, so `provider.name === "azure"` is the single
// routing signal — no host-sniffing or field-presence detection. These helpers
// centralize the per-call URL + auth differences so the four chat-completions
// builders stay consistent.

// Build the chat-completions request URL. Standard OpenAI-compatible providers
// hit `${baseUrl}/chat/completions`. Azure has no such flat path: it routes per
// deployment and requires the api-version query, so the URL becomes
// `${baseUrl}/openai/deployments/<deployment>/chat/completions?api-version=<v>`.
// The deployment defaults to the model id; api-version defaults to the GA value
// (normalizeProvider already fills it for a persisted config — default here too
// so a hand-built azure ProviderConfig still routes). Components are
// percent-encoded so an unusual deployment/version value can't break the path.
function chatCompletionsUrl(provider: ProviderConfig, baseUrl: string): string {
  if (provider.name !== "azure") return `${baseUrl}/chat/completions`;
  const apiVersion = provider.apiVersion?.trim() || DEFAULT_AZURE_API_VERSION;
  const deployment = (provider.deployment?.trim() || provider.model).trim();
  return `${baseUrl}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;
}

// Auth header for a chat-completions request. Azure resource-key auth uses the
// `api-key` header; every other provider — and Azure Entra-token auth, selected
// by authScheme "bearer" — uses `Authorization: Bearer`. `apiKey` is optional so
// a keyless local gateway sends no auth header at all.
function chatCompletionsAuthHeader(
  provider: ProviderConfig,
  apiKey: string | undefined
): Record<string, string> {
  if (!apiKey) return {};
  if (provider.name === "azure" && provider.authScheme !== "bearer") {
    return { "api-key": apiKey };
  }
  return { authorization: `Bearer ${apiKey}` };
}

// prompt_cache_retention body fragment. The runtime pins "in_memory" on every
// OpenAI-compatible chat-completions / responses call (ADR
// prompt-cache-in-memory-tier.md), explicitly opting out of the "24h" extended
// tier. Azure rejects that: some deployments (gpt-5.x) return "This model is
// compatible only with 24h extended prompt caching", so omit the field for
// azure and let the resource manage its own prompt caching (Azure controls data
// retention at the resource level, not via this request field).
function promptCacheRetentionBody(provider: ProviderConfig): Record<string, string> {
  if (provider.name === "azure") return {};
  return { prompt_cache_retention: "in_memory" };
}

// True when an azure config has no usable resource base URL — missing,
// whitespace, or a value with no parseable host (e.g. a bare "https://", which
// would pass a naive non-empty + https-prefix check but build a hostless
// `https:///openai/deployments/...` URL that fetch rejects). Azure is
// per-resource with no default, so chatCompletionsUrl would otherwise build a
// relative/hostless deployment path that fails. The config-entry boundaries
// (CLI `provider set`, the setup API, and the set_provider tool that funnels
// through it) reject this before persisting. normalizeProvider itself stays a
// pure transform and never throws, so config hydration and per-agent override
// resolution are unaffected.
export function azureNeedsBaseUrl(name: string, baseUrl: string | undefined): boolean {
  if (name !== "azure") return false;
  const value = (baseUrl ?? "").trim();
  if (value.length === 0) return true;
  try {
    return new URL(value).hostname.length === 0;
  } catch {
    return true; // unparseable URL → needs a real resource endpoint
  }
}

// Azure sends a credential on every call — the resource key in a plaintext
// `api-key` header, or an Entra access token as `Authorization: Bearer`. Either
// leaks over plaintext http, so refuse to configure an azure endpoint that
// isn't https. Azure is https across every cloud, so this never blocks a
// legitimate setup; requiring https (rather than a host allowlist) keeps it
// cloud-agnostic. An empty baseUrl is left to azureNeedsBaseUrl.
export function azureNeedsHttps(name: string, baseUrl: string | undefined): boolean {
  if (name !== "azure") return false;
  const value = (baseUrl ?? "").trim().toLowerCase();
  if (value.length === 0) return false;
  return !value.startsWith("https://");
}

// The anthropic provider sends ANTHROPIC_API_KEY in an x-api-key header on every
// request, so a plaintext http custom baseUrl would leak the key in transit.
// Refuse a non-https custom endpoint — EXCEPT an explicit loopback host (a local
// http proxy is a deliberate, low-risk dev setup). Parse the URL rather than
// prefix-matching so a hostless value like a bare "https://" (which would build
// an unreachable "https:///v1/messages") is refused too. An empty baseUrl uses
// the https first-party default, so it's left alone.
export function anthropicNeedsHttps(name: string, baseUrl: string | undefined): boolean {
  if (name !== "anthropic") return false;
  const value = (baseUrl ?? "").trim();
  if (value.length === 0) return false;
  let host: string;
  try {
    // URL.hostname returns an IPv6 literal in brackets, e.g. "[::1]".
    const parsed = new URL(value);
    host = parsed.hostname.toLowerCase();
    if (host.length === 0) return true; // e.g. bare "https://" — no host to reach
    if (parsed.protocol === "https:") return false; // https with a real host is fine
  } catch {
    return true; // unparseable → not a safe https endpoint
  }
  // Non-https with a real host: allow only explicit loopback (a local dev proxy).
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") return false;
  return true; // non-https, non-loopback → refuse (key would go in cleartext)
}

// ---------------- Vision (image input) ----------------
//
// Single-shot vision call: caller provides a prompt + one inline base64 PNG/JPEG,
// the provider returns plain text. Used by browser_vision to ask the configured
// vision model about a page screenshot without exposing pixels to the agent
// loop itself. We intentionally keep the surface tiny — one image, low detail,
// small max_tokens — so cost stays bounded.
export interface VisionRequest {
  prompt: string;
  imageBase64: string;
  mimeType: "image/png" | "image/jpeg";
  // Caps the model's response length. Defaults to 512 (small budget keeps
  // surprise costs predictable; callers that need more should raise the cap
  // explicitly and document why).
  maxTokens?: number;
}

export interface VisionResult {
  text: string;
  provider: ProviderConfig;
  usage?: Record<string, unknown>;
  cost?: CostRecord;
}

// Echo provider vision stubs — mirror of echoToolCallingStubs. Tests register
// canned results; default fallback returns a deterministic "Vision stub: <prompt>"
// so callers that forget to seed a stub still see a stable shape.
const echoVisionStubs: Array<{ tag?: string; result: Omit<VisionResult, "provider"> & { provider?: ProviderConfig } }> = [];

export function setEchoVisionResponse(
  result: Omit<VisionResult, "provider"> & { provider?: ProviderConfig },
  tag?: string
): void {
  echoVisionStubs.push({ tag, result });
}

export function clearEchoVisionResponses(): void {
  echoVisionStubs.length = 0;
}

function nextEchoVisionResult(provider: ProviderConfig, prompt: string): VisionResult {
  const stub = echoVisionStubs.shift();
  if (stub) {
    return { provider: stub.result.provider ?? provider, ...stub.result };
  }
  return { provider, text: `Vision stub: ${prompt}` };
}

export async function generateVisionAnalysis(
  config: RuntimeConfig,
  request: VisionRequest
): Promise<VisionResult> {
  const provider = normalizeProvider(config.provider);
  const maxTokens = request.maxTokens ?? 512;
  if (provider.name === "echo") {
    return nextEchoVisionResult(provider, request.prompt);
  }
  if (provider.name === "codex") {
    return callVisionCodex(provider, request, maxTokens);
  }
  if (provider.name === "anthropic" || provider.name === "bedrock") {
    const dataUrl = `data:${request.mimeType};base64,${request.imageBase64}`;
    const messages: ToolCallingMessage[] = [
      { role: "user", content: [{ type: "text", text: request.prompt }, { type: "image_url", image_url: { url: dataUrl } }] }
    ];
    const result = provider.name === "bedrock"
      ? await callBedrockConverse(provider, messages, [], undefined, maxTokens)
      : await callAnthropicMessages(provider, messages, [], undefined, maxTokens);
    return { provider: result.provider, text: result.text, usage: result.usage, cost: result.cost };
  }
  // openai / openrouter / local — all expose chat-completions with the same
  // multi-modal content array shape (`type: "image_url"`).
  return callVisionChatCompletions(provider, request, maxTokens);
}

async function callVisionCodex(
  provider: ProviderConfig,
  request: VisionRequest,
  maxTokens: number
): Promise<VisionResult> {
  // Vision goes through codex's non-streaming /responses path, so the
  // session-rotation failure mode is a 401 on the initial response (not
  // a mid-stream error event). Map that to CodexSessionExpiredError so
  // withCodexSessionRetry can re-read auth.json and try again.
  return withCodexSessionRetry(async () => {
    const bearer = readCodexBearer(provider);
    const baseUrl = resolveBaseUrl(provider.baseUrl, defaultBaseUrl(provider));
    const dataUrl = `data:${request.mimeType};base64,${request.imageBase64}`;
    const response = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
        accept: "application/json",
        ...codexHeaders(bearer)
      },
      body: JSON.stringify({
        model: provider.model,
        store: false,
        stream: false,
        instructions: "",
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: request.prompt },
              { type: "input_image", image_url: dataUrl, detail: "low" }
            ]
          }
        ],
        max_output_tokens: maxTokens
      })
    });
    const rawPayload = await response.text();
    const payload = parseJsonObject(rawPayload);
    if (!response.ok) {
      const fallback = rawPayload.slice(0, 500) || `Codex vision request failed with HTTP ${response.status}`;
      const message = readOpenAIError(payload) ?? fallback;
      if (response.status === 401 && isCodexSessionExpiredMessage(message)) {
        throw new CodexSessionExpiredError(message);
      }
      throw new Error(message);
    }
    const text = extractOutputText(payload);
    const usage = isRecord(payload.usage) ? payload.usage : undefined;
    return {
      provider,
      text,
      usage,
      cost: estimateCost(provider, usage)
    };
  });
}

async function callVisionChatCompletions(
  provider: ProviderConfig,
  request: VisionRequest,
  maxTokens: number
): Promise<VisionResult> {
  const envName = provider.apiKeyEnv ?? "OPENAI_API_KEY";
  const apiKey = provider.name === "local" ? process.env[envName] : readOpenAIBearer(provider);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...chatCompletionsAuthHeader(provider, apiKey),
    ...(provider.name === "openrouter" ? { "HTTP-Referer": "http://127.0.0.1:7337", "X-Title": "Gini Agent" } : {})
  };
  const baseUrl = resolveBaseUrl(provider.baseUrl, defaultBaseUrl(provider));
  const dataUrl = `data:${request.mimeType};base64,${request.imageBase64}`;
  // OpenAI's newer o-series chat models reject `max_tokens` outright and
  // require `max_completion_tokens`. Older OpenAI models still accept the
  // legacy field. OpenRouter / local OpenAI-compatible gateways may not
  // recognize the newer name yet, so we keep `max_tokens` for them. Send
  // only the field each backend expects to avoid double-counting or
  // 400-level errors.
  // Azure serves OpenAI models, whose newer o-series reject `max_tokens` and
  // require `max_completion_tokens` — so azure follows the openai field choice.
  const tokenBudgetField = provider.name === "openai" || provider.name === "azure"
    ? { max_completion_tokens: maxTokens }
    : { max_tokens: maxTokens };
  const response = await fetch(chatCompletionsUrl(provider, baseUrl), {
    method: "POST",
    headers,
    body: JSON.stringify({
      ...sanitizeExtraBody(provider.extraBody, VISION_RESERVED_EXTRA_BODY_KEYS),
      model: provider.model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: request.prompt },
            { type: "image_url", image_url: { url: dataUrl, detail: "low" } }
          ]
        }
      ],
      stream: false,
      ...tokenBudgetField,
      ...promptCacheRetentionBody(provider)
    })
  });
  const rawPayload = await response.text();
  const payload = parseJsonObject(rawPayload);
  if (!response.ok) {
    const fallback = rawPayload.slice(0, 500) || `Vision request failed with HTTP ${response.status}`;
    throw new Error(readOpenAIError(payload) ?? fallback);
  }
  const text = extractChatText(payload);
  const usage = isRecord(payload.usage) ? payload.usage : undefined;
  return {
    provider,
    text,
    usage,
    cost: estimateCost(provider, usage)
  };
}

// ---------------- Aux text (single-shot side call) ----------------
//
// One system instruction + one user input, plain text back. Used by the
// browser snapshot path to summarize the over-budget remainder of a
// first-visit snapshot without involving the agent loop. Same
// tiny-surface philosophy as generateVisionAnalysis: a single turn, no
// identity files / memory recall, bounded max tokens.
export interface AuxTextRequest {
  system: string;
  user: string;
  // Caps the model's response length. Defaults to 1024.
  maxTokens?: number;
}

export interface AuxTextResult {
  text: string;
  provider: ProviderConfig;
  usage?: Record<string, unknown>;
  cost?: CostRecord;
}

// Echo provider aux-text stubs — mirror of echoVisionStubs. Received
// requests are recorded so tests can assert what the aux model was sent
// (e.g. that snapshot-summarization input was redacted first). A stub
// with `error` set makes the echo call throw, exercising callers'
// aux-failure fallback paths.
const echoAuxTextStubs: Array<{ result?: Omit<AuxTextResult, "provider"> & { provider?: ProviderConfig }; error?: string }> = [];
const echoAuxTextRequests: AuxTextRequest[] = [];

export function setEchoAuxTextResponse(
  result: Omit<AuxTextResult, "provider"> & { provider?: ProviderConfig }
): void {
  echoAuxTextStubs.push({ result });
}

export function setEchoAuxTextFailure(message: string): void {
  echoAuxTextStubs.push({ error: message });
}

export function clearEchoAuxTextResponses(): void {
  echoAuxTextStubs.length = 0;
  echoAuxTextRequests.length = 0;
}

export function getEchoAuxTextRequests(): AuxTextRequest[] {
  return echoAuxTextRequests.map((request) => ({ ...request }));
}

export async function generateAuxText(
  config: RuntimeConfig,
  request: AuxTextRequest,
  // Optional per-call override, same contract as generateToolCallingResponse:
  // a caller that resolved a per-agent provider passes it here so the aux
  // side-call (which can carry transcript content) goes to the provider that
  // serves the agent, not the global config provider. config.provider is
  // never mutated.
  providerOverride?: ProviderConfig,
  // Optional per-turn abort signal, same contract as
  // generateToolCallingResponse: cancelTask aborts the in-flight aux call (the
  // in-turn compaction summary) at the source so a cancelled turn stops here too.
  signal?: AbortSignal
): Promise<AuxTextResult> {
  const provider = normalizeProvider(providerOverride ?? config.provider);
  const maxTokens = request.maxTokens ?? 1024;
  if (provider.name === "echo") {
    echoAuxTextRequests.push({ ...request });
    const stub = echoAuxTextStubs.shift();
    if (stub?.error !== undefined) throw new Error(stub.error);
    if (stub?.result) return { provider: stub.result.provider ?? provider, ...stub.result };
    return { provider, text: `Aux text stub: ${request.user.slice(0, 80)}` };
  }
  if (provider.name === "anthropic" || provider.name === "bedrock") {
    const messages: ToolCallingMessage[] = [
      { role: "system", content: request.system },
      { role: "user", content: request.user }
    ];
    const result = provider.name === "bedrock"
      ? await callBedrockConverse(provider, messages, [], undefined, maxTokens, signal)
      : await callAnthropicMessages(provider, messages, [], undefined, maxTokens, signal);
    return { provider: result.provider, text: result.text, usage: result.usage, cost: result.cost };
  }
  if (provider.name === "codex" || provider.name === "openai") {
    const result = await callOpenAIResponses(provider, request.user, request.system, undefined, maxTokens, signal);
    return { provider: result.provider, text: result.text, usage: result.usage, cost: result.cost };
  }
  // openrouter / local / deepseek / azure — OpenAI-compatible chat-completions.
  const result = await callChatCompletions(provider, request.user, request.system, maxTokens, signal);
  return { provider: result.provider, text: result.text, usage: result.usage, cost: result.cost };
}

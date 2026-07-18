// Provider × model capability record — a living table of which providers/
// models accept image input (`vision`), ingest documents natively
// (`nativeDocs`, e.g. PDF → text + page-images on the provider side), and
// how large their context windows are for prior-chat replay budgeting.
//
// Used at task-build time to decide attachment delivery and prior-history
// token budgets: `nativeDocs` gates the native `document` content part;
// `vision` gates the image content part in `buildAttachmentContent` (a
// non-vision model degrades an image attachment to a text note, current
// turn and replay alike, plus an arrival-turn steering directive so the
// agent refuses in-band rather than hallucinating image contents).
//
// Defaults are conservative: an unknown provider/model resolves to
// { vision: false, nativeDocs: false } and a 32K-token context window so we
// never emit a content part a provider can't parse or assume a huge unknown
// context window.
//
// Update path: add a provider branch (or extend an existing one) below as
// providers/models gain modalities, with a source in the PR. The static
// per-provider/model-family table here is the v1 strategy; live discovery
// of OpenRouter's `architecture.input_modalities` (per routed model) is a
// follow-up that would replace the hardcoded OpenRouter family list.

import type { ProviderConfig } from "./types";

export interface ProviderModality {
  vision: boolean;
  nativeDocs: boolean;
}

export const PRIOR_CONTEXT_WINDOW_FRACTION = 0.65;
export const FALLBACK_CONTEXT_WINDOW_TOKENS = 32_000;

// The ChatGPT Codex backend enforces a ~275k effective context window
// regardless of the underlying model's nominal window: gpt-5.5 is 1M on the
// direct OpenAI API but only 275k when served through Codex. Cap the codex
// provider at this backend limit so prior-context packing budgets against the
// real window instead of the model's larger nominal one.
export const CODEX_BACKEND_CONTEXT_WINDOW_TOKENS = 275_000;

// Known OpenAI vision/document model families. The `openai` provider name
// also covers custom OpenAI-compatible endpoints (a user-set baseUrl + an
// arbitrary model id), so gating on a known family keeps an unrecognized or
// text-only compatible model from being handed a `document` part it 400s on.
// The trailing boundary (end-of-string, `-`, or `.`) prevents prefix
// collisions: `gpt-5.4`/`gpt-4o-mini`/`o1-mini` match, but a colliding id
// like `gpt-5foo`/`gpt-4oish`/`o1derful` does not (defaults conservatively
// to false rather than being handed a document part).
const OPENAI_NATIVE_FAMILY = /^(gpt-4o|gpt-4\.1|gpt-5|o1|o3|o4|chatgpt-4o)(?=$|[-.])/i;

function normalizeModel(model: string | undefined): string {
  return (model ?? "").trim().toLowerCase();
}

function openaiContextWindowTokens(model: string): number {
  const slug = normalizeModel(model);
  if (slug.length === 0) return FALLBACK_CONTEXT_WINDOW_TOKENS;
  if (/^gpt-5(?:\.[2345])?-chat(?=$|-)/.test(slug)) return 128_000;
  if (/^(gpt-4o|chatgpt-4o)(?=$|[-.])/.test(slug)) return 128_000;
  if (/^gpt-5\.5(?=$|[-.])/.test(slug)) return 1_000_000;
  if (/^gpt-5\.4-(mini|nano)(?=$|-)/.test(slug)) return 400_000;
  if (/^gpt-5\.4(?=$|-)/.test(slug)) return 1_050_000;
  if (/^gpt-5(?:\.[23])?(?=$|-)/.test(slug)) return 400_000;
  if (/^gpt-4\.1(?=$|-)/.test(slug)) return 1_047_576;
  if (/^o[134](?=$|-)/.test(slug)) return 200_000;
  return FALLBACK_CONTEXT_WINDOW_TOKENS;
}

function deepseekContextWindowTokens(model: string): number {
  const slug = normalizeModel(model);
  if (/^deepseek-v4(?=$|-)/.test(slug)) return 1_000_000;
  if (slug === "deepseek-chat" || slug === "deepseek-reasoner") return 1_000_000;
  return FALLBACK_CONTEXT_WINDOW_TOKENS;
}

function openrouterContextWindowTokens(model: string): number {
  const slug = normalizeModel(model);
  const slash = slug.indexOf("/");
  if (slash < 0) return FALLBACK_CONTEXT_WINDOW_TOKENS;
  const vendor = slug.slice(0, slash);
  const routedModel = slug.slice(slash + 1);
  if (vendor === "openai") return openaiContextWindowTokens(routedModel);
  if (vendor === "deepseek") return deepseekContextWindowTokens(routedModel);
  if (vendor === "anthropic") return claudeContextWindowTokens(routedModel);
  if (vendor === "google" && routedModel.startsWith("gemini")) return 1_000_000;
  return FALLBACK_CONTEXT_WINDOW_TOKENS;
}

// Claude context window by family. The 1M-token window is GA on Opus 4.6+,
// Sonnet 4.6, and Fable 5 (first-party API and Amazon Bedrock alike, at
// standard pricing with no long-context premium); Haiku 4.5 and older or
// unrecognized Claude ids stay at the 200K window. `slug` is the normalized
// model id and may carry a Bedrock inference-profile prefix
// ("us.anthropic.claude-opus-4-8") or arrive bare ("claude-opus-4-8") — both
// match the family patterns. The minor-version classes ([6-9]|\d\d) keep
// future point releases (Opus 4.9+) on 1M while leaving 4.5/4.1/4.0 at 200K.
// The `(?=$|[-.])` boundary anchors the minor token to a whole segment so a
// model id's DATE STAMP can't be misread as a minor version (e.g.
// "claude-sonnet-4-20250514" must not match `4-\d\d` via the "20" of the date
// and jump to 1M; it falls to 200K). Real ids delimit the minor with end-of-
// string or a `-`/`.` separator, never a glued suffix.
function claudeContextWindowTokens(slug: string): number {
  if (/claude-opus-4-(?:[6-9]|\d\d)(?=$|[-.])/.test(slug)) return 1_000_000;
  if (/claude-sonnet-4-(?:[6-9]|\d\d)(?=$|[-.])/.test(slug)) return 1_000_000;
  if (/claude-fable-\d/.test(slug)) return 1_000_000;
  if (/claude/.test(slug)) return 200_000;
  return FALLBACK_CONTEXT_WINDOW_TOKENS;
}

// First-party Anthropic Messages API. An unrecognized id stays conservative on
// the fallback (see claudeContextWindowTokens).
function anthropicContextWindowTokens(model: string): number {
  return claudeContextWindowTokens(normalizeModel(model));
}

// Bedrock model ids are cross-region inference profiles, e.g.
// "us.anthropic.claude-opus-4-8" or "us.amazon.nova-pro-v1:0". Key off the
// provider+family segment so each family gets its real window; unknown ids
// (other Bedrock families we don't enumerate) keep the conservative fallback.
function bedrockContextWindowTokens(model: string): number {
  const slug = normalizeModel(model);
  if (/anthropic\.claude/.test(slug)) return claudeContextWindowTokens(slug);
  if (/amazon\.nova-premier/.test(slug)) return 1_000_000;
  if (/amazon\.nova-(pro|lite)/.test(slug)) return 300_000;
  if (/amazon\.nova-micro/.test(slug)) return 128_000;
  return FALLBACK_CONTEXT_WINDOW_TOKENS;
}

export function resolveProviderContextWindowTokens(provider: ProviderConfig): number {
  const model = provider.model ?? "";
  switch (provider.name) {
    case "openai":
    // Azure hosts the same OpenAI models, so the context window follows the
    // model family just like standard OpenAI.
    case "azure":
      return openaiContextWindowTokens(model);
    case "codex":
      // Clamp to the backend cap; min() stays correct if codex is ever pointed
      // at a model whose nominal window is already below the cap.
      return Math.min(CODEX_BACKEND_CONTEXT_WINDOW_TOKENS, openaiContextWindowTokens(model));
    case "openrouter":
      return openrouterContextWindowTokens(model);
    case "deepseek":
      return deepseekContextWindowTokens(model);
    case "anthropic":
      return anthropicContextWindowTokens(model);
    case "bedrock":
      return bedrockContextWindowTokens(model);
    case "local":
    case "echo":
      return FALLBACK_CONTEXT_WINDOW_TOKENS;
    default:
      return FALLBACK_CONTEXT_WINDOW_TOKENS;
  }
}

export function resolveDefaultPriorContextTokenBudget(provider: ProviderConfig): number {
  return Math.floor(resolveProviderContextWindowTokens(provider) * PRIOR_CONTEXT_WINDOW_FRACTION);
}

// Conservative max-output-token floor for a model whose family we don't
// recognize, and the historical Anthropic/Bedrock default. Every send-site
// fell back to this flat 8192 before per-family resolution existed; keeping it
// as the floor means an unrecognized id behaves exactly as it did before.
export const FALLBACK_MAX_OUTPUT_TOKENS = 8_192;

// Max output tokens (synchronous Messages/Converse) by Claude family. The model
// REJECTS a max_tokens above its real ceiling with a 400 (Bedrock
// ValidationException "exceeds the model limit of N"; first-party Anthropic the
// equivalent) — it does NOT clamp — so this must never overshoot. Ceilings:
// Opus/Sonnet 4.6+ and Fable at 128K; Haiku 4.5, Opus 4.5, and Sonnet 4.5 at
// 64K; Sonnet 4.0 at 64K; Opus 4.1 and Opus 4.0 at 32K. These are verified
// against the Anthropic Models API AND the live Bedrock runtime (a Converse
// call probes the exact boundary: us.anthropic.claude-sonnet-4-6 accepts
// maxTokens=128000 and 400s at 128001 with "exceeds the model limit of
// 128000"). NOTE: the AWS Bedrock model-card page is STALE for Sonnet 4.6 — it
// lists "Max output tokens: 64K", but the runtime enforces 128000, so do NOT
// "correct" this table down to match that doc. `slug` may carry a Bedrock
// inference-profile prefix ("us.anthropic.claude-opus-4-8") or be bare
// ("claude-opus-4-8"); both match. Anything else (3.x, EOL, unrecognized) stays
// on the conservative floor.
//
// The minor-version classes are anchored with a trailing `(?=$|[-.])` so a
// model id's DATE STAMP can't be misread as a minor version: without a
// boundary, `claude-sonnet-4-20250514` (Sonnet 4.0, dated) matches
// `[…]4-(?:[6-9]|\d\d)` because `\d\d` eats "20" → a wrong 128K ceiling → a 400
// on a real Sonnet-4.0 streaming turn. The boundary forces the minor token to be
// a WHOLE segment (end of string, or followed by a `-`/`.` separator — the only
// ways a minor version is delimited in real first-party and Bedrock ids), so a
// date run or a glued suffix can't be misread as a minor version. The explicit
// 4.5/4.1/4.0 patterns pin the older tiers; order matters (specific tiers before
// the 6-9 class).
function claudeMaxOutputTokens(slug: string): number {
  if (/claude-opus-4-(?:[6-9]|\d\d)(?=$|[-.])/.test(slug)) return 128_000;
  if (/claude-sonnet-4-(?:[6-9]|\d\d)(?=$|[-.])/.test(slug)) return 128_000;
  if (/claude-fable-\d/.test(slug)) return 128_000;
  if (/claude-haiku-4-5/.test(slug)) return 64_000;
  if (/claude-opus-4-5/.test(slug)) return 64_000;
  if (/claude-sonnet-4-5/.test(slug)) return 64_000;
  if (/claude-opus-4-1/.test(slug)) return 32_000;
  // Bare major-version 4.0 ids (e.g. "claude-sonnet-4-20250514" — a date stamp
  // follows the major, no minor version). Match the major followed directly by
  // a non-minor segment so 4.5/4.6 (handled above) don't fall in here.
  if (/claude-sonnet-4-20\d/.test(slug)) return 64_000;
  if (/claude-opus-4-20\d/.test(slug)) return 32_000;
  return FALLBACK_MAX_OUTPUT_TOKENS;
}

// Max output tokens for a Bedrock model id (cross-region inference profile,
// e.g. "us.anthropic.claude-sonnet-4-6" or "us.amazon.nova-pro-v1:0"). Claude
// families defer to claudeMaxOutputTokens; the non-Claude families carry their
// own probed ceilings. Unknown families stay on the conservative floor.
function bedrockMaxOutputTokens(model: string): number {
  const slug = normalizeModel(model);
  if (/anthropic\.claude/.test(slug)) return claudeMaxOutputTokens(slug);
  if (/amazon\.nova-premier/.test(slug)) return 32_000;
  if (/amazon\.nova-(pro|lite|micro)/.test(slug)) return 10_000;
  if (/deepseek\.r1/.test(slug)) return 32_768;
  if (/meta\.llama4/.test(slug)) return 8_192;
  return FALLBACK_MAX_OUTPUT_TOKENS;
}

// Default max_tokens for the streaming tool-calling loop, where a tool call's
// arguments must fit in one response: if the model truncates them mid-JSON
// (stopReason "max_tokens"/"length"), the runtime can't parse the call and the
// turn fails (see the file_write/code_exec "JSON Parse error: Expected '}'"
// cascade this replaced). Returns the model's REAL output ceiling so a large
// tool argument (a long file body, a big code block) fits.
//
// Scope: only the `anthropic` and `bedrock` providers historically applied a
// flat 8192 default; the chat-completions providers (openai/azure/openrouter/
// deepseek/local) send no max_tokens at all, so the model's own server-side max
// applies and they are not affected. Callers on those providers get the floor.
//
// IMPORTANT — streaming only: this ceiling is for the streaming send-path. A
// NON-streaming request with a large max_tokens trips the first-party Anthropic
// API's "streaming is required for long requests" guard, so non-streaming
// callers (structured-output) must keep a small explicit budget rather than
// this value.
export function resolveMaxOutputTokens(provider: ProviderConfig): number {
  switch (provider.name) {
    case "anthropic":
      return claudeMaxOutputTokens(normalizeModel(provider.model ?? ""));
    case "bedrock":
      return bedrockMaxOutputTokens(provider.model ?? "");
    default:
      return FALLBACK_MAX_OUTPUT_TOKENS;
  }
}

// OpenRouter routes to many upstream models under `<vendor>/<model>` slugs.
// The families below are documented to accept image + file input via
// OpenRouter's unified `file` content part. Anything outside these families
// (or an unrecognized slug) falls back to the conservative default.
function openrouterModality(model: string): ProviderModality {
  const slug = model.toLowerCase();
  const supported =
    slug.startsWith("anthropic/") ||
    slug.startsWith("google/gemini") ||
    slug.startsWith("openai/");
  return supported ? { vision: true, nativeDocs: true } : { vision: false, nativeDocs: false };
}

export function resolveProviderModality(provider: ProviderConfig): ProviderModality {
  const model = provider.model ?? "";
  switch (provider.name) {
    case "openai":
      // gpt-4o / 4.1 / 5.x / o-series accept image input and ingest files
      // natively (Responses input_file / Chat-Completions file). Gate on a
      // known family so an unknown model id (or a custom OpenAI-compatible
      // endpoint pointed at a text-only model) stays conservatively false.
      return OPENAI_NATIVE_FAMILY.test(model)
        ? { vision: true, nativeDocs: true }
        : { vision: false, nativeDocs: false };
    case "azure":
      // Azure serves OpenAI models, so vision follows the same model family.
      // But Azure's deployment-scoped chat/completions does NOT accept the
      // `file` content part (its content schema is text/image/audio), so a
      // native `document` part would 400 — keep nativeDocs false in Azure mode.
      return OPENAI_NATIVE_FAMILY.test(model)
        ? { vision: true, nativeDocs: false }
        : { vision: false, nativeDocs: false };
    case "openrouter":
      return openrouterModality(model);
    case "deepseek":
      // Confirmed text-only API — no image/file content part.
      return { vision: false, nativeDocs: false };
    case "anthropic":
      // Claude Opus/Sonnet/Haiku accept image input and ingest documents
      // natively via the Messages API (image + document content blocks). The
      // family is uniformly multimodal, so unlike the openai branch there's
      // no per-model gate. translateMessagesToAnthropic maps image_url and
      // document parts into the corresponding base64 source blocks.
      return { vision: true, nativeDocs: true };
    case "bedrock": {
      // Bedrock Converse exposes image content blocks per-model; enable vision
      // for the families that accept them (Claude 3+, the multimodal Nova tiers,
      // Mistral Pixtral, Llama 4, the Llama 3.2 vision variants). Text-only ids
      // (DeepSeek R1, Llama 3.3, Nova Micro) and unrecognized ids stay false so
      // the vision path never sends a block the model rejects.
      //
      // nativeDocs is false regardless: the Converse translator (converseUserContent)
      // does not emit `document` blocks, so document parts must flow through the
      // runtime's extract-to-text fallback rather than being passed "natively"
      // and silently dropped. (Native Converse document blocks are a follow-up.)
      const visionFamily =
        /anthropic\.claude|amazon\.nova-(?:pro|lite|premier)|pixtral|llama4|llama3-2-(?:11b|90b)/i.test(model);
      return { vision: visionFamily, nativeDocs: false };
    }
    case "codex":
      // Verified empirically against the live ChatGPT-backend /responses
      // surface (gpt-5.x): it accepts a native `input_file` document part
      // (a PDF sent as a document part — no inlined text — was read back
      // verbatim) and an `image_url`/`input_image` part (text in an image
      // was read back). The backend is undocumented but is a single known
      // surface serving gpt-5.x, so treat it as natively multimodal.
      return { vision: true, nativeDocs: true };
    case "local":
      // Text-only unless a vision-capable model is loaded; nativeDocs
      // essentially never. UNKNOWN → conservative false.
      // TODO: detect a loaded vision model and flip `vision` when present.
      return { vision: false, nativeDocs: false };
    case "echo":
      // Test stub; no real modality.
      return { vision: false, nativeDocs: false };
    default:
      // Unknown provider → conservative default.
      return { vision: false, nativeDocs: false };
  }
}

// Maximum raw image bytes a single image content part may carry. The choke
// point is Anthropic's Messages API, which caps the base64-encoded
// `image.source.base64` payload — NOT the decoded bytes — at 5,242,880 server-
// side. base64 inflates raw bytes by 4/3, so the raw budget that keeps the
// encoded payload under the cap (with margin) is target * 3 / 4. Callers compare
// raw decoded bytes against this limit. It is universal across every provider:
// anthropic and bedrock share the cap, openrouter can route to an Anthropic
// upstream, and providers that allow more (e.g. openai's 20 MB) are still safely
// served by a smaller, high-quality JPEG. Kept as a per-provider hook so a
// future provider with a different ceiling can be tuned here without touching
// the build path.
export function resolveImageByteLimit(_provider: ProviderConfig): number {
  const PROVIDER_BASE64_CAP = 5_242_880;
  // Stay a margin under the hard cap on the encoded payload, then convert the
  // encoded budget back to a raw-byte budget (base64 is 4/3 the size of raw).
  const encodedTargetWithMargin = Math.min(5_000_000, PROVIDER_BASE64_CAP);
  return Math.floor((encodedTargetWithMargin * 3) / 4);
}

// Bedrock Converse tool use (function calling) is per-model. Every family in the
// catalog accepts a `toolConfig` EXCEPT DeepSeek, whose R1 reasoning model
// Converse rejects with a ValidationException ("This model doesn't support tool
// use"). A normal chat turn always loads tools, so without this gate a DeepSeek
// agent 400s on every turn; omitting toolConfig lets it run text-only instead.
// Denylist the known-incompatible family rather than allowlisting — the runtime
// accepts custom ids and the rest of Bedrock (Claude, Nova, Llama, Mistral)
// supports tool use, so an unrecognized id should default to attaching tools.
export function bedrockSupportsToolUse(model: string): boolean {
  return !/deepseek/i.test(model);
}

// Whether a Bedrock model can carry toolConfig on a streaming (converse-stream)
// request. Llama 4 streams fine and uses tools fine, but NOT both at once — a
// Llama 4 ConverseStream with toolConfig returns "This model doesn't support tool
// use in streaming mode" (verified live; the model card's blanket "no
// ConverseStream" wording is broader than the actual constraint). callBedrockConverse
// uses this to drop to non-stream Converse for Llama 4 only when it is attaching
// tools — tool-less Llama 4 turns still stream. Denylist the known family;
// everything else supports tools + streaming together.
export function bedrockSupportsStreamingWithTools(model: string): boolean {
  return !/llama4/i.test(model);
}

// Whether a Claude model accepts the fine-grained-tool-streaming beta flag,
// which streams a tool_use block's input JSON incrementally instead of
// buffering it whole. Documented for the Claude 4 FAMILY ONLY — "Claude Sonnet
// 4.5, Claude Haiku 4.5, Claude Sonnet 4, and Claude Opus 4" (AWS Bedrock
// "Anthropic Claude tool use" docs; the first-party Messages API matches). Older
// Claude 3.x/3.5 ids and the non-Claude Bedrock families (Nova, Llama, DeepSeek,
// Mistral) are NOT listed, and the API rejects an unsupported beta with a 400
// rather than ignoring it.
//
// The flag we send is DATE-STAMPED (fine-grained-tool-streaming-2025-05-14), so
// the gate matches the major version `-4-` EXACTLY rather than `[4-9]` — a
// future Claude 5+ that either GA's the feature flag-free or uses a newer dated
// beta would otherwise be force-fed this 2025-05-14 string and hard-400 on
// every streaming tool turn (strictly worse than the safe non-match fallback,
// which is just the pre-existing buffering stall). Unlike the numeric ceiling
// tables (claudeMaxOutputTokens / claudeContextWindowTokens), which forward-
// match the MINOR within `-4-` because an over-classified ceiling degrades
// gracefully, this gate is binary accept/400 and must not forward-match the
// major. The slug may carry a Bedrock inference-profile prefix
// ("us.anthropic.claude-sonnet-4-6") or be a bare first-party id
// ("claude-sonnet-4-6"); both match because the pattern keys off the
// `claude-<tier>-4-` shape. Used by both the bedrock (Converse, via
// additionalModelRequestFields) and first-party anthropic (HTTP anthropic-beta
// header) send paths.
export function claudeSupportsFineGrainedToolStreaming(model: string): boolean {
  return /claude-(?:sonnet|haiku|opus)-4-/.test(normalizeModel(model));
}

export interface ModelPricing {
  /** USD per 1M input (prompt) tokens. */
  inputPerMillion: number;
  /** USD per 1M output (completion) tokens. */
  outputPerMillion: number;
}

// Per-model token pricing in USD per million tokens, used by estimateCost to
// fill CostRecord.estimatedUsd. This is a MAINTAINED list-price table — add a
// row (with a source in the PR) when a provider/model is added or a price
// changes. Matched against the normalized model id, so a Bedrock-prefixed id
// (`anthropic.claude-opus-4-8`) hits the same row as the first-party one. The
// first match wins, so order specific patterns before broad ones. An
// unrecognized model returns undefined and contributes 0 USD (tokens are still
// counted); local/echo/demo providers are intentionally unpriced.
//
// Anthropic values verified 2026-05 (input/output $ per MTok): Fable 5 10/50,
// Opus 4.5–4.8 5/25, Sonnet 4.6 3/15, Haiku 4.5 1/5. OpenAI/DeepSeek rows are
// public list prices and should be re-verified before relying on the USD
// figure for billing.
const MODEL_PRICING: Array<{ match: RegExp; input: number; output: number }> = [
  // Anthropic / Claude (first-party + Bedrock `anthropic.` prefix).
  { match: /(^|[.\-/])claude-fable-5(?=$|[-.])/, input: 10, output: 50 },
  { match: /(^|[.\-/])claude-opus-4-[5678](?=$|[-.])/, input: 5, output: 25 },
  { match: /(^|[.\-/])claude-opus-4-[01](?=$|[-.])/, input: 15, output: 75 },
  { match: /(^|[.\-/])claude-3-opus(?=$|[-.])/, input: 15, output: 75 },
  { match: /(^|[.\-/])claude-sonnet-4-[56](?=$|[-.])/, input: 3, output: 15 },
  { match: /(^|[.\-/])claude-haiku-4-5(?=$|[-.])/, input: 1, output: 5 },
  { match: /(^|[.\-/])claude-3-5-haiku(?=$|[-.])/, input: 0.8, output: 4 },
  // OpenAI / Codex (gpt-5.x served through the codex backend uses gpt-5 pricing).
  { match: /(^|[.\-/])gpt-5(\.\d+)?-?(mini|nano)(?=$|[-.])/, input: 0.25, output: 2 },
  { match: /(^|[.\-/])gpt-5(?=$|[-.\d])/, input: 1.25, output: 10 },
  { match: /(^|[.\-/])gpt-4o-mini(?=$|[-.])/, input: 0.15, output: 0.6 },
  { match: /(^|[.\-/])gpt-4o(?=$|[-.])/, input: 2.5, output: 10 },
  // DeepSeek.
  { match: /(^|[.\-/])deepseek-reasoner(?=$|[-.])/, input: 0.55, output: 2.19 },
  { match: /(^|[.\-/])deepseek(?=$|[-.])/, input: 0.27, output: 1.1 }
];

export function resolveModelPricing(provider: ProviderConfig): ModelPricing | undefined {
  const slug = normalizeModel(provider.model);
  if (slug.length === 0) return undefined;
  for (const row of MODEL_PRICING) {
    if (row.match.test(slug)) return { inputPerMillion: row.input, outputPerMillion: row.output };
  }
  return undefined;
}

/**
 * Estimate USD for a call given resolved input/output token counts. Returns
 * undefined when the model is unpriced (so estimatedUsd stays absent rather
 * than a misleading 0).
 */
export function estimateUsd(
  provider: ProviderConfig,
  inputTokens: number | undefined,
  outputTokens: number | undefined
): number | undefined {
  const pricing = resolveModelPricing(provider);
  if (!pricing) return undefined;
  const input = typeof inputTokens === "number" && Number.isFinite(inputTokens) ? inputTokens : 0;
  const output = typeof outputTokens === "number" && Number.isFinite(outputTokens) ? outputTokens : 0;
  return (input * pricing.inputPerMillion + output * pricing.outputPerMillion) / 1_000_000;
}

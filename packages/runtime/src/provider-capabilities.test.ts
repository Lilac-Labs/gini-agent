import { describe, expect, test } from "bun:test";
import {
  bedrockSupportsStreamingWithTools,
  bedrockSupportsToolUse,
  claudeSupportsFineGrainedToolStreaming,
  estimateUsd,
  FALLBACK_CONTEXT_WINDOW_TOKENS,
  FALLBACK_MAX_OUTPUT_TOKENS,
  resolveDefaultPriorContextTokenBudget,
  resolveImageByteLimit,
  resolveMaxOutputTokens,
  resolveModelPricing,
  resolveProviderContextWindowTokens,
  resolveProviderModality
} from "./provider-capabilities";
import type { ProviderConfig } from "./types";

function provider(name: ProviderConfig["name"], model: string): ProviderConfig {
  return { name, model };
}

describe("resolveModelPricing", () => {
  test("routes representative model ids to the right per-million rates", () => {
    expect(resolveModelPricing(provider("anthropic", "claude-opus-4-8"))).toEqual({ inputPerMillion: 5, outputPerMillion: 25 });
    expect(resolveModelPricing(provider("anthropic", "claude-fable-5"))).toEqual({ inputPerMillion: 10, outputPerMillion: 50 });
    // Bedrock-prefixed ids resolve to the same first-party row.
    expect(resolveModelPricing(provider("bedrock", "us.anthropic.claude-sonnet-4-6"))).toEqual({ inputPerMillion: 3, outputPerMillion: 15 });
    expect(resolveModelPricing(provider("anthropic", "claude-haiku-4-5"))).toEqual({ inputPerMillion: 1, outputPerMillion: 5 });
  });

  test("orders specific patterns before broad ones", () => {
    // gpt-5 mini/nano must win over the broad gpt-5 row.
    expect(resolveModelPricing(provider("openai", "gpt-5.4-mini"))).toEqual({ inputPerMillion: 0.25, outputPerMillion: 2 });
    expect(resolveModelPricing(provider("codex", "gpt-5.5"))).toEqual({ inputPerMillion: 1.25, outputPerMillion: 10 });
    // deepseek-reasoner must win over the broad deepseek row.
    expect(resolveModelPricing(provider("openrouter", "deepseek-reasoner"))).toEqual({ inputPerMillion: 0.55, outputPerMillion: 2.19 });
    expect(resolveModelPricing(provider("openrouter", "deepseek-v4-flash"))).toEqual({ inputPerMillion: 0.27, outputPerMillion: 1.1 });
  });

  test("returns undefined for an unpriced or empty model", () => {
    expect(resolveModelPricing(provider("local", "some-unknown-model"))).toBeUndefined();
    expect(resolveModelPricing(provider("echo", ""))).toBeUndefined();
  });
});

describe("estimateUsd", () => {
  test("computes USD from input/output token counts at the model's rates", () => {
    // opus 4.8 = $5/$25 per MTok → 100 in + 20 out = $0.0005 + $0.0005 = $0.001.
    expect(estimateUsd(provider("anthropic", "claude-opus-4-8"), 100, 20)).toBeCloseTo(0.001, 9);
  });

  test("returns undefined (not 0) for an unpriced model so the figure stays absent", () => {
    expect(estimateUsd(provider("local", "unknown"), 1000, 1000)).toBeUndefined();
  });

  test("treats missing or non-finite token counts as zero", () => {
    expect(estimateUsd(provider("anthropic", "claude-opus-4-8"), undefined, undefined)).toBe(0);
    expect(estimateUsd(provider("anthropic", "claude-opus-4-8"), Number.NaN, 20)).toBeCloseTo(0.0005, 9);
  });
});

describe("resolveProviderModality", () => {
  test("known openai families support vision and native docs", () => {
    expect(resolveProviderModality(provider("openai", "gpt-5.5"))).toEqual({ vision: true, nativeDocs: true });
    expect(resolveProviderModality(provider("openai", "gpt-4o"))).toEqual({ vision: true, nativeDocs: true });
    expect(resolveProviderModality(provider("openai", "gpt-4.1-mini"))).toEqual({ vision: true, nativeDocs: true });
    expect(resolveProviderModality(provider("openai", "o4-mini"))).toEqual({ vision: true, nativeDocs: true });
    expect(resolveProviderModality(provider("openai", "ChatGPT-4o-latest"))).toEqual({ vision: true, nativeDocs: true });
  });

  test("unknown openai model ids fall back to conservative false", () => {
    // A custom OpenAI-compatible endpoint (or an unrecognized model) must not
    // be handed a document part it can't ingest.
    expect(resolveProviderModality(provider("openai", "llama-3-70b"))).toEqual({ vision: false, nativeDocs: false });
    expect(resolveProviderModality(provider("openai", "text-davinci-003"))).toEqual({ vision: false, nativeDocs: false });
    expect(resolveProviderModality(provider("openai", ""))).toEqual({ vision: false, nativeDocs: false });
    // Prefix collisions must NOT match a known family (no boundary → false).
    expect(resolveProviderModality(provider("openai", "gpt-5foo"))).toEqual({ vision: false, nativeDocs: false });
    expect(resolveProviderModality(provider("openai", "gpt-4oish"))).toEqual({ vision: false, nativeDocs: false });
    expect(resolveProviderModality(provider("openai", "o1derful"))).toEqual({ vision: false, nativeDocs: false });
  });

  test("openrouter supported families resolve to both true", () => {
    expect(resolveProviderModality(provider("openrouter", "anthropic/claude-3.7-sonnet")))
      .toEqual({ vision: true, nativeDocs: true });
    expect(resolveProviderModality(provider("openrouter", "google/gemini-2.5-pro")))
      .toEqual({ vision: true, nativeDocs: true });
    expect(resolveProviderModality(provider("openrouter", "openai/gpt-5.5")))
      .toEqual({ vision: true, nativeDocs: true });
  });

  test("openrouter is case-insensitive on the family prefix", () => {
    expect(resolveProviderModality(provider("openrouter", "Anthropic/Claude-3.7-Sonnet")))
      .toEqual({ vision: true, nativeDocs: true });
  });

  test("openrouter google family requires the gemini prefix, not just google/", () => {
    // google/gemma-* is text-only on OpenRouter; only google/gemini* is gated true.
    expect(resolveProviderModality(provider("openrouter", "google/gemma-3-27b")))
      .toEqual({ vision: false, nativeDocs: false });
    expect(resolveProviderModality(provider("openrouter", "google/gemini-1.5-flash")))
      .toEqual({ vision: true, nativeDocs: true });
  });

  test("openrouter unknown/other routed models fall back to conservative false", () => {
    expect(resolveProviderModality(provider("openrouter", "meta-llama/llama-3.3-70b-instruct")))
      .toEqual({ vision: false, nativeDocs: false });
    expect(resolveProviderModality(provider("openrouter", "deepseek/deepseek-chat")))
      .toEqual({ vision: false, nativeDocs: false });
    expect(resolveProviderModality(provider("openrouter", "")))
      .toEqual({ vision: false, nativeDocs: false });
  });

  test("deepseek is text-only", () => {
    expect(resolveProviderModality(provider("deepseek", "deepseek-chat")))
      .toEqual({ vision: false, nativeDocs: false });
    expect(resolveProviderModality(provider("deepseek", "deepseek-reasoner")))
      .toEqual({ vision: false, nativeDocs: false });
  });

  test("codex is natively multimodal (verified against the live backend)", () => {
    expect(resolveProviderModality(provider("codex", "gpt-5.5")))
      .toEqual({ vision: true, nativeDocs: true });
  });

  test("azure follows the openai model family for vision but never native docs", () => {
    // Azure's deployment-scoped chat/completions has no `file` content part, so
    // nativeDocs stays false even for a vision-capable family.
    expect(resolveProviderModality(provider("azure", "gpt-4o")))
      .toEqual({ vision: true, nativeDocs: false });
    expect(resolveProviderModality(provider("azure", "gpt-5.5")))
      .toEqual({ vision: true, nativeDocs: false });
    // An unknown/text-only Azure deployment stays conservatively false on both.
    expect(resolveProviderModality(provider("azure", "text-embedding-3-large")))
      .toEqual({ vision: false, nativeDocs: false });
  });

  test("local is conservatively unknown → false", () => {
    expect(resolveProviderModality(provider("local", "local/default")))
      .toEqual({ vision: false, nativeDocs: false });
  });

  test("echo has no modality", () => {
    expect(resolveProviderModality(provider("echo", "gini-echo-v0")))
      .toEqual({ vision: false, nativeDocs: false });
  });

  test("an unknown provider name resolves to the conservative default", () => {
    expect(resolveProviderModality({ name: "mystery" as ProviderConfig["name"], model: "x" }))
      .toEqual({ vision: false, nativeDocs: false });
  });

  test("bedrock: vision is per-model, nativeDocs always false (Converse sends no document blocks)", () => {
    // Multimodal families → vision true.
    for (const m of [
      "us.anthropic.claude-opus-4-8",
      "us.amazon.nova-pro-v1:0",
      "us.amazon.nova-lite-v1:0",
      "us.mistral.pixtral-large-2502-v1:0",
      "us.meta.llama4-maverick-17b-instruct-v1:0",
      "us.meta.llama3-2-11b-instruct-v1:0"
    ]) {
      expect(resolveProviderModality(provider("bedrock", m))).toEqual({ vision: true, nativeDocs: false });
    }
    // Text-only / unrecognized ids → vision false. nativeDocs is false either way.
    for (const m of ["us.deepseek.r1-v1:0", "us.meta.llama3-3-70b-instruct-v1:0", "us.amazon.nova-micro-v1:0", ""]) {
      expect(resolveProviderModality(provider("bedrock", m))).toEqual({ vision: false, nativeDocs: false });
    }
  });
});

describe("bedrockSupportsToolUse", () => {
  test("DeepSeek ids are gated off; every other catalog family stays on", () => {
    // DeepSeek R1 returns a ValidationException when sent a Converse toolConfig.
    expect(bedrockSupportsToolUse("us.deepseek.r1-v1:0")).toBe(false);
    expect(bedrockSupportsToolUse("DeepSeek-R1")).toBe(false);
    // Tool-capable families default to true (incl. unrecognized/custom ids).
    for (const m of [
      "us.anthropic.claude-opus-4-8",
      "us.amazon.nova-micro-v1:0",
      "us.meta.llama3-3-70b-instruct-v1:0",
      "us.mistral.mistral-large-2407-v1:0",
      "some.custom.future-model",
      ""
    ]) {
      expect(bedrockSupportsToolUse(m)).toBe(true);
    }
  });
});

describe("bedrockSupportsStreamingWithTools", () => {
  test("Llama 4 ids are gated off; every other family streams with tools", () => {
    // Llama 4 can't carry toolConfig on a streaming request ("tool use in
    // streaming mode"); callBedrockConverse drops to non-stream only when tools
    // are attached.
    expect(bedrockSupportsStreamingWithTools("us.meta.llama4-maverick-17b-instruct-v1:0")).toBe(false);
    expect(bedrockSupportsStreamingWithTools("us.meta.llama4-scout-17b-instruct-v1:0")).toBe(false);
    // Other families (incl. Llama 3.3, unrecognized/custom ids) support tools + streaming.
    for (const m of [
      "us.anthropic.claude-opus-4-8",
      "us.amazon.nova-lite-v1:0",
      "us.meta.llama3-3-70b-instruct-v1:0",
      "us.deepseek.r1-v1:0",
      "some.custom.future-model",
      ""
    ]) {
      expect(bedrockSupportsStreamingWithTools(m)).toBe(true);
    }
  });
});

describe("claudeSupportsFineGrainedToolStreaming", () => {
  test("Claude 4 family (bedrock-prefixed or bare first-party) accept the flag; 3.x, 5+, and non-Claude don't", () => {
    // Fine-grained tool streaming is documented for the Claude 4 family only,
    // on both the bedrock (prefixed) and first-party (bare) id shapes.
    for (const m of [
      "us.anthropic.claude-sonnet-4-6",
      "us.anthropic.claude-opus-4-8",
      "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
      "anthropic.claude-sonnet-4-20250514-v1:0",
      "claude-opus-4-8",
      "claude-sonnet-4-12",
      "claude-sonnet-4-5-20250929"
    ]) {
      expect(claudeSupportsFineGrainedToolStreaming(m)).toBe(true);
    }
    // Claude 3.x/3.5 are NOT in the supported list — sending the beta to them
    // risks a 400, so the gate must exclude them even though they're Claude.
    for (const m of [
      "us.anthropic.claude-3-5-sonnet-20241022-v1:0",
      "us.anthropic.claude-3-opus-20240229-v1:0",
      "us.anthropic.claude-3-haiku-20240307-v1:0",
      "claude-3-5-sonnet-20241022"
    ]) {
      expect(claudeSupportsFineGrainedToolStreaming(m)).toBe(false);
    }
    // Future MAJORS (Claude 5+, 10+) must NOT match: the beta flag we send is
    // date-stamped (…-2025-05-14), so force-feeding it to a future major that
    // GA's the feature or uses a newer beta would hard-400 every streaming tool
    // turn — worse than the safe non-match fallback. The gate pins major 4.
    for (const m of [
      "claude-sonnet-5-0",
      "claude-opus-5-1",
      "us.anthropic.claude-sonnet-5-0-20260101-v1:0",
      "claude-sonnet-10-0"
    ]) {
      expect(claudeSupportsFineGrainedToolStreaming(m)).toBe(false);
    }
    // Non-Claude families don't support the beta flag, and an empty/unknown id
    // stays off.
    for (const m of [
      "us.amazon.nova-pro-v1:0",
      "us.meta.llama4-scout-17b-instruct-v1:0",
      "us.deepseek.r1-v1:0",
      "us.mistral.mistral-large-2407-v1:0",
      "some.custom.future-model",
      ""
    ]) {
      expect(claudeSupportsFineGrainedToolStreaming(m)).toBe(false);
    }
  });
});

describe("resolveProviderContextWindowTokens", () => {
  test("openai known model families resolve to their context windows", () => {
    expect(resolveProviderContextWindowTokens(provider("openai", "gpt-5.5"))).toBe(1_000_000);
    expect(resolveProviderContextWindowTokens(provider("openai", "gpt-5.4"))).toBe(1_050_000);
    expect(resolveProviderContextWindowTokens(provider("openai", "gpt-5.4-mini"))).toBe(400_000);
    expect(resolveProviderContextWindowTokens(provider("openai", "gpt-5.3-codex-spark"))).toBe(400_000);
    expect(resolveProviderContextWindowTokens(provider("openai", "gpt-5.2-chat-latest"))).toBe(128_000);
    expect(resolveProviderContextWindowTokens(provider("openai", "gpt-4.1-mini"))).toBe(1_047_576);
    expect(resolveProviderContextWindowTokens(provider("openai", "o4-mini"))).toBe(200_000);
  });

  test("codex caps at the backend context window even when the model's nominal window is larger", () => {
    // gpt-5.5 is 1M on the direct OpenAI API but only 275k through the Codex
    // backend; openai must stay unchanged at the model's nominal window.
    expect(resolveProviderContextWindowTokens(provider("codex", "gpt-5.5"))).toBe(275_000);
    expect(resolveProviderContextWindowTokens(provider("openai", "gpt-5.5"))).toBe(1_000_000);
  });

  test("azure resolves context windows by the underlying openai model family", () => {
    expect(resolveProviderContextWindowTokens(provider("azure", "gpt-5.5"))).toBe(1_000_000);
    expect(resolveProviderContextWindowTokens(provider("azure", "gpt-4.1-mini"))).toBe(1_047_576);
    expect(resolveProviderContextWindowTokens(provider("azure", "o4-mini"))).toBe(200_000);
  });

  test("deepseek v4 models and compatibility aliases resolve to one million tokens", () => {
    expect(resolveProviderContextWindowTokens(provider("deepseek", "deepseek-v4-flash"))).toBe(1_000_000);
    expect(resolveProviderContextWindowTokens(provider("deepseek", "deepseek-v4-pro"))).toBe(1_000_000);
    expect(resolveProviderContextWindowTokens(provider("deepseek", "deepseek-chat"))).toBe(1_000_000);
    expect(resolveProviderContextWindowTokens(provider("deepseek", "deepseek-reasoner"))).toBe(1_000_000);
  });

  test("openrouter routed slugs reuse known upstream windows where possible", () => {
    expect(resolveProviderContextWindowTokens(provider("openrouter", "openai/gpt-5.4-mini"))).toBe(400_000);
    expect(resolveProviderContextWindowTokens(provider("openrouter", "deepseek/deepseek-v4-flash"))).toBe(1_000_000);
    expect(resolveProviderContextWindowTokens(provider("openrouter", "anthropic/claude-4-sonnet"))).toBe(200_000);
    expect(resolveProviderContextWindowTokens(provider("openrouter", "google/gemini-2.5-pro"))).toBe(1_000_000);
  });

  test("anthropic + bedrock map to real per-model windows, not the 32K fallback", () => {
    // 1M-context Claude families: Opus 4.6+, Sonnet 4.6, Fable 5 — on first-party
    // and on Bedrock inference profiles alike.
    expect(resolveProviderContextWindowTokens(provider("anthropic", "claude-opus-4-8"))).toBe(1_000_000);
    expect(resolveProviderContextWindowTokens(provider("anthropic", "claude-sonnet-4-6"))).toBe(1_000_000);
    expect(resolveProviderContextWindowTokens(provider("anthropic", "claude-fable-5"))).toBe(1_000_000);
    expect(resolveProviderContextWindowTokens(provider("bedrock", "us.anthropic.claude-opus-4-8"))).toBe(1_000_000);
    expect(resolveProviderContextWindowTokens(provider("openrouter", "anthropic/claude-opus-4-8"))).toBe(1_000_000);
    // Haiku 4.5 and older Opus/Sonnet point releases keep the 200K window.
    expect(resolveProviderContextWindowTokens(provider("anthropic", "claude-haiku-4-5"))).toBe(200_000);
    expect(resolveProviderContextWindowTokens(provider("anthropic", "claude-opus-4-5"))).toBe(200_000);
    expect(resolveProviderContextWindowTokens(provider("bedrock", "us.anthropic.claude-haiku-4-5"))).toBe(200_000);
    // A date-stamped major-only 4.0 id must NOT have its date digits ("20")
    // misread as a 4.x minor version and jump to the 1M window — it stays 200K.
    expect(resolveProviderContextWindowTokens(provider("anthropic", "claude-sonnet-4-20250514"))).toBe(200_000);
    expect(resolveProviderContextWindowTokens(provider("bedrock", "us.anthropic.claude-opus-4-20250514-v1:0"))).toBe(200_000);
    expect(resolveProviderContextWindowTokens(provider("bedrock", "us.amazon.nova-premier-v1:0"))).toBe(1_000_000);
    expect(resolveProviderContextWindowTokens(provider("bedrock", "us.amazon.nova-pro-v1:0"))).toBe(300_000);
    expect(resolveProviderContextWindowTokens(provider("bedrock", "eu.amazon.nova-lite-v1:0"))).toBe(300_000);
    expect(resolveProviderContextWindowTokens(provider("bedrock", "us.amazon.nova-micro-v1:0"))).toBe(128_000);
    // Unrecognized families on each provider stay conservative.
    expect(resolveProviderContextWindowTokens(provider("anthropic", "mystery-model"))).toBe(FALLBACK_CONTEXT_WINDOW_TOKENS);
    expect(resolveProviderContextWindowTokens(provider("bedrock", "us.meta.llama3-3-70b-instruct-v1:0"))).toBe(FALLBACK_CONTEXT_WINDOW_TOKENS);
  });

  test("unknown, local, echo, and openrouter auto fall back conservatively", () => {
    expect(resolveProviderContextWindowTokens(provider("openai", "llama-3-70b"))).toBe(FALLBACK_CONTEXT_WINDOW_TOKENS);
    // An unrecognized deepseek model id hits the deepseek context-window fallback.
    expect(resolveProviderContextWindowTokens(provider("deepseek", "deepseek-legacy-v0"))).toBe(FALLBACK_CONTEXT_WINDOW_TOKENS);
    expect(resolveProviderContextWindowTokens(provider("local", "local/default"))).toBe(FALLBACK_CONTEXT_WINDOW_TOKENS);
    expect(resolveProviderContextWindowTokens(provider("echo", "gini-echo-v0"))).toBe(FALLBACK_CONTEXT_WINDOW_TOKENS);
    expect(resolveProviderContextWindowTokens(provider("openrouter", "openrouter/auto"))).toBe(FALLBACK_CONTEXT_WINDOW_TOKENS);
    expect(resolveProviderContextWindowTokens({ name: "mystery" as ProviderConfig["name"], model: "x" }))
      .toBe(FALLBACK_CONTEXT_WINDOW_TOKENS);
  });
});

describe("resolveMaxOutputTokens", () => {
  test("Claude 4.6+ Opus/Sonnet and Fable resolve to the 128K ceiling (anthropic + bedrock)", () => {
    expect(resolveMaxOutputTokens(provider("anthropic", "claude-opus-4-8"))).toBe(128_000);
    expect(resolveMaxOutputTokens(provider("anthropic", "claude-sonnet-4-6"))).toBe(128_000);
    expect(resolveMaxOutputTokens(provider("anthropic", "claude-fable-5"))).toBe(128_000);
    expect(resolveMaxOutputTokens(provider("bedrock", "us.anthropic.claude-opus-4-8"))).toBe(128_000);
    expect(resolveMaxOutputTokens(provider("bedrock", "us.anthropic.claude-sonnet-4-6"))).toBe(128_000);
    // A future point release (4.9, 4.10) stays on the 128K tier.
    expect(resolveMaxOutputTokens(provider("anthropic", "claude-opus-4-9"))).toBe(128_000);
    expect(resolveMaxOutputTokens(provider("anthropic", "claude-sonnet-4-12"))).toBe(128_000);
  });

  test("Haiku 4.5 and the 4.5 Opus/Sonnet tier resolve to 64K", () => {
    expect(resolveMaxOutputTokens(provider("anthropic", "claude-haiku-4-5"))).toBe(64_000);
    expect(resolveMaxOutputTokens(provider("anthropic", "claude-opus-4-5"))).toBe(64_000);
    expect(resolveMaxOutputTokens(provider("anthropic", "claude-sonnet-4-5"))).toBe(64_000);
    expect(resolveMaxOutputTokens(provider("bedrock", "us.anthropic.claude-haiku-4-5-20251001-v1:0"))).toBe(64_000);
    expect(resolveMaxOutputTokens(provider("bedrock", "us.anthropic.claude-sonnet-4-5-20250929-v1:0"))).toBe(64_000);
  });

  test("Opus 4.1 resolves to 32K", () => {
    expect(resolveMaxOutputTokens(provider("anthropic", "claude-opus-4-1"))).toBe(32_000);
    expect(resolveMaxOutputTokens(provider("bedrock", "us.anthropic.claude-opus-4-1-20250805-v1:0"))).toBe(32_000);
  });

  test("date-stamped 4.0 ids resolve to their real ceiling, not a date-digit overmatch", () => {
    // Regression: a major-only 4.0 id carries a date stamp right after the major
    // ("claude-sonnet-4-20250514"). A `4-(?:[6-9]|\d\d)` minor class without a
    // trailing-digit anchor reads the date's "20" as a minor version and wrongly
    // returns 128K, so a streaming turn would send max_tokens=128000 against the
    // model's real 64K (Sonnet 4.0) / 32K (Opus 4.0) ceiling and 400. Pin the
    // documented ceilings (verified via the Anthropic Models API + provider docs).
    expect(resolveMaxOutputTokens(provider("anthropic", "claude-sonnet-4-20250514"))).toBe(64_000);
    expect(resolveMaxOutputTokens(provider("bedrock", "us.anthropic.claude-sonnet-4-20250514-v1:0"))).toBe(64_000);
    expect(resolveMaxOutputTokens(provider("anthropic", "claude-opus-4-20250514"))).toBe(32_000);
    expect(resolveMaxOutputTokens(provider("bedrock", "us.anthropic.claude-opus-4-20250514-v1:0"))).toBe(32_000);
    // The minor-version boundary is a whole segment (end / `-` / `.`), so a
    // letter-glued suffix can't be misread as a 4.6+ minor either — it falls to
    // the floor rather than the 128K tier. Real ids never glue letters onto the
    // minor, but the boundary is segment-anchored so it can't.
    expect(resolveMaxOutputTokens(provider("anthropic", "claude-sonnet-4-6preview"))).toBe(FALLBACK_MAX_OUTPUT_TOKENS);
    // A dated 4.6 (minor delimited by `-`) still resolves to its 128K tier.
    expect(resolveMaxOutputTokens(provider("bedrock", "us.anthropic.claude-sonnet-4-6-20260101-v1:0"))).toBe(128_000);
  });

  test("non-Claude Bedrock families carry their own probed ceilings", () => {
    expect(resolveMaxOutputTokens(provider("bedrock", "us.amazon.nova-premier-v1:0"))).toBe(32_000);
    expect(resolveMaxOutputTokens(provider("bedrock", "us.amazon.nova-pro-v1:0"))).toBe(10_000);
    expect(resolveMaxOutputTokens(provider("bedrock", "eu.amazon.nova-lite-v1:0"))).toBe(10_000);
    expect(resolveMaxOutputTokens(provider("bedrock", "us.amazon.nova-micro-v1:0"))).toBe(10_000);
    expect(resolveMaxOutputTokens(provider("bedrock", "us.deepseek.r1-v1:0"))).toBe(32_768);
    expect(resolveMaxOutputTokens(provider("bedrock", "us.meta.llama4-scout-17b-instruct-v1:0"))).toBe(8_192);
    expect(resolveMaxOutputTokens(provider("bedrock", "us.meta.llama4-maverick-17b-instruct-v1:0"))).toBe(8_192);
  });

  test("unrecognized Claude, unrecognized Bedrock family, and non-Anthropic providers fall back to the floor", () => {
    // Legacy/EOL/unrecognized Claude ids on both providers.
    expect(resolveMaxOutputTokens(provider("anthropic", "claude-3-5-sonnet-20241022"))).toBe(FALLBACK_MAX_OUTPUT_TOKENS);
    expect(resolveMaxOutputTokens(provider("anthropic", "mystery-model"))).toBe(FALLBACK_MAX_OUTPUT_TOKENS);
    expect(resolveMaxOutputTokens(provider("bedrock", "us.meta.llama3-3-70b-instruct-v1:0"))).toBe(FALLBACK_MAX_OUTPUT_TOKENS);
    // The chat-completions providers send no max_tokens default at all, so they
    // get the floor here (their send-path never applies it).
    expect(resolveMaxOutputTokens(provider("openai", "gpt-5.5"))).toBe(FALLBACK_MAX_OUTPUT_TOKENS);
    expect(resolveMaxOutputTokens(provider("azure", "gpt-5.5"))).toBe(FALLBACK_MAX_OUTPUT_TOKENS);
    expect(resolveMaxOutputTokens(provider("openrouter", "anthropic/claude-opus-4-8"))).toBe(FALLBACK_MAX_OUTPUT_TOKENS);
    expect(resolveMaxOutputTokens(provider("deepseek", "deepseek-chat"))).toBe(FALLBACK_MAX_OUTPUT_TOKENS);
    expect(resolveMaxOutputTokens(provider("local", "local/default"))).toBe(FALLBACK_MAX_OUTPUT_TOKENS);
    expect(resolveMaxOutputTokens(provider("codex", "gpt-5.5"))).toBe(FALLBACK_MAX_OUTPUT_TOKENS);
    expect(resolveMaxOutputTokens(provider("echo", "gini-echo-v0"))).toBe(FALLBACK_MAX_OUTPUT_TOKENS);
    expect(resolveMaxOutputTokens({ name: "mystery" as ProviderConfig["name"], model: "x" })).toBe(FALLBACK_MAX_OUTPUT_TOKENS);
  });

  test("a missing model id falls back to the floor without throwing", () => {
    expect(resolveMaxOutputTokens({ name: "anthropic" } as ProviderConfig)).toBe(FALLBACK_MAX_OUTPUT_TOKENS);
    expect(resolveMaxOutputTokens({ name: "bedrock" } as ProviderConfig)).toBe(FALLBACK_MAX_OUTPUT_TOKENS);
  });
});

describe("resolveImageByteLimit", () => {
  test("raw budget stays under the provider base64 cap once encoded", () => {
    // Anthropic/Bedrock cap the base64-encoded `image.source.base64` payload at
    // 5,242,880, not the raw bytes. base64 length = 4 * ceil(n / 3), so a raw
    // limit must satisfy that the encoded form is <= the cap.
    const limit = resolveImageByteLimit(provider("bedrock", "us.anthropic.claude-opus-4-8"));
    expect(limit).toBeGreaterThan(0);
    const encodedLength = 4 * Math.ceil(limit / 3);
    expect(encodedLength).toBeLessThanOrEqual(5_242_880);
  });
});

describe("resolveDefaultPriorContextTokenBudget", () => {
  test("defaults to sixty-five percent of the provider context window", () => {
    // codex gpt-5.5 budgets against the 275k backend cap, not the 1M nominal window.
    expect(resolveDefaultPriorContextTokenBudget(provider("codex", "gpt-5.5"))).toBe(178_750);
    expect(resolveDefaultPriorContextTokenBudget(provider("openai", "gpt-5.5"))).toBe(650_000);
    expect(resolveDefaultPriorContextTokenBudget(provider("openai", "gpt-5.4-mini"))).toBe(260_000);
    expect(resolveDefaultPriorContextTokenBudget(provider("openai", "gpt-4.1-mini"))).toBe(680_924);
    expect(resolveDefaultPriorContextTokenBudget(provider("echo", "gini-echo-v0"))).toBe(20_800);
  });
});

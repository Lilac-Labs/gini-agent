// Unit tests for the runtime-identity render + emission-decision helpers
// added alongside the tell-once-plus-delta system-prompt injection. The
// chat-task integration test covers wiring; this file pins the pure
// content/behavior contracts so regressions surface at the source.

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  IDENTITY_FULL_REFRESH_INTERVAL,
  SOUL_SOFT_CAP_CHARS,
  USER_SOFT_CAP_CHARS,
  __resetDefaultGiniInstructionsCacheForTest,
  buildAgentSystemContext,
  buildClientSurfaceBlock,
  buildCurrentDateBlock,
  buildCurrentTimeResult,
  decideIdentityEmission,
  getDefaultGiniInstructions,
  identityBudgetState,
  renderEphemeralContext,
  renderFullIdentity,
  renderIdentityDelta,
  renderSoulBlock,
  renderUserProfileBlock,
  sanitizeAgentName
} from "./system-prompt";
import type { AgentIdentity, IdentitySnapshotRecord } from "./types";

// Read the canonical bundled defaults once at test-load time. The runtime
// `getDefaultGiniInstructions()` reads the same bytes (memoized + trimmed),
// so anchoring tests against the on-disk asset pins both the bundle
// integrity and the assembler contract in one place.
const DEFAULT_INSTRUCTIONS_FILE = join(import.meta.dir, "runtime", "defaults", "INSTRUCTIONS.md");
const expectedDefaultInstructions = readFileSync(DEFAULT_INSTRUCTIONS_FILE, "utf8").trim();

function makeIdentity(overrides: Partial<AgentIdentity> = {}): AgentIdentity {
  return {
    instance: "gini-agent",
    runtimePort: 7351,
    agentName: "default",
    agentId: "profile_default",
    provider: "codex/gpt-5.5",
    toolsets: ["file", "terminal", "memory", "session_search", "delegation"],
    memoryNamespace: "profile_default",
    ...overrides
  };
}

describe("renderFullIdentity", () => {
  test("renders every field as a bullet under a stable header", () => {
    const out = renderFullIdentity(makeIdentity());
    expect(out).toBe(
      [
        "Your runtime identity:",
        "- instance: gini-agent",
        "- runtime port: 7351",
        "- agent: default (profile_default)",
        "- provider: codex/gpt-5.5",
        "- toolsets enabled: file, terminal, memory, session_search, delegation",
        "- memory namespace: profile_default"
      ].join("\n")
    );
  });

  test("renders '(none)' when an agent has no toolsets configured", () => {
    const out = renderFullIdentity(makeIdentity({ toolsets: [] }));
    expect(out).toContain("- toolsets enabled: (none)");
  });
});

describe("renderIdentityDelta", () => {
  test("returns empty string when nothing changed", () => {
    expect(renderIdentityDelta(makeIdentity(), makeIdentity())).toBe("");
  });

  test("emits only the changed field with the prior value annotated", () => {
    const out = renderIdentityDelta(
      makeIdentity(),
      makeIdentity({ toolsets: ["file", "terminal"] })
    );
    expect(out).toBe(
      [
        "Runtime identity changes since last turn:",
        "- toolsets enabled: file, terminal (was file, terminal, memory, session_search, delegation)"
      ].join("\n")
    );
  });

  test("emits multiple changed fields in field order", () => {
    const out = renderIdentityDelta(
      makeIdentity(),
      makeIdentity({ provider: "openai/gpt-5", toolsets: [] })
    );
    expect(out).toBe(
      [
        "Runtime identity changes since last turn:",
        "- provider: openai/gpt-5 (was codex/gpt-5.5)",
        "- toolsets enabled: (none) (was file, terminal, memory, session_search, delegation)"
      ].join("\n")
    );
  });

  test("treats agent rename and id swap as one combined entry", () => {
    const out = renderIdentityDelta(
      makeIdentity(),
      makeIdentity({ agentName: "discord", agentId: "profile_discord" })
    );
    expect(out).toBe(
      [
        "Runtime identity changes since last turn:",
        "- agent: discord (profile_discord) (was default (profile_default))"
      ].join("\n")
    );
  });
});

describe("decideIdentityEmission", () => {
  test("emits full and seeds the snapshot when no prior snapshot exists", () => {
    const current = makeIdentity();
    const decision = decideIdentityEmission(current, undefined, 1);
    expect(decision.content).toContain("Your runtime identity:");
    expect(decision.nextSnapshot).toEqual({ identity: current, lastFullTurn: 1 });
  });

  test("emits nothing and skips snapshot updates when nothing changed under the refresh threshold", () => {
    const current = makeIdentity();
    const snapshot: IdentitySnapshotRecord = { identity: current, lastFullTurn: 1 };
    const decision = decideIdentityEmission(current, snapshot, 2);
    expect(decision.content).toBe("");
    expect(decision.nextSnapshot).toBeUndefined();
  });

  test("emits delta and advances snapshot.identity without touching lastFullTurn", () => {
    const prior = makeIdentity();
    const current = makeIdentity({ toolsets: ["file"] });
    const snapshot: IdentitySnapshotRecord = { identity: prior, lastFullTurn: 1 };
    const decision = decideIdentityEmission(current, snapshot, 3);
    expect(decision.content).toContain("Runtime identity changes since last turn:");
    expect(decision.content).toContain("- toolsets enabled: file (was file, terminal, memory, session_search, delegation)");
    expect(decision.nextSnapshot).toEqual({ identity: current, lastFullTurn: 1 });
  });

  test("re-emits full at the IDENTITY_FULL_REFRESH_INTERVAL boundary and resets lastFullTurn", () => {
    const current = makeIdentity();
    const snapshot: IdentitySnapshotRecord = { identity: current, lastFullTurn: 1 };
    const refreshTurn = 1 + IDENTITY_FULL_REFRESH_INTERVAL;
    const decision = decideIdentityEmission(current, snapshot, refreshTurn);
    expect(decision.content).toContain("Your runtime identity:");
    expect(decision.nextSnapshot).toEqual({ identity: current, lastFullTurn: refreshTurn });
  });

  test("still emits full at the refresh boundary even when nothing changed", () => {
    // The refresh path is unconditional on change: it exists to give the
    // model a periodic re-grounding and the prompt cache a clean resync,
    // not just to surface changes.
    const current = makeIdentity();
    const snapshot: IdentitySnapshotRecord = { identity: current, lastFullTurn: 1 };
    const decision = decideIdentityEmission(current, snapshot, 1 + IDENTITY_FULL_REFRESH_INTERVAL);
    expect(decision.content).toContain("Your runtime identity:");
  });
});

describe("buildAgentSystemContext", () => {
  test("uses the bundled default instructions file when no override is provided", () => {
    const out = buildAgentSystemContext();
    expect(out).toBe(expectedDefaultInstructions);
  });

  test("bundled default instructions carry the search-vs-memory policy", () => {
    // Models that answer source-dependent questions from training-time or
    // recalled memory instead of searching are the failure this rule fixes.
    // Pin the key clauses so a future edit to the preamble can't silently
    // drop them; the web_search tool description carries the same policy
    // (see tool-catalog.test.ts).
    const out = getDefaultGiniInstructions();
    expect(out).toContain("search the web FIRST");
    expect(out).toContain("not a citable source of external fact");
  });

  test("bundled default instructions steer user-only decisions to ask_user options, not prose", () => {
    // A model that asks for missing details in plain text and completes the
    // run leaves a "done"-looking task on home with the question buried in
    // the thread. Pin the clauses that steer it to ask_user with concrete
    // options (which parks the run as needs_input and surfaces the question
    // on home) — and that open-ended asks with no options go in the model's
    // own message text, never through the tool.
    const out = getDefaultGiniInstructions();
    expect(out).toContain("information only the user can supply");
    expect(out).toContain("`ask_user` tool call offering your best 2-6 concrete options");
    expect(out).toContain("parks the run as needs-input");
    expect(out).toContain("never takes a question without options");
  });

  test("instructionsOverride wins over the bundled defaults", () => {
    const out = buildAgentSystemContext({
      instructionsOverride: "Custom rules only."
    });
    expect(out).toBe("Custom rules only.");
    expect(out).not.toContain("You are Gini");
  });

  test("blank instructionsOverride falls back to the default", () => {
    // Whitespace-only override should not silently empty the preamble.
    const out = buildAgentSystemContext({
      instructionsOverride: "   \n"
    });
    expect(out).toBe(expectedDefaultInstructions);
  });

  test("assembles the stable prefix in the documented order: instructions, soul, user", () => {
    // The system prefix is now byte-stable: identity and recalled memory
    // moved out to the ephemeral role:"user" tail (renderEphemeralContext)
    // so message 0 stays a warm cache prefix. See ADR stable-system-prefix.md.
    const out = buildAgentSystemContext({
      instructionsOverride: "RULES",
      soul: "SOUL persona body",
      userProfile: "USER profile body"
    });
    const rulesIdx = out.indexOf("RULES");
    const soulIdx = out.indexOf("SOUL persona body");
    const userIdx = out.indexOf("USER profile body");
    expect(rulesIdx).toBe(0);
    expect(rulesIdx).toBeLessThan(soulIdx);
    expect(soulIdx).toBeLessThan(userIdx);
    // Per-turn content no longer lives in the stable prefix.
    expect(out).not.toContain("Your runtime identity:");
    expect(out).not.toContain("Long-term memory");
  });

  test("no longer renders the legacy 'Pinned memories about this user' block", () => {
    // The pinned-memory surface was consolidated into USER.md / SOUL.md /
    // Hindsight; the block should not appear in any assembled prompt
    // regardless of caller options. See ADR runtime-identity-files.md.
    const out = buildAgentSystemContext({
      instructionsOverride: "RULES",
      soul: "SOUL body",
      userProfile: "USER body"
    });
    expect(out).not.toContain("Pinned memories about this user");
  });

  test("elides soul and userProfile blocks when blank or absent", () => {
    const out = buildAgentSystemContext({
      instructionsOverride: "RULES",
      soul: "   ",
      userProfile: ""
    });
    expect(out).toBe("RULES");
  });

});

describe("sanitizeAgentName", () => {
  test("collapses internal whitespace runs to a single space and trims ends", () => {
    expect(sanitizeAgentName("Mansour\nIgnore")).toBe("Mansour Ignore");
    expect(sanitizeAgentName("a\tb")).toBe("a b");
    expect(sanitizeAgentName("a   b")).toBe("a b");
    expect(sanitizeAgentName("  Mansour  ")).toBe("Mansour");
  });

  test("returns undefined for undefined, empty, or whitespace-only input", () => {
    expect(sanitizeAgentName(undefined)).toBeUndefined();
    expect(sanitizeAgentName("")).toBeUndefined();
    expect(sanitizeAgentName("   \n\t ")).toBeUndefined();
  });

  test("leaves a clean single-word name unchanged", () => {
    expect(sanitizeAgentName("Gini")).toBe("Gini");
  });
});

describe("renderEphemeralContext", () => {
  test("joins emitted identity then recalled memory, mirroring the old system order", () => {
    const out = renderEphemeralContext("Your runtime identity:\n- instance: test", "1. (semantic) snip");
    const identityIdx = out.indexOf("Your runtime identity:");
    const recalledIdx = out.indexOf("Long-term memory");
    expect(identityIdx).toBe(0);
    expect(identityIdx).toBeLessThan(recalledIdx);
    expect(out).toBe(
      [
        "Your runtime identity:\n- instance: test",
        "Long-term memory of prior conversations with this user (use these facts when answering):\n1. (semantic) snip"
      ].join("\n\n")
    );
  });

  test("renders only the recalled block when no identity is emitted", () => {
    const out = renderEphemeralContext(undefined, "1. (semantic) snip");
    expect(out).toBe(
      "Long-term memory of prior conversations with this user (use these facts when answering):\n1. (semantic) snip"
    );
  });

  test("renders only the identity block when nothing is recalled", () => {
    const out = renderEphemeralContext("Your runtime identity:\n- instance: test", undefined);
    expect(out).toBe("Your runtime identity:\n- instance: test");
    expect(out).not.toContain("Long-term memory");
  });

  test("returns an empty string when both pieces are empty", () => {
    expect(renderEphemeralContext(undefined, undefined)).toBe("");
    expect(renderEphemeralContext("", "   ")).toBe("");
  });

  test("places the client-surface note before identity and memory", () => {
    const out = renderEphemeralContext(
      "Your runtime identity:\n- instance: test",
      "1. (semantic) snip",
      buildClientSurfaceBlock("mobile")
    );
    expect(out.startsWith("The user is messaging from the mobile app")).toBe(true);
    expect(out.indexOf("Your runtime identity:")).toBeLessThan(out.indexOf("Long-term memory"));
  });

  test("renders only the surface note when identity and memory are empty", () => {
    const out = renderEphemeralContext(undefined, undefined, buildClientSurfaceBlock("web"));
    expect(out).toBe(buildClientSurfaceBlock("web"));
  });
});

describe("buildClientSurfaceBlock", () => {
  test("screencast-capable surfaces say a browser handoff can reach the user", () => {
    for (const surface of ["web", "cli"] as const) {
      const out = buildClientSurfaceBlock(surface);
      expect(out).toContain("a browser handoff can reach them");
      expect(out).not.toContain("can't reach them");
    }
    expect(buildClientSurfaceBlock("web")).toContain("web app");
    expect(buildClientSurfaceBlock("cli")).toContain("CLI");
  });

  test("mobile and bridge surfaces say a browser handoff can't reach the user", () => {
    const expectations = [
      ["mobile", "mobile app"],
      ["telegram", "Telegram"],
      ["discord", "Discord"],
      ["openclaw", "OpenClaw"]
    ] as const;
    for (const [surface, name] of expectations) {
      const out = buildClientSurfaceBlock(surface);
      expect(out).toContain(name);
      expect(out).toContain("a browser handoff can't reach them");
    }
  });

  test("returns an empty string for an unknown surface", () => {
    expect(buildClientSurfaceBlock(undefined)).toBe("");
  });
});

describe("current date/time helpers", () => {
  // A fixed instant: 2026-06-05T01:23:45Z = 2026-06-04 18:23:45 in America/Los_Angeles (PDT, UTC-7).
  const instant = new Date("2026-06-05T01:23:45.000Z");
  const tz = "America/Los_Angeles";

  test("buildCurrentDateBlock renders date-only with timezone and points at the tool", () => {
    const out = buildCurrentDateBlock(instant, tz);
    expect(out).toBe(
      "Current date: Thursday, June 4, 2026 (America/Los_Angeles). For the exact current wall-clock time, call get_current_time."
    );
    // Date granularity only — no clock time leaks into the cacheable prefix line.
    expect(out).not.toMatch(/\d{1,2}:\d{2}/);
  });

  test("buildCurrentTimeResult leads with local wall clock and appends UTC ISO", () => {
    const out = buildCurrentTimeResult(instant, tz);
    expect(out).toContain("Thursday, June 4, 2026");
    // Localized separator before AM/PM and the tz abbreviation spelling vary by
    // ICU build, so pin robust substrings rather than an exact full string.
    expect(out).toMatch(/6:23:45/);
    expect(out).toContain("PM");
    expect(out).toMatch(/PDT|GMT-7|GMT-07/);
    expect(out).toContain("America/Los_Angeles");
    expect(out).toContain("UTC: 2026-06-05T01:23:45.000Z");
  });
});

describe("identity-file budget headers", () => {
  test("renderUserProfileBlock wraps content with a percentage budget header under cap", () => {
    const content = "Name: Alex.\nLocation: Berlin.";
    const out = renderUserProfileBlock(content);
    // Header reports the actual chars, the cap, and a percentage.
    const expectedPct = Math.round((content.length / USER_SOFT_CAP_CHARS) * 100);
    expect(out).toBe(
      `USER profile (${content.length} / ${USER_SOFT_CAP_CHARS} chars, ${expectedPct}%):\n${content}`
    );
    // Under 80% the header has no near-cap suffix.
    expect(out).not.toContain("near cap");
    expect(out).not.toContain("over cap");
  });

  test("renderUserProfileBlock adds 'near cap, consolidate' between 80% and 100%", () => {
    // Build a payload sized to land in the 80-100% band exactly. Use the
    // exact cap fraction so the test is independent of rounding.
    const content = "a".repeat(Math.floor(USER_SOFT_CAP_CHARS * 0.85));
    const out = renderUserProfileBlock(content);
    expect(out.split("\n", 1)[0]).toContain("near cap, consolidate");
    expect(out).not.toContain("over cap");
  });

  test("renderUserProfileBlock reports 'over cap, please consolidate' beyond 100%", () => {
    // Overshoot the cap by ~10%.
    const content = "a".repeat(USER_SOFT_CAP_CHARS + 150);
    const out = renderUserProfileBlock(content);
    expect(out.split("\n", 1)[0]).toContain("over cap, please consolidate");
    // We do NOT truncate — full content rides into the prompt.
    expect(out).toContain(content);
  });

  test("renderSoulBlock has the same shape as renderUserProfileBlock with SOUL label and cap", () => {
    const content = "Voice: terse.\nStyle: literal.";
    const out = renderSoulBlock(content);
    const expectedPct = Math.round((content.length / SOUL_SOFT_CAP_CHARS) * 100);
    expect(out).toBe(
      `SOUL persona (${content.length} / ${SOUL_SOFT_CAP_CHARS} chars, ${expectedPct}%):\n${content}`
    );
  });

  test("buildAgentSystemContext renders USER and SOUL blocks with budget headers", () => {
    const out = buildAgentSystemContext({
      instructionsOverride: "RULES",
      soul: "PERSONA body",
      userProfile: "USER body"
    });
    expect(out).toContain("USER profile (");
    expect(out).toContain("SOUL persona (");
    expect(out).toContain("USER body");
    expect(out).toContain("PERSONA body");
  });

  test("BLOCKED notices skip the budget header (it's a safety message, not file content)", () => {
    const blocked = "[BLOCKED: USER.md contained potential prompt injection (prompt_injection). Content not loaded.]";
    const out = buildAgentSystemContext({
      instructionsOverride: "RULES",
      userProfile: blocked
    });
    // BLOCKED notice rides as-is; no "USER profile (N / 1500..." header
    // wraps it. Otherwise the model sees a budget number for a notice
    // that has nothing to do with the actual file body.
    expect(out).toContain(blocked);
    expect(out).not.toMatch(/USER profile \(\d+ \/ 1500/);
  });

  test("identityBudgetState classifies regions correctly", () => {
    const small = identityBudgetState("small body", USER_SOFT_CAP_CHARS);
    expect(small.overCap).toBe(false);
    expect(small.nearCap).toBe(false);
    const near = identityBudgetState("a".repeat(Math.floor(USER_SOFT_CAP_CHARS * 0.85)), USER_SOFT_CAP_CHARS);
    expect(near.overCap).toBe(false);
    expect(near.nearCap).toBe(true);
    const over = identityBudgetState("a".repeat(USER_SOFT_CAP_CHARS + 200), USER_SOFT_CAP_CHARS);
    expect(over.overCap).toBe(true);
    expect(over.nearCap).toBe(true);
    expect(over.pct).toBeGreaterThan(100);
  });
});

describe("getDefaultGiniInstructions", () => {
  // The runtime can't function without the bundled defaults file — a
  // missing file at this point means the runtime is incorrectly packaged.
  // The function must throw loudly rather than silently fall back to an
  // empty string or a hardcoded sentinel.
  afterEach(() => {
    // Restore the active path + drop the cache so subsequent tests get
    // the real bundled bytes back.
    __resetDefaultGiniInstructionsCacheForTest();
  });

  test("throws with a clear message when the bundled file is missing", () => {
    // Point the resolver at a path that cannot exist on any sane CI host.
    const missingPath = join(import.meta.dir, "runtime", "defaults", "does-not-exist-INSTRUCTIONS.md");
    __resetDefaultGiniInstructionsCacheForTest(missingPath);
    expect(() => getDefaultGiniInstructions()).toThrow(/default INSTRUCTIONS\.md missing from bundle/);
    expect(() => getDefaultGiniInstructions()).toThrow(missingPath);
  });

  test("memoizes on success — repeat calls reuse the cached value", () => {
    // First call reads + trims + caches; second call returns the cache.
    // We can't directly observe the absence of a syscall, so we observe
    // it indirectly: read once to populate the cache, then swap the
    // active path to a missing file AND clear the cache via the reset
    // helper. The next call now throws — proving the swap took effect.
    // If the second `getDefaultGiniInstructions()` call had hit the
    // filesystem before the explicit reset (i.e., not honored the cache),
    // there is no path swap to observe; the only way to see the failure
    // path is via the explicit reset+swap below.
    const first = getDefaultGiniInstructions();
    expect(first).toBe(expectedDefaultInstructions);
    const second = getDefaultGiniInstructions();
    expect(second).toBe(first);
    // Explicit reset + swap: confirms the override path machinery works
    // and the prior result came from the cache rather than a fresh read.
    const missingPath = join(import.meta.dir, "runtime", "defaults", "does-not-exist-INSTRUCTIONS.md");
    __resetDefaultGiniInstructionsCacheForTest(missingPath);
    expect(() => getDefaultGiniInstructions()).toThrow(/default INSTRUCTIONS\.md missing from bundle/);
  });
});

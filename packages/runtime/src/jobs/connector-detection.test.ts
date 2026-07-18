import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mutateState, readState } from "../state";
import type { RuntimeConfig } from "../types";
import { runConnectorDetection } from "./connector-detection";
import { listProviders } from "../integrations/connectors/registry";

const ROOT = mkdtempSync(join(tmpdir(), "gini-detect-test-"));

beforeAll(() => {
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function buildConfig(instance: string): RuntimeConfig {
  return {
    instance,
    port: 7339,
    token: "test",
    provider: { name: "echo", model: "" },
    workspaceRoot: ROOT,
    stateRoot: ROOT,
    logRoot: `${ROOT}-logs`
  };
}

// Stub the host-environment probes so the test outcome is deterministic
// regardless of what's installed on the developer's PATH.
function stubProviderDetect(providerId: string, value: { detected: boolean; suggestedName?: string; message?: string }): () => void {
  const provider = listProviders().find((p) => p.id === providerId);
  if (!provider) throw new Error(`Provider not registered: ${providerId}`);
  const previous = provider.detect;
  provider.detect = async () => value;
  return () => {
    provider.detect = previous;
  };
}

// Companion stub for the post-create health probe. A positive detection
// materializes a connector and runConnectorDetection then runs an initial
// checkConnector → provider.probe; for claude-code that shells out to
// `claude auth status`, the same host-dependent subprocess detect() avoids.
// Stubbing the probe keeps the create-path tests off the real CLI.
function stubProviderProbe(providerId: string, value: { ok: boolean; message: string }): () => void {
  const provider = listProviders().find((p) => p.id === providerId);
  if (!provider) throw new Error(`Provider not registered: ${providerId}`);
  const previous = provider.probe;
  provider.probe = async () => value;
  return () => {
    provider.probe = previous;
  };
}

describe("runConnectorDetection", () => {
  beforeEach(() => {
    rmSync(ROOT, { recursive: true, force: true });
  });

  test("creates an auto-source connector when a provider detects positive", async () => {
    const restore = stubProviderDetect("claude-code", { detected: true, suggestedName: "Claude Code", message: "stub" });
    // claude-code exposes a probe, so the create path runs checkConnector →
    // probe; stub it so the test never shells out to `claude auth status`.
    const restoreProbe = stubProviderProbe("claude-code", { ok: true, message: "stub" });
    try {
      // Make sure codex doesn't accidentally fire.
      const restoreCodex = stubProviderDetect("codex", { detected: false });
      try {
        const config = buildConfig("detect-creates");
        const report = await runConnectorDetection(config);
        const created = report.created.find((c) => c.provider === "claude-code");
        // canonicalCredentialName("claude-code") resolves to "claude-code"
        // (the credentialName field), which takes priority over the
        // suggestedName so isSkillActive can look up the connector by name.
        expect(created?.name).toBe("claude-code");
        const state = readState(config.instance);
        const record = state.connectors.find((c) => c.provider === "claude-code");
        expect(record?.source).toBe("auto");
        expect(record?.status).toBe("configured");
      } finally {
        restoreCodex();
      }
    } finally {
      restoreProbe();
      restore();
    }
  });

  test("is idempotent when run twice in a row", async () => {
    const restore = stubProviderDetect("claude-code", { detected: true, suggestedName: "Claude Code" });
    const restoreProbe = stubProviderProbe("claude-code", { ok: true, message: "stub" });
    const restoreCodex = stubProviderDetect("codex", { detected: false });
    try {
      const config = buildConfig("detect-idempotent");
      await runConnectorDetection(config);
      const second = await runConnectorDetection(config);
      expect(second.created).toEqual([]);
      const state = readState(config.instance);
      const matches = state.connectors.filter((c) => c.provider === "claude-code");
      expect(matches.length).toBe(1);
      expect(second.skipped.find((s) => s.provider === "claude-code")?.reason).toBe("exists");
    } finally {
      restoreCodex();
      restoreProbe();
      restore();
    }
  });

  test("respects a disabled tombstone and does not re-create", async () => {
    const restore = stubProviderDetect("claude-code", { detected: true });
    const restoreCodex = stubProviderDetect("codex", { detected: false });
    try {
      const config = buildConfig("detect-tombstone");
      await mutateState(config.instance, (state) => {
        const at = new Date().toISOString();
        state.connectors.push({
          id: "id_tombstone",
          instance: state.instance,
          name: "Claude Code",
          provider: "claude-code",
          status: "disabled",
          scopes: [],
          secretRefs: [],
          createdAt: at,
          updatedAt: at,
          health: "unknown",
          source: "auto"
        });
      });
      const report = await runConnectorDetection(config);
      expect(report.created).toEqual([]);
      expect(report.skipped.find((s) => s.provider === "claude-code")?.reason).toBe("tombstoned");
      const state = readState(config.instance);
      expect(state.connectors.filter((c) => c.provider === "claude-code").length).toBe(1);
    } finally {
      restoreCodex();
      restore();
    }
  });

  test("skips when a user-source connector already exists", async () => {
    const restore = stubProviderDetect("claude-code", { detected: true });
    const restoreCodex = stubProviderDetect("codex", { detected: false });
    try {
      const config = buildConfig("detect-existing-user");
      await mutateState(config.instance, (state) => {
        const at = new Date().toISOString();
        state.connectors.push({
          id: "id_user",
          instance: state.instance,
          name: "user claude",
          provider: "claude-code",
          status: "configured",
          scopes: [],
          secretRefs: [],
          createdAt: at,
          updatedAt: at,
          health: "healthy",
          source: "user"
        });
      });
      const report = await runConnectorDetection(config);
      expect(report.created).toEqual([]);
      expect(report.skipped.find((s) => s.provider === "claude-code")?.reason).toBe("exists");
    } finally {
      restoreCodex();
      restore();
    }
  });

  test("skips providers without a detect method", async () => {
    // This test asserts only that the no-detect providers (demo/linear/
    // generic) are reported; it doesn't care what claude-code/codex return.
    // Stub their detect() to a fast value so the run doesn't shell out to
    // `which` / `claude auth status` / `codex`. They still own a detect
    // function (the stub), so they're correctly excluded from "no-detect".
    const restoreClaude = stubProviderDetect("claude-code", { detected: false });
    const restoreCodex = stubProviderDetect("codex", { detected: false });
    try {
      const config = buildConfig("detect-no-method");
      // demo + linear + generic have no detect — they should land in `skipped`
      // with reason "no-detect" and never appear in `created`.
      const report = await runConnectorDetection(config);
      const noDetectIds = report.skipped.filter((s) => s.reason === "no-detect").map((s) => s.provider);
      expect(noDetectIds).toContain("demo");
      expect(noDetectIds).toContain("linear");
      expect(noDetectIds).toContain("generic");
    } finally {
      restoreCodex();
      restoreClaude();
    }
  });
});

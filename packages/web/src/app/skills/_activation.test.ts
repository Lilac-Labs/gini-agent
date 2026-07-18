// Pure-JS tests (no React/DOM) for the Skills-page activation logic. Now reads
// the server-computed `usable` bit when present; falls back to the client-side
// predicate when absent (backward compat during rolling deploys).

import { describe, expect, test } from "bun:test";
import type { ConnectorRecord, SkillRecord } from "@runtime/types";
import type { ProviderDescriptor } from "@/lib/queries";
import { deriveActivation } from "./_activation";

function skill(overrides: Partial<SkillRecord>): SkillRecord {
  return {
    id: "skill_test",
    instance: "dev",
    name: "test",
    description: "",
    trigger: "",
    steps: [],
    requiredTools: [],
    requiredPermissions: [],
    status: "enabled",
    version: 1,
    createdAt: "",
    updatedAt: "",
    tests: [],
    successCount: 0,
    failureCount: 0,
    previousVersions: [],
    body: "",
    ...overrides
  };
}

function connector(overrides: Partial<ConnectorRecord>): ConnectorRecord {
  return {
    id: "id_test",
    instance: "dev",
    name: "google-workspace-oauth",
    provider: "google-oauth-desktop",
    status: "configured",
    scopes: [],
    secretRefs: [],
    createdAt: "",
    updatedAt: "",
    health: "healthy",
    ...overrides
  };
}

// The google-oauth-desktop provider as the /api/connectors/providers payload
// surfaces it. An account attached to this instance reports the credential as
// externally satisfied.
function gwsProvider(overrides: Partial<ProviderDescriptor> = {}): ProviderDescriptor {
  return {
    id: "google-oauth-desktop",
    label: "Google Workspace OAuth",
    description: "",
    fields: [],
    hasProbe: false,
    hasDetect: false,
    credentialTemplate: { type: "oauth2", name: "google-workspace-oauth" },
    ...overrides
  };
}

function byNameOf(connectors: ConnectorRecord[]): Map<string, ConnectorRecord[]> {
  const map = new Map<string, ConnectorRecord[]>();
  for (const c of connectors) {
    const list = map.get(c.name) ?? [];
    list.push(c);
    map.set(c.name, list);
  }
  return map;
}

// deriveActivation for the Google Workspace credential, with a provider whose
// externallySatisfied bit is controlled per-test.
function activationFor(
  s: SkillRecord,
  connectors: ConnectorRecord[],
  provider: ProviderDescriptor = gwsProvider()
) {
  return deriveActivation(
    s,
    byNameOf(connectors),
    new Map([[provider.id, provider]]),
    new Map([["google-workspace-oauth", provider]])
  );
}

describe("deriveActivation: skill status short-circuits", () => {
  test("unsupported validation -> unsupported/danger", () => {
    const s = skill({ validationStatus: "unsupported", requiredCredentials: ["google-workspace-oauth"] });
    expect(activationFor(s, [])).toEqual({ label: "unsupported", tone: "danger" });
  });

  test("disabled skill -> disabled/neutral", () => {
    const s = skill({ status: "disabled", requiredCredentials: ["google-workspace-oauth"] });
    expect(activationFor(s, [])).toEqual({ label: "disabled", tone: "neutral" });
  });

  test("archived skill -> disabled/neutral", () => {
    const s = skill({ status: "archived", requiredCredentials: ["google-workspace-oauth"] });
    expect(activationFor(s, [])).toEqual({ label: "disabled", tone: "neutral" });
  });

  test("no required credentials -> active/ok", () => {
    const s = skill({ requiredCredentials: [] });
    expect(activationFor(s, [])).toEqual({ label: "active", tone: "ok" });
  });

  test("undefined requiredCredentials treated as none -> active/ok", () => {
    const s = skill({ requiredCredentials: undefined });
    expect(activationFor(s, [])).toEqual({ label: "active", tone: "ok" });
  });
});

describe("deriveActivation: server usable bit", () => {
  const serviceSkill = skill({
    name: "google-calendar",
    requiredCredentials: ["google-workspace-oauth"]
  });

  test("usable: true -> active/ok", () => {
    const conn = connector({ usable: true });
    expect(activationFor(serviceSkill, [conn])).toEqual({ label: "active", tone: "ok" });
  });

  test("usable: false -> needs setup/warn", () => {
    const conn = connector({ usable: false });
    expect(activationFor(serviceSkill, [conn])).toEqual({ label: "needs setup", tone: "warn" });
  });

  test("codex skill gates on codex connector usable bit", () => {
    const codexSkill = skill({ name: "codex-delegate", requiredCredentials: ["codex"] });
    const codexProvider: ProviderDescriptor = {
      id: "codex", label: "Codex", description: "", fields: [],
      hasProbe: true, hasDetect: true
    };
    const conn = connector({ name: "codex", provider: "codex", usable: true });
    const result = deriveActivation(
      codexSkill,
      byNameOf([conn]),
      new Map([["codex", codexProvider]]),
      new Map([["codex", codexProvider]])
    );
    expect(result).toEqual({ label: "active", tone: "ok" });

    const unhealthy = connector({ name: "codex", provider: "codex", usable: false });
    const result2 = deriveActivation(
      codexSkill,
      byNameOf([unhealthy]),
      new Map([["codex", codexProvider]]),
      new Map([["codex", codexProvider]])
    );
    expect(result2).toEqual({ label: "needs setup", tone: "warn" });
  });
});

describe("deriveActivation: fallback when usable is absent", () => {
  const serviceSkill = skill({
    name: "google-calendar",
    requiredCredentials: ["google-workspace-oauth"]
  });

  test("configured + healthy record -> active/ok (fallback)", () => {
    const conn = connector({ status: "configured", health: "healthy" });
    expect(activationFor(serviceSkill, [conn])).toEqual({ label: "active", tone: "ok" });
  });

  test("configured + unknown health on a probe-less provider -> active/ok (presence-healthy)", () => {
    const conn = connector({ status: "configured", health: "unknown" });
    expect(activationFor(serviceSkill, [conn], gwsProvider({ hasProbe: false }))).toEqual({
      label: "active",
      tone: "ok"
    });
  });

  test("configured + unknown health but provider HAS a probe -> needs setup/warn", () => {
    const conn = connector({ status: "configured", health: "unknown" });
    expect(activationFor(serviceSkill, [conn], gwsProvider({ hasProbe: true }))).toEqual({
      label: "needs setup",
      tone: "warn"
    });
  });

  test("a disabled record does not satisfy and blocks the fallthrough -> needs setup/warn", () => {
    const conn = connector({ status: "disabled", health: "healthy" });
    expect(activationFor(serviceSkill, [conn], gwsProvider({ externallySatisfied: true }))).toEqual({
      label: "needs setup",
      tone: "warn"
    });
  });
});

describe("deriveActivation: externally-satisfied fallthrough", () => {
  const serviceSkill = skill({
    name: "google-calendar",
    requiredCredentials: ["google-workspace-oauth"]
  });

  test("no connector record + provider externallySatisfied -> active/ok", () => {
    expect(activationFor(serviceSkill, [], gwsProvider({ externallySatisfied: true }))).toEqual({
      label: "active",
      tone: "ok"
    });
  });

  test("no connector record + provider NOT externallySatisfied -> needs setup/warn", () => {
    expect(activationFor(serviceSkill, [], gwsProvider({ externallySatisfied: false }))).toEqual({
      label: "needs setup",
      tone: "warn"
    });
  });

  test("no connector record + no provider mapped for the credential -> needs setup/warn", () => {
    const s = skill({ name: "needs-unmapped", requiredCredentials: ["UNMAPPED_KEY"] });
    const activation = deriveActivation(s, byNameOf([]), new Map(), new Map());
    expect(activation).toEqual({ label: "needs setup", tone: "warn" });
  });
});

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmptyState, mutateState, readState } from "../../state";
import { attachGoogleAccountToInstance } from "../../state/google-account-bindings";
import { writeGoogleAccounts } from "../../state/google-accounts";
import { writeSecret } from "../../state/secrets";
import type { ConnectorRecord, RuntimeConfig, SkillRecord } from "../../types";
import { bindingsForCredentials, checkConnector, connectorIsUsable, createConnector, isSkillActive, markConnectorUnhealthyForProvider, resolveSkillEnv, updateConnector } from "./index";

const ROOT = "/tmp/gini-connectors-unit";

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function newSkill(overrides: Partial<SkillRecord>): SkillRecord {
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

function newConnector(overrides: Partial<ConnectorRecord>): ConnectorRecord {
  return {
    id: "id_test",
    instance: "dev",
    name: "test",
    provider: "linear",
    status: "configured",
    scopes: [],
    secretRefs: [],
    createdAt: "",
    updatedAt: "",
    health: "healthy",
    ...overrides
  };
}

describe("isSkillActive", () => {
  // Name-based: a skill is active iff every `requiredCredentials` name maps to
  // a configured + healthy connector. The connector keeps its `provider` so the
  // usability guard can consult the module's probe (linear probes; demo does
  // not), but the gate matches on `name`.

  test("returns true when the skill has no required credentials", () => {
    const state = createEmptyState("dev");
    state.connectors = [];
    const skill = newSkill({ requiredCredentials: [] });
    expect(isSkillActive(state, skill)).toBe(true);
  });

  test("returns true when every required credential has a healthy connector", () => {
    const state = createEmptyState("dev");
    state.connectors = [newConnector({ name: "LINEAR_API_KEY", type: "api-key", provider: "linear", health: "healthy" })];
    const skill = newSkill({ requiredCredentials: ["LINEAR_API_KEY"] });
    expect(isSkillActive(state, skill)).toBe(true);
  });

  test("returns false when the matching connector is unhealthy", () => {
    const state = createEmptyState("dev");
    state.connectors = [newConnector({ name: "LINEAR_API_KEY", type: "api-key", provider: "linear", health: "unhealthy" })];
    const skill = newSkill({ requiredCredentials: ["LINEAR_API_KEY"] });
    expect(isSkillActive(state, skill)).toBe(false);
  });

  test("returns false when no connector with the required name exists", () => {
    const state = createEmptyState("dev");
    state.connectors = [newConnector({ name: "OTHER_KEY", type: "api-key", provider: "linear", health: "healthy" })];
    const skill = newSkill({ requiredCredentials: ["LINEAR_API_KEY"] });
    expect(isSkillActive(state, skill)).toBe(false);
  });

  test("returns false when a skill is marked unsupported", () => {
    const state = createEmptyState("dev");
    state.connectors = [newConnector({ name: "LINEAR_API_KEY", type: "api-key", provider: "linear", health: "healthy" })];
    const skill = newSkill({
      requiredCredentials: ["LINEAR_API_KEY"],
      validationStatus: "unsupported",
      validationMessage: "Unknown provider in source"
    });
    expect(isSkillActive(state, skill)).toBe(false);
  });

  test("treats unknown health as inactive when the provider has a probe", () => {
    const state = createEmptyState("dev");
    // Linear has a probe; an unprobed connector should not satisfy the gate.
    state.connectors = [newConnector({ name: "LINEAR_API_KEY", type: "api-key", provider: "linear", health: "unknown" })];
    const skill = newSkill({ requiredCredentials: ["LINEAR_API_KEY"] });
    expect(isSkillActive(state, skill)).toBe(false);
  });

  test("treats unknown health as active when the provider has no probe", () => {
    const state = createEmptyState("dev");
    // The "demo" provider declares no probe — presence is enough.
    state.connectors = [newConnector({ name: "DEMO_KEY", type: "api-key", provider: "demo", health: "unknown" })];
    const skill = newSkill({ requiredCredentials: ["DEMO_KEY"] });
    expect(isSkillActive(state, skill)).toBe(true);
  });

  test("disabled connector with healthy probe does NOT satisfy a skill", () => {
    // The user explicitly turned this connector off. A stale `health:
    // "healthy"` from before they disabled it (or a probe job that ran
    // anyway) must not let dependent skills activate behind their back.
    const state = createEmptyState("dev");
    state.connectors = [newConnector({ name: "LINEAR_API_KEY", type: "api-key", provider: "linear", status: "disabled", health: "healthy" })];
    const skill = newSkill({ requiredCredentials: ["LINEAR_API_KEY"] });
    expect(isSkillActive(state, skill)).toBe(false);
  });

  test("error-status connector does NOT satisfy a skill even if a probe later returns healthy", () => {
    const state = createEmptyState("dev");
    state.connectors = [newConnector({ name: "LINEAR_API_KEY", type: "api-key", provider: "linear", status: "error", health: "healthy" })];
    const skill = newSkill({ requiredCredentials: ["LINEAR_API_KEY"] });
    expect(isSkillActive(state, skill)).toBe(false);
  });

  test("disabled connector does NOT satisfy a no-probe provider either", () => {
    const state = createEmptyState("dev");
    state.connectors = [newConnector({ name: "DEMO_KEY", type: "api-key", provider: "demo", status: "disabled", health: "unknown" })];
    const skill = newSkill({ requiredCredentials: ["DEMO_KEY"] });
    expect(isSkillActive(state, skill)).toBe(false);
  });
});

describe("resolveSkillEnv", () => {
  // resolveSkillEnv resolves prerequisites.env for a skill by finding a
  // matching connector and reading its secret. The find predicate must
  // mirror the isSkillActive guard — otherwise a disabled or error-status
  // connector with a stale `health: "healthy"` could leak its secret into
  // a terminal_exec spawn even though the activation gate excludes the
  // skill.

  test("disabled connector with healthy probe does NOT inject its secret", async () => {
    const instance = "resolve-disabled";
    const config = {
      instance,
      port: 0,
      token: "t",
      provider: { name: "echo" as const, model: "echo" },
      workspaceRoot: `${ROOT}/${instance}/workspace`,
      stateRoot: `${ROOT}/${instance}`,
      logRoot: `${ROOT}/${instance}/logs`
    };
    const ref = writeSecret(instance, "id_disabled", "LINEAR_API_KEY", "leaked-token");
    await mutateState(instance, (state) => {
      state.connectors.push(newConnector({
        id: "id_disabled",
        instance,
        provider: "linear",
        type: "api-key",
        name: "LINEAR_API_KEY",
        status: "disabled",
        health: "healthy",
        secretRefs: [ref]
      }));
    });
    const skill = newSkill({
      source: "bundled",
      requiredCredentials: ["LINEAR_API_KEY"],
      prerequisites: { env: ["LINEAR_API_KEY"] }
    });
    const env = await resolveSkillEnv(config, skill);
    expect(env).toEqual({});
  });

  test("configured + healthy connector DOES inject its secret (regression)", async () => {
    // Post-migration shape: the connector is typed api-key named LINEAR_API_KEY
    // and the skill references it by name. (The state migration re-keys the
    // secret purpose to the credential name; a stored secret under "token"
    // resolves via bindingsForCredentials reading the single secretRef's
    // purpose.)
    const instance = "resolve-configured";
    const config = {
      instance,
      port: 0,
      token: "t",
      provider: { name: "echo" as const, model: "echo" },
      workspaceRoot: `${ROOT}/${instance}/workspace`,
      stateRoot: `${ROOT}/${instance}`,
      logRoot: `${ROOT}/${instance}/logs`
    };
    const ref = writeSecret(instance, "id_ok", "LINEAR_API_KEY", "real-token");
    await mutateState(instance, (state) => {
      state.connectors.push(newConnector({
        id: "id_ok",
        instance,
        provider: "linear",
        type: "api-key",
        name: "LINEAR_API_KEY",
        status: "configured",
        health: "healthy",
        secretRefs: [ref]
      }));
    });
    const skill = newSkill({
      source: "bundled",
      requiredCredentials: ["LINEAR_API_KEY"],
      prerequisites: { env: ["LINEAR_API_KEY"] }
    });
    const env = await resolveSkillEnv(config, skill);
    expect(env).toEqual({ LINEAR_API_KEY: "real-token" });
  });

  // A generic credential migrates to an api-key named by its field purpose
  // (single secret) or an oauth2 with an identity envMap (2+ secrets). After
  // migration, resolution is name-based — these tests use that post-migration
  // shape directly.

  test("generic api-key injects the secret under its name == declared env var", async () => {
    const instance = "resolve-generic";
    const config = {
      instance,
      port: 0,
      token: "t",
      provider: { name: "echo" as const, model: "echo" },
      workspaceRoot: `${ROOT}/${instance}/workspace`,
      stateRoot: `${ROOT}/${instance}`,
      logRoot: `${ROOT}/${instance}/logs`
    };
    const ref = writeSecret(instance, "id_generic", "MY_API_KEY", "generic-real");
    await mutateState(instance, (state) => {
      state.connectors.push(newConnector({
        id: "id_generic",
        instance,
        provider: "generic",
        type: "api-key",
        name: "MY_API_KEY",
        status: "configured",
        health: "healthy",
        secretRefs: [ref]
      }));
    });
    const skill = newSkill({
      source: "bundled",
      requiredCredentials: ["MY_API_KEY"],
      prerequisites: { env: ["MY_API_KEY"] }
    });
    const env = await resolveSkillEnv(config, skill);
    expect(env).toEqual({ MY_API_KEY: "generic-real" });
  });

  test("oauth2 credential materializes its full envMap (no prerequisites.env filter)", async () => {
    // An oauth2 credential's `envMap` IS its contract for which env vars it
    // produces — resolveSkillEnv injects every mapped var for a granted
    // credential, independent of `prerequisites.env`.
    const instance = "resolve-generic-extra";
    const config = {
      instance,
      port: 0,
      token: "t",
      provider: { name: "echo" as const, model: "echo" },
      workspaceRoot: `${ROOT}/${instance}/workspace`,
      stateRoot: `${ROOT}/${instance}`,
      logRoot: `${ROOT}/${instance}/logs`
    };
    const wanted = writeSecret(instance, "id_generic", "MY_API_KEY", "generic-real");
    const extra = writeSecret(instance, "id_generic", "OTHER_SECRET", "other-real");
    await mutateState(instance, (state) => {
      state.connectors.push(newConnector({
        id: "id_generic",
        instance,
        provider: "generic",
        type: "oauth2",
        name: "my-generic-oauth",
        status: "configured",
        health: "healthy",
        secretRefs: [wanted, extra],
        metadata: { envMap: { MY_API_KEY: "MY_API_KEY", OTHER_SECRET: "OTHER_SECRET" } }
      }));
    });
    const skill = newSkill({
      source: "bundled",
      requiredCredentials: ["my-generic-oauth"]
    });
    const env = await resolveSkillEnv(config, skill);
    expect(env).toEqual({ MY_API_KEY: "generic-real", OTHER_SECRET: "other-real" });
  });

  test("disabled generic credential does NOT inject its secret", async () => {
    const instance = "resolve-generic-disabled";
    const config = {
      instance,
      port: 0,
      token: "t",
      provider: { name: "echo" as const, model: "echo" },
      workspaceRoot: `${ROOT}/${instance}/workspace`,
      stateRoot: `${ROOT}/${instance}`,
      logRoot: `${ROOT}/${instance}/logs`
    };
    const ref = writeSecret(instance, "id_generic", "MY_API_KEY", "generic-real");
    await mutateState(instance, (state) => {
      state.connectors.push(newConnector({
        id: "id_generic",
        instance,
        provider: "generic",
        type: "api-key",
        name: "MY_API_KEY",
        status: "disabled",
        health: "healthy",
        secretRefs: [ref]
      }));
    });
    const skill = newSkill({
      source: "bundled",
      requiredCredentials: ["MY_API_KEY"],
      prerequisites: { env: ["MY_API_KEY"] }
    });
    const env = await resolveSkillEnv(config, skill);
    expect(env).toEqual({});
  });

  // Per-(skill, connector) consent gate (ADR skill-connector-consent.md). A
  // non-bundled skill receives a credentialed connector's env only after the
  // user grants that provider; bundled skills are auto-granted.

  test("ungranted non-bundled skill does NOT inject even with a healthy connector", async () => {
    const instance = "resolve-ungranted";
    const config = {
      instance,
      port: 0,
      token: "t",
      provider: { name: "echo" as const, model: "echo" },
      workspaceRoot: `${ROOT}/${instance}/workspace`,
      stateRoot: `${ROOT}/${instance}`,
      logRoot: `${ROOT}/${instance}/logs`
    };
    const ref = writeSecret(instance, "id_ungranted", "LINEAR_API_KEY", "real-token");
    await mutateState(instance, (state) => {
      state.connectors.push(newConnector({
        id: "id_ungranted",
        instance,
        provider: "linear",
        type: "api-key",
        name: "LINEAR_API_KEY",
        status: "configured",
        health: "healthy",
        secretRefs: [ref]
      }));
    });
    const skill = newSkill({
      source: "user",
      requiredCredentials: ["LINEAR_API_KEY"],
      prerequisites: { env: ["LINEAR_API_KEY"] }
    });
    const env = await resolveSkillEnv(config, skill);
    expect(env).toEqual({});
  });

  test("granted non-bundled skill injects the connector's secret", async () => {
    const instance = "resolve-granted";
    const config = {
      instance,
      port: 0,
      token: "t",
      provider: { name: "echo" as const, model: "echo" },
      workspaceRoot: `${ROOT}/${instance}/workspace`,
      stateRoot: `${ROOT}/${instance}`,
      logRoot: `${ROOT}/${instance}/logs`
    };
    const ref = writeSecret(instance, "id_granted", "LINEAR_API_KEY", "real-token");
    await mutateState(instance, (state) => {
      state.connectors.push(newConnector({
        id: "id_granted",
        instance,
        provider: "linear",
        type: "api-key",
        name: "LINEAR_API_KEY",
        status: "configured",
        health: "healthy",
        secretRefs: [ref]
      }));
    });
    const skill = newSkill({
      source: "user",
      grantedConnectors: ["LINEAR_API_KEY"],
      requiredCredentials: ["LINEAR_API_KEY"],
      prerequisites: { env: ["LINEAR_API_KEY"] }
    });
    const env = await resolveSkillEnv(config, skill);
    expect(env).toEqual({ LINEAR_API_KEY: "real-token" });
  });

  test("bundled skill injects without any written grant (auto-grant)", async () => {
    const instance = "resolve-bundled-autogrant";
    const config = {
      instance,
      port: 0,
      token: "t",
      provider: { name: "echo" as const, model: "echo" },
      workspaceRoot: `${ROOT}/${instance}/workspace`,
      stateRoot: `${ROOT}/${instance}`,
      logRoot: `${ROOT}/${instance}/logs`
    };
    const ref = writeSecret(instance, "id_bundled", "LINEAR_API_KEY", "real-token");
    await mutateState(instance, (state) => {
      state.connectors.push(newConnector({
        id: "id_bundled",
        instance,
        provider: "linear",
        type: "api-key",
        name: "LINEAR_API_KEY",
        status: "configured",
        health: "healthy",
        secretRefs: [ref]
      }));
    });
    const skill = newSkill({
      source: "bundled",
      requiredCredentials: ["LINEAR_API_KEY"],
      prerequisites: { env: ["LINEAR_API_KEY"] }
    });
    const env = await resolveSkillEnv(config, skill);
    expect(env).toEqual({ LINEAR_API_KEY: "real-token" });
  });
});

// Name-based resolution (the model post-credential-refactor). Skills declare
// `requiredCredentials` (names); connectors carry a `type` and (for api-key)
// the env var IS the credential name. The transitional fallback above keeps
// `requiredConnectors`-keyed skills working until the migration lands.

describe("isSkillActive by credential name", () => {
  test("satisfied when a usable connector with the required name exists", () => {
    const state = createEmptyState("dev");
    state.connectors = [newConnector({ name: "LINEAR_API_KEY", type: "api-key", provider: "linear", health: "healthy" })];
    const skill = newSkill({ requiredCredentials: ["LINEAR_API_KEY"] });
    expect(isSkillActive(state, skill)).toBe(true);
  });

  test("unsatisfied when no connector has the required name", () => {
    const state = createEmptyState("dev");
    state.connectors = [newConnector({ name: "OTHER_KEY", type: "api-key", provider: "linear", health: "healthy" })];
    const skill = newSkill({ requiredCredentials: ["LINEAR_API_KEY"] });
    expect(isSkillActive(state, skill)).toBe(false);
  });

  test("unsatisfied when the named connector is disabled (stale healthy probe)", () => {
    const state = createEmptyState("dev");
    state.connectors = [newConnector({ name: "LINEAR_API_KEY", type: "api-key", provider: "linear", status: "disabled", health: "healthy" })];
    const skill = newSkill({ requiredCredentials: ["LINEAR_API_KEY"] });
    expect(isSkillActive(state, skill)).toBe(false);
  });
});

describe("isSkillActive with an externally satisfied credential", () => {
  // google-oauth-desktop's `credentialExternallySatisfied` hook reads the
  // machine-global account registry (~/.gini/google-accounts/accounts.json).
  // HOME is pointed at a scratch dir per test — the registry resolves HOME via
  // process.env.HOME first (see the src/state/google-accounts.ts header) — so
  // the host machine's real registry never leaks into these assertions.
  let scratchHome: string;
  let prevHome: string | undefined;
  let prevStateRoot: string | undefined;

  beforeEach(() => {
    scratchHome = mkdtempSync(join(tmpdir(), "gini-connectors-ext-"));
    prevHome = process.env.HOME;
    process.env.HOME = scratchHome;
    prevStateRoot = process.env.GINI_STATE_ROOT;
    process.env.GINI_STATE_ROOT = join(scratchHome, "state");
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevStateRoot === undefined) delete process.env.GINI_STATE_ROOT;
    else process.env.GINI_STATE_ROOT = prevStateRoot;
    rmSync(scratchHome, { recursive: true, force: true });
  });

  function registryAccount() {
    return {
      id: "gacct_test0001",
      tag: "personal",
      email: "me@example.com",
      configDir: join(scratchHome, ".gini", "google-accounts", "gacct_test0001"),
      addedAt: "2026-01-01T00:00:00.000Z"
    };
  }

  test("an instance-bound Google account activates a workspace skill with zero connectors", () => {
    const account = registryAccount();
    writeGoogleAccounts([account]);
    attachGoogleAccountToInstance("dev", account, { primary: true });
    const state = createEmptyState("dev");
    state.connectors = [];
    const skill = newSkill({ requiredCredentials: ["google-workspace-oauth"] });
    expect(isSkillActive(state, skill)).toBe(true);
  });

  test("another instance's registered Google account does not activate the workspace skill", () => {
    const account = registryAccount();
    writeGoogleAccounts([account]);
    attachGoogleAccountToInstance("other", account, { primary: true });
    const state = createEmptyState("dev");
    state.connectors = [];
    const skill = newSkill({ requiredCredentials: ["google-workspace-oauth"] });
    expect(isSkillActive(state, skill)).toBe(false);
  });

  test("an empty or missing registry leaves the workspace skill inactive", () => {
    const state = createEmptyState("dev");
    state.connectors = [];
    const skill = newSkill({ requiredCredentials: ["google-workspace-oauth"] });
    // Missing registry file.
    expect(isSkillActive(state, skill)).toBe(false);
    // Present but empty registry.
    writeGoogleAccounts([]);
    expect(isSkillActive(state, skill)).toBe(false);
  });

  test("an unrelated credential is unaffected by registered Google accounts", () => {
    writeGoogleAccounts([registryAccount()]);
    const state = createEmptyState("dev");
    state.connectors = [];
    const skill = newSkill({ requiredCredentials: ["LINEAR_API_KEY"] });
    expect(isSkillActive(state, skill)).toBe(false);
  });

  test("a disabled workspace connector keeps the skill inactive despite registered accounts", () => {
    // Explicit operator off stays off: once a connector record with the
    // required name exists, the hook never overrides its status — only a
    // fully absent record falls through to the external-satisfaction check.
    writeGoogleAccounts([registryAccount()]);
    const state = createEmptyState("dev");
    state.connectors = [newConnector({
      name: "google-workspace-oauth",
      type: "oauth2",
      provider: "google-oauth-desktop",
      status: "disabled",
      health: "healthy"
    })];
    const skill = newSkill({ requiredCredentials: ["google-workspace-oauth"] });
    expect(isSkillActive(state, skill)).toBe(false);
  });

  test("a usable record satisfies the gate even when a disabled record shares the name", () => {
    // Two records share the required name: an explicit operator-off and a
    // configured + healthy one. Any usable record satisfies the credential
    // before record-presence semantics are consulted, so the disabled
    // sibling neither blocks activation nor matters to the hook (the
    // registry is empty here — activation can only come from the usable
    // record, not external satisfaction).
    const state = createEmptyState("dev");
    state.connectors = [
      newConnector({
        id: "id_off",
        name: "google-workspace-oauth",
        type: "oauth2",
        provider: "google-oauth-desktop",
        status: "disabled",
        health: "healthy"
      }),
      newConnector({
        id: "id_on",
        name: "google-workspace-oauth",
        type: "oauth2",
        provider: "google-oauth-desktop",
        status: "configured",
        health: "healthy"
      })
    ];
    const skill = newSkill({ requiredCredentials: ["google-workspace-oauth"] });
    expect(isSkillActive(state, skill)).toBe(true);
  });
});

describe("bindingsForCredentials", () => {
  test("api-key credential: env var IS the credential name", () => {
    const state = createEmptyState("dev");
    state.connectors = [newConnector({
      id: "id_linear",
      name: "LINEAR_API_KEY",
      type: "api-key",
      provider: "linear",
      health: "healthy",
      secretRefs: [{ purpose: "token", path: "secrets/id_linear/token.json" }]
    })];
    const bindings = bindingsForCredentials(state, ["LINEAR_API_KEY"]);
    expect(bindings).toEqual({ LINEAR_API_KEY: { credentialId: "id_linear", purpose: "token" } });
  });

  test("oauth2 credential: one binding per envMap entry", () => {
    const state = createEmptyState("dev");
    state.connectors = [newConnector({
      id: "id_gws",
      name: "google-workspace-oauth",
      type: "oauth2",
      provider: "google-oauth-desktop",
      health: "healthy",
      secretRefs: [
        { purpose: "client_id", path: "secrets/id_gws/client_id.json" },
        { purpose: "client_secret", path: "secrets/id_gws/client_secret.json" }
      ],
      metadata: {
        envMap: {
          client_id: "GOOGLE_WORKSPACE_CLI_CLIENT_ID",
          client_secret: "GOOGLE_WORKSPACE_CLI_CLIENT_SECRET"
        }
      }
    })];
    const bindings = bindingsForCredentials(state, ["google-workspace-oauth"]);
    expect(bindings).toEqual({
      GOOGLE_WORKSPACE_CLI_CLIENT_ID: { credentialId: "id_gws", purpose: "client_id" },
      GOOGLE_WORKSPACE_CLI_CLIENT_SECRET: { credentialId: "id_gws", purpose: "client_secret" }
    });
  });

  test("disabled credential contributes no bindings", () => {
    const state = createEmptyState("dev");
    state.connectors = [newConnector({
      id: "id_linear",
      name: "LINEAR_API_KEY",
      type: "api-key",
      provider: "linear",
      status: "disabled",
      health: "healthy",
      secretRefs: [{ purpose: "token", path: "secrets/id_linear/token.json" }]
    })];
    expect(bindingsForCredentials(state, ["LINEAR_API_KEY"])).toEqual({});
  });

  test("untyped presence-only credential contributes no bindings even with a secretRef", () => {
    const state = createEmptyState("dev");
    state.connectors = [newConnector({
      id: "id_claude",
      name: "claude-code",
      // No `type`: a presence-only record (claude-code/codex). It may carry a
      // secretRef but exposes no env var, so a skill that names it gets {}.
      provider: "claude-code",
      health: "healthy",
      secretRefs: [{ purpose: "token", path: "secrets/id_claude/token.json" }]
    })];
    expect(bindingsForCredentials(state, ["claude-code"])).toEqual({});
  });

  test("untyped record alongside a real api-key: only the api-key injects", () => {
    const state = createEmptyState("dev");
    state.connectors = [
      newConnector({
        id: "id_claude",
        name: "claude-code",
        provider: "claude-code",
        health: "healthy",
        secretRefs: [{ purpose: "token", path: "secrets/id_claude/token.json" }]
      }),
      newConnector({
        id: "id_linear",
        name: "LINEAR_API_KEY",
        type: "api-key",
        provider: "linear",
        health: "healthy",
        secretRefs: [{ purpose: "token", path: "secrets/id_linear/token.json" }]
      })
    ];
    expect(bindingsForCredentials(state, ["claude-code", "LINEAR_API_KEY"])).toEqual({
      LINEAR_API_KEY: { credentialId: "id_linear", purpose: "token" }
    });
  });
});

describe("resolveSkillEnv by credential name", () => {
  function configFor(instance: string) {
    return {
      instance,
      port: 0,
      token: "t",
      provider: { name: "echo" as const, model: "echo" },
      workspaceRoot: `${ROOT}/${instance}/workspace`,
      stateRoot: `${ROOT}/${instance}`,
      logRoot: `${ROOT}/${instance}/logs`
    };
  }

  test("api-key: granted non-bundled skill injects the secret under name==env var", async () => {
    const instance = "name-apikey-granted";
    const ref = writeSecret(instance, "id_linear", "token", "real-token");
    await mutateState(instance, (state) => {
      state.connectors.push(newConnector({
        id: "id_linear",
        instance,
        name: "LINEAR_API_KEY",
        type: "api-key",
        provider: "linear",
        status: "configured",
        health: "healthy",
        secretRefs: [ref]
      }));
    });
    const skill = newSkill({
      source: "user",
      grantedConnectors: ["LINEAR_API_KEY"],
      requiredCredentials: ["LINEAR_API_KEY"],
      prerequisites: { env: ["LINEAR_API_KEY"] }
    });
    const env = await resolveSkillEnv(configFor(instance), skill);
    expect(env).toEqual({ LINEAR_API_KEY: "real-token" });
  });

  test("api-key: ungranted non-bundled skill injects nothing", async () => {
    const instance = "name-apikey-ungranted";
    const ref = writeSecret(instance, "id_linear", "token", "real-token");
    await mutateState(instance, (state) => {
      state.connectors.push(newConnector({
        id: "id_linear",
        instance,
        name: "LINEAR_API_KEY",
        type: "api-key",
        provider: "linear",
        status: "configured",
        health: "healthy",
        secretRefs: [ref]
      }));
    });
    const skill = newSkill({
      source: "user",
      requiredCredentials: ["LINEAR_API_KEY"],
      prerequisites: { env: ["LINEAR_API_KEY"] }
    });
    const env = await resolveSkillEnv(configFor(instance), skill);
    expect(env).toEqual({});
  });

  test("api-key: bundled skill auto-grants (no written grant needed)", async () => {
    const instance = "name-apikey-bundled";
    const ref = writeSecret(instance, "id_linear", "token", "real-token");
    await mutateState(instance, (state) => {
      state.connectors.push(newConnector({
        id: "id_linear",
        instance,
        name: "LINEAR_API_KEY",
        type: "api-key",
        provider: "linear",
        status: "configured",
        health: "healthy",
        secretRefs: [ref]
      }));
    });
    const skill = newSkill({
      source: "bundled",
      requiredCredentials: ["LINEAR_API_KEY"],
      prerequisites: { env: ["LINEAR_API_KEY"] }
    });
    const env = await resolveSkillEnv(configFor(instance), skill);
    expect(env).toEqual({ LINEAR_API_KEY: "real-token" });
  });

  test("oauth2: granted skill materializes every envMap var by name", async () => {
    const instance = "name-oauth-granted";
    const cid = writeSecret(instance, "id_gws", "client_id", "client-id-value");
    const csec = writeSecret(instance, "id_gws", "client_secret", "client-secret-value");
    await mutateState(instance, (state) => {
      state.connectors.push(newConnector({
        id: "id_gws",
        instance,
        name: "google-workspace-oauth",
        type: "oauth2",
        provider: "google-oauth-desktop",
        status: "configured",
        health: "healthy",
        secretRefs: [cid, csec],
        metadata: {
          envMap: {
            client_id: "GOOGLE_WORKSPACE_CLI_CLIENT_ID",
            client_secret: "GOOGLE_WORKSPACE_CLI_CLIENT_SECRET"
          }
        }
      }));
    });
    const skill = newSkill({
      source: "user",
      grantedConnectors: ["google-workspace-oauth"],
      requiredCredentials: ["google-workspace-oauth"],
      prerequisites: { env: ["GOOGLE_WORKSPACE_CLI_CLIENT_ID", "GOOGLE_WORKSPACE_CLI_CLIENT_SECRET"] }
    });
    const env = await resolveSkillEnv(configFor(instance), skill);
    expect(env).toEqual({
      GOOGLE_WORKSPACE_CLI_CLIENT_ID: "client-id-value",
      GOOGLE_WORKSPACE_CLI_CLIENT_SECRET: "client-secret-value"
    });
  });

  test("oauth2: ungranted skill injects nothing", async () => {
    const instance = "name-oauth-ungranted";
    const cid = writeSecret(instance, "id_gws", "client_id", "client-id-value");
    await mutateState(instance, (state) => {
      state.connectors.push(newConnector({
        id: "id_gws",
        instance,
        name: "google-workspace-oauth",
        type: "oauth2",
        provider: "google-oauth-desktop",
        status: "configured",
        health: "healthy",
        secretRefs: [cid],
        metadata: { envMap: { client_id: "GOOGLE_WORKSPACE_CLI_CLIENT_ID" } }
      }));
    });
    const skill = newSkill({
      source: "user",
      requiredCredentials: ["google-workspace-oauth"],
      prerequisites: { env: ["GOOGLE_WORKSPACE_CLI_CLIENT_ID"] }
    });
    const env = await resolveSkillEnv(configFor(instance), skill);
    expect(env).toEqual({});
  });

  test("disabled named connector does NOT inject its secret", async () => {
    const instance = "name-apikey-disabled";
    const ref = writeSecret(instance, "id_linear", "token", "leaked-token");
    await mutateState(instance, (state) => {
      state.connectors.push(newConnector({
        id: "id_linear",
        instance,
        name: "LINEAR_API_KEY",
        type: "api-key",
        provider: "linear",
        status: "disabled",
        health: "healthy",
        secretRefs: [ref]
      }));
    });
    const skill = newSkill({
      source: "bundled",
      requiredCredentials: ["LINEAR_API_KEY"],
      prerequisites: { env: ["LINEAR_API_KEY"] }
    });
    const env = await resolveSkillEnv(configFor(instance), skill);
    expect(env).toEqual({});
  });

  // The modern declaration form: a skill that lists ONLY
  // `requires.credentials` and carries NO `prerequisites.env`. Injection must
  // derive from the granted credential alone — `prerequisites.env` is legacy
  // and not required for env to flow.

  test("api-key: requires.credentials-only skill (no prerequisites.env) injects when granted", async () => {
    const instance = "name-apikey-only-granted";
    const ref = writeSecret(instance, "id_foo", "token", "foo-secret");
    await mutateState(instance, (state) => {
      state.connectors.push(newConnector({
        id: "id_foo",
        instance,
        name: "FOO_API_KEY",
        type: "api-key",
        provider: "generic",
        status: "configured",
        health: "healthy",
        secretRefs: [ref]
      }));
    });
    const skill = newSkill({
      source: "user",
      grantedConnectors: ["FOO_API_KEY"],
      requiredCredentials: ["FOO_API_KEY"]
    });
    const env = await resolveSkillEnv(configFor(instance), skill);
    expect(env).toEqual({ FOO_API_KEY: "foo-secret" });
  });

  test("api-key: requires.credentials-only skill ungranted (non-bundled) injects nothing", async () => {
    const instance = "name-apikey-only-ungranted";
    const ref = writeSecret(instance, "id_foo", "token", "foo-secret");
    await mutateState(instance, (state) => {
      state.connectors.push(newConnector({
        id: "id_foo",
        instance,
        name: "FOO_API_KEY",
        type: "api-key",
        provider: "generic",
        status: "configured",
        health: "healthy",
        secretRefs: [ref]
      }));
    });
    const skill = newSkill({
      source: "user",
      requiredCredentials: ["FOO_API_KEY"]
    });
    const env = await resolveSkillEnv(configFor(instance), skill);
    expect(env).toEqual({});
  });

  test("oauth2: requires.credentials-only skill (no prerequisites.env) injects mapped env vars", async () => {
    const instance = "name-oauth-only-granted";
    const cid = writeSecret(instance, "id_oauth", "client_id", "cid-value");
    const csec = writeSecret(instance, "id_oauth", "client_secret", "csec-value");
    await mutateState(instance, (state) => {
      state.connectors.push(newConnector({
        id: "id_oauth",
        instance,
        name: "some-oauth",
        type: "oauth2",
        provider: "generic",
        status: "configured",
        health: "healthy",
        secretRefs: [cid, csec],
        metadata: {
          envMap: {
            client_id: "SOME_CLIENT_ID",
            client_secret: "SOME_CLIENT_SECRET"
          }
        }
      }));
    });
    const skill = newSkill({
      source: "user",
      grantedConnectors: ["some-oauth"],
      requiredCredentials: ["some-oauth"]
    });
    const env = await resolveSkillEnv(configFor(instance), skill);
    expect(env).toEqual({ SOME_CLIENT_ID: "cid-value", SOME_CLIENT_SECRET: "csec-value" });
  });
});

// Type-driven create (commit 4). When `type` is supplied, createConnector
// drops the "provider must be a registered module" requirement — a plain
// api key needs no provider code — and enforces the LOCKED name rules:
// api-key name IS the env var (uppercase env-token), names are unique
// instance-wide, oauth2 envMap targets are valid env tokens.

describe("createConnector typed credentials", () => {
  function configFor(instance: string): RuntimeConfig {
    return {
      instance,
      port: 0,
      token: "t",
      provider: { name: "echo" as const, model: "echo" },
      workspaceRoot: `${ROOT}/${instance}/workspace`,
      stateRoot: `${ROOT}/${instance}`,
      logRoot: `${ROOT}/${instance}/logs`
    };
  }

  test("api-key: name IS the env var; secret keyed by name; MCP metadata persisted", async () => {
    const config = configFor("create-apikey");
    const created = await createConnector(config, {
      provider: "generic",
      name: "MY_SERVICE_KEY",
      type: "api-key",
      secrets: { MY_SERVICE_KEY: "secret-value" },
      metadata: { mcp: { url: "https://mcp.example.com/mcp", headerName: "Authorization", scheme: "Bearer" } }
    });
    expect(created.type).toBe("api-key");
    expect(created.name).toBe("MY_SERVICE_KEY");
    expect(created.secretRefs).toHaveLength(1);
    expect(created.secretRefs[0]!.purpose).toBe("MY_SERVICE_KEY");
    expect(created.metadata?.mcp).toEqual({ url: "https://mcp.example.com/mcp", headerName: "Authorization", scheme: "Bearer" });
  });

  test("api-key: an unknown provider is allowed once a type is supplied", async () => {
    const config = configFor("create-apikey-unknown-provider");
    const created = await createConnector(config, {
      provider: "not-a-registered-module",
      name: "PLAIN_KEY",
      type: "api-key",
      secrets: { PLAIN_KEY: "value" }
    });
    expect(created.type).toBe("api-key");
    expect(created.provider).toBe("not-a-registered-module");
  });

  test("api-key: a non-env-token name is rejected", async () => {
    const config = configFor("create-apikey-badname");
    await expect(
      createConnector(config, {
        provider: "generic",
        name: "my-service-key",
        type: "api-key",
        secrets: { "my-service-key": "value" }
      })
    ).rejects.toThrow(/Invalid api-key credential name/);
  });

  test("a duplicate name is rejected instance-wide", async () => {
    const config = configFor("create-dupe");
    await createConnector(config, {
      provider: "generic",
      name: "DUPE_KEY",
      type: "api-key",
      secrets: { DUPE_KEY: "value" }
    });
    await expect(
      createConnector(config, {
        provider: "generic",
        name: "DUPE_KEY",
        type: "api-key",
        secrets: { DUPE_KEY: "value2" }
      })
    ).rejects.toThrow(/already exists/);
  });

  test("oauth2: envMap persisted and every secret keyed by its env var", async () => {
    const config = configFor("create-oauth2");
    const created = await createConnector(config, {
      provider: "generic",
      name: "my-oauth",
      type: "oauth2",
      secrets: { CLIENT_ID: "cid", CLIENT_SECRET: "csec" },
      metadata: { envMap: { CLIENT_ID: "CLIENT_ID", CLIENT_SECRET: "CLIENT_SECRET" } }
    });
    expect(created.type).toBe("oauth2");
    expect(created.name).toBe("my-oauth");
    expect(created.metadata?.envMap).toEqual({ CLIENT_ID: "CLIENT_ID", CLIENT_SECRET: "CLIENT_SECRET" });
    expect(created.secretRefs.map((r) => r.purpose).sort()).toEqual(["CLIENT_ID", "CLIENT_SECRET"]);
  });

  test("oauth2: an invalid env var name in envMap is rejected", async () => {
    const config = configFor("create-oauth2-badenv");
    await expect(
      createConnector(config, {
        provider: "generic",
        name: "my-oauth-bad",
        type: "oauth2",
        secrets: { "client-id": "cid" },
        metadata: { envMap: { "client-id": "client-id" } }
      })
    ).rejects.toThrow(/Invalid env var name in envMap/);
  });

  test("untyped create still requires a registered provider (unchanged)", async () => {
    const config = configFor("create-untyped-unknown");
    await expect(
      createConnector(config, {
        provider: "not-a-registered-module",
        name: "whatever"
      })
    ).rejects.toThrow(/Unknown provider/);
  });

  test("a typed create persists the record and resolves by name", async () => {
    const config = configFor("create-roundtrip");
    const created = await createConnector(config, {
      provider: "generic",
      name: "ROUNDTRIP_KEY",
      type: "api-key",
      secrets: { ROUNDTRIP_KEY: "value" }
    });
    const stored = readState(config.instance).connectors.find((c) => c.id === created.id);
    expect(stored?.name).toBe("ROUNDTRIP_KEY");
    expect(stored?.type).toBe("api-key");
  });

  test("api-key: more than one secret is rejected", async () => {
    const config = configFor("create-apikey-two-secrets");
    await expect(
      createConnector(config, {
        provider: "generic",
        name: "TWO_SECRETS",
        type: "api-key",
        secrets: { TWO_SECRETS: "a", EXTRA: "b" }
      })
    ).rejects.toThrow(/exactly one secret/);
  });

  test("oauth2: an envMap purpose with no matching secret is rejected", async () => {
    const config = configFor("create-oauth2-missing-secret");
    await expect(
      createConnector(config, {
        provider: "generic",
        name: "my-oauth-missing",
        type: "oauth2",
        secrets: { CLIENT_ID: "cid" },
        metadata: { envMap: { CLIENT_ID: "CLIENT_ID", CLIENT_SECRET: "CLIENT_SECRET" } }
      })
    ).rejects.toThrow(/has no secret for it/);
  });

  test("a duplicate name collides even against a disabled record", async () => {
    const config = configFor("create-dupe-disabled");
    const first = await createConnector(config, {
      provider: "generic",
      name: "DISABLED_DUPE",
      type: "api-key",
      secrets: { DISABLED_DUPE: "value" }
    });
    await mutateState(config.instance, (state) => {
      const c = state.connectors.find((x) => x.id === first.id)!;
      c.status = "disabled";
    });
    await expect(
      createConnector(config, {
        provider: "generic",
        name: "DISABLED_DUPE",
        type: "api-key",
        secrets: { DISABLED_DUPE: "value2" }
      })
    ).rejects.toThrow(/already exists/);
  });
});

// Template-driven create (GROUP 1). Every create path that does NOT pass an
// explicit `type` but names a template-backed provider (linear,
// google-oauth-desktop) must yield the SAME typed, name-correct record the
// migration produces — so connector.request /complete, `gini connector add`,
// and the dialog all converge on one shape.
describe("createConnector applies the provider template when no type is passed", () => {
  function configFor(instance: string): RuntimeConfig {
    return {
      instance,
      port: 0,
      token: "t",
      provider: { name: "echo" as const, model: "echo" },
      workspaceRoot: `${ROOT}/${instance}/workspace`,
      stateRoot: `${ROOT}/${instance}`,
      logRoot: `${ROOT}/${instance}/logs`
    };
  }

  test("linear → typed api-key named LINEAR_API_KEY with mcp.name, secret under purpose token", async () => {
    // Mirrors the connector.request /complete + CLI path: provider="linear",
    // a label-ish name, secret keyed by the module field "token", no type.
    const config = configFor("template-linear");
    const created = await createConnector(config, {
      provider: "linear",
      name: "My Linear",
      secrets: { token: "lin_api_real" }
    });
    expect(created.type).toBe("api-key");
    expect(created.name).toBe("LINEAR_API_KEY");
    expect(created.metadata?.mcp).toEqual({
      url: "https://mcp.linear.app/mcp",
      name: "linear",
      headerName: "Authorization",
      scheme: "Bearer"
    });
    // Secret stays under purpose "token" so the Linear probe (resolveSecret
    // "token") keeps working AND bindingsForCredentials reads it as LINEAR_API_KEY.
    expect(created.secretRefs.map((r) => r.purpose)).toEqual(["token"]);
  });

  test("google-oauth-desktop → oauth2 named google-workspace-oauth with the canonical envMap", async () => {
    const config = configFor("template-google");
    const created = await createConnector(config, {
      provider: "google-oauth-desktop",
      name: "My Google",
      // client_id is now a secret field, so the request dialog routes both
      // values into `secrets` under their purposes.
      secrets: { client_id: "cid-value", client_secret: "csec-value" }
    });
    expect(created.type).toBe("oauth2");
    expect(created.name).toBe("google-workspace-oauth");
    expect(created.metadata?.envMap).toEqual({
      client_id: "GOOGLE_WORKSPACE_CLI_CLIENT_ID",
      client_secret: "GOOGLE_WORKSPACE_CLI_CLIENT_SECRET"
    });
    expect(created.secretRefs.map((r) => r.purpose).sort()).toEqual(["client_id", "client_secret"]);
  });

  test("a fresh google credential resolves GOOGLE_WORKSPACE_CLI_CLIENT_ID by name", async () => {
    // Fresh-create shape == migration shape: GOOGLE_WORKSPACE_CLI_CLIENT_ID
    // must materialize from the credential's client_id secret.
    const instance = "template-google-resolves";
    const config = configFor(instance);
    const created = await createConnector(config, {
      provider: "google-oauth-desktop",
      name: "My Google Resolve",
      secrets: { client_id: "cid-value", client_secret: "csec-value" }
    });
    await mutateState(instance, (state) => {
      const c = state.connectors.find((x) => x.id === created.id)!;
      c.health = "healthy";
    });
    const skill = newSkill({
      source: "bundled",
      requiredCredentials: ["google-workspace-oauth"],
      prerequisites: { env: ["GOOGLE_WORKSPACE_CLI_CLIENT_ID", "GOOGLE_WORKSPACE_CLI_CLIENT_SECRET"] }
    });
    const env = await resolveSkillEnv(config, skill);
    expect(env).toEqual({
      GOOGLE_WORKSPACE_CLI_CLIENT_ID: "cid-value",
      GOOGLE_WORKSPACE_CLI_CLIENT_SECRET: "csec-value"
    });
  });

  test("presence-only provider (demo) with no template stays untyped", async () => {
    const config = configFor("template-demo");
    const created = await createConnector(config, {
      provider: "demo",
      name: "Demo"
    });
    expect(created.type).toBeUndefined();
  });
});

describe("checkConnector presence-health for typed credentials", () => {
  function configFor(instance: string): RuntimeConfig {
    return {
      instance,
      port: 0,
      token: "t",
      provider: { name: "echo" as const, model: "echo" },
      workspaceRoot: `${ROOT}/${instance}/workspace`,
      stateRoot: `${ROOT}/${instance}`,
      logRoot: `${ROOT}/${instance}/logs`
    };
  }

  test("a typed api-key whose provider has no module is presence-healthy when configured", async () => {
    const instance = "check-typed-unknown";
    const config = configFor(instance);
    const created = await createConnector(config, {
      provider: "not-a-registered-module",
      name: "PLAIN_TYPED_KEY",
      type: "api-key",
      secrets: { PLAIN_TYPED_KEY: "value" }
    });
    const probed = await checkConnector(config, created.id);
    expect(probed.health).toBe("healthy");
  });

  test("an UNTYPED record with an unknown provider stays unhealthy", async () => {
    // Guard the inverse: only typed credentials get the presence-healthy
    // treatment; an untyped record referencing a dead provider is still broken.
    const instance = "check-untyped-unknown";
    const config = configFor(instance);
    await mutateState(instance, (state) => {
      state.connectors.push(newConnector({
        id: "id_untyped_unknown",
        instance,
        name: "Legacy",
        provider: "not-a-registered-module",
        type: undefined,
        status: "configured",
        health: "unknown",
        secretRefs: []
      }));
    });
    const probed = await checkConnector(config, "id_untyped_unknown");
    expect(probed.health).toBe("unhealthy");
  });
});

// Section A: connectorIsUsable export tests
describe("connectorIsUsable", () => {
  test("configured + healthy → usable", () => {
    expect(connectorIsUsable(newConnector({ status: "configured", health: "healthy", provider: "linear" }))).toBe(true);
  });

  test("configured + unhealthy → not usable", () => {
    expect(connectorIsUsable(newConnector({ status: "configured", health: "unhealthy", provider: "linear" }))).toBe(false);
  });

  test("configured + unknown with probe → not usable", () => {
    // Linear has a probe.
    expect(connectorIsUsable(newConnector({ status: "configured", health: "unknown", provider: "linear" }))).toBe(false);
  });

  test("configured + unknown without probe → usable", () => {
    // Demo has no probe.
    expect(connectorIsUsable(newConnector({ status: "configured", health: "unknown", provider: "demo" }))).toBe(true);
  });

  test("disabled + healthy → not usable", () => {
    expect(connectorIsUsable(newConnector({ status: "disabled", health: "healthy", provider: "linear" }))).toBe(false);
  });
});

// Section C: probe on create/update
describe("createConnector probes for probe-having providers", () => {
  function configFor(instance: string): RuntimeConfig {
    return {
      instance,
      port: 0,
      token: "t",
      provider: { name: "echo" as const, model: "echo" },
      workspaceRoot: `${ROOT}/${instance}/workspace`,
      stateRoot: `${ROOT}/${instance}`,
      logRoot: `${ROOT}/${instance}/logs`
    };
  }

  test("probe-having provider (linear) returns settled health on create", async () => {
    const config = configFor("create-probe-linear");
    const connector = await createConnector(config, {
      name: "Linear",
      provider: "linear",
      secrets: { token: "fake_token" }
    });
    // Probe ran against a fake token, so health is settled (unhealthy).
    expect(connector.health).not.toBe("unknown");
    expect(connector.lastHealthAt).toBeDefined();
  });

  test("probe-less provider (demo) keeps presence-only health on create", async () => {
    const config = configFor("create-noprobe-demo");
    const connector = await createConnector(config, {
      name: "demo-test",
      provider: "demo"
    });
    // Demo has no probe; createConnector seeds health via updateConnectorHealth.
    expect(connector.health).toBe("healthy");
  });

  test("updateConnector probes after secret rotation for probe-having providers", async () => {
    const config = configFor("update-probe-rotate");
    // First create with demo (no probe) so we have a known connector id.
    await mutateState(config.instance, (state) => {
      state.connectors.push(newConnector({
        id: "id_update_probe",
        instance: config.instance,
        provider: "linear",
        type: "api-key",
        name: "LINEAR_API_KEY",
        status: "configured",
        health: "healthy",
        secretRefs: [{ purpose: "token", path: "secrets/id_update_probe.token.json" }]
      }));
    });
    writeSecret(config.instance, "id_update_probe", "token", "new_secret_value");
    const updated = await updateConnector(config, "id_update_probe", {
      secrets: { token: "rotated_token" }
    });
    // Probe ran (and failed with the test token); health is settled.
    expect(updated.health).not.toBe("unknown");
    expect(updated.lastHealthAt).toBeDefined();
  });
});

// Section D: markConnectorUnhealthyForProvider
describe("markConnectorUnhealthyForProvider", () => {
  test("marks the configured connector unhealthy and emits transition audit", async () => {
    const instance = "auth-fail-bridge";
    process.env.GINI_STATE_ROOT = ROOT;
    await mutateState(instance, (state) => {
      state.connectors.push(newConnector({
        id: "id_codex_d",
        instance,
        name: "codex",
        provider: "codex",
        status: "configured",
        health: "healthy"
      }));
    });
    await markConnectorUnhealthyForProvider(instance, "codex", "Token expired");
    const state = readState(instance);
    const conn = state.connectors.find((c) => c.id === "id_codex_d");
    expect(conn?.health).toBe("unhealthy");
    expect(conn?.message).toBe("Token expired");
    // Audit emits a connector.health.transition event.
    expect(state.audit.some((e) => e.action === "connector.health.transition" && e.target === "id_codex_d")).toBe(true);
  });

  test("does not emit a duplicate transition when already unhealthy", async () => {
    const instance = "auth-fail-bridge-dedup";
    process.env.GINI_STATE_ROOT = ROOT;
    await mutateState(instance, (state) => {
      state.connectors.push(newConnector({
        id: "id_codex_dup",
        instance,
        name: "codex",
        provider: "codex",
        status: "configured",
        health: "unhealthy",
        message: "already failed"
      }));
    });
    await markConnectorUnhealthyForProvider(instance, "codex", "Still expired");
    const state = readState(instance);
    const conn = state.connectors.find((c) => c.id === "id_codex_dup");
    expect(conn?.health).toBe("unhealthy");
    expect(conn?.message).toBe("Still expired");
    // No transition audit since health was already unhealthy.
    expect(state.audit.filter((e) => e.action === "connector.health.transition" && e.target === "id_codex_dup")).toHaveLength(0);
  });

  test("skips connectors for other providers", async () => {
    const instance = "auth-fail-bridge-other";
    process.env.GINI_STATE_ROOT = ROOT;
    await mutateState(instance, (state) => {
      state.connectors.push(newConnector({
        id: "id_linear_other",
        instance,
        name: "LINEAR_API_KEY",
        provider: "linear",
        status: "configured",
        health: "healthy"
      }));
    });
    await markConnectorUnhealthyForProvider(instance, "codex", "Token expired");
    const state = readState(instance);
    const conn = state.connectors.find((c) => c.id === "id_linear_other");
    expect(conn?.health).toBe("healthy");
  });
});

// Section F: claude-code/codex skill gating via credentialName
describe("isSkillActive gates codex/claude-code skills on connector state", () => {
  test("codex skill is active when a usable 'codex' connector exists", () => {
    const state = createEmptyState("skill-gate-codex");
    state.connectors = [newConnector({ name: "codex", provider: "codex", status: "configured", health: "healthy" })];
    const skill = newSkill({ requiredCredentials: ["codex"] });
    expect(isSkillActive(state, skill)).toBe(true);
  });

  test("codex skill is inactive when the codex connector is unhealthy", () => {
    const state = createEmptyState("skill-gate-codex-unhealthy");
    state.connectors = [newConnector({ name: "codex", provider: "codex", status: "configured", health: "unhealthy" })];
    const skill = newSkill({ requiredCredentials: ["codex"] });
    expect(isSkillActive(state, skill)).toBe(false);
  });

  test("codex skill is inactive when no connector exists", () => {
    const state = createEmptyState("skill-gate-codex-missing");
    state.connectors = [];
    const skill = newSkill({ requiredCredentials: ["codex"] });
    expect(isSkillActive(state, skill)).toBe(false);
  });

  test("claude-code skill is active when a usable 'claude-code' connector exists", () => {
    const state = createEmptyState("skill-gate-cc");
    state.connectors = [newConnector({ name: "claude-code", provider: "claude-code", status: "configured", health: "healthy" })];
    const skill = newSkill({ requiredCredentials: ["claude-code"] });
    expect(isSkillActive(state, skill)).toBe(true);
  });

  test("claude-code skill is inactive when connector is unhealthy", () => {
    const state = createEmptyState("skill-gate-cc-unhealthy");
    state.connectors = [newConnector({ name: "claude-code", provider: "claude-code", status: "configured", health: "unhealthy" })];
    const skill = newSkill({ requiredCredentials: ["claude-code"] });
    expect(isSkillActive(state, skill)).toBe(false);
  });

  test("bindingsForCredentials yields nothing for codex (presence-only, no type)", () => {
    const state = createEmptyState("bindings-codex");
    state.connectors = [newConnector({ name: "codex", provider: "codex", status: "configured", health: "healthy" })];
    const bindings = bindingsForCredentials(state, ["codex"]);
    expect(bindings).toEqual({});
  });
});

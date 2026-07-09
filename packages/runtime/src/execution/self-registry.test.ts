// Coverage for the self-config / introspection registry and its direct-tool
// dispatch surface.
//
// The registry (self-registry.ts) is the single source of truth for the
// self-config operation BEHAVIOR (handler + tag + audit). Each capability is
// exposed to the agent loop as a direct deferred tool whose NAME is the op
// name; dispatch routes the self tool cases through dispatchSelfOp. The
// dispatch-level tests exercise the route-by-tag logic (query sync, mutate
// gated-vs-auto) against a seeded RuntimeConfig + state, reusing the same
// fixture shape as tool-dispatch.test.ts. Args are passed at TOP LEVEL (no
// {name, args} envelope) — that is the contract this file pins.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChatSession, createTask, mutateState, readState, recordProviderAuthFailure, upsertTask } from "../state";
import type { GoogleAccountStatus, RuntimeConfig } from "../types";
import { dispatchToolCall } from "./tool-dispatch";
import { findSelfOperation, SELF_OPERATIONS, setGoogleAccountsStatusProvider } from "./self-registry";

const ROOT = mkdtempSync(join(tmpdir(), "gini-self-registry-"));
process.env.GINI_STATE_ROOT = ROOT;
process.env.GINI_LOG_ROOT = `${ROOT}/logs`;

function buildConfig(instance: string, approvalMode: RuntimeConfig["approvalMode"] = "auto"): RuntimeConfig {
  return {
    instance,
    port: 0,
    token: "t",
    provider: { name: "echo", model: "" },
    approvalMode,
    workspaceRoot: `${ROOT}/${instance}/workspace`,
    stateRoot: ROOT,
    logRoot: `${ROOT}/logs`
  };
}

async function newTask(config: RuntimeConfig): Promise<string> {
  const task = createTask(config.instance, "self-registry test");
  await mutateState(config.instance, (state) => {
    const session = createChatSession(state, "self-registry test session");
    task.chatSessionId = session.id;
    upsertTask(state, task);
  });
  return task.id;
}

describe("self operation registry", () => {
  test("SELF_OPERATIONS carries the 25 expected ops with name, summary, tag, handler", () => {
    expect(SELF_OPERATIONS.length).toBe(25);
    for (const op of SELF_OPERATIONS) {
      expect(typeof op.name).toBe("string");
      expect(op.name.length).toBeGreaterThan(0);
      expect(typeof op.summary).toBe("string");
      expect(op.summary.length).toBeGreaterThan(0);
      expect(["query", "mutate"]).toContain(op.tag);
      expect(typeof op.handler).toBe("function");
    }
    const names = SELF_OPERATIONS.map((op) => op.name).sort();
    expect(names).toEqual([
      "add_mcp_server",
      "create_agent",
      "delete_agent",
      "disable_toolset",
      "enable_toolset",
      "get_self",
      "list_agents",
      "list_connectors",
      "list_mcp_servers",
      "list_providers",
      "list_skills",
      "list_toolsets",
      "remove_connector",
      "remove_mcp_server",
      "remove_provider",
      "rename_agent",
      "rollback_skill",
      "rotate_connector",
      "set_approval_mode",
      "set_auto_approve_commands",
      "set_dangerous_patterns",
      "set_provider",
      "test_skill",
      "update_self",
      "use_agent"
    ]);
  });

  test("the query/mutate split matches the gating contract", () => {
    const queries = SELF_OPERATIONS.filter((op) => op.tag === "query").map((op) => op.name).sort();
    const mutates = SELF_OPERATIONS.filter((op) => op.tag === "mutate").map((op) => op.name).sort();
    expect(queries).toEqual([
      "get_self",
      "list_agents",
      "list_connectors",
      "list_mcp_servers",
      "list_providers",
      "list_skills",
      "list_toolsets"
    ]);
    expect(mutates).toEqual([
      "add_mcp_server",
      "create_agent",
      "delete_agent",
      "disable_toolset",
      "enable_toolset",
      "remove_connector",
      "remove_mcp_server",
      "remove_provider",
      "rename_agent",
      "rollback_skill",
      "rotate_connector",
      "set_approval_mode",
      "set_auto_approve_commands",
      "set_dangerous_patterns",
      "set_provider",
      "test_skill",
      "update_self",
      "use_agent"
    ]);
  });

  test("findSelfOperation resolves known names and rejects unknown ones", () => {
    expect(findSelfOperation("nope")).toBeUndefined();
    expect(findSelfOperation("get_self")).toBeDefined();
    expect(findSelfOperation("set_provider")?.tag).toBe("mutate");
  });

  test("test_skill is tagged mutate because it records a pass/fail counter on the skill", () => {
    expect(findSelfOperation("test_skill")?.tag).toBe("mutate");
  });
});

describe("direct self tools — query", () => {
  test("get_self resolves synchronously with the instance snapshot", async () => {
    const instance = `self-get-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    const result = await dispatchToolCall(config, taskId, "get_self", "call_1", "{}");
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result) as {
        ok: boolean;
        instance: string;
        approvalSettings: { approvalMode: string; autoApproveCommands: unknown[]; dangerousTerminalPatterns: unknown[] };
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.instance).toBe(instance);
      // get_self now exposes the full approval picture so the model can
      // read the allowlist before a replace via set_auto_approve_commands.
      expect(parsed.approvalSettings.approvalMode).toBe("auto");
      expect(Array.isArray(parsed.approvalSettings.autoApproveCommands)).toBe(true);
      expect(Array.isArray(parsed.approvalSettings.dangerousTerminalPatterns)).toBe(true);
    }
  });

  test("list_toolsets resolves synchronously with the instance toolsets", async () => {
    const instance = `self-toolsets-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    const result = await dispatchToolCall(config, taskId, "list_toolsets", "call_1", "{}");
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result) as { ok: boolean; toolsets: unknown[] };
      expect(parsed.ok).toBe(true);
      expect(Array.isArray(parsed.toolsets)).toBe(true);
    }
  });

  test("list_skills takes its filter args at top level (no {name,args} envelope)", async () => {
    const instance = `self-skills-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const skillDir = join(ROOT, instance, "skills", "scripted");
    mkdirSync(join(skillDir, "scripts"), { recursive: true });
    writeFileSync(join(skillDir, "scripts", "run.ts"), "console.log('{}')");
    await mutateState(config.instance, (state) => {
      state.skills.push({
        id: "skill_scripted",
        instance: config.instance,
        name: "scripted",
        description: "Scripted skill",
        trigger: "",
        steps: [],
        requiredTools: [],
        requiredPermissions: [],
        status: "enabled",
        version: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        tests: [],
        successCount: 0,
        failureCount: 0,
        previousVersions: [],
        body: "",
        source: "user",
        manifestPath: join(skillDir, "SKILL.md")
      });
    });
    const taskId = await newTask(config);
    // Top-level args, NOT nested under `args`.
    const result = await dispatchToolCall(
      config,
      taskId,
      "list_skills",
      "call_1",
      JSON.stringify({ status: "enabled" })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result) as { ok: boolean; skills: Array<{ name: string; scripts?: string[] }> };
      expect(parsed.ok).toBe(true);
      expect(Array.isArray(parsed.skills)).toBe(true);
      expect(parsed.skills.find((skill) => skill.name === "scripted")?.scripts).toEqual(["run"]);
    }
  });

  test("list_providers credits a custom apiKeyEnv for the active provider", async () => {
    const instance = `self-providers-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    // Active anthropic provider keyed on a custom env var (a Bedrock bearer),
    // exactly as the Settings catalog surface sees it. The agent-facing
    // list_providers op must thread apiKeyEnv so it agrees with Settings.
    config.provider = {
      name: "anthropic",
      model: "anthropic.claude-opus-4-8",
      baseUrl: "https://bedrock-mantle.us-east-1.api.aws/anthropic",
      apiKeyEnv: "BEDROCK_BEARER_TOKEN_SELFREG"
    };
    const prevCustom = process.env.BEDROCK_BEARER_TOKEN_SELFREG;
    const prevCanonical = process.env.ANTHROPIC_API_KEY;
    try {
      process.env.BEDROCK_BEARER_TOKEN_SELFREG = "bedrock-live";
      // Canonical unset so the custom-env credit is the only path to configured.
      delete process.env.ANTHROPIC_API_KEY;
      const taskId = await newTask(config);
      const result = await dispatchToolCall(config, taskId, "list_providers", "call_1", "{}");
      expect(result.kind).toBe("sync");
      if (result.kind === "sync") {
        const parsed = JSON.parse(result.result) as {
          ok: boolean;
          activeProvider: string;
          providers: Array<{ name: string; configured: boolean; isActive: boolean }>;
        };
        expect(parsed.ok).toBe(true);
        expect(parsed.activeProvider).toBe("anthropic");
        const anthropic = parsed.providers.find((p) => p.name === "anthropic");
        expect(anthropic?.configured).toBe(true);
        expect(anthropic?.isActive).toBe(true);
      }
    } finally {
      if (prevCustom === undefined) delete process.env.BEDROCK_BEARER_TOKEN_SELFREG;
      else process.env.BEDROCK_BEARER_TOKEN_SELFREG = prevCustom;
      if (prevCanonical === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevCanonical;
    }
  });

  test("list_providers carries authStatus and reauth so the agent sees needs-reauth state", async () => {
    // The agent participates in the needs-reauth clear lifecycle via
    // set_provider, so list_providers must expose the same authStatus/reauth
    // enrichment the HTTP catalog carries — `configured: true` alone is the
    // misleading presence-only signal issue #233 eliminates.
    const instance = `self-providers-reauth-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    await mutateState(config.instance, (state) => {
      recordProviderAuthFailure(state, { provider: "openai", detail: "token expired", taskId: "task_seed" });
    });
    const taskId = await newTask(config);
    const result = await dispatchToolCall(config, taskId, "list_providers", "call_1", "{}");
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result) as {
        ok: boolean;
        providers: Array<{
          name: string;
          authStatus?: string;
          reauth?: { detail: string; reauthKind: string; reauthUrl: string };
        }>;
      };
      expect(parsed.ok).toBe(true);
      const openai = parsed.providers.find((p) => p.name === "openai");
      expect(openai?.authStatus).toBe("needs_reauth");
      expect(openai?.reauth?.detail).toBe("token expired");
      expect(openai?.reauth?.reauthKind).toBe("settings");
      const echo = parsed.providers.find((p) => p.name === "echo");
      expect(echo?.authStatus).toBe("ok");
      expect(echo?.reauth).toBeUndefined();
    }
  });

  test("list_connectors surfaces per-account Google sign-in even with NO google connector record", async () => {
    // Google can be live on an instance whose state has no google-oauth-desktop
    // record (machine-global account registry / credentialExternallySatisfied).
    // The tool must still expose live per-account signedIn — it is the model's
    // only on-demand truth source (the system-prompt accounts block is
    // registration-only and directs the model here).
    const instance = `self-connectors-gacct-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    const account = (over: Partial<GoogleAccountStatus>): GoogleAccountStatus => ({
      id: "gacct_x",
      tag: "x",
      email: "x@example.com",
      configDir: "/home/u/.gini/google-accounts/gacct_x",
      addedAt: "2026-01-01T00:00:00.000Z",
      signedIn: false,
      tokenRevoked: false,
      services: {},
      message: "",
      ...over
    });
    const restore = setGoogleAccountsStatusProvider(async () => [
      account({ id: "gacct_p", tag: "personal", email: "me@gmail.com", signedIn: true, primary: true, message: "Signed in to Google" }),
      account({ id: "gacct_w", tag: "work", email: "me@work.com", signedIn: false, tokenRevoked: true, message: "Google sign-in expired — re-auth needed" })
    ]);
    try {
      const result = await dispatchToolCall(config, taskId, "list_connectors", "call_1", "{}");
      expect(result.kind).toBe("sync");
      if (result.kind === "sync") {
        const parsed = JSON.parse(result.result) as {
          ok: boolean;
          connectors: Array<{ provider: string }>;
          googleAccounts?: Array<{ tag: string; email: string | null; signedIn: boolean; tokenRevoked: boolean; primary: boolean; message: string }>;
        };
        expect(parsed.ok).toBe(true);
        // Precondition of this test: the seeded state carries no google record.
        expect(parsed.connectors.some((c) => c.provider === "google-oauth-desktop")).toBe(false);
        expect(parsed.googleAccounts).toEqual([
          { tag: "personal", email: "me@gmail.com", signedIn: true, tokenRevoked: false, primary: true, message: "Signed in to Google" },
          { tag: "work", email: "me@work.com", signedIn: false, tokenRevoked: true, primary: false, message: "Google sign-in expired — re-auth needed" }
        ]);
      }
    } finally {
      restore();
    }
  });

  test("list_connectors omits googleAccounts when the account registry is empty", async () => {
    const instance = `self-connectors-noacct-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance);
    const taskId = await newTask(config);
    const restore = setGoogleAccountsStatusProvider(async () => []);
    try {
      const result = await dispatchToolCall(config, taskId, "list_connectors", "call_1", "{}");
      expect(result.kind).toBe("sync");
      if (result.kind === "sync") {
        const parsed = JSON.parse(result.result) as { ok: boolean; googleAccounts?: unknown };
        expect(parsed.ok).toBe(true);
        expect(parsed.googleAccounts).toBeUndefined();
      }
    } finally {
      restore();
    }
  });
});

describe("direct self tools — mutate", () => {
  test("create_agent gates as pending in strict mode with payload.opName set", async () => {
    const instance = `self-create-strict-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance, "strict");
    const taskId = await newTask(config);
    // Args at top level — the direct tool's name IS the op name.
    const result = await dispatchToolCall(
      config,
      taskId,
      "create_agent",
      "call_1",
      JSON.stringify({ name: "Athena" })
    );
    expect(result.kind).toBe("pending");
    if (result.kind === "pending") {
      const state = readState(instance);
      const approval = state.authorizations.find((a) => a.id === result.approvalId);
      expect(approval).toBeDefined();
      expect(approval?.action).toBe("self.config");
      expect(approval?.status).toBe("pending");
      // The approval payload carries the op name + top-level args, so the
      // executeApprovedAction self.config branch re-runs the right handler.
      expect(approval?.payload.opName).toBe("create_agent");
      const payloadArgs = approval?.payload.args as Record<string, unknown> | undefined;
      expect(payloadArgs?.name).toBe("Athena");
    }
  });

  test("create_agent auto-resolves in auto mode and lands the side effect", async () => {
    const instance = `self-create-auto-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance, "auto");
    const taskId = await newTask(config);
    const result = await dispatchToolCall(
      config,
      taskId,
      "create_agent",
      "call_1",
      JSON.stringify({ name: "Athena" })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result) as { ok: boolean; agent?: { name: string } };
      expect(parsed.ok).toBe(true);
      expect(parsed.agent?.name).toBe("Athena");
    }
    const state = readState(instance);
    expect(state.agents.some((a) => a.name === "Athena")).toBe(true);
  });

  test("set_provider gates as pending in strict mode and carries top-level args in the payload", async () => {
    const instance = `self-setprov-strict-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance, "strict");
    const taskId = await newTask(config);
    const result = await dispatchToolCall(
      config,
      taskId,
      "set_provider",
      "call_1",
      JSON.stringify({ provider: "echo" })
    );
    expect(result.kind).toBe("pending");
    if (result.kind === "pending") {
      const state = readState(instance);
      const approval = state.authorizations.find((a) => a.id === result.approvalId);
      expect(approval?.action).toBe("self.config");
      expect(approval?.payload.opName).toBe("set_provider");
      const payloadArgs = approval?.payload.args as Record<string, unknown> | undefined;
      expect(payloadArgs?.provider).toBe("echo");
    }
  });

  test("set_provider supports bedrock + awsRegion and ignores a model-supplied baseUrl", async () => {
    const instance = `self-setprov-bedrock-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance, "auto");
    const taskId = await newTask(config);
    const prevAk = process.env.AWS_ACCESS_KEY_ID;
    const prevSk = process.env.AWS_SECRET_ACCESS_KEY;
    process.env.AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
    process.env.AWS_SECRET_ACCESS_KEY = "secret";
    try {
      const result = await dispatchToolCall(
        config,
        taskId,
        "set_provider",
        "call_1",
        JSON.stringify({ provider: "bedrock", model: "us.amazon.nova-pro-v1:0", awsRegion: "us-west-2", baseUrl: "https://evil.example/v1" })
      );
      expect(result.kind).toBe("sync");
      expect(config.provider.name).toBe("bedrock");
      expect(config.provider.awsRegion).toBe("us-west-2");
      // The model-supplied baseUrl is NOT honored (key-exfil guard); the host is
      // derived from the region instead.
      expect(config.provider.baseUrl).toBe("https://bedrock-runtime.us-west-2.amazonaws.com");
    } finally {
      if (prevAk === undefined) delete process.env.AWS_ACCESS_KEY_ID; else process.env.AWS_ACCESS_KEY_ID = prevAk;
      if (prevSk === undefined) delete process.env.AWS_SECRET_ACCESS_KEY; else process.env.AWS_SECRET_ACCESS_KEY = prevSk;
    }
  });

  test("set_provider with an omitted provider does NOT repoint the active anthropic endpoint (key-exfil guard)", async () => {
    const instance = `self-setprov-anthropic-guard-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance, "auto");
    // Make anthropic the ACTIVE provider with its first-party endpoint + key.
    config.provider = { name: "anthropic", model: "claude-opus-4-8", baseUrl: "https://api.anthropic.com", apiKeyEnv: "ANTHROPIC_API_KEY" };
    const taskId = await newTask(config);
    const prevKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    try {
      // A prompt-injected model omits `provider` (so the ACTIVE anthropic is
      // patched, not switched) and tries to repoint baseUrl at an attacker host.
      const result = await dispatchToolCall(
        config,
        taskId,
        "set_provider",
        "call_1",
        JSON.stringify({ baseUrl: "https://evil.example/v1" })
      );
      expect(result.kind).toBe("sync");
      expect(config.provider.name).toBe("anthropic");
      // The endpoint stays first-party — the model-supplied baseUrl is dropped,
      // so the next anthropic call can't send x-api-key to the attacker host.
      expect(config.provider.baseUrl).toBe("https://api.anthropic.com");
    } finally {
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevKey;
    }
  });

  test("auto-resolving a self.config op scrubs secret args from the resolved approval payload", async () => {
    const instance = `self-scrub-payload-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance, "auto");
    const taskId = await newTask(config);
    const result = await dispatchToolCall(
      config,
      taskId,
      "set_provider",
      "call_1",
      JSON.stringify({ provider: "echo", apiKey: "sk-super-secret" })
    );
    expect(result.kind).toBe("sync");
    // The handler ran on approval (the real apiKey reached setSetupProvider),
    // but the now-resolved authorization row served to clients must not retain
    // the credential — executeApprovedAction redacts payload.args after the run.
    const state = readState(instance);
    const approval = state.authorizations.find(
      (a) => a.action === "self.config" && (a.payload.opName as string) === "set_provider"
    );
    expect(approval).toBeDefined();
    const payloadArgs = approval?.payload.args as Record<string, unknown> | undefined;
    expect(payloadArgs?.apiKey).toBe("[redacted]");
    // Non-secret args still survive so the historical row stays legible.
    expect(payloadArgs?.provider).toBe("echo");
  });

  test("set_provider routes azure transport fields through dispatch onto the live config", async () => {
    const instance = `self-setprov-azure-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance, "auto");
    const taskId = await newTask(config);
    const prevKey = process.env.AZURE_OPENAI_API_KEY;
    // Pre-set the env var so setSetupProvider accepts a keyless edit (no
    // secrets.env write, no plist refresh) and we exercise only the routing
    // forwarding done by the set_provider self-tool (baseUrl/apiVersion/
    // deployment/authScheme present-clears mapping).
    process.env.AZURE_OPENAI_API_KEY = "az-test";
    try {
      const result = await dispatchToolCall(
        config,
        taskId,
        "set_provider",
        "call_1",
        JSON.stringify({
          provider: "azure",
          model: "gpt-5.5",
          baseUrl: "https://r.openai.azure.com",
          apiVersion: "2024-10-21",
          deployment: "gpt-5.5-deploy",
          authScheme: "api-key"
        })
      );
      expect(result.kind).toBe("sync");
      // The side effect lands on the live config object.
      expect(config.provider.name).toBe("azure");
      expect(config.provider.baseUrl).toBe("https://r.openai.azure.com");
      expect(config.provider.apiVersion).toBe("2024-10-21");
      expect(config.provider.deployment).toBe("gpt-5.5-deploy");
      expect(config.provider.authScheme).toBe("api-key");
    } finally {
      if (prevKey === undefined) delete process.env.AZURE_OPENAI_API_KEY;
      else process.env.AZURE_OPENAI_API_KEY = prevKey;
    }
  });

  test("a model-only set_provider patch does not clear the provider's needs-reauth record", async () => {
    const instance = `self-setprov-keyless-keep-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance, "auto");
    const taskId = await newTask(config);
    const prevKey = process.env.OPENAI_API_KEY;
    // The dead key sits in process.env, so the keyless patch passes
    // setSetupProvider's env-already-set gate without touching the credential.
    process.env.OPENAI_API_KEY = "sk-dead";
    try {
      await mutateState(config.instance, (state) => {
        recordProviderAuthFailure(state, { provider: "openai", detail: "token expired", taskId: "task_seed" });
      });
      const result = await dispatchToolCall(
        config,
        taskId,
        "set_provider",
        "call_1",
        JSON.stringify({ provider: "openai", model: "gpt-5.4-mini" })
      );
      expect(result.kind).toBe("sync");
      // "Switch to <model>" proves nothing about the credential: the record
      // (and the amber Settings row it drives) must survive, and no clear may
      // be audited — otherwise the row flips back to a stale "Connected".
      const state = readState(config.instance);
      expect(state.providerAuthFailures?.openai).toBeDefined();
      expect(state.audit.some((a) => a.action === "provider.auth.cleared" && a.target === "openai")).toBe(false);
    } finally {
      if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevKey;
    }
  });

  test("a set_provider write carrying an apiKey clears the provider's needs-reauth record", async () => {
    const instance = `self-setprov-key-clears-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance, "auto");
    const taskId = await newTask(config);
    const prevKey = process.env.OPENAI_API_KEY;
    const prevHome = process.env.HOME;
    const prevSkipRefresh = process.env.GINI_SKIP_PLIST_REFRESH;
    // The supplied apiKey routes through writeKeyToSecretsEnv, which resolves
    // ~/.gini/secrets.env via process.env.HOME — point HOME at a scratch dir
    // so the write never touches the real file, and skip the plist refresh so
    // the key-carrying path can't signal the developer's running gateway.
    const home = join(ROOT, `home-${instance}`);
    mkdirSync(home, { recursive: true });
    process.env.HOME = home;
    process.env.GINI_SKIP_PLIST_REFRESH = "1";
    try {
      await mutateState(config.instance, (state) => {
        recordProviderAuthFailure(state, { provider: "openai", detail: "token expired", taskId: "task_seed" });
      });
      const result = await dispatchToolCall(
        config,
        taskId,
        "set_provider",
        "call_1",
        JSON.stringify({ provider: "openai", model: "gpt-5.4-mini", apiKey: "sk-rotated" })
      );
      expect(result.kind).toBe("sync");
      // The env-keyed write landed in the sandboxed home, not the real one.
      expect(readFileSync(join(home, ".gini", "secrets.env"), "utf8")).toContain("sk-rotated");
      // A supplied key is a credential re-establishment — the documented
      // clear seam — so the record drops and the clear is audited.
      const state = readState(config.instance);
      expect(state.providerAuthFailures?.openai).toBeUndefined();
      expect(state.audit.some((a) => a.action === "provider.auth.cleared" && a.target === "openai")).toBe(true);
    } finally {
      if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevKey;
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevSkipRefresh === undefined) delete process.env.GINI_SKIP_PLIST_REFRESH;
      else process.env.GINI_SKIP_PLIST_REFRESH = prevSkipRefresh;
    }
  });

  test("set_approval_mode auto-resolves in auto mode and lands the side effect on config", async () => {
    const instance = `self-approval-auto-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance, "auto");
    const taskId = await newTask(config);
    const result = await dispatchToolCall(
      config,
      taskId,
      "set_approval_mode",
      "call_1",
      JSON.stringify({ mode: "yolo" })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result) as { ok: boolean; approvalMode?: string };
      expect(parsed.ok).toBe(true);
      expect(parsed.approvalMode).toBe("yolo");
    }
    // updateAutoApproveSettings mutates the live config object in-process.
    expect(config.approvalMode).toBe("yolo");
  });

  test("set_approval_mode rejects an invalid mode without throwing", async () => {
    const instance = `self-approval-bad-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance, "auto");
    const taskId = await newTask(config);
    const result = await dispatchToolCall(
      config,
      taskId,
      "set_approval_mode",
      "call_1",
      JSON.stringify({ mode: "nope" })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result) as { ok: boolean };
      expect(parsed.ok).toBe(false);
    }
    // The bad call left the config's mode untouched.
    expect(config.approvalMode).toBe("auto");
  });

  test("disable_toolset auto-resolves in auto mode and flips the toolset status", async () => {
    const instance = `self-toolset-auto-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance, "auto");
    const taskId = await newTask(config);
    const result = await dispatchToolCall(
      config,
      taskId,
      "disable_toolset",
      "call_1",
      JSON.stringify({ toolset: "browser" })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result) as { ok: boolean; status?: string };
      expect(parsed.ok).toBe(true);
      expect(parsed.status).toBe("disabled");
    }
    const state = readState(instance);
    expect(state.toolsets.find((t) => t.name === "browser")?.status).toBe("disabled");
  });

  test("disable_toolset gates as pending in strict mode with payload.opName set", async () => {
    const instance = `self-toolset-strict-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance, "strict");
    const taskId = await newTask(config);
    const result = await dispatchToolCall(
      config,
      taskId,
      "disable_toolset",
      "call_1",
      JSON.stringify({ toolset: "browser" })
    );
    expect(result.kind).toBe("pending");
    if (result.kind === "pending") {
      const state = readState(instance);
      const approval = state.authorizations.find((a) => a.id === result.approvalId);
      expect(approval?.action).toBe("self.config");
      expect(approval?.payload.opName).toBe("disable_toolset");
    }
  });

  test("set_auto_approve_commands replaces the allowlist in auto mode", async () => {
    const instance = `self-allowlist-auto-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance, "auto");
    const taskId = await newTask(config);
    const result = await dispatchToolCall(
      config,
      taskId,
      "set_auto_approve_commands",
      "call_1",
      JSON.stringify({ patterns: ["git status", "ls"] })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result) as { ok: boolean; autoApproveCommands?: string[] };
      expect(parsed.ok).toBe(true);
      expect(parsed.autoApproveCommands).toEqual(["git status", "ls"]);
    }
    // updateAutoApproveSettings mutates the live config object in-process.
    expect(config.autoApproveCommands).toEqual(["git status", "ls"]);
  });

  test("set_auto_approve_commands rejects a non-array 'patterns' without throwing", async () => {
    const instance = `self-allowlist-bad-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance, "auto");
    const taskId = await newTask(config);
    const result = await dispatchToolCall(
      config,
      taskId,
      "set_auto_approve_commands",
      "call_1",
      JSON.stringify({ patterns: "git " })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result) as { ok: boolean };
      expect(parsed.ok).toBe(false);
    }
    expect(config.autoApproveCommands).toBeUndefined();
  });

  test("set_auto_approve_commands rejects non-string elements without wiping the saved list", async () => {
    const instance = `self-allowlist-nonstring-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance, "auto");
    config.autoApproveCommands = ["git status"];
    const taskId = await newTask(config);
    const result = await dispatchToolCall(
      config,
      taskId,
      "set_auto_approve_commands",
      "call_1",
      JSON.stringify({ patterns: [123] })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result) as { ok: boolean };
      expect(parsed.ok).toBe(false);
    }
    // The setter was never called, so the saved allowlist is untouched —
    // a [123] payload must NOT silently overwrite it with an empty list.
    expect(config.autoApproveCommands).toEqual(["git status"]);
  });

  test("set_dangerous_patterns rejects non-string elements without wiping the saved list", async () => {
    const instance = `self-danger-nonstring-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance, "auto");
    config.dangerousTerminalPatterns = ["rm -rf"];
    const taskId = await newTask(config);
    const result = await dispatchToolCall(
      config,
      taskId,
      "set_dangerous_patterns",
      "call_1",
      JSON.stringify({ patterns: [123] })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result) as { ok: boolean };
      expect(parsed.ok).toBe(false);
    }
    expect(config.dangerousTerminalPatterns).toEqual(["rm -rf"]);
  });

  test("rotate_connector rejects a supplied purpose that doesn't exist on the connector", async () => {
    const instance = `self-rotate-badpurpose-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance, "auto");
    const taskId = await newTask(config);
    // Seed a connector with a single secret slot named "token". The handler
    // checks the supplied purpose against the connector's secretRefs BEFORE
    // calling updateConnector, so it never reaches the secret-write path.
    await mutateState(instance, (state) => {
      state.connectors.push({
        id: "conn_rotate_1",
        instance,
        name: "rotate-test",
        provider: "generic",
        status: "configured",
        scopes: [],
        secretRefs: [{ purpose: "token", path: "conn_rotate_1/token" }],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        health: "unknown",
        source: "user"
      });
    });
    const result = await dispatchToolCall(
      config,
      taskId,
      "rotate_connector",
      "call_1",
      JSON.stringify({ connector: "conn_rotate_1", token: "new-secret", purpose: "ghost" })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result) as { ok: boolean; error?: string };
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain("ghost");
    }
    // The bogus purpose did NOT get appended as a new secret slot.
    const after = readState(instance).connectors.find((c) => c.id === "conn_rotate_1");
    expect(after?.secretRefs.map((r) => r.purpose)).toEqual(["token"]);
  });

  test("test_skill routes through the seam and reports a missing skill as {ok:false}", async () => {
    const instance = `self-testskill-${Math.random().toString(36).slice(2, 8)}`;
    const config = buildConfig(instance, "auto");
    const taskId = await newTask(config);
    const result = await dispatchToolCall(
      config,
      taskId,
      "test_skill",
      "call_1",
      JSON.stringify({ skillId: "does_not_exist" })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      const parsed = JSON.parse(result.result) as { ok: boolean };
      expect(parsed.ok).toBe(false);
    }
  });
});

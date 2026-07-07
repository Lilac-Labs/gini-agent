// Unit tests for resolveEffectiveContext. The bundle is purely functional —
// it takes a RuntimeState + RuntimeConfig and returns an EffectiveContext —
// so these tests build state in memory without touching disk.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { resolveEffectiveContext, providerOverrideForRuntime } from "./effective-context";
import type {
  AgentRecord,
  MessagingBridgeRecord,
  ProviderConfig,
  RuntimeConfig,
  RuntimeState,
  ToolsetRecord
} from "../types";

function buildAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent_default",
    instance: "test",
    name: "default",
    status: "active",
    providerName: undefined,
    model: undefined,
    toolsets: [],
    messagingTargets: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function buildToolset(name: string, status: ToolsetRecord["status"] = "enabled"): ToolsetRecord {
  return {
    id: `toolset_${name}`,
    instance: "test",
    name,
    description: "",
    status,
    toolNames: [],
    scopes: ["task"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function buildBridge(name: string, deliveryTargets: string[]): MessagingBridgeRecord {
  return {
    id: `bridge_${name}`,
    instance: "test",
    name,
    kind: "demo",
    status: "configured",
    deliveryTargets,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function buildState(overrides: Partial<RuntimeState> = {}): RuntimeState {
  const base: RuntimeState = {
    version: 1,
    instance: "test",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    tasks: [],
    authorizations: [], setupRequests: [],
    audit: [],
    skills: [],
    jobs: [],
    connectors: [],
    improvements: [],
    skillOutcomes: [],
    learningFindings: [],
    promotions: [],
    snapshots: [],
    tools: [],
    toolsets: [],
    subagents: [],
    mcpServers: [],
    messagingBridges: [],
    importReports: [],
    agents: [],
    activeAgentId: undefined,
    relays: [],
    notifications: [],
    emailWatchers: [],
    events: [],
    jobRuns: [],
    chatSessions: [],
    chatMessages: [],
    messagingMessages: [],
    runs: [],
    planSteps: [], usageLedger: []
  };
  return { ...base, ...overrides };
}

// Provider credential env vars that could let a provider read as "configured"
// and so trip the transient dispatch fallback during a pure resolution check.
const FALLBACK_TRIGGER_ENV = [
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "DEEPSEEK_API_KEY",
  "GINI_LOCAL_API_KEY",
  "MY_LOCAL_KEY",
  "ANTHROPIC_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY"
];

// Scrub every provider credential (and ambient codex/AWS resolution), then set
// the requested keys, so a resolution test sees ONLY the pinned provider as
// configured — no surprise fallback from an ambient ~/.codex/auth.json or a
// shell-exported provider key. Returns a restore() that reverts every change.
function stubProviderEnv(set: Record<string, string>): () => void {
  const names = new Set([...FALLBACK_TRIGGER_ENV, "CODEX_AUTH_JSON", "AWS_SHARED_CREDENTIALS_FILE", "AWS_PROFILE", ...Object.keys(set)]);
  const saved: Record<string, string | undefined> = {};
  for (const name of names) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  process.env.CODEX_AUTH_JSON = "/nonexistent/gini-effective-resolution/auth.json";
  process.env.AWS_SHARED_CREDENTIALS_FILE = "/nonexistent/gini-effective-resolution/credentials";
  for (const [name, value] of Object.entries(set)) process.env[name] = value;
  return () => {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  };
}

function buildConfig(provider: ProviderConfig = { name: "echo", model: "gini-echo-v0" }): RuntimeConfig {
  return {
    instance: "test",
    port: 7338,
    token: "test",
    provider,
    workspaceRoot: "/tmp/effective-context-ws",
    stateRoot: "/tmp/effective-context-state",
    logRoot: "/tmp/effective-context-logs"
  };
}

describe("resolveEffectiveContext", () => {
  test("falls back to instance provider when no active agent", () => {
    const state = buildState();
    const config = buildConfig({ name: "codex", model: "gpt-5.5" });
    const ctx = resolveEffectiveContext(state, config);
    expect(ctx.providerSource).toBe("instance");
    expect(ctx.provider).toBe(config.provider);
    expect(ctx.toolsetFilter).toBeUndefined();
    expect(ctx.messagingTargetFilter).toBeUndefined();
    expect(ctx.warnings).toEqual([]);
    expect(ctx.agentId).toBeUndefined();
  });

  test("agent provider override wins when both providerName and model are set", () => {
    // The pinned provider is configured, so resolution returns it verbatim with
    // no dispatch fallback (the fallback only kicks in for an UNCONFIGURED pin).
    const restore = stubProviderEnv({ OPENAI_API_KEY: "sk-key" });
    try {
      const agent = buildAgent({ providerName: "openai", model: "gpt-5.4" });
      const state = buildState({ agents: [agent], activeAgentId: agent.id });
      const config = buildConfig({ name: "codex", model: "gpt-5.5" });
      const ctx = resolveEffectiveContext(state, config);
      expect(ctx.providerSource).toBe("agent");
      expect(ctx.provider.name).toBe("openai");
      expect(ctx.provider.model).toBe("gpt-5.4");
      expect(ctx.providerFallback).toBeUndefined();
      expect(ctx.agentId).toBe(agent.id);
    } finally {
      restore();
    }
  });

  test("cross-provider agent override does not inherit instance baseUrl/apiKeyEnv", () => {
    // Pre-fix, an agent with providerName=\"openrouter\" running on an
    // instance configured for OpenAI would carry OpenAI's baseUrl
    // (\"https://api.openai.com/v1\") and apiKeyEnv (\"OPENAI_API_KEY\")
    // because the resolver spread config.provider unconditionally.
    // The migrated agent then POSTs to the wrong endpoint with the
    // wrong key — a silent correctness bug for anyone importing
    // openclaw agents that don't match their gini instance's provider.
    const restore = stubProviderEnv({ OPENROUTER_API_KEY: "or-key" });
    try {
      const agent = buildAgent({ providerName: "openrouter", model: "openai/gpt-4o" });
      const state = buildState({ agents: [agent], activeAgentId: agent.id });
      const config = buildConfig({
        name: "openai",
        model: "gpt-5.4-mini",
        baseUrl: "https://api.openai.com/v1",
        apiKeyEnv: "OPENAI_API_KEY"
      });
      const ctx = resolveEffectiveContext(state, config);
      expect(ctx.provider.name).toBe("openrouter");
      expect(ctx.provider.baseUrl).toBe("https://openrouter.ai/api/v1");
      expect(ctx.provider.apiKeyEnv).toBe("OPENROUTER_API_KEY");
    } finally {
      restore();
    }
  });

  test("same-provider agent override still inherits instance baseUrl/apiKeyEnv", () => {
    // An operator pointing the instance at an OpenAI-compatible local
    // server still wants their per-agent overrides (model only) to use
    // the same endpoint. Only cross-provider overrides should drop the
    // inheritance.
    // The same-provider override inherits the instance's custom apiKeyEnv
    // (MY_LOCAL_KEY); set it so the resolved provider is configured and no
    // dispatch fallback fires over this resolution check.
    const restore = stubProviderEnv({ MY_LOCAL_KEY: "local-key" });
    try {
      const agent = buildAgent({ providerName: "openai", model: "gpt-5.4-mini" });
      const state = buildState({ agents: [agent], activeAgentId: agent.id });
      const config = buildConfig({
        name: "openai",
        model: "gpt-5.4",
        baseUrl: "http://localhost:8000/v1",
        apiKeyEnv: "MY_LOCAL_KEY"
      });
      const ctx = resolveEffectiveContext(state, config);
      expect(ctx.provider.name).toBe("openai");
      expect(ctx.provider.model).toBe("gpt-5.4-mini");
      expect(ctx.provider.baseUrl).toBe("http://localhost:8000/v1");
      expect(ctx.provider.apiKeyEnv).toBe("MY_LOCAL_KEY");
    } finally {
      restore();
    }
  });

  test("agent without providerName falls back to instance provider", () => {
    const agent = buildAgent({ providerName: undefined, model: undefined });
    const state = buildState({ agents: [agent], activeAgentId: agent.id });
    const config = buildConfig({ name: "codex", model: "gpt-5.5" });
    const ctx = resolveEffectiveContext(state, config);
    expect(ctx.providerSource).toBe("instance");
    expect(ctx.provider).toBe(config.provider);
  });

  test("agent toolset whitelist intersects with state, warns on unknown", () => {
    const agent = buildAgent({ toolsets: ["file", "unknown_toolset"] });
    const state = buildState({
      agents: [agent],
      activeAgentId: agent.id,
      toolsets: [buildToolset("file"), buildToolset("terminal")]
    });
    const ctx = resolveEffectiveContext(state, buildConfig());
    expect(ctx.toolsetFilter).toBeDefined();
    expect(ctx.toolsetFilter?.has("file")).toBe(true);
    // Unknown IDs stay in the filter so a later toolset add transparently
    // takes effect.
    expect(ctx.toolsetFilter?.has("unknown_toolset")).toBe(true);
    expect(ctx.warnings).toContain("agent references unknown toolset 'unknown_toolset'");
  });

  test("agent toolset whitelist warns on disabled", () => {
    const agent = buildAgent({ toolsets: ["mcp"] });
    const state = buildState({
      agents: [agent],
      activeAgentId: agent.id,
      toolsets: [buildToolset("mcp", "disabled")]
    });
    const ctx = resolveEffectiveContext(state, buildConfig());
    expect(ctx.toolsetFilter?.has("mcp")).toBe(true);
    expect(ctx.warnings).toContain("agent references disabled toolset 'mcp'");
  });

  test("messaging target whitelist warns on unknown target", () => {
    const agent = buildAgent({ messagingTargets: ["local", "slack"] });
    const state = buildState({
      agents: [agent],
      activeAgentId: agent.id,
      messagingBridges: [buildBridge("demo", ["local"])]
    });
    const ctx = resolveEffectiveContext(state, buildConfig());
    expect(ctx.messagingTargetFilter?.has("local")).toBe(true);
    expect(ctx.messagingTargetFilter?.has("slack")).toBe(true);
    expect(ctx.warnings).toContain("agent references unknown messaging target 'slack'");
    // Known target should not surface a warning.
    expect(ctx.warnings).not.toContain("agent references unknown messaging target 'local'");
  });

  test("no warnings when agent fields all resolve cleanly", () => {
    const agent = buildAgent({
      providerName: "openai",
      model: "gpt-5.4",
      toolsets: ["file"],
      messagingTargets: ["local"]
    });
    const state = buildState({
      agents: [agent],
      activeAgentId: agent.id,
      toolsets: [buildToolset("file")],
      messagingBridges: [buildBridge("demo", ["local"])]
    });
    const ctx = resolveEffectiveContext(state, buildConfig());
    expect(ctx.warnings).toEqual([]);
    expect(ctx.providerSource).toBe("agent");
  });
});

// Transient dispatch fallback: when the resolved provider (instance OR
// agent-pinned) is unconfigured but another real provider is, the bundle's
// `provider` is swapped for the fallback and `providerFallback` records the
// selected→using pair. config.provider is never touched.
describe("resolveEffectiveContext (transient dispatch fallback)", () => {
  const PROVIDER_ENV_VARS = [
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "DEEPSEEK_API_KEY",
    "GINI_LOCAL_API_KEY",
    "ANTHROPIC_API_KEY",
    "AZURE_OPENAI_API_KEY",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY"
  ];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const name of [...PROVIDER_ENV_VARS, "CODEX_AUTH_JSON", "AWS_SHARED_CREDENTIALS_FILE", "AWS_PROFILE"]) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
    // Keep ambient codex/AWS creds from leaking into the "nothing configured"
    // baseline these tests rely on.
    process.env.CODEX_AUTH_JSON = "/nonexistent/gini-effective-fallback/auth.json";
    process.env.AWS_SHARED_CREDENTIALS_FILE = "/nonexistent/gini-effective-fallback/credentials";
  });
  afterEach(() => {
    for (const name of Object.keys(saved)) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  test("instance branch: unconfigured instance provider + configured fallback → swaps and records the pair", () => {
    process.env.DEEPSEEK_API_KEY = "ds-key";
    const state = buildState();
    const config = buildConfig({ name: "bedrock", model: "us.amazon.nova-pro-v1:0" });
    const ctx = resolveEffectiveContext(state, config);
    expect(ctx.providerSource).toBe("instance");
    expect(ctx.provider.name).toBe("deepseek");
    expect(ctx.providerFallback).toEqual({ selected: "bedrock", using: "deepseek" });
    // config.provider is untouched — the fallback is transient.
    expect(config.provider.name).toBe("bedrock");
  });

  test("agent-pinned branch: agent pinned to an unconfigured provider falls back too", () => {
    process.env.DEEPSEEK_API_KEY = "ds-key";
    const agent = buildAgent({ providerName: "bedrock", model: "us.amazon.nova-pro-v1:0" });
    const state = buildState({ agents: [agent], activeAgentId: agent.id });
    const config = buildConfig({ name: "openai", model: "gpt-5.4-mini" });
    const ctx = resolveEffectiveContext(state, config);
    expect(ctx.provider.name).toBe("deepseek");
    expect(ctx.providerFallback).toEqual({ selected: "bedrock", using: "deepseek" });
  });

  test("no swap when the resolved provider is configured", () => {
    process.env.OPENAI_API_KEY = "sk-key";
    const state = buildState();
    const config = buildConfig({ name: "openai", model: "gpt-5.4-mini" });
    const ctx = resolveEffectiveContext(state, config);
    expect(ctx.provider).toBe(config.provider);
    expect(ctx.providerFallback).toBeUndefined();
  });

  test("no swap when nothing is configured (genuinely unconfigured → /setup still applies)", () => {
    const state = buildState();
    const config = buildConfig({ name: "bedrock", model: "us.amazon.nova-pro-v1:0" });
    const ctx = resolveEffectiveContext(state, config);
    expect(ctx.provider).toBe(config.provider);
    expect(ctx.providerFallback).toBeUndefined();
  });
});

// providerOverrideForRuntime is the helper consumed by memory pipelines
// (retain/reflect/reinforce) so each pipeline doesn't repeat the state +
// effective + source dance. We exercise it against on-disk state to mirror
// the real call shape from those pipelines.
const OVERRIDE_ROOT = "/tmp/gini-provider-override-test";

beforeAll(() => {
  rmSync(OVERRIDE_ROOT, { recursive: true, force: true });
  mkdirSync(OVERRIDE_ROOT, { recursive: true });
  process.env.GINI_STATE_ROOT = OVERRIDE_ROOT;
  process.env.GINI_LOG_ROOT = `${OVERRIDE_ROOT}-logs`;
});

afterAll(() => {
  rmSync(OVERRIDE_ROOT, { recursive: true, force: true });
});

function writeStateFile(instance: string, state: RuntimeState): void {
  const dir = `${OVERRIDE_ROOT}/instances/${instance}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/state.json`, JSON.stringify(state, null, 2));
}

describe("providerOverrideForRuntime", () => {
  test("returns the agent's provider when source is agent", () => {
    const instance = "override-agent";
    const agent = buildAgent({
      id: "agent_default",
      providerName: "codex",
      model: "gpt-5.5"
    });
    writeStateFile(instance, buildState({
      instance,
      agents: [agent],
      activeAgentId: agent.id
    }));
    const config = buildConfig({ name: "echo", model: "gini-echo-v0" });
    config.instance = instance;
    const override = providerOverrideForRuntime(config);
    expect(override).toBeDefined();
    expect(override?.name).toBe("codex");
    expect(override?.model).toBe("gpt-5.5");
  });

  test("returns undefined when no active agent (instance source)", () => {
    const instance = "override-none";
    writeStateFile(instance, buildState({ instance }));
    const config = buildConfig({ name: "codex", model: "gpt-5.5" });
    config.instance = instance;
    expect(providerOverrideForRuntime(config)).toBeUndefined();
  });

  test("returns undefined when agent has no providerName/model (instance source)", () => {
    const instance = "override-partial";
    const agent = buildAgent({ id: "agent_default", providerName: undefined, model: undefined });
    writeStateFile(instance, buildState({
      instance,
      agents: [agent],
      activeAgentId: agent.id
    }));
    const config = buildConfig({ name: "codex", model: "gpt-5.5" });
    config.instance = instance;
    expect(providerOverrideForRuntime(config)).toBeUndefined();
  });
});

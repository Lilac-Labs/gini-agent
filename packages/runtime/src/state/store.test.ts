import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { createEmptyState, normalizeState, readState, writeState } from "./store";
import { createChatSession, createJob, createTopic } from "./records";
import { readSecret, writeSecret } from "./secrets";
import { bindingsForCredentials, resolveSkillEnv } from "../integrations/connectors";
import { instanceRoot, statePath } from "../paths";
import type { ConnectorRecord, RuntimeConfig, RuntimeState, SkillRecord } from "../types";

// Isolated state root so the test never touches ~/.gini.
const ROOT = "/tmp/gini-store-test";

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("normalizeState toolset/tool backfill", () => {
  test("adds missing default toolsets and tools by name", () => {
    const state = createEmptyState("test-instance");
    // Simulate an older instance whose state was written before the
    // browser toolset was added: drop those entries from both arrays.
    state.toolsets = state.toolsets.filter((ts) => ts.name !== "browser");
    state.tools = state.tools.filter((tool) => tool.toolset !== "browser");
    expect(state.toolsets.some((ts) => ts.name === "browser")).toBe(false);
    expect(state.tools.some((tool) => tool.toolset === "browser")).toBe(false);

    const normalized = normalizeState("test-instance", state);

    expect(normalized.toolsets.some((ts) => ts.name === "browser")).toBe(true);
    expect(normalized.tools.some((tool) => tool.name === "browser.navigate")).toBe(true);
    expect(normalized.tools.some((tool) => tool.name === "browser.click")).toBe(true);
  });

  test("does not duplicate existing toolsets", () => {
    const state = createEmptyState("test-instance-2");
    const beforeCount = state.toolsets.length;
    const beforeToolCount = state.tools.length;
    const normalized = normalizeState("test-instance-2", state);
    expect(normalized.toolsets.length).toBe(beforeCount);
    expect(normalized.tools.length).toBe(beforeToolCount);
  });

  test("preserves user-modified toolset rows when names already match", () => {
    const state = createEmptyState("test-instance-3");
    const fileToolset = state.toolsets.find((ts) => ts.name === "file");
    expect(fileToolset).toBeDefined();
    const customDescription = "custom user description";
    fileToolset!.description = customDescription;
    const normalized = normalizeState("test-instance-3", state);
    const after = normalized.toolsets.find((ts) => ts.name === "file");
    expect(after?.description).toBe(customDescription);
  });

  test("seeds toolsets when state.toolsets is missing entirely", () => {
    const partial = { instance: "test-instance-4" } as unknown as RuntimeState;
    const normalized = normalizeState("test-instance-4", partial);
    expect(Array.isArray(normalized.toolsets)).toBe(true);
    expect(normalized.toolsets.length).toBeGreaterThan(0);
    expect(normalized.toolsets.some((ts) => ts.name === "browser")).toBe(true);
  });

  test("unions new tool names into an existing toolset row and synthesizes matching tool rows", () => {
    // Simulate an older instance whose browser toolset row was written
    // when only the original 9 browser tools existed. The toolset row
    // exists; the new tool entries (vision, hover, drag, select_option,
    // wait_for, tabs, upload_file) are missing from both toolNames and
    // the tool rows. Mark the existing toolset as "enabled" so we can
    // verify the new tool rows come up "available" matching the
    // toolset's status.
    const state = createEmptyState("test-instance-5");
    const browser = state.toolsets.find((ts) => ts.name === "browser");
    expect(browser).toBeDefined();
    browser!.toolNames = [
      "browser.navigate",
      "browser.snapshot",
      "browser.click",
      "browser.type",
      "browser.press",
      "browser.scroll",
      "browser.back",
      "browser.console",
      "browser.close"
    ];
    browser!.status = "enabled";
    // Drop the newer tool rows so the backfill has something to do.
    const newerNames = new Set([
      "browser.vision",
      "browser.hover",
      "browser.drag",
      "browser.select_option",
      "browser.wait_for",
      "browser.tabs",
      "browser.upload_file"
    ]);
    state.tools = state.tools.filter(
      (tool) => tool.toolset !== "browser" || !newerNames.has(tool.name)
    );

    const normalized = normalizeState("test-instance-5", state);
    const after = normalized.toolsets.find((ts) => ts.name === "browser")!;
    // toolNames is now the full default set, in stable order (old names
    // first, new names appended).
    expect(after.toolNames.length).toBe(17);
    for (const name of newerNames) {
      expect(after.toolNames.includes(name)).toBe(true);
    }
    // Tool rows for each new name exist and inherit the toolset's
    // enabled→available status.
    for (const name of newerNames) {
      const row = normalized.tools.find((tool) => tool.name === name);
      expect(row).toBeDefined();
      expect(row!.toolset).toBe("browser");
      expect(row!.status).toBe("available");
    }
  });

  test("normalizes legacy intervalSeconds: 0 sentinel on cron-driven jobs to undefined", () => {
    // Earlier versions of the runtime stored `intervalSeconds: 0` on cron
    // jobs so the field stayed a `number`. After the type was made
    // optional, cron jobs carry no intervalSeconds at all. The normalizer
    // migrates legacy rows on load — interval jobs are left untouched.
    const state = createEmptyState("test-instance-cron-migrate");
    state.jobs = [
      // Legacy cron job: intervalSeconds: 0, cronExpression set.
      {
        id: "job_legacy_cron",
        instance: "test-instance-cron-migrate",
        name: "legacy cron",
        prompt: "x",
        intervalSeconds: 0,
        cronExpression: "0 9 * * *",
        cronTimezone: "UTC",
        status: "active",
        deliveryTargets: [],
        context: [],
        retryLimit: 0,
        timeoutSeconds: 600,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        nextRunAt: "2026-01-02T09:00:00.000Z",
        runCount: 0,
        missedRuns: 0,
        taskIds: [],
        runIds: []
      },
      // Legacy interval job: positive intervalSeconds, no cronExpression.
      {
        id: "job_legacy_interval",
        instance: "test-instance-cron-migrate",
        name: "legacy interval",
        prompt: "x",
        intervalSeconds: 60,
        status: "active",
        deliveryTargets: [],
        context: [],
        retryLimit: 0,
        timeoutSeconds: 600,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        nextRunAt: "2026-01-01T00:01:00.000Z",
        runCount: 0,
        missedRuns: 0,
        taskIds: [],
        runIds: []
      }
    ];

    const normalized = normalizeState("test-instance-cron-migrate", state);

    const cronJob = normalized.jobs.find((j) => j.id === "job_legacy_cron");
    const intervalJob = normalized.jobs.find((j) => j.id === "job_legacy_interval");
    // Cron-driven row: the 0 sentinel is dropped.
    expect(cronJob?.intervalSeconds).toBeUndefined();
    expect(cronJob?.cronExpression).toBe("0 9 * * *");
    // Interval-driven row: untouched.
    expect(intervalJob?.intervalSeconds).toBe(60);
  });

  test("unions new default toolsets into existing agent_default without touching user-authored agents", () => {
    // Simulate an instance whose `agent_default` row was persisted before
    // `browser` joined the default toolsets list, alongside a
    // user-authored agent with an explicit narrow toolset pick.
    const state = createEmptyState("test-instance-agent-migrate");
    const defaultAgentRecord = state.agents.find((agent) => agent.id === "agent_default");
    expect(defaultAgentRecord).toBeDefined();
    // Pre-Phase-2 default toolsets list (no browser, no delegation).
    defaultAgentRecord!.toolsets = ["file", "terminal", "memory", "session_search"];
    const originalUpdatedAt = defaultAgentRecord!.updatedAt;
    // Pin updatedAt back in time so we can verify the migration bumped it.
    defaultAgentRecord!.updatedAt = "2025-01-01T00:00:00.000Z";
    // Add a user-authored agent with a deliberately narrow toolset.
    state.agents.push({
      id: "agent_user_custom",
      instance: "test-instance-agent-migrate",
      name: "user-custom",
      status: "inactive",
      providerName: undefined,
      model: undefined,
      toolsets: ["file"],
      messagingTargets: [],
      createdAt: originalUpdatedAt,
      updatedAt: originalUpdatedAt
    });
    // Add a legacy `profile_default` row to confirm the migration also
    // covers the legacy id.
    state.agents.push({
      id: "profile_default",
      instance: "test-instance-agent-migrate",
      name: "legacy-default",
      status: "inactive",
      providerName: undefined,
      model: undefined,
      toolsets: ["file", "terminal"],
      messagingTargets: [],
      createdAt: originalUpdatedAt,
      updatedAt: "2025-01-01T00:00:00.000Z"
    });

    const normalized = normalizeState("test-instance-agent-migrate", state);

    const migratedDefault = normalized.agents.find((agent) => agent.id === "agent_default")!;
    // Browser (and any other current default) is unioned in; pre-existing
    // entries are preserved in order.
    expect(migratedDefault.toolsets).toContain("file");
    expect(migratedDefault.toolsets).toContain("terminal");
    expect(migratedDefault.toolsets).toContain("memory");
    expect(migratedDefault.toolsets).toContain("session_search");
    expect(migratedDefault.toolsets).toContain("delegation");
    expect(migratedDefault.toolsets).toContain("browser");
    expect(migratedDefault.updatedAt).not.toBe("2025-01-01T00:00:00.000Z");

    const migratedLegacy = normalized.agents.find((agent) => agent.id === "profile_default")!;
    expect(migratedLegacy.toolsets).toContain("browser");
    expect(migratedLegacy.toolsets).toContain("delegation");
    expect(migratedLegacy.updatedAt).not.toBe("2025-01-01T00:00:00.000Z");

    // User-authored agent is untouched.
    const userCustom = normalized.agents.find((agent) => agent.id === "agent_user_custom")!;
    expect(userCustom.toolsets).toEqual(["file"]);
    expect(userCustom.updatedAt).toBe(originalUpdatedAt);
  });

  test("unions web_search into a default agent persisted at the post-browser snapshot", () => {
    // An instance created after `browser` joined the defaults but before
    // `web_search` did carries exactly this 8-entry whitelist. The
    // migration must recognize it as uncustomized and add web_search —
    // otherwise the web_search tool stays invisible to the model.
    const state = createEmptyState("test-instance-web-search-migrate");
    const agent = state.agents.find((a) => a.id === "agent_default")!;
    agent.toolsets = ["file", "terminal", "memory", "session_search", "delegation", "messaging", "mcp", "browser"];
    agent.updatedAt = "2025-01-01T00:00:00.000Z";

    const normalized = normalizeState("test-instance-web-search-migrate", state);
    const after = normalized.agents.find((a) => a.id === "agent_default")!;
    expect(after.toolsets).toContain("web_search");
    expect(after.toolsets).toContain("browser");
    expect(after.updatedAt).not.toBe("2025-01-01T00:00:00.000Z");
  });

  test("backfilled tool rows for a DISABLED toolset stay disabled", () => {
    const state = createEmptyState("test-instance-6");
    const browser = state.toolsets.find((ts) => ts.name === "browser");
    expect(browser).toBeDefined();
    // Simulate an instance whose operator has explicitly disabled the
    // browser toolset, then trim its tool roster to the historical 9-tool
    // shape so the backfill below has work to do.
    browser!.status = "disabled";
    browser!.toolNames = [
      "browser.navigate",
      "browser.snapshot",
      "browser.click",
      "browser.type",
      "browser.press",
      "browser.scroll",
      "browser.back",
      "browser.console",
      "browser.close"
    ];
    const newerNames = ["browser.vision", "browser.hover"];
    state.tools = state.tools.filter(
      (tool) => tool.toolset !== "browser" || !newerNames.includes(tool.name)
    );

    const normalized = normalizeState("test-instance-6", state);
    for (const name of newerNames) {
      const row = normalized.tools.find((tool) => tool.name === name);
      expect(row).toBeDefined();
      expect(row!.status).toBe("disabled");
    }
  });
});

describe("backfillDefaultAgentToolsets", () => {
  test("legacy state with the prior default whitelist gains messaging and mcp", () => {
    const state = createEmptyState("test-instance-agent-backfill-legacy");
    const agent = state.agents.find((a) => a.id === "agent_default");
    expect(agent).toBeDefined();
    // Simulate an upgraded instance whose default agent still carries
    // the prior whitelist (pre-messaging/mcp addition).
    agent!.toolsets = ["file", "terminal", "memory", "session_search", "delegation"];

    const normalized = normalizeState("test-instance-agent-backfill-legacy", state);
    const after = normalized.agents.find((a) => a.id === "agent_default");
    expect(after).toBeDefined();
    expect(after!.toolsets).toContain("messaging");
    expect(after!.toolsets).toContain("mcp");
    // Original entries preserved.
    for (const name of ["file", "terminal", "memory", "session_search", "delegation"]) {
      expect(after!.toolsets).toContain(name);
    }
    // Audit row landed so the backfill is traceable.
    const audit = normalized.audit.find(
      (e) => e.action === "agent.toolsets.backfilled" && e.target === "agent_default"
    );
    expect(audit).toBeDefined();
    expect((audit?.evidence as { added?: string[] })?.added).toEqual(["messaging", "mcp"]);
  });

  test("customized state (user removed terminal) is left untouched", () => {
    const state = createEmptyState("test-instance-agent-backfill-custom");
    const agent = state.agents.find((a) => a.id === "agent_default");
    expect(agent).toBeDefined();
    // User removed `terminal` — list no longer matches the prior default
    // exactly, so the migration should leave it alone.
    agent!.toolsets = ["file", "memory", "session_search", "delegation"];

    const normalized = normalizeState("test-instance-agent-backfill-custom", state);
    const after = normalized.agents.find((a) => a.id === "agent_default");
    expect(after).toBeDefined();
    expect(after!.toolsets).toEqual(["file", "memory", "session_search", "delegation"]);
    expect(after!.toolsets).not.toContain("messaging");
    expect(after!.toolsets).not.toContain("mcp");
    // No backfill audit row written.
    const audit = normalized.audit.find(
      (e) => e.action === "agent.toolsets.backfilled" && e.target === "agent_default"
    );
    expect(audit).toBeUndefined();
  });

  test("fresh state without an agent_default row is a no-op", () => {
    const state = createEmptyState("test-instance-agent-backfill-noagent");
    // Replace the seeded default with a differently-named agent so the
    // lookup misses entirely.
    state.agents = [{
      id: "agent_other",
      instance: "test-instance-agent-backfill-noagent",
      name: "other",
      status: "active",
      providerName: undefined,
      model: undefined,
      toolsets: ["file", "terminal", "memory", "session_search", "delegation"],
      messagingTargets: [],
      createdAt: state.agents[0].createdAt,
      updatedAt: state.agents[0].updatedAt
    }];
    state.activeAgentId = "agent_other";

    const normalized = normalizeState("test-instance-agent-backfill-noagent", state);
    // The non-default agent is untouched even though its whitelist
    // matches the prior default set — the migration only targets
    // `agent_default`.
    const other = normalized.agents.find((a) => a.id === "agent_other");
    expect(other!.toolsets).toEqual(["file", "terminal", "memory", "session_search", "delegation"]);
    const audit = normalized.audit.find(
      (e) => e.action === "agent.toolsets.backfilled"
    );
    expect(audit).toBeUndefined();
  });

  test("already-migrated state (messaging + mcp present) is idempotent", () => {
    const state = createEmptyState("test-instance-agent-backfill-idempotent");
    // createEmptyState seeds the new default which already includes
    // `messaging` and `mcp`. No backfill should fire.
    const before = state.agents.find((a) => a.id === "agent_default")!.toolsets.slice();
    expect(before).toContain("messaging");
    expect(before).toContain("mcp");

    const normalized = normalizeState("test-instance-agent-backfill-idempotent", state);
    const after = normalized.agents.find((a) => a.id === "agent_default");
    expect(after!.toolsets).toEqual(before);
    const audit = normalized.audit.find(
      (e) => e.action === "agent.toolsets.backfilled"
    );
    expect(audit).toBeUndefined();

    // Running normalizeState a second time on the already-migrated state
    // is still a no-op — no second audit row appears.
    const renormalized = normalizeState("test-instance-agent-backfill-idempotent", normalized);
    const audits = renormalized.audit.filter(
      (e) => e.action === "agent.toolsets.backfilled"
    );
    expect(audits.length).toBe(0);
  });
});

describe("renameDefaultAgentToGini", () => {
  test("renames a legacy default-named default agent to Gini and audits it", () => {
    const state = createEmptyState("test-instance-rename-default");
    const agent = state.agents.find((a) => a.id === "agent_default")!;
    // Simulate an instance seeded before the default agent was named
    // "Gini" — its default agent still carries the legacy "default" name.
    agent.name = "default";

    const normalized = normalizeState("test-instance-rename-default", state);
    const after = normalized.agents.find((a) => a.id === "agent_default")!;
    expect(after.name).toBe("Gini");
    const audit = normalized.audit.find(
      (e) => e.action === "agent.default.renamed" && e.target === "agent_default"
    );
    expect(audit).toBeDefined();
    expect(audit?.evidence).toEqual({ from: "default", to: "Gini", agentId: "agent_default" });
  });

  test("leaves a user-renamed default agent untouched", () => {
    const state = createEmptyState("test-instance-rename-custom");
    const agent = state.agents.find((a) => a.id === "agent_default")!;
    // User renamed their default agent — the migration must not clobber it.
    agent.name = "Mansour";

    const normalized = normalizeState("test-instance-rename-custom", state);
    const after = normalized.agents.find((a) => a.id === "agent_default")!;
    expect(after.name).toBe("Mansour");
    const audit = normalized.audit.find((e) => e.action === "agent.default.renamed");
    expect(audit).toBeUndefined();
  });

  test("is idempotent — a second pass writes no further audit row", () => {
    const state = createEmptyState("test-instance-rename-idempotent");
    const agent = state.agents.find((a) => a.id === "agent_default")!;
    agent.name = "default";

    const normalized = normalizeState("test-instance-rename-idempotent", state);
    expect(normalized.agents.find((a) => a.id === "agent_default")!.name).toBe("Gini");
    const renormalized = normalizeState("test-instance-rename-idempotent", normalized);
    const audits = renormalized.audit.filter((e) => e.action === "agent.default.renamed");
    expect(audits.length).toBe(1);
  });

  test("a freshly seeded default agent is already named Gini — no rename fires", () => {
    const state = createEmptyState("test-instance-rename-fresh");
    expect(state.agents.find((a) => a.id === "agent_default")!.name).toBe("Gini");

    const normalized = normalizeState("test-instance-rename-fresh", state);
    expect(normalized.agents.find((a) => a.id === "agent_default")!.name).toBe("Gini");
    const audit = normalized.audit.find((e) => e.action === "agent.default.renamed");
    expect(audit).toBeUndefined();
  });
});

describe("dropDeadMemoryImprovements", () => {
  test("strips improvements with the legacy kind: memory and audits each removal", () => {
    const state = createEmptyState("legacy-memory-improvements");
    // Inject legacy proposals via the dynamic shape — the type-level
    // ImprovementKind dropped "memory" alongside the state.memories
    // consolidation, but persisted state files still carry them.
    state.improvements = [
      ...state.improvements,
      {
        id: "imp_mem_1",
        instance: state.instance,
        // Cast through unknown because the field is no longer typed.
        kind: "memory" as unknown as "skill",
        title: "remember preferences",
        rationale: "legacy",
        status: "proposed",
        sourceTaskId: undefined,
        sourceTraceIds: [],
        payload: { content: "x" },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      },
      {
        id: "imp_skill_1",
        instance: state.instance,
        kind: "skill",
        title: "real skill",
        rationale: "ok",
        status: "proposed",
        sourceTaskId: undefined,
        sourceTraceIds: [],
        payload: { name: "real skill" },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }
    ];

    const normalized = normalizeState(state.instance, state);

    // The legacy memory proposal is gone; the skill proposal stays.
    expect(normalized.improvements.find((p) => p.id === "imp_mem_1")).toBeUndefined();
    expect(normalized.improvements.find((p) => p.id === "imp_skill_1")).toBeDefined();

    // The removal landed an audit row so operators can see why the
    // proposal disappeared.
    const audit = normalized.audit.find(
      (event) => event.action === "improvement.memory-kind.removed" && event.target === "imp_mem_1"
    );
    expect(audit).toBeDefined();
    expect(audit?.evidence?.title).toBe("remember preferences");
  });
});

describe("archiveOrphanJobChannels (issue #369)", () => {
  // Append a chat session record onto a state with the fields normalizeState
  // and the sweep read. `id` doubles as a discriminator across cases.
  function pushSession(
    state: RuntimeState,
    overrides: Partial<RuntimeState["chatSessions"][number]> & { id: string }
  ) {
    state.chatSessions.push({
      instance: state.instance,
      title: overrides.id,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      messageIds: [],
      taskIds: [],
      runIds: [],
      ...overrides
    });
  }

  test("archives a job channel orphaned by a pre-cleanup deletion (no surviving job references it)", () => {
    const state = createEmptyState("orphan-channel-archive");
    // The exact shape from issue #369: a channel left behind after its job
    // was deleted — kind:"channel", origin:"job", not archived, and no job
    // in state points at it.
    pushSession(state, { id: "chat_orphan", kind: "channel", origin: "job" });

    const normalized = normalizeState(state.instance, state);

    const channel = normalized.chatSessions.find((s) => s.id === "chat_orphan");
    expect(channel?.archivedAt).toBeString();
    const audit = normalized.audit.find(
      (e) => e.action === "chat.session.archived" && e.evidence?.reason === "orphan.job.channel.backfill"
    );
    expect(audit).toBeDefined();
    expect(audit?.evidence?.archived).toBe(1);
  });

  test("backfills kind on a legacy origin:job session before sweeping it", () => {
    const state = createEmptyState("orphan-channel-legacy-kind");
    // A legacy session predating the chats-IA `kind` field: only origin:"job"
    // is set. normalizeState backfills kind:"channel" first, so the sweep
    // still catches it.
    pushSession(state, { id: "chat_legacy", origin: "job" });

    const normalized = normalizeState(state.instance, state);

    const channel = normalized.chatSessions.find((s) => s.id === "chat_legacy");
    expect(channel?.kind).toBe("channel");
    expect(channel?.archivedAt).toBeString();
  });

  test("leaves a channel a surviving job still delivers into (chatSessionId or fan-out route)", () => {
    const state = createEmptyState("orphan-channel-referenced");
    pushSession(state, { id: "chat_bound", kind: "channel", origin: "job" });
    pushSession(state, { id: "chat_routed", kind: "channel", origin: "job" });
    const at = "2026-01-01T00:00:00.000Z";
    state.jobs.push({
      id: "job_bound",
      instance: state.instance,
      agentId: "agent_default",
      name: "bound",
      prompt: "x",
      intervalSeconds: 600,
      status: "active",
      nextRunAt: at,
      deliveryTargets: [],
      context: [],
      retryLimit: 0,
      timeoutSeconds: 600,
      runIds: [],
      taskIds: [],
      runCount: 0,
      missedRuns: 0,
      createdAt: at,
      updatedAt: at,
      chatSessionId: "chat_bound",
      routes: { alerts: { chatSessionId: "chat_routed" } }
    });

    const normalized = normalizeState(state.instance, state);

    // Both referenced channels stay active — a live job still delivers into them.
    expect(normalized.chatSessions.find((s) => s.id === "chat_bound")?.archivedAt).toBeUndefined();
    expect(normalized.chatSessions.find((s) => s.id === "chat_routed")?.archivedAt).toBeUndefined();
    expect(normalized.audit.some((e) => e.evidence?.reason === "orphan.job.channel.backfill")).toBe(false);
  });

  test("never touches email-watch channels or already-archived/plain sessions", () => {
    const state = createEmptyState("orphan-channel-excluded");
    // Email-watch channels are owned by the email-watch subsystem's own
    // delete/heal paths — out of scope for this sweep even when orphaned.
    pushSession(state, { id: "chat_emailwatch", kind: "channel", origin: "job", feature: "email-watch" });
    // Already archived — re-stamping would lie about when it left the lists.
    pushSession(state, { id: "chat_already", kind: "channel", origin: "job", archivedAt: "2026-05-01T00:00:00.000Z" });
    // A plain agent chat (no channel kind) must never be archived.
    pushSession(state, { id: "chat_plain", kind: "agent" });

    const normalized = normalizeState(state.instance, state);

    expect(normalized.chatSessions.find((s) => s.id === "chat_emailwatch")?.archivedAt).toBeUndefined();
    // Untouched: the pre-existing archivedAt timestamp is preserved verbatim.
    expect(normalized.chatSessions.find((s) => s.id === "chat_already")?.archivedAt).toBe("2026-05-01T00:00:00.000Z");
    expect(normalized.chatSessions.find((s) => s.id === "chat_plain")?.archivedAt).toBeUndefined();
    expect(normalized.audit.some((e) => e.evidence?.reason === "orphan.job.channel.backfill")).toBe(false);
  });

  test("is idempotent — a second normalize archives nothing new", () => {
    const state = createEmptyState("orphan-channel-idempotent");
    pushSession(state, { id: "chat_orphan", kind: "channel", origin: "job" });

    const once = normalizeState(state.instance, state);
    const stamped = once.chatSessions.find((s) => s.id === "chat_orphan")?.archivedAt;
    expect(stamped).toBeString();

    const twice = normalizeState(state.instance, once);
    // Same timestamp, no second archive audit.
    expect(twice.chatSessions.find((s) => s.id === "chat_orphan")?.archivedAt).toBe(stamped);
    expect(
      twice.audit.filter((e) => e.evidence?.reason === "orphan.job.channel.backfill").length
    ).toBe(1);
  });
});

describe("migrateJobsToTopics (Jobs → Topics)", () => {
  const at = "2026-01-01T00:00:00.000Z";
  function pushJob(state: RuntimeState, overrides: { id: string; chatSessionId?: string; forwardToChat?: boolean }) {
    state.jobs.push({
      id: overrides.id,
      instance: state.instance,
      agentId: "agent_default",
      name: overrides.id,
      prompt: "x",
      intervalSeconds: 600,
      status: "active",
      nextRunAt: at,
      deliveryTargets: [],
      context: [],
      retryLimit: 0,
      timeoutSeconds: 600,
      runIds: [],
      taskIds: [],
      runCount: 0,
      missedRuns: 0,
      createdAt: at,
      updatedAt: at,
      ...(overrides.chatSessionId !== undefined ? { chatSessionId: overrides.chatSessionId } : {}),
      ...(overrides.forwardToChat !== undefined ? { forwardToChat: overrides.forwardToChat } : {})
    });
  }
  function pushSession(state: RuntimeState, overrides: Partial<RuntimeState["chatSessions"][number]> & { id: string }) {
    state.chatSessions.push({
      instance: state.instance,
      title: overrides.id,
      createdAt: at,
      updatedAt: at,
      messageIds: [],
      taskIds: [],
      runIds: [],
      ...overrides
    });
  }

  test("mints a Topic + forwardToChat for a legacy job bound to a kind:agent Chat", () => {
    const state = createEmptyState("jobs-topics-legacy-chat");
    // The legacy deliverTo:"chat" rebind result: the job's chatSessionId points
    // at the user's own kind:"agent" Chat — it has no dedicated Topic.
    pushSession(state, { id: "chat_agent", kind: "agent", agentId: "agent_default" });
    pushJob(state, { id: "job_legacy", chatSessionId: "chat_agent" });

    const normalized = normalizeState(state.instance, state);

    const job = normalized.jobs.find((j) => j.id === "job_legacy")!;
    // Re-pointed at a fresh dedicated channel/Topic; forwardToChat set.
    expect(job.chatSessionId).not.toBe("chat_agent");
    expect(job.forwardToChat).toBe(true);
    const topic = normalized.chatSessions.find((s) => s.id === job.chatSessionId);
    expect(topic?.kind).toBe("channel");
    expect(topic?.origin).toBe("job");
    expect(topic?.title).toBe("job_legacy");
    // The user's Chat is left intact.
    expect(normalized.chatSessions.find((s) => s.id === "chat_agent")?.kind).toBe("agent");
  });

  test("a job already on a kind:channel Topic is left channel-only (no forwardToChat)", () => {
    const state = createEmptyState("jobs-topics-channel");
    pushSession(state, { id: "chat_channel", kind: "channel", origin: "job", agentId: "agent_default" });
    pushJob(state, { id: "job_channel", chatSessionId: "chat_channel" });

    const normalized = normalizeState(state.instance, state);

    const job = normalized.jobs.find((j) => j.id === "job_channel")!;
    expect(job.chatSessionId).toBe("chat_channel");
    expect(job.forwardToChat ?? false).toBe(false);
  });

  test("is idempotent — a second normalize mints no further Topic", () => {
    const state = createEmptyState("jobs-topics-idempotent");
    pushSession(state, { id: "chat_agent", kind: "agent", agentId: "agent_default" });
    pushJob(state, { id: "job_legacy", chatSessionId: "chat_agent" });

    const once = normalizeState(state.instance, state);
    const mintedTopicId = once.jobs.find((j) => j.id === "job_legacy")!.chatSessionId;
    const sessionCount = once.chatSessions.length;

    const twice = normalizeState(state.instance, once);
    // The marker gates a second pass: same Topic, no new session minted.
    expect(twice.jobs.find((j) => j.id === "job_legacy")!.chatSessionId).toBe(mintedTopicId);
    expect(twice.chatSessions.length).toBe(sessionCount);
  });
});

describe("normalizeState approval -> authorization/setup-request migration", () => {
  test("partitions a legacy approvals array by action", () => {
    const at = new Date().toISOString();
    const state = createEmptyState("test-approval-split");
    // Simulate a pre-split state file: drop the new arrays, install a
    // mixed `approvals` array.
    const legacy = [
      {
        id: "approval_1",
        instance: "test-approval-split",
        status: "pending",
        createdAt: at,
        updatedAt: at,
        action: "file.write",
        target: "/tmp/x",
        risk: "medium",
        reason: "write a file",
        payload: { path: "/tmp/x" }
      },
      {
        id: "approval_2",
        instance: "test-approval-split",
        status: "approved",
        createdAt: at,
        updatedAt: at,
        action: "browser.connect",
        target: "https://example.com",
        risk: "low",
        reason: "sign in",
        payload: {}
      },
      {
        id: "approval_3",
        instance: "test-approval-split",
        status: "denied",
        createdAt: at,
        updatedAt: at,
        action: "connector.request",
        target: "openai",
        risk: "medium",
        reason: "enter creds",
        payload: { provider: "openai" }
      },
      {
        id: "approval_4",
        instance: "test-approval-split",
        status: "pending",
        createdAt: at,
        updatedAt: at,
        action: "browser.fill_secret",
        target: "https://login.example.com",
        risk: "high",
        reason: "type password",
        payload: { slots: [] }
      }
    ];
    const legacyState = state as RuntimeState & { approvals?: unknown };
    legacyState.approvals = legacy as unknown;
    // Force the new arrays empty so the migration path runs.
    (legacyState as { authorizations?: unknown }).authorizations = undefined;
    (legacyState as { setupRequests?: unknown }).setupRequests = undefined;

    const normalized = normalizeState("test-approval-split", state);

    expect((normalized as unknown as { approvals?: unknown }).approvals).toBeUndefined();
    expect(normalized.authorizations).toHaveLength(1);
    expect(normalized.authorizations[0]!.id).toBe("approval_1");
    expect(normalized.authorizations[0]!.action).toBe("file.write");

    expect(normalized.setupRequests).toHaveLength(3);
    const byId = new Map(normalized.setupRequests.map((row) => [row.id, row]));
    expect(byId.get("approval_2")!.action).toBe("browser.connect");
    expect(byId.get("approval_2")!.status).toBe("completed");
    expect(byId.get("approval_3")!.action).toBe("connector.request");
    expect(byId.get("approval_3")!.status).toBe("cancelled");
    expect(byId.get("approval_4")!.action).toBe("browser.fill_secret");
    expect(byId.get("approval_4")!.status).toBe("pending");
    // Risk is structurally absent from SetupRequest.
    expect((byId.get("approval_4") as { risk?: unknown }).risk).toBeUndefined();
  });

  test("is a no-op when the legacy field is absent", () => {
    const state = createEmptyState("test-approval-noop");
    expect((state as RuntimeState & { approvals?: unknown }).approvals).toBeUndefined();
    const normalized = normalizeState("test-approval-noop", state);
    expect(normalized.authorizations).toEqual([]);
    expect(normalized.setupRequests).toEqual([]);
    expect((normalized as unknown as { approvals?: unknown }).approvals).toBeUndefined();
  });
});

describe("normalizeState provider-keyed → typed-named-credential migration", () => {
  // Build a pre-migration state: provider-keyed linear + google-oauth-desktop
  // + a generic connector, plus a user skill that requires + grants them.
  // Secrets are written to disk so the migration's purpose re-key can be
  // verified to preserve values.
  function seedPreMigration(instance: string): RuntimeState {
    const state = createEmptyState(instance);
    const at = new Date().toISOString();

    const linearRef = writeSecret(instance, "id_linear", "token", "lin_api_secret");
    const gwsIdRef = writeSecret(instance, "id_gws", "client_id", "gws-client-id");
    const gwsSecretRef = writeSecret(instance, "id_gws", "client_secret", "gws-client-secret");
    const genericRef = writeSecret(instance, "id_generic", "MY_API_KEY", "generic-secret");

    const connectors: ConnectorRecord[] = [
      {
        id: "id_linear",
        instance,
        name: "Linear",
        provider: "linear",
        status: "configured",
        scopes: [],
        secretRefs: [linearRef],
        createdAt: at,
        updatedAt: at,
        health: "healthy",
        source: "user"
      },
      {
        id: "id_gws",
        instance,
        name: "Google",
        provider: "google-oauth-desktop",
        status: "configured",
        scopes: [],
        secretRefs: [gwsIdRef, gwsSecretRef],
        createdAt: at,
        updatedAt: at,
        health: "healthy",
        source: "user"
      },
      {
        id: "id_generic",
        instance,
        name: "My Service",
        provider: "generic",
        status: "configured",
        scopes: [],
        secretRefs: [genericRef],
        createdAt: at,
        updatedAt: at,
        health: "healthy",
        source: "user"
      }
    ];
    // Replace the default demo connector list with our seeded set.
    state.connectors = connectors;

    const skill: SkillRecord = {
      id: "skill_user_1",
      instance,
      name: "my-linear-skill",
      description: "User skill referencing linear + generic",
      trigger: "",
      steps: [],
      requiredTools: [],
      requiredPermissions: [],
      status: "enabled",
      version: 1,
      createdAt: at,
      updatedAt: at,
      tests: [],
      successCount: 0,
      failureCount: 0,
      previousVersions: [],
      body: "",
      source: "user",
      // Declares the env vars so the generic requires conversion can match the
      // generic credential (MY_API_KEY) by env coverage rather than guessing.
      prerequisites: { env: ["LINEAR_API_KEY", "MY_API_KEY"] },
      requiredConnectors: [{ provider: "linear" }, { provider: "generic" }],
      grantedConnectors: ["linear", "generic"]
    };
    state.skills = [skill];
    return state;
  }

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

  test("types + names connectors, preserves secrets, converts skills, and is idempotent", async () => {
    const instance = "test-cred-migrate";
    const state = seedPreMigration(instance);
    const normalized = normalizeState(instance, state);

    const linear = normalized.connectors.find((c) => c.id === "id_linear")!;
    expect(linear.type).toBe("api-key");
    expect(linear.name).toBe("LINEAR_API_KEY");
    expect(linear.metadata?.mcp).toEqual({
      url: "https://mcp.linear.app/mcp",
      name: "linear",
      headerName: "Authorization",
      scheme: "Bearer"
    });
    // The secret purpose is NOT re-keyed: it stays "token" so the Linear probe
    // (resolveSecret "token") and bindingsForCredentials (secretRefs[0].purpose)
    // both keep working.
    expect(linear.secretRefs.map((r) => r.purpose)).toEqual(["token"]);
    const linearRef = linear.secretRefs.find((r) => r.purpose === "token")!;
    expect(readSecret(instance, linearRef)).toBe("lin_api_secret");
    // The api-key still resolves under its name via the binding layer.
    expect(bindingsForCredentials(normalized, ["LINEAR_API_KEY"])).toEqual({
      LINEAR_API_KEY: { credentialId: "id_linear", purpose: "token" }
    });

    const gws = normalized.connectors.find((c) => c.id === "id_gws")!;
    expect(gws.type).toBe("oauth2");
    expect(gws.name).toBe("google-workspace-oauth");
    expect(gws.metadata?.envMap).toEqual({
      client_id: "GOOGLE_WORKSPACE_CLI_CLIENT_ID",
      client_secret: "GOOGLE_WORKSPACE_CLI_CLIENT_SECRET"
    });
    // oauth2 keeps its purposes (client_id/client_secret) — values intact.
    expect(readSecret(instance, gws.secretRefs.find((r) => r.purpose === "client_id")!)).toBe("gws-client-id");
    expect(readSecret(instance, gws.secretRefs.find((r) => r.purpose === "client_secret")!)).toBe("gws-client-secret");
    // GOOGLE_WORKSPACE_CLI_CLIENT_ID actually RESOLVES through the full env
    // path (not just a read-back of the envMap). resolveSkillEnv reads the
    // instance off disk, so persist the migrated state first. The migrated
    // skill is a user skill that grants google-workspace-oauth, so
    // resolveSkillEnv injects it.
    writeState(instance, normalized);
    const gwsSkill: SkillRecord = {
      ...normalized.skills.find((s) => s.id === "skill_user_1")!,
      requiredCredentials: ["google-workspace-oauth"],
      grantedConnectors: ["google-workspace-oauth"],
      prerequisites: { env: ["GOOGLE_WORKSPACE_CLI_CLIENT_ID", "GOOGLE_WORKSPACE_CLI_CLIENT_SECRET"] }
    };
    const gwsEnv = await resolveSkillEnv(configFor(instance), gwsSkill);
    expect(gwsEnv).toEqual({
      GOOGLE_WORKSPACE_CLI_CLIENT_ID: "gws-client-id",
      GOOGLE_WORKSPACE_CLI_CLIENT_SECRET: "gws-client-secret"
    });

    const generic = normalized.connectors.find((c) => c.id === "id_generic")!;
    expect(generic.type).toBe("api-key");
    expect(generic.name).toBe("MY_API_KEY");
    expect(readSecret(instance, generic.secretRefs[0]!)).toBe("generic-secret");

    const skill = normalized.skills.find((s) => s.id === "skill_user_1")!;
    expect(skill.requiredCredentials).toEqual(["LINEAR_API_KEY", "MY_API_KEY"]);
    expect(skill.grantedConnectors).toEqual(["LINEAR_API_KEY", "MY_API_KEY"]);

    // Exactly one summary audit row.
    const summary = normalized.audit.filter((a) => a.action === "connector.migration.typed_credentials");
    expect(summary.length).toBe(1);

    // Marker set.
    const marker = (normalized as unknown as { migrations?: { connectorsTypedCredentials?: string } }).migrations?.connectorsTypedCredentials;
    expect(typeof marker).toBe("string");

    // Idempotent: a second pass changes nothing material and adds no new
    // migration audit row.
    const second = normalizeState(instance, normalized);
    expect(second.connectors.find((c) => c.id === "id_linear")!.name).toBe("LINEAR_API_KEY");
    expect(second.connectors.find((c) => c.id === "id_linear")!.secretRefs.map((r) => r.purpose)).toEqual(["token"]);
    expect(second.audit.filter((a) => a.action === "connector.migration.typed_credentials").length).toBe(1);
    expect(second.skills.find((s) => s.id === "skill_user_1")!.requiredCredentials).toEqual(["LINEAR_API_KEY", "MY_API_KEY"]);
  });

  test("a skill requiring linear with NO linear connector still converts (static canonical table)", () => {
    const instance = "test-cred-no-connector";
    const state = createEmptyState(instance);
    // No linear connector at all — only the seeded demo. The skill still must
    // get its provider-keyed requirement converted to the canonical name.
    const at = new Date().toISOString();
    const skill: SkillRecord = {
      id: "skill_needs_linear",
      instance,
      name: "needs-linear",
      description: "Requires linear but no connector exists",
      trigger: "",
      steps: [],
      requiredTools: [],
      requiredPermissions: [],
      status: "enabled",
      version: 1,
      createdAt: at,
      updatedAt: at,
      tests: [],
      successCount: 0,
      failureCount: 0,
      previousVersions: [],
      body: "",
      source: "user",
      requiredConnectors: [{ provider: "linear" }]
    };
    state.skills = [skill];
    const normalized = normalizeState(instance, state);
    expect(normalized.skills.find((s) => s.id === "skill_needs_linear")!.requiredCredentials).toEqual(["LINEAR_API_KEY"]);
  });

  test("renames TWO colliding generic LINEAR_API_KEY records to _2 and _3 (loops to first free)", () => {
    const instance = "test-cred-collision";
    const state = createEmptyState(instance);
    const at = new Date().toISOString();

    const linearRef = writeSecret(instance, "id_linear", "token", "lin_api_secret");
    const dupRef = writeSecret(instance, "id_dup", "LINEAR_API_KEY", "generic-dup-secret");
    const dup2Ref = writeSecret(instance, "id_dup2", "LINEAR_API_KEY", "generic-dup2-secret");

    const mk = (id: string, name: string, provider: string, refs: ConnectorRecord["secretRefs"]): ConnectorRecord => ({
      id,
      instance,
      name,
      provider,
      status: "configured",
      scopes: [],
      secretRefs: refs,
      createdAt: at,
      updatedAt: at,
      health: "healthy",
      source: "user"
    });
    state.connectors = [
      mk("id_linear", "Linear", "linear", [linearRef]),
      mk("id_dup", "Dup", "generic", [dupRef]),
      mk("id_dup2", "Dup2", "generic", [dup2Ref])
    ];

    const normalized = normalizeState(instance, state);

    // Template-typed linear keeps the canonical name.
    expect(normalized.connectors.find((c) => c.id === "id_linear")!.name).toBe("LINEAR_API_KEY");
    // First generic dup → _2.
    const dup = normalized.connectors.find((c) => c.id === "id_dup")!;
    expect(dup.type).toBe("api-key");
    expect(dup.name).toBe("LINEAR_API_KEY_2");
    expect(readSecret(instance, dup.secretRefs[0]!)).toBe("generic-dup-secret");
    // Second generic dup loops past the now-claimed _2 to the first free _3.
    const dup2 = normalized.connectors.find((c) => c.id === "id_dup2")!;
    expect(dup2.type).toBe("api-key");
    expect(dup2.name).toBe("LINEAR_API_KEY_3");
    expect(readSecret(instance, dup2.secretRefs[0]!)).toBe("generic-dup2-secret");
    // All three credential names are unique (no duplicate produced).
    const names = normalized.connectors.filter((c) => c.type).map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    // A collision audit per renamed record.
    const collisions = normalized.audit.filter((a) => a.action === "connector.migration_collision");
    expect(collisions.length).toBe(2);
    expect(collisions.map((c) => (c.evidence as { to?: string }).to).sort()).toEqual([
      "LINEAR_API_KEY_2",
      "LINEAR_API_KEY_3"
    ]);
  });

  test("leaves presence-only providers (demo) untyped", () => {
    const instance = "test-cred-presence";
    const state = createEmptyState(instance);
    // createEmptyState seeds a demo connector — leave it as-is.
    const normalized = normalizeState(instance, state);
    const demo = normalized.connectors.find((c) => c.provider === "demo");
    expect(demo).toBeDefined();
    expect(demo!.type).toBeUndefined();
  });
});

describe("normalizeState connector canonical-name rename migration", () => {
  const at = new Date().toISOString();

  // A pre-existing auto-detected record, named by the provider label before
  // the provider declared a `credentialName` (the shape the rename heals).
  function mkConnector(instance: string, id: string, name: string, provider: string): ConnectorRecord {
    return {
      id,
      instance,
      name,
      provider,
      status: "configured",
      scopes: [],
      secretRefs: [],
      createdAt: at,
      updatedAt: at,
      health: "healthy",
      source: "auto"
    };
  }

  test("renames stale-named auto records to their provider's canonical credential name", () => {
    const instance = "test-canon-rename";
    const state = createEmptyState(instance);
    state.connectors = [
      mkConnector(instance, "id_codex", "Codex", "codex"),
      mkConnector(instance, "id_cc", "Claude Code", "claude-code")
    ];
    const normalized = normalizeState(instance, state);
    // Renamed to the names skill activation (isSkillActive) matches against.
    expect(normalized.connectors.find((c) => c.id === "id_codex")!.name).toBe("codex");
    expect(normalized.connectors.find((c) => c.id === "id_cc")!.name).toBe("claude-code");
    // Exactly one summary audit row documenting both renames.
    const summary = normalized.audit.filter((a) => a.action === "connector.migration.canonical_names");
    expect(summary.length).toBe(1);
    expect((summary[0]!.evidence as { renamed?: number }).renamed).toBe(2);
    // Marker set.
    const marker = (normalized as unknown as { migrations?: { connectorsCanonicalNames?: string } }).migrations
      ?.connectorsCanonicalNames;
    expect(typeof marker).toBe("string");
  });

  test("suffixes to the first free _N when the canonical name is already claimed", () => {
    const instance = "test-canon-collision";
    const state = createEmptyState(instance);
    state.connectors = [
      mkConnector(instance, "id_new", "codex", "codex"),
      mkConnector(instance, "id_old", "Codex", "codex")
    ];
    const normalized = normalizeState(instance, state);
    // The claimer keeps the canonical name; the stale record takes _2.
    expect(normalized.connectors.find((c) => c.id === "id_new")!.name).toBe("codex");
    expect(normalized.connectors.find((c) => c.id === "id_old")!.name).toBe("codex_2");
    const collisions = normalized.audit.filter((a) => a.action === "connector.migration_collision");
    expect(collisions.length).toBe(1);
    expect(collisions[0]!.evidence).toEqual({ from: "Codex", to: "codex_2" });
  });

  test("marker prevents a re-run from renaming records again", () => {
    const instance = "test-canon-marker";
    const state = createEmptyState(instance);
    state.connectors = [mkConnector(instance, "id_codex", "Codex", "codex")];
    const normalized = normalizeState(instance, state);
    expect(normalized.connectors.find((c) => c.id === "id_codex")!.name).toBe("codex");
    // Rename back to the stale label; the marker gates the second pass so the
    // record stays as the operator left it and no new audit row appears.
    normalized.connectors.find((c) => c.id === "id_codex")!.name = "Codex";
    const second = normalizeState(instance, normalized);
    expect(second.connectors.find((c) => c.id === "id_codex")!.name).toBe("Codex");
    expect(second.audit.filter((a) => a.action === "connector.migration.canonical_names").length).toBe(1);
  });

  test("leaves records whose provider has no canonical credential name untouched", () => {
    const instance = "test-canon-skip";
    const state = createEmptyState(instance);
    // createEmptyState seeds a demo connector (presence-only, no canonical
    // name); add a generic record too — neither may be renamed, and with no
    // renames the summary audit is skipped (marker still set silently).
    state.connectors.push(mkConnector(instance, "id_generic", "My Service", "generic"));
    const demoName = state.connectors.find((c) => c.provider === "demo")!.name;
    const normalized = normalizeState(instance, state);
    expect(normalized.connectors.find((c) => c.provider === "demo")!.name).toBe(demoName);
    expect(normalized.connectors.find((c) => c.id === "id_generic")!.name).toBe("My Service");
    expect(normalized.audit.filter((a) => a.action === "connector.migration.canonical_names").length).toBe(0);
    const marker = (normalized as unknown as { migrations?: { connectorsCanonicalNames?: string } }).migrations
      ?.connectorsCanonicalNames;
    expect(typeof marker).toBe("string");
  });
});

const MARKER_TASK = {
  id: "task_marker",
  title: "marker",
  input: "marker",
  status: "completed",
  instance: "test-write-atomic",
  agentId: "agent_default",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  tracePath: "/dev/null",
  auditIds: [],
  approvalIds: [],
  skillIds: []
} satisfies RuntimeState["tasks"][number];

describe("writeState atomic temp files", () => {
  // Pin the ENOENT-rename hazard (a duplicate gateway boot racing the
  // incumbent's writeState on a shared `state.json.tmp`). Each write must use a
  // per-call temp filename and leave no temp behind, so two overlapping writers
  // never consume each other's temp and ENOENT on rename.
  test("round-trips and leaves no temp files behind", () => {
    const instance = "test-write-atomic";
    const root = instanceRoot(instance);
    for (let i = 0; i < 5; i += 1) {
      const state = createEmptyState(instance);
      // A marker task survives normalizeState (it only backfills agentId), so
      // the last write is observable on round-trip.
      state.tasks = [{ ...MARKER_TASK, title: `write-${i}` }];
      writeState(instance, state);
    }
    // No `*.tmp` files linger in the instance dir — neither the legacy fixed
    // `state.json.tmp` nor any per-write temp.
    const lingering = readdirSync(root).filter((name) => name.includes(".tmp"));
    expect(lingering).toEqual([]);
    // The last write is the durable state.
    expect(readState(instance).tasks[0]?.title).toBe("write-4");
  });

  test("writes a complete, fsync-durable file (never zero-length or torn)", () => {
    // The durability guarantee behind the fsync-before-rename: the on-disk
    // state.json is always a complete JSON document, never the correctly-sized
    // ALL-ZERO file a delayed-allocation rename-without-fsync leaves after a
    // hard poweroff — the exact corruption that crash-looped a guest on boot.
    const instance = "test-write-durable";
    const state = createEmptyState(instance);
    state.tasks = [{ ...MARKER_TASK, instance, title: "durable" }];
    writeState(instance, state);
    const raw = readFileSync(statePath(instance), "utf8");
    // Non-empty, and its tail was written (not truncated/zeroed): the trailing
    // "}\n" that writeState always appends is present.
    expect(raw.length).toBeGreaterThan(0);
    expect(raw.endsWith("}\n")).toBe(true);
    // Parses as complete JSON and round-trips the marker.
    const parsed = JSON.parse(raw) as RuntimeState;
    expect(parsed.tasks[0]?.title).toBe("durable");
  });
});

// The runtime drives a single spawned per-instance Chrome that carries no
// state record (issue #420). normalizeState always coerces state.browser to
// null on load, so a legacy or hand-edited state file holding a stale
// managed/cdp record can't resurrect a removed transport or crash a consumer.
describe("normalizeState browser connection record", () => {
  test("a well-formed cdp-mode record is kept (the user's external-Chrome attach)", () => {
    const state = createEmptyState("keep-cdp");
    (state as unknown as Record<string, unknown>).browser = {
      mode: "cdp",
      cdpUrl: "ws://127.0.0.1:9222/devtools/browser/abc",
      startedAt: "2026-01-01T00:00:00.000Z"
    };
    const normalized = normalizeState("keep-cdp", state);
    expect(normalized.browser?.mode).toBe("cdp");
    expect(normalized.browser?.cdpUrl).toBe("ws://127.0.0.1:9222/devtools/browser/abc");
  });

  test("a stale managed-mode record loads as browser: null without crashing (removed transport)", () => {
    const state = createEmptyState("stale-managed");
    // The visible-window "managed" mode was removed (issue #420). A legacy
    // state file that still holds one must coerce to null on load rather than
    // resurrect a removed transport — write it through a loose record to
    // simulate the on-disk shape.
    (state as unknown as Record<string, unknown>).browser = {
      mode: "managed",
      cdpUrl: "internal:managed",
      pid: 4242,
      dataDir: "/tmp/some-profile",
      chromePath: "/fake/chrome",
      startedAt: "2026-01-01T00:00:00.000Z",
      headless: false
    };
    const normalized = normalizeState("stale-managed", state);
    expect(normalized.browser ?? null).toBeNull();
  });

  test("a malformed record (missing cdpUrl) loads as browser: null", () => {
    const state = createEmptyState("malformed-browser");
    (state as unknown as Record<string, unknown>).browser = { mode: "cdp" };
    const normalized = normalizeState("malformed-browser", state);
    expect(normalized.browser ?? null).toBeNull();
  });

  test("an already-null record stays null (idempotent)", () => {
    const state = createEmptyState("already-null");
    const normalized = normalizeState("already-null", state);
    expect(normalized.browser ?? null).toBeNull();
  });
});

// The device-pairing subsystem is gone (owner-token-only auth; see ADR
// owner-token-auth.md). Old state files still carry its collections — pin that
// normalizeState sheds the legacy keys so the next write drops them.
describe("normalizeState legacy pairing-key shed", () => {
  test("drops pairingCodes/pairingRequests/devices from a legacy state file", () => {
    const state = createEmptyState("legacy-pairing-shed");
    const loose = state as unknown as Record<string, unknown>;
    loose.pairingCodes = [{ id: "pair_1" }];
    loose.pairingRequests = [{ id: "pairreq_1" }];
    loose.devices = [{ id: "device_1", status: "active" }];
    const normalized = normalizeState("legacy-pairing-shed", state) as unknown as Record<string, unknown>;
    expect(normalized.pairingCodes).toBeUndefined();
    expect(normalized.pairingRequests).toBeUndefined();
    expect(normalized.devices).toBeUndefined();
  });
});

describe("normalizeState task.chatSessionId backfill", () => {
  // Build a state with one legacy task (no chatSessionId) joined to a user
  // chat message, plus a task that has no matching message (a job task) to
  // prove unmatched tasks are left alone and don't force re-scans.
  function seedLegacyTasks(instance: string): RuntimeState {
    const state = createEmptyState(instance);
    const at = "2026-01-01T00:00:00.000Z";
    state.tasks = [
      {
        id: "task_chat", title: "t", input: "hi", status: "completed", instance,
        createdAt: at, updatedAt: at, tracePath: "", auditIds: [], approvalIds: [], skillIds: []
      },
      {
        id: "task_job", title: "j", input: "run", status: "completed", instance,
        createdAt: at, updatedAt: at, tracePath: "", auditIds: [], approvalIds: [], skillIds: []
      }
    ] as RuntimeState["tasks"];
    state.chatMessages = [
      { id: "m1", instance, sessionId: "chat_A", role: "user", content: "hi", createdAt: at, taskId: "task_chat" },
      // A second user message for the same task; the FIRST in array order wins.
      { id: "m2", instance, sessionId: "chat_B", role: "user", content: "again", createdAt: at, taskId: "task_chat" }
    ] as RuntimeState["chatMessages"];
    return state;
  }

  test("stamps a legacy task's chatSessionId from its first user message and sets the marker", () => {
    const state = seedLegacyTasks("backfill-happy");
    const dyn = state as unknown as { migrations?: { taskChatSessionIdBackfilled?: string } };
    expect(dyn.migrations?.taskChatSessionIdBackfilled).toBeUndefined();

    normalizeState("backfill-happy", state);

    expect(state.tasks.find((t) => t.id === "task_chat")!.chatSessionId).toBe("chat_A");
    // A task with no matching user message is left undefined.
    expect(state.tasks.find((t) => t.id === "task_job")!.chatSessionId).toBeUndefined();
    // Marker is set so the join never re-runs.
    expect(dyn.migrations?.taskChatSessionIdBackfilled).toBeString();
  });

  test("is gated by the marker: a task added after the backfill is NOT re-derived", () => {
    const state = seedLegacyTasks("backfill-gated");
    normalizeState("backfill-gated", state);
    // Simulate a later un-stamped legacy task appearing with a matching message
    // AFTER the marker is set (e.g. a hand-edited state file). The gate means
    // the one-time backfill won't touch it — the field stays as created.
    (state.tasks as RuntimeState["tasks"]).push({
      id: "task_late", title: "l", input: "x", status: "completed", instance: "backfill-gated",
      createdAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
      tracePath: "", auditIds: [], approvalIds: [], skillIds: []
    } as RuntimeState["tasks"][number]);
    (state.chatMessages as RuntimeState["chatMessages"]).push({
      id: "m3", instance: "backfill-gated", sessionId: "chat_C", role: "user",
      content: "late", createdAt: "2026-01-02T00:00:00.000Z", taskId: "task_late"
    } as RuntimeState["chatMessages"][number]);

    normalizeState("backfill-gated", state);
    expect(state.tasks.find((t) => t.id === "task_late")!.chatSessionId).toBeUndefined();
  });

  test("never overwrites a chatSessionId already set on a task", () => {
    const state = seedLegacyTasks("backfill-preserve");
    state.tasks.find((t) => t.id === "task_chat")!.chatSessionId = "chat_explicit";
    normalizeState("backfill-preserve", state);
    expect(state.tasks.find((t) => t.id === "task_chat")!.chatSessionId).toBe("chat_explicit");
  });
});

// Schema v10 (ADR chat-topics-tasks-subagents.md) — legacy threads convert to
// linear Chat history by nulling the thread tags on durable chat messages and
// on queued (pending) messages.
describe("normalizeState thread-tag strip (v10)", () => {
  // Seeds a state with one thread-tagged chatMessage and one session whose
  // pendingMessages queue carries a thread-tagged entry.
  function seedThreadTagged(instance: string): RuntimeState {
    const state = createEmptyState(instance);
    (state.chatMessages as RuntimeState["chatMessages"]).push({
      id: "m_thread", instance, sessionId: "chat_x", role: "user",
      content: "threaded reply", createdAt: "2026-01-01T00:00:00.000Z",
      threadId: "thread_1", parentBlockId: "blk_root"
    } as RuntimeState["chatMessages"][number]);
    (state.chatSessions as RuntimeState["chatSessions"]).push({
      id: "chat_x", instance, title: "Chat", createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z", messageIds: ["m_thread"], taskIds: [], runIds: [],
      pendingMessages: [
        { id: "p1", content: "queued reply", createdAt: "2026-01-01T00:00:01.000Z", threadId: "thread_1", parentBlockId: "blk_root" }
      ]
    } as RuntimeState["chatSessions"][number]);
    return state;
  }

  test("strips threadId/parentBlockId from chatMessages and pendingMessages", () => {
    const state = seedThreadTagged("thread-strip");
    normalizeState("thread-strip", state);

    const message = state.chatMessages.find((m) => m.id === "m_thread")!;
    expect(message.threadId).toBeUndefined();
    expect(message.parentBlockId).toBeUndefined();

    const pending = state.chatSessions.find((s) => s.id === "chat_x")!.pendingMessages![0]!;
    expect(pending.threadId).toBeUndefined();
    expect(pending.parentBlockId).toBeUndefined();
  });

  test("is idempotent across two runs", () => {
    const state = seedThreadTagged("thread-strip-idem");
    const once = normalizeState("thread-strip-idem", state);
    const twice = normalizeState("thread-strip-idem", once);

    const message = twice.chatMessages.find((m) => m.id === "m_thread")!;
    expect(message.threadId).toBeUndefined();
    expect(message.parentBlockId).toBeUndefined();
    const pending = twice.chatSessions.find((s) => s.id === "chat_x")!.pendingMessages![0]!;
    expect(pending.threadId).toBeUndefined();
    expect(pending.parentBlockId).toBeUndefined();
  });
});

describe("normalizeState emailWatchers agentId rehome", () => {
  test("rehomes a watcher whose agentId points at a non-existent agent onto the default agent", () => {
    // When the owning agent disappears, the watcher's backing job gets
    // rehomed to agent_default but the watcher kept the dead agentId — so
    // they split apart and the startup backfill mints duplicate shared jobs.
    // migrateRecordAgentIds must re-stamp the orphaned watcher onto the
    // default agent in lockstep with its job.
    const state = createEmptyState("ew-agentid-rehome");
    const at = "2026-01-01T00:00:00.000Z";
    state.emailWatchers = [
      {
        id: "emailwatch_orphan",
        instance: state.instance,
        agentId: "agent_dead",
        provider: "gmail",
        query: "in:inbox",
        enabled: true,
        status: "ok",
        createdAt: at,
        updatedAt: at
      }
    ];

    const normalized = normalizeState(state.instance, state);
    expect(normalized.emailWatchers.find((w) => w.id === "emailwatch_orphan")!.agentId).toBe("agent_default");
    expect(normalized.audit.some((e) => e.action === "records.agentid.backfill")).toBe(true);
  });
});

describe("normalizeState home container migrations", () => {
  test("topicsPinnedBackfilled pins non-archived topics once, skipping archived and non-topic sessions", () => {
    const state = createEmptyState("mig-topics-pinned");
    const topic = createTopic(state, { title: "Live topic" });
    const archived = createTopic(state, { title: "Archived topic" });
    archived.archivedAt = "2026-01-01T00:00:00.000Z";
    const chat = createChatSession(state, "Main chat", undefined, "agent_default", undefined, "agent");

    const dyn = state as unknown as { migrations?: { topicsPinnedBackfilled?: string } };
    expect(dyn.migrations?.topicsPinnedBackfilled).toBeUndefined();

    normalizeState("mig-topics-pinned", state);

    expect(topic.pinned).toBe(true);
    // The archived topic keeps its mint-time pinned:false — the backfill
    // never pins archived sessions.
    expect(archived.pinned).toBe(false);
    expect(chat.pinned).toBeUndefined();
    expect(dyn.migrations?.topicsPinnedBackfilled).toBeString();
  });

  test("topicsPinnedBackfilled is marker-gated: an unpin after the backfill survives re-normalize", () => {
    const state = createEmptyState("mig-topics-pinned-gated");
    const topic = createTopic(state, { title: "Legacy topic" });
    normalizeState("mig-topics-pinned-gated", state);
    expect(topic.pinned).toBe(true);

    // The user unpins; a later load must not re-pin it.
    topic.pinned = false;
    normalizeState("mig-topics-pinned-gated", state);
    expect(topic.pinned).toBe(false);
  });

  test("containersAckSeeded stamps acknowledgedAt on every pre-existing session and sets the marker", () => {
    const state = createEmptyState("mig-ack-seeded");
    const topic = createTopic(state, { title: "Old errand" });
    const chat = createChatSession(state, "Old chat");
    const dyn = state as unknown as { migrations?: { containersAckSeeded?: string } };

    normalizeState("mig-ack-seeded", state);

    expect(topic.acknowledgedAt).toBeString();
    expect(chat.acknowledgedAt).toBeString();
    expect(dyn.migrations?.containersAckSeeded).toBeString();
  });

  test("containersAckSeeded is marker-gated: sessions created after the seed stay unacknowledged", () => {
    const state = createEmptyState("mig-ack-seeded-gated");
    normalizeState("mig-ack-seeded-gated", state);

    const fresh = createTopic(state, { title: "New errand" });
    normalizeState("mig-ack-seeded-gated", state);
    expect(fresh.acknowledgedAt).toBeUndefined();
  });
});

describe("normalizeState job deliveryPolicy migration", () => {
  test("jobsDeliveryPolicyDefaulted stamps 'always' on jobs missing the field, preserves explicit values, and sets the marker", () => {
    const state = createEmptyState("mig-jobs-delivery-policy");
    const at = new Date().toISOString();
    const legacy = createJob(state, { name: "legacy digest", prompt: "p", nextRunAt: at });
    const explicit = createJob(state, { name: "watch", prompt: "p", nextRunAt: at, deliveryPolicy: "silent" });
    const dyn = state as unknown as { migrations?: { jobsDeliveryPolicyDefaulted?: string } };
    expect(dyn.migrations?.jobsDeliveryPolicyDefaulted).toBeUndefined();

    normalizeState("mig-jobs-delivery-policy", state);

    expect(legacy.deliveryPolicy).toBe("always");
    expect(explicit.deliveryPolicy).toBe("silent");
    expect(dyn.migrations?.jobsDeliveryPolicyDefaulted).toBeString();
  });

  test("jobsDeliveryPolicyDefaulted is marker-gated: a job added after the pass is not re-stamped", () => {
    const state = createEmptyState("mig-jobs-delivery-policy-gated");
    normalizeState("mig-jobs-delivery-policy-gated", state);

    const fresh = createJob(state, { name: "later job", prompt: "p", nextRunAt: new Date().toISOString() });
    normalizeState("mig-jobs-delivery-policy-gated", state);
    expect(fresh.deliveryPolicy).toBeUndefined();
  });

  test("auto-inbox legacy jobs are repaired to silent delivery with a hidden channel", () => {
    const state = createEmptyState("mig-auto-inbox-silent");
    const at = new Date().toISOString();
    const job = createJob(state, {
      name: "Auto-inbox",
      prompt: "p",
      nextRunAt: at,
      templateId: "auto-inbox",
      deliveryPolicy: "always"
    });

    normalizeState(state.instance, state);

    expect(job.deliveryPolicy).toBe("silent");
    expect(job.chatSessionId).toBeString();
    const session = state.chatSessions.find((candidate) => candidate.id === job.chatSessionId);
    expect(session).toMatchObject({
      title: "Auto-inbox",
      kind: "channel",
      origin: "job",
      headless: true,
      agentId: "agent_default"
    });
    expect(session?.archivedAt).toBeUndefined();
    expect(
      state.audit.some((event) => event.action === "auto-inbox.silent-delivery.migrated" && event.evidence?.mintedChannels === 1)
    ).toBe(true);

    const sessionCount = state.chatSessions.length;
    normalizeState(state.instance, state);
    expect(state.chatSessions.length).toBe(sessionCount);
  });

  test("auto-inbox jobs with an existing visible channel keep the channel but hide it", () => {
    const state = createEmptyState("mig-auto-inbox-existing-channel");
    const at = new Date().toISOString();
    const session = createChatSession(state, "Auto-inbox", undefined, "agent_default", "job", "channel");
    const job = createJob(state, {
      name: "Auto-inbox",
      prompt: "p",
      nextRunAt: at,
      templateId: "auto-inbox",
      chatSessionId: session.id
    });

    normalizeState(state.instance, state);

    expect(job.deliveryPolicy).toBe("silent");
    expect(job.chatSessionId).toBe(session.id);
    expect(state.chatSessions.find((candidate) => candidate.id === session.id)?.headless).toBe(true);
    expect(state.chatSessions.filter((candidate) => candidate.title === "Auto-inbox")).toHaveLength(1);
  });
});

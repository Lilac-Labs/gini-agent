// Tests for install_skill / enable_skill / disable_skill dispatch.
// Exercises tool registration plus the happy-path lifecycle (install,
// disable, re-enable) and validation errors.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { sep } from "node:path";
import { dispatchToolCall } from "./tool-dispatch";
import { buildToolCatalog } from "./tool-catalog";
import { createChatSession, createSkill, createTask, mutateState, readState, upsertTask } from "../state";
import type { RuntimeConfig, RuntimeState, SkillRecord, ToolsetRecord } from "../types";

const ROOT = "/tmp/gini-skill-dispatch-test";

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function makeConfig(instance: string): RuntimeConfig {
  return {
    instance,
    port: 0,
    token: "test",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: ROOT,
    stateRoot: ROOT,
    logRoot: `${ROOT}-logs`
  };
}

async function seedTask(config: RuntimeConfig): Promise<string> {
  return mutateState(config.instance, (state) => {
    const task = createTask(state.instance, "test");
    upsertTask(state, task);
    return task.id;
  });
}

function stateWithToolsets(toolsets: ToolsetRecord[]): RuntimeState {
  return {
    version: 1,
    instance: "test",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    tasks: [], authorizations: [], setupRequests: [], audit: [], skills: [], jobs: [],
    connectors: [], improvements: [], skillOutcomes: [], learningFindings: [],
    promotions: [], snapshots: [], tools: [], toolsets, subagents: [],
    mcpServers: [], messagingBridges: [], importReports: [], agents: [],
    activeAgentId: undefined, relays: [], notifications: [], emailWatchers: [], events: [],
    jobRuns: [], chatSessions: [], chatMessages: [], messagingMessages: [],
    runs: [], planSteps: [], usageLedger: []
  };
}

const SKILL_BODY = `---
name: dispatch-test-skill
description: Synthetic skill for dispatch tests.
trigger: When dispatch tests fire.
---

# Dispatch test skill

This skill is created from inside the unit test suite. It does nothing
useful — its body just needs to parse so the manifest validator accepts
it.

## Steps

1. Do nothing.
2. Confirm nothing happened.
`;

describe("skill tool registration", () => {
  test("install_skill registers under 'skills' and requires body", () => {
    const ts: ToolsetRecord = {
      id: "toolset_skills",
      instance: "test",
      name: "skills",
      description: "",
      status: "enabled",
      toolNames: [],
      scopes: ["task"],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    const catalog = buildToolCatalog(stateWithToolsets([ts]));
    const tool = catalog.find((t) => t.function.name === "install_skill");
    expect(tool).toBeDefined();
    expect(tool?.toolset).toBe("skills");
    expect(tool?.function.parameters.required).toEqual(["body"]);
  });

  test("enable_skill registers under 'skills' and requires skillId", () => {
    const ts: ToolsetRecord = {
      id: "toolset_skills",
      instance: "test",
      name: "skills",
      description: "",
      status: "enabled",
      toolNames: [],
      scopes: ["task"],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    const catalog = buildToolCatalog(stateWithToolsets([ts]));
    const tool = catalog.find((t) => t.function.name === "enable_skill");
    expect(tool).toBeDefined();
    expect(tool?.toolset).toBe("skills");
    expect(tool?.function.parameters.required).toEqual(["skillId"]);
  });

  test("disable_skill registers under 'skills' and requires skillId", () => {
    const ts: ToolsetRecord = {
      id: "toolset_skills",
      instance: "test",
      name: "skills",
      description: "",
      status: "enabled",
      toolNames: [],
      scopes: ["task"],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };
    const catalog = buildToolCatalog(stateWithToolsets([ts]));
    const tool = catalog.find((t) => t.function.name === "disable_skill");
    expect(tool).toBeDefined();
    expect(tool?.toolset).toBe("skills");
    expect(tool?.function.parameters.required).toEqual(["skillId"]);
  });
});

describe("install_skill dispatch", () => {
  test("lands a minimal SKILL.md and emits skill.installed audit", async () => {
    const config = makeConfig("install-skill-happy");
    const taskId = await seedTask(config);

    const result = await dispatchToolCall(
      config,
      taskId,
      "install_skill",
      "call_install",
      JSON.stringify({ body: SKILL_BODY })
    );
    expect(result.kind).toBe("sync");
    const skill = readState(config.instance).skills.find((s) => s.name === "dispatch-test-skill");
    expect(skill).toBeDefined();
    if (result.kind === "sync") {
      expect(result.result).toContain(skill!.id);
    }

    // User installs land flat in the instance skills root — no grouping
    // subfolder (and specifically not a "user" one). Category folders are a
    // bundled-skill convention, so a flat user skill carries no category.
    expect(skill!.manifestPath?.endsWith(`${sep}skills${sep}dispatch-test-skill${sep}SKILL.md`)).toBe(true);
    expect(skill!.manifestPath).not.toContain(`${sep}skills${sep}user${sep}`);
    expect(skill!.category).toBeUndefined();

    const audit = readState(config.instance).audit.find(
      (event) => event.action === "skill.installed" && event.actor === "agent" && event.target === skill!.id
    );
    expect(audit).toBeDefined();
    expect(audit?.evidence?.skillId).toBe(skill!.id);
    expect(audit?.evidence?.name).toBe("dispatch-test-skill");
  });

  test("stays flat even when a category arg is passed", async () => {
    const config = makeConfig("install-skill-category");
    const taskId = await seedTask(config);

    // A stray `category` arg is ignored — user skills never nest.
    const result = await dispatchToolCall(
      config,
      taskId,
      "install_skill",
      "call_install_cat",
      JSON.stringify({ body: SKILL_BODY, category: "team-tools" })
    );
    expect(result.kind).toBe("sync");
    const skill = readState(config.instance).skills.find((s) => s.name === "dispatch-test-skill");
    expect(skill).toBeDefined();
    expect(skill!.manifestPath?.endsWith(`${sep}skills${sep}dispatch-test-skill${sep}SKILL.md`)).toBe(true);
    expect(skill!.manifestPath).not.toContain(`${sep}skills${sep}team-tools${sep}`);
    expect(skill!.category).toBeUndefined();
  });

  test("rejects missing body", async () => {
    const config = makeConfig("install-skill-no-body");
    const taskId = await seedTask(config);
    await expect(
      dispatchToolCall(config, taskId, "install_skill", "call_no_body", JSON.stringify({}))
    ).rejects.toThrow(/body/);
  });

  // A near-miss frontmatter (top-level `gini:` block + `requirements` typo)
  // installs fine but its credential declaration is silently dropped. The
  // tool result must surface the warning so the authoring model self-corrects.
  test("surfaces frontmatter warnings in the result for a weather3-style skill", async () => {
    const config = makeConfig("install-skill-warn");
    const taskId = await seedTask(config);
    const body = [
      "---",
      "name: weather3",
      "description: Check the weather.",
      "gini:",
      "  category: user",
      "  requirements:",
      "    credentials:",
      "      - WEATHER3_API_KEY",
      "---",
      "",
      "# Weather3",
      "",
      "Fetch a forecast."
    ].join("\n");
    const result = await dispatchToolCall(config, taskId, "install_skill", "call_warn", JSON.stringify({ body }));
    expect(result.kind).toBe("sync");
    if (result.kind !== "sync") throw new Error("unreachable");
    expect(result.result).toContain("⚠ Frontmatter warnings");
    expect(result.result).toContain("requirements");
    expect(result.result).toContain("requires");
    // Audit evidence carries the warnings too.
    const skill = readState(config.instance).skills.find((s) => s.name === "weather3");
    const audit = readState(config.instance).audit.find(
      (event) => event.action === "skill.installed" && event.target === skill!.id
    );
    expect((audit?.evidence?.frontmatterWarnings as string[] | undefined)?.length).toBeGreaterThan(0);
  });

  test("omits the frontmatter-warnings suffix for a clean skill", async () => {
    const config = makeConfig("install-skill-clean");
    const taskId = await seedTask(config);
    const result = await dispatchToolCall(config, taskId, "install_skill", "call_clean", JSON.stringify({ body: SKILL_BODY }));
    expect(result.kind).toBe("sync");
    if (result.kind !== "sync") throw new Error("unreachable");
    expect(result.result).not.toContain("⚠ Frontmatter warnings");
  });
});

describe("enable_skill / disable_skill dispatch", () => {
  test("disable_skill flips status and writes a disable audit", async () => {
    const config = makeConfig("skill-disable-happy");
    const taskId = await seedTask(config);
    // Install the skill so we have something to flip.
    await dispatchToolCall(
      config,
      taskId,
      "install_skill",
      "call_pre_install",
      JSON.stringify({ body: SKILL_BODY })
    );
    const skill = readState(config.instance).skills.find((s) => s.name === "dispatch-test-skill");
    expect(skill).toBeDefined();

    const result = await dispatchToolCall(
      config,
      taskId,
      "disable_skill",
      "call_disable",
      JSON.stringify({ skillId: skill!.id })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      expect(result.result).toContain("Disabled skill");
      expect(result.result).toContain(skill!.id);
    }

    const after = readState(config.instance).skills.find((s) => s.id === skill!.id);
    expect(after?.status).toBe("disabled");

    const audit = readState(config.instance).audit.find(
      (event) => event.action === "skill.disabled" && event.target === skill!.id
    );
    expect(audit).toBeDefined();
  });

  test("enable_skill flips status back to enabled", async () => {
    const config = makeConfig("skill-enable-happy");
    const taskId = await seedTask(config);
    await dispatchToolCall(
      config,
      taskId,
      "install_skill",
      "call_pre_install2",
      JSON.stringify({ body: SKILL_BODY })
    );
    const skill = readState(config.instance).skills.find((s) => s.name === "dispatch-test-skill");
    expect(skill).toBeDefined();
    // Disable first.
    await dispatchToolCall(
      config,
      taskId,
      "disable_skill",
      "call_disable2",
      JSON.stringify({ skillId: skill!.id })
    );
    // Then re-enable.
    const result = await dispatchToolCall(
      config,
      taskId,
      "enable_skill",
      "call_enable",
      JSON.stringify({ skillId: skill!.id })
    );
    expect(result.kind).toBe("sync");
    if (result.kind === "sync") {
      expect(result.result).toContain("Enabled skill");
    }
    const after = readState(config.instance).skills.find((s) => s.id === skill!.id);
    expect(after?.status).toBe("enabled");
  });

  test("enable_skill rejects unknown skill id", async () => {
    const config = makeConfig("skill-enable-unknown");
    const taskId = await seedTask(config);
    await expect(
      dispatchToolCall(
        config,
        taskId,
        "enable_skill",
        "call_bad",
        JSON.stringify({ skillId: "skill_nope" })
      )
    ).rejects.toThrow(/Skill not found/);
  });
});

describe("enable_skill connector-consent gate", () => {
  async function seedTaskWithWebSession(config: RuntimeConfig): Promise<string> {
    return mutateState(config.instance, (state) => {
      const session = createChatSession(state, "web session");
      const task = createTask(state.instance, "test");
      task.chatSessionId = session.id;
      upsertTask(state, task);
      session.taskIds.push(task.id);
      return task.id;
    });
  }

  // The consent gate fires only when a TYPED credential the skill requires
  // exists (a presence-only connector carries no secret to consent to). Seed a
  // typed api-key named LINEAR_API_KEY so `firstUngrantedCredential` finds it.
  async function seedLinearCredential(config: RuntimeConfig) {
    const at = new Date().toISOString();
    return mutateState(config.instance, (state) => {
      state.connectors.push({
        id: "id_linear_cred",
        instance: state.instance,
        name: "LINEAR_API_KEY",
        provider: "linear",
        type: "api-key",
        status: "configured",
        scopes: [],
        secretRefs: [{ purpose: "LINEAR_API_KEY", path: `${ROOT}/secret.json` }],
        createdAt: at,
        updatedAt: at,
        health: "healthy",
        source: "user"
      });
    });
  }

  async function seedSkill(config: RuntimeConfig, overrides: Partial<SkillRecord>) {
    return mutateState(config.instance, (state) =>
      createSkill(state, {
        name: "credentialed-skill",
        description: "",
        trigger: "",
        steps: [],
        requiredTools: [],
        requiredPermissions: [],
        status: "disabled",
        source: "user",
        requiredCredentials: ["LINEAR_API_KEY"],
        ...overrides
      })
    );
  }

  test("enabling a non-bundled credentialed skill mints a grant SetupRequest (pending)", async () => {
    const config = makeConfig("skill-gate-pending");
    const taskId = await seedTaskWithWebSession(config);
    await seedLinearCredential(config);
    const skill = await seedSkill(config, {});
    const result = await dispatchToolCall(
      config,
      taskId,
      "enable_skill",
      "call_gate",
      JSON.stringify({ skillId: skill.id })
    );
    expect(result.kind).toBe("pending");
    const state = readState(config.instance);
    const setup = state.setupRequests.find((s) => s.action === "skill.grant_connector");
    expect(setup).toBeDefined();
    expect(setup?.payload.skillId).toBe(skill.id);
    // Payload carries the credential NAME.
    expect(setup?.payload.credentialName).toBe("LINEAR_API_KEY");
    // Skill must NOT be enabled yet — consent first.
    expect(state.skills.find((s) => s.id === skill.id)?.status).toBe("disabled");
  });

  test("enabling a bundled credentialed skill enables immediately (auto-grant)", async () => {
    const config = makeConfig("skill-gate-bundled");
    const taskId = await seedTaskWithWebSession(config);
    const skill = await seedSkill(config, { name: "bundled-skill", source: "bundled" });
    const result = await dispatchToolCall(
      config,
      taskId,
      "enable_skill",
      "call_bundled",
      JSON.stringify({ skillId: skill.id })
    );
    expect(result.kind).toBe("sync");
    expect(readState(config.instance).skills.find((s) => s.id === skill.id)?.status).toBe("enabled");
  });

  test("enabling an already-granted credentialed skill enables immediately", async () => {
    const config = makeConfig("skill-gate-granted");
    const taskId = await seedTaskWithWebSession(config);
    const skill = await seedSkill(config, { name: "granted-skill", grantedConnectors: ["LINEAR_API_KEY"] });
    const result = await dispatchToolCall(
      config,
      taskId,
      "enable_skill",
      "call_granted",
      JSON.stringify({ skillId: skill.id })
    );
    expect(result.kind).toBe("sync");
    expect(readState(config.instance).skills.find((s) => s.id === skill.id)?.status).toBe("enabled");
  });

  test("enabling a credentialed skill over Telegram returns a sync error (no setup row)", async () => {
    const config = makeConfig("skill-gate-telegram");
    await seedLinearCredential(config);
    const skill = await seedSkill(config, { name: "tg-skill" });
    const taskId = await mutateState(config.instance, (state) => {
      const session = createChatSession(state, "tg session", {
        kind: "telegram",
        bridgeId: "bridge_t",
        chatId: 123,
        target: "123"
      });
      const task = createTask(state.instance, "test");
      task.chatSessionId = session.id;
      upsertTask(state, task);
      session.taskIds.push(task.id);
      return task.id;
    });
    const result = await dispatchToolCall(
      config,
      taskId,
      "enable_skill",
      "call_tg",
      JSON.stringify({ skillId: skill.id })
    );
    expect(result.kind).toBe("sync");
    if (result.kind !== "sync") throw new Error("unreachable");
    const parsed = JSON.parse(result.result) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("web chat");
    expect(readState(config.instance).setupRequests.some((s) => s.action === "skill.grant_connector")).toBe(false);
  });

  test("enabling a credentialed skill in a job-origin session returns a sync error (no setup row)", async () => {
    const config = makeConfig("skill-gate-job");
    await seedLinearCredential(config);
    const skill = await seedSkill(config, { name: "job-skill" });
    const taskId = await mutateState(config.instance, (state) => {
      // Scheduled/headless dedicated job session: origin:"job", no source.
      const session = createChatSession(state, "job session", undefined, undefined, "job");
      const task = createTask(state.instance, "test");
      task.chatSessionId = session.id;
      upsertTask(state, task);
      session.taskIds.push(task.id);
      return task.id;
    });
    const result = await dispatchToolCall(
      config,
      taskId,
      "enable_skill",
      "call_job",
      JSON.stringify({ skillId: skill.id })
    );
    expect(result.kind).toBe("sync");
    if (result.kind !== "sync") throw new Error("unreachable");
    const parsed = JSON.parse(result.result) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("web chat");
    expect(readState(config.instance).setupRequests.some((s) => s.action === "skill.grant_connector")).toBe(false);
  });

  test("re-entering enable_skill while a grant is pending references the existing request (no duplicate)", async () => {
    const config = makeConfig("skill-gate-dedupe");
    const taskId = await seedTaskWithWebSession(config);
    await seedLinearCredential(config);
    const skill = await seedSkill(config, {});
    const first = await dispatchToolCall(
      config,
      taskId,
      "enable_skill",
      "call_dedupe_1",
      JSON.stringify({ skillId: skill.id })
    );
    expect(first.kind).toBe("pending");
    const existing = readState(config.instance).setupRequests.filter((s) => s.action === "skill.grant_connector");
    expect(existing.length).toBe(1);

    const second = await dispatchToolCall(
      config,
      taskId,
      "enable_skill",
      "call_dedupe_2",
      JSON.stringify({ skillId: skill.id })
    );
    expect(second.kind).toBe("pending");
    if (second.kind !== "pending") throw new Error("unreachable");
    // Same request id, no duplicate row.
    expect(second.approvalId).toBe(existing[0].id);
    expect(
      readState(config.instance).setupRequests.filter((s) => s.action === "skill.grant_connector").length
    ).toBe(1);
  });

  test("two different tasks enabling the same skill each get their own grant request", async () => {
    const config = makeConfig("skill-gate-cross-task");
    const taskA = await seedTaskWithWebSession(config);
    const taskB = await seedTaskWithWebSession(config);
    await seedLinearCredential(config);
    const skill = await seedSkill(config, {});

    const first = await dispatchToolCall(
      config,
      taskA,
      "enable_skill",
      "call_taskA",
      JSON.stringify({ skillId: skill.id })
    );
    expect(first.kind).toBe("pending");
    if (first.kind !== "pending") throw new Error("unreachable");

    const second = await dispatchToolCall(
      config,
      taskB,
      "enable_skill",
      "call_taskB",
      JSON.stringify({ skillId: skill.id })
    );
    expect(second.kind).toBe("pending");
    if (second.kind !== "pending") throw new Error("unreachable");

    // Each task gets its OWN resumable approval — the dedupe is per-task, so a
    // second task does not park on the first task's card (which would resume
    // only the first task on completion, stranding the second).
    expect(second.approvalId).not.toBe(first.approvalId);
    const rows = readState(config.instance).setupRequests.filter((s) => s.action === "skill.grant_connector");
    expect(rows.length).toBe(2);
    const reqA = rows.find((s) => s.id === first.approvalId);
    const reqB = rows.find((s) => s.id === second.approvalId);
    expect(reqA?.taskId).toBe(taskA);
    expect(reqB?.taskId).toBe(taskB);
  });
});

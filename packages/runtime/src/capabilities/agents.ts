import type { AgentRecord, RuntimeConfig } from "../types";
import {
  activateAgent,
  bankIdForAgent,
  createAgentRecord,
  deleteBankAndUnits,
  deleteChatSession,
  ensureAgentBank,
  mutateState,
  readState
} from "../state";
import { addAudit } from "../state/audit";
import { listEmailWatchers, removeEmailWatcher, setEmailTriageEnabled } from "../state/email-watchers";
import { now } from "../state/ids";
import { providerCatalog } from "../provider";
import { renameSeededSoulName, seedAgentSoulFile } from "../runtime/identity-files";
import { DEFAULT_AGENT_TOOLSETS } from "../state/defaults";

export function listAgents(config: RuntimeConfig) {
  const state = readState(config.instance);
  return { activeAgentId: state.activeAgentId, defaultAgentId: "agent_default", agents: state.agents };
}

export async function createAgent(config: RuntimeConfig, input: Record<string, unknown>) {
  // The name is seeded into the agent's SOUL.md (`Your name is <name>.`)
  // and surfaced in the runtime-identity block, so collapse every
  // whitespace run (incl. embedded \n/\r/\t) to a single space and trim —
  // this keeps the stored name a clean single-line label and rejects
  // whitespace-only input.
  const name = String(input.name ?? "").replace(/\s+/g, " ").trim();
  if (!name) throw new Error("Agent name is required.");
  const record = await mutateState(config.instance, (state) => {
    // Config (provider, toolsets, memory scopes, messaging targets) is
    // copied from the default agent when the caller doesn't supply it.
    // The CLI doesn't pass these — without this fallback, new agents
    // ended up with undefined provider fields and silently fell through
    // to config.provider at runtime, contradicting the "agent owns
    // provider" design.
    //
    // Memory and hindsight content is NOT copied: agents start empty.
    // Only the *config* is inherited from the default agent.
    // "profile_default" is the legacy pre-rename id for the default agent
    // — the same pair of ids the boot seeding and the default-model write
    // target. Without the fallback, agents created on a legacy instance
    // inherit no provider pair and silently follow config.provider.
    const defaultAgent =
      state.agents.find((agent) => agent.id === "agent_default") ??
      state.agents.find((agent) => agent.id === "profile_default");
    // When the caller doesn't supply toolsets, union the current desired
    // default list into whatever the default agent has on disk. This keeps
    // newly-created sibling agents on an old instance (where
    // `agent_default.toolsets` predates a new addition like `browser`)
    // from inheriting the stale list. The migration in
    // `migrateDefaultAgentToolsets` already widens `agent_default` itself
    // on read, but this defends against creation paths that fire before
    // the next normalize.
    // Union the canonical DEFAULT_AGENT_TOOLSETS list into whatever the
    // default agent has on disk. This keeps newly-created sibling agents
    // on an old instance (where `agent_default.toolsets` predates a new
    // addition like `browser`) from inheriting the stale list. The
    // migration in `migrateDefaultAgentToolsets` widens `agent_default`
    // itself on read, but this defends against creation paths that fire
    // before the next normalize.
    const fallbackToolsets = (() => {
      const seed = Array.isArray(defaultAgent?.toolsets) ? [...defaultAgent.toolsets] : [];
      const known = new Set(seed);
      for (const name of DEFAULT_AGENT_TOOLSETS) {
        if (!known.has(name)) {
          seed.push(name);
          known.add(name);
        }
      }
      return seed;
    })();
    return createAgentRecord(state, {
      name,
      providerName: typeof input.providerName === "string"
        ? input.providerName as never
        : defaultAgent?.providerName,
      model: typeof input.model === "string"
        ? input.model
        : defaultAgent?.model,
      toolsets: Array.isArray(input.toolsets)
        ? input.toolsets.map(String)
        : fallbackToolsets,
      messagingTargets: Array.isArray(input.messagingTargets)
        ? input.messagingTargets.map(String)
        : (defaultAgent?.messagingTargets ?? []),
      // Ambient-memory switch: only an explicit false is stored (absent ⇒
      // on). Deliberately NOT inherited from the default agent — opting a
      // purpose-built agent out of memory says nothing about siblings.
      ...(input.autoMemory === false ? { autoMemory: false } : {})
    });
  });
  // Phase C — eagerly create the per-agent bank so the new agent starts
  // with an *empty* memory pool. Config copied at creation, content NOT:
  // there's no copying of memories or hindsight units from the default
  // agent or any other agent.
  ensureAgentBank(config.instance, record.id);
  // Seed the per-agent SOUL.md with `Your name is <name>.` so the new
  // agent self-identifies by its own name (INSTRUCTIONS.md is generic).
  // Order matters: state has already been persisted, so a crash here
  // can never leave a SOUL.md for a non-existent agent.
  seedAgentSoulFile(config.instance, record.id, record.name);
  return record;
}

export async function useAgent(config: RuntimeConfig, idOrName: string) {
  return mutateState(config.instance, (state) => activateAgent(state, idOrName));
}

// Rename an agent. `AgentRecord.name` is the authoritative label (drives
// the switcher, list, `use_agent <name>`, and the `- agent:` identity
// block). The folder + Hindsight bank are keyed by the stable opaque id,
// so a rename never moves them. After the state write we best-effort sync
// the agent's seeded SOUL.md name line — but only when the SOUL is exactly
// the untouched seed (`renameSeededSoulName`); a customized persona is left
// to the model/user.
export async function renameAgent(
  config: RuntimeConfig,
  idOrName: string,
  rawName: string
) {
  // Collapse every whitespace run to a single space and trim — same
  // hygiene as `createAgent`, so the stored name stays a clean single-line
  // label and a whitespace-only rename is rejected.
  const newName = String(rawName ?? "").replace(/\s+/g, " ").trim();
  if (!newName) throw new Error("New agent name is required.");
  // "default" is the sentinel the `renameDefaultAgentToGini` migration keys
  // on: it flips an `agent_default` row named "default" back to "Gini" on the
  // next state read, which would drift the AgentRecord name away from a SOUL
  // that says "default". Reject it outright rather than let the rename silently
  // un-stick.
  if (newName === "default") throw new Error('"default" is a reserved name.');
  // Resolve id-first, then fall back to name, so an agent whose NAME happens
  // to equal another agent's id can't shadow the intended target.
  const found = readState(config.instance).agents;
  const target = found.find((a) => a.id === idOrName) ?? found.find((a) => a.name === idOrName);
  if (!target) throw new Error(`Agent not found: ${idOrName}`);
  // No-op a rename to the current name: skip the state write, audit, and SOUL
  // sync so an identity rename doesn't bump updatedAt or log a from===to event.
  if (target.name === newName) return target;
  const result = await mutateState(config.instance, (state) => {
    const agent = state.agents.find((a) => a.id === target.id);
    if (!agent) throw new Error(`Agent not found: ${idOrName}`);
    const oldName = agent.name;
    agent.name = newName;
    agent.updatedAt = now();
    addAudit(
      state,
      {
        actor: "user",
        action: "agent.renamed",
        target: agent.id,
        risk: "low",
        evidence: { from: oldName, to: newName, agentId: agent.id }
      },
      { agentId: agent.id }
    );
    return { record: agent, oldName };
  });
  // Keep the seeded SOUL.md name line in sync outside the state write.
  // Best-effort: never clobbers a customized SOUL (see renameSeededSoulName).
  renameSeededSoulName(config.instance, result.record.id, result.oldName, newName);
  return result.record;
}

// Set (or clear) an agent's provider/model override. `AgentRecord.providerName`
// + `model` are the per-agent control surface that resolveEffectiveContext
// reads (see ADR agents-replace-profiles.md): an override applies only when
// BOTH fields are set, so this helper enforces that pairing rather than letting
// a half-configured agent silently fall through to the instance default.
//
// Modes:
//   - SET — both providerName and model present. Validate the provider name
//     against the catalog and store both; the chat path then routes this
//     agent's inference through the chosen provider.
//   - CLEAR — both absent/blank. Drop the override so the agent inherits the
//     instance default again (providerSource flips back to "instance").
//   - A lone providerName or model is rejected ("Invalid input" → 400) instead
//     of being half-applied.
//
// Credentials are NOT managed here. API keys and AWS access keys live in
// secrets.env; Codex auth lives in ~/.codex — all instance-level. This helper only selects
// which provider/model the agent uses. It validates the provider NAME against
// the catalog but does not require the provider to be configured — the
// configured-only restriction is a UI affordance (see ADR
// per-agent-provider-settings.md). A no-op (the agent already carries the
// requested selection) skips the state write, audit, and updatedAt bump —
// same hygiene as renameAgent.
export async function setAgentProvider(
  config: RuntimeConfig,
  idOrName: string,
  input: Record<string, unknown>
): Promise<AgentRecord> {
  const providerName = typeof input.providerName === "string" ? input.providerName.trim() : "";
  const model = typeof input.model === "string" ? input.model.trim() : "";
  if (providerName && !model) {
    throw new Error("Invalid input: model is required when providerName is set.");
  }
  if (!providerName && model) {
    throw new Error("Invalid input: providerName is required when model is set.");
  }
  if (providerName) {
    const known = new Set(providerCatalog().map((item) => item.name));
    if (!known.has(providerName)) {
      throw new Error(`Invalid input: unknown provider '${providerName}'.`);
    }
  }
  // Resolve id-first, then name, so an agent whose NAME happens to equal
  // another agent's id can't shadow the intended target (same rule as
  // renameAgent).
  const agents = readState(config.instance).agents;
  const target = agents.find((a) => a.id === idOrName) ?? agents.find((a) => a.name === idOrName);
  if (!target) throw new Error(`Agent not found: ${idOrName}`);
  const nextProvider = providerName ? (providerName as AgentRecord["providerName"]) : undefined;
  const nextModel = model || undefined;
  return mutateState(config.instance, (state) => {
    const agent = state.agents.find((a) => a.id === target.id);
    if (!agent) throw new Error(`Agent not found: ${idOrName}`);
    // No-op when the selection is unchanged: return without bumping updatedAt
    // or writing an audit row so a redundant save doesn't churn history. The
    // check lives inside mutateState (the serialized write boundary) so two
    // concurrent identical calls can't both slip past it and emit duplicate
    // agent.provider_set audit rows.
    if (agent.providerName === nextProvider && agent.model === nextModel) {
      return agent;
    }
    const from = { providerName: agent.providerName, model: agent.model };
    agent.providerName = nextProvider;
    agent.model = nextModel;
    agent.updatedAt = now();
    addAudit(
      state,
      {
        actor: "user",
        action: "agent.provider_set",
        target: agent.id,
        risk: "low",
        evidence: { from, to: { providerName: nextProvider, model: nextModel }, agentId: agent.id }
      },
      { agentId: agent.id }
    );
    return agent;
  });
}

// Set (or clear) an agent's ambient-memory switch. `autoMemory: false` makes
// chat turns for this agent skip auto-recall and auto-retain (see the
// AgentRecord field comment); `autoMemory: true` restores the default. The
// record stores only the explicit `false` — restoring deletes the field so
// state.json doesn't accumulate redundant `autoMemory: true` rows. Memory
// TOOLS are untouched: they're governed by the agent's toolsets. A no-op
// (already in the requested mode) skips the state write, audit, and
// updatedAt bump — same hygiene as renameAgent/setAgentProvider.
export async function setAgentMemory(
  config: RuntimeConfig,
  idOrName: string,
  input: Record<string, unknown>
): Promise<AgentRecord> {
  if (typeof input.autoMemory !== "boolean") {
    throw new Error("Invalid input: autoMemory must be a boolean.");
  }
  const autoMemory = input.autoMemory;
  // Resolve id-first, then name, so an agent whose NAME happens to equal
  // another agent's id can't shadow the intended target (same rule as
  // renameAgent).
  const agents = readState(config.instance).agents;
  const target = agents.find((a) => a.id === idOrName) ?? agents.find((a) => a.name === idOrName);
  if (!target) throw new Error(`Agent not found: ${idOrName}`);
  return mutateState(config.instance, (state) => {
    const agent = state.agents.find((a) => a.id === target.id);
    if (!agent) throw new Error(`Agent not found: ${idOrName}`);
    const current = agent.autoMemory !== false;
    if (current === autoMemory) return agent;
    if (autoMemory) {
      delete agent.autoMemory;
    } else {
      agent.autoMemory = false;
    }
    agent.updatedAt = now();
    addAudit(
      state,
      {
        actor: "user",
        action: "agent.memory_set",
        target: agent.id,
        risk: "low",
        evidence: { autoMemory, agentId: agent.id }
      },
      { agentId: agent.id }
    );
    return agent;
  });
}

// Hard-deletes an agent and cascades cleanup across its memory pools.
// Guards:
//   - The default agent (`agent_default`) cannot be deleted.
//   - The active agent cannot be deleted — the caller must switch first.
//   - Unknown agent id/name throws (mapped to 404 by the HTTP layer).
// Cascade:
//   - The agent's conversation surfaces — its Chat (`kind:"agent"`) and
//     every Topic (`kind:"topic"`) it owns — are deleted with their
//     chat_blocks (ADR chat-topics-tasks-subagents.md Decision D). Job
//     channels (`kind:"channel"`) are deliberately left untouched; the
//     job lifecycle detaches them separately. Removing the topic rows here
//     is what keeps normalizeState's orphan-rehome pass from re-stamping a
//     deleted agent's Topics onto another agent.
//   - The agent's email-watch cluster — every EmailWatcherRecord it owns
//     (via removeEmailWatcher, which tears down the shared backing job +
//     per-concern channels as the last watcher goes) and its whole-inbox
//     triage opt-in (via setEmailTriageEnabled(false)). Without this, the
//     watchers strand under a now-dead agentId and the shared "Email watch"
//     job keeps polling. Done BEFORE the row-removal mutateState below
//     because those helpers run their own mutateState passes.
//   - Per-agent Hindsight bank (`bank_${agentId}`) + all units in it.
//   - The agent row is removed from `state.agents`.
// The legacy `state.memories` per-agent purge was removed alongside the
// state.memories consolidation (see ADR runtime-identity-files.md);
// USER.md is instance-scoped (no per-agent purge needed) and SOUL.md
// lives under `agents/<agentId>/SOUL.md` on disk — its filesystem
// cleanup is left to the operator since the file may carry hand-edited
// content worth preserving.
// Returns counts so callers/tests can verify the cascade scope. A single
// audit event records the deletion + cleanup counts.
export async function deleteAgent(
  config: RuntimeConfig,
  idOrName: string
): Promise<{ ok: true; id: string; unitsDeleted: number; bankDeleted: boolean }> {
  // Resolve + guard up front so the email-watch teardown (which runs its own
  // mutateState passes and so can't live inside the single removal block
  // below) only fires for a deletable agent. The same guards are re-checked
  // inside the removal mutateState as the atomic safety net.
  const target = (() => {
    const state = readState(config.instance);
    const agent = state.agents.find((item) => item.id === idOrName || item.name === idOrName);
    if (!agent) throw new Error(`Agent not found: ${idOrName}`);
    if (agent.id === "agent_default") {
      throw new Error("Cannot delete the default agent.");
    }
    if (state.activeAgentId === agent.id) {
      throw new Error("Cannot delete the active agent; switch to another agent first.");
    }
    return agent;
  })();

  // Tear down the agent's email-watch cluster before the row is removed so
  // nothing is orphaned under a dead agentId. removeEmailWatcher rebuilds /
  // tears down the shared job + per-concern channels as each (last) watcher
  // goes; setEmailTriageEnabled(false) tears down a triage-only job + channel
  // if the agent had opted in.
  for (const watcher of listEmailWatchers(config).filter((w) => w.agentId === target.id)) {
    await removeEmailWatcher(config, watcher.id);
  }
  await setEmailTriageEnabled(config, target.id, false);

  const result = await mutateState(config.instance, (state) => {
    const agent = state.agents.find((item) => item.id === idOrName || item.name === idOrName);
    if (!agent) throw new Error(`Agent not found: ${idOrName}`);
    if (agent.id === "agent_default") {
      throw new Error("Cannot delete the default agent.");
    }
    if (state.activeAgentId === agent.id) {
      throw new Error("Cannot delete the active agent; switch to another agent first.");
    }
    // Delete the agent's conversation surfaces — its Chat (`kind:"agent"`)
    // and every Topic (`kind:"topic"`) it owns. Without this, those rows
    // survive the agent and normalizeState's orphan-rehome pass re-stamps
    // them onto the default agent, piling duplicate Topics into another
    // agent's list. Job channels (`kind:"channel"`) are left alone — they
    // have their own lifecycle. Collect the ids first so we don't mutate
    // `state.chatSessions` while iterating it.
    const surfaceIds = state.chatSessions
      .filter(
        (session) =>
          session.agentId === agent.id &&
          (session.kind === "agent" || session.kind === "topic")
      )
      .map((session) => session.id);
    for (const id of surfaceIds) deleteChatSession(state, id);
    state.agents = state.agents.filter((item) => item.id !== agent.id);
    return { id: agent.id, name: agent.name };
  });

  // Drop the per-agent Hindsight bank + its units outside the JSON state
  // transaction. SQLite is the source of truth for hindsight, so a single
  // BEGIN/COMMIT block there is the only consistency boundary we need.
  const { unitsDeleted, bankDeleted } = deleteBankAndUnits(
    config.instance,
    bankIdForAgent(result.id)
  );

  // Single audit event covering the whole cascade. Routed through a
  // follow-up mutateState so the cleanup counts are visible alongside
  // hindsight bookkeeping; the agent removal itself is already logged by
  // the state mutation above via state.agents membership change.
  await mutateState(config.instance, (state) => {
    // The deleted agent is the subject — attribute the audit to it so the
    // deletion event lands in that agent's own historical inbox rather
    // than the currently-active one.
    addAudit(
      state,
      {
        actor: "user",
        action: "agent.deleted",
        target: result.id,
        risk: "medium",
        evidence: {
          name: result.name,
          unitsDeleted,
          bankDeleted
        }
      },
      { agentId: result.id }
    );
    return result.id;
  });

  return {
    ok: true,
    id: result.id,
    unitsDeleted,
    bankDeleted
  };
}

// Soft-deletes an agent by stamping `archivedAt`. The agent stays in
// `state.agents` (its memory pool and history are preserved) but moves to
// the UI's Archived section, can't be activated until restored, and has its
// scheduled jobs suppressed by runDueJobs.
// Guards:
//   - The default agent (`agent_default`) cannot be archived — it's the
//     always-present fallback selection.
//   - Unknown agent id/name throws (mapped to 404 by the HTTP layer).
// The active agent CAN be archived: archiving the current selection hands
// "active" back to the default agent (via activateAgent) so the active
// pointer, per-agent statuses, and the agent.activated audit stay consistent.
// A no-op (already archived) returns the record without bumping updatedAt or
// writing a second audit row.
export async function archiveAgent(
  config: RuntimeConfig,
  idOrName: string
): Promise<AgentRecord> {
  return mutateState(config.instance, (state) => {
    const agent = state.agents.find((item) => item.id === idOrName || item.name === idOrName);
    if (!agent) throw new Error(`Agent not found: ${idOrName}`);
    if (agent.id === "agent_default") {
      throw new Error("Cannot archive the default agent.");
    }
    if (agent.archivedAt) return agent;
    const wasActive = state.activeAgentId === agent.id;
    agent.archivedAt = now();
    agent.updatedAt = now();
    // The archived agent is the subject — attribute the audit to it so the
    // event lands in that agent's own historical inbox.
    addAudit(
      state,
      {
        actor: "user",
        action: "agent.archived",
        target: agent.id,
        risk: "low",
        evidence: { name: agent.name, agentId: agent.id }
      },
      { agentId: agent.id }
    );
    // Archiving the active selection leaves the instance without an active
    // agent; hand "active" back to the always-present default so statuses,
    // `activeAgentId`, and the agent.activated audit are set consistently.
    if (wasActive) {
      activateAgent(state, "agent_default");
    }
    return agent;
  });
}

// Restores an archived agent by clearing `archivedAt`. The agent returns to
// the active list but stays inactive — restoration never auto-activates it.
// Unknown agent id/name throws; a no-op (not archived) returns the record
// without bumping updatedAt or writing an audit row.
export async function unarchiveAgent(
  config: RuntimeConfig,
  idOrName: string
): Promise<AgentRecord> {
  return mutateState(config.instance, (state) => {
    const agent = state.agents.find((item) => item.id === idOrName || item.name === idOrName);
    if (!agent) throw new Error(`Agent not found: ${idOrName}`);
    if (!agent.archivedAt) return agent;
    delete agent.archivedAt;
    agent.updatedAt = now();
    addAudit(
      state,
      {
        actor: "user",
        action: "agent.unarchived",
        target: agent.id,
        risk: "low",
        evidence: { name: agent.name, agentId: agent.id }
      },
      { agentId: agent.id }
    );
    return agent;
  });
}

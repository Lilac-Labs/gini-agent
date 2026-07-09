import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import type { Authorization, ConnectorRecord, Instance, ProviderConfig, RuntimeConfig, RuntimeState, SetupRequest, SetupRequestAction, SetupRequestStatus, TaskStatus } from "../types";
import { ensureDir, instanceRoot, statePath } from "../paths";
import { now } from "./ids";
import { defaultAgent, defaultTools, defaultToolsets } from "./defaults";
import { addAudit } from "./audit";
import { createChatSession } from "./records";
import { getMemoryDb, memoryDbPath } from "./memory-db";
import { canonicalCredentialName, getProvider } from "../integrations/connectors/registry";

// Shared terminal-status predicate. Every site that mutates
// `task.status` should check this before flipping so a cancelled /
// failed / completed task isn't resurrected by a stale in-flight
// code path. Returns `true` for the three terminal states in the
// TaskStatus union.
export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function createEmptyState(instance: Instance): RuntimeState {
  const at = now();
  return {
    version: 1,
    instance,
    createdAt: at,
    updatedAt: at,
    tasks: [],
    authorizations: [],
    setupRequests: [],
    audit: [],
    skills: [],
    jobs: [],
    connectors: [
      {
        id: "id_demo",
        instance,
        name: "Demo Connector",
        provider: "demo",
        status: "configured",
        scopes: ["demo:read"],
        secretRefs: [],
        createdAt: at,
        updatedAt: at,
        health: "unknown",
        source: "user"
      }
    ],
    improvements: [],
    skillOutcomes: [],
    learningFindings: [],
    promotions: [],
    snapshots: [],
    tools: defaultTools(instance, at),
    toolsets: defaultToolsets(instance, at),
    subagents: [],
    mcpServers: [],
    messagingBridges: [],
    importReports: [],
    agents: [defaultAgent(instance, at)],
    activeAgentId: "agent_default",
    relays: [],
    notifications: [],
    emailWatchers: [],
    sentDrafts: [],
    events: [],
    jobRuns: [],
    usageLedger: [],
    chatSessions: [],
    chatMessages: [],
    messagingMessages: [],
    runs: [],
    planSteps: [],
    tunnel: null
  };
}

export function readState(instance: Instance): RuntimeState {
  ensureDir(instanceRoot(instance));
  const path = statePath(instance);
  if (!existsSync(path)) {
    const state = createEmptyState(instance);
    writeState(instance, state);
    return state;
  }
  const state = JSON.parse(readFileSync(path, "utf8")) as RuntimeState;
  return normalizeState(instance, state);
}

// Monotonic per-process counter that keys each write's temp file. Combined
// with the pid it makes the temp path unique to a single writeState call.
let writeStateSeq = 0;

export function writeState(instance: Instance, state: RuntimeState): void {
  ensureDir(instanceRoot(instance));
  state.updatedAt = now();
  const path = statePath(instance);
  // Per-write temp filename, NOT a shared `${path}.tmp`. The single-process
  // model serializes intra-process writes (see mutateState below), but two
  // processes can briefly overlap — a supervisor respawn racing a draining
  // incumbent, or an update handoff. With a shared temp name, writer A's
  // renameSync consumes the temp and writer B's renameSync then ENOENTs.
  // pid + a monotonic counter keys the temp to this call so concurrent
  // writers never touch each other's temp; renameSync stays atomic, so a
  // reader still sees the prior or next state, never a torn write.
  const tempPath = `${path}.${process.pid}.${(writeStateSeq += 1)}.tmp`;
  // Durability, not just atomicity. renameSync is atomic — a reader sees the
  // prior or next file, never a torn one — but atomicity is NOT durability.
  // With ext4 delayed allocation, writeFileSync leaves the JSON in page cache
  // while the rename's metadata can still commit to the journal; a power loss
  // (or a hard guest poweroff mid-write) then replays the rename over data
  // blocks that were never written, leaving a correctly-sized, ALL-ZERO
  // state.json that fails JSON.parse on the next boot (a runtime-fatal crash
  // loop). fsync the temp's DATA to stable storage before the rename, and the
  // directory entry after, so a crash yields the old file or the complete new
  // one — never zeros.
  const fd = openSync(tempPath, "w");
  try {
    writeSync(fd, `${JSON.stringify(state, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tempPath, path);
  } catch (error) {
    // A unique temp name means a failed rename would otherwise leave the temp
    // behind to accumulate; clean it up best-effort and surface the original
    // error to the caller.
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // Cleanup is best-effort; the rename error is the one that matters.
    }
    throw error;
  }
  // Persist the directory entry the rename created, so the name -> new-inode
  // link is itself durable even if the parent dir's metadata was still cached.
  fsyncDir(instanceRoot(instance));
}

// fsync a directory so a create/rename within it survives a power loss. Best
// effort: some filesystems reject fsync on a read-only directory fd, and the
// file-level fsync above is the guarantee that actually protects state
// contents — this only hardens the rename's visibility.
function fsyncDir(dir: string): void {
  let dfd: number | undefined;
  try {
    dfd = openSync(dir, "r");
    fsyncSync(dfd);
  } catch {
    // Directory fsync is a best-effort durability boost; ignore if the
    // platform disallows it.
  } finally {
    if (dfd !== undefined) closeSync(dfd);
  }
}

// Per-instance serialization queue. mutateState is async so concurrent callers
// from independent async tasks (HTTP handlers, scheduler ticks, subagents,
// messaging bridges) never interleave their read-modify-write windows on the
// same instance. Single-process per-instance is the deployment model, so an
// in-process promise chain is sufficient — no file lock or semaphore needed.
//
// Reads (readState) stay lock-free because the file is written atomically
// (writeFileSync to .tmp + renameSync) so a reader either sees the prior
// state or the next state, never a torn write.
const instanceLocks = new Map<Instance, Promise<unknown>>();

// Public seed/migration entrypoint. Called at boot from `install()` so the
// default agent picks up `gini run --provider X` on fresh instances and
// migrates legacy davao-style instances away from the leaked echo
// defaults. Idempotent — calling it twice with the same inputs is a no-op.
// Writes back to disk only when something actually changed.
export async function seedDefaultAgentFromRuntimeConfig(config: RuntimeConfig): Promise<void> {
  await mutateState(config.instance, (state) => {
    seedDefaultAgentFromConfig(state, config.provider);
  });
}

export async function mutateState<T>(instance: Instance, fn: (state: RuntimeState) => T): Promise<T> {
  const previous = instanceLocks.get(instance) ?? Promise.resolve();
  const next = previous.then(() => {
    const state = readState(instance);
    const result = fn(state);
    writeState(instance, state);
    return result;
  });
  // Store a chained promise that swallows errors so a failed mutation does
  // not poison the queue for subsequent callers; the original error still
  // propagates to the caller via the returned `next`.
  instanceLocks.set(instance, next.catch(() => undefined));
  return next;
}

// Pre-rename state files persisted a `lane` field on every record (top-level
// state.lane plus a lane field on every Task/Audit/Memory/Skill/etc.). After
// the lane→instance rename these files still exist on disk; we rewrite them
// in-place when first read. mutateState's read-modify-write cycle persists
// the cleaned shape on the next mutation. Idempotent: records that already
// carry an `instance` field are left alone.
function migrateLaneFieldToInstance(state: RuntimeState): void {
  const stateAny = state as unknown as { lane?: unknown; instance?: unknown };
  if (stateAny.lane !== undefined && stateAny.instance === undefined) {
    stateAny.instance = stateAny.lane;
  }
  delete stateAny.lane;

  const collectionKeys: Array<keyof RuntimeState | "approvals"> = [
    "tasks",
    // Legacy collection. Pre-split state files might still carry it; the
    // approvals→authorizations/setupRequests partitioner runs later in
    // normalizeState, but we still strip lane fields off any rows that
    // landed here first.
    "approvals",
    "audit",
    "skills",
    "jobs",
    "connectors",
    "improvements",
    "promotions",
    "snapshots",
    "tools",
    "toolsets",
    "subagents",
    "mcpServers",
    "messagingBridges",
    "importReports",
    "agents",
    "relays",
    "notifications",
    "events",
    "jobRuns",
    "chatSessions",
    "chatMessages",
    "messagingMessages",
    "runs",
    "planSteps",
    "authorizations",
    "setupRequests"
  ];
  for (const key of collectionKeys) {
    const records = (state as unknown as Record<string, unknown>)[key];
    if (!Array.isArray(records)) continue;
    for (const record of records) {
      if (!record || typeof record !== "object") continue;
      const rec = record as { lane?: unknown; instance?: unknown };
      if (rec.lane !== undefined && rec.instance === undefined) {
        rec.instance = rec.lane;
      }
      delete rec.lane;
    }
  }
}

// ADR connector-provider-spec-compliance.md renamed `state.identities` → `state.connectors` and each
// record's `kind` → `provider`. State files written before that rename
// still carry the old keys; rewrite them in-place so mutateState persists
// the new shape on the next write. No back-compat shim is exposed outside
// this normalizer.
function migrateIdentitiesToConnectors(state: RuntimeState): void {
  const stateAny = state as unknown as { connectors?: unknown; identities?: unknown };
  if (stateAny.identities !== undefined && stateAny.connectors === undefined) {
    stateAny.connectors = stateAny.identities;
  }
  delete stateAny.identities;
  if (Array.isArray(state.connectors)) {
    for (const connector of state.connectors) {
      const rec = connector as unknown as { kind?: unknown; provider?: unknown; secretRefs?: unknown };
      if (rec.kind !== undefined && rec.provider === undefined) {
        rec.provider = rec.kind;
      }
      delete rec.kind;
      connector.secretRefs ??= [];
      // Auto-detection landed after the original ConnectorRecord shape;
      // pre-existing records were all created via the user-driven CRUD
      // path, so default `source: "user"`. The detection job stamps
      // "auto" when it materializes a new record.
      connector.source ??= "user";
    }
  }
}

// The split of Approval into Authorization (agent-actor) + SetupRequest
// (user-actor) lives in docs/adr/authorization-vs-setup-request.md. Pre-split
// state files persisted a single `state.approvals` array. On first read we
// partition it by action — browser.connect / connector.request /
// browser.fill_secret become SetupRequest rows (status remapped from the
// pending/approved/denied trio to pending/completed/cancelled), everything
// else becomes Authorization. The legacy field is cleared so the next
// mutateState write persists the cleaned shape. Idempotent: state files
// that already carry the split (and no `approvals` field) are no-ops.
const SETUP_REQUEST_ACTIONS = new Set<string>([
  "browser.connect",
  "connector.request",
  "browser.fill_secret"
]);

function migrateApprovalsToAuthorizationsAndSetupRequests(state: RuntimeState): void {
  // RuntimeState no longer declares `approvals`, so read it via an unknown
  // cast — legacy state.json files persisted the field and the migration
  // still needs to drain them.
  const legacyHolder = state as unknown as { approvals?: Authorization[] };
  const legacy = legacyHolder.approvals;
  if (!Array.isArray(legacy) || legacy.length === 0) {
    delete legacyHolder.approvals;
    return;
  }
  // Always partition. A mixed-shape file (both `approvals` and one of the
  // new arrays populated) can happen if a process crashed mid-write or if
  // a downgrade-then-upgrade left rows in both shapes; silently dropping
  // the legacy rows would lose pending work. Merge by id below — any
  // legacy row whose id already exists in the corresponding new array is
  // skipped (the new shape wins), the rest are appended.
  const authorizations: Authorization[] = [];
  const setupRequests: SetupRequest[] = [];
  for (const row of legacy) {
    if (!row || typeof row !== "object") continue;
    if (SETUP_REQUEST_ACTIONS.has(row.action)) {
      const status: SetupRequestStatus = row.status === "approved"
        ? "completed"
        : row.status === "denied"
          ? "cancelled"
          : "pending";
      // Drop the inherited `risk` field — SetupRequest carries no risk.
      // Cast via unknown so the action narrows to SetupRequestAction.
      const { risk: _risk, ...rest } = row;
      setupRequests.push({ ...(rest as Omit<Authorization, "risk">), status, action: rest.action as SetupRequestAction });
    } else {
      authorizations.push(row);
    }
  }
  // Merge: keep any rows already in the new arrays, append legacy rows
  // whose id isn't represented yet. The new shape wins on conflict — a
  // partial write that produced both shapes is treated as "the new array
  // is authoritative for the rows it carries."
  const existingAuthIds = new Set((state.authorizations ?? []).map((a) => a.id));
  const existingSetupIds = new Set((state.setupRequests ?? []).map((s) => s.id));
  state.authorizations = [
    ...(state.authorizations ?? []),
    ...authorizations.filter((a) => !existingAuthIds.has(a.id))
  ];
  state.setupRequests = [
    ...(state.setupRequests ?? []),
    ...setupRequests.filter((s) => !existingSetupIds.has(s.id))
  ];
  delete legacyHolder.approvals;
}

// Seed the default agent's provider fields from RuntimeConfig.provider when:
//   1. The agent has never been configured (providerName/model undefined), OR
//   2. The agent still carries the legacy hardcoded echo defaults AND the
//      instance config points at a different provider — this corrects
//      pre-Phase-B instances where the default leaked echo regardless of
//      the user's `gini run --provider X` choice.
// Idempotent: a second pass with the same inputs is a no-op. Touches only
// the default agent (id === "agent_default" or the legacy "profile_default")
// because non-default agents are user-authored and we don't want to clobber
// their explicit picks.
function seedDefaultAgentFromConfig(state: RuntimeState, provider: ProviderConfig): boolean {
  const defaults = state.agents.filter((agent) => agent.id === "agent_default" || agent.id === "profile_default");
  let mutated = false;
  for (const agent of defaults) {
    const needsSeed = !agent.providerName || !agent.model;
    const legacyEcho = agent.providerName === "echo"
      && agent.model === "gini-echo-v0"
      && (provider.name !== "echo" || provider.model !== "gini-echo-v0");
    if (!needsSeed && !legacyEcho) continue;
    agent.providerName = provider.name;
    agent.model = provider.model;
    agent.updatedAt = now();
    mutated = true;
  }
  return mutated;
}

// Pre-rename state files persisted `state.profiles` / `state.activeProfileId`.
// After the profile→agent rename these fields still exist on disk; we rewrite
// them in-place when first read. mutateState's read-modify-write cycle persists
// the cleaned shape on the next mutation. Idempotent: when `agents` already
// exists, the legacy `profiles` field is just dropped.
function migrateProfileFieldsToAgent(state: RuntimeState): void {
  const stateAny = state as unknown as {
    profiles?: unknown;
    agents?: unknown;
    activeProfileId?: unknown;
    activeAgentId?: unknown;
  };
  if (stateAny.profiles !== undefined && stateAny.agents === undefined) {
    stateAny.agents = stateAny.profiles;
  }
  delete stateAny.profiles;
  if (stateAny.activeProfileId !== undefined && stateAny.activeAgentId === undefined) {
    stateAny.activeAgentId = stateAny.activeProfileId;
  }
  delete stateAny.activeProfileId;
}

// Strip legacy improvement proposals with `kind: "memory"` from the
// in-memory shape. The `memory` kind was removed alongside the
// state.memories consolidation; older state files may still carry
// proposals on that kind which would otherwise fall through the
// proposeImprovement normalizer and get mis-applied as a skill or job.
// Each removed proposal lands an audit row so operators can see the
// pruning happened. See ADR runtime-identity-files.md.
function dropDeadMemoryImprovements(state: RuntimeState): void {
  if (!Array.isArray(state.improvements)) return;
  const removed: Array<{ id: string; title: string; status: string }> = [];
  state.improvements = state.improvements.filter((proposal) => {
    const dyn = proposal as unknown as { kind?: unknown; id?: unknown; title?: unknown; status?: unknown };
    if (dyn.kind !== "memory") return true;
    removed.push({
      id: typeof dyn.id === "string" ? dyn.id : "<unknown>",
      title: typeof dyn.title === "string" ? dyn.title : "<untitled>",
      status: typeof dyn.status === "string" ? dyn.status : "<unknown>"
    });
    return false;
  });
  if (removed.length === 0) return;
  for (const entry of removed) {
    addAudit(
      state,
      {
        actor: "runtime",
        action: "improvement.memory-kind.removed",
        target: entry.id,
        risk: "low",
        evidence: { title: entry.title, status: entry.status, reason: "kind: memory removed in consolidation" }
      },
      { system: true }
    );
  }
}

// Defensive drop of the legacy `state.memories` field. The migration in
// `migratePinnedMemoriesToUserProfile` clears the array and sets a marker
// so this normally runs against an empty array, but old state files from
// instances that haven't yet booted post-consolidation still carry the
// field on disk. The `migrations.statePinnedToUserMd` marker gates the
// drop — without it, a half-installed instance could lose pinned content
// before the migration ran. With it, the field is dead and we strip it
// from the in-memory shape so subsequent code paths never see the legacy
// surface. The on-disk JSON keeps the field as an empty array until the
// next write; that's fine — the migration is idempotent and the type-
// level field is gone. See ADR runtime-identity-files.md.
function dropDeadMemoriesField(state: RuntimeState): void {
  const dyn = state as unknown as {
    memories?: unknown;
    migrations?: { statePinnedToUserMd?: string };
  };
  if (!Array.isArray(dyn.memories)) return;
  if (!dyn.migrations?.statePinnedToUserMd) {
    // Migration hasn't run yet for this instance. Leave `state.memories`
    // intact so the migration can drain it.
    return;
  }
  delete dyn.memories;
}

// Drop the dead `AgentRecord.memoryScopes` field from persisted state.
// Idempotent: a second pass over an already-cleaned state file matches
// no rows.
function migrateDropDeadAgentMemoryScopes(state: RuntimeState): void {
  let memoryScopesStripped = 0;
  if (Array.isArray(state.agents)) {
    for (const agent of state.agents) {
      const rec = agent as unknown as { memoryScopes?: unknown };
      if (rec.memoryScopes !== undefined) {
        delete rec.memoryScopes;
        memoryScopesStripped += 1;
      }
    }
  }
  if (memoryScopesStripped > 0) {
    addAudit(
      state,
      {
        actor: "runtime",
        action: "agent.memoryscopes.dropped",
        target: "state.agents",
        risk: "low",
        evidence: { stripped: memoryScopesStripped }
      },
      { system: true }
    );
  }
}

// Convert provider-keyed connectors and the skill requires/grants that
// reference them to the typed, named-credential model. Skills and MCP rows
// reference credentials BY NAME after this runs; the provider-keyed
// resolution fallbacks are removed once every record is migrated.
//
// Marker-gated on `state.migrations.connectorsTypedCredentials` so it runs
// once per instance, idempotent, with a single summary audit row.
//
//   - linear            → type "api-key", name LINEAR_API_KEY. The secret
//                         STAYS under its existing purpose ("token"):
//                         bindingsForCredentials reads `secretRefs[0].purpose`
//                         and the Linear probe resolves "token", so re-keying
//                         would break both. metadata.mcp drives the "linear"
//                         MCP row.
//   - google-oauth-desktop → type "oauth2", name google-workspace-oauth,
//                         metadata.envMap built from the secrets actually
//                         present (reversing the module's envBindings).
//   - generic           → 1 secret: api-key named by the field purpose; 2+:
//                         oauth2 with an identity envMap.
//   - demo/claude-code/codex (presence-only) → left untyped (carry no env).
//
// Skill requires conversion uses the STATIC canonical table
// (`canonicalCredentialName`, connectors/registry.ts) for template providers,
// so a skill requiring a provider with NO connector still converts. For
// `generic` requires (no canonical name) the converter matches the skill's
// declared `prerequisites.env` against the generic credential whose fields
// cover them.
//
// Collision (LOCKED decision 4): if a generic connector maps to a name a
// template-typed connector owns (e.g. LINEAR_API_KEY), the template-typed one
// keeps the canonical name and the generic dup is renamed to the first free
// `<name>_N` with a `connector.migration_collision` audit.
const GENERIC_ENV_TOKEN = /^[A-Z][A-Z0-9_]*$/;

// A typed generic credential plus the env vars it materializes, so skill
// requires conversion can match `generic` requires by env coverage (#7).
interface GenericCredential {
  name: string;
  envVars: Set<string>;
}

interface TypedCredentialMigrationResult {
  // provider string → new credential name, for converting skill GRANTS. Only
  // populated for the template providers (linear/google) and, as a fallback,
  // the last generic credential's name keyed under "generic".
  providerToName: Map<string, string>;
  // Typed generic credentials, for env-coverage matching of `generic` requires.
  generics: GenericCredential[];
  collisions: Array<{ connectorId: string; from: string; to: string }>;
}

function migrateConnectorsToTypedCredentials(state: RuntimeState): void {
  const dyn = state as unknown as {
    migrations?: { connectorsTypedCredentials?: string };
  };
  if (dyn.migrations?.connectorsTypedCredentials) return;
  if (!Array.isArray(state.connectors)) state.connectors = [];

  const at = now();
  const result: TypedCredentialMigrationResult = {
    providerToName: new Map(),
    generics: [],
    collisions: []
  };
  // Names already claimed by a typed credential, used for collision detection.
  const claimedNames = new Set<string>();
  let typedCount = 0;
  // Count of google-oauth-desktop records that migrated with an incomplete
  // envMap (legacy shape missing the client_id secret), surfaced in the
  // summary audit so operators know to re-enter the Client ID.
  let partialGoogle = 0;

  // Pick the first `<name>_N` not already claimed (loops past `_2`, `_3`, …) so
  // two colliding generics can't both land on `<name>_2`.
  const firstFreeSuffixedName = (base: string): string => {
    let n = 2;
    while (claimedNames.has(`${base}_${n}`)) n += 1;
    return `${base}_${n}`;
  };

  // Pass 1: template-typed providers (linear, google-oauth-desktop) own their
  // canonical names first so a colliding generic loses the tie-break.
  for (const connector of state.connectors) {
    if (connector.type) {
      // Already typed (idempotent re-entry guard at the record level, though
      // the marker should prevent re-running). Record its name as claimed.
      claimedNames.add(connector.name);
      result.providerToName.set(connector.provider, connector.name);
      if (connector.provider === "generic") {
        result.generics.push({ name: connector.name, envVars: genericEnvVars(connector) });
      }
      continue;
    }
    if (connector.provider === "linear") {
      // Do NOT re-key the secret purpose. bindingsForCredentials reads
      // `secretRefs[0].purpose` and the Linear probe resolves "token" — both
      // keep working only if the purpose stays put.
      connector.type = "api-key";
      connector.name = "LINEAR_API_KEY";
      connector.metadata = {
        ...(connector.metadata ?? {}),
        mcp: { url: "https://mcp.linear.app/mcp", name: "linear", headerName: "Authorization", scheme: "Bearer" }
      };
      claimedNames.add("LINEAR_API_KEY");
      result.providerToName.set("linear", "LINEAR_API_KEY");
      typedCount += 1;
    } else if (connector.provider === "google-oauth-desktop") {
      connector.type = "oauth2";
      connector.name = "google-workspace-oauth";
      // Build the envMap from the secrets actually present. With client_id now
      // a secret (Group 1) both purposes are in secretRefs and both map. A
      // legacy record that pre-dates the client_id-secret flip carries only
      // client_secret — map just that purpose (the migration emits a note via
      // the summary audit's `partialGoogle` count rather than crashing).
      const envBindings = getProvider("google-oauth-desktop")?.secrets?.envBindings ?? {};
      const purposeToEnv: Record<string, string> = {};
      for (const [envName, purpose] of Object.entries(envBindings)) {
        purposeToEnv[purpose] = envName;
      }
      const envMap: Record<string, string> = {};
      for (const ref of connector.secretRefs ?? []) {
        const envName = purposeToEnv[ref.purpose];
        if (envName) envMap[ref.purpose] = envName;
      }
      connector.metadata = { ...(connector.metadata ?? {}), envMap };
      if (!envMap.client_id) partialGoogle += 1;
      claimedNames.add("google-workspace-oauth");
      result.providerToName.set("google-oauth-desktop", "google-workspace-oauth");
      typedCount += 1;
    }
  }

  // Pass 2: generic connectors. 1 secret → api-key named by the field purpose;
  // 2+ → oauth2 with an identity envMap. Presence-only providers
  // (demo/claude-code/codex) and any other un-templated provider are left
  // untyped — they carry no env and resolve nothing.
  for (const connector of state.connectors) {
    if (connector.type) continue;
    if (connector.provider !== "generic") continue;
    const refs = connector.secretRefs ?? [];
    if (refs.length === 1) {
      const purpose = refs[0]!.purpose;
      let name = purpose;
      // Collision: a credential already owns this name. Loop to the first free
      // `_N` so a second colliding generic doesn't reuse `_2`.
      if (claimedNames.has(name) && GENERIC_ENV_TOKEN.test(name)) {
        const renamed = firstFreeSuffixedName(name);
        result.collisions.push({ connectorId: connector.id, from: name, to: renamed });
        name = renamed;
      }
      connector.type = "api-key";
      connector.name = name;
      claimedNames.add(name);
      // Generic single-credential maps its provider string to this name. When
      // multiple generics exist their providers all say "generic"; the last
      // write wins for the grant fallback, but requires conversion matches by
      // env coverage (`result.generics`) so it isn't ambiguous.
      result.providerToName.set("generic", name);
      result.generics.push({ name, envVars: new Set([name]) });
      typedCount += 1;
    } else if (refs.length >= 2) {
      connector.type = "oauth2";
      // Keep the existing record name as the handle; identity envMap from each
      // secret purpose so resolveSkillEnv materializes `<purpose>` as itself.
      const envMap: Record<string, string> = {};
      for (const ref of refs) {
        if (GENERIC_ENV_TOKEN.test(ref.purpose)) envMap[ref.purpose] = ref.purpose;
      }
      connector.metadata = { ...(connector.metadata ?? {}), envMap };
      claimedNames.add(connector.name);
      result.providerToName.set("generic", connector.name);
      result.generics.push({ name: connector.name, envVars: new Set(Object.values(envMap)) });
      typedCount += 1;
    }
    // 0 secrets: nothing to bind; leave untyped.
  }

  // Convert skill requires/grants. Only user skills hold grants; bundled
  // skills are auto-granted and their requires come from disk (already
  // edited to requires.credentials), so we skip bundled rows here.
  let skillsConverted = 0;
  for (const skill of state.skills ?? []) {
    let mutated = false;
    if (Array.isArray(skill.requiredConnectors) && skill.requiredConnectors.length > 0 && !skill.requiredCredentials) {
      const names: string[] = [];
      for (const req of skill.requiredConnectors) {
        // Template providers map via the STATIC canonical table, so a skill
        // requiring a provider with NO connector still converts.
        const canonical = canonicalCredentialName(req.provider);
        if (canonical) {
          names.push(canonical);
          continue;
        }
        // `generic` (no canonical name): match the generic credential whose env
        // vars cover this skill's declared `prerequisites.env`, instead of
        // blindly taking the last generic.
        if (req.provider === "generic") {
          const matched = matchGenericByEnv(skill.prerequisites?.env ?? [], result.generics);
          if (matched) names.push(matched);
        }
      }
      // De-dupe while preserving order (a skill could list the same provider
      // twice, or two providers that map to one name).
      const unique = names.filter((n, i) => names.indexOf(n) === i);
      if (unique.length > 0) {
        skill.requiredCredentials = unique;
        mutated = true;
      }
    }
    if (Array.isArray(skill.grantedConnectors) && skill.grantedConnectors.length > 0) {
      const converted = skill.grantedConnectors.map((g) => {
        const canonical = canonicalCredentialName(g);
        if (canonical) return canonical;
        return result.providerToName.get(g) ?? g;
      });
      // Only rewrite when at least one entry actually maps to a new name, so a
      // re-run (or already-name-based grants) is a no-op.
      if (converted.some((name, i) => name !== skill.grantedConnectors![i])) {
        skill.grantedConnectors = converted;
        mutated = true;
      }
    }
    if (mutated) {
      skill.updatedAt = at;
      skillsConverted += 1;
    }
  }

  // Emit one summary audit + a per-collision audit row — but ONLY when the
  // migration actually changed something. A fresh/empty instance has nothing
  // to migrate, so we skip the audit noise (and the marker still gets set so
  // the pass never re-runs). When data was migrated, the summary documents the
  // one-time conversion.
  if (typedCount > 0 || skillsConverted > 0) {
    addAudit(
      state,
      {
        actor: "runtime",
        action: "connector.migration.typed_credentials",
        target: "state.connectors",
        risk: "low",
        evidence: {
          connectorsTyped: typedCount,
          skillsConverted,
          collisions: result.collisions.length,
          ...(partialGoogle > 0 ? { partialGoogle } : {})
        }
      },
      { system: true }
    );
    for (const collision of result.collisions) {
      addAudit(
        state,
        {
          actor: "runtime",
          action: "connector.migration_collision",
          target: collision.connectorId,
          risk: "low",
          evidence: { from: collision.from, to: collision.to }
        },
        { system: true }
      );
    }
  }

  dyn.migrations = { ...(dyn.migrations ?? {}), connectorsTypedCredentials: at };
}

// The env vars an already-typed generic credential materializes — its
// `metadata.envMap` values (oauth2) or its single name (api-key). Used to
// match `generic` skill requires by env coverage on a re-entry where the
// generic was already typed by a prior pass.
function genericEnvVars(connector: ConnectorRecord): Set<string> {
  const envMap = connector.metadata?.envMap;
  if (envMap && Object.keys(envMap).length > 0) return new Set(Object.values(envMap));
  return new Set([connector.name]);
}

// Pick the typed generic credential the skill actually consumes: every env var
// the generic provides must appear in the skill's declared `prerequisites.env`
// (the generic's env set is a subset of the skill's env). A skill that declares
// `[LINEAR_API_KEY, MY_API_KEY]` matches the generic providing `{MY_API_KEY}`
// even though LINEAR_API_KEY comes from the Linear credential. Falls back to the
// single generic when the skill declares no env (nothing to match on) and
// exactly one exists, so the common one-generic instance still converts.
// Returns undefined when no generic matches — the skill drops that requirement.
function matchGenericByEnv(skillEnv: string[], generics: GenericCredential[]): string | undefined {
  if (generics.length === 0) return undefined;
  if (skillEnv.length === 0) {
    return generics.length === 1 ? generics[0]!.name : undefined;
  }
  const declared = new Set(skillEnv);
  for (const generic of generics) {
    if (generic.envVars.size === 0) continue;
    if (Array.from(generic.envVars).every((envVar) => declared.has(envVar))) return generic.name;
  }
  return undefined;
}

// Rename connector records whose name no longer matches their provider's
// canonical credential name. Skill activation matches credentials BY NAME
// (isSkillActive, connectors/index.ts) and the skill loader maps legacy
// `requires.connectors` providers through `canonicalCredentialName`
// (connectors/registry.ts) — so a record auto-detected under a display label
// (e.g. "Codex", "Claude Code") before its provider declared a
// `credentialName` never matches the skill's requiredCredentials and the
// skill stays inactive despite a healthy connector. The detection job never
// renames existing records (runConnectorDetection skips providers that
// already have a record), so this one-time rename is the only path that
// heals pre-existing instances.
//
// Marker-gated on `state.migrations.connectorsCanonicalNames` so it runs
// once per instance, idempotent, with a single summary audit row. Runs AFTER
// migrateConnectorsToTypedCredentials so template records (linear /
// google-oauth-desktop) already carry their canonical names and pass through
// untouched. Providers with no canonical name (generic, demo) are skipped.
//
// Collision (same rule as the typed-credential migration, LOCKED decision 4):
// if the canonical name is already claimed by another record, the claimer
// keeps it and the renamed record takes the first free `<name>_N` with a
// `connector.migration_collision` audit.
function migrateConnectorCanonicalNames(state: RuntimeState): void {
  const dyn = state as unknown as {
    migrations?: { connectorsCanonicalNames?: string };
  };
  if (dyn.migrations?.connectorsCanonicalNames) return;
  if (!Array.isArray(state.connectors)) state.connectors = [];

  const at = now();
  const claimedNames = new Set(state.connectors.map((c) => c.name));
  // Pick the first `<name>_N` not already claimed (loops past `_2`, `_3`, …)
  // so two colliding records can't both land on `<name>_2`.
  const firstFreeSuffixedName = (base: string): string => {
    let n = 2;
    while (claimedNames.has(`${base}_${n}`)) n += 1;
    return `${base}_${n}`;
  };

  const renames: Array<{ connectorId: string; from: string; to: string }> = [];
  const collisions: Array<{ connectorId: string; from: string; to: string }> = [];
  for (const connector of state.connectors) {
    const canonical = canonicalCredentialName(connector.provider);
    if (!canonical || connector.name === canonical) continue;
    let target = canonical;
    if (claimedNames.has(target)) {
      target = firstFreeSuffixedName(canonical);
      collisions.push({ connectorId: connector.id, from: connector.name, to: target });
    }
    renames.push({ connectorId: connector.id, from: connector.name, to: target });
    connector.name = target;
    claimedNames.add(target);
  }

  // Emit the audit rows only when something actually renamed — a fresh or
  // already-canonical instance sets the marker silently.
  if (renames.length > 0) {
    addAudit(
      state,
      {
        actor: "runtime",
        action: "connector.migration.canonical_names",
        target: "state.connectors",
        risk: "low",
        evidence: { renamed: renames.length, renames, collisions: collisions.length }
      },
      { system: true }
    );
    for (const collision of collisions) {
      addAudit(
        state,
        {
          actor: "runtime",
          action: "connector.migration_collision",
          target: collision.connectorId,
          risk: "low",
          evidence: { from: collision.from, to: collision.to }
        },
        { system: true }
      );
    }
  }

  dyn.migrations = { ...(dyn.migrations ?? {}), connectorsCanonicalNames: at };
}

// Archive job channels orphaned by a job deletion that pre-dated removeJob's
// channel cleanup. A recurring job's dedicated channel (kind:"channel",
// origin:"job") is surfaced on the Recurring Jobs rails (web sidebar + mobile
// channels) as long as it isn't archived; a job deleted before removeJob
// learned to archive its channel left the channel behind, matching the
// clients' `(kind:"channel" || origin:"job") && !archivedAt` filter with no
// job to decorate it (issue #369). Stamp `archivedAt` on every such orphan so
// it leaves the lists — history is preserved and it stays addressable by
// id/URL, mirroring removeJob/rebindJobDelivery's archive semantics.
//
// Scope guards (mirror removeJob): only LIVE channels (skip already-archived),
// never an email-watch channel (`feature === "email-watch"` — that subsystem
// owns its channels' lifecycle), and never one any surviving job still
// delivers into via `chatSessionId` or a fan-out route. Idempotent: once every
// orphan is archived, a re-run finds nothing (the referenced set and the
// archived guard both hold). No marker needed — the `!archivedAt` guard makes
// repeat runs no-ops.
function archiveOrphanJobChannels(state: RuntimeState): void {
  if (!Array.isArray(state.chatSessions) || state.chatSessions.length === 0) return;
  const referenced = new Set<string>();
  for (const job of state.jobs) {
    if (job.chatSessionId) referenced.add(job.chatSessionId);
    for (const route of Object.values(job.routes ?? {})) {
      if (route.chatSessionId) referenced.add(route.chatSessionId);
    }
  }
  let archived = 0;
  for (const session of state.chatSessions) {
    if (session.kind !== "channel") continue;
    if (session.archivedAt) continue;
    if (session.feature === "email-watch") continue;
    if (referenced.has(session.id)) continue;
    session.archivedAt = now();
    session.updatedAt = now();
    archived += 1;
  }
  if (archived > 0) {
    addAudit(
      state,
      {
        actor: "runtime",
        action: "chat.session.archived",
        target: state.instance,
        risk: "low",
        evidence: { reason: "orphan.job.channel.backfill", archived }
      },
      { system: true }
    );
  }
}

// Backfill Task.chatSessionId from the chatMessages join for records that
// pre-date the field. The Tasks page reads task.chatSessionId directly so it
// no longer has to pull /state for the chatMessages list — but state files
// older than this field must still resolve correctly.
//
// Marker-gated on `state.migrations.taskChatSessionIdBackfilled` so the join
// runs at most ONCE per instance. New tasks set chatSessionId at creation
// (execution/chat.ts) and non-chat tasks (jobs/messaging) legitimately have
// none, so after the one-time backfill there is nothing left to derive —
// re-running every readState only re-scanned the same unmatched tasks forever.
// The original ungated version was an O(tasks × chatMessages) nested .find on
// EVERY read (measured at 28,764ms across one short window on a 4,353-task /
// 971-message instance) and dominated the runtime's CPU. This pass is now both
// gated AND O(tasks + chatMessages): a single index of taskId -> user-message
// sessionId replaces the per-task linear scan. No audit row — this is purely
// derived data, not a new fact.
function migrateTaskChatSessionId(state: RuntimeState): void {
  const dyn = state as unknown as {
    migrations?: { taskChatSessionIdBackfilled?: string };
  };
  if (dyn.migrations?.taskChatSessionIdBackfilled) return;
  if (!Array.isArray(state.tasks) || state.tasks.length === 0) return;
  if (!Array.isArray(state.chatMessages) || state.chatMessages.length === 0) {
    // Nothing to join against, but the backfill has "run" for this state shape
    // — mark it so a task-only instance doesn't re-enter every read.
    dyn.migrations = { ...(dyn.migrations ?? {}), taskChatSessionIdBackfilled: now() };
    return;
  }
  // Index taskId -> sessionId from the first user-role message per task, in one
  // pass over chatMessages, so the task loop below is O(tasks) not O(tasks ×
  // messages). First match wins (mirrors the prior .find, which returned the
  // first matching message in array order).
  const sessionByTask = new Map<string, string>();
  for (const message of state.chatMessages) {
    if (message.role !== "user") continue;
    if (!message.taskId) continue;
    if (!sessionByTask.has(message.taskId)) sessionByTask.set(message.taskId, message.sessionId);
  }
  for (const task of state.tasks) {
    if (task.chatSessionId) continue;
    const sessionId = sessionByTask.get(task.id);
    if (sessionId) task.chatSessionId = sessionId;
  }
  dyn.migrations = { ...(dyn.migrations ?? {}), taskChatSessionIdBackfilled: now() };
}

// Convert legacy threads into linear Chat history (ADR
// chat-topics-tasks-subagents.md, Decision 3). A thread was a `threadId` /
// `parentBlockId` tag on durable chat messages and queued pending messages
// inside one session's ordinal stream; nulling those tags makes the rows read
// as one linear main-chat history in ordinal order. The SQLite chat_blocks
// rows are nulled by the parallel v10 memory-db migration.
//
// Marker-gated on `state.migrations.threadsToLinearHistory` so it runs at most
// ONCE per instance — NOT on every load. The live thread-routing path still
// writes these tags this phase (it is deleted in a later phase), so a
// strip-on-every-read would null a freshly-queued thread reply before it could
// be dispatched. Gating confines the conversion to the one-time legacy upgrade.
function migrateThreadsToLinearHistory(state: RuntimeState): void {
  const dyn = state as unknown as {
    migrations?: { threadsToLinearHistory?: string };
  };
  if (dyn.migrations?.threadsToLinearHistory) return;
  for (const message of state.chatMessages) {
    delete message.threadId;
    delete message.parentBlockId;
  }
  for (const session of state.chatSessions) {
    for (const pending of session.pendingMessages ?? []) {
      delete pending.threadId;
      delete pending.parentBlockId;
    }
  }
  dyn.migrations = { ...(dyn.migrations ?? {}), threadsToLinearHistory: now() };
}

// Give every legacy chat-bound job a dedicated Topic + forwardToChat (ADR
// chat-topics-tasks-subagents.md, "Jobs → Topics"). Before this phase a
// `deliverTo:"chat"` job re-pointed its `chatSessionId` at the user's own
// `kind:"agent"` conversation, so it has no dedicated Topic. Mint a fresh
// channel/Topic for each such job, re-point `job.chatSessionId` at it, and set
// `forwardToChat=true` so each fire forwards into Chat instead of burying
// reports inline. Jobs already bound to a `kind:"channel"` Topic are left as
// channel-only (forwardToChat defaults to false). Marker-gated so it runs ONCE
// per instance; idempotent within a run. Runs after the channel-kind backfill
// so a legacy `origin:"job"` session that just gained `kind:"channel"` is in
// scope and never mistaken for an agent chat.
function migrateJobsToTopics(state: RuntimeState): void {
  const dyn = state as unknown as { migrations?: { jobsToTopics?: string } };
  if (dyn.migrations?.jobsToTopics) return;
  let migrated = 0;
  for (const job of state.jobs) {
    if (job.chatSessionId === undefined) continue;
    const session = state.chatSessions.find((s) => s.id === job.chatSessionId);
    // Only a job pointed at a real `kind:"agent"` Chat is a legacy
    // deliverTo:"chat" rebind result with no dedicated Topic — give it one.
    if (!session || session.kind !== "agent") continue;
    const topic = createChatSession(state, job.name, undefined, job.agentId, "job", "channel");
    job.chatSessionId = topic.id;
    job.forwardToChat = true;
    migrated += 1;
  }
  if (migrated > 0) {
    addAudit(
      state,
      {
        actor: "runtime",
        action: "jobs.topics.migrated",
        target: state.instance,
        risk: "low",
        evidence: { migrated }
      },
      { system: true }
    );
  }
  dyn.migrations = { ...(dyn.migrations ?? {}), jobsToTopics: now() };
}

// Default `deliveryPolicy: "always"` on pre-existing jobs. "always" preserves
// today's semantics exactly — including the [SILENT] sentinel suppression,
// which is honored under every policy (jobs/finalize.ts). Marker-gated on
// `state.migrations.jobsDeliveryPolicyDefaulted` so a job the user later
// flips to another policy isn't reset on the next load.
function migrateJobsDeliveryPolicyDefaulted(state: RuntimeState): void {
  const dyn = state as unknown as {
    migrations?: { jobsDeliveryPolicyDefaulted?: string };
  };
  if (dyn.migrations?.jobsDeliveryPolicyDefaulted) return;
  for (const job of state.jobs) {
    job.deliveryPolicy ??= "always";
  }
  dyn.migrations = { ...(dyn.migrations ?? {}), jobsDeliveryPolicyDefaulted: now() };
}

// Auto-inbox used to be installable as a normal message-delivering routine.
// Existing installs must be repaired on read so the watcher stays headless and
// only its spawned draft tasks surface on Home.
function migrateAutoInboxJobsToSilentDelivery(state: RuntimeState): void {
  let repaired = 0;
  let mintedChannels = 0;
  const at = now();
  for (const job of state.jobs) {
    if (job.templateId !== "auto-inbox") continue;
    let mutated = false;
    if (job.deliveryPolicy !== "silent") {
      job.deliveryPolicy = "silent";
      mutated = true;
    }

    let session = job.chatSessionId
      ? state.chatSessions.find((candidate) => candidate.id === job.chatSessionId)
      : undefined;
    if (!session || session.kind !== "channel") {
      session = createChatSession(state, job.name || "Auto-inbox", undefined, job.agentId, "job", "channel");
      job.chatSessionId = session.id;
      mintedChannels += 1;
      mutated = true;
    }

    if (session.headless !== true) {
      session.headless = true;
      mutated = true;
    }
    if (session.archivedAt !== undefined) {
      delete session.archivedAt;
      mutated = true;
    }
    if (mutated) {
      job.updatedAt = at;
      session.updatedAt = at;
      repaired += 1;
    }
  }
  if (repaired > 0) {
    addAudit(
      state,
      {
        actor: "runtime",
        action: "auto-inbox.silent-delivery.migrated",
        target: state.instance,
        risk: "low",
        evidence: { repaired, mintedChannels }
      },
      { system: true }
    );
  }
}

// Backfill `pinned: true` on existing non-archived Topics. The sidebar's
// topics section moves from a kind-based filter (`kind === "topic"`) to a
// pinned-based one (`pinned === true`) — without this one-time backfill,
// every topic the user already relies on would vanish from the sidebar on
// upgrade. Only legacy rows are pinned here: from this point on pinning is a
// user gesture, and router/agent-minted containers stay unpinned.
// Marker-gated on `state.migrations.topicsPinnedBackfilled` so it runs at
// most ONCE per instance — re-running would re-pin containers the user has
// since unpinned.
function migrateTopicsPinned(state: RuntimeState): void {
  const dyn = state as unknown as {
    migrations?: { topicsPinnedBackfilled?: string };
  };
  if (dyn.migrations?.topicsPinnedBackfilled) return;
  for (const session of state.chatSessions) {
    if (session.kind === "topic" && !session.archivedAt) session.pinned = true;
  }
  dyn.migrations = { ...(dyn.migrations ?? {}), topicsPinnedBackfilled: now() };
}

// Seed `acknowledgedAt` on every pre-existing session so the first boot after
// the home attention queue ships doesn't derive `done_unacknowledged` for
// every historical container and flood home with stale rows. Sessions created
// after this one-time pass start unacknowledged, so new outcomes surface
// normally. Marker-gated on `state.migrations.containersAckSeeded` — a
// re-run would wipe out real "this outcome is new" state by re-stamping.
function migrateContainersAckSeeded(state: RuntimeState): void {
  const dyn = state as unknown as {
    migrations?: { containersAckSeeded?: string };
  };
  if (dyn.migrations?.containersAckSeeded) return;
  const at = now();
  for (const session of state.chatSessions) {
    session.acknowledgedAt ??= at;
  }
  dyn.migrations = { ...(dyn.migrations ?? {}), containersAckSeeded: at };
}

// Stamp the active-at-migration-time agent onto records that pre-date the
// per-agent isolation field. Idempotent and audit-emitting. Covers Task,
// ChatSessionRecord, JobRecord, JobRunRecord,
// SubagentRecord, Approval, EmailWatcherRecord in one pass so the backfill
// audit doesn't fan out into separate rows. RuntimeEvent and AuditEvent are
// deliberately excluded — see the comment at the stamp loop below.
function migrateRecordAgentIds(state: RuntimeState): void {
  // When the state file has no agents at all (e.g. a hand-edited or
  // partially-restored file that lost both the seed pass and the
  // pre-seed defaults), skip the backfill entirely. Stamping records
  // with a literal "agent_default" id that no AgentRecord owns would
  // leave them attributed to a nonexistent agent. The seeding step in
  // normalizeState above ensures we never reach this branch in
  // normal operation. Defense in depth against a stale `activeAgentId`
  // that the upstream repair missed: only honor it when it points at an
  // existing agent; otherwise fall back to the first active / first
  // existing agent rather than the dead id.
  const knownActive = state.agents.some((agent) => agent.id === state.activeAgentId)
    ? state.activeAgentId
    : undefined;
  const defaultAgentId =
    knownActive
    ?? state.agents.find((agent) => agent.status === "active")?.id
    ?? state.agents[0]?.id;
  if (!defaultAgentId) return;
  const validAgentIds = new Set(state.agents.map((agent) => agent.id));
  const counts: Record<string, number> = {};
  // Re-stamp rows whose agentId is missing OR points at an agent that no
  // longer exists (deleted agent, stale id from an old import). The latter
  // would otherwise leave records stranded under an unselectable id and
  // invisible to the UI which filters by `state.agents`. Idempotent: once
  // every row resolves to a valid id, subsequent runs are no-ops.
  const stamp = <T extends { agentId?: string }>(rows: T[] | undefined, label: string) => {
    if (!Array.isArray(rows)) return;
    let n = 0;
    for (const row of rows) {
      if (row.agentId && validAgentIds.has(row.agentId)) continue;
      row.agentId = defaultAgentId;
      n += 1;
    }
    if (n > 0) counts[label] = n;
  };
  stamp(state.tasks, "tasks");
  stamp(state.chatSessions, "chatSessions");
  stamp(state.jobs, "jobs");
  stamp(state.jobRuns, "jobRuns");
  stamp(state.subagents, "subagents");
  stamp(state.authorizations, "authorizations");
  stamp(state.setupRequests, "setupRequests");
  stamp(state.emailWatchers, "emailWatchers");
  // Events and audits are deliberately NOT backfilled here. After the
  // AgentContext refactor, a missing agentId on an event/audit is a
  // first-class signal that the row is system-attributed (instance boot,
  // agent-lifecycle, instance-level config). Stamping those legacy-style
  // would erase that distinction and re-pollute every read with a
  // backfill audit row. Legacy events from before agentId existed simply
  // stay unattributed — the UI's "All agents" view shows them; per-agent
  // filters skip them, which matches the system-event contract.
  if (Object.keys(counts).length > 0) {
    addAudit(
      state,
      {
        actor: "runtime",
        action: "records.agentid.backfill",
        target: defaultAgentId,
        risk: "low",
        evidence: { stamped: counts, agentId: defaultAgentId }
      },
      { agentId: defaultAgentId }
    );
  }
}

// Backfill `messaging` and `mcp` onto the default agent's toolsets
// whitelist when the agent still carries the prior default set exactly
// (`["file","terminal","memory","session_search","delegation"]`). Without
// this, an instance created before the messaging+mcp toolsets joined the
// default whitelist keeps gating `send_message` out via the per-agent
// intersection even after the operator enables those toolsets. The
// exact-match heuristic catches the common case (the user never
// customized the list) without overriding intentional removals — any
// customization (added or removed entries) leaves the agent alone.
// Idempotent: a state file already on the new shape (the union already
// includes both names, OR the user has customized the list) is a no-op.
const PRIOR_DEFAULT_AGENT_TOOLSETS = [
  "file",
  "terminal",
  "memory",
  "session_search",
  "delegation"
] as const;
function backfillDefaultAgentToolsets(state: RuntimeState): void {
  // Defensive: iterate every agent_default row in case a corrupt state
  // file ended up with duplicates. The id uniqueness invariant should
  // hold, but if it doesn't, migrating one and leaving the rest stale
  // would be the worst outcome.
  const candidates = state.agents.filter((candidate) => candidate.id === "agent_default");
  for (const agent of candidates) {
    const current = agent.toolsets ?? [];
    // Order-insensitive exact match against the prior default. A set
    // comparison catches reorders and matches the "user never customized"
    // signal without depending on the historical write order.
    if (current.length !== PRIOR_DEFAULT_AGENT_TOOLSETS.length) continue;
    const currentSet = new Set(current);
    let matches = true;
    for (const name of PRIOR_DEFAULT_AGENT_TOOLSETS) {
      if (!currentSet.has(name)) { matches = false; break; }
    }
    if (!matches) continue;
    // Match. Union in `messaging` and `mcp` so the operator's later
    // toolset-enable lands at a fully-resolved per-agent whitelist.
    agent.toolsets = [...current, "messaging", "mcp"];
    agent.updatedAt = now();
    addAudit(
      state,
      {
        actor: "runtime",
        action: "agent.toolsets.backfilled",
        target: agent.id,
        risk: "low",
        evidence: { added: ["messaging", "mcp"], agentId: agent.id }
      },
      { agentId: agent.id }
    );
  }
}

// Rename the default agent from the legacy "default" name to "Gini" on
// existing instances. `AgentRecord.name` is the agent's display label (the
// switcher, list_agents, the runtime-identity block) and the source the
// boot-time SOUL.md seed reads ("Your name is <name>."); an instance
// seeded before the default agent was named "Gini" carries
// `name === "default"`, which would surface as "default" everywhere.
// Strictly gated on the literal "default" name so a user who renamed their
// default agent is left alone, and idempotent (after the rename the name
// is "Gini" and the guard no longer matches).
function renameDefaultAgentToGini(state: RuntimeState): void {
  // Defensive: iterate every default row (also the legacy `profile_default`
  // id) in case a corrupt state file ended up with duplicates.
  const candidates = state.agents.filter(
    (candidate) => candidate.id === "agent_default" || candidate.id === "profile_default"
  );
  for (const agent of candidates) {
    if (agent.name !== "default") continue;
    agent.name = "Gini";
    agent.updatedAt = now();
    addAudit(
      state,
      {
        actor: "runtime",
        action: "agent.default.renamed",
        target: agent.id,
        risk: "low",
        evidence: { from: "default", to: "Gini", agentId: agent.id }
      },
      { agentId: agent.id }
    );
  }
}

// Phase C — per-agent backfill on the SQLite hindsight store. Pre-Phase-C
// rows have a NULL agent_id (default value from the ALTER TABLE). Walk the
// DB once and stamp them with the migration-time active agent, mirroring
// the JSON MemoryRecord backfill. Bank rows get the same treatment so
// their `agentId` field is non-null going forward. Idempotent — only
// touches NULL rows.
function migrateHindsightAgentIdColumns(instance: Instance, state: RuntimeState): void {
  // Skip if no memory.db has been created yet — first-boot instances will
  // pick up the column from CREATE TABLE and won't need the backfill.
  if (!existsSync(memoryDbPath(instance))) return;
  const defaultAgentId =
    state.activeAgentId
    ?? state.agents.find((agent) => agent.status === "active")?.id
    ?? state.agents[0]?.id
    ?? "agent_default";
  try {
    const db = getMemoryDb(instance);
    const stampedUnits = db
      .query<{ c: number }, []>(
        "SELECT COUNT(*) AS c FROM memory_units WHERE agent_id IS NULL"
      )
      .get()?.c ?? 0;
    if (stampedUnits > 0) {
      db.run("UPDATE memory_units SET agent_id = ? WHERE agent_id IS NULL", [defaultAgentId]);
    }
    const stampedBanks = db
      .query<{ c: number }, []>(
        "SELECT COUNT(*) AS c FROM memory_banks WHERE agent_id IS NULL AND id != 'bank_default'"
      )
      .get()?.c ?? 0;
    if (stampedBanks > 0) {
      // The legacy `bank_default` row stays untagged so existing code that
      // reads from it (ensureDefaultBank) keeps working; per-agent banks
      // created by ensureAgentBank carry a non-null agent_id from inception.
      db.run(
        "UPDATE memory_banks SET agent_id = ? WHERE agent_id IS NULL AND id != 'bank_default'",
        [defaultAgentId]
      );
    }
    if (stampedUnits > 0 || stampedBanks > 0) {
      addAudit(
        state,
        {
          actor: "runtime",
          action: "hindsight.agentid.backfill",
          target: defaultAgentId,
          risk: "low",
          evidence: { units: stampedUnits, banks: stampedBanks, agentId: defaultAgentId }
        },
        { agentId: defaultAgentId }
      );
    }
  } catch {
    // SQLite open failures are surfaced through `gini doctor`'s probe; the
    // normalizeState path stays best-effort so a corrupted DB doesn't block
    // every read of state.json.
  }
}

// Union the desired default-agent toolsets list into existing
// `agent_default` (and the legacy `profile_default`) records on disk.
// Without this, an instance created before a new default toolset (e.g.
// `browser`) was added still carries the old toolsets array, and
// `resolveEffectiveContext` filters the tool catalog by that stale list —
// so even though the toolset row itself is enabled by the global
// backfill, the agent's whitelist still excludes the new tool family.
//
// Only touches the default agent records. User-authored agents keep
// whatever toolsets they have; they were explicit picks.
// Historical snapshots of the default-agent toolsets list. The migration
// only fires when the agent's current toolsets exactly matches one of
// these — that's the "user never customized" signal. If the user removed
// or rearranged anything, we leave the list alone (they made an
// explicit pick). Each snapshot represents a stable point in the
// default's evolution before a new toolset was added.
const HISTORICAL_DEFAULT_AGENT_TOOLSETS: ReadonlyArray<ReadonlyArray<string>> = [
  // Pre-delegation, pre-messaging/mcp, pre-browser.
  ["file", "terminal", "memory", "session_search"],
  // Pre-messaging/mcp, pre-browser (handled by backfillDefaultAgentToolsets above).
  ["file", "terminal", "memory", "session_search", "delegation"],
  // Post-messaging/mcp, pre-browser. This is what backfillDefaultAgentToolsets
  // produces when it fires on the prior-default snapshot.
  ["file", "terminal", "memory", "session_search", "delegation", "messaging", "mcp"],
  // Post-browser, pre-web_search. Lets instances created after `browser`
  // but before `web_search` recognize the default as uncustomized and
  // union in `web_search`.
  ["file", "terminal", "memory", "session_search", "delegation", "messaging", "mcp", "browser"],
  // Post-web_search, pre-database. Lets instances created after `web_search`
  // but before the `database` toolset recognize the default as uncustomized
  // and union in `database`.
  ["file", "terminal", "memory", "session_search", "delegation", "messaging", "mcp", "browser", "web_search"]
];

function migrateDefaultAgentToolsets(state: RuntimeState, instance: Instance): void {
  if (!Array.isArray(state.agents) || state.agents.length === 0) return;
  const at = now();
  const desired = defaultAgent(instance, at).toolsets;
  if (!Array.isArray(desired) || desired.length === 0) return;
  for (const agent of state.agents) {
    if (agent.id !== "agent_default" && agent.id !== "profile_default") continue;
    const existing = Array.isArray(agent.toolsets) ? agent.toolsets : null;
    if (existing === null) {
      agent.toolsets = [...desired];
      agent.updatedAt = at;
      continue;
    }
    // `profile_default` is the legacy agent id (renamed to
    // `agent_default`). Anyone still on it has a stale config — always
    // migrate it up to the current default without the customization
    // check applied to `agent_default`.
    const isLegacyDefault = agent.id === "profile_default";
    const existingSet = new Set(existing);
    if (!isLegacyDefault) {
      // For `agent_default`, only union when the current toolsets exactly
      // matches one of the historical snapshots OR the current desired
      // default. Any divergence (user added/removed something) is treated
      // as customization and left alone.
      const matchesSnapshot = (snapshot: ReadonlyArray<string>): boolean => {
        if (snapshot.length !== existing.length) return false;
        for (const name of snapshot) {
          if (!existingSet.has(name)) return false;
        }
        return true;
      };
      const isHistorical = HISTORICAL_DEFAULT_AGENT_TOOLSETS.some(matchesSnapshot);
      const isCurrent = matchesSnapshot(desired);
      if (!isHistorical && !isCurrent) continue;
    }
    let mutated = false;
    for (const name of desired) {
      if (!existingSet.has(name)) {
        existing.push(name);
        existingSet.add(name);
        mutated = true;
      }
    }
    if (mutated) {
      agent.updatedAt = at;
    }
  }
}

export function normalizeState(instance: Instance, state: RuntimeState): RuntimeState {
  migrateProfileFieldsToAgent(state);
  migrateLaneFieldToInstance(state);
  migrateIdentitiesToConnectors(state);
  state.instance = instance;
  state.improvements ??= [];
  // Skill-learning rows (ADR skill-learning-from-outcomes.md). Default to []
  // so older state files predating the feature load.
  state.skillOutcomes ??= [];
  state.learningFindings ??= [];
  state.connectors ??= [];
  state.tasks ??= [];
  migrateApprovalsToAuthorizationsAndSetupRequests(state);
  state.authorizations ??= [];
  state.setupRequests ??= [];
  state.audit ??= [];
  state.skills ??= [];
  state.jobs ??= [];
  // The device-pairing subsystem is gone (auth is owner-token-only; see ADR
  // owner-token-auth.md). Old state files still carry its collections — drop
  // them on read so the next write sheds the legacy keys.
  delete (state as unknown as Record<string, unknown>).pairingCodes;
  delete (state as unknown as Record<string, unknown>).pairingRequests;
  delete (state as unknown as Record<string, unknown>).devices;
  state.promotions ??= [];
  state.snapshots ??= [];
  state.tools ??= defaultTools(instance, now());
  state.toolsets ??= defaultToolsets(instance, now());
  // Backfill any toolsets/tools that were added to defaults after this
  // instance was first created. Without this, an existing instance that
  // already has a `state.toolsets` array silently misses new toolsets
  // (e.g. browser) and `/api/toolsets/<name>/enable` returns "Toolset
  // not found". Match by name so user-renamed entries are left alone.
  const at = now();
  const desiredToolsets = defaultToolsets(instance, at);
  const desiredTools = defaultTools(instance, at);
  for (const ts of desiredToolsets) {
    if (!state.toolsets!.some((existing) => existing.name === ts.name)) {
      state.toolsets!.push(ts);
    }
  }
  // For each defaults-known toolset, union its desired tool names into
  // the (possibly pre-existing) state row, and synthesize matching tool
  // rows whose status reflects the EXISTING toolset's status. This runs
  // before the catch-all "add missing tools" pass below so a tool that
  // belongs to an already-enabled toolset comes up "available" rather
  // than inheriting the defaults' "disabled" status. Without this an
  // older instance whose `browser` row is enabled but whose tool rows
  // pre-date browser.vision et al. would render the new entries as
  // disabled even though the toolset itself is on.
  for (const desired of desiredToolsets) {
    const existing = state.toolsets!.find((t) => t.name === desired.name);
    if (!existing) continue;
    // Union toolNames preserving the existing row's order; append any
    // names that aren't already present.
    const known = new Set(existing.toolNames);
    for (const name of desired.toolNames) {
      if (!known.has(name)) {
        existing.toolNames.push(name);
        known.add(name);
      }
    }
    const existingStatus = existing.status;
    for (const desiredTool of desiredTools) {
      if (desiredTool.toolset !== desired.name) continue;
      if (state.tools!.some((t) => t.name === desiredTool.name)) continue;
      state.tools!.push({
        ...desiredTool,
        status: existingStatus === "enabled" ? "available" : "disabled"
      });
    }
  }
  // Catch-all final pass: tools whose toolset wasn't in the defaults
  // (or matched by name above) but that ship in defaultTools. We use
  // the desired tool's own status here since there's no existing
  // toolset row to consult.
  for (const tool of desiredTools) {
    if (!state.tools!.some((existing) => existing.name === tool.name)) {
      state.tools!.push(tool);
    }
  }
  // `mcp` and `messaging` originally shipped disabled. Their default flipped
  // to enabled so a fresh instance has all toolsets on. For existing
  // instances created before the flip, promote the row only when the operator
  // never touched it (createdAt === updatedAt). Anyone who explicitly
  // disabled it has updatedAt > createdAt and is left alone.
  for (const name of ["mcp", "messaging"] as const) {
    const row = state.toolsets!.find((t) => t.name === name);
    if (!row) continue;
    if (row.status !== "disabled") continue;
    if (row.createdAt !== row.updatedAt) continue;
    row.status = "enabled";
    row.updatedAt = at;
    for (const tool of state.tools!.filter((t) => t.toolset === name)) {
      tool.status = "available";
      tool.updatedAt = at;
    }
  }
  state.subagents ??= [];
  state.mcpServers ??= [];
  state.messagingBridges ??= [];
  state.messagingMessages ??= [];
  state.importReports ??= [];
  // Seed a default agent when the state file is either missing the field or
  // carries an empty array. Without the empty-array branch,
  // migrateRecordAgentIds would fall through its `"agent_default"` literal
  // and stamp records with an id no AgentRecord actually owns.
  if (!Array.isArray(state.agents) || state.agents.length === 0) {
    state.agents = [defaultAgent(instance, now())];
  }
  state.activeAgentId ??= state.agents.find((item) => item.status === "active")?.id ?? state.agents[0]?.id;
  // Repair: if `activeAgentId` references an agent the state file no longer
  // contains (hand-edited file, partial restore, deleted-default edge), it
  // would propagate the dead id through migrateRecordAgentIds. Re-anchor it
  // to the first active / first existing agent so downstream readers and
  // backfills see a real id.
  if (!state.agents.some((agent) => agent.id === state.activeAgentId)) {
    state.activeAgentId = state.agents.find((item) => item.status === "active")?.id ?? state.agents[0]?.id;
  }
  // Rename the legacy "default"-named default agent to "Gini" so its label
  // and SOUL.md name seed read "Gini". Runs after the default-agent seed
  // branch above so it sees a real default row; a freshly seeded default is
  // already "Gini", so it's a no-op there. Idempotent.
  renameDefaultAgentToGini(state);
  // Backfill the default agent's toolsets whitelist with `messaging` and
  // `mcp` when the agent still carries the prior default set exactly.
  // Runs after the default-agent seed branch above so the migration sees
  // a real `agent_default` row when one was just synthesized. Idempotent.
  backfillDefaultAgentToolsets(state);
  // Union new default toolsets (e.g. `browser` after Phase 2) into the
  // existing `agent_default` record. Runs after agents are populated;
  // idempotent.
  migrateDefaultAgentToolsets(state, instance);
  // Phase C — per-agent memory isolation backfill for the SQLite
  // hindsight store. The legacy `state.memories` per-agent backfill
  // ran here too; that surface was removed in the state.memories
  // consolidation (see ADR runtime-identity-files.md) so only
  // the SQLite-backed helper remains.
  migrateHindsightAgentIdColumns(instance, state);
  // Drop the dead AgentRecord.memoryScopes field from legacy state
  // files. Runs after agents are populated so the audit event lands on
  // a valid state.
  migrateDropDeadAgentMemoryScopes(state);
  // Defensive drop of the now-removed `state.memories` field. Only
  // strips when the consolidation migration has already run for this
  // instance (marker present), so a half-installed instance keeps its
  // pinned content intact until the migration drains it. See ADR
  // runtime-identity-files.md.
  dropDeadMemoriesField(state);
  // Strip legacy improvement proposals with `kind: "memory"` so the
  // proposeImprovement normalizer never sees them and silently
  // mis-applies them as skills or jobs. See ADR
  // runtime-identity-files.md.
  dropDeadMemoryImprovements(state);
  state.relays ??= [];
  state.notifications ??= [];
  state.emailWatchers ??= [];
  state.sentDrafts ??= [];
  state.events ??= [];
  state.jobRuns ??= [];
  state.usageLedger ??= [];
  state.chatSessions ??= [];
  state.chatMessages ??= [];
  state.runs ??= [];
  state.planSteps ??= [];
  // Per-agent isolation backfill for record types other than memory. Runs
  // after every list default above so we never touch undefined arrays.
  // Idempotent — only stamps rows missing `agentId`.
  migrateRecordAgentIds(state);
  // Backfill Task.chatSessionId so the Tasks page can resolve task -> chat
  // session without a /state round-trip. Runs after chatMessages is
  // defaulted (above) so the join scan never sees undefined.
  migrateTaskChatSessionId(state);
  for (const session of state.chatSessions) {
    session.runIds ??= [];
    // Backfill the chats-IA `kind` for recurring-job channels only. Job
    // sessions map 1:1 to channels. Non-job sessions are intentionally
    // left undefined here — an agent may own several legacy sessions, so
    // getOrCreateAgentChat marks exactly one as the canonical "agent"
    // chat lazily on first access rather than mass-assigning every row.
    if (session.kind === undefined && session.origin === "job") {
      session.kind = "channel";
    }
  }
  // Convert legacy threads into linear Chat history (ADR
  // chat-topics-tasks-subagents.md). Marker-gated so it runs ONCE per instance.
  migrateThreadsToLinearHistory(state);
  // Give legacy chat-bound jobs a dedicated Topic + forwardToChat (ADR
  // chat-topics-tasks-subagents.md, "Jobs → Topics"). Runs after the
  // channel-kind backfill above so a job pointed at a real kind:"agent" Chat is
  // unambiguously a legacy deliverTo:"chat" rebind result. Marker-gated.
  migrateJobsToTopics(state);
  // Default deliveryPolicy on jobs that predate the field. Marker-gated.
  migrateJobsDeliveryPolicyDefaulted(state);
  migrateAutoInboxJobsToSilentDelivery(state);
  // Archive job channels orphaned by a pre-cleanup job deletion (issue #369).
  // Runs after the channel-kind backfill above so a legacy `origin:"job"`
  // session that just gained `kind:"channel"` is in scope, and after
  // `state.jobs` is defaulted so the surviving-job reference scan is safe.
  archiveOrphanJobChannels(state);
  // Home attention-queue backfills (both marker-gated): pin legacy topics for
  // the pinned-based sidebar, and seed acknowledgedAt so the first boot after
  // upgrade doesn't flood home. Run after the session-shape backfills above
  // so any session they minted or re-kinded is covered on the same first pass.
  migrateTopicsPinned(state);
  migrateContainersAckSeeded(state);
  for (const run of state.runs) {
    run.planStepIds ??= [];
    run.childRunIds ??= [];
    run.approvalIds ??= [];
  }
  for (const skill of state.skills) {
    const legacyStatus = (skill as unknown as { status?: string }).status;
    // Compatibility only: older state files used pre-enablement skill statuses.
    if (legacyStatus === "trusted") skill.status = "enabled";
    else if (legacyStatus === "draft" || legacyStatus === "untrusted") skill.status = "disabled";
    else if (!legacyStatus) skill.status = "disabled";
    skill.tests ??= [];
    skill.successCount ??= 0;
    skill.failureCount ??= 0;
    skill.previousVersions ??= [];
    // Filesystem skill loader (Slice 2) introduced these fields. Records
    // persisted before the loader landed don't carry them — backfill with
    // safe defaults so consumers can rely on `body` being a string.
    skill.body ??= "";
    // Skill records carry an explicit `source` so bundled and user-instance
    // skills with the same name coexist as separate rows. Legacy records
    // default to "user" — bundled records get re-tagged on the next
    // loadSkillsFromDisk pass.
    skill.source ??= "user";
    // ADR connector-provider-spec-compliance.md renamed SkillRecord.requiredIdentities (with `kind` keys) to
    // requiredConnectors (with `provider` keys). Rewrite in-place so the
    // record uses the new vocabulary; the loader will overwrite from disk
    // on the next reload anyway.
    const legacy = skill as unknown as { requiredIdentities?: unknown };
    if (Array.isArray(legacy.requiredIdentities) && !skill.requiredConnectors) {
      skill.requiredConnectors = legacy.requiredIdentities
        .map((entry) => {
          if (!entry || typeof entry !== "object") return null;
          const item = entry as Record<string, unknown>;
          const provider = typeof item.kind === "string" ? item.kind : typeof item.provider === "string" ? item.provider : "";
          if (!provider) return null;
          const scopes = Array.isArray(item.scopes) ? item.scopes.map(String) : undefined;
          return scopes ? { provider, scopes } : { provider };
        })
        .filter((entry): entry is { provider: string; scopes?: string[] } => entry !== null);
    }
    delete legacy.requiredIdentities;
  }
  // Convert provider-keyed connectors + the skill requires/grants that
  // reference them to the typed, named-credential model. Runs after the
  // connector `kind`→`provider` rename (migrateIdentitiesToConnectors) AND
  // after the skill `requiredIdentities`→`requiredConnectors` rewrite above so
  // every skill's requires is on the provider shape this migration reads.
  // Marker-gated + idempotent.
  migrateConnectorsToTypedCredentials(state);
  // Rename records to their provider's canonical credential name (e.g. a
  // pre-existing auto-detected "Codex" record → "codex") so name-based skill
  // activation (isSkillActive) matches them. Runs after the typed-credential
  // migration so template records already carry canonical names. Marker-gated.
  migrateConnectorCanonicalNames(state);
  for (const subagent of state.subagents) {
    // Slice 4 introduced `systemPrompt` (always present) and optional
    // toolsetIds/skillNames/resultSummary/resultError. Records persisted
    // before Slice 4 landed don't carry these — backfill `systemPrompt`
    // with an empty string so callers can rely on the field being a
    // string. The optional fields stay undefined for legacy rows.
    subagent.systemPrompt ??= "";
  }
  for (const job of state.jobs) {
    job.deliveryTargets ??= [];
    job.context ??= [];
    job.retryLimit ??= 0;
    job.timeoutSeconds ??= 600;
    job.runIds ??= [];
    // Drop the legacy `intervalSeconds: 0` sentinel on cron-driven jobs.
    // Earlier versions stored 0 on a cron-driven JobRecord so the field
    // stayed a `number`; we made `intervalSeconds` optional and cron jobs
    // now carry no interval at all. Idempotent: a state file already on
    // the new shape (intervalSeconds undefined) passes through untouched,
    // and an interval-driven legacy record with `intervalSeconds: 0` and
    // no cronExpression stays as-is so the next mutate-time guard surfaces
    // the bogus shape (which can't have been produced by current code).
    if (job.cronExpression && job.intervalSeconds === 0) {
      job.intervalSeconds = undefined;
    }
  }
  // Browser connection slot. The only persisted mode is `cdp` (the user
  // attached the runtime to their own external Chrome); the default spawned
  // transport carries no record. Keep a well-formed cdp record; coerce anything
  // else to null so a legacy/hand-edited state file holding a stale
  // `{mode:"managed",...}` record (the removed visible-window transport — issue
  // #420) or a malformed shape can't resurrect a removed transport or crash a
  // downstream consumer.
  if (state.browser !== undefined && state.browser !== null) {
    const candidate = state.browser as { cdpUrl?: unknown; mode?: unknown };
    if (typeof candidate !== "object" || candidate.mode !== "cdp" || typeof candidate.cdpUrl !== "string") {
      state.browser = null;
    }
  }
  // Tunnel selection singleton is purely opt-in (see ADR
  // tunnel-connectivity.md). Backfill null so legacy state files and
  // hand-edited files alike present a consistent shape to consumers.
  state.tunnel ??= null;
  return state;
}

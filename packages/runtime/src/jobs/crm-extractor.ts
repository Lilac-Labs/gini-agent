// CRM extraction controller: the always-on pipeline that turns the user's
// mailbox into people-crm rows. Owns the resumable backfill, the infinite
// watcher for future mail, and the pause/resume/status surface the gateway
// exposes. Design and measurements: ADR people-crm-extraction-pipeline.md.
//
// Execution model: curator turns are ordinary chat tasks submitted with the
// OWNING agent pinned (Task.agentId — the user's default agent, so contacts
// land in the database their assistant queries) and a persistent
// "crm-curator" subagent persona constraining each turn to the database
// toolset + people-crm skill with ambient memory off. Turns are convergent
// (schema-level CAS + UNIQUE arbitration), so the pool runs fully parallel
// and crash recovery simply re-runs whatever was mid-flight.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appendLog } from "../state";
import { readState, mutateState, createSubagentRecord } from "../state";
import { dbExecute, dbQuery } from "../state/agent-data-db";
import {
  crmBroadcastSenders,
  clearCrmCachedMessages,
  crmQueueCounts,
  enqueueCrmThreads,
  getCrmMeta,
  getCrmRunState,
  listCrmThreads,
  markCrmThreadIngested,
  markCrmThreads,
  requeueCrmErrors,
  setCrmMeta,
  setCrmRunState,
  type CrmQueueCounts,
  type CrmRunState,
} from "../state/crm-extraction-db";
import { readGoogleAccounts, readPrimaryGoogleAccountId } from "../state/google-accounts";
import { fixtureCrmMailSource, gmailCrmMailSource, type CrmMailSource } from "../integrations/crm-mail";
import {
  analyzeThread,
  batchByPrimary,
  buildTurnMessage,
  decideThread,
  makeSelfMatcher,
  type CrmMail,
} from "./crm-extraction-pipeline";
import { submitTask } from "../agent";
import { projectRoot } from "../paths";
import type { Instance, RuntimeConfig, SubagentRecord } from "../types";

export const CRM_CURATOR_SUBAGENT_NAME = "crm-curator";
const TURN_WORKERS = 16;
const INGEST_CONCURRENCY = 8;
// Read lazily so tests can shrink the timeout/interval after module import.
function turnTimeoutMs(): number {
  return Number(process.env.GINI_CRM_TURN_TIMEOUT_MS ?? "240000");
}
function watcherIntervalMs(): number {
  return Number(process.env.GINI_CRM_WATCH_INTERVAL_MS ?? "60000");
}
// Overlap window when polling for new mail — enqueue dedup makes re-listing
// the boundary idempotent.
const WATCHER_OVERLAP_MS = 60_000;

const CURATOR_SYSTEM_PROMPT = [
  "You are the CRM curator — a focused worker that maintains the user's people-CRM database from material handed to you in the task.",
  "You only use database tools (db_query, db_execute, db_schema). You never browse, never run terminal commands, never authenticate anywhere.",
  "Follow the people-crm skill instructions included in the task message. Read what you are handed, decide which real people it evidences, and fold them into the contacts/relations tables per the skill's rules.",
  "Be conservative about creating rows: never one for the user themself — but a display name matching the user's is not by itself the user; apply the skill's self check (address variants, self-mail behavior, signature details beyond the name) and keep a genuine name-twin as their own contact. No rows for cold one-way inbound pitches (sellers, recruiters cold-pitching, unsolicited job seekers) absent real engagement — but inbound pipeline pointed AT the user (a prospective customer, an investor, an applicant to a role the user posted, a warm intro through an existing contact) is not cold: fold those in even before the user replies. When in doubt about a stranger who is pitching, skip them.",
  "Finish with a single short line summarizing what changed (or why nothing did).",
].join("\n");

interface ExtractorHandle {
  loop?: Promise<void>;
  stopRequested: boolean;
  // Set to cut a watcher sleep short so a manual "sync now" (start on an
  // already-running pipeline) polls for new mail immediately instead of
  // waiting out the interval. Consumed by sleepUnlessStopped.
  wakeRequested?: boolean;
  inFlightTurns: number;
  lastError?: string;
  lastActivityAt?: number;
}

const handles = new Map<Instance, ExtractorHandle>();

// Recent complete threads fetched by onboarding before the People backfill
// starts. Process-local by design: a restart simply falls back to Gmail, while
// the normal path avoids persisting a second bootstrap mailbox. Keys include
// account id because Gmail thread ids are only account-scoped.
const onboardingThreads = new Map<Instance, Map<string, CrmMail[]>>();

function onboardingThreadKey(accountId: string, threadId: string): string {
  return `${accountId}\0${threadId}`;
}

export function primeCrmExtractionThreads(
  instance: Instance,
  accountId: string,
  threads: Array<{ threadId: string; messages: CrmMail[] }>,
): void {
  if (threads.length === 0) return;
  let cache = onboardingThreads.get(instance);
  if (!cache) {
    cache = new Map();
    onboardingThreads.set(instance, cache);
  }
  for (const thread of threads) {
    if (thread.messages.length > 0) cache.set(onboardingThreadKey(accountId, thread.threadId), thread.messages);
  }
}

function takeOnboardingThread(
  instance: Instance,
  accountId: string,
  threadId: string,
  newestDate: number,
): CrmMail[] | undefined {
  const cache = onboardingThreads.get(instance);
  if (!cache) return undefined;
  const key = onboardingThreadKey(accountId, threadId);
  const messages = cache.get(key);
  cache.delete(key);
  if (cache.size === 0) onboardingThreads.delete(instance);
  if (!messages) return undefined;
  // A message may arrive while the user is still in the wizard. The full
  // mailbox list is authoritative: a snapshot older than its queue row must
  // never hide that arrival, so discard it and refetch the current thread.
  let snapshotNewest = 0;
  for (const message of messages) snapshotNewest = Math.max(snapshotNewest, message.date);
  return snapshotNewest >= newestDate ? messages : undefined;
}

function handleFor(instance: Instance): ExtractorHandle {
  let h = handles.get(instance);
  if (!h) {
    h = { stopRequested: false, inFlightTurns: 0 };
    handles.set(instance, h);
  }
  return h;
}

// Test seam: closed-over sources by instance (fixture dirs in tests/dev).
// The single-source form models one account ("fixture"); the plural form
// models a multi-account registry.
const sourceOverrides = new Map<Instance, CrmMailAccount[]>();
export function __setCrmMailSourceForTests(instance: Instance, source: CrmMailSource | undefined): void {
  if (source) sourceOverrides.set(instance, [{ accountId: "", email: getCrmMeta(instance, "self_email") ?? "user@example.com", source }]);
  else sourceOverrides.delete(instance);
}
export function __setCrmMailSourcesForTests(instance: Instance, accounts: CrmMailAccount[] | undefined): void {
  if (accounts) sourceOverrides.set(instance, accounts);
  else sourceOverrides.delete(instance);
}

export interface CrmMailAccount {
  accountId: string; // '' = the legacy/single-source account (rows tagged '' route here)
  email: string;
  source: CrmMailSource;
}

export interface CrmExtractionStatus {
  runState: CrmRunState;
  counts: CrmQueueCounts;
  backfillSeeded: boolean;
  mailCursor: number | null;
  inFlightTurns: number;
  selfEmail: string | null;
  selfAddresses: string[];
  accounts: Array<{ accountId: string; email: string; backfillSeeded: boolean; mailCursor: number | null }>;
  agentId: string | null;
  subagentId: string | null;
  source: "gmail" | "fixture" | null;
  lastError: string | null;
  lastActivityAt: number | null;
}

// Every mailbox the user connected, deduped by email (two registry rows
// carrying the same address must not double-process one mailbox). The first
// entry is the PRIMARY (its email seeds the self row); extraction spans all
// of them — the directory covers everything the user is reachable at.
function resolveMailAccounts(instance: Instance): CrmMailAccount[] {
  const override = sourceOverrides.get(instance);
  if (override) return override;
  const fixtureDir = getCrmMeta(instance, "fixture_dir") ?? process.env.GINI_CRM_FIXTURE_DIR;
  if (fixtureDir) {
    return [{ accountId: "", email: getCrmMeta(instance, "self_email") ?? "user@example.com", source: fixtureCrmMailSource(fixtureDir) }];
  }
  const accounts = readGoogleAccounts().filter((a) => a.email);
  if (accounts.length === 0) return [];
  const primaryId = readPrimaryGoogleAccountId();
  const ordered = [...accounts].sort((a, b) => Number(b.id === primaryId) - Number(a.id === primaryId));
  const seen = new Set<string>();
  const out: CrmMailAccount[] = [];
  for (const account of ordered) {
    const email = account.email.toLowerCase();
    if (seen.has(email)) continue;
    seen.add(email);
    out.push({ accountId: account.id, email, source: gmailCrmMailSource({ configDir: account.configDir }) });
  }
  return out;
}

// The self set spans every connected address (speaking from ANY of the
// user's accounts is the user speaking) plus operator-supplied extras.
function selfAddresses(instance: Instance, accounts: CrmMailAccount[]): string[] {
  const extra = getCrmMeta(instance, "self_extra");
  const parsed = extra ? (JSON.parse(extra) as string[]) : [];
  const set = new Set<string>([...accounts.map((a) => a.email.toLowerCase()), ...parsed.map((e) => e.toLowerCase())]);
  return [...set];
}

// Per-account seed flag + cursor. The single-account era used bare keys —
// the '' accountId maps onto them, so an existing pipeline neither reseeds
// nor loses its cursor when this code arrives (its rows and meta simply
// belong to the '' pseudo-account until reopens re-tag them).
function seededKey(accountId: string): string {
  return accountId ? `backfill_seeded:${accountId}` : "backfill_seeded";
}
function cursorKey(accountId: string): string {
  return accountId ? `mail_cursor:${accountId}` : "mail_cursor";
}
// Reconciliation flag, keyed like the seed flag: connecting a new mailbox
// re-arms one directory-wide reconcile pass after ITS backfill drains.
function reconciledKey(accountId: string): string {
  return accountId ? `reconciled:${accountId}` : "reconciled";
}

// The skill body embedded into every turn (saves the read_skill round trip;
// measured in the ADR). Bundled path — the skill ships with the runtime.
let cachedSkillBody: string | undefined;
function skillBody(): string {
  if (cachedSkillBody) return cachedSkillBody;
  const raw = readFileSync(join(projectRoot(), "skills", "personal", "people-crm", "SKILL.md"), "utf8");
  cachedSkillBody = raw.replace(/^---[\s\S]*?---\n/, "");
  return cachedSkillBody;
}

async function ensureCuratorSubagent(config: RuntimeConfig, agentId: string): Promise<SubagentRecord> {
  const existing = readState(config.instance).subagents.find(
    (s) => s.name === CRM_CURATOR_SUBAGENT_NAME && s.agentId === agentId,
  );
  if (existing) return existing;
  return mutateState(config.instance, (state) => {
    const again = state.subagents.find((s) => s.name === CRM_CURATOR_SUBAGENT_NAME && s.agentId === agentId);
    if (again) return again;
    return createSubagentRecord(state, {
      agentId,
      name: CRM_CURATOR_SUBAGENT_NAME,
      prompt: "Persistent CRM curator persona for the email-extraction pipeline.",
      toolsets: [],
      systemPrompt: CURATOR_SYSTEM_PROMPT,
      toolsetIds: ["database"],
      skillNames: ["people-crm"],
      autoMemory: false,
    });
  });
}

// The reserved contact row for the user. The pipeline only knows the
// connected address; the curator folds newly-discovered self-aliases into
// this row per the skill (`You —` marker).
function seedSelfRow(instance: Instance, agentId: string, selfEmail: string): void {
  // SELECT 1, not id or rowid: the open migrates the retired email-PK shape
  // to the modern schema, but an agent-recreated custom contacts table may
  // lack an id column — and a WITHOUT ROWID one lacks rowid too. A bare
  // existence probe works against any shape that has the two columns.
  const existing = dbQuery(
    instance,
    agentId,
    "SELECT 1 FROM contacts WHERE description LIKE 'You —%' OR email_address = ? LIMIT 1",
    [selfEmail],
  );
  if (existing.rows.length > 0) return;
  dbExecute(
    instance,
    agentId,
    "INSERT INTO contacts (first_name, email_address, description) VALUES (?, ?, ?)",
    [
      "You",
      selfEmail,
      "You — the user's own reserved row. Newly-discovered self-addresses are recorded here as aliases, never as separate contacts.",
    ],
  );
}

function owningAgentId(config: RuntimeConfig): string {
  const state = readState(config.instance);
  return state.agents.find((a) => a.id === "agent_default")?.id ?? state.activeAgentId ?? "agent_default";
}

async function sleepUnlessStopped(handle: ExtractorHandle, ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until && !handle.stopRequested && !handle.wakeRequested) {
    await Bun.sleep(Math.min(1_000, until - Date.now()));
  }
  handle.wakeRequested = false; // consume a manual-sync wake
}

async function mapPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await fn(items[index]!);
    }
  });
  await Promise.all(workers);
}

// The whole-directory reconciliation turn (phase 2.5). Per-thread turns run
// in parallel and each sees only its own batch, so one human with two
// mailboxes (or a self-alias) can race into twin rows that no single turn
// had the evidence to merge — the UNIQUE constraints arbitrate identical
// keys, but two different addresses pass. One pass with the whole table
// visible closes that hole.
function buildReconcileMessage(skill: string, selfEmail: string): string {
  return [
    `Reconcile my people-CRM directory — a full pass over my mailbox just finished (your people-crm skill is included below — no need to read_skill). I'm ${selfEmail}.`,
    "",
    "```people-crm-skill",
    skill.trim(),
    "```",
    "",
    "This is a whole-directory audit, not a per-thread fold. Query ALL rows (scalar columns + description first; read a profile only when deciding a specific merge), then:",
    "1. Duplicate humans: rows sharing a distinctive full name are one person by default — merge per the skill's rules (keep the richer row, fold the other address and any unique dossier claims in, repoint `relations`, DELETE the thinner row) unless the dossiers prove two distinct humans.",
    "2. Me: any row that is actually me under another address folds into the reserved `You —` row as an alias per the skill's self check.",
    "3. Mention-only rows: DELETE rows with no address and no direct interaction (name-drops, calendar-only co-invitees), noting the mention in the citing contact's dossier.",
    "4. Repair the `You —` row if damaged: description keeps its `You —` prefix and one-line summary, aliases consolidated, no placeholder values anywhere.",
    "Finish with one short line summarizing merges/deletes/repairs (or why none were needed).",
  ].join("\n");
}

async function runReconcileTurn(
  config: RuntimeConfig,
  handle: ExtractorHandle,
  agentId: string,
  subagentId: string,
  selfEmail: string,
): Promise<boolean> {
  handle.inFlightTurns += 1;
  try {
    const task = await submitTask(config, buildReconcileMessage(skillBody(), selfEmail), {
      mode: "chat", agentId, subagentId,
    });
    const deadline = Date.now() + turnTimeoutMs();
    while (Date.now() < deadline) {
      await Bun.sleep(Math.min(2_000, turnTimeoutMs()));
      const row = readState(config.instance).tasks.find((t) => t.id === task.id);
      if (!row) return false;
      if (row.status === "completed") return true;
      if (row.status === "failed" || row.status === "cancelled") return false;
      if (row.status === "waiting_approval" || row.status === "needs_input") return false;
    }
    return false;
  } catch (error) {
    handle.lastError = error instanceof Error ? error.message : String(error);
    return false;
  } finally {
    handle.inFlightTurns -= 1;
    handle.lastActivityAt = Date.now();
  }
}

// One curator turn over one batch of threads; convergent, so a timeout is
// retried once and a crash simply leaves the rows for the next drain. Never
// rejects: any failure (including the pre-turn thread fetches) marks the
// batch's rows error — a thrown turn would take down the whole mapPool wave
// and with it the loop, stranding the other workers headless.
async function runTurn(
  config: RuntimeConfig,
  handle: ExtractorHandle,
  agentId: string,
  subagentId: string,
  accounts: CrmMailAccount[],
  accountByThread: Map<string, string>,
  messagesByThread: Map<string, CrmMail[]>,
  selfEmail: string,
  threadIds: string[],
): Promise<void> {
  handle.inFlightTurns += 1;
  try {
    const batch: { threadId: string; msgs: Awaited<ReturnType<CrmMailSource["fetchThread"]>> }[] = [];
    for (const threadId of threadIds) {
      const account = accountFor(accounts, accountByThread.get(threadId) ?? "");
      const msgs = messagesByThread.get(threadId) ?? await account.source.fetchThread(threadId);
      if (msgs.length > 0) batch.push({ threadId, msgs });
    }
    if (batch.length === 0) {
      markCrmThreads(config.instance, threadIds, { status: "skipped", error: "thread vanished from source" });
      return;
    }
    const content = buildTurnMessage(batch, skillBody(), selfEmail);
    const attempt = async (): Promise<{ ok: boolean; taskId: string; error?: string }> => {
      const task = await submitTask(config, content, { mode: "chat", agentId, subagentId });
      const deadline = Date.now() + turnTimeoutMs();
      while (Date.now() < deadline) {
        await Bun.sleep(Math.min(2_000, turnTimeoutMs()));
        const row = readState(config.instance).tasks.find((t) => t.id === task.id);
        if (!row) return { ok: false, taskId: task.id, error: "task disappeared" };
        if (row.status === "completed") return { ok: true, taskId: task.id };
        if (row.status === "failed" || row.status === "cancelled") {
          return { ok: false, taskId: task.id, error: `${row.status}: ${(row.error ?? row.summary ?? "").slice(0, 120)}` };
        }
        if (row.status === "waiting_approval" || row.status === "needs_input") {
          return { ok: false, taskId: task.id, error: `stuck: ${row.status}` };
        }
      }
      return { ok: false, taskId: task.id, error: "timeout" };
    };
    let result = await attempt();
    // Retry a timeout once — but never after a pause/disable: the retry is a
    // brand-new model turn, and the stop contract is "nothing new dispatches".
    if (!result.ok && result.error === "timeout" && !handle.stopRequested) result = await attempt();
    markCrmThreads(config.instance, threadIds, {
      status: result.ok ? "done" : "error",
      taskId: result.taskId,
      error: result.ok ? null : result.error,
      bumpAttempts: true,
    });
    handle.lastActivityAt = Date.now();
    if (!result.ok) handle.lastError = result.error;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    markCrmThreads(config.instance, threadIds, {
      status: "error",
      error: `turn: ${message}`.slice(0, 200),
      bumpAttempts: true,
    });
    handle.lastError = message;
  } finally {
    handle.inFlightTurns -= 1;
  }
}

async function runLoop(config: RuntimeConfig, handle: ExtractorHandle): Promise<void> {
  const instance = config.instance;
  try {
    while (!handle.stopRequested && getCrmRunState(instance) === "running") {
      // Each iteration is fenced: a transient failure (Gmail 429/5xx, a
      // failed token re-mint, a network blip) parks the loop for one watcher
      // interval and retries, exactly like the missing-source case — it must
      // never kill the always-on pipeline while the persisted state still
      // says "running". Every phase is idempotent, so re-running one is safe.
      try {
        await runLoopIteration(config, handle);
      } catch (error) {
        handle.lastError = error instanceof Error ? error.message : String(error);
        appendLog(instance, "crm.extraction.iteration_error", { error: handle.lastError });
        await sleepUnlessStopped(handle, watcherIntervalMs());
      }
    }
  } finally {
    handle.loop = undefined;
    appendLog(instance, "crm.extraction.loop_exited", { runState: getCrmRunState(instance) });
  }
}

// Route a queue row to the mailbox it came from. Rows tagged '' predate
// multi-account (or came from the fixture) and belong to the primary.
function accountFor(accounts: CrmMailAccount[], rowAccount: string): CrmMailAccount {
  return accounts.find((a) => a.accountId === rowAccount) ?? accounts[0]!;
}

// A single-account pipeline that predates the per-account meta keys carries
// bare backfill_seeded/mail_cursor entries; adopt them for the account so
// its mailbox is not re-backfilled (a full re-run of curator turns).
function adoptLegacyMeta(instance: Instance, account: CrmMailAccount): void {
  if (!account.accountId) return; // '' IS the legacy key space
  if (getCrmMeta(instance, seededKey(account.accountId)) !== undefined) return;
  const legacySeeded = getCrmMeta(instance, "backfill_seeded");
  if (legacySeeded === undefined) return;
  setCrmMeta(instance, seededKey(account.accountId), legacySeeded);
  const legacyCursor = getCrmMeta(instance, "mail_cursor");
  if (legacyCursor !== undefined) setCrmMeta(instance, cursorKey(account.accountId), legacyCursor);
  appendLog(instance, "crm.extraction.meta_adopted", { accountId: account.accountId });
}

// One pass of the phase machine. Returning (rather than looping internally)
// keeps the stop/run-state checks and the crash fence in runLoop as the
// single control point. Sources are re-resolved every pass, so an account
// connected while the pipeline runs gets its own backfill on the next
// iteration — extraction always spans ALL of the user's mailboxes.
async function runLoopIteration(config: RuntimeConfig, handle: ExtractorHandle): Promise<void> {
  const instance = config.instance;
  const accounts = resolveMailAccounts(instance);
  if (accounts.length === 0) {
    handle.lastError = "no mail source (connect a Google account)";
    await sleepUnlessStopped(handle, watcherIntervalMs());
    return;
  }
  const primary = accounts[0]!;
  adoptLegacyMeta(instance, primary);
  const agentId = owningAgentId(config);
  const isSelf = makeSelfMatcher(selfAddresses(instance, accounts));

  // Phase 0 — backfill seeding, exactly once per account.
  for (const account of accounts) {
    if (handle.stopRequested) return;
    if (getCrmMeta(instance, seededKey(account.accountId)) === "1") continue;
    const refs = await account.source.listMessages();
    const byThread = new Map<string, number>();
    for (const r of refs) byThread.set(r.threadId, Math.max(byThread.get(r.threadId) ?? 0, r.internalDate));
    enqueueCrmThreads(
      instance,
      [...byThread.entries()].map(([threadId, newestDate]) => ({ threadId, newestDate })),
      account.accountId,
    );
    const cursor = Math.max(0, ...refs.map((r) => r.internalDate));
    setCrmMeta(instance, cursorKey(account.accountId), String(cursor || Date.now()));
    setCrmMeta(instance, seededKey(account.accountId), "1");
    appendLog(instance, "crm.extraction.backfill_seeded", {
      accountId: account.accountId, email: account.email, threads: byThread.size, messages: refs.length,
    });
    handle.lastActivityAt = Date.now();
    return;
  }

  // Phase 1 — ingest: fetch + analyze pending threads (routed per account).
  const pending = listCrmThreads(instance, ["pending"], 200);
  if (pending.length > 0) {
    await mapPool(pending, INGEST_CONCURRENCY, async (row) => {
      if (handle.stopRequested) return;
      try {
        const account = accountFor(accounts, row.account);
        const msgs = takeOnboardingThread(instance, account.accountId, row.thread_id, row.newest_date)
          ?? await account.source.fetchThread(row.thread_id);
        if (msgs.length === 0) {
          markCrmThreads(instance, [row.thread_id], { status: "skipped", error: "thread vanished from source" });
          return;
        }
        const analysis = analyzeThread(msgs, isSelf);
        markCrmThreadIngested(instance, row.thread_id, {
          ...analysis,
          // Only plausible curator candidates need to cross the phase boundary.
          // Definite skips retain no raw payload; broadcast candidates are
          // cleared if the phase-2 aggregate later rejects them.
          messagesJson: analysis.engaged && analysis.hasHuman ? JSON.stringify(msgs) : null,
        });
      } catch (error) {
        markCrmThreads(instance, [row.thread_id], {
          status: "error",
          error: `ingest: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200),
          bumpAttempts: true,
        });
      }
    });
    handle.lastActivityAt = Date.now();
    return;
  }

  // Phase 2 — decide + run curator turns over everything ingested.
  const ingested = listCrmThreads(instance, ["ingested"]);
  if (ingested.length > 0 && !handle.stopRequested) {
    const broadcast = crmBroadcastSenders(instance);
    const keeps: typeof ingested = [];
    for (const row of ingested) {
      const verdict = decideThread(
        { engaged: row.engaged === 1, primarySender: row.primary_sender, hasHuman: row.has_human === 1 },
        broadcast,
      );
      if (verdict.keep) keeps.push(row);
      else markCrmThreads(instance, [row.thread_id], { status: "skipped", error: verdict.reason });
    }
    if (keeps.length > 0) {
      const subagent = await ensureCuratorSubagent(config, agentId);
      seedSelfRow(instance, agentId, primary.email);
      const accountByThread = new Map(keeps.map((r) => [r.thread_id, r.account]));
      const messagesByThread = new Map<string, CrmMail[]>();
      for (const row of keeps) {
        const messages = parseCachedMessages(row.messages_json);
        if (messages) messagesByThread.set(row.thread_id, messages);
      }
      const batches = batchByPrimary(
        keeps.map((r) => ({ threadId: r.thread_id, primarySender: r.primary_sender, chars: r.chars })),
      );
      appendLog(instance, "crm.extraction.wave", { threads: keeps.length, turns: batches.length });
      await mapPool(batches, TURN_WORKERS, async (batch) => {
        if (handle.stopRequested) return;
        await runTurn(
          config,
          handle,
          agentId,
          subagent.id,
          accounts,
          accountByThread,
          messagesByThread,
          primary.email,
          batch,
        );
      });
    }
    return;
  }

  // Phase 2.5 — one whole-directory reconciliation after a mailbox's
  // backfill fully drains (see buildReconcileMessage for why). Runs at most
  // once per account seed; three failed attempts stand down so a persistent
  // failure can't burn a turn every watcher interval.
  const unreconciled = accounts.filter((a) => getCrmMeta(instance, reconciledKey(a.accountId)) !== "1");
  if (unreconciled.length > 0 && crmQueueCounts(instance).done > 0 && !handle.stopRequested) {
    const attempts = Number(getCrmMeta(instance, "reconcile_attempts") ?? "0");
    if (attempts < 3) {
      const subagent = await ensureCuratorSubagent(config, agentId);
      seedSelfRow(instance, agentId, primary.email);
      appendLog(instance, "crm.extraction.reconcile", { attempt: attempts + 1 });
      const ok = await runReconcileTurn(config, handle, agentId, subagent.id, primary.email);
      if (ok) {
        for (const account of accounts) setCrmMeta(instance, reconciledKey(account.accountId), "1");
        setCrmMeta(instance, "reconcile_attempts", "0");
        appendLog(instance, "crm.extraction.reconciled", {});
      } else {
        setCrmMeta(instance, "reconcile_attempts", String(attempts + 1));
      }
    } else {
      for (const account of accounts) setCrmMeta(instance, reconciledKey(account.accountId), "1");
      setCrmMeta(instance, "reconcile_attempts", "0");
      appendLog(instance, "crm.extraction.reconcile_abandoned", {});
    }
    return;
  }

  // Phase 3 — watcher: poll every mailbox for new mail, then idle.
  let sawNew = false;
  for (const account of accounts) {
    if (handle.stopRequested) return;
    const cursor = Number(getCrmMeta(instance, cursorKey(account.accountId)) ?? "0");
    const refs = await account.source.listMessages(Math.max(0, cursor - WATCHER_OVERLAP_MS));
    if (refs.length === 0) continue;
    const byThread = new Map<string, number>();
    for (const r of refs) byThread.set(r.threadId, Math.max(byThread.get(r.threadId) ?? 0, r.internalDate));
    const { added, reopened } = enqueueCrmThreads(
      instance,
      [...byThread.entries()].map(([threadId, newestDate]) => ({ threadId, newestDate })),
      account.accountId,
    );
    const newest = Math.max(cursor, ...refs.map((r) => r.internalDate));
    setCrmMeta(instance, cursorKey(account.accountId), String(newest));
    if (added || reopened) {
      appendLog(instance, "crm.extraction.watch", { accountId: account.accountId, added, reopened });
      handle.lastActivityAt = Date.now();
      sawNew = true;
    }
  }
  if (sawNew) return; // ingest the new arrivals immediately
  await sleepUnlessStopped(handle, watcherIntervalMs());
}

export function crmExtractionStatus(config: RuntimeConfig): CrmExtractionStatus {
  const instance = config.instance;
  const handle = handleFor(instance);
  const accounts = resolveMailAccounts(instance);
  const primary = accounts[0];
  const accountRows = accounts.map((a) => {
    const cursor = getCrmMeta(instance, cursorKey(a.accountId));
    return {
      accountId: a.accountId,
      email: a.email,
      backfillSeeded: getCrmMeta(instance, seededKey(a.accountId)) === "1",
      mailCursor: cursor ? Number(cursor) : null,
    };
  });
  const state = readState(instance);
  const agentId = state.agents.find((a) => a.id === "agent_default")?.id ?? state.activeAgentId ?? null;
  const subagent = state.subagents.find((s) => s.name === CRM_CURATOR_SUBAGENT_NAME);
  const legacyCursor = getCrmMeta(instance, "mail_cursor");
  return {
    runState: getCrmRunState(instance),
    counts: crmQueueCounts(instance),
    // Aggregates keep their single-account meaning: seeded = every mailbox
    // seeded; cursor = the oldest per-account cursor (the frontier the
    // watcher is guaranteed to have covered everywhere).
    backfillSeeded: accountRows.length > 0 && accountRows.every((a) => a.backfillSeeded),
    mailCursor: accountRows.length > 0
      ? Math.min(...accountRows.map((a) => a.mailCursor ?? 0)) || (legacyCursor ? Number(legacyCursor) : null)
      : legacyCursor ? Number(legacyCursor) : null,
    inFlightTurns: handle.inFlightTurns,
    selfEmail: primary?.email ?? getCrmMeta(instance, "self_email") ?? null,
    selfAddresses: accounts.length > 0 ? selfAddresses(instance, accounts) : [],
    accounts: accountRows,
    agentId,
    subagentId: subagent?.id ?? null,
    source: primary?.source.kind ?? null,
    lastError: handle.lastError ?? null,
    lastActivityAt: handle.lastActivityAt ?? null,
  };
}

// Start, resume, or manually sync. On an idle/paused pipeline this launches
// (or resumes) the loop; on an already-running one it wakes the watcher for an
// immediate mail poll — the "Sync now" the People page offers. A disabled
// pipeline refuses to start — the master switch must be flipped back via
// enableCrmExtraction first.
export async function startCrmExtraction(config: RuntimeConfig): Promise<CrmExtractionStatus> {
  const instance = config.instance;
  if (getCrmRunState(instance) === "disabled") {
    throw new Error("Invalid input: CRM extraction is disabled — enable it first.");
  }
  const accounts = resolveMailAccounts(instance);
  if (accounts.length === 0) {
    // "Invalid input" prefix → the gateway maps this to HTTP 400.
    throw new Error("Invalid input: CRM extraction needs a connected Google account (or a fixture source).");
  }
  const primary = accounts[0]!;
  // Setup first, state flip last: if any setup step throws, the pipeline
  // stays in its prior state instead of reporting "running" with no loop.
  const agentId = owningAgentId(config);
  await ensureCuratorSubagent(config, agentId);
  seedSelfRow(instance, agentId, primary.email);
  setCrmMeta(instance, "self_email", primary.email);
  requeueCrmErrors(instance);
  setCrmRunState(instance, "running");
  const handle = handleFor(instance);
  handle.stopRequested = false;
  handle.lastError = undefined;
  // Wake a running loop's watcher sleep so this call syncs new mail now; a
  // fresh loop (below) polls immediately anyway and simply clears the flag.
  handle.wakeRequested = true;
  if (!handle.loop) {
    appendLog(instance, "crm.extraction.started", {
      source: primary.source.kind,
      accounts: accounts.map((a) => a.email),
    });
    handle.loop = runLoop(config, handle);
  }
  return crmExtractionStatus(config);
}

// Pause. In-flight curator turns finish (they are convergent and cheap to
// let complete); nothing new dispatches, the watcher stops, and the paused
// state survives restarts. Pausing a disabled pipeline is a no-op — the
// stronger state wins.
export async function pauseCrmExtraction(config: RuntimeConfig): Promise<CrmExtractionStatus> {
  const instance = config.instance;
  if (getCrmRunState(instance) !== "disabled") {
    setCrmRunState(instance, "paused");
    handleFor(instance).stopRequested = true;
    appendLog(instance, "crm.extraction.paused", {});
  }
  return crmExtractionStatus(config);
}

// Master switch off: stops the loop like pause, and additionally blocks
// start, the onboarding autostart, and the boot reconcile until enabled.
export async function disableCrmExtraction(config: RuntimeConfig): Promise<CrmExtractionStatus> {
  const instance = config.instance;
  setCrmRunState(instance, "disabled");
  handleFor(instance).stopRequested = true;
  onboardingThreads.delete(instance);
  clearCrmCachedMessages(instance);
  appendLog(instance, "crm.extraction.disabled", {});
  return crmExtractionStatus(config);
}

function parseCachedMessages(raw: string | null): CrmMail[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const messages = parsed.filter((value): value is CrmMail => {
      if (!value || typeof value !== "object") return false;
      const message = value as Partial<CrmMail>;
      return (
        typeof message.id === "string"
        && typeof message.threadId === "string"
        && typeof message.date === "number"
        && Array.isArray(message.to)
        && Array.isArray(message.cc)
        && typeof message.subject === "string"
        && typeof message.body === "string"
      );
    });
    return messages.length === parsed.length && messages.length > 0 ? messages : undefined;
  } catch {
    return undefined;
  }
}

// Master switch back on: returns a disabled pipeline to idle (it does NOT
// start it — POST start, or the next onboarding autostart, does that).
export async function enableCrmExtraction(config: RuntimeConfig): Promise<CrmExtractionStatus> {
  const instance = config.instance;
  if (getCrmRunState(instance) === "disabled") {
    setCrmRunState(instance, "idle");
    appendLog(instance, "crm.extraction.enabled", {});
  }
  return crmExtractionStatus(config);
}

// Boot reconcile: a pipeline that was running when the runtime died resumes
// automatically; a paused one stays paused.
export function reconcileCrmExtraction(config: RuntimeConfig): void {
  if (getCrmRunState(config.instance) !== "running") return;
  void startCrmExtraction(config).catch((error) => {
    appendLog(config.instance, "crm.extraction.reconcile_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

// Onboarding hook: fire-and-forget autostart once the user finishes
// onboarding with a Google account connected. Never throws into the
// onboarding path.
export function autostartCrmExtractionAfterOnboarding(config: RuntimeConfig): void {
  if (getCrmRunState(config.instance) !== "idle") return;
  if (resolveMailAccounts(config.instance).length === 0) return;
  void startCrmExtraction(config).catch((error) => {
    appendLog(config.instance, "crm.extraction.autostart_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

// Test seam: await the current loop's exit after a pause (keeps tests
// deterministic without exposing the handle).
export async function __awaitCrmLoopExitForTests(instance: Instance): Promise<void> {
  const handle = handleFor(instance);
  while (handle.loop) await Bun.sleep(20);
  while (handle.inFlightTurns > 0) await Bun.sleep(20);
}

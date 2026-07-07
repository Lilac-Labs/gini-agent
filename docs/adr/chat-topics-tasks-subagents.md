# ADR: Chat → Topics → Tasks → Subagents

- **Status:** Accepted (2026-06-26; shipped across 10 commits on the implementing branch)
- **Date:** 2026-06-25
- **Supersedes / reverses:** [One Chat Per Agent, Threads, And Job Channels](./agent-chat-threads-and-channels.md) (threads-as-tags and one-canonical-chat are reversed)
- **Superseded in part by:** [Task Containers And Runs](./task-containers-and-runs.md) — the container side of the hierarchy is unified into one task-container primitive (topic = a container the user pinned), and the Task tier's "needs-input as a structured return value" became the persisted `needs_input` status with `spawn_task` child containers for user-facing delegation. The routing, forwarding, and per-topic context-isolation decisions here still stand.
- **Updates:** [Bounded Chat Context Window](./chat-context-window.md) (per-session soft thread-priority packing becomes per-topic hard isolation)
- **See also:** [ChatBlock Protocol](./chat-block-protocol.md), [Agent Loop With Native Tool Calling](./agent-loop-tool-calling.md), [Per-Agent Memory Isolation](./agent-memory-isolation.md)

## Decision

Reorganize the conversation model from **one chat per agent + threads-as-tags** into a
four-level hierarchy:

```
Chat ──(1:N)──> Topics ──(1:N)──> Tasks ──(1:N)──> Subagents
```

- **Chat** is a *special, always-present Topic* and the user's main interface. It does
  **not** own the working context for substantive requests. It is a **router + inbox**:
  it classifies each user message (answer-here / open-new-topic / continue-existing-topic),
  dispatches the work into the chosen **Topic**, and surfaces the Topic's **final** answer
  back in Chat, tagged with the Topic (a forwarded, deep-linkable chip).
- **Topic** is a session whose context is **fresh and isolated to that subject**. It is a
  first-class `ChatSessionRecord` with its own `chat_blocks` ordinal stream, SSE, read
  state, APNs routing, and — the load-bearing win — its **own context window**. Topics
  are started by Chat, by a Job, or by another Topic. A Topic has access to all skills and
  memory. This is what actually fixes "the context window is always filled with irrelevant
  information": each Topic replays only its own transcript.
- **Task** is a unit of delegated work a Topic creates, with explicit task-states. Input:
  prompt, goal, context, tools, skills, memory. Output: success / fail result, **or
  "additional input needed."** A Task owns one-or-more Subagents.
- **Subagent** does the actual unit(s) of work, started by a Task and returning to a Task.
  Input: prompt, context, tools, skills, memory. Return: success / fail result, or
  additional input. The simplest Task is a single Subagent.

This **reverses** the central decision of `agent-chat-threads-and-channels.md` ("**no new
session per thread** — threads ride the same ordinal stream"). The whole reason that ADR
chose tags-on-one-stream was to reuse the ChatBlock protocol; a Topic-as-session gets the
**same** reuse at the granularity the protocol was designed for, *plus* genuine context
isolation, which tags can never give.

## Context — why threads fail

Two flaws, both rooted in one structural fact (one transcript per agent):

1. **Agent-started threading is unpredictable.** Routing is decided *mid-turn* by the model
   calling `start_thread` (or emitting `<route>thread</route>`). The model fires it
   inconsistently, and when it does, the thread roots on whatever message triggered it, so
   related work scatters across messages and threads are hard to track. (Routing is a
   model behavior, not a structural guarantee.)
2. **The context window fills with irrelevant info.** Because every thread is a tag on the
   *one* agent session, every turn replays that one giant transcript. `chat-context-window.md`
   only *softens* this with thread-priority packing (`groupPriority`, `activeThreadId`):
   unrelated threads are *deprioritized*, not *excluded* — they still enter the budget if
   they fit. There is no hard per-subject isolation.

Topics fix both at the source: routing moves **up** (Chat picks a Topic at intake, before
any work streams) and context moves **out** (a real separate session = a real separate
window). The flaky mid-turn `start_thread` decision and the thread-priority packing
heuristic both **disappear** rather than getting patched.

## How the new model maps onto existing primitives

The redesign is mostly a **promotion and re-wiring** of things that already exist, not a
greenfield build:

| New concept | Closest existing thing | Gap to close |
|---|---|---|
| **Topic** | `kind:"channel"` job session (a real session with its own stream) | Generalize beyond jobs; add `kind:"topic"` (Chat keeps `kind:"agent"`); give it a title/summary + findable identity |
| **Chat** | the `kind:"agent"` canonical session (`getOrCreateAgentChat`) | Stop being the context owner; become a router/forwarder; keep "one per agent" |
| **Task** | the parent `Task` that calls `spawn_subagent` (already the Task tier) | Add the structured `needs_input` return so a unit of work can bubble "additional input needed" (no new record layer, no new status); optional `goal`/`context` framing |
| **Subagent** | `SubagentRecord` + `spawnSubagent` (constrained child task, fresh narrow context) | Already the right shape; add the "needs input" return variant; elevate its fresh-context property to the Topic tier |
| **Forward topic→chat** | job `finalize.ts` mirror + the "from \<job name\>" web/mobile segment badge | Generalize into a reusable Topic→Chat forwarder ("from #topic" + "View topic →") |
| **Per-topic context window** | `priorChatMessages` already filters `m.sessionId === sessionId` | Once Topic = session, isolation is automatic; delete thread-priority packing |
| **Chat reply → existing topic** | — (net new) | The hard problem: subject→topic resolution + cross-session dispatch + forward-back |

## Data model

### Session kind

`ChatSessionRecord.kind` (`packages/runtime/src/types.ts`) extends from `"agent" | "channel"` to add
**`"topic"`** — and **Chat is the existing `kind:"agent"` session**, kept as-is (it is
already the single always-present per-agent chat). We deliberately do **not** rename
`"agent"`→`"chat"`: `kind` is consulted in dozens of value checks across the gateway, web,
and mobile (`isOpenableJobChannel`, `unreachableSessionIds`, the sidebar/rails,
`getOrCreateAgentChat`), and a value rename would churn all of them for no behavioral gain.
The `kind:"agent"` session simply *plays the Chat role* in the new IA (surfaced as
"Messages").

- **`"agent"`** — Chat: the single always-present per-agent chat (unchanged; resolved by
  `getOrCreateAgentChat`, which only manages `kind:"agent"` sessions and therefore never
  demotes Topic siblings).
- **`"topic"`** — a subject-scoped session (new). Carries:
  - `title` (the existing session field, reused) — the `#name` shown in the sidebar.
  - `topicSummary?` — a short rolling summary used for routing/retrieval (seeded from the
    originating message; falls back to embedding-recall when there are many Topics).
  - `parentChatSessionId?` — the Chat that spawned it (the forward-back target).
  - `origin?: "job"` for job-spawned Topics.
- **`"channel"`** — a job channel; functionally the job's Topic (its own session + context).
  Kept as `kind:"channel"`; the cosmetic value-rename to `"topic"` is deferred (see
  Implementation notes). Jobs forward into Chat via `JobRecord.forwardToChat`.

`normalizeState` keeps existing `kind` values (no `"agent"`/`"channel"` rewrite) and only
nulls legacy thread tags (Decision 3).

### Topic record vs. session extension

**A Topic IS a `ChatSessionRecord`** (a `kind:"topic"` session), not a new
`TopicRecord` table. Rationale: per-topic context isolation, the block stream, SSE,
`Last-Event-ID` resume, read-state, badge, and APNs all already key on `session_id` — a
Topic-as-session inherits all of it for free. A parallel `TopicRecord` would re-derive that
machinery (the exact mistake the threads ADR avoided, now applied correctly at session
grain). The cross-store caveat (sessions in JSON `RuntimeState`, blocks in SQLite) is
unchanged.

### Task / Subagent

> **Superseded** (2026-07-03) by ADR task-containers-and-runs.md: `needs_input` is now
> a persisted `TaskStatus` (a reclassification of the `ask_user` park, not a new record
> layer), and agent-created user-facing work is a **child task container** minted via
> `spawn_task` — "subagent" now refers only to invisible in-run helpers. The
> no-new-record-layer reasoning below is preserved as context.

- **The Task tier is the existing parent-`Task` + `spawnSubagent` edge** — a Topic turn *is*
  the Task; `spawnSubagent` produces a constrained child Task. No new `TaskRecord` table and
  no new persisted `TaskStatus`/`SubagentStatus` member is added (either would fork
  `subagentDepth`, the cancel-cascade, `toolCallState` resume, and the renderers).
- **"Additional input needed" is a structured return value**, not a persisted state: when a
  subagent's `ask_user` has no answerable surface it returns `{needsInput, question}`, which
  `spawnSubagentTool` surfaces to the parent (carried on `Task.needsInput` /
  `SubagentRecord.resultNeedsInput`) so the parent re-asks via the existing
  `ask_user`→forward path — no spurious wait-timeout. Optional `goal`/`context` framing
  fields are added to the subagent input.
- The `parentTaskId` chain + `subagentDepth` cap (max 3) and `agentId` inheritance are
  preserved precisely *because* no record is inserted between parent and subagent.

### Forwarding

A **forward** mirrors a Topic turn render-only into the Chat session: every block it emits —
tool calls, intermediate narration, phases, system notes, and the final `assistant_text` — is
copied across, each tagged with `forwardedFromTopicId` + `forwardedFromTopicTitle` (carried in
the block's `payload_json` — no schema migration) and never replayed into the model context.
The "from #topic · View topic →" deep-link chip rides only on the turn's **final answer**, not
under every mirrored narration line (the client flags the closing answer when grouping the
exchange), generalizing the existing "from \<job name\>" segment. Pending gate cards
(`setup_requested` / `authorization_requested`) from a Topic turn forward the same way and keep
their own chip while staying actionable in Chat (gates are global by id).
The reverse — a Chat reply routed into a Topic — mirrors the user message into the Topic,
runs the turn in the Topic's context, and forwards the answer back. `transcriptSessionId`
for `persistFinalAnswerRow` must point at the **Topic** (replay correctness), even though
the user saw the answer in Chat — getting this wrong re-introduces the "re-answers the
previous question" bug across two sessions.

## Routing (the hard, net-new mechanism)

When a user posts in **Chat**, a lightweight **router** decides one of:

1. **answer-in-chat** — trivial/conversational; Chat answers directly, no Topic.
2. **open-new-topic** — a new subject; mint a `kind:"topic"` session, run the work there,
   forward the final answer back to Chat.
3. **continue-existing-topic** — find the right Topic for this subject and dispatch into it
   (the "drafted an email about a trip, then later 'book the event tickets' → find the trip Topic"
   case), then forward back.

**Mechanism (hybrid):** an embedding/recall pre-filter over Topic
`topicSummary`/`title` surfaces candidate Topics; a small **structured router call**
(`routeChatMessage`, built like the chat-title generator `generateChatTitleFromBlocks`)
makes the final 3-way decision with those candidates in context, returning
`{decision: "chat"|"new_topic"|"existing_topic", topicId?, title?}`. The decision happens
**at intake** (it selects which transcript loads) instead of mid-stream (tagging
already-streamed blocks). A structured classifier is used instead of agent control tools
because the decision must precede context loading and a forced structured output is more
reliable than hoping the agent calls a tool. The new-vs-existing-vs-inline bias lives in
the router's own prompt, not in hard-coded heuristics.

"At intake" bounds the verdict against the *turn* (no run/task/context exists until it
lands), not against the POST: the router is a model call, so making the HTTP ack wait on
it put ~1s+ of dead air on every message a user sends. The submit path acknowledges and
renders the message first, then obtains the verdict off the request path (see ADR
chat-message-queue.md, "Echo-first instant ack"). The router's classifier prompt excludes
the just-inserted echo block from its recent-conversation section so routing sees the same
inputs it saw when it ran pre-ack.

## Jobs → Topics

A Job **creates a Topic** (today it mints a `kind:"channel"` session — the same act,
renamed). "Deliver to chat" stops being a `chatSessionId` *re-pointer* onto the user's
conversation and becomes a **forward flag** (`job.forwardToChat`) on top of the always-
present `job.topicId`: each fire runs in the Job's Topic and *forwards* its final message
into Chat tagged with the Topic. Consequences:

- The chat-bound **deferral-by-skip** (`runDueJobs` skipping a due job while the chat has a
  live turn) is no longer needed for non-forwarded delivery — a job runs in its own Topic,
  never on the live Chat turn's ordinal range. It survives, if at all, only as a narrow
  "don't forward into Chat mid-turn" guard at the forward step.
- The rebind-archive-channel branch is removed (the Topic is never archived just because
  delivery moved to Chat). Channel-archive-on-job-delete stays (the Topic dies with the job).
- `outboundMirror`/`source`, `deliveryTargets`, `[SILENT]`, oneShot, and fan-out routes
  (each route → a sub-Topic) carry over.

## Client contract

- **Sidebar:** a **"Topics"** section (the Pencil design) lists `#name` Topics with unread
  badges, plus the single **"Messages"** (Chat) entry. The cross-agent `/threads` inbox
  becomes a Topics list. Channels fold into Topics.
- **Main Chat:** forwarded Topic results render in a highlighted block with a "#topic ·
  N messages · View topic →" chip. "Reply in thread" becomes **"Continue as a topic."**
- **Topic view:** structurally the existing pinned-`?session=` channel view, retitled with
  the Topic header ("#topic · N messages") and an "Also send to main" affordance.
- **New/changed routes:** `GET /api/agents/:id/chat` (now resolves the Chat root);
  `GET /api/topics` (replaces `/api/threads`); `POST /api/chat/:id/messages` gains routing;
  a forward/route endpoint; the `/api/chat/:id/threads*` routes become topic routes. Every
  wire change (`topicId`/forward marker, any Task/Subagent block kind) must update **both**
  web and mobile renderers (the dual-renderer rule; mobile's `BlockRenderer` `never`-guard
  catches new block kinds but not new fields).
- **Read-state:** session-level store applies per-topic unchanged; the per-thread
  localStorage store is replaced by per-topic keys (re-seed to avoid an all-unread flash).

## Migration

- `kind:"agent"` session stays the Chat root (no rename). Its untagged main-chat blocks stay.
- `kind:"channel"` job sessions stay `kind:"channel"` (each is the job's Topic) and gain
  `forwardToChat` semantics — no kind rewrite.
- Jobs whose `deliverTo:"chat"` pointed `chatSessionId` at the user's conversation get a
  **minted Topic** + `forwardToChat=true` (they have no dedicated Topic today).
- **Legacy threads:** *recommended* — freeze in place, readable as-is; new subjects become
  Topics. Converting each `(sessionId, threadId)` span into a standalone Topic session
  requires re-homing blocks into new sessions with re-based ordinals (the `UNIQUE(session_id,
  ordinal)` invariant) — a real data migration, not an additive column change. (Alternative:
  do the conversion; heavier and riskier.)
- In-flight tasks carry `toolCallState`/`bootResumeCount` and resume on restart — migration
  must not strand them.

## Resolved decisions (locked 2026-06-25)

1. **Topic creation is agent-decided per message.** A 3-way router (answer-in-chat /
   open-new-topic / continue-existing-topic) classifies each Chat message; the bias lives in
   the router's prompt (a structured intake classifier), not a hard rule.
2. **Routing is hybrid.** Embedding recall over Topic `topicSummary`/`title` surfaces
   candidate Topics; a small structured router call (`routeChatMessage`) makes the final
   3-way decision, returning `{decision, topicId?, title?}`.
3. **Legacy threads are converted into the linear Chat history** — not displayed as threads,
   and not split into separate Topic sessions. Their `thread_id`/`parent_block_id` tags are
   nulled so the blocks read as one linear Chat history in ordinal order; new subjects become
   Topics. (No block re-homing / ordinal re-basing — the blocks already share the agent
   session's one ordinal stream, so this is a nulling backfill.)
4. **The full hierarchy ships, including the Task tier.** Topics + routing + forwarding +
   context isolation + Jobs→Topics **and** the Task tier — realized as the `needs_input`
   structured return on the existing parent-Task + `spawnSubagent` edge (no new record layer
   or persisted status; see Implementation notes). Thorough automated tests plus a
   live-gateway dogfood gate each phase.

## Phasing (proposed)

1. **Topic data model + per-topic context isolation** — add `kind:"topic"`, `createTopic`,
   per-topic packer scope (a topic replays its own session); `normalizeState` thread→linear
   backfill. (Backend; the core win.)
2. **Chat→Topic routing + forwarding** — the router (open/route + retrieval), the
   topic↔chat forward bus, cross-session queue handling.
3. **Jobs → Topics** — job creates a Topic; `forwardToChat`; retire deferral-by-skip.
4. **Task-tier formalization** — explicit Task states + `needs_input` structured return.
5. **Clients (web + mobile)** — Topics sidebar, topic view, forwarded-topic chip,
   "Continue as a topic"; remove/repurpose thread UI (dual-renderer).
6. **Remove thread machinery + ADR finalization + tests + live dogfood.**

## Consequences

Pro: the two flaws are solved structurally, not patched; per-topic context windows; the
ChatBlock protocol is reused at the right granularity; jobs/channels unify with topics;
thread-priority packing and the flaky mid-turn `start_thread` decision are deleted.

Con: routing is a new model-driven step at intake (a latency/cost tradeoff for trivial
messages, mitigated by the answer-in-chat path); a Chat reply that runs in a Topic is a
two-session turn no current path models (queue, run-scoping, forward-back must be exact);
legacy threads either freeze or require a real data migration; the Task tier adds a record
layer that must preserve the `subagentDepth` chain.

## Implementation notes / deferrals

- **Chat is the existing `kind:"agent"` session**, kept (not renamed to `"chat"`) — see Session kind.
- **Job Topics keep `kind:"channel"` (`origin:"job"`)** rather than being renamed `kind:"topic"`.
  Functionally they are the job's Topic (own session, own context) and now forward into Chat via
  `JobRecord.forwardToChat`; the cosmetic value-rename `"channel"→"topic"` is deferred to avoid
  churning every `kind` check across gateway/web/mobile. They surface in the rails' Recurring-jobs
  section, not the Topics list.
- **The Task tier is the existing parent-`Task` + `spawnSubagent` edge**, not a new record layer
  (which would fork `subagentDepth`, the cancel-cascade, `toolCallState` resume, and the renderers).
  The only net-new capability — "additional input needed" — is a structured `needs_input` **return
  value** (a subagent's `ask_user` wall bubbles to its parent, which re-asks via the existing
  `ask_user`→forward path), plus optional `goal`/`context` framing fields and forwarding a Topic
  turn's pending gate cards into Chat. No new persisted `TaskStatus`/`SubagentStatus` members.
  *(Superseded: `needs_input` is now a persisted `TaskStatus` and `spawn_task` mints child task
  containers — see ADR task-containers-and-runs.md. The helper bubble-up path itself is unchanged.)*
- **Mobile native-only behavior** (a real push-notification tap, RN touch/gesture on the new Topic
  rows + forwarded chip) is covered by unit tests + typecheck but not yet exercised on a simulator.

## Acceptance checks

- `bun run test` / `bun run typecheck` green across runtime + web + mobile (modulo a pre-existing
  ~1/6 flaky-timing pool — SSE stream / discord poller / chat auto-rename — and pre-existing
  RN-module-resolution failures in two mobile test files, both confirmed unrelated to this change).
- **Phase 1** — `createTopic`, `getOrCreateAgentChat` not promoting a Topic, the v10 `chat_blocks`
  thread-tag null migration, and the marker-gated `chatMessages`/`pendingMessages` strip
  (records / agent-chat-resolver / store / memory-db tests).
- **Phase 2** — the topic dispatch + forward round-trip (`chat-topic-forward.test.ts`: new topic +
  forward, replay scoping keeps the answer in the Topic, per-topic queue, chat-direct unchanged) and
  the structured router 3-way decision + recent-conversation/topic-summary prompt + validator
  hardening (`chat-route.test.ts`).
- **Phase 3** — a `forwardToChat` job materializes in its Topic AND forwards a tagged block into the
  owning agent's Chat; channel-only forwards nothing; the chat-bound deferral is gone; the migration
  mints a Topic + `forwardToChat` for a legacy chat-bound job (`jobs.test.ts`, `store.test.ts`).
- **Phase 4** — a subagent `ask_user` with no answerable surface returns `status:"needs_input"`
  (no timeout) and the parent reads it as a parseable tool result; `goal`/`context` render as
  labeled system-prompt sections; a Topic turn's `setup_requested` gate forwards an actionable copy
  (same id) into the parent Chat (`subagents.test.ts`, `chat-task-emit.test.ts`).
- **Live-gateway dogfood (codex `gpt-5.5`, driven through the web app):** routing a new substantive
  message into a fresh Topic with the answer forwarded back; a follow-up continuing the *existing*
  Topic; the cross-topic "sort out the game tickets" jumping back to the trip Topic over a
  more-recent distractor; a quick advice ask staying chat-direct; the chat rendering as one linear
  timeline with `from #topic · View topic →` chips and the Topics sidebar/topic-view — all verified
  in the browser after the thread machinery was removed.

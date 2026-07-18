# ADR: Routine-Template Catalog And Gallery

- **Status:** Accepted
- **Date:** 2026-07-07
- **See also:** [Web Onboarding Flow](./web-onboarding-flow.md), [Job Skill Attachments](./job-skill-attachments.md)

## Decision

Present the starter routines (Auto-inbox, Morning Briefing, Meeting
Briefing) as a one-click **gallery** in the web app (`/routines`), backed by
a shared **routine-template catalog** in the runtime
(`packages/runtime/src/runtime/routine-templates.ts`).

The catalog is a typed array in code — deliberately *not* a marketplace, a
disk loader, or a user-authored template system. Each `RoutineTemplate`
carries the presentation fields the gallery renders (`name`, `description`,
`icon` key, `scheduleHint`) plus **per-function settings sections**
(`settings: RoutineSettingsSection[]` — one collapsible group per routine
function, e.g. Auto-inbox's "Label new mail" / "Draft replies to important
emails" / "Assist with scheduling") and a `buildSpec` that composes the
`createScheduledJob` payload (prompt, cron, skills) server-side from the
resolved settings state. Each section holds typed fields discriminated on
`kind` — `toggle` (boolean), `text` (multiline string, e.g. a draft-replies
scope or scheduling rules), and `labelList` (editable Gmail filtering labels:
name, UI-only swatch color, classification rule, per-label auto-archive, and
an optional seed-provenance `origin` tag) — each with a catalog default. Field keys are flat across sections (sections
are presentation grouping only), and the resolved state
(`RoutineSettings`, keyed by field key) is validated server-side by
`resolveSettings` (unknown keys rejected; per-kind shape checks; label list
capped with trimmed names/rules and palette-fallback colors). Prompts and
cron expressions stay product-owned in the catalog and are never composed in
the browser — the client only sends settings state. Adding a template is one
catalog entry.

### Per-account settings values

A template can mark `perAccountSettings: true` (Auto-inbox does): the field
*schema* stays shared, but the *values* are kept per connected Google
account, keyed by lowercased email — the same address key the email-watch
records and the agent's account selection use. The persisted shape is a
wrapper, `templateSettings = { accounts: Record<email, RoutineSettings> }`,
distinguishable from a legacy flat blob by its `accounts` object.
`resolveInstallSettings` owns the install shapes: an email-keyed body (any
key carrying "@") validates each entry through `resolveSettings` (at most
10 accounts; keys must be bounded, whitespace-free email addresses,
lowercased on store); a flat body — including the legacy boolean `options`
map, which is how `POST /api/onboarding/routines` arrives — applies alike
to every account attached to this instance; an absent body seeds one entry
per attached account from the per-account defaults. With zero attached
accounts every non-account-keyed shape falls back to the flat single blob, so instances
without a Google account keep the flat behavior end to end. Account
enumeration synchronously filters the machine-global registry through the
instance binding (`googleAccountsForInstance`, rows with a known email) —
never the live-status probe — because it runs on every gallery GET.

Auto-inbox's `buildSpec` composes the per-account wrapper into one prompt:
a preamble instructing the run to work ONLY the listed accounts, then per
account an `Account <email>:` heading followed by that account's own
behavior lines (its label list and prefix, reply scope, scheduling rules).
Accounts with every function off are omitted; all accounts off builds no
spec (the same zero-behavior rule as the flat shape), and the
google-calendar skill attaches when ANY account assists scheduling.

An account connected AFTER an install still appears in the Settings tab
(the view join below adds it with seeded defaults) and joins the persisted
map on the next save — but the baked prompt covers only the accounts
configured at install time until then; connecting an account does not
auto-reinstall.

### Gmail label discovery seeds per-account defaults

An account's *seeded defaults* always MERGE the user's own labels with the
standard starter set. When a Google account is connected, a fire-and-forget
background pipeline (`src/runtime/label-discovery.ts`, mirroring the
onboarding profile scan's discipline) digests the account's EXISTING Gmail
labels: a deterministic fetch stage — the same auth gate as the onboarding
scan's mailbox fetch (the plaintext `authorized_user` credential when
present, else one `gws auth export --unmasked` spawn for keyring-backed
logins) minting an in-memory token, then direct Gmail HTTP for the
user-created label list plus per-label message counts and a few recent
From/Subject samples — feeds ONE `generateStructured` call that keeps the
labels a human plainly uses to organize mail, infers each one's
plain-language classification rule, and — given the standard catalog
alongside the usage evidence — returns `coveredStandard`: the standard
label names whose function an existing label already serves (an existing
"Receipts" covers "orders"), so the seed never suggests a duplicate
function without renaming or merging the user's own labels. Labels under
the routine's own output namespace (`Gini/…`, the labelPrefix composition)
are excluded at the fetch stage: on a mailbox where Auto-inbox already ran
they are the routine's product, and re-importing them would circularly seed
the profile with our own labels. The validator clamps rather than rejects
(label names and samples are untrusted mailbox content), a digested label
must name one of the REAL input labels, `coveredStandard` must name catalog
labels, and auto-archive is always off — archiving stays a user opt-in. An
account where both credential paths come up empty records a clean failure.

The digest persists machine-globally per account at
`~/.gini/google-accounts/<accountId>/label-profile.json`
(`src/state/google-label-profiles.ts`, atomic writes, never-throw reads,
swept with the account's managed dir on removal; a stale `running` record
older than five minutes is treated as orphaned and re-runnable).
`ensureLabelProfile` guards re-entry (in-flight set; ready and fresh-running
skip) and fires from the connect paths — `POST /api/google/accounts` and the
loopback web login callback —
plus a backfill on the gallery GET that only targets accounts with no
profile at all, so a persistent failure never loops on the poll-driven
read. An account's seed is the discovered labels first (tagged
`origin: "existing"`), then the standard catalog labels not functionally
covered and not name-colliding case-insensitively (tagged
`origin: "suggested"`, truncating first at the 20-label seed cap); a
failed, absent, or empty profile seeds the full standard set, all
suggested, and a pre-`coveredStandard` profile suggests the full standard
set minus name collisions. The `origin` tag is presentation only — the web
renders it as a read-only badge, a valid tag survives save round-trips
(`resolveLabelRule`), and `buildSpec` never composes it into the job
prompt. A saved settings entry always beats the seed, and the user can edit
everything in the settings UI afterwards.

Two callers share the catalog:

- the **onboarding starter-routines step** — `routineJobSpecs` in
  `src/runtime/onboarding.ts` maps its `POST /api/onboarding/routines` body
  onto the same `buildSpec` calls (the endpoint's contract is unchanged; see
  ADR web-onboarding-flow.md)
- the **gallery endpoints**, thin `src/http.ts` delegations into the module:

| Endpoint | Behavior |
| --- | --- |
| `GET /api/routines/templates` | The catalog joined with installed state — the live job carrying each `templateId`, scoped by `?agentId=` like `GET /api/jobs`. `installed.settings` carries the job's resolved settings state: the persisted `templateSettings` when stamped, else the legacy `templateOptions` mapped through the template's `legacySettings` hook, each filled with the catalog defaults (absent on templates without settings and on jobs predating provenance). Per-account templates carry `installed.accountSettings` instead — one row per account attached to the instance (`{ accountId, email, primary?, settings }`, exactly the effective primary marked) with per-account precedence: the account's saved entry in the `{ accounts }` wrapper, else the job's legacy flat stamp, else the account's seeded defaults. The flat `installed.settings` remains only when no account is attached. |
| `POST /api/routines/templates/<id>/install` | Body `{ timezone?, settings?, options? }`. Missing setting keys fall back to the template defaults; the legacy flat boolean `options` map is still accepted and mapped through `legacySettings`; for per-account templates `settings` may be the email-keyed map (see Per-account settings values above); timezone precedence is payload > onboarding record > UTC. Idempotent per-template replace scoped to the active agent: skills are pre-validated (`assertSkillNamesResolve`, a clean 400 with zero side effects), then the owning agent's job with this `templateId` is deleted and one fresh job created via `createScheduledJob` — the same call `POST /api/jobs` makes. The owning agent is resolved server-side (never caller-supplied), the same way `createScheduledJob` stamps `agentId`. Returns the `JobRecord`. |
| `DELETE /api/routines/templates/<id>` | Removes the active agent's installed job(s) with this `templateId` (same server-side agent resolution as install); 404 when that agent has none. For message-delivering routines, `removeJob` archives the routine's conversation with the job — it leaves the Messages list, its history stays addressable by id. |

### Delivery: visible routines own conversations when they produce chat output

An installed routine that produces chat-visible output uses its own
**dedicated channel session titled after the routine** ("Morning Briefing"
in the Messages list), never a forward into the main agent Chat — the
templates set no `forwardToChat`, and each fire's final answer lands in the
routine's conversation through the ordinary jobs delivery path
(`dispatchPromptRun` / `finalizeJobRunFromTask`). Both writers provision it
through the shared `createRoutineJob` helper when the template sets
`createsMessagesConversation: true`:

- a **fresh install** passes `createDedicatedSession: { title }` (the
  `create_job` tool's idiom), so `createScheduledJob` mints the channel
  inside the same write as the job;
- a **reinstall** (the detail page's Settings save, or an onboarding
  re-apply over a gallery install) captures the replaced job's live channel
  before the replace pass, un-archives it (`removeJob` archived it with the
  old job) and binds the new job to it via `chatSessionId` — settings edits
  never churn the conversation or its history.

Auto-inbox is the exception: it sets `createsMessagesConversation: false`,
so installing it creates a scheduled job with an internal headless working
channel, not a visible Messages conversation. The hidden channel gives the
Auto-inbox run a parent container so it can call `spawn_task` for
draft-worthy emails; those child tasks set `surface:true` and appear on Home
for review. Labeling and archiving stay inside the Auto-inbox run and need no
user-facing delivery.

`GET /api/routines/templates` exposes the session as
`installed.chatSessionId` only for visible delivery conversations (absent
for Auto-inbox and on installs predating provisioning), which the detail
page's Open messages action deep-links as `/chat?session=<id>`. Home's Chats
section lists live job delivery channels
(`kind:"channel"` + `origin:"job"`, not headless, no feature owner like
email-watch) alongside the user's own conversations, so an installed
message-delivering routine's conversation is visible without a deep link.

Installed jobs link back to their template through an optional
`JobRecord.templateId`, stamped by `buildSpec` on both the gallery and
onboarding paths and threaded through `createScheduledJob` like any other
create-payload field. Templates with settings also stamp the resolved
settings state as `JobRecord.templateSettings` (defaults merged with the
caller's overrides, validated by `resolveSettings`) so the detail page's
Settings view can render the installed configuration. The pre-settings
`JobRecord.templateOptions` boolean map is no longer stamped but stays
readable: each template's optional `legacySettings` hook maps it onto the
settings model (Auto-inbox translates the retired `archiveUnimportant`
boolean into per-label auto-archive on the unimportant default labels), and
`POST /api/onboarding/routines` — whose flat-boolean body contract is
unchanged — routes through the same mapping before `buildSpec`. All these
fields are optional, so no state migration; ordinary jobs never carry them.
A selection that yields no behavior (an Auto-inbox with every function off)
builds no spec — the onboarding path skips it, the install endpoint rejects
it with a 400.

The web gallery (`packages/web/src/app/routines/page.tsx`, linked from the
sidebar) renders a card per template — icon, name, description — with a
one-click Add that installs the catalog defaults, split into My routines
(installed) and Explore (catalog) views off the GET's `installed` join. An
installed card opens the detail page
(`packages/web/src/app/routines/[templateId]/page.tsx`): pause/resume and
Run Now proxy the job endpoints (`POST /api/jobs/<id>/{pause,resume,run}`),
Open messages deep-links the routine's conversation when one exists,
Recent sessions lists the job's run history, Settings renders the template's
settings sections (toggle rows, text fields, and the filtering-label editor
— per-label name/rule/auto-archive edits, add and remove) and saves by
re-installing with the full settings state (the idempotent per-template
replace — the jobId changes; the page owns the switcher selection so it
survives that remount), and Delete routine uninstalls. On per-account
templates an account-switcher pill row scopes the sections to one connected
account (edits accumulate across accounts; Save posts the full email-keyed
map), and seeded labels carry their read-only Existing/Suggested badge. Errors surface
as toasts;
the install endpoint's skill-resolve 400 is the connector-readiness signal
(no pre-flight on the card).

### Personalized suggestions start as setup tasks

The onboarding Gmail scan also persists a small `suggestedRoutines` list of
evidence-backed recurring automations. My routines renders those separately
from the fixed catalog in a horizontal Suggestions rail; a ready scan with no
suggestions (including records written before this field existed) simply omits
the rail. The fixed starter catalog remains in Explore and is never presented
as personalized advice.

A suggestion's **Add** button does not silently install a guessed schedule.
It starts a surfaced Home task through `POST /api/containers`, gives the
container a compact `Create a routine: …` title, and opens that task in the
Home side panel. The task brief requires the agent to collect the cadence and,
when the suggestion uses Gmail, the connected email account(s) through the
existing `ask_user` choice-card flow before calling `create_job`. The resulting
job is therefore an ordinary custom scheduled routine and appears in My
routines through the existing custom-job partition; no suggestion-only job or
installer state is added.

### My routines is the agent's full routine surface

My routines lists every routine the effective agent owns, partitioned into
three card kinds:

- **catalog installs** — template cards keyed on `templateId` (above);
- **email watchers** — cards over `GET /api/email/watchers`, with a detail
  page at `/routines/watch/[watcherId]` (see ADR email-watch.md);
- **custom scheduled jobs** — every other job from the agent-scoped
  `GET /api/jobs?agentId=` (chat-created via `create_job`): a generic card
  (humanized job name, first prompt line, Paused state, Open channel /
  Remove) with a detail page at `/routines/job/[jobId]` — Recent sessions
  and Info tabs, pause/resume, Run Now, Edit schedule (the shared
  `EditJobDialog`: interval/cron/timezone plus retry, timeout, budget, and
  delivery targets), Delete; no Settings tab (prompt editing stays in chat).

The routines page — its `PageHeader` action and the "No routines yet" empty
state — offers a **Create routine** entry point that seeds the Home composer
in Task mode with `Create a routine that …` (`/?compose=task&prompt=`,
consumed by `HomeComposer`). A custom routine therefore starts as an ordinary
Home task the agent fulfills with `create_job`; there is deliberately no
dedicated create form — authoring stays conversational, the same path email
watchers and other chat-created jobs already take.

The one exclusion from the custom partition besides `templateId` is the
shared email-watch detection job, identified **structurally** — a
`skill-script` pre-run hook routed at the `gmail-watch` skill, the same
marker the runtime provisions and finds it by (`findSharedJobId` in
`src/state/email-watchers.ts`) — never by name. That job is infrastructure;
its watchers are the routines. Partition helpers live in
`packages/web/src/app/routines/custom-jobs.ts`.

`/routines` is the **sole scheduled-jobs surface**. The standalone `/jobs`
page is gone; the route survives only as a stale-link redirect (`/jobs?job=<id>`
→ `/routines/job/<id>`, bare `/jobs` → `/routines`), and
`/routines/job/[jobId]` is the canonical per-job URL for *any* job id — a
job carrying a `templateId` forwards to `/routines/<templateId>`. The pieces
the old page shared with the chat surface's per-agent Jobs tab (the schedule
label, the calendar views, `EditJobDialog`) live in
`packages/web/src/components/jobs/`.

## Consequences

- Installed routines are ordinary `active` jobs: the user can pause, edit,
  or delete them in /routines, and the job scheduler/channel provisioning
  are inherited unchanged from `createScheduledJob`.
- Because install is a per-template replace keyed on `templateId` and the
  owning agent (like the delete), re-installing with different settings never
  duplicates a routine — but it re-creates the job, so run history on the
  replaced job is dropped with it (message-delivering routines' conversation
  and message history survive the replace). Each agent can hold its own
  install of the same template; one agent's install/remove never touches
  another's.
- A gallery install or Remove leaves a stale id in the onboarding record's
  `routineJobIds`. The onboarding replace pass ignores ids that no longer
  exist AND additionally deletes the owning agent's live jobs carrying a
  catalog `templateId`, so "at most one live job per template per agent"
  holds no matter which writer (gallery or onboarding) ran last.
- The gallery reflects onboarding-created installs (same `templateId`
  stamp), so a user who enabled routines during onboarding sees them as
  installed on /routines.
- Personalized suggestions are inert until the user clicks Add and completes
  the task's setup choices; model-generated scan text alone never creates a
  job or selects an account on the user's behalf.

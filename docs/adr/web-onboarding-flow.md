# ADR: Web Onboarding Flow

- **Status:** Accepted
- **Date:** 2026-07-02
- **See also:** [Multiple Tagged Google Accounts](./google-multi-account.md), [Chat Topics, Tasks, Subagents](./chat-topics-tasks-subagents.md), [Job Skill Attachments](./job-skill-attachments.md), [Managed Deployment Mode](./managed-deployment-mode.md)

## Decision

Give the web app a first-run `/onboarding` flow backed by four runtime
endpoints and a small per-instance record. The runtime owns everything
durable and product-defining: the onboarding record, the Gmail profile scan
(including its prompt), and the starter-routine job specs. The browser is a
renderer over the `/api/onboarding` contract — it never composes prompts or
cron expressions.

The funnel opens with **prerequisite steps** ahead of the five dotted wizard
steps (which are the same for every deployment): always a **sign-in step**,
and — on a self-hosted deployment with no model provider configured — a
**capability-derived provider step** (see "Capability-derived steps and the
skip paths" below). Prerequisite steps carry no progress dots. Google access
is the app's top-level prerequisite, so an incomplete funnel always shows
sign-in first. The step adapts to the account registry
(`GET /api/google/accounts`, polled while the
step is up): with a signed-in account it offers "Continue as \<primary
email\>", otherwise "Continue with Google" starts the connect flow and the
button swaps once the account registers. The step's OAuth buttons ("Continue
with Google", "Use a different account", and the reconnect-revoked-primary
relogin) carry **signin intent**: completing that OAuth makes the account the
registry's persisted primary, so the card flips to "Continue as \<the account
just authorized\>" with no further action. The accounts step's "Add account"
keeps the default **add intent** and never touches the primary — the web
reads the primary from the server-resolved `primary: true` row of
`GET /api/google/accounts` (heuristic fallback only when the flag is absent).
See ADR google-multi-account.md, "The primary account and OAuth intents". The client-side OnboardingGate is
render-blocking: authenticated content stays hidden until the record resolves
(and while a redirect is in flight), so an incomplete user never flashes the
home chrome before landing on `/onboarding`. The gate has two exemptions,
never blanked or redirected: an explicit `/chat?session=…` deep link — a user
following a direct link to a specific conversation asked for that exact
surface — and `/setup`, the standing provider-setup page for a **completed**
instance whose provider is missing (the proxy's setup gate still bounces that
state there; an incomplete funnel instead passes through the proxy and gets
the wizard's own provider step — see below).

## Auth-mode switch and step re-entry

How "connect a Google account" works depends on the deployment, so the
sign-in step's connect buttons and the accounts step's "Add account" switch
on `GET /api/google/auth-mode` (ADR google-multi-account.md). Both modes are
the same **same-tab OAuth round trip** — the tab leaves for Google's consent
screen and returns to `returnTo`, with `?googleAddError=1` appended on
failure (toasted once at the /onboarding page level):

- **`loopback`** (local/desktop): the browser navigates to
  `/api/runtime/google/login/start?returnTo=…&origin=…` — the BFF injects the
  gateway bearer and the gateway runs a Desktop-client PKCE
  authorization-code flow whose redirect URI is the web app's own loopback
  origin (`<origin>/api/runtime/google/login/callback`), so Google sends the
  tab straight back into the app; the gateway's callback exchanges the code,
  writes the gws credential, and registers the account (idempotent by Google
  sub) before 302ing to `returnTo`. The gateway only ever sees the BFF's
  loopback hop, so the page passes its own origin along; a non-loopback
  origin gets a clear 400 (Google Desktop clients can only redirect to
  localhost/127.0.0.1, so LAN access can't complete this flow). See ADR
  google-multi-account.md ("Web login" under the login path).
- **`edge`** (hosted): the guest is headless, so the browser navigates
  same-tab to the edge's `/auth/google/add?returnTo=…` — a web-application
  OAuth round trip whose code exchange and provisioning
  (`POST /api/google/accounts/provision`) happen server-side on the edge.
  The reconnect-revoked-primary relogin uses this SAME add flow with
  `intent=signin` — not the owner sign-in flow `/auth/google`, which heals
  only the baked credential dir and could never heal a primary that was
  flipped to another account. The add flow identity-matches whichever account
  the user re-authorizes, and when that account is the session owner's own
  (matched by Google sub), the edge upgrades the provision to a baked-dir
  heal server-side — see ADR google-multi-account.md.

`returnTo` is `/onboarding?step=accounts` from the accounts step and plain
`/onboarding` from the sign-in step (the fresh account should surface as
"Continue as …", not skip the funnel). While the auth mode is still loading,
the buttons stay disabled so a click can never fall through to the wrong
flow.

The same-tab round trip means the wizard fully remounts on return, so
`/onboarding?step=…` names the step to resume: a pure param→step mapping
(`initialOnboardingStep`, `_components/lib.ts`) seeds the wizard's initial
state — today only `accounts` is a valid name; anything else starts at
sign-in. The param only matters for an incomplete record (the gate redirects
a completed user off `/onboarding` regardless). A failed add round trip comes
back with `?googleAddError=1`, surfaced as a one-shot error toast at the page
level (it can land on either returnTo).

## Capability-derived steps and the skip paths

The wizard derives its step sequence from deployment capabilities instead of
persisting step state in the onboarding record. Steps are held by **name**
(`onboardingSteps` / `OnboardingStep` in `_components/lib.ts`): the provider
step can join the sequence after mount (the capability probe resolves
async), so a numeric position could silently re-label the step the user is
on. Sign-in and the provider step sit before `welcome` in the sequence, which
is also how the page renders them dotless — the five product dots are stable
for every deployment.

- **Provider step** (`StepProvider`): shown only when `GET /api/setup/status`
  answers a definite "self-hosted and no provider configured"
  (`needsProviderStep`: `managed: false` AND `providerConfigured: false`; an
  unresolved or failed probe never blocks the funnel on a guess). It renders
  the shared `ProviderPicker` — the exact surface `/setup` renders — inside
  the wizard frame, so the catalog, per-provider config forms, and
  `POST /api/setup/provider` are all inherited. It sits between sign-in and
  the wizard proper because the Gmail profile scan needs the model. A save
  advances, invalidates the cached probe, and kicks the scan; "Skip for now"
  (rendered by the step itself, so it survives a loading or failed catalog)
  advances without one. Managed deployments never see the step — the platform
  provisions the provider (ADR managed-deployment-mode.md).
- **Scan gating:** the same `needsProviderStep` predicate gates the scan
  kickoff — the scan's synthesis calls need the model, so without a provider
  it could only fail. When the provider step is shown, sign-in's continue
  defers the kick to the provider step's save; if the user skips instead, the
  scan is never submitted and the profile step renders a **connect-a-model
  state** (no eternal spinner, no "Try again" that can only fail; Continue
  stays available) and the tasks step falls back to its static suggestions.
- **Sign-in skip:** the sign-in step carries a quiet "Skip for now" that
  completes onboarding minimally — `PATCH /api/onboarding` with
  `completed: true` plus the browser-resolved timezone (theme keeps the app
  default) — so a user without a Google account still reaches the app and can
  connect one later via settings or skills. The page withholds the skip when
  managed (the edge's Google sign-in IS the session, so the managed funnel is
  unchanged). Skipping sign-in skips the whole funnel, provider step
  included; a provider-less instance then falls under the `/setup` bounce
  below, the standing surface for that state.
- **Proxy interplay** (`packages/web/src/proxy.ts`): the setup gate's
  "unconfigured self-hosted → 307 `/setup`" bounce yields to an incomplete
  funnel. When the status probe reports unconfigured+unmanaged, the proxy
  probes `GET /api/onboarding`; only an explicit `completed: false` passes
  the request through (OnboardingGate then routes it to `/onboarding`, whose
  provider step replaces the `/setup` detour). Completed, an unexpected
  payload, or a failed probe all keep the bounce — and the GET's server-side
  grandfathering means a used instance answers `completed: true`, so existing
  installs never see the funnel.

- **Persistence:** `~/.gini/instances/<instance>/onboarding.json`
  (`packages/runtime/src/state/onboarding.ts`) — deliberately NOT part of
  `state.json`. Atomic temp+rename writes; the read never throws
  (missing/corrupt degrades to "no record").
- **Orchestration:** bounded module `packages/runtime/src/runtime/onboarding.ts`;
  `src/http.ts` handlers are thin delegations, mirroring `runtime/setup-api.ts`.
- **Types:** `OnboardingRecord` / `OnboardingScan` / `OnboardingProfile` /
  `OnboardingProfileSection` / `OnboardingScanStatus` in
  `packages/runtime/src/types.ts`, imported by the web via `@runtime/types`.

## Contract

- `GET /api/onboarding` → `OnboardingRecord`. Two lazy side effects:
  grandfathering (below) and a staleness guard that reclaims a running scan
  orphaned by a runtime restart.
- `PATCH /api/onboarding` body `{ timezone?, theme?, completed? }` → updated
  record. Timezone is probe-validated by constructing an
  `Intl.DateTimeFormat` with it (croner resolves `cronTimezone` through Intl
  too, so a zone that passes the probe can never fail job creation later —
  and unlike a `supportedValuesOf` membership check, the probe accepts the
  canonical zones browsers report, e.g. `Asia/Kolkata`); theme must be
  `"light" | "dark"`; `completed: true` stamps `completedAt` once. Violations
  throw `Invalid input: …` → 400.
- `POST /api/onboarding/scan` → `OnboardingRecord`. Starts the deterministic
  Gmail profile scan in the background and returns the `running` record
  immediately; idempotent while a scan is `running` or `ready`. With no
  detectable Google access — empty account registry (ADR
  google-multi-account.md), no `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE` (the
  hosted-provisioning credential), no default
  `~/.config/gws` dir — the scan lands in `no_account` without running the
  pipeline. `idle`/`failed`/`no_account` (re)submit, so a retry after
  connecting an account just works.
- `POST /api/onboarding/routines` body
  `{ timezone?, autoInbox?, morningBriefing?, meetingBriefing? }` →
  `{ record, jobs }`. Timezone falls back to the record's, then `"UTC"`.

## Grandfathering

Onboarding must never funnel an existing user into a first-run flow. On the
FIRST `GET /api/onboarding` (no record file), the runtime consults instance
state: any chat session or any task ⇒ the instance predates onboarding, and a
`completed: true` record is persisted immediately. A genuinely fresh instance
gets the default record WITHOUT persisting it — the first PATCH/scan write
creates the file, so grandfathering keeps re-evaluating until the instance is
used either way.

## Scan mechanism

The profile scan is a **deterministic in-runtime pipeline**
(`packages/runtime/src/runtime/onboarding-scan.ts`), not an agent task — the
reliability win is removing the multi-turn tool-calling loop while keeping the
model only where it authors prose:

1. **Fetch** — `gws` is the ONLY credential holder but not the data path. The
   pipeline spawns `gws auth export --unmasked` once (injectable `gwsSpawn`,
   mirroring the gmail-watch detection script), mints a short-lived access
   token from the exported refresh credentials (`oauth2.googleapis.com/token`),
   and reads the mailbox over direct Gmail HTTP (`gmail.googleapis.com`,
   injectable `fetchImpl`): resolve the self email (`profile`), list ~7 days of
   inbox (capped at ~50 messages, full bodies for the most-recent handful) plus
   a sent sample (metadata only — sent mail evidences voice, not content), with
   the per-message gets running in parallel at a fixed concurrency of 8 — a gws
   subprocess costs ~0.45s of process startup per call, so one shared token
   over HTTPS reads the same window in a fraction of the time. Export+mint IS
   the auth gate: a missing/garbled export or a refused mint fails the scan
   with the no-signed-in-session error. The exported credentials and minted
   token live in scan-local variables only — never logged, never persisted,
   never interpolated into events or error text (Gmail/token faults map to
   short generic messages). A single message get failing drops just that
   message; profile/list/token faults fail the scan. The account's gws config
   dir is resolved from the Google-accounts registry (the persisted primary,
   else first provisioned, else first row; `~/.config/gws` / the hosted baked
   credential when there is no registered account), the same account the
   scheduled google jobs target.
2. **Synthesize** — TWO parallel `generateStructured` calls turn the fetched
   bundle into `{ profile: { displayName, sections[] } }` and
   `{ suggestedTasks[] }`; generation is output-token-bound, so splitting the
   deliverables roughly halves synthesis wall clock. The content rules are
   server-owned and carried verbatim, split by deliverable (person-centric
   durable-fact sections in a fixed order, forbidden transactional content, and
   the displayName legal-name form on the profile call; the suggestedTasks
   shapes/ranking on the tasks call); both calls read the SAME rendered mailbox
   (as untrusted quoted evidence — the tasks call needs who-wrote-last
   evidence, the profile call needs sent mail for voice). Outputs are
   shape-checked and clamped by `validateScanProfile` / `validateScanTasks`
   before they land. The profile call is load-bearing: its failure fails the
   scan. A failed tasks call degrades to a `ready` scan with no
   `suggestedTasks` — the web's tasks step then falls back to its static
   suggestions.

The runtime must own the model call regardless: skill scripts receive only
Google OAuth connector secrets, never model API keys — so keeping the fetch in
runtime too (rather than a new skill) is the natural fit.

The web kicks the scan off the moment its two prerequisites hold — Google
access confirmed at the **sign-in step's continue action**, and a provider to
synthesize with (when the capability-derived provider step is shown, the kick
moves to that step's save; a skipped provider step means no kick at all — see
"Capability-derived steps and the skip paths") — not on page mount (a
mount-time kick fired spurious runs on every visit, including the brief mount
a completed user gets before the gate redirects). The same mutation backs the
profile step's "Try again" after a failure: `POST /api/onboarding/scan` resubmits a `failed` scan
(clearing the previous error) while staying idempotent for `running`/`ready`
and refusing entirely on a completed record. Should the scan still be running
when the user reaches the tasks step, that step shows a hint and adopts the
scan's suggestions when they arrive — unless the user has already edited the
list, in which case their state wins.

`POST /api/onboarding/scan` flips the record to `running` and returns
immediately; the pipeline runs in the **background** (fire-and-forget) and,
when it settles, writes the terminal record (`ready` with the profile, or
`failed` with an error — the pipeline never throws to the caller) and **pushes
an `onboarding` event** (`kind: "onboarding"`, `action: "onboarding.scan"`)
over the events stream. The browser's `RuntimeStreamBridge` maps that event to
the `["onboarding"]` query key, so the running scan reveals its profile within
~50ms of finishing — no `GET /api/onboarding` poll. A `running` scan whose
background pipeline was orphaned by a runtime restart is reclaimed by the GET
staleness guard (a running scan older than ~5 min flips to `failed`, so "Try
again" resubmits). The web treats `failed`/`no_account` as a friendly fallback,
never a blocker. The profile step holds its Continue action (shown disabled)
while the scan is still `running` — so the user waits for the distilled profile
instead of advancing past a half-built one — and re-enables it the moment the
scan turns `ready` or drops to that fallback, so a slow or failed scan still
never traps the user on the step.

## Routines mapping

`POST /api/onboarding/routines` is an **idempotent replace**: delete the jobs
in `record.routineJobIds` (ids that no longer exist are ignored), then create
one job per enabled routine via the jobs module's `createScheduledJob` — the
exact call `POST /api/jobs` makes, so validation, scheduling, and channel
provisioning are inherited, and the jobs are ordinary `active` records the
user can edit or remove in /jobs afterwards. The new ids land back in
`routineJobIds`.

| Routine | Cron (record tz) | Skills | Delivery |
| --- | --- | --- | --- |
| Auto-inbox | `*/30 * * * *` | `google-gmail` (+ `google-calendar` when scheduling assist is on) | own Topic |
| Morning Briefing | `0 8 * * *` | `google-gmail`, `google-calendar` | Topic + `forwardToChat` |
| Meeting Briefing | `*/15 * * * *` | `google-calendar`, `google-gmail` | Topic + `forwardToChat` |

The Auto-inbox prompt is composed ONLY of the sub-toggles the user enabled
(label new mail / archive unimportant / scheduling assist / draft replies)
and always states that Gini never sends email without the user's review; an
enabled Auto-inbox with zero sub-toggles creates no job. The briefings set
`forwardToChat` so each fire also surfaces in the agent's Chat (ADR
chat-topics-tasks-subagents.md).

## Consequences

- The onboarding gate costs one small file read per `GET /api/onboarding`;
  nothing is added to the `state.json` hot path.
- Task seeding (the flow's final step) reuses `POST /api/containers` with
  `startedAs: "task"` — no onboarding-specific endpoint. Each seeded task is
  a task container that surfaces on the task-first home (ADR
  task-containers-and-runs.md).
- The scan's quality is bounded by the model + the mailbox evidence; the
  contract only guarantees the transport (deterministic Gmail HTTP fetch in,
  two parallel structured synthesis calls, shape-checked + clamped out).

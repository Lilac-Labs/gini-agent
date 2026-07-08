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
`icon` key, `scheduleHint`, sub-`options` with defaults) and a `buildSpec`
that composes the `createScheduledJob` payload (prompt, cron, skills)
server-side. Prompts and cron expressions are product-owned in the catalog
and never composed in the browser — the client only sends toggle state.
Adding a template is one catalog entry.

Two callers share the catalog:

- the **onboarding starter-routines step** — `routineJobSpecs` in
  `src/runtime/onboarding.ts` maps its `POST /api/onboarding/routines` body
  onto the same `buildSpec` calls (the endpoint's contract is unchanged; see
  ADR web-onboarding-flow.md)
- the **gallery endpoints**, thin `src/http.ts` delegations into the module:

| Endpoint | Behavior |
| --- | --- |
| `GET /api/routines/templates` | The catalog joined with installed state — the live job carrying each `templateId`, scoped by `?agentId=` like `GET /api/jobs`. `installed.options` carries the job's persisted `templateOptions` (absent on templates without options and on jobs predating the field). |
| `POST /api/routines/templates/<id>/install` | Body `{ timezone?, options? }`. Missing option keys fall back to the template defaults; timezone precedence is payload > onboarding record > UTC. Idempotent per-template replace scoped to the active agent: skills are pre-validated (`assertSkillNamesResolve`, a clean 400 with zero side effects), then the owning agent's job with this `templateId` is deleted and one fresh job created via `createScheduledJob` — the same call `POST /api/jobs` makes. The owning agent is resolved server-side (never caller-supplied), the same way `createScheduledJob` stamps `agentId`. Returns the `JobRecord`. |
| `DELETE /api/routines/templates/<id>` | Removes the active agent's installed job(s) with this `templateId` (same server-side agent resolution as install); 404 when that agent has none. `removeJob` archives the routine's conversation with the job — it leaves the Messages list, its history stays addressable by id. |

### Delivery: every routine owns a conversation

An installed routine's delivery surface is its own **dedicated channel
session titled after the routine** ("Morning Briefing" in the Messages
list), never a forward into the main agent Chat — the templates set no
`forwardToChat`, and each fire's final answer lands in the routine's
conversation through the ordinary jobs delivery path
(`dispatchPromptRun` / `finalizeJobRunFromTask`). Both writers provision it
through the shared `createRoutineJob` helper:

- a **fresh install** passes `createDedicatedSession: { title }` (the
  `create_job` tool's idiom), so `createScheduledJob` mints the channel
  inside the same write as the job;
- a **reinstall** (the detail page's Settings save, or an onboarding
  re-apply over a gallery install) captures the replaced job's live channel
  before the replace pass, un-archives it (`removeJob` archived it with the
  old job) and binds the new job to it via `chatSessionId` — option edits
  never churn the conversation or its history.

`GET /api/routines/templates` exposes the session as
`installed.chatSessionId` (absent only on installs predating provisioning),
which the detail page's Open messages action deep-links as
`/chat?session=<id>`. The web sidebar's Messages section lists live job
delivery channels (`kind:"channel"` + `origin:"job"`, not headless, no
feature owner like email-watch) alongside the user's own conversations, so
an installed routine's conversation is visible without a deep link.

Installed jobs link back to their template through an optional
`JobRecord.templateId`, stamped by `buildSpec` on both the gallery and
onboarding paths and threaded through `createScheduledJob` like any other
create-payload field. Templates with options also stamp the resolved option
state as `JobRecord.templateOptions` (defaults merged with the caller's
overrides) so the detail page's Settings view can render the installed
selection. Both fields are optional, so no state migration; ordinary jobs
never carry them. A selection that yields no behavior (an Auto-inbox with
every sub-option off) builds no spec — the onboarding path skips it, the
install endpoint rejects it with a 400.

The web gallery (`packages/web/src/app/routines/page.tsx`, linked from the
sidebar) renders a card per template — icon, name, description — with a
one-click Add that installs the catalog defaults, split into My routines
(installed) and Explore (catalog) views off the GET's `installed` join. An
installed card opens the detail page
(`packages/web/src/app/routines/[templateId]/page.tsx`): pause/resume and
Run Now proxy the job endpoints (`POST /api/jobs/<id>/{pause,resume,run}`),
Open messages deep-links the routine's conversation,
Recent sessions lists the job's run history, Settings edits the template
options and saves by re-installing (the idempotent per-template replace —
the jobId changes), and Delete routine uninstalls. Errors surface as toasts;
the install endpoint's skill-resolve 400 is the connector-readiness signal
(no pre-flight on the card).

## Consequences

- Installed routines are ordinary `active` jobs: the user can pause, edit,
  or delete them in /jobs, and the job scheduler/channel provisioning are
  inherited unchanged from `createScheduledJob`.
- Because install is a per-template replace keyed on `templateId` and the
  owning agent (like the delete), re-installing with different options never
  duplicates a routine — but it re-creates the job, so run history on the
  replaced job is dropped with it (the routine's conversation and its
  message history survive the replace). Each agent can hold its own install
  of the same template; one agent's install/remove never touches another's.
- A gallery install or Remove leaves a stale id in the onboarding record's
  `routineJobIds`. The onboarding replace pass ignores ids that no longer
  exist AND additionally deletes the owning agent's live jobs carrying a
  catalog `templateId`, so "at most one live job per template per agent"
  holds no matter which writer (gallery or onboarding) ran last.
- The gallery reflects onboarding-created installs (same `templateId`
  stamp), so a user who enabled routines during onboarding sees them as
  installed on /routines.

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
| `GET /api/routines/templates` | The catalog joined with installed state — the live job carrying each `templateId`, scoped by `?agentId=` like `GET /api/jobs`. |
| `POST /api/routines/templates/<id>/install` | Body `{ timezone?, options? }`. Missing option keys fall back to the template defaults; timezone precedence is payload > onboarding record > UTC. Idempotent per-template replace: skills are pre-validated (`assertSkillNamesResolve`, a clean 400 with zero side effects), then any job with this `templateId` is deleted and one fresh job created via `createScheduledJob` — the same call `POST /api/jobs` makes. Returns the `JobRecord`. |
| `DELETE /api/routines/templates/<id>` | Removes the installed job(s) with this `templateId`; 404 when none. |

Installed jobs link back to their template through an optional
`JobRecord.templateId`, stamped by `buildSpec` on both the gallery and
onboarding paths and threaded through `createScheduledJob` like any other
create-payload field. The field is optional, so no state migration; ordinary
jobs never carry it. A selection that yields no behavior (an Auto-inbox with
every sub-option off) builds no spec — the onboarding path skips it, the
install endpoint rejects it with a 400.

The web page (`packages/web/src/app/routines/page.tsx`, linked from the
sidebar) renders a card per template — icon, name, description, sub-option
checkboxes that drive the install payload, schedule hint — and flips to an
installed state (badge, link to the job in /jobs, Remove) off the GET's
`installed` join. Errors surface as toasts; the install endpoint's
skill-resolve 400 is the connector-readiness signal (no pre-flight on the
card).

## Consequences

- Installed routines are ordinary `active` jobs: the user can pause, edit,
  or delete them in /jobs, and the job scheduler/channel provisioning are
  inherited unchanged from `createScheduledJob`.
- Because install is a per-template replace keyed on `templateId`
  (instance-wide, like the delete), re-installing with different options
  never duplicates a routine — but it re-creates the job, so run history on
  the replaced job is dropped with it.
- A gallery Remove leaves a stale id in the onboarding record's
  `routineJobIds`; the onboarding replace pass already ignores ids that no
  longer exist.
- The gallery reflects onboarding-created installs (same `templateId`
  stamp), so a user who enabled routines during onboarding sees them as
  installed on /routines.

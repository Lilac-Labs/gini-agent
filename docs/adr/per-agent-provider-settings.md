# ADR: Per-Agent Provider Settings (Editable Override + Agent Model Card)

- **Status:** Accepted
- **Date:** 2026-06-09
- **See also:** [Agents Replace Profiles And Drive Runtime Behavior](./agents-replace-profiles.md), [Per-Agent Memory Isolation](./agent-memory-isolation.md)

## Decision

Make provider/model selection a per-agent operation. Each agent already
carries an optional `providerName` + `model` override that
`resolveEffectiveContext` resolves into the effective provider for inference
and memory LLM calls (see ADR agents-replace-profiles.md). That override could
only be set at agent creation. This ADR adds:

1. A mutation to **edit an existing agent's** provider/model — capability
   `setAgentProvider(config, idOrName, { providerName, model })` exposed at
   `POST /api/agents/:id/provider`.
2. An **"Agent model" card** on the Settings page, adjacent to the "Default
   model" control, where the user selects the provider/model for the active
   agent. (Originally shipped as a Settings tab in the per-agent chat view —
   see the 2026-07-07 amendment below.)

The instance-level provider remains the bootstrap seed and the fallback an
agent inherits when it carries no override (`providerSource: "instance"`).

## Context

Provider selection lived only on the global Settings page, which writes the
instance-level `RuntimeConfig.provider`. The agent record was the documented
control surface for per-agent provider (ADR agents-replace-profiles.md), but
the only way to populate it was the create-agent path — there was no edit
surface, and no UI affordance on the agent view itself. The product direction
is per-agent personas with real provider preferences (a "coding" agent on one
provider, a "research" agent on another), so the active agent needed a
first-class place to pick a provider/model.

## Credentials Stay Instance-Level

Provider **credentials** are machine-global: API keys and the AWS access key +
secret live in `~/.gini/secrets.env` and `process.env`, and Codex OAuth in
`~/.codex/auth.json`. They are not per-agent, and the instance-level
`POST /api/setup/provider` flow that writes them (plus the launchd plist
refresh it triggers) is unchanged. The Agent model card therefore only
**selects among already-configured providers** — it never accepts or stores a
key. This keeps a single source of truth for secrets and avoids duplicating the
heavy secret-write/plist-refresh machinery per agent.

Consequences of this split:

- The Agent model card offers only providers reported `configured` by
  `providerCatalogWithStatus` — a turn through an unconfigured provider falls
  back transiently to a configured one ([Transient Provider Fallback](./provider-fallback.md))
  rather than running the chosen provider, so the card still offers only
  configured rows.
- Because `resolveEffectiveContext` inherits the instance's transport config
  (baseUrl, apiKeyEnv, Azure routing, extraBody) only when the agent routes to
  the **same** provider name as the instance, a cross-provider agent takes
  `normalizeProvider`'s per-provider defaults. Azure is configured-gated to the
  active instance provider (it has no default endpoint), so the card
  naturally won't offer a broken cross-provider Azure override.

## Contract

`POST /api/agents/:id/provider`

- Body `{ providerName, model }` — **both** required to set an override. The
  provider name is validated against `providerCatalog()`; an unknown name is
  rejected. A lone `providerName` or lone `model` is rejected. These map to
  `400` via the `Invalid input:` prefix in `statusFromErrorMessage`.
- Body with both blank/omitted — **clears** the override; the agent reverts to
  the instance default (`providerSource` flips back to `"instance"`).
- Unknown agent id/name → `404` via the `Agent not found:` prefix.
- A no-op (the agent already carries the requested selection) skips the state
  write, the audit row, and the `updatedAt` bump — same hygiene as
  `renameAgent`.
- Success returns the updated `AgentRecord` and writes an `agent.provider_set`
  audit event with `{ from, to, agentId }`.

The "both required for an override" rule is the same invariant
`resolveEffectiveContext` enforces (a half-configured agent falls through to
the instance config), surfaced at the write boundary so the stored record is
always either a complete override or none.

The API validates the provider **name** only; it does not require the provider
to be `configured`. The configured-only restriction is a UI affordance (the
card filters to configured rows), not an API contract — the endpoint
intentionally allows setting a known-but-unconfigured provider (e.g. to
pre-select one before its credential is added). An override to an unconfigured
provider does not fail the turn: dispatch falls back transiently to a configured
provider and the web surfaces a banner — see
[Transient Provider Fallback](./provider-fallback.md).

## UI

`packages/web/src/app/settings/_components/AgentModelControl.tsx` renders the
"Agent model" card on the Settings page, adjacent to the "Default model"
control and above the provider rows. It sits inside the self-serve provider
section that managed deployments hide (see ADR managed-deployment-mode.md),
so on a managed instance it disappears along with the rest of the provider
surfaces.

The card reads the active agent's current effective provider from
`/api/status.activeAgent` (`resolvedProvider` + `providerSource`). Selection is
model-first (see ADR model-first-selection.md): the shared `ModelPicker` lists
canonical models with the configured routes that serve them, picking a model
saves the route pair through the contract above immediately, and a "Use default
model" action copies the current default pair onto the agent as a new pin. The
picker surfaces the agent's currently-saved pair even when it is off-catalog
(e.g. a custom Bedrock inference-profile id); entering a brand-new custom model
id is not done here — that lives in the provider Edit dialog below the card,
keeping this card a focused per-agent selector rather than a second
provider-configuration surface.

The card is scoped to the ACTIVE agent: both the mutation target and the
displayed current provider come from `/api/status.activeAgent`, so the read
and the write always refer to the same agent.

## Consequences

- Switching the active agent's provider from the Settings page is now a
  first-class action, not a create-time-only setting.
- Clearing the override on the **default** agent (`agent_default`) is transient:
  `seedDefaultAgentFromConfig` reseeds its `providerName`/`model` from
  `RuntimeConfig.provider` whenever they are missing, so a cleared default agent
  reverts to an explicit override that equals the instance provider. This is by
  design — the default agent mirrors the instance config — and the **effective**
  provider/model is identical either way (only `providerSource` flips from
  "instance" back to "agent"). Clearing a non-default agent's override persists.
- The provider rows on the same page remain the place to add/edit/remove
  provider credentials; the "Default model" control next to the card picks
  the instance default.
- `AgentRecord` and `resolveEffectiveContext` are unchanged — this ADR adds an
  edit surface over the existing model, so no migration is required.

## Acceptance Checks

- `POST /api/agents/:id/provider` with `{ providerName: "openai", model:
  "gpt-4o" }` on the active agent → `/api/status.activeAgent.resolvedProvider`
  reflects openai/gpt-4o and `providerSource === "agent"`.
- The same route with blank fields clears the override →
  `providerSource === "instance"`.
- A lone field or unknown provider → `400`; an unknown agent → `404`.
- The Agent model card appears on the Settings page next to the Default model
  control (self-hosted only — hidden when managed), and selecting a configured
  provider + model persists and drives the next chat turn.
- `bun run typecheck`, `bun run test`, and `bun run gini smoke` are green.

## Critical Files

- `packages/runtime/src/capabilities/agents.ts` — `setAgentProvider` (validation, no-op,
  audit).
- `packages/runtime/src/http.ts` — `POST /api/agents/:id/provider` route.
- `packages/runtime/src/execution/effective-context.ts` — the resolution chokepoint the override
  feeds; it also applies the transient credential fallback
  ([Transient Provider Fallback](./provider-fallback.md)).
- `packages/web/src/app/settings/_components/AgentModelControl.tsx` — the
  per-agent provider/model picker card.
- `packages/web/src/app/settings/page.tsx` — mounts the card inside the
  managed-gated provider section.

## Amendment 2026-06-09: Model-First Picker

The chat Settings tab's provider radio rows + per-provider model dropdown were
replaced by the shared model-first `ModelPicker` (the UI section above
describes the current shape). The `POST /api/agents/:id/provider` contract,
the credentials-stay-instance-level split, and the resolution semantics are
unchanged. The global Settings page's per-provider "active" radio was
likewise replaced by a "Default model" control whose write path updates the
instance provider and the default agent's override together — see ADR
model-first-selection.md.

## Amendment 2026-07-07: Relocated To The Settings Page

The picker originally shipped as a **Settings tab** in the per-agent chat
view (`packages/web/src/components/chat/SettingsTab.tsx`, next to the Jobs
tab, hidden on channels and pinned sessions so the read and write stayed on
the active agent). The home redesign redirects the unpinned `/chat` route —
the tab's only host — so the tab became unreachable. The control moved to
the Settings page as the "Agent model" card described in the UI section
above; the chat tab, its `ChatTabBar` entry, and the `hideSettingsTab`
plumbing were removed. The contract, the active-agent scope, and the
snapshot-not-live-link semantics are unchanged; placement inside the
managed-gated provider section additionally hides the card on managed
deployments (ADR managed-deployment-mode.md), where the provider is
platform-provisioned.

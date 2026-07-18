# ADR: Skills As Packages, Connectors As Credentials

> Renamed from "Skills As Packages, Identities As Credentials" per ADR connector-provider-spec-compliance.md. The decision is unchanged; only the vocabulary updated.
>
> The package/credential split below still holds. The *binding* between them
> moved from provider-keyed to name-based: skills now reference credentials by
> NAME (`metadata.gini.requires.credentials`) and connectors carry an explicit
> `type`. See ADR typed-named-credentials.md for the current model; treat the
> `requires.connectors: [{ provider }]` form referenced here as the legacy
> binding kept for one release.

## Decision

Gini has two top-level user-facing primitives for integrating with the outside world:

- **Skill** — the package. A folder under `skills/` (bundled) or `~/.gini/instances/<inst>/skills/` (user-installed) containing `SKILL.md` (markdown for the agent), optional helper scripts, and Anthropic Agent Skills frontmatter declaring requirements. This is the unit a user thinks of as "the Linear thing my agent can do." Already present in Gini.
- **Connector** — the managed credential record. Stores secrets, scopes, and health for an external account (e.g. Linear API key, Google OAuth tokens) or local permission grant (e.g. macOS TCC for Notes). Renamed from "Identity" per ADR connector-provider-spec-compliance.md.

A skill is **active** if and only if every connector it declares as required exists and is usable (`connectorIsUsable`: configured and healthy, or unknown health when the provider declares no probe — see ADR connector-provider-spec-compliance.md). Activation is automatic; deactivation is automatic when a connector stops being usable. The agent loop never sees inactive skills.

There is no separate "Integration" or layer above either of these. The Skill *is* the package; the Connector *is* the credential plane. This matches the Hermes and OpenClaw conventions for skill-as-package, with Gini's addition being a managed credential plane that those projects punt to environment variables for.

## Context

Earlier framings of this surface used a "Connector" record that conflated three things — auth/identity, tool/execution, and knowledge/instructions — into one undefined record. The actual implementation already separated these concerns: `SkillRecord` is the package (markdown + scripts + declared requirements), `ToolRecord` / `ToolsetRecord` is the execution layer (subprocess, MCP, HTTP), and the credential layer was a stub. The conflation lived only in vocabulary.

Two observations forced clarity:

1. **Hermes and OpenClaw both use "skill" as the user-facing package.** A Hermes Linear skill is `skills/productivity/linear/SKILL.md` plus `scripts/linear_api.py` plus frontmatter declaring `LINEAR_API_KEY` as a required env var. OpenClaw's skill format is the same shape. Both explicitly do not bundle credentials; they declare requirements. Gini's `SkillRecord` already has this shape (`body`, `manifestPath`, `prerequisites.env`, `requiredTools`, `requiredPermissions`, `source: bundled | user`). The convention is well-established and Gini already follows it.
2. **The screenless-Mac model breaks the "punt to env vars" approach.** A user interacting with Gini from a phone or remote web client cannot `export LINEAR_API_KEY=...` on the host. Credentials must be managed by the runtime, not the user's shell. This is the gap Hermes and OpenClaw don't fill and Gini must.

The right shape is: skills stay as packages, Connectors become a first-class managed credential plane, and skills declare which connectors they need. The two records bind by dependency, not by merging.

Cardinality forces this separation. A single Google connector powers Gmail, Calendar, Drive, Docs, and Sheets skills. A single skill ("schedule meeting and send invite") needs multiple connectors (Calendar + Mail). Merging skill and connector into one record would either force per-skill credential duplication or per-record multi-credential bundling. Both are worse than a dependency edge.

## Required Now

### Skill record

- `SkillRecord` gains a `requiredConnectors: { provider: string; scopes?: string[] }[]` field, parsed from `SKILL.md` frontmatter under `metadata.gini.requires.connectors` (Anthropic Agent Skills spec extension namespace).
- Skill loading remains unchanged for bundled and user skills.

### Connector record

- `ConnectorRecord` is the managed credential record; secret storage follows ADR connector-secret-storage.md.
- `RuntimeState.connectors` holds them. No back-compat shim is exposed outside the normalizer.
- HTTP route prefix is `/api/connectors`. The old `/api/identities` prefix has been removed.
- CLI command is `gini connector ...`. The old `gini identity ...` command has been removed.
- Per-provider health probes live in `packages/runtime/src/integrations/connectors/<provider>.ts`. The `demo` provider keeps its no-op behavior; real providers (e.g. `linear`) make remote authenticated calls during health checks.

### Activation by dependency

- When the agent loop lists available skills, it filters out any skill whose `requiredConnectors` are not all satisfied by a usable connector.
- Skill execution paths (subprocess spawn, tool dispatch) re-check at call time as a defensive guard.
- When a skill spawns a subprocess that declares `prerequisites.env`, the runtime resolves those env vars from matching connectors and injects them into the subprocess environment. Plaintext secrets never appear in skill records, state, audit, or trace evidence.
- The Skills UI surface marks dependent skills as "needs setup: \<provider>" when their connectors are missing or unhealthy and exposes inline `[Set up <Label>]` to add the missing connector without leaving the page.

### Approval and audit

- All connector mutations (create, update, rotate, delete, health) emit audit events tied to the connector id, per ADR approval-and-audit-substrate.md.
- Secret values never appear in audit evidence. Audit may include the connector id, the purpose, and a boolean of whether resolution succeeded.
- Risky tool calls that consume connector secrets continue to route through ADR approval-and-audit-substrate.md approvals.

### UI

- Connector setup happens inline on the Skills page next to the rows that depend on a connector. There is no standalone Connectors page; auto-detected connectors with no dependent skill are not surfaced in the UI.
- Each skill row shows its required connectors and whether they are satisfied. Missing connectors expose `[Set up <Label>]`; healthy connectors expose `[Disconnect]`. Disconnect physically removes user-source records and tombstones auto-source records (`status: "disabled"`) so the auto-detection pass won't immediately re-create them.

## Rejected

- Merging Skill and Connector into one record. Breaks N:M cardinality (one connector serves many skills, one skill can need many connectors) and conflates curated bundled content with user-specific runtime data on differing lifecycles.
- An "Integration" wrapper above Skill. Hermes and OpenClaw demonstrate that the skill *is* the integration; an additional layer adds vocabulary without changing semantics.
- Punting credentials to environment variables (Hermes/OpenClaw approach). Incompatible with the screenless-Mac model where the user has no shell access to the host.
- Reintroducing macOS Keychain as a secret backend (see ADR connector-secret-storage.md).

## Deferred

- OAuth flows for providers that require them (e.g. Google). v1 providers use static credentials (API keys, PATs).
- Connector scope-aware approval policy (today scopes are advisory metadata).
- Per-skill UI editor or marketplace.
- Cross-instance connector sharing.

## Consequences For Coding Agents

- Use `ConnectorRecord`, `/api/connectors`, and `gini connector` everywhere. Do not introduce or revive `Identity` naming.
- When adding a provider, place per-provider code under `packages/runtime/src/integrations/connectors/<provider>.ts`. Export a `ProviderModule` (ADR connector-provider-spec-compliance.md) — fields, optional probe, optional detect — and register it in `registry.ts`.
- When adding a skill that needs credentials, declare them in the skill's frontmatter under `metadata.gini.requires.connectors` and reference them in scripts via env vars. Do not read connector records directly from skill code.
- Skill activation filtering is a runtime concern. Do not duplicate the "is this skill active" check at the UI layer; ask the gateway.
- Do not introduce an "Integration" type, table, or route. The skill is the package.

## Acceptance Checks

- `bun run gini connector add --provider demo --name "test"` creates a connector record and emits an audit event.
- `bun run gini connector health <id>` runs the per-provider probe and updates `health`.
- `bun run gini connector remove <id>` deletes the record and any associated encrypted secret files.
- A bundled skill that declares `metadata.gini.requires.connectors: [{ provider: linear }]` does not appear in the agent loop's available-skill list when no healthy `linear` connector exists.
- Adding a healthy `linear` connector makes the same skill appear; deleting or breaking the connector makes it disappear again.
- A subprocess launched by a skill receives the connector's resolved env vars; the skill record contains no plaintext secret.
- `bun run gini smoke` exercises connector CRUD and the activation gate.
- `rg "kind:" packages/runtime/src/integrations/connectors` returns no matches in the new provider registry code.

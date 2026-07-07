# Gini Runtime Implementation Notes

These notes describe the current source layout and boundaries. Product direction lives in [Whitepaper](./whitepaper.md). Runtime behavior is documented in [Gateway And Control Plane](./gateway.md), [Conversation And Runs](./conversation-runs.md), and [Memory](./memory.md).

## Source Layout

The repository is a Bun workspaces monorepo (see ADR bun-workspaces-monorepo.md): the root `package.json` is a private workspace root with a single `bun.lock`, and the runnable surfaces live under `packages/*` — `packages/runtime` (`@gini/runtime`, the gateway), `packages/web` (`@gini/web`, the Next.js control plane), and `packages/mobile` (`@gini/mobile`, the Expo app). Bundled `skills/`, `docs/`, `scripts/`, `vendor/`, and `patches/` stay at the repository root: they are assets and infrastructure the runtime discovers from the workspace root, not packages.

- `packages/runtime/src/types.ts` defines serialized domain contracts and runtime record shapes.
- `packages/runtime/src/paths.ts` owns path selection, instance directory layout, ports, and local filesystem conventions.
- `packages/runtime/src/server.ts` is the Bun process entrypoint and scheduler loop.
- `packages/runtime/src/http.ts` is the authenticated local API router.
- `packages/runtime/src/agent.ts` owns task execution and approval-gated tool actions.
- `packages/runtime/src/provider.ts` owns provider normalization, health checks, and model calls.
- `packages/runtime/src/state/` contains persistence, JSON state store helpers, audit/trace records, IDs, security helpers, SQLite memory storage, and the sandboxed per-agent SQLite database (`agent-data-db.ts`).
- `packages/runtime/src/runtime/` contains install/status, public runtime views, parity/readiness checks, and local harness helpers.
- `packages/runtime/src/execution/` contains chat, runs, and search behavior.
- `packages/runtime/src/memory/` contains retain, recall, reflect, reinforce, embeddings/reranker status, entity, temporal, migration, and schema logic.
- `packages/runtime/src/data/` contains the deterministic tabular (CSV/XLSX) → table importer for the agent database.
- `packages/runtime/src/jobs/` contains scheduler job creation, execution, replay, run history behavior, and the concern fan-out scheduler — a routed pre-run hook result (`buckets`) dispatches one constrained-subagent worker per non-empty bucket into its `JobRecord.routes[routeKey]` (a `JobRoute`), with the cursor committed per-bucket (ADR `job-concern-fanout.md`).
- `packages/runtime/src/hooks/` contains the domain-agnostic pre-run hook primitive: a trusted handler registry, the runner (per-hook timeout, typed result, untrusted-content fence, flat OR routed-`buckets` context rendering), and its barrel. It imports only `packages/runtime/src/types`; the scheduler and any other caller consume it, and handlers self-register from their own domains.
- `packages/runtime/src/governance/` contains approvals-adjacent runtime workflows such as improvements and promotions.
- `packages/runtime/src/capabilities/` contains skills, toolsets, agents, and subagent records.
- `packages/runtime/src/integrations/` contains connectors, MCP, messaging, import inspection, relay, and notification behavior.
- `packages/runtime/src/tools/` contains file, terminal, code, and web tool implementations.
- `packages/runtime/src/cli.ts` is the CLI shim.
- `packages/runtime/src/cli/` contains CLI routing, API helpers, process management, output helpers, and command modules.
- `packages/web/` is the Next.js control plane and BFF proxy.
- `packages/mobile/` is the Expo iOS/Android client.
- `skills/` (repository root) holds the bundled skills the runtime loads from the workspace root; skill scripts stay self-contained (no runtime-source imports).

## Boundary Rules

- API handlers should delegate behavior to bounded runtime modules instead of embedding state mutation logic.
- Runtime behavior modules may use `packages/runtime/src/state/*`, `packages/runtime/src/types.ts`, `packages/runtime/src/paths.ts`, and neighboring behavior modules when needed.
- Storage modules should remain persistence-oriented: load/save, record constructors, migrations, traces, logs, security helpers, and low-level state utilities.
- API responses must not expose bearer tokens, secret hashes, or credential material.
- CLI commands should prefer public runtime APIs when exercising product behavior.
- Direct module calls from CLI are reserved for local harness/process operations such as install, smoke setup, snapshots, and evidence bundles.
- New connector providers, tools, model providers, and client surfaces should land in focused modules before adding router or CLI commands.
- Hermes-parity features should first add durable runtime records and safe inspection flows before adding live external transports.
- MCP, messaging, and import integrations must fail visibly and must not mutate external installs or credentials by default.

## Current Intentional Compromises

- Most non-memory runtime records still live in a JSON state file for easy local debugging.
- Memory uses SQLite because recall needs structured indexes and durable local query behavior.
- Provider clients still share `packages/runtime/src/provider.ts`; split them when provider routing/fallback becomes more complex.
- Some integration surfaces are durable records and health flows before they are full live transports.
- The CLI command set is broad, but command modules now keep behavior out of the top-level shim.

# ADR: Connector-Backed Web Search

- **Status:** Accepted
- **Date:** 2026-06-01
- **See also:** [Connector + Provider Vocabulary, Spec Compliance, And Meta-Skills](connector-provider-spec-compliance.md), [ChatBlock Protocol](chat-block-protocol.md), [Agent Loop With Native Tool Calling](agent-loop-tool-calling.md), [Authorization vs SetupRequest](authorization-vs-setup-request.md), [Azure OpenAI As A First-Class Provider](azure-provider.md)

## Decision

Web search reaches the agent through two paths, chosen by deployment:

- **Hosted gini** searches the live web **on by default, with no tenant-supplied search key** — its tool-calling turns run on the Azure OpenAI Responses API's built-in `{ type: "web_search" }` tool (Bing-grounded on the service's own Azure resource). The model searches mid-turn and returns cited prose in a single turn. See "Default web search on the hosted gini model" below.
- **Local / self-hosted** deployments use the built-in agent tool `web_search`, backed by **connector providers**. The initial providers are **Brave Search** (`brave-search`, free tier) and **Exa** (`exa`, neural search + extraction). The tool selects a usable connector (`connectorIsUsable`) at dispatch — honoring a model-supplied `provider` argument, otherwise preferring Brave then Exa — resolves that connector's API key through the standard audited secret path, calls the provider's REST API, and returns ranked results as compact text.

The connector path is the first **connector-backed tool**: a built-in tool that consumes a connector secret directly, distinct from the two existing connector consumers (skill env-bindings and auto-registered MCP servers, see ADR connector-provider-spec-compliance.md). Adding a new search backend is a new `ProviderModule` plus a branch in the tool's backend switch — no new tool, no new toolset. It remains the opt-in path for local/self-hosted deployments (and any future explicit override), so a self-hosted operator can still bring their own search backend.

## Context

Comparable agents (Hermes, OpenClaw) expose web search as a single tool with pluggable backends selected by config. Gini already had `web_fetch` (fetch a known URL) but no discovery path, so the model guessed URLs. The connector substrate already models external credentials with health probes and audited secret resolution, so search providers fit it directly — each provider is a `ProviderModule` with a probe and an `envBinding`, and the tool reads the key the same way a skill subprocess would.

## Mechanics

- **Providers.** `packages/runtime/src/integrations/connectors/{brave-search,exa}.ts` export `ProviderModule`s (token field, probe that runs a 1-result query, env-bindings `BRAVE_SEARCH_API_KEY` / `EXA_API_KEY`). Registered in the provider registry. Each also sets the optional `docsUrl` field (below).
- **Tool + backends.** `web_search` is defined in the tool catalog (toolset `web_search`). The dispatcher picks a usable connector (`connectorIsUsable`, the shared predicate from `packages/runtime/src/integrations/connectors/index.ts`), resolves its `token` via `resolveConnectorSecret` (audited), and calls the matching backend in `packages/runtime/src/tools/web-search.ts`.
- **Toolset + migration.** A `web_search` toolset ships enabled by default and is in `DEFAULT_AGENT_TOOLSETS`. Because the agent-whitelist intersection would otherwise hide the tool on instances created before it existed, `normalizeState` registers the post-`browser` default-agent snapshot so the backfill unions `web_search` into existing default-agent whitelists (see `migrateDefaultAgentToolsets` in `packages/runtime/src/state/store.ts`).
- **Degraded fallback when no connector exists.** `web_search` throws a `ToolDisplayError` (below) that steers the model to keep searching with the live-web tools it always has — `browser_navigate` or `web_fetch` against a real search engine — and answer from what it finds rather than from memory. Querying a search engine this way is searching; only guessing random content URLs is not. `request_connector` is offered as a setup upgrade for faster, cleaner results, not a hard gate. When the model does call `request_connector` for a missing provider, the chat renders the model's reason as an assistant bubble above a minimal `connector.request` card; the Connect modal captures the key, and the provider's `docsUrl` renders as a "Learn more" link.

## Default web search on the hosted gini model

Hosted gini gives every tenant live web search with **no search key of their own**. The grounding runs on the service's Azure resource, reached through the edge, so a guest never holds a Bing or Brave/Exa credential.

- **Runtime routes tool-calling turns through the Responses API.** For a hosted `openai` / `azure` provider, the tool-calling dispatch runs the turn on the Azure OpenAI **Responses API** (not Chat Completions), where the built-in `{ type: "web_search" }` tool is available inline. The model searches the live web mid-turn and returns cited prose in a single turn. The choice is gated on the `GINI_HOSTED` marker: `shouldUseResponsesWebSearch` in `packages/runtime/src/provider.ts` returns true only for `openai` / `azure` when `process.env.GINI_HOSTED === "1"`. Non-hosted `openai` / `azure` and every other provider stay on Chat Completions (and thus on the connector path above).
- **The edge exposes a `/responses` router twin.** The hosted edge's model router serves `/responses` alongside its existing `/chat/completions` handler: same router-token auth, same `gini-model` → real-deployment rewrite (the single choke point that resolves the tenant-facing alias), and the same per-call usage metering. Because the call terminates on the service's Azure resource, that resource grounds the built-in search — which is why no tenant key is required. The guest POSTs `{ model: "gini-model", tools: [{ type: "web_search" }], input }` to this twin.
- **The runtime reuses its existing Responses tool-calling path.** `callResponsesWithWebSearch` builds the request with `translateMessagesToResponsesInput` and reads the stream with `readResponsesToolCallingStream` — the same helpers the codex `/responses` path already uses (`packages/runtime/src/provider.ts`). Those handlers key on `function_call` items, so the server-side `web_search_call` items the model emits are ignored and never surface as phantom tool calls; the cited answer streams as text while the search runs server-side.
- **The redundant `web_search` function tool is dropped on this path.** Since the built-in tool does the searching, `callResponsesWithWebSearch` filters the brave/exa `web_search` function tool out of the tools list before appending `{ type: "web_search" }`, so the model never sees two competing search affordances. The runtime's other function tools ride along as Responses function tools unchanged.

## Model-facing vs user-facing tool errors

A tool failure can carry two audiences. `web_search` with no connector must steer the **model** verbosely (keep searching via `browser_navigate` / `web_fetch` against a search engine, with `request_connector` as a setup upgrade) while showing the **user** a calm line ("No search provider connected.").

- `ToolDisplayError` (`packages/runtime/src/execution/tool-dispatch.ts`) carries the verbose model-facing `message` plus a short `displayMessage` and a `displaySeverity` of `"info" | "error"`.
- The chat-task dispatch catch feeds the full `message` to the model as the tool result and passes `displayMessage` / `displaySeverity` to the UI. `ToolCallBlock.errorSeverity` rides the ChatBlock wire (see ADR chat-block-protocol.md) so clients render an `"info"` failure as a muted "needs setup" notice rather than a red error.

This is a general pattern: any tool may throw `ToolDisplayError` to split steering from the user-facing line. Plain `Error`s keep surfacing their message to both audiences (red).

## Async resume after setup resolution

`POST /api/setup-requests/<id>/complete` creates the connector, probes it, and — on a healthy probe — resumes the paused agent run. The resume is **detached** (`resolveSetupRequest({ awaitResume: false })`), mirroring `submitTask`'s fire-and-forget `runTask(...).catch(failTask)`. The HTTP response returns as soon as the connector is saved and verified, so the connect modal closes immediately instead of blocking for the whole resumed run; the agent then streams its continuation into the chat. The same flag applies to `browser.connect` completion.

`POST /api/setup-requests/<id>/cancel` for `connector.request` follows the same detached response shape but resumes the paused run with a cancellation tool result instead of failing the task. That lets the agent continue without the connector when possible, or reply with the specific connector/input it still needs when the original request cannot be satisfied.

## Consequences

- Hosted tenants get web search out of the box: no connector to request, no key to supply. The `web_search` connector tool is dropped from the hosted tools list, so the model reaches for the built-in Responses tool instead of a connector.
- `GINI_HOSTED` (plus `provider.name` being `openai` / `azure`) is the single signal that flips a turn onto the Responses API; any future hosted-only tool behavior keys off the same marker rather than re-deriving "is this hosted?" per site.
- New connector search backends are additive: a `ProviderModule` + a backend branch. No tool/toolset churn. This stays the path for local/self-hosted deployments.
- The connector substrate now has three consumers — skills, MCP, and built-in tools. Future built-in tools that need credentials should follow this path rather than inventing a parallel secret channel.
- `ToolDisplayError` / `errorSeverity` give every tool a way to keep model steering out of the user's view; clients must honor `errorSeverity` (default `"error"`).
- `docsUrl` is an optional `ProviderModule` field; absent it, no "Learn more" link renders.

## Acceptance checks

- `bun test packages/runtime/src/provider.test.ts` covers `shouldUseResponsesWebSearch` gating: true for `openai` / `azure` only when `GINI_HOSTED === "1"`, false for those providers otherwise and for every non-hosted provider, so the Responses web-search path engages only for the hosted gini model.
- `bun test packages/runtime/src/tools/web-search.test.ts`, `packages/runtime/src/integrations/connectors/{brave-search,exa}.test.ts` cover backend mapping and probes.
- `bun test packages/runtime/src/execution/tool-dispatch.test.ts` covers the no-connector `ToolDisplayError` split (verbose model message + `"No search provider connected."` info line) and the provider-specific message when an explicit backend is absent while another is connected.
- `bun test packages/runtime/src/state/store.test.ts` covers the default-agent backfill of `web_search`.
- `bun test packages/runtime/src/execution/chat-task.test.ts` covers the `connector.request` reason rendering as an assistant bubble above the setup card and cancellation resuming the agent loop with a fallback result.
- Live: asking to search the web on an instance with no search connector shows the muted "No search provider connected." line, a Gini explanation bubble, and a minimal Connect card; completing the connect closes the modal immediately and the agent continues.
- Live: cancelling the Connect card marks the card cancelled, clears the in-flight chat state, and the agent either continues with another path or explains which connector/input is still needed.
- Live (hosted): asking the hosted gini model a question that needs current information returns a cited answer from a live web search in one turn, with no search connector configured and no key prompted.

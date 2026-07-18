# ADR: Connector-Backed Web Search

- **Status:** Accepted
- **See also:** [Connector Registry](connector-registry.md), [Provider Spec Compliance](connector-provider-spec-compliance.md)

## Context

Web search needs a real provider credential, but it should still look like one
stable agent capability. Provider-specific search tools would leak connector
selection into prompts and force every new backend to expand the tool catalog.
Embedding a service-owned search path in the model provider would also make
local behavior depend on an external control plane.

## Decision

Gini exposes one built-in agent tool, `web_search`, backed by connector
providers. The initial providers are:

- **Brave Search** (`brave-search`) for conventional ranked web results; and
- **Exa** (`exa`) for neural search and extracted content.

At dispatch, the tool resolves a usable connector through the normal connector
registry and audited secret path. A model-supplied `provider` argument wins;
otherwise Brave is preferred, then Exa. The backend response is normalized to
compact ranked text before it enters the conversation.

This is a connector-backed tool, distinct from skill environment bindings and
auto-registered MCP servers. Adding another search backend requires a
`ProviderModule` and one backend adapter branch, not another agent tool.

Search availability follows connector truth:

- no usable connector means the tool returns a setup request rather than
  pretending current information is available;
- disabled, invalid, or revoked connectors do not satisfy the capability; and
- connector secret values never enter model-visible arguments, traces, or
  errors.

OpenAI and Azure tool-calling normally use Chat Completions. If a deployment
returns a specific error requiring `/v1/responses`, the runtime retries that
turn on the equivalent Responses function-calling surface. It carries the same
runtime `web_search` function tool unchanged; it does not substitute a
provider-native search tool or silently add search spending.

## Consequences

- Local and self-hosted installations own their search credentials and provider
  choice.
- Search behavior is consistent across model providers.
- Models can request `web_search` without knowing which backend is configured.
- A Responses compatibility retry preserves connector governance and audit
  behavior.
- New search providers are additive and do not change the tool schema.

## Acceptance Checks

- Provider registration, secret resolution, selection, and normalized results:
  `packages/runtime/src/tools/web-search.test.ts` and connector provider tests.
- Tool dispatch and setup-request behavior: runtime tool-dispatch tests.
- Responses compatibility preserves `web_search` as a function tool:
  `packages/runtime/src/provider.test.ts`.

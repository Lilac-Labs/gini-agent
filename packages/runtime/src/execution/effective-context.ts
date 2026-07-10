// Effective execution context.
//
// Resolves the active agent's overrides on top of the instance-level
// RuntimeConfig and returns a small bundle the rest of the runtime can
// consult without re-deriving the same intersection logic in every call
// site. Today the bundle covers:
//   - provider override (agent-owned name/model wins over config.provider
//     when both fields are set; otherwise falls back to config.provider)
//   - toolset filter (an opt-in whitelist of toolset names — empty/absent
//     means "no agent-level restriction")
//   - messaging target filter (same shape, applied to bridge delivery)
//   - warnings: best-effort diagnostics for IDs the agent references but
//     state doesn't currently have (or has disabled). The filter still
//     includes those IDs so that re-enabling the toolset later is
//     transparent — warnings are purely informational.
//
// Memory namespacing (Phase C) deliberately lives outside this module for
// now: per-agent memory isolation will introduce its own helper that
// composes with the bundle returned here.

import type { ProviderConfig, ProviderName, RuntimeConfig, RuntimeState } from "../types";
import { normalizeProvider, providerHealth, resolveDispatchProvider } from "../provider";
import { readState } from "../state";

export interface EffectiveContext {
  agentId?: string;
  // Phase C — per-agent memory isolation key. Defined whenever agentId is
  // (so chat-task can pass it through to recall/retain without re-checking
  // optionality). Currently identical to agentId; surfaced as a distinct
  // field so future work can re-namespace memory (e.g. shared pools) without
  // breaking the rest of the contract.
  memoryNamespace?: string;
  provider: ProviderConfig;
  providerSource: "agent" | "instance";
  // Set when `provider` was transiently swapped to a configured fallback
  // because the resolved provider (instance or agent-pinned) had no usable
  // credentials but another real provider did. `selected` is the user's
  // unconfigured choice; `using` is the fallback actually serving the turn.
  // Surfaced so the web can show a "finish setup" banner. NEVER persisted —
  // config.provider keeps the user's selection.
  providerFallback?: { selected: ProviderName; using: ProviderName };
  toolsetFilter?: Set<string>;
  messagingTargetFilter?: Set<string>;
  // Whether the ambient memory pipeline (auto-recall before the model
  // call, auto-retain after completion) runs for this agent's turns.
  // Only an explicit `autoMemory: false` on the agent record turns it
  // off; absent agent or absent field ⇒ true.
  autoMemory: boolean;
  warnings: string[];
}

// Swap an unconfigured resolved provider for a configured fallback (transient,
// per-turn). Returns the provider to dispatch with plus the fallback marker
// when a swap happened; otherwise the provider unchanged. Applied to BOTH the
// instance-sourced provider and an agent-pinned provider so an agent pinned to
// an unconfigured provider falls back too.
function applyDispatchFallback(provider: ProviderConfig, config: RuntimeConfig): {
  provider: ProviderConfig;
  providerFallback?: { selected: ProviderName; using: ProviderName };
} {
  if (providerHealth({ ...config, provider }).configured) {
    return { provider };
  }
  const resolution = resolveDispatchProvider({ ...config, provider });
  if (!resolution.usingFallback) {
    return { provider };
  }
  return {
    provider: resolution.provider,
    providerFallback: { selected: resolution.selected, using: resolution.using }
  };
}

export function resolveEffectiveContext(state: RuntimeState, config: RuntimeConfig): EffectiveContext {
  const agent = state.agents.find((candidate) => candidate.id === state.activeAgentId);
  if (!agent) {
    const dispatch = applyDispatchFallback(config.provider, config);
    return {
      provider: dispatch.provider,
      providerSource: "instance",
      ...(dispatch.providerFallback ? { providerFallback: dispatch.providerFallback } : {}),
      autoMemory: true,
      warnings: []
    };
  }

  const warnings: string[] = [];

  // Provider: agent wins when both name + model are populated. Otherwise we
  // fall back to the instance config so a partially-configured agent doesn't
  // break inference.
  //
  // Only inherit the instance's transport config — baseUrl / apiKeyEnv /
  // extraBody and the Azure routing fields (apiVersion / deployment /
  // authScheme) — when the agent is routing to the SAME provider as the
  // instance. The same-provider branch spreads config.provider, so every one of
  // those fields rides along automatically. A cross-provider agent (e.g. an
  // OpenRouter-routed agent on an Azure-configured instance) must take
  // normalizeProvider's per-provider defaults — spreading config.provider
  // unconditionally would carry the wrong baseUrl + apiKeyEnv (and a stray Azure
  // deployment/api-version) onto the override and silently send the agent's
  // requests to the instance's endpoint with the instance's key.
  let provider: ProviderConfig;
  let providerSource: "agent" | "instance";
  if (agent.providerName && agent.model) {
    const sameProvider = agent.providerName === config.provider.name;
    provider = normalizeProvider(
      sameProvider
        ? {
            ...config.provider,
            name: agent.providerName as ProviderConfig["name"],
            model: agent.model
          }
        : {
            name: agent.providerName as ProviderConfig["name"],
            model: agent.model
          }
    );
    providerSource = "agent";
  } else {
    provider = config.provider;
    providerSource = "instance";
  }

  // Transient dispatch fallback: if the resolved provider (instance OR
  // agent-pinned) has no usable credentials but another real provider does,
  // dispatch with the configured fallback so the turn completes. config.provider
  // is never mutated — the fallback is recomputed per turn and the banner
  // persists until the user finishes setup.
  const dispatch = applyDispatchFallback(provider, config);
  provider = dispatch.provider;

  // Toolset intersection. The agent stores toolset names (e.g. "file"),
  // which match ToolsetRecord.name. Validate against state and surface
  // unknown/disabled references as warnings — but keep them in the filter
  // so re-enabling later "just works".
  let toolsetFilter: Set<string> | undefined;
  if (agent.toolsets && agent.toolsets.length > 0) {
    toolsetFilter = new Set(agent.toolsets);
    const byName = new Map(state.toolsets.map((row) => [row.name, row] as const));
    for (const name of agent.toolsets) {
      const row = byName.get(name);
      if (!row) {
        warnings.push(`agent references unknown toolset '${name}'`);
        continue;
      }
      if (row.status === "disabled") {
        warnings.push(`agent references disabled toolset '${name}'`);
      }
    }
  }

  // Messaging target intersection. We validate against known bridges'
  // deliveryTargets. A target is "known" when at least one configured
  // bridge advertises it.
  let messagingTargetFilter: Set<string> | undefined;
  if (agent.messagingTargets && agent.messagingTargets.length > 0) {
    messagingTargetFilter = new Set(agent.messagingTargets);
    const known = new Set<string>();
    for (const bridge of state.messagingBridges) {
      for (const target of bridge.deliveryTargets) known.add(target);
    }
    for (const target of agent.messagingTargets) {
      if (!known.has(target)) {
        warnings.push(`agent references unknown messaging target '${target}'`);
      }
    }
  }

  return {
    agentId: agent.id,
    memoryNamespace: agent.id,
    provider,
    providerSource,
    ...(dispatch.providerFallback ? { providerFallback: dispatch.providerFallback } : {}),
    toolsetFilter,
    messagingTargetFilter,
    autoMemory: agent.autoMemory !== false,
    warnings
  };
}

// Convenience: read the current state and return the provider override these
// callers should dispatch with. Used by memory pipelines (retain, reflect,
// reinforce) so a single LLM call follows the agent's provider — or the
// transient dispatch fallback when the instance provider is unconfigured —
// without those modules each rebuilding the resolve/source check. Returns
// undefined only when the instance provider is configured and no agent
// override applies, so the generators read config.provider verbatim.
//
// Embeddings and the reranker do NOT use this — they continue to read
// config.provider directly so semantic recall stays stable across agent
// switches (see ADR agents-replace-profiles.md).
export function providerOverrideForRuntime(config: RuntimeConfig): ProviderConfig | undefined {
  const state = readState(config.instance);
  const effective = resolveEffectiveContext(state, config);
  if (effective.providerSource === "agent" || effective.providerFallback) {
    return effective.provider;
  }
  return undefined;
}

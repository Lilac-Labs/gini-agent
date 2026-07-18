import type { ConnectorRecord, ConnectorSecretRef, RuntimeConfig, RuntimeState, SkillRecord } from "../../types";
import { addAudit, appendLog, id, mutateState, now, readState, updateConnectorHealth } from "../../state";
import { deleteConnectorSecrets, readSecret, writeSecret } from "../../state/secrets";
import { syncProviderMcpServers } from "../mcp-sync";
import { redactSecretsInText } from "../mcp-http";
import { getProvider, listProviders, providerForCredentialName } from "./registry";
import type { ProviderModule } from "./types";

export interface CreateConnectorInput {
  name: string;
  provider: string;
  // Credential type. When supplied, the record is stamped with it so skills
  // and MCP rows can resolve the credential by name, and the hard "provider
  // must be a registered module" requirement is relaxed (the module becomes
  // optional template enrichment). Optional — presence-only and un-typed
  // legacy records omit it and still validate against a registered provider.
  type?: ConnectorRecord["type"];
  scopes?: string[];
  secrets?: Record<string, string>;
  // Free-form metadata for the `generic` provider. Stored verbatim on the
  // record under `metadata.fields` so the Add Connector dialog can render
  // dynamic non-secret fields (base URLs, account ids) without provider-
  // specific code. Typed credentials also persist `mcp`/`envMap` here.
  metadata?: ConnectorRecord["metadata"];
}

// CRUD-created connectors always carry `source: "user"`. The detection
// job creates `source: "auto"` records directly on the state slab without
// going through this helper so the auto-create path keeps its own audit
// signal (`connector.auto_create`).

export interface UpdateConnectorInput {
  name?: string;
  scopes?: string[];
  status?: "configured" | "disabled" | "error";
  secrets?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

// Default values the Add Connector dialog prefills when a provider is picked
// as a credential template. Derived from the provider module's secret spec,
// so a plain API key still needs no module while first-party providers
// (linear, google-oauth-desktop) seed the right name + shape automatically.
export interface CredentialTemplate {
  type: "api-key" | "oauth2";
  // api-key: the env var the secret binds to (== credential name).
  // oauth2: a handle (the provider id) the user can rename.
  name: string;
  // api-key only: the HTTP MCP server URL to prefill (from module.mcpServer).
  mcpUrl?: string;
  // api-key only: the MCP server row name to register under (from
  // module.mcpServer.name). Lets the credential own a differently-named row —
  // e.g. LINEAR_API_KEY drives the "linear" server skills reference. Defaults
  // to the credential name when absent.
  mcpName?: string;
  // oauth2 only: purpose → ENV_NAME map seeded from the module's envBindings.
  envMap?: Record<string, string>;
}

// Derive the credential template for a provider from its declared secret
// bindings: exactly one env binding → api-key (the binding's env var is the
// credential name; the module's `mcpServer.url`, if any, prefills the MCP
// field); two or more → oauth2 (envMap = purpose → ENV_NAME, reversed from
// the module's `envBindings`). Providers with no secret spec (presence-only,
// generic) have no template — those still go through the by-type dialog
// inputs the user fills in manually.
export function credentialTemplateForProvider(module: ProviderModule): CredentialTemplate | undefined {
  const envBindings = module.secrets?.envBindings;
  if (!envBindings) return undefined;
  const entries = Object.entries(envBindings);
  if (entries.length === 0) return undefined;
  if (entries.length === 1) {
    const [envName] = entries[0]!;
    return {
      type: "api-key",
      // api-key name IS the env var, unless the module pins a canonical name.
      name: module.credentialName ?? envName,
      ...(module.mcpServer?.url ? { mcpUrl: module.mcpServer.url } : {}),
      ...(module.mcpServer?.name ? { mcpName: module.mcpServer.name } : {})
    };
  }
  const envMap: Record<string, string> = {};
  for (const [envName, purpose] of entries) {
    envMap[purpose] = envName;
  }
  // oauth2 name is a handle. Use the module's canonical credentialName (e.g.
  // "google-workspace-oauth") when declared so the dialog / request / CLI /
  // migration agree; fall back to the module id only when none is set.
  return { type: "oauth2", name: module.credentialName ?? module.id, envMap };
}

// An env-var token: uppercase ASCII, digits, and underscores, leading with a
// letter. An api-key credential's `name` IS its env var, and every oauth2
// `metadata.envMap` target must be one of these.
const ENV_TOKEN = /^[A-Z][A-Z0-9_]*$/;

// Mark the connector(s) for a provider unhealthy when a runtime auth failure
// is observed (Section D bridge). Called fire-and-forget from agent.ts and
// chat-task.ts after recording the ProviderAuthFailure record. Only touches
// providers that actually have a connector (codex, claude-code in practice).
export async function markConnectorUnhealthyForProvider(
  instance: string,
  provider: string,
  detail: string
): Promise<void> {
  const state = readState(instance);
  const targets = state.connectors.filter(
    (c) => c.provider === provider && c.status === "configured"
  );
  if (targets.length === 0) return;
  await mutateState(instance, (s) => {
    const at = now();
    for (const target of targets) {
      const conn = s.connectors.find((c) => c.id === target.id);
      if (!conn) continue;
      const transition = conn.health !== "unhealthy";
      conn.health = "unhealthy";
      conn.message = detail;
      conn.lastHealthAt = at;
      conn.updatedAt = at;
      if (transition) {
        addAudit(
          s,
          {
            actor: "runtime",
            action: "connector.health.transition",
            target: conn.id,
            risk: "medium",
            evidence: {
              provider: conn.provider,
              from: target.health,
              to: "unhealthy",
              message: detail,
              source: "provider_auth_failure"
            }
          },
          { system: true }
        );
      }
    }
  });
}

// Re-probe connectors for a provider after its auth failure has cleared.
// Called fire-and-forget when a successful model call clears the needs-reauth
// record, so recovery doesn't wait for the 30-min reprobe cadence.
export async function reprobeConnectorsForProvider(
  config: RuntimeConfig,
  provider: string
): Promise<void> {
  const state = readState(config.instance);
  const targets = state.connectors.filter(
    (c) => c.provider === provider && c.status === "configured"
  );
  for (const target of targets) {
    const module = getProvider(target.provider);
    if (!module?.probe) continue;
    try {
      await checkConnector(config, target.id);
    } catch {
      // Best-effort: the probe failure already landed on the record.
    }
  }
}

export async function createConnector(config: RuntimeConfig, input: CreateConnectorInput): Promise<ConnectorRecord> {
  const provider = String(input.provider || "").trim();
  if (!provider) throw new Error("Invalid input: provider is required.");
  if (!String(input.name || "").trim()) throw new Error("Invalid input: name is required.");
  const module = getProvider(provider);
  // The provider module is REQUIRED only for un-typed creates that ALSO lack a
  // credential template (presence-only and legacy provider-keyed connectors
  // still resolve through their module). When a credential `type` is supplied,
  // OR the registered module carries a `credentialTemplate`, the create yields
  // a typed record: a plain api-key needs no registered provider (unknown
  // provider allowed once `type` is set), and a template-backed provider (e.g.
  // linear, google-oauth-desktop) is stamped typed even when the caller —
  // connector.request /complete, `gini connector add` — passed no `type`.
  const template = module ? credentialTemplateForProvider(module) : undefined;
  if (!module && !input.type) {
    throw new Error(`Unknown provider: ${provider}. Use one of ${listProviders().map((p) => p.id).join(", ")} or "generic".`);
  }

  // Resolve the effective type/name/metadata. An explicit `type` (the
  // type-driven Add Connector dialog) wins and uses the caller's name +
  // metadata as-is. Otherwise, when the provider has a template, stamp the
  // record from it so EVERY create path (dialog, /complete, CLI) lands the
  // same typed, name-correct shape the migration produces. With no type and
  // no template, the record stays untyped (presence-only / generic).
  let type = input.type;
  let name = String(input.name).trim();
  let metadata = input.metadata;
  if (!type && template) {
    type = template.type;
    name = template.name;
    if (template.type === "api-key") {
      metadata = {
        ...(input.metadata ?? {}),
        ...(template.mcpUrl
          ? {
              mcp: {
                url: template.mcpUrl,
                ...(template.mcpName ? { name: template.mcpName } : {}),
                headerName: "Authorization",
                scheme: "Bearer"
              }
            }
          : {})
      };
    } else {
      metadata = { ...(input.metadata ?? {}), envMap: { ...template.envMap } };
    }
  }

  // Typed-credential name rules (LOCKED decision 3). api-key name IS the env
  // var; oauth2 name is a handle but each envMap target must be a valid env
  // token. Names are unique instance-wide (uniqueness is enforced inside the
  // mutate lock below so a concurrent create can't slip a duplicate past the
  // check).
  if (type === "api-key" && !ENV_TOKEN.test(name)) {
    throw new Error(`Invalid api-key credential name: "${name}". The name is used as the environment variable, so it must match ${ENV_TOKEN.source} (e.g. LINEAR_API_KEY).`);
  }
  if (type === "oauth2") {
    const envMap = (metadata?.envMap ?? {}) as Record<string, string>;
    for (const envName of Object.values(envMap)) {
      if (!ENV_TOKEN.test(String(envName))) {
        throw new Error(`Invalid env var name in envMap: "${envName}". Each target must match ${ENV_TOKEN.source} (e.g. GOOGLE_WORKSPACE_CLI_CLIENT_ID).`);
      }
    }
  }

  const connectorId = id("id");
  const secretRefs: ConnectorSecretRef[] = [];
  for (const [purpose, value] of Object.entries(input.secrets ?? {})) {
    if (typeof value !== "string" || value.length === 0) continue;
    secretRefs.push(writeSecret(config.instance, connectorId, purpose, value));
  }

  // Shape validation (MED #11). A typed record must resolve cleanly: an
  // api-key has exactly one secret (its env var == name reads `secretRefs[0]`),
  // and every oauth2 envMap purpose must have a matching secretRef so each
  // declared env var actually resolves. These run before the mutate so a
  // malformed record never lands.
  if (type === "api-key" && secretRefs.length !== 1) {
    throw new Error(`An api-key credential must carry exactly one secret; "${name}" got ${secretRefs.length}.`);
  }
  if (type === "oauth2") {
    const envMap = (metadata?.envMap ?? {}) as Record<string, string>;
    const purposes = new Set(secretRefs.map((ref) => ref.purpose));
    for (const purpose of Object.keys(envMap)) {
      if (!purposes.has(purpose)) {
        throw new Error(`oauth2 credential "${name}" maps purpose "${purpose}" to an env var but has no secret for it.`);
      }
    }
  }

  const finalType = type;
  const finalName = name;
  const finalMetadata = metadata;
  const result = await mutateState(config.instance, (state) => {
    const at = now();
    // Uniqueness check INSIDE the lock (LOCKED decision 3). A typed credential
    // name must be unique instance-wide INCLUDING disabled/tombstoned records —
    // a disabled credential still owns its name (and its env var), so allowing
    // a duplicate would make name→credential resolution ambiguous.
    if (finalType) {
      const existing = state.connectors.find((c) => c.name === finalName);
      if (existing) {
        throw new Error(`A credential named "${finalName}" already exists. Credential names must be unique.`);
      }
    }
    const connector: ConnectorRecord = {
      id: connectorId,
      instance: state.instance,
      name: finalName,
      provider,
      ...(finalType ? { type: finalType } : {}),
      status: "configured",
      scopes: Array.isArray(input.scopes) ? input.scopes.map(String) : [],
      secretRefs,
      createdAt: at,
      updatedAt: at,
      health: "unknown",
      metadata: finalMetadata,
      source: "user"
    };
    state.connectors.unshift(connector);
    // For connectors without a probe (demo, generic, claude-code, codex, and
    // typed credentials whose provider has no registered module) there is no
    // remote check that could refute the configured-status assumption, so the
    // synchronous health-set is honest. For probe-based providers (linear),
    // seeding `healthy` from `status === "configured"` would lie until the
    // next reprobe — leave them at `health: "unknown"` so the activation gate
    // (which treats unknown-with-probe as inactive) waits for the first real
    // probe before surfacing dependent skills.
    if (!module?.probe) {
      updateConnectorHealth(connector);
    }
    // Connectors live at the instance level — they're shared across
    // every agent, so the create row isn't per-agent activity.
    addAudit(
      state,
      {
        actor: "user",
        action: "connector.create",
        target: connector.id,
        risk: "medium",
        evidence: {
          provider: connector.provider,
          name: connector.name,
          scopes: connector.scopes,
          purposes: secretRefs.map((ref) => ref.purpose)
        }
      },
      { system: true }
    );
    return connector;
  });
  // Probe immediately for probe-having providers so health is settled before
  // returning. All paths (HTTP POST, CLI add, agent rotate_connector) inherit
  // this probe. Best-effort: a probe failure lands on the record (health:
  // "unhealthy" + message) rather than failing the create itself.
  if (module?.probe) {
    try {
      return await checkConnector(config, connectorId);
    } catch {
      // checkConnector already persisted the failure; return the latest record.
      return readState(config.instance).connectors.find((c) => c.id === connectorId)!;
    }
  }
  return result;
}

export async function updateConnector(
  config: RuntimeConfig,
  connectorId: string,
  input: UpdateConnectorInput
): Promise<ConnectorRecord> {
  const newSecrets = input.secrets ?? {};
  const wroteRefs: ConnectorSecretRef[] = [];
  for (const [purpose, value] of Object.entries(newSecrets)) {
    if (typeof value !== "string" || value.length === 0) continue;
    wroteRefs.push(writeSecret(config.instance, connectorId, purpose, value));
  }
  const result = await mutateState(config.instance, (state) => {
    const connector = state.connectors.find((candidate) => candidate.id === connectorId);
    if (!connector) throw new Error(`Connector not found: ${connectorId}`);
    if (typeof input.name === "string") {
      const nextName = input.name.trim() || connector.name;
      // Renaming a typed credential must keep the LOCKED name rules intact:
      // an api-key name IS its env var (uppercase env-token), and names stay
      // unique instance-wide (including disabled records). Skip when the name
      // is unchanged so an idempotent PATCH doesn't fail its own uniqueness
      // check.
      if (connector.type && nextName !== connector.name) {
        if (connector.type === "api-key" && !ENV_TOKEN.test(nextName)) {
          throw new Error(`Invalid api-key credential name: "${nextName}". The name is used as the environment variable, so it must match ${ENV_TOKEN.source} (e.g. LINEAR_API_KEY).`);
        }
        const collision = state.connectors.find((c) => c.id !== connector.id && c.name === nextName);
        if (collision) {
          throw new Error(`A credential named "${nextName}" already exists. Credential names must be unique.`);
        }
      }
      connector.name = nextName;
    }
    if (Array.isArray(input.scopes)) connector.scopes = input.scopes.map(String);
    if (input.status) connector.status = input.status;
    if (input.metadata) connector.metadata = { ...(connector.metadata ?? {}), ...input.metadata };
    for (const ref of wroteRefs) {
      const existing = connector.secretRefs.find((candidate) => candidate.purpose === ref.purpose);
      if (existing) existing.path = ref.path;
      else connector.secretRefs.push(ref);
    }
    connector.updatedAt = now();
    addAudit(
      state,
      {
        actor: "user",
        action: wroteRefs.length > 0 ? "connector.rotate" : "connector.update",
        target: connector.id,
        risk: "medium",
        evidence: {
          provider: connector.provider,
          rotatedPurposes: wroteRefs.map((ref) => ref.purpose)
        }
      },
      { system: true }
    );
    return connector;
  });
  // Re-probe after a secret rotation or status change for probe-having
  // providers so health settles immediately. Best-effort: failures land on
  // the record itself rather than failing the update.
  const shouldProbe = wroteRefs.length > 0 || input.status === "configured";
  if (shouldProbe) {
    const module = getProvider(result.provider);
    if (module?.probe) {
      try {
        return await checkConnector(config, connectorId);
      } catch {
        return readState(config.instance).connectors.find((c) => c.id === connectorId)!;
      }
    }
  }
  return result;
}

export async function deleteConnector(config: RuntimeConfig, connectorId: string): Promise<{ id: string; tombstoned?: boolean }> {
  // Read the source up-front so we can decide whether to physically wipe
  // the encrypted secrets. Auto-source connectors don't carry secrets
  // today (claude-code/codex are presence-only), but the wipe is still
  // safe to skip — the tombstone path leaves the record in place so a
  // future "rotate" or "edit" could rebuild it.
  const initial = readState(config.instance).connectors.find((c) => c.id === connectorId);
  if (!initial) throw new Error(`Connector not found: ${connectorId}`);
  const isAuto = initial.source === "auto";

  if (!isAuto) {
    deleteConnectorSecrets(config.instance, connectorId);
  }

  return mutateState(config.instance, (state) => {
    const index = state.connectors.findIndex((candidate) => candidate.id === connectorId);
    if (index < 0) throw new Error(`Connector not found: ${connectorId}`);
    if (isAuto) {
      // Tombstone — keep the record around with `status: "disabled"` so
      // the detection job (which skips disabled rows) doesn't immediately
      // re-create the connector after the user explicitly disconnected it.
      const connector = state.connectors[index]!;
      connector.status = "disabled";
      connector.health = "unknown";
      connector.message = undefined;
      connector.updatedAt = now();
      addAudit(
        state,
        {
          actor: "user",
          action: "connector.disable",
          target: connectorId,
          risk: "medium",
          evidence: { provider: connector.provider, name: connector.name, source: connector.source }
        },
        { system: true }
      );
      return { id: connectorId, tombstoned: true };
    }
    const [connector] = state.connectors.splice(index, 1);
    addAudit(
      state,
      {
        actor: "user",
        action: "connector.delete",
        target: connectorId,
        risk: "medium",
        evidence: { provider: connector?.provider, name: connector?.name }
      },
      { system: true }
    );
    return { id: connectorId };
  });
}

// Resolve a single secret value for a connector, emitting an audit event
// that records the purpose and whether resolution succeeded — never the
// value itself. Callers that need to pass a secret into a subprocess
// should fetch it through here so the audit trail is consistent.
// When `taskId` is supplied, the resolution audit attributes to the
// owning agent of that task; callers without a task context (health
// probes, management UI) fall through to a system-level audit.
export async function resolveConnectorSecret(
  config: RuntimeConfig,
  connectorId: string,
  purpose: string,
  taskId?: string
): Promise<string | undefined> {
  const state = readState(config.instance);
  const connector = state.connectors.find((candidate) => candidate.id === connectorId);
  if (!connector) throw new Error(`Connector not found: ${connectorId}`);
  const ref = connector.secretRefs.find((candidate) => candidate.purpose === purpose);
  let value: string | undefined;
  let ok = false;
  try {
    if (ref) {
      value = readSecret(config.instance, ref);
      ok = true;
    }
  } finally {
    await mutateState(config.instance, (mutating) => {
      addAudit(
        mutating,
        {
          actor: "runtime",
          action: "connector.secret.use",
          target: connectorId,
          risk: "low",
          taskId,
          evidence: { provider: connector.provider, purpose, resolved: ok }
        },
        taskId ? { taskId } : { system: true }
      );
    });
  }
  return value;
}

// Per-provider health probe dispatch. Probes are optional per ADR connector-provider-spec-compliance.md: a
// provider without a `probe` falls back to a configured-status check (no
// remote system to query). A record that references an unknown provider AND
// carries no credential `type` lands at `unhealthy` with a surfaced message so
// the activation gate sees the failure — but a typed credential (api-key /
// oauth2) is self-describing: it resolves from its own fields/envMap and needs
// no provider module, so a plain typed key whose provider isn't registered is
// treated presence-healthy (configured → healthy) rather than unhealthy. This
// keeps "a plain API key needs no module" true end to end.
export async function checkConnector(config: RuntimeConfig, connectorId: string): Promise<ConnectorRecord> {
  const initial = readState(config.instance).connectors.find((candidate) => candidate.id === connectorId);
  if (!initial) throw new Error(`Connector not found: ${connectorId}`);

  const module = getProvider(initial.provider);
  let probeMessage: string | undefined;
  let probeHealth: "healthy" | "unhealthy" | "unknown" = initial.health;
  let probed = false;

  if (!module && initial.type) {
    // Typed credential with no registered module — self-describing, no remote
    // system to query. Presence-healthy when configured.
    probeHealth = initial.status === "configured" ? "healthy" : "unhealthy";
    probeMessage = `Typed ${initial.type} credential "${initial.name}" has no provider module; presence-only.`;
  } else if (!module) {
    probeHealth = "unhealthy";
    probeMessage = `Unknown provider: ${initial.provider}.`;
    probed = true;
  } else if (module.probe) {
    probed = true;
    try {
      const result = await module.probe({
        config,
        connectorId,
        resolveSecret: (purpose) => resolveConnectorSecret(config, connectorId, purpose),
        metadata: initial.metadata ?? {}
      });
      probeHealth = result.ok ? "healthy" : "unhealthy";
      probeMessage = result.message;
    } catch (error) {
      probeHealth = "unhealthy";
      probeMessage = error instanceof Error ? error.message : String(error);
    }
  } else {
    // Presence-only provider (e.g. apple-notes, generic with no static check).
    // Default to healthy iff the record is configured — there is no remote
    // system to query.
    probeHealth = initial.status === "configured" ? "healthy" : "unhealthy";
    probeMessage = `Provider ${initial.provider} has no remote probe; presence-only.`;
  }

  const result = await mutateState(config.instance, (state) => {
    const connector = state.connectors.find((candidate) => candidate.id === connectorId);
    if (!connector) throw new Error(`Connector not found: ${connectorId}`);
    connector.lastHealthAt = now();
    connector.health = probeHealth;
    connector.message = probeMessage;
    connector.updatedAt = now();
    addAudit(
      state,
      {
        actor: "runtime",
        action: "connector.health",
        target: connectorId,
        risk: "low",
        evidence: { provider: connector.provider, health: connector.health, probed }
      },
      { system: true }
    );
    return connector;
  });
  // After a successful health write, materialize any provider-declared
  // MCP server record so `mcp_call(server: "<provider>")` resolves. Safe
  // to call on every probe — the sync is idempotent and skips providers
  // whose MCP entry already exists.
  if (result.health === "healthy") {
    try {
      await syncProviderMcpServers(config);
    } catch (error) {
      // Best-effort. A failure here doesn't unwind the health update —
      // the connector is still usable for env-based flows. But we MUST
      // make the failure observable so a regression isn't silent:
      // operators see `mcp.auto_register_failed` in the audit log and
      // can diagnose without re-running the probe locally.
      const message = redactSecretsInText(error instanceof Error ? error.message : String(error));
      appendLog(config.instance, "mcp.auto_register.error", {
        connectorId,
        provider: result.provider,
        error: message
      });
      await mutateState(config.instance, (state) => {
        addAudit(
          state,
          {
            actor: "runtime",
            action: "mcp.auto_register_failed",
            target: connectorId,
            risk: "low",
            evidence: { provider: result.provider, error: message }
          },
          { system: true }
        );
      });
    }
  }
  return result;
}

// Does this configured connector pass the same health guard the activation
// gate and env resolution share? A `disabled` connector is one the user
// explicitly turned off — even if a stale probe still says "healthy", it
// must not satisfy a skill. An `error` status means setup failed.
// `health: "unknown"` counts only when the matching provider has no probe
// (no failing signal); a probe-based provider that hasn't run yet stays
// inactive so we don't surface skills before their first probe.
export function connectorIsUsable(connector: ConnectorRecord): boolean {
  if (connector.status !== "configured") return false;
  if (connector.health === "healthy") return true;
  const hasProbe = Boolean(getProvider(connector.provider)?.probe);
  return !hasProbe && connector.health === "unknown";
}

// A skill is active iff every required credential is satisfied by a
// configured + healthy ConnectorRecord. The agent loop filters inactive
// skills out of its available-skills set; the UI still shows them so users
// can see what's missing.
//
// Name-based: a required credential NAME is satisfied when a usable connector
// with that `name` exists. A skill that declares no `requiredCredentials` has
// no credential gate (the legacy `requires.connectors` form is mapped to
// credential names at load time — see canonicalCredentialName in
// connectors/registry.ts, applied by the skill loader).
//
// When NO connector record with the required name exists at all, the provider
// that owns the credential name gets a final say via its
// `credentialExternallySatisfied` hook — e.g. a Google account attached to
// this instance satisfies google-workspace-oauth with no connector record
// (ADR google-multi-account.md). An existing record of ANY status keeps the
// `connectorIsUsable`-only semantics: a `disabled` record is an explicit
// operator off and must not be overridden by an external source.
export function isSkillActive(state: RuntimeState, skill: SkillRecord): boolean {
  if (skill.validationStatus === "unsupported") return false;
  const credentials = skill.requiredCredentials ?? [];
  for (const name of credentials) {
    const named = state.connectors.filter((candidate) => candidate.name === name);
    if (named.some(connectorIsUsable)) continue;
    if (named.length === 0) {
      const providerId = providerForCredentialName(name);
      const module = providerId ? getProvider(providerId) : undefined;
      if (module?.credentialExternallySatisfied?.(state.instance)) continue;
    }
    return false;
  }
  return true;
}

// Derive env var → (provider, purpose) mappings at runtime from each
// registered provider's `envBindings`. This replaces the pre-ADR-connector-provider-spec-compliance.md
// hardcoded global map. Callers can ask "which env vars do these providers
// expose, and which purpose holds the secret for each?" without
// per-provider knowledge.
export function envBindingsForProviders(providers: string[]): Record<string, { provider: string; purpose: string }> {
  const result: Record<string, { provider: string; purpose: string }> = {};
  for (const providerId of providers) {
    const module = getProvider(providerId);
    if (!module?.secrets?.envBindings) continue;
    for (const [envName, purpose] of Object.entries(module.secrets.envBindings)) {
      result[envName] = { provider: providerId, purpose };
    }
  }
  return result;
}

// Derive env var → (credentialId, purpose) mappings from named credentials.
// This is the name-based successor to `envBindingsForProviders` for skill-env
// resolution. For each requested credential NAME:
//   - api-key: one binding whose env var IS the credential name (uppercase
//     env-token), reading the credential's single secret purpose.
//   - oauth2: one binding per `metadata.envMap` entry (purpose → ENV_NAME).
// Only configured + healthy credentials contribute (same guard as
// `isSkillActive`). A name that matches no usable credential yields nothing.
// On a duplicate env var across two requested credentials, the first
// requested credential wins (deterministic; names are unique instance-wide
// once migrated).
export function bindingsForCredentials(
  state: RuntimeState,
  names: string[]
): Record<string, { credentialId: string; purpose: string }> {
  const result: Record<string, { credentialId: string; purpose: string }> = {};
  for (const name of names) {
    const connector = state.connectors.find(
      (candidate) => candidate.name === name && connectorIsUsable(candidate)
    );
    if (!connector) continue;
    if (connector.type === "oauth2") {
      const envMap = connector.metadata?.envMap ?? {};
      for (const [purpose, envName] of Object.entries(envMap)) {
        if (envName in result) continue;
        result[envName] = { credentialId: connector.id, purpose };
      }
      continue;
    }
    // api-key: the env var IS the credential name. Resolve from its single
    // secret purpose. Untyped/presence-only records (type=null, e.g.
    // claude-code/codex) carry no env and must contribute no binding even
    // though they may hold a secretRef.
    if (connector.type !== "api-key") continue;
    const purpose = connector.secretRefs[0]?.purpose;
    if (!purpose) continue;
    if (name in result) continue;
    result[name] = { credentialId: connector.id, purpose };
  }
  return result;
}

// The first required credential a non-bundled skill needs the user to grant
// before it can be enabled — or `undefined` when every credentialed
// requirement is already granted. A requirement needs consent only when it
// "carries a secret": the named connector has a `type` (api-key/oauth2);
// presence-only connectors (no type, no env) leak nothing. Shared by
// setSkillStatusTool (initial gate) and the /complete grant branch (next-card
// mint) so both stay in lockstep. Name-based only — the legacy
// `requires.connectors` form is mapped to credential names at load time.
export function firstUngrantedCredential(
  state: RuntimeState,
  skill: SkillRecord
): { name: string; label: string } | undefined {
  const granted = skill.grantedConnectors ?? [];
  for (const name of skill.requiredCredentials ?? []) {
    if (granted.includes(name)) continue;
    const connector = state.connectors.find((c) => c.name === name);
    // Only typed credentials carry a secret that needs consent.
    if (!connector?.type) continue;
    const label = getProvider(connector.provider)?.label ?? name;
    return { name, label };
  }
  return undefined;
}

// NOTE: connector env enters a process through exactly one path —
// `skill_run`, which calls `resolveSkillEnv` for the named skill. The old
// aggregate-across-every-active-skill helper (`resolveActiveSkillsEnv`) and
// the per-name terminal_exec resolver (`resolveSkillEnvByName`) are both
// gone: terminal commands always run with a clean env. See
// docs/adr/skill-env-containment.md.

export async function resolveSkillEnv(
  config: RuntimeConfig,
  skill: SkillRecord,
  taskId?: string
): Promise<Record<string, string>> {
  // The injectable env set is derived from the skill's GRANTED
  // `requiredCredentials`, NOT from the legacy `prerequisites.env` list. A
  // skill that declares only `requires.credentials: [X]` (the modern,
  // documented way) must get X injected; gating on `prerequisites.env` would
  // silently drop it. `bindingsForCredentials` already produces the right
  // NAME→secret bindings (api-key: env var == name; oauth2: envMap entries).
  const credentials = skill.requiredCredentials ?? [];
  if (credentials.length === 0) return {};
  const state = readState(config.instance);
  // Per-(skill, credential) consent gate (ADR skill-connector-consent.md). A
  // credential contributes env only when the skill is bundled (first-party,
  // auto-granted) or the user has explicitly granted that credential NAME to
  // this skill. Without this, any installed+enabled skill that merely DECLARES
  // a credential would receive its secret — the prompt-injection hole. The
  // bundled short-circuit means bundled skills never need a written grant.
  const bundled = (skill.source ?? "user") === "bundled";

  // Name-based resolution. Each env var resolves through
  // `bindingsForCredentials`, which already applies the configured+healthy
  // guard. The grant gate keys on the credential NAME: api-key credentials
  // have env var == name; oauth2 credentials map several env vars to one name
  // (the credential id ties an env var back to its owning credential name for
  // the gate). A skill with no `requiredCredentials` resolves nothing — the
  // legacy `requires.connectors` form is mapped to credential names at load
  // time (see canonicalCredentialName in connectors/registry.ts), so there
  // is no provider-keyed resolution path left here.
  const idToName = new Map<string, string>();
  for (const name of credentials) {
    const connector = state.connectors.find(
      (candidate) => candidate.name === name && connectorIsUsable(candidate)
    );
    if (connector) idToName.set(connector.id, name);
  }
  const granted = (name: string): boolean =>
    bundled || (skill.grantedConnectors?.includes(name) ?? false);
  const bindings = bindingsForCredentials(state, credentials);
  const out: Record<string, string> = {};
  for (const [envName, binding] of Object.entries(bindings)) {
    const credentialName = idToName.get(binding.credentialId);
    if (!credentialName || !granted(credentialName)) continue;
    const value = await resolveConnectorSecret(config, binding.credentialId, binding.purpose, taskId);
    if (value) out[envName] = value;
  }
  return out;
}

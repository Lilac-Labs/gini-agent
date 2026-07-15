// Provider-module contract (ADR connector-provider-spec-compliance.md).
//
// A ProviderModule encapsulates everything Gini needs to know about a
// specific external integration — its label, the fields the Add Connector
// dialog renders, which env-var bindings expose to skills, and (optionally)
// a remote health probe. Each module is a peer in `src/integrations/
// connectors/` and registers itself via the registry.

import type { Instance, RuntimeConfig } from "../../types";

export interface ProviderField {
  // Stable id used as the form-field name and (for secrets) the secret
  // purpose. Kebab-case by convention.
  name: string;
  // Human-readable label rendered in the Add Connector dialog.
  label: string;
  // Hint text rendered below the field.
  description?: string;
  // Whether the value is sensitive. Secret fields are persisted via the
  // encrypted secrets store (ADR connector-secret-storage.md) and never written to state.json or
  // audit evidence. Non-secret fields live on `connector.metadata.fields`.
  secret: boolean;
  // Whether the user must supply this field. The CRUD layer rejects
  // missing required fields before persisting.
  required?: boolean;
  // Placeholder rendered in the form input.
  placeholder?: string;
}

export interface ProviderSecretSpec {
  // Logical purposes the provider's secrets satisfy (for audit clarity).
  purposes: string[];
  // Map of env var → secret purpose. The runtime uses this to bind a
  // connector's secrets into the env of subprocesses launched by skills
  // that depend on this provider. Example: `{ LINEAR_API_KEY: "token" }`
  // for the Linear provider.
  envBindings: Record<string, string>;
}

export interface ProbeContext {
  config: RuntimeConfig;
  connectorId: string;
  // Resolve a secret value for the connector under probe. Records an audit
  // event regardless of success.
  resolveSecret: (purpose: string) => Promise<string | undefined>;
  // Non-secret per-record metadata (e.g. base URL, account id).
  metadata: Record<string, unknown>;
}

export interface ProbeResult {
  ok: boolean;
  // Surfaced to the user via `connector.message`.
  message?: string;
}

export interface DetectResult {
  detected: boolean;
  // Optional human-friendly name to suggest in the Add Connector dialog.
  suggestedName?: string;
  // Optional notes describing how detection ran (CLI path, env var…).
  message?: string;
}

export interface ProviderModule {
  // Kebab-case identifier. Must equal the file basename and match the
  // value users supply for `provider` in API and CLI calls.
  id: string;
  // Human-readable label for the dialog and connector cards.
  label: string;
  // One-line product summary rendered in the Add Connector dialog.
  description: string;
  // Optional "Learn more" link rendered under the connect form.
  docsUrl?: string;
  // Form fields the Add Connector dialog renders. Empty for providers that
  // have no inputs (e.g. claude-code, codex use the host environment).
  fields: ProviderField[];
  // Secret spec — purposes and env-var bindings the provider declares.
  // Omitted for providers that don't store secrets.
  secrets?: ProviderSecretSpec;
  // Optional canonical credential NAME for this provider's typed credential.
  // api-key providers don't need it (the name IS the single env var binding),
  // but an oauth2 provider's handle differs from both its module id and its
  // env vars — e.g. google-oauth-desktop → "google-workspace-oauth". When set,
  // `credentialTemplateForProvider` uses it as the template name so the Add
  // Connector dialog, connector.request /complete, the CLI, and the state
  // migration all produce the SAME credential name. Surfaced through
  // `canonicalCredentialName` (connectors/registry.ts), the single source the
  // migration and skill loader both consult.
  credentialName?: string;
  // Optional. Returns true when this provider's canonical credential is
  // satisfied by an external source attached to this instance even though no connector
  // record exists in the instance. `isSkillActive` consults this only when NO
  // connector record with the required name exists at all — an existing
  // record of any status (including `disabled`, an explicit operator off)
  // keeps the usability-only gate and is never overridden by this hook. E.g.
  // google-oauth-desktop reports the machine-global Google account registry,
  // where each registered config dir is self-contained. Must be cheap and
  // synchronous: the activation gate sits on the hot system-prompt path.
  credentialExternallySatisfied?: (instance: Instance) => boolean;
  // Probe is optional per ADR connector-provider-spec-compliance.md. Providers with no remote system to
  // query (apple-notes via TCC, generic by definition) omit it; the
  // connector record's health falls back to a status-only check.
  probe?(ctx: ProbeContext): Promise<ProbeResult>;
  // Optional detector — surfaces "we noticed `claude` on your PATH" in
  // the Add Connector dialog. Best-effort; called from the gateway only
  // when the user opens the dialog.
  detect?(): Promise<DetectResult>;
  // Per-provider probe-interval override (ms). Defaults to 30 minutes
  // when undefined. The periodic re-probe job uses this to pace the
  // background health pass.
  probeIntervalMs?: number;
  // Optional. When set, the runtime constructs the user-visible message
  // shown above the inline connector.request form by substituting
  // `${name}` placeholders with values from the tool call's `params`
  // argument. Each placeholder name must appear in `requestParams`. If
  // the provider doesn't declare `requestInstructions`, the model's
  // `reason` field is used verbatim (current behavior).
  requestInstructions?: string;
  // Optional. Parameters the model can pass to `request_connector`. Each
  // is exposed in `params: { [name]: string }` on the tool call. Required
  // params are validated at dispatch time. Non-secret only — these are
  // runtime context (e.g. project IDs), not credentials.
  requestParams?: Array<{
    name: string;
    label: string;
    description?: string;
    required?: boolean;
  }>;
  // Optional. The name of a bundled Gini skill that owns the setup flow
  // for this provider. When set, the runtime tells the model to invoke
  // THIS SKILL (via read_skill) when the connector is missing, instead of
  // the default "call request_connector" shortcut. The setup skill is
  // responsible for any installation, OAuth, project provisioning, etc.,
  // and itself calls request_connector at the end to capture credentials.
  setupSkill?: string;
  // Optional. When set, the runtime auto-registers a matching MCP server
  // record (in `state.mcpServers`) the first time a configured + healthy
  // connector for this provider appears. The registry is keyed by `name`:
  // if an MCP server with the same name already exists (user-managed or
  // otherwise), the upsert is a no-op so we never clobber custom config.
  // Headers may reference `${ENV}` placeholders that resolve through
  // `resolveMcpHeaders()` against the same provider's `envBindings`.
  mcpServer?: {
    name: string;
    url: string;
    transport?: "http";
    headers?: Record<string, string>;
    exposedTools?: string[];
  };
}

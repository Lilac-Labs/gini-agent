"use client";

// Reusable Add Connector dialog. Originally lived in
// web/src/app/connectors/page.tsx; lifted here so the Skills page can
// open it inline next to a missing-connector row without navigating.
// Stays a controlled component (open/onOpenChange owned by the caller)
// so the call site decides when to surface it.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DocReference } from "@/components/DocReference";
import type { ProviderDescriptor } from "@/lib/queries";

export interface CreateConnectorBody {
  provider: string;
  name: string;
  // Credential type. Threaded through to createConnector so the record is
  // stamped by type and resolves by name. Omitted by rotate/request (those
  // operate on existing/provider-pinned records) and by the legacy
  // provider-template create path.
  type?: "api-key" | "oauth2";
  // Optional so rotate mode can omit it. The runtime's updateConnector
  // treats any provided scopes array as a full replacement, so sending
  // `scopes: []` from a rotate (where the dialog hides the input) would
  // wipe the stored scopes despite the dialog promising they stay the
  // same. Create mode still always sends scopes.
  scopes?: string[];
  secrets: Record<string, string>;
  metadata?: Record<string, unknown>;
}

// An env-var token: uppercase ASCII, digits, and underscores, leading with a
// letter. Mirrors the server-side rule in createConnector. An api-key
// credential `name` IS its env var; each oauth2 row's env var name must match.
const ENV_TOKEN = /^[A-Z][A-Z0-9_]*$/;

type CredType = "api-key" | "oauth2";

// One oauth2 field: an env var the runtime materializes and the value to
// store for it. Every value is persisted encrypted (oauth2 credentials
// resolve entirely through the secret store via metadata.envMap), so there
// is no non-secret variant here. `purpose` is the secret-store key the value
// is stored under and the envMap purpose it binds to; when a template is
// applied it carries the provider's purpose (e.g. "client_id") so the created
// record matches the migration shape — otherwise it equals the env var name
// (identity map for a custom oauth2 credential).
interface OAuthRow {
  envVarName: string;
  value: string;
  purpose?: string;
}

export interface AddConnectorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (body: CreateConnectorBody) => void;
  pending?: boolean;
  providers: ProviderDescriptor[];
  // Pre-select a provider id (e.g. when opened next to a Linear-needs-setup
  // row on the Skills page). When omitted, the first registered provider
  // is selected.
  defaultProvider?: string;
  // Pre-fill the connector name. Useful for the auto-suggest case.
  defaultName?: string;
  // Lock the provider dropdown when the caller wants the dialog scoped to
  // a single provider — the Skills page rows pass this so the user can't
  // accidentally create a Linear connector from the "Set up Codex" button.
  lockProvider?: boolean;
  // "create" (default) opens an Add Connector dialog wired to POST. "rotate"
  // opens a Rotate Credential dialog with the same field UI but skips the
  // name/scopes inputs (we're not replacing those, just the secret) and
  // changes the title/button label so the user knows they're updating an
  // existing record. "request" is the in-chat Connect flow triggered by
  // an `action === "connector.request"` approval: same minimal UI as a
  // secret-only create, but the caller wires the submit to the
  // approval connect endpoint instead of the normal POST /api/connectors.
  // The caller still owns the actual API call via onSubmit.
  mode?: "create" | "rotate" | "request";
  // Create-mode framing overrides so a caller can title the type-driven
  // dialog after its entry point (e.g. the Integrations page's "Add MCP
  // server" action) instead of the generic "Add connector" framing. Rotate
  // and request modes render their own titles/copy and ignore `title`;
  // `description` replaces the selected provider's description, and
  // `namePlaceholder`/`secretPlaceholder` swap the api-key inputs' example
  // placeholders.
  title?: string;
  description?: string;
  namePlaceholder?: string;
  secretPlaceholder?: string;
  // Optional inline error string the caller can pass back when a probe
  // fails on the connect endpoint. Surfaces under the secret inputs so
  // the user can correct the token without the dialog closing.
  externalError?: string | null;
  // Templateless request fields (mode="request" only). When the
  // connector.request approval carries an api-key credentialType and no
  // registered provider, the card renders the type-driven minimal inputs
  // instead of a provider's fields: the credential name is pinned from the
  // trusted setup payload (read-only), and the user enters only the secret.
  // Templateless requests are api-key ONLY (oauth2 needs a provider module /
  // setup skill — see docs/adr/chat-credential-provisioning.md). See
  // BlockSetupRequested.
  requestCredentialName?: string;
  requestCredentialType?: "api-key";
  requestMcpUrl?: string;
  // Server-resolved name of the skill this credential is granted to (request
  // mode, when the connector.request carried a skillId). When present, the
  // dialog titles the action as granting the credential to that named skill so
  // the consent is accurate about which skill receives the grant.
  requestSkillName?: string;
}

// Render plain text with any http(s) URLs turned into links. Trailing
// sentence punctuation after a URL stays as text so a URL ending a
// sentence (".../api/.") doesn't pull the period into the link.
function linkify(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(https?:\/\/[^\s]+?)([.,;:!?)\]]*)(?=\s|$)/g;
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(
      <a
        key={key++}
        href={m[1]}
        target="_blank"
        rel="noreferrer"
        className="underline underline-offset-2 hover:text-foreground"
      >
        {m[1]}
      </a>
    );
    if (m[2]) out.push(m[2]);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function AddConnectorDialog({
  open,
  onOpenChange,
  onSubmit,
  pending = false,
  providers,
  defaultProvider,
  defaultName,
  lockProvider = false,
  mode = "create",
  title,
  description,
  namePlaceholder,
  secretPlaceholder,
  externalError = null,
  requestCredentialName,
  requestCredentialType,
  requestMcpUrl,
  requestSkillName
}: AddConnectorDialogProps) {
  // A templateless request carries an api-key credentialType and NO registered
  // provider (the connector.request approval had no `provider`). Detect it
  // FIRST, straight from the trusted props — independent of the provider list.
  // The earlier bug let `initialProvider` fall back to the first registered
  // provider (demo) whenever `defaultProvider` was empty, which made
  // `selectedProvider` truthy and the templateless branch unreachable, so the
  // api-key secret input never rendered. Detection now mirrors the server
  // (http.ts): credentialType present && no provider.
  const hasDefaultProvider = Boolean(defaultProvider && providers.some((p) => p.id === defaultProvider));
  const templatelessRequest = mode === "request" && requestCredentialType === "api-key" && !hasDefaultProvider;

  const initialProvider = useMemo(() => {
    if (hasDefaultProvider) return defaultProvider as string;
    // No default provider: a templateless request has no provider at all (leave
    // it empty so the templateless branch stays active). Other modes keep the
    // legacy first-provider fallback for the type-driven create / generic flows.
    if (templatelessRequest) return "";
    return providers[0]?.id ?? "demo";
  }, [defaultProvider, hasDefaultProvider, providers, templatelessRequest]);

  const [provider, setProvider] = useState(initialProvider);
  const [name, setName] = useState(defaultName ?? "");
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  // Type-driven create state. The credential `type` decides which inputs
  // render; the (optional) template picker above prefills them from a
  // provider module. `template === ""` means a plain, module-less credential.
  const [credType, setCredType] = useState<CredType>("api-key");
  const [template, setTemplate] = useState("");
  const [apiKeyName, setApiKeyName] = useState("");
  const [apiKeySecret, setApiKeySecret] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");
  // MCP server row name to register under (from a template's mcpServer.name).
  // Empty for plain api keys, where the row defaults to the credential name.
  const [mcpName, setMcpName] = useState("");
  const [oauthName, setOauthName] = useState("");
  const [oauthRows, setOauthRows] = useState<OAuthRow[]>([{ envVarName: "", value: "" }]);

  useEffect(() => {
    if (open) {
      setProvider(initialProvider);
      setName(defaultName ?? "");
      setFieldValues({});
      setError(null);
      // A templateless request seeds the type-driven inputs from the trusted
      // setup payload: the credential name is pinned (read-only), the type
      // decides which inputs render, and an api-key MCP URL is carried through
      // read-only. Otherwise fall back to the create-mode defaults.
      setCredType(requestCredentialType ?? "api-key");
      setTemplate("");
      setApiKeyName(requestCredentialName ?? defaultName ?? "");
      setApiKeySecret("");
      setMcpUrl(requestMcpUrl ?? "");
      setMcpName("");
      setOauthName(requestCredentialName ?? defaultName ?? "");
      setOauthRows([{ envVarName: "", value: "" }]);
    }
  }, [open, initialProvider, defaultName, requestCredentialName, requestCredentialType, requestMcpUrl]);

  const selectedProvider = providers.find((p) => p.id === provider);

  // Pick a provider module as a template: stamp the credential type, name, and
  // (api-key) MCP URL / (oauth2) env-var rows from its declared bindings, and
  // carry the provider id forward so the record keeps its probe + MCP module.
  // "" clears back to a plain, module-less credential (provider "generic").
  function applyTemplate(templateId: string) {
    setTemplate(templateId);
    setError(null);
    if (!templateId) {
      setProvider("generic");
      return;
    }
    const picked = providers.find((p) => p.id === templateId);
    const tmpl = picked?.credentialTemplate;
    setProvider(templateId);
    if (!tmpl) return;
    setCredType(tmpl.type);
    if (tmpl.type === "api-key") {
      setApiKeyName(tmpl.name);
      setMcpUrl(tmpl.mcpUrl ?? "");
      setMcpName(tmpl.mcpName ?? "");
    } else {
      setOauthName(tmpl.name);
      // Seed one row per template envMap entry, KEEPING the provider's purpose
      // key (e.g. client_id → GOOGLE_WORKSPACE_CLI_CLIENT_ID). Submit stores
      // each value under its purpose and persists the template's envMap so a
      // fresh UI-created credential matches the migration / bundled-skill shape
      // (bindingsForCredentials reads each purpose's secret by env var).
      const envMap = tmpl.envMap ?? {};
      const rows = Object.entries(envMap).map(([purpose, envVarName]) => ({ envVarName, value: "", purpose }));
      setOauthRows(rows.length > 0 ? rows : [{ envVarName: "", value: "" }]);
    }
  }

  // Providers worth offering as templates: those whose module declares a
  // credential template (linear, google-oauth-desktop). Presence-only and
  // generic providers carry none, so they'd add noise to the picker.
  const templateProviders = providers.filter((p) => p.credentialTemplate);

  // "request" mode (in-chat Connect button) is always minimal: it surfaces
  // just the provider's secret fields, because the approval payload already
  // pins the provider and there is no use case for connecting `generic` via
  // this path. "rotate" reuses the same provider-fields UI (replace secrets
  // only). "create" no longer uses this — it renders the type-driven UI.
  const minimal = mode === "request";

  // Type-driven create submit (api-key / oauth2). Builds the create input
  // createConnector expects: api-key → name == env var, one secret under
  // that key, optional `metadata.mcp`; oauth2 → handle name, one secret per
  // row keyed by its env var, `metadata.envMap` (identity purpose → ENV).
  const submitCreate = () => {
    setError(null);
    if (credType === "api-key") {
      const envName = apiKeyName.trim();
      if (!envName) {
        setError("Credential name is required.");
        return;
      }
      if (!ENV_TOKEN.test(envName)) {
        setError("Credential name must be an env var: uppercase letters, digits, underscores (e.g. LINEAR_API_KEY).");
        return;
      }
      if (!apiKeySecret.trim()) {
        setError("Secret value is required.");
        return;
      }
      const url = mcpUrl.trim();
      const rowName = mcpName.trim();
      onSubmit({
        provider: template || "generic",
        name: envName,
        type: "api-key",
        secrets: { [envName]: apiKeySecret.trim() },
        metadata: url
          ? {
              mcp: {
                url,
                ...(rowName ? { name: rowName } : {}),
                headerName: "Authorization",
                scheme: "Bearer"
              }
            }
          : {}
      });
      return;
    }

    // oauth2
    const handle = oauthName.trim();
    if (!handle) {
      setError("Credential name is required.");
      return;
    }
    const rows = oauthRows.filter((r) => r.envVarName.trim().length > 0);
    if (rows.length === 0) {
      setError("OAuth2 credentials need at least one field.");
      return;
    }
    const secrets: Record<string, string> = {};
    const envMap: Record<string, string> = {};
    for (const row of rows) {
      const envName = row.envVarName.trim();
      if (!ENV_TOKEN.test(envName)) {
        setError(`Invalid env var name "${envName}": uppercase letters, digits, underscores (e.g. GOOGLE_WORKSPACE_CLI_CLIENT_ID).`);
        return;
      }
      if (!row.value.trim()) {
        setError(`Value for ${envName} is required.`);
        return;
      }
      // The secret-store key (purpose) is the template's provider purpose when
      // a template was applied (e.g. "client_id"), else the env var name itself
      // (identity map for a custom oauth2 credential). envMap binds purpose →
      // ENV; bindingsForCredentials resolves each ENV from its purpose's secret.
      const purpose = row.purpose?.trim() || envName;
      secrets[purpose] = row.value.trim();
      envMap[purpose] = envName;
    }
    onSubmit({
      provider: template || "generic",
      name: handle,
      type: "oauth2",
      secrets,
      metadata: { envMap }
    });
  };

  // Templateless request submit (mode="request", no registered provider).
  // api-key ONLY (oauth2 needs a provider module / setup skill). The credential
  // name is pinned by the trusted setup payload, so the user supplies only the
  // secret; /complete derives name/type/metadata from that payload. The api-key
  // name IS its env var, so there is no envMap to send.
  const submitTemplatelessRequest = () => {
    setError(null);
    const credName = (requestCredentialName ?? "").trim();
    if (!apiKeySecret.trim()) {
      setError("Secret value is required.");
      return;
    }
    onSubmit({
      provider: "generic",
      name: credName,
      type: "api-key",
      secrets: { [credName]: apiKeySecret.trim() }
    });
  };

  const submit = () => {
    if (mode === "create") {
      submitCreate();
      return;
    }
    if (templatelessRequest) {
      submitTemplatelessRequest();
      return;
    }
    setError(null);
    if (!selectedProvider) {
      setError(`Provider ${provider} is not registered.`);
      return;
    }
    const secrets: Record<string, string> = {};
    const metadataFields: Record<string, string> = {};

    for (const field of selectedProvider.fields) {
      const raw = fieldValues[field.name] ?? "";
      // In rotate mode the user is replacing secrets only; non-secret
      // metadata fields keep their stored values, so don't block the
      // submission on them being empty.
      const requiredHere = field.required && (mode !== "rotate" || field.secret);
      if (requiredHere && !raw.trim()) {
        setError(`${field.label} is required.`);
        return;
      }
      if (!raw.trim()) continue;
      if (field.secret) secrets[field.name] = raw.trim();
      else metadataFields[field.name] = raw.trim();
    }

    if (mode === "rotate" && Object.keys(secrets).length === 0) {
      setError("Provide at least one new secret value to rotate.");
      return;
    }

    // In rotate mode the dialog hides the scopes input and the description
    // promises name and scopes stay the same. Sending an empty `scopes`
    // array would have updateConnector treat it as a full replacement and
    // wipe the stored scopes. Omit the field entirely on rotate so only
    // the new secrets land. In minimal request mode, default name to the
    // provider label and skip scopes entirely (secret encodes scope).
    const resolvedName =
      mode === "rotate"
        ? (defaultName ?? name).trim()
        : (name.trim() || selectedProvider.label);
    onSubmit({
      provider,
      name: resolvedName,
      secrets,
      metadata: Object.keys(metadataFields).length > 0 ? { fields: metadataFields } : undefined
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={mode === "request" ? "sm:max-w-md" : undefined}>
        <DialogHeader>
          <DialogTitle>
            {mode === "rotate"
              ? `Rotate ${defaultName ?? "credential"}`
              : mode === "request"
                // When the request resolved a skill name server-side, title the
                // action as granting the credential to THAT skill so the
                // consent reflects which skill receives the grant.
                ? requestSkillName
                  ? `Grant ${selectedProvider?.label ?? requestCredentialName ?? "credential"} to ${requestSkillName}`
                  : `Connect ${selectedProvider?.label ?? requestCredentialName ?? "credential"}`
                : (title ?? "Add connector")}
          </DialogTitle>
          <DialogDescription>
            {mode === "rotate"
              ? "Replace the stored secret(s). The connector record, name, and scopes stay the same."
              : templatelessRequest
                ? "Enter the secret below. It is stored encrypted server-side and never shown to the agent."
                : linkify(description ?? selectedProvider?.description ?? "Connect a new external system.")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {mode === "create" ? (
            <>
              <div className="space-y-1">
                <Label htmlFor="credential-type">Credential type</Label>
                <Select value={credType} onValueChange={(v) => { setCredType(v as CredType); setError(null); }}>
                  <SelectTrigger id="credential-type"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="api-key">API key</SelectItem>
                    <SelectItem value="oauth2">OAuth2</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {templateProviders.length > 0 ? (
                <div className="space-y-1">
                  <Label htmlFor="credential-template">Template (optional)</Label>
                  <Select value={template || "__none"} onValueChange={(v) => applyTemplate(v === "__none" ? "" : v)} disabled={lockProvider}>
                    <SelectTrigger id="credential-template"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none">None / custom</SelectItem>
                      {templateProviders.map((p) => (
                        <SelectItem key={p.id} value={p.id}>{p.label} ({p.id})</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-[11px] text-muted-foreground">
                    Prefill the name and shape from a known provider, or leave on custom for a plain key.
                  </p>
                </div>
              ) : null}

              {credType === "api-key" ? (
                <>
                  <div className="space-y-1">
                    <Label htmlFor="apikey-name">Credential name (used as the env var)</Label>
                    <Input
                      id="apikey-name"
                      value={apiKeyName}
                      onChange={(e) => { setApiKeyName(e.target.value); setError(null); }}
                      placeholder={namePlaceholder ?? "LINEAR_API_KEY"}
                      autoComplete="off"
                    />
                    {apiKeyName.trim() && !ENV_TOKEN.test(apiKeyName.trim()) ? (
                      <p className="text-[11px] text-destructive">
                        Must be an env var: uppercase letters, digits, underscores (e.g. LINEAR_API_KEY).
                      </p>
                    ) : (
                      <p className="text-[11px] text-muted-foreground">Skills reference this credential by this name.</p>
                    )}
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="apikey-secret">Secret value</Label>
                    <Input
                      id="apikey-secret"
                      type="password"
                      value={apiKeySecret}
                      onChange={(e) => setApiKeySecret(e.target.value)}
                      placeholder={secretPlaceholder ?? "lin_api_…"}
                      autoComplete="off"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="apikey-mcp">MCP server URL (optional)</Label>
                    <Input
                      id="apikey-mcp"
                      value={mcpUrl}
                      onChange={(e) => setMcpUrl(e.target.value)}
                      placeholder="https://mcp.example.com/mcp"
                      autoComplete="off"
                    />
                    <p className="text-[11px] text-muted-foreground">
                      Registers an MCP server with header Authorization: Bearer ${"{"}{apiKeyName.trim() || "ENV"}{"}"}.
                    </p>
                  </div>
                </>
              ) : (
                <>
                  <div className="space-y-1">
                    <Label htmlFor="oauth-name">Credential name</Label>
                    <Input
                      id="oauth-name"
                      value={oauthName}
                      onChange={(e) => { setOauthName(e.target.value); setError(null); }}
                      placeholder="google-workspace-oauth"
                      autoComplete="off"
                    />
                    <p className="text-[11px] text-muted-foreground">A handle skills reference by name (kebab-case is fine).</p>
                  </div>
                  <OAuthFieldEditor rows={oauthRows} onChange={(next) => { setOauthRows(next); setError(null); }} />
                </>
              )}
            </>
          ) : templatelessRequest ? (
            // Templateless request (api-key only): the credential name is pinned
            // by the trusted setup payload (read-only) — the user enters only the
            // secret. Mirrors create mode's api-key inputs, minus the name field.
            <>
              <div className="space-y-1">
                <Label htmlFor="request-apikey-name">Credential name (used as the env var)</Label>
                <Input id="request-apikey-name" value={apiKeyName} readOnly disabled autoComplete="off" />
                <p className="text-[11px] text-muted-foreground">Skills reference this credential by this name.</p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="request-apikey-secret">Secret value</Label>
                <Input
                  id="request-apikey-secret"
                  type="password"
                  value={apiKeySecret}
                  onChange={(e) => { setApiKeySecret(e.target.value); setError(null); }}
                  placeholder="paste the key"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  data-1p-ignore="true"
                  data-lpignore="true"
                  data-form-type="other"
                />
              </div>
              {requestMcpUrl ? (
                <div className="space-y-1">
                  <Label htmlFor="request-apikey-mcp">MCP server URL</Label>
                  <Input id="request-apikey-mcp" value={mcpUrl} readOnly disabled autoComplete="off" />
                  <p className="text-[11px] text-muted-foreground">
                    Registers an MCP server with header Authorization: Bearer ${"{"}{apiKeyName.trim() || "ENV"}{"}"}.
                  </p>
                </div>
              ) : null}
            </>
          ) : (
            selectedProvider?.fields.map((field) => (
              <div key={field.name} className="space-y-1">
                <Label htmlFor={`connector-${field.name}`}>{field.label}{field.required ? " *" : ""}</Label>
                <Input
                  id={`connector-${field.name}`}
                  type={field.secret ? "password" : "text"}
                  value={fieldValues[field.name] ?? ""}
                  onChange={(e) => setFieldValues((prev) => ({ ...prev, [field.name]: e.target.value }))}
                  placeholder={field.placeholder}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  data-1p-ignore="true"
                  data-lpignore="true"
                  data-form-type="other"
                  className={field.secret ? "font-mono" : undefined}
                />
                {field.description ? (
                  <p className="text-[11px] text-muted-foreground">{field.description}</p>
                ) : null}
              </div>
            ))
          )}

          {selectedProvider?.docsUrl ? (
            <p className="text-[11px] text-muted-foreground">
              Learn more at{" "}
              <DocReference url={selectedProvider.docsUrl}>
                <button
                  type="button"
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  {selectedProvider.docsUrl.replace(/^https?:\/\//, "")}
                </button>
              </DocReference>
            </p>
          ) : null}

          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          {externalError ? <p className="text-xs text-destructive">{externalError}</p> : null}
        </div>
        <DialogFooter className={mode === "request" ? "bg-transparent" : undefined}>
          <Button onClick={submit} disabled={pending}>
            {pending
              ? mode === "rotate"
                ? "Saving…"
                : minimal
                  ? "Connecting…"
                  : "Adding…"
              : mode === "rotate"
                ? "Save"
                : minimal
                  ? "Connect"
                  : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Dynamic env-var rows for an oauth2 credential. Each row maps an env var
// name (the runtime materializes it via metadata.envMap) to its value; the
// value is always stored encrypted. Mirrors the field-list pattern the
// generic editor used, with an env-var-name column.
function OAuthFieldEditor({
  rows,
  onChange
}: {
  rows: OAuthRow[];
  onChange: (next: OAuthRow[]) => void;
}) {
  function update(index: number, patch: Partial<OAuthRow>) {
    onChange(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }
  function add() {
    onChange([...rows, { envVarName: "", value: "" }]);
  }
  function remove(index: number) {
    onChange(rows.filter((_, i) => i !== index));
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>Fields</Label>
        <Button type="button" size="sm" variant="outline" onClick={add}>Add field</Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Each row is an env var the skill expects. Values are stored encrypted.
      </p>
      {rows.map((row, index) => (
        <div key={index} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2 rounded-md border border-border p-2">
          <Input
            placeholder="ENV_VAR_NAME"
            value={row.envVarName}
            onChange={(e) => update(index, { envVarName: e.target.value })}
            autoComplete="off"
          />
          <Input
            placeholder="value"
            type="password"
            value={row.value}
            onChange={(e) => update(index, { value: e.target.value })}
            autoComplete="off"
          />
          <Button type="button" size="sm" variant="ghost" className="text-destructive" onClick={() => remove(index)}>
            ×
          </Button>
        </div>
      ))}
    </div>
  );
}

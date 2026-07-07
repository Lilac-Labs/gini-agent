"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader, EmptyState } from "@/components/PageHeader";
import { MarkdownContent } from "@/components/chat/MarkdownContent";
import { api } from "@/lib/api";
import { useConnectors, useGoogleAccounts, useInvalidate, useProviders, useSkills, type ProviderDescriptor } from "@/lib/queries";
import { AddConnectorDialog, type CreateConnectorBody } from "@/components/AddConnectorDialog";
import { ManualCredentialDialog } from "@/components/ManualCredentialDialog";
import { GoogleAccountsCard } from "./_components/GoogleAccountsCard";
import { deriveActivation, type Activation } from "./_activation";
import type { ChatSession } from "@/lib/view-types";
import type { ConnectorRecord, SkillRecord } from "@runtime/types";

type ReloadReport = {
  added: Array<{ id: string; name: string }>;
  updated: Array<{ id: string; name: string }>;
  skipped: Array<{ path: string; reason: string }>;
};

type DetectionReport = {
  considered: number;
  created: Array<{ id: string; provider: string; name: string }>;
  skipped: Array<{ provider: string; reason: string }>;
};

// Per-row state for the inline Add Connector dialog. The Skills page renders
// one dialog at a time; pendingProvider holds the provider id so the modal
// opens pre-scoped to the row the user clicked from. mode toggles between
// creating a new connector ("create") and rotating the secret on an existing
// one ("rotate"); rotate carries the connectorId so submit can PATCH it.
interface InlineDialogState {
  open: boolean;
  provider: string;
  suggestedName: string;
  mode: "create" | "rotate";
  connectorId?: string;
}

export default function SkillsPage() {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const skills = useSkills(debounced);
  const connectors = useConnectors();
  const providers = useProviders();
  // Machine-global registry — exists even with no google-oauth-desktop
  // connector record, so the accounts card can render on a registry-only
  // machine where the connectors enrichment has nothing to attach to.
  const googleAccounts = useGoogleAccounts();
  const invalidate = useInvalidate();
  const [dialog, setDialog] = useState<InlineDialogState>({ open: false, provider: "", suggestedName: "", mode: "create" });
  const [manualProvider, setManualProvider] = useState<ProviderDescriptor | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search), 200);
    return () => clearTimeout(timer);
  }, [search]);

  const action = useMutation({
    mutationFn: ({ id, op }: { id: string; op: "test" | "enable" | "disable" | "rollback" }) =>
      api<SkillRecord>(`/skills/${encodeURIComponent(id)}/${op}`, { method: "POST" }),
    onSuccess: (_, vars) => {
      toast.success(`${vars.op}: ${vars.id}`);
      invalidate(["skills", "state"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const validate = useMutation({
    mutationFn: () => api<{ ok: boolean; results: Array<{ id: string; name: string; ok: boolean; issues: string[] }> }>("/skills/validate"),
    onSuccess: (result) => {
      const failing = result.results.filter((r) => !r.ok).length;
      toast.success(failing === 0 ? `All ${result.results.length} skills validated.` : `${failing} of ${result.results.length} skills have issues.`);
      invalidate(["skills"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const reload = useMutation({
    mutationFn: () => api<ReloadReport>("/skills/reload", { method: "POST" }),
    onSuccess: (result) => {
      const added = result.added.length;
      const updated = result.updated.length;
      const skipped = result.skipped.length;
      toast.success(`Reload: +${added} new · ~${updated} updated${skipped ? ` · ${skipped} skipped` : ""}`);
      invalidate(["skills"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const detect = useMutation({
    mutationFn: () => api<DetectionReport>("/connectors/detect", { method: "POST" }),
    onSuccess: (result) => {
      const created = result.created.length;
      toast.success(created === 0 ? "Detection ran — no new connectors." : `Detected ${created} connector${created === 1 ? "" : "s"}.`);
      invalidate(["connectors", "skills", "events"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const create = useMutation({
    mutationFn: (body: CreateConnectorBody) =>
      api<ConnectorRecord>("/connectors", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: async (created) => {
      toast.success(`Added ${created.name}`);
      invalidate(["connectors", "events", "skills"]);
      // Best-effort initial probe — same pattern the old Connectors page
      // used so the row flips to healthy without waiting on the periodic
      // re-probe. Failures land on the connector record itself.
      await api(`/connectors/${created.id}/health`, { method: "POST" }).catch(() => undefined);
      invalidate(["connectors", "skills"]);
      setDialog({ open: false, provider: "", suggestedName: "", mode: "create" });
      setManualProvider(null);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const rotate = useMutation({
    mutationFn: ({ id, body }: { id: string; body: CreateConnectorBody }) =>
      api<ConnectorRecord>(`/connectors/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: async (updated) => {
      toast.success(`Rotated ${updated.name}`);
      invalidate(["connectors", "events", "skills"]);
      // Re-probe immediately so the row flips back to healthy without
      // waiting on the periodic re-probe — same pattern as the create path.
      await api(`/connectors/${updated.id}/health`, { method: "POST" }).catch(() => undefined);
      invalidate(["connectors", "skills"]);
      setDialog({ open: false, provider: "", suggestedName: "", mode: "create" });
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const disconnect = useMutation({
    mutationFn: (id: string) => api<{ id: string; tombstoned?: boolean }>(`/connectors/${id}`, { method: "DELETE" }),
    onSuccess: (result) => {
      toast.success(result.tombstoned ? "Disconnected (kept as tombstone)" : "Connector removed");
      invalidate(["connectors", "events", "skills"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  // "Set up via chat" for a credential with NO registered provider module.
  // There is no Add Connector dialog to open at such a credential (no fields,
  // no probe), so the canonical path is agent-driven: the seed message names
  // the specific credential + skill so the agent inspects requires.credentials
  // and issues request_connector for it (which mints the secure in-chat card).
  // Steers the user to that flow instead of the dead-end "not supported" note.
  const setupCredentialViaChat = useMutation({
    mutationFn: async (args: { skill: SkillRecord; credentialName: string }) => {
      const session = await api<ChatSession>("/chat", {
        method: "POST",
        body: JSON.stringify({ title: `Set up ${args.credentialName}` })
      });
      await api(`/chat/${session.id}/messages`, {
        method: "POST",
        body: JSON.stringify({
          content: `The ${args.skill.name} skill needs the ${args.credentialName} credential, which has no provider module. Please request it from me so I can enter it securely.`,
          client: "web"
        })
      });
      return session;
    },
    onSuccess: (session) => {
      invalidate(["chat", "tasks"]);
      router.push(`/chat?session=${session.id}`);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const filtered = skills.data ?? [];
  const sorted = useMemo(
    () => filtered.slice().sort((a, b) => a.name.localeCompare(b.name)),
    [filtered]
  );
  const detail = filtered.find((s) => s.id === selected) ?? sorted[0];
  const byName = useMemo(
    () => connectorsByName(connectors.data ?? []),
    [connectors.data]
  );
  const providersById = useMemo(
    () => providersByIdMap(providers.data ?? []),
    [providers.data]
  );
  const providerByCredentialName = useMemo(
    () => providerByCredentialNameMap(providers.data ?? []),
    [providers.data]
  );

  return (
    <>
      <PageHeader
        title="Skills"
        description="Procedures the agent can use"
        actions={
          <>
            <Button size="sm" variant="outline" disabled={detect.isPending} onClick={() => detect.mutate()}>
              {detect.isPending ? "Detecting…" : "Refresh detection"}
            </Button>
            <Button size="sm" variant="outline" disabled={reload.isPending} onClick={() => reload.mutate()}>
              {reload.isPending ? "Reloading…" : "Reload from disk"}
            </Button>
            <Button size="sm" variant="outline" disabled={validate.isPending} onClick={() => validate.mutate()}>
              {validate.isPending ? "Validating…" : "Validate all"}
            </Button>
          </>
        }
      />
      <div className="flex flex-1 gap-4 overflow-hidden p-6">
        <div className="flex w-80 flex-col gap-3 overflow-hidden">
          <Input placeholder="Search skills…" value={search} onChange={(event) => setSearch(event.target.value)} />
          <div className="text-[11px] text-muted-foreground">
            {skills.isLoading ? "Loading…" : `${filtered.length} skill${filtered.length === 1 ? "" : "s"}`}
          </div>
          {filtered.length === 0 ? (
            <EmptyState
              title={debounced ? "No matches" : "No skills loaded"}
              description={debounced ? undefined : "Drop a SKILL.md under skills/ and click Reload from disk."}
            />
          ) : (
            <ul className="flex-1 space-y-2 overflow-auto pr-1">
              {sorted.map((skill) => (
                <li key={skill.id}>
                  <button
                    onClick={() => setSelected(skill.id)}
                    className={`w-full rounded-md border px-3 py-2 text-left transition-colors ${
                      detail?.id === skill.id ? "border-primary bg-accent" : "border-border bg-card hover:bg-accent/50"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="line-clamp-1 text-sm font-medium">{skill.name}</span>
                      <ActivationPill
                        activation={deriveActivation(skill, byName, providersById, providerByCredentialName)}
                      />
                    </div>
                    {skill.description ? (
                      <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">{skill.description}</p>
                    ) : null}
                    <span className="mt-1 block font-mono text-[10px] text-muted-foreground">
                      {skill.source ?? "user"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex-1 overflow-auto">
          {!detail ? (
            <EmptyState title="No skill selected" />
          ) : (
            <Card>
              <CardHeader>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <CardTitle className="text-base">{detail.name}</CardTitle>
                    {detail.trigger ? (
                      <CardDescription className="font-mono text-[11px]">
                        trigger “{detail.trigger}”
                      </CardDescription>
                    ) : null}
                  </div>
                  <ActivationPill
                    activation={deriveActivation(detail, byName, providersById, providerByCredentialName)}
                  />
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {detail.source ? (
                    <Badge variant="outline" className="font-mono text-[10px] uppercase">
                      {detail.source}
                    </Badge>
                  ) : null}
                  {detail.category ? (
                    <Badge variant="secondary" className="font-mono text-[10px]">
                      {detail.category}
                    </Badge>
                  ) : null}
                  {(detail.platforms ?? []).map((platform) => (
                    <Badge key={platform} variant="outline" className="font-mono text-[10px]">
                      {platform}
                    </Badge>
                  ))}
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {detail.description ? (
                  <p className="text-sm text-muted-foreground">{detail.description}</p>
                ) : null}
                {detail.compatibility ? (
                  <p className="text-xs text-muted-foreground">{detail.compatibility}</p>
                ) : null}
                <ActivationRow
                  skill={detail}
                  byName={byName}
                  providersById={providersById}
                  providerByCredentialName={providerByCredentialName}
                />
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" disabled={action.isPending} onClick={() => action.mutate({ id: detail.id, op: "test" })}>Test</Button>
                  {detail.status === "enabled" ? (
                    <Button size="sm" variant="outline" disabled={action.isPending} onClick={() => action.mutate({ id: detail.id, op: "disable" })}>Disable</Button>
                  ) : (
                    <Button size="sm" variant="outline" disabled={action.isPending} onClick={() => action.mutate({ id: detail.id, op: "enable" })}>Enable</Button>
                  )}
                  <Button size="sm" variant="outline" disabled={action.isPending || detail.previousVersions.length === 0} onClick={() => action.mutate({ id: detail.id, op: "rollback" })}>
                    Rollback
                  </Button>
                </div>
                {detail.allowedTools ? (
                  <Section title="Allowed tools (from SKILL.md frontmatter)">
                    <p className="font-mono text-[11px] text-muted-foreground">{detail.allowedTools}</p>
                  </Section>
                ) : null}
                {(detail.requiredCredentials ?? []).length > 0 ? (
                  <Section title="Required credentials">
                    <ul className="space-y-1">
                      {(detail.requiredCredentials ?? []).map((credentialName) => {
                        // Connectors carrying this credential NAME. The provider
                        // for setup guidance comes from a matching record, else
                        // the canonical provider for the name (so a credential
                        // with no connector yet still routes to its setup flow).
                        const matches = (connectors.data ?? []).filter(
                          (c) => c.name === credentialName && c.status === "configured"
                        );
                        const provider =
                          providersById.get(matches[0]?.provider ?? "") ??
                          providerByCredentialName.get(credentialName);
                        const hasProbe = Boolean(provider?.hasProbe);
                        // Mirror the runtime gate: a connector counts as
                        // satisfying the requirement when it is healthy, OR
                        // when its provider has no probe and the record is
                        // configured (we have no failing signal). See
                        // src/integrations/connectors/index.ts isSkillActive.
                        const satisfying = matches.find(
                          (c) => c.health === "healthy" || (!hasProbe && c.health === "unknown" && c.status === "configured")
                        );
                        const dependentCount = countDependentSkills(filtered, credentialName);
                        return (
                          <li key={credentialName} className="space-y-2 text-xs">
                            <div className="flex items-center justify-between gap-2">
                            <span className="font-mono">
                              {credentialName}
                            </span>
                            {satisfying ? (
                              <div className="flex items-center gap-1.5">
                                <Badge variant="outline" className="text-[10px] text-emerald-600">
                                  {satisfying.health === "healthy" ? "healthy" : "configured"} ({satisfying.name})
                                </Badge>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-6 px-2 text-[10px]"
                                  disabled={disconnect.isPending}
                                  onClick={() => {
                                    const message = `Disconnect ${satisfying.name}?\nThis will deactivate ${dependentCount} dependent skill${dependentCount === 1 ? "" : "s"}.`;
                                    if (confirm(message)) disconnect.mutate(satisfying.id);
                                  }}
                                >
                                  Disconnect
                                </Button>
                              </div>
                            ) : !provider ? (
                              // No registered provider module for this
                              // credential name, so there's no Add Connector
                              // dialog to open at it. The canonical path is
                              // agent-driven request_connector, so hand off to
                              // chat with a seed that names this credential
                              // rather than dead-ending.
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-6 px-2 text-[10px]"
                                disabled={setupCredentialViaChat.isPending}
                                onClick={() => setupCredentialViaChat.mutate({ skill: detail, credentialName })}
                              >
                                {setupCredentialViaChat.isPending ? "Opening chat…" : "Set up via chat"}
                              </Button>
                            ) : matches.length > 0 ? (
                              // Matching connector(s) exist but none satisfy
                              // (typically: unhealthy creds). Render the
                              // first one inline with Rotate + Disconnect so
                              // the user can fix it without leaving the
                              // page. We deliberately do NOT show "Set up"
                              // here to avoid creating a second connector
                              // for the same provider.
                              (() => {
                                const broken = matches[0]!;
                                const label = broken.health === "unhealthy" ? "unhealthy" : broken.health;
                                return (
                                  <div className="flex flex-col items-end gap-1">
                                    <div className="flex items-center gap-1.5">
                                      <Badge variant="outline" className="text-[10px] text-amber-600">
                                        {label} ({broken.name})
                                      </Badge>
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        className="h-6 px-2 text-[10px]"
                                        disabled={rotate.isPending}
                                        onClick={() =>
                                          setDialog({
                                            open: true,
                                            provider: broken.provider,
                                            suggestedName: broken.name,
                                            mode: "rotate",
                                            connectorId: broken.id
                                          })
                                        }
                                      >
                                        Rotate
                                      </Button>
                                      <Button
                                        size="sm"
                                        variant="ghost"
                                        className="h-6 px-2 text-[10px]"
                                        disabled={disconnect.isPending}
                                        onClick={() => {
                                          const message = `Disconnect ${broken.name}?\nThis will deactivate ${dependentCount} dependent skill${dependentCount === 1 ? "" : "s"}.`;
                                          if (confirm(message)) disconnect.mutate(broken.id);
                                        }}
                                      >
                                        Disconnect
                                      </Button>
                                    </div>
                                    {broken.message ? (
                                      <p className="text-[10px] text-muted-foreground">{broken.message}</p>
                                    ) : null}
                                  </div>
                                );
                              })()
                            ) : provider.externallySatisfied ? (
                              // The credential is satisfied out-of-band with no
                              // connector record — in hosted the guest ships
                              // with its Google Workspace credential already in
                              // place (baked by the host, registered at boot),
                              // so there's nothing for the user to set up. Show
                              // it as provisioned rather than offering a setup
                              // affordance the hosted product doesn't need.
                              <Badge variant="outline" className="text-[10px] text-emerald-600">
                                provisioned
                              </Badge>
                            ) : (
                              // Simple secret-only providers (e.g. linear
                              // PAT). Original credential dialog works
                              // fine — user pastes one token and submits.
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-6 px-2 text-[10px]"
                                onClick={() =>
                                  setDialog({
                                    open: true,
                                    provider: provider.id,
                                    suggestedName: provider.label,
                                    mode: "create"
                                  })
                                }
                              >
                                Set up {provider.label}
                              </Button>
                            )}
                            </div>
                            {/* Tagged Google accounts. With a configured
                                connector they ride its `accounts`
                                enrichment; on a registry-only machine (no
                                record) they come from the machine-global
                                registry query. Surface them so the user can
                                retag / remove / add another. */}
                            {provider?.id === "google-oauth-desktop" &&
                            (satisfying || (googleAccounts.data ?? []).length > 0) ? (
                              <GoogleAccountsCard
                                accounts={satisfying?.accounts ?? googleAccounts.data ?? []}
                              />
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  </Section>
                ) : null}

                <Tabs defaultValue={detail.body ? "content" : "overview"}>
                  <TabsList>
                    <TabsTrigger value="content">Content</TabsTrigger>
                    <TabsTrigger value="overview">Overview</TabsTrigger>
                  </TabsList>

                  <TabsContent value="content">
                    {detail.body ? (
                      <div className="rounded-md border border-border bg-card/50 p-4">
                        <MarkdownContent text={detail.body} />
                      </div>
                    ) : (
                      <EmptyState
                        title="No body content"
                        description="This skill was created via the API and has no markdown body."
                      />
                    )}
                  </TabsContent>

                  <TabsContent value="overview" className="space-y-4">
                    {detail.steps.length > 0 ? (
                      <Section title="Steps">
                        <ol className="list-decimal space-y-1 pl-5 text-sm">
                          {detail.steps.map((step, index) => <li key={index}>{step}</li>)}
                        </ol>
                      </Section>
                    ) : null}

                    {detail.tests.length > 0 ? (
                      <Section title="Tests">
                        <ul className="list-disc space-y-1 pl-5 text-sm">
                          {detail.tests.map((test, index) => <li key={index}>{test}</li>)}
                        </ul>
                      </Section>
                    ) : null}

                    {detail.requiredTools.length > 0 ? (
                      <Section title="Required tools">
                        <div className="flex flex-wrap gap-1.5">
                          {detail.requiredTools.map((tool) => (
                            <Badge key={tool} variant="outline" className="font-mono text-[10px]">
                              {tool}
                            </Badge>
                          ))}
                        </div>
                      </Section>
                    ) : null}

                    {detail.requiredPermissions.length > 0 ? (
                      <Section title="Required permissions">
                        <div className="flex flex-wrap gap-1.5">
                          {detail.requiredPermissions.map((perm) => (
                            <Badge key={perm} variant="outline" className="font-mono text-[10px]">
                              {perm}
                            </Badge>
                          ))}
                        </div>
                      </Section>
                    ) : null}

                    {detail.prerequisites && (
                      (detail.prerequisites.commands?.length || detail.prerequisites.env?.length)
                    ) ? (
                      <Section title="Prerequisites">
                        {detail.prerequisites.commands?.length ? (
                          <div className="space-y-1">
                            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Commands</div>
                            <div className="flex flex-wrap gap-1.5">
                              {detail.prerequisites.commands.map((cmd) => (
                                <Badge key={cmd} variant="outline" className="font-mono text-[10px]">
                                  {cmd}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        ) : null}
                        {detail.prerequisites.env?.length ? (
                          <div className="space-y-1">
                            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Env</div>
                            <div className="flex flex-wrap gap-1.5">
                              {detail.prerequisites.env.map((env) => (
                                <Badge key={env} variant="outline" className="font-mono text-[10px]">
                                  {env}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        ) : null}
                      </Section>
                    ) : null}

                    <Section title="Stats">
                      <p className="font-mono text-[11px] text-muted-foreground">
                        ✓ {detail.successCount} · ✕ {detail.failureCount}
                        {detail.lastUsedAt ? ` · last used ${new Date(detail.lastUsedAt).toLocaleString()}` : ""}
                        {detail.sourceTaskId ? ` · source task ${detail.sourceTaskId}` : ""}
                      </p>
                    </Section>

                    {detail.manifestPath ? (
                      <Section title="Manifest path">
                        <p className="break-all font-mono text-[11px] text-muted-foreground">{detail.manifestPath}</p>
                      </Section>
                    ) : null}

                    {detail.previousVersions.length > 0 ? (
                      <Section title="History">
                        <pre className="overflow-auto rounded-md border border-border bg-card/50 p-3 font-mono text-[11px]">
                          {JSON.stringify(detail.previousVersions, null, 2)}
                        </pre>
                      </Section>
                    ) : null}
                  </TabsContent>
                </Tabs>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <AddConnectorDialog
        open={dialog.open}
        onOpenChange={(open) =>
          setDialog((prev) => (open ? prev : { open: false, provider: "", suggestedName: "", mode: "create" }))
        }
        onSubmit={(body) =>
          dialog.mode === "rotate" && dialog.connectorId
            ? rotate.mutate({ id: dialog.connectorId, body })
            : create.mutate(body)
        }
        pending={dialog.mode === "rotate" ? rotate.isPending : create.isPending}
        providers={providers.data ?? []}
        defaultProvider={dialog.provider || undefined}
        defaultName={dialog.suggestedName}
        lockProvider
        mode={dialog.mode}
      />

      <ManualCredentialDialog
        open={manualProvider !== null}
        onOpenChange={(open) => { if (!open) setManualProvider(null); }}
        provider={manualProvider}
        onSubmit={(body) => create.mutate(body)}
        pending={create.isPending}
      />
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h4>
      {children}
    </div>
  );
}

function ActivationPill({ activation }: { activation: Activation }) {
  const tone = activation.tone === "ok"
    ? "bg-emerald-500/10 text-emerald-600"
    : activation.tone === "warn"
    ? "bg-amber-500/10 text-amber-600"
    : activation.tone === "danger"
    ? "bg-red-500/10 text-red-600"
    : "bg-muted text-muted-foreground";
  return (
    <span className={`rounded px-2 py-0.5 text-[10px] font-medium ${tone}`}>{activation.label}</span>
  );
}

function ActivationRow({
  skill,
  byName,
  providersById,
  providerByCredentialName
}: {
  skill: SkillRecord;
  byName: Map<string, ConnectorRecord[]>;
  providersById: Map<string, ProviderDescriptor>;
  providerByCredentialName: Map<string, ProviderDescriptor>;
}) {
  const activation = deriveActivation(skill, byName, providersById, providerByCredentialName);
  return (
    <div className="flex items-center gap-2 text-xs">
      <ActivationPill activation={activation} />
      {skill.validationStatus === "unsupported" && skill.validationMessage ? (
        <span className="text-[11px] text-muted-foreground">{skill.validationMessage}</span>
      ) : null}
    </div>
  );
}

// Index connectors by their credential NAME (skills reference credentials by
// name). Multiple records can share a name only transiently (e.g. a tombstoned
// + a fresh one); the list preserves them so the activation check can pick the
// usable one.
function connectorsByName(connectors: ConnectorRecord[]): Map<string, ConnectorRecord[]> {
  const map = new Map<string, ConnectorRecord[]>();
  for (const c of connectors) {
    const list = map.get(c.name) ?? [];
    list.push(c);
    map.set(c.name, list);
  }
  return map;
}

function providersByIdMap(providers: ProviderDescriptor[]): Map<string, ProviderDescriptor> {
  const map = new Map<string, ProviderDescriptor>();
  for (const p of providers) map.set(p.id, p);
  return map;
}

// Reverse of the provider credential template: credential NAME → the provider
// whose template owns it (linear → LINEAR_API_KEY, google-oauth-desktop →
// google-workspace-oauth). Lets the page route a required credential name to
// its provider — and, for the hosted Google credential, read its
// `externallySatisfied` bit — even before any connector record exists. Mirrors
// providerForCredentialName in connectors/registry.ts.
function providerByCredentialNameMap(providers: ProviderDescriptor[]): Map<string, ProviderDescriptor> {
  const map = new Map<string, ProviderDescriptor>();
  for (const p of providers) {
    const name = p.credentialTemplate?.name;
    if (name && !map.has(name)) map.set(name, p);
  }
  return map;
}

function countDependentSkills(skills: SkillRecord[], credentialName: string): number {
  let count = 0;
  for (const skill of skills) {
    const required = skill.requiredCredentials ?? [];
    if (required.includes(credentialName)) count += 1;
  }
  return count;
}

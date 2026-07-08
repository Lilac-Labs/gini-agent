"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
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
import { useConnectors, useInvalidate, useProviders, useSkills, type ProviderDescriptor } from "@/lib/queries";
import { deriveActivation, type Activation } from "./_activation";
import type { ChatSession } from "@/lib/view-types";
import type { ConnectorRecord, SkillRecord } from "@runtime/types";

type ReloadReport = {
  added: Array<{ id: string; name: string }>;
  updated: Array<{ id: string; name: string }>;
  skipped: Array<{ path: string; reason: string }>;
};

export default function SkillsPage() {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const skills = useSkills(debounced);
  const connectors = useConnectors();
  const providers = useProviders();
  const invalidate = useInvalidate();

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
                                <ManageInIntegrationsLink />
                              </div>
                            ) : !provider ? (
                              // No registered provider module for this
                              // credential name, so the Integrations page has
                              // no tile for it. The canonical path is
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
                              // (typically: unhealthy creds). Surface the
                              // first one's state; rotate/disconnect live on
                              // the Integrations page now.
                              (() => {
                                const broken = matches[0]!;
                                const label = broken.health === "unhealthy" ? "unhealthy" : broken.health;
                                return (
                                  <div className="flex flex-col items-end gap-1">
                                    <div className="flex items-center gap-1.5">
                                      <Badge variant="outline" className="text-[10px] text-amber-600">
                                        {label} ({broken.name})
                                      </Badge>
                                      <ManageInIntegrationsLink />
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
                              // it as provisioned; account management (retag /
                              // add / remove) lives on the Integrations page.
                              <div className="flex items-center gap-1.5">
                                <Badge variant="outline" className="text-[10px] text-emerald-600">
                                  provisioned
                                </Badge>
                                <ManageInIntegrationsLink />
                              </div>
                            ) : (
                              // A registered provider exists for this
                              // credential — its connect flow lives on the
                              // Integrations page.
                              <ManageInIntegrationsLink />
                            )}
                            </div>
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
    </>
  );
}

// Connector management (connect, rotate, disconnect, Google accounts) lives on
// the Integrations page; credential rows here link to it instead of embedding
// the dialogs.
function ManageInIntegrationsLink() {
  return (
    <Button asChild size="sm" variant="outline" className="h-6 px-2 text-[10px]">
      <Link href="/integrations">Manage in Integrations</Link>
    </Button>
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

"use client";

// People directory: the contacts the assistant has researched from the
// user's mail (the CRM extraction pipeline, ADR
// people-crm-extraction-pipeline.md), rendered per the "Gini people" design —
// a sortable/filterable table plus a slide-in dossier panel. Data comes from
// the profile-less /crm/contacts list; the multi-KB dossier is fetched per
// selection.
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpDown, Building2, ListFilter, Maximize2, UserRoundPlus, X } from "lucide-react";
import type { CrmContactDetail, CrmContactSummary } from "@runtime/capabilities/crm-contacts";
import type { CrmExtractionStatus } from "@runtime/jobs/crm-extractor";
import type { ChatSession } from "@/lib/view-types";
import { api } from "@/lib/api";
import { MarkdownContent } from "@/components/chat/MarkdownContent";
import { EmptyState } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  CATEGORY_ITEMS,
  SORT_ITEMS,
  filterContacts,
  fullName,
  initials,
  relativeTime,
  roleLine,
  sortContacts,
  type PeopleCategory,
  type PeopleSort,
} from "./_lib";

const ROW_GRID = "grid-cols-[minmax(220px,1.1fr)_minmax(190px,0.9fr)_minmax(260px,1.6fr)_92px]";

function inviteMailto(contact?: CrmContactSummary): string {
  const subject = encodeURIComponent("Join me on Gini");
  const bodyText = encodeURIComponent(
    "Hey — I've been using Gini, a personal assistant that actually gets work done. Come try it: https://ginicomputer.com",
  );
  return `mailto:${contact?.email ?? ""}?subject=${subject}&body=${bodyText}`;
}

function Avatar({ contact, size = 34 }: { contact: CrmContactSummary; size?: number }) {
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-full font-semibold ${
        contact.isSelf ? "bg-[#6366F1] text-white" : "bg-secondary text-muted-foreground"
      }`}
      style={{ width: size, height: size, fontSize: size >= 44 ? 14 : 11.5 }}
    >
      {initials(contact)}
    </span>
  );
}

const EMPTY_DRAFT = { firstName: "", lastName: "", email: "", company: "", position: "", category: "", description: "" };

export default function PeoplePage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sort, setSort] = useState<PeopleSort>("name");
  const [category, setCategory] = useState<PeopleCategory>("all");
  const [panelWide, setPanelWide] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [draft, setDraft] = useState(EMPTY_DRAFT);

  const contacts = useQuery<{ contacts: CrmContactSummary[] }>({
    queryKey: ["crm-contacts"],
    queryFn: () => api<{ contacts: CrmContactSummary[] }>("/crm/contacts"),
    refetchInterval: 60_000,
  });
  const extraction = useQuery<CrmExtractionStatus>({
    queryKey: ["crm-extraction"],
    queryFn: () => api<CrmExtractionStatus>("/crm/extraction"),
    refetchInterval: 60_000,
  });
  const detail = useQuery<CrmContactDetail>({
    queryKey: ["crm-contact", selectedId],
    queryFn: () => api<CrmContactDetail>(`/crm/contacts/${selectedId}`),
    enabled: selectedId !== null,
  });

  const createContact = useMutation({
    mutationFn: () =>
      api<CrmContactDetail>("/crm/contacts", { method: "POST", body: JSON.stringify(draft) }),
    onSuccess: (created) => {
      setCreateOpen(false);
      setDraft(EMPTY_DRAFT);
      void queryClient.invalidateQueries({ queryKey: ["crm-contacts"] });
      setSelectedId(created.id);
    },
  });

  // "Update with Gini": hand the person to the assistant in a fresh chat —
  // research refresh is agent work, not a form.
  const updateWithGini = useMutation({
    mutationFn: async (contact: CrmContactSummary) => {
      const session = await api<ChatSession>("/chat", { method: "POST", body: JSON.stringify({}) });
      await api(`/chat/${session.id}/messages`, {
        method: "POST",
        body: JSON.stringify({
          content: `Refresh your research on ${fullName(contact)}${contact.email ? ` (${contact.email})` : ""} in my people CRM: re-check our recent threads and their public info, then update the dossier, description, category, and last_spoke_at as warranted.`,
        }),
      });
      return session.id;
    },
    onSuccess: (sessionId) => router.push(`/chat?session=${encodeURIComponent(sessionId)}`),
  });

  const rows = useMemo(
    () => sortContacts(filterContacts(contacts.data?.contacts ?? [], category), sort),
    [contacts.data, category, sort],
  );
  const selected = rows.find((c) => c.id === selectedId) ?? contacts.data?.contacts.find((c) => c.id === selectedId) ?? null;
  const status = extraction.data;
  const processed = status ? status.counts.done + status.counts.skipped + status.counts.error : 0;

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Main column */}
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[1100px] px-10 pb-24 pt-9">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <h1 className="text-2xl font-bold tracking-tight">People</h1>
                <p className="mt-2 max-w-[640px] text-sm text-muted-foreground">
                  Your assistant builds a working profile of the people you interact with, drawn from
                  your conversations and background research. It updates periodically — if anything
                  needs correcting, just ask.
                </p>
              </div>
              <Button variant="outline" asChild>
                <a href={inviteMailto()}>Invite to&nbsp;Gini</a>
              </Button>
              <Button onClick={() => setCreateOpen(true)}>
                <UserRoundPlus className="size-4" />
                Create contact
              </Button>
            </div>

            {/* Toolbar */}
            <div className="mt-6 flex items-center justify-between">
              <div className="flex items-center gap-3.5">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button className="flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-[13px] font-medium hover:bg-muted">
                      {SORT_ITEMS.find((s) => s.id === sort)!.label}
                      <ArrowUpDown className="size-3 text-muted-foreground" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuLabel className="text-[11.5px] text-muted-foreground">Sort</DropdownMenuLabel>
                    {SORT_ITEMS.map((s) => (
                      <DropdownMenuItem key={s.id} onSelect={() => setSort(s.id)}>
                        <span className="inline-flex w-3.5 justify-center">
                          {sort === s.id ? <span className="size-[5px] self-center rounded-full bg-current" /> : null}
                        </span>
                        {s.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
                {status ? (
                  <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span
                      className={`size-[7px] rounded-full ${status.runState === "running" ? "bg-emerald-500" : "bg-muted-foreground/50"}`}
                    />
                    {status.lastActivityAt ? `Updated ${relativeTime(status.lastActivityAt, Date.now())}` : `Extraction ${status.runState}`}
                    {processed > 0 ? ` · ${processed.toLocaleString()} threads processed` : ""}
                  </span>
                ) : null}
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    title="Filter"
                    className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <ListFilter className="size-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[190px]">
                  <DropdownMenuLabel className="text-[11.5px] text-muted-foreground">Category</DropdownMenuLabel>
                  {CATEGORY_ITEMS.map((c) => (
                    <DropdownMenuItem key={c.id} onSelect={() => setCategory(c.id)}>
                      <span className="flex-1">{c.label}</span>
                      {category === c.id ? <span className="size-[5px] rounded-full bg-current" /> : null}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            {/* Table */}
            <div className="mt-2.5 overflow-hidden rounded-xl border border-border bg-card">
              <div className={`grid ${ROW_GRID} gap-4 px-4 py-2.5 text-[12.5px] font-medium text-muted-foreground`}>
                <span>Name</span>
                <span>Contact</span>
                <span>Description</span>
                <span className="justify-self-end">Status</span>
              </div>
              {contacts.isLoading ? (
                <div className="border-t border-border px-4 py-8 text-center text-sm text-muted-foreground">Loading…</div>
              ) : rows.length === 0 ? (
                <div className="border-t border-border p-6">
                  <EmptyState
                    title="No people yet"
                    description="Connect a Google account and the assistant will build your directory from your mail."
                  />
                </div>
              ) : (
                rows.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => setSelectedId(c.id)}
                    className={`grid ${ROW_GRID} w-full items-center gap-4 border-t border-border px-4 py-3 text-left transition-colors hover:bg-muted ${
                      c.id === selectedId ? "bg-muted" : ""
                    }`}
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <Avatar contact={c} />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold">{fullName(c)}</span>
                        {c.company ? (
                          <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                            <Building2 className="size-3 shrink-0" />
                            <span className="truncate">{c.company}</span>
                          </span>
                        ) : null}
                      </span>
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] text-muted-foreground">{c.email ?? "—"}</span>
                      <span className="mt-px block text-[13px] text-muted-foreground">{c.phone ?? "—"}</span>
                    </span>
                    <span className="text-[13px] leading-[1.45]">{c.description ?? ""}</span>
                    {c.isSelf || !c.email ? (
                      <span className="justify-self-end text-[13px] text-muted-foreground">{c.isSelf ? "you" : "—"}</span>
                    ) : (
                      <a
                        href={inviteMailto(c)}
                        onClick={(event) => event.stopPropagation()}
                        className="inline-flex h-[30px] items-center justify-center justify-self-end rounded-lg border border-input bg-card px-3.5 text-[13px] font-medium hover:bg-muted"
                      >
                        Invite
                      </a>
                    )}
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Detail panel */}
      {selected ? (
        <aside className={`flex h-full ${panelWide ? "w-[560px]" : "w-[380px]"} shrink-0 flex-col border-l border-border bg-card`}>
          <div className="flex items-center gap-1.5 px-3.5 pb-2.5 pt-3.5">
            <span className="flex-1 text-[13.5px] font-semibold">People</span>
            <button
              title="Expand"
              onClick={() => setPanelWide((w) => !w)}
              className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Maximize2 className="size-3.5" />
            </button>
            <button
              title="Close"
              onClick={() => setSelectedId(null)}
              className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-1.5">
            <div className="flex items-start gap-3.5">
              <Avatar contact={selected} size={44} />
              <div className="min-w-0 flex-1 pt-0.5">
                <div className="text-base font-bold tracking-tight">{fullName(selected)}</div>
                <div className="mt-1 text-xs leading-[1.45] text-muted-foreground">{roleLine(selected)}</div>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-[76px_1fr] gap-x-3.5 gap-y-1.5 text-[13px]">
              <span className="text-muted-foreground">Email</span>
              <span className="truncate">{selected.email ?? "Unknown"}</span>
              <span className="text-muted-foreground">Category</span>
              <span>{selected.category ?? "—"}</span>
              <span className="text-muted-foreground">Company</span>
              <span className="truncate">{selected.company ?? "Unknown"}</span>
              <span className="text-muted-foreground">Last spoke</span>
              <span>{selected.isSelf ? "—" : relativeTime(selected.lastSpokeAt, Date.now())}</span>
            </div>
            <div className="my-5 h-px bg-border" />
            {detail.isLoading ? (
              <div className="text-sm text-muted-foreground">Loading profile…</div>
            ) : detail.data?.profile ? (
              <MarkdownContent text={detail.data.profile} dropForeignImages />
            ) : (
              <div className="text-sm text-muted-foreground">
                No researched profile yet — the assistant writes one as it encounters this person.
              </div>
            )}
          </div>
          <div className="flex flex-col gap-2 border-t border-border px-4 py-3.5">
            <Button
              variant="outline"
              className="w-full"
              disabled={updateWithGini.isPending}
              onClick={() => updateWithGini.mutate(selected)}
            >
              {updateWithGini.isPending ? "Opening chat…" : "Update with Gini"}
            </Button>
            {!selected.isSelf && selected.email ? (
              <Button variant="outline" className="w-full" asChild>
                <a href={inviteMailto(selected)}>Invite to&nbsp;Gini</a>
              </Button>
            ) : null}
          </div>
        </aside>
      ) : null}

      {/* Create contact */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create contact</DialogTitle>
            <DialogDescription>
              Add someone by hand — the assistant researches and fills in the rest over time.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cc-first">First name</Label>
              <Input id="cc-first" value={draft.firstName} onChange={(e) => setDraft({ ...draft, firstName: e.target.value })} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cc-last">Last name</Label>
              <Input id="cc-last" value={draft.lastName} onChange={(e) => setDraft({ ...draft, lastName: e.target.value })} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cc-email">Email</Label>
              <Input id="cc-email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cc-company">Company</Label>
              <Input id="cc-company" value={draft.company} onChange={(e) => setDraft({ ...draft, company: e.target.value })} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cc-position">Position</Label>
              <Input id="cc-position" value={draft.position} onChange={(e) => setDraft({ ...draft, position: e.target.value })} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cc-category">Category</Label>
              <select
                id="cc-category"
                value={draft.category}
                onChange={(e) => setDraft({ ...draft, category: e.target.value })}
                className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
              >
                <option value="">—</option>
                <option value="Work">Work</option>
                <option value="Personal">Personal</option>
              </select>
            </div>
            <div className="col-span-2 flex flex-col gap-1.5">
              <Label htmlFor="cc-desc">Description</Label>
              <Input
                id="cc-desc"
                placeholder="Who they are at a glance"
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              />
            </div>
          </div>
          {createContact.isError ? (
            <p className="text-sm text-destructive">{(createContact.error as Error).message}</p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button disabled={createContact.isPending || draft.firstName.trim() === ""} onClick={() => createContact.mutate()}>
              {createContact.isPending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

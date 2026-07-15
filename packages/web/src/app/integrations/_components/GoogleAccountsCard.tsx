"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  CalendarIcon,
  CheckIcon,
  CircleIcon,
  FileTextIcon,
  HardDriveIcon,
  ListChecksIcon,
  MailIcon,
  PencilIcon,
  PlusIcon,
  RotateCwIcon,
  TableIcon,
  VideoIcon,
  XIcon,
  type LucideIcon
} from "lucide-react";
import type { GoogleAccountStatus } from "@runtime/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle
} from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { useGoogleAuthMode, useInvalidate } from "@/lib/queries";
import { connectGoogleUrl, primaryAccountId, reloginPrimaryUrl } from "@/app/onboarding/_components/lib";

// The multi-color Google "G" mark, shared by the account rows here and the
// Integrations page's Google drilldown header.
export function GoogleLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden>
      <path fill="#4285F4" d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z" />
      <path fill="#34A853" d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z" />
      <path fill="#FBBC05" d="M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z" />
      <path fill="#EA4335" d="M24 9.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 3.18 29.93 1 24 1 15.4 1 7.96 5.93 4.34 13.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z" />
    </svg>
  );
}

// Display metadata for the per-service grant keys `gws auth status` reports
// (GoogleAccountStatus.services). Rows render only for services the account
// actually has granted — never fabricated. Unknown keys fall back to the raw
// key with a generic icon.
const SERVICE_META: Record<string, { label: string; description: string; icon: LucideIcon }> = {
  gmail: { label: "Gmail", description: "Read, search, and send email", icon: MailIcon },
  calendar: { label: "Google Calendar", description: "View and manage events", icon: CalendarIcon },
  drive: { label: "Google Drive", description: "Browse and manage files", icon: HardDriveIcon },
  docs: { label: "Google Docs", description: "Read and edit documents", icon: FileTextIcon },
  sheets: { label: "Google Sheets", description: "Read and edit spreadsheets", icon: TableIcon },
  forms: { label: "Google Forms", description: "Create and read forms", icon: ListChecksIcon },
  meet: { label: "Google Meet", description: "Schedule and join meetings", icon: VideoIcon }
};

// The tagged Google accounts attached to this instance (including the
// boot-registered hosted primary account), rendered as one card per account —
// email + tag badge, connected date, sign-in status, granted-service rows —
// with retag / disconnect / add-another flows. "Add account" navigates
// straight into the same-tab browser OAuth round trip onboarding uses
// (connectGoogleUrl) — this page owns Google OAuth, so it never routes
// through chat (the agent's request_google_account CTA points back HERE).
export function GoogleAccountsCard({ accounts }: { accounts: GoogleAccountStatus[] }) {
  const invalidate = useInvalidate();
  // Which auth mode shapes the connect/reconnect URLs (edge → full sign-in
  // flow, loopback → gateway PKCE start), and which row is the primary. The
  // PRIMARY row's revoked state heals through reloginPrimaryUrl (signin intent
  // re-persists the primary); a non-primary revoked row heals through the add
  // flow, which identity-matches the existing registry row by email and
  // rewrites its credential in place.
  const authMode = useGoogleAuthMode();
  const mode = authMode.data?.mode;
  const primaryId = primaryAccountId(accounts);
  // Account whose tag is being edited inline. Null when no row is in edit mode.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTag, setDraftTag] = useState("");
  // Account pending disconnect confirmation. Null when the dialog is closed.
  const [removing, setRemoving] = useState<GoogleAccountStatus | null>(null);

  const retag = useMutation({
    mutationFn: ({ id, tag }: { id: string; tag: string }) =>
      api<GoogleAccountStatus>(`/google/accounts/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ tag })
      }),
    onSuccess: (account) => {
      toast.success(`Retagged to ${account.tag}`);
      setEditingId(null);
      invalidate(["connectors", "connector-providers", "google-accounts"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const remove = useMutation({
    mutationFn: (id: string) => api<{ id: string }>(`/google/accounts/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Account removed");
      setRemoving(null);
      // "connector-providers" carries the externallySatisfied bit derived
      // from this registry, so the activation pills refresh immediately.
      invalidate(["connectors", "connector-providers", "google-accounts"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const useAccount = useMutation({
    mutationFn: (id: string) => api<GoogleAccountStatus>(`/google/accounts/${id}/use`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Google account selected");
      invalidate(["connectors", "connector-providers", "google-accounts"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const signOut = useMutation({
    mutationFn: () => api<{ ok: true }>("/google/session/signout", { method: "POST" }),
    onSuccess: () => {
      toast.success("Signed out of this instance");
      invalidate(["connectors", "connector-providers", "google-accounts"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const startEdit = (account: GoogleAccountStatus) => {
    setEditingId(account.id);
    setDraftTag(account.tag);
  };

  const saveEdit = (id: string) => {
    const tag = draftTag.trim();
    if (!tag) return;
    retag.mutate({ id, tag });
  };

  return (
    <div className="flex flex-col gap-3">
      {accounts.length === 0 ? (
        <p className="text-sm text-muted-foreground">No accounts connected yet.</p>
      ) : (
        accounts.map((account) => {
          const granted = Object.entries(account.services)
            .filter(([, ok]) => ok)
            .map(([name]) => name);
          // The primary row, once revoked, heals only through the full sign-in
          // flow — show a dedicated Reconnect button. Gated on the resolved
          // auth mode so the click can never target the wrong URL.
          const canReloginPrimary =
            account.id === primaryId && !account.signedIn && account.tokenRevoked === true && Boolean(mode);
          // A non-primary revoked row heals through the ADD flow: the user
          // re-authorizes the same account, and provisionTarget matches the
          // existing registry row by email and rewrites its credential in
          // place — no duplicate row, no primary flip. Same auth-mode gate.
          const canReconnectNonPrimary =
            account.id !== primaryId && !account.signedIn && account.tokenRevoked === true && Boolean(mode);
          return (
            <div key={account.id} className="overflow-hidden rounded-xl border border-border bg-card">
              <div className="flex items-center gap-3.5 px-5 py-4">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full border border-border bg-white">
                  <GoogleLogo className="size-5" />
                </span>
                <div className="min-w-0 flex-1">
                  {editingId === account.id ? (
                    <div className="flex items-center gap-1.5">
                      <Input
                        autoFocus
                        value={draftTag}
                        onChange={(event) => setDraftTag(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") saveEdit(account.id);
                          if (event.key === "Escape") setEditingId(null);
                        }}
                        className="h-6 max-w-48 text-xs"
                      />
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-6"
                        aria-label="Save tag"
                        disabled={retag.isPending || !draftTag.trim()}
                        onClick={() => saveEdit(account.id)}
                      >
                        <CheckIcon className="size-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-6"
                        aria-label="Cancel"
                        disabled={retag.isPending}
                        onClick={() => setEditingId(null)}
                      >
                        <XIcon className="size-3.5" />
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[15px] font-bold">
                        {account.email || "(sign-in pending)"}
                      </span>
                      <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
                        {account.tag}
                      </span>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-6 shrink-0"
                        aria-label={`Retag ${account.tag}`}
                        onClick={() => startEdit(account)}
                      >
                        <PencilIcon className="size-3 text-muted-foreground" />
                      </Button>
                    </div>
                  )}
                  <p className="mt-0.5 truncate text-[12.5px] text-muted-foreground">
                    Connected {new Date(account.addedAt).toLocaleDateString()}
                  </p>
                </div>
                {editingId === account.id ? null : (
                  <div className="flex shrink-0 items-center gap-2.5">
                    {account.signedIn ? (
                      <span className="flex items-center gap-1.5 text-[13px] font-semibold text-emerald-600">
                        <CheckIcon className="size-[15px]" />
                        Connected
                      </span>
                    ) : (
                      <span className="text-[13px] font-semibold text-amber-600">
                        {account.tokenRevoked === true ? "Reconnect needed" : "Sign-in expired"}
                      </span>
                    )}
                    {canReloginPrimary && mode ? (
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={`Reconnect ${account.tag}`}
                        onClick={() =>
                          window.location.assign(
                            reloginPrimaryUrl(mode, "/integrations?view=google", window.location.origin)
                          )
                        }
                      >
                        <RotateCwIcon className="size-3" />
                        Reconnect
                      </Button>
                    ) : null}
                    {canReconnectNonPrimary && mode ? (
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={`Reconnect ${account.tag}`}
                        onClick={() =>
                          window.location.assign(
                            connectGoogleUrl(mode, "/integrations?view=google", window.location.origin)
                          )
                        }
                      >
                        <RotateCwIcon className="size-3" />
                        Reconnect
                      </Button>
                    ) : null}
                    {account.id === primaryId ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={signOut.isPending}
                        onClick={() => signOut.mutate()}
                      >
                        {signOut.isPending ? "Signing out..." : "Sign out of this instance"}
                      </Button>
                    ) : account.signedIn ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={useAccount.isPending}
                        onClick={() => useAccount.mutate(account.id)}
                      >
                        Make primary
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label={`Disconnect ${account.tag}`}
                      onClick={() => setRemoving(account)}
                    >
                      Disconnect
                    </Button>
                  </div>
                )}
              </div>
              {granted.map((name) => {
                const meta = SERVICE_META[name] ?? { label: name, description: "", icon: CircleIcon };
                const Icon = meta.icon;
                return (
                  <div key={name} className="flex items-center gap-3.5 border-t border-border px-5 py-3.5">
                    <span className="flex size-[34px] shrink-0 items-center justify-center rounded-[9px] border border-border bg-white">
                      <Icon className="size-[17px] text-muted-foreground" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold">{meta.label}</div>
                      {meta.description ? (
                        <div className="text-[12.5px] text-muted-foreground">{meta.description}</div>
                      ) : null}
                    </div>
                    <span className="flex items-center gap-1.5 text-[13px] font-semibold text-emerald-600">
                      <CheckIcon className="size-3.5" />
                      Enabled
                    </span>
                  </div>
                );
              })}
            </div>
          );
        })
      )}

      <Button
        variant="outline"
        size="sm"
        className="self-start"
        disabled={!mode}
        onClick={() =>
          mode && window.location.assign(connectGoogleUrl(mode, "/integrations?view=google", window.location.origin))
        }
      >
        <PlusIcon className="size-3.5" />
        Add account
      </Button>

      <Dialog
        open={Boolean(removing)}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) setRemoving(null);
        }}
      >
        <DialogContent className="gap-5 border-border bg-card p-7 sm:max-w-md">
          <DialogTitle className="text-base font-bold text-foreground">
            Disconnect {removing?.tag ?? "account"}?
          </DialogTitle>
          <DialogDescription className="text-[13px] text-muted-foreground">
            This signs the account out and removes it from the registry. You can reconnect it from chat anytime.
          </DialogDescription>
          <div className="flex items-center justify-end gap-2.5 border-t border-border pt-4">
            <Button type="button" variant="outline" onClick={() => setRemoving(null)} disabled={remove.isPending}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => removing && remove.mutate(removing.id)}
              disabled={!removing || remove.isPending}
            >
              {remove.isPending ? "Disconnecting…" : "Disconnect"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

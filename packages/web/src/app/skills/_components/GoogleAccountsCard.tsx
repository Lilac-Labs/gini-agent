"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { CheckIcon, PencilIcon, PlusIcon, RotateCwIcon, Trash2Icon, XIcon } from "lucide-react";
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
import { primaryAccountId, reloginPrimaryUrl } from "@/app/onboarding/_components/lib";
import type { ChatSession } from "@/lib/view-types";

// The tagged Google accounts surfaced on the google-oauth-desktop connector
// (GET /api/connectors attaches `accounts`) plus the boot-registered hosted
// primary account. Lets the user retag / remove an account, or add another.
// Connecting an additional account runs a browser OAuth flow the agent drives,
// so "Add account" hands the user off to a fresh chat with a seed message
// rather than attempting OAuth from the page.
export function GoogleAccountsCard({ accounts }: { accounts: GoogleAccountStatus[] }) {
  const router = useRouter();
  const invalidate = useInvalidate();
  // Which auth mode shapes the reconnect URL (edge → full sign-in flow, loopback
  // → gateway PKCE start), and which row is the primary. Only the PRIMARY row's
  // revoked state heals through reloginPrimaryUrl; non-primary revoked rows keep
  // the add/reconnect-via-chat affordance.
  const authMode = useGoogleAuthMode();
  const mode = authMode.data?.mode;
  const primaryId = primaryAccountId(accounts);
  // Account whose tag is being edited inline. Null when no row is in edit mode.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTag, setDraftTag] = useState("");
  // Account pending remove confirmation. Null when the dialog is closed.
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

  // Mirrors the Skills page "Set up via chat" mechanism: POST a session, send a
  // seed message, then navigate to it so the agent drives the OAuth flow.
  const addViaChat = useMutation({
    mutationFn: async () => {
      const session = await api<ChatSession>("/chat", {
        method: "POST",
        body: JSON.stringify({ title: "Connect Google account" })
      });
      await api(`/chat/${session.id}/messages`, {
        method: "POST",
        body: JSON.stringify({ content: "Connect another Google account.", client: "web" })
      });
      return session;
    },
    onSuccess: (session) => {
      invalidate(["chat", "tasks"]);
      router.push(`/chat?session=${session.id}`);
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
    <div className="mt-3 space-y-2 rounded-md border border-border bg-card/50 p-3">
      <div className="flex items-center justify-between gap-2">
        <h5 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Connected accounts
        </h5>
        <Button
          size="sm"
          variant="outline"
          className="h-6 px-2 text-[10px]"
          disabled={addViaChat.isPending}
          onClick={() => addViaChat.mutate()}
        >
          <PlusIcon className="size-3" />
          {addViaChat.isPending ? "Opening chat…" : "Add account"}
        </Button>
      </div>

      {accounts.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">No accounts connected yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {accounts.map((account) => {
            const granted = Object.entries(account.services)
              .filter(([, ok]) => ok)
              .map(([name]) => name);
            // The primary row, once revoked, heals only through the full sign-in
            // flow — show a dedicated Reconnect button. Gated on the resolved
            // auth mode so the click can never target the wrong URL.
            const canReloginPrimary =
              account.id === primaryId && !account.signedIn && account.tokenRevoked === true && Boolean(mode);
            return (
              <li
                key={account.id}
                className="flex items-center justify-between gap-2 rounded-md border border-border bg-background px-2.5 py-1.5"
              >
                <div className="min-w-0 flex-1 space-y-0.5">
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
                        className="h-6 text-xs"
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
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium">{account.tag}</span>
                      <span
                        className={`size-2 shrink-0 rounded-full ${account.signedIn ? "bg-emerald-400" : "bg-amber-400"}`}
                        aria-hidden
                      />
                      <span className={`text-[10px] ${account.signedIn ? "text-emerald-600" : "text-amber-600"}`}>
                        {account.signedIn
                          ? "Signed in"
                          : account.tokenRevoked === true
                            ? "Reconnect needed"
                            : "Sign-in expired"}
                      </span>
                    </div>
                  )}
                  <p className="truncate text-[11px] text-muted-foreground">
                    {account.email || "(sign-in pending)"}
                  </p>
                  {granted.length > 0 ? (
                    <p className="truncate text-[10px] text-muted-foreground">{granted.join(" · ")}</p>
                  ) : null}
                </div>
                {editingId === account.id ? null : (
                  <div className="flex items-center gap-1">
                    {canReloginPrimary && mode ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 gap-1 px-2 text-[10px]"
                        aria-label={`Reconnect ${account.tag}`}
                        onClick={() =>
                          window.location.assign(reloginPrimaryUrl(mode, "/skills", window.location.origin))
                        }
                      >
                        <RotateCwIcon className="size-3" />
                        Reconnect
                      </Button>
                    ) : null}
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7"
                      aria-label={`Retag ${account.tag}`}
                      onClick={() => startEdit(account)}
                    >
                      <PencilIcon className="size-3.5 text-muted-foreground" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7"
                      aria-label={`Remove ${account.tag}`}
                      onClick={() => setRemoving(account)}
                    >
                      <Trash2Icon className="size-3.5 text-muted-foreground" />
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <Dialog
        open={Boolean(removing)}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) setRemoving(null);
        }}
      >
        <DialogContent className="gap-5 border-border bg-card p-7 sm:max-w-md">
          <DialogTitle className="text-base font-bold text-foreground">
            Remove {removing?.tag ?? "account"}?
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
              {remove.isPending ? "Removing…" : "Remove"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

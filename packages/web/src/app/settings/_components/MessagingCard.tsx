"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, X } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/PageHeader";
import { StatusPill } from "@/components/StatusPill";
import { SlackConnectDialog } from "@/components/SlackConnectDialog";
import { api } from "@/lib/api";
import { useInvalidate } from "@/lib/queries";
import type { ChatAllowlistView } from "@runtime/integrations/messaging";
import type { MessagingBridgeRecord } from "@runtime/types";

export interface MessagingRow { id: string; name: string; status: string; kind: string }

// Telegram / Discord share the multi-kind create dialog below; Slack has its own
// focused SlackConnectDialog (two credentials, no delivery targets).
type AddBridgeKind = "telegram" | "discord";

export function MessagingCard({
  bridges,
  healthPending,
  removePending,
  onHealth,
  onRemove
}: {
  bridges: MessagingRow[];
  healthPending: boolean;
  removePending: boolean;
  onHealth: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-sm">Messaging bridges</CardTitle>
            <CardDescription>{bridges.length} configured</CardDescription>
          </div>
          <AddMessagingBridgeButtons />
        </div>
      </CardHeader>
      <CardContent>
        {bridges.length === 0 ? (
          <EmptyState title="No bridges — add a Telegram, Discord, or Slack bot above to get started." />
        ) : (
          <ul className="divide-y divide-border">
            {bridges.map((item) => (
              <li key={item.id} className="flex flex-col gap-2 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm">{item.name}</p>
                    <p className="font-mono text-[10px] text-muted-foreground">{item.kind}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusPill value={item.status} />
                    <Button size="sm" variant="outline" disabled={healthPending} onClick={() => onHealth(item.id)}>Health</Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={removePending}
                      onClick={() => {
                        // Hard-delete the bridge: drops the bridge row from
                        // state, deletes the encrypted bot-token secret, and
                        // leaves historical messages in place (the UI gates
                        // their rendering on bridge existence). The Remove
                        // button sits next to Health — a misclick would
                        // otherwise instantly destroy the bridge with no
                        // intervening signal. Match the same window.confirm
                        // pattern the skills page uses for connector disconnect.
                        if (window.confirm(`Remove ${item.name}?\nThis deletes the bridge and its bot token. Past messages stay in history.`)) {
                          onRemove(item.id);
                        }
                      }}
                    >
                      Remove
                    </Button>
                  </div>
                </div>
                {item.kind === "telegram" && item.status === "configured" ? (
                  <TelegramPendingRequests bridgeId={item.id} />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// Pending pairing requests for a Telegram bridge. Polls the bridge's chat
// allowlist every 3 s; each chat that messaged the bot but isn't yet on
// the allowlist surfaces here as an Approve/Reject row. The underlying
// state lives on the bridge as `metadata.recentDeniedChats`, populated by
// the Telegram poller every time a non-allowlisted update arrives.
function TelegramPendingRequests({ bridgeId }: { bridgeId: string }) {
  const invalidate = useInvalidate();
  const chats = useQuery({
    queryKey: ["messaging", bridgeId, "chats"],
    queryFn: () => api<ChatAllowlistView>(`/messaging/${encodeURIComponent(bridgeId)}/chats`),
    refetchInterval: 3_000
  });
  const approve = useMutation({
    // Forward the verification code the operator just confirmed
    // against alongside the chatId so the server can reject if the
    // pending entry's code rotated (race against the user re-DMing
    // after the previous code expired) or expired between when the
    // page rendered and when the button was clicked.
    mutationFn: ({ chatId, expectedCode }: { chatId: number; expectedCode?: string }) =>
      api(`/messaging/${encodeURIComponent(bridgeId)}/allow`, {
        method: "POST",
        body: JSON.stringify({ chatId, ...(expectedCode ? { expectedCode } : {}) })
      }),
    onSuccess: () => {
      toast.success("Chat approved");
      invalidate(["messaging", "state"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });
  const reject = useMutation({
    mutationFn: (chatId: number) =>
      api(`/messaging/${encodeURIComponent(bridgeId)}/reject-pending`, {
        method: "POST",
        body: JSON.stringify({ chatId })
      }),
    onSuccess: () => {
      toast.message("Request rejected");
      invalidate(["messaging"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const pending = chats.data?.recentDeniedChats ?? [];
  const allowedCount = chats.data?.allowedChatIds.length ?? 0;
  const busy = approve.isPending || reject.isPending;

  if (pending.length === 0) {
    // Quiet the idle "Listening…" indicator once at least one chat
    // is on the allowlist — the operator has confirmed they're done
    // onboarding and shouldn't have to look at a permanent hint band.
    // A new unrecognized chat that DMs the bot still mints a pending
    // row here; the row is what surfaces, not this empty state.
    if (allowedCount > 0) return null;
    return (
      <div className="mt-1 flex items-center gap-2 rounded-xl bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-sky-500" aria-hidden />
        <span className="text-sky-600 dark:text-sky-400 font-medium">
          Listening for new pairing requests…
        </span>
        <span>To add a sender, have them message your bot — their request will appear here.</span>
      </div>
    );
  }

  return (
    <ul className="mt-1 flex flex-col gap-2">
      {pending.map((entry) => (
        <li
          key={entry.chatId}
          className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-sky-500/30 bg-sky-500/5 px-3 py-2"
        >
          <div className="min-w-0">
            <p className="text-sm font-medium">
              Pairing request from {entry.sender ?? "unknown sender"}
            </p>
            <p className="font-mono text-[10px] text-muted-foreground">
              {entry.chatType} · chat {entry.chatId}
            </p>
            {entry.verificationCode ? (
              <p className="mt-1 text-[11px] text-muted-foreground">
                Code:{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">
                  {entry.verificationCode}
                </code>
                {entry.verificationCodeExpiresAt ? (
                  <span className="ml-2">
                    expires {new Date(entry.verificationCodeExpiresAt).toLocaleTimeString()}
                  </span>
                ) : null}
                <span className="ml-2">— confirm with the user before approving.</span>
              </p>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              className="h-7 rounded-full bg-sky-500 px-3 text-xs font-semibold text-white hover:bg-sky-600"
              disabled={busy}
              onClick={() => approve.mutate({ chatId: entry.chatId, expectedCode: entry.verificationCode })}
            >
              <Check className="mr-1 h-3.5 w-3.5" />
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 rounded-full px-3 text-xs"
              disabled={busy}
              onClick={() => reject.mutate(entry.chatId)}
            >
              <X className="mr-1 h-3.5 w-3.5" />
              Reject
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}

// "Add Telegram" / "Add Discord" buttons + the matching create dialog.
// Renders the same POST /api/messaging surface the CLI uses, so the
// browser is a peer of `gini messaging add` rather than a partial view.
// The bot token never leaves the dialog and is forwarded straight to
// the runtime, which encrypts it into the per-instance secret store
// before responding.
function AddMessagingBridgeButtons() {
  const invalidate = useInvalidate();
  const [open, setOpen] = useState(false);
  // The BYO Socket-Mode Slack create flow lives in the shared SlackConnectDialog
  // (its own open state) — the multi-kind dialog below only handles
  // Telegram / Discord.
  const [slackOpen, setSlackOpen] = useState(false);
  const [kind, setKind] = useState<AddBridgeKind>("telegram");
  const [name, setName] = useState("");
  const [botToken, setBotToken] = useState("");
  const [deliveryTargets, setDeliveryTargets] = useState("");
  const [result, setResult] = useState<MessagingBridgeRecord | null>(null);
  // The deferred close-reset runs 150ms after close() so the dialog's
  // exit animation reads stable state. Tracking the timer id lets us
  // cancel it when the user reopens the dialog within that window —
  // otherwise the late reset would clobber the freshly-set kind/name
  // in the new dialog session.
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Monotonic per-dialog-session counter. An in-flight create's
  // per-call onSuccess captures the value at submit time and only
  // promotes the response into `result` if the same session is still
  // active. close() and openFor() bump this so a POST that resolves
  // after the user closes or reopens the dialog can't pollute a
  // fresh session with a stale success view.
  const sessionRef = useRef(0);
  // Synchronous single-flight guard. The submit button's
  // disabled={add.isPending} relies on a state propagation that only
  // commits on the next React render. A same-frame double-click can
  // fire submit() twice before that render lands, so we need a ref
  // that flips synchronously to gate the second call.
  const submittingRef = useRef(false);

  const add = useMutation<MessagingBridgeRecord, Error, { name: string; kind: AddBridgeKind; botToken: string; deliveryTargets: string[] }>({
    mutationFn: (input) =>
      api<MessagingBridgeRecord>("/messaging", {
        method: "POST",
        body: JSON.stringify(input)
      }),
    onSuccess: (_record, variables) => {
      // Always fire — the bridge exists server-side regardless of
      // whether the user's dialog session is still open. The
      // mutate()-level onSuccess below handles routing the record
      // into the success view only when the session is still active.
      toast.success(`${labelFor(variables.kind)} bridge added.`);
      invalidate(["messaging", "events", "state"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const cancelResetTimer = () => {
    if (resetTimerRef.current) {
      clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
  };

  useEffect(() => () => cancelResetTimer(), []);

  const openFor = (next: AddBridgeKind) => {
    cancelResetTimer();
    sessionRef.current += 1;
    setKind(next);
    setName("");
    setBotToken("");
    setDeliveryTargets("");
    setResult(null);
    add.reset();
    setOpen(true);
  };

  const close = () => {
    setOpen(false);
    sessionRef.current += 1;
    cancelResetTimer();
    resetTimerRef.current = setTimeout(() => {
      resetTimerRef.current = null;
      setName("");
      setBotToken("");
      setDeliveryTargets("");
      setResult(null);
      add.reset();
    }, 150);
  };

  const submit = () => {
    if (submittingRef.current) return;
    const trimmedName = name.trim();
    const trimmedToken = botToken.trim();
    const parsedTargets = parseDeliveryTargets(deliveryTargets);
    if (!trimmedName) {
      toast.error("Name is required.");
      return;
    }
    if (!trimmedToken) {
      toast.error("Bot token is required.");
      return;
    }
    if (kind === "discord" && parsedTargets.length === 0) {
      toast.error("At least one Discord channel ID is required.");
      return;
    }
    submittingRef.current = true;
    const submittingSession = sessionRef.current;
    add.mutate(
      {
        name: trimmedName,
        kind,
        botToken: trimmedToken,
        deliveryTargets: parsedTargets
      },
      {
        onSuccess: (record) => {
          if (sessionRef.current !== submittingSession) return;
          // Drop the entered values from React state the moment the server
          // confirms the bridge was created. The token is already persisted
          // in the per-instance encrypted secret store and the name has
          // been echoed back on `record`, so the form state is redundant
          // by this point. Holding the token in component state until the
          // 150ms-after-close reset would leave it inspectable in React
          // DevTools or any future debug log/error overlay for the
          // duration of the summary view — bad hygiene for a credential.
          setName("");
          setBotToken("");
          setDeliveryTargets("");
          setResult(record);
        },
        onSettled: () => {
          submittingRef.current = false;
        }
      }
    );
  };

  const label = labelFor(kind);
  const tokenHint = kind === "telegram"
    ? "Open Telegram, chat with @BotFather, run /newbot, and paste the token below."
    : "Open the Discord Developer Portal, create an application, add a bot, and copy its token.";

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => openFor("telegram")}>
          Add Telegram
        </Button>
        <Button size="sm" variant="outline" onClick={() => openFor("discord")}>
          Add Discord
        </Button>
        <Button size="sm" variant="outline" onClick={() => setSlackOpen(true)}>
          Add Slack
        </Button>
      </div>
      <SlackConnectDialog open={slackOpen} onOpenChange={setSlackOpen} />
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (value) return;
          // Reject Esc / outside-click / X dismissals while the create
          // POST is in flight. The mutation has no AbortController and
          // the runtime does not enforce bridge name uniqueness, so a
          // dismiss-then-resubmit would mint two bridges with the same
          // name fighting over the same bot token. Cancel button is
          // already disabled by add.isPending below.
          //
          // Reading submittingRef.current alongside add.isPending
          // closes a same-frame race: between submit() flipping the
          // ref synchronously and React committing the next render,
          // this closure still reads add.isPending === false from the
          // prior render's lexical scope. The ref is updated
          // synchronously, so any later closure sees the new value.
          if (submittingRef.current || add.isPending) return;
          close();
        }}
      >
        <DialogContent
          showCloseButton={!add.isPending}
          onEscapeKeyDown={(event) => {
            if (submittingRef.current || add.isPending) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (submittingRef.current || add.isPending) event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>Add {label} bridge</DialogTitle>
            <DialogDescription>{tokenHint}</DialogDescription>
          </DialogHeader>
          {result ? (
            <BridgeAddedSummary record={result} onClose={close} />
          ) : (
            <>
              <div className="grid gap-3">
                <div className="grid gap-1.5">
                  <Label htmlFor="bridge-name" className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    Name
                  </Label>
                  <Input
                    id="bridge-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder={`my-${kind}-bot`}
                    autoComplete="off"
                    autoFocus
                  />
                  <p className="text-[11px] text-muted-foreground">
                    A short label so you can recognize this bridge later.
                  </p>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="bridge-token" className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    Bot token
                  </Label>
                  <Input
                    id="bridge-token"
                    type="password"
                    value={botToken}
                    onChange={(event) => setBotToken(event.target.value)}
                    placeholder={kind === "telegram" ? "123456789:ABCdef..." : "MzA1...Ovy4MCQQ"}
                    autoComplete="off"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Stored encrypted in the per-instance secret store. Never leaves your machine.
                  </p>
                </div>
                {kind === "discord" ? (
                  <div className="grid gap-1.5">
                    <Label htmlFor="bridge-targets" className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      Channel IDs
                    </Label>
                    <Textarea
                      id="bridge-targets"
                      value={deliveryTargets}
                      onChange={(event) => setDeliveryTargets(event.target.value)}
                      placeholder={"123456789012345678\n987654321098765432"}
                      autoComplete="off"
                      rows={3}
                    />
                    <p className="text-[11px] text-muted-foreground">
                      One channel ID per line, or comma-separated. Enable Developer Mode in
                      Discord, right-click a channel, and choose Copy Channel ID. The bot will
                      poll these channels for incoming messages.
                    </p>
                  </div>
                ) : null}
              </div>
              {add.error ? (
                <p className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
                  {add.error.message}
                </p>
              ) : null}
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="outline" disabled={add.isPending}>Cancel</Button>
                </DialogClose>
                <Button
                  onClick={submit}
                  disabled={
                    add.isPending
                    || name.trim().length === 0
                    || botToken.trim().length === 0
                    || (kind === "discord" && parseDeliveryTargets(deliveryTargets).length === 0)
                  }
                >
                  {add.isPending ? "Adding…" : `Add ${label}`}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

// Post-create summary view. For Telegram, points the operator at the
// per-chat enrollment flow: anyone DMs the bot, the bot replies with
// a short verification code, the same code surfaces under this bridge
// in the pending-request list with Approve / Reject buttons. For
// Discord, points the operator at the invite-and-add-to-channel
// flow since there's no per-user enrollment surface.
function BridgeAddedSummary({
  record,
  onClose
}: {
  record: MessagingBridgeRecord;
  onClose: () => void;
}) {
  const metadata = (record.metadata ?? {}) as { botUsername?: string };
  const botUsername = metadata.botUsername;

  return (
    <>
      <div className="space-y-3 text-xs">
        <p className="text-sm">
          <span className="font-medium">{record.name}</span> is now configured as a {record.kind} bridge.
        </p>
        {record.kind === "telegram" ? (
          <div className="space-y-2 rounded-md border border-sky-500/30 bg-sky-500/5 p-3">
            <p className="text-sm font-medium">Next: enroll a chat</p>
            <p>
              Have anyone (yourself included) DM {botUsername ? `@${botUsername}` : "your bot"} on
              Telegram. The bot replies with a short verification code (e.g.{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">F971-8261</code>
              ); the same code appears as a pending request under this bridge.
            </p>
            <p className="text-[11px] text-muted-foreground">
              Confirm the code matches what the user reports, then click Approve. The bot greets
              the chat afterward so the user knows they&apos;re paired. Codes expire after 10 minutes —
              a fresh DM mints a new one.
            </p>
          </div>
        ) : null}
        {record.kind === "discord" ? (
          <div className="space-y-2 rounded-md border border-indigo-500/30 bg-indigo-500/5 p-3">
            <p className="text-sm font-medium">Next: invite the bot to your channels</p>
            <p>
              The bot will poll the channel IDs you supplied. Open the Discord Developer Portal,
              copy the bot&apos;s OAuth2 install URL, and add it to the server so it can read
              those channels. Click Health on the new bridge afterward to verify the token.
            </p>
          </div>
        ) : null}
      </div>
      <DialogFooter>
        <Button onClick={onClose}>Done</Button>
      </DialogFooter>
    </>
  );
}

function labelFor(kind: string): string {
  if (kind === "telegram") return "Telegram";
  if (kind === "discord") return "Discord";
  if (kind === "slack") return "Slack";
  return kind;
}

// Split a free-form Discord channel-ID input on commas and whitespace
// so the user can paste a list however they have it — comma-separated
// from a spreadsheet, one-per-line from a notes file, or mixed.
function parseDeliveryTargets(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

"use client";

// Focused, reusable dialog for connecting a bring-your-own Socket-Mode Slack
// bridge (name + bot token xoxb- + app-level token xapp-, POST /api/messaging
// kind:"slack"). Used from both the Settings Messaging card ("Add Slack") and
// the Integrations Slack drilldown ("Connect workspace"), so there is one
// implementation of the create form and its safety behavior. Controlled
// component: the caller owns open/onOpenChange.

import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
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
import { api } from "@/lib/api";
import { useInvalidate } from "@/lib/queries";
import type { MessagingBridgeRecord } from "@runtime/types";

interface SlackConnectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Fires once the server confirms the bridge, before the success view shows.
  onConnected?: (record: MessagingBridgeRecord) => void;
}

export function SlackConnectDialog({ open, onOpenChange, onConnected }: SlackConnectDialogProps) {
  const invalidate = useInvalidate();
  const [name, setName] = useState("");
  const [botToken, setBotToken] = useState("");
  // Slack's second credential: the app-level xapp- token that authenticates the
  // Socket Mode connection. The bot token above handles replies.
  const [appToken, setAppToken] = useState("");
  const [result, setResult] = useState<MessagingBridgeRecord | null>(null);
  // Monotonic per-open-session counter. An in-flight create's onSuccess captures
  // the value at submit time and only promotes the response into `result` if the
  // same session is still active, so a POST that resolves after the dialog closes
  // and reopens can't pollute a fresh session with a stale success view.
  const sessionRef = useRef(0);
  // Synchronous single-flight guard. The submit button's disabled={add.isPending}
  // only commits on the next React render; a same-frame double-click could fire
  // submit() twice before that render lands, so a ref gates the second call.
  const submittingRef = useRef(false);

  const add = useMutation<MessagingBridgeRecord, Error, { name: string; botToken: string; appToken: string }>({
    mutationFn: (input) =>
      api<MessagingBridgeRecord>("/messaging", {
        method: "POST",
        body: JSON.stringify({
          name: input.name,
          kind: "slack",
          botToken: input.botToken,
          appToken: input.appToken,
          deliveryTargets: []
        })
      }),
    onSuccess: () => {
      // Fires regardless of session — the bridge exists server-side. The
      // mutate()-level onSuccess routes the record into the success view.
      toast.success("Slack bridge added.");
      invalidate(["messaging", "events", "state"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  // Reset the form each time the dialog opens and bump the session counter.
  // Reset-on-open (rather than a deferred close-reset) is sufficient here since
  // tokens are additionally cleared the instant the create succeeds below.
  useEffect(() => {
    if (!open) return;
    sessionRef.current += 1;
    setName("");
    setBotToken("");
    setAppToken("");
    setResult(null);
    add.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = () => {
    if (submittingRef.current) return;
    const trimmedName = name.trim();
    const trimmedToken = botToken.trim();
    const trimmedAppToken = appToken.trim();
    if (!trimmedName) {
      toast.error("Name is required.");
      return;
    }
    if (!trimmedToken) {
      toast.error("Bot token is required.");
      return;
    }
    if (!trimmedAppToken) {
      toast.error("App-level token is required.");
      return;
    }
    submittingRef.current = true;
    const submittingSession = sessionRef.current;
    add.mutate(
      { name: trimmedName, botToken: trimmedToken, appToken: trimmedAppToken },
      {
        onSuccess: (record) => {
          if (sessionRef.current !== submittingSession) return;
          // Credential hygiene: drop the entered tokens from React state the
          // moment the server confirms the bridge. They're already persisted in
          // the per-instance encrypted secret store, so holding them in state
          // until the dialog closes would leave a credential inspectable in
          // React DevTools or a debug overlay for the duration of the summary.
          setName("");
          setBotToken("");
          setAppToken("");
          setResult(record);
          onConnected?.(record);
        },
        onSettled: () => {
          submittingRef.current = false;
        }
      }
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (value) {
          onOpenChange(true);
          return;
        }
        // Reject Esc / outside-click / X dismissals while the create POST is in
        // flight. The mutation has no AbortController and the runtime does not
        // enforce bridge-name uniqueness, so a dismiss-then-resubmit would mint
        // two bridges fighting over the same token. Reading submittingRef
        // alongside add.isPending closes a same-frame race between submit()
        // flipping the ref and React committing the next render.
        if (submittingRef.current || add.isPending) return;
        onOpenChange(false);
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
          <DialogTitle>Add Slack bridge</DialogTitle>
          <DialogDescription>
            Create a Slack app at api.slack.com/apps, enable Socket Mode, install it to your
            workspace, and paste both tokens below.
          </DialogDescription>
        </DialogHeader>
        {result ? (
          <>
            <div className="space-y-3 text-xs">
              <p className="text-sm">
                <span className="font-medium">{result.name}</span> is now configured as a slack bridge.
              </p>
              <div className="space-y-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3">
                <p className="text-sm font-medium">Next: DM the bot in Slack</p>
                <p>
                  Open your workspace, find the app under Apps, and send it a direct message. Each
                  top-level message starts its own thread — the reply lands inside it. Click Health
                  on the new bridge to verify the bot token.
                </p>
                <p className="text-[11px] text-muted-foreground">
                  Anyone in the workspace can DM the bot; installing the app into the workspace is
                  the access decision.
                </p>
              </div>
            </div>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <div className="grid gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="slack-connect-name" className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Name
                </Label>
                <Input
                  id="slack-connect-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="my-slack-bot"
                  autoComplete="off"
                  autoFocus
                />
                <p className="text-[11px] text-muted-foreground">
                  A short label so you can recognize this bridge later.
                </p>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="slack-connect-bot-token" className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Bot token
                </Label>
                <Input
                  id="slack-connect-bot-token"
                  type="password"
                  value={botToken}
                  onChange={(event) => setBotToken(event.target.value)}
                  placeholder="xoxb-..."
                  autoComplete="off"
                />
                <p className="text-[11px] text-muted-foreground">
                  Stored encrypted in the per-instance secret store. Never leaves your machine.
                </p>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="slack-connect-app-token" className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  App-level token
                </Label>
                <Input
                  id="slack-connect-app-token"
                  type="password"
                  value={appToken}
                  onChange={(event) => setAppToken(event.target.value)}
                  placeholder="xapp-..."
                  autoComplete="off"
                />
                <p className="text-[11px] text-muted-foreground">
                  Generated under your app&apos;s Basic Information → App-Level Tokens with the
                  connections:write scope. It authenticates the Socket Mode connection the bridge
                  listens on; the bot token above handles replies.
                </p>
              </div>
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
                  || appToken.trim().length === 0
                }
              >
                {add.isPending ? "Adding…" : "Add Slack"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

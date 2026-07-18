"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import {
  useBrowserConnection,
  useConnectBrowser,
  useDisconnectBrowser
} from "@/lib/queries";

// Two transports (issue #420). By DEFAULT the agent drives its own spawned
// per-instance headless Chrome — launched on demand, no controls needed; a
// site sign-in happens through the in-chat screencast modal. As a power-user
// option the user can instead attach the runtime to their OWN already-running
// Chrome over a CDP websocket URL (the "Advanced" section). There is no
// managed/visible-window mode anymore — only the spawned default and CDP
// attach.
export function BrowserSettingsCard() {
  const connect = useConnectBrowser();
  const disconnect = useDisconnectBrowser();
  const status = useBrowserConnection({
    isActive: connect.isPending || disconnect.isPending
  });
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [cdpUrl, setCdpUrl] = useState("");
  const [disconnectOpen, setDisconnectOpen] = useState(false);

  const connected = status.data?.connected ?? false;
  const record = status.data?.record;

  const handleAttach = () => {
    const trimmed = cdpUrl.trim();
    if (!trimmed) {
      toast.error("Paste a CDP URL first.");
      return;
    }
    connect.mutate(
      { cdpUrl: trimmed },
      {
        onSuccess: () => {
          toast.success("Attached to Chrome via CDP.");
          setCdpUrl("");
        },
        onError: (error: Error) => toast.error(error.message)
      }
    );
  };

  const handleDisconnect = () => {
    disconnect.mutate(undefined, {
      onSuccess: () => {
        toast.success("Disconnected.");
        setDisconnectOpen(false);
      },
      onError: (error: Error) => toast.error(error.message)
    });
  };

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Browser</CardTitle>
          <CardDescription>
            {connected
              ? "Attached to your Chrome over CDP."
              : "The agent uses its own browser; attach your own Chrome only if you need to."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {record ? (
            <dl className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
              <Detail label="Mode" value="External CDP attach" />
              <Detail label="Attached" value={new Date(record.startedAt).toLocaleString()} />
              <Detail label="CDP URL" value={record.cdpUrl} mono wrap />
            </dl>
          ) : (
            <p className="text-xs text-muted-foreground">
              By default the agent drives its own browser, launched automatically when a task
              needs the web. When it hits a sign-in wall it opens a live view of that browser
              in chat so you can sign in once. You only need the option below if you want the
              agent to drive a Chrome you are already running yourself.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {connected ? (
              <Button
                size="sm"
                variant="destructive"
                onClick={() => setDisconnectOpen(true)}
                disabled={disconnect.isPending}
              >
                Disconnect
              </Button>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setShowAdvanced((value) => !value)}
              >
                {showAdvanced ? "Hide Advanced" : "Advanced"}
              </Button>
            )}
          </div>

          {!connected && showAdvanced ? (
            <div className="grid gap-3 rounded-md border border-border bg-card/50 p-3 text-xs">
              <div>
                <Label htmlFor="browser-cdp" className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Attach to existing Chrome (CDP URL)
                </Label>
                <Input
                  id="browser-cdp"
                  value={cdpUrl}
                  onChange={(event) => setCdpUrl(event.target.value)}
                  placeholder="ws://127.0.0.1:9222/devtools/browser/abc"
                />
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Start Chrome with{" "}
                  <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">
                    --remote-debugging-port=9222
                  </code>{" "}
                  yourself, then paste its websocket debugger URL here. The runtime drives
                  that Chrome but never starts or stops the process. Most people don&apos;t need this —
                  the agent&apos;s own browser works out of the box.
                </p>
                <div className="mt-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleAttach}
                    disabled={connect.isPending || cdpUrl.trim().length === 0}
                  >
                    {connect.isPending ? "Attaching..." : "Attach via CDP"}
                  </Button>
                </div>
              </div>
            </div>
          ) : null}

          {connect.error ? (
            <p className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
              {connect.error.message}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Dialog open={disconnectOpen} onOpenChange={setDisconnectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disconnect browser?</DialogTitle>
            <DialogDescription>
              The runtime will drop its CDP attachment but never touch the Chrome process you
              started. The agent falls back to its own spawned browser.
            </DialogDescription>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">Your Chrome process is left alone.</p>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              variant="destructive"
              onClick={handleDisconnect}
              disabled={disconnect.isPending}
            >
              {disconnect.isPending ? "Disconnecting..." : "Disconnect"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Detail({
  label,
  value,
  mono = false,
  wrap = false
}: {
  label: string;
  value: string;
  mono?: boolean;
  wrap?: boolean;
}) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={`mt-0.5 ${mono ? "font-mono text-[11px]" : "text-xs"} ${wrap ? "break-all" : ""}`}>
        {value}
      </dd>
    </div>
  );
}

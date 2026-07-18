"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { api, streamUrl } from "@/lib/api";
import { openResilientEventSource } from "@/lib/resilient-event-source";

// Live sign-in screencast. Mounted by the browser.connect approval card once
// the user has approved ("Connect to agent's browser") and the server has
// stamped the setup request as a screencast (signInStarted + screencast). It
// streams JPEG frames of the agent's headless browser over an SSE channel
// (proxied by the BFF, which injects the gateway bearer server-side — the
// browser never holds the token) and relays the user's clicks/keys back via a
// POST endpoint. The user signs in on the live page, then clicks "I've signed
// in" to complete the setup request and resume the agent's task.
//
// There is intentionally NO URL bar: the modal drives the page the agent
// already reached. Free navigation would bypass the agent's SSRF / domain
// policy gate (which lives on browser_navigate), so sign-in links are followed
// by clicking them on the page, which Chrome routes normally.

// CDP modifier bitmask: Alt 1, Ctrl 2, Meta 4, Shift 8.
function cdpModifiers(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

interface ScreencastFrameMsg {
  data: string;
  meta: { deviceWidth?: number; deviceHeight?: number };
}

export function ScreencastModal({
  setupRequestId,
  handoff = false,
  onComplete,
  onCancel,
  completing,
  cancelling
}: {
  setupRequestId: string;
  // True for a handoff-mode browser.connect (the user finishes a sensitive
  // step themselves) — drives the title/button copy. False = sign-in.
  handoff?: boolean;
  onComplete: () => void;
  onCancel: () => void;
  completing: boolean;
  cancelling: boolean;
}) {
  // Mode-keyed copy mirrors browserConnectButtonLabel (sign-in vs handoff).
  const title = handoff ? "Finish in the browser" : "Sign in to continue";
  const description = handoff
    ? "Complete the step on the live page below — the agent is watching this same browser and will continue once you're done."
    : "Sign in on the live page below — the agent is watching this same browser and will continue once you're done.";
  const completeLabel = handoff ? "I'm done" : "I've signed in";
  const imgRef = useRef<HTMLImageElement>(null);
  const captureRef = useRef<HTMLTextAreaElement>(null);
  // Natural size of the captured page (device pixels from CDP frame metadata),
  // used to rescale pointer coordinates from the displayed <img> to the page.
  const pageSize = useRef({ w: 1280, h: 800 });
  const [status, setStatus] = useState<"connecting" | "live" | "error">("connecting");
  // True once the first frame has painted. Until then the <img> stays hidden and
  // a placeholder shows, so a src-less <img> never renders the browser's
  // broken-image glyph (what a stalled/reconnecting stream used to look like).
  // The ref mirror lets the onStateChange closure read the latest value without
  // capturing the initial render's.
  const [hasFrame, setHasFrame] = useState(false);
  const hasFrameRef = useRef(false);
  // The origin (scheme + host) of the page being screencast, streamed from the
  // gateway. The modal has no address bar, so this is the operator's only
  // trusted signal for which site they're typing credentials into.
  const [origin, setOrigin] = useState<string | null>(null);
  const dragStart = useRef<{ x: number; y: number; clientX: number; clientY: number; mods: number } | null>(null);
  // Latest text selected on the REMOTE page. The server returns it after every
  // selection-causing action (double/triple-click, drag, copy/cut/select-all),
  // so a native Cmd+C/Cmd+X on the focused capture field can write it to the
  // operator's clipboard synchronously — no async clipboard API (which is
  // unavailable over plain HTTP) needed.
  const remoteSelection = useRef("");
  // Move-coalescing: pointer move fires far faster than a round-trip, so cap it
  // to one in-flight POST and remember only the latest position, flushed when
  // the in-flight one returns. Keeps hover responsive without flooding the one
  // shared CDP socket with stale intermediate coordinates.
  const moveInFlight = useRef(false);
  const pendingMove = useRef<Record<string, unknown> | null>(null);

  // Open the frames SSE through the RESILIENT wrapper, not a bare EventSource.
  // EventSource hits /api/runtime/... so the BFF injects the bearer; the browser
  // never sees it. The catch: a request that lands while the gateway is
  // restarting (for example during a local update or watchdog recovery)
  // gets the BFF's retryable 503, and per the SSE spec a non-2xx response
  // PERMANENTLY closes a bare EventSource (no auto-retry) — stranding the modal
  // on "Reconnecting…" with no frame. openResilientEventSource reopens on
  // backoff (same as the main runtime event stream), so the screencast recovers
  // on its own once the gateway is back. Listeners are (re)registered in
  // `attach` so they survive each reopen; the reopened stream carries no
  // Last-Event-ID and the gateway bridge replays its latest frame on
  // resubscribe, so the page repaints immediately.
  useEffect(() => {
    hasFrameRef.current = false;
    setHasFrame(false);
    setStatus("connecting");
    const handle = openResilientEventSource(streamUrl(`/browser/screencast/${setupRequestId}/frames`), {
      attach: (source) => {
        source.addEventListener("frame", (ev) => {
          try {
            const frame = JSON.parse((ev as MessageEvent).data) as ScreencastFrameMsg;
            if (imgRef.current) imgRef.current.src = `data:image/jpeg;base64,${frame.data}`;
            if (frame.meta?.deviceWidth) pageSize.current.w = frame.meta.deviceWidth;
            if (frame.meta?.deviceHeight) pageSize.current.h = frame.meta.deviceHeight;
            hasFrameRef.current = true;
            setHasFrame(true);
            setStatus("live");
          } catch {
            // drop a malformed frame
          }
        });
        source.addEventListener("url", (ev) => {
          try {
            const { url } = JSON.parse((ev as MessageEvent).data) as { url?: string };
            if (url) setOrigin(new URL(url).origin);
          } catch {
            // drop a malformed/unparseable url event
          }
        });
      },
      // Transition-only connection state. Dropped transport → "Reconnecting…";
      // reopened → wait for the first frame ("Connecting…"), unless one has
      // already painted, in which case keep showing the last frame across the
      // blip (a fresh frame replays immediately on resubscribe).
      onStateChange: (connected) => {
        setStatus(connected ? (hasFrameRef.current ? "live" : "connecting") : "error");
      }
    });
    return () => handle.close();
  }, [setupRequestId]);

  // Fire-and-forget one input event to the gateway. We don't await/toast on
  // failure: input is high-frequency and a dropped move/click is recoverable.
  const sendInput = useCallback(
    (payload: Record<string, unknown>) => {
      void api(`/browser/screencast/${setupRequestId}/input`, {
        method: "POST",
        body: JSON.stringify(payload)
      }).catch(() => undefined);
    },
    [setupRequestId]
  );

  // Like sendInput, but captures the remote page's selection from the response
  // (selection-causing actions) so a subsequent native copy/cut can serve it.
  const sendInputCapturingSelection = useCallback(
    (payload: Record<string, unknown>) => {
      void api<{ ok: boolean; selection?: string }>(`/browser/screencast/${setupRequestId}/input`, {
        method: "POST",
        body: JSON.stringify(payload)
      })
        .then((res) => {
          if (typeof res?.selection === "string") remoteSelection.current = res.selection;
        })
        .catch(() => undefined);
    },
    [setupRequestId]
  );

  // Coalesced move sender: at most one move POST outstanding; the latest move
  // that arrives while one is in flight is stashed and sent when it settles.
  const sendMove = useCallback(
    (payload: Record<string, unknown>) => {
      if (moveInFlight.current) {
        pendingMove.current = payload;
        return;
      }
      moveInFlight.current = true;
      void api(`/browser/screencast/${setupRequestId}/input`, {
        method: "POST",
        body: JSON.stringify(payload)
      })
        .catch(() => undefined)
        .finally(() => {
          moveInFlight.current = false;
          const next = pendingMove.current;
          if (next) {
            pendingMove.current = null;
            sendMove(next);
          }
        });
    },
    [setupRequestId]
  );

  // Map a pointer event on the <img> to page coordinates (the rendered image
  // is scaled to fit, so rescale by the natural/displayed ratio).
  const toPage = useCallback((e: { clientX: number; clientY: number }) => {
    const el = imgRef.current;
    if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    const sx = pageSize.current.w / r.width;
    const sy = pageSize.current.h / r.height;
    return { x: Math.round((e.clientX - r.left) * sx), y: Math.round((e.clientY - r.top) * sy) };
  }, []);

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    captureRef.current?.focus();
    const p = toPage(e);
    dragStart.current = { x: p.x, y: p.y, clientX: e.clientX, clientY: e.clientY, mods: cdpModifiers(e) };
  };
  const onMouseUp = (e: React.MouseEvent) => {
    const start = dragStart.current;
    dragStart.current = null;
    if (!start) return;
    const end = toPage(e);
    const moved = Math.abs(e.clientX - start.clientX) > 4 || Math.abs(e.clientY - start.clientY) > 4;
    if (moved) {
      // Drag-select and double/triple-click select text — capture the resulting
      // remote selection so a following Cmd+C copies it.
      sendInputCapturingSelection({ kind: "dragselect", x0: start.x, y0: start.y, x1: end.x, y1: end.y, modifiers: start.mods });
    } else {
      const clickCount = e.detail || 1;
      const click = { kind: "click", x: start.x, y: start.y, clickCount, modifiers: start.mods };
      if (clickCount >= 2) sendInputCapturingSelection(click);
      else sendInput(click);
    }
  };
  const onWheel = (e: React.WheelEvent) => {
    const p = toPage(e);
    sendInput({ kind: "scroll", x: p.x, y: p.y, dx: e.deltaX, dy: e.deltaY, modifiers: cdpModifiers(e) });
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const cmd = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    // Let the browser's own copy/cut/paste events fire for these — do NOT
    // preventDefault, or the clipboard handlers below never run.
    if (cmd && (k === "c" || k === "x" || k === "v")) return;
    e.preventDefault();
    // Cmd+A selects all on the remote page (and the server returns the selection
    // so a following Cmd+C copies it).
    if (cmd && k === "a") {
      sendInputCapturingSelection({ kind: "selectall" });
      return;
    }
    const mods = cdpModifiers(e);
    const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
    sendInput({
      kind: "key",
      text: printable ? e.key : "",
      key: e.key,
      code: e.code,
      vk: e.keyCode,
      modifiers: mods
    });
  };
  // Native clipboard events on the focused capture field cross the boundary and
  // work even over plain HTTP (where navigator.clipboard is undefined).
  // COPY OUT: write the cached remote selection into the operator's clipboard.
  const onCopy = (e: React.ClipboardEvent) => {
    if (!remoteSelection.current) return;
    e.clipboardData.setData("text/plain", remoteSelection.current);
    e.preventDefault();
  };
  const onCut = (e: React.ClipboardEvent) => {
    if (!remoteSelection.current) return;
    e.clipboardData.setData("text/plain", remoteSelection.current);
    e.preventDefault();
    sendInput({ kind: "cut" }); // delete the selection on the remote side
  };
  // PASTE IN: ship the operator's clipboard text to the remote page's field.
  const onPaste = (e: React.ClipboardEvent) => {
    const text = e.clipboardData.getData("text");
    e.preventDefault();
    if (text) sendInput({ kind: "paste", text });
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !completing) onCancel(); }}>
      <DialogContent className="flex h-[92vh] w-[96vw] max-w-[96vw] flex-col sm:max-w-[96vw]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {description}
            {status === "connecting" ? " Connecting…" : status === "error" ? " Reconnecting…" : null}
          </DialogDescription>
        </DialogHeader>
        {/* Read-only trust anchor: the origin the agent's browser is on, sourced
            from the gateway. NOT an input — there is no navigation from here. */}
        <div className="flex items-center gap-2 rounded border border-border bg-muted/40 px-2 py-1 text-xs text-muted-foreground">
          <span className="shrink-0">Signing in to</span>
          <span className="truncate font-mono text-foreground" title={origin ?? undefined}>
            {origin ?? "…"}
          </span>
        </div>
        {/* Image area flexes to fill all leftover vertical space; min-h-0 lets it
            shrink inside the flex column. The image fits within this box with
            both dimensions capped (max-h/max-w-full) so its element box hugs the
            painted pixels — required for the toPage() click mapping, which is why
            object-contain (letterboxing inside a larger box) is NOT used. */}
        <div className="relative flex min-h-0 flex-1 items-center justify-center">
          {/* Hidden field that holds keyboard focus so key events land here. */}
          <textarea
            ref={captureRef}
            aria-hidden
            tabIndex={-1}
            className="absolute -left-[9999px] h-px w-px opacity-0"
            onKeyDown={onKeyDown}
            onCopy={onCopy}
            onCut={onCut}
            onPaste={onPaste}
            onInput={(e) => { (e.target as HTMLTextAreaElement).value = ""; }}
          />
          {/* eslint-disable-next-line @next/next/no-img-element -- live screencast frames, not a static asset */}
          <img
            ref={imgRef}
            alt="Agent browser screencast"
            // Kept mounted (imgRef must exist for the frame handler to set .src)
            // but hidden until the first frame lands: a src-less <img> otherwise
            // paints the browser's broken-image glyph + alt text, which is
            // exactly how a stalled/reconnecting stream used to look.
            className={`max-h-full max-w-full cursor-crosshair rounded border border-border bg-black ${hasFrame ? "" : "invisible"}`}
            draggable={false}
            onMouseDown={onMouseDown}
            onMouseUp={onMouseUp}
            onMouseMove={(e) => { if (dragStart.current) return; const p = toPage(e); sendMove({ kind: "move", x: p.x, y: p.y, modifiers: cdpModifiers(e) }); }}
            onWheel={onWheel}
            onDoubleClick={(e) => e.preventDefault()}
          />
          {/* Shown until the first frame arrives (initial connect, or while the
              resilient wrapper reopens after a gateway restart) so the operator
              sees a calm connecting state instead of a broken image. */}
          {!hasFrame ? (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 rounded border border-border bg-black text-sm text-muted-foreground">
              <Loader2 className="size-6 animate-spin" aria-hidden />
              <span>{status === "error" ? "Reconnecting to the agent's browser…" : "Connecting to the agent's browser…"}</span>
            </div>
          ) : null}
        </div>
        <div className="mt-2 flex gap-2">
          <Button size="sm" disabled={completing} onClick={onComplete}>
            {completing ? "Finishing…" : completeLabel}
          </Button>
          <Button size="sm" variant="outline" disabled={cancelling} onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

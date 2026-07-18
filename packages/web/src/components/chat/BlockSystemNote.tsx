import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DocReference } from "@/components/DocReference";
import type { SystemNoteBlock } from "@runtime/types";

// Muted italic line used for terminal flags ("Cancelled", "Failed: …") and
// other operator-attributed notes. Kept low-key so it doesn't pull focus
// from the assistant's reply.
//
// Provider-credential failures (block.authError) are the exception: they
// render as an alert card naming the provider, with a CTA whose destination
// depends on how the provider authenticates (issue #205). OAuth/CLI providers
// (codex) link to the hosted re-auth step-through; AWS providers (bedrock) link
// to Settings but the CTA reads as "open settings" since there's no key to
// paste; API-key providers link to the Settings → Providers key form, with the
// provider's own error shown as the specific cause.
//
// A generic cta (block.cta) renders the note text plus an inline button to
// an in-app route (e.g. request_google_account's "Reconnect Google account"
// → /integrations). Neutral styling — it's guidance, not an error card.
export function BlockSystemNote({ block }: { block: SystemNoteBlock }) {
  if (block.authError) {
    const { providerLabel, detail, reauthKind, reauthUrl } = block.authError;
    // Fall back to the Settings form for blocks that predate the routing fields
    // (or any with them missing) so an older persisted note never renders a
    // broken CTA.
    const kind = reauthKind ?? "settings";
    const url = reauthUrl ?? "/settings";
    // "docs" opens an instruction page (the user re-auths themselves, e.g. in a
    // terminal), so the label must read as "show me how" — not as a button that
    // performs the auth. "aws" navigates to Settings but the provider signs with
    // AWS credentials, so it must not promise a key form. "settings" navigates
    // to the in-app key form.
    const ctaLabel =
      kind === "docs"
        ? `How to re-authenticate ${providerLabel}`
        : kind === "aws"
          ? `Open ${providerLabel} settings`
          : `Update ${providerLabel} key`;
    return (
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
        <div className="flex items-center gap-2">
          <ShieldAlert className="size-4 shrink-0 text-amber-600 dark:text-amber-500" aria-hidden />
          <span className="text-xs font-medium text-foreground">{block.text}</span>
        </div>
        {detail ? (
          <p className="mt-1 text-[11px] italic text-muted-foreground">{detail}</p>
        ) : null}
        {kind === "docs" ? (
          <DocReference url={url}>
            <Button size="sm" variant="outline" className="mt-2">
              {ctaLabel}
            </Button>
          </DocReference>
        ) : (
          <Button asChild size="sm" variant="outline" className="mt-2">
            <Link href={url}>{ctaLabel}</Link>
          </Button>
        )}
      </div>
    );
  }
  if (block.cta) {
    return (
      <div>
        <p className="text-xs italic text-muted-foreground">{block.text}</p>
        <Button asChild size="sm" variant="outline" className="mt-2">
          <Link href={block.cta.href}>{block.cta.label}</Link>
        </Button>
      </div>
    );
  }
  return (
    <p className="text-xs italic text-muted-foreground">{block.text}</p>
  );
}

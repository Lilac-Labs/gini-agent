"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useInvalidate } from "@/lib/queries";
import { ProviderPicker } from "@/components/ProviderPicker";

// The /setup page. First-run onboarding for a fresh Gini install: the runtime
// is up (autostart enabled it), the user just landed here from the installer's
// `open http://127.0.0.1:3000/setup`, and they need to pick a provider before
// they can use the app.
//
// On mount we call /api/setup/status. If providerConfigured is true the user
// got here by mistake (or backed into the URL) and we redirect home.
// Otherwise we render the shared ProviderPicker, which offers the full
// provider catalog (OpenAI, Codex, Anthropic, Bedrock, OpenRouter, DeepSeek,
// Azure, Local) and POSTs the choice to /api/setup/provider — the same
// surface Settings → Add provider uses.

type SetupStatus = {
  ok: true;
  providerConfigured: boolean;
  // The backend ships the full SUPPORTED_PROVIDERS list here; the picker reads
  // the live /providers/catalog rather than this array, so the page only needs
  // the configured flag and the current-provider hint.
  providers: string[];
  current: string | null;
  message: string;
};

export default function SetupPage() {
  const router = useRouter();
  const invalidate = useInvalidate();
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await api<SetupStatus>("/setup/status");
        if (cancelled) return;
        setStatus(next);
        if (next.providerConfigured) router.replace("/");
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <p className="text-sm text-muted-foreground">Loading setup…</p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 justify-center overflow-auto p-6">
      <div className="w-full max-w-3xl space-y-6 py-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">Welcome to Gini</h1>
          <p className="text-sm text-muted-foreground">
            Pick a provider and Gini will start using it. You can change this later in Settings.
          </p>
          {status && status.current && status.current !== "echo" ? (
            <p className="text-xs text-muted-foreground">
              Current provider: <span className="font-medium">{status.current}</span> — not yet configured.
            </p>
          ) : null}
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>
        <ProviderPicker
          submitLabel="Save and continue"
          pendingLabel="Saving…"
          onSaved={() => {
            // The shared ["setup-status"] cache (staleTime Infinity) still
            // says providerConfigured: false; refresh it so an incomplete
            // funnel entered after this save doesn't show a spurious
            // provider step (needsProviderStep — ADR web-onboarding-flow.md).
            invalidate(["setup-status"]);
            router.replace("/");
          }}
        />
      </div>
    </div>
  );
}

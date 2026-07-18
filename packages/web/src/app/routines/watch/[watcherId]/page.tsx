"use client";

import { use, useState } from "react";
import Link from "next/link";
import { notFound, useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChevronRightIcon, MessageSquareIcon, Trash2Icon, ZapIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { formatRelativeTime } from "@/components/chat/relative-time";
import { useEmailWatchers, useRemoveEmailWatcher, useUpdateEmailWatcher } from "@/lib/queries";
import type { EmailWatcherRecord } from "@runtime/types";
import { WATCHER_CHIP } from "../../chips";
import { watcherChannelId, watcherMatcherLabel } from "../../watchers";

// Email-watcher routine detail page. Same visual language as the template
// detail (/routines/[templateId]): breadcrumb, sticky tinted hero (enable
// toggle = PATCH enabled, Open channel action) and underline tabs — Settings
// (objective edit/clear) and Info (matcher, account, status, Delete routine).
// No Recent sessions tab: a watcher's activity lives in its channel, and
// there is no per-watcher runs API.
export default function WatcherDetailPage({ params }: { params: Promise<{ watcherId: string }> }) {
  const { watcherId } = use(params);
  const watchers = useEmailWatchers();

  const all = watchers.data;
  const watcher = all?.find((candidate) => candidate.id === watcherId);
  // Only a loaded list can rule the id unknown — while loading, show a quiet
  // placeholder instead of flashing the 404 boundary.
  if (all && !watcher) notFound();

  return (
    <>
      <header className="flex items-center gap-2 border-b border-border px-6 py-4 text-sm">
        <ZapIcon className="size-4 text-muted-foreground" aria-hidden />
        <Link href="/routines" className="text-muted-foreground transition-colors hover:text-foreground">
          Routines
        </Link>
        <ChevronRightIcon className="size-[15px] text-muted-foreground/65" aria-hidden />
        <span className="font-medium">{watcher ? watcherMatcherLabel(watcher) : "…"}</span>
      </header>
      {watcher ? (
        <WatcherDetail watcher={watcher} />
      ) : (
        <div className="p-6 text-sm text-muted-foreground">
          {watchers.error ? watchers.error.message : "Loading…"}
        </div>
      )}
    </>
  );
}

function WatcherDetail({ watcher }: { watcher: EmailWatcherRecord }) {
  const router = useRouter();
  const { icon: Icon, color } = WATCHER_CHIP;
  const update = useUpdateEmailWatcher();
  const remove = useRemoveEmailWatcher();
  const [tab, setTab] = useState<"settings" | "info">("settings");

  const name = watcherMatcherLabel(watcher);
  const description = watcher.objective?.trim() || watcher.query;
  const channelId = watcherChannelId(watcher);

  const toggleEnabled = () => {
    update.mutate(
      { id: watcher.id, enabled: !watcher.enabled },
      {
        onSuccess: () => toast.success(watcher.enabled ? `Paused ${name}` : `Resumed ${name}`),
        onError: (error) => toast.error(error.message)
      }
    );
  };

  const submitDelete = () => {
    remove.mutate(watcher.id, {
      onSuccess: () => {
        toast.success(`Removed ${name}`);
        router.push("/routines");
      },
      onError: (error) => toast.error(error.message)
    });
  };

  const tabs = [
    { key: "settings" as const, label: "Settings" },
    { key: "info" as const, label: "Info" }
  ];

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="mx-auto flex max-w-[1240px] flex-col items-start gap-10 md:flex-row md:gap-13">
        {/* Left sticky column: hero + actions */}
        <div className="w-full shrink-0 md:sticky md:top-0 md:w-[300px]">
          <div
            className="relative flex min-h-[310px] flex-col overflow-hidden rounded-2xl p-5"
            style={{
              backgroundColor: color,
              backgroundImage: "radial-gradient(rgba(255,255,255,0.22) 1.3px, transparent 1.3px)",
              backgroundSize: "15px 15px"
            }}
          >
            <div className="flex items-start justify-between gap-3">
              <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-white/90">
                <Icon className="size-[22px]" style={{ color }} aria-hidden />
              </span>
              <HeroToggle on={watcher.enabled} disabled={update.isPending} onClick={toggleEnabled} />
            </div>
            <span className="flex-1" />
            <div className="text-[11px] font-semibold tracking-[0.6px] text-white/70">CREATED FROM CHAT</div>
            <div className="mt-2 text-[19px] font-bold text-white">{name}</div>
            <div className="mt-2 text-[13px] leading-normal text-white/85">{description}</div>
          </div>

          {channelId ? (
            <div className="mt-5 flex flex-col gap-0.5">
              <button
                type="button"
                onClick={() => router.push(`/chat?session=${encodeURIComponent(channelId)}`)}
                className="flex items-center gap-3 rounded-lg px-2 py-2.5 text-left text-sm font-medium transition-colors hover:bg-muted"
              >
                <MessageSquareIcon className="size-[17px] text-muted-foreground" aria-hidden />
                Open channel
              </button>
            </div>
          ) : null}
        </div>

        {/* Right column */}
        <div className="min-w-0 flex-1">
          <h1 className="text-[26px] font-bold tracking-tight">{name}</h1>
          <p className="mt-2.5 max-w-[640px] text-[15px] leading-relaxed text-muted-foreground">{description}</p>

          <div className="mt-6 flex items-center gap-7 border-b border-border">
            {tabs.map((entry) => (
              <button
                key={entry.key}
                type="button"
                onClick={() => setTab(entry.key)}
                className={cn(
                  "-mb-px border-b-2 pb-3 text-[15px] transition-colors",
                  tab === entry.key
                    ? "border-foreground font-semibold"
                    : "border-transparent font-medium text-muted-foreground hover:text-foreground"
                )}
              >
                {entry.label}
              </button>
            ))}
          </div>

          {tab === "settings" ? (
            // Keyed by updatedAt so a saved/cleared objective reseeds the
            // textarea from the refetched record.
            <SettingsTab key={watcher.updatedAt} watcher={watcher} />
          ) : (
            <InfoTab watcher={watcher} deletePending={remove.isPending} onDelete={submitDelete} />
          )}
        </div>
      </div>
    </div>
  );
}

// The hero card's enable pill (same treatment as the template detail hero).
// On = the watcher is enabled; toggling PATCHes `enabled`.
function HeroToggle({ on, disabled, onClick }: { on: boolean; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={on ? "Pause routine" : "Resume routine"}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "relative h-[25px] w-11 shrink-0 rounded-full transition-colors disabled:opacity-70",
        on ? "bg-black/30" : "bg-white/35"
      )}
    >
      <span
        className={cn(
          "absolute top-[3px] size-[19px] rounded-full bg-white transition-all",
          on ? "left-[22px]" : "left-[3px]"
        )}
      />
    </button>
  );
}

// Objective editor: Save PATCHes the trimmed text, Clear PATCHes null (the
// gateway contract for removing an objective).
function SettingsTab({ watcher }: { watcher: EmailWatcherRecord }) {
  const update = useUpdateEmailWatcher();
  const saved = watcher.objective ?? "";
  const [objective, setObjective] = useState(saved);
  const dirty = objective.trim() !== saved;

  const submit = (next: string | null) => {
    update.mutate(
      { id: watcher.id, objective: next },
      {
        onSuccess: () => toast.success(next === null ? "Objective cleared" : "Objective updated"),
        onError: (error) => toast.error(error.message)
      }
    );
  };

  return (
    <div className="mt-6">
      <div className="rounded-xl border border-border bg-card px-5 py-4">
        <div className="text-sm font-semibold">Objective</div>
        <div className="mt-1 max-w-[480px] text-[13px] leading-normal text-muted-foreground">
          What the reply should achieve. Gini keeps this in mind every time the watch fires.
        </div>
        <textarea
          value={objective}
          onChange={(event) => setObjective(event.target.value)}
          rows={3}
          placeholder="e.g. Get a refund or a replacement"
          disabled={update.isPending}
          className="mt-3 w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-[13px] text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
        />
      </div>
      <div className="mt-4 flex items-center gap-2">
        <Button
          size="sm"
          disabled={!dirty || objective.trim() === "" || update.isPending}
          onClick={() => submit(objective.trim())}
        >
          {update.isPending ? "Saving…" : "Save"}
        </Button>
        <Button size="sm" variant="ghost" disabled={saved === "" || update.isPending} onClick={() => submit(null)}>
          Clear
        </Button>
      </div>
    </div>
  );
}

const STATUS_LABELS: Record<EmailWatcherRecord["status"], string> = {
  ok: "OK",
  error: "Error",
  needs_auth: "Needs sign-in"
};

function InfoTab({
  watcher,
  deletePending,
  onDelete
}: {
  watcher: EmailWatcherRecord;
  deletePending: boolean;
  onDelete: () => void;
}) {
  const rows: Array<[string, string]> = [
    [
      "Watching",
      watcher.sender ?? (watcher.threadId ? `Thread ${watcher.threadId}` : watcher.query)
    ],
    ["Account", watcher.accountEmail ?? "Default account"],
    ...(watcher.followUpAfterHours !== undefined
      ? ([["Follow up after", `${watcher.followUpAfterHours}h of silence`]] as Array<[string, string]>)
      : []),
    ["Status", STATUS_LABELS[watcher.status]],
    ["Created", formatRelativeTime(watcher.createdAt)]
  ];
  return (
    <div className="mt-6">
      <h2 className="text-[17px] font-semibold">Information</h2>
      <div className="mt-2 flex flex-col">
        {rows.map(([key, value]) => (
          <div key={key} className="flex items-center justify-between gap-4 border-b border-border py-[15px]">
            <span className="text-sm text-muted-foreground">{key}</span>
            <span className="min-w-0 truncate text-sm font-semibold">{value}</span>
          </div>
        ))}
      </div>
      {watcher.status !== "ok" && watcher.lastError ? (
        <p className="mt-3 text-[13px] leading-normal text-destructive">{watcher.lastError}</p>
      ) : null}
      <button
        type="button"
        disabled={deletePending}
        onClick={onDelete}
        className="mt-6 inline-flex h-[38px] items-center gap-2 rounded-lg px-3 text-sm font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
      >
        <Trash2Icon className="size-4" aria-hidden />
        {deletePending ? "Deleting…" : "Delete routine"}
      </button>
    </div>
  );
}

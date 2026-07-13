"use client";

import { use, useState } from "react";
import Link from "next/link";
import { notFound, useRouter } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  MessageSquareIcon,
  PlayIcon,
  PlusIcon,
  Trash2Icon,
  XIcon,
  ZapIcon
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/PageHeader";
import { api } from "@/lib/api";
import { formatRelativeTime } from "@/components/chat/relative-time";
import {
  useInstallRoutineTemplate,
  useInvalidate,
  useJobRuns,
  useJobs,
  useRoutineTemplates,
  useUninstallRoutineTemplate,
  type RoutineAccountSettingsView,
  type RoutineLabelRule,
  type RoutineSettingField,
  type RoutineSettings,
  type RoutineSettingsSection,
  type RoutineTemplateView
} from "@/lib/queries";
import type { JobRecord } from "@runtime/types";
import { RoutineTools } from "@/components/jobs/RoutineTools";
import { chipFor } from "../chips";

// Routine detail page (GiniRoutineDetail design handoff): breadcrumb, a
// sticky hero card tinted with the template's chip color (enable toggle =
// job pause/resume, Run Now action), and underline tabs — Recent sessions
// (the installed job's run history), Settings (the template's per-function
// settings sections, saved via the idempotent re-install), and Info (real
// rows + Delete routine). A template that isn't added renders the hero with
// an Add button in place of the toggle and tabs.
export default function RoutineDetailPage({ params }: { params: Promise<{ templateId: string }> }) {
  const { templateId } = use(params);
  const templates = useRoutineTemplates();

  const all = templates.data?.templates;
  const template = all?.find((candidate) => candidate.id === templateId);
  // Only a loaded catalog can rule the id unknown — while loading, show a
  // quiet placeholder instead of flashing the 404 boundary.
  if (all && !template) notFound();

  return (
    <>
      <header className="flex items-center gap-2 border-b border-border px-6 py-4 text-sm">
        <ZapIcon className="size-4 text-muted-foreground" aria-hidden />
        <Link href="/routines" className="text-muted-foreground transition-colors hover:text-foreground">
          Routines
        </Link>
        <ChevronRightIcon className="size-[15px] text-muted-foreground/65" aria-hidden />
        <span className="font-medium">{template?.name ?? "…"}</span>
      </header>
      {template ? (
        <RoutineDetail template={template} />
      ) : (
        <div className="p-6 text-sm text-muted-foreground">
          {templates.error ? templates.error.message : "Loading…"}
        </div>
      )}
    </>
  );
}

function RoutineDetail({ template }: { template: RoutineTemplateView }) {
  const router = useRouter();
  const { icon: Icon, color } = chipFor(template.icon);
  const installed = template.installed;
  const jobs = useJobs();
  const job = installed ? (jobs.data ?? []).find((candidate) => candidate.id === installed.jobId) : undefined;
  const install = useInstallRoutineTemplate();
  const uninstall = useUninstallRoutineTemplate();
  const invalidate = useInvalidate();
  const [tab, setTab] = useState<"sessions" | "settings" | "info">("sessions");
  // Held here, above the jobId-keyed SettingsTab, so the account being edited
  // survives the remount a Save triggers (re-install mints a new jobId).
  const [settingsAccount, setSettingsAccount] = useState<string>();

  // Same inline mutation shape as the jobs page: POST /jobs/<id>/{run,pause,resume}.
  const action = useMutation({
    mutationFn: ({ id, op }: { id: string; op: "run" | "pause" | "resume" }) =>
      api<JobRecord>(`/jobs/${id}/${op}`, { method: "POST" }),
    onSuccess: (_, vars) => {
      toast.success(
        vars.op === "run" ? `Running ${template.name}` : `${vars.op === "pause" ? "Paused" : "Resumed"} ${template.name}`
      );
      invalidate(["jobs", "jobRuns", "routine-templates", "events"]);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const submitAdd = () => {
    install.mutate(
      { id: template.id, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      {
        onSuccess: () => toast.success(`Added ${template.name}`),
        onError: (error) => toast.error(error.message)
      }
    );
  };

  // Save re-installs with the edited settings — the flat state, or the full
  // email-keyed map for per-account templates (idempotent per-template
  // replace server-side — the jobId changes, and the invalidated templates
  // query re-resolves the page onto the new job). The current job's
  // cronTimezone rides along so the schedule's timezone is preserved.
  const submitSave = (settings: RoutineSettings | Record<string, RoutineSettings>) => {
    install.mutate(
      {
        id: template.id,
        settings,
        timezone: job?.cronTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
      },
      {
        onSuccess: () => toast.success("Settings saved"),
        onError: (error) => toast.error(error.message)
      }
    );
  };

  const submitDelete = () => {
    uninstall.mutate(template.id, {
      onSuccess: () => {
        toast.success(`Removed ${template.name}`);
        router.push("/routines");
      },
      onError: (error) => toast.error(error.message)
    });
  };

  const tabs = [
    { key: "sessions" as const, label: "Recent sessions" },
    ...(template.settings.length > 0 ? [{ key: "settings" as const, label: "Settings" }] : []),
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
              {installed ? (
                <HeroToggle
                  on={installed.status === "active"}
                  disabled={action.isPending}
                  onClick={() =>
                    action.mutate({ id: installed.jobId, op: installed.status === "active" ? "pause" : "resume" })
                  }
                />
              ) : (
                <button
                  type="button"
                  disabled={install.isPending}
                  onClick={submitAdd}
                  className="inline-flex h-[30px] shrink-0 items-center rounded-full bg-white/90 px-4 text-xs font-semibold transition-opacity hover:opacity-90 disabled:opacity-50"
                  style={{ color }}
                >
                  Add
                </button>
              )}
            </div>
            <span className="flex-1" />
            <div className="text-[11px] font-semibold tracking-[0.6px] text-white/70">CREATED BY GINI</div>
            <div className="mt-2 text-[19px] font-bold text-white">{template.name}</div>
            <div className="mt-2 text-[13px] leading-normal text-white/85">{template.description}</div>
          </div>

          {installed ? (
            <div className="mt-5 flex flex-col gap-0.5">
              <button
                type="button"
                disabled={action.isPending}
                onClick={() => action.mutate({ id: installed.jobId, op: "run" })}
                className="flex items-center gap-3 rounded-lg px-2 py-2.5 text-left text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50"
              >
                <PlayIcon className="size-[17px] text-muted-foreground" aria-hidden />
                Run Now
              </button>
              {installed.chatSessionId ? (
                // The routine's dedicated conversation when the template
                // delivers into Chats (same idiom as the watcher detail's
                // Open channel).
                <button
                  type="button"
                  onClick={() => router.push(`/chat?session=${encodeURIComponent(installed.chatSessionId!)}`)}
                  className="flex items-center gap-3 rounded-lg px-2 py-2.5 text-left text-sm font-medium transition-colors hover:bg-muted"
                >
                  <MessageSquareIcon className="size-[17px] text-muted-foreground" aria-hidden />
                  Open messages
                </button>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* Right column */}
        <div className="min-w-0 flex-1">
          <h1 className="text-[26px] font-bold tracking-tight">{template.name}</h1>
          <p className="mt-2.5 max-w-[640px] text-[15px] leading-relaxed text-muted-foreground">
            {template.description}
          </p>

          {installed ? (
            <>
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

              {tab === "sessions" ? (
                <SessionsTab jobId={installed.jobId} />
              ) : tab === "settings" ? (
                // Keyed by jobId: a Save re-installs onto a fresh job, and the
                // remount reseeds the fields from the newly persisted settings.
                <SettingsTab
                  key={installed.jobId}
                  template={template}
                  pending={install.isPending}
                  onSave={submitSave}
                  activeAccount={settingsAccount}
                  onSelectAccount={setSettingsAccount}
                />
              ) : (
                <InfoTab
                  template={template}
                  job={job}
                  deletePending={uninstall.isPending}
                  onDelete={submitDelete}
                />
              )}
            </>
          ) : (
            <div className="mt-8 flex flex-col items-center rounded-xl border border-dashed border-border bg-card/50 px-6 py-14 text-center">
              <p className="text-sm font-medium">Not added yet</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Add this routine and Gini runs it on a schedule ({template.scheduleHint.toLowerCase()}).
              </p>
              <Button size="sm" className="mt-4" disabled={install.isPending} onClick={submitAdd}>
                Add routine
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// The hero card's enable pill (design's on-tint / off-tint over the chip
// color). On = the job is active; toggling pauses/resumes it.
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

// Owns the runs query so it only fetches while the tab is mounted (and never
// falls back to the unscoped /job-runs list when nothing is installed).
function SessionsTab({ jobId }: { jobId: string }) {
  const runs = useJobRuns(jobId);
  const loading = runs.isLoading;
  const sorted = (runs.data ?? []).slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return (
    <div>
      <h2 className="mt-6 text-[17px] font-semibold">Recent sessions</h2>
      {loading ? (
        <div className="mt-4 text-sm text-muted-foreground">Loading…</div>
      ) : sorted.length === 0 ? (
        <div className="mt-4">
          <EmptyState title="No sessions yet" description="Runs appear here after the routine fires." />
        </div>
      ) : (
        <div className="mt-2 flex flex-col">
          {sorted.map((run) => (
            <div key={run.id} className="flex items-center gap-5 border-b border-border/60 px-1 py-[11px]">
              <span className="w-[78px] shrink-0 text-[13px] text-muted-foreground">
                {formatRelativeTime(run.createdAt)}
              </span>
              <span className="shrink-0 text-sm capitalize">
                {run.status === "running" ? "Running" : run.trigger === "manual" ? "Manual run" : run.status}
              </span>
              {run.summary || run.error ? (
                <>
                  <span className="text-muted-foreground/55">|</span>
                  <span className={cn("min-w-0 truncate text-sm", run.error ? "text-destructive" : "text-muted-foreground")}>
                    {run.error ?? run.summary}
                  </span>
                </>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// The swatch palette for labels added in the editor, cycled by list
// position — the same eight design hexes the runtime catalog defaults use
// (LABEL_COLOR_PALETTE in packages/runtime/src/runtime/routine-templates.ts).
const LABEL_COLOR_PALETTE = ["#4277FB", "#12B5C4", "#F5820A", "#1FA463", "#EC6B9E", "#9B7DF0", "#7DA9FB", "#E8A317"];

// The state the editor considers "saved": the installed job's
// server-normalized settings (defaults filled, legacy installs mapped), or
// the catalog defaults for a job predating settings provenance.
function baselineSettings(template: RoutineTemplateView): RoutineSettings {
  return (
    template.installed?.settings ??
    Object.fromEntries(template.settings.flatMap((section) => section.fields.map((field) => [field.key, field.defaultValue])))
  );
}

// Canonical serialization for dirty tracking: deep-compare in catalog field
// order, so key insertion order never fakes (or masks) a dirty state.
function serializeSettings(template: RoutineTemplateView, settings: RoutineSettings): string {
  return JSON.stringify(
    template.settings.flatMap((section) =>
      section.fields.map((field) => {
        const value = settings[field.key];
        return Array.isArray(value)
          ? value.map((label) => [label.name, label.color, label.rule, label.autoArchive])
          : value;
      })
    )
  );
}

function SettingsTab({
  template,
  pending,
  onSave,
  activeAccount,
  onSelectAccount
}: {
  template: RoutineTemplateView;
  pending: boolean;
  onSave: (settings: RoutineSettings | Record<string, RoutineSettings>) => void;
  activeAccount: string | undefined;
  onSelectAccount: (email: string) => void;
}) {
  // Per-account templates (Auto-inbox) get the account switcher; flat
  // templates — and a per-account install on a machine with no registered
  // account (the server omits accountSettings then) — keep the flat editor.
  const accounts = template.installed?.accountSettings;
  if (accounts && accounts.length > 0) {
    return (
      <PerAccountSettingsTab
        template={template}
        accounts={accounts}
        pending={pending}
        onSave={onSave}
        activeAccount={activeAccount}
        onSelectAccount={onSelectAccount}
      />
    );
  }
  return <FlatSettingsTab template={template} pending={pending} onSave={onSave} />;
}

function FlatSettingsTab({
  template,
  pending,
  onSave
}: {
  template: RoutineTemplateView;
  pending: boolean;
  onSave: (settings: RoutineSettings) => void;
}) {
  const [values, setValues] = useState<RoutineSettings>(() => ({ ...baselineSettings(template) }));
  const setField = (key: string, value: RoutineSettings[string]) =>
    setValues((current) => ({ ...current, [key]: value }));
  const dirty = serializeSettings(template, values) !== serializeSettings(template, baselineSettings(template));

  return (
    <div className="mt-6">
      <div className="flex flex-col gap-4">
        {template.settings.map((section) => (
          <SettingsSection key={section.key} section={section} values={values} onChange={setField} />
        ))}
      </div>
      <Button size="sm" className="mt-4" disabled={!dirty || pending} onClick={() => onSave(values)}>
        {pending ? "Saving…" : "Save"}
      </Button>
    </div>
  );
}

// Per-account settings (the design's account switcher): the server joins one
// settings state per connected Google account, the switcher scopes the
// sections below to one account while edits accumulate across all of them,
// and Save posts the FULL email-keyed map — the wire's per-account shape.
// The selection is owned by the parent (it must survive the Save remount);
// absent or stale (a disconnected account), it falls back to the primary.
function PerAccountSettingsTab({
  template,
  accounts,
  pending,
  onSave,
  activeAccount,
  onSelectAccount
}: {
  template: RoutineTemplateView;
  accounts: RoutineAccountSettingsView[];
  pending: boolean;
  onSave: (settings: Record<string, RoutineSettings>) => void;
  activeAccount: string | undefined;
  onSelectAccount: (email: string) => void;
}) {
  const activeEmail = accounts.some((account) => account.email === activeAccount)
    ? activeAccount!
    : (accounts.find((account) => account.primary) ?? accounts[0]!).email;
  const [values, setValues] = useState<Record<string, RoutineSettings>>(() =>
    Object.fromEntries(accounts.map((account) => [account.email, { ...account.settings }]))
  );
  const setField = (key: string, value: RoutineSettings[string]) =>
    setValues((current) => ({ ...current, [activeEmail]: { ...current[activeEmail], [key]: value } }));
  const dirty = accounts.some(
    (account) =>
      serializeSettings(template, values[account.email] ?? {}) !== serializeSettings(template, account.settings)
  );

  return (
    <div className="mt-6">
      <div className="flex flex-wrap items-center gap-2">
        {accounts.map((account) => {
          const active = account.email === activeEmail;
          return (
            <button
              key={account.email}
              type="button"
              aria-pressed={active}
              onClick={() => onSelectAccount(account.email)}
              className={cn(
                "inline-flex h-9 items-center gap-2 rounded-full border pl-2 pr-3.5 text-[13px] transition-colors",
                active
                  ? "border-foreground bg-foreground font-semibold text-background"
                  : "border-input bg-card font-medium text-muted-foreground hover:border-foreground/28 hover:text-foreground"
              )}
            >
              <span
                className={cn(
                  "flex size-[22px] shrink-0 items-center justify-center rounded-full text-[11px] font-bold",
                  active ? "bg-background text-foreground" : "bg-muted text-muted-foreground"
                )}
              >
                {account.email.charAt(0).toUpperCase()}
              </span>
              {account.email}
            </button>
          );
        })}
      </div>
      <p className="mb-4 mt-2.5 text-[13px] text-muted-foreground">
        Settings below apply only to <span className="font-semibold text-foreground">{activeEmail}</span>. Each
        connected email account has its own settings.
      </p>
      <div className="flex flex-col gap-4">
        {template.settings.map((section) => (
          <SettingsSection
            key={section.key}
            section={section}
            values={values[activeEmail] ?? {}}
            onChange={setField}
          />
        ))}
      </div>
      <Button size="sm" className="mt-4" disabled={!dirty || pending} onClick={() => onSave(values)}>
        {pending ? "Saving…" : "Save"}
      </Button>
    </div>
  );
}

// One collapsible per-function card (the design's "Label new mail" section):
// title + chevron header, then the section's fields divided by hairlines.
function SettingsSection({
  section,
  values,
  onChange
}: {
  section: RoutineSettingsSection;
  values: RoutineSettings;
  onChange: (key: string, value: RoutineSettings[string]) => void;
}) {
  const [open, setOpen] = useState(true);
  const Chevron = open ? ChevronUpIcon : ChevronDownIcon;
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center justify-between gap-3 px-[22px] py-5 text-left"
      >
        <span className="text-base font-semibold">{section.title}</span>
        <Chevron className="size-[18px] text-muted-foreground" aria-hidden />
      </button>
      {open ? (
        <div className="px-[22px] pb-6 pt-1">
          <div className="divide-y divide-border">
            {section.fields.map((field) => (
              <div key={field.key} className="py-5 first:pt-1.5 last:pb-0">
                <SettingField field={field} value={values[field.key]} onChange={(value) => onChange(field.key, value)} />
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SettingField({
  field,
  value,
  onChange
}: {
  field: RoutineSettingField;
  value: RoutineSettings[string] | undefined;
  onChange: (value: RoutineSettings[string]) => void;
}) {
  if (field.kind === "toggle") {
    const on = typeof value === "boolean" ? value : field.defaultValue;
    return (
      <div className="flex items-start justify-between gap-5">
        <div className="min-w-0">
          <div className="text-sm font-semibold">{field.label}</div>
          {field.description ? (
            <div className="mt-1.5 max-w-[480px] text-[13px] leading-normal text-muted-foreground">
              {field.description}
            </div>
          ) : null}
        </div>
        <SettingToggle on={on} label={field.label} onClick={() => onChange(!on)} />
      </div>
    );
  }
  if (field.kind === "text") {
    return (
      <div>
        <div className="text-sm font-semibold">{field.label}</div>
        {field.description ? (
          <div className="mt-1 text-[13px] leading-normal text-muted-foreground">{field.description}</div>
        ) : null}
        <Textarea
          className="mt-3"
          value={typeof value === "string" ? value : field.defaultValue}
          placeholder={field.placeholder}
          aria-label={field.label}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
    );
  }
  return (
    <div>
      <div className="text-sm font-semibold">{field.label}</div>
      {field.description ? (
        <div className="mt-1 text-[13px] leading-normal text-muted-foreground">{field.description}</div>
      ) : null}
      <LabelListEditor value={Array.isArray(value) ? value : field.defaultValue} onChange={onChange} />
    </div>
  );
}

// The filtering-label editor: one bordered card per label (swatch, muted
// name-input pill, read-only Existing/Suggested provenance badge when the
// seed tagged one, Auto-archive mini toggle, remove) with the rule textarea
// in a padded wrapper below — both editable areas share the muted-pill
// hover/primary-focus treatment — then the 44px Add new label row appending
// with a cycled palette color.
function LabelListEditor({
  value,
  onChange
}: {
  value: RoutineLabelRule[];
  onChange: (labels: RoutineLabelRule[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const update = (index: number, label: RoutineLabelRule) =>
    onChange(value.map((current, i) => (i === index ? label : current)));
  const addLabel = () => {
    const name = draft.trim();
    if (!name) return;
    onChange([
      ...value,
      { name, color: LABEL_COLOR_PALETTE[value.length % LABEL_COLOR_PALETTE.length]!, rule: "", autoArchive: false }
    ]);
    setDraft("");
  };
  // The pill treatment the design gives every editable area in a label card:
  // muted fill with a transparent border, darkening on hover, and lifting to
  // a background fill with the primary ring on focus.
  const editablePill =
    "rounded-[8px] border border-transparent bg-muted outline-none transition hover:bg-foreground/6 focus:border-primary focus:bg-background focus:ring-[3px] focus:ring-primary/18";
  return (
    <div className="mt-3.5 flex flex-col gap-3">
      {value.map((label, index) => (
        <div
          key={index}
          className="rounded-lg border border-border bg-card transition hover:border-foreground/20 hover:shadow-[0_1px_2px_rgba(21,23,28,0.05)]"
        >
          <div className="flex items-center gap-2 px-2.5 py-2">
            <span className="mx-1 size-3.5 shrink-0 rounded-[4px]" style={{ backgroundColor: label.color }} aria-hidden />
            <input
              value={label.name}
              placeholder="Label name"
              aria-label="Label name"
              onChange={(event) => update(index, { ...label, name: event.target.value })}
              className={cn("min-w-0 flex-1 px-[9px] py-1.5 text-sm font-semibold", editablePill)}
            />
            {label.origin ? (
              <span
                className={cn(
                  "shrink-0 rounded px-1.5 text-[11px] text-muted-foreground",
                  label.origin === "existing" ? "bg-muted" : "border border-input bg-transparent"
                )}
              >
                {label.origin === "existing" ? "Existing" : "Suggested"}
              </span>
            ) : null}
            <span className="ml-1 shrink-0 text-[13px] text-muted-foreground">Auto-archive</span>
            <MiniToggle
              on={label.autoArchive}
              label={`Auto-archive ${label.name}`}
              onClick={() => update(index, { ...label, autoArchive: !label.autoArchive })}
            />
            <button
              type="button"
              aria-label={`Remove ${label.name}`}
              onClick={() => onChange(value.filter((_, i) => i !== index))}
              className="flex size-[26px] shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <XIcon className="size-4" aria-hidden />
            </button>
          </div>
          <div className="px-2.5 pb-2.5">
            <textarea
              value={label.rule}
              aria-label={`Rule for ${label.name}`}
              rows={1}
              onChange={(event) => update(index, { ...label, rule: event.target.value })}
              className={cn(
                "block field-sizing-content w-full resize-none px-3 py-2.5 text-[13px] leading-normal text-foreground/80 focus:text-foreground",
                editablePill
              )}
            />
          </div>
        </div>
      ))}
      <div className="flex items-center gap-2.5">
        <input
          value={draft}
          placeholder="Add new label..."
          aria-label="Add new label"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              addLabel();
            }
          }}
          className="h-11 min-w-0 flex-1 rounded-lg border border-input bg-card px-3.5 text-sm outline-none transition hover:border-foreground/28 focus:border-primary focus:ring-[3px] focus:ring-primary/18"
        />
        <button
          type="button"
          aria-label="Add label"
          disabled={!draft.trim()}
          onClick={addLabel}
          className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-input bg-card text-muted-foreground transition-colors hover:border-primary hover:bg-primary hover:text-primary-foreground disabled:pointer-events-none disabled:opacity-50"
        >
          <PlusIcon className="size-[18px]" aria-hidden />
        </button>
      </div>
    </div>
  );
}

// The label card's 40×23 Auto-archive toggle (the design's smaller variant
// of SettingToggle).
function MiniToggle({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "relative h-[23px] w-10 shrink-0 rounded-full transition-colors",
        on ? "bg-foreground" : "bg-foreground/25"
      )}
    >
      <span
        className={cn(
          "absolute top-[2.5px] size-[18px] rounded-full transition-all",
          on ? "left-[19.5px] bg-background" : "left-[2.5px] bg-white"
        )}
      />
    </button>
  );
}

function SettingToggle({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "relative mt-0.5 h-[25px] w-11 shrink-0 rounded-full transition-colors",
        on ? "bg-foreground" : "bg-foreground/25"
      )}
    >
      <span
        className={cn(
          "absolute top-[3px] size-[19px] rounded-full transition-all",
          on ? "left-[22px] bg-background" : "left-[3px] bg-white"
        )}
      />
    </button>
  );
}

function InfoTab({
  template,
  job,
  deletePending,
  onDelete
}: {
  template: RoutineTemplateView;
  job: JobRecord | undefined;
  deletePending: boolean;
  onDelete: () => void;
}) {
  const rows: Array<[string, string]> = [
    ["Created by", "Gini"],
    ["Schedule", template.scheduleHint],
    ["Skills", job?.skillNames?.join(", ") ?? "—"],
    ["Last run", job?.lastRunAt ? formatRelativeTime(job.lastRunAt) : "Never"]
  ];
  return (
    <div className="mt-6">
      <h2 className="text-[17px] font-semibold">Information</h2>
      <div className="mt-2 flex flex-col">
        {rows.map(([key, value]) => (
          <div key={key} className="flex items-center justify-between gap-4 border-b border-border py-[15px]">
            <span className="text-sm text-muted-foreground">{key}</span>
            <span className="text-sm font-semibold">{value}</span>
          </div>
        ))}
      </div>
      <RoutineTools jobId={job?.id} />
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

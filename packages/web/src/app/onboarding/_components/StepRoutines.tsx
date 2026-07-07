"use client";

import { toast } from "sonner";
import { CalendarCheckIcon, CheckIcon, InboxIcon, SunriseIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useApplyOnboardingRoutines } from "@/lib/queries";
import { PrimaryPill, serif } from "./bits";
import type { RoutinesState } from "./lib";

// Step 2 — starter routines. Toggle state lives in the page-level wizard
// state (not here): this step unmounts on 2 → 3 navigation, so local state
// would silently reset the user's choices when they navigate back. Continue
// POSTs the state to /onboarding/routines, where the runtime composes the job
// prompts/crons (nothing product-owned is assembled in the browser).
export function StepRoutines({
  timezone,
  routines,
  onRoutines,
  onDone
}: {
  timezone: string;
  routines: RoutinesState;
  onRoutines: (update: (state: RoutinesState) => RoutinesState) => void;
  onDone: () => void;
}) {
  const apply = useApplyOnboardingRoutines();
  const { autoInbox, morningBriefing, meetingBriefing } = routines;
  const setAutoInbox = (patch: Partial<RoutinesState["autoInbox"]>) =>
    onRoutines((s) => ({ ...s, autoInbox: { ...s.autoInbox, ...patch } }));
  const setMorningBriefing = (patch: Partial<RoutinesState["morningBriefing"]>) =>
    onRoutines((s) => ({ ...s, morningBriefing: { ...s.morningBriefing, ...patch } }));
  const setMeetingBriefing = (patch: Partial<RoutinesState["meetingBriefing"]>) =>
    onRoutines((s) => ({ ...s, meetingBriefing: { ...s.meetingBriefing, ...patch } }));

  const submit = () => {
    apply.mutate(
      { timezone, autoInbox, morningBriefing, meetingBriefing },
      {
        onSuccess: onDone,
        onError: (error) => toast.error(error.message)
      }
    );
  };

  return (
    <div className="flex flex-col gap-5 px-6 pb-8 pt-1 sm:px-8">
      <header className="flex flex-col gap-2">
        <h1 className={`${serif} text-[27px]/[31px] font-semibold sm:text-[30px]/[33px]`}>
          Routines to get you started
        </h1>
        <p className="text-[15px]/[22px] text-[#6B6B66]">
          Toggle any on or off — you can change these later.
        </p>
      </header>

      <div className="flex flex-col gap-3 rounded-[16px] bg-[#F6F6F1] p-3">
        <RoutineCard
          icon={InboxIcon}
          iconBg="bg-[#3554D1]"
          title="Auto-inbox"
          description="Your inbox, organized without the work."
          enabled={autoInbox.enabled}
          onEnabled={(enabled) => setAutoInbox({ enabled })}
        >
          <div
            className={cn(
              "flex flex-col",
              !autoInbox.enabled && "pointer-events-none opacity-40"
            )}
          >
            <CheckRow
              label="Label new mail"
              checked={autoInbox.labelNewMail}
              onChange={(labelNewMail) => setAutoInbox({ labelNewMail })}
            />
            <CheckRow
              label="Archive unimportant emails"
              checked={autoInbox.archiveUnimportant}
              onChange={(archiveUnimportant) => setAutoInbox({ archiveUnimportant })}
            />
            <CheckRow
              label="Assist with scheduling"
              checked={autoInbox.assistScheduling}
              onChange={(assistScheduling) => setAutoInbox({ assistScheduling })}
            />
            <CheckRow
              label="Draft replies to important emails"
              checked={autoInbox.draftReplies}
              onChange={(draftReplies) => setAutoInbox({ draftReplies })}
            />
          </div>
          <p className="text-[12px]/[17px] text-[#9A9A94]">
            These drafts can look like already-sent emails in an IMAP mail app and Superhuman, but
            Gini never sends without your review.
          </p>
        </RoutineCard>

        <RoutineCard
          icon={SunriseIcon}
          iconBg="bg-[#E8834A]"
          title="Morning Briefing"
          description="Start your day knowing exactly what matters."
          enabled={morningBriefing.enabled}
          onEnabled={(enabled) => setMorningBriefing({ enabled })}
        >
          <div
            className={cn(
              "flex flex-col",
              !morningBriefing.enabled && "pointer-events-none opacity-40"
            )}
          >
            <CheckRow
              label="Personalized news topics"
              checked={morningBriefing.personalizedNews}
              onChange={(personalizedNews) => setMorningBriefing({ personalizedNews })}
            />
          </div>
        </RoutineCard>

        <RoutineCard
          icon={CalendarCheckIcon}
          iconBg="bg-[#2E9E6B]"
          title="Meeting Briefing"
          description="Get meeting prep in email and Gini."
          enabled={meetingBriefing.enabled}
          onEnabled={(enabled) => setMeetingBriefing({ enabled })}
        />
      </div>

      <div className="flex justify-end">
        <PrimaryPill onClick={submit} pending={apply.isPending}>
          Continue
        </PrimaryPill>
      </div>
    </div>
  );
}

function RoutineCard({
  icon: Icon,
  iconBg,
  title,
  description,
  enabled,
  onEnabled,
  children
}: {
  icon: typeof InboxIcon;
  iconBg: string;
  title: string;
  description: string;
  enabled: boolean;
  onEnabled: (enabled: boolean) => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3.5 rounded-[12px] border border-[#E8E8E1] bg-white p-4">
      <div className="flex items-center gap-3.5">
        <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-[10px]", iconBg)}>
          <Icon className="size-5 text-white" strokeWidth={1.75} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-bold text-[#1A1A1A]">{title}</h2>
          <p className="text-[13px] text-[#6B6B66]">{description}</p>
        </div>
        <ToggleSwitch checked={enabled} onChange={onEnabled} label={title} />
      </div>
      {children}
    </div>
  );
}

function ToggleSwitch({
  checked,
  onChange,
  label
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "flex h-[26px] w-11 shrink-0 items-center rounded-full px-[3px] transition-colors",
        checked ? "justify-end bg-[#3554D1]" : "justify-start bg-[#E8E8E1]"
      )}
    >
      <span className="size-5 rounded-full bg-white shadow-sm" aria-hidden />
    </button>
  );
}

function CheckRow({
  label,
  checked,
  onChange
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex items-center gap-2.5 py-2 text-left"
    >
      <span
        className={cn(
          "flex size-[18px] shrink-0 items-center justify-center rounded-[5px]",
          checked ? "bg-[#1A1A1A]" : "border border-[#E8E8E1] bg-white"
        )}
        aria-hidden
      >
        {checked ? <CheckIcon className="size-3 text-white" strokeWidth={3} /> : null}
      </span>
      <span className={cn("text-[14px]", checked ? "text-[#1A1A1A]" : "text-[#9A9A94]")}>
        {label}
      </span>
    </button>
  );
}

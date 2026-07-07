"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import {
  ChevronDownIcon,
  CircleUserRoundIcon,
  GlobeIcon,
  MailIcon,
  PlugIcon,
  SlidersHorizontalIcon,
  SunIcon
} from "lucide-react";
import { useUpdateOnboarding } from "@/lib/queries";
import { PrimaryPill, serif } from "./bits";
import { timezoneLabel } from "./lib";

const INTRO_ROWS: Array<{ icon: typeof MailIcon; label: React.ReactNode }> = [
  { icon: CircleUserRoundIcon, label: "Gini learns the basics from your email and calendar" },
  { icon: SlidersHorizontalIcon, label: "You choose the routines you want running in the background" },
  { icon: PlugIcon, label: "Connect any extra apps and personalize your assistant" },
  {
    icon: MailIcon,
    label: (
      <>
        Gini <strong className="font-bold">never</strong> sends emails or messages without your approval
      </>
    )
  }
];

// Step 1 — welcome + timezone/theme. The CTA persists both via PATCH
// /onboarding and applies the theme app-wide through next-themes; the
// onboarding surface itself stays light (scoped palette).
export function StepWelcome({
  timezone,
  theme,
  onTimezone,
  onTheme,
  onDone
}: {
  timezone: string;
  theme: "light" | "dark";
  onTimezone: (zone: string) => void;
  onTheme: (theme: "light" | "dark") => void;
  onDone: () => void;
}) {
  const { setTheme } = useTheme();
  const patch = useUpdateOnboarding();
  // Populated on mount only: the SSR runtime's ICU timezone list can differ
  // from the browser's, so rendering it on the server causes a hydration
  // mismatch. Until the effect runs the select shows just the current value.
  const [zones, setZones] = useState<Array<{ zone: string; label: string }>>([]);
  useEffect(() => {
    setZones(Intl.supportedValuesOf("timeZone").map((zone) => ({ zone, label: timezoneLabel(zone) })));
  }, []);

  const submit = () => {
    patch.mutate(
      { timezone, theme },
      {
        onSuccess: () => {
          setTheme(theme);
          onDone();
        },
        onError: (error) => toast.error(error.message)
      }
    );
  };

  return (
    <div className="flex flex-col gap-6 px-8 pb-10 pt-5 sm:px-14">
      <header className="flex flex-col gap-3.5">
        <h1 className={`${serif} text-[32px]/[36px] font-semibold sm:text-[38px]/[40px]`}>
          Let&rsquo;s get started.
        </h1>
        <p className="text-[15px]/[23px] text-[#6B6B66]">
          We&rsquo;ll take this step by step. In the next few minutes, Gini will learn the basics,
          suggest useful routines, and let you tune what it can do.
        </p>
      </header>

      <ul className="flex flex-col gap-[18px]">
        {INTRO_ROWS.map(({ icon: Icon, label }, i) => (
          <li key={i} className="flex items-center gap-3.5">
            <Icon className="size-5 shrink-0 text-[#1A1A1A]" strokeWidth={1.75} aria-hidden />
            <span className="text-[15px] text-[#1A1A1A]">{label}</span>
          </li>
        ))}
      </ul>

      <div className="flex flex-col rounded-[14px] border border-[#E8E8E1] bg-[#F6F6F1] px-4 py-2">
        <SettingRow icon={GlobeIcon} label="Time zone">
          <PillSelect
            ariaLabel="Time zone"
            value={timezone}
            onChange={onTimezone}
            options={
              zones.length > 0
                ? zones.map(({ zone, label }) => ({ value: zone, label }))
                : timezone
                  ? [{ value: timezone, label: timezoneLabel(timezone) }]
                  : []
            }
          />
        </SettingRow>
        <SettingRow icon={SunIcon} label="Theme">
          <PillSelect
            ariaLabel="Theme"
            value={theme}
            onChange={(value) => onTheme(value as "light" | "dark")}
            options={[
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" }
            ]}
          />
        </SettingRow>
      </div>

      <PrimaryPill className="w-full py-4" onClick={submit} disabled={!timezone} pending={patch.isPending}>
        Let&rsquo;s get started
      </PrimaryPill>
    </div>
  );
}

function SettingRow({
  icon: Icon,
  label,
  children
}: {
  icon: typeof GlobeIcon;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <div className="flex items-center gap-3">
        <Icon className="size-[18px] shrink-0 text-[#6B6B66]" strokeWidth={1.75} aria-hidden />
        <span className="text-[14px] font-medium text-[#1A1A1A]">{label}</span>
      </div>
      {children}
    </div>
  );
}

// Native select styled as the design's white dropdown pill. Native (not the
// shadcn Select) on purpose: the timezone list is 400+ entries (type-ahead and
// scrolling come free), and the popover renders OS-side, so it needs no
// theming to stay light when the app theme is dark.
function PillSelect({
  value,
  onChange,
  options,
  ariaLabel
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  ariaLabel: string;
}) {
  return (
    <div className="relative min-w-0">
      <select
        aria-label={ariaLabel}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full max-w-[240px] appearance-none truncate rounded-[9px] border border-[#E8E8E1] bg-white py-2 pl-3 pr-8 text-[13px] font-medium text-[#1A1A1A] outline-none focus-visible:ring-2 focus-visible:ring-[#1A1A1A]/15"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDownIcon
        className="pointer-events-none absolute right-2.5 top-1/2 size-[15px] -translate-y-1/2 text-[#9A9A94]"
        aria-hidden
      />
    </div>
  );
}

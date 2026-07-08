import { CalendarCheckIcon, InboxIcon, MailSearchIcon, SunriseIcon, type LucideIcon } from "lucide-react";

// Icon-key → presentation mapping for the catalog's `icon` hints, shared by
// the gallery and the routine detail page. Chip colors come from the
// GiniRoutines design handoff (Auto-inbox blue, Morning Briefing gold,
// Meeting Briefing green); unknown keys fall back to the inbox treatment.
export interface RoutineChip {
  icon: LucideIcon;
  color: string;
}

const CHIPS: Record<string, RoutineChip> = {
  inbox: { icon: InboxIcon, color: "#4277FB" },
  sunrise: { icon: SunriseIcon, color: "#E8A317" },
  "calendar-check": { icon: CalendarCheckIcon, color: "#1FA463" }
};

export function chipFor(icon: string): RoutineChip {
  return CHIPS[icon] ?? CHIPS.inbox!;
}

// Chip for email-watcher routines (created conversationally, not from the
// catalog) — the design handoff's chip-cyan.
export const WATCHER_CHIP: RoutineChip = { icon: MailSearchIcon, color: "#12B5C4" };

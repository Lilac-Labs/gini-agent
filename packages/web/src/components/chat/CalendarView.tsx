"use client";

import { CalendarClock } from "lucide-react";
import { cn } from "@/lib/utils";
import type { EventColor } from "@/components/calendar/calendar-colors";
import {
  buildWeekDays,
  type CalendarEvent,
  dayKey,
  formatRange
} from "@/components/calendar/calendar-utils";
import { WeekView } from "@/components/calendar/week-view";

// Inline calendar preview. The agent emits a ```calendar fenced block when it
// proposes, reschedules, or cancels a timed event (most often while drafting an
// email about a meeting); MarkdownContent routes that block here so the user can
// SEE the proposed slot against their existing agenda for the week and spot any
// conflict, instead of being handed a wall of text.
//
// The block is plain text: optional `view:` / `date:` / `tz:` header lines up to
// the first blank line, then pipe-delimited event lines. The preview always
// renders the shared 7-day WeekView (the same macOS-Calendar-style grid the Routines
// tab uses) for the week containing the anchor, read-only — there is no Apply
// affordance; the real calendar write still goes through Gini's normal flow.

type Status = "proposed" | "cancel" | "existing";

type CalEvent = {
  date: string; // YYYY-MM-DD
  allDay: boolean;
  startMin: number; // minutes from midnight (0 for all-day)
  endMin: number;
  title: string;
  status: Status;
};

export type ParsedCalendar = {
  view: "day" | "week";
  anchor: string | null; // YYYY-MM-DD, or null when no dated events exist
  tz?: string;
  events: CalEvent[];
};

// Compact hour-row height for the inline preview. The viewport below is sized to
// 12 of these rows so the 8 AM–8 PM window is fully visible by default while
// scrolling still reveals the earlier/later hours. (Routines use the grid's 96px.)
const INLINE_HOUR_PX = 44;

const HEADER_KEYS = ["view", "date", "tz"] as const;

function normalizeStatus(raw: string | undefined): Status {
  const s = (raw ?? "").trim().toLowerCase();
  if (s === "proposed" || s === "new") return "proposed";
  if (s === "cancel" || s === "canceled" || s === "cancelled" || s === "removed") return "cancel";
  return "existing";
}

// minutes from midnight, or null if not a valid HH:MM
function parseHM(hm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

// Parse the time-spec field (field 0). Returns null when it doesn't match any
// recognized shape, so the caller can skip the whole line (lenient parsing).
function parseTimeSpec(
  spec: string,
  anchor: string | null
): { date: string; allDay: boolean; startMin: number; endMin: number } | null {
  const dateMatch = /^(\d{4}-\d{2}-\d{2})\s+(.*)$/.exec(spec);
  const date = dateMatch ? dateMatch[1]! : anchor;
  const rest = dateMatch ? dateMatch[2]!.trim() : spec;
  if (!date) return null; // no explicit date and no anchor to default to
  if (rest.toLowerCase() === "all-day") {
    return { date, allDay: true, startMin: 0, endMin: 0 };
  }
  const range = /^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/.exec(rest);
  if (!range) return null;
  const startMin = parseHM(range[1]!);
  const endMin = parseHM(range[2]!);
  if (startMin === null || endMin === null || endMin <= startMin) return null;
  return { date, allDay: false, startMin, endMin };
}

export function parseCalendar(raw: string): ParsedCalendar {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const header: Partial<Record<(typeof HEADER_KEYS)[number], string>> = {};

  // Header section: leading `key: value` lines until the first blank line. Only
  // consumed when the very first non-empty line is a recognized header — else the
  // whole block is treated as event lines (no header).
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === "") i++; // skip leading blanks
  const firstMatch = i < lines.length ? /^([A-Za-z]+):\s*(.*)$/.exec(lines[i]!) : null;
  const firstKey = firstMatch?.[1]?.toLowerCase();
  const hasHeader = !!firstKey && (HEADER_KEYS as readonly string[]).includes(firstKey);
  if (hasHeader) {
    for (; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.trim() === "") {
        i++; // consume the blank separator
        break;
      }
      const m = /^([A-Za-z]+):\s*(.*)$/.exec(line);
      const key = m?.[1]?.toLowerCase();
      if (m && key && (HEADER_KEYS as readonly string[]).includes(key)) {
        header[key as (typeof HEADER_KEYS)[number]] = m[2]!.trim();
        continue;
      }
      // The first non-recognized-header line ends the header. Leave i pointing at
      // it (don't consume) so it's parsed as an event line — agents often emit
      // event lines straight after the header with no blank separator.
      break;
    }
  } else {
    i = 0; // no header — every line is an event line
  }

  // First pass: pull the raw fields so the anchor can be resolved before times
  // that default to it are finalized.
  const rawEvents: Array<{ spec: string; title: string; status: string }> = [];
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    const parts = line.split("|").map((p) => p.trim());
    if (parts.length < 2 || parts[1] === "") continue; // needs a time spec + title
    rawEvents.push({ spec: parts[0]!, title: parts[1]!, status: parts[2] ?? "" });
  }

  // Anchor: explicit `date:` header, else the earliest explicitly-dated event,
  // else null (the no-dated-events placeholder branch).
  const datedDates = rawEvents
    .map((e) => /^(\d{4}-\d{2}-\d{2})\b/.exec(e.spec)?.[1])
    .filter((d): d is string => !!d)
    .sort();
  const headerDate = header.date && /^\d{4}-\d{2}-\d{2}$/.test(header.date) ? header.date : undefined;
  const anchor = headerDate ?? datedDates[0] ?? null;

  const events: CalEvent[] = [];
  for (const e of rawEvents) {
    const ts = parseTimeSpec(e.spec, anchor);
    if (!ts) continue; // a line that doesn't parse is skipped
    events.push({ ...ts, title: e.title, status: normalizeStatus(e.status) });
  }

  const headerView = header.view?.toLowerCase();
  const view: "day" | "week" =
    headerView === "day" || headerView === "week"
      ? headerView
      : anchor && events.every((e) => e.date === anchor)
        ? "day"
        : "week";

  return { view, anchor, tz: header.tz, events };
}

// ── Adapter: parsed events → generic grid events ───────────────────────────────

// A local Date for a YYYY-MM-DD day so dayKey() (which reads local
// getFullYear/Month/Date) lines up with the shared grid's day buckets.
function ymdToLocal(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y!, m! - 1, d!);
}

// Inline preview colors are driven by status, not by a per-id palette: proposed
// → accent (blue), cancel → muted (gray), existing → gray.
const STATUS_COLOR: Record<Status, EventColor> = {
  proposed: "blue",
  cancel: "gray",
  existing: "gray"
};

function adaptEvent(e: CalEvent, index: number): CalendarEvent {
  const day = ymdToLocal(e.date);
  const status = e.status === "existing" ? undefined : e.status;
  return {
    day,
    key: `${e.date}-${index}`,
    title: e.title,
    hour: e.allDay ? null : Math.floor(e.startMin / 60),
    minute: e.allDay ? null : e.startMin % 60,
    endHour: e.allDay ? null : Math.floor(e.endMin / 60),
    endMinute: e.allDay ? null : e.endMin % 60,
    sortKey: e.allDay ? Number.POSITIVE_INFINITY : e.startMin,
    timeLabel: "",
    color: STATUS_COLOR[e.status],
    status
  };
}

export function CalendarView({ raw }: { raw: string }) {
  const parsed = parseCalendar(raw.trim());
  const { anchor, tz, events } = parsed;

  // No dated events at all → placeholder. Keep this branch minimal.
  if (!anchor) {
    return (
      <div className="my-2 overflow-hidden rounded-xl border bg-card text-card-foreground">
        <div className="flex items-center gap-2 border-b px-3 py-2 text-muted-foreground">
          <CalendarClock className="size-[15px] shrink-0" aria-hidden="true" />
          <span className="text-[12px] font-semibold uppercase tracking-wide">Calendar</span>
        </div>
        <div className="px-3 py-3 text-[13px] text-muted-foreground">No events to preview.</div>
      </div>
    );
  }

  // Always render the 7-day week containing the anchor. The anchor day is
  // circled (passed as the grid's `today`) so the proposed day stands out.
  const anchorDate = ymdToLocal(anchor);
  const days = buildWeekDays(anchorDate);

  const eventsByDay = new Map<string, CalendarEvent[]>();
  events.forEach((e, index) => {
    const adapted = adaptEvent(e, index);
    const key = dayKey(adapted.day);
    const list = eventsByDay.get(key) ?? [];
    list.push(adapted);
    eventsByDay.set(key, list);
  });

  const range = `${formatRange(days[0]!, days[6]!)}${tz ? ` · ${tz}` : ""}`;

  return (
    <div className="my-2 overflow-hidden rounded-xl border bg-card text-card-foreground">
      <div className="flex items-center gap-2 border-b px-3 py-2 text-muted-foreground">
        <CalendarClock className="size-[15px] shrink-0" aria-hidden="true" />
        <span className="text-[12px] font-semibold uppercase tracking-wide">Calendar</span>
        <span className="ml-auto text-[12px] font-medium text-foreground">{range}</span>
      </div>

      {/* Fixed-height viewport sized to exactly the 8 AM–8 PM window (12 rows ×
          INLINE_HOUR_PX) so that range fills the card; scrolling reveals the rest. */}
      <div className="flex flex-col overflow-hidden" style={{ height: `${12 * INLINE_HOUR_PX}px` }}>
        <WeekView
          days={days}
          today={anchorDate}
          eventsByDay={eventsByDay}
          scrollToHour={8}
          hourPx={INLINE_HOUR_PX}
          dense
        />
      </div>
    </div>
  );
}

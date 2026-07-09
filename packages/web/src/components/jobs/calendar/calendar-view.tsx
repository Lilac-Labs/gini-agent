"use client";

import React from "react";

import type {
  CalendarJob as CronJob,
  CalendarRunEntry as CronRunLogEntry,
  CalendarStatus as CronStatus
} from "@/components/calendar/types";
import { assignJobColors } from "@/components/calendar/calendar-colors";
import {
  addDays,
  addMonths,
  buildEventsForDays,
  buildMonthDays,
  buildRunStatusMap,
  buildWeekDays,
  type CalendarEvent,
  type CalendarViewMode,
  startOfDay,
  startOfMonth
} from "@/components/calendar/calendar-utils";
import { DayView } from "@/components/calendar/day-view";
import { MonthView } from "@/components/calendar/month-view";
import { WeekView } from "@/components/calendar/week-view";
import { CalendarHeader } from "./calendar-header";
import { EventDetailDialog } from "./event-detail-dialog";

interface CalendarViewProps {
  status: CronStatus | null;
  jobs: CronJob[];
  runs: CronRunLogEntry[];
  loading: boolean;
  error: string | null;
  onRefresh: () => Promise<void>;
  highlightJobId?: string | null;
  onHighlightConsumed?: () => void;
}

export function CalendarView({
  status,
  jobs,
  runs,
  loading,
  error,
  onRefresh,
  highlightJobId,
  onHighlightConsumed
}: CalendarViewProps) {
  const [today, setToday] = React.useState(() => startOfDay(new Date()));

  // Recompute `today` after midnight so highlights stay correct.
  // `today` is intentionally in the dep list so the timer re-arms each midnight.
  React.useEffect(() => {
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const msUntilMidnight = midnight.getTime() - now.getTime();
    const timer = setTimeout(() => setToday(startOfDay(new Date())), msUntilMidnight + 500);
    return () => clearTimeout(timer);
  }, [today]);
  const [refreshing, setRefreshing] = React.useState(false);
  const [selectedEvent, setSelectedEvent] = React.useState<CalendarEvent | null>(null);
  const [viewMode, setViewMode] = React.useState<CalendarViewMode>("week");
  const [focusDate, setFocusDate] = React.useState<Date>(() => startOfDay(new Date()));

  const jobColors = React.useMemo(() => assignJobColors(jobs), [jobs]);

  // Auto-select a job when navigating from an external highlight signal.
  React.useEffect(() => {
    if (!highlightJobId || jobs.length === 0) return;
    const job = jobs.find((j) => j.id === highlightJobId);
    if (job) {
      setSelectedEvent({
        day: today,
        key: job.id,
        title: job.name || job.id,
        job,
        sortKey: 0,
        timeLabel: "",
        hour: null,
        minute: null,
        color: jobColors.get(job.id) ?? "gray"
      });
      onHighlightConsumed?.();
    }
  }, [highlightJobId, jobs, jobColors, onHighlightConsumed, today]);

  const activeDays = React.useMemo(() => {
    if (viewMode === "month") return buildMonthDays(focusDate);
    if (viewMode === "week") return buildWeekDays(focusDate);
    return [startOfDay(focusDate)];
  }, [focusDate, viewMode]);

  const runStatusMap = React.useMemo(() => buildRunStatusMap(runs), [runs]);

  const eventsByDay = React.useMemo(
    () =>
      buildEventsForDays(activeDays, jobs, {
        colors: jobColors,
        runStatusMap,
        onEventClick: setSelectedEvent
      }),
    [activeDays, jobs, jobColors, runStatusMap]
  );

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };

  const movePeriod = (direction: -1 | 1) => {
    setFocusDate((current) => {
      if (viewMode === "month") return addMonths(startOfMonth(current), direction);
      if (viewMode === "week") return addDays(current, 7 * direction);
      return addDays(current, direction);
    });
  };

  const handleDayClick = (date: Date) => {
    setFocusDate(startOfDay(date));
    setViewMode("day");
  };

  return (
    <div
      role="application"
      aria-label="Calendar"
      className="flex h-full flex-col overflow-hidden bg-card"
    >
      <CalendarHeader
        focusDate={focusDate}
        viewMode={viewMode}
        status={status}
        loading={loading}
        refreshing={refreshing}
        onPrev={() => movePeriod(-1)}
        onNext={() => movePeriod(1)}
        onToday={() => setFocusDate(startOfDay(new Date()))}
        onViewChange={setViewMode}
        onRefresh={handleRefresh}
      />

      {error && (
        <div className="mx-4 mb-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          {error}
        </div>
      )}

      {viewMode === "month" ? (
        <MonthView
          days={activeDays}
          focusDate={focusDate}
          today={today}
          eventsByDay={eventsByDay}
          onDayClick={handleDayClick}
        />
      ) : viewMode === "week" ? (
        <WeekView days={activeDays} today={today} eventsByDay={eventsByDay} />
      ) : (
        <DayView
          day={startOfDay(focusDate)}
          today={today}
          jobs={jobs}
          eventsByDay={eventsByDay}
          onDayChange={(date) => setFocusDate(startOfDay(date))}
        />
      )}

      <EventDetailDialog
        event={selectedEvent}
        color={selectedEvent ? (selectedEvent.color ?? "gray") : null}
        today={today}
        runStatusMap={runStatusMap}
        onClose={() => setSelectedEvent(null)}
      />
    </div>
  );
}

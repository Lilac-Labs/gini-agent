"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import type { CalendarStatus as CronStatus } from "@/components/calendar/types";
import {
  type CalendarViewMode,
  formatMonthAbbrev,
  getHeaderSubtitle,
  getHeaderTitle
} from "@/components/calendar/calendar-utils";

interface CalendarHeaderProps {
  focusDate: Date;
  viewMode: CalendarViewMode;
  status: CronStatus | null;
  loading: boolean;
  refreshing: boolean;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  onViewChange: (mode: CalendarViewMode) => void;
  onRefresh: () => void;
}

export function CalendarHeader({
  focusDate,
  viewMode,
  status,
  loading,
  refreshing,
  onPrev,
  onNext,
  onToday,
  onViewChange,
  onRefresh
}: CalendarHeaderProps) {
  const title = getHeaderTitle(viewMode, focusDate);
  const subtitle = getHeaderSubtitle(viewMode, focusDate);

  return (
    <div className="relative flex flex-col gap-4 bg-card px-7 py-5">
      <div className="flex flex-col items-start justify-between gap-4 md:flex-row">
        {/* Left: Date badge + title */}
        <div className="flex items-start gap-3">
          {/* Date badge */}
          <div className="inline-flex min-w-16 flex-col items-center overflow-hidden rounded-lg ring-1 ring-border">
            <div className="flex w-full justify-center bg-muted/50 px-2 pt-1 pb-0.5">
              <span className="text-xs font-semibold text-muted-foreground">
                {formatMonthAbbrev(focusDate)}
              </span>
            </div>
            <div className="flex w-full justify-center bg-card px-2 pt-px pb-[3px]">
              <span className="text-lg font-bold leading-7 text-primary">
                {focusDate.getDate()}
              </span>
            </div>
          </div>

          {/* Title + date range */}
          <div className="flex flex-col gap-0.5">
            <div className="text-lg font-semibold text-foreground">{title}</div>
            <span className="text-sm text-muted-foreground">{subtitle}</span>
          </div>
        </div>

        {/* Right: Navigation + View Switcher + Refresh */}
        <div className="flex flex-wrap items-center gap-3">
          {/* Prev / Next */}
          <div className="inline-flex overflow-hidden rounded-lg shadow-xs ring-1 ring-border">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-9 rounded-none border-r border-border px-2.5"
              onClick={onPrev}
            >
              <ChevronLeft className="h-4 w-4" />
              <span className="sr-only">Previous</span>
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-9 rounded-none border-r border-border px-2.5"
              onClick={onNext}
            >
              <ChevronRight className="h-4 w-4" />
              <span className="sr-only">Next</span>
            </Button>
          </div>

          {/* Today */}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 px-3 text-sm font-medium"
            onClick={onToday}
          >
            Today
          </Button>

          {/* View dropdown */}
          <Select value={viewMode} onValueChange={(v) => onViewChange(v as CalendarViewMode)}>
            <SelectTrigger className="h-9 w-[130px] text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="month">Month view</SelectItem>
              <SelectItem value="week">Week view</SelectItem>
              <SelectItem value="day">Day view</SelectItem>
            </SelectContent>
          </Select>

          {/* Refresh */}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 px-3 text-sm font-medium"
            onClick={onRefresh}
            disabled={loading || refreshing}
          >
            {loading || refreshing ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
      </div>

      {/* Status badges */}
      <div className="flex flex-wrap gap-2">
        <Badge
          className={
            status?.enabled
              ? "border-green-300 bg-green-50 text-green-800 text-xs dark:border-green-900 dark:bg-green-950/40 dark:text-green-200"
              : "border-red-300 bg-red-50 text-red-800 text-xs dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
          }
        >
          Auto-run {status?.enabled ? "On" : "Off"}
        </Badge>
      </div>

      {/* Bottom border */}
      <div className="pointer-events-none absolute bottom-0 left-0 w-full border-t border-border" />
    </div>
  );
}

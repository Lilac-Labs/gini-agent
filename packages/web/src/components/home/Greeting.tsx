"use client";

import Link from "next/link";
import { Calendar } from "lucide-react";
import { useHome } from "@/lib/queries";
import { useMounted } from "@/lib/use-mounted";

// Time-of-day split per the home design: morning < 12, afternoon < 17,
// evening otherwise.
function timeOfDayGreeting(hour: number): string {
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

// The home greeting: muted day-of-week row (with a "View schedule" link to
// /routines — the scheduled-work surface) over the big time-of-day salutation.
// All `new Date()` reads are mount-gated so SSR markup never bakes in the
// server's clock/timezone; the name comes from the gateway's optional
// owner setting (never derived from an email local-part).
export function Greeting() {
  const mounted = useMounted();
  const home = useHome();
  const now = mounted ? new Date() : null;
  const dayName = now ? now.toLocaleDateString(undefined, { weekday: "long" }) : " ";
  const greeting = now ? timeOfDayGreeting(now.getHours()) : "Good evening";
  const firstName = home.data?.owner?.firstName;
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>{dayName}</span>
        <span className="opacity-50">·</span>
        <Link
          href="/routines"
          className="inline-flex items-center gap-[5px] transition-colors hover:text-foreground"
        >
          <Calendar className="size-[13px]" />
          View schedule
        </Link>
      </div>
      <h1 className="text-[28px] font-semibold tracking-[-0.01em] text-foreground">
        {firstName ? `${greeting}, ${firstName}.` : `${greeting}.`}
      </h1>
    </div>
  );
}

import { cn } from "@/lib/utils";

export type ChatTab = "messages" | "jobs";

interface TabSpec {
  id: ChatTab;
  label: string;
  count?: number;
  countLabel?: string;
}

// Chat tab bar — design `i2BaA`. The active tab gets a 2px white bottom
// border; inactive labels are muted. Routines carries an optional count pill.
// Underline lives on the label row so it hugs the text width like the
// design. Routines is a per-agent surface; the caller hides it on channels (which
// can show another agent's session), so its visibility flag is passed
// separately.
export function ChatTabBar({
  active,
  onChange,
  jobCount,
  hideJobsTab,
  hideWhenSingleTab
}: {
  active: ChatTab;
  onChange: (tab: ChatTab) => void;
  jobCount?: number;
  hideJobsTab?: boolean;
  hideWhenSingleTab?: boolean;
}) {
  const tabs: TabSpec[] = [
    { id: "messages", label: "Chat" },
    ...(hideJobsTab ? [] : [{ id: "jobs", label: "Routines", count: jobCount } as TabSpec])
  ];
  if (hideWhenSingleTab && tabs.length <= 1) return null;

  return (
    <div className="flex shrink-0 items-end gap-1.5 border-b border-border px-7">
      {tabs.map((tab) => {
        const isActive = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onChange(tab.id)}
            className={cn(
              "flex items-center gap-2 px-3 py-3.5 text-[13px] font-semibold transition-colors",
              isActive
                ? "border-b-2 border-foreground text-foreground"
                : "border-b-2 border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {tab.label}
            {tab.count ? (
              <span className="flex items-center justify-center rounded-full border border-border bg-muted px-1.5 py-px text-[11px] font-bold text-foreground">
                {tab.count}
                {tab.countLabel ? <span className="sr-only"> {tab.countLabel}</span> : null}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

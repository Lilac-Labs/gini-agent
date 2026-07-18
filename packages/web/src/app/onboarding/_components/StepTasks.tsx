"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { CheckIcon, PaperclipIcon, PlusIcon, TimerIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { useInvalidate, useOnboarding, useUpdateOnboarding } from "@/lib/queries";
import { LightPill, PrimaryPill } from "./bits";
import { adoptScanSuggestions, removeSeededItem, seedTaskBody, suggestedTasksFrom } from "./lib";

interface TaskItem {
  text: string;
  checked: boolean;
}

// Step 5 — seed starter tasks. Only concrete Gmail-scan suggestions become
// checked rows; a missing, failed, or empty scan never becomes generic work.
// A scan that turns ready while this step is up (useOnboarding keeps polling
// while it runs) replaces the empty snapshot with inbox-derived suggestions —
// but only until the user touches the list (custom add or seeding); after that
// their state wins. "Add N tasks" POSTs each checked row to
// /containers (startedAs "task"), so each seeded task is a task container
// that surfaces on the task-first home; then marks onboarding completed and
// leaves the funnel. "Skip" completes without seeding.
export function StepTasks() {
  const router = useRouter();
  const invalidate = useInvalidate();
  const { data } = useOnboarding();
  const patch = useUpdateOnboarding();
  const [items, setItems] = useState<TaskItem[]>(() =>
    suggestedTasksFrom(data?.scan).map((text) => ({ text, checked: true }))
  );
  const [draft, setDraft] = useState("");
  const [touched, setTouched] = useState(false);
  const checkedCount = items.filter((item) => item.checked).length;

  // The composer's placeholder cycles through the suggested tasks (the
  // design shows one inline as an example of what to type). Only visible
  // while the input is empty; the interval keeps running harmlessly.
  const [placeholderIndex, setPlaceholderIndex] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setPlaceholderIndex((i) => i + 1), 3500);
    return () => clearInterval(timer);
  }, []);
  const placeholder = items.length > 0 ? items[placeholderIndex % items.length].text : "";

  const scan = data?.scan;
  // Once per step visit: if the snapshot was taken from a ready scan the
  // suggestions are already inbox-derived, otherwise the first ready poll
  // result fills the list (unless the user got there first).
  const adopted = useRef(scan?.status === "ready");
  useEffect(() => {
    if (adopted.current) return;
    const suggestions = adoptScanSuggestions(scan, touched);
    if (!suggestions) return;
    adopted.current = true;
    setItems(suggestions.map((text) => ({ text, checked: true })));
  }, [scan, touched]);

  const finish = (message?: string) =>
    patch.mutate(
      { completed: true },
      {
        onSuccess: () => {
          if (message) toast.success(message);
          router.replace("/");
        },
        onError: (error) => toast.error(error.message)
      }
    );

  const seed = useMutation({
    mutationFn: async (tasks: string[]) => {
      for (const content of tasks) {
        // Same contract as the home composer (useStartTask): each row starts
        // a task container, so it shows up on the task-first home.
        await api("/containers", {
          method: "POST",
          body: JSON.stringify(seedTaskBody(content))
        });
        // Drop the item the moment its POST lands, so a retry after a
        // mid-sequence failure only sends the remainder instead of
        // re-creating the tasks that already succeeded.
        setItems((prev) => removeSeededItem(prev, content));
      }
    },
    onSuccess: (_, tasks) => {
      invalidate(["home", "tasks", "chat"]);
      finish(`${tasks.length} ${tasks.length === 1 ? "task" : "tasks"} added — Gini is getting to work.`);
    },
    onError: (error: Error) => toast.error(error.message)
  });

  const addDraft = () => {
    const text = draft.trim();
    if (!text) return;
    setTouched(true);
    setItems((prev) => [...prev, { text, checked: true }]);
    setDraft("");
  };

  const toggle = (index: number) => {
    setTouched(true);
    setItems((prev) => prev.map((item, i) => (i === index ? { ...item, checked: !item.checked } : item)));
  };

  const pending = seed.isPending || patch.isPending;

  return (
    <>
      <div className="flex flex-col gap-5 px-6 pb-6 pt-1 sm:px-8">
        <header className="flex flex-col gap-2">
          <h1 className="text-[22px]/[28px] font-bold text-[#1A1A1A]">
            Tasks are how Ginis get work done
          </h1>
          <p className="text-[15px]/[22px] text-[#6B6B66]">
            Give your Gini clear work to do, then track progress as it works through each task.
          </p>
        </header>

        <div className="flex flex-col gap-3 rounded-[14px] border border-[#E8E8E1] bg-white p-3.5 shadow-[0_4px_14px_0_rgba(0,0,0,0.05)]">
          <div className="flex items-start gap-3">
            <span
              className="mt-0.5 size-5 shrink-0 rounded-[6px] border-[1.5px] border-[#E8E8E1] bg-white"
              aria-hidden
            />
            <input
              aria-label="Add your own task"
              value={draft}
              placeholder={placeholder}
              disabled={seed.isPending}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") addDraft();
              }}
              className="min-w-0 flex-1 bg-transparent text-[16px]/[22px] text-[#1A1A1A] outline-none placeholder:text-[#9A9A94]"
            />
          </div>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5 text-[#9A9A94]">
              <TimerIcon className="size-4" aria-hidden />
              <PaperclipIcon className="size-4" aria-hidden />
            </div>
            <button
              type="button"
              aria-label="Add task to list"
              onClick={addDraft}
              disabled={!draft.trim() || seed.isPending}
              className="flex size-8 items-center justify-center rounded-full bg-[#1C1C1A] text-white transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              <PlusIcon className="size-4" aria-hidden />
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <p className="text-[14px] text-[#9A9A94]">Suggested starter tasks</p>
          {scan?.status === "running" ? (
            <p className="text-[13px] italic text-[#9A9A94]">
              Gini is still reading your inbox — suggestions will update when it finishes.
            </p>
          ) : scan && items.length === 0 ? (
            <p className="text-[13px] text-[#9A9A94]">
              Gini couldn&rsquo;t find a concrete starter task from your inbox. Add one above or skip for now.
            </p>
          ) : null}
          <ul className="flex flex-col">
            {items.map((item, index) => (
              <li key={`${item.text}-${index}`} className="border-b border-[#E8E8E1] last:border-b-0">
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={item.checked}
                  // Frozen while seeding: items drop out as each POST lands,
                  // so an index-based toggle mid-flight would hit the wrong
                  // (shifted) row.
                  disabled={seed.isPending}
                  onClick={() => toggle(index)}
                  className="flex w-full items-center gap-3.5 py-3 text-left"
                >
                  <span
                    className={cn(
                      "flex size-[22px] shrink-0 items-center justify-center rounded-full",
                      item.checked ? "bg-[#1C1C1A]" : "border-[1.5px] border-[#E8E8E1] bg-white"
                    )}
                    aria-hidden
                  >
                    {item.checked ? <CheckIcon className="size-3 text-white" strokeWidth={3} /> : null}
                  </span>
                  <span className="text-[15px] text-[#1A1A1A]">{item.text}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <footer className="flex items-center justify-between border-t border-[#E8E8E1] px-6 py-5 sm:px-8">
        <LightPill onClick={() => finish()} disabled={pending}>
          Skip
        </LightPill>
        <PrimaryPill
          onClick={() => {
            // Seeding counts as touching the list: the items are dropping out
            // as their POSTs land, and a late scan result must not replace
            // the in-flight list.
            setTouched(true);
            seed.mutate(items.filter((item) => item.checked).map((item) => item.text));
          }}
          disabled={checkedCount === 0}
          pending={pending}
          className="rounded-[12px] px-5 py-3"
        >
          Add {checkedCount} {checkedCount === 1 ? "task" : "tasks"}
        </PrimaryPill>
      </footer>
    </>
  );
}

"use client";

import { Loader2Icon } from "lucide-react";
import type { OnboardingProfileSection } from "@runtime/types";
import { useOnboarding } from "@/lib/queries";
import { LightPill, PrimaryPill, serif } from "./bits";
import { profileCardView, splitEmailSegments } from "./lib";

// Step 3 — the profile distilled from the Gmail scan. useOnboarding polls
// GET /onboarding every 2.5s while the scan is running (the GET finalizes the
// scan server-side), so this card flips to the profile on its own. Continue
// stays blocked (disabled) while the scan is still building the
// profile — the "loading" view — so the user waits for it instead of skipping
// past a half-built profile; it re-enables the moment the scan turns ready or
// falls back, so a slow or failed scan surfaces the fallback instead of
// trapping the user here. kickoffFailed reports the page's scan-kickoff
// mutation state: without it a failed kickoff would leave the scan "idle"
// forever and this card spinning with it. The fallback keeps the friendly copy
// but shows the scan error (when there is one) and a "Try again" wired to the
// same kickoff mutation, which resubmits a failed scan server-side.
// scanUnavailable (no provider configured — the user skipped the provider
// step) renders the connect-a-model state instead: no spinner (nothing will
// ever finish) and no "Try again" (a retry could only fail the same way).
export function StepProfile({
  kickoffFailed,
  scanUnavailable,
  onRetry,
  retryPending,
  onDone
}: {
  kickoffFailed: boolean;
  scanUnavailable: boolean;
  onRetry: () => void;
  retryPending: boolean;
  onDone: () => void;
}) {
  const { data } = useOnboarding();
  const scan = data?.scan;
  const view = profileCardView(scan, kickoffFailed, scanUnavailable);
  const profile = view === "profile" ? scan?.profile : undefined;

  return (
    <div className="flex flex-col gap-5 px-6 pb-8 pt-1 sm:px-8">
      {profile ? (
        <>
          <h1 className={`${serif} text-[24px]/[29px] font-medium sm:text-[27px]/[31px]`}>
            {profile.displayName}
          </h1>
          <div className="flex flex-col gap-5">
            {profile.sections.map((section) => (
              <ProfileSection key={section.title} section={section} />
            ))}
          </div>
        </>
      ) : view === "loading" ? (
        <div className="flex flex-col items-center gap-3 py-14 text-center">
          <Loader2Icon className="size-6 animate-spin text-[#9A9A94]" aria-hidden />
          <p className="text-[15px] font-medium text-[#1A1A1A]">
            Gini is learning from your work style…
          </p>
          <p className="text-[13px] text-[#9A9A94]">
            Creating a profile for you. This usually takes a minute.
          </p>
        </div>
      ) : view === "unavailable" ? (
        <div className="flex flex-col gap-3 py-10 text-center">
          <h1 className={`${serif} text-[24px]/[29px] font-medium`}>
            Here&rsquo;s what we know about you
          </h1>
          <p className="mx-auto max-w-md text-[15px]/[22px] text-[#6B6B66]">
            Connect a model first — Gini reads your inbox with it to build your profile.
            You can add a provider anytime in Settings, and Gini will learn as you use it.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3 py-10 text-center">
          <h1 className={`${serif} text-[24px]/[29px] font-medium`}>
            Here&rsquo;s what we know about you
          </h1>
          <p className="mx-auto max-w-md text-[15px]/[22px] text-[#6B6B66]">
            Gini couldn&rsquo;t finish reading your inbox yet — it will keep learning as you use it.
          </p>
          {scan?.error ? (
            <p className="mx-auto w-full max-w-md truncate text-[13px] text-[#9A9A94]" title={scan.error}>
              {scan.error}
            </p>
          ) : null}
          <div className="mt-1 flex justify-center">
            <LightPill onClick={onRetry} disabled={retryPending}>
              {retryPending ? "Retrying…" : "Try again"}
            </LightPill>
          </div>
        </div>
      )}

      <div className="flex justify-end">
        <PrimaryPill onClick={onDone} disabled={view === "loading"}>
          Continue
        </PrimaryPill>
      </div>
    </div>
  );
}

function ProfileSection({ section }: { section: OnboardingProfileSection }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-[15px] font-bold text-[#1A1A1A]">{section.title}</h2>
      {section.bullets && section.bullets.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {section.bullets.map((bullet, i) => (
            <li key={i} className="flex gap-3 text-[15px]/[23px] text-[#1A1A1A]">
              <span className="mt-[9px] size-[5px] shrink-0 rounded-full bg-[#C9C9C2]" aria-hidden />
              <span>
                {splitEmailSegments(bullet).map((segment, j) =>
                  segment.email ? (
                    <a
                      key={j}
                      href={`mailto:${segment.text}`}
                      className="text-[#3554D1] hover:underline"
                    >
                      {segment.text}
                    </a>
                  ) : (
                    <span key={j}>{segment.text}</span>
                  )
                )}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {section.note ? <p className="text-[15px]/[22px] text-[#6B6B66]">{section.note}</p> : null}
    </section>
  );
}

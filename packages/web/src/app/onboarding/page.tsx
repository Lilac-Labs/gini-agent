"use client";

import { useEffect, useRef, useState } from "react";
import { Fraunces } from "next/font/google";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronLeftIcon } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  useInvalidate,
  useOnboarding,
  useSetupStatus,
  useStartOnboardingScan,
  useUpdateOnboarding
} from "@/lib/queries";
import { Dots, serif } from "./_components/bits";
import {
  defaultRoutinesState,
  initialOnboardingStep,
  needsProviderStep,
  onboardingSteps,
  type OnboardingStep
} from "./_components/lib";
import { StepAccounts } from "./_components/StepAccounts";
import { StepProfile } from "./_components/StepProfile";
import { StepProvider } from "./_components/StepProvider";
import { StepRoutines } from "./_components/StepRoutines";
import { StepSignIn } from "./_components/StepSignIn";
import { StepTasks } from "./_components/StepTasks";
import { StepWelcome } from "./_components/StepWelcome";

// The design's serif display face, scoped to this tree: the variable class is
// applied on the page root only, so the rest of the app never sees Fraunces.
const fraunces = Fraunces({ subsets: ["latin"], variable: "--font-fraunces", display: "swap" });

// First-run onboarding flow (ADR web-onboarding-flow.md): prerequisite steps
// (sign-in, and — self-hosted with no provider configured — the
// capability-derived provider step) plus five dotted wizard steps in one
// client component tree, driven by the /api/onboarding endpoints. The Gmail
// profile scan (idempotent endpoint) is kicked off the moment its two
// prerequisites hold — Google access confirmed at sign-in's continue, and a
// provider to synthesize with (immediately when one is configured, from the
// provider step's save otherwise) — so it runs in the background through the
// welcome/routines steps and is usually ready by the profile step. The whole
// surface renders the design's light palette regardless of the app theme
// (hardcoded colors + light color-scheme; nothing reads the shadcn tokens).
export default function OnboardingPage() {
  const params = useSearchParams();
  const router = useRouter();
  const invalidate = useInvalidate();
  // The edge add-account flow leaves and re-enters this page in the same tab,
  // naming the step to resume via ?step= (the gate only lets an incomplete
  // record this far, so honoring the param can never skip a completed funnel
  // back open). Read once as the initial state; in-wizard navigation owns the
  // step from then on. Steps are held by NAME: the provider step joins the
  // sequence only when the setup-status probe resolves to "self-hosted and
  // unconfigured" (needsProviderStep), and that can happen after mount — a
  // numeric position could silently re-label the step the user is on.
  const [step, setStep] = useState<OnboardingStep>(() => initialOnboardingStep(params?.get("step")));
  const setupStatus = useSetupStatus();
  // True only on a definite "self-hosted and no provider configured" answer.
  // Gates both the provider step's presence and the scan kickoff (the scan's
  // synthesis calls need the model, so without a provider it could only fail).
  const scanUnavailable = needsProviderStep(setupStatus.data);
  const steps = onboardingSteps(scanUnavailable);
  // Deliberately empty until mounted: the browser's timezone (and Intl data in
  // general) can differ from the SSR runtime's, so resolving it during render
  // would make the server and client HTML disagree (hydration error). The
  // mount effect below fills it in before the user can interact.
  const [timezone, setTimezone] = useState("");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  // Step 2's toggle state lives here (not in StepRoutines): the step unmounts
  // when navigating 2 → 3, and a remount must re-render the user's choices —
  // a second Continue would otherwise silently revert them to the defaults.
  const [routines, setRoutines] = useState(defaultRoutinesState);
  const { data } = useOnboarding();

  useEffect(() => {
    setTimezone((current) => current || Intl.DateTimeFormat().resolvedOptions().timeZone);
  }, []);

  // A failed edge add-account round trip returns to this page with
  // ?googleAddError=1 (appended to whichever step it left from). Surface it
  // once per mount — the ref keeps a dev-mode double-mount from stacking two
  // toasts.
  const addErrorToasted = useRef(false);
  const googleAddError = params?.get("googleAddError") === "1";
  useEffect(() => {
    if (!googleAddError || addErrorToasted.current) return;
    addErrorToasted.current = true;
    toast.error("Couldn't add the Google account — please try again.");
    // One-shot in the URL too: strip the flag (keeping ?step= and the rest of
    // the query intact) so a manual refresh doesn't re-toast.
    const url = new URL(window.location.href);
    url.searchParams.delete("googleAddError");
    window.history.replaceState(null, "", url.toString());
  }, [googleAddError]);

  // Fired from step 0's continue and step 3's "Try again". Idempotent
  // server-side: running/ready scans are returned as-is, failed/no_account
  // resubmit, and a completed record is never scanned.
  const scan = useStartOnboardingScan();

  // A ?step= entry lands past sign-in and so skips its continue — the normal
  // scan kickoff. On a first-ever visit the scan would stay idle and the
  // profile step would spin forever, so kick it once here too (idempotent
  // server-side; the ref guards StrictMode's double mount). Entry-only by
  // design (the initial-step ref): in-wizard navigation already fires the
  // scan. The kick waits for the setup-status probe so a skipped-provider
  // funnel never submits a scan that could only fail (needsProviderStep); a
  // failed probe kicks anyway, matching the rest of the app's
  // treat-as-configured default.
  const enteredPastSignIn = useRef(step !== "signin");
  const stepParamScanKicked = useRef(false);
  useEffect(() => {
    if (!enteredPastSignIn.current || stepParamScanKicked.current) return;
    if (setupStatus.data === undefined && !setupStatus.isError) return;
    stepParamScanKicked.current = true;
    if (!needsProviderStep(setupStatus.data)) scan.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setupStatus.data, setupStatus.isError]);

  // The sign-in step's "Skip for now" (self-hosted only — managed sign-in IS
  // the session, so the page withholds it): complete onboarding minimally so
  // a user without a Google account still reaches the app. The browser
  // timezone (resolved by the mount effect above) rides along so the record
  // stays coherent for whatever reads it later (e.g. the routines endpoint's
  // fallback); theme keeps the app default. The PATCH response seeds the
  // ["onboarding"] cache (useUpdateOnboarding), so the onboarding gate sees
  // completed before the redirect lands.
  const managed = setupStatus.data?.managed === true;
  const patch = useUpdateOnboarding();
  const skipSignIn = () =>
    patch.mutate(
      { completed: true, ...(timezone ? { timezone } : {}) },
      {
        onSuccess: () => router.replace("/"),
        onError: (error) => toast.error(error.message)
      }
    );

  const stepIndex = steps.indexOf(step);
  // The dot index doubles as the "wizard proper" test: sign-in and the
  // provider step sit before "welcome" in the sequence, so their dot index is
  // negative — no header, no progress dots, no back chevron (dot 0, welcome,
  // hides the chevron too; back never leaves the dotted wizard).
  const dot = stepIndex - steps.indexOf("welcome");
  const next = () => setStep(steps[Math.min(stepIndex + 1, steps.length - 1)] ?? step);
  const back = () => setStep(steps[Math.max(stepIndex - 1, steps.indexOf("welcome"))] ?? step);

  const profileInitial =
    data?.scan.status === "ready" ? (data.scan.profile?.displayName.trim().charAt(0) ?? "") : "";

  return (
    <main
      className={cn(fraunces.variable, "relative min-h-screen bg-[#F4F4EE] text-[#1A1A1A]")}
      style={{ colorScheme: "light" }}
    >
      {step === "routines" ? (
        <div
          className={`${serif} absolute left-[72px] top-14 hidden w-[340px] text-[44px]/[46px] font-semibold lg:block`}
          aria-hidden
        >
          Organize your Everyday
        </div>
      ) : null}
      {step === "profile" ? (
        <div
          className={`${serif} absolute left-[72px] top-14 hidden w-[360px] text-[46px]/[52px] font-medium lg:block`}
          aria-hidden
        >
          Here&rsquo;s what we know about{" "}
          <span className="inline-flex items-center gap-3 align-baseline">
            <span className="inline-flex size-[38px] items-center justify-center rounded-full bg-[#7C6CF0] font-sans text-[17px] font-semibold text-white">
              {profileInitial}
            </span>
            you
          </span>
        </div>
      ) : null}

      <div className="relative flex min-h-screen items-center justify-center px-4 py-10">
        <section
          className={cn(
            "w-full overflow-hidden rounded-[22px] border border-[#E8E8E1] bg-white shadow-[0_18px_48px_-8px_rgba(26,26,26,0.14)]",
            step === "signin" ? "max-w-[480px]" : step === "provider" ? "max-w-[720px]" : "max-w-[640px]"
          )}
        >
          {dot >= 0 ? (
            <header
              className={cn(
                "flex items-center px-6 pb-4 pt-6 sm:px-8",
                step === "welcome" ? "justify-start sm:px-14" : "gap-3"
              )}
            >
              {dot > 0 ? (
                <button
                  type="button"
                  aria-label="Back"
                  onClick={back}
                  className="-ml-1 flex size-7 items-center justify-center rounded-full text-[#1A1A1A] transition-colors hover:bg-[#F6F6F1]"
                >
                  <ChevronLeftIcon className="size-[22px]" strokeWidth={1.75} />
                </button>
              ) : null}
              <Dots step={dot} className={dot > 0 ? "flex-1 justify-center pr-6" : undefined} />
            </header>
          ) : null}

          {step === "signin" ? (
            <StepSignIn
              onContinue={() => {
                // Google is confirmed. Kick the scan now unless the provider
                // step is about to ask for the model it needs — its save
                // kicks it instead.
                if (!scanUnavailable) scan.mutate();
                next();
              }}
              onSkip={managed ? undefined : skipSignIn}
              skipPending={patch.isPending}
            />
          ) : step === "provider" ? (
            <StepProvider
              onDone={() => {
                // A provider now exists: refresh the capability probe
                // (staleTime Infinity — the profile step's gating reads it)
                // and start the scan sign-in deferred, then enter the wizard
                // proper.
                invalidate(["setup-status"]);
                scan.mutate();
                next();
              }}
              onSkip={next}
            />
          ) : step === "welcome" ? (
            <StepWelcome
              timezone={timezone}
              theme={theme}
              onTimezone={setTimezone}
              onTheme={setTheme}
              onDone={next}
            />
          ) : step === "routines" ? (
            <StepRoutines timezone={timezone} routines={routines} onRoutines={setRoutines} onDone={next} />
          ) : step === "profile" ? (
            <StepProfile
              kickoffFailed={scan.isError}
              scanUnavailable={scanUnavailable}
              onRetry={() => scan.mutate()}
              retryPending={scan.isPending}
              onDone={next}
            />
          ) : step === "accounts" ? (
            <StepAccounts onDone={next} />
          ) : (
            <StepTasks />
          )}
        </section>
      </div>
    </main>
  );
}

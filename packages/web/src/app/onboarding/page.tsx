"use client";

import { useEffect, useRef, useState } from "react";
import { Fraunces } from "next/font/google";
import { useSearchParams } from "next/navigation";
import { ChevronLeftIcon } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useOnboarding, useStartOnboardingScan } from "@/lib/queries";
import { Dots, serif } from "./_components/bits";
import { defaultRoutinesState, initialOnboardingStep } from "./_components/lib";
import { StepAccounts } from "./_components/StepAccounts";
import { StepProfile } from "./_components/StepProfile";
import { StepRoutines } from "./_components/StepRoutines";
import { StepSignIn } from "./_components/StepSignIn";
import { StepTasks } from "./_components/StepTasks";
import { StepWelcome } from "./_components/StepWelcome";

// The design's serif display face, scoped to this tree: the variable class is
// applied on the page root only, so the rest of the app never sees Fraunces.
const fraunces = Fraunces({ subsets: ["latin"], variable: "--font-fraunces", display: "swap" });

// First-run onboarding flow (ADR web-onboarding-flow.md): a sign-in step plus
// five wizard steps in one client component tree, driven by the
// /api/onboarding endpoints. Step 0 confirms Google access and its continue
// action kicks off the Gmail profile scan (the endpoint is idempotent), so
// the scan runs in the background during steps 1–2 and is usually ready by
// step 3. The whole surface renders the design's light palette regardless of
// the app theme (hardcoded colors + light color-scheme; nothing reads the
// shadcn tokens).
export default function OnboardingPage() {
  const params = useSearchParams();
  // The edge add-account flow leaves and re-enters this page in the same tab,
  // naming the step to resume via ?step= (the gate only lets an incomplete
  // record this far, so honoring the param can never skip a completed funnel
  // back open). Read once as the initial state; in-wizard navigation owns the
  // step from then on.
  const [step, setStep] = useState(() => initialOnboardingStep(params?.get("step")));
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

  // A ?step= entry lands past step 0 and so skips its continue — the normal
  // scan kickoff. On a first-ever visit the scan would stay idle and step 3
  // would spin forever, so kick it once on mount too (idempotent server-side;
  // the ref guards StrictMode's double mount). Mount-only by design:
  // in-wizard navigation past step 0 already fires the scan.
  const stepParamScanKicked = useRef(false);
  useEffect(() => {
    if (step === 0 || stepParamScanKicked.current) return;
    stepParamScanKicked.current = true;
    scan.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const next = () => setStep((s) => Math.min(s + 1, 5));
  const back = () => setStep((s) => Math.max(s - 1, 1));

  const profileInitial =
    data?.scan.status === "ready" ? (data.scan.profile?.displayName.trim().charAt(0) ?? "") : "";

  return (
    <main
      className={cn(fraunces.variable, "relative min-h-screen bg-[#F4F4EE] text-[#1A1A1A]")}
      style={{ colorScheme: "light" }}
    >
      {step === 2 ? (
        <div
          className={`${serif} absolute left-[72px] top-14 hidden w-[340px] text-[44px]/[46px] font-semibold lg:block`}
          aria-hidden
        >
          Organize your Everyday
        </div>
      ) : null}
      {step === 3 ? (
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
            step === 0 ? "max-w-[480px]" : "max-w-[640px]"
          )}
        >
          {step > 0 ? (
            <header
              className={cn(
                "flex items-center px-6 pb-4 pt-6 sm:px-8",
                step === 1 ? "justify-start sm:px-14" : "gap-3"
              )}
            >
              {step > 1 ? (
                <button
                  type="button"
                  aria-label="Back"
                  onClick={back}
                  className="-ml-1 flex size-7 items-center justify-center rounded-full text-[#1A1A1A] transition-colors hover:bg-[#F6F6F1]"
                >
                  <ChevronLeftIcon className="size-[22px]" strokeWidth={1.75} />
                </button>
              ) : null}
              <Dots step={step - 1} className={step > 1 ? "flex-1 justify-center pr-6" : undefined} />
            </header>
          ) : null}

          {step === 0 ? (
            <StepSignIn
              onContinue={() => {
                scan.mutate();
                next();
              }}
            />
          ) : step === 1 ? (
            <StepWelcome
              timezone={timezone}
              theme={theme}
              onTimezone={setTimezone}
              onTheme={setTheme}
              onDone={next}
            />
          ) : step === 2 ? (
            <StepRoutines timezone={timezone} routines={routines} onRoutines={setRoutines} onDone={next} />
          ) : step === 3 ? (
            <StepProfile
              kickoffFailed={scan.isError}
              onRetry={() => scan.mutate()}
              retryPending={scan.isPending}
              onDone={next}
            />
          ) : step === 4 ? (
            <StepAccounts onDone={next} />
          ) : (
            <StepTasks />
          )}
        </section>
      </div>
    </main>
  );
}

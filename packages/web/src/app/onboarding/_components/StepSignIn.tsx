"use client";

import Image from "next/image";
import { useGoogleAccounts } from "@/lib/queries";
import { serif } from "./bits";
import { primaryAccountId, signInCta } from "./lib";
import { useConnectGoogleAccount, useReloginPrimary } from "./useConnectGoogleAccount";

// Step 0 — sign in with Google, always the first screen of an incomplete
// funnel (no dots, no back chevron). Google access is the app's top-level
// prerequisite, so this step adapts to the account registry (polled every 5s
// while mounted, so an account connected through the consent window appears
// on its own):
//   - a signed-in account exists → "Continue as <primary email>" kicks off
//     the profile scan (the moment Gini's Gmail access is confirmed) and
//     advances; "Use a different account" starts the connect flow.
//   - the primary's sign-in was REVOKED → "Sign-in expired — reconnect
//     <email>" runs the FULL sign-in flow (useReloginPrimary), the only path
//     that re-authorizes the SAME account. "Use a different account" still
//     offers the add flow as an escape hatch.
//   - no usable account → "Continue with Google" starts the connect flow;
//     once the account registers the button swaps to "Continue as".
// The connect flow is a same-tab OAuth round trip in both auth modes (edge's
// /auth/google/add or the gateway's loopback PKCE flow — see
// useConnectGoogleAccount), returning to /onboarding so the funnel restarts
// at this step with the fresh account visible.
// `onSkip` (self-hosted only — the page withholds it when managed, where the
// edge's Google sign-in is the session itself) renders a quiet "Skip for now"
// that completes onboarding minimally, so a user without a Google account
// still reaches the app; they can connect one later via settings or skills.
// The design's Microsoft button is omitted — no Microsoft integration exists.
export function StepSignIn({
  onContinue,
  onSkip,
  skipPending
}: {
  onContinue: () => void;
  onSkip?: () => void;
  skipPending?: boolean;
}) {
  const accounts = useGoogleAccounts({ refetchInterval: 5_000 });
  // Signin intent: the account this OAuth completes as becomes the persisted
  // primary, so "Use a different account" actually flips the step-0 card.
  const connect = useConnectGoogleAccount("/onboarding", "signin");
  const relogin = useReloginPrimary("/onboarding");
  const all = accounts.data ?? [];
  const cta = signInCta(all);
  const signedIn = all.filter((account) => account.signedIn);
  const primary = signedIn.find((account) => account.id === primaryAccountId(signedIn));
  // The revoked primary (signed out) — its email/tag labels the reconnect
  // button. Resolved against the FULL registry, not just the signed-in subset.
  const revokedPrimary = all.find((account) => account.id === primaryAccountId(all));

  return (
    <div className="flex flex-col items-center gap-7 px-7 pb-12 pt-12 text-center sm:px-10">
      <div className="flex items-center gap-2.5">
        <Image
          src="/gini-agent-logo.png"
          alt=""
          width={26}
          height={26}
          unoptimized
          className="size-[26px]"
        />
        <span className={`${serif} text-[21px] font-bold tracking-[0.22em]`}>GINI</span>
      </div>

      <h1 className="text-[17px] text-[#1A1A1A]">Sign in to Gini</h1>

      <div className="flex w-full flex-col items-center gap-3.5">
        {cta === "reconnect" ? (
          <>
            <GoogleButton onClick={relogin.connect} disabled={relogin.isPending}>
              Sign-in expired — reconnect {revokedPrimary?.email || revokedPrimary?.tag}
            </GoogleButton>
            <button
              type="button"
              onClick={connect.connect}
              disabled={connect.isPending}
              className="text-[13px] text-[#9A9A94] transition-colors hover:text-[#6B6B66] hover:underline disabled:opacity-50"
            >
              Use a different account
            </button>
          </>
        ) : cta === "continue" && primary ? (
          <>
            <GoogleButton onClick={onContinue}>
              Continue as {primary.email || primary.tag}
            </GoogleButton>
            <button
              type="button"
              onClick={connect.connect}
              disabled={connect.isPending}
              className="text-[13px] text-[#9A9A94] transition-colors hover:text-[#6B6B66] hover:underline disabled:opacity-50"
            >
              Use a different account
            </button>
          </>
        ) : (
          <GoogleButton
            onClick={connect.connect}
            disabled={connect.isPending || accounts.isPending}
          >
            Continue with Google
          </GoogleButton>
        )}
        {onSkip ? (
          <button
            type="button"
            onClick={onSkip}
            disabled={skipPending}
            className="text-[13px] text-[#9A9A94] transition-colors hover:text-[#6B6B66] hover:underline disabled:opacity-50"
          >
            Skip for now
          </button>
        ) : null}
      </div>
    </div>
  );
}

// White bordered pill with the Google "G", per the design's sign-in buttons.
function GoogleButton({
  children,
  onClick,
  disabled
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-center justify-center gap-2.5 rounded-[10px] border border-[#E8E8E1] bg-white px-4 py-3 text-[15px] font-medium text-[#1A1A1A] transition-colors hover:bg-[#FAFAF7] disabled:pointer-events-none disabled:opacity-50"
    >
      <GoogleG className="size-[18px] shrink-0" />
      <span className="truncate">{children}</span>
    </button>
  );
}

function GoogleG({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden>
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

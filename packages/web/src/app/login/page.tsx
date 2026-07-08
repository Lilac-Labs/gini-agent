"use client";

import { useEffect } from "react";
import Image from "next/image";
import { Fraunces } from "next/font/google";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { useGoogleAuthMode } from "@/lib/queries";

// Managed sign-in landing (ADR managed-deployment-mode.md). This page renders
// ONLY the sign-in affordance: the "Continue with Google" button is a plain
// same-tab, same-origin navigation to /auth/google, a route owned by the edge
// proxy that fronts a managed deployment. The edge terminates the OAuth
// handshake, mints the session, and routes the user into their agent — the
// app never implements auth itself, which is also why AppShell renders this
// route bare (no chrome, no gates; see AppShell.tsx).
//
// The page keys on the deployment's auth mode (GET /api/google/auth-mode,
// the seam ADR web-onboarding-flow.md introduced): "edge" means an edge
// fronts this app and /auth/google exists, so the card renders; "loopback"
// means self-hosted — there is nothing to sign in to, so redirect home.
//
// Visual language matches onboarding (StepSignIn): the light scoped palette,
// the serif wordmark, and the white bordered Google pill.

// The design's serif display face, scoped to this tree — same pattern as
// onboarding/page.tsx, so the rest of the app never sees Fraunces.
const fraunces = Fraunces({ subsets: ["latin"], variable: "--font-fraunces", display: "swap" });
const serif = "[font-family:var(--font-fraunces),Georgia,serif]";

export default function LoginPage() {
  const router = useRouter();
  const mode = useGoogleAuthMode().data?.mode;

  useEffect(() => {
    if (mode === "loopback") router.replace("/");
  }, [mode, router]);

  // Render nothing until the mode resolves: flashing the card at a
  // self-hosted user (or the blank shell at a managed one) would be worse
  // than a beat of empty background.
  if (mode !== "edge") return null;

  return (
    <main
      className={cn(fraunces.variable, "flex min-h-screen items-center justify-center bg-[#F4F4EE] px-4 py-10 text-[#1A1A1A]")}
      style={{ colorScheme: "light" }}
    >
      <section className="w-full max-w-[480px] overflow-hidden rounded-[22px] border border-[#E8E8E1] bg-white shadow-[0_18px_48px_-8px_rgba(26,26,26,0.14)]">
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

          {/* Same-origin, same-tab link — the edge handles the OAuth flow
              behind /auth/google and redirects back once a session exists. */}
          <a
            href="/auth/google"
            className="flex w-full items-center justify-center gap-2.5 rounded-[10px] border border-[#E8E8E1] bg-white px-4 py-3 text-[15px] font-medium text-[#1A1A1A] transition-colors hover:bg-[#FAFAF7]"
          >
            <GoogleG className="size-[18px] shrink-0" />
            <span className="truncate">Continue with Google</span>
          </a>
        </div>
      </section>
    </main>
  );
}

// The Google "G", per the design's sign-in buttons (same art as onboarding's
// StepSignIn, which keeps its copy private to its step).
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

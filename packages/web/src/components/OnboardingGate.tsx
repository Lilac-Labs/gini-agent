"use client";

import { useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useOnboarding } from "@/lib/queries";

// Render-blocking gate around the first-run onboarding flow (ADR
// web-onboarding-flow.md). AppShell wraps every authenticated route's content
// in it, and it renders nothing until the route is known to be the right one:
// no flash of the home chrome before an incomplete user lands on /onboarding,
// and no flash of the funnel for a user who already completed it.
//
//   - record still loading → render null (children stay hidden until the
//     funnel state is known);
//   - incomplete off /onboarding → render null while redirecting there;
//   - completed on /onboarding → render null while redirecting home;
//   - otherwise → render children.
//
// Two exemptions always render immediately and are never redirected:
//
//   - an explicit chat-session deep link (/chat with a `session` query
//     param) — a user following a direct link to a specific conversation
//     (e.g. from a notification) asked for that exact surface, and hijacking
//     (or blanking) it mid-funnel would strand them;
//   - /setup — provider setup must be reachable before onboarding, since the
//     wizard has no provider step: on a fresh instance the proxy bounces
//     / → /setup, and redirecting that into the funnel would leave no way to
//     ever configure a provider.
//
// Mounted only inside the authenticated chrome (AppShell), so the pre-auth
// /login page never fires the query.
export function OnboardingGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const router = useRouter();
  const { data } = useOnboarding();

  const onOnboarding =
    pathname === "/onboarding" || (pathname?.startsWith("/onboarding/") ?? false);
  const chatDeepLink = pathname === "/chat" && search?.get("session") != null;
  const exempt = chatDeepLink || pathname === "/setup";
  const misrouted = data ? (data.completed ? onOnboarding : !onOnboarding) : false;

  useEffect(() => {
    if (!data || exempt || !misrouted) return;
    router.replace(data.completed ? "/" : "/onboarding");
  }, [data, exempt, misrouted, router]);

  if (exempt) return <>{children}</>;
  if (!data || misrouted) return null;
  return <>{children}</>;
}

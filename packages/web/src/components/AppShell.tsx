"use client";

import { usePathname } from "next/navigation";
import { OnboardingGate } from "@/components/OnboardingGate";
import { MobileTopBar, Sidebar } from "@/components/Sidebar";

// The /login page is a pre-auth, standalone surface shown before a session
// exists. Wrapping it in the authenticated app chrome (Sidebar) fires
// /api/runtime/* queries that 401 without a session (console noise) and leaks
// app navigation onto the sign-in screen. So it renders bare; every other
// route gets the full shell.
//
// /onboarding is authenticated (providers/SSE stay mounted via the layout) but
// renders without the sidebar chrome: it's a focused first-run surface. The
// OnboardingGate WRAPS every authenticated route's content — including the
// whole shell, so an incomplete user never sees a flash of the home chrome
// before landing on /onboarding, and a completed user never flashes the
// funnel before being bounced back home.
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  // Exact /login (or its subpaths) only — not a broad prefix, so a future
  // route like /logins isn't accidentally treated as a bare page.
  if (
    pathname === "/login" ||
    pathname?.startsWith("/login/")
  ) {
    return <>{children}</>;
  }
  if (pathname === "/onboarding" || pathname?.startsWith("/onboarding/")) {
    return <OnboardingGate>{children}</OnboardingGate>;
  }
  return (
    <OnboardingGate>
      <div className="flex h-screen">
        <Sidebar />
        <div className="flex flex-1 flex-col overflow-hidden">
          <MobileTopBar />
          <main className="relative flex flex-1 flex-col overflow-hidden">
            {children}
          </main>
        </div>
      </div>
    </OnboardingGate>
  );
}

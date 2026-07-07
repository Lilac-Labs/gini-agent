"use client";

import { useGoogleAuthMode } from "@/lib/queries";
import { connectGoogleUrl, reloginPrimaryUrl } from "./lib";

// Google account connection, shared by the sign-in step and the accounts
// step. Both deployment auth modes (GET /api/google/auth-mode) are the same
// SAME-TAB OAuth round trip now: the tab leaves for Google's consent screen
// and comes back to `returnTo` — with `?googleAddError=1` appended on
// failure, which the onboarding page already toasts:
//
// - **edge** (hosted): `/auth/google/add` — the edge exchanges the code
//   server-side and provisions the account into the guest.
// - **loopback** (local): `/api/runtime/google/login/start` — the BFF injects
//   the gateway bearer and the gateway runs a Desktop-client PKCE flow whose
//   redirect URI is this same origin's `/api/runtime/google/login/callback`
//   (see connectGoogleUrl for why the page passes its origin along).
//
// `isPending` is true only until the mode resolves; `connect` is a no-op till
// then, so an early click can never fall through to the wrong flow.
//
// `intent` distinguishes what the completed OAuth does with the account:
// "signin" (the sign-in step) makes it the persisted primary, "add" (the
// accounts step, the default) never touches the primary — see connectGoogleUrl.
export function useConnectGoogleAccount(returnTo: string, intent: "signin" | "add" = "add") {
  const authMode = useGoogleAuthMode();
  const mode = authMode.data?.mode;

  return {
    connect: () => {
      if (!mode) return;
      window.location.assign(connectGoogleUrl(mode, returnTo, window.location.origin, intent));
    },
    isPending: !mode
  };
}

// Re-login for the REVOKED primary account. Mirrors useConnectGoogleAccount but
// targets reloginPrimaryUrl — always signin intent, so the healed account is
// re-persisted as the primary, and in edge mode an owner self-re-auth is
// upgraded to a baked-dir heal server-side (see reloginPrimaryUrl for why the
// add flow, not /auth/google, is the edge relogin path).
// Same-tab OAuth round trip returning to `returnTo`; `connect` is a no-op
// until the auth mode resolves.
export function useReloginPrimary(returnTo: string) {
  const authMode = useGoogleAuthMode();
  const mode = authMode.data?.mode;

  return {
    connect: () => {
      if (!mode) return;
      window.location.assign(reloginPrimaryUrl(mode, returnTo, window.location.origin));
    },
    isPending: !mode
  };
}

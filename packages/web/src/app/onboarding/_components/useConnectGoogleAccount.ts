"use client";

import { connectGoogleUrl, reloginPrimaryUrl } from "./lib";

// Google account connection, shared by the sign-in step and the accounts
// step. The tab leaves for Google's consent screen and comes back to
// `returnTo`, with `?googleAddError=1` appended on failure. The BFF injects
// the gateway bearer and the gateway runs a Desktop-client PKCE flow whose
// redirect URI is this same origin's `/api/runtime/google/login/callback`
// (see connectGoogleUrl for why the page passes its origin along).
// `intent` distinguishes what the completed OAuth does with the account:
// "signin" (the sign-in step) makes it the persisted primary, "add" (the
// accounts step, the default) never touches the primary — see connectGoogleUrl.
export function useConnectGoogleAccount(returnTo: string, intent: "signin" | "add" = "add") {
  return {
    connect: () => window.location.assign(connectGoogleUrl(returnTo, window.location.origin, intent)),
    isPending: false
  };
}

// Re-login for the REVOKED primary account. Mirrors useConnectGoogleAccount but
// targets reloginPrimaryUrl — always signin intent, so the healed account is
// re-persisted as the primary.
export function useReloginPrimary(returnTo: string) {
  return {
    connect: () => window.location.assign(reloginPrimaryUrl(returnTo, window.location.origin)),
    isPending: false
  };
}

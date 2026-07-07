// Google-OAuth login helpers for edge-fronted (managed) deployments. The edge
// runs the entire OAuth dance; the app just opens the edge's /auth/google in a
// system auth session and captures the session token the edge hands back via a
// gini://auth?token=… redirect. Storing that token as {baseUrl, token} is all
// the rest of the app needs — it's the same session token the browser gets as a
// cookie, just carried by redirect instead of Set-Cookie.
//
// These functions are pure (no react-native / expo imports) so the URL-building
// and redirect-parsing are unit-testable without a native runtime.

// The edge origin the app authenticates against, baked at build time via
// EXPO_PUBLIC_EDGE_BASE_URL (babel-preset-expo inlines EXPO_PUBLIC_* values).
// There is deliberately no default: unset (the self-hosted build) means the
// app has no hosted sign-in, and the auth gate routes signed-out users
// straight to the manual /setup connect screen instead of /login.
export const EDGE_BASE_URL: string | undefined =
  process.env.EXPO_PUBLIC_EDGE_BASE_URL || undefined;

// The URL the sign-in screen opens in the system auth session. ?mode=mobile
// tells the edge to hand the session token back via the gini:// redirect instead
// of setting a cookie. The edge fixes the redirect target server-side, so the
// client passes no redirect param (a page can't redirect the token elsewhere).
export function buildMobileAuthUrl(edgeBaseUrl: string): string {
  return `${edgeBaseUrl.replace(/\/+$/, "")}/auth/google?mode=mobile`;
}

// Extract the session token from the gini://auth?token=… redirect the edge
// returns. Returns null for a foreign scheme or a missing/blank token so the
// caller treats it as a failed sign-in rather than persisting a bogus token.
// Parses the query string directly (rather than via URL) to stay robust across
// custom-scheme quirks in URL polyfills.
export function parseOauthRedirect(redirectUrl: string): string | null {
  if (!redirectUrl.startsWith("gini://")) return null;
  const q = redirectUrl.indexOf("?");
  if (q < 0) return null;
  const token = new URLSearchParams(redirectUrl.slice(q + 1)).get("token");
  return token && token.length > 0 ? token : null;
}

// Revoke the session server-side on sign-out: POST /auth/mobile/logout deletes
// the sessions row at the edge, so the token is dead everywhere — not just
// forgotten by this device. Best-effort by design: sign-out must always
// complete locally, so a network failure (or a gateway without the endpoint —
// the self-hosted owner bearer isn't a revocable session) is swallowed.
// Injectable fetch keeps this unit-testable without a network.
export async function revokeEdgeSession(
  creds: { baseUrl: string; token: string } | null,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  if (!creds) return;
  try {
    await fetchImpl(`${creds.baseUrl.replace(/\/+$/, "")}/auth/mobile/logout`, {
      method: "POST",
      headers: { authorization: `Bearer ${creds.token}` }
    });
  } catch {
    // Best-effort — local sign-out proceeds regardless.
  }
}

// Next.js Proxy. Runs at the network boundary for every request not excluded
// by the matcher below. One responsibility:
//
//   Setup gate. If no provider is configured the operator is bounced to
//   /setup so the rest of the app doesn't render in a broken state.
//
// The Host classifier rejects requests whose Host is neither loopback nor a
// configured GINI_TRUSTED_ORIGINS entry, so a DNS-rebinding page pointed at
// an attacker-controlled hostname is 404'd before it reaches the BFF.

import { NextResponse, type NextRequest } from "next/server";
import { runtimeToken, runtimeUrl } from "@/lib/runtime";
import { parseTrustedOriginUrls } from "@/lib/trusted-origins";

const PROXY_STATUS_TIMEOUT_MS = 1500;

async function isProviderConfigured(): Promise<boolean | null> {
  const url = `${runtimeUrl()}/api/setup/status`;
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${runtimeToken()}` },
      signal: AbortSignal.timeout(PROXY_STATUS_TIMEOUT_MS)
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { providerConfigured?: unknown };
    return data.providerConfigured === true;
  } catch {
    return null;
  }
}

/** Per-request Host classifier. Two live lanes:
 *
 *  - `loopback`: the operator's own machine (`localhost` / `127.0.0.1` /
 *    `[::1]`). Pass through with the setup gate.
 *  - `trusted`: a stable hostname the operator listed in
 *    `GINI_TRUSTED_ORIGINS` (Tailscale, reverse proxy, whatever stable
 *    front they own). The BFF's CSRF guard handles origin equality on this
 *    lane.
 *
 *  Anything else returns `unknown` and 404s before the request reaches the
 *  app — defends against DNS-rebinding to an attacker-controlled hostname.
 *  See docs/adr/bff-trust-boundary.md. */
function classifyHost(hostHeader: string | null): "loopback" | "trusted" | "unknown" {
  if (!hostHeader) return "unknown";
  const lower = hostHeader.toLowerCase();
  const hostOnly = lower.includes("]")
    ? lower.slice(0, lower.lastIndexOf("]") + 1)
    : lower.includes(":") ? lower.slice(0, lower.indexOf(":")) : lower;
  if (hostOnly === "localhost" || hostOnly === "127.0.0.1" || hostOnly === "[::1]") {
    return "loopback";
  }
  // Share the env-var parse + validation with the BFF CSRF guard so the
  // two lanes can't drift apart on what counts as a valid entry (entries
  // with paths/queries/userinfo are rejected here as well as there, per
  // the same fail-loud-on-typo posture). The proxy matches the Host
  // header against `.host` (with default-port equivalence); the BFF
  // matches the Origin header against `${protocol}//${host}` — same
  // validated input, different match field.
  const allowlist = parseTrustedOriginUrls(process.env.GINI_TRUSTED_ORIGINS);
  if (allowlist) {
    for (const url of allowlist) {
      const entryHost = url.host.toLowerCase();
      if (hostMatches(lower, entryHost)) return "trusted";
    }
  }
  return "unknown";
}

/** Compare two Host header values applying the default-port equivalence rule
 *  the BFF trust boundary enforces (see docs/adr/bff-trust-boundary.md):
 *  `host` and `host:443` (HTTPS) or `host:80` (HTTP) are equivalent when
 *  one side omits the port. */
function hostMatches(inbound: string, candidate: string): boolean {
  if (inbound === candidate) return true;
  const splitPort = (h: string): { name: string; port: string | null } => {
    if (h.startsWith("[")) {
      const close = h.lastIndexOf("]");
      const name = h.slice(0, close + 1);
      const rest = h.slice(close + 1);
      return { name, port: rest.startsWith(":") ? rest.slice(1) : null };
    }
    const idx = h.indexOf(":");
    return idx < 0 ? { name: h, port: null } : { name: h.slice(0, idx), port: h.slice(idx + 1) };
  };
  const a = splitPort(inbound);
  const b = splitPort(candidate);
  if (a.name !== b.name) return false;
  const isDefault = (port: string | null) => port === null || port === "443" || port === "80";
  return isDefault(a.port) && isDefault(b.port);
}

function notFound(): NextResponse {
  return new NextResponse("Not found", { status: 404 });
}

function applyResponsePolicy(res: NextResponse): NextResponse {
  // Outbound clicks send only the origin, never the full path.
  res.headers.set("referrer-policy", "strict-origin");
  // Defense-in-depth against clickjacking: the control plane is never meant to
  // be framed, so send the deny-all anti-framing headers as a standard backstop.
  res.headers.set("x-frame-options", "DENY");
  res.headers.set("content-security-policy", "frame-ancestors 'none'");
  return res;
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const url = request.nextUrl.clone();
  const classification = classifyHost(request.headers.get("host"));

  if (classification === "unknown") {
    return notFound();
  }

  // Loopback + trusted lanes pass through; the BFF guard makes its own auth
  // decision via loopback-Host or the GINI_TRUSTED_ORIGINS allowlist.
  const next = NextResponse.next();
  // Setup gate runs ONLY on loopback — /setup is a localhost-only experience,
  // so a Tailscale-front caller hitting `/` should not be redirected there.
  // (When the gateway reverse-proxies the app it rewrites Host to loopback, so
  // gateway-fronted requests land on this lane too.) Redirect ONLY top-level
  // page navigations — never asset/subresource requests (images, JS chunks,
  // fetches), so e.g. /gini-agent-logo.png is served instead of 307'd to
  // /setup. Sec-Fetch-Dest=document marks a top-level navigation; clients that
  // omit the header fall back to the Accept: text/html heuristic.
  if (classification === "loopback") {
    const { pathname } = url;
    const dest = request.headers.get("sec-fetch-dest");
    const isPageNav = dest === "document"
      || (dest === null && (request.headers.get("accept") ?? "").includes("text/html"));
    if (
      isPageNav
      && !pathname.startsWith("/setup")
      && !pathname.startsWith("/api/")
    ) {
      const configured = await isProviderConfigured();
      if (configured === false) {
        // The gateway rewrites Host to loopback before proxying, so this absolute
        // redirect resolves to the loopback web port — which would point a remote
        // tunnel browser at its own 127.0.0.1. The gateway rewrites a loopback
        // Location back to a relative path on the way out (see src/http.ts
        // proxyWeb), so the browser resolves /setup against the origin it used
        // (relay or loopback).
        const setupUrl = new URL("/setup", request.url);
        return applyResponsePolicy(NextResponse.redirect(setupUrl));
      }
    }
  }
  return applyResponsePolicy(next);
}

export const config = {
  // Exclude Next.js static assets and the dev-mode HMR endpoint — the proxy
  // runs at request time and re-running for every /_next/static asset would
  // be wasteful. `_next/webpack-hmr` is the dev server's WebSocket upgrade
  // path; intercepting it as an HTTP request breaks the upgrade handshake.
  // The path doesn't exist in production builds. The match intentionally
  // covers `/api/*` so the Host classifier 404s unknown-host BFF calls too.
  // `icon.png` is the Next.js 16 metadata-route filename for the site
  // favicon — public logo bytes, no sensitive payload.
  matcher: ["/((?!_next/static|_next/image|_next/webpack-hmr|favicon.ico|icon.png).*)"]
};

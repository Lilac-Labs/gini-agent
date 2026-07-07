// Host/Origin trust at the SINGLE FRONT (the gateway).
//
// The gateway reverse-proxies the web app (see ADR gateway-web-reverse-proxy.md)
// and, when a tunnel is connected, is the only network-facing surface (the
// Next.js web child binds loopback and is reached only via this gateway or
// local dev). So the gateway owns the host/origin/CSRF trust decision for every
// web-bound request and then presents a loopback Host/Origin to the inner web
// child — which therefore needs no relay awareness of its own.
//
// This is the relay-aware guard that previously lived in the web BFF
// (web/src/lib/runtime.ts). It is intentionally a separate copy from the BFF's
// own loopback-only guard: the two now protect INDEPENDENT surfaces (this one
// the proxied perimeter, the BFF its direct web-port access), so they never
// both evaluate the same request and cannot drift into a reachability split.

// Loopback hostnames trusted unconditionally — a DNS-rebinding page cannot make
// the browser send a loopback Host, and frpc/local dev reach the gateway on
// loopback. Strips an optional :port (IPv6 literals are bracketed).
export function isLoopbackHost(host: string): boolean {
  const closeBracket = host.lastIndexOf("]");
  const hostnameOnly = closeBracket >= 0
    ? host.slice(0, closeBracket + 1)
    : host.includes(":") ? host.slice(0, host.indexOf(":")) : host;
  return hostnameOnly === "localhost" || hostnameOnly === "127.0.0.1" || hostnameOnly === "[::1]";
}

// True when a connection's REAL peer address is the local loopback. This is the
// network fact behind "the local operator" — it cannot be forged by a Host
// header. On the default loopback bind every accepted connection is loopback,
// so this is always true and changes nothing. It matters only when the gateway
// binds a non-loopback interface (GINI_BIND_HOST=0.0.0.0, the container case):
// there a remote peer arrives over the network (e.g. Docker's bridge gateway,
// 172.x) with an attacker-controlled `Host: localhost`, and trusting the Host
// alone would hand it the loopback-operator lane. Loopback-Host trust is
// therefore gated on this. `address` comes from Bun's server.requestIP (the
// kernel-reported socket peer), never from a forgeable header like
// X-Forwarded-For. A null/absent address (no socket info) is treated as
// loopback so the in-process/test path — which never binds a non-loopback
// interface — keeps its historical behavior.
//
// IPv6 note: Bun reports the peer family explicitly. ::1 is loopback;
// IPv4-mapped loopback (::ffff:127.0.0.1) is normalized before the check.
export function isLoopbackPeer(address: string | null | undefined): boolean {
  if (address === null || address === undefined || address.length === 0) return true;
  const normalized = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  return normalized === "127.0.0.1" || normalized === "::1" || normalized.startsWith("127.");
}

// A host that is the gini-relay domain or one of its per-device subdomains. The
// relay routes each random subdomain only to its owner's frpc tunnel and owns
// that DNS, so a `*.<relayDomain>` Host can only be present on a request that
// actually arrived through the operator's own tunnel — as un-rebindable as
// loopback. See docs/adr/bff-trust-boundary.md.
export function isRelayHost(host: string): boolean {
  const domain = (process.env.GINI_RELAY_DOMAIN ?? "gini-relay.lilaclabs.ai").toLowerCase();
  const lower = host.toLowerCase();
  const closeBracket = lower.lastIndexOf("]");
  const hostnameOnly = closeBracket >= 0
    ? lower.slice(0, closeBracket + 1)
    : lower.includes(":") ? lower.slice(0, lower.indexOf(":")) : lower;
  return hostnameOnly === domain || hostnameOnly.endsWith(`.${domain}`);
}

// Hosts of runtime-managed tunnels that are currently CONNECTED (set by
// src/integrations/tunnel.ts whenever it writes a tunnel record, keyed by
// instance). A Host equal to a connected tunnel's host is as trustworthy as a
// relay subdomain: the runtime itself established that tunnel to this gateway,
// and the provider (Tailscale's tailnet DNS, ngrok's *.ngrok-free.app,
// Cloudflare's *.trycloudflare.com, the gini relay) owns the DNS for the name —
// an attacker cannot rebind it to this machine. Without this lane, a tunnel the
// runtime just published would fail closed (404/403) until the operator
// hand-copied the random URL into GINI_TRUSTED_ORIGINS.
//
// isRuntimeTunnelHost matches against EVERY entry rather than threading an
// instance through the guard call sites. That is sound because a gateway
// process serves exactly one instance (instances are separate processes, see
// docs/gateway.md), so in production this map holds at most that one
// instance's entry; the instance key exists so tests exercising several
// instances in one process stay isolated.
const runtimeTunnelHosts = new Map<string, string>();

// Record (url) or clear (null) the connected tunnel host for an instance.
export function setRuntimeTunnelTrust(instance: string, url: string | null): void {
  if (!url) {
    runtimeTunnelHosts.delete(instance);
    return;
  }
  try {
    runtimeTunnelHosts.set(instance, stripDefaultPort(new URL(url).host));
  } catch {
    // An unparseable url must never install a trust entry.
    runtimeTunnelHosts.delete(instance);
  }
}

// Test seam: drop every runtime-tunnel trust entry.
export function clearRuntimeTunnelTrust(): void {
  runtimeTunnelHosts.clear();
}

function stripDefaultPort(host: string): string {
  return host.toLowerCase().replace(/:(?:80|443)$/, "");
}

// A Host that equals a currently-connected runtime-managed tunnel's host.
export function isRuntimeTunnelHost(host: string): boolean {
  if (runtimeTunnelHosts.size === 0) return false;
  const target = stripDefaultPort(host);
  for (const tunnelHost of runtimeTunnelHosts.values()) {
    if (tunnelHost === target) return true;
  }
  return false;
}

// Parse `GINI_TRUSTED_ORIGINS` into validated origin strings. Mirrors the BFF's
// web/src/lib/trusted-origins.ts validation exactly (entries with a path,
// query, hash, or userinfo are rejected as a likely paste error). Tri-state:
//   null  -> env unset (loopback/relay-only fallback applies)
//   Set   -> at least one valid entry parsed
//   empty -> env set but every entry malformed -> fail closed (refuse all
//            non-loopback, non-relay requests).
export function trustedOrigins(): ReadonlySet<string> | null {
  const raw = process.env.GINI_TRUSTED_ORIGINS;
  if (!raw || !raw.trim()) return null;
  const out = new Set<string>();
  for (const candidate of raw.split(",")) {
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    try {
      const parsed = new URL(trimmed);
      if (
        (parsed.pathname !== "" && parsed.pathname !== "/")
        || parsed.search !== ""
        || parsed.hash !== ""
        || parsed.username !== ""
        || parsed.password !== ""
      ) {
        continue;
      }
      out.add(`${parsed.protocol}//${parsed.host}`);
    } catch {
      // Skip malformed entries individually.
    }
  }
  return out;
}

// Default-port-equivalent Host match against GINI_TRUSTED_ORIGINS, mirroring the
// BFF proxy classifier (host:443 ≡ host for https, host:80 ≡ host for http). A
// no-Origin top-level navigation to an operator-listed front (e.g. a Tailscale
// host reached through a reverse proxy) carries no Origin to match, but its Host
// should still be trusted.
function hostInTrustedAllowlist(host: string): boolean {
  const raw = process.env.GINI_TRUSTED_ORIGINS;
  if (!raw || !raw.trim()) return false;
  const strip = (h: string): string => h.toLowerCase().replace(/:(?:80|443)$/, "");
  const target = strip(host);
  for (const candidate of raw.split(",")) {
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    try {
      const parsed = new URL(trimmed);
      if (
        (parsed.pathname !== "" && parsed.pathname !== "/")
        || parsed.search !== ""
        || parsed.hash !== ""
        || parsed.username !== ""
        || parsed.password !== ""
      ) {
        continue;
      }
      if (strip(parsed.host) === target) return true;
    } catch {
      // Skip malformed entries individually.
    }
  }
  return false;
}

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// The host/origin trust decision (the Sec-Fetch-Site check is applied
// separately by the caller). Returns true when the inbound Host/Origin may be
// reverse-proxied to the inner web child.
//
//   - No Origin: allow only safe methods on a Host that is itself trusted —
//     loopback (covers local dev AND the runtime's own loopback probes, e.g.
//     the tunnel readiness probe GET /api/runtime/__healthz which carries no
//     Origin), the relay front (top-level navigations over the tunnel), or a
//     Host the operator listed in GINI_TRUSTED_ORIGINS (a top-level navigation
//     to a reverse-proxy front carries no Origin to match). Loopback/relay are
//     trusted regardless of GINI_TRUSTED_ORIGINS — a rebinding page cannot forge
//     a loopback Host and the relay owns its DNS. An unsafe no-Origin request
//     must use the native /api/* surface with its own bearer.
//   - Origin present: a relay Origin is trusted only when it equals the inbound
//     relay Host (same subdomain — a different relay subdomain is a cross-site
//     peer and must not be trusted); a loopback Origin on a loopback Host is
//     local; otherwise the Origin must match GINI_TRUSTED_ORIGINS (or, with no
//     allowlist, equal a loopback Host).
function hostOriginTrusted(origin: string | null, isUnsafe: boolean, expectedHost: string): boolean {
  if (!origin) {
    if (isUnsafe) return false;
    return (
      isLoopbackHost(expectedHost)
      || isRelayHost(expectedHost)
      || isRuntimeTunnelHost(expectedHost)
      || hostInTrustedAllowlist(expectedHost)
    );
  }
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }
  // A relay Origin is trusted only when it equals the inbound relay Host — i.e.
  // a request to a relay subdomain whose page is that SAME subdomain. Trusting
  // any relay Origin regardless of Host would let one relay subdomain (an
  // attacker's) ride a same-site cookie to another subdomain (the victim's),
  // since all *.<relayDomain> share one registrable domain. Match the Origin==Host
  // discipline the loopback/allowlist lanes use.
  if (isRelayHost(originUrl.host) && isRelayHost(expectedHost) && originUrl.host === expectedHost) return true;
  // A runtime-tunnel Origin follows the same Origin==Host discipline as the
  // relay lane: only the page served from that same tunnel front is trusted.
  if (
    isRuntimeTunnelHost(originUrl.host)
    && isRuntimeTunnelHost(expectedHost)
    && originUrl.host === expectedHost
  ) {
    return true;
  }
  if (isLoopbackHost(expectedHost) && isLoopbackHost(originUrl.host)) return true;
  const allowlist = trustedOrigins();
  if (allowlist) return allowlist.has(`${originUrl.protocol}//${originUrl.host}`);
  return isLoopbackHost(expectedHost) && originUrl.host === expectedHost;
}

// The web-bound trust decision for the gateway. Returns true when the request
// may be reverse-proxied to the inner web child, false when it must be refused.
// Sec-Fetch-Site, when present, must be same-origin or none.
export function webBoundRequestAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  const isUnsafe = UNSAFE_METHODS.has(request.method);
  const expectedHost = request.headers.get("host") ?? new URL(request.url).host;
  if (!hostOriginTrusted(origin, isUnsafe, expectedHost)) return false;
  // Sec-Fetch-Site cross-site is rejected for credentialed subresources/fetches,
  // but NOT for a top-level page navigation (Sec-Fetch-Dest=document): a user
  // opening the tunnel URL via a link from another site is a legitimate
  // cross-site navigation and must not be 404'd. Subresource data-leak
  // protection is unaffected — those carry a non-document destination.
  const fetchSite = request.headers.get("sec-fetch-site");
  const isDocumentNav = request.headers.get("sec-fetch-dest") === "document";
  if (!isDocumentNav && fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return false;
  return true;
}

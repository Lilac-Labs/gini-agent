import type { NextConfig } from "next";
import { resolve } from "node:path";

// Per-instance distDir lets the CLI run multiple `next dev` instances in
// parallel without them fighting over the same `<distDir>/lock`. The CLI
// passes `GINI_DIST_DIR=.next-<instance>` (always relative, kept inside `web/`
// per Next.js' distDir constraint). Defaulting to `.next` preserves the
// standalone `bun run dev` workflow for anyone running the web app
// outside `gini start`.
const distDir = process.env.GINI_DIST_DIR ?? ".next";

// The relay domain whose per-device subdomains are allowed as dev origins.
// This is purely a Next DEV-server concern (production ignores allowedDevOrigins)
// and is NOT part of the gateway trust model: Next's CLIENT-side dev-origin
// check uses the browser's Origin (the relay subdomain), which the gateway can't
// rewrite, so without this entry HMR / dev resources are blocked when the app is
// opened over a gini-relay tunnel. The actual host/origin TRUST decision lives
// at the gateway (src/lib/origin-trust.ts); this only re-enables dev HMR.
const relayDomain = process.env.GINI_RELAY_DOMAIN ?? "gini-relay.lilaclabs.ai";

const nextConfig: NextConfig = {
  distDir,
  // Next.js 16 defaults to blocking dev-resource requests from any origin
  // other than `localhost`, which silently breaks HMR + client-component
  // hydration when the user lands on http://127.0.0.1:<port>. The Gini
  // installer and CLI consistently open the app via 127.0.0.1, so we
  // allow both forms explicitly. Production builds don't read this —
  // it's a dev-server concern only. The relay-domain wildcard lets dev `/_next/*`
  // resources + the HMR WebSocket load when the app is opened over a gini-relay
  // tunnel (the browser's Origin is the relay subdomain even though the gateway
  // forwards a loopback Host). Dev-only; not a trust grant.
  allowedDevOrigins: ["127.0.0.1", "localhost", `*.${relayDomain}`],
  logging: {
    // The Google login callback carries a single-use OAuth authorization code
    // in its query string; keep it out of the dev access log (production
    // `next start` logs no incoming requests, so this is dev-only hygiene).
    incomingRequests: {
      ignore: [/\/api\/runtime\/google\/login\/callback/]
    }
  },
  turbopack: {
    // The workspace root, not this package dir. Bun's isolated installs
    // symlink packages/web/node_modules entries into the root
    // node_modules/.bun store, and the web app type-imports from
    // packages/runtime — both live outside packages/web, and Turbopack
    // refuses to compile files outside its root.
    root: resolve(import.meta.dirname, "..", "..")
  }
};

export default nextConfig;

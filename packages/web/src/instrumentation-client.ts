import posthog from "posthog-js";
import { posthogInitOptions } from "./lib/posthog";

// Client-side PostHog initialization via Next.js's `instrumentation-client`
// convention (the modern replacement for a `PostHogProvider` — per PostHog's
// guidance the two must NOT be combined). Runs once, before the app renders.
//
// Gated on the public project token so the app runs normally when analytics is
// unconfigured. The token + host come from `NEXT_PUBLIC_*` env (see
// `.env.local`); the `NEXT_PUBLIC_` prefix is required for client-side access.
//
// The chat-privacy masking lives in `posthogInitOptions` (tested); nothing
// from chat is collected.
const token = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;

if (token) {
  posthog.init(token, posthogInitOptions(process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com"));
}

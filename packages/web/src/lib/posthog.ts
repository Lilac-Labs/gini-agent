import type { PostHogConfig } from "posthog-js";

// PostHog's date-stamped config-defaults snapshot. Pinned so future default
// flips are opt-in rather than silent. See https://posthog.com/docs/libraries/next-js.
export const POSTHOG_DEFAULTS = "2026-05-30" as const;

// CHAT-PRIVACY INVARIANT: Gini is a personal chat agent — its entire surface is
// private, so PostHog must collect NO text or input content:
//   - session replay ("screen recording") masks every input and ALL text, so a
//     recording shows layout, navigation, and interaction timing, never what was
//     typed or displayed;
//   - autocapture keeps click/navigation signal but records no element text or
//     attribute values, so an event can't smuggle a message's contents out.
// Masking is applied GLOBALLY (fail-closed), not per-chat-component, so a newly
// added surface can't leak by being forgotten. Kept as a pure function so the
// invariant is unit-tested.
export function posthogInitOptions(apiHost: string): Partial<PostHogConfig> {
  return {
    api_host: apiHost,
    defaults: POSTHOG_DEFAULTS,
    session_recording: {
      maskAllInputs: true,
      maskTextSelector: "*"
    },
    mask_all_text: true,
    mask_all_element_attributes: true
  };
}

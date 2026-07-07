import { describe, expect, test } from "bun:test";
import { POSTHOG_DEFAULTS, posthogInitOptions } from "./posthog";

// Regression guard for the chat-privacy invariant: if any of these masking
// flags is ever weakened, PostHog would start collecting chat content. These
// tests fail loudly before that can ship.
describe("posthogInitOptions", () => {
  test("masks every input and ALL text in session replay", () => {
    const options = posthogInitOptions("https://us.i.posthog.com");
    expect(options.session_recording?.maskAllInputs).toBe(true);
    expect(options.session_recording?.maskTextSelector).toBe("*");
  });

  test("autocapture collects no element text or attribute values", () => {
    const options = posthogInitOptions("https://us.i.posthog.com");
    expect(options.mask_all_text).toBe(true);
    expect(options.mask_all_element_attributes).toBe(true);
  });

  test("passes the api host through and pins the defaults snapshot", () => {
    const options = posthogInitOptions("https://eu.i.posthog.com");
    expect(options.api_host).toBe("https://eu.i.posthog.com");
    expect(options.defaults).toBe(POSTHOG_DEFAULTS);
    expect(POSTHOG_DEFAULTS).toBe("2026-05-30");
  });
});

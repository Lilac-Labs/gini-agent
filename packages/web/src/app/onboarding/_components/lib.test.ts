// Unit tests for the pure onboarding helpers: routines-step wizard-state
// defaults, the capability-derived step sequence (provider step + scan
// gating), inbox-derived suggested-task selection, late scan-result adoption
// on the tasks step, timezone labels,
// email linkification segments, and primary-account resolution and ordering.
// Pure-JS tests
// (no React/DOM) — they import the helper module directly.

import { describe, expect, test } from "bun:test";
import type { GoogleAccountStatus, OnboardingScan } from "@runtime/types";
import {
  accountsPrimaryFirst,
  adoptScanSuggestions,
  connectGoogleUrl,
  defaultRoutinesState,
  initialOnboardingStep,
  needsProviderStep,
  onboardingSteps,
  primaryAccountId,
  profileCardView,
  reloginPrimaryUrl,
  removeSeededItem,
  seedTaskBody,
  signInCta,
  splitEmailSegments,
  suggestedTasksFrom,
  timezoneLabel
} from "./lib";

function buildAccount(overrides: Partial<GoogleAccountStatus>): GoogleAccountStatus {
  return {
    id: "gacct_a",
    tag: "personal",
    email: "a@example.com",
    configDir: "/tmp/gws-a",
    addedAt: "2026-01-01T00:00:00.000Z",
    signedIn: true,
    services: { gmail: true },
    message: "Signed in",
    ...overrides
  };
}

describe("defaultRoutinesState", () => {
  test("matches the design defaults (all routines on, archive-unimportant off)", () => {
    expect(defaultRoutinesState()).toEqual({
      autoInbox: { enabled: true, labelNewMail: true, archiveUnimportant: false, assistScheduling: true, draftReplies: true },
      morningBriefing: { enabled: true, personalizedNews: true },
      meetingBriefing: { enabled: true }
    });
  });

  test("returns a fresh object per call — mutating one result never bleeds into the next", () => {
    const first = defaultRoutinesState();
    first.autoInbox.enabled = false;
    first.meetingBriefing.enabled = false;
    expect(defaultRoutinesState().autoInbox.enabled).toBe(true);
    expect(defaultRoutinesState().meetingBriefing.enabled).toBe(true);
  });
});

describe("profileCardView", () => {
  test("ready scan renders the profile", () => {
    const scan: OnboardingScan = { status: "ready", profile: { displayName: "U", sections: [] } };
    expect(profileCardView(scan, false)).toBe("profile");
  });

  test("unloaded record and running scan render the loading state", () => {
    expect(profileCardView(undefined, false)).toBe("loading");
    expect(profileCardView({ status: "running" }, false)).toBe("loading");
  });

  test("idle before the kickoff fires stays on loading — no fallback flash", () => {
    expect(profileCardView({ status: "idle" }, false)).toBe("loading");
  });

  test("idle after a failed kickoff falls back — never an eternal spinner", () => {
    expect(profileCardView({ status: "idle" }, true)).toBe("fallback");
  });

  test.each(["failed", "no_account"] as const)("%s scan renders the fallback", (status) => {
    expect(profileCardView({ status }, false)).toBe("fallback");
  });

  test("scanUnavailable short-circuits every non-ready state to the connect-a-model view", () => {
    // Idle would otherwise spin forever (the scan was never kicked off) and a
    // failed scan would offer a "Try again" that can never succeed.
    expect(profileCardView(undefined, false, true)).toBe("unavailable");
    expect(profileCardView({ status: "idle" }, false, true)).toBe("unavailable");
    expect(profileCardView({ status: "idle" }, true, true)).toBe("unavailable");
    expect(profileCardView({ status: "running" }, false, true)).toBe("unavailable");
    expect(profileCardView({ status: "failed" }, false, true)).toBe("unavailable");
  });

  test("a ready profile wins over scanUnavailable", () => {
    const scan: OnboardingScan = { status: "ready", profile: { displayName: "U", sections: [] } };
    expect(profileCardView(scan, false, true)).toBe("profile");
  });
});

describe("needsProviderStep", () => {
  test("true only on a definite self-hosted-and-unconfigured answer", () => {
    expect(needsProviderStep({ managed: false, providerConfigured: false })).toBe(true);
  });

  test("an unresolved probe never blocks the funnel on a guess", () => {
    expect(needsProviderStep(undefined)).toBe(false);
  });

  test("managed deployments never see the provider step (ADR managed-deployment-mode.md)", () => {
    expect(needsProviderStep({ managed: true, providerConfigured: false })).toBe(false);
  });

  test("a configured provider needs no step", () => {
    expect(needsProviderStep({ managed: false, providerConfigured: true })).toBe(false);
  });
});

describe("onboardingSteps", () => {
  test("the provider step slots between sign-in and the wizard proper", () => {
    expect(onboardingSteps(true)).toEqual([
      "signin",
      "provider",
      "welcome",
      "routines",
      "profile",
      "accounts",
      "tasks"
    ]);
  });

  test("without the provider step the sequence is unchanged in order", () => {
    expect(onboardingSteps(false)).toEqual(onboardingSteps(true).filter((s) => s !== "provider"));
  });
});

describe("seedTaskBody", () => {
  test("pins the POST /containers contract — drifting it strands seeded tasks off the task-first home or leaks them into sidebar Chats", () => {
    const body = seedTaskBody("Draft a reply to Alice");
    expect(body).toEqual({
      content: "Draft a reply to Alice",
      client: "web",
      startedAs: "task"
    });
    // Exactly these keys, nothing extra — startTaskContainer keys behavior
    // off client and startedAs verbatim.
    expect(Object.keys(body).sort()).toEqual(["client", "content", "startedAs"]);
  });
});

describe("removeSeededItem", () => {
  test("removes only the first CHECKED item matching the text", () => {
    const items = [
      { text: "a", checked: false },
      { text: "a", checked: true },
      { text: "a", checked: true },
      { text: "b", checked: true }
    ];
    expect(removeSeededItem(items, "a")).toEqual([
      { text: "a", checked: false },
      { text: "a", checked: true },
      { text: "b", checked: true }
    ]);
  });

  test("returns the list unchanged when nothing matches", () => {
    const items = [{ text: "a", checked: true }];
    expect(removeSeededItem(items, "z")).toBe(items);
  });
});

describe("suggestedTasksFrom", () => {
  test("ready scan with suggestions wins", () => {
    const scan: OnboardingScan = {
      status: "ready",
      suggestedTasks: ["Draft a reply to Alice", "Follow up on the invoice"]
    };
    expect(suggestedTasksFrom(scan)).toEqual(["Draft a reply to Alice", "Follow up on the invoice"]);
  });

  test("ready scan without suggestions returns no seed tasks", () => {
    expect(suggestedTasksFrom({ status: "ready" })).toEqual([]);
  });

  test.each(["running", "failed", "no_account", "idle"] as const)(
    "%s scan returns no seed tasks",
    (status) => {
      expect(suggestedTasksFrom({ status })).toEqual([]);
    }
  );

  test("undefined scan returns no seed tasks", () => {
    expect(suggestedTasksFrom(undefined)).toEqual([]);
  });
});

describe("adoptScanSuggestions", () => {
  const ready: OnboardingScan = { status: "ready", suggestedTasks: ["Draft a reply to Alice"] };

  test("a ready scan with suggestions replaces an untouched list", () => {
    expect(adoptScanSuggestions(ready, false)).toEqual(["Draft a reply to Alice"]);
  });

  test("a touched list is never replaced", () => {
    expect(adoptScanSuggestions(ready, true)).toBeUndefined();
  });

  test.each(["idle", "running", "failed", "no_account"] as const)(
    "a %s scan replaces nothing",
    (status) => {
      expect(adoptScanSuggestions({ status }, false)).toBeUndefined();
    }
  );

  test("an unloaded record replaces nothing", () => {
    expect(adoptScanSuggestions(undefined, false)).toBeUndefined();
  });

  test("a ready scan without suggestions keeps the empty list", () => {
    expect(adoptScanSuggestions({ status: "ready" }, false)).toBeUndefined();
    expect(adoptScanSuggestions({ status: "ready", suggestedTasks: [] }, false)).toBeUndefined();
  });
});

describe("timezoneLabel", () => {
  test("region-named zone renders 'Region (City)'", () => {
    expect(timezoneLabel("America/Los_Angeles")).toBe("Pacific (Los Angeles)");
  });

  test("underscores in the city become spaces", () => {
    expect(timezoneLabel("America/New_York")).toBe("Eastern (New York)");
  });

  test("a zone whose generic name adds nothing keeps just the city", () => {
    // UTC's longGeneric is "Coordinated Universal Time"; the label must still
    // be a readable single token, never "(UTC)" duplication or a GMT offset.
    const label = timezoneLabel("UTC");
    expect(label.length).toBeGreaterThan(0);
    expect(label).not.toMatch(/GMT[+-]/);
  });

  test("an unknown zone falls back to the bare city segment", () => {
    expect(timezoneLabel("Not/A_Zone")).toBe("A Zone");
  });
});

describe("splitEmailSegments", () => {
  test("text without an address is a single plain segment", () => {
    expect(splitEmailSegments("Country of citizenship: China")).toEqual([
      { text: "Country of citizenship: China", email: false }
    ]);
  });

  test("an embedded address splits into plain/email/plain", () => {
    expect(splitEmailSegments("Work email: alex@example.com (primary)")).toEqual([
      { text: "Work email: ", email: false },
      { text: "alex@example.com", email: true },
      { text: " (primary)", email: false }
    ]);
  });

  test("multiple addresses each get their own segment", () => {
    const segments = splitEmailSegments("a@x.com and b@y.co");
    expect(segments).toEqual([
      { text: "a@x.com", email: true },
      { text: " and ", email: false },
      { text: "b@y.co", email: true }
    ]);
  });

  test("plus/dot/hyphen locals and subdomains are matched whole", () => {
    expect(splitEmailSegments("(also has alex.chen+cal@mail.example.edu)")).toEqual([
      { text: "(also has ", email: false },
      { text: "alex.chen+cal@mail.example.edu", email: true },
      { text: ")", email: false }
    ]);
  });
});

describe("primaryAccountId", () => {
  test("empty registry has no primary", () => {
    expect(primaryAccountId([])).toBeUndefined();
  });

  test("first account is primary when none is provisioned", () => {
    const accounts = [buildAccount({ id: "gacct_a" }), buildAccount({ id: "gacct_b" })];
    expect(primaryAccountId(accounts)).toBe("gacct_a");
  });

  test("a provisioned account beats registry order", () => {
    const accounts = [
      buildAccount({ id: "gacct_a" }),
      buildAccount({ id: "gacct_b", provisioned: true })
    ];
    expect(primaryAccountId(accounts)).toBe("gacct_b");
  });

  test("the server-resolved primary flag beats the provisioned/first heuristic", () => {
    // The persisted primary (flipped by a sign-in-intent OAuth) wins even
    // over a provisioned row — the flag IS the server's resolution.
    const accounts = [
      buildAccount({ id: "gacct_a", provisioned: true }),
      buildAccount({ id: "gacct_b", primary: true })
    ];
    expect(primaryAccountId(accounts)).toBe("gacct_b");
  });
});

describe("accountsPrimaryFirst", () => {
  test("empty list stays empty", () => {
    expect(accountsPrimaryFirst([])).toEqual([]);
  });

  test("a provisioned primary moves to the front; the rest keep registry order", () => {
    const accounts = [
      buildAccount({ id: "gacct_a" }),
      buildAccount({ id: "gacct_b" }),
      buildAccount({ id: "gacct_c", provisioned: true })
    ];
    expect(accountsPrimaryFirst(accounts).map((a) => a.id)).toEqual(["gacct_c", "gacct_a", "gacct_b"]);
    // The input array is untouched (no in-place sort).
    expect(accounts.map((a) => a.id)).toEqual(["gacct_a", "gacct_b", "gacct_c"]);
  });

  test("order is unchanged when the first account is already the primary", () => {
    const accounts = [buildAccount({ id: "gacct_a" }), buildAccount({ id: "gacct_b" })];
    expect(accountsPrimaryFirst(accounts).map((a) => a.id)).toEqual(["gacct_a", "gacct_b"]);
  });
});

describe("initialOnboardingStep", () => {
  test("?step=accounts re-enters the wizard on the accounts step", () => {
    expect(initialOnboardingStep("accounts")).toBe("accounts");
  });

  test.each([null, undefined, "", "unknown", "ACCOUNTS", "4", "provider"])(
    "%p starts at the sign-in step",
    (param) => {
      expect(initialOnboardingStep(param)).toBe("signin");
    }
  );
});

describe("connectGoogleUrl", () => {
  test("edge mode targets the edge add flow with the returnTo encoded", () => {
    expect(connectGoogleUrl("edge", "/onboarding?step=accounts", "http://127.0.0.1:3059")).toBe(
      "/auth/google/add?returnTo=%2Fonboarding%3Fstep%3Daccounts"
    );
  });

  test("loopback mode targets the gateway start route with returnTo AND the browser origin encoded", () => {
    expect(connectGoogleUrl("loopback", "/onboarding", "http://127.0.0.1:3059")).toBe(
      "/api/runtime/google/login/start?returnTo=%2Fonboarding&origin=http%3A%2F%2F127.0.0.1%3A3059"
    );
  });

  test("signin intent is appended in both modes; an explicit add intent keeps the bare URL", () => {
    expect(connectGoogleUrl("edge", "/onboarding", "http://127.0.0.1:3059", "signin")).toBe(
      "/auth/google/add?returnTo=%2Fonboarding&intent=signin"
    );
    expect(connectGoogleUrl("loopback", "/onboarding", "http://127.0.0.1:3059", "signin")).toBe(
      "/api/runtime/google/login/start?returnTo=%2Fonboarding&origin=http%3A%2F%2F127.0.0.1%3A3059&intent=signin"
    );
    expect(connectGoogleUrl("edge", "/onboarding", "http://127.0.0.1:3059", "add")).toBe(
      "/auth/google/add?returnTo=%2Fonboarding"
    );
  });
});

describe("reloginPrimaryUrl", () => {
  test("edge mode routes to the add flow with signin intent — the edge upgrades an owner self-re-auth to a baked-dir heal", () => {
    // NOT /auth/google: the owner sign-in flow heals only the baked dir, so a
    // primary flipped to another account would loop on the reconnect CTA.
    expect(reloginPrimaryUrl("edge", "/skills", "http://127.0.0.1:3059")).toBe(
      "/auth/google/add?returnTo=%2Fskills&intent=signin"
    );
    expect(reloginPrimaryUrl("edge", "/onboarding")).toBe(
      "/auth/google/add?returnTo=%2Fonboarding&intent=signin"
    );
  });

  test("loopback mode builds the gateway PKCE start URL with returnTo, origin, and signin intent (the heal re-persists the primary)", () => {
    expect(reloginPrimaryUrl("loopback", "/skills", "http://127.0.0.1:3059")).toBe(
      "/api/runtime/google/login/start?returnTo=%2Fskills&origin=http%3A%2F%2F127.0.0.1%3A3059&intent=signin"
    );
  });

  test("loopback mode with no origin encodes an empty origin", () => {
    expect(reloginPrimaryUrl("loopback", "/onboarding")).toBe(
      "/api/runtime/google/login/start?returnTo=%2Fonboarding&origin=&intent=signin"
    );
  });
});

describe("signInCta", () => {
  test("no accounts → 'connect'", () => {
    expect(signInCta([])).toBe("connect");
  });

  test("a signed-in primary → 'continue'", () => {
    expect(signInCta([buildAccount({ id: "gacct_a", signedIn: true })])).toBe("continue");
  });

  test("a revoked primary (signed out AND tokenRevoked) → 'reconnect'", () => {
    expect(
      signInCta([buildAccount({ id: "gacct_a", signedIn: false, tokenRevoked: true })])
    ).toBe("reconnect");
  });

  test("a signed-out primary that was NOT revoked (e.g. sign-in pending) → 'connect'", () => {
    // signedIn:false but tokenRevoked absent/false must not surface reconnect —
    // there is no revoked credential to heal.
    expect(signInCta([buildAccount({ id: "gacct_a", signedIn: false })])).toBe("connect");
    expect(
      signInCta([buildAccount({ id: "gacct_a", signedIn: false, tokenRevoked: false })])
    ).toBe("connect");
  });

  test("reconnect keys off the PRIMARY row: a revoked provisioned primary wins over a signed-in secondary", () => {
    // The provisioned account is primary (see primaryAccountId); its revoked
    // state drives the CTA even though another account is signed in.
    const accounts = [
      buildAccount({ id: "gacct_secondary", signedIn: true }),
      buildAccount({ id: "gacct_primary", provisioned: true, signedIn: false, tokenRevoked: true })
    ];
    expect(signInCta(accounts)).toBe("reconnect");
  });
});

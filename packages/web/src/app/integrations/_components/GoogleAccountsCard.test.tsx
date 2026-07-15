/// <reference lib="dom" />

// Each Google account is a separate disclosure: service grants start hidden,
// expanding one account does not change its siblings, and its accessible
// control reports the current state.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { GoogleAccountStatus } from "@runtime/types";
import { GoogleAccountsCard } from "./GoogleAccountsCard";

const realFetch = globalThis.fetch;

beforeEach(() => {
  // useGoogleAuthMode owns an incidental query. Leave it pending so this test
  // stays focused on the local disclosure state without a network dependency.
  globalThis.fetch = mock(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function account(overrides: Partial<GoogleAccountStatus>): GoogleAccountStatus {
  return {
    id: "gacct_test",
    tag: "test",
    email: "test@example.com",
    configDir: "/tmp/gacct_test",
    addedAt: "2026-07-01T00:00:00.000Z",
    signedIn: true,
    services: {},
    message: "",
    ...overrides
  };
}

function renderAccounts() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <GoogleAccountsCard
        accounts={[
          account({
            id: "gacct_work",
            tag: "work",
            email: "work@example.com",
            primary: true,
            services: { gmail: true }
          }),
          account({
            id: "gacct_personal",
            tag: "personal",
            email: "personal@example.com",
            services: { calendar: true }
          })
        ]}
      />
    </QueryClientProvider>
  );
}

describe("GoogleAccountsCard disclosures", () => {
  test("accounts start collapsed and expand independently", () => {
    renderAccounts();

    expect(screen.queryByText("Gmail")).toBeNull();
    expect(screen.queryByText("Google Calendar")).toBeNull();

    const workToggle = screen.getByRole("button", { name: "Expand work@example.com details" });
    expect(workToggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(workToggle);

    expect(screen.queryByText("Gmail")).not.toBeNull();
    expect(screen.queryByText("Google Calendar")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Collapse work@example.com details" }).getAttribute("aria-expanded")
    ).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Expand personal@example.com details" }));
    expect(screen.queryByText("Gmail")).not.toBeNull();
    expect(screen.queryByText("Google Calendar")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Collapse work@example.com details" }));
    expect(screen.queryByText("Gmail")).toBeNull();
    expect(screen.queryByText("Google Calendar")).not.toBeNull();
  });
});

/// <reference lib="dom" />

// Each Google account is a separate disclosure, and account actions respect
// the instance binding: the primary is protected while a secondary can be
// disconnected without exposing machine-wide credential deletion.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { GoogleAccountStatus } from "@runtime/types";
import { GoogleAccountsCard } from "./GoogleAccountsCard";

const realFetch = globalThis.fetch;
let requests: Array<{ url: string; method: string }> = [];

beforeEach(() => {
  requests = [];
  globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    requests.push({ url, method });
    if (method === "DELETE") {
      return Promise.resolve(
        new Response(JSON.stringify({ id: "gacct_personal" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );
    }
    // Leave unrelated requests pending so these tests stay focused on account
    // card behavior.
    return new Promise<Response>(() => {});
  }) as unknown as typeof fetch;
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

  test("protects the primary and disconnects only the selected secondary", async () => {
    renderAccounts();

    expect(screen.queryByRole("button", { name: "Disconnect work@example.com" })).toBeNull();
    expect(screen.queryByText("Remove from this machine")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect personal@example.com" }));

    await waitFor(() => {
      expect(requests).toContainEqual({
        url: "/api/runtime/google/accounts/gacct_personal/instance",
        method: "DELETE"
      });
    });
  });
});

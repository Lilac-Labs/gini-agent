/// <reference lib="dom" />

// /login managed sign-in page (ADR managed-deployment-mode.md): keyed on the
// deployment's auth mode. "edge" (a managed edge fronts the app) renders the
// sign-in card whose "Continue with Google" is a plain same-tab link to the
// relative /auth/google; "loopback" (self-hosted) redirects home. The real
// useGoogleAuthMode hook runs against a stubbed fetch, so the wire contract
// is what these tests pin.
//
// LEAK SAFETY: mock.module is process-wide, so the node_module mocks are
// captured and restored in afterAll (next/font/google resolves fonts at build
// time under Next and can't run under bun test at all, so its mock is the
// price of importing the page).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const realNav = await import("next/navigation");
const realImage = await import("next/image");
const realFetch = globalThis.fetch;

const replaceCalls: string[] = [];

let LoginPage: typeof import("./page").default;

beforeAll(async () => {
  mock.module("next/navigation", () => ({
    ...realNav,
    useRouter: () => ({ replace: (href: string) => replaceCalls.push(href), push: () => {}, prefetch: () => {} })
  }));
  mock.module("next/font/google", () => ({
    Fraunces: () => ({ variable: "font-fraunces-stub" })
  }));
  // next/image's loader can't build its optimizer URL under happy-dom's URL
  // implementation; a plain <img> stands in.
  mock.module("next/image", () => ({
    default: ({ src, alt }: { src: string; alt?: string }) =>
      // eslint-disable-next-line @next/next/no-img-element
      <img src={src} alt={alt ?? ""} />
  }));
  LoginPage = (await import("./page")).default;
});

afterAll(() => {
  mock.module("next/navigation", () => realNav);
  mock.module("next/image", () => realImage);
});

function stubAuthMode(mode: "edge" | "loopback"): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ mode }), {
      status: 200,
      headers: { "content-type": "application/json" }
    })) as unknown as typeof fetch;
}

beforeEach(() => {
  replaceCalls.length = 0;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    rtlRender(
      <QueryClientProvider client={client}>
        <LoginPage />
      </QueryClientProvider>
    );
  });
}

describe("LoginPage", () => {
  test("edge auth mode: renders the sign-in card with a same-tab relative /auth/google link", async () => {
    stubAuthMode("edge");
    await renderPage();
    await waitFor(() => expect(screen.queryByText("Sign in to Gini")).not.toBeNull());
    const link = screen.getByText("Continue with Google").closest("a");
    expect(link).not.toBeNull();
    // Relative URL, same tab: the edge fronting this app owns /auth/google,
    // so the link must not name a host or open a new tab.
    expect(link?.getAttribute("href")).toBe("/auth/google");
    expect(link?.getAttribute("target")).toBeNull();
    expect(replaceCalls).toEqual([]);
  });

  test("loopback auth mode: redirects home without rendering the card", async () => {
    stubAuthMode("loopback");
    await renderPage();
    await waitFor(() => expect(replaceCalls).toEqual(["/"]));
    expect(screen.queryByText("Sign in to Gini")).toBeNull();
    expect(screen.queryByText("Continue with Google")).toBeNull();
  });

  test("renders nothing while the auth mode is unresolved", async () => {
    // A never-resolving probe: neither the card nor the redirect may fire on a
    // guess — the page waits for the deployment's answer.
    globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch;
    await renderPage();
    expect(screen.queryByText("Sign in to Gini")).toBeNull();
    expect(replaceCalls).toEqual([]);
  });
});

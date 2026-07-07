/// <reference lib="dom" />

// TunnelConnectedPopover is presentational: it takes a TunnelState plus
// onEdit/onDisconnect callbacks. These tests render it directly with props and
// drive every interactive path — the two-way QR reveal, the masked URL toggle,
// copy (success + reject + timer revert), Edit, Disconnect — plus the
// providerName and url fallbacks. The clipboard stub is installed before render
// because happy-dom omits navigator.clipboard. Every state-updating interaction
// goes through async userEvent so React updates stay inside act().

import { afterEach, describe, expect, jest, mock, test } from "bun:test";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TunnelProvider, TunnelState } from "./types";
import { TunnelConnectedPopover } from "./TunnelConnectedPopover";

const PROVIDERS: TunnelProvider[] = [
  { id: "gini-relay", name: "Gini Relay", enabled: true },
  { id: "tailscale", name: "Tailscale", enabled: false, requires: "Tailscale network" },
  { id: "ngrok", name: "ngrok", enabled: false, requires: "ngrok account" },
  { id: "cloudflare", name: "Cloudflare", enabled: false, requires: "cloudflared CLI" }
];

function makeState(over: Partial<TunnelState> = {}): TunnelState {
  return {
    providers: PROVIDERS,
    selectedProvider: "tailscale",
    status: "connected",
    url: "https://g31.example",
    ...over
  };
}

// The copy button swaps the Copy glyph for Check; lucide tags each SVG with a
// stable `lucide-<name>` class, so query the rendered icon to read copied-state.
const copyButton = () => screen.getByRole("button", { name: "Copy public URL" });
const hasCheck = () => copyButton().querySelector(".lucide-check") !== null;

let writeText: ReturnType<typeof mock>;

// userEvent.setup() installs its own navigator.clipboard, so stub it AFTER
// setup to guarantee the component's writeText call lands on our mock.
function stubClipboard(impl: () => Promise<void>) {
  writeText = mock(impl);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText }
  });
}

// Some tests enable fake timers; always restore real timers so a failure can't
// leak the fake clock into the next test.
afterEach(() => {
  jest.useRealTimers();
});

describe("TunnelConnectedPopover", () => {
  test("the stability copy is provider-aware: stable fronts say so, churning ones warn", () => {
    // tailscale (machine-named) keeps its URL across reconnects.
    const { rerender } = render(
      <TunnelConnectedPopover state={makeState()} onEdit={() => {}} onDisconnect={() => {}} />
    );
    expect(screen.queryByText(/stable link/)).not.toBeNull();
    // ngrok's free tier mints a fresh subdomain per connect — no 24/7 claim.
    rerender(
      <TunnelConnectedPopover
        state={makeState({ selectedProvider: "ngrok", url: "https://ab12.ngrok-free.app" })}
        onEdit={() => {}}
        onDisconnect={() => {}}
      />
    );
    expect(screen.queryByText(/stable link/)).toBeNull();
    expect(screen.queryByText(/changes on every reconnect/)).not.toBeNull();
    // cloudflare QUICK tunnels churn too…
    rerender(
      <TunnelConnectedPopover
        state={makeState({ selectedProvider: "cloudflare", url: "https://some-words.trycloudflare.com" })}
        onEdit={() => {}}
        onDisconnect={() => {}}
      />
    );
    expect(screen.queryByText(/changes on every reconnect/)).not.toBeNull();
    // …but a NAMED cloudflare tunnel is a stable custom domain.
    rerender(
      <TunnelConnectedPopover
        state={makeState({ selectedProvider: "cloudflare", url: "https://gini.example.com" })}
        onEdit={() => {}}
        onDisconnect={() => {}}
      />
    );
    expect(screen.queryByText(/stable link/)).not.toBeNull();
  });

  test("the QR reveal is two-way: Reveal shows a Hide toggle, Hide re-blurs it", async () => {
    const user = userEvent.setup();
    render(
      <TunnelConnectedPopover state={makeState()} onEdit={() => {}} onDisconnect={() => {}} />
    );
    await user.click(screen.getByRole("button", { name: "Reveal QR" }));
    // Revealed: the Reveal button is replaced by a Hide toggle.
    expect(screen.queryByRole("button", { name: "Reveal QR" })).toBeNull();
    const hide = screen.getByRole("button", { name: "Hide QR code" });
    await user.click(hide);
    // Hidden again: Reveal is back and the Hide toggle is gone.
    expect(screen.queryByRole("button", { name: "Reveal QR" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Hide QR code" })).toBeNull();
  });

  test("the URL is masked until revealed and itself toggles the reveal", async () => {
    const user = userEvent.setup();
    render(
      <TunnelConnectedPopover state={makeState()} onEdit={() => {}} onDisconnect={() => {}} />
    );
    // Hidden by default: the real URL is not shown and the QR sits behind Reveal.
    expect(screen.queryByText("https://g31.example")).toBeNull();
    expect(screen.queryByRole("button", { name: "Reveal QR" })).not.toBeNull();
    const urlToggle = screen.getByRole("button", { name: "Reveal public URL" });
    expect(urlToggle.textContent).not.toContain("g31.example");
    // Clicking the URL reveals both the URL and the QR (shared state).
    await user.click(urlToggle);
    expect(screen.queryByText("https://g31.example")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Reveal QR" })).toBeNull();
    // Clicking it again re-masks both.
    await user.click(screen.getByRole("button", { name: "Hide public URL" }));
    expect(screen.queryByText("https://g31.example")).toBeNull();
  });

  test("copy success writes the url, shows Check, then reverts after the timer", async () => {
    jest.useFakeTimers();
    const user = userEvent.setup({ delay: null, advanceTimers: jest.advanceTimersByTime });
    stubClipboard(() => Promise.resolve());
    render(
      <TunnelConnectedPopover state={makeState()} onEdit={() => {}} onDisconnect={() => {}} />
    );
    expect(hasCheck()).toBe(false);
    await user.click(copyButton());
    expect(writeText).toHaveBeenCalledWith("https://g31.example");
    // Flush copy()'s continuation (await writeText -> setCopied(true)); with
    // delay:null userEvent doesn't yield the microtask the way real delays do.
    await act(async () => {});
    expect(hasCheck()).toBe(true);
    // Fire the setTimeout(1500) revert on the fake clock instead of burning real
    // wall-clock; the inner callback flips copied back to false.
    await act(async () => {
      jest.advanceTimersByTime(1500);
    });
    expect(hasCheck()).toBe(false);
  });

  test("copy failure is swallowed and copied stays false", async () => {
    const user = userEvent.setup();
    stubClipboard(() => Promise.reject(new Error("nope")));
    render(
      <TunnelConnectedPopover state={makeState()} onEdit={() => {}} onDisconnect={() => {}} />
    );
    await user.click(copyButton());
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(hasCheck()).toBe(false);
  });

  test("Edit selection routes to onEdit", async () => {
    const user = userEvent.setup();
    const onEdit = mock(() => {});
    render(
      <TunnelConnectedPopover state={makeState()} onEdit={onEdit} onDisconnect={() => {}} />
    );
    await user.click(screen.getByRole("button", { name: "Edit selection" }));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  test("Disconnect routes to onDisconnect", async () => {
    const user = userEvent.setup();
    const onDisconnect = mock(() => {});
    render(
      <TunnelConnectedPopover state={makeState()} onEdit={() => {}} onDisconnect={onDisconnect} />
    );
    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });

  test("providerName resolves the selected provider's name", () => {
    render(
      <TunnelConnectedPopover
        state={makeState({ selectedProvider: "ngrok" })}
        onEdit={() => {}}
        onDisconnect={() => {}}
      />
    );
    expect(screen.queryByText("ngrok")).not.toBeNull();
  });

  test("providerName falls back to Gini Relay when no provider matches", () => {
    render(
      <TunnelConnectedPopover
        state={makeState({ selectedProvider: null })}
        onEdit={() => {}}
        onDisconnect={() => {}}
      />
    );
    expect(screen.queryByText("Gini Relay")).not.toBeNull();
  });

  test("renders without crashing when url is undefined", () => {
    render(
      <TunnelConnectedPopover
        state={makeState({ url: undefined })}
        onEdit={() => {}}
        onDisconnect={() => {}}
      />
    );
    expect(screen.queryByRole("button", { name: "Copy public URL" })).not.toBeNull();
  });
});

"use client";

// Shared model-first picker (ADR model-first-selection.md).
//
// The user picks a MODEL; a provider is just a route that serves it. The
// collapsed trigger leads with the serving route's brand icon and spells
// the route out ("gpt-5.5 · Codex") — the model name alone can't say which
// provider a turn rides. The open state is a searchable list of model
// names, each row naming its serving route; a model served by more than
// one configured route shows a chevron, and hovering the row (or
// ArrowRight / tapping the chevron — hover is unreachable on keyboard and
// touch) opens a side flyout of its routes with the default tagged.
//
// Used by the Settings page's "Default model" and "Agent model" controls.
// Data comes from GET /providers/models (canonical models ×
// configured routes); selection is reported as the exact
// { provider, model } pair the selection endpoints persist.

import { useId, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, SearchIcon } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { providerIcon } from "@/components/provider-logos";
import {
  displayProviderName,
  type ModelCatalogEntry,
  type ModelRoute,
  type ProviderCatalogItem
} from "@/lib/providers";

export interface ModelSelection {
  provider: string;
  model: string;
}

// Case-insensitive substring filter over the canonical model name and the
// route labels (so "bedrock" finds everything routable through Bedrock).
export function filterModelEntries(
  entries: ModelCatalogEntry[],
  query: string
): ModelCatalogEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter(
    (entry) =>
      entry.id.toLowerCase().includes(q) ||
      entry.routes.some((route) => route.label.toLowerCase().includes(q))
  );
}

// The entry+route matching a persisted { provider, model } pair, or null
// when the pair is off-catalog (custom model id, or its provider has since
// been disconnected).
export function findSelectedRoute(
  entries: ModelCatalogEntry[],
  value: ModelSelection | null | undefined
): { entry: ModelCatalogEntry; route: ModelRoute } | null {
  if (!value) return null;
  for (const entry of entries) {
    for (const route of entry.routes) {
      if (route.provider === value.provider && route.providerModelId === value.model) {
        return { entry, route };
      }
    }
  }
  return null;
}

// Collapsed-trigger label: the model name plus its serving route — the
// name alone can't say whether gpt-5.5 rides Codex or OpenAI, so the route
// is always spelled out. An off-catalog pair falls back to the provider's
// display label.
export function modelTriggerLabel(
  entries: ModelCatalogEntry[],
  value: ModelSelection | null | undefined,
  fallbackProviderLabel: (provider: string) => string
): { model: string; route?: string } {
  if (!value || !value.model) return { model: "Select model" };
  const match = findSelectedRoute(entries, value);
  if (match) {
    return { model: match.entry.id, route: match.route.label };
  }
  return { model: value.model, route: fallbackProviderLabel(value.provider) };
}

// Keep in sync with the flyout wrapper's w-72 — the constant feeds the
// viewport-collision side flip in openFlyout.
const FLYOUT_WIDTH_PX = 288;

// Whether a mouseleave on the popover content is a genuine departure that
// should close the route flyout. Travel to a descendant (the flyout panel
// bridges the visual gap, so row→flyout stays inside) keeps it open, as
// does a missing relatedTarget (pointer left the window) — yanking the
// panel away mid-reach is worse than leaving it up.
export function shouldCloseFlyoutOnLeave(
  content: HTMLElement | null,
  relatedTarget: unknown
): boolean {
  if (!(relatedTarget instanceof Node)) return false;
  if (content?.contains(relatedTarget)) return false;
  return true;
}

export function ModelPicker({
  value,
  onSelect,
  disabled,
  ariaLabel
}: {
  // The persisted { provider, model } pair this control reflects.
  value?: ModelSelection | null;
  onSelect: (selection: ModelSelection) => void;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const models = useQuery({
    // Prefix-shares the ["providers"] key so every existing invalidation of
    // the provider catalog (add/edit/remove provider) refreshes this too.
    queryKey: ["providers", "models"],
    queryFn: () => api<ModelCatalogEntry[]>("/providers/models"),
    refetchInterval: 60_000
  });
  const catalog = useQuery({
    queryKey: ["providers"],
    queryFn: () => api<ProviderCatalogItem[]>("/providers/catalog"),
    refetchInterval: 60_000
  });

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  // Side flyout for a multi-route model: anchored to its row's offset within
  // the popover. `side` flips left when the viewport has no room on the right.
  const [flyout, setFlyout] = useState<{ entryId: string; top: number; side: "right" | "left" } | null>(null);
  const [flyoutHighlight, setFlyoutHighlight] = useState(0);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const baseId = useId();

  const entries = useMemo(() => models.data ?? [], [models.data]);
  const filtered = useMemo(() => filterModelEntries(entries, query), [entries, query]);
  const active = filtered.length > 0 ? Math.min(highlight, filtered.length - 1) : -1;
  const selected = useMemo(() => findSelectedRoute(entries, value), [entries, value]);
  // Look the flyout's entry up in the full list: a query edit closes the
  // flyout, but a stale frame in between must not crash on a filtered-out id.
  const flyoutEntry = flyout ? entries.find((entry) => entry.id === flyout.entryId) : undefined;

  const fallbackProviderLabel = (provider: string): string => {
    const row = (catalog.data ?? []).find((item) => item.name === provider);
    return displayProviderName(row ?? { displayName: provider, name: provider });
  };
  const label = modelTriggerLabel(entries, value, fallbackProviderLabel);
  const TriggerIcon = providerIcon(value?.model ? value.provider : undefined);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    setQuery("");
    setFlyout(null);
    // Land the highlight on the current selection so Enter re-confirms it.
    const selectedIndex = next && selected ? entries.findIndex((entry) => entry.id === selected.entry.id) : -1;
    setHighlight(selectedIndex >= 0 ? selectedIndex : 0);
  };

  const choose = (route: ModelRoute) => {
    setOpen(false);
    setFlyout(null);
    onSelect({ provider: String(route.provider), model: route.providerModelId });
  };

  const openFlyout = (entry: ModelCatalogEntry, rowEl: HTMLElement | null) => {
    if (entry.routes.length < 2 || !rowEl || !contentRef.current) return;
    const contentRect = contentRef.current.getBoundingClientRect();
    const rowRect = rowEl.getBoundingClientRect();
    const side = contentRect.right + FLYOUT_WIDTH_PX + 8 <= window.innerWidth ? "right" : "left";
    const selectedRouteIndex = entry.routes.findIndex(
      (route) => route.provider === value?.provider && route.providerModelId === value?.model
    );
    setFlyout({ entryId: entry.id, top: rowRect.top - contentRect.top, side });
    setFlyoutHighlight(selectedRouteIndex >= 0 ? selectedRouteIndex : 0);
  };

  const moveHighlight = (delta: number) => {
    if (flyout && flyoutEntry) {
      setFlyoutHighlight((current) =>
        Math.max(0, Math.min(current + delta, flyoutEntry.routes.length - 1))
      );
      return;
    }
    setFlyout(null);
    setHighlight(() => {
      const next = Math.max(0, Math.min(active + delta, filtered.length - 1));
      rowRefs.current.get(next)?.scrollIntoView({ block: "nearest" });
      return next;
    });
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveHighlight(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveHighlight(-1);
    } else if (event.key === "ArrowRight") {
      const entry = active >= 0 ? filtered[active] : undefined;
      if (!flyout && entry && entry.routes.length > 1) {
        event.preventDefault();
        openFlyout(entry, rowRefs.current.get(active) ?? null);
      }
    } else if (event.key === "ArrowLeft") {
      if (flyout) {
        event.preventDefault();
        setFlyout(null);
      }
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (flyout && flyoutEntry) {
        const route = flyoutEntry.routes[flyoutHighlight];
        if (route) choose(route);
        return;
      }
      const entry = active >= 0 ? filtered[active] : undefined;
      const route = entry?.routes.find((candidate) => candidate.default) ?? entry?.routes[0];
      if (route) choose(route);
    }
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          aria-label={ariaLabel ?? "Select model"}
          className="max-w-full gap-2"
        >
          {/* The serving route's brand mark — the model name alone can't say
              whether gpt-5.5 rides Codex or OpenAI. Falls back to the generic
              model mark when nothing is selected. */}
          <TriggerIcon className="size-4 shrink-0 text-muted-foreground" />
          <span title={label.model} className="truncate font-mono text-[13px]">{label.model}</span>
          {/* Until the route list resolves, every selection looks off-catalog
              and would flash a spurious "· provider" suffix — hold the
              name-only collapsed state instead. */}
          {label.route && !models.isPending ? (
            <span className="truncate text-[13px] font-normal text-muted-foreground">· {label.route}</span>
          ) : null}
          <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        ref={contentRef}
        align="start"
        className="relative w-96 overflow-visible p-2"
        onMouseLeave={(event) => {
          if (shouldCloseFlyoutOnLeave(contentRef.current, event.relatedTarget)) setFlyout(null);
        }}
        // Escape with the flyout open closes only the flyout; a second
        // Escape closes the popover.
        onEscapeKeyDown={(event) => {
          if (flyout) {
            event.preventDefault();
            setFlyout(null);
          }
        }}
      >
        <div
          className="flex items-center gap-2 border-b border-border px-1 pb-2"
          // Pointer parked on the search header means the user has left the
          // route flyout's row — dismiss it (scroll/row-hover already do).
          onMouseEnter={() => setFlyout(null)}
        >
          <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setHighlight(0);
              setFlyout(null);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search models…"
            aria-label="Search models"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={open}
            // The combobox drives the route flyout's listbox while it is
            // open — aria-activedescendant below points into it.
            aria-controls={flyout && flyoutEntry ? `${baseId}-flylist` : `${baseId}-list`}
            aria-activedescendant={
              flyout && flyoutEntry
                ? `${baseId}-fly-${flyoutHighlight}`
                : active >= 0
                  ? `${baseId}-opt-${active}`
                  : undefined
            }
            className="h-8 border-0 bg-transparent px-0 shadow-none focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent"
          />
        </div>
        <div
          id={`${baseId}-list`}
          role="listbox"
          aria-label="Models"
          className="mt-1 max-h-72 overflow-y-auto"
          onScroll={() => setFlyout(null)}
        >
          {models.isLoading ? (
            <p className="px-2 py-4 text-center text-[13px] text-muted-foreground">Loading models…</p>
          ) : filtered.length === 0 ? (
            <p className="px-2 py-4 text-center text-[13px] text-muted-foreground">
              {entries.length === 0 ? "No providers connected." : "No models match."}
            </p>
          ) : (
            filtered.map((entry, index) => {
              const isMulti = entry.routes.length > 1;
              const defaultRoute = entry.routes.find((route) => route.default) ?? entry.routes[0]!;
              const isSelected = selected?.entry.id === entry.id;
              const isActive = index === active;
              return (
                <div
                  key={entry.id}
                  ref={(el) => {
                    if (el) rowRefs.current.set(index, el);
                    else rowRefs.current.delete(index);
                  }}
                  role="option"
                  id={`${baseId}-opt-${index}`}
                  aria-selected={isSelected}
                  // Advertise the route flyout to assistive tech — the
                  // chevron button is skipped by option-descendant rules.
                  aria-haspopup={isMulti ? "listbox" : undefined}
                  aria-expanded={isMulti ? flyout?.entryId === entry.id : undefined}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5",
                    isActive && !flyout ? "bg-accent text-accent-foreground" : null,
                    isActive && flyout?.entryId === entry.id ? "bg-accent text-accent-foreground" : null
                  )}
                  onMouseEnter={(event) => {
                    setHighlight(index);
                    if (isMulti) openFlyout(entry, event.currentTarget);
                    else setFlyout(null);
                  }}
                  onClick={() => choose(defaultRoute)}
                >
                  <span title={entry.id} className="min-w-0 flex-1 truncate font-mono text-[13px]">{entry.id}</span>
                  {/* Every row names its serving route — the model id alone
                      can't say whether gpt-5.5 rides Codex or OpenAI. */}
                  {/* Separator for the accessible name — without it the
                      option reads "claude-sonnet-4-6Amazon Bedrock". */}
                  <span className="sr-only"> via </span>
                  {/* The model name wins the space fight: the route label
                      may shrink/truncate, the name span keeps flex-1. */}
                  <span
                    title={defaultRoute.label}
                    className={cn(
                      "min-w-0 truncate text-xs",
                      isActive ? "text-accent-foreground/70" : "text-muted-foreground"
                    )}
                  >
                    {defaultRoute.label}
                  </span>
                  {isSelected ? <CheckIcon className="size-4 shrink-0 text-[#4277FB]" /> : null}
                  {isMulti ? (
                    // Touch fallback: hover never fires there, so the chevron
                    // is a real button that opens the route flyout. Kept out
                    // of the Tab order — focusable descendants of an option
                    // are invalid for AT; ArrowRight and tap are the paths.
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-label={`Choose a route for ${entry.id}`}
                      aria-expanded={flyout?.entryId === entry.id}
                      className="-m-1 shrink-0 rounded p-1.5 hover:bg-foreground/10"
                      onClick={(event) => {
                        event.stopPropagation();
                        openFlyout(entry, event.currentTarget.closest('[role="option"]') as HTMLElement | null);
                      }}
                    >
                      <ChevronRightIcon className="size-4 text-muted-foreground" />
                    </button>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
        {flyout && flyoutEntry ? (
          // The wrapper pads (not margins) the gap between the popover edge
          // and the panel so the pointer's row→flyout path stays over a DOM
          // descendant of the content — a margin gap would fire the content's
          // mouseleave halfway across and close the flyout mid-reach.
          <div
            className={cn("absolute z-50 w-72", flyout.side === "right" ? "left-full pl-1" : "right-full pr-1")}
            style={{ top: flyout.top }}
          >
            <div
              id={`${baseId}-flylist`}
              role="listbox"
              aria-label={`Routes for ${flyoutEntry.id}`}
              className="rounded-lg bg-popover p-1 text-popover-foreground shadow-lg ring-1 ring-foreground/10"
            >
            <p className="truncate px-2 py-1 font-mono text-[11px] text-muted-foreground">
              {flyoutEntry.id} · route via
            </p>
            {flyoutEntry.routes.map((route, index) => {
              const isCurrent =
                route.provider === value?.provider && route.providerModelId === value?.model;
              const RouteIcon = providerIcon(String(route.provider));
              return (
                <div
                  key={`${route.provider}-${route.providerModelId}`}
                  role="option"
                  id={`${baseId}-fly-${index}`}
                  aria-selected={isCurrent}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                    index === flyoutHighlight ? "bg-accent text-accent-foreground" : null
                  )}
                  onMouseEnter={() => setFlyoutHighlight(index)}
                  onClick={() => choose(route)}
                >
                  <RouteIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span title={route.label} className="min-w-0 flex-1 truncate">{route.label}</span>
                  {route.default ? <Badge variant="secondary">default</Badge> : null}
                  {isCurrent ? <CheckIcon className="size-4 shrink-0 text-[#4277FB]" /> : null}
                </div>
              );
            })}
            </div>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

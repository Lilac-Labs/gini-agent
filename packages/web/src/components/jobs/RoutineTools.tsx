"use client";

import { useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  BrainIcon,
  ClockIcon,
  DatabaseIcon,
  FileTextIcon,
  GlobeIcon,
  MailIcon,
  PlugIcon,
  SearchIcon,
  SendIcon,
  SettingsIcon,
  SparklesIcon,
  TerminalIcon,
  UserRoundIcon,
  UsersIcon,
  WrenchIcon
} from "lucide-react";
import { useJobTools } from "@/lib/queries";

// Icon per toolset name in the runtime catalog (TOOL_DEFS in
// packages/runtime/src/execution/tool-catalog.ts). Unlisted toolsets fall
// back to the wrench so a new toolset never breaks the section.
const TOOLSET_ICONS: Record<string, LucideIcon> = {
  browser: GlobeIcon,
  connectors: PlugIcon,
  core: SettingsIcon,
  database: DatabaseIcon,
  email: MailIcon,
  file: FileTextIcon,
  identity: UserRoundIcon,
  jobs: ClockIcon,
  mcp: PlugIcon,
  memory: BrainIcon,
  messaging: SendIcon,
  self: SettingsIcon,
  session_search: SearchIcon,
  skills: SparklesIcon,
  subagents: UsersIcon,
  terminal: TerminalIcon,
  web_search: SearchIcon
};

// How many rows show before the "Show all" toggle — the effective catalog
// runs to dozens of tools, so the collapsed view keeps the Info tab scannable.
const COLLAPSED_COUNT = 14;

// The Tools section of a routine's Info tab: the effective tool catalog the
// job's runs dispatch with, as icon + label rows clustered by toolset (the
// server sorts toolset-then-label). Hidden entirely while there's no data —
// error and not-installed states just omit the section.
export function RoutineTools({ jobId }: { jobId?: string }) {
  const tools = useJobTools(jobId);
  const [expanded, setExpanded] = useState(false);

  if (!jobId) return null;
  if (tools.isLoading) {
    return (
      <div className="mt-8">
        <h2 className="text-[17px] font-semibold">Tools</h2>
        <div className="mt-4 text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }
  const all = tools.data?.tools ?? [];
  if (all.length === 0) return null;

  const visible = expanded ? all : all.slice(0, COLLAPSED_COUNT);

  return (
    <div className="mt-8">
      <h2 className="text-[17px] font-semibold">Tools</h2>
      <div className="mt-2 grid grid-cols-1 gap-x-8 sm:grid-cols-2">
        {visible.map((tool) => {
          const Icon = TOOLSET_ICONS[tool.toolset] ?? WrenchIcon;
          return (
            <div key={tool.name} title={tool.summary} className="flex items-center gap-3 py-[6px]">
              <Icon className="size-[15px] shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 truncate text-[13px]">{tool.label}</span>
            </div>
          );
        })}
      </div>
      {all.length > COLLAPSED_COUNT ? (
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          className="mt-2 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          {expanded ? "Show fewer" : `Show all ${all.length} tools`}
        </button>
      ) : null}
    </div>
  );
}

import type { RuntimeConfig } from "../types";
import { addAudit, mutateState, now, readState } from "../state";
import { buildToolCatalog, chatBlockLabelFor, firstSentence } from "../execution/tool-catalog";

export function listToolsets(config: RuntimeConfig) {
  const state = readState(config.instance);
  return { toolsets: state.toolsets, tools: state.tools };
}

// Display order for the toolset clusters on the routine detail pages. Leads
// with the high-signal capabilities a routine is usually about (email, files,
// memory, scheduling) and pushes the large browser cluster toward the end, so
// a collapsed first slice isn't a monotonous wall of one toolset's rows.
// Toolsets missing from this list (including future additions) sort
// alphabetically after the listed ones.
const JOB_TOOLS_TOOLSET_ORDER = [
  "email",
  "file",
  "memory",
  "jobs",
  "messaging",
  "session_search",
  "skills",
  "web_search",
  "database",
  "terminal",
  "mcp",
  "connectors",
  "subagents",
  "browser",
  "self",
  "identity"
];
const JOB_TOOLS_TOOLSET_RANK = new Map(JOB_TOOLS_TOOLSET_ORDER.map((name, index) => [name, index] as const));

// The effective tool catalog a job's runs dispatch with, for display on the
// routine detail pages. Resolves the job's owning agent and applies the same
// enabled-toolset ∩ agent-whitelist gate the dispatch path uses
// (resolveEffectiveContext in src/execution/effective-context.ts), so the
// list matches what the model actually sees. The server owns labels and
// ordering — clients render rows, they never re-derive tool names.
export function listJobTools(config: RuntimeConfig, jobId: string) {
  const state = readState(config.instance);
  const job = state.jobs.find((item) => item.id === jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);
  const agent = state.agents.find((item) => item.id === job.agentId);
  // Same nonempty condition as resolveEffectiveContext: an empty or absent
  // whitelist means "no agent restriction", not "no tools".
  const toolsetFilter = agent?.toolsets && agent.toolsets.length > 0 ? new Set(agent.toolsets) : undefined;
  const tools = buildToolCatalog(state, toolsetFilter).map((tool) => ({
    name: tool.function.name,
    label: chatBlockLabelFor(tool.function.name),
    toolset: tool.toolset,
    summary: tool.indexSummary ?? firstSentence(tool.function.description)
  }));
  // Toolset-first ordering clusters related tools (all file tools together,
  // all browser tools together) the way the routine mockup groups them, with
  // clusters in the curated display order above and labels sorted within.
  const rank = (toolset: string) => JOB_TOOLS_TOOLSET_RANK.get(toolset) ?? JOB_TOOLS_TOOLSET_ORDER.length;
  tools.sort(
    (a, b) =>
      rank(a.toolset) - rank(b.toolset) || a.toolset.localeCompare(b.toolset) || a.label.localeCompare(b.label)
  );
  return { tools };
}

export async function setToolsetStatus(config: RuntimeConfig, name: string, status: "enabled" | "disabled") {
  return mutateState(config.instance, (state) => {
    const toolset = state.toolsets.find((item) => item.name === name || item.id === name);
    if (!toolset) throw new Error(`Toolset not found: ${name}`);
    toolset.status = status;
    toolset.updatedAt = now();
    for (const tool of state.tools.filter((item) => item.toolset === toolset.name)) {
      tool.status = status === "enabled" ? "available" : "disabled";
      tool.updatedAt = now();
    }
    // Toolsets are instance-wide capability switches; individual agents
    // can further restrict via their toolset filter but the toggle itself
    // isn't owned by an agent.
    addAudit(
      state,
      {
        actor: "user",
        action: `toolset.${status}`,
        target: toolset.name,
        risk: "medium",
        evidence: { toolNames: toolset.toolNames, scopes: toolset.scopes }
      },
      { system: true }
    );
    return toolset;
  });
}

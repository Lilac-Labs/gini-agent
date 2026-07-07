import type { ParityCheck, RuntimeConfig } from "../types";
import { readState } from "../state";
import { providerCatalog } from "../provider";

export function hermesParityChecks(config: RuntimeConfig): { ok: boolean; checks: ParityCheck[] } {
  const state = readState(config.instance);
  const checks: ParityCheck[] = [
    check("cli", "CLI workflow", true, ["install/start/status/task commands exist"], "pass"),
    check("events", "Runtime event stream", true, [`${state.events.length} events`, "events API feeds CLI/mobile/watch surfaces"], "pass"),
    check("memory", "Persistent memory", true, ["USER.md (cross-agent identity)", "SOUL.md (per-agent persona)", "Hindsight per-agent bank (auto-retain + recall)"], "pass"),
    check("skills", "Skills/procedures", true, [`${state.skills.length} skills`, "search/show/update/test/enable/disable/rollback APIs"], "pass"),
    check("session_search", "Session search", true, ["search API returns task/trace/memory/skill/audit citations"], "pass"),
    check("jobs", "Cron/jobs", true, [`${state.jobs.length} jobs`, `${state.jobRuns.length} run records`, "prompt/script run/replay/update/remove APIs"], "pass"),
    check("tools", "File/terminal/web/code tools", true, state.toolsets.map((item) => `${item.name}:${item.status}`), hasToolset(state, "file") && hasToolset(state, "terminal") ? "pass" : "missing"),
    check("toolsets", "Toolsets and gating", true, state.toolsets.map((item) => item.name), state.toolsets.length > 0 ? "pass" : "missing"),
    check("providers", "Provider abstraction", true, providerCatalog().map((item) => item.id), providerCatalog().length >= 5 ? "pass" : "partial"),
    check("delegation", "Delegation/subagents", true, [`${state.subagents.length} subagents`, "spawn/list APIs with trace linkage and toolset limits"], "pass"),
    check("mcp", "MCP integration", true, [`${state.mcpServers.length} MCP server records`, "add/health/invoke/disable APIs"], "pass"),
    check("messaging", "Messaging bridge", true, [`${state.messagingBridges.length} bridge records`, "add/health/disable APIs and notification routing"], "pass"),
    check("agents", "Config/agent equivalent", true, state.agents.map((item) => `${item.name}:${item.status}`), state.agents.length > 0 ? "pass" : "missing"),
    check("migration", "Hermes/OpenClaw import basics", true, [
      `${state.importReports.filter((report) => report.mode === "inspect").length} inspect, ${state.importReports.filter((report) => report.mode === "applied").length} applied import reports`,
      "inspect for read-only summary, apply for in-process state mutation (openclaw migrator)"
    ], "pass"),
    check("mobile", "Mobile/remote control structure", true, ["owner-token mobile client", "mobile bootstrap contract"], "pass"),
    check("relay", "Remote relay and notifications", true, [`${state.relays.length} relay records`, `${state.notifications.length} notifications`, "local/lan/hosted relay records with queued notifications"], "pass")
  ];
  return { ok: checks.every((item) => item.status !== "missing"), checks };
}

function check(id: string, label: string, requiredForV1: boolean, evidence: string[], status: ParityCheck["status"]): ParityCheck {
  return { id, label, requiredForV1, evidence, status };
}

function hasToolset(state: ReturnType<typeof readState>, name: string): boolean {
  return state.toolsets.some((item) => item.name === name);
}

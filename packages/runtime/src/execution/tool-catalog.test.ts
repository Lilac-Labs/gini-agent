// Unit tests for buildToolCatalog's filtering composition.
//
// state.toolsets (enabled set) is the global "this toolset is on" filter.
// agentToolsetFilter narrows that further to an active-agent whitelist.
// Always-on tools bypass both filters so freshly cloned instances and
// tightly scoped agents can still reach the core agent capability surface:
// web_fetch, read_skill, spawn_subagent, the scheduled-job tools
// (create_job, list_jobs, update_job, delete_job, run_job), mcp_call,
// request_connector, browser_fill_secrets, request_messaging_bridge,
// and the agent-capability meta-tools whose toolsets aren't in the
// defaults (cancel_task, install_skill, enable_skill, disable_skill,
// edit_soul, edit_user_profile). The surface-gateway tool `send_message`
// (toolset `messaging`) is deliberately NOT always-on so the operator's
// toolset enable/disable kill switch keeps working; the sibling
// `request_messaging_bridge` IS always-on because it's a meta-tool
// (renders an onboarding card; doesn't egress data) and the chat
// onboarding path needs to be reachable on fresh instances.

import { describe, expect, test } from "bun:test";
import {
  applyDeferralFilter,
  buildToolCatalog,
  chatBlockArgsPreviewFor,
  deferredToolIndex,
  firstSentence,
  handleLoadTools,
  resolveLoadableTools,
  toProviderTools
} from "./tool-catalog";
import { defaultToolsets } from "../state/defaults";
import type { RuntimeState, ToolsetRecord } from "../types";

// The 21 browser tools that are deferred (the cluster minus the always-on
// browser_navigate plus the escalation/onboarding meta-tools
// browser_fill_secrets and browser_connect).
const DEFERRED_BROWSER = [
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_fill_form",
  "browser_press",
  "browser_scroll",
  "browser_back",
  "browser_console",
  "browser_dialog",
  "browser_requests",
  "browser_resize",
  "browser_cookies",
  "browser_close",
  "browser_hover",
  "browser_drag",
  "browser_select_option",
  "browser_wait_for",
  "browser_tabs",
  "browser_upload_file",
  "browser_download",
  "browser_vision"
];

function ts(name: string, status: ToolsetRecord["status"] = "enabled"): ToolsetRecord {
  return {
    id: `toolset_${name}`,
    instance: "test",
    name,
    description: "",
    status,
    toolNames: [],
    scopes: ["task"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function stateWithToolsets(toolsets: ToolsetRecord[]): RuntimeState {
  return {
    version: 1,
    instance: "test",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    tasks: [], authorizations: [], setupRequests: [], audit: [], skills: [], jobs: [],
    connectors: [], improvements: [], skillOutcomes: [], learningFindings: [],
    promotions: [], snapshots: [], tools: [], toolsets, subagents: [],
    mcpServers: [], messagingBridges: [], importReports: [], agents: [],
    activeAgentId: undefined, relays: [], notifications: [], emailWatchers: [], events: [],
    jobRuns: [], chatSessions: [], chatMessages: [], messagingMessages: [],
    runs: [], planSteps: [], usageLedger: []
  };
}

const ALWAYS_ON = new Set([
  "web_fetch",
  // The deferred-tools loader. Toolset "core" (not in defaults); always-on
  // so the model can pull any deferred schema live. Never deferred itself.
  "load_tools",
  // Always-on read-only clock on the `core` toolset (not in defaults); the
  // model must be able to answer "what time is it" regardless of toolset state.
  "get_current_time",
  "read_skill",
  "record_skill_feedback",
  "spawn_subagent",
  // spawn_task rides alongside spawn_subagent: same non-default "subagents"
  // toolset, same always-on rationale; the child-task path is depth-capped,
  // dedup-keyed, and audited.
  "spawn_task",
  "create_job",
  "list_jobs",
  "update_job",
  "delete_job",
  "run_job",
  // email_watch lives under the "email" toolset (not in defaults); always-on
  // so a fresh instance can set up an email watcher from chat. Config-only.
  "email_watch",
  "mcp_call",
  // skill_run is the generic dispatch surface for skill-bundled
  // procedures (signed-URL uploads/downloads, format conversions,
  // multi-step orchestrations). vision_query is the base primitive that
  // exposes the model's multimodal capability on arbitrary uploads.
  // Both always-on alongside mcp_call.
  "skill_run",
  "vision_query",
  "request_connector",
  // request_google_account surfaces the connect/reconnect-Google button
  // (system_note cta → Integrations page). Ungated like request_connector —
  // a revoked Google session can strand any instance, so the affordance must
  // pass toolset gating with nothing toggled — but DEFERRED like
  // list_connectors, so it joins the live tools array only via load_tools
  // (the steering that routes the model here names the tool explicitly).
  "request_google_account",
  // ask_user is the single-select question-card meta-tool (chat.choice
  // SetupRequest). Always-on like request_connector: its primary steer —
  // offering setup-vs-alternative choices before connector setup — must
  // work on a fresh instance with no toolsets toggled.
  "ask_user",
  // request_confirmation is the inline Confirm/Cancel meta-tool (the
  // confirmation.request SetupRequest). Always-on like ask_user: the agent
  // must be able to ask for consent before an irreversible third-party-facing
  // action on a fresh instance with no toolsets toggled, and it pauses even
  // under approvalMode "yolo".
  "request_confirmation",
  // browser_fill_secrets is the meta-tool path for asking the user
  // to type a value into a DOM field on the agent's browser tab. It
  // never types anything itself (it just renders a chat card), so
  // it lives outside the "browser" toolset's kill switch — same
  // logic as request_connector being outside the "connectors"
  // toolset.
  "browser_fill_secrets",
  // The chat-side messaging lifecycle meta-tools. Same always-on
  // rationale as request_connector / browser_fill_secrets — they
  // surface UI cards or read state, never egress data on their own.
  // The surface-gateway send_message tool stays GATED by the
  // messaging toolset (operators flip the toolset to disable
  // outbound DM autonomy without losing the onboarding / inventory
  // / pairing / removal affordances).
  "request_messaging_bridge",
  "list_messaging_bridges",
  "list_messaging_pairings",
  "wait_for_messaging_pair",
  "request_messaging_pairing",
  "request_remove_messaging_bridge",
  "cancel_task",
  "install_skill",
  "list_skills",
  "enable_skill",
  "disable_skill",
  // Identity-file edit tools live under the "identity" toolset which is
  // not in defaults; always-on so a fresh instance can propose SOUL.md /
  // USER.md edits. The propose-vs-approve file split is the gate.
  "edit_soul",
  "edit_user_profile"
  // The self-config tools (get_self, list_*, set_provider, …) live under
  // the "self" toolset (not in defaults) and pass gating, but they are
  // DEFERRED — they only join the live tools array once the model loads
  // them. They are asserted separately (see "deferred tools" below), not
  // in ALWAYS_ON, because ALWAYS_ON is the set that passes toolset gating
  // with no toolsets enabled (all live in the post-deferral catalog except
  // the deferred request_google_account, noted above).
]);

// The self-config / introspection tools, now direct deferred tools.
const SELF_TOOLS = [
  "get_self",
  "list_providers",
  "list_agents",
  "list_mcp_servers",
  "list_connectors",
  "set_provider",
  "use_agent",
  "create_agent",
  "rename_agent",
  "set_approval_mode",
  "list_toolsets",
  "enable_toolset",
  "disable_toolset",
  "delete_agent",
  "remove_provider",
  "set_auto_approve_commands",
  "set_dangerous_patterns",
  "add_mcp_server",
  "remove_mcp_server",
  "remove_connector",
  "rotate_connector",
  "update_self",
  "rollback_skill",
  "test_skill"
];

describe("buildToolCatalog", () => {
  test("includes only always-on (and ungated self) tools when no toolsets are enabled", () => {
    const state = stateWithToolsets([]);
    const catalog = buildToolCatalog(state);
    // buildToolCatalog returns the gated catalog INCLUDING deferred tools;
    // the self tools bypass toolset gating (deferral, applied later, is what
    // hides them from the live array). So every tool here is either always-on
    // or one of the self tools.
    for (const tool of catalog) {
      expect(ALWAYS_ON.has(tool.function.name) || tool.toolset === "self").toBe(true);
    }
    // Sanity: every always-on tool surfaces.
    const names = new Set(catalog.map((t) => t.function.name));
    for (const expected of ALWAYS_ON) {
      expect(names.has(expected)).toBe(true);
    }
    // The self tools surface (ungated) and are marked deferred.
    for (const name of SELF_TOOLS) {
      const tool = catalog.find((t) => t.function.name === name);
      expect(tool).toBeDefined();
      expect(tool?.deferred).toBe(true);
    }
  });

  test("fresh-default toolsets surface the always-on agent-capability tools plus send_message", () => {
    // Pin the contract that a freshly cloned instance's default toolset
    // state advertises the agent-capability meta-tools (cancel_task,
    // install_skill, enable_skill, disable_skill) plus the
    // memory/session_search tools. All shipped toolsets default enabled,
    // so the surface-gateway tool `send_message` is also visible.
    // `mcp_call` is always-on (no toolset gate).
    const state = stateWithToolsets(defaultToolsets("test", "2026-01-01T00:00:00.000Z"));
    const catalog = buildToolCatalog(state);
    const names = new Set(catalog.map((t) => t.function.name));
    const expectedVisible = [
      "recall_memory",
      "search_history",
      "cancel_task",
      "install_skill",
      "enable_skill",
      "disable_skill",
      "mcp_call",
      "request_connector",
      "send_message"
    ];
    for (const tool of expectedVisible) {
      expect(names.has(tool)).toBe(true);
    }
    // add_memory and update_memory were dropped as part of the
    // state.memories consolidation. See ADR
    // runtime-identity-files.md.
    expect(names.has("add_memory")).toBe(false);
    expect(names.has("update_memory")).toBe(false);
  });

  test("disabling messaging toolset hides send_message (kill switch works)", () => {
    // messaging defaults enabled. Flip it to disabled to verify the
    // kill switch still removes send_message from the catalog.
    const state = stateWithToolsets(defaultToolsets("test", "2026-01-01T00:00:00.000Z").map((t) =>
      t.name === "messaging" ? { ...t, status: "disabled" as const } : t
    ));
    const catalog = buildToolCatalog(state);
    const names = new Set(catalog.map((t) => t.function.name));
    expect(names.has("send_message")).toBe(false);
  });

  test("core meta-tools remain visible regardless of toolset state", () => {
    // cancel_task, list_skills, install_skill, enable_skill, disable_skill have no
    // separate toolset to gate them — they ride alongside spawn_subagent
    // and read_skill and stay always-on.
    const stateEmpty = stateWithToolsets([]);
    const stateAllDisabled = stateWithToolsets(defaultToolsets("test", "2026-01-01T00:00:00.000Z").map((t) => ({ ...t, status: "disabled" as const })));
    for (const state of [stateEmpty, stateAllDisabled]) {
      const names = new Set(buildToolCatalog(state).map((t) => t.function.name));
      for (const tool of ["cancel_task", "list_skills", "install_skill", "enable_skill", "disable_skill"]) {
        expect(names.has(tool)).toBe(true);
      }
    }
  });

  test("agent toolset filter narrows the catalog to file + always-on", () => {
    const state = stateWithToolsets([ts("file"), ts("terminal"), ts("memory")]);
    const catalog = buildToolCatalog(state, new Set(["file"]));
    for (const tool of catalog) {
      if (ALWAYS_ON.has(tool.function.name)) continue;
      // The self tools bypass the agent toolset filter (ungated). Everything
      // else surviving must be a file.* tool.
      if (tool.toolset === "self") continue;
      expect(tool.toolset).toBe("file");
    }
    // file_read should be present, terminal_exec should not.
    const names = new Set(catalog.map((t) => t.function.name));
    expect(names.has("file_read")).toBe(true);
    expect(names.has("terminal_exec")).toBe(false);
    // Always-on tools survive even when not listed in the agent filter.
    for (const expected of ALWAYS_ON) {
      expect(names.has(expected)).toBe(true);
    }
  });

  test("run_job is always-on with toolset 'jobs' and requires jobId", () => {
    const state = stateWithToolsets([]);
    const catalog = buildToolCatalog(state);
    const tool = catalog.find((t) => t.function.name === "run_job");
    expect(tool).toBeDefined();
    expect(tool?.toolset).toBe("jobs");
    expect(tool?.function.parameters.required).toEqual(["jobId"]);
  });

  test("create_job and update_job offer skillNames with the attach-the-recipe steering", () => {
    // The skillNames descriptions carry the in-prompt steering that makes
    // the agent attach integration skills when scheduling (ADR
    // job-skill-attachments.md). Pin the key clauses so a rewrite that
    // drops them surfaces as a test failure.
    const state = stateWithToolsets([]);
    const catalog = buildToolCatalog(state);
    const createTool = catalog.find((t) => t.function.name === "create_job");
    // The top-level description carries the attach-by-default demand — the
    // param description alone was not enough to make the model reach for it.
    expect(createTool?.function.description).toContain("ALWAYS set `skillNames`");
    const createProps = createTool?.function.parameters.properties as Record<string, { description?: string }>;
    expect(createProps.skillNames).toBeDefined();
    expect(createProps.skillNames?.description).toContain("loaded into every run");
    expect(createProps.skillNames?.description).toContain("google-calendar + google-gmail");
    // Operating recipes only — without this clause the model attaches
    // one-time setup/install/sign-in skills to recurring jobs.
    expect(createProps.skillNames?.description).toContain("Never attach one-time setup/installation skills");
    const updateTool = catalog.find((t) => t.function.name === "update_job");
    expect(updateTool?.function.description).toContain("skill attachments");
    const updateProps = updateTool?.function.parameters.properties as Record<string, { type?: unknown; description?: string }>;
    expect(updateProps.skillNames).toBeDefined();
    // update is full-replacement; [] or null clears (updateJob treats null
    // as clear), so the schema must admit null alongside array.
    expect(updateProps.skillNames?.type).toEqual(["array", "null"]);
    expect(updateProps.skillNames?.description).toContain("FULL replacement");
    expect(updateProps.skillNames?.description).toContain("[] (or null) to clear");
    expect(updateProps.skillNames?.description).toContain("Never attach one-time setup/installation skills");
  });

  test("set_provider's model-facing schema offers bedrock + awsRegion + azure routing; baseUrl is documented as ignored for anthropic/bedrock", () => {
    // This is the schema the MODEL actually sees (the SELF_OPERATIONS schema is
    // documentation-only). It offers bedrock + awsRegion and azure transport
    // fields. baseUrl exists because azure requires its per-resource endpoint,
    // but is documented as ignored for anthropic/bedrock — an env-keyed
    // provider's key is sent to whatever baseUrl is configured, so a model
    // repointing the first-party Anthropic endpoint would be a key-exfil vector.
    const state = stateWithToolsets([]);
    const catalog = buildToolCatalog(state);
    const tool = catalog.find((t) => t.function.name === "set_provider");
    expect(tool).toBeDefined();
    const props = tool!.function.parameters.properties as Record<string, { description?: string }>;
    expect(Object.keys(props).sort()).toEqual(["apiKey", "apiVersion", "authScheme", "awsRegion", "baseUrl", "deployment", "model", "provider"]);
    expect(props.provider?.description).toContain("bedrock");
    expect(props.awsRegion?.description).toContain("bedrock");
    expect(props.baseUrl?.description).toContain("Ignored for codex/echo/anthropic/bedrock");
  });

  test("skill_run is always-on with the expected required args", () => {
    // skill_run is the generic dispatch surface for skill-bundled
    // procedures (signed-URL upload flows, format conversions, multi-
    // step orchestrations) — always-on alongside mcp_call so a fresh
    // instance can invoke any enabled skill's scripts.
    const state = stateWithToolsets([]);
    const catalog = buildToolCatalog(state);
    const tool = catalog.find((t) => t.function.name === "skill_run");
    expect(tool).toBeDefined();
    expect(tool?.function.parameters.required).toEqual(["skill", "script"]);
  });

  test("vision_query is always-on (stays a base primitive in core)", () => {
    // vision_query exposes the model's internal multimodal capability —
    // same shape as browser_vision / web_fetch. Stays in core; not a
    // skill script.
    const state = stateWithToolsets([]);
    const catalog = buildToolCatalog(state);
    const tool = catalog.find((t) => t.function.name === "vision_query");
    expect(tool).toBeDefined();
    expect(tool?.function.parameters.required).toEqual(["uploadId", "question"]);
  });

  test("agent filter for a globally-disabled toolset still produces an empty (non-always-on) catalog", () => {
    const state = stateWithToolsets([ts("file", "disabled")]);
    const catalog = buildToolCatalog(state, new Set(["file"]));
    for (const tool of catalog) {
      // Only always-on tools and the ungated self tools survive when the one
      // requested toolset is globally disabled.
      expect(ALWAYS_ON.has(tool.function.name) || tool.toolset === "self").toBe(true);
    }
  });

  test("undefined agent filter falls back to global enabled set", () => {
    const state = stateWithToolsets([ts("file"), ts("terminal")]);
    const catalog = buildToolCatalog(state, undefined);
    const names = new Set(catalog.map((t) => t.function.name));
    expect(names.has("file_read")).toBe(true);
    expect(names.has("terminal_exec")).toBe(true);
  });

  describe("identity tool descriptions", () => {
    // The descriptions of `edit_user_profile` and `edit_soul` carry the
    // bulk of the in-prompt steering. Pin the key clauses so a future
    // rewrite that drops them surfaces as a test failure instead of
    // silently regressing model behavior.
    const state = stateWithToolsets([]);
    const catalog = buildToolCatalog(state);

    test("edit_user_profile description names the H2 sections and the soft cap", () => {
      const tool = catalog.find((t) => t.function.name === "edit_user_profile");
      expect(tool).toBeDefined();
      const desc = tool?.function.description ?? "";
      // H2 section convention (Identity, Preferences, Background, Goals).
      expect(desc).toContain("## Identity");
      expect(desc).toContain("## Preferences");
      // Set preferred over append.
      expect(desc).toContain('Prefer `action: "set"`');
      // Declarative-not-imperative phrasing rule.
      expect(desc).toContain("facts ABOUT the user");
      // Budget awareness clause.
      expect(desc).toContain("soft cap");
      // SKIP-list keyword (a single representative entry is enough).
      expect(desc).toContain("task progress");
      // Don't-narrate / short ack rule.
      expect(desc).toContain("Got it");
      // USER/SOUL partition: communication preferences route here, not to
      // edit_soul. A representative imperative-form example pins the rule
      // so a future rewrite that drops the preference branch surfaces.
      expect(desc).toContain("preferences");
      expect(desc).toContain("be more concise");
    });

    test("edit_soul description names the H2 sections and the soft cap", () => {
      const tool = catalog.find((t) => t.function.name === "edit_soul");
      expect(tool).toBeDefined();
      const desc = tool?.function.description ?? "";
      expect(desc).toContain("## Voice");
      expect(desc).toContain("## Style");
      expect(desc).toContain('Prefer `action: "set"`');
      expect(desc).toContain("Voice is terse");
      expect(desc).toContain("soft cap");
      // USER/SOUL partition: SOUL fires only on explicit persona
      // assignment, not on USER preferences about communication.
      expect(desc).toContain("persona");
      expect(desc).toContain("You are");
    });
  });

  describe("sensitive-boundary tool descriptions", () => {
    // browser_connect and browser_fill_secrets carry the steering for the
    // payment / PII boundary: the agent drives a sensitive flow as far as
    // it can, then escalates to the user instead of refusing. Pin the key
    // clauses so a rewrite that drops a sanctioned use surfaces as a test
    // failure. browser_fill_secrets is always-on; browser_connect rides the
    // browser toolset, so enable it.
    const state = stateWithToolsets([ts("browser")]);
    const catalog = buildToolCatalog(state);

    test("browser_connect description sanctions both sign-in unblock and sensitive-step handoff", () => {
      const tool = catalog.find((t) => t.function.name === "browser_connect");
      expect(tool).toBeDefined();
      const desc = tool?.function.description ?? "";
      // Use (1): the sign-in unblock keeps its strong steers.
      expect(desc).toContain("Sign-in unblock");
      expect(desc).toContain("NEVER a first step");
      expect(desc).toContain("I've signed in");
      // Use (2): the handoff for a user-must-act step.
      expect(desc).toContain("Sensitive-step handoff");
      expect(desc).toContain("payment");
      expect(desc).toContain("I'm done");
      // Handoff is only useful when the user's surface can render the
      // in-chat screencast (web app, not mobile / a messaging bridge).
      expect(desc).toContain("render the in-chat screencast");
      // The mode parameter selects the completion-card wording.
      const props = tool!.function.parameters.properties as Record<string, { enum?: string[]; default?: string }>;
      expect(props.mode?.enum).toEqual(["sign-in", "handoff"]);
      expect(props.mode?.default).toBe("sign-in");
    });

    test("browser_fill_secrets description names payment and checkout PII alongside credentials", () => {
      const tool = catalog.find((t) => t.function.name === "browser_fill_secrets");
      expect(tool).toBeDefined();
      const desc = tool?.function.description ?? "";
      // Credentials remain first-class.
      expect(desc).toContain("passwords, OTPs");
      // Payment / sensitive personal info at checkout is now first-class too.
      expect(desc).toContain("payment-card");
      expect(desc).toContain("checkout");
      // Existing constraints survive the broadening.
      expect(desc).toContain("NEVER for ordinary text");
      expect(desc).toContain("you never see the values");
    });
  });

  test("ask_user is options-only and open-ended asks steer to plain message text", () => {
    // The missing-substance contract: request_confirmation routes "you lack
    // the substance" to a direct question in the model's own message text
    // (the user's reply arrives as the next message), and ask_user's schema
    // requires 2-6 options — the tool only presents concrete choices. Pin
    // both descriptions so a rewrite can't reintroduce a free-text ask path.
    const state = stateWithToolsets([]);
    const catalog = buildToolCatalog(state);
    const askUser = catalog.find((t) => t.function.name === "ask_user");
    expect(askUser?.function.parameters.required).toEqual(["question", "options"]);
    const askDesc = askUser?.function.description ?? "";
    expect(askDesc).toContain("`options` is required");
    expect(askDesc).toContain("ask directly in your plain message text");
    expect(askDesc).toContain("NEVER invent multiple-choice options");
    // The Other/Skip affordances stay UI-owned — never model-supplied.
    expect(askDesc).toContain("do NOT include an \"Other\"");
    const confirmDesc = catalog.find((t) => t.function.name === "request_confirmation")?.function.description ?? "";
    expect(confirmDesc).toContain("ask for it directly in your message text");
    expect(confirmDesc).not.toContain("question-only `ask_user`");
  });

  test("web_search description steers factual/lookup questions away from memory", () => {
    // The search-vs-memory policy is the behavioral fix for models that
    // answer source-dependent questions from parametric or recalled memory
    // instead of searching. Pin the clause so a description rewrite can't
    // silently drop it. The same policy lives in the default INSTRUCTIONS.md
    // (see system-prompt.test.ts); both surfaces must carry it.
    const state = stateWithToolsets([ts("web_search")]);
    const catalog = buildToolCatalog(state);
    const desc = catalog.find((t) => t.function.name === "web_search")?.function.description ?? "";
    expect(desc).toContain("BEFORE answering");
    expect(desc).toContain("recalled memory");
    expect(desc).toContain("stable general knowledge");
  });

  test("file_write description advertises the inline generated-file surface", () => {
    const state = stateWithToolsets([ts("file")]);
    const catalog = buildToolCatalog(state);
    const desc = catalog.find((t) => t.function.name === "file_write")?.function.description ?? "";
    expect(desc).toContain("inline file card in chat");
  });

  describe("cross-toolset routing hints", () => {
    // browser_navigate's description steers content discovery to
    // web_search, and the search/fetch descriptions steer page
    // interaction to the browser tools. Each hint joins the description
    // only when its referenced toolset is reachable in the assembled
    // catalog, so the model is never pointed at tools it doesn't have.
    // The web_fetch steer is part of browser_navigate's BASE description —
    // web_fetch is always-on, so no toolset gate may drop it.
    const SEARCH_HINT = "prefer web_search over guessing URLs";
    const FETCH_STEER = "for plain content retrieval from a known URL prefer web_fetch";
    const WEB_HINT = "use the browser tools (browser_navigate) instead";
    const descOf = (catalog: ReturnType<typeof buildToolCatalog>, name: string): string =>
      catalog.find((t) => t.function.name === name)?.function.description ?? "";

    test("both toolsets enabled: hints join both sides' descriptions", () => {
      const state = stateWithToolsets([ts("browser"), ts("web_search")]);
      const catalog = buildToolCatalog(state);
      expect(descOf(catalog, "browser_navigate")).toContain(SEARCH_HINT);
      expect(descOf(catalog, "browser_navigate")).toContain(FETCH_STEER);
      expect(descOf(catalog, "web_search")).toContain(WEB_HINT);
      expect(descOf(catalog, "web_fetch")).toContain(WEB_HINT);
      // The annotation never survives catalog assembly — the provider
      // payload must carry only the (possibly extended) description.
      for (const tool of catalog) {
        expect(tool.crossToolsetHint).toBeUndefined();
      }
    });

    test("web_search toolset disabled: browser_navigate drops the search hint but keeps the web_fetch steer", () => {
      const state = stateWithToolsets([ts("browser")]);
      const catalog = buildToolCatalog(state);
      expect(descOf(catalog, "browser_navigate")).not.toContain("web_search");
      // web_fetch is always-on, so the steer toward it survives the gate.
      expect(descOf(catalog, "browser_navigate")).toContain(FETCH_STEER);
      // The browser toolset is on, so the always-on web_fetch still points
      // page-interaction work at it.
      expect(descOf(catalog, "web_fetch")).toContain(WEB_HINT);
    });

    test("browser toolset disabled: web_search and web_fetch drop the hint", () => {
      const state = stateWithToolsets([ts("web_search")]);
      const catalog = buildToolCatalog(state);
      expect(descOf(catalog, "web_search")).not.toContain(WEB_HINT);
      expect(descOf(catalog, "web_fetch")).not.toContain(WEB_HINT);
    });

    test("agent whitelist excluding browser strips the hint even when globally enabled", () => {
      const state = stateWithToolsets([ts("browser"), ts("web_search")]);
      const catalog = buildToolCatalog(state, new Set(["web_search"]));
      expect(descOf(catalog, "web_search")).not.toContain(WEB_HINT);
      expect(descOf(catalog, "web_fetch")).not.toContain(WEB_HINT);
    });
  });
});

describe("deferred tools", () => {
  // Every shipped toolset enabled, so the browser toolset is gated-in and its
  // deferred tools ride the catalog (subject to deferral, not the toolset
  // kill switch).
  const fullState = stateWithToolsets(defaultToolsets("test", "2026-01-01T00:00:00.000Z"));

  test("the 21 browser tools are deferred; load_tools, browser_navigate, browser_connect, browser_fill_secrets are core", () => {
    const catalog = buildToolCatalog(fullState);
    for (const name of DEFERRED_BROWSER) {
      const tool = catalog.find((t) => t.function.name === name);
      expect(tool).toBeDefined();
      expect(tool?.deferred).toBe(true);
    }
    // browser_navigate, the escalation/onboarding meta-tools, and the loader
    // stay core.
    for (const name of ["load_tools", "browser_navigate", "browser_connect", "browser_fill_secrets"]) {
      const tool = catalog.find((t) => t.function.name === name);
      expect(tool).toBeDefined();
      expect(tool?.deferred).not.toBe(true);
    }
  });

  test("applyDeferralFilter(catalog, ∅) drops every deferred tool but keeps core", () => {
    const catalog = buildToolCatalog(fullState);
    const filtered = applyDeferralFilter(catalog, new Set());
    const names = new Set(filtered.map((t) => t.function.name));
    for (const name of DEFERRED_BROWSER) {
      expect(names.has(name)).toBe(false);
    }
    // Core tools survive an empty loaded set.
    for (const name of ["load_tools", "browser_navigate", "browser_connect", "browser_fill_secrets", "file_read"]) {
      expect(names.has(name)).toBe(true);
    }
    // No deferred tool leaks into the empty-loaded provider array.
    expect(filtered.every((t) => !t.deferred)).toBe(true);
  });

  test("the self-config tools are deferred and absent from applyDeferralFilter(catalog, ∅)", () => {
    const catalog = buildToolCatalog(fullState);
    for (const name of SELF_TOOLS) {
      const tool = catalog.find((t) => t.function.name === name);
      expect(tool).toBeDefined();
      expect(tool?.toolset).toBe("self");
      expect(tool?.deferred).toBe(true);
    }
    const live = new Set(applyDeferralFilter(catalog, new Set()).map((t) => t.function.name));
    for (const name of SELF_TOOLS) {
      expect(live.has(name)).toBe(false);
    }
    // self_discover / self_invoke are gone.
    const allNames = new Set(catalog.map((t) => t.function.name));
    expect(allNames.has("self_discover")).toBe(false);
    expect(allNames.has("self_invoke")).toBe(false);
  });

  test("request_google_account is ungated but deferred, surfacing via the on-demand index", () => {
    // The Google reconnect affordance must pass toolset gating on any
    // instance (a revoked session can strand a fresh one), but its schema
    // stays out of the live tools array until the model loads it — the
    // steering that routes the model here names the tool, and the index
    // line carries the never-run-gws-auth-login steer.
    const emptyCatalog = buildToolCatalog(stateWithToolsets([]));
    const tool = emptyCatalog.find((t) => t.function.name === "request_google_account");
    expect(tool).toBeDefined();
    expect(tool?.toolset).toBe("connectors");
    expect(tool?.deferred).toBe(true);
    const live = new Set(applyDeferralFilter(emptyCatalog, new Set()).map((t) => t.function.name));
    expect(live.has("request_google_account")).toBe(false);
    const index = deferredToolIndex(emptyCatalog, new Set());
    const entry = index.find((e) => e.name === "request_google_account");
    expect(entry?.summary).toContain("Integrations page");
    expect(entry?.summary).toContain("gws auth login");
  });

  test("applyDeferralFilter includes a deferred tool once it is loaded", () => {
    const catalog = buildToolCatalog(fullState);
    const filtered = applyDeferralFilter(catalog, new Set(["browser_snapshot"]));
    const names = new Set(filtered.map((t) => t.function.name));
    expect(names.has("browser_snapshot")).toBe(true);
    // Sibling deferred tools that weren't loaded stay hidden.
    expect(names.has("browser_click")).toBe(false);
  });

  test("toProviderTools strips deferred/indexSummary annotations", () => {
    const catalog = buildToolCatalog(fullState);
    const snapshot = catalog.find((t) => t.function.name === "browser_snapshot")!;
    expect(snapshot.deferred).toBe(true);
    expect(snapshot.indexSummary).toBeDefined();
    const provider = toProviderTools([snapshot]);
    const spec = provider[0] as unknown as Record<string, unknown>;
    expect("deferred" in spec).toBe(false);
    expect("indexSummary" in spec).toBe(false);
    expect("toolset" in spec).toBe(false);
    expect("displayLabel" in spec).toBe(false);
  });

  test("deferredToolIndex lists unloaded deferred tools by name + summary, dropping loaded ones", () => {
    const catalog = buildToolCatalog(fullState);
    const indexEmpty = deferredToolIndex(catalog, new Set());
    const indexNames = new Set(indexEmpty.map((e) => e.name));
    for (const name of DEFERRED_BROWSER) {
      expect(indexNames.has(name)).toBe(true);
    }
    // Core tools never appear in the on-demand index.
    expect(indexNames.has("load_tools")).toBe(false);
    expect(indexNames.has("browser_connect")).toBe(false);
    // Every entry carries a non-empty summary.
    for (const entry of indexEmpty) {
      expect(entry.summary.length).toBeGreaterThan(0);
    }
    // A loaded tool drops out of the index.
    const indexAfter = deferredToolIndex(catalog, new Set(["browser_snapshot"]));
    expect(indexAfter.some((e) => e.name === "browser_snapshot")).toBe(false);
  });

  test("resolveLoadableTools partitions deferred (loadable) from unknown/core names", () => {
    const catalog = buildToolCatalog(fullState);
    const { loaded, unknown } = resolveLoadableTools(catalog, [
      "browser_snapshot",
      "browser_navigate", // now core → not loadable
      "file_read", // core → not loadable
      "nonsense_tool" // not in catalog
    ]);
    expect(loaded).toEqual(["browser_snapshot"]);
    expect(unknown.sort()).toEqual(["browser_navigate", "file_read", "nonsense_tool"].sort());
  });

  test("handleLoadTools loads deferred tools and reports newlyLoaded + alreadyLoaded + unknown", () => {
    const catalog = buildToolCatalog(fullState);
    const first = handleLoadTools(
      JSON.stringify({ names: ["browser_snapshot", "browser_click"] }),
      catalog,
      new Set()
    );
    expect(first.newlyLoaded.sort()).toEqual(["browser_click", "browser_snapshot"].sort());
    const firstEnvelope = JSON.parse(first.result) as {
      ok: boolean;
      loaded: string[];
      alreadyLoaded: string[];
      unknown: string[];
      note: string;
    };
    expect(firstEnvelope.ok).toBe(true);
    expect(firstEnvelope.loaded.sort()).toEqual(["browser_click", "browser_snapshot"].sort());
    expect(firstEnvelope.alreadyLoaded).toEqual([]);
    expect(firstEnvelope.note).toContain("callable directly");

    // Re-loading an already-loaded tool: it lands in alreadyLoaded, not
    // newlyLoaded.
    const second = handleLoadTools(
      JSON.stringify({ names: ["browser_snapshot"] }),
      catalog,
      new Set(["browser_snapshot"])
    );
    expect(second.newlyLoaded).toEqual([]);
    const secondEnvelope = JSON.parse(second.result) as { alreadyLoaded: string[] };
    expect(secondEnvelope.alreadyLoaded).toEqual(["browser_snapshot"]);
  });

  test("handleLoadTools surfaces unknown names with didYouMean suggestions", () => {
    const catalog = buildToolCatalog(fullState);
    const { result, newlyLoaded } = handleLoadTools(
      JSON.stringify({ names: ["browser_snapsho"] }), // typo
      catalog,
      new Set()
    );
    expect(newlyLoaded).toEqual([]);
    const envelope = JSON.parse(result) as {
      unknown: string[];
      didYouMean?: Record<string, string[]>;
    };
    expect(envelope.unknown).toEqual(["browser_snapsho"]);
    expect(envelope.didYouMean?.["browser_snapsho"]).toContain("browser_snapshot");
  });

  test("handleLoadTools tolerates malformed args without throwing", () => {
    const catalog = buildToolCatalog(fullState);
    const { result, newlyLoaded } = handleLoadTools("not json{", catalog, new Set());
    expect(newlyLoaded).toEqual([]);
    const envelope = JSON.parse(result) as { ok: boolean; loaded: string[] };
    expect(envelope.ok).toBe(true);
    expect(envelope.loaded).toEqual([]);
  });

  test("firstSentence trims to the first sentence and caps length", () => {
    expect(firstSentence("Open a page. Then do more.")).toBe("Open a page.");
    const long = "a".repeat(200);
    expect(firstSentence(long, 50).length).toBeLessThanOrEqual(50);
  });
});

describe("chatBlockArgsPreviewFor browser ref labels", () => {
  test("browser_click renders role + name when the resolver names the ref", () => {
    const preview = chatBlockArgsPreviewFor(
      "browser_click",
      { ref: "@e38" },
      (ref) => (ref === "@e38" ? { role: "button", name: "Buy a License" } : undefined)
    );
    expect(preview).toBe('button "Buy a License"');
  });

  test("browser_click falls back to the bare ref with no resolver", () => {
    expect(chatBlockArgsPreviewFor("browser_click", { ref: "@e38" })).toBe("@e38");
  });

  test('browser_click drops the synthetic "clickable" role and shows the name alone', () => {
    const preview = chatBlockArgsPreviewFor(
      "browser_click",
      { ref: "@e38" },
      () => ({ role: "clickable", name: "Buy a License" })
    );
    expect(preview).toBe('"Buy a License"');
  });

  test("browser_click falls back to the bare ref when the named element has no name", () => {
    const preview = chatBlockArgsPreviewFor(
      "browser_click",
      { ref: "@e38" },
      () => ({ role: "button", name: "" })
    );
    expect(preview).toBe("@e38");
  });

  test("browser_fill_form joins each field's resolved label", () => {
    const preview = chatBlockArgsPreviewFor(
      "browser_fill_form",
      { fields: [{ ref: "@e1" }, { ref: "@e2" }] },
      (ref) =>
        ref === "@e1"
          ? { role: "textbox", name: "Email" }
          : ref === "@e2"
            ? { role: "textbox", name: "Password" }
            : undefined
    );
    expect(preview).toBe('textbox "Email", textbox "Password"');
  });
});

describe("chatBlockArgsPreviewFor job names", () => {
  test("run_job resolves the job's name from its id", () => {
    const preview = chatBlockArgsPreviewFor(
      "run_job",
      { jobId: "job_6e0fd00b" },
      undefined,
      (jobId) => (jobId === "job_6e0fd00b" ? "Send daily report" : undefined)
    );
    expect(preview).toBe("Send daily report");
  });

  test("run_job falls back to the bare id when the job can't be resolved", () => {
    expect(
      chatBlockArgsPreviewFor("run_job", { jobId: "job_6e0fd00b" }, undefined, () => undefined)
    ).toBe("job_6e0fd00b");
  });

  test("run_job falls back to the bare id with no resolver", () => {
    expect(chatBlockArgsPreviewFor("run_job", { jobId: "job_6e0fd00b" })).toBe("job_6e0fd00b");
  });

  test("create_job prefers the model-supplied name over the resolver", () => {
    const preview = chatBlockArgsPreviewFor(
      "create_job",
      { name: "New job" },
      undefined,
      () => "should-not-be-used"
    );
    expect(preview).toBe("New job");
  });
});

describe("chatBlockArgsPreviewFor masking", () => {
  test("terminal_exec masks the raw command (empty preview)", () => {
    const preview = chatBlockArgsPreviewFor("terminal_exec", {
      command: 'GOOGLE_WORKSPACE_CLI_CONFIG_DIR="/Users/shelden/.gini/google-accounts/gacct" gcloud auth list'
    });
    expect(preview).toBe("");
  });
});

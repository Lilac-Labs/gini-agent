// Tool dispatch for the chat-task agent loop.
//
// Where src/tools/* parse `task.input` (legacy CLI prefix path), this module
// dispatches by tool name + structured args. Low-risk tools execute
// synchronously and return a string result the loop feeds back to the
// model. High-risk tools create an approval and return `{ pending: true }`
// — the loop captures the approval id, snapshots its messages onto the
// task, and pauses the task. When the user resolves the approval,
// agent.executeApprovedAction runs the side effect, calls
// resumeChatTask, and the loop continues with the captured tool result.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import type { RuntimeConfig, RuntimeState, Task } from "../types";
import {
  addAudit,
  appendTrace,
  assertInsideWorkspace,
  createAuthorization,
  createSetupRequest,
  createChatMessage,
  createTaskContainer,
  deleteChatSession,
  findChildContainerByCorrelationKey,
  insertChatBlock,
  isTerminalTaskStatus,
  mutateState,
  now,
  readState,
  recordUsage
} from "../state";
import { accountSelectionNeeded, addEmailWatcher, clearEmailWatcherObjective, listEmailWatchers, removeEmailWatcher, setEmailTriageEnabled, setEmailWatcherEnabled, setEmailWatcherObjective } from "../state/email-watchers";
import { ApprovalRaceLostError, ApprovedActionFailedError, TaskAlreadyTerminalError, cancelTask, findTask, resolveAuthorization, runTerminalCommand } from "../agent";
import { walkFiles, simpleDiff } from "../tools/file";
import { codeExecutionCommand } from "../tools/code";
import { MAX_SUBAGENT_DEPTH, containerChainDepth, spawnSubagent, subagentDepth } from "../capabilities/subagents";
import { matchAutoApprove } from "./auto-approve";
import { resolveApprovalPolicy, type PolicyAction } from "./policy";
import { createScheduledJob, listJobs, rebindJobDelivery, removeJob, runJobNow, updateJob, updateJobStatus } from "../jobs";
import { findSelfOperation } from "./self-registry";
import { isDeferredToolName } from "./tool-catalog";
import { buildCurrentTimeResult, resolveLocalTimeZone } from "../system-prompt";
import { recall } from "../memory";
import {
  dedupeAppendLines,
  loadSoul,
  loadUserProfile,
  previewRemoveSoulSection,
  previewRemoveUserProfileSection,
  removeSoulSection,
  removeUserProfileSection,
  scanForInjection,
  soulPath,
  userProfilePath,
  withIdentityFileLock,
  writeSoul,
  writeUserProfile,
  type IdentityFileStatus
} from "../runtime/identity-files";
import { resolveEffectiveContext } from "./effective-context";
import { importTableFromFile } from "../data/import-table";
import { dbExecute, dbListTables, dbQuery } from "../state";
import { uploadTagFor } from "../lib/upload-ref";
import { resolveEmitContext, setToolCallRunningHint } from "./chat-task-emit";
import { searchSessions } from "./search";
import { installSkillFromBody, setSkillStatus } from "../capabilities/skills";
import { recordFeedbackOutcome } from "../learning/outcomes";
import { credentialTemplateForProvider, firstUngrantedCredential, isSkillActive } from "../integrations/connectors";
import { getProvider } from "../integrations/connectors/registry";
import { resolveConnectorSecret } from "../integrations/connectors";
import { invokeMcpTool } from "../integrations/mcp";
import { braveWebSearch, exaWebSearch, formatWebSearchResults } from "../tools/web-search";
import { findSkillScript, invokeSkillScript } from "../capabilities/skill-scripts";
import { invokeVisionQuery } from "../capabilities/vision-query";
import { checkMessagingBridge, listAllowedChats } from "../integrations/messaging";
import { isBridgeSurfaceKind } from "../integrations/messaging-poller-helpers";
import { riskForAction } from "./tool-risk";
import {
  browserBack,
  browserClick,
  browserClose,
  browserConsole,
  browserCookies,
  browserDialog,
  browserDrag,
  browserFillForm,
  browserHover,
  browserNavigate,
  browserPress,
  browserRequests,
  browserResize,
  browserScroll,
  browserSelectOption,
  browserSnapshot,
  browserTabs,
  browserType,
  browserVision,
  browserWaitFor,
  peekCurrentBrowserUrl,
  resolveUploadPath
} from "../tools/browser";
import { parseFillSecretSlots, sanitizeUrlForAuditTarget } from "./browser-fill-secrets-types";

export type DispatchResult =
  // `result` is the text the model sees. An agent-produced image (e.g. a
  // browser screenshot) reaches the user by a ready-to-paste markdown tag
  // embedded IN `result` (`gini-upload://<id>`) that the model drops into its
  // reply where the picture belongs — there is no separate image channel. See
  // ADR outbound-chat-attachments.md.
  //
  // `jobId` is set only by a create_job/update_job call that actually
  // created or patched a job: a structured copy of the job's id so the
  // chat-task loop can stamp it onto the tool_call block (the routine
  // card's click target) without parsing it back out of `result`.
  // delete_job deliberately never sets it — a card pointing at a deleted
  // routine could only render its tombstone state.
  | { kind: "sync"; result: string; jobId?: string }
  | { kind: "pending"; approvalId: string };

// Universal ceiling on a single tool result, mirroring Codex's per-call
// truncation. Most tools already self-cap well below this (browser 32k,
// file/web/mcp 12k chars), but a few (read_skill, vision_query,
// search_history, db_schema, file_list/search, subagent summaries) are
// uncapped — a single huge result could otherwise dominate the model
// context and sit inside the in-loop elision's protected-recent window.
// 40k chars ≈ 10k tokens (the chars/4 estimate). It sits ABOVE the
// browser 32k self-cap so nothing that works today regresses.
const MAX_TOOL_RESULT_CHARS = 40_000;

// Cap a single tool result to MAX_TOOL_RESULT_CHARS, truncating middle-out.
//
// Performance-safe by construction: for every result at or under the cap
// this is a single `.length` compare that returns the SAME string
// reference unchanged, so normal agent behavior is byte-identical and
// there is zero quality or runtime cost on the common path. Only the rare
// oversized outlier pays a substring. Truncation is middle-out — keep the
// head (where a tool's summary/header usually lives) and the tail (where
// closing structure/totals usually live) and drop the middle — so quality
// degrades minimally, and the marker tells the model exactly how to
// recover the omitted middle. This is an ADDITIONAL ceiling on top of each
// tool's own cap, never a replacement for it.
export function capToolResultText(result: string, toolName: string): string {
  if (result.length <= MAX_TOOL_RESULT_CHARS) return result;
  const elided = result.length - MAX_TOOL_RESULT_CHARS;
  const marker = `\n\n[... ${elided} characters elided from ${toolName} to fit the context window. Re-run this tool with a narrower scope (offset/limit or a more specific query) to see the omitted middle. ...]\n\n`;
  // Reserve room for the marker, then split the remaining budget ~60% head
  // / ~40% tail. Floor on both ends keeps the final string at or under the
  // cap even after the marker is inserted.
  const budget = Math.max(0, MAX_TOOL_RESULT_CHARS - marker.length);
  const headLen = Math.floor(budget * 0.6);
  const tailLen = budget - headLen;
  return `${result.slice(0, headLen)}${marker}${result.slice(result.length - tailLen)}`;
}

// A tool failure whose model-facing message (the thrown `message`, fed back
// as the tool result so the model can steer itself) differs from what the
// user should see in the chat UI. `displayMessage` is the short, calm line
// rendered under the tool-call row; `displaySeverity` lets the client style
// it as a neutral "info" notice (gray) instead of a red error. Plain Errors
// continue to surface their full message to both the model and the user.
export class ToolDisplayError extends Error {
  readonly displayMessage: string;
  readonly displaySeverity: "info" | "error";
  constructor(modelMessage: string, opts: { displayMessage: string; severity?: "info" | "error" }) {
    super(modelMessage);
    this.name = "ToolDisplayError";
    this.displayMessage = opts.displayMessage;
    this.displaySeverity = opts.severity ?? "error";
  }
}

// Top-level entry. Routes the tool call to its handler and caps any sync
// result at the universal per-tool ceiling so a single oversized result
// can't dominate the model context. The cap lives at this boundary so
// EVERY caller (chat-task loop, subagents) is covered once, regardless of
// which tool ran. Pending/approval results pass through untouched — the
// approval path caps its result string separately when it resumes the
// loop (see agent.executeApprovedAction).
export async function dispatchToolCall(
  config: RuntimeConfig,
  taskId: string,
  toolName: string,
  toolCallId: string,
  rawArgs: string,
  messageHistory?: readonly unknown[]
): Promise<DispatchResult> {
  const result = await dispatchToolCallInner(config, taskId, toolName, toolCallId, rawArgs, messageHistory);
  // Spread so structured side-channel fields (create_job's `jobId`) survive
  // the cap rewrap.
  return result.kind === "sync"
    ? { ...result, result: capToolResultText(result.result, toolName) }
    : result;
}

// Routes the tool call to its handler. Throws on unknown
// tool names so the loop can surface that to the model as an error
// (instead of silently ignoring a hallucinated tool).
async function dispatchToolCallInner(
  config: RuntimeConfig,
  taskId: string,
  toolName: string,
  toolCallId: string,
  rawArgs: string,
  // Current chat-task turn's in-flight message buffer. Only the loop in
  // chat-task.ts owns this — it accumulates assistant tool_calls and tool
  // results across iterations of the same task run, none of which land on
  // `task.toolCallState.messages` until the task pauses for approval. Gates
  // that need to inspect the current turn's tool history (e.g. the
  // setup-skill gate inside request_connector) must look here too, not
  // only at the persisted snapshot. Optional so test callers that bypass
  // the loop keep working.
  messageHistory?: readonly unknown[]
): Promise<DispatchResult> {
  let args: Record<string, unknown>;
  try {
    args = parseArgs(rawArgs);
  } catch (error) {
    throw new Error(`Invalid JSON arguments for ${toolName}: ${error instanceof Error ? error.message : String(error)}`);
  }

  switch (toolName) {
    case "file_read":
      return { kind: "sync", result: await fileRead(config, taskId, args) };
    case "file_list":
      return { kind: "sync", result: await fileList(config, taskId, args) };
    case "file_search":
      return { kind: "sync", result: await fileSearch(config, taskId, args) };
    case "web_fetch":
      return { kind: "sync", result: await webFetchTool(config, taskId, args) };
    case "get_current_time":
      // Pure read of the runtime clock — no state, no side effects, no approval.
      // Same tz resolution as the cacheable date block (shared helper).
      return {
        kind: "sync",
        result: buildCurrentTimeResult(new Date(), resolveLocalTimeZone())
      };
    case "web_search":
      return { kind: "sync", result: await webSearchTool(config, taskId, args) };
    case "read_skill":
      return { kind: "sync", result: await readSkillTool(config, taskId, args) };
    case "record_skill_feedback":
      return { kind: "sync", result: await recordSkillFeedbackTool(config, taskId, args) };
    case "spawn_subagent":
      return { kind: "sync", result: await spawnSubagentTool(config, taskId, args) };
    case "spawn_task":
      return { kind: "sync", result: await spawnTaskTool(config, taskId, args) };
    case "create_job": {
      const created = await createJobTool(config, taskId, args);
      return { kind: "sync", result: created.result, jobId: created.jobId };
    }
    case "list_jobs":
      return { kind: "sync", result: await listJobsTool(config, taskId, args) };
    case "update_job": {
      const updated = await updateJobTool(config, taskId, args);
      return { kind: "sync", result: updated.result, jobId: updated.jobId };
    }
    case "delete_job":
      return { kind: "sync", result: await deleteJobTool(config, taskId, args) };
    case "run_job":
      return { kind: "sync", result: await runJobTool(config, taskId, args) };
    case "email_watch":
      return { kind: "sync", result: await emailWatchTool(config, taskId, args) };
    case "recall_memory":
      return { kind: "sync", result: await recallMemoryTool(config, taskId, args) };
    case "db_query":
      return { kind: "sync", result: await dbQueryTool(config, taskId, args) };
    case "db_execute":
      return { kind: "sync", result: await dbExecuteTool(config, taskId, args) };
    case "db_import":
      return { kind: "sync", result: await dbImportTool(config, taskId, args) };
    case "db_schema":
      return { kind: "sync", result: await dbSchemaTool(config, taskId, args) };
    case "edit_soul":
      return { kind: "sync", result: await editSoulTool(config, taskId, args) };
    case "edit_user_profile":
      return { kind: "sync", result: await editUserProfileTool(config, taskId, args) };
    case "search_history":
      return { kind: "sync", result: await searchHistoryTool(config, taskId, args) };
    case "send_message":
      return pendingOrAuto(config, "messaging.send", undefined, (reason) => requestSendMessage(config, taskId, toolCallId, args, reason));
    case "cancel_task":
      return { kind: "sync", result: await cancelTaskTool(config, taskId, args) };
    case "install_skill":
      return { kind: "sync", result: await installSkillTool(config, taskId, args) };
    case "enable_skill":
      return await setSkillStatusTool(config, taskId, toolCallId, args, "enabled");
    case "disable_skill":
      return await setSkillStatusTool(config, taskId, toolCallId, args, "disabled");
    case "mcp_call":
      return { kind: "sync", result: await mcpCallTool(config, taskId, args) };
    case "skill_run":
      return await skillRunDispatch(config, taskId, toolCallId, args);
    case "vision_query":
      return { kind: "sync", result: await visionQueryTool(config, taskId, args) };
    case "request_connector":
      return await requestConnectorTool(config, taskId, toolCallId, args, messageHistory);
    case "ask_user":
      return await askUserTool(config, taskId, toolCallId, args);
    case "request_confirmation":
      return await requestConfirmationTool(config, taskId, toolCallId, args);
    case "browser_fill_secrets":
      return await browserFillSecretsTool(config, taskId, toolCallId, args);
    case "request_messaging_bridge":
      return await requestMessagingBridgeTool(config, taskId, toolCallId, args);
    case "list_messaging_bridges":
      return { kind: "sync", result: await listMessagingBridgesTool(config) };
    case "list_messaging_pairings":
      return { kind: "sync", result: await listMessagingPairingsTool(config, args) };
    case "wait_for_messaging_pair":
      return await waitForMessagingPairTool(config, taskId, toolCallId, args);
    case "request_messaging_pairing":
      return await requestMessagingPairingTool(config, taskId, toolCallId, args);
    case "request_remove_messaging_bridge":
      return await requestRemoveMessagingBridgeTool(config, taskId, toolCallId, args);
    case "browser_navigate":
      return { kind: "sync", result: await browserDispatch(config, taskId, "browser.navigate", () => browserNavigate(taskId, args, config), args) };
    case "browser_snapshot":
      return { kind: "sync", result: await browserDispatch(config, taskId, "browser.snapshot", () => browserSnapshot(taskId, args, config), args) };
    case "browser_click":
      return { kind: "sync", result: await browserDispatch(config, taskId, "browser.click", () => browserClick(taskId, args), args) };
    case "browser_type":
      return { kind: "sync", result: await browserDispatch(config, taskId, "browser.type", () => browserType(taskId, args), args) };
    case "browser_fill_form":
      return { kind: "sync", result: await browserDispatch(config, taskId, "browser.fill_form", () => browserFillForm(taskId, args), args) };
    case "browser_press":
      return { kind: "sync", result: await browserDispatch(config, taskId, "browser.press", () => browserPress(taskId, args), args) };
    case "browser_scroll":
      return { kind: "sync", result: await browserDispatch(config, taskId, "browser.scroll", () => browserScroll(taskId, args), args) };
    case "browser_back":
      return { kind: "sync", result: await browserDispatch(config, taskId, "browser.back", () => browserBack(taskId, args), args) };
    case "browser_console":
      return { kind: "sync", result: await browserDispatch(config, taskId, "browser.console", () => browserConsole(taskId, args), args) };
    case "browser_dialog":
      return { kind: "sync", result: await browserDispatch(config, taskId, "browser.dialog", () => browserDialog(taskId, args), args) };
    case "browser_requests":
      return { kind: "sync", result: await browserDispatch(config, taskId, "browser.requests", () => browserRequests(taskId, args), args) };
    case "browser_resize":
      return { kind: "sync", result: await browserDispatch(config, taskId, "browser.resize", () => browserResize(taskId, args), args) };
    case "browser_cookies":
      return { kind: "sync", result: await browserDispatch(config, taskId, "browser.cookies", () => browserCookies(taskId, args), args) };
    case "browser_close":
      return { kind: "sync", result: await browserDispatch(config, taskId, "browser.close", () => browserClose(taskId, args), args) };
    case "browser_hover":
      return { kind: "sync", result: await browserDispatch(config, taskId, "browser.hover", () => browserHover(taskId, args), args) };
    case "browser_drag":
      return { kind: "sync", result: await browserDispatch(config, taskId, "browser.drag", () => browserDrag(taskId, args), args) };
    case "browser_select_option":
      return { kind: "sync", result: await browserDispatch(config, taskId, "browser.select_option", () => browserSelectOption(taskId, args), args) };
    case "browser_wait_for":
      return { kind: "sync", result: await browserDispatch(config, taskId, "browser.wait_for", () => browserWaitFor(taskId, args), args) };
    case "browser_tabs": {
      // tabs.list is read-only (low risk); tabs.new/switch/close mutate the
      // active page (medium). Encode that into the action label so the risk
      // registry in tool-risk.ts picks the right bucket without re-parsing
      // args downstream.
      const tabsAction = typeof args.action === "string" ? args.action : "";
      const label =
        tabsAction === "new" || tabsAction === "switch" || tabsAction === "close"
          ? `browser.tabs.${tabsAction}`
          : "browser.tabs.list";
      return { kind: "sync", result: await browserDispatch(config, taskId, label, () => browserTabs(taskId, args), args) };
    }
    case "browser_vision": {
      const result = await browserDispatch(config, taskId, "browser.vision", () => browserVision(taskId, args, config), args);
      // Roll the vision provider's spend into the owning task's cost row
      // so the chat UI's running token / USD total reflects the
      // out-of-band vision call. The envelope carries `cost` as a
      // CostRecord (or null) — parse it once and accumulate via
      // addCostToTask. Failures here are best-effort; the tool result
      // already flows back to the model.
      await accumulateBrowserVisionCost(config, taskId, result);
      // browserVision's result already carries `imageMarkdown` (the ready-to-
      // paste tag) in its envelope, so the model can drop the screenshot into
      // its reply inline. Nothing to lift here.
      return { kind: "sync", result };
    }
    case "browser_upload_file":
      // Uploading a workspace file egresses bytes to a remote site —
      // explicit, side-effecting, irreversible from the user's
      // perspective. Route through the approval gate like file.write.
      return pendingOrAuto(config, "browser.upload_file", undefined, (reason) => requestBrowserUpload(config, taskId, toolCallId, args, reason));
    case "browser_download":
      // Downloading writes remote bytes onto the local disk (the
      // instance-scoped downloads dir). Route through the approval gate
      // the same way browser_upload_file does; the approved click runs
      // in agent.executeApprovedAction's "browser.download" branch.
      return pendingOrAuto(config, "browser.download", undefined, (reason) => requestBrowserDownload(config, taskId, toolCallId, args, reason));
    // Self-config / self-introspection direct tools. Each maps to a
    // SelfOperation; query tools resolve sync, mutate tools route through the
    // generic self.config approval branch. The tool name IS the op name and
    // args are top-level, so the approval payload shape is identical to the
    // legacy facade — executeApprovedAction needs no change.
    case "get_self":
    case "list_providers":
    case "list_agents":
    case "list_skills":
    case "list_mcp_servers":
    case "list_connectors":
    case "list_toolsets":
    case "set_provider":
    case "use_agent":
    case "create_agent":
    case "rename_agent":
    case "set_approval_mode":
    case "enable_toolset":
    case "disable_toolset":
    case "delete_agent":
    case "remove_provider":
    case "set_auto_approve_commands":
    case "set_dangerous_patterns":
    case "add_mcp_server":
    case "remove_mcp_server":
    case "remove_connector":
    case "rotate_connector":
    case "update_self":
    case "rollback_skill":
    case "test_skill":
      return await dispatchSelfOp(config, taskId, toolCallId, toolName, args);
    case "browser_connect": {
      // browser.connect is a SetupRequest (user-actor): the user acts in the
      // in-chat screencast of the agent's headless Chrome, performs their step
      // (sign-in, or a handoff step like payment entry), then signals done.
      // There is no "auto-approve" path — the user has to perform the action —
      // so bypass pendingOrAuto and always return the pending approval id.
      //
      // Navigate-first precondition (same contract as browser_fill_secrets):
      // both sanctioned uses act on a page the agent ALREADY reached by
      // navigating — a sign-in / auth wall to clear, or a sensitive step the
      // user must perform themselves (ADR browser-connect-handoff.md).
      // Calling it cold — before any browser_navigate
      // — is a misuse that would pop a spurious "Connect" card at the user for
      // what is really an ordinary browse-the-web request. Refuse the cold call
      // and steer the agent to browse headless first; it then only escalates to
      // a Connect prompt when a navigation genuinely reaches such a step.
      // Validate the reason first so a missing reason fails identically
      // regardless of browser state. `reason` is schema-required, but a model
      // can still omit it; surface a recoverable, actionable nudge (matching
      // the other branches here) instead of a bare throw so the model simply
      // retries WITH a reason rather than seeing a terse "Error:" line and
      // stalling (issue #397).
      if (typeof args.reason !== "string" || args.reason.length === 0) {
        return {
          kind: "sync",
          result: JSON.stringify({
            ok: false,
            error:
              "browser_connect requires a `reason`: one short user-facing sentence shown on the Connect card (e.g. 'Sign in to GitHub to continue'). Re-call browser_connect with that `reason` (keep the same `url`)."
          })
        };
      }
      // "Open page" means a live session on a real http(s) URL — the same
      // notion browser_fill_secrets uses. sanitizeUrlForAuditTarget returns
      // undefined when there's no session, the page is about:blank, or the
      // scheme isn't http(s) (chrome://, data:, …) — none of which can host a
      // sign-in wall to clear.
      const hasOpenPage = sanitizeUrlForAuditTarget(peekCurrentBrowserUrl(taskId)) !== undefined;
      if (!hasOpenPage) {
        return {
          kind: "sync",
          result: JSON.stringify({
            ok: false,
            error:
              "browser_connect only acts on a page you have already reached — a sign-in wall to clear, or a step the user must perform themselves. No browser page is open yet — call browser_navigate (headless) to open the page first, and call browser_connect only when that page genuinely needs the user (a login, OAuth, or 401/403 wall, or a handoff step like payment entry)."
          })
        };
      }
      // Transport guard: the Connect card's screencast streams the SPAWNED
      // headless Chrome. When the user has attached the runtime to their OWN
      // external Chrome over CDP (state.browser is a cdp record), there is no
      // spawned browser to screencast, so a Connect card would 409 on open and
      // strand the user. The user already has their own VISIBLE Chrome — steer
      // the agent to ask them to do the step there directly, then retry.
      if ((readState(config.instance).browser?.mode ?? null) === "cdp") {
        return {
          kind: "sync",
          result: JSON.stringify({
            ok: false,
            error:
              "The user has attached their own Chrome over CDP, so there's no in-chat browser view to open. Don't surface a Connect card. Instead, tell the user to complete this step (sign-in, payment, confirmation) directly in their own Chrome window that you're driving, then retry the navigation / re-snapshot the page to continue."
          })
        };
      }
      // Surface-reachability guard (mirrors browser_fill_secrets / request_connector):
      // the Connect card's screencast renders only in a live WEB chat session.
      // A sessionless task (subagent / scheduled job / deleted session) or a
      // messaging-bridge conversation (Telegram/Discord) can't show or complete
      // the card, so minting one would park the task in waiting_approval with no
      // way to resolve it. Refuse up-front with a recoverable tool_result.
      // (The mobile app renders chat but not the screencast — that case is
      // steered in INSTRUCTIONS via the per-turn surface note, like the handoff.)
      const connectState = readState(config.instance);
      const connectTask = findTask(connectState, taskId);
      const connectSession = connectTask.chatSessionId
        ? connectState.chatSessions.find((s) => s.id === connectTask.chatSessionId)
        : undefined;
      const connectSurfaceKind = connectSession?.source?.kind ?? connectSession?.outboundMirror?.kind;
      if (!connectSession || connectSession.origin === "job") {
        return {
          kind: "sync",
          result: JSON.stringify({
            ok: false,
            error: "browser_connect surfaces an in-chat Connect card, which needs a live web chat session — this task isn't attached to one (subagent child, scheduled job, or other headless run). Don't call browser_connect here; complete the browsing without the user, or route this through the parent web chat."
          })
        };
      }
      if (isBridgeSurfaceKind(connectSurfaceKind)) {
        return {
          kind: "sync",
          result: JSON.stringify({
            ok: false,
            error: `browser_connect's in-chat browser view only works in the web chat (this conversation is over ${connectSurfaceKind}). Reply in text asking the user to open the web chat to sign in / complete the step, then continue once they confirm.`
          })
        };
      }
      // Loop guard: cap Connect cards per sign-in wall (host) per task. The
      // first card pauses the task for the user; minting it always resolves
      // before a second connect can be dispatched, so a binary "already asked"
      // check would block every legitimate later wall on the same host. Instead
      // allow a first prompt plus one retry — covers a mistyped credential or a
      // genuinely different wall on the same host later in the task — and refuse
      // the 3rd+, where re-prompting just spams identical cards because signing
      // in evidently isn't clearing the wall. The host key is intentionally
      // coarse: the count cap tolerates host/redirect churn (OAuth/IdP
      // redirects get their own host bucket; two walls on one host share a
      // bucket, but the cap of 2 softens that).
      const wall = connectWallHost(resolveConnectUrl(args, taskId));
      const cardsForWall = readState(config.instance).setupRequests.filter(
        (r) =>
          r.taskId === taskId &&
          r.action === "browser.connect" &&
          connectWallHost(typeof r.payload?.url === "string" ? r.payload.url : undefined) === wall
      ).length;
      if (cardsForWall >= MAX_CONNECT_CARDS_PER_WALL) {
        return {
          kind: "sync",
          result: JSON.stringify({
            ok: false,
            error:
              "You've already surfaced a Connect card for this site twice in this task and the step it was for (sign-in or a user handoff) hasn't been completed. Do NOT call browser_connect again for this site. If you can finish without the user acting in the browser, continue; otherwise stop and tell the user you're blocked waiting on them to complete that step on this site."
          })
        };
      }
      const approvalId = await requestBrowserConnect(config, taskId, toolCallId, args);
      return { kind: "pending", approvalId };
    }
    case "file_write":
      return pendingOrAuto(config, "file.write", undefined, (reason) => requestFileWrite(config, taskId, toolCallId, args, reason));
    case "file_patch":
      return pendingOrAuto(config, "file.patch", undefined, (reason) => requestFilePatch(config, taskId, toolCallId, args, reason));
    case "terminal_exec":
      return terminalExecDispatch(config, taskId, toolCallId, args);
    case "code_exec":
      // code_exec compiles to a terminal command. Route through the
      // policy seam as terminal.exec so dangerous-pattern matching
      // applies uniformly (a code snippet that shells out to `sudo`
      // gets gated the same way a terminal_exec would). The
      // `command` field on the payload is what the policy inspects.
      return codeExecDispatch(config, taskId, toolCallId, args);
    default:
      // Defensive backstop only. The chat-task loop gate is the PRIMARY guard:
      // it blocks any deferred tool not loaded at the start of the turn before
      // dispatch is ever reached, so a known deferred tool with its own case
      // (browser_*, the self ops) never gets here unloaded. This branch still
      // catches the residual cases that bypass that gate — a deferred tool with
      // NO dispatch case, or a name-typo onto a deferred name — returning a
      // recoverable nudge pointing at load_tools instead of the bare
      // "Unknown tool" error so the model self-corrects on the next turn.
      if (isDeferredToolName(toolName)) {
        return {
          kind: "sync",
          result: JSON.stringify({
            ok: false,
            error: `Tool '${toolName}' is available but not loaded. Call load_tools({names:['${toolName}']}) first, then call it.`
          })
        };
      }
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Tool arguments must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

// Forgiving variant of parseArgs for ChatBlock emission. The strict
// parseArgs above throws on malformed JSON to keep dispatch correct;
// emission must never abort the loop, so this helper returns an empty
// object on failure and lets the chat-task loop continue. Used by
// emitToolCallRunning in chat-task.ts.
export function parseToolArgsLenient(raw: string): Record<string, unknown> {
  try {
    return parseArgs(raw);
  } catch {
    return {};
  }
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required string argument: ${key}`);
  }
  return value;
}

function optionalString(args: Record<string, unknown>, key: string, fallback: string): string {
  const value = args[key];
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string") throw new Error(`Argument ${key} must be a string.`);
  return value;
}

function optionalNumber(args: Record<string, unknown>, key: string, fallback: number): number {
  const value = args[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || Number.isNaN(value)) throw new Error(`Argument ${key} must be a number.`);
  return value;
}

// ---------------- Sync tools ----------------

async function fileRead(config: RuntimeConfig, taskId: string, args: Record<string, unknown>): Promise<string> {
  const target = requireString(args, "path");
  const full = assertInsideWorkspace(config.workspaceRoot, target);
  const stat = statSync(full);
  if (!stat.isFile()) throw new Error(`Not a file: ${target}`);
  const content = readFileSync(full, "utf8").slice(0, 12_000);
  appendTrace(config.instance, taskId, {
    type: "tool",
    message: "File read (chat-task)",
    data: { path: target, bytes: content.length }
  });
  await recordLowRiskAudit(config, taskId, "file.read", target, { bytes: content.length });
  return content;
}

async function fileList(config: RuntimeConfig, taskId: string, args: Record<string, unknown>): Promise<string> {
  const target = optionalString(args, "path", ".");
  const full = assertInsideWorkspace(config.workspaceRoot, target);
  const entries = readdirSync(full)
    .slice(0, 200)
    .map((entry) => {
      const fp = join(full, entry);
      const stat = statSync(fp);
      return `${stat.isDirectory() ? "dir " : "file"} ${relative(config.workspaceRoot, fp)}`;
    });
  appendTrace(config.instance, taskId, {
    type: "tool",
    message: "Directory listed (chat-task)",
    data: { path: target, entries: entries.length }
  });
  await recordLowRiskAudit(config, taskId, "file.list", target, { entries: entries.length });
  return entries.join("\n") || "No entries.";
}

async function fileSearch(config: RuntimeConfig, taskId: string, args: Record<string, unknown>): Promise<string> {
  const pattern = requireString(args, "pattern");
  const target = optionalString(args, "path", ".");
  const root = assertInsideWorkspace(config.workspaceRoot, target);
  const matches: string[] = [];
  for (const file of walkFiles(config.workspaceRoot, root, 300)) {
    if (matches.length >= 100) break;
    if (!isTextLike(file)) continue;
    const content = readFileSync(file, "utf8");
    const line = content.split(/\r?\n/).findIndex((value) => value.toLowerCase().includes(pattern.toLowerCase()));
    if (line >= 0) matches.push(`${relative(config.workspaceRoot, file)}:${line + 1}`);
  }
  appendTrace(config.instance, taskId, {
    type: "tool",
    message: "Files searched (chat-task)",
    data: { pattern, dir: target, matches: matches.length }
  });
  await recordLowRiskAudit(config, taskId, "file.search", pattern, { matches: matches.length });
  return matches.join("\n") || "No matches.";
}

// Wraps a browser tool invocation with the trace+audit ceremony every other
// chat-task tool emits. Browser tools return JSON strings on their own
// (success or error), so we don't second-guess their result — we just log
// the dispatch and pass it through. Audit risk is derived from the single
// source of truth in src/execution/tool-risk.ts:
//   - read-only paths (navigate/snapshot/hover/scroll/back/press/console/
//     requests/resize/cookies/close/wait_for/tabs.list/vision) are "low"
//   - side-effecting calls (click/type/fill_form/drag/select_option/
//     dialog/tabs.{new,switch,close}) are "medium"
// browser.upload_file is classified "high" in the registry but never
// reaches this dispatcher: it's intercepted as an approval request in
// requestBrowserUpload and executed via agent.executeApprovedAction after
// explicit user consent.
//
// Callers pass a thunk so the legacy `(taskId, args)` tools and the
// config-bearing browser_vision can share one wrapper without forcing a
// uniform signature on the tool functions themselves.
async function browserDispatch(
  config: RuntimeConfig,
  taskId: string,
  action: string,
  thunk: () => Promise<string>,
  args: Record<string, unknown>
): Promise<string> {
  // Pre-side-effect terminal check. Browser tools execute their
  // action (click / type / navigate / etc.) inside the thunk
  // BEFORE any audit/state mutation; without this check a
  // `cancelTask` that landed between the chat-task per-call guard
  // releasing its `mutateState` lock and our await on `thunk()`
  // would let the browser action still mutate the page. We don't
  // have a signal to thread into Playwright, so the best we can do
  // is refuse to invoke the thunk when the task is already
  // terminal.
  const preStatus = readState(config.instance).tasks.find((t) => t.id === taskId)?.status;
  if (preStatus && isTerminalTaskStatus(preStatus)) {
    return JSON.stringify({ success: false, aborted: true, error: `Browser action skipped: task is already ${preStatus}.` });
  }
  const result = await thunk();
  const risk = riskForAction(action);
  let parsed: { success?: boolean; error?: string } = {};
  try {
    parsed = JSON.parse(result) as { success?: boolean; error?: string };
  } catch {
    // Result wasn't JSON — treat as opaque success.
    parsed = { success: true };
  }
  // When the browser tool's safety check blocks a URL (which may contain a
  // bearer/api-token pattern), the raw URL would otherwise be persisted to
  // both trace data and the audit row, where it surfaces in the activity
  // UI and on disk. Redact the URL and target in that case so secrets
  // don't leak through the audit trail. Other failures (network, timeout,
  // unknown ref) keep the URL since it's needed for debugging.
  //
  // Match both "Blocked:" (active safety rejection) and "Invalid URL:"
  // (URL parse failure) — defense in depth so any safety-rejection prefix
  // routed through this dispatcher won't leak the input string. The error
  // message itself can also echo the raw URL (e.g. `Invalid URL: <raw>`),
  // so we substitute a generic "[redacted]" string for the persisted error
  // on the redaction path while still letting the original error reach the
  // model via the returned tool result.
  const safetyBlocked =
    parsed.success === false &&
    typeof parsed.error === "string" &&
    (parsed.error.startsWith("Blocked:") || parsed.error.startsWith("Invalid URL:"));
  const safeArgs = safetyBlocked && typeof args.url === "string"
    ? { ...args, url: "[redacted]" }
    : args;
  const safeTarget = safetyBlocked && typeof args.url === "string"
    ? "[redacted]"
    : typeof args.url === "string"
      ? args.url
      : typeof args.ref === "string"
        ? args.ref
        : action;
  const safeError = safetyBlocked ? "[redacted]" : parsed.error ?? null;
  appendTrace(config.instance, taskId, {
    type: parsed.success === false ? "error" : "tool",
    message: `Browser tool ${action}`,
    data: { action, args: safeArgs, success: parsed.success !== false, error: safeError }
  });
  await mutateState(config.instance, (state: RuntimeState) => {
    const item = findTask(state, taskId);
    addAudit(
      state,
      {
        actor: "agent",
        action,
        target: safeTarget,
        risk,
        taskId: item.id,
        runId: item.runId,
        evidence: { args: safeArgs, success: parsed.success !== false, error: safeError }
      },
      { taskId: item.id }
    );
    item.updatedAt = now();
  });
  return result;
}

// Sum a per-call CostRecord into the owning task's running cost row.
// Mirrors addCost in src/execution/chat-task.ts: token totals add; USD
// estimates add when present; provider/model track the most recent call.
// This keeps task.cost honest when out-of-band side calls (like
// browser_vision's provider request) consume tokens the main agent loop
// doesn't see directly.
async function accumulateBrowserVisionCost(
  config: RuntimeConfig,
  taskId: string,
  rawResult: string
): Promise<void> {
  let parsed: { cost?: Record<string, unknown> | null } = {};
  try {
    parsed = JSON.parse(rawResult) as typeof parsed;
  } catch {
    return;
  }
  if (!parsed.cost || typeof parsed.cost !== "object") return;
  const increment = parsed.cost as {
    provider?: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    estimatedUsd?: number;
  };
  // Skip entirely if there's nothing numeric to add (e.g. the provider
  // didn't return usage). Avoids pointless mutateState round-trips.
  if (
    increment.inputTokens === undefined &&
    increment.outputTokens === undefined &&
    increment.totalTokens === undefined &&
    increment.estimatedUsd === undefined
  ) {
    return;
  }
  let visionAgentId: string | undefined;
  await mutateState(config.instance, (state: RuntimeState) => {
    const item = findTask(state, taskId);
    visionAgentId = item.agentId;
    const sum = (a: number | undefined, b: number | undefined): number | undefined => {
      if (a === undefined && b === undefined) return undefined;
      return (a ?? 0) + (b ?? 0);
    };
    const prev = item.cost;
    item.cost = {
      provider: increment.provider ?? prev?.provider ?? "",
      model: increment.model ?? prev?.model ?? "",
      inputTokens: sum(prev?.inputTokens, increment.inputTokens),
      outputTokens: sum(prev?.outputTokens, increment.outputTokens),
      totalTokens: sum(prev?.totalTokens, increment.totalTokens),
      estimatedUsd: sum(prev?.estimatedUsd, increment.estimatedUsd)
    };
    item.updatedAt = now();
  });
  // Also record this out-of-band vision spend into the durable usage ledger
  // (the home chart's sole source). The same call folds into task.cost above
  // for the live per-turn display; the chart never sums task.cost, so there is
  // no double count.
  void recordUsage(
    config.instance,
    { source: "vision", taskId, agentId: visionAgentId },
    {
      provider: increment.provider ?? "",
      model: increment.model ?? "",
      inputTokens: increment.inputTokens,
      outputTokens: increment.outputTokens,
      totalTokens: increment.totalTokens,
      estimatedUsd: increment.estimatedUsd
    }
  ).catch(() => {});
}

// Classify a host string as one of: loopback (127/8, ::1, "localhost",
// "0.0.0.0"), private (RFC1918 IPv4 + ULA IPv6), linkLocal (169.254/16,
// fe80::/10), public (anything else parsable), or unknown (a hostname
// we can't classify without DNS resolution).
function classifyHost(host: string): "loopback" | "private" | "linkLocal" | "public" | "unknown" {
  const stripped = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const lower = stripped.toLowerCase();
  // Literal hostnames that always mean loopback regardless of /etc/hosts
  // mapping. "*.localhost" is RFC 6761 — DNS clients SHOULD treat it as
  // local even if a public DNS server returns something else, so we
  // refuse it pre-resolution.
  if (lower === "localhost" || lower.endsWith(".localhost")) return "loopback";
  const ipVersion = isIP(stripped);
  if (ipVersion === 4) {
    const parts = stripped.split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return "unknown";
    if (parts[0] === 127) return "loopback";
    if (parts[0] === 0) return "loopback";
    if (parts[0] === 10) return "private";
    if (parts[0] === 172 && (parts[1] ?? 0) >= 16 && (parts[1] ?? 0) <= 31) return "private";
    if (parts[0] === 192 && parts[1] === 168) return "private";
    if (parts[0] === 169 && parts[1] === 254) return "linkLocal";
    // RFC 6598 carrier-grade NAT space: 100.64.0.0/10. Not RFC1918
    // but treated equivalently — these are not globally routable and
    // can be used to reach a CGN-internal service that proxies the
    // SSRF target. Span: 100.64 through 100.127.
    if (parts[0] === 100 && (parts[1] ?? 0) >= 64 && (parts[1] ?? 0) <= 127) return "private";
    // RFC 2544 benchmark/test space: 198.18.0.0/15. Often routed to
    // internal lab gear; treat as private for the same reason.
    if (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) return "private";
    return "public";
  }
  if (ipVersion === 6) {
    if (lower === "::1" || lower === "::" || lower === "::0") return "loopback";
    // Unique local addresses (fc00::/7) and link-local (fe80::/10). The
    // prefix check is loose but errs on the side of refusing more than
    // strictly necessary, which is the right direction for an SSRF
    // guard.
    if (lower.startsWith("fc") || lower.startsWith("fd")) return "private";
    // IPv6 link-local is fe80::/10 — first 10 bits 1111111010, so
    // the leading hex byte is fe80–febf. A prefix check on "fe80"
    // misses fe81..febf; widen to the full /10 range.
    if (/^fe[89ab]/.test(lower)) return "linkLocal";
    // IPv4-mapped IPv6 forms. Three shapes are all valid IPv6
    // literals for the same underlying IPv4 address; each must be
    // reclassified on the embedded IPv4 or the guard is bypassable:
    //   a. mixed dot-quad: "::ffff:127.0.0.1"
    //   b. pure hex IPv4-mapped: "::ffff:7f00:1"
    //   c. deprecated IPv4-compatible: "::7f00:1" (no ffff). Node's
    //      URL parser normalizes "[::127.0.0.1]" to this form, so
    //      it shows up unprompted even when the agent passed a
    //      dot-quad-looking URL.
    const mappedDotQuad = lower.match(/^::ffff:([\d.]+)$/);
    if (mappedDotQuad) return classifyHost(mappedDotQuad[1] ?? "");
    const mappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    const compatHex = lower.match(/^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    const hex = mappedHex ?? compatHex;
    if (hex) {
      const hi = parseInt(hex[1] ?? "0", 16);
      const lo = parseInt(hex[2] ?? "0", 16);
      if (Number.isFinite(hi) && Number.isFinite(lo)) {
        const ipv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
        return classifyHost(ipv4);
      }
    }
    return "public";
  }
  return "unknown";
}

// SSRF guard for the agent's web_fetch tool. The agent might be
// prompt-injected into fetching the local BFF
// (http://127.0.0.1:<bff>/api/runtime/approvals) which would inject
// the runtime bearer and return state including secrets. Refuse
// loopback / RFC1918 / link-local destinations both at the URL
// literal AND post-DNS so a hostname that resolves to a private
// address can't sneak through. Doesn't defeat full DNS rebinding
// (TTL=0 swap between resolve and fetch) — that's a separate
// hardening layer that would require dialing the resolved IP
// directly.
async function assertPublicWebFetchTarget(parsed: URL): Promise<void> {
  const literalKind = classifyHost(parsed.hostname);
  if (literalKind === "loopback" || literalKind === "private" || literalKind === "linkLocal") {
    throw new Error(
      `web_fetch refuses ${literalKind} destination ${parsed.hostname}: agent tools may not reach loopback, RFC1918, or link-local addresses.`
    );
  }
  if (literalKind === "unknown") {
    // It's a hostname we couldn't classify pre-DNS. Resolve and
    // re-classify the address.
    try {
      const { address } = await lookup(parsed.hostname);
      const resolvedKind = classifyHost(address);
      if (resolvedKind === "loopback" || resolvedKind === "private" || resolvedKind === "linkLocal") {
        throw new Error(
          `web_fetch refuses ${parsed.hostname} (resolves to ${resolvedKind} address ${address}).`
        );
      }
    } catch (err) {
      // DNS failure: let the subsequent fetch surface the failure
      // organically; don't swallow our own refusal.
      if (err instanceof Error && err.message.startsWith("web_fetch refuses")) throw err;
    }
  }
}

// Cap on automatic redirect hops. Five is consistent with the
// default browser limit and prevents a server that 302s in a loop
// from holding the agent's tool slot.
const WEB_FETCH_MAX_REDIRECTS = 5;

async function webFetchTool(config: RuntimeConfig, taskId: string, args: Record<string, unknown>): Promise<string> {
  const rawUrl = requireString(args, "url");
  let current = new URL(rawUrl);
  if (current.protocol !== "https:" && current.protocol !== "http:") throw new Error("web_fetch requires an http(s) URL.");
  await assertPublicWebFetchTarget(current);

  // Manual redirect handling: default fetch() follows redirects, which
  // would let a public URL 302 into loopback / RFC1918 and bypass the
  // pre-fetch guard. Loop with redirect:"manual" and re-validate the
  // Location target on every hop. The fetch DNS resolution still
  // happens inside fetch() so a full DNS-rebinding attacker (TTL=0
  // swap between assertPublicWebFetchTarget's lookup and the actual
  // dial) can still slip through — closing that requires dialing the
  // resolved IP directly with hostname-in-Host-header + SNI overrides,
  // which Bun doesn't expose cleanly today. The redirect-bypass leg
  // is the bigger blast radius and is closed here.
  let response: Response;
  let hops = 0;
  for (;;) {
    response = await fetch(current, { redirect: "manual" });
    if (response.status < 300 || response.status >= 400) break;
    const location = response.headers.get("location");
    if (!location) break;
    if (hops >= WEB_FETCH_MAX_REDIRECTS) {
      throw new Error(`web_fetch refused after ${WEB_FETCH_MAX_REDIRECTS} redirects from ${parsed_origin(current)} (loop or chain too long).`);
    }
    // Resolve relative redirects against the previous URL so we
    // validate the actual destination, not a partial path.
    const next = new URL(location, current);
    if (next.protocol !== "https:" && next.protocol !== "http:") {
      throw new Error(`web_fetch refuses redirect to non-http(s) URL: ${next.protocol}`);
    }
    await assertPublicWebFetchTarget(next);
    current = next;
    hops += 1;
  }
  const text = (await response.text())
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 12_000);
  // Log only the origin (protocol + host) in trace + audit. The
  // path can carry tokens (signed-URL signatures, OAuth-via-path
  // styles, the occasional poorly-designed "personal key in URL"
  // pattern) and any server-controlled redirect can add more, so
  // including pathname risks leaking credentials into the trace.
  // Operators who need the exact endpoint can read the original
  // tool_call args from the conversation transcript; the audit
  // row's job is to attest "the agent reached this host" without
  // revealing what it asked for.
  const sanitizedUrl = `${current.protocol}//${current.host}`;
  appendTrace(config.instance, taskId, {
    type: "tool",
    message: "Web page fetched (chat-task)",
    data: { url: sanitizedUrl, status: response.status, bytes: text.length, redirects: hops }
  });
  await recordLowRiskAudit(config, taskId, "web.fetch", sanitizedUrl, { status: response.status, bytes: text.length, redirects: hops });
  return text || `Fetched ${sanitizedUrl} with HTTP ${response.status}.`;
}

// Tiny helper kept inline because it's only used by the redirect-cap
// error message — avoids leaking query strings / fragments into the
// exception while still naming the origin of the redirect chain.
function parsed_origin(url: URL): string {
  return `${url.protocol}//${url.host}`;
}

// Web search via Brave or Exa. Pick a healthy connector by provider id
// (model-supplied `provider` arg wins; otherwise Brave > Exa). The token
// is resolved through the standard connector secrets path so the audit
// trail records the resolution without ever logging the key.
type WebSearchProvider = "brave-search" | "exa";

const WEB_SEARCH_PREFERENCE: WebSearchProvider[] = ["brave-search", "exa"];

async function webSearchTool(config: RuntimeConfig, taskId: string, args: Record<string, unknown>): Promise<string> {
  const query = requireString(args, "query");
  const count = Math.min(Math.max(Math.trunc(optionalNumber(args, "count", 5)), 1), 10);
  const requested = (args.provider === undefined || args.provider === null || args.provider === "")
    ? undefined
    : requireString(args, "provider");
  if (requested && requested !== "brave-search" && requested !== "exa") {
    throw new Error(`Unsupported web_search provider: ${requested}. Use 'brave-search' or 'exa'.`);
  }

  const state = readState(config.instance);
  const candidates: WebSearchProvider[] = requested
    ? [requested as WebSearchProvider]
    : WEB_SEARCH_PREFERENCE;

  let connector: typeof state.connectors[number] | undefined;
  let providerId: WebSearchProvider | undefined;
  for (const id of candidates) {
    const found = state.connectors.find(
      (c) => c.provider === id && c.status === "configured" && c.health === "healthy"
    );
    if (found) {
      connector = found;
      providerId = id;
      break;
    }
  }
  if (!connector || !providerId) {
    const wanted = requested ?? "brave-search or exa";
    // When the model named a specific provider, the user may already have a
    // DIFFERENT search provider connected — so "No search provider connected."
    // would be false. Name the missing one instead. The no-`provider` case
    // keeps the generic line (nothing is connected at all).
    const requestedLabel = requested ? (getProvider(requested)?.label ?? requested) : undefined;
    throw new ToolDisplayError(
      `Web search via a connector is unavailable: no healthy ${wanted} connector. You still have live-web tools, so do NOT answer from memory — search another way and answer from what you find: use browser_navigate to query a search engine (e.g. https://duckduckgo.com/?q=<query> or https://www.google.com/search?q=<query>) and read the results, or web_fetch a search-results URL. Querying a real search engine like this IS searching; only guessing random content URLs is not. You can also call request_connector with provider '${requested ?? "brave-search"}' to add a search API key for faster, cleaner results going forward, then retry this tool.`,
      {
        displayMessage: requestedLabel ? `${requestedLabel} is not connected.` : "No search provider connected.",
        severity: "info"
      }
    );
  }

  const token = await resolveConnectorSecret(config, connector.id, "token", taskId);
  if (!token) throw new Error(`Connector ${connector.name} is missing its token secret.`);

  const results = providerId === "brave-search"
    ? await braveWebSearch(token, query, count)
    : await exaWebSearch(token, query, count);

  appendTrace(config.instance, taskId, {
    type: "tool",
    message: "Web search completed",
    data: { provider: providerId, query, count: results.length }
  });
  await recordLowRiskAudit(config, taskId, "web.search", query, {
    provider: providerId,
    requested,
    count: results.length,
    connectorId: connector.id
  });
  return formatWebSearchResults(providerId, query, results);
}

// Skill catalog access. Returns the full markdown body of an enabled skill
// so the model can follow its instructions. We deliberately gate on the
// "enabled" status — disabled / archived skills are invisible
// to the agent loop. The system prompt only advertises enabled skills, so
// the model shouldn't request anything else; if it does, surface the
// reason to the model as a tool error rather than silently returning empty.
async function readSkillTool(config: RuntimeConfig, taskId: string, args: Record<string, unknown>): Promise<string> {
  const name = requireString(args, "name");
  const state = readState(config.instance);
  // When both a bundled and a user record share a name, prefer an enabled
  // bundled row first, then any enabled row. This mirrors the advertised
  // skill block: disabled rows stay invisible even when they share a name
  // with an enabled skill.
  const matches = state.skills.filter((s) => s.name === name);
  if (matches.length === 0) throw new Error(`No skill named ${name} is registered.`);
  const enabledMatches = matches.filter((s) => s.status === "enabled");
  const skill = enabledMatches.find((s) => (s.source ?? "user") === "bundled") ?? enabledMatches[0] ?? matches[0]!;
  if (skill.status !== "enabled") {
    throw new Error(`Skill ${name} is disabled (current status: ${skill.status}). Ask the user to enable it via /skills before using.`);
  }
  if (!isSkillActive(state, skill)) {
    const missing = (skill.requiredConnectors ?? []).map((entry) => entry.provider).join(", ");
    throw new Error(`Skill ${name} is inactive: required connectors not healthy (${missing || "unknown"}). Ask the user to set up the missing connector — they can click [Set up <Provider>] next to the affected skill on the /skills page, or call request_connector so they can enter it securely.`);
  }
  appendTrace(config.instance, taskId, {
    type: "tool",
    message: "Skill body read (chat-task)",
    data: { name: skill.name, version: skill.version, bytes: skill.body.length, allowedTools: skill.allowedTools }
  });
  await recordLowRiskAudit(config, taskId, "skill.read", skill.id, {
    name: skill.name,
    version: skill.version,
    bytes: skill.body.length,
    // ADR connector-provider-spec-compliance.md: capture the declared allowed-tools at read time so the audit
    // trail records the contract the agent agreed to follow when invoking
    // this skill. Not enforced at the tool dispatcher yet — see ADR connector-provider-spec-compliance.md
    // "Deferred" for the enforcement plan.
    allowedTools: skill.allowedTools
  });
  return skill.body || "(skill body is empty)";
}

// Skill-learning feedback capture (ADR skill-learning-from-outcomes.md). The
// model calls this when the user answers a "Skill review" question about a
// recent action. It records the verdict as a SkillOutcome with
// source:"user_feedback" — a negative answer attributed to the named skill so
// the next review reflects on it. Low-risk: appends one bounded row.
async function recordSkillFeedbackTool(config: RuntimeConfig, taskId: string, args: Record<string, unknown>): Promise<string> {
  const targetTaskId = requireString(args, "task_id");
  const ok = args.ok;
  if (typeof ok !== "boolean") throw new Error("Argument ok must be a boolean.");
  const skillName = optionalString(args, "skill_name", "");
  const detail = optionalString(args, "detail", "");
  // Attribute the feedback row to the agent that ran the judged task when known.
  const agentId = readState(config.instance).tasks.find((t) => t.id === targetTaskId)?.agentId;
  const outcome = await recordFeedbackOutcome(config, {
    skillName: skillName || undefined,
    taskId: targetTaskId,
    agentId,
    ok,
    detail: detail || undefined
  });
  await recordLowRiskAudit(config, taskId, "skill.feedback.recorded", outcome.skillId ?? outcome.id, {
    taskId: targetTaskId,
    signal: outcome.signal,
    skillName: outcome.skillName
  });
  return ok
    ? `Recorded: the action turned out right${outcome.skillName ? ` (${outcome.skillName})` : ""}.`
    : `Recorded a problem${outcome.skillName ? ` with ${outcome.skillName}` : ""} — the next skill review will look at it.`;
}

// Generic MCP tool dispatch. Routes (server, tool, arguments) to the
// matching McpServerRecord and returns the flattened text content the
// tool produced. Errors come back as a JSON envelope rather than thrown
// exceptions so the model can read the failure and recover (e.g. retry
// with corrected arguments) instead of seeing a generic tool-error.
//
// Result text is capped at 12000 chars to bound prompt growth; Linear's
// list_issues can return many pages of issue blobs.
async function mcpCallTool(
  config: RuntimeConfig,
  taskId: string,
  args: Record<string, unknown>
): Promise<string> {
  const serverName = requireString(args, "server");
  const toolName = requireString(args, "tool");
  const toolArgs = (args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments))
    ? args.arguments as Record<string, unknown>
    : {};
  const state = readState(config.instance);
  const server = state.mcpServers.find(
    (item) => item.name.toLowerCase() === serverName.toLowerCase() || item.id === serverName
  );
  if (!server) {
    return JSON.stringify({ ok: false, error: `Unknown MCP server: ${serverName}. Configured servers: ${state.mcpServers.map((s) => s.name).join(", ") || "(none)"}` });
  }
  if (server.status !== "configured") {
    return JSON.stringify({ ok: false, error: `MCP server ${server.name} is not configured (status: ${server.status}). Ask the user to run 'gini mcp health ${server.name}' or re-add credentials.` });
  }
  if (server.transport === "http" && !server.url) {
    return JSON.stringify({ ok: false, error: `MCP server ${server.name} is http transport but has no url.` });
  }
  appendTrace(config.instance, taskId, {
    type: "tool",
    message: `MCP tool ${server.name}/${toolName}`,
    data: { server: server.name, tool: toolName, argBytes: JSON.stringify(toolArgs).length }
  });
  let result: { ok: boolean; stdout?: string; message?: string };
  try {
    result = await invokeMcpTool(config, server.id, toolName, toolArgs, { taskId });
  } catch (error) {
    return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
  if (!result.ok) {
    return JSON.stringify({ ok: false, error: result.message ?? "MCP tool failed.", content: truncate(result.stdout ?? "", 12_000) });
  }
  return truncate(result.stdout ?? "", 12_000);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n... (truncated)`;
}

// skill_run dispatch wrapper: scripts a skill declares under
// `metadata.gini.requires.approval` ALWAYS pause for an explicit user
// Approve/Deny — mode-independent, like browser_connect bypassing
// pendingOrAuto. auto/yolo must NOT bypass this gate: a gated script
// (e.g. phone-call/place-call) performs an outward-facing, irreversible
// side effect, and the approval card IS the user's confirmation.
// Ungated scripts stay on the plain sync path below.
//
// The gate lives HERE, in skill_run dispatch, and deliberately NOT in
// invokeSkillScript: internal callers — the skill-script pre-run hook
// handler (skill-script-hook.ts) and the approved-action executor in
// agent.ts — call invokeSkillScript directly and must stay ungated. See
// ADR skill-script-approval-gating.md.
async function skillRunDispatch(
  config: RuntimeConfig,
  taskId: string,
  toolCallId: string,
  args: Record<string, unknown>
): Promise<DispatchResult> {
  const skillName = requireString(args, "skill");
  const scriptName = requireString(args, "script");
  const handle = findSkillScript(readState(config.instance), skillName, scriptName);
  if (handle && (handle.skill.requiresApprovalScripts ?? []).includes(scriptName)) {
    let approvalId: string;
    try {
      approvalId = await requestSkillScriptApproval(config, taskId, toolCallId, skillName, scriptName, skillScriptArgs(args));
    } catch (err) {
      // Same conversion pendingOrAuto performs: a terminal task means
      // the approval row was never created — surface a clean skip.
      if (err instanceof TaskAlreadyTerminalError) {
        return { kind: "sync", result: `Action skipped: task was already ${err.status} when the request reached the runtime.` };
      }
      throw err;
    }
    return { kind: "pending", approvalId };
  }
  const result = await skillRunTool(config, taskId, args);
  // attachments/promote-file lifts a workspace file into the upload space and
  // returns { ok, uploadId, mimeType, size, filename }. For ANY successful
  // promote, augment the model-facing result with a ready-to-paste markdown
  // tag (`attachmentMarkdown`) the model drops into its reply WHERE the
  // attachment belongs (inline, mid-prose). An image yields an image tag
  // (renders as a picture); any other file yields a link tag (renders a
  // download chip). This is the path the agent reaches for to "send" a file —
  // a screenshot from terminal_exec, a generated PDF/CSV, a log. See ADR
  // outbound-chat-attachments.md.
  return { kind: "sync", result: withPromoteFileAttachmentTag(skillName, scriptName, result) };
}

// Given an attachments/promote-file result, return it augmented with an
// `attachmentMarkdown` field (the ready-to-paste tag) for any successful
// promote, choosing image-vs-link syntax by mime. Returns the result unchanged
// for any other skill/script, a failed promote, or a malformed envelope. The
// tag embeds the canonical `gini-upload://<id>` ref the clients rewrite to
// their authed source.
export function withPromoteFileAttachmentTag(
  skillName: string,
  scriptName: string,
  rawResult: string
): string {
  if (skillName !== "attachments" || scriptName !== "promote-file") return rawResult;
  let parsed: { ok?: unknown; uploadId?: unknown; mimeType?: unknown; filename?: unknown };
  try {
    parsed = JSON.parse(rawResult) as typeof parsed;
  } catch {
    return rawResult;
  }
  if (parsed.ok !== true) return rawResult;
  const id = String(parsed.uploadId ?? "");
  if (id.length === 0) return rawResult;
  const tag = uploadTagFor(id, {
    mimeType: String(parsed.mimeType ?? ""),
    filename: typeof parsed.filename === "string" ? parsed.filename : undefined
  });
  // Re-serialize with the tag added so the model sees a single JSON object.
  return JSON.stringify({ ...(parsed as Record<string, unknown>), attachmentMarkdown: tag });
}

// Mint the skill.run approval row. Mirrors requestTerminalExec: the
// reason is what the user reads on the approval card, so it carries a
// compact preview of the script args alongside the skill/script pair.
async function requestSkillScriptApproval(
  config: RuntimeConfig,
  taskId: string,
  toolCallId: string,
  skillName: string,
  scriptName: string,
  scriptArgs: Record<string, unknown>
): Promise<string> {
  const preview = JSON.stringify(scriptArgs);
  const argsPreview = preview.length > 400 ? `${preview.slice(0, 400)}…` : preview;
  return mutateState(config.instance, (state: RuntimeState) => {
    const item = findTask(state, taskId);
    if (isTerminalTaskStatus(item.status)) {
      throw new TaskAlreadyTerminalError(taskId, item.status);
    }
    const approval = createAuthorization(state, {
      taskId: item.id,
      action: "skill.run",
      target: `${skillName}/${scriptName}`,
      risk: "high",
      reason: `Run skill script ${skillName}/${scriptName}: ${argsPreview}`,
      payload: { skillName, scriptName, scriptArgs, toolCallId }
    });
    item.approvalIds.push(approval.id);
    item.updatedAt = now();
    appendTrace(config.instance, item.id, {
      type: "approval",
      message: "Approval requested for skill script (chat-task)",
      data: { approvalId: approval.id, skill: skillName, script: scriptName, toolCallId }
    });
    return approval.id;
  });
}

// The optional `args` object a skill_run call forwards to the script.
function skillScriptArgs(args: Record<string, unknown>): Record<string, unknown> {
  return args.args && typeof args.args === "object" && !Array.isArray(args.args)
    ? args.args as Record<string, unknown>
    : {};
}

// skill_run dispatch: looks up the requested skill+script and spawns the
// script with stdin = JSON args. Returns the script's JSON stdout
// verbatim, or a clear { ok: false, error } envelope on script failure
// / missing script / malformed output. See src/capabilities/skill-
// scripts.ts for the spawn + env-injection details.
async function skillRunTool(
  config: RuntimeConfig,
  taskId: string,
  args: Record<string, unknown>
): Promise<string> {
  const skillName = requireString(args, "skill");
  const scriptName = requireString(args, "script");
  const scriptArgs = skillScriptArgs(args);
  const handle = findSkillScript(readState(config.instance), skillName, scriptName);
  if (!handle) {
    return JSON.stringify({
      ok: false,
      error: `Skill script not found: ${skillName}/${scriptName}. The skill must be enabled and ship a top-level file named ${scriptName}.<ext> under scripts/.`
    });
  }
  const result = await invokeSkillScript(config, handle, scriptArgs, { taskId });
  if (result.parsed !== null && result.parsed !== undefined) {
    return typeof result.parsed === "string" ? result.parsed : JSON.stringify(result.parsed);
  }
  return JSON.stringify({ ok: result.ok, error: result.error ?? "Skill script returned no output." });
}

// vision_query dispatch: runs the configured vision model against an
// arbitrary Gini upload.
async function visionQueryTool(
  config: RuntimeConfig,
  taskId: string,
  args: Record<string, unknown>
): Promise<string> {
  const uploadId = requireString(args, "uploadId");
  const question = requireString(args, "question");
  const maxTokens = typeof args.maxTokens === "number" ? args.maxTokens : undefined;
  const result = await invokeVisionQuery(config, { uploadId, question, maxTokens }, { taskId });
  return JSON.stringify(result);
}

// Spawn a constrained subagent and wait for its terminal state. The model
// gets the child's summary back as the tool result. We deliberately resolve
// synchronously (from the model's perspective) so the agent loop sees a
// straightforward request/response pattern and doesn't need a separate
// resume flow for delegation. Approval-gated tool calls inside the
// subagent block the subagent task, not the parent — the parent just
// polls for the final state.
//
// Depth is capped via MAX_SUBAGENT_DEPTH to prevent runaway nesting; the
// cap is enforced both here (before submitting) and inside spawnSubagent
// itself for defense-in-depth.
async function spawnSubagentTool(
  config: RuntimeConfig,
  taskId: string,
  args: Record<string, unknown>
): Promise<string> {
  const name = requireString(args, "name");
  const prompt = requireString(args, "prompt");
  const goal = typeof args.goal === "string" ? args.goal : undefined;
  const context = typeof args.context === "string" ? args.context : undefined;
  const systemPrompt = typeof args.system_prompt === "string" ? args.system_prompt : undefined;
  const toolsets = Array.isArray(args.toolsets) ? args.toolsets.map(String) : undefined;
  const skills = Array.isArray(args.skills) ? args.skills.map(String) : undefined;
  const timeoutMs = typeof args.timeout_ms === "number" && args.timeout_ms > 0 ? args.timeout_ms : 5 * 60 * 1000;

  // Pre-side-effect terminal check. `spawnSubagent` creates a
  // durable child task; refuse when the parent task is already
  // terminal so cancel + auto-approve doesn't leak a fresh subagent
  // run against a cancelled parent. The serialized re-check inside
  // `spawnSubagent`'s `mutateState` is the authoritative guard;
  // this is the cheap early-exit so we don't even reach the
  // record-creation lock.
  const stateNow = readState(config.instance);
  const parentStatus = stateNow.tasks.find((t) => t.id === taskId)?.status;
  if (parentStatus && isTerminalTaskStatus(parentStatus)) {
    return `Error: spawn_subagent skipped because parent task is already ${parentStatus}.`;
  }

  // Pre-flight depth check so we can return a clean error to the model
  // instead of throwing an exception that becomes a generic tool error.
  const depth = subagentDepth(stateNow, taskId);
  if (depth >= MAX_SUBAGENT_DEPTH) {
    appendTrace(config.instance, taskId, {
      type: "error",
      message: "spawn_subagent rejected: depth cap reached",
      data: { depth, cap: MAX_SUBAGENT_DEPTH, name }
    });
    return `Error: max_subagent_depth_exceeded (current depth ${depth}, cap ${MAX_SUBAGENT_DEPTH}). Refusing to spawn '${name}'.`;
  }

  // Audit + trace the delegation call before launching the child. Medium
  // risk because it doesn't directly mutate the world, but it commits
  // model time / spend on a tangent.
  await mutateState(config.instance, (state: RuntimeState) => {
    const item = findTask(state, taskId);
    addAudit(
      state,
      {
        actor: "agent",
        action: "subagent.spawn",
        target: name,
        risk: "medium",
        taskId: item.id,
        runId: item.runId,
        evidence: { name, promptBytes: prompt.length, toolsets, skills, depth }
      },
      { taskId: item.id }
    );
    item.updatedAt = now();
  });
  appendTrace(config.instance, taskId, {
    type: "tool",
    message: `Spawning subagent '${name}'`,
    data: { name, toolsets, skills, depth }
  });

  let subagentId: string | undefined;
  try {
    const created = await spawnSubagent(config, {
      name,
      prompt,
      goal,
      context,
      systemPrompt,
      toolsets,
      skills,
      parentTaskId: taskId
    });
    subagentId = created.id;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // `spawnSubagent` refuses inside its own `mutateState` when
    // the parent task is terminal. Convert that into a clean
    // "skipped" tool result rather than the generic
    // "spawn_subagent failed" tool error so the model sees a
    // coherent no-op.
    if (message.startsWith("Cannot spawn subagent: parent task ")) {
      appendTrace(config.instance, taskId, {
        type: "task",
        message: `spawn_subagent skipped: parent task is terminal`,
        data: { message }
      });
      return `Error: spawn_subagent skipped because parent task became terminal between pre-check and spawn.`;
    }
    appendTrace(config.instance, taskId, {
      type: "error",
      message: `spawn_subagent failed: ${message}`,
      data: { name }
    });
    return `Error: ${message}`;
  }

  // Reflect the parent's currentStep so the UI shows what we're waiting on.
  await mutateState(config.instance, (state: RuntimeState) => {
    const item = findTask(state, taskId);
    item.currentStep = `Waiting on subagent ${name}`;
    item.updatedAt = now();
  });

  const final = await waitForSubagentTerminal(config, subagentId, timeoutMs, taskId);

  appendTrace(config.instance, taskId, {
    type: "tool",
    message: `Subagent '${name}' finished`,
    data: { subagentId, status: final.status, hasSummary: Boolean(final.summary), hasError: Boolean(final.error) }
  });

  // Format the result. We return a compact JSON-shaped string so the model
  // can parse if it wants, but the strings inside are human-readable. When the
  // subagent bubbled up an "additional input needed" question, surface it as
  // status:"needs_input" with the question so the parent (which has a topic/chat
  // session) re-asks via its own ask_user. See ADR chat-topics-tasks-subagents.md.
  const payload = {
    subagentId,
    status: final.status,
    summary: final.summary ?? null,
    error: final.error ?? null,
    ...(final.needsInput ? { needsInput: final.needsInput } : {})
  };
  return JSON.stringify(payload);
}

// Child-task delegation (unified task model). Where spawn_subagent runs an
// invisible in-run helper that reports back only to the spawning run,
// spawn_task mints a durable CHILD TASK CONTAINER — its own thread, child of
// the spawning run's container — and runs the written brief as the child's
// first run. The subagent machinery is reused purely as the mechanical
// carrier of the brief/constraints: the child's run 1 starts from
// title/prompt/goal/context, never the parent transcript, so the child
// thread is self-contained. Idempotent via `correlation_key` (scoped to the
// parent container; the dedup lookup deliberately ignores acknowledge/
// archive so a re-firing spawner never re-mints a dismissed finding), and
// depth-capped on BOTH walks: the task chain (subagentDepth, same cap as
// spawn_subagent) and the container chain (containerChainDepth — each
// child's follow-up runs start with a fresh task chain, so the task walk
// alone couldn't cap container nesting). `surface: true` stamps the child
// container user-facing (the home inclusion bit — watch drafts set it;
// internal errands default false).
async function spawnTaskTool(
  config: RuntimeConfig,
  taskId: string,
  args: Record<string, unknown>
): Promise<string> {
  const title = requireString(args, "title");
  const prompt = requireString(args, "prompt");
  const goal = typeof args.goal === "string" ? args.goal : undefined;
  const context = typeof args.context === "string" ? args.context : undefined;
  const toolsets = Array.isArray(args.toolsets) ? args.toolsets.map(String) : undefined;
  const skills = Array.isArray(args.skills) ? args.skills.map(String) : undefined;
  const correlationKey =
    typeof args.correlation_key === "string" && args.correlation_key.trim().length > 0
      ? args.correlation_key.trim()
      : undefined;
  const surface = args.surface === true;
  if (args.await !== undefined && args.await !== "result" && args.await !== "none") {
    return `Error: invalid await value ${JSON.stringify(args.await)} — use "result" or "none".`;
  }
  const awaitMode: "result" | "none" = args.await === "none" ? "none" : "result";
  const timeoutMs = 5 * 60 * 1000;

  // Pre-side-effect terminal check, mirroring spawnSubagentTool: the
  // serialized re-check inside spawnSubagent's mutateState is the
  // authoritative guard; this is the cheap early-exit.
  const stateNow = readState(config.instance);
  const spawningTask = stateNow.tasks.find((t) => t.id === taskId);
  if (spawningTask && isTerminalTaskStatus(spawningTask.status)) {
    return `Error: spawn_task skipped because the spawning task is already ${spawningTask.status}.`;
  }

  // The child container hangs off the spawning run's container. A run with
  // no container (imperative CLI task, parent-delegated subagent helper) has
  // no parent thread for the child to mirror into.
  const parentContainerId = spawningTask?.chatSessionId;
  if (!parentContainerId || !stateNow.chatSessions.some((s) => s.id === parentContainerId)) {
    return "Error: spawn_task requires the spawning run to be bound to a container. Use spawn_subagent for in-run delegation from a container-less run.";
  }

  // Depth caps, pre-flight so the model gets a clean error instead of a
  // generic tool exception. Task-chain walk first (same as spawn_subagent) …
  const helperDepth = subagentDepth(stateNow, taskId);
  if (helperDepth >= MAX_SUBAGENT_DEPTH) {
    appendTrace(config.instance, taskId, {
      type: "error",
      message: "spawn_task rejected: subagent depth cap reached",
      data: { depth: helperDepth, cap: MAX_SUBAGENT_DEPTH, title }
    });
    return `Error: max_subagent_depth_exceeded (current depth ${helperDepth}, cap ${MAX_SUBAGENT_DEPTH}). Refusing to spawn '${title}'.`;
  }
  // … then the container-chain walk, so nesting through fresh containers
  // (whose runs are depth-clean on the task walk) is capped too.
  const chainDepth = containerChainDepth(stateNow, parentContainerId);
  if (chainDepth >= MAX_SUBAGENT_DEPTH) {
    appendTrace(config.instance, taskId, {
      type: "error",
      message: "spawn_task rejected: container depth cap reached",
      data: { depth: chainDepth, cap: MAX_SUBAGENT_DEPTH, title }
    });
    return `Error: max_task_depth_exceeded (container chain already at depth ${chainDepth}, cap ${MAX_SUBAGENT_DEPTH}). Refusing to spawn '${title}'.`;
  }

  // ONE mutateState owns the create-or-dedup decision so two concurrent
  // spawns with the same correlation_key can't both mint. The audit rides
  // in the same mutation.
  const decision = await mutateState(config.instance, (state: RuntimeState) => {
    const item = findTask(state, taskId);
    if (correlationKey) {
      const existing = findChildContainerByCorrelationKey(state, parentContainerId, correlationKey);
      if (existing) {
        // Latest run in the existing child, for the dedup result payload.
        const latest = [...existing.taskIds]
          .reverse()
          .map((id) => state.tasks.find((t) => t.id === id))
          .find((t) => t !== undefined);
        addAudit(
          state,
          {
            actor: "agent",
            action: "task.spawn.deduped",
            target: existing.id,
            risk: "low",
            taskId: item.id,
            runId: item.runId,
            evidence: { correlationKey, containerId: existing.id, title }
          },
          { taskId: item.id }
        );
        item.updatedAt = now();
        return {
          deduped: true as const,
          containerId: existing.id,
          latestRunStatus: latest?.status,
          summary: latest?.summary
        };
      }
    }
    const parentSession = state.chatSessions.find((s) => s.id === parentContainerId);
    const child = createTaskContainer(state, {
      agentId: item.agentId ?? parentSession?.agentId,
      title,
      parentChatSessionId: parentContainerId,
      spawnedByTaskId: item.id,
      ...(correlationKey ? { correlationKey } : {}),
      ...(surface ? { surfaced: true } : {})
    });
    addAudit(
      state,
      {
        actor: "agent",
        action: "task.spawn",
        target: child.id,
        risk: "medium",
        taskId: item.id,
        runId: item.runId,
        evidence: { title, promptBytes: prompt.length, correlationKey, surface, awaitMode, toolsets, skills, depth: chainDepth }
      },
      { taskId: item.id }
    );
    item.updatedAt = now();
    return { deduped: false as const, containerId: child.id };
  });

  if (decision.deduped) {
    appendTrace(config.instance, taskId, {
      type: "tool",
      message: `spawn_task deduped to existing child container`,
      data: { correlationKey, containerId: decision.containerId, latestRunStatus: decision.latestRunStatus }
    });
    return JSON.stringify({
      deduped: true,
      containerId: decision.containerId,
      latestRunStatus: decision.latestRunStatus ?? null,
      ...(decision.summary ? { summary: decision.summary } : {})
    });
  }
  const containerId = decision.containerId;

  appendTrace(config.instance, taskId, {
    type: "tool",
    message: `Spawning child task '${title}'`,
    data: { containerId, correlationKey, surface, awaitMode, toolsets, skills }
  });

  // Execution composes with the subagent machinery (the fan-out-worker
  // precedent in jobs/index.ts): the child task is submitted INTO the child
  // container, so its blocks/transcript land there and mirror one level up
  // into the parent thread via resolveEmitContext.
  let subagentId: string;
  let childTaskId: string;
  try {
    const created = await spawnSubagent(config, {
      name: title,
      prompt,
      goal,
      context,
      toolsets,
      skills,
      parentTaskId: taskId,
      chatSessionId: containerId
    });
    subagentId = created.id;
    childTaskId = created.taskId;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Remove the just-minted container so a failed spawn doesn't leave an
    // empty child behind — with a correlation_key that orphan would win
    // every future dedup lookup and permanently mask the retry.
    // Known dedup window: a concurrent same-key spawn can dedup onto this
    // containerId between the mint above and this delete, leaving that
    // caller holding an id that no longer resolves. The next spawn with the
    // key re-mints cleanly.
    await mutateState(config.instance, (state: RuntimeState) => {
      if (state.chatSessions.some((s) => s.id === containerId)) deleteChatSession(state, containerId);
    });
    if (message.startsWith("Cannot spawn subagent: parent task ")) {
      appendTrace(config.instance, taskId, {
        type: "task",
        message: `spawn_task skipped: spawning task is terminal`,
        data: { message }
      });
      return `Error: spawn_task skipped because the spawning task became terminal between pre-check and spawn.`;
    }
    appendTrace(config.instance, taskId, {
      type: "error",
      message: `spawn_task failed: ${message}`,
      data: { title }
    });
    return `Error: ${message}`;
  }

  // Land the brief in the child thread (durable user row + render block) so
  // the thread is self-contained: the thread IS the context its runs used.
  // Tagged with the child task id so the child's own run 1 doesn't replay it
  // (it already carries the prompt as task input) while follow-up runs in
  // the container do.
  await mutateState(config.instance, (state: RuntimeState) => {
    if (!state.chatSessions.some((s) => s.id === containerId)) return;
    createChatMessage(state, { sessionId: containerId, role: "user", content: prompt, taskId: childTaskId });
  });
  try {
    insertChatBlock(config.instance, {
      kind: "user_text",
      sessionId: containerId,
      text: prompt,
      taskId: childTaskId
    });
  } catch (error) {
    appendTrace(config.instance, taskId, {
      type: "task",
      message: "spawn_task brief block insert failed",
      data: { containerId, error: error instanceof Error ? error.message : String(error) }
    });
  }

  if (awaitMode === "none") {
    // Watch mode: the child keeps running in its own container; the spawning
    // run moves on with the ids.
    return JSON.stringify({ containerId, taskId: childTaskId, status: "running" });
  }

  // Reflect the parent's currentStep so the UI shows what we're waiting on.
  await mutateState(config.instance, (state: RuntimeState) => {
    const item = findTask(state, taskId);
    item.currentStep = `Waiting on child task ${title}`;
    item.updatedAt = now();
  });

  const final = await waitForSpawnedChildResult(config, subagentId, childTaskId, timeoutMs, taskId);

  appendTrace(config.instance, taskId, {
    type: "tool",
    message: `Child task '${title}' settled`,
    data: { containerId, childTaskId, status: final.status, hasSummary: Boolean(final.summary), hasError: Boolean(final.error) }
  });

  return JSON.stringify({
    containerId,
    taskId: childTaskId,
    status: final.status,
    summary: final.summary ?? null,
    error: final.error ?? null,
    ...(final.needsInput ? { needsInput: final.needsInput } : {})
  });
}

// Validate a create_job / update_job `deliveryTargets` payload against
// the dispatchable messaging bridges — the isBridgeSurfaceKind set
// (telegram / discord / slack), the only kinds the job finalizer
// (src/jobs/finalize.ts) can send to. A demo
// (or other non-dispatchable) bridge would validate and then fail on
// every fire, so it is rejected here. Entries resolve by bridge id,
// then case-insensitive name, then kind; an entry whose winning tier
// matches more than one bridge is rejected as ambiguous (bridge names
// and kinds are not unique, and bridge ordering shifts as records are
// added — first-match would silently re-route). The resolved entry is
// persisted as the bridge id, which is stable across renames and
// reordering (the same way ChatSessionRecord.outboundMirror pins
// bridgeId). Unknown entries are rejected with the dispatchable bridge
// names so the agent can relay a fixable error to the user.
// Returns undefined when the field was omitted; an empty array is the
// documented "clear" signal for update_job and passes through.
function parseDeliveryTargets(config: RuntimeConfig, raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error("Invalid input: deliveryTargets must be an array of strings.");
  }
  const dispatchable = readState(config.instance).messagingBridges.filter(
    (bridge) => isBridgeSurfaceKind(bridge.kind)
  );
  const resolved: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new Error("Invalid input: deliveryTargets entries must be non-empty strings.");
    }
    const value = entry.trim();
    const lower = value.toLowerCase();
    let matches = dispatchable.filter((bridge) => bridge.id === value);
    if (matches.length === 0) matches = dispatchable.filter((bridge) => bridge.name.toLowerCase() === lower);
    if (matches.length === 0) matches = dispatchable.filter((bridge) => bridge.kind.toLowerCase() === lower);
    if (matches.length === 0) {
      const names = dispatchable.map((bridge) => bridge.name).join(", ");
      throw new Error(
        `Invalid input: no dispatchable messaging bridge matches '${value}'. Dispatchable bridges: ${names.length > 0 ? names : "<none>"}.`
      );
    }
    if (matches.length > 1) {
      const candidates = matches.map((bridge) => `${bridge.name} (${bridge.id})`).join(", ");
      throw new Error(
        `Invalid input: deliveryTargets entry '${value}' is ambiguous — matches ${candidates}. Use the bridge name or id.`
      );
    }
    const bridge = matches[0]!;
    // A slack bridge with no configured channel is DM-only: inbound DM
    // channels are discovered at event time and never persisted, so
    // generic job dispatch would fall back to the literal "local"
    // target and fail with channel_not_found on every fire. Reject at
    // save time with the fix in hand. A slack bridge WITH a configured
    // channel id passes — the text-only send works there.
    if (bridge.kind === "slack" && bridge.deliveryTargets.length === 0) {
      throw new Error(
        `Invalid input: Slack bridge '${bridge.name}' has no delivery channel configured, so scheduled-job output has nowhere to post. Add a channel id to that bridge's deliveryTargets, or pick a different bridge.`
      );
    }
    resolved.push(bridge.id);
  }
  return resolved;
}

// Schedule a real job (cron-style) and link it to the originating chat
// session so the job's output is delivered back as an assistant message
// when it fires. Low-risk: no approval gate, since reminders should not
// pop a modal — the user can pause/delete the job at any time via /jobs.
// We discover the originating session by walking task → run → conversation.
// Returns the model-facing confirmation string plus, when a job was actually
// created, its id as a structured field (see DispatchResult.jobId). The
// race-skip early returns below carry no jobId — nothing was created.
async function createJobTool(
  config: RuntimeConfig,
  taskId: string,
  args: Record<string, unknown>
): Promise<{ result: string; jobId?: string }> {
  const name = requireString(args, "name");
  const prompt = requireString(args, "prompt");
  // Exactly one of (intervalSeconds, cronExpression) must drive the
  // schedule. The authoritative validation lives in `createScheduledJob`,
  // but doing a fast-path check here gives the agent a typed tool-result
  // error before we touch the per-instance lock.
  const intervalProvided = args.intervalSeconds !== undefined && args.intervalSeconds !== null;
  const cronProvided = args.cronExpression !== undefined && args.cronExpression !== null;
  if (intervalProvided && cronProvided) {
    throw new Error("Invalid input: cronExpression and intervalSeconds are mutually exclusive.");
  }
  if (!intervalProvided && !cronProvided) {
    throw new Error("Invalid input: create_job requires either intervalSeconds or cronExpression.");
  }
  let intervalSeconds: number | undefined;
  if (intervalProvided) {
    if (typeof args.intervalSeconds !== "number" || !Number.isFinite(args.intervalSeconds) || args.intervalSeconds <= 0 || !Number.isInteger(args.intervalSeconds)) {
      throw new Error("Invalid input: intervalSeconds must be a positive integer.");
    }
    intervalSeconds = args.intervalSeconds;
  }
  let cronExpression: string | undefined;
  if (cronProvided) {
    if (typeof args.cronExpression !== "string" || args.cronExpression.trim().length === 0) {
      throw new Error("Invalid input: cronExpression must be a non-empty string.");
    }
    cronExpression = args.cronExpression;
  }
  let cronTimezone: string | undefined;
  if (args.cronTimezone !== undefined && args.cronTimezone !== null) {
    if (typeof args.cronTimezone !== "string" || args.cronTimezone.length === 0) {
      throw new Error("Invalid input: cronTimezone must be a non-empty string.");
    }
    cronTimezone = args.cronTimezone;
  }
  // `cronTimezone` without `cronExpression` is a payload mistake (it has
  // nothing to apply to). Reject up-front so the agent sees the error
  // before the lock-serialized re-check in `createScheduledJob` does.
  if (cronTimezone !== undefined && cronExpression === undefined) {
    throw new Error("Invalid input: cronTimezone may only be set when cronExpression is set.");
  }
  // Coerce oneShot to a strict boolean. Treat `undefined`/`null` as false
  // (recurring), and anything else (string "true", number 1) is rejected
  // so the agent has a clean contract.
  let oneShot = false;
  if (args.oneShot !== undefined && args.oneShot !== null) {
    if (typeof args.oneShot !== "boolean") {
      throw new Error("Invalid input: oneShot must be a boolean.");
    }
    oneShot = args.oneShot;
  }
  // Delivery policy fast-path check; the authoritative validation (enum +
  // the silent × oneShot rejection) lives in createScheduledJob.
  let deliveryPolicy: "always" | "on_findings" | "silent" | undefined;
  if (args.deliveryPolicy !== undefined && args.deliveryPolicy !== null) {
    if (args.deliveryPolicy !== "always" && args.deliveryPolicy !== "on_findings" && args.deliveryPolicy !== "silent") {
      throw new Error("Invalid input: deliveryPolicy must be one of \"always\" | \"on_findings\" | \"silent\".");
    }
    deliveryPolicy = args.deliveryPolicy;
  }
  // Per-job auto-approve envelope. Same validation shape as
  // `createScheduledJob` so the agent gets a typed rejection (which the
  // chat-task loop relays back as a tool-result error) instead of
  // silently coercing a bogus payload. The authoritative re-check lives
  // in createScheduledJob; this is a fast-path so we can fail before
  // touching the per-instance lock.
  let dangerouslyAutoApprove: boolean | undefined;
  if (args.dangerouslyAutoApprove !== undefined && args.dangerouslyAutoApprove !== null) {
    if (typeof args.dangerouslyAutoApprove !== "boolean") {
      throw new Error("Invalid input: dangerouslyAutoApprove must be a boolean.");
    }
    dangerouslyAutoApprove = args.dangerouslyAutoApprove;
  }
  let approvalMode: "strict" | "auto" | "yolo" | undefined;
  if (args.approvalMode !== undefined && args.approvalMode !== null) {
    if (args.approvalMode !== "strict" && args.approvalMode !== "auto" && args.approvalMode !== "yolo") {
      throw new Error("Invalid input: approvalMode must be one of \"strict\" | \"auto\" | \"yolo\".");
    }
    approvalMode = args.approvalMode;
  }
  let autoApproveCommands: string[] | undefined;
  if (args.autoApproveCommands !== undefined && args.autoApproveCommands !== null) {
    if (!Array.isArray(args.autoApproveCommands)) {
      throw new Error("Invalid input: autoApproveCommands must be an array of strings.");
    }
    const cleaned: string[] = [];
    for (const entry of args.autoApproveCommands) {
      if (typeof entry !== "string") {
        throw new Error("Invalid input: autoApproveCommands entries must be strings.");
      }
      if (entry.length === 0) {
        throw new Error("Invalid input: autoApproveCommands entries must be non-empty strings.");
      }
      cleaned.push(entry);
    }
    autoApproveCommands = cleaned;
  }
  let dangerousTerminalPatterns: string[] | undefined;
  if (args.dangerousTerminalPatterns !== undefined && args.dangerousTerminalPatterns !== null) {
    if (!Array.isArray(args.dangerousTerminalPatterns)) {
      throw new Error("Invalid input: dangerousTerminalPatterns must be an array of strings.");
    }
    const cleaned: string[] = [];
    for (const entry of args.dangerousTerminalPatterns) {
      if (typeof entry !== "string") {
        throw new Error("Invalid input: dangerousTerminalPatterns entries must be strings.");
      }
      if (entry.length === 0) {
        throw new Error("Invalid input: dangerousTerminalPatterns entries must be non-empty strings.");
      }
      cleaned.push(entry);
    }
    dangerousTerminalPatterns = cleaned;
  }
  let timeoutSeconds: number | undefined;
  if (args.timeoutSeconds !== undefined && args.timeoutSeconds !== null) {
    if (typeof args.timeoutSeconds !== "number" || !Number.isFinite(args.timeoutSeconds) || args.timeoutSeconds <= 0 || !Number.isInteger(args.timeoutSeconds)) {
      throw new Error("Invalid input: timeoutSeconds must be a positive integer.");
    }
    timeoutSeconds = args.timeoutSeconds;
  }
  const deliveryTargets = parseDeliveryTargets(config, args.deliveryTargets);
  // `preRunHook` passes through UNVALIDATED on purpose: the authoritative
  // shape + known-handler (isKnownHook) validation lives in
  // `createScheduledJob` — the same seam the HTTP /api/jobs route uses — and
  // its typed `Invalid input: …` relays back as the tool-result error.
  // Duplicating the registry check here would just drift from that one
  // source of truth.
  const preRunHook = args.preRunHook;

  // Walk task -> run -> conversation to determine whether the agent is
  // invoking us from inside a chat task. If so, the job binds to that same
  // conversation (a Topic or the main agent chat) and delivers each fire
  // into it. Otherwise (CLI / imperative task), the job runs without any
  // chat delivery target — same as before.
  const state = readState(config.instance);
  const task = state.tasks.find((item) => item.id === taskId);
  // Pre-side-effect terminal check. `create_job` persists a
  // durable scheduled job; refuse when the parent task is already
  // terminal so cancel + auto-approve doesn't leak a recurring job
  // past the cancellation. The serialized re-check inside
  // `createScheduledJob`'s `mutateState` is the authoritative
  // guard; this early-exit just avoids touching the lock.
  if (task && isTerminalTaskStatus(task.status)) {
    return { result: `Error: create_job skipped because task is already ${task.status}.` };
  }
  // The agent's caller is "chat-bound" when its task is attached to a run
  // whose conversation still exists. That originating conversation is the
  // session the job binds to and delivers each fire into.
  let originatingSessionId: string | undefined;
  if (task?.runId) {
    const run = state.runs.find((item) => item.id === task.runId);
    if (run?.conversationId) {
      const session = state.chatSessions.find((item) => item.id === run.conversationId);
      if (session) originatingSessionId = session.id;
    }
  }
  const invokedFromChat = originatingSessionId !== undefined;

  // Pass `parentTaskId` so `createScheduledJob`'s own `mutateState`
  // callback can re-check terminal status atomically. The earlier
  // lock-free `readState` pre-check is kept as a fast path / error-
  // message-quality improvement; this is the authoritative
  // serialization point. `createScheduledJob` throws if the parent
  // task is already terminal. When `invokedFromChat`, the job binds to the
  // originating conversation; `requireChatSession` makes createScheduledJob
  // re-verify that session still exists inside the same mutateState write.
  let job;
  try {
    job = await createScheduledJob(config, {
      name,
      // intervalSeconds is undefined when cron drives the schedule —
      // createScheduledJob's mutual-exclusion guard treats that as the
      // "not interval-driven" case and stores 0 as the sentinel.
      intervalSeconds,
      cronExpression,
      cronTimezone,
      prompt,
      // Bind chat-driven jobs to their originating conversation (the Topic or
      // main agent chat the create_job tool ran in), so each fire delivers into
      // that same thread. When the originating session is a Topic, the
      // Topic→Chat activity mirror (resolveEmitContext) surfaces the fire's
      // full turn in the parent Chat for free, so `forwardToChat` stays unset
      // to avoid double-posting the final answer.
      chatSessionId: invokedFromChat ? originatingSessionId : undefined,
      oneShot,
      deliveryPolicy,
      // Skill attachments pass through verbatim — createScheduledJob is the
      // single validation choke point (shape + enabled-skill resolution),
      // and its typed `Invalid input: …` surfaces back as a tool error.
      skillNames: args.skillNames,
      parentTaskId: taskId,
      dangerouslyAutoApprove,
      approvalMode,
      autoApproveCommands,
      dangerousTerminalPatterns,
      timeoutSeconds,
      deliveryTargets,
      preRunHook
    }, {
      // Inherit the originating task's owning agent so a scheduler tick
      // doesn't reattribute the job to whichever agent happens to be
      // active at fire time. Threaded through the trusted options bag
      // so a malicious HTTP client can't spoof it via the request body.
      originatingAgentId: task?.agentId,
      // Re-verify the originating session still exists inside the same
      // mutateState write: its id came from a lock-free readState above, so a
      // racing deletion could otherwise persist a job bound to a dead session.
      requireChatSession: invokedFromChat
    });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Cannot create scheduled job: parent task ")) {
      return { result: `Error: create_job skipped because parent task was cancelled between pre-check and job creation.` };
    }
    if (err instanceof Error && err.message.startsWith("Cannot create scheduled job: chat session ")) {
      return { result: `Error: create_job skipped because the originating chat session was deleted between pre-check and job creation.` };
    }
    throw err;
  }
  // The job's chatSessionId is the originating conversation when
  // invokedFromChat, or undefined for imperative/CLI invocations.
  const chatSessionId = job.chatSessionId;

  await mutateState(config.instance, (current) => {
    const item = findTask(current, taskId);
    addAudit(
      current,
      {
        actor: "agent",
        action: "job.created",
        target: job.id,
        risk: "low",
        taskId: item.id,
        runId: item.runId,
        evidence: {
          name,
          intervalSeconds,
          cronExpression,
          cronTimezone,
          oneShot,
          deliveryPolicy: job.deliveryPolicy,
          skillNames: job.skillNames,
          chatSessionId,
          jobId: job.id,
          dangerouslyAutoApprove,
          approvalMode,
          autoApproveCommands,
          dangerousTerminalPatterns,
          timeoutSeconds,
          deliveryTargets,
          // Handler id only — the hook's declarative config can carry bulky
          // per-script data the audit row doesn't need.
          preRunHookHandlerId: job.preRunHook?.handlerId
        }
      },
      { taskId: item.id }
    );
    item.updatedAt = now();
  });
  appendTrace(config.instance, taskId, {
    type: "job",
    message: "Created scheduled job",
    data: {
      jobId: job.id,
      name,
      intervalSeconds,
      cronExpression,
      cronTimezone,
      oneShot,
      deliveryPolicy: job.deliveryPolicy,
      skillNames: job.skillNames,
      chatSessionId,
      preRunHookHandlerId: job.preRunHook?.handlerId,
      dangerouslyAutoApprove,
      approvalMode,
      autoApproveCommands,
      dangerousTerminalPatterns,
      timeoutSeconds,
      deliveryTargets
    }
  });

  // Cadence string surfaces the right vocabulary back to the agent so its
  // follow-up reply to the user describes the actual schedule shape.
  const cadence = oneShot
    ? "one-shot"
    : cronExpression
      ? `cron \"${cronExpression}\" (${cronTimezone ?? "UTC"})`
      : `every ${intervalSeconds}s`;
  // When the job is bound to a chat conversation, surface its id in the
  // tool-call result so the model's follow-up reply can mention both the
  // job id and the conversation each fire delivers into. Imperative/CLI
  // invocations skip this suffix — there's no chat to point at.
  const sessionSuffix = chatSessionId ? ` into ${chatSessionId}` : "";
  return {
    result: `Created job ${job.id} (\"${name}\"): ${cadence}, fires at ${job.nextRunAt}${sessionSuffix}.`,
    jobId: job.id
  };
}

// Read-only listing of scheduled jobs. Cheap, low-risk: just walks
// `state.jobs` and returns a compact summary the agent can reason about
// without spending tokens on internal-only fields. The agent uses this to
// resolve "this job" / "my reminder" to a real job id before calling
// update_job or delete_job.
async function listJobsTool(
  config: RuntimeConfig,
  taskId: string,
  args: Record<string, unknown>
): Promise<string> {
  let nameContains: string | undefined;
  if (args.nameContains !== undefined && args.nameContains !== null) {
    if (typeof args.nameContains !== "string") {
      throw new Error("Invalid input: nameContains must be a string.");
    }
    nameContains = args.nameContains.toLowerCase();
  }
  let fullPrompt = false;
  if (args.fullPrompt !== undefined && args.fullPrompt !== null) {
    if (typeof args.fullPrompt !== "boolean") {
      throw new Error("Invalid input: fullPrompt must be a boolean.");
    }
    fullPrompt = args.fullPrompt;
  }
  const all = listJobs(config);
  const filtered = nameContains
    ? all.filter((job) => job.name.toLowerCase().includes(nameContains!))
    : all;
  // Compact summary: only the fields an agent needs to identify and
  // describe a job. Prompts default to a 200-char truncation so a
  // long-prompt job doesn't blow up the tool-result context. When the
  // caller passes `fullPrompt: true` we return verbatim prompts — the
  // agent needs this when it intends to edit a prompt (append /
  // search-and-replace), since update_job's prompt field is REPLACE-only.
  // Schedule fields are reported as-is (cronExpression+cronTimezone for
  // cron jobs, intervalSeconds for interval-driven jobs) so the agent
  // can echo the user's vocabulary.
  const summary = filtered.map((job) => ({
    id: job.id,
    name: job.name,
    status: job.status,
    cronExpression: job.cronExpression,
    cronTimezone: job.cronTimezone,
    intervalSeconds: job.intervalSeconds,
    oneShot: job.oneShot === true,
    nextRunAt: job.nextRunAt,
    lastRunAt: job.lastRunAt,
    chatSessionId: job.chatSessionId,
    // Surfaced so update_job's REPLACE-only skillNames patch can preserve
    // attachments the user isn't changing.
    skillNames: job.skillNames,
    prompt: fullPrompt
      ? job.prompt
      : job.prompt.length > 200
        ? `${job.prompt.slice(0, 200)}…`
        : job.prompt
  }));
  appendTrace(config.instance, taskId, {
    type: "tool",
    message: "Listed jobs",
    data: { total: all.length, returned: summary.length, nameContains, fullPrompt }
  });
  await recordLowRiskAudit(config, taskId, "job.listed", "jobs", {
    total: all.length,
    returned: summary.length,
    nameContains,
    fullPrompt
  });
  return JSON.stringify({ count: summary.length, jobs: summary });
}

// Patch an existing job in place. Preferred over delete+create for
// schedule/prompt/status changes — preserves job id, dedicated chat
// thread, and run history. Validation lives in `updateJob` (typed
// `Invalid input: …` errors surface back as tool-result errors).
// Returns the model-facing confirmation string plus, when the patch was
// actually applied, the job's id as a structured field (see
// DispatchResult.jobId — the routine card renders for update turns too).
// The error-string early returns carry no jobId — nothing was changed.
async function updateJobTool(
  config: RuntimeConfig,
  taskId: string,
  args: Record<string, unknown>
): Promise<{ result: string; jobId?: string }> {
  const jobId = requireString(args, "jobId");

  // Pre-side-effect terminal check. Mirrors the guard pattern in
  // `create_job`: refuse when the parent task is already terminal so a
  // late cancel doesn't leak a mutation past the cancellation. The
  // serialized re-check inside `updateJob` / `updateJobStatus` (via
  // `parentTaskId`) is the authoritative guard; this early-exit avoids
  // touching the lock for the common case.
  {
    const state = readState(config.instance);
    const task = state.tasks.find((item) => item.id === taskId);
    if (task && isTerminalTaskStatus(task.status)) {
      return { result: `Error: update_job skipped because task is already ${task.status}.` };
    }
  }

  // Collect status separately — `updateJob` handles every other field but
  // status lives in `updateJobStatus` (different audit action vocabulary).
  let statusPatch: "active" | "paused" | undefined;
  if (args.status !== undefined && args.status !== null) {
    if (args.status !== "active" && args.status !== "paused") {
      throw new Error("Invalid input: status must be 'active' or 'paused'.");
    }
    statusPatch = args.status;
  }

  // Build the patch payload for `updateJob` — pass only the keys the
  // caller explicitly supplied so we don't accidentally clear fields with
  // undefined. `null` is meaningful (it's the "clear this field" signal
  // for cronExpression / cronTimezone / intervalSeconds) so we preserve
  // it.
  const patch: Record<string, unknown> = {};
  const passthrough = [
    "name",
    "prompt",
    "intervalSeconds",
    "cronExpression",
    "cronTimezone",
    "timeoutSeconds",
    "autoApproveCommands",
    "dangerouslyAutoApprove",
    "deliveryPolicy",
    "skillNames"
  ] as const;
  for (const key of passthrough) {
    if (key in args) patch[key] = args[key];
  }
  // `deliveryTargets` is validated against dispatchable bridges and
  // normalized to bridge ids instead of passed through raw — an unknown
  // or ambiguous entry must fail here with the dispatchable bridge
  // names so the agent can relay a fixable error.
  // `[]` is the documented "clear" signal and passes through.
  const deliveryTargetsPatch = parseDeliveryTargets(config, args.deliveryTargets);
  if (deliveryTargetsPatch !== undefined) patch.deliveryTargets = deliveryTargetsPatch;
  // oneShot lives on the JobRecord but isn't part of `updateJob`'s HTTP
  // patch contract — it is forwarded as a separate parameter so the
  // assignment and the silent × one-shot guards run inside `updateJob`'s
  // single mutateState, atomically with every sibling field. Validate
  // up-front so we fail before any persistence happens.
  let oneShotPatch: boolean | undefined;
  if (args.oneShot !== undefined && args.oneShot !== null) {
    if (typeof args.oneShot !== "boolean") {
      throw new Error("Invalid input: oneShot must be a boolean.");
    }
    oneShotPatch = args.oneShot;
  }
  // Same-call silent × one-shot pre-flight: reject the combination before
  // ANY persistence so a refused call can't leave the job half-patched
  // (policy committed, oneShot refused, channel hidden). The serialized
  // guards inside `updateJob` remain authoritative under concurrent flips.
  if (oneShotPatch === true && patch.deliveryPolicy === "silent") {
    throw new Error(`Invalid input: deliveryPolicy "silent" is not allowed on one-shot reminder jobs`);
  }
  // Delivery rebind. Same enum as create_job's deliverTo; applied via
  // `rebindJobDelivery` (one mutateState write) after the field patch so a
  // same-call name change titles the freshly minted channel.
  let deliverTo: "channel" | "chat" | undefined;
  if (args.deliverTo !== undefined && args.deliverTo !== null) {
    if (args.deliverTo !== "channel" && args.deliverTo !== "chat") {
      throw new Error("Invalid input: deliverTo must be one of \"channel\" | \"chat\".");
    }
    deliverTo = args.deliverTo;
  }

  const hasFieldPatch =
    Object.keys(patch).length > 0 || oneShotPatch !== undefined;
  if (!hasFieldPatch && statusPatch === undefined && deliverTo === undefined) {
    throw new Error("Invalid input: update_job requires at least one field to change.");
  }

  // Capture the previous schedule shape for the audit evidence BEFORE we
  // mutate. The audit row pins the prior fields so the change is
  // reconstructable from the log alone.
  const before = listJobs(config).find((candidate) => candidate.id === jobId);
  if (!before) throw new Error(`Job not found: ${jobId}`);
  // Delivery-rebind pre-checks, before ANY mutation so a rejected rebind
  // leaves the job untouched even when other patch fields were supplied.
  // The authoritative guards are re-run inside rebindJobDelivery's
  // mutateState; these lock-free checks give the agent a typed tool error
  // without touching the per-instance lock.
  let originatingSessionId: string | undefined;
  if (deliverTo !== undefined) {
    // Watcher / fan-out jobs (email-watch etc.) bind routing state to their
    // sessions — a rebind would orphan dedupe anchors and concern channels.
    if (before.preRunHook || (before.routes && Object.keys(before.routes).length > 0)) {
      return { result: `Error: update_job deliverTo is not supported for jobs with a preRunHook or fan-out routes — their sessions carry routing state.` };
    }
    if (deliverTo === "chat") {
      // Same task → run → conversation derivation as create_job: "chat"
      // means THIS conversation, so the call must originate from one.
      const state = readState(config.instance);
      const task = state.tasks.find((item) => item.id === taskId);
      if (task?.runId) {
        const run = state.runs.find((item) => item.id === task.runId);
        if (run?.conversationId && state.chatSessions.some((s) => s.id === run.conversationId)) {
          originatingSessionId = run.conversationId;
        }
      }
      if (originatingSessionId === undefined) {
        return { result: `Error: update_job deliverTo "chat" requires invocation from a chat conversation, and this task has no originating chat session.` };
      }
    }
  }
  const previousSchedule = {
    cronExpression: before.cronExpression,
    cronTimezone: before.cronTimezone,
    intervalSeconds: before.intervalSeconds,
    oneShot: before.oneShot === true,
    status: before.status
  };

  // Forward `taskId` as `parentTaskId` so each mutator's own
  // `mutateState` callback can re-check terminal status atomically. The
  // earlier lock-free `readState` pre-check is kept as a fast path /
  // error-message-quality improvement; this is the authoritative
  // serialization point.
  if (hasFieldPatch) {
    await updateJob(config, jobId, patch, taskId, oneShotPatch);
  }
  if (statusPatch !== undefined) {
    await updateJobStatus(config, jobId, statusPatch, taskId);
  }
  // Delivery rebind, applied last so a same-call `name` patch titles a
  // freshly minted channel. rebindJobDelivery toggles forwardToChat (keeping
  // the job's Topic) and writes its own job.delivery.rebound audit row; the
  // clause below feeds the result text so the model can describe the change.
  let deliveryClause: string | undefined;
  let deliverToApplied = false;
  if (deliverTo !== undefined) {
    let rebind: Awaited<ReturnType<typeof rebindJobDelivery>> | undefined;
    try {
      rebind = await rebindJobDelivery(config, jobId, deliverTo, { parentTaskId: taskId });
    } catch (err) {
      // The rebind can race a parent-task cancellation landing between the
      // lock-free pre-checks above and rebindJobDelivery's serialized
      // re-check. By this point the sibling patches (name/schedule/oneShot/
      // status) have already committed, so returning a bare `Error:` would
      // tell the model the whole call failed while most of it persisted: when
      // other fields were applied, fall through to the normal success return
      // with a skip clause and leave `deliverTo` out of appliedFields. Only a
      // deliverTo-only call (nothing applied) keeps the error surface.
      const parentTerminal =
        err instanceof Error && err.message.startsWith("Cannot rebind job delivery: parent task ");
      if (!parentTerminal) throw err;
      const otherFieldsApplied = hasFieldPatch || statusPatch !== undefined;
      if (!otherFieldsApplied) throw err;
      deliveryClause = "Delivery rebind skipped: the parent task went terminal mid-call.";
    }
    if (rebind) {
      deliverToApplied = true;
      if (rebind.outcome === "noop") {
        deliveryClause = deliverTo === "chat"
          ? "Delivery already forwards into this conversation — no change."
          : "Delivery already stays in the job's dedicated channel — no change.";
      } else if (deliverTo === "channel") {
        deliveryClause = `Delivery now stays in the job's dedicated channel ${rebind.job.chatSessionId} (no longer forwarded into this conversation).`;
      } else {
        deliveryClause = `Each fire now forwards its final answer into this conversation, tagged with the job's channel ${rebind.job.chatSessionId}.`;
      }
    }
  }

  const after = listJobs(config).find((candidate) => candidate.id === jobId);
  if (!after) throw new Error(`Job not found after update: ${jobId}`);

  // Compose evidence describing exactly which fields were touched. We
  // record only the patch keys the caller supplied (plus `status`,
  // `oneShot`, and `deliverTo` if it actually applied — a rebind skipped
  // by a mid-call race is excluded so appliedFields reflects persisted
  // state; the supplied value still appears in the `patch` evidence as
  // intent).
  const appliedFields = [
    ...Object.keys(patch),
    ...(oneShotPatch !== undefined ? ["oneShot"] : []),
    ...(statusPatch !== undefined ? ["status"] : []),
    ...(deliverToApplied ? ["deliverTo"] : [])
  ];
  await mutateState(config.instance, (state) => {
    const item = findTask(state, taskId);
    addAudit(
      state,
      {
        actor: "agent",
        action: "job.updated",
        target: jobId,
        risk: "low",
        taskId: item.id,
        runId: item.runId,
        evidence: {
          jobId,
          appliedFields,
          patch: { ...patch, ...(oneShotPatch !== undefined ? { oneShot: oneShotPatch } : {}), ...(statusPatch !== undefined ? { status: statusPatch } : {}), ...(deliverTo !== undefined ? { deliverTo } : {}) },
          previousSchedule
        }
      },
      { taskId: item.id }
    );
    item.updatedAt = now();
  });
  appendTrace(config.instance, taskId, {
    type: "job",
    message: "Updated scheduled job",
    data: { jobId, appliedFields }
  });

  const cadence = after.cronExpression
    ? `cron \"${after.cronExpression}\" (${after.cronTimezone ?? "UTC"})`
    : after.intervalSeconds
      ? `every ${after.intervalSeconds}s`
      : "no schedule";
  // Only an active job has a meaningful next-fire moment. A paused job's
  // `nextRunAt` may still be populated (the scheduler simply skips it
  // while paused), but stating "next fires at ..." would lie to the
  // caller. Likewise, guard against an unexpectedly absent nextRunAt on
  // active jobs so the message doesn't read "next fires at undefined".
  const firingClause =
    after.status === "paused"
      ? "will not fire until resumed"
      : after.nextRunAt
        ? `next fires at ${after.nextRunAt}`
        : "next-fire moment pending";
  return {
    result: `Updated job ${after.id} (\"${after.name}\"): ${appliedFields.join(", ")}. Now ${after.status}, ${cadence}, ${firingClause}.${deliveryClause ? ` ${deliveryClause}` : ""}`,
    jobId: after.id
  };
}

// Delete a job and cascade-remove its run history. Low-risk for symmetry
// with create_job: the user can always re-create. The audit row pins
// the prior schedule shape so the deleted job is reconstructable from
// the log alone.
async function deleteJobTool(
  config: RuntimeConfig,
  taskId: string,
  args: Record<string, unknown>
): Promise<string> {
  const jobId = requireString(args, "jobId");

  // Pre-side-effect terminal check. Mirrors the guard pattern in
  // `create_job`: refuse when the parent task is already terminal so a
  // late cancel doesn't leak a mutation past the cancellation. The
  // serialized re-check inside `removeJob` (via `parentTaskId`) is the
  // authoritative guard; this early-exit avoids touching the lock for
  // the common case.
  {
    const state = readState(config.instance);
    const task = state.tasks.find((item) => item.id === taskId);
    if (task && isTerminalTaskStatus(task.status)) {
      return `Error: delete_job skipped because task is already ${task.status}.`;
    }
  }

  const before = listJobs(config).find((candidate) => candidate.id === jobId);
  if (!before) throw new Error(`Job not found: ${jobId}`);
  const previousSchedule = {
    name: before.name,
    cronExpression: before.cronExpression,
    cronTimezone: before.cronTimezone,
    intervalSeconds: before.intervalSeconds,
    oneShot: before.oneShot === true,
    status: before.status,
    chatSessionId: before.chatSessionId
  };
  const removed = await removeJob(config, jobId, taskId);
  await mutateState(config.instance, (state) => {
    const item = findTask(state, taskId);
    addAudit(
      state,
      {
        actor: "agent",
        action: "job.deleted",
        target: jobId,
        risk: "low",
        taskId: item.id,
        runId: item.runId,
        evidence: {
          jobId,
          name: removed.name,
          previousSchedule
        }
      },
      { taskId: item.id }
    );
    item.updatedAt = now();
  });
  appendTrace(config.instance, taskId, {
    type: "job",
    message: "Deleted scheduled job",
    data: { jobId, name: removed.name }
  });
  return `Deleted job ${removed.id} (\"${removed.name}\").`;
}

// Manually fire an existing scheduled job. Wraps the same `runJobNow`
// entrypoint that `POST /api/jobs/<id>/run` calls, with `trigger="manual"`
// so overlap protection is intentionally skipped (manual runs may execute
// alongside an in-flight scheduled run). The spawned task itself still
// flows through the job's configured approval envelope at fire-time.
async function runJobTool(
  config: RuntimeConfig,
  taskId: string,
  args: Record<string, unknown>
): Promise<string> {
  const jobId = requireString(args, "jobId");

  // Pre-side-effect terminal check. Lock-free fast path: avoid touching
  // the state lock when the parent task is already terminal. The
  // serialized re-check inside `runJobNow` (via `parentTaskId`) is the
  // authoritative guard against a `cancelTask` landing between this
  // pre-check and our write.
  {
    const state = readState(config.instance);
    const task = state.tasks.find((item) => item.id === taskId);
    if (task && isTerminalTaskStatus(task.status)) {
      return `Error: run_job skipped because task is already ${task.status}.`;
    }
  }

  // Resolve the job up-front so we can surface its name in the return
  // string (and fail fast on an unknown id instead of letting `runJobNow`
  // throw deep in its mutateState).
  const before = listJobs(config).find((candidate) => candidate.id === jobId);
  if (!before) throw new Error(`Job not found: ${jobId}`);

  const result = await runJobNow(config, jobId, "manual", taskId);
  // `runJobNow` only returns undefined on the overlap-skip branch, which
  // is gated on trigger==="schedule" — so for "manual" it should never
  // happen in normal operation. Surface a clear error if the contract ever
  // changes rather than crashing on the destructure below.
  if (!result) {
    throw new Error(`run_job for ${jobId} produced no run (overlap skip should not apply to manual triggers).`);
  }
  // Script jobs return { jobId, runId, exitCode, stdout, stderr }; prompt
  // jobs return { jobId, runId, taskId }. The taskId is only meaningful for
  // prompt jobs — script jobs run synchronously inside `runJobNow` and
  // never spawn an agent task. Discriminate on shape.
  const runId = (result as { runId: string }).runId;
  const isScriptResult = Object.prototype.hasOwnProperty.call(result, "exitCode");
  const exitCode = isScriptResult ? (result as { exitCode: number }).exitCode : undefined;
  const stderr = isScriptResult ? (result as { stderr?: string }).stderr ?? "" : "";
  const spawnedTaskId = isScriptResult ? undefined : (result as { taskId?: string }).taskId;

  await mutateState(config.instance, (state) => {
    const item = findTask(state, taskId);
    addAudit(
      state,
      {
        actor: "agent",
        action: "job.run.manual",
        target: jobId,
        risk: "low",
        taskId: item.id,
        runId: item.runId,
        evidence: isScriptResult
          ? { jobId, runId, exitCode }
          : { jobId, runId, spawnedTaskId }
      },
      { taskId: item.id }
    );
    item.updatedAt = now();
  });
  appendTrace(config.instance, taskId, {
    type: "job",
    message: isScriptResult ? "Manually executed script job" : "Manually triggered job run",
    data: isScriptResult
      ? { jobId, runId, exitCode }
      : { jobId, runId, taskId: spawnedTaskId }
  });

  if (isScriptResult) {
    // Script jobs run synchronously inside `runJobNow`, so by the time we
    // return here the run is already complete. Report the result rather
    // than "Triggered" so the model can see success/failure without
    // chasing the JobRun record.
    if (exitCode === 0) {
      return `Script job ${jobId} (\"${before.name}\") completed — run ${runId}, exit 0.`;
    }
    // On failure include a truncated tail of stderr so the model can see
    // what went wrong without overwhelming context. Skip stdout — script
    // jobs are typically side-effect-driven and the audit/trace already
    // captures both streams.
    const stderrTail = stderr.length > 500 ? stderr.slice(stderr.length - 500) : stderr;
    const stderrSuffix = stderrTail ? ` stderr: ${stderrTail}` : "";
    return `Script job ${jobId} (\"${before.name}\") failed — run ${runId}, exit ${exitCode}.${stderrSuffix}`;
  }

  const taskSuffix = spawnedTaskId ? `, task ${spawnedTaskId}` : "";
  return `Triggered job ${jobId} (\"${before.name}\") — run ${runId}${taskSuffix}.`;
}

// Email watcher management (ADR email-watch.md). One handler dispatches the
// add / list / remove actions. Low-risk: only writes an EmailWatcherRecord
// (and, on add, a dedicated chat session for the woken turns to post into).
// The actual mail reading/replying happens later in the woken turn, gated by
// terminal_exec's approval. The audit row is recorded by the state helper.
async function emailWatchTool(
  config: RuntimeConfig,
  taskId: string,
  args: Record<string, unknown>
): Promise<string> {
  const action = requireString(args, "action");

  if (action === "list") {
    // Scope to the calling agent so it sees only its own watches (mirrors how
    // `add` resolves the owning agent) — otherwise an agent reads every agent's
    // watches and wrongly concludes a matching one already exists.
    const callingAgentId = readState(config.instance).tasks.find((t) => t.id === taskId)?.agentId;
    const watchers = listEmailWatchers(config, callingAgentId);
    const summary = watchers.map((w) => ({
      id: w.id,
      query: w.query,
      sender: w.sender,
      threadId: w.threadId,
      followUpAfterHours: w.followUpAfterHours,
      objective: w.objective,
      accountEmail: w.accountEmail,
      ...(w.accountWarning ? { accountWarning: w.accountWarning } : {}),
      enabled: w.enabled,
      status: w.status,
      chatSessionId: w.chatSessionId,
      lastPolledAt: w.lastPolledAt
    }));
    await recordLowRiskAudit(config, taskId, "email.watcher.listed", "email", { count: summary.length });
    return JSON.stringify({ count: summary.length, watchers: summary });
  }

  if (action === "remove") {
    const id = requireString(args, "id");
    const removed = await removeEmailWatcher(config, id);
    appendTrace(config.instance, taskId, {
      type: "tool",
      message: "Removed email watcher",
      data: { watcherId: removed.id }
    });
    return `Removed email watcher ${removed.id} (query: ${removed.query}).`;
  }

  if (action === "disable" || action === "enable") {
    const id = requireString(args, "id");
    const enabled = action === "enable";
    const updated = await setEmailWatcherEnabled(config, id, enabled);
    if (!updated) throw new Error(`Email watcher not found: ${id}`);
    appendTrace(config.instance, taskId, {
      type: "tool",
      message: enabled ? "Enabled email watcher" : "Disabled email watcher",
      data: { watcherId: updated.id }
    });
    return enabled
      ? `Enabled email watcher ${updated.id} (query: ${updated.query}); polling resumed.`
      : `Disabled email watcher ${updated.id} (query: ${updated.query}); polling paused.`;
  }

  if (action === "update") {
    // Revise a watcher's standing objective (the user changed the goal
    // mid-conversation), or clear it entirely (clearObjective: true) when the
    // user drops the standing goal. Deep validation (trim, cap, empty) lives in
    // the shared state helper so the tool, HTTP, and CLI channels enforce the
    // same contract.
    const id = requireString(args, "id");
    if (args.clearObjective === true) {
      const updated = await clearEmailWatcherObjective(config, id);
      if (!updated) throw new Error(`Email watcher not found: ${id}`);
      appendTrace(config.instance, taskId, {
        type: "tool",
        message: "Cleared email watcher objective",
        data: { watcherId: updated.id }
      });
      return `Cleared objective for email watcher ${updated.id}.`;
    }
    const objective = requireString(args, "objective");
    const updated = await setEmailWatcherObjective(config, id, objective);
    if (!updated) throw new Error(`Email watcher not found: ${id}`);
    appendTrace(config.instance, taskId, {
      type: "tool",
      message: "Updated email watcher objective",
      data: { watcherId: updated.id }
    });
    return `Updated objective for email watcher ${updated.id}: ${updated.objective}`;
  }

  if (action !== "add") {
    throw new Error(`Invalid input: action must be one of "add" | "list" | "remove" | "disable" | "enable" | "update" (got ${action}).`);
  }

  // action === "add". Build the Gmail query: a raw `query` wins; otherwise
  // `from:<sender>`; otherwise the whole inbox (`in:inbox`).
  let sender: string | undefined;
  if (args.sender !== undefined && args.sender !== null) {
    if (typeof args.sender !== "string" || args.sender.length === 0) {
      throw new Error("Invalid input: sender must be a non-empty string.");
    }
    sender = args.sender;
  }
  let rawQuery: string | undefined;
  if (args.query !== undefined && args.query !== null) {
    if (typeof args.query !== "string" || args.query.length === 0) {
      throw new Error("Invalid input: query must be a non-empty string.");
    }
    rawQuery = args.query;
  }
  let account: string | undefined;
  if (args.account !== undefined && args.account !== null) {
    if (typeof args.account !== "string" || args.account.length === 0) {
      throw new Error("Invalid input: account must be a non-empty string.");
    }
    account = args.account;
  }
  // Deep objective validation (trim, cap, empty) lives in addEmailWatcher so
  // every channel enforces the same contract; this is the type gate only.
  let objective: string | undefined;
  if (args.objective !== undefined && args.objective !== null) {
    if (typeof args.objective !== "string" || args.objective.length === 0) {
      throw new Error("Invalid input: objective must be a non-empty string.");
    }
    objective = args.objective;
  }
  let threadId: string | undefined;
  if (args.threadId !== undefined && args.threadId !== null) {
    if (typeof args.threadId !== "string" || args.threadId.length === 0) {
      throw new Error("Invalid input: threadId must be a non-empty string.");
    }
    threadId = args.threadId;
  }
  // Deep validation (positive, thread watches only) lives in addEmailWatcher.
  let followUpAfterHours: number | undefined;
  if (args.followUpAfterHours !== undefined && args.followUpAfterHours !== null) {
    if (typeof args.followUpAfterHours !== "number") {
      throw new Error("Invalid input: followUpAfterHours must be a number.");
    }
    followUpAfterHours = args.followUpAfterHours;
  }
  // Inherit the originating task's agent so the watcher + its dedicated chat
  // session (and the future woken turns) attribute to the right agent, and its
  // chat session so a broad/topic watch delivers drafts into the conversation
  // where it was set up (addEmailWatcher ignores this for sender/thread watches).
  const originatingTask = readState(config.instance).tasks.find((t) => t.id === taskId);
  const owningAgentId = originatingTask?.agentId;
  const deliverToSessionId = originatingTask?.chatSessionId;

  // Whole-inbox triage opt-in: `triage: true` provisions the broad respond-or-flag
  // concern over the ENTIRE inbox; `triage: false` tears it down. Triage is OPT-IN
  // — only set it when the user explicitly asked to triage all their new mail, never
  // when they name a specific sender/thread. When triage is the ONLY thing requested
  // (no sender/query/threadId), opt in/out without creating a normal watcher.
  if (args.triage !== undefined && args.triage !== null) {
    if (typeof args.triage !== "boolean") {
      throw new Error("Invalid input: triage must be a boolean.");
    }
    await setEmailTriageEnabled(config, owningAgentId, args.triage);
    appendTrace(config.instance, taskId, {
      type: "tool",
      message: args.triage ? "Enabled inbox triage" : "Disabled inbox triage"
    });
    if (sender === undefined && rawQuery === undefined && threadId === undefined) {
      return args.triage
        ? "Whole-inbox triage enabled: newly-arrived mail no specific watch claims gets a proposed reply or a flag in the Inbox triage channel. Never sends without your approval."
        : "Whole-inbox triage disabled. Targeted sender/thread watches are unaffected.";
    }
  }

  // Belt-and-suspenders for multi-account selection: when no `account` was given
  // and 2+ Google accounts are signed in, do NOT default arbitrarily — return a
  // hint that lists the accounts and tells the model to ask the user (ask_user),
  // then re-add with the chosen `account`. One signed-in account auto-defaults
  // (Phase A); an explicit `account` resolves; so this fires only on a genuinely
  // ambiguous add. No watcher is created.
  const selectionHint = await accountSelectionNeeded(account);
  if (selectionHint) {
    appendTrace(config.instance, taskId, {
      type: "tool",
      message: "Email watch needs account selection"
    });
    return selectionHint;
  }

  const watcher = await addEmailWatcher(config, { sender, query: rawQuery, account, objective, threadId, followUpAfterHours, agentId: owningAgentId, deliverToSessionId });

  appendTrace(config.instance, taskId, {
    type: "tool",
    message: "Created email watcher",
    data: { watcherId: watcher.id, query: watcher.query, chatSessionId: watcher.chatSessionId, accountEmail: watcher.accountEmail }
  });
  const accountLabel = watcher.accountEmail ? ` in ${watcher.accountEmail}` : "";
  const warning = watcher.accountWarning ? ` Note: ${watcher.accountWarning}` : "";
  return `Watching email${accountLabel} (query: ${watcher.query}). Watcher ${watcher.id}; proposed replies will appear in its chat thread (${watcher.chatSessionId}). It polls about once a minute and never sends without your approval.${warning}`;
}

// Explicit on-demand memory recall. Wraps the same `recall()` entrypoint
// that the chat-task loop runs automatically at the start of each task,
// but exposes it to the model so it can fetch additional memory mid-
// conversation when the user references prior context. Returns a compact
// JSON-serialized summary so the model can decide whether to dig deeper.
// Low-risk / read-only.
async function recallMemoryTool(
  config: RuntimeConfig,
  taskId: string,
  args: Record<string, unknown>
): Promise<string> {
  const query = requireString(args, "query");
  let tokenBudget: number | undefined;
  if (args.tokenBudget !== undefined && args.tokenBudget !== null) {
    if (typeof args.tokenBudget !== "number" || !Number.isFinite(args.tokenBudget) || args.tokenBudget <= 0) {
      throw new Error("Invalid input: tokenBudget must be a positive number.");
    }
    tokenBudget = args.tokenBudget;
  }
  let bankId: string | undefined;
  if (args.bankId !== undefined && args.bankId !== null) {
    if (typeof args.bankId !== "string" || args.bankId.length === 0) {
      throw new Error("Invalid input: bankId must be a non-empty string.");
    }
    bankId = args.bankId;
  }
  const state = readState(config.instance);
  const effective = resolveEffectiveContext(state, config);
  if (!effective.agentId) {
    throw new Error("Cannot recall memory: no active agent.");
  }
  const result = await recall(config, {
    agentId: effective.agentId,
    query,
    tokenBudget,
    bankId,
    sourceTaskId: taskId
  });
  const excerpts = result.units.map((entry) => ({
    id: entry.unit.id,
    content: entry.unit.text.length > 200 ? `${entry.unit.text.slice(0, 200)}…` : entry.unit.text,
    score: Number(entry.score.toFixed(4))
  }));
  await recordLowRiskAudit(config, taskId, "memory.recalled", query, {
    units: result.units.length,
    totalTokens: result.totalTokens,
    tokenBudget,
    bankId: bankId ?? null
  });
  return JSON.stringify({
    units: result.units.length,
    totalTokens: result.totalTokens,
    excerpts
  });
}

// ---- Agent-database primitive tools (ADR agent-database.md) ----
//
// db_query / db_execute / db_import / db_schema operate on the active agent's
// own sandboxed SQLite file (src/state/agent-data-db.ts), isolated from Gini's
// system data. Low-risk / no-approval: it's the agent's private data store, like
// memory; the file-level isolation is the safety boundary. AgentDataError from
// the storage layer propagates as the tool result so the model can correct its
// SQL.

function requireAgentId(config: RuntimeConfig, what: string): string {
  const state = readState(config.instance);
  const effective = resolveEffectiveContext(state, config);
  if (!effective.agentId) throw new Error(`Cannot ${what}: no active agent.`);
  return effective.agentId;
}

// Read an optional string arg as string | undefined (undefined when absent or
// empty), without the fallback that optionalString applies.
function optStr(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`Argument ${key} must be a string.`);
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function queryParams(args: Record<string, unknown>): unknown[] {
  if (args.params === undefined || args.params === null) return [];
  if (!Array.isArray(args.params)) throw new Error("Argument params must be an array.");
  return args.params;
}

async function dbQueryTool(config: RuntimeConfig, taskId: string, args: Record<string, unknown>): Promise<string> {
  const agentId = requireAgentId(config, "query the database");
  const sql = requireString(args, "sql");
  const result = dbQuery(config.instance, agentId, sql, queryParams(args));
  await recordLowRiskAudit(config, taskId, "db.query", sql.slice(0, 200), {
    rows: result.rowCount,
    truncated: result.truncated
  });
  return JSON.stringify(result);
}

async function dbExecuteTool(config: RuntimeConfig, taskId: string, args: Record<string, unknown>): Promise<string> {
  const agentId = requireAgentId(config, "use the database");
  const sql = requireString(args, "sql");
  const result = dbExecute(config.instance, agentId, sql, queryParams(args));
  appendTrace(config.instance, taskId, { type: "tool", message: "Database write", data: { sql: sql.slice(0, 200), changes: result.changes } });
  await recordLowRiskAudit(config, taskId, "db.execute", sql.slice(0, 200), { changes: result.changes });
  return JSON.stringify(result);
}

async function dbImportTool(config: RuntimeConfig, taskId: string, args: Record<string, unknown>): Promise<string> {
  const agentId = requireAgentId(config, "import into the database");
  const path = requireString(args, "path");
  const table = requireString(args, "table");
  const skipLines = typeof args.skipLines === "number" ? args.skipLines : undefined;
  const recreate = args.recreate === true;
  const report = await importTableFromFile(config, agentId, path, table, { skipLines, recreate });
  appendTrace(config.instance, taskId, { type: "tool", message: "Table imported", data: { ...report } });
  await recordLowRiskAudit(config, taskId, "db.import", `${path} -> ${report.table}`, {
    rowsInserted: report.rowsInserted,
    rowsSkipped: report.rowsSkipped
  });
  return JSON.stringify(report);
}

async function dbSchemaTool(config: RuntimeConfig, taskId: string, args: Record<string, unknown>): Promise<string> {
  const agentId = requireAgentId(config, "read the database schema");
  void args;
  const tables = dbListTables(config.instance, agentId);
  await recordLowRiskAudit(config, taskId, "db.schema", "", { tables: tables.length });
  return JSON.stringify({ tables });
}

// Edit the active agent's SOUL.md. Same flow as edit_user_profile:
// a clean body auto-approves (lands at SOUL.md, effective on the next
// system prompt); an injection-flagged body routes to SOUL.md.proposed
// and stays out of the prompt until the user approves it. `set` replaces
// the body; `append` layers a new section under the existing approved
// body; `remove` drops the first paragraph containing a substring
// (`needle`) from the existing approved body.
// See ADR runtime-identity-files.md.
async function editSoulTool(
  config: RuntimeConfig,
  taskId: string,
  args: Record<string, unknown>
): Promise<string> {
  const action = optionalString(args, "action", "set");
  if (action !== "set" && action !== "append" && action !== "remove") {
    throw new Error("Invalid input: action must be 'set', 'append', or 'remove'.");
  }
  const state = readState(config.instance);
  const effective = resolveEffectiveContext(state, config);
  const agentId = effective.agentId;
  if (!agentId) {
    throw new Error("Cannot edit SOUL.md: no active agent.");
  }
  // Serialize the whole read-modify-write against concurrent edits to the
  // SAME SOUL.md. Same-parent sibling subagents share an agentId (and thus
  // this path), and they can now overlap, so without this lock two appends
  // could both read the same body and last-write-wins. See
  // withIdentityFileLock.
  return withIdentityFileLock(soulPath(config.instance, agentId), () =>
    editSoulToolLocked(config, taskId, args, action, agentId)
  );
}

async function editSoulToolLocked(
  config: RuntimeConfig,
  taskId: string,
  args: Record<string, unknown>,
  action: "set" | "append" | "remove",
  agentId: string
): Promise<string> {
  if (action === "remove") {
    const needle = requireString(args, "needle");
    // Pre-scan the post-remove body so a hostile pattern that survives
    // the deletion still routes through the propose path. Without the
    // pre-scan a remove against a file whose remaining paragraphs trip
    // the scanner would auto-approve a tainted body.
    const preview = previewRemoveSoulSection(config.instance, agentId, needle);
    if (!preview.ok) {
      // No mutation hit disk — surface a clean failure to the model so
      // it can retry with a different needle instead of assuming the
      // edit landed. We deliberately do NOT throw: an invalid input
      // should leave the conversation intact.
      const reason = preview.reason === "no source"
        ? "no approved SOUL.md exists to remove from"
        : `no paragraph matched needle "${needle}"`;
      return `Could not remove SOUL.md section: ${reason}.`;
    }
    const targetStatus: IdentityFileStatus = preview.scanFindings.length > 0 ? "proposed" : "approved";
    const removeResult = removeSoulSection(config.instance, agentId, needle, targetStatus);
    if (!removeResult.ok) {
      // The pre-scan already confirmed there is a source and a match — a
      // fall-through here is only reachable on a concurrent filesystem
      // race; surface the same clean failure shape.
      const reason = removeResult.reason === "no source"
        ? "no approved SOUL.md exists to remove from"
        : `no paragraph matched needle "${needle}"`;
      return `Could not remove SOUL.md section: ${reason}.`;
    }
    const autoApproved = removeResult.status === "approved";
    const auditAction = autoApproved
      ? "identity.soul.approved"
      : "identity.soul.proposed";
    await mutateState(config.instance, (state) => {
      const item = findTask(state, taskId);
      addAudit(
        state,
        {
          actor: "agent",
          action: auditAction,
          target: removeResult.path,
          risk: autoApproved ? "low" : "medium",
          taskId: item.id,
          runId: item.runId,
          evidence: {
            agentId,
            action,
            needle,
            path: removeResult.path,
            scanFindings: removeResult.scanFindings,
            autoApproved
          }
        },
        { taskId: item.id }
      );
      item.updatedAt = now();
    });
    appendTrace(config.instance, taskId, {
      type: "model",
      message: autoApproved
        ? "SOUL.md remove (auto-approved)"
        : "SOUL.md remove blocked from prompt (proposed)",
      data: { agentId, action, needle, path: removeResult.path, scanFindings: removeResult.scanFindings, autoApproved }
    });
    if (!autoApproved) {
      const scanNote = ` (scan flagged: ${removeResult.scanFindings.join(", ")}; content blocked from prompt until approved)`;
      return `Proposed SOUL.md remove at ${removeResult.path}${scanNote}. Awaiting user approval via POST /api/identity-files/soul/approve.`;
    }
    return `Updated SOUL.md at ${removeResult.path} (removed paragraph matching "${needle}").`;
  }
  const content = requireString(args, "content");
  // For 'append', the new body carries the existing approved body
  // followed by a blank line and the new content. The approved file
  // stays the source of truth. Lines from `content` that already
  // exist verbatim in the existing body are dropped so a model that
  // re-emits the current file alongside the new fact doesn't duplicate.
  let body = content;
  let appendDedupeDropped = 0;
  if (action === "append") {
    const existing = loadSoul(config.instance, agentId);
    if (existing && existing.trim().length > 0 && !existing.startsWith("[BLOCKED:")) {
      const dedupe = dedupeAppendLines(existing, content);
      appendDedupeDropped = dedupe.droppedLineCount;
      if (dedupe.empty) {
        // Nothing new to append — surface a no-op so the model knows the
        // write was redundant and the file stays clean. Audit + trace
        // record the suppression so it stays observable.
        await mutateState(config.instance, (state) => {
          const item = findTask(state, taskId);
          addAudit(
            state,
            {
              actor: "agent",
              action: "identity.soul.append.noop",
              target: soulPath(config.instance, agentId),
              risk: "low",
              taskId: item.id,
              runId: item.runId,
              evidence: { agentId, droppedLineCount: appendDedupeDropped }
            },
            { taskId: item.id }
          );
          item.updatedAt = now();
        });
        appendTrace(config.instance, taskId, {
          type: "model",
          message: "SOUL.md append no-op (all lines already present)",
          data: { agentId, droppedLineCount: appendDedupeDropped }
        });
        return `No SOUL.md change: all appended lines already exist in the approved body.`;
      }
      body = `${existing.trim()}\n\n${dedupe.residual}`;
    }
  }
  // Pre-scan the proposed body. When the scan flags a threat the write
  // is routed to `.proposed` so a hostile body never lands at the
  // approved path. Only clean bodies auto-approve. See ADR
  // runtime-identity-files.md.
  const previewScan = scanForInjection(body, "SOUL.md");
  const targetStatus: IdentityFileStatus = previewScan.findings.length > 0 ? "proposed" : "approved";
  const result = writeSoul(config.instance, agentId, body, targetStatus);
  const autoApproved = result.status === "approved";
  const auditAction = autoApproved
    ? "identity.soul.approved"
    : "identity.soul.proposed";
  await mutateState(config.instance, (state) => {
    const item = findTask(state, taskId);
    addAudit(
      state,
      {
        actor: "agent",
        action: auditAction,
        target: result.path,
        risk: autoApproved ? "low" : "medium",
        taskId: item.id,
        runId: item.runId,
        evidence: {
          agentId,
          action,
          path: result.path,
          contentBytes: body.length,
          scanFindings: result.scanFindings,
          autoApproved,
          ...(appendDedupeDropped > 0 ? { droppedLineCount: appendDedupeDropped } : {})
        }
      },
      { taskId: item.id }
    );
    item.updatedAt = now();
  });
  appendTrace(config.instance, taskId, {
    type: "model",
    message: autoApproved
      ? "SOUL.md edit (auto-approved)"
      : "SOUL.md edit blocked from prompt (proposed)",
    data: { agentId, action, path: result.path, contentBytes: body.length, scanFindings: result.scanFindings, autoApproved }
  });
  if (!autoApproved) {
    const scanNote = ` (scan flagged: ${result.scanFindings.join(", ")}; content blocked from prompt until approved)`;
    return `Proposed SOUL.md edit at ${result.path}${scanNote}. Awaiting user approval via POST /api/identity-files/soul/approve.`;
  }
  return `Updated SOUL.md at ${result.path}.`;
}

// Propose an edit to the instance-scoped USER.md. Same propose →
// approve flow as edit_soul. Instance-scoped so user identity carries
// across agent switches.
async function editUserProfileTool(
  config: RuntimeConfig,
  taskId: string,
  args: Record<string, unknown>
): Promise<string> {
  const action = optionalString(args, "action", "set");
  if (action !== "set" && action !== "append" && action !== "remove") {
    throw new Error("Invalid input: action must be 'set', 'append', or 'remove'.");
  }
  // Serialize the read-modify-write against concurrent edits to USER.md.
  // USER.md is per-instance, so ANY two overlapping subagents in the
  // instance contend on it; the lock prevents a lost append. See
  // withIdentityFileLock.
  return withIdentityFileLock(userProfilePath(config.instance), () =>
    editUserProfileToolLocked(config, taskId, args, action)
  );
}

async function editUserProfileToolLocked(
  config: RuntimeConfig,
  taskId: string,
  args: Record<string, unknown>,
  action: "set" | "append" | "remove"
): Promise<string> {
  if (action === "remove") {
    const needle = requireString(args, "needle");
    // Pre-scan the post-remove body so a hostile pattern that survives
    // the deletion still routes through the propose path. Without the
    // pre-scan a remove against a file whose remaining paragraphs trip
    // the scanner would auto-approve a tainted body.
    const preview = previewRemoveUserProfileSection(config.instance, needle);
    if (!preview.ok) {
      const reason = preview.reason === "no source"
        ? "no approved USER.md exists to remove from"
        : `no paragraph matched needle "${needle}"`;
      return `Could not remove USER.md section: ${reason}.`;
    }
    const targetStatus: IdentityFileStatus = preview.scanFindings.length > 0 ? "proposed" : "approved";
    const removeResult = removeUserProfileSection(config.instance, needle, targetStatus);
    if (!removeResult.ok) {
      // The pre-scan already confirmed there is a source and a match — a
      // fall-through here is only reachable on a concurrent filesystem
      // race; surface the same clean failure shape.
      const reason = removeResult.reason === "no source"
        ? "no approved USER.md exists to remove from"
        : `no paragraph matched needle "${needle}"`;
      return `Could not remove USER.md section: ${reason}.`;
    }
    const autoApproved = removeResult.status === "approved";
    const auditAction = autoApproved
      ? "identity.user_profile.approved"
      : "identity.user_profile.proposed";
    await mutateState(config.instance, (state) => {
      const item = findTask(state, taskId);
      addAudit(
        state,
        {
          actor: "agent",
          action: auditAction,
          target: removeResult.path,
          risk: autoApproved ? "low" : "medium",
          taskId: item.id,
          runId: item.runId,
          evidence: {
            action,
            needle,
            path: removeResult.path,
            scanFindings: removeResult.scanFindings,
            autoApproved
          }
        },
        { taskId: item.id }
      );
      item.updatedAt = now();
    });
    appendTrace(config.instance, taskId, {
      type: "model",
      message: autoApproved
        ? "USER.md remove (auto-approved)"
        : "USER.md remove blocked from prompt (proposed)",
      data: { action, needle, path: removeResult.path, scanFindings: removeResult.scanFindings, autoApproved }
    });
    if (!autoApproved) {
      const scanNote = ` (scan flagged: ${removeResult.scanFindings.join(", ")}; content blocked from prompt until approved)`;
      return `Proposed USER.md remove at ${removeResult.path}${scanNote}. Awaiting user approval via POST /api/identity-files/user/approve.`;
    }
    return `Updated USER.md at ${removeResult.path} (removed paragraph matching "${needle}").`;
  }
  const content = requireString(args, "content");
  let body = content;
  let appendDedupeDropped = 0;
  if (action === "append") {
    const existing = loadUserProfile(config.instance);
    if (existing && existing.trim().length > 0 && !existing.startsWith("[BLOCKED:")) {
      // Drop lines from `content` that already live verbatim in the
      // existing body so a model that re-emits the current file
      // alongside the new fact doesn't duplicate (the dominant
      // overshoot pattern on weaker tool-calling models). When the
      // residual is empty no write happens — the file is already
      // current.
      const dedupe = dedupeAppendLines(existing, content);
      appendDedupeDropped = dedupe.droppedLineCount;
      if (dedupe.empty) {
        await mutateState(config.instance, (state) => {
          const item = findTask(state, taskId);
          addAudit(
            state,
            {
              actor: "agent",
              action: "identity.user_profile.append.noop",
              target: userProfilePath(config.instance),
              risk: "low",
              taskId: item.id,
              runId: item.runId,
              evidence: { droppedLineCount: appendDedupeDropped }
            },
            { taskId: item.id }
          );
          item.updatedAt = now();
        });
        appendTrace(config.instance, taskId, {
          type: "model",
          message: "USER.md append no-op (all lines already present)",
          data: { droppedLineCount: appendDedupeDropped }
        });
        return `No USER.md change: all appended lines already exist.`;
      }
      body = `${existing.trim()}\n\n${dedupe.residual}`;
    }
  }
  // Pre-scan the proposed body. When the scan flags a threat the write
  // is routed to `.proposed` (matching edit_soul semantics) so a hostile
  // body never lands at the approved path. Only clean bodies auto-approve.
  // See ADR runtime-identity-files.md.
  const previewScan = scanForInjection(body, "USER.md");
  const targetStatus: IdentityFileStatus = previewScan.findings.length > 0 ? "proposed" : "approved";
  const result = writeUserProfile(config.instance, body, targetStatus);
  const autoApproved = result.status === "approved";
  const auditAction = autoApproved
    ? "identity.user_profile.approved"
    : "identity.user_profile.proposed";
  await mutateState(config.instance, (state) => {
    const item = findTask(state, taskId);
    addAudit(
      state,
      {
        actor: "agent",
        action: auditAction,
        target: result.path,
        risk: autoApproved ? "low" : "medium",
        taskId: item.id,
        runId: item.runId,
        evidence: {
          action,
          path: result.path,
          contentBytes: body.length,
          scanFindings: result.scanFindings,
          autoApproved,
          ...(appendDedupeDropped > 0 ? { droppedLineCount: appendDedupeDropped } : {})
        }
      },
      { taskId: item.id }
    );
    item.updatedAt = now();
  });
  appendTrace(config.instance, taskId, {
    type: "model",
    message: autoApproved
      ? "USER.md edit (auto-approved)"
      : "USER.md edit blocked from prompt (proposed)",
    data: { action, path: result.path, contentBytes: body.length, scanFindings: result.scanFindings, autoApproved }
  });
  if (!autoApproved) {
    const scanNote = ` (scan flagged: ${result.scanFindings.join(", ")}; content blocked from prompt until approved)`;
    return `Proposed USER.md edit at ${result.path}${scanNote}. Awaiting user approval via POST /api/identity-files/user/approve.`;
  }
  return `Updated USER.md at ${result.path}.`;
}

// Cross-session lookup wrapping `searchSessions`. Returns up to `limit`
// (default 20, capped at 100) snippets matching the query. Low-risk and
// read-only — no audit row, matching the sibling read-only meta tools
// (`file_read`, `file_search`, `read_skill`). The per-task trace below
// is the right narrative seam for "the agent searched X".
async function searchHistoryTool(
  config: RuntimeConfig,
  taskId: string,
  args: Record<string, unknown>
): Promise<string> {
  const query = requireString(args, "query");
  let limit = 20;
  if (args.limit !== undefined && args.limit !== null) {
    if (typeof args.limit !== "number" || !Number.isFinite(args.limit) || args.limit <= 0) {
      throw new Error("Invalid input: limit must be a positive number.");
    }
    limit = Math.min(100, Math.floor(args.limit));
  }
  const results = searchSessions(config, query, limit);
  appendTrace(config.instance, taskId, {
    type: "tool",
    message: "Searched session history",
    data: { query, limit, hits: results.length }
  });
  return JSON.stringify({
    count: results.length,
    results: results.map((r) => ({
      kind: r.kind,
      title: r.title,
      excerpt: r.excerpt,
      taskId: r.taskId,
      source: r.source,
      score: r.score
    }))
  });
}

// Cancel a task. Refuses to cancel the CURRENT task — that would
// terminate the running conversation. Wraps `cancelTask`, which already
// refuses on already-terminal tasks and cascades to child subagents.
// Self-cancel is guarded twice: the lock-free pre-check below is the
// fast path that lets the model see a friendly message instead of an
// error, and `cancelTask(..., callerTaskId)` re-checks inside its
// serialized mutateState callback so a request that slips between the
// pre-check and the mutation still throws before any state change.
async function cancelTaskTool(
  config: RuntimeConfig,
  callerTaskId: string,
  args: Record<string, unknown>
): Promise<string> {
  const targetTaskId = requireString(args, "taskId");
  if (targetTaskId === callerTaskId) {
    return `Error: cannot cancel the current task — that would terminate the running conversation. Use this only for child subagents or unrelated tasks.`;
  }
  const stateNow = readState(config.instance);
  const target = stateNow.tasks.find((t) => t.id === targetTaskId);
  if (!target) throw new Error(`Task not found: ${targetTaskId}`);
  if (isTerminalTaskStatus(target.status)) {
    return `Task ${targetTaskId} is already ${target.status}; no action taken.`;
  }
  const cancelled = await cancelTask(config, targetTaskId, { parentTaskId: callerTaskId });
  await mutateState(config.instance, (state) => {
    const item = findTask(state, callerTaskId);
    addAudit(
      state,
      {
        actor: "agent",
        action: "task.cancel.requested",
        target: targetTaskId,
        risk: "low",
        taskId: item.id,
        runId: item.runId,
        evidence: { targetTaskId, previousStatus: target.status, newStatus: cancelled.status }
      },
      { taskId: item.id }
    );
    item.updatedAt = now();
  });
  appendTrace(config.instance, callerTaskId, {
    type: "task",
    message: "Requested task cancellation",
    data: { targetTaskId, previousStatus: target.status, newStatus: cancelled.status }
  });
  return `Cancelled task ${targetTaskId} (was ${target.status}, now ${cancelled.status}).`;
}

// Install a skill from a raw SKILL.md body. Wraps installSkillFromBody,
// which validates the manifest, writes it to disk, and reloads the skill
// registry. Returns the new skill id + name + validation issues so the
// model can surface a useful confirmation.
async function installSkillTool(
  config: RuntimeConfig,
  taskId: string,
  args: Record<string, unknown>
): Promise<string> {
  const body = requireString(args, "body");
  let files: Array<{ name: string; content: string }> | undefined;
  if (args.files !== undefined && args.files !== null) {
    if (!Array.isArray(args.files)) {
      throw new Error("Invalid input: files must be an array.");
    }
    const cleaned: Array<{ name: string; content: string }> = [];
    for (const entry of args.files) {
      if (!entry || typeof entry !== "object") {
        throw new Error("Invalid input: files entries must be objects with name+content.");
      }
      const candidate = entry as { name?: unknown; content?: unknown };
      if (typeof candidate.name !== "string" || candidate.name.length === 0) {
        throw new Error("Invalid input: files entries require a non-empty name.");
      }
      if (typeof candidate.content !== "string") {
        throw new Error("Invalid input: files entries require a string content.");
      }
      cleaned.push({ name: candidate.name, content: candidate.content });
    }
    files = cleaned;
  }
  const installed = await installSkillFromBody(config, { body, files });
  await mutateState(config.instance, (state) => {
    const item = findTask(state, taskId);
    addAudit(
      state,
      {
        actor: "agent",
        action: "skill.installed",
        target: installed.skill.id,
        risk: "low",
        taskId: item.id,
        runId: item.runId,
        evidence: {
          skillId: installed.skill.id,
          name: installed.skill.name,
          manifestPath: installed.manifestPath,
          validationIssues: installed.validation.issues,
          frontmatterWarnings: installed.validation.warnings
        }
      },
      { taskId: item.id }
    );
    item.updatedAt = now();
  });
  appendTrace(config.instance, taskId, {
    type: "tool",
    message: "Installed skill",
    data: { skillId: installed.skill.id, name: installed.skill.name, manifestPath: installed.manifestPath }
  });
  const issuesSuffix = installed.validation.issues.length > 0
    ? ` Warnings: ${installed.validation.issues.join("; ")}.`
    : "";
  // Surface advisory frontmatter near-misses prominently so the authoring
  // model fixes them and re-installs — these flag a silently-dropped
  // credential/connector declaration the skill is currently missing.
  const warningsSuffix = installed.validation.warnings.length > 0
    ? ` ⚠ Frontmatter warnings — fix and re-install: ${installed.validation.warnings.join("; ")}.`
    : "";
  return `Installed skill ${installed.skill.id} ("${installed.skill.name}") at ${installed.manifestPath}.${issuesSuffix}${warningsSuffix}`;
}

// Enable / disable a registered skill. Wraps setSkillStatus, which
// writes the matching skill.enabled / skill.disabled audit row.
//
// Enabling a NON-bundled skill that requires a credentialed connector is
// gated by a per-(skill, connector) consent grant (ADR
// skill-connector-consent.md): the tool mints a `skill.grant_connector`
// SetupRequest and returns `{ kind: "pending" }` instead of enabling, so the
// user approves the grant via the chat card before the connector's env can
// reach the skill's scripts. One SetupRequest per ungranted provider — the
// user grants one, the loop resumes, re-enters here, and either enables (no
// more ungranted providers) or mints the next grant. Bundled skills are
// auto-granted in resolveSkillEnv and skip the gate entirely.
async function setSkillStatusTool(
  config: RuntimeConfig,
  taskId: string,
  toolCallId: string,
  args: Record<string, unknown>,
  status: "enabled" | "disabled"
): Promise<DispatchResult> {
  const skillId = requireString(args, "skillId");

  if (status === "enabled") {
    const state = readState(config.instance);
    const skill = state.skills.find((s) => s.id === skillId || s.name === skillId);
    if (!skill) throw new Error(`Skill not found: ${skillId}`);
    const bundled = (skill.source ?? "user") === "bundled";
    if (!bundled) {
      // The first required credential that carries a secret and isn't yet
      // granted. A credential "carries a secret" when its connector has a
      // `type` (api-key/oauth2). Presence-only connectors (no type, no env)
      // leak nothing and need no consent. Name-based: skills declare
      // `requiredCredentials`, resolved against the named connector record.
      const ungranted = firstUngrantedCredential(state, skill);
      if (ungranted) {
        return await requestSkillConnectorGrant(config, taskId, toolCallId, skill.id, skill.name, ungranted.name, ungranted.label);
      }
    }
  }

  const skill = await setSkillStatus(config, skillId, status);
  appendTrace(config.instance, taskId, {
    type: "tool",
    message: status === "enabled" ? "Enabled skill" : "Disabled skill",
    data: { skillId: skill.id, name: skill.name, status }
  });
  await recordLowRiskAudit(config, taskId, status === "enabled" ? "skill.enable.requested" : "skill.disable.requested", skill.id, {
    skillId: skill.id,
    name: skill.name,
    status
  });
  return { kind: "sync", result: `${status === "enabled" ? "Enabled" : "Disabled"} skill ${skill.id} ("${skill.name}").` };
}

// Mint a `skill.grant_connector` SetupRequest for one (skill, credential) pair.
// Mirrors requestConnectorTool: the chat-task loop's pending handler emits a
// setup_requested block, the user grants via the chat card, and the
// /complete handler (src/http.ts) appends the credential name to
// grantedConnectors, enables the skill, and resumes this task. Surface-guarded
// like browser_fill_secrets — the amber card only renders in the web chat.
async function requestSkillConnectorGrant(
  config: RuntimeConfig,
  taskId: string,
  toolCallId: string,
  skillId: string,
  skillName: string,
  credentialName: string,
  credentialLabel: string
): Promise<DispatchResult> {
  const providerLabel = credentialLabel;

  // Surface guard — same rationale as browser_fill_secrets. The consent card
  // is React UI rendered only in the web chat; a task running over a
  // messaging bridge (Telegram/Discord), in a scheduled/headless job session
  // (origin:"job"), or with no chat session at all would park in
  // waiting_approval with no way to grant. Fail synchronously so the agent can
  // verbalize "open the web chat to grant" back to the user.
  // NOTE: sibling request_* guards in this file share the same shape but DON'T
  // yet check origin:"job"; that blind spot is tracked separately — do not
  // assume it's handled there.
  const surfaceState = readState(config.instance);
  const surfaceTask = findTask(surfaceState, taskId);
  const surfaceSession = surfaceTask.chatSessionId
    ? surfaceState.chatSessions.find((s) => s.id === surfaceTask.chatSessionId)
    : undefined;
  const surfaceKind = surfaceSession?.source?.kind ?? surfaceSession?.outboundMirror?.kind;
  if (!surfaceSession || surfaceSession.origin === "job") {
    return {
      kind: "sync",
      result: JSON.stringify({
        ok: false,
        error: `Enabling skill "${skillName}" needs a one-time grant of your ${providerLabel} credential, and that consent card only renders in a web chat session — this task isn't attached to one (subagent child, scheduled job, or other headless run). Route this through the web chat or settings page.`
      })
    };
  }
  if (isBridgeSurfaceKind(surfaceKind)) {
    return {
      kind: "sync",
      result: JSON.stringify({
        ok: false,
        error: `Enabling skill "${skillName}" needs a one-time grant of your ${providerLabel} credential, and the consent card only works in the web chat (this conversation is over ${surfaceKind}). Reply asking the user to open the web chat to grant access, then continue once they confirm.`
      })
    };
  }

  // Idempotent re-enter: if a pending grant SetupRequest already exists for
  // this (skill, provider) ON THIS TASK — e.g. the model re-called
  // enable_skill while the user hadn't yet acted on the card — reference it
  // instead of minting a duplicate. The dedupe is scoped to the SAME task:
  // each task that enables the skill needs its own resumable approval, since
  // completing the card resumes only its owning `setup.taskId`. Reusing
  // another task's pending request would park this task on a request that
  // resumes someone else, stranding it forever.
  const existing = surfaceState.setupRequests.find(
    (s) =>
      s.status === "pending" &&
      s.action === "skill.grant_connector" &&
      s.taskId === taskId &&
      s.payload.skillId === skillId &&
      s.payload.credentialName === credentialName
  );
  if (existing) {
    return { kind: "pending", approvalId: existing.id };
  }

  const reason = `Skill "${skillName}" requests access to your ${providerLabel} credential. Granting lets its scripts use ${providerLabel}; you can revoke by disabling the skill.`;
  const approvalId = await mutateState(config.instance, (mutable: RuntimeState) => {
    const item = findTask(mutable, taskId);
    if (isTerminalTaskStatus(item.status)) {
      throw new TaskAlreadyTerminalError(taskId, item.status);
    }
    const approval = createSetupRequest(mutable, {
      taskId: item.id,
      action: "skill.grant_connector",
      target: providerLabel,
      reason,
      payload: { skillId, skillName, credentialName, credentialLabel, toolCallId }
    });
    item.approvalIds.push(approval.id);
    item.updatedAt = now();
    // Persist the reason as a durable assistant bubble so it survives past
    // approval resolution — same pattern as requestConnectorTool.
    if (item.chatSessionId) {
      createChatMessage(mutable, {
        sessionId: item.chatSessionId,
        role: "assistant",
        content: reason,
        taskId: item.id,
        runId: item.runId,
        kind: "approval_reason",
        ...(item.threadId ? { threadId: item.threadId } : {}),
        ...(item.parentBlockId ? { parentBlockId: item.parentBlockId } : {})
      });
    }
    appendTrace(config.instance, item.id, {
      type: "approval",
      message: "Approval requested for skill connector grant",
      data: { approvalId: approval.id, skillId, credentialName, toolCallId }
    });
    return approval.id;
  });
  return { kind: "pending", approvalId };
}

// Poll the subagent record until its child task reaches a terminal state,
// or `timeoutMs` elapses. We poll instead of using events because the
// runtime state mutation queue is the canonical cross-call sync point and
// the chat-task loop's terminal transitions already call syncSubagentFromTask.
//
// On timeout we return a synthetic record with status "timeout" so the
// caller can recover (the underlying task continues running and may still
// complete later — its eventual completion will sync into the record).
async function waitForSubagentTerminal(
  config: RuntimeConfig,
  subagentId: string,
  timeoutMs: number,
  parentTaskId?: string
): Promise<{ status: string; summary?: string; error?: string; needsInput?: { question: string } }> {
  const deadline = Date.now() + Math.max(1000, timeoutMs);
  const pollMs = 100;
  while (Date.now() < deadline) {
    const state = readState(config.instance);
    const sub = state.subagents.find((item) => item.id === subagentId);
    if (!sub) return { status: "missing", error: `Subagent ${subagentId} disappeared.` };
    if (sub.status === "completed" || sub.status === "failed" || sub.status === "cancelled") {
      // "Additional input needed" return: the subagent reached a terminal
      // status but carries a question its ask_user could not answer in-band.
      // Surface it as status:"needs_input" so the parent re-asks instead of
      // treating the run as a plain completion. NOT a persisted
      // SubagentStatus — only the return-value status string. See ADR
      // chat-topics-tasks-subagents.md.
      if (sub.resultNeedsInput) {
        return {
          status: "needs_input",
          summary: sub.resultSummary ?? sub.summary,
          needsInput: sub.resultNeedsInput
        };
      }
      return {
        status: sub.status,
        summary: sub.resultSummary ?? sub.summary,
        error: sub.resultError ?? sub.error
      };
    }
    // Parent cancellation OR failure should short-circuit the wait
    // so the parent task can exit cleanly. The cascade in
    // `cancelTask` / `failTask` will eventually mark the subagent
    // terminal too, but we shouldn't pin the parent dispatch loop
    // on that round-trip. Checking `failed` (not just `cancelled`)
    // matters because a sibling approval denial flips the parent
    // through that branch.
    if (parentTaskId) {
      const parent = state.tasks.find((t) => t.id === parentTaskId);
      if (parent?.status === "cancelled" || parent?.status === "failed") {
        return { status: parent.status, error: `Parent task was ${parent.status} while subagent was running.` };
      }
    }
    await Bun.sleep(pollMs);
  }
  return { status: "timeout", error: `Subagent ${subagentId} did not finish within ${timeoutMs}ms.` };
}

// spawn_task's awaited-result wait. Mirrors waitForSubagentTerminal —
// including the bubble-up return when the child completed carrying an
// unanswerable question — plus child-task-specific park branches: a child
// task that PARKS on its own needs_input gate (unlike a helper it has a real
// thread, so ask_user parks there instead of bubbling) surfaces to the
// spawning run as status:"needs_input" immediately rather than pinning this
// dispatch until timeout, and a child parked waiting_approval on a pending
// Authorization surfaces as status:"waiting_approval" the same way. The
// child stays parked in its own thread; the user answers/approves it there.
// The stamped waiting_approval arm covers the GINI_NEEDS_INPUT_STATUS=0
// compat park, whose needsInput stamp still lands.
async function waitForSpawnedChildResult(
  config: RuntimeConfig,
  subagentId: string,
  childTaskId: string,
  timeoutMs: number,
  parentTaskId: string
): Promise<{ status: string; summary?: string; error?: string; needsInput?: Task["needsInput"] }> {
  const deadline = Date.now() + Math.max(1000, timeoutMs);
  // Poll granularity is read at call time so tests (and slow CI) can shrink
  // the dead-wait between a child going terminal and the awaiting parent
  // observing it. Defaults to 100ms; mirrors GINI_PAIR_POLL_MS.
  const pollMs = Number(process.env.GINI_SPAWN_POLL_MS) || 100;
  while (Date.now() < deadline) {
    const state = readState(config.instance);
    const sub = state.subagents.find((item) => item.id === subagentId);
    if (!sub) return { status: "missing", error: `Subagent ${subagentId} disappeared.` };
    if (sub.status === "completed" || sub.status === "failed" || sub.status === "cancelled") {
      if (sub.resultNeedsInput) {
        return {
          status: "needs_input",
          summary: sub.resultSummary ?? sub.summary,
          needsInput: sub.resultNeedsInput
        };
      }
      return {
        status: sub.status,
        summary: sub.resultSummary ?? sub.summary,
        error: sub.resultError ?? sub.error
      };
    }
    const child = state.tasks.find((t) => t.id === childTaskId);
    if (child?.needsInput && (child.status === "needs_input" || child.status === "waiting_approval")) {
      return { status: "needs_input", needsInput: child.needsInput };
    }
    // An Authorization-parked child (no needsInput stamp) would otherwise
    // spin this wait until timeout: the gate is settled by the user on the
    // confirm card in the child's own thread, so surface the park to the
    // spawning run immediately instead.
    if (
      child?.status === "waiting_approval" &&
      state.authorizations.some((a) => a.taskId === childTaskId && a.status === "pending")
    ) {
      return {
        status: "waiting_approval",
        summary: "Child task is waiting for the user to approve a gated action in its own thread."
      };
    }
    const parent = state.tasks.find((t) => t.id === parentTaskId);
    if (parent?.status === "cancelled" || parent?.status === "failed") {
      return { status: parent.status, error: `Parent task was ${parent.status} while the child task was running.` };
    }
    await Bun.sleep(pollMs);
  }
  return { status: "timeout", error: `Child task ${childTaskId} did not finish within ${timeoutMs}ms.` };
}

function isTextLike(path: string): boolean {
  const ext = extname(path).toLowerCase();
  return ["", ".ts", ".js", ".json", ".md", ".txt", ".html", ".css", ".yml", ".yaml"].includes(ext);
}

async function recordLowRiskAudit(
  config: RuntimeConfig,
  taskId: string,
  action: string,
  target: string,
  evidence: Record<string, unknown>
): Promise<void> {
  await mutateState(config.instance, (state: RuntimeState) => {
    const item = findTask(state, taskId);
    addAudit(
      state,
      {
        actor: "runtime",
        action,
        target,
        risk: "low",
        taskId: item.id,
        runId: item.runId,
        evidence
      },
      { taskId: item.id }
    );
    item.updatedAt = now();
  });
}

// ---------------- Self-knowledge / self-config ----------------
//
// The operation handlers live in self-registry.ts (the single source of
// truth). Each self-config capability is now a DIRECT deferred tool whose
// name IS the op name; this dispatcher routes the self tool cases through one
// helper. Query ops resolve synchronously; mutate ops route through the
// generic self.config approval branch (auto-approved in `auto`, gated in
// `strict`), with the actual handler re-run in agent.executeApprovedAction
// on approval.

async function dispatchSelfOp(
  config: RuntimeConfig,
  taskId: string,
  toolCallId: string,
  opName: string,
  args: Record<string, unknown>
): Promise<DispatchResult> {
  // The self tool cases are the only callers, and each name is a registered
  // op, so findSelfOperation always resolves here.
  const op = findSelfOperation(opName)!;
  if (op.tag === "query") {
    return { kind: "sync", result: await op.handler(config, taskId, args) };
  }
  // mutate => route through the approval seam. The actual handler run happens
  // in agent.executeApprovedAction (the "self.config" branch) on approval,
  // re-reading {opName, args} from the approval payload. The direct tool
  // passes args at TOP LEVEL, so the payload shape is identical to the legacy
  // facade and the executeApprovedAction branch needs no change.
  return pendingOrAuto(config, "self.config", undefined, (reason) => requestSelfInvoke(config, taskId, toolCallId, op.name, args, reason));
}

// ---------------- Approval-gated tools ----------------

async function requestFileWrite(
  config: RuntimeConfig,
  taskId: string,
  toolCallId: string,
  args: Record<string, unknown>,
  reasonOverride?: string
): Promise<string> {
  const target = requireString(args, "path");
  const content = requireString(args, "content");
  assertInsideWorkspace(config.workspaceRoot, target);
  return mutateState(config.instance, (state: RuntimeState) => {
    const item = findTask(state, taskId);
    // Respect a terminal status the cancelled-task race opened up
    // between the chat loop's top-of-iteration check and our claim
    // on the per-instance lock. Throwing `TaskAlreadyTerminalError`
    // lets `pendingOrAuto` short-circuit to a "skipped" tool result
    // without creating a fresh approval row against an already-
    // terminal task.
    if (isTerminalTaskStatus(item.status)) {
      throw new TaskAlreadyTerminalError(taskId, item.status);
    }
    const approval = createAuthorization(state, {
      taskId: item.id,
      action: "file.write",
      target,
      risk: "high",
      reason: reasonOverride ?? "File writes are side effects and require explicit approval.",
      payload: { path: target, content, toolCallId }
    });
    item.approvalIds.push(approval.id);
    item.updatedAt = now();
    appendTrace(config.instance, item.id, {
      type: "approval",
      message: "Approval requested for file write (chat-task)",
      data: { approvalId: approval.id, target, toolCallId }
    });
    return approval.id;
  });
}

// Approval-gated browser_upload_file. Validates the workspace path (and
// its symlink target) before opening the approval row so the user sees a
// real, in-workspace file on the approval card. The actual setInputFiles
// call runs in agent.executeApprovedAction's "browser.upload_file"
// branch, which calls browserUploadFileApproved with the captured ref +
// resolved path.
async function requestBrowserUpload(
  config: RuntimeConfig,
  taskId: string,
  toolCallId: string,
  args: Record<string, unknown>,
  reasonOverride?: string
): Promise<string> {
  const ref = requireString(args, "ref");
  const userPath = requireString(args, "path");
  // resolveUploadPath throws on invalid / outside-workspace / symlink-escape.
  // Let it propagate so the dispatch loop surfaces the error message to the
  // model as a tool error (matching how requestFileWrite handles
  // assertInsideWorkspace failures).
  const resolved = resolveUploadPath(config.workspaceRoot, userPath);
  // Capture the destination URL before the approval is created so the
  // approval card surfaces where the file is about to land. May be null
  // when the agent hasn't opened a browser session yet (no navigation
  // before the upload request) — the approval still works, the UI just
  // can't show a destination.
  const currentUrl = peekCurrentBrowserUrl(taskId) ?? null;
  return mutateState(config.instance, (state: RuntimeState) => {
    const item = findTask(state, taskId);
    if (isTerminalTaskStatus(item.status)) {
      throw new TaskAlreadyTerminalError(taskId, item.status);
    }
    const approval = createAuthorization(state, {
      taskId: item.id,
      action: "browser.upload_file",
      target: resolved.displayPath,
      risk: "high",
      reason: reasonOverride ?? "Uploading a workspace file to a remote site is a side effect and requires explicit approval.",
      payload: {
        ref,
        path: userPath,
        resolvedPath: resolved.absolute,
        currentUrl,
        toolCallId
      }
    });
    item.approvalIds.push(approval.id);
    item.updatedAt = now();
    appendTrace(config.instance, item.id, {
      type: "approval",
      message: "Approval requested for browser upload (chat-task)",
      data: { approvalId: approval.id, target: resolved.displayPath, ref, toolCallId, destination: currentUrl }
    });
    return approval.id;
  });
}

// Approval-gated browser_download. Captures the ref the agent wants to
// click plus the page it is sitting on, so the approval card shows the
// user where the download will come from. The actual click + download
// capture runs in agent.executeApprovedAction's "browser.download"
// branch, which calls browserDownloadApproved with the captured ref.
async function requestBrowserDownload(
  config: RuntimeConfig,
  taskId: string,
  toolCallId: string,
  args: Record<string, unknown>,
  reasonOverride?: string
): Promise<string> {
  const ref = requireString(args, "ref");
  const currentUrl = peekCurrentBrowserUrl(taskId) ?? null;
  return mutateState(config.instance, (state: RuntimeState) => {
    const item = findTask(state, taskId);
    if (isTerminalTaskStatus(item.status)) {
      throw new TaskAlreadyTerminalError(taskId, item.status);
    }
    const approval = createAuthorization(state, {
      taskId: item.id,
      action: "browser.download",
      target: currentUrl ?? ref,
      risk: "high",
      reason: reasonOverride ?? "Downloading a file from a remote site onto this machine is a side effect and requires explicit approval.",
      payload: { ref, currentUrl, toolCallId }
    });
    item.approvalIds.push(approval.id);
    item.updatedAt = now();
    appendTrace(config.instance, item.id, {
      type: "approval",
      message: "Approval requested for browser download (chat-task)",
      data: { approvalId: approval.id, ref, toolCallId, source: currentUrl }
    });
    return approval.id;
  });
}

// At most this many Connect cards per sign-in wall (host) per task. One prompt
// plus a retry is legitimate (mistyped credential, or a genuinely different
// wall on the same host later in the task); beyond that, re-prompting just spams
// identical cards because signing in evidently isn't clearing the wall.
const MAX_CONNECT_CARDS_PER_WALL = 2;

// The page a browser_connect call targets: the explicit `url` arg if the
// model supplied one, else the live page the agent is sitting on. Used both as
// the visible-Chrome landing URL and as the dedupe key for the loop guard, so
// the two always agree on what wall is being cleared.
function resolveConnectUrl(args: Record<string, unknown>, taskId: string): string | undefined {
  const urlArg = typeof args.url === "string" ? args.url.trim() : "";
  return urlArg.length > 0 ? urlArg : peekCurrentBrowserUrl(taskId);
}

// Host of a connect target, used to dedupe repeated Connect cards within a
// task so query/path churn on the same site doesn't read as a new wall.
// Returns "" when no URL resolves (all such calls share one bucket).
function connectWallHost(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

// Approval-gated browser_connect. Mints a `browser.connect` SetupRequest that
// surfaces the in-chat Connect card; on completion the user signs in through a
// screencast of the agent's already-running spawned headless Chrome (no visible
// window is ever opened — issue #420). The reason flows onto the approval row's
// evidence so the UI can render a friendlier label instead of the generic
// terminal-exec card.
async function requestBrowserConnect(
  config: RuntimeConfig,
  taskId: string,
  toolCallId: string,
  args: Record<string, unknown>
): Promise<string> {
  const reason = requireString(args, "reason");
  // Target URL — the page the agent was trying to reach. The screencast binds
  // to the page the agent already drove to, so this rides the payload as a
  // fallback hint and keeps the loop-guard dedupe key consistent with the
  // dispatch. Validated minimally; safetyCheck runs server-side in the
  // open-browser endpoint.
  const url = resolveConnectUrl(args, taskId);
  // Handoff mode is opt-in: only an explicit mode:"handoff" rides the payload
  // (it flips the web card's completion button from "I've signed in" to
  // "I'm done" — ADR browser-connect-handoff.md). Anything else, including
  // the unset default, keeps the payload byte-identical to the sign-in flow.
  const handoff = args.mode === "handoff";
  return mutateState(config.instance, (state: RuntimeState) => {
    const item = findTask(state, taskId);
    if (isTerminalTaskStatus(item.status)) {
      throw new TaskAlreadyTerminalError(taskId, item.status);
    }
    const approval = createSetupRequest(state, {
      taskId: item.id,
      action: "browser.connect",
      // Use the reason as the target so the setup card surfaces
      // it prominently. The web UI also reads evidence.reason for
      // the body when rendering a browser.connect card.
      target: reason,
      reason: "Signing in through the agent's browser requires explicit approval.",
      payload: { reason, toolCallId, url, ...(handoff ? { mode: "handoff" } : {}) }
    });
    item.approvalIds.push(approval.id);
    item.updatedAt = now();
    appendTrace(config.instance, item.id, {
      type: "approval",
      message: "Approval requested for browser connect (chat-task)",
      data: { approvalId: approval.id, reason, toolCallId, url, ...(handoff ? { mode: "handoff" } : {}) }
    });
    return approval.id;
  });
}

async function requestFilePatch(
  config: RuntimeConfig,
  taskId: string,
  toolCallId: string,
  args: Record<string, unknown>,
  reasonOverride?: string
): Promise<string> {
  const target = requireString(args, "path");
  const oldText = requireString(args, "oldText");
  const newText = requireString(args, "newText");
  const path = assertInsideWorkspace(config.workspaceRoot, target);
  if (!existsSync(path)) throw new Error(`Cannot patch missing file: ${target}`);
  const before = readFileSync(path, "utf8");
  if (!before.includes(oldText)) throw new Error(`Patch target text not found in ${target}`);
  const after = before.replace(oldText, newText);
  return mutateState(config.instance, (state: RuntimeState) => {
    const item = findTask(state, taskId);
    if (isTerminalTaskStatus(item.status)) {
      throw new TaskAlreadyTerminalError(taskId, item.status);
    }
    const approval = createAuthorization(state, {
      taskId: item.id,
      action: "file.patch",
      target,
      risk: "high",
      reason: reasonOverride ?? "File patches are side effects and require explicit approval.",
      payload: {
        path: target,
        oldText,
        newText,
        diff: simpleDiff(oldText, newText),
        beforeBytes: before.length,
        afterBytes: after.length,
        toolCallId
      }
    });
    item.approvalIds.push(approval.id);
    item.updatedAt = now();
    appendTrace(config.instance, item.id, {
      type: "approval",
      message: "Approval requested for file patch (chat-task)",
      data: { approvalId: approval.id, target, diff: approval.payload.diff, toolCallId }
    });
    return approval.id;
  });
}

// Approval-gated send_message. Validates the bridge id and message body
// before opening the approval row so the approval card reflects a real
// target. The actual `sendMessagingOutput` call runs in
// `agent.executeApprovedAction`'s `messaging.send` branch.
async function requestSendMessage(
  config: RuntimeConfig,
  taskId: string,
  toolCallId: string,
  args: Record<string, unknown>,
  reasonOverride?: string
): Promise<string> {
  const bridgeId = requireString(args, "bridgeId");
  const text = requireString(args, "text");
  let target: string | undefined;
  if (args.target !== undefined && args.target !== null) {
    if (typeof args.target !== "string" || args.target.length === 0) {
      throw new Error("Invalid input: target must be a non-empty string.");
    }
    target = args.target;
  }
  return mutateState(config.instance, (state: RuntimeState) => {
    const item = findTask(state, taskId);
    if (isTerminalTaskStatus(item.status)) {
      throw new TaskAlreadyTerminalError(taskId, item.status);
    }
    // Resolve the bridge inside the lock so a concurrent disable can't
    // sneak between our validation and the approval write.
    const bridge = state.messagingBridges.find(
      (candidate) => candidate.id === bridgeId || candidate.name === bridgeId
    );
    if (!bridge) throw new Error(`Messaging bridge not found: ${bridgeId}`);
    // Tool-handler gate for the per-bridge target allow-list. The catalog
    // description promises this enforcement ("Optional delivery target
    // (chat id) on the bridge's allow-list"). `sendMessagingOutput` does
    // its own active-agent target filter, but that's a separate envelope
    // (the agent's allowed targets, not the bridge's) — without this
    // check an explicit target the bridge doesn't recognize would land
    // an approval row and surface as a runtime failure post-approval.
    // Keeping the check here makes the failure mode loud at tool-call
    // time so the model can correct itself. When `target` is omitted,
    // sendMessagingOutput falls back to the first allowed target (see
    // `bridge.deliveryTargets[0]`), which is the documented behavior.
    if (target !== undefined && !bridge.deliveryTargets.includes(target)) {
      throw new Error(
        `Invalid input: target '${target}' is not on bridge '${bridge.id}' allow-list (delivery targets: ${bridge.deliveryTargets.join(", ") || "<none>"})`
      );
    }
    const approval = createAuthorization(state, {
      taskId: item.id,
      action: "messaging.send",
      target: bridge.id,
      risk: "high",
      reason: reasonOverride ?? "Outbound messaging egresses data and requires explicit approval.",
      payload: {
        bridgeId: bridge.id,
        text,
        target,
        toolCallId
      }
    });
    item.approvalIds.push(approval.id);
    item.updatedAt = now();
    appendTrace(config.instance, item.id, {
      type: "approval",
      message: "Approval requested for messaging send (chat-task)",
      data: { approvalId: approval.id, bridgeId: bridge.id, target, textBytes: text.length, toolCallId }
    });
    return approval.id;
  });
}

// Create the approval row for a mutate self-config operation. Mirrors
// requestSendMessage: the side effect (running the registry handler) does
// NOT happen here — it runs in agent.executeApprovedAction's "self.config"
// branch once the approval resolves, re-reading {opName, args} from the
// payload. In `auto` mode pendingOrAuto auto-resolves this immediately; in
// `strict` mode the row waits for the operator.
async function requestSelfInvoke(
  config: RuntimeConfig,
  taskId: string,
  toolCallId: string,
  opName: string,
  opArgs: Record<string, unknown>,
  reasonOverride?: string
): Promise<string> {
  return mutateState(config.instance, (state: RuntimeState) => {
    const item = findTask(state, taskId);
    if (isTerminalTaskStatus(item.status)) {
      throw new TaskAlreadyTerminalError(taskId, item.status);
    }
    const approval = createAuthorization(state, {
      taskId: item.id,
      action: "self.config",
      target: opName,
      risk: "medium",
      reason: reasonOverride ?? "Changing Gini's own configuration requires approval.",
      payload: {
        opName,
        args: opArgs,
        toolCallId
      }
    });
    item.approvalIds.push(approval.id);
    item.updatedAt = now();
    appendTrace(config.instance, item.id, {
      type: "approval",
      message: "Approval requested for self-config change (chat-task)",
      data: { approvalId: approval.id, opName, toolCallId }
    });
    return approval.id;
  });
}

// Request that the user connect an external provider. Routed through the
// setup-request state machine so the chat-task loop pauses naturally — the
// task moves to waiting_approval, the chat UI renders a Connect card
// (branched on `action === "connector.request"`), and the loop resumes
// when the user finishes the secret entry via POST /api/setup-requests/<id>/complete.
//
// The side effect happens in the complete endpoint, NOT in
// executeApprovedAction: the endpoint calls createConnector + checkConnector,
// then resolves the setup request. The corresponding executeApprovedAction
// branch is a no-op string that simply tells the model "connected, proceed".
async function requestConnectorTool(
  config: RuntimeConfig,
  taskId: string,
  toolCallId: string,
  args: Record<string, unknown>,
  messageHistory?: readonly unknown[]
): Promise<DispatchResult> {
  const reason = requireString(args, "reason");
  const providerId = optionalString(args, "provider", "");
  const provider = providerId ? getProvider(providerId) : undefined;

  // The contract: the caller supplies EITHER a registered `provider`
  // (template path) OR `{name, type:"api-key"}` (templateless typed credential
  // for a service with no provider module). Templateless is the path when the
  // model passed `type` and there's no registered provider for `provider`.
  // Templateless supports api-key ONLY — an oauth2 credential needs a provider
  // module / setup skill to model its env vars and OAuth flow, so the model
  // can't request one without a registered provider (see
  // docs/adr/chat-credential-provisioning.md).
  const credentialType = optionalString(args, "type", "");
  const templateless = !provider && credentialType === "api-key";

  if (!provider && credentialType === "oauth2") {
    // Recoverable: an oauth2 credential can't be requested templatelessly.
    // The model must go through a provider module / setup skill that knows the
    // service's env vars and OAuth flow.
    return {
      kind: "sync",
      result: JSON.stringify({
        ok: false,
        error: `Templateless request_connector supports type "api-key" only. An oauth2 credential requires a registered provider module (pass its \`provider\` id) or a setup skill that owns the OAuth flow — request_connector cannot mint one for a service with no provider module.`
      })
    };
  }

  if (!provider && !templateless) {
    // Synchronous error so the model can recover. It either picked a bogus
    // provider id, or asked for a templateless credential without a valid
    // `type`. Matches how mcp_call surfaces unknown servers.
    return {
      kind: "sync",
      result: JSON.stringify({
        ok: false,
        error: providerId
          ? `Unknown provider: ${providerId}. For a service with no registered provider, pass {name, type:"api-key"} instead so the user can connect it.`
          : `request_connector needs either a registered \`provider\` id, or \`type:"api-key"\` plus \`name\` for a templateless credential.`
      })
    };
  }

  // Templateless field capture. `name` is the credential name; it IS the env
  // var (templateless is api-key only), so validate it synchronously here
  // (createConnector re-validates server-side) — a recoverable error lets the
  // model fix the name before any card is minted.
  const credentialName = templateless ? optionalString(args, "name", "") : "";
  const credentialLabel = optionalString(args, "label", "");
  const mcpUrl = optionalString(args, "mcpUrl", "");
  const skillId = optionalString(args, "skillId", "");
  if (templateless) {
    if (!credentialName) {
      return {
        kind: "sync",
        result: JSON.stringify({
          ok: false,
          error: `A templateless request needs a \`name\`. It is used as the environment variable, so it must be an uppercase env-var token (e.g. SOME_SERVICE_API_KEY).`
        })
      };
    }
    if (!/^[A-Z][A-Z0-9_]*$/.test(credentialName)) {
      return {
        kind: "sync",
        result: JSON.stringify({
          ok: false,
          error: `Invalid api-key credential name: "${credentialName}". The name is used as the environment variable, so it must match ^[A-Z][A-Z0-9_]*$ (e.g. SOME_SERVICE_API_KEY).`
        })
      };
    }
  }

  // Surface guard — same rationale as requestSkillConnectorGrant /
  // browser_fill_secrets. The Connect card is React UI rendered only in the
  // web chat; a task running over a messaging bridge (Telegram/Discord), in a
  // scheduled/headless job session (origin:"job"), or with no chat session at
  // all would park in waiting_approval with no way to enter the secret. Fail
  // synchronously so the agent can verbalize "open the web chat to enter it".
  const surfaceState = readState(config.instance);
  const surfaceTask = findTask(surfaceState, taskId);
  const surfaceSession = surfaceTask.chatSessionId
    ? surfaceState.chatSessions.find((s) => s.id === surfaceTask.chatSessionId)
    : undefined;
  const surfaceKind = surfaceSession?.source?.kind ?? surfaceSession?.outboundMirror?.kind;
  if (!surfaceSession || surfaceSession.origin === "job") {
    return {
      kind: "sync",
      result: JSON.stringify({
        ok: false,
        error: `Connecting a credential needs the secure Connect card, and that card only renders in a web chat session — this task isn't attached to one (subagent child, scheduled job, or other headless run). Route this through the web chat or settings page.`
      })
    };
  }
  if (isBridgeSurfaceKind(surfaceKind)) {
    return {
      kind: "sync",
      result: JSON.stringify({
        ok: false,
        error: `Connecting a credential needs the secure Connect card, which only works in the web chat (this conversation is over ${surfaceKind}). Reply asking the user to open the web chat to enter it, then continue once they confirm.`
      })
    };
  }

  // The model owns the full user-visible string. The skill body (when one
  // applies) shows the format — the model reads it, substitutes any real
  // values like project IDs, and passes the finished text here. No runtime
  // templating: `reason` becomes the approval's `reason` verbatim.

  // Fast path: if a healthy + configured connector already exists, the model
  // is calling defensively. Tell it to proceed and skip the round-trip through
  // the approval UI. Key on the credential `name` for templateless requests,
  // else on the provider id.
  const state = surfaceState;
  const existing = templateless
    ? state.connectors.find(
        (c) => c.name === credentialName && c.status === "configured" && c.health === "healthy"
      )
    : state.connectors.find(
        (c) => c.provider === providerId && c.status === "configured" && c.health === "healthy"
      );
  if (existing) {
    const label = provider?.label ?? (credentialLabel || credentialName);
    return {
      kind: "sync",
      result: `${label} is already connected. Proceed with the original request.`
    };
  }

  // Setup-skill gate: providers that declare `setupSkill` own a multi-step
  // prerequisite flow (install CLI, OAuth, project provisioning, enable
  // APIs, etc.) before credential capture is meaningful. The model has
  // been observed bypassing the skill and calling request_connector
  // directly with a generic reason, leaving the user without the
  // prerequisites needed to mint credentials. Refuse the call when the
  // task's tool-call history shows no prior `read_skill` for the
  // declared setup skill — the error directs the model there, the
  // skill body itself calls request_connector at the end, and the
  // resumed call passes this same gate naturally because the
  // intervening read_skill is now in the message history.
  //
  // Look in BOTH the in-flight workingMessages (current turn's tool
  // history, only available via the chat-task loop's messageHistory
  // arg) AND the persisted snapshot on task.toolCallState. The
  // snapshot is only written when a task pauses for approval, so the
  // first time the model calls request_connector inside the same turn
  // it just called read_skill, only messageHistory has the evidence.
  if (provider?.setupSkill) {
    const task = state.tasks.find((t) => t.id === taskId);
    const persisted = task?.toolCallState?.messages ?? [];
    const inFlight = messageHistory ?? [];
    const allMessages: readonly unknown[] = [...persisted, ...inFlight];
    const hasReadSetup = allMessages.some((m) => {
      if (!m || typeof m !== "object") return false;
      const msg = m as { role?: unknown; tool_calls?: unknown };
      if (msg.role !== "assistant") return false;
      const calls = msg.tool_calls;
      if (!Array.isArray(calls)) return false;
      return calls.some((c) => {
        if (!c || typeof c !== "object") return false;
        const call = c as { function?: { name?: unknown; arguments?: unknown } };
        const fn = call.function;
        if (!fn || fn.name !== "read_skill") return false;
        try {
          const args = typeof fn.arguments === "string"
            ? JSON.parse(fn.arguments)
            : (fn.arguments ?? {});
          return (args as { name?: unknown })?.name === provider.setupSkill;
        } catch {
          return false;
        }
      });
    });
    if (!hasReadSetup) {
      return {
        kind: "sync",
        result: JSON.stringify({
          ok: false,
          error: `This provider's setup is owned by the '${provider.setupSkill}' skill. Call \`read_skill\` with name '${provider.setupSkill}' first — that skill body walks through the required prerequisites (install, OAuth, project provisioning, APIs) and itself calls request_connector at the end.`
        })
      };
    }
  }

  // Resolve the user-facing target/label. For the known-provider path these
  // come from the module; for a templateless request they come from the
  // model's `name`/`label`. The card detects the templateless case by
  // `credentialType` being present with no registered provider (see
  // BlockSetupRequested / AddConnectorDialog).
  const target = provider?.id ?? credentialName;
  const payloadLabel = provider?.label ?? (credentialLabel || credentialName);
  // When a skill requested this credential, resolve its NAME from state (the
  // model supplies only the id) so the card can render "Grant <credential> to
  // skill <name>" from a server-resolved identity rather than the
  // model-authored reason/title. GUARD: only carry the skillId through when the
  // named skill actually DECLARES the credential this request will mint. The
  // model supplies skillId, so without this check the card could promise "Grant
  // X to skill Y" for a grant /complete will then refuse (Y doesn't declare X) —
  // the consent copy must never advertise a grant that won't happen. When the
  // skill doesn't declare it, drop skillId + credentialSkillName: the credential
  // is still created on completion, just not auto-granted. The /complete
  // declares-credential check remains the authoritative backstop.
  const requestedName = templateless
    ? credentialName
    : (provider ? credentialTemplateForProvider(provider)?.name : undefined);
  const grantSkill = skillId ? state.skills.find((s) => s.id === skillId) : undefined;
  const skillDeclaresCredential = Boolean(
    grantSkill && requestedName && (grantSkill.requiredCredentials ?? []).includes(requestedName)
  );
  const effectiveSkillId = skillDeclaresCredential ? skillId : "";
  const credentialSkillName = skillDeclaresCredential ? grantSkill?.name : undefined;
  const approvalId = await mutateState(config.instance, (mutable: RuntimeState) => {
    const item = findTask(mutable, taskId);
    if (isTerminalTaskStatus(item.status)) {
      throw new TaskAlreadyTerminalError(taskId, item.status);
    }
    const approval = createSetupRequest(mutable, {
      taskId: item.id,
      action: "connector.request",
      target,
      reason,
      payload: {
        // Known-provider fields (undefined for templateless requests).
        provider: provider?.id,
        providerLabel: provider?.label,
        providerDescription: provider?.description,
        fields: provider?.fields,
        // Templateless typed-credential fields (undefined for the
        // known-provider path). credentialType present + no registered
        // provider is how the card detects templateless.
        credentialName: templateless ? credentialName : undefined,
        credentialType: templateless ? credentialType : undefined,
        credentialLabel: templateless ? payloadLabel : undefined,
        mcpUrl: templateless && mcpUrl ? mcpUrl : undefined,
        // Skill to auto-grant on completion (either path). Only stamped when
        // the named skill declares this credential (see guard above), so a
        // promised grant always matches what /complete will perform.
        skillId: effectiveSkillId || undefined,
        // Server-resolved name of that skill, for the card to display.
        credentialSkillName,
        reason,
        toolCallId
      }
    });
    item.approvalIds.push(approval.id);
    item.updatedAt = now();
    // Persist the model's `reason` as a durable assistant bubble in the
    // chat session so it survives past approval resolution. Without this,
    // the bubble exists only while the task is `waiting_approval` (via
    // the synthesizer in getChatSession) and disappears once the user
    // saves the form — leaving no record of the instructions they just
    // acted on. Tag with kind:"approval_reason" so syncChatTaskResult's
    // single-summary-per-task short-circuit doesn't mistake this for the
    // task's final summary.
    if (item.chatSessionId) {
      createChatMessage(mutable, {
        sessionId: item.chatSessionId,
        role: "assistant",
        content: reason,
        taskId: item.id,
        runId: item.runId,
        kind: "approval_reason",
        ...(item.threadId ? { threadId: item.threadId } : {}),
        ...(item.parentBlockId ? { parentBlockId: item.parentBlockId } : {})
      });
    }
    appendTrace(config.instance, item.id, {
      type: "approval",
      message: "Approval requested for connector connect (chat-task)",
      data: { approvalId: approval.id, provider: target, toolCallId }
    });
    return approval.id;
  });
  return { kind: "pending", approvalId };
}

// ask_user tool. Mints a chat.choice SetupRequest whose payload carries the
// question + options; the chat-task loop's pending handler emits a
// setup_requested block and the web chat renders the question as the agent's
// own message with the single-select options beneath (the UI adds its own
// "Other" freeform input and Skip affordance — they are not tool params).
// The tool is options-only: an option-less call gets a graceful error that
// steers the model to ask open-ended questions in plain message text instead
// of parking. POST /api/setup-requests/<id>/complete resumes the loop with
// the user's pick; /cancel (Skip) resumes with a skip fallback instead of
// failing the task. Unlike connector.request, no approval_reason assistant
// bubble is persisted — the question lives in the setup block itself.
// See docs/adr/user-choice-prompt.md.
async function askUserTool(
  config: RuntimeConfig,
  taskId: string,
  toolCallId: string,
  args: Record<string, unknown>
): Promise<DispatchResult> {
  const question = typeof args.question === "string" ? args.question.trim() : "";
  if (!question) {
    return {
      kind: "sync",
      result: JSON.stringify({ ok: false, error: "ask_user needs a non-empty `question` string." })
    };
  }
  // `options` is required: this tool exists only to present a concrete
  // choice. An option-less call is rejected with a steer back to plain
  // message text instead of minting an empty choice card — no park, no
  // SetupRequest. The steer deliberately doesn't promise who replies: in a
  // chat the user's answer arrives as the next message, but a subagent
  // child has no user and its final text bubbles up to the parent instead.
  // Historical option-less rows stay answerable through the existing
  // /complete and message-answer paths; only new mints are gated here.
  const rawOptions = args.options ?? [];
  if (!Array.isArray(rawOptions) || rawOptions.length === 0) {
    return {
      kind: "sync",
      result: JSON.stringify({ ok: false, error: "ask_user only presents choices — `options` (2-6 entries of { label, description? }) is required. For an open-ended question, state the question in your message text instead." })
    };
  }
  if (rawOptions.length < 2 || rawOptions.length > 6) {
    return {
      kind: "sync",
      result: JSON.stringify({ ok: false, error: "ask_user `options` must be an array of 2-6 entries, each { label, description? }." })
    };
  }
  const options: Array<{ label: string; description?: string }> = [];
  for (const entry of rawOptions) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return {
        kind: "sync",
        result: JSON.stringify({ ok: false, error: "Each ask_user option must be an object: { label: string, description?: string }." })
      };
    }
    const candidate = entry as { label?: unknown; description?: unknown };
    const label = typeof candidate.label === "string" ? candidate.label.trim() : "";
    if (!label) {
      return {
        kind: "sync",
        result: JSON.stringify({ ok: false, error: "Each ask_user option needs a non-empty `label` string." })
      };
    }
    if (options.some((o) => o.label === label)) {
      return {
        kind: "sync",
        result: JSON.stringify({ ok: false, error: `Duplicate ask_user option label: "${label}". Labels must be distinct.` })
      };
    }
    const description = typeof candidate.description === "string" && candidate.description.trim().length > 0
      ? candidate.description.trim()
      : undefined;
    options.push({ label, ...(description ? { description } : {}) });
  }

  // Surface guard — same rationale as requestConnectorTool. The choice card
  // is React UI rendered only in the web chat; a task running over a
  // messaging bridge or in a headless container would park on a question
  // with no way to answer. Fail synchronously so the agent asks the
  // question as a regular message instead. Surfaced (non-headless)
  // containers are allowed even when `origin === "job"`: a scheduled run's
  // thread is listable in the web chat, so its question parks as a
  // needs_input the user can answer — only headless containers (a watch
  // job's invisible working thread) can never stall on user input.
  const surfaceState = readState(config.instance);
  const surfaceTask = findTask(surfaceState, taskId);
  const surfaceSession = surfaceTask.chatSessionId
    ? surfaceState.chatSessions.find((s) => s.id === surfaceTask.chatSessionId)
    : undefined;
  const surfaceKind = surfaceSession?.source?.kind ?? surfaceSession?.outboundMirror?.kind;
  if (!surfaceSession || surfaceSession.headless === true || isBridgeSurfaceKind(surfaceKind)) {
    // A subagent child has no chat surface of its own (it runs with no
    // chatSessionId), so the question can't be answered here. Bubble it up:
    // return a STRUCTURED marker the subagent loop carries to its terminal
    // result, and stamp it onto the task so syncSubagentFromTask mirrors it
    // onto the SubagentRecord. The parent's spawn_subagent tool result then
    // surfaces the question, and the parent — which DOES have a topic/chat
    // session — re-asks via its own ask_user. The option labels ride along
    // so the parent can re-ask with the same choices instead of inventing
    // its own. See ADR chat-topics-tasks-subagents.md (the "additional
    // input needed" return).
    if (surfaceTask.subagentId) {
      const optionLabels = options.map((o) => o.label);
      await mutateState(config.instance, (mutable: RuntimeState) => {
        const item = findTask(mutable, taskId);
        item.needsInput = { question, options: optionLabels };
        item.updatedAt = now();
      });
      return {
        kind: "sync",
        result: JSON.stringify({ ok: false, needsInput: true, question, options: optionLabels })
      };
    }
    return {
      kind: "sync",
      result: JSON.stringify({
        ok: false,
        error: "The choice card only renders in a web chat session — this task isn't attached to one. Ask the question as a regular message listing the options and continue from the user's reply."
      })
    };
  }

  const approvalId = await mutateState(config.instance, (mutable: RuntimeState) => {
    const item = findTask(mutable, taskId);
    if (isTerminalTaskStatus(item.status)) {
      throw new TaskAlreadyTerminalError(taskId, item.status);
    }
    const approval = createSetupRequest(mutable, {
      taskId: item.id,
      action: "chat.choice",
      target: question,
      // `reason` is the question so the setup_requested block summary (and
      // transcripts) read as the question itself.
      reason: question,
      payload: { question, options, toolCallId }
    });
    item.approvalIds.push(approval.id);
    item.updatedAt = now();
    appendTrace(config.instance, item.id, {
      type: "approval",
      message: "User choice requested (chat-task)",
      data: { approvalId: approval.id, question, toolCallId }
    });
    return approval.id;
  });
  return { kind: "pending", approvalId };
}

// request_confirmation tool. Mints a confirmation.request SetupRequest whose
// payload carries the summary + optional details + confirm-button label. The
// chat-task loop's pending handler emits a setup_requested block and the web
// chat renders the inline Confirm/Cancel card. POST
// /api/setup-requests/<id>/complete (Confirm) resumes the loop with tool
// result {confirmed:true}; /cancel (Cancel) resumes with {confirmed:false} —
// an unambiguous boolean, not a generic "skipped" string. Modeled on
// askUserTool: same surface guard, no approval_reason bubble (the summary IS
// the card content). Because it is a SetupRequest it pauses the task even
// under approvalMode "yolo" — SetupRequests never call resolveApprovalPolicy.
// See docs/adr/user-confirmation-primitive.md.
async function requestConfirmationTool(
  config: RuntimeConfig,
  taskId: string,
  toolCallId: string,
  args: Record<string, unknown>
): Promise<DispatchResult> {
  const summary = typeof args.summary === "string" ? args.summary.trim() : "";
  if (!summary) {
    return {
      kind: "sync",
      result: JSON.stringify({ ok: false, error: "request_confirmation needs a non-empty `summary` string describing what will happen if confirmed." })
    };
  }
  const details = typeof args.details === "string" && args.details.trim().length > 0
    ? args.details.trim()
    : undefined;
  const confirmLabel = typeof args.confirmLabel === "string" && args.confirmLabel.trim().length > 0
    ? args.confirmLabel.trim()
    : "Confirm";

  // Surface guard — same rationale as askUserTool. The Confirm/Cancel card is
  // React UI rendered only in the web chat; a task running over a messaging
  // bridge or in a headless job session would park in waiting_approval with no
  // way to confirm. Fail synchronously so the agent does NOT proceed with the
  // irreversible action — it should ask for the go-ahead as a regular message
  // instead and continue from the user's reply.
  const surfaceState = readState(config.instance);
  const surfaceTask = findTask(surfaceState, taskId);
  const surfaceSession = surfaceTask.chatSessionId
    ? surfaceState.chatSessions.find((s) => s.id === surfaceTask.chatSessionId)
    : undefined;
  const surfaceKind = surfaceSession?.source?.kind ?? surfaceSession?.outboundMirror?.kind;
  if (!surfaceSession || surfaceSession.origin === "job" || isBridgeSurfaceKind(surfaceKind)) {
    return {
      kind: "sync",
      result: JSON.stringify({
        ok: false,
        error: "The confirmation card only renders in a web chat session — this task isn't attached to one. Do NOT proceed with the irreversible action: ask the user for an explicit go-ahead as a regular message and continue from their reply."
      })
    };
  }

  const approvalId = await mutateState(config.instance, (mutable: RuntimeState) => {
    const item = findTask(mutable, taskId);
    if (isTerminalTaskStatus(item.status)) {
      throw new TaskAlreadyTerminalError(taskId, item.status);
    }
    const approval = createSetupRequest(mutable, {
      taskId: item.id,
      action: "confirmation.request",
      // target = summary so the setup.requested / setup.completed audit rows
      // (and the setup_requested block summary) record WHAT was confirmed. The
      // full `details` the user consents to lives verbatim in payload (durable
      // state), so the consent is auditable end-to-end; a short digest also
      // rides in the trace below.
      target: summary,
      reason: summary,
      payload: { summary, ...(details ? { details } : {}), confirmLabel, toolCallId }
    });
    item.approvalIds.push(approval.id);
    item.updatedAt = now();
    appendTrace(config.instance, item.id, {
      type: "approval",
      message: "User confirmation requested (chat-task)",
      data: {
        approvalId: approval.id,
        summary,
        confirmLabel,
        toolCallId,
        ...(details ? { detailsDigest: details.slice(0, 200) } : {})
      }
    });
    return approval.id;
  });
  return { kind: "pending", approvalId };
}

// Browser-fill-secrets tool. Mints a browser.fill_secret setup request
// whose payload carries the slots the agent wants the user to fill.
// Same chat-block emission path as request_connector — the chat-task
// loop's pending-setup handler emits a setup_requested block
// into the chat stream as soon as this returns { kind: "pending" }.
// The card renders inline. On Submit, the BFF forwards to
// POST /api/setup-requests/<id>/complete, which detects the action and
// runs the playwright-fill branch (see src/http.ts). Values are
// never written to state, audit, or trace payloads.
async function browserFillSecretsTool(
  config: RuntimeConfig,
  taskId: string,
  toolCallId: string,
  args: Record<string, unknown>
): Promise<DispatchResult> {
  // Surface guard: the amber approval card is React UI on the BFF, and
  // the messaging bridge mirrors (telegram-poller, discord-poller,
  // slack-bridge) only
  // relay assistant_text after the task reaches a terminal status.
  // Minting a fill_secret approval would park the task in
  // awaiting_approval, the mirror would skip with
  // reply_skip_non_terminal, and the user on Telegram/Discord would see
  // a typing indicator that eventually stops — no error, no card, no
  // way to submit. Fail the tool synchronously so the agent gets a
  // tool_result it can verbalize back as a plain assistant message
  // ("open the web chat to enter credentials"), which the mirror will
  // relay once the task settles.
  const surfaceState = readState(config.instance);
  const surfaceTask = findTask(surfaceState, taskId);
  const surfaceSession = surfaceTask.chatSessionId
    ? surfaceState.chatSessions.find((s) => s.id === surfaceTask.chatSessionId)
    : undefined;
  // Read both `source` (inbound bridge descriptor on live chat
  // sessions) and `outboundMirror` (bridge descriptor on dedicated
  // job-spawned sessions whose `source` is intentionally undefined
  // so they don't compete for inbound routing — see ChatSessionRecord
  // doc in src/types.ts). A scheduled job spawned from a Telegram
  // chat has source=undefined but outboundMirror.kind="telegram",
  // and submits with mode:"chat" so the full tool catalog is in
  // scope — without checking outboundMirror, the guard would let
  // such a job mint a fill_secret approval that no user can
  // complete (no web card was ever rendered, finalize.ts routes
  // the eventual reply back through outboundMirror to Telegram).
  // Mirror finalize.ts:161's `outboundMirror ?? source` precedent.
  const surfaceKind = surfaceSession?.source?.kind ?? surfaceSession?.outboundMirror?.kind;
  // Chat-card tools also need a live chat session to surface the
  // card. A subagent spawned with mode:"chat" (or any other caller
  // that dispatches tools without binding a chat session) would
  // otherwise mint an approval that emitApprovalRequested then
  // silently skips because resolveEmitContext returns undefined
  // for sessionless tasks (chat-task-emit.ts). Same orphaning
  // happens when chatSessionId is set but the referenced session
  // was deleted — surfaceSession resolves to undefined either way.
  // End result: row in state.approvals + task parked, but no UI
  // card to act on. Refuse up-front on either shape so the model
  // can surface a recoverable tool_result.
  if (!surfaceSession) {
    return {
      kind: "sync",
      result: JSON.stringify({
        ok: false,
        error: "Approval-card tools require a web chat session, and this task isn't attached to one (subagent child, scheduled job, or other headless run). Tell the caller to route this through the parent web chat or settings page."
      })
    };
  }
  if (isBridgeSurfaceKind(surfaceKind)) {
    return {
      kind: "sync",
      result: JSON.stringify({
        ok: false,
        error: `browser_fill_secrets only works in the web chat (this conversation is over ${surfaceKind}). Reply to the user in text asking them to open the web chat to enter their credentials, then continue once they confirm.`
      })
    };
  }

  const slots = parseFillSecretSlots(args.slots);
  if (slots.length === 0) {
    return {
      kind: "sync",
      result: JSON.stringify({
        ok: false,
        error: "browser_fill_secrets requires at least one valid slot (name + locator)."
      })
    };
  }
  // Slot names are the map key the chat card uses for both the React
  // list key and the fillValues record (BlockApprovalRequested.tsx); the
  // /connect handler also looks up secrets by name. Duplicate names
  // would silently share a single user-entered value across multiple
  // distinct DOM locators — picture an agent emitting two "password"
  // slots whose locators target username + password fields — so the
  // user types one value and both inputs receive it. Reject up-front
  // with a clear error.
  const seenNames = new Set<string>();
  const duplicates: string[] = [];
  for (const slot of slots) {
    if (seenNames.has(slot.name)) {
      duplicates.push(slot.name);
    } else {
      seenNames.add(slot.name);
    }
  }
  if (duplicates.length > 0) {
    return {
      kind: "sync",
      result: JSON.stringify({
        ok: false,
        error: `browser_fill_secrets slot names must be unique. Duplicates: ${Array.from(new Set(duplicates)).join(", ")}.`
      })
    };
  }
  const reason = typeof args.reason === "string" && args.reason.trim().length > 0
    ? args.reason.trim()
    : `The agent is asking you to fill ${slots.length} field${slots.length === 1 ? "" : "s"} on the current page.`;

  // Build a stable target string so the approval card can show
  // which page the fill targets. The structural copy of the
  // approved URL lives on `payload.approvedUrl` (see the
  // createSetupRequest call below) — the safety check in
  // src/execution/browser-fill-secrets.ts reads from there, NOT
  // from a parseable substring of target. `target` is the
  // human-readable label that flows into the audit row. Strip
  // query strings and fragments before recording — they
  // frequently carry tokens (OAuth `code`/`state`, password-reset
  // `token`, session ids, magic-link nonces) and the audit
  // writer-boundary only drops `evidence` on redacted:true, leaving
  // `target` intact.
  const liveUrl = peekCurrentBrowserUrl(taskId);
  const approvedUrl = sanitizeUrlForAuditTarget(liveUrl);
  // Refuse dispatch when no live browser session exists. Without a
  // captured origin, the user has no way to consent to a specific
  // page, and the /connect origin guard has nothing to compare
  // against — secrets typed into the chat card would land on
  // whatever page the session points at by /connect time, which
  // may not be the page the agent intended (or the page the user
  // would have approved if they could see it). The agent should
  // browser_navigate to the form's page first, then call
  // browser_fill_secrets with locators from the resulting snapshot.
  if (!approvedUrl) {
    return {
      kind: "sync",
      result: JSON.stringify({
        ok: false,
        error: "browser_fill_secrets requires an active browser session on the page being filled. Call browser_navigate (and browser_snapshot if needed) first, then re-issue this tool with locators from the snapshot."
      })
    };
  }
  const target = approvedUrl;

  const approvalId = await mutateState(config.instance, (mutable: RuntimeState) => {
    const item = findTask(mutable, taskId);
    if (isTerminalTaskStatus(item.status)) {
      throw new TaskAlreadyTerminalError(taskId, item.status);
    }
    const approval = createSetupRequest(mutable, {
      taskId: item.id,
      action: "browser.fill_secret",
      target,
      reason,
      // Structural fields the /connect handler reads:
      //   - slots: which DOM elements to fill (kept; parsed by
      //     parseFillSecretSlots at every consumer).
      //   - approvedUrl: the origin (protocol+host+port) captured
      //     at dispatch time, used as the load-bearing equality
      //     check against the live page URL before any .fill()
      //     runs. Stored structurally (not encoded in target's
      //     substring) so a future tweak to target formatting
      //     can't silently weaken the safety check. Pathname is
      //     stripped by sanitizeUrlForAuditTarget because
      //     reset/magic-link URLs can carry tokens in the path
      //     component.
      //   - toolCallId: the originating tool_call_id the chat-task
      //     loop uses to thread the resume tool result.
      payload: { slots, reason, toolCallId, approvedUrl }
    });
    item.approvalIds.push(approval.id);
    item.updatedAt = now();
    // Mirror the reason into the chat session so it survives past
    // approval resolution, same pattern as requestConnectorTool.
    if (item.chatSessionId) {
      createChatMessage(mutable, {
        sessionId: item.chatSessionId,
        role: "assistant",
        content: reason,
        taskId: item.id,
        runId: item.runId,
        kind: "approval_reason",
        ...(item.threadId ? { threadId: item.threadId } : {}),
        ...(item.parentBlockId ? { parentBlockId: item.parentBlockId } : {})
      });
    }
    appendTrace(config.instance, item.id, {
      type: "approval",
      message: "Approval requested for browser.fill_secret",
      data: { approvalId: approval.id, slotCount: slots.length, toolCallId }
    });
    return approval.id;
  });
  return { kind: "pending", approvalId };
}

// Messaging-bridge add affordance. Mints a `messaging.add_bridge`
// approval whose card surfaces a name input and a password-masked
// bot-token input inside the chat — the same inline-card pattern
// `browser_fill_secrets` and `request_connector` use. On Submit, the
// BFF forwards values to POST /api/approvals/<id>/connect, which
// routes into addMessagingBridge (the same code path the CLI and the
// settings page already call). The bot token never enters the model
// context, audit evidence, or the chat transcript — same hygiene as
// browser.fill_secret.
async function requestMessagingBridgeTool(
  config: RuntimeConfig,
  taskId: string,
  toolCallId: string,
  args: Record<string, unknown>
): Promise<DispatchResult> {
  // Surface guard — same rationale as browser_fill_secrets. The amber
  // card renders only in the web chat; a task running over Telegram
  // or Discord that minted this approval would park in
  // awaiting_approval forever with no submission path. Refuse early
  // so the agent can verbalize "open the web chat to add the bridge"
  // back to the user.
  const surfaceState = readState(config.instance);
  const surfaceTask = findTask(surfaceState, taskId);
  const surfaceSession = surfaceTask.chatSessionId
    ? surfaceState.chatSessions.find((s) => s.id === surfaceTask.chatSessionId)
    : undefined;
  const surfaceKind = surfaceSession?.source?.kind ?? surfaceSession?.outboundMirror?.kind;
  // Chat-card tools also need a live chat session to surface the
  // card. A subagent spawned with mode:"chat" (or any other caller
  // that dispatches tools without binding a chat session) would
  // otherwise mint an approval that emitApprovalRequested then
  // silently skips because resolveEmitContext returns undefined
  // for sessionless tasks (chat-task-emit.ts). Same orphaning
  // happens when chatSessionId is set but the referenced session
  // was deleted — surfaceSession resolves to undefined either way.
  // End result: row in state.approvals + task parked, but no UI
  // card to act on. Refuse up-front on either shape so the model
  // can surface a recoverable tool_result.
  if (!surfaceSession) {
    return {
      kind: "sync",
      result: JSON.stringify({
        ok: false,
        error: "Approval-card tools require a web chat session, and this task isn't attached to one (subagent child, scheduled job, or other headless run). Tell the caller to route this through the parent web chat or settings page."
      })
    };
  }
  if (isBridgeSurfaceKind(surfaceKind)) {
    return {
      kind: "sync",
      result: JSON.stringify({
        ok: false,
        error: `request_messaging_bridge only works in the web chat (this conversation is over ${surfaceKind}). Reply to the user in text asking them to open the web chat to add the bridge there.`
      })
    };
  }

  const rawKind = typeof args.kind === "string" ? args.kind.trim().toLowerCase() : "";
  // The chat card collects only name + bot token; Discord bridges
  // need a deliveryTargets channel-ID list that the card doesn't
  // surface, so an "add a discord bridge from chat" approval would
  // be unactionable (settings dialog + CLI are the only paths that
  // collect channel IDs). The catalog enum restricts kind to
  // "telegram", but the model can violate the schema; refuse here
  // with a clear message that points the user at the right surface
  // so the agent can fall back to plain text instead of minting a
  // dead-end approval card.
  if (rawKind === "discord") {
    return {
      kind: "sync",
      result: JSON.stringify({
        ok: false,
        error: "request_messaging_bridge cannot add a Discord bridge from chat: the card does not collect the required channel-IDs list. Tell the user to open the settings page and click \"Add Discord\" there."
      })
    };
  }
  // Same shape for Slack: the card collects a single bot token, and
  // Slack bridges need TWO credentials (bot token + app-level Socket
  // Mode token), so a chat-created Slack bridge would be unactionable.
  if (rawKind === "slack") {
    return {
      kind: "sync",
      result: JSON.stringify({
        ok: false,
        error: "request_messaging_bridge cannot add a Slack bridge from chat: the card collects a single bot token, and Slack also needs an app-level (xapp-) Socket Mode token. Tell the user to open the settings page and click \"Add Slack\" there."
      })
    };
  }
  if (rawKind !== "telegram") {
    return {
      kind: "sync",
      result: JSON.stringify({
        ok: false,
        error: `request_messaging_bridge requires kind: "telegram" (got ${JSON.stringify(args.kind)}).`
      })
    };
  }
  const kind = "telegram" as const;
  const kindLabel = "Telegram";
  const suggestedName = typeof args.suggestedName === "string" && args.suggestedName.trim().length > 0
    ? args.suggestedName.trim()
    : `my-${kind}-bot`;
  const reason = typeof args.reason === "string" && args.reason.trim().length > 0
    ? args.reason.trim()
    : `Add a ${kindLabel} bridge so this agent can talk to you on ${kindLabel}.`;

  const approvalId = await mutateState(config.instance, (mutable: RuntimeState) => {
    const item = findTask(mutable, taskId);
    if (isTerminalTaskStatus(item.status)) {
      throw new TaskAlreadyTerminalError(taskId, item.status);
    }
    const approval = createSetupRequest(mutable, {
      taskId: item.id,
      action: "messaging.add_bridge",
      target: kind,
      reason,
      // Structural payload fields the /connect handler reads:
      //   - kind: telegram | discord, drives the addMessagingBridge
      //     branch + the per-kind help text under the form.
      //   - suggestedName: prefilled value for the name input; the
      //     user can change it before submitting.
      //   - toolCallId: links the resume tool result back to the
      //     originating tool_call in the chat-task loop.
      payload: { kind, suggestedName, reason, toolCallId }
    });
    item.approvalIds.push(approval.id);
    item.updatedAt = now();
    // Mirror the reason into the chat session so it survives past
    // approval resolution — same pattern as requestConnectorTool /
    // browserFillSecretsTool.
    if (item.chatSessionId) {
      createChatMessage(mutable, {
        sessionId: item.chatSessionId,
        role: "assistant",
        content: reason,
        taskId: item.id,
        runId: item.runId,
        kind: "approval_reason",
        ...(item.threadId ? { threadId: item.threadId } : {}),
        ...(item.parentBlockId ? { parentBlockId: item.parentBlockId } : {})
      });
    }
    appendTrace(config.instance, item.id, {
      type: "approval",
      message: "Approval requested for messaging.add_bridge",
      data: { approvalId: approval.id, kind, toolCallId }
    });
    return approval.id;
  });
  return { kind: "pending", approvalId };
}

// Read-only inventory of configured messaging bridges. Returns the
// minimum every caller needs (id, name, kind, status, bot username
// from metadata) so the agent can answer "what bridges do I have?"
// or pick the right id for a follow-up request_remove_messaging_bridge
// without leaking the encrypted secret refs / per-chat allowlists.
async function listMessagingBridgesTool(config: RuntimeConfig): Promise<string> {
  const state = readState(config.instance);
  const bridges = state.messagingBridges.map((bridge) => {
    const meta = (bridge.metadata ?? {}) as { botUsername?: unknown };
    const botUsername = typeof meta.botUsername === "string" ? meta.botUsername : undefined;
    return {
      id: bridge.id,
      name: bridge.name,
      kind: bridge.kind,
      status: bridge.status,
      message: bridge.message ?? null,
      botUsername: botUsername ?? null,
      createdAt: bridge.createdAt,
      updatedAt: bridge.updatedAt
    };
  });
  return JSON.stringify({ ok: true, bridges });
}

// Read-only view of a Telegram bridge's pending pairing requests +
// current allowlist. Mirrors the data MessagingCard's
// TelegramPendingRequests component polls so the agent sees what
// the operator would see in settings. Returns ok:false (string
// envelope, not throw) on unknown bridges or non-telegram kinds so
// the model gets a recoverable tool result instead of a hard error.
async function listMessagingPairingsTool(
  config: RuntimeConfig,
  args: Record<string, unknown>
): Promise<string> {
  const bridge = typeof args.bridge === "string" ? args.bridge.trim() : "";
  if (!bridge) {
    return JSON.stringify({ ok: false, error: "list_messaging_pairings requires a 'bridge' (id or name)." });
  }
  try {
    const view = listAllowedChats(config, bridge);
    // Redact verificationCode + verificationCodeExpiresAt from the
    // tool envelope. The code is a security-critical token whose
    // entire purpose is preventing TOFU enrollment race attacks
    // (see messaging.ts `DeniedChatAttempt`); a prompt-injected
    // agent that could read it would be able to scrape live codes
    // and race the legitimate user. The model doesn't need the
    // code to pair: request_messaging_pairing's dispatcher reads
    // the same listAllowedChats view server-side when minting the
    // approval, and the operator confirms the code by eye against
    // what the bot DM'd them. The settings UI still gets the full
    // view via its own /api/messaging/* path; only the model-
    // facing tool envelope is redacted.
    const safeRecentDeniedChats = view.recentDeniedChats.map((entry) => ({
      chatId: entry.chatId,
      chatType: entry.chatType,
      sender: entry.sender,
      lastAttemptAt: entry.lastAttemptAt
    }));
    return JSON.stringify({
      ok: true,
      bridge,
      allowedChatIds: view.allowedChatIds,
      ownerChatId: view.ownerChatId,
      recentDeniedChats: safeRecentDeniedChats
    });
  } catch (error) {
    return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

// Pairing-approval affordance. Mints a messaging.approve_pairing
// approval whose payload carries everything the chat card needs to
// render the confirmation (bridge id+name+botUsername, chat id+type,
// sender, verification code + expiry). Approve / Reject both flow
// through /api/approvals/<id>/connect (Reject just sends
// `{ reject: true }`); /approve refuses this action.
//
// The dispatcher reads the pending row up-front and refuses if the
// chat is already enrolled, no longer pending, or the code has
// expired — gives the agent a recoverable tool_result instead of
// minting a card the operator can't act on.

// Shape of a pending recentDeniedChats entry that both
// requestMessagingPairingTool and waitForMessagingPairTool consume
// when minting a messaging.approve_pairing approval. Fields match
// what BlockApprovalRequested.tsx pulls off the payload.
interface PendingPairForApproval {
  chatId: number;
  chatType?: string;
  sender?: string;
  verificationCode?: string;
  verificationCodeExpiresAt?: string;
}

// Single source of truth for messaging.approve_pairing approval
// minting. Both the explicit-request tool (requestMessagingPairingTool)
// and the wait-loop tool (waitForMessagingPairTool) build the same
// approval shape, including the chat-task plumbing (approvalIds.push,
// approval_reason chat message, appendTrace). Centralizing it keeps
// the two call sites from drifting when the card grows a new payload
// field — adding the field here propagates to both.
async function mintPairingApproval(
  config: RuntimeConfig,
  taskId: string,
  toolCallId: string,
  bridge: { id: string; name: string; metadata?: Record<string, unknown> },
  pending: PendingPairForApproval,
  reasonOverride?: string
): Promise<string> {
  const reason = reasonOverride
    ?? `Confirm the verification code below matches what you received on Telegram before approving chat ${pending.chatId}.`;
  const meta = (bridge.metadata ?? {}) as { botUsername?: unknown };
  const botUsername = typeof meta.botUsername === "string" ? meta.botUsername : undefined;
  return mutateState(config.instance, (mutable: RuntimeState) => {
    const item = findTask(mutable, taskId);
    if (isTerminalTaskStatus(item.status)) {
      throw new TaskAlreadyTerminalError(taskId, item.status);
    }
    const approval = createSetupRequest(mutable, {
      taskId: item.id,
      action: "messaging.approve_pairing",
      target: `${bridge.id}:${pending.chatId}`,
      reason,
      payload: {
        bridgeId: bridge.id,
        bridgeName: bridge.name,
        botUsername: botUsername ?? null,
        chatId: pending.chatId,
        chatType: pending.chatType ?? "private",
        sender: pending.sender ?? null,
        verificationCode: pending.verificationCode ?? null,
        verificationCodeExpiresAt: pending.verificationCodeExpiresAt ?? null,
        toolCallId
      }
    });
    item.approvalIds.push(approval.id);
    item.updatedAt = now();
    if (item.chatSessionId) {
      createChatMessage(mutable, {
        sessionId: item.chatSessionId,
        role: "assistant",
        content: reason,
        taskId: item.id,
        runId: item.runId,
        kind: "approval_reason",
        ...(item.threadId ? { threadId: item.threadId } : {}),
        ...(item.parentBlockId ? { parentBlockId: item.parentBlockId } : {})
      });
    }
    appendTrace(config.instance, item.id, {
      type: "approval",
      message: "Approval requested for messaging.approve_pairing",
      data: { approvalId: approval.id, bridgeId: bridge.id, chatId: pending.chatId, toolCallId }
    });
    return approval.id;
  });
}

async function requestMessagingPairingTool(
  config: RuntimeConfig,
  taskId: string,
  toolCallId: string,
  args: Record<string, unknown>
): Promise<DispatchResult> {
  // Surface guard — same rationale as requestMessagingBridgeTool /
  // browserFillSecretsTool. The approval card renders only in the
  // web chat; a task spawned from a Telegram (or Discord) bridge
  // that minted this approval would park in awaiting_approval
  // forever, and the telegram-poller would skip relay via
  // reply_skip_non_terminal. Refuse early so the agent can fall
  // back to plain text ("open the web chat to approve the pairing").
  const surfaceState = readState(config.instance);
  const surfaceTask = findTask(surfaceState, taskId);
  const surfaceSession = surfaceTask.chatSessionId
    ? surfaceState.chatSessions.find((s) => s.id === surfaceTask.chatSessionId)
    : undefined;
  const surfaceKind = surfaceSession?.source?.kind ?? surfaceSession?.outboundMirror?.kind;
  // Chat-card tools also need a live chat session to surface the
  // card. A subagent spawned with mode:"chat" (or any other caller
  // that dispatches tools without binding a chat session) would
  // otherwise mint an approval that emitApprovalRequested then
  // silently skips because resolveEmitContext returns undefined
  // for sessionless tasks (chat-task-emit.ts). Same orphaning
  // happens when chatSessionId is set but the referenced session
  // was deleted — surfaceSession resolves to undefined either way.
  // End result: row in state.approvals + task parked, but no UI
  // card to act on. Refuse up-front on either shape so the model
  // can surface a recoverable tool_result.
  if (!surfaceSession) {
    return {
      kind: "sync",
      result: JSON.stringify({
        ok: false,
        error: "Approval-card tools require a web chat session, and this task isn't attached to one (subagent child, scheduled job, or other headless run). Tell the caller to route this through the parent web chat or settings page."
      })
    };
  }
  if (isBridgeSurfaceKind(surfaceKind)) {
    return {
      kind: "sync",
      result: JSON.stringify({
        ok: false,
        error: `request_messaging_pairing only works in the web chat (this conversation is over ${surfaceKind}). Tell the user to open the web chat to approve the pairing.`
      })
    };
  }

  const bridgeIdOrName = typeof args.bridge === "string" ? args.bridge.trim() : "";
  if (!bridgeIdOrName) {
    return {
      kind: "sync",
      result: JSON.stringify({ ok: false, error: "request_messaging_pairing requires a 'bridge' (id or name)." })
    };
  }
  const chatIdRaw = args.chatId;
  const chatId = typeof chatIdRaw === "number" ? chatIdRaw : Number(chatIdRaw);
  if (!Number.isFinite(chatId)) {
    return {
      kind: "sync",
      result: JSON.stringify({ ok: false, error: `request_messaging_pairing requires a numeric 'chatId' (got ${JSON.stringify(args.chatId)}).` })
    };
  }
  const state = readState(config.instance);
  const bridge = state.messagingBridges.find((b) => b.id === bridgeIdOrName || b.name === bridgeIdOrName);
  if (!bridge) {
    return {
      kind: "sync",
      result: JSON.stringify({ ok: false, error: `Messaging bridge not found: ${bridgeIdOrName}.` })
    };
  }
  if (bridge.kind !== "telegram") {
    return {
      kind: "sync",
      result: JSON.stringify({ ok: false, error: `Pairing approvals only apply to telegram bridges (got '${bridge.kind}').` })
    };
  }
  const view = listAllowedChats(config, bridge.id);
  if (view.allowedChatIds.includes(chatId)) {
    return {
      kind: "sync",
      result: JSON.stringify({
        ok: false,
        error: `Chat ${chatId} is already enrolled on bridge '${bridge.name}'. No pairing card needed.`
      })
    };
  }
  const pending = view.recentDeniedChats.find((entry) => entry.chatId === chatId);
  if (!pending) {
    return {
      kind: "sync",
      result: JSON.stringify({
        ok: false,
        error: `No pending pairing request for chat ${chatId} on bridge '${bridge.name}'. Have the user DM the bot to mint a fresh request.`
      })
    };
  }
  if (pending.verificationCodeExpiresAt) {
    const expiresAt = Date.parse(pending.verificationCodeExpiresAt);
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
      return {
        kind: "sync",
        result: JSON.stringify({
          ok: false,
          error: `Verification code for chat ${chatId} expired. Tell the user to DM the bot again to mint a fresh code.`
        })
      };
    }
  }
  // Group chats deliberately have no verification code (the bot can't
  // DM a per-user code through a group), and the chat-card approve
  // path requires one for the verification handshake. messaging-
  // pairing-connect.ts refuses code-less approves, so without this
  // up-front check the agent would mint a card whose Approve button
  // bounces — only Reject would work and the card would sit there
  // until the operator gave up. Refuse the mint instead so the
  // agent surfaces the right next step to the user (settings page
  // or `gini messaging allow`).
  if (!pending.verificationCode) {
    return {
      kind: "sync",
      result: JSON.stringify({
        ok: false,
        error: `Chat ${chatId} on bridge '${bridge.name}' has no verification code (likely a group chat). Group enrollments don't go through the chat-card handshake — tell the user to open the settings page (or run \`gini messaging allow ${bridge.name} ${chatId}\`) to approve.`
      })
    };
  }

  const reasonOverride = typeof args.reason === "string" && args.reason.trim().length > 0
    ? args.reason.trim()
    : undefined;
  const approvalId = await mintPairingApproval(
    config,
    taskId,
    toolCallId,
    bridge,
    { ...pending, chatId },
    reasonOverride
  );
  return { kind: "pending", approvalId };
}

// Server-side blocking tool the agent calls right after a
// successful request_messaging_bridge. Polls the bridge's
// recentDeniedChats every second for up to `timeoutSeconds`; the
// moment a fresh pending row shows up, mints a
// messaging.approve_pairing approval bound to the agent's task and
// returns {kind:"pending", approvalId} so the chat-task loop pauses
// on the approval card. Lets the agent stay engaged with the user
// through the bridge-add → user-DMs-bot → operator-approves dance
// without returning control and asking the user to come back.
//
// Exit paths:
//   - Pending row arrives → mint approval → pending DispatchResult
//   - Task cancelled mid-wait → sync ok:false with "cancelled"
//   - Timeout → sync ok:false with "timeout" so the agent can
//     surface the option to keep waiting or skip
//
// Reuses the same surface guard as the other request_ tools: a
// Telegram/Discord-sourced chat can't surface an approval the
// remote user can't act on.
async function waitForMessagingPairTool(
  config: RuntimeConfig,
  taskId: string,
  toolCallId: string,
  args: Record<string, unknown>
): Promise<DispatchResult> {
  // Surface guard.
  const surfaceState = readState(config.instance);
  const surfaceTask = findTask(surfaceState, taskId);
  const surfaceSession = surfaceTask.chatSessionId
    ? surfaceState.chatSessions.find((s) => s.id === surfaceTask.chatSessionId)
    : undefined;
  const surfaceKind = surfaceSession?.source?.kind ?? surfaceSession?.outboundMirror?.kind;
  // Chat-card tools also need a live chat session to surface the
  // card. A subagent spawned with mode:"chat" (or any other caller
  // that dispatches tools without binding a chat session) would
  // otherwise mint an approval that emitApprovalRequested then
  // silently skips because resolveEmitContext returns undefined
  // for sessionless tasks (chat-task-emit.ts). Same orphaning
  // happens when chatSessionId is set but the referenced session
  // was deleted — surfaceSession resolves to undefined either way.
  // End result: row in state.approvals + task parked, but no UI
  // card to act on. Refuse up-front on either shape so the model
  // can surface a recoverable tool_result.
  if (!surfaceSession) {
    return {
      kind: "sync",
      result: JSON.stringify({
        ok: false,
        error: "Approval-card tools require a web chat session, and this task isn't attached to one (subagent child, scheduled job, or other headless run). Tell the caller to route this through the parent web chat or settings page."
      })
    };
  }
  if (isBridgeSurfaceKind(surfaceKind)) {
    return {
      kind: "sync",
      result: JSON.stringify({
        ok: false,
        error: `wait_for_messaging_pair only works in the web chat (this conversation is over ${surfaceKind}).`
      })
    };
  }

  const bridgeIdOrName = typeof args.bridge === "string" ? args.bridge.trim() : "";
  if (!bridgeIdOrName) {
    return {
      kind: "sync",
      result: JSON.stringify({ ok: false, error: "wait_for_messaging_pair requires a 'bridge' (id or name)." })
    };
  }
  const requestedTimeoutSeconds = typeof args.timeoutSeconds === "number" && Number.isFinite(args.timeoutSeconds)
    ? args.timeoutSeconds
    : 600;
  // Clamp to a sane window. The lower bound keeps a too-short
  // call from racing the poll interval; the upper bound caps how
  // long we tie up the chat-task awaiting an external event.
  const timeoutSeconds = Math.max(10, Math.min(1800, Math.round(requestedTimeoutSeconds)));
  const deadlineMs = Date.now() + timeoutSeconds * 1000;
  // Server-side env override so tests don't wait full poll ticks. Production
  // leaves it unset and gets the 1000ms default (Number(undefined)/0/NaN all
  // fall through the `||`).
  const POLL_INTERVAL_MS = Number(process.env.GINI_PAIR_POLL_MS) || 1000;

  // Validate bridge existence + kind up-front so we don't burn
  // the timeout on a typo'd name. The wait predicate itself
  // re-reads state every tick, so no snapshot is held here:
  // surfacing a pending row that arrived BEFORE the wait started
  // is still legitimate (the operator hasn't acted on it yet),
  // and approved rows are removed from recentDeniedChats so they
  // can't loop back. The previous snapshot-diff predicate raced
  // with the natural "user DMs the bot between bridge create and
  // wait_for_messaging_pair start" window — pre-existing rows
  // were filtered out as not-new even though they represented the
  // exact unresolved pair the agent was waiting for.
  const initialBridge = readState(config.instance).messagingBridges.find(
    (b) => b.id === bridgeIdOrName || b.name === bridgeIdOrName
  );
  if (!initialBridge) {
    return {
      kind: "sync",
      result: JSON.stringify({ ok: false, error: `Messaging bridge not found: ${bridgeIdOrName}.` })
    };
  }
  if (initialBridge.kind !== "telegram") {
    return {
      kind: "sync",
      result: JSON.stringify({ ok: false, error: `wait_for_messaging_pair only applies to telegram bridges (got '${initialBridge.kind}').` })
    };
  }
  // Snapshot the allowlist at wait start so we can detect a chat
  // getting enrolled out-of-band (settings page click, CLI
  // `gini messaging allow`, or another agent's parallel
  // request_messaging_pairing) WHILE this wait is running. allowChat
  // both removes the pending row AND adds chatId to allowedChatIds,
  // so the pending-row predicate alone can't tell us "someone else
  // approved it" from "no one has DM'd yet" — both look like
  // "nothing to surface." Without this snapshot, the agent would
  // time out and tell the user "DM the bot again" even though they
  // were already enrolled.
  const initialAllowedSnapshot = new Set<number>(
    Array.isArray((initialBridge.metadata ?? {} as Record<string, unknown>).allowedChatIds)
      ? ((initialBridge.metadata ?? {}).allowedChatIds as unknown[]).map((v) => Number(v)).filter((n) => Number.isFinite(n))
      : []
  );

  // Set a runningHint on this tool_call block so the chat UI upgrades
  // the row from the 14px inline spinner to an amber waiting-card —
  // a long, externally-gated wait (up to 600s waiting on an inbound
  // Telegram DM) needs visual weight proportional to its duration and a
  // cancel affordance co-located with the state. The hint folds the
  // bot's @username into the card body so the operator doesn't have to
  // scan a separate system_note for context.
  //
  // Resolve the bot's @username. addMessagingBridge skips getMe —
  // botUsername is populated by checkMessagingBridge — so a freshly-
  // added bridge has empty metadata here. Run the probe once when
  // missing; the merged write benefits later consumers (pairing card,
  // operator UI) too. Best-effort: a failed probe falls back to the
  // bridge name, which still uniquely identifies the bot the user
  // just configured.
  const readBotUsername = (bridge: typeof initialBridge): string | undefined => {
    const meta = (bridge.metadata ?? {}) as { botUsername?: unknown };
    return typeof meta.botUsername === "string" ? meta.botUsername : undefined;
  };
  let botUsernameForGuidance = readBotUsername(initialBridge);
  // Only probe when the bridge has an attached secret ref — without
  // a token, checkMessagingBridge flips status to "error" with a
  // "token missing" message, which the in-loop guard at "liveBridge.status
  // !== 'configured'" treats as a bridge that can't receive messages.
  // Production bridges always have a token because addMessagingBridge
  // requires one for telegram; tests that construct bridges via
  // createMessagingBridgeRecord directly skip this check by leaving
  // secretRefs empty.
  const hasSecret = (initialBridge.secretRefs ?? []).length > 0;
  if (!botUsernameForGuidance && initialBridge.kind === "telegram" && hasSecret) {
    try {
      const refreshed = await checkMessagingBridge(config, initialBridge.id);
      botUsernameForGuidance = readBotUsername(refreshed);
    } catch {
      // Probe failed; fall through to bridge-name fallback.
    }
  }
  const guidanceText = botUsernameForGuidance
    ? `Open Telegram and start a chat with @${botUsernameForGuidance}: tap Start (or send /start), then send any message. The approval card will appear here as soon as your DM lands.`
    : `Open Telegram and start a chat with the bot '${initialBridge.name}': tap Start (or send /start), then send any message. The approval card will appear here as soon as your DM lands.`;
  const guidanceCtx = resolveEmitContext(config, taskId);
  if (guidanceCtx) setToolCallRunningHint(guidanceCtx, toolCallId, guidanceText);

  const reasonText = typeof args.reason === "string" && args.reason.trim().length > 0
    ? args.reason.trim()
    : undefined;

  // Poll loop. readState is in-process cached, so this is cheap.
  while (Date.now() < deadlineMs) {
    const liveState = readState(config.instance);

    // Abort if the task itself was cancelled mid-wait.
    const liveTask = liveState.tasks.find((t) => t.id === taskId);
    if (liveTask && isTerminalTaskStatus(liveTask.status)) {
      return {
        kind: "sync",
        result: JSON.stringify({
          ok: false,
          error: "wait_for_messaging_pair aborted: task was cancelled."
        })
      };
    }

    const liveBridge = liveState.messagingBridges.find(
      (b) => b.id === bridgeIdOrName || b.name === bridgeIdOrName
    );
    if (!liveBridge) {
      return {
        kind: "sync",
        result: JSON.stringify({ ok: false, error: `Messaging bridge no longer exists: ${bridgeIdOrName}.` })
      };
    }
    // Bridge can flip to "disabled" or "error" while the wait is
    // polling — operator clicked Disable in settings, the bot
    // token rotated and the health check failed, etc. Without this
    // exit the wait would tell the user to DM a bot that won't
    // receive their message, and time out 10 minutes later. Return
    // a sync failure so the agent can tell the user what actually
    // changed.
    if (liveBridge.status !== "configured") {
      return {
        kind: "sync",
        result: JSON.stringify({
          ok: false,
          error: `Messaging bridge '${liveBridge.name}' is no longer in 'configured' status (now '${liveBridge.status}')${liveBridge.message ? `: ${liveBridge.message}` : ""}. Stop telling the user to DM the bot — the bridge can't receive messages until it's re-enabled.`
        })
      };
    }
    const liveMeta = (liveBridge.metadata ?? {}) as {
      allowedChatIds?: unknown;
      recentDeniedChats?: Array<{
        chatId: number;
        chatType?: string;
        sender?: string;
        verificationCode?: string;
        verificationCodeExpiresAt?: string;
      }>;
    };
    const livePending = liveMeta.recentDeniedChats ?? [];
    const allowedSet = new Set<number>(
      Array.isArray(liveMeta.allowedChatIds)
        ? liveMeta.allowedChatIds.map((v) => Number(v)).filter((n) => Number.isFinite(n))
        : []
    );

    // Out-of-band enrollment detection: any chat in the current
    // allowlist that wasn't there at wait start is a fresh
    // approval landed via settings / CLI / a parallel agent flow.
    // Return success so the agent can tell the user "the chat is
    // enrolled, you can DM the bot now" instead of timing out.
    const freshlyEnrolled: number[] = [];
    for (const chatId of allowedSet) {
      if (!initialAllowedSnapshot.has(chatId)) freshlyEnrolled.push(chatId);
    }
    if (freshlyEnrolled.length > 0) {
      return {
        kind: "sync",
        result: JSON.stringify({
          ok: true,
          outOfBand: true,
          enrolledChatIds: freshlyEnrolled,
          message: `Chat ${freshlyEnrolled.join(", ")} got enrolled on bridge '${liveBridge.name}' out-of-band (settings page, CLI, or a parallel agent flow) while waiting. The user can DM the bot now.`
        })
      };
    }

    // Surface the first pending row that the operator can act on:
    // (a) has a verification code (groups never mint a code and
    // are not approvable via the chat-card handshake — they go
    // through the settings page / CLI), (b) isn't already enrolled
    // on the bridge's allowlist (defensive; allowChat clears
    // recentDeniedChats on enroll), and (c) the code hasn't
    // expired. Without (c), an operator who left the chat tab
    // open across the 10-minute code TTL would be presented an
    // approval card whose Approve action would fail at allowChat's
    // expired-code throw. Mirrors the expiry guard inside
    // requestMessagingPairingTool.
    const nowMs = Date.now();
    const newOrRotated = livePending.find((entry) => {
      if (!entry.verificationCode) return false;
      if (allowedSet.has(entry.chatId)) return false;
      if (entry.verificationCodeExpiresAt) {
        const expiresAt = Date.parse(entry.verificationCodeExpiresAt);
        if (Number.isFinite(expiresAt) && expiresAt <= nowMs) return false;
      }
      return true;
    });

    if (newOrRotated && newOrRotated.verificationCode) {
      // Delegate to the shared mintPairingApproval helper so the
      // payload shape stays in lockstep with requestMessagingPairingTool.
      // The helper writes its own "Approval requested" trace; add a
      // wait-variant trace afterward so an operator inspecting the
      // task log can tell the card came from the polling loop instead
      // of an explicit request_messaging_pairing call.
      const approvalId = await mintPairingApproval(
        config,
        taskId,
        toolCallId,
        liveBridge,
        newOrRotated,
        reasonText
      );
      appendTrace(config.instance, taskId, {
        type: "approval",
        message: "Approval requested for messaging.approve_pairing (wait_for_messaging_pair)",
        data: { approvalId, bridgeId: liveBridge.id, chatId: newOrRotated.chatId, toolCallId }
      });
      return { kind: "pending", approvalId };
    }

    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  return {
    kind: "sync",
    result: JSON.stringify({
      ok: false,
      error: `wait_for_messaging_pair timed out after ${timeoutSeconds}s with no inbound pair on bridge '${initialBridge.name}'. The user can DM the bot again — call wait_for_messaging_pair to retry, or move on if they're not pairing right now.`
    })
  };
}

// Bridge-removal affordance. Mints a messaging.remove_bridge
// approval whose card asks the operator to confirm tearing down a
// configured bridge from chat. Approve POSTs `{}` to /connect; the
// runtime calls removeMessagingBridge (same path as the CLI / the
// settings page's Remove button). Tasks see the resume tool result
// once removal completes.
async function requestRemoveMessagingBridgeTool(
  config: RuntimeConfig,
  taskId: string,
  toolCallId: string,
  args: Record<string, unknown>
): Promise<DispatchResult> {
  // Surface guard — same rationale as the other request_ tools.
  // The destructive confirmation card renders only in the web chat;
  // a task spawned from a Telegram (or Discord) bridge that minted
  // this approval would park in awaiting_approval forever.
  const surfaceState = readState(config.instance);
  const surfaceTask = findTask(surfaceState, taskId);
  const surfaceSession = surfaceTask.chatSessionId
    ? surfaceState.chatSessions.find((s) => s.id === surfaceTask.chatSessionId)
    : undefined;
  const surfaceKind = surfaceSession?.source?.kind ?? surfaceSession?.outboundMirror?.kind;
  // Chat-card tools also need a live chat session to surface the
  // card. A subagent spawned with mode:"chat" (or any other caller
  // that dispatches tools without binding a chat session) would
  // otherwise mint an approval that emitApprovalRequested then
  // silently skips because resolveEmitContext returns undefined
  // for sessionless tasks (chat-task-emit.ts). Same orphaning
  // happens when chatSessionId is set but the referenced session
  // was deleted — surfaceSession resolves to undefined either way.
  // End result: row in state.approvals + task parked, but no UI
  // card to act on. Refuse up-front on either shape so the model
  // can surface a recoverable tool_result.
  if (!surfaceSession) {
    return {
      kind: "sync",
      result: JSON.stringify({
        ok: false,
        error: "Approval-card tools require a web chat session, and this task isn't attached to one (subagent child, scheduled job, or other headless run). Tell the caller to route this through the parent web chat or settings page."
      })
    };
  }
  if (isBridgeSurfaceKind(surfaceKind)) {
    return {
      kind: "sync",
      result: JSON.stringify({
        ok: false,
        error: `request_remove_messaging_bridge only works in the web chat (this conversation is over ${surfaceKind}). Tell the user to open the web chat to confirm bridge removal.`
      })
    };
  }

  const bridgeIdOrName = typeof args.bridge === "string" ? args.bridge.trim() : "";
  if (!bridgeIdOrName) {
    return {
      kind: "sync",
      result: JSON.stringify({ ok: false, error: "request_remove_messaging_bridge requires a 'bridge' (id or name)." })
    };
  }
  const state = readState(config.instance);
  const bridge = state.messagingBridges.find((b) => b.id === bridgeIdOrName || b.name === bridgeIdOrName);
  if (!bridge) {
    return {
      kind: "sync",
      result: JSON.stringify({ ok: false, error: `Messaging bridge not found: ${bridgeIdOrName}.` })
    };
  }
  const reason = typeof args.reason === "string" && args.reason.trim().length > 0
    ? args.reason.trim()
    : `Remove the ${bridge.kind} bridge '${bridge.name}'? This deletes its bot token; past messages stay in history.`;

  const approvalId = await mutateState(config.instance, (mutable: RuntimeState) => {
    const item = findTask(mutable, taskId);
    if (isTerminalTaskStatus(item.status)) {
      throw new TaskAlreadyTerminalError(taskId, item.status);
    }
    const approval = createSetupRequest(mutable, {
      taskId: item.id,
      action: "messaging.remove_bridge",
      target: bridge.id,
      reason,
      payload: {
        bridgeId: bridge.id,
        bridgeName: bridge.name,
        kind: bridge.kind,
        toolCallId
      }
    });
    item.approvalIds.push(approval.id);
    item.updatedAt = now();
    if (item.chatSessionId) {
      createChatMessage(mutable, {
        sessionId: item.chatSessionId,
        role: "assistant",
        content: reason,
        taskId: item.id,
        runId: item.runId,
        kind: "approval_reason",
        ...(item.threadId ? { threadId: item.threadId } : {}),
        ...(item.parentBlockId ? { parentBlockId: item.parentBlockId } : {})
      });
    }
    appendTrace(config.instance, item.id, {
      type: "approval",
      message: "Approval requested for messaging.remove_bridge",
      data: { approvalId: approval.id, bridgeId: bridge.id, toolCallId }
    });
    return approval.id;
  });
  return { kind: "pending", approvalId };
}

// Routes a terminal command through the approval-policy seam.
//
// The allowlist fast-path stays as a no-approval-row optimization for
// commands matched by `RuntimeConfig.autoApproveCommands`: those
// execute directly via `runTerminalCommand` with the matched pattern
// stamped on the side-effect audit row. Everything else goes through
// `pendingOrAuto`, which consults `resolveApprovalPolicy` to decide
// auto-approve vs gate per the active approval mode.
async function terminalExecDispatch(
  config: RuntimeConfig,
  taskId: string,
  toolCallId: string,
  args: Record<string, unknown>
): Promise<DispatchResult> {
  const command = requireString(args, "command");
  const timeoutMs = optionalNumber(args, "timeoutMs", 60_000);
  const pty = args.pty === true;

  const matchedPattern = matchAutoApprove(config.autoApproveCommands, command);
  if (matchedPattern) {
    // Short-circuit BEFORE writing the auto-approved trace if the
    // task already terminated. Without this the trace claims
    // "Auto-approved terminal command" against a cancelled task
    // before `runTerminalCommand`'s claim short-circuit catches the
    // signal. `runTerminalCommand` still independently honors the
    // registry abort once claimed, but skipping here is cheaper and
    // keeps the trace honest.
    const preStatus = await mutateState(config.instance, (state) => findTask(state, taskId).status);
    if (isTerminalTaskStatus(preStatus)) {
      return { kind: "sync", result: `Action skipped: task is already ${preStatus}.` };
    }
    appendTrace(config.instance, taskId, {
      type: "approval",
      message: "Auto-approved terminal command (allowlist match)",
      data: { command, pty, matchedPattern, toolCallId }
    });
    const result = await runTerminalCommand(config, taskId, command, {
      timeoutMs,
      pty,
      evidenceExtra: { autoApproved: true, autoApprovedReason: matchedPattern, toolCallId }
    });
    return { kind: "sync", result: result.summary };
  }

  return pendingOrAuto(
    config,
    "terminal.exec",
    { command },
    (reason) => requestTerminalExec(config, taskId, toolCallId, command, timeoutMs, pty, reason)
  );
}

// code_exec compiles a snippet to a shell command. Route through the
// policy seam as `code.exec` so the dangerous-pattern blocklist runs
// against BOTH the wrapper command AND the raw source. An argv-style
// payload like `Bun.spawn(["sudo", "apt"])` is invisible to a
// substring check against the wrapper alone (the wrapper contains
// `"sudo"` without the trailing space the literal substring needed);
// checking the source directly closes the hole. The persisted
// approval row's action stays `terminal.exec` (it really runs as one)
// — only the policy decision branches separately.
async function codeExecDispatch(
  config: RuntimeConfig,
  taskId: string,
  toolCallId: string,
  args: Record<string, unknown>
): Promise<DispatchResult> {
  const language = requireString(args, "language");
  const code = requireString(args, "code");
  const command = codeExecutionCommand(language, code);
  return pendingOrAuto(
    config,
    "code.exec",
    { command, source: code, language },
    (reason) => requestCodeExecPrebuilt(config, taskId, toolCallId, language, command, code, reason)
  );
}

async function requestTerminalExec(
  config: RuntimeConfig,
  taskId: string,
  toolCallId: string,
  command: string,
  timeoutMs: number,
  pty: boolean,
  reasonOverride?: string
): Promise<string> {
  return mutateState(config.instance, (state: RuntimeState) => {
    const item = findTask(state, taskId);
    if (isTerminalTaskStatus(item.status)) {
      throw new TaskAlreadyTerminalError(taskId, item.status);
    }
    const approval = createAuthorization(state, {
      taskId: item.id,
      action: "terminal.exec",
      target: command,
      risk: "high",
      reason: reasonOverride ?? "Terminal execution can change the system and requires explicit approval.",
      payload: { command, timeoutMs, pty, toolCallId }
    });
    item.approvalIds.push(approval.id);
    item.updatedAt = now();
    appendTrace(config.instance, item.id, {
      type: "approval",
      message: "Approval requested for terminal command (chat-task)",
      data: { approvalId: approval.id, command, pty, toolCallId }
    });
    return approval.id;
  });
}

async function requestCodeExecPrebuilt(
  config: RuntimeConfig,
  taskId: string,
  toolCallId: string,
  language: string,
  command: string,
  source: string,
  reasonOverride?: string
): Promise<string> {
  return mutateState(config.instance, (state: RuntimeState) => {
    const item = findTask(state, taskId);
    if (isTerminalTaskStatus(item.status)) {
      throw new TaskAlreadyTerminalError(taskId, item.status);
    }
    const approval = createAuthorization(state, {
      taskId: item.id,
      action: "terminal.exec",
      target: `code.${language}`,
      risk: "high",
      reason: reasonOverride ?? "Code execution can change the system and requires explicit approval.",
      // `source` on the payload is the contract that lets the
      // policy seam (re-)resolve this as code.exec instead of
      // terminal.exec — the matcher then scans the raw source so
      // argv-style payloads can't slip past a wrapper-only check.
      payload: { command, timeoutMs: 10_000, toolCallId, language, source }
    });
    item.approvalIds.push(approval.id);
    item.updatedAt = now();
    appendTrace(config.instance, item.id, {
      type: "approval",
      message: "Approval requested for code execution (chat-task)",
      data: { approvalId: approval.id, language, toolCallId }
    });
    return approval.id;
  });
}

// Helper: pull the captured tool_call_id off an approval payload. The
// chat-task loop persists the originating tool_call_id on the approval
// payload so when the approval resolves, the runtime knows which message
// in the snapshot to update with the tool result.
export function approvalToolCallId(payload: Record<string, unknown>): string | undefined {
  const id = payload.toolCallId;
  return typeof id === "string" ? id : undefined;
}


// ---------------- pendingOrAuto ----------------
//
// Single-point wrapper for every approval-gated tool. Consults
// `resolveApprovalPolicy(config, action, payload)` to decide whether
// the approval should pause for a human gate (`mode: "gate"`) or
// auto-resolve through the same
// `resolveApproval` -> `executeApprovedAction` pipeline a human
// approval would take (`mode: "auto"`). Approval creation, the
// approve audit row, the per-action side-effect audit, and the tool
// result string all live in one canonical place (agent.ts) instead
// of being duplicated per action. Each auto-resolved side effect
// creates an Approval row (status transitions pending -> approved
// through resolveApproval, same as a human approval) and writes the
// `autoApproved=true` + `autoApprovedReason=<policy reason>` markers
// onto the resolution audit rows. The reviewer sees an identical
// trail to a normal flow except for the marker on the audit row.
async function pendingOrAuto(
  config: RuntimeConfig,
  action: PolicyAction,
  payload: { command: string; source?: string; language?: string; skill?: string } | undefined,
  request: (reasonOverride?: string) => Promise<string>
): Promise<DispatchResult> {
  // Compute the policy decision BEFORE creating the approval so the
  // gate reason (`dangerous-pattern: <id>`) can flow into the
  // approval row's `reason` field. Without this, operators see only
  // the generic per-action copy ("Terminal execution can change the
  // system...") on the approval card and lose the matched-pattern
  // signal entirely.
  const decision = resolveApprovalPolicy(config, action, payload);
  const reasonOverride = decision.mode === "gate" ? decision.reason : undefined;

  // The `await request()` MUST live inside a try/catch so a
  // `TaskAlreadyTerminalError` raised by the request helper
  // (request* helpers refuse to create an approval against an
  // already-terminal task) is converted to a "skipped" sync tool
  // result rather than bubbling up as a generic tool error to the
  // model. `ApprovalRaceLostError` is ALSO caught here for symmetry,
  // although in practice it only fires from `resolveApproval` below
  // — request* helpers throw the task-terminal variant instead.
  let approvalId: string;
  try {
    approvalId = await request(reasonOverride);
  } catch (err) {
    if (err instanceof TaskAlreadyTerminalError) {
      return { kind: "sync", result: `Action skipped: task was already ${err.status} when the request reached the runtime.` };
    }
    if (err instanceof ApprovalRaceLostError) {
      return { kind: "sync", result: `Action skipped: approval was already ${err.status} by another caller.` };
    }
    throw err;
  }
  if (decision.mode === "gate") return { kind: "pending", approvalId };
  try {
    const { approval, toolResult } = await resolveAuthorization(config, approvalId, {
      actor: "runtime",
      resumeChatTask: false,
      evidenceExtra: { autoApproved: true, autoApprovedReason: decision.reason }
    });
    // `executeApprovedAction`'s guard can flip the approval from
    // `approved` back to `denied` (the
    // `approval.cancelled_task_terminal` audit row) and return an
    // undefined `toolResult`. Reporting "Auto-approved." in that
    // case would tell the model the action succeeded when the
    // audit trail says it was cancelled. Read the approval status
    // from the row returned by `resolveApproval` and route the
    // "denied / cancelled post-approval" case through the skipped
    // sync result.
    if (toolResult === undefined && approval.status === "denied") {
      return { kind: "sync", result: `Action skipped: approval was cancelled before the side effect ran.` };
    }
    return { kind: "sync", result: toolResult ?? "Auto-approved." };
  } catch (err) {
    // Race-loss: another caller (concurrent deny / cancel / double-
    // approve) decided this approval between our request* call and our
    // resolveApproval call. The other party is responsible for the
    // task's terminal transition; we just stop pretending we own the
    // action and let the chat-task loop's next-iteration cancellation
    // check observe the decided state. Returning a sync tool result
    // keeps the dispatch loop honest without escalating to task failure.
    if (err instanceof ApprovalRaceLostError) {
      return { kind: "sync", result: `Action skipped: approval was already ${err.status} by another caller.` };
    }
    // Side-effect failed AFTER we marked the approval approved. Wrap in
    // ApprovedActionFailedError so the chat-task loop's generic catch
    // re-throws it (instead of converting to a recoverable tool result)
    // and the outer runChatTask handler fails the owning task. Without
    // this the model would receive a string like "Error: EISDIR" and
    // could go on to declare the task complete despite the failure.
    throw new ApprovedActionFailedError(approvalId, err);
  }
}

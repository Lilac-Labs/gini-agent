// Browser automation tools. Drives a single per-instance Chrome via
// playwright-core, via one of two transports:
//
//   - "spawned" (the DEFAULT): a per-instance branded Chrome the runtime
//     launches itself (launchSpawnedChrome) over the pipe transport, with a
//     free-picked --remote-debugging-port for the sign-in screencast. Backed by
//     the per-instance profile dir at ~/.gini/instances/<inst>/chrome-profile/.
//     Carries NO state.browser record — it's the agent's browser whenever the
//     user hasn't attached their own.
//   - "cdp": attach to the user's OWN already-running external Chrome over a CDP
//     websocket URL they supply via /api/browser/connect (chromium.connectOverCDP).
//     Persisted as the state.browser record; we never spawn or kill that
//     process. (The previous managed-window transport was removed — issue #420.)
//
// The per-instance profile dir persists every spawned-Chrome sign-in: cookies
// survive runtime restarts and Chrome process restarts. All tasks share the
// single active context (cookies bleed across tasks within an instance, per the
// explicit product decision).
//
// Sign-in happens in-place: the browser_connect SetupRequest opens an in-chat
// screencast of the already-running headless Chrome (over its CDP debug port)
// so the user can sign in without the agent ever switching browsers.
//
// Tasks are keyed by taskId and idle-swept after 5 minutes. Side-effecting
// actions (click/type/drag/select_option/tabs:new/tabs:switch/tabs:close)
// skip the approval gate; the snapshot itself is the trace evidence.
// browser_upload_file and browser_download are the exceptions — both are
// approval-gated (high risk): upload can exfiltrate workspace files to a
// remote site, download writes remote bytes onto the local disk.
import type { Browser, BrowserContext, Locator, Page } from "playwright-core";
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { browserTracesDir, downloadsDir, instanceRoot } from "../paths";
import { resolveBrowserHeadless } from "../lib/container-env";
import { launchSpawnedChrome } from "./chrome-launch";
import { generateAuxText, generateVisionAnalysis } from "../provider";
import { resolveImageByteLimit, resolveProviderModality } from "../provider-capabilities";
import { addAudit, assertInsideWorkspace, mutateState, readState, recordUsage, storeUpload } from "../state";
import { imageTagFor } from "../lib/upload-ref";
import { sanitizeUrlForAuditTarget } from "../execution/browser-fill-secrets-types";
import type { BrowserConnectionRecord, BrowserDomainPolicy, ImageAttachment, Instance, RuntimeConfig } from "../types";

// Per-instance Chrome profile directory. The agent persists ALL sign-ins
// and cookies here; the directory survives runtime restarts and spawned
// Chrome process restarts. The spawned launch and every relaunch share this
// one dir, so a sign-in (done through the in-chat screencast) is visible to
// every later browser tool call. Removing it requires deleting the directory
// manually.
export function chromeProfileDirFor(instance: Instance): string {
  return join(instanceRoot(instance), "chrome-profile");
}

// Synchronously read the current URL of the task's browser session, if any.
// Used by approval flows (e.g. browser.upload_file) so the approval card
// can surface the upload destination to the user without forcing a
// withSession round-trip. Returns undefined when no session exists yet —
// the agent may request upload before navigating, in which case there's
// simply no destination URL to display.
export function peekCurrentBrowserUrl(taskId: string): string | undefined {
  const session = sessions.get(taskId);
  if (!session) return undefined;
  try {
    return session.page.url();
  } catch {
    return undefined;
  }
}

// Resolve the CDP targetId of the task's CURRENT page (session.page) — the exact
// tab the agent is driving. The screencast binds to this target so it shows the
// requesting task's page, never a sibling task's tab that happens to share a URL
// in the shared per-instance context (matching the old single-window behavior,
// where the user acted on the agent's actual page). The id equals the `id` field
// Chrome's /json reports for that target. Returns undefined when there's no live
// session or the CDP lookup fails — the caller then falls back to the URL hint.
export async function peekCurrentBrowserTargetId(taskId: string): Promise<string | undefined> {
  const session = sessions.get(taskId);
  if (!session) return undefined;
  try {
    const cdp = await session.context.newCDPSession(session.page);
    try {
      const info = (await cdp.send("Target.getTargetInfo")) as {
        targetInfo?: { targetId?: string };
      };
      const id = info?.targetInfo?.targetId;
      return typeof id === "string" ? id : undefined;
    } finally {
      await cdp.detach().catch(() => undefined);
    }
  } catch {
    return undefined;
  }
}

// Synchronously read the accessibility role + name a snapshot recorded for
// a ref, if the task's session still holds it. Used by the chat tool_call
// preview so a click row reads `button "Buy a License"` instead of the
// opaque `@e38`. Refs are stored `@`-prefixed (see resolveRefForAction);
// we normalize so a caller passing either form resolves. Returns undefined
// when there's no live session or the ref was swept — the preview falls
// back to the bare ref.
export function peekRefLabel(
  taskId: string,
  ref: string
): { role: string; name: string } | undefined {
  const session = sessions.get(taskId);
  if (!session) return undefined;
  const normalized = ref.startsWith("@") ? ref : `@${ref}`;
  const target = session.refs.get(normalized);
  if (!target) return undefined;
  return { role: target.role, name: target.name };
}

const SNAPSHOT_CHAR_BUDGET = 32_000;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const SWEEP_INTERVAL_MS = 30_000;

// Per-ref target recorded at snapshot time. `locator` is the stamped
// [data-gini-ref] fast path; role/name/nth describe the element as the
// walker emitted it so action tools can self-heal a lost stamp (an SPA
// re-render replacing the stamped node) by re-querying — see
// resolveRefForAction. `nth` is the element's index among entries
// sharing the same role+name in the walk that emitted the ref; it
// disambiguates repeated controls (three "Delete" buttons). See ADR
// browser-automation-engine.md.
interface RefTarget {
  locator: Locator;
  role: string;
  name: string;
  nth: number;
  // True when the element lives inside a same-origin iframe and the
  // locator chains through page.frameLocator. Framed refs never
  // self-heal: healing re-queries the MAIN frame's tree and could
  // restamp a same-name bystander outside the frame the model targeted.
  framed?: boolean;
}

interface Session {
  context: BrowserContext;
  page: Page;
  refs: Map<string, RefTarget>;
  lastActivity: number;
  // In-flight call counter. Incremented by withSession around each tool
  // invocation so the idle sweeper can skip sessions that are mid-call
  // (e.g. a slow page.goto exceeding the 5-minute idle window).
  inFlight: number;
  // Tabs the agent itself opened during this task. Used by closeSession to
  // drain agent-opened tabs at task end without touching tabs the user
  // opened or another task owns. Populated by getOrCreate ONLY when it
  // actually created a fresh page (a reused pre-existing page is a user
  // page and stays out of the set) and by browser_tabs action:"new".
  // Pages closed via browser_tabs action:"close" are removed.
  ownedPageIds: Set<Page>;
  // Monotonic allocator for @eN snapshot refs. Refs are STABLE within a
  // page lifetime: the walker reuses an element's existing data-gini-ref
  // stamp and only allocates new ids for unstamped elements, so the
  // counter never hands a removed element's id to a different element.
  // Reset to 1 when snapshot() detects a navigation (which also clears
  // all stamps). See ADR browser-automation-engine.md.
  nextRefId: number;
  // Redacted text of the most recent snapshot — the diff base for
  // post-action snapshots — plus the URL it was taken at. A URL change
  // between snapshots means navigation: stamps cleared, numbering reset,
  // diff base dropped. browser_navigate / browser_back / browser_tabs
  // page swaps clear lastSnapshotUrl explicitly so even a same-URL
  // navigation (reload) resets refs.
  lastSnapshotText?: string;
  lastSnapshotUrl?: string;
  // Stable tab handles. Each Page gets a permanent session-scoped handle
  // ("t1", "t2", …) the first time browser_tabs sees it — on open for
  // agent-created tabs, lazily on list for user-opened tabs and
  // window.open popups. The counter is monotonic and a handle is NEVER
  // reused, so a stale plan addressing a closed tab's handle fails
  // loudly instead of acting on whichever tab inherited its position
  // (the failure mode of positional indexes). Entries are pruned when
  // the page closes. See ADR browser-automation-engine.md.
  tabHandles: Map<string, Page>;
  nextTabHandleId: number;
}

// The currently-installed shared handle: a branded Chrome the runtime launched
// itself (launchSpawnedChrome — --headless=new + stealth flags + clean UA + the
// per-instance profile + a free-picked --remote-debugging-port) over the pipe
// transport. Carries the profileDir we reap on teardown (a profile-dir-scoped
// SIGKILL — never killall, never the user's :9222) and the debug port (used by
// the sign-in modal that attaches over CDP).
//
// PER INSTANCE: there is one shared browser per instance, stored in the single
// `shared` slot below, and tasks share its context (cookies bleed across tasks
// within an instance, per the explicit product decision).
type SharedHandle =
  | { kind: "spawned"; context: BrowserContext; port: number; profileDir: string }
  | { kind: "cdp"; browser: Browser; context: BrowserContext };

// The single instance-level handle the spawned launch installs into.
let shared: SharedHandle | null = null;
// In-flight launch promise so concurrent ensureShared callers share one
// launchSpawnedChrome() instead of orphaning the loser's handle.
let pendingShared: Promise<SharedHandle> | null = null;
// Monotonically-increasing disconnect counter. Bumped at the start of
// every disconnectSharedBrowser call. Replaces an earlier boolean
// `disconnecting` flag whose two-state design lost information across
// re-entrant disconnects and exceeded-drain-deadline races: a slow
// getOrCreate / launch that breached the 5s cap would resume
// after teardown, observe `disconnecting === false`, and proceed against
// a torn-down browser. With a generation counter the resuming caller
// compares its captured epoch to the current one and bails on any
// change. Callers that need "is teardown in progress right now?" can
// read the wider `inFlightDisconnects` boolean below.
let disconnectGeneration = 0;
// True while one or more disconnectSharedBrowser calls are mid-flight.
// withSession uses this to short-circuit new admissions cheaply without
// racing the generation counter on every entry. Cleared back to false
// when the last in-flight disconnect's finally block runs.
let inFlightDisconnects = 0;
// Counts admissions that have captured a generation but have not yet
// bumped their session's `inFlight`. Without this, a tool call could
// pass the initial check, suspend inside getOrCreate / ensureBrowser
// (e.g. on a slow spawned-Chrome launch),
// disconnectSharedBrowser could observe an empty drain and tear down,
// and the suspended call would resume against a closed browser. The
// drain loop in disconnectSharedBrowser waits for this to fall to zero
// in addition to summing per-session inFlight.
let pendingAdmissions = 0;
// How long disconnectSharedBrowser waits for inFlight sessions to drain
// before forcing teardown. Better to risk tearing down a slow in-flight
// call than to wedge disconnect forever waiting on a hung page.goto.
const DISCONNECT_DRAIN_DEADLINE_MS = 5_000;
// How long a single Playwright close()/disconnect() in the teardown path
// may run before we give up on it. context.close() / page.close() never
// resolve when Chromium is wedged (a page stuck on a heavy/bot-protected
// navigation), which would otherwise hang the whole connect/disconnect
// flow for minutes. Overridable via __test.setTeardownCloseTimeoutForTest
// so close-path tests don't have to wait the full budget.
let teardownCloseTimeoutMs = 5_000;
// Memoized playwright-core chromium import, used by the cdp provider to
// connectOverCDP to a user's external Chrome. The spawned provider goes
// through chrome-launch.ts directly; only the cdp attach needs the bare
// chromium namespace here.
let chromiumImport: Promise<typeof import("playwright-core").chromium> | undefined;
function loadChromium(): Promise<typeof import("playwright-core").chromium> {
  if (!chromiumImport) {
    // Surface a friendlier error than the bare Node module-resolution string
    // when playwright-core isn't installed. Matches the defensive wrapper in
    // src/capabilities/browser-connect.ts so both code paths emit the same hint.
    chromiumImport = import("playwright-core").then(
      (mod) => mod.chromium,
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        const isMissing =
          (error as { code?: string } | undefined)?.code === "MODULE_NOT_FOUND" ||
          (error as { code?: string } | undefined)?.code === "ERR_MODULE_NOT_FOUND" ||
          message.includes("Cannot find package 'playwright-core'") ||
          message.includes("Cannot find module 'playwright-core'");
        if (isMissing) {
          throw new Error(
            "Browser runtime is missing. Run `bun install` in the gini-agent checkout, then restart the runtime."
          );
        }
        throw error;
      }
    );
  }
  return chromiumImport;
}
const sessions = new Map<string, Session>();
// Per-task registry of literal secret values that browserFillByLocator
// has typed into the page. Populated BEFORE the .fill() call so a
// page that synchronously clears or copies the input on the `input`
// event still has its typed bytes recorded — without this, a page
// that clears its own input post-fill would leave the
// data-gini-secret-stamped element empty and the live-DOM-only
// collector at collectSecretValuesFromPageWithSession would return
// nothing for that task, defeating redaction in subsequent
// browser_console / browser_snapshot / browser_vision calls. Read
// alongside the live-DOM collector to catch BOTH (a) values typed
// via fill_secret that the page has since cleared/moved, and
// (b) values the page itself populated into data-gini-secret-stamped
// elements (e.g. server-side prefilled credentials revealed via
// hover). The registry is per-task so closing a session
// (closeSession or sweep) deletes the entry, bounding memory.
const filledSecretValues = new Map<string, Set<string>>();
// Minimum length below which a typed value is NOT registered as a
// redaction target. A single-character secret would otherwise
// turn every literal occurrence of that character into
// "[redacted]" — including digits inside snapshot ref tokens
// like `[@e1]`, which would shred the snapshot and break the
// agent's locator references. Multi-character secrets are
// vanishingly unlikely to collide with structural snapshot
// tokens. Real credentials are always ≥ this length in
// practice (PINs are typically 4+, OTPs 6+, passwords 8+).
export const FILLED_SECRET_MIN_REDACTION_LENGTH = 4;
// Record a secret value typed for a task. Called by
// browserFillByLocator immediately before .fill() runs. Empty
// strings and short strings are not recorded so the redactor's
// substring match stays safe against structural tokens.
function recordFilledSecret(taskId: string, value: string): void {
  if (typeof value !== "string" || value.length < FILLED_SECRET_MIN_REDACTION_LENGTH) return;
  let set = filledSecretValues.get(taskId);
  if (!set) {
    set = new Set<string>();
    filledSecretValues.set(taskId, set);
  }
  set.add(value);
}
// Drop the per-task registry when the task's session closes (idle
// sweep, explicit close, or browser disconnect). Memory-bound
// cleanup — the union-across-tasks redaction (see
// allRegisteredSecrets below) keeps secrets visible to other
// active tasks until each task's own session terminates.
function clearFilledSecrets(taskId: string): void {
  filledSecretValues.delete(taskId);
}
// Union of every known secret across every active task's registry.
// The shared-BrowserContext architecture (persistent / CDP profile
// is shared across tasks per src/tools/browser.ts:495-502) means
// Task A can type a credential, the page can JS-copy it into
// document.title, and Task B can read that title via its own
// snapshot/navigate response. Task B's per-task registry is empty,
// but Task A's is non-empty until Task A's session closes — so
// reading the union catches cross-task leaks via shared DOM state.
// Returns [] when no task has any registered secrets so the
// redactor's empty-set fast path stays cheap in the common case.
function allRegisteredSecrets(): string[] {
  if (filledSecretValues.size === 0) return [];
  const out = new Set<string>();
  for (const set of filledSecretValues.values()) {
    for (const v of set) out.add(v);
  }
  return Array.from(out);
}
// Set at runtime startup via setBrowserInstance(). Scopes the spawned
// Chrome's profile dir (chromeProfileDirFor) and the per-instance state reads
// to this instance. Stays undefined in standalone test contexts that import
// the tools directly without going through the runtime — the launch path then
// falls back to a default profile dir.
let runtimeInstance: Instance | undefined;
// Same idea per task — concurrent getOrCreate() calls for the same taskId
// share one Promise<Session> so we never create two contexts for one task.
const pendingSessions = new Map<string, Promise<Session>>();
let sweepTimer: ReturnType<typeof setInterval> | undefined;
let exitHookRegistered = false;

// Called by the runtime (src/server.ts) right after loadConfig so the
// session manager can resolve which instance's per-instance profile dir to
// launch against. Safe to call repeatedly — only the last value is used.
export function setBrowserInstance(instance: Instance): void {
  runtimeInstance = instance;
}

// The transport kind. `spawned` is the DEFAULT (a per-instance branded Chrome
// the runtime launches itself); `cdp` attaches to a user's OWN external Chrome
// over a CDP websocket URL they supply. (The old `persistent` / visible
// managed-window transport was removed — issue #420.)
type Mode = "spawned" | "cdp";

// Mode decided from state.browser. No record → the default spawned launch; a
// persisted cdp record → attach to the user's external Chrome. We resolve the
// record before the launch await so two concurrent cold-start callers see the
// same decision.
function activeBrowserRecord(): BrowserConnectionRecord | undefined {
  if (!runtimeInstance) return undefined;
  try {
    const state = readState(runtimeInstance);
    return state.browser ?? undefined;
  } catch {
    // readState can throw on a state-file corruption — better to fall back to
    // the spawned launch than to wedge every browser tool call.
    return undefined;
  }
}

function modeFromRecord(record: BrowserConnectionRecord | undefined): Mode {
  return record ? "cdp" : "spawned";
}

// ---------------- Session providers ----------------
//
// Seam for WHERE the browser the agent drives comes from. A provider owns
// exactly one transport concern: acquire a live BrowserContext
// (`connect`) and release it (`disconnect`). Everything above this seam —
// snapshot walking, secret redaction, SSRF/domain-policy gating,
// approvals, audit, traces — runs IN-PROCESS against the Playwright
// client regardless of which provider supplied the browser; swapping the
// provider only changes where the launch endpoint points. That is the
// property that ruled out subprocess engines (see ADR
// browser-automation-engine.md, "Remote session provider seam") and it
// must hold for any future provider.
//
// Today's providers are two: `spawned` (the DEFAULT — a per-instance branded
// Chrome the runtime launches itself over the pipe transport) and `cdp` (attach
// to the user's own external Chrome over a CDP URL they supply). The one
// capability the local engine cannot fake is IP reputation (datacenter-IP
// blocks, geo walls); a future remote/cloud-browser provider would slot in as a
// third entry that resolves its remote endpoint (provision a cloud session,
// then attach over CDP/WebSocket) and returns a cdp-shaped SharedHandle — or
// adds its own SharedHandle variant when its teardown needs extra release work
// (e.g. an API call ending the cloud session). The disconnect-generation
// choreography stays in ensureShared / teardown call sites; it is
// transport-agnostic.
interface BrowserSessionProvider {
  kind: Mode;
  // Establish the transport and return the live handle. Called by ensureShared
  // under the single-flight pendingShared promise. The cdp provider reads
  // `record.cdpUrl`; the spawned provider ignores the record.
  connect(record: BrowserConnectionRecord | undefined): Promise<SharedHandle>;
  // Release the handle this provider built. Must never throw — teardown
  // runs on paths (disconnect, exit hooks) that cannot surface errors.
  disconnect(handle: SharedHandle): Promise<void>;
}

// The per-instance profile dir the spawned launch uses. Refuses to launch when
// no instance is registered (raw test imports install a fake handle instead).
function spawnedProfileDir(): string {
  if (!runtimeInstance) {
    throw new Error(
      "No instance registered for the browser session manager; call setBrowserInstance() before triggering a browser tool."
    );
  }
  return chromeProfileDirFor(runtimeInstance);
}

// The spawn-and-attach launcher, indirected through a module-level binding so
// tests can swap it for a fake (like chromeKiller below) and exercise the
// provider body without launching a real Chrome. Production uses the real
// chrome-launch implementation.
let spawnChrome: typeof launchSpawnedChrome = launchSpawnedChrome;

const spawnedSessionProvider: BrowserSessionProvider = {
  kind: "spawned",
  async connect(_record) {
    // Launch our OWN branded Chrome against the per-instance profile dir on a
    // free debug port, over Playwright's pipe transport. The user's :9222 is
    // never touched; the debug port is free-picked above it (and is the
    // endpoint the sign-in modal attaches to over CDP).
    //
    // Headless by default (the historical value). A container running Xvfb
    // sets GINI_BROWSER_HEADLESS=false so Chrome launches HEADED against the
    // virtual display (DISPLAY=:99) — a real headed Chrome under Xvfb presents
    // fewer automation signals than --headless=new, complementing the stealth
    // identity. See ADR docker-xvfb-deployment.md.
    const profileDir = spawnedProfileDir();
    const { context, port } = await spawnChrome({ profileDir, headless: resolveBrowserHeadless() });
    return { kind: "spawned", context, port, profileDir };
  },
  async disconnect(handle) {
    if (handle.kind !== "spawned") return;
    // Close the persistent context, which terminates the Chrome Playwright
    // launched. Bound it so a wedged Chrome can't hang teardown; on timeout,
    // reap by the instance profile dir (so the scan SIGKILLs only this
    // instance's spawned Chrome — never killall, never the user's :9222). The
    // profile dir on disk stays put so sign-ins persist.
    const settled = await settledWithin(handle.context.close(), teardownCloseTimeoutMs);
    if (!settled) {
      try {
        const killed = chromeKiller(handle.profileDir);
        if (killed >= 1) await new Promise((r) => setTimeout(r, 300));
      } catch {
        // best effort — a kill failure must never throw out of teardown.
      }
    }
  }
};

// Attach to the user's OWN external Chrome over a CDP websocket URL they
// supplied via /api/browser/connect. We NEVER spawn or kill this process — the
// user owns it. connectOverCDP works under Bun via the bundled-ws→built-in-ws
// patch (patches/playwright-core@1.61.1.patch); without it the CDP websocket
// handshake deadlocks. This is an opt-in transport for users who point us at
// their own Chrome.
const cdpSessionProvider: BrowserSessionProvider = {
  kind: "cdp",
  async connect(record) {
    const chromium = await loadChromium();
    if (!record?.cdpUrl) {
      throw new Error(
        "CDP browser connection record is missing cdpUrl; reconnect via /api/browser/connect."
      );
    }
    // connectOverCDP returns a Browser handle scoped to the remote process.
    // The remote Chrome's default BrowserContext shows up under
    // browser.contexts() — we reuse it so signed-in cookies are visible.
    let browser: Browser;
    try {
      browser = await chromium.connectOverCDP(record.cdpUrl, { timeout: 60_000 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/timeout|websocket|protocol/i.test(message)) {
        throw new Error(
          `Failed to attach over CDP: ${message}. ` +
            "Confirm Chrome is running with --remote-debugging-port and the cdpUrl host:port is reachable, " +
            "or disconnect and let the agent use its own spawned browser instead."
        );
      }
      throw error instanceof Error ? error : new Error(message);
    }
    const ctx = browser.contexts()[0] ?? (await browser.newContext());
    return { kind: "cdp", browser, context: ctx };
  },
  async disconnect(handle) {
    if (handle.kind !== "cdp") return;
    const candidate = handle.browser as unknown as { disconnect?: () => Promise<void> };
    if (typeof candidate.disconnect === "function") {
      // Bound the disconnect, but NEVER kill — the remote Chrome is the user's
      // own process. (playwright-core 1.61 does not expose disconnect() on a
      // connectOverCDP Browser, so this branch is dormant there; kept for
      // builds/versions that do, where it's the clean detach.)
      await settledWithin(candidate.disconnect(), teardownCloseTimeoutMs);
    }
    // If disconnect() isn't available on this CDP-attached Browser, do NOT fall
    // back to close(). On some Playwright builds close() over CDP terminates the
    // remote, and killing the user's own Chrome is never acceptable; leaking the
    // in-process handle is strictly the safer failure. The handle is dropped on
    // the next ensureShared() reattach regardless.
  }
};

// Registry keyed by Mode. A future remote provider adds its entry here (plus
// its Mode mapping); ensureShared and teardownHandle dispatch through this
// table and need no changes.
// Mutable only via __test.setSessionProviderForTest.
const sessionProviders: Record<Mode, BrowserSessionProvider> = {
  spawned: spawnedSessionProvider,
  cdp: cdpSessionProvider
};

// Is the spawned BrowserContext still backed by a live browser? After an
// EXTERNAL kill (crash, or the user killing the spawned Chrome) Playwright's
// context.pages() still returns [] without throwing, so it can't tell a dead
// context from a live one. The underlying Browser's isConnected() is the signal
// that actually flips on an external kill (and on an explicit context.close()).
// We treat a context as dead ONLY when we can positively observe
// isConnected() === false; when the Browser handle isn't exposed (lightweight
// test fakes, or a Playwright build that returns null for a persistent context)
// we assume alive, matching the previous reuse-by-default behavior.
function isContextConnected(context: BrowserContext): boolean {
  const ctx = context as BrowserContext & { browser?: () => Browser | null };
  try {
    if (typeof ctx.browser === "function") {
      const browser = ctx.browser();
      if (browser) return browser.isConnected();
    }
  } catch {
    // browser() unexpectedly threw — fall through to assume-alive.
  }
  return true;
}

// Cheap "is this handle still alive?" probe used to short-circuit
// ensureShared when the previously-installed handle survives, and to force a
// relaunch/reattach when the underlying Chrome died. The cdp handle exposes the
// remote Browser directly (probe isConnected()); the spawned handle is a
// persistent context (pipe transport) probed via isContextConnected, which
// returns false on an external kill and true otherwise.
function isHandleAlive(handle: SharedHandle): boolean {
  try {
    if (handle.kind === "cdp") return handle.browser.isConnected();
    return isContextConnected(handle.context);
  } catch {
    return false;
  }
}

// Exposed so callers like browserVision can capture the current disconnect
// generation before doing slow work (provider fetch) and re-check after,
// bailing if the browser was torn down underneath them. Same value the
// internal admission gate compares against.
export function currentDisconnectGeneration(): number {
  return disconnectGeneration;
}

// The spawned Chrome's CDP debug port, or null when no live spawned handle is
// installed (no browser launched yet). The sign-in screencast bridge dials ONLY
// this port (always ≥ DEFAULT_CDP_PORT_BASE, well above the user's conventional
// :9222) to attach its raw-CDP screencast — it never accepts a port from the
// client. Returns null rather than launching: the bridge is a read/drive channel
// over an ALREADY-running headless Chrome, not a reason to spawn one.
export function getScreencastPort(): number | null {
  // Only the spawned handle exposes a debug port we own and may screencast; a
  // cdp-attached handle is the user's own Chrome (no port we control), so the
  // sign-in screencast doesn't apply.
  if (shared && shared.kind === "spawned" && isHandleAlive(shared)) return shared.port;
  return null;
}

async function ensureShared(): Promise<SharedHandle> {
  if (shared && isHandleAlive(shared)) return shared;
  if (pendingShared) return pendingShared;
  // Resolve the persisted record (if any) BEFORE the launch await so two
  // concurrent cold-start callers see the same transport decision: no record →
  // the default spawned launch; a cdp record → attach to the user's Chrome.
  const record = activeBrowserRecord();
  const mode: Mode = modeFromRecord(record);
  // Capture the current disconnect generation at the START of the launch.
  // If a disconnect bumps the counter while launchSpawnedChrome is in flight,
  // we don't want to install the resulting handle on the shared slot —
  // disconnect already cleared `shared`, so installing the freshly-built handle
  // would silently re-attach the agent to a stale Chrome. Throwing inside the
  // IIFE lets the natural pendingShared rejection carry up to the caller, and
  // the resulting handle is closed so we don't leak the process.
  const launchGeneration = disconnectGeneration;
  pendingShared = (async () => {
    // Transport acquisition is fully delegated to the session provider —
    // the generation choreography around it is transport-agnostic.
    const built: SharedHandle = await sessionProviders[mode].connect(record);
    if (disconnectGeneration !== launchGeneration) {
      // Disconnect bumped the generation while we were launching. Clean
      // up the freshly-built handle and surface a clear error to the
      // caller.
      await teardownHandle(built).catch(() => undefined);
      throw new Error("Browser disconnecting, retry shortly.");
    }
    return built;
  })()
    .then((handle) => {
      // Re-check inside the .then so we never install a stale handle on
      // the shared slot. The IIFE above already throws in this case, but
      // the belt-and-braces check covers a future refactor where the
      // generation could change between the IIFE return and this handler.
      if (disconnectGeneration !== launchGeneration) {
        void teardownHandle(handle).catch(() => undefined);
        throw new Error("Browser disconnecting, retry shortly.");
      }
      shared = handle;
      registerExitHook();
      startSweeper();
      return handle;
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      // Don't wrap the "Browser disconnecting" sentinel — withSession
      // matches on its prefix and we want callers to see the same
      // message regardless of where the bail happened.
      if (message.startsWith("Browser disconnecting")) {
        throw error instanceof Error ? error : new Error(message);
      }
      throw new Error(
        `Failed to launch Chromium: ${message}. ` +
          "Confirm Chrome / Chromium is installed (or set GINI_CHROME_PATH), or run " +
          "`bunx playwright install chromium` to install the browser."
      );
    })
    .finally(() => {
      pendingShared = null;
    });
  return pendingShared;
}

// Bound a Playwright close()/disconnect() that can hang when Chromium is
// wedged (a page stuck on a heavy/bot-protected navigation). Swallows
// rejection like the old `.catch(() => undefined)`. Returns true if the op
// settled within the budget, false if it timed out (caller then force-kills
// the child so the profile-dir lock frees for the next launch).
async function settledWithin(op: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const TIMED_OUT = Symbol("timed-out");
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    const outcome = await Promise.race([op.then(() => undefined, () => undefined), timeout]);
    return outcome !== TIMED_OUT;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// The spawned Chromium child isn't reachable via the playwright-core
// client API (Browser has no process()), so when context.close() times
// out we reap it by OS pid: find the process whose --user-data-dir is
// this instance's profile dir and SIGKILL it, releasing the profile lock
// for the next spawned launch. Best-effort and overridable for tests.
// Returns the number of pids signalled.
let chromeKiller: (profileDir: string) => number = killChromeByProfileDir;
function killChromeByProfileDir(profileDir: string): number {
  try {
    const out = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
    let n = 0;
    for (const line of out.split("\n")) {
      if (!line.includes(`--user-data-dir=${profileDir}`)) continue;
      const pid = Number(line.trim().split(/\s+/)[0]);
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, "SIGKILL");
          n++;
        } catch {
          /* gone */
        }
      }
    }
    return n;
  } catch {
    return 0;
  }
}

// Teardown of a SharedHandle, dispatched through the session provider that
// built it (the seam's release side). The spawned provider closes the
// BrowserContext, terminating the launched Chromium child; the profile dir on
// disk stays put so sign-ins persist.
async function teardownHandle(handle: SharedHandle): Promise<void> {
  return sessionProviders[handle.kind].disconnect(handle);
}

function registerExitHook(): void {
  if (exitHookRegistered) return;
  exitHookRegistered = true;
  // Only beforeExit. The runtime's own SIGTERM handler in src/server.ts
  // calls closeAll() as part of its drain; intercepting SIGINT/SIGTERM
  // here would either swallow the signal (no process.exit) or race the
  // server's drain. beforeExit covers non-server callers (CLI, tests).
  process.on("beforeExit", () => {
    void closeAll();
  });
}

function startSweeper(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const cutoff = Date.now() - IDLE_TIMEOUT_MS;
    for (const [taskId, session] of sessions.entries()) {
      // Skip sessions with in-flight calls so a slow page.goto doesn't
      // get killed under the agent's feet just because it crossed the
      // idle threshold mid-await.
      if (session.inFlight > 0) continue;
      if (session.lastActivity < cutoff) {
        void closeSession(taskId);
      }
    }
  }, SWEEP_INTERVAL_MS);
  // Don't keep the event loop alive just for the sweeper.
  if (typeof sweepTimer.unref === "function") sweepTimer.unref();
}

// ---------------- Session trace recording (opt-in) ----------------
//
// When RuntimeConfig.browserRecording is true (server boot calls
// setBrowserRecording), browser sessions record a Playwright trace for
// debugging/audit review. Tracing (context.tracing start/stop) is used
// instead of recordVideo because video must be configured when the
// context is CREATED — impossible for the spawned persistent context, which
// is launched before any task exists — while tracing can start on an
// already-live context. The
// BrowserContext is shared across tasks (one per instance), so only one trace
// runs at a time: the first session created while none is active claims it;
// sessions starting while a trace is in flight are simply not recorded.
//
// Trace archives are raw Playwright captures (DOM snapshots +
// screenshots) and do NOT pass through the secret-redaction layer — they
// can contain anything the page displayed. They are written only to local
// disk under <instanceRoot>/browser-traces/, never enter the model
// context, and every save writes a browser.trace_saved audit row. That is
// why the feature is opt-in and OFF by default.
const TRACE_RETENTION_MAX = 10;
let browserRecordingEnabled = false;
// taskId of the session holding the single context-wide trace, or null.
let activeTraceTaskId: string | null = null;

// Called at server boot alongside setBrowserInstance. Safe to call
// repeatedly; affects sessions created after the call.
export function setBrowserRecording(enabled: boolean): void {
  browserRecordingEnabled = enabled === true;
}

// typeof-guarded view of context.tracing so lightweight test fakes (and a
// hypothetical context without tracing support) degrade to "no recording"
// instead of throwing.
interface ContextTracing {
  start?: (options: { screenshots: boolean; snapshots: boolean }) => Promise<void>;
  stop?: (options?: { path?: string }) => Promise<void>;
}
function tracingOf(context: BrowserContext): ContextTracing | undefined {
  const tracing = (context as BrowserContext & { tracing?: ContextTracing }).tracing;
  return tracing && typeof tracing === "object" ? tracing : undefined;
}

// Start the context-wide trace for a freshly-created session. Best-effort:
// any failure leaves the session fully functional, just unrecorded.
async function startSessionTrace(taskId: string, context: BrowserContext): Promise<void> {
  if (!browserRecordingEnabled || activeTraceTaskId !== null) return;
  const tracing = tracingOf(context);
  if (typeof tracing?.start !== "function") return;
  // Reserve the slot BEFORE the await so a concurrently-created second
  // session can't start a competing trace on the same shared context.
  activeTraceTaskId = taskId;
  try {
    await tracing.start({ screenshots: true, snapshots: true });
  } catch {
    activeTraceTaskId = null;
  }
}

// Bounded retention: keep the newest TRACE_RETENTION_MAX archives, delete
// the rest. Newness is mtime-based so retention survives filename-format
// changes. Best-effort throughout.
function pruneTraceFiles(dir: string): void {
  let entries: Array<{ path: string; mtimeMs: number }>;
  try {
    entries = readdirSync(dir)
      .filter((name) => name.endsWith(".zip"))
      .map((name) => {
        const path = join(dir, name);
        return { path, mtimeMs: statSync(path).mtimeMs };
      });
  } catch {
    return;
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const stale of entries.slice(TRACE_RETENTION_MAX)) {
    try {
      unlinkSync(stale.path);
    } catch {
      // best effort
    }
  }
}

// Stop and save the trace when the owning session closes (explicit close,
// idle sweep, disconnect, process exit). Best-effort end to end — a
// failed save must never block session teardown.
async function stopSessionTrace(taskId: string, context: BrowserContext): Promise<void> {
  if (activeTraceTaskId !== taskId) return;
  activeTraceTaskId = null;
  const tracing = tracingOf(context);
  if (typeof tracing?.stop !== "function") return;
  if (!runtimeInstance) {
    // No instance to scope the archive under (raw test imports) — end the
    // trace without saving so the context stops buffering.
    await tracing.stop().catch(() => undefined);
    return;
  }
  const instance = runtimeInstance;
  try {
    const dir = browserTracesDir(instance);
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeTask = taskId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
    const path = join(dir, `trace-${stamp}-${safeTask}.zip`);
    await tracing.stop({ path });
    pruneTraceFiles(dir);
    let sizeBytes: number | null = null;
    try {
      sizeBytes = statSync(path).size;
    } catch {
      // Playwright always writes the archive on stop({ path }); a missing
      // file just means a fake/degenerate tracer — keep the audit row.
    }
    await mutateState(instance, (state) => {
      addAudit(
        state,
        {
          actor: "runtime",
          action: "browser.trace_saved",
          target: path,
          risk: "low",
          taskId,
          runId: state.tasks.find((task) => task.id === taskId)?.runId,
          evidence: { path, sizeBytes }
        },
        { taskId }
      );
    });
  } catch {
    // best effort — never block teardown on a failed trace save.
  }
}

async function getOrCreate(taskId: string): Promise<Session> {
  const existing = sessions.get(taskId);
  if (existing) {
    // Reuse the cached session only while its browser is still connected. If
    // the Chrome died out from under it mid-task (external kill), drop the
    // session so we re-materialize a fresh page against the relaunched
    // context below instead of handing back a dead page that throws
    // "Target page, context or browser has been closed".
    if (isContextConnected(existing.context)) {
      existing.lastActivity = Date.now();
      return existing;
    }
    sessions.delete(taskId);
    clearFilledSecrets(taskId);
  }
  const inflight = pendingSessions.get(taskId);
  if (inflight) return inflight;
  const promise = (async () => {
    const handle = await ensureShared();
    // Tasks sharing one BrowserContext share its cookies (by design — one
    // profile per instance). The FIRST task on the context claims any existing
    // page (e.g. the about:blank Chrome opens at launch); later tasks each get
    // a fresh tab so they don't trample each other. Count by context (not
    // global session count) so the initial page is claimed exactly once.
    const context = handle.context;
    const contextHasSession = Array.from(sessions.values()).some((s) => s.context === context);
    const reusable = contextHasSession ? undefined : context.pages()[0];
    const page = reusable ?? (await context.newPage());
    // Only mark the page as agent-owned when we just created it. The reused
    // pre-existing page is the spawned Chrome's initial about:blank tab —
    // closing it on session teardown could tear down the shared context's
    // first tab out from under a sibling session, so leave it unowned.
    const ownedPageIds = new Set<Page>();
    if (!reusable) ownedPageIds.add(page);
    const session: Session = {
      context,
      page,
      refs: new Map(),
      lastActivity: Date.now(),
      inFlight: 0,
      ownedPageIds,
      nextRefId: 1,
      tabHandles: new Map(),
      nextTabHandleId: 1
    };
    sessions.set(taskId, session);
    // Attach console capture eagerly so page.goto errors before the
    // agent's first browser_console call are still observable, the
    // dialog handler so the very first navigation's dialogs are
    // captured instead of silently auto-dismissed by Playwright, and
    // the network log so the first page load's requests are visible.
    attachConsole(taskId, page);
    attachDialogHandler(taskId, page);
    attachNetworkCapture(taskId, page);
    // Opt-in session trace recording — no-op unless enabled at boot and
    // no other session already holds the context-wide trace.
    await startSessionTrace(taskId, context);
    return session;
  })().finally(() => {
    pendingSessions.delete(taskId);
  });
  pendingSessions.set(taskId, promise);
  return promise;
}

// Per-tool wrapper that bumps inFlight while the work is in progress so
// the idle sweeper never closes a session mid-call.
async function withSession<T>(taskId: string, fn: (session: Session) => Promise<T>): Promise<T> {
  if (inFlightDisconnects > 0) {
    // The caller is the tool layer; throwing here surfaces as a `success:
    // false` envelope from each browser_* entry point via their existing
    // catch blocks.
    throw new Error("Browser disconnecting, retry shortly.");
  }
  // Capture the disconnect generation BEFORE bumping pendingAdmissions so
  // we can detect any disconnect that completes (and possibly re-completes)
  // while getOrCreate is materializing. A boolean wouldn't be enough: by
  // the time getOrCreate resumes the boolean may have flipped back to
  // false, but the browser we were going to use is gone.
  const enteredAt = disconnectGeneration;
  pendingAdmissions++;
  let session: Session;
  try {
    session = await getOrCreate(taskId);
    if (disconnectGeneration !== enteredAt) {
      // Disconnect started — and possibly finished — while we were
      // materializing. Bail out without using the session; the browser
      // is either being torn down or already gone.
      throw new Error("Browser disconnecting, retry shortly.");
    }
    session.inFlight++;
  } finally {
    pendingAdmissions--;
  }
  try {
    return await fn(session);
  } finally {
    session.inFlight--;
    session.lastActivity = Date.now();
  }
}

async function closeSession(taskId: string): Promise<void> {
  const session = sessions.get(taskId);
  if (!session) return;
  sessions.delete(taskId);
  consoleLogs.delete(taskId);
  pendingDialogResponses.delete(taskId);
  unreportedDialogs.delete(taskId);
  networkLogs.delete(taskId);
  // Drop the per-task secret-redaction registry when the session
  // closes. The DOM is gone (the page closes below), so the
  // registry would never be consulted again for this task —
  // keeping it would just leak memory across many tasks.
  clearFilledSecrets(taskId);
  // Stop + save the opt-in session trace while the context is still live
  // (no-op unless this task holds the trace). Never throws.
  await stopSessionTrace(taskId, session.context);
  try {
    // Shared spawned context: close every page the agent opened during this
    // task. The spawned Chrome's initial tab and the persistent profile stay
    // alive — the ownedPageIds set tracks ONLY agent-opened tabs (initial page
    // from getOrCreate plus any browser_tabs action:"new"), so the shared
    // context's first tab is never in this set. The next task lands in the
    // same profile.
    for (const page of session.ownedPageIds) {
      await page.close().catch(() => undefined);
    }
    session.ownedPageIds.clear();
  } catch {
    // Already closed or browser disconnected; nothing useful to do.
  }
  // We deliberately do NOT tear down the shared handle when sessions hit
  // zero. The persistent context is cheap to keep alive idle (Chromium
  // sleeps when no pages are active) and re-launching it on the next
  // tool call would be more disruptive than the idle process is.
  // Explicit Connect/Disconnect is the only path that tears down the
  // shared handle.
}

// Drop the in-process Playwright handle and tear down the spawned Chrome it
// holds. Used by the browser-connect capability's disconnect: the next browser
// tool call lazily relaunches the SAME per-instance profile via ensureShared,
// so the user's sign-ins survive. Safe no-op when no shared browser is held.
export async function disconnectSharedBrowser(): Promise<void> {
  // Bump the generation FIRST so any in-flight admissions and any
  // pendingBrowser launch capture-and-compare can detect the disconnect
  // even if their resume runs after this function returns. Re-entrant
  // disconnects each get their own generation; the drain loop below
  // bails early if a NEWER generation appears, letting that newer call
  // handle the actual teardown.
  const myGeneration = ++disconnectGeneration;
  inFlightDisconnects++;
  try {
    // Wait for in-flight calls AND materializing admissions to drain. We
    // can't safely close pages / contexts while tools are mid-await on
    // them — the half-completed browser call would throw a confusing
    // "Target closed" up the stack. We also have to wait for any
    // withSession callers that have passed the admission check but
    // haven't yet bumped inFlight: closing under them would leave a
    // suspended call holding a soon-to-be-dead session reference. Bound
    // the wait so a hung page.goto can't wedge disconnect forever; after
    // the deadline, proceed with teardown anyway.
    const drainDeadline = Date.now() + DISCONNECT_DRAIN_DEADLINE_MS;
    while (Date.now() < drainDeadline) {
      // If a newer disconnect call has bumped the generation past ours,
      // bail early: the newer call will run its own drain and teardown,
      // and our continued work would just double-close pages.
      if (disconnectGeneration !== myGeneration) return;
      let pending = 0;
      for (const session of sessions.values()) pending += session.inFlight;
      if (pending === 0 && pendingAdmissions === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // Same early-exit re-check after the drain loop: a newer disconnect
    // may have arrived while we slept the last 50ms tick. Let it own the
    // teardown.
    if (disconnectGeneration !== myGeneration) return;

    // Wait for any in-flight launch to settle BEFORE tearing down the
    // shared slot. The drain loop above only counts admissions that
    // reached withSession — a slow launchPersistentContext / connectOverCDP
    // started by an earlier admission that has since exited withSession
    // can still finish here and install itself into `shared`, holding the
    // profile lock against the Connect/Wipe that's running this teardown.
    // Swallow rejections: a failed launch leaves `shared` null, which is
    // what we want, and the original caller already saw the failure.
    if (pendingShared) {
      await pendingShared.catch(() => undefined);
    }

    const ids = Array.from(sessions.keys());
    for (const id of ids) {
      const session = sessions.get(id);
      sessions.delete(id);
      // Clear the per-task secret-redaction registry along with
      // the session — the DOM is going away. Without this, the
      // registry would leak across many disconnects, bounded only
      // by process exit.
      clearFilledSecrets(id);
      if (!session) continue;
      // Stop + save the opt-in session trace before the context goes away
      // (no-op unless this task holds the trace). Never throws.
      await stopSessionTrace(id, session.context);
      try {
        // Spawned and cdp both share a single context — close just the
        // pages we own. teardownHandle below closes the whole context for the
        // spawned transport (so agent-opened pages would go away anyway), but
        // in CDP mode the user's browser process stays alive, so any
        // agent-opened tabs we don't close here would survive disconnect
        // as orphan tabs in the user's window. Bound each close so a wedged
        // page can't block reaching teardownHandle.
        for (const page of session.ownedPageIds) {
          await settledWithin(page.close(), teardownCloseTimeoutMs);
        }
        session.ownedPageIds.clear();
      } catch {
        // ignore
      }
    }
    consoleLogs.clear();
    if (shared) {
      // Either the handle survived the entire drain, or pendingShared
      // resolved between the generation check and now and installed itself
      // into shared (the ensureShared post-await re-check usually catches
      // this and throws, but a future refactor or a same-generation race
      // could still land here). Tear it down regardless.
      await teardownHandle(shared).catch(() => undefined);
      shared = null;
    }
    if (sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = undefined;
    }
  } finally {
    inFlightDisconnects--;
  }
}

export async function closeAll(): Promise<void> {
  // Bump the generation so an in-flight launch that resolves during this
  // teardown sees the mismatch and tears its own handle down instead of
  // installing it into `shared` after our cleanup ran (a leak past process
  // exit). Then drain the in-flight launch before tearing down, mirroring
  // disconnectSharedBrowser.
  disconnectGeneration++;
  if (pendingShared) {
    await pendingShared.catch(() => undefined);
  }
  const ids = Array.from(sessions.keys());
  for (const id of ids) {
    const session = sessions.get(id);
    sessions.delete(id);
    // Match closeSession / disconnectSharedBrowser: drop the
    // per-task secret-redaction registry alongside the session.
    clearFilledSecrets(id);
    if (!session) continue;
    // Stop + save the opt-in session trace before teardown (no-op unless
    // this task holds the trace). Never throws.
    await stopSessionTrace(id, session.context);
    try {
      // Close every agent-owned page. In CDP mode this is the only thing
      // that reaps agent-opened tabs (the user's browser stays alive).
      // In persistent mode teardownHandle closes the whole context next,
      // so this is harmless redundancy. Bound each close so a wedged page
      // can't block teardown.
      for (const page of session.ownedPageIds) {
        await settledWithin(page.close(), teardownCloseTimeoutMs);
      }
      session.ownedPageIds.clear();
    } catch {
      // ignore
    }
  }
  consoleLogs.clear();
  if (shared) {
    await teardownHandle(shared).catch(() => undefined);
    shared = null;
  }
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = undefined;
  }
}

// Cloud metadata endpoints and link-local IPs we never want the agent to
// poke at, even though Gini is local-first. The 169.254.0.0/16 check
// covers AWS, Azure, and other cloud-provider quirks in one shot.
const BLOCKED_HOSTNAMES = new Set([
  "169.254.169.254",
  "100.100.100.200",
  "metadata.google.internal",
  "metadata.goog",
  // Loopback + unspecified — the agent's BFF and runtime listen on
  // these addresses, and the BFF's catch-all /api/runtime/* proxy
  // injects the runtime bearer for any safe-method loopback request
  // (no Origin header from a server-driven browser navigation). Without
  // these entries an agent could navigate the controlled browser to
  // http://127.0.0.1:<bff-port>/api/runtime/approvals and read state
  // including the messaging.approve_pairing payload's verificationCode.
  // Mirrors the broader loopback block on the web_fetch tool.
  "127.0.0.1",
  "0.0.0.0",
  "localhost",
  "::1"
]);

export const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /xoxb-[A-Za-z0-9-]{20,}/,
  /xoxp-[A-Za-z0-9-]{20,}/,
  /AKIA[0-9A-Z]{16}/
];

function isLinkLocal(host: string): boolean {
  // 169.254.0.0/16
  return /^169\.254\.\d{1,3}\.\d{1,3}$/.test(host);
}

// Decode IPv4-mapped IPv6 forms to their embedded dotted-IPv4
// representation, so downstream checks can apply uniform IPv4 logic
// (loopback / metadata / link-local) without three separate paths
// for the equivalent IPv6 spellings. Returns undefined when the
// host is not an IPv4-mapped IPv6 literal.
function decodeIpv4Mapped(host: string): string | undefined {
  // Mixed dot-quad form: ::ffff:127.0.0.1
  const dotQuad = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(host);
  if (dotQuad) return dotQuad[1]!;
  // Hex IPv4-mapped: ::ffff:wwxx:yyzz
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
  // Deprecated IPv4-compatible: ::wwxx:yyzz (no ffff). Bun
  // normalizes [::127.0.0.1] to [::7f00:1].
  const compatHex = /^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
  const hex = hexMapped ?? compatHex;
  if (hex) {
    const hi = parseInt(hex[1]!, 16);
    const lo = parseInt(hex[2]!, 16);
    if (Number.isFinite(hi) && Number.isFinite(lo)) {
      return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    }
  }
  return undefined;
}

// Lightweight IPv6 guard. WHATWG URL hands back hostnames in canonical
// lowercase form, but `[::1]` style brackets are preserved for IPv6
// literals. Strip the brackets, then close the explicit bypasses we know
// about (link-local fe80::/10, loopback ::1, IPv4-mapped ::ffff:a.b.c.d).
// Not a full SSRF sandbox — proportional to the design's "lightweight
// guard" intent.
function isBlockedIpv6(host: string): string | undefined {
  // fe80::/10 — first 10 bits are 1111 1110 10, so the first 16 bits fall
  // in fe80..febf. Require all four hex digits in the leading group so
  // shorter forms like `fe8::` (which expand to 0fe8::, outside the range)
  // don't false-positive. fe8a:: is inside the range and correctly matches.
  if (/^fe[89ab][0-9a-f]:/i.test(host)) {
    return `Blocked: ${host} is an IPv6 link-local address.`;
  }
  if (host === "::1") {
    return `Blocked: ${host} is the IPv6 loopback address.`;
  }
  // ::ffff:a.b.c.d — IPv4-mapped IPv6 in dotted-quad form. Re-run the
  // IPv4 link-local / metadata check against the trailing dotted quad.
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(host);
  if (mapped) {
    const ipv4 = mapped[1]!;
    if (BLOCKED_HOSTNAMES.has(ipv4)) {
      return `Blocked: ${host} maps to ${ipv4}, a cloud metadata endpoint.`;
    }
    if (isLinkLocal(ipv4)) {
      return `Blocked: ${host} maps to ${ipv4}, a link-local address.`;
    }
  }
  // ::ffff:HHHH:HHHH — same IPv4-mapped address but in canonical hex form.
  // Bun normalizes `[::ffff:169.254.169.254]` to `[::ffff:a9fe:a9fe]`, so
  // the dotted-quad regex above never matches. Decode the two trailing
  // 16-bit groups back into a dotted quad and re-run the IPv4 checks.
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
  if (mappedHex) {
    const high = parseInt(mappedHex[1]!, 16);
    const low = parseInt(mappedHex[2]!, 16);
    const a = (high >> 8) & 0xff;
    const b = high & 0xff;
    const c = (low >> 8) & 0xff;
    const d = low & 0xff;
    const ipv4 = `${a}.${b}.${c}.${d}`;
    if (BLOCKED_HOSTNAMES.has(ipv4)) {
      return `Blocked: ${host} maps to ${ipv4}, a cloud metadata endpoint.`;
    }
    if (isLinkLocal(ipv4)) {
      return `Blocked: ${host} maps to ${ipv4}, a link-local address.`;
    }
  }
  return undefined;
}

// The bare loopback hostnames the agent's browser may never reach.
// safetyCheck and hostnameIsLoopback share this one array so they can't
// drift. (browser_console's in-page guard pins the validated origin rather
// than re-classifying hosts, so it does not consume this list.)
const LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "0.0.0.0", "localhost", "::1"];

// True when `hostname` denotes a loopback origin: an exact LOOPBACK_HOSTS
// entry, anything in 127.0.0.0/8, or a name under the `.localhost` TLD.
// Strips IPv6 brackets and a trailing root dot and lowercases first, so
// bracketed / fully-qualified / mixed-case forms classify the same as their
// bare form. Used by safetyCheck — which separately decodes IPv4-mapped /
// compat IPv6 forms to a dotted quad before calling this — and exported so
// the predicate is unit-testable on its own.
export function hostnameIsLoopback(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  return LOOPBACK_HOSTS.includes(h) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) || h.endsWith(".localhost");
}

// Exported for direct unit testing in src/tools/browser.test.ts.
// Returns undefined when the URL is allowed; otherwise a human-readable
// reason starting with "Blocked:" or "Invalid URL:". `allowLoopback` opts out
// of the loopback block for callers that LEGITIMATELY need loopback access:
// the cdp-attach path validates a user-supplied CDP URL that is always loopback
// (127.0.0.1:9222 or similar), which is exactly the target the SSRF block
// refuses for agent navigation. Two intents, one validator. Agent navigation
// never passes allowLoopback, so a loopback URL stays refused there.
export function safetyCheck(rawUrl: string, options: { allowLoopback?: boolean } = {}): string | undefined {
  // Run the secret-pattern scan against the raw input *before* attempting
  // to parse the URL. A malformed-but-secret-bearing input would otherwise
  // fall through to the `Invalid URL: ${rawUrl}` branch and leak the token
  // into the trace + audit row. Short-circuiting here keeps the error
  // surface free of the original string.
  //
  // decodeURIComponent is all-or-nothing — a single bad escape (e.g. `%zz`)
  // throws and we'd fall back to scanning only the raw form, missing tokens
  // that happen to be percent-encoded alongside other malformed escapes
  // (e.g. `http://example.com/%zz/%73%6b-ant-...`). Decode each `%HH`
  // independently so a single bad escape doesn't blind the rest of the scan.
  const decoded = rawUrl.replace(/%([0-9a-f]{2})/gi, (match, hex: string) => {
    try {
      return decodeURIComponent(`%${hex}`);
    } catch {
      return match;
    }
  });
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(rawUrl) || pattern.test(decoded)) {
      return "Blocked: URL appears to contain an API key or token.";
    }
  }
  // Outbound exfiltration gate: SECRET_PATTERNS above only catches
  // pattern-shaped tokens. The values the agent typed via
  // browser_fill_secrets are arbitrary strings, and a compromised page
  // could steer the model into composing a navigation URL that carries
  // one out (`https://evil.test/?q=<secret>`). Scan the raw AND
  // percent-decoded forms against the cross-task registered-secret
  // union. Values below the redaction floor are skipped for the same
  // reason recordFilledSecret refuses them: a tiny value substring-
  // matches structural URL bytes and would false-positive. The message
  // is deliberately generic — echoing the value or naming which secret
  // matched would leak it into the trace + audit row.
  for (const secret of allRegisteredSecrets()) {
    if (secret.length < FILLED_SECRET_MIN_REDACTION_LENGTH) continue;
    if (rawUrl.includes(secret) || decoded.includes(secret)) {
      return "Blocked: URL contains a registered secret value.";
    }
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return `Invalid URL: ${rawUrl}`;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `Blocked: only http(s) URLs are allowed (got ${parsed.protocol}).`;
  }
  // Strip IPv6 brackets so the comparisons below see the bare host.
  // Also strip a trailing dot — DNS roots are written with a trailing
  // "." (e.g. "localhost." or "127.0.0.1.") and resolvers treat them
  // as equivalent to the dotless form. Without the strip,
  // host.endsWith(".localhost") would miss "localhost.", letting a
  // crafted URL bypass the loopback block.
  const rawHost = parsed.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  // Decode IPv4-mapped IPv6 forms to their embedded IPv4 BEFORE
  // running any checks, so a mapped loopback (e.g. ::ffff:127.0.0.1
  // or ::ffff:7f00:1) goes through the same loopback gate as the
  // bare IPv4 form. Without this, the IPv6 branch's classifier would
  // route mapped loopback through the metadata path.
  const host = decodeIpv4Mapped(rawHost) ?? rawHost;
  const loopbackHosts = new Set(LOOPBACK_HOSTS);
  if (hostnameIsLoopback(host)) {
    if (options.allowLoopback) return undefined;
    return `Blocked: ${host} is a loopback address; the agent's browser may not reach the local BFF / runtime.`;
  }
  if (BLOCKED_HOSTNAMES.has(host)) {
    // Loopback entries are handled above; what reaches here is
    // cloud-metadata. (BLOCKED_HOSTNAMES still includes the loopback
    // entries so they get blocked even when the explicit-literal path
    // above misses an oddity, but the messaging here is cosmetic.)
    return `Blocked: ${host} is a cloud metadata endpoint.`;
  }
  if (isLinkLocal(host)) {
    return `Blocked: ${host} is a link-local address.`;
  }
  const ipv6Block = isBlockedIpv6(host);
  if (ipv6Block) {
    // The IPv4-mapped IPv6 forms are loopback iff the decoded IPv4
    // is loopback — but isBlockedIpv6 only matches metadata + link-
    // local IPv4. Decode again here for the loopback case so
    // [::7f00:1] (deprecated IPv4-compat for 127.0.0.1) doesn't
    // bypass the loopback block.
    return ipv6Block;
  }
  // Deprecated IPv4-compatible IPv6 form `::wwxx:yyzz` decodes to
  // IPv4 a.b.c.d where (a<<8|b) = wwxx and (c<<8|d) = yyzz. Bun
  // normalizes [::127.0.0.1] to [::7f00:1], so the explicit-literal
  // path above never sees the loopback form. Reclassify the decoded
  // IPv4 and reuse the loopback check.
  const compatHex = /^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
  if (compatHex) {
    const high = parseInt(compatHex[1]!, 16);
    const low = parseInt(compatHex[2]!, 16);
    const ipv4 = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
    if (loopbackHosts.has(ipv4) || /^127\./.test(ipv4)) {
      if (options.allowLoopback) return undefined;
      return `Blocked: ${host} maps to ${ipv4}, a loopback address.`;
    }
  }
  return undefined;
}

// Per-agent browsing boundary on top of the SSRF gate above. Returns a
// "Blocked:" reason when the URL's host is denied by (or, in allow-only
// mode, absent from) the agent's BrowserDomainPolicy; undefined when no
// policy applies or the host passes. Matching is exact host or subdomain
// suffix (`example.com` matches `sub.example.com`), case-insensitive, no
// wildcards. Deny is checked first so an entry on both lists stays
// blocked. Unparseable URLs pass — safetyCheck already refuses them with
// its own message. The reason can name the host (unlike the registered-
// secret gate, nothing here is sensitive) so the model can route around
// the boundary instead of retrying. See ADR browser-domain-policy.md.
export function domainPolicyBlockReason(rawUrl: string, policy: BrowserDomainPolicy | undefined): string | undefined {
  if (!policy) return undefined;
  const deny = Array.isArray(policy.deny) ? policy.deny : [];
  const allow = Array.isArray(policy.allow) ? policy.allow : [];
  if (deny.length === 0 && allow.length === 0) return undefined;
  let hostname: string;
  try {
    hostname = new URL(rawUrl).hostname;
  } catch {
    return undefined;
  }
  // Same host normalization as safetyCheck: strip IPv6 brackets and the
  // trailing root dot, lowercase.
  const host = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  const matches = (entry: string): boolean => {
    const domain = entry.replace(/\.$/, "").toLowerCase();
    return domain.length > 0 && (host === domain || host.endsWith(`.${domain}`));
  };
  if (deny.some(matches)) {
    return `Blocked: ${host} is denied by the agent's browser domain policy.`;
  }
  if (allow.length > 0 && !allow.some(matches)) {
    return `Blocked: ${host} is not in the agent's allowed browsing domains (agent domain policy is allow-only).`;
  }
  return undefined;
}

// Resolve the task's owning agent's BrowserDomainPolicy through the same
// state channel activeBrowserRecord uses. Returns undefined — no policy,
// nothing blocked — when no runtime instance is registered (tests / direct
// tool callers), the task has no agentId (system-driven flows), or the
// state read fails; the always-on SSRF gate still applies in every one of
// those cases.
function agentDomainPolicyForTask(taskId: string | undefined): BrowserDomainPolicy | undefined {
  if (!runtimeInstance || !taskId) return undefined;
  try {
    const state = readState(runtimeInstance);
    const agentId = state.tasks.find((task) => task.id === taskId)?.agentId;
    if (!agentId) return undefined;
    return state.agents.find((agent) => agent.id === agentId)?.browserDomainPolicy;
  } catch {
    return undefined;
  }
}

// Shared origin boundary check for any tool that reads or executes against
// the live page. Returns the safetyCheck reason — covering EVERY origin
// safetyCheck refuses (loopback control-plane, cloud metadata, link-local)
// — or the agent domain-policy reason when the page's current URL is
// disallowed, otherwise undefined; bounces
// the page to about:blank (best-effort) on a block. browser_navigate blocks
// these targets up front, but a page can still settle on one afterward via
// JS navigation, meta-refresh, a link click, or a CDP-attached tab already
// parked there. snapshot() calls this before reading page state;
// browser_console before evaluating agent JS; browser_vision before/after
// the screenshot.
//
// Test mocks pass minimal page stubs (often only `evaluate`). Guarding
// url()/goto() behind typeof keeps those mocks from having to grow a
// surface just to clear this check.
async function disallowedOriginReason(page: Page, taskId?: string): Promise<string | undefined> {
  if (typeof page.url !== "function") return undefined;
  const currentUrl = page.url();
  if (!currentUrl || currentUrl === "about:blank") return undefined;
  const blocked = safetyCheck(currentUrl) ?? domainPolicyBlockReason(currentUrl, agentDomainPolicyForTask(taskId));
  if (!blocked) return undefined;
  if (typeof page.goto === "function") {
    try {
      await page.goto("about:blank", { waitUntil: "domcontentloaded" });
    } catch {
      /* best-effort cleanup */
    }
  }
  return blocked;
}

interface SnapEntry {
  ref: string;
  role: string;
  name: string;
  value: string;
  url: string;
  depth: number;
  full: boolean; // true when emitted only because we're in `full` mode
  hidden: boolean; // true when the element exists but isn't visible
  // Stamp id (e.g. "e7") of the same-origin iframe this entry was walked
  // from. Host-side ref resolution chains through
  // page.frameLocator('[data-gini-ref="e7"]') for these entries since
  // page.locator does not pierce iframes.
  frameRef?: string;
  // For role:"iframe" rows of walkable same-origin frames: the frame
  // document's URL, checked host-side against safetyCheck + the agent
  // domain policy. A blocked frame keeps its placeholder row but has
  // its content rows stripped before the snapshot text is assembled.
  frameUrl?: string;
  // Rendering marker appended to placeholder rows (" [cross-origin]",
  // " [blocked]").
  note?: string;
}

// Cap on the number of invisible-but-locatable interactive elements we
// emit per snapshot. A page with thousands of hidden nodes (e.g. a
// virtualized list with prerendered rows) would otherwise blow up the
// snapshot. Visible entries are budgeted separately via SNAPSHOT_CHAR_BUDGET.
const SNAPSHOT_HIDDEN_BUDGET = 50;

// Cap on cursor-interactive ("clickable") emissions per snapshot. Div-soup
// pages style every card/row cursor:pointer; without a cap those rows would
// crowd real controls out of the 32KB char budget. Capped separately from
// the hidden budget for the same reason hidden entries are: a marker line
// tells the model more clickables exist. Ported from agent-browser's
// cursor-interactivity pass; see ADR browser-automation-engine.md.
const SNAPSHOT_CLICKABLE_BUDGET = 75;

// Per-row cap on prose-text emission (full-mode only). A prose container
// (e.g. a comment body, an article paragraph block) gets ONE "text" row
// holding its direct text content, sliced to this length so a single
// long block can't dominate the snapshot. Many rows still ride the
// shared SNAPSHOT_CHAR_BUDGET, so a text-heavy page truncates via the
// existing counted markers / aux-summary remainder path.
const SNAPSHOT_TEXT_ROW_MAX_CHARS = 400;

// Bot-wall / challenge-page detection. Challenge interstitials
// (Cloudflare "Just a moment...", CAPTCHA walls, Akamai / PerimeterX
// blocks) render no DOM the agent can act on and never change on
// re-snapshot, so a model that keeps re-snapshotting one burns its
// whole context window on identical challenge trees. The heuristic is
// deliberately structural to avoid flagging pages that merely TALK
// about CAPTCHAs: suspect a bot wall only when the page TITLE matches
// a known challenge title, or an IFRAME row in the snapshot text (the
// walker emits every frame as `iframe "name|src"`) points at a known
// challenge/captcha provider. Bare body-text mentions ("captcha",
// "verify you are human" in a paragraph or link) never trigger on
// their own.
const BOT_WALL_TITLE_MARKERS = [
  "just a moment", // Cloudflare interstitial
  "checking your browser", // Cloudflare legacy interstitial
  "attention required", // Cloudflare block page
  "access denied", // Akamai / generic edge block
  "pardon our interruption", // PerimeterX / HUMAN
  "verify you are human",
  "are you a robot",
  "human verification"
];
const BOT_WALL_IFRAME_MARKERS = [
  "challenges.cloudflare.com", // Turnstile / managed challenge
  "/cdn-cgi/challenge-platform", // Cloudflare challenge assets
  "hcaptcha.com",
  "google.com/recaptcha",
  "recaptcha.net",
  "geo.captcha-delivery.com", // DataDome
  "px-captcha", // PerimeterX
  "arkoselabs.com" // FunCaptcha
];
const BOT_WALL_WARNING =
  "This page appears to be a bot-detection challenge (CAPTCHA / interstitial). Re-snapshotting will not get past it — stop retrying and report the block to the user.";

function detectBotWall(title: string, snapshotText: string): boolean {
  const t = title.toLowerCase();
  if (BOT_WALL_TITLE_MARKERS.some((marker) => t.includes(marker))) return true;
  for (const line of snapshotText.split("\n")) {
    if (!line.includes('iframe "')) continue;
    const lowered = line.toLowerCase();
    if (BOT_WALL_IFRAME_MARKERS.some((marker) => lowered.includes(marker))) return true;
  }
  return false;
}

interface SnapshotResult {
  text: string;
  refs: Map<string, RefTarget>;
  // Ref-bearing entries rendered in `text` — what the model sees on the
  // plain counted-truncation path.
  elementCount: number;
  // Ref-bearing entries that fell past the char budget into the bounded
  // remainder. Their refs ARE registered (an @eN a summary preserves stays
  // actionable); result builders add this to elementCount only when the
  // aux summary is actually appended.
  remainderElementCount: number;
  truncated: boolean;
  // True when this snapshot detected a navigation (URL change since the
  // session's last snapshot, or an explicit navigate/back/tab swap that
  // dropped lastSnapshotUrl). Stamps were cleared and numbering reset;
  // callers must NOT diff this snapshot against the pre-navigation one.
  navigated: boolean;
  // True when the page looks like a bot-detection challenge (see
  // detectBotWall above). Result-building callers pair it with
  // BOT_WALL_WARNING so the model stops re-snapshotting.
  botWallSuspected: boolean;
  // Redacted text of the entries that did not fit the char budget
  // (bounded at SNAPSHOT_SUMMARY_INPUT_CAP). First-visit result builders
  // (browser_navigate / browser_snapshot) summarize it via an aux model;
  // diff-mode consumers ignore it. Absent when nothing was clipped.
  truncatedRemainder?: string;
}

// Aux-model summarization of an over-budget first-visit snapshot. Diff
// mode already keeps multi-step loops small; a big FIRST landing (the
// initial navigate or an explicit browser_snapshot) used to silently
// lose everything past SNAPSHOT_CHAR_BUDGET. Instead, the clipped
// remainder (post-redaction) is summarized by a single bounded aux text
// call and appended under a divider; plain counted truncation remains
// the fallback when no runtime config reached the tool or the aux call
// fails. Input and output are both bounded to keep the added latency
// one small side-call on over-budget first visits only.
const SNAPSHOT_SUMMARY_INPUT_CAP = 64_000;
const SNAPSHOT_SUMMARY_MAX_TOKENS = 1_024;
const SNAPSHOT_SUMMARY_DIVIDER =
  "[--- remainder summarized by aux model; @eN refs preserved and actionable ---]";
const SNAPSHOT_SUMMARY_SYSTEM =
  "You summarize the overflow portion of a web-page accessibility snapshot for a browser-automation agent. "
  + "Preserve element ref tokens like [@e12] VERBATIM next to the controls they belong to — the agent acts on those refs. "
  + "Collapse repetitive rows (lists, cards, nav items) into one line each with representative refs. Plain text only, be concise.";

// Returns the aux summary of a clipped snapshot remainder, or undefined
// when the call fails (callers then keep the plain counted truncation).
// `remainder` must already be redacted — snapshot() redacts it with the
// same pass as the snapshot text itself.
//
// Known limitation: this routes to the GLOBAL config.provider, not a
// per-agent provider override — tool dispatch doesn't thread the
// resolved effective provider down to the browser tools, so the
// (redacted) remainder of an agent's snapshot can go to the global
// provider even when the agent's chat turns use a different one. Fixing
// it means threading the effective provider through dispatchToolCall
// into every snapshot-producing browser tool.
async function summarizeSnapshotRemainder(config: RuntimeConfig, remainder: string): Promise<string | undefined> {
  try {
    const result = await generateAuxText(config, {
      system: SNAPSHOT_SUMMARY_SYSTEM,
      user: remainder.slice(0, SNAPSHOT_SUMMARY_INPUT_CAP),
      maxTokens: SNAPSHOT_SUMMARY_MAX_TOKENS
    });
    void recordUsage(config.instance, { source: "aux" }, result.cost).catch(() => {});
    const summary = result.text.trim();
    return summary.length > 0 ? summary : undefined;
  } catch {
    return undefined;
  }
}

// Shared by browser_navigate / browser_snapshot: append the aux summary
// of the clipped remainder under a divider, or return the text unchanged
// when summarization is unavailable. The summary still rides the ok()
// deep-redaction pass like every other string in the result. `summarized`
// tells the caller whether the remainder's refs are reachable from this
// result (so they belong in its elementCount) or were clipped away.
async function withSummarizedRemainder(
  text: string,
  truncatedRemainder: string | undefined,
  config: RuntimeConfig | undefined
): Promise<{ text: string; summarized: boolean }> {
  if (truncatedRemainder === undefined || config === undefined) return { text, summarized: false };
  const summary = await summarizeSnapshotRemainder(config, truncatedRemainder);
  if (summary === undefined) return { text, summarized: false };
  return { text: `${text}\n${SNAPSHOT_SUMMARY_DIVIDER}\n${summary}`, summarized: true };
}

// Marker attribute stamped on snapshot-rendered elements so the
// "@<id>" ref tokens the LLM sees in a snapshot can be translated
// back into playwright locators by callers outside snapshot() —
// principally browserFillByLocator below.
const REF_ATTR_GLOBAL = "data-gini-ref";

// Walk the page in the browser and return a flat list of "interesting"
// nodes plus a unique CSS-attribute ref we can use to resolve a Locator
// later. Built in a single page.evaluate so we minimize round-trips and
// reuse one DOM walk for both the snapshot text and the locator map.
async function snapshot(page: Page, full: boolean, taskId?: string): Promise<SnapshotResult> {
  // Single-point loopback check before reading page state. Any
  // browser action — direct navigate, click, type, scroll — can
  // settle the page on a different URL than the agent originally
  // requested, via JS navigation / meta-refresh / link click. The
  // R14 fix protected browser_navigate's post-redirect URL but
  // didn't cover those other paths. Snapshotting / returning the
  // URL of a loopback page would expose any local BFF / runtime
  // state the page rendered. Refuse at the snapshot boundary so
  // every caller (browser_snapshot, browser_click, browser_type,
  // browser_back, etc.) inherits the same gate. Try to clean up
  // by navigating the page away to about:blank — best-effort.
  //
  // Test mocks for the snapshot walker pass minimal page stubs
  // (only evaluate is mocked, since the walker only needs DOM
  // access). Guard the url()/goto() calls behind typeof checks so
  // existing unit tests don't have to grow the mock surface.
  const loopbackBlock = await disallowedOriginReason(page, taskId);
  if (loopbackBlock) {
    throw new Error(`${loopbackBlock} (page settled on disallowed URL after a navigation; agent must not inspect this surface)`);
  }
  const REF_ATTR = REF_ATTR_GLOBAL;
  // Refs are STABLE within a page lifetime: the walker below reuses an
  // element's existing data-gini-ref stamp and allocates new ids only
  // for unstamped elements, so refs the model holds from earlier
  // snapshots keep resolving and post-action diffs line up. Stamps are
  // cleared and numbering restarts at @e1 ONLY on navigation — detected
  // here as a URL change since the session's last snapshot (navigate /
  // back / tab swaps force it by dropping lastSnapshotUrl). The clear
  // pass actively strips stamps rather than trusting the new document
  // to be clean, because a bfcache-restored history entry can resurrect
  // a stamped DOM. See ADR browser-automation-engine.md.
  const session = taskId !== undefined ? sessions.get(taskId) : undefined;
  const currentUrl = typeof page.url === "function" ? page.url() : "";
  const navigated = session !== undefined && session.lastSnapshotUrl !== currentUrl;
  if (navigated && session) {
    await page.evaluate((attr) => {
      const clearDoc = (doc: Pick<Document, "querySelectorAll">): void => {
        for (const el of doc.querySelectorAll(`[${attr}]`)) el.removeAttribute(attr);
      };
      clearDoc(document);
      // Same-origin iframe documents carry stamps from the inline frame
      // walk; strip those too (cross-origin access throws — skip).
      for (const frame of Array.from(document.querySelectorAll("iframe"))) {
        try {
          const doc = (frame as HTMLIFrameElement).contentDocument;
          if (doc) clearDoc(doc);
        } catch {
          /* cross-origin frame — nothing of ours in there */
        }
      }
    }, REF_ATTR).catch(() => undefined);
    session.nextRefId = 1;
    session.lastSnapshotText = undefined;
  }
  const startId = session?.nextRefId ?? 1;

  type Raw = {
    ref: string;
    role: string;
    name: string;
    value: string;
    url: string;
    depth: number;
    full: boolean;
    hidden: boolean;
    frameRef?: string;
    frameUrl?: string;
    note?: string;
  };

  const raw = await page.evaluate(
    ({ attr, fullMode, hiddenBudget, clickableBudget, textRowMaxChars, startId }: { attr: string; fullMode: boolean; hiddenBudget: number; clickableBudget: number; textRowMaxChars: number; startId: number }) => {
      const INTERACTIVE_TAGS = new Set([
        "A",
        "BUTTON",
        "INPUT",
        "SELECT",
        "TEXTAREA",
        "OPTION",
        "SUMMARY"
      ]);
      const ROLE_FROM_TAG: Record<string, string> = {
        A: "link",
        BUTTON: "button",
        SELECT: "combobox",
        TEXTAREA: "textbox",
        OPTION: "option",
        SUMMARY: "button"
      };
      const INPUT_ROLE: Record<string, string> = {
        button: "button",
        submit: "button",
        reset: "button",
        checkbox: "checkbox",
        radio: "radio",
        range: "slider",
        search: "searchbox",
        email: "textbox",
        text: "textbox",
        password: "textbox",
        tel: "textbox",
        url: "textbox",
        number: "spinbutton",
        // `file` is a first-class role so the model can distinguish a
        // file-picker input from a normal textbox — most upload widgets
        // hide the underlying <input type="file"> behind a styled button,
        // and the agent needs to be able to target the input by ref.
        file: "file"
      };

      const roleOf = (el: Element): string | undefined => {
        const explicit = el.getAttribute("role");
        if (explicit) return explicit;
        if (el.tagName === "INPUT") {
          const type = (el as HTMLInputElement).type?.toLowerCase() ?? "text";
          return INPUT_ROLE[type] ?? "textbox";
        }
        return ROLE_FROM_TAG[el.tagName];
      };

      // Document/window of the element itself: inline-walked same-origin
      // iframe elements belong to the FRAME's document, so id lookups
      // (aria-labelledby, label[for]) and computed styles must resolve
      // against that document/view, not the main frame's. Falls back to
      // the globals for elements without ownerDocument wiring (the unit-
      // test fakes).
      const docOf = (el: Element): Document => (el.ownerDocument ?? document) as Document;
      const viewOf = (el: Element): Window => (el.ownerDocument?.defaultView ?? window) as Window;

      const nameOf = (el: Element): string => {
        const aria = el.getAttribute("aria-label");
        if (aria) return aria.trim();
        const labelledby = el.getAttribute("aria-labelledby");
        if (labelledby) {
          const refs = labelledby.split(/\s+/).map((id) => docOf(el).getElementById(id)?.textContent ?? "");
          const joined = refs.join(" ").trim();
          if (joined) return joined;
        }
        if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
          const id = el.getAttribute("id");
          if (id) {
            const lbl = docOf(el).querySelector(`label[for="${CSS.escape(id)}"]`);
            const text = lbl?.textContent?.trim();
            if (text) return text;
          }
          const placeholder = el.getAttribute("placeholder");
          if (placeholder) return placeholder.trim();
        }
        // For elements stamped with data-gini-secret (contenteditable
        // fields filled via fill_secret), the textContent holds the
        // typed value — same risk as <input>.value would carry. Mask
        // the name with "[redacted]" so the snapshot doesn't leak the
        // typed bytes via the entry's name field.
        if (el.getAttribute("data-gini-secret") !== null) {
          const raw = (el.textContent ?? "").trim();
          return raw.length > 0 ? "[redacted]" : "";
        }
        const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
        return text.slice(0, 120);
      };

      // A nameless clickable that wraps only an icon (an <svg>, or a known
      // icon <i>/font-icon child) carries no accessible name, so nameOf
      // returns "". Detect that case so the walker can synthesize a stable
      // clickable handle instead of dropping the control. Class names like
      // "icon", "fa-", "material-icons" are the conventional font-icon
      // signals; the check is shallow on purpose — an icon nested several
      // structural levels deep belongs to a different control.
      const hasIconChild = (el: Element): boolean => {
        for (const child of Array.from(el.children)) {
          if (child.tagName === "SVG") return true;
          if (child.tagName === "I") {
            const cls = child.getAttribute("class") ?? "";
            if (/(^|\s)(icon|fa-|material-icons|glyphicon)/.test(cls)) return true;
          }
        }
        return false;
      };
      // Synthesize a name for a nameless-but-clearly-interactive clickable
      // (icon-only menu, three-dot button, etc.) so it earns a ref. Priority:
      // a descendant's aria-label/title (the icon usually carries it), then
      // the element's own title/aria-label, then test/automation hooks
      // (data-testid/data-test/name), else a generic handle. The name only
      // has to be a stable, human-recognizable click target — not perfect.
      const iconFallbackName = (el: Element): string => {
        for (const child of Array.from(el.children)) {
          const childAria = child.getAttribute("aria-label") ?? child.getAttribute("title");
          if (childAria && childAria.trim()) return childAria.trim();
        }
        const own = el.getAttribute("title") ?? el.getAttribute("aria-label");
        if (own && own.trim()) return own.trim();
        const hook = el.getAttribute("data-testid") ?? el.getAttribute("data-test") ?? el.getAttribute("name");
        if (hook && hook.trim()) return hook.trim();
        return hasIconChild(el) ? "icon button" : "button";
      };

      const isVisible = (el: Element): boolean => {
        const rect = (el as HTMLElement).getBoundingClientRect?.();
        if (!rect) return false;
        if (rect.width === 0 && rect.height === 0) return false;
        const style = viewOf(el).getComputedStyle(el as HTMLElement);
        if (style.display === "none" || style.visibility === "hidden") return false;
        return true;
      };

      // Prose-text emission (full mode only). A prose container — a div /
      // p of comment-body or article text whose element children are only
      // inline/text-level (e.g. <a>, <span>, <b>) — carries no interactive
      // role, so the accessibility walk would drop its text entirely. The
      // helpers below read the element's DIRECT text nodes only (NOT
      // recursive textContent, which would re-emit nested controls' names
      // that already get their own rows) and decide whether the element is
      // a leaf prose block worth one "text" row.
      const INLINE_TEXT_TAGS = new Set([
        "A", "ABBR", "B", "BR", "CITE", "CODE", "EM", "I", "MARK", "P",
        "Q", "S", "SMALL", "SPAN", "STRONG", "SUB", "SUP", "TIME", "U", "WBR"
      ]);
      // Direct child text nodes only — never descends into element
      // children, so a nested emitted control's name isn't duplicated here.
      // Test fakes without childNodes return "" (no text row), keeping
      // existing walker tests byte-identical unless they opt in.
      const directText = (el: Element): string => {
        const nodes = (el as Element & { childNodes?: ArrayLike<{ nodeType: number; textContent: string | null }> }).childNodes;
        if (!nodes) return "";
        let acc = "";
        for (const node of Array.from(nodes)) {
          // Node.TEXT_NODE === 3
          if (node.nodeType === 3) acc += `${node.textContent ?? ""} `;
        }
        return acc.replace(/\s+/g, " ").trim();
      };
      // A leaf prose block: every element child is inline/text-level (so
      // its prose belongs to this container, not to a nested structural
      // region that will be walked separately). Empty-children counts.
      const isProseContainer = (el: Element): boolean => {
        for (const child of Array.from(el.children)) {
          if (!INLINE_TEXT_TAGS.has(child.tagName)) return false;
        }
        return true;
      };

      const out: Raw[] = [];
      // Allocation starts above BOTH the session counter and any id
      // already stamped in the document. The session counter guards
      // against reusing a removed element's id for a different element;
      // the stamp scan guards against collisions when the counter and
      // the DOM disagree (bfcache restore carrying stamps the counter
      // never saw, or a unit-test walk with no session).
      let nextId = startId;
      // Ids are bounded to 9 digits: beyond that a page-planted stamp
      // could push the counter into float-imprecision territory (2^53)
      // where ++ stops incrementing and every fresh allocation collides.
      // Accessible same-origin iframe documents are scanned too — the
      // inline frame walk stamps elements in there, and missing them
      // would let the counter collide with a frame-held stamp.
      const stampScanDocs: Array<Pick<Document, "querySelectorAll">> = [document];
      for (const frame of Array.from(document.querySelectorAll("iframe"))) {
        try {
          const doc = (frame as HTMLIFrameElement).contentDocument;
          if (doc) stampScanDocs.push(doc);
        } catch {
          /* cross-origin frame — unreachable, carries no stamps of ours */
        }
      }
      for (const doc of stampScanDocs) {
        for (const el of Array.from(doc.querySelectorAll(`[${attr}]`))) {
          const m = /^e(\d{1,9})$/.exec(el.getAttribute(attr) ?? "");
          if (m) nextId = Math.max(nextId, Number(m[1]) + 1);
        }
      }
      // Reuse an existing stamp (refs are stable within a page lifetime);
      // only unstamped elements get a freshly-allocated id. Two stamps are
      // NOT trusted: a value that doesn't match our e<N> format (the page
      // set the attribute itself — honoring it would let page content pick
      // its own ref), and a value already reused this walk (cloneNode
      // copies attributes, so a cloned subtree carries duplicate stamps;
      // two elements sharing a ref breaks strict-mode resolution). Both
      // get restamped with a fresh id.
      const stampsThisWalk = new Set<string>();
      const refFor = (el: Element): string => {
        const existing = el.getAttribute(attr);
        if (existing && /^e\d{1,9}$/.test(existing) && !stampsThisWalk.has(existing)) {
          stampsThisWalk.add(existing);
          return `@${existing}`;
        }
        const id = `e${nextId++}`;
        el.setAttribute(attr, id);
        stampsThisWalk.add(id);
        return `@${id}`;
      };
      let hiddenEmitted = 0;
      let hiddenTotal = 0;
      let clickableEmitted = 0;
      let clickableTotal = 0;
      // Elements already surfaced in THIS walk. The <select> branch
      // enumerates its <option> children eagerly (they have zero-size
      // rects, so the bare walk would only see them as hidden); when the
      // walk then recurses into those same options, this set stops a
      // second [hidden] row from being emitted for the same element —
      // with stable stamps the duplicate would even carry the same ref.
      const emittedThisWalk = new Set<Element>();
      const isFileInput = (el: Element): boolean =>
        el.tagName === "INPUT" && ((el as HTMLInputElement).type?.toLowerCase() ?? "text") === "file";
      // A radio/checkbox that fails isVisible but has an associated visible
      // <label> (wrapping it, or pointing at it via label[for]) is a styled
      // toggle: the page hides the native input and renders the label as
      // the control. Without a ref the agent can't toggle it at all, so it
      // is force-emitted with a [hidden] annotation — same treatment as the
      // file-input rule below, and exempt from the hidden budget for the
      // same reason. See ADR browser-automation-engine.md.
      const isHiddenToggleWithVisibleLabel = (el: Element): boolean => {
        if (el.tagName !== "INPUT") return false;
        const type = (el as HTMLInputElement).type?.toLowerCase() ?? "text";
        if (type !== "radio" && type !== "checkbox") return false;
        for (let p: Element | null = el.parentElement; p; p = p.parentElement) {
          if (p.tagName === "LABEL") return isVisible(p);
        }
        const id = el.getAttribute("id");
        if (id) {
          const lbl = docOf(el).querySelector(`label[for="${CSS.escape(id)}"]`);
          if (lbl && isVisible(lbl)) return true;
        }
        return false;
      };
      // `frameId` is the stamp id (e.g. "e7") of the same-origin iframe
      // currently being walked inline, or undefined in the main frame.
      // Entries emitted under a frame carry it as `frameRef` so host-side
      // ref resolution can chain through page.frameLocator (page.locator
      // does not pierce iframes).
      const walk = (el: Element, depth: number, underCursorClickable: boolean, frameId?: string): void => {
        const tag = el.tagName;
        // Iframes: every frame gets a row. Same-origin frames (reachable
        // via contentDocument) are walked INLINE one level deep, sharing
        // this walk's budgets and ref numbering; cross-origin frames
        // (contentDocument throws or is null) get an opaque placeholder.
        // Frames nested inside an already-inlined frame are placeholder-
        // only — host-side ref resolution chains exactly one frameLocator
        // hop. Whether a same-origin frame's CONTENT may be included is
        // decided host-side (safetyCheck + domain policy on frameUrl);
        // blocked frames keep the placeholder and lose their content rows.
        if (tag === "IFRAME") {
          const src = el.getAttribute("src") ?? "";
          const frameName = el.getAttribute("name") ?? el.getAttribute("title") ?? "";
          const label = [frameName, src].filter(Boolean).join("|") || "(no src)";
          const visible = isVisible(el);
          let frameDoc: Document | null = null;
          try {
            frameDoc = (el as HTMLIFrameElement).contentDocument;
          } catch {
            frameDoc = null;
          }
          if (!frameDoc || !frameDoc.body) {
            out.push({ ref: "", role: "iframe", name: label, value: "", url: "", depth, full: false, hidden: !visible, note: " [cross-origin]", frameRef: frameId });
            return;
          }
          if (!visible || frameId !== undefined) {
            // Hidden frames and frames nested inside an inlined frame:
            // placeholder only, no inline content.
            out.push({ ref: "", role: "iframe", name: label, value: "", url: "", depth, full: false, hidden: !visible, frameRef: frameId });
            return;
          }
          let frameUrl = src;
          try {
            frameUrl = frameDoc.location?.href || src;
          } catch {
            /* keep the src attribute as the best-effort URL */
          }
          const ref = refFor(el);
          out.push({ ref, role: "iframe", name: label, value: "", url: "", depth, full: false, hidden: false, frameUrl });
          walk(frameDoc.body, depth + 1, false, ref.slice(1));
          return;
        }
        const role = roleOf(el);
        const interactive = role !== undefined && (INTERACTIVE_TAGS.has(tag) || el.getAttribute("role"));
        const visible = isVisible(el);
        // When this element qualifies as a cursor-clickable via
        // cursor:pointer, descendants inherit that computed cursor and must
        // not each re-qualify on it (see the dedupe note below).
        let childUnderCursorClickable = underCursorClickable;
        // <input type="file"> always gets a ref — most real upload widgets
        // hide the actual input behind a styled button, and without a ref
        // browser_upload_file can't target it. Counted in the visible
        // budget regardless of visibility; the `[hidden]` annotation tells
        // the model the input isn't directly clickable.
        const forceEmit = interactive && (isFileInput(el) || (!visible && isHiddenToggleWithVisibleLabel(el)));
        if (emittedThisWalk.has(el)) {
          // Already surfaced (a <select>'s eager option enumeration) —
          // skip the emission branches, nothing below applies twice.
        } else if (interactive && (visible || forceEmit)) {
          const ref = refFor(el);
          let value = "";
          if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
            // Suppress sensitive input values so a user-typed
            // credential filled via browser.fill_secret does not
            // round-trip back into the LLM through the next
            // browser_snapshot. Trigger conditions:
            //   - type="password" (matches what the rendered
            //     browser visually masks)
            //   - autocomplete hints that the field is a credential
            //     or one-time code (covers cases where the page uses
            //     a custom text input + JS reveal)
            //   - data-gini-secret attribute stamped by
            //     browserFillByLocator after a successful fill, so a
            //     filled field stays masked even if the page swaps
            //     out the type (some SPAs flip type=text after fill
            //     to show the value visually)
            const input = el as HTMLInputElement;
            const inputType = (input.type || "").toLowerCase();
            const autocomplete = (input.getAttribute("autocomplete") || "").toLowerCase();
            // `getAttribute(...) !== null` works on both real DOM Element
            // and any minimal stub that implements only getAttribute (the
            // unit test fakes in browser.test.ts don't have hasAttribute).
            const isSecretField = inputType === "password"
              || autocomplete === "current-password"
              || autocomplete === "new-password"
              || autocomplete === "one-time-code"
              || input.getAttribute("data-gini-secret") !== null;
            const rawValue = input.value ?? "";
            value = isSecretField
              ? (rawValue.length > 0 ? "[redacted]" : "")
              : rawValue;
          } else if (el.tagName === "SELECT") {
            value = (el as HTMLSelectElement).value ?? "";
          }
          const url = el.tagName === "A" ? (el as HTMLAnchorElement).href : "";
          out.push({
            ref,
            role: role!,
            name: nameOf(el),
            value,
            url,
            depth,
            full: false,
            hidden: !visible,
            frameRef: frameId
          });
          // For <select>, surface its <option> children as sibling rows at
          // depth+1 so the agent can address each option by its own @eN
          // ref (browser_click / browser_select_option). The bare walker
          // skips <option> elements because they have a zero-size bounding
          // rect in the native renderer; we explicitly enumerate via
          // querySelectorAll so options nested inside <optgroup> are
          // captured too.
          if (tag === "SELECT" && visible) {
            const options = (el as HTMLSelectElement).querySelectorAll("option");
            for (const opt of Array.from(options)) {
              if (opt.disabled || opt.hidden) continue;
              emittedThisWalk.add(opt);
              const optRef = refFor(opt);
              const labelOrText = (opt.label || opt.text || "").trim().slice(0, 120);
              out.push({
                ref: optRef,
                role: "option",
                name: labelOrText,
                value: opt.value,
                url: "",
                depth: depth + 1,
                full: false,
                hidden: false,
                frameRef: frameId
              });
            }
          }
        } else if (interactive && !visible) {
          // Invisible interactive element — give it a ref so wait_for can
          // target it (state:"hidden"/"attached"/"detached"), but suppress
          // name/value/url annotations (they're usually empty or stale
          // and just add noise). Capped separately so a virtualized list
          // with thousands of prerendered rows doesn't blow up the snapshot.
          hiddenTotal++;
          if (hiddenEmitted < hiddenBudget) {
            const ref = refFor(el);
            out.push({
              ref,
              role: role!,
              name: "",
              value: "",
              url: "",
              depth,
              full: false,
              hidden: true,
              frameRef: frameId
            });
            hiddenEmitted++;
          }
        } else if (visible) {
          // Reaching here means the element is NOT semantically interactive
          // (no interactive tag, no explicit role — those were consumed by
          // the branches above). Cursor-interactivity augmentation: div-soup
          // UIs signal clickability through styling and handlers instead of
          // semantics, so a visible element with computed cursor:pointer, an
          // onclick attribute, or tabindex >= 0 still earns a ref, under the
          // synthetic role "clickable". Ported from agent-browser's
          // cursor-interactivity pass; see ADR browser-automation-engine.md.
          // BODY is excluded: a page styling `body { cursor: pointer }`
          // would otherwise emit the entire page text as one name AND
          // dedupe-suppress every real clickable underneath it.
          const cursorPointer = tag !== "BODY" && viewOf(el).getComputedStyle(el as HTMLElement).cursor === "pointer";
          const tabindexAttr = el.getAttribute("tabindex");
          const selfQualified = el.getAttribute("onclick") !== null
            || (tabindexAttr !== null && Number.parseInt(tabindexAttr, 10) >= 0);
          // The computed cursor is inherited, so inside a cursor-pointer
          // clickable every descendant reports cursor:pointer too. Dedupe:
          // pointer alone does not re-qualify a descendant (otherwise a
          // cursor:pointer card would emit every child); an element's OWN
          // onclick/tabindex always does.
          const qualifies = selfQualified || (cursorPointer && !underCursorClickable);
          // Empty-name clickables are usually un-targetable noise, so a bare
          // inherited-cursor:pointer descendant with no name stays skipped
          // (and a skipped element does not suppress its descendants — a
          // child may carry the only usable name, e.g. an aria-label inside
          // an icon-only wrapper). But an icon-only control the user can
          // really click — one that SELF-qualifies (own onclick/tabindex) or
          // qualifies AND wraps an <svg>/font-icon — has no first-class click
          // handle without a ref, forcing raw DOM dispatch. For those narrow
          // cases synthesize a name (see iconFallbackName) so they still earn
          // a ref instead of vanishing from the snapshot.
          let name = qualifies ? nameOf(el) : "";
          if (qualifies && !name && (selfQualified || hasIconChild(el))) {
            name = iconFallbackName(el);
          }
          if (qualifies && name) {
            clickableTotal++;
            if (clickableEmitted < clickableBudget) {
              const ref = refFor(el);
              out.push({ ref, role: "clickable", name, value: "", url: "", depth, full: false, hidden: false, frameRef: frameId });
              clickableEmitted++;
            }
            if (cursorPointer) childUnderCursorClickable = true;
          } else if (fullMode) {
            // In full mode, also record landmark/heading text so the snapshot
            // captures structural cues the model can use for orientation.
            const landmarkRoles = ["heading", "main", "navigation", "banner", "contentinfo", "region"];
            const tagToRole: Record<string, string> = {
              H1: "heading",
              H2: "heading",
              H3: "heading",
              H4: "heading",
              MAIN: "main",
              NAV: "navigation",
              HEADER: "banner",
              FOOTER: "contentinfo",
              ARTICLE: "article",
              SECTION: "region"
            };
            const fallbackRole = role ?? tagToRole[tag];
            let emittedLandmark = false;
            if (fallbackRole && landmarkRoles.includes(fallbackRole)) {
              const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
              if (text) {
                out.push({ ref: "", role: fallbackRole, name: text, value: "", url: "", depth, full: true, hidden: false, frameRef: frameId });
                emittedLandmark = true;
              }
            }
            // Prose-text fallback: a visible, non-interactive, non-clickable
            // leaf prose container (its element children are only
            // inline/text-level) gets ONE low-priority "text" row holding
            // its DIRECT text content. This captures comment bodies /
            // article paragraphs the accessibility walk would otherwise
            // drop. Skipped when a landmark row already covered this element
            // (no double-emit) and for data-gini-secret-stamped elements
            // (their text is the typed value — never emit raw). Inline child
            // links/spans still emit their own rows via the recursion below;
            // reading direct text nodes only means their names aren't
            // duplicated in this row. Sliced to bound a single block; the
            // post-pass redaction + SNAPSHOT_CHAR_BUDGET apply to it like
            // every other row.
            if (!emittedLandmark && el.getAttribute("data-gini-secret") === null && isProseContainer(el)) {
              const prose = directText(el).slice(0, textRowMaxChars);
              if (prose.length > 1) {
                out.push({ ref: "", role: "text", name: prose, value: "", url: "", depth, full: true, hidden: false, frameRef: frameId });
              }
            }
          }
        }
        for (const child of Array.from(el.children)) walk(child, depth + 1, childUnderCursorClickable, frameId);
      };
      walk(document.body, 0, false);
      return { entries: out, hiddenEmitted, hiddenTotal, hiddenBudget, clickableEmitted, clickableTotal, nextId };
    },
    { attr: REF_ATTR, fullMode: full, hiddenBudget: SNAPSHOT_HIDDEN_BUDGET, clickableBudget: SNAPSHOT_CLICKABLE_BUDGET, textRowMaxChars: SNAPSHOT_TEXT_ROW_MAX_CHARS, startId }
  );

  const refs = new Map<string, RefTarget>();
  // nth assignment for stale-ref healing: an element's index among
  // entries sharing its role+name in THIS walk, in emission (DOM) order.
  const nthByRoleName = new Map<string, number>();
  const lines: string[] = [];
  let charCount = 0;
  let truncated = false;
  let elementCount = 0;
  let remainderElementCount = 0;
  const allEntries = (raw as { entries: SnapEntry[] }).entries;
  // Frame gating: the walker inlines same-origin iframe content, but
  // whether that content may REACH the model is decided here, where the
  // SSRF gate and the agent domain policy live. A frame whose document
  // URL fails either check keeps its placeholder row (marked
  // " [blocked]", ref dropped) and loses every content row walked from
  // it. about:blank / about:srcdoc frames have no remote origin and are
  // allowed — mirrors the snapshot boundary's about:blank special case.
  const domainPolicy = agentDomainPolicyForTask(taskId);
  const blockedFrameIds = new Set<string>();
  for (const entry of allEntries) {
    if (entry.role === "iframe" && entry.ref && entry.frameUrl !== undefined) {
      const frameUrl = entry.frameUrl;
      const localDoc = frameUrl === "" || frameUrl === "about:blank" || frameUrl === "about:srcdoc";
      const blocked = localDoc ? undefined : safetyCheck(frameUrl) ?? domainPolicyBlockReason(frameUrl, domainPolicy);
      if (blocked) {
        blockedFrameIds.add(entry.ref.slice(1));
        entry.ref = "";
        entry.note = " [blocked]";
      }
    }
  }
  const entries = blockedFrameIds.size > 0
    ? allEntries.filter((e) => !e.frameRef || !blockedFrameIds.has(e.frameRef))
    : allEntries;
  const hiddenEmitted = (raw as { hiddenEmitted: number }).hiddenEmitted;
  const hiddenTotal = (raw as { hiddenTotal: number }).hiddenTotal;
  const clickableEmitted = (raw as { clickableEmitted: number }).clickableEmitted;
  const clickableTotal = (raw as { clickableTotal: number }).clickableTotal;
  // Persist the advanced allocator so the next snapshot in this session
  // never reuses an id. Test mocks return minimal walker shapes without
  // nextId — fall back to the unchanged startId for those.
  if (session) {
    const advanced = (raw as { nextId?: number }).nextId;
    session.nextRefId = typeof advanced === "number" ? advanced : startId;
  }
  // Lines past the char budget are collected (bounded) instead of being
  // dropped on the floor: first-visit result builders can hand them to an
  // aux model for summarization (see SNAPSHOT_SUMMARY_INPUT_CAP below).
  // Their refs are registered too, so an @eN the summary preserves stays
  // actionable — the stamps exist on the page either way.
  const remainderLines: string[] = [];
  let remainderChars = 0;
  for (const entry of entries) {
    const indent = "  ".repeat(entry.depth);
    let line: string;
    if (entry.ref) {
      line = `${indent}[${entry.ref}] ${entry.role}`;
      if (entry.hidden) {
        // Hidden entries get role + [hidden] only — no name/value/url
        // annotations, since they're typically empty or stale on
        // not-yet-shown / off-screen widgets and just add noise.
        line += " [hidden]";
      } else {
        if (entry.name) line += ` "${entry.name}"`;
        if (entry.value) line += ` value="${entry.value}"`;
        if (entry.role === "link" && entry.url) line += ` url="${entry.url}"`;
      }
    } else {
      line = `${indent}${entry.role} "${entry.name}"`;
      // Placeholder iframe rows annotate why their content is absent:
      // [hidden] (frame not visible), [cross-origin] (contentDocument
      // unreachable), or [blocked] (frame URL failed the SSRF gate /
      // domain policy above).
      if (entry.hidden) line += " [hidden]";
      if (entry.note) line += entry.note;
    }
    const clipped = truncated || charCount + line.length + 1 > SNAPSHOT_CHAR_BUDGET;
    if (clipped) {
      truncated = true;
      // Stop all work (rendering AND ref registration) once the
      // summarization input cap is full — the counted marker below only
      // needs entries.length, and refs for rows no summary will ever
      // mention are dead weight.
      if (remainderChars > SNAPSHOT_SUMMARY_INPUT_CAP) break;
      remainderLines.push(line);
      remainderChars += line.length + 1;
    } else {
      lines.push(line);
      charCount += line.length + 1;
    }
    if (entry.ref) {
      // nth is FRAME-LOCAL: healing re-queries page.getByRole / getByText,
      // which search the main frame only, so framed entries sharing a
      // role+name with main-frame ones must not inflate the main-frame
      // ordinals (framed refs never heal — see resolveRefForAction — so
      // their own nth is never queried).
      const nthKey = `${entry.frameRef ?? ""}\u0000${entry.role}\u0000${entry.name}`;
      const nth = nthByRoleName.get(nthKey) ?? 0;
      nthByRoleName.set(nthKey, nth + 1);
      // page.locator does not pierce iframes: entries walked from a
      // same-origin frame resolve through page.frameLocator on the
      // OWNING iframe's stamp, then the element's stamp inside it.
      // Fake test pages may not implement frameLocator — fall back to
      // the flat locator there (their refs are usually planted directly).
      const ownSelector = `[${REF_ATTR}="${entry.ref.slice(1)}"]`;
      const locator = entry.frameRef && typeof page.frameLocator === "function"
        ? page.frameLocator(`[${REF_ATTR}="${entry.frameRef}"]`).locator(ownSelector)
        : page.locator(ownSelector);
      refs.set(entry.ref, {
        locator,
        role: entry.role,
        name: entry.name,
        nth,
        ...(entry.frameRef ? { framed: true } : {})
      });
      // Count rendered and remainder refs separately so result builders
      // can report exactly what the model sees: rendered rows only on the
      // plain counted-truncation path, plus the remainder's refs when the
      // aux summary (which preserves them) is actually appended.
      if (clipped) remainderElementCount++;
      else elementCount++;
    }
  }
  let text = lines.join("\n");
  // Each truncation marker carries the omitted count so the model gets a
  // scroll-vs-stop signal (how much more is out there) instead of a bare
  // "there was more". Every entry renders exactly one line, so the
  // char-budget count is entries-not-emitted.
  if (truncated) text += `\n[...truncated +${entries.length - lines.length} more entries]`;
  // Separate marker for hidden-budget truncation so the model can tell
  // "more interactive elements exist on the page, just hidden" apart
  // from "snapshot text was clipped at the char budget".
  if (hiddenTotal > hiddenEmitted) text += `\n[...hidden truncated +${hiddenTotal - hiddenEmitted} more hidden]`;
  // Same idea for the clickable cap: tells the model more cursor-detected
  // clickables exist beyond SNAPSHOT_CLICKABLE_BUDGET, distinct from
  // char-budget clipping.
  if (clickableTotal > clickableEmitted) text += `\n[...clickable truncated +${clickableTotal - clickableEmitted} more clickables]`;
  // Defense in depth: redact any literal occurrence of a known
  // data-gini-secret value from the assembled snapshot text. The
  // walker's element-local redaction only catches the stamped
  // element itself — a page that JS-copies the typed value into
  // another DOM node (a "you typed: ..." preview, password-strength
  // widget echo, password-match indicator, hidden mirror input)
  // would otherwise emit the copy verbatim through the unmarked
  // element's name / textContent. Post-processing the assembled
  // snapshot text against the live secret list closes this gap
  // with the same primitive browserConsole and browserVision use.
  const secretValues = await collectSecretValuesFromPageWithSession(page, taskId);
  let remainderText = remainderLines.join("\n");
  if (secretValues.length > 0) {
    text = redactSecretValuesFromString(text, secretValues);
    // The remainder can be forwarded to an aux summarization model —
    // redact it with the exact same pass BEFORE it leaves this function,
    // so the aux provider never sees a secret the agent loop wouldn't.
    if (remainderText.length > 0) remainderText = redactSecretValuesFromString(remainderText, secretValues);
  }
  // Store the REDACTED text as the diff base for the next post-action
  // snapshot — diffing always compares redacted text against redacted
  // text, so the diff path cannot bypass secret suppression. Only
  // full=false walks set the base: post-action snapshots are always
  // full=false, and diffing one against a full=true tree (with its extra
  // landmark/heading rows) would render every landmark as a spurious
  // removal. The URL marker updates on EVERY walk regardless — it feeds
  // the navigation detector above, and skipping it after a full=true
  // snapshot would make the next walk strip every stamp on the page.
  if (session) {
    if (!full) session.lastSnapshotText = text;
    session.lastSnapshotUrl = currentUrl;
  }
  // Bot-wall sniff on the assembled (already-redacted) snapshot text plus
  // the page title. Fake test pages often mock only evaluate — guard the
  // title call like the url()/goto() guards above.
  const pageTitle = typeof page.title === "function" ? await page.title().catch(() => "") : "";
  const botWallSuspected = detectBotWall(pageTitle, text);
  return {
    text,
    refs,
    elementCount,
    remainderElementCount,
    truncated,
    navigated,
    botWallSuspected,
    ...(remainderText.length > 0 ? { truncatedRemainder: remainderText } : {})
  };
}

// Post-action snapshots return a line diff instead of the full tree when
// the diff body is smaller than this fraction of the full text. Above the
// threshold a diff stops paying for itself (the reader still has to
// reconstruct most of the page) so we return the full snapshot.
const SNAPSHOT_DIFF_MAX_RATIO = 0.6;
// Unchanged lines kept around each +/- run so the model can locate the
// change inside the tree without the full snapshot.
const SNAPSHOT_DIFF_CONTEXT_LINES = 1;
const SNAPSHOT_DIFF_HEADER =
  "[diff vs previous snapshot — + added, - removed; unchanged omitted. Call browser_snapshot for the full tree.]";

// Line-based diff of two snapshot texts, rendered unified-diff style
// (header + removed/added lines with SNAPSHOT_DIFF_CONTEXT_LINES of
// context). Implemented inline as a common-prefix/suffix trim plus an
// LCS over the changed middle — post-action changes are usually local,
// so the quadratic LCS only ever sees a small window. No dependency,
// no regex over page-controlled text. Returns undefined when the trimmed
// middle is too large to diff (see the cell cap below); the caller falls
// back to the full snapshot. See ADR browser-automation-engine.md.
function renderSnapshotDiff(prevText: string, currText: string): string | undefined {
  const prev = prevText.split("\n");
  const curr = currText.split("\n");
  let start = 0;
  while (start < prev.length && start < curr.length && prev[start] === curr[start]) start++;
  let prevEnd = prev.length;
  let currEnd = curr.length;
  while (prevEnd > start && currEnd > start && prev[prevEnd - 1] === curr[currEnd - 1]) {
    prevEnd--;
    currEnd--;
  }
  const a = prev.slice(start, prevEnd);
  const b = curr.slice(start, currEnd);
  // A change this widespread won't render as a useful diff anyway, and
  // the quadratic LCS table below would allocate (and fill) one cell per
  // line pair — cap the work and let the caller return the full tree.
  if (a.length * b.length > 1_000_000) return undefined;
  // LCS table over the trimmed middle; backtrack into an op list.
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table: Uint32Array[] = [];
  for (let i = 0; i < rows; i++) table.push(new Uint32Array(cols));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j]
        ? table[i + 1]![j + 1]! + 1
        : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const ops: Array<{ kind: "same" | "del" | "add"; line: string }> = [];
  for (let i = 0; i < start; i++) ops.push({ kind: "same", line: prev[i]! });
  let ai = 0;
  let bi = 0;
  while (ai < a.length && bi < b.length) {
    if (a[ai] === b[bi]) {
      ops.push({ kind: "same", line: a[ai]! });
      ai++;
      bi++;
    } else if (table[ai + 1]![bi]! >= table[ai]![bi + 1]!) {
      ops.push({ kind: "del", line: a[ai]! });
      ai++;
    } else {
      ops.push({ kind: "add", line: b[bi]! });
      bi++;
    }
  }
  while (ai < a.length) ops.push({ kind: "del", line: a[ai++]! });
  while (bi < b.length) ops.push({ kind: "add", line: b[bi++]! });
  for (let i = prevEnd; i < prev.length; i++) ops.push({ kind: "same", line: prev[i]! });
  // Render only changed lines plus nearby context.
  const keep = new Array<boolean>(ops.length).fill(false);
  let changed = false;
  for (let i = 0; i < ops.length; i++) {
    if (ops[i]!.kind === "same") continue;
    changed = true;
    const lo = Math.max(0, i - SNAPSHOT_DIFF_CONTEXT_LINES);
    const hi = Math.min(ops.length - 1, i + SNAPSHOT_DIFF_CONTEXT_LINES);
    for (let j = lo; j <= hi; j++) keep[j] = true;
  }
  // A header with no body reads like an empty page, not an unchanged
  // one — say so explicitly.
  if (!changed) return `${SNAPSHOT_DIFF_HEADER}\n(no changes)`;
  const lines: string[] = [SNAPSHOT_DIFF_HEADER];
  let prevKept = -1;
  for (let i = 0; i < ops.length; i++) {
    if (!keep[i]) continue;
    // Mark the gap between non-adjacent hunks — without it two distant
    // changes read as neighboring lines of the tree.
    if (prevKept !== -1 && i > prevKept + 1) lines.push("  ⋯");
    prevKept = i;
    const op = ops[i]!;
    lines.push(op.kind === "del" ? `- ${op.line}` : op.kind === "add" ? `+ ${op.line}` : `  ${op.line}`);
  }
  return lines.join("\n");
}

// Shared post-action snapshot: re-snapshot, refresh the session's refs,
// and return either the full tree or a line diff vs the previous snapshot
// when the change is small. Used by the action tools (click / type /
// press / scroll / hover / drag / select_option / wait_for) — NOT by
// browser_navigate, browser_back, browser_tabs, or explicit
// browser_snapshot, which always return the full tree. That asymmetry is
// the model's recovery path: when a diff isn't enough, browser_snapshot
// gets the whole page. Diffing compares the redacted previous text with
// the redacted current text (snapshot() redacts before returning and
// before storing the base), so the diff path cannot leak what redaction
// suppressed. See ADR browser-automation-engine.md.
async function snapshotAfterAction(
  session: Session,
  taskId: string
): Promise<{ snapshot: string; snapshotMode: "full" | "diff"; elementCount: number; truncated: boolean; botWallSuspected?: true; warning?: string }> {
  const prev = session.lastSnapshotText;
  const snap = await snapshot(session.page, false, taskId);
  session.refs = snap.refs;
  // An action can land the page on a challenge wall (e.g. a click that
  // navigated into a Cloudflare interstitial) — surface the same
  // botWallSuspected flag the navigate/snapshot results carry, so every
  // action tool inherits it via its spread of these fields.
  const botWall = snap.botWallSuspected ? { botWallSuspected: true as const, warning: BOT_WALL_WARNING } : {};
  if (!snap.navigated && prev !== undefined) {
    const diff = renderSnapshotDiff(prev, snap.text);
    if (diff !== undefined && diff.length < snap.text.length * SNAPSHOT_DIFF_MAX_RATIO) {
      return { snapshot: diff, snapshotMode: "diff", elementCount: snap.elementCount, truncated: snap.truncated, ...botWall };
    }
  }
  return { snapshot: snap.text, snapshotMode: "full", elementCount: snap.elementCount, truncated: snap.truncated, ...botWall };
}

// Resolve a ref for an action tool (click / type / hover / drag /
// select_option / wait_for), self-healing a lost stamp. The fast path is
// the stamped [data-gini-ref] locator recorded at snapshot time; when it
// no longer matches anything (an SPA re-render destroyed the stamped
// node), re-query by the recorded role/name/nth, restamp the survivor
// with the SAME ref id, and report healed: true so the caller can flag
// `healedRef` in its result. See ADR browser-automation-engine.md.
//
// Deliberately NOT used by browser_fill_secrets or the upload paths:
// those act only on the exact stamped element and fail loudly on stamp
// loss — mis-resolution there is a credential-leak / approval-bypass
// hazard (trust boundary; see ADR browser-fill-secret.md and the
// comments at those call sites).
//
// Returns undefined when the ref was never issued or healing found no
// candidate; callers emit the standard "Unknown ref" error.
async function resolveRefForAction(
  session: Session,
  ref: string
): Promise<{ locator: Locator; healed: boolean } | undefined> {
  const target = session.refs.get(ref);
  if (!target) return undefined;
  // Unit tests plant minimal locator stubs without count(); treat those
  // as live (same typeof-guard pattern snapshot() uses for page.url).
  if (typeof target.locator.count !== "function") {
    return { locator: target.locator, healed: false };
  }
  let stampedCount = 0;
  try {
    stampedCount = await target.locator.count();
  } catch {
    // A failing count (page navigating mid-call, context churn) is
    // handled like a lost stamp: healing below either re-finds the
    // element or the action fails with the standard message.
  }
  if (stampedCount > 0) return { locator: target.locator, healed: false };
  // In-frame refs fail loudly on stamp loss instead of healing: the
  // healing queries below search the MAIN frame only, so they could find
  // a same-role/name bystander outside the iframe and restamp it with
  // this ref's id — the action would land in the wrong document.
  if (target.framed) return undefined;
  const healed = await healLostRef(session, target, ref);
  return healed ? { locator: healed, healed: true } : undefined;
}

// Re-find an element whose data-gini-ref stamp was destroyed. ARIA-role
// entries re-query the accessibility tree via getByRole(role, { name,
// exact: true }) and take the recorded nth match; role "clickable" is
// synthetic (cursor-detected, not a real ARIA role — see the walker) so
// it falls back to exact-text matching, as does any role Playwright's
// role engine rejects. A found candidate is restamped with the SAME id
// so later resolutions take the stamped fast path and the next snapshot
// keeps the ref stable.
async function healLostRef(session: Session, target: RefTarget, ref: string): Promise<Locator | undefined> {
  // Nothing to re-query by: hidden-budget entries are emitted nameless.
  if (!target.name) return undefined;
  const page = session.page;
  if (typeof page.getByRole !== "function" || typeof page.getByText !== "function") return undefined;
  let candidate: Locator | undefined;
  if (target.role !== "clickable") {
    const byRole = page
      .getByRole(target.role as Parameters<Page["getByRole"]>[0], { name: target.name, exact: true })
      .nth(target.nth);
    try {
      if ((await byRole.count()) > 0) {
        candidate = byRole;
      } else {
        // A role Playwright supports that matches nothing means the
        // element is genuinely gone — fail rather than guess by text.
        return undefined;
      }
    } catch {
      // The role engine rejected the role string (the walker emits some
      // non-ARIA roles) — fall through to the text strategy.
    }
  }
  let viaText = false;
  if (!candidate) {
    const byText = page.getByText(target.name, { exact: true }).nth(target.nth);
    try {
      if ((await byText.count()) === 0) return undefined;
    } catch {
      return undefined;
    }
    candidate = byText;
    viaText = true;
  }
  // Two guards before the candidate is trusted (mis-heal containment —
  // see ADR browser-automation-engine.md). First, a candidate already
  // carrying a different stamp is a live element addressed by some OTHER
  // ref; restamping it would silently fold two refs onto one node and
  // the action would land on the wrong element. Second, a text-strategy
  // candidate must itself qualify as cursor-interactive the way the
  // walker's synthetic "clickable" entries do — getByText also matches
  // same-text bystanders (headings, plain spans) the walker never
  // emitted. Both cases bail to the standard Unknown-ref failure.
  //
  // The checks and the restamp run in ONE evaluate: a candidate locator
  // re-resolves on every call, so checking in one round trip and writing
  // in another would let a racing re-render shift the nth match between
  // them — the element that passed the checks must be the element that
  // gets the stamp. The short timeout keeps a candidate that detached
  // after count() from auto-waiting the action's whole budget here.
  let restamped = false;
  try {
    const verdict = await candidate.evaluate(
      (el: Element, arg: { attr: string; id: string; requireInteractive: boolean }) => {
        const stamp = el.getAttribute(arg.attr);
        const tabindexAttr = el.getAttribute("tabindex");
        const foreignStamp = stamp !== null && stamp !== arg.id;
        const cursorInteractive =
          window.getComputedStyle(el as HTMLElement).cursor === "pointer" ||
          el.getAttribute("onclick") !== null ||
          (tabindexAttr !== null && Number.parseInt(tabindexAttr, 10) >= 0);
        const accepted = !foreignStamp && (!arg.requireInteractive || cursorInteractive);
        if (accepted) el.setAttribute(arg.attr, arg.id);
        return accepted;
      },
      { attr: REF_ATTR_GLOBAL, id: ref.slice(1), requireInteractive: viaText },
      { timeout: 2_000 }
    );
    if (!verdict) return undefined;
    restamped = true;
  } catch {
    return undefined;
  }
  // The verified element now carries the SAME id, so the ref stays
  // stable for future actions and snapshots — and acting through the
  // stamped selector (instead of the re-resolving role/text candidate)
  // pins this action to exactly the element that passed the checks.
  if (restamped && typeof page.locator === "function") {
    const stampedLocator = page.locator(`[${REF_ATTR_GLOBAL}="${ref.slice(1)}"]`);
    session.refs.set(ref, { ...target, locator: stampedLocator });
    return stampedLocator;
  }
  return candidate;
}

// Build a browser tool response, applying a redaction pass over
// EVERY string leaf when the per-task secret registry has any
// recorded values. The snapshot text is already redacted inside
// snapshot(), and browserConsole/browserVision redact their
// eval/answer fields explicitly — but every browser tool response
// also includes raw `url: page.url()`, `title: await page.title()`,
// and (for browser_tabs) tab arrays with both. A page can write
// the typed credential into document.title (via an input handler)
// or push it into the URL state (via history.pushState / hash),
// and those metadata fields would otherwise leak through. Walking
// the entire payload through redactSecretValuesDeep catches every
// string leaf — url, title, tab.url, tab.title, plus anything
// future tool responses surface.
//
// taskId selects the per-task unreported-dialog buffer (see
// attachDialogHandler): any JS dialogs that fired since the task's
// last reported tool result are merged in as a `dialogs` field and
// the buffer cleared, so each dialog is surfaced to the model
// exactly once — and the dialog message text rides the same
// redaction pass as every other string leaf.
//
// For redaction, taskId is advisory: the pass consults
// allRegisteredSecrets() across every active task's registry, not
// just this task's. The shared spawned BrowserContext (one
// per-instance profile) bleeds DOM state across tasks — Task A's
// page can copy a typed credential into document.title, then Task B
// reads that title via its own snapshot/navigate response. A purely
// per-task lookup would miss this because Task B's registry is
// empty. The union catches cross-task leaks at the cost of
// over-redacting in edge cases where two tasks coincidentally
// typed the same long string (vanishingly unlikely given the
// 4-char minimum).
function ok(payload: Record<string, unknown>, taskId?: string): string {
  const body: Record<string, unknown> = { success: true, ...payload };
  if (taskId !== undefined) {
    const dialogs = takeUnreportedDialogs(taskId);
    if (dialogs.length > 0) body.dialogs = dialogs;
  }
  const secrets = allRegisteredSecrets();
  if (secrets.length === 0) {
    return JSON.stringify(body);
  }
  const redacted = redactSecretValuesDeep(body, secrets);
  return JSON.stringify(redacted);
}

function fail(error: string): string {
  // Mirror ok()'s redaction so an error message that contains a
  // registered secret value (playwright's "Call log: fill(...)"
  // verbiage, or any error whose text was built from page state
  // like a contenteditable's textContent) doesn't leak the secret
  // into the tool result that flows back to the LLM. All browser
  // tools' top-level catch-handlers return `fail(error.message)`,
  // so this one place covers every browser tool's failure path
  // — the bounded fill module's pre-redaction is now defense in
  // depth, not the sole guard.
  const secrets = allRegisteredSecrets();
  const sanitized = secrets.length > 0
    ? redactSecretValuesFromString(error, secrets)
    : error;
  return JSON.stringify({ success: false, error: sanitized });
}

function bool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  return fallback;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// ---------------- PDF navigation handling ----------------
//
// A URL that renders as a PDF gives Chrome's PDF-viewer DOM to the
// snapshot walker — a useless, near-empty tree. Detect the PDF at the
// navigation boundary via the response content-type and return extracted
// text (bounded to the snapshot char budget) instead of a DOM snapshot.
// The bytes come from the navigation response when it can be buffered,
// falling back to a native-fetch re-fetch of the same gated URL (the
// URL has already passed the SSRF gate + domain policy + post-redirect
// re-checks; the re-fetch re-runs those gates on every redirect hop).
// Extraction reuses the shared attachment extractor (lazy pdfjs-dist);
// when bytes or extraction are unavailable the result still flags
// `pdf: true` with an honest note so the model stops re-snapshotting.

// Cap on PDF bytes handed to the extractor. Injectable for tests.
const PDF_EXTRACT_MAX_BYTES_DEFAULT = 20 * 1024 * 1024;
let pdfExtractMaxBytes = PDF_EXTRACT_MAX_BYTES_DEFAULT;

// Extractor seam: production lazily imports the shared attachment
// extractor; tests stub it so the suite never loads pdfjs-dist.
type PdfTextExtractor = (bytes: Uint8Array) => Promise<{ text: string } | null>;
const defaultPdfTextExtractor: PdfTextExtractor = async (bytes) => {
  const { extractText } = await import("../capabilities/attachment-extract");
  return extractText(bytes, "application/pdf", "document.pdf");
};
let pdfTextExtractor: PdfTextExtractor = defaultPdfTextExtractor;

// Content-type of a navigation response, lowercased ("" when the response
// or its headers aren't available — fake test pages, aborted loads).
function navigationContentType(response: unknown): string {
  const headersFn = (response as { headers?: () => Record<string, string> } | null | undefined)?.headers;
  if (typeof headersFn !== "function") return "";
  try {
    const headers = headersFn.call(response);
    return (headers["content-type"] ?? "").toLowerCase();
  } catch {
    return "";
  }
}

// PDFs must start with the "%PDF-" magic. Acquired navigation bytes are
// validated against it before extraction because a successful body read is
// NOT proof of PDF bytes: when Chrome's PDF viewer intercepts a main-frame
// PDF navigation, response.body() resolves successfully with the viewer's
// HTML wrapper bytes — without this check that HTML would reach pdfjs and
// fail with "Invalid PDF structure".
const PDF_MAGIC = new TextEncoder().encode("%PDF-");
function isPdfBytes(bytes: Uint8Array): boolean {
  if (bytes.byteLength < PDF_MAGIC.byteLength) return false;
  return PDF_MAGIC.every((b, i) => bytes[i] === b);
}

// Timeout for each native re-fetch request so a hung server can't stall
// the turn; redirect hops each get their own budget.
const PDF_REFETCH_TIMEOUT_MS = 15_000;
// Bound on manual redirect hops the re-fetch will follow.
const PDF_REFETCH_MAX_REDIRECTS = 5;
// Injectable fetch seam so the re-fetch path can be exercised without
// touching the network. Mirrors the pdfTextExtractor seam above.
type PdfRefetchFetch = (url: string, init: RequestInit) => Promise<Response>;
const defaultPdfRefetchFetch: PdfRefetchFetch = (url, init) => fetch(url, init);
let pdfRefetchFetch: PdfRefetchFetch = defaultPdfRefetchFetch;

// Cookie header for the URL from the browser context, so the native
// re-fetch carries the same auth the page navigation had (auth-gated
// PDFs still extract). typeof-guarded so lightweight test fakes without
// a cookies() implementation degrade to "no cookies".
async function contextCookieHeader(context: BrowserContext, url: string): Promise<string | undefined> {
  const cookiesFn = (context as BrowserContext & {
    cookies?: (urls?: string | string[]) => Promise<Array<{ name: string; value: string }>>;
  }).cookies;
  if (typeof cookiesFn !== "function") return undefined;
  try {
    const cookies = await cookiesFn.call(context, url);
    if (!Array.isArray(cookies) || cookies.length === 0) return undefined;
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  } catch {
    return undefined;
  }
}

// Native re-fetch of the PDF bytes. Playwright's APIRequestContext
// (page.request.get) is unusable under Bun: its node:_http_client shim
// hands a path-only string to new URL() inside _parseSetCookieHeader,
// and the resulting unhandled rejection escapes the promise chain and
// kills the whole process. Bun's own fetch is used instead, preserving
// the trust boundary the context request rode for free: the browser
// context's cookies for each hop's URL are sent as a Cookie header, and
// redirects are followed manually with the SSRF gate + domain policy
// re-run on every hop — the initial URL already passed the
// post-redirect navigation gates, and per-hop checks keep that
// invariant for the re-fetch (a redirect must never reach a blocked
// host). Any failure degrades to { bytes: null } so the caller emits
// the honest could-not-retrieve note.
async function refetchPdfBytes(
  context: BrowserContext,
  startUrl: string,
  taskId: string
): Promise<{ bytes: Uint8Array | null; oversize: boolean }> {
  let url = startUrl;
  for (let hop = 0; hop <= PDF_REFETCH_MAX_REDIRECTS; hop++) {
    const cookie = await contextCookieHeader(context, url);
    let res: Response;
    try {
      res = await pdfRefetchFetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(PDF_REFETCH_TIMEOUT_MS),
        ...(cookie ? { headers: { cookie } } : {})
      });
    } catch {
      return { bytes: null, oversize: false };
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return { bytes: null, oversize: false };
      let next: string;
      try {
        next = new URL(location, url).toString();
      } catch {
        return { bytes: null, oversize: false };
      }
      const blocked = safetyCheck(next) ?? domainPolicyBlockReason(next, agentDomainPolicyForTask(taskId));
      if (blocked) return { bytes: null, oversize: false };
      url = next;
      continue;
    }
    // Honor the byte cap before buffering when the server declares a
    // content-length; the caller's shared byteLength check covers
    // undeclared bodies.
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > pdfExtractMaxBytes) {
      return { bytes: null, oversize: true };
    }
    let body: Uint8Array;
    try {
      body = new Uint8Array(await res.arrayBuffer());
    } catch {
      return { bytes: null, oversize: false };
    }
    // The same magic validation applies to re-fetched bytes (an error
    // page or HTML redirect target is not a PDF either).
    return { bytes: isPdfBytes(body) ? body : null, oversize: false };
  }
  // Redirect chain exceeded the hop bound.
  return { bytes: null, oversize: false };
}

// Build the navigate result for a PDF response. Extracted text rides the
// standard ok() redaction pass; failures degrade to a structured hint
// (`pdf: true` + note) rather than an empty snapshot.
async function pdfNavigateResult(
  session: Session,
  response: unknown,
  finalUrl: string,
  taskId: string
): Promise<string> {
  // A PDF page has no DOM the agent can act on — drop any refs from the
  // previous page so a stale click can't fire against the viewer.
  session.refs = new Map();
  session.lastSnapshotText = undefined;
  const status = (response as { status?: () => number } | null | undefined)?.status?.() ?? null;
  let bytes: Uint8Array | null = null;
  try {
    const bodyFn = (response as { body?: () => Promise<Uint8Array> } | null | undefined)?.body;
    if (typeof bodyFn === "function") bytes = await bodyFn.call(response);
  } catch {
    bytes = null;
  }
  // Empty or non-PDF bytes count as a failed read: when Chrome's PDF viewer
  // intercepts a main-frame PDF navigation, response.body() either throws OR
  // resolves successfully with the viewer's HTML wrapper bytes, so the magic
  // check is what routes real navigations to the re-fetch below.
  if (bytes && !isPdfBytes(bytes)) bytes = null;
  // Re-fetch the bytes with a Bun-native fetch (see refetchPdfBytes):
  // finalUrl is the SAME post-redirect URL that already passed
  // safetyCheck + domain policy above, the context's cookies ride along
  // as a Cookie header, and any further redirects are re-gated per hop.
  let fetchOversize = false;
  if (!bytes) {
    const refetched = await refetchPdfBytes(session.context, finalUrl, taskId);
    bytes = refetched.bytes;
    fetchOversize = refetched.oversize;
  }
  if (fetchOversize || (bytes && bytes.byteLength > pdfExtractMaxBytes)) {
    return ok({
      url: finalUrl,
      status,
      pdf: true,
      note: `This URL is a PDF document larger than the ${Math.floor(pdfExtractMaxBytes / (1024 * 1024))}MB extraction cap; no text was extracted. There is no DOM to snapshot — do not re-snapshot this page.`
    }, taskId);
  }
  // Both retrieval attempts failed — degrade honestly, naming the cause
  // so the model doesn't blame the extractor.
  if (!bytes) {
    return ok({
      url: finalUrl,
      status,
      pdf: true,
      note: "This URL is a PDF document; text extraction was not possible (could not retrieve PDF bytes). There is no DOM to snapshot — do not re-snapshot this page. If the user needs its contents, report that the PDF could not be read."
    }, taskId);
  }
  let text: string | null = null;
  try {
    text = (await pdfTextExtractor(bytes))?.text ?? null;
  } catch {
    text = null;
  }
  if (text === null) {
    return ok({
      url: finalUrl,
      status,
      pdf: true,
      note: "This URL is a PDF document; text extraction was not possible. There is no DOM to snapshot — do not re-snapshot this page. If the user needs its contents, report that the PDF could not be read."
    }, taskId);
  }
  let truncated = false;
  if (text.length > SNAPSHOT_CHAR_BUDGET) {
    const omitted = text.length - SNAPSHOT_CHAR_BUDGET;
    text = `${text.slice(0, SNAPSHOT_CHAR_BUDGET)}\n[...PDF text truncated +${omitted} more chars]`;
    truncated = true;
  }
  return ok({
    url: finalUrl,
    status,
    pdf: true,
    pdfText: text,
    truncated,
    note: "This URL rendered as a PDF document; extracted text is shown instead of a DOM snapshot."
  }, taskId);
}

export async function browserNavigate(
  taskId: string,
  args: Record<string, unknown>,
  // Runtime config enables the over-budget aux summarization fallback;
  // direct callers / tests may omit it and get plain counted truncation.
  config?: RuntimeConfig
): Promise<string> {
  const url = str(args.url);
  if (!url) return fail("Missing required string argument: url");
  const blocked = safetyCheck(url) ?? domainPolicyBlockReason(url, agentDomainPolicyForTask(taskId));
  if (blocked) return fail(blocked);
  try {
    return await withSession(taskId, async (session) => {
      // DNS pre-flight: the literal-only safetyCheck above misses
      // DNS aliases that resolve to loopback / private IPs (e.g.
      // an attacker-controlled "evil.example" A record pointing
      // at 127.0.0.1). Resolve the hostname and re-run safetyCheck
      // on the resolved address before handing the URL to Chrome.
      // Run AFTER withSession admission (not before) so the
      // disconnect-bail race the test suite covers fires first
      // and the lookup doesn't add an await boundary that shifts
      // admission timing. The check doesn't fully close DNS
      // rebinding (a TTL=0 swap between our lookup and Chrome's
      // own lookup is still possible), but it catches the common
      // case and matches what the web_fetch tool already does.
      try {
        const parsed = new URL(url);
        if (isIP(parsed.hostname) === 0) {
          const { address } = await lookup(parsed.hostname);
          // IPv6 addresses MUST be wrapped in brackets to form a
          // valid URL authority. Without brackets,
          // "https://2606:4700:4700::1111/" parses with the first
          // ":4700" as a port, corrupting the host parse and
          // causing safetyCheck to throw on the malformed URL —
          // which my catch then swallowed, silently bypassing the
          // resolved-host check for every legitimate IPv6 DNS
          // target. Wrap if the resolved address parses as IPv6.
          const authority = isIP(address) === 6 ? `[${address}]` : address;
          const resolvedBlocked = safetyCheck(`${parsed.protocol}//${authority}/`);
          if (resolvedBlocked) {
            return fail(`${resolvedBlocked} (resolved from ${parsed.hostname})`);
          }
        }
      } catch (err) {
        // DNS failure (NXDOMAIN, network-down) — let Chrome's
        // navigation surface the error organically rather than
        // collapsing into a generic fail() here.
        void err;
      }
      const response = await session.page.goto(url, { waitUntil: "domcontentloaded" });
      // Re-validate after navigation completes — playwright's goto
      // follows server redirects (302/303/307/308 + meta-refresh),
      // so a public allowed URL could land the page on a loopback
      // origin after the pre-flight check passed. Snapshotting +
      // returning the URL with that resolved origin would let an
      // attacker exfiltrate /api/runtime state through a redirect
      // chain the agent didn't directly request. Block the
      // resolved URL with the same safetyCheck and navigate the
      // page away to about:blank so the loopback page doesn't sit
      // in the session's history for the next tool call to read.
      const finalUrl = session.page.url();
      // about:blank is the legitimate "page is idle" state — either
      // the goto didn't actually settle (mocked / dummy backend) or
      // a prior cleanup landed us there. Skip the post-nav block
      // for it; the snapshot() boundary check already special-
      // cases it the same way.
      const postBlock = finalUrl === "about:blank"
        ? undefined
        : safetyCheck(finalUrl) ?? domainPolicyBlockReason(finalUrl, agentDomainPolicyForTask(taskId));
      if (postBlock) {
        try {
          await session.page.goto("about:blank", { waitUntil: "domcontentloaded" });
        } catch {
          // Best-effort cleanup; if even about:blank fails, the
          // returned error still tells the operator what happened.
        }
        return fail(`${postBlock} (final URL after redirect from ${url})`);
      }
      // Explicit navigation: even a same-URL goto produced a fresh
      // document, so drop the snapshot baseline — snapshot() then clears
      // any stale stamps, restarts ref numbering at @e1, and returns the
      // full tree (never a diff).
      session.lastSnapshotUrl = undefined;
      // PDF responses have no DOM worth walking — return extracted text
      // (or an honest hint) instead of a useless viewer snapshot.
      if (navigationContentType(response).includes("application/pdf")) {
        return await pdfNavigateResult(session, response, finalUrl, taskId);
      }
      const snap = await snapshot(session.page, false, taskId);
      session.refs = snap.refs;
      const rendered = await withSummarizedRemainder(snap.text, snap.truncatedRemainder, config);
      return ok({
        url: finalUrl,
        status: response?.status() ?? null,
        title: await session.page.title(),
        snapshot: rendered.text,
        // Count what THIS result lets the model act on: the rendered rows,
        // plus the remainder's refs only when the appended summary actually
        // carries them.
        elementCount: snap.elementCount + (rendered.summarized ? snap.remainderElementCount : 0),
        truncated: snap.truncated,
        ...(snap.botWallSuspected ? { botWallSuspected: true, warning: BOT_WALL_WARNING } : {})
      }, taskId);
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

export async function browserSnapshot(
  taskId: string,
  args: Record<string, unknown>,
  // Runtime config enables the over-budget aux summarization fallback;
  // direct callers / tests may omit it and get plain counted truncation.
  config?: RuntimeConfig
): Promise<string> {
  const full = bool(args.full, false);
  try {
    return await withSession(taskId, async (session) => {
      const snap = await snapshot(session.page, full, taskId);
      session.refs = snap.refs;
      const rendered = await withSummarizedRemainder(snap.text, snap.truncatedRemainder, config);
      return ok({
        url: session.page.url(),
        title: await session.page.title(),
        snapshot: rendered.text,
        // Same accounting as browser_navigate: remainder refs count only
        // when the appended summary carries them.
        elementCount: snap.elementCount + (rendered.summarized ? snap.remainderElementCount : 0),
        truncated: snap.truncated,
        ...(snap.botWallSuspected ? { botWallSuspected: true, warning: BOT_WALL_WARNING } : {})
      }, taskId);
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

export async function browserClick(taskId: string, args: Record<string, unknown>): Promise<string> {
  const ref = str(args.ref);
  if (!ref) return fail("Missing required string argument: ref");
  try {
    return await withSession(taskId, async (session) => {
      const resolved = await resolveRefForAction(session, ref);
      if (!resolved) return fail(`Unknown ref ${ref}. Take a fresh snapshot first.`);
      await resolved.locator.click({ timeout: 10_000 });
      await session.page.waitForLoadState("domcontentloaded").catch(() => undefined);
      const snapFields = await snapshotAfterAction(session, taskId);
      return ok({
        url: session.page.url(),
        title: await session.page.title(),
        ...snapFields,
        ...(resolved.healed ? { healedRef: true } : {})
      }, taskId);
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

export async function browserType(taskId: string, args: Record<string, unknown>): Promise<string> {
  const ref = str(args.ref);
  const text = typeof args.text === "string" ? args.text : undefined;
  if (!ref) return fail("Missing required string argument: ref");
  if (text === undefined) return fail("Missing required string argument: text");
  try {
    return await withSession(taskId, async (session) => {
      const resolved = await resolveRefForAction(session, ref);
      if (!resolved) return fail(`Unknown ref ${ref}. Take a fresh snapshot first.`);
      await resolved.locator.fill(text, { timeout: 10_000 });
      const snapFields = await snapshotAfterAction(session, taskId);
      return ok({
        url: session.page.url(),
        ...snapFields,
        ...(resolved.healed ? { healedRef: true } : {})
      }, taskId);
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

// Batch form fill for labeled NON-secret fields: each {ref, text} entry
// is filled with the same semantics as browser_type (clear-then-fill via
// the self-healing ref resolution), but the page is snapshotted ONCE
// after all fills instead of once per field. Stops at the first failing
// field and reports which fields were filled and which were not
// attempted, so the model can re-snapshot and retry the remainder.
//
// Secrets stay exclusively in browser_fill_secrets: as a defensive
// mirror of the outbound-URL gate in safetyCheck, any field text
// containing a registered secret value fails closed with a generic
// message that never echoes the value.
export async function browserFillForm(taskId: string, args: Record<string, unknown>): Promise<string> {
  const rawFields = args.fields;
  if (!Array.isArray(rawFields) || rawFields.length === 0) {
    return fail("Missing required argument: fields (non-empty array of {ref, text}).");
  }
  const fields: Array<{ ref: string; text: string }> = [];
  for (const entry of rawFields) {
    const ref = entry !== null && typeof entry === "object" ? str((entry as Record<string, unknown>).ref) : undefined;
    const text = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>).text : undefined;
    if (!ref || typeof text !== "string") {
      return fail("Each fields entry must be an object with string 'ref' and string 'text'.");
    }
    fields.push({ ref, text });
  }
  // Values below the redaction floor are skipped for the same reason
  // recordFilledSecret refuses them: a tiny value substring-matches
  // ordinary text and would false-positive.
  for (const secret of allRegisteredSecrets()) {
    if (secret.length < FILLED_SECRET_MIN_REDACTION_LENGTH) continue;
    if (fields.some((f) => f.text.includes(secret))) {
      return fail("Blocked: a field value contains a registered secret. Use browser_fill_secrets for credentials/secrets.");
    }
  }
  try {
    return await withSession(taskId, async (session) => {
      const filled: string[] = [];
      let healedAny = false;
      const report = (failedRef: string): string => {
        const notAttempted = fields.slice(filled.length + 1).map((f) => f.ref);
        return `Filled before failure: ${filled.join(", ") || "none"}. Not attempted: ${notAttempted.join(", ") || "none"}. Take a fresh snapshot and retry the remaining fields starting at ${failedRef}.`;
      };
      for (const field of fields) {
        const resolved = await resolveRefForAction(session, field.ref);
        if (!resolved) {
          return fail(`Unknown ref ${field.ref}. ${report(field.ref)}`);
        }
        try {
          await resolved.locator.fill(field.text, { timeout: 10_000 });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return fail(`Fill failed at ${field.ref}: ${message}. ${report(field.ref)}`);
        }
        if (resolved.healed) healedAny = true;
        filled.push(field.ref);
      }
      const snapFields = await snapshotAfterAction(session, taskId);
      return ok({
        url: session.page.url(),
        filled,
        ...snapFields,
        ...(healedAny ? { healedRef: true } : {})
      }, taskId);
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

// Collects the values of every element on the live page that
// carries the data-gini-secret attribute (stamped by
// browserFillByLocator after a successful fill_secret submission)
// AND merges in the per-task secret registry populated BEFORE the
// fill. The registry catches values the page has since cleared,
// detached, or copied to an unstamped element on the input handler
// — without it, those bytes would not appear in the live DOM under
// any stamped element and the redactor would let them through.
//
// Used by browser_console, browser_vision, and the snapshot walker
// to redact literal occurrences of typed credentials from any
// tool result that flows back to the LLM. Callers pass their
// already-acquired playwright Page so the collection inherits the
// surrounding withSession lock and the secret-list snapshot lives
// in closure scope BEFORE the agent-controlled side effect runs
// (eval, screenshot, walk) — so an agent-supplied expression that
// navigates the page can't empty the secret list mid-call.
//
// taskId is optional so the existing browser-tool call sites can
// be incrementally migrated; when omitted, only the live-DOM
// collection runs (legacy behavior).
async function collectSecretValuesFromPageWithSession(page: import("playwright-core").Page, taskId?: string): Promise<string[]> {
  let liveValues: string[] = [];
  try {
    liveValues = await page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll("[data-gini-secret]"));
      const values: string[] = [];
      for (const el of nodes) {
        // <input>/<textarea>/<select> elements expose the typed
        // bytes via the .value property. Non-input fill targets
        // (e.g. [contenteditable] <div> elements — playwright's
        // .fill() supports these) hold the typed bytes in
        // textContent instead. Collect BOTH so the redactor knows
        // every literal secret occurrence regardless of which
        // surface the fill landed on.
        const value = (el as HTMLInputElement).value;
        if (typeof value === "string" && value.length > 0) values.push(value);
        const text = el.textContent;
        if (typeof text === "string" && text.length > 0) values.push(text);
      }
      return values;
    });
  } catch {
    liveValues = [];
  }
  // Merge in EVERY active task's registry (not just this task's).
  // Shared BrowserContext means another task's typed credential
  // could be visible on this page's title / DOM / URL even though
  // this task never typed it. taskId is accepted for API
  // symmetry; the union read makes it advisory.
  void taskId;
  const registered = allRegisteredSecrets();
  if (registered.length > 0) {
    const out: string[] = [...liveValues];
    for (const v of registered) {
      if (!out.includes(v)) out.push(v);
    }
    return out;
  }
  return liveValues;
}

// Replace every occurrence of any secret value in `text` with
// "[redacted]". Sorts secrets by length descending so longer
// secrets are replaced before shorter prefixes (avoids leaking a
// suffix when one secret contains another). Empty / zero-length
// secrets are skipped to prevent global replacement runaway.
export function redactSecretValuesFromString(text: string, secrets: readonly string[]): string {
  if (!text || secrets.length === 0) return text;
  let out = text;
  for (const s of [...secrets].sort((a, b) => b.length - a.length)) {
    if (s.length === 0) continue;
    // String.replaceAll is preferred over global-regex because the
    // secret may contain regex metacharacters that would otherwise
    // need escaping.
    out = out.split(s).join("[redacted]");
  }
  return out;
}

// Deep-walk any JSON-serializable value and redact secret bytes
// from every string leaf, including string-typed values inside
// arrays and objects. Used by browser_console where the agent's
// eval expression can wrap a secret in a container
// (`[input.value]`, `{v: input.value}`) to escape a string-only
// redactor. Primitives that aren't strings are passed through;
// circular structures are guarded so a `{ self: self }` reference
// cycle doesn't infinite-loop.
export function redactSecretValuesDeep(value: unknown, secrets: readonly string[], seen: WeakSet<object> = new WeakSet()): unknown {
  if (secrets.length === 0) return value;
  if (typeof value === "string") return redactSecretValuesFromString(value, secrets);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value as object)) return "[circular]";
  seen.add(value as object);
  if (Array.isArray(value)) {
    return value.map((item) => redactSecretValuesDeep(item, secrets, seen));
  }
  // Redact both KEYS and values. An agent can use a computed key
  // to smuggle the secret bytes out via JSON serialization
  // (`{[input.value]: 1}` → `{"hunter2": 1}`). When two keys
  // collapse to the same redacted form, append a numeric suffix
  // so the second hit doesn't silently overwrite the first.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const redactedKey = redactSecretValuesFromString(k, secrets);
    let finalKey = redactedKey;
    if (finalKey !== k && Object.prototype.hasOwnProperty.call(out, finalKey)) {
      let i = 2;
      while (Object.prototype.hasOwnProperty.call(out, `${redactedKey}_${i}`)) i++;
      finalKey = `${redactedKey}_${i}`;
    }
    out[finalKey] = redactSecretValuesDeep(v, secrets, seen);
  }
  return out;
}

// browser.fill_secret slot writer. Takes a raw playwright selector
// (CSS, text=, role=, or an ARIA snapshot ref token like "@e2"
// which resolveLocator translates to [data-gini-ref="e2"]) plus the
// value to type. Used exclusively by the POST /api/setup-requests/<id>/complete
// browser.fill_secret branch; never called via the tool catalog.
// Skips the post-fill snapshot that browser_type takes because the
// agent will re-snapshot on its own when it resumes — and because
// the fill might be one of several in the same submit batch, so
// taking a snapshot per slot is wasted work.
// Result discriminator for browserFillByLocator. Callers branch
// on `code` rather than parsing a magic-string prefix from
// `error` — see src/execution/browser-fill-secrets.ts which uses
// code === "origin-mismatch" to halt the per-slot loop without
// typing remaining secrets into a drifted origin. Future error
// classes (e.g. timeout, detached, frame-detached) can be added
// here without touching the consumer's branching logic.
export type BrowserFillByLocatorResult =
  | { ok: true }
  | { ok: false; code: "origin-mismatch"; error: string }
  | { ok: false; code: "validation-error"; error: string }
  | { ok: false; code: "fill-error"; error: string };

export async function browserFillByLocator(
  taskId: string,
  args: { locator: string; value: string; expectedUrl?: string }
): Promise<BrowserFillByLocatorResult> {
  if (typeof args.locator !== "string" || args.locator.length === 0) {
    return { ok: false, code: "validation-error", error: "Missing required string argument: locator" };
  }
  if (typeof args.value !== "string") {
    return { ok: false, code: "validation-error", error: "Missing required string argument: value" };
  }
  // Capture the live secret list into closure scope BEFORE the
  // session work runs. disconnectSharedBrowser has a bounded
  // DISCONNECT_DRAIN_DEADLINE_MS (5s) but locator.fill has a
  // 10s timeout — so a disconnect that fires mid-fill can run
  // clearFilledSecrets and empty the global registry BEFORE the
  // fill catch runs. A purely-global-read in the catch would
  // then redact against an empty set and leak the typed value
  // via the Playwright "Call log: fill(...)" verbiage. The
  // local snapshot survives teardown; we include the about-to-
  // be-recorded value in case recordFilledSecret hasn't run
  // yet (or skipped the value for being below the redaction
  // floor — registering it locally for THIS error path is safe
  // because the local list never escapes this function).
  const secretsForCatch: string[] = [...allRegisteredSecrets()];
  if (typeof args.value === "string" && args.value.length > 0 && !secretsForCatch.includes(args.value)) {
    secretsForCatch.push(args.value);
  }
  try {
    return await withSession(taskId, async (session) => {
      // Per-slot URL re-check immediately before the playwright
      // .fill() call. The /connect handler's pre-loop URL check is
      // TOCTOU on its own: a navigation between the pre-loop check
      // and any subsequent slot's .fill() would land the secret on
      // a new origin. Re-reading session.page.url() inside the
      // same withSession callback closes the window to the depth
      // of one playwright API call. Callers that don't supply
      // expectedUrl skip the check (existing browser tool callers
      // that don't need the binding).
      //
      // expectedUrl is the page origin (protocol+host+port), the
      // same shape the producer-side approvedUrl on the approval
      // payload carries (both flow through sanitizeUrlForAuditTarget,
      // which strips pathname/query/fragment because reset and
      // magic-link URLs can carry tokens in the path).
      if (args.expectedUrl) {
        const liveUrl = sanitizeUrlForAuditTarget(session.page.url());
        if (liveUrl !== args.expectedUrl) {
          return {
            ok: false,
            code: "origin-mismatch",
            error: `origin-mismatch: live=${liveUrl ?? "invalid"} expected=${args.expectedUrl}`
          } as const;
        }
      }
      // Trust boundary: @-refs resolve ONLY via the literal stamped
      // [data-gini-ref] selector — never resolveRefForAction's stale-ref
      // self-healing. Mis-resolution here would type a credential into
      // the wrong element, so a lost stamp must fail loudly instead
      // (see ADR browser-fill-secret.md).
      const selector = args.locator.startsWith("@")
        ? `[${REF_ATTR_GLOBAL}="${args.locator.slice(1)}"]`
        : args.locator;
      const locator = session.page.locator(selector);
      // Record the value in the per-task secret registry BEFORE the
      // fill so a page that synchronously clears the input on its
      // `input` handler still has the typed bytes available to the
      // redactor. Recording is best-effort; even if the .fill
      // below throws (origin mismatch, timeout), the registry
      // entry is fine to keep — the value was about to land in
      // the DOM and any later snapshot that captured it pre-throw
      // still needs redaction.
      recordFilledSecret(taskId, args.value);
      await locator.fill(args.value, { timeout: 10_000 });
      // Stamp the element with data-gini-secret so subsequent
      // browser_snapshot calls redact its value (see snapshot
      // walker's secret-field branch). type="password" already
      // triggers redaction on its own; this covers fields the page
      // may flip from password→text post-fill (some SPAs do this
      // to show the value in their own custom UI) and generic
      // credential fields that aren't explicitly password type but
      // were filled via fill_secret.
      //
      // CRITICAL: the stamping MUST NOT fail the fill outcome. The
      // .fill() at the line above already wrote the secret to the
      // DOM; if we let a stamp-evaluate throw (element detached,
      // page navigated, frame-detached, serialization error) bubble
      // out to the outer catch, the caller would record this slot
      // as errored AND the value would be in the DOM unstamped —
      // subsequent snapshots wouldn't redact it. Wrap the entire
      // Node-side evaluate await in its own try/catch so the fill
      // outcome reflects the actual DOM write, not the stamp's
      // success. A stamp failure is a recoverable defense-in-depth
      // miss; if it happens, the snapshot walker's other heuristics
      // (type=password, autocomplete=current-password) still cover
      // the common cases.
      try {
        await locator.evaluate((el) => {
          try {
            (el as Element).setAttribute("data-gini-secret", "true");
          } catch {
            /* attribute set best-effort */
          }
        });
      } catch {
        /* stamp evaluate threw on the Node side (detached element,
           navigation, serialization) — keep the fill outcome and
           rely on the snapshot walker's other redaction signals.
           A defensive trace is emitted by the bounded fill module
           via the per-slot result if subsequent calls observe
           unstamped values. */
      }
      return { ok: true } as const;
    });
  } catch (error) {
    // CRITICAL: Playwright's locator.fill embeds the typed value
    // into its timeout-error message via "Call log: fill(\"<value>\")"
    // (see coreBundle.js fill instrumentation). If the fill times
    // out (disabled input, slow SPA hydration, contenteditable
    // mismatch), the raw error.message contains the secret in
    // plaintext. Returning it verbatim would route the value
    // through:
    //   - browser-fill-secrets.ts: errors[].error → appendTrace
    //     data (NOT redacted:true → persisted to per-task JSONL)
    //   - browser-fill-secrets.ts: resumeChatTask resumeResult
    //     → tool_result block → LLM context
    // Redact every literal occurrence of any registered secret
    // for this task before returning. The registry was populated
    // pre-fill, so even a clear-on-input page hostile script
    // can't unregister the value.
    const raw = error instanceof Error ? error.message : String(error);
    // Redact against the locally-captured secret list (snapshotted
    // BEFORE the fill, so it survives disconnect's bounded drain
    // deadline). Falling back to the live global registry would
    // miss the typed value if disconnectSharedBrowser fired and
    // cleared the registry mid-fill — see the secretsForCatch
    // capture above. The local list also defends against
    // recordFilledSecret skipping short values (the floor would
    // bar the registry entry but the local capture still gets
    // redacted for this error path only).
    void taskId;
    const sanitized = redactSecretValuesFromString(raw, secretsForCatch);
    return { ok: false, code: "fill-error", error: sanitized };
  }
}

export async function browserPress(taskId: string, args: Record<string, unknown>): Promise<string> {
  const key = str(args.key);
  if (!key) return fail("Missing required string argument: key");
  try {
    return await withSession(taskId, async (session) => {
      await session.page.keyboard.press(key);
      await session.page.waitForLoadState("domcontentloaded").catch(() => undefined);
      const snapFields = await snapshotAfterAction(session, taskId);
      return ok({
        url: session.page.url(),
        ...snapFields
      }, taskId);
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

export async function browserScroll(taskId: string, args: Record<string, unknown>): Promise<string> {
  const direction = str(args.direction);
  if (direction !== "up" && direction !== "down") {
    return fail("Argument direction must be 'up' or 'down'.");
  }
  try {
    return await withSession(taskId, async (session) => {
      const dy = direction === "down" ? 600 : -600;
      await session.page.evaluate((delta) => window.scrollBy(0, delta), dy);
      const snapFields = await snapshotAfterAction(session, taskId);
      return ok({
        url: session.page.url(),
        ...snapFields
      }, taskId);
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

export async function browserBack(taskId: string, _args: Record<string, unknown>): Promise<string> {
  try {
    return await withSession(taskId, async (session) => {
      const response = await session.page.goBack({ waitUntil: "domcontentloaded" });
      // History navigation, same contract as browser_navigate: drop the
      // baseline so refs reset and the response carries the full tree.
      session.lastSnapshotUrl = undefined;
      const snap = await snapshot(session.page, false, taskId);
      session.refs = snap.refs;
      return ok({
        url: session.page.url(),
        status: response?.status() ?? null,
        title: await session.page.title(),
        snapshot: snap.text,
        elementCount: snap.elementCount,
        truncated: snap.truncated
      }, taskId);
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

const consoleLogs = new Map<string, Array<{ type: string; text: string }>>();
const consoleHooked = new WeakSet<Page>();

// Pages outlive tasks: an adopted user tab survives closeSession and is
// re-instrumented by a LATER task, but the console/dialog/network
// listeners install once per page (re-listening would duplicate records).
// Handlers therefore resolve the OWNING task at EVENT time through this
// map — refreshed by every attach call — instead of closing over the
// taskId that happened to do the hooking, which would route a later
// task's records (and ignore its browser_dialog arming) into a dead
// task's buffers.
const pageTaskOwner = new WeakMap<Page, string>();

function attachConsole(taskId: string, page: Page): void {
  pageTaskOwner.set(page, taskId);
  if (consoleHooked.has(page)) return;
  consoleHooked.add(page);
  page.on("console", (msg) => {
    const owner = pageTaskOwner.get(page) ?? taskId;
    const buf = consoleLogs.get(owner) ?? [];
    buf.push({ type: msg.type(), text: msg.text() });
    if (buf.length > 200) buf.splice(0, buf.length - 200);
    consoleLogs.set(owner, buf);
  });
}

// JS dialog (alert / confirm / prompt / beforeunload) capture. With no
// "dialog" listener installed, Playwright auto-dismisses every dialog
// silently — the model never learns a confirm() fired, so an "Are you
// sure?" flow always takes the cancel path without anyone knowing. The
// handler below keeps the auto-respond behavior (responding immediately
// means page JS never blocks on an open dialog, which would freeze every
// in-flight action) but makes it observable and steerable:
//   - default response is dismiss, matching Playwright's no-handler
//     behavior;
//   - browser_dialog arms a ONE-SHOT response (accept / dismiss /
//     promptText) consumed by the next dialog that fires for the task;
//   - every dialog is recorded and surfaced once in a `dialogs` field of
//     the task's next ok() tool result, riding the standard
//     secret-redaction pass there.
interface DialogRecord {
  type: string;
  message: string;
  defaultValue?: string;
  url: string;
  at: string;
  response: "accepted" | "dismissed";
  promptText?: string;
}
// Cap on unreported dialog records held per task. A page firing dialogs
// in a loop between tool calls would otherwise grow the buffer without
// bound; the model only needs the most recent few to understand what
// happened.
const DIALOG_BUFFER_CAP = 5;
const dialogHooked = new WeakSet<Page>();
const pendingDialogResponses = new Map<string, { accept: boolean; promptText?: string }>();
const unreportedDialogs = new Map<string, DialogRecord[]>();

// Drain the task's unreported dialog records. Called by ok() so each
// record is surfaced exactly once, in the next successful tool result.
function takeUnreportedDialogs(taskId: string): DialogRecord[] {
  const buf = unreportedDialogs.get(taskId);
  if (!buf || buf.length === 0) return [];
  unreportedDialogs.delete(taskId);
  return buf;
}

// Read-only network request visibility. Per-task ring buffer of the most
// recent completed (and failed) requests on agent-owned pages — method,
// URL, status, resourceType, optional failure text. No bodies, no
// headers, no interception/mocking: this is observability only, read by
// browser_requests. Plain strings keep the buffer cheap; the cap bounds
// memory on chatty pages (analytics beacons, polling).
interface NetworkLogEntry {
  method: string;
  url: string;
  status: number | null;
  resourceType: string;
  failure?: string;
}
const NETWORK_LOG_CAP = 100;
const networkLogs = new Map<string, NetworkLogEntry[]>();
const networkHooked = new WeakSet<Page>();

function attachNetworkCapture(taskId: string, page: Page): void {
  // Fake test pages may not expose .on — same typeof-guard pattern
  // snapshot() uses for page.url.
  if (typeof page.on !== "function") return;
  pageTaskOwner.set(page, taskId);
  if (networkHooked.has(page)) return;
  networkHooked.add(page);
  const push = (entry: NetworkLogEntry): void => {
    // Resolve the owner at event time — see pageTaskOwner.
    const owner = pageTaskOwner.get(page) ?? taskId;
    const buf = networkLogs.get(owner) ?? [];
    buf.push(entry);
    if (buf.length > NETWORK_LOG_CAP) buf.splice(0, buf.length - NETWORK_LOG_CAP);
    networkLogs.set(owner, buf);
  };
  page.on("response", (response) => {
    try {
      const request = response.request();
      push({
        method: request.method(),
        url: response.url(),
        status: response.status(),
        resourceType: request.resourceType()
      });
    } catch {
      // A response whose request handle is already gone (page teardown
      // race) just doesn't get logged.
    }
  });
  page.on("requestfailed", (request) => {
    try {
      push({
        method: request.method(),
        url: request.url(),
        status: null,
        resourceType: request.resourceType(),
        failure: request.failure()?.errorText ?? "failed"
      });
    } catch {
      // ignore — same teardown race as above
    }
  });
}

function attachDialogHandler(taskId: string, page: Page): void {
  // Fake test pages may not expose .on — same typeof-guard pattern
  // snapshot() uses for page.url.
  if (typeof page.on !== "function") return;
  pageTaskOwner.set(page, taskId);
  if (dialogHooked.has(page)) return;
  dialogHooked.add(page);
  page.on("dialog", (dialog) => {
    // Resolve the owner at event time — see pageTaskOwner. A page adopted
    // by a later task consumes THAT task's armed response and records into
    // its buffer, not the buffer of whichever task installed the listener.
    const owner = pageTaskOwner.get(page) ?? taskId;
    const armed = pendingDialogResponses.get(owner);
    pendingDialogResponses.delete(owner);
    const accept = armed?.accept ?? false;
    const record: DialogRecord = {
      type: dialog.type(),
      message: dialog.message(),
      ...(dialog.type() === "prompt" ? { defaultValue: dialog.defaultValue() } : {}),
      url: typeof page.url === "function" ? page.url() : "",
      at: new Date().toISOString(),
      response: accept ? "accepted" : "dismissed",
      ...(accept && armed?.promptText !== undefined ? { promptText: armed.promptText } : {})
    };
    const buf = unreportedDialogs.get(owner) ?? [];
    buf.push(record);
    if (buf.length > DIALOG_BUFFER_CAP) buf.splice(0, buf.length - DIALOG_BUFFER_CAP);
    unreportedDialogs.set(owner, buf);
    // Respond immediately so page JS unblocks. Errors (dialog already
    // handled, page closed mid-response) are swallowed — the record
    // above already captured what fired.
    void (accept ? dialog.accept(armed?.promptText) : dialog.dismiss()).catch(() => undefined);
  });
}

export async function browserConsole(taskId: string, args: Record<string, unknown>): Promise<string> {
  const expression = str(args.expression);
  const clear = bool(args.clear, false);
  try {
    return await withSession(taskId, async (session) => {
      // Refuse to run agent JS on any origin the URL guard rejects (loopback
      // control-plane, cloud metadata, link-local, ...). This is the one tool
      // that executes agent-supplied code in the page's origin, so a
      // same-origin fetch from a loopback document would reach the
      // bearer-injecting BFF. Read the URL ONCE: validate it AND derive the
      // origin the in-page race assertion pins against, so the two can't
      // disagree across a navigation. Drop any console output captured while
      // on a now-refused page so it can't surface on a later call.
      const preUrl = typeof session.page.url === "function" ? session.page.url() : "";
      if (preUrl && preUrl !== "about:blank") {
        const preBlock = safetyCheck(preUrl) ?? domainPolicyBlockReason(preUrl, agentDomainPolicyForTask(taskId));
        if (preBlock) {
          if (typeof session.page.goto === "function") {
            try {
              await session.page.goto("about:blank", { waitUntil: "domcontentloaded" });
            } catch {
              /* best-effort */
            }
          }
          // Clear AFTER the bounce: the console listener stays attached, so a
          // log the blocked page emits as it is navigated away would otherwise
          // repopulate the buffer after an earlier clear.
          consoleLogs.delete(taskId);
          return fail(`${preBlock} (refusing to run console JS on a disallowed origin)`);
        }
      }
      // The origin the in-page assertion pins against, derived from the same
      // read we just validated (safetyCheck already confirmed it parses).
      // "null" for about:blank / no-page sessions.
      const validatedOrigin = preUrl && preUrl !== "about:blank" ? new URL(preUrl).origin : "null";
      // attachConsole is now called eagerly in getOrCreate; this is a
      // belt-and-braces re-attach in case the page was somehow swapped.
      attachConsole(taskId, session.page);
      if (clear) {
        consoleLogs.set(taskId, []);
      }
      // Collect data-gini-secret values BEFORE the eval. If we
      // collected after, an agent-supplied expression that itself
      // navigates (`location.href='...'; document.querySelector('input').value`)
      // or clears the form would empty the secret list — leaving
      // the captured evalResult (which read the value pre-navigation)
      // unredacted on the way back to the LLM. Pre-collection
      // snapshots the secret list into closure scope so the
      // redactor's input is stable regardless of subsequent page
      // state.
      const secretValues = await collectSecretValuesFromPageWithSession(session.page, taskId);
      let evalResult: unknown = undefined;
      let evalError: string | undefined;
      if (expression) {
        try {
          evalResult = await session.page.evaluate(
            ({ expr, validatedOrigin }: { expr: string; validatedOrigin: string }) => {
              // In-page race assertion — runs in the SAME execution context
              // the agent's expression (and any fetch it issues) will. The
              // server validated the page origin a moment earlier; if a
              // navigation committed in the gap before this eval, the document
              // origin no longer matches and we refuse — without re-implementing
              // the URL policy in the page. Pinning the origin closes the whole
              // race class (loopback control-plane, cloud metadata, link-local,
              // any cross-origin): a same-origin BFF write needs the document
              // origin to BE the control plane, and a changed origin no longer
              // is. Same-origin client navigation (hash, pushState) keeps
              // location.origin, so legitimate in-page interaction is unaffected.
              if (location.origin !== validatedOrigin) {
                throw new Error(`Blocked: page origin changed to ${location.origin} (expected ${validatedOrigin}); refusing to run console JS on a navigated origin.`);
              }
              // eslint-disable-next-line no-new-func
              return new Function(`return (${expr});`)();
            },
            { expr: expression, validatedOrigin }
          );
        } catch (error) {
          evalError = error instanceof Error ? error.message : String(error);
        }
      }
      // The eval can navigate the page, and a navigation kicked off earlier
      // can commit during it — the race the in-page assertion blocks
      // *execution* for. If the page is now on a refused origin, withhold the
      // result rather than returning session.page.url() (the loopback URL) or
      // messages (console output the page emitted): the write is already
      // blocked, but returning — or later resurfacing — that state would still
      // leak it, so drop the captured logs too.
      const postEvalBlock = await disallowedOriginReason(session.page, taskId);
      if (postEvalBlock) {
        consoleLogs.delete(taskId);
        return fail(`${postEvalBlock} (refusing to return console state from a disallowed origin)`);
      }
      const messages = consoleLogs.get(taskId) ?? [];
      // Redact data-gini-secret values from anywhere they could
      // surface to the LLM. The snapshot walker's redaction handles
      // the structured snapshot path; this catches the eval /
      // console-log paths. Deep-redact non-string evalResult values
      // — the agent can wrap a secret in a container like
      // `[input.value]` or `{v: input.value}` to escape a string-only
      // redactor, but redactSecretValuesDeep walks every string leaf
      // inside arrays and objects.
      const redactedMessages = messages.map((m) => ({
        ...m,
        text: redactSecretValuesFromString(m.text, secretValues)
      }));
      const redactedEvalResult = evalResult === undefined
        ? null
        : redactSecretValuesDeep(evalResult, secretValues);
      return ok({
        url: session.page.url(),
        messages: redactedMessages,
        evalResult: redactedEvalResult,
        evalError: evalError ? redactSecretValuesFromString(evalError, secretValues) : null
      }, taskId);
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

// Arm a one-shot response for the NEXT JavaScript dialog that fires for
// this task. Dialogs are auto-dismissed (and recorded) the moment they
// fire — see attachDialogHandler — so this tool cannot answer a dialog
// retroactively; it pre-registers the answer for the next one, letting
// the model deliberately complete a confirm()/prompt() flow by arming
// accept and then re-triggering the action.
export async function browserDialog(taskId: string, args: Record<string, unknown>): Promise<string> {
  const action = str(args.action);
  if (action !== "accept" && action !== "dismiss") {
    return fail("Argument 'action' must be one of: accept, dismiss.");
  }
  if (args.promptText !== undefined && typeof args.promptText !== "string") {
    return fail("Argument 'promptText' must be a string.");
  }
  const promptText = typeof args.promptText === "string" ? args.promptText : undefined;
  // promptText is typed into page JS when the dialog fires — an outbound
  // channel into the page. Defensive mirror of the browser_fill_form gate:
  // a registered secret fails closed with a generic message that never
  // echoes the value (values under the redaction floor are skipped for the
  // same false-positive reason recordFilledSecret refuses them).
  if (promptText !== undefined) {
    for (const secret of allRegisteredSecrets()) {
      if (secret.length < FILLED_SECRET_MIN_REDACTION_LENGTH) continue;
      if (promptText.includes(secret)) {
        return fail("Blocked: promptText contains a registered secret. Use browser_fill_secrets for credentials/secrets.");
      }
    }
  }
  try {
    return await withSession(taskId, async (session) => {
      pendingDialogResponses.set(taskId, {
        accept: action === "accept",
        ...(promptText !== undefined ? { promptText } : {})
      });
      return ok({
        url: typeof session.page.url === "function" ? session.page.url() : "",
        armed: action,
        ...(promptText !== undefined ? { promptText } : {})
      }, taskId);
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

// Read-only list of the task's recent network requests (see
// attachNetworkCapture). URLs ride the standard ok() redaction pass, so
// a registered secret appearing in a recorded URL never reaches the
// model verbatim.
export async function browserRequests(taskId: string, args: Record<string, unknown>): Promise<string> {
  if (args.filter !== undefined && typeof args.filter !== "string") {
    return fail("Argument 'filter' must be a string.");
  }
  const filter = str(args.filter);
  try {
    return await withSession(taskId, async (session) => {
      const all = networkLogs.get(taskId) ?? [];
      const requests = filter ? all.filter((r) => r.url.includes(filter)) : all;
      return ok({
        url: typeof session.page.url === "function" ? session.page.url() : "",
        requests
      }, taskId);
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

// Curated viewport-resize utility (no raw CDP passthrough). Dimensions
// are clamped to a sane range so the agent can't set a degenerate or
// absurd viewport.
const RESIZE_MIN_WIDTH = 320;
const RESIZE_MAX_WIDTH = 3840;
const RESIZE_MIN_HEIGHT = 240;
const RESIZE_MAX_HEIGHT = 2160;

export async function browserResize(taskId: string, args: Record<string, unknown>): Promise<string> {
  const width = typeof args.width === "number" && Number.isFinite(args.width) ? Math.round(args.width) : undefined;
  const height = typeof args.height === "number" && Number.isFinite(args.height) ? Math.round(args.height) : undefined;
  if (width === undefined) return fail("Missing required number argument: width");
  if (height === undefined) return fail("Missing required number argument: height");
  const clampedWidth = Math.min(Math.max(width, RESIZE_MIN_WIDTH), RESIZE_MAX_WIDTH);
  const clampedHeight = Math.min(Math.max(height, RESIZE_MIN_HEIGHT), RESIZE_MAX_HEIGHT);
  try {
    return await withSession(taskId, async (session) => {
      if (typeof session.page.setViewportSize !== "function") {
        return fail("Viewport resize is not supported by this browser session.");
      }
      await session.page.setViewportSize({ width: clampedWidth, height: clampedHeight });
      return ok({
        url: typeof session.page.url === "function" ? session.page.url() : "",
        width: clampedWidth,
        height: clampedHeight,
        ...(clampedWidth !== width || clampedHeight !== height ? { clamped: true } : {})
      }, taskId);
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

// Curated cookie READ (no writes, no raw CDP passthrough). Values are
// ALWAYS replaced with "[redacted]" — the metadata (name, domain, path,
// expiry, flags) is what the agent needs to reason about auth state;
// the value itself is a credential and never reaches the model.
export async function browserCookies(taskId: string, args: Record<string, unknown>): Promise<string> {
  void args;
  try {
    return await withSession(taskId, async (session) => {
      const context = session.context;
      if (!context || typeof context.cookies !== "function") {
        return fail("Cookie read is not supported by this browser session.");
      }
      // Cookies are live page/origin state. Like every other live-page
      // reader (console, vision, the snapshot boundary), refuse to read
      // them while the page sits on a disallowed origin — otherwise a
      // redirect onto a blocked host would let its cookie metadata reach
      // the model.
      const originBlock = await disallowedOriginReason(session.page, taskId);
      if (originBlock) {
        return fail(`${originBlock} (refusing to read cookies from a disallowed origin)`);
      }
      const pageUrl = typeof session.page.url === "function" ? session.page.url() : "";
      // Scope to the current page when it has a real http(s) URL so the
      // agent sees the cookies that apply to where it is; fall back to
      // the whole shared context otherwise.
      const scopedToPage = /^https?:/i.test(pageUrl);
      const cookies = await (scopedToPage ? context.cookies(pageUrl) : context.cookies());
      const redacted = cookies.map((cookie) => ({
        name: cookie.name,
        value: "[redacted]",
        domain: cookie.domain,
        path: cookie.path,
        expires: cookie.expires,
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
        sameSite: cookie.sameSite
      }));
      return ok({
        url: pageUrl,
        scope: scopedToPage ? "page" : "context",
        cookies: redacted
      }, taskId);
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

// Hover over an element identified by its @eN ref from the last snapshot.
// Hovering can reveal tooltips or trigger CSS :hover-only menus the agent
// needs to interact with next; we re-snapshot afterwards so any newly
// visible interactive elements get fresh @eN refs.
export async function browserHover(taskId: string, args: Record<string, unknown>): Promise<string> {
  const ref = str(args.ref);
  if (!ref) return fail("Missing required string argument: ref");
  try {
    return await withSession(taskId, async (session) => {
      const resolved = await resolveRefForAction(session, ref);
      if (!resolved) return fail(`Unknown ref ${ref}. Take a fresh snapshot first.`);
      await resolved.locator.hover({ timeout: 10_000 });
      const snapFields = await snapshotAfterAction(session, taskId);
      return ok({
        url: session.page.url(),
        title: await session.page.title(),
        ...snapFields,
        ...(resolved.healed ? { healedRef: true } : {})
      }, taskId);
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

// Drag one element onto another by their @eN refs. Useful for kanban-style
// reorderings and drag-to-upload zones; we wait for any post-drop navigation
// or DOM settle via waitForLoadState before re-snapshotting.
export async function browserDrag(taskId: string, args: Record<string, unknown>): Promise<string> {
  const fromRef = str(args.fromRef);
  const toRef = str(args.toRef);
  if (!fromRef) return fail("Missing required string argument: fromRef");
  if (!toRef) return fail("Missing required string argument: toRef");
  try {
    return await withSession(taskId, async (session) => {
      const from = await resolveRefForAction(session, fromRef);
      if (!from) return fail(`Unknown ref ${fromRef}. Take a fresh snapshot first.`);
      const to = await resolveRefForAction(session, toRef);
      if (!to) return fail(`Unknown ref ${toRef}. Take a fresh snapshot first.`);
      await from.locator.dragTo(to.locator, { timeout: 10_000 });
      await session.page.waitForLoadState("domcontentloaded").catch(() => undefined);
      const snapFields = await snapshotAfterAction(session, taskId);
      return ok({
        url: session.page.url(),
        title: await session.page.title(),
        ...snapFields,
        ...(from.healed || to.healed ? { healedRef: true } : {})
      }, taskId);
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

// Select option(s) on a <select> by ref. Callers can address either:
//
//   1. The <select> directly + value/values — Playwright's normal contract.
//   2. A specific <option> ref alone — we walk up to the containing
//      <select> and use the option's `value` attribute. The snapshot
//      walker surfaces both the select and its options as @eN refs, so
//      the model often picks an option ref naturally; rather than fight
//      the model into picking the select, we accept either shape.
//
// If both an option ref AND a value/values are supplied, the explicit
// value wins (callers may override the option's default value attribute).
export async function browserSelectOption(taskId: string, args: Record<string, unknown>): Promise<string> {
  const ref = str(args.ref);
  if (!ref) return fail("Missing required string argument: ref");
  const value = typeof args.value === "string" ? args.value : undefined;
  const valuesRaw = args.values;
  const hasValues = valuesRaw !== undefined;
  let values: string[] | undefined;
  if (hasValues) {
    if (!Array.isArray(valuesRaw) || !valuesRaw.every((v): v is string => typeof v === "string")) {
      return fail("Argument 'values' must be an array of strings.");
    }
    values = valuesRaw;
  }
  if (value !== undefined && hasValues) {
    return fail("Provide either 'value' or 'values', not both.");
  }
  try {
    return await withSession(taskId, async (session) => {
      const resolved = await resolveRefForAction(session, ref);
      if (!resolved) return fail(`Unknown ref ${ref}. Take a fresh snapshot first.`);
      let locator = resolved.locator;

      // Detect whether the resolved element is an <option>. If so, walk
      // up to the containing <select> and (when no explicit value/values
      // was supplied) infer the value from the option's `value` attribute.
      // Errors evaluating tagName fall back to "treat as select" — that
      // keeps existing select-ref callers working under any future
      // walker change that surfaces non-OPTION refs.
      let inferredValue: string | undefined;
      try {
        const meta = await locator.evaluate((el: Element) => ({
          tagName: el.tagName,
          value: el.getAttribute("value") ?? (el as HTMLOptionElement).value ?? ""
        }));
        if (meta.tagName === "OPTION") {
          inferredValue = typeof meta.value === "string" ? meta.value : undefined;
          // Walk up to the parent <select>; .selectOption only works on
          // <select>, not on individual <option> nodes.
          locator = locator.locator("xpath=ancestor::select[1]");
        }
      } catch {
        // If evaluate fails (no such element, page navigated away mid-
        // call, etc.) we fall through to the original selectOption call,
        // which will surface its own structured error to the caller.
      }

      // Selection priority: explicit value > explicit values[] > inferred
      // value from option ref. If none of those are available, fail with
      // the standard message.
      let selection: string | string[];
      if (value !== undefined) {
        selection = value;
      } else if (values !== undefined) {
        selection = values;
      } else if (inferredValue !== undefined) {
        selection = inferredValue;
      } else {
        return fail("Missing required argument: provide either 'value' (string) or 'values' (string[]).");
      }
      await locator.selectOption(selection, { timeout: 10_000 });
      const snapFields = await snapshotAfterAction(session, taskId);
      return ok({
        url: session.page.url(),
        ...snapFields,
        selected: selection,
        ...(resolved.healed ? { healedRef: true } : {})
      }, taskId);
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

// Wait for either a known element to reach a particular state, or for a
// substring of text to appear anywhere in document.body.innerText. Either
// `ref` or `text` must be supplied (exclusively). After the wait completes
// we re-snapshot so any newly visible interactive elements pick up fresh
// `@eN` refs. Timeouts surface as a structured `Wait timed out...` error
// rather than the raw Playwright stack.
export async function browserWaitFor(taskId: string, args: Record<string, unknown>): Promise<string> {
  const ref = str(args.ref);
  const text = str(args.text);
  if (ref && text) return fail("Provide either 'ref' or 'text', not both.");
  if (!ref && !text) return fail("Missing required argument: provide either 'ref' or 'text'.");
  const stateArg = args.state;
  const allowedStates = new Set(["visible", "hidden", "attached", "detached"]);
  let waitState: "visible" | "hidden" | "attached" | "detached" = "visible";
  if (stateArg !== undefined) {
    if (typeof stateArg !== "string" || !allowedStates.has(stateArg)) {
      return fail("Argument 'state' must be one of: visible, hidden, attached, detached.");
    }
    waitState = stateArg as typeof waitState;
  }
  let timeoutMs = 10_000;
  if (args.timeoutMs !== undefined) {
    if (typeof args.timeoutMs !== "number" || !Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
      return fail("Argument 'timeoutMs' must be a positive number.");
    }
    // Hard upper bound: 60s. Any larger value gets silently clamped so an
    // agent can't wedge a tool call for minutes on a stuck condition. The
    // catalog entry documents the cap.
    timeoutMs = Math.min(args.timeoutMs, 60_000);
  }
  try {
    return await withSession(taskId, async (session) => {
      let healedRef = false;
      try {
        if (ref) {
          if (waitState === "visible" || waitState === "attached") {
            // Self-heal only the "element should be present" states. For
            // hidden/detached, a lost stamp often IS the disappearance
            // being awaited — healing onto a re-rendered replacement
            // would invert the wait's meaning — so those keep the raw
            // stamped locator.
            const resolved = await resolveRefForAction(session, ref);
            if (resolved) {
              healedRef = resolved.healed;
              await resolved.locator.waitFor({ state: waitState, timeout: timeoutMs });
            } else {
              // Resolution failing right now is not "unknown ref" for the
              // presence states — waiting for an element that isn't there
              // YET is exactly what this tool is for. Fall back to polling
              // the stamped locator so a node that (re)appears with its
              // stamp intact satisfies the wait.
              const target = session.refs.get(ref);
              if (!target) return fail(`Unknown ref ${ref}. Take a fresh snapshot first.`);
              await target.locator.waitFor({ state: waitState, timeout: timeoutMs });
            }
          } else {
            const target = session.refs.get(ref);
            if (!target) return fail(`Unknown ref ${ref}. Take a fresh snapshot first.`);
            await target.locator.waitFor({ state: waitState, timeout: timeoutMs });
          }
        } else {
          // text-mode: poll the page for the substring. Playwright's
          // waitForFunction handles the timing for us; we pass the needle in
          // as an argument so it crosses the page boundary as a string.
          await session.page.waitForFunction(
            (needle: string) => document.body?.innerText?.includes(needle) ?? false,
            text!,
            { timeout: timeoutMs }
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/timeout|exceeded/i.test(message)) {
          return fail(`Wait timed out after ${timeoutMs}ms: ${message}`);
        }
        return fail(message);
      }
      const snapFields = await snapshotAfterAction(session, taskId);
      return ok({
        url: session.page.url(),
        title: await session.page.title(),
        ...snapFields,
        ...(healedRef ? { healedRef: true } : {})
      }, taskId);
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

// Return the stable handle for `page`, assigning the next "tN" id when the
// page hasn't been seen before — this is how user-opened tabs and
// window.open popups get handles lazily on their first list.
function tabHandleFor(session: Session, page: Page): string {
  for (const [handle, existing] of session.tabHandles) {
    if (existing === page) return handle;
  }
  const handle = `t${session.nextTabHandleId++}`;
  session.tabHandles.set(handle, page);
  return handle;
}

// Resolve a tN handle to its live Page. Returns undefined for an unknown
// handle AND for a handle whose page has closed since it was listed
// (pruning the dead entry on the way out) — both mean the model is acting
// on a stale tab list and must re-list.
function resolveTabHandle(session: Session, id: string): Page | undefined {
  const page = session.tabHandles.get(id);
  if (!page) return undefined;
  if (!session.context.pages().includes(page)) {
    session.tabHandles.delete(id);
    return undefined;
  }
  return page;
}

// Multi-tab management. Drives BrowserContext.pages() and context.newPage()
// for list / new / switch / close. Tabs are addressed by stable tN handles
// (see Session.tabHandles), never by position. Critically, every action that
// swaps the active page clears `session.refs` BEFORE assigning
// `session.page` so any concurrent stale ref lookup fails fast against the
// old refs map rather than silently resolving against the new page.
export async function browserTabs(taskId: string, args: Record<string, unknown>): Promise<string> {
  const action = str(args.action);
  if (!action) return fail("Missing required string argument: action");
  if (action !== "list" && action !== "new" && action !== "switch" && action !== "close") {
    return fail("Argument 'action' must be one of: list, new, switch, close.");
  }
  try {
    return await withSession(taskId, async (session) => {
      if (action === "list") {
        const pages = session.context.pages();
        // Prune handles whose page has closed (user-closed tabs, crashed
        // renderers) so the map doesn't accumulate dead Page references.
        // The handle itself stays retired — the counter only moves forward.
        const open = new Set(pages);
        for (const [handle, p] of session.tabHandles) {
          if (!open.has(p)) session.tabHandles.delete(handle);
        }
        const tabs = await Promise.all(
          pages.map(async (p) => ({
            id: tabHandleFor(session, p),
            url: p.url(),
            title: await p.title().catch(() => ""),
            active: p === session.page
          }))
        );
        return ok({ url: session.page.url(), tabs }, taskId);
      }
      if (action === "new") {
        if (args.url !== undefined && (typeof args.url !== "string" || args.url.length === 0)) {
          return fail("Argument 'url' must be a non-empty string.");
        }
        const url = str(args.url);
        if (url) {
          const blocked = safetyCheck(url) ?? domainPolicyBlockReason(url, agentDomainPolicyForTask(taskId));
          if (blocked) return fail(blocked);
        }
        const page = await session.context.newPage();
        // Mark the freshly-opened tab as agent-owned IMMEDIATELY so any
        // failure between here and the final session.page swap (goto error,
        // console attach error, snapshot throw, even a sync throw between
        // awaits) still leaves the tab tracked for closeSession to reap.
        // Without this, an orphan tab survives task teardown.
        session.ownedPageIds.add(page);
        // Assign the stable handle up front so the response can tell the
        // model how to address the tab it just opened without re-listing.
        const id = tabHandleFor(session, page);
        attachConsole(taskId, page);
        attachDialogHandler(taskId, page);
        attachNetworkCapture(taskId, page);
        if (url) {
          await page.goto(url, { waitUntil: "domcontentloaded" });
        }
        // Clear refs BEFORE swapping the page so any concurrent stale ref
        // lookup hitting session.refs while session.page is the new tab
        // fails fast against an empty map rather than silently resolving
        // against a locator that points at the old page. Dropping the
        // snapshot baseline marks the page swap as a navigation: refs
        // renumber from @e1 and the response carries the full tree.
        session.refs = new Map();
        session.lastSnapshotUrl = undefined;
        session.page = page;
        await page.bringToFront().catch(() => undefined);
        const snap = await snapshot(session.page, false, taskId);
        session.refs = snap.refs;
        return ok({
          id,
          url: session.page.url(),
          title: await session.page.title(),
          snapshot: snap.text,
          elementCount: snap.elementCount,
          truncated: snap.truncated
        }, taskId);
      }
      if (action === "switch") {
        const id = str(args.id);
        if (!id) return fail("Missing required string argument: id (a tab handle like \"t2\" from browser_tabs list).");
        const target = resolveTabHandle(session, id);
        if (!target) return fail(`No tab with id ${id}. Tab handles are never reused; call browser_tabs action:"list" for the current tabs.`);
        // Page swap = navigation for ref purposes (the target tab may
        // carry stamps from an earlier visit — clear and renumber).
        session.refs = new Map();
        session.lastSnapshotUrl = undefined;
        session.page = target;
        // The target may be a user-opened tab or window.open popup that
        // never went through getOrCreate / tabs:new — hook its dialogs
        // and network log now that the agent is acting on it
        // (idempotent via WeakSet).
        attachDialogHandler(taskId, target);
        attachNetworkCapture(taskId, target);
        await target.bringToFront().catch(() => undefined);
        const snap = await snapshot(session.page, false, taskId);
        session.refs = snap.refs;
        return ok({
          url: session.page.url(),
          title: await session.page.title(),
          snapshot: snap.text,
          elementCount: snap.elementCount,
          truncated: snap.truncated
        }, taskId);
      }
      // close
      const id = str(args.id);
      if (!id) return fail("Missing required string argument: id (a tab handle like \"t2\" from browser_tabs list).");
      const target = resolveTabHandle(session, id);
      if (!target) return fail(`No tab with id ${id}. Tab handles are never reused; call browser_tabs action:"list" for the current tabs.`);
      const wasActive = target === session.page;
      await target.close();
      // Retire the handle (never reassigned — the counter is monotonic)
      // and drop the closed page from agent ownership if we had it. If the
      // page wasn't agent-owned (rare in practice — the agent normally
      // only addresses tabs it can see, and it opens new ones via
      // browser_tabs:new), the delete is a harmless no-op.
      session.tabHandles.delete(id);
      session.ownedPageIds.delete(target);
      if (wasActive) {
        // Match the invariant the new/switch branches follow: clear refs
        // BEFORE assigning session.page so a stale-ref lookup that races
        // the page swap fails fast against an empty map. Then pick
        // whatever's left, or create a fresh page so the session isn't
        // left pointing at a closed handle. A freshly-opened fallback page
        // counts as agent-owned (we just created it).
        session.refs = new Map();
        session.lastSnapshotUrl = undefined;
        const remaining = session.context.pages();
        if (remaining[0]) {
          session.page = remaining[0];
        } else {
          const fallback = await session.context.newPage();
          session.ownedPageIds.add(fallback);
          session.page = fallback;
        }
        // Whichever page became active — an adopted survivor or the
        // fresh fallback — gets the dialog and network hooks
        // (idempotent via WeakSet).
        attachDialogHandler(taskId, session.page);
        attachNetworkCapture(taskId, session.page);
      } else {
        // Active page didn't change, but refs map points at the old
        // snapshot we're about to refresh — drop it now for consistency
        // with the wasActive branch.
        session.refs = new Map();
      }
      const snap = await snapshot(session.page, false, taskId);
      session.refs = snap.refs;
      return ok({
        url: session.page.url(),
        title: await session.page.title(),
        snapshot: snap.text,
        elementCount: snap.elementCount,
        truncated: snap.truncated
      }, taskId);
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

export async function browserClose(taskId: string, _args: Record<string, unknown>): Promise<string> {
  try {
    consoleLogs.delete(taskId);
    await closeSession(taskId);
    return ok({ closed: true, taskId }, taskId);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

// Cap on numbered ref badges injected for an annotated browser_vision
// screenshot. Fifty is plenty for the model to anchor an answer to
// specific elements; an unbounded overlay on a ref-dense page would bury
// the very content the screenshot is meant to show.
const VISION_ANNOTATE_BADGE_CAP = 50;

// Native-vision fast-path gate. When the active model accepts image
// input, attaching the screenshot directly to the conversation would
// save the aux round trip and the OCR fidelity loss of describing
// pixels in text — but a raw image cannot be post-OCR-redacted, so the
// native route is allowed ONLY when no secrets are registered for ANY
// active task (allRegisteredSecrets() is the cross-task union; one
// task's typed credential can be visible on another task's page via
// the shared BrowserContext). With any secret registered, the aux
// side-call with pre-blur + post-OCR redaction stays mandatory.
type VisionRoute = "native-image" | "aux-side-call";

function resolveVisionRoute(config: RuntimeConfig): VisionRoute {
  if (allRegisteredSecrets().length > 0) return "aux-side-call";
  return resolveProviderModality(config.provider).vision ? "native-image" : "aux-side-call";
}

// Screenshot the current page and ask the configured vision model a question
// about it. Returns the model's text answer. The agent never sees the
// screenshot bytes — vision is a side call mediated by the provider layer so
// pixels stay out of the agent loop's transcript. One image per invocation;
// `full` toggles fullPage vs viewport. Cost is bounded by the provider's
// default 512-token response budget, the 5MB screenshot cap above, and a
// disconnect-generation re-check that bails before returning if the browser
// was torn down mid-call.
export async function browserVision(
  taskId: string,
  args: Record<string, unknown>,
  config: RuntimeConfig
): Promise<string> {
  const question = str(args.question);
  if (!question) return fail("Missing required string argument: question");
  const full = bool(args.full, false);
  const annotate = bool(args.annotate, false);
  try {
    return await withSession(taskId, async (session) => {
      // Refuse to screenshot a page on a refused origin (loopback
      // control-plane, cloud metadata, link-local). browser_vision ships the
      // rendered pixels to the vision provider, so an unguarded screenshot of
      // a loopback page would exfiltrate control-plane state as an image —
      // the same surface browser_console and snapshot() already gate.
      const visionBlock = await disallowedOriginReason(session.page, taskId);
      if (visionBlock) {
        return fail(`${visionBlock} (refusing to screenshot a disallowed origin)`);
      }
      // Capture the disconnect generation BEFORE the screenshot. A slow
      // screenshot (large full-page captures can take seconds) followed by
      // a disconnect mid-await would otherwise slip past the post-fetch
      // check and let us forward stale bytes from a torn-down browser.
      const capturedGeneration = currentDisconnectGeneration();
      // Pre-collect data-gini-secret values BEFORE the screenshot.
      // If we collected after, a screenshot that itself navigates
      // (extremely rare) or page cleanup between screenshot and
      // collection would empty the secret list and skip the
      // belt-and-braces post-OCR redaction.
      const secretValues = await collectSecretValuesFromPageWithSession(session.page, taskId);
      // Blur every data-gini-secret element before the screenshot so
      // the vision model can't OCR a credential the user typed via
      // fill_secret. Native browser rendering already masks
      // type="password" inputs, but non-password inputs filled via
      // fill_secret (OTP/recovery-code text inputs) would otherwise
      // render in cleartext. The blur is applied via inline style
      // immediately before the screenshot and restored immediately
      // after — the user's actual page never sees the blur because
      // the headless render happens in the same DOM frame.
      // Both evaluate calls are tolerant of synthetic / mocked
      // pages that may not implement page.evaluate at all (the
      // browserVision unit tests use a stripped-down page mock).
      try {
        if (typeof session.page.evaluate === "function") {
          await session.page.evaluate(() => {
            const els = document.querySelectorAll("[data-gini-secret]");
            for (const el of Array.from(els)) {
              const h = el as HTMLElement;
              h.dataset.giniBlurRestore = h.style.filter || "";
              h.style.filter = "blur(12px)";
            }
          });
        }
      } catch { /* best-effort blur */ }
      // When annotating, overlay numbered badges on viewport-visible
      // stamped elements so the vision model can anchor its answer to
      // snapshot refs. Badge text is ONLY the ref id ("e12") — never page
      // text — so the overlay adds no new redaction surface; the
      // [data-gini-secret] pre-blur above and the post-OCR redaction
      // below stay untouched, and secret-stamped elements are never
      // badged at all. See ADR browser-automation-engine.md.
      if (annotate) {
        try {
          if (typeof session.page.evaluate === "function") {
            // Only refs the session actually holds get a badge — a stamp
            // alone isn't enough (the walker stamps elements the char
            // budget then drops, and a page could plant the attribute
            // itself); a badge citing a ref the agent can't act on would
            // send it chasing Unknown-ref failures.
            const knownIds = Array.from(session.refs.keys()).map((r) => r.slice(1));
            await session.page.evaluate((arg: { cap: number; ids: string[]; fullPage: boolean }) => {
              const known = new Set(arg.ids);
              const stamped = Array.from(document.querySelectorAll("[data-gini-ref]"));
              let placed = 0;
              for (const el of stamped) {
                if (placed >= arg.cap) break;
                if (!known.has(el.getAttribute("data-gini-ref") ?? "")) continue;
                if (el.getAttribute("data-gini-secret") !== null) continue;
                const rect = el.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0) continue;
                // A fullPage capture includes below-fold content, so the
                // viewport filter only applies to viewport captures.
                if (
                  !arg.fullPage
                  && (rect.bottom <= 0 || rect.right <= 0
                    || rect.top >= window.innerHeight || rect.left >= window.innerWidth)
                ) {
                  continue;
                }
                const badge = document.createElement("div");
                badge.setAttribute("data-gini-vision-badge", "true");
                badge.textContent = el.getAttribute("data-gini-ref") ?? "";
                // Document-absolute placement (viewport rect + scroll
                // offset) rather than position:fixed, so badges land on
                // their elements in fullPage captures too — fixed boxes
                // would all pile up in the scrolled-to viewport.
                badge.style.cssText =
                  `position:absolute;left:${Math.max(0, rect.left + window.scrollX)}px;`
                  + `top:${Math.max(0, rect.top + window.scrollY)}px;`
                  + "z-index:2147483647;background:#1a73e8;color:#fff;"
                  + "font:10px/1.4 monospace;padding:0 3px;border-radius:3px;pointer-events:none;";
                document.documentElement.appendChild(badge);
                placed++;
              }
            }, { cap: VISION_ANNOTATE_BADGE_CAP, ids: knownIds, fullPage: full });
          }
        } catch { /* best-effort overlay — an unannotated screenshot is still useful */ }
      }
      let buf: Buffer;
      try {
        buf = await session.page.screenshot({ type: "png", fullPage: full });
      } finally {
        // Always restore even if screenshot threw — otherwise the
        // page would be left visibly blurred for the user.
        try {
          if (typeof session.page.evaluate === "function") {
            await session.page.evaluate(() => {
              const els = document.querySelectorAll("[data-gini-secret]");
              for (const el of Array.from(els)) {
                const h = el as HTMLElement;
                h.style.filter = h.dataset.giniBlurRestore ?? "";
                delete h.dataset.giniBlurRestore;
              }
            });
          }
        } catch { /* best-effort restore */ }
        // Strip the annotation overlay by its dedicated attribute, even
        // when the screenshot threw — a surviving badge would leak into
        // later snapshots and screenshots as a phantom page element.
        if (annotate) {
          try {
            if (typeof session.page.evaluate === "function") {
              await session.page.evaluate(() => {
                const badges = document.querySelectorAll("[data-gini-vision-badge]");
                for (const badge of Array.from(badges)) badge.remove();
              });
            }
          } catch { /* best-effort removal */ }
        }
      }
      // The vision provider measures the base64-encoded image against its cap,
      // not the decoded bytes. resolveImageByteLimit returns a raw-byte budget
      // whose base64 expansion (4/3) stays under that cap, so an accepted
      // screenshot never 400s at the provider. A capture this large is also
      // almost certainly a huge full-page scroll that produces a useless answer;
      // failing fast avoids a wasted provider round-trip and gives the model a
      // clear retry instruction.
      const maxScreenshotBytes = resolveImageByteLimit(config.provider);
      if (buf.length > maxScreenshotBytes) {
        return fail(
          `Screenshot too large (${buf.length} bytes > ${maxScreenshotBytes} byte cap). Try full:false or scroll to a specific section.`
        );
      }
      // Re-check after the capture: if the page navigated to a refused origin
      // while the screenshot was in flight, discard the buffer rather than
      // sending its pixels to the vision provider.
      const postShotBlock = await disallowedOriginReason(session.page, taskId);
      if (postShotBlock) {
        return fail(`${postShotBlock} (page navigated to a disallowed origin during capture; discarding screenshot)`);
      }
      const imageBase64 = Buffer.from(buf).toString("base64");
      // With badges in the shot, tell the vision model what they mean so
      // its answer cites refs the agent can act on directly.
      const prompt = annotate
        ? `${question}\n\nThe numbered badges overlaid on the screenshot are element refs (badge "e12" = @e12 in the page snapshot); cite them when referring to specific elements.`
        : question;
      // Route selection (see resolveVisionRoute). "native-image" means
      // the screenshot is ALLOWED to enter the conversation directly. The
      // model loop still only sees the text answer below — but the captured
      // pixels are now ALSO stored as an upload and surfaced to the USER via
      // a ready-to-paste `gini-upload://<id>` markdown tag (imageMarkdown
      // below) the model drops into its reply, so a request like "screenshot
      // lego.com and send it to me" actually delivers the image. See ADR
      // outbound-chat-attachments.md.
      const route = resolveVisionRoute(config);
      void route;
      const result = await generateVisionAnalysis(config, {
        prompt,
        imageBase64,
        mimeType: "image/png",
        maxTokens: 512
      });
      // Re-check after the provider response too — a disconnect that
      // started while we were awaiting the model is just as bad as one
      // that started during the screenshot.
      if (currentDisconnectGeneration() !== capturedGeneration) {
        return fail("Browser disconnecting, retry shortly.");
      }
      // Defense in depth: even with the blur, post-process the
      // vision answer to redact any literal occurrence of a known
      // secret value — covers a model that pre-cached the value
      // from an earlier turn or somehow recovered it from a
      // partial blur (very small screenshot, tiny font, etc.).
      // secretValues was snapshotted pre-screenshot above.
      const redactedAnswer = redactSecretValuesFromString(result.text, secretValues);
      // Store the captured PNG as an upload so the user can see it. `buf` is
      // the SAME bytes sent to the vision model — already DOM-blurred for
      // any [data-gini-secret] element before capture (see the screenshot
      // block above), so redaction parity holds: a user-visible screenshot
      // never leaks a secret the vision answer would have redacted. Storage
      // is best-effort — a failure here must not fail the tool, since the
      // text answer is the model-facing result and already succeeded.
      let image: ImageAttachment | undefined;
      try {
        image = storeUpload(config.instance, buf, "image/png", "screenshot.png");
      } catch {
        image = undefined;
      }
      return ok({
        url: session.page.url(),
        answer: redactedAnswer,
        bytes: buf.length,
        full,
        // Ready-to-paste markdown tag the model drops into its reply WHERE it
        // wants the screenshot shown (inline, mid-prose). The clients rewrite
        // the `gini-upload://<id>` ref to their own authed image source; a
        // missing tag just means no inline image. See ADR
        // outbound-chat-attachments.md.
        ...(image ? { imageMarkdown: imageTagFor(image.id, "screenshot") } : {}),
        cost: result.cost ?? null,
        usage: result.usage ?? null
      }, taskId);
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

// Validate that a workspace-relative `userPath` points at an in-workspace
// regular file and return both the absolute path and a workspace-relative
// display path (for trace/approval rendering). Throws with a structured
// message when the path is missing, outside the workspace, doesn't exist,
// isn't a file, or resolves outside the workspace via a symlink.
//
// Shared by browser_upload_file's pre-approval gate (so the user sees a
// real, validated path on the approval card) AND by the post-approval
// executor (browserUploadFileApproved), which re-runs THIS function
// against the user-supplied path — not the pre-resolved one — so a
// TOCTOU symlink swap between request and approval is rejected.
export function resolveUploadPath(
  workspaceRoot: string,
  userPath: string
): { absolute: string; displayPath: string } {
  if (!userPath) throw new Error("Missing required string argument: path");
  const absolute = assertInsideWorkspace(workspaceRoot, userPath);
  if (!existsSync(absolute)) {
    throw new Error(`Upload path does not exist: ${userPath}`);
  }
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(absolute);
  } catch (error) {
    throw new Error(`Cannot stat upload path: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!st.isFile()) {
    throw new Error(`Upload path is not a file: ${userPath}`);
  }
  // Resolve symlinks and re-run the workspace check. A symlink under the
  // workspace pointing at /etc/passwd would otherwise let an agent
  // exfiltrate arbitrary files via an upload widget; closing this here
  // keeps the assertInsideWorkspace contract intact across symlink chases.
  // We realpath both sides so a workspace itself reached via a symlink
  // (common on macOS where /tmp -> /private/tmp) doesn't false-positive
  // a perfectly in-workspace file.
  let real: string;
  try {
    real = realpathSync(absolute);
  } catch (error) {
    throw new Error(`Cannot resolve upload path: ${error instanceof Error ? error.message : String(error)}`);
  }
  let realWorkspace: string;
  try {
    realWorkspace = realpathSync(workspaceRoot);
  } catch {
    // If the workspace itself can't be realpath'd, fall back to the
    // original; the second assertInsideWorkspace below catches anything
    // that lands outside the un-resolved tree as well.
    realWorkspace = workspaceRoot;
  }
  try {
    assertInsideWorkspace(realWorkspace, real);
  } catch {
    throw new Error(`Path resolves outside workspace via symlink: ${userPath}`);
  }
  return { absolute: real, displayPath: userPath };
}

// Upload a workspace file to a file-input element by ref. The user-supplied
// path is treated as workspace-relative, validated to be inside the
// workspace, and then re-validated after symlink resolution so a planted
// symlink pointing at /etc/passwd can't escape the sandbox. The realpath is
// what gets handed to Playwright's setInputFiles.
//
// NOTE: The chat-task dispatcher now routes browser_upload_file through an
// approval gate (see src/execution/tool-dispatch.ts::requestBrowserUpload
// and src/agent.ts::executeApprovedAction). This function remains as the
// direct, unapproved path used by tests and any non-chat-task caller that
// has already validated user intent.
export async function browserUploadFile(
  taskId: string,
  args: Record<string, unknown>,
  workspaceRoot: string
): Promise<string> {
  const ref = str(args.ref);
  if (!ref) return fail("Missing required string argument: ref");
  const userPath = str(args.path);
  if (!userPath) return fail("Missing required string argument: path");
  let resolved: { absolute: string; displayPath: string };
  try {
    resolved = resolveUploadPath(workspaceRoot, userPath);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  try {
    return await withSession(taskId, async (session) => {
      // Trust boundary: uploads act ONLY on the exact stamped element —
      // no resolveRefForAction self-healing here. The user's approval
      // names this specific target; re-resolving by role/name could hand
      // the file to a different input. A lost stamp fails loudly instead
      // (same stance as browser_fill_secrets; see ADR
      // browser-fill-secret.md).
      const target = session.refs.get(ref);
      if (!target) return fail(`Unknown ref ${ref}. Take a fresh snapshot first.`);
      await target.locator.setInputFiles(resolved.absolute, { timeout: 10_000 });
      const snap = await snapshot(session.page, false, taskId);
      session.refs = snap.refs;
      return ok({
        url: session.page.url(),
        path: resolved.displayPath,
        snapshot: snap.text,
        elementCount: snap.elementCount,
        truncated: snap.truncated
      }, taskId);
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

// Approved-upload executor. Called by agent.executeApprovedAction after the
// user explicitly authorizes a browser.upload_file approval. RE-runs
// resolveUploadPath against the user-supplied path at execute time (NOT
// the pre-resolved path captured at approval time) so a TOCTOU swap —
// an attacker (or buggy tool) replacing the workspace file with a symlink
// to /etc/passwd between approval and execution — fails closed. Returns
// the same envelope shape browserUploadFile uses so the chat-task loop
// feeds the success message back as the tool result.
export async function browserUploadFileApproved(
  taskId: string,
  ref: string,
  workspaceRoot: string,
  userPath: string
): Promise<string> {
  let resolved: { absolute: string; displayPath: string };
  try {
    resolved = resolveUploadPath(workspaceRoot, userPath);
  } catch (error) {
    // The approval payload stored a resolved path that passed the symlink
    // check at request time. If the same validation fails NOW the path
    // changed underneath us — refuse rather than upload whatever the
    // symlink now points at.
    const message = error instanceof Error ? error.message : String(error);
    return fail(`Upload path changed between approval and execution: ${message}`);
  }
  try {
    return await withSession(taskId, async (session) => {
      // Trust boundary: the approval was granted for the exact stamped
      // element — no resolveRefForAction self-healing here; a lost stamp
      // fails loudly (see ADR browser-fill-secret.md). The liveness
      // pre-check below keeps that stance: it exists only to fail FAST
      // with actionable guidance when the stamped node vanished between
      // approval and execution (a menu closed, an SPA re-render), instead
      // of hanging 10s in setInputFiles and surfacing a raw Playwright
      // timeout. Unit tests plant minimal locator stubs without count();
      // treat those as live (same guard as resolveRefForAction).
      const target = session.refs.get(ref);
      if (!target) return fail(`Unknown ref ${ref}. Take a fresh snapshot first.`);
      if (typeof target.locator.count === "function") {
        let stampedCount = 0;
        try {
          stampedCount = await target.locator.count();
        } catch {
          // A failing count (page navigating mid-call, context churn)
          // reads as a lost stamp: same fast, actionable failure.
        }
        if (stampedCount === 0) {
          return fail(`The element for ${ref} is no longer on the page — it re-rendered or a menu closed since the snapshot. Take a fresh browser_snapshot and retry with the new ref.`);
        }
      }
      await target.locator.setInputFiles(resolved.absolute, { timeout: 10_000 });
      const snap = await snapshot(session.page, false, taskId);
      session.refs = snap.refs;
      return ok({
        url: session.page.url(),
        path: resolved.displayPath,
        snapshot: snap.text,
        elementCount: snap.elementCount,
        truncated: snap.truncated
      }, taskId);
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

// ---------------- Downloads (approval-gated) ----------------

// Size cap for browser_download saves. Checked AFTER the save — Playwright
// streams the download to disk and the byte count isn't known up front —
// so an over-cap file is deleted and the tool fails. Injectable for tests
// via __test.setDownloadMaxBytesForTest.
const DOWNLOAD_MAX_BYTES_DEFAULT = 50 * 1024 * 1024;
let downloadMaxBytes = DOWNLOAD_MAX_BYTES_DEFAULT;

// How long to wait for the page to actually start a download after the
// approved click. Generous because the server decides when the
// Content-Disposition response begins. Injectable for tests via
// __test.setDownloadEventTimeoutForTest.
const DOWNLOAD_EVENT_TIMEOUT_MS_DEFAULT = 30_000;
let downloadEventTimeoutMs = DOWNLOAD_EVENT_TIMEOUT_MS_DEFAULT;

// Reduce a server-suggested filename to a safe basename. The suggested
// name is attacker-controlled (the remote server picks it), so path
// separators and traversal segments are stripped down to the final path
// component, control chars removed, and empty/dot-only results replaced
// with a generic name. Exported for direct unit testing.
export function sanitizeDownloadFilename(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\x00-\x1f\x7f]/g, "").trim();
  if (cleaned === "" || cleaned === "." || cleaned === "..") return "download";
  return cleaned.slice(0, 255);
}

// Unique-ify a save path on collision: invoice.pdf → invoice-1.pdf,
// invoice-2.pdf, … so repeated downloads never overwrite earlier ones.
function uniqueDownloadPath(dir: string, filename: string): string {
  let candidate = join(dir, filename);
  if (!existsSync(candidate)) return candidate;
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : "";
  for (let i = 1; ; i++) {
    candidate = join(dir, `${stem}-${i}${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
}

// Approved-download executor. Called by agent.executeApprovedAction after
// the user explicitly authorizes a browser.download approval (mirrors
// browserUploadFileApproved). Clicks the approved element, captures the
// resulting download via Playwright's download event, and saves it under
// the instance-scoped downloads dir with a sanitized, collision-safe
// filename. The saved file is size-capped post-save (over-cap files are
// deleted). Returns the standard redacted envelope reporting the saved
// path, size, and the server's suggested filename.
export async function browserDownloadApproved(
  taskId: string,
  ref: string,
  instance: Instance
): Promise<string> {
  try {
    return await withSession(taskId, async (session) => {
      // Trust boundary: the approval was granted for the exact stamped
      // element — no resolveRefForAction self-healing here; a lost stamp
      // fails loudly (same stance as browser_upload_file; see ADR
      // browser-fill-secret.md). The liveness pre-check below keeps that
      // stance: it exists only to fail FAST with actionable guidance when
      // the stamped node vanished between approval and execution (the
      // common case: downloading from a row menu that closed after the
      // previous download), instead of hanging 10s in the click and
      // surfacing a raw Playwright timeout the model then burns minutes
      // investigating. Unit tests plant minimal locator stubs without
      // count(); treat those as live (same guard as resolveRefForAction).
      const target = session.refs.get(ref);
      if (!target) return fail(`Unknown ref ${ref}. Take a fresh snapshot first.`);
      if (typeof target.locator.count === "function") {
        let stampedCount = 0;
        try {
          stampedCount = await target.locator.count();
        } catch {
          // A failing count (page navigating mid-call, context churn)
          // reads as a lost stamp: same fast, actionable failure.
        }
        if (stampedCount === 0) {
          return fail(`The element for ${ref} is no longer on the page — it re-rendered or a menu closed since the snapshot. Take a fresh browser_snapshot and retry with the new ref.`);
        }
      }
      if (typeof session.page.waitForEvent !== "function") {
        return fail("Download capture is not supported by this browser session.");
      }
      const downloadPromise = session.page.waitForEvent("download", { timeout: downloadEventTimeoutMs });
      // Pre-attach a no-op catch: if the click below throws (and we
      // return its failure), the still-pending wait eventually times out
      // and must not surface as an unhandled rejection.
      downloadPromise.catch(() => undefined);
      await target.locator.click({ timeout: 10_000 });
      let download: Awaited<typeof downloadPromise>;
      try {
        download = await downloadPromise;
      } catch {
        // The wait expired (or the page went away) with no download
        // event. The common cause: the link points at content the
        // browser renders inline (Chrome opens PDFs in its viewer
        // instead of downloading), so no download ever fires. Steer the
        // model to the path that works for inline content.
        return fail(
          "The click did not trigger a file download. Content the browser renders inline (like PDFs) never fires a download — use browser_navigate to open the URL instead; PDF text is extracted on navigation."
        );
      }
      // Trust boundary: the approval named the PAGE the click happens on,
      // but the browser fetches the download from wherever the element
      // points (redirect targets, signed CDN URLs, attacker-controlled
      // hrefs) — so the actual download SOURCE must pass the same SSRF
      // gate + agent domain policy as navigation before any bytes are
      // saved. On a block the transfer is cancelled and nothing is kept.
      // blob:/data: sources skip the gate: those are client-generated
      // downloads (the common "export CSV" anchor pattern) whose bytes
      // come from the already-gated page with no network fetch, so SSRF
      // and domain policy don't apply — the size cap, filename
      // sanitization, and audit below still do.
      // An empty URL skips the gate too: real Playwright Download.url()
      // always returns the source URL; only test fakes lack it.
      const downloadUrl = typeof download.url === "function" ? download.url() : "";
      const clientGenerated = downloadUrl.startsWith("blob:") || downloadUrl.startsWith("data:");
      const sourceBlock = downloadUrl && !clientGenerated
        ? safetyCheck(downloadUrl) ?? domainPolicyBlockReason(downloadUrl, agentDomainPolicyForTask(taskId))
        : undefined;
      if (sourceBlock) {
        if (typeof download.cancel === "function") {
          await download.cancel().catch(() => undefined);
        }
        return fail(`${sourceBlock} (download source URL)`);
      }
      const suggested = typeof download.suggestedFilename === "function" ? download.suggestedFilename() : "";
      const filename = sanitizeDownloadFilename(suggested || "download");
      const dir = downloadsDir(instance);
      mkdirSync(dir, { recursive: true });
      const savedPath = uniqueDownloadPath(dir, filename);
      await download.saveAs(savedPath);
      const size = statSync(savedPath).size;
      if (size > downloadMaxBytes) {
        try {
          unlinkSync(savedPath);
        } catch {
          // Best-effort cleanup; the failure message below still tells
          // the model (and the audit trail) the cap fired.
        }
        return fail(`Download exceeds the ${Math.floor(downloadMaxBytes / (1024 * 1024))}MB size cap (${size} bytes); the file was deleted.`);
      }
      return ok({
        url: session.page.url(),
        // The real source the bytes came from (gated above) — surfaced so
        // the audit row records where the download actually originated,
        // not just the page it was triggered from.
        downloadUrl: downloadUrl || null,
        path: savedPath,
        suggestedFilename: suggested || null,
        size
      }, taskId);
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

// Internal hooks exported for unit tests. The session manager keeps its
// state module-local so production callers don't accidentally poke at the
// shared browser; tests need controlled access to verify the
// disconnect generation, inFlight draining, and the CDP-safe close fallback.
export const __test = {
  // Bump the disconnect generation as if a disconnect ran. Tests that
  // need to simulate "disconnect mid-admission" call this between
  // capturing the current generation and resuming the admission.
  bumpDisconnectGenerationForTest(): number {
    return ++disconnectGeneration;
  },
  currentDisconnectGenerationForTest(): number {
    return disconnectGeneration;
  },
  setInFlightDisconnectsForTest(value: number): void {
    inFlightDisconnects = value;
  },
  inFlightDisconnectsForTest(): number {
    return inFlightDisconnects;
  },
  installPendingSharedForTest(promise: Promise<SharedHandle>): void {
    pendingShared = promise;
  },
  clearPendingSharedForTest(): void {
    pendingShared = null;
  },
  // Shrink the teardown close/disconnect budget so the wedged-Chromium
  // tests fire the timeout in milliseconds instead of waiting the full 5s.
  setTeardownCloseTimeoutForTest(ms: number): void {
    teardownCloseTimeoutMs = ms;
  },
  resetTeardownCloseTimeoutForTest(): void {
    teardownCloseTimeoutMs = 5_000;
  },
  // Swap the profile-dir Chromium reaper so the wedged-close test can
  // assert it's invoked on timeout without scanning real `ps`.
  setChromeKillerForTest(fn: (profileDir: string) => number): void {
    chromeKiller = fn;
  },
  resetChromeKillerForTest(): void {
    chromeKiller = killChromeByProfileDir;
  },
  // Clear the registered runtime instance so a test that set one via
  // setBrowserInstance() doesn't leak it into sibling tests.
  resetBrowserInstanceForTest(): void {
    runtimeInstance = undefined;
  },
  // Swap the session provider so the seam-dispatch test can verify
  // ensureShared / teardownHandle route through the registry without touching
  // playwright-core. Pass null to restore the built-in provider.
  setSessionProviderForTest(kind: Mode, provider: BrowserSessionProvider | null): void {
    const builtIn: Record<Mode, BrowserSessionProvider> = {
      spawned: spawnedSessionProvider,
      cdp: cdpSessionProvider
    };
    sessionProviders[kind] = provider ?? builtIn[kind];
  },
  // Swap the spawn-and-attach launcher so the spawned-provider tests exercise
  // the real provider body without launching Chrome. Pass null to restore the
  // production launcher.
  setSpawnChromeForTest(fn: typeof launchSpawnedChrome | null): void {
    spawnChrome = fn ?? launchSpawnedChrome;
  },
  // Read the resolved per-instance spawned profile dir (exercises the
  // no-instance throw).
  spawnedProfileDirForTest(): string {
    return spawnedProfileDir();
  },
  // Drive the provider's connect() directly so the spawned body (no-instance
  // refusal) can be exercised without routing a whole tool call.
  connectProviderForTest(kind: Mode, record?: BrowserConnectionRecord): Promise<SharedHandle> {
    return sessionProviders[kind].connect(record);
  },
  // Reset the memoized chromium import so a test that stubs the cdp connect
  // path doesn't leak the real (or a faked) playwright-core namespace.
  resetChromiumImportForTest(): void {
    chromiumImport = undefined;
  },
  // Reset the opt-in recording flag and any active trace claim so
  // recording tests don't leak state into siblings.
  resetSessionTraceForTest(): void {
    browserRecordingEnabled = false;
    activeTraceTaskId = null;
  },
  activeTraceTaskIdForTest(): string | null {
    return activeTraceTaskId;
  },
  // Direct access to the bounded-retention pruner so the keep-newest-N
  // behavior can be pinned without driving a whole session lifecycle.
  pruneTraceFilesForTest(dir: string): void {
    pruneTraceFiles(dir);
  },
  // Install a fake spawned handle so getScreencastPort, the close-path
  // teardown assertions, and the spawned teardown can be exercised without
  // launching Chrome. The context's browser().isConnected() drives liveness
  // (getScreencastPort only returns the port for a LIVE spawned handle).
  installFakeSpawnedHandleForTest(
    port: number,
    context: Pick<BrowserContext, "close"> & Partial<{ pages: () => Page[]; browser: () => unknown }>,
    profileDir = "/tmp/fake-spawn-profile"
  ): void {
    shared = { kind: "spawned", context: context as BrowserContext, port, profileDir };
  },
  // Install a fake cdp handle so the cdp liveness probe (isHandleAlive checks
  // the remote Browser's isConnected()) and getScreencastPort's cdp guard
  // (returns null — no port we own) can be exercised without a real attach.
  installFakeCdpHandleForTest(
    browser: Pick<Browser, "isConnected">,
    context: Pick<BrowserContext, "close"> & Partial<{ pages: () => Page[] }>
  ): void {
    shared = { kind: "cdp", browser: browser as Browser, context: context as BrowserContext };
  },
  // Liveness probe over the currently-installed shared handle. Null when no
  // handle is installed. Lets tests assert that an externally-killed Chrome
  // (context.browser().isConnected() === false) is detected as dead so
  // ensureShared relaunches instead of reusing the stale handle.
  isSharedHandleAliveForTest(): boolean | null {
    return shared ? isHandleAlive(shared) : null;
  },
  uninstallFakeBrowserForTest(): { kind: SharedHandle["kind"] | null } {
    const captured = { kind: shared?.kind ?? null };
    shared = null;
    return captured;
  },
  // Synchronously poke inFlight on a synthetic session so the drain
  // test can verify disconnect waits without spinning up Playwright.
  installFakeSessionForTest(taskId: string, inFlight: number): void {
    const fakePage = { close: () => Promise.resolve() } as unknown as Page;
    sessions.set(taskId, {
      context: {} as BrowserContext,
      page: fakePage,
      refs: new Map(),
      lastActivity: Date.now(),
      inFlight,
      ownedPageIds: new Set<Page>([fakePage]),
      nextRefId: 1,
      tabHandles: new Map(),
      nextTabHandleId: 1
    });
  },
  // Install a synthetic session with a caller-provided `page` so tool
  // entry points (browserVision, etc.) can be exercised against a
  // hand-built page without spawning Chromium.
  installFakeSessionWithPageForTest(taskId: string, page: Partial<Page>): void {
    const realPage = page as unknown as Page;
    sessions.set(taskId, {
      context: {} as BrowserContext,
      page: realPage,
      refs: new Map(),
      lastActivity: Date.now(),
      inFlight: 0,
      ownedPageIds: new Set<Page>([realPage]),
      nextRefId: 1,
      tabHandles: new Map(),
      nextTabHandleId: 1
    });
  },
  // Install a synthetic session with both a `page` and `context` so tab-
  // management tests (which read context.pages() and call context.newPage())
  // can exercise the entire flow without spawning Chromium.
  installFakeSessionWithPageAndContextForTest(
    taskId: string,
    page: Partial<Page>,
    context: Partial<BrowserContext>
  ): void {
    const realPage = page as unknown as Page;
    sessions.set(taskId, {
      context: context as unknown as BrowserContext,
      page: realPage,
      refs: new Map(),
      lastActivity: Date.now(),
      inFlight: 0,
      ownedPageIds: new Set<Page>([realPage]),
      nextRefId: 1,
      tabHandles: new Map(),
      nextTabHandleId: 1
    });
  },
  // Read the currently-installed page on a fake session so tests can
  // assert that a tab-management operation actually swapped session.page.
  getFakeSessionPageForTest(taskId: string): Page | undefined {
    return sessions.get(taskId)?.page;
  },
  // Read the entire fake session so tests can mutate ownedPageIds directly
  // (used by the closeSession drain test to simulate agent-opened tabs).
  getFakeSessionForTest(taskId: string): Session | undefined {
    return sessions.get(taskId);
  },
  // Run closeSession against a synthetic session — the production
  // closeSession is module-private, but tests need to exercise its
  // ownedPageIds drain behavior end-to-end.
  closeSessionForTest(taskId: string): Promise<void> {
    return closeSession(taskId);
  },
  // Read the currently-installed refs map so tests can assert it was
  // cleared (e.g. tab switch / new / close should clear the refs).
  getFakeSessionRefsForTest(taskId: string): Map<string, RefTarget> | undefined {
    return sessions.get(taskId)?.refs;
  },
  // Set the refs map on a fake session so tests can plant a fake locator
  // keyed by `@eN` before invoking a tool that needs to resolve it.
  // Values are either RefTarget-shaped objects (locator is an OBJECT —
  // tests exercising stale-ref healing pass role/name/nth metadata) or
  // bare locator stubs, which get wrapped with empty healing metadata.
  // The discrimination key is `typeof value.locator`: a real Locator's
  // own `.locator` property is a sub-locator FACTORY (function), so a
  // bare stub that happens to expose `.locator(sel)` still normalizes
  // as a locator, not a RefTarget.
  setFakeSessionRefsForTest(taskId: string, refs: Map<string, unknown>): void {
    const session = sessions.get(taskId);
    if (!session) return;
    const normalized = new Map<string, RefTarget>();
    for (const [key, value] of refs) {
      const maybe = value as { locator?: unknown; role?: unknown; name?: unknown; nth?: unknown; framed?: unknown };
      if (maybe !== null && typeof maybe === "object" && typeof maybe.locator === "object" && maybe.locator !== null) {
        normalized.set(key, {
          locator: maybe.locator as Locator,
          role: typeof maybe.role === "string" ? maybe.role : "",
          name: typeof maybe.name === "string" ? maybe.name : "",
          nth: typeof maybe.nth === "number" ? maybe.nth : 0,
          ...(maybe.framed === true ? { framed: true } : {})
        });
      } else {
        normalized.set(key, { locator: value as Locator, role: "", name: "", nth: 0 });
      }
    }
    session.refs = normalized;
  },
  setFakeSessionInFlight(taskId: string, inFlight: number): void {
    const session = sessions.get(taskId);
    if (session) session.inFlight = inFlight;
  },
  // Override the browser_download size cap so cap-rejection tests don't
  // need to materialize a 50MB file. Pass null to restore the default.
  setDownloadMaxBytesForTest(value: number | null): void {
    downloadMaxBytes = value ?? DOWNLOAD_MAX_BYTES_DEFAULT;
  },
  // Shrink the download-event wait so the no-download failure path can be
  // exercised without the 30s production timeout. Pass null to restore.
  setDownloadEventTimeoutForTest(value: number | null): void {
    downloadEventTimeoutMs = value ?? DOWNLOAD_EVENT_TIMEOUT_MS_DEFAULT;
  },
  // Stub the PDF text extractor so navigation tests never load
  // pdfjs-dist. Pass null to restore the lazy attachment-extract path.
  setPdfTextExtractorForTest(extractor: ((bytes: Uint8Array) => Promise<{ text: string } | null>) | null): void {
    pdfTextExtractor = extractor ?? defaultPdfTextExtractor;
  },
  // Override the PDF extraction byte cap so over-cap tests don't need a
  // 20MB buffer. Pass null to restore the default.
  setPdfExtractMaxBytesForTest(value: number | null): void {
    pdfExtractMaxBytes = value ?? PDF_EXTRACT_MAX_BYTES_DEFAULT;
  },
  // Stub the native PDF re-fetch so its cookie/redirect/cap logic can be
  // exercised without touching the network. Pass null to restore.
  setPdfRefetchFetchForTest(impl: ((url: string, init: RequestInit) => Promise<Response>) | null): void {
    pdfRefetchFetch = impl ?? defaultPdfRefetchFetch;
  },
  // Register a secret value for a task exactly as browserFillByLocator
  // would, so the safetyCheck registered-secret URL gate can be
  // exercised without driving a real fill.
  recordFilledSecretForTest(taskId: string, value: string): void {
    recordFilledSecret(taskId, value);
  },
  // Drop every per-task secret registry so registered-secret tests
  // don't leak redaction targets into sibling tests.
  resetFilledSecretsForTest(): void {
    filledSecretValues.clear();
  },
  clearFakeSessionsForTest(): void {
    sessions.clear();
    // Match the real session-teardown contract: also drop the
    // per-task secret-redaction registry and dialog state so tests
    // that install fake sessions then call this helper don't leak
    // state into subsequent tests.
    filledSecretValues.clear();
    pendingDialogResponses.clear();
    unreportedDialogs.clear();
    networkLogs.clear();
  },
  // Hook a fake page's response/requestfailed events for a task exactly
  // as getOrCreate / browser_tabs would, so network capture can be
  // exercised by invoking the registered handlers — no Chromium.
  attachNetworkCaptureForTest(taskId: string, page: Page): void {
    attachNetworkCapture(taskId, page);
  },
  // Hook a fake page's dialog events for a task exactly as getOrCreate /
  // browser_tabs would, so dialog capture can be exercised by invoking
  // the registered handler with a fake Dialog — no Chromium.
  attachDialogHandlerForTest(taskId: string, page: Page): void {
    attachDialogHandler(taskId, page);
  },
  // Read (without draining) the task's unreported dialog buffer.
  peekUnreportedDialogsForTest(taskId: string): DialogRecord[] {
    return unreportedDialogs.get(taskId) ?? [];
  },
  // Expose the server-side loopback boundary check for direct unit
  // testing — snapshot() and browser_console both gate on it.
  disallowedOriginReasonForTest(page: Page, taskId?: string): Promise<string | undefined> {
    return disallowedOriginReason(page, taskId);
  },
  // Seed / read the per-task console-log buffer so tests can assert that a
  // blocked browser_console call drops captured control-plane output.
  seedConsoleLogsForTest(taskId: string, msgs: { type: string; text: string }[]): void {
    consoleLogs.set(taskId, msgs);
  },
  getConsoleLogsForTest(taskId: string): { type: string; text: string }[] | undefined {
    return consoleLogs.get(taskId);
  },
  // Expose the in-page walker for direct unit testing. Callers supply a
  // fake Page whose `evaluate(fn, arg)` runs `fn(arg)` locally against
  // a pre-populated `globalThis.document` (and friends) — that lets
  // browser walk semantics be asserted without spawning Chromium. Pass
  // taskId (with a fake session installed) to exercise the session-scoped
  // ref-stability / navigation-reset behavior.
  snapshotForTest(page: Page, full: boolean, taskId?: string): Promise<SnapshotResult> {
    return snapshot(page, full, taskId);
  },
  // Direct access to the diff renderer so its formatting rules — the
  // "(no changes)" body, hunk separators, the LCS cell cap — can be
  // asserted without driving a full page walk.
  renderSnapshotDiffForTest(prevText: string, currText: string): string | undefined {
    return renderSnapshotDiff(prevText, currText);
  },
  // Expose the browser_vision route gate (native-image vs aux side-call)
  // so its secret-registry × model-capability matrix can be pinned
  // without a provider call.
  resolveVisionRouteForTest(config: RuntimeConfig): VisionRoute {
    return resolveVisionRoute(config);
  }
};

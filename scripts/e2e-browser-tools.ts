// Live end-to-end harness for the browser toolset.
//
// Requires a running gini runtime on $GINI_RUNTIME_BASE (default
// http://localhost:7426) with the codex provider configured. Each test
// creates a fresh chat session, submits a prompt that should drive the
// agent to use a specific browser tool, polls the task to completion, and
// asserts on (a) the agent's final assistant message and (b) the trace
// showing the expected tool calls actually fired.
//
// Usage:
//   GINI_RUNTIME_BASE=http://localhost:7426 \
//   GINI_RUNTIME_TOKEN=<token> \
//   bun run scripts/e2e-browser-tools.ts [test-name]

const BASE = process.env.GINI_RUNTIME_BASE ?? "http://localhost:7426";
const TOKEN = process.env.GINI_RUNTIME_TOKEN ?? "";
const FILTER = process.argv[2];

// Tiny local fixture server so the agent can hit pages with predictable
// top-level DOM (no iframes, no anti-bot). The runtime's safetyCheck only
// allows http(s) URLs, so a localhost server is the cleanest substitute
// for data: URLs.
function startFixtureServer(): { url: string; close: () => void } {
  const routes: Record<string, { contentType: string; body: string }> = {
    "/select": {
      contentType: "text/html",
      body: `<!doctype html><html><head><title>select-fixture</title></head><body>
<h1>Select fixture</h1>
<select id="cars" onchange="document.title='picked-'+this.value">
  <option value="audi">Audi</option>
  <option value="bmw">BMW</option>
  <option value="ford">Ford</option>
</select>
<p>Current value: <span id="out">audi</span></p>
<script>document.getElementById('cars').addEventListener('change', e => { document.getElementById('out').textContent = e.target.value; });</script>
</body></html>`
    },
    "/hover": {
      contentType: "text/html",
      body: `<!doctype html><html><head><title>hover-fixture</title></head><body>
<button id="target" onmouseenter="document.getElementById('reveal').textContent='TREASURE-FOUND'">Hover me</button>
<div id="reveal">(hidden)</div>
</body></html>`
    },
    "/drag": {
      contentType: "text/html",
      body: `<!doctype html><html><head><title>drag-fixture</title></head><body>
<div id="src" draggable="true" style="width:100px;height:100px;background:#eee;display:inline-block">SOURCE</div>
<div id="dst" style="width:100px;height:100px;background:#ddd;display:inline-block;margin-left:80px">TARGET</div>
<div id="result">(no drop)</div>
<script>
const src = document.getElementById('src');
const dst = document.getElementById('dst');
src.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', 'PAYLOAD-X'); });
dst.addEventListener('dragover', (e) => { e.preventDefault(); });
dst.addEventListener('drop', (e) => {
  e.preventDefault();
  const data = e.dataTransfer.getData('text/plain');
  document.getElementById('result').textContent = 'DROP-OK-' + data;
});
</script>
</body></html>`
    },
    "/upload": {
      contentType: "text/html",
      body: `<!doctype html><html><head><title>upload-fixture</title></head><body>
<form>
  <input type="file" id="picker" onchange="document.getElementById('out').textContent = this.files[0] ? this.files[0].name : 'none';">
</form>
<div id="out">(no file)</div>
</body></html>`
    }
  };
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      const route = routes[path];
      if (!route) return new Response("not found", { status: 404 });
      return new Response(route.body, { headers: { "content-type": route.contentType } });
    }
  });
  return {
    url: `http://localhost:${server.port}`,
    close: () => server.stop()
  };
}

const FIXTURE = startFixtureServer();
process.on("beforeExit", () => FIXTURE.close());

const HEADERS = {
  "content-type": "application/json",
  ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {})
};

async function api(path: string, init?: RequestInit & { body?: unknown }) {
  const url = `${BASE}${path}`;
  const body = init?.body !== undefined ? JSON.stringify(init.body) : undefined;
  const response = await fetch(url, { ...init, headers: HEADERS, body });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} → HTTP ${response.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

interface ChatSession {
  id: string;
}

interface ChatMessageResult {
  taskId: string;
  runId?: string;
}

interface Task {
  id: string;
  status: string;
  partialSummary?: string;
  summary?: string;
  currentStep?: string;
  error?: string | null;
  cost?: { totalTokens?: number };
}

interface TraceEvent {
  type: string;
  message: string;
  data?: Record<string, unknown>;
}

async function createSession(title: string): Promise<ChatSession> {
  return api("/api/chat", { method: "POST", body: { title } });
}

async function submitMessage(sessionId: string, content: string): Promise<ChatMessageResult> {
  const result = (await api(`/api/chat/${sessionId}/messages`, { method: "POST", body: { content } })) as {
    taskId?: string;
    runId?: string;
    accepted?: boolean;
    blockId?: string;
  };
  if (result.taskId) return { taskId: result.taskId, runId: result.runId };
  // Echo-first ack: the POST resolves before the routing verdict, so the
  // taskId lands on the echo block once dispatch completes — poll for it.
  if (!result.accepted || !result.blockId) {
    throw new Error(`Unexpected submit response: ${JSON.stringify(result)}`);
  }
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const { blocks } = (await api(`/api/chat/${sessionId}/blocks`)) as {
      blocks: Array<{ id: string; taskId?: string; runId?: string }>;
    };
    const echo = blocks.find((block) => block.id === result.blockId);
    if (echo?.taskId) return { taskId: echo.taskId, runId: echo.runId };
    await Bun.sleep(250);
  }
  throw new Error(`Message ${result.blockId} was not dispatched to a task within 30s`);
}

async function getTaskAndTrace(taskId: string): Promise<{ task: Task; trace: TraceEvent[] }> {
  const result = await api(`/api/tasks/${taskId}`);
  return { task: result.task as Task, trace: (result.trace ?? []) as TraceEvent[] };
}

async function getTask(taskId: string): Promise<Task> {
  return (await getTaskAndTrace(taskId)).task;
}

async function waitForCompletion(taskId: string, timeoutMs: number): Promise<Task> {
  const deadline = Date.now() + timeoutMs;
  let lastStep = "";
  while (Date.now() < deadline) {
    const task = await getTask(taskId);
    if (task.currentStep && task.currentStep !== lastStep) {
      lastStep = task.currentStep;
      process.stdout.write(`    → ${task.currentStep}\n`);
    }
    // Auto-approve any pending approvals so we can exercise approval-gated
    // tools (e.g. browser_upload_file) end-to-end without a human in the
    // loop. This harness is local-only and the user explicitly invokes it.
    if (task.status === "waiting_approval" || task.status === "awaiting_approval" || (task.status === "running" && task.currentStep?.toLowerCase().includes("approval"))) {
      const approvals = (await api(`/api/authorizations`)) as Array<{ id: string; taskId: string; status: string }>;
      const pending = approvals.find((a) => a.taskId === taskId && a.status === "pending");
      if (pending) {
        process.stdout.write(`    → auto-approving ${pending.id}\n`);
        await api(`/api/authorizations/${pending.id}/approve`, { method: "POST" });
      }
    }
    if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
      return task;
    }
    await Bun.sleep(2000);
  }
  throw new Error(`Task ${taskId} did not complete within ${timeoutMs}ms`);
}

interface TestCase {
  name: string;
  prompt: string;
  expectedToolNames: string[];
  expectInFinalText: (text: string) => boolean;
  timeoutMs?: number;
}

const TESTS: TestCase[] = [
  {
    name: "browser_select_option",
    prompt:
      `Use the browser tools. Navigate to ${FIXTURE.url}/select — it serves a page with a top-level <select id='cars'> containing Audi/BMW/Ford. ` +
      "Take a snapshot to find the <select>'s @eN ref, then use browser_select_option to pick BMW (value 'bmw'). " +
      "After that, use browser_console with expression `document.getElementById('cars').value` to verify, then reply with the value on its own line prefixed with 'SELECTED='.",
    expectedToolNames: ["browser.navigate", "browser.select_option"],
    expectInFinalText: (text) => /SELECTED=bmw/i.test(text),
    timeoutMs: 240_000
  },
  {
    name: "browser_hover",
    prompt:
      `Use the browser tools. Navigate to ${FIXTURE.url}/hover. The page has a button labelled 'Hover me'. ` +
      "Snapshot to find its @eN ref, then call browser_hover on it. After the hover, take another snapshot or use browser_console with expression `document.getElementById('reveal').textContent` to read the revealed text. " +
      "Reply with that revealed text on its own line prefixed with 'REVEAL='.",
    expectedToolNames: ["browser.navigate", "browser.hover"],
    expectInFinalText: (text) => /TREASURE-FOUND/i.test(text),
    timeoutMs: 240_000
  },
  {
    name: "browser_tabs",
    prompt:
      "Use the browser tools. Open two tabs: tab 1 at https://example.com/ and tab 2 at https://www.iana.org/. " +
      "Use browser_tabs with action 'list' to confirm both are open, then switch to tab 1 and tell me its title. " +
      "Reply with the title on its own line prefixed with 'TITLE='.",
    expectedToolNames: ["browser.navigate", "browser.tabs.list", "browser.tabs.switch"],
    expectInFinalText: (text) => /example domain/i.test(text),
    timeoutMs: 240_000
  },
  {
    name: "browser_wait_for",
    prompt:
      "Use the browser tools. Navigate to https://httpbin.org/delay/2 (this URL takes ~2 seconds to respond). " +
      "After navigating, use browser_wait_for with text:'origin' and timeoutMs:8000 to be sure the JSON has loaded. " +
      "Then read the page content (browser_snapshot or browser_console) and tell me the value of the 'origin' field. " +
      "Reply with that IP address on its own line prefixed with 'ORIGIN='.",
    expectedToolNames: ["browser.navigate", "browser.wait_for"],
    expectInFinalText: (text) => /ORIGIN=\d+\.\d+\.\d+\.\d+/.test(text) || /\b\d+\.\d+\.\d+\.\d+\b/.test(text),
    timeoutMs: 240_000
  },
  {
    name: "browser_vision",
    prompt:
      "Use the browser tools. Navigate to https://example.com and then call browser_vision with the question " +
      "'What is the main heading on this page, word-for-word?'. Report back the model's answer. Reply with the heading " +
      "on its own line prefixed with 'HEADING='.",
    expectedToolNames: ["browser.navigate", "browser.vision"],
    expectInFinalText: (text) => /example domain/i.test(text),
    timeoutMs: 240_000
  },
  {
    name: "browser_drag",
    prompt:
      `Use the browser tools. Navigate to ${FIXTURE.url}/drag. The page has a draggable SOURCE box and a TARGET box. ` +
      "Take a snapshot to find the two box refs, then use browser_drag with fromRef=SOURCE-ref and toRef=TARGET-ref. " +
      "After the drag, use browser_console with expression `document.getElementById('result').textContent` to read the result, then reply with that text on its own line prefixed with 'DROP='.",
    expectedToolNames: ["browser.navigate", "browser.drag"],
    expectInFinalText: (text) => /DROP-OK-PAYLOAD-X/.test(text) || /DROP=.*DROP-OK/.test(text),
    timeoutMs: 240_000
  },
  {
    name: "browser_upload_file",
    prompt:
      `Use the browser tools. Navigate to ${FIXTURE.url}/upload. The page has a file <input>. ` +
      "Take a snapshot, find the file input's ref, then use browser_upload_file with that ref and path 'e2e-upload-fixture.txt' (a file at the workspace root). " +
      "After the upload completes (the user will approve it), use browser_console with expression `document.getElementById('out').textContent` to read what filename appears on the page. " +
      "Reply with that filename on its own line prefixed with 'UPLOADED='.",
    expectedToolNames: ["browser.navigate", "browser.upload_file"],
    expectInFinalText: (text) => /UPLOADED=e2e-upload-fixture\.txt/.test(text) || /e2e-upload-fixture\.txt/i.test(text),
    timeoutMs: 300_000
  }
];

async function run(test: TestCase): Promise<{ ok: boolean; reason: string; task: Task; trace: TraceEvent[] }> {
  console.log(`\n=== ${test.name} ===`);
  const session = await createSession(`e2e-${test.name}-${Date.now()}`);
  const submission = await submitMessage(session.id, test.prompt);
  console.log(`    task ${submission.taskId}`);
  await waitForCompletion(submission.taskId, test.timeoutMs ?? 180_000);
  const { task, trace } = await getTaskAndTrace(submission.taskId);
  const finalText = task.summary ?? task.partialSummary ?? "";
  const toolActions = trace
    .filter((e) => e.type === "tool" || e.type === "error")
    .map((e) => {
      const data = e.data as Record<string, unknown> | undefined;
      return typeof data?.action === "string" ? data.action : null;
    })
    .filter((s): s is string => Boolean(s));
  const missingTools = test.expectedToolNames.filter((needed) => !toolActions.some((a) => a === needed || a.startsWith(needed)));
  const textOk = test.expectInFinalText(finalText);
  const ok = task.status === "completed" && missingTools.length === 0 && textOk;
  const reason = ok
    ? "PASS"
    : `FAIL: status=${task.status}; missingTools=[${missingTools.join(",")}]; textMatch=${textOk}; text=${finalText.slice(0, 200)}`;
  console.log(`    tools called: ${toolActions.join(", ")}`);
  console.log(`    final text: ${finalText.slice(0, 400)}`);
  console.log(`    ${reason}`);
  return { ok, reason, task, trace };
}

async function main() {
  const filtered = FILTER ? TESTS.filter((t) => t.name.includes(FILTER)) : TESTS;
  if (filtered.length === 0) {
    console.error(`No tests match filter "${FILTER}"`);
    process.exit(2);
  }
  console.log(`Running ${filtered.length} tests against ${BASE}`);
  const summary: Array<{ name: string; ok: boolean; reason: string }> = [];
  for (const test of filtered) {
    try {
      const result = await run(test);
      summary.push({ name: test.name, ok: result.ok, reason: result.reason });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`    ABORTED: ${message}`);
      summary.push({ name: test.name, ok: false, reason: `ABORT: ${message}` });
    }
  }
  console.log("\n=== Summary ===");
  for (const row of summary) console.log(`  ${row.ok ? "PASS" : "FAIL"}  ${row.name}  ${row.reason.slice(0, 200)}`);
  const failed = summary.filter((s) => !s.ok).length;
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

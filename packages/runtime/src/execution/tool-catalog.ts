// Tool catalog: the OpenAI-shaped tool specs the chat-task agent loop
// exposes to the model. Each tool name corresponds to a dispatch handler
// in src/execution/tool-dispatch.ts. Specs mirror the existing imperative
// tools in src/tools/* — same approval gating, same audit + trace surface.
//
// The list returned here is filtered by enabled toolsets (from
// `RuntimeState.toolsets`) so the user can disable a toolset and have the
// model never see its tools, just like the legacy /toolsets page.

import { createHash } from "node:crypto";
import type { ToolFunctionSpec } from "../provider";
import type { RuntimeState } from "../types";

// Canonical tool list. Initial set mirrors src/tools/* one-for-one. We keep
// each entry small and self-documenting so models with weaker tool-calling
// (local Llamas, some compat providers) still understand what each tool
// does without extra system-prompt context.
//
// `displayLabel` is the human-readable short label clients render in
// tool_call ChatBlocks. Server-side ownership keeps the labels consistent
// across web / mobile / CLI bridges (see ADR chat-block-protocol.md).
// When omitted on a TOOL_DEFS entry, `chatBlockLabelFor` falls back to a
// humanized version of the tool name.
//
// `deferred` marks a tool whose full schema is NOT shipped to the provider
// until the model loads it via the `load_tools` meta-tool. A deferred tool's
// NAME + `indexSummary` still surface in the system-prompt "available on
// demand" index so the model knows the capability exists; the schema only
// joins the provider `tools` array once loaded. This keeps the live
// full-schema tool count low (weak local providers degrade past ~30-50 live
// tools) while preserving access to the whole catalog. `indexSummary` is the
// one-line description used in that index (falls back to the description's
// first sentence when omitted).
//
// `crossToolsetHint` is a routing sentence that points the model at a
// sibling toolset (e.g. browser_navigate → web_search for plain content
// retrieval). buildToolCatalog appends it to the description only when the
// referenced toolset is reachable in the assembled catalog — same gate the
// referenced tools themselves pass — so the model is never steered toward
// tools it doesn't have. The hint text must name only tools that toolset
// actually guarantees; steers toward ALWAYS-ON tools (web_fetch bypasses
// toolset gating entirely) belong in the base description instead, where
// no gate can drop them while the tool exists.
const TOOL_DEFS: Array<ToolFunctionSpec & { toolset: string; displayLabel?: string; deferred?: boolean; indexSummary?: string; crossToolsetHint?: { toolset: string; text: string } }> = [
  {
    toolset: "file",
    displayLabel: "Read file",
    type: "function",
    function: {
      name: "file_read",
      description: "Read a UTF-8 text file from the workspace. Returns up to 12000 characters.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative path." }
        },
        required: ["path"]
      }
    }
  },
  {
    toolset: "file",
    displayLabel: "List directory",
    type: "function",
    function: {
      name: "file_list",
      description: "List entries in a directory inside the workspace. Returns up to 200 entries.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative directory. Defaults to '.'.", default: "." }
        }
      }
    }
  },
  {
    toolset: "file",
    displayLabel: "Search files",
    type: "function",
    function: {
      name: "file_search",
      description: "Search workspace files for a substring (case-insensitive). Returns up to 100 path:line matches.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Substring to match." },
          path: { type: "string", description: "Workspace-relative directory to search. Defaults to '.'.", default: "." }
        },
        required: ["pattern"]
      }
    }
  },
  {
    toolset: "file",
    displayLabel: "Write file",
    type: "function",
    function: {
      name: "file_write",
      description: "Write a workspace file. Successful writes surface as an inline file card in chat, so use this for files the user should view here. Approval-gated: the user must approve before the file is written.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative path." },
          content: { type: "string", description: "Full file content to write." }
        },
        required: ["path", "content"]
      }
    }
  },
  {
    toolset: "file",
    displayLabel: "Patch file",
    type: "function",
    function: {
      name: "file_patch",
      description: "Patch a workspace file by replacing one block of text with another. Approval-gated.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative path." },
          oldText: { type: "string", description: "The exact existing text to replace. Must appear verbatim in the file." },
          newText: { type: "string", description: "The replacement text." }
        },
        required: ["path", "oldText", "newText"]
      }
    }
  },
  {
    // Web search via a configured provider connector (Brave Search or Exa).
    // Backed by `src/integrations/connectors/{brave-search,exa}.ts`. The
    // tool picks a healthy backend automatically when `provider` is
    // omitted, preferring Brave (free tier) over Exa (paid). Returns up
    // to `count` ranked results as compact text the model can cite.
    toolset: "web_search",
    displayLabel: "Web search",
    crossToolsetHint: {
      toolset: "browser",
      text: "For interacting with pages — clicking, typing, authenticated sessions — use the browser tools (browser_navigate) instead."
    },
    type: "function",
    function: {
      name: "web_search",
      description: "Search the public web. Returns up to `count` ranked results, each as `[N] title — url\\n    snippet`. Use this instead of guessing URLs or asking the user — it's the agent's primary way to discover fresh information. Reach for it BEFORE answering any question whose answer depends on a current, specific, or authoritative source (regulations, requirements, prices, hours, schedules, news, statistics, specific people/places/products/events, or any \"look it up\" request) rather than answering from training-time or recalled memory; only stable general knowledge (explanations, definitions, reasoning) should be answered without a search. Backends: Brave returns keyword web results (broad, fresh, free tier). Exa returns semantically-matched results with extracted content highlights (better for research / discovering substantive content on a concept). Default picks the first healthy connector (Brave preferred). If results don't fit the task, you may suggest the user set up the other backend via request_connector — never hardcode a choice; let the user decide. If this tool errors because no connector is configured, you still have live-web access — rather than answering from memory, query a search engine another way: use browser_navigate to open a search engine and read the results, or web_fetch a search-results URL (querying a real engine is searching; guessing random content URLs is not). You can also call request_connector for 'brave-search' (default) or 'exa' to add an API key for faster, cleaner results.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query." },
          count: { type: "number", description: "Max results to return. Defaults to 5; capped at 10.", default: 5 },
          provider: {
            type: "string",
            enum: ["brave-search", "exa"],
            description: "Optional explicit backend. When omitted, picks the first healthy connector (Brave preferred)."
          }
        },
        required: ["query"]
      }
    }
  },
  {
    toolset: "messaging",
    displayLabel: "Read",
    crossToolsetHint: {
      toolset: "browser",
      text: "For interacting with pages — clicking, typing, authenticated sessions — use the browser tools (browser_navigate) instead."
    },
    type: "function",
    function: {
      name: "web_fetch",
      description: "Fetch an HTTP/HTTPS URL and return up to 12000 characters of stripped text.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Absolute http(s) URL." }
        },
        required: ["url"]
      }
    }
  },
  {
    toolset: "terminal",
    displayLabel: "Run shell command",
    type: "function",
    function: {
      name: "terminal_exec",
      description: "Run a shell command in the workspace. Approval-gated; user must approve. Returns stdout/stderr and exit code. The working directory is the agent WORKSPACE root, not the user's home directory — `~` does NOT point at the workspace, so reference workspace files with relative paths (or absolute paths inside the workspace), never `~/...`. Set timeoutMs explicitly for slow commands (Apple/AppleScript-backed CLIs like memo or remindctl can take 30+ seconds; brew installs can take minutes). Set pty=true for interactive CLI tools (vim, memo, claude-code, codex, python repl) — without pty they hang or exit immediately because stdin is not a TTY. Commands always run with a clean env: no connector secrets are ever injected, so a Linear-token leak can't ride alongside a curl invocation. A command that genuinely needs a connector credential must ship as a skill script and be invoked via `skill_run` — that is the only path connector secrets enter a process.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command line. Runs through `zsh -lc`." },
          timeoutMs: { type: "number", description: "Maximum runtime before kill, in milliseconds. Defaults to 60000 (60s). Bump for slow ops (memo/remindctl scans, brew installs, network).", default: 60000 },
          pty: { type: "boolean", description: "Set true for interactive CLIs that need a TTY (vim, memo, claude-code, codex, python repl). When true the command is spawned under a pseudo-terminal so it doesn't see stdin-is-not-tty errors. Default false.", default: false }
        },
        required: ["command"]
      }
    }
  },
  {
    toolset: "terminal",
    displayLabel: "Run code",
    type: "function",
    function: {
      name: "code_exec",
      description: "Run a short snippet of code in a sandboxed shell. Approval-gated.",
      parameters: {
        type: "object",
        properties: {
          language: { type: "string", description: "Language to execute. Supported: js, ts, python." },
          code: { type: "string", description: "The code to run." }
        },
        required: ["language", "code"]
      }
    }
  },
  {
    // Skill catalog access. Always available so the model can opportunistically
    // load any enabled skill listed in the system prompt without waiting for
    // the user to enable a toolset. Sync, low-risk, no approval needed: the
    // body is just text content that already lives in state.
    toolset: "skills",
    displayLabel: "Read skill",
    type: "function",
    function: {
      name: "read_skill",
      description: "Read the full markdown body of an enabled skill by name. Use this when the system prompt advertises a skill and you need its instructions to follow.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Skill name (e.g. 'apple-notes')." }
        },
        required: ["name"]
      }
    }
  },
  {
    // Skill-learning feedback capture (ADR skill-learning-from-outcomes.md).
    // When the user answers a "Skill review" question about whether a recent
    // action turned out right, the model records the verdict here so the next
    // review reflects on it. Sync, low-risk: it only appends a SkillOutcome row.
    toolset: "skills",
    displayLabel: "Record skill feedback",
    // Deferred: it's reachable on any turn (a Skill review question can land in
    // any session) but is only needed when the user is answering one, so it
    // surfaces by name + summary in the on-demand index and the model loads its
    // schema via load_tools when it actually needs it. Keeping it out of the
    // live tools array avoids adding a schema slot to every turn.
    deferred: true,
    indexSummary: "Record the user's verdict (right / wrong) on a recent action they were asked about in a Skill review.",
    type: "function",
    function: {
      name: "record_skill_feedback",
      description: "Record the user's verdict on whether a recent skill-driven action turned out right, in answer to a Skill review question. A negative verdict is attributed to the named skill so it can be improved. Only call this when the user is answering such a question.",
      parameters: {
        type: "object",
        properties: {
          skill_name: { type: "string", description: "The skill the question was about (e.g. 'apple-notes')." },
          task_id: { type: "string", description: "The id of the task whose action the user is judging (from the review question)." },
          ok: { type: "boolean", description: "true if the action turned out right, false if it was wrong." },
          detail: { type: "string", description: "Optional: what went wrong, when ok is false." }
        },
        required: ["task_id", "ok"]
      }
    }
  },
  {
    // Subagent delegation. Spawns a constrained child task running the
    // chat-task agent loop with its own system prompt and toolset/skill
    // subsets. The dispatch waits for the child to reach a terminal state
    // (completed/failed/timeout) and feeds the summary back as the tool
    // result. Medium-risk: no approval, but every call is audited and
    // traced; depth-capped at 3 levels.
    toolset: "subagents",
    displayLabel: "Spawn subagent",
    type: "function",
    function: {
      name: "spawn_subagent",
      description: "Delegate a focused sub-task to a constrained child agent. Returns the child's summary (or error) once it finishes. Use sparingly — one delegation per logical sub-goal — and prefer direct tool use for simple queries.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short label for the subagent (e.g. 'research', 'patch-author')." },
          prompt: { type: "string", description: "The user-facing instruction for the subagent." },
          goal: { type: "string", description: "Optional one-line objective for the subagent, rendered as a '## Goal' section ahead of the prompt." },
          context: { type: "string", description: "Optional background the subagent needs (constraints, prior findings), rendered as a '## Context' section ahead of the prompt." },
          system_prompt: { type: "string", description: "Optional override for the subagent's system instructions. Defaults to a generic 'focused subagent' preamble." },
          toolsets: { type: "array", items: { type: "string" }, description: "Optional list of toolset names to expose. Subset of the parent's enabled toolsets." },
          skills: { type: "array", items: { type: "string" }, description: "Optional list of enabled skill names to advertise. Subset of the parent's enabled skills." },
          timeout_ms: { type: "number", description: "How long to wait for the subagent before timing out. Defaults to 300000 (5 minutes)." }
        },
        required: ["name", "prompt"]
      }
    }
  },
  {
    // Child-task delegation (unified task model). Where spawn_subagent runs
    // an invisible in-run helper, spawn_task mints a durable child task
    // container — its own thread under the spawning run's container — and
    // runs the written brief as the child's first run. Idempotent via
    // correlation_key (dedup survives acknowledge/archive), depth-capped on
    // both the helper chain and the container chain, audited like
    // spawn_subagent.
    toolset: "subagents",
    displayLabel: "Spawn task",
    type: "function",
    function: {
      name: "spawn_task",
      description:
        "Spawn a durable child task with its own thread. Use for user-facing or durable delegated work — a draft the user must review, a follow-up errand, one work item per finding from a watch. The child starts ONLY from the written brief you pass here (title/prompt/goal/context); it cannot see this conversation, so include everything it needs. Its activity mirrors into this thread as it runs. For invisible in-run helpers (parallel fan-out, heavy reads, a narrowed-tool chunk of THIS task) use spawn_subagent instead — helpers report back only to you and never surface to the user.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short user-facing title for the child task's thread." },
          prompt: { type: "string", description: "The written brief the child's first run starts from. Self-contained — the child cannot read this thread's transcript." },
          goal: { type: "string", description: "Optional one-line objective for the child, rendered as a '## Goal' section ahead of the prompt." },
          context: { type: "string", description: "Optional background the child needs (constraints, prior findings), rendered as a '## Context' section ahead of the prompt. Include the relevant slice here — never assume the child can see this thread." },
          correlation_key: { type: "string", description: "Optional idempotency key, scoped to this container. Re-spawning with the same key returns the existing child (deduped: true) instead of minting another — including after the user acknowledged or archived it. Use a stable per-finding id (e.g. 'email:<message-id>')." },
          surface: { type: "boolean", description: "true marks the child as user-facing so it can appear on the user's home (e.g. a draft to review). Default false: an internal errand whose activity only mirrors into this thread." },
          await: { type: "string", enum: ["result", "none"], description: "'result' (default) waits for the child's first run and returns its outcome; 'none' returns immediately with the child's ids (fire-and-forget, e.g. watch fan-out)." },
          toolsets: { type: "array", items: { type: "string" }, description: "Optional list of toolset names to expose to the child. Subset of the parent's enabled toolsets." },
          skills: { type: "array", items: { type: "string" }, description: "Optional list of enabled skill names to advertise to the child. Subset of the parent's enabled skills." }
        },
        required: ["title", "prompt"]
      }
    }
  },
  {
    // The deferred-tools meta-tool. CORE (always-on, never deferred): it is
    // the only way the model can pull a deferred tool's schema into the live
    // provider `tools` array. The system prompt lists deferred tools by name
    // + one-line summary under an "available on demand" index; the model
    // calls load_tools with the exact names, and from the NEXT turn on it
    // calls those tools directly by name. Handled INLINE in the chat-task
    // loop (not via the dispatch switch) so it can mutate the loaded set and
    // persist it onto the task.
    toolset: "core",
    displayLabel: "Load tools",
    type: "function",
    function: {
      name: "load_tools",
      description: "Load the full schemas for one or more tools listed in the 'Tools available on demand' section of your system prompt so you can call them. Pass their EXACT names. After this returns, call each loaded tool directly by name on a later turn — do NOT pass its arguments to load_tools. Example: load_tools({\"names\":[\"browser_snapshot\"]}).",
      parameters: {
        type: "object",
        properties: {
          names: {
            type: "array",
            items: { type: "string" },
            description: "Exact names of the on-demand tools to load (e.g. ['browser_snapshot', 'browser_click'])."
          }
        },
        required: ["names"]
      }
    }
  },
  {
    // Read-only clock. CORE and always-on (never deferred): "what time is it"
    // must never fail because a toolset is off, and unlike terminal `date` this
    // carries no approval/audit weight (terminal_exec is high-risk → gated). The
    // system prefix already states today's DATE at day granularity (cache-stable);
    // this tool supplies the precise wall-clock TIME on demand, which can't live
    // in the cached prefix because it changes every minute. See ADR
    // stable-system-prefix.md.
    toolset: "core",
    displayLabel: "Current time",
    type: "function",
    function: {
      name: "get_current_time",
      description: "Return the current wall-clock date and time (local timezone, plus UTC). Read-only, no side effects. Use whenever you need the exact current time — answering 'what time is it', computing a relative time like 'in 30 minutes', or timestamping something. The system prompt already gives today's date; call this for the precise time of day.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    toolset: "browser",
    displayLabel: "Open page",
    // The web_fetch steer lives in the base description because web_fetch is
    // always-on (it bypasses toolset gating in toolsForState), so it is
    // unconditionally reachable; only the web_search half needs the gate.
    crossToolsetHint: {
      toolset: "web_search",
      text: "To discover pages or fresh information, prefer web_search over guessing URLs."
    },
    type: "function",
    function: {
      name: "browser_navigate",
      description: "Open a URL in a headless browser session and return a compact accessibility snapshot with @eN refs the agent can click or type into. URLs that serve a PDF return the document's extracted text (`pdfText`) instead of a snapshot — there is no DOM to act on. The browser is for interacting with pages (clicking, typing, authenticated sessions); for plain content retrieval from a known URL prefer web_fetch.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Absolute http(s) URL to navigate to." }
        },
        required: ["url"]
      }
    }
  },
  {
    toolset: "browser",
    displayLabel: "Snapshot page",
    deferred: true,
    indexSummary: "Re-snapshot the current browser page to get fresh @eN element refs.",
    type: "function",
    function: {
      name: "browser_snapshot",
      description: "Re-snapshot the current browser page. Always returns the full tree (action results may return diffs vs the previous snapshot). Default returns interactive elements with @eN refs; entries with role `clickable` are cursor-detected clickables (non-semantic elements styled cursor:pointer or carrying onclick/tabindex). Same-origin iframes are walked inline (their elements get actionable @eN refs under an `iframe` row); cross-origin or blocked iframes show an opaque placeholder row. Pass full=true for a richer tree including landmarks and headings.",
      parameters: {
        type: "object",
        properties: {
          full: { type: "boolean", description: "If true, include landmark/heading nodes alongside interactive elements.", default: false }
        }
      }
    }
  },
  {
    toolset: "browser",
    displayLabel: "Click element",
    deferred: true,
    indexSummary: "Click an element on the current page by its @eN ref.",
    type: "function",
    function: {
      name: "browser_click",
      description: "Click an element on the current page by its @eN ref from the latest snapshot. Returns a fresh snapshot, possibly as a diff (call browser_snapshot for the full tree).",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: "Element ref like '@e3' from the latest snapshot." }
        },
        required: ["ref"]
      }
    }
  },
  {
    toolset: "browser",
    displayLabel: "Type text",
    deferred: true,
    indexSummary: "Type text into an input element on the current page by its @eN ref.",
    type: "function",
    function: {
      name: "browser_type",
      description: "Clear and type text into an input element identified by its @eN ref. Returns a fresh snapshot, possibly as a diff (call browser_snapshot for the full tree).",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: "Input ref like '@e3' from the latest snapshot." },
          text: { type: "string", description: "Text to type into the input." }
        },
        required: ["ref", "text"]
      }
    }
  },
  {
    toolset: "browser",
    displayLabel: "Fill form",
    deferred: true,
    indexSummary: "Fill multiple non-secret form fields in one call, each by its @eN ref.",
    type: "function",
    function: {
      name: "browser_fill_form",
      description: "Fill MULTIPLE non-secret form fields in one call. Each {ref, text} entry is filled in order with the same clear-and-type semantics as browser_type, then ONE snapshot is returned after all fills (possibly a diff — call browser_snapshot for the full tree). Stops at the FIRST failing field and reports which fields were filled and which were not attempted, so you can re-snapshot and retry the remainder. NEVER use this for passwords, credentials, or other secrets — use browser_fill_secrets for those; field values containing a registered secret are rejected.",
      parameters: {
        type: "object",
        properties: {
          fields: {
            type: "array",
            description: "Fields to fill, in order.",
            items: {
              type: "object",
              properties: {
                ref: { type: "string", description: "Input ref like '@e3' from the latest snapshot." },
                text: { type: "string", description: "Text to type into the input." }
              },
              required: ["ref", "text"]
            }
          }
        },
        required: ["fields"]
      }
    }
  },
  {
    toolset: "browser",
    displayLabel: "Press key",
    deferred: true,
    indexSummary: "Press a keyboard key on the current page (Enter, Tab, ArrowDown, …).",
    type: "function",
    function: {
      name: "browser_press",
      description: "Press a keyboard key on the current page (e.g. 'Enter', 'Tab', 'Escape', 'ArrowDown'). Returns a fresh snapshot, possibly as a diff (call browser_snapshot for the full tree).",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "Key name as Playwright understands it (e.g. 'Enter', 'ArrowDown', 'Control+A')." }
        },
        required: ["key"]
      }
    }
  },
  {
    toolset: "browser",
    displayLabel: "Scroll page",
    deferred: true,
    indexSummary: "Scroll the current page up or down by one viewport.",
    type: "function",
    function: {
      name: "browser_scroll",
      description: "Scroll the current page up or down by one viewport. Returns a fresh snapshot, possibly as a diff (call browser_snapshot for the full tree).",
      parameters: {
        type: "object",
        properties: {
          direction: { type: "string", enum: ["up", "down"], description: "Scroll direction." }
        },
        required: ["direction"]
      }
    }
  },
  {
    toolset: "browser",
    displayLabel: "Go back",
    deferred: true,
    indexSummary: "Navigate back one entry in the browser history.",
    type: "function",
    function: {
      name: "browser_back",
      description: "Navigate back one entry in the browser history. Returns a fresh snapshot.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    toolset: "browser",
    displayLabel: "Read console",
    deferred: true,
    indexSummary: "Read recent console messages, or evaluate a JavaScript expression on the page.",
    type: "function",
    function: {
      name: "browser_console",
      description: "Read recent console messages from the current page, and/or evaluate a JavaScript expression in the page and return its result. Use the expression to read data the accessibility snapshot omits (values the page renders with JS) or to call the page's own APIs with fetch() in its signed-in session.",
      parameters: {
        type: "object",
        properties: {
          expression: { type: "string", description: "Optional JavaScript expression to evaluate in the page context." },
          clear: { type: "boolean", description: "If true, clear the captured console buffer before returning.", default: false }
        }
      }
    }
  },
  {
    toolset: "browser",
    displayLabel: "Respond to dialog",
    deferred: true,
    indexSummary: "Arm an accept/dismiss response for the next JavaScript dialog (alert/confirm/prompt).",
    type: "function",
    function: {
      name: "browser_dialog",
      description: "Respond to JavaScript dialogs (alert/confirm/prompt/beforeunload). Dialogs are auto-DISMISSED the moment they fire so the page never hangs; each one is then reported once in a `dialogs` field on your next browser tool result. To accept a dialog deliberately (e.g. a confirm() asking 'Are you sure?'), call this FIRST to arm a one-shot response, then perform the action that triggers the dialog (e.g. browser_click) — the armed response is consumed by the next dialog that fires and the outcome appears in that tool result's `dialogs` field. For prompt() dialogs use action 'accept' with promptText.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["accept", "dismiss"], description: "How to answer the next dialog. Unarmed dialogs are dismissed by default; arm 'dismiss' explicitly only to override a previously armed accept." },
          promptText: { type: "string", description: "Text to enter when accepting a prompt() dialog. Ignored for other dialog types." }
        },
        required: ["action"]
      }
    }
  },
  {
    toolset: "browser",
    displayLabel: "List network requests",
    deferred: true,
    indexSummary: "List recent network requests from the current browser session (method, URL, status; no bodies).",
    type: "function",
    function: {
      name: "browser_requests",
      description: "List the most recent network requests observed on the task's browser pages (up to the last 100): method, URL, status, resourceType, and failure text for requests that never completed. Read-only — no request/response bodies, no headers, no interception. Useful for spotting failed API calls, redirects, or what a page is talking to.",
      parameters: {
        type: "object",
        properties: {
          filter: { type: "string", description: "Optional substring; only requests whose URL contains it are returned." }
        }
      }
    }
  },
  {
    toolset: "browser",
    displayLabel: "Resize viewport",
    deferred: true,
    indexSummary: "Resize the browser viewport (clamped to 320–3840 × 240–2160).",
    type: "function",
    function: {
      name: "browser_resize",
      description: "Resize the browser viewport. Width is clamped to 320–3840 and height to 240–2160. Useful for exercising responsive layouts or revealing elements hidden at the default size. Returns the applied (possibly clamped) dimensions.",
      parameters: {
        type: "object",
        properties: {
          width: { type: "number", description: "Viewport width in CSS pixels (clamped to 320–3840)." },
          height: { type: "number", description: "Viewport height in CSS pixels (clamped to 240–2160)." }
        },
        required: ["width", "height"]
      }
    }
  },
  {
    toolset: "browser",
    displayLabel: "List cookies",
    deferred: true,
    indexSummary: "List cookies for the current page (values always redacted; read-only).",
    type: "function",
    function: {
      name: "browser_cookies",
      description: "List cookies that apply to the current page (or the whole browser context when no page is open). READ-ONLY, and cookie VALUES are always redacted — only name, domain, path, expiry, and the httpOnly/secure/sameSite flags are returned. Useful for checking whether a session/auth cookie exists without exposing it.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    toolset: "browser",
    displayLabel: "Close browser",
    deferred: true,
    indexSummary: "Close the browser session for the current task.",
    type: "function",
    function: {
      name: "browser_close",
      description: "Close the browser session for the current task. Frees the underlying BrowserContext immediately instead of waiting for the idle sweeper.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    toolset: "browser",
    displayLabel: "Hover element",
    deferred: true,
    indexSummary: "Hover over an element by its @eN ref to reveal tooltips or hover menus.",
    type: "function",
    function: {
      name: "browser_hover",
      description: "Hover over an element on the current page by its @eN ref. Useful for revealing tooltips or :hover-only menus. Returns a fresh snapshot, possibly as a diff (call browser_snapshot for the full tree).",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: "Element ref like '@e3' from the latest snapshot." }
        },
        required: ["ref"]
      }
    }
  },
  {
    toolset: "browser",
    displayLabel: "Drag element",
    deferred: true,
    indexSummary: "Drag from one element to another by their @eN refs.",
    type: "function",
    function: {
      name: "browser_drag",
      description: "Drag from one element to another by their @eN refs. Returns a fresh snapshot, possibly as a diff (call browser_snapshot for the full tree).",
      parameters: {
        type: "object",
        properties: {
          fromRef: { type: "string", description: "Source element ref like '@e3' from the latest snapshot." },
          toRef: { type: "string", description: "Target element ref like '@e7' from the latest snapshot." }
        },
        required: ["fromRef", "toRef"]
      }
    }
  },
  {
    toolset: "browser",
    displayLabel: "Select option",
    deferred: true,
    indexSummary: "Select an option in a <select> element by its @eN ref.",
    type: "function",
    function: {
      name: "browser_select_option",
      description: "Select an option in a <select> element by its @eN ref. Pass `value` for single-select or `values` for multi-select. Exactly one of the two must be provided. Returns a fresh snapshot, possibly as a diff (call browser_snapshot for the full tree).",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: "Select element ref like '@e3' from the latest snapshot." },
          value: { type: "string", description: "Option value to select (single-select). Mutually exclusive with `values`." },
          values: { type: "array", items: { type: "string" }, description: "Option values to select (multi-select). Mutually exclusive with `value`." }
        },
        required: ["ref"]
      }
    }
  },
  {
    toolset: "browser",
    displayLabel: "Wait for element",
    deferred: true,
    indexSummary: "Wait for an element (by @eN ref) to reach a state, or for text to appear on the page.",
    type: "function",
    function: {
      name: "browser_wait_for",
      description: "Wait for an element (by @eN ref) to reach a state, or for a substring to appear in the page text. Exactly one of `ref` or `text` must be supplied. Returns a fresh snapshot after the wait completes, possibly as a diff (call browser_snapshot for the full tree).",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: "Element ref like '@e3' from the latest snapshot. Mutually exclusive with `text`." },
          text: { type: "string", description: "Substring to wait for in document.body.innerText. Mutually exclusive with `ref`." },
          state: {
            type: "string",
            enum: ["visible", "hidden", "attached", "detached"],
            description: "Element state to wait for when using `ref`. Defaults to 'visible'."
          },
          timeoutMs: { type: "number", description: "Maximum wait in milliseconds. Defaults to 10000. Hard cap of 60000 (60s); larger values are silently clamped.", default: 10000 }
        }
      }
    }
  },
  {
    toolset: "browser",
    displayLabel: "Manage tabs",
    deferred: true,
    indexSummary: "List, open, switch, or close browser tabs.",
    type: "function",
    function: {
      name: "browser_tabs",
      description: "Manage browser tabs: list current tabs, open a new tab, switch the active tab, or close a tab. Tabs are addressed by stable handles like 't2' (from `list` or the `id` returned by `new`); handles never change and are never reused, even after the tab closes. `id` is required for switch and close. `url` is optional for `new` (the new tab is created blank if omitted).",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["list", "new", "switch", "close"],
            description: "Tab operation to perform."
          },
          url: { type: "string", description: "Absolute http(s) URL to load when action='new'. Optional." },
          id: { type: "string", description: "Stable tab handle like 't2' for action='switch' or action='close'. Get handles from action='list' (or the id returned by action='new')." }
        },
        required: ["action"]
      }
    }
  },
  {
    toolset: "browser",
    displayLabel: "Upload file",
    deferred: true,
    indexSummary: "Upload a workspace file via a file input on the current page.",
    type: "function",
    function: {
      name: "browser_upload_file",
      description: "Upload a workspace file via a file input. Path is workspace-relative and validated against escapes (including symlink targets).",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: "File-input element ref like '@e3' from the latest snapshot." },
          path: { type: "string", description: "Workspace-relative path to the file to upload." }
        },
        required: ["ref", "path"]
      }
    }
  },
  {
    toolset: "browser",
    displayLabel: "Download file",
    deferred: true,
    indexSummary: "Download a file by clicking an element; saves under the instance downloads dir (approval-gated).",
    type: "function",
    function: {
      name: "browser_download",
      description: "Click an element (by its @eN ref) that triggers a file download and save the file under the agent's downloads directory. Use for 'download the invoice PDF' style tasks where a link or button serves a file. Only works when the click actually fires a download (attachment responses or links with a download attribute) — content the browser renders inline, like most PDF links, never does; use browser_navigate for those (PDF text is extracted on navigation). Approval-gated: the user confirms before the click runs. The result reports the saved path, file size, and the server's suggested filename. If the user asked for the file(s) in a specific location, move each saved file there (terminal_exec) right after its download completes — don't leave them staged in the downloads directory until the end of the task. Downloads larger than the size cap are rejected and deleted.",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: "Element ref like '@e3' from the latest snapshot whose click triggers the download." }
        },
        required: ["ref"]
      }
    }
  },
  {
    toolset: "browser",
    displayLabel: "Hand browser to user",
    type: "function",
    function: {
      name: "browser_connect",
      description: "Surface a Connect button in chat that lets the user act on the agent's own browser, for a step only the user can perform; when they finish, the agent continues with the persisted session. After they click Connect, a live view of the agent's browser opens in chat (a screencast of the headless browser they can click and type in) so the user does it without leaving the app. Two sanctioned uses — it is NEVER a first step and must NOT be called before navigating: always navigate with browser_navigate first. (1) Sign-in unblock (default, mode \"sign-in\"): ONLY when a navigation you ALREADY made hit a sign-in roadblock — a login screen, OAuth / identity-provider redirect, 401/403, or \"please sign in\" interstitial that actually blocks the page you need. Never call it proactively for sign-in; for ordinary browsing that does not hit a sign-in wall, keep using browser_navigate (headless) — no connection or approval is needed, so do not ask the user to connect. When you DO hit a sign-in wall, don't report it as a blocker — call this tool. The user clicks Connect, signs in once, clicks \"I've signed in\", then the agent continues. (2) Sensitive-step handoff (mode \"handoff\"): the task has reached a step the USER must perform themselves — entering payment details, a final purchase confirmation — or the user chose via ask_user to finish manually. Only at such a genuine user-must-act step or on the user's explicit choice, never as a shortcut for steps you can drive yourself, and only when the user's surface can render the in-chat screencast (the per-turn surface note tells you whether a browser handoff can reach them — it can on the web app, not on mobile or a messaging bridge). The user clicks Connect, completes the step, clicks \"I'm done\", then the agent continues — re-snapshot the page, confirm the outcome from it, and report. In both uses pass `url` = the page you ALREADY navigated to (the sign-in wall, or the page the user must act on), so the live view shows that exact page and the agent retries it afterward. This tool does NOT reach a page you haven't navigated to — use browser_navigate for that.",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string", description: "One short user-facing sentence shown in the approval card (e.g. 'Sign in to Amazon to manage your Audible subscription', 'Enter your payment details to finish the booking')." },
          url: { type: "string", description: "Absolute http(s) URL of the page you already navigated to — the sign-in wall, or the page the user must act on. The live browser view shows this exact page, and the agent retries it afterward. Not a way to open a page you haven't navigated to — use browser_navigate for that." },
          mode: { type: "string", enum: ["sign-in", "handoff"], default: "sign-in", description: "Which sanctioned use this is. \"sign-in\" (default): clear a sign-in wall — the completion card reads \"I've signed in\". \"handoff\": the user performs a sensitive step themselves (payment entry, final confirmation) — the completion card reads \"I'm done\"." }
        },
        required: ["reason"]
      }
    }
  },
  {
    toolset: "browser",
    deferred: true,
    indexSummary: "Screenshot the current page and ask a vision model about what's visible (charts, images, layout).",
    type: "function",
    function: {
      name: "browser_vision",
      description: "Screenshot the current page and ask the configured vision model a question about what's visible. Returns the model's text answer. Use when the accessibility snapshot can't capture what you need (charts, image-only content, visual layout, captchas-by-description). One image per call.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "Question to ask about the page screenshot." },
          full: { type: "boolean", default: false, description: "If true, capture the full scrollable page; otherwise just the viewport." },
          annotate: { type: "boolean", default: false, description: "If true, overlay numbered badges showing element refs (@eN from the latest snapshot) on the screenshot so the answer can cite specific elements. Secret-bearing elements are never badged." }
        },
        required: ["question"]
      }
    }
  },
  {
    // Connector-request affordance. When a skill is enabled but inactive
    // because its required connector is missing, the model calls this tool
    // to surface a "Connect <provider>" card in chat. The task pauses on
    // the resulting approval and resumes automatically once the user
    // completes the secret entry. Always-on (like read_skill / mcp_call):
    // the model needs this path even on a fresh instance with no toolsets
    // toggled.
    toolset: "connectors",
    displayLabel: "Request connector",
    type: "function",
    function: {
      name: "request_connector",
      description: "Ask the user to connect a credential the task needs. This is the ONLY way to obtain a credential: it renders a SECURE inline input in the web chat so the value is captured server-side — NEVER ask the user to paste an API key, token, or secret as a normal chat message (the value would land in your context and the transcript). Two ways to call it: (1) pass a registered `provider` id (e.g. 'linear', 'github') for a known service; or (2) for a brand-new service that has no provider module, pass `name` + `type:\"api-key\"` (and optionally `label`, `mcpUrl`, `skillId`) to request an arbitrary api-key credential. Templateless requests support api-key ONLY — an oauth2 credential requires a registered provider or setup skill. The user sees a Connect button in the chat; the task pauses until they finish the setup, then resumes automatically.",
      parameters: {
        type: "object",
        properties: {
          provider: { type: "string", description: "Registered provider id (e.g. 'linear'). Use this for a known service whose setup is already modeled. Omit it (and pass `name` + `type:\"api-key\"` instead) for a brand-new service with no provider module." },
          name: { type: "string", description: "Credential name for a templateless request (no registered provider). It IS the environment variable, so it must be an uppercase token like SOME_SERVICE_API_KEY (matches /^[A-Z][A-Z0-9_]*$/). Required when `provider` is omitted." },
          type: { type: "string", enum: ["api-key"], description: "Credential type for a templateless request. Only 'api-key' (a single secret token stored in the env var named by `name`) is supported templatelessly; an oauth2 credential needs a registered provider or setup skill. Required when `provider` is omitted." },
          label: { type: "string", description: "Optional human-readable label shown to the user for a templateless request (e.g. 'Some Service'). Defaults to `name`." },
          mcpUrl: { type: "string", description: "Optional MCP server URL to associate with an api-key credential (templateless requests only)." },
          skillId: { type: "string", description: "Optional id of the skill that needs this credential. When set, completing the card both stores the credential AND grants it to this skill — no separate consent card." },
          reason: { type: "string", description: "The full user-visible message shown above the inline Connect form. You are responsible for producing the complete text — including any URLs, project IDs, click instructions, or step-by-step guidance the user needs. Substitute any real values (project ids, etc.) directly into the string; do not leave `${...}` placeholders. The skill body (when one applies) shows the exact format to follow; copy it line-for-line, fill in the real values, and pass the result here verbatim." }
        },
        required: ["reason"]
      }
    }
  },
  {
    // Google-account affordance. Google sign-in (connect and reconnect
    // alike) is browser OAuth on the Integrations page — never an in-chat
    // credential entry and never agent-driven (ADR google-multi-account.md).
    // This tool surfaces an inline button in chat that takes the user
    // there; the agent then waits. Fire-and-forget (no SetupRequest gate):
    // the user navigates away, completes OAuth, and tells the agent when
    // they're done. Always-on like request_connector: an expired Google
    // session can surface on any instance regardless of toolset state.
    // Deferred (like list_connectors): the steering that routes the model
    // here (accounts block and Google skills) names the tool,
    // so the on-demand index line is enough to make it load the schema.
    toolset: "connectors",
    displayLabel: "Request Google account",
    deferred: true,
    indexSummary: "Show the user an inline button to the Integrations page to connect or reconnect a Google account; never run `gws auth login` yourself.",
    type: "function",
    function: {
      name: "request_google_account",
      description: "Show the user an inline button in chat that opens the Integrations page, where they connect or reconnect Google accounts via browser OAuth. Call it when a `gws` call fails with an auth error, an account's sign-in is expired or revoked, no Google account is set up, or the user wants to add one. This button is the ONLY path: NEVER run `gws auth login`, and NEVER drive a Google sign-in page with the browser tools. After calling it, tell the user to click the button, then STOP and wait for them to say it's done.",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string", description: "Optional one-line context shown above the button. Omit to let the runtime compose it from live account status." }
        }
      }
    }
  },
  {
    // User-choice affordance. The agent calls this mid-turn to present a
    // concrete single-select choice: the web chat renders the question as
    // the agent's own message with the options beneath, and the task pauses
    // on the resulting chat.choice SetupRequest until the user picks. The
    // tool is options-ONLY — an open-ended question belongs in the agent's
    // plain message text (the dispatcher rejects option-less calls with a
    // steer back there). Always-on (like request_connector): the model needs
    // this path even on a fresh instance with no toolsets toggled. See
    // docs/adr/user-choice-prompt.md.
    toolset: "core",
    displayLabel: "Ask user",
    type: "function",
    function: {
      name: "ask_user",
      description: "Present the user a concrete choice the task cannot proceed without. They see your question with 2-6 selectable options beneath it; the task pauses until they pick, then resumes with their answer. This tool ONLY presents choices — `options` is required. For an open-ended question with no options to offer (a free-form detail, and above all content that speaks in the user's voice, like what a message or reply should say), do NOT call this tool: ask directly in your plain message text and the user's reply arrives as the next message — NEVER invent multiple-choice options for content only the user can author. Use it whenever multiple viable paths exist and their preference matters (single-select). Every option must be a concrete action you can actually take with your available tools, or a setup you can request — never a way of opting out of the task. ESPECIALLY use this before requesting connector setup — offer the setup-vs-alternative choices first (e.g. for missing web search: \"Connect a search provider\", \"Fetch likely sites directly with web_fetch\", \"Browse the web with the browser\") so the user decides whether setup is worth it. Do NOT offer \"answer from general knowledge/memory\" as an option for research or current-information tasks — if the user wants that, they can type it under Other; fall back to general knowledge only when they explicitly choose it or every live path is exhausted. Also use it for mid-task preference or clarification decisions the task cannot proceed without (which approach, which account, which restaurant, what time — offer your best concrete guesses as the options): the call parks the task as needs-input and keeps the question on the user's home screen until they answer, while a prose question ends the run looking done. The UI automatically adds an \"Other (type your answer)\" freeform input and a Skip affordance — do NOT include an \"Other\" / \"something else\" / \"skip\" entry in `options`. Do NOT use this for permission confirmations — risk-gated actions already go through the authorization flow.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "The question, shown as your own message above the options. One clear sentence." },
          options: {
            type: "array",
            minItems: 2,
            maxItems: 6,
            description: "2-6 mutually exclusive choices (required — this tool only presents choices; ask open-ended questions in your message text instead). Keep labels short; put any detail in `description`.",
            items: {
              type: "object",
              properties: {
                label: { type: "string", description: "Short choice label shown on the option (e.g. \"Set up Brave only\")." },
                description: { type: "string", description: "Optional one-line detail rendered muted under the label." }
              },
              required: ["label"]
            }
          }
        },
        required: ["question", "options"]
      }
    }
  },
  {
    // User-confirmation affordance. The agent calls this BEFORE an
    // irreversible action that goes to another person (sending or replying
    // to a message/email, posting a reply in a web app, submitting or
    // purchasing on the user's behalf). It surfaces an inline Confirm/Cancel
    // card in the web chat; the task pauses on a confirmation.request
    // SetupRequest and resumes with the user's decision. Like ask_user it is
    // a SetupRequest, so it pauses even under approvalMode "yolo" — yolo
    // authorizes operational/reversible work, not speaking in the user's
    // voice to others. Always-on (like request_connector / ask_user): the
    // model needs this path even on a fresh instance with no toolsets toggled.
    // See docs/adr/user-confirmation-primitive.md.
    toolset: "core",
    displayLabel: "Request confirmation",
    type: "function",
    function: {
      name: "request_confirmation",
      description: "Ask the user to confirm before an irreversible action that goes to another person — sending or replying to a message or email, posting a reply in a web app, submitting or purchasing on their behalf. The user sees an inline Confirm/Cancel card in chat; the task pauses until they decide, then resumes with { confirmed: true } (do the action) or { confirmed: false } (don't — ask what to change). This fires even when you are otherwise auto-approved (yolo): yolo authorizes operational, reversible work, NOT speaking in the user's voice to others. EXCEPTION: if the user already gave a clear, specific go-ahead for THIS action in the conversation (\"send it\", \"reply yes\", \"you can submit\"), do NOT call this — just execute. This is for consent to send content the user has ALREADY approved; it is never a license to fabricate what they would say — when you lack the substance, ask for it directly in your message text (their reply arrives as the next message) and compose from their answer. Do NOT use this for risk-gated operational actions (those already go through the authorization flow) or for picking between options (use ask_user).",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "One human-readable line stating what will happen if confirmed (e.g. \"Send this reply to Dana in the project thread\"). Shown as the card headline." },
          details: { type: "string", description: "Optional — the actual content the user is consenting to (the message body, the recipient, the order summary), shown in an expandable section so they can review exactly what goes out." },
          confirmLabel: { type: "string", description: "Optional label for the confirm button (e.g. \"Send\", \"Submit\", \"Purchase\"). Defaults to \"Confirm\"." }
        },
        required: ["summary"]
      }
    }
  },
  {
    // Browser-fill-secrets affordance. When the agent's browser tool
    // reaches a login, checkout, or other input form whose values must
    // come from the user (passwords, OTPs, MFA codes, payment-card
    // fields, sensitive personal info), the agent calls this tool. The
    // user sees a card in chat with one input
    // field per slot, types the value(s), and the gateway pipes them
    // straight into page.locator(...).fill(...) via the same /connect
    // endpoint connector.request uses. Submitted values are never
    // persisted, never enter the LLM context, never reach the
    // transcript or audit payload — see ADR browser-fill-secret.md.
    toolset: "browser",
    displayLabel: "Ask user for sensitive values",
    type: "function",
    function: {
      name: "browser_fill_secrets",
      description: "Ask the user to fill one or more input fields on the active browser page. ONLY for values the user must supply themselves: credentials and other secrets (passwords, OTPs, account ids, MFA codes) AND payment-card or sensitive personal-info fields on a checkout, booking, or registration page (card number, expiry, CVC, SSN, and the like). NEVER for ordinary text like search queries or form content you already know; type that yourself with browser_type. Every call here interrupts the user with an approval card, and conversely NEVER attempt to fill credential fields yourself with browser_type. The user sees a single card in chat with one input per slot; once they submit, the gateway fills each locator on the page with the user's value via playwright. Requires an active browser session — call browser_navigate first if needed. Your tool result is a plain-text summary naming which slots filled (by slot.name, never values), which errored, and any abort condition (cancel, origin drift); you never see the values themselves. Re-snapshot the page after this returns to see the post-fill state. If more fields need filling (e.g. an MFA code on the next page), call this tool again.",
      parameters: {
        type: "object",
        properties: {
          slots: {
            type: "array",
            description: "One entry per input field to fill. Order matters — fields are filled in array order. Each slot's name is opaque (used only as the key in the secrets dict the user submits); locator is the playwright selector or @-ref of the input; label is the human-readable text shown next to the input in chat; kind picks the HTML input type for masking.",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "Slot identifier (e.g. 'username', 'password', 'otp'). Used as the secrets-dict key on submit; not shown to the user." },
                locator: { type: "string", description: "Playwright selector (CSS, text=, etc.) or @-ref from a recent browser_snapshot. The gateway fills this locator via playwright at fill time." },
                label: { type: "string", description: "Human-readable label rendered next to the input in chat (e.g. 'GitHub password')." },
                kind: { type: "string", enum: ["text", "password", "email", "tel", "number", "url"], description: "HTML input type for the rendered field. Use 'password' to mask the value while the user types. Defaults to 'text'." }
              },
              required: ["name", "locator", "label"]
            }
          },
          reason: { type: "string", description: "Short user-visible text shown above the form (e.g. 'Sign in to GitHub to continue'). One line." }
        },
        required: ["slots", "reason"]
      }
    }
  },
  {
    // Messaging-bridge-request affordance. Surfaces the same inline form
    // card used by `request_connector` / `browser_fill_secrets`, but for
    // adding a Telegram bridge. The agent calls this when the user asks
    // something like "add a telegram bot" or "wire up telegram"; the
    // user sees a card with a name input and a bot-token input
    // (password-masked) inside the chat. On Submit, the gateway
    // forwards the values to addMessagingBridge — same code path the
    // CLI (`gini messaging add`) and the settings page already go
    // through. Bot token never enters the model context, the audit row
    // evidence, or the chat transcript.
    //
    // Discord is deliberately NOT advertised in the kind enum: a
    // Discord bridge requires a list of channel IDs (deliveryTargets)
    // that the current chat card doesn't collect, so the create would
    // always fail at the /connect handler's deliveryTargets check.
    // Discord still flows through the CLI and the settings dialog,
    // both of which surface the channel-ID input. When the chat card
    // grows a channel-IDs textarea, widen the enum here.
    toolset: "messaging",
    displayLabel: "Add messaging bridge",
    type: "function",
    function: {
      name: "request_messaging_bridge",
      description: "Ask the user to wire up a Telegram messaging bridge by entering a bot token. Use this when the user says something like 'add a telegram bot', 'connect telegram', or any other Telegram onboarding ask. The user sees an inline card in chat with a name input and a password-masked bot-token input; once they submit, the bridge is created on the runtime — same path as the CLI's `gini messaging add` and the settings page's Add Telegram dialog. The task pauses on this approval and resumes automatically after the user submits. AFTER the bridge resolves successfully, the agent SHOULD typically chain `wait_for_messaging_pair` next so the user gets walked through the DM-the-bot → approve-the-pair handshake without context-switching — only skip the wait if the user explicitly asked to just provision the bridge without pairing right now. For Discord, point the user at the settings page (Add Discord button) because Discord bridges need a channel-ID list that this chat card does not collect.",
      parameters: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: ["telegram"],
            description: "Which bridge kind to add. Only 'telegram' is supported from chat today; for Discord, direct the user to the settings page."
          },
          suggestedName: {
            type: "string",
            description: "Optional default name for the bridge (e.g. 'my-telegram-bot'). The user can edit this in the card before submitting. Defaults to a kind-derived placeholder when omitted."
          },
          reason: {
            type: "string",
            description: "Short user-visible text shown above the form explaining what the bridge will do (e.g. 'Add a Telegram bot so I can DM you updates.'). One line."
          }
        },
        required: ["kind"]
      }
    }
  },
  {
    // Read-only inventory of messaging bridges. Always-on so the agent
    // can answer "what bridges do I have?" or "is the telegram bot
    // configured?" without needing the messaging toolset enabled. Same
    // always-on rationale as request_messaging_bridge: meta-tools that
    // surface UI / read state are always available; the
    // surface-gateway send_message tool stays gated.
    toolset: "messaging",
    displayLabel: "List messaging bridges",
    type: "function",
    function: {
      name: "list_messaging_bridges",
      description: "List the messaging bridges configured on this Gini instance. Returns each bridge's id, name, kind (telegram | discord | slack | demo), status (configured | error | disabled), and bot username when present. Useful before suggesting bridge changes ('do you already have telegram?'), before calling request_remove_messaging_bridge or request_messaging_pairing (so you can target the right bridge id), or whenever the user asks 'what bots are connected?'. Read-only and cheap — call it whenever you need fresh state.",
      parameters: {
        type: "object",
        properties: {}
      }
    }
  },
  {
    // Read-only inventory of a Telegram bridge's pending pairing
    // requests + allowlist. Always-on for the same reason as
    // list_messaging_bridges. Cheap; call before
    // request_messaging_pairing so the operator card shows the
    // current row.
    toolset: "messaging",
    displayLabel: "List messaging pairings",
    type: "function",
    function: {
      name: "list_messaging_pairings",
      description: "List the pending Telegram pairing requests AND the currently-allowed chats for a bridge. Returns an object with `allowedChatIds` (the chats already enrolled) and `recentDeniedChats` (each pending row's chatId, sender, chatType, lastAttemptAt). Call this when the user says 'any pending bots?' / 'who DM'd the bot?' / 'show pairings'; the result tells you whether to immediately call request_messaging_pairing to surface an approve card. Verification codes are NOT returned by this tool — the operator confirms them out-of-band against the bot's DM reply, and request_messaging_pairing reads the code server-side when minting the approval. Only telegram bridges have an allowlist; calling on a discord/demo bridge returns an error envelope.",
      parameters: {
        type: "object",
        properties: {
          bridge: {
            type: "string",
            description: "Bridge id (e.g. 'bridge_abc123') or human name (e.g. 'my-telegram-bot') of the bridge to query. Get it from list_messaging_bridges first if you're not sure."
          }
        },
        required: ["bridge"]
      }
    }
  },
  {
    // Approval-gated affordance for confirming or rejecting an
    // inbound Telegram pairing request from chat. The agent calls
    // this after list_messaging_pairings shows there's a pending
    // entry the user has likely just DM'd the bot from; the chat
    // card displays the sender + verification code + expiry so the
    // operator can verify the code matches what the user reports
    // before approving. Approve / Reject both go through /connect
    // (the agent doesn't run the side effect directly).
    toolset: "messaging",
    displayLabel: "Wait for messaging pair",
    type: "function",
    function: {
      name: "wait_for_messaging_pair",
      description: "Block server-side until an inbound Telegram pairing request arrives on the named bridge, then automatically surface the messaging.approve_pairing confirmation card so the user can Approve / Reject inline. Use this RIGHT AFTER request_messaging_bridge succeeds: the agent should stay engaged with the user through the bridge add → user DMs bot → approve dance instead of returning control and asking the user to come back. The tool blocks for up to `timeoutSeconds` (default 600) checking for a fresh pending row every second; the moment one appears it mints the approval card and pauses the task on it. On Approve/Reject the chat-task loop resumes with the outcome string and the agent continues. On timeout, returns `{ok: false, error: 'timeout'}` so the agent can ask the user whether to keep waiting.",
      parameters: {
        type: "object",
        properties: {
          bridge: {
            type: "string",
            description: "Bridge id or name to watch for inbound pairings. Same shape as list_messaging_pairings."
          },
          timeoutSeconds: {
            type: "number",
            description: "Max seconds to block waiting for an inbound pair. Default 600 (10 min — matches the verification code's TTL so a slow user can still complete pairing on the same code). The runtime clamps to [10, 1800]."
          },
          reason: {
            type: "string",
            description: "Optional user-visible text shown above the eventual approval card (e.g. 'Confirm the code I'm seeing matches what your bot replied with.'). One line."
          }
        },
        required: ["bridge"]
      }
    }
  },
  {
    toolset: "messaging",
    displayLabel: "Approve pairing request",
    type: "function",
    function: {
      name: "request_messaging_pairing",
      description: "Surface an Approve / Reject card in chat for a single pending Telegram pairing request. Use this when list_messaging_pairings reveals a pending row that the user is asking about (e.g. they just DM'd the bot from their phone and want to be enrolled). The card shows the sender, chat id, verification code, and expiry — the user clicks Approve only after confirming the code matches what their Telegram client received. Approve enrolls the chat on the allowlist and the bot greets the user; Reject clears the pending row without enrolling. Don't call this for pairing requests with expired codes — tell the user to DM the bot again to mint a fresh code.",
      parameters: {
        type: "object",
        properties: {
          bridge: {
            type: "string",
            description: "Bridge id or name. Same shape list_messaging_pairings accepts."
          },
          chatId: {
            type: "number",
            description: "Telegram chat id from the pending row. Negative ids are valid (groups/supergroups), positive ids are direct DMs."
          },
          reason: {
            type: "string",
            description: "Short user-visible text shown above the card (e.g. 'Confirm this is you on Telegram before I enroll your chat.'). One line."
          }
        },
        required: ["bridge", "chatId"]
      }
    }
  },
  {
    // Approval-gated destructive affordance for tearing down a
    // configured bridge from chat. Same passthrough-card pattern as
    // the other request_ tools; the card surfaces a Remove
    // confirmation with the bridge name. On Submit the runtime calls
    // removeMessagingBridge — same path the CLI / settings page use.
    toolset: "messaging",
    displayLabel: "Remove messaging bridge",
    type: "function",
    function: {
      name: "request_remove_messaging_bridge",
      description: "Ask the user to confirm tearing down a messaging bridge from chat. The card shows the bridge's name + kind + an irreversibility warning ('deletes the bridge and its bot token; past messages stay in history'). Use this when the user says 'remove my telegram bot', 'delete the discord bridge', etc. List with list_messaging_bridges first if you don't already know the bridge id. The card requires explicit Remove confirmation; the user can Cancel to back out.",
      parameters: {
        type: "object",
        properties: {
          bridge: {
            type: "string",
            description: "Bridge id (e.g. 'bridge_abc123') or human name (e.g. 'my-telegram-bot'). Resolves to the same record list_messaging_bridges returns."
          },
          reason: {
            type: "string",
            description: "Short user-visible text shown above the confirmation (e.g. 'Confirm you want to delete the my-telegram-bot bridge and its bot token.'). One line."
          }
        },
        required: ["bridge"]
      }
    }
  },
  {
    // Generic MCP tool invocation. The agent loop sees this as a single
    // tool entry; the dispatcher routes (server, tool, arguments) to the
    // matching McpServerRecord via src/integrations/mcp.ts. Each
    // configured http MCP server is advertised separately in the system
    // prompt so the model knows which tools belong to which server.
    // TODO: gate side-effecting MCP tools through the approval policy
    // based on the tool's `annotations.destructiveHint`; for v0 every call
    // auto-executes.
    toolset: "mcp",
    displayLabel: "Call MCP tool",
    type: "function",
    function: {
      name: "mcp_call",
      description: "Invoke a tool on a configured MCP server. Use list_skills/read_skill first to discover what tools each MCP server exposes (e.g. read_skill name='linear' for Linear).",
      parameters: {
        type: "object",
        properties: {
          server: { type: "string", description: "MCP server name (e.g. 'linear')." },
          tool: { type: "string", description: "Tool name as advertised by the MCP server (e.g. 'list_issues')." },
          arguments: { type: "object", description: "Arguments object the MCP tool expects. Shape varies per tool — read the skill for details.", additionalProperties: true }
        },
        required: ["server", "tool"]
      }
    }
  },
  {
    // skill_run: invoke a script that ships with an enabled skill. The
    // skill's SKILL.md documents what scripts it offers and what args
    // each takes; the runtime spawns the script with stdin = JSON args,
    // env = connector secrets + GINI_* context, and returns stdout
    // parsed as JSON. This is the dispatch surface for recipe-shaped
    // procedures that live in skills (signed-URL upload flows, multi-
    // step orchestrations, format conversions) — distinct from `mcp_call`
    // (which hits external MCP servers) and from the primitive tools in
    // the catalog (which expose raw runtime capabilities).
    //
    // Read the skill's body via read_skill first to know which scripts
    // exist and what args they take.
    toolset: "mcp",
    displayLabel: "Run skill script",
    type: "function",
    function: {
      name: "skill_run",
      description: "Invoke a script that ships with an enabled skill. Use this for skill-bundled procedures (e.g. `skill_run({skill:'attachments', script:'signed-upload', args:{uploadId, url, headers}})` for signed-PUT upload flows). The skill's SKILL.md is the reference for which scripts it offers and what args each takes — read_skill it first. Returns the script's JSON result verbatim, or `{ok:false, error}` on script failure / non-JSON output.",
      parameters: {
        type: "object",
        properties: {
          skill: { type: "string", description: "Name of the enabled skill that owns the script (e.g. 'attachments')." },
          script: { type: "string", description: "Script basename (no extension) inside the skill's scripts/ folder (e.g. 'signed-upload')." },
          args: { type: "object", description: "Args object passed to the script as JSON on stdin. Shape is per-script; the skill's SKILL.md documents it.", additionalProperties: true }
        },
        required: ["skill", "script"]
      }
    }
  },
  {
    // vision_query: ask the configured vision model a question about a
    // Gini upload. Like browser_vision but for arbitrary uploads — pairs
    // with skill-managed downloads/uploads and chat-attached images so
    // the model can "see" content it didn't start with as a data URL.
    // Stays in core (not a skill script) because it's a thin wrapper
    // over the model's internal multimodal capability — same shape as
    // browser_vision and web_fetch.
    toolset: "mcp",
    displayLabel: "Vision query",
    type: "function",
    function: {
      name: "vision_query",
      description: "Ask the configured vision model a question about an existing Gini upload (image/png or image/jpeg). Use this for chat-attached screenshots when you need to inspect details beyond what's already in vision context, or after skill scripts (e.g. attachments/signed-download) landed an image and you want the model to describe / extract from it. Returns { ok, answer, usage?, error? }. Costs a vision-model call.",
      parameters: {
        type: "object",
        properties: {
          uploadId: { type: "string", description: "Id of the image upload to query (from the chat marker, or from a skill script that landed an upload)." },
          question: { type: "string", description: "What to ask about the image." },
          maxTokens: { type: "number", description: "Optional cap on the response length. Default 512." }
        },
        required: ["uploadId", "question"]
      }
    }
  },
  {
    // Schedule a real cron/job. When created from chat, the job binds to and
    // delivers each fire into the conversation it was created from (a Topic or
    // the main agent chat); a Topic-bound fire also surfaces in the parent Chat
    // via the Topic→Chat activity mirror (see the dispatcher +
    // resolveEmitContext). Low-risk: no approval gate — the user can pause/delete the
    // job at any time, and gating reminders behind an approval dialog
    // would defeat the UX (`remind me in 2 minutes` should not pop a
    // modal). Always exposed (like read_skill / spawn_subagent) so a
    // fresh instance can schedule reminders without toolset toggling.
    toolset: "jobs",
    displayLabel: "Schedule job",
    type: "function",
    function: {
      name: "create_job",
      description: "Schedule a recurring or one-shot job that runs a prompt. ALWAYS set `skillNames` when the prompt touches an integration covered by an Available skill (e.g. google-calendar + google-gmail for a daily briefing, linear for an issue digest): attached skills' instructions are inlined into every fire, so the job follows the recipe instead of rediscovering CLI usage each run — omitting them makes every fire slower, costlier, and less reliable. The job delivers each fire into the conversation it was created from — this same Topic or chat — so its reports stay where the user set it up; no separate destination to pick. When created from a Topic, each fire also surfaces in the parent Chat automatically (the Topic mirrors its activity there), so the user sees it in both places. To ALSO push the job's output to a messaging app, set `deliveryTargets` (see below) — that is in addition to the in-conversation delivery, not instead of it. Provide EITHER `intervalSeconds` OR `cronExpression` (with `cronTimezone`), never both. Use `intervalSeconds` for 'in N minutes' or 'every N hours' (from-now timing). Use `cronExpression` + `cronTimezone` for wall-clock or weekday patterns ('daily at 9am', 'weekdays at 8:30'). Set oneShot=true for single-fire reminders. When a scheduled job needs to run UNATTENDED (e.g. recurring with no human present at fire-time), set `approvalMode: \"yolo\"` for tasks that need broad action, or use `autoApproveCommands` for narrow shell-pattern opt-ins — otherwise the job may stall at a gated approval forever (the instance default is \"auto\", which auto-approves file writes and safe shell commands but still gates dangerous patterns like rm -rf, sudo, pipe-to-sh, chmod 777, and destructive git operations). `dangerouslyAutoApprove: true` is a deprecated alias for `approvalMode: \"yolo\"` kept for back-compat. The default `timeoutSeconds` is 600 (10 min) — drop it lower for trivial reminders, or raise it (e.g. 1800+) when the prompt invokes external CLIs like codex or claude-code that can take several minutes.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short human-readable label (e.g. 'cake-reminder')." },
          intervalSeconds: { type: "number", description: "Seconds between runs (from-now timing). For a one-shot reminder, this is the delay until the single fire (e.g. 120 for 'in 2 minutes'). Mutually exclusive with `cronExpression`." },
          cronExpression: {
            type: "string",
            description: "Standard 5-field Unix cron: `minute hour day-of-month month day-of-week`. No seconds field, no year field. Day-of-week is 0-6 with 0 = Sunday (NOT ISO 1=Monday); `1` is Monday, `5` is Friday. Examples: '0 9 * * *' (every day at 09:00), '30 8 * * 1-5' (08:30 on weekdays), '0 */2 * * *' (every 2 hours), '0 0 1 * *' (midnight on the 1st of each month). FOOTGUN: if you restrict BOTH day-of-month and day-of-week, Unix cron OR's them — '0 0 1 * 1' means 'midnight on the 1st OR every Monday', NOT 'when the 1st is a Monday'. There is no Unix-cron expression for 'first Monday of the month'; refuse such requests or split into two separate jobs. Mutually exclusive with `intervalSeconds`. Always pair with `cronTimezone` for wall-clock-named times."
          },
          cronTimezone: {
            type: "string",
            description: "IANA timezone identifier (e.g. 'America/Los_Angeles', 'Europe/Berlin', 'Asia/Tokyo', 'UTC'). Defaults to 'UTC' when omitted. Always set this explicitly when the user names a wall-clock time — '9am' alone is ambiguous; '9am America/Los_Angeles' is not. Only valid alongside `cronExpression`."
          },
          prompt: { type: "string", description: "The instruction the agent will receive when the job fires. Phrase it from the user's perspective (e.g. 'Remind me to take the cake out of the oven.')." },
          oneShot: { type: "boolean", description: "If true, the job is paused after its first successful run. Defaults to false (recurring)." },
          deliveryPolicy: {
            type: "string",
            enum: ["always", "on_findings", "silent"],
            description: "How each fire's final reply is delivered. \"always\" (default): every reply delivers. \"on_findings\": watch-style — the fire is invited to reply [SILENT] when there is nothing new, so only real findings deliver. \"silent\": never deliver — the run's output stays in the job's hidden working thread; use for watch jobs that spawn a child task per finding (spawn_task with a correlation_key) instead of reporting. Not allowed with oneShot=true."
          },
          skillNames: {
            type: "array",
            items: { type: "string" },
            description: "Names from the Available skills list to attach to this job. Their full instructions are loaded into every run, so each fire follows the skill's recipe instead of rediscovering CLI usage. Pick by each skill's listed description, choosing the OPERATING recipes the fire will follow at run time — e.g. a calendar/email digest needs google-calendar + google-gmail. Never attach one-time setup/installation skills (anything described as 'setup', 'install', or 'sign in'); setup is already done by the time the job fires. Max 8; every name must match an enabled skill."
          },
          autoApproveCommands: {
            type: "array",
            items: { type: "string" },
            description: "Shell command patterns that auto-approve without asking the user at fire-time. Always wins over the dangerous-pattern blocklist when matched (explicit operator allow beats heuristic block). Use when the job must act unattended on specific commands. Examples: 'git *', 'gh *', 'cd *', 'ls *', 'rg *'. Patterns are matched against the full command string; only add patterns that match the user's stated intent for the job."
          },
          approvalMode: {
            type: "string",
            enum: ["strict", "auto", "yolo"],
            description: "Approval policy for this job's spawned tasks only. \"strict\" gates every approval-eligible action. \"auto\" auto-approves file writes / safe shell commands, gates dangerous shell patterns. \"yolo\" bypasses everything (full audit trail still written). When omitted, the spawned task inherits the operator's instance default."
          },
          dangerousTerminalPatterns: {
            type: "array",
            items: { type: "string" },
            description: "Override the dangerous-pattern blocklist for this job's spawned tasks. Each entry is a substring matched against the command string. Only consulted when approvalMode is \"auto\". When omitted, the built-in defaults apply (rm -rf to absolute paths, sudo, pipe-to-sh, chmod 777, destructive git operations, writes to /etc/, ~/.ssh/, ~/.aws/)."
          },
          dangerouslyAutoApprove: {
            type: "boolean",
            description: "DEPRECATED alias for approvalMode: \"yolo\". Kept for back-compat; new payloads should use approvalMode instead. If both fields are set, approvalMode wins."
          },
          timeoutSeconds: {
            type: "number",
            description: "Wall-clock seconds before the spawned task is killed. Default 600 (10 min) — enough for typical git/gh + multi-file scan jobs. Drop lower (e.g. 60-120) for trivial reminders; raise (e.g. 1800-3600) when the prompt invokes external CLIs like codex or claude-code that can run several minutes. The model will be terminated mid-thought if this is too low."
          },
          deliveryTargets: {
            type: "array",
            items: { type: "string" },
            description: "Optional messaging-bridge names to deliver the job's final output to (in addition to its chat thread, if it has one), e.g. [\"telegram\"]. Use when the user asks for the job's output to reach a messaging app. Each entry must match exactly one configured Telegram, Discord, or Slack bridge by exact id, or by name or kind (case-insensitive), and is stored as the bridge id; a Slack bridge is only accepted when it has a delivery channel configured (a DM-only Slack bridge has nowhere to post job output); unknown or ambiguous entries are rejected with the dispatchable bridge names so you can relay the fix."
          },
          preRunHook: {
            type: "object",
            description: "Optional pre-fire hook: a registered trusted handler runs in-process before each fire and either shortCircuits the run (no model turn; also auto-pauses oneShot jobs, so watch jobs need oneShot=false) or injects context items into the prompt turn. The built-in \"skill-script\" handler runs config.skill/config.script headless, passing the remaining config keys to the script as args.",
            properties: {
              handlerId: { type: "string", description: "Registered handler id (built-in: \"skill-script\")." },
              config: { type: "object", description: "For \"skill-script\": { skill, script, ...args }." },
              timeoutMs: { type: "number", description: "Timeout in ms (default 30000)." }
            },
            required: ["handlerId", "config"]
          }
        },
        required: ["name", "prompt"]
      }
    }
  },
  {
    // Read-only accessor for the scheduled job list. Cheap and low-risk;
    // call this first whenever the user refers to "this job" or any
    // existing scheduled job, so update_job / delete_job target the right
    // id instead of accidentally creating a duplicate via create_job.
    toolset: "jobs",
    displayLabel: "List jobs",
    type: "function",
    function: {
      name: "list_jobs",
      description: "List scheduled jobs visible to this instance. Cheap, side-effect-free; call this first when the user refers to 'this job', 'my reminder', or any existing scheduled job so you can target the right job id with update_job / delete_job (instead of creating a duplicate). Returns a compact JSON array with each job's id, name, status, schedule shape (cronExpression+cronTimezone OR intervalSeconds), oneShot flag, nextRunAt/lastRunAt timestamps, chatSessionId, attached skillNames, and a truncated prompt. Pass `fullPrompt: true` when you intend to edit a prompt (e.g. 'append to this reminder' or 'change wording X to Y') so you get the verbatim prompt without truncation — otherwise prompts are truncated to 200 chars to keep the result compact.",
      parameters: {
        type: "object",
        properties: {
          nameContains: { type: "string", description: "Optional case-insensitive substring filter on job name." },
          fullPrompt: { type: "boolean", description: "Optional. If true, return each job's prompt verbatim with no truncation. Default false. Set true when you intend to edit a prompt (append, search-and-replace) so update_job can submit the complete new prompt without losing tail content." }
        }
      }
    }
  },
  {
    // Mutate an existing job in place. Preferred over delete+create when
    // the user wants to change a job's schedule, prompt, or status —
    // preserves the job id, chatSessionId, run history, and audit chain.
    // Low-risk / no approval for the same reason as create_job: the user
    // can always pause/delete from /jobs.
    toolset: "jobs",
    displayLabel: "Update job",
    type: "function",
    function: {
      name: "update_job",
      description: "Patch an existing scheduled job in place. Use this — NOT delete+create — when the user wants to change a job's schedule, prompt, name, status, skill attachments, auto-approve envelope, or delivery binding (`deliverTo`); this preserves the job id, its bound chat session, and run history. Supply only the fields you want to change. Schedule transitions follow the same mutual-exclusion rule as create_job: a single patch may not set BOTH a positive intervalSeconds AND a cronExpression. To switch a job between cron-driven and interval-driven, pass the new driver and set the other to null (e.g. `{cronExpression: '0 9 * * *', cronTimezone: 'America/Los_Angeles', intervalSeconds: null}`). Call list_jobs first if you don't already know the jobId.",
      parameters: {
        type: "object",
        properties: {
          jobId: { type: "string", description: "Id of the job to patch (e.g. 'job_a3aa6707'). Get this from list_jobs." },
          name: { type: "string", description: "Optional new human-readable label." },
          prompt: { type: "string", description: "Optional new instruction the agent will receive when the job fires." },
          intervalSeconds: { type: ["number", "null"], description: "Optional new interval. Pass a positive integer to make the job interval-driven; pass null to clear the interval when also setting cronExpression." },
          cronExpression: { type: ["string", "null"], description: "Optional new 5-field Unix cron expression. Pass a string to make the job cron-driven; pass null to clear it when switching to intervalSeconds." },
          cronTimezone: { type: ["string", "null"], description: "Optional new IANA timezone identifier (only valid with cronExpression). Pass null to clear (only legal when also clearing cronExpression)." },
          oneShot: { type: "boolean", description: "Optional. If true the job is auto-paused after its first run." },
          deliveryPolicy: {
            type: "string",
            enum: ["always", "on_findings", "silent"],
            description: "Optional new delivery policy for each fire's final reply. \"always\": every reply delivers. \"on_findings\": watch-style — only real findings deliver (the fire may reply [SILENT] when there is nothing new). \"silent\": never deliver — output stays in the job's hidden working thread. Rejected on oneShot jobs."
          },
          skillNames: {
            type: ["array", "null"],
            items: { type: "string" },
            description: "Optional new skill attachments (FULL replacement — supply every skill the job should keep; pass [] (or null) to clear). Attached skills' full instructions are loaded into every run, so each fire follows the skill's recipe instead of rediscovering CLI usage. Pick by each skill's listed description, choosing the OPERATING recipes the fire will follow at run time. Never attach one-time setup/installation skills (anything described as 'setup', 'install', or 'sign in'); setup is already done by the time the job fires. Call list_jobs first to see the job's current skillNames. Max 8; every name must match an enabled skill."
          },
          status: { type: "string", enum: ["active", "paused"], description: "Optional pause/resume. 'paused' stops the scheduler from firing the job; 'active' resumes it." },
          autoApproveCommands: { type: "array", items: { type: "string" }, description: "Optional new list of auto-approve shell patterns for unattended fires." },
          dangerouslyAutoApprove: { type: "boolean", description: "Optional. If true the scheduled task bypasses ALL approval gates at fire-time." },
          timeoutSeconds: { type: "number", description: "Optional. Wall-clock seconds before the spawned task is killed." },
          deliveryTargets: { type: "array", items: { type: "string" }, description: "Optional new list of messaging-bridge names that receive the job's final output in addition to its chat thread, e.g. [\"telegram\"]. Pass [] to clear. Each entry must match exactly one configured Telegram, Discord, or Slack bridge by exact id, or by name or kind (case-insensitive), and is stored as the bridge id; a Slack bridge is only accepted when it has a delivery channel configured; unknown or ambiguous entries are rejected." },
          deliverTo: {
            type: "string",
            enum: ["channel", "chat"],
            description: "Optional rebind of where future fires deliver. \"channel\": creates a NEW dedicated job channel and delivers future fires there (a previously archived channel is never unarchived); no-op when the job already delivers to a channel. \"chat\": delivers future fires into THIS conversation (only valid when invoked from a chat conversation) and ARCHIVES the job's previous dedicated channel — its history is preserved and the channel stays directly addressable, but it disappears from session lists; no-op when the job is already bound to this conversation. Not available for watcher jobs (preRunHook or fan-out routes) — their sessions carry routing state."
          }
        },
        required: ["jobId"]
      }
    }
  },
  {
    // Delete a scheduled job and its run history. Low-risk / no approval
    // for symmetry with create_job: gating destroys the composition story
    // (the agent should be able to do delete+create or update smoothly).
    // The user can always restore via re-creation; audit trail is preserved.
    toolset: "jobs",
    displayLabel: "Delete job",
    type: "function",
    function: {
      name: "delete_job",
      description: "Delete a scheduled job and its run history. Use sparingly — prefer update_job when changing a job's schedule, prompt, or status, since update preserves the job id, dedicated chat thread, and audit chain. Use delete_job when the user explicitly asks to remove a job, or when you must compose delete+create to reach a target state that update_job can't express. Call list_jobs first if you don't already know the jobId.",
      parameters: {
        type: "object",
        properties: {
          jobId: { type: "string", description: "Id of the job to delete (e.g. 'job_a3aa6707'). Get this from list_jobs." }
        },
        required: ["jobId"]
      }
    }
  },
  {
    // Install a skill from a raw SKILL.md body. Companion to the existing
    // meta/install-skill agent skill (which the agent invokes when the
    // user shares a skill description inline). This tool is the direct
    // API path — use it when you already have the SKILL.md text in hand
    // and just need to land it on the runtime.
    toolset: "skills",
    displayLabel: "Install skill",
    type: "function",
    function: {
      name: "install_skill",
      description: "Install a skill from a raw SKILL.md document. Validates the manifest, writes it under the instance's skills directory, and reloads the skill registry. Use when the user shares a SKILL.md body (or you generated one) and wants it active. Companion to the meta/install-skill agent skill — that skill drives the full UX flow; this tool is the direct API call.",
      parameters: {
        type: "object",
        properties: {
          body: { type: "string", description: "Full SKILL.md content (YAML frontmatter + markdown body)." },
          files: {
            type: "array",
            description: "Optional named-file payloads written next to SKILL.md (e.g. scripts/linear.sh). Each entry's name is treated as a relative path under the skill folder and must not escape it.",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "Relative path under the skill folder." },
                content: { type: "string", description: "File contents." }
              },
              required: ["name", "content"]
            }
          }
        },
        required: ["body"]
      }
    }
  },
  {
    // Enable a skill so it shows up in the system prompt and read_skill
    // can fetch its body. Low-risk; the underlying handler runs
    // `setSkillStatus(config, idOrName, "enabled")` and writes a
    // skill.enabled audit row.
    toolset: "skills",
    displayLabel: "Enable skill",
    type: "function",
    function: {
      name: "enable_skill",
      description: "Enable a registered skill so it appears in the advertised-skills block and the agent can read its body. Use after the user asks to turn a skill on (or after install_skill if the manifest didn't auto-enable). Bundled (first-party) skills enable immediately. Enabling a non-bundled skill that requires a credentialed connector first prompts the user for a one-time consent grant (a setup card per connector) before the skill can use that credential — expect the call to come back pending; the loop resumes once the user grants.",
      parameters: {
        type: "object",
        properties: {
          skillId: { type: "string", description: "Skill id or name (e.g. 'skill_abc123' or 'apple-notes')." }
        },
        required: ["skillId"]
      }
    }
  },
  {
    // Disable a skill so it stops appearing in the system prompt and
    // read_skill refuses to fetch its body. Low-risk; underlying handler
    // writes a skill.disabled audit row.
    toolset: "skills",
    displayLabel: "Disable skill",
    type: "function",
    function: {
      name: "disable_skill",
      description: "Disable a registered skill so it stops appearing in the advertised-skills block. Use when the user asks to turn a skill off. Trivial; no approval gate. The skill's manifest stays on disk — re-enable with enable_skill when needed.",
      parameters: {
        type: "object",
        properties: {
          skillId: { type: "string", description: "Skill id or name (e.g. 'skill_abc123' or 'apple-notes')." }
        },
        required: ["skillId"]
      }
    }
  },
  {
    // Cancel a task. Pairs with spawn_subagent for parent-side control
    // of a runaway child. Low-risk; the underlying `cancelTask` already
    // refuses on already-terminal tasks and cascades to child subagents.
    // The self-cancel guard lives in the dispatcher (the current task
    // cannot cancel itself — that would terminate the running
    // conversation).
    toolset: "subagents",
    displayLabel: "Cancel task",
    type: "function",
    function: {
      name: "cancel_task",
      description: "Cancel a running task. Use for runaway subagents the user wants to abort, or to clean up an unrelated task. Refuses to cancel the CURRENT chat task — call cancellation never makes sense from inside the task it would terminate. Already-terminal tasks (completed / failed / cancelled) are returned as-is by the underlying handler.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "Id of the task to cancel (e.g. 'task_abc123')." }
        },
        required: ["taskId"]
      }
    }
  },
  {
    // Outbound messaging via a configured bridge. High-risk: contains
    // "send" → routed through the approval queue. In "auto" mode the
    // policy seam auto-approves; "strict" gates every call. The user
    // can pre-approve specific bridges or flip approvalMode at runtime.
    toolset: "messaging",
    displayLabel: "Send message",
    type: "function",
    function: {
      name: "send_message",
      description: "Send a message through a configured messaging bridge (Telegram, Discord, etc.). Approval-gated by default — the operator's approvalMode controls whether each call is auto-approved or queued. Pass `target` to choose a specific allow-listed chat; omit it to use the bridge's first allowed target. Use sparingly and only when the user has asked the agent to relay something to a chat — don't send a message just because one came in.",
      parameters: {
        type: "object",
        properties: {
          bridgeId: { type: "string", description: "Id or name of the messaging bridge (e.g. 'msg_abc123' or 'my-bot')." },
          text: { type: "string", description: "Message body. Keep it concise — Telegram caps inbound text at 4096 chars." },
          target: { type: "string", description: "Optional delivery target (chat id) on the bridge's allow-list. When omitted the bridge's first allowed target is used." }
        },
        required: ["bridgeId", "text"]
      }
    }
  },
  {
    // Cross-session lookup. Scans past tasks, traces, skills, and audit
    // rows for a substring match. Low-risk; read-only. (Pinned memories
    // were dropped in the state.memories consolidation — for memory
    // recall use `recall_memory` against the Hindsight bank instead.)
    toolset: "session_search",
    displayLabel: "Search history",
    type: "function",
    function: {
      name: "search_history",
      description: "Search past chat sessions, task traces, skill text, and audit events for a substring. Use when the user references something they did before ('did I ever ask about X?', 'find that conversation about Y'). Returns up to `limit` snippets ordered by score, each with kind (task/trace/skill/audit), title, excerpt, and taskId when applicable. For memory recall use `recall_memory` instead — it queries the Hindsight bank where auto-retain persists facts.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Substring to search for (case-insensitive)." },
          limit: { type: "number", description: "Maximum number of snippets to return. Defaults to 20, capped at 100." }
        },
        required: ["query"]
      }
    }
  },
  {
    // Explicit on-demand memory query. Distinct from the automatic
    // embedding recall that runs per chat task — this is the tool the
    // model reaches for when the user asks about something specific
    // ("did we discuss X?", "what do you remember about Y?"). Returns a
    // compact summary so the model can decide whether to dig deeper or
    // ask the user for clarification. Low-risk / no approval.
    toolset: "memory",
    displayLabel: "Recall memory",
    type: "function",
    function: {
      name: "recall_memory",
      description: "Explicit on-demand recall of stored memory. Use when the user references prior context (e.g. 'did we discuss X?', 'what do you remember about Y?'). Distinct from the automatic embedding recall that runs at the start of every task — call this when you need to fetch additional memory mid-conversation. Returns a compact JSON summary: unit count, total tokens, and an excerpt list (id, truncated content, score). Pass `tokenBudget` to cap pack size; pass `bankId` only when you need to query a specific bank (default: the active agent's bank).",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The phrase to search memory for." },
          tokenBudget: { type: "number", description: "Maximum tokens worth of memory units to return. Defaults to 2000." },
          bankId: { type: "string", description: "Optional memory bank id to query. Defaults to the active agent's per-agent bank." }
        },
        required: ["query"]
      }
    }
  },
  {
    // Agent-database primitive (ADR agent-database.md): the agent's own
    // sandboxed SQLite DB for keeping and exhaustively querying structured
    // records. db_query is the read side — exact, complete results, the
    // opposite of ranked top-K recall.
    toolset: "database",
    displayLabel: "Query database",
    type: "function",
    function: {
      name: "db_query",
      description: "Run a read-only SQL query (SELECT / WITH) against YOUR per-agent database and get back every matching row. This is your tool for EXHAUSTIVE, exact questions over structured records you've stored — 'how many / list all X where …', counts, GROUP BY, JOINs. Use it instead of recall_memory whenever completeness matters (recall is a fuzzy top-K sample and will undercount). Returns up to a row cap with a `truncated` flag — use COUNT(*) / LIMIT / OFFSET to page large sets. Use parameter placeholders (?) with `params` for any values. Call db_schema first if you don't know what tables exist.",
      parameters: {
        type: "object",
        properties: {
          sql: { type: "string", description: "A single read-only statement (SELECT or WITH …)." },
          params: { type: "array", description: "Values bound to ? placeholders, in order.", items: {} }
        },
        required: ["sql"]
      }
    }
  },
  {
    // Write side of the agent database: DDL + DML. One statement per call.
    toolset: "database",
    displayLabel: "Run SQL",
    type: "function",
    function: {
      name: "db_execute",
      description: "Run a single write/DDL statement (CREATE TABLE, ALTER, DROP, INSERT, UPDATE, DELETE) against YOUR per-agent database. Use this to set up tables for things the user wants tracked as structured records and to add or change rows. One statement per call; use parameter placeholders (?) with `params` for values. For loading a whole CSV/XLSX file, use db_import instead of many INSERTs. The database is private to you and isolated from Gini's system data.",
      parameters: {
        type: "object",
        properties: {
          sql: { type: "string", description: "A single SQL statement (DDL or DML)." },
          params: { type: "array", description: "Values bound to ? placeholders, in order.", items: {} }
        },
        required: ["sql"]
      }
    }
  },
  {
    // Bulk tabular import: file → table, deterministic, one row per record.
    toolset: "database",
    displayLabel: "Import table",
    type: "function",
    function: {
      name: "db_import",
      description: "Load a CSV or XLSX file from your workspace into a table in your per-agent database — one file row becomes one table row, deterministically (no truncation, no summarizing). Columns are derived from the file's header row, stored as TEXT; leading non-table preamble lines (e.g. an export's notes) are skipped automatically (or pin the header with skipLines). Use this whenever the user gives you a spreadsheet/export to remember and query (contacts, transactions, a roster, …). After importing, inspect with db_schema and query with db_query; reshape with db_execute if you want typed/renamed columns.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative path to the CSV/XLSX file (shown in the attachment note)." },
          table: { type: "string", description: "Destination table name (created if absent)." },
          skipLines: { type: "number", description: "Optional 0-based index of the header row, to skip preamble lines explicitly." },
          recreate: { type: "boolean", description: "Drop the table first if it already exists (default false → append)." }
        },
        required: ["path", "table"]
      }
    }
  },
  {
    // Introspection so the agent can recall what it's already tracking.
    toolset: "database",
    displayLabel: "Database schema",
    type: "function",
    function: {
      name: "db_schema",
      description: "List the tables in your per-agent database with their columns and row counts. Call this to see what you're already tracking before querying or creating tables.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    // Manually trigger an existing scheduled job. Wraps the same
    // `runJobNow` entrypoint that `POST /api/jobs/<id>/run` calls. Low-risk
    // / no approval: the spawned task itself still flows through the job's
    // configured `approvalMode` / `autoApproveCommands`, so any side
    // effects inside the run are gated at their normal granularity. The
    // tool only fires an EXISTING job — for one-off prompts use create_job
    // with intervalSeconds + oneShot=true instead.
    toolset: "jobs",
    displayLabel: "Run job",
    type: "function",
    function: {
      name: "run_job",
      description: "Manually fire an EXISTING scheduled job right now. This is distinct from create_job: run_job triggers a job that has already been scheduled, while create_job defines a new one. Use this when the user says 'test this job now', 'fire the reminder', or 'run job X off-schedule'. Behavior differs by job kind: prompt-backed jobs spawn an async task — posting into the job's dedicated chat thread when one is configured — using the job's configured approvalMode / autoApproveCommands at fire-time, and the tool returns once the trigger lands (run id and spawned task id included); script-backed jobs (operator-installed only) execute synchronously and the tool returns the exit code, plus a truncated stderr tail on failure. Overlap protection only applies to scheduled triggers; a manual run CAN run alongside an in-flight scheduled run. Call list_jobs first if you don't already know the jobId.",
      parameters: {
        type: "object",
        properties: {
          jobId: { type: "string", description: "Id of the job to fire (e.g. 'job_a3aa6707'). Get this from list_jobs." }
        },
        required: ["jobId"]
      }
    }
  },
  {
    // Email watcher management (ADR email-watch.md). One tool with an
    // `action` enum keeps the catalog surface
    // minimal — the same pattern create/list/delete_job follow, collapsed
    // into a single tool because the watch surface is narrow. Low-risk /
    // no approval: this only writes a config record (an EmailWatcherRecord)
    // that the user can remove at any time. The actual reading/replying
    // happens later in the woken agent turn, gated by terminal_exec's
    // approval at that point. Always exposed (the "email" toolset isn't a
    // legacy default) so a fresh instance can set up a watcher from chat.
    toolset: "email",
    displayLabel: "Watch email",
    type: "function",
    function: {
      name: "email_watch",
      description: "Manage email watchers. Use `action: \"add\"` to start watching for emails (optionally from a specific sender) and have a proposed reply drafted in a dedicated chat thread when one arrives — fire this when the user says things like 'watch my email for messages from alice@x.com and draft replies' or 'keep an eye on emails from my boss'. The watcher polls the signed-in Google account roughly once a minute; on each new matching email it wakes a turn that reads the message and posts a PROPOSED reply for review (it never sends without explicit approval). Provide `sender` to scope to one address (builds the query `from:<sender>`), or `query` for a raw Gmail search query. To watch ONE SPECIFIC CONVERSATION — especially a support ticket / negotiation where reply addresses change (case-123@x.zendesk.com replying for support@x.com) — pass `threadId` instead: the watch keys on the Gmail thread, so every new message in it triggers regardless of sender (get the thread id via the gws CLI from the message being discussed). To watch a CATEGORY OF MAIL defined by SUBJECT MATTER rather than a sender or thread (e.g. 'watch for investor inbound', 'flag customer complaints', 'keep an eye on press inquiries'), set the watch up as an LLM CLASSIFIER, NOT a keyword query: pass `query: \"in:inbox\"` (broad — let the model judge) plus an `objective` that (1) defines IN PLAIN LANGUAGE what qualifies and (2) says what a good reply does. The drafting turn then reads each new email's title + body and decides, drafting a reply when it qualifies and returning [SILENT] otherwise. Do NOT try to capture a semantic category with a keyword OR-group like `{investor vc \"seed round\"}`: genuine matches routinely contain NONE of those words (a VC's \"saw your post, coffee chat?\" email has no investor keyword) and a keyword query SILENTLY DROPS them. ONLY narrow `query` below `in:inbox` when the category maps to a RELIABLE Gmail operator (a known sender/domain via `from:`, promotions via `category:promotions`, `has:attachment`, a label) — use that as a cheap pre-filter, still WITH the classifying objective. This is a TOPIC watch, NOT whole-inbox triage (which can't carry an objective). Cost note: a broad `in:inbox` topic watch runs the model on every new email — that is the price of catching semantically-matching mail that has no keywords; accept it for fuzzy categories, avoid it only when a reliable operator exists. On creation it classifies the single most-recent inbox email (older mail already waiting is not swept yet); going forward it classifies each new email once as it arrives. DISTILL an `objective` whenever the user expresses a GOAL or a TOPIC intent for the watch ('get a refund or a replacement', 'keep responding until it's resolved', or the category itself like 'investor inbound') — not only for explicit goals; it is injected into every drafting turn for that watch so replies advance it. When the user changes the goal later, use `action: \"update\"` with the watcher `id` and the new `objective`, or `clearObjective: true` to drop the standing goal entirely. Use `action: \"list\"` to show existing watchers, `action: \"remove\"` with an `id` to stop one, and `action: \"disable\"` / `action: \"enable\"` with an `id` to pause/resume a watcher without deleting it. To triage the WHOLE inbox — respond-or-flag EVERY newly-arrived email that no specific watch claims — use `action: \"add\"` with `triage: true` (and `triage: false` to turn it off); enable this ONLY when the user explicitly asks to handle ALL their new mail ('watch my whole inbox', 'respond-or-flag all my new mail', 'triage everything'), NEVER when they name a specific sender or thread, and NEVER for a named TOPIC/category like 'investor inbound' or 'customer complaints' (that is a TOPIC watch — a `query` + `objective`, above — not triage). Each watch is tied to ONE connected Google account (the `account` param is authoritative — detection polls exactly that inbox). Resolve the account when adding: use the account the user named; if exactly ONE Google account is connected, omit `account` (it defaults to that one); if MULTIPLE are connected and the user didn't specify, call `ask_user` with the connected account emails (shown in your system prompt) as the options to let them pick, then add with that `account` — never silently pick one. Watching requires the user to be signed in to Google via the `gws` CLI; if they aren't, the watcher is created but stays in `needs_auth` until they sign in.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["add", "list", "remove", "disable", "enable", "update"],
            description: "What to do: 'add' a new watcher, 'list' existing watchers, 'remove' a watcher by id, 'disable'/'enable' a watcher by id (pause/resume without deleting), or 'update' a watcher's objective by id (set a new `objective`, or `clearObjective: true` to remove it)."
          },
          sender: { type: "string", description: "For action='add': the email address to watch for (e.g. 'alice@example.com'). Builds the Gmail query `from:<sender>`. Omit to watch the whole inbox (or provide `query` instead)." },
          query: { type: "string", description: "For action='add': a raw Gmail search query (e.g. 'from:boss@x.com subject:urgent is:unread'). Takes precedence over `sender` when both are given." },
          threadId: { type: "string", description: "For action='add': watch one specific Gmail conversation by its thread id (PREFER this over `sender` for support tickets and ongoing negotiations — ticket systems rotate sending addresses, the thread is stable). New messages from anyone but the user trigger a draft; the automated-sender filter does not apply." },
          followUpAfterHours: { type: "number", description: "For action='add' with `threadId`: also nudge when the counterparty goes SILENT — if the thread's last message is the user's own and older than this many hours, a turn wakes to draft a polite follow-up (once per outbound message). Positive number; thread watches only. Use when the user says things like 'keep following up until they respond'." },
          objective: { type: "string", description: "For action='add'/'update': the user's standing goal for this watch, distilled from what they said (e.g. 'get a refund or a replacement', 'keep responding until the issue is resolved'). Injected into every drafting turn for the watch so proposed replies advance it. Max 2000 characters." },
          clearObjective: { type: "boolean", description: "For action='update': set true to clear the watcher's standing objective (drafting turns stop receiving goal context). Mutually exclusive with `objective`." },
          account: { type: "string", description: "For action='add': the connected Google account email this watch should poll (AUTHORITATIVE — detection targets exactly this account's inbox). Resolve it before adding: if the user named an account, use it; if exactly ONE Google account is connected, omit this (it defaults to that single account); if MULTIPLE accounts are connected and the user did NOT say which, do NOT guess — call `ask_user` (options = the connected account emails, visible in your system prompt) to let them pick, then add with that `account`." },
          id: { type: "string", description: "For action='remove'/'disable'/'enable'/'update': the watcher id (from action='list')." },
          triage: { type: "boolean", description: "For action='add': set `true` to TRIAGE THE WHOLE INBOX — every newly-arrived email no specific watch claims gets a proposed reply or a flag — or `false` to turn that off. OPT-IN: only set when the user explicitly asks to handle ALL their new mail ('watch my whole inbox', 'triage everything'); NEVER set it when they name a specific sender/thread (use `sender`/`threadId`) or a TOPIC/category like 'investor inbound' (use a `query` + `objective`). Can be sent on its own (no `sender`/`query`/`threadId`) to toggle triage without creating a targeted watch." }
        },
        required: ["action"]
      }
    }
  },
  {
    // Edit the active agent's SOUL.md (per-agent persona). Auto-approved:
    // a clean body lands at SOUL.md directly and rides the system prompt
    // on the next turn. The injection scan still gates content that trips
    // a threat pattern — a flagged body routes to SOUL.md.proposed and
    // stays out of the prompt until the user approves via
    // `POST /api/identity-files/soul/approve`.
    // Always exposed alongside add_memory — the "identity" toolset is
    // not part of the legacy default set; gating on enable would silently
    // hide the per-agent persona surface on fresh instances.
    // See ADR runtime-identity-files.md.
    toolset: "identity",
    displayLabel: "Edit persona",
    type: "function",
    function: {
      name: "edit_soul",
      description: "Edit the active agent's SOUL.md — your own persona / character / identity (name, voice, tone, style, boundaries). Fire when the user shapes WHO YOU ARE, not WHAT TO DO for them. Example phrasings that DO trigger this tool: \"You are Athena, a research assistant\"; \"be more sardonic, don't hedge\"; \"act as a stoic critic with strong opinions\"; \"speak like a pirate from now on\". Example phrasings that DO NOT trigger this tool: \"I prefer concise replies\", \"be more concise\", \"no pleasantries\", \"use bullet points\" — those are USER preferences about how the user wants replies and route to `edit_user_profile`. Most turns are not about your identity, so most turns write nothing here. When in doubt, default to `edit_user_profile`; USER.md is about the user, SOUL.md is about you. Prefer `action: \"set\"` with the full consolidated SOUL.md body — keep a leading `Your name is <name>.` line and use H2 sections (`## Voice`, `## Style`, `## Boundaries`); the current file is visible in the system prompt above, so emit the new version with the new content integrated under the right section. Write entries as facts about who you are, not directives to yourself (\"Voice is terse\" ✓ — \"Always be terse\" ✗). Aim to keep the file under the soft cap shown in the SOUL persona header (1500 chars); when near or over cap, consolidate. Auto-approved: a clean body goes straight to SOUL.md and rides the system prompt on the next turn. The injection scan still gates content that trips a threat pattern. After a clean edit, give a short natural acknowledgment (\"Got it — I'll keep it dry.\"); do NOT narrate the tool call. `action: \"append\"` adds a new section below existing content (prefer set; append is a legacy fallback). `action: \"remove\"` drops the first paragraph containing the `needle` substring from the existing body; requires `needle`. Requires an active agent — there is no per-instance SOUL.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["set", "append", "remove"],
            description: "Whether to replace the whole SOUL.md body (set), append a new section below the existing content (append), or drop the first paragraph containing `needle` from the existing content (remove).",
            default: "set"
          },
          content: { type: "string", description: "The new SOUL.md body (action=set) or the section to append (action=append). Keep it concise — every turn pays for this in tokens. Not required for action=remove." },
          needle: { type: "string", description: "Required when action=remove. A plain substring; the first paragraph in the existing SOUL.md that contains this substring is dropped." }
        },
        required: []
      }
    }
  },
  {
    // Edit the instance-scoped USER.md. Auto-approved: writes land at
    // USER.md directly and ride the system prompt on the next turn.
    // USER.md is instance-scoped so the user's identity carries across
    // agent switches. Distinct from edit_soul (per-agent persona; same
    // auto-approve policy). Always exposed. See ADR
    // runtime-identity-files.md.
    toolset: "identity",
    displayLabel: "Edit user profile",
    type: "function",
    function: {
      name: "edit_user_profile",
      description: "Edit the instance-scoped USER.md — facts and preferences ABOUT THE USER. Two kinds of content fire this tool: (1) facts about the user — name, role, location, employer, languages, family; (2) preferences for how the user wants you to communicate — \"I prefer concise replies\", \"be more concise\", \"no pleasantries\", \"use bullet points for lists\", \"wants detailed technical explanations\". Even when the user phrases a preference as an imperative (\"be direct with me\", \"skip the preamble\"), it is a preference about how the user wants replies → this tool, NOT `edit_soul`. If the user is talking about themselves OR about how they want replies, use this tool. `edit_soul` is reserved for the rare case where the user is explicitly assigning the agent a persona (\"You are X\", \"Act as X\"). When in doubt, default to this tool. Prefer `action: \"set\"` with the full consolidated USER.md content under H2 sections (`## Identity`, `## Preferences`, `## Background`, `## Goals`) — the current file is visible in the system prompt above, so emit the new version with the new content integrated under the right section rather than appending a chunk below. Only call when the user's CURRENT message contains a NEW durable fact or preference NOT already in USER.md. Write entries as facts ABOUT the user, not directives to yourself (\"User prefers concise replies\" ✓ — \"Always reply concisely\" ✗); imperative phrasing in USER.md gets re-read next session as a system directive. Casual chat and follow-up questions are NOT identity facts — most turns should produce ZERO calls. Aim to keep the file under the soft cap shown in the USER profile header (1500 chars); when near or over cap, consolidate. DO NOT save task progress, PR/issue/commit IDs, completed-work logs, or other transient state — those belong in long-term memory (auto-retain handles them silently). Do NOT narrate the call: just acknowledge briefly (\"Got it, X.\", \"Noted.\"). Auto-approved: writes go straight to USER.md and ride the system prompt on the next turn. USER.md is instance-scoped so the user's identity bridges across agent switches. The injection scan still gates content that trips a threat pattern. `action: \"append\"` adds a new section (legacy fallback; the storage layer de-duplicates lines that already exist); `action: \"remove\"` drops the first paragraph containing the `needle` substring (requires `needle`). Distinct from edit_soul (per-agent persona; same auto-approve policy).",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["set", "append", "remove"],
            description: "Whether to replace the whole USER.md body (set), append a new section below the existing content (append), or drop the first paragraph containing `needle` from the existing content (remove).",
            default: "set"
          },
          content: { type: "string", description: "The new USER.md body (action=set) or the section to append (action=append). Not required for action=remove." },
          needle: { type: "string", description: "Required when action=remove. A plain substring; the first paragraph in the existing USER.md that contains this substring is dropped." }
        },
        required: []
      }
    }
  },
  // Self-config / self-introspection direct tools. Each maps 1:1 to a
  // SelfOperation in self-registry.ts (the handler home). All are DEFERRED:
  // their names + one-line summaries surface in the on-demand index, and the
  // model loads the ones it needs via load_tools. Query tools resolve
  // synchronously; the mutate tools route through the generic self.config
  // approval branch in the dispatcher (auto-approved in `auto`, gated in
  // `strict`). Args are passed at TOP LEVEL — no `{name, args}` envelope.
  {
    toolset: "self",
    displayLabel: "Get self",
    deferred: true,
    indexSummary: "Compact snapshot of Gini's runtime: instance, port, version, active provider/model, active agent, approval mode, resource counts. Load this to answer 'what model are you using' / 'what's your setup'.",
    type: "function",
    function: {
      name: "get_self",
      description: "Compact snapshot of Gini's own runtime — instance, port, version, active provider/model, active agent, approval mode, and resource counts. Use this to answer questions about Gini's current configuration ('what model are you using?', 'what's your setup?'). Read-only.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    toolset: "self",
    displayLabel: "List providers",
    deferred: true,
    indexSummary: "LLM provider catalog with which is active and which have credentials configured.",
    type: "function",
    function: {
      name: "list_providers",
      description: "List the LLM provider catalog — which provider is active and which have credentials configured. Read-only. Call this before set_provider to confirm the target is configured.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    toolset: "self",
    displayLabel: "List agents",
    deferred: true,
    indexSummary: "Agents on this instance with per-agent provider/model overrides, toolset whitelists, and which is active.",
    type: "function",
    function: {
      name: "list_agents",
      description: "List the agents on this instance with their per-agent provider/model overrides, toolset whitelists, and which one is active. Read-only. Call before use_agent to get the right agent id.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    toolset: "skills",
    displayLabel: "List skills",
    indexSummary: "Installed skills with id, name, category, status, trigger phrase, and script names. Filter by status or nameContains.",
    type: "function",
    function: {
      name: "list_skills",
      description: "List installed skills with id, name, category, status, trigger phrase, and script names. Read-only. Filter by `status` or `nameContains`.",
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["enabled", "disabled", "archived", "all"],
            description: "Filter by status. Defaults to 'all'.",
            default: "all"
          },
          nameContains: { type: "string", description: "Optional case-insensitive substring filter on the skill name." }
        }
      }
    }
  },
  {
    toolset: "self",
    displayLabel: "List MCP servers",
    deferred: true,
    indexSummary: "Registered MCP servers with transport, status, and exposed tool count.",
    type: "function",
    function: {
      name: "list_mcp_servers",
      description: "List the registered MCP servers with transport, status, and exposed tool count. Read-only.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    toolset: "self",
    displayLabel: "List connectors",
    deferred: true,
    indexSummary: "Registered connectors with provider, status, and health, plus live per-account Google sign-in (googleAccounts).",
    type: "function",
    function: {
      name: "list_connectors",
      description: "List the registered connectors (claude-code, codex, linear, …) with provider, status, and health, plus `googleAccounts`: live per-account Google sign-in status. Read-only.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    toolset: "self",
    displayLabel: "Set provider",
    deferred: true,
    indexSummary: "Switch the active LLM provider and/or model. Confirm the target is configured via list_providers first.",
    type: "function",
    function: {
      name: "set_provider",
      description: "Switch the active LLM provider and/or model (e.g. 'switch to deepseek'). Confirm the target is configured via list_providers first. Approval-gated: auto-approved in `auto` mode, gated in `strict`.",
      parameters: {
        type: "object",
        properties: {
          provider: {
            type: "string",
            description: "Provider id (e.g. 'codex', 'openai', 'anthropic', 'bedrock', 'openrouter', 'deepseek', 'local', 'azure', 'echo'). When omitted, the current provider is kept and only `model`/`awsRegion`/`baseUrl` (and any Azure routing fields) are updated."
          },
          model: { type: "string", description: "Model identifier on the target provider (e.g. 'deepseek-v4-pro', 'gpt-5.5', or a Bedrock inference-profile id like 'us.amazon.nova-pro-v1:0'). Defaults to the provider's first catalog model when omitted." },
          awsRegion: { type: "string", description: "AWS region for the 'bedrock' provider's Converse endpoint/signing (e.g. 'us-east-1'). Ignored by other providers." },
          baseUrl: { type: "string", description: "Override base URL for OpenAI-compatible providers (openai, openrouter, deepseek, local). Ignored for codex/echo/anthropic/bedrock. For the azure provider, set this to the resource endpoint (https://<resource>.openai.azure.com) — it is required." },
          apiVersion: { type: "string", description: "Azure OpenAI api-version (e.g. '2024-10-21'). azure provider only; defaults to a GA value when omitted." },
          deployment: { type: "string", description: "Azure OpenAI deployment name. Defaults to the model id when omitted. azure provider only." },
          authScheme: { type: "string", enum: ["bearer", "api-key"], description: "Auth header style for the azure provider. 'api-key' (default) sends Azure's api-key header for a resource key; 'bearer' sends Authorization: Bearer for an Entra token." },
          apiKey: { type: "string", description: "API key — only required when the env var for this provider isn't already set. Persisted to secrets.env and process.env. Not used by bedrock (AWS SigV4) or codex (OAuth)." }
        },
        required: []
      }
    }
  },
  {
    toolset: "self",
    displayLabel: "Use agent",
    deferred: true,
    indexSummary: "Switch the active agent. Its provider/model override, SOUL.md, toolset filter, and memory namespace take effect next turn.",
    type: "function",
    function: {
      name: "use_agent",
      description: "Switch the active agent. Its provider/model override, SOUL.md, toolset filter, and memory namespace take effect next turn. Call list_agents first for the id. Approval-gated: auto-approved in `auto` mode, gated in `strict`.",
      parameters: {
        type: "object",
        properties: {
          agentId: { type: "string", description: "Agent id or name (e.g. 'agent_abc123' or 'athena')." }
        },
        required: ["agentId"]
      }
    }
  },
  {
    toolset: "self",
    displayLabel: "Create agent",
    deferred: true,
    indexSummary: "Create a new agent row (NOT activated — follow up with use_agent). Inherits provider/toolsets from the default agent unless overridden.",
    type: "function",
    function: {
      name: "create_agent",
      description: "Create a new agent row. It is NOT activated — follow up with use_agent to switch. Inherits provider/toolsets from the default agent unless overridden. Approval-gated: auto-approved in `auto` mode, gated in `strict`.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Human-readable name (e.g. 'Athena')." },
          providerName: { type: "string", description: "Optional provider override (e.g. 'deepseek'). Defaults to the default agent's provider." },
          model: { type: "string", description: "Optional model override (e.g. 'deepseek-v4-pro'). Defaults to the default agent's model." },
          toolsets: {
            type: "array",
            description: "Optional list of toolset names this agent is allowed to use. Defaults to the default agent's toolset set.",
            items: { type: "string" }
          }
        },
        required: ["name"]
      }
    }
  },
  {
    toolset: "self",
    displayLabel: "Rename agent",
    deferred: true,
    indexSummary: "Rename an agent. Updates the agent's name and keeps its seeded SOUL.md name line in sync. The folder/memory bank are id-keyed and never move.",
    type: "function",
    function: {
      name: "rename_agent",
      description: "Rename an agent. Updates the agent's name and keeps its seeded SOUL.md name line in sync (the folder/memory bank are id-keyed and never move). If the agent has a customized SOUL persona, also update the name reference there via edit_soul. Approval-gated: auto-approved in `auto` mode, gated in `strict`.",
      parameters: {
        type: "object",
        properties: {
          agentId: { type: "string", description: "Agent id or name to rename (e.g. 'agent_abc123' or 'Mansour')." },
          name: { type: "string", description: "New human-readable name (e.g. 'Bob')." }
        },
        required: ["agentId", "name"]
      }
    }
  },
  {
    toolset: "self",
    displayLabel: "Set approval mode",
    deferred: true,
    indexSummary: "Set the runtime approval mode (strict / auto / yolo).",
    type: "function",
    function: {
      name: "set_approval_mode",
      description: "Set the runtime approval mode: strict (gate every high-risk action), auto (auto-approve safe actions, gate dangerous shell), or yolo (skip the per-action gate). Use when the user says 'set permissions to yolo' or 'stop asking me to approve'. Approval-gated: auto-approved in `auto` mode, gated in `strict`.",
      parameters: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["strict", "auto", "yolo"], description: "strict | auto | yolo." }
        },
        required: ["mode"]
      }
    }
  },
  {
    toolset: "self",
    displayLabel: "List toolsets",
    deferred: true,
    indexSummary: "Instance toolsets with status (enabled/disabled), description, and the tools each gates.",
    type: "function",
    function: {
      name: "list_toolsets",
      description: "List the instance toolsets with id, name, status (enabled/disabled), description, and the tool names each gates. Read-only. Call before enable_toolset/disable_toolset.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    toolset: "self",
    displayLabel: "Enable toolset",
    deferred: true,
    indexSummary: "Enable a toolset so its tools become available. Reversible via disable_toolset.",
    type: "function",
    function: {
      name: "enable_toolset",
      description: "Enable a toolset so its tools become available to agents on this instance. Call list_toolsets first for the name. Approval-gated: auto-approved in `auto` mode, gated in `strict`.",
      parameters: {
        type: "object",
        properties: {
          toolset: { type: "string", description: "Toolset name or id (e.g. 'browser', 'messaging')." }
        },
        required: ["toolset"]
      }
    }
  },
  {
    toolset: "self",
    displayLabel: "Disable toolset",
    deferred: true,
    indexSummary: "Disable a toolset so its tools stop being offered. Self-config tools bypass gating, so this can't lock the agent out. Reversible via enable_toolset.",
    type: "function",
    function: {
      name: "disable_toolset",
      description: "Disable a toolset so its tools stop being offered to agents. Self-config tools bypass toolset gating, so this can't lock the agent out of its own config surface; reversible via enable_toolset. Approval-gated: auto-approved in `auto` mode, gated in `strict`.",
      parameters: {
        type: "object",
        properties: {
          toolset: { type: "string", description: "Toolset name or id (e.g. 'browser', 'messaging')." }
        },
        required: ["toolset"]
      }
    }
  },
  {
    toolset: "self",
    displayLabel: "Delete agent",
    deferred: true,
    indexSummary: "Hard-delete an agent and its memory bank. Refuses the default and the active agent (switch first).",
    type: "function",
    function: {
      name: "delete_agent",
      description: "Hard-delete an agent and its per-agent memory bank. Refuses the default agent and the currently-active agent (switch via use_agent first). Call list_agents for the id. Approval-gated: auto-approved in `auto` mode, gated in `strict`.",
      parameters: {
        type: "object",
        properties: {
          agentId: { type: "string", description: "Agent id or name to delete (e.g. 'agent_abc123' or 'athena')." }
        },
        required: ["agentId"]
      }
    }
  },
  {
    toolset: "self",
    displayLabel: "Remove provider",
    deferred: true,
    indexSummary: "Disconnect a credential-storing LLM provider: scrub its stored key(s). Falls back to codex/echo if it was active.",
    type: "function",
    function: {
      name: "remove_provider",
      description: "Disconnect an LLM provider whose credentials gini stores: scrub its key(s) from process.env + secrets.env. Covers the API-key providers (openai/openrouter/deepseek/anthropic) and bedrock (scrubs its AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY). If it was active, falls back to codex (or echo). Codex and local cannot be removed this way. Approval-gated: auto-approved in `auto` mode, gated in `strict`.",
      parameters: {
        type: "object",
        properties: {
          provider: { type: "string", description: "Provider id to remove (e.g. 'openai', 'openrouter', 'deepseek', 'anthropic', 'bedrock')." }
        },
        required: ["provider"]
      }
    }
  },
  {
    toolset: "self",
    displayLabel: "Set auto-approve commands",
    deferred: true,
    indexSummary: "REPLACE the auto-approve command allowlist. Include existing entries (from get_self.approvalSettings) to keep them.",
    type: "function",
    function: {
      name: "set_auto_approve_commands",
      description: "REPLACE the auto-approve command allowlist (shell prefixes auto-approved without gating). This REPLACES the existing list — read get_self.approvalSettings.autoApproveCommands first and include any entries you want to keep. Approval-gated: auto-approved in `auto` mode, gated in `strict`.",
      parameters: {
        type: "object",
        properties: {
          patterns: {
            type: "array",
            description: "The FULL allowlist of command prefixes to auto-approve. This REPLACES the existing list — include existing entries (visible via get_self.approvalSettings.autoApproveCommands) to keep them.",
            items: { type: "string" }
          }
        },
        required: ["patterns"]
      }
    }
  },
  {
    toolset: "self",
    displayLabel: "Set dangerous patterns",
    deferred: true,
    indexSummary: "REPLACE the dangerous-terminal-pattern list. Include existing entries (from get_self.approvalSettings) to keep them.",
    type: "function",
    function: {
      name: "set_dangerous_patterns",
      description: "REPLACE the dangerous-terminal-pattern list (substrings that always force a gate even in auto). This REPLACES the existing list — read get_self.approvalSettings.dangerousTerminalPatterns first and include any entries you want to keep. Approval-gated: auto-approved in `auto` mode, gated in `strict`.",
      parameters: {
        type: "object",
        properties: {
          patterns: {
            type: "array",
            description: "The FULL list of dangerous command substrings that always require approval. This REPLACES the existing list — include existing entries (visible via get_self.approvalSettings.dangerousTerminalPatterns) to keep them.",
            items: { type: "string" }
          }
        },
        required: ["patterns"]
      }
    }
  },
  {
    toolset: "self",
    displayLabel: "Add MCP server",
    deferred: true,
    indexSummary: "Register a new MCP server (stdio command or http url) so its tools become available.",
    type: "function",
    function: {
      name: "add_mcp_server",
      description: "Register a new MCP server so its tools become available. http transport needs a url; stdio needs a command. Approval-gated: auto-approved in `auto` mode, gated in `strict`.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Server name (e.g. 'linear')." },
          transport: { type: "string", enum: ["stdio", "http"], description: "Transport. Defaults to 'stdio', or 'http' when a url is given." },
          command: { type: "string", description: "Executable for a stdio server (e.g. 'npx'). Required for stdio." },
          args: { type: "array", description: "Argument list for the stdio command.", items: { type: "string" } },
          url: { type: "string", description: "Streamable-HTTP endpoint for an http server (e.g. 'https://mcp.linear.app/mcp'). Required for http." },
          headers: { type: "object", description: "Static or ${ENV}-placeholder header map for an http server." },
          exposedTools: { type: "array", description: "Optional whitelist of tool names to expose from this server.", items: { type: "string" } }
        },
        required: ["name"]
      }
    }
  },
  {
    toolset: "self",
    displayLabel: "Remove MCP server",
    deferred: true,
    indexSummary: "Disable a registered MCP server so its tools stop being offered.",
    type: "function",
    function: {
      name: "remove_mcp_server",
      description: "Disable a registered MCP server so its tools stop being offered. Call list_mcp_servers first for the id. Approval-gated: auto-approved in `auto` mode, gated in `strict`.",
      parameters: {
        type: "object",
        properties: {
          server: { type: "string", description: "MCP server id or name." }
        },
        required: ["server"]
      }
    }
  },
  {
    toolset: "self",
    displayLabel: "Remove connector",
    deferred: true,
    indexSummary: "Disconnect a connector: wipe its secrets (user) or tombstone it (auto-detected).",
    type: "function",
    function: {
      name: "remove_connector",
      description: "Disconnect a connector: wipe its encrypted secrets (user connectors) or tombstone it (auto-detected ones). Call list_connectors first for the id. Approval-gated: auto-approved in `auto` mode, gated in `strict`.",
      parameters: {
        type: "object",
        properties: {
          connector: { type: "string", description: "Connector id to remove." }
        },
        required: ["connector"]
      }
    }
  },
  {
    toolset: "self",
    displayLabel: "Rotate connector",
    deferred: true,
    indexSummary: "Rotate a connector's credential — write a new token into one of its secret slots.",
    type: "function",
    function: {
      name: "rotate_connector",
      description: "Rotate a connector's credential — write a new token into one of its secret slots. Pass 'purpose' when the connector has more than one slot. Call list_connectors first for the id. Approval-gated: auto-approved in `auto` mode, gated in `strict`.",
      parameters: {
        type: "object",
        properties: {
          connector: { type: "string", description: "Connector id to rotate." },
          token: { type: "string", description: "The new secret value to store." },
          purpose: { type: "string", description: "Which secret slot to write (e.g. 'token'). Optional when the connector has exactly one slot; required when it has several." }
        },
        required: ["connector", "token"]
      }
    }
  },
  {
    toolset: "self",
    displayLabel: "Update runtime",
    deferred: true,
    indexSummary: "Update the runtime to the latest commit and RESTART the gateway to run the new code.",
    type: "function",
    function: {
      name: "update_self",
      description: "Update the runtime to the latest commit (git fetch + reset + bun install) and RESTART the gateway so the new code takes effect. Only works from the installer-managed runtime. Approval-gated: auto-approved in `auto` mode, gated in `strict`.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    toolset: "self",
    displayLabel: "Roll back skill",
    deferred: true,
    indexSummary: "Roll a skill back to its previous saved version. Fails if it has no rollback history.",
    type: "function",
    function: {
      name: "rollback_skill",
      description: "Roll a skill back to its previous saved version. Fails if the skill has no rollback history. Call list_skills first for the id. Approval-gated: auto-approved in `auto` mode, gated in `strict`.",
      parameters: {
        type: "object",
        properties: {
          skillId: { type: "string", description: "Skill id or name to roll back." }
        },
        required: ["skillId"]
      }
    }
  },
  {
    toolset: "self",
    displayLabel: "Test skill",
    deferred: true,
    indexSummary: "Validate a skill's record (required fields, steps, spec compliance) and report pass/fail.",
    type: "function",
    function: {
      name: "test_skill",
      description: "Validate a skill's record (required fields, steps, spec compliance) and report pass/fail. Records the test outcome on the skill, so it is approval-gated: auto-approved in `auto` mode, gated in `strict`. Call list_skills first for the id.",
      parameters: {
        type: "object",
        properties: {
          skillId: { type: "string", description: "Skill id or name to test." }
        },
        required: ["skillId"]
      }
    }
  }
];

export type ToolCatalogTool = ToolFunctionSpec & {
  toolset: string;
  displayLabel?: string;
  deferred?: boolean;
  indexSummary?: string;
  crossToolsetHint?: { toolset: string; text: string };
};

// Public read-only copy. Returned ordering is stable so the toolsHash is
// deterministic across boots (used for resume after approval).
export function allTools(): ToolCatalogTool[] {
  return TOOL_DEFS.map((t) => ({ ...t, function: { ...t.function, parameters: { ...t.function.parameters } } }));
}


// Filter tools by enabled toolsets in state. The web_fetch tool is grouped
// under "messaging" only because the legacy defaults didn't include a "web"
// toolset; if state has no `web` toolset the tool stays available unless an
// explicit messaging toolset row is disabled. To keep behavior intuitive we
// always allow web_fetch for now (low-risk, matches legacy `web ` prefix).
//
// `agentToolsetFilter` is the optional active-agent whitelist (toolset
// names). When set, it intersects with the enabled-toolset filter — a tool
// passes only if its owning toolset is BOTH globally enabled AND in the
// agent's whitelist. Always-on tools bypass both filters: web_fetch,
// list_skills, read_skill, spawn_subagent, the scheduled-job surface (create_job,
// list_jobs, update_job, delete_job, run_job), mcp_call, request_connector,
// and the core agent-capability meta-tools that have no separate toolset
// to gate them (cancel_task — sibling to spawn_subagent; install_skill /
// enable_skill / disable_skill — siblings to read_skill). The surface-
// gateway tool `send_message` (toolset `messaging`) stays subject to the
// toolset enable/disable kill switch — operators disable that toolset to
// hide outbound messaging entirely.
export function buildToolCatalog(state: RuntimeState, agentToolsetFilter?: Set<string>): ToolCatalogTool[] {
  const enabled = new Set(state.toolsets.filter((t) => t.status === "enabled").map((t) => t.name));
  return allTools().filter((tool) => {
    if (tool.function.name === "web_fetch") return true;
    // load_tools is the deferred-tools meta-tool. Always-on and on no legacy
    // toolset (`core`); the model needs it to pull any deferred schema into
    // the live tools array. Deferral itself is applied later by
    // applyDeferralFilter, not by this gate — load_tools is never deferred.
    if (tool.function.name === "load_tools") return true;
    // get_current_time is the always-on read-only clock. Like load_tools it
    // lives on `core` (not a legacy default toolset); the model
    // must be able to answer "what time is it" on any instance regardless of
    // which toolsets are enabled, and it has no side effects to gate.
    if (tool.function.name === "get_current_time") return true;
    // Always expose read_skill so the model can load any enabled skill the
    // system prompt advertises. The "skills" toolset isn't part of the
    // legacy default toolsets; gating it on enable would mean a fresh
    // instance can't follow its own skill prompt without a toolset toggle.
    if (tool.function.name === "list_skills") return true;
    if (tool.function.name === "read_skill") return true;
    // record_skill_feedback (ADR skill-learning-from-outcomes.md) — the model
    // records the user's answer to a "Skill review" question. Always-on like
    // read_skill: a review question can land in any session, and the agent must
    // be able to capture the verdict regardless of toolset state. Low-risk: it
    // only appends a SkillOutcome row.
    if (tool.function.name === "record_skill_feedback") return true;
    // Always expose spawn_subagent. Like read_skill it's a runtime
    // capability not tied to a legacy default toolset row, and gating it
    // on enable would silently disable delegation on freshly cloned
    // instances. Subagent path itself is depth-capped and audited.
    if (tool.function.name === "spawn_subagent") return true;
    // spawn_task rides alongside spawn_subagent for the same reason: it's a
    // runtime capability on the non-default "subagents" toolset, and the
    // child-task path is depth-capped, dedup-keyed, and audited.
    if (tool.function.name === "spawn_task") return true;
    // Always expose the full scheduled-job tool surface (create / list /
    // update / delete / run). The "jobs" toolset isn't part of the legacy
    // defaults; gating on enable would silently hide scheduling (and the
    // chat-reminder delivery loop) on fresh instances. Exposing the set
    // together also keeps composition coherent — without list_jobs the
    // agent can't see existing jobs to pick the right id for update,
    // delete, or run, and that's how duplicates get created. Low-risk by
    // design: the user can pause/delete any job from /jobs, and manual
    // runs inherit the job's existing approval envelope.
    if (tool.function.name === "create_job") return true;
    if (tool.function.name === "list_jobs") return true;
    if (tool.function.name === "update_job") return true;
    if (tool.function.name === "delete_job") return true;
    if (tool.function.name === "run_job") return true;
    // email_watch (ADR email-watch.md) — config-only watcher management on
    // the "email" toolset, which isn't a legacy default. Always-on like the
    // job surface so a fresh instance can set up an email watcher from chat
    // without a toolset toggle. Low-risk: it only writes a watcher record.
    if (tool.function.name === "email_watch") return true;
    // mcp_call is a runtime capability not bound to a legacy toolset row.
    // Gating it on the "mcp" toolset would silently hide MCP usage on
    // fresh instances even when a user has configured a server, so it
    // mirrors read_skill / spawn_subagent's always-on stance.
    if (tool.function.name === "mcp_call") return true;
    // skill_run is the generic dispatch surface for skill-bundled
    // procedures (recipe-shaped operations that live in skills, not in
    // core). Always-on alongside mcp_call so a fresh instance can invoke
    // any skill script without toolset toggling — the skill's `enabled`
    // status is the gate.
    if (tool.function.name === "skill_run") return true;
    // vision_query is the base primitive that exposes the model's
    // multimodal capability against arbitrary uploads — like
    // browser_vision but not tied to the browser session. Always-on
    // alongside mcp_call for the same reasons.
    if (tool.function.name === "vision_query") return true;
    // request_connector is the in-chat affordance that lets the agent
    // ask the user to wire up a missing connector. Same always-on
    // rationale: a fresh instance with no toolsets toggled still needs
    // to be able to surface "connect linear" when the linear skill is
    // inactive — gating on a legacy toolset would silently disable the
    // onboarding path.
    if (tool.function.name === "request_connector") return true;
    // request_google_account is the in-chat affordance that puts a
    // connect/reconnect-Google button (→ Integrations page) in front of
    // the user. Same always-on rationale as request_connector: a revoked
    // Google session can strand any instance, and the recovery path must
    // be reachable with no toolsets toggled.
    if (tool.function.name === "request_google_account") return true;
    // ask_user is the in-chat affordance for putting a single-select
    // question card in front of the user mid-turn. Always-on for the
    // same reason as request_connector: offering setup-vs-alternative
    // choices (its primary steer) must work on a fresh instance with
    // no toolsets toggled, and it's a meta-tool with no side effects
    // beyond pausing on a user-actor card.
    if (tool.function.name === "ask_user") return true;
    // request_confirmation is the in-chat affordance for an inline
    // Confirm/Cancel card before an irreversible third-party-facing
    // action. Always-on for the same reason as ask_user: the agent must
    // be able to ask for consent on a fresh instance with no toolsets
    // toggled, and it's a meta-tool with no side effects beyond pausing
    // on a user-actor card (it pauses even under approvalMode "yolo").
    if (tool.function.name === "request_confirmation") return true;
    // browser_fill_secrets is the in-chat affordance for credential
    // entry on the agent's browser tab. Always-on for the same
    // reason as request_connector: a fresh instance with no toolsets
    // toggled still needs the agent to be able to ask the user for a
    // password mid-task. The browser_type tool is gated by the
    // browser toolset, but browser_fill_secrets is a meta-tool
    // (renders a chat card; never types anything itself) and stays
    // visible so the agent can always escalate to the user instead
    // of guessing a credential.
    if (tool.function.name === "browser_fill_secrets") return true;
    // request_messaging_bridge is the in-chat affordance for adding a
    // Telegram / Discord bridge — peer of request_connector but for
    // outbound messaging plumbing. Always-on for the same reason: the
    // user should be able to ask "add a telegram bot" on a fresh
    // instance without first toggling a toolset. The owning toolset is
    // "messaging" (same as `send_message`), but unlike send_message
    // this is a meta-tool that surfaces a credential form card; it
    // doesn't egress data on its own. Always exposed so the onboarding
    // path stays reachable even when the messaging toolset is disabled
    // by operators who don't want the agent autonomously sending DMs.
    if (tool.function.name === "request_messaging_bridge") return true;
    // The rest of the chat-side messaging lifecycle: read-only
    // inventory (list_messaging_bridges, list_messaging_pairings) so
    // the agent can answer state questions, and approval-gated
    // request_messaging_pairing / request_remove_messaging_bridge so
    // the agent can drive pair-approval and removal from chat without
    // the user needing to context-switch to the settings page. Same
    // always-on rationale as request_messaging_bridge: meta-tools that
    // surface UI cards or read state ride alongside it; the
    // surface-gateway send_message tool stays gated by the messaging
    // toolset kill switch.
    if (tool.function.name === "list_messaging_bridges") return true;
    if (tool.function.name === "list_messaging_pairings") return true;
    if (tool.function.name === "wait_for_messaging_pair") return true;
    if (tool.function.name === "request_messaging_pairing") return true;
    if (tool.function.name === "request_remove_messaging_bridge") return true;
    // Always expose the core agent-capability meta-tools whose owning
    // toolsets aren't in the legacy defaults (`skills`, `subagents`).
    // Gating these on a toolset toggle would mean a fresh instance
    // literally can't see them, even though they're the right path for
    // common asks ("cancel that subagent", "install this skill"). They
    // sit alongside their already-always-on siblings (cancel_task next
    // to spawn_subagent; install/enable/disable_skill next to
    // read_skill). When the underlying resource isn't configured the
    // tool handler surfaces a clear error — that's the correct UX, not
    // "tool didn't exist". Note: `send_message` (toolset `messaging`)
    // is deliberately NOT in this bypass — it's a surface-gateway tool
    // (outbound messaging) where the operator's toolset kill switch
    // must work. Flipping the `messaging` toolset to disabled is how
    // the operator turns it off.
    if (tool.function.name === "cancel_task") return true;
    if (tool.function.name === "install_skill") return true;
    if (tool.function.name === "enable_skill") return true;
    if (tool.function.name === "disable_skill") return true;
    // Identity-file edit tools. The "identity" toolset is not part of
    // the legacy default set; gating on enable would silently hide the
    // per-agent SOUL.md / instance USER.md edit surface on fresh
    // instances. The proposed-vs-approved file split (see ADR
    // runtime-identity-files.md) keeps unreviewed content out of the
    // prompt regardless of toolset state, so always-on here is safe.
    if (tool.function.name === "edit_soul") return true;
    if (tool.function.name === "edit_user_profile") return true;
    // Self-knowledge surface. The self-config / introspection tools
    // (get_self, self-list readers other than always-on list_skills, and the
    // mutate ops like set_provider / use_agent / set_approval_mode) are direct
    // deferred tools on the "self" toolset, which is not a legacy default;
    // gating on enable would mean a fresh instance couldn't answer "what
    // model are you using" or "switch to deepseek" — the exact asks the
    // surface exists for. They pass gating here; deferral (applied later by
    // applyDeferralFilter) is what keeps them out of the live tools array
    // until the model loads them. Query tools are read-only; the mutate
    // tools gate via the self.config approval branch in dispatch.
    if (tool.toolset === "self") return true;
    if (!enabled.has(tool.toolset)) return false;
    if (agentToolsetFilter && !agentToolsetFilter.has(tool.toolset)) return false;
    return true;
  }).map((tool) => {
    // Apply or strip cross-toolset routing hints (see the TOOL_DEFS doc
    // comment). The hint joins the description only when its referenced
    // toolset passes the same enabled + agent-whitelist gate the referenced
    // tools pass; otherwise it's dropped so the model never chases tools
    // that aren't in the catalog. The annotation itself never survives
    // assembly — toProviderTools must not see it.
    const hint = tool.crossToolsetHint;
    if (!hint) return tool;
    const { crossToolsetHint: _hint, ...rest } = tool;
    const reachable = enabled.has(hint.toolset)
      && (!agentToolsetFilter || agentToolsetFilter.has(hint.toolset));
    if (!reachable) return rest;
    return { ...rest, function: { ...rest.function, description: `${rest.function.description} ${hint.text}` } };
  });
}

// Stable hash over a tool list. Used to detect when the catalog changes
// between iterations of the agent loop (e.g. user enabled a toolset
// mid-conversation) so we can decide whether to keep resuming with the
// snapshotted state.
export function hashCatalog(tools: ToolCatalogTool[]): string {
  const summary = tools.map((t) => `${t.function.name}:${JSON.stringify(t.function.parameters)}`).join("|");
  return createHash("sha1").update(summary).digest("hex").slice(0, 16);
}

// Return the OpenAI tool spec without the `toolset` / `displayLabel` /
// `deferred` / `indexSummary` / `crossToolsetHint` annotations we use for
// filtering, chat rendering, and the deferred-tools index. The provider
// only knows the `type/function` shape.
export function toProviderTools(tools: ToolCatalogTool[]): ToolFunctionSpec[] {
  return tools.map(
    ({ toolset: _toolset, displayLabel: _displayLabel, deferred: _deferred, indexSummary: _indexSummary, crossToolsetHint: _crossToolsetHint, ...rest }) => rest
  );
}

// ---------------- Deferred tools ----------------
//
// A deferred tool's full schema is withheld from the provider until the
// model loads it via load_tools. The functions below are the pure surface
// the chat-task loop drives: build the system-prompt index, filter the
// provider catalog by the loaded set, resolve names, and run a load_tools
// call. None of them touch state — the loop owns persistence.

// First sentence of a (possibly multi-paragraph) tool description, capped so
// the on-demand index stays compact. Splits on the first sentence-ending
// punctuation followed by whitespace; falls back to a hard char cap.
export function firstSentence(text: string, cap = 140): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^.*?[.!?](?=\s|$)/);
  const sentence = match ? match[0] : trimmed;
  if (sentence.length <= cap) return sentence;
  return sentence.slice(0, cap - 1).trimEnd() + "…";
}

// The system-prompt "available on demand" index: every deferred tool in the
// (already-gated) catalog that the model has NOT yet loaded, as {name,
// summary}. summary prefers the curated `indexSummary`, falling back to the
// description's first sentence.
export function deferredToolIndex(
  catalog: ToolCatalogTool[],
  loaded: ReadonlySet<string>
): Array<{ name: string; summary: string }> {
  return catalog
    .filter((tool) => tool.deferred && !loaded.has(tool.function.name))
    .map((tool) => ({
      name: tool.function.name,
      summary: tool.indexSummary ?? firstSentence(tool.function.description ?? "")
    }));
}

// The provider-facing catalog: drop deferred tools the model hasn't loaded
// yet. Core tools always pass; a deferred tool passes only once its name is
// in `loaded`. The hot no-load path (loaded === ∅) returns exactly the core
// tools, byte-identical to a catalog with no deferred entries.
export function applyDeferralFilter(
  catalog: ToolCatalogTool[],
  loaded: ReadonlySet<string>
): ToolCatalogTool[] {
  return catalog.filter((tool) => !tool.deferred || loaded.has(tool.function.name));
}

// Partition the requested names against the (already-gated) catalog. Only a
// deferred tool that is present in the catalog counts as loadable — a core
// tool (already live) or a name the catalog doesn't carry lands in `unknown`
// so the model gets a clear signal instead of silently no-op-ing.
export function resolveLoadableTools(
  catalog: ToolCatalogTool[],
  names: string[]
): { loaded: string[]; unknown: string[] } {
  const deferredNames = new Set(
    catalog.filter((tool) => tool.deferred).map((tool) => tool.function.name)
  );
  const loaded: string[] = [];
  const unknown: string[] = [];
  for (const name of names) {
    if (deferredNames.has(name)) loaded.push(name);
    else unknown.push(name);
  }
  return { loaded, unknown };
}

// Closest deferred-tool names for an unknown load request, so the model gets
// a "did you mean" nudge instead of a bare miss. A candidate is "close" when
// one name contains the other or they share a leading token.
function suggestDeferredTools(catalog: ToolCatalogTool[], name: string): string[] {
  const lower = name.toLowerCase();
  const head = lower.split(/[_\s]/)[0] ?? lower;
  return catalog
    .filter((tool) => tool.deferred)
    .map((tool) => tool.function.name)
    .filter((candidate) => {
      const c = candidate.toLowerCase();
      return c.includes(lower) || lower.includes(c) || (head.length > 0 && c.startsWith(head));
    })
    .slice(0, 5);
}

// Run a load_tools call against the catalog + current loaded set. Lenient
// parse (a malformed arg blob yields an empty names list rather than
// throwing — the model gets a recoverable envelope). Returns the JSON
// tool-result string plus the names that became NEWLY loaded this call, so
// the loop can union them into the loaded set and persist.
export function handleLoadTools(
  rawArgs: string,
  catalog: ToolCatalogTool[],
  loaded: ReadonlySet<string>
): { result: string; newlyLoaded: string[] } {
  let names: string[] = [];
  try {
    const parsed = rawArgs && rawArgs.trim() ? (JSON.parse(rawArgs) as unknown) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const raw = (parsed as Record<string, unknown>).names;
      if (Array.isArray(raw)) {
        names = raw.filter((n): n is string => typeof n === "string" && n.trim().length > 0).map((n) => n.trim());
      } else if (typeof raw === "string" && raw.trim().length > 0) {
        // Tolerate a single name passed as a bare string.
        names = [raw.trim()];
      }
    }
  } catch {
    names = [];
  }
  const { loaded: loadable, unknown } = resolveLoadableTools(catalog, names);
  const newlyLoaded = loadable.filter((name) => !loaded.has(name));
  const alreadyLoaded = loadable.filter((name) => loaded.has(name));
  const envelope: Record<string, unknown> = {
    ok: true,
    loaded: newlyLoaded,
    alreadyLoaded,
    unknown,
    note: "These tools are now callable directly. Call them by name on your next turn — do not pass their arguments to load_tools."
  };
  if (unknown.length > 0) {
    const didYouMean: Record<string, string[]> = {};
    for (const name of unknown) {
      const suggestions = suggestDeferredTools(catalog, name);
      if (suggestions.length > 0) didYouMean[name] = suggestions;
    }
    if (Object.keys(didYouMean).length > 0) envelope.didYouMean = didYouMean;
  }
  return { result: JSON.stringify(envelope), newlyLoaded };
}

// Whether a tool NAME is a deferred catalog tool. Used by the dispatcher's
// pre-switch guard: a deferred tool the model calls before loading it isn't
// in the dispatch switch's reachable set yet (it ships no schema), so the
// guard returns a recoverable "load it first" nudge instead of throwing
// "Unknown tool".
export function isDeferredToolName(toolName: string): boolean {
  return TOOL_DEFS.some((tool) => tool.deferred && tool.function.name === toolName);
}

// Display-label lookup for ChatBlock rendering. Returns the catalog
// entry's explicit `displayLabel` when set; otherwise humanizes the
// tool's machine name (`file_read` → `File read`) as a stable fallback.
// Centralized server-side so web, mobile, and CLI bridges render the
// same vocabulary in tool_call ChatBlocks (ADR chat-block-protocol.md).
export function chatBlockLabelFor(toolName: string): string {
  const entry = TOOL_DEFS.find((t) => t.function.name === toolName);
  if (entry?.displayLabel) return entry.displayLabel;
  // Fallback: split underscores, capitalize the first word, lowercase
  // the rest. `file_read` → `File read`, `mcp_call` → `Mcp call`. We
  // intentionally don't title-case every word — `Search History` looks
  // like a marketing label rather than a compact verb phrase.
  const tokens = toolName.split(/[._]/).filter(Boolean);
  if (tokens.length === 0) return toolName;
  const first = tokens[0]!;
  const head = first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
  const tail = tokens.slice(1).map((t) => t.toLowerCase()).join(" ");
  return tail ? `${head} ${tail}` : head;
}

// Truncate a short headline string to 80 chars with an ellipsis. Picked
// to fit one bubble line on a phone (mobile is the narrowest target);
// web can expand the bubble for the full args object via `argsFull`.
function truncatePreview(value: string, maxLen = 80): string {
  if (value.length <= maxLen) return value;
  return value.slice(0, maxLen - 1) + "…";
}

// Stringify the value half of an args entry compactly: strings pass
// through, numbers/booleans are coerced, objects/arrays are JSON-encoded
// with a hard length cap so a giant blob doesn't blow out the preview.
function previewValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// Render a browser ref as a human-readable element label when a resolver
// can name it, falling back to the bare ref otherwise. The resolver is
// supplied by the caller (chat-task wires it to the live browser session)
// so tool-catalog stays free of browser internals.
function formatRefPreview(
  ref: unknown,
  resolve?: (ref: string) => { role: string; name: string } | undefined
): string {
  const refStr = previewValue(ref);
  if (!refStr) return "";
  const label = resolve?.(refStr);
  if (label?.name) {
    // Synthetic "clickable" role (cursor-detected, not a real ARIA role) reads
    // poorly as a label — show the name alone in that one case.
    return label.role && label.role !== "clickable"
      ? `${label.role} "${label.name}"`
      : `"${label.name}"`;
  }
  // No accessible name (icon button) or no live session → bare ref.
  return refStr;
}

// Per-tool argsPreview override — returns the most useful 1-line
// representation of the call's headline argument. Falls back to a
// generic "key=value, ..." dump of all top-level args when no specific
// mapping fires. Always truncated to 80 chars (see truncatePreview).
//
// Add new entries here as new tools land; the helper deliberately
// covers all the current first-class tools so clients render a useful
// inline preview without each one rebuilding the per-tool mapping.
export function chatBlockArgsPreviewFor(
  toolName: string,
  args: Record<string, unknown> | null | undefined,
  resolveRefLabel?: (ref: string) => { role: string; name: string } | undefined,
  resolveJobName?: (jobId: string) => string | undefined
): string {
  const safe = args ?? {};
  // Headline-arg mapping per tool. Order matters within an entry only
  // when multiple alt sources are queried (e.g. `browser_*` may have
  // `url` OR `ref`).
  switch (toolName) {
    case "file_read":
    case "file_list":
    case "file_search":
    case "file_write":
    case "file_patch":
      return truncatePreview(previewValue(safe.path) || previewValue(safe.pattern));
    case "web_fetch":
      return truncatePreview(previewValue(safe.url));
    case "web_search":
      return truncatePreview(previewValue(safe.query));
    case "load_tools":
      return truncatePreview(Array.isArray(safe.names) ? safe.names.join(", ") : previewValue(safe.names));
    case "terminal_exec":
      // Masked: a raw shell command line is noise — and a path/secret-leak
      // risk — in an end-user inline preview. The full command stays in
      // `argsFull.command`; clients surface it on row expansion.
      return "";
    case "code_exec":
      return truncatePreview(`${previewValue(safe.language) || "code"}: ${previewValue(safe.code)}`);
    case "read_skill":
    case "enable_skill":
    case "disable_skill":
      return truncatePreview(previewValue(safe.name) || previewValue(safe.skillId));
    case "install_skill":
      return truncatePreview("skill");
    case "spawn_subagent":
      return truncatePreview(previewValue(safe.name) || previewValue(safe.prompt));
    case "spawn_task":
      return truncatePreview(previewValue(safe.title) || previewValue(safe.prompt));
    case "browser_navigate":
      return truncatePreview(previewValue(safe.url));
    case "browser_click":
    case "browser_type":
    case "browser_hover":
    case "browser_select_option":
    case "browser_upload_file":
    case "browser_download":
      return truncatePreview(formatRefPreview(safe.ref, resolveRefLabel));
    case "browser_press":
      return truncatePreview(previewValue(safe.key));
    case "browser_resize":
      return truncatePreview(`${previewValue(safe.width)}x${previewValue(safe.height)}`);
    case "browser_scroll":
      return truncatePreview(previewValue(safe.direction));
    case "browser_wait_for":
      return truncatePreview(formatRefPreview(safe.ref, resolveRefLabel) || previewValue(safe.text));
    case "browser_fill_form":
      // Preview the refs only — field text is page content the card
      // doesn't need, and the ref list tells the user what's touched.
      return truncatePreview(
        Array.isArray(safe.fields)
          ? safe.fields
              .map((f) => (f !== null && typeof f === "object" ? formatRefPreview((f as Record<string, unknown>).ref, resolveRefLabel) : ""))
              .filter(Boolean)
              .join(", ")
          : ""
      );
    case "browser_tabs":
    case "browser_dialog":
      return truncatePreview(previewValue(safe.action));
    case "browser_vision":
      return truncatePreview(previewValue(safe.question));
    case "browser_drag":
      return truncatePreview(
        `${formatRefPreview(safe.fromRef, resolveRefLabel)} → ${formatRefPreview(safe.toRef, resolveRefLabel)}`
      );
    case "browser_requests":
      return truncatePreview(previewValue(safe.filter));
    case "browser_snapshot":
    case "browser_back":
    case "browser_close":
    case "browser_console":
      return "";
    case "mcp_call":
      return truncatePreview(
        `${previewValue(safe.server)}.${previewValue(safe.tool)}`
      );
    case "skill_run":
      return truncatePreview(`${previewValue(safe.skill)}/${previewValue(safe.script)}`);
    case "vision_query":
      return truncatePreview(`${previewValue(safe.uploadId)}: ${previewValue(safe.question)}`);
    case "request_connector":
      return truncatePreview(previewValue(safe.provider));
    case "ask_user":
      return truncatePreview(previewValue(safe.question));
    case "request_confirmation":
      return truncatePreview(previewValue(safe.summary));
    case "request_messaging_bridge":
      return truncatePreview(previewValue(safe.kind));
    case "list_messaging_bridges":
      return "";
    case "list_messaging_pairings":
      return truncatePreview(previewValue(safe.bridge));
    case "wait_for_messaging_pair":
      return truncatePreview(previewValue(safe.bridge));
    case "request_messaging_pairing":
      return truncatePreview(`${previewValue(safe.bridge)} chat ${previewValue(safe.chatId)}`);
    case "request_remove_messaging_bridge":
      return truncatePreview(previewValue(safe.bridge));
    case "create_job":
    case "run_job":
    case "delete_job":
    case "update_job": {
      // Prefer a model-supplied `name` (create_job, or update_job rename),
      // then resolve the job's stored name from its id so jobId-only calls
      // (run_job / delete_job) read as the job's name, not "job_6e0fd00b".
      const jobIdStr = previewValue(safe.jobId);
      const resolved = jobIdStr ? resolveJobName?.(jobIdStr) : undefined;
      return truncatePreview(previewValue(safe.name) || previewValue(resolved) || jobIdStr);
    }
    case "list_jobs":
      return truncatePreview(previewValue(safe.nameContains) || "");
    case "cancel_task":
      return truncatePreview(previewValue(safe.taskId));
    case "send_message":
      return truncatePreview(previewValue(safe.text));
    case "search_history":
      return truncatePreview(previewValue(safe.query));
    case "recall_memory":
      return truncatePreview(previewValue(safe.query));
    case "db_query":
    case "db_execute":
      return truncatePreview(previewValue(safe.sql));
    case "db_import":
      return truncatePreview(`${previewValue(safe.path)} → ${previewValue(safe.table)}`);
    case "db_schema":
      return "";
    case "add_memory":
      return truncatePreview(previewValue(safe.content));
    case "update_memory":
      return truncatePreview(previewValue(safe.memoryId));
    case "get_self":
    case "list_providers":
    case "list_agents":
    case "list_mcp_servers":
    case "list_connectors":
    case "list_toolsets":
    case "update_self":
      return "";
    case "list_skills":
      return truncatePreview(previewValue(safe.nameContains) || previewValue(safe.status) || "");
    case "set_provider":
      return truncatePreview(previewValue(safe.provider) || previewValue(safe.model) || "");
    case "use_agent":
      return truncatePreview(previewValue(safe.agentId));
    case "create_agent":
      return truncatePreview(previewValue(safe.name));
    case "rename_agent":
      return truncatePreview(previewValue(safe.name));
    case "set_approval_mode":
      return truncatePreview(previewValue(safe.mode));
    case "enable_toolset":
    case "disable_toolset":
      return truncatePreview(previewValue(safe.toolset));
    case "delete_agent":
      return truncatePreview(previewValue(safe.agentId));
    case "remove_provider":
      return truncatePreview(previewValue(safe.provider));
    case "set_auto_approve_commands":
    case "set_dangerous_patterns":
      return truncatePreview(Array.isArray(safe.patterns) ? `${safe.patterns.length} patterns` : "");
    case "add_mcp_server":
      return truncatePreview(previewValue(safe.name));
    case "remove_mcp_server":
      return truncatePreview(previewValue(safe.server));
    case "remove_connector":
    case "rotate_connector":
      return truncatePreview(previewValue(safe.connector));
    case "rollback_skill":
    case "test_skill":
      return truncatePreview(previewValue(safe.skillId));
    default: {
      // Generic fallback: key=value, ... for the first few entries.
      // Keeps unmapped or future tools from emitting an empty preview.
      const parts = Object.entries(safe)
        .slice(0, 3)
        .map(([key, value]) => `${key}=${previewValue(value)}`);
      return truncatePreview(parts.join(", "));
    }
  }
}

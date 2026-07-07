import type { AssistantTextBlock, ChatBlock, ToolCallBlock } from "@runtime/types";

// One entry in a collapsed exchange's "process": either a tool call or a
// piece of pre-tool narration the model emitted between tools. Steps keep
// exchange order so the expanded view replays the turn chronologically.
export type ProcessStep =
  | { kind: "tool_call"; block: ToolCallBlock }
  | { kind: "narration"; block: AssistantTextBlock };

// Render-time view of the chat block stream. Whenever a turn makes tool
// calls, those calls AND the per-iteration narration the model emitted
// between them collapse into a single "tool_group" item — the narration
// renders as "Thinking" rows alongside the tool-call rows — leaving only the
// final answer as a standalone bubble. The grouping is identical while the
// turn streams and after it settles (the process reads the same the whole way
// through, so no steps reflow when the turn finishes). What differs is
// presentation: an in-flight group (`inProgress`) renders expanded so the user
// watches each tool call land as it happens, then collapses to the one-line
// summary once the turn completes. The generated-files card likewise waits
// until the turn is complete. A turn with no tool calls passes its blocks
// through as raw bubbles.
//
// `isFinalAnswer` marks the one block that is the turn's closing answer —
// only set on a standalone assistant_text that comes after the last tool call
// (or the lone reply of a no-tool turn). A forwarded Topic turn's per-iteration
// narration is NOT the final answer, so its "# topic" deep-link chip is
// suppressed; only the final answer carries it.
export type ChatRenderItem =
  | { kind: "block"; block: ChatBlock; isFinalAnswer?: boolean }
  | { kind: "tool_group"; id: string; calls: ToolCallBlock[]; steps: ProcessStep[]; inProgress: boolean }
  | { kind: "file_artifact"; id: string; files: { path: string; toolName: string }[] };

export function groupExchanges(
  blocks: ChatBlock[],
  terminalTaskIds: ReadonlySet<string> = new Set()
): ChatRenderItem[] {
  const items: ChatRenderItem[] = [];
  // ask_user renders as the agent speaking: its chat.choice setup_requested
  // block is the sole representation, so the tool_call itself never becomes
  // a tool-group row (or a loose inline block). Its tool_result stays in the
  // stream but is invisible on its own (results render only inside a parent
  // call's expansion). EXCEPT a rejected call: the dispatcher refuses to
  // mint a choice (option-less/malformed args), so no chat.choice block
  // exists and dropping the call would leave the turn with no trace at all.
  // A rejection shows up either as block status "error"/"denied" (dispatch
  // threw) or — for the graceful steer — as the paired tool_result's
  // `{"ok":false,...}` JSON while the call itself settled "ok"; keep those
  // calls so the failed ask still renders as a tool row.
  const askUserRejected = (call: ToolCallBlock): boolean => {
    if (call.status === "error" || call.status === "denied") return true;
    const result = blocks.find(
      (b) => b.kind === "tool_result" && b.callId === call.callId && b.taskId === call.taskId
    );
    return result?.kind === "tool_result" && result.preview.startsWith('{"ok":false');
  };
  blocks = blocks.filter(
    (b) => !(b.kind === "tool_call" && b.toolName === "ask_user" && !askUserRejected(b))
  );
  // Partition blocks into exchanges, then collapse each. An exchange is the
  // set of blocks sharing one taskId — a single agent turn or job cycle. A
  // turn's user_text, assistant_text, and tool calls all carry that turn's
  // taskId, so grouping by taskId keeps them together. This is what splits a
  // recurring-job channel — which has no user_text — into one group per cron
  // cycle; treating the whole channel as one exchange would collapse every
  // cycle's tool calls into a single group anchored to the first message.
  //
  // Grouping by taskId rather than by contiguous run also survives
  // interleaving: a manual or replay job run may execute alongside an
  // in-flight scheduled run (see src/jobs/index.ts), so two tasks can write
  // blocks into one session's ordinal stream out of order. Keying on taskId
  // reunites each task's blocks regardless of insertion order, and exchange
  // order follows each task's first appearance.
  //
  // A block with no taskId forms its own single-block exchange in place, so
  // it passes through untouched rather than merging into an unrelated turn.
  const exchanges: ChatBlock[][] = [];
  const indexByTask = new Map<string, number>();
  for (const b of blocks) {
    if (b.taskId === undefined) {
      exchanges.push([b]);
      continue;
    }
    const existing = indexByTask.get(b.taskId);
    if (existing === undefined) {
      indexByTask.set(b.taskId, exchanges.length);
      exchanges.push([b]);
    } else {
      exchanges[existing]!.push(b);
    }
  }
  for (const exchange of exchanges) appendExchange(items, exchange, terminalTaskIds);
  return items;
}

function appendExchange(items: ChatRenderItem[], exchange: ChatBlock[], terminalTaskIds: ReadonlySet<string>) {
  const calls: ToolCallBlock[] = [];
  for (const b of exchange) {
    if (b.kind === "tool_call") calls.push(b);
  }
  // No tool calls: a plain Q&A turn (or one just starting before its first tool
  // call). Pass every block through as its own bubble — nothing to fold and no
  // narration to demote.
  if (calls.length === 0) {
    // No tool calls: the final answer is the last assistant_text. Mark it so a
    // forwarded turn shows its "# topic" chip only on the closing reply.
    let finalIdx = -1;
    for (let i = exchange.length - 1; i >= 0; i--) {
      if (exchange[i]!.kind === "assistant_text") {
        finalIdx = i;
        break;
      }
    }
    for (let i = 0; i < exchange.length; i++) {
      // A tool_result never renders standalone (results show only inside a
      // parent call's expansion), so skip it here like the grouped path does.
      // Reachable without a call: the ask_user filter above drops the
      // tool_call but its result stays, so an ask_user-only turn lands here —
      // passing the result through would render an empty transcript row.
      if (exchange[i]!.kind === "tool_result") continue;
      items.push({ kind: "block", block: exchange[i]!, ...(i === finalIdx ? { isFinalAnswer: true } : {}) });
    }
    return;
  }
  // The final answer is the LAST assistant_text, but only when it comes AFTER
  // the last tool call; every earlier assistant_text is per-iteration narration
  // that folds into the group as a "Thinking" row. A turn that stopped on a
  // tool call (no closing answer — still streaming, or terminated there) has
  // its last assistant_text before that call, so finalAnswerIdx stays -1 and
  // every narration folds with no standalone bubble. Computed the same whether
  // the turn is still in flight or already settled.
  let lastToolCallIdx = -1;
  for (let i = exchange.length - 1; i >= 0; i--) {
    if (exchange[i]!.kind === "tool_call") {
      lastToolCallIdx = i;
      break;
    }
  }
  let finalAnswerIdx = -1;
  for (let i = exchange.length - 1; i >= 0; i--) {
    if (exchange[i]!.kind === "assistant_text") {
      if (i > lastToolCallIdx) finalAnswerIdx = i;
      break;
    }
  }
  // Build the ordered process: tool calls and non-final narration in
  // exchange order. The group renders at the first process step's
  // position (groupIdx), so a leading narration line collapses into the
  // group rather than rendering above it.
  const steps: ProcessStep[] = [];
  let groupIdx = -1;
  for (let i = 0; i < exchange.length; i++) {
    const b = exchange[i]!;
    if (b.kind === "tool_call") {
      steps.push({ kind: "tool_call", block: b });
    } else if (b.kind === "assistant_text" && i !== finalAnswerIdx) {
      steps.push({ kind: "narration", block: b });
    } else {
      continue;
    }
    if (groupIdx === -1) groupIdx = i;
  }
  for (let i = 0; i < groupIdx; i++) {
    // A tool_result never renders standalone (BlockRenderer returns null for
    // it), so passing one through here would render an empty transcript row.
    // Reachable: the ask_user filter above drops the tool_call but keeps its
    // result, so when the ask was the turn's first process-eligible block
    // (no earlier narration or call) its orphaned result precedes groupIdx.
    if (exchange[i]!.kind === "tool_result") continue;
    items.push({ kind: "block", block: exchange[i]! });
  }
  // While the turn is still generating, the group renders expanded (each tool
  // call shown as it lands); it collapses to the one-line summary once the turn
  // settles. The file-artifact card below shares this completeness check.
  const complete = isExchangeComplete(exchange, terminalTaskIds);
  items.push({ kind: "tool_group", id: `group-${calls[0]!.id}`, calls, steps, inProgress: !complete });
  for (let i = groupIdx + 1; i < exchange.length; i++) {
    const b = exchange[i]!;
    if (b.kind === "tool_call" || b.kind === "tool_result") continue;
    if (b.kind === "assistant_text" && i !== finalAnswerIdx) continue;
    items.push({ kind: "block", block: b, ...(i === finalAnswerIdx ? { isFinalAnswer: true } : {}) });
  }
  // Once the turn settles, group every successfully generated file into one
  // always-visible card so the user can open them directly instead of digging
  // through the collapsed tool group. Dedupe by path, keeping the last write's
  // toolName. The card is pushed after the trailing blocks (assistant_text) so
  // it renders below the agent's reply rather than above it. Skipped while the
  // turn is still in flight — a mid-stream write isn't a final artifact yet.
  if (complete) {
    const filesByPath = new Map<string, string>();
    for (const call of calls) {
      if (call.toolName !== "file_write" && call.toolName !== "file_patch") continue;
      if (call.status !== "ok") continue;
      const path = String(call.argsFull?.path ?? call.argsPreview ?? "").trim();
      if (!path) continue;
      filesByPath.set(path, call.toolName);
    }
    if (filesByPath.size > 0) {
      const files = Array.from(filesByPath, ([path, toolName]) => ({ path, toolName }));
      items.push({ kind: "file_artifact", id: `files-${calls[0]!.id}`, files });
    }
  }
}

function isExchangeComplete(exchange: ChatBlock[], terminalTaskIds: ReadonlySet<string>): boolean {
  // A terminal run (carries a "Completed" phase, dropped before grouping) is
  // complete even when it stopped on a tool call with no closing answer, so
  // fold it instead of dumping every block inline as if it were in-flight.
  const taskId = exchange.find((b) => b.taskId !== undefined)?.taskId;
  if (taskId !== undefined && terminalTaskIds.has(taskId)) return true;
  for (let i = exchange.length - 1; i >= 0; i--) {
    const b = exchange[i]!;
    if (b.kind === "phase" || b.kind === "tool_result" || b.kind === "system_note") continue;
    if (b.kind === "assistant_text") return !b.streaming;
    return false;
  }
  return false;
}

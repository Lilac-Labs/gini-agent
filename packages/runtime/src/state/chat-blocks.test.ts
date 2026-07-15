// Unit tests for the chat block persistence layer.
//
// Pins:
//   - ordinal allocation is per-session and monotonically increasing
//   - inserts and upserts fire the subscriber AFTER the SQLite commit
//   - assistant_text upserts replace text without changing ordinal
//   - tool_call upserts look up by callId + session and flip status
//   - listChatBlocksAfter respects the cursor, falls back to full list
//     when the cursor is unknown
//   - delete cascade clears the rows
//   - subscribers are isolated per (instance, sessionId)

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  closeAllMemoryDbs,
  deleteChatBlocksForSession,
  getMemoryDb,
  insertChatBlock,
  latestAssistantTextForSession,
  latestAssistantTextForThread,
  listChatBlocks,
  listChatBlocksAfter,
  listThreadBlocks,
  subscribeChatBlocks,
  summarizeThreads,
  summarizeThreadsForInstance,
  updateToolCallBlock,
  upsertAssistantTextBlock
} from "./index";
import { getMainChatUserTextBlockForTask, listMainChatBlocks } from "./chat-blocks";
import type { ChatBlock } from "../types";

const ROOT = "/tmp/gini-chat-blocks-test";

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  process.env.GINI_STATE_ROOT = ROOT;
  process.env.GINI_LOG_ROOT = `${ROOT}-logs`;
});

afterAll(() => {
  closeAllMemoryDbs();
  rmSync(ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  // Each test uses its own instance name, but defensively reset the
  // module-level emitter listeners by closing the DB so nothing
  // accumulates across describe blocks if a previous failure left a
  // subscriber attached.
  closeAllMemoryDbs();
});

describe("chat-blocks persistence", () => {
  test("allocates ordinals per session in monotonic order", () => {
    const instance = "chat-blocks-ordinals";
    // Insert two blocks in session A and one in session B, interleaved.
    const a1 = insertChatBlock(instance, {
      kind: "user_text",
      sessionId: "chat_a",
      text: "hello"
    });
    const b1 = insertChatBlock(instance, {
      kind: "user_text",
      sessionId: "chat_b",
      text: "ello"
    });
    const a2 = insertChatBlock(instance, {
      kind: "assistant_text",
      sessionId: "chat_a",
      text: "Hi",
      streaming: true
    });
    const a3 = insertChatBlock(instance, {
      kind: "phase",
      sessionId: "chat_a",
      label: "Working: file_read"
    });

    expect(a1.ordinal).toBe(1);
    expect(a2.ordinal).toBe(2);
    expect(a3.ordinal).toBe(3);
    // Session B's ordinal stream is independent — also starts at 1.
    expect(b1.ordinal).toBe(1);

    const listed = listChatBlocks(instance, "chat_a");
    expect(listed.map((b) => b.ordinal)).toEqual([1, 2, 3]);
    expect(listed.map((b) => b.kind)).toEqual(["user_text", "assistant_text", "phase"]);
  });

  test("upsertAssistantTextBlock updates text without re-allocating ordinal", () => {
    const instance = "chat-blocks-assistant";
    const initial = insertChatBlock(instance, {
      kind: "assistant_text",
      sessionId: "chat_x",
      text: "Hi",
      streaming: true
    });
    const after = insertChatBlock(instance, {
      kind: "phase",
      sessionId: "chat_x",
      label: "Completed"
    });
    expect(after.ordinal).toBe(2);

    const updated = upsertAssistantTextBlock(instance, initial.id, {
      text: "Hi there",
      streaming: true
    });
    expect(updated?.kind).toBe("assistant_text");
    if (updated?.kind === "assistant_text") {
      expect(updated.text).toBe("Hi there");
      expect(updated.streaming).toBe(true);
      expect(updated.ordinal).toBe(1);
    }

    // Final flip to streaming=false. Ordinal still pinned.
    const finalized = upsertAssistantTextBlock(instance, initial.id, {
      text: "Hi there, friend",
      streaming: false
    });
    expect(finalized?.kind).toBe("assistant_text");
    if (finalized?.kind === "assistant_text") {
      expect(finalized.text).toBe("Hi there, friend");
      expect(finalized.streaming).toBe(false);
      expect(finalized.ordinal).toBe(1);
    }
    // The phase block stays at ordinal 2 — order is preserved across the
    // upserts so a reconnecting client still sees text streaming before
    // the phase that followed.
    const listed = listChatBlocks(instance, "chat_x");
    expect(listed[0]?.ordinal).toBe(1);
    expect(listed[0]?.kind).toBe("assistant_text");
    expect(listed[1]?.ordinal).toBe(2);
    expect(listed[1]?.kind).toBe("phase");
  });

  test("updateToolCallBlock flips status by callId within session", () => {
    const instance = "chat-blocks-toolcall";
    insertChatBlock(instance, {
      kind: "tool_call",
      sessionId: "chat_t",
      toolName: "file_read",
      displayLabel: "Read file",
      argsPreview: "hello.md",
      argsFull: { path: "hello.md" },
      status: "running",
      callId: "call_1"
    });
    // Parallel fan-out — two distinct callIds.
    insertChatBlock(instance, {
      kind: "tool_call",
      sessionId: "chat_t",
      toolName: "file_list",
      displayLabel: "List files",
      argsPreview: ".",
      argsFull: { path: "." },
      status: "running",
      callId: "call_2"
    });

    const ok = updateToolCallBlock(instance, "call_1", "chat_t", { status: "ok" });
    expect(ok?.kind).toBe("tool_call");
    if (ok?.kind === "tool_call") expect(ok.status).toBe("ok");

    // Other call left untouched.
    const listed = listChatBlocks(instance, "chat_t");
    const call2 = listed.find(
      (b): b is ChatBlock & { kind: "tool_call" } =>
        b.kind === "tool_call" && b.callId === "call_2"
    );
    expect(call2?.status).toBe("running");

    // Error path stamps message.
    const err = updateToolCallBlock(instance, "call_2", "chat_t", {
      status: "error",
      errorMessage: "boom"
    });
    expect(err?.kind).toBe("tool_call");
    if (err?.kind === "tool_call") {
      expect(err.status).toBe("error");
      expect(err.errorMessage).toBe("boom");
    }
  });

  test("updateToolCallBlock stamps jobId on the ok flip and it survives rehydrate", () => {
    const instance = "chat-blocks-toolcall-jobid";
    // A create_job call that succeeded: the loop flips it `ok` with the new
    // job's structured id (the routine card's click target). A second call
    // that failed flips `error` with no jobId — the field must stay absent.
    insertChatBlock(instance, {
      kind: "tool_call",
      sessionId: "chat_j",
      toolName: "create_job",
      displayLabel: "Create scheduled job",
      argsPreview: "morning-brief",
      argsFull: { name: "morning-brief" },
      status: "running",
      callId: "call_job_ok"
    });
    insertChatBlock(instance, {
      kind: "tool_call",
      sessionId: "chat_j",
      toolName: "create_job",
      displayLabel: "Create scheduled job",
      argsPreview: "broken-brief",
      argsFull: { name: "broken-brief" },
      status: "running",
      callId: "call_job_err"
    });

    const ok = updateToolCallBlock(instance, "call_job_ok", "chat_j", { status: "ok", jobId: "job_abc123" });
    expect(ok?.kind === "tool_call" && ok.jobId).toBe("job_abc123");
    updateToolCallBlock(instance, "call_job_err", "chat_j", { status: "error", errorMessage: "boom" });

    // Rehydrated from the SQLite rows, not the in-memory return values.
    const listed = listChatBlocks(instance, "chat_j");
    const okRow = listed.find((b) => b.kind === "tool_call" && b.callId === "call_job_ok");
    const errRow = listed.find((b) => b.kind === "tool_call" && b.callId === "call_job_err");
    expect(okRow?.kind === "tool_call" && okRow.jobId).toBe("job_abc123");
    expect(okRow?.kind === "tool_call" && okRow.status).toBe("ok");
    expect(errRow?.kind === "tool_call" && errRow.jobId).toBeUndefined();
  });

  test("updateToolCallBlock with taskId scopes to the owning turn — a stale settle can't hit a newer same-callId row", () => {
    const instance = "chat-blocks-toolcall-taskscope";
    // callId is NOT unique across turns: the codex text-backstop synthesizes a
    // deterministic content-derived id, so the SAME gated call re-emitted in a
    // later turn carries the SAME callId. Two tool_call blocks, same session,
    // same callId, DIFFERENT task_ids — turn 2's is higher-ordinal (latest).
    insertChatBlock(instance, {
      kind: "tool_call",
      sessionId: "chat_ts",
      taskId: "task_1",
      toolName: "terminal_exec",
      displayLabel: "Run shell command",
      argsPreview: "echo hi",
      argsFull: { command: "echo hi" },
      status: "running",
      callId: "call_dup"
    });
    insertChatBlock(instance, {
      kind: "tool_call",
      sessionId: "chat_ts",
      taskId: "task_2",
      toolName: "terminal_exec",
      displayLabel: "Run shell command",
      argsPreview: "echo hi",
      argsFull: { command: "echo hi" },
      status: "running",
      callId: "call_dup"
    });

    // A LATE settle for turn 1 (e.g. an approved action aborted by cancel)
    // scoped to task_1 must touch ONLY turn 1's row, even though turn 2's row
    // is the latest-ordinal match for (session, callId).
    const settled = updateToolCallBlock(instance, "call_dup", "chat_ts", { status: "denied" }, "task_1");
    expect(settled?.kind === "tool_call" && settled.status).toBe("denied");
    expect(settled?.kind === "tool_call" && settled.taskId).toBe("task_1");

    const blocks = listChatBlocks(instance, "chat_ts");
    const turn1 = blocks.find((b) => b.kind === "tool_call" && b.taskId === "task_1");
    const turn2 = blocks.find((b) => b.kind === "tool_call" && b.taskId === "task_2");
    // Turn 1 settled; turn 2 (the newer, latest-ordinal row) is untouched.
    expect(turn1?.kind === "tool_call" && turn1.status).toBe("denied");
    expect(turn2?.kind === "tool_call" && turn2.status).toBe("running");

    // Without the taskId scope, the legacy lookup hits the latest-ordinal row
    // (turn 2) — the exact cross-turn clobber the scope prevents.
    const legacy = updateToolCallBlock(instance, "call_dup", "chat_ts", { status: "ok" });
    expect(legacy?.kind === "tool_call" && legacy.taskId).toBe("task_2");
  });

  test("listChatBlocksAfter honors cursor and falls back when unknown", () => {
    const instance = "chat-blocks-cursor";
    const a = insertChatBlock(instance, {
      kind: "user_text",
      sessionId: "chat_c",
      text: "hi"
    });
    const b = insertChatBlock(instance, {
      kind: "phase",
      sessionId: "chat_c",
      label: "Thinking"
    });
    const c = insertChatBlock(instance, {
      kind: "system_note",
      sessionId: "chat_c",
      text: "tick"
    });

    // Cursor format: `<id>:<ts>`. Use each block's createdAt as the
    // client snapshot — for insert-only kinds it equals updated_at.
    // The resume query returns blocks at-or-after the snapshot ordinal
    // *or* timestamp; the cursor itself replays via the >= comparison
    // (the mobile client's id-keyed upsert collapses it).
    const afterA = listChatBlocksAfter(
      instance,
      "chat_c",
      `${a.id}:${a.createdAt}`
    );
    expect(afterA.map((row) => row.id)).toEqual([a.id, b.id, c.id]);

    // Cursor pinned at the tail with a far-future timestamp: ordinal
    // branch never matches (no later rows) and the timestamp branch
    // never matches (all rows are older than the snapshot). Result is
    // empty. We pin an explicit timestamp rather than using c.createdAt
    // because the three inserts above land in the same millisecond, so
    // their updated_at strings tie and the >= comparison would include
    // every row.
    const afterTail = listChatBlocksAfter(
      instance,
      "chat_c",
      `${c.id}:2099-01-01T00:00:00.000Z`
    );
    expect(afterTail).toHaveLength(0);

    // Unknown cursor: best-effort fall back to the full session list.
    const afterUnknown = listChatBlocksAfter(
      instance,
      "chat_c",
      "block_does_not_exist:2099-01-01T00:00:00.000Z"
    );
    expect(afterUnknown.map((row) => row.id)).toEqual([a.id, b.id, c.id]);

    // Null cursor (initial subscribe): equivalent to listChatBlocks.
    const afterNull = listChatBlocksAfter(instance, "chat_c", null);
    expect(afterNull.map((row) => row.id)).toEqual([a.id, b.id, c.id]);

    // Legacy client (no `:<ts>` suffix): falls back to comparing against
    // the cursor row's current updated_at. Same `>=` semantics so the
    // cursor still replays, but in-place updates to the cursor row
    // itself are missed — kept for back-compat with shipped clients.
    const afterALegacy = listChatBlocksAfter(instance, "chat_c", a.id);
    expect(afterALegacy.map((row) => row.id)).toEqual([a.id, b.id, c.id]);
  });

  test("listChatBlocksAfter bare-id fallback uses the cursor row's current updated_at", () => {
    // Pins the back-compat path: an old client without the `:<ts>`
    // suffix on its Last-Event-ID. The fallback reads the cursor row's
    // CURRENT `updated_at` as `client_ts`, then applies the same
    // `(ordinal > cursor.ordinal OR updated_at >= client_ts)` filter.
    //
    // What this test proves (i.e. what a regression must NOT break):
    //   1. A bare id (no suffix) is parsed without throwing.
    //   2. The cursor row replays with its CURRENT payload — even though
    //      that payload was upserted between insert and resume.
    //   3. Earlier-ordinal rows whose updated_at is older than the
    //      cursor's current updated_at are NOT replayed (the fallback
    //      has no way to recover them — only the suffixed cursor form
    //      preserves the client's snapshot ts).
    const instance = "chat-blocks-legacy-fallback";
    // A: an assistant_text we'll upsert later, advancing its updated_at.
    const a = insertChatBlock(instance, {
      kind: "assistant_text",
      sessionId: "chat_l",
      text: "Hi",
      streaming: true
    });
    // B: a later-ordinal phase. Force B's updated_at to a known-old
    // timestamp so we can prove the fallback's `>=` comparison excludes
    // it via the timestamp branch while the ordinal branch still picks
    // it up.
    const b = insertChatBlock(instance, {
      kind: "phase",
      sessionId: "chat_l",
      label: "Thinking"
    });
    const db = getMemoryDb(instance);
    const tsOld = "2000-01-01T00:00:00.000Z";
    db.run("UPDATE chat_blocks SET updated_at = ? WHERE id = ?", [tsOld, b.id]);

    // Mutate A in place. `upsertAssistantTextBlock` stamps a fresh
    // `updated_at` via `now()`, which is much newer than tsOld.
    const upserted = upsertAssistantTextBlock(instance, a.id, {
      text: "Hi there, friend",
      streaming: false
    });
    expect(upserted?.kind).toBe("assistant_text");

    // Resume with the BARE id of A (no `:<ts>` suffix). The fallback
    // reads A's current updated_at as the cutoff.
    const replay = listChatBlocksAfter(instance, "chat_l", a.id);
    const ids = replay.map((row) => row.id);
    // A replays via the `updated_at >= cutoff.updated_at` branch
    // (it's the same row — equal updated_at).
    expect(ids).toContain(a.id);
    // B replays via the `ordinal > cursor.ordinal` branch even though
    // its updated_at is older than the cutoff. This proves both halves
    // of the WHERE clause survive the bare-id path.
    expect(ids).toContain(b.id);

    // The cursor row's payload that replays is the UPSERTED text, not
    // the pre-upsert text — proves we read the current row, not a
    // cached snapshot.
    const replayedA = replay.find((row) => row.id === a.id);
    if (replayedA?.kind === "assistant_text") {
      expect(replayedA.text).toBe("Hi there, friend");
      expect(replayedA.streaming).toBe(false);
    }
  });

  test("listChatBlocksAfter replays in-place updates after the cursor", () => {
    // A reconnecting client carries a Last-Event-ID equal to the wire
    // event id the SSE emitter sent: `<block_id>:<updated_at_snapshot>`.
    // The resume query splits the cursor, looks up the row by id, then
    // returns every row whose ordinal moved past the cursor OR whose
    // updated_at is at-or-after the client snapshot. This lets in-place
    // upserts to the cursor row itself (assistant_text delta on the
    // in-flight reply, tool_call status flip) replay on reconnect.
    const instance = "chat-blocks-resume-upserts";
    const stream = insertChatBlock(instance, {
      kind: "assistant_text",
      sessionId: "chat_r",
      text: "Hi",
      streaming: true
    });
    const streamTsOld =
      stream.kind === "assistant_text" ? stream.updatedAt : stream.createdAt;
    const call = insertChatBlock(instance, {
      kind: "tool_call",
      sessionId: "chat_r",
      toolName: "file_read",
      displayLabel: "Read file",
      argsPreview: "x.md",
      argsFull: { path: "x.md" },
      status: "running",
      callId: "call_resume"
    });
    const phase = insertChatBlock(instance, {
      kind: "phase",
      sessionId: "chat_r",
      label: "Working: file_read"
    });

    // Tool_call flips to ok in place — its updated_at moves forward.
    updateToolCallBlock(instance, "call_resume", "chat_r", { status: "ok" });

    // Resume from cursor=stream.id with the old ts snapshot. The cursor
    // row itself replays via the same-ms tie (updated_at >= streamTsOld);
    // the tool_call (ordinal 2) and phase (3) replay via the ordinal
    // branch. The mobile client's id-keyed upsert collapses any
    // re-replay of the unchanged cursor row.
    const replay = listChatBlocksAfter(
      instance,
      "chat_r",
      `${stream.id}:${streamTsOld}`
    );
    const replayedIds = replay.map((row) => row.id).sort();
    expect(replayedIds).toEqual([stream.id, call.id, phase.id].sort());

    const replayedCall = replay.find((row) => row.id === call.id);
    if (replayedCall?.kind === "tool_call") {
      expect(replayedCall.status).toBe("ok");
    }

    // Same shape for assistant_text deltas to an earlier-ordinal block.
    upsertAssistantTextBlock(instance, stream.id, {
      text: "Hi there",
      streaming: false
    });
    // New cursor = phase.id (latest ordinal) at phase's createdAt.
    // Earlier-ordinal blocks with newer updated_at must replay — both
    // the assistant_text upsert we just did and the still-newer tool_call
    // ok flip from earlier.
    const replay2 = listChatBlocksAfter(
      instance,
      "chat_r",
      `${phase.id}:${phase.createdAt}`
    );
    const ids2 = replay2.map((row) => row.id).sort();
    // Phase itself is included via the updated_at >= clientTs branch
    // (same-ms tie). Both upserted rows replay.
    expect(ids2).toEqual([stream.id, call.id, phase.id].sort());
    const text = replay2.find((row) => row.id === stream.id);
    if (text?.kind === "assistant_text") {
      expect(text.text).toBe("Hi there");
      expect(text.streaming).toBe(false);
    }
  });

  test("listChatBlocksAfter replays the cursor block when it was upserted in place", () => {
    // The canonical streaming case: cursor is the in-flight assistant_text
    // block, and while the client was offline the row was upserted with
    // new text (and eventually streaming:false). With the richer cursor
    // (`<id>:<ts_old>`) the row's current updated_at is > ts_old, so the
    // resume query returns the upserted block.
    //
    // The wire-format invariant we pin: the upserted text is what the
    // resuming client sees on the cursor row (not the pre-upsert text).
    // We deterministically pin timestamps via direct UPDATEs so the test
    // doesn't ride on `Date.now()` resolution.
    const instance = "chat-blocks-resume-cursor-self";
    const stream = insertChatBlock(instance, {
      kind: "assistant_text",
      sessionId: "chat_s",
      text: "Hi",
      streaming: true
    });

    // Force the row's updated_at to a known pre-upsert snapshot. We
    // pick a deliberately old timestamp so the in-place upsert below
    // (stamped with `now()`) lands strictly after it — regardless of
    // the system clock or per-test scheduling jitter.
    const tsOld = "2000-01-01T00:00:00.000Z";
    const db = getMemoryDb(instance);
    db.run("UPDATE chat_blocks SET updated_at = ? WHERE id = ?", [
      tsOld,
      stream.id
    ]);

    // In-place upsert. `upsertAssistantTextBlock` stamps updated_at via
    // `now()`, which will be much later than tsOld.
    const upserted = upsertAssistantTextBlock(instance, stream.id, {
      text: "Hi there, friend",
      streaming: false
    });
    expect(upserted?.kind).toBe("assistant_text");

    const replay = listChatBlocksAfter(
      instance,
      "chat_s",
      `${stream.id}:${tsOld}`
    );
    const replayedStream = replay.find((row) => row.id === stream.id);
    expect(replayedStream).toBeDefined();
    if (replayedStream?.kind === "assistant_text") {
      expect(replayedStream.text).toBe("Hi there, friend");
      expect(replayedStream.streaming).toBe(false);
    }
  });

  test("listChatBlocksAfter replays same-ms ties via >= comparison", () => {
    // Pins the `>=` half of the resume filter independently of the
    // `ordinal >` half. A regression to strict `>` on the timestamp
    // branch must be caught here.
    //
    // Construction: A (ordinal=1) and B (ordinal=2). Cursor is B at
    // timestamp `tiedAt`. We then force A's `updated_at` to equal
    // `tiedAt` — modeling the realistic case where an earlier-ordinal
    // row was upserted in the same millisecond as the cursor row was
    // snapshotted. With cursor=B, the `ordinal > 2` branch CANNOT match
    // A (A.ordinal=1), so the only way A appears in the replay is via
    // `updated_at >= tiedAt`. A strict `>` would drop A.
    const instance = "chat-blocks-resume-tie";
    const a = insertChatBlock(instance, {
      kind: "user_text",
      sessionId: "chat_t",
      text: "a"
    });
    const b = insertChatBlock(instance, {
      kind: "phase",
      sessionId: "chat_t",
      label: "Thinking"
    });
    const tiedAt = "2099-01-01T00:00:00.000Z";
    const db = getMemoryDb(instance);
    db.run(
      "UPDATE chat_blocks SET updated_at = ? WHERE session_id = ? AND id IN (?, ?)",
      [tiedAt, "chat_t", a.id, b.id]
    );

    // Cursor pins B at tiedAt. A has a LOWER ordinal than the cursor —
    // the only branch that can surface A is `updated_at >= tiedAt`.
    const replay = listChatBlocksAfter(
      instance,
      "chat_t",
      `${b.id}:${tiedAt}`
    );
    const ids = replay.map((row) => row.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
  });

  test("subscribers fire on insert and upsert, then stop after unsubscribe", () => {
    const instance = "chat-blocks-subscribe";
    const events: ChatBlock[] = [];
    const unsubscribe = subscribeChatBlocks(instance, "chat_sub", (block) => {
      events.push(block);
    });

    const first = insertChatBlock(instance, {
      kind: "user_text",
      sessionId: "chat_sub",
      text: "first"
    });
    const stream = insertChatBlock(instance, {
      kind: "assistant_text",
      sessionId: "chat_sub",
      text: "",
      streaming: true
    });
    upsertAssistantTextBlock(instance, stream.id, { text: "ok", streaming: true });
    upsertAssistantTextBlock(instance, stream.id, { text: "ok!", streaming: false });

    expect(events).toHaveLength(4);
    expect(events[0]?.id).toBe(first.id);
    expect(events[1]?.kind).toBe("assistant_text");
    expect(events[2]?.kind).toBe("assistant_text");
    if (events[2]?.kind === "assistant_text") expect(events[2].text).toBe("ok");
    if (events[3]?.kind === "assistant_text") {
      expect(events[3].text).toBe("ok!");
      expect(events[3].streaming).toBe(false);
    }

    unsubscribe();
    insertChatBlock(instance, {
      kind: "system_note",
      sessionId: "chat_sub",
      text: "after unsubscribe"
    });
    expect(events).toHaveLength(4);
  });

  test("subscribers are isolated per (instance, sessionId)", () => {
    const instance = "chat-blocks-isolation";
    const aEvents: ChatBlock[] = [];
    const bEvents: ChatBlock[] = [];
    const unsubA = subscribeChatBlocks(instance, "chat_a", (block) => aEvents.push(block));
    const unsubB = subscribeChatBlocks(instance, "chat_b", (block) => bEvents.push(block));

    insertChatBlock(instance, {
      kind: "user_text",
      sessionId: "chat_a",
      text: "a"
    });
    insertChatBlock(instance, {
      kind: "user_text",
      sessionId: "chat_b",
      text: "b"
    });

    expect(aEvents).toHaveLength(1);
    expect(bEvents).toHaveLength(1);
    if (aEvents[0]?.kind === "user_text") expect(aEvents[0].text).toBe("a");
    if (bEvents[0]?.kind === "user_text") expect(bEvents[0].text).toBe("b");

    unsubA();
    unsubB();
  });

  test("deleteChatBlocksForSession removes only that session's rows", () => {
    const instance = "chat-blocks-delete";
    insertChatBlock(instance, { kind: "user_text", sessionId: "chat_d1", text: "1" });
    insertChatBlock(instance, { kind: "phase", sessionId: "chat_d1", label: "x" });
    insertChatBlock(instance, { kind: "user_text", sessionId: "chat_d2", text: "2" });

    expect(deleteChatBlocksForSession(instance, "chat_d1")).toBe(2);
    expect(listChatBlocks(instance, "chat_d1")).toHaveLength(0);
    expect(listChatBlocks(instance, "chat_d2")).toHaveLength(1);

    // Idempotent: second delete returns zero, listChatBlocks still empty.
    expect(deleteChatBlocksForSession(instance, "chat_d1")).toBe(0);
  });

  test("latestAssistantTextForSession returns the newest non-empty assistant reply", () => {
    const instance = "chat-blocks-latest-assistant";
    const sessionId = "chat_latest";
    insertChatBlock(instance, { kind: "user_text", sessionId, text: "first question" });
    insertChatBlock(instance, { kind: "assistant_text", sessionId, text: "first answer", streaming: false });
    insertChatBlock(instance, { kind: "user_text", sessionId, text: "second question" });
    insertChatBlock(instance, { kind: "assistant_text", sessionId, text: "second answer", streaming: false });
    // Newest assistant_text by ordinal wins — this is what makes a
    // collapsed notification track the last message across turns.
    expect(latestAssistantTextForSession(instance, sessionId)).toBe("second answer");
  });

  test("latestAssistantTextForSession skips whitespace-only blocks and tool calls", () => {
    const instance = "chat-blocks-latest-skip";
    const sessionId = "chat_skip";
    insertChatBlock(instance, { kind: "assistant_text", sessionId, text: "real answer", streaming: false });
    // A later assistant_text that is whitespace-only must NOT shadow the
    // real one — the lookup keeps scanning to an older non-empty block.
    insertChatBlock(instance, { kind: "assistant_text", sessionId, text: "   ", streaming: false });
    // A tool_call after it is ignored entirely (wrong kind).
    insertChatBlock(instance, {
      kind: "tool_call",
      sessionId,
      toolName: "file_read",
      displayLabel: "Read file",
      argsPreview: "x.md",
      argsFull: { path: "x.md" },
      status: "ok",
      callId: "call_skip"
    });
    expect(latestAssistantTextForSession(instance, sessionId)).toBe("real answer");
  });

  test("latestAssistantTextForSession ignores threaded assistant replies", () => {
    const instance = "chat-blocks-latest-thread";
    const sessionId = "chat_thread_latest";
    const root = insertChatBlock(instance, {
      kind: "assistant_text",
      sessionId,
      text: "main chat answer",
      streaming: false
    });
    // A threaded reply added later must not leak into the main-chat
    // preview — the notification deep-links to the main chat.
    insertChatBlock(instance, {
      kind: "assistant_text",
      sessionId,
      text: "threaded reply",
      streaming: false,
      threadId: "thread_1",
      parentBlockId: root.id
    });
    expect(latestAssistantTextForSession(instance, sessionId)).toBe("main chat answer");
  });

  test("latestAssistantTextForSession returns null when the session has no assistant text", () => {
    const instance = "chat-blocks-latest-empty";
    const sessionId = "chat_empty";
    insertChatBlock(instance, { kind: "user_text", sessionId, text: "only a question" });
    expect(latestAssistantTextForSession(instance, sessionId)).toBeNull();
    // And null for a session that doesn't exist at all.
    expect(latestAssistantTextForSession(instance, "chat_nonexistent")).toBeNull();
  });

  test("latestAssistantTextForSession ignores a newer in-flight (streaming) reply", () => {
    const instance = "chat-blocks-latest-streaming";
    const sessionId = "chat_streaming";
    // Turn N: a finalized reply.
    insertChatBlock(instance, { kind: "assistant_text", sessionId, text: "completed turn", streaming: false });
    // Turn N+1: already mid-stream when the NSE fetches the preview for
    // turn N's completion push. Its partial text must NOT shadow the
    // finalized turn — the banner would otherwise show a half-streamed
    // fragment of a different turn under the older turn's "new message".
    insertChatBlock(instance, { kind: "assistant_text", sessionId, text: "partial in-flight", streaming: true });
    expect(latestAssistantTextForSession(instance, sessionId)).toBe("completed turn");
  });

  test("latestAssistantTextForSession returns null when the only reply is still streaming", () => {
    const instance = "chat-blocks-latest-only-streaming";
    const sessionId = "chat_only_streaming";
    insertChatBlock(instance, { kind: "assistant_text", sessionId, text: "still typing", streaming: true });
    // No finalized reply yet → no preview (the generic banner stands until
    // the turn completes and its own push lands).
    expect(latestAssistantTextForSession(instance, sessionId)).toBeNull();
  });

  test("latestAssistantTextForThread returns the thread's own finalized reply", () => {
    const instance = "chat-blocks-thread-latest";
    const sessionId = "chat_threaded";
    const root = insertChatBlock(instance, {
      kind: "assistant_text", sessionId, text: "main chat reply", streaming: false
    });
    insertChatBlock(instance, {
      kind: "assistant_text", sessionId, text: "thread reply one", streaming: false,
      threadId: "thread_1", parentBlockId: root.id
    });
    insertChatBlock(instance, {
      kind: "assistant_text", sessionId, text: "thread reply two", streaming: false,
      threadId: "thread_1", parentBlockId: root.id
    });
    // Newest reply WITHIN the thread — never the main-chat block.
    expect(latestAssistantTextForThread(instance, sessionId, "thread_1")).toBe("thread reply two");
    // And it doesn't bleed across threads.
    expect(latestAssistantTextForThread(instance, sessionId, "thread_other")).toBeNull();
  });

  test("latestAssistantTextForThread skips an in-flight streaming thread reply", () => {
    const instance = "chat-blocks-thread-streaming";
    const sessionId = "chat_threaded_stream";
    insertChatBlock(instance, {
      kind: "assistant_text", sessionId, text: "finalized thread reply", streaming: false,
      threadId: "thread_2"
    });
    insertChatBlock(instance, {
      kind: "assistant_text", sessionId, text: "partial", streaming: true,
      threadId: "thread_2"
    });
    expect(latestAssistantTextForThread(instance, sessionId, "thread_2")).toBe("finalized thread reply");
  });

  test("rows persist taskId, runId, and agentId for indexable joins", () => {
    const instance = "chat-blocks-metadata";
    insertChatBlock(instance, {
      kind: "tool_call",
      sessionId: "chat_meta",
      toolName: "file_read",
      displayLabel: "Read file",
      argsPreview: "hello.md",
      argsFull: { path: "hello.md" },
      status: "running",
      callId: "call_meta",
      taskId: "task_meta",
      runId: "run_meta",
      agentId: "agent_meta"
    });

    // Verify the columns are persisted (we expose them via the
    // re-assembled block + the agent_id column directly on the row).
    const block = listChatBlocks(instance, "chat_meta")[0];
    expect(block?.taskId).toBe("task_meta");
    expect(block?.runId).toBe("run_meta");

    const db = getMemoryDb(instance);
    const row = db
      .query<{ agent_id: string | null; task_id: string | null; run_id: string | null }, [string]>(
        "SELECT agent_id, task_id, run_id FROM chat_blocks WHERE id = ?"
      )
      .get(block!.id);
    expect(row?.agent_id).toBe("agent_meta");
    expect(row?.task_id).toBe("task_meta");
    expect(row?.run_id).toBe("run_meta");
  });

  test("getMainChatUserTextBlockForTask returns the task's main-chat user message, ignoring threaded and other-task rows", () => {
    const instance = "chat-blocks-user-anchor";
    const sessionId = "chat_anchor";
    // A user message for the target turn, plus noise: an assistant reply, a
    // user message from a different task, and a threaded user message.
    const target = insertChatBlock(instance, {
      kind: "user_text",
      sessionId,
      text: "research this",
      taskId: "task_target"
    });
    insertChatBlock(instance, {
      kind: "assistant_text",
      sessionId,
      text: "an earlier answer",
      taskId: "task_prior",
      streaming: false
    });
    insertChatBlock(instance, {
      kind: "user_text",
      sessionId,
      text: "different turn",
      taskId: "task_other"
    });
    insertChatBlock(instance, {
      kind: "user_text",
      sessionId,
      text: "threaded reply",
      taskId: "task_target",
      threadId: "thread_x",
      parentBlockId: target.id
    });

    const found = getMainChatUserTextBlockForTask(instance, sessionId, "task_target");
    expect(found?.id).toBe(target.id);

    // No user message for the task → undefined, so an agent turn for that
    // task does not thread (it stays in the channel/main timeline).
    expect(getMainChatUserTextBlockForTask(instance, sessionId, "task_prior")).toBeUndefined();
  });

  test("system_note round-trips authError metadata; plain notes omit it", () => {
    const instance = "chat-blocks-autherror";

    insertChatBlock(instance, {
      kind: "system_note",
      sessionId: "chat_auth",
      text: "Codex authentication failed. Re-authenticate Codex to continue.",
      authError: {
        provider: "codex",
        providerLabel: "Codex",
        detail: "Provided authentication token is expired. Please try signing in again.",
        reauthKind: "docs",
        reauthUrl: "https://gini.lilaclabs.ai/docs/providers/codex#re-authentication"
      }
    });
    insertChatBlock(instance, {
      kind: "system_note",
      sessionId: "chat_auth",
      text: "Cancelled"
    });

    const [authNote, plainNote] = listChatBlocks(instance, "chat_auth");
    if (authNote?.kind !== "system_note" || plainNote?.kind !== "system_note") {
      throw new Error("expected two system_note blocks");
    }
    expect(authNote.authError).toEqual({
      provider: "codex",
      providerLabel: "Codex",
      detail: "Provided authentication token is expired. Please try signing in again.",
      reauthKind: "docs",
      reauthUrl: "https://gini.lilaclabs.ai/docs/providers/codex#re-authentication"
    });
    expect(plainNote.authError).toBeUndefined();
  });

  test("system_note round-trips cta metadata; a half-formed cta is dropped on read", () => {
    const instance = "chat-blocks-cta";

    insertChatBlock(instance, {
      kind: "system_note",
      sessionId: "chat_cta",
      text: "Google sign-in for me@gmail.com needs to be reconnected.",
      cta: { href: "/integrations", label: "Reconnect Google account" }
    });
    const malformed = insertChatBlock(instance, {
      kind: "system_note",
      sessionId: "chat_cta",
      text: "note with a broken cta"
    });
    // Rewrite to a label-less cta payload (hand-edited / truncated row): the
    // read normalizer must drop it rather than surface a dead button.
    getMemoryDb(instance).run("UPDATE chat_blocks SET payload_json = ? WHERE id = ?", [
      JSON.stringify({ text: "note with a broken cta", cta: { href: "/integrations" } }),
      malformed.id
    ]);

    const [ctaNote, brokenNote] = listChatBlocks(instance, "chat_cta");
    if (ctaNote?.kind !== "system_note" || brokenNote?.kind !== "system_note") {
      throw new Error("expected two system_note blocks");
    }
    expect(ctaNote.cta).toEqual({ href: "/integrations", label: "Reconnect Google account" });
    expect(ctaNote.authError).toBeUndefined();
    expect(brokenNote.cta).toBeUndefined();
  });

  test("system_note preserves the aws reauthKind through the read normalizer", () => {
    const instance = "chat-blocks-autherror-aws";
    insertChatBlock(instance, {
      kind: "system_note",
      sessionId: "chat_aws",
      text: "Amazon Bedrock authentication failed. Open Bedrock settings to continue.",
      authError: {
        provider: "bedrock",
        providerLabel: "Amazon Bedrock",
        detail: "The security token included in the request is invalid.",
        reauthKind: "aws",
        reauthUrl: "/settings"
      }
    });

    const note = listChatBlocks(instance, "chat_aws")[0];
    if (note?.kind !== "system_note") throw new Error("expected a system_note block");
    // "aws" must survive — collapsing it to "settings" makes the renderer tell
    // the user to update a Bedrock API key that AWS SigV4 auth never has.
    expect(note.authError?.reauthKind).toBe("aws");
  });

  test("rowToBlock backfills routing fields for a legacy authError row", () => {
    const instance = "chat-blocks-autherror-legacy";
    const inserted = insertChatBlock(instance, {
      kind: "system_note",
      sessionId: "chat_legacy",
      text: "Codex authentication failed. Re-authenticate Codex to continue.",
      authError: {
        provider: "codex",
        providerLabel: "Codex",
        detail: "token expired",
        reauthKind: "docs",
        reauthUrl: "https://gini.lilaclabs.ai/docs/providers/codex#re-authentication"
      }
    });
    // Rewrite the payload to a pre-routing-fields shape (no reauthKind/reauthUrl)
    // to simulate a row written by an older build.
    getMemoryDb(instance).run("UPDATE chat_blocks SET payload_json = ? WHERE id = ?", [
      JSON.stringify({
        text: "Codex authentication failed. Re-authenticate Codex to continue.",
        authError: { provider: "codex", providerLabel: "Codex", detail: "token expired" }
      }),
      inserted.id
    ]);

    const note = listChatBlocks(instance, "chat_legacy")[0];
    if (note?.kind !== "system_note") throw new Error("expected a system_note block");
    expect(note.authError).toEqual({
      provider: "codex",
      providerLabel: "Codex",
      detail: "token expired",
      reauthKind: "settings",
      reauthUrl: "/settings"
    });
  });

  test("user_text inbound images round-trip and rowToBlock drops malformed entries", () => {
    const instance = "chat-blocks-usertext-images";
    const inserted = insertChatBlock(instance, {
      kind: "user_text",
      sessionId: "chat_ui",
      text: "look at these",
      images: [{ id: "up_ok", mimeType: "image/png", size: 10 }]
    });
    const block = listChatBlocks(instance, "chat_ui")[0];
    if (block?.kind !== "user_text") throw new Error("expected a user_text block");
    expect(block.images).toEqual([{ id: "up_ok", mimeType: "image/png", size: 10 }]);

    // A hand-edited payload with one valid entry, one empty-id, one non-object:
    // only the valid entry survives.
    getMemoryDb(instance).run("UPDATE chat_blocks SET payload_json = ? WHERE id = ?", [
      JSON.stringify({
        text: "look at these",
        images: [{ id: "", mimeType: "image/png", size: 1 }, "nope", { id: "up_keep", mimeType: "image/jpeg", size: 5 }]
      }),
      inserted.id
    ]);
    const edited = listChatBlocks(instance, "chat_ui")[0];
    if (edited?.kind !== "user_text") throw new Error("expected a user_text block");
    expect(edited.images).toEqual([{ id: "up_keep", mimeType: "image/jpeg", size: 5 }]);

    // An all-bad array yields no images field at all.
    getMemoryDb(instance).run("UPDATE chat_blocks SET payload_json = ? WHERE id = ?", [
      JSON.stringify({ text: "x", images: [{ id: "" }, 7] }),
      inserted.id
    ]);
    const edited2 = listChatBlocks(instance, "chat_ui")[0];
    if (edited2?.kind !== "user_text") throw new Error("expected a user_text block");
    expect(edited2.images).toBeUndefined();
  });

});

describe("chat-blocks threading", () => {
  test("thread_id and parent_block_id round-trip through insert → list", () => {
    const instance = "chat-blocks-thread-roundtrip";
    const inserted = insertChatBlock(instance, {
      kind: "assistant_text",
      sessionId: "chat_th",
      text: "thread reply",
      streaming: false,
      threadId: "thread_1",
      parentBlockId: "block_root"
    });
    expect(inserted.threadId).toBe("thread_1");
    expect(inserted.parentBlockId).toBe("block_root");

    const [block] = listChatBlocks(instance, "chat_th");
    expect(block?.threadId).toBe("thread_1");
    expect(block?.parentBlockId).toBe("block_root");

    // Columns are persisted (not just round-tripped through the payload).
    const db = getMemoryDb(instance);
    const row = db
      .query<{ thread_id: string | null; parent_block_id: string | null }, [string]>(
        "SELECT thread_id, parent_block_id FROM chat_blocks WHERE id = ?"
      )
      .get(inserted.id);
    expect(row?.thread_id).toBe("thread_1");
    expect(row?.parent_block_id).toBe("block_root");
  });

  test("main-chat blocks omit thread fields", () => {
    const instance = "chat-blocks-thread-omit";
    const inserted = insertChatBlock(instance, {
      kind: "user_text",
      sessionId: "chat_main",
      text: "no thread"
    });
    expect(inserted.threadId).toBeUndefined();
    expect(inserted.parentBlockId).toBeUndefined();
    const [block] = listChatBlocks(instance, "chat_main");
    expect(block?.threadId).toBeUndefined();
    expect(block?.parentBlockId).toBeUndefined();
  });

  test("upsertAssistantTextBlock preserves thread fields across deltas", () => {
    const instance = "chat-blocks-thread-upsert";
    const initial = insertChatBlock(instance, {
      kind: "assistant_text",
      sessionId: "chat_up",
      text: "",
      streaming: true,
      threadId: "thread_u",
      parentBlockId: "block_pu"
    });
    const updated = upsertAssistantTextBlock(instance, initial.id, {
      text: "growing reply",
      streaming: false
    });
    expect(updated?.threadId).toBe("thread_u");
    expect(updated?.parentBlockId).toBe("block_pu");
  });

  test("updateToolCallBlock preserves thread fields across status flips", () => {
    const instance = "chat-blocks-thread-toolcall";
    insertChatBlock(instance, {
      kind: "tool_call",
      sessionId: "chat_tc",
      toolName: "file_read",
      displayLabel: "Read file",
      argsPreview: "x.md",
      argsFull: { path: "x.md" },
      status: "running",
      callId: "call_th",
      threadId: "thread_tc",
      parentBlockId: "block_tc"
    });
    const flipped = updateToolCallBlock(instance, "call_th", "chat_tc", { status: "ok" });
    expect(flipped?.threadId).toBe("thread_tc");
    expect(flipped?.parentBlockId).toBe("block_tc");
  });

  test("listThreadBlocks and listMainChatBlocks split the interleaved stream", () => {
    const instance = "chat-blocks-thread-split";
    const session = "chat_split";
    // Interleave main-chat and thread blocks in one ordinal stream.
    const m1 = insertChatBlock(instance, { kind: "user_text", sessionId: session, text: "main 1" });
    const t1 = insertChatBlock(instance, {
      kind: "assistant_text",
      sessionId: session,
      text: "thread 1",
      streaming: false,
      threadId: "thread_x",
      parentBlockId: m1.id
    });
    const m2 = insertChatBlock(instance, { kind: "assistant_text", sessionId: session, text: "main 2", streaming: false });
    const t2 = insertChatBlock(instance, {
      kind: "user_text",
      sessionId: session,
      text: "thread 2",
      threadId: "thread_x",
      parentBlockId: m1.id
    });

    const threadBlocks = listThreadBlocks(instance, session, "thread_x");
    expect(threadBlocks.map((b) => b.id)).toEqual([t1.id, t2.id]);

    const mainBlocks = listMainChatBlocks(instance, session);
    expect(mainBlocks.map((b) => b.id)).toEqual([m1.id, m2.id]);

    // Raw list still carries everything in ordinal order.
    expect(listChatBlocks(instance, session).map((b) => b.ordinal)).toEqual([1, 2, 3, 4]);
  });

  test("summarizeThreads returns one row per thread with counts and previews", () => {
    const instance = "chat-blocks-thread-summary";
    const session = "chat_sum";
    const root = insertChatBlock(instance, {
      kind: "assistant_text",
      sessionId: session,
      text: "Here is a research plan you can branch on.",
      streaming: false
    });
    // Thread A: two replies.
    insertChatBlock(instance, {
      kind: "user_text",
      sessionId: session,
      text: "Follow up on step one",
      threadId: "thread_a",
      parentBlockId: root.id
    });
    insertChatBlock(instance, {
      kind: "assistant_text",
      sessionId: session,
      text: "Step one is done.",
      streaming: false,
      threadId: "thread_a",
      parentBlockId: root.id
    });
    // Thread B: one reply, rooted at the same parent.
    insertChatBlock(instance, {
      kind: "user_text",
      sessionId: session,
      text: "Different tangent",
      threadId: "thread_b",
      parentBlockId: root.id
    });

    const summaries = summarizeThreads(instance, session);
    expect(summaries).toHaveLength(2);
    const byId = new Map(summaries.map((s) => [s.threadId, s]));
    const a = byId.get("thread_a");
    const b = byId.get("thread_b");
    expect(a?.replyCount).toBe(2);
    expect(b?.replyCount).toBe(1);
    expect(a?.parentBlockId).toBe(root.id);
    expect(a?.rootPreview).toBe("Here is a research plan you can branch on.");
    // Rooted at an assistant_text block (user clicked "Reply in thread").
    expect(a?.rootAuthor).toBe("agent");
    expect(a?.lastReplyPreview).toBe("Step one is done.");
    expect(b?.lastReplyPreview).toBe("Different tangent");
    expect(a?.sessionId).toBe(session);
  });

  test("summarizeThreads reports rootAuthor 'user' for an agent-started thread rooted at the human message", () => {
    const instance = "chat-blocks-thread-root-author";
    const session = "chat_rootauthor";
    // Agent-started thread: the root is the HUMAN's user_text message.
    const userMsg = insertChatBlock(instance, {
      kind: "user_text",
      sessionId: session,
      text: "Research espresso machines under $500",
      taskId: "task_r"
    });
    insertChatBlock(instance, {
      kind: "assistant_text",
      sessionId: session,
      text: "Here are the tradeoffs.",
      streaming: false,
      threadId: "thread_r",
      parentBlockId: userMsg.id
    });

    const [summary] = summarizeThreads(instance, session);
    expect(summary?.parentBlockId).toBe(userMsg.id);
    expect(summary?.rootAuthor).toBe("user");
    expect(summary?.rootPreview).toBe("Research espresso machines under $500");
  });

  test("summarizeThreads reply count excludes phase and tool blocks", () => {
    const instance = "chat-blocks-thread-count";
    const session = "chat_count";
    const root = insertChatBlock(instance, {
      kind: "assistant_text",
      sessionId: session,
      text: "Root message.",
      streaming: false
    });
    // Two real messages in the thread.
    const firstMessage = insertChatBlock(instance, {
      kind: "user_text",
      sessionId: session,
      text: "Run the check",
      threadId: "thread_c",
      parentBlockId: root.id
    });
    const lastMessage = insertChatBlock(instance, {
      kind: "assistant_text",
      sessionId: session,
      text: "Done.",
      streaming: false,
      threadId: "thread_c",
      parentBlockId: root.id
    });
    // Transient/auxiliary blocks sharing the thread id — must not be counted.
    insertChatBlock(instance, {
      kind: "phase",
      sessionId: session,
      label: "Thinking",
      threadId: "thread_c",
      parentBlockId: root.id
    });
    insertChatBlock(instance, {
      kind: "tool_call",
      sessionId: session,
      toolName: "file_read",
      displayLabel: "Read file",
      argsPreview: "x.md",
      argsFull: { path: "x.md" },
      status: "ok",
      callId: "call_count",
      threadId: "thread_c",
      parentBlockId: root.id
    });
    insertChatBlock(instance, {
      kind: "tool_result",
      sessionId: session,
      callId: "call_count",
      preview: "ok",
      truncated: false,
      threadId: "thread_c",
      parentBlockId: root.id
    });
    const trailingNote = insertChatBlock(instance, {
      kind: "system_note",
      sessionId: session,
      text: "note",
      threadId: "thread_c",
      parentBlockId: root.id
    });

    // Pin created_at into a fixed order so the auxiliary trailing block is
    // strictly NEWER than the last message — the real shape after a run, where
    // a "Completed" phase / system_note lands after the reply text. Inserts in
    // a test fire within the same millisecond and `now()` follows the wall
    // clock, so force every relevant timestamp to make the check hermetic.
    const db = getMemoryDb(instance);
    const firstTs = "2020-01-01T00:00:01.000Z";
    const messageTs = "2020-01-01T00:00:02.000Z";
    const auxTs = "2020-01-01T00:00:03.000Z";
    db.run("UPDATE chat_blocks SET created_at = ? WHERE id = ?", [firstTs, firstMessage.id]);
    db.run("UPDATE chat_blocks SET created_at = ? WHERE id = ?", [messageTs, lastMessage.id]);
    db.run("UPDATE chat_blocks SET created_at = ? WHERE id = ?", [auxTs, trailingNote.id]);

    const summaries = summarizeThreads(instance, session);
    const thread = summaries.find((s) => s.threadId === "thread_c");
    // Only the user_text + assistant_text blocks count toward replies.
    expect(thread?.replyCount).toBe(2);
    // lastReplyAt tracks the last MESSAGE, not the trailing auxiliary block —
    // otherwise the unread badge re-flags a thread the user already opened.
    expect(thread?.lastReplyAt).toBe(messageTs);
  });

  test("summarizeThreads reports thread activity while its newest run is in flight", () => {
    const instance = "chat-blocks-thread-active";
    const session = "chat_active";
    const root = insertChatBlock(instance, {
      kind: "assistant_text",
      sessionId: session,
      text: "Root.",
      streaming: false
    });
    const reply = (threadId: string) =>
      insertChatBlock(instance, {
        kind: "user_text",
        sessionId: session,
        text: `reply in ${threadId}`,
        threadId,
        parentBlockId: root.id
      });
    const phase = (threadId: string, label: string) =>
      insertChatBlock(instance, { kind: "phase", sessionId: session, label, threadId, parentBlockId: root.id });
    const toolCall = (threadId: string, callId: string, status: "running" | "ok") =>
      insertChatBlock(instance, {
        kind: "tool_call",
        sessionId: session,
        toolName: "file_read",
        displayLabel: "Read file",
        argsPreview: "x.md",
        argsFull: { path: "x.md" },
        status,
        callId,
        threadId,
        parentBlockId: root.id
      });

    // Newest phase is non-terminal → the run is still going.
    reply("thread_running");
    phase("thread_running", "Working: terminal");
    // Newest phase is terminal → done.
    reply("thread_done");
    phase("thread_done", "Completed");
    // A tool call still running AFTER the terminal phase decides first.
    reply("thread_tool");
    phase("thread_tool", "Completed");
    toolCall("thread_tool", "call_active_1", "running");
    // A stale running tool call BEFORE the terminal phase does not — the
    // newer phase block wins the backwards scan.
    reply("thread_tool_done");
    toolCall("thread_tool_done", "call_active_2", "running");
    phase("thread_tool_done", "Cancelled");
    // Only messages → nothing in flight.
    reply("thread_text");
    // Only a finished tool call → nothing in flight.
    reply("thread_tool_ok");
    toolCall("thread_tool_ok", "call_active_3", "ok");

    const byId = new Map(summarizeThreads(instance, session).map((s) => [s.threadId, s]));
    expect(byId.get("thread_running")?.activity).toBe("running");
    expect(byId.get("thread_done")?.activity).toBeUndefined();
    expect(byId.get("thread_tool")?.activity).toBe("running");
    expect(byId.get("thread_tool_done")?.activity).toBeUndefined();
    expect(byId.get("thread_text")?.activity).toBeUndefined();
    expect(byId.get("thread_tool_ok")?.activity).toBeUndefined();
    // The instance-wide inbox query computes the same flag.
    const inbox = new Map(summarizeThreadsForInstance(instance, [session]).map((s) => [s.threadId, s]));
    expect(inbox.get("thread_running")?.activity).toBe("running");
    expect(inbox.get("thread_done")?.activity).toBeUndefined();
  });

  test("summarizeThreads reports waiting_approval while a user gate is the newest activity", () => {
    const instance = "chat-blocks-thread-gates";
    const session = "chat_gates";
    const root = insertChatBlock(instance, {
      kind: "assistant_text",
      sessionId: session,
      text: "Root.",
      streaming: false
    });
    const reply = (threadId: string) =>
      insertChatBlock(instance, {
        kind: "user_text",
        sessionId: session,
        text: `reply in ${threadId}`,
        threadId,
        parentBlockId: root.id
      });

    // Run parked on an authorization gate: phase "Working" then the gate,
    // with nothing newer — the run is waiting on the user, not running.
    reply("thread_auth");
    insertChatBlock(instance, {
      kind: "phase",
      sessionId: session,
      label: "Working: terminal",
      threadId: "thread_auth",
      parentBlockId: root.id
    });
    insertChatBlock(instance, {
      kind: "authorization_requested",
      sessionId: session,
      authorizationId: "auth_1",
      action: "terminal.exec",
      risk: "medium",
      summary: "Run a shell command",
      threadId: "thread_auth",
      parentBlockId: root.id
    });

    // Setup gates park the run the same way.
    reply("thread_setup");
    insertChatBlock(instance, {
      kind: "setup_requested",
      sessionId: session,
      setupRequestId: "setup_1",
      action: "connector.request",
      summary: "Provide a credential",
      threadId: "thread_setup",
      parentBlockId: root.id
    });

    // An approved gate resumes: newer running tool call wins the scan.
    reply("thread_auth_resumed");
    insertChatBlock(instance, {
      kind: "authorization_requested",
      sessionId: session,
      authorizationId: "auth_2",
      action: "terminal.exec",
      risk: "medium",
      summary: "Run a shell command",
      threadId: "thread_auth_resumed",
      parentBlockId: root.id
    });
    insertChatBlock(instance, {
      kind: "tool_call",
      sessionId: session,
      toolName: "terminal_run",
      displayLabel: "Run shell command",
      argsPreview: "sleep 5",
      argsFull: { command: "sleep 5" },
      status: "running",
      callId: "call_gate_1",
      threadId: "thread_auth_resumed",
      parentBlockId: root.id
    });

    // A denied/finished gate ends with a terminal phase after it — idle.
    reply("thread_auth_done");
    insertChatBlock(instance, {
      kind: "authorization_requested",
      sessionId: session,
      authorizationId: "auth_3",
      action: "terminal.exec",
      risk: "medium",
      summary: "Run a shell command",
      threadId: "thread_auth_done",
      parentBlockId: root.id
    });
    insertChatBlock(instance, {
      kind: "phase",
      sessionId: session,
      label: "Cancelled",
      threadId: "thread_auth_done",
      parentBlockId: root.id
    });

    const byId = new Map(summarizeThreads(instance, session).map((s) => [s.threadId, s]));
    expect(byId.get("thread_auth")?.activity).toBe("waiting_approval");
    expect(byId.get("thread_setup")?.activity).toBe("waiting_approval");
    expect(byId.get("thread_auth_resumed")?.activity).toBe("running");
    expect(byId.get("thread_auth_done")?.activity).toBeUndefined();
  });

  test("summarizeThreads keeps a thread active while an older overlapping task still runs", () => {
    const instance = "chat-blocks-thread-overlap";
    const session = "chat_overlap";
    const root = insertChatBlock(instance, {
      kind: "assistant_text",
      sessionId: session,
      text: "Root.",
      streaming: false
    });

    // Two tasks interleave in one thread (replies are not serialized):
    // task A starts a long tool, then task B replies quickly and completes.
    // B's terminal phase is the thread's NEWEST block, but A's work is
    // still in flight — the thread must read running, not idle.
    insertChatBlock(instance, {
      kind: "user_text",
      sessionId: session,
      text: "long job",
      threadId: "thread_overlap",
      parentBlockId: root.id,
      taskId: "task_a"
    });
    insertChatBlock(instance, {
      kind: "tool_call",
      sessionId: session,
      toolName: "terminal_exec",
      displayLabel: "Run shell command",
      argsPreview: "sleep 60",
      argsFull: { command: "sleep 60" },
      status: "running",
      callId: "call_overlap_a",
      threadId: "thread_overlap",
      parentBlockId: root.id,
      taskId: "task_a"
    });
    insertChatBlock(instance, {
      kind: "user_text",
      sessionId: session,
      text: "quick follow-up",
      threadId: "thread_overlap",
      parentBlockId: root.id,
      taskId: "task_b"
    });
    insertChatBlock(instance, {
      kind: "phase",
      sessionId: session,
      label: "Completed",
      threadId: "thread_overlap",
      parentBlockId: root.id,
      taskId: "task_b"
    });

    // A gate parked on one task outranks another task's running work —
    // the actionable state wins, matching the UI ordering.
    insertChatBlock(instance, {
      kind: "user_text",
      sessionId: session,
      text: "gated job",
      threadId: "thread_overlap_gate",
      parentBlockId: root.id,
      taskId: "task_c"
    });
    insertChatBlock(instance, {
      kind: "authorization_requested",
      sessionId: session,
      authorizationId: "auth_overlap",
      action: "terminal.exec",
      risk: "medium",
      summary: "Run a shell command",
      threadId: "thread_overlap_gate",
      parentBlockId: root.id,
      taskId: "task_c"
    });
    insertChatBlock(instance, {
      kind: "user_text",
      sessionId: session,
      text: "second job",
      threadId: "thread_overlap_gate",
      parentBlockId: root.id,
      taskId: "task_d"
    });
    insertChatBlock(instance, {
      kind: "phase",
      sessionId: session,
      label: "Working: terminal",
      threadId: "thread_overlap_gate",
      parentBlockId: root.id,
      taskId: "task_d"
    });

    const byId = new Map(summarizeThreads(instance, session).map((s) => [s.threadId, s]));
    expect(byId.get("thread_overlap")?.activity).toBe("running");
    expect(byId.get("thread_overlap_gate")?.activity).toBe("waiting_approval");
  });

  test("summarizeThreads skips malformed activity rows instead of guessing", () => {
    const instance = "chat-blocks-thread-active-malformed";
    const session = "chat_active_malformed";
    const root = insertChatBlock(instance, {
      kind: "assistant_text",
      sessionId: session,
      text: "Root.",
      streaming: false
    });
    // Older decisive row says running; the two newer rows are unusable (one
    // unparseable payload, one phase with no string label) and must be
    // skipped — not treated as terminal or as active.
    insertChatBlock(instance, {
      kind: "user_text",
      sessionId: session,
      text: "reply",
      threadId: "thread_m",
      parentBlockId: root.id
    });
    insertChatBlock(instance, {
      kind: "phase",
      sessionId: session,
      label: "Working: terminal",
      threadId: "thread_m",
      parentBlockId: root.id
    });
    const labelless = insertChatBlock(instance, {
      kind: "phase",
      sessionId: session,
      label: "Thinking",
      threadId: "thread_m",
      parentBlockId: root.id
    });
    const corrupt = insertChatBlock(instance, {
      kind: "phase",
      sessionId: session,
      label: "Thinking",
      threadId: "thread_m",
      parentBlockId: root.id
    });
    const db = getMemoryDb(instance);
    db.run("UPDATE chat_blocks SET payload_json = ? WHERE id = ?", ["{}", labelless.id]);
    db.run("UPDATE chat_blocks SET payload_json = ? WHERE id = ?", ["not json", corrupt.id]);

    const [summary] = summarizeThreads(instance, session);
    expect(summary?.threadId).toBe("thread_m");
    expect(summary?.activity).toBe("running");

    // A thread whose ONLY activity rows are unusable falls back to idle.
    insertChatBlock(instance, {
      kind: "user_text",
      sessionId: session,
      text: "reply",
      threadId: "thread_m2",
      parentBlockId: root.id
    });
    const only = insertChatBlock(instance, {
      kind: "phase",
      sessionId: session,
      label: "Thinking",
      threadId: "thread_m2",
      parentBlockId: root.id
    });
    db.run("UPDATE chat_blocks SET payload_json = ? WHERE id = ?", ["{}", only.id]);
    const m2 = summarizeThreads(instance, session).find((s) => s.threadId === "thread_m2");
    expect(m2?.activity).toBeUndefined();
  });

  test("summarizeThreads breaks last-reply ties deterministically by thread id", () => {
    const instance = "chat-blocks-thread-ties";
    const session = "chat_ties";
    const root = insertChatBlock(instance, {
      kind: "assistant_text",
      sessionId: session,
      text: "Root.",
      streaming: false
    });
    const a = insertChatBlock(instance, {
      kind: "user_text",
      sessionId: session,
      text: "reply b-side",
      threadId: "thread_tie_b",
      parentBlockId: root.id
    });
    const b = insertChatBlock(instance, {
      kind: "user_text",
      sessionId: session,
      text: "reply a-side",
      threadId: "thread_tie_a",
      parentBlockId: root.id
    });
    // Same-millisecond replies are the real shape for a burst of inserts —
    // pin both to one timestamp so the tiebreak (thread_id ASC) is what
    // orders the rows, not insertion luck.
    const db = getMemoryDb(instance);
    const ts = "2020-02-02T00:00:00.000Z";
    db.run("UPDATE chat_blocks SET created_at = ? WHERE id = ?", [ts, a.id]);
    db.run("UPDATE chat_blocks SET created_at = ? WHERE id = ?", [ts, b.id]);

    const ordered = summarizeThreads(instance, session).map((s) => s.threadId);
    expect(ordered).toEqual(["thread_tie_a", "thread_tie_b"]);
    const orderedInstance = summarizeThreadsForInstance(instance, [session]).map((s) => s.threadId);
    expect(orderedInstance).toEqual(["thread_tie_a", "thread_tie_b"]);
  });

  test("summarizeThreadsForInstance scopes to the supplied agent sessions", () => {
    const instance = "chat-blocks-thread-instance";
    const agentSession = "chat_agent";
    const otherSession = "chat_other";
    const root = insertChatBlock(instance, {
      kind: "assistant_text",
      sessionId: agentSession,
      text: "Root in the agent chat.",
      streaming: false,
      agentId: "agent_1"
    });
    insertChatBlock(instance, {
      kind: "user_text",
      sessionId: agentSession,
      text: "Agent thread reply",
      threadId: "thread_agent",
      parentBlockId: root.id,
      agentId: "agent_1"
    });
    // A thread in a session NOT in the agent-session set — must be excluded.
    insertChatBlock(instance, {
      kind: "user_text",
      sessionId: otherSession,
      text: "Channel thread reply",
      threadId: "thread_other",
      parentBlockId: "block_other"
    });

    const scoped = summarizeThreadsForInstance(instance, [agentSession]);
    expect(scoped.map((s) => s.threadId)).toEqual(["thread_agent"]);
    expect(scoped[0]?.agentId).toBe("agent_1");

    // Empty agent-session list yields no rows.
    expect(summarizeThreadsForInstance(instance, [])).toHaveLength(0);
  });
});

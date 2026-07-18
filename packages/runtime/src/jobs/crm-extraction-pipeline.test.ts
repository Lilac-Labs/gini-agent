import { describe, expect, test } from "bun:test";
import {
  analyzeThread,
  batchByPrimary,
  buildTurnMessage,
  decideThread,
  makeSelfMatcher,
  stitchThread,
  stripQuotedTail,
  type CrmMail,
} from "./crm-extraction-pipeline";

const SELF = "me@corp.io";
const isSelf = makeSelfMatcher([SELF, "alias@gmail.com"]);

function mail(over: Partial<CrmMail> & { id: string }): CrmMail {
  return {
    threadId: "t1",
    date: 1_000,
    to: [],
    cc: [],
    subject: "subj",
    body: "hello",
    ...over,
  };
}

describe("makeSelfMatcher", () => {
  test("matches exact addresses, plus-tag variants, and nothing else", () => {
    expect(isSelf("me@corp.io")).toBe(true);
    expect(isSelf("ME@CORP.IO")).toBe(true);
    expect(isSelf("me+shopping@corp.io")).toBe(true);
    expect(isSelf("alias+x@gmail.com")).toBe(true);
    expect(isSelf("someone@corp.io")).toBe(false); // same domain ≠ self
    expect(isSelf("me@other.io")).toBe(false);
    expect(isSelf("not-an-address")).toBe(false);
  });
});

describe("analyzeThread / decideThread", () => {
  test("self-sent thread is engaged; primary sender is the dominant human", () => {
    const msgs = [
      mail({ id: "1", from: { address: "friend@x.com" }, to: [{ address: SELF }] }),
      mail({ id: "2", from: { address: SELF }, to: [{ address: "friend@x.com" }], date: 2_000 }),
      mail({ id: "3", from: { address: "friend@x.com" }, to: [{ address: SELF }], date: 3_000 }),
    ];
    const a = analyzeThread(msgs, isSelf);
    expect(a.engaged).toBe(true);
    expect(a.primarySender).toBe("friend@x.com");
    expect(a.messageCount).toBe(3);
    expect(a.newestDate).toBe(3_000);
    expect(a.senders).toEqual([{ sender: "friend@x.com", multiMessage: true, selfWrote: true }]);
    expect(decideThread(a, new Set())).toEqual({ keep: true });
  });

  test("primary sender is the DOMINANT human when several are present", () => {
    const msgs = [
      mail({ id: "1", from: { address: "quiet@x.com" }, to: [{ address: SELF }] }),
      mail({ id: "2", from: { address: "chatty@y.com" }, to: [{ address: SELF }], date: 2_000 }),
      mail({ id: "3", from: { address: "chatty@y.com" }, to: [{ address: SELF }], date: 3_000 }),
      mail({ id: "4", from: { address: SELF }, to: [{ address: "chatty@y.com" }], date: 4_000 }),
    ];
    const a = analyzeThread(msgs, isSelf);
    expect(a.primarySender).toBe("chatty@y.com");
    expect(a.senders.map((s) => s.sender).sort()).toEqual(["chatty@y.com", "quiet@x.com"]);
  });

  test("being cc'd in by a human counts as engaged (the intro shape)", () => {
    const msgs = [
      mail({ id: "1", from: { address: "intro@x.com" }, to: [{ address: "other@y.com" }], cc: [{ address: SELF }] }),
    ];
    const a = analyzeThread(msgs, isSelf);
    expect(a.engaged).toBe(true);
    expect(decideThread(a, new Set()).keep).toBe(true);
  });

  test("cold one-way inbound is not engaged and gets skipped", () => {
    const msgs = [mail({ id: "1", from: { address: "sdr@pitch.com" }, to: [{ address: SELF }] })];
    const a = analyzeThread(msgs, isSelf);
    expect(a.engaged).toBe(false);
    expect(decideThread(a, new Set())).toEqual({ keep: false, reason: "not engaged (no self message or cc)" });
  });

  test("being cc'd by an AUTOMATED sender does not count as engaged", () => {
    const msgs = [
      mail({ id: "1", from: { address: "no-reply@robot.com" }, to: [{ address: "other@y.com" }], cc: [{ address: SELF }] }),
    ];
    expect(analyzeThread(msgs, isSelf).engaged).toBe(false);
  });

  test("outbound-only mail to a human keeps the thread (you spoke first)", () => {
    const msgs = [mail({ id: "1", from: { address: SELF }, to: [{ address: "prospect@x.com" }] })];
    const a = analyzeThread(msgs, isSelf);
    expect(a.engaged).toBe(true);
    expect(a.hasHuman).toBe(true); // via human recipient
    expect(a.primarySender).toBeNull();
    expect(decideThread(a, new Set()).keep).toBe(true);
  });

  test("self replying to a machine is engaged but has no human → skipped", () => {
    const msgs = [
      mail({ id: "1", from: { address: "no-reply@robot.com" }, to: [{ address: SELF }] }),
      mail({ id: "2", from: { address: SELF }, to: [{ address: "no-reply@robot.com" }], date: 2_000 }),
    ];
    const a = analyzeThread(msgs, isSelf);
    expect(a.engaged).toBe(true);
    expect(a.hasHuman).toBe(false);
    expect(decideThread(a, new Set())).toEqual({ keep: false, reason: "all senders automated/self" });
  });

  test("a broadcast primary sender is skipped even when engaged", () => {
    const msgs = [
      mail({ id: "1", from: { address: "persona@drip.com" }, to: [{ address: SELF }] }),
      mail({ id: "2", from: { address: SELF }, to: [{ address: "persona@drip.com" }], date: 2_000 }),
    ];
    const a = analyzeThread(msgs, isSelf);
    expect(decideThread(a, new Set(["persona@drip.com"]))).toEqual({ keep: false, reason: "broadcast sender" });
  });
});

describe("stripQuotedTail", () => {
  test("cuts attribution tails and quoted lines but never empties a body", () => {
    const body = [
      "Sounds good, see you then!",
      "",
      "On Tue, Jul 7, 2026 at 9:00 AM Friend <friend@x.com> wrote:",
      "> earlier message",
      "> more quoted",
    ].join("\n");
    expect(stripQuotedTail(body)).toBe("Sounds good, see you then!");
    const allQuote = ["> only", "> quoted", "> lines"].join("\n");
    expect(stripQuotedTail(allQuote).length).toBeGreaterThan(0);
  });
});

describe("stitchThread", () => {
  test("orders oldest→newest and middle-truncates over budget", () => {
    const msgs = Array.from({ length: 8 }, (_, i) =>
      mail({ id: String(i), date: (i + 1) * 100, from: { address: "a@x.com" }, body: "x".repeat(400), subject: `m${i}` }),
    );
    const out = stitchThread(msgs, 2_000);
    expect(out).toContain("omitted for length");
    expect(out.indexOf("m0")).toBeGreaterThan(-1);
    expect(out.indexOf("m7")).toBeGreaterThan(out.indexOf("m0")); // both ends kept
  });
});

describe("batchByPrimary", () => {
  test("groups by primary sender under both caps", () => {
    const rows = [
      { threadId: "a1", primarySender: "alice@x.com", chars: 10 },
      { threadId: "a2", primarySender: "alice@x.com", chars: 10 },
      { threadId: "a3", primarySender: "alice@x.com", chars: 10 },
      { threadId: "b1", primarySender: "bob@y.com", chars: 10 },
      { threadId: "solo", primarySender: null, chars: 10 },
    ];
    const batches = batchByPrimary(rows, 2, 1_000);
    expect(batches).toEqual([["a1", "a2"], ["a3"], ["b1"], ["solo"]]);
    // char cap splits too
    const big = batchByPrimary(
      [
        { threadId: "c1", primarySender: "c@z.com", chars: 900 },
        { threadId: "c2", primarySender: "c@z.com", chars: 900 },
      ],
      10,
      1_000,
    );
    expect(big).toEqual([["c1"], ["c2"]]);
  });
});

describe("buildTurnMessage", () => {
  test("inlines the skill and fences each thread", () => {
    const msg = buildTurnMessage(
      [
        { threadId: "t1", msgs: [mail({ id: "1", from: { address: "a@x.com" } })] },
        { threadId: "t2", msgs: [mail({ id: "2", from: { address: "b@y.com" }, threadId: "t2" })] },
      ],
      "# People CRM\nrules here",
      SELF,
    );
    expect(msg).toContain("these 2 email threads");
    expect(msg).toContain("no need to read_skill");
    expect(msg).toContain("```people-crm-skill");
    expect(msg).toContain("rules here");
    expect(msg).toContain("[Thread 1 of 2 — 1 message]");
    expect(msg).toContain(`I'm ${SELF}.`);
  });
});

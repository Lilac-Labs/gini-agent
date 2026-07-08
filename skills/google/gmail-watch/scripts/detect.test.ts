// Unit tests for the stateless gmail-watch detection engine (ADR email-watch.md).
//
// Covers the pure helpers (gws JSON / NDJSON-window / metadata parsers, the
// safety floor, the raw match item) AND the watcher-state regimes (seeding,
// dedup, truncation, oldest-first backlog drain, same-second siblings, the
// after: watermark bound) by calling `detect` directly with an injected gws
// spawn — no child process, no state store (the engine is pure: state in, state
// out). Every detection-hardening invariant is pinned here.

import { describe, expect, test } from "bun:test";
import {
  buildMatchItem,
  detect,
  parseFromAddress,
  parseGwsAuthStatus,
  run,
  runWatches,
  scrubError,
  shouldDropMessage,
  type GwsSpawn
} from "./detect";

interface Meta {
  id: string;
  internalDate?: string;
  from?: string;
  subject?: string;
  date?: string;
  snippet?: string;
  // Optional headers for the cross-account dedup tests: the RFC Message-ID
  // (stable across accounts) and the To recipient (drives dedup precedence).
  to?: string;
  messageId?: string;
}

const PREAMBLE = "Using keyring backend: keyring\n";

function listResponse(ids: string[]): string {
  return PREAMBLE + JSON.stringify({ messages: ids.map((id) => ({ id, threadId: id })) });
}

// Multi-page NDJSON `--page-all` response. `pages` is a list of id-arrays,
// newest-first across and within pages; the last page carries a nextPageToken
// only when `truncated` is set (the page-cap-hit signal).
function pagedListResponse(pages: string[][], truncated = false): string {
  const lines = pages.map((ids, i) => {
    const isLast = i === pages.length - 1;
    const doc: Record<string, unknown> = { messages: ids.map((id) => ({ id, threadId: id })) };
    if (!isLast || truncated) doc.nextPageToken = `tok-${i}`;
    return JSON.stringify(doc);
  });
  return PREAMBLE + lines.join("\n");
}

function metadataResponse(meta: Meta): string {
  return (
    PREAMBLE +
    JSON.stringify({
      id: meta.id,
      internalDate: meta.internalDate,
      snippet: meta.snippet ?? "",
      payload: {
        headers: [
          { name: "From", value: meta.from ?? "" },
          { name: "Subject", value: meta.subject ?? "" },
          { name: "Date", value: meta.date ?? "" },
          ...(meta.to !== undefined ? [{ name: "To", value: meta.to }] : []),
          ...(meta.messageId !== undefined ? [{ name: "Message-ID", value: meta.messageId }] : [])
        ]
      }
    })
  );
}

function getArgId(joined: string): string | undefined {
  return joined.match(/"id":"([^"]+)"/)?.[1];
}

// gws spawn stub from a flat list response + a metadata map.
function stubSpawn(ids: string[], metaById: Record<string, Meta>): GwsSpawn {
  return async (args: string[]) => {
    const joined = args.join(" ");
    if (joined.includes("messages list")) return listResponse(ids);
    if (joined.includes("messages get")) {
      const hit = getArgId(joined);
      return hit && metaById[hit] ? metadataResponse(metaById[hit]) : PREAMBLE + "{}";
    }
    return PREAMBLE + "{}";
  };
}

// A gws spawn that HONORS the `after:<epochSec>` bound the engine builds (the
// real Gmail contract). When `truncated` is set the last page carries a
// nextPageToken (page-cap-hit) and only the newest `pageCap` messages list.
function afterHonoringSpawn(
  corpus: Meta[],
  opts: { truncated?: boolean; pageCap?: number } = {}
): GwsSpawn {
  const pageCap = opts.pageCap ?? 1000;
  const byId: Record<string, Meta> = {};
  for (const m of corpus) byId[m.id] = m;
  return async (args: string[]) => {
    const joined = args.join(" ");
    if (joined.includes("messages list")) {
      const afterSec = Number(joined.match(/after:(\d+)/)?.[1] ?? "0");
      const matched = corpus
        .filter((m) => Math.floor(Number(m.internalDate) / 1000) > afterSec)
        .sort((a, b) => Number(b.internalDate) - Number(a.internalDate));
      const listed = opts.truncated ? matched.slice(0, pageCap) : matched;
      const pages: string[][] = [];
      if (opts.truncated && listed.length > 0) {
        const per = Math.ceil(listed.length / 10);
        for (let i = 0; i < 10; i++) pages.push(listed.slice(i * per, (i + 1) * per).map((m) => m.id));
      } else {
        for (let i = 0; i < listed.length; i += 100) pages.push(listed.slice(i, i + 100).map((m) => m.id));
      }
      if (pages.length === 0) pages.push([]);
      return pagedListResponse(pages, opts.truncated);
    }
    if (joined.includes("messages get")) {
      const hit = getArgId(joined);
      return hit && byId[hit] ? metadataResponse(byId[hit]) : PREAMBLE + "{}";
    }
    return PREAMBLE + "{}";
  };
}

function matchCount(items: { text: string; untrusted: boolean }[] | undefined): number {
  return (items ?? []).filter((i) => i.untrusted).length;
}

// Each item's text is "New email from <sender> — <json>"; parse the embedded
// JSON payload (everything after the first " — ").
function itemPayload(text: string): Record<string, unknown> {
  const json = text.slice(text.indexOf(" — ") + 3);
  return JSON.parse(json) as Record<string, unknown>;
}

// Drafted = untrusted match items only (trusted objective/notice items carry
// no JSON payload).
function draftedIds(items: { text: string; untrusted: boolean }[] | undefined): string[] {
  return (items ?? []).filter((i) => i.untrusted).map((i) => itemPayload(i.text).id as string);
}

// Flatten every routed bucket into one items[] (the multi-watch result no longer
// carries a flat items[] — matches are partitioned per concern by routeKey).
function allBucketItems(
  buckets: Record<string, { text: string; untrusted: boolean }[]> | undefined
): { text: string; untrusted: boolean }[] {
  return Object.values(buckets ?? {}).flat();
}

describe("parse + safety helpers", () => {
  test("parseGwsAuthStatus reads token_valid", () => {
    expect(parseGwsAuthStatus(PREAMBLE + '{"token_valid":true}').signedIn).toBe(true);
    expect(parseGwsAuthStatus(PREAMBLE + '{"token_valid":false}').signedIn).toBe(false);
    expect(parseGwsAuthStatus("garbage").signedIn).toBe(false);
  });

  test("safety floor drops automated senders", () => {
    expect(shouldDropMessage({ id: "x", from: "no-reply@service.com" })).toBe(true);
    expect(shouldDropMessage({ id: "x", from: "mailer-daemon@x.com" })).toBe(true);
    expect(shouldDropMessage({ id: "x", from: "notifications@github.com" })).toBe(true);
  });

  test("safety floor drops self by equality, not substring", () => {
    expect(shouldDropMessage({ id: "x", from: "Me <me@example.com>" }, "me@example.com")).toBe(true);
    expect(shouldDropMessage({ id: "x", from: "me@example.com" }, "me@example.com")).toBe(true);
    // self j@gmail.com must NOT drop aj@gmail.com (substring match would).
    expect(shouldDropMessage({ id: "x", from: "AJ <aj@gmail.com>" }, "j@gmail.com")).toBe(false);
    expect(shouldDropMessage({ id: "x", from: "Alice <alice@x.com>" }, "me@example.com")).toBe(false);
  });

  test("an explicitly watched sender bypasses the automated heuristic; self still drops", () => {
    // Watching noreply@ups.com by name must fire despite the AUTOMATED_FROM hit.
    expect(shouldDropMessage({ id: "x", from: "UPS <noreply@ups.com>" }, "me@example.com", "noreply@ups.com")).toBe(false);
    // Case-insensitive equality on the parsed address.
    expect(shouldDropMessage({ id: "x", from: "NoReply@UPS.com" }, "me@example.com", "noreply@ups.com")).toBe(false);
    // A DIFFERENT automated sender on the same watch still drops.
    expect(shouldDropMessage({ id: "x", from: "notifications@github.com" }, "me@example.com", "noreply@ups.com")).toBe(true);
    // Self-drop is mandatory — even when self IS the watched address.
    expect(shouldDropMessage({ id: "x", from: "me@example.com" }, "me@example.com", "me@example.com")).toBe(true);
  });

  test("parseFromAddress extracts the bare address from either form", () => {
    expect(parseFromAddress("Alice <alice@x.com>")).toBe("alice@x.com");
    expect(parseFromAddress("bob@y.com")).toBe("bob@y.com");
    expect(parseFromAddress("no address here")).toBeUndefined();
  });

  test("buildMatchItem emits a sender-labeled raw item, untrusted, no fence", () => {
    const item = buildMatchItem({ id: "m1", from: "alice@x.com", subject: "hi", snippet: "yo" });
    expect(item.untrusted).toBe(true);
    expect(item.text).not.toContain("UNTRUSTED");
    expect(item.text).not.toContain("matched-context");
    // Labeled by sender so the shared thread can attribute each match.
    expect(item.text.startsWith("New email from alice@x.com — ")).toBe(true);
    const data = itemPayload(item.text);
    expect(data.id).toBe("m1");
    expect(data.subject).toBe("hi");
    expect(data.from).toBe("alice@x.com");
  });

  test("scrubError redacts secret-file paths, home-rooted paths, and /root", () => {
    expect(scrubError("failed to read /Users/alice/.config/gws/token.json")).toBe("failed to read <path>");
    // Extension-less home path is redacted too.
    expect(scrubError("keyring at /Users/x/.config/gws/keyring missing")).toBe("keyring at <path> missing");
    expect(scrubError("open /home/bob/.gini/secrets.enc: denied")).toBe("open <path>: denied");
    expect(scrubError("config /root/.config/gws failed")).toBe("config <path> failed");
    // /root anchored so it doesn't eat /rootcause.
    expect(scrubError("the rootcause was unclear")).toBe("the rootcause was unclear");
  });
});

describe("detect — regimes", () => {
  test("seeding drafts the pending inbound head oldest-first, baselines at newest, records boundary seen", async () => {
    const spawn = stubSpawn(["m2", "m1"], {
      m1: { id: "m1", internalDate: "1000", from: "alice@x.com", subject: "a" },
      m2: { id: "m2", internalDate: "2000", from: "alice@x.com", subject: "b" }
    });
    const r = await detect({ query: "from:alice@x.com is:unread", state: null }, spawn, "me@example.com");
    // Both head messages are non-self inbound => seed drafts BOTH, oldest-first.
    expect(r.kind).toBe("context");
    expect(draftedIds(r.items)).toEqual(["m1", "m2"]);
    // Baselined at the newest head id; only its boundary id is recorded (different
    // seconds => no sibling).
    expect(r.state.cursor).toBe("2000");
    expect(r.state.seen).toEqual(["m2"]);
  });

  test("seeding drains the recent head oldest-first; older-than-head backlog excluded; next tick does not re-draft", async () => {
    // Three matching messages already in the inbox, all within the cap. Seed drains
    // the whole head oldest-first; the cursor baselines at the newest.
    const corpus: Meta[] = [
      { id: "s-new", internalDate: "1780000003000", from: "Alice <alice@x.com>", subject: "newest" },
      { id: "s-mid", internalDate: "1780000002000", from: "Alice <alice@x.com>", subject: "mid" },
      { id: "s-old", internalDate: "1780000001000", from: "Alice <alice@x.com>", subject: "old" }
    ];
    const spawn = afterHonoringSpawn(corpus);
    const seed = await detect({ query: "from:alice@x.com", state: null }, spawn, "me@example.com");
    expect(seed.kind).toBe("context");
    // The whole head is drafted, oldest-first.
    expect(draftedIds(seed.items)).toEqual(["s-old", "s-mid", "s-new"]);
    expect(seed.state.cursor).toBe("1780000003000");
    expect(seed.state.seen).toEqual(["s-new"]);

    // The next steady tick (with the seeded state) re-lists nothing newer than the
    // baseline => no re-draft of any seeded message.
    const steady = await detect({ query: "from:alice@x.com", state: seed.state }, spawn, "me@example.com");
    expect(steady.kind).toBe("shortCircuit");
  });

  test("seeding stays silent when the head is only self (nothing pending to answer)", async () => {
    const spawn = stubSpawn(["m2", "m1"], {
      m1: { id: "m1", internalDate: "1000", from: "me@example.com", subject: "earlier reply" },
      m2: { id: "m2", internalDate: "2000", from: "me@example.com", subject: "our reply" }
    });
    const r = await detect({ query: "from:alice@x.com is:unread", state: null }, spawn, "me@example.com");
    // Every head message is our OWN => draft nothing, baseline silently.
    expect(r.kind).toBe("shortCircuit");
    expect(r.summary).toBe("[SILENT]");
    expect(r.state.cursor).toBe("2000");
    expect(r.state.seen).toEqual(["m2"]);
  });

  test("seeding with a self newest still drafts an older non-self inbound in the head", async () => {
    const spawn = stubSpawn(["m2", "m1"], {
      m1: { id: "m1", internalDate: "1000", from: "alice@x.com", subject: "their pending question" },
      m2: { id: "m2", internalDate: "2000", from: "me@example.com", subject: "our reply" }
    });
    const r = await detect({ query: "from:alice@x.com is:unread", state: null }, spawn, "me@example.com");
    // The self newest is dropped but still advances the baseline; the older non-self
    // inbound in the head is drafted.
    expect(r.kind).toBe("context");
    expect(draftedIds(r.items)).toEqual(["m1"]);
    expect(r.state.cursor).toBe("2000");
    expect(r.state.seen).toEqual(["m2"]);
  });

  test("seeding stays silent when the head is only an automated sender", async () => {
    const spawn = stubSpawn(["m2", "m1"], {
      m1: { id: "m1", internalDate: "1000", from: "no-reply@service.com", subject: "auto a" },
      m2: { id: "m2", internalDate: "2000", from: "no-reply@service.com", subject: "auto b" }
    });
    const r = await detect({ query: "is:unread", state: null }, spawn, "me@example.com");
    // Every head message is automated (the steady drop filter rejects it) => silent.
    expect(r.kind).toBe("shortCircuit");
    expect(r.summary).toBe("[SILENT]");
    expect(r.state.cursor).toBe("2000");
    expect(r.state.seen).toEqual(["m2"]);
  });

  test("seeding with an automated newest still drafts the older real mail in the head", async () => {
    // The exact real-world bug: the newest matching email is an automated notice,
    // and the real pending inbound sits just below it in the head. The automated
    // newest is dropped but advances the baseline; the older real mail drafts.
    const spawn = stubSpawn(["m2", "m1"], {
      m1: { id: "m1", internalDate: "1000", from: "Investor <vc@fund.com>", subject: "Coffee chat?" },
      m2: { id: "m2", internalDate: "2000", from: "workspace-noreply@google.com", subject: "security notice" }
    });
    const r = await detect({ query: "in:inbox", state: null }, spawn, "me@example.com");
    expect(r.kind).toBe("context");
    expect(draftedIds(r.items)).toEqual(["m1"]);
    expect(r.state.cursor).toBe("2000");
    expect(r.state.seen).toEqual(["m2"]);
  });

  test("seeding carries the objective and the fetched body on the seeded draft", async () => {
    const meta: Meta = { id: "m2", internalDate: "2000", from: "Alice <alice@x.com>", subject: "offer", snippet: "snip" };
    const fullBody = "The full pending email body the drafting turn replies to.";
    const spawn: GwsSpawn = async (args) => {
      const joined = args.join(" ");
      if (joined.includes("messages list")) return listResponse(["m2"]);
      if (joined.includes("messages get") && joined.includes('"format":"full"')) {
        return PREAMBLE + JSON.stringify({ id: "m2", payload: { mimeType: "text/plain", body: { data: Buffer.from(fullBody, "utf8").toString("base64url") } } });
      }
      if (joined.includes("messages get")) return metadataResponse(meta);
      return PREAMBLE + "{}";
    };
    const r = await detect(
      { query: "from:alice@x.com", sender: "alice@x.com", objective: "Get a refund", state: null },
      spawn,
      "me@example.com"
    );
    expect(r.kind).toBe("context");
    expect(itemPayload(r.items![0]!.text).body).toBe(fullBody);
    const trusted = r.items!.filter((i) => !i.untrusted);
    expect(trusted).toHaveLength(1);
    expect(trusted[0]!.text).toBe("Objective for this watch (alice@x.com): Get a refund");
  });

  test("seeding on a truncated window drains the head and baselines at newest, never the un-listed tail", async () => {
    // The window is truncated (pageLimitHit), but seeding ignores truncation: it
    // walks only the newest head (up to the cap), never the older un-listed tail.
    // Build the head with distinct, decreasing timestamps so the drain order and
    // the baseline are unambiguous; an extra page-tail sits below the head.
    const head = Array.from({ length: 25 }, (_, i) => `h${i}`); // h0 newest .. h24
    const tail = Array.from({ length: 20 }, (_, i) => `t${i}`); // below the head
    const dateOf = (id: string): string => {
      const hi = head.indexOf(id);
      if (hi >= 0) return String(9000 - hi); // h0=9000 .. h24=8976
      return "1000"; // tail timestamps far below the head
    };
    let metaGets = 0;
    const spawn: GwsSpawn = async (args) => {
      const joined = args.join(" ");
      if (joined.includes("messages list")) {
        // 10 pages of the head + tail, last page carries a token (truncated).
        const all = [...head, ...tail];
        const per = Math.ceil(all.length / 10);
        const pages = Array.from({ length: 10 }, (_, i) => all.slice(i * per, (i + 1) * per));
        return pagedListResponse(pages, true);
      }
      if (joined.includes("messages get") && joined.includes('"format":"full"')) {
        const id = getArgId(joined)!;
        return PREAMBLE + JSON.stringify({ id, payload: { mimeType: "text/plain", body: { data: Buffer.from("body", "utf8").toString("base64url") } } });
      }
      if (joined.includes("messages get")) {
        metaGets += 1;
        const id = getArgId(joined)!;
        return metadataResponse({ id, internalDate: dateOf(id), from: "alice@x.com" });
      }
      return PREAMBLE + "{}";
    };
    const r = await detect({ query: "is:unread", state: null }, spawn, "me@example.com");
    expect(r.kind).toBe("context");
    // The whole head (25 non-self) drafts, oldest-first; the cursor baselines at
    // the newest head id and the older un-listed tail is never drafted.
    expect(matchCount(r.items)).toBe(25);
    expect(draftedIds(r.items)).toEqual(head.slice().reverse());
    expect(r.state.cursor).toBe("9000");
    expect(r.state.seen).toEqual(["h0"]);
    // Only the head (+ a boundary probe) is walked — never the full window.
    expect(metaGets).toBeLessThan(head.length + tail.length);
  });

  test("seeding records same-second siblings so the inclusive after: does not re-draft them", async () => {
    const corpus: Meta[] = [
      { id: "s-new", internalDate: "1780000000900", from: "Alice <alice@x.com>", subject: "newest" },
      { id: "s-sib", internalDate: "1780000000100", from: "Alice <alice@x.com>", subject: "sibling" },
      { id: "s-old", internalDate: "1779999000000", from: "Alice <alice@x.com>", subject: "old" }
    ];
    const byId: Record<string, Meta> = {};
    for (const m of corpus) byId[m.id] = m;
    // Inclusive-after stub: `after:N` lists messages whose floored second is >= N.
    const inclusiveAfter: GwsSpawn = async (args) => {
      const joined = args.join(" ");
      if (joined.includes("messages list")) {
        const m = joined.match(/after:(\d+)/);
        const afterSec = m ? Number(m[1]) : 0;
        const matched = corpus
          .filter((x) => !m || Math.floor(Number(x.internalDate) / 1000) >= afterSec)
          .sort((a, b) => Number(b.internalDate) - Number(a.internalDate));
        return listResponse(matched.map((x) => x.id));
      }
      if (joined.includes("messages get")) {
        const hit = getArgId(joined);
        return hit && byId[hit] ? metadataResponse(byId[hit]) : PREAMBLE + "{}";
      }
      return PREAMBLE + "{}";
    };

    const seed = await detect({ query: "is:unread", state: null }, inclusiveAfter, "me@example.com");
    // All three are non-self inbound in the head => all drafted oldest-first. Both
    // same-second boundary ids (s-new + its sibling s-sib) ride forward in `seen`,
    // with the cursor at their shared second, so the inclusive `after:` next tick
    // re-lists them but they're skipped.
    expect(seed.kind).toBe("context");
    expect(draftedIds(seed.items)).toEqual(["s-old", "s-sib", "s-new"]);
    expect(seed.state.cursor).toBe("1780000000900");
    expect(new Set(seed.state.seen)).toEqual(new Set(["s-new", "s-sib"]));

    // Steady fire: both same-second ids are re-listed but in `seen` => no re-draft.
    const steady = await detect(
      { query: "is:unread", state: seed.state },
      inclusiveAfter,
      "me@example.com"
    );
    expect(steady.kind).toBe("shortCircuit");
  });

  test("seeding a head LARGER than the cap drafts only the newest cap; the rest are excluded; next tick does not re-draft", async () => {
    // 30 matching messages already in the inbox, more than MAX_MESSAGES_PER_TICK
    // (25). Seeding considers only the newest 25 head ids, drafts them oldest-first,
    // and baselines at the newest; the 5 oldest are below the head and excluded by
    // `after:` forever.
    const ids = Array.from({ length: 30 }, (_, i) => `g${i}`);
    const corpus: Meta[] = ids.map((id, i) => ({
      id,
      internalDate: String(11_000_000 + i * 1000), // g0 oldest .. g29 newest
      from: "Alice <alice@x.com>",
      subject: `m${i}`
    }));
    const spawn = afterHonoringSpawn(corpus);
    const seed = await detect({ query: "from:alice@x.com", state: null }, spawn, "me@example.com");
    expect(seed.kind).toBe("context");
    // Only the newest 25 (g5..g29) are drafted, oldest-first; the 5 oldest are NOT.
    const newest25 = ids.slice(5); // g5 .. g29
    expect(matchCount(seed.items)).toBe(25);
    expect(draftedIds(seed.items)).toEqual(newest25);
    for (const old of ids.slice(0, 5)) expect(draftedIds(seed.items)).not.toContain(old);
    expect(seed.state.cursor).toBe(String(11_000_000 + 29 * 1000));
    expect(seed.state.seen).toEqual(["g29"]);

    // Next tick (with the seeded state): `after:` excludes everything at/below the
    // baseline => no re-draft of the head or the excluded tail.
    const steady = await detect({ query: "from:alice@x.com", state: seed.state }, spawn, "me@example.com");
    expect(steady.kind).toBe("shortCircuit");
  });

  test("a new human match yields exactly one item; self/automated dropped", async () => {
    const spawn = stubSpawn(["m2", "m3", "m4"], {
      m2: { id: "m2", internalDate: "3000", from: "Alice <alice@x.com>", subject: "new" },
      m3: { id: "m3", internalDate: "3100", from: "no-reply@alice.com", subject: "auto" },
      m4: { id: "m4", internalDate: "3200", from: "me@example.com", subject: "self" }
    });
    const r = await detect(
      { query: "from:alice@x.com is:unread", state: { cursor: "1000", seen: [] } },
      spawn,
      "me@example.com"
    );
    expect(r.kind).toBe("context");
    expect(matchCount(r.items)).toBe(1);
    expect(draftedIds(r.items)).toEqual(["m2"]);
    // Cursor advanced to the last consumed item (m4, the newest dropped).
    expect(r.state.cursor).toBe("3200");
  });

  test("a watch's explicit sender lets an automated address through end to end", async () => {
    const spawn = stubSpawn(["u1", "u2"], {
      u1: { id: "u1", internalDate: "3000", from: "UPS <noreply@ups.com>", subject: "package" },
      u2: { id: "u2", internalDate: "3100", from: "me@example.com", subject: "self" }
    });
    const r = await detect(
      { query: "from:noreply@ups.com", sender: "noreply@ups.com", state: { cursor: "1000", seen: [] } },
      spawn,
      "me@example.com"
    );
    // The watched automated address fires; self is still dropped.
    expect(r.kind).toBe("context");
    expect(draftedIds(r.items)).toEqual(["u1"]);
  });

  test("a matched tick appends ONE trusted objective item; a no-match tick emits none", async () => {
    const spawn = stubSpawn(["o1"], {
      o1: { id: "o1", internalDate: "3000", from: "Alice <alice@x.com>", subject: "offer" }
    });
    const r = await detect(
      {
        query: "from:alice@x.com",
        sender: "alice@x.com",
        objective: "Get a refund or a replacement",
        state: { cursor: "1000", seen: [] }
      },
      spawn,
      "me@example.com"
    );
    expect(r.kind).toBe("context");
    expect(matchCount(r.items)).toBe(1);
    // Exactly one TRUSTED item: the objective, labeled by the watched sender,
    // outside the untrusted fence (the runner renders trusted items unfenced).
    const trusted = r.items!.filter((i) => !i.untrusted);
    expect(trusted).toHaveLength(1);
    expect(trusted[0]!.text).toBe("Objective for this watch (alice@x.com): Get a refund or a replacement");

    // Nothing new on the next tick => shortCircuit, no objective item.
    const quiet = await detect(
      { query: "from:alice@x.com", sender: "alice@x.com", objective: "Get a refund or a replacement", state: r.state },
      stubSpawn([], {}),
      "me@example.com"
    );
    expect(quiet.kind).toBe("shortCircuit");
    expect(quiet.items).toBeUndefined();
  });

  test("bounds the query with after:<epochSec> once a cursor exists, but not on seeding", async () => {
    const listCalls: string[] = [];
    const cap: GwsSpawn = async (args) => {
      const joined = args.join(" ");
      if (joined.includes("messages list")) listCalls.push(joined);
      return PREAMBLE + "{}";
    };
    await detect({ query: "is:unread", state: null }, cap, "me@example.com");
    expect(listCalls).toHaveLength(1);
    expect(listCalls[0]).not.toContain("after:");

    await detect({ query: "is:unread", state: { cursor: "3000", seen: [] } }, cap, "me@example.com");
    expect(listCalls[1]).toContain("after:3");
  });

  test("steady non-truncated window of 30 drafts all 30 exactly once across fires, honoring after:", async () => {
    const ids = Array.from({ length: 30 }, (_, i) => `b${i}`);
    const corpus: Meta[] = ids.map((id, i) => ({
      id,
      internalDate: String(11_000_000 + i * 1000),
      from: "Alice <alice@x.com>",
      subject: `m${i}`
    }));
    const spawn = afterHonoringSpawn(corpus);

    // Fire 1: caps at MAX_MESSAGES_PER_TICK (25), oldest-first (b0..b24).
    const r1 = await detect({ query: "is:unread", state: { cursor: "1000", seen: [] } }, spawn, "me@example.com");
    expect(matchCount(r1.items)).toBe(25);
    expect(draftedIds(r1.items)).toEqual(ids.slice(0, 25));
    expect(r1.state.cursor).toBe(String(11_000_000 + 24 * 1000));

    // Fire 2 (using fire-1's state): `after:` excludes b0..b24; the last 5 drain.
    const r2 = await detect({ query: "is:unread", state: r1.state }, spawn, "me@example.com");
    expect(matchCount(r2.items)).toBe(5);
    expect(draftedIds(r2.items)).toEqual(ids.slice(25));

    // Fire 3: nothing new => shortCircuit.
    const r3 = await detect({ query: "is:unread", state: r2.state }, spawn, "me@example.com");
    expect(r3.kind).toBe("shortCircuit");
  });

  test("steady truncated window jumps cursor to newest, short-circuits with a backlog notice, no re-loop", async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `c${i}`);
    const corpus: Meta[] = ids.map((id, i) => ({
      id,
      internalDate: String(12_000_000 + i * 1000),
      from: "Alice <alice@x.com>",
      subject: `t${i}`
    }));
    const spawn = afterHonoringSpawn(corpus, { truncated: true, pageCap: 10 });

    const r1 = await detect({ query: "is:unread", state: { cursor: "1000", seen: [] } }, spawn, "me@example.com");
    // No per-message drafts; a non-silent backlog summary; cursor jumped to newest.
    expect(r1.kind).toBe("shortCircuit");
    expect(matchCount(r1.items)).toBe(0);
    expect(r1.summary).toContain("backlog");
    expect(r1.summary).not.toBe("[SILENT]");
    expect(r1.state.cursor).toBe(String(12_000_000 + 59 * 1000));

    // Fire 2 (using fire-1's state): `after:` excludes the backlog => silent.
    const r2 = await detect({ query: "is:unread", state: r1.state }, spawn, "me@example.com");
    expect(r2.kind).toBe("shortCircuit");
    expect(r2.summary).toBe("[SILENT]");
  });

  test("truncated window with a bad newest metadata-get still advances the cursor", async () => {
    const newestId = "stuck-newest";
    const spawn: GwsSpawn = async (args) => {
      const joined = args.join(" ");
      if (joined.includes("messages list")) {
        const tail = Array.from({ length: 20 }, (_, i) => [`s${i}`]);
        return pagedListResponse([[newestId], ...tail], true);
      }
      if (joined.includes("messages get")) return PREAMBLE + "{}"; // no internalDate
      return PREAMBLE + "{}";
    };
    const r = await detect({ query: "is:unread", state: { cursor: "1000", seen: [] } }, spawn, "me@example.com");
    expect(r.kind).toBe("shortCircuit");
    expect(r.summary).toContain("backlog");
    expect(Number(r.state.cursor)).toBeGreaterThan(1000);
  });

  test("a healthy tick stamps status:ok into the returned state", async () => {
    const spawn = stubSpawn(["m2", "m1"], {
      m1: { id: "m1", internalDate: "1000", from: "alice@x.com", subject: "a" },
      m2: { id: "m2", internalDate: "2000", from: "alice@x.com", subject: "b" }
    });
    // Seeding tick.
    const seed = await detect({ query: "is:unread", state: null }, spawn, "me@example.com");
    expect(seed.state.status).toBe("ok");
    // Steady tick with a new match.
    const steady = await detect(
      { query: "is:unread", state: { cursor: "1000", seen: [] } },
      stubSpawn(["m3"], { m3: { id: "m3", internalDate: "3000", from: "Bob <bob@x.com>", subject: "hi" } }),
      "me@example.com"
    );
    expect(steady.kind).toBe("context");
    expect(steady.state.status).toBe("ok");
  });

  test("dedup: an already-seen boundary id does not re-trigger", async () => {
    // m9 sits at the cursor's boundary second and is already in `seen`.
    const spawn = stubSpawn(["m9"], {
      m9: { id: "m9", internalDate: "5000", from: "alice@x.com", subject: "old" }
    });
    const r = await detect(
      { query: "is:unread", state: { cursor: "5000", seen: ["m9"] } },
      spawn,
      "me@example.com"
    );
    expect(r.kind).toBe("shortCircuit");
  });
});

describe("detect — body in matched items", () => {
  // base64url-encode a string the way Gmail returns part `body.data`.
  function b64url(s: string): string {
    return Buffer.from(s, "utf8").toString("base64url");
  }

  // A `messages get format=full` response with a single text/plain part.
  function fullPlainResponse(id: string, meta: Meta, plain: string): string {
    return (
      PREAMBLE +
      JSON.stringify({
        id,
        internalDate: meta.internalDate,
        snippet: meta.snippet ?? "",
        payload: {
          mimeType: "text/plain",
          headers: [{ name: "From", value: meta.from ?? "" }],
          body: { data: b64url(plain) }
        }
      })
    );
  }

  // A `messages get format=full` response with a multipart text/html part only.
  function fullHtmlResponse(id: string, meta: Meta, html: string): string {
    return (
      PREAMBLE +
      JSON.stringify({
        id,
        internalDate: meta.internalDate,
        snippet: meta.snippet ?? "",
        payload: {
          mimeType: "multipart/alternative",
          headers: [{ name: "From", value: meta.from ?? "" }],
          parts: [{ mimeType: "text/html", body: { data: b64url(html) } }]
        }
      })
    );
  }

  // Was `format=full` requested in this `messages get` args line?
  function isFullGet(joined: string): boolean {
    return joined.includes("messages get") && joined.includes('"format":"full"');
  }

  test("a matched item carries the fetched text/plain body", async () => {
    const meta: Meta = { id: "m2", internalDate: "3000", from: "Alice <alice@x.com>", subject: "offer", snippet: "short snippet" };
    const fullBody = "Hi there — here is the full body of the email with the real content.";
    const spawn: GwsSpawn = async (args) => {
      const joined = args.join(" ");
      if (joined.includes("messages list")) return listResponse(["m2"]);
      if (isFullGet(joined)) return fullPlainResponse("m2", meta, fullBody);
      if (joined.includes("messages get")) return metadataResponse(meta);
      return PREAMBLE + "{}";
    };
    const r = await detect(
      { query: "from:alice@x.com", state: { cursor: "1000", seen: [] } },
      spawn,
      "me@example.com"
    );
    expect(r.kind).toBe("context");
    expect(itemPayload(r.items![0]!.text).body).toBe(fullBody);
  });

  test("a body-fetch error falls back to the snippet without failing the tick", async () => {
    const meta: Meta = { id: "m2", internalDate: "3000", from: "Alice <alice@x.com>", subject: "offer", snippet: "snippet fallback" };
    const spawn: GwsSpawn = async (args) => {
      const joined = args.join(" ");
      if (joined.includes("messages list")) return listResponse(["m2"]);
      // The full-format body fetch throws; detection must degrade to the snippet.
      if (isFullGet(joined)) throw new Error("transport blew up");
      if (joined.includes("messages get")) return metadataResponse(meta);
      return PREAMBLE + "{}";
    };
    const r = await detect(
      { query: "from:alice@x.com", state: { cursor: "1000", seen: [] } },
      spawn,
      "me@example.com"
    );
    // The tick still produces the match — body is the snippet, not a thrown fault.
    expect(r.kind).toBe("context");
    expect(matchCount(r.items)).toBe(1);
    expect(itemPayload(r.items![0]!.text).body).toBe("snippet fallback");
  });

  test("a text/html-only body is tag-stripped", async () => {
    const meta: Meta = { id: "m2", internalDate: "3000", from: "Alice <alice@x.com>", subject: "offer", snippet: "s" };
    const html = "<html><head><style>p{color:red}</style></head><body><p>Hello&nbsp;<b>world</b></p></body></html>";
    const spawn: GwsSpawn = async (args) => {
      const joined = args.join(" ");
      if (joined.includes("messages list")) return listResponse(["m2"]);
      if (isFullGet(joined)) return fullHtmlResponse("m2", meta, html);
      if (joined.includes("messages get")) return metadataResponse(meta);
      return PREAMBLE + "{}";
    };
    const r = await detect(
      { query: "from:alice@x.com", state: { cursor: "1000", seen: [] } },
      spawn,
      "me@example.com"
    );
    const body = itemPayload(r.items![0]!.text).body as string;
    // Tags + the <style> block stripped; entity decoded; whitespace collapsed.
    expect(body).toBe("Hello world");
    expect(body).not.toContain("<");
    expect(body).not.toContain("color:red");
  });

  test("a long body is truncated with a marker", async () => {
    const meta: Meta = { id: "m2", internalDate: "3000", from: "Alice <alice@x.com>", subject: "offer", snippet: "s" };
    const long = "x".repeat(5000);
    const spawn: GwsSpawn = async (args) => {
      const joined = args.join(" ");
      if (joined.includes("messages list")) return listResponse(["m2"]);
      if (isFullGet(joined)) return fullPlainResponse("m2", meta, long);
      if (joined.includes("messages get")) return metadataResponse(meta);
      return PREAMBLE + "{}";
    };
    const r = await detect(
      { query: "from:alice@x.com", state: { cursor: "1000", seen: [] } },
      spawn,
      "me@example.com"
    );
    const body = itemPayload(r.items![0]!.text).body as string;
    expect(body.endsWith("…[truncated]")).toBe(true);
    expect(body.length).toBe(4000 + "…[truncated]".length);
  });

  test("a silent seed (head is only self) does NOT fetch a body (no format=full get)", async () => {
    let fullGets = 0;
    const spawn: GwsSpawn = async (args) => {
      const joined = args.join(" ");
      if (joined.includes("messages list")) return listResponse(["m2", "m1"]);
      if (isFullGet(joined)) {
        fullGets += 1;
        return PREAMBLE + "{}";
      }
      if (joined.includes("messages get")) {
        const id = getArgId(joined)!;
        // Every head message is our OWN => silent seed, no body fetch.
        return metadataResponse({ id, internalDate: id === "m2" ? "2000" : "1000", from: "me@example.com" });
      }
      return PREAMBLE + "{}";
    };
    const r = await detect({ query: "from:alice@x.com", state: null }, spawn, "me@example.com");
    expect(r.kind).toBe("shortCircuit"); // silent seed (self-only head), drafts nothing
    expect(fullGets).toBe(0);
  });

  test("a short-circuit (only-dropped) tick does NOT fetch a body", async () => {
    let fullGets = 0;
    const spawn: GwsSpawn = async (args) => {
      const joined = args.join(" ");
      if (joined.includes("messages list")) return listResponse(["m2"]);
      if (isFullGet(joined)) {
        fullGets += 1;
        return PREAMBLE + "{}";
      }
      // The only new message is automated => dropped, no surviving match.
      if (joined.includes("messages get")) return metadataResponse({ id: "m2", internalDate: "3000", from: "no-reply@x.com", subject: "auto" });
      return PREAMBLE + "{}";
    };
    const r = await detect(
      { query: "in:inbox", state: { cursor: "1000", seen: [] } },
      spawn,
      "me@example.com"
    );
    expect(r.kind).toBe("shortCircuit");
    // The dropped message never triggers a body fetch.
    expect(fullGets).toBe(0);
  });
});

describe("detect — thread mode", () => {
  // A `threads get format=metadata` response: the whole conversation's
  // message metadata in one document.
  function threadResponse(threadId: string, metas: Meta[]): string {
    return (
      PREAMBLE +
      JSON.stringify({
        id: threadId,
        messages: metas.map((m) => ({
          id: m.id,
          threadId,
          internalDate: m.internalDate,
          snippet: m.snippet ?? "",
          payload: {
            headers: [
              { name: "From", value: m.from ?? "" },
              { name: "Subject", value: m.subject ?? "" },
              { name: "Date", value: m.date ?? "" }
            ]
          }
        }))
      })
    );
  }

  function threadSpawn(threadId: string, metas: Meta[]): GwsSpawn {
    return async (args) => {
      const joined = args.join(" ");
      if (joined.includes("threads get")) return threadResponse(threadId, metas);
      return PREAMBLE + "{}";
    };
  }

  test("fetches the thread via a metadata-level threads get", async () => {
    const calls: string[] = [];
    const spawn: GwsSpawn = async (args) => {
      calls.push(args.join(" "));
      return threadResponse("t-1", []);
    };
    await detect({ query: "thread:t-1", threadId: "t-1", state: null }, spawn, "me@example.com");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("gmail users threads get");
    expect(calls[0]).toContain('"id":"t-1"');
    expect(calls[0]).toContain('"format":"metadata"');
    // Metadata only — never bodies. To + Message-ID ride for cross-account dedup.
    expect(calls[0]).toContain('"metadataHeaders":["From","Subject","Date","To","Message-ID"]');
  });

  test("a single-quote-bearing threadId is shell-neutralized in the spawned --params arg", async () => {
    // The serialized --params is single-quoted for `zsh -lc`. A crafted threadId
    // carrying a single quote must not break out of that quoting and inject a
    // command — every embedded quote is shell-escaped to '\''.
    const evil = `x'; touch /tmp/PWNED; '`;
    let paramsArg = "";
    const spawn: GwsSpawn = async (args) => {
      const i = args.indexOf("--params");
      if (i >= 0) paramsArg = args[i + 1]!;
      return threadResponse(evil, []);
    };
    await detect({ query: `thread:${evil}`, threadId: evil, state: null }, spawn, "me@example.com");
    // The arg is `'<body>'` where every single quote inside <body> is the
    // escape sequence '\'' (close-quote, literal-quote, reopen-quote). Replay
    // what the shell does — drop the outer quotes, turn each '\'' back into one
    // literal quote — and the result is exactly the original JSON: the crafted
    // value can't break out and the injected command never becomes a token.
    expect(paramsArg.startsWith("'") && paramsArg.endsWith("'")).toBe(true);
    const shellValue = paramsArg.slice(1, -1).split(`'\\''`).join("'");
    expect(JSON.parse(shellValue).id).toBe(evil);
  });

  test("seeding stays silent when the newest thread message is self", async () => {
    const spawn = threadSpawn("t-1", [
      { id: "m1", internalDate: "1000", from: "support@x.com", subject: "case opened" },
      { id: "m2", internalDate: "2000", from: "me@example.com", subject: "re: case" }
    ]);
    const r = await detect({ query: "thread:t-1", threadId: "t-1", state: null }, spawn, "me@example.com");
    // The thread's last word is ours (the ball is in their court) => silent seed.
    expect(r.kind).toBe("shortCircuit");
    expect(r.state.cursor).toBe("2000");
    expect(r.state.seen).toEqual(["m2"]);
    expect(r.state.status).toBe("ok");
  });

  test("seeding drafts the newest thread message when it is from the counterparty", async () => {
    const spawn = threadSpawn("t-1", [
      { id: "m1", internalDate: "1000", from: "me@example.com", subject: "case opened" },
      // The counterparty has already replied — the pending message a watch added
      // to this thread should draft a reply to immediately.
      { id: "m2", internalDate: "2000", from: "support@x.com", subject: "re: case", snippet: "here's our answer" }
    ]);
    const r = await detect(
      { query: "thread:t-1", threadId: "t-1", objective: "Get a refund", state: null },
      spawn,
      "me@example.com"
    );
    expect(r.kind).toBe("context");
    expect(draftedIds(r.items)).toEqual(["m2"]);
    // The seeded draft carries the thread id + the standing objective.
    expect(itemPayload(r.items![0]!.text).threadId).toBe("t-1");
    const trusted = r.items!.filter((i) => !i.untrusted);
    expect(trusted).toHaveLength(1);
    expect(trusted[0]!.text).toBe("Objective for this watch (thread:t-1): Get a refund");
    // Baselined at the newest; only that one message rides forward in `seen`.
    expect(r.state.cursor).toBe("2000");
    expect(r.state.seen).toEqual(["m2"]);
    // The next tick (with the seeded state) re-detects nothing => no re-draft.
    const steady = await detect({ query: "thread:t-1", threadId: "t-1", state: r.state }, spawn, "me@example.com");
    expect(steady.kind).toBe("shortCircuit");
  });

  test("a rotated automated address triggers (no automated filter); self never does", async () => {
    const spawn = threadSpawn("t-1", [
      { id: "m1", internalDate: "1000", from: "support@x.com", subject: "case" },
      // The ticket system replies from a rotated no-reply address — exactly
      // what a thread watch exists to catch.
      { id: "m2", internalDate: "3000", from: "Case 123 <no-reply@case-123.x.zendesk.com>", subject: "update", snippet: "we shipped it" },
      // Our own reply advances the cursor but never triggers.
      { id: "m3", internalDate: "4000", from: "Me <me@example.com>", subject: "re: update" }
    ]);
    const r = await detect(
      { query: "thread:t-1", threadId: "t-1", state: { cursor: "1000", seen: ["m1"] } },
      spawn,
      "me@example.com"
    );
    expect(r.kind).toBe("context");
    expect(matchCount(r.items)).toBe(1);
    expect(draftedIds(r.items)).toEqual(["m2"]);
    // The match payload carries the thread id so the drafting turn reads the
    // full conversation.
    expect(itemPayload(r.items![0]!.text).threadId).toBe("t-1");
    // Cursor advanced past our own reply too.
    expect(r.state.cursor).toBe("4000");
    expect(r.state.seen).toEqual(["m3"]);
  });

  test("a surviving thread match carries the fetched body; a silent (self-newest) seed does not fetch one", async () => {
    let fullGets = 0;
    const fullBody = "The ticket bot's full reply with the substantive content.";
    // Seeding-state thread: the newest message is OUR OWN => silent seed.
    let seedingThread = true;
    const spawn: GwsSpawn = async (args) => {
      const joined = args.join(" ");
      if (joined.includes("messages get") && joined.includes('"format":"full"')) {
        fullGets += 1;
        return (
          PREAMBLE +
          JSON.stringify({
            id: "m2",
            payload: { mimeType: "text/plain", body: { data: Buffer.from(fullBody, "utf8").toString("base64url") } }
          })
        );
      }
      if (joined.includes("threads get")) {
        return seedingThread
          ? threadResponse("t-1", [
              { id: "m1", internalDate: "1000", from: "support@x.com", subject: "case" },
              { id: "m0", internalDate: "1500", from: "me@example.com", subject: "our last word" }
            ])
          : threadResponse("t-1", [
              { id: "m1", internalDate: "1000", from: "support@x.com", subject: "case" },
              { id: "m2", internalDate: "3000", from: "bot@x.zendesk.com", subject: "update", snippet: "short" }
            ]);
      }
      return PREAMBLE + "{}";
    };
    // Seeding tick on a self-newest thread drafts nothing => no body fetch.
    const seed = await detect({ query: "thread:t-1", threadId: "t-1", state: null }, spawn, "me@example.com");
    expect(seed.kind).toBe("shortCircuit");
    expect(fullGets).toBe(0);

    // Steady tick: the bot's new message survives => its body is fetched.
    seedingThread = false;
    const r = await detect(
      { query: "thread:t-1", threadId: "t-1", state: { cursor: "1000", seen: ["m1"] } },
      spawn,
      "me@example.com"
    );
    expect(r.kind).toBe("context");
    expect(draftedIds(r.items)).toEqual(["m2"]);
    expect(itemPayload(r.items![0]!.text).body).toBe(fullBody);
    expect(fullGets).toBe(1);
  });

  test("a self-only new message advances the cursor silently", async () => {
    const spawn = threadSpawn("t-1", [
      { id: "m1", internalDate: "1000", from: "support@x.com", subject: "case" },
      { id: "m2", internalDate: "5000", from: "me@example.com", subject: "our reply" }
    ]);
    const r = await detect(
      { query: "thread:t-1", threadId: "t-1", state: { cursor: "1000", seen: ["m1"] } },
      spawn,
      "me@example.com"
    );
    expect(r.kind).toBe("shortCircuit");
    expect(r.state.cursor).toBe("5000");
  });

  test("a matched thread tick appends the trusted objective item with a thread label", async () => {
    const spawn = threadSpawn("t-9", [
      { id: "m1", internalDate: "1000", from: "support@x.com", subject: "case" },
      { id: "m2", internalDate: "2000", from: "agent@x.zendesk.com", subject: "offer" }
    ]);
    const r = await detect(
      { query: "thread:t-9", threadId: "t-9", objective: "Get a full refund", state: { cursor: "1000", seen: ["m1"] } },
      spawn,
      "me@example.com"
    );
    expect(r.kind).toBe("context");
    const trusted = r.items!.filter((i) => !i.untrusted);
    expect(trusted).toHaveLength(1);
    expect(trusted[0]!.text).toBe("Objective for this watch (thread:t-9): Get a full refund");
  });

  test("follow-up nudge fires once per outbound message when the counterparty is silent", async () => {
    // Our own message is the thread's last, sent far past the 24h threshold.
    const spawn = threadSpawn("t-1", [
      { id: "m1", internalDate: "1000", from: "support@x.com", subject: "case" },
      { id: "m2", internalDate: "2000", from: "me@example.com", subject: "our offer" }
    ]);
    const args = {
      query: "thread:t-1",
      threadId: "t-1",
      followUpAfterHours: 24,
      objective: "Get a refund",
      state: { cursor: "2000", seen: ["m2"] }
    };
    const r1 = await detect(args, spawn, "me@example.com");
    // The nudge wakes a model turn (context) with TRUSTED items only: the
    // nudge notice + the objective.
    expect(r1.kind).toBe("context");
    expect(matchCount(r1.items)).toBe(0);
    const trusted = r1.items!.filter((i) => !i.untrusted);
    expect(trusted).toHaveLength(2);
    expect(trusted[0]!.text).toContain("No reply on this watched thread since 1970-01-01T00:00:02.000Z (over 24 hours).");
    expect(trusted[0]!.text).toContain("Draft a polite follow-up that advances the objective.");
    expect(trusted[1]!.text).toBe("Objective for this watch (thread:t-1): Get a refund");
    expect(r1.state.lastNudgedForMessageId).toBe("m2");

    // Same outbound message on the next tick => NO second nudge (the id is
    // pinned), not a nudge-per-tick storm.
    const r2 = await detect({ ...args, state: r1.state }, spawn, "me@example.com");
    expect(r2.kind).toBe("shortCircuit");
    expect(r2.state.lastNudgedForMessageId).toBe("m2");
  });

  test("follow-up nudge respects the threshold and the last-sender", async () => {
    // Last message is ours but RECENT — below the threshold, no nudge.
    const recent = String(Date.now() - 60_000);
    const recentSpawn = threadSpawn("t-1", [
      { id: "m1", internalDate: "1000", from: "support@x.com", subject: "case" },
      { id: "m2", internalDate: recent, from: "me@example.com", subject: "ours" }
    ]);
    const r1 = await detect(
      { query: "thread:t-1", threadId: "t-1", followUpAfterHours: 24, state: { cursor: recent, seen: ["m2"] } },
      recentSpawn,
      "me@example.com"
    );
    expect(r1.kind).toBe("shortCircuit");
    expect(r1.state.lastNudgedForMessageId).toBeUndefined();

    // Last message is THEIRS (old) — the ball is in our court, no nudge.
    const theirsSpawn = threadSpawn("t-1", [
      { id: "m1", internalDate: "1000", from: "me@example.com", subject: "ours" },
      { id: "m2", internalDate: "2000", from: "support@x.com", subject: "theirs" }
    ]);
    const r2 = await detect(
      { query: "thread:t-1", threadId: "t-1", followUpAfterHours: 24, state: { cursor: "2000", seen: ["m2"] } },
      theirsSpawn,
      "me@example.com"
    );
    expect(r2.kind).toBe("shortCircuit");
    expect(r2.state.lastNudgedForMessageId).toBeUndefined();
  });

  test("a newer outbound message resets the nudge cycle", async () => {
    // Already nudged for m2; a NEWER self message m3 (also past the
    // threshold) changes the last-message id => a fresh nudge.
    const spawn = threadSpawn("t-1", [
      { id: "m1", internalDate: "1000", from: "support@x.com", subject: "case" },
      { id: "m2", internalDate: "2000", from: "me@example.com", subject: "first follow-up" },
      { id: "m3", internalDate: "3000", from: "me@example.com", subject: "second follow-up" }
    ]);
    const r = await detect(
      {
        query: "thread:t-1",
        threadId: "t-1",
        followUpAfterHours: 24,
        state: { cursor: "3000", seen: ["m3"], lastNudgedForMessageId: "m2" }
      },
      spawn,
      "me@example.com"
    );
    expect(r.kind).toBe("context");
    expect(r.state.lastNudgedForMessageId).toBe("m3");
  });

  test("thread detection is at-least-once: old state re-detects, new state goes silent", async () => {
    const spawn = threadSpawn("t-1", [
      { id: "m1", internalDate: "1000", from: "support@x.com", subject: "case" },
      { id: "m2", internalDate: "2000", from: "bot@x.zendesk.com", subject: "update" }
    ]);
    const oldState = { cursor: "1000", seen: ["m1"] };
    const r1 = await detect({ query: "thread:t-1", threadId: "t-1", state: oldState }, spawn, "me@example.com");
    expect(draftedIds(r1.items)).toEqual(["m2"]);
    // Commit skipped => re-run with the old state re-detects the same message.
    const r2 = await detect({ query: "thread:t-1", threadId: "t-1", state: oldState }, spawn, "me@example.com");
    expect(draftedIds(r2.items)).toEqual(["m2"]);
    // Committed state => silent.
    const r3 = await detect({ query: "thread:t-1", threadId: "t-1", state: r1.state }, spawn, "me@example.com");
    expect(r3.kind).toBe("shortCircuit");
  });

  // A gws error BODY (exit 0) on a `threads get` — a missing/inaccessible thread
  // yields `{"error":{...}}`, not an empty thread. It must surface as a watch
  // fault (status:"error" + a lastError), NOT seed-to-now / short-circuit ok.
  function threadErrorSpawn(body: Record<string, unknown>): GwsSpawn {
    return async (args) => {
      const joined = args.join(" ");
      if (joined.includes("auth status")) return PREAMBLE + '{"token_valid":true}';
      if (joined.includes("getProfile")) return PREAMBLE + '{"emailAddress":"me@example.com"}';
      if (joined.includes("threads get")) return PREAMBLE + JSON.stringify(body);
      return PREAMBLE + "{}";
    };
  }
  const NOT_FOUND_BODY = { error: { code: 404, message: "Requested entity was not found.", reason: "notFound" } };

  test("a 404 error body on a steady-state thread tick reports error, cursor unchanged", async () => {
    const r = await run(
      { query: "thread:t-x", threadId: "t-x", state: { cursor: "5000", seen: ["m1"] } },
      threadErrorSpawn(NOT_FOUND_BODY)
    );
    // Surfaced as a fault, NOT swallowed as an empty thread.
    expect(r.kind).toBe("shortCircuit");
    expect(r.state.status).toBe("error");
    expect(r.state.lastError && r.state.lastError.length > 0).toBe(true);
    // Cursor/seen preserved — NOT advanced, NOT seeded to now().
    expect(r.state.cursor).toBe("5000");
    expect(r.state.seen).toEqual(["m1"]);
  });

  test("a 404 error body on the FIRST (seeding) thread tick reports error, no baseline cursor", async () => {
    const r = await run(
      { query: "thread:t-x", threadId: "t-x", state: null },
      threadErrorSpawn(NOT_FOUND_BODY)
    );
    expect(r.kind).toBe("shortCircuit");
    expect(r.state.status).toBe("error");
    expect(r.state.lastError && r.state.lastError.length > 0).toBe(true);
    // No baseline cursor was written (seeding a bad thread must NOT baseline to now).
    expect(r.state.cursor).toBeUndefined();
    expect(r.state.seen).toBeUndefined();
  });

  test("a genuine empty thread still seeds/short-circuits ok (no regression)", async () => {
    const emptyThread: GwsSpawn = async (args) => {
      const joined = args.join(" ");
      if (joined.includes("auth status")) return PREAMBLE + '{"token_valid":true}';
      if (joined.includes("getProfile")) return PREAMBLE + '{"emailAddress":"me@example.com"}';
      if (joined.includes("threads get")) return threadResponse("t-e", []);
      return PREAMBLE + "{}";
    };
    const r = await run({ query: "thread:t-e", threadId: "t-e", state: null }, emptyThread);
    expect(r.kind).toBe("shortCircuit");
    expect(r.state.status).toBe("ok");
    expect(r.state.lastError).toBeUndefined();
    // An empty (but valid) thread baselines to now() as before.
    expect(Number(r.state.cursor)).toBeGreaterThan(0);
  });

  test("a thread error body's lastError is scrubbed (no raw paths leak)", async () => {
    const r = await run(
      { query: "thread:t-x", threadId: "t-x", state: { cursor: "5000", seen: [] } },
      threadErrorSpawn({ error: { code: 500, message: "boom reading /Users/alice/.config/gws/token.json", reason: "backendError" } })
    );
    expect(r.state.status).toBe("error");
    expect(r.state.lastError).not.toContain("/Users/alice");
    expect(r.state.lastError).toContain("<path>");
  });

  test("a same-second-as-cursor message visible on a later tick is still drafted", async () => {
    // Gmail internalDate is second-granular: our outbound and the ticket bot's
    // auto-ack land in the same epoch second. The bot's message is visible only
    // on a later tick, so a ms-exact `> cursor` test would drop it forever.
    const cursor = "1780000000000"; // our reply, at the cursor second
    const sibling = "1780000000000"; // bot reply, SAME second, not yet seen
    const spawn = threadSpawn("t-1", [
      { id: "m1", internalDate: "1779990000000", from: "support@x.com", subject: "case" },
      { id: "m2", internalDate: cursor, from: "me@example.com", subject: "our offer" },
      { id: "m3", internalDate: sibling, from: "bot@x.zendesk.com", subject: "auto-ack", snippet: "received" }
    ]);
    const r = await detect(
      { query: "thread:t-1", threadId: "t-1", state: { cursor, seen: ["m2"] } },
      spawn,
      "me@example.com"
    );
    expect(r.kind).toBe("context");
    expect(draftedIds(r.items)).toEqual(["m3"]);
    // Both same-second ids ride forward in `seen` so neither re-drafts next tick.
    expect(new Set(r.state.seen)).toEqual(new Set(["m2", "m3"]));
  });

  test("runWatches routes a thread watch through thread detection", async () => {
    const spawn: GwsSpawn = async (args) => {
      const joined = args.join(" ");
      if (joined.includes("auth status")) return PREAMBLE + '{"token_valid":true}';
      if (joined.includes("getProfile")) return PREAMBLE + '{"emailAddress":"me@example.com"}';
      if (joined.includes("threads get")) {
        return threadResponse("t-1", [
          { id: "m1", internalDate: "1000", from: "support@x.com", subject: "case" },
          { id: "m2", internalDate: "2000", from: "no-reply@case-1.x.zendesk.com", subject: "update" }
        ]);
      }
      throw new Error(`unexpected gws call: ${joined}`);
    };
    const r = await runWatches(
      {
        // Legacy byWatcher INPUT is still read transparently (the first new tick
        // rewrites it flat). routeKey defaults to watcherId.
        watches: [{ watcherId: "w-t", query: "thread:t-1", threadId: "t-1" }],
        state: { byWatcher: { "w-t": { cursor: "1000", seen: ["m1"] } } }
      },
      spawn
    );
    expect(r.kind).toBe("context");
    expect(draftedIds(r.buckets!["w-t"])).toEqual(["m2"]);
    expect(r.state["w-t"]!.cursor).toBe("2000");
    expect(r.state["w-t"]!.status).toBe("ok");
  });
});

describe("run — health in state", () => {
  test("signed-out tick emits status:needs_auth with cursor/seen unchanged", async () => {
    const signedOut: GwsSpawn = async (args) => {
      const joined = args.join(" ");
      if (joined.includes("auth status")) return PREAMBLE + '{"token_valid":false}';
      throw new Error("should not poll while signed out");
    };
    const r = await run({ query: "is:unread", state: { cursor: "5000", seen: ["m1"] } }, signedOut);
    expect(r.kind).toBe("shortCircuit");
    expect(r.summary).toBe("[SILENT]");
    expect(r.state.status).toBe("needs_auth");
    // Cursor/seen carried through unchanged (don't advance past unread mail).
    expect(r.state.cursor).toBe("5000");
    expect(r.state.seen).toEqual(["m1"]);
    expect(r.state.lastError).toBeUndefined();
  });

  test("gws-error tick emits status:error + a scrubbed lastError, cursor/seen unchanged", async () => {
    const erroring: GwsSpawn = async (args) => {
      const joined = args.join(" ");
      if (joined.includes("auth status")) return PREAMBLE + '{"token_valid":true}';
      throw new Error("transport blew up reading /Users/alice/.config/gws/token.json");
    };
    const r = await run({ query: "is:unread", state: { cursor: "7000", seen: ["m2"] } }, erroring);
    expect(r.kind).toBe("shortCircuit");
    expect(r.state.status).toBe("error");
    expect(r.state.lastError).toBe("transport blew up reading <path>");
    expect(r.state.cursor).toBe("7000");
    expect(r.state.seen).toEqual(["m2"]);
  });

  test("a list error body (exit 0) reports status:error, cursor/seen unchanged", async () => {
    // gws can return a Google API error as a JSON body on a `messages list` too.
    // It is a fault, not an empty window — surface it, don't seed/advance.
    const listError: GwsSpawn = async (args) => {
      const joined = args.join(" ");
      if (joined.includes("auth status")) return PREAMBLE + '{"token_valid":true}';
      if (joined.includes("getProfile")) return PREAMBLE + '{"emailAddress":"me@example.com"}';
      if (joined.includes("messages list")) {
        return PREAMBLE + JSON.stringify({ error: { code: 400, message: "Invalid query.", reason: "invalidArgument" } });
      }
      return PREAMBLE + "{}";
    };
    const r = await run({ query: "is:unread", state: { cursor: "7000", seen: ["m2"] } }, listError);
    expect(r.kind).toBe("shortCircuit");
    expect(r.state.status).toBe("error");
    expect(r.state.lastError && r.state.lastError.length > 0).toBe(true);
    expect(r.state.cursor).toBe("7000");
    expect(r.state.seen).toEqual(["m2"]);
  });

  test("a healthy signed-in tick returns detect's status:ok result", async () => {
    const healthy: GwsSpawn = async (args) => {
      const joined = args.join(" ");
      if (joined.includes("auth status")) return PREAMBLE + '{"token_valid":true}';
      if (joined.includes("getProfile")) return PREAMBLE + '{"emailAddress":"me@example.com"}';
      if (joined.includes("messages list")) return listResponse(["m2", "m1"]);
      // Every head message is our own => a silent seed (drafts nothing).
      if (joined.includes("messages get")) {
        const id = getArgId(joined)!;
        return metadataResponse({ id, internalDate: id === "m2" ? "2000" : "1000", from: "me@example.com" });
      }
      return PREAMBLE + "{}";
    };
    const r = await run({ query: "is:unread", state: null }, healthy);
    expect(r.kind).toBe("shortCircuit"); // silent seed (self-only head)
    expect(r.state.status).toBe("ok");
    expect(r.state.lastError).toBeUndefined();
  });
});

describe("detect — at-least-once boundary", () => {
  test("the context state is returned but the caller persists it only after dispatch", async () => {
    // The engine returns the advanced cursor on a context result; the consumer
    // persists it ONLY after dispatch. Re-running with the OLD state (a skipped
    // commit) re-detects the same match — at-least-once across delivery.
    const spawn = stubSpawn(["d1"], {
      d1: { id: "d1", internalDate: "6000", from: "Alice <alice@x.com>", subject: "hi" }
    });
    const oldState = { cursor: "1000", seen: [] as string[] };
    const r1 = await detect({ query: "is:unread", state: oldState }, spawn, "me@example.com");
    expect(matchCount(r1.items)).toBe(1);
    expect(r1.state.cursor).toBe("6000");

    // Commit skipped (dispatch threw) => re-run with oldState => re-detects d1.
    const r2 = await detect({ query: "is:unread", state: oldState }, spawn, "me@example.com");
    expect(matchCount(r2.items)).toBe(1);
    expect(draftedIds(r2.items)).toEqual(["d1"]);
  });
});

describe("runWatches — multi-watch (one shared job)", () => {
  // Extract the `q:"..."` value from a `messages list` args line so a stub can
  // route per-watch by query (each watch lists under its own query).
  function listQuery(joined: string): string | undefined {
    return joined.match(/"q":"([^"]*)"/)?.[1];
  }

  // gws spawn routing list/get per-query: each query maps to a flat id list +
  // shared metadata map. signedIn is true; getProfile resolves the self address.
  function multiSpawn(
    byQuery: Record<string, string[]>,
    metaById: Record<string, Meta>,
    self = "me@example.com"
  ): GwsSpawn {
    return async (args: string[]) => {
      const joined = args.join(" ");
      if (joined.includes("auth status")) return PREAMBLE + '{"token_valid":true}';
      if (joined.includes("getProfile")) return PREAMBLE + JSON.stringify({ emailAddress: self });
      if (joined.includes("messages list")) {
        const q = listQuery(joined) ?? "";
        // Honor any after:<sec> the engine appended to the watch's base query.
        const base = q.replace(/ after:\d+$/, "");
        return listResponse(byQuery[base] ?? byQuery[q] ?? []);
      }
      if (joined.includes("messages get")) {
        const hit = getArgId(joined);
        return hit && metaById[hit] ? metadataResponse(metaById[hit]) : PREAMBLE + "{}";
      }
      return PREAMBLE + "{}";
    };
  }

  test("iterates watches with per-watch state, drafts across senders in one turn", async () => {
    const spawn = multiSpawn(
      {
        "from:alice@x.com is:unread": ["a1"],
        "from:bob@x.com is:unread": ["b1"]
      },
      {
        a1: { id: "a1", internalDate: "3000", from: "Alice <alice@x.com>", subject: "from alice" },
        b1: { id: "b1", internalDate: "4000", from: "Bob <bob@x.com>", subject: "from bob" }
      }
    );
    const r = await runWatches(
      {
        watches: [
          { watcherId: "w-alice", routeKey: "w-alice", query: "from:alice@x.com is:unread", sender: "alice@x.com" },
          { watcherId: "w-bob", routeKey: "w-bob", query: "from:bob@x.com is:unread", sender: "bob@x.com" }
        ],
        state: { "w-alice": { cursor: "1000", seen: [] }, "w-bob": { cursor: "1000", seen: [] } }
      },
      spawn
    );
    // Each concern gets its OWN bucket keyed by routeKey, each match labeled by sender.
    expect(r.kind).toBe("context");
    expect(matchCount(r.buckets!["w-alice"])).toBe(1);
    expect(matchCount(r.buckets!["w-bob"])).toBe(1);
    expect(r.buckets!["w-alice"]!.some((i) => i.text.startsWith("New email from Alice <alice@x.com> — "))).toBe(true);
    expect(r.buckets!["w-bob"]!.some((i) => i.text.startsWith("New email from Bob <bob@x.com> — "))).toBe(true);
    // Per-watch state advanced independently, keyed by routeKey at the top level.
    expect(r.state["w-alice"]!.cursor).toBe("3000");
    expect(r.state["w-bob"]!.cursor).toBe("4000");
    expect(r.state["w-alice"]!.status).toBe("ok");
    expect(r.state["w-bob"]!.status).toBe("ok");
  });

  test("a per-watch gws error isolates to that watch; the others still draft", async () => {
    const spawn: GwsSpawn = async (args) => {
      const joined = args.join(" ");
      if (joined.includes("auth status")) return PREAMBLE + '{"token_valid":true}';
      if (joined.includes("getProfile")) return PREAMBLE + '{"emailAddress":"me@example.com"}';
      if (joined.includes("messages list")) {
        const q = listQuery(joined) ?? "";
        // The "bad" watch's list throws; the "good" watch lists a match.
        if (q.startsWith("from:bad@x.com")) {
          throw new Error("transport blew up reading /Users/alice/.config/gws/token.json");
        }
        return listResponse(["g1"]);
      }
      if (joined.includes("messages get")) {
        const hit = getArgId(joined);
        return hit === "g1"
          ? metadataResponse({ id: "g1", internalDate: "5000", from: "Good <good@x.com>", subject: "ok" })
          : PREAMBLE + "{}";
      }
      return PREAMBLE + "{}";
    };
    const r = await runWatches(
      {
        watches: [
          { watcherId: "w-bad", query: "from:bad@x.com is:unread", sender: "bad@x.com" },
          { watcherId: "w-good", query: "from:good@x.com is:unread", sender: "good@x.com" }
        ],
        state: { "w-bad": { cursor: "1000", seen: [] }, "w-good": { cursor: "1000", seen: [] } }
      },
      spawn
    );
    // The good watch still drafts into its bucket; the bad watch is marked error
    // with a SCRUBBED lastError and its cursor unchanged (no bucket for it).
    expect(r.kind).toBe("context");
    expect(r.buckets!["w-bad"]).toBeUndefined();
    expect(draftedIds(r.buckets!["w-good"])).toEqual(["g1"]);
    expect(r.state["w-good"]!.status).toBe("ok");
    expect(r.state["w-good"]!.cursor).toBe("5000");
    expect(r.state["w-bad"]!.status).toBe("error");
    expect(r.state["w-bad"]!.lastError).toBe("transport blew up reading <path>");
    expect(r.state["w-bad"]!.cursor).toBe("1000");
  });

  test("signed-out marks every watch needs_auth, no model turn, cursors unchanged", async () => {
    const signedOut: GwsSpawn = async (args) => {
      const joined = args.join(" ");
      if (joined.includes("auth status")) return PREAMBLE + '{"token_valid":false}';
      throw new Error("should not poll while signed out");
    };
    const r = await runWatches(
      {
        watches: [
          { watcherId: "w1", query: "from:a@x.com is:unread", sender: "a@x.com" },
          { watcherId: "w2", query: "from:b@x.com is:unread", sender: "b@x.com" }
        ],
        state: { w1: { cursor: "1000", seen: ["x"] }, w2: { cursor: "2000", seen: [] } }
      },
      signedOut
    );
    expect(r.kind).toBe("shortCircuit");
    expect(r.summary).toBe("[SILENT]");
    expect(r.state.w1!.status).toBe("needs_auth");
    expect(r.state.w2!.status).toBe("needs_auth");
    // Cursors/seen carried through unchanged (don't advance past unread mail).
    expect(r.state.w1!.cursor).toBe("1000");
    expect(r.state.w1!.seen).toEqual(["x"]);
    expect(r.state.w2!.cursor).toBe("2000");
  });

  test("seeding a fresh watch drafts the newest pending inbound and baselines", async () => {
    const spawn = multiSpawn(
      { "from:new@x.com is:unread": ["n1"] },
      { n1: { id: "n1", internalDate: "9000", from: "New <new@x.com>", subject: "hi" } }
    );
    const r = await runWatches(
      { watches: [{ watcherId: "w-new", query: "from:new@x.com is:unread", sender: "new@x.com" }], state: null },
      spawn
    );
    // The newest is a pending non-self inbound => the seeded draft rides the
    // watch's OWN routeKey bucket, and the watch baselines its cursor/seen.
    expect(r.kind).toBe("context");
    expect(draftedIds(r.buckets!["w-new"])).toEqual(["n1"]);
    expect(r.state["w-new"]!.cursor).toBe("9000");
    expect(r.state["w-new"]!.seen).toEqual(["n1"]);
    expect(r.state["w-new"]!.status).toBe("ok");
  });

  test("seeding a fresh watch whose newest is self baselines silently (no bucket)", async () => {
    const spawn = multiSpawn(
      { "from:new@x.com is:unread": ["n1"] },
      { n1: { id: "n1", internalDate: "9000", from: "me@example.com", subject: "our reply" } }
    );
    const r = await runWatches(
      { watches: [{ watcherId: "w-new", query: "from:new@x.com is:unread", sender: "new@x.com" }], state: null },
      spawn
    );
    // The newest is our own message => silent seed, no bucket opened.
    expect(r.kind).toBe("shortCircuit");
    expect(r.summary).toBe("[SILENT]");
    expect(r.state["w-new"]!.cursor).toBe("9000");
    expect(r.state["w-new"]!.seen).toEqual(["n1"]);
    expect(r.state["w-new"]!.status).toBe("ok");
  });

  test("per-watch backlog notices route into each concern's own bucket", async () => {
    // Two watches both hit truncated windows (no draftable match); each watch's
    // notice routes into ITS OWN routeKey bucket as a trusted item, so each
    // concern's worker surfaces its own backlog notice.
    const corpusA: Meta[] = Array.from({ length: 60 }, (_, i) => ({
      id: `a${i}`,
      internalDate: String(12_000_000 + i * 1000),
      from: "Alice <alice@x.com>",
      subject: `a${i}`
    }));
    const corpusB: Meta[] = Array.from({ length: 60 }, (_, i) => ({
      id: `b${i}`,
      internalDate: String(13_000_000 + i * 1000),
      from: "Bob <bob@x.com>",
      subject: `b${i}`
    }));
    const byId: Record<string, Meta> = {};
    for (const m of [...corpusA, ...corpusB]) byId[m.id] = m;
    const spawn: GwsSpawn = async (args) => {
      const joined = args.join(" ");
      if (joined.includes("auth status")) return PREAMBLE + '{"token_valid":true}';
      if (joined.includes("getProfile")) return PREAMBLE + '{"emailAddress":"me@example.com"}';
      if (joined.includes("messages list")) {
        const q = listQuery(joined) ?? "";
        const corpus = q.startsWith("from:alice") ? corpusA : corpusB;
        const afterSec = Number(joined.match(/after:(\d+)/)?.[1] ?? "0");
        const listed = corpus
          .filter((m) => Math.floor(Number(m.internalDate) / 1000) > afterSec)
          .sort((a, b) => Number(b.internalDate) - Number(a.internalDate))
          .slice(0, 10);
        const pages: string[][] = [];
        const per = Math.ceil(listed.length / 10);
        for (let i = 0; i < 10; i++) pages.push(listed.slice(i * per, (i + 1) * per).map((m) => m.id));
        return pagedListResponse(pages, true);
      }
      if (joined.includes("messages get")) {
        const hit = getArgId(joined);
        return hit && byId[hit] ? metadataResponse(byId[hit]) : PREAMBLE + "{}";
      }
      return PREAMBLE + "{}";
    };
    const r = await runWatches(
      {
        watches: [
          { watcherId: "w-a", query: "from:alice@x.com is:unread", sender: "alice@x.com" },
          { watcherId: "w-b", query: "from:bob@x.com is:unread", sender: "bob@x.com" }
        ],
        state: { "w-a": { cursor: "1000", seen: [] }, "w-b": { cursor: "1000", seen: [] } }
      },
      spawn
    );
    // Each notice is a trusted item in its OWN concern's bucket (a context turn).
    expect(r.kind).toBe("context");
    expect(r.buckets!["w-a"]).toHaveLength(1);
    expect(r.buckets!["w-a"]![0]!.untrusted).toBe(false);
    expect(r.buckets!["w-a"]![0]!.text).toContain("from:alice@x.com is:unread");
    expect(r.buckets!["w-b"]![0]!.text).toContain("from:bob@x.com is:unread");
    // Both cursors jumped to their newest.
    expect(r.state["w-a"]!.cursor).toBe(String(12_000_000 + 59 * 1000));
    expect(r.state["w-b"]!.cursor).toBe(String(13_000_000 + 59 * 1000));
  });

  test("a sibling match and a backlog notice land in their own concern buckets", async () => {
    // One watch produces a fresh draftable match; another hits a truncated
    // (page-cap) window in the SAME tick. The match opens the alice bucket; the
    // backlog notice opens the bulk bucket as a TRUSTED item — neither is dropped
    // and both advance their own cursor.
    const backlog: Meta[] = Array.from({ length: 60 }, (_, i) => ({
      id: `bk${i}`,
      internalDate: String(20_000_000 + i * 1000),
      from: "Bulk <bulk@x.com>",
      subject: `bk${i}`
    }));
    const byId: Record<string, Meta> = {
      m1: { id: "m1", internalDate: "5000", from: "Alice <alice@x.com>", subject: "fresh" }
    };
    for (const m of backlog) byId[m.id] = m;
    const spawn: GwsSpawn = async (args) => {
      const joined = args.join(" ");
      if (joined.includes("auth status")) return PREAMBLE + '{"token_valid":true}';
      if (joined.includes("getProfile")) return PREAMBLE + '{"emailAddress":"me@example.com"}';
      if (joined.includes("messages list")) {
        const q = listQuery(joined) ?? "";
        if (q.startsWith("from:alice")) return listResponse(["m1"]);
        // The bulk watch's window is truncated (page cap hit).
        const afterSec = Number(joined.match(/after:(\d+)/)?.[1] ?? "0");
        const listed = backlog
          .filter((m) => Math.floor(Number(m.internalDate) / 1000) > afterSec)
          .sort((a, b) => Number(b.internalDate) - Number(a.internalDate))
          .slice(0, 10);
        const pages: string[][] = [];
        const per = Math.ceil(listed.length / 10);
        for (let i = 0; i < 10; i++) pages.push(listed.slice(i * per, (i + 1) * per).map((m) => m.id));
        return pagedListResponse(pages, true);
      }
      if (joined.includes("messages get")) {
        const hit = getArgId(joined);
        return hit && byId[hit] ? metadataResponse(byId[hit]) : PREAMBLE + "{}";
      }
      return PREAMBLE + "{}";
    };
    const r = await runWatches(
      {
        watches: [
          { watcherId: "w-alice", query: "from:alice@x.com is:unread", sender: "alice@x.com" },
          { watcherId: "w-bulk", query: "from:bulk@x.com is:unread", sender: "bulk@x.com" }
        ],
        state: { "w-alice": { cursor: "1000", seen: [] }, "w-bulk": { cursor: "1000", seen: [] } }
      },
      spawn
    );
    expect(r.kind).toBe("context");
    // Alice's bucket carries exactly her fresh draftable match.
    expect(matchCount(r.buckets!["w-alice"])).toBe(1);
    expect(r.buckets!["w-alice"]!.some((i) => i.untrusted && i.text.startsWith("New email from Alice <alice@x.com> — "))).toBe(true);
    // The bulk bucket carries the backlog notice as a TRUSTED item (not dropped).
    const notice = r.buckets!["w-bulk"]!.filter((i) => !i.untrusted);
    expect(notice).toHaveLength(1);
    expect(notice[0]!.text).toContain("backlog");
    expect(notice[0]!.text).toContain("from:bulk@x.com is:unread");
    // The truncated watch's cursor still jumped to its newest.
    expect(r.state["w-bulk"]!.cursor).toBe(String(20_000_000 + 59 * 1000));
  });

  test("a watch entry's sender + objective ride through to the bypass and the trusted item", async () => {
    const spawn = multiSpawn(
      { "from:noreply@ups.com": ["p1"] },
      { p1: { id: "p1", internalDate: "4000", from: "UPS <noreply@ups.com>", subject: "shipped" } }
    );
    const r = await runWatches(
      {
        watches: [{ watcherId: "w-ups", query: "from:noreply@ups.com", sender: "noreply@ups.com", objective: "Track the package until delivered" }],
        state: { "w-ups": { cursor: "1000", seen: [] } }
      },
      spawn
    );
    expect(r.kind).toBe("context");
    expect(draftedIds(r.buckets!["w-ups"])).toEqual(["p1"]);
    const trusted = r.buckets!["w-ups"]!.filter((i) => !i.untrusted);
    expect(trusted).toHaveLength(1);
    expect(trusted[0]!.text).toBe("Objective for this watch (noreply@ups.com): Track the package until delivered");
  });

  test("no watches yields a silent shortCircuit with empty state", async () => {
    const spawn = multiSpawn({}, {});
    const r = await runWatches({ watches: [], state: null }, spawn);
    expect(r.kind).toBe("shortCircuit");
    expect(r.summary).toBe("[SILENT]");
    expect(r.state).toEqual({});
  });

  test("buckets are keyed by routeKey, defaulting to watcherId", async () => {
    const spawn = multiSpawn(
      { "from:alice@x.com": ["a1"] },
      { a1: { id: "a1", internalDate: "3000", from: "Alice <alice@x.com>", subject: "hi" } }
    );
    const r = await runWatches(
      {
        // routeKey explicitly diverges from watcherId — the bucket + state key follow it.
        watches: [{ watcherId: "w-alice", routeKey: "concern-alice", query: "from:alice@x.com", sender: "alice@x.com" }],
        state: { "concern-alice": { cursor: "1000", seen: [] } }
      },
      spawn
    );
    expect(r.kind).toBe("context");
    expect(Object.keys(r.buckets!)).toEqual(["concern-alice"]);
    expect(draftedIds(r.buckets!["concern-alice"])).toEqual(["a1"]);
    expect(r.state["concern-alice"]!.cursor).toBe("3000");
  });

  test("a targeted concern claims its mail; a broad watch drops the already-claimed id", async () => {
    // The SAME email (id m1, from alice) is listed by BOTH a targeted alice watch
    // and a broad in:inbox watch. Precedence: alice claims it, so the broad bucket
    // never re-drafts it. A second inbox-only email (m2) routes to the broad bucket.
    const spawn: GwsSpawn = async (args) => {
      const joined = args.join(" ");
      if (joined.includes("auth status")) return PREAMBLE + '{"token_valid":true}';
      if (joined.includes("getProfile")) return PREAMBLE + '{"emailAddress":"me@example.com"}';
      if (joined.includes("messages list")) {
        const q = joined.match(/"q":"([^"]*)"/)?.[1]?.replace(/ after:\d+$/, "") ?? "";
        if (q.startsWith("from:alice")) return listResponse(["m1"]);
        return listResponse(["m2", "m1"]); // in:inbox lists both, newest-first
      }
      if (joined.includes("messages get")) {
        const hit = getArgId(joined);
        const byId: Record<string, Meta> = {
          m1: { id: "m1", internalDate: "3000", from: "Alice <alice@x.com>", subject: "from alice" },
          m2: { id: "m2", internalDate: "4000", from: "Carol <carol@x.com>", subject: "random" }
        };
        return hit && byId[hit] ? metadataResponse(byId[hit]) : PREAMBLE + "{}";
      }
      return PREAMBLE + "{}";
    };
    const r = await runWatches(
      {
        watches: [
          { watcherId: "w-alice", routeKey: "w-alice", query: "from:alice@x.com", sender: "alice@x.com" },
          { watcherId: "w-triage", routeKey: "triage", query: "in:inbox" }
        ],
        state: { "w-alice": { cursor: "1000", seen: [] }, triage: { cursor: "1000", seen: [] } }
      },
      spawn
    );
    expect(r.kind).toBe("context");
    // m1 lands in the TARGETED bucket only — never the broad bucket.
    expect(draftedIds(r.buckets!["w-alice"])).toEqual(["m1"]);
    // The broad bucket keeps only the unclaimed remainder.
    expect(draftedIds(r.buckets!["triage"])).toEqual(["m2"]);
    // Both watches' cursors advanced over what each consumed.
    expect(r.state["w-alice"]!.cursor).toBe("3000");
    expect(r.state.triage!.cursor).toBe("4000");
  });

  test("a broad watch whose only match is claimed opens no bucket", async () => {
    // The single inbox email is alice's, already claimed by the targeted watch, so
    // the broad bucket has nothing left and is omitted (no idle worker turn).
    const spawn: GwsSpawn = async (args) => {
      const joined = args.join(" ");
      if (joined.includes("auth status")) return PREAMBLE + '{"token_valid":true}';
      if (joined.includes("getProfile")) return PREAMBLE + '{"emailAddress":"me@example.com"}';
      if (joined.includes("messages list")) {
        const q = joined.match(/"q":"([^"]*)"/)?.[1]?.replace(/ after:\d+$/, "") ?? "";
        if (q.startsWith("from:alice")) return listResponse(["m1"]);
        return listResponse(["m1"]);
      }
      if (joined.includes("messages get")) {
        const hit = getArgId(joined);
        return hit === "m1"
          ? metadataResponse({ id: "m1", internalDate: "3000", from: "Alice <alice@x.com>", subject: "hi" })
          : PREAMBLE + "{}";
      }
      return PREAMBLE + "{}";
    };
    const r = await runWatches(
      {
        watches: [
          { watcherId: "w-alice", routeKey: "w-alice", query: "from:alice@x.com", sender: "alice@x.com" },
          { watcherId: "w-triage", routeKey: "triage", query: "in:inbox" }
        ],
        state: { "w-alice": { cursor: "1000", seen: [] }, triage: { cursor: "1000", seen: [] } }
      },
      spawn
    );
    expect(r.kind).toBe("context");
    expect(draftedIds(r.buckets!["w-alice"])).toEqual(["m1"]);
    // Empty broad bucket omitted entirely.
    expect(r.buckets!["triage"]).toBeUndefined();
    expect(Object.keys(r.buckets!)).toEqual(["w-alice"]);
    // The broad watch's cursor still advanced over the message it consumed (and
    // dropped to precedence), so it won't re-list it.
    expect(r.state.triage!.cursor).toBe("3000");
  });

  // A `threads get format=metadata` response (thread mode's poll shape) for the
  // specificity-order tests below, where a thread watch runs alongside
  // query-listing watches in one tick.
  function threadDocResponse(threadId: string, metas: Meta[]): string {
    return (
      PREAMBLE +
      JSON.stringify({
        id: threadId,
        messages: metas.map((m) => ({
          id: m.id,
          threadId,
          internalDate: m.internalDate,
          snippet: m.snippet ?? "",
          payload: {
            headers: [
              { name: "From", value: m.from ?? "" },
              { name: "Subject", value: m.subject ?? "" },
              { name: "Date", value: m.date ?? "" }
            ]
          }
        }))
      })
    );
  }

  test("a thread watch beats a sender watch on the same message (one owner per tick)", async () => {
    // Alice posts m1 INSIDE watched thread t-1, and alice is ALSO sender-watched.
    // The thread watch is MORE specific, so it claims m1 even though the sender
    // watch comes first in the watches list; the sender watch is stripped of its
    // only match — it opens no bucket and drafts nothing, but its cursor still
    // advances over what it consumed.
    const spawn: GwsSpawn = async (args) => {
      const joined = args.join(" ");
      if (joined.includes("auth status")) return PREAMBLE + '{"token_valid":true}';
      if (joined.includes("getProfile")) return PREAMBLE + '{"emailAddress":"me@example.com"}';
      if (joined.includes("threads get")) {
        return threadDocResponse("t-1", [
          { id: "m0", internalDate: "1000", from: "me@example.com", subject: "opened" },
          { id: "m1", internalDate: "3000", from: "Alice <alice@x.com>", subject: "re: case" }
        ]);
      }
      if (joined.includes("messages list")) return listResponse(["m1"]);
      if (joined.includes("messages get")) {
        return getArgId(joined) === "m1"
          ? metadataResponse({ id: "m1", internalDate: "3000", from: "Alice <alice@x.com>", subject: "re: case" })
          : PREAMBLE + "{}";
      }
      return PREAMBLE + "{}";
    };
    const r = await runWatches(
      {
        // Sender watch FIRST in the list — the specificity sort, not list order,
        // must decide the owner.
        watches: [
          { watcherId: "w-alice", routeKey: "w-alice", query: "from:alice@x.com", sender: "alice@x.com" },
          { watcherId: "w-thread", routeKey: "w-thread", query: "thread:t-1", threadId: "t-1" }
        ],
        state: { "w-alice": { cursor: "1000", seen: [] }, "w-thread": { cursor: "1000", seen: ["m0"] } }
      },
      spawn
    );
    expect(r.kind).toBe("context");
    expect(draftedIds(r.buckets!["w-thread"])).toEqual(["m1"]);
    // The losing sender watch opens no bucket at all.
    expect(r.buckets!["w-alice"]).toBeUndefined();
    expect(Object.keys(r.buckets!)).toEqual(["w-thread"]);
    // ...but still commits its advanced cursor, so it won't re-list m1.
    expect(r.state["w-alice"]!.cursor).toBe("3000");
    expect(r.state["w-alice"]!.status).toBe("ok");
  });

  test("a sender watch losing a thread-claimed id still drafts the same sender's mail outside the thread", async () => {
    // Alice posts m1 inside watched thread t-1 AND m2 in a fresh thread on the
    // SAME tick. The thread watch owns m1; the sender watch keeps m2.
    const spawn: GwsSpawn = async (args) => {
      const joined = args.join(" ");
      if (joined.includes("auth status")) return PREAMBLE + '{"token_valid":true}';
      if (joined.includes("getProfile")) return PREAMBLE + '{"emailAddress":"me@example.com"}';
      if (joined.includes("threads get")) {
        return threadDocResponse("t-1", [
          { id: "m0", internalDate: "1000", from: "me@example.com", subject: "opened" },
          { id: "m1", internalDate: "3000", from: "Alice <alice@x.com>", subject: "re: case" }
        ]);
      }
      if (joined.includes("messages list")) return listResponse(["m2", "m1"]);
      if (joined.includes("messages get")) {
        const hit = getArgId(joined);
        const byId: Record<string, Meta> = {
          m1: { id: "m1", internalDate: "3000", from: "Alice <alice@x.com>", subject: "re: case" },
          m2: { id: "m2", internalDate: "4000", from: "Alice <alice@x.com>", subject: "new topic" }
        };
        return hit && byId[hit] ? metadataResponse(byId[hit]) : PREAMBLE + "{}";
      }
      return PREAMBLE + "{}";
    };
    const r = await runWatches(
      {
        watches: [
          { watcherId: "w-alice", routeKey: "w-alice", query: "from:alice@x.com", sender: "alice@x.com" },
          { watcherId: "w-thread", routeKey: "w-thread", query: "thread:t-1", threadId: "t-1" }
        ],
        state: { "w-alice": { cursor: "1000", seen: [] }, "w-thread": { cursor: "1000", seen: ["m0"] } }
      },
      spawn
    );
    expect(r.kind).toBe("context");
    expect(draftedIds(r.buckets!["w-thread"])).toEqual(["m1"]);
    // The sender watch loses m1 to the thread watch but keeps its own m2.
    expect(draftedIds(r.buckets!["w-alice"])).toEqual(["m2"]);
    expect(r.state["w-alice"]!.cursor).toBe("4000");
  });

  test("a sender watch beats a plain query watch on the same message", async () => {
    // m1 (from alice) matches BOTH a user query watch (label:receipts) and the
    // alice sender watch. The sender watch is more specific, so it owns m1 even
    // though the query watch comes first in the watches list; the stripped query
    // watch opens no bucket but its cursor still advances.
    const spawn: GwsSpawn = async (args) => {
      const joined = args.join(" ");
      if (joined.includes("auth status")) return PREAMBLE + '{"token_valid":true}';
      if (joined.includes("getProfile")) return PREAMBLE + '{"emailAddress":"me@example.com"}';
      if (joined.includes("messages list")) return listResponse(["m1"]);
      if (joined.includes("messages get")) {
        return getArgId(joined) === "m1"
          ? metadataResponse({ id: "m1", internalDate: "3000", from: "Alice <alice@x.com>", subject: "receipt" })
          : PREAMBLE + "{}";
      }
      return PREAMBLE + "{}";
    };
    const r = await runWatches(
      {
        watches: [
          { watcherId: "w-q", routeKey: "w-q", query: "label:receipts" },
          { watcherId: "w-alice", routeKey: "w-alice", query: "from:alice@x.com", sender: "alice@x.com" }
        ],
        state: { "w-q": { cursor: "1000", seen: [] }, "w-alice": { cursor: "1000", seen: [] } }
      },
      spawn
    );
    expect(r.kind).toBe("context");
    expect(draftedIds(r.buckets!["w-alice"])).toEqual(["m1"]);
    expect(r.buckets!["w-q"]).toBeUndefined();
    expect(Object.keys(r.buckets!)).toEqual(["w-alice"]);
    expect(r.state["w-q"]!.cursor).toBe("3000");
  });

  test("a plain query watch beats the synthetic triage concern on the same message", async () => {
    // m1 matches a user query watch AND the broad triage concern; the user watch
    // owns it (triage is the least specific tier) regardless of list order.
    // Triage keeps only its unclaimed remainder m2.
    const spawn: GwsSpawn = async (args) => {
      const joined = args.join(" ");
      if (joined.includes("auth status")) return PREAMBLE + '{"token_valid":true}';
      if (joined.includes("getProfile")) return PREAMBLE + '{"emailAddress":"me@example.com"}';
      if (joined.includes("messages list")) {
        const q = joined.match(/"q":"([^"]*)"/)?.[1]?.replace(/ after:\d+$/, "") ?? "";
        if (q.startsWith("subject:invoice")) return listResponse(["m1"]);
        return listResponse(["m2", "m1"]); // in:inbox lists both, newest-first
      }
      if (joined.includes("messages get")) {
        const hit = getArgId(joined);
        const byId: Record<string, Meta> = {
          m1: { id: "m1", internalDate: "3000", from: "Alice <alice@x.com>", subject: "invoice 42" },
          m2: { id: "m2", internalDate: "4000", from: "Carol <carol@x.com>", subject: "random" }
        };
        return hit && byId[hit] ? metadataResponse(byId[hit]) : PREAMBLE + "{}";
      }
      return PREAMBLE + "{}";
    };
    const r = await runWatches(
      {
        // Triage FIRST in the list — the tier sort must still run it LAST.
        watches: [
          { watcherId: "w-triage", routeKey: "triage", query: "in:inbox" },
          { watcherId: "w-q", routeKey: "w-q", query: "subject:invoice" }
        ],
        state: { "w-q": { cursor: "1000", seen: [] }, triage: { cursor: "1000", seen: [] } }
      },
      spawn
    );
    expect(r.kind).toBe("context");
    expect(draftedIds(r.buckets!["w-q"])).toEqual(["m1"]);
    expect(draftedIds(r.buckets!["triage"])).toEqual(["m2"]);
    expect(r.state.triage!.cursor).toBe("4000");
  });

  test("within a tier, the first-created watch wins the claim (stable list order)", async () => {
    // Two same-tier query watches both match m1. The watches list carries
    // creation order, and the stable tier sort preserves it — so the FIRST watch
    // owns m1 and the second is stripped (no bucket, cursor still advances).
    const spawn: GwsSpawn = async (args) => {
      const joined = args.join(" ");
      if (joined.includes("auth status")) return PREAMBLE + '{"token_valid":true}';
      if (joined.includes("getProfile")) return PREAMBLE + '{"emailAddress":"me@example.com"}';
      if (joined.includes("messages list")) return listResponse(["m1"]);
      if (joined.includes("messages get")) {
        return getArgId(joined) === "m1"
          ? metadataResponse({ id: "m1", internalDate: "3000", from: "Alice <alice@x.com>", subject: "invoice 42" })
          : PREAMBLE + "{}";
      }
      return PREAMBLE + "{}";
    };
    const r = await runWatches(
      {
        watches: [
          { watcherId: "w-q1", routeKey: "w-q1", query: "subject:invoice" },
          { watcherId: "w-q2", routeKey: "w-q2", query: "label:receipts" }
        ],
        state: { "w-q1": { cursor: "1000", seen: [] }, "w-q2": { cursor: "1000", seen: [] } }
      },
      spawn
    );
    expect(r.kind).toBe("context");
    expect(draftedIds(r.buckets!["w-q1"])).toEqual(["m1"]);
    expect(r.buckets!["w-q2"]).toBeUndefined();
    expect(r.state["w-q2"]!.cursor).toBe("3000");
  });

  test("per-bucket state round-trips by routeKey for the generic commit", async () => {
    // The returned state is keyed by routeKey at the TOP level (NOT nested under
    // byWatcher), so the generic persistFanOutState can merge ONLY the dispatched
    // routeKeys. Feed the returned state straight back as the next tick's input.
    const spawn = multiSpawn(
      { "from:alice@x.com": ["a1"] },
      { a1: { id: "a1", internalDate: "3000", from: "Alice <alice@x.com>", subject: "hi" } }
    );
    const r1 = await runWatches(
      {
        watches: [{ watcherId: "w-alice", routeKey: "w-alice", query: "from:alice@x.com", sender: "alice@x.com" }],
        state: { "w-alice": { cursor: "1000", seen: [] } }
      },
      spawn
    );
    expect(draftedIds(r1.buckets!["w-alice"])).toEqual(["a1"]);
    // Round-trip the flat state back in: a1 is now at/behind the cursor and seen,
    // so the next tick re-detects nothing (no bucket).
    const r2 = await runWatches(
      { watches: [{ watcherId: "w-alice", routeKey: "w-alice", query: "from:alice@x.com", sender: "alice@x.com" }], state: r1.state },
      spawn
    );
    expect(r2.kind).toBe("shortCircuit");
    expect(allBucketItems(r2.buckets)).toHaveLength(0);
  });

  // A multi-account spawn: like multiSpawn, but records the configDir each gws
  // call ran under so the per-watch account targeting can be asserted. Returns the
  // same canned responses regardless of dir (the account binding is the env, not
  // the data).
  function dirRecordingSpawn(
    byQuery: Record<string, string[]>,
    metaById: Record<string, Meta>,
    seen: { dirs: string[] }
  ): GwsSpawn {
    return async (args: string[], configDir?: string) => {
      seen.dirs.push(configDir ?? "<default>");
      const joined = args.join(" ");
      if (joined.includes("auth status")) return PREAMBLE + '{"token_valid":true}';
      if (joined.includes("getProfile")) return PREAMBLE + '{"emailAddress":"me@example.com"}';
      if (joined.includes("messages list")) {
        const q = listQuery(joined) ?? "";
        const base = q.replace(/ after:\d+$/, "");
        return listResponse(byQuery[base] ?? byQuery[q] ?? []);
      }
      if (joined.includes("messages get")) {
        const hit = getArgId(joined);
        return hit && metaById[hit] ? metadataResponse(metaById[hit]) : PREAMBLE + "{}";
      }
      return PREAMBLE + "{}";
    };
  }

  test("a watch with configDir runs EVERY gws call under that account's dir", async () => {
    const seen = { dirs: [] as string[] };
    const spawn = dirRecordingSpawn(
      { "from:alice@x.com": ["a1"] },
      { a1: { id: "a1", internalDate: "3000", from: "Alice <alice@x.com>", subject: "hi" } },
      seen
    );
    const r = await runWatches(
      {
        watches: [{ watcherId: "w-a", query: "from:alice@x.com", sender: "alice@x.com", configDir: "/dir/gacct_a" }],
        state: { "w-a": { cursor: "1000", seen: [] } }
      },
      spawn
    );
    expect(r.kind).toBe("context");
    expect(draftedIds(r.buckets!["w-a"])).toEqual(["a1"]);
    // auth status + getProfile + list + get + body-fetch all carried the dir; no
    // gws call leaked to the default config dir.
    expect(seen.dirs.length).toBeGreaterThan(0);
    expect(seen.dirs.every((d) => d === "/dir/gacct_a")).toBe(true);
  });

  test("a watch WITHOUT configDir runs gws on the default config dir (no env)", async () => {
    const seen = { dirs: [] as string[] };
    const spawn = dirRecordingSpawn(
      { "from:alice@x.com": ["a1"] },
      { a1: { id: "a1", internalDate: "3000", from: "Alice <alice@x.com>", subject: "hi" } },
      seen
    );
    const r = await runWatches(
      {
        watches: [{ watcherId: "w-a", query: "from:alice@x.com", sender: "alice@x.com" }],
        state: { "w-a": { cursor: "1000", seen: [] } }
      },
      spawn
    );
    expect(r.kind).toBe("context");
    expect(seen.dirs.length).toBeGreaterThan(0);
    expect(seen.dirs.every((d) => d === "<default>")).toBe(true);
  });

  test("two account-scoped watches each target their OWN dir in one tick", async () => {
    const seen = { dirs: [] as string[] };
    const spawn: GwsSpawn = async (args, configDir) => {
      const joined = args.join(" ");
      if (joined.includes("auth status")) return PREAMBLE + '{"token_valid":true}';
      if (joined.includes("getProfile")) return PREAMBLE + '{"emailAddress":"me@example.com"}';
      if (joined.includes("messages list")) {
        const q = listQuery(joined)?.replace(/ after:\d+$/, "") ?? "";
        // Tag the listed id by the dir the call ran under so we can assert each
        // watch polled its own account.
        if (q.startsWith("from:alice")) {
          seen.dirs.push(`alice:${configDir}`);
          return listResponse(["a1"]);
        }
        seen.dirs.push(`bob:${configDir}`);
        return listResponse(["b1"]);
      }
      if (joined.includes("messages get")) {
        const hit = getArgId(joined);
        const byId: Record<string, Meta> = {
          a1: { id: "a1", internalDate: "3000", from: "Alice <alice@x.com>", subject: "hi" },
          b1: { id: "b1", internalDate: "4000", from: "Bob <bob@x.com>", subject: "yo" }
        };
        return hit && byId[hit] ? metadataResponse(byId[hit]) : PREAMBLE + "{}";
      }
      return PREAMBLE + "{}";
    };
    const r = await runWatches(
      {
        watches: [
          { watcherId: "w-a", query: "from:alice@x.com", sender: "alice@x.com", configDir: "/dir/gacct_a" },
          { watcherId: "w-b", query: "from:bob@x.com", sender: "bob@x.com", configDir: "/dir/gacct_b" }
        ],
        state: { "w-a": { cursor: "1000", seen: [] }, "w-b": { cursor: "1000", seen: [] } }
      },
      spawn
    );
    expect(r.kind).toBe("context");
    expect(draftedIds(r.buckets!["w-a"])).toEqual(["a1"]);
    expect(draftedIds(r.buckets!["w-b"])).toEqual(["b1"]);
    expect(seen.dirs).toContain("alice:/dir/gacct_a");
    expect(seen.dirs).toContain("bob:/dir/gacct_b");
    // No cross-account leak: alice's list never ran under bob's dir and vice versa.
    expect(seen.dirs).not.toContain("alice:/dir/gacct_b");
    expect(seen.dirs).not.toContain("bob:/dir/gacct_a");
  });
});

describe("runWatches — cross-account Message-ID dedup", () => {
  function listQuery(joined: string): string | undefined {
    return joined.match(/"q":"([^"]*)"/)?.[1];
  }

  // A two-account spawn: a list/get response routed by the configDir the call ran
  // under (each account targets its own dir) AND the watch's query. The SAME
  // underlying email appears in each account with a DIFFERENT gmail id but the
  // SAME Message-ID — the exact cross-account-duplicate shape detection must
  // collapse. `byDir` maps a configDir to its { query -> ids } + metadata.
  function twoAccountSpawn(
    byDir: Record<string, { byQuery: Record<string, string[]>; metaById: Record<string, Meta> }>
  ): GwsSpawn {
    return async (args: string[], configDir?: string) => {
      const dir = configDir ?? "<default>";
      const acct = byDir[dir];
      const joined = args.join(" ");
      if (joined.includes("auth status")) return PREAMBLE + '{"token_valid":true}';
      if (joined.includes("getProfile")) return PREAMBLE + '{"emailAddress":"me@example.com"}';
      if (!acct) return PREAMBLE + "{}";
      if (joined.includes("messages list")) {
        const q = (listQuery(joined) ?? "").replace(/ after:\d+$/, "");
        return listResponse(acct.byQuery[q] ?? []);
      }
      if (joined.includes("messages get")) {
        const hit = getArgId(joined);
        return hit && acct.metaById[hit] ? metadataResponse(acct.metaById[hit]!) : PREAMBLE + "{}";
      }
      return PREAMBLE + "{}";
    };
  }

  test("the same Message-ID across two accounts drafts exactly once (To-recipient wins)", async () => {
    // One email To alice@x.com lands in both inboxes: alice's copy is gmail id A1,
    // bob's copy is B1 — but both carry Message-ID <mid-1>. alice is the
    // To-recipient, so alice's watch drafts; bob's is suppressed.
    const spawn = twoAccountSpawn({
      "/dir/gacct_a": {
        byQuery: { "in:inbox": ["A1"] },
        metaById: { A1: { id: "A1", internalDate: "3000", from: "Carol <carol@x.com>", subject: "hi", to: "alice@x.com", messageId: "<mid-1>" } }
      },
      "/dir/gacct_b": {
        byQuery: { "in:inbox": ["B1"] },
        metaById: { B1: { id: "B1", internalDate: "3000", from: "Carol <carol@x.com>", subject: "hi", to: "alice@x.com", messageId: "<mid-1>" } }
      }
    });
    const r = await runWatches(
      {
        watches: [
          { watcherId: "w-a", routeKey: "w-a", query: "in:inbox", account: "alice@x.com", configDir: "/dir/gacct_a" },
          { watcherId: "w-b", routeKey: "w-b", query: "in:inbox", account: "bob@x.com", configDir: "/dir/gacct_b" }
        ],
        state: { "w-a": { cursor: "1000", seen: [] }, "w-b": { cursor: "1000", seen: [] } }
      },
      spawn
    );
    expect(r.kind).toBe("context");
    // alice (the To-recipient) drafts; bob's bucket is suppressed entirely.
    expect(draftedIds(r.buckets!["w-a"])).toEqual(["A1"]);
    expect(r.buckets!["w-b"]).toBeUndefined();
    // The LOSER's cursor still advanced over its own copy, so it won't re-draft.
    expect(r.state["w-b"]!.cursor).toBe("3000");
    expect(r.state["w-a"]!.cursor).toBe("3000");
  });

  test("the loser records seen + does NOT re-draft on the next tick", async () => {
    const byDir = {
      "/dir/gacct_a": {
        byQuery: { "in:inbox": ["A1"] },
        metaById: { A1: { id: "A1", internalDate: "3000", from: "Carol <carol@x.com>", subject: "hi", to: "alice@x.com", messageId: "<mid-1>" } }
      },
      "/dir/gacct_b": {
        byQuery: { "in:inbox": ["B1"] },
        metaById: { B1: { id: "B1", internalDate: "3000", from: "Carol <carol@x.com>", subject: "hi", to: "alice@x.com", messageId: "<mid-1>" } }
      }
    };
    const spawn = twoAccountSpawn(byDir);
    const watches = [
      { watcherId: "w-a", routeKey: "w-a", query: "in:inbox", account: "alice@x.com", configDir: "/dir/gacct_a" },
      { watcherId: "w-b", routeKey: "w-b", query: "in:inbox", account: "bob@x.com", configDir: "/dir/gacct_b" }
    ];
    const r1 = await runWatches(
      { watches, state: { "w-a": { cursor: "1000", seen: [] }, "w-b": { cursor: "1000", seen: [] } } },
      spawn
    );
    expect(draftedIds(r1.buckets!["w-a"])).toEqual(["A1"]);
    expect(r1.buckets!["w-b"]).toBeUndefined();
    // Feed the returned state back: the loser's advanced cursor + seen mean B1 is
    // no longer "new", so the next tick re-drafts nothing (no double reply later).
    const r2 = await runWatches({ watches, state: r1.state }, spawn);
    expect(r2.kind).toBe("shortCircuit");
    expect(allBucketItems(r2.buckets)).toHaveLength(0);
  });

  test("precedence falls back to account email ascending when neither is the To-recipient", async () => {
    // The email is To a third party, so neither account is the To-recipient — the
    // deterministic tie-break (account email ascending) picks alice over bob
    // regardless of watch order.
    const spawn = twoAccountSpawn({
      "/dir/gacct_a": {
        byQuery: { "in:inbox": ["A1"] },
        metaById: { A1: { id: "A1", internalDate: "3000", from: "Carol <carol@x.com>", subject: "hi", to: "list@x.com", messageId: "<mid-2>" } }
      },
      "/dir/gacct_b": {
        byQuery: { "in:inbox": ["B1"] },
        metaById: { B1: { id: "B1", internalDate: "3000", from: "Carol <carol@x.com>", subject: "hi", to: "list@x.com", messageId: "<mid-2>" } }
      }
    });
    const r = await runWatches(
      {
        watches: [
          { watcherId: "w-b", routeKey: "w-b", query: "in:inbox", account: "bob@x.com", configDir: "/dir/gacct_b" },
          { watcherId: "w-a", routeKey: "w-a", query: "in:inbox", account: "alice@x.com", configDir: "/dir/gacct_a" }
        ],
        state: { "w-a": { cursor: "1000", seen: [] }, "w-b": { cursor: "1000", seen: [] } }
      },
      spawn
    );
    expect(r.kind).toBe("context");
    // alice@x.com < bob@x.com, so alice wins the tie-break regardless of watch order.
    expect(draftedIds(r.buckets!["w-a"])).toEqual(["A1"]);
    expect(r.buckets!["w-b"]).toBeUndefined();
  });

  test("distinct Message-IDs across accounts are NOT deduped (each drafts)", async () => {
    // Two genuinely different emails (different Message-IDs), one per account —
    // not a cross-account duplicate, so both draft.
    const spawn = twoAccountSpawn({
      "/dir/gacct_a": {
        byQuery: { "in:inbox": ["A1"] },
        metaById: { A1: { id: "A1", internalDate: "3000", from: "Carol <carol@x.com>", subject: "a", to: "alice@x.com", messageId: "<mid-a>" } }
      },
      "/dir/gacct_b": {
        byQuery: { "in:inbox": ["B1"] },
        metaById: { B1: { id: "B1", internalDate: "3000", from: "Dave <dave@x.com>", subject: "b", to: "bob@x.com", messageId: "<mid-b>" } }
      }
    });
    const r = await runWatches(
      {
        watches: [
          { watcherId: "w-a", routeKey: "w-a", query: "in:inbox", account: "alice@x.com", configDir: "/dir/gacct_a" },
          { watcherId: "w-b", routeKey: "w-b", query: "in:inbox", account: "bob@x.com", configDir: "/dir/gacct_b" }
        ],
        state: { "w-a": { cursor: "1000", seen: [] }, "w-b": { cursor: "1000", seen: [] } }
      },
      spawn
    );
    expect(r.kind).toBe("context");
    expect(draftedIds(r.buckets!["w-a"])).toEqual(["A1"]);
    expect(draftedIds(r.buckets!["w-b"])).toEqual(["B1"]);
  });

  test("single-account behavior is unchanged (no Message-ID dedup when one account sees a message)", async () => {
    // One account, two distinct messages each with its own Message-ID — the dedup
    // pass groups by Message-ID but finds only one account per group, so it never
    // suppresses anything. Both drafts survive.
    const spawn: GwsSpawn = async (args, configDir) => {
      void configDir;
      const joined = args.join(" ");
      if (joined.includes("auth status")) return PREAMBLE + '{"token_valid":true}';
      if (joined.includes("getProfile")) return PREAMBLE + '{"emailAddress":"me@example.com"}';
      if (joined.includes("messages list")) {
        const q = (listQuery(joined) ?? "").replace(/ after:\d+$/, "");
        if (q.startsWith("from:alice")) return listResponse(["m1"]);
        return listResponse(["m2"]);
      }
      if (joined.includes("messages get")) {
        const hit = getArgId(joined);
        const byId: Record<string, Meta> = {
          m1: { id: "m1", internalDate: "3000", from: "Alice <alice@x.com>", subject: "a", to: "me@example.com", messageId: "<mid-1>" },
          m2: { id: "m2", internalDate: "4000", from: "Bob <bob@x.com>", subject: "b", to: "me@example.com", messageId: "<mid-2>" }
        };
        return hit && byId[hit] ? metadataResponse(byId[hit]!) : PREAMBLE + "{}";
      }
      return PREAMBLE + "{}";
    };
    const r = await runWatches(
      {
        watches: [
          { watcherId: "w-alice", routeKey: "w-alice", query: "from:alice@x.com", sender: "alice@x.com", configDir: "/dir/gacct_a" },
          { watcherId: "w-bob", routeKey: "w-bob", query: "from:bob@x.com", sender: "bob@x.com", configDir: "/dir/gacct_a" }
        ],
        state: { "w-alice": { cursor: "1000", seen: [] }, "w-bob": { cursor: "1000", seen: [] } }
      },
      spawn
    );
    expect(r.kind).toBe("context");
    expect(draftedIds(r.buckets!["w-alice"])).toEqual(["m1"]);
    expect(draftedIds(r.buckets!["w-bob"])).toEqual(["m2"]);
  });

  test("within-account targeted-vs-triage dedup (by gmail id) still works", async () => {
    // Regression guard for the existing within-account precedence: a targeted
    // watch and a triage watch on the SAME account list the SAME gmail id; the
    // targeted watch claims it and triage drops it (unchanged by the Message-ID
    // dedup, which fires only across DISTINCT accounts).
    const spawn: GwsSpawn = async (args) => {
      const joined = args.join(" ");
      if (joined.includes("auth status")) return PREAMBLE + '{"token_valid":true}';
      if (joined.includes("getProfile")) return PREAMBLE + '{"emailAddress":"me@example.com"}';
      if (joined.includes("messages list")) {
        const q = (listQuery(joined) ?? "").replace(/ after:\d+$/, "");
        if (q.startsWith("from:alice")) return listResponse(["m1"]);
        return listResponse(["m2", "m1"]);
      }
      if (joined.includes("messages get")) {
        const hit = getArgId(joined);
        const byId: Record<string, Meta> = {
          m1: { id: "m1", internalDate: "3000", from: "Alice <alice@x.com>", subject: "a", to: "me@example.com", messageId: "<mid-1>" },
          m2: { id: "m2", internalDate: "4000", from: "Carol <carol@x.com>", subject: "c", to: "me@example.com", messageId: "<mid-2>" }
        };
        return hit && byId[hit] ? metadataResponse(byId[hit]!) : PREAMBLE + "{}";
      }
      return PREAMBLE + "{}";
    };
    const r = await runWatches(
      {
        watches: [
          { watcherId: "w-alice", routeKey: "w-alice", query: "from:alice@x.com", sender: "alice@x.com" },
          { watcherId: "w-triage", routeKey: "triage", query: "in:inbox" }
        ],
        state: { "w-alice": { cursor: "1000", seen: [] }, triage: { cursor: "1000", seen: [] } }
      },
      spawn
    );
    expect(r.kind).toBe("context");
    expect(draftedIds(r.buckets!["w-alice"])).toEqual(["m1"]);
    expect(draftedIds(r.buckets!["triage"])).toEqual(["m2"]);
  });
});

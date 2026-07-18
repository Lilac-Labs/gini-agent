// Pure pipeline logic for CRM email extraction — no I/O, no runtime state.
// The controller (crm-extractor.ts) feeds it normalized mail and turns its
// outputs into curator chat turns. Ported from the validated harness; the
// measurements behind each rule live in ADR people-crm-extraction-pipeline.md.

export interface CrmAddress {
  name?: string;
  address: string; // lowercased
}

export interface CrmMail {
  id: string;
  threadId: string;
  date: number; // epoch ms
  from?: CrmAddress;
  to: CrmAddress[];
  cc: CrmAddress[];
  subject: string;
  // Plain-text body (already HTML-flattened by the mail source).
  body: string;
}

// Machine-role senders. Tuned on a 2,139-message mailbox: drops the bulk of
// machine mail with the only person-shaped casualties being founder-signed
// drip campaigns — which engaged-only intake would drop anyway.
export const AUTOMATED_SENDER = /no-?reply|do-?not-?reply|^(notifications?|mailer-daemon|postmaster|bounce|newsletter|digest|alerts?|billing|receipts?[+@]|updates?|info|hello|support|team|community|events|marketing|news|store-news|order-update|shipment-tracking|auto-confirm|system|calendar-notification|drive-shares|comments-[a-z0-9]+|sc-|ads-account|cloudplatform|memberinfo|announcements?|welcome|verify|help|feedback|invoice[s+]?|security|account[s]?|admin|website|hey|apply|jobs|careers|press|sales)@|^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}@|@(mail|email|e|mailer|notify|updates|notifications|calendar)\./i;

export const CRM_DEFAULTS = {
  maxThreadChars: 60_000,
  batchMax: 10,
  batchChars: 100_000,
};

// The user's own addresses: the connected account plus aliases. Exact
// matches plus plus-tag variants — the seeded "You —" contact row is where
// the agent accumulates newly-discovered aliases.
export function makeSelfMatcher(selfAddresses: string[]): (addr: string) => boolean {
  const set = new Set(selfAddresses.map((a) => a.trim().toLowerCase()).filter(Boolean));
  const bases = [...set].map((a) => {
    const [local, host] = a.split("@");
    return { local: (local ?? a).split("+")[0]!, host: host ?? "" };
  });
  return (addr: string): boolean => {
    const a = addr.toLowerCase();
    if (set.has(a)) return true;
    const [local, host] = a.split("@");
    if (!local || !host) return false;
    const bareLocal = local.split("+")[0]!;
    return bases.some((b) => b.host === host && b.local === bareLocal);
  };
}

export interface ThreadAnalysis {
  messageCount: number;
  newestDate: number;
  chars: number;
  // Engaged: the user sent a message in the thread, or a non-automated
  // sender deliberately cc'd the user into it (the intro shape).
  engaged: boolean;
  // Dominant non-self, non-machine sender — the batching key.
  primarySender: string | null;
  // Per-sender behavior rows for the broadcast filter aggregates.
  senders: { sender: string; multiMessage: boolean; selfWrote: boolean }[];
  // Whether any human is visible at all: a non-machine non-self sender, or
  // (for outbound-only threads) a human recipient of the user's own mail.
  hasHuman: boolean;
}

export function analyzeThread(msgs: CrmMail[], isSelf: (a: string) => boolean): ThreadAnalysis {
  const selfWrote = msgs.some((m) => m.from && isSelf(m.from.address));
  const ccdIn = msgs.some(
    (m) => m.from && !isSelf(m.from.address) && !AUTOMATED_SENDER.test(m.from.address) && m.cc.some((a) => isSelf(a.address)),
  );
  const senderCounts = new Map<string, number>();
  for (const m of msgs) {
    const s = m.from?.address;
    if (s && !isSelf(s) && !AUTOMATED_SENDER.test(s)) senderCounts.set(s, (senderCounts.get(s) ?? 0) + 1);
  }
  const primarySender = [...senderCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const humanSenders = primarySender !== null;
  const humanRecipients = msgs.some(
    (m) =>
      m.from && isSelf(m.from.address) &&
      [...m.to, ...m.cc].some((a) => !isSelf(a.address) && !AUTOMATED_SENDER.test(a.address)),
  );
  const allSenders = new Set(msgs.map((m) => m.from?.address).filter((a): a is string => !!a && !isSelf(a)));
  return {
    messageCount: msgs.length,
    newestDate: Math.max(0, ...msgs.map((m) => m.date)),
    chars: msgs.reduce((s, m) => s + m.subject.length + m.body.length, 0),
    engaged: selfWrote || ccdIn,
    primarySender,
    senders: [...allSenders].map((sender) => ({ sender, multiMessage: msgs.length > 1, selfWrote })),
    hasHuman: humanSenders || humanRecipients,
  };
}

// Post-ingest keep/skip decision, given the current behavioral broadcast set.
export function decideThread(
  analysis: Pick<ThreadAnalysis, "engaged" | "primarySender" | "hasHuman">,
  broadcast: Set<string>,
): { keep: boolean; reason?: string } {
  if (!analysis.engaged) return { keep: false, reason: "not engaged (no self message or cc)" };
  if (!analysis.hasHuman) return { keep: false, reason: "all senders automated/self" };
  if (analysis.primarySender && broadcast.has(analysis.primarySender)) {
    return { keep: false, reason: "broadcast sender" };
  }
  return { keep: true };
}

// Drop the quoted-reply tail of a message body — the thread is stitched
// chronologically, so the quoted copy of earlier messages is duplication
// that re-bills every prior message as fresh input.
export function stripQuotedTail(body: string): string {
  const lines = body.split("\n");
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!.trim();
    if (
      /^On .{5,120} wrote:$/.test(l) ||
      /^-{2,}\s*(Original|Forwarded) [Mm]essage\s*-{2,}/.test(l) ||
      /^_{10,}$/.test(l) ||
      (/^From: .+@.+$/.test(l) && i + 1 < lines.length && /^(Sent|Date): /.test(lines[i + 1]!.trim()))
    ) {
      cut = i;
      break;
    }
  }
  const kept = lines.slice(0, cut).filter((l) => !l.trimStart().startsWith(">"));
  const out = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return out.length > 0 ? out : lines.slice(0, 3).join("\n");
}

function formatAddr(a: CrmAddress | undefined): string {
  if (!a) return "";
  return a.name ? `${a.name} <${a.address}>` : a.address;
}

// Stitch a thread oldest→newest into one fenced block; when over budget,
// drop middle messages (both ends carry the signatures and the live state).
export function stitchThread(messages: CrmMail[], maxThreadChars = CRM_DEFAULTS.maxThreadChars): string {
  const sorted = [...messages].sort((a, b) => a.date - b.date);
  const parts = sorted.map((m) => {
    const headers = [
      m.from ? `From: ${formatAddr(m.from)}` : "",
      m.to.length ? `To: ${m.to.map(formatAddr).join(", ")}` : "",
      m.cc.length ? `Cc: ${m.cc.map(formatAddr).join(", ")}` : "",
      m.date ? `Date: ${new Date(m.date).toISOString()}` : "",
      m.subject ? `Subject: ${m.subject}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    return `--- message ---\n${headers}\n\n${stripQuotedTail(m.body)}`;
  });
  let total = parts.reduce((s, p) => s + p.length, 0);
  let kept = parts;
  let dropped = 0;
  if (total > maxThreadChars && parts.length > 3) {
    kept = [...parts];
    while (total > maxThreadChars && kept.length > 4) {
      const mid = Math.floor(kept.length / 2);
      total -= kept[mid]!.length;
      kept.splice(mid, 1);
      dropped++;
    }
  }
  const note = dropped ? `\n--- (${dropped} middle messages of this thread omitted for length) ---\n` : "";
  const head = kept.slice(0, Math.ceil(kept.length / 2)).join("\n\n");
  const tail = kept.slice(Math.ceil(kept.length / 2)).join("\n\n");
  return `${head}${note ? note : "\n\n"}${tail}`;
}

// Group kept threads into batches by primary correspondent so one turn
// amortizes the system preamble across a whole relationship's history.
export function batchByPrimary(
  rows: { threadId: string; primarySender: string | null; chars: number }[],
  batchMax = CRM_DEFAULTS.batchMax,
  batchChars = CRM_DEFAULTS.batchChars,
): string[][] {
  const groups = new Map<string, { threadId: string; chars: number }[]>();
  for (const r of rows) {
    const key = r.primarySender ?? `~solo:${r.threadId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }
  const batches: string[][] = [];
  for (const group of groups.values()) {
    let current: string[] = [];
    let chars = 0;
    const flush = (): void => {
      if (current.length) batches.push(current);
      current = [];
      chars = 0;
    };
    for (const r of group) {
      if (current.length >= batchMax || (current.length > 0 && chars + r.chars > batchChars)) flush();
      current.push(r.threadId);
      chars += r.chars;
    }
    flush();
  }
  return batches;
}

// The turn message: the bare ask, the skill body inline (saves the
// read_skill round trip), then each thread fenced as data.
export function buildTurnMessage(
  batch: { threadId: string; msgs: CrmMail[] }[],
  skillBody: string,
  selfEmail: string,
  maxThreadChars = CRM_DEFAULTS.maxThreadChars,
): string {
  const total = batch.length;
  const blocks = batch.map((b, i) => {
    const label = total > 1 ? `[Thread ${i + 1} of ${total} — ${b.msgs.length} message${b.msgs.length === 1 ? "" : "s"}]\n` : "";
    return "```email-thread\n" + label + stitchThread(b.msgs, maxThreadChars) + "\n```";
  });
  const what = total === 1
    ? `this email thread (${batch[0]!.msgs.length} message${batch[0]!.msgs.length === 1 ? "" : "s"}`
    : `these ${total} email threads (same correspondents`;
  return [
    `Update my CRM from ${what}; your people-crm skill is included below — no need to read_skill). I'm ${selfEmail}.`,
    "",
    "```people-crm-skill",
    skillBody.trim(),
    "```",
    "",
    blocks.join("\n\n"),
  ].join("\n");
}

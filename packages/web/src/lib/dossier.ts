// Display normalization for contact dossiers (the `profile` markdown the
// CRM curator writes). Older dossiers list Claims / Citations as bare
// `[n] Claim: …` lines — markdown collapses consecutive plain lines into one
// paragraph, so the whole section rendered as a single run-together blob.
// The skill's skeleton now emits one bullet per claim; this helper converges
// legacy dossiers onto the same shape so they render one claim per line too.
//
// Scope guards — the rewrite must never corrupt non-claim content:
// - Only lines inside a Claims/Citations section are rewritten, so `[n]
//   Claim:` appearing in prose or quoted in another section stays verbatim.
// - Fenced code blocks pass through untouched even inside that section.
// - Mid-line splitting is per line (never across newlines) and re-attaches a
//   prefix that is only a list/quote marker, so `- [1] Claim:` and
//   `* [1] Claim:` lines aren't chopped into an empty item plus a bullet.

const CLAIMS_HEADING = /^#{1,6}\s+.*\b(claims|citations)\b/i;
const ANY_HEADING = /^#{1,6}\s/;
const FENCE = /^\s*(```|~~~)/;
const MIDLINE_CLAIM = /(?<=\S)\s+(?=\[\d+\] Claim:)/;
const BARE_CLAIM_LINE = /^\s*\[\d+\] Claim:/;
// A segment that is only a list/quote marker (`-`, `*`, `+`, `1.`, `>`)
// belongs to the claim that follows it, not on a line of its own.
const MARKER_ONLY = /^\s*(?:[-*+]|\d+[.)]|>)\s*$/;

function normalizeClaimLine(line: string): string[] {
  const segments = line.split(MIDLINE_CLAIM);
  // Re-attach a marker-only prefix to the first claim so an
  // already-bulleted line survives intact.
  if (segments.length > 1 && MARKER_ONLY.test(segments[0]!)) {
    const marker = segments.shift()!;
    segments[0] = `${marker} ${segments[0]!}`;
  }
  return segments.map((seg) => (BARE_CLAIM_LINE.test(seg) ? `- ${seg.trimStart()}` : seg));
}

export function dossierDisplayMarkdown(profile: string): string {
  let inClaims = false;
  let inFence = false;
  const out: string[] = [];
  for (const line of profile.split("\n")) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (!inFence && ANY_HEADING.test(line)) inClaims = CLAIMS_HEADING.test(line);
    if (!inFence && inClaims) out.push(...normalizeClaimLine(line));
    else out.push(line);
  }
  return out.join("\n");
}

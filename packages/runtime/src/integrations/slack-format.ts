// Convert lightweight Markdown to Slack mrkdwn.
//
// Slack's mrkdwn dialect is close to CommonMark but diverges on the
// exact markers agents tend to produce:
//   - bold is `*bold*` (single asterisk), not `**bold**`
//   - links are `<url|text>`, not `[text](url)`
//   - headings don't exist; a `# heading` line renders as literal text
//
// We convert just that subset and pass everything else through
// untouched — no escaping pass, unlike Telegram's MarkdownV2, because
// Slack renders unrecognized markers as literal text instead of
// rejecting the message. Fenced and inline code use the same backtick
// syntax in both dialects, so code spans are hidden before the prose
// conversions run (a `**` or `[x](y)` inside a code block must survive
// verbatim) and restored after.
//
// References:
//   https://docs.slack.dev/messaging/formatting-message-text

// Sentinel bytes used while shuffling code tokens through the prose
// conversions. These ASCII control codes (0x01–0x02) cannot appear in
// normal user input, so they round-trip cleanly — same trick as
// telegram-format.ts.
const CODE_SENTINEL_OPEN = "";
const CODE_SENTINEL_CLOSE = "";

type CodeToken = { kind: "fence" | "inline"; inner: string };

// Pull out fenced and inline code spans first so the bold / link /
// heading conversions never touch code interiors.
function hideCodeSpans(input: string, tokens: CodeToken[]): string {
  return input.replace(/```([\s\S]*?)```|`([^`\n]*)`/g, (_match, fence, inline) => {
    tokens.push(
      fence !== undefined
        ? { kind: "fence", inner: fence }
        : { kind: "inline", inner: inline ?? "" }
    );
    return `${CODE_SENTINEL_OPEN}${tokens.length - 1}${CODE_SENTINEL_CLOSE}`;
  });
}

export function formatSlackMrkdwn(input: string): string {
  if (input.length === 0) return input;

  const codeTokens: CodeToken[] = [];
  let work = hideCodeSpans(input, codeTokens);

  // `[text](url)` → `<url|text>`. The url character class excludes
  // whitespace and closing parens so a link followed by prose
  // punctuation doesn't swallow it; nested brackets in the label are
  // not supported (agents don't produce them).
  work = work.replace(/\[([^\]\n]+)\]\((\S+?)\)/g, "<$2|$1>");

  // `**bold**` / `__bold__` → `*bold*`. Inner content must not contain
  // the marker character or newlines so we don't match across
  // paragraph boundaries or eat literal asterisks.
  work = work.replace(/\*\*([^*\n]+?)\*\*/g, "*$1*");
  work = work.replace(/__([^_\n]+?)__/g, "*$1*");

  // `# heading` lines → bold lines. mrkdwn has no heading syntax; the
  // literal hashes read as noise, bolding preserves the emphasis.
  work = work.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");

  // Restore code spans last so no prose conversion saw raw backticks.
  work = work.replace(
    new RegExp(`${CODE_SENTINEL_OPEN}(\\d+)${CODE_SENTINEL_CLOSE}`, "g"),
    (_m, indexStr: string) => {
      const tok = codeTokens[Number(indexStr)];
      if (!tok) return "";
      return tok.kind === "fence" ? "```" + tok.inner + "```" : "`" + tok.inner + "`";
    }
  );

  return work;
}

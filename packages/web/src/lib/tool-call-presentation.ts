export interface TerminalCommandPresentation {
  label: string;
  command: string;
}

// `gws gmail` is an implementation detail of the user's email action. Match
// only a direct invocation (optionally prefixed by env assignments) so a shell
// command that merely mentions the CLI is not mislabeled. Gmail commands keep
// their result available to the caller, but the CLI syntax and machine-local
// account path do not reach the rendered command detail.
export function terminalCommandPresentation(
  defaultLabel: string,
  command: string
): TerminalCommandPresentation {
  const match = command.trim().match(
    /^(?:env\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*(?:\S*\/)?gws\s+gmail(?:\s+([\s\S]*))?$/
  );
  if (!match) return { label: defaultLabel, command };

  const args = match[1]?.trim() ?? "";
  let label = "Use Gmail";
  if (/^(?:\+read\b|users\s+(?:messages|threads|drafts)\s+get\b)/.test(args)) {
    label = "Read email";
  } else if (/^(?:\+triage\b|users\s+(?:messages|threads|drafts)\s+list\b)/.test(args)) {
    label = "Search email";
  } else if (/^\+(?:send|reply|reply-all|forward)\b[\s\S]*\s--draft(?:\s|$)/.test(args)) {
    label = "Draft email";
  } else if (/^(?:\+(?:send|reply|reply-all|forward)\b|users\s+(?:messages|drafts)\s+send\b)/.test(args)) {
    label = "Send email";
  }
  return { label, command: "" };
}

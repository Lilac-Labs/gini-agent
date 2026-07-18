import { describe, expect, test } from "bun:test";
import { terminalCommandPresentation } from "./tool-call-presentation";

describe("terminalCommandPresentation", () => {
  test("masks direct Gmail reads behind a plain-language label", () => {
    const command =
      'GOOGLE_WORKSPACE_CLI_CONFIG_DIR="/Users/me/.gini/google-accounts/gacct" gws gmail +read --id abc --headers';

    expect(terminalCommandPresentation("Run shell command", command)).toEqual({
      label: "Read email",
      command: ""
    });
    expect(
      terminalCommandPresentation("Run shell command", "gws gmail users threads get --params '{}'")
    ).toEqual({ label: "Read email", command: "" });
  });

  test("describes searches, drafts, and sends", () => {
    expect(
      terminalCommandPresentation("Run shell command", "gws gmail users messages list --params '{}'")
    ).toEqual({ label: "Search email", command: "" });
    expect(
      terminalCommandPresentation(
        "Run shell command",
        "gws gmail +reply --message-id abc --body 'Thanks' --draft"
      )
    ).toEqual({ label: "Draft email", command: "" });
    expect(
      terminalCommandPresentation(
        "Run shell command",
        "gws gmail users drafts send --json '{\"id\":\"draft-1\"}'"
      )
    ).toEqual({ label: "Send email", command: "" });
  });

  test("uses a Gmail fallback without revealing unfamiliar Gmail syntax", () => {
    expect(terminalCommandPresentation("Run shell command", "gws gmail users labels create")).toEqual({
      label: "Use Gmail",
      command: ""
    });
  });

  test("keeps unrelated shell commands unchanged and inspectable", () => {
    expect(terminalCommandPresentation("Run shell command", "echo 'gws gmail +read --id abc'")).toEqual({
      label: "Run shell command",
      command: "echo 'gws gmail +read --id abc'"
    });
    expect(terminalCommandPresentation("Run shell command", "echo hello")).toEqual({
      label: "Run shell command",
      command: "echo hello"
    });
  });
});

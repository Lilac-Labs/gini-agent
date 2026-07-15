/// <reference lib="dom" />

import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { HomeSectionHeader } from "./HomeSectionHeader";

describe("HomeSectionHeader", () => {
  test("renders a counted disclosure with an independent action", () => {
    const onToggle = mock(() => {});
    render(
      <HomeSectionHeader
        title="Chats"
        count={3}
        open
        onToggle={onToggle}
        action={<button type="button">New chat</button>}
      />
    );

    const disclosure = screen.getByRole("button", { name: /Chats/ });
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("· 3")).not.toBeNull();
    expect(screen.getByRole("button", { name: "New chat" })).not.toBeNull();

    fireEvent.click(disclosure);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  test("renders a closed disclosure without a count or action", () => {
    render(<HomeSectionHeader title="Tasks" open={false} onToggle={() => {}} />);

    const disclosure = screen.getByRole("button", { name: "Tasks" });
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(/^·/)).toBeNull();
  });
});

/// <reference lib="dom" />

import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { HomeSectionHeader } from "./HomeSectionHeader";

describe("HomeSectionHeader", () => {
  test("renders and toggles a counted disclosure", () => {
    const onToggle = mock(() => {});
    render(<HomeSectionHeader title="Chats" count={3} open onToggle={onToggle} />);

    const disclosure = screen.getByRole("button", { name: /Chats/ });
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("· 3")).not.toBeNull();

    fireEvent.click(disclosure);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  test("renders a closed disclosure without a count", () => {
    render(<HomeSectionHeader title="Tasks" open={false} onToggle={() => {}} />);

    const disclosure = screen.getByRole("button", { name: "Tasks" });
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(/^·/)).toBeNull();
  });
});

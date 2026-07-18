/// <reference lib="dom" />

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";

const realNavigation = await import("next/navigation");
let homeResult: { data?: unknown } = { data: undefined };
let routerPush = mock(() => {});
let panelValue: { openTopicId: string | null; openTopic: (id: string) => void } | null = null;
let mountedValue = true;

mock.module("@/lib/queries", () => ({
  useHome: () => homeResult,
}));
mock.module("@/components/chat/TopicPanelContext", () => ({
  useTopicPanel: () => panelValue,
}));
mock.module("@/lib/use-mounted", () => ({
  useMounted: () => mountedValue,
}));
mock.module("next/navigation", () => ({
  ...realNavigation,
  useRouter: () => ({ push: routerPush }),
}));

let HomeDoneList: typeof import("./HomeDoneList").HomeDoneList;

beforeAll(async () => {
  const componentPath = "./HomeDoneList?home-done-compat-test";
  ({ HomeDoneList } = (await import(componentPath)) as typeof import("./HomeDoneList"));
});

afterAll(() => {
  mock.module("next/navigation", () => realNavigation);
});

describe("HomeDoneList", () => {
  beforeEach(() => {
    homeResult = { data: undefined };
    routerPush = mock(() => {});
    panelValue = null;
    mountedValue = true;
  });

  test("returns nothing before the home response loads", () => {
    render(<HomeDoneList />);
    expect(screen.queryByText("Done")).toBeNull();
  });

  test("treats a legacy home response without done as empty", () => {
    homeResult = { data: { tasks: [], recents: [] } };

    expect(() => render(<HomeDoneList />)).not.toThrow();
    expect(screen.queryByText("Done")).toBeNull();
  });

  test("omits the section for an explicitly empty done array", () => {
    homeResult = { data: { tasks: [], recents: [], done: [] } };

    render(<HomeDoneList />);
    expect(screen.queryByText("Done")).toBeNull();
  });

  test("renders and toggles done rows, including the legacy router path", () => {
    homeResult = {
      data: {
        tasks: [],
        recents: [],
        done: [{
          id: "chat-1",
          title: "Finished task",
          outcomeLine: "Completed successfully",
          completedAt: "2026-07-15T00:00:00.000Z",
        }],
      },
    };

    render(<HomeDoneList />);
    const header = screen.getByRole("button", { name: /Done/ });
    const row = screen.getByRole("link");
    expect(screen.getByText("Finished task")).not.toBeNull();
    expect(screen.getByText("Completed successfully")).not.toBeNull();
    fireEvent.click(row);
    expect(routerPush).toHaveBeenCalledWith("/chat?session=chat-1");
    fireEvent.keyDown(row, { key: "Enter" });
    fireEvent.keyDown(row, { key: " " });
    expect(routerPush).toHaveBeenCalledTimes(3);
    fireEvent.click(header);
    expect(screen.queryByText("Finished task")).toBeNull();
    fireEvent.click(header);
    expect(screen.getByText("Finished task")).not.toBeNull();
  });

  test("opens rows through the topic panel and hides unmounted timestamps", () => {
    const openTopic = mock(() => {});
    panelValue = { openTopicId: "other", openTopic };
    mountedValue = false;
    homeResult = {
      data: {
        tasks: [],
        recents: [],
        done: [{ id: "chat-2", title: "Panel task", completedAt: "2026-07-15T00:00:00.000Z" }],
      },
    };

    render(<HomeDoneList />);
    const row = screen.getByRole("button", { name: /Panel task/ });
    expect(row.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(row);
    fireEvent.keyDown(row, { key: "Enter" });
    fireEvent.keyDown(row, { key: " " });
    expect(openTopic).toHaveBeenCalledTimes(3);
    expect(screen.queryByText(/ago|just now|yesterday/i)).toBeNull();
  });
});

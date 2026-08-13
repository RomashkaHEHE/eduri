// @vitest-environment jsdom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type GuestRoom } from "../api";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  promote: vi.fn(),
}));

vi.mock("react-router-dom", () => ({
  Link: ({ children, to, ...props }: {
    children?: ReactNode;
    to: string;
  }) => createElement("a", { ...props, href: to }, children),
  useNavigate: () => mocks.navigate,
}));

vi.mock("../board/BoardSurface", () => ({
  BoardSurface: ({ readOnly }: { readOnly?: boolean }) => createElement(
    "div",
    {
      "data-testid": "board-surface",
      "data-read-only": readOnly ? "true" : "false",
    },
  ),
}));

vi.mock("../board/localStore", () => ({
  BoardIndexedDbStore: class {
    readonly whenReady = Promise.resolve();
    flush = vi.fn(async () => undefined);
    destroy = vi.fn(async () => undefined);
  },
}));

vi.mock("../board/localBoardAssets", () => ({
  LocalBoardAssetRepository: class {
    whenReady = vi.fn(async () => undefined);
    subscribe = vi.fn(() => () => undefined);
    insertImage = vi.fn();
    resolveAssetUrl = vi.fn(async () => null);
    validateForeignImages = vi.fn(async () => undefined);
    close = vi.fn(async () => undefined);
  },
}));

vi.mock("../board/promoteSoloBoard", () => ({
  promoteSoloBoardToGuestRoom: (...args: unknown[]) => mocks.promote(...args),
}));

import { SoloBoardPage } from "./SoloBoardPage";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function guestRoom(shareId: string): GuestRoom {
  return {
    shareId,
    createdAt: "2026-08-09T08:00:00.000Z",
    lastActivityAt: "2026-08-09T08:00:00.000Z",
    expiresAt: "2026-08-11T08:00:00.000Z",
    roomUrl: `/room/${shareId}`,
    resources: [{
      id: "board-resource",
      kind: "board",
      ordinal: 0,
      url: `/room/${shareId}/board`,
      createdAt: "2026-08-09T08:00:00.000Z",
      lastActivityAt: "2026-08-09T08:00:00.000Z",
    }],
  };
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  mocks.navigate.mockReset();
  mocks.promote.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.restoreAllMocks();
});

describe("SoloBoardPage session promotion", () => {
  it("keeps the Board read-only and does not navigate before promotion is durable", async () => {
    let finishPromotion!: (room: GuestRoom) => void;
    mocks.promote.mockReturnValue(new Promise<GuestRoom>((resolve) => {
      finishPromotion = resolve;
    }));

    await act(async () => {
      root?.render(createElement(SoloBoardPage));
    });
    const startButton = await vi.waitFor(() => {
      const button = [...container!.querySelectorAll("button")].find((item) => (
        item.textContent === "Начать сеанс"
      ));
      expect(button).toBeDefined();
      expect((button as HTMLButtonElement).disabled).toBe(false);
      return button as HTMLButtonElement;
    });

    await act(async () => startButton.click());
    expect(startButton.textContent).toBe("Создаём сеанс");
    expect(startButton.disabled).toBe(true);
    expect(
      container?.querySelector('[data-testid="board-surface"]')
        ?.getAttribute("data-read-only"),
    ).toBe("true");
    expect(mocks.navigate).not.toHaveBeenCalled();

    await act(async () => finishPromotion(guestRoom("share-board")));
    expect(mocks.navigate).toHaveBeenCalledWith("/room/share-board/board");
  });

  it("restores editing and exposes an error without navigating", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.promote.mockRejectedValue(new Error("network offline"));

    await act(async () => {
      root?.render(createElement(SoloBoardPage));
    });
    const startButton = await vi.waitFor(() => {
      const button = [...container!.querySelectorAll("button")].find((item) => (
        item.textContent === "Начать сеанс"
      ));
      expect(button).toBeDefined();
      expect((button as HTMLButtonElement).disabled).toBe(false);
      return button as HTMLButtonElement;
    });
    await act(async () => startButton.click());

    await vi.waitFor(() => {
      expect(container?.querySelector('[role="alert"]')?.textContent).toContain(
        "Не удалось начать сеанс",
      );
    });
    expect(startButton.disabled).toBe(false);
    expect(
      container?.querySelector('[data-testid="board-surface"]')
        ?.getAttribute("data-read-only"),
    ).toBe("false");
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("shows a server response instead of masking it as a connection error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.promote.mockRejectedValue(new ApiError(
      "Слишком много созданных сеансов",
      429,
    ));

    await act(async () => {
      root?.render(createElement(SoloBoardPage));
    });
    const startButton = await vi.waitFor(() => {
      const button = [...container!.querySelectorAll("button")].find((item) => (
        item.textContent === "Начать сеанс"
      ));
      expect(button).toBeDefined();
      return button as HTMLButtonElement;
    });
    await act(async () => startButton.click());

    await vi.waitFor(() => {
      expect(container?.querySelector('[role="alert"]')?.textContent)
        .toContain("Слишком много созданных сеансов");
    });
  });
});

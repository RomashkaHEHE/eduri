// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GuestRoom } from "../api";

const mocks = vi.hoisted(() => ({
  params: { shareId: "share-id", resourceKind: "board" as string | undefined },
  locationState: null as Record<string, unknown> | null,
  navigate: vi.fn(),
  get: vi.fn(),
  ensureResource: vi.fn(),
  callToken: vi.fn(),
  callMounts: 0,
  callUnmounts: 0,
  callProps: undefined as Record<string, unknown> | undefined,
  boardProps: undefined as Record<string, unknown> | undefined,
  codeProps: undefined as Record<string, unknown> | undefined,
}));

vi.mock("react-router-dom", () => ({
  Link: ({ to, children, ...props }: {
    to: string;
    children: React.ReactNode;
  }) => createElement("a", { ...props, href: to }, children),
  Navigate: ({ to }: { to: string }) => createElement("div", {
    "data-navigate": to,
  }),
  useLocation: () => ({ state: mocks.locationState }),
  useNavigate: () => mocks.navigate,
  useParams: () => mocks.params,
}));

vi.mock("../api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../api")>();
  return {
    ...original,
    api: {
      guestRooms: {
        get: (...args: unknown[]) => mocks.get(...args),
        ensureResource: (...args: unknown[]) => mocks.ensureResource(...args),
        callToken: (...args: unknown[]) => mocks.callToken(...args),
      },
    },
  };
});

vi.mock("../components/LessonCall", async () => {
  const React = await import("react");
  return {
    CallWorkspace: (props: Record<string, unknown>) => {
      mocks.callProps = props;
      React.useEffect(() => {
        mocks.callMounts += 1;
        return () => {
          mocks.callUnmounts += 1;
        };
      }, []);
      return createElement("div", { "data-testid": "call" }, "Call");
    },
  };
});

vi.mock("../board/LessonBoard", () => ({
  GuestBoard: (props: Record<string, unknown>) => {
    mocks.boardProps = props;
    return createElement("div", { "data-testid": "board" }, "Board");
  },
}));

vi.mock("../components/GuestCodeWorkspace", () => ({
  GuestCodeWorkspace: (props: Record<string, unknown>) => {
    mocks.codeProps = props;
    return createElement("div", { "data-testid": "code" }, "Code");
  },
}));

vi.mock("../guestIdentity", () => ({
  guestDeviceId: () => "device-id-000000000000000000000000",
}));

import { ApiError } from "../api";
import { ThemeProvider } from "../theme";
import { GuestRoomPage } from "./GuestRoomPage";

let container: HTMLDivElement | undefined;
let root: Root | undefined;

function room(kinds: Array<"board" | "code" | "call">): GuestRoom {
  return {
    shareId: "share-id",
    createdAt: "2026-08-09T00:00:00.000Z",
    lastActivityAt: "2026-08-09T00:00:00.000Z",
    expiresAt: "2026-08-11T00:00:00.000Z",
    roomUrl: "/room/share-id",
    resources: kinds.map((kind, index) => ({
      id: `${kind}-${index}`,
      kind,
      ordinal: 1,
      url: `/room/share-id/${kind}`,
      createdAt: "2026-08-09T00:00:00.000Z",
      lastActivityAt: "2026-08-09T00:00:00.000Z",
    })),
  };
}

async function renderPage(): Promise<void> {
  if (!container) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  await act(async () => {
    root?.render(createElement(
      ThemeProvider,
      null,
      createElement(GuestRoomPage),
    ));
    await Promise.resolve();
  });
}

beforeEach(() => {
  mocks.params = { shareId: "share-id", resourceKind: "board" };
  mocks.locationState = null;
  mocks.navigate.mockReset();
  mocks.get.mockReset();
  mocks.ensureResource.mockReset();
  mocks.callToken.mockReset();
  mocks.callMounts = 0;
  mocks.callUnmounts = 0;
  mocks.callProps = undefined;
  mocks.boardProps = undefined;
  mocks.codeProps = undefined;
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe("GuestRoomPage", () => {
  it("keeps the same call mounted while Board and Code switch", async () => {
    mocks.get.mockResolvedValue(room(["board", "code", "call"]));
    await renderPage();
    expect(container?.textContent).toContain("Board");
    expect(mocks.callMounts).toBe(1);

    mocks.params = { shareId: "share-id", resourceKind: "code" };
    await renderPage();
    expect(container?.textContent).toContain("Code");
    expect(mocks.codeProps).toMatchObject({
      shareId: "share-id",
      resourceId: "code-1",
      deviceId: "device-id-000000000000000000000000",
    });
    expect(mocks.callMounts).toBe(1);
    expect(mocks.callUnmounts).toBe(0);

    mocks.params = { shareId: "share-id", resourceKind: "call" };
    await renderPage();
    expect(mocks.callMounts).toBe(1);
    expect(mocks.callUnmounts).toBe(0);
  });

  it("adds a linked call without leaving the active Board and auto-joins", async () => {
    mocks.get.mockResolvedValue(room(["board"]));
    mocks.ensureResource.mockResolvedValue({
      room: room(["board", "call"]),
      created: true,
    });
    await renderPage();
    await act(async () => {
      container?.querySelector<HTMLButtonElement>(
        'button[title="Начать звонок"]',
      )?.click();
      await Promise.resolve();
    });
    expect(mocks.ensureResource).toHaveBeenCalledWith("share-id", "call");
    expect(container?.textContent).toContain("Board");
    expect(mocks.callProps?.autoJoin).toBe(true);
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("navigates to a newly linked Code resource", async () => {
    mocks.get.mockResolvedValue(room(["board"]));
    mocks.ensureResource.mockResolvedValue({
      room: room(["board", "code"]),
      created: true,
    });
    await renderPage();
    await act(async () => {
      container?.querySelector<HTMLButtonElement>(
        'button[title="Добавить код"]',
      )?.click();
      await Promise.resolve();
    });
    expect(mocks.navigate).toHaveBeenCalledWith("/room/share-id/code");
  });

  it("renders the terminal expired state with only Home", async () => {
    mocks.get.mockRejectedValue(new ApiError("Сеанс завершён", 410));
    await renderPage();
    expect(container?.textContent).toContain("Сеанс завершён");
    const links = container?.querySelectorAll("a") ?? [];
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("/");
  });

  it("renders terminal UI immediately when Guest Board reports BOARD_GONE", async () => {
    mocks.get.mockResolvedValue(room(["board"]));
    await renderPage();
    expect(container?.textContent).toContain("Board");
    const onTerminal = mocks.boardProps?.onTerminal as
      | ((kind: "expired" | "not-found") => void)
      | undefined;
    expect(onTerminal).toBeTypeOf("function");

    await act(async () => onTerminal?.("expired"));
    expect(container?.textContent).toContain("Сеанс завершён");
    expect(container?.querySelectorAll("a")).toHaveLength(1);
  });
});

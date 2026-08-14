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
  updateCallProfile: vi.fn(),
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
        updateCallProfile: (...args: unknown[]) => mocks.updateCallProfile(...args),
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
import {
  ONLINE_PROFILE_STORAGE_KEY,
  resetOnlineProfileMemoryForTests,
} from "../onlineProfile";
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
  resetOnlineProfileMemoryForTests();
  window.localStorage.clear();
  window.localStorage.setItem(ONLINE_PROFILE_STORAGE_KEY, JSON.stringify({
    version: 1,
    displayName: "Guest user",
    color: "#2563eb",
  }));
  mocks.params = { shareId: "share-id", resourceKind: "board" };
  mocks.locationState = null;
  mocks.navigate.mockReset();
  mocks.get.mockReset();
  mocks.ensureResource.mockReset();
  mocks.callToken.mockReset();
  mocks.updateCallProfile.mockReset().mockResolvedValue(undefined);
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
  vi.useRealTimers();
  window.localStorage.clear();
  resetOnlineProfileMemoryForTests();
});

describe("GuestRoomPage", () => {
  it("requires a profile before mounting room collaboration", async () => {
    window.localStorage.clear();
    resetOnlineProfileMemoryForTests();
    mocks.get.mockResolvedValue(room(["board", "call"]));

    await renderPage();
    await act(async () => Promise.resolve());

    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.body.textContent).toContain("Display Name");
    expect(mocks.boardProps).toBeUndefined();
    expect(mocks.callMounts).toBe(0);
    expect(document.body.querySelector(".modal__header .icon-button")).toBeNull();

    await act(async () => {
      document.body.querySelector<HTMLButtonElement>(
        '[role="dialog"] button[type="submit"]',
      )?.click();
      await Promise.resolve();
    });

    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(mocks.boardProps).toMatchObject({
      profile: { displayName: "Гость", color: "#2563eb" },
    });
    expect(mocks.callMounts).toBe(1);
  });

  it("does not request a profile for an expired room link", async () => {
    window.localStorage.clear();
    resetOnlineProfileMemoryForTests();
    mocks.get.mockRejectedValue(new ApiError("Сеанс завершён", 410));

    await renderPage();
    await act(async () => Promise.resolve());

    expect(container?.textContent).toContain("Сеанс завершён");
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it("places Profile immediately before the theme control", async () => {
    mocks.get.mockResolvedValue(room(["board"]));
    await renderPage();
    const actions = container?.querySelector(".guest-room__header-actions");
    expect(actions?.children[0]?.classList.contains("online-profile-button")).toBe(true);
    expect(actions?.children[1]?.classList.contains("theme-toggle")).toBe(true);
  });

  it("labels the room-link action and confirms a successful copy", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    mocks.get.mockResolvedValue(room(["board"]));
    await renderPage();
    const button = container?.querySelector<HTMLButtonElement>(
      ".guest-room__copy",
    );

    expect(button?.textContent).toBe("Ссылка");
    await act(async () => {
      button?.click();
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith(window.location.href);
    expect(button?.textContent).toBe("Скопирована");

    await act(async () => vi.advanceTimersByTime(1_500));
    expect(button?.textContent).toBe("Ссылка");
  });

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

  it("requests guest call credentials with the selected profile", async () => {
    mocks.get.mockResolvedValue(room(["board", "call"]));
    mocks.callToken.mockResolvedValue({
      url: "wss://livekit.eduri.test",
      token: "token",
      roomName: "guest-room",
    });
    await renderPage();

    const requestCredentials = mocks.callProps?.requestCredentials as
      | (() => Promise<unknown>)
      | undefined;
    expect(requestCredentials).toBeTypeOf("function");
    await requestCredentials?.();

    expect(mocks.callToken).toHaveBeenCalledWith("share-id", {
      deviceId: "device-id-000000000000000000000000",
      profile: { displayName: "Guest user", color: "#2563eb" },
    });

    const updateParticipantProfile = mocks.callProps?.updateParticipantProfile as
      | ((profile: { displayName: string; color: `#${string}` }) => Promise<void>)
      | undefined;
    expect(mocks.callProps?.profile).toEqual({
      displayName: "Guest user",
      color: "#2563eb",
    });
    await updateParticipantProfile?.({
      displayName: "Updated guest",
      color: "#d33f49",
    });
    expect(mocks.updateCallProfile).toHaveBeenCalledWith(
      "share-id",
      "device-id-000000000000000000000000",
      { displayName: "Updated guest", color: "#d33f49" },
    );
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

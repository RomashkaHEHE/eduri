// @vitest-environment jsdom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type GuestRoom } from "../api";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  promote: vi.fn(),
  workspaceProps: null as Record<string, unknown> | null,
  session: {
    document: {},
    origin: {},
    blobStore: {},
    flush: vi.fn(async () => undefined),
  },
}));

vi.mock("react-router-dom", () => ({
  Link: ({ children, to, ...props }: {
    children?: ReactNode;
    to: string;
  }) => createElement("a", { ...props, href: to }, children),
  useNavigate: () => mocks.navigate,
}));

vi.mock("../components/CodeWorkspace", () => ({
  CodeWorkspace: (props: Record<string, unknown>) => {
    mocks.workspaceProps = props;
    return createElement("div", {
      "data-testid": "code-workspace",
      "data-read-only": props.readOnly ? "true" : "false",
    });
  },
}));

vi.mock("../code/promoteSoloCode", () => ({
  promoteSoloCodeToGuestRoom: (...args: unknown[]) => mocks.promote(...args),
}));

import { SoloCodePage } from "./SoloCodePage";
import { ThemeProvider } from "../theme";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function room(shareId: string): GuestRoom {
  return {
    shareId,
    createdAt: "2026-08-09T08:00:00.000Z",
    lastActivityAt: "2026-08-09T08:00:00.000Z",
    expiresAt: "2026-08-11T08:00:00.000Z",
    roomUrl: `/room/${shareId}`,
    resources: [{
      id: "code-resource",
      kind: "code",
      ordinal: 0,
      url: `/room/${shareId}/code`,
      createdAt: "2026-08-09T08:00:00.000Z",
      lastActivityAt: "2026-08-09T08:00:00.000Z",
    }],
  };
}

async function publishSession(): Promise<void> {
  const onSessionReady = mocks.workspaceProps?.onSessionReady as
    | ((session: unknown) => void)
    | undefined;
  expect(onSessionReady).toBeTypeOf("function");
  await act(async () => onSessionReady?.(mocks.session));
}

function startButton(): HTMLButtonElement {
  const button = [...container!.querySelectorAll("button")].find((item) => (
    item.textContent === "Начать сеанс"
    || item.textContent === "Создаём сеанс"
  ));
  expect(button).toBeDefined();
  return button as HTMLButtonElement;
}

async function renderPage(): Promise<void> {
  await act(async () => root?.render(createElement(
    ThemeProvider,
    null,
    createElement(SoloCodePage),
  )));
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  mocks.navigate.mockReset();
  mocks.promote.mockReset();
  mocks.workspaceProps = null;
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

describe("SoloCodePage session promotion", () => {
  it("does not expose collaboration profile controls in solo mode", async () => {
    await renderPage();

    expect(container?.querySelector(".online-profile-button")).toBeNull();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it("keeps Code read-only and delays navigation until promotion is durable", async () => {
    let finishPromotion!: (value: GuestRoom) => void;
    mocks.promote.mockReturnValue(new Promise<GuestRoom>((resolve) => {
      finishPromotion = resolve;
    }));

    await renderPage();
    expect(startButton().disabled).toBe(true);
    await publishSession();
    const button = startButton();
    expect(button.disabled).toBe(false);

    await act(async () => button.click());
    expect(button.textContent).toBe("Создаём сеанс");
    expect(button.disabled).toBe(true);
    expect(
      container?.querySelector('[data-testid="code-workspace"]')
        ?.getAttribute("data-read-only"),
    ).toBe("true");
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.promote).toHaveBeenCalledWith(expect.objectContaining({
      session: mocks.session,
      signal: expect.any(AbortSignal),
    }));

    await act(async () => finishPromotion(room("share-code")));
    expect(mocks.navigate).toHaveBeenCalledWith("/room/share-code/code");
  });

  it("restores editing and exposes an error without navigating", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.promote.mockRejectedValue(new Error("network offline"));

    await renderPage();
    await publishSession();
    const button = startButton();
    await act(async () => button.click());

    await vi.waitFor(() => {
      expect(container?.querySelector('[role="alert"]')?.textContent)
        .toContain("Не удалось начать сеанс");
    });
    expect(button.disabled).toBe(false);
    expect(
      container?.querySelector('[data-testid="code-workspace"]')
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

    await renderPage();
    await publishSession();
    await act(async () => startButton().click());

    await vi.waitFor(() => {
      expect(container?.querySelector('[role="alert"]')?.textContent)
        .toContain("Слишком много созданных сеансов");
    });
  });

  it("aborts an unfinished promotion when the page unmounts", async () => {
    let finishPromotion!: (value: GuestRoom) => void;
    mocks.promote.mockReturnValue(new Promise<GuestRoom>((resolve) => {
      finishPromotion = resolve;
    }));

    await renderPage();
    await publishSession();
    await act(async () => startButton().click());
    const signal = (mocks.promote.mock.calls[0]?.[0] as {
      signal: AbortSignal;
    }).signal;
    expect(signal.aborted).toBe(false);

    await act(async () => root?.unmount());
    root = null;
    expect(signal.aborted).toBe(true);
    await act(async () => finishPromotion(room("aborted-code")));
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { ConnectionError } from "livekit-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LessonSummary } from "../../shared/types";
import { CallWorkspace, LessonCall } from "./LessonCall";

const mocks = vi.hoisted(() => ({
  callToken: vi.fn(),
  liveKitRoomProps: undefined as Record<string, unknown> | undefined,
}));

vi.mock("../api", () => ({
  api: { lessons: { callToken: mocks.callToken } },
}));

vi.mock("@livekit/components-react", () => ({
  LiveKitRoom: (props: Record<string, unknown>) => {
    mocks.liveKitRoomProps = props;
    return createElement("div", {
      className: props.className as string,
      "data-testid": "livekit-room",
    });
  },
  ParticipantTile: () => null,
  RoomAudioRenderer: () => null,
  StartAudio: () => null,
  useConnectionState: vi.fn(),
  useLocalParticipant: vi.fn(),
  useParticipants: vi.fn(),
  useRoomContext: vi.fn(),
  useTracks: vi.fn(),
}));

let container: HTMLDivElement | undefined;
let root: Root | undefined;

beforeEach(() => {
  (globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.callToken.mockReset();
  mocks.liveKitRoomProps = undefined;
  document.documentElement.removeAttribute("data-theme");
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  document.documentElement.removeAttribute("data-theme");
  document.querySelector("style[data-lesson-call-theme-test]")?.remove();
});

function installCallThemeStyles() {
  const source = readFileSync(
    resolve(process.cwd(), "src", "client", "styles.css"),
    "utf8",
  );
  const start = source.indexOf("/* Call / LiveKit colors follow");
  const end = source.indexOf(".dock-tabs", start);
  if (start < 0 || end < 0) throw new Error("Call theme CSS block is unavailable");
  const style = document.createElement("style");
  style.dataset.lessonCallThemeTest = "true";
  style.textContent = source.slice(start, end);
  document.head.append(style);
  return source;
}

function callToken(element: Element, name: string) {
  return getComputedStyle(element).getPropertyValue(name).trim();
}

async function joinActiveCall() {
  mocks.callToken.mockResolvedValue({
    url: "wss://livekit.eduri.test",
    token: "token",
    roomName: "lesson-room",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(createElement(LessonCall, { lessonId: "lesson-id", status: "active" })));
  await act(async () => {
    container?.querySelector<HTMLButtonElement>(".call-join-button")?.click();
  });
  expect(mocks.liveKitRoomProps).toBeDefined();
}

describe("LessonCall", () => {
  it("switches lobby and LiveKit tokens with the global theme without remounting", async () => {
    const styles = installCallThemeStyles();
    const requestCredentials = vi.fn().mockResolvedValue({
      url: "wss://livekit.eduri.test",
      token: "token",
      roomName: "theme-room",
    });
    document.documentElement.dataset.theme = "light";
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(createElement(CallWorkspace, { requestCredentials }));
    });

    const lobby = container.querySelector(".lesson-call--lobby");
    const guestCall = document.createElement("aside");
    guestCall.className = "guest-room__call";
    document.body.append(guestCall);
    expect(lobby).not.toBeNull();
    expect(callToken(lobby!, "--call-shell-bg")).toBe("#f4f7f9");
    expect(callToken(lobby!, "--call-control-bg")).toBe("#dbe4eb");
    expect(callToken(lobby!, "--call-error-bg")).toBe("#fff0ef");
    expect(callToken(guestCall, "--call-shell-bg")).toBe("#f4f7f9");

    document.documentElement.dataset.theme = "dark";
    expect(container.querySelector(".lesson-call--lobby")).toBe(lobby);
    expect(callToken(lobby!, "--call-shell-bg")).toBe("#171816");
    expect(callToken(lobby!, "--call-control-bg")).toBe("#30312e");
    expect(callToken(lobby!, "--call-error-bg")).toBe("#3c2929");
    expect(callToken(guestCall, "--call-shell-bg")).toBe("#171816");

    await act(async () => {
      container?.querySelector<HTMLButtonElement>(".call-join-button")?.click();
      await Promise.resolve();
    });

    const room = container.querySelector(".call-room");
    expect(room).not.toBeNull();
    expect(callToken(room!, "--call-shell-bg")).toBe("#171816");
    expect(callToken(room!, "--lk-bg")).toBe("var(--call-shell-bg)");

    document.documentElement.dataset.theme = "light";
    expect(container.querySelector(".call-room")).toBe(room);
    expect(callToken(room!, "--call-shell-bg")).toBe("#f4f7f9");
    expect(styles).toContain(
      ".guest-room { position: relative; display: grid; grid-template-rows: 52px minmax(0, 1fr); color: var(--ink); background: var(--background); }",
    );
    expect(styles).toContain(
      ".guest-room__call { color: var(--call-shell-text); border-left: 1px solid var(--call-shell-border); background: var(--call-shell-bg); }",
    );
    const callStyles = styles.slice(
      styles.indexOf("/* Call / LiveKit colors follow"),
      styles.indexOf(".dock-tabs"),
    );
    const hardCodedCallColors = [...callStyles.matchAll(
      /(?:^|[;{]\s*)(?:color|background|border(?:-color)?|box-shadow|text-shadow)\s*:\s*(?:#[\da-f]{3,8}\b|rgba?\(|white\b|black\b)/gimu,
    )].map((match) => match[0].trim());
    expect(hardCodedCallColors).toEqual([]);
    guestCall.remove();
  });

  it("auto-joins only when the caller explicitly requests it", async () => {
    const requestCredentials = vi.fn().mockResolvedValue({
      url: "wss://livekit.eduri.test",
      token: "token",
      roomName: "guest-room",
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(CallWorkspace, {
        requestCredentials,
        autoJoin: true,
      }));
      await Promise.resolve();
    });
    expect(requestCredentials).toHaveBeenCalledOnce();
    expect(mocks.liveKitRoomProps).toMatchObject({
      serverUrl: "wss://livekit.eduri.test",
      connect: true,
    });
  });

  it.each<LessonSummary["status"]>(["completed", "cancelled"])(
    "does not offer joining a %s lesson",
    (status) => {
      const markup = renderToStaticMarkup(createElement(LessonCall, { lessonId: "lesson-id", status }));

      expect(markup).not.toContain("call-join-button");
      expect(markup).not.toContain("Подключиться</button>");
    },
  );

  it.each<LessonSummary["status"]>(["scheduled", "active"])(
    "offers joining an %s lesson",
    (status) => {
      const markup = renderToStaticMarkup(createElement(LessonCall, { lessonId: "lesson-id", status }));

      expect(markup).toContain("call-join-button");
      expect(markup).toContain("Подключиться</button>");
    },
  );

  it("returns to a retryable lobby when the LiveKit connection fails", async () => {
    await joinActiveCall();
    const onError = mocks.liveKitRoomProps?.onError as ((reason: Error) => void) | undefined;

    await act(async () => onError?.(ConnectionError.serverUnreachable("Сервер звонков недоступен")));

    expect(container?.textContent).toContain("Связь прервалась");
    expect(container?.textContent).toContain("Сервер звонков недоступен");
    expect(container?.textContent).toContain("Подключиться снова");
  });

  it("keeps media-device errors inside the active call", async () => {
    await joinActiveCall();
    const onError = mocks.liveKitRoomProps?.onError as ((reason: Error) => void) | undefined;

    await act(async () => onError?.(new DOMException("Permission denied", "NotAllowedError")));

    expect(container?.querySelector(".call-join-button")).toBeNull();
    expect(mocks.callToken).toHaveBeenCalledTimes(1);
  });
});

// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { ConnectionError, ConnectionState, Room, Track } from "livekit-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LessonSummary } from "../../shared/types";
import { CallWorkspace, LessonCall } from "./LessonCall";

const PROFILE = { displayName: "Call user", color: "#2563eb" as const };

const mocks = vi.hoisted(() => ({
  callToken: vi.fn(),
  updateCallProfile: vi.fn(),
  liveKitRoomProps: undefined as Record<string, unknown> | undefined,
  connectionState: "connected",
  room: {
    disconnect: vi.fn(),
    switchActiveDevice: vi.fn(),
  },
  localParticipant: {
    identity: "local-user",
    setMicrophoneEnabled: vi.fn(),
    setCameraEnabled: vi.fn(),
    setScreenShareEnabled: vi.fn(),
  },
  isMicrophoneEnabled: false,
  isCameraEnabled: false,
  isScreenShareEnabled: false,
  visualTracks: [] as Array<Record<string, unknown>>,
  participants: [] as Array<Record<string, unknown>>,
}));

vi.mock("../api", () => ({
  api: {
    lessons: {
      callToken: mocks.callToken,
      updateCallProfile: mocks.updateCallProfile,
    },
  },
}));

vi.mock("@livekit/components-react", async () => {
  const React = await import("react");
  const trackContext = React.createContext<Record<string, unknown> | undefined>(undefined);
  const renderTracks = (
    tag: "div" | "aside",
    baseClassName: string,
    props: Record<string, unknown>,
  ) => React.createElement(
    tag,
    {
      className: `${baseClassName} ${String(props.className ?? "")}`.trim(),
      ...(tag === "aside" ? { "data-lk-orientation": "vertical" } : {}),
    },
    (props.tracks as Array<Record<string, unknown>>).map((track, index) => React.createElement(
      trackContext.Provider,
      { value: track, key: `${String(track.source)}:${index}` },
      props.children as React.ReactNode,
    )),
  );

  return {
  LiveKitRoom: (props: Record<string, unknown>) => {
    mocks.liveKitRoomProps = props;
    return React.createElement("div", {
      className: props.className as string,
      "data-testid": "livekit-room",
    }, props.children as React.ReactNode);
  },
  CarouselLayout: (props: Record<string, unknown>) => renderTracks("aside", "lk-carousel", props),
  FocusLayoutContainer: (props: Record<string, unknown>) => React.createElement(
    "div",
    { className: `lk-focus-layout ${String(props.className ?? "")}`.trim() },
    props.children as React.ReactNode,
  ),
  GridLayout: (props: Record<string, unknown>) => renderTracks("div", "lk-grid-layout", props),
  ParticipantTile: (props: Record<string, unknown>) => React.createElement("div", {
    className: props.className,
    "data-testid": "participant-media",
  }),
  RoomAudioRenderer: () => null,
  StartAudio: () => null,
  isTrackReference: (track: Record<string, unknown> | undefined) => Boolean(track?.publication),
  useConnectionState: () => mocks.connectionState,
  useLocalParticipant: () => ({
    localParticipant: mocks.localParticipant,
    isMicrophoneEnabled: mocks.isMicrophoneEnabled,
    isCameraEnabled: mocks.isCameraEnabled,
    isScreenShareEnabled: mocks.isScreenShareEnabled,
  }),
  useMaybeTrackRefContext: () => React.useContext(trackContext),
  useParticipants: () => mocks.participants.length ? mocks.participants : [mocks.localParticipant],
  useRoomContext: () => mocks.room,
  useTracks: () => mocks.visualTracks,
  };
});

let container: HTMLDivElement | undefined;
let root: Root | undefined;
const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
const originalSetSinkId = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "setSinkId");

function setAudioOutputSupport(supported: boolean) {
  if (!supported) {
    Reflect.deleteProperty(HTMLMediaElement.prototype, "setSinkId");
    return;
  }
  Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", {
    configurable: true,
    value: vi.fn().mockResolvedValue(undefined),
  });
}

function mediaDevice(kind: MediaDeviceKind, deviceId: string, label: string): MediaDeviceInfo {
  return {
    kind,
    deviceId,
    label,
    groupId: "test-group",
    toJSON: () => ({ kind, deviceId, label, groupId: "test-group" }),
  };
}

function callParticipant(identity: string, name: string, isLocal = false) {
  return { identity, name, isLocal };
}

function visualTrack(
  participant: ReturnType<typeof callParticipant>,
  source: Track.Source.Camera | Track.Source.ScreenShare,
  trackSid?: string,
  isMuted = false,
) {
  return trackSid
    ? {
        participant,
        source,
        publication: { source, trackSid, isMuted },
      }
    : { participant, source };
}

async function clickButton(label: string) {
  const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button).not.toBeNull();
  await act(async () => {
    button?.click();
    await Promise.resolve();
  });
}

async function clickLabeledElement(label: string) {
  const element = document.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  expect(element).not.toBeNull();
  await act(async () => {
    element?.click();
    await Promise.resolve();
  });
}

async function selectOption(label: string, value: string) {
  const select = document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  expect(select).not.toBeNull();
  await act(async () => {
    if (select) {
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    await Promise.resolve();
  });
}

async function clickDeviceOption(groupLabel: string, optionLabel: string) {
  const group = document.querySelector(`[role="radiogroup"][aria-label="${groupLabel}"]`);
  const button = Array.from(group?.querySelectorAll<HTMLButtonElement>("button") ?? [])
    .find((candidate) => candidate.textContent === optionLabel);
  expect(button).toBeDefined();
  await act(async () => {
    button?.click();
    await Promise.resolve();
  });
}

async function clickButtonWithText(label: string) {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
    .find((candidate) => candidate.textContent === label);
  expect(button).toBeDefined();
  await act(async () => {
    button?.click();
    await Promise.resolve();
  });
}

beforeEach(() => {
  (globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.callToken.mockReset();
  mocks.updateCallProfile.mockReset().mockResolvedValue(undefined);
  mocks.liveKitRoomProps = undefined;
  mocks.connectionState = ConnectionState.Connected;
  mocks.room.disconnect.mockReset().mockResolvedValue(undefined);
  mocks.room.switchActiveDevice.mockReset().mockResolvedValue(true);
  mocks.localParticipant.setMicrophoneEnabled.mockReset().mockResolvedValue(undefined);
  mocks.localParticipant.setCameraEnabled.mockReset().mockResolvedValue(undefined);
  mocks.localParticipant.setScreenShareEnabled.mockReset().mockResolvedValue(undefined);
  mocks.isMicrophoneEnabled = false;
  mocks.isCameraEnabled = false;
  mocks.isScreenShareEnabled = false;
  mocks.visualTracks = [];
  mocks.participants = [];
  vi.spyOn(Room, "getLocalDevices").mockResolvedValue([]);
  setAudioOutputSupport(false);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      getDisplayMedia: vi.fn(),
    },
  });
  window.localStorage.removeItem("eduri-call-devices-v1");
  document.documentElement.removeAttribute("data-theme");
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  document.documentElement.removeAttribute("data-theme");
  document.querySelector("style[data-lesson-call-theme-test]")?.remove();
  vi.restoreAllMocks();
  if (originalMediaDevices) {
    Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
  } else {
    Reflect.deleteProperty(navigator, "mediaDevices");
  }
  if (originalSetSinkId) {
    Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", originalSetSinkId);
  } else {
    Reflect.deleteProperty(HTMLMediaElement.prototype, "setSinkId");
  }
  window.localStorage.removeItem("eduri-call-devices-v1");
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
  await act(async () => root?.render(createElement(LessonCall, {
    lessonId: "lesson-id",
    status: "active",
    profile: PROFILE,
  })));
  await act(async () => {
    container?.querySelector<HTMLButtonElement>(".call-join-button")?.click();
  });
  expect(mocks.liveKitRoomProps).toBeDefined();
}

describe("LessonCall", () => {
  it("requests a LiveKit token with the selected collaboration profile", async () => {
    await joinActiveCall();

    expect(mocks.callToken).toHaveBeenCalledWith("lesson-id", PROFILE);
    expect(mocks.updateCallProfile).not.toHaveBeenCalled();
  });

  it("updates an active participant profile without replacing the room or media", async () => {
    await joinActiveCall();
    const mountedRoom = container?.querySelector('[data-testid="livekit-room"]');
    const nextProfile = { displayName: "Updated call user", color: "#d33f49" as const };

    await act(async () => {
      root?.render(createElement(LessonCall, {
        lessonId: "lesson-id",
        status: "active",
        profile: nextProfile,
      }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.updateCallProfile).toHaveBeenCalledWith(
      "lesson-id",
      nextProfile,
    );
    expect(mocks.callToken).toHaveBeenCalledTimes(1);
    expect(container?.querySelector('[data-testid="livekit-room"]')).toBe(mountedRoom);
    expect(mocks.liveKitRoomProps?.token).toBe("token");
    expect(mocks.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
    expect(mocks.localParticipant.setCameraEnabled).not.toHaveBeenCalled();
  });

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
      audio: false,
      video: false,
    });
    expect(mocks.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
    expect(mocks.localParticipant.setCameraEnabled).not.toHaveBeenCalled();
  });

  it("switches intuitively between equal grid, focused screen, and focused camera", async () => {
    const tutor = callParticipant("tutor", "Tutor");
    const student = callParticipant("student", "Student");
    mocks.participants = [tutor, student];
    mocks.visualTracks = [
      visualTrack(tutor, Track.Source.Camera, "camera-tutor"),
      visualTrack(tutor, Track.Source.ScreenShare, "screen-tutor"),
      visualTrack(student, Track.Source.Camera),
    ];
    await joinActiveCall();

    expect(container?.querySelector(".call-layout-grid")).not.toBeNull();
    expect(container?.querySelectorAll(".call-track-tile")).toHaveLength(3);
    expect(container?.querySelector(".call-focus-layout")).toBeNull();

    await clickLabeledElement("Tutor: Демонстрация экрана");
    expect(container?.querySelector(".call-focus-layout")).not.toBeNull();
    expect(container?.querySelector('[data-track-source="screen_share"].is-focused')).not.toBeNull();
    expect(container?.querySelector(".call-track-carousel")?.children).toHaveLength(2);

    await clickLabeledElement("Tutor: Камера");
    expect(container?.querySelector('[data-track-source="camera"].is-focused')).not.toBeNull();
    expect(container?.querySelector('[data-track-source="screen_share"].is-focused')).toBeNull();

    await clickLabeledElement("Tutor: Камера");
    expect(container?.querySelector(".call-focus-layout")).toBeNull();
    expect(container?.querySelector(".call-layout-grid")).not.toBeNull();
  });

  it("keeps participants without media as compact non-focusable cards", async () => {
    const local = callParticipant("local-user", "Call user", true);
    mocks.participants = [local];
    mocks.visualTracks = [visualTrack(local, Track.Source.Camera)];
    await joinActiveCall();

    const grid = container?.querySelector(".call-layout-grid");
    const tile = container?.querySelector<HTMLElement>(".call-track-tile--no-media");
    expect(grid?.classList.contains("is-media-empty")).toBe(true);
    expect(tile?.getAttribute("role")).toBe("group");
    expect(tile?.getAttribute("tabindex")).toBeNull();
    expect(tile?.textContent).toContain("Вы");
    expect(tile?.textContent).toContain("Без видео");

    await act(async () => tile?.click());
    expect(container?.querySelector(".call-focus-layout")).toBeNull();
  });

  it("returns to the grid when the focused stream disappears", async () => {
    const tutor = callParticipant("tutor", "Tutor");
    const camera = visualTrack(tutor, Track.Source.Camera, "camera-tutor");
    mocks.participants = [tutor];
    mocks.visualTracks = [
      camera,
      visualTrack(tutor, Track.Source.ScreenShare, "screen-tutor"),
    ];
    await joinActiveCall();
    await clickLabeledElement("Tutor: Демонстрация экрана");
    expect(container?.querySelector(".call-focus-layout")).not.toBeNull();

    mocks.visualTracks = [camera];
    await act(async () => {
      root?.render(createElement(LessonCall, {
        lessonId: "lesson-id",
        status: "active",
        profile: PROFILE,
      }));
      await Promise.resolve();
    });

    expect(container?.querySelector(".call-focus-layout")).toBeNull();
    expect(container?.querySelector(".call-layout-grid")).not.toBeNull();
  });

  it("enters muted and asks for a camera choice before its first activation", async () => {
    await joinActiveCall();

    expect(mocks.liveKitRoomProps).toMatchObject({ audio: false, video: false });
    expect(mocks.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
    expect(mocks.localParticipant.setCameraEnabled).not.toHaveBeenCalled();

    await clickButton("Включить микрофон");
    expect(mocks.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true);
    expect(mocks.localParticipant.setCameraEnabled).not.toHaveBeenCalled();

    await clickButton("Включить камеру");
    expect(mocks.localParticipant.setCameraEnabled).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"][aria-label="Выберите камеру"]')).not.toBeNull();

    await clickDeviceOption("Камера", "По умолчанию");
    expect(mocks.room.switchActiveDevice).toHaveBeenCalledWith("videoinput", "default", false);
    expect(mocks.localParticipant.setCameraEnabled).toHaveBeenCalledWith(true);
    expect(JSON.parse(window.localStorage.getItem("eduri-call-devices-v1") ?? "null")).toMatchObject({
      videoInput: "default",
      videoInputSelected: true,
    });

    mocks.localParticipant.setCameraEnabled.mockClear();
    await clickButton("Включить камеру");
    expect(mocks.localParticipant.setCameraEnabled).toHaveBeenCalledWith(true);
    expect(document.querySelector('[role="dialog"][aria-label="Выберите камеру"]')).toBeNull();
  });

  it("enumerates without permission and switches the selected microphone and camera", async () => {
    vi.mocked(Room.getLocalDevices).mockResolvedValue([
      mediaDevice("audioinput", "mic-two", "Studio microphone"),
      mediaDevice("videoinput", "camera-two", "Desk camera"),
    ]);
    await joinActiveCall();

    await clickButton("Выбрать микрофон и наушники");
    expect(Room.getLocalDevices).toHaveBeenCalledWith(undefined, false);

    await clickDeviceOption("Микрофон", "Studio microphone");
    expect(mocks.room.switchActiveDevice).toHaveBeenCalledWith("audioinput", "mic-two", true);
    await clickButton("Выбрать камеру");
    await clickDeviceOption("Камера", "Desk camera");
    expect(mocks.room.switchActiveDevice).toHaveBeenCalledWith("videoinput", "camera-two", true);

    expect(JSON.parse(window.localStorage.getItem("eduri-call-devices-v1") ?? "null")).toMatchObject({
      version: 1,
      audioInput: "mic-two",
      videoInput: "camera-two",
      videoInputSelected: true,
    });
    expect(mocks.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
    expect(mocks.localParticipant.setCameraEnabled).not.toHaveBeenCalled();

    await clickButton("Выбрать камеру");
    await clickButton("Разрешить доступ и обновить устройства");
    expect(Room.getLocalDevices).toHaveBeenLastCalledWith(undefined, true);
  });

  it("restores device choices but still enters muted and supports speaker selection", async () => {
    setAudioOutputSupport(true);
    window.localStorage.setItem("eduri-call-devices-v1", JSON.stringify({
      version: 1,
      audioInput: "saved-mic",
      audioOutput: "saved-speaker",
      videoInput: "saved-camera",
    }));
    vi.mocked(Room.getLocalDevices).mockResolvedValue([
      mediaDevice("audiooutput", "speaker-two", "Headphones"),
    ]);
    await joinActiveCall();

    expect(mocks.liveKitRoomProps).toMatchObject({
      audio: false,
      video: false,
      options: {
        audioCaptureDefaults: { deviceId: "saved-mic" },
        videoCaptureDefaults: { deviceId: "saved-camera" },
        audioOutput: { deviceId: "saved-speaker" },
      },
    });

    await clickButton("Выбрать микрофон и наушники");
    await clickDeviceOption("Наушники", "Headphones");
    expect(mocks.room.switchActiveDevice).toHaveBeenCalledWith("audiooutput", "speaker-two", true);
  });

  it("uses browser-default output when speaker selection is unsupported", async () => {
    await joinActiveCall();
    const options = mocks.liveKitRoomProps?.options as Record<string, unknown>;
    expect(options).not.toHaveProperty("audioOutput");

    await clickButton("Открыть настройки звонка");
    expect(document.querySelector('[role="dialog"][aria-modal="true"]')?.textContent)
      .toContain("Настройки звонка");
    const speakers = document.querySelector<HTMLSelectElement>('select[aria-label="Наушники"]');
    expect(speakers?.disabled).toBe(true);
    expect(speakers?.textContent).toContain("Не поддерживается");
  });

  it("does not save a device when LiveKit rejects the switch", async () => {
    vi.mocked(Room.getLocalDevices).mockResolvedValue([
      mediaDevice("audioinput", "rejected-mic", "Rejected microphone"),
    ]);
    mocks.room.switchActiveDevice.mockResolvedValueOnce(false);
    await joinActiveCall();

    await clickButton("Выбрать микрофон и наушники");
    await clickDeviceOption("Микрофон", "Rejected microphone");

    expect(window.localStorage.getItem("eduri-call-devices-v1")).toBeNull();
    expect(container?.textContent).toContain("Микрофон недоступен");
  });

  it("opens the protected browser source chooser when screen sharing starts", async () => {
    await joinActiveCall();

    await clickButton("Начать демонстрацию");
    expect(mocks.localParticipant.setScreenShareEnabled).toHaveBeenCalledWith(true, {
      audio: true,
      video: true,
      contentHint: "detail",
      selfBrowserSurface: "include",
      surfaceSwitching: "include",
      systemAudio: "include",
      preferCurrentTab: false,
    });
  });

  it("opens the browser source chooser from the screen-share arrow and can switch a source", async () => {
    mocks.isScreenShareEnabled = true;
    await joinActiveCall();

    await clickButton("Выбрать экран или окно");
    expect(mocks.localParticipant.setScreenShareEnabled).not.toHaveBeenCalled();
    await clickButtonWithText("Сменить экран или окно");

    expect(mocks.localParticipant.setScreenShareEnabled.mock.calls[0]).toEqual([false]);
    expect(mocks.localParticipant.setScreenShareEnabled.mock.calls[1]?.[0]).toBe(true);
  });

  it.each<LessonSummary["status"]>(["completed", "cancelled"])(
    "does not offer joining a %s lesson",
    (status) => {
      const markup = renderToStaticMarkup(createElement(LessonCall, {
        lessonId: "lesson-id",
        status,
        profile: PROFILE,
      }));

      expect(markup).not.toContain("call-join-button");
      expect(markup).not.toContain("Подключиться</button>");
    },
  );

  it.each<LessonSummary["status"]>(["scheduled", "active"])(
    "offers joining an %s lesson",
    (status) => {
      const markup = renderToStaticMarkup(createElement(LessonCall, {
        lessonId: "lesson-id",
        status,
        profile: PROFILE,
      }));

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

// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ConnectionError,
  ConnectionState,
  LocalAudioTrack,
  Room,
  Track,
} from "livekit-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LessonSummary } from "../../shared/types";
import { CallWorkspace, LessonCall } from "./LessonCall";

const PROFILE = { displayName: "Call user", color: "#2563eb" as const };

const mocks = vi.hoisted(() => ({
  callToken: vi.fn(),
  callParticipants: vi.fn(),
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
    getTrackPublication: vi.fn(),
    getTrackPublications: vi.fn(() => []),
  },
  isMicrophoneEnabled: false,
  isCameraEnabled: false,
  isScreenShareEnabled: false,
  visualTracks: [] as Array<Record<string, unknown>>,
  participants: [] as Array<Record<string, unknown>>,
  trackVolume: 0,
  connectionQuality: "excellent",
  permissionStates: {
    microphone: "granted" as PermissionState,
    camera: "granted" as PermissionState,
  },
  permissionChangeHandlers: {
    microphone: undefined as EventListener | undefined,
    camera: undefined as EventListener | undefined,
  },
}));

vi.mock("../api", () => ({
  api: {
    lessons: {
      callToken: mocks.callToken,
      callParticipants: mocks.callParticipants,
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
  useConnectionQualityIndicator: () => ({ quality: mocks.connectionQuality }),
  useLocalParticipant: () => ({
    localParticipant: mocks.localParticipant,
    isMicrophoneEnabled: mocks.isMicrophoneEnabled,
    isCameraEnabled: mocks.isCameraEnabled,
    isScreenShareEnabled: mocks.isScreenShareEnabled,
  }),
  useMaybeTrackRefContext: () => React.useContext(trackContext),
  useParticipants: () => mocks.participants.length ? mocks.participants : [mocks.localParticipant],
  useRoomContext: () => mocks.room,
  useTrackVolume: () => mocks.trackVolume,
  useTracks: () => mocks.visualTracks,
  };
});

let container: HTMLDivElement | undefined;
let root: Root | undefined;
const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
const originalPermissions = Object.getOwnPropertyDescriptor(navigator, "permissions");
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
  return {
    identity,
    name,
    isLocal,
    connectionQuality: mocks.connectionQuality,
    setVolume: vi.fn(),
    getTrackPublication: vi.fn(),
    getTrackPublications: vi.fn(() => []),
  };
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

async function changeRange(label: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  expect(input).not.toBeNull();
  await act(async () => {
    if (input) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
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
  mocks.callParticipants.mockReset().mockResolvedValue([]);
  mocks.updateCallProfile.mockReset().mockResolvedValue(undefined);
  mocks.liveKitRoomProps = undefined;
  mocks.connectionState = ConnectionState.Connected;
  mocks.room.disconnect.mockReset().mockResolvedValue(undefined);
  mocks.room.switchActiveDevice.mockReset().mockResolvedValue(true);
  mocks.localParticipant.setMicrophoneEnabled.mockReset().mockResolvedValue(undefined);
  mocks.localParticipant.setCameraEnabled.mockReset().mockResolvedValue(undefined);
  mocks.localParticipant.setScreenShareEnabled.mockReset().mockResolvedValue(undefined);
  mocks.localParticipant.getTrackPublication.mockReset();
  mocks.localParticipant.getTrackPublications.mockReset().mockReturnValue([]);
  mocks.isMicrophoneEnabled = false;
  mocks.isCameraEnabled = false;
  mocks.isScreenShareEnabled = false;
  mocks.visualTracks = [];
  mocks.participants = [];
  mocks.trackVolume = 0;
  mocks.connectionQuality = "excellent";
  mocks.permissionStates.microphone = "granted";
  mocks.permissionStates.camera = "granted";
  mocks.permissionChangeHandlers.microphone = undefined;
  mocks.permissionChangeHandlers.camera = undefined;
  vi.spyOn(Room, "getLocalDevices").mockResolvedValue([]);
  setAudioOutputSupport(false);
  Object.defineProperty(navigator, "permissions", {
    configurable: true,
    value: {
      query: vi.fn(async ({ name }: PermissionDescriptor) => {
        const kind = name as "microphone" | "camera";
        return {
          get state() {
            return mocks.permissionStates[kind];
          },
          onchange: null,
          addEventListener: vi.fn((_type: string, listener: EventListener) => {
            mocks.permissionChangeHandlers[kind] = listener;
          }),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        };
      }),
    },
  });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      getDisplayMedia: vi.fn(),
      getUserMedia: vi.fn(async (constraints: MediaStreamConstraints) => {
        const audioTrack = { stop: vi.fn() };
        const videoTrack = { stop: vi.fn() };
        const audioTracks = constraints.audio ? [audioTrack] : [];
        const videoTracks = constraints.video ? [videoTrack] : [];
        return {
          getTracks: () => [...audioTracks, ...videoTracks],
          getAudioTracks: () => audioTracks,
          getVideoTracks: () => videoTracks,
        };
      }),
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
  if (originalPermissions) {
    Object.defineProperty(navigator, "permissions", originalPermissions);
  } else {
    Reflect.deleteProperty(navigator, "permissions");
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
  it("shows lobby participants with media indicators using the expected inverted rules", async () => {
    mocks.callParticipants.mockResolvedValue([
      {
        identity: "tutor:1",
        displayName: "Tutor One",
        color: "#2563eb",
        microphoneEnabled: false,
        cameraEnabled: true,
        screenShareEnabled: true,
      },
      {
        identity: "student:1",
        displayName: "Student Two",
        color: "#d33f49",
        microphoneEnabled: true,
        cameraEnabled: false,
        screenShareEnabled: false,
      },
    ]);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(createElement(LessonCall, {
        lessonId: "lesson-id",
        status: "active",
        profile: PROFILE,
      }));
      await Promise.resolve();
    });

    expect(mocks.callParticipants).toHaveBeenCalledWith("lesson-id");
    const participants = container.querySelectorAll(".call-lobby-participant");
    expect(participants).toHaveLength(2);
    expect(participants[0]?.textContent).toContain("Tutor One");
    expect(participants[0]?.querySelector('[aria-label="Микрофон выключен"]')).not.toBeNull();
    expect(participants[0]?.querySelector('[aria-label="Камера включена"]')).not.toBeNull();
    expect(participants[0]?.querySelector('[aria-label="Демонстрация экрана включена"]')).not.toBeNull();
    expect(participants[1]?.textContent).toContain("Student Two");
    expect(participants[1]?.querySelector(".call-lobby-participant__media")?.children).toHaveLength(0);
  });

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

  it("requests microphone and camera access before enabling their controls", async () => {
    mocks.permissionStates.microphone = "prompt";
    mocks.permissionStates.camera = "denied";
    const stopAudio = vi.fn();
    const stopVideo = vi.fn();
    const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => {
      const audioTracks = constraints.audio ? [{ stop: stopAudio }] : [];
      const videoTracks = constraints.video ? [{ stop: stopVideo }] : [];
      return {
        getTracks: () => [...audioTracks, ...videoTracks],
        getAudioTracks: () => audioTracks,
        getVideoTracks: () => videoTracks,
      };
    });
    Object.assign(navigator.mediaDevices, { getUserMedia });
    await joinActiveCall();

    const microphone = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Запросить доступ к микрофону"]',
    );
    const camera = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Запросить доступ к камере"]',
    );
    expect(microphone?.classList.contains("is-access-inactive")).toBe(true);
    expect(microphone?.getAttribute("title")).toBeNull();
    expect(microphone?.querySelector('[role="tooltip"]')?.textContent)
      .toBe("Браузер не дал доступ к микрофону");
    expect(camera?.classList.contains("is-access-inactive")).toBe(true);
    expect(camera?.querySelector('[role="tooltip"]')?.textContent)
      .toBe("Браузер не дал доступ к камере");

    await clickButton("Запросить доступ к микрофону");
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true, video: false });
    expect(stopAudio).toHaveBeenCalledOnce();
    expect(mocks.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
    expect(document.querySelector('button[aria-label="Включить микрофон"]'))
      .not.toBeNull();

    await clickButton("Включить микрофон");
    expect(mocks.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true);

    await clickButton("Запросить доступ к камере");
    expect(getUserMedia).toHaveBeenCalledWith({ audio: false, video: true });
    expect(stopVideo).toHaveBeenCalledOnce();
    expect(document.querySelector('button[aria-label="Включить камеру"]'))
      .not.toBeNull();
    expect(mocks.localParticipant.setCameraEnabled).not.toHaveBeenCalled();
  });

  it("keeps denied capture controls inactive and explains unsupported screen sharing", async () => {
    mocks.permissionStates.microphone = "denied";
    const getUserMedia = vi.fn().mockRejectedValue(
      new DOMException("Permission denied", "NotAllowedError"),
    );
    Object.assign(navigator.mediaDevices, { getUserMedia });
    Reflect.deleteProperty(navigator.mediaDevices, "getDisplayMedia");
    await joinActiveCall();

    await clickButton("Запросить доступ к микрофону");
    expect(document.querySelector('button[aria-label="Запросить доступ к микрофону"]'))
      .not.toBeNull();
    expect(mocks.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
    expect(container?.textContent).toContain("Нет доступа к камере или микрофону");

    const screen = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Демонстрация экрана недоступна"]',
    );
    expect(screen?.disabled).toBe(false);
    expect(screen?.getAttribute("title")).toBeNull();
    expect(screen?.querySelector('[role="tooltip"]')?.textContent)
      .toBe("Браузер не поддерживает демонстрацию экрана");
    await clickButton("Демонстрация экрана недоступна");
    expect(mocks.localParticipant.setScreenShareEnabled).not.toHaveBeenCalled();
  });

  it("reacts when microphone permission is revoked in browser settings", async () => {
    await joinActiveCall();
    expect(document.querySelector('button[aria-label="Включить микрофон"]')).not.toBeNull();

    mocks.permissionStates.microphone = "denied";
    await act(async () => {
      mocks.permissionChangeHandlers.microphone?.(new Event("change"));
      await Promise.resolve();
    });

    const microphone = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Запросить доступ к микрофону"]',
    );
    expect(microphone?.classList.contains("is-access-inactive")).toBe(true);
    expect(microphone?.querySelector('[role="tooltip"]')?.textContent)
      .toBe("Браузер не дал доступ к микрофону");
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

    expect(document.querySelector('button[aria-label="Разрешить доступ и обновить устройства"]'))
      .toBeNull();
  });

  it("keeps the device list current without a manual refresh action", async () => {
    await joinActiveCall();
    const addEventListener = vi.mocked(navigator.mediaDevices.addEventListener);
    const deviceChange = addEventListener.mock.calls
      .find(([type]) => type === "devicechange")?.[1] as EventListener | undefined;
    expect(deviceChange).toBeDefined();

    await act(async () => {
      deviceChange?.(new Event("devicechange"));
      await Promise.resolve();
    });

    expect(Room.getLocalDevices).toHaveBeenCalledTimes(2);
    expect(Room.getLocalDevices).toHaveBeenLastCalledWith(undefined, false);
    expect(document.querySelector(".call-device-refresh")).toBeNull();
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
    await clickDeviceOption("Наушники или динамики", "Headphones");
    expect(mocks.room.switchActiveDevice).toHaveBeenCalledWith("audiooutput", "speaker-two", true);
  });

  it("uses browser-default output when speaker selection is unsupported", async () => {
    await joinActiveCall();
    const options = mocks.liveKitRoomProps?.options as Record<string, unknown>;
    expect(options).not.toHaveProperty("audioOutput");

    await clickButton("Открыть настройки звонка");
    expect(document.querySelector('[role="dialog"][aria-modal="true"]')?.textContent)
      .toContain("Настройки звонка");
    const speakers = document.querySelector<HTMLSelectElement>('select[aria-label="Наушники или динамики"]');
    expect(speakers?.disabled).toBe(true);
    expect(speakers?.textContent).toContain("Не поддерживается");
  });

  it("organizes settings by media type and applies screen-share quality", async () => {
    await joinActiveCall();
    await clickButton("Открыть настройки звонка");

    const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
    expect(dialog?.textContent).toContain("Звук");
    expect(dialog?.textContent).toContain("Камера");
    expect(dialog?.textContent).toContain("Демонстрация экрана");
    expect(dialog?.textContent).toContain("Порог активации голоса");
    expect(dialog?.textContent).toContain("Проверить микрофон и звук");

    await selectOption("Разрешение демонстрации", "720p");
    await selectOption("Частота кадров демонстрации", "15");
    await changeRange("Порог активации голоса", "-44");

    expect(JSON.parse(window.localStorage.getItem("eduri-call-devices-v1") ?? "null"))
      .toMatchObject({
        screenResolution: "720p",
        screenFrameRate: 15,
        voiceActivationThreshold: -44,
      });

    await clickButton("Начать демонстрацию");
    expect(mocks.localParticipant.setScreenShareEnabled).toHaveBeenCalledWith(true, {
      audio: true,
      video: true,
      contentHint: "detail",
      resolution: { width: 1280, height: 720, frameRate: 15 },
      selfBrowserSurface: "include",
      surfaceSwitching: "include",
      systemAudio: "include",
      preferCurrentTab: false,
    }, {
      screenShareEncoding: {
        maxBitrate: 1_500_000,
        maxFramerate: 15,
        priority: "medium",
      },
    });
  });

  it("loops a microphone test through the selected output and stops its capture", async () => {
    setAudioOutputSupport(true);
    const stopTrack = vi.fn();
    const getUserMedia = vi.fn().mockResolvedValue({
      getTracks: () => [{ stop: stopTrack }],
    });
    Object.assign(navigator.mediaDevices, { getUserMedia });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    window.localStorage.setItem("eduri-call-devices-v1", JSON.stringify({
      version: 1,
      audioInput: "test-mic",
      audioOutput: "test-headphones",
      videoInput: "default",
      videoInputSelected: false,
    }));
    await joinActiveCall();
    await clickButton("Открыть настройки звонка");
    await clickButtonWithText("Проверить микрофон и звук");

    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        deviceId: { exact: "test-mic" },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    });
    expect(HTMLMediaElement.prototype.setSinkId).toHaveBeenCalledWith("test-headphones");
    expect(document.querySelectorAll(".call-microphone-test__visualizer span")).toHaveLength(12);

    await clickButtonWithText("Остановить проверку");
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it("installs a voice-activation processor when the microphone starts", async () => {
    const setProcessor = vi.fn().mockResolvedValue(undefined);
    const localTrack = Object.assign(Object.create(LocalAudioTrack.prototype), {
      getProcessor: vi.fn(() => undefined),
      setProcessor,
    }) as LocalAudioTrack;
    mocks.localParticipant.getTrackPublication.mockReturnValue({
      track: localTrack,
      isMuted: false,
    });
    await joinActiveCall();

    await clickButton("Включить микрофон");

    expect(setProcessor).toHaveBeenCalledOnce();
    expect(setProcessor.mock.calls[0]?.[0]).toMatchObject({
      name: "eduri-voice-activation",
    });
  });

  it("marks any transmitted microphone audio around the participant avatar", async () => {
    const local = callParticipant("local-user", "Call user", true);
    local.getTrackPublication.mockReturnValue({
      track: { kind: Track.Kind.Audio },
      isMuted: false,
    });
    mocks.trackVolume = 0.01;
    mocks.participants = [local];
    mocks.visualTracks = [visualTrack(local, Track.Source.Camera)];
    await joinActiveCall();

    expect(container?.querySelector(".call-track-tile.is-transmitting-audio")).not.toBeNull();
    expect(container?.querySelector(".call-participant-idle > span")).not.toBeNull();
  });

  it("reveals connection quality and WebRTC metrics from the tile indicator", async () => {
    const local = callParticipant("local-user", "Call user", true);
    mocks.participants = [local];
    mocks.visualTracks = [visualTrack(local, Track.Source.Camera)];
    await joinActiveCall();

    const trigger = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="Качество соединения: Отличное"]',
    );
    expect(trigger).not.toBeNull();
    await act(async () => {
      trigger?.focus();
      await Promise.resolve();
    });

    const popover = container?.querySelector(".call-connection__popover");
    expect(popover?.textContent).toContain("Задержка");
    expect(popover?.textContent).toContain("Джиттер");
    expect(popover?.textContent).toContain("Потери");
    expect(popover?.textContent).toContain("Медиапоток");
  });

  it("adjusts a remote participant from the context menu up to 400 percent", async () => {
    const tutor = callParticipant("tutor", "Tutor");
    mocks.participants = [mocks.localParticipant, tutor];
    mocks.visualTracks = [visualTrack(tutor, Track.Source.Camera)];
    await joinActiveCall();

    const tile = container?.querySelector<HTMLElement>('[data-participant-identity="tutor"]');
    await act(async () => {
      tile?.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        clientX: 120,
        clientY: 80,
      }));
      await Promise.resolve();
    });

    expect(document.querySelector('[role="dialog"][aria-label="Громкость участника Tutor"]'))
      .not.toBeNull();
    expect(document.querySelector(".call-participant-menu header")).toBeNull();
    const textbox = document.querySelector<HTMLInputElement>(
      'input[aria-label="Громкость участника Tutor"]',
    );
    expect(textbox?.value).toBe("100");

    await act(async () => {
      if (textbox) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")
          ?.set?.call(textbox, "300");
        textbox.dispatchEvent(new Event("input", { bubbles: true }));
        textbox.dispatchEvent(new Event("change", { bubbles: true }));
      }
      await Promise.resolve();
    });

    expect(tutor.setVolume).toHaveBeenCalledWith(3, Track.Source.Microphone);
    expect(tutor.setVolume).toHaveBeenCalledWith(3, Track.Source.ScreenShareAudio);
    const slider = document.querySelector<HTMLInputElement>(
      'input[aria-label="Громкость участника Tutor: слайдер"]',
    );
    expect(slider?.value).toBe("200");
    expect(slider?.style.getPropertyValue("--call-volume-boost")).toBe("50%");

    await act(async () => {
      textbox?.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1 }));
      await Promise.resolve();
    });
    expect(textbox?.value).toBe("301");

    await act(async () => {
      slider?.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 1 }));
      await Promise.resolve();
    });
    expect(textbox?.value).toBe("300");

    await act(async () => {
      if (textbox) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")
          ?.set?.call(textbox, "999");
        textbox.dispatchEvent(new Event("input", { bubbles: true }));
        textbox.dispatchEvent(new Event("change", { bubbles: true }));
      }
      await Promise.resolve();
    });
    expect(textbox?.value).toBe("400");
    expect(slider?.style.getPropertyValue("--call-volume-boost")).toBe("100%");
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
      resolution: { width: 1920, height: 1080, frameRate: 30 },
      selfBrowserSurface: "include",
      surfaceSwitching: "include",
      systemAudio: "include",
      preferCurrentTab: false,
    }, {
      screenShareEncoding: {
        maxBitrate: 5_000_000,
        maxFramerate: 30,
        priority: "medium",
      },
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

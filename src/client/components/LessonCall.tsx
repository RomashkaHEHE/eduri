import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  CarouselLayout,
  FocusLayoutContainer,
  GridLayout,
  LiveKitRoom,
  ParticipantTile,
  RoomAudioRenderer,
  StartAudio,
  useConnectionState,
  useLocalParticipant,
  useParticipants,
  useRoomContext,
  useMaybeTrackRefContext,
  useTracks,
  isTrackReference,
  type TrackReferenceOrPlaceholder,
} from "@livekit/components-react";
import {
  AlertTriangle,
  Check,
  ChevronUp,
  CircleCheck,
  CircleX,
  RefreshCw,
  LoaderCircle,
  Maximize2,
  Mic,
  MicOff,
  MonitorUp,
  PhoneOff,
  RotateCcw,
  Settings,
  Video,
  VideoOff,
} from "lucide-react";
import {
  ConnectionError,
  ConnectionState,
  Room,
  Track,
} from "livekit-client";
import type { LessonSummary } from "../../shared/types";
import type { CollaborationProfile } from "../../shared/collaborationProfile";
import { api, type CallCredentials } from "../api";
import { Modal } from "./UI";

interface LessonCallProps {
  lessonId: string;
  status: LessonSummary["status"];
  profile: CollaborationProfile;
}

export interface CallWorkspaceProps {
  requestCredentials: () => Promise<CallCredentials>;
  profile?: CollaborationProfile;
  updateParticipantProfile?: (profile: CollaborationProfile) => Promise<void>;
  autoJoin?: boolean;
  unavailable?: {
    title: string;
    message: string;
    kind?: "completed" | "cancelled";
  };
}

type CallStage = "idle" | "requesting" | "active" | "left" | "disconnected";
type ControlKind = "microphone" | "camera" | "screen";
type SelectableDeviceKind = "audioinput" | "audiooutput" | "videoinput";

interface CallDevicePreferences {
  readonly audioInput: string;
  readonly audioOutput: string;
  readonly videoInput: string;
  readonly videoInputSelected: boolean;
}

const CALL_DEVICE_PREFERENCES_KEY = "eduri-call-devices-v1";
const DEFAULT_DEVICE_PREFERENCES: CallDevicePreferences = Object.freeze({
  audioInput: "default",
  audioOutput: "default",
  videoInput: "default",
  videoInputSelected: false,
});

function collaborationProfileKey(
  profile: CollaborationProfile | undefined,
): string | null {
  return profile ? JSON.stringify([profile.displayName, profile.color]) : null;
}

function validDeviceId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function readDevicePreferences(): CallDevicePreferences {
  if (typeof window === "undefined") return DEFAULT_DEVICE_PREFERENCES;
  try {
    const raw = window.localStorage.getItem(CALL_DEVICE_PREFERENCES_KEY);
    if (!raw || raw.length > 2_048) return DEFAULT_DEVICE_PREFERENCES;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return DEFAULT_DEVICE_PREFERENCES;
    const candidate = parsed as Record<string, unknown>;
    if (candidate.version !== 1) return DEFAULT_DEVICE_PREFERENCES;
    return {
      audioInput: validDeviceId(candidate.audioInput)
        ? candidate.audioInput
        : "default",
      audioOutput: validDeviceId(candidate.audioOutput)
        ? candidate.audioOutput
        : "default",
      videoInput: validDeviceId(candidate.videoInput)
        ? candidate.videoInput
        : "default",
      videoInputSelected: candidate.videoInputSelected === true
        || (validDeviceId(candidate.videoInput) && candidate.videoInput !== "default"),
    };
  } catch {
    return DEFAULT_DEVICE_PREFERENCES;
  }
}

function writeDevicePreferences(preferences: CallDevicePreferences): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CALL_DEVICE_PREFERENCES_KEY, JSON.stringify({
      version: 1,
      ...preferences,
    }));
  } catch {
    // Device preferences are best-effort presentation state.
  }
}

function supportsAudioOutputSelection(): boolean {
  return typeof HTMLMediaElement !== "undefined"
    && typeof HTMLMediaElement.prototype.setSinkId === "function";
}

function errorMessage(reason: unknown) {
  if (reason instanceof DOMException) {
    if (reason.name === "NotAllowedError" || reason.name === "PermissionDeniedError") {
      return "Нет доступа к камере или микрофону. Разрешите доступ в настройках браузера.";
    }
    if (reason.name === "NotFoundError" || reason.name === "DevicesNotFoundError") {
      return "Камера или микрофон не найдены.";
    }
    if (reason.name === "NotReadableError" || reason.name === "TrackStartError") {
      return "Камера или микрофон уже используются другим приложением.";
    }
  }
  return reason instanceof Error ? reason.message : "Не удалось подключиться к звонку.";
}

function mediaDeviceMessage(kind?: MediaDeviceKind) {
  if (kind === "audioinput") return "Микрофон недоступен. Проверьте разрешение браузера и выбранное устройство.";
  if (kind === "audiooutput") return "Не удалось выбрать устройство вывода звука. Этот браузер может не поддерживать переключение динамиков.";
  if (kind === "videoinput") return "Камера недоступна. Проверьте разрешение браузера и выбранное устройство.";
  return "Не удалось включить камеру или микрофон.";
}

function participantLabel(track: TrackReferenceOrPlaceholder | undefined, localIdentity: string) {
  if (!track) return "";
  if (track.participant.identity === localIdentity) return "Вы";
  return track.participant.name || "Участник";
}

function trackReferenceKey(track: TrackReferenceOrPlaceholder): string {
  return isTrackReference(track)
    ? `${track.participant.identity}:${track.source}:${track.publication.trackSid}`
    : `${track.participant.identity}:${track.source}:placeholder`;
}

function isTrackMediaActive(track: TrackReferenceOrPlaceholder): boolean {
  return isTrackReference(track) && !track.publication.isMuted;
}

function participantInitials(name: string): string {
  const initials = name
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
  return initials || "?";
}

function CallTrackTile({
  trackRef: explicitTrackRef,
  focusedTrackKey,
  localIdentity,
  onSelect,
}: {
  trackRef?: TrackReferenceOrPlaceholder;
  focusedTrackKey: string | null;
  localIdentity: string;
  onSelect: (track: TrackReferenceOrPlaceholder) => void;
}) {
  const contextTrackRef = useMaybeTrackRefContext();
  const trackRef = explicitTrackRef ?? contextTrackRef;
  if (!trackRef) return null;

  const key = trackReferenceKey(trackRef);
  const mediaActive = isTrackMediaActive(trackRef);
  const focused = focusedTrackKey === key;
  const screenShare = trackRef.source === Track.Source.ScreenShare;
  const name = participantLabel(trackRef, localIdentity);
  const sourceLabel = screenShare ? "Демонстрация экрана" : mediaActive ? "Камера" : "Без видео";

  const select = () => {
    if (mediaActive) onSelect(trackRef);
  };

  return (
    <div
      className={`call-track-tile ${mediaActive ? "call-track-tile--media" : "call-track-tile--no-media"} ${screenShare ? "call-track-tile--screen" : "call-track-tile--camera"} ${focused ? "is-focused" : ""}`}
      data-call-track-key={key}
      data-participant-identity={trackRef.participant.identity}
      data-track-source={trackRef.source}
      role={mediaActive ? "button" : "group"}
      tabIndex={mediaActive ? 0 : undefined}
      aria-label={`${name}: ${sourceLabel}`}
      aria-pressed={mediaActive ? focused : undefined}
      onClick={select}
      onKeyDown={(event) => {
        if (!mediaActive || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        select();
      }}
    >
      <ParticipantTile trackRef={trackRef} className="call-participant" />
      {!mediaActive && (
        <div className="call-participant-idle" aria-hidden="true">
          <span>{participantInitials(name)}</span>
          <strong>{name}</strong>
          <small>Без видео</small>
        </div>
      )}
      <div className="call-track-label" aria-hidden="true">
        <span>{name}</span>
        {screenShare && <small>Экран</small>}
      </div>
    </div>
  );
}

function CallControl({
  active = false,
  danger = false,
  disabled = false,
  label,
  onClick,
  split = false,
  children,
}: {
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  label: string;
  onClick: () => void;
  split?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`call-control ${split ? "call-control--split" : ""} ${active ? "is-active" : ""} ${danger ? "is-danger" : ""}`}
      aria-label={label}
      title={label}
      aria-pressed={danger ? undefined : active}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function deviceFallbackLabel(kind: SelectableDeviceKind, index: number): string {
  if (kind === "audioinput") return `Микрофон ${index + 1}`;
  if (kind === "audiooutput") return `Наушники ${index + 1}`;
  return `Камера ${index + 1}`;
}

function deviceOptions(
  kind: SelectableDeviceKind,
  devices: readonly MediaDeviceInfo[],
  selected: string,
): readonly { readonly id: string; readonly label: string }[] {
  const seen = new Set<string>();
  const options: { id: string; label: string }[] = [];
  for (const device of devices) {
    if (!validDeviceId(device.deviceId) || seen.has(device.deviceId)) continue;
    seen.add(device.deviceId);
    options.push({
      id: device.deviceId,
      label: device.label.trim() || deviceFallbackLabel(kind, options.length),
    });
  }
  if (!seen.has("default")) {
    options.unshift({ id: "default", label: "По умолчанию" });
    seen.add("default");
  }
  if (validDeviceId(selected) && !seen.has(selected)) {
    options.push({ id: selected, label: "Выбранное устройство недоступно" });
  }
  return options;
}

function useCallDevices(onError: (message: string | null) => void) {
  const [devices, setDevices] = useState<readonly MediaDeviceInfo[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const requestGeneration = useRef(0);

  const refresh = useCallback(async (requestPermissions: boolean) => {
    const generation = ++requestGeneration.current;
    setRefreshing(true);
    try {
      const next = await Room.getLocalDevices(undefined, requestPermissions);
      if (requestGeneration.current === generation) setDevices(next);
    } catch (reason) {
      if (requestPermissions && requestGeneration.current === generation) {
        onError(errorMessage(reason));
      }
    } finally {
      if (requestGeneration.current === generation) setRefreshing(false);
    }
  }, [onError]);

  useEffect(() => {
    void refresh(false);
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.addEventListener) return;
    const handleDeviceChange = () => void refresh(false);
    mediaDevices.addEventListener("devicechange", handleDeviceChange);
    return () => {
      requestGeneration.current += 1;
      mediaDevices.removeEventListener("devicechange", handleDeviceChange);
    };
  }, [refresh]);

  return { devices, refresh, refreshing };
}

interface DeviceRow {
  readonly kind: SelectableDeviceKind;
  readonly label: string;
  readonly selected: string;
  readonly supported: boolean;
}

function callDeviceRows(preferences: CallDevicePreferences): readonly DeviceRow[] {
  return [
    {
      kind: "audioinput",
      label: "Микрофон",
      selected: preferences.audioInput,
      supported: true,
    },
    {
      kind: "audiooutput",
      label: "Наушники",
      selected: preferences.audioOutput,
      supported: supportsAudioOutputSelection(),
    },
    {
      kind: "videoinput",
      label: "Камера",
      selected: preferences.videoInput,
      supported: true,
    },
  ];
}

function DeviceSettingsForm({
  devices,
  preferences,
  disabled,
  refreshing,
  onRefresh,
  onSelect,
}: {
  devices: readonly MediaDeviceInfo[];
  preferences: CallDevicePreferences;
  disabled: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  onSelect: (kind: SelectableDeviceKind, deviceId: string) => void;
}) {
  const rows = callDeviceRows(preferences);

  return (
    <section className="call-settings-form" aria-labelledby="call-settings-devices-title">
      <header>
        <h3 id="call-settings-devices-title">Устройства</h3>
        <button
          type="button"
          className="call-device-refresh"
          aria-label="Разрешить доступ и обновить устройства"
          title="Разрешить доступ и обновить устройства"
          disabled={disabled || refreshing}
          onClick={onRefresh}
        >
          <RefreshCw className={refreshing ? "spin" : undefined} size={17} />
        </button>
      </header>
      <div className="call-settings-form__fields">
        {rows.map((row) => {
          const options = deviceOptions(
            row.kind,
            devices.filter((device) => device.kind === row.kind),
            row.selected,
          );
          return (
            <label key={row.kind}>
              <span>{row.label}</span>
              <select
                aria-label={row.label}
                value={row.supported ? row.selected : "unsupported"}
                disabled={disabled || !row.supported}
                onChange={(event) => onSelect(row.kind, event.target.value)}
              >
                {!row.supported && <option value="unsupported">Не поддерживается</option>}
                {row.supported && options.map((option) => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </select>
            </label>
          );
        })}
      </div>
    </section>
  );
}

function DeviceQuickMenu({
  label,
  kinds,
  devices,
  preferences,
  disabled,
  refreshing,
  onRefresh,
  onSelect,
}: {
  label: string;
  kinds: readonly SelectableDeviceKind[];
  devices: readonly MediaDeviceInfo[];
  preferences: CallDevicePreferences;
  disabled: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  onSelect: (kind: SelectableDeviceKind, deviceId: string) => void;
}) {
  const rows = callDeviceRows(preferences).filter((row) => kinds.includes(row.kind));

  return (
    <div className="call-device-menu" role="dialog" aria-label={label}>
      <header>
        <strong>{label}</strong>
        <button
          type="button"
          className="call-device-refresh"
          aria-label="Разрешить доступ и обновить устройства"
          title="Разрешить доступ и обновить устройства"
          disabled={disabled || refreshing}
          onClick={onRefresh}
        >
          <RefreshCw className={refreshing ? "spin" : undefined} size={15} />
        </button>
      </header>
      {rows.map((row) => {
        if (!row.supported) {
          return (
            <div className="call-device-menu__section" key={row.kind}>
              <span>{row.label}</span>
              <small>Не поддерживается браузером</small>
            </div>
          );
        }
        const options = deviceOptions(
          row.kind,
          devices.filter((device) => device.kind === row.kind),
          row.selected,
        );
        return (
          <div
            className="call-device-menu__section"
            role="radiogroup"
            aria-label={row.label}
            key={row.kind}
          >
            <span>{row.label}</span>
            {options.map((option) => (
              <button
                type="button"
                role="radio"
                aria-checked={option.id === row.selected}
                disabled={disabled}
                key={option.id}
                onClick={() => onSelect(row.kind, option.id)}
              >
                <Check size={14} />
                <span>{option.label}</span>
              </button>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function MediaControl({
  disabled,
  menuOpen,
  menuLabel,
  onMenuClick,
  children,
  menu,
}: {
  disabled: boolean;
  menuOpen: boolean;
  menuLabel: string;
  onMenuClick: () => void;
  children: React.ReactNode;
  menu?: React.ReactNode;
}) {
  return (
    <div className={`call-media-control${menuOpen ? " is-open" : ""}`}>
      <div className="call-control-group">
        {children}
        <button
          type="button"
          className="call-control-menu-trigger"
          aria-label={menuLabel}
          title={menuLabel}
          aria-expanded={menuOpen}
          disabled={disabled}
          onClick={onMenuClick}
        >
          <ChevronUp size={13} />
        </button>
      </div>
      {menuOpen && menu}
    </div>
  );
}

function ActiveCall({
  mediaError,
  onMediaError,
  onLeave,
  devicePreferences,
  onDevicePreferenceChange,
  profile,
  initialProfileKey,
  updateParticipantProfile,
}: {
  mediaError: string | null;
  onMediaError: (message: string | null) => void;
  onLeave: () => void;
  devicePreferences: CallDevicePreferences;
  onDevicePreferenceChange: (kind: SelectableDeviceKind, deviceId: string) => void;
  profile?: CollaborationProfile;
  initialProfileKey: string | null;
  updateParticipantProfile?: (profile: CollaborationProfile) => Promise<void>;
}) {
  const room = useRoomContext();
  const connectionState = useConnectionState();
  const participants = useParticipants();
  const {
    localParticipant,
    isCameraEnabled,
    isMicrophoneEnabled,
    isScreenShareEnabled,
  } = useLocalParticipant();
  const visualTracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  );
  const [busyControl, setBusyControl] = useState<ControlKind | null>(null);
  const [switchingDevice, setSwitchingDevice] = useState<SelectableDeviceKind | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [quickMenu, setQuickMenu] = useState<"audio" | "camera" | "screen" | null>(null);
  const [cameraMenuPurpose, setCameraMenuPurpose] = useState<"configure" | "enable" | null>(null);
  const [focusedTrackKey, setFocusedTrackKey] = useState<string | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const profileUpdateMounted = useRef(true);
  const profileUpdateConnected = useRef(
    connectionState === ConnectionState.Connected,
  );
  const profileUpdateEverConnected = useRef(
    connectionState === ConnectionState.Connected,
  );
  const profileUpdateRunning = useRef(false);
  const appliedProfileKey = useRef(initialProfileKey);
  const desiredProfile = useRef(profile ? {
    profile,
    key: collaborationProfileKey(profile)!,
  } : null);
  const updateProfileRef = useRef(updateParticipantProfile);
  const profileErrorRef = useRef(onMediaError);
  const localIdentity = localParticipant.identity;
  const remoteCount = participants.filter((participant) => participant.identity !== localIdentity).length;
  const { devices, refresh: refreshDevices, refreshing: refreshingDevices } = useCallDevices(onMediaError);

  const flushProfileUpdate = useCallback(async () => {
    if (profileUpdateRunning.current) return;
    profileUpdateRunning.current = true;
    let failedProfileKey: string | null = null;
    try {
      while (
        profileUpdateMounted.current
        && profileUpdateConnected.current
      ) {
        const desired = desiredProfile.current;
        const updateProfile = updateProfileRef.current;
        if (
          !desired
          || !updateProfile
          || desired.key === appliedProfileKey.current
        ) {
          break;
        }
        try {
          await updateProfile(desired.profile);
        } catch (reason) {
          failedProfileKey = desired.key;
          if (profileUpdateMounted.current) {
            profileErrorRef.current(errorMessage(reason));
          }
          break;
        }
        if (profileUpdateMounted.current) {
          appliedProfileKey.current = desired.key;
        }
      }
    } finally {
      profileUpdateRunning.current = false;
      const pending = desiredProfile.current;
      if (
        profileUpdateMounted.current
        && profileUpdateConnected.current
        && pending
        && pending.key !== appliedProfileKey.current
        && pending.key !== failedProfileKey
      ) {
        void flushProfileUpdate();
      }
    }
  }, []);

  useEffect(() => {
    profileUpdateMounted.current = true;
    updateProfileRef.current = updateParticipantProfile;
    profileErrorRef.current = onMediaError;
    desiredProfile.current = profile ? {
      profile,
      key: collaborationProfileKey(profile)!,
    } : null;
    const connected = connectionState === ConnectionState.Connected;
    if (
      connected
      && !profileUpdateConnected.current
      && profileUpdateEverConnected.current
    ) {
      appliedProfileKey.current = null;
    }
    if (connected) profileUpdateEverConnected.current = true;
    profileUpdateConnected.current = connected;
    if (profileUpdateConnected.current) void flushProfileUpdate();
  }, [connectionState, flushProfileUpdate, onMediaError, profile, updateParticipantProfile]);

  useEffect(() => {
    profileUpdateMounted.current = true;
    return () => {
      profileUpdateMounted.current = false;
    };
  }, []);

  const focusedTrack = focusedTrackKey
    ? visualTracks.find((track) => (
        trackReferenceKey(track) === focusedTrackKey && isTrackMediaActive(track)
      ))
    : undefined;
  const carouselTracks = focusedTrack
    ? visualTracks.filter((track) => trackReferenceKey(track) !== focusedTrackKey)
    : [];
  const hasActiveMedia = visualTracks.some(isTrackMediaActive);

  useEffect(() => {
    if (focusedTrackKey && !focusedTrack) setFocusedTrackKey(null);
  }, [focusedTrack, focusedTrackKey]);

  const selectTrack = useCallback((track: TrackReferenceOrPlaceholder) => {
    if (!isTrackMediaActive(track)) return;
    const key = trackReferenceKey(track);
    setFocusedTrackKey((current) => current === key ? null : key);
  }, []);

  useEffect(() => {
    const updateFullscreen = () => setIsFullscreen(document.fullscreenElement === frameRef.current);
    document.addEventListener("fullscreenchange", updateFullscreen);
    return () => document.removeEventListener("fullscreenchange", updateFullscreen);
  }, []);

  useEffect(() => {
    if (!quickMenu) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (
        event.target instanceof Node
        && !controlsRef.current?.contains(event.target)
      ) {
        setQuickMenu(null);
        setCameraMenuPurpose(null);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setQuickMenu(null);
      setCameraMenuPurpose(null);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [quickMenu]);

  const toggleMedia = useCallback(async (kind: ControlKind) => {
    if (
      kind === "camera"
      && !isCameraEnabled
      && !devicePreferences.videoInputSelected
    ) {
      setCameraMenuPurpose("enable");
      setQuickMenu("camera");
      return;
    }
    setBusyControl(kind);
    onMediaError(null);
    try {
      if (kind === "microphone") await localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled);
      if (kind === "camera") await localParticipant.setCameraEnabled(!isCameraEnabled);
      if (kind === "screen") {
        await localParticipant.setScreenShareEnabled(!isScreenShareEnabled, isScreenShareEnabled ? undefined : {
          audio: true,
          video: true,
          contentHint: "detail",
          selfBrowserSurface: "include",
          surfaceSwitching: "include",
          systemAudio: "include",
          preferCurrentTab: false,
        });
      }
    } catch (reason) {
      if (kind === "screen" && reason instanceof DOMException && reason.name === "NotAllowedError") {
        onMediaError("Демонстрация экрана не началась.");
      } else {
        onMediaError(errorMessage(reason));
      }
    } finally {
      setBusyControl(null);
    }
  }, [devicePreferences.videoInputSelected, isCameraEnabled, isMicrophoneEnabled, isScreenShareEnabled, localParticipant, onMediaError]);

  const chooseScreenSource = useCallback(async () => {
    setQuickMenu(null);
    setBusyControl("screen");
    onMediaError(null);
    try {
      if (isScreenShareEnabled) {
        await localParticipant.setScreenShareEnabled(false);
      }
      await localParticipant.setScreenShareEnabled(true, {
        audio: true,
        video: true,
        contentHint: "detail",
        selfBrowserSurface: "include",
        surfaceSwitching: "include",
        systemAudio: "include",
        preferCurrentTab: false,
      });
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "NotAllowedError") {
        onMediaError("Демонстрация экрана не началась.");
      } else {
        onMediaError(errorMessage(reason));
      }
    } finally {
      setBusyControl(null);
    }
  }, [isScreenShareEnabled, localParticipant, onMediaError]);

  const selectDevice = useCallback(async (
    kind: SelectableDeviceKind,
    deviceId: string,
    closeQuickMenu: boolean,
  ) => {
    if (!validDeviceId(deviceId)) return;
    setSwitchingDevice(kind);
    onMediaError(null);
    try {
      const switched = await room.switchActiveDevice(
        kind,
        deviceId,
        deviceId !== "default",
      );
      if (!switched) throw new Error("Device switch was rejected");
      onDevicePreferenceChange(kind, deviceId);
      if (closeQuickMenu) setQuickMenu(null);
      if (kind === "videoinput" && cameraMenuPurpose === "enable") {
        setCameraMenuPurpose(null);
        setBusyControl("camera");
        await localParticipant.setCameraEnabled(true);
      } else if (kind === "videoinput") {
        setCameraMenuPurpose(null);
      }
    } catch {
      onMediaError(mediaDeviceMessage(kind));
    } finally {
      setBusyControl(null);
      setSwitchingDevice(null);
    }
  }, [cameraMenuPurpose, localParticipant, onDevicePreferenceChange, onMediaError, room]);

  const toggleQuickMenu = useCallback((menu: "audio" | "camera" | "screen") => {
    setSettingsOpen(false);
    const nextMenu = quickMenu === menu ? null : menu;
    setQuickMenu(nextMenu);
    setCameraMenuPurpose(nextMenu === "camera" ? "configure" : null);
  }, [quickMenu]);

  const openSettings = useCallback(async () => {
    setQuickMenu(null);
    setCameraMenuPurpose(null);
    if (document.fullscreenElement) await document.exitFullscreen();
    setSettingsOpen(true);
  }, []);

  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await frameRef.current?.requestFullscreen();
    } catch {
      onMediaError("Не удалось развернуть звонок на весь экран.");
    }
  }, [onMediaError]);

  const statusText = connectionState === ConnectionState.Connected
    ? remoteCount > 0 ? `${remoteCount + 1} в звонке` : "Ожидаем участника"
    : connectionState === ConnectionState.Reconnecting
      ? "Восстанавливаем связь"
      : "Подключаемся";
  const controlsDisabled = connectionState !== ConnectionState.Connected;
  const mediaControlsDisabled = controlsDisabled || busyControl !== null || switchingDevice !== null;
  const screenShareSupported = typeof navigator.mediaDevices?.getDisplayMedia === "function";

  return (
    <div ref={frameRef} className="lesson-call lesson-call--active">
      <div className="call-stage">
        {focusedTrack ? (
          <FocusLayoutContainer className="call-focus-layout">
            <CarouselLayout tracks={carouselTracks} className="call-track-carousel">
              <CallTrackTile
                focusedTrackKey={focusedTrackKey}
                localIdentity={localIdentity}
                onSelect={selectTrack}
              />
            </CarouselLayout>
            <CallTrackTile
              trackRef={focusedTrack}
              focusedTrackKey={focusedTrackKey}
              localIdentity={localIdentity}
              onSelect={selectTrack}
            />
          </FocusLayoutContainer>
        ) : (
          <GridLayout
            tracks={visualTracks}
            className={`call-layout-grid ${hasActiveMedia ? "has-active-media" : "is-media-empty"}`}
          >
            <CallTrackTile
              focusedTrackKey={focusedTrackKey}
              localIdentity={localIdentity}
              onSelect={selectTrack}
            />
          </GridLayout>
        )}
        {remoteCount === 0 && connectionState === ConnectionState.Connected && (
          <div className="call-waiting">Ожидаем второго участника</div>
        )}
      </div>

      <div className={`call-status ${connectionState === ConnectionState.Connected ? "is-connected" : "is-connecting"}`}>
        {connectionState === ConnectionState.Connected ? <span className="call-status__dot" /> : <LoaderCircle className="spin" size={13} />}
        <span>{statusText}</span>
      </div>

      {mediaError && (
        <div className="call-alert" role="alert">
          <AlertTriangle size={15} />
          <span>{mediaError}</span>
          <button type="button" aria-label="Закрыть сообщение" onClick={() => onMediaError(null)}>×</button>
        </div>
      )}

      <div ref={controlsRef} className="call-controls" aria-label="Управление звонком">
        <MediaControl
          disabled={mediaControlsDisabled}
          menuOpen={quickMenu === "audio"}
          menuLabel="Выбрать микрофон и наушники"
          onMenuClick={() => toggleQuickMenu("audio")}
          menu={(
            <DeviceQuickMenu
              label="Звук"
              kinds={["audioinput", "audiooutput"]}
              devices={devices}
              preferences={devicePreferences}
              disabled={mediaControlsDisabled}
              refreshing={refreshingDevices}
              onRefresh={() => void refreshDevices(true)}
              onSelect={(kind, deviceId) => void selectDevice(kind, deviceId, true)}
            />
          )}
        >
          <CallControl
            split
            active={isMicrophoneEnabled}
            disabled={mediaControlsDisabled}
            label={isMicrophoneEnabled ? "Выключить микрофон" : "Включить микрофон"}
            onClick={() => void toggleMedia("microphone")}
          >
            {busyControl === "microphone" ? <LoaderCircle className="spin" size={18} /> : isMicrophoneEnabled ? <Mic size={18} /> : <MicOff size={18} />}
          </CallControl>
        </MediaControl>
        <MediaControl
          disabled={mediaControlsDisabled}
          menuOpen={quickMenu === "camera"}
          menuLabel="Выбрать камеру"
          onMenuClick={() => toggleQuickMenu("camera")}
          menu={(
            <DeviceQuickMenu
              label={cameraMenuPurpose === "enable" ? "Выберите камеру" : "Камера"}
              kinds={["videoinput"]}
              devices={devices}
              preferences={devicePreferences}
              disabled={mediaControlsDisabled}
              refreshing={refreshingDevices}
              onRefresh={() => void refreshDevices(true)}
              onSelect={(kind, deviceId) => void selectDevice(kind, deviceId, true)}
            />
          )}
        >
          <CallControl
            split
            active={isCameraEnabled}
            disabled={mediaControlsDisabled}
            label={isCameraEnabled ? "Выключить камеру" : "Включить камеру"}
            onClick={() => void toggleMedia("camera")}
          >
            {busyControl === "camera" ? <LoaderCircle className="spin" size={18} /> : isCameraEnabled ? <Video size={18} /> : <VideoOff size={18} />}
          </CallControl>
        </MediaControl>
        <MediaControl
          disabled={mediaControlsDisabled || !screenShareSupported}
          menuOpen={quickMenu === "screen"}
          menuLabel="Выбрать экран или окно"
          onMenuClick={() => toggleQuickMenu("screen")}
          menu={(
            <div className="call-device-menu call-screen-menu" role="dialog" aria-label="Демонстрация экрана">
              <button
                type="button"
                disabled={mediaControlsDisabled || !screenShareSupported}
                onClick={() => void chooseScreenSource()}
              >
                <MonitorUp size={16} />
                <span>{isScreenShareEnabled ? "Сменить экран или окно" : "Выбрать экран или окно"}</span>
              </button>
            </div>
          )}
        >
          <CallControl
            split
            active={isScreenShareEnabled}
            disabled={mediaControlsDisabled || !screenShareSupported}
            label={screenShareSupported ? (isScreenShareEnabled ? "Остановить демонстрацию" : "Начать демонстрацию") : "Демонстрация экрана недоступна"}
            onClick={() => void toggleMedia("screen")}
          >
            {busyControl === "screen" ? <LoaderCircle className="spin" size={18} /> : <MonitorUp size={18} />}
          </CallControl>
        </MediaControl>
        <CallControl active={isFullscreen} label={isFullscreen ? "Свернуть звонок" : "Развернуть звонок"} onClick={() => void toggleFullscreen()}>
          <Maximize2 size={18} />
        </CallControl>
        <button
          type="button"
          className={`call-control${settingsOpen ? " is-active" : ""}`}
          aria-label="Открыть настройки звонка"
          title="Открыть настройки звонка"
          disabled={mediaControlsDisabled}
          onClick={() => void openSettings()}
        >
          <Settings size={18} />
        </button>
        <CallControl danger label="Покинуть звонок" onClick={() => { void room.disconnect(); onLeave(); }}>
          <PhoneOff size={18} />
        </CallControl>
      </div>
      <StartAudio className="call-start-audio" label="Включить звук" />
      <RoomAudioRenderer />
      <Modal
        open={settingsOpen}
        title="Настройки звонка"
        onClose={() => setSettingsOpen(false)}
        width="medium"
        backdropClassName="call-settings-modal"
      >
        <DeviceSettingsForm
          devices={devices}
          preferences={devicePreferences}
          disabled={mediaControlsDisabled}
          refreshing={refreshingDevices}
          onRefresh={() => void refreshDevices(true)}
          onSelect={(kind, deviceId) => void selectDevice(kind, deviceId, false)}
        />
      </Modal>
    </div>
  );
}

export function CallWorkspace({
  requestCredentials,
  profile,
  updateParticipantProfile,
  autoJoin = false,
  unavailable,
}: CallWorkspaceProps) {
  const [stage, setStage] = useState<CallStage>("idle");
  const [credentials, setCredentials] = useState<CallCredentials | null>(null);
  const [initialProfileKey, setInitialProfileKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [devicePreferences, setDevicePreferences] = useState(readDevicePreferences);
  const intentionalLeave = useRef(false);
  const autoJoinAttempted = useRef(false);

  const join = useCallback(async () => {
    intentionalLeave.current = false;
    setStage("requesting");
    setError(null);
    setMediaError(null);
    const requestedProfileKey = collaborationProfileKey(profile);
    try {
      const result = await requestCredentials();
      setCredentials(result);
      setInitialProfileKey(requestedProfileKey);
      setStage("active");
    } catch (reason) {
      setCredentials(null);
      setInitialProfileKey(null);
      setError(errorMessage(reason));
      setStage("idle");
    }
  }, [profile, requestCredentials]);

  const leave = useCallback(() => {
    intentionalLeave.current = true;
    setCredentials(null);
    setInitialProfileKey(null);
    setMediaError(null);
    setStage("left");
  }, []);

  const handleRoomError = useCallback((reason: Error) => {
    const message = errorMessage(reason);
    if (reason instanceof ConnectionError) {
      setCredentials(null);
      setInitialProfileKey(null);
      setError(message);
      setStage("disconnected");
      return;
    }
    setMediaError(message);
  }, []);

  const changeDevicePreference = useCallback((
    kind: SelectableDeviceKind,
    deviceId: string,
  ) => {
    setDevicePreferences((current) => {
      const next = kind === "audioinput"
        ? { ...current, audioInput: deviceId }
        : kind === "audiooutput"
          ? { ...current, audioOutput: deviceId }
          : { ...current, videoInput: deviceId, videoInputSelected: true };
      writeDevicePreferences(next);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!autoJoin) {
      autoJoinAttempted.current = false;
      return;
    }
    if (
      autoJoinAttempted.current
      || unavailable
      || credentials
      || stage !== "idle"
    ) {
      return;
    }
    autoJoinAttempted.current = true;
    void join();
  }, [autoJoin, credentials, join, stage, unavailable]);

  if (unavailable) {
    const completed = unavailable.kind === "completed";
    return (
      <div className="lesson-call lesson-call--lobby">
        <div className="call-lobby-icon">
          {completed ? <CircleCheck size={24} /> : <CircleX size={24} />}
        </div>
        <strong>{unavailable.title}</strong>
        <span>{unavailable.message}</span>
      </div>
    );
  }

  if (!credentials || stage !== "active") {
    const interrupted = stage === "disconnected";
    const left = stage === "left";
    return (
      <div className="lesson-call lesson-call--lobby">
        <div className={`call-lobby-icon ${interrupted ? "is-error" : ""}`}>
          {interrupted ? <AlertTriangle size={24} /> : <Video size={25} />}
        </div>
        <strong>{interrupted ? "Связь прервалась" : left ? "Вы вышли из звонка" : "Видеозвонок"}</strong>
        <span>{interrupted ? "Подключитесь повторно" : left ? "Можно вернуться в любой момент" : "Камера и микрофон после входа выключены"}</span>
        {error && <div className="call-lobby-error" role="alert">{error}</div>}
        <button type="button" className="call-join-button" disabled={stage === "requesting"} onClick={() => void join()}>
          {stage === "requesting" ? <LoaderCircle className="spin" size={17} /> : left || interrupted ? <RotateCcw size={17} /> : <Video size={17} />}
          {stage === "requesting" ? "Подключаемся" : left || interrupted ? "Подключиться снова" : "Подключиться"}
        </button>
      </div>
    );
  }

  return (
    <LiveKitRoom
      key={`${credentials.roomName}:${credentials.token}`}
      className="call-room"
      token={credentials.token}
      serverUrl={credentials.url}
      connect
      audio={false}
      video={false}
      options={{
        adaptiveStream: true,
        dynacast: true,
        audioCaptureDefaults: { deviceId: devicePreferences.audioInput },
        videoCaptureDefaults: { deviceId: devicePreferences.videoInput },
        ...(supportsAudioOutputSelection()
          ? { audioOutput: { deviceId: devicePreferences.audioOutput } }
          : {}),
      }}
      onError={handleRoomError}
      onMediaDeviceFailure={(_failure, kind) => setMediaError(mediaDeviceMessage(kind))}
      onDisconnected={() => {
        setCredentials(null);
        setInitialProfileKey(null);
        setStage(intentionalLeave.current ? "left" : "disconnected");
      }}
    >
      <ActiveCall
        mediaError={mediaError}
        onMediaError={setMediaError}
        onLeave={leave}
        devicePreferences={devicePreferences}
        onDevicePreferenceChange={changeDevicePreference}
        profile={profile}
        initialProfileKey={initialProfileKey}
        updateParticipantProfile={updateParticipantProfile}
      />
    </LiveKitRoom>
  );
}

export function LessonCall({ lessonId, status, profile }: LessonCallProps) {
  const requestCredentials = useCallback(
    () => api.lessons.callToken(lessonId, profile),
    [lessonId, profile],
  );
  const updateParticipantProfile = useCallback(
    (nextProfile: CollaborationProfile) => (
      api.lessons.updateCallProfile(lessonId, nextProfile)
    ),
    [lessonId],
  );
  const unavailable = status === "completed"
    ? {
        title: "Занятие завершено",
        message: "Звонок больше недоступен",
        kind: "completed" as const,
      }
    : status === "cancelled"
      ? {
          title: "Занятие отменено",
          message: "Подключиться к звонку нельзя",
          kind: "cancelled" as const,
        }
      : undefined;
  return (
    <CallWorkspace
      requestCredentials={requestCredentials}
      profile={profile}
      updateParticipantProfile={updateParticipantProfile}
      unavailable={unavailable}
    />
  );
}

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  LiveKitRoom,
  ParticipantTile,
  RoomAudioRenderer,
  StartAudio,
  useConnectionState,
  useLocalParticipant,
  useParticipants,
  useRoomContext,
  useTracks,
  type TrackReferenceOrPlaceholder,
} from "@livekit/components-react";
import {
  AlertTriangle,
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
}

const CALL_DEVICE_PREFERENCES_KEY = "eduri-call-devices-v1";
const DEFAULT_DEVICE_PREFERENCES: CallDevicePreferences = Object.freeze({
  audioInput: "default",
  audioOutput: "default",
  videoInput: "default",
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

function CallControl({
  active = false,
  danger = false,
  disabled = false,
  label,
  onClick,
  children,
}: {
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`call-control ${active ? "is-active" : ""} ${danger ? "is-danger" : ""}`}
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
  if (kind === "audiooutput") return `Динамики ${index + 1}`;
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

function CallDeviceSettings({
  id,
  room,
  preferences,
  disabled,
  onChange,
  onError,
}: {
  id: string;
  room: Room;
  preferences: CallDevicePreferences;
  disabled: boolean;
  onChange: (kind: SelectableDeviceKind, deviceId: string) => void;
  onError: (message: string | null) => void;
}) {
  const [devices, setDevices] = useState<readonly MediaDeviceInfo[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [switching, setSwitching] = useState<SelectableDeviceKind | null>(null);
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

  const selectDevice = useCallback(async (
    kind: SelectableDeviceKind,
    deviceId: string,
  ) => {
    if (!validDeviceId(deviceId)) return;
    setSwitching(kind);
    onError(null);
    try {
      const switched = await room.switchActiveDevice(
        kind,
        deviceId,
        deviceId !== "default",
      );
      if (!switched) throw new Error("Device switch was rejected");
      onChange(kind, deviceId);
    } catch {
      onError(mediaDeviceMessage(kind));
    } finally {
      setSwitching(null);
    }
  }, [onChange, onError, room]);

  const audioOutputSupported = supportsAudioOutputSelection();
  const rows = [
    {
      kind: "audioinput" as const,
      label: "Микрофон",
      selected: preferences.audioInput,
      supported: true,
    },
    {
      kind: "audiooutput" as const,
      label: "Динамики",
      selected: preferences.audioOutput,
      supported: audioOutputSupported,
    },
    {
      kind: "videoinput" as const,
      label: "Камера",
      selected: preferences.videoInput,
      supported: true,
    },
  ];

  return (
    <div
      id={id}
      className="call-device-settings"
      role="dialog"
      aria-label="Устройства звонка"
    >
      <header>
        <strong>Устройства</strong>
        <button
          type="button"
          className="call-device-settings__refresh"
          aria-label="Разрешить доступ и обновить устройства"
          title="Разрешить доступ и обновить устройства"
          disabled={disabled || refreshing || switching !== null}
          onClick={() => void refresh(true)}
        >
          <RefreshCw className={refreshing ? "spin" : undefined} size={15} />
        </button>
      </header>
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
              disabled={disabled || switching !== null || !row.supported}
              onChange={(event) => void selectDevice(row.kind, event.target.value)}
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
  const cameraTracks = useTracks(
    [{ source: Track.Source.Camera, withPlaceholder: true }],
    { onlySubscribed: false },
  );
  const screenTracks = useTracks([Track.Source.ScreenShare], { onlySubscribed: false });
  const [busyControl, setBusyControl] = useState<ControlKind | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsId = useId();
  const frameRef = useRef<HTMLDivElement>(null);
  const settingsAreaRef = useRef<HTMLDivElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
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

  const { mainTrack, pipTrack, isSharing } = useMemo(() => {
    const remoteScreen = screenTracks.find((track) => track.participant.identity !== localIdentity);
    const screen = remoteScreen ?? screenTracks[0];
    const remoteCamera = cameraTracks.find((track) => track.participant.identity !== localIdentity);
    const localCamera = cameraTracks.find((track) => track.participant.identity === localIdentity);
    return {
      mainTrack: screen ?? remoteCamera ?? localCamera,
      pipTrack: screen ? (remoteCamera ?? localCamera) : remoteCamera && localCamera ? localCamera : undefined,
      isSharing: Boolean(screen),
    };
  }, [cameraTracks, localIdentity, screenTracks]);

  useEffect(() => {
    const updateFullscreen = () => setIsFullscreen(document.fullscreenElement === frameRef.current);
    document.addEventListener("fullscreenchange", updateFullscreen);
    return () => document.removeEventListener("fullscreenchange", updateFullscreen);
  }, []);

  useEffect(() => {
    if (!settingsOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (
        event.target instanceof Node
        && !settingsAreaRef.current?.contains(event.target)
        && !settingsButtonRef.current?.contains(event.target)
      ) {
        setSettingsOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setSettingsOpen(false);
      settingsButtonRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [settingsOpen]);

  const toggleMedia = useCallback(async (kind: ControlKind) => {
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
  }, [isCameraEnabled, isMicrophoneEnabled, isScreenShareEnabled, localParticipant, onMediaError]);

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
  const screenShareSupported = typeof navigator.mediaDevices?.getDisplayMedia === "function";

  return (
    <div ref={frameRef} className={`lesson-call lesson-call--active ${isSharing ? "lesson-call--sharing" : ""}`}>
      <div className="call-stage">
        {mainTrack ? (
          <ParticipantTile trackRef={mainTrack} className="call-participant call-participant--main" />
        ) : (
          <div className="call-video-placeholder"><VideoOff size={27} /><span>Камера выключена</span></div>
        )}
        {mainTrack && <span className="call-participant-label">{participantLabel(mainTrack, localIdentity)}</span>}
        {pipTrack && (
          <div className="call-picture-in-picture">
            <ParticipantTile trackRef={pipTrack} className="call-participant call-participant--pip" />
            <span>{participantLabel(pipTrack, localIdentity)}</span>
          </div>
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

      <div ref={settingsAreaRef} className="call-device-settings-area">
        {settingsOpen && (
          <CallDeviceSettings
            id={settingsId}
            room={room}
            preferences={devicePreferences}
            disabled={controlsDisabled || busyControl !== null}
            onChange={onDevicePreferenceChange}
            onError={onMediaError}
          />
        )}
      </div>

      <div className="call-controls" aria-label="Управление звонком">
        <CallControl
          active={isMicrophoneEnabled}
          disabled={controlsDisabled || busyControl !== null}
          label={isMicrophoneEnabled ? "Выключить микрофон" : "Включить микрофон"}
          onClick={() => void toggleMedia("microphone")}
        >
          {busyControl === "microphone" ? <LoaderCircle className="spin" size={18} /> : isMicrophoneEnabled ? <Mic size={18} /> : <MicOff size={18} />}
        </CallControl>
        <CallControl
          active={isCameraEnabled}
          disabled={controlsDisabled || busyControl !== null}
          label={isCameraEnabled ? "Выключить камеру" : "Включить камеру"}
          onClick={() => void toggleMedia("camera")}
        >
          {busyControl === "camera" ? <LoaderCircle className="spin" size={18} /> : isCameraEnabled ? <Video size={18} /> : <VideoOff size={18} />}
        </CallControl>
        <CallControl
          active={isScreenShareEnabled}
          disabled={controlsDisabled || busyControl !== null || !screenShareSupported}
          label={screenShareSupported ? (isScreenShareEnabled ? "Остановить демонстрацию" : "Выбрать экран") : "Демонстрация экрана недоступна"}
          onClick={() => void toggleMedia("screen")}
        >
          {busyControl === "screen" ? <LoaderCircle className="spin" size={18} /> : <MonitorUp size={18} />}
        </CallControl>
        <CallControl active={isFullscreen} label={isFullscreen ? "Свернуть звонок" : "Развернуть звонок"} onClick={() => void toggleFullscreen()}>
          <Maximize2 size={18} />
        </CallControl>
        <button
          ref={settingsButtonRef}
          type="button"
          className={`call-control${settingsOpen ? " is-active" : ""}`}
          aria-label="Настроить устройства"
          title="Настроить устройства"
          aria-expanded={settingsOpen}
          aria-controls={settingsId}
          disabled={controlsDisabled || busyControl !== null}
          onClick={() => setSettingsOpen((current) => !current)}
        >
          <Settings size={18} />
        </button>
        <CallControl danger label="Покинуть звонок" onClick={() => { void room.disconnect(); onLeave(); }}>
          <PhoneOff size={18} />
        </CallControl>
      </div>
      <StartAudio className="call-start-audio" label="Включить звук" />
      <RoomAudioRenderer />
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
          : { ...current, videoInput: deviceId };
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

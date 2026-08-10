import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  LoaderCircle,
  Maximize2,
  Mic,
  MicOff,
  MonitorUp,
  PhoneOff,
  RotateCcw,
  Video,
  VideoOff,
} from "lucide-react";
import { ConnectionError, ConnectionState, Track } from "livekit-client";
import type { LessonSummary } from "../../shared/types";
import { api, type CallCredentials } from "../api";

interface LessonCallProps {
  lessonId: string;
  status: LessonSummary["status"];
}

export interface CallWorkspaceProps {
  requestCredentials: () => Promise<CallCredentials>;
  autoJoin?: boolean;
  unavailable?: {
    title: string;
    message: string;
    kind?: "completed" | "cancelled";
  };
}

type CallStage = "idle" | "requesting" | "active" | "left" | "disconnected";
type ControlKind = "microphone" | "camera" | "screen";

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

function ActiveCall({
  mediaError,
  onMediaError,
  onLeave,
}: {
  mediaError: string | null;
  onMediaError: (message: string | null) => void;
  onLeave: () => void;
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
  const frameRef = useRef<HTMLDivElement>(null);
  const localIdentity = localParticipant.identity;
  const remoteCount = participants.filter((participant) => participant.identity !== localIdentity).length;

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

  const toggleMedia = useCallback(async (kind: ControlKind) => {
    setBusyControl(kind);
    onMediaError(null);
    try {
      if (kind === "microphone") await localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled);
      if (kind === "camera") await localParticipant.setCameraEnabled(!isCameraEnabled);
      if (kind === "screen") {
        await localParticipant.setScreenShareEnabled(!isScreenShareEnabled, isScreenShareEnabled ? undefined : {
          audio: true,
          contentHint: "detail",
          selfBrowserSurface: "exclude",
          surfaceSwitching: "include",
          systemAudio: "include",
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
          label={screenShareSupported ? (isScreenShareEnabled ? "Остановить демонстрацию" : "Показать экран") : "Демонстрация экрана недоступна"}
          onClick={() => void toggleMedia("screen")}
        >
          {busyControl === "screen" ? <LoaderCircle className="spin" size={18} /> : <MonitorUp size={18} />}
        </CallControl>
        <CallControl active={isFullscreen} label={isFullscreen ? "Свернуть звонок" : "Развернуть звонок"} onClick={() => void toggleFullscreen()}>
          <Maximize2 size={18} />
        </CallControl>
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
  autoJoin = false,
  unavailable,
}: CallWorkspaceProps) {
  const [stage, setStage] = useState<CallStage>("idle");
  const [credentials, setCredentials] = useState<CallCredentials | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const intentionalLeave = useRef(false);
  const autoJoinAttempted = useRef(false);

  const join = useCallback(async () => {
    intentionalLeave.current = false;
    setStage("requesting");
    setError(null);
    setMediaError(null);
    try {
      const result = await requestCredentials();
      setCredentials(result);
      setStage("active");
    } catch (reason) {
      setCredentials(null);
      setError(errorMessage(reason));
      setStage("idle");
    }
  }, [requestCredentials]);

  const leave = useCallback(() => {
    intentionalLeave.current = true;
    setCredentials(null);
    setMediaError(null);
    setStage("left");
  }, []);

  const handleRoomError = useCallback((reason: Error) => {
    const message = errorMessage(reason);
    if (reason instanceof ConnectionError) {
      setCredentials(null);
      setError(message);
      setStage("disconnected");
      return;
    }
    setMediaError(message);
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
        <span>{interrupted ? "Подключитесь повторно" : left ? "Можно вернуться в любой момент" : "Камера и микрофон включатся после входа"}</span>
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
      audio
      video
      options={{ adaptiveStream: true, dynacast: true }}
      onError={handleRoomError}
      onMediaDeviceFailure={(_failure, kind) => setMediaError(mediaDeviceMessage(kind))}
      onDisconnected={() => {
        setCredentials(null);
        setStage(intentionalLeave.current ? "left" : "disconnected");
      }}
    >
      <ActiveCall mediaError={mediaError} onMediaError={setMediaError} onLeave={leave} />
    </LiveKitRoom>
  );
}

export function LessonCall({ lessonId, status }: LessonCallProps) {
  const requestCredentials = useCallback(
    () => api.lessons.callToken(lessonId),
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
      unavailable={unavailable}
    />
  );
}

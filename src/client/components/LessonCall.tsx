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
  useConnectionQualityIndicator,
  useLocalParticipant,
  useParticipants,
  useRoomContext,
  useMaybeTrackRefContext,
  useTrackVolume,
  useTracks,
  isTrackReference,
  type TrackReferenceOrPlaceholder,
} from "@livekit/components-react";
import {
  AlertTriangle,
  AudioLines,
  Check,
  ChevronUp,
  CircleCheck,
  CircleX,
  Gauge,
  Headphones,
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
  Wifi,
} from "lucide-react";
import {
  ConnectionQuality,
  ConnectionError,
  ConnectionState,
  LocalAudioTrack,
  LocalTrack,
  RemoteAudioTrack,
  RemoteTrack,
  Room,
  Track,
  type AudioProcessorOptions,
  type Participant,
  type ScreenShareCaptureOptions,
  type TrackPublishOptions,
  type TrackProcessor,
} from "livekit-client";
import type { LessonSummary } from "../../shared/types";
import type { CollaborationProfile } from "../../shared/collaborationProfile";
import type { CallLobbyParticipant } from "../../shared/call";
import { api, type CallCredentials } from "../api";
import { Modal } from "./UI";

interface LessonCallProps {
  lessonId: string;
  status: LessonSummary["status"];
  profile: CollaborationProfile;
}

export interface CallWorkspaceProps {
  requestCredentials: () => Promise<CallCredentials>;
  requestParticipants?: () => Promise<CallLobbyParticipant[]>;
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
type ScreenResolution = "720p" | "1080p";
type ScreenFrameRate = 15 | 30;
type CapturePermissionKind = "microphone" | "camera";
type CapturePermissionState = PermissionState | "checking" | "unsupported" | "unavailable";

interface CallDevicePreferences {
  readonly audioInput: string;
  readonly audioOutput: string;
  readonly videoInput: string;
  readonly videoInputSelected: boolean;
  readonly voiceActivationThreshold: number;
  readonly screenResolution: ScreenResolution;
  readonly screenFrameRate: ScreenFrameRate;
}

const CALL_DEVICE_PREFERENCES_KEY = "eduri-call-devices-v1";
const DEFAULT_DEVICE_PREFERENCES: CallDevicePreferences = Object.freeze({
  audioInput: "default",
  audioOutput: "default",
  videoInput: "default",
  videoInputSelected: false,
  voiceActivationThreshold: -50,
  screenResolution: "1080p",
  screenFrameRate: 30,
});

const VOICE_THRESHOLD_MIN = -80;
const VOICE_THRESHOLD_MAX = -20;
const PARTICIPANT_VOLUME_DEFAULT = 100;
const PARTICIPANT_VOLUME_SLIDER_MAX = 200;
const PARTICIPANT_VOLUME_MAX = 400;

function validParticipantVolume(value: number): number {
  if (!Number.isFinite(value)) return PARTICIPANT_VOLUME_DEFAULT;
  return Math.min(PARTICIPANT_VOLUME_MAX, Math.max(0, Math.round(value)));
}

function capturePermissionLabel(kind: CapturePermissionKind): string {
  return kind === "microphone" ? "микрофону" : "камере";
}

function capturePermissionTooltip(
  kind: CapturePermissionKind,
  state: CapturePermissionState,
): string | undefined {
  if (state === "granted") return undefined;
  const label = capturePermissionLabel(kind);
  if (state === "checking") return `Проверяем доступ к ${label}`;
  if (state === "unsupported") return `Браузер не поддерживает доступ к ${label}`;
  if (state === "unavailable") {
    return kind === "microphone" ? "Микрофон не найден" : "Камера не найдена";
  }
  return `Браузер не дал доступ к ${label}`;
}

function permissionStateAfterFailure(reason: unknown): CapturePermissionState {
  if (reason instanceof DOMException) {
    if (reason.name === "NotFoundError" || reason.name === "DevicesNotFoundError") {
      return "unavailable";
    }
    if (reason.name === "NotSupportedError") return "unsupported";
    if (reason.name === "NotAllowedError" || reason.name === "PermissionDeniedError") {
      return "denied";
    }
  }
  return "prompt";
}

function validVoiceThreshold(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(VOICE_THRESHOLD_MAX, Math.max(VOICE_THRESHOLD_MIN, Math.round(value)))
    : DEFAULT_DEVICE_PREFERENCES.voiceActivationThreshold;
}

function validScreenResolution(value: unknown): ScreenResolution {
  return value === "720p" || value === "1080p"
    ? value
    : DEFAULT_DEVICE_PREFERENCES.screenResolution;
}

function validScreenFrameRate(value: unknown): ScreenFrameRate {
  return value === 15 || value === 30
    ? value
    : DEFAULT_DEVICE_PREFERENCES.screenFrameRate;
}

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
      voiceActivationThreshold: validVoiceThreshold(candidate.voiceActivationThreshold),
      screenResolution: validScreenResolution(candidate.screenResolution),
      screenFrameRate: validScreenFrameRate(candidate.screenFrameRate),
    };
  } catch {
    return DEFAULT_DEVICE_PREFERENCES;
  }
}

function screenShareCaptureOptions(preferences: CallDevicePreferences): ScreenShareCaptureOptions {
  const resolution = preferences.screenResolution === "720p"
    ? { width: 1280, height: 720, frameRate: preferences.screenFrameRate }
    : { width: 1920, height: 1080, frameRate: preferences.screenFrameRate };
  return {
    audio: true,
    video: true,
    contentHint: "detail" as const,
    resolution,
    selfBrowserSurface: "include" as const,
    surfaceSwitching: "include" as const,
    systemAudio: "include" as const,
    preferCurrentTab: false,
  };
}

function screenSharePublishOptions(preferences: CallDevicePreferences): TrackPublishOptions {
  const highResolution = preferences.screenResolution === "1080p";
  return {
    screenShareEncoding: {
      maxBitrate: highResolution
        ? preferences.screenFrameRate === 30 ? 5_000_000 : 2_500_000
        : preferences.screenFrameRate === 30 ? 2_000_000 : 1_500_000,
      maxFramerate: preferences.screenFrameRate,
      priority: "medium" as const,
    },
  };
}

class VoiceActivationProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  readonly name = "eduri-voice-activation";
  processedTrack?: MediaStreamTrack;

  private thresholdDb: number;
  private context?: AudioContext;
  private source?: MediaStreamAudioSourceNode;
  private gate?: ScriptProcessorNode;
  private destination?: MediaStreamAudioDestinationNode;

  constructor(thresholdDb: number) {
    this.thresholdDb = validVoiceThreshold(thresholdDb);
  }

  setThreshold(thresholdDb: number): void {
    this.thresholdDb = validVoiceThreshold(thresholdDb);
  }

  async init(options: AudioProcessorOptions): Promise<void> {
    this.context = options.audioContext;
    this.connect(options.track);
  }

  async restart(options: AudioProcessorOptions): Promise<void> {
    this.disconnect(true);
    if (options.audioContext) this.context = options.audioContext;
    if (!this.context) throw new Error("Audio context is unavailable");
    this.connect(options.track);
  }

  async destroy(): Promise<void> {
    this.disconnect(true);
  }

  private connect(track: MediaStreamTrack): void {
    const context = this.context;
    if (!context) throw new Error("Audio context is unavailable");
    const source = context.createMediaStreamSource(new MediaStream([track]));
    const gate = context.createScriptProcessor(1024, 1, 1);
    const destination = context.createMediaStreamDestination();
    let releaseFrames = 0;

    gate.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const output = event.outputBuffer.getChannelData(0);
      let peak = 0;
      for (let index = 0; index < input.length; index += 1) {
        peak = Math.max(peak, Math.abs(input[index]));
      }
      const threshold = 10 ** (this.thresholdDb / 20);
      if (peak >= threshold) releaseFrames = Math.ceil(context.sampleRate * 0.16);
      const open = releaseFrames > 0;
      if (open) releaseFrames = Math.max(0, releaseFrames - input.length);
      if (open) output.set(input);
      else output.fill(0);
    };

    source.connect(gate);
    gate.connect(destination);
    this.source = source;
    this.gate = gate;
    this.destination = destination;
    this.processedTrack = destination.stream.getAudioTracks()[0];
  }

  private disconnect(stopOutput: boolean): void {
    this.source?.disconnect();
    this.gate?.disconnect();
    if (this.gate) this.gate.onaudioprocess = null;
    if (stopOutput) this.processedTrack?.stop();
    this.source = undefined;
    this.gate = undefined;
    this.destination = undefined;
    this.processedTrack = undefined;
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

interface ParticipantNetworkMetrics {
  readonly roundTripMs: number | null;
  readonly jitterMs: number | null;
  readonly packetLossPercent: number | null;
  readonly bitrateKbps: number | null;
}

const EMPTY_NETWORK_METRICS: ParticipantNetworkMetrics = Object.freeze({
  roundTripMs: null,
  jitterMs: null,
  packetLossPercent: null,
  bitrateKbps: null,
});

async function participantNetworkMetrics(participant: Participant): Promise<ParticipantNetworkMetrics> {
  let roundTripSeconds: number | null = null;
  let jitterSeconds: number | null = null;
  let packetsLost = 0;
  let packetsTotal = 0;
  let bitrate = 0;
  const reports = await Promise.all(participant.getTrackPublications().map(async (publication) => {
    const track = publication.track;
    if (!(track instanceof LocalTrack) && !(track instanceof RemoteTrack)) return undefined;
    bitrate += track.currentBitrate;
    return track.getRTCStatsReport();
  }));

  for (const report of reports) {
    report?.forEach((stat) => {
      if (
        stat.type === "candidate-pair"
        && (stat.state === "succeeded" || stat.nominated)
        && typeof stat.currentRoundTripTime === "number"
      ) {
        roundTripSeconds = roundTripSeconds === null
          ? stat.currentRoundTripTime
          : Math.min(roundTripSeconds, stat.currentRoundTripTime);
      }
      if (
        (stat.type === "inbound-rtp" || stat.type === "remote-inbound-rtp")
        && typeof stat.jitter === "number"
      ) {
        jitterSeconds = jitterSeconds === null ? stat.jitter : Math.max(jitterSeconds, stat.jitter);
      }
      if (stat.type === "remote-inbound-rtp" && typeof stat.roundTripTime === "number") {
        roundTripSeconds = roundTripSeconds === null
          ? stat.roundTripTime
          : Math.min(roundTripSeconds, stat.roundTripTime);
      }
      if (stat.type === "inbound-rtp") {
        const lost = typeof stat.packetsLost === "number" ? Math.max(0, stat.packetsLost) : 0;
        const received = typeof stat.packetsReceived === "number" ? Math.max(0, stat.packetsReceived) : 0;
        packetsLost += lost;
        packetsTotal += lost + received;
      } else if (stat.type === "remote-inbound-rtp") {
        const lost = typeof stat.packetsLost === "number" ? Math.max(0, stat.packetsLost) : 0;
        const sent = typeof stat.packetsSent === "number" ? Math.max(0, stat.packetsSent) : 0;
        packetsLost += lost;
        packetsTotal += Math.max(sent, lost);
      }
    });
  }

  return {
    roundTripMs: roundTripSeconds === null ? null : roundTripSeconds * 1_000,
    jitterMs: jitterSeconds === null ? null : jitterSeconds * 1_000,
    packetLossPercent: packetsTotal > 0 ? (packetsLost / packetsTotal) * 100 : null,
    bitrateKbps: bitrate > 0 ? bitrate / 1_000 : null,
  };
}

function connectionQualityLabel(quality: ConnectionQuality): string {
  if (quality === ConnectionQuality.Excellent) return "Отличное";
  if (quality === ConnectionQuality.Good) return "Стабильное";
  if (quality === ConnectionQuality.Poor) return "Нестабильное";
  if (quality === ConnectionQuality.Lost) return "Соединение потеряно";
  return "Определяется";
}

function metricValue(value: number | null, unit: string, decimals = 0): string {
  return value === null ? "Нет данных" : `${value.toFixed(decimals)} ${unit}`;
}

function ParticipantConnectionIndicator({ participant }: { participant: Participant }) {
  const { quality } = useConnectionQualityIndicator({ participant });
  const [inspecting, setInspecting] = useState(false);
  const [metrics, setMetrics] = useState<ParticipantNetworkMetrics>(EMPTY_NETWORK_METRICS);

  useEffect(() => {
    if (!inspecting) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const next = await participantNetworkMetrics(participant);
        if (!cancelled) setMetrics(next);
      } catch {
        if (!cancelled) setMetrics(EMPTY_NETWORK_METRICS);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [inspecting, participant]);

  const label = connectionQualityLabel(quality);
  return (
    <div
      className="call-connection"
      data-quality={quality}
      onMouseEnter={() => setInspecting(true)}
      onMouseLeave={() => setInspecting(false)}
      onFocus={() => setInspecting(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setInspecting(false);
      }}
    >
      <button
        type="button"
        className="call-connection__trigger"
        aria-label={`Качество соединения: ${label}`}
        aria-expanded={inspecting}
      >
        <Wifi size={13} />
      </button>
      {inspecting && (
        <div className="call-connection__popover" role="status">
          <strong>{label}</strong>
          <dl>
            <div><dt>Задержка</dt><dd>{metricValue(metrics.roundTripMs, "мс")}</dd></div>
            <div><dt>Джиттер</dt><dd>{metricValue(metrics.jitterMs, "мс")}</dd></div>
            <div><dt>Потери</dt><dd>{metricValue(metrics.packetLossPercent, "%", 1)}</dd></div>
            <div><dt>Медиапоток</dt><dd>{metricValue(metrics.bitrateKbps, "Кбит/с")}</dd></div>
          </dl>
        </div>
      )}
    </div>
  );
}

type AdjustableParticipant = Participant & {
  setVolume(
    volume: number,
    source?: Track.Source.Microphone | Track.Source.ScreenShareAudio,
  ): void;
};

function canAdjustParticipantVolume(participant: Participant): participant is AdjustableParticipant {
  return !participant.isLocal
    && typeof (participant as unknown as { setVolume?: unknown }).setVolume === "function";
}

function ParticipantVolumeMenu({
  participant,
  value,
  position,
  onChange,
  onClose,
}: {
  participant: Participant;
  value: number;
  position: { readonly x: number; readonly y: number };
  onChange: (value: number) => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState(String(value));
  const name = participant.name || "Участник";
  const sliderValue = Math.min(value, PARTICIPANT_VOLUME_SLIDER_MAX);
  const sliderFill = (sliderValue / PARTICIPANT_VOLUME_SLIDER_MAX) * 100;
  const boostFill = value > PARTICIPANT_VOLUME_SLIDER_MAX
    ? ((value - PARTICIPANT_VOLUME_SLIDER_MAX)
      / (PARTICIPANT_VOLUME_MAX - PARTICIPANT_VOLUME_SLIDER_MAX)) * 100
    : 0;

  useEffect(() => setDraft(String(value)), [value]);

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const closeOnKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const close = () => onClose();
    window.addEventListener("pointerdown", closeOutside, true);
    window.addEventListener("keydown", closeOnKey);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    const focusFrame = window.requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLInputElement>('input[type="number"]')
        ?.focus({ preventScroll: true });
    });
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("pointerdown", closeOutside, true);
      window.removeEventListener("keydown", closeOnKey);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [onClose]);

  const change = (next: number) => onChange(validParticipantVolume(next));
  const changeByWheel = (event: React.WheelEvent<HTMLInputElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.deltaY === 0) return;
    change(value + (event.deltaY < 0 ? 1 : -1));
  };
  const commitDraft = () => {
    if (draft.trim() === "") {
      setDraft(String(value));
      return;
    }
    change(Number(draft));
  };

  return (
    <div
      ref={menuRef}
      className="call-participant-menu"
      role="dialog"
      aria-label={`Громкость участника ${name}`}
      style={{ left: position.x, top: position.y }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="call-participant-volume">
        <label htmlFor={`call-participant-volume-${participant.identity}`}>Громкость</label>
        <div className="call-participant-volume__value">
          <input
            id={`call-participant-volume-${participant.identity}`}
            type="number"
            aria-label={`Громкость участника ${name}`}
            min={0}
            max={PARTICIPANT_VOLUME_MAX}
            step={1}
            inputMode="numeric"
            value={draft}
            onChange={(event) => {
              const nextDraft = event.target.value;
              setDraft(nextDraft);
              if (nextDraft.trim() !== "") change(Number(nextDraft));
            }}
            onBlur={commitDraft}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            onWheel={changeByWheel}
          />
          <span>%</span>
        </div>
        <input
          className="call-participant-volume__range"
          type="range"
          aria-label={`Громкость участника ${name}: слайдер`}
          min={0}
          max={PARTICIPANT_VOLUME_SLIDER_MAX}
          step={1}
          value={sliderValue}
          style={{
            "--call-volume-fill": `${sliderFill}%`,
            "--call-volume-boost": `${boostFill}%`,
          } as React.CSSProperties}
          onChange={(event) => change(Number(event.target.value))}
          onWheel={changeByWheel}
        />
      </div>
    </div>
  );
}

function CallTrackTile({
  trackRef: explicitTrackRef,
  focusedTrackKey,
  localIdentity,
  onSelect,
  onOpenParticipantMenu,
}: {
  trackRef?: TrackReferenceOrPlaceholder;
  focusedTrackKey: string | null;
  localIdentity: string;
  onSelect: (track: TrackReferenceOrPlaceholder) => void;
  onOpenParticipantMenu: (
    event: React.MouseEvent<HTMLDivElement>,
    participant: Participant,
  ) => void;
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
  const microphonePublication = trackRef.participant.getTrackPublication?.(Track.Source.Microphone);
  const microphoneTrack = microphonePublication?.track instanceof LocalAudioTrack
    || microphonePublication?.track instanceof RemoteAudioTrack
    ? microphonePublication.track
    : undefined;
  const transmittedVolume = useTrackVolume(microphoneTrack, {
    fftSize: 32,
    smoothingTimeConstant: 0.35,
  });
  const transmittingAudio = !microphonePublication?.isMuted && transmittedVolume > 0;

  const select = () => {
    if (mediaActive) onSelect(trackRef);
  };

  return (
    <div
      className={`call-track-tile ${mediaActive ? "call-track-tile--media" : "call-track-tile--no-media"} ${screenShare ? "call-track-tile--screen" : "call-track-tile--camera"} ${focused ? "is-focused" : ""} ${transmittingAudio ? "is-transmitting-audio" : ""}`}
      data-call-track-key={key}
      data-participant-identity={trackRef.participant.identity}
      data-track-source={trackRef.source}
      role={mediaActive ? "button" : "group"}
      tabIndex={mediaActive ? 0 : undefined}
      aria-label={`${name}: ${sourceLabel}`}
      aria-pressed={mediaActive ? focused : undefined}
      onClick={select}
      onContextMenu={(event) => onOpenParticipantMenu(event, trackRef.participant)}
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
      <ParticipantConnectionIndicator participant={trackRef.participant} />
    </div>
  );
}

function CallControl({
  active = false,
  danger = false,
  disabled = false,
  inactiveReason,
  label,
  onClick,
  children,
}: {
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  inactiveReason?: string;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`call-control ${active ? "is-active" : ""} ${danger ? "is-danger" : ""} ${inactiveReason ? "is-access-inactive" : ""}`}
      aria-label={label}
      title={inactiveReason ? undefined : label}
      aria-pressed={danger ? undefined : active}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
      {inactiveReason && (
        <span className="call-control-tooltip" role="tooltip">{inactiveReason}</span>
      )}
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
  const requestGeneration = useRef(0);

  const refresh = useCallback(async () => {
    const generation = ++requestGeneration.current;
    try {
      const next = await Room.getLocalDevices(undefined, false);
      if (requestGeneration.current === generation) setDevices(next);
    } catch (reason) {
      if (requestGeneration.current === generation) onError(errorMessage(reason));
    }
  }, [onError]);

  useEffect(() => {
    void refresh();
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.addEventListener) return;
    const handleDeviceChange = () => void refresh();
    mediaDevices.addEventListener("devicechange", handleDeviceChange);
    return () => {
      requestGeneration.current += 1;
      mediaDevices.removeEventListener("devicechange", handleDeviceChange);
    };
  }, [refresh]);

  return { devices, refresh };
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
      label: "Наушники или динамики",
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

function DeviceSelect({
  row,
  devices,
  disabled,
  onSelect,
}: {
  row: DeviceRow;
  devices: readonly MediaDeviceInfo[];
  disabled: boolean;
  onSelect: (kind: SelectableDeviceKind, deviceId: string) => void;
}) {
  const options = deviceOptions(
    row.kind,
    devices.filter((device) => device.kind === row.kind),
    row.selected,
  );

  return (
    <label className="call-settings-field">
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
}

function MicrophoneTest({
  inputDeviceId,
  outputDeviceId,
  disabled,
  onDevicesChanged,
  onError,
}: {
  inputDeviceId: string;
  outputDeviceId: string;
  disabled: boolean;
  onDevicesChanged: () => void;
  onError: (message: string | null) => void;
}) {
  const [active, setActive] = useState(false);
  const [levels, setLevels] = useState<number[]>(() => Array.from({ length: 12 }, () => 0));
  const resources = useRef<{
    stream: MediaStream;
    audio: HTMLAudioElement;
    context?: AudioContext;
    animationFrame?: number;
  } | null>(null);

  const stop = useCallback(() => {
    const current = resources.current;
    resources.current = null;
    if (current?.animationFrame !== undefined) cancelAnimationFrame(current.animationFrame);
    current?.stream.getTracks().forEach((track) => track.stop());
    if (current) {
      current.audio.pause();
      current.audio.srcObject = null;
      void current.context?.close();
    }
    setLevels(Array.from({ length: 12 }, () => 0));
    setActive(false);
  }, []);

  useEffect(() => stop, [stop]);

  useEffect(() => {
    const audio = resources.current?.audio;
    if (!audio || !supportsAudioOutputSelection()) return;
    void audio.setSinkId(outputDeviceId).catch(() => {
      onError(mediaDeviceMessage("audiooutput"));
    });
  }, [onError, outputDeviceId]);

  const start = useCallback(async () => {
    onError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: inputDeviceId === "default" ? undefined : { exact: inputDeviceId },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        video: false,
      });
      const audio = new Audio();
      audio.autoplay = true;
      audio.srcObject = stream;
      if (supportsAudioOutputSelection()) await audio.setSinkId(outputDeviceId);
      await audio.play();

      const context = typeof AudioContext === "undefined" ? undefined : new AudioContext();
      resources.current = { stream, audio, context };
      if (context) {
        const analyser = context.createAnalyser();
        analyser.fftSize = 64;
        analyser.smoothingTimeConstant = 0.65;
        context.createMediaStreamSource(stream).connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);
        const update = () => {
          analyser.getByteFrequencyData(data);
          const next = Array.from({ length: 12 }, (_, index) => {
            const startIndex = Math.floor((index * data.length) / 12);
            const endIndex = Math.max(startIndex + 1, Math.floor(((index + 1) * data.length) / 12));
            let sum = 0;
            for (let cursor = startIndex; cursor < endIndex; cursor += 1) sum += data[cursor];
            return Math.max(0.04, sum / (endIndex - startIndex) / 255);
          });
          setLevels(next);
          if (resources.current) resources.current.animationFrame = requestAnimationFrame(update);
        };
        resources.current.animationFrame = requestAnimationFrame(update);
      }
      setActive(true);
      onDevicesChanged();
    } catch (reason) {
      stop();
      onError(errorMessage(reason));
    }
  }, [inputDeviceId, onDevicesChanged, onError, outputDeviceId, stop]);

  return (
    <div className={`call-microphone-test${active ? " is-active" : ""}`}>
      <div className="call-microphone-test__visualizer" aria-label="Уровень микрофона">
        {levels.map((level, index) => (
          <span key={index} style={{ "--call-audio-level": level } as React.CSSProperties} />
        ))}
      </div>
      <button
        type="button"
        className="call-settings-action"
        disabled={disabled}
        onClick={() => active ? stop() : void start()}
      >
        {active ? <CircleX size={16} /> : <Headphones size={16} />}
        <span>{active ? "Остановить проверку" : "Проверить микрофон и звук"}</span>
      </button>
    </div>
  );
}

function CallSettings({
  devices,
  preferences,
  disabled,
  onRefreshDevices,
  onSelectDevice,
  onPreferencesChange,
  onError,
}: {
  devices: readonly MediaDeviceInfo[];
  preferences: CallDevicePreferences;
  disabled: boolean;
  onRefreshDevices: () => void;
  onSelectDevice: (kind: SelectableDeviceKind, deviceId: string) => void;
  onPreferencesChange: (patch: Partial<CallDevicePreferences>) => void;
  onError: (message: string | null) => void;
}) {
  const rows = callDeviceRows(preferences);
  const microphone = rows.find((row) => row.kind === "audioinput")!;
  const output = rows.find((row) => row.kind === "audiooutput")!;
  const camera = rows.find((row) => row.kind === "videoinput")!;

  return (
    <div className="call-settings">
      <section className="call-settings-section" aria-labelledby="call-settings-audio-title">
        <header>
          <AudioLines size={19} />
          <h3 id="call-settings-audio-title">Звук</h3>
        </header>
        <div className="call-settings-grid">
          <DeviceSelect row={microphone} devices={devices} disabled={disabled} onSelect={onSelectDevice} />
          <DeviceSelect row={output} devices={devices} disabled={disabled} onSelect={onSelectDevice} />
        </div>
        <MicrophoneTest
          inputDeviceId={preferences.audioInput}
          outputDeviceId={preferences.audioOutput}
          disabled={disabled}
          onDevicesChanged={onRefreshDevices}
          onError={onError}
        />
        <label className="call-settings-range">
          <span>Порог активации голоса</span>
          <output>{preferences.voiceActivationThreshold} дБ</output>
          <input
            type="range"
            aria-label="Порог активации голоса"
            min={VOICE_THRESHOLD_MIN}
            max={VOICE_THRESHOLD_MAX}
            step={1}
            value={preferences.voiceActivationThreshold}
            disabled={disabled}
            onChange={(event) => onPreferencesChange({
              voiceActivationThreshold: validVoiceThreshold(Number(event.target.value)),
            })}
          />
        </label>
      </section>

      <section className="call-settings-section" aria-labelledby="call-settings-camera-title">
        <header>
          <Video size={19} />
          <h3 id="call-settings-camera-title">Камера</h3>
        </header>
        <DeviceSelect row={camera} devices={devices} disabled={disabled} onSelect={onSelectDevice} />
      </section>

      <section className="call-settings-section" aria-labelledby="call-settings-screen-title">
        <header>
          <MonitorUp size={19} />
          <h3 id="call-settings-screen-title">Демонстрация экрана</h3>
        </header>
        <div className="call-settings-grid">
          <label className="call-settings-field">
            <span>Разрешение</span>
            <select
              aria-label="Разрешение демонстрации"
              value={preferences.screenResolution}
              disabled={disabled}
              onChange={(event) => onPreferencesChange({
                screenResolution: validScreenResolution(event.target.value),
              })}
            >
              <option value="720p">1280 × 720</option>
              <option value="1080p">1920 × 1080</option>
            </select>
          </label>
          <label className="call-settings-field">
            <span>Частота кадров</span>
            <select
              aria-label="Частота кадров демонстрации"
              value={preferences.screenFrameRate}
              disabled={disabled}
              onChange={(event) => onPreferencesChange({
                screenFrameRate: validScreenFrameRate(Number(event.target.value)),
              })}
            >
              <option value={15}>15 FPS</option>
              <option value={30}>30 FPS</option>
            </select>
          </label>
        </div>
      </section>
    </div>
  );
}

function DeviceQuickMenu({
  label,
  kinds,
  devices,
  preferences,
  disabled,
  onSelect,
}: {
  label: string;
  kinds: readonly SelectableDeviceKind[];
  devices: readonly MediaDeviceInfo[];
  preferences: CallDevicePreferences;
  disabled: boolean;
  onSelect: (kind: SelectableDeviceKind, deviceId: string) => void;
}) {
  const rows = callDeviceRows(preferences).filter((row) => kinds.includes(row.kind));

  return (
    <div className="call-device-menu" role="dialog" aria-label={label}>
      <header>
        <strong>{label}</strong>
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
        <ChevronUp size={12} />
      </button>
      {menuOpen && menu}
    </div>
  );
}

function ActiveCall({
  mediaError,
  onMediaError,
  onLeave,
  devicePreferences,
  onPreferencesChange,
  profile,
  initialProfileKey,
  updateParticipantProfile,
}: {
  mediaError: string | null;
  onMediaError: (message: string | null) => void;
  onLeave: () => void;
  devicePreferences: CallDevicePreferences;
  onPreferencesChange: (patch: Partial<CallDevicePreferences>) => void;
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
  const [participantVolumes, setParticipantVolumes] = useState<Record<string, number>>({});
  const [capturePermissions, setCapturePermissions] = useState<Record<
    CapturePermissionKind,
    CapturePermissionState
  >>({ microphone: "checking", camera: "checking" });
  const [participantMenu, setParticipantMenu] = useState<{
    readonly participantIdentity: string;
    readonly x: number;
    readonly y: number;
  } | null>(null);
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
  const voiceGateRef = useRef<VoiceActivationProcessor | null>(null);
  if (!voiceGateRef.current) {
    voiceGateRef.current = new VoiceActivationProcessor(devicePreferences.voiceActivationThreshold);
  }
  const localIdentity = localParticipant.identity;
  const remoteCount = participants.filter((participant) => participant.identity !== localIdentity).length;
  const menuParticipant = participantMenu
    ? participants.find((participant) => participant.identity === participantMenu.participantIdentity)
    : undefined;
  const { devices, refresh: refreshDevices } = useCallDevices(onMediaError);

  useEffect(() => {
    let cancelled = false;
    const permissionStatuses: Array<{
      readonly status: PermissionStatus;
      readonly update: () => void;
    }> = [];
    const check = async (kind: CapturePermissionKind) => {
      if (!navigator.mediaDevices?.getUserMedia) {
        if (!cancelled) {
          setCapturePermissions((current) => ({ ...current, [kind]: "unsupported" }));
        }
        return;
      }
      if (!navigator.permissions?.query) {
        if (!cancelled) {
          setCapturePermissions((current) => ({ ...current, [kind]: "prompt" }));
        }
        return;
      }
      try {
        const status = await navigator.permissions.query({
          name: kind as PermissionName,
        });
        if (cancelled) return;
        const update = () => {
          if (!cancelled) {
            setCapturePermissions((current) => ({ ...current, [kind]: status.state }));
          }
        };
        permissionStatuses.push({ status, update });
        update();
        status.addEventListener("change", update);
      } catch {
        if (!cancelled) {
          setCapturePermissions((current) => ({ ...current, [kind]: "prompt" }));
        }
      }
    };
    void check("microphone");
    void check("camera");
    return () => {
      cancelled = true;
      for (const { status, update } of permissionStatuses) {
        status.removeEventListener("change", update);
      }
    };
  }, []);

  const changeParticipantVolume = useCallback((participant: Participant, value: number) => {
    if (!canAdjustParticipantVolume(participant)) return;
    const next = validParticipantVolume(value);
    setParticipantVolumes((current) => ({ ...current, [participant.identity]: next }));
    const gain = next / 100;
    participant.setVolume(gain, Track.Source.Microphone);
    participant.setVolume(gain, Track.Source.ScreenShareAudio);
  }, []);
  const closeParticipantMenu = useCallback(() => setParticipantMenu(null), []);

  const openParticipantMenu = useCallback((
    event: React.MouseEvent<HTMLDivElement>,
    participant: Participant,
  ) => {
    if (!canAdjustParticipantVolume(participant)) return;
    event.preventDefault();
    event.stopPropagation();
    const frame = frameRef.current;
    if (!frame) return;
    const frameRect = frame.getBoundingClientRect();
    const menuWidth = Math.min(248, Math.max(0, frame.clientWidth - 16));
    const menuHeight = 132;
    const requestedX = event.clientX - frameRect.left;
    const requestedY = event.clientY - frameRect.top;
    setParticipantMenu({
      participantIdentity: participant.identity,
      x: Math.max(8, Math.min(requestedX, frame.clientWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(requestedY, frame.clientHeight - menuHeight - 8)),
    });
  }, []);

  useEffect(() => {
    if (participantMenu && !menuParticipant) setParticipantMenu(null);
  }, [menuParticipant, participantMenu]);

  useEffect(() => {
    voiceGateRef.current?.setThreshold(devicePreferences.voiceActivationThreshold);
  }, [devicePreferences.voiceActivationThreshold]);

  const ensureVoiceActivation = useCallback(async () => {
    const publication = localParticipant.getTrackPublication?.(Track.Source.Microphone);
    const track = publication?.track;
    const processor = voiceGateRef.current;
    if (!(track instanceof LocalAudioTrack) || !processor) return;
    if (track.getProcessor()?.name === processor.name) return;
    await track.setProcessor(processor);
  }, [localParticipant]);

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
      if (kind === "microphone") {
        const enabling = !isMicrophoneEnabled;
        await localParticipant.setMicrophoneEnabled(enabling);
        if (enabling) await ensureVoiceActivation();
      }
      if (kind === "camera") await localParticipant.setCameraEnabled(!isCameraEnabled);
      if (kind === "screen") {
        await localParticipant.setScreenShareEnabled(
          !isScreenShareEnabled,
          isScreenShareEnabled ? undefined : screenShareCaptureOptions(devicePreferences),
          isScreenShareEnabled ? undefined : screenSharePublishOptions(devicePreferences),
        );
      }
      void refreshDevices();
    } catch (reason) {
      if (kind === "screen" && reason instanceof DOMException && reason.name === "NotAllowedError") {
        onMediaError("Демонстрация экрана не началась.");
      } else {
        onMediaError(errorMessage(reason));
      }
    } finally {
      setBusyControl(null);
    }
  }, [devicePreferences, ensureVoiceActivation, isCameraEnabled, isMicrophoneEnabled, isScreenShareEnabled, localParticipant, onMediaError, refreshDevices]);

  const requestCapturePermission = useCallback(async (kind: CapturePermissionKind) => {
    setBusyControl(kind);
    onMediaError(null);
    try {
      const mediaDevices = navigator.mediaDevices;
      if (!mediaDevices?.getUserMedia) {
        throw new DOMException("Media capture is unavailable", "NotSupportedError");
      }
      const stream = await mediaDevices.getUserMedia({
        audio: kind === "microphone",
        video: kind === "camera",
      });
      const matchingTracks = kind === "microphone"
        ? stream.getAudioTracks()
        : stream.getVideoTracks();
      if (matchingTracks.length === 0) {
        stream.getTracks().forEach((track) => track.stop());
        throw new DOMException("Requested device is unavailable", "NotFoundError");
      }
      stream.getTracks().forEach((track) => track.stop());
      setCapturePermissions((current) => ({ ...current, [kind]: "granted" }));
      await refreshDevices();
    } catch (reason) {
      setCapturePermissions((current) => ({
        ...current,
        [kind]: permissionStateAfterFailure(reason),
      }));
      onMediaError(errorMessage(reason));
    } finally {
      setBusyControl(null);
    }
  }, [onMediaError, refreshDevices]);

  const chooseScreenSource = useCallback(async () => {
    setQuickMenu(null);
    setBusyControl("screen");
    onMediaError(null);
    try {
      if (isScreenShareEnabled) {
        await localParticipant.setScreenShareEnabled(false);
      }
      await localParticipant.setScreenShareEnabled(
        true,
        screenShareCaptureOptions(devicePreferences),
        screenSharePublishOptions(devicePreferences),
      );
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "NotAllowedError") {
        onMediaError("Демонстрация экрана не началась.");
      } else {
        onMediaError(errorMessage(reason));
      }
    } finally {
      setBusyControl(null);
    }
  }, [devicePreferences, isScreenShareEnabled, localParticipant, onMediaError]);

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
      onPreferencesChange(kind === "audioinput"
        ? { audioInput: deviceId }
        : kind === "audiooutput"
          ? { audioOutput: deviceId }
          : { videoInput: deviceId, videoInputSelected: true });
      void refreshDevices();
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
  }, [cameraMenuPurpose, localParticipant, onMediaError, onPreferencesChange, refreshDevices, room]);

  const toggleQuickMenu = useCallback((menu: "audio" | "camera" | "screen") => {
    setSettingsOpen(false);
    const nextMenu = quickMenu === menu ? null : menu;
    setQuickMenu(nextMenu);
    setCameraMenuPurpose(nextMenu === "camera" ? "configure" : null);
    if (nextMenu) void refreshDevices();
  }, [quickMenu, refreshDevices]);

  const openSettings = useCallback(async () => {
    setQuickMenu(null);
    setCameraMenuPurpose(null);
    if (document.fullscreenElement) await document.exitFullscreen();
    void refreshDevices();
    setSettingsOpen(true);
  }, [refreshDevices]);

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
  const microphonePermissionGranted = capturePermissions.microphone === "granted";
  const cameraPermissionGranted = capturePermissions.camera === "granted";
  const microphoneInactiveReason = capturePermissionTooltip(
    "microphone",
    capturePermissions.microphone,
  );
  const cameraInactiveReason = capturePermissionTooltip("camera", capturePermissions.camera);

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
                onOpenParticipantMenu={openParticipantMenu}
              />
            </CarouselLayout>
            <CallTrackTile
              trackRef={focusedTrack}
              focusedTrackKey={focusedTrackKey}
              localIdentity={localIdentity}
              onSelect={selectTrack}
              onOpenParticipantMenu={openParticipantMenu}
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
              onOpenParticipantMenu={openParticipantMenu}
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

      {participantMenu && menuParticipant && (
        <ParticipantVolumeMenu
          participant={menuParticipant}
          value={participantVolumes[menuParticipant.identity] ?? PARTICIPANT_VOLUME_DEFAULT}
          position={{ x: participantMenu.x, y: participantMenu.y }}
          onChange={(value) => changeParticipantVolume(menuParticipant, value)}
          onClose={closeParticipantMenu}
        />
      )}

      <div ref={controlsRef} className="call-controls" aria-label="Управление звонком">
        <MediaControl
          disabled={mediaControlsDisabled || !microphonePermissionGranted}
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
              onSelect={(kind, deviceId) => void selectDevice(kind, deviceId, true)}
            />
          )}
        >
          <CallControl
            active={microphonePermissionGranted && isMicrophoneEnabled}
            disabled={mediaControlsDisabled}
            inactiveReason={microphoneInactiveReason}
            label={microphonePermissionGranted
              ? isMicrophoneEnabled ? "Выключить микрофон" : "Включить микрофон"
              : "Запросить доступ к микрофону"}
            onClick={() => void (microphonePermissionGranted
              ? toggleMedia("microphone")
              : requestCapturePermission("microphone"))}
          >
            {busyControl === "microphone" ? <LoaderCircle className="spin" size={21} /> : isMicrophoneEnabled ? <Mic size={21} /> : <MicOff size={21} />}
          </CallControl>
        </MediaControl>
        <MediaControl
          disabled={mediaControlsDisabled || !cameraPermissionGranted}
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
              onSelect={(kind, deviceId) => void selectDevice(kind, deviceId, true)}
            />
          )}
        >
          <CallControl
            active={cameraPermissionGranted && isCameraEnabled}
            disabled={mediaControlsDisabled}
            inactiveReason={cameraInactiveReason}
            label={cameraPermissionGranted
              ? isCameraEnabled ? "Выключить камеру" : "Включить камеру"
              : "Запросить доступ к камере"}
            onClick={() => void (cameraPermissionGranted
              ? toggleMedia("camera")
              : requestCapturePermission("camera"))}
          >
            {busyControl === "camera" ? <LoaderCircle className="spin" size={21} /> : isCameraEnabled ? <Video size={21} /> : <VideoOff size={21} />}
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
            active={isScreenShareEnabled}
            disabled={mediaControlsDisabled}
            inactiveReason={screenShareSupported
              ? undefined
              : "Браузер не поддерживает демонстрацию экрана"}
            label={screenShareSupported ? (isScreenShareEnabled ? "Остановить демонстрацию" : "Начать демонстрацию") : "Демонстрация экрана недоступна"}
            onClick={() => {
              if (screenShareSupported) void toggleMedia("screen");
            }}
          >
            {busyControl === "screen" ? <LoaderCircle className="spin" size={21} /> : <MonitorUp size={21} />}
          </CallControl>
        </MediaControl>
        <CallControl active={isFullscreen} label={isFullscreen ? "Свернуть звонок" : "Развернуть звонок"} onClick={() => void toggleFullscreen()}>
          <Maximize2 size={20} />
        </CallControl>
        <button
          type="button"
          className={`call-control${settingsOpen ? " is-active" : ""}`}
          aria-label="Открыть настройки звонка"
          title="Открыть настройки звонка"
          disabled={mediaControlsDisabled}
          onClick={() => void openSettings()}
        >
          <Settings size={20} />
        </button>
        <CallControl danger label="Покинуть звонок" onClick={() => { void room.disconnect(); onLeave(); }}>
          <PhoneOff size={20} />
        </CallControl>
      </div>
      <StartAudio className="call-start-audio" label="Включить звук" />
      <RoomAudioRenderer />
      <Modal
        open={settingsOpen}
        title="Настройки звонка"
        onClose={() => setSettingsOpen(false)}
        width="large"
        backdropClassName="call-settings-modal"
      >
        <CallSettings
          devices={devices}
          preferences={devicePreferences}
          disabled={mediaControlsDisabled}
          onRefreshDevices={() => void refreshDevices()}
          onSelectDevice={(kind, deviceId) => void selectDevice(kind, deviceId, false)}
          onPreferencesChange={onPreferencesChange}
          onError={onMediaError}
        />
      </Modal>
    </div>
  );
}

export function CallWorkspace({
  requestCredentials,
  requestParticipants,
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
  const [lobbyParticipants, setLobbyParticipants] = useState<CallLobbyParticipant[]>([]);
  const intentionalLeave = useRef(false);
  const autoJoinAttempted = useRef(false);

  useEffect(() => {
    if (!requestParticipants || unavailable || (credentials && stage === "active")) return;
    let cancelled = false;
    let requestInFlight = false;
    const refreshParticipants = async () => {
      if (requestInFlight || document.visibilityState === "hidden") return;
      requestInFlight = true;
      try {
        const participants = await requestParticipants();
        if (!cancelled) setLobbyParticipants(participants);
      } catch {
        // Keep the last known roster when a background refresh fails.
      } finally {
        requestInFlight = false;
      }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") void refreshParticipants();
    };
    void refreshParticipants();
    const timer = window.setInterval(() => void refreshParticipants(), 5_000);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [credentials, requestParticipants, stage, unavailable]);

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

  const changePreferences = useCallback((patch: Partial<CallDevicePreferences>) => {
    setDevicePreferences((current) => {
      const next = { ...current, ...patch };
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
        <div className="call-lobby-summary">
          <div className={`call-lobby-icon ${interrupted ? "is-error" : ""}`}>
            {interrupted ? <AlertTriangle size={24} /> : <Video size={25} />}
          </div>
          <div className="call-lobby-copy">
            <strong>{interrupted ? "Связь прервалась" : left ? "Вы вышли из звонка" : "Видеозвонок"}</strong>
            <span>{interrupted ? "Подключитесь повторно" : left ? "Можно вернуться в любой момент" : "Камера и микрофон после входа выключены"}</span>
          </div>
        </div>
        <div className="call-lobby-roster" aria-label="Участники звонка" aria-live="polite">
          {lobbyParticipants.length === 0 ? (
            <span className="call-lobby-roster__empty">В звонке пока никого</span>
          ) : lobbyParticipants.map((participant) => (
            <div className="call-lobby-participant" key={participant.identity}>
              <span
                className="call-lobby-participant__avatar"
                style={{ backgroundColor: participant.color }}
                aria-hidden="true"
              >
                {participantInitials(participant.displayName)}
              </span>
              <span className="call-lobby-participant__name">{participant.displayName}</span>
              <span className="call-lobby-participant__media">
                {!participant.microphoneEnabled && (
                  <span title="Микрофон выключен" aria-label="Микрофон выключен"><MicOff size={14} /></span>
                )}
                {participant.cameraEnabled && (
                  <span title="Камера включена" aria-label="Камера включена"><Video size={14} /></span>
                )}
                {participant.screenShareEnabled && (
                  <span title="Демонстрация экрана включена" aria-label="Демонстрация экрана включена"><MonitorUp size={14} /></span>
                )}
              </span>
            </div>
          ))}
        </div>
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
        webAudioMix: true,
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
        onPreferencesChange={changePreferences}
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
  const requestParticipants = useCallback(
    () => api.lessons.callParticipants(lessonId),
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
      requestParticipants={requestParticipants}
      profile={profile}
      updateParticipantProfile={updateParticipantProfile}
      unavailable={unavailable}
    />
  );
}

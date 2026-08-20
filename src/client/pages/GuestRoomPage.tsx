import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Braces,
  Check,
  Copy,
  House,
  Phone,
  Presentation,
} from "lucide-react";
import {
  Link,
  Navigate,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import { Button, Modal } from "../components/UI";
import type { CollaborationProfile } from "../../shared/collaborationProfile";
import {
  ApiError,
  api,
  type GuestResourceKind,
  type GuestRoom,
} from "../api";
import { CallWorkspace } from "../components/LessonCall";
import { GuestCodeWorkspace } from "../components/GuestCodeWorkspace";
import { GuestBoard } from "../board/LessonBoard";
import { guestDeviceId } from "../guestIdentity";
import {
  OnlineProfileButton,
  OnlineProfileProvider,
  useOnlineProfile,
} from "../onlineProfile";
import { ThemeToggle } from "../theme";

type RoomState =
  | { kind: "loading" }
  | { kind: "active"; room: GuestRoom }
  | { kind: "expired" }
  | { kind: "missing" }
  | { kind: "error"; message: string };

function RoomEnded({ missing = false }: { missing?: boolean }) {
  return (
    <main className="room-ended">
      <ThemeToggle className="theme-toggle--floating" />
      <div>
        <House size={28} />
        <h1>{missing ? "Сеанс не найден" : "Сеанс завершён"}</h1>
        <Link className="button button--primary" to="/">На главную</Link>
      </div>
    </main>
  );
}

export function GuestRoomPage() {
  return (
    <OnlineProfileProvider>
      <GuestRoomPageContent />
    </OnlineProfileProvider>
  );
}

function GuestRoomPageContent() {
  const { shareId = "", resourceKind } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [state, setState] = useState<RoomState>({ kind: "loading" });
  const [copied, setCopied] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [adding, setAdding] = useState<GuestResourceKind | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [autoJoinCall, setAutoJoinCall] = useState(() => (
    (location.state as { autoJoinCall?: unknown } | null)?.autoJoinCall === true
  ));
  const deviceId = useMemo(guestDeviceId, []);
  const { profile } = useOnlineProfile({
    defaultDisplayName: "Гость",
    required: state.kind === "active",
  });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    const load = (initial: boolean) => {
      void api.guestRooms.get(shareId).then((room) => {
        if (!cancelled) setState({ kind: "active", room });
      }).catch((error) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 410) {
          setState({ kind: "expired" });
        } else if (error instanceof ApiError && error.status === 404) {
          setState({ kind: "missing" });
        } else if (initial) {
          setState({
            kind: "error",
            message: error instanceof Error
              ? error.message
              : "Не удалось открыть комнату",
          });
        }
      });
    };
    load(true);
    const refreshTimer = window.setInterval(() => load(false), 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(refreshTimer);
    };
  }, [shareId]);

  const requestCredentials = useCallback(
    () => api.guestRooms.callToken(shareId, {
      deviceId,
      ...(profile ? { profile } : {}),
    }),
    [deviceId, profile, shareId],
  );
  const updateParticipantProfile = useCallback(
    (nextProfile: CollaborationProfile) => (
      api.guestRooms.updateCallProfile(shareId, deviceId, nextProfile)
    ),
    [deviceId, shareId],
  );
  const activeResource = useMemo(() => {
    if (state.kind !== "active") return null;
    return state.room.resources.find((resource) => (
      resource.kind === resourceKind
    )) ?? null;
  }, [resourceKind, state]);
  const callResource = state.kind === "active"
    ? state.room.resources.find((resource) => resource.kind === "call") ?? null
    : null;

  if (state.kind === "loading") {
    return <div className="app-loading"><span className="spinner" /></div>;
  }
  if (state.kind === "expired") return <RoomEnded />;
  if (state.kind === "missing") return <RoomEnded missing />;
  if (state.kind === "error") {
    return (
      <main className="room-ended">
        <ThemeToggle className="theme-toggle--floating" />
        <div>
          <h1>Комната недоступна</h1>
          <p>{state.message}</p>
          <Link className="button button--primary" to="/">На главную</Link>
        </div>
      </main>
    );
  }
  if (!resourceKind) {
    const first = state.room.resources[0];
    return first
      ? <Navigate to={`/room/${shareId}/${first.kind}`} replace />
      : <RoomEnded missing />;
  }
  if (!activeResource) return <RoomEnded missing />;

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
      setActionError("Не удалось скопировать ссылку");
    }
  };

  const addResource = async (kind: GuestResourceKind) => {
    if (adding) return;
    setAdding(kind);
    setActionError(null);
    try {
      const result = await api.guestRooms.ensureResource(shareId, kind);
      setState({ kind: "active", room: result.room });
      if (kind === "call") {
        setAutoJoinCall(true);
        return;
      }
      navigate(`/room/${shareId}/${kind}`);
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 410) {
        setState({ kind: "expired" });
      } else {
        setActionError(
          reason instanceof Error
            ? reason.message
            : "Не удалось добавить инструмент",
        );
      }
    } finally {
      setAdding(null);
    }
  };

  return (
    <>
      <main className="guest-room">
      <header className="public-workspace__bar guest-room__bar">
        <button
          type="button"
          className="public-workspace__back"
          aria-label="На главную"
          onClick={() => setLeaveOpen(true)}
        >
          <ArrowLeft size={18} />
        </button>
        <nav className="guest-room__tabs" aria-label="Инструменты комнаты">
          {state.room.resources.map((resource) => (
            <Link
              key={resource.id}
              className={resource.kind === resourceKind ? "is-active" : ""}
              to={`/room/${shareId}/${resource.kind}`}
            >
              {resource.kind === "board"
                ? "Доска"
                : resource.kind === "code"
                  ? "Код"
                  : "Звонок"}
            </Link>
          ))}
          {!state.room.resources.some((resource) => resource.kind === "board") && (
            <button
              type="button"
              disabled={adding !== null}
              onClick={() => void addResource("board")}
              title="Добавить доску"
            >
              <Presentation size={15} />
              <span>Добавить доску</span>
            </button>
          )}
          {!state.room.resources.some((resource) => resource.kind === "code") && (
            <button
              type="button"
              disabled={adding !== null}
              onClick={() => void addResource("code")}
              title="Добавить код"
            >
              <Braces size={15} />
              <span>Добавить код</span>
            </button>
          )}
          {!callResource && (
            <button
              type="button"
              disabled={adding !== null}
              onClick={() => void addResource("call")}
              title="Начать звонок"
            >
              <Phone size={15} />
              <span>Начать звонок</span>
            </button>
          )}
        </nav>
        <div className="guest-room__header-actions">
          <OnlineProfileButton />
          <ThemeToggle />
          <button
            type="button"
            className="guest-room__copy"
            onClick={() => void copyLink()}
          >
            {copied ? <Check size={16} /> : <Copy size={16} />}
            {copied ? "Скопирована" : "Ссылка"}
          </button>
        </div>
      </header>
      {actionError && (
        <div className="guest-room__action-error" role="alert">
          {actionError}
        </div>
      )}
      <section
        className={`guest-room__content ${callResource ? "has-call" : ""} ${resourceKind === "call" ? "is-call-focused" : ""}`}
      >
        <div className="guest-room__stage">
          {profile && resourceKind === "board" ? (
            <GuestBoard
              shareId={shareId}
              deviceId={deviceId}
              profile={profile}
              onTerminal={(kind) => setState({
                kind: kind === "expired" ? "expired" : "missing",
              })}
            />
          ) : profile && resourceKind === "code" ? (
            <GuestCodeWorkspace
              shareId={shareId}
              resourceId={activeResource.id}
              deviceId={deviceId}
              profile={profile}
              onTerminal={(kind) => setState({
                kind: kind === "expired" ? "expired" : "missing",
              })}
            />
          ) : null}
        </div>
        {profile && callResource && (
          <aside className="guest-room__call" aria-label="Звонок">
            <CallWorkspace
              requestCredentials={requestCredentials}
              profile={profile}
              updateParticipantProfile={updateParticipantProfile}
              autoJoin={autoJoinCall}
            />
          </aside>
        )}
      </section>
      </main>
      <Modal
        open={leaveOpen}
        title="Покинуть комнату?"
        description={
          callResource
            ? "Звонок будет отключён. Доска, код и материалы останутся в комнате — вернуться можно по этой ссылке."
            : "Доска, код и материалы останутся в комнате — вернуться можно по этой ссылке."
        }
        onClose={() => setLeaveOpen(false)}
        width="small"
      >
        <div className="modal-actions">
          <Button variant="secondary" autoFocus onClick={() => setLeaveOpen(false)}>
            Остаться
          </Button>
          <Button onClick={() => navigate("/")}>Покинуть комнату</Button>
        </div>
      </Modal>
    </>
  );
}

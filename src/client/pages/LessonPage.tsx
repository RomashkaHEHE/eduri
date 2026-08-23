import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { io, type Socket } from "socket.io-client";
import {
  ArrowLeft,
  BookOpen,
  Check,
  CircleStop,
  Code2,
  ExternalLink,
  FileText,
  LibraryBig,
  PencilRuler,
  Search,
  Signal,
  SignalLow,
  X,
} from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import type { LessonSummary } from "../../shared/types";
import type { MaterialDetail } from "../api";
import { api } from "../api";
import { homeForRole, useAuth } from "../auth";
import { getBoardCatalogEntry } from "../board/catalog";
import { LessonBoard } from "../board/LessonBoard";
import { useCriticalDataGuard } from "../board/criticalDataGuard";
import { Button, EmptyState, ErrorState, IconButton, LoadingBlock, Modal, Notice, formatDateTime, useAsyncData } from "../components/UI";
import {
  OnlineProfileButton,
  OnlineProfileProvider,
  useOnlineProfile,
} from "../onlineProfile";
import { ThemeToggle } from "../theme";

type WorkspaceMode = "board" | "code" | "materials";
type ConnectionState = "connecting" | "connected" | "offline";

interface LessonSocketState {
  materials?: MaterialDetail[];
}

interface LessonJoinAck {
  ok: boolean;
  lesson?: {
    status?: LessonSummary["status"];
  };
}

const LessonCodeWorkspace = lazy(
  () => import("../components/LessonCodeWorkspace")
    .then((module) => ({ default: module.LessonCodeWorkspace })),
);

function elapsedLabel(start?: string | null) {
  if (!start) return "00:00";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(start).getTime()) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return `${hours ? `${String(hours).padStart(2, "0")}:` : ""}${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function useElapsed(start?: string | null) {
  const [value, setValue] = useState(() => elapsedLabel(start));
  useEffect(() => {
    setValue(elapsedLabel(start));
    const timer = window.setInterval(() => setValue(elapsedLabel(start)), 1000);
    return () => window.clearInterval(timer);
  }, [start]);
  return value;
}

function progressLabel(status?: MaterialDetail["progressStatus"]) {
  if (status === "completed") return "Выполнено";
  if (status === "covered") return "Разобрано";
  return "Назначено";
}

export function LessonPage() {
  return (
    <OnlineProfileProvider>
      <LessonPageContent />
    </OnlineProfileProvider>
  );
}

function LessonPageContent() {
  const { lessonId = "" } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const resource = useAsyncData(async () => {
    try {
      const lesson = await api.lessons.get(lessonId);
      const materials = await api.materials.list(user?.role === "tutor" ? {} : { studentId: lesson.studentId });
      return { lesson, materials };
    } catch (error) {
      const cached = user?.id ? await getBoardCatalogEntry(user.id, lessonId).catch(() => null) : null;
      if (!cached?.lesson) throw error;
      return {
        lesson: { ...cached.lesson, materials: [], notes: "" },
        materials: [] as MaterialDetail[],
      };
    }
  }, [lessonId, user?.id, user?.role]);
  const { profile } = useOnlineProfile({
    defaultDisplayName: user?.displayName ?? "",
    required: Boolean(resource.data && user),
  });
  useEffect(() => {
    let cancelled = false;
    resource.setData((current) =>
      current?.lesson.id === lessonId ? current : null);
    if (!user?.id || !lessonId) return () => {
      cancelled = true;
    };
    void getBoardCatalogEntry(user.id, lessonId)
      .then((cached) => {
        if (!cancelled && cached?.lesson) {
          resource.setData((current) => current ?? {
            lesson: { ...cached.lesson!, materials: [], notes: "" },
            materials: [] as MaterialDetail[],
          });
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [lessonId, resource.setData, user?.id]);
  const [mode, setMode] = useState<WorkspaceMode>("board");
  const [codeActivated, setCodeActivated] = useState(false);
  const [materialSearch, setMaterialSearch] = useState("");
  const [planMaterials, setPlanMaterials] = useState<MaterialDetail[]>([]);
  const [materials, setMaterials] = useState<MaterialDetail[]>([]);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [boardDataAtRisk, setBoardDataAtRisk] = useState(false);
  const [endOpen, setEndOpen] = useState(false);
  const [ending, setEnding] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const elapsed = useElapsed(resource.data?.lesson.startedAt ?? resource.data?.lesson.scheduledAt);
  const runGuardedBoardExit = useCriticalDataGuard(boardDataAtRisk);

  const leaveLesson = useCallback(() => {
    if (!user) return;
    runGuardedBoardExit(() => navigate(homeForRole(user.role)));
  }, [navigate, runGuardedBoardExit, user]);

  useEffect(() => {
    if (!resource.data) return;
    setMaterials(resource.data.materials);
    setPlanMaterials(resource.data.lesson.materials ?? resource.data.materials.filter((material) => material.progressLessonId === resource.data!.lesson.id));
  }, [resource.data]);

  useEffect(() => {
    if (!lessonId) return;
    const updateLessonStatus = (status: LessonSummary["status"]) => {
      resource.setData((current) => current
        ? { ...current, lesson: { ...current.lesson, status } }
        : current);
    };
    const socket = io({ withCredentials: true, transports: ["websocket", "polling"] });
    socketRef.current = socket;
    const connected = () => {
      setConnection("connected");
      socket.emit("lesson:join", { lessonId }, (ack: LessonJoinAck) => {
        if (!ack?.ok || !ack.lesson) return;
        if (ack.lesson.status) updateLessonStatus(ack.lesson.status);
      });
    };
    socket.on("connect", connected);
    socket.on("disconnect", () => setConnection("offline"));
    socket.on("connect_error", () => setConnection("offline"));
    socket.on("lesson:material", (payload: { lessonId?: string; material?: MaterialDetail; materials?: MaterialDetail[] }) => {
      if (payload.lessonId && payload.lessonId !== lessonId) return;
      if (payload.materials) setPlanMaterials(payload.materials);
      else if (payload.material) setPlanMaterials((current) => current.some((item) => item.id === payload.material!.id) ? current : [...current, payload.material!]);
    });
    socket.on("lesson:status", (payload: { lessonId?: string; status?: LessonSummary["status"] }) => {
      if (payload.lessonId && payload.lessonId !== lessonId) return;
      if (!payload.status || !["scheduled", "active", "completed", "cancelled"].includes(payload.status)) return;
      updateLessonStatus(payload.status);
    });
    socket.on("lesson:state", (payload: LessonSocketState) => {
      if (payload.materials) setPlanMaterials(payload.materials);
    });
    return () => {
      socket.emit("lesson:leave", { lessonId });
      socket.disconnect();
      socketRef.current = null;
    };
  }, [lessonId]);

  const addMaterial = async (material: MaterialDetail) => {
    if (planMaterials.some((item) => item.id === material.id)) return;
    setActionError(null);
    const previous = planMaterials;
    setPlanMaterials((current) => [...current, material]);
    try {
      const result = await api.lessons.attachMaterial(lessonId, material.id, planMaterials.length);
      setPlanMaterials(result.materials);
      setMaterials((current) => current.map((item) => result.materials.find((attached) => attached.id === item.id) ?? item));
      socketRef.current?.emit("lesson:material", { lessonId, materials: result.materials });
    } catch (reason) {
      setPlanMaterials(previous);
      setActionError(reason instanceof Error ? reason.message : "Не удалось добавить материал в план");
    }
  };

  const finishLesson = async () => {
    if (!resource.data || !user) return;
    let allowed = false;
    runGuardedBoardExit(() => {
      allowed = true;
    });
    if (!allowed) return;
    setEnding(true);
    try { await api.lessons.finish(lessonId); navigate(homeForRole(user.role)); }
    catch (reason) { setActionError(reason instanceof Error ? reason.message : "Не удалось завершить урок"); setEnding(false); setEndOpen(false); }
  };

  const filteredMaterials = useMemo(() => {
    const query = materialSearch.trim().toLocaleLowerCase("ru");
    return materials.filter((material) => !query || `${material.title} ${material.body ?? ""} ${material.tags.join(" ")}`.toLocaleLowerCase("ru").includes(query));
  }, [materials, materialSearch]);

  if (resource.loading && !resource.data) return (
    <div className="lesson-loading">
      <ThemeToggle className="theme-toggle--floating" />
      <LoadingBlock label="Подготавливаем рабочее пространство" />
    </div>
  );
  if (!resource.data || !user) return (
    <div className="lesson-loading">
      <ThemeToggle className="theme-toggle--floating" />
      <ErrorState message={resource.error ?? "Урок не найден"} onRetry={resource.reload} />
    </div>
  );
  const { lesson } = resource.data;

  return (
    <main className="lesson-shell">
      <header className="lesson-header">
        <IconButton label="Выйти из урока" onClick={leaveLesson}><ArrowLeft size={20} /></IconButton>
        <div className="lesson-header__title"><strong>{lesson.title}</strong><span>{lesson.studentName} · {formatDateTime(lesson.scheduledAt, { hour: "2-digit", minute: "2-digit" })}</span></div>
        <div className={`connection-pill connection-pill--${connection}`}>{connection === "connected" ? <Signal size={15} /> : <SignalLow size={15} />}<span>{connection === "connected" ? "На связи" : connection === "connecting" ? "Подключение" : "Нет связи"}</span></div>
        <time className="lesson-timer">{elapsed}</time>
        <OnlineProfileButton className="lesson-header__profile" />
        <ThemeToggle className="lesson-header__theme" />
        {user.role === "tutor" ? <Button variant="danger" size="small" icon={<CircleStop size={17} />} onClick={() => setEndOpen(true)}>Завершить</Button> : <Button variant="secondary" size="small" icon={<X size={17} />} onClick={leaveLesson}>Выйти</Button>}
      </header>

      <nav className="lesson-modes" aria-label="Рабочий режим">
        <button className={mode === "board" ? "is-active" : ""} onClick={() => setMode("board")} title="Доска"><PencilRuler size={21} /><span>Доска</span></button>
        <button className={mode === "code" ? "is-active" : ""} onClick={() => { setCodeActivated(true); setMode("code"); }} title="Код"><Code2 size={21} /><span>Код</span></button>
        <button className={mode === "materials" ? "is-active" : ""} onClick={() => setMode("materials")} title="Материалы"><LibraryBig size={21} /><span>Материалы</span></button>
      </nav>

      <section className="lesson-workspace">
        {actionError && <div className="lesson-toast"><Notice type="error">{actionError}</Notice><IconButton label="Закрыть" onClick={() => setActionError(null)}><X size={16} /></IconButton></div>}
        <div className={`workspace-pane ${mode === "board" ? "is-visible" : ""}`} aria-hidden={mode !== "board"}>
          {profile && <LessonBoard
            lessonId={lesson.id}
            userId={user.id}
            lesson={lesson}
            profile={profile}
            onCriticalDataRiskChange={setBoardDataAtRisk}
          />}
        </div>
        <div className={`workspace-pane code-workspace ${mode === "code" ? "is-visible" : ""}`} aria-hidden={mode !== "code"}>
          {profile && codeActivated && (
            <Suspense fallback={<div className="lesson-runtime-loading"><LoadingBlock label="Загружаем редактор кода" /></div>}>
              <LessonCodeWorkspace
                lessonId={lesson.id}
                userId={user.id}
                profile={profile}
                readOnly={lesson.status === "completed" || lesson.status === "cancelled"}
              />
            </Suspense>
          )}
        </div>
        <div className={`workspace-pane lesson-library ${mode === "materials" ? "is-visible" : ""}`} aria-hidden={mode !== "materials"}>
          <div className="lesson-library__header"><div><h2>Материалы урока</h2><p>Добавляйте задачи и конспекты в текущий план.</p></div><label className="search-field"><Search size={17} /><span className="sr-only">Поиск материалов</span><input value={materialSearch} onChange={(event) => setMaterialSearch(event.target.value)} placeholder="Найти материал" /></label></div>
          {filteredMaterials.length ? <div className="lesson-material-grid">{filteredMaterials.map((material) => { const added = planMaterials.some((item) => item.id === material.id); return <article className="lesson-material-card" key={material.id}><div className="lesson-material-card__head"><span className={`lesson-material-card__kind lesson-material-card__kind--${material.kind}`}>{material.kind === "file" ? <FileText size={18} /> : <BookOpen size={18} />}</span><span className={`progress-tag progress-tag--${material.progressStatus ?? "assigned"}`}>{progressLabel(material.progressStatus)}</span></div><h3>{material.title}</h3><p>{material.body || material.url || material.fileName || "Материал без описания"}</p><div className="lesson-material-card__foot"><span>{material.tags.slice(0, 2).map((tag) => `#${tag}`).join(" ")}</span><Button variant={added ? "secondary" : "primary"} size="small" disabled={added} icon={added ? <Check size={16} /> : undefined} onClick={() => void addMaterial(material)}>{added ? "В плане" : "В план"}</Button></div></article>; })}</div> : <EmptyState title="Материалы не найдены" />}
        </div>
      </section>

      <Modal open={endOpen} title="Завершить занятие?" description="Доска, код и материалы останутся в истории урока." onClose={() => setEndOpen(false)} width="small"><div className="form-stack"><div className="finish-summary"><span><Check size={18} /> Материалов в плане: {planMaterials.length}</span></div><div className="modal-actions"><Button variant="secondary" onClick={() => setEndOpen(false)}>Продолжить урок</Button><Button variant="danger" disabled={ending} onClick={() => void finishLesson()}>{ending ? "Завершаем…" : "Завершить"}</Button></div></div></Modal>
    </main>
  );
}

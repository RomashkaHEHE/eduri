import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ArrowRight, CalendarPlus, CheckCircle2, Clock3, Play, Video } from "lucide-react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import type { LessonSummary, MaterialSummary, StudentSummary } from "../../../shared/types";
import { api } from "../../api";
import {
  Button,
  EmptyState,
  ErrorState,
  FormField,
  LoadingBlock,
  Modal,
  Notice,
  PageHeader,
  StatusBadge,
  formatDateTime,
  useAsyncData,
} from "../../components/UI";

interface TodayData {
  lessons: LessonSummary[];
  reviewCount: number;
  students: StudentSummary[];
  selectedMaterial: MaterialSummary | null;
}

function localDateTimeValue(date = new Date(Date.now() + 60 * 60 * 1000)) {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

export function TutorTodayPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedMaterialId = searchParams.get("create") === "lesson" ? searchParams.get("materialId") : null;
  const resource = useAsyncData<TodayData>(async () => {
    const [lessons, assignments, students, selectedMaterial] = await Promise.all([
      api.lessons.list({ scope: "today" }),
      api.assignments.list({ status: "submitted" }),
      api.students.list(),
      selectedMaterialId ? api.materials.get(selectedMaterialId) : Promise.resolve(null),
    ]);
    return { lessons, reviewCount: assignments.length, students, selectedMaterial };
  }, [selectedMaterialId]);
  const [lessonModal, setLessonModal] = useState(false);
  const [startingId, setStartingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (selectedMaterialId) setLessonModal(true);
  }, [selectedMaterialId]);

  const closeLessonModal = () => {
    setLessonModal(false);
    if (searchParams.get("create") !== "lesson") return;
    const next = new URLSearchParams(searchParams);
    next.delete("create");
    next.delete("materialId");
    setSearchParams(next, { replace: true });
  };

  const nextLesson = useMemo(
    () => resource.data?.lessons.find((lesson) => lesson.status === "active") ?? resource.data?.lessons.find((lesson) => lesson.status === "scheduled"),
    [resource.data],
  );

  const openLesson = async (lesson: LessonSummary) => {
    setStartingId(lesson.id);
    setActionError(null);
    try {
      if (lesson.status === "scheduled") await api.lessons.start(lesson.id);
      navigate(`/lesson/${lesson.id}`);
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : "Не удалось начать урок");
      setStartingId(null);
    }
  };

  return (
    <div className="page page--dashboard">
      <PageHeader
        title="Сегодня"
        description={new Intl.DateTimeFormat("ru-RU", { weekday: "long", day: "numeric", month: "long" }).format(new Date())}
        actions={<Button icon={<CalendarPlus size={18} />} onClick={() => setLessonModal(true)}>Запланировать урок</Button>}
      />
      {actionError && <Notice type="error">{actionError}</Notice>}
      {resource.loading && <LoadingBlock label="Загружаем расписание" />}
      {resource.error && <ErrorState message={resource.error} onRetry={resource.reload} />}
      {resource.data && (
        <div className="dashboard-grid">
          <section className="next-lesson-panel">
            <div className="section-heading"><div><span className="eyebrow">Ближайшее занятие</span><h2>{nextLesson?.title ?? "Уроков пока нет"}</h2></div>{nextLesson && <StatusBadge status={nextLesson.status} />}</div>
            {nextLesson ? (
              <>
                <div className="next-lesson-panel__student"><span className="avatar">{nextLesson.studentName.slice(0, 1).toUpperCase()}</span><div><strong>{nextLesson.studentName}</strong><span><Clock3 size={15} /> {formatDateTime(nextLesson.scheduledAt)} · {nextLesson.durationMinutes} мин</span></div></div>
                <Button icon={<Video size={18} />} onClick={() => void openLesson(nextLesson)} disabled={startingId === nextLesson.id}>
                  {nextLesson.status === "active" ? "Вернуться в урок" : "Начать урок"}
                </Button>
              </>
            ) : (
              <EmptyState title="Свободное окно" description="Создайте урок или продолжите подготовку материалов." action={<Button variant="secondary" onClick={() => setLessonModal(true)}>Запланировать</Button>} />
            )}
          </section>

          <section className="summary-panel">
            <div className="section-heading"><h2>Требует внимания</h2></div>
            <Link className="attention-row" to="/tutor/assignments">
              <span className="attention-row__icon attention-row__icon--amber"><CheckCircle2 size={19} /></span>
              <span><strong>Домашние на проверку</strong><small>Ответы учеников</small></span>
              <b>{resource.data.reviewCount}</b><ArrowRight size={17} />
            </Link>
            <Link className="attention-row" to="/tutor/students">
              <span className="attention-row__icon"><Play size={19} /></span>
              <span><strong>Активные ученики</strong><small>Карточки и история</small></span>
              <b>{resource.data.students.filter((student) => student.status === "active").length}</b><ArrowRight size={17} />
            </Link>
          </section>

          <section className="schedule-panel">
            <div className="section-heading"><h2>Расписание дня</h2><Link to="/tutor/students">Все ученики</Link></div>
            {resource.data.lessons.length ? (
              <div className="schedule-list">
                {resource.data.lessons.map((lesson) => (
                  <div className="schedule-row" key={lesson.id}>
                    <time>{new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" }).format(new Date(lesson.scheduledAt))}</time>
                    <span className="schedule-row__line" />
                    <div><strong>{lesson.studentName}</strong><span>{lesson.title} · {lesson.durationMinutes} мин</span></div>
                    <StatusBadge status={lesson.status} />
                    {lesson.status !== "completed" && lesson.status !== "cancelled" && <Button variant="ghost" size="small" onClick={() => void openLesson(lesson)}>Открыть</Button>}
                  </div>
                ))}
              </div>
            ) : <EmptyState title="На сегодня занятий нет" />}
          </section>
        </div>
      )}
      <CreateLessonModal key={selectedMaterialId ?? "blank"} open={lessonModal && !resource.loading && Boolean(resource.data)} students={resource.data?.students ?? []} initialMaterial={resource.data?.selectedMaterial} onClose={closeLessonModal} onCreated={resource.reload} />
    </div>
  );
}

export function CreateLessonModal({ open, students, onClose, onCreated, initialStudentId = "", initialMaterial }: {
  open: boolean;
  students: StudentSummary[];
  onClose: () => void;
  onCreated: () => void;
  initialStudentId?: string;
  initialMaterial?: MaterialSummary | null;
}) {
  const [title, setTitle] = useState("Занятие");
  const [studentId, setStudentId] = useState(initialStudentId);
  const [scheduledAt, setScheduledAt] = useState(localDateTimeValue());
  const [duration, setDuration] = useState(60);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const lesson = await api.lessons.create({ title: title.trim(), studentId, scheduledAt: new Date(scheduledAt).toISOString(), durationMinutes: duration });
      if (initialMaterial) await api.lessons.attachMaterial(lesson.id, initialMaterial.id, 0);
      onCreated();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось создать урок");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} title="Новое занятие" onClose={onClose}>
      <form className="form-stack" onSubmit={submit}>
        {initialMaterial && <Notice type="info"><strong>Материал для урока:</strong> {initialMaterial.title}</Notice>}
        <FormField label="Ученик"><select value={studentId} onChange={(event) => setStudentId(event.target.value)} required><option value="">Выберите ученика</option>{students.map((student) => <option key={student.id} value={student.id}>{student.displayName}</option>)}</select></FormField>
        <FormField label="Название"><input value={title} onChange={(event) => setTitle(event.target.value)} required /></FormField>
        <div className="form-row"><FormField label="Дата и время"><input type="datetime-local" value={scheduledAt} onChange={(event) => setScheduledAt(event.target.value)} required /></FormField><FormField label="Длительность"><select value={duration} onChange={(event) => setDuration(Number(event.target.value))}><option value={45}>45 минут</option><option value={60}>60 минут</option><option value={90}>90 минут</option><option value={120}>120 минут</option></select></FormField></div>
        {error && <Notice type="error">{error}</Notice>}
        {!students.length && <Notice type="info">Сначала создайте ученика.</Notice>}
        <div className="modal-actions"><Button variant="secondary" type="button" onClick={onClose}>Отмена</Button><Button type="submit" disabled={submitting || !students.length || !studentId}>{submitting ? "Создаём…" : "Создать"}</Button></div>
      </form>
    </Modal>
  );
}

import { useState, type FormEvent } from "react";
import { ArrowLeft, BookOpen, CalendarPlus, Copy, Edit3, Send, Video } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { AssignmentSummary, LessonSummary, StudentSummary } from "../../../shared/types";
import { api, type MaterialDetail, type StudentDetail } from "../../api";
import {
  Button,
  EmptyState,
  ErrorState,
  FormField,
  IconButton,
  LoadingBlock,
  Modal,
  Notice,
  StatusBadge,
  formatDateTime,
  initials,
  useAsyncData,
} from "../../components/UI";
import { CreateLessonModal } from "./TutorTodayPage";

interface DetailData { student: StudentDetail; lessons: LessonSummary[]; assignments: AssignmentSummary[]; materials: MaterialDetail[] }

function linkFromInvite(result: { inviteUrl?: string; inviteToken?: string }) {
  if (result.inviteUrl) return new URL(result.inviteUrl, window.location.origin).toString();
  return result.inviteToken ? `${window.location.origin}/activate#token=${encodeURIComponent(result.inviteToken)}` : "";
}

export function StudentDetailPage() {
  const { studentId = "" } = useParams();
  const navigate = useNavigate();
  const resource = useAsyncData<DetailData>(async () => {
    const [student, lessons, assignments, materials] = await Promise.all([
      api.students.get(studentId),
      api.lessons.list({ studentId }),
      api.assignments.list({ studentId }),
      api.materials.list({ studentId }),
    ]);
    return { student, lessons, assignments, materials };
  }, [studentId]);
  const [lessonModal, setLessonModal] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  if (resource.loading) return <div className="page"><LoadingBlock label="Открываем карточку ученика" /></div>;
  if (resource.error || !resource.data) return <div className="page"><ErrorState message={resource.error ?? "Ученик не найден"} onRetry={resource.reload} /></div>;
  const { student, lessons, assignments, materials } = resource.data;
  const upcoming = lessons.filter((lesson) => lesson.status === "scheduled" || lesson.status === "active");

  return (
    <div className="page">
      <Link className="back-link" to="/tutor/students"><ArrowLeft size={16} /> Ученики</Link>
      <header className="student-profile-header">
        <div className="student-profile-header__identity"><span className="avatar avatar--large">{initials(student.displayName)}</span><div><h1>{student.displayName}</h1><span>{student.loginName}</span><StatusBadge status={student.status} /></div></div>
        <div className="student-profile-header__actions"><Button variant="secondary" icon={<Edit3 size={17} />} onClick={() => setEditOpen(true)}>Изменить</Button><Button variant="secondary" icon={<Send size={17} />} onClick={() => setInviteOpen(true)}>Пригласить</Button><Button icon={<CalendarPlus size={18} />} onClick={() => setLessonModal(true)}>Запланировать</Button></div>
      </header>

      <div className="metric-strip">
        <div><span>Следующий урок</span><strong>{formatDateTime(student.nextLessonAt)}</strong></div>
        <div><span>Последний урок</span><strong>{formatDateTime(student.lastLessonAt)}</strong></div>
        <div><span>Домашние в работе</span><strong>{student.pendingAssignments}</strong></div>
        <div><span>Всего занятий</span><strong>{lessons.filter((lesson) => lesson.status === "completed").length}</strong></div>
      </div>

      {student.note && <section className="inline-note"><Edit3 size={17} /><div><strong>Заметка репетитора</strong><p>{student.note}</p></div></section>}

      <div className="detail-grid">
        <section className="content-section">
          <div className="section-heading"><h2>Занятия</h2><button className="link-button" onClick={() => setLessonModal(true)}>Добавить</button></div>
          {lessons.length ? <div className="timeline-list">{lessons.map((lesson) => <article className="timeline-row" key={lesson.id}><span className={`timeline-row__dot timeline-row__dot--${lesson.status}`} /><div><strong>{lesson.title}</strong><span>{formatDateTime(lesson.scheduledAt)} · {lesson.durationMinutes} мин</span></div><StatusBadge status={lesson.status} />{(lesson.status === "scheduled" || lesson.status === "active") && <IconButton label="Открыть урок" onClick={() => navigate(`/lesson/${lesson.id}`)}><Video size={18} /></IconButton>}</article>)}</div> : <EmptyState title="Занятий пока нет" action={<Button variant="secondary" onClick={() => setLessonModal(true)}>Запланировать</Button>} />}
        </section>

        <aside className="content-section">
          <div className="section-heading"><h2>Домашние задания</h2><Link to="/tutor/assignments">Все</Link></div>
          {assignments.length ? <div className="compact-list">{assignments.slice(0, 6).map((assignment) => <div className="compact-row" key={assignment.id}><span className="compact-row__icon"><BookOpen size={17} /></span><div><strong>{assignment.title}</strong><span>{assignment.dueAt ? `До ${formatDateTime(assignment.dueAt)}` : "Без срока"}</span></div><StatusBadge status={assignment.status} /></div>)}</div> : <EmptyState title="Заданий пока нет" />}
        </aside>
      </div>

      <section className="content-section student-material-progress">
        <div className="section-heading"><h2>Материалы и прогресс</h2><Link to="/tutor/materials">Библиотека</Link></div>
        {materials.length ? <div className="progress-material-list">{materials.slice(0, 8).map((material) => <div key={material.id}><span className="compact-row__icon"><BookOpen size={17} /></span><div><strong>{material.title}</strong><span>{material.kind === "task" ? "Задача" : material.kind === "note" ? "Конспект" : "Материал"}</span></div><span className={`progress-tag progress-tag--${material.progressStatus ?? "assigned"}`}>{material.progressStatus === "completed" ? "Выполнено" : material.progressStatus === "covered" ? "Разобрано" : "Назначено"}</span></div>)}</div> : <EmptyState title="Материалы ещё не назначены" />}
      </section>

      <CreateLessonModal open={lessonModal} students={[student as StudentSummary]} initialStudentId={student.id} onClose={() => setLessonModal(false)} onCreated={resource.reload} />
      <StudentInviteDialog open={inviteOpen} student={student} onClose={() => setInviteOpen(false)} />
      <EditStudentDialog open={editOpen} student={student} onClose={() => setEditOpen(false)} onSaved={resource.reload} />
    </div>
  );
}

function StudentInviteDialog({ open, student, onClose }: { open: boolean; student: StudentSummary; onClose: () => void }) {
  const [link, setLink] = useState(""); const [loading, setLoading] = useState(false); const [error, setError] = useState<string | null>(null);
  const create = async () => { setLoading(true); setError(null); try { setLink(linkFromInvite(await api.students.invite(student.id))); } catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось выпустить ссылку"); } finally { setLoading(false); } };
  return <Modal open={open} title="Приглашение ученика" onClose={() => { setLink(""); setError(null); onClose(); }}><div className="form-stack">{link ? <FormField label="Одноразовая ссылка"><div className="copy-field"><input value={link} readOnly /><IconButton label="Скопировать" onClick={() => void navigator.clipboard.writeText(link)}><Copy size={18} /></IconButton></div></FormField> : <p className="modal-copy">Выпустите новую ссылку для активации аккаунта ученика.</p>}{error && <Notice type="error">{error}</Notice>}<div className="modal-actions"><Button variant="secondary" onClick={onClose}>Закрыть</Button>{!link && <Button onClick={() => void create()} disabled={loading}>{loading ? "Создаём…" : "Создать ссылку"}</Button>}</div></div></Modal>;
}

function EditStudentDialog({ open, student, onClose, onSaved }: { open: boolean; student: StudentDetail; onClose: () => void; onSaved: () => void }) {
  const [displayName, setDisplayName] = useState(student.displayName); const [note, setNote] = useState(student.note ?? ""); const [error, setError] = useState<string | null>(null); const [loading, setLoading] = useState(false);
  const submit = async (event: FormEvent) => { event.preventDefault(); setLoading(true); setError(null); try { await api.students.update(student.id, { displayName: displayName.trim(), note: note.trim() }); onSaved(); onClose(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось сохранить"); } finally { setLoading(false); } };
  return <Modal open={open} title="Изменить ученика" onClose={onClose}><form className="form-stack" onSubmit={submit}><FormField label="Имя"><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} required /></FormField><FormField label="Заметка"><textarea rows={4} value={note} onChange={(event) => setNote(event.target.value)} /></FormField>{error && <Notice type="error">{error}</Notice>}<div className="modal-actions"><Button type="button" variant="secondary" onClick={onClose}>Отмена</Button><Button type="submit" disabled={loading || !displayName.trim()}>{loading ? "Сохраняем…" : "Сохранить"}</Button></div></form></Modal>;
}

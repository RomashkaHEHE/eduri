import { ArrowRight, BookOpen, Calendar, CheckCircle2, Clock3, Video } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import type { AssignmentSummary, LessonSummary } from "../../../shared/types";
import { api } from "../../api";
import { Button, EmptyState, ErrorState, LoadingBlock, PageHeader, StatusBadge, formatDateTime, useAsyncData } from "../../components/UI";

interface StudentTodayData { lessons: LessonSummary[]; assignments: AssignmentSummary[] }

export function StudentTodayPage() {
  const navigate = useNavigate();
  const resource = useAsyncData<StudentTodayData>(async () => {
    const [lessons, assignments] = await Promise.all([api.lessons.list({ scope: "upcoming" }), api.assignments.list()]);
    return { lessons, assignments };
  }, []);
  const nextLesson = resource.data?.lessons.find((lesson) => lesson.status === "active") ?? resource.data?.lessons.find((lesson) => lesson.status === "scheduled");
  const activeAssignments = resource.data?.assignments.filter((assignment) => assignment.status === "assigned" || assignment.status === "returned") ?? [];

  return <div className="page"><PageHeader title="Сегодня" description={new Intl.DateTimeFormat("ru-RU", { weekday: "long", day: "numeric", month: "long" }).format(new Date())} />{resource.loading && <LoadingBlock label="Загружаем кабинет" />}{resource.error && <ErrorState message={resource.error} onRetry={resource.reload} />}{resource.data && <div className="student-dashboard"><section className="student-next-lesson"><div className="section-heading"><div><span className="eyebrow">Следующее занятие</span><h2>{nextLesson?.title ?? "Пока не запланировано"}</h2></div>{nextLesson && <StatusBadge status={nextLesson.status} />}</div>{nextLesson ? <div className="student-next-lesson__body"><span className="student-next-lesson__date"><Calendar size={21} /><strong>{formatDateTime(nextLesson.scheduledAt, { weekday: "long", day: "numeric", month: "long" })}</strong></span><span><Clock3 size={17} /> {formatDateTime(nextLesson.scheduledAt, { hour: "2-digit", minute: "2-digit" })} · {nextLesson.durationMinutes} минут</span><Button icon={<Video size={18} />} onClick={() => navigate(`/lesson/${nextLesson.id}`)}>{nextLesson.status === "active" ? "Подключиться" : "Открыть занятие"}</Button></div> : <EmptyState title="В расписании пусто" description="Новое занятие появится здесь после того, как репетитор его назначит." />}</section><section className="student-homework-panel"><div className="section-heading"><h2>Домашние задания</h2><Link to="/student/assignments">Все задания</Link></div>{activeAssignments.length ? <div className="homework-brief-list">{activeAssignments.slice(0, 4).map((assignment) => <Link key={assignment.id} to="/student/assignments" className="homework-brief"><span className={`homework-brief__icon ${assignment.status === "returned" ? "is-returned" : ""}`}><BookOpen size={18} /></span><span><strong>{assignment.title}</strong><small>{assignment.dueAt ? `До ${formatDateTime(assignment.dueAt)}` : "Без срока"}</small></span><ArrowRight size={17} /></Link>)}</div> : <EmptyState title="Всё выполнено" description="Сейчас нет заданий, которые требуют ответа." />}</section><section className="student-progress-panel"><span className="student-progress-panel__icon"><CheckCircle2 size={22} /></span><div><h2>Проверено заданий</h2><strong>{resource.data.assignments.filter((assignment) => assignment.status === "reviewed").length}</strong></div><Link to="/student/assignments">Посмотреть результаты</Link></section></div>}</div>;
}

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, ClipboardCheck, Clock3, RotateCcw, Send } from "lucide-react";
import type { AssignmentSummary } from "../../../shared/types";
import { api } from "../../api";
import { Button, EmptyState, ErrorState, FormField, LoadingBlock, Modal, Notice, PageHeader, StatusBadge, formatDateTime, useAsyncData } from "../../components/UI";

export function StudentAssignmentsPage() {
  const resource = useAsyncData(() => api.assignments.list(), []);
  const [filter, setFilter] = useState<"active" | "submitted" | "reviewed" | "all">("active");
  const [selected, setSelected] = useState<AssignmentSummary | null>(null);
  const filtered = useMemo(() => (resource.data ?? []).filter((assignment) => {
    if (filter === "active") return assignment.status === "assigned" || assignment.status === "returned";
    if (filter === "submitted") return assignment.status === "submitted";
    if (filter === "reviewed") return assignment.status === "reviewed";
    return true;
  }), [resource.data, filter]);
  return <div className="page"><PageHeader title="Домашние задания" description="Условия, ответы и комментарии репетитора" /><div className="filter-tabs filter-tabs--standalone" role="group" aria-label="Фильтр заданий"><button className={filter === "active" ? "is-active" : ""} onClick={() => setFilter("active")}>В работе</button><button className={filter === "submitted" ? "is-active" : ""} onClick={() => setFilter("submitted")}>На проверке</button><button className={filter === "reviewed" ? "is-active" : ""} onClick={() => setFilter("reviewed")}>Проверено</button><button className={filter === "all" ? "is-active" : ""} onClick={() => setFilter("all")}>Все</button></div>{resource.loading && <LoadingBlock label="Загружаем задания" />}{resource.error && <ErrorState message={resource.error} onRetry={resource.reload} />}{resource.data && !filtered.length && <EmptyState title="В этом разделе пока пусто" />}{filtered.length > 0 && <div className="student-assignment-grid">{filtered.map((assignment) => <article className="student-assignment-card" key={assignment.id}><div className="student-assignment-card__top"><span className="assignment-card__icon"><ClipboardCheck size={20} /></span><StatusBadge status={assignment.status} /></div><h2>{assignment.title}</h2><p>{assignment.description}</p><div className="student-assignment-card__bottom"><span><Clock3 size={15} /> {assignment.dueAt ? `до ${formatDateTime(assignment.dueAt)}` : "без срока"}</span><Button variant={assignment.status === "assigned" || assignment.status === "returned" ? "primary" : "secondary"} size="small" onClick={() => setSelected(assignment)}>{assignment.status === "assigned" ? "Выполнить" : assignment.status === "returned" ? "Исправить" : "Открыть"}</Button></div></article>)}</div>}<AssignmentDialog assignment={selected} onClose={() => setSelected(null)} onSaved={resource.reload} /></div>;
}

function AssignmentDialog({ assignment, onClose, onSaved }: { assignment: AssignmentSummary | null; onClose: () => void; onSaved: () => void }) {
  const [answer, setAnswer] = useState(assignment?.answer ?? ""); const [error, setError] = useState<string | null>(null); const [loading, setLoading] = useState(false);
  useEffect(() => { setAnswer(assignment?.answer ?? ""); setError(null); }, [assignment]);
  const editable = assignment?.status === "assigned" || assignment?.status === "returned";
  const close = () => { setAnswer(""); setError(null); onClose(); };
  const submit = async () => { if (!assignment) return; setLoading(true); setError(null); try { await api.assignments.submit(assignment.id, answer.trim()); onSaved(); close(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось отправить ответ"); } finally { setLoading(false); } };
  return <Modal open={Boolean(assignment)} title={assignment?.title ?? "Задание"} onClose={close} width="large"><div className="assignment-dialog"><div className="assignment-condition"><span>Условие</span><p>{assignment?.description}</p></div>{assignment?.status === "returned" && assignment.feedback && <Notice type="info"><strong>Комментарий репетитора</strong><br />{assignment.feedback}</Notice>}{assignment?.status === "reviewed" && <Notice type="success"><CheckCircle2 size={16} /> {assignment.feedback || "Задание проверено"}</Notice>}<FormField label="Ваш ответ"><textarea rows={8} value={answer} onChange={(event) => setAnswer(event.target.value)} readOnly={!editable} placeholder="Введите решение или ответ" /></FormField>{error && <Notice type="error">{error}</Notice>}<div className="modal-actions">{editable ? <><Button variant="secondary" onClick={close}>Закрыть</Button><Button icon={assignment?.status === "returned" ? <RotateCcw size={17} /> : <Send size={17} />} disabled={loading || !answer.trim()} onClick={() => void submit()}>{loading ? "Отправляем…" : "Отправить на проверку"}</Button></> : <Button onClick={close}>Закрыть</Button>}</div></div></Modal>;
}

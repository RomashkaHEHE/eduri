import { useEffect, useMemo, useState, type FormEvent } from "react";
import { CheckCheck, ClipboardCheck, MessageSquare, Plus, Search } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import type { AssignmentSummary, MaterialSummary, StudentSummary } from "../../../shared/types";
import { api } from "../../api";
import { Button, EmptyState, ErrorState, FormField, LoadingBlock, Modal, Notice, PageHeader, StatusBadge, formatDateTime, useAsyncData } from "../../components/UI";

interface AssignmentsData {
  assignments: AssignmentSummary[];
  students: StudentSummary[];
  selectedMaterial: MaterialSummary | null;
}
const assignmentFilters: Array<{ value: AssignmentSummary["status"] | "all"; label: string }> = [
  { value: "all", label: "Все" }, { value: "submitted", label: "На проверке" }, { value: "assigned", label: "Назначено" }, { value: "returned", label: "Возвращено" }, { value: "reviewed", label: "Проверено" },
];

export function TutorAssignmentsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedMaterialId = searchParams.get("create") === "assignment" ? searchParams.get("materialId") : null;
  const resource = useAsyncData<AssignmentsData>(async () => {
    const [assignments, students, selectedMaterial] = await Promise.all([
      api.assignments.list(),
      api.students.list(),
      selectedMaterialId ? api.materials.get(selectedMaterialId) : Promise.resolve(null),
    ]);
    return { assignments, students, selectedMaterial };
  }, [selectedMaterialId]);
  const [filter, setFilter] = useState<AssignmentSummary["status"] | "all">("all");
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [reviewing, setReviewing] = useState<AssignmentSummary | null>(null);
  useEffect(() => {
    if (selectedMaterialId) setCreateOpen(true);
  }, [selectedMaterialId]);

  const closeCreate = () => {
    setCreateOpen(false);
    if (searchParams.get("create") !== "assignment") return;
    const next = new URLSearchParams(searchParams);
    next.delete("create");
    next.delete("materialId");
    setSearchParams(next, { replace: true });
  };
  const filtered = useMemo(() => (resource.data?.assignments ?? []).filter((assignment) => {
    const query = search.trim().toLocaleLowerCase("ru");
    return (filter === "all" || assignment.status === filter) && (!query || `${assignment.title} ${assignment.studentName}`.toLocaleLowerCase("ru").includes(query));
  }), [resource.data, filter, search]);

  return <div className="page"><PageHeader title="Домашние задания" description="Назначение, ответы и обратная связь" actions={<Button icon={<Plus size={18} />} onClick={() => setCreateOpen(true)}>Новое задание</Button>} /><div className="toolbar toolbar--wrap"><label className="search-field"><Search size={18} /><span className="sr-only">Поиск заданий</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Задание или ученик" /></label><div className="filter-tabs" role="group" aria-label="Статус задания">{assignmentFilters.map((item) => <button key={item.value} className={filter === item.value ? "is-active" : ""} onClick={() => setFilter(item.value)}>{item.label}{item.value === "submitted" && resource.data ? <span>{resource.data.assignments.filter((assignment) => assignment.status === "submitted").length}</span> : null}</button>)}</div></div>{resource.loading && <LoadingBlock label="Загружаем задания" />}{resource.error && <ErrorState message={resource.error} onRetry={resource.reload} />}{resource.data && !filtered.length && <EmptyState title="Заданий не найдено" description="Создайте новое задание или измените фильтры." action={<Button variant="secondary" onClick={() => setCreateOpen(true)}>Создать задание</Button>} />}{filtered.length > 0 && <div className="assignment-list">{filtered.map((assignment) => <article className="assignment-card" key={assignment.id}><div className="assignment-card__icon"><ClipboardCheck size={20} /></div><div className="assignment-card__main"><div><h2>{assignment.title}</h2><StatusBadge status={assignment.status} /></div><p>{assignment.description}</p><span>{assignment.studentName} · {assignment.dueAt ? `до ${formatDateTime(assignment.dueAt)}` : "без срока"}</span></div><div className="assignment-card__action">{assignment.status === "submitted" ? <Button size="small" icon={<MessageSquare size={16} />} onClick={() => setReviewing(assignment)}>Проверить</Button> : assignment.status === "reviewed" ? <CheckCheck size={20} className="success-icon" /> : null}</div></article>)}</div>}<CreateAssignmentModal key={resource.data?.selectedMaterial?.id ?? "blank"} open={createOpen && !resource.loading && Boolean(resource.data)} students={resource.data?.students ?? []} initialMaterial={resource.data?.selectedMaterial} onClose={closeCreate} onCreated={resource.reload} /><ReviewAssignmentModal assignment={reviewing} onClose={() => setReviewing(null)} onSaved={resource.reload} /></div>;
}

function defaultAssignmentDescription(material?: MaterialSummary | null) {
  if (!material) return "";
  return material.body?.trim() || material.url || `Изучить материал «${material.title}».`;
}

function CreateAssignmentModal({ open, students, initialMaterial, onClose, onCreated }: { open: boolean; students: StudentSummary[]; initialMaterial?: MaterialSummary | null; onClose: () => void; onCreated: () => void }) {
  const [studentId, setStudentId] = useState(""); const [title, setTitle] = useState(initialMaterial?.title ?? ""); const [description, setDescription] = useState(defaultAssignmentDescription(initialMaterial)); const [dueAt, setDueAt] = useState(""); const [error, setError] = useState<string | null>(null); const [loading, setLoading] = useState(false);
  const close = () => { setStudentId(""); setTitle(""); setDescription(""); setDueAt(""); setError(null); onClose(); };
  const submit = async (event: FormEvent) => { event.preventDefault(); setLoading(true); setError(null); try { await api.assignments.create({ studentId, title: title.trim(), description: description.trim(), dueAt: dueAt ? new Date(dueAt).toISOString() : null, materialIds: initialMaterial ? [initialMaterial.id] : [] }); onCreated(); close(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось создать задание"); } finally { setLoading(false); } };
  return <Modal open={open} title="Новое домашнее задание" onClose={close} width="large"><form className="form-stack" onSubmit={submit}>{initialMaterial && <Notice type="info"><strong>Прикреплён материал:</strong> {initialMaterial.title}</Notice>}<div className="form-row"><FormField label="Ученик"><select value={studentId} onChange={(event) => setStudentId(event.target.value)} required><option value="">Выберите ученика</option>{students.map((student) => <option value={student.id} key={student.id}>{student.displayName}</option>)}</select></FormField><FormField label="Срок"><input type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} /></FormField></div><FormField label="Название"><input value={title} onChange={(event) => setTitle(event.target.value)} required /></FormField><FormField label="Задание"><textarea rows={8} value={description} onChange={(event) => setDescription(event.target.value)} required /></FormField>{error && <Notice type="error">{error}</Notice>}<div className="modal-actions"><Button type="button" variant="secondary" onClick={close}>Отмена</Button><Button type="submit" disabled={loading || !studentId || !title.trim() || !description.trim()}>{loading ? "Назначаем…" : "Назначить"}</Button></div></form></Modal>;
}

function ReviewAssignmentModal({ assignment, onClose, onSaved }: { assignment: AssignmentSummary | null; onClose: () => void; onSaved: () => void }) {
  const [feedback, setFeedback] = useState(""); const [error, setError] = useState<string | null>(null); const [loading, setLoading] = useState(false);
  const save = async (status: "reviewed" | "returned") => { if (!assignment) return; setLoading(true); setError(null); try { await api.assignments.review(assignment.id, status, feedback.trim()); onSaved(); setFeedback(""); onClose(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось сохранить проверку"); } finally { setLoading(false); } };
  return <Modal open={Boolean(assignment)} title={assignment?.title ?? "Проверка"} description={assignment ? `Ответ ученика ${assignment.studentName}` : undefined} onClose={onClose} width="large"><div className="form-stack"><div className="submitted-answer"><span>Ответ ученика</span><p>{assignment?.answer || "Ответ не содержит текста"}</p></div><FormField label="Комментарий"><textarea rows={5} value={feedback} onChange={(event) => setFeedback(event.target.value)} /></FormField>{error && <Notice type="error">{error}</Notice>}<div className="modal-actions modal-actions--split"><Button variant="secondary" disabled={loading} onClick={() => void save("returned")}>Вернуть на доработку</Button><Button disabled={loading} icon={<CheckCheck size={17} />} onClick={() => void save("reviewed")}>{loading ? "Сохраняем…" : "Принять"}</Button></div></div></Modal>;
}

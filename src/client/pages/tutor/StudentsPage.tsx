import { useMemo, useState, type FormEvent } from "react";
import { Copy, MoreHorizontal, Plus, Search, Send, UserPlus, Users } from "lucide-react";
import { Link } from "react-router-dom";
import type { StudentSummary } from "../../../shared/types";
import { api, type CreateStudentResult } from "../../api";
import {
  Button,
  EmptyState,
  ErrorState,
  FormField,
  IconButton,
  LoadingBlock,
  Modal,
  Notice,
  PageHeader,
  StatusBadge,
  formatDateTime,
  initials,
  useAsyncData,
} from "../../components/UI";

function invitationLink(result: { inviteUrl?: string; inviteToken?: string }) {
  if (result.inviteUrl) return new URL(result.inviteUrl, window.location.origin).toString();
  if (result.inviteToken) return `${window.location.origin}/activate#token=${encodeURIComponent(result.inviteToken)}`;
  return "";
}
export function StudentsPage() {
  const resource = useAsyncData(() => api.students.list(), []);
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [inviteStudent, setInviteStudent] = useState<StudentSummary | null>(null);
  const filtered = useMemo(() => {
    const value = search.trim().toLocaleLowerCase("ru");
    if (!value) return resource.data ?? [];
    return (resource.data ?? []).filter((student) => `${student.displayName} ${student.loginName}`.toLocaleLowerCase("ru").includes(value));
  }, [resource.data, search]);

  return (
    <div className="page">
      <PageHeader title="Ученики" description="Карточки, прогресс и история занятий" actions={<Button icon={<UserPlus size={18} />} onClick={() => setCreateOpen(true)}>Добавить ученика</Button>} />
      <div className="toolbar">
        <label className="search-field"><Search size={18} /><span className="sr-only">Поиск учеников</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Найти по имени" /></label>
        <span className="toolbar__count"><Users size={17} /> {filtered.length}</span>
      </div>
      {resource.loading && <LoadingBlock label="Загружаем учеников" />}
      {resource.error && <ErrorState message={resource.error} onRetry={resource.reload} />}
      {resource.data && !filtered.length && <EmptyState title={search ? "Ничего не найдено" : "Учеников пока нет"} description={search ? "Попробуйте изменить запрос." : "Создайте аккаунт ученика и отправьте ему приглашение."} action={!search && <Button variant="secondary" icon={<Plus size={17} />} onClick={() => setCreateOpen(true)}>Создать ученика</Button>} />}
      {filtered.length > 0 && (
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>Ученик</th><th>Статус</th><th>Следующий урок</th><th>Последний урок</th><th>Домашние</th><th><span className="sr-only">Действия</span></th></tr></thead>
            <tbody>{filtered.map((student) => (
              <tr key={student.id}>
                <td data-label="Ученик"><Link className="person-cell" to={`/tutor/students/${student.id}`}><span className="avatar avatar--small">{initials(student.displayName)}</span><span><strong>{student.displayName}</strong><small>{student.loginName}</small></span></Link></td>
                <td data-label="Статус"><StatusBadge status={student.status} /></td>
                <td data-label="Следующий урок">{formatDateTime(student.nextLessonAt)}</td>
                <td data-label="Последний урок">{formatDateTime(student.lastLessonAt)}</td>
                <td data-label="Домашние"><span className={student.pendingAssignments ? "count-badge" : "muted"}>{student.pendingAssignments || "—"}</span></td>
                <td className="table-actions"><Button variant="ghost" size="small" icon={<Send size={16} />} onClick={() => setInviteStudent(student)}>Пригласить</Button><IconButton label={`Действия: ${student.displayName}`}><MoreHorizontal size={19} /></IconButton></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <CreateStudentModal open={createOpen} onClose={() => setCreateOpen(false)} onCreated={resource.reload} />
      <InviteStudentModal student={inviteStudent} onClose={() => setInviteStudent(null)} />
    </div>
  );
}

function CreateStudentModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [displayName, setDisplayName] = useState("");
  const [loginName, setLoginName] = useState("");
  const [note, setNote] = useState("");
  const [result, setResult] = useState<CreateStudentResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const link = result ? invitationLink(result) : "";

  const close = () => {
    setDisplayName(""); setLoginName(""); setNote(""); setResult(null); setError(null); onClose();
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setSubmitting(true); setError(null);
    try {
      const created = await api.students.create({ displayName: displayName.trim(), loginName: loginName.trim() || undefined, note: note.trim() || undefined });
      setResult(created); onCreated();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось создать ученика");
    } finally { setSubmitting(false); }
  };

  return <Modal open={open} title={result ? "Ученик создан" : "Новый ученик"} description={result ? "Отправьте персональную ссылку ученику." : "После создания вы получите одноразовую ссылку."} onClose={close}>
    {result ? <div className="form-stack"><div className="invite-result"><span className="avatar">{initials(result.student.displayName)}</span><div><strong>{result.student.displayName}</strong><span>{result.student.loginName}</span></div></div>{link ? <><FormField label="Пригласительная ссылка"><div className="copy-field"><input value={link} readOnly /><IconButton label="Скопировать ссылку" onClick={() => void navigator.clipboard.writeText(link)}><Copy size={18} /></IconButton></div></FormField><Notice type="info">Ссылка одноразовая. После активации ученик будет входить по имени и кодовому слову.</Notice></> : <Notice type="info">Аккаунт создан. Ссылку можно выпустить из списка учеников.</Notice>}<div className="modal-actions"><Button onClick={close}>Готово</Button></div></div> :
      <form className="form-stack" onSubmit={submit}><FormField label="Имя ученика"><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} required autoFocus /></FormField><FormField label="Имя для входа" hint="Можно оставить пустым — оно будет создано автоматически."><input value={loginName} onChange={(event) => setLoginName(event.target.value)} /></FormField><FormField label="Внутренняя заметка"><textarea rows={3} value={note} onChange={(event) => setNote(event.target.value)} /></FormField>{error && <Notice type="error">{error}</Notice>}<div className="modal-actions"><Button type="button" variant="secondary" onClick={close}>Отмена</Button><Button type="submit" disabled={submitting || !displayName.trim()}>{submitting ? "Создаём…" : "Создать"}</Button></div></form>}
  </Modal>;
}

function InviteStudentModal({ student, onClose }: { student: StudentSummary | null; onClose: () => void }) {
  const [link, setLink] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const createInvite = async () => {
    if (!student) return;
    setLoading(true); setError(null);
    try { setLink(invitationLink(await api.students.invite(student.id))); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось создать приглашение"); }
    finally { setLoading(false); }
  };
  return <Modal open={Boolean(student)} title={`Приглашение · ${student?.displayName ?? ""}`} onClose={() => { setLink(""); setError(null); onClose(); }}>
    <div className="form-stack">{link ? <FormField label="Пригласительная ссылка"><div className="copy-field"><input value={link} readOnly /><IconButton label="Скопировать ссылку" onClick={() => void navigator.clipboard.writeText(link)}><Copy size={18} /></IconButton></div></FormField> : <p className="modal-copy">Новая ссылка отменит предыдущее неиспользованное приглашение.</p>}{error && <Notice type="error">{error}</Notice>}<div className="modal-actions"><Button variant="secondary" onClick={onClose}>Закрыть</Button>{!link && <Button onClick={() => void createInvite()} disabled={loading}>{loading ? "Создаём…" : "Создать ссылку"}</Button>}</div></div>
  </Modal>;
}

import { useMemo, useState, type FormEvent } from "react";
import { BookOpen, ExternalLink, FileText, Link2, Plus, Search, Tags, Wrench } from "lucide-react";
import { useNavigate } from "react-router-dom";
import type { MaterialSummary } from "../../../shared/types";
import { api } from "../../api";
import { Button, EmptyState, ErrorState, FormField, LoadingBlock, Modal, Notice, PageHeader, formatDateTime, useAsyncData } from "../../components/UI";

const materialKinds: Array<{ value: MaterialSummary["kind"] | "all"; label: string }> = [
  { value: "all", label: "Все" },
  { value: "note", label: "Конспекты" },
  { value: "task", label: "Задачи" },
  { value: "link", label: "Ссылки" },
  { value: "file", label: "Файлы" },
];

function KindIcon({ kind, size = 18 }: { kind: MaterialSummary["kind"]; size?: number }) {
  if (kind === "link") return <Link2 size={size} />;
  if (kind === "file") return <FileText size={size} />;
  if (kind === "task") return <Wrench size={size} />;
  return <BookOpen size={size} />;
}

const kindNames: Record<MaterialSummary["kind"], string> = { note: "Конспект", task: "Задача", link: "Ссылка", file: "Файл" };

export function MaterialsPage() {
  const navigate = useNavigate();
  const resource = useAsyncData(() => api.materials.list(), []);
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<MaterialSummary["kind"] | "all">("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("ru");
    return (resource.data ?? []).filter((material) => {
      const matchesKind = kind === "all" || material.kind === kind;
      const matchesQuery = !query || `${material.title} ${material.body ?? ""} ${material.tags.join(" ")}`.toLocaleLowerCase("ru").includes(query);
      return matchesKind && matchesQuery;
    });
  }, [resource.data, search, kind]);
  const selected = filtered.find((material) => material.id === selectedId) ?? filtered[0] ?? null;

  return (
    <div className="page page--wide">
      <PageHeader title="Материалы" description="Задачи, конспекты, ссылки и файлы" actions={<Button icon={<Plus size={18} />} onClick={() => setCreateOpen(true)}>Добавить материал</Button>} />
      <div className="toolbar toolbar--wrap"><label className="search-field"><Search size={18} /><span className="sr-only">Поиск материалов</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Название, текст или тег" /></label><div className="filter-tabs" role="group" aria-label="Тип материала">{materialKinds.map((item) => <button key={item.value} className={kind === item.value ? "is-active" : ""} onClick={() => setKind(item.value)}>{item.label}</button>)}</div></div>
      {resource.loading && <LoadingBlock label="Загружаем материалы" />}
      {resource.error && <ErrorState message={resource.error} onRetry={resource.reload} />}
      {resource.data && !filtered.length && <EmptyState title={search || kind !== "all" ? "Материалы не найдены" : "Библиотека пуста"} description={search || kind !== "all" ? "Измените фильтр или поисковый запрос." : "Добавьте первую задачу, конспект или ссылку."} action={!search && kind === "all" && <Button variant="secondary" onClick={() => setCreateOpen(true)}>Добавить материал</Button>} />}
      {filtered.length > 0 && <div className="library-layout"><div className="material-list" role="listbox" aria-label="Материалы">{filtered.map((material) => <button role="option" aria-selected={selected?.id === material.id} key={material.id} className={`material-row ${selected?.id === material.id ? "material-row--selected" : ""}`} onClick={() => setSelectedId(material.id)}><span className={`material-kind material-kind--${material.kind}`}><KindIcon kind={material.kind} /></span><span className="material-row__content"><strong>{material.title}</strong><small>{kindNames[material.kind]} · {formatDateTime(material.createdAt, { day: "numeric", month: "short" })}</small><span className="tag-line">{material.tags.slice(0, 3).map((tag) => <em key={tag}>#{tag}</em>)}</span></span></button>)}</div><aside className="material-preview">{selected && <><div className="material-preview__head"><span className={`material-kind material-kind--${selected.kind}`}><KindIcon kind={selected.kind} /></span><span>{kindNames[selected.kind]}</span>{selected.url && <a href={selected.url} target="_blank" rel="noreferrer" aria-label="Открыть источник"><ExternalLink size={18} /></a>}</div><h2>{selected.title}</h2>{selected.body && <div className="material-body">{selected.body}</div>}{selected.url && <a className="source-link" href={selected.url} target="_blank" rel="noreferrer"><Link2 size={16} /> {selected.url}</a>}{selected.fileName && <div className="file-chip"><FileText size={17} /><span>{selected.fileName}</span></div>}{selected.tags.length > 0 && <div className="preview-tags"><Tags size={16} />{selected.tags.map((tag) => <span key={tag}>#{tag}</span>)}</div>}<div className="material-preview__actions"><Button variant="secondary" onClick={() => navigate(`/tutor?create=lesson&materialId=${encodeURIComponent(selected.id)}`)}>Добавить в урок</Button><Button onClick={() => navigate(`/tutor/assignments?create=assignment&materialId=${encodeURIComponent(selected.id)}`)}>В домашнее</Button></div></>}</aside></div>}
      <CreateMaterialModal open={createOpen} onClose={() => setCreateOpen(false)} onCreated={resource.reload} />
    </div>
  );
}

function CreateMaterialModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [kind, setKind] = useState<MaterialSummary["kind"]>("task");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [url, setUrl] = useState("");
  const [tags, setTags] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => { setKind("task"); setTitle(""); setBody(""); setUrl(""); setTags(""); setFile(null); setError(null); onClose(); };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setSubmitting(true); setError(null);
    try {
      const normalizedTags = tags.split(",").map((tag) => tag.trim().replace(/^#/, "")).filter(Boolean);
      if (kind === "file") {
        const form = new FormData();
        form.set("title", title.trim()); form.set("kind", kind); form.set("tags", JSON.stringify(normalizedTags));
        if (file) form.set("file", file);
        await api.materials.create(form);
      } else {
        await api.materials.create({ title: title.trim(), kind, body: body.trim() || undefined, url: url.trim() || undefined, tags: normalizedTags });
      }
      onCreated(); close();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось добавить материал"); }
    finally { setSubmitting(false); }
  };
  return <Modal open={open} title="Новый материал" onClose={close} width="large"><form className="form-stack" onSubmit={submit}><div className="form-row"><FormField label="Тип"><select value={kind} onChange={(event) => { setKind(event.target.value as MaterialSummary["kind"]); setFile(null); }}><option value="task">Задача</option><option value="note">Конспект</option><option value="link">Ссылка</option><option value="file">Файл</option></select></FormField><FormField label="Название"><input value={title} onChange={(event) => setTitle(event.target.value)} required autoFocus /></FormField></div>{kind !== "link" && kind !== "file" && <FormField label={kind === "task" ? "Условие задачи" : "Текст конспекта"}><textarea rows={8} value={body} onChange={(event) => setBody(event.target.value)} required /></FormField>}{kind === "file" ? <FormField label="Файл" hint="До 25 МБ"><input type="file" onChange={(event) => setFile(event.target.files?.[0] ?? null)} required /></FormField> : <FormField label={kind === "task" ? "Источник или разбор (необязательно)" : "Ссылка"}><input type="url" value={url} onChange={(event) => setUrl(event.target.value)} required={kind === "link"} placeholder="https://" /></FormField>}<FormField label="Теги" hint="Разделяйте запятыми"><input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="ЕГЭ, параметры, алгебра" /></FormField>{error && <Notice type="error">{error}</Notice>}<div className="modal-actions"><Button type="button" variant="secondary" onClick={close}>Отмена</Button><Button type="submit" disabled={submitting || !title.trim() || (kind === "file" && !file)}>{submitting ? "Добавляем…" : "Добавить"}</Button></div></form></Modal>;
}

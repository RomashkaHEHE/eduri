import { useMemo, useState } from "react";
import { BookOpen, ExternalLink, FileText, Link2, Search, Wrench } from "lucide-react";
import type { MaterialSummary } from "../../../shared/types";
import { api } from "../../api";
import { EmptyState, ErrorState, LoadingBlock, PageHeader, useAsyncData } from "../../components/UI";

function iconFor(kind: MaterialSummary["kind"]) {
  if (kind === "link") return <Link2 size={20} />;
  if (kind === "file") return <FileText size={20} />;
  if (kind === "task") return <Wrench size={20} />;
  return <BookOpen size={20} />;
}
const labels: Record<MaterialSummary["kind"], string> = {
  note: "Конспект",
  task: "Задача",
  link: "Ссылка",
  file: "Файл",
};

function progressText(status?: "assigned" | "covered" | "completed") {
  if (status === "completed") return "Выполнено";
  if (status === "covered") return "Разобрано";
  return "Назначено";
}

export function StudentMaterialsPage() {
  const resource = useAsyncData(() => api.materials.list(), []);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<(NonNullable<typeof resource.data>)[number] | null>(null);
  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("ru");
    return (resource.data ?? []).filter((material) =>
      !query || `${material.title} ${material.body ?? ""} ${material.tags.join(" ")}`.toLocaleLowerCase("ru").includes(query),
    );
  }, [resource.data, search]);

  return (
    <div className="page">
      <PageHeader title="Материалы" description="Конспекты и задачи от репетитора" />
      <div className="toolbar">
        <label className="search-field"><Search size={18} /><span className="sr-only">Поиск материалов</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Найти материал" /></label>
      </div>
      {resource.loading && <LoadingBlock label="Загружаем материалы" />}
      {resource.error && <ErrorState message={resource.error} onRetry={resource.reload} />}
      {resource.data && !filtered.length && <EmptyState title="Материалов пока нет" />}
      {filtered.length > 0 && <div className="student-material-grid">{filtered.map((material) => (
        <button className="student-material-card" key={material.id} onClick={() => setSelected(material)}>
          <span className={`material-kind material-kind--${material.kind}`}>{iconFor(material.kind)}</span>
          <span className="student-material-card__content">
            <small>{labels[material.kind]}</small><strong>{material.title}</strong>
            <span>{material.body || material.url || material.fileName || "Открыть материал"}</span>
            <em className={`progress-tag progress-tag--${material.progressStatus ?? "assigned"}`}>{progressText(material.progressStatus)}</em>
          </span>
          {material.url && <ExternalLink size={17} />}
        </button>
      ))}</div>}
      {selected && <div className="mobile-material-overlay">
        <button className="sidebar-backdrop" aria-label="Закрыть материал" onClick={() => setSelected(null)} />
        <aside className="student-material-detail">
          <button className="detail-close" onClick={() => setSelected(null)}>Закрыть</button>
          <span className={`material-kind material-kind--${selected.kind}`}>{iconFor(selected.kind)}</span>
          <small>{labels[selected.kind]}</small><h2>{selected.title}</h2>
          <span className={`progress-tag progress-tag--${selected.progressStatus ?? "assigned"}`}>{progressText(selected.progressStatus)}</span>
          {selected.body && <div className="material-body">{selected.body}</div>}
          {selected.url && <a className="source-link" href={selected.url} target="_blank" rel="noreferrer"><ExternalLink size={16} /> Открыть источник</a>}
          {selected.kind === "file" && <a className="source-link" href={`/api/materials/${selected.id}/file`}><FileText size={16} /> Скачать файл</a>}
        </aside>
      </div>}
    </div>
  );
}

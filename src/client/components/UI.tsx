import {
  useEffect,
  useId,
  useRef,
  useState,
  type DependencyList,
  type PropsWithChildren,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { AlertCircle, Inbox, LoaderCircle, X } from "lucide-react";
import type { AccountStatus, AssignmentSummary, LessonSummary } from "../../shared/types";

export function Button({
  variant = "primary",
  size = "medium",
  icon,
  children,
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "small" | "medium" | "icon";
  icon?: ReactNode;
}) {
  return (
    <button className={`button button--${variant} button--${size} ${className}`} {...props}>
      {icon}
      {children}
    </button>
  );
}

export function IconButton({ label, children, className = "", ...props }: PropsWithChildren<{
  label: string;
  className?: string;
}> & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button className={`icon-button ${className}`} aria-label={label} title={label} {...props}>
      {children}
    </button>
  );
}

export function Modal({
  open,
  title,
  description,
  children,
  onClose,
  width = "medium",
  dismissible = true,
}: PropsWithChildren<{
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  width?: "small" | "medium" | "large";
  dismissible?: boolean;
}>) {
  const headingId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    document.body.classList.add("modal-open");
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && dismissible) onCloseRef.current();
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    const focusTimer = window.setTimeout(() => {
      const dialog = dialogRef.current;
      const body = dialog?.querySelector<HTMLElement>(".modal__body");
      const preferred = body?.querySelector<HTMLElement>("[autofocus]")
        ?? body?.querySelector<HTMLElement>(
          'input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        )
        ?? dialog?.querySelector<HTMLElement>(
          'button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
      preferred?.focus();
    }, 0);
    return () => {
      window.clearTimeout(focusTimer);
      document.body.classList.remove("modal-open");
      document.removeEventListener("keydown", onKeyDown);
      previous?.focus();
    };
  }, [dismissible, open]);

  if (!open) return null;
  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (dismissible && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={`modal modal--${width}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-describedby={description ? descriptionId : undefined}
      >
        <div className="modal__header">
          <div>
            <h2 id={headingId}>{title}</h2>
            {description && <p id={descriptionId}>{description}</p>}
          </div>
          {dismissible && (
            <IconButton label="Закрыть" onClick={onClose}>
              <X size={19} />
            </IconButton>
          )}
        </div>
        <div className="modal__body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="page-header__actions">{actions}</div>}
    </header>
  );
}

export function FormField({
  label,
  hint,
  error,
  children,
}: PropsWithChildren<{ label: string; hint?: string; error?: string }>) {
  return (
    <label className={`field ${error ? "field--error" : ""}`}>
      <span className="field__label">{label}</span>
      {children}
      {error ? <span className="field__error">{error}</span> : hint ? <span className="field__hint">{hint}</span> : null}
    </label>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-state__icon"><Inbox size={22} /></span>
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-state" role="alert">
      <AlertCircle size={20} />
      <div><strong>Не удалось загрузить данные</strong><p>{message}</p></div>
      {onRetry && <Button variant="secondary" size="small" onClick={onRetry}>Повторить</Button>}
    </div>
  );
}

export function LoadingBlock({ label = "Загрузка" }: { label?: string }) {
  return (
    <div className="loading-block" role="status">
      <LoaderCircle className="spin" size={22} />
      <span>{label}</span>
    </div>
  );
}

export function Notice({ type = "info", children }: PropsWithChildren<{ type?: "info" | "success" | "error" }>) {
  return <div className={`notice notice--${type}`} role={type === "error" ? "alert" : "status"}>{children}</div>;
}

export function useAsyncData<T>(loader: () => Promise<T>, dependencies: DependencyList = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    loader()
      .then((result) => active && setData(result))
      .catch((reason: unknown) => active && setError(reason instanceof Error ? reason.message : "Неизвестная ошибка"))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
    // The caller controls reload dependencies explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...dependencies, version]);

  return { data, setData, error, loading, reload: () => setVersion((value) => value + 1) };
}

export function formatDateTime(value?: string | null, options?: Intl.DateTimeFormatOptions) {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return new Intl.DateTimeFormat("ru-RU", options ?? {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}

export function initials(name: string) {
  return name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

const statusLabels: Record<string, string> = {
  pending: "Ожидает активации",
  active: "Активен",
  suspended: "Приостановлен",
  scheduled: "Запланирован",
  completed: "Завершён",
  cancelled: "Отменён",
  assigned: "Назначено",
  submitted: "Сдано",
  reviewed: "Проверено",
  returned: "Возвращено",
};

export function StatusBadge({ status }: { status: AccountStatus | LessonSummary["status"] | AssignmentSummary["status"] }) {
  return <span className={`status status--${status}`}>{statusLabels[status] ?? status}</span>;
}

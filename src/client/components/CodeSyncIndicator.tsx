import { Cloud, CloudOff, LoaderCircle } from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

export type CodeSyncConnection =
  | "loading-local"
  | "offline"
  | "connecting"
  | "syncing"
  | "online"
  | "expired"
  | "error";

export type CodeSyncDurability = "ready" | "writing" | "at-risk";

export interface CodeSyncIndicatorProps {
  readonly connection: CodeSyncConnection;
  readonly durability: CodeSyncDurability;
  readonly pendingUpdates: number;
  readonly error?: string | null;
  readonly readOnly?: boolean;
}

type IndicatorState = "online" | "syncing" | "offline" | "error";

type PopupPlacement = "above" | "below";

interface PopupGeometry {
  readonly placement: PopupPlacement;
  readonly maxHeight: number;
  readonly width: number;
  readonly rightOffset: number;
}

const POPUP_GAP = 7;
const POPUP_VIEWPORT_MARGIN = 8;

function connectionLabel(connection: CodeSyncConnection): string {
  switch (connection) {
    case "loading-local":
      return "Загрузка локальных данных";
    case "connecting":
      return "Подключение";
    case "syncing":
      return "Синхронизация";
    case "online":
      return "Подключено";
    case "offline":
      return "Нет соединения";
    case "expired":
      return "Сеанс завершён";
    case "error":
      return "Ошибка синхронизации";
  }
}

function durabilityLabel(durability: CodeSyncDurability): string {
  switch (durability) {
    case "ready":
      return "Сохранено на устройстве";
    case "writing":
      return "Сохраняем на устройстве";
    case "at-risk":
      return "Локальное сохранение недоступно";
  }
}

function indicatorState({
  connection,
  durability,
  pendingUpdates,
  error,
}: CodeSyncIndicatorProps): IndicatorState {
  if (
    error
    || durability === "at-risk"
    || connection === "error"
    || connection === "expired"
  ) {
    return "error";
  }
  if (connection === "offline") return "offline";
  if (
    connection !== "online"
    || durability === "writing"
    || pendingUpdates > 0
  ) {
    return "syncing";
  }
  return "online";
}

function summaryLabel(status: CodeSyncIndicatorProps): string {
  const state = indicatorState(status);
  if (status.durability === "at-risk") {
    return "Локальное сохранение недоступно";
  }
  if (status.connection === "expired") return "Сеанс завершён";
  if (status.error || status.connection === "error") {
    return "Синхронизация недоступна";
  }
  if (state === "online") return "Изменения синхронизированы";
  if (status.connection === "offline") {
    return "Офлайн: изменения сохранены на этом устройстве";
  }
  if (status.connection === "online") return "Сохраняем изменения";
  if (status.connection === "loading-local") return "Загружаем локальные изменения";
  return "Подключаемся к синхронизации";
}

export function CodeSyncIndicator(status: CodeSyncIndicatorProps) {
  const popupId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const lastPointerTypeRef = useRef<string | null>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [popupGeometry, setPopupGeometry] = useState<PopupGeometry | null>(null);
  const state = indicatorState(status);
  const summary = summaryLabel(status);
  const open = !dismissed && (hovered || focused || pinned);
  const pendingLabel = status.pendingUpdates > 99 ? "99+" : String(status.pendingUpdates);
  const terminalAvailable = status.connection === "online"
    && status.durability !== "at-risk"
    && !status.readOnly;
  const popupStyle = popupGeometry ? {
    "--code-sync-popup-max-height": `${popupGeometry.maxHeight}px`,
    "--code-sync-popup-width": `${popupGeometry.width}px`,
    "--code-sync-popup-right-offset": `${popupGeometry.rightOffset}px`,
  } as CSSProperties : undefined;

  useLayoutEffect(() => {
    if (!open) {
      setPopupGeometry(null);
      return;
    }

    const updatePopupGeometry = (): void => {
      const root = rootRef.current;
      const popup = popupRef.current;
      if (!root || !popup) return;

      const visualViewport = window.visualViewport;
      const viewportLeft = visualViewport?.offsetLeft ?? 0;
      const viewportTop = visualViewport?.offsetTop ?? 0;
      const viewportRight = viewportLeft + (visualViewport?.width ?? window.innerWidth);
      const viewportBottom = viewportTop + (visualViewport?.height ?? window.innerHeight);
      const workspace = root.closest<HTMLElement>(".full-code-workspace");
      const workspaceRect = workspace?.getBoundingClientRect();
      const clipLeft = Math.max(viewportLeft, workspaceRect?.left ?? viewportLeft);
      const clipTop = Math.max(viewportTop, workspaceRect?.top ?? viewportTop);
      const clipRight = Math.min(viewportRight, workspaceRect?.right ?? viewportRight);
      const clipBottom = Math.min(viewportBottom, workspaceRect?.bottom ?? viewportBottom);
      const rootRect = root.getBoundingClientRect();
      const availableAbove = Math.max(
        0,
        rootRect.top - POPUP_GAP - clipTop - POPUP_VIEWPORT_MARGIN,
      );
      const availableBelow = Math.max(
        0,
        clipBottom - rootRect.bottom - POPUP_GAP - POPUP_VIEWPORT_MARGIN,
      );
      const naturalHeight = Math.max(popup.scrollHeight, popup.getBoundingClientRect().height);
      const placement: PopupPlacement = naturalHeight <= availableBelow
        || availableBelow >= availableAbove
        ? "below"
        : "above";
      const maxHeight = Math.floor(
        placement === "below" ? availableBelow : availableAbove,
      );
      const width = Math.max(
        0,
        Math.floor(Math.min(300, clipRight - clipLeft - POPUP_VIEWPORT_MARGIN * 2)),
      );
      const unclampedLeft = rootRect.right - width;
      const minimumLeft = clipLeft + POPUP_VIEWPORT_MARGIN;
      const maximumLeft = clipRight - POPUP_VIEWPORT_MARGIN - width;
      const popupLeft = Math.min(Math.max(unclampedLeft, minimumLeft), maximumLeft);
      const rightOffset = Math.round(rootRect.right - popupLeft - width);

      setPopupGeometry((current) => {
        const next = { placement, maxHeight, width, rightOffset };
        return current?.placement === next.placement
          && current.maxHeight === next.maxHeight
          && current.width === next.width
          && current.rightOffset === next.rightOffset
          ? current
          : next;
      });
    };

    updatePopupGeometry();
    const workspace = rootRef.current?.closest<HTMLElement>(".full-code-workspace");
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(updatePopupGeometry);
    if (rootRef.current) observer?.observe(rootRef.current);
    if (workspace) observer?.observe(workspace);
    if (popupRef.current) observer?.observe(popupRef.current);
    window.addEventListener("resize", updatePopupGeometry);
    window.addEventListener("scroll", updatePopupGeometry, true);
    window.visualViewport?.addEventListener("resize", updatePopupGeometry);
    window.visualViewport?.addEventListener("scroll", updatePopupGeometry);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updatePopupGeometry);
      window.removeEventListener("scroll", updatePopupGeometry, true);
      window.visualViewport?.removeEventListener("resize", updatePopupGeometry);
      window.visualViewport?.removeEventListener("scroll", updatePopupGeometry);
    };
  }, [open]);

  useEffect(() => {
    if (!pinned) return;
    const handleOutsidePointer = (event: PointerEvent): void => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setPinned(false);
      setDismissed(true);
    };
    document.addEventListener("pointerdown", handleOutsidePointer);
    return () => document.removeEventListener("pointerdown", handleOutsidePointer);
  }, [pinned]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    triggerRef.current?.focus({ preventScroll: true });
    setPinned(false);
    setDismissed(true);
  };

  const handlePopupKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    let nextScrollTop: number | null = null;
    switch (event.key) {
      case "ArrowDown":
        nextScrollTop = event.currentTarget.scrollTop + 32;
        break;
      case "ArrowUp":
        nextScrollTop = event.currentTarget.scrollTop - 32;
        break;
      case "PageDown":
        nextScrollTop = event.currentTarget.scrollTop + event.currentTarget.clientHeight;
        break;
      case "PageUp":
        nextScrollTop = event.currentTarget.scrollTop - event.currentTarget.clientHeight;
        break;
      case "Home":
        nextScrollTop = 0;
        break;
      case "End":
        nextScrollTop = event.currentTarget.scrollHeight;
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.scrollTop = nextScrollTop;
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    lastPointerTypeRef.current = event.pointerType || "mouse";
  };

  const handleClick = (): void => {
    if (lastPointerTypeRef.current !== "touch") return;
    if (pinned) {
      setPinned(false);
      setDismissed(true);
    } else {
      setPinned(true);
      setDismissed(false);
    }
  };

  return (
    <div
      ref={rootRef}
      className="code-sync-indicator"
      data-state={state}
      data-popup-placement={open ? popupGeometry?.placement ?? "below" : undefined}
      style={popupStyle}
      onFocus={() => {
        setFocused(true);
        setDismissed(false);
      }}
      onBlur={(event) => {
        if (rootRef.current?.contains(event.relatedTarget)) return;
        setFocused(false);
        setPinned(false);
        setDismissed(false);
      }}
      onKeyDown={handleKeyDown}
      onPointerEnter={(event) => {
        if (event.pointerType === "touch") return;
        setHovered(true);
        setDismissed(false);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === "touch") return;
        setHovered(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="code-sync-indicator__trigger"
        aria-label={`Синхронизация: ${summary}. Показать подробности`}
        aria-expanded={open}
        aria-controls={open ? popupId : undefined}
        aria-describedby={open ? popupId : undefined}
        onPointerDown={handlePointerDown}
        onClick={handleClick}
      >
        {state === "online" ? (
          <Cloud size={16} />
        ) : state === "syncing" ? (
          <LoaderCircle className="spin" size={16} />
        ) : (
          <CloudOff size={16} />
        )}
        {status.pendingUpdates > 0 && (
          <span className="code-sync-indicator__count" aria-hidden="true">
            {pendingLabel}
          </span>
        )}
      </button>

      {open && (
        <div
          ref={popupRef}
          id={popupId}
          className="code-sync-indicator__popup"
          data-placement={popupGeometry?.placement ?? "below"}
          role="tooltip"
          tabIndex={0}
          onKeyDown={handlePopupKeyDown}
        >
          <div className="code-sync-indicator__heading">
            <strong>Синхронизация</strong>
            <span>{summary}</span>
          </div>
          <dl>
            <div>
              <dt>Соединение</dt>
              <dd>{connectionLabel(status.connection)}</dd>
            </div>
            <div>
              <dt>Локальные данные</dt>
              <dd>{durabilityLabel(status.durability)}</dd>
            </div>
            <div>
              <dt>Ожидают подтверждения</dt>
              <dd>{status.pendingUpdates}</dd>
            </div>
            <div>
              <dt>Редактор</dt>
              <dd>{status.readOnly ? "Только чтение" : "Редактирование"}</dd>
            </div>
            <div>
              <dt>Общий терминал</dt>
              <dd>{terminalAvailable ? "Доступен" : "Недоступен"}</dd>
            </div>
          </dl>
          {status.error && (
            <p className="code-sync-indicator__error">{status.error}</p>
          )}
        </div>
      )}

      {status.error && (
        <span className="sr-only" role="alert">{status.error}</span>
      )}
    </div>
  );
}

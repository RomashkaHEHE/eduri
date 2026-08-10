import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Braces,
  Check,
  ChevronDown,
  Circle,
  Diamond,
  Eraser,
  Frame,
  GripVertical,
  ImagePlus,
  LockKeyhole,
  Minus,
  MoreHorizontal,
  MousePointer2,
  MousePointerClick,
  Pencil,
  RotateCcw,
  Settings2,
  Sigma,
  Square,
  Type,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import {
  defaultBoardToolbarPreferences,
  type BoardToolbarItemId,
  type BoardToolbarPreferences,
} from "./toolbarPreferences";
import type { BoardTool } from "./rendering/types";

type BoardShapeTool = "rectangle" | "ellipse" | "diamond" | "frame";

export interface BoardToolbarProps {
  readonly activeTool: BoardTool;
  readonly penLaserActive?: boolean;
  readonly readOnly: boolean;
  readonly imageAvailable: boolean;
  readonly preferences: BoardToolbarPreferences;
  chooseTool(tool: BoardTool): void;
  changePreferences(preferences: BoardToolbarPreferences): void;
}

interface ToolDescriptor {
  readonly tool: BoardTool;
  readonly label: string;
  readonly icon: LucideIcon;
}

interface ToolShortcut {
  readonly letter?: string;
  readonly numeric?: string;
}

const ITEM_DESCRIPTORS: Readonly<Record<
  Exclude<BoardToolbarItemId, "shapes">,
  ToolDescriptor
>> = {
  pen: { tool: "pen", label: "Рисование", icon: Pencil },
  eraser: { tool: "eraser", label: "Ластик", icon: Eraser },
  text: { tool: "text", label: "Текст", icon: Type },
  line: { tool: "line", label: "Линия", icon: Minus },
  arrow: { tool: "arrow", label: "Стрелка", icon: ArrowUpRight },
  code: { tool: "code", label: "Код", icon: Braces },
  latex: { tool: "latex", label: "LaTeX", icon: Sigma },
  image: { tool: "image", label: "Изображение", icon: ImagePlus },
};

const SHAPE_DESCRIPTORS: Readonly<Record<BoardShapeTool, ToolDescriptor>> = {
  rectangle: { tool: "rectangle", label: "Прямоугольник", icon: Square },
  ellipse: { tool: "ellipse", label: "Эллипс", icon: Circle },
  diamond: { tool: "diamond", label: "Ромб", icon: Diamond },
  frame: { tool: "frame", label: "Область", icon: Frame },
};

const SHAPE_TOOLS = Object.freeze([
  "rectangle",
  "ellipse",
  "diamond",
  "frame",
] as const satisfies readonly BoardShapeTool[]);

const TOOL_SHORTCUTS: Readonly<Partial<Record<BoardTool, ToolShortcut>>> = {
  select: { letter: "V", numeric: "1" },
  pen: { letter: "P", numeric: "2" },
  eraser: { letter: "E", numeric: "3" },
  text: { letter: "T", numeric: "4" },
  line: { letter: "L", numeric: "5" },
  arrow: { letter: "A", numeric: "6" },
  rectangle: { letter: "R", numeric: "7" },
  ellipse: { letter: "O", numeric: "8" },
  diamond: { letter: "D", numeric: "9" },
  frame: { letter: "F", numeric: "0" },
};

function isShapeTool(tool: BoardTool): tool is BoardShapeTool {
  return SHAPE_TOOLS.includes(tool as BoardShapeTool);
}

function shortcutLabel(tool: BoardTool): string | undefined {
  const shortcut = TOOL_SHORTCUTS[tool];
  return [shortcut?.letter, shortcut?.numeric]
    .filter((value): value is string => Boolean(value))
    .join(" ") || undefined;
}

function itemIsDisabled(
  itemId: BoardToolbarItemId,
  readOnly: boolean,
  imageAvailable: boolean,
): boolean {
  if (itemId === "image" && !imageAvailable) return true;
  return readOnly && itemId !== "pen";
}

function moveItem(
  preferences: BoardToolbarPreferences,
  itemId: BoardToolbarItemId,
  targetIndex: number,
): BoardToolbarPreferences | null {
  const sourceIndex = preferences.order.indexOf(itemId);
  if (
    sourceIndex < 0
    || !Number.isInteger(targetIndex)
    || targetIndex < 0
    || targetIndex >= preferences.order.length
    || sourceIndex === targetIndex
  ) {
    return null;
  }
  const order = [...preferences.order];
  const [moved] = order.splice(sourceIndex, 1);
  order.splice(targetIndex, 0, moved);
  const visibleSet = new Set(preferences.visible);
  return {
    order,
    visible: order.filter((item) => visibleSet.has(item)),
  };
}

function setItemVisibility(
  preferences: BoardToolbarPreferences,
  itemId: BoardToolbarItemId,
  visible: boolean,
): BoardToolbarPreferences | null {
  const visibleSet = new Set(preferences.visible);
  if (visible === visibleSet.has(itemId)) return null;
  if (visible) visibleSet.add(itemId);
  else visibleSet.delete(itemId);
  return {
    order: [...preferences.order],
    visible: preferences.order.filter((item) => visibleSet.has(item)),
  };
}

function restoreFocus(ref: RefObject<HTMLButtonElement | null>): void {
  queueMicrotask(() => ref.current?.focus({ preventScroll: true }));
}

function menuKeyboardNavigation(
  event: ReactKeyboardEvent<HTMLElement>,
  close: () => void,
): void {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    close();
    return;
  }
  if (event.key === "Tab") {
    close();
    return;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const menu = event.currentTarget;
  const items = [...menu.querySelectorAll<HTMLButtonElement>(
    '[role="menuitem"]:not(:disabled)',
  )];
  if (items.length === 0) return;
  event.preventDefault();
  const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
  const nextIndex = event.key === "Home"
    ? 0
    : event.key === "End"
      ? items.length - 1
      : event.key === "ArrowDown"
        ? (currentIndex + 1 + items.length) % items.length
        : (currentIndex - 1 + items.length) % items.length;
  items[nextIndex].focus({ preventScroll: true });
}

function ShortcutIndicator({ tool }: { readonly tool: BoardTool }) {
  const numeric = TOOL_SHORTCUTS[tool]?.numeric;
  return numeric ? (
    <span className="board-tool__shortcut board-toolbar__shortcut" aria-hidden="true">
      {numeric}
    </span>
  ) : null;
}

function ToolIconButton({
  descriptor,
  active,
  disabled,
  itemId,
  onClick,
}: {
  readonly descriptor: ToolDescriptor;
  readonly active: boolean;
  readonly disabled: boolean;
  readonly itemId: BoardToolbarItemId | "select";
  onClick(): void;
}) {
  const Icon = descriptor.icon;
  const numbered = Boolean(TOOL_SHORTCUTS[descriptor.tool]?.numeric);
  return (
    <button
      type="button"
      className={`board-tool board-toolbar__tool${numbered ? " board-tool--numbered" : ""}${active ? " is-active" : ""}`}
      data-toolbar-item={itemId}
      data-toolbar-tool={descriptor.tool}
      aria-label={descriptor.label}
      aria-keyshortcuts={shortcutLabel(descriptor.tool)}
      aria-pressed={active}
      title={descriptor.label}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon size={19} strokeWidth={1.9} aria-hidden="true" />
      <ShortcutIndicator tool={descriptor.tool} />
    </button>
  );
}

export function BoardToolbar({
  activeTool,
  penLaserActive = false,
  readOnly,
  imageAvailable,
  preferences,
  chooseTool,
  changePreferences,
}: BoardToolbarProps) {
  const [lastShape, setLastShape] = useState<BoardShapeTool>("rectangle");
  const [shapeMenuOpen, setShapeMenuOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [overflowShapesOpen, setOverflowShapesOpen] = useState(false);
  const [configurationOpen, setConfigurationOpen] = useState(false);
  const [draggedItem, setDraggedItem] = useState<BoardToolbarItemId | null>(null);
  const draggedItemRef = useRef<BoardToolbarItemId | null>(null);

  const shapeTriggerRef = useRef<HTMLButtonElement | null>(null);
  const shapeMenuRef = useRef<HTMLDivElement | null>(null);
  const overflowTriggerRef = useRef<HTMLButtonElement | null>(null);
  const overflowMenuRef = useRef<HTMLDivElement | null>(null);
  const configurationDialogRef = useRef<HTMLElement | null>(null);
  const configurationCloseRef = useRef<HTMLButtonElement | null>(null);

  const visibleItems = useMemo(() => {
    const visible = new Set(preferences.visible);
    return preferences.order.filter((item) => visible.has(item));
  }, [preferences]);
  const hiddenItems = useMemo(() => {
    const visible = new Set(preferences.visible);
    return preferences.order.filter((item) => !visible.has(item));
  }, [preferences]);
  const hiddenToolIsActive = hiddenItems.some((itemId) => itemId === "shapes"
    ? isShapeTool(activeTool)
    : ITEM_DESCRIPTORS[itemId].tool === activeTool);

  useEffect(() => {
    if (isShapeTool(activeTool)) setLastShape(activeTool);
  }, [activeTool]);

  const closeShapeMenu = useCallback((focusTrigger = true) => {
    setShapeMenuOpen(false);
    if (focusTrigger) restoreFocus(shapeTriggerRef);
  }, []);

  const closeOverflow = useCallback((focusTrigger = true) => {
    setOverflowOpen(false);
    setOverflowShapesOpen(false);
    if (focusTrigger) restoreFocus(overflowTriggerRef);
  }, []);

  const closeConfiguration = useCallback(() => {
    setConfigurationOpen(false);
    setDraggedItem(null);
    draggedItemRef.current = null;
    restoreFocus(overflowTriggerRef);
  }, []);

  useEffect(() => {
    if (!shapeMenuOpen) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (
        target
        && !shapeMenuRef.current?.contains(target)
        && !shapeTriggerRef.current?.contains(target)
      ) {
        closeShapeMenu();
      }
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [closeShapeMenu, shapeMenuOpen]);

  useEffect(() => {
    if (!overflowOpen) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (
        target
        && !overflowMenuRef.current?.contains(target)
        && !overflowTriggerRef.current?.contains(target)
      ) {
        closeOverflow();
      }
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [closeOverflow, overflowOpen]);

  useEffect(() => {
    if (!configurationOpen) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && !configurationDialogRef.current?.contains(target)) {
        closeConfiguration();
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeConfiguration();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [closeConfiguration, configurationOpen]);

  useLayoutEffect(() => {
    if (shapeMenuOpen) {
      shapeMenuRef.current?.querySelector<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled)',
      )?.focus({ preventScroll: true });
    }
  }, [shapeMenuOpen]);

  useLayoutEffect(() => {
    if (overflowOpen) {
      overflowMenuRef.current?.querySelector<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled)',
      )?.focus({ preventScroll: true });
    }
  }, [overflowOpen]);

  useLayoutEffect(() => {
    if (configurationOpen) {
      configurationCloseRef.current?.focus({ preventScroll: true });
    }
  }, [configurationOpen]);

  const selectShape = (shape: BoardShapeTool, fromOverflow = false) => {
    setLastShape(shape);
    if (fromOverflow) closeOverflow();
    else closeShapeMenu();
    chooseTool(shape);
  };

  const selectItem = (itemId: BoardToolbarItemId, fromOverflow = false) => {
    if (itemId === "shapes") {
      selectShape(lastShape, fromOverflow);
      return;
    }
    if (fromOverflow) closeOverflow();
    chooseTool(ITEM_DESCRIPTORS[itemId].tool);
  };

  const updateVisibility = (itemId: BoardToolbarItemId, visible: boolean) => {
    const next = setItemVisibility(preferences, itemId, visible);
    if (next) changePreferences(next);
  };

  const reorder = (itemId: BoardToolbarItemId, targetIndex: number) => {
    const next = moveItem(preferences, itemId, targetIndex);
    if (next) changePreferences(next);
  };

  const onConfigurationKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab") return;
    const dialog = configurationDialogRef.current;
    if (!dialog) return;
    const focusable = [...dialog.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), [tabindex="0"]',
    )].filter((element) => !element.hasAttribute("hidden"));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable.at(-1) ?? first;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  };

  const onDragStart = (
    event: ReactDragEvent<HTMLElement>,
    itemId: BoardToolbarItemId,
  ) => {
    draggedItemRef.current = itemId;
    setDraggedItem(itemId);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", itemId);
    }
  };

  const onDrop = (
    event: ReactDragEvent<HTMLElement>,
    targetItem: BoardToolbarItemId,
  ) => {
    event.preventDefault();
    const sourceItem = draggedItemRef.current;
    if (sourceItem) reorder(sourceItem, preferences.order.indexOf(targetItem));
    draggedItemRef.current = null;
    setDraggedItem(null);
  };

  const shapeDescriptor = SHAPE_DESCRIPTORS[lastShape];
  const ShapeIcon = shapeDescriptor.icon;
  const descriptorForItem = (
    itemId: Exclude<BoardToolbarItemId, "shapes">,
  ): ToolDescriptor => itemId === "pen" && activeTool === "pen" && penLaserActive
    ? {
        tool: "pen",
        label: "Лазерная указка",
        icon: MousePointerClick,
      }
    : ITEM_DESCRIPTORS[itemId];

  return (
    <>
      <div
        className={`board-v2__toolbar board-toolbar${shapeMenuOpen || overflowOpen ? " is-popup-open" : ""}${overflowOpen ? " board-toolbar--overflow-open" : ""}`}
        role="toolbar"
        aria-label="Инструменты доски"
      >
        <ToolIconButton
          descriptor={{ tool: "select", label: "Выбор", icon: MousePointer2 }}
          active={activeTool === "select"}
          disabled={false}
          itemId="select"
          onClick={() => chooseTool("select")}
        />

        {visibleItems.map((itemId) => itemId === "shapes" ? (
          <div
            key={itemId}
            className="board-toolbar__split-tool"
            data-toolbar-item="shapes"
          >
            <button
              type="button"
              className={`board-tool board-toolbar__tool board-tool--numbered${isShapeTool(activeTool) ? " is-active" : ""}`}
              data-toolbar-tool={lastShape}
              aria-label={shapeDescriptor.label}
              aria-keyshortcuts={shortcutLabel(lastShape)}
              aria-pressed={isShapeTool(activeTool)}
              title={shapeDescriptor.label}
              disabled={itemIsDisabled("shapes", readOnly, imageAvailable)}
              onClick={() => selectShape(lastShape)}
            >
              <ShapeIcon size={19} strokeWidth={1.9} aria-hidden="true" />
              <ShortcutIndicator tool={lastShape} />
            </button>
            <button
              ref={shapeTriggerRef}
              type="button"
              className="board-toolbar__split-trigger"
              aria-label="Выбрать фигуру"
              aria-haspopup="menu"
              aria-expanded={shapeMenuOpen}
              disabled={itemIsDisabled("shapes", readOnly, imageAvailable)}
              onClick={() => {
                setOverflowOpen(false);
                setShapeMenuOpen((open) => !open);
              }}
            >
              <ChevronDown size={13} aria-hidden="true" />
            </button>
            {shapeMenuOpen && (
              <div
                ref={shapeMenuRef}
                className="board-toolbar__menu board-toolbar__shape-menu"
                data-toolbar-menu="shapes"
                role="menu"
                aria-label="Фигуры"
                onKeyDown={(event) => menuKeyboardNavigation(
                  event,
                  () => closeShapeMenu(),
                )}
              >
                {SHAPE_TOOLS.map((shape) => {
                  const descriptor = SHAPE_DESCRIPTORS[shape];
                  const Icon = descriptor.icon;
                  return (
                    <button
                      key={shape}
                      type="button"
                      role="menuitem"
                      data-toolbar-tool={shape}
                      aria-current={lastShape === shape ? "true" : undefined}
                      onClick={() => selectShape(shape)}
                    >
                      <Icon size={17} aria-hidden="true" />
                      <span>{descriptor.label}</span>
                      {lastShape === shape && <Check size={15} aria-hidden="true" />}
                      {TOOL_SHORTCUTS[shape]?.numeric && (
                        <kbd aria-hidden="true">{TOOL_SHORTCUTS[shape]?.numeric}</kbd>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        ) : (
          <ToolIconButton
            key={itemId}
            descriptor={descriptorForItem(itemId)}
            active={activeTool === ITEM_DESCRIPTORS[itemId].tool}
            disabled={itemIsDisabled(itemId, readOnly, imageAvailable)}
            itemId={itemId}
            onClick={() => selectItem(itemId)}
          />
        ))}

        <div className="board-toolbar__overflow">
          <button
            ref={overflowTriggerRef}
            type="button"
            className={`board-toolbar__overflow-trigger${hiddenToolIsActive ? " is-active" : ""}`}
            aria-label="Ещё инструменты"
            aria-haspopup="menu"
            aria-expanded={overflowOpen}
            aria-pressed={hiddenToolIsActive}
            title="Ещё инструменты"
            onClick={() => {
              setShapeMenuOpen(false);
              setOverflowOpen((open) => !open);
            }}
          >
            <MoreHorizontal size={19} aria-hidden="true" />
          </button>

          {overflowOpen && (
            <div
              ref={overflowMenuRef}
              className="board-toolbar__menu board-toolbar__overflow-menu"
              data-toolbar-menu="overflow"
              role="menu"
              aria-label="Дополнительные инструменты"
              onKeyDown={(event) => menuKeyboardNavigation(
                event,
                () => closeOverflow(),
              )}
            >
              {hiddenItems.map((itemId) => itemId === "shapes" ? (
                <div key={itemId} role="none" data-overflow-item="shapes">
                  <button
                    type="button"
                    role="menuitem"
                    data-toolbar-tool={lastShape}
                    aria-current={activeTool === lastShape ? "true" : undefined}
                    disabled={itemIsDisabled(itemId, readOnly, imageAvailable)}
                    onClick={() => selectShape(lastShape, true)}
                  >
                    <ShapeIcon size={17} aria-hidden="true" />
                    <span>{shapeDescriptor.label}</span>
                    {TOOL_SHORTCUTS[lastShape]?.numeric && (
                      <kbd aria-hidden="true">{TOOL_SHORTCUTS[lastShape]?.numeric}</kbd>
                    )}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    aria-haspopup="menu"
                    aria-expanded={overflowShapesOpen}
                    aria-label="Выбрать другую фигуру"
                    disabled={itemIsDisabled(itemId, readOnly, imageAvailable)}
                    onClick={() => setOverflowShapesOpen((open) => !open)}
                  >
                    <ChevronDown size={15} aria-hidden="true" />
                    <span>Другие фигуры</span>
                  </button>
                  {overflowShapesOpen && SHAPE_TOOLS.map((shape) => {
                    const descriptor = SHAPE_DESCRIPTORS[shape];
                    const Icon = descriptor.icon;
                    return (
                      <button
                        key={shape}
                        type="button"
                        role="menuitem"
                        className="board-toolbar__nested-menuitem"
                        data-toolbar-tool={shape}
                        aria-current={activeTool === shape ? "true" : undefined}
                        onClick={() => selectShape(shape, true)}
                      >
                        <Icon size={16} aria-hidden="true" />
                        <span>{descriptor.label}</span>
                        {TOOL_SHORTCUTS[shape]?.numeric && (
                          <kbd aria-hidden="true">{TOOL_SHORTCUTS[shape]?.numeric}</kbd>
                        )}
                      </button>
                    );
                  })}
                </div>
              ) : (() => {
                const descriptor = descriptorForItem(itemId);
                const Icon = descriptor.icon;
                return (
                  <button
                    key={itemId}
                    type="button"
                    role="menuitem"
                    data-overflow-item={itemId}
                    data-toolbar-tool={descriptor.tool}
                    aria-current={activeTool === descriptor.tool ? "true" : undefined}
                    disabled={itemIsDisabled(itemId, readOnly, imageAvailable)}
                    onClick={() => selectItem(itemId, true)}
                  >
                    <Icon size={17} aria-hidden="true" />
                    <span>{descriptor.label}</span>
                    {TOOL_SHORTCUTS[descriptor.tool]?.numeric && (
                      <kbd aria-hidden="true">
                        {TOOL_SHORTCUTS[descriptor.tool]?.numeric}
                      </kbd>
                    )}
                  </button>
                );
              })())}

              <button
                type="button"
                role="menuitem"
                className="board-toolbar__configure"
                data-toolbar-action="configure"
                onClick={() => {
                  closeOverflow(false);
                  setConfigurationOpen(true);
                }}
              >
                <Settings2 size={17} aria-hidden="true" />
                <span>Настроить панель</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {configurationOpen && (
        <div className="board-toolbar-config__backdrop">
          <section
            ref={configurationDialogRef}
            className="board-toolbar-config"
            role="dialog"
            aria-modal="true"
            aria-labelledby="board-toolbar-config-title"
            onKeyDown={onConfigurationKeyDown}
          >
            <header className="board-toolbar-config__header">
              <h2 id="board-toolbar-config-title">Настройка панели</h2>
              <button
                ref={configurationCloseRef}
                type="button"
                aria-label="Закрыть настройку панели"
                onClick={closeConfiguration}
              >
                <X size={18} aria-hidden="true" />
              </button>
            </header>

            <ol className="board-toolbar-config__list" aria-label="Порядок инструментов">
              <li className="board-toolbar-config__item is-locked" data-toolbar-config-item="select">
                <LockKeyhole size={16} aria-hidden="true" />
                <MousePointer2 size={18} aria-hidden="true" />
                <span>Выбор</span>
                <span className="board-toolbar-config__fixed-label">Всегда первый</span>
                <input
                  type="checkbox"
                  checked
                  disabled
                  aria-label="Показывать инструмент Выбор"
                />
              </li>

              {preferences.order.map((itemId, index) => {
                const isShapes = itemId === "shapes";
                const descriptor = isShapes
                  ? { ...shapeDescriptor, label: "Фигуры" }
                  : ITEM_DESCRIPTORS[itemId];
                const Icon = descriptor.icon;
                const visible = preferences.visible.includes(itemId);
                return (
                  <li
                    key={itemId}
                    className={`board-toolbar-config__item${draggedItem === itemId ? " is-dragging" : ""}`}
                    data-toolbar-config-item={itemId}
                    draggable
                    tabIndex={0}
                    aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                    onKeyDown={(event) => {
                      if (!event.altKey) return;
                      if (event.key === "ArrowUp") {
                        event.preventDefault();
                        reorder(itemId, index - 1);
                      } else if (event.key === "ArrowDown") {
                        event.preventDefault();
                        reorder(itemId, index + 1);
                      }
                    }}
                    onDragStart={(event) => onDragStart(event, itemId)}
                    onDragOver={(event) => {
                      if (draggedItemRef.current) event.preventDefault();
                    }}
                    onDrop={(event) => onDrop(event, itemId)}
                    onDragEnd={() => {
                      draggedItemRef.current = null;
                      setDraggedItem(null);
                    }}
                  >
                    <GripVertical size={16} aria-hidden="true" />
                    <Icon size={18} aria-hidden="true" />
                    <span>{descriptor.label}</span>
                    <label>
                      <span className="board-toolbar-config__visibility-label">Показывать</span>
                      <input
                        type="checkbox"
                        checked={visible}
                        aria-label={`Показывать инструмент ${descriptor.label}`}
                        onChange={(event) => updateVisibility(
                          itemId,
                          event.currentTarget.checked,
                        )}
                      />
                    </label>
                    <button
                      type="button"
                      aria-label={`Переместить ${descriptor.label} вверх`}
                      disabled={index === 0}
                      onClick={() => reorder(itemId, index - 1)}
                    >
                      <ArrowUp size={16} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Переместить ${descriptor.label} вниз`}
                      disabled={index === preferences.order.length - 1}
                      onClick={() => reorder(itemId, index + 1)}
                    >
                      <ArrowDown size={16} aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ol>

            <footer className="board-toolbar-config__footer">
              <button
                type="button"
                data-toolbar-action="reset"
                onClick={() => changePreferences(defaultBoardToolbarPreferences())}
              >
                <RotateCcw size={16} aria-hidden="true" />
                <span>Сбросить настройки</span>
              </button>
            </footer>
          </section>
        </div>
      )}
    </>
  );
}

import {
  ChevronDown,
  ChevronRight,
  Copy,
  FileCode2,
  FileDigit,
  FilePlus2,
  Folder,
  FolderPlus,
  MoreHorizontal,
  Pencil,
  Trash2,
  Upload,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import type { CodeWorkspaceEntrySnapshot } from "../../code/core";
import {
  NativeInputPresence,
  visibleNativeInputPresencePeer,
  type NativeInputPresencePeer,
  type NativeInputPresencePublisher,
} from "../code/nativeInputPresence";

interface CodeExplorerProps {
  readonly entries: readonly CodeWorkspaceEntrySnapshot[];
  readonly activeId: string | null;
  readonly readOnly: boolean;
  readonly renamingId: string | null;
  readonly renameValue: string;
  readonly onSelect: (entryId: string) => void;
  readonly onBeginRename: (entry: CodeWorkspaceEntrySnapshot) => void;
  readonly onRenameValueChange: (value: string) => void;
  readonly onCommitRename: () => void;
  readonly awarenessPeers?: readonly NativeInputPresencePeer[];
  readonly publishAwareness?: NativeInputPresencePublisher;
  readonly onCancelRename: () => void;
  readonly onCreate: (kind: "file" | "folder", parentId: string | null) => void;
  readonly onUpload: (files: FileList | null, parentId: string | null) => void;
  readonly onDuplicate: (entry: CodeWorkspaceEntrySnapshot) => void;
  readonly onDelete: (entry: CodeWorkspaceEntrySnapshot) => void;
  readonly onMove: (entryId: string, parentId: string | null) => void;
  readonly onUndo: () => void;
  readonly onRedo: () => void;
}

interface VisibleEntry extends CodeWorkspaceEntrySnapshot {
  readonly depth: number;
}

interface ExplorerMenuState {
  readonly x: number;
  readonly y: number;
  readonly entryId: string | null;
}

function visibleEntries(
  entries: readonly CodeWorkspaceEntrySnapshot[],
  collapsed: ReadonlySet<string>,
): readonly VisibleEntry[] {
  const byParent = new Map<string | null, CodeWorkspaceEntrySnapshot[]>();
  for (const entry of entries) {
    const children = byParent.get(entry.parentId) ?? [];
    children.push(entry);
    byParent.set(entry.parentId, children);
  }
  const result: VisibleEntry[] = [];
  const visited = new Set<string>();
  const hideDescendants = (parentId: string): void => {
    for (const entry of byParent.get(parentId) ?? []) {
      if (visited.has(entry.id)) continue;
      visited.add(entry.id);
      if (entry.kind === "folder") hideDescendants(entry.id);
    }
  };
  const visit = (parentId: string | null, depth: number): void => {
    for (const entry of byParent.get(parentId) ?? []) {
      if (visited.has(entry.id)) continue;
      visited.add(entry.id);
      result.push({ ...entry, depth });
      if (entry.kind === "folder") {
        if (collapsed.has(entry.id)) hideDescendants(entry.id);
        else visit(entry.id, depth + 1);
      }
    }
  };
  visit(null, 0);
  for (const entry of entries) {
    if (visited.has(entry.id)) continue;
    visited.add(entry.id);
    result.push({ ...entry, depth: 0 });
    if (entry.kind === "folder") {
      if (collapsed.has(entry.id)) hideDescendants(entry.id);
      else visit(entry.id, 1);
    }
  }
  return result;
}

export function CodeExplorer({
  entries,
  activeId,
  readOnly,
  renamingId,
  renameValue,
  onSelect,
  onBeginRename,
  onRenameValueChange,
  onCommitRename,
  awarenessPeers = [],
  publishAwareness = () => undefined,
  onCancelRename,
  onCreate,
  onUpload,
  onDuplicate,
  onDelete,
  onMove,
  onUndo,
  onRedo,
}: CodeExplorerProps) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [menu, setMenu] = useState<ExplorerMenuState | null>(null);
  const [uploadParentId, setUploadParentId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | "root" | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const treeRef = useRef<HTMLDivElement | null>(null);
  const expandableFolderIds = useMemo(() => new Set(entries
    .map((entry) => entry.parentId)
    .filter((parentId): parentId is string => parentId !== null)), [entries]);
  const tree = useMemo(
    () => visibleEntries(entries, collapsed),
    [collapsed, entries],
  );

  useEffect(() => {
    setCollapsed((current) => {
      const next = new Set([...current]
        .filter((id) => expandableFolderIds.has(id)));
      return next.size === current.size
        && [...next].every((id) => current.has(id))
        ? current
        : next;
    });
  }, [expandableFolderIds]);

  useEffect(() => {
    if (!menu) return undefined;
    const close = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null);
    };
    const closeWindow = () => setMenu(null);
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("blur", closeWindow);
    window.addEventListener("resize", closeWindow);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("blur", closeWindow);
      window.removeEventListener("resize", closeWindow);
    };
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")
        ?.focus({ preventScroll: true });
    });
  }, [menu]);

  const toggleFolder = (entryId: string, expanded?: boolean): void => {
    setCollapsed((current) => {
      const next = new Set(current);
      const shouldExpand = expanded ?? next.has(entryId);
      if (shouldExpand) next.delete(entryId);
      else next.add(entryId);
      return next;
    });
  };

  const openMenu = (
    event: Pick<MouseEvent, "preventDefault" | "clientX" | "clientY">,
    entryId: string | null,
  ): void => {
    event.preventDefault();
    if (entryId) onSelect(entryId);
    setMenu({ x: event.clientX, y: event.clientY, entryId });
  };

  const menuEntry = menu?.entryId
    ? entries.find((entry) => entry.id === menu.entryId) ?? null
    : null;
  const menuParentId = menuEntry?.kind === "folder"
    ? menuEntry.id
    : menuEntry?.parentId ?? null;

  const chooseUpload = (parentId: string | null): void => {
    setUploadParentId(parentId);
    setMenu(null);
    fileInputRef.current?.click();
  };

  const restoreTreeFocus = (): void => {
    requestAnimationFrame(() => {
      const selected = treeRef.current?.querySelector<HTMLButtonElement>(
        '[role="treeitem"][aria-selected="true"] .code-tree-entry__main',
      );
      (selected ?? treeRef.current)?.focus({ preventScroll: true });
    });
  };

  const drop = (
    event: DragEvent,
    parentId: string | null,
  ): void => {
    event.preventDefault();
    event.stopPropagation();
    const entryId = draggingId ?? event.dataTransfer.getData("text/x-eduri-code-entry");
    setDraggingId(null);
    setDropTargetId(null);
    if (!entryId || readOnly || entryId === parentId) return;
    onMove(entryId, parentId);
    if (parentId) toggleFolder(parentId, true);
  };

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(
      "button:not(:disabled)",
    )];
    if (buttons.length === 0) return;
    const current = Math.max(0, buttons.indexOf(document.activeElement as HTMLButtonElement));
    if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      setMenu(null);
      return;
    }
    let next: number | null = null;
    if (event.key === "ArrowDown") next = (current + 1) % buttons.length;
    if (event.key === "ArrowUp") next = (current - 1 + buttons.length) % buttons.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = buttons.length - 1;
    if (next !== null) {
      event.preventDefault();
      buttons[next].focus();
    }
  };

  const handleExplorerKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    const target = event.target;
    if (
      target instanceof HTMLInputElement
      || target instanceof HTMLTextAreaElement
      || (target instanceof HTMLElement && target.isContentEditable)
      || readOnly
      || event.altKey
      || (!event.ctrlKey && !event.metaKey)
    ) return;
    const key = event.code === "KeyZ"
      ? "z"
      : event.code === "KeyY"
        ? "y"
        : event.key.toLocaleLowerCase("en-US");
    if (key === "z") {
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) onRedo();
      else onUndo();
    } else if (key === "y" && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      onRedo();
    }
  };

  return (
    <aside
      className="code-explorer"
      aria-label="Проводник"
      onKeyDown={handleExplorerKeyDown}
    >
      <div className="code-explorer__head">
        <strong>Проводник</strong>
        <button
          type="button"
          aria-label="Меню проводника"
          title="Меню проводника"
          aria-haspopup="menu"
          aria-expanded={menu?.entryId === null}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            openMenu({
              preventDefault: () => undefined,
              clientX: rect.right,
              clientY: rect.bottom,
            }, null);
          }}
        >
          <MoreHorizontal size={16} />
        </button>
      </div>
      <div
        ref={treeRef}
        className={`code-explorer__tree${dropTargetId === "root" ? " is-drop-target" : ""}`}
        role="tree"
        aria-label="Файлы проекта"
        tabIndex={-1}
        onContextMenu={(event) => {
          if (event.target === event.currentTarget) openMenu(event, null);
        }}
        onDragOver={(event) => {
          if (!readOnly && draggingId) {
            event.preventDefault();
            setDropTargetId("root");
          }
        }}
        onDrop={(event) => drop(event, null)}
      >
        {tree.map((entry) => {
          const folder = entry.kind === "folder";
          const expandable = folder && expandableFolderIds.has(entry.id);
          const expanded = expandable && !collapsed.has(entry.id);
          const renameTarget = {
            kind: "explorer",
            entryId: entry.id,
            field: "rename",
          } as const;
          const renamePeer = visibleNativeInputPresencePeer(
            awarenessPeers,
            renameTarget,
          );
          const editingPeer = [...awarenessPeers]
            .filter((peer) => (
              peer.state.target.kind === "file"
              && peer.state.target.entryId === entry.id
            ))
            .sort((left, right) => left.participant.participantId.localeCompare(
              right.participant.participantId,
            ))[0] ?? null;
          const visiblePresencePeer = renamePeer ?? editingPeer;
          return (
            <div
              key={entry.id}
              className={`code-tree-entry${entry.id === activeId ? " is-active" : ""}${
                draggingId === entry.id ? " is-dragging" : ""
              }${dropTargetId === entry.id ? " is-drop-target" : ""}`}
              style={{ paddingLeft: 5 + entry.depth * 14 }}
              role="treeitem"
              aria-level={entry.depth + 1}
              aria-selected={entry.id === activeId}
              aria-expanded={expandable ? expanded : undefined}
              data-folder={folder ? "true" : undefined}
              draggable={!readOnly}
              onDragStart={(event) => {
                if (readOnly) {
                  event.preventDefault();
                  return;
                }
                setDraggingId(entry.id);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/x-eduri-code-entry", entry.id);
              }}
              onDragEnd={() => {
                setDraggingId(null);
                setDropTargetId(null);
              }}
              onDragOver={(event) => {
                if (!folder || readOnly || draggingId === entry.id) return;
                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer.dropEffect = "move";
                setDropTargetId(entry.id);
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                  setDropTargetId((current) => current === entry.id ? null : current);
                }
              }}
              onDrop={(event) => {
                if (folder) {
                  drop(event, entry.id);
                } else {
                  event.preventDefault();
                  event.stopPropagation();
                  setDropTargetId(null);
                }
              }}
              onContextMenu={(event) => openMenu(event, entry.id)}
            >
              {renamingId === entry.id ? (
              <div className="code-tree-entry__rename">
                <span className="code-tree-entry__chevron" aria-hidden="true">
                  {expandable
                    ? expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />
                    : null}
                </span>
                <span className="code-tree-entry__icon" aria-hidden="true">
                  {folder
                    ? <Folder size={15} />
                    : entry.contentKind === "blob"
                      ? <FileDigit size={15} />
                      : <FileCode2 size={15} />}
                </span>
                <NativeInputPresence
                  className="code-tree-entry__rename-input"
                  target={renameTarget}
                  value={renameValue}
                  peers={awarenessPeers}
                  publish={publishAwareness}
                >
                  {(presence) => (
                    <input
                      {...presence}
                      autoFocus
                      value={renameValue}
                      readOnly={readOnly}
                      aria-label="Новое имя"
                      onChange={(event) => onRenameValueChange(event.target.value)}
                      onBlur={(event) => {
                        presence.onBlur(event);
                        onCommitRename();
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") onCommitRename();
                        if (event.key === "Escape") onCancelRename();
                      }}
                    />
                  )}
                </NativeInputPresence>
              </div>
              ) : (
              <button
                type="button"
                className="code-tree-entry__main"
                onClick={() => {
                  onSelect(entry.id);
                  if (expandable) toggleFolder(entry.id);
                }}
                onDoubleClick={() => {
                  if (!folder) onBeginRename(entry);
                }}
                onKeyDown={(event) => {
                  if (expandable && event.key === "ArrowRight") {
                    event.preventDefault();
                    toggleFolder(entry.id, true);
                  } else if (expandable && event.key === "ArrowLeft") {
                    event.preventDefault();
                    toggleFolder(entry.id, false);
                  } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                    const rect = event.currentTarget.getBoundingClientRect();
                    openMenu({
                      preventDefault: () => event.preventDefault(),
                      clientX: rect.left + 18,
                      clientY: rect.bottom,
                    }, entry.id);
                  }
                }}
              >
                <span className="code-tree-entry__chevron" aria-hidden="true">
                  {expandable
                    ? expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />
                    : null}
                </span>
                <span className="code-tree-entry__icon" aria-hidden="true">
                  {folder
                    ? <Folder size={15} />
                    : entry.contentKind === "blob"
                      ? <FileDigit size={15} />
                      : <FileCode2 size={15} />}
                </span>
                <span>{entry.name}</span>
                {visiblePresencePeer && (
                  <span
                    className="code-tree-entry__presence"
                    style={{ backgroundColor: visiblePresencePeer.participant.color }}
                    title={renamePeer
                      ? `${visiblePresencePeer.participant.displayName} переименовывает`
                      : `${visiblePresencePeer.participant.displayName} редактирует файл`}
                    aria-label={renamePeer
                      ? `${visiblePresencePeer.participant.displayName} переименовывает`
                      : `${visiblePresencePeer.participant.displayName} редактирует файл`}
                  >{visiblePresencePeer.participant.displayName.slice(0, 1)}</span>
                )}
              </button>
              )}
            </div>
          );
        })}
      </div>
      <input
        ref={fileInputRef}
        className="sr-only"
        type="file"
        multiple
        disabled={readOnly}
        onChange={(event) => {
          onUpload(event.currentTarget.files, uploadParentId);
          event.currentTarget.value = "";
        }}
      />
      {menu && (
        <div
          ref={menuRef}
          className="code-explorer-menu"
          role="menu"
          aria-label={menuEntry ? `Действия: ${menuEntry.name}` : "Действия проводника"}
          style={{
            left: Math.max(8, Math.min(menu.x, window.innerWidth - 218)),
            top: Math.max(8, Math.min(menu.y, window.innerHeight - 270)),
          }}
          onKeyDown={handleMenuKeyDown}
        >
          <button type="button" role="menuitem" disabled={readOnly} onClick={() => {
            onCreate("file", menuParentId);
            if (menuParentId) toggleFolder(menuParentId, true);
            setMenu(null);
          }}><FilePlus2 size={15} /><span>Создать файл</span></button>
          <button type="button" role="menuitem" disabled={readOnly} onClick={() => {
            onCreate("folder", menuParentId);
            if (menuParentId) toggleFolder(menuParentId, true);
            setMenu(null);
          }}><FolderPlus size={15} /><span>Создать папку</span></button>
          <button type="button" role="menuitem" disabled={readOnly} onClick={() => chooseUpload(menuParentId)}>
            <Upload size={15} /><span>Загрузить файлы</span>
          </button>
          {menuEntry && <div className="code-explorer-menu__separator" role="separator" />}
          {menuEntry && (
            <button type="button" role="menuitem" disabled={readOnly} onClick={() => {
              onBeginRename(menuEntry);
              setMenu(null);
            }}><Pencil size={15} /><span>Переименовать</span></button>
          )}
          {menuEntry?.kind === "file" && (
            <button type="button" role="menuitem" disabled={readOnly} onClick={() => {
              onDuplicate(menuEntry);
              setMenu(null);
              restoreTreeFocus();
            }}><Copy size={15} /><span>Дублировать</span></button>
          )}
          {menuEntry && menuEntry.id !== "main-py" && (
            <button type="button" role="menuitem" className="is-danger" disabled={readOnly} onClick={() => {
              onDelete(menuEntry);
              setMenu(null);
              restoreTreeFocus();
            }}><Trash2 size={15} /><span>Удалить</span></button>
          )}
        </div>
      )}
    </aside>
  );
}

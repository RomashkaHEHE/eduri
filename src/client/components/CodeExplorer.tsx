import {
  ChevronDown,
  ChevronRight,
  Copy,
  FileCode2,
  FileDigit,
  FilePlus2,
  Folder,
  FolderPlus,
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
  readonly id?: string;
  readonly entries: readonly CodeWorkspaceEntrySnapshot[];
  readonly activeId: string | null;
  readonly readOnly: boolean;
  readonly renamingId: string | null;
  readonly renameValue: string;
  readonly onActivate: (entryId: string) => void;
  readonly onBeginRename: (entry: CodeWorkspaceEntrySnapshot) => void;
  readonly onRenameValueChange: (value: string) => void;
  readonly onCommitRename: () => void;
  readonly awarenessPeers?: readonly NativeInputPresencePeer[];
  readonly publishAwareness?: NativeInputPresencePublisher;
  readonly onCancelRename: () => void;
  readonly onCreate: (kind: "file" | "folder", parentId: string | null) => void;
  readonly onUpload: (files: FileList | null, parentId: string | null) => void;
  readonly onDuplicate: (entry: CodeWorkspaceEntrySnapshot) => void;
  readonly onDelete: (entries: readonly CodeWorkspaceEntrySnapshot[]) => void;
  readonly onMove: (entryIds: readonly string[], parentId: string | null) => void;
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

interface ExplorerSelectionState {
  readonly ids: ReadonlySet<string>;
  readonly focusedId: string | null;
  readonly anchorId: string | null;
}

const EMPTY_SELECTION: ExplorerSelectionState = {
  ids: new Set(),
  focusedId: null,
  anchorId: null,
};

function sameIds(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((id) => right.has(id));
}

function sameSelection(
  left: ExplorerSelectionState,
  right: ExplorerSelectionState,
): boolean {
  return left.focusedId === right.focusedId
    && left.anchorId === right.anchorId
    && sameIds(left.ids, right.ids);
}

function visibleRange(
  entries: readonly VisibleEntry[],
  anchorId: string,
  targetId: string,
): ReadonlySet<string> {
  const anchorIndex = entries.findIndex((entry) => entry.id === anchorId);
  const targetIndex = entries.findIndex((entry) => entry.id === targetId);
  if (anchorIndex < 0 || targetIndex < 0) return new Set([targetId]);
  const start = Math.min(anchorIndex, targetIndex);
  const end = Math.max(anchorIndex, targetIndex);
  return new Set(entries.slice(start, end + 1).map((entry) => entry.id));
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

function containsRequiredMainEntry(
  entries: readonly CodeWorkspaceEntrySnapshot[],
  entryId: string,
): boolean {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  let current = byId.get("main-py");
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    if (current.id === entryId) return true;
    visited.add(current.id);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return false;
}

export function CodeExplorer({
  id,
  entries,
  activeId,
  readOnly,
  renamingId,
  renameValue,
  onActivate,
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
  const [selection, setSelection] = useState<ExplorerSelectionState>(EMPTY_SELECTION);
  const [menu, setMenu] = useState<ExplorerMenuState | null>(null);
  const [uploadParentId, setUploadParentId] = useState<string | null>(null);
  const [draggingIds, setDraggingIds] = useState<readonly string[]>([]);
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
  const entryById = useMemo(
    () => new Map(entries.map((entry) => [entry.id, entry])),
    [entries],
  );
  const visibleIdSet = useMemo(
    () => new Set(tree.map((entry) => entry.id)),
    [tree],
  );
  const selectedEntries = useMemo(
    () => tree.flatMap((entry) => {
      if (!selection.ids.has(entry.id)) return [];
      const source = entryById.get(entry.id);
      return source ? [source] : [];
    }),
    [entryById, selection.ids, tree],
  );
  const focusedId = selection.focusedId && visibleIdSet.has(selection.focusedId)
    ? selection.focusedId
    : activeId && visibleIdSet.has(activeId)
      ? activeId
      : tree[0]?.id ?? null;
  const selectionRef = useRef(selection);
  const previousActiveIdRef = useRef<string | null>(null);
  selectionRef.current = selection;

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
    setSelection((current) => {
      const closestVisible = (entryId: string | null): string | null => {
        let cursor = entryId ? entryById.get(entryId) : undefined;
        const visited = new Set<string>();
        while (cursor && !visited.has(cursor.id)) {
          if (visibleIdSet.has(cursor.id)) return cursor.id;
          visited.add(cursor.id);
          cursor = cursor.parentId === null ? undefined : entryById.get(cursor.parentId);
        }
        return null;
      };
      const nextIds = new Set([...current.ids].filter((id) => visibleIdSet.has(id)));
      const nextFocusedId = closestVisible(current.focusedId)
        ?? (activeId && visibleIdSet.has(activeId) ? activeId : tree[0]?.id ?? null);
      if (current.ids.size > 0 && nextIds.size === 0 && nextFocusedId) {
        nextIds.add(nextFocusedId);
      }
      const nextAnchorId = closestVisible(current.anchorId) ?? nextFocusedId;
      const next = { ids: nextIds, focusedId: nextFocusedId, anchorId: nextAnchorId };
      return sameSelection(current, next) ? current : next;
    });
  }, [activeId, entryById, tree, visibleIdSet]);

  useEffect(() => {
    const previousActiveId = previousActiveIdRef.current;
    previousActiveIdRef.current = activeId;
    if (previousActiveId === activeId) return;
    if (!activeId || !entryById.has(activeId)) return;
    setSelection((current) => {
      if (current.ids.has(activeId)) return current;
      return {
        ids: new Set([activeId]),
        focusedId: activeId,
        anchorId: activeId,
      };
    });
  }, [activeId, entryById]);

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
    if (entryId && !selectionRef.current.ids.has(entryId)) {
      setSelection({
        ids: new Set([entryId]),
        focusedId: entryId,
        anchorId: entryId,
      });
    } else if (entryId) {
      setSelection((current) => ({ ...current, focusedId: entryId }));
    }
    setMenu({ x: event.clientX, y: event.clientY, entryId });
  };

  const menuEntry = menu?.entryId
    ? entries.find((entry) => entry.id === menu.entryId) ?? null
    : null;
  const menuParentId = menuEntry?.kind === "folder"
    ? menuEntry.id
    : menuEntry?.parentId ?? null;
  const selectionContainsMain = selectedEntries.some((entry) => (
    containsRequiredMainEntry(entries, entry.id)
  ));
  const chooseUpload = (parentId: string | null): void => {
    setUploadParentId(parentId);
    setMenu(null);
    fileInputRef.current?.click();
  };

  const entryButton = (entryId: string | null): HTMLButtonElement | null => {
    if (!entryId) return null;
    return [...(treeRef.current?.querySelectorAll<HTMLButtonElement>(
      ".code-tree-entry__main[data-entry-id]",
    ) ?? [])].find((button) => button.dataset.entryId === entryId) ?? null;
  };

  const restoreTreeFocus = (): void => {
    requestAnimationFrame(() => {
      const roving = treeRef.current?.querySelector<HTMLButtonElement>(
        '.code-tree-entry__main[tabindex="0"]',
      );
      (roving ?? entryButton(selectionRef.current.focusedId) ?? treeRef.current)
        ?.focus({ preventScroll: true });
    });
  };

  const focusEntry = (entryId: string): void => {
    entryButton(entryId)?.focus({ preventScroll: true });
  };

  const selectEntry = (
    entryId: string,
    options: {
      readonly additive?: boolean;
      readonly range?: boolean;
      readonly activate?: boolean;
    } = {},
  ): void => {
    setSelection((current) => {
      if (options.range) {
        const anchorId = current.anchorId && visibleIdSet.has(current.anchorId)
          ? current.anchorId
          : current.focusedId && visibleIdSet.has(current.focusedId)
            ? current.focusedId
            : entryId;
        const rangeIds = visibleRange(tree, anchorId, entryId);
        return {
          ids: options.additive
            ? new Set([...current.ids, ...rangeIds])
            : rangeIds,
          focusedId: entryId,
          anchorId,
        };
      }
      if (options.additive) {
        const ids = new Set(current.ids);
        if (ids.has(entryId)) ids.delete(entryId);
        else ids.add(entryId);
        return {
          ids,
          focusedId: entryId,
          anchorId: entryId,
        };
      }
      return {
        ids: new Set([entryId]),
        focusedId: entryId,
        anchorId: entryId,
      };
    });
    if (options.activate) onActivate(entryId);
  };

  const selectionForDrag = (entryId: string): readonly string[] => {
    const ids = selectionRef.current.ids.has(entryId)
      ? tree.filter((entry) => selectionRef.current.ids.has(entry.id)).map((entry) => entry.id)
      : [entryId];
    if (!selectionRef.current.ids.has(entryId)) {
      setSelection({
        ids: new Set([entryId]),
        focusedId: entryId,
        anchorId: entryId,
      });
    }
    return ids;
  };

  const transferredEntryIds = (event: DragEvent): readonly string[] => {
    const serializedIds = event.dataTransfer.getData("text/x-eduri-code-entries");
    try {
      const value: unknown = JSON.parse(serializedIds);
      if (Array.isArray(value) && value.every((id) => typeof id === "string")) {
        return value;
      }
    } catch {
      // A drag from an older client may only expose the singular format.
    }
    const entryId = event.dataTransfer.getData("text/x-eduri-code-entry");
    return entryId ? [entryId] : [];
  };

  const invalidDropTarget = (
    entryIds: readonly string[],
    parentId: string | null,
  ): boolean => {
    if (parentId === null) return false;
    const roots = new Set(entryIds);
    let cursor: string | null = parentId;
    const visited = new Set<string>();
    while (cursor !== null && !visited.has(cursor)) {
      if (roots.has(cursor)) return true;
      visited.add(cursor);
      cursor = entryById.get(cursor)?.parentId ?? null;
    }
    return false;
  };

  const drop = (
    event: DragEvent,
    parentId: string | null,
  ): void => {
    event.preventDefault();
    event.stopPropagation();
    const transferredIds = transferredEntryIds(event);
    const entryIds = draggingIds.length > 0 ? draggingIds : transferredIds;
    setDraggingIds([]);
    setDropTargetId(null);
    if (
      entryIds.length === 0
      || readOnly
      || invalidDropTarget(entryIds, parentId)
    ) return;
    onMove(entryIds, parentId);
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
      event.stopPropagation();
      setMenu(null);
      restoreTreeFocus();
      return;
    }
    let next: number | null = null;
    if (event.key === "ArrowDown") next = (current + 1) % buttons.length;
    if (event.key === "ArrowUp") next = (current - 1 + buttons.length) % buttons.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = buttons.length - 1;
    if (next !== null) {
      event.preventDefault();
      event.stopPropagation();
      buttons[next].focus();
    }
  };

  const handleExplorerKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.defaultPrevented) return;
    const target = event.target;
    if (
      target instanceof HTMLInputElement
      || target instanceof HTMLTextAreaElement
      || (target instanceof HTMLElement && target.isContentEditable)
      || event.altKey
    ) return;
    const command = event.ctrlKey || event.metaKey;
    const targetButton = target instanceof HTMLElement
      ? target.closest<HTMLButtonElement>(".code-tree-entry__main[data-entry-id]")
      : null;
    const currentId = targetButton?.dataset.entryId
      ?? (target === treeRef.current ? focusedId : null);
    const currentIndex = currentId
      ? tree.findIndex((entry) => entry.id === currentId)
      : -1;
    const key = event.code === "KeyZ"
      ? "z"
      : event.code === "KeyY"
        ? "y"
        : event.key.toLocaleLowerCase("en-US");
    if (command && !readOnly && key === "z") {
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) onRedo();
      else onUndo();
    } else if (command && !readOnly && key === "y" && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      onRedo();
    } else if (command && key === "a") {
      event.preventDefault();
      event.stopPropagation();
      const ids = new Set(tree.map((entry) => entry.id));
      setSelection({
        ids,
        focusedId: focusedId ?? tree[0]?.id ?? null,
        anchorId: focusedId ?? tree[0]?.id ?? null,
      });
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setSelection({
        ids: new Set(),
        focusedId,
        anchorId: focusedId,
      });
    } else if (
      currentIndex >= 0
      && ["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)
    ) {
      event.preventDefault();
      event.stopPropagation();
      const nextIndex = event.key === "Home"
        ? 0
        : event.key === "End"
          ? tree.length - 1
          : Math.max(0, Math.min(
            tree.length - 1,
            currentIndex + (event.key === "ArrowUp" ? -1 : 1),
          ));
      const nextId = tree[nextIndex]?.id;
      if (!nextId) return;
      if (event.shiftKey) {
        selectEntry(nextId, { range: true, additive: command });
      } else if (command) {
        setSelection((current) => ({ ...current, focusedId: nextId }));
      } else {
        selectEntry(nextId);
      }
      focusEntry(nextId);
    } else if (currentIndex >= 0 && event.key === "ArrowRight") {
      const currentEntry = tree[currentIndex]!;
      if (currentEntry.kind !== "folder" || !expandableFolderIds.has(currentId!)) return;
      event.preventDefault();
      event.stopPropagation();
      if (collapsed.has(currentId!)) {
        toggleFolder(currentId!, true);
        return;
      }
      const child = tree[currentIndex + 1];
      if (!child || child.depth <= currentEntry.depth) return;
      if (event.shiftKey) {
        selectEntry(child.id, { range: true, additive: command });
      } else if (command) {
        setSelection((current) => ({ ...current, focusedId: child.id }));
      } else {
        selectEntry(child.id);
      }
      focusEntry(child.id);
    } else if (currentIndex >= 0 && event.key === "ArrowLeft") {
      const currentEntry = tree[currentIndex]!;
      const expandable = currentEntry.kind === "folder"
        && expandableFolderIds.has(currentId!);
      if (expandable && !collapsed.has(currentId!)) {
        event.preventDefault();
        event.stopPropagation();
        toggleFolder(currentId!, false);
        return;
      }
      if (currentEntry.parentId === null) return;
      event.preventDefault();
      event.stopPropagation();
      const parentId = currentEntry.parentId;
      if (event.shiftKey) {
        selectEntry(parentId, { range: true, additive: command });
      } else if (command) {
        setSelection((current) => ({ ...current, focusedId: parentId }));
      } else {
        selectEntry(parentId);
      }
      focusEntry(parentId);
    } else if (currentIndex >= 0 && event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      onActivate(currentId!);
    } else if (currentIndex >= 0 && (event.key === " " || event.key === "Spacebar")) {
      event.preventDefault();
      event.stopPropagation();
      selectEntry(currentId!, { additive: true });
    } else if (
      currentIndex >= 0
      && event.key === "F2"
      && !readOnly
      && renamingId === null
      && selectedEntries.length === 1
      && selectedEntries[0]?.id === currentId
    ) {
      event.preventDefault();
      event.stopPropagation();
      onBeginRename(selectedEntries[0]!);
    } else if (
      currentIndex >= 0
      && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))
    ) {
      const rect = targetButton?.getBoundingClientRect();
      if (!rect) return;
      event.preventDefault();
      event.stopPropagation();
      openMenu({
        preventDefault: () => undefined,
        clientX: rect.left + 18,
        clientY: rect.bottom,
      }, currentId!);
    } else if (
      !readOnly
      && renamingId === null
      && (event.key === "Delete" || event.key === "Backspace")
    ) {
      event.preventDefault();
      event.stopPropagation();
      if (!selectionContainsMain && selectedEntries.length > 0) onDelete(selectedEntries);
    }
  };

  return (
    <aside
      id={id}
      className="code-explorer"
      aria-label="Проводник"
      onKeyDown={handleExplorerKeyDown}
    >
      <div className="code-explorer__head">
        <strong>Проводник</strong>
      </div>
      <div
        ref={treeRef}
        className={`code-explorer__tree${dropTargetId === "root" ? " is-drop-target" : ""}`}
        role="tree"
        aria-label="Файлы проекта"
        aria-multiselectable="true"
        tabIndex={-1}
        onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          setSelection((current) => ({
            ids: new Set(),
            focusedId: current.focusedId,
            anchorId: current.focusedId,
          }));
        }}
        onContextMenu={(event) => {
          if (event.target === event.currentTarget) openMenu(event, null);
        }}
        onDragOver={(event) => {
          const entryIds = draggingIds.length > 0
            ? draggingIds
            : transferredEntryIds(event);
          if (!readOnly && entryIds.length > 0) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
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
          const selected = selection.ids.has(entry.id);
          const dragging = draggingIds.includes(entry.id);
          return (
            <div
              key={entry.id}
              className={`code-tree-entry${selected ? " is-selected" : ""}${
                entry.id === activeId ? " is-active" : ""
              }${
                dragging ? " is-dragging" : ""
              }${dropTargetId === entry.id ? " is-drop-target" : ""}`}
              style={{ paddingLeft: 5 + entry.depth * 14 }}
              role="treeitem"
              aria-level={entry.depth + 1}
              aria-selected={selected}
              aria-expanded={expandable ? expanded : undefined}
              data-folder={folder ? "true" : undefined}
              draggable={!readOnly}
              onDragStart={(event) => {
                if (readOnly) {
                  event.preventDefault();
                  return;
                }
                const entryIds = selectionForDrag(entry.id);
                setDraggingIds(entryIds);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData(
                  "text/x-eduri-code-entries",
                  JSON.stringify(entryIds),
                );
                event.dataTransfer.setData("text/x-eduri-code-entry", entry.id);
              }}
              onDragEnd={() => {
                setDraggingIds([]);
                setDropTargetId(null);
              }}
              onDragOver={(event) => {
                const entryIds = draggingIds.length > 0
                  ? draggingIds
                  : transferredEntryIds(event);
                if (entryIds.length === 0) return;
                event.stopPropagation();
                if (
                  !folder
                  || readOnly
                  || invalidDropTarget(entryIds, entry.id)
                ) {
                  setDropTargetId(null);
                  return;
                }
                event.preventDefault();
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
                data-entry-id={entry.id}
                tabIndex={entry.id === focusedId ? 0 : -1}
                onFocus={() => {
                  setSelection((current) => current.focusedId === entry.id
                    ? current
                    : { ...current, focusedId: entry.id });
                }}
                onClick={(event) => {
                  const additive = event.ctrlKey || event.metaKey;
                  selectEntry(entry.id, {
                    additive,
                    range: event.shiftKey,
                    activate: !additive && !event.shiftKey,
                  });
                  if (
                    expandable
                    && !additive
                    && !event.shiftKey
                    && event.detail <= 1
                  ) toggleFolder(entry.id);
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
          {menuEntry && selectedEntries.length === 1 && (
            <button type="button" role="menuitem" disabled={readOnly} onClick={() => {
              onBeginRename(menuEntry);
              setMenu(null);
            }}><Pencil size={15} /><span>Переименовать</span></button>
          )}
          {menuEntry?.kind === "file" && selectedEntries.length === 1 && (
            <button type="button" role="menuitem" disabled={readOnly} onClick={() => {
              onDuplicate(menuEntry);
              setMenu(null);
              restoreTreeFocus();
            }}><Copy size={15} /><span>Дублировать</span></button>
          )}
          {menuEntry && selectedEntries.length > 0 && !selectionContainsMain && (
            <button type="button" role="menuitem" className="is-danger" disabled={readOnly} onClick={() => {
              onDelete(selectedEntries);
              setMenu(null);
              restoreTreeFocus();
            }}><Trash2 size={15} /><span>Удалить</span></button>
          )}
        </div>
      )}
    </aside>
  );
}

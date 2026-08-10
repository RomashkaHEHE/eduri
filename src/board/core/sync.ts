import * as Y from "yjs";

export const REMOTE_UPDATE_ORIGIN = Object.freeze({
  type: "eduri.board.remote-update",
});

export function encodeBoardStateVector(doc: Y.Doc): Uint8Array {
  return Y.encodeStateVector(doc);
}

export function encodeBoardUpdate(doc: Y.Doc, stateVector?: Uint8Array): Uint8Array {
  return stateVector
    ? Y.encodeStateAsUpdate(doc, stateVector)
    : Y.encodeStateAsUpdate(doc);
}

export function applyBoardUpdate(
  doc: Y.Doc,
  update: Uint8Array,
  origin: object = REMOTE_UPDATE_ORIGIN,
): void {
  Y.applyUpdate(doc, update, origin);
}

export function mergeBoardUpdates(updates: readonly Uint8Array[]): Uint8Array {
  return Y.mergeUpdates([...updates]);
}

function mergeBoundedGroup(
  updates: readonly Uint8Array[],
  maxBytes: number,
): readonly Uint8Array[] {
  if (updates.length === 0) return [];
  if (updates.length === 1) return [updates[0].slice()];
  const merged = mergeBoardUpdates(updates);
  if (merged.byteLength <= maxBytes) return [merged];
  const midpoint = Math.ceil(updates.length / 2);
  return [
    ...mergeBoundedGroup(updates.slice(0, midpoint), maxBytes),
    ...mergeBoundedGroup(updates.slice(midpoint), maxBytes),
  ];
}

/**
 * Coalesces contiguous Yjs updates without turning an aggregate backlog into
 * one oversized wire/storage row. An already-oversized individual update is
 * preserved so the caller can durably retain it and enter explicit recovery.
 */
export function mergeBoardUpdatesBounded(
  updates: readonly Uint8Array[],
  maxBytes: number,
): readonly Uint8Array[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError("maxBytes must be a positive safe integer");
  }
  const compacted: Uint8Array[] = [];
  let group: Uint8Array[] = [];
  let groupBytes = 0;
  const flushGroup = (): void => {
    compacted.push(...mergeBoundedGroup(group, maxBytes));
    group = [];
    groupBytes = 0;
  };
  for (const source of updates) {
    const update = source.slice();
    if (update.byteLength > maxBytes) {
      flushGroup();
      compacted.push(update);
      continue;
    }
    if (
      group.length > 0
      && groupBytes + update.byteLength > maxBytes
    ) {
      flushGroup();
    }
    group.push(update);
    groupBytes += update.byteLength;
  }
  flushGroup();
  return compacted;
}

export function stateVectorsEqual(left: Uint8Array, right: Uint8Array): boolean {
  const leftStates = Y.decodeStateVector(left);
  const rightStates = Y.decodeStateVector(right);
  if (leftStates.size !== rightStates.size) return false;
  for (const [clientId, clock] of leftStates) {
    if (rightStates.get(clientId) !== clock) return false;
  }
  return true;
}

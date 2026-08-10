import * as Y from "yjs";
import type { BoardCommandOrigin } from "./commands.js";

export const DEFAULT_TYPING_CAPTURE_MS = 450;

export interface LocalUndoOptions {
  captureTimeout?: number;
  scope?: Y.Doc | Y.AbstractType<unknown> | Array<Y.AbstractType<unknown>>;
}

export class LocalUndoController {
  readonly manager: Y.UndoManager;

  constructor(
    doc: Y.Doc,
    localOrigin: BoardCommandOrigin,
    options: LocalUndoOptions = {},
  ) {
    this.manager = new Y.UndoManager(options.scope ?? doc, {
      captureTimeout: options.captureTimeout ?? DEFAULT_TYPING_CAPTURE_MS,
      trackedOrigins: new Set([localOrigin]),
      ignoreRemoteMapChanges: false,
    });
  }

  get canUndo(): boolean {
    return this.manager.canUndo();
  }

  get canRedo(): boolean {
    return this.manager.canRedo();
  }

  beginGesture(): void {
    this.manager.stopCapturing();
  }

  endGesture(): void {
    this.manager.stopCapturing();
  }

  commandBoundary(): void {
    this.manager.stopCapturing();
  }

  toolBoundary(): void {
    this.manager.stopCapturing();
  }

  focusBoundary(): void {
    this.manager.stopCapturing();
  }

  undo(): boolean {
    this.manager.stopCapturing();
    return this.manager.undo() !== null;
  }

  redo(): boolean {
    this.manager.stopCapturing();
    return this.manager.redo() !== null;
  }

  clear(): void {
    this.manager.clear();
    this.manager.stopCapturing();
  }

  dispose(): void {
    this.manager.destroy();
  }
}

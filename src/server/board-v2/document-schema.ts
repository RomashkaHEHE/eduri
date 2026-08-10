import * as Y from "yjs";

import {
  BOARD_CORE_SCHEMA_VERSION,
  getManifestMeta,
  getManifestPages,
  getPageMeta,
  getPageObjects,
  openManifestDocument,
  openPageDocument,
} from "../../board/core/index.js";

const MANIFEST_DOCUMENT_KEY = "manifest";
const PAGE_DOCUMENT_KEY_PREFIX = "page:";

export class BoardDocumentSchemaError extends Error {
  constructor(
    public readonly code: "INVALID_STRUCTURE" | "CAUSAL_GAP",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BoardDocumentSchemaError";
  }
}

function schemaError(
  message: string,
  cause?: unknown,
  code: BoardDocumentSchemaError["code"] = "INVALID_STRUCTURE",
): never {
  throw new BoardDocumentSchemaError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function assertMetadata(
  metadata: Y.Map<unknown>,
  documentKind: "manifest" | "page",
  pageId?: string,
): void {
  if (metadata.get("documentKind") !== documentKind) {
    schemaError(`Board ${documentKind} metadata has an invalid document kind`);
  }
  if (metadata.get("schemaVersion") !== BOARD_CORE_SCHEMA_VERSION) {
    schemaError(`Board ${documentKind} metadata has an invalid schema version`);
  }
  if (pageId !== undefined && metadata.get("pageId") !== pageId) {
    schemaError("Board page metadata does not match its document key");
  }
}

function validateManifestDocument(doc: Y.Doc): void {
  assertMetadata(getManifestMeta(doc), "manifest");
  const pages = getManifestPages(doc) as Y.Map<unknown>;
  for (const [pageId, value] of pages.entries()) {
    if (!(value instanceof Y.Map)) {
      schemaError(`Manifest page '${pageId}' must be a Y.Map`);
    }
    if (value.get("id") !== pageId) {
      schemaError(`Manifest page '${pageId}' has a mismatched id`);
    }
    if (
      typeof value.get("name") !== "string"
      || !(value.get("name") as string).trim()
      || typeof value.get("rank") !== "string"
      || !value.get("rank")
    ) {
      schemaError(`Manifest page '${pageId}' has invalid name or rank metadata`);
    }
    if (
      !(value.get("background") instanceof Y.Map)
      || !(value.get("grid") instanceof Y.Map)
    ) {
      schemaError(`Manifest page '${pageId}' has invalid settings maps`);
    }
  }
}

function validatePageDocument(doc: Y.Doc, documentKey: string): void {
  const pageId = documentKey.slice(PAGE_DOCUMENT_KEY_PREFIX.length);
  assertMetadata(getPageMeta(doc), "page", pageId);
  const objects = getPageObjects(doc) as Y.Map<unknown>;
  for (const [objectId, value] of objects.entries()) {
    if (!(value instanceof Y.Map)) {
      schemaError(`Board object '${objectId}' must be a Y.Map`);
    }
  }
}

function openDocumentForValidation(documentKey: string): Y.Doc {
  if (documentKey === MANIFEST_DOCUMENT_KEY) {
    return openManifestDocument(new Y.Doc());
  }
  if (documentKey.startsWith(PAGE_DOCUMENT_KEY_PREFIX)) {
    return openPageDocument(new Y.Doc());
  }
  schemaError(`Unsupported Board document key '${documentKey}'`);
}

export function validateBoardDocumentStructure(
  doc: Y.Doc,
  documentKey: string,
): void {
  if (doc.store.pendingStructs || doc.store.pendingDs) {
    schemaError(
      "Board update has unresolved CRDT dependencies and is not independently applicable",
      undefined,
      "CAUSAL_GAP",
    );
  }
  if (documentKey === MANIFEST_DOCUMENT_KEY) {
    validateManifestDocument(doc);
    return;
  }
  if (documentKey.startsWith(PAGE_DOCUMENT_KEY_PREFIX)) {
    validatePageDocument(doc, documentKey);
    return;
  }
  schemaError(`Unsupported Board document key '${documentKey}'`);
}

export function createBoardDocumentValidationShadow(
  source: Y.Doc,
  documentKey: string,
): Y.Doc {
  const shadow = openDocumentForValidation(documentKey);
  try {
    Y.applyUpdate(shadow, Y.encodeStateAsUpdate(source));
    validateBoardDocumentStructure(shadow, documentKey);
    return shadow;
  } catch (error) {
    shadow.destroy();
    if (error instanceof BoardDocumentSchemaError) throw error;
    schemaError("Board document cannot be prepared for schema validation", error);
  }
}

export function applyAndValidateBoardUpdate(
  shadow: Y.Doc,
  documentKey: string,
  update: Uint8Array,
): boolean {
  let integrated = false;
  const onUpdate = () => {
    integrated = true;
  };
  shadow.on("update", onUpdate);
  try {
    Y.applyUpdate(shadow, update);
    validateBoardDocumentStructure(shadow, documentKey);
    return integrated;
  } catch (error) {
    if (error instanceof BoardDocumentSchemaError) throw error;
    schemaError("Board update cannot be applied to the validation shadow", error);
  } finally {
    shadow.off("update", onUpdate);
  }
}

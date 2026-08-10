import * as Y from "yjs";

export const BOARD_CORE_SCHEMA_VERSION = 1;

export const MANIFEST_META_ROOT = "eduri.board.manifest.meta";
export const MANIFEST_PAGES_ROOT = "eduri.board.manifest.pages";
export const MANIFEST_EXTENSIONS_ROOT = "eduri.board.manifest.extensions";
export const MANIFEST_COMPONENTS_ROOT = "eduri.board.manifest.components";

export const PAGE_META_ROOT = "eduri.board.page.meta";
export const PAGE_OBJECTS_ROOT = "eduri.board.page.objects";

export const CORE_INITIALIZATION_ORIGIN = Object.freeze({
  type: "eduri.board.core-initialization",
});

export const BUILTIN_OBJECT_KINDS = Object.freeze({
  arrow: "eduri/arrow",
  code: "eduri/code",
  diamond: "eduri/diamond",
  ellipse: "eduri/ellipse",
  frame: "eduri/frame",
  image: "eduri/image",
  latex: "eduri/latex",
  line: "eduri/line",
  rectangle: "eduri/rectangle",
  stroke: "eduri/stroke",
  text: "eduri/text",
} as const);

export type BoardObjectKind = string;

export type AtomicTransform = readonly [
  x: number,
  y: number,
  width: number,
  height: number,
  rotation: number,
];

export type BoardObjectRecord = Y.Map<unknown>;
export type ManifestPageRecord = Y.Map<unknown>;

export interface BoardObjectInput {
  id: string;
  kind: BoardObjectKind;
  version: number;
  transform: AtomicTransform;
  zRank: string;
  parentId?: string | null;
  style?: Readonly<Record<string, unknown>>;
  props?: Readonly<Record<string, unknown>>;
}

export interface ManifestPageInput {
  id: string;
  name: string;
  rank: string;
  background?: Readonly<Record<string, unknown>>;
  grid?: Readonly<Record<string, unknown>>;
}

export interface BoardObjectView {
  id: string;
  kind: BoardObjectKind;
  version: number;
  transform: AtomicTransform;
  zRank: string;
  parentId: string | null;
  style: Y.Map<unknown>;
  props: Y.Map<unknown>;
}

export type BoardDocumentOptions = NonNullable<ConstructorParameters<typeof Y.Doc>[0]>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const NAMESPACED_KIND_PATTERN = /^[a-z][a-z0-9.-]*\/[a-z][a-z0-9.-]*$/u;
const KNOWN_MAP_ROOTS = new Set([
  MANIFEST_META_ROOT,
  MANIFEST_PAGES_ROOT,
  MANIFEST_EXTENSIONS_ROOT,
  MANIFEST_COMPONENTS_ROOT,
  PAGE_META_ROOT,
  PAGE_OBJECTS_ROOT,
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneBoardValue(value: unknown, path: string): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${path} must not contain a non-finite number`);
    }
    return value;
  }

  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof Y.AbstractType) return value;
  if (Array.isArray(value)) {
    return value.map((entry, index) => cloneBoardValue(entry, `${path}[${index}]`));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        cloneBoardValue(entry, `${path}.${key}`),
      ]),
    );
  }

  throw new TypeError(`${path} contains an unsupported value`);
}

function fillMap(
  target: Y.Map<unknown>,
  entries: Readonly<Record<string, unknown>> | undefined,
  path: string,
): void {
  for (const [key, value] of Object.entries(entries ?? {})) {
    if (!key) throw new TypeError(`${path} contains an empty key`);
    target.set(key, cloneBoardValue(value, `${path}.${key}`));
  }
}

export function assertStableUuid(value: string, label = "id"): void {
  if (!UUID_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a canonical UUID`);
  }
}

export function assertObjectKind(kind: string): void {
  if (!NAMESPACED_KIND_PATTERN.test(kind)) {
    throw new TypeError("Object kind must be a lowercase namespaced identifier");
  }
}

export function normalizeAtomicTransform(value: readonly number[]): AtomicTransform {
  if (value.length !== 5 || value.some((component) => !Number.isFinite(component))) {
    throw new TypeError("Transform must contain five finite numbers");
  }

  return Object.freeze([
    value[0],
    value[1],
    value[2],
    value[3],
    value[4],
  ]) as AtomicTransform;
}

export function createManifestDocument(options: BoardDocumentOptions = {}): Y.Doc {
  const doc = openManifestDocument(new Y.Doc(options));
  const meta = getManifestMeta(doc);

  doc.transact(() => {
    meta.set("documentKind", "manifest");
    meta.set("schemaVersion", BOARD_CORE_SCHEMA_VERSION);
  }, CORE_INITIALIZATION_ORIGIN);

  getManifestPages(doc);
  getManifestExtensions(doc);
  getManifestComponents(doc);
  return doc;
}

export function createPageDocument(pageId: string, options: BoardDocumentOptions = {}): Y.Doc {
  assertStableUuid(pageId, "pageId");
  const doc = openPageDocument(new Y.Doc(options));
  const meta = getPageMeta(doc);

  doc.transact(() => {
    meta.set("documentKind", "page");
    meta.set("schemaVersion", BOARD_CORE_SCHEMA_VERSION);
    meta.set("pageId", pageId);
  }, CORE_INITIALIZATION_ORIGIN);

  getPageObjects(doc);
  return doc;
}

export function openManifestDocument(doc = new Y.Doc()): Y.Doc {
  getManifestMeta(doc);
  getManifestPages(doc);
  getManifestExtensions(doc);
  getManifestComponents(doc);
  return doc;
}

export function openPageDocument(doc = new Y.Doc()): Y.Doc {
  getPageMeta(doc);
  getPageObjects(doc);
  return doc;
}

export function resolveKnownBoardRootTypes(doc: Y.Doc): void {
  for (const name of [...doc.share.keys()]) {
    if (KNOWN_MAP_ROOTS.has(name)) doc.getMap(name);
  }
}

export function getManifestMeta(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap<unknown>(MANIFEST_META_ROOT);
}

export function getManifestPages(doc: Y.Doc): Y.Map<ManifestPageRecord> {
  return doc.getMap<ManifestPageRecord>(MANIFEST_PAGES_ROOT);
}

export function getManifestExtensions(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap<unknown>(MANIFEST_EXTENSIONS_ROOT);
}

export function getManifestComponents(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap<unknown>(MANIFEST_COMPONENTS_ROOT);
}

export function getPageMeta(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap<unknown>(PAGE_META_ROOT);
}

export function getPageObjects(doc: Y.Doc): Y.Map<BoardObjectRecord> {
  return doc.getMap<BoardObjectRecord>(PAGE_OBJECTS_ROOT);
}

export function getPageId(doc: Y.Doc): string {
  const pageId = getPageMeta(doc).get("pageId");
  if (typeof pageId !== "string") throw new Error("Page document has no pageId");
  assertStableUuid(pageId, "pageId");
  return pageId;
}

export function createManifestPageRecord(input: ManifestPageInput): ManifestPageRecord {
  assertStableUuid(input.id, "page.id");
  if (!input.name.trim()) throw new TypeError("Page name must not be empty");
  if (!input.rank) throw new TypeError("Page rank must not be empty");

  const record = new Y.Map<unknown>();
  const background = new Y.Map<unknown>();
  const grid = new Y.Map<unknown>();
  fillMap(background, input.background, "page.background");
  fillMap(grid, input.grid, "page.grid");

  record.set("id", input.id);
  record.set("name", input.name);
  record.set("rank", input.rank);
  record.set("background", background);
  record.set("grid", grid);
  return record;
}

export function createBoardObject(input: BoardObjectInput): BoardObjectRecord {
  assertStableUuid(input.id, "object.id");
  assertObjectKind(input.kind);
  if (!Number.isSafeInteger(input.version) || input.version < 1) {
    throw new TypeError("Object version must be a positive safe integer");
  }
  if (!input.zRank) throw new TypeError("Object zRank must not be empty");
  if (input.parentId !== undefined && input.parentId !== null) {
    assertStableUuid(input.parentId, "object.parentId");
  }

  const record = new Y.Map<unknown>();
  const style = new Y.Map<unknown>();
  const props = new Y.Map<unknown>();
  fillMap(style, input.style, "object.style");
  fillMap(props, input.props, "object.props");

  record.set("id", input.id);
  record.set("kind", input.kind);
  record.set("version", input.version);
  record.set("transform", normalizeAtomicTransform(input.transform));
  record.set("zRank", input.zRank);
  record.set("parentId", input.parentId ?? null);
  record.set("style", style);
  record.set("props", props);
  return record;
}

export function readBoardObject(record: BoardObjectRecord): BoardObjectView {
  const id = record.get("id");
  const kind = record.get("kind");
  const version = record.get("version");
  const transform = record.get("transform");
  const zRank = record.get("zRank");
  const parentId = record.get("parentId");
  const style = record.get("style");
  const props = record.get("props");

  if (typeof id !== "string") throw new Error("Board object has no valid id");
  assertStableUuid(id, "object.id");
  if (typeof kind !== "string") throw new Error("Board object has no valid kind");
  assertObjectKind(kind);
  if (!Number.isSafeInteger(version) || (version as number) < 1) {
    throw new Error("Board object has no valid version");
  }
  if (!Array.isArray(transform)) throw new Error("Board object has no transform");
  if (typeof zRank !== "string" || !zRank) throw new Error("Board object has no valid zRank");
  if (parentId !== null && typeof parentId !== "string") {
    throw new Error("Board object has no valid parentId");
  }
  if (!(style instanceof Y.Map)) throw new Error("Board object has no style map");
  if (!(props instanceof Y.Map)) throw new Error("Board object has no props map");

  return {
    id,
    kind,
    version: version as number,
    transform: normalizeAtomicTransform(transform as number[]),
    zRank,
    parentId,
    style,
    props,
  };
}

export function createCollaborativeText(initialValue = ""): Y.Text {
  const text = new Y.Text();
  if (initialValue) text.insert(0, initialValue);
  return text;
}

export function createTextProps(text = ""): Readonly<Record<string, unknown>> {
  return { text: createCollaborativeText(text) };
}

export function createCodeProps(
  source = "",
  language = "plaintext",
  runnerProfile: string | null = null,
): Readonly<Record<string, unknown>> {
  return {
    source: createCollaborativeText(source),
    language,
    runnerProfile,
    outputSnapshot: null,
  };
}

export function createLatexProps(source = ""): Readonly<Record<string, unknown>> {
  return { source: createCollaborativeText(source) };
}

export function getCollaborativeText(
  record: BoardObjectRecord,
  property: string,
): Y.Text | undefined {
  const props = record.get("props");
  if (!(props instanceof Y.Map)) return undefined;
  const text = props.get(property);
  return text instanceof Y.Text ? text : undefined;
}

export function getStrokePoints(record: BoardObjectRecord): Uint8Array | undefined {
  const props = record.get("props");
  if (!(props instanceof Y.Map)) return undefined;
  const points = props.get("points");
  return points instanceof Uint8Array ? points.slice() : undefined;
}

export function cloneValueForBoard(value: unknown, path = "value"): unknown {
  return cloneBoardValue(value, path);
}

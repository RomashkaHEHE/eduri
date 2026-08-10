import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as Y from "yjs";
import {
  BoardControlCode,
  BoardPermission,
} from "../../board/protocol";
import {
  BUILTIN_OBJECT_KINDS,
  LocalUndoController,
  createLocalCommandOrigin,
  getPageObjects,
  openPageDocument,
} from "../../board/core";
import {
  BOARD_RECOVERY_MIME_TYPE,
  createBoardRecoveryBundleParts,
} from "../../board/persistence";
import { currentCsrfToken } from "../api";
import { requestDurableBrowserStorage } from "../offline";
import {
  BoardSurface,
  type BoardAwarenessState,
  type BoardConnectionStatus,
  type BoardImageInsertion,
  type BoardServerMetrics,
  type BoardSurfaceProps,
} from "./BoardSurface";
import {
  BOARD_METRICS_REFRESH_MS,
  fetchBoardServerMetrics,
} from "./boardMetrics";
import {
  getBoardCatalogEntry,
  putBoardCatalogEntry,
  registerBoardNamespace,
  type BoardCatalogEntry,
} from "./catalog";
import {
  AssetUploadCoordinator,
  BoardAssetOutbox,
  type AssetOutboxHealth,
} from "./assetOutbox";
import {
  BoardAssetHttpTransport,
  boardAssetContentUrl,
  parseAssetReadyControlPayload,
} from "./assetHttpTransport";
import { BoardIndexedDbStore } from "./localStore";
import {
  BOARD_IMAGE_HASH_PATTERN,
  BOARD_IMAGE_ID_PATTERN,
  validateBoardImageFile,
  validateForeignFragmentImageAssets,
} from "./localBoardAssets";
import {
  BoardNetworkProvider,
  type BoardProviderStatus,
  type BoardSocket,
} from "./networkProvider";
import {
  BOARD_BROWSER_CAPABILITIES,
  BoardTicketRequestError,
  createBootstrappedBoardTicketSource,
  createHttpBoardTicketSource,
  requestHttpBoardBootstrap,
  type BoardBootstrapTicket,
  type HttpBoardBootstrapOptions,
} from "./ticketSource";

export { browserImageDimensions } from "./localBoardAssets";
export { validateForeignFragmentImageAssets };
import type {
  BoardGesturePreview,
  BoardLaserClearMode,
  BoardLaserPreview,
  BoardLaserStroke,
  BoardPoint,
  BoardPresence,
  BoardTool,
} from "./rendering/types";
import {
  MAX_BOARD_GESTURE_PREVIEW_POINTS,
  MAX_BOARD_LASER_POINTS,
  sanitizeBoardGesturePreviewStyle,
  sanitizeBoardLaserPreview,
} from "./rendering/types";
import { boardObjectSnapshot } from "./rendering/objectSnapshot";
import type { LessonSummary } from "../../shared/types";

interface LessonBoardProps {
  readonly lessonId: string;
  readonly userId: string;
  readonly lesson: LessonSummary;
  readonly onCriticalDataRiskChange?: (active: boolean) => void;
}

interface GuestBoardProps {
  readonly shareId: string;
  readonly deviceId: string;
  readonly onCriticalDataRiskChange?: (active: boolean) => void;
  readonly onTerminal?: (kind: "expired" | "not-found") => void;
}

interface CollaborativeBoardProps {
  readonly cacheUserId: string;
  readonly cacheScopeId: string;
  readonly lesson?: LessonSummary;
  readonly ticketOptions: HttpBoardBootstrapOptions;
  readonly metricsLessonId?: string;
  readonly assetEndpoint?: string;
  readonly guest: boolean;
  readonly onCriticalDataRiskChange?: (active: boolean) => void;
  readonly onTerminal?: (kind: "expired" | "not-found") => void;
}

interface ActiveBoardSession {
  readonly bootstrap: BoardCatalogEntry;
  readonly document: Y.Doc;
  readonly store: BoardIndexedDbStore;
  readonly provider: BoardNetworkProvider;
  readonly assetOutbox: BoardAssetOutbox;
  readonly assetCoordinator: AssetUploadCoordinator;
  readonly assetRegistration: Promise<void>;
  readonly undo: LocalUndoController;
  readonly localOrigin: object;
  readonly initialPermissions: number;
  readonly assetObjectUrls: Map<string, {
    readonly sha256: string;
    readonly url: string;
  }>;
  readonly assetTasks: Set<Promise<unknown>>;
  readonly assetEndpoint?: string;
  closing: boolean;
}

type GateState =
  | { readonly kind: "checking" }
  | {
      readonly kind: "error";
      readonly title: string;
      readonly message: string;
      readonly retryable: boolean;
    }
  | { readonly kind: "active"; readonly session: ActiveBoardSession };

const BOARD_TICKET_ENDPOINT = "/api/board-v2/sync-ticket";
const BOARD_TOOLS = new Set<BoardTool>([
  "select",
  "hand",
  "pen",
  "highlighter",
  "eraser",
  "text",
  "line",
  "arrow",
  "rectangle",
  "ellipse",
  "diamond",
  "frame",
  "code",
  "latex",
  "image",
]);
const BOARD_GESTURE_TOOLS = new Set<BoardGesturePreview["kind"]>([
  "pen",
  "highlighter",
  "line",
  "arrow",
  "rectangle",
  "ellipse",
  "diamond",
  "frame",
]);

function boardGateFailure(
  error: unknown,
  guest = false,
): Extract<GateState, { kind: "error" }> {
  if (!(error instanceof BoardTicketRequestError)) {
    return {
      kind: "error",
      title: "Доска временно недоступна",
      message: error instanceof Error
        ? error.message
        : "Не удалось связаться с сервером доски",
      retryable: true,
    };
  }

  if (
    error.code === "PROTOCOL_MISMATCH"
    || error.code === "SCHEMA_MISMATCH"
    || error.status === 422
    || error.status === 426
  ) {
    return {
      kind: "error",
      title: "Нужно обновить Eduri",
      message:
        "Эта версия приложения несовместима с форматом доски. Обновите страницу после выхода новой версии Eduri.",
      retryable: false,
    };
  }

  if (error.code === "BOARD_NOT_V2" || error.status === 409) {
    return {
      kind: "error",
      title: "Доска не настроена",
      message:
        "Для этого урока не включена актуальная версия доски. Другая версия доски открыта не будет.",
      retryable: false,
    };
  }

  if (
    error.code === "NOT_FOUND"
    || error.status === 404
  ) {
    return {
      kind: "error",
      title: "Доска недоступна",
      message: guest
        ? "Комната не найдена или доска не добавлена в этот сеанс."
        : "Урок не найден или у вас больше нет доступа к его доске.",
      retryable: false,
    };
  }

  if (
    error.code === "SESSION_REVOKED"
    || error.status === 401
  ) {
    return {
      kind: "error",
      title: "Сессия завершена",
      message: "Войдите в Eduri заново, чтобы открыть доску.",
      retryable: false,
    };
  }

  if (
    error.code === "ACCESS_REVOKED"
    || error.status === 403
  ) {
    return {
      kind: "error",
      title: "Нет доступа к доске",
      message: "Доступ к этому уроку был отозван.",
      retryable: false,
    };
  }

  if (
    error.code === "BOARD_GONE"
    || error.status === 410
  ) {
    return {
      kind: "error",
      title: guest ? "Сеанс завершён" : "Доска больше недоступна",
      message: guest
        ? "Комната завершена после периода без активности."
        : "Эта доска была удалена или создана заново.",
      retryable: false,
    };
  }

  return {
    kind: "error",
    title: error.retryable
      ? "Доска временно недоступна"
      : "Не удалось открыть доску",
    message: error.code === "BOARD_V2_DISABLED"
      ? "Сервер доски временно отключён. Уже сохранённые данные останутся на устройстве."
      : error.message,
    retryable: error.retryable,
  };
}

function guestBoardTerminalKind(
  error: unknown,
): "expired" | "not-found" | null {
  if (!(error instanceof BoardTicketRequestError)) return null;
  if (error.code === "BOARD_GONE" || error.status === 410) return "expired";
  if (error.code === "NOT_FOUND" || error.status === 404) return "not-found";
  return null;
}

function browserSocket(url: string, subprotocol: string): BoardSocket {
  return new WebSocket(url, subprotocol) as unknown as BoardSocket;
}

function lessonTicketOptions(lessonId: string): HttpBoardBootstrapOptions {
  return {
    endpoint: BOARD_TICKET_ENDPOINT,
    lessonId,
    capabilities: BOARD_BROWSER_CAPABILITIES,
    csrfToken: currentCsrfToken,
    fetch: window.fetch.bind(window),
    baseUrl: window.location.href,
  };
}

function guestTicketOptions(
  shareId: string,
  deviceId: string,
): HttpBoardBootstrapOptions {
  return {
    endpoint: `/api/guest/rooms/${encodeURIComponent(shareId)}/board-ticket`,
    requestBody: {
      deviceId,
      minSchemaVersion: 1,
      maxSchemaVersion: 1,
      capabilities: BOARD_BROWSER_CAPABILITIES,
    },
    minSchemaVersion: 1,
    maxSchemaVersion: 1,
    capabilities: BOARD_BROWSER_CAPABILITIES,
    requireCsrf: false,
    fetch: window.fetch.bind(window),
    baseUrl: window.location.href,
  };
}

function catalogFromBootstrap(
  userId: string,
  cacheScopeId: string,
  lesson: LessonSummary | undefined,
  bootstrap: BoardBootstrapTicket,
): Omit<BoardCatalogEntry, "key" | "updatedAt"> {
  return {
    userId,
    lessonId: cacheScopeId,
    boardId: bootstrap.boardId,
    generation: bootstrap.generation,
    schemaVersion: bootstrap.schemaVersion,
    capabilities: bootstrap.capabilities,
    permissions: bootstrap.permissions,
    manifestDocumentKey: "manifest",
    pageId: bootstrap.defaultPageId,
    pageDocumentKey: bootstrap.defaultPageDocumentKey,
    lesson,
  };
}

function createSession(
  bootstrap: BoardCatalogEntry,
  options: HttpBoardBootstrapOptions,
  initialTicket?: BoardBootstrapTicket,
  assetEndpoint?: string,
): ActiveBoardSession {
  const document = openPageDocument(new Y.Doc());
  const localOrigin = createLocalCommandOrigin(crypto.randomUUID());
  const store = new BoardIndexedDbStore({
    userId: bootstrap.userId,
    boardId: bootstrap.boardId,
    generation: bootstrap.generation,
    documentKey: bootstrap.pageDocumentKey,
  }, document);
  const assetOutbox = new BoardAssetOutbox({
    userId: bootstrap.userId,
    boardId: bootstrap.boardId,
    generation: bootstrap.generation,
  });
  const assetRegistration = Promise.all([
    assetOutbox.whenReady(),
    registerBoardNamespace(
      {
        userId: bootstrap.userId,
        boardId: bootstrap.boardId,
        generation: bootstrap.generation,
      },
      assetOutbox.name,
    ),
  ]).then(() => undefined);
  const assetCoordinator = new AssetUploadCoordinator({
    outbox: assetOutbox,
    transport: new BoardAssetHttpTransport({
      boardId: bootstrap.boardId,
      generation: bootstrap.generation,
      csrfToken: currentCsrfToken,
      fetch: window.fetch.bind(window),
      endpoint: assetEndpoint,
    }),
  });
  const scope = {
    boardId: bootstrap.boardId,
    generation: bootstrap.generation,
    documentKey: bootstrap.pageDocumentKey,
  };
  const scopedOptions = {
    ...options,
    minSchemaVersion: bootstrap.schemaVersion,
    maxSchemaVersion: bootstrap.schemaVersion,
  };
  const ticketSource = initialTicket
    ? createBootstrappedBoardTicketSource(scopedOptions, scope, initialTicket)
    : createHttpBoardTicketSource({
        ...scopedOptions,
        scope,
      });
  const provider = new BoardNetworkProvider({
    document,
    scope,
    localStore: store,
    ticketSource,
    socketFactory: browserSocket,
    minSchemaVersion: bootstrap.schemaVersion,
    maxSchemaVersion: bootstrap.schemaVersion,
    capabilities: bootstrap.capabilities,
    onControl: (frame) => {
      if (
        frame.code !== BoardControlCode.ASSET_READY
        || frame.generation !== bootstrap.generation
      ) {
        return;
      }
      try {
        const event = parseAssetReadyControlPayload(frame.payload);
        void assetCoordinator.handleAssetReady(event).catch((error) => {
          console.error("Board asset ready event could not be persisted", error);
        });
      } catch (error) {
        console.error("Board asset ready event was invalid", error);
      }
    },
  });
  const undo = new LocalUndoController(document, localOrigin);
  return {
    bootstrap,
    document,
    store,
    provider,
    assetOutbox,
    assetCoordinator,
    assetRegistration,
    undo,
    localOrigin,
    initialPermissions: bootstrap.permissions,
    assetObjectUrls: new Map(),
    assetTasks: new Set(),
    assetEndpoint,
    closing: false,
  };
}

async function closeSession(session: ActiveBoardSession): Promise<void> {
  if (session.closing) return;
  session.closing = true;
  session.undo.dispose();
  session.assetCoordinator.stop();
  await session.provider.stop();
  await session.assetCoordinator.drain();
  while (session.assetTasks.size > 0) {
    await Promise.allSettled([...session.assetTasks]);
  }
  await session.store.flush().catch(() => undefined);
  await session.assetRegistration.catch(() => undefined);
  await session.assetOutbox.close().catch(() => undefined);
  await session.store.destroy().catch(() => undefined);
  for (const asset of session.assetObjectUrls.values()) {
    URL.revokeObjectURL(asset.url);
  }
  session.assetObjectUrls.clear();
  session.document.destroy();
}

function startSession(session: ActiveBoardSession): void {
  void session.assetRegistration.catch((error) => {
    console.error("Board asset outbox could not be initialized", error);
  });
  session.assetCoordinator.start();
  void session.provider.start();
}

function trackAssetTask<T>(
  session: ActiveBoardSession,
  operation: Promise<T>,
): Promise<T> {
  session.assetTasks.add(operation);
  void operation.finally(() => {
    session.assetTasks.delete(operation);
  }).catch(() => undefined);
  return operation;
}

async function insertSessionImage(
  session: ActiveBoardSession,
  file: File,
): Promise<BoardImageInsertion> {
  const operation = (async () => {
    const validated = await validateBoardImageFile(file);

    // enqueueLocal resolves only after both the source blob and its upload
    // state are committed to IndexedDB. BoardSurface creates the CRDT object
    // only after this promise resolves.
    const stored = await session.assetOutbox.enqueueLocal({
      blob: file,
      declaredMime: validated.mimeType,
      originalFileName: file.name,
    });
    session.assetCoordinator.wake();
    return {
      assetId: stored.assetId,
      contentHash: stored.sha256,
      mimeType: stored.declaredMime,
      width: validated.width,
      height: validated.height,
      originalBytes: stored.byteSize,
    };
  })();
  return trackAssetTask(session, operation);
}

async function resolveSessionAssetUrl(
  session: ActiveBoardSession,
  assetId: string,
  contentHash: string | null,
): Promise<string | null> {
  if (session.closing || !BOARD_IMAGE_ID_PATTERN.test(assetId)) return null;
  const operation = (async () => {
    const record = await session.assetOutbox.get(assetId);
    if (
      !record
      || (contentHash !== null && record.sha256 !== contentHash)
    ) {
      return null;
    }
    if (record.blob) {
      const cached = session.assetObjectUrls.get(assetId);
      if (cached?.sha256 === record.sha256) return cached.url;
      if (cached) URL.revokeObjectURL(cached.url);
      const url = URL.createObjectURL(record.blob);
      session.assetObjectUrls.set(assetId, {
        sha256: record.sha256,
        url,
      });
      return url;
    }
    if (record.state !== "ready") return null;
    return boardAssetContentUrl(
      {
        boardId: session.bootstrap.boardId,
        generation: session.bootstrap.generation,
      },
      assetId,
      session.assetEndpoint,
    );
  })();
  return trackAssetTask(session, operation);
}

function remoteImageIdentity(
  value: Y.Map<unknown>,
): {
  assetId: string;
  sha256: string;
  byteSize: number;
  declaredMime: string;
} | null {
  const object = boardObjectSnapshot(value);
  if (object.kind !== BUILTIN_OBJECT_KINDS.image) return null;
  const assetId = object.props.assetId;
  const sha256 = object.props.contentHash;
  const byteSize = object.props.originalBytes;
  const declaredMime = object.props.mimeType;
  if (
    typeof assetId !== "string"
    || !BOARD_IMAGE_ID_PATTERN.test(assetId)
    || typeof sha256 !== "string"
    || !BOARD_IMAGE_HASH_PATTERN.test(sha256)
    || typeof byteSize !== "number"
    || !Number.isSafeInteger(byteSize)
    || byteSize < 1
    || typeof declaredMime !== "string"
    || declaredMime.length < 3
  ) {
    return null;
  }
  return { assetId, sha256, byteSize, declaredMime };
}

function surfaceStatus(status: BoardProviderStatus): BoardConnectionStatus {
  if (status.localDurability === "at-risk") return "storage-error";
  if (status.connection === "recovery-required") return "recovery-required";
  if (status.connection === "loading-local") return "loading-cache";
  if (status.connection === "online" || status.connection === "read-only") {
    return status.pendingUpdateCount > 0 ? "pending" : "synced";
  }
  if (status.connection === "connecting" || status.connection === "authenticating") {
    return "connecting";
  }
  if (status.connection === "idle") return "connecting";
  return "offline";
}

function finitePoint(value: unknown): BoardPoint | undefined {
  if (
    !value
    || typeof value !== "object"
    || !("x" in value)
    || !("y" in value)
    || typeof value.x !== "number"
    || typeof value.y !== "number"
    || !Number.isFinite(value.x)
    || !Number.isFinite(value.y)
  ) {
    return undefined;
  }
  return { x: value.x, y: value.y };
}

function finitePoints(value: unknown): BoardPoint[] {
  if (!Array.isArray(value)) return [];
  const points: BoardPoint[] = [];
  for (const entry of value.slice(-MAX_BOARD_LASER_POINTS)) {
    const point = finitePoint(entry);
    if (point) points.push(point);
  }
  return points;
}

function laserPreviewFromGesture(value: unknown): BoardLaserPreview | undefined {
  if (
    value === null
    || typeof value !== "object"
    || !("kind" in value)
    || value.kind !== "laser"
  ) {
    return undefined;
  }

  if ("strokes" in value) {
    const segmented = sanitizeBoardLaserPreview(value);
    if (segmented) return segmented;
  }
  if (!("points" in value)) return undefined;
  const points = finitePoints(value.points);
  if (points.length === 0) return undefined;
  const style = "style" in value
    ? sanitizeBoardGesturePreviewStyle(value.style)
    : undefined;
  return {
    strokes: [{
      points,
      ...(style ? { style } : {}),
    }],
  };
}

function lastLaserPoint(preview: BoardLaserPreview): BoardPoint | undefined {
  for (let index = preview.strokes.length - 1; index >= 0; index -= 1) {
    const point = preview.strokes[index].points.at(-1);
    if (point) return point;
  }
  return undefined;
}

function copyLaserStrokes(
  preview: BoardLaserPreview,
): BoardLaserStroke[] {
  return preview.strokes.map((stroke) => ({
    points: stroke.points.map((point) => ({ ...point })),
    ...(stroke.style ? { style: { ...stroke.style } } : {}),
  }));
}

function remotePresences(
  provider: BoardNetworkProvider,
  pageId: string,
): BoardPresence[] {
  const ownId = provider.awareness.clientID;
  const result: BoardPresence[] = [];
  for (const [clientId, rawState] of provider.awareness.getStates()) {
    if (clientId === ownId || !rawState || typeof rawState !== "object") continue;
    const state = rawState as Record<string, unknown>;
    if (
      state.pageId !== undefined
      && state.pageId !== null
      && state.pageId !== pageId
    ) {
      continue;
    }
    if (
      typeof state.userId !== "string"
      || typeof state.displayName !== "string"
      || typeof state.color !== "string"
    ) {
      continue;
    }
    const laserPoint = finitePoint(state.laserPointer);
    const gesture = state.gesturePreview;
    const laserPreview = laserPreviewFromGesture(gesture)
      ?? (laserPoint
        ? { strokes: [{ points: [laserPoint, laserPoint] }] }
        : undefined);
    const gestureStyle = gesture
      && typeof gesture === "object"
      && "style" in gesture
        ? sanitizeBoardGesturePreviewStyle(gesture.style)
        : undefined;
    const gesturePreview =
      gesture
      && typeof gesture === "object"
      && "kind" in gesture
      && typeof gesture.kind === "string"
      && BOARD_GESTURE_TOOLS.has(gesture.kind as BoardGesturePreview["kind"])
      && "points" in gesture
        ? {
            kind: gesture.kind as BoardGesturePreview["kind"],
            points: finitePoints(gesture.points),
            ...(gestureStyle ? { style: gestureStyle } : {}),
          }
        : undefined;
    const activeTool = typeof state.activeTool === "string" && BOARD_TOOLS.has(state.activeTool as BoardTool)
      ? state.activeTool as BoardTool
      : undefined;
    const laserClearMode = state.laserClearMode === "fade"
      || state.laserClearMode === "immediate"
      ? state.laserClearMode as BoardLaserClearMode
      : undefined;
    const selectionIds = Array.isArray(state.selection)
      ? state.selection
          .filter((value): value is string => typeof value === "string")
          .slice(0, 256)
      : [];
    result.push({
      clientId,
      userId: state.userId,
      displayName: state.displayName,
      color: state.color,
      cursor: finitePoint(state.cursor),
      selectionIds,
      activeTool,
      gesturePreview:
        gesturePreview && gesturePreview.points.length > 0
          ? gesturePreview
          : undefined,
      laser: laserPreview,
      laserClearMode,
    });
  }
  return result;
}

function ActiveCollaborativeBoard({
  session,
  metricsLessonId,
  onCriticalDataRiskChange,
  onTerminal,
}: {
  session: ActiveBoardSession;
  metricsLessonId?: string;
  onCriticalDataRiskChange?: (active: boolean) => void;
  onTerminal?: (kind: "expired" | "not-found") => void;
}) {
  const [providerStatus, setProviderStatus] = useState(session.provider.status);
  const [presences, setPresences] = useState<readonly BoardPresence[]>([]);
  const [assetHealth, setAssetHealth] = useState<AssetOutboxHealth | null>(null);
  const [assetPersistenceAtRisk, setAssetPersistenceAtRisk] = useState(false);
  const [assetRefresh, setAssetRefresh] = useState<{
    readonly assetId: string;
    readonly revision: number;
  } | null>(null);
  const assetRevisionRef = useRef(0);
  const terminalReportedRef = useRef(false);
  const [serverMetrics, setServerMetrics] =
    useState<BoardServerMetrics | null>(null);
  const permissions = providerStatus.permissions || session.initialPermissions;
  const readOnly =
    providerStatus.connection === "recovery-required"
    || (permissions & BoardPermission.EDIT) === 0;
  const recoverableBlockedAssetCount =
    assetHealth?.blocked.filter((risk) => risk.hasLocalRecoveryCopy).length ?? 0;
  const dataAtRisk =
    providerStatus.localDurability === "at-risk"
    || providerStatus.connection === "recovery-required"
    || assetPersistenceAtRisk
    || recoverableBlockedAssetCount > 0;

  useEffect(() => session.provider.subscribe(setProviderStatus), [session]);

  useEffect(() => {
    if (
      terminalReportedRef.current
      || providerStatus.connection !== "recovery-required"
      || providerStatus.recovery?.reason !== "board-gone"
    ) {
      return;
    }
    terminalReportedRef.current = true;
    onTerminal?.("expired");
  }, [onTerminal, providerStatus.connection, providerStatus.recovery?.reason]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (session.provider.status.localDurability !== "writing") return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [session]);

  useEffect(() => {
    onCriticalDataRiskChange?.(dataAtRisk);
    return () => onCriticalDataRiskChange?.(false);
  }, [dataAtRisk, onCriticalDataRiskChange]);

  useEffect(() => {
    if (!metricsLessonId) {
      setServerMetrics(null);
      return;
    }
    if (
      providerStatus.connection !== "online"
      && providerStatus.connection !== "read-only"
    ) {
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      try {
        const next = await fetchBoardServerMetrics(
          metricsLessonId,
        );
        if (!cancelled) setServerMetrics(next);
      } catch {
        // Size is diagnostic information; transient failure never blocks work.
      }
    };
    void refresh();
    const timer = window.setInterval(
      () => void refresh(),
      BOARD_METRICS_REFRESH_MS,
    );
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [metricsLessonId, providerStatus.connection, session]);

  useEffect(() => {
    const refresh = () => setPresences(
      remotePresences(session.provider, session.bootstrap.pageId),
    );
    session.provider.awareness.on("change", refresh);
    refresh();
    return () => session.provider.awareness.off("change", refresh);
  }, [session]);

  useEffect(() => {
    let cancelled = false;
    let healthRequest = 0;
    const refreshHealth = async () => {
      const request = ++healthRequest;
      try {
        const next = await session.assetOutbox.health();
        if (!cancelled && request === healthRequest) {
          setAssetHealth(next);
          setAssetPersistenceAtRisk(false);
        }
      } catch {
        if (!cancelled && request === healthRequest) {
          setAssetPersistenceAtRisk(true);
        }
      }
    };
    const unsubscribe = session.assetOutbox.subscribe((event) => {
      assetRevisionRef.current += 1;
      setAssetRefresh({
        assetId: event.assetId,
        revision: assetRevisionRef.current,
      });
      void refreshHealth();
    });
    void refreshHealth();
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [session]);

  useEffect(() => {
    const objects = getPageObjects(session.document);
    const observed = new Set<string>();
    const identityByObject = new Map<string, {
      readonly assetId: string;
      readonly key: string;
    }>();
    const referenceCount = new Map<string, number>();
    const releaseObject = (objectId: string) => {
      const previous = identityByObject.get(objectId);
      if (!previous) return;
      identityByObject.delete(objectId);
      const remaining = (referenceCount.get(previous.assetId) ?? 1) - 1;
      if (remaining > 0) {
        referenceCount.set(previous.assetId, remaining);
        return;
      }
      referenceCount.delete(previous.assetId);
      const cached = session.assetObjectUrls.get(previous.assetId);
      if (cached) {
        URL.revokeObjectURL(cached.url);
        session.assetObjectUrls.delete(previous.assetId);
      }
    };
    const trackObject = (objectId: string) => {
      if (session.closing) return;
      const value = objects.get(objectId);
      let identity: ReturnType<typeof remoteImageIdentity> = null;
      try {
        if (value) identity = remoteImageIdentity(value);
      } catch {
        // A malformed object remains renderable as a safe placeholder.
      }
      const key = identity
        ? `${identity.assetId}:${identity.sha256}:${identity.byteSize}`
        : null;
      const previous = identityByObject.get(objectId);
      if (previous?.key === key) return;
      releaseObject(objectId);
      if (!identity || !key) return;
      identityByObject.set(objectId, { assetId: identity.assetId, key });
      referenceCount.set(
        identity.assetId,
        (referenceCount.get(identity.assetId) ?? 0) + 1,
      );
      if (observed.has(key)) return;
      observed.add(key);
      const tracked = trackAssetTask(
        session,
        session.assetOutbox.trackRemote(identity),
      );
      void tracked.then(() => {
        session.assetCoordinator.wake();
      }).catch((error) => {
        observed.delete(key);
        console.error("Remote board image could not be tracked", error);
      });
    };
    const observer = (
      events: readonly Y.YEvent<Y.AbstractType<unknown>>[],
    ) => {
      const changed = new Set<string>();
      for (const event of events) {
        if (typeof event.path[0] === "string") changed.add(event.path[0]);
        if (
          event.path.length === 0
          && event.target === objects
          && event instanceof Y.YMapEvent
        ) {
          for (const key of event.keysChanged) changed.add(key);
        }
      }
      for (const id of changed) trackObject(id);
    };
    objects.observeDeep(observer);
    for (const id of objects.keys()) trackObject(id);
    return () => {
      objects.unobserveDeep(observer);
      for (const id of [...identityByObject.keys()]) releaseObject(id);
    };
  }, [session]);

  const changeAwareness = useCallback((change: BoardAwarenessState) => {
    if ("selectionIds" in change && change.selectionIds) {
      session.provider.setSelection(change.selectionIds);
    }
    const laserPreview = "laser" in change && change.laser
      ? sanitizeBoardLaserPreview(change.laser)
      : undefined;
    session.provider.setPresence({
      cursor: "cursor" in change ? change.cursor ?? null : undefined,
      activeTool: "activeTool" in change ? change.activeTool ?? null : undefined,
      laserPointer: "laser" in change
        ? laserPreview ? lastLaserPoint(laserPreview) ?? null : null
        : undefined,
      laserClearMode: "laser" in change
        ? laserPreview
          ? null
          : change.laserClearMode ?? "fade"
        : undefined,
      gesturePreview: "laser" in change
        ? laserPreview
          ? {
              kind: "laser",
              strokes: copyLaserStrokes(laserPreview),
            }
          : null
        : "gesturePreview" in change
          ? change.gesturePreview
            ? {
                kind: change.gesturePreview.kind,
                points: change.gesturePreview.points.slice(
                  -MAX_BOARD_GESTURE_PREVIEW_POINTS,
                ),
                ...(change.gesturePreview.style
                  ? { style: change.gesturePreview.style }
                  : {}),
              }
            : null
          : undefined,
      pageId: session.bootstrap.pageId,
    });
  }, [session]);

  const insertImage = useCallback(
    (file: File) => insertSessionImage(session, file),
    [session],
  );
  const resolveAssetUrl = useCallback(
    (assetId: string, contentHash: string | null) =>
      resolveSessionAssetUrl(session, assetId, contentHash),
    [session],
  );
  const validateFragmentPaste = useCallback<
    NonNullable<BoardSurfaceProps["validateFragmentPaste"]>
  >(async (fragment, imageAssets) => {
    const sameAssetScope =
      fragment.scope.boardId === session.bootstrap.boardId
      && fragment.scope.generation === session.bootstrap.generation;
    if (imageAssets.unresolved.some(
      (asset) => asset.reason === "invalid-identity",
    )) {
      throw new Error("Фрагмент содержит повреждённую ссылку на изображение");
    }
    if (sameAssetScope) return;
    if (imageAssets.unresolved.length > 0) {
      throw new Error(
        "Изображение нового формата нельзя переносить между разными досками",
      );
    }

    await validateForeignFragmentImageAssets(
      session.assetOutbox,
      imageAssets.identities,
    );
  }, [session]);
  const exportRecovery = useCallback(async () => {
    const records = await session.assetOutbox.list().catch(() => []);
    const recoveryAssets = records.flatMap((record) => record.blob
      ? [{
          record,
          blob: record.blob,
        }]
      : []);
    const bundleParts = createBoardRecoveryBundleParts({
      identity: {
        boardId: session.bootstrap.boardId,
        lessonId: session.bootstrap.lessonId,
        generation: session.bootstrap.generation,
        schemaVersion: session.bootstrap.schemaVersion,
        documentKey: session.bootstrap.pageDocumentKey,
        pageId: session.bootstrap.pageId,
      },
      document: session.document,
      reason:
        providerStatus.recovery?.reason
        ?? (recoverableBlockedAssetCount > 0
          ? "asset-sync-risk"
          : "local-storage-at-risk"),
      pendingUpdateCount: providerStatus.pendingUpdateCount,
      assets: recoveryAssets.map(({ record, blob }) => ({
          assetId: record.assetId,
          sha256: record.sha256,
          mimeType: record.declaredMime,
          fileName: record.originalFileName,
          byteLength: blob.size,
        })),
    });
    const prefixParts = bundleParts.map((part) => {
      const copy = new Uint8Array(part.byteLength);
      copy.set(part);
      return copy.buffer;
    });
    const bundle = new Blob(
      [...prefixParts, ...recoveryAssets.map(({ blob }) => blob)],
      { type: BOARD_RECOVERY_MIME_TYPE },
    );
    const url = URL.createObjectURL(bundle);
    const link = window.document.createElement("a");
    link.href = url;
    link.download =
      `eduri-board-${session.bootstrap.boardId.slice(0, 8)}-${Date.now()}.eduri-board`;
    link.hidden = true;
    window.document.body.append(link);
    try {
      link.click();
    } finally {
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  }, [
    providerStatus.pendingUpdateCount,
    providerStatus.recovery?.reason,
    recoverableBlockedAssetCount,
    session,
  ]);

  return (
    <BoardSurface
      document={session.document}
      localOrigin={session.localOrigin}
      undo={session.undo}
      readOnly={readOnly}
      status={surfaceStatus(providerStatus)}
      pendingUpdates={providerStatus.pendingUpdateCount}
      presences={presences}
      serverMetrics={serverMetrics}
      assetHealth={assetHealth}
      assetPersistenceAtRisk={assetPersistenceAtRisk}
      assetRefresh={assetRefresh}
      insertImage={insertImage}
      resolveAssetUrl={resolveAssetUrl}
      onExportRecovery={exportRecovery}
      fragmentScope={{
        boardId: session.bootstrap.boardId,
        generation: session.bootstrap.generation,
        pageId: session.bootstrap.pageId,
      }}
      validateFragmentPaste={validateFragmentPaste}
      onAwarenessChange={changeAwareness}
    />
  );
}

function CollaborativeBoard({
  cacheUserId,
  cacheScopeId,
  lesson,
  ticketOptions,
  metricsLessonId,
  assetEndpoint,
  guest,
  onCriticalDataRiskChange,
  onTerminal,
}: CollaborativeBoardProps) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<GateState>({ kind: "checking" });
  const activeRef = useRef<ActiveBoardSession | null>(null);
  const lessonRef = useRef(lesson);
  const onTerminalRef = useRef(onTerminal);
  lessonRef.current = lesson;
  onTerminalRef.current = onTerminal;

  useEffect(() => {
    let cancelled = false;
    let created: ActiveBoardSession | null = null;
    setState({ kind: "checking" });

    const activate = async () => {
      let cached: BoardCatalogEntry | null = null;
      try {
        cached = await getBoardCatalogEntry(cacheUserId, cacheScopeId);
      } catch (error) {
        console.error("Board catalog could not be read", error);
      }
      if (cancelled) return;

      if (cached) {
        const refreshedCache: BoardCatalogEntry = {
          ...cached,
          lesson: lessonRef.current,
          updatedAt: new Date().toISOString(),
        };
        cached = refreshedCache;
        void putBoardCatalogEntry({
          userId: refreshedCache.userId,
          lessonId: refreshedCache.lessonId,
          boardId: refreshedCache.boardId,
          generation: refreshedCache.generation,
          schemaVersion: refreshedCache.schemaVersion,
          capabilities: refreshedCache.capabilities,
          permissions: refreshedCache.permissions,
          manifestDocumentKey: refreshedCache.manifestDocumentKey,
          pageId: refreshedCache.pageId,
          pageDocumentKey: refreshedCache.pageDocumentKey,
          lesson: lessonRef.current,
        }).catch(() => undefined);
        created = createSession(cached, ticketOptions, undefined, assetEndpoint);
        activeRef.current = created;
        setState({ kind: "active", session: created });
        void requestDurableBrowserStorage().catch(() => undefined);
        startSession(created);
        return;
      }

      try {
        const bootstrap = await requestHttpBoardBootstrap(ticketOptions);
        const catalogInput = catalogFromBootstrap(
          cacheUserId,
          cacheScopeId,
          lessonRef.current,
          bootstrap,
        );
        let catalog: BoardCatalogEntry;
        try {
          catalog = await putBoardCatalogEntry(catalogInput);
        } catch (error) {
          console.error("Board catalog could not be persisted", error);
          catalog = {
            ...catalogInput,
            key: `${cacheUserId}:${cacheScopeId}`,
            updatedAt: new Date().toISOString(),
          };
        }
        if (cancelled) return;
        created = createSession(
          catalog,
          ticketOptions,
          bootstrap,
          assetEndpoint,
        );
        activeRef.current = created;
        setState({ kind: "active", session: created });
        void requestDurableBrowserStorage().catch(() => undefined);
        startSession(created);
      } catch (error) {
        if (cancelled) return;
        if (guest) {
          const terminalKind = guestBoardTerminalKind(error);
          if (terminalKind) onTerminalRef.current?.(terminalKind);
        }
        setState(boardGateFailure(error, guest));
      }
    };
    void activate();

    return () => {
      cancelled = true;
      const session = created ?? activeRef.current;
      if (session) {
        activeRef.current = null;
        void closeSession(session);
      }
    };
  }, [
    assetEndpoint,
    attempt,
    cacheScopeId,
    cacheUserId,
    guest,
    ticketOptions,
  ]);

  if (state.kind === "checking") {
    return <div className="board-v2-gate"><span className="spinner" /></div>;
  }
  if (state.kind === "error") {
    return (
      <div className="board-v2-gate board-v2-gate--error">
        <strong>{state.title}</strong>
        <span>{state.message}</span>
        {state.retryable && (
          <button
            type="button"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Повторить
          </button>
        )}
      </div>
    );
  }
  return (
    <ActiveCollaborativeBoard
      session={state.session}
      metricsLessonId={metricsLessonId}
      onCriticalDataRiskChange={onCriticalDataRiskChange}
      onTerminal={onTerminal}
    />
  );
}

export function LessonBoard({
  lessonId,
  userId,
  lesson,
  onCriticalDataRiskChange,
}: LessonBoardProps) {
  const options = useMemo(
    () => lessonTicketOptions(lessonId),
    [lessonId],
  );
  return (
    <CollaborativeBoard
      cacheUserId={userId}
      cacheScopeId={lessonId}
      lesson={lesson}
      ticketOptions={options}
      metricsLessonId={lessonId}
      guest={false}
      onCriticalDataRiskChange={onCriticalDataRiskChange}
    />
  );
}

export function GuestBoard({
  shareId,
  deviceId,
  onCriticalDataRiskChange,
  onTerminal,
}: GuestBoardProps) {
  const options = useMemo(
    () => guestTicketOptions(shareId, deviceId),
    [deviceId, shareId],
  );
  return (
    <CollaborativeBoard
      cacheUserId={`guest-device:${deviceId}`}
      cacheScopeId={`guest-room:${shareId}`}
      ticketOptions={options}
      assetEndpoint={
        `/api/guest/rooms/${encodeURIComponent(shareId)}/board-assets`
      }
      guest
      onCriticalDataRiskChange={onCriticalDataRiskChange}
      onTerminal={onTerminal}
    />
  );
}

// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { LessonSummary } from "../../shared/types";
import type {
  BoardAwarenessState,
  BoardSurfaceProps,
} from "./BoardSurface";
import type {
  BoardLocalPresence,
  BoardProviderStatus,
} from "./networkProvider";
import {
  MAX_BOARD_LASER_POINTS,
  MAX_BOARD_LASER_STROKES,
  type BoardLaserClearMode,
  type BoardPoint,
} from "./rendering/types";
import type { AssetOutboxRecord } from "./assetOutbox";

interface FakeAwarenessState {
  readonly userId?: string;
  readonly displayName?: string;
  readonly color?: string;
  readonly pageId?: string | null;
  readonly activeTool?: string;
  readonly viewport?: unknown;
  readonly laserPointer?: BoardPoint | null;
  readonly laserClearMode?: BoardLaserClearMode | null;
  readonly gesturePreview?: {
    readonly kind: string;
    readonly points?: readonly unknown[];
    readonly style?: unknown;
    readonly strokes?: readonly {
      readonly points: readonly unknown[];
      readonly style?: unknown;
    }[];
  } | null;
}

class FakeAwareness {
  clientID = 77;
  readonly states = new Map<number, FakeAwarenessState>([[77, {}]]);
  private readonly listeners = new Set<() => void>();

  getStates(): Map<number, FakeAwarenessState> {
    return this.states;
  }

  on(event: string, listener: () => void): void {
    if (event === "change") this.listeners.add(listener);
  }

  off(event: string, listener: () => void): void {
    if (event === "change") this.listeners.delete(listener);
  }

  emitChange(): void {
    for (const listener of this.listeners) listener();
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

interface FakeProvider {
  status: BoardProviderStatus;
  readonly awareness: FakeAwareness;
  readonly presenceCalls: BoardLocalPresence[];
  readonly selectionCalls: readonly string[][];
  readonly subscribers: Set<(status: BoardProviderStatus) => void>;
  readonly updateProfile: ReturnType<typeof vi.fn>;
  start(): Promise<void>;
  stop(): Promise<void>;
  subscribe(listener: (status: BoardProviderStatus) => void): () => void;
  setPresence(presence: BoardLocalPresence): void;
  setSelection(selection: readonly string[]): void;
  emitConnection(connection: BoardProviderStatus["connection"]): void;
  emitStatus(status: Partial<BoardProviderStatus>): void;
}

const mocks = vi.hoisted(() => ({
  initialConnection: "online" as BoardProviderStatus["connection"],
  providers: [] as FakeProvider[],
  surfaceProps: undefined as BoardSurfaceProps | undefined,
  getCatalogEntry: vi.fn(),
  putCatalogEntry: vi.fn(),
  registerNamespace: vi.fn(),
}));

vi.mock("./BoardSurface", () => ({
  BoardSurface: (props: BoardSurfaceProps) => {
    mocks.surfaceProps = props;
    return null;
  },
}));

vi.mock("./catalog", () => ({
  getBoardCatalogEntry: mocks.getCatalogEntry,
  putBoardCatalogEntry: mocks.putCatalogEntry,
  registerBoardNamespace: mocks.registerNamespace,
}));

vi.mock("../api", () => ({
  currentCsrfToken: () => "test-csrf-token",
}));

vi.mock("./localStore", () => ({
  BoardIndexedDbStore: class {
    readonly flush = vi.fn(async () => undefined);
    readonly destroy = vi.fn(async () => undefined);
  },
}));

vi.mock("./assetOutbox", () => ({
  BoardAssetOutbox: class {
    readonly name = "eduri-board-v2-assets-test";
    readonly whenReady = vi.fn(async () => undefined);
    readonly close = vi.fn(async () => undefined);
    readonly trackRemote = vi.fn(async () => undefined);
    readonly subscribe = vi.fn(() => () => undefined);
    readonly health = vi.fn(async () => ({
      pendingLocalCount: 0,
      pendingRemoteCount: 0,
      readyCount: 0,
      blocked: [],
    }));
    readonly list = vi.fn(async () => []);
  },
  AssetUploadCoordinator: class {
    readonly start = vi.fn();
    readonly stop = vi.fn();
    readonly drain = vi.fn(async () => undefined);
    readonly wake = vi.fn();
    readonly handleAssetReady = vi.fn(async () => undefined);
  },
}));

vi.mock("./networkProvider", () => ({
  BoardNetworkProvider: class implements FakeProvider {
    status: BoardProviderStatus = {
      connection: mocks.initialConnection,
      localDurability: "ready",
      pendingUpdateCount: 0,
      pendingUpdateBytes: 0,
      permissions: 3,
      lastDurableSequence: 0,
      recovery: null,
      lastError: null,
    };
    readonly awareness = new FakeAwareness();
    readonly presenceCalls: BoardLocalPresence[] = [];
    readonly selectionCalls: string[][] = [];
    readonly subscribers = new Set<(status: BoardProviderStatus) => void>();
    readonly updateProfile = vi.fn();

    constructor() {
      mocks.providers.push(this);
    }

    async start(): Promise<void> {}

    async stop(): Promise<void> {}

    subscribe(listener: (status: BoardProviderStatus) => void): () => void {
      this.subscribers.add(listener);
      return () => this.subscribers.delete(listener);
    }

    setPresence(presence: BoardLocalPresence): void {
      this.presenceCalls.push(presence);
    }

    setSelection(selection: readonly string[]): void {
      this.selectionCalls.push([...selection]);
    }

    emitConnection(connection: BoardProviderStatus["connection"]): void {
      this.emitStatus({ connection });
    }

    emitStatus(status: Partial<BoardProviderStatus>): void {
      this.status = { ...this.status, ...status };
      for (const listener of this.subscribers) listener(this.status);
    }
  },
}));

vi.mock("../offline", () => ({
  requestDurableBrowserStorage: vi.fn(async () => true),
}));

import { BOARD_METRICS_REFRESH_MS } from "./boardMetrics";
import {
  GuestBoard,
  LessonBoard,
  browserImageDimensions,
  validateForeignFragmentImageAssets,
} from "./LessonBoard";

const LESSON: LessonSummary = {
  id: "lesson-1",
  title: "Алгебра",
  studentId: "student-1",
  studentName: "Артём",
  scheduledAt: "2026-07-28T12:00:00.000Z",
  durationMinutes: 60,
  status: "active",
};

const PROFILE = {
  displayName: "Board user",
  color: "#2563eb" as const,
};

const CATALOG = {
  key: "user-1:lesson-1",
  userId: "user-1",
  lessonId: "lesson-1",
  boardId: "board-1",
  generation: 1,
  schemaVersion: 1,
  capabilities: 0,
  permissions: 3,
  manifestDocumentKey: "manifest" as const,
  pageId: "00000000-0000-4000-8000-000000000201",
  pageDocumentKey: "page:default",
  lesson: LESSON,
  updatedAt: "2026-07-28T12:00:00.000Z",
};

function assetRecord(
  overrides: Partial<AssetOutboxRecord> = {},
): AssetOutboxRecord {
  return {
    assetId: "asset-1",
    revision: 1,
    source: "local",
    state: "ready",
    sha256: "a".repeat(64),
    byteSize: 123,
    declaredMime: "image/png",
    originalFileName: "image.png",
    blob: new Blob([Uint8Array.of(1)], { type: "image/png" }),
    uploadId: null,
    nextOffset: 0,
    chunkBytes: null,
    attemptCount: 0,
    nextAttemptAt: 0,
    lastErrorCode: null,
    createdAt: 1,
    updatedAt: 1,
    published: null,
    ...overrides,
  };
}

function metricsResponse(measuredAt: string): Response {
  return new Response(JSON.stringify({
    updateLogCount: 2,
    updateLogBytes: 20,
    assetCount: 1,
    assetBytes: 100,
    logicalBytes: 120,
    physicalBytes: 110,
    compactedAt: null,
    measuredAt,
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function ticketErrorResponse(
  status: number,
  code: string,
  error: string,
): Response {
  return new Response(JSON.stringify({ code, error }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function bootstrapResponse(): Response {
  return new Response(JSON.stringify({
    ticket: "initial-ticket",
    expiresAt: "2030-01-01T00:00:00.000Z",
    boardId: CATALOG.boardId,
    generation: CATALOG.generation,
    protocolVersion: 1,
    schemaVersion: CATALOG.schemaVersion,
    capabilities: CATALOG.capabilities,
    permissions: CATALOG.permissions,
    manifestDocKey: CATALOG.manifestDocumentKey,
    defaultPageId: CATALOG.pageId,
    defaultPageDocKey: CATALOG.pageDocumentKey,
    websocketPath: "/api/board-v2/sync",
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  });
}

async function renderLessonBoard(): Promise<void> {
  await act(async () => {
    root?.render(createElement(LessonBoard, {
      lessonId: LESSON.id,
      userId: CATALOG.userId,
      lesson: LESSON,
      profile: PROFILE,
    }));
  });
  await settle();
  expect(mocks.providers).toHaveLength(1);
  expect(mocks.surfaceProps).toBeDefined();
}

async function renderUncachedLessonBoard(): Promise<void> {
  await act(async () => {
    root?.render(createElement(LessonBoard, {
      lessonId: LESSON.id,
      userId: CATALOG.userId,
      lesson: LESSON,
      profile: PROFILE,
    }));
  });
  await settle();
}

let container: HTMLDivElement | undefined;
let root: Root | undefined;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-28T12:00:00.000Z"));
  mocks.initialConnection = "online";
  mocks.providers.length = 0;
  mocks.surfaceProps = undefined;
  mocks.getCatalogEntry.mockReset().mockResolvedValue(CATALOG);
  mocks.putCatalogEntry.mockReset().mockResolvedValue(CATALOG);
  mocks.registerNamespace.mockReset().mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
  }
  root = undefined;
  container?.remove();
  container = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("LessonBoard clipboard image guards", () => {
  it("falls back to HTMLImageElement when createImageBitmap cannot decode", async () => {
    const createObjectURL = vi.fn(() => "blob:test-image");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("createImageBitmap", vi.fn().mockRejectedValue(
      new Error("unsupported decoder path"),
    ));
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    vi.stubGlobal("Image", class {
      naturalWidth = 640;
      naturalHeight = 480;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      set src(_value: string) {
        this.onload?.();
      }
    });

    await expect(browserImageDimensions(new File(
      [Uint8Array.of(1)],
      "fallback.png",
      { type: "image/png" },
    ))).resolves.toEqual({ width: 640, height: 480 });
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:test-image");
  });

  it("deduplicates repeated foreign references before durable lookup", async () => {
    const get = vi.fn(async () => assetRecord());
    const identities: Parameters<
      typeof validateForeignFragmentImageAssets
    >[1] = [
      {
        objectId: "image-1",
        assetId: "asset-1",
        contentHash: "a".repeat(64),
        mimeType: "image/png",
        originalBytes: 123,
      },
      {
        objectId: "image-2",
        assetId: "asset-1",
        contentHash: "a".repeat(64),
        mimeType: "image/png",
        originalBytes: 123,
      },
    ];

    await expect(validateForeignFragmentImageAssets(
      { get },
      identities,
    )).resolves.toBeUndefined();
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("asset-1");
  });

  it("rejects conflicting identities for one foreign asset before lookup", async () => {
    const get = vi.fn(async () => assetRecord());
    const identities: Parameters<
      typeof validateForeignFragmentImageAssets
    >[1] = [
      {
        objectId: "image-1",
        assetId: "asset-1",
        contentHash: "a".repeat(64),
        mimeType: "image/png",
        originalBytes: 123,
      },
      {
        objectId: "image-2",
        assetId: "asset-1",
        contentHash: "b".repeat(64),
        mimeType: "image/png",
        originalBytes: 123,
      },
    ];

    await expect(validateForeignFragmentImageAssets(
      { get },
      identities,
    )).rejects.toThrow(/противоречивые/u);
    expect(get).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "hash",
      record: assetRecord({ sha256: "b".repeat(64) }),
    },
    {
      label: "byte count",
      record: assetRecord({ byteSize: 124 }),
    },
    {
      label: "MIME",
      record: assetRecord({ declaredMime: "image/jpeg" }),
    },
    {
      label: "durability",
      record: assetRecord({ blob: null, state: "pending" }),
    },
  ])("rejects a foreign image with mismatched $label", async ({ record }) => {
    const get = vi.fn(async () => record);

    await expect(validateForeignFragmentImageAssets(
      { get },
      [{
        objectId: "image-1",
        assetId: "asset-1",
        contentHash: "a".repeat(64),
        mimeType: "image/png",
        originalBytes: 123,
      }],
    )).rejects.toThrow(/Сначала импортируйте/u);
  });
});

describe("LessonBoard Board v2-only gate", () => {
  it.each([
    {
      status: 404,
      code: "NOT_FOUND",
      expectedTitle: "Доска недоступна",
    },
    {
      status: 409,
      code: "BOARD_NOT_V2",
      expectedTitle: "Доска не настроена",
    },
  ])(
    "does not mount the legacy board for $status/$code",
    async ({ status, code, expectedTitle }) => {
      mocks.getCatalogEntry.mockResolvedValue(null);
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>().mockResolvedValue(
          ticketErrorResponse(status, code, "Server detail"),
        ),
      );

      await renderUncachedLessonBoard();

      expect(container?.textContent).toContain(expectedTitle);
      expect(container?.querySelector("button")).toBeNull();
      expect(mocks.providers).toHaveLength(0);
    },
  );

  it.each([
    { status: 422, code: "SCHEMA_MISMATCH" },
    { status: 426, code: "PROTOCOL_MISMATCH" },
  ])(
    "shows a non-retryable compatibility state for $code",
    async ({ status, code }) => {
      mocks.getCatalogEntry.mockResolvedValue(null);
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>().mockResolvedValue(
          ticketErrorResponse(status, code, "Incompatible Board client"),
        ),
      );

      await renderUncachedLessonBoard();

      expect(container?.textContent).toContain("Нужно обновить Eduri");
      expect(container?.querySelector("button")).toBeNull();
      expect(mocks.providers).toHaveLength(0);
    },
  );

  it("retries a temporary Board v2 outage and activates v2 when it returns", async () => {
    mocks.getCatalogEntry.mockResolvedValue(null);
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(ticketErrorResponse(
        503,
        "BOARD_V2_DISABLED",
        "Board v2 is temporarily disabled",
      ))
      .mockResolvedValueOnce(bootstrapResponse())
      .mockResolvedValue(metricsResponse("2026-07-28T12:00:00.000Z"));
    vi.stubGlobal("fetch", fetchMock);

    await renderUncachedLessonBoard();

    expect(container?.textContent).toContain("Доска временно недоступна");
    const retry = container?.querySelector("button");
    expect(retry?.textContent).toContain("Повторить");

    await act(async () => {
      retry?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(mocks.providers).toHaveLength(1);
    expect(mocks.surfaceProps).toBeDefined();
  });
});

describe("LessonBoard background metrics", () => {
  it("updates the profile without replacing the board session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        metricsResponse("2026-07-28T12:00:00.000Z"),
      ),
    );
    await renderLessonBoard();
    const provider = mocks.providers[0];
    const surfaceDocument = mocks.surfaceProps?.document;

    await act(async () => {
      root?.render(createElement(LessonBoard, {
        lessonId: LESSON.id,
        userId: CATALOG.userId,
        lesson: LESSON,
        profile: { displayName: "Updated user", color: "#d33f49" },
      }));
    });
    await settle();

    expect(mocks.providers).toHaveLength(1);
    expect(mocks.providers[0]).toBe(provider);
    expect(mocks.surfaceProps?.document).toBe(surfaceDocument);
    expect(provider?.updateProfile).toHaveBeenCalledOnce();
    expect(provider?.updateProfile).toHaveBeenCalledWith({
      displayName: "Updated user",
      color: "#d33f49",
    });
  });

  it("polls every 30 seconds only while online and cleans up on unmount", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockImplementation(async () => metricsResponse(
        new Date(Date.now()).toISOString(),
      ));
    vi.stubGlobal("fetch", fetchMock);

    await renderLessonBoard();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.surfaceProps?.serverMetrics?.syncedAt)
      .toBe("2026-07-28T12:00:00.000Z");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(BOARD_METRICS_REFRESH_MS - 1);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const provider = mocks.providers[0];
    await act(async () => provider.emitConnection("offline"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BOARD_METRICS_REFRESH_MS * 2);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => provider.emitConnection("read-only"));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await act(async () => root?.unmount());
    root = undefined;
    expect(provider.subscribers.size).toBe(0);
    expect(provider.awareness.listenerCount).toBe(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BOARD_METRICS_REFRESH_MS * 2);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not start metrics requests for an offline session", async () => {
    mocks.initialConnection = "offline";
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await renderLessonBoard();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BOARD_METRICS_REFRESH_MS * 2);
    });
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => mocks.providers[0].emitConnection("online"));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("LessonBoard local durability", () => {
  it("guards a browser unload only while a local update is still being queued", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        metricsResponse("2026-07-28T12:00:00.000Z"),
      ),
    );
    await renderLessonBoard();
    const provider = mocks.providers[0];
    provider.status = {
      ...provider.status,
      localDurability: "writing",
      pendingUpdateCount: 1,
    };

    const writingUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(writingUnload);
    expect(writingUnload.defaultPrevented).toBe(true);

    provider.status = {
      ...provider.status,
      localDurability: "ready",
    };
    const durableUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(durableUnload);
    expect(durableUnload.defaultPrevented).toBe(false);
  });
});

describe("LessonBoard laser awareness", () => {
  it("maps local and sanitized remote camera awareness", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        metricsResponse("2026-07-28T12:00:00.000Z"),
      ),
    );
    await renderLessonBoard();
    const provider = mocks.providers[0];
    const localViewport = { x: 120, y: -45, zoom: 0.5 } as const;

    await act(async () => {
      mocks.surfaceProps?.onAwarenessChange?.({ viewport: localViewport });
    });
    expect(provider.presenceCalls.at(-1)).toMatchObject({
      pageId: CATALOG.pageId,
      viewport: localViewport,
    });

    provider.awareness.states.set(88, {
      userId: "tutor-2",
      displayName: "Преподаватель",
      color: "#006d77",
      pageId: CATALOG.pageId,
      viewport: { x: 25, y: 35, zoom: 0.005 },
    });
    await act(async () => provider.awareness.emitChange());
    expect(mocks.surfaceProps?.presences?.[0]?.viewport).toEqual({
      x: 25,
      y: 35,
      zoom: 0.02,
    });

    provider.awareness.states.set(88, {
      userId: "tutor-2",
      displayName: "Преподаватель",
      color: "#006d77",
      pageId: CATALOG.pageId,
      viewport: { x: 25, y: 35, zoom: Number.NaN },
    });
    await act(async () => provider.awareness.emitChange());
    expect(mocks.surfaceProps?.presences?.[0]?.viewport).toBeUndefined();
  });

  it("bounds and maps segmented laser awareness while accepting legacy peers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        metricsResponse("2026-07-28T12:00:00.000Z"),
      ),
    );
    await renderLessonBoard();
    const provider = mocks.providers[0];
    const points = Array.from({ length: 300 }, (_, index) => ({
      x: index,
      y: index * 2,
    }));
    const localStrokes = [
      {
        points: points.slice(0, 180),
        style: {
          stroke: "#315efb",
          strokeWidth: 5,
          opacity: 0.8,
        },
      },
      {
        points: points.slice(180),
        style: {
          stroke: "#d33f49",
          strokeWidth: 9,
          opacity: 0.6,
        },
      },
    ];
    const retainedFirstStrokePoints = Math.max(
      0,
      MAX_BOARD_LASER_POINTS - localStrokes[1].points.length,
    );
    const boundedStrokes = [
      {
        ...localStrokes[0],
        points: points.slice(180 - retainedFirstStrokePoints, 180),
      },
      localStrokes[1],
    ];

    await act(async () => {
      mocks.surfaceProps?.onAwarenessChange?.({
        laser: { strokes: localStrokes },
      } satisfies BoardAwarenessState);
    });
    expect(provider.presenceCalls.at(-1)).toMatchObject({
      laserPointer: points.at(-1),
      gesturePreview: {
        kind: "laser",
        strokes: boundedStrokes,
      },
      laserClearMode: null,
      pageId: CATALOG.pageId,
    });

    provider.awareness.states.set(88, {
      userId: "tutor-2",
      displayName: "Преподаватель",
      color: "#006d77",
      pageId: CATALOG.pageId,
      laserPointer: points.at(-1),
      gesturePreview: {
        kind: "laser",
        strokes: localStrokes,
      },
    });
    await act(async () => provider.awareness.emitChange());

    expect(mocks.surfaceProps?.presences).toHaveLength(1);
    expect(mocks.surfaceProps?.presences?.[0]).toMatchObject({
      clientId: 88,
      userId: "tutor-2",
      displayName: "Преподаватель",
      laser: {
        strokes: boundedStrokes,
      },
    });

    const numerousStrokes = Array.from(
      { length: MAX_BOARD_LASER_STROKES + 4 },
      (_, index) => ({
        points: [{ x: index, y: -index }],
        style: {
          stroke: "#315efb",
          strokeWidth: 5,
          opacity: 0.8,
        },
      }),
    );
    provider.awareness.states.set(88, {
      userId: "tutor-2",
      displayName: "Преподаватель",
      color: "#006d77",
      pageId: CATALOG.pageId,
      gesturePreview: {
        kind: "laser",
        strokes: numerousStrokes,
      },
    });
    await act(async () => provider.awareness.emitChange());
    const cappedStrokes = mocks.surfaceProps?.presences?.[0]?.laser?.strokes;
    expect(cappedStrokes).toHaveLength(MAX_BOARD_LASER_STROKES);
    expect(cappedStrokes?.[0]?.points).toEqual([{ x: 4, y: -4 }]);
    expect(cappedStrokes?.at(-1)?.points).toEqual([{ x: 19, y: -19 }]);

    provider.awareness.states.set(88, {
      userId: "tutor-2",
      displayName: "Преподаватель",
      color: "#006d77",
      pageId: CATALOG.pageId,
      laserPointer: points.at(-1),
      gesturePreview: {
        kind: "laser",
        points,
        style: {
          stroke: "rgb(10, 20, 30)",
          strokeWidth: 1_000,
          opacity: -1,
        },
      },
    });
    await act(async () => provider.awareness.emitChange());
    expect(mocks.surfaceProps?.presences?.[0]?.laser?.strokes).toEqual([{
      points: points.slice(-MAX_BOARD_LASER_POINTS),
      style: {
        stroke: "rgb(10,20,30)",
        strokeWidth: 96,
        opacity: 0,
      },
    }]);

    provider.awareness.states.set(88, {
      userId: "tutor-2",
      displayName: "Преподаватель",
      color: "#006d77",
      pageId: CATALOG.pageId,
      laserPointer: { x: 71, y: 72 },
      gesturePreview: null,
    });
    await act(async () => provider.awareness.emitChange());
    expect(mocks.surfaceProps?.presences?.[0]?.laser?.strokes).toEqual([{
      points: [{ x: 71, y: 72 }, { x: 71, y: 72 }],
    }]);

    await act(async () => {
      mocks.surfaceProps?.onAwarenessChange?.({
        laser: null,
        laserClearMode: "immediate",
      });
    });
    expect(provider.presenceCalls.at(-1)).toMatchObject({
      laserPointer: null,
      laserClearMode: "immediate",
      gesturePreview: null,
      pageId: CATALOG.pageId,
    });

    provider.awareness.states.set(88, {
      userId: "tutor-2",
      displayName: "Преподаватель",
      color: "#006d77",
      pageId: CATALOG.pageId,
      laserPointer: null,
      laserClearMode: "immediate",
      gesturePreview: null,
    });
    await act(async () => provider.awareness.emitChange());
    expect(mocks.surfaceProps?.presences?.[0]?.laser).toBeUndefined();
    expect(mocks.surfaceProps?.presences?.[0]?.laserClearMode).toBe("immediate");
  });

  it("carries bounded in-progress drawing previews without persisting them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        metricsResponse("2026-07-28T12:00:00.000Z"),
      ),
    );
    await renderLessonBoard();
    const provider = mocks.providers[0];
    const points = Array.from({ length: 300 }, (_, index) => ({
      x: index,
      y: index + 1,
    }));

    await act(async () => {
      mocks.surfaceProps?.onAwarenessChange?.({
        gesturePreview: {
          kind: "pen",
          points,
          style: {
            stroke: "#d33f49",
            strokeWidth: 14,
            opacity: 0,
          },
        },
      });
    });
    expect(provider.presenceCalls.at(-1)).toMatchObject({
      gesturePreview: {
        kind: "pen",
        points: points.slice(-256),
        style: {
          stroke: "#d33f49",
          strokeWidth: 14,
          opacity: 0,
        },
      },
      pageId: CATALOG.pageId,
    });

    provider.awareness.states.set(89, {
      userId: "student-2",
      displayName: "Ученик",
      color: "#2a9d5b",
      pageId: CATALOG.pageId,
      gesturePreview: {
        kind: "pen",
        points: [points[0], points.at(-1)!],
        style: {
          stroke: "rgb(10, 20, 30)",
          strokeWidth: 1_000,
          opacity: -1,
        },
      },
    });
    await act(async () => provider.awareness.emitChange());
    expect(mocks.surfaceProps?.presences?.[0]?.gesturePreview).toEqual({
      kind: "pen",
      points: [points[0], points.at(-1)],
      style: {
        stroke: "rgb(10,20,30)",
        strokeWidth: 96,
        opacity: 0,
      },
    });

    provider.awareness.states.set(89, {
      userId: "student-2",
      displayName: "Ð£Ñ‡ÐµÐ½Ð¸Ðº",
      color: "#2a9d5b",
      pageId: CATALOG.pageId,
      gesturePreview: {
        kind: "pen",
        points: [points[0], points.at(-1)!],
        style: {
          stroke: "url(javascript:alert(1))",
          strokeWidth: 4,
          opacity: 0.5,
        },
      },
    });
    await act(async () => provider.awareness.emitChange());
    expect(mocks.surfaceProps?.presences?.[0]?.gesturePreview).toEqual({
      kind: "pen",
      points: [points[0], points.at(-1)],
    });

    provider.awareness.states.set(89, {
      userId: "student-2",
      displayName: "Ученик",
      color: "#2a9d5b",
      pageId: CATALOG.pageId,
      activeTool: "shape",
    });
    await act(async () => provider.awareness.emitChange());
    expect(mocks.surfaceProps?.presences?.[0]?.activeTool).toBe("shape");

    provider.awareness.states.set(89, {
      userId: "student-2",
      displayName: "Ученик",
      color: "#2a9d5b",
      pageId: CATALOG.pageId,
      activeTool: "ellipse",
    });
    await act(async () => provider.awareness.emitChange());
    expect(mocks.surfaceProps?.presences?.[0]?.activeTool).toBeUndefined();

    await act(async () => {
      mocks.surfaceProps?.onAwarenessChange?.({ gesturePreview: null });
    });
    expect(provider.presenceCalls.at(-1)).toMatchObject({
      gesturePreview: null,
      pageId: CATALOG.pageId,
    });
  });
});

describe("LessonBoard recovery guard", () => {
  it("reports only states that can lose or strand local work", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        metricsResponse("2026-07-28T12:00:00.000Z"),
      ),
    );
    const onRisk = vi.fn();
    await act(async () => {
      root?.render(createElement(LessonBoard, {
        lessonId: LESSON.id,
        userId: CATALOG.userId,
        lesson: LESSON,
        profile: PROFILE,
        onCriticalDataRiskChange: onRisk,
      }));
    });
    await settle();
    expect(onRisk).toHaveBeenLastCalledWith(false);
    expect(mocks.surfaceProps?.readOnly).toBe(false);

    const provider = mocks.providers[0];
    await act(async () => provider.emitStatus({ localDurability: "at-risk" }));
    expect(onRisk).toHaveBeenLastCalledWith(true);

    await act(async () => provider.emitStatus({ localDurability: "ready" }));
    expect(onRisk).toHaveBeenLastCalledWith(false);

    await act(async () => provider.emitStatus({
      connection: "recovery-required",
      recovery: {
        reason: "permission-revoked",
        generation: CATALOG.generation,
        documentKey: CATALOG.pageDocumentKey,
        occurredAt: Date.now(),
      },
    }));
    expect(onRisk).toHaveBeenLastCalledWith(true);
    expect(mocks.surfaceProps?.readOnly).toBe(true);
  });
});

describe("GuestBoard terminal state", () => {
  it("reports BOARD_GONE once so the room can leave recovery UI immediately", async () => {
    const onTerminal = vi.fn();
    await act(async () => {
      root?.render(createElement(GuestBoard, {
        shareId: "guest-share",
        deviceId: "device-id-000000000000000000000000",
        profile: PROFILE,
        onTerminal,
      }));
    });
    await settle();
    const provider = mocks.providers[0];
    expect(provider).toBeDefined();

    await act(async () => provider.emitStatus({
      connection: "recovery-required",
      recovery: {
        reason: "board-gone",
        generation: CATALOG.generation,
        documentKey: CATALOG.pageDocumentKey,
        occurredAt: Date.now(),
      },
    }));
    expect(onTerminal).toHaveBeenCalledOnce();
    expect(onTerminal).toHaveBeenCalledWith("expired");

    await act(async () => provider.emitStatus({ lastError: "still gone" }));
    expect(onTerminal).toHaveBeenCalledOnce();
  });
});

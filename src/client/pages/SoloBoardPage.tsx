import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, LoaderCircle, Users, X } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import * as Y from "yjs";
import {
  LocalUndoController,
  createLocalCommandOrigin,
  openPageDocument,
} from "../../board/core";
import {
  BoardSurface,
  type BoardConnectionStatus,
  type BoardSurfaceProps,
} from "../board/BoardSurface";
import { BoardIndexedDbStore } from "../board/localStore";
import { LocalBoardAssetRepository } from "../board/localBoardAssets";
import { promoteSoloBoardToGuestRoom } from "../board/promoteSoloBoard";
import { guestPromotionErrorMessage } from "../promotionFinalization";

const SOLO_BOARD_IDENTITY = Object.freeze({
  userId: "guest-solo",
  boardId: "solo-board",
  generation: 1,
});
const SOLO_BOARD_FRAGMENT_SCOPE = Object.freeze({
  boardId: SOLO_BOARD_IDENTITY.boardId,
  generation: SOLO_BOARD_IDENTITY.generation,
  pageId: "default",
});

interface LocalBoardSession {
  document: Y.Doc;
  localOrigin: ReturnType<typeof createLocalCommandOrigin>;
  undo: LocalUndoController;
  store: BoardIndexedDbStore | null;
  assets: LocalBoardAssetRepository | null;
  assetPersistenceAtRisk: boolean;
}

export function SoloBoardPage() {
  const navigate = useNavigate();
  const [session, setSession] = useState<LocalBoardSession | null>(null);
  const [status, setStatus] = useState<BoardConnectionStatus>("loading-cache");
  const [promoting, setPromoting] = useState(false);
  const [promotionError, setPromotionError] = useState<string | null>(null);
  const [assetRefresh, setAssetRefresh] = useState<{
    readonly assetId: string;
    readonly revision: number;
  } | null>(null);
  const assetRevisionRef = useRef(0);
  const promotionAbortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      promotionAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const document = openPageDocument(new Y.Doc());
    const localOrigin = createLocalCommandOrigin("guest-solo-board");
    const undo = new LocalUndoController(document, localOrigin);
    let store: BoardIndexedDbStore | null = null;
    let assetRepository: LocalBoardAssetRepository | null = null;
    let storeConstructionError: unknown;
    let assetConstructionError: unknown;
    try {
      store = new BoardIndexedDbStore({
        ...SOLO_BOARD_IDENTITY,
        documentKey: "page:default",
      }, document);
    } catch (error) {
      storeConstructionError = error;
    }
    try {
      assetRepository = new LocalBoardAssetRepository(SOLO_BOARD_IDENTITY);
    } catch (error) {
      assetConstructionError = error;
    }

    const storeReady = store
      ? store.whenReady
      : Promise.reject(storeConstructionError);
    const assetsReady = assetRepository
      ? assetRepository.whenReady()
      : Promise.reject(assetConstructionError);
    void Promise.allSettled([storeReady, assetsReady]).then(async ([
      storeResult,
      assetResult,
    ]) => {
      const documentDurable = storeResult.status === "fulfilled";
      const assetsDurable = documentDurable
        && assetResult.status === "fulfilled";
      if (!documentDurable) {
        console.error(
          "Solo board storage could not be opened",
          storeResult.status === "rejected"
            ? storeResult.reason
            : storeConstructionError,
        );
        await store?.destroy().catch(() => undefined);
        store = null;
      }
      if (!assetsDurable) {
        if (documentDurable) {
          console.error(
            "Solo board asset storage could not be opened",
            assetResult.status === "rejected"
              ? assetResult.reason
              : assetConstructionError,
          );
        }
        await assetRepository?.close().catch(() => undefined);
        assetRepository = null;
      }
      if (cancelled) return;
      setSession({
        document,
        localOrigin,
        undo,
        store: documentDurable ? store : null,
        assets: assetsDurable ? assetRepository : null,
        assetPersistenceAtRisk:
          documentDurable && assetResult.status === "rejected",
      });
      setStatus(documentDurable ? "synced" : "storage-error");
    }).catch((error) => {
      console.error("Solo board storage initialization failed", error);
    });
    return () => {
      cancelled = true;
      undo.dispose();
      const closeStore = store
        ? store.flush().catch(() => undefined).then(() =>
            store?.destroy().catch(() => undefined))
        : Promise.resolve();
      void Promise.allSettled([
        closeStore,
        assetRepository?.close() ?? Promise.resolve(),
      ]).finally(() => document.destroy());
    };
  }, []);

  useEffect(() => {
    if (!session?.assets) return;
    return session.assets.subscribe((event) => {
      assetRevisionRef.current += 1;
      setAssetRefresh({
        assetId: event.assetId,
        revision: assetRevisionRef.current,
      });
    });
  }, [session]);

  const insertImage = useCallback(
    (file: File) => {
      if (!session?.assets) {
        return Promise.reject(new Error("Локальное хранилище изображений недоступно"));
      }
      return session.assets.insertImage(file);
    },
    [session],
  );
  const resolveAssetUrl = useCallback(
    (assetId: string, contentHash: string | null) =>
      session?.assets?.resolveAssetUrl(assetId, contentHash) ?? null,
    [session],
  );
  const validateFragmentPaste = useCallback<
    NonNullable<BoardSurfaceProps["validateFragmentPaste"]>
  >(async (fragment, imageAssets) => {
    if (!session?.assets) {
      throw new Error("Локальное хранилище изображений недоступно");
    }
    if (imageAssets.unresolved.some(
      (asset) => asset.reason === "invalid-identity",
    )) {
      throw new Error("Фрагмент содержит повреждённую ссылку на изображение");
    }
    const sameAssetScope =
      fragment.scope.boardId === SOLO_BOARD_FRAGMENT_SCOPE.boardId
      && fragment.scope.generation === SOLO_BOARD_FRAGMENT_SCOPE.generation;
    if (sameAssetScope) return;
    if (imageAssets.unresolved.length > 0) {
      throw new Error(
        "Изображение нового формата нельзя переносить между разными досками",
      );
    }
    await session.assets.validateForeignImages(imageAssets.identities);
  }, [session]);

  const startSession = useCallback(async () => {
    if (!session || promoting) return;
    const abortController = new AbortController();
    promotionAbortRef.current = abortController;
    setPromoting(true);
    setPromotionError(null);
    try {
      const room = await promoteSoloBoardToGuestRoom({
        document: session.document,
        sourceStore: session.store,
        assets: session.assets,
        signal: abortController.signal,
      });
      if (abortController.signal.aborted) return;
      const boardUrl = room.resources.find((resource) => (
        resource.kind === "board"
      ))?.url ?? `/room/${encodeURIComponent(room.shareId)}/board`;
      navigate(boardUrl);
    } catch (error) {
      if (
        abortController.signal.aborted
        || (error instanceof Error && error.name === "AbortError")
      ) {
        return;
      }
      console.error("Solo Board promotion failed", error);
      if (mountedRef.current) {
        setPromotionError(guestPromotionErrorMessage(error));
      }
    } finally {
      if (promotionAbortRef.current === abortController) {
        promotionAbortRef.current = null;
        if (mountedRef.current) setPromoting(false);
      }
    }
  }, [navigate, promoting, session]);

  return (
    <main className="public-workspace public-workspace--board">
      <header className="public-workspace__bar">
        <Link className="public-workspace__back" to="/" aria-label="На главную">
          <ArrowLeft size={18} />
        </Link>
        <strong>Доска</strong>
        <div className="public-workspace__session-actions">
          <span className="public-workspace__mode">Личный режим</span>
          <button
            type="button"
            className="button button--primary button--small public-workspace__start-session"
            disabled={!session || promoting}
            onClick={() => void startSession()}
          >
            {promoting
              ? <LoaderCircle className="spin" size={15} />
              : <Users size={15} />}
            <span>{promoting ? "Создаём сеанс" : "Начать сеанс"}</span>
          </button>
        </div>
      </header>
      <div className="public-board-stage">
        {promotionError && (
          <div className="public-workspace__promotion-error" role="alert">
            <span>{promotionError}</span>
            <button
              type="button"
              onClick={() => setPromotionError(null)}
              aria-label="Закрыть сообщение"
            >
              <X size={15} />
            </button>
          </div>
        )}
        {session ? (
          <BoardSurface
            document={session.document}
            localOrigin={session.localOrigin}
            undo={session.undo}
            status={status}
            readOnly={promoting}
            assetPersistenceAtRisk={session.assetPersistenceAtRisk}
            assetRefresh={assetRefresh}
            resolveAssetUrl={session.assets ? resolveAssetUrl : undefined}
            insertImage={session.assets ? insertImage : undefined}
            validateFragmentPaste={
              session.assets ? validateFragmentPaste : undefined
            }
            fragmentScope={SOLO_BOARD_FRAGMENT_SCOPE}
          />
        ) : (
          <div className="board-v2-gate" role="status">
            <span className="spinner" />
          </div>
        )}
      </div>
    </main>
  );
}

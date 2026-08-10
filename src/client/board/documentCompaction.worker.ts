import {
  openExistingBoardDocumentDatabase,
  runBoardDocumentCompactionPass,
} from "./documentCompaction.js";
import {
  BOARD_DOCUMENT_COMPACTION_WORKER_PROTOCOL,
  isBoardDocumentCompactionWorkerRequest,
  type BoardDocumentCompactionWorkerFailure,
  type BoardDocumentCompactionWorkerSuccess,
  validateBoardDocumentCompactionJob,
} from "./documentCompactionProtocol.js";

interface CompactionWorkerScope {
  readonly indexedDB: IDBFactory;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  postMessage(message: unknown): void;
}

const scope = globalThis as unknown as CompactionWorkerScope;
let running = false;

function failure(error: unknown): BoardDocumentCompactionWorkerFailure {
  return {
    protocolVersion: BOARD_DOCUMENT_COMPACTION_WORKER_PROTOCOL,
    type: "board-document-compaction-error",
    error: {
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

scope.addEventListener("message", (event) => {
  if (running) {
    scope.postMessage(failure(new Error("Board document compaction worker is busy")));
    return;
  }
  if (!isBoardDocumentCompactionWorkerRequest(event.data)) {
    scope.postMessage(failure(new Error("Invalid Board document compaction request")));
    return;
  }
  const request = event.data;
  running = true;
  void (async () => {
    let database: IDBDatabase | null = null;
    try {
      const job = validateBoardDocumentCompactionJob(request.job);
      database = await openExistingBoardDocumentDatabase(
        scope.indexedDB,
        job.databaseName,
      );
      const response: BoardDocumentCompactionWorkerSuccess = {
        protocolVersion: BOARD_DOCUMENT_COMPACTION_WORKER_PROTOCOL,
        type: "board-document-compaction-result",
        result: await runBoardDocumentCompactionPass(database, job),
      };
      scope.postMessage(response);
    } catch (error) {
      scope.postMessage(failure(error));
    } finally {
      database?.close();
      running = false;
    }
  })();
});

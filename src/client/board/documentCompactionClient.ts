import {
  BOARD_DOCUMENT_COMPACTION_WORKER_PROTOCOL,
  isBoardDocumentCompactionWorkerResponse,
  type BoardDocumentCompactionJob,
  type BoardDocumentCompactionResult,
  type BoardDocumentCompactionWorkerRequest,
  validateBoardDocumentCompactionJob,
} from "./documentCompactionProtocol.js";

type CompactionWorker = Pick<
  Worker,
  | "onerror"
  | "onmessage"
  | "onmessageerror"
  | "postMessage"
  | "terminate"
>;

export interface BoardDocumentCompactionWorkerOptions {
  readonly signal?: AbortSignal;
  readonly workerFactory?: () => CompactionWorker;
}

export class BoardDocumentCompactionWorkerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoardDocumentCompactionWorkerError";
  }
}

function defaultWorkerFactory(): Worker {
  return new Worker(
    new URL("./documentCompaction.worker.ts", import.meta.url),
    {
      type: "module",
      name: "eduri-board-document-compaction",
    },
  );
}

export function compactBoardDocumentInWorker(
  candidate: BoardDocumentCompactionJob,
  options: BoardDocumentCompactionWorkerOptions = {},
): Promise<BoardDocumentCompactionResult> {
  const job = validateBoardDocumentCompactionJob(candidate);
  if (options.signal?.aborted) {
    return Promise.reject(new DOMException(
      "Board document compaction was aborted",
      "AbortError",
    ));
  }

  return new Promise<BoardDocumentCompactionResult>((resolve, reject) => {
    let worker: CompactionWorker;
    try {
      worker = (options.workerFactory ?? defaultWorkerFactory)();
    } catch (error) {
      reject(error);
      return;
    }
    let settled = false;
    const finish = (
      result:
        | { readonly ok: true; readonly value: BoardDocumentCompactionResult }
        | { readonly ok: false; readonly error: unknown },
    ): void => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", handleAbort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
      if (result.ok) resolve(result.value);
      else reject(result.error);
    };
    const handleAbort = (): void => finish({
      ok: false,
      error: new DOMException(
        "Board document compaction was aborted",
        "AbortError",
      ),
    });
    worker.onmessage = (event: MessageEvent<unknown>) => {
      if (!isBoardDocumentCompactionWorkerResponse(event.data)) {
        finish({
          ok: false,
          error: new BoardDocumentCompactionWorkerError(
            "Board document compaction worker returned an invalid response",
          ),
        });
        return;
      }
      if (event.data.type === "board-document-compaction-error") {
        finish({
          ok: false,
          error: new BoardDocumentCompactionWorkerError(
            event.data.error.message,
          ),
        });
        return;
      }
      finish({ ok: true, value: event.data.result });
    };
    worker.onerror = (event: ErrorEvent) => {
      event.preventDefault();
      finish({
        ok: false,
        error: new BoardDocumentCompactionWorkerError(
          event.message || "Board document compaction worker failed",
        ),
      });
    };
    worker.onmessageerror = () => finish({
      ok: false,
      error: new BoardDocumentCompactionWorkerError(
        "Board document compaction worker response could not be decoded",
      ),
    });
    options.signal?.addEventListener("abort", handleAbort, { once: true });

    const request: BoardDocumentCompactionWorkerRequest = {
      protocolVersion: BOARD_DOCUMENT_COMPACTION_WORKER_PROTOCOL,
      type: "compact-board-document",
      job,
    };
    try {
      worker.postMessage(request);
    } catch (error) {
      finish({ ok: false, error });
    }
  });
}

import { BOARD_PROTOCOL_LIMITS } from "../../board/protocol/index.js";

export const BOARD_DOCUMENT_COMPACTION_WORKER_PROTOCOL = 3 as const;
export const BOARD_DOCUMENT_LOG_STATS_KEY = "document-log-stats";

export interface BoardDocumentCompactionLimits {
  readonly maxRows: number;
  readonly maxBytes: number;
  readonly maxUpdateBytes: number;
}

export const DEFAULT_BOARD_DOCUMENT_COMPACTION_LIMITS =
  Object.freeze<BoardDocumentCompactionLimits>({
    maxRows: 256,
    maxBytes: 32 * 1024 * 1024,
    maxUpdateBytes: BOARD_PROTOCOL_LIMITS.maxUpdateBytes,
  });

export interface BoardDocumentCompactionJob {
  readonly databaseName: string;
  readonly updatesStoreName: string;
  readonly sizesStoreName: string;
  readonly metadataStoreName: string;
  readonly limits?: Partial<BoardDocumentCompactionLimits>;
}

export type BoardDocumentCompactionStatus =
  | "compacted"
  | "noop"
  | "stale";

export interface BoardDocumentCompactionResult {
  readonly status: BoardDocumentCompactionStatus;
  readonly revision: number;
  readonly rowCount: number;
  readonly rowBytes: number;
  readonly selectedRows: number;
  readonly selectedBytes: number;
  readonly replacementRows: number;
  readonly replacementBytes: number;
}

export interface BoardDocumentLogStats {
  readonly version: 1;
  readonly revision: number;
  readonly rowCount: number;
  readonly rowBytes: number;
}

export interface BoardDocumentCompactionWorkerRequest {
  readonly protocolVersion: typeof BOARD_DOCUMENT_COMPACTION_WORKER_PROTOCOL;
  readonly type: "compact-board-document";
  readonly job: BoardDocumentCompactionJob;
}

export interface BoardDocumentCompactionWorkerSuccess {
  readonly protocolVersion: typeof BOARD_DOCUMENT_COMPACTION_WORKER_PROTOCOL;
  readonly type: "board-document-compaction-result";
  readonly result: BoardDocumentCompactionResult;
}

export interface BoardDocumentCompactionWorkerFailure {
  readonly protocolVersion: typeof BOARD_DOCUMENT_COMPACTION_WORKER_PROTOCOL;
  readonly type: "board-document-compaction-error";
  readonly error: {
    readonly name: string;
    readonly message: string;
  };
}

export type BoardDocumentCompactionWorkerResponse =
  | BoardDocumentCompactionWorkerSuccess
  | BoardDocumentCompactionWorkerFailure;

function positiveSafeInteger(value: unknown): value is number {
  return (
    typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0
  );
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return (
    typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
  );
}

export function createBoardDocumentLogStats(
  rowCount: number,
  rowBytes: number,
  revision = 1,
): BoardDocumentLogStats {
  if (
    !positiveSafeInteger(revision)
    || !nonNegativeSafeInteger(rowCount)
    || !nonNegativeSafeInteger(rowBytes)
  ) {
    throw new TypeError("Board document log statistics are invalid");
  }
  return Object.freeze({
    version: 1,
    revision,
    rowCount,
    rowBytes,
  });
}

export function restoreBoardDocumentLogStats(
  value: unknown,
): BoardDocumentLogStats {
  if (
    typeof value !== "object"
    || value === null
    || !("version" in value)
    || value.version !== 1
    || !("revision" in value)
    || !("rowCount" in value)
    || !("rowBytes" in value)
  ) {
    throw new Error("Board document log statistics are missing or invalid");
  }
  return createBoardDocumentLogStats(
    value.rowCount as number,
    value.rowBytes as number,
    value.revision as number,
  );
}

export function boardDocumentLogStatsEqual(
  left: BoardDocumentLogStats,
  right: BoardDocumentLogStats,
): boolean {
  return (
    left.revision === right.revision
    && left.rowCount === right.rowCount
    && left.rowBytes === right.rowBytes
  );
}

export function resolveBoardDocumentCompactionLimits(
  candidate: Partial<BoardDocumentCompactionLimits> = {},
): BoardDocumentCompactionLimits {
  const limits = {
    ...DEFAULT_BOARD_DOCUMENT_COMPACTION_LIMITS,
    ...candidate,
  };
  if (!positiveSafeInteger(limits.maxRows) || limits.maxRows < 2) {
    throw new TypeError("Board document compaction maxRows must be at least 2");
  }
  if (!positiveSafeInteger(limits.maxUpdateBytes)) {
    throw new TypeError(
      "Board document compaction maxUpdateBytes must be a positive safe integer",
    );
  }
  if (
    !positiveSafeInteger(limits.maxBytes)
    || limits.maxBytes < limits.maxUpdateBytes
  ) {
    throw new TypeError(
      "Board document compaction maxBytes must cover at least one maximum update",
    );
  }
  return Object.freeze(limits);
}

export function validateBoardDocumentCompactionJob(
  candidate: BoardDocumentCompactionJob,
): BoardDocumentCompactionJob {
  if (
    typeof candidate.databaseName !== "string"
    || candidate.databaseName.length === 0
  ) {
    throw new TypeError("Board document compaction requires a database name");
  }
  if (
    typeof candidate.updatesStoreName !== "string"
    || candidate.updatesStoreName.length === 0
  ) {
    throw new TypeError("Board document compaction requires an updates store");
  }
  if (
    typeof candidate.metadataStoreName !== "string"
    || candidate.metadataStoreName.length === 0
  ) {
    throw new TypeError("Board document compaction requires a metadata store");
  }
  if (
    typeof candidate.sizesStoreName !== "string"
    || candidate.sizesStoreName.length === 0
  ) {
    throw new TypeError("Board document compaction requires an update-size store");
  }
  return Object.freeze({
    databaseName: candidate.databaseName,
    updatesStoreName: candidate.updatesStoreName,
    sizesStoreName: candidate.sizesStoreName,
    metadataStoreName: candidate.metadataStoreName,
    limits: resolveBoardDocumentCompactionLimits(candidate.limits),
  });
}

export function isBoardDocumentCompactionWorkerRequest(
  value: unknown,
): value is BoardDocumentCompactionWorkerRequest {
  return (
    typeof value === "object"
    && value !== null
    && "protocolVersion" in value
    && value.protocolVersion === BOARD_DOCUMENT_COMPACTION_WORKER_PROTOCOL
    && "type" in value
    && value.type === "compact-board-document"
    && "job" in value
    && typeof value.job === "object"
    && value.job !== null
  );
}

export function isBoardDocumentCompactionWorkerResponse(
  value: unknown,
): value is BoardDocumentCompactionWorkerResponse {
  if (
    typeof value !== "object"
    || value === null
    || !("protocolVersion" in value)
    || value.protocolVersion !== BOARD_DOCUMENT_COMPACTION_WORKER_PROTOCOL
    || !("type" in value)
  ) {
    return false;
  }
  if (value.type === "board-document-compaction-result") {
    if (
      !("result" in value)
      || typeof value.result !== "object"
      || value.result === null
    ) {
      return false;
    }
    const result = value.result;
    if (
      !("status" in result)
      || (
        result.status !== "compacted"
        && result.status !== "noop"
        && result.status !== "stale"
      )
      || !("revision" in result)
      || !positiveSafeInteger(result.revision)
      || !("rowCount" in result)
      || !nonNegativeSafeInteger(result.rowCount)
      || !("rowBytes" in result)
      || !nonNegativeSafeInteger(result.rowBytes)
      || !("selectedRows" in result)
      || !nonNegativeSafeInteger(result.selectedRows)
      || !("selectedBytes" in result)
      || !nonNegativeSafeInteger(result.selectedBytes)
      || !("replacementRows" in result)
      || !nonNegativeSafeInteger(result.replacementRows)
      || !("replacementBytes" in result)
      || !nonNegativeSafeInteger(result.replacementBytes)
      || ((result.rowCount === 0) !== (result.rowBytes === 0))
      || ((result.selectedRows === 0) !== (result.selectedBytes === 0))
      || ((result.replacementRows === 0) !== (result.replacementBytes === 0))
    ) {
      return false;
    }
    if (
      result.status === "compacted"
      && (
        result.selectedRows < 2
        || result.replacementRows < 1
        || result.replacementRows >= result.selectedRows
        || result.rowCount < result.replacementRows
        || result.rowBytes < result.replacementBytes
      )
    ) {
      return false;
    }
    if (result.status === "noop") {
      return (
        result.selectedRows <= result.rowCount
        && result.selectedBytes <= result.rowBytes
        && result.replacementRows === result.selectedRows
        && result.replacementBytes === result.selectedBytes
      );
    }
    return true;
  }
  return (
    value.type === "board-document-compaction-error"
    && "error" in value
    && typeof value.error === "object"
    && value.error !== null
    && "name" in value.error
    && typeof value.error.name === "string"
    && "message" in value.error
    && typeof value.error.message === "string"
  );
}

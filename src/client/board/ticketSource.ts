import { BoardCapability } from "../../board/protocol/index.js";

export const BOARD_BROWSER_CAPABILITIES =
  BoardCapability.CHUNKING
  | BoardCapability.AWARENESS
  | BoardCapability.RECOVERY_FORK
  | BoardCapability.PAGE_SHARDING;

export interface BoardSyncScope {
  readonly boardId: string;
  readonly generation: number;
  readonly documentKey: string;
}

export interface BoardSyncTicket {
  readonly ticket: string;
  readonly socketUrl: string;
  readonly expiresAt?: string;
}

export type BoardTicketSource = () => Promise<BoardSyncTicket>;

export interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export type FetchLike = (
  input: string,
  init: {
    readonly method: "POST";
    readonly credentials: "same-origin";
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
  },
) => Promise<FetchResponseLike>;

export interface HttpBoardTicketSourceOptions {
  readonly endpoint: string;
  readonly scope: BoardSyncScope;
  readonly lessonId?: string;
  readonly minSchemaVersion?: number;
  readonly maxSchemaVersion?: number;
  readonly capabilities?: number;
  readonly csrfToken?: () => string;
  readonly requireCsrf?: boolean;
  readonly requestBody?: Readonly<Record<string, unknown>>;
  readonly fetch: FetchLike;
  readonly baseUrl?: string;
  readonly fallbackSocketUrl?: string;
}

export interface BoardBootstrapTicket extends BoardSyncTicket {
  readonly boardId: string;
  readonly generation: number;
  readonly protocolVersion: number;
  readonly schemaVersion: number;
  readonly capabilities: number;
  readonly permissions: number;
  readonly manifestDocumentKey: string;
  readonly defaultPageId: string;
  readonly defaultPageDocumentKey: string;
}

export interface HttpBoardBootstrapOptions {
  readonly endpoint: string;
  readonly lessonId?: string;
  readonly minSchemaVersion?: number;
  readonly maxSchemaVersion?: number;
  readonly capabilities?: number;
  readonly csrfToken?: () => string;
  readonly requireCsrf?: boolean;
  readonly requestBody?: Readonly<Record<string, unknown>>;
  readonly fetch: FetchLike;
  readonly baseUrl?: string;
  readonly fallbackSocketUrl?: string;
}

export class BoardTicketRequestError extends Error {
  readonly status: number | null;
  readonly terminal: boolean;
  readonly retryable: boolean;
  readonly code: string | null;
  readonly details: unknown;
  readonly responseBody: unknown;

  constructor(
    message: string,
    status: number | null,
    terminal: boolean,
    metadata: {
      readonly code?: string | null;
      readonly details?: unknown;
      readonly responseBody?: unknown;
      readonly retryable?: boolean;
    } = {},
  ) {
    super(message);
    this.name = "BoardTicketRequestError";
    this.status = status;
    this.terminal = terminal;
    this.retryable = metadata.retryable ?? !terminal;
    this.code = metadata.code ?? null;
    this.details = metadata.details;
    this.responseBody = metadata.responseBody ?? null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new BoardTicketRequestError("Board ticket response is not an object", null, false);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) {
    throw new BoardTicketRequestError(
      `Board ticket response has no valid ${field}`,
      null,
      false,
    );
  }
  return value;
}

function websocketUrl(
  response: Record<string, unknown>,
  options: HttpBoardTicketSourceOptions,
  ticket: string,
): string {
  const direct = response.websocketUrl ?? response.wsUrl;
  const candidate = typeof direct === "string"
    ? direct
    : typeof response.wsPath === "string"
      ? response.wsPath
      : typeof response.websocketPath === "string"
        ? response.websocketPath
      : options.fallbackSocketUrl;
  if (!candidate) {
    throw new BoardTicketRequestError(
      "Board ticket response has no WebSocket URL or path",
      null,
      false,
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate, options.baseUrl);
  } catch {
    throw new BoardTicketRequestError("Board WebSocket URL is invalid", null, false);
  }
  if (parsed.protocol === "http:") parsed.protocol = "ws:";
  if (parsed.protocol === "https:") parsed.protocol = "wss:";
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new BoardTicketRequestError(
      "Board WebSocket URL must use ws or wss",
      null,
      false,
    );
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new BoardTicketRequestError(
      "Board WebSocket URL cannot contain credentials or a fragment",
      null,
      false,
    );
  }
  for (const [key, value] of parsed.searchParams.entries()) {
    if (
      /ticket|token|authorization|access[_-]?token/iu.test(key) ||
      value === ticket
    ) {
      throw new BoardTicketRequestError(
        "Board ticket must be sent in AUTH, never in the WebSocket URL",
        null,
        true,
      );
    }
  }
  return parsed.toString();
}

function validateScope(
  response: Record<string, unknown>,
  scope: BoardSyncScope,
): void {
  if (response.boardId !== undefined && response.boardId !== scope.boardId) {
    throw new BoardTicketRequestError("Ticket boardId does not match the bootstrap", null, true);
  }
  if (
    response.generation !== undefined &&
    response.generation !== scope.generation
  ) {
    throw new BoardTicketRequestError(
      "Ticket generation does not match the bootstrap",
      null,
      true,
    );
  }
  const responseDocumentKey = response.documentKey
    ?? response.defaultDocumentKey
    ?? response.defaultPageDocKey;
  if (
    responseDocumentKey !== undefined &&
    responseDocumentKey !== scope.documentKey
  ) {
    throw new BoardTicketRequestError(
      "Ticket documentKey does not match the bootstrap",
      null,
      true,
    );
  }
}

function ticketRequestBody(options: {
  readonly lessonId?: string;
  readonly scope: BoardSyncScope;
  readonly minSchemaVersion?: number;
  readonly maxSchemaVersion?: number;
  readonly capabilities?: number;
  readonly requestBody?: Readonly<Record<string, unknown>>;
}): object {
  if (options.requestBody) return options.requestBody;
  if (!options.lessonId) return options.scope;
  return {
    lessonId: options.lessonId,
    minSchemaVersion: options.minSchemaVersion ?? 1,
    maxSchemaVersion: options.maxSchemaVersion ?? 1,
    capabilities: options.capabilities ?? BOARD_BROWSER_CAPABILITIES,
  };
}

async function postTicket(
  options: Pick<
    HttpBoardTicketSourceOptions,
    "endpoint" | "csrfToken" | "requireCsrf" | "fetch"
  >,
  body: object,
): Promise<Record<string, unknown>> {
  const csrfToken = options.csrfToken?.() ?? "";
  if (options.requireCsrf !== false && !csrfToken) {
    throw new BoardTicketRequestError("A CSRF token is required", null, false);
  }

  let response: FetchResponseLike;
  try {
    response = await options.fetch(options.endpoint, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new BoardTicketRequestError(
      error instanceof Error ? error.message : "Board ticket request failed",
      null,
      false,
    );
  }

  if (!response.ok) {
    let responseBody: unknown = null;
    try {
      responseBody = await response.json();
    } catch {
      // Some proxies return an empty or non-JSON error response.
    }
    const errorRecord =
      responseBody !== null
      && typeof responseBody === "object"
      && !Array.isArray(responseBody)
        ? responseBody as Record<string, unknown>
        : null;
    const codeCandidate =
      errorRecord?.code
      ?? errorRecord?.errorCode
      ?? (
        errorRecord?.details !== null
        && typeof errorRecord?.details === "object"
        && !Array.isArray(errorRecord.details)
          ? (errorRecord.details as Record<string, unknown>).code
          : undefined
      );
    const code = typeof codeCandidate === "string" && codeCandidate.trim()
      ? codeCandidate.trim()
      : null;
    const messageCandidate = errorRecord?.error ?? errorRecord?.message;
    const message =
      typeof messageCandidate === "string" && messageCandidate.trim()
        ? messageCandidate.trim()
        : `Board ticket request failed with HTTP ${response.status}`;
    const retryable =
      response.status === 408
      || response.status === 425
      || response.status === 429
      || response.status >= 500;
    throw new BoardTicketRequestError(
      message,
      response.status,
      !retryable,
      {
        code,
        details: errorRecord?.details,
        responseBody,
        retryable,
      },
    );
  }
  try {
    return asRecord(await response.json());
  } catch (error) {
    if (error instanceof BoardTicketRequestError) throw error;
    throw new BoardTicketRequestError(
      "Board ticket response is not valid JSON",
      response.status,
      false,
    );
  }
}

function parseTicket(
  body: Record<string, unknown>,
  options: Pick<
    HttpBoardTicketSourceOptions,
    "baseUrl" | "fallbackSocketUrl"
  >,
): BoardSyncTicket {
  const ticket = nonEmptyString(body.ticket, "ticket");
  const expiresAt = body.expiresAt === undefined
    ? undefined
    : nonEmptyString(body.expiresAt, "expiresAt");
  if (expiresAt !== undefined && !Number.isFinite(Date.parse(expiresAt))) {
    throw new BoardTicketRequestError("Board ticket expiresAt is invalid", null, false);
  }
  return {
    ticket,
    socketUrl: websocketUrl(body, options as HttpBoardTicketSourceOptions, ticket),
    expiresAt,
  };
}

export function createHttpBoardTicketSource(
  options: HttpBoardTicketSourceOptions,
): BoardTicketSource {
  return async () => {
    const body = await postTicket(options, ticketRequestBody(options));
    validateScope(body, options.scope);
    return parseTicket(body, options);
  };
}

function requiredInteger(
  value: unknown,
  field: string,
  minimum = 0,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new BoardTicketRequestError(
      `Board bootstrap response has no valid ${field}`,
      null,
      false,
    );
  }
  return value as number;
}

export async function requestHttpBoardBootstrap(
  options: HttpBoardBootstrapOptions,
): Promise<BoardBootstrapTicket> {
  const negotiation = options.requestBody ?? {
      lessonId: options.lessonId,
      minSchemaVersion: options.minSchemaVersion ?? 1,
      maxSchemaVersion: options.maxSchemaVersion ?? 1,
      capabilities: options.capabilities ?? BOARD_BROWSER_CAPABILITIES,
    };
  const body = await postTicket(options, negotiation);
  const parsed = parseTicket(body, options);
  return {
    ...parsed,
    boardId: nonEmptyString(body.boardId, "boardId"),
    generation: requiredInteger(body.generation, "generation", 1),
    protocolVersion: requiredInteger(body.protocolVersion, "protocolVersion", 1),
    schemaVersion: requiredInteger(body.schemaVersion, "schemaVersion", 1),
    capabilities: requiredInteger(body.capabilities, "capabilities"),
    permissions: requiredInteger(body.permissions, "permissions"),
    manifestDocumentKey: nonEmptyString(
      body.manifestDocKey ?? (body.docKeys as Record<string, unknown> | undefined)?.manifest,
      "manifestDocKey",
    ),
    defaultPageId: nonEmptyString(body.defaultPageId, "defaultPageId"),
    defaultPageDocumentKey: nonEmptyString(
      body.defaultPageDocKey
        ?? (body.docKeys as Record<string, unknown> | undefined)?.defaultPage,
      "defaultPageDocKey",
    ),
  };
}

export function createBootstrappedBoardTicketSource(
  options: HttpBoardBootstrapOptions,
  scope: BoardSyncScope,
  initial: BoardBootstrapTicket,
): BoardTicketSource {
  let first: BoardSyncTicket | null = initial;
  return async () => {
    if (first) {
      const ticket = first;
      first = null;
      return ticket;
    }
    const refreshed = await requestHttpBoardBootstrap(options);
    validateScope({
      boardId: refreshed.boardId,
      generation: refreshed.generation,
      defaultPageDocKey: refreshed.defaultPageDocumentKey,
    }, scope);
    return refreshed;
  };
}

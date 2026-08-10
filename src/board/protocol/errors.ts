export enum BoardProtocolErrorCode {
  FRAME_TOO_LARGE = "FRAME_TOO_LARGE",
  TRUNCATED = "TRUNCATED",
  INVALID_MAGIC = "INVALID_MAGIC",
  UNSUPPORTED_VERSION = "UNSUPPORTED_VERSION",
  UNSUPPORTED_MESSAGE = "UNSUPPORTED_MESSAGE",
  INVALID_VARUINT = "INVALID_VARUINT",
  INVALID_UTF8 = "INVALID_UTF8",
  INVALID_LENGTH = "INVALID_LENGTH",
  INVALID_FIELD = "INVALID_FIELD",
  TRAILING_DATA = "TRAILING_DATA",
}
export class BoardProtocolError extends Error {
  readonly code: BoardProtocolErrorCode;

  constructor(
    code: BoardProtocolErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BoardProtocolError";
    this.code = code;
  }
}

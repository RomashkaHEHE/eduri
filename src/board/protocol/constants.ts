/**
 * RFC 6455 subprotocol advertised by Board v2 clients and accepted by the
 * Board v2 WebSocket endpoint.
 */
export const BOARD_SUBPROTOCOL = "eduri-board-v2";

/**
 * Version of the binary envelope defined in this directory. This is
 * intentionally independent from the Board schema and UI versions.
 */
export const BOARD_PROTOCOL_VERSION = 1;

/** ASCII "EDB2", used to reject traffic meant for another endpoint. */
export const BOARD_PROTOCOL_MAGIC = 0x4544_4232;

export const MESSAGE_ID_BYTES = 16;

/**
 * Decoder limits are protocol security limits, not total-board limits.
 * Large logical UPDATE/SYNC_STEP2 frames are carried in bounded CHUNK frames.
 */
export const BOARD_PROTOCOL_LIMITS = Object.freeze({
  maxEncodedFrameBytes: 16 * 1024 * 1024 + 4 * 1024,
  maxTicketBytes: 4 * 1024,
  maxDocumentKeyBytes: 256,
  maxIdentityBytes: 256,
  maxStateVectorBytes: 2 * 1024 * 1024,
  maxUpdateBytes: 16 * 1024 * 1024,
  maxAwarenessBytes: 256 * 1024,
  maxControlPayloadBytes: 64 * 1024,
  maxChunkPayloadBytes: 256 * 1024,
  maxChunkCount: 128,
  maxReassembledBytes: 16 * 1024 * 1024 + 4 * 1024,
  maxSchemaVersion: 0xffff,
  maxGeneration: Number.MAX_SAFE_INTEGER,
  maxSequence: Number.MAX_SAFE_INTEGER,
  maxAwarenessClientId: 0xffff_ffff,
});

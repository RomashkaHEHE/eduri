# Eduri Board Protocol v1

This document specifies the renderer-independent binary envelope used by Board
v2. It is normative for web and future native clients. The machine-readable
golden bytes are in `src/board/protocol/fixtures/v1.json`.

## Transport and envelope

The transport is an ordered RFC 6455 binary WebSocket using subprotocol
`eduri-board-v2`. The codec itself has no WebSocket dependency: one WebSocket
binary message contains exactly one encoded frame.

Every frame starts with:

| Field | Encoding | Value |
| --- | --- | --- |
| magic | unsigned 32-bit, big-endian | ASCII `EDB2`, hex `45 44 42 32` |
| protocol version | unsigned byte | `1` |
| message type | unsigned byte | `1` through `9` below |

All other unsigned integers use the canonical unsigned base-128 varuint used by
lib0: least-significant seven-bit group first, the high bit marks continuation,
and the shortest possible encoding is required. This is the unsigned LEB128
layout. Values are limited by the field-specific bounds in
`src/board/protocol/constants.ts`; values above JavaScript's safe integer range
are not valid.

`bytes` means a canonical varuint byte length followed by that many uninterpreted
bytes. `utf8` means the same length prefix followed by strict UTF-8 bytes. A
message ID is exactly 16 uninterpreted bytes with no byte-order conversion.
Frames with trailing bytes are invalid.

## CRDT payloads

`SYNC_STEP1.stateVector` is the standard Yjs state-vector v1 encoding.
`SYNC_STEP2.update` and `UPDATE.update` are standard Yjs update v1 encodings.
They are opaque to the Eduri envelope and transport: an implementation must not
JSON-encode, reinterpret, recompress, or otherwise transform them.

One `SYNC_STEP2.update` or `UPDATE.update` payload is limited to exactly
16 MiB (`16 * 1024 * 1024` bytes) by `maxUpdateBytes`. `CHUNK` may split the
encoded envelope across transport frames, but it does not raise that per-update
limit. The limit is not an aggregate document or offline-backlog limit.

JavaScript uses `Y.encodeStateVector`, `Y.encodeStateAsUpdate`,
`Y.applyUpdate`, and `Y.mergeUpdates`. A Rust/Yrs client uses the corresponding
v1 encoders and decoders (`StateVector`/`Update` v1). The wire format does not
use Yjs's experimental `encodeStateAsUpdateV2` format. Changing this CRDT
encoding requires a new negotiated protocol capability or protocol version.

State-vector client/clock pairs form a mapping; their encoded pair order is not
canonical across Yjs-compatible implementations. A receiver must accept valid
pairs in any order and must reject duplicate client IDs, truncated values, or
trailing data. Clients must not compare the raw state-vector bytes to decide
whether two replicas have the same state.

The fixture document in `v1.json` has Yjs client ID `42` and contains
`fixture.answer = 42`. Its state vector and full update are included both as
standalone hex and inside `YJS_SYNC_STEP1` and `YJS_SYNC_STEP2` frames. A native
client should decode those bytes and assert the same semantic value. The
fixture was also decoded and re-encoded byte-for-byte with Yrs through
`ywasm 0.27.3`; that verification version is recorded in the JSON.

Awareness payloads are standard opaque `y-protocols/awareness` update bytes.
They are not Yjs document updates and must never be persisted as board state.

## Synchronization sequence

After `READY`, an editable client first flushes locally batched edits into its
durable outbox, replays every pending `UPDATE`, and durably records the
corresponding `ACK`s. It must not send the initial `SYNC_STEP1` while a local
batch, a persistence write, or an unacknowledged outbox entry remains. New
local edits created while this gate is active join the same process. A
read-only client with divergent local work enters recovery instead of
uploading it. The client rereads the authoritative local outbox on every
`READY`, together with its durable document log; process-local notifications
are hints and cannot replace this reread.

Once that durability gate is clear, the client sends `SYNC_STEP1` for the
document with its current state vector. The server responds in WebSocket order
with:

1. zero or more independently applicable `SYNC_STEP2` updates containing state
   missing from that client;
2. one server `SYNC_STEP1` containing the server's current state vector.

The server samples that final state vector only after outbound flow-control has
capacity and sends it without another asynchronous gap. Updates committed while
the socket is draining are therefore either included in the preceding ordered
broadcast stream or reflected in the final vector, never hidden behind a stale
precomputed vector.

An editable client computes its diff from the server state vector and sends one
`SYNC_STEP2` only when that diff is non-empty and no larger than
`maxUpdateBytes`. The server accepts this response only after its own
`SYNC_STEP1`, rechecks edit access, validates the resulting document schema,
and durably appends the update before broadcasting it as an ordinary `UPDATE`.
A read-only client must not upload the diff; local divergent state requires
recovery.

This second half is required even when the normal durable outbox is empty. It
recovers the narrow case where the Board document update log committed a local
edit before the separate outbox transaction completed.

If the non-empty client diff exceeds `maxUpdateBytes`, the client must not send
an oversized `SYNC_STEP2`. It restarts the document handshake with an empty
state vector so the server replays its complete durable state. The client then
uses the bounded shadow-replay procedure below with an exact expected outbox of
zero rows, atomically materializes the missing history as ordinary `UPDATE`
rows, processes their individual ACKs, and starts one final state-vector sync.
A new client `SYNC_STEP1` restarts the server-side document handshake.

Replaying and durably acknowledging the ordinary outbox before state-vector
sync prevents the same local edit from also being appended under the server's
synthetic `SYNC_STEP2` message ID.

Outbox order is durable protocol state, not a wall-clock guess. Each local
`UPDATE` receives a monotonically increasing queue order in the same IndexedDB
transaction that stores it. Initial replay and later retries preserve that
order across reloads, tabs, and equal or moving system timestamps. A native
client must provide the same stable per-document ordering in its local store.
One local coalescing window may yield multiple contiguous outbox rows; merging
must stop before the resulting update exceeds `maxUpdateBytes`.

The server may send multiple `SYNC_STEP2` frames for one handshake. Each is a
complete standard Yjs update-v1 value and may itself use `CHUNK`. The aggregate
document size is not bounded by `maxReassembledBytes`; that limit applies to
one logical frame/update only.

An independently valid Yjs update can still arrive before a causal predecessor.
Applying such an update leaves unresolved Yjs structs or delete sets. The
server must reject it before durable append and send a non-closing
`RESYNC_REQUIRED` control carrying the rejected `messageId` and strict UTF-8
JSON payload with `reason: "CAUSAL_GAP"` and `retryable: true`. The client keeps
the exact outbox entry and retries it after an earlier pending update receives
a durable `ACK`.

If no earlier outbox row remains, the missing predecessor may exist only in the
local Board document log because the process stopped between those two
durability writes. The client then requests one full durable server replay with
an empty state vector and mirrors it into a temporary Y.Doc. After a local
persistence barrier, it captures a local mutation epoch and reads both the
chronological durable Yjs document update log and the exact complete durable
outbox. It applies those updates sequentially to the server shadow and captures
only the actual Yjs update events that integrate there, including missing struct
and delete-set dependencies.

Those emitted deltas are retained in causal order. Consecutive deltas may be
merged only when the merged standard update-v1 value is no larger than the
16 MiB `maxUpdateBytes` limit. The result is zero or more replacement `UPDATE`s,
each with a fresh message ID and a contiguous durable queue order beginning at
the earliest covered position. The first replacement applies to the fully
replayed server state; each later replacement applies after the preceding
replacement. The client sends the persisted sequence through ordinary ordered
WebSocket replay and durably processes its per-message `ACK`s.

One local compare-and-swap transaction replaces the exact complete captured
outbox with the entire bounded causal sequence, or removes the captured rows if
no delta remains. The exact expected set may be empty only to materialize
document-history-only deltas; it succeeds only if the authoritative outbox
remains empty. A crash leaves either all old rows or the complete replacement
sequence, never a partially rebased outbox. A mutation-epoch change detected
during snapshot or replay preparation cancels that prepared rebase. A later
local edit is never folded into the captured sequence: its durable outbox write
either makes the exact-set CAS lose or follows the committed sequence in normal
queue order. Any concurrent tab addition, acknowledgement, or replacement also
makes the CAS lose; the loser adopts the authoritative rows returned by that
transaction and can replay the winner's exact messages safely. An asynchronous
result is additionally bound to the connection epoch that requested the server
replay.

The aggregate local history may be arbitrarily larger than 16 MiB and must be
partitioned into the bounded sequence above. If one indivisible Yjs update event
emitted during replay alone exceeds 16 MiB, it cannot be divided safely: the
client preserves the original outbox and enters explicit local recovery. The
server validation shadow is rebuilt from durable state after each rejection, so
unresolved data cannot become latent schema poison.

## Frame bodies

Fields appear in the listed order after the common six-byte header.

| Type | Name | Body |
| ---: | --- | --- |
| 1 | `AUTH` | generation varuint, minimum schema varuint, maximum schema varuint, capabilities varuint, ticket utf8 |
| 2 | `READY` | generation varuint, schema varuint, capabilities varuint, awareness client ID varuint, permissions varuint |
| 3 | `SYNC_STEP1` | generation varuint, document key utf8, state vector bytes |
| 4 | `SYNC_STEP2` | generation varuint, document key utf8, update bytes |
| 5 | `UPDATE` | generation varuint, document key utf8, message ID, update bytes |
| 6 | `ACK` | generation varuint, document key utf8, message ID, durable sequence varuint |
| 7 | `AWARENESS` | generation varuint, document key utf8, awareness client ID varuint, awareness update bytes |
| 8 | `CONTROL` | generation varuint, control code varuint, flags byte, optional fields, payload bytes |
| 9 | `CHUNK` | reassembly ID, inner type byte, chunk index varuint, chunk count varuint, total length varuint, payload bytes |

`CONTROL` flag bit 0 includes a document key immediately after the flags. Bit 1
includes a 16-byte message ID after the optional document key. Other flag bits
are invalid in protocol v1. The payload is code-specific opaque binary data and
may be empty.

An update rejected before persistence by the tenant soft quota or server
free-disk floor uses `STORAGE_ERROR` and repeats the rejected `UPDATE.messageId`
through flag bit 1. Its current payload is strict UTF-8 JSON with `error`,
`reason` (`TENANT_QUOTA` or `DISK_PRESSURE`), `retryable: true`, and a
`retryAfterMs` hint. The server sends neither `ACK` nor the peer `UPDATE`.
Clients must retain the exact update and message ID in their durable outbox;
the hint affects retry scheduling only and is not permission to discard work.

For an exact retry of a previously committed `{actor, client, messageId,
update}` tuple, the server returns the original `ACK` before schema or
semantic-no-op validation. This remains valid after compaction, when the update
is already represented by the snapshot. Reusing a `messageId` with different
identity or bytes is a protocol error. A newly identified update that adds no
CRDT information receives non-closing `RESYNC_REQUIRED` with
`reason: "NO_NEW_INFORMATION"` and `retryable: true`, without allocating an
update-log row, sequence, or idempotency receipt. The client requests a full
durable replay and runs the exact-set outbox CAS described above; if the state
is already present, the redundant row is removed without an ACK. This is safe
because the replay proves durable server state. For an ordinary invalid update,
the client first checks its authoritative IndexedDB outbox: if another tab
atomically replaced the rejected row, it adopts and sends the replacement
instead of creating a false recovery fork.

Ordered `CHUNK` payloads collectively contain the complete encoded bytes of one
logical `SYNC_STEP2` or `UPDATE` frame. `chunkIndex` is zero-based, every payload
is non-empty,
`chunkCount` is at least two, and `totalLength` is the exact byte length after
ordered reassembly. The reassembled bytes are decoded again as one complete
frame. A chunk reassembly ID is not the durable `UPDATE.messageId`. Receivers
must apply each completed `SYNC_STEP2` independently rather than concatenate
multiple logical updates into one reassembly buffer.

## Versioning rules

The envelope version, schema version, object plugin versions, and board
generation are separate values. A client must reject an unsupported envelope
version before parsing its body. Capabilities are a 32-bit bitset negotiated by
intersection; codecs preserve unknown capability bits. Object/plugin
compatibility is handled by the CRDT schema and must not change envelope bytes.

Golden fixture changes are wire-format changes. Add a new fixture version and
retain the old file when a future protocol version is introduced.

## Recovery bundle v1

The local recovery export is a separate portable container, not a sync frame.
Its byte layout is:

1. ASCII `EDURI_BOARD_RECOVERY_V1\n`;
2. header length as one unsigned 32-bit little-endian integer;
3. exactly that many bytes of strict UTF-8 JSON;
4. one complete Yjs update-v1 document snapshot;
5. immutable asset bodies concatenated in header order.

The required JSON header fields are:

```text
format             "eduri.board.recovery"
version            1
identity           boardId, lessonId, generation, schemaVersion,
                   documentKey, pageId
reason             non-empty string
pendingUpdateCount non-negative safe integer
createdAt          ISO-compatible date string
documentBytes      positive byte length of the following Yjs update
assets[]           assetId, sha256, mimeType, nullable fileName, bytes
```

`assets[].bytes` is the exact byte length of that asset body. There is no
padding or per-asset prefix. The header is limited to 4 MiB as a parser guard;
this is not a board or asset-size cap. A bundle with truncation, undeclared
trailing bytes, an unsupported format/version, or inconsistent lengths is
invalid.

The DOM-free writer exposes separate non-asset byte parts so a web adapter can
append existing `Blob` objects without reading large assets into memory. Native
clients can stream those same parts and asset files in order. The byte-stable
fixture is enforced in `src/board/persistence/recoveryBundle.test.ts`.

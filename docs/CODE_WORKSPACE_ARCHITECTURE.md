# Eduri Code Workspace Architecture

Status: multi-file web workspace and guest collaboration implemented; isolated
server execution and lazy per-file CRDT documents remain pending.

Date: 2026-08-09.

## Product contract

Code is a first-class room resource, not a text field attached to a lesson.
Every workspace starts with `/main.py` and supports folders, Python files,
arbitrary uploaded input/data files, collaborative cursors/selections, an
interactive terminal, and named input/output test cases. Board and Call may be
opened beside the same Code resource without creating unrelated sessions.

The editor is local-first. File edits are durably queued locally before a
network round trip, reconnect transfers only missing CRDT updates, and remote
updates never execute code. File tree operations and test-case changes use
local command origins so undo cannot revert another participant's work.

## Canonical model

The canonical model is renderer/editor independent and uses Yjs update-v1:

- one manifest document with stable entry IDs, parent IDs, names, type,
  fractional rank, and metadata;
- one `Y.Text` document per editable text file, loaded lazily;
- immutable content-addressed blobs for binary/uploaded files;
- ordered test cases with collaborative `stdin` and expected output text;
- terminal sessions and live cursor/selection state are ephemeral and never
  replayed as document mutations.

Each stored `parentId` is a granular CRDT parent intent rather than an
assumption that independently merged map fields already form a tree. Every
adapter derives the effective parent forest deterministically: a missing,
non-folder, or self parent is treated as the root; one edge per cycle is
detached at the lexicographically smallest ASCII entry ID; and the first edge
crossing the depth or derived-path bound is detached. Descendants stay in the
newly rooted subtree. This normalization is a pure read operation and never
emits a repair transaction, so duplicate or reordered updates cannot create a
repair loop or pollute local undo. Local commands still prevent cycles and
reject a move, add, or rename that would require this safety normalization.
Deletion traverses the effective subtree, not stale raw parent intents.

Paths are derived from validated names and effective parent IDs. Clients cannot
use absolute paths, `..`, NUL, separators inside a name, duplicate sibling
names, or case-fold collisions. Concurrent sibling-name collisions receive a
stable ID-derived path segment without rewriting either collaborator's name.
Unknown/newer entry metadata survives round trips. Protocol/core/persistence
interfaces must remain usable by a future desktop client and Rust/Yrs
implementation.

### Current web v1 adapter

The current web adapter persists a bounded update-v1 log and an ACK-backed
outbox in IndexedDB. A local transaction and its outbox record commit in one
IndexedDB transaction before the socket may send it. Reconnect sends a state
vector, accepts bounded multipart missing updates, and replays unacknowledged
updates with their original stable update IDs. Duplicate acknowledgements and
duplicate/reordered remote Yjs updates are idempotent. A server-confirmed ACK
removes the outbox record; merely opening the workspace creates no room
mutation.

Guest awareness sends cursor/selection coordinates plus bounded ephemeral
terminal input requests and submitted lines. Terminal lines contain no CR/LF,
are capped at 1,024 UTF-16 code units, and never enter the Y.Doc, update log,
files, tests, or history. Participant ID, display name, and color come from the
authenticated server session and are never accepted from the client awareness
payload. Remote code updates and terminal awareness update the UI but never
start execution. Local undo/redo tracks only the stable local command origin.

The React adapter materializes the complete entry/test snapshots on hydration
and structural changes. A deep change confined to collaborative file or test
text patches only the affected snapshot; typing in one file therefore does not
convert every other workspace file to a JavaScript string or rebuild all test
text on each keystroke. Full workspace materialization remains explicit for
validation, promotion, and Run/Test snapshots.

The current Explorer renders the effective parent forest directly. Folders
expand/collapse by pointer or arrow key. Create, upload, rename, and delete are
owned by its pointer/keyboard context menu. Move uses native drag-and-drop onto
a folder or the Explorer root; there is no destination selector in the editor
toolbar. The tests editor is unmounted and consumes no layout space until its
toolbar toggle is opened.

### Server durability and bounded compaction

Migration v13 adds explicit high-water and aggregate counters to the Code
document row. Migration v20 adds transactionally maintained per-workspace and
global guest storage usage rows. The server reconstructs a workspace from its
full Yjs update-v1 snapshot plus only update rows after `snapshot_sequence`.
It verifies the resulting workspace schema, state vector, row count, and byte
counters on every read used for sync or append. A snapshot is CRDT state
produced by `Y.encodeStateAsUpdate`; it is never application JSON or a
last-write-wins scene replacement.

The default storage policy is:

- compact after 64 retained updates or 2 MiB of retained update bytes;
- retain at most 127 update-log rows per workspace;
- retain at most 64 MiB across snapshot, update log, and state vector;
- retain at most 32,768 idempotency receipts per workspace;
- retain at most 512 MiB of accounted durable CRDT storage across all guest
  Code workspaces;
- emit at most 128 persisted parts during a cold sync (one snapshot plus at
  most 127 update rows).

Accounted guest storage includes exact snapshot, state-vector, and retained
update bytes; the bounded receipt identity fields; and conservative SQLite
row/index reserves of 1 KiB per workspace, 1 KiB per document, 2 KiB per
update, and 2 KiB per receipt. Consequently tiny updates and lifetime receipts
consume quota even after update-log compaction, and creating another guest room
does not reset or multiply the storage ceiling. Migration v20 reconciles
pre-existing rows once. Thereafter SQLite triggers maintain both the
per-workspace and singleton aggregate rows without rescanning history.

Before Socket.IO's JSON/binary decoder runs, a shared Engine.IO wire listener
charges every incoming Socket.IO message to process-global and trusted
source-IP scopes. Parser-invalid frames and unknown namespaces therefore cannot
bypass accounting merely because they never create a namespace Socket. After
decoding, every authenticated event is additionally charged, before any
application schema/protocol parser, to a stable `lesson-user` or Code-workspace
scope. The application measurement covers escaped UTF-8 strings and binary
views without materializing another JSON copy; cyclic, accessor-bearing, overly
deep, or excessively wide in-process values fail closed without first creating
an attacker-sized traversal stack. A structural rejection saturates its stable
principal (or pre-auth trusted-IP) window while charging only the bounded wire
size globally, so its fail-closed sentinel cannot itself cause a process-wide
outage. Parallel sockets, different sessions/device IDs, and reconnects do not
reset any of these one-minute windows.

Default ingress limits are 100,000 events/1 GiB process-wide, 10,000 events/
256 MiB per source IP, 2,400 events/128 MiB per authenticated lesson user, and
4,000 events/64 MiB per Code workspace per minute. IP/principal registries are
capped at 4,096/10,000 scopes and reclaim entries idle for two minutes; new
scopes fail closed while full. An ingress rejection returns an explicit
`RATE_LIMITED`/`rate-limited` acknowledgement when possible and disconnects the
offending socket after queuing it. Reconnect remains limited until the fixed
window ends. Engine.IO independently rejects a single envelope above 5 MiB.

Admission is app-wide at the Engine.IO connection boundary, including clients
that connect only to the Code namespace: at most 512 concurrent connections and
32 per trusted source IP. Handshake attempts are also bounded at 4,000 global
and 120 per IP per minute with a 4,096-entry/two-minute IP registry. A pending
reservation expires after 10 seconds, and an accepted reservation is released
exactly once on Engine.IO disconnect, so failed handshakes and reconnect churn
cannot leak or bypass capacity. `X-Real-IP` is accepted only when the direct
peer matches the exact configured nginx IP.

The Socket.IO transport additionally enforces one-minute aggregate abuse
budgets per stable Code workspace, never per socket, participant ID, or
client-supplied device ID. The defaults are 1,200 awareness events, 120 sync
requests, 1,200 update events, and 16 MiB of update bytes per workspace per
minute. Opening parallel sockets, rotating a device ID, or reconnecting does
not reset those counters. Sync has a separate event budget so a normal cold
sync or reconnect is not blocked merely because the update budget was used.
Rejected updates receive a non-terminal `rate-limited` control acknowledgement
and never enter repository persistence. The in-memory scope registry is capped
at 10,000 workspaces and reclaims entries idle for two minutes; a new scope
fails closed while that bound is full.

The retained whole-state `lesson:code` compatibility event has a separate
aggregate budget keyed by authenticated user and lesson: 600 events and
64 MiB of serialized code per minute by default. Its registry has the same
10,000-scope/two-minute bounds. A rejected write returns an explicit
`RATE_LIMITED` acknowledgement with `retryAfterMs` before any SQLite update or
revision increment. Multiple sessions, tabs, sockets, and reconnects for the
same user/lesson share this budget.

These registries are process-local. A future multi-instance deployment must
move the counters to a shared rate store or enforce an equivalent authenticated
aggregate limit at the edge; multiplying the documented budgets by adding app
processes is not an accepted scaling model.

An append first checks its durable receipt, then reconstructs and validates the
candidate Y.Doc inside the same immediate SQLite transaction. When either soft
threshold is reached, the server encodes the complete candidate state as one
update-v1 snapshot, advances `snapshot_sequence` and `last_sequence`, deletes
the covered update rows, and updates all counters atomically. Sequence numbers
remain monotonic, and receipts are deliberately retained across compaction, so
an exact replay returns its original sequence without recreating a log row.
For a guest workspace, a newly committed update and its room/resource activity
renewal share that same SQLite transaction. If the lease is no longer active,
the update, receipt, sequence, and counters all roll back. Exact or digest-level
replays remain idempotent and do not renew the lease.

Workspace creation and every quota-expanding append check the singleton guest
usage inside the same `BEGIN IMMEDIATE` transaction as their payload and
receipt mutations. Concurrent writers for different rooms therefore serialize
against one durable total, and restart cannot reset admission. A compaction
that reduces accounted storage remains allowed when an already-migrated total
is temporarily above policy; any growth above policy rolls back all payload,
receipt, document-counter, and aggregate-counter changes together.

Yjs may accept an update whose causal predecessor has not arrived yet. Such a
document has pending structs or delete sets and must not be snapshotted because
encoding it would omit the unresolved update. The server retains that update
as an incremental row. If the log is already at its hard boundary, an incoming
predecessor is accepted only when it resolves the pending data and permits
immediate compaction; otherwise the append and its provisional receipt roll
back without changing durable counters.

The 4 MiB per-update protocol guard also applies to a generated snapshot. If a
candidate cannot be compacted within that frame guard, the server keeps its
incremental representation while the aggregate row/byte limits allow it. A
write that would cross a hard row, aggregate-byte, or receipt limit is rejected
transactionally. Exact retries using an already stored `(device_id,
update_id)` remain readable and idempotent even when no capacity for a new
receipt remains.

Structural validation is performed against the deterministic effective parent
forest. Consequently, concurrent cross-moves, move/delete races, and combined
depth/path overflows remain valid CRDT updates and converge on the server and
all clients instead of causing a terminal `INVALID_UPDATE`. Malformed entry
records, unsafe names, invalid content types, and resource-limit violations
remain hard failures.

Binary files are written to a content-addressed local cache first. In a guest
room the capability-scoped HTTP client verifies the full SHA-256, byte count,
MIME, every upload chunk, and finalized identity. The CRDT file reference is
created only after the immutable remote blob is ready. A cache miss downloads,
verifies, and locally caches the immutable bytes before returning them.
An idempotent begin request that only discovers the same already-ready blob is
not room activity; the durable CRDT file/reference mutation is what extends the
guest-room lease.

Server upload reservation commits a garbage-collection intent before creating
its private staging file. Finalization queues the deterministic final path
before linking it and removes that recovery intent only in the metadata publish
transaction. A failed publish re-enqueues the path synchronously; room expiry
during a slow malware scan is rechecked before mutable upload rows are read, so
it returns `410 ROOM_EXPIRED` without publishing bytes or ready metadata. The
successful ready transition and guest-room activity update share one SQLite
transaction, and cleanup retries staging/final unlink after restart.

Upload admission is also aggregate rather than room-multipliable. A Code
resource may retain at most 512 MiB and 4,096 blob/upload records; all guest Code
resources together may reserve at most 2 GiB, 100,000 records, and 256 active
uploads. The same immediate SQLite transaction checks published blobs and
outstanding reservations before it creates an upload, and each new metadata row
reserves 2 KiB against the free-disk floor. Creating another guest room or
restarting the process therefore cannot reset these storage ceilings.

The server never turns arbitrary binary bytes into `ready` metadata until a
bounded ClamAV `INSTREAM` scan explicitly returns clean. The complete
stat/hash/scan/publish finalization path is process-bounded to two active jobs
and eight queued jobs; excess work fails with a retryable storage error instead
of building an unbounded I/O/scan queue. Hash verification finishes before
scanning, and scanning finishes before the immutable file is linked to durable
metadata. `FOUND` rejects and garbage-collects the private staging data. Scanner
outage, timeout, protocol error, or configured scan limit fails closed with no
CRDT-publishable blob identity; the completed upload stays private and can retry
while its upload lease is active. Migration v14 adds a durable scan
provider/timestamp attestation. Older rows have no attestation and must be
hash-verified, scanned, and attested on their first dedup/status/download path
before the service exposes them. Concurrent first reads of the same legacy row
share one bounded hash-and-scan decision.

Promoting `/code` to a guest room first makes the solo workspace read-only,
flushes and validates its durable Yjs state, captures one immutable update, and
reads and verifies every referenced binary blob before creating a room. After
creating an unlisted server draft, the new guest provider synchronizes the
server-created workspace and each
deduplicated blob is persisted in the guest local cache and published through
the same capability-scoped HTTP client used by the ordinary guest editor. The
captured entries, metadata, and test-case roots then replace the server default
in one guest transaction using newly integrated shared types, avoiding Y.Map
winner conflicts with the server-created `main-py`. Navigation waits for the
local update log flush, the server ACK, and all blob finalizations. Failure
before the draft is finalized cancels that server draft, clears only the
partially created guest Code databases, and never mutates or deletes the solo
workspace. Immediately before the finalize request, the browser persists
bounded same-origin recovery metadata containing the draft capability. After
the request is sent, an ambiguous response preserves the guest databases and
the recovery record; the next promotion attempt retries the idempotent finalize
for the same room before creating a new draft. Records are keyed by draft and
removed with an exact capability comparison, so concurrent tabs cannot
overwrite or clear another attempt. The record remains through local provider
and blob-store shutdown and is cleared only after a final cancellation check.
An invalid, missing, or expired draft (`400`, `404`, or `410`) clears only that
record and allows the same action to continue with another pending attempt or a
fresh draft; network and `5xx` failures remain recoverable.

Current limitation: web v1 co-locates the manifest maps and nested collaborative
`Y.Text` values in one workspace Y.Doc. It therefore does not yet implement the
accepted lazy one-document-per-editable-file model above. Splitting those
documents requires a versioned protocol/repository migration before the
per-file scaling gate can be considered complete.

## Execution profiles

### Browser profile

Pyodide runs in a dedicated disposable Worker. Every explicit run creates a
new Worker at the query-versioned `/python-runner.worker.js?protocol=3` URL,
sends one tagged protocol-v3 request, may receive bounded output chunks and
input-request messages, and terminates that Worker after the terminal result,
runtime/worker/protocol error, cancellation, or its bounded timeout. Ordinary
Run uses the 45-second client ceiling. Test uses the test case's `250..45000`
ms timeout, defaulting to 5,000 ms for new and legacy cases. The Worker also
closes itself after posting its one terminal response. Python interpreter state
and virtual files therefore cannot survive into the next run.

Each multi-file run receives a bounded immutable workspace snapshot, creates a
fresh `/workspace`, changes to it, and invokes the selected Python entry point.
Directories carry stable entry IDs and normalized paths. Every file carries
its stable entry ID, content kind, SHA-256, byte size, normalized path, and
deterministic text or byte content. The protocol permits at most 512 entries,
2 MiB per file, 8 MiB of aggregate file bytes, 32 directory levels, and 1,024
UTF-16 code units per path. Known network, storage, cross-tab, and nested-worker
globals are shadowed after the runtime loads but before any untrusted Python
executes; failure to shadow one of those known globals aborts execution. Python
receives an empty frozen `jsglobals` object instead of the Worker global.
Pyodide `0.27.5` is exact-pinned in the npm lock, copied into versioned build
assets by the explicit dev/build hook, and loaded only from
`/vendor/pyodide/0.27.5/`. Monaco follows the same same-origin asset model, so
the production CSP has no external script or connect origins and runtime
execution performs no CDN/PyPI fetch.

Explorer, toolbar, test controls, terminal prompt/output, and the lesson Code
output use one document-theme palette. The document root is the authoritative
CSS theme source, so those surfaces change in the same pre-paint update as
Monaco without remounting the workspace, replacing its Y.Doc, or cancelling a
run.

The blacklist remains defense in depth rather than a complete boundary for
browser secrets. Only the pinned same-origin loader runs before capabilities
are removed, but a separate credential-free runner origin would still be the
stronger browser isolation boundary.

Output, wall time, source length, stdin, file count, and aggregate workspace
characters are bounded. Interactive input uses per-run shared control/data
buffers so Pyodide's synchronous stdin callback can block without blocking the
page. The site is served with `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`, which makes those
`SharedArrayBuffer` instances available. This profile is suitable for ordinary
algorithms; its first uncached use downloads the pinned runtime from the Eduri
origin. It does not install packages from PyPI at run time and cannot provide
native extensions, unrestricted packages, processes, memory/disk cgroups, or
a true PTY.

Browser stdout/stderr is streamed to the terminal while preserving the exact
emitted character stream in the terminal result, including trailing line
endings and a genuinely empty stdout. The terminal may style an empty
successful run in the UI, but the execution result and test-case comparison
never substitute explanatory text for program output.

After an ordinary successful execution or Python runtime error, the Worker
recursively snapshots `/workspace` and returns version-1 file changes inside
the protocol-v3 terminal response. A change is either a deterministic byte
write with its optional baseline identity or a delete with its required
baseline identity. The snapshot rejects unsafe, non-normalized, duplicate or
case-colliding paths; excessive depth, count, per-file or aggregate bytes;
symbolic links; devices; and other non-regular files. Changes are strictly
ordered by case-folded UTF-16 code units so the client can reject unsorted or
duplicate protocol data. An ordinary runtime error retains writes completed
before the exception. Test execution deliberately ignores every returned file
delta and can never mutate the workspace.

An ordinary Run applies only changes whose immutable Run baseline still
matches the same stable entry ID, exact path, content kind, and content. New
paths also require the captured parent topology to remain compatible. The
client plans once, publishes every accepted binary through the durable blob
store, then repeats the complete baseline/path check after those asynchronous
publishes. Cancellation, unmount, read-only transition, session replacement,
or a final mismatch opens no Yjs transaction. Accepted creates, replacements,
deletes, and required parent folders are validated first and committed through
stable-ID core commands in one local-origin Yjs transaction. Existing
text-to-text replacements update the same collaborative `Y.Text`. `main.py`
cannot be deleted. Conflicting paths are skipped and reported as a bounded
partial-result warning; unrelated accepted paths still commit. This avoids a
whole-workspace snapshot overwrite while preserving safe Python filesystem
effects.

### Isolated server profile

Broader execution requires a separate runner service, never the Eduri web/API
container. Every run receives a read-only image plus one disposable workspace
volume and must enforce all of the following independently:

- rootless user namespace and no host Docker socket;
- no network namespace route, DNS, metadata service, loopback service access,
  or inherited server credentials;
- read-only root filesystem, writable workspace only, no host mounts;
- seccomp, AppArmor/SELinux, dropped capabilities, `no_new_privileges`;
- cgroup v2 CPU, memory, process, IO, wall-time, and output limits;
- bounded archive extraction rejecting traversal, links, devices, and bombs;
- fresh sandbox per run and asynchronous deletion afterward;
- a brokered protocol that accepts only workspace snapshots, stdin, limits,
  and the selected entry point.

Firecracker/gVisor is preferred if the host supports it. A plain application
process, Node `vm`, chroot alone, or a privileged Docker sibling is not an
acceptable security boundary. The public server runner remains disabled until
an operational penetration test and abuse controls are complete.

## Test cases and terminal

A test case stores a name, stdin, expected stdout, bounded timeout in
milliseconds, and rank. Timeout accepts `250..45000`, defaults to 5,000, and
legacy Yjs records without the field read as that default. Output comparison is
always normalized by lines: line-ending style and one final newline difference
do not affect the result. Running tests never applies a returned workspace
delta and never mutates source or expected output.
Results are ephemeral unless the user explicitly saves a bounded run summary.

The test panel is closed by default and mounted only when explicitly expanded.
A Test consumes its bounded stored stdin snapshot line by line and receives EOF
after the final line. An ordinary Run has no advance stdin snapshot: when
Python calls `input()`, the Worker emits a request and waits on its per-run
shared buffer. The terminal then exposes one focused line control; submission
resumes execution. A line is capped at 64 KiB of UTF-8 and total interactive
input at 1 MiB, while the shared-room awareness UI applies the stricter 1,024
UTF-16-code-unit/no-newline bound. Requests and submissions are ephemeral
awareness so another active room participant can answer and observers see the
submitted line without creating a durable code update. An active run can be
terminated from the Run command, which also revokes its pending input stream.

This browser mechanism provides prompt-by-prompt stdin and streamed combined
stdout/stderr, but not a true PTY. A future isolated server runner protocol must
distinguish stdout, stderr, prompts, exit status, timeout, truncation, and
sandbox failure independently, and killing a run must revoke its input stream
and sandbox immediately.

## Acceptance gates

- concurrent file content and tree operations converge under duplicate,
  delayed, and reordered updates;
- offline edits survive reload and merge on reconnect;
- cursors, selections, and terminal input remain awareness-only, bounded, and
  authenticated;
- uploaded trees cannot escape the workspace through names, archives, links,
  Unicode ambiguity, or case collisions;
- arbitrary binary blobs cannot become ready, deduplicated, or downloadable
  without a successful bounded malware scan; scanner failures remain fail-closed;
- code cannot reach Eduri, cloud metadata, LAN services, the public Internet,
  host files, other rooms, or runner control sockets;
- fork/process, memory, CPU, disk, output, and wall-time exhaustion terminate
  without affecting the API service;
- stdin/output and normalized line comparison have deterministic tests;
- receiving remote code never starts a run.

# Eduri Code Workspace Architecture

Status: multi-file web workspace, guest and lesson collaboration, relative
presence, and one ordered shared browser terminal implemented; isolated server
execution and lazy per-file CRDT documents remain pending.

Date: 2026-08-12.

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
- ordered test cases bound to a stable text-file entry ID, with collaborative
  `stdin` and expected output text;
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

Awareness protocol v3 advertises exactly one focused editing target. File text
and test stdin/expected-output presence carries Monaco's ordered selection set:
the primary selection first, followed by at most 31 secondary selections. Each
directional anchor/head pair uses encoded Yjs relative positions bound to the
exact `Y.Text`. The parser accepts the previous singular relative-selection
field at ingress and normalizes it immediately to a one-item canonical array;
plural-capability negotiation keeps a mixed-version recipient on the singular
primary form. Test name/timeout and Explorer rename inputs use a bounded
ephemeral draft plus one UTF-16 selection; terminal presence identifies the
shared input surface but carries no terminal state. Focus ownership is tokened,
so cleanup from an unmounted field cannot clear a newer focused field. Every
awareness state is bounded and ephemeral. Participant ID, display name, and
color come from the server-authoritative connection identity and are never
accepted from the awareness payload.

Online Code uses the shared device-local collaboration profile stored as the
strict `eduri-online-profile-v1` envelope. It contains exactly a normalized,
non-empty single-line `displayName` (at most 60 Unicode characters and 240
UTF-8 bytes, without control or bidi-formatting characters) and a canonical
lowercase six-digit `#rrggbb` color. The first guest-room or lesson entry with
no valid profile is offered a dismissible profile suggestion. The active online
session uses the normalized default until the person saves a profile; the Code,
Board, and Call providers remain available. The active online header exposes the profile
button immediately before Theme; solo `/code` and `/board` do not expose it.
The modal uses the complete in-app Board color picker. Strict parsing rejects
malformed, noncanonical, wrong-version, and extra-field storage records;
storage/page-visibility reconciliation shares valid edits between tabs and
closes an open stale editor. External key deletion opens the suggestion again
while the active collaboration providers continue with the in-memory default,
while blocked storage retains an in-memory fallback.

Guest and lesson Code socket authentication carries the profile as a bounded
credential field. The server validates and normalizes it, then supplies the
resulting display name/color authoritatively to editor/test awareness and the
shared terminal participant; awareness cannot override identity. The profile
field remains optional at wire ingress for older-client compatibility, where
the existing generated guest or authenticated-account identity is used, but
the current web client sends its saved profile or normalized session default.
Profile values never
change a participant ID, account, role, lesson membership, resource capability,
or edit permission.

Editing the profile always updates socket authentication for a future recovery
connection. While connected, every distinct saved value is also sent immediately
as one strict, bounded `PROFILE_UPDATE` over the existing guest/lesson Code
socket; an identical consecutive value is a local no-op. The server reauthorizes
the participant, validates the profile, retains the same participant ID, and
answers with `PROFILE_UPDATED`. It publishes the resulting identity through the
existing awareness stream plus an ordered terminal owner/host delta. The sender
`PROFILE_UPDATED` echo updates its own authoritative participant identity;
peers receive an ordinary awareness identity replacement on the existing peer
presence without changing that peer's awareness state.

Code profile controls deliberately have no request/correlation ID. Socket.IO's
ordered event delivery and ordered server processing are therefore part of this
v3 contract: distinct rapid saves are not coalesced and their
`PROFILE_UPDATED` results must be applied in request order. If the socket is
disconnected, saving changes only the latest handshake auth and sends no stale
control; reconnect authenticates with that latest value. A non-terminal
validation or profile-rate rejection leaves the device-local saved profile in
place, exposes the provider error, and does not synthesize an accepted
`PROFILE_UPDATED`; the current client does not automatically retry that rejected
control until another different save or reconnect supplies a profile again.

The socket, terminal host lease, and active run remain intact; no disconnect,
process stop, or execution-epoch change occurs. The same workspace Y.Doc,
Monaco models/tokenization, local IndexedDB log, pending durable outbox,
Explorer/test state, and shared-terminal client surface remain mounted. Board
uses negotiated, correlated `PROFILE_UPDATE` / `PROFILE_UPDATED` controls on its
existing WebSocket without refreshing a ticket, issuing another `AUTH` or
`READY`, or recreating its document or camera. Guest/lesson Call uses the current
profile when requesting a new LiveKit token and, while already connected,
serializes server-authorized participant updates in place. The Call adapter keeps
only the latest desired value while one PATCH is in flight, retries the latest
value after a real room reconnect, and never replaces its token, room, component,
or media tracks merely to change the profile.

Monaco is not a controlled React text input. An exact `Y.Text` is bound directly
to its model: local Monaco changes become granular Yjs operations and remote
Yjs deltas become granular model edits. Monaco therefore retains its model,
tokenization, scroll, selection, and undo chrome instead of replacing the full
model and repainting syntax on every remote character. Every non-collapsed
remote selection is a tracked decoration and every selection head is a stable,
zero-width content-widget caret in the authenticated participant color,
including coincident carets. A forward or backward whole-line selection ends
at its actual next-line column-one boundary and uses Monaco's finite text-range
geometry; it never fills the remaining editor or page width. No `|` or other
cursor glyph is inserted into the document or inline text layout. Native
collaborative inputs use absolute overlay carets and selections over their
bounded remote drafts. In both Monaco and native inputs, caret lines and
selections remain visible while participant name labels are hidden by default.
Each caret has its own absolutely positioned label, revealed only while a
hover-capable pointer is inside that caret's 18-pixel geometric area; pointer
exit hides it, and touch or other no-hover input does not reveal it. Monaco and
native inputs calculate this hover from pointer coordinates delivered to the
underlying editing surface. The complete remote overlay remains
`pointer-events: none`, so pointer down, click, selection, context-menu, and
focus pass through even directly over a remote caret. Labels never change
document/input values, text layout, scroll, or selection. Pure nested
`Y.Text` events bypass React entry/test snapshots entirely. Structural and
metadata changes still refresh those snapshots, while Run/Test captures read
authoritative data from the Y.Doc.

The current Explorer renders the effective parent forest directly and keeps
four device-local concepts separate: the file opened in the editor, the local
multi-selection, the roving keyboard-focus row, and the fixed Shift-range
anchor. Explorer selection, focus, anchor, expansion, and collapse are
presentation state, not CRDT content, awareness, or undo history. Modifier or
keyboard multi-selection therefore does not implicitly replace the opened
entry; plain activation can still open a file or the existing folder-action
surface.

The flattened visible depth-first order is authoritative for pointer and
keyboard ranges. Plain selection replaces the set, `Shift` selects the visible
range from the anchor, `Ctrl`/`Cmd` toggles one row, and
`Ctrl`/`Cmd+Shift` adds a visible range. Collapsing a folder immediately prunes
its hidden descendants from selection and resolves focus/anchor to a visible
row, so a later destructive command cannot silently affect a hidden selection.
The multiselect tree uses one roving `tabIndex=0` row and exposes selection
independently from the active/opened-file styling.

Arrow keys and `Home`/`End` navigate the visible order; Shift extends a range
and `Ctrl`/`Cmd` navigation moves focus without replacing selection.
`ArrowLeft`/`ArrowRight` implement parent/child collapse and expansion,
`Enter` activates the focused entry, Space toggles it, `F2` renames only an
exactly one-item selection, `Ctrl`/`Cmd+A` selects all visible rows, `Escape`
clears selection, and Delete/Backspace removes the deletable selection. A
right-click on a selected row preserves the group while focusing that row; a
right-click on an unselected row replaces the selection. Multi-selection menus
omit singular rename and duplicate actions.

Dragging a selected row moves the selected roots together; dragging an
unselected row first makes it the sole selection. Drops target a folder or the
Explorer root and cannot target any selected subtree. Group move and delete
normalize redundant ancestor/descendant inputs, validate the complete command,
and commit in one local-origin Yjs transaction, producing one local Undo item
with no partial mutation on failure. The required `main.py` entry and every
ancestor folder containing it make the complete delete selection protected.
Create, upload, rename, duplicate, and delete remain available from the
pointer/keyboard context menu. The Explorer header contains only its title,
with no ellipsis or dedicated delete action. There is no destination selector
in the editor toolbar. A narrow VS Code-style activity bar sits to the left of
the resizable sidebar and selects either the Explorer page or the Tests page.
Both pages use the same persisted sidebar width (or the same sidebar height in
compact layout), so opening tests never takes space from the terminal. The
Explorer stays mounted while hidden to preserve its navigation state; the test
editors are mounted only while the Tests page is active. The Tests activity is
disabled unless the active entry is a Python text file.

Editor language and Python capability derive from the current normalized file
name, never from stable entry identity or the file's creation history. A
case-insensitive `.py` text file uses Monaco's Python language and exposes the
Tests activity and idle `F9` action. Renaming that same entry to `.txt`
immediately changes its existing Monaco model to `plaintext`, returns an open
Tests page to Explorer, disables the Tests activity, removes idle Run, and
makes workspace-scoped F9 a no-op without remounting the editor or changing the
stored text. Known non-Python extensions
such as `.md`, `.json`, `.js`, and `.ts` select their matching Monaco language
but never gain Python Run/Test capability. Renaming back to `.py` restores the
file's previously attached tests because those tests remain bound to stable
entry ID.

### Server durability and bounded compaction

Migration v13 adds explicit high-water and aggregate counters to the Code
document row. Migration v20 adds transactionally maintained per-workspace and
global guest storage usage rows. The server reconstructs a workspace from its
full Yjs update-v1 snapshot plus only update rows after `snapshot_sequence`.
It verifies the resulting workspace schema, state vector, row count, and byte
counters on every read used for sync or append. A snapshot is CRDT state
produced by `Y.encodeStateAsUpdate`; it is never application JSON or a
last-write-wins scene replacement.

Migration v22 lets a workspace belong to exactly one guest-room resource or
one lesson. The first lesson access imports retained `lessons.code_state`
exactly once and records the source JSON, revision, SHA-256, and import time in
immutable audit history; those legacy columns are recovery data and never an
active writer. Lesson workspaces use the separate `/lesson-code-sync`
namespace. Cookie session, active account, role, lesson membership, and lesson
status are checked at handshake, on every inbound operation, and before
outbound collaboration data. Scheduled/active lessons are writable;
completed/cancelled lessons permit cold read-only sync. Code and tests are
durable, while the shared terminal is intentionally ephemeral after the final
participant disconnects. Lesson storage retains the same per-workspace guards
but is not charged to the global guest quota. Until an authenticated lesson
blob service exists, lesson uploads and binary filesystem deltas fail closed;
text files, folders, and tests remain fully collaborative.

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

The legacy whole-state `lesson:code` writer is no longer a compatibility path.
It rejects writes with `CODE_ENGINE_MISMATCH`; retained lesson code columns are
an immutable import/rollback source. Live lessons use the same granular Code
workspace model over the authenticated `/lesson-code-sync` namespace.

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

Pyodide runs behind an opaque-origin sandboxed iframe. The iframe has
`sandbox="allow-scripts"` without `allow-same-origin`, applies a network-denying
CSP, and creates the disposable Blob Worker itself. The application fetches
and verifies the exact same-origin runtime assets and versioned
`/python-runner.worker.js?protocol=4&revision=2` source before transferring only those
bytes through a private `MessageChannel`; the sandbox exposes no privileged
parent RPC. Every explicit run sends one tagged protocol-v4 request, may
receive bounded output chunks and input-request messages, and destroys the
Worker, channel, and iframe after the terminal result, runtime/worker/protocol
error, cancellation, or its bounded timeout. Ordinary Run uses the 45-second
client ceiling. Test uses the test case's `250..45000` ms timeout, defaulting to
5,000 ms for new and legacy cases. The Worker also closes itself after posting
its one terminal response. Python interpreter state and virtual files therefore
cannot survive into the next run.

The interactive xterm surface uses the separately versioned protocol-v3
`/python-terminal.worker.js?protocol=3&revision=3` source through the same opaque broker.
Each shell `py path.py` command receives a fresh
workspace snapshot and disposable interpreter, so imports, globals, and stale
MEMFS do not leak into the next shell command. Bare `py` starts an explicit
interactive Python session whose interpreter persists only until `exit()`,
`quit()`, EOF, interruption, timeout, read-only transition, session change, or
unmount. Its cumulative filesystem delta is checked and applied once on exit.
The safe virtual shell implements only bounded workspace commands (`help`,
`pwd`, `ls`/`dir`, `cat`/`type`, `clear`/`cls`, and `py`/`python`); it is not an
OS or server shell.

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

The opaque origin is the browser credential boundary: it cannot read the
application DOM, cookies, local/session storage, or IndexedDB. Exact-key broker
validation permits only run/terminal requests, bounded input/EOF/interrupt
controls, bounded output, and validated filesystem deltas. There is no generic
object bridge back into the application realm. The capability blacklist inside
the Worker remains defense in depth, while `connect-src 'none'` blocks iframe
and Worker network egress.

Output, wall time, source length, stdin, file count, and aggregate workspace
characters are bounded. Interactive input uses per-run shared control/data
buffers created inside the opaque iframe so Pyodide's synchronous stdin
callback can block without blocking the page. The privileged parent never
creates or transfers those buffers; it sends bounded input, EOF, and interrupt
control envelopes to the broker. The site is served with
`Cross-Origin-Opener-Policy: same-origin`,
`Cross-Origin-Embedder-Policy: require-corp`, and an explicit
`cross-origin-isolated` iframe permission so `SharedArrayBuffer` is available
inside the sandbox. This profile is suitable for ordinary
algorithms; its first uncached use downloads the pinned runtime from the Eduri
origin. It does not install packages from PyPI at run time and cannot provide
native extensions, unrestricted packages, processes, memory/disk cgroups, or
a true PTY.

Browser stdout/stderr is streamed to the terminal while preserving the exact
emitted character stream in the terminal result, including trailing line
endings and a genuinely empty stdout. The terminal may style an empty
successful run in the UI, but the execution result and test-case comparison
never substitute explanatory text for program output.

The initiating client takes a local F9/Test request lock before awaiting its
durable document outbox. It releases that lock only on rejection, a connection
or permission transition, or authoritative terminal progress. The idle run
control and a plain workspace-scoped F9 both request an ordinary run. Once a
request is pending or execution is active, further F9 presses are consumed as
no-ops and never stop or restart it; only clicking the active `Stop` control
interrupts execution. Repeated F9/Test actions during synchronization therefore
cannot enqueue competing starts.

After an ordinary successful execution or Python runtime error, the Worker
recursively snapshots `/workspace` and returns version-1 file changes inside
the protocol-v4 runner response. A change is either a deterministic byte
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

A test case stores a stable target `entryId`, name, stdin, expected stdout,
bounded timeout in milliseconds, and rank. The target is the Python file's
stable entry identity rather than its display name or derived path, so rename
and move preserve the complete test set. Switching the active Python file
selects and renders only tests whose `entryId` matches that file. Duplicating a
file duplicates its contents but not its tests. A normal local file or subtree
delete removes tests for all deleted files in the same local-origin Yjs
transaction and Undo item. A valid test concurrently merged after its target
was deleted is retained as an orphan, but is hidden and cannot execute; this
avoids making a convergent document structurally invalid. Records created
before per-file binding and therefore missing `entryId` are interpreted as
belonging to stable `main-py` without an eager migration transaction.

New tests can be created only for an existing collaborative text file and the
web UI exposes test controls only while the active file has a case-insensitive
`.py` suffix. A test-run action carries both target entry ID and test ID. The
execution host re-reads the synchronized document and rejects the action if the
test's stored target differs from the requested entry, so a stale or forged
pair cannot run one file with another file's stdin and expected output.

Timeout accepts `250..45000`, defaults to 5,000, and legacy Yjs records without
the field read as that default. Output comparison is always normalized by
lines: line-ending style and one final newline difference do not affect the
result. Running tests never applies a returned workspace delta and never
mutates source or expected output.
Results are ephemeral unless the user explicitly saves a bounded run summary.

The test panel is closed by default and mounted only when explicitly expanded.
A Test consumes its bounded stored stdin snapshot line by line and receives EOF
after the final line. Test names/timeouts expose bounded live draft/caret
presence; stdin and expected output use collaborative `Y.Text` and relative
selections without remounting focused editors.

One server-ordered state machine owns each active workspace terminal. It grants
one input lease, elects one authorized browser execution host, assigns run IDs,
and broadcasts ordered bounded deltas for prompt, input, output, mode, host,
run, and test result. Full bounded snapshots are reserved for connect, explicit
sync/gap recovery, and `clear`/`cls` generation changes. ACKs cover accepted,
unchanged, duplicate, and rejected actions. Output and run lifecycle never use
lossy awareness. All participants therefore see one terminal and one run;
receiving a remote update alone never starts a second local execution.

The xterm input is the active terminal row, not a detached HTML input. Editing,
caret motion, program `input()`, Ctrl-C, Ctrl-D, shell/REPL prompts, and
`clear`/`cls` are reflected through the shared state machine. A command line is
capped at 1,024 UTF-16 code units with control characters removed. Python stdin
also retains its 64 KiB per-line, 1 MiB total, bounded-request guards. The
terminal transcript is bounded to 256 KiB, host output actions to 64 KiB, and
small stdout writes are batched before transport. Terminal state is ephemeral
when the room becomes empty and is disabled while collaboration is offline;
source editing remains local-first and available offline. The header does not
render a persistent terminal input-owner name. The xterm caret stays visible in
the authenticated owner's color; for a remote owner, its absolutely positioned
name label is hidden by default and appears only while a hover-capable pointer
is within the transparent 18-pixel geometric area around that caret. The area
and label never intercept pointer events, focus, selection, or input, and never
change the terminal buffer or layout. Touch and other no-hover input leave the
label collapsed. The overlay derives its position from the public xterm buffer
cursor after parse, render, resize, and scroll changes and hides whenever that
buffer position falls outside the rendered viewport.

Terminal actions retain compact SHA-256 idempotency fingerprints and retry with
their original action ID. Identical retries do not consume the action budget a
second time; conflicting payload reuse is rejected. Every provider socket
transition advances a monotonic execution epoch, so a Worker started before a
disconnect cannot publish output or a filesystem delta after a rapid reconnect.
Within bare-`py`, Ctrl-C resets the `InteractiveConsole` buffer and returns to
the primary prompt instead of closing the REPL.

This browser mechanism provides prompt-by-prompt stdin and streamed combined
stdout/stderr but not a server PTY. A future isolated server runner protocol
must distinguish stdout, stderr, prompts, exit status, timeout, truncation, and
sandbox failure independently, and killing a run must revoke its input stream
and sandbox immediately.

## Acceptance gates

- concurrent file content and tree operations converge under duplicate,
  delayed, and reordered updates;
- offline edits survive reload and merge on reconnect;
- all primary and secondary cursors/selections, their order and direction
  survive remote edits within the documented 32-selection awareness bound;
  malformed or oversized presence is rejected while terminal input/output/run
  lifecycle remains bounded, server-ordered, and ephemeral;
- strict profile storage/auth validation, dismissible first-online suggestion,
  server-authoritative editor/terminal identity, and live profile refresh
  without a socket reconnect, terminal-host interruption, Monaco remount, or
  replacement of the Y.Doc, IndexedDB log, or outbox, including ordered rapid
  Code updates, offline-save authentication on reconnect, recoverable rejection,
  and Call update coalescing, failure, and reconnect retry;
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

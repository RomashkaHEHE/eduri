# Eduri Engineering Guide

## Board v2

Before changing the lesson board, read `docs/BOARD_ARCHITECTURE.md`. It is the
source of truth for the Board v2 product requirements, data model, sync
semantics, offline behavior, assets, and rollout.

Before changing user-visible input, tools, editors, shortcuts, or interaction
states, also read and update `docs/BOARD_CONTROLS.md`. It is the exhaustive
reference for currently implemented web controls and edge cases.

The following rules are non-negotiable:

- The board is local-first. A local edit is applied and durably queued locally
  before any network round trip. Normal operation has no Save, Refresh, or
  Retry workflow.
- The canonical board model and wire protocol must not depend on React, DOM,
  Excalidraw, Konva, Pixi, Socket.IO, or another renderer/transport.
- Board state uses a granular CRDT. Do not reintroduce whole-scene
  last-write-wins snapshots as the collaboration protocol.
- Reconnect sync transfers only missing updates by state vector. Offline edits
  converge automatically without a conflict dialog.
- Web hydration starts from an empty Y.Doc and a bounded update-v1 IndexedDB
  log. Cross-tab messages are hints followed by authoritative database rereads;
  never trust them as state or compact into one unbounded whole-document row.
- Images and other binary assets are first-class and durable. Store immutable,
  content-addressed blobs outside the CRDT and keep a persistent local upload
  outbox. Never advertise an asset tool that can silently lose the asset.
- Cursors, selections, laser pointer, active tool, and live gesture previews use
  ephemeral awareness. Identity fields come from the authenticated server, not
  arbitrary client payloads.
- Undo/redo tracks local command origins. `Ctrl+Z` must not undo another
  participant's work.
- Shapes are versioned, namespaced plugins. Unknown or newer shapes must survive
  round trips and render as a safe placeholder rather than being deleted.
- Text, code, and LaTeX source use collaborative text types. Receiving a remote
  code update must never execute it.
- There is no small total-scene cap. Resource protection uses documented
  per-frame, per-asset, rate, tenant quota, and free-disk guards. The UI exposes
  document, update-log, asset, and total size.
- The web client is one adapter. Core schema, commands, migrations, golden
  protocol fixtures, and persistence interfaces must also be usable by a future
  optimized desktop client. Rust/Yrs compatibility is an explicit target.
- Board v2 is the only active lesson-board engine. Production had no lesson
  board history when this switch was approved. Do not reintroduce Excalidraw,
  whole-scene Socket.IO writes, per-board canaries, or an automatic legacy
  fallback. Retained legacy database columns are recovery data, not a writer.
- Keep the global Board v2 switch as a fail-closed operational circuit breaker.
  Disabling it must make the board explicitly unavailable. Before the first
  real production lesson, complete the remaining acceptance and physical-device
  checks recorded in the architecture document.

Changes to Board v2 require tests proportional to the affected invariant.
Sync/storage changes require convergence, duplicate/reordered update,
offline/reconnect, restart durability, ACL revocation, and compaction tests.
Renderer/input changes require desktop, mobile, touch, stylus, and performance
verification.

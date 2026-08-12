# Eduri Board v2 Architecture

Status: accepted architecture, Board v2 is the only active lesson-board engine.

Date: 2026-08-02.

This document defines the product and engineering contract for the next Eduri
board. It exists so future work does not optimize the current Excalidraw
snapshot implementation into a dead end.

## Current implementation status

Board v2 is enabled by default for development and new deployments. The active
lesson workspace has no legacy renderer or automatic fallback. The owner
confirmed that Eduri has not yet been used for lessons, so there is no
production board history to migrate. A global emergency switch remains, but
disabling it makes the board explicitly unavailable instead of mounting a
different writer.

Implemented in the Board v2 path:

- renderer-independent, Yrs-compatible Yjs update-v1/state-vector-v1 schema and
  a fully specified binary protocol with machine-readable golden fixtures;
- local-first hydration from an append-only update-v1 IndexedDB log with
  bounded module-worker suffix compaction, durable update outbox, cross-tab
  authoritative reconciliation, bidirectional state-vector
  reconnect (including IndexedDB-only crash-window edits), multi-update cold
  sync for documents larger than one logical frame, authenticated awareness,
  durable ACKs, chunking, automatic retry, passive session audits, outbound
  recipient reauthorization, durable causal replay order, and atomically
  persisted bounded repair sequences for out-of-order or history-only updates;
- solo-to-guest Board promotion that flushes and replays the chronological,
  bounded local update-v1 log through the ordinary provider, publishes copied
  assets and finalizes the server draft before navigation, cancels failed
  drafts, and rejects an oversized in-memory-only aggregate before room
  creation instead of turning total document size into one frame;
- Konva viewport culling, safe unknown/future-object placeholders, local-only
  undo/redo, versioned built-in style capabilities and defaults, atomic mixed
  multi-selection styling, local creation-tool presets, deterministic
  fractional z-order with four layer commands, offline copy/cut/paste through
  the portable Board Fragment v1 format, collaborative text/code/LaTeX source,
  executable code blocks, click-anchored code/LaTeX/image placement tools,
  straight and quadratic curved line/arrow geometry, remote cursors,
  selections, Drawing-integrated multi-stroke laser sessions, bounded live
  gesture previews, hostile-style sanitization and bounded static text previews
  at the renderer boundary, a ref-aware
  decoded-image LRU, a site-wide light/dark local presentation theme,
  device-local grid,
  configurable toolbar, and connector-curvature preferences, an accessible
  object/canvas context menu, display-paced rendering, and standard scoped
  selection and navigation shortcuts;
- mouse, pen, and touch gesture ownership, pointer capture cleanup, pinch zoom,
  containment/`Shift`-intersection marquee and freeform-lasso selection,
  continuous erasing,
  transform persistence, and responsive controls;
- private content-addressed image storage, resumable upload, cross-tab repair,
  durable remote caching, MIME/hash/decode validation, atomic tenant quota and
  free-disk reservations, and explicit terminal-failure recovery;
- byte-budgeted server document LRU, schema validation on a shadow Y.Doc before
  persistence, transactional worker-thread compaction, board metrics, atomic
  CRDT-update tenant-quota/free-disk admission, an atomic offline application
  shell, and emergency recovery bundles that can stream large local assets
  without loading them all into memory.

Still required before the first real production lesson:

- the complete browser and physical-device acceptance matrix, including
  Safari/iOS and Chrome/Android stylus, IME, backgrounding, and long-session
  tests;
- ordinary board import/export;
- rendered KaTeX plus the planned snippet engine (the current LaTeX object
  already preserves collaborative source but renders it as source text);
- a user-facing recovery-bundle import flow, named pages, and material/task
  references.

The normative desktop-compatible wire description is
[`BOARD_PROTOCOL_V1.md`](./BOARD_PROTOCOL_V1.md).
The complete reference for currently implemented web input, tool, editor,
offline, read-only, and cancellation behavior is
[`BOARD_CONTROLS.md`](./BOARD_CONTROLS.md).

## Product contract

The board must feel local even when it is collaborative:

- input appears immediately;
- saving, reconnecting, compaction, and asset upload are background work;
- losing the network does not stop ordinary drawing or editing;
- reconnect merges offline work without asking the user to resolve conflicts;
- the user is interrupted only when data is genuinely at risk or permission was
  revoked.

Priorities, in order:

1. Performance and input latency.
2. Stability and acknowledged-update durability.
3. No routine friction: no manual save, refresh, or reconnect.
4. Convergent, high-quality synchronization.
5. Fast cached and cold loading.
6. Clear, compact, pleasant tutor-oriented UI.
7. Full and reliable tools, including images.
8. Deep Eduri integration: materials, executable code blocks, lesson state.
9. Extensible versioned objects such as LaTeX, graphs, and future plugins.
10. Correct desktop, tablet, phone, touch, mouse, and stylus behavior.
11. A renderer-independent protocol suitable for a later optimized desktop app.

CRDT convergence means every replica reaches the same state. It cannot preserve
two incompatible intentions applied to the same scalar property. The model must
therefore make conflicts granular, keep transforms atomic, and use awareness to
reduce simultaneous edits to the same object.

## Decisions

### CRDT

Use Yjs 13.x and the standard Yjs update/state-vector format.

Reasons:

- compact incremental binary updates;
- fast synchronous startup without a large WASM bootstrap;
- mature IndexedDB persistence and awareness ecosystem;
- origin-aware `Y.UndoManager`;
- transport independence;
- compatible Rust implementation (Yrs) for a future native client.

Automerge remains a valid alternative but is not selected because its browser
startup and package cost are higher and local-only undo requires more custom
work.

### Renderer

The canonical document does not contain renderer objects.

The first native Board v2 web renderer will use imperative Konva behind a
`BoardRenderer` interface. Konva supplies mature hit testing, scene layers,
dragging, transforms, and Canvas export under an MIT license. Viewport culling
and a spatial index are required.

PixiJS/WebGPU remains a replaceable renderer if representative benchmarks show
that Canvas2D cannot meet the budgets below. A renderer replacement must not
change the CRDT schema or protocol.

Do not use tldraw without a separately approved production license. The tldraw
5.2.5 default license prohibits production deployment. Excalidraw is not an
Eduri runtime dependency. A future optional importer may parse its JSON through
an isolated adapter, but Excalidraw must never become the canonical Board v2
model or an automatic fallback writer.

### Module boundaries

Target boundaries:

```text
src/board/core/          DOM-free schema, commands, undo, migrations, metrics
src/board/protocol/      versioned binary frames and capability negotiation
src/board/persistence/   LocalStore, RemoteSync, AssetStore interfaces
src/client/board/        web IndexedDB, provider, UI, input, renderer adapters
src/server/board-v2/     ACL, sync, SQLite log/snapshot, compaction, assets
```

`core`, `protocol`, and persistence contracts must run in Node tests without a
browser. They may later move unchanged into a workspace package shared by web
and desktop.

## Document model

Board v2 has a small manifest document and one document per page. The first
release creates one infinite default page, while the split permits lazy loading
when named pages are added later.

### Manifest

The manifest contains:

- page IDs, names, fractional ranks, background, and grid settings;
- board-level extension metadata;
- references to reusable components/templates.

Authoritative generation, protocol version, schema compatibility, and ACL live
in SQLite and the authenticated handshake. A client cannot lower them through a
CRDT edit.

### Page

Each page has an `objects` Y.Map keyed by a stable UUID. Every object is a
versioned, namespaced plugin record:

```text
id
kind             e.g. eduri/text, eduri/stroke, eduri/code
version
transform        atomic [x, y, width, height, rotation]
zRank            fractional ordering key
parentId
style            granular Y.Map
props            versioned plugin data
```

Rules:

- coordinates are device-independent logical units;
- camera, zoom, current tool, selection, presentation theme, toolbar layout,
  and connector/ordinary creation preferences are local view state;
- a transform is one atomic value so concurrent movement cannot combine `x`
  from one user with `y` from another;
- text, code, and LaTeX source use Y.Text;
- a completed freehand stroke stores immutable packed/delta-coded points;
- live stroke preview is awareness data, not hundreds of durable CRDT writes;
- connectors retain bindings plus fallback coordinates; current built-in line
  and arrow version 1 geometry stores finite local `start` and `end` points and
  an optional finite local quadratic `control` point inside versioned `props`;
- unknown object kinds and newer versions keep their opaque plugin style/props
  byte-for-byte preserved and render as safe placeholders; generic core
  envelope fields remain subject to schema-safe core commands;
- plugins provide validator, migrator, renderer, editor, exporter, bounds, and
  optional accessibility description.

Initial plugin set:

- selection/hand;
- one free-drawing tool whose local presets cover both opaque drawing and
  wide translucent highlighting, and whose pre-held standalone `Alt` exposes
  an awareness-only temporary laser mode using those same presets;
- text;
- line, arrow, rectangle, ellipse, diamond;
- eraser;
- image;
- frame;
- collaborative Python code block;
- collaborative LaTeX source block.

Implemented integrated object plugins:

- `eduri/latex`: raw LaTeX Y.Text with a source preview today; KaTeX rendering
  and a separate snippet engine modeled after LaTeX Suite remain planned;
- `eduri/code`: Python language, collaborative Y.Text source, browser runner
  profile, explicit output snapshot, and a textarea editor today; a future
  CodeMirror overlay remains editing UI rather than canonical object state.

Planned next plugins:

- function plot/coordinate plane;
- material/task reference with immutable source identity.

A remote code update never invokes a runner. Execution is an explicit,
authenticated command and must use the existing browser sandbox or a future
isolated runner.

The current Eduri product accepts and executes only Python. New code objects
and the lesson socket use `language: "python"`; legacy client payloads may be
read to preserve their source but are normalized to the Python workspace and
can never select or execute a JavaScript runner. The versioned language field
remains in the renderer-independent object schema so a future explicitly
approved language plugin does not require changing the CRDT envelope.

### Line and arrow geometry

Built-in version 1 line and arrow objects share one DOM-free geometry contract.
Their local `props.start` and `props.end` are required two-finite-number tuples;
`props.control`, when present, is one two-finite-number tuple defining a
quadratic Bezier. Absence of `control` means the historical straight segment,
so existing straight records need no migration. Invalid or unbounded point
data follows the ordinary malformed-object placeholder path and must never be
silently rewritten or deleted.

Creation normalizes all supplied world points into the object's local transform
and stores the concrete control point, not a toolbar curvature scalar. For the
current signed creation preference `c` in `-1..1`, the web adapter derives the
control from start `S`, end `E`, chord length `d`, and its perpendicular unit
normal `N = (-(E.y-S.y)/d, (E.x-S.x)/d)` as
`(S + E) / 2 + N * c * d * 0.75`. A near-zero value omits the control point
completely. This formula is creation policy; the stored three points are
authoritative and allow a future editor or native client to create curves
without reproducing a web preference.

Core geometry computes quadratic extrema for bounds and exposes bounded curve
sampling independently of Konva. The renderer may convert the quadratic to an
equivalent cubic for a drawing API, but that cubic is never canonical state.
The arrowhead uses the end tangent from `control` to `end`; selection, default
containment marquee, `Shift`-inclusive intersection marquee, inclusive lasso,
viewport spatial indexing, transforms, and continuous eraser collision must
all use the curved path rather than the straight start/end chord. Live creation
awareness carries start/control/end as a bounded ephemeral preview and never
executes a durable geometry command on a peer. Native clients must preserve the
optional point and match these bounds, hit, and tangent semantics through
protocol fixtures.

## Built-in styling and z-order

### Versioned style contract

The durable `style` Y.Map contains granular object overrides. Built-in readers
derive the effective style by shallowly overlaying those stored values on the
defaults for the exact `(kind, version)` pair. Defaults are not written back
during read or hydration. Deleting an override exposes the versioned default.

The following built-in version 1 capability/default table is normative.
Capabilities are a set; their order in an implementation is not semantic.

| Built-in kind | Supported style capabilities | Version 1 defaults |
| --- | --- | --- |
| `eduri/rectangle`, `eduri/ellipse`, `eduri/diamond` | `stroke`, `strokeWidth`, `fill`, `opacity`, `dash` | `stroke=#17212b`; `strokeWidth=2`; `fill=rgba(255,255,255,0)`; `opacity=1`; `dash=[]` |
| `eduri/line`, `eduri/arrow` | `stroke`, `strokeWidth`, `opacity`, `dash` | `stroke=#17212b`; `strokeWidth=2`; `opacity=1`; `dash=[]` |
| `eduri/frame` | `stroke`, `strokeWidth`, `fill`, `opacity`, `dash` | `stroke=#8492a6`; `strokeWidth=1.5`; `fill=rgba(255,255,255,0)`; `opacity=1`; `dash=[8,6]` |
| `eduri/stroke` | `stroke`, `strokeWidth`, `opacity`, `dash`, `blendMode` | `stroke=#17212b`; `strokeWidth=2.5`; `opacity=1`; `dash=[]`; `blendMode=source-over` |
| `eduri/text` | `fill`, `fontSize`, `fontFamily`, `fontStyle`, `opacity` | `fill=#17212b`; `fontSize=20`; `fontFamily=Inter, Arial, sans-serif`; `fontStyle=normal`; `opacity=1` |
| `eduri/latex` | `fill`, `fontSize`, `fontStyle`, `opacity` | `fill=#17212b`; `fontSize=22`; `fontStyle=normal`; `opacity=1` |
| `eduri/code` | `fontSize`, `opacity` | `fontSize=14`; `opacity=1` |
| `eduri/image` | `opacity` | `opacity=1` |

For text and LaTeX, `fill` is the foreground/glyph color. An incompatible
change to capabilities, defaults, or a property's meaning requires a new object
plugin version. Older clients preserve unknown style entries but do not expose
or interpret them. A known kind with a newer unsupported object version keeps
the existing safe-placeholder behavior instead of applying version 1 defaults.
Web and native renderers must use the same table rather than renderer-library
defaults.

Creation-tool presets are local input/view state. They are not part of the
board CRDT, awareness, wire protocol, or undo history, and changing a preset
does not modify existing objects. A preset affects only subsequently created
objects, whose concrete style overrides are then written through the ordinary
durable object-add command. Current browser-profile persistence and any future
personal preset synchronization belong in user/device settings outside the
board document.

The Drawing tool uses an ordered palette of stable device-local composite
preset slots containing `id`, `stroke`, `strokeWidth`, and `opacity`. A fresh
profile starts with the six built-in graphite, red, blue, green, orange, and
wide translucent yellow slots, but the live palette may contain 1-24 slots.
Choosing an inactive slot in ordinary mode applies the whole preset; choosing
the active slot again opens its color, thickness, and opacity controls. The
slot indicator renders opacity over a transparency grid, and at 100% board zoom
its circle radius in CSS pixels equals the logical stroke width. The supported
`0.5..16` range therefore fills the 32 px indicator at its maximum. New
freehand strokes are always solid and source-over. The version-1 `dash` and
`blendMode` fields remain readable and round-trip-safe for retained data, but
the web UI does not offer dash for freehand strokes.

The web adapter also treats vertical-dominant wheel input over a slot as a
device-local width edit of that exact slot. It consumes the event before the
camera, steps by `0.5` inside `0.5..16`, and neither selects the slot nor opens
its editor. Pixel-mode trackpad deltas accumulate to one logical notch per 24
CSS pixels with direction, target, and 180 ms idle resets; a single event cannot
contribute more than one notch, while line/page-mode events contribute one.
Horizontal-dominant input remains native strip scrolling. Browser pinch
`Ctrl`/`Cmd+wheel` and wheel during an owned reorder are consumed without a
value change. The active creation style follows an edited active slot, but an
in-progress stroke retains its pointer-down style snapshot. This input state,
like every other palette edit, is outside CRDT, awareness, protocol, and board
undo.

Palette configuration is web-adapter UI state, not a board mode. Its palette
toggle applies a restrained, theme-specific scrim to the underlying style bar
while leaving the toggle and edit controls operable; the pressed toggle uses a
distinct accent in both themes rather than sharing the dark-theme hover color.
There is no separate global Drawing-settings dialog yet. While
configuration is active, pressing any slot opens that slot's editor without
changing the active preset. Add appends a stable-ID clone of the active preset,
keeps it inactive, and opens its editor. Delete cannot remove the final slot;
deleting the active slot chooses the next slot at the same index, or the
preceding slot when the deleted slot was last. Reorder preserves the slot ID
and active ID.

The web adapter supports mouse/pen reorder with a 3 CSS-pixel activation
threshold. Touch distinguishes a pre-hold horizontal scroll with a separate
6 CSS-pixel slop from reorder, which becomes eligible after a 240 ms hold and
uses the 3 CSS-pixel activation threshold; a secondary pointer cannot steal
the gesture. Preview is animation-frame-coalesced: the grabbed slot follows
the pointer without reordering its DOM node, neighboring slots translate to
open the prospective gap, and crossing is calculated from the dragged slot's
center so the grab point cannot bias the target. Edge scrolling is
refresh-rate-independent and bounded by the intrinsic range captured before
preview transforms; it stops at a physical or logical reorder boundary.
Window listeners cover failed pointer capture. Pointer-up performs no extra
edge-scroll step and at most one final-index commit; the DOM reorder and preview
teardown share a transition-free commit frame, while returning to the source
index is a local no-op that still suppresses the trailing click. Pointer
focus and an active pointer drag have no persistent selection ring or synthetic
drag outline, while keyboard `:focus-visible` retains the accessible slot
outline. The edit-only add control is an absolute sibling outside the centered
preset strip's flex/scroll geometry, so its appearance has zero influence on
the strip's centered position; adding a real slot still widens and recenters
the strip. Width-capped centered layouts reserve enough symmetric side room
for this docked control, while fixed-left responsive layouts reserve its space
only on the right; both retain horizontal access to every real slot. Its
standalone surface consumes the same light/dark adapter tokens as the rest of
the board controls, rather than inheriting contrast from the strip scrim. The
`Alt+ArrowLeft`/`Alt+ArrowRight` shortcuts provide a one-position accessible
reorder for a focused slot
and consumes boundary no-ops. Pointer cancellation, capture loss, window blur,
tool change, unmount, configuration toggle, and `Escape` discard an unfinished
preview and suppress any trailing compatibility click. The
configuration-specific `Escape` order is active reorder, open slot editor,
then configuration mode. Dark-theme contrast, horizontal overflow,
coarse-pointer target sizing, focus restoration, and live announcements remain
adapter concerns; none changes the renderer-independent model.

Palette selection, value changes, add/delete/reorder operations, popup state,
and configuration state are outside the page/manifest Y.Docs, awareness,
wire protocol, and `Y.UndoManager`. They cannot modify existing objects or
consume/create a board undo item. Only a later object-add command materializes
the then-active preset as concrete durable stroke style. A palette operation
therefore remains available without a network connection and never causes a
collaboration packet.

The current device format is a local-storage envelope under
`eduri-board-free-drawing-presets-v2`, guarded at a maximum serialized string
length of 65,536 UTF-16 code units:

```json
{"version":2,"presets":[{"id":"graphite","stroke":"#17212b","strokeWidth":2.5,"opacity":1}]}
```

V2 loading is structurally fail-closed: the envelope version, array, 1-24
count, object records, and ID uniqueness must all be valid or the complete V2
value is rejected. Each stable ID must match
`^[a-z0-9][a-z0-9:_-]{0,63}$` under JavaScript Unicode/case-insensitive flags.
Supported style scalars are then normalized to six-digit hex color,
`0.5..16` width in `0.5` steps, and `0..1` opacity in `0.01` steps. A
missing or rejected V2 value may migrate the exact six-entry array from the
read-only
`eduri-board-handwriting-presets-v1` key; retaining that old key as read-only
also keeps rollback from overwriting a newer variable palette. If neither
format is usable, the built-in six slots are copied. Writes are best-effort,
debounced by 180 ms, flushed synchronously on browser `pagehide` and surface
unmount, and never block input. Slot count, order, IDs, and values persist;
configuration/popup state and the active ID do not. Every remount activates the
first slot in the loaded order.

Ordinary tools use the same separation between durable object values and local
input settings. Stroke, fill, and text foreground controls consume one shared
device-local Color Library, but a durable object always stores the concrete
color string selected at creation/apply time. No object stores a palette-slot
ID, so editing, deleting, or reordering a favorite cannot recolor an object or
change a creation preset. Transparent fill remains an explicit semantic action
rather than an alpha-bearing favorite. Existing safe alpha colors continue to
round-trip and render, while new picker values are canonical opaque six-digit
sRGB HEX plus the object's separate general opacity.

The Color Library has 1-24 uniquely identified, ordered favorites and up to
eight canonical, deduplicated MRU colors. Its strict device envelope is
`eduri-board-style-color-palette-v1`:

```json
{"version":1,"slots":[{"id":"graphite","color":"#17212b"}],"recentColors":["#123456"]}
```

The whole stored value is rejected for a version/structure/count/ID/color/MRU
violation or input beyond 65,536 UTF-16 code units. Stable IDs use the same
bounded identifier grammar as Drawing slots. Storage access is best-effort;
writes are debounced for 180 ms and flushed on `pagehide` and adapter unmount.
Mouse/pen/touch reorder previews, focus, popup placement, and recent-color
presentation are web-adapter concerns. Color editing is entirely in-app: the
web adapter must not render an `input[type=color]`, open a platform color
dialog, or expose the browser EyeDropper. The shared editor owns one
floating-point HSVA draft while it is mounted and presents a saturation/value
plane, a 0-359-degree hue rail, and a live preview. Input updates that draft
synchronously; conversion to canonical opaque six-digit sRGB HEX occurs only
at the frame-coalesced adapter callback boundary. A parent echo of the emitted
HEX therefore cannot be reparsed into a slightly different hue, saturation, or
value during a gesture. Achromatic and quantized near-achromatic samples retain
the deliberate draft hue, while a genuine external value change resynchronizes
the idle editor.

Pointer and touch drags use pointer capture and coalesce preview callbacks to
animation frames. Failed or unexpectedly lost plane capture installs a
gesture-scoped window fallback for the owned pointer only; up, cancel, blur, or
unmount always removes it. Hue and alpha rails follow the same ownership rule:
successful input capture receives the terminal event, while failed or lost
capture installs an axis- and pointer-scoped window move/up/cancel fallback that
samples the final outside coordinate before closing the gesture. The visual
two-dimensional plane is exposed to assistive technology as two native range
axes, saturation and brightness, rather than one semantically false slider.
Each axis is keyboard-adjustable in one-percentage-point steps, ten with
`Shift` or page keys, and by bounds with `Home`/`End`; the hue rail retains
native range-input semantics and closes Arrow/Home/End/PageUp/PageDown gestures
on matching key-up. An assistive/programmatic range change with no active
pointer or key owner is a bounded discrete gesture.

The ordinary style-color variant keeps alpha fixed at one. Only the Drawing
preset editor enables the optional alpha rail, which maps to that device-local
slot's separate `opacity` scalar in `0..1`; it never emits an alpha-bearing
stroke color. Its visual range runs from the selected opaque color at the left
to the same color at zero alpha over a checkerboard at the right. The native
range value remains opacity alpha (`1` at the RTL-mapped left, `0` at the
right), and adapter callbacks receive that value unchanged after snapping to
the configured alpha step relative to its minimum. The same precision-safe
normalization applies to RGBA, HSVA, and eight-digit HEXA input before any
preview or commit. This presentation does not
merge alpha into an ordinary object's color or silently replace the separate
general object-opacity control. Transparent shape fill remains its existing
semantic action.

The preview is also the advanced-format trigger. A `contextmenu` action on it
suppresses the browser menu and lazily mounts the inline format panel;
`Context Menu` and `Shift+F10` provide the keyboard equivalent and focus the
first format field. The panel and its draft rows do not exist in the ordinary
picker DOM while closed. It exposes synchronized RGB/RGBA and HSV/HSVA rows as
appropriate plus six-digit HEX or eight-digit HEXA when alpha is enabled.
Native paste/edit followed by a valid commit is parsed through strict finite
channel bounds and updates the same HSVA draft; invalid or incomplete input
stays visibly invalid and cannot reach a preset, command, or MRU. Each row
copies its current canonical representation rather than a dirty draft through
the Clipboard API and reports success or failure without changing color.
`Escape` discards any uncommitted row draft, closes and unmounts this advanced
panel, restores the preview focus after unmount, and does not close its host
popup.

Favorites and MRU colors are independent horizontally scrollable web-adapter
rows. Both reserve a bottom lane so their visible thin scrollbar cannot overlap
ordinary or coarse-pointer color targets. Chromium/WebKit uses a theme-aware
6 CSS-pixel track with no end arrows; Firefox uses its platform thin scrollbar.
Wheel/trackpad input selects the greater-magnitude delta axis (vertical on a
tie), uses pixel deltas directly, converts a line to 32 CSS pixels, converts a
page to the row's client width, and clamps the result to the row's finite
`0..scrollWidth-clientWidth` range. A changed position consumes native scroll
and propagation. A bound or non-overflowing row performs no horizontal write
and leaves browser default uncancelled, but still stops propagation before the
board camera. `Ctrl`/`Cmd` pinch and wheel during an owned palette reorder are
consumed without movement. Native horizontal touch panning remains available;
Favorites configuration retains its pre-hold-scroll versus 240 ms hold-to-
reorder ownership rule. These operations modify only local DOM `scrollLeft`.
They never select or change a color, reorder palette state, move the camera,
write profile storage, CRDT or awareness, or affect undo history.

The saturation/value handle keeps stable visual dimensions and renders the
canonical draft color in its circular center. Hue and optional alpha rails keep
a 30-CSS-pixel ordinary hit height and a 38-CSS-pixel coarse-pointer hit height,
but their visible tracks are 14 CSS pixels tall with only a one-pixel corner
radius. Each rail thumb is a borderless 7 by 14 CSS-pixel rectangle filled with
the selected color, exactly spans the visible track vertically, and uses only
external light/dark box-shadow rings so its fill is not consumed by an inset or
centered border. The hue rail's seven HSV sector colors are regenerated from
the current draft saturation and value, so low-saturation or low-value choices
do not show a misleading fully vivid rainbow. The alpha rail places its
selected-color-to-transparent gradient over a theme-aware checkerboard. These
are web presentation details and do not alter color normalization, command
grouping, CRDT state, awareness, or the picker input protocol.

For a selection, one picker pointer/keyboard gesture is one continuous local
command and undo item, regardless of its number of animation-frame previews.
Pointer-up, the corresponding key-up/blur, or a valid advanced-format commit
flushes the last preview and commits only that final color to the MRU. Pointer
cancellation, capture loss, and browser blur flush the queued preview before
terminating the capture. Popup dismissal or unmount preserves previews already
emitted but discards a still-queued animation-frame sample before the undo
boundary closes, so no delayed style write can escape the gesture. An
uncommitted or invalid advanced draft adds no MRU entry. Editing a Color Library
or Drawing-preset color/alpha remains device-local, produces no Yjs transaction
or board undo item, and likewise never adds the edited slot value to MRU merely
because it was previewed.

The portalled popup treats its complete composed DOM subtree as internal.
Pointer-down on its header text, labels, non-interactive background, or picker
surface cannot be misclassified as outside focus and close it. Interactive
descendants keep normal focus behavior. Opening focuses the non-modal dialog
container so native sequential navigation starts inside the portalled subtree;
pointer-down or focus genuinely outside the trigger and popup retains the
documented dismissal behavior.

Text, Line, Arrow, Rectangle, Ellipse, Diamond, and Frame keep independent
device-local creation styles in the strict `eduri-board-tool-styles-v1`
envelope. All seven records and only the capabilities declared by the exact
creation tool are serialized; unsafe scalar values fall back to that tool's
versioned default. The adapter accepts arbitrary safe colors, `0.5..96` stroke
width, `0.05..1` opacity, up to eight dash segments of `0..256`, `8..256` font
size, a renderer-safe comma-separated font-family stack, and canonical
normal/bold/italic tokens. This envelope uses the same 65,536-code-unit,
version, 180 ms debounce, `pagehide`/unmount flush, and storage-failure rules as
the Color Library. These records are profile/input state outside the page and
manifest Y.Docs; a later object-add command copies their current concrete
values into the new object.

The web style adapter must not turn common suggestions into durable
allow-lists. Its one-press colors, line patterns, font stacks, and font sizes are
accelerators. Arbitrary validated color, exact numeric width/opacity/font size,
safe font-family fallback stack, and bounded dash pattern remain available.
Mixed values stay explicit, and a change targets only compatible versions. The
style bar intentionally exposes no broad reset action or callback for a
creation style or selection; users change its individual properties directly.
This does not affect the toolbar-layout reset or the independent Line/Arrow
curvature reset, which remain adapter controls with their documented scopes.

Text foreground uses a swatch-only color trigger without a paint-bucket glyph;
the contextual label and resulting glyph color already identify its meaning.
The web adapter hides general opacity for Text creation and for a selection
whose opacity-capable targets are exclusively Text and/or LaTeX. This is only a
UI decision: the version-1 `opacity` capability, stored override, default,
renderer behavior, and round-trip preservation remain intact.
A mixed selection which also contains an opacity-capable non-text object may
show the union's opacity control and apply it to every compatible target.

The ordinary font-family control is a portalled select-only combobox/listbox
with the exact friendly labels `Inter`, `Georgia`, `Cascadia Code`, `Arial`,
`Verdana`, `Trebuchet MS`, `Times New Roman`, and `Courier New`. Every ordinary
option and the closed selected/custom value renders through the complete stored
font-family stack it represents. Mixed state and `Другой шрифт...` use the
interface font instead. Choosing a named option still writes its full validated
fallback stack, so presentation labels cannot erase deterministic fallback
behavior needed by web and future native clients. A stored custom stack is
represented by its first family name without being collapsed to that label in
durable state.

The combobox supports Arrow navigation, `Home`/`End`, printable-key typeahead,
`Enter`/`Space` selection, cancel-and-focus-restore with `Escape`, normal focus
traversal with `Tab`, and outside-pointer dismissal. `Другой шрифт...`
explicitly opens the existing custom stack editor; that path keeps its
validation, commit, blur, cancel, and focus behavior and accepts at most eight
comma-separated families and 256 UTF-16 code units. The font-size input has no
browser spinner chrome. Wheel over that input changes the bounded `8..256`
value by `0.5`, or `5` with `Shift`, consumes the camera wheel event, and groups
an uninterrupted wheel burst as one continuous style command.

For a multi-selection, the style UI exposes the union of capabilities declared
by the selected supported `(kind, version)` contracts. Applying one property
targets only selected objects that declare that capability; unsupported objects
remain unchanged. Mixed effective values remain explicitly mixed until the user
chooses a value. The core validates every target and the complete set/delete
patch before mutation, rejects collaborative types inside style values and a
property present in both set and delete, then applies all target changes in one
named Yjs transaction with the local device origin. The whole patch is one
local undo item; continuous controls use one gesture capture boundary. Undo
must preserve independent remote style, transform, and content changes.
Bold and italic are aggregated independently as tri-state controls. A mixed
toggle applies a distinct canonical `fontStyle` value to each affected object
through one atomic per-target core command, so adding bold never removes an
object's existing italic token.

Collaborative style and text values are untrusted input. The web renderer
applies finite, bounded dash, font-size, color, font-family, and font-style
values before invoking Canvas2D. Static text/code/LaTeX previews and metadata
labels render bounded UTF-16 prefixes with an explicit ellipsis. These are
renderer-only safety limits: the full CRDT values remain intact for editing,
sync, recovery, and a future native client.

### Fractional object ranks

Object `zRank` generation follows the exact behavior of
`fractional-indexing` 3.2.0. A valid stored rank:

- is non-empty ASCII matching `^[0-9A-Za-z]+$`;
- is accepted as both a lower and upper bound by that version's key algorithm;
- sorts strictly between its non-null lower and upper bounds;
- is never compared with locale collation, case folding, or Unicode
  normalization.

`null` denotes an unbounded lower or upper side. Batch generation returns the
requested number of distinct, strictly ordered keys inside the interval.
These golden values are part of the desktop portability contract:

```text
after(null)                  = a0
after(a0)                    = a1
between(null, a0)            = Zz
between(a0, a1)              = a0V
betweenN(null, null, 5)      = [a0, a1, a2, a3, a4]
betweenN(a0, a1, 2)          = [a0G, a0V]
```

All canonical object ordering uses a lexicographic unsigned UTF-16 code-unit
comparator: compare corresponding code units from left to right; the first
smaller unit sorts first; if the shared prefix is equal, the shorter string
sorts first. Objects first compare `zRank` and then stable UUID `id` with the
same comparator. For example, `Zz < a0`, `a0 < a00`, and the UTF-16 pair for
`\u{1f600}` sorts before `\uffff`. Rust/Yrs clients must compare sequences from
`encode_utf16()` for full parity, not Rust UTF-8 bytes, Unicode scalar values,
locale APIs, or platform string collation. Valid ranks and UUIDs are ASCII, but
the UTF-16 rule also makes ordering deterministic while malformed non-ASCII
input is being contained or normalized.

Duplicate ranks can arise from concurrent insertion and remain convergent
because the UUID tie-breaker defines a total order. A local create or reorder
that needs fresh intervals first normalizes readable objects when ranks are
invalid or duplicated: sort by the canonical `(raw zRank, id)` order and assign
a fresh `betweenN(null, null, count)` sequence. Malformed records are not
rewritten. Readable unknown/newer plugin records participate only through their
generic core envelope; normalization may replace their `zRank` but must not
interpret or modify opaque style/props. Normalization uses its own non-local
origin and is excluded from local undo; the user's subsequent reorder remains
one local undo item. Merely reading, rendering, or hydrating a document must
never normalize or otherwise write ranks.

The four durable multi-selection commands are:

- `front`: place the selected objects after every unselected object;
- `forward`: move each selected run across at most one adjacent unselected
  object toward the front;
- `backward`: move each selected run across at most one adjacent unselected
  object toward the back;
- `back`: place the selected objects before every unselected object.

Layer-order commands are deliberately absent from the style bar for every tool
and selection. The web adapter exposes them through one `Порядок слоёв` group
in the selected-object context menu, whose side menu contains all four commands,
and through the documented keyboard shortcuts. Collapsing those commands into
an adapter-only menu group or removing duplicate style-bar buttons does not
change the four core commands or their undo semantics.

Every command deduplicates selected IDs, preserves the selected objects'
relative order, assigns all required fractional ranks in one named local Yjs
transaction, and is one undo item. A command that cannot change the order is a
local no-op and adds no undo entry; prerequisite invalid/duplicate-rank
normalization may still have emitted its separate system transaction.
Concurrent rank writes still follow ordinary CRDT scalar semantics: replicas
converge deterministically, but two incompatible layering intentions are not
both preserved.

The DOM-free Board Fragment v1 core is the canonical selection-transfer
foundation. Its binary container is:

```text
"EDURI_BOARD_FRAGMENT_V1\n"
uint32-le JSON header byte length
UTF-8 JSON header
standard Yjs update-v1 payload
```

The header fixes `format`, fragment and schema versions, source board,
generation and page scope, canonical source-order object IDs, and payload byte
length. The update contains one isolated
`eduri.board.fragment.objects` map. It preserves collaborative and opaque Yjs
types, explicit style overrides, binary values, object versions, and unknown
plugin data without passing through a renderer snapshot.

Decoding validates the complete header, update, roots, records, internal IDs,
and canonical source z-order before a target document may change. Insertion
uses caller-generated fresh UUIDs, remaps included parents, detaches external
parents, applies one finite translation or center anchor, and assigns distinct
fractional ranks preserving source order. Any prerequisite target-rank
normalization retains its system origin; all inserted objects are one local
command and undo item. Multi-object deletion likewise validates every target
before one local transaction.

Fragment guards are per operation rather than a total-board cap: 50,000
objects, a 4 MiB header, a conservative 12 MiB update-v1 payload, and a bounded
encoded container. The update margin keeps the rebuilt one-transaction paste
below the 16 MiB sync update limit. A fragment reports valid version-1 built-in
image identities and unresolved future/malformed image references so an
adapter can refuse a transfer that would create a broken asset.

The web adapter uses this format for ordinary copy, cut, and paste without a
network round trip. Clipboard events write a custom MIME value with a text
fallback; toolbar actions retain a same-tab fallback when browser clipboard
permission is unavailable. Cut removes the source objects only after a
confirmed system clipboard write and only while the source document and
selection remain unchanged. Paste is serialized, placed at the pointer or
viewport center with a repeated-paste cascade, selects the inserted objects,
and remains one local undo item. Read-only users may copy but cannot cut or
paste, and text/code/LaTeX editors keep native clipboard behavior.

The web clipboard adapter also accepts external clipboard content. One
clipboard snapshot is classified globally in this fail-closed order:

1. a claimed and valid Board Fragment custom MIME;
2. a valid Board Fragment encoded in its `text/plain` fallback;
3. the first PNG, JPEG, WebP, or GIF blob;
4. non-empty `text/plain`.

A claimed or prefixed malformed Board Fragment is an error and never degrades
to an image or ordinary text. External text is preserved exactly, including
leading/trailing whitespace, and creates one `eduri/text` object with a
collaborative `Y.Text`; one external-text operation is limited to 4 MiB of
UTF-8 so its single Yjs update remains safely below the 16 MiB protocol guard.
This is not a document-size limit. External images use the same durable asset
outbox as the picker and create no CRDT object until local blob persistence
succeeds. After the object commit, the web adapter directly activates Select
and makes the new image the sole selection. A pending, failed, or invalidated
image insertion preserves the preceding local tool and selection.

Rich clipboard blobs are byte-guarded before their complete text is
materialized. A custom-MIME blob larger than the maximum encoded fragment is
rejected without reading its full body. For `text/plain`, the adapter first
reads only a bounded prefix to distinguish the reserved
`EDURI_BOARD_FRAGMENT_` namespace: ordinary text then uses the 4 MiB text
limit, while a fragment uses the encoded-container limit. Oversized reserved
or ordinary payloads fail closed without allocating an unbounded JavaScript
string.

Native paste-event data is authoritative and never falls back to remembered
same-tab state. Toolbar and context-menu Paste use the rich Async Clipboard API
when the browser exposes it, fall back to `readText()`, and may use the
remembered Eduri fragment only when system reads are unavailable or denied.
All payload kinds share one ordered paste queue, and a toolbar/context command
reserves its place before its asynchronous system read resolves. The target
document, monotonic document/access epoch, world anchor, camera zoom, and
viewport are captured when the command is invoked. A document or read-only
transition starts a fresh current queue without waiting for stale work; even an
A-B-A or writable-read-only-writable transition cannot revive the old epoch.
Cursor/camera movement, transition, unmount, or document replacement during
later clipboard, decode, or persistence work cannot retarget or partially
commit the operation.

The target also captures a local history epoch. Any successful local Undo or
Redo which pops a history item starts a new history epoch, immediately releases
the current clipboard-busy state, and invalidates unresolved paste/duplicate
work from the preceding history state.
A late image decode, asset persistence, clipboard read, or fragment validation
therefore cannot create a new command and clear a Redo stack after the user has
already moved through history. Every successful insertion is bracketed by undo
capture boundaries so it remains one independent undo item even if
collaborative text or another local command changed while its asynchronous
preparation was pending.

Same-board image references remain valid. A foreign-scope fragment is rejected
before CRDT mutation unless every referenced image already has the exact
hash, byte count, and MIME identity in the target board's durable asset store;
repeated identities are deduplicated before bounded-concurrency lookups, while
conflicting identities for one asset fail before storage access. Unresolved
future image versions are never guessed across scopes. Ordinary board
import/export is not implemented yet. It must reuse this format and transfer
referenced asset bytes without making the web implementation canonical.

## Commands and undo

All durable user changes go through named core commands and Yjs transactions
with a local device origin. Migration, normalization, server, and other system
transactions use explicit stable non-user origins.

`Y.UndoManager` tracks only local user origins. Migration, normalization,
server, and remote origins are excluded.

Command capture boundaries:

- one pointer drag is one undo item;
- one completed stroke is one item;
- multi-object transform is one item;
- one atomic multi-object style patch is one item;
- one continuous style-control gesture is one item;
- one multi-object z-order command is one item;
- typing groups in a short 400-500 ms window;
- tool switch, pointer-up, explicit command, and focus change stop capture.

Undo/redo is collaborative: undo emits a new CRDT update but never rewinds or
removes another participant's independent work. It is ordinary session undo,
not Git history. Cross-session version history is intentionally out of scope.

## Web input, themes, and frame pacing

Keyboard commands are active only while focus is inside the board. They use
physical `KeyboardEvent.code` values so `Ctrl/Cmd+A`, undo/redo, tool keys, and
zoom commands work with Russian and Latin keyboard layouts. Collaborative text,
code, and LaTeX editors retain native selection and clipboard behavior and
route only their local undo/redo through the local-origin undo manager.

The web adapter consumes the standalone `KeyboardEvent.key === "Alt"` press
inside non-editor board chrome and the matching release, even if focus drifts
before that release. This prevents browser chrome from stealing a live board
gesture. It does not consume `AltGraph`, native editor input, or other key
events merely carrying `altKey`, and it does not synthesize modifier state:
the Select tool's lasso choice and eraser restore continue to read `altKey`
from each pointer/mouse event. Consuming the key event alone changes no board
state. The remembered pressed-key set is browser-adapter state only, cleared on
blur and unmount, and never enters the CRDT, awareness, undo, or wire protocol.

Selection follows established desktop conventions:

- the hand is an implicit pan mode rather than a visible toolbar tool; choosing
  Select while it is already active, including with `KeyV`, toggles to this
  mode and leaves every visible tool unselected, while choosing Select again
  returns to ordinary selection;
- `Ctrl/Cmd+A` selects every mutable object;
- a plain object click selects it alone or preserves its already-selected group,
  while `Shift`-click toggles only that object;
- `Shift` is the only additive area-selection modifier: whether it was held at
  pointer-down is captured independently for the complete gesture, and a
  `Shift` marquee or `Shift+Alt` lasso unions matches with the complete
  pointer-down selection even if `Shift` is later released;
- arrow keys move the selection by one logical unit, or ten with `Shift`; one
  held-key gesture is one local undo item;
- `Ctrl/Cmd+D` duplicates the portable selection fragment locally in one undo
  item, and `Enter` edits one selected text, code, or LaTeX object;
- `Escape` cancels an active gesture, then closes an editor, clears selection,
  or returns to Select without committing a draft;
- `Ctrl/Cmd` plus/minus zooms around the viewport center, `Ctrl/Cmd+1` returns
  to 100%, and `Ctrl/Cmd+0` or `Home` fits content.

Every web camera path uses one shared 2%-2000% zoom clamp. Toolbar and keyboard
steps preserve the viewport-center world point, wheel zoom preserves the
pointer world point, pinch preserves its gesture anchor, and Fit content also
uses the same limits. Renderer adapters must not introduce narrower bounds.

A rectangular marquee normally matches a supported mutable object only when
its complete rendered hit geometry is contained by the rectangle, with an
equal boundary accepted. While `Shift` is currently held during that gesture,
the rectangle instead uses inclusive any-intersection: exact object geometry
may touch its boundary or filled area, lie inside it, or, for a closed shape,
enclose it. Both modes include stroke width, curved paths, arrow heads,
rotation, and Frame/Area labels and do not depend on whether the renderer node
is materialized in the viewport. Broad-phase bounds overlap alone is never a
match.

The rectangular geometry modifier is live and independent from the additive
flag captured at pointer-down. Board-scoped `Shift` keydown/keyup invalidates
membership even without pointer movement, and every owned pointer or
compatibility-mouse event reconciles the current state. Pressing `Shift` during
a marquee therefore changes preview and final matching to any-intersection;
releasing it returns them to containment. If `Shift` was held at pointer-down,
the result remains additive for the complete gesture despite a later release.
If it was not held then, a later press changes geometry only and does not union
the captured base selection.

Holding standalone `Alt` at pointer-down ignores object/Transformer hits and
creates an implicitly closed freeform lasso instead. The lasso uses an
inclusive even-odd region and matches any object geometry that touches its
boundary or filled area, lies inside it, or encloses it. Closed built-in shape
interiors remain selectable for this object-level test even when their visual
fill is transparent. Its geometry is already any-intersection, so `Shift`
changes lasso behavior only when it was present at pointer-down to set the
additive flag; later `Shift` changes do not alter lasso matching. The renderer
uses the geometry spatial index as a broad phase, samples in screen space, and
progressively compacts a long contour with an error-bounded corner-preserving
simplifier to a maximum of 2,048 points so release work remains bounded.
Concave broad-phase rejection occurs before exact long-stroke geometry is
decoded. Rectangle and lasso previews are renderer-local,
screen-constant dashed/translucent shapes and never enter the CRDT, awareness,
or undo history. Candidate membership and final release share the same exact
geometry functions: full rendered-geometry containment for a marquee without
`Shift`, inclusive rendered-geometry intersection for a marquee while `Shift`
is held, and inclusive any-intersection for every lasso. Preview/final union
uses only the independently captured pointer-down additive flag.

`Ctrl/Cmd` held before Select pointer-down is a hit-bypass rather than an
additive modifier: it ignores any object or Transformer and starts the same
ordinary rectangular area gesture as empty canvas. Initial `Alt` still chooses
lasso. An initially held command modifier is latched as construction input and
cannot move that area until both `Ctrl` and `Cmd` have been released and either
is pressed again during the same pointer gesture. Every pointer-down creates a
fresh latch, including consecutive gestures while the user keeps `Ctrl` held.
Once armed, `Ctrl/Cmd` freezes construction and translates the complete
unfinished rectangle or lasso by screen delta divided by zoom without moving
the camera. Releasing it resumes construction from the translated endpoint
without a jump; repeated phases accumulate and pointer-up applies the final
movement delta.

Live area-selection membership is display-paced. Pointer/coalesced geometry
changes and armed `Ctrl/Cmd` translation schedule at most one membership pass
per animation frame; complete scene replacement, individual object
add/change/delete, and zoom change invalidate the preview and schedule the same
bounded pass. Pointer-up always performs one synchronous final calculation
against the newest gesture geometry and object scene, so a pending or stale
visual frame cannot alter the committed result.

The live candidate IDs are renderer state only. Until pointer-up they do not
replace the committed selection, invoke `onSelectionChange`, enter awareness,
write either Y.Doc, or touch `Y.UndoManager`. While the gesture owns input, the
renderer suppresses committed Transformer/selection chrome and transform
handles. It draws the dashed translucent rectangle/lasso as the aggregate
gesture area and solid noninteractive outlines for its materialized candidate
nodes. Individual preview outlines are capped at 512; above that budget the
renderer shows bounded aggregate-only candidate chrome while retaining the
complete candidate set for final selection. Cancellation removes the gesture
and candidate chrome, cancels a scheduled membership frame, and restores the
unchanged committed selection chrome without a callback or awareness update.

During every selection-area gesture, selected object dragging and Transformer
input are suspended and restored on finish or cancellation. More generally,
renderer object/Transformer input is disabled while a Select-owned pan or pinch
gesture is active, preventing compatibility mouse/touch events from racing the
gesture owner.

The web toolbar is a device-customizable view over stable tool identities.
Select is outside customization and remains visible in the first position.
The complete ordered customizable registry is Drawing, Eraser, Text, Line,
Arrow, Shape, Code, LaTeX, and Image. A fresh profile places the first six on
the main toolbar and the final three in overflow. An unchecked item is hidden
from the main strip but remains available in overflow; visibility is not
feature enablement. Code, LaTeX, and Image use ordinary ordered tool slots
rather than a fixed special-tools group or visual separator. Shape is one
stable tool identity and one layout item. Its toolbar and overflow entries are
ordinary single actions with no split button, arrow, shape menu, or nested
shape list. Rectangle, Ellipse, Diamond, and Frame remain distinct canonical
object kinds and creation commands; the active Shape tool chooses among them
through an adapter-local segmented setting in its style bar. That setting
starts as Rectangle after a surface remount, emits no awareness active-tool
change, CRDT transaction, or undo item, and is snapshotted together with the
selected kind's independent creation style at pointer-down. Changing it cannot
retarget an in-progress gesture. A missing durable-image host capability
disables Image wherever it is rendered without removing its registry row or
rewriting the preference.

Laser is not a stable tool identity or configurable registry row. While the
stable Drawing tool is active, a pre-gesture standalone `Alt` hold temporarily
changes its Pencil button to a minimal pointer presentation. The renderer
reports only that presentation state to the toolbar adapter: Drawing remains
selected, keeps `P`/`2`, uses its palette, and remains the advertised active
tool. Configuration always shows Drawing with Pencil. This transient state does
not enter the toolbar preference, CRDT, awareness active-tool field, command
log, or undo.

Configuration may reorder all customizable items and toggle their visibility;
Select cannot be moved or hidden. Native drag/drop, explicit Up/Down commands,
and `Alt+ArrowUp`/`Alt+ArrowDown` are equivalent adapter inputs. Reset restores
the default complete order and visible subset. The dialog's focus trap,
dismissal, dark/coarse-pointer presentation, and menu navigation are web UI
concerns. Read-only users may change this device preference even though
mutating tools remain disabled. Hiding an active tool does not change it.

The strict current-device envelope is stored under
`eduri-board-toolbar-v2` as
`{"version":2,"order":[...],"visible":[...]}`. `order` contains all nine
registry IDs exactly once; `visible` is a unique subset whose display order is
always derived from `order`. Parsing is structurally fail-closed, rejects input
over 65,536 UTF-16 code units, and restores the complete default on any unknown,
missing, duplicate, malformed, or wrong-version value. Writes are immediate
and best-effort; storage failure never blocks the in-memory toolbar.

Only when the v2 key is absent, the adapter reads the former strict
`eduri-board-toolbar-v1` version-1 envelope with ten registry IDs. A valid
legacy envelope is migrated in memory by removing `laser` from `order` and
`visible` without changing the relative order or visibility of the other nine
items. An existing malformed v2 value fails closed to defaults and must not
fall back to v1. Reset immediately restores the default order and visible set,
then ordinary persistence writes that default as a valid v2 envelope. An older
v1 value may remain in storage, but it is ignored while the v2 key exists. This
setting and migration are outside the manifest/page Y.Docs, protocol,
awareness, undo, and board recovery data. A native client may provide a
different toolbar while retaining the same stable tool and object identities.

Plain numeric tool aliases are also stable identities, not toolbar positions:
`1` Select, `2` Drawing, `3` Eraser, `4` Text, `5` Line, `6` Arrow, and `7`
Shape. Shape also retains the letter alias `R`; the former shape-specific
`O`/`D`/`F` and `8`/`9`/`0` inputs are not intercepted. Reordering, hiding,
overflow placement, and the selected concrete shape never renumber the tools.
Visible buttons surface the corresponding alias as faint lower-right adapter
chrome; overflow rows may show it as a compact key label. The indicators have
no backing, border, or shadow, remain outside the centered icon footprint, and
do not adopt the active-tool accent. They do not enter board state, awareness,
history, or the renderer-independent protocol.

Line and Arrow also keep independent signed creation-curvature preferences
under `eduri-board-connector-curvature-v1`. The strict device value has exact
`{"version":1,"values":{"line":number,"arrow":number}}` structure, is bounded
to 1,024 UTF-16 code units, rejects non-finite/out-of-range `-1..1` input, and
normalizes accepted values to 0.05 steps. Both default to zero. The slider,
exact percent input, and reset-to-straight command change only this local
creation setting; they create no CRDT transaction, awareness update, or undo
item. A creation gesture snapshots its selected tool's value at pointer-down
and materializes only the resulting optional control point in the new object.

Code, LaTeX, and Image use the same active-tool lifecycle as other tools.
Pressing a toolbar/overflow item only selects and advertises the tool; it never
creates an object or opens a picker. Their renderer-owned primary gesture
captures the pointer-down world/screen point and emits that world anchor on
pointer-up only while maximum travel remains at most 8 CSS pixels. Pointer
cancel, capture loss, tool/read-only transition, blur, hidden document,
context-menu opening, destruction, or pinch takeover emits no command.

On that accepted callback, the UI adapter freezes the current document,
access/history epochs, supplied anchor, camera, and viewport. Code and LaTeX
create their nominal 360 x 240 and 260 x 110 objects centered on that anchor,
downscaling but never upscaling to the captured viewport, select them, and open
their editor. Image placement opens the native picker synchronously from the
same pointer-up callback to preserve browser user activation, then validates
and durably stores the blob before creating the centered CRDT object. Picker
cancellation or any frozen-scope invalidation creates no object. Successful
tool placement does not force a different tool, so Code, LaTeX, or Image stays
active for repeated use unless another local action changed it. Clipboard image
insertion deliberately remains a separate paste command which activates Select
after commit. These differences are adapter command policy, not object schema
or transport behavior.

Placing a new empty text box starts a renderer-local provisional editor rather
than a CRDT object. The first textarea value containing a non-whitespace
character synchronously creates the versioned `eduri/text` object with the
complete, untrimmed current value and immediately continues through its
collaborative `Y.Text` binding. Whitespace-only input remains provisional.
During IME composition, promotion waits for `compositionend` so replacing the
binding cannot interrupt the browser's active composition. The web adapter
tracks the interval from `compositionstart` through `compositionend` explicitly
instead of relying only on optional per-event `isComposing` flags; composing
`Enter`/`Escape` keystrokes remain owned by the IME rather than closing the
editor. Closing, replacing, or revoking access to a still-empty provisional
editor creates no object, update, selection, awareness state, or undo item.
Undoing the initial add closes the now-invalid editor state when it removes the
object. Once promoted, the object follows ordinary collaborative text
semantics; it is never deleted merely because a later edit makes its text empty,
since a concurrent remote insert must not be lost.

The web renderer intercepts `contextmenu` only inside its canvas. A context
request carries renderer-local screen coordinates, the corresponding board
world point, and the hit object identity to the React UI adapter. Opening it
cancels unfinished renderer or node interactions without a partial durable
commit. The UI applies normal desktop targeting: preserve an already-selected
group, select a different mutable object alone, or clear selection on empty or
unsupported content. Its actions reuse the same core commands and guarded
clipboard paths as toolbar and keyboard entry points. Keyboard menu access,
bounded placement, focus navigation, read-only filtering, and native editor
context menus remain adapter behavior and do not enter the CRDT or wire
protocol. The layer commands are presented as a sibling side-menu panel so
scroll clipping cannot hide it and keyboard traversal stays scoped to one menu
level. Mouse/pen hover, click/touch activation, parent/child focus transfer,
delayed pointer transit between panels, outside-pointer ownership, and
right-preferred placement with left-edge flipping are likewise local web UI
behavior. Selecting a leaf still invokes exactly the same guarded core command
and local undo transaction as its keyboard shortcut.

Drawing's laser-modifier behavior is explicitly order-sensitive. When
standalone `Alt` is already held at Drawing pointer-down, the renderer latches
that gesture as a temporary laser stroke. It must not create a durable freehand
object. `AltGraph` is excluded. Releasing `Alt` during the stroke records a
pending session release but does not change the latched gesture: laser sampling
continues until pointer-up and only then may the session fade. Pressing `Alt`
after an ordinary freehand pointer-down can never activate laser. `Ctrl/Cmd` is
independent of laser and retains the unfinished-stroke movement behavior below
whether it was held before pointer-down or pressed afterward.

A laser stroke snapshots the current Drawing preset at its own pointer-down and
uses its sanitized color, logical stroke width, and opacity. Its glow follows
that color and uses screen-constant blur. Samples are spaced by at least 2 CSS
pixels and each pointer-down creates a separate path, preventing bridges between
successive strokes. Pointer-up while `Alt` remains held retains the session and
permits further strokes. Every local path remains rendered until release;
per-path progressive 256-point compaction preserves its full span and does not
remove older paths. A separately derived awareness projection carries at most
the newest 16 strokes and 160 aggregate points. If needed, its point budget is
distributed across included paths and sampled evenly from each start to end
without mutating the local session. Each retained stroke keeps its own style
snapshot.

Releasing `Alt` after pointer-up clears laser awareness and fades the complete
retained local session together over 800 ms. An `Alt` release during an active
stroke defers that same action until pointer-up;
re-pressing before pointer-up does not undo the pending release. While retained,
the session remains an active awareness value even when its pointer is
stationary. The awareness protocol's normal heartbeat owns participant
liveness; the renderer must not expire a held session merely because no new
pointer sample arrived. The session is otherwise awareness-only: no object,
command, selection, CRDT transaction, durable update, or undo item exists.

The stable active tool remains Drawing throughout this state machine. The
renderer exposes a transient presentation callback so its toolbar button shows
a minimal pointer icon while a pre-gesture `Alt` hold can start laser, and
while a laser gesture/session is active. It returns to Pencil after release or
cancellation without broadcasting a different active tool. Read-only Drawing
accepts only this pre-held-`Alt` laser branch; ordinary pointer-down remains
non-mutating. A focused board toolbar or palette button does not suppress the
pre-gesture presentation; a focused text-entry control does.

Laser cancellation is immediate, not faded. Pointer cancel, owned capture
loss, pinch takeover, `Escape`, context-menu opening, tool/read-only transition,
window blur, hidden document, renderer replacement/destruction, or other common
interaction cancellation destroys every local retained stroke, clears
awareness with `laserClearMode=immediate`, and restores Pencil presentation.
Normal release uses `laserClearMode=fade`; an older sender without the field is
treated as the compatible fade case. The window-level compatibility
`mousemove`/`mouseup` path uses the same latched gesture, update, retention, and
release rules as Pointer Events.

During one ordinary active freehand stroke, held `Ctrl/Cmd` temporarily drags
the complete unfinished stroke without appending points or moving the camera.
The web adapter accumulates one uniform logical offset, moves its Konva preview
in constant time, and materializes translated durable points only at commit;
the bounded awareness preview carries the same visible translation. The last
point therefore stays under the pointer, so releasing the modifier resumes the
same stroke without a connecting jump. `Shift` creates one replaceable straight
endpoint from the latest committed point; releasing it resumes ordinary
freehand sampling. `Ctrl/Cmd` takes priority when both modifiers are held and
moves that provisional endpoint together with the rest of the stroke.
Pointer-up honors the active mode, and the whole hybrid gesture remains one
object and one local undo item. Wheel camera input is ignored while any pointer
gesture, object drag, or resize/rotate transform is active.

The zoom toolbar has a state-based Home button. If the world origin is not at
the viewport center, the first press centers it without changing zoom. Pressing
Home while it is already centered sets zoom to 100%. Camera movement between
presses starts again with centering; there is no hidden click counter.

The complete selection is local state. Awareness advertises at most 256 object
IDs, independently capped again by the network adapter, so selecting a 10k or
50k fixture cannot violate server frame guards. Remote selection-count or
bounds metadata may be added later without sending the full set.

Local multi-selection chrome is also renderer-only state: it never enters the
CRDT, awareness, command log, or undo manager. When the full editable selection
is materialized and within the Transformer budget, the common group frame is a
screen-constant dashed outline and each selected node receives a separate
noninteractive solid outline. Those outlines are recomputed from cached local
bounds and live node transforms, so they follow drag, resize, and rotation in
the same visual frame while retaining constant screen-space weight at every
zoom. Partly offscreen selections combine a dashed aggregate frame with solid
individual outlines for their materialized members. The renderer suppresses
individual outlines entirely above 512 materialized selected nodes; commands
continue to use the complete local ID set.

The web Transformer's visual and pointer-hit metrics are an explicit
screen-space exception to ordinary world-node inverse-zoom compensation. Konva
Transformer already ignores ancestor transforms when resolving its absolute
transform, so the adapter keeps its 9 x 9 CSS-pixel anchor bodies, constant
pointer targets (including Konva's additional 10-pixel touch hit stroke), 1.5
CSS-pixel anchor/border strokes, 4 CSS-pixel padding, configured 50 CSS-pixel
rotation-anchor offset, and `[7, 5]` CSS-pixel multi-selection dash unchanged
across the shared 2%-2000% zoom range. Applying another inverse-zoom factor
would make this chrome grow while zooming out. These metrics and their refresh
are renderer-local:
they never alter selection, awareness, object transforms, CRDT state, or undo
history; only the completed transform uses the durable command path.

Rotation snapping is likewise web input/renderer policy rather than canonical
object or protocol state. Rotation remains continuous without `Shift`; while a
rotation-handle drag is active, each pointer or compatibility-mouse movement
reads its own modifier state and quantizes the live angle to 45-degree
increments when `Shift` is held. Pressing or releasing `Shift` takes effect on
the next movement and does not recalculate an otherwise stationary preview,
end the transform, or open a new command capture. Pointer-up commits the angle
currently shown through the ordinary atomic transform command, so alternating
between snapped and smooth phases remains one local undo item. The transient
modifier/snap state never enters the CRDT, awareness, or wire protocol.

The web theme is site-wide local device state and is never written to Yjs. One
application preference drives the ordinary site chrome, Monaco editors, and
Board renderer; switching it does not recreate or mutate the document. Dark
mode changes canvas, grid, chrome, transformer, and presence contrast. At the
renderer boundary it adaptively maps only the exact canonical version-1
default dark ink to the documented light theme ink; explicit custom colors and
the stored CRDT style remain unchanged. The web adapter applies the versioned
HTML bootstrap before first paint, reconciles storage/OS state again after
subscription and page resume, and updates both the canvas renderer and Monaco
in the layout phase so one presentation change cannot expose mixed-theme
frames. A native client may implement the same presentation choice without
changing protocol bytes.

Whether grid lines are shown is also a device-local presentation preference.
It is independent of the manifest's future shared grid definition: hiding the
grid changes neither page/manifest CRDT state, awareness, undo, nor the canvas
background. A future shared grid geometry or policy must use a manifest core
command instead of writing an ad hoc field into the page document.

Animation work is scheduled by `requestAnimationFrame`, not a fixed 60 Hz
timer. A 120/144 Hz display can therefore receive frames at its native cadence
when the scene and hardware stay within budget. Raw pointer, camera, preview,
and presence updates are coalesced to at most one visual commit per display
frame; durable final gesture state is never dropped. Selection must not defeat
viewport culling by materializing every offscreen selected node. Bounded
selection chrome may summarize large selections while commands still operate
on the complete local ID set. Per-object local selection outlines iterate only
the already materialized selected nodes and have the 512-node budget described
above, keeping overlay work bounded independently of total selection size.

The web input adapter also accepts legacy compatibility `mousemove`/`mouseup`
events while a mouse pointer is active. This covers OS-level button injection
and touchpad drivers that begin with `pointerdown` but deliver movement through
the legacy mouse stream. Pointer and compatibility events at the same screen
coordinate are deduplicated. A missing, throwing, or empty
`getCoalescedEvents()` result falls back to the current event, so synthetic
input cannot freeze a freehand preview until button release. A bounded
awareness preview carries the effective stroke color, width, and opacity so
wide translucent writing does not change appearance after pointer-up. These
are renderer-adapter rules and do not change commands or CRDT data.

The eraser is also a renderer-local input adapter. While its pointer is down,
the web renderer shows one bounded gray filled silhouette in renderer-local
screen coordinates, independent of board zoom. Visual history is bounded by
fixed source-sample and render-station counts rather than a path-length cutoff.
The old-end speed rises with visible length, so input that grows the trail also
makes it catch up faster. The centerline prefers 1 CSS-pixel path-length
stations up to its fixed station budget. Circular cross-sections and filled
connectors between adjacent stations keep longer spans continuous and give the
silhouette rounded bends and round ends, including at sharp pointer turns.

The silhouette radius varies continuously between stations. Its newest full
diameter changes smoothly from about 15 CSS pixels at low smoothed pointer
speed toward a 9 CSS-pixel minimum at high speed. Every station derives its
diameter from its own smoothed local speed, so subsequent head-speed changes do
not make the whole history pulse. The older end tapers to roughly 55% of its
local speed-derived full diameter. The newest circular end is the head itself
and is part of the same silhouette, not a separate filled primitive. The whole
silhouette is rasterized once with one uniform 0.20-opacity fill; construction
cross-sections cannot accumulate alpha, create darker overlap seams, or expose
sharp joins. Subpixel motion remains visible, and coalesced input samples
receive monotonic times normalized into the `performance.now()` animation-clock
domain.

An animation-frame expiry loop retracts the old end according to
`speed = min(3, 0.015 * length)` CSS pixels per millisecond, where `length` is
the current visual path length in CSS pixels. The formula is integrated over
elapsed time, so longer trails catch up faster up to the configured ceiling
while the result remains refresh-rate independent. Its base speed, length gain,
and ceiling are separate renderer constants for tuning. Movement neither resets
its frame clock nor selects a separate
trimming path. The newest head remains until finish/cancel. The web adapter
rebuilds the initial round head and every later tail section as the same bounded
silhouette, so a separate tail cannot pop into view. One owned display-paced
frame suppresses Konva automatic draw requests while it updates the station
profile and silhouette and then directly draws the preview canvas, avoiding a
second deferred canvas frame. The sample buffer, render stations, animation
timing, and single silhouette primitive are bounded renderer state, not board
state.

A separate thin 24 CSS-pixel-diameter footprint outline centered on the newest
point exposes the actual hit area. Collision remains a continuous swept capsule
with a 12 CSS-pixel radius between every pair of delivered pointer positions,
independent of the speed-sensitive filled silhouette and visual-history
sampling. A dedicated spatial broad phase selects nearby object geometry; the
precise phase tests the complete segment against rotated shapes and the
persisted polylines of lines, arrows, and freehand strokes. It never relies on
discrete point probes or on a currently materialized renderer node, so sparse
events and subpixel objects at minimum zoom cannot create gaps. Crossed mutable
objects stay visible at reduced local opacity to show that they are pending
deletion. Sweeping a pending object while `Alt` is held removes only that object
from the pending set and immediately restores its normal local opacity;
touching an unmarked object with `Alt` is a no-op.

The visual trail, footprint outline, opacity preview, and pending-ID set are
neither CRDT nor awareness state and create no undo item. Pointer-up removes the
trail and commits the remaining IDs atomically through one local delete
command; cancellation, capture loss, tool changes, read-only transitions,
pinch takeover, blur, hidden-document transition, and renderer destruction
remove all trail chrome and restore every previewed object without a durable
mutation.
A zoom change also cancels an active erase gesture because its fixed
screen-space radius maps to a different logical radius; ordinary same-zoom
camera translation keeps world-space gesture continuity.

## Sync protocol

Transport is RFC 6455 binary WebSocket with subprotocol `eduri-board-v2`.
Protocol envelopes and golden fixtures are versioned independently of UI code.
Browser-initiated protocol, recovery, and send-failure closes use private-use
codes `4002`, `4008`, and `4011`; reserved server close codes are never passed
to the browser `WebSocket.close()` API.

Web clients first request a CSRF-protected, 60-second sync ticket scoped to:

- board;
- user and current session;
- board generation;
- protocol/schema range.

The ticket is sent in the first AUTH frame, never in a URL or access log.
Desktop clients use the same ticket endpoint with their authenticated session
adapter.

Ticket admission is bounded before the process-wide store fills: at most 32
unconsumed tickets per session and 64 per user may exist during their 60-second
lifetime. Consuming or expiring a ticket releases both counters. A full ticket
budget returns `429`, `Retry-After`, and a bounded retry delay in the response
body rather than falling through to a retry-looping `500`. The WebSocket
transport admits at most 512 total and 24 per source IP, of which at most 128
total and 8 per source IP may still be waiting for AUTH. An unauthenticated
socket is forcibly terminated after five seconds, so a raw peer that ignores a
WebSocket close handshake cannot retain the admission slot. The reverse proxy independently limits
Board handshakes and concurrent sockets before they reach Node. Production
trusts the proxy-supplied real IP only when the socket peer exactly matches the
single IP configured by `TRUST_PROXY`; broad hop-count/boolean trust is rejected
in production. Direct and untrusted peers use their socket address even if they
forge forwarding headers.

Public guest tickets derive their stable actor identity from an HMAC of the
share capability and device ID. The repository-facing ID uses only its bounded
opaque alphabet (`guest_` plus a base64url digest); display labels and session
hashes remain separate and must never be substituted for that actor ID.

Logical message types:

- AUTH / READY;
- SYNC_STEP1 containing a state vector;
- SYNC_STEP2 containing one independently applicable missing update;
- UPDATE with a unique message ID;
- ACK with durable server sequence;
- AWARENESS;
- CONTROL for permission, asset, lifecycle, and error events;
- CHUNK for bounded reassembly of large logical frames.

Normal edits coalesce for roughly one animation frame. The server:

1. validates protocol, session, current lesson membership, board generation,
   frame/rate limits, and edit permission;
2. durably inserts the update into SQLite;
3. applies it to the cached document;
4. broadcasts it;
5. acknowledges the sender.

It must not broadcast or acknowledge before durable insert. A missing ACK is
safe: the client retains the update locally and state-vector synchronization
will replay anything the server lacks. Message IDs make retries idempotent.

For a public guest Board, a newly committed update and its room/resource
activity renewal occur in the same SQLite transaction. If the guest lease is
no longer active, the update, receipt, sequence, and Board metadata all roll
back. Exact committed receipt replays return their original ACK without
renewing the lease.

The update log is not used to order or resolve edits; Yjs does that. Server
sequence exists for durability, compaction, and observability.

Frames are chunked above a documented threshold. Security limits apply to a
frame/update/asset/rate and available disk, not to the total board. Binary assets
never travel in CRDT frames.

Reconnects and parallel sockets cannot multiply the ordinary per-connection
budgets. In each ten-second window the transport also enforces aggregate source
IP budgets of 4,000 inbound frames and 128 MiB, plus stable-principal budgets of
2,400 updates/128 MiB and 1,200 awareness updates/4 MiB. An authenticated
account shares one principal budget across its devices and boards; all devices
using one public guest board share that board principal. Exceeding a budget
closes the connection explicitly, while the client's durable local outbox keeps
unsent work for a later retry. The rate-limit CONTROL carries a validated
`retryAfterMs`; the provider postpones reconnect and outbox replay until that
window elapses instead of repeatedly reconnecting against the same window.
Server-issued awareness client IDs are released on disconnect, so lifetime
connection churn cannot grow their reservation set without bound.

State vectors are decoded as client-to-clock mappings. Pair order is not
canonical across Yjs and Yrs, so valid pairs are accepted in any order while
duplicates, truncation, and trailing data are rejected.

Reconnect is bidirectional. After `READY`, an editable client first replays its
durable outbox and durably processes every `ACK`; the initial state-vector sync
does not begin until local batches, persistence writes, and pending outbox
entries are empty. `READY` always causes an authoritative document-log and
outbox reread, even when no cross-tab hint was observed. The client then sends
its state vector.
The server replies with zero or more independently applicable `SYNC_STEP2`
updates, then sends its own `SYNC_STEP1`. An editable client answers with one
`SYNC_STEP2` only when its local diff is non-empty and bounded. The server
validates and durably stores that reply before broadcasting it. This closes the
narrow crash window where the Board IndexedDB document log committed an edit
before the separate outbox.

If that history-only client diff is larger than one update, the client does not
encode it as an oversized `SYNC_STEP2`. It restarts the handshake with an empty
state vector, reconstructs the full durable server state in a shadow, captures
only the chronological local deltas that integrate there, and atomically
materializes them into an initially empty durable outbox as multiple ordinary
bounded `UPDATE`s. After their ACKs it performs a final state-vector sync.

A local update receives a monotonic durable queue order in the same IndexedDB
transaction that stores it. Reconnect replay uses this order rather than
timestamps, so reloads, multiple tabs, and clock changes cannot invert causally
related updates. One coalescing interval may produce multiple outbox rows:
contiguous updates merge only while the resulting row remains bounded.

The server checks for an exact committed `messageId` receipt before schema and
semantic-no-op validation. An exact retry receives its original ACK even after
compaction has folded the update into a snapshot. A new update that contributes
no CRDT information receives non-closing retryable `RESYNC_REQUIRED` with
`reason: "NO_NEW_INFORMATION"` without allocating an update-log row, sequence,
or receipt. The client proves the server's durable state through full replay and
uses the same exact-set CAS to remove or replace the redundant outbox row. This
also resolves the legitimate race where one tab uploads document-log state
before its originating tab finishes the separate outbox write.

Before persistence, every update is applied to a validation shadow. Any
unresolved Yjs structs or delete sets are a causal gap, even if the visible
schema still looks valid. The server discards and rebuilds that shadow, keeps
the socket open, and returns retryable `RESYNC_REQUIRED` for the exact
`messageId`. The client retains the update and retries it after an earlier
outbox entry is durably acknowledged.

If the rejected row is already the earliest outbox entry, its predecessor may
be in the Board IndexedDB log but absent from the separate outbox after a crash.
The client requests a rare full durable server replay into a temporary shadow.
After a local persistence barrier, it captures the local mutation epoch, reads
the complete chronological Board IndexedDB update log and the complete durable
outbox, and applies both to that server shadow. It captures the actual Yjs
update events that integrate into the shadow, including missing struct and
delete-set dependencies, instead of encoding the aggregate local state as one
potentially oversized update.

The captured deltas form a causal sequence. Consecutive deltas may be merged
only while the merged update remains at or below the protocol's 16 MiB
`maxUpdateBytes` limit. Every resulting replacement gets a fresh message ID and
a contiguous durable queue order beginning at the earliest covered position.
The first replacement is applicable to the fully replayed server state; every
later replacement is applicable after its predecessors. Ordinary ordered
WebSocket `UPDATE` replay preserves that dependency order and each replacement
is acknowledged independently.

One compare-and-swap transaction replaces the exact complete captured outbox
with the entire bounded replacement sequence, or removes it when replay proves
that no local delta remains. The expected complete set may be empty when
materializing document-history-only deltas; that commit succeeds only while the
authoritative outbox is still empty. A crash therefore leaves either all old
rows or the complete new sequence, never a partial rebase. If the local
mutation epoch changes during preparation, the client abandons that preparation
and resumes ordinary durable queue handling. If another tab changes, adds,
acknowledges, or rebases any outbox row, the exact-set CAS loses and the stale
tab adopts the transaction's authoritative rows instead of overwriting them.
Socket-epoch checks likewise prevent an asynchronous repair prepared for an old
connection from being sent on a newer one. A local edit that begins after the
final epoch check is not folded into the captured replacement: its durable
outbox write either makes the CAS lose or follows the committed sequence in
ordinary queue order.

The 16 MiB limit applies to each replacement update, not to the aggregate
offline backlog. If one indivisible Yjs update event produced by replay alone
exceeds that limit, it cannot be partitioned without inventing CRDT semantics:
the original outbox is preserved and the client enters explicit local recovery.
An aggregate backlog larger than 16 MiB must instead be represented and replayed
as multiple bounded updates. These rules prevent an out-of-order malicious or
damaged update from remaining latent while also preventing a legitimate
IndexedDB-only predecessor or a large valid backlog from deadlocking forever.

A cold document may require any number of `SYNC_STEP2` updates. `CHUNK` bounds
one logical update; it is not a total-document limit.

## Presence

Awareness is ephemeral and never stored in SQLite or IndexedDB:

- cursor in board coordinates;
- selected object IDs;
- active tool;
- Drawing's temporary laser session as an ordered collection of individually
  styled strokes;
- the laser clear mode (`fade` for normal release, `immediate` for explicit
  cancellation);
- current page and optional viewport;
- capped live gesture preview.

Cursor/laser updates are coalesced around 20-30 Hz and interpolated by peers.
Laser payload validation retains at most the newest 16 strokes and 160 total
finite points, and sanitizes each optional color/width/opacity style at the
renderer/network boundary. A retained session stays active until an explicit
clear or participant-awareness removal, including while stationary; normal
awareness heartbeats provide disconnect liveness. Normal release removes it
from awareness and gives peers an 800 ms fade; cancellation removes it
immediately. Selection is sent only on change.

The server owns `userId`, display name, role, and color. It validates that a
connection updates only its negotiated awareness client ID, preventing identity
spoofing or removal of another participant's presence.

Multiple devices for one user are distinct presence instances.

## Offline behavior

Web startup order:

1. create a strictly empty Y.Doc;
2. hydrate it from the Board IndexedDB update log using a namespace containing
   user, board, generation, and document key;
3. render cached state immediately;
4. connect the network provider in the background;
5. exchange state vectors and merge missing updates.

The current web namespace begins with `eduri-board-v2-store3`. This explicit
format gate prevents either an old whole-state y-indexeddb snapshot or the
earlier bounded log without a transactional per-row size index from being
opened as the current format. Board v2 was never production-enabled under the
older namespaces, so no user data migration is required for this gate.

The local document store appends standard update-v1 values. Each append
atomically updates shared row, byte, and revision statistics in the same
IndexedDB transaction, so every tab schedules from authoritative aggregate
accounting rather than a process-local estimate. At 500 rows or 64 MiB of
update-log bytes, it schedules a single-flight background compaction pass after
one second. Production compaction always runs in a dedicated module worker; a
worker creation, protocol, malformed-response, or runtime failure never falls
back to Yjs merging on the main thread.

Each pass scans only the newest suffix, in reverse, bounded to 256 rows and a
32 MiB aggregate input budget, except that one already-indivisible oversized
newest row remains recoverable rather than being discarded. In causal order it
coalesces that suffix into fewer standard update-v1 segments no larger than the
protocol's 16 MiB `maxUpdateBytes`, with the same indivisible-source exception.
For each candidate, a transactional per-row byte index is checked before the
binary value is requested. The size entry and selected value are read in one
short readonly transaction, so the 32 MiB selected-input budget does not
materialize an out-of-budget lookahead row and an append waits for at most the
current selected row read rather than the complete suffix scan. Ordinary
document appends remain independently durable while the worker runs; merge
computation is outside the write transaction.

A short IndexedDB exact-suffix compare-and-swap transaction verifies both the
original total row count and the selected newest auto-increment keys, then
atomically deletes only that suffix and appends its replacements. A concurrent
append or compaction makes the pass stale without deleting either writer's
rows. Worker responses are checked against status-specific protocol invariants,
then the caller rereads authoritative statistics from IndexedDB. A future or
same-revision conflicting response is rejected, and only the reread statistics
drive later scheduling. A stale pass starts with a 250 ms retry and backs off
exponentially to four seconds; after a successful pass, another pass is
scheduled after the normal one-second delay while a threshold remains exceeded.
A worker failure retries after 30 seconds only while a threshold remains
exceeded. An exact no-op pass records its checked row/byte high-water mark and
is retried only after another 128 rows or 16 MiB of log growth, avoiding a hot
loop on large irreducible state.

`flush()` drains ordinary document writes, awaits one current or newly started
compaction pass on a best-effort basis, then drains writes that arrived during
that pass; compaction failure alone does not fail the durability flush.
`destroy()` cancels a scheduled pass, aborts and awaits an active worker,
drains already-queued document writes, and closes the document database.
Document and outbox teardown remain independent, with failures aggregated.

Local edits remain available and durable without a server. The normal connected
state is silent. A small unobtrusive status appears only for offline, pending,
or genuine risk.

Pending updates keep a durable per-document queue order independent of wall
clock time. That order survives restart and makes causal replay deterministic;
temporary causal gaps are retried automatically without a conflict dialog or a
manual refresh. The causal-rebase transaction is crash-safe and guarded by the
exact complete stored outbox and the preparing client's local mutation epoch,
so simultaneous tabs and in-flight local edits cannot replace newer outbox
state. A large aggregate backlog is repaired into as many bounded causal rows as
needed rather than being treated as a board-size failure.

Open web tabs exchange only durable-local-change hints through in-process peers
and `BroadcastChannel`, with `storage`, `online`, and foreground visibility as
fallback hints. Every hint triggers an authoritative outbox reread and a
document-log tail read after the consumer's last applied monotonic row cursor;
hints never carry trusted state. The same authoritative reread includes the
generation-scoped recovery marker; once persisted, it moves every already-open
peer into a read-only recovery state. Recovery peers remain subscribed to
durable-local-change hints and keep rereading the document-log tail and outbox,
so a transaction that finishes just after the marker is still included in the
visible fork and recovery export; they never resume network upload. IndexedDB
compaction preserves cursor safety because it deletes only the selected suffix
and appends replacement segments; the out-of-line auto-increment generator
gives every replacement a key newer than the removed suffix, so a monotonic
tail reader sees each replacement once. History integrated from that log is
not enqueued again, and an online client automatically restarts its state-vector
handshake. Rare causal repair still reads the complete chronological log. A
native client must provide equivalent process coordination or rely on its
transactional local database and reconnect rereads.

A service worker must cache hashed application assets and a local board catalog
so a previously opened board can reload without the network. First-ever offline
access is impossible and is not promised.

Use `navigator.storage.persist()` when available and monitor storage estimates.
Never evict unsynchronized updates or pending assets. If local persistence
fails, keep the in-memory session alive but clearly warn before the user closes
it.

IndexedDB `blocked` events are non-terminal: open, upgrade, and deletion remain
pending until their eventual success or error. Every opened connection closes
on `versionchange`, and teardown closes late-success handles even if the caller
has already observed a terminal open error.

Logout removes the user's local namespaces. Revoking server access cannot erase
data already stored on a device; it prevents future synchronization.

If a lesson is completed, reassigned, or suspended while a client is offline,
security wins: rejected offline work remains as an explicit local recovery
fork/export and is never silently destroyed.

## Assets

Images and future attachments are immutable content-addressed blobs outside the
CRDT.

Insertion flow:

1. reject an empty or over-128-MiB blob before decode;
2. inspect at most the first 1 MiB for the shared PNG/JPEG/WebP/GIF signature,
   encoded dimensions, SVG/unsupported content, and declared-MIME mismatch;
3. decode in the browser and require the decoded dimensions to match the
   encoded header (allowing the width/height transpose produced by EXIF
   quarter-turn orientation) and client dimension/pixel guards; an exposed but
   format-limited `createImageBitmap` decoder falls back to
   `HTMLImageElement`;
4. assign a stable client-generated asset ID and hash the blob with SHA-256;
5. persist the original blob and upload session in IndexedDB/OPFS;
6. create the board object using a local preview only after that durable commit;
7. resume a chunked authenticated upload in the background;
8. independently verify hash, MIME by content, dimensions, frame count, and
   decode safety server-side;
9. atomically publish the private blob and notify connected peers.

Another participant sees a stable `Синхронизируется...` placeholder until the
blob is ready, then it repairs automatically. There is no manual retry during
normal transient failure.

Storage is content-addressed and deduplicated only inside a tutor tenant to
avoid cross-tenant existence side channels. Files stay outside the public web
root. SVG is sanitized/rasterized or rejected, never served as active untrusted
content.

Assets remain for the board lifetime even after object deletion because local
undo or an offline replica may reference them. Garbage collection is a later,
retention-aware operation. Guest-room expiry is the board-lifetime boundary:
its SQLite deletion transaction removes guest blob metadata and durably queues
both published and staging paths. Idempotent post-commit unlink treats `ENOENT`
as success, refuses to delete a newly live key, and retains failures for restart
or maintenance retry.

Migration 16 extends that queue across the complete upload lifecycle. A staging
intent commits before the `.part` file is created; a deterministic final key and
recovery intent commit before the hardlink is attempted. Publication removes
the final intent only in the same transaction that creates ready metadata. Any
filesystem or database failure after the link attempt re-enqueues the final key,
including when room cleanup consumed the earlier intent concurrently. The
migration also derives and queues deterministic final keys for active pre-v16
uploads, so a crash-created hardlink cannot become untracked after restart.

Guest Board assets reuse the same durable asset service through a separate
share-capability router. Every begin, chunk, finalize, status, and content
request requires an allowed application origin, is rate-limited, rechecks that
the guest room is active, and proves that the requested board belongs to that
room's board resource. Guest tenant and actor IDs are derived from server-side
room/resource IDs; no tenant or actor identity is accepted from the client.
The first successful finalize transition and a begin request that creates a new
logical asset link extend the room lease inside the same SQLite transaction as
the ready/link state. A failed lease update rolls the asset change back.
Replaying a completed finalize or beginning the same already-ready
asset is an idempotent no-op and does not extend the lease. Concurrent begin or
finalize contenders derive that decision from the committed row transition, so
only the winner emits the mutation callback; status and content reads do not
emit it either. The authenticated tutor/student asset router retains its
account and CSRF checks and applies a stable-user mutation budget of 600
requests per ten-minute window in production.

Guest asset capacity is not multiplied by creating more rooms: each
server-derived `guest-room-*` tenant has a 512 MiB soft quota and all guest
tenants share a 2 GiB soft quota, including active upload reservations. The
admission check is performed in the same immediate SQLite transaction as the
upload mutation and survives process restarts. Deduplicated blobs do not make
logical metadata free: a tenant may retain at most 10,000 asset rows, all guest
tenants share a 100,000-row ceiling, and every newly-created row reserves 2 KiB
against the free-disk admission check. Those durable row-count checks run in
the same immediate transaction for both new uploads and deduplicated links.
At most two untrusted finalize preflights run concurrently, including file
stat, full SHA-256 hashing, header inspection, and decode; at most eight wait in
the bounded queue, and each Sharp metadata/raw decode has a 30-second timeout.
Queue saturation and storage pressure return retryable explicit errors; they
never discard the browser's durable pending asset.

## Server persistence

The additive schema uses:

- boards, one-to-one with a lesson initially;
- board_documents for manifest/page snapshots and state vectors;
- board_updates for idempotent append-only binary updates;
- board_assets and private tenant-scoped blobs;
- immutable legacy import metadata.

The old `lessons.board_state` and `board_revision` columns are not removed during
rollout.

SQLite WAL remains appropriate for the current single-node workload. Each
active document is cached with memory accounting and idle LRU eviction.

Migration 19 maintains one durable `board_storage_usage` row per board
generation and one `board_guest_storage_usage` aggregate row. The migration
reconciles pre-existing snapshots, state vectors, update rows, receipts, and
legacy sources once; SQLite triggers then update the counters in the same
transaction as document creation/initialization, append, compaction, cascade
deletion, and legacy-source insertion. Quota accounting includes payload bytes,
the retained receipt's bounded identity fields, and conservative row/index
reserves: 1 KiB for a board generation, 1 KiB per document, 2 KiB per update,
2 KiB per receipt, and 1 KiB per legacy import. These are abuse-accounting
reserves rather than estimates exposed as exact SQLite file allocation.

Append admission reads the one board counter and, for guests, the singleton
aggregate counter inside `BEGIN IMMEDIATE`; it never rescans the update or
receipt history. Authenticated tutor admission sums only the bounded per-board
counter rows belonging to that tutor. Compaction transactionally replaces
snapshot/state-vector usage and releases only deleted update payload and row
reserve; lifetime idempotency receipts and their accounting remain. Board
metrics expose receipt bytes, metadata reserve bytes, and the resulting quota
bytes while retaining the existing payload metrics.

A migration that rebuilds `boards` must preserve every direct and transitive
child row. SQLite foreign keys are disabled before the migration transaction,
the replacement table is copied and swapped inside `BEGIN IMMEDIATE`,
`foreign_key_check` must pass before commit, and the previous foreign-key mode
is restored after either commit or rollback. Deferring foreign keys inside the
transaction is insufficient because `DROP TABLE` still executes cascading
deletes.

Public guest rooms use a 48-hour inactivity lease. Issuing a LiveKit join token
is not room activity: it reserves a persistent 15-minute provisional media
slot, explicitly creates the authorized two-person LiveKit room, and the server
then periodically asks LiveKit for the canonical room records. Only a room with
`numParticipants` greater than zero extends the 48-hour lease and refreshes its
media slot. A confirmed-empty provisional slot is released after its short
lease and its never-occupied SFU room is deleted best-effort. LiveKit
`auto_create` is disabled, so a stale JWT without a room-create grant cannot
recreate a room deleted after account, lesson, or membership revocation.
Targets remain eligible for a bounded two-minute late confirmation so a poll
that crosses `expires_at` can renew an actually occupied call before the same
maintenance pass performs cleanup. Guest call room names are derived from the
immutable call-resource key, so the same logical call is reused after an empty
LiveKit room closes. Expiry commits the hashed tombstone and content deletion
first, then passes the stable call room names to best-effort LiveKit deletion;
a LiveKit outage must not roll back or postpone durable expiry. Guest-room
polling and cleanup have an explicit lifecycle hook that is stopped before the
HTTP server closes its database.

Anonymous admission is bounded persistently rather than only by a spoofable
browser header: the service allows at most 200 simultaneously active/draft
guest rooms and at most 32 provisionally activating or canonically occupied
guest calls across them. Merely creating any number of logical Call resources
does not hold those 32 media slots; reservation starts transactionally at token
provisioning and survives restart. Creating rooms is additionally limited to
five per source IP per hour, call-token minting has its own limiter, and the
edge applies independent guest and LiveKit connection/request budgets. Expired
room/activation cleanup releases capacity; a full pool fails with `503` and a
`Retry-After` derived from the nearest persisted slot expiry instead of
overcommitting storage or the SFU.

Compaction:

1. choose a committed high-water sequence;
2. for a production file-backed database, open a read-only WAL connection
   inside a memory-limited worker and stream snapshot plus update rows through
   that committed sequence there; update BLOBs must not be materialized or
   copied through the WebSocket/HTTP event loop;
3. validate its state vector;
4. in one SQLite transaction replace the snapshot and delete only updates at or
   below the high-water mark.

Concurrent later rows remain. A crash before or after the transaction cannot
lose acknowledged state.

One stored snapshot must itself remain a valid, bounded Yjs update. If the
reconstructed snapshot would exceed the per-update protocol limit, compaction
does not delete the incremental log. Cold sync streams the retained snapshot
and updates separately, so this guard never becomes a total-board cap.
The coordinator records the oversized high-water mark, coalesces one queued
rerun per document, and retries only after both a cooldown and a meaningful
amount of later data. It must not rebuild the same oversized history after
every edit. In-memory repositories use an explicit transfer-based fallback for
tests because a SQLite `:memory:` database cannot be reopened by a worker.

Disk-full or database errors produce no ACK and no broadcast. The client keeps
working locally and retries. Never let an in-memory server document become the
only acknowledged copy.

## Size and resource policy

Remove the 1.5 MB total scene limit for Board v2.

The board menu exposes:

- object count;
- compact CRDT snapshot bytes;
- pending update-log count/bytes;
- original and generated asset count/bytes;
- logical total and physical server storage;
- last compaction/synchronization time.

Safety still requires configurable limits:

- frame and reassembled update size;
- individual asset size and decoded pixel dimensions;
- per-tenant and aggregate guest asset metadata-row ceilings;
- update and awareness rate;
- tenant soft quota;
- server free-disk floor;
- active-document memory budget.

The current public-guest storage defaults add a 512 MiB per-board and 2 GiB
aggregate CRDT soft quota across every guest Board. Both counts include
snapshots, state vectors, retained update payloads, lifetime idempotency
receipts, legacy source where present, and the conservative durable row/index
reserves above. Creation, initialization, append, compaction growth, and legacy
insertion are checked transactionally; creating another room, compacting away
payload while retaining receipts, or restarting the process cannot reset or
bypass the budget. These guest limits are operational abuse ceilings, not a
replacement for the no-small-total-scene rule for authenticated lesson boards.

These limits must fail explicitly and keep local pending data. They must not
silently discard work. A large board is handled through incremental updates,
assets outside CRDT, page sharding, viewport culling, and compaction.

## Access and lifecycle

Ticket issuance, AUTH, every durable UPDATE, and every asset request recheck:

- active session;
- allowed origin for web;
- exact current tutor/student lesson membership;
- role and edit permission;
- board generation and lifecycle.

Admin is not a board participant. Existing session/user revocation and student
reassignment hooks also close Board v2 sockets.

Generation prevents a stale offline replica from mutating a deleted, reset, or
recreated board. A tombstone returns a clear BOARD_GONE result.

Completed boards are readable. Final edit policy must be consistent with
offline semantics. If edits are locked, rejected offline work becomes a local
recovery fork rather than disappearing.

## Legacy containment and v2-only rollout

The owner confirmed before activation that production contains no lesson-board
history. Therefore all lessons without a board descriptor create a Board v2
descriptor directly, including database rows whose unused legacy scene column
contains development data. The legacy field is retained unchanged rather than
silently imported or deleted.

The browser does not mount Excalidraw or send `lesson:scene`. The server rejects
every legacy snapshot write after the ordinary access check, including writes
that arrive before a Board v2 descriptor exists or target an explicit legacy
descriptor. Protocol and schema incompatibility are explicit errors and can
never trigger a different board engine. An explicit legacy descriptor also
fails closed on ticket issuance; it is not rewritten on first visit.

The global kill switch remains an operational circuit breaker. When disabled,
the board ticket endpoint returns an explicit temporary-unavailable response
for authorized users. It never enables a legacy writer.

If a legacy import is ever needed for a backup or development fixture, it must
be a separately invoked, additive and idempotent operation:

- retain original JSON, revision, and SHA-256;
- create a manifest/default page;
- convert supported objects to native versioned objects;
- convert unknown objects to bounded placeholders preserving raw data;
- validate object count, bounds, state vector, and snapshot before changing the
  sticky engine descriptor.

Missing image blobs cannot be reconstructed and must render as clear
missing-asset placeholders. There is no bidirectional dual-write.

## Performance budgets

Budgets are measured on representative desktop, tablet, and mid-range mobile
hardware, not assumed:

- local cached board becomes interactive without waiting for network;
- pointer input-to-paint p95 targets one 60 Hz frame for normal scenes;
- frame pacing follows the active display (60/90/120/144 Hz) without an
  artificial 60 fps cap; this is a latency budget, not a promise that every
  device can render every scene at 144 fps;
- representative 144 Hz profiling targets roughly 4 ms of board JavaScript per
  visual frame under 240-1000 Hz pointer input, with DPR 1/2, 10k/50k fixtures,
  three presences, and an active lesson call;
- ordinary edits never transmit the full scene;
- cursor movement remains visually continuous under normal tutoring latency;
- viewport work scales with visible objects, not total board objects;
- cold loading is code-split and does not load board/code runtimes elsewhere;
- fixtures include 10k and 50k lightweight objects plus large external assets;
- server active-document memory remains within configured LRU budget.

`npm run benchmark:board-compaction -- --mib=64` is the reproducible local
worker-side compaction baseline. It reports selected/replacement sizes, elapsed
time, endpoint RSS/heap/external/array-buffer deltas, and verifies the
reconstructed Yjs state vector. Endpoint deltas are not peak-memory
measurements and do not replace browser measurements of module-worker startup,
IndexedDB behavior, or main-thread responsiveness on target devices.

Konva and Pixi representative benchmarks decide renderer changes. Renderer
benchmarks never justify changing the canonical format.

## Foundation acceptance tests

Before the first real production lesson, tests and physical-device checks must
cover:

- two and three replicas with reordered, duplicated, delayed, and replayed
  updates converge to equal state vectors and semantic content;
- simultaneous text, move/style, delete/edit, and z-order operations;
- built-in style capability/default parity across renderers, atomic mixed
  multi-selection patches, token-preserving mixed font-style toggles,
  continuous-control grouping, stable authoritative-HSVA picker
  pointer/touch/keyboard behavior and cancellation, dynamic-SV hue and optional
  Drawing-alpha rails, lazy RGB(A)/HSV(A)/HEX(A) editing and clipboard behavior,
  frame-coalesced preview/final-MRU semantics,
  Drawing-slot mouse-wheel/trackpad normalization and camera isolation,
  Text/LaTeX opacity-control filtering, named/custom font-stack preview and
  complete-stack persistence, font-combobox keyboard/dismissal behavior,
  absence of a broad style-bar reset, spinner-free grouped font-size wheel
  input, absence of duplicate style-bar
  layer controls with grouped context-menu/shortcut parity, hostile remote style/text
  renderer bounds, and local-only undo preserving independent remote changes;
- fractional-index golden keys, UTF-16 comparator parity with Rust/Yrs,
  invalid/duplicate-rank normalization outside local undo, all four
  multi-selection layer commands, and convergence under reordered duplicate
  delivery;
- local-only undo/redo preserving remote changes and gesture grouping;
- offline divergent edits followed by automatic reconnect merge;
- server restart before insert, after insert, and before ACK;
- duplicate message ID idempotence;
- exact committed receipt replay after compaction and automatic semantic-no-op
  repair without log or receipt growth;
- receipt-aware durable quota accounting under adversarial tiny updates,
  compaction, concurrent guest contenders, rejected-append rollback, migration
  reconciliation, cascade deletion, and process restart;
- causal-gap rejection without persistence, followed by ordered automatic retry
  and convergence when the predecessor is acknowledged;
- IndexedDB-only predecessor recovery, including delete sets, crash boundaries,
  local-mutation-epoch invalidation, exact complete-outbox compare-and-swap
  across concurrent tabs, and restart replay of the rebased causal sequence;
- an empty-outbox IndexedDB-only diff above 16 MiB materialized as multiple
  bounded, causally ordered ordinary updates and followed by a final sync;
- causal-gap repair whose aggregate valid backlog exceeds 16 MiB, proving that
  every persisted replacement is bounded, applies in causal order, and
  converges without recovery; an indivisible emitted update above 16 MiB must
  preserve the old outbox and enter explicit recovery;
- bounded suffix compaction with concurrent durable writes, shared threshold
  accounting, exact no-op verification/cooldown, worker abort/crash/malformed
  response handling, and atomic replacement fault injection;
- cold sync whose aggregate document state exceeds one reassembled frame;
- reconnect upload of local state present in IndexedDB but absent from outbox;
- schema-poison rejection before durable append and clean reconnect afterward;
- unauthorized tutor/student/admin, suspension, reassignment, session expiry,
  and lifecycle revocation;
- awareness spoof/removal rejection;
- cached offline reload and local quota failure behavior;
- offline image insert, interrupted upload/resume, remote repair, reload, ACL,
  MIME/hash mismatch, and decompression-bomb protection;
- unknown future object preservation by an older client;
- mobile/touch/stylus gestures and responsive controls;
- synthetic keyboard-to-mouse button injection, empty coalesced samples,
  mixed pointer/mouse movement, and cursor awareness during renderer-owned
  drag/transform gestures;
- Drawing modifier ordering: pre-held standalone `Alt` latches an
  awareness-only laser while `Ctrl/Cmd`, including when pre-held, retains
  unfinished-stroke movement; `AltGraph` never starts laser; `Alt` release
  during laser remains latched through pointer-up;
  `Alt`-held multi-stroke retention keeps every local path without connecting
  bridges and clears only on final release; per-stroke Drawing-preset
  color/width/opacity snapshots, full-span 16-stroke/160-point awareness
  projection that never prunes local geometry, stationary remote retention, and
  an 800 ms grouped release fade; immediate cleanup of active and pointer-up
  retained sessions on pointer cancel/capture loss,
  pinch, `Escape`, context menu, tool/read-only transition, blur, hidden
  document, replacement, and destruction; parity under legacy mouse injection;
  zero CRDT/selection/undo mutation, read-only laser-only Drawing, and transient
  Pencil/pointer toolbar presentation after canvas, toolbar, or palette focus
  without active-tool identity changes;
- focus-scoped, keyboard-layout-independent shortcuts, default rectangular
  containment, live `Shift` inclusive marquee intersection (including partial
  touches and closed objects enclosing the marquee), press/release preview and
  final parity without pointer movement, independently latched pointer-down
  `Shift` additive union despite later release, non-additive mid-gesture
  `Shift`, inclusive lasso intersection with `Shift` affecting only its
  pointer-down additive mode, bounded long/concave contours, `Ctrl/Cmd`
  hit-bypass plus release/repress area movement
  at non-default zoom and across consecutive held-modifier gestures,
  display-paced live membership parity with final predicates, additive union
  and moved-area recomputation, scene/object/zoom invalidation, cancellation
  restoration, no pre-release selection/awareness mutation, and bounded
  aggregate-only chrome above 512 materialized candidates,
  exact screen-constant Transformer visual/hit anchors, anchor/border strokes,
  padding, rotation offset, and single/multi-selection dash at 2%, 100%, and
  2000% zoom without selection, awareness, durable-transform, or undo mutation,
  smooth rotation plus 45-degree `Shift` snapping when held before or during a
  rotation, next-movement release back to smooth rotation, stationary modifier
  changes, and one atomic transform/undo item across repeated snap transitions,
  2%-2000% zoom-bound parity across direct camera, toolbar, keyboard, wheel,
  pinch, and Fit-content paths with stable anchors at both limits,
  standalone-Alt browser suppression without editor/AltGraph/pointer-modifier
  regressions, large `Ctrl/Cmd+A` awareness/culling bounds, context-menu
  targeting/focus/read-only/undo behavior, layer-side-menu hover/click/touch and
  level-scoped keyboard navigation, outside-pointer ownership, right/left edge
  placement and resize clamping, local grid visibility, and light/dark contrast;
- fixed-first Select, nine-item customizable registry without standalone Laser,
  default main/overflow split, one stable Shape button and overflow row without
  a split action or nested menu, four inline segmented shape-kind settings,
  per-kind creation-style restoration, pointer-down kind snapshots, and only
  `R`/`7` activating Shape while former shape-specific aliases remain
  unconsumed, arbitrary visible/hidden ordering, drag/button/keyboard toolbar configuration,
  focus/dismissal/read-only behavior, strict v2 preference parsing and reset,
  v1 migration which removes only the former `laser` row while preserving
  remaining order/visibility, malformed-v2 precedence, storage failure, remount
  restoration, and numeric shortcut stability independent of order and
  visibility;
- line/arrow curvature preference independence and strict persistence,
  straight-object compatibility, quadratic bounds and transform parity,
  arrow-end tangent, live preview, marquee/lasso inclusion, viewport indexing,
  and eraser collision across every curve direction and zoom;
- one-fill eraser-trail silhouette at 2%, 100%, and 2000% zoom, bounded
  source samples and render stations, preferred 1-CSS-pixel arc-length
  sampling with continuous filled connectors beyond that budget, uniform
  opacity without alpha overdraw, rounded bends and ends, continuous 15-to-9
  CSS-pixel speed response, roughly 55% old-end taper, length-sensitive
  `min(3, 0.015 * length)` CSS-pixel/ms retraction during movement and idle
  independent of display refresh rate, separate 24-CSS-pixel footprint
  parity, and complete finish,
  cancel, capture-loss, tool-change, read-only, pinch, blur, hidden-document,
  zoom-change, and destruction cleanup;
- code/LaTeX/image tool selection without eager creation, exact click anchoring,
  8-CSS-pixel movement tolerance, drag/pinch/cancel suppression, repeated-tool
  behavior, editor/selection policy, synchronous picker activation, frozen
  document/camera/viewport/history target, durable asset-before-object commit,
  picker cancellation, and late document/access/history invalidation;
- clipboard fragment/image/text priority, malformed-fragment fail-closed
  behavior, rich-clipboard degradation, frozen asynchronous anchors, ordered
  mixed-payload paste, durable image-before-object insertion, text byte guards,
  editor-native paste, read-only, document replacement, and local-only undo;
- the emergency Board v2 switch fails closed without exposing or accepting a
  legacy board writer.

## Delivery order

1. DOM-free schema, commands, protocol fixtures, SQLite repository, compaction,
   and convergence/fault tests behind a disabled production flag.
2. IndexedDB provider, service worker board cache, awareness, and asset outbox.
3. Polished Konva BoardSurface with cursors, selection, local undo/redo, core
   tools, responsive input, import/export, and size UI.
4. V2-only activation, legacy-write containment, and explicit compatibility
   errors.
5. Code block, LaTeX/snippets, graph, material/task, templates, and named pages.
6. Desktop client spike using the same protocol and golden fixtures.

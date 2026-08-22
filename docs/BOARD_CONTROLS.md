# Eduri Board v2 Controls

Status: exhaustive reference for the currently implemented web client.

This document records user-visible Board v2 controls, input semantics, state
transitions, cancellation rules, and important browser fallbacks. It describes
implemented behavior, including edge cases that are easy to miss. Product and
protocol invariants remain normative in
[`BOARD_ARCHITECTURE.md`](./BOARD_ARCHITECTURE.md) and
[`BOARD_PROTOCOL_V1.md`](./BOARD_PROTOCOL_V1.md).

There is no Save, Refresh, or routine Retry action. Ordinary edits are applied
locally first, queued durably, and synchronized in the background.

## Focus and command scope

- Board keyboard commands run only while `document.activeElement` is inside
  the board surface. Pressing the canvas or its host focuses the surface without
  scrolling it.
- Shortcuts use physical `KeyboardEvent.code` values. They therefore remain in
  the same physical positions under Russian and Latin keyboard layouts.
- Board commands do not intercept events whose target is an `input`,
  `textarea`, `select`, or `contenteditable` element. A focused toolbar
  `button` is still inside the board command scope unless a lower-level control
  handles the key itself.
- While focus is in non-editor board chrome, the web adapter consumes the
  standalone left or right `Alt` key on `keydown` and its matching `keyup`.
  This prevents browser chrome from taking focus during pointer gestures.
  Native inputs/editors, `AltGraph`, and events for other keys which merely
  carry `altKey` remain untouched.
- Tool shortcuts require no `Ctrl`/`Cmd`, `Alt`, or `Shift`, and ignore key
  auto-repeat. Other commands accept only the modifier restrictions stated in
  their own definitions.
- Seven creation/selection tools have stable numeric aliases: `1` Select,
  `2` Drawing, `3` Eraser, `4` Text, `5` Line, `6` Arrow, and `7` Shape.
  The mapping never follows a customized toolbar order or visibility. Both the
  top number row and the numeric keypad work; keypad aliases require Num Lock
  so keypad navigation keys are not stolen. Plain `8`, `9`, and `0` are not
  tool shortcuts.
- `Ctrl`/`Cmd+1` and `Ctrl`/`Cmd+0` keep their camera meanings and take
  precedence over the plain numeric tool aliases. Modified `2`-`9` events are
  not consumed as tool shortcuts.
- The renderer's hold-Space pan shortcut is stricter: it does not start while
  an `input`, `textarea`, `button`, `select`, or `contenteditable` element is
  focused.
- Inline text, code, and LaTeX editors keep native text selection and clipboard
  behavior. Their undo/redo is still routed to the board's local-only history.
- Read-only state changes which commands are available; being offline by itself
  does not make the board read-only.
- Toolbar buttons, selects, sliders, text/number inputs, and the in-app color
  picker's focusable controls keep their documented keyboard behavior.
  `Tab`/`Shift+Tab` follows DOM order, focused buttons
  activate with `Enter` or Space, and focused native inputs are not commandeered
  by board shortcuts. The overflow menu, like the board context menu, adds
  explicit Up/Down/Home/End navigation. `Alt+ArrowLeft`/
  `Alt+ArrowRight` on a Drawing preset and `Alt+ArrowUp`/`Alt+ArrowDown` on a
  toolbar-configuration row are documented reordering exceptions; they move
  the focused item rather than selecting another tool.
- Numeric textboxes never expose browser spinner-arrow buttons anywhere in the
  web client. They retain ordinary typing, validation, and documented keyboard
  behavior; this is one global presentation rule for every
  `input[type="number"]`, not a component-specific exception.
- `Ctrl` and `Cmd` are treated as the same board-command modifier. Tool
  shortcuts reject every modifier and key repeat. Command shortcuts generally
  do not reject an additional `Alt` or `Shift`; `Shift` has special meaning
  only where this document says so (`Redo`, object-toggle/area-selection
  behavior, extreme layer movement, 10-unit nudge, straight freehand,
  45-degree rotation snap, and `Shift+F10`).
  `Delete`, `Backspace`, `Escape`, `Home`, and the dedicated context-menu key
  also work with extra modifiers.

## Local view state and initial state

- A newly mounted board starts in Select with no selection or inline editor.
  The world origin is centered at exactly 100% zoom.
- Camera, current tool, selection, editor state, code-run UI, grid visibility,
  toolbar layout, and creation presets/styles are local
  board view/input state. The site theme is application presentation state.
  None of them is board CRDT content or an undo item.
- Site theme, grid visibility, toolbar item order/visibility, ordinary creation
  styles, and the free-drawing palette's
  ordered slots and values persist best-effort on the current device. Camera,
  selection, current tool, the current shape kind, active Drawing
  slot, either palette/toolbar configuration mode, open tool/preset popups, the
  open size panel, and the open context menu do not.
- Replacing the active board document recreates the renderer, returning the
  camera to centered 100%, and clears selection, editor, code output UI, and an
  open context menu. The React surface keeps its current tool, grid choice, and
  free-drawing presets unless it is itself remounted. The application provider
  keeps the site theme across board and route remounts.
- Browser-storage failure never blocks drawing. Site theme falls back to the OS
  preference, the grid defaults hidden, toolbar layout falls back to its
  built-in main/overflow split, and creation palettes/styles fall back to their
  built-in values.

## Toolbars

### Main tools and overflow

Select is permanently visible in the first toolbar position. It is outside the
customizable item list, so it cannot be hidden or moved. A fresh profile shows
Drawing, Eraser, Text, Line, Arrow, and Shape after Select. Code,
LaTeX, and Image start in the overflow menu opened by the ellipsis. A hidden
tool remains fully available in overflow; hiding is placement, not feature
disabling. Code, LaTeX, and Image have no separate toolbar section or divider:
if revealed, each occupies an ordinary ordered tool slot with the same
active/disabled treatment as its peers.

| Tool or group | Shortcut | Pointer behavior | Fresh profile | Read-only |
| --- | --- | --- | --- | --- |
| Select | `V` or `1` | Click, containment/`Shift`-intersection marquee, `Alt` lasso, move, resize, rotate | Fixed first | Available |
| Drawing | `P` or `2` | Freehand stroke; pre-held `Alt` starts its temporary laser mode | Main toolbar | Laser mode only |
| Eraser | `E` or `3` | Preview a pending erase, commit on release | Main toolbar | Disabled |
| Text | `T` or `4` | Open a provisional 240 x 52 text editor; create on first input | Main toolbar | Disabled |
| Line | `L` or `5` | Drag a straight or quadratic curved line | Main toolbar | Disabled |
| Arrow | `A` or `6` | Drag a straight or quadratic curved arrow | Main toolbar | Disabled |
| Shape | `R` or `7` | Drag the Rectangle, Ellipse, Diamond, or Frame/Area selected in the tool settings | Main toolbar | Disabled |
| Code block | none | Select the tool, then click the canvas to place and edit a Python block | Overflow | Disabled |
| LaTeX formula | none | Select the tool, then click the canvas to place and edit LaTeX source | Overflow | Disabled |
| Image | none | Select the tool, then click the canvas to open the file picker for that location | Overflow | Disabled |

### Contextual modifier hints

A faint, compact hint stack sits immediately to the left of the main toolbar.
It is not a static shortcut legend: the renderer reports only held-key actions
that can change the current tool or gesture **at that moment**. Each row shows
the key and a short action label. The stack accepts no pointer input, reserves
no empty placeholder when there are no actions, and is hidden while an object
editor or board context menu owns keyboard input. On narrow surfaces it remains
to the toolbar's left in the same top row and the toolbar keeps horizontal
scrolling. Opening toolbar configuration hides the stack.

| Current renderer state | Visible hints |
| --- | --- |
| Select, no active gesture | `Shift` add to selection; `Ctrl` ignore objects; `Alt` lasso |
| Active rectangular area selection | `Shift` include touched objects; armed `Ctrl` move the area |
| Active lasso selection | Armed `Ctrl` move the area |
| Drawing selected, no active gesture | `Alt` laser |
| Active ordinary Drawing/highlighter stroke | Armed `Ctrl` move the unfinished stroke; `Shift` straight segment |
| Active laser, pan, pinch, placement, shape/connector drawing, resize, or object drag | none |
| Active Eraser gesture | `Alt` restore an object from the pending erase set |
| Active rotation handle gesture | `Shift` snap to 45-degree steps |
| Hand, Eraser while idle, Text, Line, Arrow, Shape, Code, LaTeX, or Image while idle | none |

`Ctrl` labels also describe the equivalent `Cmd` behavior. For selection-area
and unfinished-stroke movement, a command key already down at pointer-down is
not advertised: the movement latch first requires a full `Ctrl`/`Cmd` release,
and only then does the `Ctrl` row appear. Consequently Drawing begins with only
the `Shift` row in that pre-held-command case, changes to `Ctrl` plus `Shift`
after release, and returns to the idle `Alt` row on pointer-up. `Alt` is absent
during an ordinary stroke because it cannot convert that stroke to laser.

The hint stack is renderer/UI-local state. It creates no CRDT update, awareness
payload, command, or undo item. Empty states are intentional and must not be
filled with generic shortcuts such as Space-to-pan.

Shape is one stable tool and one visibility/order unit. Its toolbar button is
an ordinary single-action button with no adjacent arrow, split action, or shape
menu. Activating it keeps the one active-tool identity `shape`; Rectangle,
Ellipse, Diamond, and Frame/Area are selected through the first segmented
control in the active tool's style bar. Rectangle is the initial kind after a
surface remount. The chosen kind remains local for that mount, changes no
existing object, and emits no CRDT update, awareness tool change, or undo item.
If Shape is hidden, overflow contains one ordinary Shape row with the same
`R`/`7` shortcut and no nested shape list.

Visible customizable items retain their relative order from the complete
stored order. Hidden items appear in overflow in that same relative order.
The ellipsis stays present even when there are no hidden tools because it also
contains `Configure toolbar`. Selecting an overflow tool closes the menu and
selects that tool exactly as its main-toolbar button would. The active tool can
be hidden during configuration; it remains active and is then reachable from
overflow rather than being silently changed. Image is disabled in either
location when the host has not supplied durable image insertion, but remains a
configurable registry row so a temporary capability absence does not rewrite
the saved layout.

Drawing normally uses the minimal diagonal Pencil outline rather than a
fountain-pen nib. While Drawing is active and standalone `Alt` is held before a
pointer gesture, the renderer changes that same active button to a minimal
pointer icon and the label `Laser pointer`. The pointer presentation stays
latched throughout the resulting laser stroke even if the modifier is released
first, and returns to Pencil only when the laser gesture/session ends. This is
transient renderer presentation: the active tool remains Drawing, with the same
`P`/`2` shortcut, button, hit target, palette, and advertised active-tool
identity. The toolbar-configuration row always shows Drawing and Pencil rather
than the transient pointer presentation.

Numerically aliased main-toolbar buttons show their fixed digit as a small
noninteractive gray hint just beyond the icon's lower-right footprint. It is
intentionally faint and has no backing, border, shadow, or reserved box; the
centered primary icon is neither shifted nor covered. The Shape button always
shows `7`. Active tools keep the hint gray
instead of promoting it to the active accent color. The indicator is visual
only and does not change the hit target, tooltip, or accessible name; the
owning button includes the fixed digit alongside its letter alias in
`aria-keyshortcuts`. Disabled creation tools keep their indicator in read-only
mode. Overflow rows show the same fixed numeric aliases as compact `kbd`
labels. Reordering, hiding, or revealing an item never renumbers a shortcut.
Code, LaTeX, and Image have no numeric indicator.

The Hand tool is intentionally hidden. Selecting Select while Select is already
active switches to Hand and leaves every visible tool unselected. Selecting
Select again returns to Select. `H` enters Hand directly; `V` from Hand or any
other tool enters Select.

Changing tools cancels an unfinished renderer gesture, closes the preceding undo
capture group, and broadcasts the new active tool through awareness. Drawing
tools remain active after creating an object. Choosing Drawing clears the
current selection so a selected object's style bar cannot mask the pen presets.

### Toolbar configuration

`Configure toolbar` opens a modal dialog over the board. The locked Select row
is shown first with an always-checked disabled visibility box. Every other row
represents exactly one customizable item: Drawing, Eraser, Text, Line, Arrow,
Shape, Code, LaTeX, or Image.

- Each row's checkbox moves that item between the main toolbar and overflow;
  an unchecked item is still available in overflow.
- Dragging a row with native HTML drag-and-drop moves it to the dropped row's
  index. The dragged row receives local preview styling; dropping back at its
  source is a no-op.
- The row's Up/Down buttons move it one position and disable at the respective
  boundary. With the row itself focused, `Alt+ArrowUp` and `Alt+ArrowDown`
  provide the same one-position operation; a boundary attempt is consumed and
  does nothing.
- Order applies to both visible and hidden subsets immediately. Visibility and
  order changes do not select, cancel, or otherwise change the current tool.
- `Reset settings` restores the fresh-profile order and the six-item visible
  set without closing the dialog.
- The close button, `Escape`, or pointer-down outside the dialog closes it and
  restores focus to the overflow trigger. `Tab` and `Shift+Tab` wrap within the
  modal while it is open; the close button receives initial focus.

Toolbar preferences persist immediately and best-effort under
`eduri-board-toolbar-v2` as the strict envelope
`{"version":2,"order":[...],"visible":[...]}`. `order` must contain all nine
customizable items exactly once and `visible` must be a unique subset; unknown,
missing, duplicate, structurally different, wrong-version, malformed, or over
65,536 UTF-16 code units reject the complete envelope and restore defaults.

If no v2 value exists, the adapter may read the former strict
`eduri-board-toolbar-v1` ten-item envelope once. A valid v1 value is migrated in
memory by removing its former `laser` row from both lists while preserving the
relative order and visibility of every remaining item. An existing v2 value,
including a malformed one, always takes precedence and is never replaced from
v1. Reset immediately restores the default order and visible set, then ordinary
persistence writes that default as a valid v2 envelope. An older v1 value may
remain in storage, but it is ignored while the v2 key exists. The setting and
migration are device-local adapter state: they create no CRDT update, awareness
payload, network packet, or undo/redo item. A storage failure keeps the current
in-memory layout usable for that mount.

### Tool menu keyboard and dismissal

Opening the overflow menu focuses its first enabled menu item.
Up/Down cycle enabled items, and Home/End focus the first/last enabled item.
`Escape` or `Tab` closes and restores focus to the owning trigger.
Pointer-down outside also closes and schedules the same focus restoration. The
menu and its open state are adapter UI only, not board content or undo history.

While the overflow menu is open, its toolbar enters the top local chrome layer,
above style, color, and other tool popups. Its entries therefore remain visible
and clickable where those popups overlap; this only changes presentation order.

`highlighter` remains an internal compatibility value for retained/remote
content. There is no visible marker or highlighter tool.

### History and clipboard

- Undo and Redo are always visible. They are disabled when their stack is empty
  and while read-only.
- Paste is visible only while editable.
- Copy appears whenever there is a selection and remains available read-only.
- Cut and Delete appear only for an editable selection.
- Clipboard buttons are disabled while an asynchronous clipboard operation is
  in progress.
- Toolbar Undo/Redo call the history controller directly. Unlike keyboard
  Undo/Redo, they do not explicitly cancel an active renderer interaction or
  end an active nudge/style gesture first.

### View controls

- Minus divides zoom by `1.1`; Plus multiplies it by `1.1`. Both preserve the
  world point at the viewport center and stop exactly at 2% and 2000%.
- The percentage displays rounded whole percent. Pressing it sets exactly 100%
  while preserving the world point at the viewport center.
- The Home button is a state machine, not a click counter. If world origin
  `(0, 0)` is more than 0.5 screen pixels from the viewport center, it first
  centers the origin without changing zoom. If origin is already centered, it
  sets zoom to 100%. Moving the camera resets the next action to centering.
- The Home button first cancels the active renderer interaction and ends an
  active nudge gesture.
- The theme button switches the complete Eduri site between light and dark
  presentation. It controls the same device-local preference as theme buttons
  in other site headers and is not board content.
- The Size button toggles a diagnostic popover. Its close button closes the
  popover; outside click and `Escape` do not currently close it.

## Context menu

### Opening and target selection

- A browser `contextmenu` event over the Konva canvas opens Eduri's menu and
  suppresses the native browser menu. This normally means a mouse right-click
  released within the 2 CSS-pixel pan threshold or a pen barrel/right-click
  action. A right-button drag which crosses that threshold pans instead and
  suppresses its resulting context-menu event. Toolbar DOM and inline textareas
  retain their native context menus.
- The menu works independently of the selected tool and in read-only mode.
  Opening it cancels an unfinished renderer gesture and any object
  drag/resize/rotation, releases owned pointers, clears held nudge keys, and
  closes the current undo capture. An object transform is restored to its
  current durable value rather than being committed.
- Right-clicking a supported mutable object which is already selected preserves
  the complete group selection; every object-menu action then applies to that
  group. Right-clicking another mutable object selects only that object;
  pointer modifiers do not make this selection additive.
- Right-clicking empty canvas clears selection and opens the canvas menu.
  Unknown, newer, or malformed placeholders are treated like canvas rather
  than exposing unsafe mutation commands. Right-clicking Transformer chrome
  targets the first selected object instead of falsely becoming canvas.
- Opening records the invocation's exact world coordinate as the most recent
  board cursor and closes the Size popover. Opening/closing the menu and its
  selection adjustment are local state, not CRDT content or undo items.
  Context-menu Paste and Duplicate freeze this coordinate explicitly, so an
  asynchronous clipboard read or asset check cannot move their anchor.
- The physical context-menu key or `Shift+F10` opens the menu at the viewport
  center. If selection contains a mutable object, its first mutable ID chooses
  the object variant while preserving the group; otherwise it opens the canvas
  variant.
- There is no separate visible touch button and Eduri does not implement its
  own long-press recognizer. A browser-generated touch `contextmenu` may reach
  the same handler, but touch-only access is browser-dependent and is not
  currently promised.

### Canvas menu

Editable canvas:

- Paste, disabled only while another clipboard operation is pending;
- Select all;
- Fit all board content;
- set 100% zoom around viewport center;
- Show grid, as a checked/unchecked item.

Read-only canvas omits Paste and keeps the other four commands.

### Object menu

Editable object/group:

- Cut, Copy, Paste, Duplicate, and destructive Delete;
- one `Порядок слоёв` group which opens a side menu containing Bring to front,
  Forward, Backward, and Send to back in that order;
- Select all.

Cut/Copy/Paste/Duplicate are disabled while clipboard work is pending. Layer
group items remain enabled even when the resulting core command will be a
no-op. Merely opening or closing the group is local UI state and does not emit
a document update or create an undo item.
There is no Edit command in this menu; editing still uses double-click/tap or
`Enter`. Every mutation uses the same guarded core path and one-item undo
semantics as its keyboard counterpart. Layer ordering is intentionally
available here and through its keyboard shortcuts, not in the style bar.

Read-only object/group contains only Copy and Select all. The complete layer
group and all other mutation commands are omitted rather than shown disabled.

### Layer side menu

- Hovering `Порядок слоёв` with a mouse or pen opens its side menu without
  moving keyboard focus. Pressing/clicking the row opens the same menu and
  focuses its first enabled command, so touch and pen users do not depend on
  hover. The group row itself never performs a layer command.
- Moving from the parent panel to the side panel is protected by a 180 ms close
  delay. Entering either panel cancels the pending close, so crossing the small
  inter-panel gap does not make the popup flicker. Entering another ordinary
  row in the parent starts the same delay rather than closing immediately; this
  lets a diagonal path reach a lower side-menu command even if it briefly
  crosses that row. Remaining over the parent row closes the side menu when the
  delay expires.
- The side menu is a sibling panel rather than a child of the scrollable parent
  panel. It is therefore not clipped by the parent's overflow and its items do
  not enter the parent's keyboard-navigation cycle. Pointer-down in either
  panel counts as inside the same context menu. The parent keeps its compact
  246 CSS-pixel width; the side panel may use up to 272 CSS pixels so its
  longest command and shortcut remain readable. Both widths shrink to the
  board's 8 CSS-pixel side margins on a narrow surface.
- Placement first tries 4 CSS pixels to the right of the parent. If that would
  cross the board's 8 CSS-pixel edge margin, it opens to the left. Its first row
  aligns with the group row, then vertical position is clamped to the same
  margin. On a viewport too narrow for two complete panels, the side with more
  room is chosen and the side menu is clamped inside the board, which may make
  it overlap the parent. Each panel keeps its own bounded vertical scrolling.
- Side placement is recalculated when the board or either panel resizes, when
  the window resizes, and when the parent menu scrolls. Camera movement by
  itself does not reposition either panel.

### Menu keyboard, focus, and closing

- The menu is an ARIA menu. Its first enabled item receives focus.
- Up/Down cycle through enabled items. `Home` and `End` focus the first/last
  enabled item in the current panel only. Native button `Enter` or Space
  activates an ordinary focused item. On `Порядок слоёв`, either key opens the
  side menu and focuses its first command.
- `ArrowRight` on `Порядок слоёв` opens the side menu and focuses its first
  enabled command. `ArrowLeft` inside the side menu closes only that panel and
  returns focus to `Порядок слоёв`. `ArrowLeft` on the parent while the side
  menu is open closes the side menu without moving the current parent focus.
  Moving parent focus away from the group with Up/Down/Home/End also closes the
  side menu.
- If the 180 ms pointer-leave timer closes a side menu whose command currently
  has keyboard focus, focus returns to `Порядок слоёв`. The still-open parent
  menu therefore never loses its active keyboard item merely because the
  pointer left both panels.
- `Escape` or `Tab` closes the menu, prevents the native key action, and returns
  focus to the board. This closes both panels even when focus is in the side
  menu. `Tab` therefore does not move to the control following the menu.
- Choosing an item first closes the menu and returns board focus, then invokes
  the command. Pointer-down outside closes it without forcing focus, after
  which that same pointer event continues to its actual target. Another
  right-click replaces the menu at the new target.
- While menu focus is active, global board keyboard and clipboard handlers are
  intentionally bypassed. The visible `Ctrl+...` strings are reference labels,
  not live shortcuts inside the open menu; ordinary closed-board shortcuts
  also accept `Cmd`, although labels currently always say `Ctrl`.
- An object menu closes if its target leaves selection, including after remote
  deletion. Any menu closes when the board document changes or the client
  enters read-only. A new context-menu request replaces both panels and starts
  with no side menu open. Board/window resize clamps it again; wheel/camera
  movement alone does not close it. Closing with `Escape` preserves object
  selection and does not change the current tool.
- The menu stays at least 8 px inside the board, is at most 246 px wide and
  board-size minus 16 px tall, and scrolls internally if necessary. Coarse
  pointer media increases each row to at least 42 px.

## Grid

- The grid is hidden by default. The canvas-menu checkbox changes a
  best-effort browser-profile preference shared by boards on that origin.
  Exactly the stored string `true` under `eduri-board-grid-visible` starts it
  visible; missing, invalid, or inaccessible storage keeps it hidden.
- Grid visibility is local presentation state: it is not CRDT or manifest/page
  content, does not synchronize through awareness, and creates no undo item.
  The document schema reserves shared page grid settings for future work, but
  this control does not read or write them.
- Hiding the grid removes only its lines; the light/dark canvas background is
  still painted. The option works read-only and does not rebuild the renderer.
  It is visual only: there is currently no snapping to grid.
- At zoom below 30%, minor lines use 100 logical units and major lines 500.
  At 30% and above they use 20 and 100 logical units. Minor lines are skipped
  when projected spacing is below 8 screen pixels; major lines are skipped
  below 20 screen pixels. Lines remain anchored to world origin while panning.

## Pointer input

### Buttons and ownership

- Primary mouse button, pen contact, or one touch pointer uses the current tool.
- Middle-button drag always pans.
- Right-button pointer-down on the Konva canvas starts a click-or-pan candidate,
  independently of the selected tool and read-only state. Movement below 2 CSS
  pixels leaves the camera unchanged and the eventual release opens the board
  context menu described above. Crossing the threshold activates pan from the
  original down point, switches the cursor to `grabbing`, and suppresses the
  context menu belonging to that drag. A later right-click opens the menu
  normally. Button 2 never begins the selected tool. The browser menu remains
  available everywhere outside the drawing canvas, including editors and
  controls.
- Hand plus primary drag pans.
- Holding Space before primary pointer-down starts a temporary pan. Pressing
  Space after any gesture has already started changes only cursor feedback and
  does not convert that gesture to a pan; active freehand has its own
  `Ctrl`/`Cmd` behavior below.
- Cursor feedback is `default` for Select, text caret for Text, cell for Eraser,
  crosshair for Drawing (including its temporary laser mode) and placement
  tools, `grab` for idle Hand/Space, and `grabbing` for an active pan, freehand
  `Ctrl`/`Cmd` stroke move, or selection-area `Ctrl`/`Cmd` move.
- A gesture belongs to the pointer ID that started it. Movement and release from
  unrelated pointer IDs do not update or finish it.
- Pointer capture is best-effort. Capture loss cancels an unfinished gesture.
- Mouse gestures also listen to window-level compatibility `mousemove` and
  `mouseup`. This supports OS button injection and drivers that begin with
  Pointer Events but deliver movement through legacy mouse events.
- A compatibility mouse event at the same screen coordinate as the preceding
  pointer event is deduplicated. Coalesced pointer samples are used when
  available; missing, throwing, or empty `getCoalescedEvents()` falls back to
  the current event.
- A compatibility `mousemove` that reports the active mouse button is no longer
  down finishes the gesture normally at that position. An unrelated-button
  `mouseup` does not finish it.
- Screen coordinates account for CSS scaling between the canvas client size and
  its bounding rectangle.
- Leaving the canvas clears cursor awareness but does not cancel an owned,
  captured gesture.
- Canvas uses `touch-action: none`, so native page pan/zoom is disabled over the
  drawing surface. Toolbars retain their own horizontal touch scrolling.
- A canvas context request corrects its screen coordinate for CSS scaling and
  computes the corresponding logical world point before canceling the
  preceding interaction.

### Touch and pinch

- One finger uses the selected tool, including drawing and selection.
- A second active touch switches to pinch zoom. The unfinished one-finger
  gesture, object drag, resize, or rotation is canceled rather than committed;
  renderer nodes return to the current durable object transforms.
- Pinch preserves the world point under the initial two-finger center while
  applying both center translation and distance-based zoom.
- Finishing a pinch does not resume the canceled one-finger gesture.
- Pinch uses the first two active touch IDs. A third touch is tracked and
  captured but does not change the pair; releasing it only removes that ID.
- Parallel touch pointers do not steal an active mouse or stylus gesture whose
  pointer ID is not one of those touches.
- Double-tap on an editable text, code, or LaTeX object opens its editor
  regardless of the selected tool, provided the board is editable.

### Wheel and touchpad

- Wheel/trackpad movement without `Ctrl`/`Cmd` pans by `deltaX` and `deltaY`.
  Pan uses those raw browser deltas; line/page delta modes are not rescaled.
- `Ctrl`/`Cmd` plus wheel, including browser touchpad pinch events represented
  this way, zooms exponentially around the current pointer position.
- For zoom, pixel delta is used directly, line delta is multiplied by 16, and
  page delta by viewport height. The result is clamped to -100..100 and applies
  factor `exp(-delta * 0.001)`.
- Wheel events are consumed but do not move or zoom the camera while a pointer
  gesture, object drag, or resize/rotate transform is active. This prevents a
  wheel or touchpad event from changing coordinates midway through a stroke.
  Ordinary wheel control resumes after the pointer interaction ends.
- Every zoom path is clamped to 2%-2000%, including toolbar/keyboard steps,
  wheel or touchpad zoom, touch pinch, direct camera changes, and Fit content.
  Reaching a limit preserves the world point under the corresponding viewport
  anchor instead of shifting the board.

### Cancellation

An unfinished drawing, shape, placement click, marquee, lasso, temporary laser
session, or erase gesture is discarded on pointer cancel, owned
pointer-capture loss, board destruction, browser-window blur, or when the
document becomes hidden. Tool changes and read-only transitions also cancel it.
A two-touch pinch takeover cancels the preceding one-touch gesture. Opening the
board context menu invokes the same cancellation and also rolls back an
in-progress object drag/transform.

Cancellation destroys local previews, clears ephemeral gesture awareness, and
does not create a durable object. For the eraser it also restores every locally
faded object. `Escape` explicitly invokes the same cancellation path.

## Drawing

### Normal stroke

- Pointer-down snapshots the selected pen style. Changing a preset while the
  pointer is down cannot restyle the active stroke.
- Pointer samples at least 0.5 screen pixels from the preceding stored point are
  appended immediately to the local preview. Stylus pressure is stored when
  available; mouse and non-pressure input use `0.5`.
- Pressure is retained in stroke data, but the current renderer uses the
  selected constant width rather than pressure-varying width. Tilt, twist,
  azimuth, and stylus barrel-eraser modes are not used.
- The local preview and final draft use the complete 0.5-screen-pixel sampled
  geometry. The awareness stream uses a separate 1.5-screen-pixel live sample
  spacing with the same stroke color, width, and opacity, reducing network and
  remote-render work without changing the committed stroke.
- One live awareness packet carries a rolling tail of at most 256 points, plus
  a stable stream ID, its absolute point offset, and the current whole-stroke
  translation. Successive tails overlap. A peer merges only the new suffix into
  the existing Konva line and updates that node in place, so the remote preview
  continues beyond 256 points and does not blink or rebuild on every packet.
  An out-of-order duplicate is ignored; overlap normally repairs a skipped
  packet, while a genuine gap restarts at the next window without drawing a
  false bridge. Remote preview accumulation uses a 131,072-point emergency
  compaction guard. This does not cap or simplify the final durable stroke.
- The visible remote pen/highlighter head interpolates from its currently
  rendered point to each newly received endpoint over 56 ms with cubic
  ease-out. A newer packet retargets from the in-flight visible point instead
  of snapping or waiting. RAF updates mutate only the final coordinate pair of
  a renderer-owned Konva array; accumulated stream geometry and awareness
  offsets remain authoritative and are not rebuilt per animation frame.
- Pointer-up commits the complete stroke as one object and one undo item.
  Freehand creation intentionally leaves it unselected.
- Completion uses a two-way preview-to-object handoff rather than clearing the
  remote preview on pointer-up. The final awareness window names the committed
  object, while the durable stroke records its source gesture stream. If
  awareness arrives first, the peer retains the preview until that object is in
  its local Y.Doc. If the CRDT update arrives first, the source stream removes
  the preview immediately. The two canvas layers therefore never expose a
  blank or doubled transition solely because the channels arrived in a
  different order. The retained final awareness value is bounded to one
  preview per participant and is replaced by their next gesture.
- A click with fewer than two stored points creates no object.

### Temporary laser mode: `Alt` before a stroke

- Drawing has no separate Laser tool or shortcut. If standalone `Alt` is
  already held when Drawing receives primary pointer-down, that gesture starts
  an ephemeral laser stroke. Modifier order is decisive: this rule is only for
  `Alt` first, pointer-down second. `AltGraph` is not standalone `Alt` and never
  starts laser.
- The laser choice is latched at pointer-down. Releasing `Alt` while the
  pointer remains down does not convert the gesture into durable drawing; the
  same laser stroke continues until pointer-up. Conversely, pressing `Alt`
  after an ordinary Drawing pointer-down never converts that stroke to laser.
  `Ctrl`/`Cmd` is independent and retains the unfinished-stroke movement mode
  in the next section.
- Every laser stroke snapshots the active Drawing preset at its own
  pointer-down. Its color, logical line width, and opacity match that slot;
  changing a preset can affect a later stroke in the same retained session but
  never restyles an earlier one. The glow uses the stroke color and a
  screen-constant blur, while line width remains the selected logical width.
- Samples are accepted after at least 2 screen pixels of movement. Each stroke
  is a separate path, so releasing and pressing the pointer again never draws a
  bridge between them.
- Pointer-up while `Alt` remains held retains every local stroke in the
  session. Further primary gestures append separate paths, and no older local
  path disappears before release. Local point and flattened-preview buffers are
  appended incrementally. Only an abnormal one-million-point uninterrupted
  laser path triggers progressive emergency compaction.
- Awareness carries rolling tails from at most the newest 16 strokes and 160
  aggregate points. Stable session/stroke IDs and per-tail absolute offsets let
  peers merge new suffixes into retained paths, including paths omitted from a
  later newest-16 packet. The peer reuses each Konva line and updates geometry
  only when points actually change. A remote session has hostile-input guards
  of 1,024 accumulated strokes and 131,072 accumulated preview points, after
  which old strokes or geometry are progressively compacted. These packet and
  receiver guards never shorten a normal local laser session.
- Each visible remote laser-stroke head uses the same 56 ms RAF interpolation
  and in-flight retargeting as freehand awareness. Separate retained strokes
  animate independently. New session IDs still replace the old group
  immediately, and a real offset gap bypasses interpolation so no false bridge
  is animated.
- Releasing `Alt` after pointer-up clears awareness and
  fades every retained stroke together over 300 ms. If the modifier is released
  during an active laser stroke, release is remembered: that stroke remains
  visible and drawable through pointer-up, then the complete session fades.
  Re-pressing `Alt` before that pointer-up does not cancel the remembered
  release or start a durable stroke.
- A new laser `sessionId` replaces the previous remote Konva group as one
  reconciliation operation before browser paint. Lines from a fading or
  completed session are never positionally reused by the new session, so its
  first one-point packet cannot briefly expose geometry from the prior laser.
- The awareness clear carries `laserClearMode=fade` for that normal release.
  Explicit cancellation instead carries `laserClearMode=immediate`, so peers
  do not leave a 300 ms ghost after a cancelled gesture. Older senders without
  this field retain the compatible normal-fade behavior.
- While Drawing is selected, the toolbar's Pencil presentation becomes its
  minimal pointer presentation whenever a pre-gesture `Alt` hold can start
  laser, and remains so for an active or retained laser session. Drawing stays
  the actual active tool and awareness identity throughout. This pre-gesture
  presentation also works when focus remains on a board toolbar or palette
  button after a click; focused text-entry controls suppress it until editing
  focus leaves the field.
- A laser session is awareness-only. It creates no CRDT object, durable update,
  selection, command, or undo/redo item, and receiving it never mutates board
  content. Read-only users may select Drawing and use only this pre-held
  modifier mode; an ordinary read-only Drawing gesture creates nothing.
- Explicit cancellation is immediate rather than faded. `Escape`, pointer
  cancel, capture loss, pinch takeover, context-menu opening, tool or read-only
  transition, window blur, hidden-document transition, board replacement, and
  renderer destruction remove the active and retained session, clear its
  awareness, and tell peers to remove it immediately. Legacy window
  `mousemove`/`mouseup` injection follows the same
  update, finish, retention, and cancellation rules as Pointer Events.

### `Ctrl`/`Cmd` moves an ordinary unfinished stroke

- While the primary pointer or pen remains down, holding `Ctrl` or `Cmd`
  temporarily changes movement from drawing to dragging the complete current,
  unfinished stroke. The board camera does not move.
- `Ctrl`/`Cmd` already held at pointer-down is ignored for movement and the
  initial hold draws an ordinary freehand stroke. Movement remains disarmed
  until both `Ctrl` and `Cmd` have been released; pressing either one again
  during the same pointer gesture then starts dragging the unfinished stroke.
  A gesture which began without either modifier can enter movement on its first
  later `Ctrl`/`Cmd` press as usual.
- No new stroke point is added while dragging. Every already sampled point,
  including a provisional straight endpoint, moves by the same logical delta,
  and the bounded live awareness preview moves with it.
- Pointer movement is measured in screen pixels and divided by current zoom.
  The moved final stroke point therefore remains under the pointer; releasing
  the modifier continues the same stroke from that point without a connecting
  jump.
- Pressing or releasing an armed `Ctrl`/`Cmd` movement phase immediately changes
  the local cursor between crosshair and grabbing. The ignored pre-held phase
  keeps the crosshair. Geometry changes on the next pointer or compatibility-
  mouse event.
- Pointer-up while `Ctrl`/`Cmd` is held applies the final movement delta and
  commits the translated stroke. The release coordinate is not added as a new
  drawing sample.
- `Ctrl`/`Cmd` takes priority if `Shift` is held at the same time.

### `Shift` during a stroke

- Holding `Shift` creates a straight segment from the last committed freehand
  point to the current pointer.
- The segment has one provisional endpoint. Further movement while `Shift`
  remains held replaces that endpoint instead of appending intermediate points.
- Releasing `Shift` leaves the current endpoint committed and resumes ordinary
  freehand sampling in the same object.
- `Shift` can be entered and left repeatedly during one stroke. Each entry uses
  the latest committed point as its new anchor.
- Pointer-up while `Shift` is held commits the current straight endpoint.
- Moving a provisional endpoint back to its anchor removes that endpoint.
  An unmoved `Shift` click therefore does not create a tiny stroke.
- The modifier state of the current native pointer/mouse event governs its
  coalesced sample batch. This avoids relying on missing modifier properties in
  synthetic coalesced samples.

The whole freehand/straight/move/freehand sequence remains one local gesture,
one durable stroke, and one undo item. Canceling it discards all portions.

## Selection, movement, and transforms

### What can be selected

Only supported, mutable object versions can be selected, styled, transformed,
or erased. Unknown, newer, or malformed plugin objects remain durable and render
as safe placeholders, but Select, `Ctrl`/`Cmd+A`, and deletion do not target
them. Plain-clicking such a placeholder clears the current selection; a
`Shift`-click leaves the selection unchanged. `Ctrl`/`Cmd` or `Alt` at
pointer-down ignores the placeholder hit and starts the selection-area gesture
described below.

### Click, marquee, and lasso

- Plain click on an unselected mutable object selects only it.
- Plain click on an already selected object preserves the current group so it
  can be dragged together.
- `Shift`-click toggles that one object in the selection. `Ctrl`/`Cmd` is not an
  object-toggle modifier.
- Dragging empty space creates a rectangular marquee. An object matches only
  when its complete rendered hit geometry is inside the rectangle, with
  equality at the boundary accepted. A partial touch is not enough. This
  includes visible stroke width, an arrow head, rotation, and the label above a
  Frame/Area; matching does not depend on viewport materialization.
- While `Shift` is currently held during an active rectangular marquee, its
  geometry predicate changes to inclusive any-intersection. An object then
  matches when any part of its exact rendered hit geometry touches the
  rectangle boundary or interior, when it lies inside the rectangle, or when a
  closed shape's selectable interior contains the rectangle. Visible stroke
  width, curved paths, arrow heads, rotation, and the Frame/Area label all
  participate; a broad-phase bounds overlap alone is not a match.
- The marquee geometry modifier is live rather than latched. Board-scoped
  `Shift` keydown/keyup updates candidate membership even while the pointer is
  stationary, and every owned pointer or compatibility-mouse event reconciles
  the current modifier state. Pressing `Shift` switches the live preview to
  any-intersection; releasing it switches back to complete containment. The
  final pointer-up uses the current state through the same predicate, so the
  committed result agrees with the latest preview.
- Holding standalone `Alt` at pointer-down creates a freeform lasso instead of
  a rectangle and ignores any object or Transformer hit under the pointer.
  Releasing `Alt` after pointer-down does not change that gesture back to a
  rectangle. `AltGraph` is not a lasso modifier.
- The lasso is implicitly closed from its final point to its first point and
  uses the inclusive even-odd fill rule in both its visible preview and hit
  test. An object matches if any part of its rendered hit geometry touches the
  lasso boundary or filled region, if the object lies completely inside the
  lasso, or if a closed shape's selectable interior completely contains the
  lasso. Rectangle, ellipse, diamond, and Frame/Area interiors count for this
  object-level selection rule even when their visual fill is transparent.
- Lasso samples are kept when they are at least 1.5 screen pixels apart.
  The local contour is bounded at 2,048 points. Reaching that bound applies an
  iterative error-bounded simplification which keeps the first/latest samples
  and high-deviation corners, then doubles the subsequent screen-distance
  threshold. The tolerance increases only as needed to return below the bounded
  target; this continues the gesture instead of freezing it and bounds
  release-time work.
- `Shift` is also the only additive area-selection modifier, but this part is
  captured independently at pointer-down. If `Shift` was held when a marquee
  or `Shift+Alt` lasso began, every preview and the final result unions matches
  with the complete selection captured at pointer-down and never toggles an
  already selected match off. That additive flag remains set even if `Shift`
  is released later. If the gesture began without `Shift`, pressing it later
  changes only a rectangular marquee's geometry predicate and does not make
  the gesture additive. Lasso is always inclusive any-intersection, so changing
  `Shift` after lasso pointer-down does not change its geometry or additive
  mode.
- `Ctrl`/`Cmd` already held at pointer-down ignores every object and Transformer
  hit and starts a rectangular marquee as if the pointer were over empty
  canvas. Its geometry still follows the current live `Shift` state. It is a
  replace gesture unless the additive flag was set by `Shift` at pointer-down.
  Initial `Alt` still chooses lasso if both `Alt` and `Ctrl`/`Cmd` are held.
- That initial `Ctrl`/`Cmd` is latched as a hit-bypass, not as area movement.
  The rectangle or lasso continues to be drawn normally for as long as the
  initially held command modifier remains down. The user must release both
  `Ctrl` and `Cmd`, then press either one again during the same pointer gesture,
  before movement can start. Each new pointer-down creates a new latch, so two
  consecutive gestures both work while the user keeps `Ctrl` held between
  them.
- Once armed inside an active marquee or lasso, holding `Ctrl`/`Cmd` freezes
  shape construction and moves the complete unfinished area. Screen movement
  is divided by zoom, the camera never moves, and cursor feedback is
  `grabbing`. Releasing the modifier resumes construction from the translated
  endpoint without a connecting jump. Repeated move/draw phases accumulate,
  and pointer-up while moving applies the final pointer delta.
- Rectangle and lasso previews are renderer-local dashed, translucent shapes.
  Their stroke/dash stay constant in screen pixels. While either gesture is
  active, candidate membership is recomputed at most once per display frame
  from its latest geometry and current marquee modifier. Marquee preview uses
  complete containment without `Shift` and inclusive any-intersection while
  `Shift` is held; lasso preview always uses inclusive any-intersection. Release
  uses the same corresponding predicate.
- An additive preview unions current matches with the complete selection
  captured at pointer-down, exactly like the final result, based on the
  pointer-down additive flag rather than the later modifier state. Translating
  the unfinished area with the armed `Ctrl`/`Cmd` mode or changing the live
  marquee `Shift` state schedules the same recomputation, so candidate outlines
  follow the current rectangle/lasso and predicate rather than waiting for
  release.
- The candidate set is renderer-local preview state. It does not replace the
  committed selection, call `onSelectionChange`, publish awareness, write the
  CRDT, or create an undo item. Pointer-up synchronously recomputes against the
  latest scene, commits the resulting IDs once, and only then exposes them
  through the ordinary bounded selection-awareness path.
- During the gesture, ordinary committed Transformer/selection chrome is
  suppressed. The dashed translucent rectangle/lasso remains the aggregate
  gesture area, and each currently materialized candidate receives its own
  noninteractive solid outline plus a light theme-aware accent wash. The wash
  appears and disappears with the display-paced candidate membership while the
  lasso is still being drawn, making entry into and exit from the current
  implicit closed region visible before pointer-up. Above 512 materialized
  candidates, individual previews are omitted and bounded aggregate-only
  candidate chrome is used; this visual budget never truncates the candidate
  IDs used at pointer-up.
- Scene replacement, object add/change/delete, and zoom changes invalidate live
  membership and schedule a display-paced reread. Cancellation destroys the
  candidate chrome and restores the prior committed selection and its ordinary
  chrome without emitting a selection callback or awareness update.
- Area construction, translation, cancellation, and final selection create no
  board object, CRDT update, or undo item.
- While a marquee or lasso is active, selected object dragging and Transformer
  handles are noninteractive. Finish or cancellation restores them from the
  current selection; compatibility mouse/touch events cannot start a competing
  drag or resize.
- A rectangular extent or lasso bounds shorter than 3 screen pixels is treated
  as an empty click. A lasso also needs at least three non-collinear points.
  Translating an otherwise tiny gesture does not make it non-empty. Plain empty
  click clears selection; an empty area gesture whose additive flag was set at
  pointer-down keeps the captured base selection.
- `Ctrl`/`Cmd+A` selects every mutable object in canonical z-order.

The complete selection remains local. Awareness sends at most its first 256
IDs, so very large local selections remain operable without an oversized
presence frame.

### Selection chrome

- Outside an active marquee/lasso, a normal editable multi-selection keeps a
  dashed common Transformer frame and handles around the group while also
  drawing a solid outline around every selected object whose renderer node is
  currently materialized. The solid individual outlines make the exact
  membership visible even when nearby unselected objects lie inside the common
  bounds. Active area-selection candidate chrome follows the separate
  renderer-local rules above and never exposes transform handles.
- Individual outlines are noninteractive and follow live group drag, resize,
  and rotation before the durable transform commits. The common dash pattern
  and every outline stroke stay constant in screen pixels across zoom levels
  and use the current light or dark theme accent.
- Transformer chrome uses fixed screen-space metrics throughout the complete
  2%-2000% zoom range. Every resize anchor and the rotation anchor has the same
  9 x 9 CSS-pixel body with a 1.5 CSS-pixel stroke; their pointer targets also
  remain screen-constant, with Konva's additional 10-pixel touch hit stroke on
  touch-capable clients. The common-frame stroke is 1.5 CSS pixels, padding is
  4 CSS pixels, the configured rotation-anchor offset is 50 CSS pixels, and a
  multi-selection common frame uses a `[7, 5]` CSS-pixel dash.
  These values must not be divided by board zoom: Konva Transformer already
  treats its absolute transform as screen space. Ordinary world-space
  selection-outline nodes still use inverse-zoom dimensions to produce their
  separately documented constant screen weight.
- Viewport culling remains authoritative: an offscreen selected object is not
  materialized merely to draw its individual outline. A partly offscreen
  selection therefore combines solid outlines for visible members with the
  bounded dashed aggregate selection frame.
- At most 512 materialized selected objects receive individual outlines. Above
  that renderer budget, only the aggregate selection chrome is shown; the
  complete selection and every command still include all selected IDs.
- Local selection outlines are presentation state only. They are not written
  to the CRDT, sent through awareness, or recorded in undo history.

### Move, resize, and rotate

- Object drag/resize/rotate is enabled only in Select and while editable.
- Dragging one selected object moves the complete supported selection by the
  same logical delta, including selected objects outside the viewport.
- One drag commits all transforms atomically and is one undo item.
- Resize and rotation handles are enabled when no more than 256 objects are
  selected and every selected renderer node is currently visible.
- Rotation is smooth by default. Holding `Shift` before or during a rotation-
  handle drag constrains the live angle to 45-degree increments. The modifier
  is read from every pointer or compatibility-mouse movement: pressing `Shift`
  engages snapping on the next movement, and releasing it restores smooth
  pointer-derived rotation on the next movement. A modifier change without
  movement does not by itself recalculate the shown angle.
- Pressing or releasing `Shift` neither ends nor restarts the transform.
  Pointer-up commits the angle currently shown through the ordinary atomic
  transform command, so any number of snap/free transitions in one drag still
  creates exactly one local undo item.
- Changing camera zoom before a transform does not enlarge, shrink, or move the
  handles relative to the selection beyond the fixed screen-space padding and
  rotation offset documented above. Transformer chrome and its hit geometry are
  renderer-local presentation/input state; showing or refreshing them does not
  change selection, awareness, board content, or undo history. Only the normal
  completed object transform enters the durable command path.
- Large or partly offscreen selections receive bounded selection chrome instead
  of partial transform handles. Commands and group drag still use the complete
  selection.
- Flipping is disabled. Resizing cannot reduce a dimension below 4 logical
  units.
- Remote removal of a selected object removes it from local selection without
  disturbing the remaining selected IDs.

### Keyboard movement and layers

- Arrow keys move selection by 1 logical unit.
- `Shift` plus an arrow moves by 10 logical units.
- `Ctrl`/`Cmd` or `Alt` blocks arrow nudging.
- Held/repeated arrow keys form one undo item until every active arrow key is
  released. Window blur also closes the nudge group.
- Layer actions are Bring to front, Forward one unselected neighbor, Backward
  one unselected neighbor, and Send to back.
- Multi-selection relative order is preserved. Selected runs cross at most one
  unselected neighbor for Forward/Backward.
- A no-op layer command creates no undo item.

### Edit and delete

- Double-click/double-tap an editable text, code, or LaTeX object to edit it.
- `Enter` edits exactly one selected text, code, or LaTeX object, or enters
  point editing for exactly one selected Line.
- In Line/Arrow point editing, `Delete` or `Backspace` targets only the selected
  anchor as documented above. Otherwise it atomically deletes every existing
  selected mutable object and clears selection. Additional modifiers do not
  suppress deletion.

## Shapes, text, frame, and placement tools

- Text pointer-up opens a local provisional 240 x 52 editor at the pointer-down
  world point. The provisional editor is not yet a board object and is not
  advertised to other participants.
- The first textarea value containing a non-whitespace character synchronously
  creates the `eduri/text` object with the complete, untrimmed current value,
  selects it, and attaches the normal collaborative `Y.Text` binding without
  replacing or defocusing the textarea. Leading/trailing whitespace and line
  breaks are preserved, but whitespace-only input remains provisional.
- Interim IME composition remains in the provisional textarea and promotion
  occurs on `compositionend`, avoiding a binding change during active native
  composition. The editor tracks the interval from `compositionstart` through
  `compositionend`, including environments whose interim input event omits
  `isComposing`. While native composition is active, `Enter` and `Escape`
  remain available to the IME and do not close the editor (including legacy key
  code `229` events).
- Closing a still-empty provisional editor through `Escape`, unmodified
  `Enter`, blur, read-only transition, document replacement, or surface unmount
  discards it. It creates no CRDT update, awareness selection, or undo item.
- `Escape` from a text editor also restores keyboard focus to the board. If the
  provisional text was promoted or an existing text object was being edited,
  the same keypress clears its local selection; plain numeric tool shortcuts
  are therefore available on the immediately following keypress.
- After promotion, the text object follows ordinary collaborative behavior. It
  is not automatically deleted if a later edit makes it empty, because deleting
  a map entry could discard a concurrent remote insertion into its `Y.Text`.
- Rectangle, ellipse, diamond, and frame drags normalize in every direction to
  positive bounds.
- `Shift`, `Ctrl`, and `Cmd` do not constrain or modify line, arrow, rectangle,
  ellipse, diamond, or frame creation. The `Ctrl`/`Cmd` mid-gesture move modes
  described above belong only to active Drawing and selection-area gestures;
  they do not apply to these creation gestures.
- A dragged shape is discarded only when both width and height are below 3
  logical units.
- Line and arrow preserve the actual start/end direction relative to their
  normalized bounds.
- Line and Arrow both create a straight ordered three-anchor smooth path. The
  two endpoints and initial midpoint use the same durable point geometry and
  point-editing lifecycle; Arrow differs only by rendering an end arrowhead.
- Line/Arrow bounds, rendering, live awareness preview, marquee/lasso
  selection, and swept eraser collision all follow the point path. Old straight
  and quadratic objects remain readable and convert on their first point edit.
- Frame text is the fixed label `Область`; there is no frame-label editor.
- A created non-stroke object is selected. Code and LaTeX enter editing
  immediately; provisional Text becomes selected when its first input creates
  the object.
- Every creation receives a fresh ID, object version 1, and a top z-rank. It is
  one add command and one undo item.
### Code, LaTeX, and Image placement

Code, LaTeX, and Image are ordinary selectable tools. Pressing their toolbar or
overflow entry only changes the active tool and awareness; it never creates an
object or opens the image picker by itself.

- Primary pointer-down on the board captures the exact world point and starting
  screen point. Pointer-up accepts that captured world point only if maximum
  movement stayed at or below 8 CSS pixels; the UI then snapshots the current
  document, access epoch, local history epoch, camera, and viewport. A larger
  drag creates nothing. The tool remains selected in either case.
- Pointer cancel/capture loss, tool cancellation, read-only transition, window
  blur, hidden document, destruction, context-menu opening, or two-touch pinch
  takeover discards the pending placement without a CRDT update or undo item.
- Code creates a 360 x 240 Python/browser block centered at the captured point;
  LaTeX creates a 260 x 110 formula initialized with `\frac{a}{b}` there. Each
  is downscaled, but never upscaled, when needed for the captured viewport.
  The new object becomes the sole selection and its inline editor opens
  immediately. Code/LaTeX remains the active tool for another placement.
- Image pointer-up synchronously opens the native file picker so browser user
  activation is retained. Canceling the picker clears the captured target and
  changes nothing. A selected file is validated and durably persisted before
  its CRDT object is created; its object is centered at the frozen click and
  downscaled as documented below. The image becomes the sole selection, and
  insertion itself never changes the tool; Image therefore remains active for
  another placement unless the user selected something else independently.
- Camera/cursor movement after the accepted click opens the picker cannot
  retarget asynchronous image insertion. Document/access replacement, local
  Undo/Redo, read-only state, or unmount before commit invalidates the frozen
  operation; no object, stale selection, error, or undo item is committed to
  another history state.

Code, LaTeX, and Image placement is therefore distinct from clipboard Paste.
An external clipboard image still uses the paste anchor and directly activates
Select after successful insertion, whereas a successful Image-tool insertion
does not force a tool change.

## Eraser

- The eraser does not delete on contact. While the primary pointer is held,
  intersected mutable objects are added to a local pending set and shown at 24%
  of their current base opacity.
- Pointer-down performs an immediate zero-length hit test, so an object under a
  stationary eraser can be marked without prior movement.
- The original object opacity is never overwritten. Remote style changes during
  the gesture become the new base for the local faded preview.
- Holding `Alt` switches to restore mode. Crossing an already pending object
  removes it from the pending set and immediately restores its normal opacity.
  Crossing an unmarked object with `Alt` does nothing.
- Releasing `Alt` returns to mark mode, so a restored object can be marked again
  later in the same gesture.
- A stationary pointer-up does not repeat the hit test. If the final screen
  coordinate changed since the last sample, that last sweep uses the `Alt` state
  carried by the release event.
- Pointer-up validates the remaining IDs and deletes them in one atomic command
  and one undo item.
- A gray, translucent trail follows the eraser in renderer-local screen space
  and never changes with board zoom. Its old-end speed depends only on the
  current trail length, so a longer trail catches up faster. Source samples and
  render stations remain strictly bounded; collision still processes every
  delivered sweep independently of this visual history.
- The trail is one continuous filled screen-space silhouette at a uniform 20%
  opacity. Its centerline prefers 1 CSS-pixel path-length stations up to the
  fixed render-station budget. Circular cross-sections plus filled connectors
  between adjacent stations keep longer spans continuous and give the
  silhouette rounded bends and round ends, including on sharp pointer turns.
  The silhouette receives one fill, so its construction geometry cannot
  accumulate alpha or expose darker seams.
- The silhouette radius varies continuously along its length. Its newest full
  diameter is about 15 CSS pixels at low smoothed pointer speed and contracts
  continuously toward a 9 CSS-pixel minimum at high speed. Every station uses
  its own smoothed local speed, so a fast section stays thinner after the
  pointer slows down. Toward the oldest end, the diameter tapers smoothly to
  about 55% of its local speed-derived full diameter. The newest circular end
  is the head itself and belongs to the same silhouette rather than a separate
  filled primitive.
- The web renderer preserves valid subpixel pointer movement at the
  silhouette's newest end. Coalesced samples are assigned monotonic times in
  the same `performance.now()` animation-clock domain instead of trusting
  incompatible native event timestamp origins.
- Trail expiry is animation-frame-driven rather than movement-driven. Its old
  end uses `speed = min(3, 0.015 * length)` CSS pixels per millisecond, where
  `length` is the current traveled-path length in CSS pixels. It therefore
  slows toward zero as a short tail settles and accelerates as the trail grows
  until the configured 3 px/ms ceiling. The formula is integrated over elapsed frame time, so it behaves
  consistently at 60, 120, and 144 Hz. Movement does not reset the expiry clock
  or select a separate trimming mode. The newest head remains visible until the
  gesture finishes or is canceled. The initial round head and every later tail
  section are rebuilt as the same bounded silhouette, so a separate tail does
  not pop into view. Expiry owns one display-paced animation frame, suppresses
  Konva's automatic draw request while updating the silhouette, and draws the
  preview canvas directly instead of scheduling a second canvas frame.
- A separate thin 24 CSS-pixel-diameter footprint outline centered on the
  newest point shows the eraser's real 12 CSS-pixel collision radius. This
  outline is not part of the filled silhouette. The speed-sensitive silhouette
  is feedback only and never changes what will be erased.
- Collision uses a swept 12 CSS-pixel-radius capsule between consecutive input
  positions, not isolated point probes. Long, fast movement is subdivided for
  broad-phase lookup, and the precise phase checks rotated shapes, lines,
  arrows, and persisted freehand polylines. Small objects can therefore be hit
  while zoomed far out.
- The trail, pending IDs, and opacity changes are local renderer state; they are
  neither CRDT content nor awareness and create no undo item before commit.
- Pointer-up removes the trail after committing the pending deletion. Cancel,
  capture loss, pinch takeover, tool change, read-only transition, blur, hidden
  document, or renderer destruction removes the trail and restores every faded
  object without deleting anything.
- A zoom change cancels an active eraser because its fixed screen-space radius
  maps to a different logical radius. Same-zoom camera translation preserves
  its world-space continuity.

## Style controls

The style bar is hidden read-only and while an inline editor is open. It appears
for a styleable creation tool or a mutable selection. If selection exists and
the current tool is not Drawing, the bar edits that selection; otherwise it
edits the future creation preset.

For mixed selections the bar exposes the union of supported properties. A
property change affects only selected object versions that support it. A mixed
value remains visibly mixed until a value is chosen.

### Shape kind

While the stable Shape tool is active, the first style-bar group contains four
icon buttons: Rectangle, Ellipse, Diamond, and Frame/Area. Exactly one is
pressed. This is an inline segmented control, not a popup or dropdown, and it
remains visible even when the rest of the style bar is editing a current
selection.

Changing the kind keeps Shape active and changes only local creation input. It
does not replace or restyle the selection, mutate an existing object, enter the
CRDT or awareness, or create an undo item. The renderer snapshots the chosen
kind and that kind's independent creation style at pointer-down, so changing
the setting cannot alter a shape gesture already in progress. Switching the
  kind immediately restores its own persisted Rectangle/Ellipse/Diamond/Frame
  direct creation style for the next gesture.

### Shared creation-preset component

Drawing, Line, and Arrow use one shared web palette component. Drawing places
it inline; Line and Arrow show one
current composite cell in the main style bar and place that same component in a
second layer when the cell is pressed. The second layer is not a tool-specific
chooser and is not replaced when configuration starts. Its palette button,
cells, repeated-active-cell editor, add/delete/reorder behavior, keyboard and
pointer handling, focus restoration, and responsive scrolling are one code
path and one element structure.

The component receives only tool data and declared style properties:

- Line and Arrow presets own stroke color, width, and opacity; Arrow also owns
  its dash pattern.

Pressing an inactive cell selects its complete future-creation style. Pressing
the active cell again opens the property editor for that cell. Configuration
edits any cell without selecting it; add clones the active cell, delete retains
at least one, and reorder changes only device-local order.

Text uses direct creation controls: foreground, font size, family, and
bold/italic are edited as one persisted tool style without preset cells.
Rectangle, Ellipse, Diamond, and Frame also use direct controls. Their outline
and fill are separate color controls with separate triggers and pickers;
outline thickness is a third independent control and is never encoded by color
cell fill or size. Opacity and dash remain separate direct controls.

Selection styling intentionally remains direct-property editing. A selected
object is durable board content rather than a future creation preset, so it
continues to use the ordinary color, width, opacity, dash, and text controls
below and never exposes creation-palette add/delete/reorder actions.

### Shared colors and ordinary tool settings

Direct selection stroke, shape fill, and text foreground use the same
device-local Color Library. A favorite is an accelerator, never an allow-list:
every direct color control
offers an arbitrary six-digit sRGB color through the built-in saturation/value
plane and hue rail. There is no `input[type=color]`, platform color dialog, or
browser EyeDropper. While mounted, the picker keeps one authoritative
floating-point HSVA draft and canonicalizes its opaque color to lowercase
six-digit HEX only at the adapter callback boundary. Ordinary style colors do
not expose alpha. Transparency remains a separate semantic `Без заливки` action
so a color cannot accidentally multiply the object's general opacity. That
action is hidden when any target is Text or LaTeX.

- A compact trigger shows the exact current color over a checkerboard. It shows
  a divided mixed indicator for heterogeneous selection and a red slash for no
  fill. The default adaptive ink `#17212b` is shown light in the dark theme,
  matching the renderer rather than becoming an invisible dark dot.
- The fill property's label is contextual: `Цвет текста` for Text/LaTeX,
  `Цвет заливки` for shapes, and `Цвет текста / заливка` when one selection
  contains both meanings of the durable `fill` field.
- A Text/LaTeX-only foreground trigger contains only the swatch; it has no
  paint-bucket icon. Mixed text-and-shape fill retains the shape-fill icon
  because the same control also changes actual fills.
- Pressing the trigger opens a non-modal dialog. A favorite, recent color,
  transparent action, saturation/value or hue gesture, or valid advanced-format
  commit can apply a color. There is no persistent numeric field in the ordinary
  picker.
- The saturation/value plane maps horizontal position to 0%-100% saturation and
  vertical position to 100%-0% value. Primary mouse, pen, and touch input begins
  on pointer-down, uses pointer capture where available, previews continuously,
  and ends on pointer-up. If capture cannot be established or is unexpectedly
  lost, bounded window listeners continue the same pointer ID outside the plane
  through up/cancel and are then removed. Keyboard and assistive navigation
  exposes separate native range axes named `Насыщенность` and `Яркость` instead
  of misrepresenting the two-dimensional plane as one slider. Arrow keys change
  the focused axis by one percentage point, or ten with `Shift`; `Home`/`End`
  select its bounds and `PageUp`/`PageDown` move it by ten points. Boundary
  attempts clamp at 0% or 100%. The visually hidden axes give the plane a visible
  focus outline. Each pointer or keyboard sample updates the authoritative HSVA
  draft synchronously before its coalesced preview; a parent re-render which
  echoes the emitted rounded HEX cannot rederive or move an unchanged hue. This
  remains stable at low saturation/value as well as for grayscale.
- The hue rail covers 0-359 degrees in one-degree steps and keeps standard
  pointer, touch, and range-input keyboard behavior, including Arrow,
  `Home`/`End`, and `PageUp`/`PageDown` gesture boundaries. A change emitted by
  assistive technology without a preceding pointer/key gesture is one discrete
  commit rather than an open-ended undo capture. Hue and alpha pointer drags use
  pointer capture where available. Failed or lost capture installs a bounded
  same-pointer window fallback that continues previewing through an outside
  release and is always removed on up, cancel, blur, or unmount. Its gradient is
  regenerated from the current saturation and value at the seven HSV sector
  boundaries; near-gray and dark selections therefore show a correspondingly
  muted or dark rail rather than an unrelated vivid rainbow.
- The saturation/value handle stays circular and has a solid current-color
  center. The saturation/value plane itself has square, unrounded corners. Hue
  and optional alpha inputs keep a 30-CSS-pixel ordinary hit height,
  enlarged to 38 CSS pixels for a coarse pointer, while their visible tracks
  remain exactly 14 CSS pixels tall with a one-pixel corner radius. Their thumbs
  are borderless 7 by 14 CSS-pixel rectangles filled by the selected color. The
  fill reaches the track's top and bottom pixels. The light and dark
  box-shadow rings lie entirely outside it, use exact integer 1 px and 2 px
  spreads in ordinary and focus states, and never depend on a fractional device
  pixel which may disappear during rasterization. The saturation/value handle
  remains unchanged with its exact 1 px exterior dark ring. The focus halo begins outside
  the enlarged dark ring.
- The optional alpha variant is used by creation-preset popups. Its rail
  is labelled `Непрозрачность`, displays the current opaque color at the left
  fading to complete transparency over a checkerboard at the right, and edits
  the slot's independent `0..1` opacity. To preserve that left-to-right visual
  direction, the native range is RTL: its value is opacity alpha (`1` at the
  left and `0` at the right), which the picker reports unchanged. Alpha from the
  rail or RGBA/HSVA/HEXA input is snapped to the configured 1% preset step
  before preview and commit, so the preset never visibly corrects itself after
  input. Direct selection stroke/fill/text pickers omit this rail and continue
  to use the separate general-opacity control where applicable.
- The checkerboard preview button renders the current alpha when the optional
  variant is active. Primary click lazily mounts a separate portalled advanced
  popup to the left of the picker and a second click closes it. It falls back
  to the right only when the board boundary leaves insufficient room on the
  left. Right-click still suppresses the browser context
  menu and opens it; `Context Menu` and `Shift+F10` do the same and move focus
  to its first field. The trigger counts as part of the panel for outside-click
  ownership, and the portalled popup remains inside its host palette's logical
  interaction surface, so pointer and focus inside it cannot close the host.
  The trigger's `pointerdown` cannot close and immediately reopen the panel.
  No format rows or format drafts exist
  while it is closed. The panel exposes synchronized RGB/RGBA and HSV/HSVA rows
  as appropriate plus six-digit HEX, or eight-digit HEXA in the alpha-enabled
  preset variant. RGB channels are integers from 0 through 255; HSV hue is
  0-360 and saturation/value are percentages from 0% through 100%; alpha accepts
  `0..1` or a percentage. Each row accepts native text paste/edit on `Enter` or
  blur and has a copy action for its current canonical representation, never an
  invalid dirty draft. Clipboard success or failure is announced without
  changing the color. Invalid or incomplete input remains visibly invalid and
  never reaches the CRDT, a creation preset, or Recent Colors. `Escape` discards
  any uncommitted format draft, closes and unmounts the advanced panel in one
  action, and restores focus to the preview without closing the host popup.
- Pointer and keyboard picker previews are coalesced to one callback per
  animation frame. For a selection, pointer-down/first adjustment opens one
  continuous local style capture; pointer-up, matching key-up/blur, or a valid
  advanced-format commit flushes the last preview and ends one undo item. Only
  that final committed color enters Recent Colors, never every intermediate
  sample.
  `pointercancel`, owned capture loss, or browser blur flushes the queued preview
  and closes the capture without adding an MRU entry. Popup close or unmount
  keeps previews already emitted but discards a not-yet-emitted animation-frame
  sample before closing the capture, so no style write can arrive after its undo
  boundary. Palette-slot editing is device-local and creates neither a board
  undo item nor an MRU entry.
- The popup is portalled outside the horizontally scrolling style strip. It is
  measured and clamped to the visible board/viewport, chooses the side with
  useful space, updates on resize or ancestor scroll, and has a bounded
  independently scrollable height. It therefore does not get clipped at a
  narrow-board edge or by style-bar overflow.
- The close button and ordinary dialog-level `Escape` restore focus to the
  trigger. Outside pointer-down closes without stealing focus from its target.
  An open advanced-format panel consumes `Escape` first as described above.
  While palette configuration is active, the remaining `Escape` stack first
  cancels an active reorder, then leaves palette configuration and focuses its
  settings toggle; another press closes the color dialog.
- Opening the popup moves focus to its dialog container without scrolling.
  The next native `Tab` therefore enters the popup controls instead of skipping
  to the next style-bar control and dismissing the popup immediately.
- `Tab` remains native and is not trapped. Moving keyboard focus outside both
  the trigger and portalled dialog closes the dialog while preserving the new
  focus target.
- Pointer-down anywhere in the popup's composed subtree counts as internal,
  including its title, labels, explanatory text, blank background, and picker
  surfaces. A short internal-pointer guard prevents the resulting focus change
  from being mistaken for outside focus; ordinary focus behavior of actual
  inputs and buttons is preserved. Clicking popup text or empty space therefore
  never closes it.

A fresh profile has these ordered shared favorites:

`#17212b`, `#8492a6`, `#ffffff`, `#d33f49`, `#ec4899`, `#2563eb`,
`#16825d`, `#d97706`, `#ffd43b`, `#7c3aed`, `#fff3bf`, `#dbeafe`,
`#dcfce7`, `#ffe4e6`.

Favorites and Recent Colors are separate horizontal scroll rows. Each keeps a
dedicated bottom lane between its cells and scrollbar, so revealing or hovering
the scrollbar never covers a color cell. Chromium/WebKit uses a visible
6 CSS-pixel track without end-arrow buttons; Firefox uses its platform `thin`
scrollbar. Track and thumb contrast are theme-specific, and the thumb gains
contrast on hover. The ordinary Favorites row is at least 45 CSS pixels tall
for 34 px cells; Recent Colors is at least 44 px tall for 27 px cells. On a
coarse pointer both rows are at least 55 px tall for their respective 44 px and
38 px targets. The popup's existing bounded vertical scroll absorbs this
additional fixed room on a short viewport.

While the popup is open, wheel and touchpad input over either row scrolls that
row horizontally. The input axis with the greater absolute delta is used;
equal deltas use the vertical component. A positive delta moves right and a
negative delta moves left. Pixel-mode deltas are used directly, line-mode
deltas are multiplied by 32 CSS pixels, and page-mode deltas are multiplied by
the row's current client width. Non-finite and zero deltas are ignored. The
resulting `scrollLeft` is clamped to `0..scrollWidth-clientWidth`. A handled
move prevents native scrolling and never reaches the board camera. At a bound,
or when the row does not overflow, no horizontal write occurs; propagation is
still stopped so the board cannot pan, while uncancelled browser-default
behavior may continue scrolling the popup itself. `Ctrl`/`Cmd` wheel/pinch and
wheel during an owned Favorites reorder are consumed without scrolling either
row. Touch continues to use native horizontal panning; in Favorites
configuration mode the existing 240 ms hold rule still separates reorder from
pre-hold touch scrolling. Scrolling changes only DOM view state: it does not
choose or edit a color, reorder a slot, move the board camera, emit awareness or
CRDT data, or create/consume an undo item.

The library may contain 1-24 stable-ID slots. Its settings button enters a mode
in which pressing a slot edits that slot without applying it to the object or
current tool. Add appends the currently edited color and opens the new stable
`custom-N` slot; delete cannot remove the final slot. Changing or deleting a
favorite never recolors existing objects and never changes a creation preset.
Mouse/pen reorder uses a 6 CSS-pixel activation threshold; touch requires a
240 ms hold, while movement before the hold scrolls the row. The dragged slot
keeps its grab point, neighbors preview their displacement, edge scrolling is
animation-frame-coalesced and refresh-rate-independent, and pointer-up commits
at most one final-index move. Cancel/capture loss/blur/`Escape` restores the
source order. `Alt+ArrowLeft` and `Alt+ArrowRight` move a focused slot one
position and keep focus; boundary attempts are consumed no-ops. Pointer focus
does not leave a tab-like ring, while keyboard `:focus-visible` remains.

Up to eight non-favorite Recent Colors are kept in most-recent-first order,
canonicalized and deduplicated. Favorite slots, their IDs/order, and recents
persist best-effort under `eduri-board-style-color-palette-v1` as the strict,
versioned envelope `{"version":1,"slots":[...],"recentColors":[...]}`. Input
longer than 65,536 UTF-16 code units, a wrong version, invalid/duplicate ID,
invalid color, count violation, duplicate recent, or structural drift rejects
the whole value and restores fresh defaults. Writes are debounced by 180 ms and
flushed on `pagehide` and surface unmount. Storage failure never blocks input.
Library operations are device settings: they produce no board update,
awareness payload, collaboration packet, or undo item.

Direct selection controls and the property editors inside creation-preset cells
use the following bounds:

- Ordinary Text is edited directly in its board object. The textarea overlay
  follows the object's canvas position, dimensions, zoom, rotation, font,
  weight, italic style, color, and opacity; it has no detached popup size,
  panel, opaque background, outline, or shadow. The matching canvas glyphs are
  suppressed locally while the transparent textarea is active so text is not
  drawn twice. Code and LaTeX retain their dedicated editors because their
  source-oriented workflows are distinct from plain text editing.

- General selection and Shape stroke width is 0.5-96 with a 0.5 exact-input
  step. Drawing, Line, and Arrow preset editors use the same reusable width
  control; Drawing and Line retain their 0.5-16 bound while Arrow uses 0.5-96.
  The range track moves through progressive common stops (`0.5`, `1`, `1.5`,
  `2`, `2.5`, `3`, `4`, `5`, `6`, `8`, `10`, `12`, `16`, then wider values up
  to the tool maximum), giving thin strokes most of the useful travel. A live
  dot previews thickness and the adjacent exact `px` field accepts every
  bounded 0.5 value. That field uses only the compact width needed for the
  rendered number and `px` suffix; the remaining reusable-control width belongs
  to the slider track.
- Opacity is 5%-100% with a 1% slider step and exact percentage input. It is
  hidden for a selection whose opacity-capable objects are all Text and/or
  LaTeX. Their durable opacity capability and any existing value are still
  preserved and rendered. A mixed selection containing at least one
  opacity-capable non-text object may show the union control; changing it still
  targets every selected object version which declares opacity.
- Font size accepts every 0.5 value from 8 through 256. A datalist supplies
  common sizes without restricting manual input, while browser spinner arrows
  are visually removed. Wheel directly over the input consumes the event so the
  board cannot pan: wheel up adds 0.5, wheel down subtracts 0.5, and holding
  `Shift` uses 5-point steps. Values clamp to 8-256. A wheel burst outside input
  focus ends after 180 ms of inactivity and is one continuous undo item; while
  the field is focused, focus/blur owns the same continuous capture.
- Font family uses a portalled select-only combobox/listbox rather than a native
  select or a visible CSS stack. Its named choices are `Inter`, `Georgia`,
  `Cascadia Code`, `Arial`, `Verdana`, `Trebuchet MS`, `Times New Roman`, and
  `Courier New`; each provides Cyrillic coverage, with a Cyrillic-capable
  fallback in its stored stack. Every ordinary option displays its own friendly
  family name in the complete fallback stack that it represents. The compact
  closed trigger reads `Шрифт` and renders it in the selected
  known family. Mixed and unsupported historical values keep the interface
  font; the trigger title still identifies a known current choice. Hovered and
  keyboard-active options use only the menu's subtle background and never draw
  an outline or inset ring around the row. Their background spans the complete
  inner width and height of the listbox with no gap at any border. The outer
  frame remains an integer one CSS pixel but uses a reduced-contrast border
  color instead of an unstable fractional width. The option's
  accessible name is the same actual family name shown in the list. An
  unsupported historical stack cannot be entered or selected again.
  Choosing a named option persists its complete safe fallback stack rather than
  its display label.
- Pressing the closed font trigger, `Enter`, `Space`, or an opening navigation
  key opens the listbox. `ArrowUp`/`ArrowDown` move through options,
  `Home`/`End` move to the first/last option, and printable-key typeahead moves
  to a matching label. `Enter` or `Space` chooses the active option. `Escape`
  closes without changing the value and restores focus; `Tab` closes while
  allowing normal focus traversal. Pointer-down outside dismisses the popup
  without selecting an option.
- Solid `[]`, dashed `[8,6]`, and dotted `[2,5]` remain one-press line-pattern
  shortcuts. `Свой рисунок штриха` accepts an arbitrary comma/space/semicolon
  sequence of up to eight alternating line/gap lengths, each 0-256, previews
  it, and applies it with `Enter` or the Apply button. Empty/`solid` and an
  all-zero pattern normalize to solid. Invalid or oversized patterns never
  mutate state. The Solid button applies `[]` immediately. The editor is also
  portalled and board-bounded. Opening focuses and selects its input; `Escape`
  closes without applying and restores focus to the trigger. Pointer-down or
  keyboard focus outside the trigger and popup closes it without stealing the
  outside target's focus.
- Freehand stroke objects deliberately do not expose their retained dash field.
- Bold and italic are independent tri-state controls. Activating a mixed token
  enables that token for every compatible object without removing the other
  token.

The style bar has no broad `Сбросить оформление` action for either a creation
tool or a selection. Users change the exposed properties directly. This does
not remove the separate toolbar-layout reset in its configuration dialog.

Mixed width, opacity, size, family, color, and dash values remain explicit.
Exact numeric fields are blank for a mixed value; mixed sliders are visually
muted rather than pretending that their fallback thumb is the shared value.
Choosing any value applies it only to selected object versions which declare
that capability.

A discrete multi-object style change is one atomic undo item. A slider,
exact-number focus, font-size wheel burst, or in-app picker gesture is held as
one undo item until its documented pointer/key/focus boundary, read-only
transition, selection change, or style-bar disappearance. Palette editing and
future creation-preset changes do not change CRDT content or undo history.

The style bar never contains any layer-order button (Bring to front, Forward,
Backward, or Send to back), regardless of the current tool or selection. All
four commands remain available from the selected-object context menu and
through `Ctrl`/`Cmd` bracket shortcuts.

Arrow remembers an independent ordered 1-24-cell palette across tool switches
and browser remounts. The strict
device envelope lives under `eduri-board-tool-style-palettes-v1` as
`{"version":1,"palettes":{...}}`. Every target record contains an existing
`activePresetId` and bounded stable-ID presets with only that target's declared
style capabilities. Input above 256 KiB, missing/extra targets, invalid or
duplicate IDs, count violations, a missing active ID, structural drift, or a
wrong version rejects the complete envelope and rebuilds safe defaults.

On the first load without this envelope, the previous single style from
`eduri-board-tool-styles-v1` becomes the first active cell for the corresponding
tool, preserving existing device choices; additional starter cells vary the
tool's primary color. The legacy envelope remains a compatibility mirror of
each active cell. Writes use the existing 180 ms debounce and flush on
`pagehide`/unmount. Values normalize to renderer-safe color, width, opacity,
dash, font-size, font-family, and font-style bounds. These settings are outside
the board CRDT, awareness, wire protocol, and undo history; only a subsequently
created object materializes the selected cell as durable object fields.

### Line and Arrow point editing

- A newly created Line or Arrow has three durable ordered anchors: the two endpoints and
  a center anchor initially halfway between them, so the initial line is
  straight. Moving the center anchor bends a smooth cubic path through all
  anchors. Existing two-point and quadratic Line/Arrow objects remain readable;
  the first point edit converts them to ordered anchors.
- `Enter` on exactly one selected mutable Line or Arrow enters point editing. A
  double-click/double-tap on either does the same. The ordinary resize/rotation
  Transformer and whole-object dragging are hidden while this mode is active.
- Every durable anchor is draggable. Between each adjacent pair, a smaller
  insertion handle is shown. Dragging it at least 3 CSS pixels inserts a new
  durable anchor at that segment; a click or shorter drag is a no-op. The live
  curve follows an anchor or pending insertion locally without waiting for
  persistence or collaboration.
- Pressing an anchor selects it. `Delete` or `Backspace` removes only that
  anchor while the line has more than two anchors. With no selected anchor, or
  with only two anchors, deletion is a consumed no-op and never deletes the
  whole connector.
- Anchor drag, midpoint insertion, and point deletion each replace the connector
  transform and ordered point list in one `line.points.set` CRDT command and
  one local undo item. Normalization may move the local origin while preserving
  the world-space curve and rotation.
- `Escape`, a tool/selection/read-only change, object removal, or an outside
  canvas press exits point editing. Handles and pending insertion are
  renderer-local and are not awareness or CRDT state.

### Line preset palette

Line uses an independent device-local color/width/opacity palette with the same
1-24 slot bounds, composite cell rendering, picker, alpha/width ranges,
add/delete/reorder behavior, and storage-failure semantics as Drawing. It is
stored under `eduri-board-line-presets-v1`; it does not change board content or
undo history until a new Line is created.

Line and Drawing render the palette through the same web component, element
structure, handlers, and CSS classes. The Line adapter changes only where that
shared component is placed: below the main style bar instead of inline inside
it. There is no separate Line chooser or configuration implementation.

- Ordinary Line mode shows one composite cell for the active preset. Pressing
  it opens the chooser. Pressing an inactive chooser cell selects its complete
  preset; pressing the already active cell a second time opens that cell's
  color/opacity/width picker.
- The palette button lives inside the opened Line preset chooser, never beside
  the single active cell. It enters configuration mode, where all Line cells
  may be edited, created, deleted, and reordered exactly like Drawing cells.
  The same mounted palette component stays in the second-layer panel while its
  configuration state changes; it is not replaced by another chooser or moved
  into the main style bar. The main style bar continues to show only its single
  current Line cell. The same palette button remains at the left of the second
  layer and becomes its visible finish-configuration control. The Line and
  Drawing preset data remain independent.

### Drawing palette and preset slots

A fresh browser profile starts with six device-local slots:

| Slot | Initial width | Initial opacity |
| --- | ---: | ---: |
| Graphite | 2.5 | 100% |
| Red | 2.5 | 100% |
| Blue | 2.5 | 100% |
| Green | 2.5 | 100% |
| Orange | 2.5 | 100% |
| Yellow | 16 | 38% |

- The live palette is ordered and may contain 1-24 slots. Slot IDs remain
  stable while slots are edited or reordered.
- The palette image at the left is an `aria-pressed` toggle button. Pressing it
  closes the preset popup, cancels an unfinished palette reorder, and enters or
  leaves palette-configuration mode. It does not yet open a separate global
  Drawing-settings window.
- Outside configuration mode, pressing an inactive slot selects its complete
  color/width/opacity preset and closes the popup. Pressing the active slot
  again toggles its popup.
- A vertical-dominant wheel gesture directly over any slot changes that slot's
  width without selecting it, opening/closing its popup, or moving focus.
  Wheel up adds 0.5 and wheel down subtracts 0.5, clamped to 0.5-16; an event at
  either bound is still consumed so it cannot pan or zoom the board. The slot
  indicator, accessible label/title, and an already-open popup update from the
  same preset value. An active-slot change affects subsequent strokes; a stroke
  whose pointer gesture already started keeps the style captured on
  pointer-down, and existing objects are never changed.
- Pixel-mode high-resolution wheel input accumulates 24 CSS pixels per 0.5
  step, with one event contributing at most one step. Changing direction or
  hovered slot, or pausing for more than 180 ms, discards the partial remainder.
  A nonzero line/page-mode event is one step. Horizontal-dominant gestures are
  left to the palette strip's native scrolling. `Shift` and `Alt` do not change
  the step. `Ctrl`/`Cmd+wheel` is consumed without changing width so browser
  touchpad-pinch zoom cannot leak through the slot. While a palette reorder owns
  the pointer, vertical wheel is likewise consumed without changing width.
- Configuration mode puts a restrained scrim over only the shared palette
  surface and its preset wells: 38% dark overlay in the light theme and 30% in
  the dark theme. Drawing and the floating Line/Arrow second layer use the same
  palette-owned overlay; sibling controls and the surrounding style bar never
  dim. The palette toggle stays emphasized above the scrim with a distinct blue pressed
  color; in dark mode this pressed color is deliberately different from both
  its idle and hover colors. Edit-only delete/add controls and an open preset
  popup remain visible and operable.
- Pressing any slot in configuration mode opens that slot's popup immediately
  without selecting it. Editing an inactive slot therefore does not change the
  style used by Drawing until that slot is selected after leaving
  configuration mode. Repeatedly pressing the same slot keeps its popup open;
  unlike an active slot in ordinary mode, it is not a close toggle here.
- The popup embeds the same in-app saturation/value, dynamic hue, preview, and
  lazy advanced-format picker as ordinary style colors; it contains no native
  color input or EyeDropper. It starts directly with the picker and has no
  redundant tool-name header, close-icon row, or leading divider. This is the
  alpha-enabled picker variant: its
  integrated rail edits the slot's opacity from 0%-100% in 1% steps, including
  complete transparency, while width remains a separate 0.5-16 control in 0.5
  steps, separated from the color controls above it by a one-pixel divider with
  equal 7 CSS-pixel spacing on both sides.
  Color and alpha previews update the device-local slot at most once per
  animation frame; they never create a board undo item or add that slot color
  to Recent Colors.
- Outside pointer-down, tool change, or `Escape` closes it. `Escape` restores
  focus to the owning slot; outside pointer-down does not force focus.
- The swatch uses a transparency checkerboard and represents color, opacity, and
  width. At 100% zoom its circle diameter is twice the logical pen width, up to
  a 32 px color area centered inside an exact 34 px circular well with a
  one-pixel border. On a device with a real fine-pointer hover, one
  80 ms linear scale transition changes the colored circle's diameter by
  4 px when that fits within the cell; otherwise it reduces the diameter by 2
  px rather than overflowing. Subpixel interpolation and edge antialiasing vary
  the alpha of partially covered boundary pixels, without staged ring layers or
  a detached outline. Pointer exit restores the exact preview size.
  `aria-pressed` selection never
  changes that size. The selected slot is identified by a compact accent marker
  in a dedicated row below its circular cell; it has no square outline or
  selected background. The palette reserves this vertical space instead of
  overlaying the marker on the cell or clipping it in the scrolling strip.
  The inline Drawing palette provides that clearance in its style bar; the
  floating Line/Arrow palette provides it inside its own scroll track. Mounting
  or opening that floating palette never changes the main style-bar frame
  dimensions or position.
- New strokes are always solid and `source-over`; the wide translucent yellow
  slot is not a separate marker tool.

Configuration-mode editing:

- A small delete button appears at the upper-right of every slot. Deletion is
  disabled when only one slot remains. Deleting an inactive slot preserves the
  active slot. Deleting the active slot activates the slot now at the same
  index, or the preceding final slot when the deleted slot was last. Focus
  moves to the next visible slot, otherwise the preceding slot.
- The add button is visually docked immediately outside the right edge of the
  style bar. It is an absolutely positioned child of the style-bar root and is
  outside the centered preset strip's flex/scroll content. It takes no layout
  space, never shifts or widens the palette when configuration mode starts, and
  cannot be clipped by the strip's horizontal scroller.
  The docked button
  uses the active theme's panel, border, text, and hover tokens rather than
  relying on the dimmed strip behind it. Pressing it
  appends a clone of the active slot, leaves the current active slot unchanged,
  and immediately opens the new slot's popup. It is disabled at 24 slots.
  Generated local IDs use the first available `custom-N` value.
- Primary mouse and pen Pointer Events may reorder a slot after a 3 CSS-pixel
  movement threshold. Touch uses the same reorder threshold after a 240 ms
  hold. Before that hold elapses, a touch movement past a separate 6 CSS-pixel
  scroll slop scrolls the strip horizontally and suppresses the resulting click
  instead of reordering; a stationary short touch remains an ordinary slot
  press. The adapter owns this touch movement because editable preset buttons
  use `touch-action: none`.
- Once reordering activates, the grabbed slot follows the pointer horizontally
  with its original grab point preserved. Its DOM position remains stable
  during the preview; neighboring slots move with short transforms to open the
  prospective gap, so the dragged slot does not jump between flex positions.
  The delete cross on the grabbed slot is hidden for the duration of the drag.
  Motion, slight elevation, and the grabbing cursor identify the dragged slot;
  no synthetic outline or ring is drawn around it.
  Crossing a neighbor is calculated from the moving slot's center rather than
  the raw pointer coordinate, so grabbing near either edge does not change the
  reorder threshold.
- A non-primary or foreign pointer cannot replace the pointer which owns an
  active slot gesture. After reorder activation, the strip previews the
  prospective order once per animation frame. Holding the pointer within
  28 CSS pixels of a scrollable horizontal edge continues scrolling at
  540 CSS pixels per second, independent of display refresh rate. Its maximum
  range is captured from the untransformed strip at pointer-down, so the
  dragged slot's own transform cannot extend that range. Scrolling stops when
  the physical bound or the final reorder position in that direction is
  reached.
- Pointer-up after a real drag commits exactly one final-index reorder when the
  final index differs from the source index. Returning to the source position
  is a device-local no-op and produces no move callback or announcement. Both
  cases suppress the synthetic click which would otherwise open the popup. A
  below-threshold pointer-up remains an ordinary slot press and opens the popup.
  Release recalculates the target from the current scroll position without one
  more edge-scroll step. A real reorder replaces preview transforms and the DOM
  order in one guarded commit frame, so old transforms never animate relative
  to the new flex positions or flash the source order.
- `pointercancel`, owned pointer-capture loss, browser-window blur, tool change,
  leaving Drawing, unmount, toggling configuration, or `Escape` cancels an
  unfinished reorder. Its preview returns to the persisted source order and no
  reorder is committed. A canceled gesture cannot open the slot popup through
  its later compatibility click. Pointer capture is best-effort; capture-phase
  window listeners finish or cancel an owned pointer which leaves the button
  when capture is unavailable.
- With a preset button focused, `Alt+ArrowLeft` or `Alt+ArrowRight` moves it
  exactly one available position and keeps its stable identity and focus.
  These shortcuts reject an additional `Ctrl`/`Cmd` or `Shift`. Movement past
  either end is a consumed no-op, so browser Back/Forward navigation cannot
  steal focus. The buttons publish both combinations through
  `aria-keyshortcuts`; pointer and keyboard moves are announced through a
  polite live region.
- Pointer focus and an active pointer drag on a preset have no persistent ring.
  A preset reached from the
  keyboard still receives a custom inset `:focus-visible` ring; add/delete
  buttons keep their own keyboard-only outlines. Pointer interaction therefore
  cannot leave a tab-like selection around a palette cell, while `Tab` and the
  accessible `Alt+Arrow` reorder path remain visible.
- Palette configuration has its own `Escape` stack before ordinary board
  `Escape`: first cancel an active reorder, then close an open preset popup,
  then leave configuration mode and focus the palette toggle. One press removes
  only one present layer, so nested state may require multiple presses.

Palette count, order, IDs, and slot values persist best-effort after 180 ms and
synchronously on browser `pagehide` and surface unmount under
`eduri-board-free-drawing-presets-v2` as
`{"version":2,"presets":[...]}`. Loading accepts 1-24 structurally valid,
uniquely identified slots from a serialized string no longer than 65,536
UTF-16 code units; invalid structure rejects the complete V2 value, while
color, width, and opacity fields are normalized to their supported ranges. If
V2 is absent or invalid, the exact legacy six-slot array at
`eduri-board-handwriting-presets-v1` is read as a migration fallback; the
legacy key is never written. If neither value is usable, built-in defaults are
restored. Browser-storage failure never blocks drawing. A remount activates the
first slot in the loaded order rather than persisting the prior active ID.

Selecting, editing, adding, deleting, or reordering slots and entering/leaving
configuration mode are local UI/input state. They produce no board CRDT update,
awareness payload, or undo/redo item and never modify an existing stroke.
Wheel width adjustment follows the same device-local persistence path and does
not start a continuous board-style command.

## Clipboard, duplicate, and paste

Standard copy/cut/paste are handled through native clipboard events while the
board has focus. Text editors retain the browser's native text clipboard.

- Copy is allowed read-only. Cut and paste are not intercepted read-only.
- Clipboard events write Eduri's custom portable Board Fragment v1 MIME plus a
  text fallback.
- A native paste snapshot is classified globally in this order: valid Eduri
  custom MIME; valid Eduri fragment in `text/plain`; first supported image;
  ordinary non-empty `text/plain`. Image therefore wins over screenshot/HTML
  text, while an Eduri fragment wins over both.
- A present custom MIME or reserved Eduri-prefixed text which is malformed,
  oversized, or unsupported fails the complete operation. It is never inserted
  as ordinary text and never falls through to an image.
- Rich custom-MIME and `text/plain` blobs are size-checked before their full
  text is read. For `text/plain`, only a small prefix is read first to
  distinguish Eduri's reserved fragment namespace. An oversized ordinary text
  payload or encoded fragment is rejected without materializing the complete
  blob as a JavaScript string.
- External PNG, JPEG, WebP, and GIF clipboard blobs use the same image
  validation, durable local outbox, and object-creation path as the Image
  picker. Only the first supported image in one clipboard snapshot is inserted;
  there is no partial multi-image batch.
- After an external-image paste successfully creates its durable object, the
  web client directly activates Select and makes that image the sole selection.
  This is not the repeated-Select toolbar toggle, so an already active Select
  never changes to Hand. Pending, failed, or invalidated clipboard-image
  insertion changes neither the current tool nor the current selection. The
  Image creation tool has the separate keep-Image-active policy documented
  above.
- External non-empty `text/plain` creates one selected `eduri/text` object
  containing the exact collaborative text, including leading/trailing
  whitespace and line breaks. It does not automatically open the inline
  editor. Empty text creates nothing. One text paste is limited to 4 MiB UTF-8;
  this is a single-command guard, not a board-size limit.
- Toolbar Copy uses the system text clipboard and remembers a same-tab fallback
  if permission or write fails. It reports that the system clipboard is
  unavailable even though same-tab paste can still work.
- Toolbar Cut deletes only after a confirmed system clipboard write. It never
  deletes on a same-tab-only fallback.
- An asynchronous cut becomes copy-only if the document, ordered selection, or
  complete Yjs state vector changes before deletion.
- Toolbar and context-menu Paste first use `navigator.clipboard.read()` so they
  can receive images and text, then degrade to `readText()`. A browser which
  denies or lacks rich clipboard reading can still paste images through native
  `Ctrl`/`Cmd+V`; only a completely denied system read may use the remembered
  same-tab Eduri fragment.
- Native `ClipboardEvent.clipboardData` is the authoritative current snapshot.
  A null, empty, or unreadable native event never substitutes remembered
  same-tab content.
- Paste and Duplicate share one ordered queue. They validate the complete
  fragment, referenced assets, image, or text limit before changing the target
  document.
- Reserving a toolbar/context Paste slot happens at command invocation, before
  its asynchronous system-clipboard read settles. A later native Paste or
  Duplicate therefore cannot overtake it.
- The queue is scoped by a monotonic document/access epoch. Replacing the
  document or entering/leaving read-only immediately gives the current surface
  a fresh queue and clears its busy state; old reads, validation, or asset
  persistence cannot block it. Returning to the same document or permission
  state never revives an operation from an earlier epoch.
- A successful Undo or Redo which moves one history item similarly starts a
  fresh clipboard history scope and clears the current busy state. Any
  clipboard read, fragment validation, image decode, or asset persistence that
  began against the preceding history state may finish its private work, but it
  cannot add an object, change selection, show a stale error, or clear the
  restored Redo stack.
- Inserted objects receive fresh IDs, preserve source relative z-order, move to
  the front, remap included parents, detach parents outside the fragment, and
  become the new selection.
- Paste anchors at the most recent local board cursor, or viewport center if no
  cursor is known. The document, world anchor, camera zoom, and viewport are
  frozen when the command begins, before clipboard permission, image decode, or
  local persistence. Later cursor/camera movement cannot retarget it.
- Repeating identical fragment, text, or image content cascades by 24 screen
  pixels diagonally at the zoom captured for each command.
- Paste or Duplicate invoked from the context menu instead uses the exact
  world point captured when that menu opened; later cursor movement cannot
  change the asynchronous operation's anchor.
- `Ctrl`/`Cmd+D` duplicates through the same local fragment insertion path
  without touching the system clipboard.
- One successful object paste or duplicate is one local undo item. Image
  persistence finishes before its CRDT object exists. Decode, validation,
  text-limit, MIME, or local-storage failure inserts no partial object.
- A successful insertion has an undo boundary both before and after its CRDT
  mutation. It cannot merge into nearby text typing, style work, nudging, or
  another local command merely because its asynchronous preparation completed
  during that command's capture window.
- If the surface unmounts, becomes read-only, or switches documents while an
  asynchronous paste is pending, no object, selection, stale error, or undo item
  is committed to either document. A blob which already reached the durable
  outbox remains safely retained for later asset garbage collection.
- One operation is guarded at 50,000 objects with bounded header/update/container
  sizes below the sync protocol's 16 MiB update limit. This is an operation
  guard, not a total-board limit.
- Same-board image references remain valid. Cross-board/generation image paste
  is rejected unless the exact immutable hash, byte count, and MIME identity is
  already durable in the target. Repeated references to one asset are grouped
  into one lookup; conflicting identities for one asset fail before lookup, and
  distinct lookups run with bounded concurrency. Unknown image versions are
  never guessed.

## Inline editors

- Text/code/LaTeX open from double-click/double-tap or `Enter` on exactly one
  selected object. Text also opens after its canvas placement, and Code/LaTeX
  open after a placement-tool canvas click; merely selecting any tool opens no
  editor. A new Text placement starts with the provisional lifecycle above;
  existing Text and newly placed code/LaTeX edit durable objects immediately.
- Ordinary Text keeps the object's exact projected position, dimensions, zoom,
  rotation, typography, opacity, wrapping, and vertical alignment at every
  viewport width. It is never moved or expanded into a detached mobile panel.
- Code and LaTeX source overlays are clamped into the visible board, have a
  minimum screen size of 220 x 72, and currently do not rotate with the object.
- Blur outside the editor container exits. Moving focus to the Run button inside
  a code editor does not exit.
- `Escape` exits any editor except while the key event belongs to an active
  native IME composition.
- Text: `Enter` exits; `Shift+Enter` inserts a newline; spellcheck is enabled.
  A composing `Enter` remains reserved for the IME. `Ctrl+Enter`,
  `Cmd+Enter`, and `Alt+Enter` do not exit and retain the textarea's native
  behavior.
- Code and LaTeX: `Enter` inserts a native newline; spellcheck is disabled.
- Text uses collaborative `text`; code and LaTeX use collaborative `source`.
  Local input performs a minimal prefix/suffix replacement. Remote deltas patch
  the textarea and translate its selection without dropping focus.
- IME composition creates explicit undo boundaries.
- Editor `Ctrl`/`Cmd+Z`, `Ctrl`/`Cmd+Shift+Z`, and `Ctrl`/`Cmd+Y` operate on the
  same local-only board history.
- Static renderer previews are safety-bounded, but the full collaborative source
  remains intact and editable.

### Python block

- Code creation produces a blank 360 x 240 Python/browser block. There is no
  language selector and no JavaScript execution option.
- Run is explicit. Remote edits never execute code.
- A source snapshot is taken when Run is pressed; only one run is active.
- Exact-pinned Pyodide 0.27.5 is loaded from Eduri's versioned same-origin
  `/vendor/pyodide/0.27.5/` assets in a new dedicated worker for every run.
  There is no warm interpreter shared by consecutive runs; browser HTTP caching
  may reduce loading cost, while first uncached use requires the Eduri origin.
- The run captures stdout, stderr, and expression result. Output is capped at
  256 KiB of characters with an explicit truncation marker.
- Client and worker use tagged protocol-v4 messages from the versioned
  `/python-runner.worker.js?protocol=4&revision=2` source: one request, bounded
  streamed output,
  and one terminal response. A Board code-block request is the protocol's
  script variant and never accepts interactive workspace input buffers or a
  workspace file delta. The client terminates the worker after a result,
  runtime/worker/protocol error, cancellation, or 45-second timeout. Read-only
  transition, document change, and unmount cancel the run; the worker also
  closes itself after its terminal response.
- The source and hash-verified runtime assets are passed to a disposable Worker
  created inside an opaque-origin `sandbox="allow-scripts"` iframe. The iframe
  cannot read application DOM or origin storage, its CSP permits no network,
  and its strict broker exposes no privileged parent API. Runtime network,
  storage, cross-tab, and nested-worker capabilities are also removed after
  the pinned runtime loads as defense in depth; failure to remove a known
  capability aborts the run. Python receives a frozen empty `jsglobals` object.
- The resulting output snapshot is a durable, undoable property update. Static
  code blocks currently render source rather than the output snapshot.

### LaTeX block

- Creation produces a 260 x 110 object initialized with `\frac{a}{b}`.
- The current editor is raw collaborative source in a textarea.
- Rendered KaTeX and a snippet engine are not implemented yet.

Code/LaTeX placement centers the object on the captured canvas click. It never
upscales the nominal 360 x 240 or 260 x 110 size and may downscale it against
the captured viewport with up to a 16 px fitting margin. It does not search for
a low-overlap automatic location; the user's click is authoritative.

## Images and asset states

- The picker and clipboard accept PNG, JPEG, WebP, and GIF. Clipboard Paste
  inserts the first supported image representation; Board Fragment data still
  has higher priority.
- Empty, unsupported, oversized, undecodable, or locally unpersistable files
  create no board object.
- Client guards: original file up to 128 MiB, decoded edge up to 16,384 pixels,
  decoded image up to 100,000,000 pixels.
- The byte-size guard runs before decode. The shared DOM-free inspector reads at
  most the first 1 MiB, rejects SVG/unknown or malformed headers, extracts
  encoded dimensions, and rejects a non-empty declared MIME which disagrees
  with the PNG/JPEG/WebP/GIF signature. Browser-decoded dimensions must match
  the encoded header; a width/height transpose from EXIF quarter-turn
  orientation is accepted. If an exposed `createImageBitmap` decoder rejects a
  format variant which the browser image element supports, decode automatically
  falls back to `HTMLImageElement` before reporting failure.
- The original blob and upload state are durably committed to IndexedDB before
  the CRDT image object is created.
- Only after that object commit does the client make the new image the sole
  selection. Clipboard insertion also activates Select; Image-tool insertion
  deliberately keeps Image active. Failure, picker cancel,
  document/access/history invalidation, or unmount before commit preserves the
  preceding tool and selection.
- The object stores immutable asset ID, SHA-256 identity, MIME, pixel dimensions,
  and original byte count.
- Initial display preserves aspect ratio, caps the largest dimension at 720
  logical units, keeps each dimension at least 40, and may downscale further to
  fit the viewport.
- A local object URL renders immediately. Otherwise a stable syncing placeholder
  remains until validated publication/cache state refreshes the node in place.
  Decode failure renders an unavailable placeholder.
- Upload uses resumable hashed chunks and durable acknowledged offsets.
  Transient failures retry automatically with jittered exponential backoff and
  wake on `online`; an expired server session restarts without losing local
  bytes. There is no routine Retry button.
- Permanent/access failures become blocked and expose recovery state when a
  local original still exists.
- Deleting an image object does not garbage-collect the stored asset because
  undo and offline replicas may still reference it.

## Undo and redo

Undo tracks only the stable local device origin. It does not rewind remote,
server, migration, or rank-normalization work. Undo/redo themselves emit normal
collaborative updates.

One undo item is created for each:

- completed object or freehand stroke;
- complete object/group drag or transform;
- eraser pending set committed on pointer-up;
- atomic delete batch;
- paste or duplicate;
- one layer command;
- one discrete multi-object style patch;
- one full continuous style slider gesture;
- one code output write;
- one held arrow-key nudge gesture.

Text typing uses a roughly 450 ms grouping window with focus, tool, and IME
boundaries.

A still-empty provisional Text editor is outside history. Its first value
containing a non-whitespace character is stored inside the object-add command,
so undoing that creation removes the object and closes its editor rather than
leaving either an empty textbox or a hidden editing state. Later typing uses the
ordinary grouping window.

Keyboard Undo/Redo first clears active nudge keys, cancels the active renderer
interaction, and ends its gesture before changing history. This protects an
uncommitted eraser, drawing, marquee, lasso, or temporary laser session. A
laser session has no history item of its own. Toolbar Undo/Redo do not perform
that explicit pre-cancellation.

## Keyboard reference

### Standalone `Alt`

- Pressing either physical `Alt` key while focus is on the board surface,
  canvas, toolbar button, or context-menu button suppresses the browser's
  default action on both `keydown` and key repeat.
- The matching `keyup` is also suppressed if focus moves outside the board
  while the key is held. A key press which starts outside the board is never
  claimed, even if its release occurs over the board.
- Browser-window blur clears the remembered key without trying to block
  operating-system actions such as `Alt+Tab`. Unmounting the board does the
  same.
- `input`, `textarea`, `select`, and `contenteditable` targets retain native
  `Alt`/Option input. `AltGraph` is not treated as standalone `Alt`.
- Only the event for the `Alt` key itself is consumed. `Alt+Enter`,
  `Alt`-modified arrows, digits, and all other key events keep their documented
  behavior. Pointer and compatibility-mouse events still expose the physical
  `altKey`, including the Select tool's lasso choice at pointer-down and the
  eraser's restore mode.
- Consuming the standalone `Alt` key event by itself changes no tool, selection,
  camera, object, CRDT update, awareness value, or undo/redo item. A subsequent
  Select pointer gesture carrying `altKey` still starts the documented lasso.

### Tools

| Key | Tool |
| --- | --- |
| `V` or `1` | Select; repeated while Select is active enters Hand |
| `H` | Hand |
| `P` or `2` | Drawing |
| `E` or `3` | Eraser |
| `T` or `4` | Text |
| `L` or `5` | Line |
| `A` or `6` | Arrow |
| `R` or `7` | Shape; concrete kind comes from the inline tool setting |

Numeric aliases accept the top number row and the NumPad while Num Lock is on.
They use the same no-modifier, no-repeat, focus, editor, read-only, awareness,
selection, cancellation, and undo-boundary rules as the corresponding letter
shortcuts. In particular, repeated `1` has the same Select/Hand toggle behavior
as repeated `V`. NumPad navigation with Num Lock off is not intercepted.
`Ctrl`/`Cmd+1` sets 100% zoom and `Ctrl`/`Cmd+0` fits content before numeric
tool lookup; `Ctrl`/`Cmd+2` through `9` are left to the browser. Plain `8`, `9`,
and `0`, and the former shape-specific `O`, `D`, and `F` aliases, are not
intercepted. Toolbar reordering, visibility, overflow placement, and the
selected concrete shape never change this table.

### Selection and editing

| Command | Result |
| --- | --- |
| `Ctrl`/`Cmd+A` | Select all mutable objects |
| Click mutable object | Select it alone, or preserve its already-selected group |
| `Shift`+click mutable object | Toggle that one object |
| Drag empty canvas | Replace selection with objects fully contained by the rectangular marquee |
| Hold `Shift` during rectangular marquee | Use inclusive any-intersection while held; pressing/releasing it updates live candidates and the final predicate |
| `Alt`+drag | Ignore object hits and replace selection with objects touched by the freeform lasso; lasso is always inclusive any-intersection |
| Hold `Shift` at marquee/lasso pointer-down | Add the area's matches to the captured pointer-down selection for the complete gesture, even if `Shift` is later released |
| Hold `Ctrl`/`Cmd` before pointer-down | Ignore object/Transformer hits and begin an ordinary area gesture; the initial hold does not move it |
| Press `Ctrl`/`Cmd` during marquee/lasso | Move the unfinished area; an initial hold must first be released and pressed again |
| Hold `Shift` while dragging the rotation handle | Snap the shown angle to 45-degree increments on movement; release for smooth rotation |
| Arrow | Move selection 1 logical unit |
| `Shift`+Arrow | Move selection 10 logical units |
| `Delete` or `Backspace` | Delete selected Line anchor in point editing; otherwise delete selection |
| `Ctrl`/`Cmd+C` | Copy selection through the native copy event |
| `Ctrl`/`Cmd+X` | Cut selection through the native cut event |
| `Ctrl`/`Cmd+V` | Paste an Eduri fragment, image, or plain text through the native paste event |
| `Ctrl`/`Cmd+D` | Duplicate selection |
| `Context Menu` or `Shift+F10` | Open the canvas/object context menu at viewport center |
| `Enter` | Edit one selected text/code/LaTeX object or enter Line/Arrow point editing |
| `Escape` | Exit Line/Arrow point editing; otherwise cancel gesture, close text editing, clear selection, or return Select |

`Enter` is blocked by `Ctrl`/`Cmd` or `Alt`; `Shift` does not block it. Arrow
nudge is blocked by `Ctrl`/`Cmd` or `Alt`.

### History and layers

| Command | Result |
| --- | --- |
| `Ctrl`/`Cmd+Z` | Undo |
| `Ctrl`/`Cmd+Shift+Z` | Redo |
| `Ctrl`/`Cmd+Y` | Redo |
| `Ctrl`/`Cmd+]` | Forward one layer step |
| `Ctrl`/`Cmd+Shift+]` | Bring to front |
| `Ctrl`/`Cmd+[` | Backward one layer step |
| `Ctrl`/`Cmd+Shift+[` | Send to back |

### Camera

| Command | Result |
| --- | --- |
| Hold Space before primary drag | Temporary pan |
| Middle-button drag | Pan |
| Right-button drag past 4 CSS pixels | Pan; suppress that drag's context menu |
| Wheel/trackpad | Pan |
| `Ctrl`/`Cmd+wheel` | Zoom around pointer |
| `Ctrl`/`Cmd+=` or numpad `+` | Zoom x1.1 around viewport center |
| `Ctrl`/`Cmd+-` or numpad `-` | Zoom /1.1 around viewport center |
| `Ctrl`/`Cmd+1` | Set 100% around viewport center |
| `Ctrl`/`Cmd+0` | Fit all content |
| `Home` key | Fit all content |

The keyboard `Home` command is deliberately different from the two-state Home
toolbar button. On an empty board, fit-content centers world origin and uses
100%. With content it uses 64 px viewport padding.

### `Escape` precedence

Toolbar configuration and Drawing palette configuration are handled before the
ordinary board stack. Toolbar configuration closes its modal and restores the
overflow trigger. Drawing palette configuration handles active palette reorder,
then open preset popup, then configuration mode, as detailed above. Once none
of those states is present, an open context menu consumes `Escape` first,
closes itself, restores board focus, and preserves selection and tool.
Otherwise the board requests gesture cancellation and ends nudge capture first.
For a text editor, its own `Escape` closes editing, clears the local selection,
and restores board focus in one action. A following numeric shortcut therefore
switches tools without a toolbar click. Other cases close one higher-level
state: current code/LaTeX editor, otherwise current selection, otherwise a
non-Select tool; those nested states can require multiple presses.

## Presence and collaboration chrome

- The active `/room/:shareId/:resourceKind` and `/lesson/:id` headers show one
  `Профиль` icon button immediately before the site-theme button. Its small
  swatch shows the current collaboration color. Public solo `/board` and
  `/code`, room loading/error/ended screens, and other non-session site chrome
  do not show this action. A guest page does not enter profile-required state
  until both the active room and requested resource resolve; an empty room or
  unknown resource path stays on its missing/ended surface without a profile
  modal.
- Entering an online guest room or authenticated lesson without a valid saved
  profile opens `Профиль` as an initial, dismissible suggestion. The guest
  default name is `Гость`; a lesson uses the authenticated account display name
  when it is valid; the initial color is `#2563eb`. The default name appears as
  phantom placeholder text in the initially empty `Display Name` field, so a
  person can type immediately without first deleting it. Until a profile is
  saved, Board, Code, and Call use that normalized default and color for the
  current online session without writing browser storage. Close, Cancel,
  `Escape`, and backdrop dismissal all keep this temporary profile and leave
  the room usable. Opening it later from the header edits the saved profile or
  offers the same suggestion again.
- The form contains a `Display Name` field, live initial/avatar preview, and the
  complete in-app Board color picker. The picker offers arbitrary opaque sRGB
  through its saturation/value plane, hue rail, keyboard axes, and lazy
  advanced formats; it never opens a native `input[type=color]` dialog. Saving
  requires a non-empty normalized single-line name of at most 60 Unicode
  characters and 240 UTF-8 bytes without control or bidi-formatting characters,
  plus a canonical lowercase six-digit `#rrggbb` color.
- `Display Name` receives initial focus and the shared modal traps `Tab` within
  its controls. Closing it through Close, Cancel, `Escape`, or the backdrop
  restores the previously focused control. The profile backdrop is intentionally
  lighter than ordinary modals. At viewport width
  760 px and below the same modal is a bottom-aligned full-width sheet with
  bounded internal scrolling; its data and dismissal rules do not change.
- One device-local profile is shared by every online guest room and lesson on
  the origin. It uses the strict exact-key envelope
  `{"version":1,"displayName":"...","color":"#rrggbb"}` under
  `eduri-online-profile-v1`; malformed, noncanonical, extra-field, or
  wrong-version values are rejected. Storage events, page-show, and visible-page
  reconciliation adopt changes from another tab. A valid external profile
  replaces the current value and closes any open editor so a stale form cannot
  overwrite it. Removing/clearing the key removes configuration; an active
  online surface immediately converts an open ordinary editor to required mode
  or opens the required modal and unmounts its Board/Code/Call providers until a
  valid profile is saved again. If localStorage is blocked or throws, the
  current tab keeps an in-memory profile instead of blocking the online
  workspace.
- Saving another name or color sends a bounded, server-validated profile update
  over the existing Board and Code connections. It does not disconnect or
  reconnect their transport, change the Board awareness client ID, or remount
  or replace the Board/Code Y.Doc, Monaco, camera, selection, local persistence,
  or durable outbox. A newly issued guest or lesson Call token uses the current
  profile. If the participant is already connected, the authenticated server
  updates that participant's LiveKit name and color in place; the client does
  not replace the token, room, component, or media tracks.
- Rapid Board changes keep one correlated request in flight and only the latest
  still-desired value pending; returning to the in-flight value cancels that
  pending change. A real Board reconnect resends the latest unconfirmed value
  with a fresh correlation ID. Code sends every distinct connected save in
  Socket.IO order and uses only the latest handshake auth while disconnected.
  Call serializes its PATCH requests and coalesces values changed while one is in
  flight to the latest desired profile. Board/Code rejection and Call PATCH
  failure leave the device-local profile saved, keep every collaboration/media
  surface mounted, and expose the relevant provider/media error; they do not
  falsely present the remote participant update as accepted.
- Local cursor and live gesture updates are coalesced to animation frames, then
  network awareness is rate-limited to roughly one packet per 40 ms.
- Remote cursor motion interpolates over 72 ms and uses a compact asymmetric
  navigation wedge with a precise hotspot, no stem or tail, and the
  authenticated participant color. Its outline contrasts with the viewer's
  current board theme and scales with the pointer, while the idle name label chooses light or dark
  text from the participant color's relative luminance. A jump above 600 screen
  pixels is shown immediately. The pointer lives in board space: its effective
  screen scale is `viewerZoom / senderZoom`, so zooming the local camera out
  shrinks remote pointers together with board content and zooming in enlarges
  them. The authenticated display-name label remains constant screen size and is hidden on
  first appearance and immediately after every position change; it appears
  only after that cursor has remained stationary for 5 seconds. A remote live
  gesture or laser is already visible as its own preview, adds no redundant
  cursor ornament, and keeps the name hidden. Label timing is renderer-local and never adds an
  awareness field or network update. Camera changes reuse the existing bounded
  awareness viewport: a participant zooming out enlarges only their pointer,
  while zooming in makes it smaller relative to board space. Pointer scale is
  exactly the inverse of sender zoom with no additional cursor-size limits across the supported
  2%-2000% board zoom range; the name label stays readable at a constant screen
  size.
- Remote selections outline visible selected objects. Presence selection is
  capped at 256 IDs and is not the participant's complete local selection.
- In-progress freehand/shapes and Drawing's temporary laser session are
  ephemeral awareness, never document content or undo history. Laser awareness
  is a bounded rolling packet of separately styled stroke tails rather than one
  connected polyline. Stream IDs and point offsets let peers accumulate the
  complete visible gesture while packet size remains fixed. Retained strokes
  stay visible to peers while the sender continues holding `Alt`, then fade
  together after release; cancellation removes them immediately.
- Multiple devices for one user remain separate presence client IDs.
- The server validates profile fields at Board-ticket or Code-handshake
  admission, binds them to the connection, and overwrites identity, display
  name, role, and color authoritatively. Awareness payloads can never choose or
  spoof those fields.
- The participant strip displays the first four participant initials. It has no
  overflow counter; all accepted presences still render on the canvas.
- Remote active tool is transported but currently has no visible badge.

## Offline, synchronization, and read-only

### Status

- Fully synced state is silent.
- Local-cache loading, connecting, and pending-upload messages wait 900 ms to
  avoid flashing during a quick start/sync.
- Offline, recovery, and storage warnings appear immediately.
- Offline text explicitly says work can continue and includes the pending update
  count when present.
- Asset/storage risk takes priority over connection text. An insert/clipboard
  error takes still higher visual priority and has a close button.
- There is no separate generic badge when read-only is caused only by missing
  edit permission.

### Offline

Offline alone leaves ordinary drawing, object/style/text changes, local
clipboard, undo, and local-first image insertion available. Updates and assets
queue locally and synchronize automatically after reconnect. There is no manual
Save or reconnect command.

The browser unload prompt is used only during the brief interval in which a
local update is still being durably queued, not merely because the board is
offline or has pending server sync.

### Public solo board

- `/board` uses the same Board v2 surface and hydrates its document from a
  deterministic guest-solo IndexedDB namespace. Ordinary solo work starts no
  network provider and survives a reload on the same browser profile.
- `Начать сеанс` in the solo header establishes an immutable edit boundary,
  temporarily makes the surface read-only, flushes the current chronological
  update-v1 log, creates a guest room with a Board resource, and replays each
  bounded update through the ordinary granular Board provider. An in-memory
  solo document with no durable store may use one aggregate update only while
  it fits the per-update protocol limit; an oversized aggregate fails before a
  room is created. Promotion also copies every available local image blob into
  the new room's asset outbox without changing its asset ID or content hash.
  Navigation to the room occurs only after the provider is online, its update
  outbox has received durable acknowledgements, local persistence is ready,
  every copied image is published, and the server initialization draft is
  finalized. A failure before finalization is prepared restores editable solo
  mode and leaves the original solo document and asset store unchanged; the
  server draft is cancelled and partially created guest-device databases are
  cleared. A structured API failure shows the server's specific message;
  unexpected transport/runtime failures use the generic connection message.
  Immediately before the first finalize request, bounded same-origin
  recovery metadata records the draft capability. An ambiguous response after
  that point preserves the guest databases and draft instead of cancelling
  them; the next Start session action retries the idempotent finalize for the
  same room before creating any new draft. Recovery is stored per draft and
  exact-cleared, so concurrent tabs cannot overwrite or remove one another's
  attempts. It remains present while post-finalize local resources close and
  is cleared only after a final cancellation check. An invalid, missing, or
  expired recovery response (`400`, `404`, or `410`) clears only that attempt
  and continues with another pending attempt or a fresh draft; network and
  `5xx` failures preserve it.
- If the document database cannot be opened, the empty or partially hydrated
  in-memory document remains editable. A persistent warning says that changes
  remain only in the current tab. The failed store is detached so later input
  does not keep retrying a rejected write queue.
- Solo image insertion uses the ordinary PNG/JPEG/WebP/GIF byte, header,
  decoded-dimension, and pixel guards. The immutable original blob, SHA-256
  identity, MIME, dimensions, and outbox-compatible local record are committed
  to IndexedDB before the image object is added. Reload resolves the image from
  that durable local blob; solo mode does not start an upload coordinator.
- Image is available only when both the document log and asset database are
  durable. If only asset storage fails, the rest of the board stays durable and
  editable, Image is disabled, and the existing image-storage warning is shown.
  If document storage fails, Image is likewise disabled because a durable blob
  without a durable referencing object would not make the insertion safe.

### Public Code workspaces

- The guest-room header action is labelled `Ссылка`. It copies the current
  resource URL to the system clipboard; after a successful write its label and
  icon change to `Скопирована` for 1.5 seconds, then return to `Ссылка`. A
  failed write keeps the ordinary label and shows the existing copy error.
- `/code` owns a durable solo Yjs document and content-addressed local binary
  cache. Its Explorer is a hierarchical tree. Every folder keeps the same
  folder icon when opened or closed. A non-empty folder is the only kind that
  shows a disclosure chevron or `aria-expanded`; clicking it or pressing
  `ArrowLeft`/`ArrowRight` collapses or expands it. An empty folder has no
  disclosure state or disclosure-key behavior, but remains a valid create,
  upload, and drop destination.
- The file opened in the editor is separate from Explorer's device-local
  selection, keyboard focus, and Shift anchor. Selection/focus/anchor and
  folder expansion are not CRDT content, awareness, or undo items. The tree is
  `aria-multiselectable`; every selected row exposes `aria-selected`, exactly
  one visible row has the roving `tabIndex=0`, and opened-file and selected-row
  styling remain distinct. Changing or clearing a selection through a modifier
  or keyboard selection command does not implicitly replace the opened entry;
  ordinary activation still opens a file or the folder-action surface.
- A plain row click replaces selection and activates that entry. `Shift+click`
  replaces selection with the inclusive range from the fixed anchor to the
  clicked row. `Ctrl`/`Cmd+click` toggles only the clicked row and resets the
  anchor to it. `Ctrl`/`Cmd+Shift+click` adds the inclusive anchor range to the
  existing set. All ranges use the currently visible flattened depth-first
  tree order. Clicking the Explorer background clears selection. Collapsing a
  folder immediately removes its now-hidden descendants from selection and
  resolves focus/anchor to the closest visible row; hidden destructive
  selections are never retained.
- `ArrowUp`/`ArrowDown` move one visible row and `Home`/`End` move to the first
  or last visible row. With `Shift` they replace selection with the anchor
  range; with `Ctrl`/`Cmd+Shift` they add that range; with only `Ctrl`/`Cmd`
  they move keyboard focus without changing selection. `ArrowRight` expands a
  collapsed non-empty folder, otherwise moves to its first visible child;
  `ArrowLeft` collapses an expanded non-empty folder, otherwise moves to its
  parent. The same Shift and command-modifier selection rules apply when a
  hierarchy key moves to another row.
- `Enter` activates the focused entry. Space toggles that row in selection.
  `F2` starts rename only when the focused row is the sole selected entry.
  `Ctrl`/`Cmd+A` selects every visible row, `Escape` clears selection, and
  Delete/Backspace deletes the complete deletable selection. Explorer-local
  `Ctrl`/`Cmd+Z`, `Ctrl`/`Cmd+Shift+Z`, and `Ctrl`/`Cmd+Y` retain the documented
  local-only tree history behavior.
- Plainly activating any folder, including an empty one, shows an in-workspace folder
  action surface instead of a blank editor. Its only visible actions are
  `Прикрепить файл`, `Создать файл`, and `Создать папку`, all targeting that
  folder and all disabled in read-only mode.
- The Explorer header contains only the `Проводник` title: it has no ellipsis
  or dedicated delete button. Right-click opens the custom action menu; on a
  row it exposes that selection's actions, while right-clicking the Explorer
  background exposes root create/upload actions. `Shift+F10` and the Context
  Menu key provide the same row menu from the keyboard. Right-clicking a
  selected row preserves the complete group while moving keyboard focus to
  that row; right-clicking an unselected row replaces selection with that row.
  Rename and duplicate are omitted for a multi-selection. Create file/folder,
  upload, singular rename/duplicate, and group delete live in this menu rather
  than the editor toolbar. Duplicate creates a collision-free sibling text or
  binary file with the same content; an immutable binary identity may be
  referenced by both files.
- Starting a drag on a selected row drags all selected visible roots together;
  starting on an unselected row first makes it the sole selection. A group can
  be dropped on a folder or the Explorer background to move it into that folder
  or to the root. File rows do not act as implicit root drop targets, and a
  selected entry or any destination inside a selected subtree rejects the drop.
  Redundant descendants whose ancestor is already selected are normalized out
  before the move.
- Group move and group delete validate every requested entry, destination,
  collision, cycle, depth/path bound, and required-file constraint before
  mutating the document. The accepted group commits in one local-origin Yjs
  transaction and is one Undo item; any failure leaves the complete group
  unchanged. Delete expands selected folders through their complete effective
  subtrees, including collapsed descendants, and normalizes redundant
  ancestor/descendant selections. `main.py` cannot be deleted, and any ancestor
  folder containing it protects the whole selection from deletion, including
  after `main.py` is moved. Tests attached to deleted files are removed in that
  same transaction and Undo item. Duplicate copies file contents but deliberately
  starts with no copied tests. No destination dropdown is used.
- Named tests belong to the currently active Python file, using its stable entry
  ID rather than its name or path. Rename and move therefore preserve its test
  set. Switching between Python files immediately replaces the visible tabs,
  count, active test form, and displayed result with that file's own state,
  without remounting the main Monaco editor or terminal. A valid concurrently
  merged test whose target was already deleted remains preserved but hidden and
  cannot execute. Legacy tests without a target are treated as tests of
  `main.py`.
- Tests are closed by default behind the `Тесты` toolbar toggle. The toggle and
  idle `F9` action exist only for a text file whose current name ends in `.py`
  case-insensitively. Opening
  the panel exposes stdin, expected output, a bounded-width name field visibly
  labelled `Title:`, and a compact `250..45000` ms field visibly labelled
  `Timeout:` without increment/decrement steppers. Output always uses
  normalized line comparison: Windows/Linux line endings and one final newline
  do not affect the result. When a workspace has no tests, the panel shows only
  the `Создать тест` action; selecting it creates the first test and opens the
  normal test form. Every test, including the only test, has a delete action;
  deleting the last test returns to the `Создать тест` state. New and legacy
  tests default to 5,000 ms. Test uses its stored deterministic stdin and
  timeout and never opens the live terminal prompt. Switching or renaming to a
  folder, binary file, or non-Python text file closes the test panel and removes
  both Python actions from the toolbar. An already-running shared process keeps
  its `Stop` action visible until it finishes, even if another file is selected.
  Plain F9 in a non-Python file is not captured. The initiating client
  revalidates the current `.py` name after synchronization, and the shared
  execution host rejects a stale or forged Run/Test action whose entry is no
  longer a text `.py` file or whose test ID belongs to another entry.
- The main Monaco model's language follows the current filename rather than
  stable entry ID. Renaming `main.py` to `main.txt` changes that same mounted
  model to `plaintext` immediately and removes Python highlighting; `.md`,
  `.json`, `.js`, `.ts`, and other recognized extensions use their matching
  Monaco language without becoming runnable Python. Renaming the stable entry
  back to `.py` restores Python highlighting, Run, and its existing tests.
- The test-name tabs remain one stable horizontal row regardless of test count.
  Every tab and the add action retain fixed width behavior, while overflow uses
  a visible thin horizontal scrollbar with touchpad, wheel/Shift-wheel, drag,
  and touch scrolling instead of wrapping or widening the sidebar. The stdin
  and expected-output Monaco fields are each 86 px tall rather than expanding
  to consume the remaining sidebar height; the enclosing test panel remains
  vertically scrollable on short layouts. Test tabs, metadata, labels, action
  text, and the two Monaco fields use the larger test-panel typography.
- The Explorer/editor boundary, editor/terminal boundary, and (while tests are
  open) tests/terminal boundary are eight-pixel drag targets with a centered
  one-pixel line; coarse pointers receive a wider transparent hit area. Mouse,
  pen, and touch resize the adjacent panels without
  remounting Monaco, xterm, or the Explorer. The layout switches the Explorer
  split from columns to rows at a measured workspace width of 620 px, and the
  tests split from columns to rows when its measured console area is narrower
  than 700 px; these decisions use the actual container rather than viewport
  media queries.
- Every resize handle is a focusable ARIA separator. Directional arrow keys
  move it by 10 px, `Shift` plus the matching arrow moves it by 40 px,
  `Home`/`End` select its live bounds, and `Enter`, `Space`, or double-click
  restores that split's default. Pointer cancel, focus-window loss, or unmount
  rolls an unfinished drag back; a completed drag and keyboard changes persist
  under the strict device-local `eduri-code-workspace-layout-v1` record. Panel
  sizes are presentation preferences only and are not part of lesson CRDT or
  awareness synchronization.
- Python runs only after an explicit shared F9/Test or terminal command. One
  authorized browser host executes each server-assigned run; every participant
  sees the same ordered run state, prompt, output, program input, and test
  result. A shell `py main.py`/`python main.py` command uses a fresh disposable
  terminal Worker and a synchronized workspace snapshot. Bare `py` opens an
  interactive Python prompt which persists only until exit/EOF/stop/session
  loss. Ordinary F9 Run uses the 45-second client ceiling. The idle run button
  is labelled `F9`; clicking it or pressing plain, non-repeating `F9` anywhere
  inside the Code workspace starts the same ordinary shared run. The shortcut
  is captured before Monaco and xterm, requires no `Ctrl`/`Cmd`, `Alt`, or
  `Shift`, and leaves modified F9 events available to their focused control.
  While a run is active the button is labelled `Stop`; clicking it interrupts
  that shared run. F9 never stops or restarts an active run. F9 auto-repeat and
  further F9 presses while a start request is pending or execution is active
  are consumed without an action. F9 and Test are also disabled while the
  initiating client waits for its document outbox and the first authoritative
  terminal state, so repeated or cross-button actions cannot enqueue competing
  starts. After completion or stop, the button returns to `F9`.
- The terminal is an xterm surface with its editable command buffer on the
  active terminal row; there is no detached HTML input. It accepts the bounded
  virtual-workspace commands `help`, `pwd`, `ls`/`dir`, `cat`/`type`,
  `clear`/`cls`, and `py`/`python`. It is deliberately not an OS/server shell.
  A new shared terminal starts with the single hint `help для списка команд`.
  The terminal header never shows a persistent input-owner name. The active
  xterm caret remains visible in its authenticated owner's color. For a remote
  owner, the name label is collapsed by default and appears only while a
  hover-capable pointer is inside the transparent 18-pixel geometric hit area
  around the current terminal caret; pointer exit hides it, and touch or other
  no-hover input does not reveal it. That hit area and its absolutely positioned
  label do not intercept pointer events, focus, selection, or terminal input and
  never change the xterm buffer or layout. Their position follows the public
  xterm buffer cursor through parse, render, resize, and scroll updates, and the
  complete cursor label overlay hides while that buffer position is outside the
  rendered viewport.
  When Python calls `input()`, the same row becomes the program input. UI input
  is limited to 1,024 UTF-16 code units without control characters; the runner
  additionally enforces 64 KiB per line, 1 MiB total, and a bounded request
  count. Output is bounded, batched, and shown in exact server order before the
  next prompt. Offline source edits remain available, but shared terminal input
  and Run/Test are disabled until the collaboration transport is online.
  `Ctrl+C` stops a shell program; inside bare-`py` it clears an idle or active
  Python block, reports `KeyboardInterrupt`, and returns to `>>>` without
  destroying the shared REPL. `Ctrl+D` supplies program EOF or exits the REPL.
- Run captures stable directory paths and, for every file, its stable ID,
  exact path, content kind, SHA-256, byte size, and bytes. The disposable
  Worker returns a bounded, strictly ordered file delta after success and after
  an ordinary Python runtime error. Test never applies that delta.
- A Run write/delete is accepted only while the stable ID, exact path, content
  kind, and content still match the captured baseline; a new path also requires
  an unchanged compatible parent topology. Binary bytes are durably published
  before any CRDT mutation and every condition is checked again afterward.
  Cancellation, read-only/session change, unmount, or a late conflict opens no
  transaction. Accepted paths commit together through stable-ID core commands
  in one local-origin Yjs transaction; an existing text-to-text write retains
  its collaborative `Y.Text`, and `main.py` deletion is blocked. Conflicting
  paths are skipped and listed in a partial-result warning without overwriting
  unrelated concurrent work.
- `Начать сеанс` is disabled until the solo session has hydrated. Activating it
  makes the complete Code workspace read-only, flushes and validates the solo
  document, verifies every referenced local binary before room creation, and
  promotes folders, text files, binary identities and bytes, and named tests
  over the ordinary guest Code sync/blob transports. The server-created
  `main.py` is replaced atomically rather than merged with the solo file.
  Navigation occurs only after every blob is remotely finalized and the Code
  update has a durable server ACK and the server initialization draft is
  finalized. Failure or cancellation before finalize leaves solo state intact,
  cancels the server draft, clears partial guest-local databases, restores
  editing, and keeps the user on `/code` with a dismissible error for
  non-cancellation failures. A structured API failure shows the server's
  specific message; unexpected transport/runtime failures use the generic
  connection message. Immediately before finalize, the draft capability
  is persisted as bounded same-origin recovery metadata. Once finalize has
  been attempted, an ambiguous network response preserves the guest databases
  and draft; the next Start session action retries that same idempotent
  finalize before creating another room. Each draft has an independent record
  which only an exact matching completion may clear. The record remains while
  the guest provider and blob cache close and until the final cancellation
  check passes. An invalid, missing, or expired response (`400`, `404`, or
  `410`) clears only that attempt and continues with another pending attempt or
  a fresh draft, while network and `5xx` failures remain recoverable.
- `/room/:shareId/code` uses the same editor over the guest Code provider.
  Local edits enter an atomic IndexedDB update log/outbox before network send.
  Offline and reconnect require no Save or Retry action. The small cloud badge
  is part of the editor's top toolbar, so it never overlays Explorer, Monaco,
  tests, or the terminal. The badge itself is one small, muted cloud without a
  pending counter, spinner, or green/blue state-color transition; connection
  detail belongs inside its popup so ordinary synchronization does not attract
  attention. The online popup heading reads `Синхронизация` and
  `Изменения синхронизированы`. Its compact body uses an icon rather than the
  visible word `Соединение`, followed by the connection value. A queued ACK row
  exists only when the count is nonzero, and the provider error appears only
  when present. It has no `Локальные данные`, `Редактор`, or `Общий терминал`
  rows.
  Hover opens the popup only while a hover-capable pointer remains on the cloud
  trigger itself. The hover popup has no pointer hit area: entering the popup's
  painted rectangle cannot keep it open. Clicking the cloud with mouse, pen, or
  touch pins the popup; clicking the cloud again, pressing outside both cloud
  and popup, blur, or `Escape` closes it. A press inside a pinned popup does not
  close it. Keyboard focus provides the equivalent accessible transient view.
  Status changes update the same mounted cloud and open popup without moving
  the toolbar or flashing.
  The popup chooses the side with useful room inside the workspace/viewport and
  scrolls within its bounded height, so a short viewport or long provider error
  cannot clip it behind the workspace's overflow boundary.
  The bounded popup itself is the next keyboard focus stop, so its overflow can
  be scrolled with Arrow/Page/Home/End without a pointer; `Escape` closes it and
  restores badge focus.
  The lesson Code adapter uses the same indicator. A local persistence failure
  is shown immediately in the popup and makes the shared editor read-only so
  later edits cannot be presented as durable.
- Monaco is bound directly to the active collaborative `Y.Text`; remote deltas
  patch only changed model ranges and do not replace its entire controlled
  value, remount Monaco, reset scroll/selection, or repaint all syntax tokens.
  Standard `Alt` multi-cursor editing is preserved. For the focused main editor
  or test stdin/expected-output editor, awareness sends Monaco's primary
  selection first and every secondary selection after it, capped at 32. Anchor
  and head preserve forward/backward direction. Each remote non-empty selection
  is a tracked decoration and each selection head is a zero-width content
  widget in the authenticated participant color, even when multiple carets
  overlap. A whole-line selection ends at the ordinary next-line column-one
  boundary and is painted only over Monaco's finite text-range geometry; it
  never extends to the editor, viewport, or page edge. No `|` character enters
  the model or inline text layout. Test name/timeout and Explorer rename show an
  input-specific overlay caret/selection for every valid remote participant in
  stable participant order over each bounded remote draft, without changing
  the local input value or layout. Every remote caret line and selection stays
  visible. Each caret's authenticated participant-name label is absolutely
  positioned and hidden by default; it appears only while a hover-capable
  pointer is inside that caret's 18-pixel geometric hover area, then hides again
  when the pointer leaves. Hover is calculated from pointer coordinates received
  by the underlying Monaco or native input; the complete remote caret, selection,
  hit-area, and label overlay remains `pointer-events: none`. Pointer down, click,
  text selection, context-menu, and focus therefore pass through to the real
  editor/input even directly over a remote caret. The label never changes the
  Monaco or native-input value, text layout, scroll, or selection. Touch and
  other no-hover input do not reveal cursor labels.
  Focus/blur/unmount clears only presence owned by that exact field.
- Cursor/selection/focused-field data is awareness-only. Terminal prompt,
  input, output, run and test lifecycle instead use an ordered ephemeral shared
  terminal state with server leases, deltas, ACKs and gap recovery. Participant
  identity, name, and color are supplied authoritatively by the server.
  Receiving any remote document, presence, or terminal state never executes
  code unless this client is explicitly elected as the run host. Unacknowledged
  actions retry with the same idempotency key; reconnect invalidates every old
  browser execution even when offline/online transitions are visually batched.
- `/lesson/:id` uses this same Code workspace and `/lesson-code-sync` transport,
  not the legacy whole-string writer. The first access imports retained lesson
  code once; scheduled/active lessons are editable, completed/cancelled lessons
  are read-only. Lesson source/tests are durable, terminal history is ephemeral
  once everyone disconnects, and binary uploads/terminal binary writes stay
  unavailable until lesson-scoped blob storage exists.
- Concurrent tree moves are shown through one deterministic effective tree.
  If independently valid edits form a cycle, target a folder deleted by
  another participant, or combine into an over-deep/overlong path, the affected
  edge is rooted consistently on every client; unrelated entries and file
  contents remain present. Local move/add/rename commands still reject cycles
  and changes that would exceed tree bounds, and Delete removes only the
  subtree currently shown in the explorer.
- `Ctrl`/`Cmd+Z`, `Ctrl`/`Cmd+Shift+Z`, and `Ctrl`/`Cmd+Y` in Monaco and while
  Explorer owns focus use a Yjs UndoManager restricted to the local command
  origin; they do not rewind a remote participant's transaction. Each Explorer
  create, upload, duplicate, rename, move, or delete is a discrete history item,
  so undo can restore a deleted file or subtree and redo can remove it again.
  The undo/redo stacks are tab-memory only: reload, unmount, or another loss of
  the current history leaves canonical deletions in place and does not retain a
  separate trash or serialized deleted-file store.
- Guest binary upload first commits the immutable local blob, uploads and
  verifies its capability-scoped remote copy, and only then adds the file
  reference to the shared CRDT. A remote cache miss downloads and verifies the
  SHA-256, byte count, and MIME before use.
- Read-only mode disables tree, editor, upload, test, and Run mutations and
  cancels an active Python worker. An upload which began before the transition
  cannot add a late file reference. This gives solo-to-room promotion a stable
  snapshot boundary.

### Read-only

Read-only is entered when edit permission is absent or the provider requires
recovery. On transition, the board cancels the renderer gesture, closes the
inline editor, terminates Python execution, hides styles, and changes an
incompatible tool to Select.

Available read-only:

- Select, implicit Hand, and Drawing only for its pre-held `Alt` laser
  mode; ordinary Drawing pointer input remains non-mutating;
- numeric `1` follows the same Select/Hand toggle as `V`; `P` or numeric `2`
  selects Drawing for temporary laser use, while numeric `3`-`7` creation
  aliases are ignored rather than consumed;
- device-local toolbar configuration; creation tools remain disabled wherever
  they are placed, while Select and Drawing retain their documented read-only
  behavior;
- camera pan/zoom/fit/Home and theme;
- canvas/object context menus with non-mutating actions and the local grid
  visibility preference;
- selection and `Ctrl`/`Cmd+A`;
- Copy;
- presence and size diagnostics.

Blocked read-only:

- durable Drawing and object/image/code/LaTeX creation;
- move, transform, style, layer, nudge, delete, erase;
- Cut, Paste, Duplicate;
- Undo/Redo;
- Python Run.

### Recovery

When recovery export is available, the warning offers a download button. The
bundle contains the complete current Yjs document plus every still-local asset
blob, board/generation/page/schema identity, reason, and pending count. It is
downloaded as a timestamped `.eduri-board` file.

There is currently no user-facing recovery-bundle import flow. Ordinary board
import/export is also not implemented.

## Size diagnostics

The closed Size button shows an authoritative logical total when available.
Otherwise it shows the best local compact-snapshot plus known server update-log
and asset total; before measurement it says Size.

Opening the popover enables lazy compact snapshot measurement immediately and
then 250 ms after document changes. Server metrics fetch immediately and every
30 seconds only while the provider is online/read-only; failure is silent and
never blocks editing.

The panel reports:

- mutable/retained object count;
- compact CRDT snapshot bytes;
- server update-log row count and bytes;
- asset count and bytes;
- local/remote asset queue count;
- blocked/risky file count;
- logical total;
- physical server bytes when available;
- last server compaction time;
- server measurement time.

Displayed byte units use binary multiples of 1024.

## Lesson call controls

- Local `npm run dev` starts an isolated pinned LiveKit server and configures
  the development API to use it. Local calls retain the same application room
  authorization, two-participant limit, explicit capture controls, and muted
  entry behavior as production; no production media endpoint or credential is
  used.
- Opening or joining a lesson call does not request capture permission and does
  not publish a microphone or camera track. Both controls start disabled on
  every entry and re-entry; each is enabled only by its own explicit button.
- Device settings list microphone, speaker, and camera choices. Opening the
  settings only enumerates already visible browser devices and never turns a
  device on. The refresh button is the explicit permission-bearing action used
  to reveal labels or newly connected devices.
- Selecting a microphone or camera updates LiveKit's active capture default.
  When that track is off, selection does not publish or capture it; the selected
  device is used if the participant later enables the corresponding control.
  Selecting speakers redirects subscribed call audio immediately.
- Selected device IDs are device-local presentation preferences stored under
  `eduri-call-devices-v1`. Media enabled state is never persisted, so saved
  device choices cannot make the next call enter unmuted. Invalid, oversized,
  or unavailable IDs fall back safely to the browser default.
- Speaker selection is disabled and labelled unsupported when the browser does
  not implement `HTMLMediaElement.setSinkId` (notably Safari/iOS). The room is
  still created normally and uses browser-default output in that case.
- Starting screen sharing invokes the browser's protected `getDisplayMedia`
  chooser. The participant selects a tab, window, or monitor there and may opt
  into supported system/tab audio. A site cannot enumerate or preselect those
  sources; cancelling the chooser leaves sharing off. While supported, the
  browser's source-switching control remains available during sharing.
- Device, permission, and picker failures remain dismissible inside the active
  call and do not force a reconnect.

## Theme and responsive behavior

- Initial theme uses the strict saved `eduri-theme-v1` local value, otherwise a
  valid legacy `eduri-board-theme` value is migrated, otherwise the OS
  preference is used. A small inline bootstrap inside the same versioned HTML
  shell applies `data-theme`, `color-scheme`, the root background, and browser
  `theme-color` before CSS or React can paint. It therefore needs no separate
  theme request and stays atomic with both online and offline application-shell
  releases; storage failure falls back without blocking startup.
  Saved preference changes synchronize between tabs, and removing or clearing
  the saved value returns every open tab to the current OS preference. The
  provider subscribes before reconciling current storage/OS state and repeats
  that reconciliation after BFCache restore or a visible-tab resume, so a
  suspended or mounting tab cannot remain on a missed preference event.
- Theme is site-wide presentation-only state. Any site or board theme button
  updates the same preference; Board canvas chrome and both Monaco editors
  follow it in the pre-paint layout phase without recreating the board renderer
  or changing editor content. CSS chrome, the Konva canvas, and Monaco therefore
  cannot expose a mixed-theme frame. Theme remains outside CRDT, sync,
  awareness, and undo.
- The Code workspace palette covers Explorer, file actions, the editor toolbar,
  test inputs, live terminal prompt/output, and the lesson output panel. The
  call palette likewise covers the lobby, LiveKit container, placeholders,
  overlays, controls, alerts, and the guest-room call shell. Both palettes are
  rooted in the document `data-theme`, change without remounting an editor or
  media room, and do not leave an intentionally always-dark sub-surface in the
  light theme. Dark backgrounds and raised surfaces use a neutral graphite
  scale; blue is reserved for focus, selection, collaboration cursors, and
  primary actions instead of tinting Explorer, terminal, Board, or call areas.
- Primary and destructive actions use theme-specific foregrounds over their
  fills. Form hover, focus, and validation borders remain distinct in dark
  mode. Site cards, panels, popups, menus, controls, and rendered board objects
  use a flat presentation without decorative depth shadows in either theme.
  Focus, selection, validation, connection-state rings, and the ephemeral
  laser glow remain functional indicators rather than elevation effects. The
  authenticated sidebar has separate light and dark
  surfaces, navigation, account, hover, active, and divider colors rather than
  acting as an always-dark exception.
- Grid visibility is likewise device-local presentation state. The context-menu
  checkbox persists independently from theme and never changes shared board
  data.
- Dark mode changes canvas, grid, toolbar chrome, transformer, and presence
  contrast. Drawing-palette configuration keeps its scrim, emphasized toggle,
  edit controls, checkerboards, and popup legible in both themes. Only the exact
  canonical graphite `#17212b` is adaptively rendered as light ink; stored
  style and custom colors do not change.
- The configured main toolbar and style bar scroll horizontally with a hidden
  scrollbar. The fixed Select and overflow trigger remain part of the toolbar
  layout, while any revealed tools follow the stored order. A variable Drawing
  palette remains inside the style strip instead of widening the board; an
  active pointer reorder can edge-scroll it.
- At board width 560 px or below, Minus/Plus hide; percentage, Home, and theme
  remain.
- At 900 px or below, history moves to bottom center. At 380 px or below it
  moves above the other bottom controls/status.
- Coarse-pointer media increases hit targets, including Drawing preset buttons.
  During palette configuration those buttons reserve touch movement for
  pointer reordering; the add/delete controls remain independently focusable.
- At 430 px viewport width or below, Code and LaTeX source editors use nearly
  the full board. Ordinary Text remains attached to its object.

## Fail-closed and current limitations

- Startup may show loading or a retry action only for a retryable startup error.
  Protocol/schema mismatch, non-v2 board, revoked session/access, or removed
  board never falls back to another engine.
- Unknown/newer objects survive and render as placeholders rather than being
  deleted.
- LaTeX is source-only today; KaTeX rendering and snippets remain planned.
- Code execution is Python-only and explicit.
- Normal board import/export, recovery import, named pages, and direct
  material/task references are not implemented.

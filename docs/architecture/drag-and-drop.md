# Drag and drop: XDND on both sides, and what API it deserves

Design review of [#126](https://github.com/sidorares/react-x11/issues/126)
("XDND drop target: accept drags from file managers"), extended to cover the
drag **source** half, and turned into an implementation plan.

Three questions drive it:

1. Is the API proposed in #126 the right one? (lenses: DOM familiarity,
   interop with real XDND implementations, reuse of the npm React ecosystem)
2. react-x11 draws windowless controls into one window canvas. XDND is a
   protocol between **X windows**. Where does the advertisement live, and
   should it be lazy?
3. What does adding the source side cost, and how do the two halves share
   machinery?

Checked at react-x11 `d5257ce` (master, 2026-08-02), **ntk 5.3.0**, node-x11
as vendored. Protocol claims are checked against two independent mirrors of
the XDND spec (see [§11](#11-sources)); every code reference is a real line
at that SHA.

> **Revision note.** The first draft was written against ntk 4.3.0. ntk 5.0.0
> – 5.3.0 landed while it was in review and changed four of its conclusions —
> one of them the headline blocker on the drag-source half. [§0.1](#01-audit-against-ntk-530)
> is the audit; the body below is corrected, not annotated.
>
> **What shipped, and where it diverged.** This is the design as argued, kept
> as the record of _why_; [drag-and-drop.md](../drag-and-drop.md) is the
> reference for what the API actually is. Phases 0–3 shipped in #162 and
> #165. Four things landed differently from the sketch below, and the
> reference page is authoritative on all of them: the floor is **ntk 5.4.0**,
> not 5.3.0 (#167 needed `clipboard.read({ time })` and `clipboard.clear`);
> the foreign target is resolved **per motion, uncached** — the drag-start
> `QueryTree` cache in §6.3/§7 is still the remote-X follow-up; the drag
> rides the **implicit button grab** rather than `GrabPointer` or
> `capturePointer`, swapping only the cursor; and `dragPreview` shipped as a
> **marker prop on a `<popup>` the app renders itself**, not as a node-valued
> prop on the source. The atom interning is also unconditional at realize
> rather than lazy.

---

## 0. TL;DR

- **The protocol reading in #126 is sound.** Message list, field layout,
  timestamp rule and the "reuse the clipboard read path" instinct all hold up.
  The gaps are not in the protocol, they are in the API and in the source half.
- **`XdndAware` should be written unconditionally at realize time, on
  top-level windows only** — #126 is right, and for a stronger reason than it
  gives. It is a 4-byte property on a window that already exists; it creates
  no X windows; and since XDND v3 the spec puts it on top-levels _only_, so
  child windows — `<glarea>`, nested `<window>`, and any future windowed
  region from [windowed-regions.md](windowed-regions.md) — need nothing at
  all. **XDND is orthogonal to the windowed/windowless split.**
- **The lazy refcount you want is real, but it should gate _behaviour_, not
  the property.** The protocol has its own lazy channel: the _suppression
  rectangle_ in `XdndStatus`. A window with zero live drop targets answers the
  first `XdndPosition` with `accept=0` and a rectangle covering the whole
  window, and the source sends nothing more until the pointer leaves — one
  message per window-entry for the entire drag. That beats de-advertising on
  every axis: no property churn per commit, no mid-drag race, no
  Offscreen/Suspense bookkeeping.
- **Drop the marker-props design.** #126 proposes `useDropTarget()` returning
  opaque props carrying "an internal marker the drop router hit-tests for".
  Not needed: `EventManager.dispatch()` already does hit test → path →
  capture/target/bubble, keyed on ordinary `on*` props
  ([events.js:218](../../src/events.js)). Drop props should be ordinary host
  props like every other event in the toolkit, with `useDropTarget` as a
  thin convenience in `src/components/` — the same two-layer shape as
  `anchorRect`/`useAnchor` and `windowIdOf`/`useWindowId`.
- **`dropAccept` must be declarative, and that is a latency argument, not a
  taste argument.** With `dropAccept` as data, `XdndStatus` can be answered from the
  ClientMessage handler without entering React. An always-advertised window
  that stalls on a render stalls _the source application's drag cursor_ — the
  user sees another app freeze. Declarative accept is what makes "always
  advertise" safe.
- **Do not ship a fake `e.dataTransfer`.** X selections are asynchronous;
  DOM's `getData()` is synchronous. A `dataTransfer.getData()` returning a
  Promise fails silently into `"[object Promise]"`. Flatten the payload onto
  the event, name the async parts async, and say why in the docs.
- **The two sides should share one drag session with two transports.** In-app
  drags (reorderable lists, trees, kanban — the overwhelming majority) never
  touch the wire: mousedown threshold, `capturePointer`, synthetic dispatch,
  live JS payloads. XDND is engaged only when the pointer leaves our windows,
  or when a foreign drag enters. Same handlers either way; `e.source` tells
  them apart. This is how GTK and Qt are built, and it is the only shape that
  respects the project's perceived-latency goal.
- **The source half is 3–4× the target half, but it is no longer blocked.**
  ntk 5.3.0 landed INCR on the selection _write_ side plus arbitrary targets
  and binary payloads ([ntk#164](https://github.com/sidorares/ntk/issues/164)),
  which was the one hard prerequisite. `app.clipboard.write({'text/uri-list':
…, 'image/png': buf}, { selection: 'XdndSelection', time })` is the whole
  data-publishing half of an XDND source, today. See [§0.1](#01-audit-against-ntk-530).
- **npm reuse: `react-dnd` is the one real prize.** Its core (`dnd-core`) is
  deliberately DOM-free and its backends are pluggable, so a
  `react-x11` backend brings `useDrag`/`useDrop` and the sortable/kanban
  ecosystem along. `@dnd-kit` and `react-dropzone` are DOM-bound and stay
  unusable — but react-dropzone's _hook shape_ is what React developers know
  for file drops, and copying it costs nothing.
- **Testing is unusually good here, and macOS is unusually bad.** node-x11's
  in-process JS server implements `SendEvent`, `SetSelectionOwner`,
  `ConvertSelection`, `GetSelectionOwner`, `ChangeProperty`, `GetProperty`,
  `QueryTree`, `TranslateCoordinates` and `GrabPointer` — so both halves are
  testable hermetically with two connections, the `test/wm.test.js` pattern.
  Meanwhile **XQuartz does not bridge Finder drags into X11**
  ([XQuartz#173](https://github.com/XQuartz/XQuartz/issues/173)), so the
  headline use case cannot be demoed on this machine against Finder — only
  X-client to X-client.

### 0.1 Audit against ntk 5.3.0

ntk went 4.3.0 → 5.3.0 in two days
([5.0.0](https://github.com/sidorares/ntk/releases/tag/v5.0.0) …
[5.3.0](https://github.com/sidorares/ntk/releases/tag/v5.3.0)). Four
conclusions moved.

#### Reversed — the drag-source blocker is gone

`feat(clipboard): INCR on the write side, required targets, any format`
([ntk#164](https://github.com/sidorares/ntk/issues/164), 5.3.0) deletes the
"file this before designing around it" item outright. `Clipboard` now:

- serves **arbitrary target names with binary payloads** —
  `write({ 'text/uri-list': str, 'image/png': buf })`, strings encoded UTF-8
  (latin-1 for `STRING`), Buffers/TypedArrays as-is;
- transfers **incrementally in both directions** (ICCCM 2.7.2), so the ~256 KB
  single-request cap no longer bounds a payload;
- answers the three targets ICCCM 2.6.2 makes mandatory — `TARGETS`,
  `TIMESTAMP`, `MULTIPLE` — which a v1 draft would have got wrong;
- takes an **ICCCM-correct timestamp**, `write(data, { time })`, explicitly
  never `CurrentTime`. That is the same discipline XDND demands, already
  enforced;
- reads back symmetrically: `targets()` enumerates offered type names, and
  `read({ target })` returns **raw bytes**, which is exactly the shape
  `e.getData(type)` needs.

`selection` has always been a free-form atom name, so `'XdndSelection'` needs
no new API at all. And the intent is explicit upstream — `clipboard.js:17`
reads, in the module header, that the target-map machinery exists so "HTML,
images and — later — XDND drags are the same machinery."

**Consequence for the plan:** Phase 0's two clipboard items collapse. The
"factor selection transfer out of `Clipboard` into a reusable primitive" ask
from #126 is satisfied by `targets()` + `read({ target })` + `write(map)`; no
ntk refactor is needed for either half, and Phase 3 stops being gated on an
ntk release cycle.

#### Improved — `on('close')` frees `on('message')` for XDND

`feat: a cancellable 'close' event for WM_DELETE_WINDOW`
([ntk#155](https://github.com/sidorares/ntk/issues/155), 5.3.0). Listening for
`'close'` self-arms: it interns `WM_PROTOCOLS`, calls
`addProtocol('WM_DELETE_WINDOW')`, decodes the ClientMessage, and hands over an
event with `preventDefault()` (`window.js:543`, `window.js:2467`).

react-x11 still does all of that by hand — `setActions()`, an `InternAtom`
callback, and a `wnd.on('message')` filter
([nodes.js:3684-3715](../../src/nodes.js)). So the Phase 0 item is now better
than "make the listener unconditional and route by `message_type`": **adopt
`wnd.on('close')` and delete the block**, which leaves `on('message')`
completely free for the XDND router with no routing logic at all. `'message'`
is still emitted for every ClientMessage (`window.js:511`), and
`_emitCloseRequest` runs after it, so the two never contend. Independently
worth doing: `onCloseRequest` gains cancellability.

`Window` also grew the general helpers this needs — `addProtocol` /
`removeProtocol` (`window.js:1459`) and `atom` / `getProperty` / `setProperty`
/ `deleteProperty` (`window.js:2100`) — so `XdndAware` is
`wnd.setProperty('XdndAware', [5], { type: 'ATOM' })` rather than a raw
`ChangeProperty`.

#### Weakened — the pointer-grab item is optional, not a prerequisite

`grabPointer({ cursor })` takes a cursor **XID**, and `app.cursors.get(name)`
mints one from the standard cursor font (`cursor.js:68`). So the drag cursor
_at grab time_ needs no new ntk API. Only the mid-drag swap as the accepted
action changes needs `ChangeActivePointerGrab`, which node-x11 exposes
(`corereqs.js:867`) and react-x11 can call directly. Phase 0 item downgraded
from prerequisite to optional convenience wrapper.

New caveat in the same area: `cursorShapes` is the X **core cursor font**, so
the themed XCursor names toolkits use for drag feedback (`dnd-copy`,
`dnd-move`, `dnd-none`) are not loadable. Feedback will be a core-font
approximation until ntk gains XCursor theme loading — cosmetic, but it is the
part of a drag the user stares at.

#### Strengthened — request buffering does _not_ cost the latency argument

`feat: one socket write per frame — buffer requests by default`
([ntk#141](https://github.com/sidorares/ntk/issues/141), 5.0.0) is the change
that looked most likely to undercut §2.4's "answer `XdndStatus` in the same
event-loop turn": a 64 KB output buffer with a 5 ms age gate would have added
up to a frame of latency to every reply.

It does not. node-x11's frame buffer has an explicit backstop —
"_nothing is left in the buffer when the event loop goes to poll for I/O_",
implemented as a `setImmediate` flush (`framebuffer.js:33-38`), alongside the
size cap, the 5 ms age gate and a flush before any request expecting a reply.
A `SendEvent` written from the ClientMessage handler therefore leaves the
socket at the end of the current phase, before the next poll — and now as part
of one write rather than one syscall per request. The claim survives with a
named mechanism, and the drag path got slightly cheaper.

#### Two new caveats for the source half

1. **`write()` payloads are eager.** `_encode()` serialises everything at
   `write()` time (`clipboard.js:398`), so §6.2's lazy `dragData` thunks are
   resolved by react-x11 **at promotion** — when it takes `XdndSelection` —
   not when a target converts. Still worth having (an in-app drag serialises
   _nothing_, and an external drag serialises once at promotion rather than at
   mousedown), but the "pull-based, so a 20 MB payload is never built for a
   drag that ends in the wastebasket" claim is now only true of drags that
   never leave our windows. Ask ntk for lazy payload getters if that matters.
2. **Ownership sits on ntk's private helper window.** `Clipboard` owns every
   selection on its hidden 1×1 window, not on the window we would name as the
   XDND source. This is protocol-legal — the target converts `XdndSelection`
   and the server routes to whoever owns it, wherever that is — and none of
   the reference implementations validate owner == source window. Verify in
   Phase 3; if a target does check, ntk needs a `window` option on `write()`.
   Related: there was no disown API when this was written, so releasing
   `XdndSelection` at drag end meant `app.X.SetSelectionOwner(0, sel, time)`
   directly. **ntk 5.4.0 added `clipboard.clear(selection)`**
   ([ntk#169](https://github.com/sidorares/ntk/issues/169)) and `_disown()`
   uses it.

#### Unchanged

Everything in §2 (advertisement, refcount, lifecycle), §3–§5 (the three
lenses), §6 (the API), and §8 (the test plan) is unaffected: ntk 5.x adds no
XDND support, no window-property policy changes, and no event-routing changes
that touch them. `SendClientMessage` (node-x11, `xcore.js:246`, whose own
comment names XDND) is still the send path.

---

## 1. What #126 gets right

Worth stating, because the rest of this document is criticism and the
foundation is good.

- **Message set and field layout are correct.** `XdndEnter` bit 0 →
  `XdndTypeList`, types in `l[2..4]`; `XdndPosition` root coordinates packed
  `(x << 16) | y` in `l[2]`; `XdndStatus` accept bit and rectangle;
  `XdndDrop`'s timestamp in `l[2]`. Verified field-by-field against two spec
  mirrors.
- **The timestamp rule is called out** — `ConvertSelection` must carry
  `XdndDrop`'s `l[2]`, not `CurrentTime`. This is the single most commonly
  botched part of XDND and #126 has it.
- **"Advertise unconditionally, answer _not accepting_"** is the right call
  (§2 sharpens the argument).
- **Reusing the clipboard read path** is right — and as of ntk 5.3.0 the
  public API is already the right shape: `targets()` enumerates offered type
  names and `read({ selection: 'XdndSelection', target })` returns raw bytes,
  INCR reassembly included (`clipboard.js:127`, `clipboard.js:148`).
- **Splitting the source off as separate work** is right. It is a much bigger
  job (§6), and the target half is independently useful.
- **The infrastructure survey is accurate**: ClientMessage already routes to
  `WindowNode` ([nodes.js:3697](../../src/nodes.js)), hit testing and hover
  path diffing already exist in `EventManager`, and `window._screenOrigin`
  ([nodes.js:3506](../../src/nodes.js)) already holds the root-coordinate
  translation `XdndPosition` needs.

Four corrections to the protocol detail before moving on:

1. **`XdndStatus` `l[1]` has a second bit.** Bit 1 means _"send
   `XdndPosition` even while inside the rectangle"_. #126 mentions only the
   accept bit. This bit is the difference between a dropzone that can draw an
   insertion caret and one that goes deaf — see §2.4.
2. **The rectangle is not a free optimisation.** #126 proposes replying with
   "the hit node's screen rect" on every position. For a uniform dropzone that
   is right and saves the source a message per motion frame; for a list that
   needs an insertion index, or a zone with edge auto-scroll, it silently
   breaks the feature. Default must be _no suppression_; suppression is opt-in
   (`e.freeze()`), with the one automatic exception in §2.3.
3. **`XdndFinished` needs a watchdog, not just a reply.** If `onDrop` awaits
   something slow, the source blocks — that is another application's UI
   frozen by ours. Send `XdndFinished` when the handler settles _or_ after a
   timeout, whichever comes first, and report the timeout to the app.
4. **Version negotiation must be stored.** `XdndEnter`'s `l[1]` high byte
   carries the source's version; `XdndFinished`'s flags in `l[1]`/`l[2]` are
   v5-only. Cap replies to `min(5, sourceVersion)` and keep the source window
   id — every reply is addressed to it, not to whoever the pointer is over.

---

## 2. Where the advertisement lives (the windowless question)

> _"our toolkit renders windowless controls inside window canvas… we need
> lazily Advertise on a nearest parent windowed control / De-advertise in the
> other direction whenever a DnD control is mounted / unmounted."_

The instinct is right — there **is** something to refcount — but the thing to
gate is not `XdndAware`.

### 2.1 `XdndAware` costs no windows

The concern behind the question is X window economy, which this project takes
seriously and rightly ([windowed-regions.md](windowed-regions.md) §3.2 is
where window-per-control dies). `XdndAware` is not that. It is:

- **a property, not a window** — zero `CreateWindow`, zero map/move storms,
  zero server-side pick-tree cost;
- **one `ChangeProperty`**, 4 bytes of payload, no round trip once the atom is
  interned;
- **on a window that exists anyway** — the top-level `<window>`.

`WindowNode.realize()` already sends `WM_NAME`, `_NET_WM_NAME`, `WM_CLASS`,
`_NET_WM_PID`, size hints, and optionally `WM_PROTOCOLS`, `WM_TRANSIENT_FOR`
and `_NET_WM_STATE`. One more 32-bit property is well under 5% of a window's
setup traffic and is sent once per window, ever.

### 2.2 The spec puts it on top-levels, which makes windowed regions a non-issue

XDND v3 moved `XdndAware` to **top-level windows only**; sources locate the
target by descending the tree with `TranslateCoordinates` and then looking for
`XdndAware` on the top-level (GTK and Qt both resolve the client window
through `WM_STATE` and walk up).

Consequences, and this is the direct answer to the question:

- **`<glarea>`'s child window: nothing.** A drag over a `<glarea>` is found
  through the enclosing top-level and routed by our own hit test.
- **A future windowed a scrolling `<box>` pane, or any `<box windowed>` that never
  ships: nothing.** The promotion decision in
  [windowed-regions.md](windowed-regions.md) §8 is invisible to XDND. That is
  a genuine argument _for_ that document's verdict — a feature that would have
  had to care about `windowed` does not.
- **Nested `<window>` children need routing, not advertising.** react-x11
  supports child `<window>`s inside a parent
  ([nodes.js:3460](../../src/nodes.js)). Those are not top-levels, so they get
  no property; messages arrive at the outer window carrying **root**
  coordinates, and the router must descend our own window tree in JS:
  root point → each realized `WindowNode`'s `_screenOrigin` + size → topmost
  match in `_xStack` order → that node's `hitTest`. Cheap, local, no round
  trips, and it is the same walk `anchorRect` already does in reverse.
- **`<popup>` is a top-level** (override-redirect, child of root) and _does_
  get the property, so a drop onto an open menu or a combo panel works.

### 2.3 What the refcount should actually gate

Keep a `Set` of registered drop-target nodes **per `WindowNode`** (a `<popup>`
is its own root, so it gets its own). It gates three things, none of them the
property:

1. **The whole-window suppression fast path.** `set.size === 0` → reply to the
   first `XdndPosition` with `accept=0`, bit 1 clear, and a rectangle covering
   the whole window in root coordinates. The source stops sending positions
   until the pointer leaves. **One ClientMessage per window-entry, for the
   whole drag.** This is exactly the saving de-advertising would have bought,
   obtained through the protocol's own mechanism.
2. **Atom interning.** Intern the ~15 `Xdnd*` atoms lazily, on the first
   drop-target registration _or_ the first `XdndEnter`, whichever comes first.
   An app with no DnD never sends the `InternAtom` batch.
3. **Module activation.** `src/dnd.js` stays cold. `realize()` writes one
   property; the shared `message` listener is an atom range check.

### 2.4 Why _not_ to make the property lazy

Four reasons, in order of how much they hurt:

1. **Mid-drag mounts are invisible.** GTK's source builds its window cache at
   _drag start_ — before our app can possibly know a drag exists. A dropzone
   that mounts in reaction to app state during a drag would never be seen by
   that source, and the failure is silent and unreproducible.
2. **Commit churn.** Route changes, tab switches and virtualised lists mount
   and unmount dropzones constantly. A 1 → 0 → 1 refcount across a commit
   boundary costs `DeleteProperty` + `ChangeProperty` _per commit_, which is
   more traffic than the one write it was trying to avoid.
3. **Offscreen and Suspense.** `hideInstance` does not unmount
   ([Reconciler.js:408](../../src/Reconciler.js)), so a correct refcount would
   need hidden-tracking too — state that is easy to get subtly wrong and whose
   failure mode is "drops stopped working in this tab".
4. **There is no user-visible difference.** Not-advertised and
   advertised-but-rejecting both produce the source's "no drop" cursor. The
   lazy version buys nothing the user can see, and costs the three failures
   above.

The one obligation `always advertise` creates: **you must always answer, and
answer fast.** A window that is `XdndAware` and silent freezes the _source_
application's drag. That obligation is why `dropAccept` has to be declarative
(§4.1) — the answer must be computable without waiting for React.

### 2.5 The exact lifecycle points

The codebase already answers this; `trapFocus` is the identical problem
(subtree-scoped declaration, root-scoped registry) and its wiring is the
template:

| Moment  | Hook                                                                                                                                                                                        | What to do                                                                                                                                 |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Mount   | `finalizeInitialChildren` returns `true` when the props declare drop handling ([Reconciler.js:342](../../src/Reconciler.js)) → `commitMount` ([Reconciler.js:352](../../src/Reconciler.js)) | `root._dnd.register(node)`. Must be `commitMount`, not `createInstance`: the node needs its `root`, which `_setRoot` assigns on insertion. |
| Update  | `commitUpdate` → `applyProps` ([nodes.js:956](../../src/nodes.js)), next to the existing `trapFocus` branch                                                                                 | register/unregister on the boolean edge only                                                                                               |
| Unmount | `detachDeletedInstance` ([Reconciler.js:424](../../src/Reconciler.js)), which already calls `events.forget(instance)`                                                                       | one more line: `instance.root?._dnd?.forget(instance)`                                                                                     |
| Hidden  | —                                                                                                                                                                                           | do **not** track. `hitTest` already skips hidden nodes; a hidden-but-registered node costs one unsuppressed `XdndStatus` and nothing else. |

Realize-time (`WindowNode.realize()`, before `map()`): write `XdndAware = 5`
as `ATOM`/32 unconditionally, next to `applyWindowStates` — same reasoning as
the EWMH properties there, a declaration made before anyone can look.

One refactor falls out: the `message` listener is currently installed only
when `onCloseRequest` is set ([nodes.js:3697](../../src/nodes.js)). Make it
unconditional and route by `ev.message_type` — `WM_PROTOCOLS` to the close
path, `Xdnd*` to the DnD router. Cheap, and `_NET_WM_PING`/`_NET_WM_SYNC` will
want it later.

---

## 3. Lens 1 — familiarity to the DOM API

react-x11 tracks the DOM closely and deliberately: capture/bubble
(`onFooCapture` then `onFoo`), `stopPropagation`/`preventDefault`, `detail`
click counting, `capturePointer` modelled on implicit pointer capture. Drag
and drop should inherit that, with three deliberate divergences.

**Keep, verbatim:**

- `onDragStart`, `onDrag`, `onDragEnd` (source) and `onDragEnter`,
  `onDragOver`, `onDragLeave`, `onDrop` (target). Same names, same
  enter/leave-do-not-bubble rule the hover path already implements
  ([events.js:428](../../src/events.js)).
- `draggable` as the prop that makes a node a source. It is the HTML
  attribute name, and it reads correctly.
- `'copy' | 'move' | 'link'` action names — they map 1:1 onto
  `XdndActionCopy`/`Move`/`Link`, which is a gift the DOM's `dropEffect`
  vocabulary hands us for free.
- MIME type strings as the type vocabulary.

**Diverge, on purpose:**

1. **No `preventDefault()`-to-accept.** In the DOM, `dragover` +
   `preventDefault()` means "suppress the browser's default of refusing the
   drop" — the most-complained-about wart in the HTML5 DnD API, and it is
   _meaningless here_: there is no browser and no default. Use
   `e.accept(action)` / `e.reject()`. Explicit, discoverable, and the
   declarative `dropAccept` prop means most code never calls either.
2. **No `e.dataTransfer`.** X selections are asynchronous — `ConvertSelection`
   then wait for `SelectionNotify`, possibly through INCR chunks. DOM's
   `getData()` is synchronous and returns a string. A `dataTransfer` whose
   `getData()` returns a Promise is a trap that fails _silently_:
   `"dropped: " + e.dataTransfer.getData('text/plain')` yields
   `"dropped: [object Promise]"` with no error anywhere. Flatten onto the
   event, name the async things async (`await e.getData(type)`), and let the
   different name carry the different contract.
3. **Data may be lazy, and may be a live object.** DOM's `setData(type, str)`
   is eager and string-only. XDND is pull-based — the target converts the
   selection _after_ the drop — so `dragData` accepts thunks, and for in-app
   drags it can carry a JS value that is never serialised at all. Strictly
   better than the DOM, and it matches `react-dnd`'s model, which is what
   React developers actually use.

---

## 4. Lens 2 — interop with real XDND implementations

This is where a plausible-looking API quietly fails in the field. Each item
below is a concrete requirement on the API surface, not just the plumbing.

### 4.1 `dropAccept` must be smarter than string equality

The same logical payload arrives under different names depending on who is
dragging:

| Drag                                   | Types actually offered                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------ |
| Files from Nautilus / Thunar / Dolphin | `text/uri-list`, `text/plain`, sometimes `x-special/gnome-icon-list`                       |
| Text from a GTK app                    | `text/plain;charset=utf-8`, `UTF8_STRING`, `text/plain`, `STRING`, `TEXT`, `COMPOUND_TEXT` |
| A link from Firefox                    | `text/x-moz-url` (**UTF-16LE**, `url\ntitle`), `text/uri-list`, `text/plain`               |
| A link from Chromium                   | `text/uri-list`, `_NETSCAPE_URL`, `text/html`                                              |

`dropAccept: ['text/plain']` therefore misses GTK text entirely, and
`dropAccept: ['text/uri-list']` catches files but silently drops Firefox's
preferred link type. So `dropAccept` takes:

- exact MIME strings — `'image/png'`;
- **semantic groups** — `'files'`, `'text'`, `'uris'` — expanding through a
  normalisation table that is part of the library, not of every app;
- a predicate — `(types) => types.some(...)` — for the rest.

Getting this table right _is_ the interop feature. It is also the one piece
that must be data rather than code, so `XdndStatus` can be answered without
entering React (§2.4).

### 4.2 `text/uri-list` must be parsed for the app

Per RFC 2483 it is CRLF-separated, percent-encoded, and `#`-prefixed lines are
comments. #126's `await e.getData('text/uri-list')` hands back the raw string
and every app writes the same buggy decoder. Provide instead:

```js
e.files; // [{ uri: 'file:///home/a/My%20Doc.pdf', path: '/home/a/My Doc.pdf' }]
```

`path` is present only for `file:` URIs whose host is empty, `localhost`, or
this machine — a remote `file://otherhost/...` has no local path and must not
pretend to. That rule is exactly the kind of thing that belongs in the library
once.

### 4.3 Protocol obligations that shape the API

- **Answer `XdndPosition` promptly, always.** §2.4. Declarative `dropAccept`
  handles the common case without React; a handler-based answer runs at
  `DiscreteEventPriority` and, if a render is in flight, replies with the last
  known answer rather than waiting.
- **`XdndFinished` must always be sent.** Async `onDrop` is supported (it is
  the natural shape — the data arrives asynchronously), so the contract is:
  the reply goes out when the returned promise settles, or after
  `dropTimeout` (default ~10 s), whichever is first, with a dev warning on
  timeout. An app must not be able to hang another app's drag by forgetting an
  `await`.
- **`XdndProxy` must be honoured on the source side** — read it on each
  candidate window, send to the proxy while keeping the real window id in the
  message fields. We never _set_ it, since only top-levels advertise (§2.2).
- **Version negotiation.** Store `sourceVersion` from `XdndEnter`'s high byte;
  v5-only `XdndFinished` fields are omitted below 5.
- **`XdndActionAsk`** should eventually pop a menu built from the source's
  `XdndActionList` + `XdndActionDescription` — react-x11 already has
  `ContextMenu`. v1 narrows to `XdndActionCopy`, which the spec permits.

### 4.4 What we will not speak, and should say so

- **Motif drag-and-drop** (the older protocol). Legacy Motif and some AWT
  builds speak only that; they will not interop. Not worth implementing.
- **XdndDirectSave (XDS)** — "drag out of the app to save a file into the file
  manager". A separate protocol layered on XDND. Worth a documented "not
  supported" line, because its absence looks like a bug.
- **Finder → X11 on macOS.** XQuartz does not bridge native drags into X11
  ([XQuartz#173](https://github.com/XQuartz/XQuartz/issues/173)). On this
  machine the feature can only be exercised X-client to X-client (a GTK app
  under XQuartz, `mwh/dragon`, or the hermetic tests in §8). Under XWayland on
  Linux, XDND does bridge to and from native Wayland apps — which is where
  #126's impact claim holds.

---

## 5. Lens 3 — reuse of the npm React ecosystem

| Package                                     | Status                         | Why                                                                                                                                                                                                                                                                   |
| ------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`react-dnd`**                             | **the prize**                  | `dnd-core` is deliberately DOM-free and backends are pluggable (constructor takes a manager, plus `setup()`/`teardown()`). A `react-x11` backend brings `useDrag`/`useDrop` and everything built on them.                                                             |
| `react-dropzone`                            | unusable, but _copy its shape_ | Already documented as failing twice ([ecosystem.md](../ecosystem.md)) — `<input>`, then `window is not defined` in its own mount effect. Its hook shape (`getRootProps()`, `isDragActive`, `acceptedFiles`) is nonetheless what React developers know for file drops. |
| `@dnd-kit/core`                             | unusable                       | Sensors are pluggable but the core measures with `getBoundingClientRect` and synthesises DOM `PointerEvent`s. A backend is not the seam it offers.                                                                                                                    |
| `react-beautiful-dnd` / `@hello-pangea/dnd` | unusable                       | DOM-only by design, and its use case (in-app reorder) is fully served by §6's local path.                                                                                                                                                                             |

Two conclusions:

1. **Design the low-level API so a `react-dnd` backend is writable on top of
   it.** That means the drag session must expose imperative
   `beginDrag`/`hover`/`drop`/`endDrag` transitions and node-rect measurement,
   not only React props — which it needs internally anyway. Nothing here is
   extra work; it is just a constraint on where the seam goes.
   `NativeTypes.FILE` maps onto foreign XDND drops; in-app drags never reach
   X. The backend can ship later, in a separate package, without changing this
   API — as long as the seam exists.
2. **Match `react-dropzone`'s hook ergonomics** in `useDropTarget`, including
   the render state (`isOver`, `isAccepted`), because that is the muscle
   memory. But go one better: react-x11 has style states, so the common case
   needs no state at all — see `:drag-over` in §6.1.

---

## 6. The proposed API

### 6.1 Target side

Host props, on any drawn node, dispatched through the existing
capture/bubble machinery — no marker, no parallel router:

```jsx
<box
  dropAccept={['files']} // declarative; answers XdndStatus without React
  onDragEnter={(e) => {}} // does not bubble, like onMouseEnter
  onDragOver={(e) => {}} // per motion, unless frozen
  onDragLeave={(e) => {}}
  onDrop={async (e) => setFiles(e.files)}
  style={{
    borderColor: '$border',
    ':drag-over': { borderColor: '$accent' }, // new style state
  }}
/>
```

**Why `dropAccept` and not `accept`.** Prop _presence_ is what registers a
node as a drop target, so the name carries behaviour, and a name as generic
as `accept` (HTML's `<input accept>`, react-dropzone's option) could ride
in on a `{...spread}` and silently make a box a dropzone — on `<input
type=file>` the element supplies the context; on a generic `<box>` nothing
does. The `drop*` prefix also keeps the family discoverable next to
`onDrop` and mirrors the source side's `drag*` data props (`dragData`,
`dragActions`, `dragPreview`). Rejected alternatives: `dndAcceptTypes`
(abbreviation prefix foreign to the codebase, splits the family into two
namespaces, and `Types` over-narrows a value that can be a group or a
predicate), `acceptDrops` (reads boolean, takes a list), `droppable`
(prettiest symmetry with `draggable`, but the target needs a _filter_, and
with `onDrop` implying accept-anything its boolean form is boilerplate).

`:drag-over` joins `STATE_KEYS` ([styles.js:156](../../src/styles.js)) and is
set by the router through the same `setStyleState` path `:hover` uses
([events.js:429](../../src/events.js)). The whole "highlight the dropzone"
feature — the thing every react-dropzone tutorial spends a `useState` on —
becomes styling.

The event, built by `_makeEvent` ([events.js:178](../../src/events.js)) so it
inherits `x`/`y`/`localX`/`localY`/`stopPropagation` for free:

```
e.types      string[]        normalised type names offered by the source
e.has(type)  boolean         alias-aware ('text', 'files', or an exact MIME)
e.action     'copy'|'move'|'link'|'ask'|'private'   what the source asked for
e.source     'internal'|'external'
e.screenX/Y  number          root coordinates (XdndPosition gives these natively)
e.accept(action?)            default: the source's requested action
e.reject()
e.freeze()                   opt into the XdndStatus suppression rectangle
                             for this node's rect (see §1, correction 2)
// onDrop only:
e.getData(type) -> Promise<Buffer|string>
e.files      [{ uri, path }] parsed text/uri-list (§4.2)
e.text       string          the best available text flavour
e.items      any             live JS payload — internal drags only, no serialisation
```

Convenience hook in `src/components/`, mirroring react-dropzone:

```jsx
const { dropProps, isOver, isAccepted } = useDropTarget({
  accept: ['files'], // the hook name supplies the scope; emits `dropAccept`
  onDrop: (e) => setFiles(e.files),
});
<box {...dropProps} style={s.zone} />;
```

### 6.2 Source side

```jsx
<box
  draggable
  dragData={{
    'text/uri-list': () => selected.map((f) => pathToUri(f.path)), // lazy: pull-based protocol
    'text/plain': selected.map((f) => f.name).join('\n'),
    'application/x-myapp-row': { id: row.id }, // in-app: live object
  }}
  dragActions={['copy', 'move']}
  dragPreview={<Chip label={row.name} />} // rendered into a <popup> that follows the pointer
  onDragStart={(e) => {
    /* e.preventDefault() cancels */
  }}
  onDrag={(e) => {}}
  onDragEnd={(e) => {
    if (e.action === 'move') remove(row.id);
  }}
  style={{ ':dragging': { backgroundColor: '$textMuted' } }}
/>
```

Three things to note:

- **`dragPreview` is a React node, not an image.** XDND has no drag image in
  the protocol; every toolkit implements it as an override-redirect window
  that follows the pointer — and react-x11 already has one, `<popup>`. So the
  drag preview is a live component, which beats DOM's
  `setDragImage(HTMLImageElement)` outright. The preview window must be
  skipped when descending for the target; since we hold the pointer grab, we
  are the only client searching, so skipping our own ids is sufficient.
- **Lazy `dragData` defers serialisation to promotion.** A drag that never
  leaves our windows serialises nothing at all — it carries the live JS value.
  A drag that goes external resolves the thunks once, when it takes
  `XdndSelection`, because ntk's `write()` encodes eagerly
  ([§0.1](#01-audit-against-ntk-530)). Deferring all the way to the target's
  conversion, as the pull-based protocol would allow, needs lazy payload
  getters in ntk — worth asking for only if a real payload makes it matter.
- **The gesture is the existing one.** Threshold on mousedown + motion, then
  `capturePointer` — the same mechanics `Slider` and `SplitPane` already use
  ([events.js:202](../../src/events.js)).

Hook form: `const { dragProps, isDragging } = useDragSource({ data, actions })`.

### 6.3 One session, two transports — how the halves fit together

A single `DragSession` in `src/dnd.js`, with a phase:

```
mousedown on draggable
   └─ threshold exceeded ──▶ phase: 'local'
        • no grab (the implicit button grab already delivers motion)
        • no X traffic at all
        • hit test + dispatch('DragOver', …) through EventManager
        • payload is the live JS value; e.source === 'internal'
        │
        ├─ pointer leaves all of our windows ──▶ phase: 'external'
        │     • SetSelectionOwner(XdndSelection)
        │     • write XdndTypeList if > 3 types
        │     • GrabPointer with the action cursor
        │     • build the top-level cache (one QueryTree of root + geometry)
        │     • XdndEnter / XdndPosition / XdndStatus / XdndDrop / XdndFinished
        │
        └─ pointer returns over our own window ──▶ XdndLeave, back to 'local'
              (selection ownership is kept until drag end — it is free)

foreign XdndEnter arrives ──▶ same synthetic dispatch, e.source === 'external'
```

Why this and not "XDND for everything":

- **Latency.** In-app reorder is the overwhelmingly common case. Routing it
  through a pointer grab, a root-tree descent and a selection round trip would
  put wire round trips on the drag path, against the project's stated
  perceived-latency ordering.
- **Fidelity.** In-app you can drag a live JS object. Forcing serialisation
  through MIME strings for a drag that never leaves the process is pure loss —
  and it is precisely why `react-dnd` does not do it.
- **One API.** Handlers cannot tell the transports apart except by asking
  (`e.source`), so an app written for in-app reorder gains cross-app drops by
  adding a MIME type to `dragData`.

This is also what makes the two halves cheap together: the source's target
tracking (which node is under the pointer, enter/leave diffing, accept state)
and the target's routing are **the same code**, differing only in whether the
peer is a foreign window or our own subtree.

---

## 7. Implementation plan

Dependency-ordered. Phase 1 alone closes #126.

### Phase 0 — prerequisites and decisions

**No ntk release gates any of this** — 5.3.0 already ships what both halves
need ([§0.1](#01-audit-against-ntk-530)).

- **[react-x11]** Adopt `wnd.on('close')` for `onCloseRequest` and delete the
  `setActions()` + `InternAtom` + `on('message')` block
  ([nodes.js:3684-3715](../../src/nodes.js)) — filed as
  [#160](https://github.com/sidorares/react-x11/issues/160). That frees
  `'message'` for the XDND router with no routing logic, and makes
  `onCloseRequest` cancellable. The only real prerequisite, and independently
  worth doing.
- **[verify in Phase 3]** That foreign targets accept `XdndSelection` owned by
  ntk's clipboard helper window rather than by the advertised source window.
  If one does not, ntk needs a `window` option on `write()`.
- **[ntk, optional]** `ChangeActivePointerGrab` wrapper for the mid-drag
  cursor swap — `grabPointer({ cursor: app.cursors.get(name) })` already
  covers grab time, and node-x11 exposes the request, so this is convenience.
- **[ntk, done in 5.4.0]** `clipboard.clear(selection)` to disown
  `XdndSelection` at drag end
  ([ntk#169](https://github.com/sidorares/ntk/issues/169)), and a `time`
  option on `read()`/`targets()` so a drop converts with `XdndDrop`'s
  timestamp rather than `CurrentTime`
  ([ntk#168](https://github.com/sidorares/ntk/issues/168)). Both are wired
  up. Still open: lazy payload getters on `write()`, if eager serialisation
  at promotion turns out to matter.
- **[decision]** `:drag-over` (and later `:dragging`) join `STATE_KEYS`.

### Phase 1 — drop target (closes #126)

1. `src/dnd.js`: atom table (lazy intern), `XdndAware` writer, ClientMessage
   decode/encode helpers, version negotiation.
2. `WindowNode.realize()`: write `XdndAware = 5` before `map()`.
3. Per-`WindowNode` drop-target registry + the three lifecycle hooks (§2.5).
4. Root-coordinate router: root point → owning `WindowNode` (descending our
   own child windows, §2.2) → `hitTest` → path.
5. `XdndEnter`/`Position`/`Leave`/`Drop` handling; `XdndStatus` answered from
   declarative `dropAccept` without entering React; the zero-target whole-window
   suppression fast path; enter/leave diffing reusing the hover-path algorithm
   ([events.js:429](../../src/events.js)).
6. Drag event objects on top of `_makeEvent`; `:drag-over`; the `dropAccept`
   normalisation table (§4.1); `text/uri-list` parsing (§4.2).
7. `XdndDrop` → `clipboard.read({ selection: 'XdndSelection', target })` with
   the drop timestamp → `onDrop` → `XdndFinished` with the watchdog.
8. `useDropTarget` in `src/components/`; types in `src/types/`; docs page;
   an `examples/` file-drop demo.

### Phase 2 — in-app drag source (no X11 at all)

9. `draggable`/`dragData`/`dragActions` props; threshold gesture over
   `capturePointer`; `onDragStart`/`onDrag`/`onDragEnd`.
10. `DragSession` local phase feeding the _same_ target-side dispatch, so
    Phase 1's handlers receive internal drags with `e.source === 'internal'`.
11. `dragPreview` → `<popup>` following the pointer; `:dragging`.
12. `useDragSource`.

At this point reorderable lists, trees and kanban work with zero wire traffic,
and the app-facing API is complete. Phase 3 changes no application code.

### Phase 3 — external drag source (XDND out)

13. Top-level cache: one `QueryTree` of root at drag start + geometry and
    `XdndAware`/`XdndProxy` per candidate; refresh on root
    `SubstructureNotify`. Per-motion target resolution is then local — the
    same design GTK uses, and the only way to avoid round trips per motion
    frame.
14. Promotion/demotion (§6.3): selection ownership, `XdndTypeList`,
    `GrabPointer` + action cursor, `XdndEnter`/`Position`/`Leave`/`Drop`.
15. `SelectionRequest` service for the offered types, `TARGETS` included,
    lazy `dragData` thunks resolved on demand; keep serving until
    `XdndFinished` (with the "throw out extremely old data" rule from the
    spec).
16. `XdndStatus` → cursor via `ChangeActivePointerGrab`; `XdndFinished` →
    `onDragEnd` with the performed action.
17. `XdndProxy` honouring; skip our own preview window in the descent.

### Phase 4 — ecosystem and polish

18. `XdndActionAsk` → `ContextMenu` from `XdndActionList` /
    `XdndActionDescription`. _Done, but not as sketched._ The two
    properties are read and handed to the app as `e.actions` /
    `e.actionDescriptions`, and `onDrop` settles the answer with
    `e.accept(action)`; the menu itself stays in application code. A
    built-in one would have to hold `XdndFinished` open for as long as it
    was on screen, and §9's first hazard is that a slow drop freezes the
    source application — so how long to make someone wait is the app's
    call, not the toolkit's. Reading the properties lazily, only when a
    position actually asks, keeps the two round trips off every other drag.
19. A `react-dnd` backend (separate package) over the seam from §5.
20. Auto-scroll on drag near a scroll container's edge — a default action in the
    router, the same shape as the existing wheel default
    ([events.js:294](../../src/events.js)). _Done._ It hangs off
    `_overAt`, so both transports get it from one implementation, and the
    step re-routes rather than re-measuring. The one thing the sketch did
    not anticipate: the step must **not** answer with an `XdndStatus`. A
    status is the reply to a position, and the source has sent none — so
    the fresh answer waits for the next real position instead.

---

## 8. Test plan

Unusually strong here, and worth exploiting.

- **Hermetic, two connections** — the `test/wm.test.js` pattern. node-x11's
  in-process JS server implements `SendEvent`, `SetSelectionOwner`,
  `ConvertSelection`, `GetSelectionOwner`, `ChangeProperty`, `GetProperty`,
  `QueryTree`, `TranslateCoordinates` and `GrabPointer`, and its
  `ConvertSelection` correctly turns into a `SelectionRequest` to the owner
  (`x11/lib/xserver/properties.js:186`). So one connection can play a **fake
  GTK source** (send `XdndEnter`/`Position`/`Drop`, own `XdndSelection`, serve
  `text/uri-list`) and assert react-x11's `XdndStatus`/`XdndFinished` byte by
  byte — and the mirror test can play a **fake target** against our source.
  Both halves of the protocol are testable with no `$DISPLAY`.
- **Unit** — `text/uri-list` parsing (percent-encoding, CRLF, `#` comments,
  remote hosts), the type-alias table against the recorded type lists in §4.1,
  version negotiation, the `XdndFinished` watchdog.
- **Node-tree** — registry lifecycle across mount/update/unmount/hide,
  enter/leave diffing, `:drag-over`, nested-`<window>` routing, and the
  zero-target suppression path (assert exactly one `XdndStatus` per
  window-entry).
- **Manual, and be honest about the platform** — Linux/XWayland: Nautilus,
  Thunar, Dolphin, Firefox, Chromium, `mwh/dragon` both directions. macOS
  XQuartz: X-client to X-client only; **Finder → X11 does not work and is not
  our bug** ([XQuartz#173](https://github.com/XQuartz/XQuartz/issues/173)).

---

## 9. Hazards

- **A slow `onDrop` freezes the source app.** The watchdog is not optional.
- **Suppression rectangles are a footgun.** Freezing a zone that needed
  per-position feedback produces a dropzone that looks broken only on slow
  movements. Default off; `e.freeze()` opt-in; document the insertion-caret
  case explicitly.
- **The source's window cache goes stale.** Windows move and stack during a
  drag. Refresh on `SubstructureNotify`, and re-descend on `ConfigureNotify`
  rather than trusting the cache for the whole gesture.
- **Our own preview window is under the pointer.** Skip our ids in the
  descent (safe, because the grab makes us the only client searching).
- **Timestamps.** Using `CurrentTime` for `ConvertSelection` mostly works and
  then fails against sources that validate — the worst failure profile there
  is. Thread `XdndDrop`'s `l[2]` through. _Done:_ `read({ time })` landed in
  ntk 5.4.0 and `_getData` passes the drop timestamp.
- **Selection ownership outlives the drag.** ntk's `Clipboard` holds a
  selection until someone else takes it. An `XdndSelection` still owned after
  the drag ends is mostly harmless, but a stale offer answered after
  `XdndFinished` is the case the spec warns about ("throw out extremely old
  data"); release it explicitly at drag end. _Done:_ `_disown()` calls
  `clipboard.clear('XdndSelection')` (ntk 5.4.0), which releases with the
  acquisition timestamp — so a drag that already lost the selection to
  another client leaves it alone, where `CurrentTime` would have taken it
  back from them.
- **Grabs versus `<popup>`.** Menus already take pointer grabs
  (`window.js:2017`). A drag beginning inside an open menu must not fight
  them; establish that the drag grab replaces the menu grab, and that closing
  the menu does not release ours.

---

## 10. Answering the three questions directly

1. **Is #126's API right?** The protocol plan is; the API needs three changes:
   ordinary host props instead of marker-carrying spread props (the existing
   dispatcher already does the work), declarative `dropAccept` promoted from a
   convenience to the mechanism that makes always-advertising safe, and no
   `dataTransfer` façade over an asynchronous transfer. Plus parsed `files`,
   a smarter `dropAccept` vocabulary, and the `XdndFinished` watchdog.
2. **Should the advertisement be lazy?** No — but the refcount you were
   reaching for is real; point it at the suppression rectangle instead of at
   the property. You get the same saving, with no race, no churn, and no
   Offscreen bookkeeping. And because `XdndAware` lives on top-levels only,
   none of this depends on the windowed/windowless decision from
   [windowed-regions.md](windowed-regions.md) — including a `<box windowed>`
   that document recommends never shipping.
3. **How well do the two sides work together?** Very well, if the drag session
   is one object with two transports rather than two features. Target-side
   routing and source-side target tracking are the same enter/leave/accept
   state machine; in-app drags reuse it with no X11 at all; and an app written
   against Phase 2 gains cross-application drops in Phase 3 without touching
   its code. With ntk 5.3.0 the source half is no longer gated on an upstream
   release ([§0.1](#01-audit-against-ntk-530)) — the only argument left for
   splitting it out of #126 is size, not dependency.

---

## 11. Sources

- XDND protocol specification —
  [freedesktop mirror](https://www.accum.se/~vatten/XDND.html) (v5 field
  layouts, `XdndStatus` flag bits, `XdndFinished` v5 additions) and the
  [tkDND copy](https://users.iit.demokritos.gr/~petasis/Tcl/tkDND/XDND_Protocol/xdnd.html)
  (versions 0–4, property semantics, target non-response rules). Fields were
  cross-checked between the two; they agree.
- [Drag-and-Drop Protocol for the X Window System](https://www.freedesktop.org/wiki/Specifications/XDND/)
  — canonical home of the spec.
- [XQuartz#173 — drag and drop from Mac to X11 not working](https://github.com/XQuartz/XQuartz/issues/173)
- [`dnd-core`](https://github.com/react-dnd/dnd-core) — the DOM-free core
  behind react-dnd's pluggable backends.
- [`mwh/dragon`](https://github.com/mwh/dragon) — a small XDND source/target,
  useful as a manual test peer.
- ntk releases audited in §0.1:
  [5.0.0](https://github.com/sidorares/ntk/releases/tag/v5.0.0) (buffered
  requests), [5.2.0](https://github.com/sidorares/ntk/releases/tag/v5.2.0)
  (`frameInFlight`),
  [5.3.0](https://github.com/sidorares/ntk/releases/tag/v5.3.0) —
  [ntk#164](https://github.com/sidorares/ntk/issues/164) (INCR write, any
  format), [ntk#163](https://github.com/sidorares/ntk/issues/163) (selection
  watch), [ntk#155](https://github.com/sidorares/ntk/issues/155) (cancellable
  `close`).
- In-tree: [events.js](../../src/events.js), [nodes.js](../../src/nodes.js),
  [Reconciler.js](../../src/Reconciler.js), [styles.js](../../src/styles.js),
  [windowed-regions.md](windowed-regions.md), [ecosystem.md](../ecosystem.md);
  ntk 5.3.0 `lib/clipboard.js`, `lib/window.js`, `lib/cursor.js`,
  `lib/index.js`; node-x11 `lib/framebuffer.js`,
  `lib/xserver/properties.js`, `lib/xcore.js`.

# Accessibility: an AT-SPI2 bridge with no mirror, and where it lives

Design record for the accessibility layer that shipped in core — the _why_
behind [accessibility.md](../accessibility.md), which is the reference for
what the API is. Written as built, not as proposed: the alternatives below
were live options at the time and the reasons they lost are the useful part.

_Checked at react-x11 `a937436` (master, 2026-08-07), **ntk 7.2.0**,
`dbus-native` 0.15.1, against at-spi2-core 2.60.4 (the installed
introspection data) and at-spi2-core's `xml/` interface definitions (the
wire spec). Verified live against this desktop's registry with libatspi
(python3 `gi.repository.Atspi`) and with Orca's own speech log. File:line
references drift with the code._

---

## 0. TL;DR

- **Linux accessibility is D-Bus, not X.** An app exposes a tree of objects
  implementing `org.a11y.atspi.*` on a dedicated _accessibility bus_ and
  registers with the AT-SPI registry daemon; Orca walks that. Being a
  pure-JS X11 client blocks nothing.
- **Two modules.** `src/a11y.js` is the model: pure functions from the
  retained node tree to roles/names/states, plus null hook slots the
  renderer polls (the trace-registry pattern — one property read per event
  when off). `src/atspi.js` is the bridge: D-Bus plumbing, dynamically
  imported once per process when a root exists. The model is unit-testable
  with no bus anywhere; the bridge is testable against an in-process bus.
- **No mirror tree.** Every AT call is answered from the live node tree at
  the moment it arrives. The only per-node bridge state is the object path,
  the exported interface list, and a snapshot of what the bus was last
  _told_ — kept solely to turn "something changed" into the precise AT-SPI
  event diff.
- **The vocabulary is the web's** (`role`, `aria-*`), not React Native's
  `accessibilityRole` family that NEXT_STEPS §11.3 originally recommended.
  RN itself adopted the ARIA names in 0.71, and the widgets here had been
  carrying web role strings for months. Role→AT-SPI mappings follow what
  Chromium and Firefox send on Linux, so Orca sees from a react-x11 app
  what it sees from a browser.
- **In core, not `@react-x11/a11y`.** The dependency argument for a sibling
  package dissolved when D-Bus landed in core as an `optionalDependency`;
  what remained was a peer-version matrix and an opt-in accessibility
  layer, which is an accessibility failure.
- **Off is free and silent.** A four-rung ladder (transport → session bus →
  `GetAddress` → connect+`Embed`), every rung failing into "off" with no
  log and no mode; the bridge's socket is `unref()`d so it never holds the
  process open. Discovery dials a **private, short-lived connection** —
  deliberately not the shared `sessionBus()` — see §7.

## 1. The constraints that shaped it

Three personas had veto power:

1. **The machine with no accessibility stack** — ssh -X, CI, containers,
   macOS/XQuartz, bare `startx`. react-x11's flagship configurations. The
   layer must cost them nothing: no import weight, no connection attempts
   that log, no event-loop hold, no new mode. This is the same rule
   [dbus.md](../dbus.md) established: "no bus" is a first-class
   configuration.
2. **The screen-reader user on a desktop.** For them the tree has to be
   _correct_, not merely present: states that match the pixels, focus
   events at the moment focus moves, text deltas as they type, and controls
   that can actually be driven. Half an implementation — a tree with stale
   states — is worse than none, because the user cannot tell which half to
   trust.
3. **The component-library author targeting react-x11.** They must not need
   a react-x11-specific integration. Standard props on host elements had to
   be the entire seam.

And one engineering constraint: the renderer's hot paths (focus moves,
every `applyProps`, every text repaint) get touched. The cost of
accessibility being _off_ had to be one nullable property read per site,
which is the same bar `trace-registry.js` set for the protocol tracer.

## 2. Where accessibility actually happens

The at-spi2-core `xml/` directory is the wire spec, and the shape is:

- A **separate bus**, not the session bus. `org.a11y.Bus.GetAddress` on the
  session bus answers its address (activating `at-spi-bus-launcher` on
  demand); `AT_SPI_BUS_ADDRESS` overrides.
- The app exports objects at `/org/a11y/atspi/accessible/<id>` implementing
  `Accessible` (tree + role + states) and per-capability interfaces:
  `Component` (geometry, hit test, focus), `Action`, `Value`,
  `Text`/`EditableText`. The app root at `…/accessible/root` adds
  `Application` and calls `org.a11y.atspi.Socket.Embed` on the registry,
  which replies with the desktop ref the root reports as its `Parent`.
- ATs bulk-load through `org.a11y.atspi.Cache.GetItems` (one struct per
  node) and then track **signals**: `org.a11y.atspi.Event.Object.*`
  (`StateChanged`, `ChildrenChanged`, `TextChanged`, `TextCaretMoved`,
  `PropertyChange`, `Announcement`, …) and `Event.Window.*`
  (`Activate`/`Deactivate`/`Create`/`Destroy`), all with the same
  `siiva{sv}` body. Orca's model of the app is built almost entirely from
  these; getting their _details_ right (state nicks like `"focused"`,
  insert/delete offsets in code points) is most of the work.
- Toolkit-less apps are expected to drive this themselves rather than
  inherit it from GTK. That is what `src/atspi.js` is.

Enum values (roles, states, relations) were generated from the installed
`gi.repository.Atspi` — the very tables Orca reads — and are append-only
upstream, so they are pasted into `a11y.js` as frozen data with the
regeneration one-liner in a comment, not fetched or computed.

## 3. The two-module split, and the hook-slot seam

```
nodes.js / events.js / Reconciler.js          (hot paths)
        │  a11yHooks.focus?.(…)  — null when off
        ▼
src/a11y.js       the model: role/name/states/tree-projection as pure
                  functions; the hook slots; startA11y() gate
        │  dynamic import, once, when a root exists and the gate passes
        ▼
src/atspi.js      the bridge: bus dial, Embed, per-node export, the
                  event queue/flush, the interface implementations
```

The precedent is `trace-registry.js`: an always-imported module whose whole
idle cost is null slots, with the heavy half behind a dynamic import. Two
consequences fall out of the split being _exactly at the D-Bus line_:

- Everything semantically interesting — what role a node has, what its name
  resolves to, which states are set, what the accessible tree looks like
  after pruning — is computable and testable with **no bus in the
  process** (`test/a11y.test.js`). The bridge test then only has to prove
  plumbing, not semantics.
- The bridge can be rewritten (Wayland's a11y future, a different
  transport) without touching the model or the renderer wiring.

The renderer chokepoints wired to slots: `insertBefore`/`removeChild`
(tree), `applyProps` (props), `TextChunkNode.setText` (label content),
`TextInputNode._repaint` (value/caret/selection — every edit path funnels
through it), `EventManager.focus` (the one place focus moves),
`_onWindowFocus` (WM focus), `appendChildToContainer`/
`removeChildFromContainer` (toplevels), `resetAfterCommit` (flush). Focus
and focusability deserve a note: the focusable rule used to exist twice
(`EventManager._isFocusable` and `Node._focusableForRing`); it now lives
once in `a11y.js` and both call it, so the keyboard, the focus ring and the
FOCUSABLE state cannot disagree by construction.

## 4. No mirror

The obvious design — GTK's, historically — is a shadow "accessible object"
per widget, kept in sync. The whole class of bugs that produces (stale
name, stale index, remove-before-add races) comes from the mirror being a
second copy of the truth.

Here there is no copy. `GetChildren` walks the live `node.children` through
the projection (§5) at call time; `GetState` recomputes from live props and
live focus; `GetExtents` reads `node.abs` and the window's live
`_screenOrigin`. An answer cannot be stale because nothing is cached to go
stale.

What _is_ kept per exported node — `{ id, ifaces, snapshot }` — exists for
one reason: **events are diffs, and a diff needs a "before".** The snapshot
holds the last name/description/states/value/text the bus was told.
`syncNode()` recomputes, XORs the two u32 state words, and emits one
`StateChanged` per flipped bit with its enum nick; `_diffText` runs a
common-prefix/suffix diff over the code-point arrays and emits the
`delete`+`insert` pair with exact offsets. This is also what makes the
wiring correct without per-prop plumbing: _any_ prop change queues the
node, and whatever actually changed is what gets emitted.

Object **export is lazy**: a node is exported the first time a ref to it is
handed out (`refFor`), which transitively means "the first time an AT could
possibly call back on it". Per (node, interface) the impl object is
`{ __proto__: sharedProto, b: bridge, n: node }` — the prototypes hold all
behaviour, dbus-native reads properties through the chain, and the per-node
cost is a couple of two-field objects. Signals are emitted through raw
`bus.sendSignal` rather than dbus-native's EventEmitter hook-up, so impls
need no emitter machinery. On detach, the subtree is walked, each exported
node unexported with a `Cache.RemoveAccessible`, and the parent gets one
`ChildrenChanged remove` — but only if the AT had ever seen the child;
what the bus was never told about, it does not need to hear removed.

## 5. The tree projection

The accessible tree is the node tree through three rules:

- **Pruned subtrees**: `aria-hidden`, the internal content kinds
  (`textchunk`, `svgchild`), `<text>` spans (the outer `<text>` speaks for
  the run), and everything under `<glarea>` (scene nodes have no
  rectangles). Gone entirely.
- **Erased nodes**: `role="none"`/`"presentation"` — the node vanishes and
  its children take its place, ARIA's semantics. This is what keeps a
  styling wrapper from adding a filler level around every widget.
- **Defaults**: `<box>` is FILLER — the role GTK gives its own layout
  containers and screen readers step over silently — so an unlabelled tree
  is _boring_ rather than noisy. Everything with real semantics defaults to
  them (window→FRAME, text→LABEL, textinput→ENTRY, image→IMAGE, …).

Two structural notes. `<popup>`s stay **nested**: a popup's `parent` is the
JSX node it was written under, so a menu appears inside the widget that
opened it — GTK4 does the same with popovers, and it preserves context that
promoting popups to application children would lose. Screen coordinates
still resolve correctly because extents go through the _owning window's_
`_screenOrigin`, and the popup is its own window. And name-from-contents
(button/menuitem/tab/… with no `aria-label`) concatenates the subtree's
chunk text — which is why `MenuRow` sets `aria-label` explicitly: without
it the shortcut column and the submenu arrow would read into the name
("New Ctrl+N ▸").

## 6. Events: queue, collapse, flush

Hook calls do not emit; they queue. The flush runs at `resetAfterCommit`
(so a commit's worth of mutations is one batch) and, for changes that
happen outside commits — pointer-driven focus, typing into an uncontrolled
input — on a `queueMicrotask` fallback. Collapse rules:

- **Removals first**, so a node that left and rejoined in one batch reads
  as its add, never as a stale remove.
- **Attaches collapse to the topmost node** per subtree: the AT gets one
  `ChildrenChanged add` + `Cache.AddAccessible` and descends on its own.
  The initial bottom-up construction of a tree costs _nothing_ — a detached
  subtree is not "live" (§3's `_live` walk) until its top joins a mounted
  toplevel, so React building a window queues zero events until the
  container mount, which then announces exactly one child.
- Focus emits `StateChanged focused` on both ends **plus** the legacy
  `Event.Focus.Focus` on the gaining node, because that is what the GTK
  bridge emits and older ATs still listen for the pair.

## 7. The ladder, and why discovery dials its own socket

`startA11y()` (called from `createRoot`, never awaited): gate →
`import('./atspi.js')` → transport → session-bus address → `GetAddress` →
connect → export root + `Cache` → `Embed` → install hooks → walk
already-mounted toplevels (via `trace-registry.onApp`). Every failure is a
silent off; `REACT_X11_A11Y=1` makes each rung print why it stopped, which
is the entire debugging story for "Orca doesn't see my app".

The one non-obvious decision: **the `GetAddress` probe uses a private
connection, opened and closed inside the call, not the shared
`sessionBus()`**. The shared machinery is process-global state, and the
climb is an unowned background task — the combination raced this repo's own
test harness, which swaps `DBUS_SESSION_BUS_ADDRESS` to a per-test broker
and hard-resets the shared state between cases; an in-flight climb from an
earlier test corrupted a later test's portal reads. The fix is not "be
careful", it is _no shared state_: a probe that owns its socket cannot
interfere with anyone, and as a bonus the shared session connection is no
longer dialled (and kept warm) as the side effect of a probe on machines
where nothing else wants D-Bus.

Related hygiene, borrowed from the ecosystem: `NO_AT_BRIDGE` is honoured —
it is what at-spi2-atk checks and what GTK's own test suite sets — and
`react-x11/test` sets it, so a suite running on a developer's desktop does
not parade hundreds of phantom applications through a live screen reader.
Priority order: `REACT_X11_A11Y` (explicit, either way) →
`AT_SPI_BUS_ADDRESS` (an address is intent — it is also the hermetic test
seam) → `NO_AT_BRIDGE` → on.

The bridge holds no event-loop reference (`stream.unref()`): it is a
passenger, not cargo, and a process with no other work exits — the
registry sees the name drop, which is AT-SPI's own liveness model. A dead
accessibility bus is not redialled, the same no-resurrection contract as
`bus.js`; the registry _restarting_ is survivable though — the bridge
watches `NameOwnerChanged` on `org.a11y.atspi.Registry` and re-embeds,
exactly as the GTK bridge does.

## 8. AT-driven input goes through the front door

- **Activation** (`Action.DoAction("activate")`) dispatches a synthetic
  **full press gesture** — MouseDown, MouseUp, Click — through
  `EventManager.dispatch` at discrete priority with the frame flush, so an
  AT press is indistinguishable from a finger: capture/bubble order,
  `:active` styling, the commit, the paint. The full gesture rather than a
  bare Click was a live-testing find: `Select` and `MenuBar` open their
  menus **on the press**, as real menus do, and a Click-only activation
  silently did nothing on exactly those controls. Coordinate-driven
  _default_ actions (caret placement, drag arming) are deliberately not
  invoked — a synthesized centre point is not a place the user chose.
- **Value writes** (`Value.CurrentValue` set) route to the node's
  `onAccessibilityAction({ action: 'setValue', value })`, wrapped in
  `callHandler` so a throwing handler cannot unwind into dbus-native's
  message dispatch. `Slider` wires it into the same clamp/quantize/emit as
  the pointer and the keyboard — one state path, three input routes.
- **Edits** (`EditableText`) go through `TextInputNode._commit`, the same
  single mutation point typing uses, so `onChange` fires and undo history
  records — an AT edit _is_ a user edit. Offsets need no conversion
  anywhere: AT-SPI counts code points, and `_chars()`/`_caret` already do.

## 9. Testing

Four layers, each catching what the one below cannot:

1. **Model** (`test/a11y.test.js`) — no bus: roles, names, states,
   projection, widget wiring, over the mock app.
2. **The spy** (`src/testing/a11y.js`, `test/a11y-spy.test.js`, and the
   layer applications are meant to use via `renderX11({ a11y: true })`) —
   the hook slots are the seam the bridge itself consumes, so a spy
   filling the same slots observes the same contract with no transport:
   synchronous, bus-free, Node-20-and-macOS-safe. It reuses the bridge's
   own snapshot-and-diff idea in miniature, and it doubles as a renderer
   regression net — a chokepoint that stops calling its hook fails these
   tests exactly as it would silence Orca. The utterance strings it (and
   `scripts/a11y-probe.mjs`) produce come from one shared `utteranceOf`,
   deliberately documented as react-x11's model rather than an imitation
   of Orca's wording, which is presentation policy that shifts between
   releases.
3. **Hermetic bridge** (`test/atspi.test.js`) — dbus-native's
   `createBroker()` is a real in-process message bus (routing, names, match
   rules); a stub client owns `org.a11y.atspi.Registry` and answers
   `Embed`; `AT_SPI_BUS_ADDRESS` points the bridge at it, so everything
   from the address onward is the production path. A second client plays
   the screen reader with raw `invoke` calls and a signal tap, asserting
   wire-level facts: struct shapes, state bits, text-diff offsets, the
   press gesture, cache items. Skips itself on Node 20 where the transport
   legitimately is not installed.
4. **Live** — not automated, but scripted and repeatable:
   `scripts/a11y-probe.mjs` is the AT side of the wire in dbus-native
   (tree dumps, an event tail, `--speak` through speech-dispatcher), and
   python3 `gi.repository.Atspi` is libatspi, Orca's own client stack —
   `get_desktop(0)` → find the app → walk/`do_action`/`set_current_value`
   exercises the real registry, with `orca --debug-file=…` grepped for
   `SPEECH OUTPUT` as ground truth. Those runs confirmed the whole chain
   ("Press me — button", "check box checked", "horizontal slider — 80
   percent", menus opening from AT activation) — and found a real bug on
   first contact: `GetRoleName` answered the ARIA vocabulary while
   `GetRole` answered the AT-SPI number. Invisible to libatspi, which
   derives role names locally from the number and never asks — exactly
   the class of defect only a second, independent client exposes, and the
   argument for the probe existing at all.

## 10. Alternatives rejected, for the record

- **A sibling `@react-x11/a11y` package** (the original §11.3 sketch).
  Made sense when D-Bus was going to be an external dependency; once
  `dbus-native` became core's own optionalDependency the split bought a
  version matrix and an opt-in accessibility story, and "install another
  package to be accessible" is the wrong default in a way no engineering
  argument offsets.
- **The RN prop vocabulary** (`accessibilityRole`, `accessibilityState`).
  Overtaken by RN itself (0.71 added the ARIA names); and the widgets'
  existing `role` strings — written before anything read them — were
  already the web's.
- **A mirror/shadow accessible tree.** §4; the sync-bug class it invites
  is the thing GTK4's rewrite spent years digging out of.
- **Gating on `org.a11y.Status.IsEnabled`** (Qt's behaviour) rather than
  connecting whenever the bus exists (GTK's). One more mode, one more
  property watch, to save a tree that is only maintained when something
  queries it anyway. GTK's answer is smaller.
- **Per-node dbus-native interface exports with EventEmitter signal
  hook-up.** dbus-native wraps `emit` per exported object; with thousands
  of nodes that is machinery nobody asked for. Raw `sendSignal` plus
  prototype-shared impls keeps per-node cost to two small objects.
- **`aria-live` region tracking.** The DOM needs it because content
  changes are the only signal; here `announce()` is explicit, cannot fire
  on renders you did not mean, and maps onto the modern
  `Event.Object.Announcement` Orca ≥ 45 speaks.

## 11. Deferred, and what each needs

| gap                                                                | what it waits on                                                                                                                            |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| relations (`aria-labelledby`, label-for)                           | an element-id registry; `aria-label` + name-from-contents cover the widgets                                                                 |
| `Selection` interface on containers                                | per-item SELECTED states + actions already carry selection; this is polish                                                                  |
| `Table` interface (row/col navigation calls)                       | honest `table`/`row`/`cell` roles + posinset shipped; the interface matters most with virtualization, where only rendered rows exist at all |
| key-event forwarding (`DeviceEventController.NotifyListenersSync`) | per-keystroke echo of keys themselves; typed characters already arrive as text-changed events                                               |
| soft-wrap line granularity in `<textarea>`                         | ntk layout lines are available (`caretPosition(...).line`); the work is boundary bookkeeping in the Text impl                               |
| `GetApplicationBusAddress` peer-to-peer mode                       | niche; empty string is a valid "no"                                                                                                         |

## 12. Sources

- at-spi2-core `xml/` — the D-Bus interface definitions (fetched from the
  GNOME repo at implementation time; `Accessible.xml`, `Cache.xml`,
  `Socket.xml`, `Event.xml`, `Text.xml`, …).
- `gi.repository.Atspi` 2.60.4 on this machine — enum values, and the
  client stack used for live verification.
- The GTK (at-spi2-atk / GTK4) and Qt (`atspiadaptor`) bridges, and
  Chromium's `ax_platform_node_auralinux` — prior art for role mappings,
  event pairs, `NO_AT_BRIDGE`, and registry-restart handling.
- Orca — both as the consumer whose event diet defines "enough", and
  directly: its debug speech log is the acceptance test.

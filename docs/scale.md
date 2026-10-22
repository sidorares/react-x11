# Display scale

Every length in react-x11 is a **logical pixel**: a unit sized so that
`fontSize: 14` is comfortably readable at the distance the display is
actually viewed from. On the panels of the last decade one logical pixel is
two device pixels — or 1.5, or 1.25 — and the renderer multiplies exactly
once, on the way to the server. An app says nothing and gets a UI the same
physical size on a 2013 monitor and a retina laptop.

```jsx
const root = await createRoot();               // scale: 'auto' is the default
const root = await createRoot({ scale: 2 });   // pin it
REACT_X11_SCALE=1.5 node app.js                // the user outranks everybody
```

```jsx
import { useScale } from 'react-x11';
const scale = useScale(); // 1, 2, 1.5... static for the life of the root
```

## What is logical and what is device

**Logical — everything application code touches:**

- every style length (`width`, `padding`, `fontSize`, `borderRadius`, the
  lengths inside `boxShadow` and gradient stops, `hitSlop`…)
- window geometry props (`width`, `height`, `x`, `y`, `minWidth`…) and the
  `onResize` payload
- event coordinates: `ev.x`/`ev.y`/`ev.localX`/`ev.localY`, wheel
  `deltaX`/`deltaY`, drag `screenX`/`screenY`
- `getClientRects()`, `measure()`, `useScreens()` rects,
  `anchorRect`/`centerRect`/`anchorArea`
- the scroll surface: `scrollTo()`/`scrollBy()` arguments, `onScroll` and
  `onViewport` payloads
- the theme: `DefaultTheme.fontSize` is 14 and stays 14

**Device — the renderer's internals and the deliberate escape hatches:**

- `node.abs`, yoga's computed layout, everything painted
- `node.scrollX`/`scrollY`/`contentWidth`/`contentHeight` read directly off
  a ref (positions in the rendered surface; use the `onScroll` payload for
  logical math)
- `<canvas onDraw>`: the browser's own canvas contract — the box arrives in
  device pixels and the payload carries `scale`, so detail is drawn on the
  real grid. It is deliberately not pre-scaled with `ctx.scale()`: text
  drawn through a scaled transform moves without growing.
- a registered element's `paint()` and `hitTest()` (see
  [extending.md](extending.md)): `this.style` and `this.abs` arrive already
  device, and so are `paintDamage()`, the rects handed to `invalidate` and
  `scrollContents` and the rects of an a11y scene; synthetic events are
  logical, and `this.scale` is on every node for the constants that never
  pass through a style and the event coordinate on its way to `abs`.

Fonts are the point of the whole exercise: a `fontSize: 14` at scale 2 is
shaped, measured and rasterized at 28px. Text on a retina panel is _sharper_,
not bigger-blurrier.

Fractional scales (`1.25`, `1.5`) work end to end, with the usual X11
caveat: a 1-logical-px hairline at 1.25x is 1 or 2 device pixels depending
on where it lands. Integer scales have no such seams.

"Logical" is per node rather than per window as soon as a `scale` prop is in
the tree: everything in the first list is divided by the scale of the node
it is about, which is the display's until an enclosing `scale` says
otherwise. See [A subtree of its own](#a-subtree-of-its-own) below.

## How `'auto'` decides

X11 has no scale protocol, so `'auto'` consults these in order and takes the
first that answers:

1. **Environment** — `REACT_X11_SCALE` (wins over everything, an explicit
   `scale:` number included: it is the accessibility escape hatch), then
   `GDK_SCALE`, then `QT_SCALE_FACTOR`.
2. **XSETTINGS** — `Gdk/WindowScalingFactor` when it is 2+, then `Xft/DPI`:
   what the desktop's own settings dialog writes.
3. **`RESOURCE_MANAGER`** — `Xft.dpi`, the `xrdb` convention.
4. **RandR millimetres** — the panel's physical size against its pixel
   size, per output, under mutter's viewing-distance model: the DPI that
   counts as 1x is 135 under a 20″ diagonal and 110 over it, snapped to
   quarter steps in [1, 3]. A 27″ 2560×1440 monitor is 1x, a 27″ 4K 1.5x, a
   16″ MacBook panel 2x.
5. **The resolution class** — when the millimetres are absent or not
   credible: a grid ≥3000 wide, or taller than 1600 on its short side, is
   2x, and everything else 1x. 2560×1440 and 2560×1600 stay 1x.
6. **1.**

**96 is not an answer**: `Xft.dpi: 96` and `Gdk/WindowScalingFactor: 1` are
what daemons publish when nobody opened the dialog, so they fall through to
the hardware rather than pinning an unconfigured 4K laptop to 1x. And
**millimetres are believed only when credible**: zeroes, aspect ratios
posing as sizes, a physical/pixel aspect mismatch and virtual machines'
monitors (by EDID — QEMU, VMware, VirtualBox, Parallels, Hyper-V — and by
connector name, `Virtual-*`, `qxl`, …) fall through to rung 5. So do
`XWAYLAND*` outputs' millimetres: the compositor owns scaling there and
publishes its decision through rung 2.

### Servers that are not describing hardware

Rungs 4–5 read a panel, so they are skipped where the connection has none:

- **XQuartz** (the `Apple-WM` extension) hands X macOS's point space,
  already normalised for density, and macOS scales the window onto whichever
  panel it lands on. The answer is 1x, with the source `xquartz`.
- **A single synthetic output covering every monitor** — Xvfb, x11vnc,
  TigerVNC, Xephyr and pre-RandR drivers — would read the union of two 1x
  monitors as a retina panel, so rung 5 is skipped when Xinerama reports
  more heads than outputs. Credible millimetres (rung 4) still count.

`REACT_X11_SCALE`, `GDK_SCALE` and a desktop's own XSETTINGS still win over
both. `REACT_X11_DEBUG_SCALE=1` in an app prints how the ladder resolved.

## On Wayland

A compositor has a scale protocol, and its answer is the display scale:
fractional-scale-v1 where it is offered (1.25, 1.5…), else
`wl_surface.preferred_buffer_scale`, else the integer `wl_output.scale` of
the output a window is on. Buffers are drawn at that density, so text is
as sharp at 1.5 as at 2. Two things still outrank it, as on X11:

- **`REACT_X11_SCALE`, then `createRoot({ scale })`** pin the factor,
  absolutely: device (buffer) pixels per logical pixel. On a compositor at
  1x, `REACT_X11_SCALE=2` is a window twice the size drawn at full
  resolution, not a small one stretched.
- **The resolution class, when the compositor says 1.** When every output
  is at 1x and the largest has no credible millimetres but a retina-class
  grid — a VM window over a retina panel — the layout is 2x, as the X11
  ladder answers for the same screen through Xwayland. A compositor that
  scales any output, or credible millimetres, keep the compositor's answer.

The frame a window draws for itself follows the compositor, not the
layout: it is drawn at the desktop's scale, beside every other window's.
`REACT_X11_DEBUG_SCALE=1` prints which of these answered.

## Several monitors

Rungs 4–5 are computed for every connected output. The **root's** scale —
the one layout and paint use — is the primary output's (the largest, where
nothing is flagged primary), as GNOME does on X11: one scale for the
session.

The per-output answers ride on `useScreens()` — every entry carries its own
`scale` — so an app that places windows can do better, and a window can be
pinned with `createRoot({ scale })` per root. A window is **not** re-scaled
as it is dragged between mismatched monitors: X11 has one coordinate space
and no per-window scale protocol, so the scale is chosen at creation and
static after.

It is static for the session too: a mid-session change of `Xft.dpi` or a
monitor swap does not re-scale running windows. Restart the app.

## A subtree of its own

The display scale is one number for the whole window. `scale` on an element
is a second factor for one **subtree** of it:

```jsx
<box scale={zoom} style={{ width: w / zoom, height: h / zoom }}>
  <NodeBody /> // written in plain logical pixels, unaware of the zoom
</box>
```

The semantics are CSS's `zoom`, not a transform:

- A node's **effective scale** is its parent's times its own `scale` prop,
  so nested props multiply and the display scale is the floor they multiply.
  `node.scale` is that number, and everything the display scale reaches —
  styles, the caret and scrollbars, shadows and gradients, a registered
  element's own `paint()` — follows it.
- **The node's own style scales too.** `scale={2}` on a box with
  `padding: 8` gets 16 device pixels of padding, not 8 with bigger children
  inside it. That is what makes the caller's job the one-liner above: divide
  the size you want the box to occupy by the zoom, and write everything
  inside it at 1x.
- **Text is shaped at the size it is drawn at.** A `fontSize: 14` inside
  `scale={2}` is shaped, measured and rasterized at 28 — the same thing the
  display scale does, for the same reason. A zoomed-in graph is not a
  stretched screenshot of a zoomed-out one.
- **Yoga lays out the scaled numbers** like any others, so a zoomed subtree
  wraps, flexes and measures its content floors at the size it is drawn.

What it is for: an element that owns a viewport — a graph pane, a canvas, a
map — and mounts application content inside it. The pane draws its own
world, and the React subtree beside it follows the same zoom, laid out,
drawn and hit at the zoomed size.

### What a boundary costs

**Events are in the target's unit.** `ev.x`, `ev.y`, `localX`/`localY` and
`getClientRects()` on a node inside a zoomed subtree are all divided by
_that node's_ scale, so they agree with each other and with the styles it
was written in — a handler inside the subtree needs to know nothing. The
trade-off is CSS `zoom`'s: a handler on an **unzoomed ancestor** reads a
coordinate in the zoomed descendant's unit, because the target is what
decides. When a pane needs its own coordinates for a hit that landed inside
the content it hosts, `ev.nativeEvent` is the way back — device pixels of
the window, which `/ node.scale` converts to whichever unit is wanted.
`screenX`/`screenY` are unaffected: they are desktop coordinates, and the
desktop has one scale.

A wheel notch scrolls `48` of the target's logical pixels, so content under
the pointer travels the distance the zoom says it should.

**A real X window is its own root.** `<window>` and `<popup>` take no
`scale` prop and ignore an enclosing one: their geometry is the server's, a
window manager sees no zoom, and a menu opened from a zoomed card should
come up at the size the rest of the app's menus are. `<glarea>` and
`<foreign>` do inherit — their boxes are laid out by the parent like any
other child's.

**Quantise a gesture-driven zoom.** Every distinct factor is a distinct
font size to shape and cache, so a wheel handler feeding the raw accumulator
into `scale` makes a new set of glyphs per frame. Round to a step — 5%, or
a ladder of preset zooms — and the cache does its job.

## In tests

The headless harnesses resolve to exactly 1 — a mock app has no display to
ask — so a geometry assertion means its numbers literally.
`createRoot({ app, scale: 2 })` opts a test in, and so does
`renderX11(element, { scale: 2 })` from `react-x11/test`.

Design notes — the ladder's rationale, prior art, and why lengths are
multiplied rather than the context transformed:
[design/scale.md](../design/scale.md).

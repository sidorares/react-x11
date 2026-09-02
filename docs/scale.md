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
  real grid. Deliberately **not** a `ctx.scale()`: ntk positions glyphs
  through the transform but sizes them from the font, so a scaled transform
  would move an app's `fillText` without growing it — and it would knock
  every fill off ntk's server-side fast paths besides.
- a registered element's `paint()` and `hitTest()` (see
  [extending.md](extending.md)): `this.style` and `this.abs` arrive already
  device, and so are `paintDamage()`, the rects handed to `invalidate` and
  `scrollContents` and the rects of an a11y scene; synthetic events are
  logical, and `this.scale` is on every node for the constants that never
  pass through a style and the event coordinate on its way to `abs`.

Fonts are the point of the whole exercise: a `fontSize: 14` at scale 2 is
shaped, measured and rasterized at 28px. Text on a retina panel is _sharper_,
not bigger-blurrier — the same reason every native toolkit renders this way
instead of transform-scaling a 1x picture.

## How `'auto'` decides

X11 never grew a scale protocol, so the answer is scattered across four
generations of convention. The ladder consults each rung only when the ones
above said nothing, ordered by "who is closest to a human having decided":

1. **Environment** — `REACT_X11_SCALE` (ours, wins over everything including
   an explicit `scale:` number — it is the accessibility escape hatch), then
   `GDK_SCALE`, then `QT_SCALE_FACTOR`. The user already told their other
   toolkits; an app of ours on the same desktop should agree.
2. **XSETTINGS** — `Gdk/WindowScalingFactor` when it is 2+, then `Xft/DPI`
   (in 1024ths of a dpi on the wire; a daemon writing plain dpi is read
   right too). This is what the desktop's own settings dialog writes and
   what every GTK app on the screen is already obeying.
3. **`RESOURCE_MANAGER`** — `Xft.dpi`, the `xrdb` convention winit,
   Chromium and every terminal emulator read.
4. **RandR millimetres** — the panel's physical size against its pixel
   size, run per output, under mutter's viewing-distance model: the DPI
   that counts as "1x" is 135 under a 20″ diagonal (a panel in your lap at
   ~50cm) and 110 over it (across a desk). Snapped to quarter steps in
   [1, 3]. For calibration: a 27″ 2560×1440 desk monitor computes 109dpi →
   1x; a 27″ 4K computes 163dpi → 1.5x; a 16″ MacBook panel computes
   255dpi → 2x, matching macOS.
5. **The resolution class** — when the millimetres are absent or caught
   lying, the pixel grid itself is the last signal: nothing ships a 1x
   panel with a ≥3000-wide or ≥1800-short-side grid, so those are called 2x
   and everything else 1x. Only the confident call is made without physical
   data — 2560×1440 stays 1x on purpose, because it is the commonest 1x
   desk monitor there is and only millimetres could tell it from a 13″
   retina lid.
6. **1.**

Two readings deserve their asterisks. **96 is not an answer**: `Xft.dpi: 96`
and `Gdk/WindowScalingFactor: 1` are what daemons publish when nobody ever
opened the dialog (xfsettingsd writes both unconditionally), so they fall
through to the hardware instead of pinning an unconfigured 4K laptop to
microscopic. And **millimetres are audited before they are believed**
(`classifyMm`): zeroes, aspect-ratios-as-sizes (16×9 "millimetres"),
physical/pixel aspect disagreement, and — the one that motivated all of
this — virtual machines, detected by EDID vendor and model (`RHT` / "QEMU
Monitor", VMware, VirtualBox, Parallels, Hyper-V) and by connector name
(`Virtual-*`, `qxl`, …). `XWAYLAND*` outputs skip the hardware rung too:
the compositor owns scaling there and publishes its decision through rung
2, in both of its Xwayland modes.

### Servers that are not describing hardware

Rungs 4–5 read a panel, so they are skipped where the connection has no
panel to describe. Two cases, both of them servers people really run:

- **XQuartz**, detected by the `Apple-WM` extension. macOS composes the
  desktop in _points_ and hands X the point space, already normalised for
  density: a 16″ retina lid arrives as 1728×1080, a 1x monitor beside it as
  2560×1403, and the window server scales what it is given onto whichever
  panel the window lands on. Inferring a factor here doubles a size macOS
  is about to double again, so the ladder answers 1x with the source
  `xquartz` — the same exemption `XWAYLAND` gets, for the same reason.
- **A single synthetic output covering every monitor.** XQuartz, Xvfb,
  x11vnc and TigerVNC, Xephyr and pre-RandR drivers answer the output walk
  with one output — usually named `default`, always without millimetres —
  whose CRTC is the _union_ of the desktop. Two 2560×1440 monitors union to
  5120×1440, which rung 5 reads as a retina panel; the machine this was
  found on unioned a retina lid and two 1x monitors into 5120×2520 and drew
  every widget at double size. Xinerama reports those heads separately, so
  more heads than outputs retires rung 5 (`isUnionOutput`). Rung 4 survives
  it — credible millimetres describe real glass however the pixels were
  divided up, which is what an `xrandr --setmonitor` split of one ultrawide
  is.

Both guards sit _below_ the configured rungs: `REACT_X11_SCALE`,
`GDK_SCALE` and a desktop's own XSETTINGS still win, because a person who
typed a factor outranks the platform.

### The machine this was built against

A 16″ MacBook panel handed 1:1 to a UTM Linux guest (XFCE, X11) defeats
rungs 1–4 simultaneously, which is why the ladder has five:

```
core screen      3456×2168 px, "914×573mm"   → synthesized to exactly 96dpi
XSETTINGS        Gdk/WindowScalingFactor 1, Xft/DPI 98304 (= 96·1024)
RESOURCE_MANAGER Xft.dpi: 96                 → the never-configured default
RandR            Virtual-1 "870×550mm"       → a 40″ panel that is 16″
EDID             vendor RHT, model "QEMU Monitor"  → the lie, signed
verdict          2x via the resolution class → correct
```

Every millimetre in that transcript is invented — QEMU fabricates a size
that makes the maths land on ~100dpi — and every configured source is an
untouched default. Run `node scripts/scale-probe.mjs` against any display
to see the same table for it, or `REACT_X11_DEBUG_SCALE=1` in an app to
watch the ladder resolve.

## Several monitors

Rungs 4–5 are computed for every connected output, because a desktop with a
retina lid and an office monitor genuinely has two answers. The **root's**
scale — the one layout and paint use — is the primary output's (the largest,
where nothing is flagged primary), matching what GNOME does on X11: one
scale for the session, chosen for the display you called primary.

The per-output answers ride on `useScreens()` — every entry carries its own
`scale` — so an app that places windows can do better, and a window can be
pinned with `createRoot({ scale })` per root. What this deliberately does
not do is re-scale a window as it is dragged between mismatched monitors:
X11 has one coordinate space and no per-window scale protocol, so that move
is a resize the window manager fights mid-drag; Qt is the one toolkit that
tries it, and "chosen at creation, static after" is the behaviour of
everything else on this window system.

Static-at-startup is the other honest limitation: a mid-session change of
`Xft.dpi` or a monitor swap does not re-scale running windows. Rare enough
that GTK3 apps mostly share it; restart the app.

## Prior art, and where this sits

| Toolkit                          | X11 sources, in order                                                                                     | Notes                                                                                                             |
| -------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| GTK 3/4                          | `GDK_SCALE` env; XSETTINGS `Gdk/WindowScalingFactor`                                                      | integer only; fonts via `Xft/DPI`                                                                                 |
| Qt 5/6                           | `QT_SCALE_FACTOR`, `QT_SCREEN_SCALE_FACTORS`; per-screen logical DPI (`Xft.dpi`), physical DPI from RandR | the only per-screen attempt on X11                                                                                |
| winit                            | `WINIT_X11_SCALE_FACTOR`; `Xft.dpi`; RandR mm                                                             | mm path famously burned by 1×1mm and VM EDIDs ([winit#1983](https://github.com/rust-windowing/winit/issues/1983)) |
| Chromium/Electron                | `Xft.dpi` via XSETTINGS then xrdb; `GDK_SCALE`                                                            | never trusts RandR mm                                                                                             |
| SDL 2/3                          | `Xft.dpi` only                                                                                            | 1x on every unconfigured desktop                                                                                  |
| mutter (the config UI's default) | per-monitor mm under the 135/110-dpi viewing-distance model                                               | the model rung 4 adopts, constants and all                                                                        |

The composition is the contribution: desktop configuration first (rungs
1–3, which is where Chromium/SDL stop — correct on configured desktops,
tiny on unconfigured HiDPI ones), mutter's perceptual model where the
hardware is honest (which is where winit's mm math stops — right until an
EDID lies), and the resolution class where it is not (which nobody else
has, and which is the only rung that survives a VM).

## Design notes

**Why multiply values instead of transforming the context.** Two hard
reasons, both ntk's. Its 2d context batches solid fills into server-side
`Render.FillRectangles` and takes similar fast paths for strokes, rounded
rects and glyph runs — all gated on an identity transform, so a frame-wide
`ctx.scale(2,2)` would rasterize every box in the UI as polygons. And its
text model sizes glyphs from the font while only _positioning_ them through
the transform, so scaled-transform text comes out moved but not grown.
Multiplying at the style funnel instead means paint code, damage rects, the
scroll blit and the paint cache all keep working in integer device pixels
with the transforms they always had. (`paintcache.js` even guards against
the other choice: a non-identity CTM disables it entirely.)

**Where the multiply lives.** One place for styles —
`scaleResolvedStyle()`, at the end of the style funnel in `_syncStyle`, so
state blocks, size queries and the flex shorthand all still think in the
logical pixels the app wrote. One place for the theme's font size — the
root branch of `inheritedTextStyle`, because descendants inherit an
already-resolved size and any second multiply would compound. One place for
window geometry (`scaleWindowGeometry`), one per string-parsed decoration
(`shadowSpecs`/`gradientSpec`, whose parses are memoized on the raw string
so the scale rides into the memo key), and division at each app-facing
egress (`SyntheticEvent`, `getClientRects`, `onScroll`, `useScreens`…).
`yoga` needs no `pointScaleFactor` games: layout runs directly in device
pixels and its ordinary whole-pixel rounding is what keeps a 1-logical-px
border crisp at 1.5x.

**Fractional scales** work end to end (`1.25`, `1.5`, quarter steps from
the ladder), with the usual X11 caveat: a 1-logical-px hairline at 1.25x is
1 or 2 device pixels depending on where it lands. Integer scales have no
such seams.

**What tests see.** The headless harnesses resolve to exactly 1 — a mock
app has no display to ask — so every geometry assertion in the suite means
its numbers literally. `createRoot({ app, scale: 2 })` opts a test in, and
so does `renderX11(element, { scale: 2 })` from `react-x11/test`;
`test/scale-render.test.js` is the boundary contract pinned as tests.
`setScaleForTests()` (from `src/scale.js`) pins a factor without a
connection.

**Known costs.** The paint cache's per-item budget is device pixels, so at
2x a widget occupies 4× the budget it did — icons and checkboxes still fit
comfortably. Damage rects, protocol traffic and backing stores scale the
same way any HiDPI surface does.

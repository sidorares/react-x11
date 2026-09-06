# Animation in styles: timelines, opacity, transforms, and who interpolates

_Design document, 2026-09-06. Written against master at c9ce902 (react-x11
2.6.1, ntk ^8.7.0, `@windowkit/appkit` ^0.4.0). File:line references will
drift with the code; the shape of the argument should not._

---

## 0. TL;DR

The style vocabulary already has two animation shapes — `transition` (a
change, over so many ms) and `animation` (a loop between two values) — and
one runtime that drives both: the window's frame clock, JS interpolation,
a damage claim per frame. That runtime is correct on every backend and is
the fallback everything below degrades to.

What an author cannot write today, in order of how often it comes up:

1. **A fade.** There is no `opacity`. The ecosystem page opens by saying so.
2. **A move that does not reflow.** There is no `translate`/`rotate`/`scale`;
   the Switch thumb slides on `start` and pays a yoga pass per frame for it.
3. **A timeline that ends.** `animation` loops forever by definition; an
   entrance, a shake, a pulse-three-times have no spelling.
4. **More than two stops**, an easing on a transition, a delay, a spring.
5. **Motion that survives a busy JS thread.** On macOS the retained layer
   presenter can hand a transition to Core Animation and stop scheduling
   frames for it; today it sets layer properties per frame like everything
   else.

The proposal is one vocabulary, four additions, and one execution rule:

- **Easing** becomes cubic-bezier control points under the hood, with names
  as aliases and springs as a second kind. This is the load-bearing change:
  it is what lets a JS evaluator and Core Animation agree on the same
  declaration (§3.1 has the numbers — mapping today's ease-out to CA's
  _named_ ease-out is 22% off at the peak; to control points it is 0.3%).
- **`transition`** grows a per-property object form with `easing` and
  `delay`, and `all` for the shorthand's slot.
- **`animation`** grows `keyframes`, `repeat` (default `Infinity`, so every
  existing loop keeps its meaning), `delay`, and `key` to re-trigger. A
  finite one rests at the declared value when it ends — the rule loops
  already follow, which turns out to be CSS's `fill-mode: none` for free.
- **`opacity`, `translateX`, `translateY`, `rotate`, `scaleX`, `scaleY`** as
  paint-only style properties on both backends. Free on a layer; an
  offscreen composite on X11, bounded to the subtree, with fast paths for
  the common cases (a leaf's opacity, a pure translate).
- **The presenter decides who interpolates.** The node model stays the one
  source of truth for _what_ is animating and _when it ends_. A presenter
  may take a property it can express on the node's own layer; anything it
  declines runs on the JS loop exactly as now. The layer presenter takes
  paint properties, opacity and transforms; layout properties stay on the
  JS loop everywhere, because yoga has to run.

Five bridge verbs stand between the layer presenter and that offload
(§4.4). The first — control-point timing functions — is a prerequisite,
not an enhancement: without it every existing transition would change its
look the day it moved to the render server.

**Status, 2026-09-06.** Bridge items 1–8 shipped in `@windowkit/appkit`
0.5.0 (§4.4). Landed in react-x11 on top of it: the presenter seam of §4.1
and the PropBox rows of §4.2 (`animate`/`cancel` in
src/cocoa/presenter.js, the `offloaded` entries in nodes.js), with additive
retargets for lengths and presentation-value retargets for colours, and
reduce motion on the Cocoa backend (src/desktopsettings.js's `fromMacOS`).
The vocabulary of §3 — easing, timelines, `opacity`, transforms — is still
to come; the control-point tables it needs exist (`EASING_CONTROL_POINTS`).

## 1. What exists

### 1.1 The vocabulary

`transition: number | { [prop]: ms }` — a number covers every animatable
property, an object picks them (docs/styling.md "Transitions"). One fixed
ease-out cubic (`ease`, src/styles.js:1121). A transition starts from what
is on screen, so an interrupted one reverses from where it got to
(`_retarget`, src/nodes.js:2066), and it starts at `now()` rather than the
last frame's timestamp, so an idle window does not find it already over
(#80). Nothing before a node's first frame transitions — an inserted
element appears at its style (`_placed`, test/transition-mount.test.js).
Layout properties may transition and cost a layout pass per frame; enums,
`zIndex`, `boxShadow` and `backgroundImage` snap (`NOT_ANIMATABLE`,
src/styles.js:726).

`animation: { [prop]: { from?, to, duration, easing?, alternate? } }` — a
loop (#352). `from` defaults to the declared value, which is also where the
property rests whenever the loop is not running. Four named easings,
`linear` by default because a cycle that eases out stutters at the wrap.
Phase is a modulo of elapsed time (`animationValueAt`, src/styles.js:965).
An equal declaration keeps its phase across re-renders (`sameAnimation`).
It stops when the window is unmapped, minimized or obscured, when anything
above the node hides it, when the node unmounts or the style drops it, and
under reduced motion (`_loopsAllowed`, src/nodes.js:2288) — and every one
of those restarts it from the top when it goes away.

### 1.2 The runtime

One path for both shapes. `_retarget` puts an entry per property into
`node._anim` and the node into `root._animating`; `flush` calls
`_advanceAnimations(now())` (src/nodes.js:11090), which claims damage for
each animating node _before_ ticking it (a finished tick deletes the entry,
and with it the only way to tell a layout animation from a paint one —
`damageForAnimation`, src/nodes.js:620), ticks, and sets `needsPaint`. The
window keeps asking for frames while `_animating` is non-empty; the
animation _is_ the repaint loop. `interpolate` (src/styles.js:990) lerps
numbers, percentages of the same unit, and colours — premultiplied, so a
fade from `transparent` does not pass through grey.

`withFrameClock` in `react-x11/test` freezes the clock; the loop tests
(test/animation-loop.test.js) and the transition tests in test/style.test.js
drive it by hand.

### 1.3 Where the pixels come from

Three presentation paths, and the animation runtime is identical on all of
them:

| backend                                      | a frame is                                                             | can anything interpolate for us?                      |
| -------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------- |
| X11 (ntk / XRender)                          | damage rects → paint walk → XRender                                    | no                                                    |
| Cocoa, `surface` presenter (**the default**) | the same paint walk into an IOSurface swapchain                        | no — one bitmap per window                            |
| Cocoa, `layers` presenter (opt-in)           | dirty nodes → per-node visuals → one `CATransaction` of property diffs | **yes** — the render server animates layer properties |

The layer presenter (src/cocoa/presenter.js) keeps a visual per drawn node:
a **PropBox** for a plain `<box>` (frame, zPosition, hidden, masksToBounds,
cornerRadius, backgroundColor, borderWidth, borderColor — zero raster), a
**Raster** for everything else (the node's own paint replayed into a bitmap
that becomes the layer's `contents`), shape layers for `<svg>`, an overlay
for scrollbars, and a clip host whose `bounds.origin` is the scroll offset.
A JS-driven transition on this presenter works today by construction: each
tick invalidates the node, the frame re-diffs its properties and sends the
changed ones under `disableActions`. It is the same cost model as X11 with
a cheaper sink.

It is opt-in — `createRoot({ cocoa: { presenter: 'layers' } })` or
`REACT_X11_COCOA_PRESENTER=layers` — while docs/macos.md's measure-first
gate is open. Everything in §4 is about that presenter; on the surface
presenter there is nothing to hand an animation to.

### 1.4 What the bridge can already do

`@windowkit/appkit`'s verbs, as react-x11 reaches them through `native`
(src/cocoa/native.js):

- `addAnimation(layer, keyPath, opts, key)` — a `CABasicAnimation`:
  `from`/`to` (numbers, `[x, y]` points, `[r, g, b, a]` colours), `duration`
  in **seconds**, `repeat` (a count, or `Infinity`), `autoreverse`, `timing`
  as one of four **named** curves (`linear`, `easeIn`, `easeOut`,
  `easeInEaseOut`; anything else is CA's default), and `hold` for
  `fillMode: forwards` + `removedOnCompletion: NO`.
- `removeAnimation(layer, key)`, `removeAllAnimations(layer)`.
- `txBegin({ duration, timing, disableActions })` / `txCommit()` — the
  implicit-animation route: set a property inside a transaction with a
  duration and CA animates it.
- `setLayerProps` accepts `opacity`, `anchorPoint`, `position`, `bounds`,
  the shadow quartet, and `transform` as
  `{ translateX, translateY, rotate (radians), scale | scaleX, scaleY }`,
  composed translate → rotate → scale — CSS's order for the individual
  transform properties, and the shape §3.4 proposes.

What it cannot do, each of which §4.4 turns into an issue: a timing function
from control points; a keyframe animation; a spring; a delay (`beginTime`);
an additive animation; a completion callback; reading a presentation value;
and the desktop's reduce-motion switch, which on Cocoa never reaches
`desktopSettings().animations` at all (src/desktopsettings.js reads
XSETTINGS and nothing else, so a mac reports `animations: true` whatever
the user set).

## 2. What cannot be said

Concrete, from the examples and the widget set:

- **Fade in a tooltip, a toast, a menu.** No `opacity`. The ecosystem page
  tells people to animate a colour instead, and every entry on that page
  exists partly because of this hole.
- **Hover lift.** `':hover': { scaleX: 1.02, scaleY: 1.02 }` — a paint-only
  state change that today has no property to change. A state block cannot
  touch layout, so growing the box is not an option either.
- **The Switch thumb.** `transition: { start: 120 }` is a layout pass per
  frame on every backend and can never be offloaded, because `start` is
  yoga's. As `translateX` it is a paint property: no layout on X11, a
  `transform.translation.x` animation in the render server on layers.
- **A shake on a bad password.** Six stops in 300ms, once, and again on the
  next attempt. Neither shape has a spelling for "once" or for "again".
- **An entrance.** Slide up and fade in on mount. Nothing may transition
  before the first frame (correctly — the mount rule), and the loop shape
  never ends.
- **A spinner.** `rotate` from 0 to 360, forever — the one loop that is
  obviously a transform, and the one with no property to loop.
- **A staggered list.** Delay per row. No `delay`.
- **A transition with a curve.** `ease-in-out` on a panel slide; a spring on
  a drag release so it carries the velocity. One fixed curve.
- **"It kept animating while the app was busy."** Any transition on macOS
  stalls with the JS thread. docs/macos.md calls this the qualitative gap
  Tier L exists for; it is not reachable until the presenter takes the
  animation.

Out of scope here, so nobody expects them: **exit animations** (keeping a
node mounted after React removed it is a reconciler feature — a deferred
`removeChild` — and deserves its own design; `onAnimationEnd` below is the
seam it will need), and **window-level opacity** (a `<popup>` fade is
`_NET_WM_WINDOW_OPACITY` on X11 and `NSWindow.alphaValue` on Cocoa, a
different mechanism from a node's).

## 3. The vocabulary

### 3.1 Easing, shared

```ts
type Easing =
  | 'linear'
  | 'ease'
  | 'ease-in'
  | 'ease-out'
  | 'ease-in-out'
  | [x1: number, y1: number, x2: number, y2: number] // cubic-bezier
  | {
      spring: {
        stiffness?: number;
        damping?: number;
        mass?: number;
        velocity?: number;
      };
    };
```

**The canonical form is the four control points.** Names are aliases
resolved once, in `styles.js`, to the beziers they already are:

| name          | control points         | today                                   |
| ------------- | ---------------------- | --------------------------------------- |
| `linear`      | `[0, 0, 1, 1]`         | `t`                                     |
| `ease-out`    | `[0.33, 1, 0.68, 1]`   | `1 - (1 - t)^3`, the transition default |
| `ease-in`     | `[0.32, 0, 0.67, 0]`   | `t^3`                                   |
| `ease-in-out` | `[0.65, 0, 0.35, 1]`   | the piecewise cubic                     |
| `ease`        | `[0.25, 0.1, 0.25, 1]` | — (CSS's default, new)                  |

Why this and not the polynomials: **the two evaluators have to agree.** A
declaration that runs on the JS loop on X11 and in the render server on
layers must look the same, and CA's only timing primitive is a cubic
bezier. Sampled at a thousand points (scratch script, not committed), the
existing curves against their bezier twins differ by at most 0.003
(ease-out, ease-in) and 0.0095 (ease-in-out) — invisible. The existing
ease-out against CA's **named** `easeOut` (`[0, 0, 0.58, 1]`) differs by
**0.216** at t = 0.35 — a visibly different animation. So the bridge's four
named curves are not a mapping target; control points are, and the JS side
gets a bezier solver (Newton with a bisection fallback, the shape every
browser ships, ~40 lines, pure, pinned by a table test against CSS's
published samples).

**Springs** are the second kind, not a curve: no duration, a settling time
derived from the physics, and the reason they exist is interruption — a
retarget carries the current velocity, which is what makes a dragged thing
let go feel like it was let go. CA's names (`mass`, `stiffness`,
`damping`, `initialVelocity`) are physical units and are also popmotion's
and Framer's; use them. A spring is only ever between two values, so it is
an easing for `transition` and for a two-stop `animation`; a keyframe
timeline takes beziers per segment. The JS evaluator is the closed-form
damped oscillator, settling at a displacement threshold; CA's is
`CASpringAnimation` and reports `settlingDuration`, which is what the
completion timer uses. Springs are the last thing to land (§7); the
vocabulary is fixed now so nothing built before them has to move.

### 3.2 `transition`

```js
transition: 120                                          // as today: everything, ease-out
transition: { backgroundColor: 120, borderColor: 120 }   // as today
transition: {
  all: 120,                                              // the shorthand's slot
  start: { duration: 160, easing: 'ease-in-out', delay: 40 },
  scaleX: { easing: { spring: { stiffness: 400, damping: 30 } } },
}
```

A property's value is `ms | { duration?, easing?, delay? }`; `all` is the
default for every animatable property not named, and is not a style
property, so the object stays one grammar. `duration` may be omitted only
with a spring. The default easing stays `ease-out` — a change that ends
looks right slowing into its value — and the default delay is 0.

`transitionFor` returns `{ duration, easing, delay }` instead of a number.
(The `.d.ts` already declares that shape — `{ duration; delay? } | null`,
src/style.d.ts:93 — and the JavaScript returns a number: one of #120's
drifts, closed by this change rather than by editing the declaration.)

`delay` is a start time, nothing more: the transition still reads its
`from` from what is on screen _when it starts_, so a retarget during the
delay is a retarget of a transition that has not moved.

### 3.3 `animation`: a timeline, which may end

```js
animation: {
  // today's loop, unchanged
  backgroundColor: { to: '$accent', duration: 900, alternate: true },
  // an entrance: from somewhere, to the declared value, once
  opacity:    { from: 0, duration: 200, repeat: 1 },
  translateY: { from: 8, duration: 200, repeat: 1, easing: 'ease-out' },
  // a shake, and again on the next attempt
  translateX: { keyframes: [0, -6, 6, -6, 6, 0], duration: 300, repeat: 1, key: attempt },
  // a spinner
  rotate: { from: 0, to: 360, duration: 800 },
  // a staggered pulse
  scaleX: { to: 1.1, duration: 600, alternate: true, delay: index * 80 },
}
```

Per property, as now — CA needs one animation per key path too, and CSS's
one-`@keyframes`-many-properties shape would only be a way to write the
same duration several times. Options:

| key          |                                                                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `from`, `to` | the two-stop form. **Exactly one may be omitted** and defaults to the declared value                                                        |
| `keyframes`  | the many-stop form, instead of `from`/`to`: values evenly spaced, or `{ at: 0..1, value, easing? }` for placed stops and per-segment curves |
| `duration`   | one pass, ms                                                                                                                                |
| `easing`     | over the pass; `linear` default, as now                                                                                                     |
| `delay`      | before the first pass only                                                                                                                  |
| `repeat`     | passes; **`Infinity` by default**, so a declaration written today means what it meant                                                       |
| `alternate`  | as now                                                                                                                                      |
| `key`        | identity: a changed `key` restarts the timeline from the top, which is how a finite one is played again                                     |

**Where it rests is the declared value — and that is the whole fill-mode
story.** Loops already have this rule: the property is at its declared
value before the first frame, off screen, under reduced motion. A finite
timeline ends and the property is at its declared value. So an entrance is
"declare the end state, arrive from somewhere else"; a shake ends where it
began because the author wrote `0` at both ends. There is no `fill:
'forwards'`, deliberately: a held last frame means the style lies about the
property from then on, and the author who wants that value can write it.
A finite timeline whose last stop is not the declared value snaps at the
end, visibly — which is the declaration being honest, not a bug.

**Start and restart.** A timeline starts on the style swap that introduces
it — a mount, or a later change — the same moment loops start today. An
equal declaration keeps its phase (`sameAnimation`, extended to
`keyframes`, `repeat`, `delay`, `key`); a changed one restarts. A finished
finite timeline stays finished across re-renders of the same declaration;
`key` is the one field whose only job is to differ. (`key` reads well in a
React codebase; `run` was the alternative.)

**Completion.** `onTransitionEnd({ property })` and `onAnimationEnd({
property })` as element props, per property, fired when the JS clock says
so — on every presenter, including one that offloaded the pixels, so a
component can chain or unmount without knowing where the animation ran.
Loops never fire it. An interrupted transition does not fire it either
(CSS agrees: `transitioncancel` is a different event, and nothing here
needs it yet).

**Reduced motion.** The existing split holds and is the simple rule:
**`animation` is motion for its own sake and never starts under reduced
motion, finite or not; `transition` is the answer to an input and always
runs.** A shake and an entrance are the kind of thing the switch exists
for, and the still frame is the declared value — the same design decision
`<ProgressBar indeterminate>` already makes for its loop.

### 3.4 `opacity` and the individual transforms

Six paint-only style properties, on both backends:

| property                   | value      | notes                                                      |
| -------------------------- | ---------- | ---------------------------------------------------------- |
| `opacity`                  | 0..1       | **group** opacity of the subtree, CSS semantics            |
| `translateX`, `translateY` | logical px |                                                            |
| `rotate`                   | degrees    | the bridge takes radians; the presenter converts           |
| `scaleX`, `scaleY`         | factor     | no `scale` — `<box scale>` is already the zoom (see below) |

Composed translate → rotate → scale about the box centre — CSS's order for
its individual transform properties and exactly what the bridge's
`transform` object does. A `transformOrigin` is the obvious later seam;
centre is CA's default anchor and the case every hover lift and spinner
wants.

Paint-only means: **state blocks may set them.** A `:hover` that scales a
card by 2% is a repaint of one node, no layout — the property that was
missing from the "hover is a repaint, not a render" story. It also means
layout is untouched: the box yoga computed is where the node _is_; the
transform is where it is _drawn_, and where the pointer finds it. Hit
testing maps the point through the inverse (the walk in `events.js` tests
node rects; a transformed node tests the inverse-mapped point against its
own rect and passes the mapped point to its children). `paintBounds()` is
the transformed box's bounding rect, which is what damage, culling and
`_subtreeBounds()` already consume. `opacity: 0` still hits, as in CSS;
`pointerEvents: 'none'` is the property for not hitting.

**Not the zoom.** `<box scale={2}>` multiplies every length in the subtree
and reshapes text at the size it will be drawn at (src/nodes.js:1778,
docs/scale.md); it is layout, and it is expensive to change. `scaleX` is
paint: the rasterized subtree stretched. They are two different tools and
the transform is the one that animates cheaply; the docs say so in one
place so the names stop looking like a mistake.

Both animate (they are numbers), both may transition, both go in
timelines. That is the whole point of choosing individual properties over
a `transform: 'rotate(45deg) …'` string: the per-property machinery
interpolates them with no matrix decomposition, and each is one CA key
path (`opacity`, `transform.translation.x`, `transform.rotation.z`,
`transform.scale.x`).

### 3.5 Deliberately not proposed

- **CSS strings** (`'200ms ease-in-out'`, `'rotate(45deg)'`). The style
  language here is numbers and objects; a second grammar inside strings is
  a parser and a source of errors that arrive as a thing that does not move.
- **`fill-mode`.** §3.3.
- **A per-frame callback in the style.** `animation` describes the motion
  and the renderer runs it — the offload in §4 depends on that being true.
  The imperative seam for a 2D per-frame draw is still open
  (docs/styling.md, last paragraph of "Loops"); a `<canvas>` with a value
  from popmotion is the answer meanwhile, and this proposal makes that
  cheaper rather than replacing it.
- **Exit animations.** §2.

## 4. Who interpolates

### 4.1 The rule

**The node model is the source of truth for what is animating and when it
ends. A presenter may take the pixels.** Concretely, `_retarget` and
`_updateLoops` keep doing everything they do — the `_anim` entry, the
start time, `sameAnimation`, the loop-stop rules — and then ask:

```js
presenter.animate?.(node, prop, entry); // → true: the presenter interpolates
```

A presenter that answers `true` owns the frames for that entry: the node
is **not** added to `root._animating` for it, no damage is claimed per
frame, and the window's frame clock stays idle. The model value goes out
as it does now — the resolved target, in the disabled-actions transaction
— and the presenter has attached the motion to the layer. Completion is a
timer at `delay + duration` (or the spring's settling time), which fires
`onTransitionEnd`/`onAnimationEnd` and, for a finite timeline, lets the
property rest. A presenter that answers `false`, has no `animate`, or is the
X11 painter, gets the JS loop exactly as today. **Every entry has the JS
loop as its fallback**, so correctness never depends on coverage — the
same rule the layer presenter already applies to painting (raster per node
when the property vocabulary runs out).

Retarget and stop go through the same seam: `presenter.cancel(node, prop)`
before a new `animate`, and from every loop-stop path.

### 4.2 What the layer presenter takes

A property qualifies when it maps to a property **of the node's own layer**
and changing it does not re-raster that layer:

| style property                                | key path                         | PropBox | Raster         |
| --------------------------------------------- | -------------------------------- | ------- | -------------- |
| `backgroundColor`, `borderColor`              | `backgroundColor`, `borderColor` | yes     | no — re-raster |
| `borderWidth`, `borderRadius`                 | `borderWidth`, `cornerRadius`    | yes     | no             |
| `opacity`                                     | `opacity`                        | yes     | **yes**        |
| `translateX/Y`, `rotate`, `scaleX/Y`          | `transform.*`                    | yes     | **yes**        |
| `boxShadow` components (once it interpolates) | `shadowOpacity/Radius/Offset`    | later   | —              |
| `color` on `<text>`                           | —                                | —       | no             |
| any layout property                           | —                                | no      | no             |

The last row is the important one. **Layout properties stay on the JS loop
on every presenter**, because yoga has to run for the frame to be right —
a `width` that grows moves its siblings. The one tempting exception, an
absolutely positioned node's `left`/`top`/`start` as the layer's
`position`, is deferred: once `translateX` exists, the Switch thumb and
its kind have a paint property to slide on, which is cheaper on X11 too
and needs no exception. The `Raster` rows are what make transforms and
opacity worth more than they look: a paragraph, an image or a registered
element fades and moves in the render server with its bitmap untouched.

**Mechanics** (per property, inside the frame's transaction):

1. Model value out as today: `visual.set({ backgroundColor: to })` under
   `disableActions`.
2. `addAnimation(layer, keyPath, { from, to, duration: ms / 1000, timing:
[x1, y1, x2, y2], delay }, key)`. CA renders `from` → `to` over the
   model value and removes itself on completion, leaving the model showing
   — the standard explicit-animation pattern, no `hold`.
3. Timer for completion.

**Loops** are `repeat: Infinity` with `autoreverse` for `alternate`, and
cost **zero JS frames** — the spinner, the pulse and the indeterminate bar
become a render-server timer. The loop-stop rules still run (they are the
one truth about whether a loop may run), and each one is a
`removeAnimation`; a resume is a fresh `addAnimation`, phase reset, as the
JS loop does now. CA stops compositing an occluded window on its own, so
the rule costs nothing there and keeps the two backends identical in what
they promise.

**Interruption** — the "reverse from where it got to" property, which
test/style.test.js pins for the JS loop and which has to hold here:

- Numeric key paths (`opacity`, `transform.*`, `borderWidth`,
  `cornerRadius`): **additive** animations, CA's own idiom. The model goes
  straight to the new target; the animation is `from: old − new, to: 0,
additive: true`. Several in flight sum, so a retarget mid-flight is
  continuous and carries its shape — with no readback of anything. This
  needs the bridge's `additive` flag (§4.4).
- Colours (CA cannot add colours): the JS side computes where the running
  animation is from its own clock and the same bezier — within a frame of
  CA's truth, since both evaluate the same curve — and starts the next one
  there. `presentationValue(layer, keyPath)` (§4.4) makes it exact later;
  it is not on the critical path.

**What the presenter needs from the node** is what `_syncPropBox` already
reads plus the animated entry; the table above is a static map from style
property to key path plus a check of `visual.isRaster`. It is a small
addition to src/cocoa/presenter.js, and the cocoa-mock presenter in the
tests records `addAnimation` calls the same way it records `setLayerProps`.

### 4.3 The surface presenter, and X11

X11 has nothing to offload: one bitmap per window, painted by the X11
walk, and the JS loop runs. The surface presenter started there too, and
now takes the same table as §4.2 by **layer promotion** (issue #483,
docs/macos.md §"Layer promotion"): a plain box with a transition or a loop
on an offloadable property gets a CALayer of its own above the window's
bitmap for as long as it animates, where nothing is painted over it, and
the same `LayerAnimations` books run it in the render server. The bitmap
keeps the frame for everything else. What this moved in the measure-first
gate's argument is recorded there, measured.

### 4.4 Bridge additions (`@windowkit/appkit`)

In the order the offload needs them:

1. **`timing: [x1, y1, x2, y2]`** on `addAnimation` and `txBegin` —
   `CAMediaTimingFunction functionWithControlPoints:`. **Prerequisite**:
   §3.1's numbers say the named curves would change every existing
   transition's look.
2. **`additive: true`** — one line on the `CABasicAnimation`. What makes
   retargeting continuous without readback.
3. **`delay`** — `beginTime = CACurrentMediaTime() + delay`, with
   `fillMode: backwards` so the layer shows `from` during the delay.
4. **Keyframes** — `values`, `keyTimes`, `timingFunctions` (one bezier per
   segment), `calculationMode: linear` (a `CAKeyframeAnimation`).
5. **Springs** — `CASpringAnimation` with `mass`/`stiffness`/`damping`/
   `initialVelocity`, returning `settlingDuration` so JS can time completion.
6. **`presentationValue(layer, keyPath)`** — `presentationLayer` readback;
   exactness for colour retargets.
7. **Completion callback** — the animation delegate's `animationDidStop:
finished:` forwarded through the event callback; makes
   `onTransitionEnd` exact rather than timer-derived. Optional.
8. **Reduce motion** — `NSWorkspace.accessibilityDisplayShouldReduceMotion`
   plus its notification, into `desktopSettings().animations` on the Cocoa
   app. Independent of this design and already wrong without it.

Each is a verb, not policy, which is the shape the bridge's contract asks
for (docs/macos.md, "The channel is already node-granular").

Filed as [windowkit/appkit#29](https://github.com/windowkit/appkit/issues/29);
[windowkit/appkit#30](https://github.com/windowkit/appkit/pull/30) implements
items 1–7 plus `speed`/`timeOffset` (merged); item 8 is
[windowkit/appkit#31](https://github.com/windowkit/appkit/issues/31), implemented
by [windowkit/appkit#32](https://github.com/windowkit/appkit/pull/32). Two
things the bridge work found that the presenter has to know: CA interpolates
colours in the display's space, so a colour read back mid-flight is not the
component midpoint; and a paused animation sampled at exactly its duration
reads as its start, so an end is sampled a millisecond early.

## 5. What `opacity` and transforms cost on X11

Both are **group** operations on a subtree, and a group needs an offscreen:
per-op alpha on overlapping children double-blends where they overlap, and
per-op transforms would rotate each child about its own centre. So:

1. Paint the subtree into an ntk `Surface` the size of `paintBounds()` in
   device pixels — the same surface family the paint cache and #433's
   `CocoaSurface` use, behind `app.createSurface` on the Cocoa surface
   backend and ntk's pixmap on X11.
2. Composite it back with `ctx.globalAlpha = opacity` and the transform set
   on the context. ntk's `drawImage` already routes a transformed draw
   through `SetPictureTransform` with a filter and scales the composite by
   `globalAlpha` (node_modules/ntk/lib/renderingcontext_2d.js:2046,
   :4599) — server-side, no readback. Rotation's filter quality and the
   transformed bounding box are the two things to verify with a pixel test
   rather than assume.

Per animated frame that is one pixmap the size of the subtree plus one
composite — bounded to the thing that moves, the way every claim here is.
Two fast paths cover most of what apps write and skip the offscreen
entirely:

- **A pure translate**: `ctx.translate` and paint the subtree through it.
  Every child paints through the same context, clips included. That is
  the shake, the slide, the entrance, the Switch thumb.
- **Opacity on a leaf** (a `<box>` with no children, or a `<text>`):
  multiply the alpha into the fill, border and ink. One node, no group.

`opacity: 1` and identity transforms cost nothing, which keeps the
properties safe to leave in a style. The offscreen surface is per node,
kept between frames of one animation and dropped when it ends, and it is
the paint cache's budget that bounds it (src/paintcache.js's byte budget
is the pattern; the surface here is not content-keyed, it is a frame
scratch).

Damage: `damageForAnimation` already claims _before_ the tick; a transform
animation claims the union of the old and new bounding rects, which is
what an absolutely positioned layout transition already does through its
parent.

## 6. Where the code goes

- **src/styles.js** — `resolveEasing` (names → control points → a bezier
  function; the spring solver), `transitionFor` → `{ duration, easing,
delay }`, `parseAnimation` (`keyframes`, `repeat`, `delay`, `key`; the
  validation messages name the option and the property as now),
  `animationValueAt` over a keyframe list (segment lookup, per-segment
  easing, `repeat` as a cap on the cycle count), `sameAnimation` over the
  new fields, and the six new properties in `PAINT_PROPS` — which puts
  them in state blocks and out of `NOT_ANIMATABLE` for free.
- **src/nodes.js** — `_retarget` (easing and delay on the entry; the
  presenter seam), `_tickAnimations` (finite end → rest at the target,
  completion events), `_updateLoops` (cancel through the presenter),
  `paint` (the group path and its two fast paths around
  `_paintBackground`/`paintContent`/`_paintChildren`), `paintBounds()`
  and `_subtreeBounds()` (transformed boxes), `damageForAnimation`.
- **src/events.js** — the inverse-mapped hit test.
- **src/cocoa/presenter.js** — `animate`/`cancel`, the key-path table,
  `opacity` and `transform` on both visual kinds; the mock presenter
  records them.
- **src/types/style.d.ts, src/style.d.ts, test/types/api.tsx** — `Easing`,
  `Transition`, `AnimationSpec`, the six properties, the two events.
- **docs/styling.md** ("Transitions", "Loops" → "Timelines"),
  **docs/macos.md** (the "Animations and transforms" section becomes a
  pointer here plus the measured result), **docs/ecosystem/animation.md**
  (delete the "no opacity" constraint; the page shrinks), **docs/system.md**
  (reduced motion covers finite timelines), **docs/elements.md** (`scale`
  vs `scaleX`, the events).
- **Widgets and examples** — Switch on `translateX`; Tooltip fades;
  ProgressBar unchanged; a shake in the configurator's password field;
  the website demos that use `transition` still pass `check-demos`.
- **Tests** — bezier table vs CSS samples and vs the polynomials
  (test/style.test.js); finite timelines, keyframes, `key` restart, rest at
  the declared value, `delay` (test/animation-loop.test.js); the mock
  presenter: a `backgroundColor` transition on a PropBox schedules zero
  frames and one `addAnimation` with control points, `color` on a `<text>`
  falls back to the loop, a loop stop removes the animation; pixels: group
  opacity over overlapping children against a reference composite, a
  rotate against a pre-rotated reference, the translate fast path
  byte-identical to the offscreen path (the differential oracle
  test/dirty-rect.test.js already has, applied here); the hit test through
  a transform. And a **structural** row in `scripts/bench/presenters-gate.json`:
  JS frames scheduled per 120ms hover transition on layers — 0 with the
  offload, ~8 without — the same kind of number the gate already judges.

## 7. Sequencing

Each step ships on both backends and is useful alone; the offload is
additive on top and can proceed in parallel from step 1.

1. **Easing vocabulary and the `transition` object form** (`all`, per-property
   `{ duration, easing, delay }`). Small; the bezier solver and its table
   test are most of it.
2. **Timelines**: `keyframes`, `repeat`, `delay`, `key`, the completion
   events, reduced motion over finite timelines.
3. **`opacity`**: the group path with the leaf fast path on X11 and the
   surface presenter; `opacity` on both visuals on layers.
4. **Transforms**: translate first (fast path only, no offscreen — most of
   the value for a fraction of the work), then rotate and scale over the
   offscreen with the inverse hit test. Switch moves to `translateX`.
5. **Layer offload**: bridge items 1–3 (`windowkit/appkit` PRs), then the
   presenter seam and its mock tests, the gate row, and a measured
   before/after on a real display the way docs/macos.md "Measured" records
   them. Items 4–7 follow as the timeline and spring features reach the
   presenter.
6. **Springs**: the JS solver, bridge item 5, `easing: { spring }` on
   transitions.

## 8. Open questions

- **`key` vs `run`** for the restart token (§3.3). Cheap to decide, hard to
  rename later.
- **Should a finite timeline snap or ease into the declared value** when its
  last stop differs? This document says snap, because it is honest and CSS
  does the same; the alternative — an implicit last stop at the declared
  value — hides a mismatch behind a nicer default.
- **Additive colours.** CA cannot; the clock-estimated `from` is within a
  frame, and the readback verb closes it. Decide whether a frame's error
  on a 120ms colour retarget is ever visible before building the verb.
- **Transforms and text selection, carets, scroll**: a transformed
  `<textinput>` maps its pointer through the inverse like everything else,
  but its caret and selection geometry are computed in layout space. The
  first cut may reject transforms on nodes that own an editing surface, or
  accept a documented gap; a real display will say which.
- **Whether `opacity` on X11 should take the offscreen at all** for a
  subtree above a size, or fall back to per-node alpha with the
  double-blend documented. The paint cache's item cap (`MAX_ITEM_PIXELS`)
  is the precedent for "past this size, do the simple thing".

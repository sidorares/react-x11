# Animation

react-x11 has a built-in `transition` style property with a fixed easing
curve — see [styling](../styling.md#transitions). Everything on this page
exists to cover what that cannot express: springs with velocity carry-over,
interruption, arbitrary easing curves, shape morphing, and keeping an element
mounted while it animates out.

There is one constraint every entry shares: **there is no `opacity` style
property**, and `validateStyle` throws on unknown properties. The classic
fade does not port literally; animate a colour, a size or a position instead.

Two patterns recur. The cheap one is `onUpdate → setState → style prop`:
every frame is a React render plus a commit, which react-x11 turns into a
partial repaint of the node whose paint changed. Keep the animated component
a leaf — a `<box>`, not the window root — and it is fine at spring frame
rates. The expensive-to-set-up, cheap-to-run one is the
[react-spring host](#react-spring), which applies frames imperatively and
bypasses React entirely.

Headless Node has no `requestAnimationFrame`. In a real app the right clock
is the ntk window's `requestAnimationFrame`, reachable through a ref on
`<window>`, which paces frames to X connection latency; a 16 ms
`setInterval` works everywhere else.

`framer-motion` is not on this page. Both its component layer and its bare
value layer fail — see the
[negative-results register](../ecosystem.md#render-time), which also explains
why reaching past `motion.*` does not help.

## popmotion {#popmotion}

**Out of the box.** popmotion@11.0.5.

Framer's low-level animation toolkit: `animate()` tweens or springs a plain
JS value and calls `onUpdate(v)` every frame. No components, no DOM — the
value goes wherever you point it. This is the smallest way to get real
springs, with velocity and overshoot, without adopting the react-spring host.

```jsx
import React, { useEffect, useState } from 'react';
import { animate } from 'popmotion';

function Bar() {
  const [w, setW] = useState(20);
  useEffect(() => {
    const anim = animate({
      from: 20,
      to: 200,
      stiffness: 300,
      damping: 20,
      onUpdate: setW,
    });
    return () => anim.stop();
  }, []);
  return <box style={{ width: w, height: 30, backgroundColor: '#3366ff' }} />;
}
```

popmotion's `framesync` detects the missing `requestAnimationFrame` and falls
back to a 16.7 ms `setTimeout`, so it works headless with no configuration.
For latency-adaptive pacing, `animate()` accepts a custom `driver` you can
back with the ntk window's clock.

- Springs on layout properties (width, margin) cost a yoga layout pass per
  frame — the same trade react-x11's own layout transitions make.
- `animate` also interpolates colour strings (`'#f00' → '#00f'`), and the
  `rgba(...)` strings it emits are accepted by the paint path.
- popmotion's `styler` and DOM helpers are irrelevant here. Use only the
  value APIs: `animate`, `spring`, `decay`, `mix`.

## d3-ease {#d3-ease}

**Out of the box.** d3-ease@3.0.1.

Pure easing functions: `ease(t)` maps normalized time to normalized progress,
and nothing else. Thirty-plus curves — cubic, elastic, bounce, back — each a
few lines of maths with no environment dependencies. This is the zero-cost
way to get the curves the built-in `transition` does not have.

Compute `t` from wall time, pass `ease(t)` to an interpolator, push the
result into a style prop.

```jsx
import React, { useEffect, useState } from 'react';
import { easeCubicOut } from 'd3-ease';
import { interpolateNumber } from 'd3-interpolate';

function useTimeline(duration, ease, onFrame) {
  useEffect(() => {
    const start = Date.now();
    const timer = setInterval(() => {
      const t = Math.min(1, (Date.now() - start) / duration);
      onFrame(ease(t));
      if (t >= 1) clearInterval(timer);
    }, 16);
    return () => clearInterval(timer);
  }, []);
}

const width = interpolateNumber(10, 200);

function Gauge() {
  const [f, setF] = useState(0);
  useTimeline(250, easeCubicOut, setF);
  return (
    <box style={{ width: width(f), height: 24, backgroundColor: '#204080' }} />
  );
}
```

- ESM-only since v3 — `require()` fails, `import` works. react-x11 apps are
  ESM anyway.
- It is only the curve; you own the clock and the interpolation.
- Overshooting curves (elastic, back) produce values outside the from/to
  range. That is the point of them, but clamp before feeding anything
  react-x11 validates as non-negative.

## d3-interpolate {#d3-interpolate}

**Out of the box.** d3-interpolate@3.0.1.

`interpolate(a, b)` returns `t => value` for numbers, colours in any CSS
space, strings with embedded numbers, dates, arrays and nested objects. Pure
maths, no DOM.

Worth knowing: `interpolateRgb` emits `'rgb(r, g, b)'` strings and the paint
path takes them as-is, so colour animation needs no conversion. react-x11 has
an internal interpolator for its own `transition` styles, but it is not
exported and handles only what transitions need — d3-interpolate is the
general tool for hand-rolled timelines.

```jsx
import { easeCubicOut } from 'd3-ease';
import { interpolateNumber, interpolateRgb } from 'd3-interpolate';

const width = interpolateNumber(10, 200);
const color = interpolateRgb('#204080', '#e04040');

function Gauge() {
  const [f, setF] = useState(0);
  useTimeline(250, easeCubicOut, setF); // see d3-ease above
  return (
    <box style={{ width: width(f), height: 24, backgroundColor: color(f) }} />
  );
}
```

- ESM-only since v3.
- Generic `interpolate(a, b)` on objects interpolates _every_ numeric-looking
  key, so interpolating a whole style object will happily produce fractional
  values for properties that want integers. Interpolate the two or three
  properties you mean.
- There is no `opacity`; to fade, interpolate a colour's alpha into
  `backgroundColor: 'rgba(...)'`.
- `interpolateArray` over polygon points feeding `<canvas onDraw>` is a good
  use of the general form.

## `@tweenjs/tween.js` {#tweenjs}

**Out of the box.** @tweenjs/tween.js@25.0.0.

`new Tween(obj).to(target, ms).easing(...).onUpdate(...).start()`, and then
_you_ call `tween.update(time)` on whatever clock you own. Since v18 there is
no implicit global loop — nothing runs until you pump it.

The explicit clock is the feature here: in a real app, pump from the ntk
window's `requestAnimationFrame`, which paces updates to X connection
latency. Use one `Group` per window if you run many tweens, so
`group.update(now)` steps them all from the same tick.

```jsx
import React, { useEffect, useState } from 'react';
import { Tween, Easing } from '@tweenjs/tween.js';

function Panel() {
  const [pos, setPos] = useState({ x: 0, h: 10 });
  useEffect(() => {
    const state = { x: 0, h: 10 };
    const tween = new Tween(state)
      .to({ x: 150, h: 60 }, 300)
      .easing(Easing.Cubic.Out)
      .onUpdate(() => setPos({ ...state }))
      .start();
    const timer = setInterval(() => {
      if (!tween.update()) clearInterval(timer); // update() is false when done
    }, 16);
    return () => clearInterval(timer);
  }, []);
  return (
    <box
      style={{
        marginLeft: pos.x,
        width: 40,
        height: pos.h,
        backgroundColor: '#00aa55',
      }}
    />
  );
}
```

- Tweens numbers only, including numbers nested in objects and arrays.
  Colours need pre-decomposition into channels; use d3-interpolate or
  popmotion instead.
- Nothing animates until something calls `update()`. Forgetting the pump is
  the classic first bug.
- `onUpdate` mutates the source object, so spread it into fresh state
  (`setPos({ ...state })`) or React skips the re-render on identity.

## flubber {#flubber}

**Out of the box.** flubber@0.4.2.

Shape-morphing interpolators for SVG paths: `interpolate(from, to)` returns
`t => d-string`, handling ring alignment, point insertion and topology
changes so intermediate frames look sensible instead of self-intersecting.
Shape morphing is the one animation the `<svg>` host makes easy, and flubber
is the standard tool for it.

```jsx
import React, { useEffect, useState } from 'react';
import flubber from 'flubber'; // CJS: default import, no named ESM exports
const { interpolate } = flubber;

const morph = interpolate(
  'M50,10 L90,90 L10,90 Z',
  'M10,10 L90,10 L90,90 L10,90 Z',
);
const svgFor = (d) =>
  `<svg viewBox="0 0 100 100"><path d="${d}" fill="#cc3355"/></svg>`;

function Morph() {
  const [t, setT] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const timer = setInterval(() => {
      const p = Math.min(1, (Date.now() - start) / 200);
      setT(p);
      if (p >= 1) clearInterval(timer);
    }, 16);
    return () => clearInterval(timer);
  }, []);
  return <svg source={svgFor(morph(t))} style={{ width: 100, height: 100 }} />;
}
```

- `import { interpolate } from 'flubber'` throws — it is a CJS package, so
  use the default-import form above.
- Build the interpolator once (module scope or `useMemo`). Construction does
  the expensive ring matching; sampling is cheap.
- Every frame is a full SVG parse and rasterize of the `source` string. Fine
  for icons and small figures; for large scenes prefer `<canvas onDraw>` and
  draw the interpolated points yourself.
- Old but stable (0.4.2 since 2017) — finished rather than unmaintained.

## react-transition-group {#react-transition-group}

**Out of the box — with `nodeRef`.** react-transition-group@4.4.5.

A transition _state machine_, not an animator: `<Transition in={bool}
timeout={ms}>` walks its child through `entering`/`entered`/`exiting`/
`exited` on a timer and keeps the child mounted during exit. You decide what
each state looks like. It is the standard way to keep an element mounted
while it animates out, which react-x11 has no built-in answer for.

Two rules. Always pass `nodeRef` — without it, v4 falls back to
`ReactDOM.findDOMNode`, which would receive a react-x11 node it cannot
understand. And map states to styles yourself, pairing with the built-in
`transition` style so the state flip _tweens_ instead of snapping. That
combination is the whole "CSSTransition" story here, since there are no class
names.

```jsx
import React, { useRef } from 'react';
import { Transition } from 'react-transition-group';

function Panel({ shown }) {
  const nodeRef = useRef(null);
  return (
    <Transition
      nodeRef={nodeRef}
      in={shown}
      timeout={150}
      mountOnEnter
      unmountOnExit
    >
      {(state) => (
        <box
          ref={nodeRef}
          style={{
            transition: 150, // let react-x11 tween the flip
            width: 100,
            height: 50,
            backgroundColor: state === 'entered' ? '#ff0000' : '#0000ff',
          }}
        />
      )}
    </Transition>
  );
}
```

- **`react-dom` must be present in `node_modules`.** `cjs/Transition.js`
  requires it at module scope for the `findDOMNode` fallback, even when
  `nodeRef` means it is never called. It is a peer dependency: install it, it
  will not be rendered with.
- `CSSTransition` is pointless here — it toggles class names, and there are
  none. Use plain `Transition`.
- `timeout` and your visual transition duration are independent numbers. Keep
  them equal, or the state flips mid-tween.
- `addEndListener` works; call the provided `done` yourself.

## `@react-spring/core` {#react-spring}

**Adapter, ~20 lines.** @react-spring/core@10.1.2,
@react-spring/animated@10.1.2.

The platform-independent half of react-spring: `useSpring`, `useTransition`,
`useTrail`, `SpringValue`, `Controller`. `@react-spring/animated` provides
`createHost`, the documented seam for building a non-DOM target — it is how
`@react-spring/native` and `/three` exist.

Springs, interruption with velocity carry-over, and `api.start()` are exactly
what the built-in duration-only `transition` cannot express. Two public
seams do the work:

- `Globals.assign({ now, requestAnimationFrame })` points react-spring's
  frame loop at a clock.
- `createHost(['box', …], { applyAnimatedValues })` produces `animated.box`.
  Every frame, react-spring calls `applyAnimatedValues(instance, props)`
  where `instance` is the react-x11 node your ref points at — and
  `node.applyProps(next, prev)` is the same imperative path the reconciler's
  own `commitUpdate` uses. Frames bypass React entirely: a component renders
  once while hundreds of frames apply.

```jsx
// spring-x11.js — the adapter
import { Globals } from '@react-spring/core';
import { createHost } from '@react-spring/animated';

Globals.assign({
  now: Date.now,
  // real app: cb => ntkWindow.requestAnimationFrame(cb)  (ref on <window>)
  requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 16),
});

const host = createHost(['box', 'text', 'window'], {
  applyAnimatedValues(instance, props) {
    if (!instance || typeof instance.applyProps !== 'function') return false;
    const prev = instance.props;
    const next = { ...prev, ...props };
    // frames carry only animated leaves — keep the static style keys
    if (props.style) next.style = { ...prev.style, ...props.style };
    instance.applyProps(next, prev);
  },
});

export const animated = host.animated;
```

```jsx
import React, { useEffect } from 'react';
import { useSpring } from '@react-spring/core';
import { animated } from './spring-x11.js';

function Bar() {
  const [style, api] = useSpring(() => ({
    from: { width: 20, backgroundColor: '#204080' },
  }));
  useEffect(() => {
    api.start({ width: 180, backgroundColor: '#e04040' });
  }, []);
  return <animated.box style={{ ...style, height: 30 }} />;
}
```

- **Merge `style` one level deep in `applyAnimatedValues`** — this is the
  number-one silent failure. On animation frames react-spring calls
  `props.getValue(true)` for _animated leaves only_, so static keys
  (`height: 30` next to an animated `width`) are absent from the payload and
  a naive `{...prev, ...props}` merge wipes them. The box then paints
  nothing, with no error.
- Hex, `rgb()` and `rgba()` colour strings interpolate out of the box. Named
  CSS colours are not enabled by default in `@react-spring/shared` — stick to
  hex and rgb.
- Do not use `useScroll`, `useResize`, `useInView` or `useReducedMotion` from
  core; they observe the DOM `window` and `matchMedia`.
  `Globals.assign({ skipAnimation })` is the manual reduced-motion switch.
- Style arrays (`style={[a, b]}`) defeat the shallow merge. Flatten first —
  react-x11 exports `flattenStyle`.
- Driving the clock from `setImmediate` runs frames as fast as the event loop
  turns, which is fine for tests and wasteful for apps. Use the ntk window
  clock or a 16 ms timeout.

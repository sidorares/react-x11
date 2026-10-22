# Animation

react-x11's built-in `transition` style property has a fixed easing curve
([styling](../styling.md#transitions)). This page covers what it cannot
express: springs with velocity carry-over, interruption, arbitrary easing
curves, shape morphing, and keeping an element mounted while it animates
out.

**There is no `opacity` style property**, and `validateStyle` throws on
unknown properties, so the classic fade does not port; animate a colour, a
size or a position instead.

Two patterns recur. The cheap one is `onUpdate → setState → style prop`:
each frame is a React render plus a commit, which react-x11 turns into a
partial repaint of the changed node. Keep the animated component a leaf — a
`<box>`, not the window root — and it holds spring frame rates. The other is
the [react-spring host](#react-spring): more setup, but it applies frames
imperatively and bypasses React.

Node has no global `requestAnimationFrame`. In an app, use the ntk window's
`requestAnimationFrame` (through a ref on `<window>`), which paces frames to
X connection latency; a 16 ms `setInterval` works everywhere else.

`framer-motion` fails at both its component and its value layer — see the
[negative-results register](../ecosystem.md#render-time).

## popmotion {#popmotion}

**Out of the box.** popmotion@11.0.5.

`animate()` tweens or springs a plain JS value and calls `onUpdate(v)`
every frame. The smallest way to get real springs, with velocity and
overshoot, without the react-spring host.

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

With no `requestAnimationFrame`, popmotion falls back to a 16.7 ms
`setTimeout`, so it needs no configuration. For latency-adaptive pacing,
pass `animate()` a custom `driver` backed by the ntk window's clock.

- Springs on layout properties (width, margin) cost a yoga layout pass per
  frame, as react-x11's own layout transitions do.
- `animate` interpolates colour strings (`'#f00' → '#00f'`), and the
  `rgba(...)` strings it emits paint as-is.
- Use only the value APIs — `animate`, `spring`, `decay`, `mix` — not
  `styler` or the DOM helpers.

## d3-ease {#d3-ease}

**Out of the box.** d3-ease@3.0.1.

Pure easing functions — `ease(t)` maps normalized time to progress — with
thirty-plus curves (cubic, elastic, bounce, back) the built-in `transition`
lacks. Compute `t` from wall time, pass `ease(t)` to an interpolator, push
the result into a style prop.

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

- ESM-only since v3 — `import`, not `require()`.
- It is only the curve; you own the clock and the interpolation.
- Overshooting curves (elastic, back) leave the from/to range; clamp before
  feeding anything react-x11 validates as non-negative.

## d3-interpolate {#d3-interpolate}

**Out of the box.** d3-interpolate@3.0.1.

`interpolate(a, b)` returns `t => value` for numbers, colours in any CSS
space, strings with embedded numbers, dates, arrays and nested objects.
`interpolateRgb` emits `'rgb(r, g, b)'` strings, which paint as-is. (The
interpolator behind react-x11's `transition` is not exported.)

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
  key, giving fractional values to properties that want integers.
  Interpolate only the properties you mean.
- There is no `opacity`; to fade, interpolate a colour's alpha into
  `backgroundColor: 'rgba(...)'`.
- `interpolateArray` over polygon points feeding `<canvas onDraw>` is a good
  use of the general form.

## `@tweenjs/tween.js` {#tweenjs}

**Out of the box.** @tweenjs/tween.js@25.0.0.

`new Tween(obj).to(target, ms).easing(...).onUpdate(...).start()`, then
_you_ call `tween.update(time)` on your own clock — there is no implicit
global loop. In an app, pump from the ntk window's `requestAnimationFrame`;
with many tweens, one `Group` per window lets `group.update(now)` step them
all from the same tick.

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

- Numbers only, including nested in objects and arrays. For colours use
  d3-interpolate or popmotion.
- Nothing animates until something calls `update()` — the classic first
  bug.
- `onUpdate` mutates the source object, so spread it into fresh state
  (`setPos({ ...state })`) or React skips the re-render on identity.

## flubber {#flubber}

**Out of the box.** flubber@0.4.2.

Shape morphing for SVG paths: `interpolate(from, to)` returns
`t => d-string`, handling ring alignment, point insertion and topology
changes so intermediate frames do not self-intersect.

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
- Build the interpolator once (module scope or `useMemo`); construction is
  the expensive part.
- Every frame is a full SVG parse and rasterize of the `source` string. Fine
  for icons and small figures; for large scenes draw the interpolated points
  in `<canvas onDraw>`.
- 0.4.2 since 2017 — finished rather than unmaintained.

## react-transition-group {#react-transition-group}

**Out of the box — with `nodeRef`.** react-transition-group@4.4.5.

A transition _state machine_, not an animator: `<Transition in={bool}
timeout={ms}>` walks its child through `entering`/`entered`/`exiting`/
`exited` on a timer and keeps it mounted during exit — the way to keep an
element mounted while it animates out, which react-x11 has no built-in for.

Always pass `nodeRef` — without it, v4 falls back to `ReactDOM.findDOMNode`,
which cannot handle a react-x11 node. Map states to styles yourself, with the
built-in `transition` style so the flip _tweens_ instead of snapping.

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

- **`react-dom` must be in `node_modules`.** `cjs/Transition.js` requires it
  at module scope for the `findDOMNode` fallback, even when `nodeRef` means
  it is never called. Install the peer; nothing renders through it.
- `CSSTransition` toggles class names, and there are none. Use plain
  `Transition`.
- `timeout` and your transition duration are independent; keep them equal,
  or the state flips mid-tween.
- `addEndListener` works; call the provided `done` yourself.

## `@react-spring/core` {#react-spring}

**Adapter, ~20 lines.** @react-spring/core@10.1.2,
@react-spring/animated@10.1.2.

The platform-independent half of react-spring: `useSpring`,
`useTransition`, `useTrail`, `SpringValue`, `Controller` — springs,
interruption with velocity carry-over, `api.start()`.
`@react-spring/animated` provides `createHost`, the documented seam for a
non-DOM target (how `@react-spring/native` and `/three` exist). Two public
seams do the work:

- `Globals.assign({ now, requestAnimationFrame })` points the frame loop at
  a clock.
- `createHost(['box', …], { applyAnimatedValues })` produces `animated.box`.
  Each frame, react-spring calls `applyAnimatedValues(instance, props)` with
  the react-x11 node, and `node.applyProps(next, prev)` is the imperative
  path the reconciler's `commitUpdate` uses. A component renders once while
  hundreds of frames apply.

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

- **Merge `style` one level deep in `applyAnimatedValues`** — the
  number-one silent failure. Frames carry _animated leaves only_
  (`props.getValue(true)`), so static keys (`height: 30` beside an animated
  `width`) are absent, and a naive `{...prev, ...props}` merge wipes them:
  the box paints nothing, with no error.
- Hex, `rgb()` and `rgba()` strings interpolate; named CSS colours are not
  enabled by default in `@react-spring/shared`.
- Do not use `useScroll`, `useResize`, `useInView` or `useReducedMotion` from
  core; they observe the DOM `window` and `matchMedia`.
  `Globals.assign({ skipAnimation })` is the manual reduced-motion switch.
- Style arrays (`style={[a, b]}`) defeat the shallow merge. Flatten first —
  react-x11 exports `flattenStyle`.
- A `setImmediate` clock runs frames as fast as the event loop turns — fine
  for tests, wasteful for apps. Use the ntk window clock or a 16 ms timeout.

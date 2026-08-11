# Extending the element vocabulary

`<box>`, `<text>`, `<glarea>` and the rest are built in, but the list is not
closed. `registerElement()` adds an element from outside the package — a
`<sparkline>`, a tray icon, an XEMBED `<foreign>` — so a sibling package can
ship one without forking react-x11 and without the core growing.

```js
import { registerElement } from 'react-x11/host';
import { Node } from 'react-x11/node';

class SparklineNode extends Node {
  constructor(props, app) {
    super('sparkline', props, app); // the kind must be the element name
  }

  paint(ctx) {
    super.paint(ctx); // background, border, clip
    const { x, y, width, height } = this.abs;
    const data = this.props.data ?? [];
    const max = Math.max(1, ...data);
    ctx.beginPath();
    data.forEach((value, i) => {
      const px = x + (width * i) / Math.max(1, data.length - 1);
      const py = y + height - (height * value) / max;
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    });
    ctx.strokeStyle = this.props.color ?? '#000';
    ctx.stroke();
  }
}

registerElement('sparkline', {
  create: (props, app) => new SparklineNode(props, app),
  semanticNames: ['data', 'color'],
});
```

```jsx
<sparkline
  data={[1, 4, 2, 8]}
  color="#c0392b"
  style={{ width: 120, height: 40 }}
/>
```

Register before you render. The registry is consulted when an element is
first created, so a late registration only affects trees mounted after it.

## The definition

| field                         |                                                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `create(props, app, hostCtx)` | builds the node. `app` is the ntk connection — the second argument every built-in node constructor takes. Must return a `Node`.       |
| `drawn`                       | default `true`: lays out with yoga and paints into the owning window. `false` for a node that owns a real child X window (see below). |
| `semanticNames`               | prop names this element owns even though they are also style names                                                                    |
| `childrenAllowed`             | default `true`; `false` rejects children by name instead of laying out something that never paints                                    |
| `override`                    | replace an existing registration. Off by default — two packages claiming one name is a conflict worth hearing about                   |

Two of these exist because getting them wrong fails a long way from the
cause, so they are worth understanding rather than copying:

**`drawn` decides whether your element paints at all.** `paintOrder()`
filters children on the set of drawn kinds; a node missing from it lays out
correctly, reports a sensible `abs` rect, and never appears on screen, with
no error anywhere. `registerElement` puts you in that set unless you opt out.

**`semanticNames` is the difference between DEV and production.** react-x11
throws in development on `<box width={10} />`, because `width` is a style
property written flat — a real mistake with an unhelpful failure otherwise.
An element whose own vocabulary overlaps the style vocabulary (`width`,
`color`, `fontSize`) therefore has to say so, or it throws on its own props
in development and works in production. `<window width>` is the built-in
precedent: on a `<window>` it is the X window's width and never style.

`react-x11/style`'s `isStyleProp(name)` is how to check whether a name you
are about to use needs declaring.

## The node contract

`Node` already implements the whole reconciler-facing surface, so an element
that only draws needs a constructor and a `paint`. What you may override:

| method                         | when                                                                                                |
| ------------------------------ | --------------------------------------------------------------------------------------------------- |
| `paint(ctx)`                   | draw. Call `super.paint(ctx)` first for background, border and clip, then draw inside `this.abs`.   |
| `applyProps(next, prev)`       | props changed. Call `super.applyProps(next, prev)`; invalidate if you cache anything derived.       |
| `measureContent(constraints)`  | your content has a size of its own (below). Leaves only — an element that measures has no children. |
| `default*(ev)`                 | the element's own behaviour for a key, a press or focus (below) — what makes it _interactive_.      |
| `hitTest(x, y)`                | non-rectangular hit areas. The default walks children in reverse paint order.                       |
| `insertBefore` / `removeChild` | only if children mean something structural to you                                                   |
| `destroySubtree()`             | release anything you allocated (pixmaps, fonts, timers). Call `super.destroySubtree()`.             |

And what you read:

- `this.props` — the current props, replaced wholesale on update.
- `this.style` — the flattened `style` prop with the active `:hover` /
  `:focus` / `:active` / `:disabled` blocks overlaid, and `$token`
  references already resolved against the theme. **Everything that paints or
  lays out reads this, never `props`.**
- `this.abs` — position and size within the owning window, valid after
  layout.
- `this.root` — the owning `<window>` node; `this.app` — the ntk connection.
- `this.theme` — the nearest theme at or above this node.

To ask for a repaint: `this.root?.invalidate(layout, rect, reason)`. Pass a
`rect` when you know what changed — an invalidation with no bound repaints
the whole window, which is this renderer's main performance bug class (see
[debugging.md](debugging.md)). `reason` joins the closed set the diagnostics
print.

### A size of your own

`<box>` is as big as its style and its children say; a gauge, a chart, a
terminal or an editor is as big as its _content_ says. An element with a size
of its own implements **`measureContent`**, and layout asks it whenever the
size on an axis is the element's to give:

```js
const TICK = 30;

class GaugeNode extends Node {
  measureContent({ width }) {
    const ticks = Math.max(1, Number(this.props.ticks ?? 4));
    // never wider than the offer, never narrower than one tick
    return { width: Math.max(TICK, Math.min(ticks * TICK, width)), height: 24 };
  }

  applyProps(next, prev) {
    const before = prev ?? this.props;
    super.applyProps(next, prev);
    // the measurement reads `ticks`, so a new one has to be taken
    if (next.ticks !== before.ticks) this.invalidateMeasure();
  }
}
```

`<gauge ticks={6} />` is then 180×24 with nothing in the style saying so, the
way `<textarea rows={6}>` is six lines tall.

It has to be a **method on the class**: the base `Node` constructor is what
wires it to layout, so an element that assigns it in its own constructor is
too late and never gets asked. `invalidateMeasure()` says so in development.

#### What it is asked

The argument is `{ width, height, widthMode, heightMode }`. Each mode says
what the number beside it means, and an unbounded axis arrives as `Infinity`
rather than as a sentinel — so `Math.min(preferred, width)` is the right
answer in all three, and the mode is there for the cases where it is not:

| asked with       | the element answers                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `unconstrained`  | its natural size — nothing bounds this axis (`<textarea>`: its preferred width, `rows` tall)                                   |
| `at-most`        | its natural size, clamped into the offer                                                                                       |
| `at-most` with 0 | **the smallest it can be drawn at** — an editor: a character or two of one line; something that scrolls inside: honestly small |
| `exactly`        | the style decided this axis; hand the number back and answer for the other one                                                 |

The `at-most 0` row is the one worth reading twice, because something else
asks it: `<window minWidth="auto">` measures the smallest size its content
can be drawn at by laying the tree out with **no room at all** and asking
every leaf directly ([elements.md](elements.md#a-floor-the-content-decides)).
An element that answers 0 there is saying it can be squeezed to nothing, and
the window's floor comes out without it.

`at-most` is what is _available_, not a cap that will be enforced: an element
may answer larger and it will be laid out at what it asked for, overflowing
whatever contains it. That is how `<text textWrap="nowrap">` works, and it is
the honest answer for content that genuinely does not reflow — a code block
that scrolls sideways rather than wrapping.

#### What it must not do

`measureContent` is a **question about a hypothetical**, asked several times
per layout and at sizes nothing will ever be drawn at. So:

- **do not read `this.abs`** — it is the result of the layout doing the
  asking, and last frame's answer at that;
- **do not paint, invalidate, or set state.** Cache derived work if it is
  expensive (`<text>` memoizes its shaped layout per width), but keep the
  answer a pure function of the content and the constraints;
- **answer with finite numbers.** Content that has not arrived yet is
  `{ width: 0, height: 0 }`, not `undefined` — anything else throws naming
  the element, because a `NaN` would otherwise spread silently through every
  ancestor's rect.

An element that measures itself **cannot have children**: layout sizes it
from the measure function and gives its children no say, so rendering one
inside it is an error naming both elements.

#### Saying the answer moved

Layout caches what an element measured to. `invalidateMeasure(reason?)` is
how the element says that cache is stale — a prop the measurement read
changed, data arrived, a font loaded — and the next frame asks again. Nothing
does this for you: only the element knows which of its inputs the measurement
reads. `reason` joins the closed set the diagnostics print
([debugging.md](debugging.md#invalidation-reasons)); the default is
`'measure'`.

#### Content with an aspect ratio

The `<image>`/`<svg>` shape — a natural size to keep the proportions of — is
one call:

```js
import { Node, intrinsicSize } from 'react-x11/node';

class ThumbNode extends Node {
  measureContent(constraints) {
    return intrinsicSize(this.decoded ?? { width: 0, height: 0 }, constraints);
  }
}
```

It shrinks to the width on offer with the height following, and scales the
width from a style height when only that axis is fixed — which is what an
`<img>` does, and is the whole of `<image>`'s own measurement.

### Behaviour of your own

An element that _does_ something — an editor, a terminal, a table with cell
editing, a tree with type-ahead — implements the **default actions**. They are
the same seam `<textinput>`'s editing runs on, and the ordering is the whole
point:

1. the application's `onKeyDown` / `onMouseDown` / … handlers, capture then
   bubble;
2. **if none of them called `ev.preventDefault()`**, the element's `default*`
   method.

So an app can veto the behaviour, or run something before it, without knowing
how the element is built — which is what `<textinput onKeyDown>` has always
been able to do, and is the reason to implement behaviour here rather than in
a React component wrapping the element.

| method                   | when                                                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `defaultKeyDown(ev)`     | a key, delivered to the focused node. `ev.keysym` is the `XK_*` constant; `codepoint >= 0x20` is the test for "this is text" |
| `defaultMouseDown(ev)`   | a press. Place a caret, grab a handle; `ev.capturePointer()` to keep the rest of the gesture                                 |
| `defaultMouseDrag(ev)`   | motion while _this_ element holds the press — including outside its box, which `onMouseMove` does not give you               |
| `defaultMouseUp(ev)`     | that press was released                                                                                                      |
| `defaultContextMenu(ev)` | right-click, after the press: open your own menu. Separate so suppressing it keeps the caret placement                       |
| `defaultFocus()`         | this element became the focused node (or its window got the X focus back): start the caret blinking                          |
| `defaultBlur()`          | focus left, or the window lost it: stop it                                                                                   |

```js
import { Node, CARET_BLINK_MS } from 'react-x11/node';
import { XK_TAB, XK_ESCAPE } from 'react-x11/keysyms';

class EditorNode extends Node {
  constructor(props, app) {
    super('codeeditor', props, app);
    // without this nothing focuses it, and no key ever arrives
    this.focusableByDefault = true;
    this.defaultCursor = 'text';
  }

  defaultKeyDown(ev) {
    if (ev.keysym === XK_ESCAPE) {
      // the way out: the next Tab leaves, so the element is never a trap
      this._tabEscapes = true;
      return;
    }
    if (ev.keysym === XK_TAB) {
      if (this._tabEscapes) {
        this._tabEscapes = false; // one Tab, then it indents again
        return; // …and this one belongs to focus traversal
      }
      this.indent(ev.shiftKey ? -1 : 1);
      ev.preventDefault(); // this one is mine
      return;
    }
    this._tabEscapes = false;
    if (ev.codepoint >= 0x20) this.insert(ev.key);
  }

  defaultFocus() {
    this._caretOn = true;
    this._blink = setInterval(() => {
      this._caretOn = !this._caretOn;
      this.root?.invalidate(false, this, 'caret');
    }, CARET_BLINK_MS);
    this._blink.unref?.();
  }

  defaultBlur() {
    clearInterval(this._blink);
    this._blink = null;
    this._caretOn = false;
  }
}
```

Four details worth having in writing:

**A gesture is vetoed once, at its press.** `defaultMouseDrag` and
`defaultMouseUp` are the continuation of the press `defaultMouseDown` got, so
a handler that prevented the press means none of the three run — an element
never hears about motion it has no press behind, and does not need a
`dragging` flag of its own to discover that.

**Focus is a prerequisite, not a consequence.** Keys are delivered to the
focused node, and nothing focuses an element that has not said it can be:
`focusableByDefault = true` makes it a tab stop and a press target the way
`<textinput>` is one, and an application's `focusable={false}` or `tabIndex`
still overrides it ([events.md](events.md#focus)).

**Tab is an ordinary key here.** It reaches `defaultKeyDown` before focus
traversal sees it, so an element can keep it — an editor indenting with Tab
does not need a wrapping component to get it, which is what the ordering used
to force. Consuming it means calling `ev.preventDefault()` from the default
action: what that prevents is the default action _after_ this one, which for
Tab is the focus cycle.

An element that eats Tab has taken the keyboard user's only way out of it, so
it owes them another. The convention, above and worth converging on: **Escape
arms one pass-through Tab.** Escape on its own does nothing visible, the next
Tab leaves, and the one after that indents again — the same bargain a code
editor on the web makes, and the reason a screen-reader user is not stuck in
your element.

**A caret blinks at `CARET_BLINK_MS`.** It is the cadence `<textinput>` uses,
exported so that two carets on one screen are in step rather than a few tens
of milliseconds apart. Stop the timer in `defaultBlur` _and_ in
`destroySubtree`: a node that unmounts while focused is forgotten rather than
blurred, so `defaultBlur` is not guaranteed to run.

### Drawing once instead of every frame

A drawing that does not change between frames does not have to be redrawn
between frames. Implement two more methods and your element is rendered once
and composited on later repaints, sharing one rendered copy with every other
node that produces the same key:

| method                  |                                                                               |
| ----------------------- | ----------------------------------------------------------------------------- |
| `paintCachePlan()`      | `null` to opt out this frame, or `{ key, x, y, width, height, format, tint }` |
| `paintCached(ctx, box)` | draw, at the **origin of `box`** — not at `this.abs`                          |

```js
paintCachePlan() {
  const width = Math.round(this.abs.width);
  const height = Math.round(this.abs.height);
  if (width <= 0 || height <= 0) return null;
  return {
    key: `sparkline|${width}x${height}|${this.props.seriesId}`,
    x: Math.round(this.abs.x),
    y: Math.round(this.abs.y),
    width,
    height,
    format: 'argb32',
    tint: null,
  };
}

paintCached(ctx, box) {
  this.drawSeries(ctx, box.x, box.y, box.width, box.height);
}
```

`format: 'a8'` stores coverage rather than colour and paints through `tint`,
so one rendered copy serves every colour the drawing is ever asked for — the
right choice for a monochrome drawing, and it keeps the colour out of the key.

**The key is the entire correctness surface.** It must name every input
`paintCached` reads, and it should be derived from the same values
`applyProps` compares so the two cannot drift. A key that misses something
shows stale pixels, which is the hardest kind of bug to see — so develop with
`REACT_X11_PAINT_CACHE=verify`, which re-renders every hit and complains
loudly when the drawing changed while the key did not. Return `null` for
anything animated, hovered, focused or blinking.

Two footguns worth naming. `paintCached` draws in **surface-local**
coordinates: reaching for `this.abs.x` inside it is the first thing to check
when a cached element paints in the wrong place. And the cache is per X
connection and keyed only on your string, so make the key specific enough
that two different drawings cannot collide — prefix it with your element
name, as above.

`globalAlpha`, the clip and any ancestor translation are applied when the
cached copy is composited, so an ancestor animating opacity is a cache hit
rather than a reason to opt out.

### Elements that own a real X window

`drawn: false` is for a node backed by its own child X window rather than
painted into its parent — a GL surface, an XEMBED socket, a video overlay.
`GlAreaNode` (`src/glnodes.js`) is the worked example: it holds no paint
code, and the owning `WindowNode` realizes it in the commit phase
(`_realizeGlAreas`) so the child window names its real parent from the
start. Read those two together before writing a third one; the ordering
constraint — no X calls in the render phase, because the render phase is
discardable — is the part that is easy to get wrong.

## The subpath exports

| subpath             |                                                                                                          |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| `react-x11/host`    | `registerElement`, `unregisterElement`, `registeredElements`, `hostTypes`, `knownElements`, `drawnKinds` |
| `react-x11/node`    | `Node`, the built-in node classes, `Scrollable`, `intrinsicSize`                                         |
| `react-x11/style`   | `createStyles`, `flattenStyle`, `isStyleProp`, `resolveTokens`, the rest of the vocabulary               |
| `react-x11/ntk`     | ntk itself, re-exported                                                                                  |
| `react-x11/keysyms` | the `XK_*` constants                                                                                     |

**Reach ntk through `react-x11/ntk`, not a second dependency.** Two copies
of ntk in one process means two Yoga instances and two font caches, and a
node built against one cannot be painted by the other — a failure that
looks like a layout bug rather than a dependency bug.

## Typing

The element also has to be declared to JSX, which is module augmentation —
the same mechanism [typescript.md](typescript.md) describes:

```ts
import type { Style } from 'react-x11/style';

declare module 'react-x11/jsx-runtime' {
  namespace JSX {
    interface IntrinsicElements {
      sparkline: {
        data: number[];
        color?: string;
        style?: Style;
        ref?: React.Ref<unknown>;
      };
    }
  }
}
```

`test/types/extend.tsx` in this repo compiles exactly that, so the story
stays true as the declarations move.

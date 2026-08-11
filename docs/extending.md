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

| method                         | when                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `paint(ctx)`                   | draw. Call `super.paint(ctx)` first for background, border and clip, then draw inside `this.abs`.            |
| `paintContent(ctx)`            | draw _between_ the background and the children — where the built-ins draw, and what a scroller needs (below) |
| `applyProps(next, prev)`       | props changed. Call `super.applyProps(next, prev)`; invalidate if you cache anything derived.                |
| `measureContent(constraints)`  | your content has a size of its own (below). Leaves only — an element that measures has no children.          |
| `default*(ev)`                 | the element's own behaviour for a key, a press or focus (below) — what makes it _interactive_.               |
| `hitTest(x, y)`                | non-rectangular hit areas. The default walks children in reverse paint order.                                |
| `insertBefore` / `removeChild` | only if children mean something structural to you                                                            |
| `destroySubtree()`             | release anything you allocated (pixmaps, fonts, timers). Call `super.destroySubtree()`.                      |

And what you read:

- `this.props` — the current props, replaced wholesale on update.
- `this.style` — the flattened `style` prop with the active `:hover` /
  `:focus` / `:active` / `:disabled` blocks overlaid, and `$token`
  references already resolved against the theme. **Everything that paints or
  lays out reads this, never `props`.**
- `this.abs` — position and size within the owning window, valid after
  layout.
- `this.contentBox()` — `abs` inset by the border and the padding: where the
  content goes, and where every built-in draws.
- `this.resolvedTextStyle()` — the text style this node resolves to, ready to
  hand to `app.fonts.layout` (below).
- `this.direction` — which way this node reads, resolved: `'ltr'` or
  `'rtl'`, never `'inherit'`. Yoga has already mirrored the boxes, so this
  is for what you draw _inside_ one — which side a mark sits on, which way
  a chevron points, what a pointer coordinate means
  ([styling.md](styling.md#direction-and-the-logical-edges)).
- `this.root` — the owning `<window>` node; `this.app` — the ntk connection.
- `this.theme` — the nearest theme at or above this node.

To ask for a repaint: `this.invalidate(layout, damage, reason)`. Pass the
damage — `this` is usually it, or a rect when you know a tighter one. An
invalidation with no bound repaints the whole window, which is this
renderer's main performance bug class (see [debugging.md](debugging.md)).
`reason` joins the closed set the diagnostics print. Damage is collected on
the window node and `invalidate` on any node forwards there, so an element
that is not attached yet invalidates nothing rather than throwing.

And to take the keyboard focus: `this.focus()` moves it here as a click
would and hands the node back, `this.blur()` gives it up, `this.focused` and
`this.focusWithin` answer where it is. They claim their own damage — a
focused control repaints itself, and its ring, without being asked.

### Text of your own

An element that draws text — a badge, a code editor, a terminal — shapes it
through ntk's font manager, and the two things it needs to do that are the
two accessors above:

```js
class BadgeNode extends Node {
  paint(ctx) {
    super.paint(ctx); // background, border, clip
    const fonts = this.app?.fonts;
    if (!fonts) return; // headless: no font manager, nothing to shape with
    const box = this.contentBox();
    const layout = fonts.layout(
      String(this.props.label ?? ''),
      this.resolvedTextStyle(),
      { maxWidth: box.width || undefined },
    );
    layout.draw(ctx, box.x, box.y);
  }
}
```

**`contentBox()` is not `abs` minus `style.padding`.** The insets come off
the layout, which is where `padding: '10%'`, the per-side overrides and the
border widths have already been resolved against this frame's size — so the
box an element computes from the style bag agrees with the one `<text>` uses
only by luck, and stops agreeing the next time the vocabulary grows another
edge — the per-side border widths were the last one to arrive.

**`resolvedTextStyle()` is what makes the type of an app reach your
element.** It is the node's own font properties over what it **inherits**
from the elements around it, and under that what the palette says text with
none of its own is set in — in the shape `fonts.layout` wants (`family`, not
`fontFamily`; `variations`, not `fontVariationSettings`). An element that
reads `this.style.fontFamily` instead is one that a
`<ThemeProvider value={{ fontFamily: 'Inter' }}>` does not reach, and one
that a `<box style={{ color: theme.dim }}>` around it does not dim — bugs an
app author can only work around by growing props on your element and
threading them in. Ask, and the element inherits exactly what a `<text>`
sibling inherits, including a `:hover` block on the row it sits in
([styling.md](styling.md#inheritance-the-ink-the-face-and-the-size)).

Both are read at paint time. `contentBox()` is computed each call, since the
box changes with every layout; `resolvedTextStyle()` is memoised and dropped
by everything that can move it — a style change, a state block, an
animation tick, a theme swap, an element above it changing its own type — so
reading it per frame costs a property lookup and never goes stale. If the
text is also what _sizes_ the element, shape it in `measureContent` as well;
`<text>` memoizes its layout per max-width for exactly that reason. An
element that keeps a cache of its own keyed on the type — a shaped run, a
rasterized label — should drop it in **`_textStyleMoved(cost)`**, which is
called with `2` when a glyph can have moved and `1` when only the ink or the
glyph rounding did. The default re-measures on the first and repaints on the
second, which is right for most elements.

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

| method                   | when                                                                                                                                                                                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `defaultKeyDown(ev)`     | a key, delivered to the focused node. `ev.keysym` is the `XK_*` constant — the Latin one, so a chord matches under any layout; `codepoint >= 0x20` is the test for "this is text"                                           |
| `defaultKeyUp(ev)`       | that key was released. Rare — nothing in core needs it — and there for an element that answers the whole keystroke rather than the press, such as `<foreign>` forwarding into an embedded client                            |
| `defaultComposition(ev)` | text still being typed — a dead key, a Compose sequence. `ev.type` is the phase, `ev.data` what to show, or at the end what to insert                                                                                       |
| `defaultMouseDown(ev)`   | a press. Place a caret, grab a handle; `ev.capturePointer()` to keep the rest of the gesture                                                                                                                                |
| `defaultMouseDrag(ev)`   | motion while _this_ element holds the press — including outside its box, which `onMouseMove` does not give you                                                                                                              |
| `defaultMouseUp(ev)`     | that press was released                                                                                                                                                                                                     |
| `defaultContextMenu(ev)` | right-click, after the press: open your own menu. Separate so suppressing it keeps the caret placement                                                                                                                      |
| `defaultFocus(info)`     | this element became the focused node (or its window got the X focus back): start the caret blinking. `info` is `{ reason, backwards }` — `'key'` with a direction is a Tab, which is the only thing that has ever needed it |
| `defaultBlur()`          | focus left, or the window lost it: stop it                                                                                                                                                                                  |

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

**An element that types text implements `defaultComposition` too.** `é` is
a dead key and then a letter, and the keys that make it never reach
`defaultKeyDown` — so an element that only implements the key path types the
letter and drops the accent, which is the bug
[events.md](events.md#composition) describes. Three phases, and the third
is the only one that inserts anything:

```js
defaultComposition(ev) {
  if (ev.type === 'compositionEnd') {
    this.preedit = '';
    if (ev.data) this.insert(ev.data);   // one edit, one undo entry
  } else {
    this.preedit = ev.data;              // draw it at the caret, underlined
  }
  this.root?.invalidate(false, this, 'text');
}
```

**An element that forwards keys somewhere else sets `composes = false`**
instead. Composition is ours to run only when the text lands in our tree;
an element handing the raw key event to another program — `<foreign>` and
its embedded client — wants the dead key itself, and the client's own input
method takes it from there.

The preedit is deliberately not part of your value: it never reaches
`onChange` or the undo history, a controlled value rewritten mid-composition
cannot corrupt it, and abandoning it — Escape, focus leaving — is dropping a
string rather than undoing an edit. Not implementing it at all is a
supported position for an element that holds no text; the composition then
simply goes nowhere.

**A caret blinks at `CARET_BLINK_MS`.** It is the cadence `<textinput>` uses,
exported so that two carets on one screen are in step rather than a few tens
of milliseconds apart. Stop the timer in `defaultBlur` _and_ in
`destroySubtree`: a node that unmounts while focused is forgotten rather than
blurred, so `defaultBlur` is not guaranteed to run.

### Scrolling content you painted

A `<box overflow="scroll">` scrolls **children**: layout knows where they
are, so the extent, the bars, the clamping and the wheel all follow from the
tree. An editor, a terminal or a canvas-backed table has no children — its
content is pixels it draws — and it still has a scroll position, an extent
and a wheel gesture to answer. Two methods make it a member of the same
machinery instead of an exception to it (issue #253):

| method                   |                                                                                                     |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| `canScroll(dx, dy)`      | is there room to move on the axis this delta names? The wheel asks before it scrolls you            |
| `scrollBy(by)`           | `scrollBy(dy)` or `scrollBy({x, y})` — move by that much                                            |
| `measureScrollContent()` | `Scrollable` only: `{ width, height }`, how far the content reaches. The default walks the children |

**The wheel's default action is those first two and nothing else.** It walks
out from the node the pointer hit, asks each one `canScroll(deltaX, deltaY)`,
and the first that says yes gets `scrollBy` — up to the `<window>`, where the
walk stops. So an element joins the chain by answering two questions, and it
**chains** by answering the first of them honestly: say no when there is
nothing left to move and the wheel goes to the pane or the window behind you,
which is what a browser does and what a user flicking through a long page
expects. `<textarea>` is the worked example in core — it scrolls wrapped text
it painted, and since it answers `canScroll` off that text, a short one hands
the gesture outward rather than swallowing it.

Answer `canScroll` from the **extent, not the position**: a viewport already
scrolled to its bottom should keep the rest of a flick rather than pass it
to whatever is behind it.

Both deltas are **whole pixels**, and stay whole however the scroll was
measured. A touchpad on a server with XI2 reports fractions of a notch and
`ev.deltaY` carries them ([events.md](events.md#wheel)), but the default
action spends only the whole part and carries the rest to the next event —
because a fractional scroll offset is one the server-side blit cannot shift,
and a smooth gesture that repainted every frame would cost more than it
looks. So an element joining the chain never has to think about sub-pixels,
and a slow scroll still moves: a pixel at a time.

#### The mixin, for everything else

`canScroll` + `scrollBy` buys the wheel. `Scrollable(Node)` buys the rest —
the offsets, `scrollTo`/`scrollBy`/`scrollIntoView`, the drawn scrollbars and
their drags, the scroll keys (arrows, Page, Home/End, Space), the tab stop
and the AT-SPI scroll-pane role — and all of it reads one number pair:

```js
import { Node, Scrollable } from 'react-x11/node';

const LINE = 16;

class EditorNode extends Scrollable(Node) {
  constructor(props, app) {
    super('codeeditor', props, app);
  }

  // scrolling is what this element *is*, rather than something an app opts
  // into with a style; the default answers `overflow: 'scroll'`
  isScroller() {
    return true;
  }

  // …and the one thing only this element knows: how far the drawing goes
  measureScrollContent() {
    return {
      width: this.longestLineWidth(),
      height: LINE * this.lines.length,
    };
  }

  paintContent(ctx) {
    const box = this.contentBox();
    ctx.save();
    ctx.beginPath();
    ctx.rect(box.x, box.y, box.width, box.height);
    ctx.clip();
    this.drawLines(ctx, box.x - this.scrollX, box.y - this.scrollY);
    ctx.restore();
  }
}
```

Three things about that, each of which is a bug if you get it the other way
round:

**Draw in `paintContent`, not in `paint`.** `paint` draws the background,
then `paintContent`, then the children, the border, and — for a
`Scrollable` — the scrollbars last. An element that draws after
`super.paint(ctx)` returns therefore paints _over its own thumb_.
`paintContent` is the seam every built-in that draws uses, and it is where a
drawing belongs whether it scrolls or not.

**Offset the drawing yourself, and clip it.** A `<box>`'s children are moved
by the scroll during layout; nobody moves pixels. `contentBox()` is the
viewport to clip to and `scrollX`/`scrollY` are what to subtract — they are
already clamped to the extent you reported, so there is nothing to bound
again. `scrollX` is a distance from the edge the content _starts_ at, which
is the right-hand one under `direction: 'rtl'`
([styling.md](styling.md#direction-and-the-logical-edges)) — and the `width` you report is that
same reach, so an element that draws in its own reading direction never has
to ask which one it is in.

**Do not assign `focusableByDefault`.** `Scrollable` answers it — a pane with
somewhere to go is a tab stop, one that fits is not — and assigning over the
getter throws. Override the getter if your element is focusable for a reason
of its own.

`measureScrollContent` is called once per layout pass, from `absolutize`, so
it may read layout geometry, but it must not paint or invalidate. It has to
return finite numbers: a `NaN` extent would otherwise become a `NaN` offset
and a subtree laid out at `NaN`, so returning anything else throws naming the
element, exactly as `measureContent` does.

When the drawing changes its own extent — a line was typed, rows arrived —
say so the way any other layout change is said, with
`this.invalidate(true, this, 'scroll')`; the next pass asks again.

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
There are two worked examples, and they are worth reading in this order.

`GlAreaNode` (`src/glnodes.js`) is the simple one: it holds no paint code,
and the owning `WindowNode` realizes it in the commit phase
(`_realizeChildWindows`) so the child window names its real parent from the
start. The ordering constraint — no X calls in the render phase, because the
render phase is discardable — is the part that is easy to get wrong.

`ForeignNode` (`src/foreignnodes.js`) is the same shape with the stakes
raised, and it is the one to read if your element touches a resource you did
not create. Three things it has to do that a GL surface does not:

- **Nothing in the render phase, for a sharper reason.** A `CreateWindow`
  from a discarded render leaks a server resource; a `ReparentWindow` from
  one has moved another application's window for real.
- **Teardown is synchronous.** `WindowNode.destroySubtree` destroys its own
  X window in the same turn your node's does, and `DestroyWindow` takes every
  inferior with it — so a release that waits for a round trip releases a
  window that no longer exists. Compute what you would have asked for; the
  requests are ordered on the connection, which is what makes "hand it back,
  _then_ destroy the container" a guarantee.
- **Give it back, do not destroy it.** The element's own test file asserts
  that first, because it is the failure this shape is most able to cause.

## The subpath exports

| subpath             |                                                                                                          |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| `react-x11/host`    | `registerElement`, `unregisterElement`, `registeredElements`, `hostTypes`, `knownElements`, `drawnKinds` |
| `react-x11/node`    | `Node`, the built-in node classes, `Scrollable`, `intrinsicSize`                                         |
| `react-x11/style`   | `createStyles`, `flattenStyle`, `isStyleProp`, `resolveTokens`, the rest of the vocabulary               |
| `react-x11/ntk`     | ntk itself, re-exported                                                                                  |
| `react-x11/keysyms` | the `XK_*` constants, `keysymOf`, `charOf`, `MOD`, `ctrlChordLetter`                                     |

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

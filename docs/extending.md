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
| `selfDamagedProps`            | prop names whose damage the element's own `applyProps` claims (see [Drawing a scene](#drawing-a-scene-into-one-node))                 |
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

## Registering under hot reload {#hot-reload}

Register at module scope — the pattern everything above shows, and the one
tree-shaking forces on a component library. That module scope re-runs when
[`react-x11/refresh`](ecosystem/dev-tooling.md#react-refresh) hot-reloads
the module, so `registerElement` has a re-registration policy rather than
a footnote:

- **The same `create` reference is never a conflict.** A definition
  arriving twice replaces silently, latest flags winning.
- **Under an active hot-reload session, any duplicate replaces silently.**
  The session begins with the first hot re-import and covers the rest of
  the process: from then on, "already registered" would only mean
  "registered by the previous version of yourself". Mounted nodes keep the
  old prototype until they remount — the same staleness contract Fast
  Refresh has for classes; new mounts get the new definition.
- **Outside a session, a duplicate still throws.** Two packages claiming
  one element name in a plain run is a conflict to be told about, and
  `override: true` remains the way to say a replacement is deliberate.

One thing the hot loader adds: inside a hot module, call it through a
namespace or default import (`Host.registerElement(...)`) — a _named_
import called at module top level is a transform error there, because
named-import bindings initialize in a microtask after a reload.

## The node contract

`Node` already implements the whole reconciler-facing surface, so an element
that only draws needs a constructor and a `paint`. What you may override:

| method                         | when                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `paint(ctx)`                   | draw. Call `super.paint(ctx)` first for background, border and clip, then draw inside `this.abs`.            |
| `paintContent(ctx)`            | draw _between_ the background and the children — where the built-ins draw, and what a scroller needs (below) |
| `applyProps(next, prev)`       | props changed. Call `super.applyProps(next, prev)`; invalidate if you cache anything derived.                |
| `paintChanged(next, prev)`     | did anything you draw change? Only for an element that claims its own damage (below)                         |
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
- `this.paintDamage()` — the rect the pass being painted covers, or `null`
  for a full one. Only an element that draws a whole scene needs it
  ([below](#drawing-a-scene-into-one-node)).

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

### Answering for your own text

_Issue #259._ An element that draws text can also let the user **select**
it. There is no registration call and no list of blessed kinds: a
`selectable` ancestor walks its subtree and asks every node four questions,
and an element that answers them is part of the document.

```js
class LogViewNode extends Node {
  // the string the three below index into — null (the default) means
  // "this element has no text", which is the honest answer for a <box>
  textContent() {
    return this.lines.join('\n');
  }

  // window coordinates in, a code-point index out. Clamp: a point past the
  // end of the text is the end of the text, which is what a drag into the
  // margin depends on
  textIndexAt(x, y) {
    return this._layout().indexAt(x - this._originX(), y - this._originY());
  }

  // where a caret at that index stands: a zero-width rect, glyph top to
  // glyph bottom
  textCaretRect(index) {
    const caret = this._layout().caretPosition(index);
    return {
      x: this._originX() + caret.x,
      y: this._originY() + caret.y,
      width: 0,
      height: caret.height,
    };
  }

  // and the bands a highlight over [start, end) fills
  textRangeRects(start, end) {
    /* one per line — see below */
  }

  paint(ctx) {
    super.paint(ctx);
    // the range the document selection has claimed of *this* element's
    // text, pushed down whenever it moves. Paint it under the glyphs.
    const range = this.selectionRange;
    if (range) {
      ctx.fillStyle = this.selectionColor;
      const rects = [];
      for (const r of this.textRangeRects(range.start, range.end)) {
        rects.push(r.x, r.y, r.width, r.height);
      }
      ctx.fillRects(rects);
    }
    this._layout().draw(ctx, this._originX(), this._originY());
  }
}
```

**Two spaces, and both are the ones already in use.** Indices are **code
points** — the space ntk's `TextLayout.caretPosition`/`indexAt` speak, so an
emoji is one position and not two — and rectangles are in the **owning
window's** coordinates, the same as `abs`, `contentBox()` and a mouse
event's `x`/`y`. An element that answers in its own local coordinates is one
whose highlight is drawn somewhere else on the screen.

**Answer from what you draw.** `<text>` computes its layout and its origin
in one place and uses it for painting and for all four accessors, because a
caret answered from a differently-placed layout is a caret in the wrong
place and nothing about it looks like a bug in the accessor. If your element
scrolls, the origin has the scroll offset in it — that is what makes a hit
test right after the user has scrolled.

**One band per line, and one per direction run.** A selection is contiguous
in _logical_ order and a line is laid out in _visual_ order, so a range that
crosses from Latin into Arabic covers two disjoint stretches of pixels. If
you are drawing with ntk's `TextLayout`, walk `line.runs` and intersect each
one with the range rather than filling from one caret x to the other;
`<text>` does this and `test/text-selection.test.js` pins it.

**Say if you own a selection of your own.** An element that edits — anything
with a caret the user moves — sets `hasOwnSelection = true` in its
constructor. A `selectable` document then skips its subtree whole and never
takes its presses, which is what keeps a `<textinput>` inside a document
from having half of it lit by somebody else's drag.

**Presses arrive through the base class.** `Node`'s `defaultMouseDown`,
`defaultMouseDrag`, `defaultMouseUp` and `defaultKeyDown` hand the gesture
to the nearest `selectable` ancestor, so an element that only draws needs to
write none of them. An element that overrides one and does not call `super`
has taken that gesture for itself — right for an editor, and the reason a
drawing element that wants both should end its handler with
`super.defaultMouseDown(ev)`.

Everything about the surface side — what a copy assembles, what the
separators are, which keys are bound — is in
[elements.md](elements.md#selecting-text).

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

The `at-most 0` row is the one worth reading twice, because it is not only
the layout that asks it. The renderer measures the smallest size every node
can be drawn at — by laying the tree out with **no room at all** and asking
each leaf directly — and writes that back as the element's own floor, so a
row too narrow for it squeezes it that far and no further
([elements.md](elements.md#everything-shrinks-nothing-shrinks-to-nothing)).
The same measurement read at the top of the tree is what
`<window minWidth="auto">` sends the window manager. An element that answers
0 there is saying it can be squeezed to nothing, and both floors come out
without it.

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
| `defaultMouseMove(ev)`   | the pointer moved over this element, no button down — light the node, the edge, the handle it is over. The first one after it arrives is the enter                                                                          |
| `defaultMouseLeave(ev)`  | …and the pointer left: put that back                                                                                                                                                                                        |
| `defaultWheel(ev)`       | the wheel, before the scroll chain — for the element whose wheel is not a scroll. `ev.preventDefault()` consumes it                                                                                                         |
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

Details worth having in writing:

**A gesture is vetoed once, at its press.** `defaultMouseDrag` and
`defaultMouseUp` are the continuation of the press `defaultMouseDown` got, so
a handler that prevented the press means none of the three run — an element
never hears about motion it has no press behind, and does not need a
`dragging` flag of its own to discover that.

**Hover is motion, not a state you are handed.** `defaultMouseMove` runs for
the element the pointer is over — coalesced to once per frame, like every
motion — and `defaultMouseLeave` when it goes elsewhere, which is everything
a scene element needs to light the node, edge or handle under the pointer and
put it back. There is no `defaultMouseEnter`: the first motion after the
pointer arrives _is_ the enter, and it carries the position an enter would
have to be asked for. A capture suspends the pair — while a gesture owns the
pointer, hover stays frozen where it was and the motion goes to
`defaultMouseDrag` instead. And a node that unmounts while hovered is
_forgotten_ rather than left, exactly as one that unmounts while focused is,
so anything with a lifetime behind the highlight is released in
`destroySubtree` as well.

**The wheel that is not a scroll.** `canScroll`/`scrollBy`
([below](#scrolling-content-you-painted)) route the wheel for content that
scrolls, and they hand the element deltas only — which is the whole of the
gesture when the answer is "move by that much". It is not the whole of a zoom
about the pointer: that needs the point that must _not_ move (`ev.x`/`ev.y`)
and the modifier that tells a zoom from a pan, and it answers the wheel
whether or not anything "can scroll". `defaultWheel(ev)` is the whole event,
at the node under the pointer, before the chain walks; `ev.preventDefault()`
consumes it and the walk never runs. The deltas are as the device measured
them, fractions included — the whole-pixel rule the chain follows is there
for the scroll blit, and a zoom factor is continuous.

```js
defaultWheel(ev) {
  if (!ev.ctrlKey) return;             // an unmodified wheel still scrolls
  this.zoomAbout(ev.x, ev.y, Math.exp(-ev.deltaY / 400));
  ev.preventDefault();                 // …and this one was mine
}
```

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

### Text a screen reader can read

An element that draws text of its own is, to an assistive technology,
nothing at all: a painted rectangle with no characters, no caret and no
selection in it. `<textinput>` is not — it implements AT-SPI's `Text` and
`EditableText` interfaces in full — and the difference is one method
(issue #257):

```js
class EditorNode extends Node {
  a11yTextState() {
    return {
      value: this.lines.join('\n'), // what is drawn
      caret: this.caret, // code points, into `value`
      selectionStart: this.anchor,
      selectionEnd: this.caret,
      editable: true,
      multiline: true,
    };
  }

  insert(text) {
    // …the element's own edit…
    this.notifyA11yTextChanged();
  }
}
```

That alone buys the whole read side: character count, reading by character,
word and line, the caret, the selection, and the `text-changed` /
`text-caret-moved` / `text-selection-changed` deltas Orca narrates from —
through the same code that serves `<textinput>`, so a third-party editor is
read by the paths core is read by rather than by a parallel set of them.

| member                              | when                                                                                                                              |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `a11yTextState()`                   | always, for an element holding text. `null` for one that holds none                                                               |
| `notifyA11yTextChanged()`           | every edit, caret move, selection change and composition — the state is _pulled_ when this says it moved                          |
| `a11ySetSelection(start, end)`      | an AT moved the caret or selected a range; the caret belongs at `end`. Without it the element is read but not navigated           |
| `a11yReplaceText(start, end, text)` | an AT edited: replace that range. Insert, delete and set-the-lot all arrive here. Without it the element is read but not typed in |
| `a11yRole`                          | the ARIA role this element is when the app writes none — `'textbox'`, `'log'`, `'document'`. Assign it in the constructor         |

**The two tiers are the two kinds of element.** A viewer — a markdown
document, a code block, a log, a terminal — reports `value` and a selection
and stops there: it gets the `Text` interface, a `document` role, and a
selection an AT can read and set, which is the whole of what "select this
paragraph and copy it" needs. An editor adds `editable: true` and
`a11yReplaceText`, which is what turns on the EDITABLE state and the
`EditableText` interface. An element that claims `editable` without
implementing the write **is** still announced as editable and reports its
own edits — it simply is not exposed as one an AT may type into, because an
interface whose every method answered "no" is a lie an AT cannot see
through.

Four details, each of which is a defect the other way round:

**Offsets are code points and they index what you draw.** `Array.from(value)`
is the counting, and `value` is the string on the screen — an open
composition included, because every geometric answer beside it (the extents
of character _n_, a magnifier's highlight) is read off the glyphs a sighted
user sees. Say which part is uncommitted with `preedit: { offset, text }`
and its churn is marked as text the user did not type, exactly as
`<textinput>`'s is ([accessibility.md](accessibility.md#while-a-composition-is-open)).
Offsets you report are clamped for you, so a caret left stale between an
edit and your own bookkeeping cannot become an out-of-range answer on the
wire.

**`notifyA11yTextChanged()` is free when nobody is listening** — one
property read, the hook slots being empty until a bridge or the test spy
fills them. So call it from every path that moves the text, rather than
asking whether accessibility is on.

**`a11yTextState()` is called several times per change**, for the role, the
states and the diff. Answer from state the element already holds; it must
not shape, copy a buffer, or invalidate.

**Say `multiline`.** Left unsaid, neither the single-line nor the
multi-line state is claimed — better than a guess read off the current
value, which would report the element's shape _changing_ the first time
somebody pressed Enter.

The behaviour is assertable without a screen reader, a desktop or a bus:
`renderX11(el, { a11y: true })` hands back a spy that records the same feed
([accessibility.md](accessibility.md#asserting-what-a-screen-reader-would-hear)),
and `test/a11y-custom-text.test.js` in this repo is a worked editor and a
worked viewer driven through it.

### A scene a screen reader can walk

_Issue #304._ An element that draws a hundred interactive things is still
one node, so it is one accessible: a graph pane full of selectable,
draggable, connectable nodes reads out as **"Flow graph, group"** and stops
there. Nothing in it can be found, named, activated or told apart, and no
amount of `role`/`aria-*` on the element itself changes that — the objects
an assistive technology would need are not in the tree, because you drew
them.

Describe them and they are:

```js
class FlowNode extends Node {
  a11yScene() {
    return this.nodes.map((node) => ({
      id: node.id, // stable for as long as it is on screen
      role: 'listitem',
      name: node.label,
      rect: node.rect, // window coordinates, like `abs`
      states: {
        selected: this.selection.has(node.id),
        focused: this.cursor === node.id,
      },
    }));
  }

  select(id) {
    // …the element's own selection…
    this.notifyA11ySceneChanged();
  }
}
```

Each becomes a real child of your element's accessible: named, placed,
walked into, focusable, with `selected` announced as it changes — the same
model a `<box role="listitem" aria-selected>` goes through, because that is
literally what these are read as. `id` is the whole of what core needs from
you: it is what makes the child that was there last frame the same child
this frame, and therefore what keeps every reference a screen reader is
holding alive across a scene you rebuild sixty times a second.

| member                        | when                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `a11yScene()`                 | always, for an element that draws interactive things. Called once per question about your children — a cheap read, never a pass |
| `notifyA11ySceneChanged()`    | the scene moved between commits: a drag, an animation, your own arrow keys. A commit re-reads it on its own                     |
| `a11ySceneAction(id, action)` | an AT acted on one of them. Return `true` to claim it; anything else keeps core's answer                                        |

What one item may say:

| field                  |                                                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `id`                   | required. Its name for as long as it is drawn — ids are matched within their parent, not globally                    |
| `rect`                 | required. Where it is, in window coordinates: where AT focus is drawn and what a magnifier follows                   |
| `role`                 | an ARIA role. `'group'` if it says none                                                                              |
| `name` / `description` | what a screen reader says. An unnamed item announces as having none, which is the defect being loud                  |
| `states`               | `selected`, `checked`, `expanded`, `disabled`, `busy`, and `focused` for your own keyboard cursor                    |
| `focusable`            | default true                                                                                                         |
| `props`                | anything else an element carries — `aria-posinset`/`aria-setsize` for Orca's "3 of 7", `aria-level`, `aria-valuenow` |
| `children`             | a scene with structure: series and points, groups and nodes                                                          |

Four things worth knowing before you write one:

**`focused` is the only way your cursor is reported.** The window's focus
manager holds your element, not the thing inside it that arrow keys move —
which is right, and it means the state has to come from you. Reporting it
is all that is asked: navigation between items stays yours.

**Actions fall back rather than fail.** With no `a11ySceneAction`, an
activation is a synthetic click at the item's own rect — you hit-test your
scene already, so the rect is the whole address and an AT's click is
indistinguishable from a mouse user's. `focus` focuses the element,
`scroll` reveals it. Implement the seam for the cases where that is wrong
(an activation that is not a click, a cursor to move, a viewport of your
own to scroll), claim those with `true`, and let the rest fall through.

**An action needs a role that promises one** — `button`, `option`,
`treeitem`, `checkbox` — _or_ your `a11ySceneAction`, which is the same
promise made directly. A `listitem` with neither is read, not clicked, the
same as everywhere else in ARIA.

**`a11yScene()` is called once per question**, so answer from what you
already hold. It is the same rule `a11yTextState()` follows, for the same
reason: a shaping pass or a copy of your model behind it turns a screen
reader walking the tree into a frame budget.

Assertable with no bus and no desktop, through the same spy:
`renderX11(el, { a11y: true })` records an item's states changing exactly as
it records a `<Checkbox>`'s, and `test/a11y-scene.test.js` is a worked graph
pane. The wire itself — children, extents, actions — is covered in
`test/atspi.test.js`.

### The standard edit menu

A `<textinput>` gets a right-click Undo / Cut / Copy / Paste / Select All
menu without being asked. An element that edits or selects text of its own
gets **the same menu** — not one that looks like it — by naming its verbs
and letting core do the rest (issue #256):

```js
import { openEditMenu } from 'react-x11';

class EditorNode extends Node {
  defaultContextMenu(ev) {
    openEditMenu(
      this,
      { x: ev.x, y: ev.y },
      {
        canUndo: this.canUndo,
        undo: () => this.undo(),
        canRedo: this.canRedo,
        redo: () => this.redo(),
        hasSelection: !this.selection.isEmpty(),
        cut: () => this.cut(),
        copy: () => this.copy(),
        paste: () => this.paste(),
        selectAll: () => this.selectAll(),
      },
    );
  }
}
```

What that buys, and the reason it is worth an export rather than a recipe:
the rows and their order, the enablement rules, Paste watching **selection
ownership** instead of asking the server on the way to opening a menu
([elements.md](elements.md#the-right-click-menu)), the arrow keys and
Escape, the pointer grab that dismisses it, and handing the keyboard back to
wherever it came from afterwards. `<textinput>` is a caller of this function,
which is what keeps the two from drifting.

**A verb you leave out is a row that is not there** — not a greyed one. It
was `<textinput sensitive>` that motivated the rule, where a disabled Copy
over a password reads as a bug in the application rather than as a decision,
but it is also exactly what a **read-only** surface needs: a rendered
document that can be selected and copied passes three things and gets a
two-row menu, with no dead Undo, Cut or Paste to explain.

```js
openEditMenu(
  node,
  { x, y },
  {
    hasSelection: selection.hasSelection(),
    copy,
    selectAll,
  },
);
```

Leave out every verb and nothing opens at all.

**Enablement is not yours to decide row by row.** You answer three questions
only the target can answer — `canUndo`, `canRedo`, `canSelectAll` (which
defaults to true: the surface is empty, or all of it is selected already) —
and hand over `hasSelection`. Cut and Copy follow the selection, Paste
follows what the server has said about the clipboard. That is the part a
second implementation would get subtly wrong.

`at` is where the pointer was, in the **owner window's** coordinates — the
`x`/`y` a synthetic event carries. A surface with no caret has nothing else
to offer, and this is what it already has; the menu is placed on the screen
from there, clamped into the monitor it opens on.

Two more functions come with it, both for the element rather than the menu:

| function              |                                                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `editMenuOpen(node)`  | is the menu up? An element that paints a selection asks — the popup holds the keyboard, so the element is not focused, and the selection has to stay lit     |
| `closeEditMenu(node)` | close it. The menu already closes itself on a choice, Escape and a press outside; this is for content that changed underneath it, or a surface that scrolled |

They are exported from the **package root** rather than from
`react-x11/node`, because the caller is not always an element: a component
that wraps one opens the same menu from an `onContextMenu` handler and a ref.

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

The one thing ahead of the walk is the hit node's own `defaultWheel`
([above](#behaviour-of-your-own)) — for an element whose wheel is not a
scroll at all, a pane that zooms about the pointer. Consuming the event there
is what keeps the walk from running; leaving it alone is what puts the
element back in this chain.

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

#### Scrolling the pixels, not just the offset

`scrollBy` moves a number; nobody moves pixels. For a drawing that is cheap
to redraw, that is the end of it — `paintContent` runs again at the new
offset and the frame is correct. For one that is expensive per row and
already lives in a retained buffer — a terminal grid, a log view, a minimap,
a chart that pans — a scroll changes almost nothing: the band that stays
visible is the same pixels, one shift away. A `Surface` can move that band
itself, server-side:

```js
import { Node, Scrollable } from 'react-x11/node';
import { Surface } from 'react-x11/ntk';

class GridNode extends Scrollable(Node) {
  ensureSurface(width, height) {
    if (this.surface?.width === width && this.surface?.height === height)
      return;
    this.surface?.destroy();
    this.surface = new Surface(this.app, { width, height });
    this.drawRows(this.visibleRows()); // a new buffer starts transparent
  }

  scrollBy(by) {
    const from = this.scrollY;
    super.scrollBy(by);
    // ask *after*: the scroller clamped it to the extent you reported
    const dy = from - this.scrollY;
    if (!dy || !this.surface) return;
    const all = {
      x: 0,
      y: 0,
      width: this.surface.width,
      height: this.surface.height,
    };
    if (this.surface.copyWithin(all, 0, dy)) this.drawRows(this.exposedBy(dy));
    else this.drawRows(this.visibleRows());
  }

  paintContent(ctx) {
    const box = this.contentBox();
    ctx.drawImage(this.surface, box.x, box.y);
  }

  destroySubtree() {
    this.surface?.destroy();
    super.destroySubtree();
  }
}
```

`copyWithin(src, dx, dy)` shifts `src` (`{x, y, width, height}`, in surface
coordinates) in place by an integer delta and answers **whether anything
survived** — `false` means repaint the lot, which is the branch a fresh
buffer, a jump to the far end and a resize all take. It is one `CopyArea`
inside the pixmap: nothing crosses the wire but the request, the overlap is
safe, and no exposure events come back.

Two things it lines up with. The deltas you are handed are already whole
pixels — the sub-pixel carry described above exists so that a shift is
always expressible — so an element scrolling this way never has a fraction
to round. And `<box overflow="scroll">` has been doing the window-side half
of this without being asked: a pure scroll of one viewport blits the
surviving band inside ntk's backing pixmap rather than repainting it. This
is that optimisation, for a buffer you retained yourself.

An element that draws its content live rather than into a surface asks for
the window-side half directly, with
[`scrollContents`](#panning-a-scene-you-drew) — the same shift, one layer
out.

### Drawing a scene into one node

_Issue #301._ A frame repaints **rects, not windows**: claims coalesce into
disjoint rectangles, each gets its own clipped pass, and a subtree that lands
outside the pass being painted emits no drawing at all. All of that has one
granularity — the retained node — which is exactly right until your element
_is_ the scene. A graph view, a chart, a timeline, a code editor: the tree
says "one node, 1100×700", so a pass over the 80×40 box a dragged node moved
through redraws all three hundred nodes, all seven hundred edges, the grid
and the minimap into a clip that throws almost all of it away.

Two accessors make such an element a member of the same machinery rather
than the one exception to it. Both are opt-in, and both keep core's answer
when you say nothing.

**Painting: `paintDamage()`.** The rect this pass covers, in the owning
window's coordinates — the same space as `abs` and a mouse event's `x`/`y` —
or `null` when the frame is unbounded and everything has to be drawn. Cull
against it exactly as core culls the tree:

```js
class FlowNode extends Node {
  paintContent(ctx) {
    // null outside a paint and on a full pass, and both mean the same
    // thing: nothing bounds you, draw the lot
    const damage = this.paintDamage();
    for (const cell of this.gridCells()) {
      if (damage && !overlaps(cell, damage)) continue;
      this.drawCell(ctx, cell);
    }
    for (const edge of this.edges) {
      if (damage && !overlaps(edge.routedBounds, damage)) continue;
      this.drawEdge(ctx, edge);
    }
    // …nodes, minimap, controls
  }
}
```

**Committing: `selfDamagedProps`.** `applyProps` damages the whole node when
any non-event prop changes identity, which is right for every element whose
node _is_ what changed and always-everything for a scene pane. A controlled
graph app commits a new `nodes` array per drag step, so each step is one
scoped claim from the gesture plus one full-pane claim from the commit — and
the full-pane claim wins. Name the props whose damage your own `applyProps`
claims and the commit contributes none of its own:

```js
registerElement('flow', {
  create: (props, app) => new FlowNode(props, app),
  semanticNames: ['nodes', 'edges'],
  // "my applyProps diffs these and invalidates what actually moved"
  selfDamagedProps: ['nodes', 'edges'],
});
```

```js
class FlowNode extends Node {
  applyProps(next, prev) {
    const before = prev ?? this.props;
    super.applyProps(next, prev); // claims nothing for `nodes`
    if (next.nodes !== before.nodes) {
      // …so this is the only claim, and it is the box that moved
      this.invalidate(
        false,
        this.movedBounds(next.nodes, before.nodes),
        'props',
      );
    }
  }
}
```

When the answer depends on the _values_ rather than the names, override
**`paintChanged(next, prev)`** instead — it is what the list feeds, so the
two are the same seam:

```js
paintChanged(next, prev) {
  if (next.nodes !== prev.nodes && onlyPositionsMoved(next.nodes, prev.nodes)) {
    return false; // folded in place above, and the moved box is claimed
  }
  return super.paintChanged(next, prev);
}
```

Three things about that contract, in the order they bite:

**Everything you do not recognise goes to `super`.** An element that answers
"nothing changed" about a prop it does not actually claim shows a stale
pixel, and nothing comes back to fix it — so the override answers for the
props it knows and hands the rest to core, which is conservative on purpose.
That is what keeps an `aria-label`, a `title`, or a prop the element grows
next year correct without anybody remembering this method exists.

**A style change is not yours to excuse.** `style` is compared by value by
the caller and never reaches either seam: what it moves is the background,
the border and the clip that `Node.paint` draws for you.

**Claim before you skip.** `selfDamagedProps` only says the commit will not
claim — it does not claim anything on your behalf. An element that names a
prop and then forgets to invalidate for it renders nothing at all on that
change, which at least fails loudly the first time you drag something.

And one place `paintDamage()` does not belong: inside `paintCached`
([below](#drawing-once-instead-of-every-frame)). That draws into a surface in
its own coordinates, and a copy culled against the window's damage is stored
half-drawn under a key that says it is whole — so every later frame that hits
the key gets the hole.

The same scene has a second one-node problem, in the accessible tree rather
than in the frame: see [A scene a screen reader can
walk](#a-scene-a-screen-reader-can-walk).

Worth it because the numbers are not small. `@react-x11/components`' `<Flow>`
on a 300-node / 745-edge scene at 1100×700 costs ~2470 X requests and ~150 ms
per drag step redrawing the pane, and ~400 requests / ~30 ms with the two
seams — the same frame, with the parts of it nobody can see left unsent.
`REACT_X11_DEBUG_PAINT=1` is how to watch it: the pass's rect is stroked in
the frame's colour, so a scene that is still repainting whole strobes across
the pane instead of outlining what moved ([debugging.md](debugging.md)).

#### Panning a scene you drew

_Issue #303._ The two seams above scope a frame to the part of the scene
that changed. A **pan** has no such part: it translates every pixel, so the
honest claim is the whole pane and the honest frame is a full repaint — of a
picture that is already on screen, one shift away from being right.

That is the shape `<box overflow="scroll">` has been treating as a special
case since issue #138: blit the band that survives inside ntk's backing
store, repaint only the strip the shift exposed. `scrollContents` is that
same dance, for a viewport of your own:

```js
class FlowNode extends Node {
  onDragPan(dx, dy) {
    this.panX += dx;
    this.panY += dy;
    // "the pixels in here moved by (dx, dy); the rest of it is new"
    this.scrollContents(this.contentBox(), dx, dy);
  }

  paintContent(ctx) {
    // …and this is the exposed strip, not the pane. Nothing here changes.
    const damage = this.paintDamage();
    for (const item of this.scene()) {
      if (damage && !overlaps(item.bounds, damage)) continue;
      this.draw(ctx, item);
    }
  }
}
```

The call claims `rect` — the conservative answer, and the one that stands if
anything declines — and arms the frame to blit instead. At frame time core
asks ntk to move the surviving band and **narrows that claim to the band the
shift exposed**, which is what `paintDamage()` then hands your paint. So the
element draws the strip and nothing else without ever asking whether the
blit happened, and every gate below falls back to repainting `rect`, which is
the behaviour without the call at all.

Four things worth knowing, in the order they bite:

**`dx`/`dy` are how far the pixels moved.** The sense `Surface.copyWithin`
and ntk's `scrollRegion` use, not a scroll offset's: panning the scene right
by ten is `dx: 10`, and the exposed band is down the left edge. Both whole
pixels — a fractional shift is not a copy — and `rect` in window coordinates
(the same space as `abs`, `contentBox()` and an event's `x`/`y`) and inside
your node.

**You promise one thing: that inside `rect` the frame really is that
translation.** Everything else is core's to check, and each of them declines
rather than misrenders — a claim from anywhere else reaching into the rect, a
sibling drawing over it, a child of your node laid out on top of it, your own
border ring or rounded corner, a layout pass that moved something, a region
too small or a shift too large to be worth it. Several pans in one frame
coalesce into one blit by their net shift; two different regions of one node
do not, and fall back.

**Diagonal is fine here**, unlike the scroll containers' one-axis-at-a-time
rule. That rule exists because the L of exposed strips overlaps the scrollbar
rects and the merges balloon back towards the whole viewport; with no bars
the L is two disjoint rects and stays two. A drag-pan is diagonal almost
every frame, so this is the case rather than the corner.

**Every gate above is about `rect`, not about your node.** A pane usually
has furniture pinned to a corner — a minimap, zoom controls, a HUD strip —
that has to repaint on a pan frame and whose pixels must _not_ ride the blit.
Carve it out of the region you shift and claim it the ordinary way; the claim
lands beside the rect and the frame stays a blit:

```js
onDragPan(dx, dy) {
  this.panX += dx;
  this.panY += dy;
  const box = this.contentBox();
  const hud = { ...box, y: box.y + box.height - HUD, height: HUD };
  this.scrollContents({ ...box, height: box.height - HUD }, dx, dy);
  this.invalidate(false, hud, 'props'); // repainted, not shifted
}
```

A claim that _reaches into_ the rect — by so much as a pixel — still declines
the frame, and that is the whole of the rule (issue #309). Overlay panels
mounted as sibling nodes work the same way, as long as they sit outside the
rect: one drawing over it is dragged along by the blit, so it declines
instead.

**Zoom is not a blit.** Scaling resamples; it is a full repaint and should
be. That is the right trade: a zoom is a gesture step, a pan is sixty of them
a second.

The protocol bench prices it at five diagonal pan steps over a 374-cell scene
— 983 requests / 606 composites / 0.30 Mpx, against 9845 / 6533 / 4.22 for
the same five steps under `REACT_X11_NO_SCROLL_BLIT=1`, which is exactly the
fallback every gate here takes. The same five steps with a HUD strip claimed
beside the region cost 3059 / 1971 / 1.10 — the blit plus the strip, where
the whole pane repainting is that 9845 again.

If your element keeps its drawing in a `Surface` of its own rather than
drawing it live, the shift you want is
[`copyWithin`](#scrolling-the-pixels-not-just-the-offset) on that surface —
same idea, one layer in.

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
| `react-x11/yoga`    | the layout engine — `Yoga`, `loadLayout`, `layoutLoaded`. Rarely needed; see below                       |
| `react-x11/ntk`     | ntk itself, re-exported — `Surface`, `Path2D`, `Image`, `Pixmap`, the font sources, `createClient`       |
| `react-x11/keysyms` | the `XK_*` constants, `keysymOf`, `charOf`, `MOD`, `ctrlChordLetter`                                     |

**Reach ntk through `react-x11/ntk`, not a second dependency.** Two copies
of ntk in one process means two font caches and two glyph atlases, and a
node built against one cannot be painted by the other — a failure that
looks like a drawing bug rather than a dependency bug.

**An element does not need the layout engine, and that is deliberate.**
`measureContent` is handed its constraints in words (`'exactly'`,
`'at-most'`, `'unconstrained'`) rather than yoga's integers, so an element
never links against it and yoga's ABI never becomes part of this seam. If you
are writing an element and reaching for `react-x11/yoga`, the answer is
almost certainly `measureContent`.

`react-x11/yoga` is for the case that is genuinely different: a package
implementing a **layout algorithm of its own** that wants to delegate part of
it. `@react-x11/components`'s `<Html>` is the worked example — its
`display: flex` builds a small yoga tree, asks it, and reads the answer back
rather than re-deriving flexbox, which is long, subtle, and silently wrong
when it is wrong.

Such a package must use **this** engine rather than its own `yoga-layout`
dependency, for the same reason it must reach ntk through `react-x11/ntk`:
two instances are two WebAssembly modules, and a node created by one cannot
be inserted into a tree owned by the other. That failure surfaces as a crash
inside the engine, naming nothing you wrote.

```ts
import { Yoga, loadLayout } from 'react-x11/yoga';

await loadLayout(); // createRoot() has already done this inside an app
const root = Yoga.Node.create();
root.setFlexDirection(Yoga.FLEX_DIRECTION_ROW);
```

The enum constants are readable from the first tick; `Node` and `Config`
throw until the assembly is loaded, which `createRoot()` awaits before it
builds anything (docs/packaging.md explains why it is loaded rather than
imported).

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

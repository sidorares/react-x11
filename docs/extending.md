# Extending the element vocabulary

`<box>`, `<text>`, `<glarea>` and the rest are built in; `registerElement()`
adds more from outside the package — a `<sparkline>`, a tray icon, an XEMBED
`<foreign>` — so a sibling package can ship one without forking react-x11.

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

Register before you render: the registry is consulted when an element is
first created, so a late registration only affects trees mounted after it.

Design notes (history, measurements, how core serves each hook):
[design/extending.md](../design/extending.md).

## The definition

| field                         |                                                                                                      |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| `create(props, app, hostCtx)` | builds and returns the `Node`; `app` is the ntk connection                                           |
| `drawn`                       | default `true`: laid out by yoga, painted into the window. `false`: it owns a child X window (below) |
| `semanticNames`               | prop names this element owns even though they are also style names                                   |
| `selfDamagedProps`            | props whose damage your own `applyProps` claims ([Drawing a scene](#drawing-a-scene-into-one-node))  |
| `childrenAllowed`             | default `true`; `false` rejects children by name rather than laying out what never paints            |
| `override`                    | replace an existing registration. Off by default: two packages claiming one name is a conflict       |

**`drawn` decides whether your element paints at all.** A kind outside the
set of drawn kinds lays out, reports a sensible `abs`, and never appears on
screen, with no error. `registerElement` adds you unless you opt out.

**`semanticNames` keeps development and production alike.** In development
react-x11 throws on `<box width={10} />`, a style property written flat. An
element whose own props overlap the style vocabulary (`width`, `color`,
`fontSize`) must list them, or it throws on its own props in development
only. `<window width>` is the built-in precedent: the X window's width,
never style. `isStyleProp(name)` from `react-x11/style` says whether a name
needs declaring.

## Registering under hot reload {#hot-reload}

Register at module scope (tree-shaking requires it of a component library).
That scope re-runs when
[`react-x11/refresh`](ecosystem/dev-tooling.md#react-refresh) hot-reloads the
module, so:

- **The same `create` reference is never a conflict**: it replaces
  silently, latest flags winning.
- **During a hot-reload session, any duplicate replaces silently.** The
  session starts at the first hot re-import and lasts for the process.
  Mounted nodes keep the old prototype until they remount (Fast Refresh's
  contract for classes); new mounts get the new definition.
- **Outside a session, a duplicate throws**; `override: true` says a
  replacement is deliberate.

In a hot module, call it through a namespace or default import
(`Host.registerElement(...)`): a _named_ import called at module top level
is a transform error there, because named-import bindings initialize a
microtask after a reload.

## The node contract

`Node` implements the whole reconciler-facing surface; an element that only
draws needs a constructor and a `paint`. What you may override:

| method                         | when                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------- |
| `paint(ctx)`                   | draw. Call `super.paint(ctx)` first (background, border, clip), then draw inside `this.abs` |
| `paintContent(ctx)`            | draw _between_ background and children — where built-ins draw; what a scroller needs        |
| `opaqueRect()`                 | the rect you cover opaquely every paint, so a pass inside skips the fills under it          |
| `viewportFixedRects()`         | what you draw fixed to your scroll pane's viewport, so its blit repaints it                 |
| `paintOverhang()`              | how far you draw past your box, so claims and culls cover it                                |
| `applyProps(next, prev)`       | props changed. Call `super`; invalidate anything you derived                                |
| `paintChanged(next, prev)`     | did anything you draw change? Only if you claim your own damage                             |
| `measureContent(constraints)`  | your content has a size of its own. Leaves only: no children                                |
| `default*(ev)`                 | your behaviour for a key, a press or focus — what makes it _interactive_                    |
| `hitTest(x, y)`                | non-rectangular hit areas. The default walks children in reverse paint order                |
| `insertBefore` / `removeChild` | only if children mean something structural to you                                           |
| `destroySubtree()`             | release what you allocated (pixmaps, fonts, timers). Call `super`                           |

What you read:

- `this.props` — the current props, replaced wholesale on update.
- `this.style` — the flattened `style` with the active `:hover` / `:focus` /
  `:active` / `:disabled` blocks overlaid and `$token`s resolved against the
  theme. **Everything that paints or lays out reads this, never `props`.**
- `this.abs` — position and size within the owning window, after layout.
- `this.contentBox()` — `abs` inset by border and padding: where the content
  goes, and where every built-in draws.
- `this.scale` — device pixels per logical pixel ([scale.md](scale.md)),
  per node (an enclosing `scale` prop zooms a subtree —
  [scale.md](scale.md#a-subtree-of-its-own)), so read it off the node.
  `style`, `abs`, `contentBox()`, the paint context and every rect you hand
  `invalidate`, `scrollContents` or a screen reader are device pixels; a
  synthetic event's `x`/`y` are logical, so hit-test `abs` with
  `ev.nativeEvent.x`/`y`, or multiply. They coincide at 1x, so test with
  `renderX11(element, { scale: 2 })`.
- `this.resolvedTextStyle()` — this node's text style, ready for
  `app.fonts.layout` (below).
- `this.resolveColor(value)` — a style colour as a context can paint it: the
  value, or the node's ink for [`currentColor`](styling.md#currentcolor).
  Pass every colour you read off `this.style` through it
  (`ctx.strokeStyle = this.resolveColor(this.style.borderColor)`), or the
  keyword paints nothing. A node whose style paints in `currentColor`
  repaints when its ink moves.
- `this.direction` — `'ltr'` or `'rtl'`, never `'inherit'`. Yoga has already
  mirrored the boxes; this is for what you draw inside one — which side a
  mark sits on, which way a chevron points, what a pointer coordinate means
  ([styling.md](styling.md#direction-and-the-logical-edges)).
- `this.root` — the owning `<window>` node; `this.app` — the ntk connection.
- `this.theme` — the nearest theme at or above this node.
- `this.paintDamage()` — the rect the current pass covers, or `null` for a
  full one ([below](#drawing-a-scene-into-one-node)).

`this.invalidate(layout, damage, reason)` asks for a repaint. Pass the damage
— `this`, or a tighter rect: an unbounded one repaints the whole window, the
main performance bug class here ([debugging.md](debugging.md)). `reason` is
from the closed set the diagnostics print. On a node not yet attached it
does nothing.

`this.focus()` takes the keyboard focus as a click would and returns the
node; `this.blur()` gives it up; `this.focused` and `this.focusWithin` say
where it is. A focus change repaints the control and its ring by itself.

### Text of your own

An element that draws text — a badge, a code editor, a terminal — shapes it
through ntk's font manager with the two accessors above:

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

**Use `contentBox()`, not `abs` minus `style.padding`.** Its insets come from
layout, with `padding: '10%'`, per-side overrides and border widths
resolved; a box derived from the style bag matches `<text>`'s only by luck.

**Use `resolvedTextStyle()`, not `this.style.fontFamily`.** It layers the
node's own font properties over what it inherits from the elements around
it and the palette's default, in the shape `fonts.layout` wants (`family`,
not `fontFamily`; `variations`, not `fontVariationSettings`; `features`,
what `fontVariantNumeric` and `fontFeatureSettings` resolve to). Read the
style bag instead and a `<ThemeProvider>` font or an enclosing box's
`color` never reaches your element; ask, and it inherits what a `<text>`
sibling does, a row's `:hover` included
([styling.md](styling.md#inheritance-the-ink-the-face-and-the-size)).

Read both at paint time: `contentBox()` is computed per call;
`resolvedTextStyle()` is memoised and dropped by whatever can move it (a
style or state change, an animation tick, a theme swap, an ancestor's type
changing). If the text also sizes the element, shape it in `measureContent`
too. A cache of your own keyed on the type — a shaped run, a rasterized
label — is dropped in **`_textStyleMoved(cost)`**: `2` when a glyph can
have moved, `1` when only the ink or glyph rounding did. The default
re-measures on `2` and repaints on `1`.

**Text as pixels.** A GL surface's labels or a signed distance field need
glyph coverage, not a drawn surface. A layout's **`coverage({ pad })`**
answers synchronously: one byte per device pixel, the layout box in whole
pixels with `pad` round it, origin at `(pad, pad)` — linear, grayscale,
unhinted, as a raster that will be scaled wants.

```js
const coverage = layout.coverage?.({ pad: 4 }) ?? null;
if (!coverage) {
  // no answer on this engine: draw onto a Surface and read it back
}
```

It is optional — ntk's layout (X11, Wayland, the mock), DirectWrite's and
CoreText's answer it from the release that added it — so feature-detect and
keep a readback. It is not `draw` pixel for pixel: `draw` snaps and hints.

### Answering for your own text

A `selectable` ancestor lets the user select the text of any descendant
that answers four questions; there is no registration.

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

- **Indices are code points** (ntk's `TextLayout.caretPosition`/`indexAt`:
  an emoji is one position). **Rects are the owning window's device
  pixels**, like `abs`; a mouse event's `x`/`y` are the same in logical
  pixels ([scale.md](scale.md)).
- **Answer from what you draw**: one layout and origin for painting and all
  four accessors. If the element scrolls, the origin includes the offset.
- **One band per line, and per direction run.** A selection is contiguous
  in logical order, a line laid out in visual order, so a Latin-to-Arabic
  range covers disjoint stretches: walk ntk's `line.runs` and intersect each
  with the range.
- **An element that edits owns its selection**: `hasOwnSelection = true` in
  the constructor, and a `selectable` document skips its subtree and its
  presses.
- **Presses arrive through the base class.** `Node`'s `defaultMouseDown`,
  `defaultMouseDrag`, `defaultMouseUp` and `defaultKeyDown` hand the
  gesture to the nearest `selectable` ancestor. Override one without
  `super` and you take the gesture (right for an editor); to keep both, end
  with `super.defaultMouseDown(ev)`.

What a copy assembles, the separators, the keys:
[elements.md](elements.md#selecting-text).

### A size of your own

An element as big as its content — a gauge, a chart, a terminal, an editor
— implements **`measureContent`**, asked whenever the size on an axis is the
element's to give:

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

`<gauge ticks={6} />` is then 180×24 with no style saying so. It must be a
**method on the class**: the base constructor wires it to layout, so one
assigned in your constructor is never asked (`invalidateMeasure()` says so
in development).

#### What it is asked

`{ width, height, widthMode, heightMode }`, an unbounded axis as `Infinity`,
so `Math.min(preferred, width)` is right in every mode; the mode is for when
it is not:

| asked with       | the element answers                                                                    |
| ---------------- | -------------------------------------------------------------------------------------- |
| `unconstrained`  | its natural size (`<textarea>`: its preferred width, `rows` tall)                      |
| `at-most`        | its natural size, clamped into the offer                                               |
| `at-most` with 0 | **the smallest it can be drawn at** — an editor: a character or two; a scroller: small |
| `exactly`        | the style decided; hand the number back and answer for the other axis                  |

The renderer asks `at-most 0` itself, laying the tree out with no room to
find each leaf's floor: a row too narrow squeezes the element that far and
no further ([elements.md](elements.md#everything-shrinks-nothing-shrinks-to-nothing)),
and at the top of the tree it is what `<window minWidth="auto">` sends the
window manager. Answer 0 and both floors are lost.

`at-most` is available room, not a cap: answer larger and the element is
laid out at that and overflows, as `<text textWrap="nowrap">` does — right
for content that does not reflow.

#### What it must not do

It is a question about a hypothetical, asked several times per layout at
sizes nothing will be drawn at:

- **do not read `this.abs`** — it is last frame's;
- **do not paint, invalidate, or set state** — cache expensive work (as
  `<text>` memoizes its layout per width), but answer as a pure function of
  content and constraints;
- **answer finite numbers** — `{ width: 0, height: 0 }` for content not yet
  arrived; anything else throws naming the element.

An element that measures itself **cannot have children**; rendering one
inside it is an error naming both.

#### Saying the answer moved

Layout caches the measurement. Call `invalidateMeasure(reason?)` when an
input it reads changes — a prop, arriving data, a loaded font — and the next
frame asks again; nothing else knows your inputs. `reason` is from the
diagnostics' closed set ([debugging.md](debugging.md#invalidation-reasons)),
default `'measure'`.

#### Content with an aspect ratio

`intrinsicSize` is the `<image>`/`<svg>` measurement, a natural size whose
proportions are kept:

```js
import { Node, intrinsicSize } from 'react-x11/node';

class ThumbNode extends Node {
  measureContent(constraints) {
    return intrinsicSize(this.decoded ?? { width: 0, height: 0 }, constraints);
  }
}
```

It shrinks to the width on offer, the height following, and scales the
width from a style height when only that is fixed, as `<img>` does.

### Behaviour of your own

An element that does something — an editor, a terminal, a table with cell
editing, a tree with type-ahead — implements **default actions**, the seam
`<textinput>` runs on. Order:

1. the app's `onKeyDown` / `onMouseDown` / … handlers, capture then bubble;
2. **unless one called `ev.preventDefault()`**, the element's `default*`
   method.

So an app can veto or precede the behaviour without knowing how the element
is built — the reason to put it here rather than in a wrapping component.

| method                   | when                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------ |
| `defaultKeyDown(ev)`     | a key, at the focused node. `ev.keysym`: the Latin `XK_*`, any layout; `codepoint >= 0x20`: text |
| `defaultKeyUp(ev)`       | the key was released. Rare: for answering the whole keystroke, as `<foreign>` does               |
| `defaultComposition(ev)` | a dead key or Compose in progress: `ev.type` the phase, `ev.data` what to show or insert         |
| `defaultMouseDown(ev)`   | a press: place a caret, grab a handle; `ev.capturePointer()` keeps the gesture                   |
| `defaultMouseDrag(ev)`   | motion while _this_ element holds the press, even outside its box                                |
| `defaultMouseUp(ev)`     | that press was released                                                                          |
| `defaultMouseMove(ev)`   | pointer motion over it, no button down. The first is the enter                                   |
| `defaultMouseLeave(ev)`  | the pointer left: unlight it                                                                     |
| `defaultWheel(ev)`       | the wheel, before the scroll chain, for a wheel that is not a scroll                             |
| `defaultContextMenu(ev)` | right-click, after the press (preventing it keeps the caret): open your menu                     |
| `defaultFocus(info)`     | it, or its window, got focus. `info`: `{ reason, backwards }`; `'key'` + direction is Tab        |
| `defaultBlur()`          | focus left, or the window lost it: stop the caret                                                |

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

- **A gesture is vetoed once, at its press**: a prevented press means no
  `defaultMouseDown`, `defaultMouseDrag` or `defaultMouseUp`.
- **Hover is motion.** `defaultMouseMove` runs for the element under the
  pointer, coalesced to once per frame, and `defaultMouseLeave` when it
  goes; the first motion is the enter (there is no `defaultMouseEnter`).
  A capture freezes hover and sends motion to `defaultMouseDrag`. A node
  unmounted while hovered is forgotten, not left: release in
  `destroySubtree` what the highlight holds.
- **The cursor is the point's.** `defaultCursor` covers the element;
  `cursorAt(x, y)`, asked on every motion in device pixels like `abs`,
  answers one per part (a link, a handle, text), or null to fall through to
  `defaultCursor`, then the parent. A `cursor` style still wins; a capture
  freezes it.

```js
cursorAt(x, y) {
  return this.linkAt(x - this.abs.x, y - this.abs.y) ? 'pointer' : 'text';
}
```

- **A wheel that is not a scroll** — a zoom about the pointer — needs the
  point (`ev.x`/`ev.y`) and the modifier, not just the deltas
  `canScroll`/`scrollBy` get ([below](#scrolling-content-you-painted)).
  `defaultWheel(ev)` gets the whole event at the node under the pointer
  before the scroll chain walks; `ev.preventDefault()` stops the walk. Its
  deltas keep their fractions.

```js
defaultWheel(ev) {
  if (!ev.ctrlKey) return;             // an unmodified wheel still scrolls
  this.zoomAbout(ev.x, ev.y, Math.exp(-ev.deltaY / 400));
  ev.preventDefault();                 // …and this one was mine
}
```

- **Focus is a prerequisite.** Keys go to the focused node, and only an
  element with `focusableByDefault = true` is focused (a tab stop and press
  target, like `<textinput>`); the app's `focusable={false}` or `tabIndex`
  still overrides it ([events.md](events.md#focus)).
- **Tab is an ordinary key**: it reaches `defaultKeyDown` before focus
  traversal, and `ev.preventDefault()` there keeps focus where it is.
- **`super.defaultKeyDown(ev)`** is the text-selection keys, and Space/Enter
  dispatching `onClick` ([events.md](events.md#space-and-enter-are-a-click)).
  An editor that answers every key (Space types a space) skips it, as
  `<textinput>` does; one answering a few keys ends with
  `return super.defaultKeyDown(ev)`, as the scroll pane does.
- **An element that eats Tab owes a way out.** The convention, shown above:
  **Escape arms one pass-through Tab** — the next Tab leaves, the one after
  indents again — so no keyboard or screen-reader user is trapped.
- **An element that types text implements `defaultComposition`.** Dead keys
  and Compose sequences never reach `defaultKeyDown`, so without it `é`
  types as `e` ([events.md](events.md#composition)). Only the last phase
  inserts:

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

The preedit is not part of your value: it never reaches `onChange` or the
undo history, a controlled value rewritten mid-composition cannot corrupt
it, and abandoning it (Escape, blur) drops a string, not an edit. An
element holding no text can leave composition out; one that **forwards keys
to another program** (`<foreign>`) sets `composes = false` so the dead key
reaches the client's input method.

**A caret blinks at `CARET_BLINK_MS`**, `<textinput>`'s cadence, so carets
blink in step. Stop the timer in `defaultBlur` _and_ `destroySubtree`: a
node unmounted while focused is never blurred.

### Text a screen reader can read

To an assistive technology, an element that draws its own text is a
rectangle with no characters, caret or selection. `a11yTextState()` gives it
what `<textinput>` has, through the same code: AT-SPI's `Text` (characters,
words, lines, caret, selection, and the `text-changed` / `text-caret-moved`
/ `text-selection-changed` events Orca narrates) and, for an editor,
`EditableText`.

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

| member                              | when                                                                               |
| ----------------------------------- | ---------------------------------------------------------------------------------- |
| `a11yTextState()`                   | always, for an element holding text; `null` if none                                |
| `notifyA11yTextChanged()`           | every edit, caret move, selection or composition change; state is then _pulled_    |
| `a11ySetSelection(start, end)`      | an AT moved the caret (to `end`) or selected. Without it: read, not navigated      |
| `a11yReplaceText(start, end, text)` | an AT inserted, deleted or set the lot. Without it: read, not typed in             |
| `a11yRole`                          | the ARIA role if the app sets none (`'textbox'`, `'log'`…); set in the constructor |

- **Viewer or editor.** A viewer (a document, a code block, a log, a
  terminal) reports `value` and a selection: it gets `Text`, a `document`
  role, and a selection an AT can read and set. An editor adds
  `editable: true` and `a11yReplaceText` for the EDITABLE state and
  `EditableText`; `editable` without `a11yReplaceText` is announced as
  editable but not exposed as typeable.
- **Offsets are code points into what you draw** (`Array.from(value)`), an
  open composition included, since extents and magnifiers follow the
  glyphs. Mark it with `preedit: { offset, text }` and its churn is reported
  as text the user did not type
  ([accessibility.md](accessibility.md#while-a-composition-is-open)).
  Offsets you report are clamped.
- **`notifyA11yTextChanged()` is free when nobody listens**: call it on
  every path that moves the text.
- **`a11yTextState()` runs several times per change**: answer from held
  state; never shape, copy a buffer, or invalidate.
- **Say `multiline`**, or neither state is claimed (a guess from the value
  would flip the first time someone pressed Enter).

`renderX11(el, { a11y: true })` returns a spy recording the same feed
([accessibility.md](accessibility.md#asserting-what-a-screen-reader-would-hear)).

### A scene a screen reader can walk

An element that draws many interactive things is one node, so one
accessible: a graph pane reads as **"Flow graph, group"**, nothing in it
findable or actionable, whatever `role`/`aria-*` it carries. Describe them:

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

Each item becomes a real child accessible — named, placed, focusable,
`selected` announced — read as `<box role="listitem" aria-selected>` would
be. `id` keeps a child the same child across frames, so a screen reader's
references survive a scene rebuilt every frame.

| member                        | when                                                                                                 |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| `a11yScene()`                 | for an element drawing interactive things. Called per question: keep it cheap                        |
| `notifyA11ySceneChanged()`    | the scene moved between commits (a drag, an animation, your arrow keys); a commit re-reads it itself |
| `a11ySceneAction(id, action)` | an AT acted on one. Return `true` to claim it, else core answers                                     |

What one item may say:

| field                  |                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| `id`                   | required. Its name while it is drawn, matched within its parent                             |
| `rect`                 | required. Window coordinates: where AT focus is drawn, what a magnifier follows             |
| `role`                 | an ARIA role; `'group'` if none                                                             |
| `name` / `description` | what a screen reader says; an unnamed item announces as having none                         |
| `states`               | `selected`, `checked`, `expanded`, `disabled`, `busy`; `focused` for your keyboard cursor   |
| `focusable`            | default true                                                                                |
| `props`                | other ARIA: `aria-posinset`/`aria-setsize` (Orca's "3 of 7"), `aria-level`, `aria-valuenow` |
| `children`             | structure: series and points, groups and nodes                                              |

- **`focused` is the only way your cursor is reported**: the focus manager
  holds your element, not the item your arrow keys move. Navigation stays
  yours.
- **Actions fall back.** Without `a11ySceneAction`, an activation is a
  synthetic click at the item's `rect`, as a mouse user's would be; `focus`
  focuses the element; `scroll` reveals the item. Claim with `true` only
  what differs — a non-click activation, a cursor move, your own viewport.
- **An action needs a role that promises one** (`button`, `option`,
  `treeitem`, `checkbox`) or your `a11ySceneAction`; a bare `listitem` is
  read, not clicked.

The same spy records an item's states changing as it does a `<Checkbox>`'s.

### The standard edit menu

An element that edits or selects text of its own gets `<textinput>`'s
right-click Undo / Cut / Copy / Paste / Select All menu — the same one — by
naming its verbs:

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

Core supplies the rows and order, enablement, Paste following **selection
ownership** rather than asking the server
([elements.md](elements.md#the-right-click-menu)), the keys, the dismissing
grab, and handing the keyboard back.

**A verb you leave out is a row that is not there**, not a greyed one. A
read-only surface passes three things for a two-row menu; no verbs, no
menu:

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

**Enablement is core's.** Answer `canUndo`, `canRedo` and `canSelectAll`
(default true; false when empty or all selected) and hand over
`hasSelection`; Cut and Copy follow the selection, Paste what the server
said about the clipboard. `at` is the pointer in the **owner window's**
coordinates (a synthetic event's `x`/`y`); the menu is clamped into its
monitor.

| function              |                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `editMenuOpen(node)`  | is it up? (it holds the keyboard; keep your selection lit)                                                         |
| `closeEditMenu(node)` | close it if content changed under it or your surface scrolled (a choice, Escape, a press outside close it already) |

All three come from the **package root**, so a component wrapping an
element can open the menu from `onContextMenu` and a ref.

### Scrolling content you painted

`<box overflow="scroll">` scrolls children. An editor, a terminal or a
canvas-backed table scrolls pixels it draws, and joins the same machinery
with:

| method                   |                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------- |
| `canScroll(dx, dy)`      | is there room on the axis this delta names? The wheel asks first                  |
| `scrollBy(by)`           | `scrollBy(dy)` or `scrollBy({x, y})`: move by that much                           |
| `measureScrollContent()` | `Scrollable` only: `{ width, height }` the content reaches. Default: the children |

**The wheel's default action is the first two.** It walks out from the hit
node asking `canScroll(deltaX, deltaY)`; the first yes gets `scrollBy`, up
to the `<window>`. Say no when there is nothing to move and the wheel
chains to what is behind you, as in a browser (`<textarea>` does). Answer
from the **extent, not the position**: a viewport at its bottom keeps the
rest of a flick. The hit node's `defaultWheel`
([above](#behaviour-of-your-own)) runs before the walk.

Deltas are **whole pixels**: a touchpad's fractions stay on `ev.deltaY`
([events.md](events.md#wheel)), and the default action carries them to the
next event, so a scroll can always be a blit and a slow one still moves.

#### The mixin, for everything else

`Scrollable(Node)` adds the offsets, `scrollTo`/`scrollBy`/`scrollIntoView`,
drawn scrollbars and their drags, the scroll keys (arrows, Page, Home/End,
Space), the tab stop and the AT-SPI scroll-pane role, all reading one
number pair:

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

- **Draw in `paintContent`, not `paint`.** `paint` draws background,
  `paintContent`, children, border and last a `Scrollable`'s scrollbars;
  drawing after `super.paint(ctx)` covers your own thumb.
- **Offset and clip yourself**: clip to `contentBox()` and subtract
  `scrollX`/`scrollY`, already clamped to your extent. `scrollX` counts from
  the edge the content starts at — the right one under `direction: 'rtl'`
  ([styling.md](styling.md#direction-and-the-logical-edges)) — as does your
  reported `width`, so drawing in your own direction needs no branch.
- **Do not assign `focusableByDefault`**: `Scrollable` answers it (a tab stop
  when there is somewhere to go) and assigning throws. Override the getter.
- **`measureScrollContent` runs at most once per layout pass**, and is
  reused when nothing inside was laid out again (a pure scroll). It may read
  layout geometry; it must not paint or invalidate, and must return finite
  numbers or it throws, naming the element.
- **When your extent changes** (a typed line, arriving rows), call
  `this.invalidate(true, this, 'scroll')`, or scrolling keeps the stale one.

#### Scrolling the pixels, not just the offset

`scrollBy` moves a number; `paintContent` redraws at the new offset. A
drawing that is expensive and kept in a retained buffer — a terminal grid, a
log, a minimap, a panning chart — can shift its surviving band inside a
`Surface` instead:

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

`copyWithin(src, dx, dy)` shifts `src` (`{x, y, width, height}`, surface
coordinates) in place by whole pixels, overlap-safe, and returns **whether
anything survived**; `false` (a fresh buffer, a far jump, a resize) means
repaint the lot.

`Surface` from `react-x11/ntk` is the backend's own — ntk's pixmap on X11,
a CG bitmap on Cocoa, a GL render target on Wayland, a Direct2D bitmap on
win32 — so the element runs unchanged; on win32 `copyWithin` returns
`false` for now. Where a surface has one graphics state (a bitmap, a render
target), `getContext('2d')` returns the same context each time and its
`destroy()` is a no-op.

**Hold one context**, taken once with `getContext('2d')`: on every backend,
shared GL devices included, its draws land in its own surface even
mid-paint.

```js
drawRows(rows) {
  const ctx = (this.ctx ??= this.surface.getContext('2d'));
  for (const row of rows) this.paintRow(ctx, row);
}
```

`surface.render(fn)` is the scoped alternative for a whole-surface repaint:
a clean transform and clip, flushed when `fn` returns. It is the same
context, so it resets a held context's transform.

**An opaque surface composites with `copy`**, skipping the blend:

```js
paintContent(ctx) {
  const box = this.contentBox();
  ctx.globalCompositeOperation = 'copy';
  ctx.drawImage(this.surface, box.x, box.y);
  ctx.globalCompositeOperation = 'source-over';
}
```

Set it back (or `save`/`restore`): it is state on the window's context. Use
it only where every pixel is opaque. A backend that cannot draw it refuses
the assignment; read it back to know.

`<box overflow="scroll">` blits its own viewport on a pure scroll; an
element that draws live asks for that with
[`scrollContents`](#panning-a-scene-you-drew).

#### Drawing what stays put while the pane scrolls

The scroll blit copies a pane's whole viewport. An element that paints part
of itself against that viewport — a fixed background, a `position: fixed`
header in a document it draws — names it in `viewportFixedRects()` (window
coordinates, device pixels; default `null`), and a blitting scroll
repaints those rects where they are and where the copy dragged them:

```js
class DocumentNode extends Node {
  _viewport() {
    // the nearest scroll pane: the one whose scroll the answer is about
    let pane = this.parent;
    while (pane && !pane.isWindow && !pane.isScroller()) pane = pane.parent;
    return pane && !pane.isWindow ? pane.contentBox() : null;
  }

  viewportFixedRects() {
    const viewport = this._viewport();
    return viewport && [{ ...viewport, height: HEADER }];
  }

  paintContent(ctx) {
    // …the document, at `this.abs`, and the header over it where the
    // viewport is, from the same geometry the answer came from
  }
}
```

Rects covering most of the viewport make the scroll a repaint. Only the
nearest scroll pane asks (an outer pane moves the inner one with what is
fixed to it), after layout, on each scroll it blits.

#### Keeping what the viewport shows while your content moves

Laid out at a new width, a document rewraps above the fold and the
paragraph at the top of the viewport moves. `anchorScrollBy(dx, dy)` keeps
it on screen, as CSS Scroll Anchoring does: your content moved (dx, dy)
device pixels in this layout pass, and the nearest scroll pane shifts its
offsets by as much before placing it, in the same frame.

```js
class DocumentNode extends Node {
  measureContent({ width }) {
    // what is at the top of the viewport, before and after
    const anchor = this._blockAtViewportTop();
    const was = anchor?.top;
    this._layOut(width);
    if (anchor) this.anchorScrollBy(0, anchor.top - was);
    return { width, height: this._height };
  }
}
```

Call it in the layout pass. Shifts in one pass add up; one outside a pass
waits for, and requests, the next. An app `scrollTo` since the last pass
drops it; a `scrollIntoView` lands after it; the result is clamped. It
returns false where nothing scrolls the element.

### Drawing a scene into one node

A frame repaints damaged **rects**, each in a clipped pass that skips
subtrees outside it — at node granularity. When your element is the scene (a
graph, a chart, a timeline, a code editor), a small rect still redraws all
of it into the clip. Two opt-in accessors fix that; say nothing and core's
answer stands.

**Painting: `paintDamage()`** — this pass's rect (window coordinates,
device pixels), or `null` when everything must be drawn. Cull with a pixel
of slack, as core does: antialiasing inks just past computed bounds, and
the pass is clipped anyway. `overlaps(a, b, 1)` here asks whether two rects
come within a pixel:

```js
class FlowNode extends Node {
  paintContent(ctx) {
    // null outside a paint and on a full pass, and both mean the same
    // thing: nothing bounds you, draw the lot
    const damage = this.paintDamage();
    for (const cell of this.gridCells()) {
      if (damage && !overlaps(cell, damage, 1)) continue;
      this.drawCell(ctx, cell);
    }
    for (const edge of this.edges) {
      if (damage && !overlaps(edge.routedBounds, damage, 1)) continue;
      this.drawEdge(ctx, edge);
    }
    // …nodes, minimap, controls
  }
}
```

**Committing: `selfDamagedProps`.** A new identity for any non-event prop
damages the whole node, so a controlled scene committing a new `nodes`
array per drag step repaints the pane. Name the props whose damage your
`applyProps` claims, and the commit claims none:

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

To decide on values rather than names, override
**`paintChanged(next, prev)`**, which the list feeds:

```js
paintChanged(next, prev) {
  if (next.nodes !== prev.nodes && onlyPositionsMoved(next.nodes, prev.nodes)) {
    return false; // folded in place above, and the moved box is claimed
  }
  return super.paintChanged(next, prev);
}
```

- **Hand what you do not recognise to `super`**, which is conservative, or
  a prop you never thought of (`aria-label`, `title`) leaves stale pixels.
- **A style change never reaches either seam**: core compares `style` by
  value and repaints what `Node.paint` draws.
- **Claim before you skip**: `selfDamagedProps` claims nothing for you; a
  named prop you forget to invalidate renders nothing.
- **Not inside `paintCached`**
  ([below](#drawing-once-instead-of-every-frame)): a copy culled by window
  damage is cached half-drawn.

The accessible tree has the same one-node problem: [A scene a screen reader
can walk](#a-scene-a-screen-reader-can-walk). On a 300-node `<Flow>` the
seams take a drag step from about 150 ms to 30 ms.
`REACT_X11_DEBUG_PAINT=1` strokes each pass's rect, so a scene still
repainting whole strobes across the pane ([debugging.md](debugging.md)).

#### Panning a scene you drew

A pan moves every pixel of a picture already on screen. `scrollContents`
does for your viewport what `<box overflow="scroll">` does: blit the
surviving band, repaint the exposed strip.

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
      if (damage && !overlaps(item.bounds, damage, 1)) continue;
      this.draw(ctx, item);
    }
  }
}
```

The call claims `rect` and arms a blit; at frame time core shifts the band
and **narrows the claim to the exposed strip**, which `paintDamage()` hands
your paint. If anything declines, `rect` is repainted as without the call;
the element never needs to know which.

- **`dx`/`dy` are how far the pixels moved** (`copyWithin`'s sense, not a
  scroll offset's): panning right by ten is `dx: 10`, exposing the left
  edge. Whole device pixels; `rect` in window coordinates, inside your
  node. Diagonal is fine.
- **You promise that inside `rect` the frame is exactly that translation.**
  Core declines on the rest: a claim from elsewhere reaching into `rect` by
  even a pixel, a sibling drawing over it, a child laid out over it, your
  own border ring or rounded corner, a layout change, a region too small or
  a shift too large. Pans in one frame coalesce by net shift; two regions
  of one node fall back.

**Furniture along an edge** — a HUD strip — is carved out of the region and
claimed beside it; sibling overlay panels outside `rect` work the same way:

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

**Furniture in a corner is pinned**, since carving takes the rows beside it.
Pass the rects that stay put; core repaints each, and the stale image the
copy dragged, every pan frame — so the furniture may change (a minimap's
viewport box) and claim inside its rect without declining. A claim
elsewhere in the region still declines, as does furniture over three
quarters of the pane.

```js
onDragPan(dx, dy) {
  this.panX += dx;
  this.panY += dy;
  // rects inside the region, in its coordinates, that do not move
  this.scrollContents(this.contentBox(), dx, dy, null, [
    this.minimapRect(),
    this.controlsRect(),
  ]);
}
```

Core pins the four radius-sized corners of a rounded box around your
element itself; your element's own border ring and corners decline. A node
mounted over the region inside a pinned rect (a zoom button, a legend) is
furniture too: pin the rect it claims, `node.paintBounds()`, slop included,
or its hover declines.

**Riders move with the pan.** Widgets mounted beside the pane in a box moved
by exactly (dx, dy) this frame, and changed in no other way, ride the blit
when named:

```js
onDragPan(dx, dy) {
  this.panX += dx;
  this.panY += dy;
  // the layer moves by (dx, dy) in this same frame's commit
  this.scrollContents(this.contentBox(), dx, dy, [this.bodiesLayer]);
}
```

A rider's commit then claims nothing, and its move only what lies outside
`rect` — nothing, if a box that paints nothing clips it to your element.
Anything else it does is claimed normally and declines that frame's blit.

**Zoom is not a blit**: scaling resamples and repaints. A retained `Surface`
shifts with [`copyWithin`](#scrolling-the-pixels-not-just-the-offset)
instead. `REACT_X11_NO_SCROLL_BLIT=1` forces the fallback
([debugging.md](debugging.md#react_x11_no_scroll_blit1)).

### An element that covers its box

An element compositing an opaque bitmap over its whole content box every
paint (a terminal, a media frame) hides what is under it, but core still
fills the window's, ancestors' and its own backgrounds first unless told:

```js
class TerminalNode extends Node {
  opaqueRect() {
    return this.contentBox(); // every pixel of it, alpha one, every paint
  }

  _screenChanged() {
    // a rect inside the answer, not the node: a node claim is inflated by
    // a pixel of slop, which is outside the rect and so never covered
    this.invalidate(false, this.contentBox(), 'content');
  }
}
```

A pass inside the answer skips those fills. Window coordinates like `abs`;
core uses the whole pixels inside it; clipping ancestors shrink it, rounded
ones by their radius. The promise — every pixel, alpha one, every paint,
whatever the props — is yours: a translucent element, or one with an
occasional background, answers `null` (the default). It is read per pass, so it may follow
`contentBox()`.

**It also lets a move be copied.** When a subtree only moved this frame (a
terminal across a desktop, a card across a graph) and something in it
covers its box, core copies its pixels and repaints only the uncovered
strip, the corners a radius gives up, and what is drawn over it. Covering
means an `opaqueRect()` element or a box with a `backgroundColor` nothing
shows through, possibly inside boxes holding nothing else. A card without
a background is repainted where it was and where it went.

Other claims that frame: one from an element **under** the subtree repaints
around the copy, not through it; one from inside, over, or unplaceable
repaints in full. If those cover most of the copy, or need more damage
rects than a frame allows (four on X11: a rounded card's corners plus strip
are five), the move repaints in both places. `REACT_X11_NO_SCROLL_BLIT=1`
turns it off ([debugging.md](debugging.md#react_x11_no_scroll_blit1)).

### An element that draws past its box

Core claims, culls and sizes a fade's surface by a node's box grown by its
outline and shadow. Declare ink beyond that, or it is left on screen when
the element changes and dropped when scrolled just out of a pane:

```js
class RichTextNode extends Node {
  // a code chip is padded two pixels past the run behind it, and at the
  // start of a line that is outside the box
  paintOverhang() {
    return Math.round(2 * this.scale);
  }
}
```

Device pixels, every side, read when core rebuilds cached paint bounds (on
a claim): bound anything the element may draw, not what it drew last.

### Drawing once instead of every frame

A drawing that does not change can be rendered once and composited on later
repaints, one copy shared by every node producing the same key:

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

`format: 'a8'` stores coverage and paints through `tint`: one copy serves
every colour of a monochrome drawing, and colour stays out of the key.

**The key is the entire correctness surface.** It must name every input
`paintCached` reads, derived from what `applyProps` compares; a missed one
shows stale pixels. Develop with `REACT_X11_PAINT_CACHE=verify`, which
re-renders every hit and complains when the drawing changed under the same
key. Return `null` while animated, hovered, focused or blinking.

`paintCached` draws in **surface-local** coordinates. The cache is per X
connection, keyed only on your string: prefix keys with your element name.
`globalAlpha`, the clip and ancestor translation apply at composite time, so
an ancestor's opacity animation still hits.

### Parts of your drawing on layers of their own

On macOS the render server can run an animation — a cursor's blink, an
edge's dash, a tooltip's fade — with no JavaScript frame, if what moves is
on a layer of its own. Layer promotion does that for a `<box>`
([macos.md](macos.md#layer-promotion-the-animated-few-on-their-own-layers-above-the-surface-presenter));
an element that paints its own content answers **sprites**: parts of its
drawing to lift, each with what its layer shows and runs.

```js
sprites() {
  const card = this.cardRect(); // device pixels, window coordinates
  return [
    {
      key: 'card',
      rect: card,
      version: this.cardVersion,
      paint: (ctx) => this.drawCard(ctx, card), // where it is, unfaded
      opacity: 1, // what it rests at
      animations: [
        {
          id: `fade-${this.fadeRun}`,
          property: 'opacity',
          values: [0, 1],
          timings: [[0.25, 0.1, 0.25, 1]],
          duration: 300, // ms
          delay: this.fadeStart - performance.now(), // ms; negative is begun
        },
      ],
    },
  ];
}

spritesLifted(keys) {
  this.lifted = keys; // paint() leaves these out now
}

spriteAnimationEnded(key, id, finished) {
  this.fadeDone = true;
  this.spritesChanged(); // the frame that asks again
}
```

| method                                    |                                                                   |
| ----------------------------------------- | ----------------------------------------------------------------- |
| `sprites()`                               | the parts on offer, or `null`; asked every frame, after layout    |
| `spritesLifted(keys)`                     | which are on layers now, before the frame paints                  |
| `spriteAnimationEnded(key, id, finished)` | the render server is done with one: it ran out, or its layer went |
| `spritesChanged()`                        | ask for a frame when the parts changed and nothing you draw did   |

A part has:

- `key`; `rect` (device pixels, window coordinates); `reach` if it draws
  past `rect`; a `clip`, with `clipRadius` for round corners.
- `paint(ctx)`, drawing it **where it is, at opacity 1, untransformed** (the
  layer applies both), and a `version` whose change paints it again.
- At rest, `opacity` and `transform`: CSS's `matrix(a, b, c, d, e, f)` as an
  array, `e`/`f` in device pixels, about `origin` (default the rect's
  centre); out of the plane, `matrix3d()`'s sixteen numbers column by
  column, translation and perspective distance in device pixels — lifted
  only if no corner is ever behind the viewer.
- `animations` of `opacity` or `transform`: `id`, `property`, `values`,
  `keyTimes`, `timings` (a curve per segment), `duration`, `delay`, `repeat`
  (`Infinity` loops), `autoreverse`, `hold` (stay on the last value). Hand a
  CSS transform animation over **sampled** into matrices from your own
  interpolation; Core Animation's would not turn a full turn or mix
  functions as CSS does.

Every frame the presenter applies promotion's rules **everywhere the part
can be** through its animations:

- **Nothing painted after the element reaches into what shows of it** — no
  later sibling, no ancestor's border, ring or scrollbar. The layer is
  masked to its `clip` and square-cornered clipping ancestors (a carousel
  slide under `overflow: hidden`); a rounded ancestor must hold all of it.
  A part wholly clipped out stays lifted showing nothing, its animation
  running, up to 32 MB of such raster per window; past that, yours to draw.
- **Neither the element nor any ancestor fades.**
- **Your inside is yours.** Offer only parts nothing you draw later
  overlaps, except later parts; list them in paint order. A part turned
  down is yours to draw, and turns down every earlier part it overlaps.

A part may name an earlier one as `parent` (a spinner in a fading card):
its layer goes in the parent's, fading, turning and clipping with it, and
must stay inside the parent's raster. Its `rect`, `origin` and `clip` are
with the parent untransformed. The parent's `paint` gets the keys lifted
inside it and leaves them out, and is repainted in the frame they change.
A child whose parent is not lifted, or that reaches out of it, is yours to
draw, in the parent's raster where that is lifted.

A lifted part is a hole in your drawing from the frame `spritesLifted` says
so; one dropped from the set is yours again that frame. Declining is always
safe: X11, Wayland, the layer presenter and a scene that refuses never ask,
`paint` draws everything, and animations run on your clock.

#### A part that shows a source

`contents`, in place of `paint` and `version`, is today a `VideoFrames` sink
([elements.md](elements.md#video)) — a camera feed in a chart, a preview in
a document — whose every `push` reaches the layer with no window frame:

```js
sprites() {
  const frames = this.props.frames;
  if (!frames?.frame) return null; // nothing to show yet
  const rect = this.previewRect(); // device pixels, on whole pixels
  return [{ key: 'preview', rect, contents: frames }];
}

paint(ctx) {
  super.paint(ctx);
  if (!this.lifted.has('preview')) this.drawPreview(ctx); // the newest frame
}
```

The layer is exactly `rect`, the picture scaled in, so keep it on whole
pixels or a seam shows; `spritesChanged()` when it comes or goes. A
presenter without video surfaces — every backend but macOS — declines, and
you draw the newest frame. `<video>` is built this
way (`src/nodes/video.js`).

For every part: an animation is attached **once per `id`**; change the id
to restart it, and a finished one is not restarted while listed. `delay`
counts from the asking frame and is read only on the first. A part repaints
only on a new `version`, a fractional move or a resize; a whole-pixel move
just moves the layer.

Sprites need `@windowkit/appkit` 0.19 or later; on an older bridge nothing
is asked. A bridge whose `transformForms()` lacks `matrix3d` leaves parts
out of the plane to their elements.

#### A part that is its shadows

`shadows` in place of `paint` makes a part CSS outer `box-shadow`s, blurred
on the GPU. `rect` is the casting box, with `rectRadius`; nothing is drawn
inside it. Each shadow: a `rect` and its corners' `radius`, offsets `x` and
`y`, CSS's `blur` and `color` as straight-sRGB `[r, g, b, a]` in 0–1. The
first is on top; fold a spread into the shape yourself.

```js
sprites() {
  const card = this.cardRect(); // device pixels, window coordinates
  const s = this.scale;
  return [
    {
      key: 'card-glow',
      rect: card,
      rectRadius: 8 * s,
      shadows: [
        { rect: card, radius: 8 * s, blur: 200 * s, color: [0.09, 0.63, 0.79, 0.25] },
        { rect: card, radius: 8 * s, y: 3 * s, blur: 2 * s, color: [0.38, 0.45, 0.47, 0.05] },
      ],
      animations: [
        {
          id: `glow-${this.hoverRun}`,
          property: 'shadowBlur',
          shadow: 0, // which of them
          values: [0, 200 * s],
          duration: 250,
        },
      ],
    },
  ];
}
```

Animations: `'shadowBlur'`, `'shadowColor'`, `'shadowOffset'` (`shadow`
the index; blurs and `[x, y]` in device pixels), plus `opacity` and
`transform` on the whole part. Pad between different shadow lists as CSS
does, and sample colours where Core Animation's straight interpolation is
not CSS's. Nothing painted after your element may reach into the glow,
through any keyframe. While lifted, draw the box minus its shadows. Such a
part is never inside another.

### Elements that own a real X window

`drawn: false` is for a node with its own child X window — a GL surface, an
XEMBED socket, a video overlay. Read the two examples in order.

`GlAreaNode` (`src/glnodes.js`) has no paint code; the owning `WindowNode`
realizes it in the commit phase, so the child names its real parent from
the start. **No X calls in the render phase**, which can be discarded.

X delivers a device event to the first window up the hierarchy that
selected it: a child that selects nothing passes the pointer to the tree's
window (as `<glarea>` does), one that selects `ButtonPress` keeps every
press. Select only what you need; ntk selects whatever a window is listened
to for. The owning window's hit test knows `<glarea>` surfaces, not your
window, so a point over yours lands on what the tree has behind it.

`ForeignNode` (`src/foreignnodes.js`), for a resource you did not create:

- **Nothing in the render phase.** A `CreateWindow` from a discarded render
  leaks a server resource; a `ReparentWindow` has moved another program's
  window for real.
- **Teardown is synchronous.** `WindowNode.destroySubtree` destroys its X
  window in the same turn as your node, and `DestroyWindow` takes every
  inferior, so a release awaiting a round trip is too late. Requests are
  ordered on the connection, which makes "hand it back, _then_ destroy the
  container" a guarantee.
- **Give it back, do not destroy it.**

## A layout algorithm of your own

`layout` on a box ([styling.md](styling.md#custom-layouts)) names an
algorithm, and `registerLayout` teaches react-x11 one. A radial menu's:

```js
import { registerLayout } from 'react-x11/host';

registerLayout('radial', {
  options: { radius: { type: 'length', default: 80 } },
  layout(children, c, { radius }) {
    const sizes = children.map((child) => child.measure());
    const reach = Math.max(0, ...sizes.map((s) => Math.max(s.width, s.height)));
    const width = c.widthMode === 'exactly' ? c.width : 2 * radius + reach;
    const height = c.heightMode === 'exactly' ? c.height : 2 * radius + reach;
    const step = (2 * Math.PI) / Math.max(1, children.length);
    return {
      width,
      height,
      children: sizes.map((s, i) => ({
        x: width / 2 + radius * Math.cos(i * step) - s.width / 2,
        y: height / 2 + radius * Math.sin(i * step) - s.height / 2,
      })),
    };
  },
});
```

```jsx
<box style={{ layout: { name: 'radial', radius: 64 } }}>
  {tools.map((tool) => (
    <ToolButton key={tool.id} tool={tool} />
  ))}
</box>
```

**One function, two questions.** `layout(children, constraints, options,
info)` is asked how big the content is for `constraints` (as
`measureContent` gets them, `Infinity` for no bound), several times a pass,
at sizes nothing is drawn at. When both modes are `'exactly'` the answer
places too: `children`, one rect per child — `{ x, y }` from the content
box's corner, plus a `width` and `height` to lay it out at, either left out
being the child's own. `measureContent`'s rules apply
([above](#what-it-must-not-do)): no `abs`, no state, finite numbers.

**What it gets of a child** is a `LayoutChild`, never a node:

| member                  |                                                                                                    |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| `measure(constraints?)` | its size. A bare number is `'exactly'`, an omitted axis `'unconstrained'`, `'at-most'` fit-content |
| `intrinsicSizes()`      | `{ minContentWidth, maxContentWidth }`: its content floor, and its width with no bound             |
| `options`               | its `layoutItem`, against your `childOptions`                                                      |
| `style`                 | its resolved style, read-only, device pixels (`gridColumn`, `alignSelf`…)                          |
| `index`                 | its place in the list                                                                              |

Every size is the child's **margin box**, in device pixels, so lining
children up is right about margins without knowing they exist.

**Options are declared, and typed.** `options` and `childOptions` map names
to `{ type, default }`: `'length'`, `'number'`, `'integer'`, `'boolean'`,
`'string'`, `'any'`, or an array of allowed values. A `length` is written in
logical pixels and arrives in device pixels. A wrong-typed value or an
undeclared option is reported by name and takes the default. The box's own
style (`gap`, `justifyContent`, `alignItems`) is `info.style`, so do not
declare look-alikes. `info.scale` is for a length the schema cannot see (in
a string, like a grid's tracks). `info.report(message, consequence)`
reports once something wrong that can be laid out around (an unnamed grid
area); throw only for what cannot be laid out at all.

**What core does.** It lays each child out at its rect, mirrors the slots
for right-to-left and rounds them to whole pixels, places absolutely
positioned children by their insets, measures content floors, carries a
child's change into the next pass, and — when the algorithm throws or
answers something that is not a size — reports it and lays the box out as
flexbox in the same frame.

Register before you render. Registering a name twice with a different
function throws unless `override: true`; under hot reload a module
re-registering its own replaces it, and a mounted box keeps its definition
until its style names a layout again. Worked examples: `masonry` and
`equal-row` (`src/layouts.js`), and `grid` (`src/grid.js`), which takes no
options and reads tracks from `info.style` and places from each child's
`style`.

In TypeScript, augment `CustomLayouts` and
`layout: { name: 'radial', radius: 40 }` type-checks, typos included;
`CustomLayoutItem` is what a child may say:

```ts
declare module 'react-x11/host' {
  interface CustomLayouts {
    radial: { radius?: number };
  }
}
```

## A position of your own

`registerPosition` adds a positioning scheme
([styling.md](styling.md#custom-positions)): the box is laid out in flow, as
`relative` is, and after every layout pass `place(node, context)` says how
far to move it. A drop's flight home, from where the pointer let go to where
layout put the item:

```js
import { registerPosition } from 'react-x11/host';

registerPosition('landing', {
  options: {
    from: { type: 'any' }, // { x, y }, window coordinates
    started: { type: 'number' },
    ms: { type: 'number', default: 200 },
  },
  place(node, { laidOut, now, options: { from, started, ms } }) {
    if (!from) return null;
    const t = Math.min(1, (now - started) / ms);
    const left = (1 - t) * (1 - t); // easing out
    return {
      x: (from.x - laidOut.x) * left,
      y: (from.y - laidOut.y) * left,
      again: t < 1,
    };
  },
});
```

`place` returns `{ x, y }`, how far to move the node in device pixels
(rounded for you), or null to leave it; `again: true` asks for another
frame, which runs placement with nothing to lay out. It resizes nothing and
sets no state: it runs on every layout pass, a scroll's included, so what
it moves lands in the frame that scrolled.

Its context, in window coordinates and device pixels:

| field               |                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------- |
| `laidOut`           | `{ x, y, width, height }`: where layout put the node, before placement                        |
| `pane`              | nearest scroll pane: `scrollport` (inside border, over padding), `scrollX`/`scrollY`; or null |
| `container`         | the parent's content box, or for a pane's direct child its scrolled content                   |
| `margin`            | its margins                                                                                   |
| `direction`/`scale` | the node's                                                                                    |
| `now`               | the frame clock, in ms                                                                        |
| `options`           | its options, resolved as a layout's are                                                       |

`node` is the node, for its `style`: the insets are the scheme's to read
(sticky reads them as thresholds); yoga never sees them as offsets.

**What core does.** It re-derives the laid-out position every pass, so
nothing remembers an offset; claims where the node was and went as damage,
keeping a pane's scroll blit; lifts it over siblings of the same `zIndex`
for paint and hit testing; and when `place` throws, reports it once and
leaves the node where layout put it until its style names another position.
`position: 'sticky'` is written against exactly this (`placeSticky` in
`src/layouts.js`).

In TypeScript, augment `CustomPositions` the way `CustomLayouts` is.

## The subpath exports

| subpath             |                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `react-x11/host`    | `registerElement`/`Layout`/`Position`, their `unregister…` and `registered…s`, `hostTypes`, `knownElements`, `drawnKinds` |
| `react-x11/node`    | `Node`, the built-in node classes, `Scrollable`, `intrinsicSize`                                                          |
| `react-x11/style`   | `createStyles`, `flattenStyle`, `isStyleProp`, `resolveTokens`, the rest of the vocabulary                                |
| `react-x11/yoga`    | the layout engine: `Yoga`, `loadLayout`, `layoutLoaded`. Rarely needed (below)                                            |
| `react-x11/ntk`     | ntk (`Path2D`, `Image`, `Pixmap`, font sources, `createClient`), the backend's `Surface`, `decodeImageBytes`              |
| `react-x11/keysyms` | the `XK_*` constants, `keysymOf`, `charOf`, `MOD`, `ctrlChordLetter`                                                      |

**Reach ntk through `react-x11/ntk`, never a second dependency.** Two copies
mean two font caches and glyph atlases, and a node built against one cannot
be painted by the other — it looks like a drawing bug. Its `Surface` is the
backend's own (above), where ntk's is the X11 pixmap; its
`decodeImageBytes` is what `<image>` uses — WebP everywhere, under Bun every
format Bun reads, off the JavaScript thread — where ntk's `decodeImage` is
PNG and JPEG, synchronously ([formats](elements.md#formats-and-what-decodes-them)).

**An element does not need the layout engine**: `measureContent` gets its
constraints in words, not yoga's integers, and arranging a box's children
is `registerLayout` ([above](#a-layout-algorithm-of-your-own)).
`react-x11/yoga` is for an element laying out content it draws that wants
flexbox for part of it (`@react-x11/components`' `<Html>` does, for
`display: flex`). Use **this** engine, never your own `yoga-layout`: two
WebAssembly instances cannot share nodes, and mixing them crashes inside
the engine, naming nothing you wrote.

```ts
import { Yoga, loadLayout } from 'react-x11/yoga';

await loadLayout(); // createRoot() has already done this inside an app
const root = Yoga.Node.create();
root.setFlexDirection(Yoga.FLEX_DIRECTION_ROW);
```

The enum constants are readable at once; `Node` and `Config` throw until
the assembly is loaded, which `createRoot()` awaits
([packaging.md](packaging.md)).

## Typing

Declare the element to JSX by module augmentation, as
[typescript.md](typescript.md) describes:

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

`Context2D` from `react-x11/node` is the canvas-shaped subset every backend
implements, so `paintContent(ctx: Context2D)` type-checks every call; a
member not every backend has is optional (`globalCompositeOperation`, which
a native context takes only for modes its bridge draws — assign and read
back) or absent. `paintCachePlan`, `paintCached`, `opaqueRect` and the rest
of the contract are on the class, with `PaintCachePlan` for the plan.

// `react-x11/node` — the base class a registered element subclasses, plus
// the built-in nodes worth extending or reading as worked examples.
//
// The contract a subclass has to keep is written down in docs/extending.md.
// The short version: `Node` already implements the whole reconciler-facing
// surface (`insertBefore`, `removeChild`, `applyProps`, `destroySubtree`,
// layout, hit testing, and a `paint` that draws background, border and
// clip), so an element that only draws needs a constructor that names its
// kind and a `paint` that calls `super.paint(ctx)` first. An element whose
// *size* comes from its content adds `measureContent`, and says when that
// answer moves with `invalidateMeasure`. An element that *behaves* — one
// that edits, drags a caret or answers chords — adds the `default*` methods:
// they run after the application's own handlers and not at all if one of
// those called `preventDefault`, which is the ordering that makes an
// interactive element composable rather than something to work around.
export { Node } from './nodes/node.js';
// `class MyPane extends Scrollable(Node)` — the same mixin <box> and
// <window> use, so a registered element can honour `overflow: 'scroll'`
// with the wheel, the keys, the bars and the a11y role already wired.
export { Scrollable } from './nodes/scrollable.js';
// The `measureContent` body of an element whose content has a size of its
// own and an aspect ratio to keep — what <image> and <svg> answer with.
export { intrinsicSize } from './nodes/layout.js';
// The cadence a caret blinks at, so an element that draws one is in step
// with `<textinput>` rather than a few tens of milliseconds beside it.
export { CARET_BLINK_MS } from './nodes/textinput.js';
export { BoxNode } from './nodes/box.js';
export { TextNode } from './nodes/text.js';
export { ImageNode } from './nodes/image.js';
export { CanvasNode } from './nodes/canvas.js';
export { TextInputNode } from './nodes/textinput.js';
export { TextAreaNode } from './nodes/textarea.js';
export { WindowNode } from './nodes/window/window.js';
export { PopupNode } from './nodes/window/popup.js';

// The two precedents for an element that owns a real child X window rather
// than painting into its parent's: registered with `drawn: false`, realized
// by the owning WindowNode. docs/extending.md walks through them —
// `GlAreaNode` for a surface of one's own, `ForeignNode` for one that holds
// somebody else's window and therefore must never destroy it.
export { GlAreaNode } from './glnodes.js';
export { ForeignNode } from './foreignnodes.js';

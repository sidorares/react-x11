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
// answer moves with `invalidateMeasure`.
export {
  Node,
  // `class MyPane extends Scrollable(Node)` — the same mixin <box> and
  // <window> use, so a registered element can honour `overflow: 'scroll'`
  // with the wheel, the keys, the bars and the a11y role already wired.
  Scrollable,
  // The `measureContent` body of an element whose content has a size of its
  // own and an aspect ratio to keep — what <image> and <svg> answer with.
  intrinsicSize,
  BoxNode,
  TextNode,
  ImageNode,
  CanvasNode,
  TextInputNode,
  TextAreaNode,
  WindowNode,
  PopupNode,
} from './nodes.js';

// The precedent for an element that owns a real child X window rather than
// painting into its parent's: registered with `drawn: false`, realized by
// the owning WindowNode. docs/extending.md walks through it.
export { GlAreaNode } from './glnodes.js';

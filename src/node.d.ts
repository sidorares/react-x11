/**
 * `react-x11/node` — the base class a registered element subclasses.
 *
 * Typed as the surface a subclass legitimately uses. It is deliberately
 * narrower than the runtime class: everything underscore-prefixed is
 * internal and may change in a patch release. docs/extending.md is the
 * contract in prose.
 */
import type { Rect, NtkApp } from './types/nodes.js';
import type { Style } from './types/style.js';

/** ntk's 2d context. Typed loosely — it is ntk's API, not ours. */
export type Context2D = unknown;

/** How an axis is bounded when layout asks an element for its size.
 * `'exactly'` — the style decided this axis; `'at-most'` — that many pixels
 * are on offer; `'unconstrained'` — nothing bounds it. */
export type MeasureMode = 'exactly' | 'at-most' | 'unconstrained';

/** The question `measureContent` answers. */
export interface MeasureConstraints {
  /** Pixels on offer across, per `widthMode`. `Infinity` when unbounded, so
   * `Math.min(preferred, width)` is right in every mode. */
  width: number;
  /** Pixels on offer down, per `heightMode`. `Infinity` when unbounded. */
  height: number;
  widthMode: MeasureMode;
  heightMode: MeasureMode;
}

/** What `measureContent` answers with. */
export interface MeasuredSize {
  width: number;
  height: number;
}

/**
 * The `measureContent` body for content with a natural size and an aspect
 * ratio to keep — `<image>` and `<svg>` are written on it:
 *
 * ```js
 * measureContent(constraints) {
 *   return intrinsicSize({ width: 320, height: 200 }, constraints);
 * }
 * ```
 */
export declare function intrinsicSize(
  natural: MeasuredSize,
  constraints: MeasureConstraints,
): MeasuredSize;

export declare class Node {
  constructor(
    kind: string,
    props: Record<string, unknown>,
    app: NtkApp,
    options?: { yoga?: boolean },
  );

  /** Element name. Must equal the name it was registered under. */
  readonly kind: string;
  /** The current props. Replaced wholesale by `applyProps`. */
  readonly props: Record<string, unknown>;
  /** The ntk connection this tree renders through. */
  readonly app: NtkApp;
  readonly parent: Node | null;
  readonly children: Node[];
  /** The owning `<window>` node, once attached. */
  readonly root: Node | null;
  readonly destroyed: boolean;
  /** Position and size within the owning window, valid after layout. */
  readonly abs: Rect;
  /** The flattened `style` prop with the active state blocks overlaid.
   * Everything that paints or lays out reads this, never `props`. */
  readonly style: Style;
  /** The nearest `theme` at or above this node. */
  readonly theme: Record<string, unknown> | null;
  /** Style names this element owns as its own semantics. Registered
   * elements declare these to `registerElement` instead of overriding. */
  readonly semanticNames: ReadonlySet<string>;

  /** Draw. A subclass calls `super.paint(ctx)` first, for the background,
   * border and clip, then draws inside `this.abs`. */
  paint(ctx: Context2D): void;
  /**
   * Implemented by an element whose size comes from its content — a gauge, a
   * chart, a terminal, an editor. Called during layout whenever the box's
   * size is the element's to give, and by the content-floor pass behind
   * `minWidth: 'auto'` with `{ width: 0, widthMode: 'at-most' }`, whose
   * answer is the smallest size the content can be drawn at.
   *
   * Must be a **method on the class**: the base constructor is what wires it
   * to layout. An element that implements it may not have children, and it
   * has to answer from what it can read at any time (props, loaded data) —
   * never from `this.abs`, which is the result of the layout doing the
   * asking. Call `invalidateMeasure()` when the answer would change.
   */
  measureContent?(constraints: MeasureConstraints): MeasuredSize;
  /** The inputs to `measureContent` changed — a prop it reads, data that
   * arrived — so the next layout has to ask again. `reason` joins the closed
   * set the diagnostics print. */
  invalidateMeasure(reason?: string): void;
  /** Props changed. A subclass calls `super.applyProps(next, prev)`. */
  applyProps(
    nextProps: Record<string, unknown>,
    prevProps: Record<string, unknown>,
  ): void;
  /** The deepest node containing the point, or null. */
  hitTest(x: number, y: number): Node | null;
  containsPoint(x: number, y: number): boolean;
  /** Drawn, visible children in paint order. */
  paintOrder(): Node[];
  insertBefore(child: Node, beforeChild: Node | null): void;
  removeChild(child: Node): void;
  destroySubtree(): void;
  /** Ask the owning window to repaint. `reason` joins the closed set the
   * diagnostics print (docs/debugging.md). */
  invalidate(layout?: boolean, rect?: Rect | null, reason?: string): void;
  getClientRects(): Rect[];
}

/**
 * Scrolling as a mixin: `class Pane extends Scrollable(Node)` gives a
 * registered element the same `overflow: 'scroll'` behaviour `<box>` and
 * `<window>` have — wheel, keys, bars, and the AT-SPI scroll-pane role.
 */
export declare function Scrollable<T extends typeof Node>(
  Base: T,
): T & {
  new (...args: any[]): {
    scrollX: number;
    scrollY: number;
    contentWidth: number;
    contentHeight: number;
    isScroller(): boolean;
    scrollTo(to: number | { x?: number; y?: number }): void;
    scrollBy(by: number | { x?: number; y?: number }): void;
    scrollIntoView(node: Node): void;
  };
};

export declare class BoxNode extends Node {
  constructor(props: Record<string, unknown>, app: NtkApp);
}

export declare class TextNode extends Node {}
export declare class ImageNode extends Node {}
export declare class CanvasNode extends Node {}
export declare class TextInputNode extends Node {}
export declare class TextAreaNode extends TextInputNode {}
export declare class WindowNode extends Node {}
export declare class PopupNode extends WindowNode {}
/** The precedent for an element owning a real child X window. */
export declare class GlAreaNode extends Node {}

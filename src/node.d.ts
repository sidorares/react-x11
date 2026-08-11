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
import type { KeyboardEvent, MouseEvent } from './types/events.js';

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

/**
 * How long a caret stays in each of its two states, in milliseconds — what
 * `<textinput>` blinks at. An element that draws its own caret uses this
 * rather than a number of its own, so two carets on one screen are in step.
 */
export declare const CARET_BLINK_MS: number;

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
  /**
   * The element's own behaviour for a key, run **after** the application's
   * `onKeyDown` handlers and not at all if one of them called
   * `preventDefault()` — the ordering that lets an app veto or extend an
   * interactive element without knowing how it is built.
   *
   * Tab arrives here like any other key. Consuming it — an editor that
   * indents — means calling `ev.preventDefault()`, which suppresses the
   * default action left after this one: the focus cycle. An element that
   * takes Tab owes the user a way back out; see docs/extending.md.
   */
  defaultKeyDown?(ev: KeyboardEvent): void;
  /** The element's own behaviour for a press, after `onMouseDown` handlers:
   * placing a caret, grabbing a scrollbar thumb, arming a drag. */
  defaultMouseDown?(ev: MouseEvent): void;
  /** Pointer motion while this element holds the press — it keeps receiving
   * these wherever the pointer goes, as `onMouseMove` does not. */
  defaultMouseDrag?(ev: MouseEvent): void;
  /** The press this element received has been released. */
  defaultMouseUp?(ev: MouseEvent): void;
  /** Right-click, after `onContextMenu` handlers: open the element's own
   * menu. Separate from the press so suppressing the menu does not also
   * give up the caret placement `defaultMouseDown` did. */
  defaultContextMenu?(ev: MouseEvent): void;
  /** This element became the focused node, or its window regained the X
   * focus while it was: start a caret blinking, arm an IME. No event —
   * focus is a state, and `onFocus` is where the app hears about it. */
  defaultFocus?(): void;
  /** Focus left, or the window lost it: stop whatever `defaultFocus`
   * started. A node that unmounts while focused is *forgotten* rather than
   * blurred, so anything with a lifetime — a blink timer — is released in
   * `destroySubtree` as well, the way `<textinput>` does. */
  defaultBlur?(): void;
  /** Whether this element is a tab stop and a focus target with nothing in
   * the props saying so — `<textinput>` is, a `<box>` with something to
   * scroll is. `focusable`/`tabIndex` props override it either way. An
   * element with default actions for keys has to set this, or nothing will
   * ever focus it. */
  focusableByDefault?: boolean;
  /** The cursor to show over this element when nothing in the style says
   * otherwise — `'text'` for something editable. A `cursor` style wins. */
  defaultCursor?: string;
  /** Props changed. A subclass calls `super.applyProps(next, prev)`. */
  applyProps(
    nextProps: Record<string, unknown>,
    prevProps: Record<string, unknown>,
  ): void;
  /** Take the keyboard focus, as clicking this node would: focus moves
   * here, `onBlur` fires on whatever had it, `onFocus` here. Also pulls the
   * X input focus back to the window if the window manager gave it away.
   * Returns this node, so an element can hand it out of a method. */
  focus(): this;
  /** Give up focus, leaving the window with nothing focused. */
  blur(): this;
  /** Whether this node has the owning window's focus. */
  readonly focused: boolean;
  /** Whether focus is on this node or inside it — CSS `:focus-within`. A
   * `<popup>` counts as inside the node it hangs off in the JSX tree. */
  readonly focusWithin: boolean;
  /** Whether `node` is this node or a descendant of it (DOM `contains`). */
  contains(node: Node | null): boolean;
  /** The deepest node containing the point, or null. */
  hitTest(x: number, y: number): Node | null;
  containsPoint(x: number, y: number): boolean;
  /** Drawn, visible children in paint order. */
  paintOrder(): Node[];
  insertBefore(child: Node, beforeChild: Node | null): void;
  removeChild(child: Node): void;
  destroySubtree(): void;
  /** Ask the owning window to repaint — every node has this; the window
   * node is where it lands. `damage` is what changed: pass `this`, or a
   * rect when you know a tighter one, because an invalidation with no bound
   * repaints the whole window. `reason` joins the closed set the
   * diagnostics print (docs/debugging.md). */
  invalidate(
    layout?: boolean,
    damage?: Node | Rect | null,
    reason?: string,
  ): void;
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

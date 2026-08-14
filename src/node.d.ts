/**
 * `react-x11/node` — the base class a registered element subclasses.
 *
 * Typed as the surface a subclass legitimately uses. It is deliberately
 * narrower than the runtime class: everything underscore-prefixed is
 * internal and may change in a patch release. docs/extending.md is the
 * contract in prose.
 */
import type {
  Rect,
  NtkApp,
  TextPosition,
  TextSelectionSnapshot,
} from './types/nodes.js';
import type {
  FontStyle,
  FontWeight,
  Style,
  TextRendering,
} from './types/style.js';
import type {
  CompositionEvent,
  KeyboardEvent,
  MouseEvent,
  WheelEvent,
} from './types/events.js';

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
 * A resolved text style — the base style `app.fonts.layout` takes, which is
 * ntk's vocabulary rather than the style vocabulary: `family` for
 * `fontFamily`, `variations` for `fontVariationSettings`.
 */
export interface TextStyle {
  /** A CSS-style family list, as `fontFamily` is written. */
  family: string;
  size: number;
  weight: FontWeight;
  style: FontStyle;
  /** A variable font's axes, `{ wght: 460 }` — undefined unless a style or
   * the cascade above it named one. */
  variations: Record<string, number> | undefined;
  textRendering: TextRendering | undefined;
  color: string;
}

/**
 * What an element holding text tells an assistive technology
 * (`a11yTextState`). Offsets are **code points**, counted the way
 * `Array.from(value).length` counts, and index `value` — the string the
 * element *draws*, an open composition included.
 */
export interface A11yTextState {
  /** The text as drawn. */
  value: string;
  /** Where the caret is. Defaults to `selectionEnd`. */
  caret?: number;
  /** The selected range; equal offsets mean a bare caret. Default 0. */
  selectionStart?: number;
  selectionEnd?: number;
  /** Whether this is text the user edits — an editor rather than a viewer.
   * Sets the EDITABLE state and, with `a11yReplaceText`, the AT-SPI
   * EditableText interface. */
  editable?: boolean;
  /** One line or many. Left unsaid, neither state is claimed rather than
   * guessed from the current value. */
  multiline?: boolean;
  /** The part of `value` that is an open composition — a dead key, a
   * half-typed Compose sequence — so a reader can tell it from the
   * character it commits. `offset` is where it starts in `value`. */
  preedit?: { offset: number; text: string } | null;
}

/**
 * One thing an element drew, as an assistive technology should meet it
 * (`a11yScene`). Everything but `id` and `rect` is optional, and what is
 * left out is simply not claimed.
 */
export interface A11ySceneItem {
  /** This item's name for the whole time it is on screen. Identity is
   * matched on it frame to frame, so a fresh id per frame is a child that
   * is destroyed and recreated under every screen reader holding it. */
  id: string;
  /** Where it is drawn, in the owning window's coordinates — the same
   * space as `abs` and a mouse event's `x`/`y`. Where AT focus draws and
   * what a magnifier follows. */
  rect: Rect;
  /** The ARIA role it plays. `'group'` when it says none, which is
   * audible and promises nothing. A role that promises activation
   * (`button`, `option`, `treeitem`, …) gives it an AT-SPI action, and so
   * does the element implementing `a11ySceneAction`. */
  role?: string;
  /** What a screen reader says. Anything unnamed is announced as having no
   * accessible name, which is the defect being loud rather than hidden. */
  name?: string;
  description?: string;
  /** Whether an AT may put its focus here. Default true. */
  focusable?: boolean;
  states?: {
    selected?: boolean;
    checked?: boolean | 'mixed';
    expanded?: boolean;
    disabled?: boolean;
    busy?: boolean;
    /** The element's own keyboard cursor — the item arrow keys would act
     * on. Element-internal focus never reaches the window's focus manager,
     * so this is the only way it is reported. */
    focused?: boolean;
  };
  /** Anything else this item would carry as an element: `aria-level`,
   * `aria-posinset`/`aria-setsize` (Orca's "3 of 7"), `aria-valuenow`,
   * `aria-keyshortcuts`, `aria-hidden`. Read exactly as they are on a
   * `<box>`; the fields above win where they overlap. */
  props?: Record<string, unknown>;
  /** A scene with structure — series and points, groups and nodes. Ids are
   * matched within their parent, so they only have to be unique there. */
  children?: A11ySceneItem[];
}

/** What an assistive technology asks an element to do with one of the
 * things it drew. */
export type A11ySceneAction = 'activate' | 'focus' | 'scroll';

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
  /** `abs` inset by the border and the padding — where the content goes,
   * and where every built-in draws. The insets come off the layout, which
   * is where percentages and the per-side overrides have already been
   * resolved, so this is not arithmetic to redo from `style`. */
  contentBox(): Rect;
  /** The text style this node resolves to, in the shape `app.fonts.layout`
   * takes: the style's font properties over what the palette says text
   * with none of its own is set in. An element that draws text inherits
   * exactly what `<text>` inherits by asking. */
  resolvedTextStyle(): TextStyle;
  /** The flattened `style` prop with the active state blocks overlaid.
   * Everything that paints or lays out reads this, never `props`. */
  readonly style: Style;
  /** The nearest `theme` at or above this node. */
  readonly theme: Record<string, unknown> | null;
  /** Which way this node reads, resolved — `'ltr'` or `'rtl'`, never
   * `'inherit'`. Yoga has already mirrored the boxes, so this is for what an
   * element draws *inside* one: which side a mark sits on, which way a
   * chevron points, what a pointer coordinate means. */
  readonly direction: 'ltr' | 'rtl';
  /** Style names this element owns as its own semantics. Registered
   * elements declare these to `registerElement` instead of overriding. */
  readonly semanticNames: ReadonlySet<string>;
  /** Prop names whose damage this element's own `applyProps` claims, and
   * which `paintChanged` therefore does not damage the whole node for.
   * Empty unless declared — registered elements declare theirs to
   * `registerElement`, so the common case needs no subclass. */
  readonly selfDamagedProps: ReadonlySet<string>;

  // --- the text this element answers for (docs/extending.md) ---------------
  //
  // Four questions in one index space and one coordinate space: characters
  // are **code points**, rectangles are in the owning window's coordinates —
  // the same ones `abs`, `contentBox()` and a mouse event's `x`/`y` use.
  // An element that answers them can be selected across by a `selectable`
  // ancestor with no registration of any kind.

  /** This element's text, or null when it has none. The default. */
  textContent(): string | null;
  /** The character boundary nearest a point. Clamps to the ends. */
  textIndexAt(x: number, y: number): number;
  /** Where a caret at this index stands — a zero-width rect from the top of
   * the glyphs to the bottom of them. */
  textCaretRect(index: number): Rect | null;
  /** The bands a highlight over `[start, end)` fills: one per line, and one
   * per direction run within a line — a range that crosses from Latin into
   * Arabic is two stretches of pixels, not the span between them. */
  textRangeRects(start: number, end: number): Rect[];
  /** The part of this element's text the document selection covers, or
   * null. An element that paints its own text fills `textRangeRects` with
   * `selectionColor` under the glyphs while this is set; that is the whole
   * contract for taking part in a selection. */
  readonly selectionRange: { start: number; end: number } | null;
  /** What to fill those rectangles with while `selectionRange` is set. */
  readonly selectionColor: string | null;
  /** An element with a selection of its own — an editor. A `selectable`
   * document around it skips its subtree whole and leaves its presses
   * alone. `<textinput>` sets it. */
  hasOwnSelection: boolean;

  // --- being a selection surface -------------------------------------------
  //
  // The base class implements these for every node, which is what lets a
  // registered element be passed anywhere a `DrawnNode` is taken — the
  // interface in `types/nodes.d.ts` lists them, so leaving them out here
  // made a subclass stop being one.

  /** The selection this element owns, or null when it is not `selectable`.
   * A snapshot: read it again after a change. */
  readonly textSelection: TextSelectionSnapshot | null;
  /** Select everything in this surface, and take PRIMARY with it. */
  selectAll(): this;
  /** Drop the selection. PRIMARY is left where it is: the text stays
   * pasteable, which is what every other X client does. */
  clearSelection(): this;
  /** What a copy would put on the clipboard. */
  selectedText(): string;
  /** Set both ends by hand. `setSelection(null)` clears. */
  setSelection(anchor: TextPosition | null, focus?: TextPosition | null): this;

  /** Draw. A subclass calls `super.paint(ctx)` first, for the background,
   * border and clip, then draws inside `this.abs`. */
  paint(ctx: Context2D): void;
  /**
   * The rect this paint pass is repainting, or null when it is repainting
   * the whole window — and null outside a paint, which means the same
   * thing: nothing is bounding you, so draw everything.
   *
   * An element whose node is one node never needs it; being painted at all
   * means it is inside the pass. An element that draws a **scene** into one
   * node culls against it the way core culls the tree, instead of redrawing
   * the scene into a clip that throws most of it away. Window coordinates,
   * the same space as `abs`; read-only.
   */
  paintDamage(): Rect | null;
  /**
   * "The pixels in `rect` moved by (dx, dy); the rest of it is new" — for an
   * element with a viewport of its own, whose pan is a scroll in every way
   * but the bookkeeping.
   *
   * Claims `rect`, and arms the frame to blit the surviving band inside the
   * backing store instead — after which the claim is narrowed to the band
   * the shift exposed, which is what `paintDamage()` hands the paint. The
   * element draws the strip and nothing else, without asking whether the
   * blit happened.
   *
   * `dx`/`dy` are how far the **pixels** moved, the sense `Surface.copyWithin`
   * uses rather than a scroll offset's, and whole. `rect` is in window
   * coordinates and inside this node. The return says whether the frame is
   * still a blit candidate; the gates that matter close at frame time, and
   * every one of them falls back to repainting `rect`.
   */
  scrollContents(rect: Rect, dx: number, dy: number): boolean;
  /**
   * Did anything this node draws change? True damages the whole node, false
   * contributes no damage at all, and the default answers true for any prop
   * that is not identical to the one it replaced — conservative, because a
   * wrong "no" is a stale pixel nothing comes back to fix.
   *
   * Overridden by an element that claims its own damage and can say so only
   * by looking at the values; an element that can say so by *name* declares
   * `selfDamagedProps` instead. Either way, call `super.paintChanged` for
   * everything the element does not know about — `style` is compared by the
   * caller and is never yours to excuse.
   */
  paintChanged(
    nextProps: Record<string, unknown>,
    prevProps: Record<string, unknown>,
  ): boolean;
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
  /**
   * Text the user is still typing: a dead key waiting for its letter, or a
   * Compose sequence half entered. `ev.type` is `compositionStart`,
   * `compositionUpdate` or `compositionEnd`, and `ev.data` is what to show
   * — or, at the end, the text that was committed.
   *
   * An element that implements this shows the preedit at its caret and
   * inserts only what the end carries; the keys that made it never reach
   * `defaultKeyDown`. See docs/extending.md.
   */
  defaultComposition?(ev: CompositionEvent): void;
  /**
   * The element's own behaviour for a press, after `onMouseDown` handlers:
   * placing a caret, grabbing a scrollbar thumb, arming a drag.
   *
   * The base class implements this (and the two below, and `defaultKeyDown`)
   * to hand the gesture to the nearest `selectable` ancestor, so a press on
   * anything inside a document reaches the selection. An element that
   * overrides it and does not call `super` is, by that alone, not part of
   * one — which is right for anything that edits, and wrong for anything
   * that only draws.
   */
  defaultMouseDown?(ev: MouseEvent): void;
  /** Pointer motion while this element holds the press — it keeps receiving
   * these wherever the pointer goes, as `onMouseMove` does not. */
  defaultMouseDrag?(ev: MouseEvent): void;
  /** The press this element received has been released. */
  defaultMouseUp?(ev: MouseEvent): void;
  /**
   * Plain pointer motion over this element, with no button down — the hook
   * for an element that paints its own hover state, a scene where the node
   * or handle under the pointer lights up.
   *
   * The element under the pointer gets it, so the first one after the
   * pointer arrives is also the enter. Not delivered while a pointer
   * capture is in force: that motion belongs to the gesture, and
   * `defaultMouseDrag` is where it goes.
   */
  defaultMouseMove?(ev: MouseEvent): void;
  /** The pointer left this element — clear what `defaultMouseMove` lit. A
   * node that unmounts while hovered is *forgotten* rather than left, the
   * way focus is, so a subtree torn down under the pointer never sees it. */
  defaultMouseLeave?(ev: MouseEvent): void;
  /**
   * The wheel over this element, before the scroll chain gets it: a pane
   * whose wheel is a zoom about the pointer rather than a scroll, which
   * needs `ev.x`/`ev.y` and the modifiers as much as the deltas.
   *
   * `ev.preventDefault()` consumes it, and the chain then never runs — the
   * answer for a gesture that is handled whether or not anything moved. An
   * element whose wheel really is a scroll implements `canScroll`/`scrollBy`
   * instead and joins the chain. Deltas are pixels, fractional where the
   * device measured a fraction: the whole-pixel rule is the chain's.
   */
  defaultWheel?(ev: WheelEvent): void;
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
  /** Whether dead keys and Compose run while this element has focus.
   * Defaults to on. Set it false for an element that forwards raw key
   * events to something with an input method of its own — `<foreign>` does,
   * and composing on this side would swallow the dead key on its way to the
   * embedded client. */
  composes?: boolean;
  /** The cursor to show over this element when nothing in the style says
   * otherwise — `'text'` for something editable. A `cursor` style wins. */
  defaultCursor?: string;
  /**
   * The ARIA role this element is when the application writes none — the
   * registered-element counterpart of `<textinput>` defaulting to
   * `textbox`. A `role` prop still wins, and an unknown name warns in
   * development. Assign it in the constructor.
   */
  a11yRole?: string;
  /**
   * What text this element holds, for the AT-SPI `Text` interface and the
   * test spy (docs/accessibility.md). `null` when it holds none. Implement
   * it and an editor, a viewer or a terminal is readable, navigable and
   * announced through the same paths `<textinput>` uses.
   *
   * Called several times per change, so answer from state the element
   * already holds — never a shaping pass or a copy of a buffer.
   */
  a11yTextState?(): A11yTextState | null;
  /**
   * An assistive technology moved the caret or the selection: `start` and
   * `end` are code-point offsets into the reported `value`, and the caret
   * belongs at `end`. Return false to refuse. Without it an AT can read
   * this element but not navigate it.
   */
  a11ySetSelection?(start: number, end: number): boolean;
  /**
   * An assistive technology edited the text: replace `[start, end)` with
   * `text`. Insert, delete and replace-everything all arrive here. Only an
   * element that implements this exposes AT-SPI's `EditableText`, so an
   * editor without it is read but never typed into.
   */
  a11yReplaceText?(start: number, end: number, text: string): boolean;
  /**
   * The text reported by `a11yTextState()` may have moved — an edit, a
   * caret move, a selection change, a composition. Free when no assistive
   * technology is listening, so call it from every path that changes the
   * text rather than guarding it.
   */
  notifyA11yTextChanged(): void;
  /**
   * The interactive things this element draws, as accessible children
   * (docs/extending.md). Without it a scene of any size is one accessible
   * — "Flow graph, group" — and nothing in it can be found, named or
   * activated.
   *
   * Called once per question asked about this element's children, so
   * answer from state the element already holds: no layout pass, no copy.
   */
  a11yScene?(): A11ySceneItem[];
  /**
   * An assistive technology acted on one of them: `id` is the one this
   * element gave it. Return `true` to claim the action; anything else
   * falls back to core — a synthetic click at the item's rect for
   * `activate`, focusing the element for `focus`, revealing the element
   * for `scroll` — so an element only answers what it has a better answer
   * for.
   */
  a11ySceneAction?(id: string, action: A11ySceneAction): boolean | void;
  /**
   * The scene reported by `a11yScene()` has changed — an item added or
   * removed, one selected, the keyboard cursor moved. A commit re-reads it
   * on its own, so this is for what the element does between commits: a
   * drag, an animation, its own arrow keys. Free when nothing is
   * listening.
   */
  notifyA11ySceneChanged(): void;
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
  /** React Native's measure contract — position in the parent, size, then
   * position in the window — which DevTools' style editor calls to draw
   * the box model. Calls back with nothing for a node with no laid-out
   * rect. */
  measure(
    callback: (
      x?: number,
      y?: number,
      width?: number,
      height?: number,
      left?: number,
      top?: number,
    ) => void,
  ): void;
}

/**
 * Scrolling as a mixin: `class Pane extends Scrollable(Node)` gives a
 * registered element the same `overflow: 'scroll'` behaviour `<box>` and
 * `<window>` have — wheel, keys, bars, and the AT-SPI scroll-pane role.
 *
 * An element whose content is **painted rather than laid out** overrides
 * `measureScrollContent`; everything else follows from the numbers it
 * returns. See docs/extending.md.
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
    /** Chain membership: has this node room to move on the axis the delta
     * names? The wheel asks it before scrolling this node rather than the
     * next one out. */
    canScroll(dx: number, dy: number): boolean;
    /** How far the content reaches. The default walks the children;
     * override it when the content is pixels this element paints. */
    measureScrollContent(): { width: number; height: number };
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
/** The precedents for an element owning a real child X window — a surface of
 * its own, and one holding somebody else's window. */
export declare class GlAreaNode extends Node {}
export declare class ForeignNode extends Node {}

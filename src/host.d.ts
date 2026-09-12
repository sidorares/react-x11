/**
 * `react-x11/host` — add a host element from outside the package.
 *
 * The element also has to be declared to JSX, which is module augmentation
 * against `react-x11/jsx-runtime` (see docs/typescript.md and
 * docs/extending.md):
 *
 * ```ts
 * declare module 'react-x11/jsx-runtime' {
 *   namespace JSX {
 *     interface IntrinsicElements {
 *       sparkline: { data: number[]; stroke?: string; style?: Style };
 *     }
 *   }
 * }
 * ```
 */
import type { Node } from './node.js';
import type { NtkApp } from './types/nodes.js';

export interface HostContext {
  isInsideText: boolean;
  isInsideSvg: boolean;
}

export interface ElementDefinition {
  /**
   * Build the node. `app` is the ntk connection the tree renders through —
   * the second argument every built-in node constructor takes. Must return
   * a `Node` whose `kind` is the registered element name.
   */
  create(
    props: Record<string, unknown>,
    app: NtkApp,
    hostContext: HostContext,
  ): Node;
  /**
   * Lays out with yoga and paints into the owning window (default true).
   * `false` is for a node owning a real child X window instead — see
   * `GlAreaNode`.
   */
  drawn?: boolean;
  /**
   * Prop names this element owns even though they are also style names, so
   * `<sparkline stroke="red">` is not reported as a flat style prop in
   * development.
   */
  semanticNames?: string[];
  /**
   * Prop names whose damage this element's own `applyProps` claims — so a
   * commit that changes one of them contributes no damage of its own,
   * instead of widening the frame to the whole node.
   *
   * For an element that draws a **scene** into one node: a graph view handed
   * a new `nodes` array per drag step invalidates the box the dragged node
   * moved through, and without this the commit claims the whole pane over
   * the top of it. Everything left out keeps core's conservative answer, and
   * an element that names a prop it does not actually claim shows stale
   * pixels — see `Node.paintChanged` and docs/extending.md.
   */
  selfDamagedProps?: string[];
  /** Reject children, naming this element, instead of laying out something
   * that will never paint. Default true. */
  childrenAllowed?: boolean;
  /** Replace an existing registration. Off by default. */
  override?: boolean;
}

export function registerElement(
  type: string,
  definition: ElementDefinition,
): void;

/** Undo a registration; true if there was one. */
export function unregisterElement(type: string): boolean;

/** Registered element names, in registration order. */
export function registeredElements(): string[];

/** The built-in element names (a copy). */
export function hostTypes(): string[];

/** Every element name currently known, built-in and registered. */
export function knownElements(): string[];

/** Kinds that lay out with yoga and paint into the owning window (a copy). */
export function drawnKinds(): string[];

// --- layouts and positions (docs/extending.md) ------------------------------

/**
 * What an option of a layout or a position may be. A `'length'` is written
 * in logical pixels, like every length in a style, and handed to the
 * algorithm in device pixels. An array is the values the option may take.
 */
export type OptionType =
  | 'length'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'string'
  | 'any'
  | readonly (string | number | boolean)[];

export interface OptionSpec {
  type: OptionType;
  default?: unknown;
}

/** The options a layout or a position takes, by name. */
export type OptionSchema = Record<string, OptionSpec>;

export type MeasureMode = 'exactly' | 'at-most' | 'unconstrained';

/** The room on offer, in the vocabulary `measureContent` speaks: device
 *  pixels, and `Infinity` on an axis with no bound. */
export interface LayoutConstraints {
  width: number;
  height: number;
  widthMode: MeasureMode;
  heightMode: MeasureMode;
}

/**
 * A child, as a layout algorithm sees it: something to measure and read
 * options off, never a node. Every size is the child's **margin box**, in
 * device pixels.
 */
export interface LayoutChild {
  /** Where it is in the list the algorithm was handed. */
  readonly index: number;
  /** Its `layoutItem`, against the layout's `childOptions`: defaults filled
   *  in, lengths in device pixels. */
  readonly options: Readonly<Record<string, any>>;
  /**
   * The size it takes under `constraints`. An axis given a number and no
   * mode is `'exactly'` that; an axis left out is `'unconstrained'`;
   * `'at-most'` is CSS's fit-content, never below its content floor.
   */
  measure(constraints?: Partial<LayoutConstraints>): {
    width: number;
    height: number;
  };
  /** The narrowest it can be drawn at — its content floor — and the width
   *  it would take with no bound at all. */
  intrinsicSizes(): { minContentWidth: number; maxContentWidth: number };
  /** Its own resolved style, in device pixels — what a grid places it by
   *  (`gridColumn`, `gridArea`) and aligns it with (`alignSelf`,
   *  `justifySelf`). */
  readonly style: Readonly<import('./types/style.js').StyleProperties>;
}

/** Where one child goes, from the content box's corner. A `width` or
 *  `height` left out is the child's own. */
export interface LayoutRect {
  x: number;
  y: number;
  width?: number;
  height?: number;
}

export interface LayoutResult {
  /** The content box's size, device pixels. */
  width: number;
  height: number;
  /** One rect per child — required of the call that places, the one with
   *  both modes `'exactly'`. */
  children?: readonly LayoutRect[];
}

export interface LayoutInfo {
  /** The box's own resolved style — `gap`, `justifyContent`, `alignItems`
   *  — in device pixels. */
  style: Readonly<import('./types/style.js').StyleProperties>;
  scale: number;
  /**
   * Say that something in the style is wrong but can be laid out around —
   * a grid area nobody named — the way a bad style value is said: once,
   * on the console and to the test harness. `consequence` is what happens
   * instead. A throw is for what cannot be laid out at all.
   */
  report(message: string, consequence: string): void;
}

export interface LayoutDefinition {
  options?: OptionSchema;
  /** What a child's `layoutItem` may say to this layout. */
  childOptions?: OptionSchema;
  /**
   * How big the box's content is for `constraints` — asked several times
   * per pass, so a pure function of its arguments — and, when both modes
   * are `'exactly'`, where each child goes.
   */
  layout(
    children: readonly LayoutChild[],
    constraints: LayoutConstraints,
    options: Readonly<Record<string, any>>,
    info: LayoutInfo,
  ): LayoutResult;
  /** Replace an existing registration. Off by default. */
  override?: boolean;
}

/** Teach react-x11 a layout algorithm, for `style={{ layout: name }}`
 *  (docs/extending.md, "A layout algorithm of your own"). */
export function registerLayout(
  name: string,
  definition: LayoutDefinition,
): void;

/** Undo a registration; true if there was one. The built-in layouts stay. */
export function unregisterLayout(name: string): boolean;

/** Registered layout names, the built-in ones first. */
export function registeredLayouts(): string[];

export interface Edges {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** What a position's `place` is handed: window coordinates, device
 *  pixels, the space `abs` is in. */
export interface PositionContext {
  /** Where layout put the node, before any placement moved it. */
  laidOut: { x: number; y: number; width: number; height: number };
  /** The nearest scroll pane above the node — its scrollport is inside its
   *  border and over its padding — or null when nothing above scrolls. */
  pane: { scrollport: Edges; scrollX: number; scrollY: number } | null;
  /** The box it is contained by: its parent's content box, or the whole
   *  scrolled content for a direct child of the pane. */
  container: Edges;
  margin: Edges;
  direction: 'ltr' | 'rtl';
  scale: number;
  /** The frame clock, in ms. */
  now: number;
  options: Readonly<Record<string, any>>;
}

export interface PositionDefinition {
  options?: OptionSchema;
  /**
   * How far to move the node from where layout put it, or null for not at
   * all. `again: true` asks for another frame, for a position that
   * animates. Runs after every layout pass; resizes nothing.
   */
  place(
    node: Node,
    context: PositionContext,
  ): { x: number; y: number; again?: boolean } | null;
  /** Replace an existing registration. Off by default. */
  override?: boolean;
}

/** Teach react-x11 a positioning scheme, for `style={{ position: name }}`
 *  (docs/extending.md, "A position of your own"). CSS's own names —
 *  `static`, `relative`, `absolute`, `fixed`, `sticky` — are not available. */
export function registerPosition(
  name: string,
  definition: PositionDefinition,
): void;

/** Undo a registration; true if there was one. */
export function unregisterPosition(name: string): boolean;

/** Registered position names, in registration order. */
export function registeredPositions(): string[];

/**
 * The layouts a style can name, each with the options it takes. Augment it
 * to add yours:
 *
 * ```ts
 * declare module 'react-x11/host' {
 *   interface CustomLayouts {
 *     radial: { radius?: number };
 *   }
 * }
 * ```
 */
export interface CustomLayouts {
  masonry: { columns?: number; columnWidth?: number };
  'equal-row': Record<never, never>;
  /** CSS grid — `layout: 'grid'` is `display: 'grid'`. It takes no options:
   *  its tracks are the box's own style, `gridTemplateColumns` and the rest. */
  grid: Record<never, never>;
}

/** What a child's `layoutItem` may tell the layout arranging it — augmented
 *  the same way. */
export interface CustomLayoutItem {
  /** `masonry`: how many columns the child is laid across. */
  span?: number;
}

/** The registered positions a style can name, each with its options —
 *  augmented the same way as `CustomLayouts`. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface CustomPositions {}

/** A layout, by name or written with its options. */
export type LayoutValue = {
  [K in keyof CustomLayouts]: K | ({ name: K } & CustomLayouts[K]);
}[keyof CustomLayouts];

/** CSS's positions, and the registered ones by name or with their options. */
export type PositionValue =
  | 'static'
  | 'relative'
  | 'absolute'
  | 'sticky'
  | {
      [K in keyof CustomPositions]: K | ({ name: K } & CustomPositions[K]);
    }[keyof CustomPositions];

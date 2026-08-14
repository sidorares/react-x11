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
  isInsideRichText: boolean;
  isInside3d: boolean;
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

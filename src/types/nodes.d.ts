/**
 * What a `ref` gives you. Drawn elements hand back their retained node;
 * `<window>` and `<popup>` hand back the live ntk `Window`, so the whole
 * ntk API is available from a ref.
 */

/** A rectangle within the owning window, valid after layout. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The retained node behind a drawn element. */
export interface DrawnNode {
  /** Element name — `'box'`, `'text'`, and the name a registered element
   * was registered under. What queries and paint order match on:
   * `screen.all((n) => n.kind === 'gauge')`. */
  readonly kind: string;
  /** Position and size within the owning window, valid after layout. */
  readonly abs: Rect;
  readonly parent: DrawnNode | null;
  readonly children: readonly DrawnNode[];
  /** Take the keyboard focus, if this node is focusable. Returns the node,
   * so a component can hand it straight out of an imperative handle. */
  focus(): this;
  blur(): this;
  /** Whether this node has the owning window's focus. */
  readonly focused: boolean;
  /** Whether focus is on this node or inside it — CSS `:focus-within`. */
  readonly focusWithin: boolean;
  /**
   * Which way this node reads, resolved — `'ltr'` or `'rtl'`, never
   * `'inherit'`. The `direction` style property here or on the nearest
   * element above, and the palette's under all of them.
   *
   * What a widget measuring a pointer against a laid-out box has to ask: a
   * coordinate means the opposite thing in the two directions, so a drag
   * reads this rather than the theme.
   */
  readonly direction: 'ltr' | 'rtl';
  /** Whether `node` is this node or a descendant of it (DOM `contains`). */
  contains(node: DrawnNode | null): boolean;
  getClientRects(): Rect[];
}

export interface ScrollTarget {
  x?: number;
  y?: number;
}

/**
 * What a `<box>` ref is: a drawn node that also scrolls. The scrolling half
 * is live only while the node's style says `overflow: 'scroll'` — before
 * that `scrollTo` has nowhere to go and the offsets stay 0.
 */
export interface ScrollableNode extends DrawnNode {
  readonly scrollX: number;
  readonly scrollY: number;
  readonly contentWidth: number;
  readonly contentHeight: number;
  /** A number scrolls the vertical axis; an object moves either or both. */
  scrollTo(to: number | ScrollTarget): void;
  scrollBy(by: number | ScrollTarget): void;
  /**
   * Scroll the minimum amount on both axes that makes a descendant fully
   * visible. Safe to call right after that node mounts — the request is
   * resolved on the next layout pass, when it has geometry.
   */
  scrollIntoView(node: DrawnNode): void;
}

/** `<textinput>` / `<textarea>`. */
export interface TextInputNode extends DrawnNode {
  /**
   * The control's current text. Inside an `onChange` handler this is the
   * value the edit produced, even in controlled mode — which is what makes
   * `ev.target.value` mean what a DOM form library expects it to.
   *
   * Writable, as a DOM input's `value` is: assigning sets the text without
   * firing `onChange`, and on a controlled input the next render puts
   * `props.value` back. react-hook-form's `register()` resets a field this
   * way.
   */
  value: string;
  /** The `name` prop, for form libraries that key fields by it. */
  readonly name?: string;
  /**
   * Step back one edit, as Ctrl+Z does. False when there is nothing to
   * undo. Controlled inputs report the restored value through `onChange`,
   * so the display follows the same round trip typing does.
   */
  undo(): boolean;
  /** Step forward one undone edit, as Ctrl+Shift+Z does. */
  redo(): boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

/**
 * ntk's `Window`, as handed back by a `<window>` or `<popup>` ref. This
 * covers what a react-x11 program usually reaches for; ntk has more (see
 * its docs/window.md), and the index signature keeps the rest reachable
 * without pretending this is a full description of the class.
 */
export interface NtkWindow {
  readonly id: number;
  width: number;
  height: number;
  x: number;
  y: number;
  map(): void;
  unmap(): void;
  raise(): NtkWindow;
  lower(): NtkWindow;
  move(x: number, y: number): void;
  resize(width: number, height: number): void;
  moveResize(x: number, y: number, width: number, height: number): void;
  setTitle(title: string): NtkWindow;
  setCursor(name: string | null): NtkWindow;
  focus(revertTo?: number): NtkWindow;
  getContext(name: '2d' | 'opengl' | 'x11', ...args: unknown[]): unknown;
  requestAnimationFrame(cb: (time: number) => void): number;
  cancelAnimationFrame(id: number): void;
  destroy(): void;
  on(event: string, handler: (...args: any[]) => void): unknown;
  off?(event: string, handler: (...args: any[]) => void): unknown;
  [key: string]: any;
}

/**
 * An ntk `App` — the X connection. `createRoot()` makes one for you; pass
 * your own to render into an existing connection.
 */
export interface NtkApp {
  readonly X: any;
  readonly display: any;
  createWindow(args?: Record<string, unknown>): NtkWindow;
  rootWindow(screen?: number): NtkWindow;
  close(): Promise<void>;
  [key: string]: any;
}

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
  /** Element name — `'box'`, `'text'`, … */
  readonly type: string;
  /** Position and size within the owning window, valid after layout. */
  readonly abs: Rect;
  readonly parent: DrawnNode | null;
  readonly children: readonly DrawnNode[];
  /** Take the keyboard focus, if this node is focusable. */
  focus(): void;
  blur(): void;
  getClientRects(): Rect[];
}

export interface ScrollTarget {
  x?: number;
  y?: number;
}

/** `<scrollview>`: a node that also scrolls. */
export interface ScrollViewNode extends DrawnNode {
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
  readonly value: string;
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

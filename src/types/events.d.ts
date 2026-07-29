/**
 * Synthetic events. Dispatched capture → target → bubble over the drawn
 * tree by front-to-back hit testing, the same shape React gives you in the
 * DOM. See docs/events.md.
 */

import type { DrawnNode } from './nodes.js';

/** The raw ntk/X11 event a synthetic one was made from. */
export interface NativeEvent {
  /** X event type number. */
  type: number;
  name?: string;
  /** Window-relative pointer position. */
  x: number;
  y: number;
  /** Screen coordinates — what you anchor a `<popup>` at. */
  rootx: number;
  rooty: number;
  /** X modifier/button mask. */
  buttons: number;
  keycode?: number;
  codepoint?: number;
  time?: number;
  [key: string]: unknown;
}

export interface SyntheticEvent<T = DrawnNode> {
  type: string;
  /** The node the event was dispatched at (the public instance). */
  target: T;
  /** The node whose handler is running. */
  currentTarget: T | null;
  /** Window coordinates. */
  x: number;
  y: number;
  /** Coordinates relative to `target`'s box. */
  localX: number;
  localY: number;
  nativeEvent: NativeEvent;
  shiftKey: boolean;
  ctrlKey: boolean;
  defaultPrevented: boolean;
  propagationStopped: boolean;
  /** Suppress the element's built-in behaviour (editing, wheel scrolling…). */
  preventDefault(): void;
  stopPropagation(): void;
  /**
   * Route the rest of this gesture's `mousemove`/`mouseup` to this node even
   * once the pointer leaves it. Released on mouseup and on unmount.
   */
  capturePointer(): void;
  releasePointer(): void;
}

export interface MouseEvent<T = DrawnNode> extends SyntheticEvent<T> {
  /** X button number: 1 left, 2 middle, 3 right. */
  button: number;
  /** DOM-style click count — 2 is a double click, 3 a triple. */
  detail: number;
}

export interface WheelEvent<T = DrawnNode> extends SyntheticEvent<T> {
  deltaX: number;
  deltaY: number;
}

export interface KeyboardEvent<T = DrawnNode> extends SyntheticEvent<T> {
  /** X keycode. */
  keycode: number;
  /** X keysym (`XK_*`), or undefined if the map has no entry. */
  keysym?: number;
  /** Unicode code point, 0 when the key produces no character. */
  codepoint: number;
  /** The character the key produced, `''` for non-printing keys. */
  key: string;
}

export interface FocusEvent<T = DrawnNode> extends SyntheticEvent<T> {}

/** `<scrollview onScroll>`. */
export interface ScrollEvent {
  scrollX: number;
  scrollY: number;
  contentWidth: number;
  contentHeight: number;
  viewportWidth: number;
  viewportHeight: number;
}

/** `<scrollview onViewport>` — fired from layout, not from scrolling. */
export interface ViewportEvent {
  width: number;
  height: number;
  contentWidth: number;
  contentHeight: number;
}

/** Handlers every drawn element and `<window>` accepts. */
export interface PointerHandlers<T = DrawnNode> {
  onClick?: (ev: MouseEvent<T>) => void;
  onClickCapture?: (ev: MouseEvent<T>) => void;
  onMouseDown?: (ev: MouseEvent<T>) => void;
  onMouseDownCapture?: (ev: MouseEvent<T>) => void;
  onMouseUp?: (ev: MouseEvent<T>) => void;
  onMouseUpCapture?: (ev: MouseEvent<T>) => void;
  onMouseMove?: (ev: MouseEvent<T>) => void;
  onMouseMoveCapture?: (ev: MouseEvent<T>) => void;
  /** Does not propagate — synthesized by hover-path diffing. */
  onMouseEnter?: (ev: MouseEvent<T>) => void;
  onMouseLeave?: (ev: MouseEvent<T>) => void;
  onWheel?: (ev: WheelEvent<T>) => void;
  onWheelCapture?: (ev: WheelEvent<T>) => void;
  /**
   * Right-click (button 3), dispatched after `onMouseDown` — so suppressing
   * the menu does not also give up whatever mousedown did. `preventDefault()`
   * skips the element's own menu, which today means the edit menu on
   * `<textinput>` and `<textarea>`.
   */
  onContextMenu?: (ev: MouseEvent<T>) => void;
  onContextMenuCapture?: (ev: MouseEvent<T>) => void;
}

export interface KeyboardHandlers<T = DrawnNode> {
  onKeyDown?: (ev: KeyboardEvent<T>) => void;
  onKeyDownCapture?: (ev: KeyboardEvent<T>) => void;
  onKeyUp?: (ev: KeyboardEvent<T>) => void;
  onKeyUpCapture?: (ev: KeyboardEvent<T>) => void;
}

export interface FocusHandlers<T = DrawnNode> {
  onFocus?: (ev: FocusEvent<T>) => void;
  onBlur?: (ev: FocusEvent<T>) => void;
}

export interface EventHandlers<T = DrawnNode>
  extends PointerHandlers<T>, KeyboardHandlers<T>, FocusHandlers<T> {}

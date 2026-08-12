/**
 * Synthetic events. Dispatched capture → target → bubble over the drawn
 * tree by front-to-back hit testing, the same shape React gives you in the
 * DOM. See docs/events.md.
 */

import type { DrawnNode, NtkWindow, TextInputNode } from './nodes.js';

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
  /**
   * X11 Mod1 — Alt on virtually every keymap, but a convention rather than
   * a rule of the protocol. `nativeEvent.buttons` has the raw mask for a
   * setup that remaps it.
   */
  altKey: boolean;
  /** X11 Mod4 — Super, under the DOM's name for it. Same caveat as `altKey`. */
  metaKey: boolean;
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
  /** Pixels, positive right — one notch of the wheel is 48 of them. */
  deltaX: number;
  /** Pixels, positive down. Fractions of a notch where `smooth`. */
  deltaY: number;
  /**
   * Whether the device measured this scroll rather than clicked it: XI2's
   * scroll valuators (a touchpad, a high-resolution wheel) can report a
   * fraction of a notch, the emulated buttons 4-7 can only ever say one.
   */
  smooth: boolean;
}

export interface KeyboardEvent<T = DrawnNode> extends SyntheticEvent<T> {
  /** X keycode. */
  keycode: number;
  /**
   * X keysym (`XK_*`), or undefined if the map has no entry — **the Latin
   * one**, so a shortcut keeps matching while another layout is typing.
   * `ev.key`/`ev.codepoint` are what the key produced; this is what it is
   * called. See "Layouts" in docs/events.md, and
   * `createRoot({ accelerators })` to turn the resolution off.
   */
  keysym?: number;
  /** Which XKB layout group typed this, 0-3. A layout switch moves the
   * group and sends no other notice. */
  group: number;
  /** Unicode code point, undefined when the key produces no character —
   * which includes every key a composition took (see `composing`). */
  codepoint?: number;
  /** The character the key produced, undefined for non-printing keys and
   * for keys a composition took. */
  key?: string;
  /** Whether this key belongs to an open composition — a dead key, or a key
   * of a Compose sequence. Its text arrives on the composition events
   * instead, so a handler that types from `onKeyDown` should skip it. */
  composing: boolean;
}

/**
 * A composition — text the user is still typing. `onCompositionStart` has
 * no data, `onCompositionUpdate` carries what is showing at the caret, and
 * `onCompositionEnd` carries the text that was committed (empty when the
 * sequence was abandoned).
 */
export interface CompositionEvent<T = DrawnNode> extends SyntheticEvent<T> {
  data: string;
}

export interface FocusEvent<T = DrawnNode> extends SyntheticEvent<T> {}

/** What a drop target's `dropAccept` prop takes: an exact type name
 * (`'image/png'`), a semantic group (`'files' | 'uris' | 'text'`), an
 * array of either, or a predicate over the offered names. Absent means
 * the node accepts anything — a bare `onDrop` is a valid dropzone. */
export type DropAccept = string | string[] | ((types: string[]) => boolean);

export type DropAction = 'copy' | 'move' | 'link' | 'ask' | 'private';

/**
 * A drag over a drop target (`onDragEnter` / `onDragOver` /
 * `onDragLeave`). Enter/leave do not bubble, like their mouse
 * counterparts; `onDragOver` dispatches capture → target → bubble.
 */
export interface DragEvent<T = DrawnNode> extends SyntheticEvent<T> {
  /** Offered payload type names, e.g. `['text/uri-list', 'text/plain']`. */
  types: string[];
  /** Alias-aware membership test: a concrete type or a semantic group. */
  has(type: string): boolean;
  /** The action the source asked for. `'ask'` means it wants the user
   * offered a choice — see `actions`. */
  action: DropAction;
  /** The actions an `'ask'` source will accept, in the order it listed
   * them. Empty for every other action, which is all but a few file
   * managers. */
  actions: Array<'copy' | 'move' | 'link'>;
  /** The source's own words for `actions`, positionally matched, with
   * `null` where it offered none. Empty when `actions` is. */
  actionDescriptions: Array<string | null>;
  /** Where the drag came from: another application, or this one. */
  source: 'internal' | 'external';
  /** Pointer position in screen (root) coordinates. */
  screenX: number;
  screenY: number;
  /** Override the declarative `dropAccept` answer for this position
   * (`onDragOver`), or settle what the drop actually did (`onDrop`, where
   * `accept` picks the action reported to the source and `reject` tells it
   * the drop was not taken after all). Inert elsewhere. */
  accept(action?: 'copy' | 'move' | 'link'): void;
  reject(): void;
  /** Opt into the XdndStatus suppression rectangle for this node's rect:
   * the source stops sending positions while the pointer stays inside.
   * Do not freeze a zone that draws per-position feedback (insertion
   * carets, edge auto-scroll). */
  freeze(): void;
}

/** The drop itself (`onDrop`). The common payloads are prefetched —
 * `files` and `text` read synchronously; everything else is behind
 * `getData`. There is deliberately no `dataTransfer`: X selection
 * transfer is asynchronous, and a sync-looking `getData` would return
 * `"[object Promise]"` silently. */
export interface DropEvent<T = DrawnNode> extends DragEvent<T> {
  /** One conversion of the drag payload. Text-ish targets decode to a
   * string; anything else stays raw bytes. Semantic groups resolve to
   * the first concretely offered member. */
  getData(type: string): Promise<Uint8Array | string>;
  /** Parsed `text/uri-list` (RFC 2483). `path` is present only for
   * genuinely local `file:` URIs. Empty when no file flavour was
   * offered. */
  files: Array<{ uri: string; path?: string }>;
  /** The best offered text flavour, when there was one. */
  text?: string;
  /** Internal drags only: the dragData values by type name, live — no
   * serialisation happened. Absent for drops from other applications. */
  items?: Record<string, unknown>;
}

/** A drag *source*'s events (`onDragStart` / `onDrag` / `onDragEnd`).
 * `source` and `accepted` describe the transport and the current target's
 * answer; `screenX/screenY` are where the pointer is, in root coordinates
 * — what a preview `<popup>` follows. */
export interface DragSourceEvent<T = DrawnNode> extends SyntheticEvent<T> {
  types: string[];
  action: DropAction;
  source: 'internal' | 'external';
  screenX: number;
  screenY: number;
  /** Whether whatever is under the pointer currently accepts the drop. */
  accepted?: boolean;
}

/** `onDragEnd`: `action` is what the drop performed, or null when the drag
 * ended nowhere (or was rejected). */
export interface DragEndEvent<T = DrawnNode> extends Omit<
  DragSourceEvent<T>,
  'action'
> {
  action: DropAction | null;
  dropped: boolean;
}

/**
 * The props that make a node draggable. `dragData` maps payload type names
 * to values: strings and bytes are served as-is, thunks are resolved
 * lazily (at delivery for an in-app drop, at promotion for an external
 * one), and any other live value reaches in-app drops by reference
 * (`e.items`) but is JSON-serialised for the wire.
 */
export interface DragSourceProps<T = DrawnNode> {
  draggable?: boolean;
  dragData?: Record<
    string,
    string | Uint8Array | (() => string | Uint8Array | unknown) | unknown
  >;
  /** Offered actions, preferred first. Defaults to `['copy']`. */
  dragActions?: Array<'copy' | 'move' | 'link'>;
  /** Fires past the drag threshold; `preventDefault()` cancels the drag
   * (the gesture continues as plain mouse events). */
  onDragStart?: (ev: DragSourceEvent<T>) => void;
  /** Per motion while dragging — the source-side mirror of onDragOver. */
  onDrag?: (ev: DragSourceEvent<T>) => void;
  onDragEnd?: (ev: DragEndEvent<T>) => void;
}

/** The props that make a node a drop target. Any drawn element and
 * `<window>`/`<popup>` accept them; their presence registers the node
 * with the XDND router (see docs/events.md). */
export interface DropTargetProps<T = DrawnNode> {
  dropAccept?: DropAccept;
  /** Does not propagate — synthesized by drag-path diffing, and paired
   * with the `':drag-over'` style state. */
  onDragEnter?: (ev: DragEvent<T>) => void;
  onDragLeave?: (ev: DragEvent<T>) => void;
  onDragOver?: (ev: DragEvent<T>) => void;
  onDragOverCapture?: (ev: DragEvent<T>) => void;
  /** May be async: XdndFinished is held until the returned promise
   * settles (or a ~10 s watchdog fires, so a forgotten await cannot hang
   * the source application's gesture). */
  onDrop?: (ev: DropEvent<T>) => void | Promise<void>;
  onDropCapture?: (ev: DropEvent<T>) => void | Promise<void>;
}

/**
 * `<textinput onChange>` / `<textarea onChange>`. The value is on both
 * `ev.value` and `ev.target.value` — the second is what every DOM form
 * library reads, and it is the *new* value even in controlled mode, where
 * `props.value` is still the old string until the parent re-renders.
 *
 * `nativeEvent` is the X key event when a keystroke drove the edit, and null
 * when nothing did — a paste resolving, an undo, a value the parent pushed
 * back. Guard it.
 */
export interface ChangeEvent<T = TextInputNode> extends Omit<
  SyntheticEvent<T>,
  'nativeEvent'
> {
  type: 'change';
  value: string;
  /** The control's `name` prop, mirrored from `target.name`. */
  name?: string;
  nativeEvent: NativeEvent | null;
}

/**
 * `<textinput onSubmit>` — Enter, or Ctrl+Enter in a `<textarea>`. Same
 * shape as {@link ChangeEvent}; `nativeEvent` is the X key event.
 */
export interface SubmitEvent<T = TextInputNode> extends Omit<
  ChangeEvent<T>,
  'type'
> {
  type: 'submit';
}

/** `<box onScroll>` — a scrolling box or window moved. */
export interface ScrollEvent {
  scrollX: number;
  scrollY: number;
  contentWidth: number;
  contentHeight: number;
  viewportWidth: number;
  viewportHeight: number;
}

/** `<box onViewport>` — fired from layout, not from scrolling. */
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
  /**
   * A composition opened — a dead key was pressed, or the Compose key was.
   * `preventDefault()` on any of the three stops the element acting on it,
   * which for `<textinput>` means showing or committing the text.
   */
  onCompositionStart?: (ev: CompositionEvent<T>) => void;
  onCompositionStartCapture?: (ev: CompositionEvent<T>) => void;
  /** The composition changed: `data` is what is showing at the caret. */
  onCompositionUpdate?: (ev: CompositionEvent<T>) => void;
  onCompositionUpdateCapture?: (ev: CompositionEvent<T>) => void;
  /** The composition finished: `data` is the text it produced, empty if it
   * was abandoned. */
  onCompositionEnd?: (ev: CompositionEvent<T>) => void;
  onCompositionEndCapture?: (ev: CompositionEvent<T>) => void;
}

export interface FocusHandlers<T = DrawnNode> {
  onFocus?: (ev: FocusEvent<T>) => void;
  onBlur?: (ev: FocusEvent<T>) => void;
}

export interface EventHandlers<T = DrawnNode>
  extends
    PointerHandlers<T>,
    KeyboardHandlers<T>,
    FocusHandlers<T>,
    DropTargetProps<T>,
    DragSourceProps<T> {}

/**
 * `<window onResize>`: X's ConfigureNotify, handed over as ntk's own event
 * object rather than a synthetic one — there is no capture/bubble phase and
 * nothing to `preventDefault`, because the window manager has already done
 * the thing being reported.
 *
 * It fires for **moves and reparents** as much as for size changes; see
 * docs/elements.md. `x`/`y` are relative to whatever the window's parent is,
 * which is the window manager's frame once it has framed the window — not
 * screen coordinates.
 */
export interface WindowResizeEvent {
  /** X event type number (22, ConfigureNotify). */
  type: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** The size differs from the last delivered event's. */
  resized: boolean;
  /** The position does. */
  moved: boolean;
  /**
   * The geometry `moved`/`resized` are measured against, or null when none
   * is known yet.
   */
  previous: { x: number; y: number; width: number; height: number } | null;
  /** Every raw event merged into this one, oldest first. */
  coalesced?: WindowResizeEvent[];
  window: NtkWindow;
  target: NtkWindow;
}

/**
 * `<window onClientMessage>`: a ClientMessage addressed to this window —
 * EWMH, XEmbed, the system tray, or a convention two copies of one
 * application agreed between themselves.
 *
 * Not a synthetic event: a ClientMessage is addressed to a *window*, so
 * there is no node under it, nothing to hit test and no chain to bubble
 * along. Delivered in arrival order, which the chunked protocols depend on.
 */
export interface ClientMessageEvent {
  /** X event type number (33, ClientMessage). */
  type: number;
  /**
   * The message type atom's **name** — `'_NET_SYSTEM_TRAY_OPCODE'`,
   * `'_XEMBED'`, `'WM_PROTOCOLS'` — which is what a handler branches on.
   *
   * `null` for an atom this connection has never named. An application
   * acting on a protocol has interned its atoms already, so that is the
   * passive-observer case rather than a coin flip; {@link atom} is exact
   * either way.
   */
  messageType: string | null;
  /** The message type atom id, as it arrived. */
  atom: number;
  /** How wide the 20 payload bytes are read. */
  format: 8 | 16 | 32;
  /** 5 values at format 32, 10 at 16, 20 at 8. */
  data: number[];
  /** The window it was delivered to. */
  window: NtkWindow;
  target: NtkWindow;
  /** ntk's raw event. */
  nativeEvent: unknown;
  defaultPrevented: boolean;
  /**
   * Stop react-x11 acting on this message itself — which today means XDND,
   * for a window answering the drag protocol on its own terms. It does not
   * reach the WM close button; `onCloseRequest` is that seam.
   */
  preventDefault(): void;
}

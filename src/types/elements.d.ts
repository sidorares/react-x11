/**
 * The host elements. Only `<window>`, `<popup>`, `<glarea>` and `<foreign>`
 * are real X11 windows; everything else is a retained node laid out by yoga
 * and painted into the owning window. See docs/elements.md.
 */

import type { Ref, RefObject, ReactNode, Key } from 'react';
import type { Color, Cursor, StyleProp } from './style.js';
import type {
  DrawnNode,
  NtkWindow,
  ScrollableNode,
  TextInputNode,
} from './nodes.js';
import type { AnchorOptions } from './components.js';
import type {
  ChangeEvent,
  SelectionChangeEvent,
  ClientMessageEvent,
  EventHandlers,
  MouseEvent,
  ScrollEvent,
  SubmitEvent,
  SyntheticEvent,
  ViewportEvent,
  WindowResizeEvent,
} from './events.js';

/** Props every element takes. */
export interface CommonProps {
  key?: Key;
  children?: ReactNode;
  style?: StyleProp;
}

/** Focus and interaction, on drawn elements and windows alike. */
export interface InteractionProps {
  focusable?: boolean;
  /** Sequential focus order; `-1` is focusable but not tabbable. */
  tabIndex?: number;
  autoFocus?: boolean;
  /**
   * Own a focus scope: Tab and presses stay inside, and focus is restored
   * when it unmounts. This is what makes a modal.
   */
  trapFocus?: boolean;
  /** Never focusable, and the trigger for a `:disabled` style block. Also
   * clears the AT-SPI ENABLED/SENSITIVE states. */
  disabled?: boolean;
}

/**
 * The ARIA role vocabulary the AT-SPI bridge maps (src/a11y.js). An
 * unknown string falls back to the element default and warns in DEV; the
 * open union keeps forward compatibility.
 */
export type A11yRole =
  | 'alert'
  | 'alertdialog'
  | 'article'
  | 'banner'
  | 'blockquote'
  | 'button'
  | 'caption'
  | 'cell'
  | 'checkbox'
  | 'columnheader'
  | 'combobox'
  | 'comment'
  | 'complementary'
  | 'contentinfo'
  | 'dialog'
  | 'document'
  | 'form'
  | 'grid'
  | 'gridcell'
  | 'group'
  | 'heading'
  | 'img'
  | 'link'
  | 'list'
  | 'listbox'
  | 'listitem'
  | 'log'
  | 'main'
  | 'marquee'
  | 'math'
  | 'menu'
  | 'menubar'
  | 'menuitem'
  | 'menuitemcheckbox'
  | 'menuitemradio'
  | 'meter'
  | 'navigation'
  | 'none'
  | 'note'
  | 'option'
  | 'paragraph'
  | 'presentation'
  | 'progressbar'
  | 'radio'
  | 'radiogroup'
  | 'region'
  | 'row'
  | 'rowheader'
  | 'scrollbar'
  | 'search'
  | 'searchbox'
  | 'separator'
  | 'slider'
  | 'spinbutton'
  | 'status'
  | 'switch'
  | 'tab'
  | 'table'
  | 'tablist'
  | 'tabpanel'
  | 'term'
  | 'textbox'
  | 'timer'
  | 'toolbar'
  | 'tooltip'
  | 'tree'
  | 'treegrid'
  | 'treeitem'
  | 'window'
  | (string & {});

/** An action assistive technology asked the app to perform. */
export interface A11yActionEvent {
  action: 'setValue';
  /** For `setValue`: the value the AT wants (AT-SPI `Value.CurrentValue`). */
  value?: number;
}

/**
 * Accessibility, in the web's vocabulary — the same `role` / `aria-*`
 * names react-dom accepts. Read by the AT-SPI bridge (docs/accessibility.md);
 * inert (and harmless) where there is no accessibility bus. Every host
 * element takes these, which is the whole seam a component library needs.
 */
export interface A11yProps {
  /** What this element *is* to a screen reader. */
  role?: A11yRole;
  /** The accessible name, above every other name source. */
  'aria-label'?: string;
  /** Supplementary description (AT-SPI `Description`). */
  'aria-description'?: string;
  /** Remove this subtree from the accessible tree entirely. */
  'aria-hidden'?: boolean;
  'aria-checked'?: boolean | 'mixed';
  'aria-selected'?: boolean;
  'aria-expanded'?: boolean;
  'aria-pressed'?: boolean | 'mixed';
  'aria-busy'?: boolean;
  'aria-modal'?: boolean;
  'aria-readonly'?: boolean;
  'aria-required'?: boolean;
  /** Truthy exposes HAS_POPUP; the string names what opens. */
  'aria-haspopup'?: boolean | 'menu' | 'listbox' | 'dialog' | 'grid' | 'tree';
  'aria-orientation'?: 'horizontal' | 'vertical';
  /** Present ⇒ the element exposes the AT-SPI Value interface. */
  'aria-valuenow'?: number;
  'aria-valuemin'?: number;
  'aria-valuemax'?: number;
  'aria-valuetext'?: string;
  /** Outline level, for `role="heading"` and tree items. */
  'aria-level'?: number;
  'aria-posinset'?: number;
  'aria-setsize'?: number;
  /** The shortcut that triggers this ("Ctrl+N"), announced with the item. */
  'aria-keyshortcuts'?: string;
  /**
   * Assistive technology drove the control — Orca setting a slider's value
   * through the AT-SPI Value interface. Wire it to the same state setter
   * as the pointer and the keyboard. Activation needs no handler here: the
   * bridge dispatches a synthetic click through the normal event path.
   */
  onAccessibilityAction?: (ev: A11yActionEvent) => void;
}

export interface DrawnProps<T = DrawnNode>
  extends
    CommonProps,
    InteractionProps,
    A11yProps,
    SelectionProps<T>,
    EventHandlers<T> {
  ref?: Ref<T>;
}

/**
 * Selecting read-only text. `selectable` on an element makes it the surface
 * a drag inside it selects across — see
 * [elements.md](elements.md#selecting-text).
 */
export interface SelectionProps<T = DrawnNode> {
  /**
   * `true` makes this element a selection surface: a drag across the text
   * inside it selects, double and triple clicks take a word and a block,
   * Ctrl+A and Ctrl+C work, and a release takes PRIMARY. It also makes the
   * element a focus target, so the keys have somewhere to arrive —
   * `tabIndex={-1}` keeps it out of the Tab cycle.
   *
   * `false` opts a subtree out of the surface above it, the way CSS's
   * `user-select: none` does: a list's bullets, a table's chrome, a button
   * inside a document.
   */
  selectable?: boolean;
  /** The highlight behind selected text. Defaults to a tint of the theme's
   * accent, which keeps the ink's own contrast intact on any palette. */
  selectionColor?: Color;
  /** The selection in this surface changed. */
  onSelectionChange?: (ev: SelectionChangeEvent<T>) => void;
}

// --- windows ---------------------------------------------------------------

/**
 * ICCCM `WM_NORMAL_HINTS` — what the window manager will let the user do.
 *
 * The four bounds also take `'auto'`, which asks the content: on a floor
 * that is the smallest size it can be drawn at, and on a cap the size it
 * wanted. Both are re-measured as the content changes.
 */
export interface SizeHintProps {
  minWidth?: number | 'auto';
  minHeight?: number | 'auto';
  maxWidth?: number | 'auto';
  maxHeight?: number | 'auto';
  widthInc?: number;
  heightInc?: number;
  baseWidth?: number;
  baseHeight?: number;
  minAspect?: [number, number];
  maxAspect?: [number, number];
  gravity?: number;
  /** `false` pins min and max size to the current size. */
  resizable?: boolean;
}

export type WindowType =
  | 'normal'
  | 'dialog'
  | 'utility'
  | 'toolbar'
  | 'splash'
  | 'menu'
  | 'dropdown_menu'
  | 'popup_menu'
  | 'tooltip'
  | 'notification'
  | 'dock'
  | 'desktop'
  | (string & {});

export interface WindowProps
  extends
    CommonProps,
    InteractionProps,
    A11yProps,
    EventHandlers<DrawnNode>,
    SizeHintProps,
    ScrollProps {
  ref?: Ref<NtkWindow>;
  /** Window title (UTF-8, via `WM_NAME` + `_NET_WM_NAME`). */
  title?: string;
  /**
   * Created but never self-mapped: this window is waiting to be embedded
   * (XEmbed / `<foreign>` on the other side), and from the reparent on,
   * mapping is the embedder's decision. What a `<Frame>` pane's root window
   * sets; without an embedder the window simply never appears.
   */
  embeddable?: boolean;
  /**
   * Realized and laid out, but not on screen: the X window exists at its
   * size (auto sizes included — the content is really measured), the tree
   * behind it is live, and the window is simply never mapped while this is
   * true. Clearing it maps the window where it stands; unlike conditional
   * rendering, nothing unmounts in between, so state, subscriptions and the
   * X window itself survive a hide.
   *
   * What `Tooltip` measures an element label in before placing it, and the
   * declarative form of "minimize by unmapping". A subtree hidden by React
   * (`<Activity mode="hidden">`, a suspended `<Suspense>`) composes with it:
   * the window is on screen only when neither says hidden.
   */
  hidden?: boolean;
  /**
   * Window geometry — window state, not yoga style: the user may resize.
   *
   * `'auto'`, which is also what leaving the prop out means, sizes the
   * window from its content and caps it at the screen — CSS's `width: auto`
   * for a box that shrinks to fit. The two axes are independent, so
   * `width={600}` with no `height` gives a window whose height follows its
   * content at that width.
   */
  width?: number | 'auto';
  height?: number | 'auto';
  x?: number;
  y?: number;
  /** Palette that `$token` style values resolve against, for this subtree. */
  theme?: Record<string, string | number>;
  /** ICCCM `WM_CLASS`. */
  wmClass?: string | [string, string] | { instance: string; class?: string };
  /** EWMH `_NET_WM_WINDOW_TYPE`, or a list of fallbacks. */
  windowType?: WindowType | WindowType[];
  /**
   * ICCCM `WM_TRANSIENT_FOR` — the window this one belongs to. It is what
   * makes a second top-level window a *dialog* rather than an unrelated
   * application window: the WM stacks it above its owner, keeps it out of
   * the taskbar and pager, iconifies it alongside, places it relative to the
   * owner and gives it a dialog's reduced frame.
   *
   * Takes a ref to a `<window>`/`<popup>`, a ref to any drawn node (resolved
   * to the window that owns it), a raw XID, or `'root'` for "transient for
   * this client's whole window group".
   *
   * Resolved in the commit phase. An owner that is not realized yet — a
   * sibling `<window>` mounting in the same commit, whose ref attaches only
   * in the layout phase — is retried rather than dropped.
   *
   * **Inert on an override-redirect window**, which is every `<popup>` by
   * default: the WM does not manage those, so nothing reads the property.
   * Pass `overrideRedirect={false}` to make the popup a managed window
   * first. ICCCM 4.1.2.6 draws exactly that distinction.
   */
  transientFor?: Ref<NtkWindow | DrawnNode> | number | 'root' | null;
  /**
   * EWMH `_NET_WM_STATE`. **Controlled**: this is what the window is asked
   * to be, and {@link WindowProps.onStatesChange} is what it actually is —
   * on X the window manager changes state behind the app's back, so the two
   * diverge and react-x11 does not force reality back to the prop.
   *
   * Applied before the window is mapped, which is the only way to open
   * already fullscreen rather than flashing at the normal size first.
   */
  states?: WindowStateName[];
  /** Sugar for `states={['fullscreen']}`; they union. */
  fullscreen?: boolean;
  /** Sugar for `states={['above']}`; they union. */
  alwaysOnTop?: boolean;
  /**
   * `false` asks for no titlebar or border, via `_MOTIF_WM_HINTS`. Honoured
   * by Mutter, KWin, Xfwm, Openbox and i3; a WM that ignores the hint
   * simply decorates the window.
   */
  decorations?: boolean;
  /**
   * Give the window a 32-bit ARGB visual, so what it does not paint stays
   * transparent and a compositor shows the desktop through it. Together with
   * `style={{ borderRadius }}` this is how a `<popup>` gets rounded,
   * antialiased corners — no Shape extension, no 1-bit mask.
   *
   * The window's own `backgroundColor` may then be translucent
   * (`rgba(20, 20, 24, 0.9)`), and leaving it unset makes the window empty
   * except for what the tree paints.
   *
   * Transparency needs a 32-bit visual (XQuartz has none) **and** a running
   * compositor to blend it. When either is missing, the window is filled
   * edge to edge and `borderRadius` on it is ignored — a square opaque
   * popup rather than a black-cornered one, which is what painting the
   * corners away would give on a server with nothing compositing. Guard the
   * enhanced design with a `'@supports transparency'` style block:
   *
   * ```jsx
   * style={{
   *   backgroundColor: '#1c1c22',
   *   '@supports transparency': {
   *     backgroundColor: 'rgba(24, 24, 30, 0.86)',
   *     borderRadius: 14,
   *   },
   * }}
   * ```
   *
   * The visual is still taken when nothing is compositing yet, so that a
   * compositor starting mid-session turns the window transparent without a
   * remount. Set at creation: a visual is a `CreateWindow` field, so
   * toggling this prop on a mounted window does nothing until it remounts
   * (change its `key`). Needs ntk >= 6.6.0.
   */
  transparent?: boolean;
  /**
   * Read the pointer through XI2, which is what makes scrolling smooth: the
   * device's own scroll valuators instead of the whole notches the server
   * emulates as button 4/5 presses, so a touchpad reports the fractions of a
   * notch it measured. Ignored where the server has no XI2 — the wheel
   * buttons answer as they always did.
   *
   * - `'auto'` (the default) selects XI2 the first time the window is
   *   scrolled. An XI2 selection replaces the core one for the same event
   *   type, and an XIMotion is ~136 bytes against a core MotionNotify's 32,
   *   so an eager selection bills a window that never scrolls ~8 KB/s of
   *   pointer traffic for nothing. The opening event of the first gesture is
   *   a whole notch — which is all a mouse wheel ever reports anyway, and
   *   all an eager selection would have delivered too, since the first
   *   valuator event only seeds the accumulator.
   * - `true` selects at creation, for an app whose whole interaction is a
   *   touchpad and which wants the very first flick smooth.
   * - `false` refuses the selection for the window's whole life.
   *
   * A `<popup>` never upgrades under `'auto'`: it holds a pointer grab, a
   * core grab delivers core events, and a window whose valuators are flowing
   * has its emulated wheel buttons dropped, so a menu that had selected XI2
   * could not be wheeled while it was grabbing. An explicit `true` still
   * wins there. Needs ntk >= 7.5.0.
   */
  xi2?: boolean | 'auto';
  /**
   * Mark this window as a drag preview: the drag router never treats it as
   * the window under the pointer, so a `<popup dragPreview>` can follow the
   * pointer without swallowing its own drag. See `useDragSource`.
   */
  dragPreview?: boolean;
  /**
   * ConfigureNotify — the tree reflows on its own. Fires for moves and
   * reparents too: check `ev.resized` / `ev.moved` before doing work of
   * your own, or a window drag pays for it per pointer step.
   */
  onResize?: (ev: WindowResizeEvent) => void;
  onExpose?: (ev: SyntheticEvent<NtkWindow>) => void;
  /**
   * The states the window manager now has on the window. Subscribing is
   * what makes react-x11 watch `_NET_WM_STATE`, so a window with no handler
   * costs nothing.
   */
  onStatesChange?: (states: WindowStateName[]) => void;
  /**
   * The window manager's close button, and anything else that asks a window
   * to close (Alt+F4, a taskbar's "Close", `wmctrl -c`).
   *
   * Every WM-managed window speaks `WM_DELETE_WINDOW` whether or not this
   * prop is passed — without it the window manager cannot ask at all and
   * kills the connection instead. This prop replaces the default answer:
   *
   * - **without it** the app's primary window unmounts the tree and closes
   *   the connection, and any other window refuses (a dialog is opened by
   *   app state, so only app state can close it — dev warns).
   * - **with it** nothing happens except this handler, which decides:
   *   `setOpen(false)` for a dialog, a "save your work?" prompt, or
   *   `root.unmount()` for a quit of your own.
   *
   * The primary window is the first top-level `<window>` that is not
   * `transientFor` another and has no `windowType` of its own — a lone
   * window always qualifies.
   */
  onCloseRequest?: (ev: SyntheticEvent<NtkWindow>) => void;
  /**
   * Every ClientMessage addressed to this window — the carrier of EWMH,
   * XEmbed, the system tray, and whatever two copies of one application
   * agree between themselves.
   *
   * `ev.messageType` is the atom's **name**, so a handler is a `switch` over
   * strings rather than a comparison against ids it had to intern first.
   * Messages arrive in the order the server sent them, which the chunked
   * protocols depend on.
   *
   * ```jsx
   * <window onClientMessage={(ev) => {
   *   if (ev.messageType !== '_NET_SYSTEM_TRAY_OPCODE') return;
   *   if (ev.data[1] === SYSTEM_TRAY_REQUEST_DOCK) dock(ev.data[2]);
   * }} />
   * ```
   *
   * react-x11 answers some of these itself: `preventDefault()` stops it
   * doing so for XDND. Nothing has to be armed — a ClientMessage reaches its
   * window whatever event mask it selected — so a window without the prop
   * costs nothing.
   */
  onClientMessage?: (ev: ClientMessageEvent) => void;
}

/**
 * `_NET_WM_STATE` names, lower-cased without the atom prefix. `'maximized'`
 * is the one that is not an atom: EWMH maximizes an axis at a time, and it
 * expands to the vert/horz pair.
 *
 * These are what a `<window>` **asks for**. What the window manager actually
 * did is `useWindowState()`, whose `states` is a list of these.
 */
export type WindowStateName =
  | 'modal'
  | 'sticky'
  | 'maximized'
  | 'maximized_vert'
  | 'maximized_horz'
  | 'shaded'
  | 'skip_taskbar'
  | 'skip_pager'
  | 'hidden'
  | 'fullscreen'
  | 'above'
  | 'below'
  | 'demands_attention'
  | 'focused'
  | (string & {});

export interface PopupProps extends WindowProps {
  /**
   * Hold a pointer grab while the popup is up — what makes a menu
   * dismissable, since without it a press on another window never reaches
   * this client at all. Needs ntk >= 3.7.0.
   */
  grab?: boolean;
  /**
   * `true` (the default) keeps the window manager out entirely, which is
   * what makes a menu a menu — no frame, no repositioning, no taskbar entry.
   *
   * `false` makes the popup an ordinary managed window: decorated, movable,
   * closable through the WM, and — with {@link WindowProps.transientFor} —
   * stacked above its owner and iconified with it. That is the combination
   * that turns a `<popup>` into a real dialog. Turn `grab` off with it: a
   * client-side pointer grab over a window the WM is trying to let the user
   * drag is a fight nobody wins.
   */
  overrideRedirect?: boolean;
  /** A press landed outside the popup: close it. */
  onDismiss?: (ev: MouseEvent<DrawnNode>) => void;
  /**
   * Hang this popup off a node — `anchorRect`'s options plus the node to
   * measure, and the popup works out its own position from them, ignoring
   * `x`/`y`.
   *
   * What this does that computing a rect in the application cannot: a popup
   * with an `'auto'` size only knows how big it is *inside* `realize()`,
   * after the content is measured and before `CreateWindow` — and which side
   * it flips to and how far it is pulled back from a screen edge are both
   * functions of that size. So an anchored popup is born the right size in
   * the right place, and keeps up afterwards with everything that can move
   * either: the anchor's own layout, an ancestor scrolling, the owner window
   * being dragged, its own content growing.
   *
   * `at` names a rect **inside** the node — a caret, a table cell — so a
   * completion list follows the line being typed on rather than the editor.
   * When the anchor scrolls out of view the popup unmaps until it comes
   * back, since there is no position that points at something invisible;
   * an app that would rather *close* it does the placement itself with
   * {@link useAnchorTracking} and its `onOutOfView`.
   */
  anchor?: PopupAnchor;
}

/** A node to anchor to: a ref (the usual — refs attach after the commit
 *  that renders them) or the node itself. */
export type AnchorTarget = DrawnNode | RefObject<DrawnNode | null> | null;

export interface PopupAnchor extends Omit<AnchorOptions, 'alignTo'> {
  /** The node this popup hangs off. */
  to: AnchorTarget;
  /** Takes the alignment axis from another node — see
   *  {@link AnchorOptions.alignTo}. */
  alignTo?: AnchorTarget;
}

// --- drawn elements --------------------------------------------------------

/**
 * The flex container — and, with `style={{overflow: 'scroll'}}`, the scroll
 * container. The scrolling props below do nothing until the style says so.
 */
export interface BoxProps
  extends Omit<DrawnProps<DrawnNode>, 'ref'>, ScrollProps {
  /**
   * Either node type, because a `<box>` is both: `DrawnNode` is what most
   * refs want and what every existing one already is, and `ScrollableNode`
   * is the same node with `scrollTo` / `scrollX` / `contentHeight` on it.
   * Reach for the second only on a box you actually scroll —
   * `useRef<ScrollableNode>(null)`.
   */
  ref?: Ref<ScrollableNode> | Ref<DrawnNode>;
}

/** What `overflow: 'scroll'` adds, on a `<box>` or a `<window>`. */
export interface ScrollProps {
  onScroll?: (ev: ScrollEvent) => void;
  /** Fired from layout, so it arrives for a list nobody has scrolled yet. */
  onViewport?: (ev: ViewportEvent) => void;
  /** Hide the drawn scrollbars; the content still scrolls. */
  scrollbar?: boolean;
  scrollbarColor?: Color;
}

export interface TextProps extends DrawnProps<DrawnNode> {
  /** Strings and numbers are only legal inside `<text>`. */
  children?: ReactNode;
}

export interface TextInputProps extends DrawnProps<TextInputNode> {
  /** Controlled mode: the display follows the prop. */
  value?: string;
  /** Uncontrolled mode. */
  defaultValue?: string;
  /**
   * Field name, echoed on the event as `ev.name` and `ev.target.name`.
   * Nothing in the renderer reads it — it exists so form libraries, which
   * key a field by its name, have somewhere to put one.
   */
  name?: string;
  /**
   * The value changed. `ev.target.value` and `ev.value` are both the new
   * text, so `(ev) => setText(ev.target.value)` and `(ev) => setText(ev.value)`
   * both read naturally.
   */
  onChange?: (ev: ChangeEvent<TextInputNode>) => void;
  /** Enter — or Ctrl+Enter in a `<textarea>`. */
  onSubmit?: (ev: SubmitEvent<TextInputNode>) => void;
  placeholder?: string;
  placeholderColor?: Color;
  /** Code-point limit. */
  maxLength?: number;
  selectionColor?: Color;
  caretColor?: Color;
  /**
   * `false` turns off the built-in right-click edit menu (Undo/Redo, Cut,
   * Copy, Paste, Select All). `onContextMenu` still fires, so this is how
   * you replace it with your own rather than suppressing it per-event.
   */
  contextMenu?: false;
  /**
   * The text is a secret: **nothing here reaches a selection.** Ctrl+C and
   * the copy half of Ctrl+X do nothing, the edit menu offers neither Cut nor
   * Copy, and selecting text does not take PRIMARY — so a middle click in
   * another window cannot spend it. Pasting *in*, editing, undo and the caret
   * are untouched.
   *
   * What is on screen stops being on screen; what is on the clipboard does
   * not. `PasswordInput` sets this on the input it shows while revealed.
   */
  sensitive?: boolean;
}

export interface TextAreaProps extends TextInputProps {
  /** Preferred height in text lines (default 3). */
  rows?: number;
}

/**
 * Raw, straight (non-premultiplied) RGBA pixels: the shape `getImageData`
 * hands back, and what ntk's `new Image()` takes. `data` is
 * `width * height * 4` bytes. Treated as immutable content — hand over a
 * new object when the pixels change, or the renderer cannot tell.
 */
export interface RawImageSource {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

/**
 * A client-side picture source the 2d context composites as-is: an ntk
 * `Image` or `Surface`, or anything with a size and a `picture(app)`.
 * Passing one puts identity in your hands — the object's server upload is
 * cached per connection, so many `<image>`s showing one `Image` upload once.
 */
export interface DirectImageSource {
  readonly width: number;
  readonly height: number;
  picture(app: unknown): unknown;
}

/**
 * A WHATWG `URL`, matched structurally because these declarations use only
 * ES lib types (no DOM, no node ambients). The useful case is a file URL
 * from `new URL('./icon.png', import.meta.url)`, which finds an asset
 * relative to the module however the app is launched.
 */
export interface FileUrl {
  readonly href: string;
  readonly protocol: string;
}

/**
 * What `src` accepts: a file path or file URL (PNG/JPEG, decoded in JS),
 * encoded PNG/JPEG bytes, raw RGBA pixels, or an ntk `Image`/`Surface`.
 */
export type ImageSource =
  string | FileUrl | Uint8Array | RawImageSource | DirectImageSource;

/**
 * An existing server-side Picture, named by X id. The size is stated by the
 * caller because asking the server for it would be a round trip — which
 * this prop exists to avoid.
 */
export interface ImagePictureSource {
  id: number;
  width: number;
  height: number;
}

/**
 * An existing server-side Pixmap or Window, named by X id. `depth` picks
 * the picture format it is composited through: 24 (rgb, the default — what
 * a window pixmap from Composite is), 32 (argb), or 8 (alpha only,
 * composited as ink through its coverage).
 */
export interface ImageDrawableSource {
  id: number;
  width: number;
  height: number;
  depth?: 8 | 24 | 32;
}

export interface ImageProps extends DrawnProps<DrawnNode> {
  /**
   * Client-side pixels: a file path or file URL (PNG/JPEG, decoded in JS),
   * encoded PNG/JPEG bytes (no temp file), raw RGBA
   * (`{ width, height, data }`), or an ntk `Image`/`Surface` used as-is.
   *
   * One source per element: `src`, `picture` and `drawable` are mutually
   * exclusive, and passing two throws.
   */
  src?: ImageSource;
  /**
   * Composite an existing server-side Picture into the element — one
   * `RenderComposite`, no `PutImage`, no readback. The picture stays the
   * caller's; drawing it scaled sets its transform/filter for the composite
   * and resets them after.
   */
  picture?: ImagePictureSource;
  /**
   * Composite an existing server-side Pixmap or Window, through a Picture
   * the element creates over it (and frees when done). The drawable stays
   * the caller's.
   */
  drawable?: ImageDrawableSource;
  /**
   * The source's identity, when `src` is re-derived per render: an
   * unchanged key means unchanged content, so a structurally new buffer is
   * neither re-decoded nor re-uploaded — and two `<image>`s with one key
   * share one decoded copy. The `<canvas cacheKey>` contract: the key must
   * name the content. Not consulted for an ntk `Image` (the object is its
   * own identity) and meaningless with `picture`/`drawable` (throws).
   */
  cacheKey?: string | number;
  /** The accessible name — what a screen reader says for this image. */
  alt?: string;
}
// Size is `style={{ width, height }}`, like every other element: `width`
// and `height` are style names, so they are not declared here. With no
// style size, the source's own size (stated, for the server-side sources)
// is the natural one, kept to its aspect ratio.

/** What `onDraw` is told about the node it is painting. */
export interface DrawInfo {
  /**
   * The node's box in **device pixels** — the browser's own canvas
   * contract: the backing store is the panel's grid, and `scale` says how
   * many of its pixels one logical pixel is worth (docs/scale.md). A
   * drawing that works in fractions of the box needs neither; one that
   * draws N-logical-px strokes multiplies by `scale`.
   */
  width: number;
  height: number;
  /**
   * The node's origin in the drawable being drawn into — the translation
   * already applied to the context, said out loud. Everything on the
   * context works in node coordinates and never needs it; the raw-pixel
   * calls are the exception, because `putImageData`/`getImageData` ignore
   * the transform (the HTML canvas rule) and address the drawable
   * directly: `ctx.putImageData(data, info.x + x, info.y + y)`. Zero when
   * the drawing goes into a surface of its own — under a `cacheKey`, or a
   * `<glarea>`'s window — so offsetting by it is correct everywhere.
   */
  x: number;
  /** See {@link DrawInfo.x}. */
  y: number;
  /** Device pixels per logical pixel — `useScale()`'s number. */
  scale: number;
  node: DrawnNode;
}

export interface CanvasProps extends DrawnProps<DrawnNode> {
  /**
   * Paint the node. `ctx` is ntk's canvas-like 2d context, translated to
   * the node's origin and clipped to its bounds. Runs on every repaint.
   *
   * One exception to "you are at the node's origin": `putImageData` (and
   * `getImageData`) ignore the transform and the clip — the HTML canvas
   * rule — and address the drawable itself. Offset by `info.x`/`info.y`,
   * or better, draw raw pixels through an `Image` source and `drawImage`,
   * which honours both and caches its upload server-side. In development,
   * a write that lands outside the node warns, once. See
   * docs/elements.md, "`<canvas>`".
   */
  onDraw?: (ctx: any, info: DrawInfo) => void;
  /**
   * Opt this drawing into the paint cache: render it once and composite it
   * on later repaints, instead of running `onDraw` again.
   *
   * Opt-in because only you know what `onDraw` reads — the key has to name
   * every input the drawing depends on, and a key that leaves one out shows
   * stale pixels. Include the things that change the picture:
   *
   *     <canvas cacheKey={`spark:${series.id}:${w}x${h}`} onDraw={draw} />
   *
   * Develop with `REACT_X11_PAINT_CACHE=verify`, which turns a key that
   * misses an input into a loud complaint rather than a wrong pixel. Leave
   * unset for anything animated or driven by state outside the props.
   */
  cacheKey?: string | number;
  /**
   * A promise about the drawing: everything it paints is one colour, and it
   * is not the drawing's to choose. `onDraw` then names no colour at all —
   * `fillStyle` and `strokeStyle` arrive preset from `style.color`.
   *
   * One drawing then serves every state a control puts it in — `:hover`,
   * `:disabled`, a theme flip — since none of those is its business.
   *
   * A cached `mono` entry currently bakes its colour and keys on it: the
   * coverage path that would apply the colour at composite time composites
   * empty under nested non-rectangular clips. Sharing across instances is
   * unaffected. See docs/elements.md#mono--one-colour-and-the-colour-out-of-the-key.
   *
   * Works without `cacheKey` — the ink is preset either way — but the two
   * together are the point.
   */
  mono?: boolean;
}

// --- vector drawings -------------------------------------------------------

export interface SvgProps extends DrawnProps<DrawnNode> {
  source?: string;
  viewBox?: string;
}

// --- GL --------------------------------------------------------------------

export type FrameLoop = 'demand' | 'always';

export interface GlAreaProps extends DrawnProps<DrawnNode> {
  /** CSS colour, or `[r, g, b, a]` floats. Default black. */
  clearColor?: Color | [number, number, number, number];
  /** `'demand'` (default) redraws on change; `'always'` runs continuously. */
  frameLoop?: FrameLoop;
  /** Visual spec for ntk's `chooseGLXConfig`, e.g. `{ DEPTH_SIZE: 24 }`. */
  glx?: Record<string, unknown>;
  /** Runs once, with the context current: one-time state, uploads, lists. */
  onCreated?: (gl: any, info: DrawInfo) => void;
  /** Draw one frame. Viewport and clear happen before, SwapBuffers after. */
  onDraw?: (gl: any, info: DrawInfo) => void;
  /** No GL surface — no GLX, or no matching visual. */
  onError?: (err: Error) => void;
  /** A click inside the surface that hit no mesh. */
  onPointerMissed?: (ev: MouseEvent<DrawnNode>) => void;
}

// --- embedding -------------------------------------------------------------

/** What arrived, and how. `xembed: false` is a client that set no
 * `_XEMBED_INFO` and got plain reparenting — the common case. */
export interface EmbeddedInfo {
  /** the client's X window id */
  id: number;
  /** whether the client speaks the XEmbed protocol */
  xembed: boolean;
  /** the protocol version in use, or 0 */
  version: number;
  node: DrawnNode;
}

export interface ForeignProps extends DrawnProps<DrawnNode> {
  /**
   * The X window to embed. Changing it hands the old client back before the
   * new one is taken. Omit it to instead **adopt** whatever is put inside
   * this node, which is what `xterm -into WID` and `mpv --wid=WID` need —
   * `onReady` is where that id comes from.
   */
  windowId?: number;
  /** The container window's id, offered as soon as it exists, so a program
   * can be spawned into it. Fires before there is anything embedded. */
  onReady?: (info: { windowId: number; node: DrawnNode }) => void;
  /** A client is in. */
  onEmbedded?: (info: EmbeddedInfo) => void;
  /** Destroyed, or reparented away by someone else. */
  onClientGone?: (info: { node: DrawnNode }) => void;
  /** `XEMBED_REQUEST_FOCUS`: the client wants the focus. It is given through
   * the focus manager unless a handler prevents it by focusing elsewhere. */
  onRequestFocus?: (info: { node: DrawnNode }) => void;
  /** The embed failed — no such window, or it went away mid-handshake.
   * Without a handler the failure is a console warning. */
  onError?: (err: Error) => void;
}

export interface ReactX11Elements {
  window: WindowProps;
  popup: PopupProps;
  box: BoxProps;
  text: TextProps;
  textinput: TextInputProps;
  textarea: TextAreaProps;
  image: ImageProps;
  canvas: CanvasProps;
  svg: SvgProps;
  glarea: GlAreaProps;
  foreign: ForeignProps;
}

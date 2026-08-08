/**
 * The host elements. Only `<window>`, `<popup>` and `<glarea>` are real X11
 * windows; everything else is a retained node laid out by yoga and painted
 * into the owning window. See docs/elements.md.
 */

import type { Ref, ReactNode, Key } from 'react';
import type { Color, Cursor, StyleProp } from './style.js';
import type {
  DrawnNode,
  NtkWindow,
  ScrollViewNode,
  TextInputNode,
} from './nodes.js';
import type {
  ChangeEvent,
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
  /** Never focusable, and the trigger for a `:disabled` style block. */
  disabled?: boolean;
}

export interface DrawnProps<T = DrawnNode>
  extends CommonProps, InteractionProps, EventHandlers<T> {
  ref?: Ref<T>;
}

// --- windows ---------------------------------------------------------------

/** ICCCM `WM_NORMAL_HINTS` — what the window manager will let the user do. */
export interface SizeHintProps {
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
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
    EventHandlers<DrawnNode>,
    SizeHintProps {
  ref?: Ref<NtkWindow>;
  /** Window title (UTF-8, via `WM_NAME` + `_NET_WM_NAME`). */
  title?: string;
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
  states?: WindowState[];
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
  onStatesChange?: (states: WindowState[]) => void;
  /** The WM close button; opts the window into `WM_DELETE_WINDOW`. */
  onCloseRequest?: (ev: SyntheticEvent<NtkWindow>) => void;
}

/**
 * `_NET_WM_STATE` names, lower-cased without the atom prefix. `'maximized'`
 * is the one that is not an atom: EWMH maximizes an axis at a time, and it
 * expands to the vert/horz pair.
 */
export type WindowState =
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
}

// --- drawn elements --------------------------------------------------------

export interface BoxProps extends DrawnProps<DrawnNode> {}

export interface ScrollViewProps extends DrawnProps<ScrollViewNode> {
  onScroll?: (ev: ScrollEvent) => void;
  /** Fired from layout, so it arrives for a list nobody has scrolled yet. */
  onViewport?: (ev: ViewportEvent) => void;
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

export interface ImageProps extends DrawnProps<DrawnNode> {
  /** File path; PNG or JPEG, decoded in JS. */
  src: string;
}
// Size is `style={{ width, height }}`, like every other element: `width`
// and `height` are style names, so they are not declared here.

/** What `onDraw` is told about the node it is painting. */
export interface DrawInfo {
  width: number;
  height: number;
  node: DrawnNode;
}

export interface CanvasProps extends DrawnProps<DrawnNode> {
  /**
   * Paint the node. `ctx` is ntk's canvas-like 2d context, translated to
   * the node's origin and clipped to its bounds. Runs on every repaint.
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
}

// --- rich content ----------------------------------------------------------

export interface MarkdownProps extends DrawnProps<DrawnNode> {
  /** Markdown text, or pass it as children. */
  source?: string;
  onLink?: (href: string, ev: MouseEvent<DrawnNode>) => void;
  theme?: Record<string, unknown>;
}

export interface HtmlProps extends DrawnProps<DrawnNode> {
  source?: string;
  stylesheet?: string | string[];
  baseUrl?: string;
  loadResource?: ((url: string, info: { element: unknown }) => unknown) | null;
  onLink?: (href: string, ev: MouseEvent<DrawnNode>, element: unknown) => void;
  theme?: Record<string, unknown>;
}

export interface SvgProps extends DrawnProps<DrawnNode> {
  source?: string;
  viewBox?: string;
}

// The ink colour is `style={{ color }}`: `color` is a style name, so it is
// not a prop here.
export interface TexProps extends DrawnProps<DrawnNode> {
  source?: string;
  /** Base font size — the formula's em, in px. */
  size?: number;
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

// --- 3D scene --------------------------------------------------------------

export type Vec3 = [number, number, number];

/** A pointer event that hit a mesh. */
export interface MeshPointerEvent {
  /** Where the ray hit, in world space. */
  point: Vec3;
  distance: number;
  object: unknown;
  nativeEvent: unknown;
  stopPropagation(): void;
}

export interface Object3DProps {
  key?: Key;
  children?: ReactNode;
  position?: Vec3;
  /** XYZ euler angles, in radians. */
  rotation?: Vec3;
  /** A tuple, or one number for a uniform scale. */
  scale?: Vec3 | number;
  visible?: boolean;
  cursor?: Cursor;
  onClick?: (ev: MeshPointerEvent) => void;
  onPointerDown?: (ev: MeshPointerEvent) => void;
  onPointerUp?: (ev: MeshPointerEvent) => void;
  onPointerMove?: (ev: MeshPointerEvent) => void;
  onPointerOver?: (ev: MeshPointerEvent) => void;
  onPointerOut?: (ev: MeshPointerEvent) => void;
}

export interface GroupProps extends Object3DProps {}
/** One geometry child and one material child. */
export interface MeshProps extends Object3DProps {}

export interface GeometryProps {
  key?: Key;
}
/** `[width, height, depth, widthSeg, heightSeg, depthSeg]` */
export interface BoxGeometryProps extends GeometryProps {
  args?: number[];
}
/** `[width, height, widthSeg, heightSeg]` */
export interface PlaneGeometryProps extends GeometryProps {
  args?: number[];
}
/** `[radius, widthSeg, heightSeg]` */
export interface SphereGeometryProps extends GeometryProps {
  args?: number[];
}
/** `[radiusTop, radiusBottom, height, radialSeg, heightSeg, openEnded]` */
export interface CylinderGeometryProps extends GeometryProps {
  args?: (number | boolean)[];
}
/** `[radius, tube, radialSeg, tubularSeg]` */
export interface TorusGeometryProps extends GeometryProps {
  args?: number[];
}
export interface BufferGeometryProps extends GeometryProps {
  position?: ArrayLike<number>;
  /** Derived from the triangles when omitted. */
  normal?: ArrayLike<number>;
  uv?: ArrayLike<number>;
  index?: ArrayLike<number>;
}

/** An ntk `Image`, or anything with `{ width, height, data }` RGBA bytes. */
export interface Texture {
  width: number;
  height: number;
  data: ArrayLike<number>;
}

export type MaterialSide = 'front' | 'back' | 'double';

export interface MaterialProps {
  key?: Key;
  color?: Color;
  map?: Texture;
  wireframe?: boolean;
  opacity?: number;
  transparent?: boolean;
  side?: MaterialSide;
}
export interface MeshBasicMaterialProps extends MaterialProps {}
export interface MeshLambertMaterialProps extends MaterialProps {
  emissive?: Color;
}
export interface MeshPhongMaterialProps extends MeshLambertMaterialProps {
  specular?: Color;
  /** Default 30. */
  shininess?: number;
}

export interface LightProps {
  key?: Key;
  color?: Color;
  intensity?: number;
}
/** Costs no light unit. */
export interface AmbientLightProps extends LightProps {}
/** `position` is the direction the light comes from. */
export interface DirectionalLightProps extends LightProps {
  position?: Vec3;
}
export interface PointLightProps extends LightProps {
  position?: Vec3;
  distance?: number;
  decay?: number;
}
export interface SpotLightProps extends PointLightProps {
  /** Radians. */
  angle?: number;
  penumbra?: number;
  target?: Vec3;
}

/** Every host element react-x11 renders. */
export interface ReactX11Elements {
  window: WindowProps;
  popup: PopupProps;
  box: BoxProps;
  scrollview: ScrollViewProps;
  text: TextProps;
  textinput: TextInputProps;
  textarea: TextAreaProps;
  image: ImageProps;
  canvas: CanvasProps;
  markdown: MarkdownProps;
  html: HtmlProps;
  svg: SvgProps;
  tex: TexProps;
  glarea: GlAreaProps;

  group: GroupProps;
  mesh: MeshProps;
  boxGeometry: BoxGeometryProps;
  planeGeometry: PlaneGeometryProps;
  sphereGeometry: SphereGeometryProps;
  cylinderGeometry: CylinderGeometryProps;
  torusGeometry: TorusGeometryProps;
  bufferGeometry: BufferGeometryProps;
  meshBasicMaterial: MeshBasicMaterialProps;
  meshLambertMaterial: MeshLambertMaterialProps;
  meshPhongMaterial: MeshPhongMaterialProps;
  ambientLight: AmbientLightProps;
  directionalLight: DirectionalLightProps;
  pointLight: PointLightProps;
  spotLight: SpotLightProps;
}

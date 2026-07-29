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
  EventHandlers,
  MouseEvent,
  ScrollEvent,
  SyntheticEvent,
  ViewportEvent,
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
  /** Window geometry — window state, not yoga style: the user may resize. */
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  /** Palette that `$token` style values resolve against, for this subtree. */
  theme?: Record<string, string | number>;
  /** ICCCM `WM_CLASS`. */
  wmClass?: string | [string, string] | { instance: string; class?: string };
  /** EWMH `_NET_WM_WINDOW_TYPE`, or a list of fallbacks. */
  windowType?: WindowType | WindowType[];
  alwaysOnTop?: boolean;
  /** ConfigureNotify — the tree reflows on its own. */
  onResize?: (ev: SyntheticEvent<NtkWindow>) => void;
  onExpose?: (ev: SyntheticEvent<NtkWindow>) => void;
  /** The WM close button; opts the window into `WM_DELETE_WINDOW`. */
  onCloseRequest?: (ev: SyntheticEvent<NtkWindow>) => void;
}

export interface PopupProps extends WindowProps {
  /**
   * Hold a pointer grab while the popup is up — what makes a menu
   * dismissable, since without it a press on another window never reaches
   * this client at all. Needs ntk >= 3.7.0.
   */
  grab?: boolean;
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
  onChange?: (text: string) => void;
  /** Enter — or Ctrl+Enter in a `<textarea>`. */
  onSubmit?: (text: string, ev: unknown) => void;
  placeholder?: string;
  placeholderColor?: Color;
  /** Code-point limit. */
  maxLength?: number;
  selectionColor?: Color;
  caretColor?: Color;
}

export interface TextAreaProps extends TextInputProps {
  /** Preferred height in text lines (default 3). */
  rows?: number;
}

export interface ImageProps extends DrawnProps<DrawnNode> {
  /** File path; PNG or JPEG, decoded in JS. */
  src: string;
}

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

export interface TexProps extends DrawnProps<DrawnNode> {
  source?: string;
  /** Base font size — the formula's em, in px. */
  size?: number;
  color?: Color;
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

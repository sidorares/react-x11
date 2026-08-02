/**
 * The widget set: plain React over the host primitives, themable through
 * `ThemeProvider`. See docs/components.md.
 */

import type { ComponentType, ReactNode, RefObject } from 'react';
import type { Color, StyleProp } from './style.js';
import type { BoxProps, GlAreaProps, Vec3 } from './elements.js';
import type { DrawnNode, Rect } from './nodes.js';
import type {
  DragEndEvent,
  DragEvent,
  DragSourceEvent,
  DragSourceProps,
  DropAccept,
  DropEvent,
  DropTargetProps,
  MouseEvent,
} from './events.js';

/**
 * The palette every widget reads. A theme overrides what it cares about and
 * inherits the rest; the shape tokens are what let a theme be more than a
 * recolour.
 */
export interface Theme {
  border: string;
  /** The border of a focused control. Named for focus and not for `:active`,
   * which is the pressed state — the `…Active` tokens below. */
  borderFocus: string;
  background: string;
  text: string;
  dim: string;
  hoverBackground: string;
  hoverText: string;
  accent: string;
  accentHover: string;
  accentText: string;
  surfaceHover: string;
  track: string;
  /** The pressed step of each fill family: rest → `…Hover` → `…Active`.
   * A control activates on the release, so this is the only thing it can
   * show while it is being held. */
  accentActive: string;
  surfaceActive: string;
  dimActive: string;
  /** The keyboard focus ring every focusable node under this palette draws
   * on `:focus-visible` — read by the renderer, not by the widgets. */
  focusRing: string;
  focusRingWidth: number;
  focusRingOffset: number;
  radius: number;
  radiusSmall: number;
  borderWidth: number;
  fontSize: number;
  paddingX: number;
  paddingY: number;
}

export interface ThemeProviderProps {
  /** Merges over the defaults, and over an outer provider. */
  value?: Partial<Theme>;
  /**
   * Style for the box the provider renders to carry the palette into the
   * node tree. Defaults to `{ flexGrow: 1 }` — an app-level provider fills
   * its parent. No box is rendered above a `<window>`, which may not sit
   * inside one; the palette goes on the window itself.
   */
  style?: StyleProp;
  children?: ReactNode;
}

/**
 * Themes everything below it, by both routes at once: widgets read the
 * palette through {@link useTheme}, and a `$token` in a style resolves
 * against the `theme` prop the provider plants in the node tree.
 */
export const ThemeProvider: ComponentType<ThemeProviderProps>;

/** The palette in force: merged over the defaults and over any outer
 * provider, and the same object `$token` resolution sees. */
export function useTheme(): Theme;

/** Props a widget passes through to the `<box>` it renders. */
type WidgetProps = Omit<BoxProps, 'children' | 'style' | 'ref'>;

/**
 * What a value widget's `onChange` receives — one signature across the
 * library, so `onChange={formik.handleChange}` wires to a `Checkbox` exactly
 * as it does to a `<textinput>`.
 *
 * The new value is `ev.value`, so `onChange={(ev) => setChecked(ev.value)}`
 * is the plain-React form.
 *
 * `target` is a plain descriptor, not a node: a widget is several nodes and
 * none of them holds its value, so there is nothing honest to point at. Its
 * shape is what formik's `handleChange` and react-hook-form's event reader
 * destructure, `type` included.
 */
export interface WidgetChangeEvent<V = unknown> {
  type: 'change';
  target: {
    /** `'checkbox'`, `'radio'`, `'select-one'`, `'range'`. */
    type: string;
    name?: string;
    value: V;
    /** Checkbox and switch only. */
    checked?: boolean;
  };
  currentTarget: WidgetChangeEvent<V>['target'];
  name?: string;
  value: V;
}

/** Widgets that are one form field: they take a `name` and echo it back. */
interface NamedWidget {
  /**
   * Field name, echoed on the change event as `ev.name` and
   * `ev.target.name`. Nothing in react-x11 reads it — it is there so a form
   * library has somewhere to put one.
   */
  name?: string;
}

export interface ButtonProps extends WidgetProps {
  children?: ReactNode;
  label?: string;
  onPress?: (ev: MouseEvent<DrawnNode>) => void;
  primary?: boolean;
  disabled?: boolean;
  style?: StyleProp;
}
export const Button: ComponentType<ButtonProps>;

export interface CheckboxProps extends WidgetProps, NamedWidget {
  children?: ReactNode;
  label?: string;
  checked?: boolean;
  onChange?: (ev: WidgetChangeEvent<boolean>) => void;
  disabled?: boolean;
  style?: StyleProp;
}
export const Checkbox: ComponentType<CheckboxProps>;

export interface RadioGroupProps<T = unknown> extends WidgetProps, NamedWidget {
  value?: T;
  onChange?: (ev: WidgetChangeEvent<T>) => void;
  children?: ReactNode;
  style?: StyleProp;
}
export function RadioGroup<T = unknown>(props: RadioGroupProps<T>): ReactNode;

export interface RadioProps<T = unknown> {
  value: T;
  children?: ReactNode;
  label?: string;
  disabled?: boolean;
}
export function Radio<T = unknown>(props: RadioProps<T>): ReactNode;

export interface SwitchProps extends WidgetProps, NamedWidget {
  checked?: boolean;
  onChange?: (ev: WidgetChangeEvent<boolean>) => void;
  disabled?: boolean;
  style?: StyleProp;
}
export const Switch: ComponentType<SwitchProps>;

export interface ProgressBarProps extends WidgetProps {
  /** 0 to 1. */
  value?: number;
  color?: Color;
  trackColor?: Color;
  height?: number;
  style?: StyleProp;
}
export const ProgressBar: ComponentType<ProgressBarProps>;

export interface SliderProps extends WidgetProps, NamedWidget {
  value?: number;
  min?: number;
  max?: number;
  step?: number;
  onChange?: (ev: WidgetChangeEvent<number>) => void;
  disabled?: boolean;
  height?: number;
  style?: StyleProp;
}
export const Slider: ComponentType<SliderProps>;

export type Placement = 'top' | 'bottom' | 'left' | 'right';

export interface TooltipProps extends WidgetProps {
  label: string;
  children?: ReactNode;
  placement?: Placement;
  /** ms before it appears (default 500). */
  delay?: number;
  fontSize?: number;
  style?: StyleProp;
}
export const Tooltip: ComponentType<TooltipProps>;

export interface DialogProps extends WidgetProps {
  open?: boolean;
  title?: string;
  children?: ReactNode;
  /**
   * `true` (the default) makes the dialog a **window-manager-managed**
   * window with `WM_TRANSIENT_FOR` pointing at its owner: framed, movable,
   * closable through the WM, out of the taskbar and alt-tab list, and — on a
   * full EWMH window manager — stacked above its owner and iconified with
   * it. A press outside does **not** close it, because a real dialog does
   * not close that way; Escape and the WM close button both call
   * {@link DialogProps.onClose}.
   *
   * `false` is the override-redirect popup 1.x shipped: no frame, not
   * movable, and a press anywhere outside dismisses it (a pointer grab).
   * Right for a transient confirmation on a display with no window manager.
   */
  managed?: boolean;
  onClose?: () => void;
  actions?: ReactNode;
  width?: number;
  height?: number;
  style?: StyleProp;
}
export const Dialog: ComponentType<DialogProps>;

/** An option, or a plain value used as both value and label. */
export type SelectOption<T = unknown> = { value: T; label: string } | T;

export interface SelectProps<T = unknown> extends WidgetProps, NamedWidget {
  value?: T;
  options?: readonly SelectOption<T>[];
  onChange?: (ev: WidgetChangeEvent<T>) => void;
  placeholder?: string;
  style?: StyleProp;
}
export function Select<T = unknown>(props: SelectProps<T>): ReactNode;

export interface MenuItem {
  label?: string;
  /** Present and truthy makes this a submenu parent. */
  items?: MenuItem[];
  disabled?: boolean;
  /** Shown right-aligned; purely a label, not a binding. */
  shortcut?: string;
  checked?: boolean;
  /** A horizontal rule instead of an item. */
  separator?: boolean;
  onSelect?: () => void;
  [key: string]: unknown;
}

export interface ContextMenuProps extends WidgetProps {
  items?: readonly MenuItem[];
  children?: ReactNode;
  onSelect?: (item: MenuItem) => void;
  fontSize?: number;
  style?: StyleProp;
}
export const ContextMenu: ComponentType<ContextMenuProps>;

export interface MenuBarMenu {
  label: string;
  items: MenuItem[];
}

export interface MenuBarProps extends WidgetProps {
  menus?: readonly MenuBarMenu[];
  onSelect?: (item: MenuItem) => void;
  fontSize?: number;
  style?: StyleProp;
}
export const MenuBar: ComponentType<MenuBarProps>;

export interface TabItem {
  id: string;
  label: string;
  content?: ReactNode;
  disabled?: boolean;
}

export interface TabsProps extends WidgetProps {
  items?: readonly TabItem[];
  value?: string;
  defaultValue?: string;
  onChange?: (id: string) => void;
  orientation?: 'horizontal' | 'vertical';
  /** Arrow keys move the highlight without selecting until Enter/Space. */
  manual?: boolean;
  style?: StyleProp;
}
export const Tabs: ComponentType<TabsProps>;

export interface TreeItem {
  id: string;
  label: string;
  /** An array — even an empty one — makes this a branch. */
  children?: TreeItem[];
  disabled?: boolean;
}

export interface TreeProps extends WidgetProps {
  items?: readonly TreeItem[];
  expanded?: readonly string[];
  defaultExpanded?: readonly string[];
  onExpandedChange?: (expanded: string[]) => void;
  selected?: string | null;
  defaultSelected?: string | null;
  onSelect?: (id: string) => void;
  onActivate?: (id: string) => void;
  style?: StyleProp;
}
export const Tree: ComponentType<TreeProps>;

export interface TableColumn<Row = any> {
  id: string;
  label?: string;
  width?: number;
  align?: 'left' | 'right' | 'center';
  /** Pull the cell value out of a row; defaults to `row[id]`. */
  value?: (row: Row) => unknown;
  render?: (row: Row, column: TableColumn<Row>) => ReactNode;
}

export interface TableSort {
  id: string;
  direction: 'asc' | 'desc';
}

export interface TableProps<Row = any> extends WidgetProps {
  columns?: readonly TableColumn<Row>[];
  rows?: readonly Row[];
  rowHeight?: number;
  sort?: TableSort | null;
  defaultSort?: TableSort | null;
  onSortChange?: (sort: TableSort | null) => void;
  selected?: string | number | null;
  defaultSelected?: string | number | null;
  onSelect?: (id: string | number) => void;
  onActivate?: (id: string | number) => void;
  onColumnResize?: (id: string, width: number) => void;
  style?: StyleProp;
}
export function Table<Row = any>(props: TableProps<Row>): ReactNode;

export interface SplitPaneProps extends WidgetProps {
  direction?: 'row' | 'column';
  size?: number;
  defaultSize?: number;
  /** Minimum size of the first pane. */
  min?: number;
  /** Minimum size of the second. */
  minSecond?: number;
  onResize?: (size: number) => void;
  /** Exactly two children: the two panes. */
  children?: ReactNode;
  style?: StyleProp;
}
export const SplitPane: ComponentType<SplitPaneProps>;

export interface Canvas3DProps extends Omit<GlAreaProps, 'onDraw'> {
  camera?: {
    position?: Vec3;
    /** Vertical field of view in degrees. */
    fov?: number;
    near?: number;
    far?: number;
    target?: Vec3;
  };
  children?: ReactNode;
}
export const Canvas3D: ComponentType<Canvas3DProps>;

// --- anchoring helpers -----------------------------------------------------

export interface AnchorOptions {
  placement?: Placement;
  /** Gap between the anchor and the popup, in px. */
  gap?: number;
  width?: number;
  height?: number;
  /** Flip to the opposite side when there is no room (default true). */
  flip?: boolean;
}

/**
 * Where to put a `<popup>` relative to a node, in screen coordinates,
 * flipped at screen edges.
 */
export function anchorRect(node: DrawnNode, options?: AnchorOptions): Rect;

/** Centre a popup of this size on the node's screen. */
export function centerRect(
  node: DrawnNode,
  size: { width: number; height: number },
): Rect;

/** `anchorRect` bound to a ref, recomputed on demand. */
export function useAnchor(
  ref: RefObject<DrawnNode | null>,
): (options?: AnchorOptions) => Rect | null;

// --- drag and drop ---------------------------------------------------------

export interface UseDropTargetOptions {
  /** Maps to the `dropAccept` host prop. */
  accept?: DropAccept;
  onDrop?: (ev: DropEvent) => void | Promise<void>;
  onDragOver?: (ev: DragEvent) => void;
  onDragEnter?: (ev: DragEvent) => void;
  onDragLeave?: (ev: DragEvent) => void;
}

/**
 * The react-dropzone-shaped convenience over the drop-target host props:
 * spread `dropProps` on any drawn element or window. Only needed when the
 * render itself changes with the drag — a `':drag-over'` style block
 * highlights without any state.
 */
export function useDropTarget(options?: UseDropTargetOptions): {
  dropProps: DropTargetProps;
  isOver: boolean;
  isAccepted: boolean;
};

export interface UseDragSourceOptions {
  /** Maps to the `dragData` host prop. */
  data?: DragSourceProps['dragData'];
  /** Maps to `dragActions`. */
  actions?: Array<'copy' | 'move' | 'link'>;
  onDragStart?: (ev: DragSourceEvent) => void;
  onDrag?: (ev: DragSourceEvent) => void;
  onDragEnd?: (ev: DragEndEvent) => void;
}

/**
 * The source-side convenience: spread `dragProps` on the node to drag.
 * `position` (screen coordinates, non-null while dragging) is what a
 * `<popup dragPreview>` follows — the drag preview is a live React tree,
 * not a bitmap.
 */
export function useDragSource(options?: UseDragSourceOptions): {
  dragProps: DragSourceProps;
  isDragging: boolean;
  position: { x: number; y: number; accepted: boolean } | null;
};

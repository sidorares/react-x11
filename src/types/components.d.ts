/**
 * The widget set: plain React over the host primitives, themable through
 * `ThemeProvider`. See docs/components.md.
 */

import type { ComponentType, Provider, ReactNode, RefObject } from 'react';
import type { Color, StyleProp } from './style.js';
import type { BoxProps, GlAreaProps, Vec3 } from './elements.js';
import type { DrawnNode, Rect } from './nodes.js';
import type { MouseEvent } from './events.js';

/**
 * The palette every widget reads. A theme overrides what it cares about and
 * inherits the rest; the shape tokens are what let a theme be more than a
 * recolour.
 */
export interface Theme {
  border: string;
  borderActive: string;
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
  radius: number;
  radiusSmall: number;
  borderWidth: number;
  fontSize: number;
  paddingX: number;
  paddingY: number;
}

/** Themes every widget below it; partial palettes merge over the defaults. */
export const ThemeProvider: Provider<Partial<Theme>>;
/** Back-compat alias of {@link ThemeProvider}. */
export const SelectThemeProvider: Provider<Partial<Theme>>;

/** Props a widget passes through to the `<box>` it renders. */
type WidgetProps = Omit<BoxProps, 'children' | 'style' | 'ref'>;

export interface ButtonProps extends WidgetProps {
  children?: ReactNode;
  label?: string;
  onPress?: (ev: MouseEvent<DrawnNode>) => void;
  primary?: boolean;
  disabled?: boolean;
  style?: StyleProp;
}
export const Button: ComponentType<ButtonProps>;

export interface CheckboxProps extends WidgetProps {
  children?: ReactNode;
  label?: string;
  checked?: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  style?: StyleProp;
}
export const Checkbox: ComponentType<CheckboxProps>;

export interface RadioGroupProps<T = unknown> extends WidgetProps {
  value?: T;
  onChange?: (value: T) => void;
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

export interface SwitchProps extends WidgetProps {
  checked?: boolean;
  onChange?: (checked: boolean) => void;
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

export interface SliderProps extends WidgetProps {
  value?: number;
  min?: number;
  max?: number;
  step?: number;
  onChange?: (value: number) => void;
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
  onClose?: () => void;
  actions?: ReactNode;
  width?: number;
  height?: number;
  style?: StyleProp;
}
export const Dialog: ComponentType<DialogProps>;

/** An option, or a plain value used as both value and label. */
export type SelectOption<T = unknown> = { value: T; label: string } | T;

export interface SelectProps<T = unknown> extends WidgetProps {
  value?: T;
  options?: readonly SelectOption<T>[];
  onChange?: (value: T) => void;
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

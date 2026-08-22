/**
 * The widget set: plain React over the host primitives, themable through
 * `ThemeProvider`. See docs/components.md.
 */

import type { ComponentType, ReactNode, Ref, RefObject } from 'react';
import type { ColorSchemePreference } from './appearance.js';
import type { Color, StyleProp } from './style.js';
import type {
  BoxProps,
  CanvasProps,
  DrawInfo,
  GlAreaProps,
  Vec3,
} from './elements.js';
import type { DrawnNode, Rect } from './nodes.js';
import type {
  DragEndEvent,
  DragEvent,
  DragSourceEvent,
  DragSourceProps,
  DropAccept,
  DropEvent,
  DropTargetProps,
  KeyboardEvent,
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
  /** The ground: what the window itself is painted with, under everything. */
  background: string;
  /** What is raised off it — a control's fill, a card, the sheet a menu or a
   * dialog is drawn on. The same colour as `background` in the light palette
   * and a step lighter in the dark one, where a card at the ground's own
   * colour is a card you cannot see. */
  surface: string;
  text: string;
  /** Secondary ink: a placeholder, a caption, a disabled label. */
  textMuted: string;
  hoverBackground: string;
  hoverText: string;
  accent: string;
  accentHover: string;
  /** The letters on an `accent` fill. Derived from it when a palette names
   * the fill and not the ink — the more legible of this palette's own `text`
   * and `background` — so an accent light enough that white disappears on it
   * gets dark letters without being asked. */
  accentText: string;
  surfaceHover: string;
  track: string;
  /** What a screen says with colour: this failed, this worked, look at this,
   * here is a note. Each works as ink as well as fill — 4.5:1 against the
   * palette's own ground — so a validation message and the badge beside it
   * are one token. `…Text` is the letters on the fill, derived by contrast
   * like `accentText`. */
  danger: string;
  dangerHover: string;
  dangerText: string;
  success: string;
  successText: string;
  warning: string;
  warningText: string;
  info: string;
  infoText: string;
  /** The pressed step of each fill family: rest → `…Hover` → `…Active`.
   * A control activates on the release, so this is the only thing it can
   * show while it is being held. `danger` is the only status colour with
   * one: a destructive button is the only status fill anyone presses. */
  accentActive: string;
  surfaceActive: string;
  textMutedActive: string;
  dangerActive: string;
  /** The keyboard focus ring every focusable node under this palette draws
   * on `:focus-visible` — read by the renderer, not by the widgets. */
  focusRing: string;
  focusRingWidth: number;
  focusRingOffset: number;
  radius: number;
  radiusSmall: number;
  /** A floating surface — a menu, a dropdown — which rounds on a wider
   * scale than a control does: half the text size, and derived from
   * `fontSize` for any palette that moves it without naming this. */
  radiusPopup: number;
  /** A row inside one, a step tighter so the highlight reads as a pill on
   * the sheet rather than as a second edge just inside its own. */
  radiusPopupItem: number;
  /** A tooltip bubble — the smallest floating surface there is. */
  radiusTooltip: number;
  borderWidth: number;
  /** The size unstyled text comes out at, and what the popup radii are
   * derived from. */
  fontSize: number;
  /** The UI face, as a CSS-style family list. What a `<text>` that names no
   * `fontFamily` inherits. */
  fontFamily: string;
  /** The face code surfaces use — a `<Code>`, a log pane, a hex dump. Not
   * read by anything unstyled; it is there so `fontFamily: '$monoFamily'`
   * says "this app's mono face" in one place. */
  monoFamily: string;
  /**
   * Which way this app reads. Seeded from the environment's locale, so an app
   * started under an RTL locale is mirrored without being asked; set it to
   * mirror a whole UI from one place — the provider plants the matching
   * `direction` style property in the tree, so the boxes and the widgets
   * follow it together.
   */
  direction: 'ltr' | 'rtl';
  paddingX: number;
  paddingY: number;
}

export interface ThemeProviderProps {
  /**
   * Merges over the scheme in force — the desktop's palette, or an outer
   * provider's. So a partial palette names what this app changes and
   * everything else keeps following the desktop.
   */
  value?: Partial<Theme>;
  /**
   * A palette layered on only when the scheme in force is dark — for a design
   * whose two schemes are not one recolour of the other. Usually unnecessary:
   * `value` already layers over the desktop's own light or dark palette.
   */
  dark?: Partial<Theme>;
  /**
   * `'system'` (the default) follows the desktop. `'light'` and `'dark'` pin
   * this subtree, for an app whose own settings own the choice — and pinning
   * is the complete opt-out: nothing under a pinned provider asks the desktop
   * anything.
   */
  colorScheme?: ColorSchemePreference;
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

/**
 * The palette as a bag of tokens, which is what it is at runtime: a theme
 * merges over whatever is above it and a `$name` in a style resolves against
 * the result, so a component that reads tokens by name — a code block asking
 * for `surface`/`text`/`textMuted`, a renderer resolving a palette it was handed
 * — can index it. The named tokens keep their types; anything else is
 * `unknown` and has to be narrowed, which is the honest answer for a name
 * only the caller knows.
 *
 * `<ThemeProvider value>` stays closed (`Partial<Theme>`) on purpose: a typo
 * in a palette is a bug, and there is nowhere else to catch it.
 */
export interface ThemeTokens extends Theme {
  readonly [token: string]: unknown;
}

/** The palette in force: merged over the defaults and over any outer
 * provider, and the same object `$token` resolution sees. */
export function useTheme(): ThemeTokens;

/**
 * Which way the widgets here read. Yoga mirrors the boxes on its own from the
 * `direction` style property, so this is for what it cannot decide: which way
 * an arrow key steps, which way a glyph points, which side a menu opens on.
 */
export function useDirection(): 'ltr' | 'rtl';

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

/**
 * The system icon set: the affordance glyphs core's own widgets are drawn
 * with. Affordances only — no nouns; a folder or a save icon belongs to an
 * icon theme. See docs/components.md#system-icons.
 */
export type IconName =
  | 'chevronRight'
  | 'chevronLeft'
  | 'chevronDown'
  | 'chevronUp'
  | 'check'
  | 'dash'
  | 'dot'
  | 'close'
  | 'plus'
  | 'moreVertical'
  | 'eye'
  | 'eyeOff';

export interface IconProps extends Omit<CanvasProps, 'onDraw' | 'cacheKey'> {
  name: IconName;
  /**
   * The size of the mark, not of a grid it sits in — the ink runs corner to
   * corner, unlike lucide and its descendants. A chevron's arms are at 45°,
   * so it is `size` along the way it points across and half that the other
   * way. Default: a shade under the palette's `fontSize`.
   */
  size?: number;
  /** Default: the ink of the element around it, and under that the palette's
   *  `text` — `color` inherits, so an icon in a row that dims itself dims
   *  with it. Pass this only to say something the surrounding text does not. */
  color?: Color;
  style?: StyleProp;
}
export const Icon: ComponentType<IconProps>;

/**
 * The drawings themselves, keyed by name — each one an `onDraw` for
 * `<canvas mono>`, for a widget that wants the glyph without the component.
 */
export const icons: Readonly<
  Record<IconName, (ctx: any, info: DrawInfo) => void>
>;
export const iconNames: readonly IconName[];
/** The default icon box for a given `fontSize`. */
export function iconSize(fontSize: number): number;

export interface ButtonProps extends WidgetProps {
  children?: ReactNode;
  label?: string;
  onPress?: (ev: MouseEvent<DrawnNode>) => void;
  primary?: boolean;
  disabled?: boolean;
  style?: StyleProp;
}
export const Button: ComponentType<ButtonProps>;

/**
 * A calendar day, `'2026-08-07'`. Not a `Date`: a square on a wall calendar
 * has no time and no zone, and two of them compare equal only if both were
 * built the same way. As a string, `===` is "the same day" and `<` is
 * "earlier".
 */
export type CalendarDay = string;

/** What a day prop takes: a day, or a `Date` read as its **local** day. */
export type DayInput = CalendarDay | Date | null;

/** A span. `end` is `null` while only one end has been picked. */
export interface DateRange {
  start: CalendarDay | null;
  end: CalendarDay | null;
}

export interface DateRangeInput {
  start?: DayInput;
  end?: DayInput;
}

/** The day, taken apart — so `isDateBlocked` need not parse the string. */
export interface DayParts {
  year: number;
  /** 1-based, unlike `Date`'s. */
  month: number;
  day: number;
  /** `0` Sunday … `6` Saturday, as `Date#getDay()` counts. */
  weekday: number;
  /** The day as a UTC-midnight `Date`. */
  date: Date;
}

/** What a cell is, when `dayContent` is asked what to draw in it. */
export interface CalendarDayState {
  blocked: boolean;
  /** A day of the neighbouring month, filling a corner of the grid. */
  outside: boolean;
  today: boolean;
  selected: boolean;
  inRange: boolean;
  /** Inside a range that is being previewed rather than picked. */
  preview: boolean;
  focused: boolean;
  /** The colour the day's number is drawn in — a marker that follows it
   * stays legible on the filled ends of a range. */
  color: Color;
}

/** A `<Calendar>`'s imperative side, for a control that holds the keyboard on
 * its behalf. `handleKey` reports whether the grid took the key. */
export interface CalendarHandle {
  handleKey: (ev: KeyboardEvent<DrawnNode>) => boolean;
}

interface CalendarCommonProps extends WidgetProps, NamedWidget {
  /** Visible month, `'2026-08'`; controlled with `onMonthChange`. */
  month?: string | null;
  defaultMonth?: string | Date | null;
  onMonthChange?: (month: string) => void;
  min?: DayInput;
  max?: DayInput;
  /** Everything `min`/`max` cannot say — weekends, holidays, days the
   * server reports as taken. */
  isDateBlocked?: (day: CalendarDay, parts: DayParts) => boolean;
  /** Let a range run across blocked days; only its ends must be free. */
  spanBlocked?: boolean;
  /** Drawn under the number, in a strip reserved only when this is given —
   * the seam for event dots, prices, availability counts. */
  dayContent?: (day: CalendarDay, state: CalendarDayState) => ReactNode;
  /** BCP 47 tag for the month name, weekday names and the trigger's label.
   * The system locale by default. */
  locale?: string;
  /** `0` Sunday … `6` Saturday. The locale's own answer by default, and
   * Monday where the runtime does not know it. */
  weekStartsOn?: number;
  style?: StyleProp;
}

export interface SingleCalendarProps extends CalendarCommonProps {
  mode?: 'single';
  value?: DayInput;
  defaultValue?: DayInput;
  onChange?: (ev: WidgetChangeEvent<CalendarDay>) => void;
}

export interface RangeCalendarProps extends CalendarCommonProps {
  mode: 'range';
  value?: DateRangeInput | null;
  defaultValue?: DateRangeInput | null;
  onChange?: (ev: WidgetChangeEvent<DateRange>) => void;
}

export type CalendarProps = (SingleCalendarProps | RangeCalendarProps) & {
  /** A tab stop by default. Off for a calendar whose keys come from
   * elsewhere — a picker's trigger, which the popup cannot take focus
   * from. */
  focusable?: boolean;
  /** Draw the day cursor even though this grid does not hold the focus,
   * which is what that same case needs. */
  focusVisible?: boolean;
  ref?: Ref<CalendarHandle>;
};
export const Calendar: ComponentType<CalendarProps>;

export type DatePickerProps = (SingleCalendarProps | RangeCalendarProps) & {
  /** The trigger's label. The locale's medium date by default, and
   * `Intl`'s own range format for two of them. */
  format?: (value: unknown) => string | null | undefined;
  placeholder?: string;
  disabled?: boolean;
};
export const DatePicker: ComponentType<DatePickerProps>;

/** What a `drawMask` is told about the mask it is painting. */
export interface PasswordMaskInfo {
  /** How wide the mask should be — what the field worked out from the
   * length, not the width of the box. */
  width: number;
  height: number;
  /** Seeded from the window and a hash of the value, so it changes on every
   * keystroke and repaints identically in between. */
  seed: number;
  color: Color;
  length: number;
}

export interface PasswordInputProps extends WidgetProps, NamedWidget {
  value?: string;
  defaultValue?: string;
  onChange?: (ev: WidgetChangeEvent<string>) => void;
  /** Enter. */
  onSubmit?: (value: string) => void;
  placeholder?: string;
  /** Show the reveal eye at all. Default `true`, as GTK's peek icon is. */
  revealable?: boolean;
  /** Drive the reveal yourself — for a toggle the keyboard can reach, the
   * built-in eye being a pointer affordance. */
  revealed?: boolean;
  onRevealChange?: (revealed: boolean) => void;
  /** In code points, not UTF-16 units. */
  maxLength?: number;
  /** Draw the mask instead of the scribble. `ctx` is ntk's canvas-like 2d
   * context, translated to the mask's origin. */
  drawMask?: (ctx: any, info: PasswordMaskInfo) => void;
  disabled?: boolean;
  style?: StyleProp;
}
export const PasswordInput: ComponentType<PasswordInputProps>;

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
  /** 0 to 1. Ignored when {@link ProgressBarProps.indeterminate} is set. */
  value?: number;
  /**
   * Working, with no idea how far along: a block slides across the track
   * forever and the bar says `aria-busy` with no value. Honours the
   * desktop's reduced-motion setting — see docs/components.md.
   */
  indeterminate?: boolean;
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
  /**
   * The hint. A string is measured and the popup sized around it; an
   * element **self-sizes too** — the popup is rendered once hidden at its
   * natural size, read back, and placed before it is ever mapped — so a card
   * whose height depends on its content needs no numbers. It gets the
   * bubble to fill and draws its own padding.
   */
  label: ReactNode;
  children?: ReactNode;
  /**
   * Which side of the trigger to open on. `'auto'` (the default) takes the
   * first side the hint fits on, preferring above; a named side is still a
   * preference rather than a promise, since it flips to its opposite rather
   * than opening off-screen.
   */
  direction?: Placement | 'auto';
  /** The older name for {@link TooltipProps.direction}; wins where given. */
  placement?: Placement;
  /** ms before it appears (default 500). */
  delay?: number;
  fontSize?: number;
  /**
   * Pin an axis of the bubble exactly. For text they override the measured
   * size; for an element, a pinned axis stays pinned and the other is
   * measured for it — `width={340}` is a fixed column whose height fits the
   * message. Give both and nothing is measured at all.
   */
  width?: number;
  height?: number;
  /**
   * Cap what an element label may measure out to, on top of the screen's
   * own cap. Inert on an axis pinned by {@link TooltipProps.width} /
   * {@link TooltipProps.height}, and on a text label, which stays one line.
   */
  maxWidth?: number;
  maxHeight?: number;
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

/** dbusmenu's `toggle-type`. */
export type MenuToggleType = 'checkmark' | 'radio';

/** dbusmenu's `toggle-state`: off, on, and "on for part of the selection". */
export type MenuToggleState = 0 | 1 | -1;

/** dbusmenu's `disposition` — what kind of attention the item wants. */
export type MenuDisposition = 'normal' | 'informative' | 'warning' | 'alert';

/**
 * One `aas` shortcut: a list of **alternatives**, each a list of modifier
 * tokens (`Control`, `Alt`, `Shift`, `Super`) ending in the key.
 *
 * ```ts
 * shortcut: [['Control', 'S']]
 * ```
 *
 * The key is named the way GDK names it — `plus`, not `+` — because that is
 * what a panel's importer parses. Menus print the friendly form.
 */
export type MenuShortcut = readonly (readonly string[])[];

/**
 * An item in a menu.
 *
 * The vocabulary is `com.canonical.dbusmenu`'s, so the identical array
 * serialises to the desktop's global menu with no translation and there is
 * no second authoring model. See docs/globalmenu.md.
 */
export interface MenuItem {
  label?: string;
  /** `'separator'` draws a rule instead of a row. Absent means `'standard'`. */
  type?: 'standard' | 'separator';
  /** Present and non-empty makes this a submenu parent. */
  items?: MenuItem[];
  /** Defaults to `true`; `false` dims the row and makes it inert. */
  enabled?: boolean;
  /** Defaults to `true`; `false` removes the row from the menu entirely. */
  visible?: boolean;
  /**
   * Drawn right-aligned, announced as `aria-keyshortcuts`, sent to the
   * panel — **and bound**: pressing it fires this item's `onSelect` while
   * the menu is mounted, without the menu being opened (#351). `enabled`
   * and `visible` gate the binding with the row. `accelerators={false}` on
   * the menu turns that off for an app with a dispatcher of its own.
   */
  shortcut?: MenuShortcut;
  /** With `toggleState`, draws a check mark or a radio dot in the gutter. */
  toggleType?: MenuToggleType;
  toggleState?: MenuToggleState;
  /** An icon-theme name, for the desktop's menu. Ignored by the drawn one. */
  iconName?: string;
  /** Raw PNG bytes, for an icon that is not in a theme. */
  iconData?: Uint8Array;
  disposition?: MenuDisposition;
  /**
   * Drawn in the 16px column left of the label — the same column the toggle
   * mark uses, so an item that is both checked and iconned shows the check.
   *
   * **Local only**, and the one deliberate departure from the dbusmenu
   * vocabulary: the desktop cannot call a function, so an item that wants an
   * icon in both menus carries `icon` for ours and `iconName` for the panel's.
   *
   * A string is drawn as text, which is a one-liner but only as good as the
   * font: an exotic glyph is tofu on a machine without it. A **function**
   * is called with the colour the row's label is being drawn in and the
   * size the gutter allows, which is what a `<canvas onDraw>` icon needs —
   * it has to pick a stroke colour, and nothing else can tell it whether
   * its row is highlighted, disabled or at rest. An element renders as-is.
   */
  icon?:
    | string
    | number
    | ReactNode
    | ((state: { color: string; size: number }) => ReactNode);
  /** Identity for React keys and for the exported item's stable integer id. */
  key?: string;
  onSelect?: (item: MenuItem) => void;
  [key: string]: unknown;
}

export interface ContextMenuProps extends WidgetProps {
  items?: readonly MenuItem[];
  children?: ReactNode;
  onSelect?: (item: MenuItem) => void;
  /**
   * Honour the items' own `shortcut`s while this menu is mounted. On by
   * default; `false` leaves the chords to an app that dispatches its own.
   */
  accelerators?: boolean;
  fontSize?: number;
  style?: StyleProp;
}
export const ContextMenu: ComponentType<ContextMenuProps>;

export interface MenuBarMenu {
  label: string;
  items: MenuItem[];
  visible?: boolean;
  key?: string;
}

export interface MenuBarProps extends WidgetProps {
  menus?: readonly MenuBarMenu[];
  onSelect?: (item: MenuItem) => void;
  /**
   * Hand the bar to the desktop's panel where there is one. On by default,
   * and `false` keeps it in the window. See docs/globalmenu.md.
   */
  globalMenu?: boolean;
  /**
   * Called with `true` when the desktop's panel takes the menu and `false`
   * when it gives it back. The one fact about this an app cannot work out for
   * itself: calling `useGlobalMenu` beside a `MenuBar` would export the menu
   * twice.
   */
  onGlobalMenuChange?: (exported: boolean) => void;
  /**
   * Honour the items' own `shortcut`s while this bar is mounted — including
   * when the desktop's panel has taken the menu over, since the panel draws
   * the rows but the key is pressed in this window. On by default; `false`
   * leaves the chords to an app that dispatches its own.
   */
  accelerators?: boolean;
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
  /**
   * Draw the cell yourself. `selected` says the cell is on the selected row —
   * a filled bar — so a colour chosen against the resting background has to
   * give way to `hoverText` there.
   */
  render?: (
    row: Row,
    context: { selected: boolean; column: TableColumn<Row> },
  ) => ReactNode;
}

export interface TableSort {
  column: string;
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
  onSelect?: (id: string | number, row: Row) => void;
  /** Double click, or Enter on the selected row. */
  onActivate?: (id: string | number, row: Row) => void;
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
  /**
   * What to render when this X server cannot give us a GL context — an
   * element, or a function of the error. `err.code` is one of ntk's
   * `GLXError` values; `GLX_INDIRECT_DISABLED` is the usual one. Rendered
   * inside a `<box>` with this component's `style`, so it keeps the
   * surface's place in the layout.
   */
  fallback?: ReactNode | ((error: GlxSetupError) => ReactNode);
}

/** The error a failed GL setup reports (ntk classifies it). */
export interface GlxSetupError extends Error {
  /** `GLX_INDIRECT_DISABLED` | `GLX_NO_EXTENSION` | `GLX_NO_CONFIG` |
   * `GLX_CONTEXT_FAILED` — branch on this, not on the message. */
  code?: string;
  /** Multi-line remedy, suitable for printing as-is. */
  hint?: string;
}
export const Canvas3D: ComponentType<Canvas3DProps>;

// --- anchoring helpers -----------------------------------------------------

/**
 * The side a popup is asked for. `'start'`/`'end'` are the **logical** ones
 * and mirror with the anchor's direction, which is what a submenu wants;
 * `'left'`/`'right'` stay physical.
 */
export type AnchorPlacement = Placement | 'start' | 'end';

export interface AnchorOptions {
  /** Preferred side, flipped at a screen edge (default `'bottom'`). */
  placement?: AnchorPlacement;
  /** Which edges line up on the cross axis (default `'start'`). */
  align?: 'start' | 'center' | 'end';
  /** Gap from the anchor along the placement axis, in px (default 2). */
  offset?: number;
  /**
   * Shift along the *alignment* axis, applied before the popup is clamped
   * into the screen. For lining up what is drawn in a surface rather than
   * the surface itself: a submenu level with the row that opened it has its
   * first item a border and a padding lower, and the eye lines up the items.
   */
  alignOffset?: number;
  /**
   * Anchor to a rect **inside** the node, in the node's own coordinates:
   * a caret, a table cell, a chart datapoint. Everything reads it — the
   * side that flips, the edge that aligns, the gap `offset` leaves — so a
   * popup at a caret behaves like one at a small widget that happens to be
   * there. `width`/`height` default to 0, so `{x, y}` alone is a point.
   */
  at?: { x: number; y: number; width?: number; height?: number };
  /** The size of the popup being placed. `width` defaults to the anchor's. */
  width?: number;
  height?: number;
  /** Take the alignment from this node instead — a submenu lines up with
   *  the row that opened it while hanging off the menu's outer edge. */
  alignTo?: DrawnNode | null;
  /** Overrides the direction read off the anchoring node. */
  direction?: 'ltr' | 'rtl';
}

/** An anchored rect, and the side it actually ended up on. */
export interface AnchorRect extends Rect {
  placement: Placement;
}

/**
 * Where to put a `<popup>` relative to a node, in screen coordinates,
 * flipped at screen edges. `null` for a node that has not been laid out.
 */
export function anchorRect(
  node: DrawnNode | null,
  options?: AnchorOptions,
): AnchorRect | null;

/** Centre a popup of this size on the node's screen. */
export function centerRect(
  node: DrawnNode,
  size: { width: number; height: number },
): Rect;

/**
 * The area a popup anchored to this node may be placed in: the usable part
 * of the monitor it is on — per-monitor, minus the panels, the same answer
 * `<window width="auto">` is capped by. What a widget sizing its own surface
 * needs (a menu is never wider than the screen it opens on). `null` where
 * there is no display to ask, which includes the headless mock.
 */
export function anchorArea(node: DrawnNode | null): Rect | null;

/**
 * A node's laid-out rect in screen coordinates — where a popup's *trigger*
 * is, rather than where to put the popup. What a surface has to know when
 * it points back at the thing it belongs to: a tooltip's arrow aims at the
 * middle of the trigger, and that stops being the middle of the tooltip as
 * soon as a screen edge slides one of the two.
 */
export function screenRect(node: DrawnNode): Rect | null;

/** `anchorRect` bound to a ref, recomputed on demand. */
export function useAnchor(
  ref: RefObject<DrawnNode | null>,
): (options?: AnchorOptions) => AnchorRect | null;

/**
 * Keeps an `anchorRect` live for as long as `active`, instead of measuring
 * once at open time: a scrolled ancestor, the node's own layout moving it,
 * or the owner window being repositioned by the WM or a script each call
 * `setRect` again with the new rect. `getOptions` is read fresh on every
 * change, so it need not be memoized. `setRect` is only called when the
 * measured rect actually differs from the previous one.
 *
 * If the anchor node scrolls (or is laid out) entirely past a clipping
 * ancestor or the owner window, `onOutOfView` is called instead of moving
 * the popup there — a popup is a real window, not a web element clipped by
 * its ancestors, so following a trigger that is no longer visible would
 * leave it pointing at nothing. Typically `onOutOfView` closes the popup.
 * With an `at` in the options that test is about the sub-rect: a caret
 * leaves the viewport long before the editor around it does.
 */
export function useAnchorTracking(
  ref: RefObject<DrawnNode | null>,
  active: boolean,
  getOptions: () => AnchorOptions | null | undefined,
  setRect: (
    next: AnchorRect | null | ((prev: AnchorRect | null) => AnchorRect | null),
  ) => void,
  onOutOfView?: () => void,
): void;

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

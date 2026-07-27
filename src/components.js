// Widget components built purely on the host primitives — no reconciler
// support needed. Plain createElement (no JSX) so the library stays
// build-step-free for consumers.
import React, {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

const h = React.createElement;

const ITEM_HEIGHT = 28;
const MAX_MENU_HEIGHT = 220;

const XK_RETURN = 0xff0d;
const XK_ESCAPE = 0xff1b;
const XK_HOME = 0xff50;
const XK_LEFT = 0xff51;
const XK_UP = 0xff52;
const XK_RIGHT = 0xff53;
const XK_DOWN = 0xff54;
const XK_PAGE_UP = 0xff55;
const XK_PAGE_DOWN = 0xff56;
const XK_END = 0xff57;

const DefaultTheme = {
  border: '#b2bec3',
  borderActive: '#2980b9',
  background: 'white',
  text: '#2d3436',
  dim: '#7f8c8d',
  hoverBackground: '#2980b9',
  hoverText: 'white',
  accent: '#2980b9',
  accentHover: '#1f6693',
  accentText: 'white',
  surfaceHover: '#f1f2f6',
  track: '#dfe6e9',
};

const ThemeContext = React.createContext(DefaultTheme);
/** Themes all widgets; partial palettes merge over the defaults. */
export const ThemeProvider = ThemeContext.Provider;
export const SelectThemeProvider = ThemeContext.Provider; // back-compat alias

function useTheme() {
  const theme = useContext(ThemeContext);
  return theme === DefaultTheme ? theme : { ...DefaultTheme, ...theme };
}

/** Shared interactive-control plumbing: hover/focus state plus the box
 * props wiring them, click + Space/Enter activation. */
function useControl(disabled, onActivate) {
  const [hover, setHover] = useState(false);
  const [focused, setFocused] = useState(false);
  const props = disabled
    ? {}
    : {
        focusable: true,
        cursor: 'pointer',
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        onFocus: () => setFocused(true),
        onBlur: () => setFocused(false),
        onClick: () => onActivate?.(),
        onKeyDown: (ev) => {
          if (ev.codepoint === 32 || ev.keysym === XK_RETURN) onActivate?.();
        },
      };
  return { hover: hover && !disabled, focused: focused && !disabled, props };
}

/** The X screen the node's window lives on, if reachable (the smoke-test
 *  mock app has no screen geometry — callers must cope with null). */
function screenOf(node) {
  const app = node?.app;
  const screen = (app?.display ?? app?.X?.display)?.screen?.[0];
  return screen?.pixel_width ? screen : null;
}

/**
 * Where to put a `<popup>` anchored to a drawn node, in **screen**
 * coordinates: the owner window's position plus the node's laid-out rect.
 *
 * `placement` is a preference, not a promise — a menu near the bottom of
 * the screen flips above its trigger rather than opening off-screen, and
 * the result is clamped into the screen either way. The chosen side comes
 * back as `placement` so the caller can style accordingly.
 */
export function anchorRect(node, options = {}) {
  if (!node?.abs) return null;
  const {
    placement = 'bottom',
    align = 'start',
    offset = 2,
    width = node.abs.width,
    height = 0,
  } = options;

  const win = node.root?.window;
  const ax = (win?.x ?? 0) + node.abs.x;
  const ay = (win?.y ?? 0) + node.abs.y;
  const aw = node.abs.width;
  const ah = node.abs.height;

  const screen = screenOf(node);
  const sw = screen?.pixel_width;
  const sh = screen?.pixel_height;

  const alignAlong = (start, size, extent) =>
    align === 'center'
      ? start + (size - extent) / 2
      : align === 'end'
        ? start + size - extent
        : start;

  let side = placement;
  let x;
  let y;

  if (side === 'bottom' || side === 'top') {
    const below = ay + ah + offset;
    const above = ay - height - offset;
    if (side === 'bottom' && sh != null && below + height > sh && above >= 0) {
      side = 'top';
    } else if (
      side === 'top' &&
      above < 0 &&
      (sh == null || below + height <= sh)
    ) {
      side = 'bottom';
    }
    y = side === 'bottom' ? below : above;
    x = alignAlong(ax, aw, width);
  } else {
    const after = ax + aw + offset;
    const before = ax - width - offset;
    if (side === 'right' && sw != null && after + width > sw && before >= 0) {
      side = 'left';
    } else if (
      side === 'left' &&
      before < 0 &&
      (sw == null || after + width <= sw)
    ) {
      side = 'right';
    }
    x = side === 'right' ? after : before;
    y = alignAlong(ay, ah, height);
  }

  if (sw != null) x = Math.max(0, Math.min(x, sw - width));
  if (sh != null && height) y = Math.max(0, Math.min(y, sh - height));

  return { x: Math.round(x), y: Math.round(y), width, height, placement: side };
}

/**
 * useAnchor(ref) — stable `measure(options)` returning `anchorRect` for the
 * referenced node. The anchoring math `Select` used to inline, shared with
 * `Tooltip` and anything else that hangs a `<popup>` off a drawn node.
 */
export function useAnchor(ref) {
  return useCallback((options) => anchorRect(ref.current, options), [ref]);
}

/** Measured size of a single-line label, for sizing a popup around it.
 *  Falls back to a rough estimate where no font stack is available. */
function measureLabel(node, text, style) {
  const fonts = node?.app?.fonts;
  const size = style?.size ?? DEFAULT_LABEL_SIZE;
  if (!fonts?.layout) {
    return { width: String(text).length * size * 0.55, height: size * 1.4 };
  }
  const layout = fonts.layout(String(text), {
    family: style?.family ?? 'sans-serif',
    size,
    weight: style?.weight ?? 'normal',
  });
  return { width: layout.width, height: layout.height };
}

const DEFAULT_LABEL_SIZE = 13;

/** String/number children become a <text>; elements pass through. */
function labelContent(children, textProps) {
  return React.Children.map(children, (child) =>
    typeof child === 'string' || typeof child === 'number'
      ? h('text', textProps, child)
      : child,
  );
}

/**
 * <Button onPress primary disabled …boxProps>label</Button> — the standard
 * push button the examples kept re-implementing: hover/focus feedback,
 * Space/Enter activation, pointer cursor.
 */
export function Button({
  children,
  label,
  onPress,
  primary = false,
  disabled = false,
  ...boxProps
}) {
  const theme = useTheme();
  const { hover, focused, props } = useControl(disabled, onPress);
  const background = disabled
    ? theme.surfaceHover
    : primary
      ? hover
        ? theme.accentHover
        : theme.accent
      : hover
        ? theme.surfaceHover
        : theme.background;
  const color = disabled ? theme.dim : primary ? theme.accentText : theme.text;
  return h(
    'box',
    {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      paddingTop: 8,
      paddingBottom: 8,
      paddingLeft: 16,
      paddingRight: 16,
      borderRadius: 4,
      borderWidth: 1,
      borderColor: disabled
        ? theme.border
        : focused
          ? primary
            ? theme.accentHover
            : theme.borderActive
          : primary
            ? theme.accent
            : theme.border,
      backgroundColor: background,
      ...props,
      ...boxProps,
    },
    labelContent(children ?? label, { color }),
  );
}

/**
 * <Checkbox checked onChange disabled>label</Checkbox> — 16px check well +
 * label row; click or Space toggles (onChange receives the next value).
 */
export function Checkbox({
  children,
  label,
  checked = false,
  onChange,
  disabled = false,
  ...boxProps
}) {
  const theme = useTheme();
  const { focused, props } = useControl(disabled, () => onChange?.(!checked));
  const fill = disabled ? theme.dim : theme.accent;
  return h(
    'box',
    {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      ...props,
      ...boxProps,
    },
    h(
      'box',
      {
        width: 16,
        height: 16,
        borderRadius: 3,
        borderWidth: 1,
        borderColor: checked
          ? fill
          : focused
            ? theme.borderActive
            : theme.border,
        backgroundColor: checked ? fill : theme.background,
        alignItems: 'center',
        justifyContent: 'center',
      },
      checked &&
        h('canvas', {
          width: 10,
          height: 8,
          onDraw: (ctx) => {
            ctx.strokeStyle = theme.accentText;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(1, 4);
            ctx.lineTo(3.5, 6.5);
            ctx.lineTo(9, 1);
            ctx.stroke();
          },
        }),
    ),
    labelContent(children ?? label, {
      color: disabled ? theme.dim : theme.text,
    }),
  );
}

const RadioGroupContext = React.createContext(null);

/**
 * <RadioGroup value onChange>…<Radio value=…>label</Radio>…</RadioGroup> —
 * exclusive choice. Arrow keys move the selection through the group in
 * mount order (wrapping); click or Space selects the focused radio.
 */
export function RadioGroup({ value, onChange, children, ...boxProps }) {
  const order = useRef([]).current;
  const ctx = useMemo(
    () => ({
      value,
      onChange,
      register: (v) => {
        order.push(v);
        return () => order.splice(order.indexOf(v), 1);
      },
      move: (delta) => {
        if (order.length === 0) return;
        const i = order.indexOf(value);
        const next = order[(i + delta + order.length) % order.length];
        if (next !== value) onChange?.(next);
      },
    }),
    [value, onChange, order],
  );
  return h(
    'box',
    { gap: 6, ...boxProps },
    h(RadioGroupContext.Provider, { value: ctx }, children),
  );
}

export function Radio({ value, children, label, disabled = false }) {
  const theme = useTheme();
  const group = useContext(RadioGroupContext);
  if (!group) {
    throw new Error('react-x11: <Radio> must be inside a <RadioGroup>');
  }
  useEffect(() => group.register(value), [group, value]);
  const selected = group.value === value;
  const { focused, props } = useControl(disabled, () => {
    if (!selected) group.onChange?.(value);
  });
  const onKeyDown = props.onKeyDown;
  if (onKeyDown) {
    props.onKeyDown = (ev) => {
      if (ev.keysym === XK_DOWN || ev.keysym === XK_RIGHT) group.move(1);
      else if (ev.keysym === XK_UP || ev.keysym === XK_LEFT) group.move(-1);
      else onKeyDown(ev);
    };
  }
  const fill = disabled ? theme.dim : theme.accent;
  return h(
    'box',
    { flexDirection: 'row', alignItems: 'center', gap: 8, ...props },
    h(
      'box',
      {
        width: 16,
        height: 16,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: selected
          ? fill
          : focused
            ? theme.borderActive
            : theme.border,
        backgroundColor: theme.background,
        alignItems: 'center',
        justifyContent: 'center',
      },
      selected &&
        h('box', {
          width: 8,
          height: 8,
          borderRadius: 4,
          backgroundColor: fill,
        }),
    ),
    labelContent(children ?? label, {
      color: disabled ? theme.dim : theme.text,
    }),
  );
}

/**
 * <Switch checked onChange disabled/> — Checkbox semantics in a sliding
 * pill; the thumb sits at the end matching the state.
 */
export function Switch({
  checked = false,
  onChange,
  disabled = false,
  ...boxProps
}) {
  const theme = useTheme();
  const { focused, props } = useControl(disabled, () => onChange?.(!checked));
  return h(
    'box',
    {
      width: 36,
      height: 20,
      borderRadius: 10,
      padding: 2,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: checked ? 'flex-end' : 'flex-start',
      backgroundColor: disabled
        ? theme.track
        : checked
          ? theme.accent
          : focused
            ? theme.dim
            : theme.border,
      ...props,
      ...boxProps,
    },
    h('box', {
      width: 16,
      height: 16,
      borderRadius: 8,
      backgroundColor: theme.background,
    }),
  );
}

/**
 * <ProgressBar value/> — determinate progress, value in [0, 1].
 */
export function ProgressBar({
  value = 0,
  color,
  trackColor,
  height = 8,
  ...boxProps
}) {
  const theme = useTheme();
  const clamped = Math.min(1, Math.max(0, value));
  return h(
    'box',
    {
      height,
      borderRadius: height / 2,
      backgroundColor: trackColor ?? theme.track,
      overflow: 'hidden',
      flexDirection: 'row',
      ...boxProps,
    },
    h('box', {
      width: `${clamped * 100}%`,
      borderRadius: height / 2,
      backgroundColor: color ?? theme.accent,
    }),
  );
}

const SLIDER_THUMB = 16;

/**
 * <Slider value min max step onChange disabled …boxProps> — draggable
 * value control.
 *
 * Dragging uses pointer capture (`ev.capturePointer()`): once the press
 * lands, move and up events keep coming to the track even when the pointer
 * leaves it, so the thumb still tracks a pointer that has wandered far
 * outside the widget — and releasing out there still ends the drag.
 *
 * Keyboard: arrows step, Home/End jump to the ends, PageUp/PageDown move
 * by ten steps.
 */
export function Slider({
  value = 0,
  min = 0,
  max = 100,
  step = 1,
  onChange,
  disabled = false,
  width,
  height = 4,
  ...boxProps
}) {
  const theme = useTheme();
  const [focused, setFocused] = useState(false);
  const [dragging, setDragging] = useState(false);
  const trackRef = useRef(null);

  const span = max - min || 1;
  const clamp = (v) => Math.min(max, Math.max(min, v));
  const quantize = (v) => {
    if (!step) return clamp(v);
    // round to the step grid measured from min, then trim float noise so
    // 0.1-style steps do not accumulate 0.30000000000000004
    const snapped = min + Math.round((v - min) / step) * step;
    const decimals = (String(step).split('.')[1] ?? '').length;
    return clamp(decimals ? Number(snapped.toFixed(decimals)) : snapped);
  };
  const fraction = (clamp(value) - min) / span;

  const emit = (next) => {
    if (next !== value) onChange?.(next);
  };

  /** Pointer x -> value, using the track's laid-out rect. */
  const valueAt = (ev) => {
    const node = trackRef.current;
    if (!node?.abs?.width) return value;
    // the thumb is centred on the value, so the usable travel is the track
    // minus one thumb width — otherwise min/max are unreachable at the ends
    const travel = Math.max(1, node.abs.width - SLIDER_THUMB);
    const x = ev.x - node.abs.x - SLIDER_THUMB / 2;
    return quantize(min + (Math.min(travel, Math.max(0, x)) / travel) * span);
  };

  const controlProps = disabled
    ? {}
    : {
        focusable: true,
        cursor: 'pointer',
        onFocus: () => setFocused(true),
        onBlur: () => setFocused(false),
        onMouseDown: (ev) => {
          ev.capturePointer();
          setDragging(true);
          emit(valueAt(ev));
        },
        onMouseMove: (ev) => {
          if (dragging) emit(valueAt(ev));
        },
        onMouseUp: () => setDragging(false),
        onKeyDown: (ev) => {
          const big = (step || 1) * 10;
          switch (ev.keysym) {
            case XK_LEFT:
            case XK_DOWN:
              emit(quantize(clamp(value - (step || 1))));
              return;
            case XK_RIGHT:
            case XK_UP:
              emit(quantize(clamp(value + (step || 1))));
              return;
            case XK_HOME:
              emit(min);
              return;
            case XK_END:
              emit(max);
              return;
            case XK_PAGE_UP:
              emit(quantize(clamp(value + big)));
              return;
            case XK_PAGE_DOWN:
              emit(quantize(clamp(value - big)));
              return;
            default:
              break;
          }
        },
      };

  return h(
    'box',
    {
      ref: trackRef,
      width,
      height: SLIDER_THUMB,
      justifyContent: 'center',
      ...controlProps,
      ...boxProps,
    },
    // track
    h(
      'box',
      {
        height,
        borderRadius: height / 2,
        backgroundColor: theme.track,
        flexDirection: 'row',
        alignItems: 'center',
        pointerEvents: 'none',
      },
      h('box', {
        width: `${fraction * 100}%`,
        height,
        borderRadius: height / 2,
        backgroundColor: disabled ? theme.dim : theme.accent,
      }),
    ),
    // thumb, centred on the value within the same travel the math uses
    h('box', {
      position: 'absolute',
      left: `${fraction * 100}%`,
      marginLeft: -SLIDER_THUMB * fraction,
      width: SLIDER_THUMB,
      height: SLIDER_THUMB,
      borderRadius: SLIDER_THUMB / 2,
      borderWidth: 1,
      borderColor: disabled
        ? theme.border
        : focused || dragging
          ? theme.accentHover
          : theme.border,
      backgroundColor: disabled ? theme.surfaceHover : theme.background,
      pointerEvents: 'none',
    }),
  );
}

const TOOLTIP_PADDING_X = 8;
const TOOLTIP_PADDING_Y = 4;

/**
 * <Tooltip label placement delay>…</Tooltip> — a hover hint in a `<popup>`,
 * so it can extend past the owner window's bounds.
 *
 * Wraps its children in a row box that carries the hover handlers and the
 * anchor ref. Shows after `delay` ms of hover, hides immediately on leave
 * (and on mousedown — a tooltip lingering over a menu you just opened is
 * the classic annoyance). `placement` flips automatically near a screen
 * edge, via the same `useAnchor` math `Select` uses.
 *
 * The popup is sized from the measured label, since a `<popup>` is a real
 * X window and needs its size up front rather than after layout.
 */
export function Tooltip({
  label,
  children,
  placement = 'top',
  delay = 500,
  fontSize = DEFAULT_LABEL_SIZE,
  ...boxProps
}) {
  const theme = useTheme();
  const ref = useRef(null);
  const measureAnchor = useAnchor(ref);
  const [rect, setRect] = useState(null);
  const timer = useRef(null);

  const cancel = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };
  const hide = () => {
    cancel();
    setRect(null);
  };

  // a pending timer must not outlive the component
  useEffect(() => cancel, []);

  const show = () => {
    const node = ref.current;
    if (!node || !label) return;
    const text = measureLabel(node, label, { size: fontSize });
    const width = Math.ceil(text.width) + TOOLTIP_PADDING_X * 2 + 2;
    const height = Math.ceil(text.height) + TOOLTIP_PADDING_Y * 2 + 2;
    const next = measureAnchor({ placement, align: 'center', width, height });
    if (next) setRect(next);
  };

  const onMouseEnter = () => {
    cancel();
    timer.current = setTimeout(() => {
      timer.current = null;
      show();
    }, delay);
  };

  return h(
    'box',
    {
      ref,
      flexDirection: 'row',
      alignItems: 'center',
      onMouseEnter,
      onMouseLeave: hide,
      onMouseDown: hide,
      ...boxProps,
    },
    children,
    rect &&
      h(
        'popup',
        {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          windowType: 'tooltip',
          backgroundColor: theme.text,
        },
        h(
          'box',
          {
            flexGrow: 1,
            borderWidth: 1,
            borderColor: theme.text,
            borderRadius: 3,
            backgroundColor: theme.text,
            justifyContent: 'center',
            paddingLeft: TOOLTIP_PADDING_X,
            paddingRight: TOOLTIP_PADDING_X,
          },
          h('text', { color: theme.background, fontSize }, label),
        ),
      ),
  );
}

// --- menus ------------------------------------------------------------------

const MENU_ITEM_HEIGHT = 26;
const MENU_SEPARATOR_HEIGHT = 7;
const MENU_MIN_WIDTH = 140;
const MENU_PAD = 4;
const MENU_GUTTER = 24; // room for the check column
const MENU_SHORTCUT_GAP = 24;

const isSelectable = (item) => item && !item.separator && !item.disabled;

/** Total popup height for a menu's items (separators are shorter). */
function menuListHeight(items) {
  const body = items.reduce(
    (sum, item) =>
      sum + (item.separator ? MENU_SEPARATOR_HEIGHT : MENU_ITEM_HEIGHT),
    0,
  );
  return body + MENU_PAD * 2 + 2;
}

/** Widest label + shortcut, measured, so the popup can be sized up front. */
function menuListWidth(node, items, fontSize) {
  let widest = 0;
  for (const item of items) {
    if (item.separator) continue;
    const label = measureLabel(node, item.label ?? '', {
      size: fontSize,
    }).width;
    const shortcut = item.shortcut
      ? measureLabel(node, item.shortcut, { size: fontSize }).width +
        MENU_SHORTCUT_GAP
      : 0;
    widest = Math.max(widest, label + shortcut);
  }
  return Math.max(
    MENU_MIN_WIDTH,
    Math.ceil(widest) + MENU_GUTTER + MENU_PAD * 2 + 12,
  );
}

/** Next selectable index in `dir`, wrapping, skipping separators/disabled. */
function nextSelectable(items, from, dir) {
  const n = items.length;
  if (!n) return -1;
  for (let step = 1; step <= n; step++) {
    const i = (from + dir * step + n * step) % n;
    if (isSelectable(items[i])) return i;
  }
  return -1;
}

function MenuRow({ item, active, onHover, onSelect, fontSize }) {
  const theme = useTheme();
  if (item.separator) {
    return h(
      'box',
      { height: MENU_SEPARATOR_HEIGHT, justifyContent: 'center' },
      h('box', { height: 1, backgroundColor: theme.border }),
    );
  }
  const dim = item.disabled;
  return h(
    'box',
    {
      height: MENU_ITEM_HEIGHT,
      flexDirection: 'row',
      alignItems: 'center',
      paddingLeft: 8,
      paddingRight: 8,
      cursor: dim ? undefined : 'pointer',
      backgroundColor: active ? theme.hoverBackground : theme.background,
      onMouseEnter: dim ? undefined : onHover,
      onClick: dim ? undefined : () => onSelect(item),
    },
    h(
      'box',
      { width: MENU_GUTTER - 8, alignItems: 'center' },
      item.checked &&
        h('text', {
          color: active ? theme.hoverText : theme.text,
          fontSize,
          children: '✓',
        }),
    ),
    h(
      'text',
      {
        color: dim ? theme.dim : active ? theme.hoverText : theme.text,
        fontSize,
      },
      item.label,
    ),
    h('box', { flexGrow: 1 }),
    item.shortcut &&
      h(
        'text',
        {
          color: dim ? theme.dim : active ? theme.hoverText : theme.dim,
          fontSize,
        },
        item.shortcut,
      ),
  );
}

/**
 * The menu popup itself: an override-redirect `<popup>` at `rect` holding a
 * list of items. Shared by `MenuBar` and `ContextMenu`; `rect` comes from
 * `useAnchor`, so menus flip at screen edges like `Select`'s.
 */
function MenuPopup({ rect, items, activeIndex, onHover, onSelect, fontSize }) {
  const theme = useTheme();
  return h(
    'popup',
    {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      windowType: 'popup_menu',
      backgroundColor: theme.background,
    },
    h(
      'box',
      {
        flexGrow: 1,
        flexShrink: 1,
        padding: MENU_PAD,
        borderWidth: 1,
        borderColor: theme.border,
        backgroundColor: theme.background,
      },
      items.map((item, index) =>
        h(MenuRow, {
          key: item.separator ? `sep-${index}` : (item.key ?? item.label),
          item,
          active: index === activeIndex,
          fontSize,
          onHover: () => onHover(index),
          onSelect,
        }),
      ),
    ),
  );
}

/**
 * Keyboard handling shared by every menu: Up/Down move the active item
 * (skipping separators and disabled entries, wrapping), Home/End jump to
 * the ends, Enter/Space activate, Escape closes. Returns true when the key
 * was consumed so callers can add their own (MenuBar adds Left/Right).
 */
function handleMenuKey(
  ev,
  { items, activeIndex, setActiveIndex, select, close },
) {
  switch (ev.keysym) {
    case XK_ESCAPE:
      close();
      return true;
    case XK_DOWN:
      setActiveIndex(nextSelectable(items, activeIndex, 1));
      return true;
    case XK_UP:
      setActiveIndex(nextSelectable(items, activeIndex, -1));
      return true;
    case XK_HOME:
      setActiveIndex(nextSelectable(items, -1, 1));
      return true;
    case XK_END:
      setActiveIndex(nextSelectable(items, items.length, -1));
      return true;
    default:
      break;
  }
  if (ev.codepoint === 32 || ev.keysym === XK_RETURN) {
    const item = items[activeIndex];
    if (isSelectable(item)) select(item);
    return true;
  }
  return false;
}

/**
 * <ContextMenu items>…</ContextMenu> — right-click anywhere in the children
 * to open a menu at the pointer.
 *
 * The wrapper is focusable and takes focus when the menu opens, because the
 * popup is override-redirect and never gets focus itself — the same trick
 * `Select` uses to keep arrow keys working while its menu is open.
 */
export function ContextMenu({
  items = [],
  children,
  onSelect,
  fontSize = DEFAULT_LABEL_SIZE,
  ...boxProps
}) {
  const ref = useRef(null);
  const [rect, setRect] = useState(null);
  const [activeIndex, setActiveIndex] = useState(-1);

  const close = () => {
    setRect(null);
    setActiveIndex(-1);
  };
  const select = (item) => {
    close();
    item.onSelect?.(item);
    onSelect?.(item);
  };

  const openAt = (ev) => {
    const node = ref.current;
    if (!node || !items.length) return;
    const width = menuListWidth(node, items, fontSize);
    const height = menuListHeight(items);
    const screen = screenOf(node);
    // anchored at the pointer rather than at a widget: clamp by hand, since
    // there is no anchor rect to flip around
    const x = ev.nativeEvent?.rootx ?? ev.x;
    const y = ev.nativeEvent?.rooty ?? ev.y;
    setRect({
      x: screen ? Math.max(0, Math.min(x, screen.pixel_width - width)) : x,
      y: screen ? Math.max(0, Math.min(y, screen.pixel_height - height)) : y,
      width,
      height,
    });
    setActiveIndex(-1);
    node.root?.events?.focus?.(node);
  };

  return h(
    'box',
    {
      ref,
      focusable: true,
      onMouseDown: (ev) => {
        if (ev.button === 3) openAt(ev);
        else if (rect) close();
      },
      onKeyDown: (ev) => {
        if (!rect) return;
        handleMenuKey(ev, {
          items,
          activeIndex,
          setActiveIndex,
          select,
          close,
        });
      },
      onBlur: close,
      ...boxProps,
    },
    children,
    rect &&
      h(MenuPopup, {
        rect,
        items,
        activeIndex,
        fontSize,
        onHover: setActiveIndex,
        onSelect: select,
      }),
  );
}

/**
 * <MenuBar menus={[{ label, items }]}/> — a horizontal bar of pull-down
 * menus. Click or Enter opens; with one open, hovering another switches to
 * it and Left/Right walk the bar; the usual menu keys work inside.
 */
export function MenuBar({
  menus = [],
  onSelect,
  fontSize = DEFAULT_LABEL_SIZE,
  ...boxProps
}) {
  const theme = useTheme();
  const [openIndex, setOpenIndex] = useState(-1);
  const [rect, setRect] = useState(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const refs = useRef([]);

  const items = openIndex >= 0 ? (menus[openIndex]?.items ?? []) : [];

  const close = () => {
    setOpenIndex(-1);
    setRect(null);
    setActiveIndex(-1);
  };

  const openMenu = (index) => {
    const node = refs.current[index];
    const menu = menus[index];
    if (!node || !menu?.items?.length) return;
    const width = menuListWidth(node, menu.items, fontSize);
    const height = menuListHeight(menu.items);
    const next = anchorRect(node, { placement: 'bottom', width, height });
    if (!next) return;
    setRect(next);
    setOpenIndex(index);
    setActiveIndex(-1);
  };

  const select = (item) => {
    close();
    item.onSelect?.(item);
    onSelect?.(item);
  };

  const moveMenu = (dir) => {
    if (!menus.length) return;
    const n = menus.length;
    openMenu((openIndex + dir + n) % n);
  };

  return h(
    'box',
    {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.surfaceHover,
      ...boxProps,
    },
    menus.map((menu, index) =>
      h(
        'box',
        {
          key: menu.label,
          ref: (node) => {
            refs.current[index] = node;
          },
          focusable: true,
          cursor: 'pointer',
          paddingLeft: 10,
          paddingRight: 10,
          paddingTop: 6,
          paddingBottom: 6,
          backgroundColor:
            openIndex === index ? theme.hoverBackground : 'transparent',
          onClick: () => (openIndex === index ? close() : openMenu(index)),
          // with a menu already open, hovering the bar switches menus —
          // standard pull-down behaviour
          onMouseEnter: () => {
            if (openIndex >= 0 && openIndex !== index) openMenu(index);
          },
          onBlur: () => {
            if (openIndex === index) close();
          },
          onKeyDown: (ev) => {
            if (ev.keysym === XK_LEFT) return moveMenu(-1);
            if (ev.keysym === XK_RIGHT) return moveMenu(1);
            if (openIndex !== index) {
              if (ev.codepoint === 32 || ev.keysym === XK_RETURN) {
                openMenu(index);
              }
              return;
            }
            handleMenuKey(ev, {
              items,
              activeIndex,
              setActiveIndex,
              select,
              close,
            });
          },
        },
        h(
          'text',
          {
            color: openIndex === index ? theme.hoverText : theme.text,
            fontSize,
          },
          menu.label,
        ),
      ),
    ),
    openIndex >= 0 &&
      rect &&
      h(MenuPopup, {
        rect,
        items,
        activeIndex,
        fontSize,
        onHover: setActiveIndex,
        onSelect: select,
      }),
  );
}

function normalizeOption(option) {
  return typeof option === 'object' && option !== null
    ? option
    : { value: option, label: String(option) };
}

function Option({ option, selected, active, onPick, onHover, nodeRef }) {
  const theme = useTheme();
  // one highlight, shared by pointer and keyboard: hovering moves the
  // active index rather than tracking a second, competing state
  return h(
    'box',
    {
      ref: nodeRef,
      height: ITEM_HEIGHT,
      justifyContent: 'center',
      paddingLeft: 10,
      cursor: 'pointer',
      backgroundColor: active ? theme.hoverBackground : theme.background,
      onMouseEnter: () => onHover?.(),
      onClick: () => onPick(option),
    },
    h(
      'text',
      {
        color: active ? theme.hoverText : theme.text,
        fontWeight: selected ? 'bold' : 'normal',
      },
      option.label,
    ),
  );
}

/**
 * <Select value options onChange placeholder width …boxProps> — a dropdown
 * built on <popup>. The menu is a real override-redirect X11 window
 * anchored below the trigger (owner window position + trigger rect).
 * Closes on pick, Escape, toggling the trigger, or focus loss within the
 * owner window.
 *
 * Keyboard (the trigger keeps focus while the menu is open — the popup is
 * override-redirect and never takes it): Up/Down open the menu, then move
 * the active option with wrapping; Home/End jump to the ends; Enter/Space
 * pick the active option (or open the menu when closed); Escape closes.
 * The active option is scrolled into view.
 */
export function Select({
  value,
  options = [],
  onChange,
  placeholder = 'Select…',
  width,
  ...boxProps
}) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState(null);
  const [focused, setFocused] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const triggerRef = useRef(null);
  const scrollRef = useRef(null);
  const activeRef = useRef(null);

  const measureAnchor = useAnchor(triggerRef);

  const normalized = options.map(normalizeOption);
  const current = normalized.find((o) => o.value === value);
  const menuHeight = Math.min(
    normalized.length * ITEM_HEIGHT + 8,
    MAX_MENU_HEIGHT,
  );

  const close = () => setOpen(false);
  const openMenu = () => {
    const node = triggerRef.current;
    if (!node) return;
    // shared anchoring: also flips the menu above the trigger when there is
    // no room below, instead of opening off the bottom of the screen
    const rect = measureAnchor({ placement: 'bottom', height: menuHeight + 2 });
    if (!rect) return;
    setAnchor(rect);
    const selected = normalized.findIndex((o) => o.value === value);
    setActiveIndex(selected >= 0 ? selected : 0);
    setOpen(true);
  };
  const toggle = () => (open ? close() : openMenu());

  const pick = (option) => {
    close();
    if (option.value !== value) onChange?.(option.value);
  };

  const move = (delta) => {
    const count = normalized.length;
    if (!count) return;
    setActiveIndex((i) => (i < 0 ? 0 : (i + delta + count) % count));
  };

  const onKeyDown = (ev) => {
    const count = normalized.length;
    switch (ev.keysym) {
      case XK_ESCAPE:
        if (open) close();
        return;
      case XK_DOWN:
      case XK_UP:
        if (open) move(ev.keysym === XK_DOWN ? 1 : -1);
        else openMenu();
        return;
      case XK_HOME:
      case XK_END:
        if (open && count)
          setActiveIndex(ev.keysym === XK_HOME ? 0 : count - 1);
        return;
      default:
        break;
    }
    if (ev.codepoint === 32 || ev.keysym === XK_RETURN) {
      const option = open ? normalized[activeIndex] : null;
      if (option) pick(option);
      else toggle();
    }
  };

  // keep the highlighted option visible while arrowing through a menu that
  // overflows MAX_MENU_HEIGHT (resolved on the popup's next layout pass)
  useEffect(() => {
    if (open) scrollRef.current?.scrollIntoView(activeRef.current);
  }, [open, activeIndex]);

  return h(
    'box',
    {
      ref: triggerRef,
      focusable: true,
      cursor: 'pointer',
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      width,
      padding: 8,
      paddingLeft: 10,
      paddingRight: 10,
      borderWidth: 1,
      borderRadius: 4,
      borderColor: focused || open ? theme.borderActive : theme.border,
      backgroundColor: theme.background,
      onClick: toggle,
      onFocus: () => setFocused(true),
      onBlur: () => {
        setFocused(false);
        close();
      },
      onKeyDown,
      ...boxProps,
    },
    h(
      'text',
      { color: current ? theme.text : theme.dim },
      current ? current.label : placeholder,
    ),
    h('box', { flexGrow: 1 }),
    h('canvas', {
      width: 10,
      height: 6,
      onDraw: (ctx, { width: w, height: hgt }) => {
        ctx.fillStyle = theme.dim;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(w, 0);
        ctx.lineTo(w / 2, hgt);
        ctx.closePath();
        ctx.fill();
      },
    }),
    open &&
      anchor &&
      h(
        'popup',
        {
          x: anchor.x,
          y: anchor.y,
          width: anchor.width,
          height: menuHeight + 2,
          backgroundColor: theme.background,
        },
        h(
          'box',
          {
            flexGrow: 1,
            // yoga's default flexShrink is 0: without this the frame keeps
            // its content height, the scrollview inside it never shrinks to
            // the viewport, and a menu longer than MAX_MENU_HEIGHT gets
            // clipped by the popup's edge instead of scrolling
            flexShrink: 1,
            borderWidth: 1,
            borderColor: theme.border,
            backgroundColor: theme.background,
          },
          h(
            'scrollview',
            { ref: scrollRef, flexGrow: 1, padding: 4 },
            normalized.map((option, index) =>
              h(Option, {
                key: String(option.value),
                option,
                selected: option.value === value,
                active: index === activeIndex,
                nodeRef: index === activeIndex ? activeRef : undefined,
                onHover: () => setActiveIndex(index),
                onPick: pick,
              }),
            ),
          ),
        ),
      ),
  );
}

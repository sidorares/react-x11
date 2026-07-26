// Widget components built purely on the host primitives — no reconciler
// support needed. Plain createElement (no JSX) so the library stays
// build-step-free for consumers.
import React, { useContext, useEffect, useMemo, useRef, useState } from 'react';

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

  const normalized = options.map(normalizeOption);
  const current = normalized.find((o) => o.value === value);

  const close = () => setOpen(false);
  const openMenu = () => {
    const node = triggerRef.current;
    if (!node) return;
    const win = node.root?.window;
    setAnchor({
      x: (win?.x ?? 0) + node.abs.x,
      y: (win?.y ?? 0) + node.abs.y + node.abs.height + 2,
      width: node.abs.width,
    });
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

  const menuHeight = Math.min(
    normalized.length * ITEM_HEIGHT + 8,
    MAX_MENU_HEIGHT,
  );

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

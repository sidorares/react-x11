// Widget components built purely on the host primitives — no reconciler
// support needed. Plain createElement (no JSX) so the library stays
// build-step-free for consumers.

import React, { useRef, useState } from 'react';
import { createStyles } from '../styles.js';
import { capTrim, useTheme } from './theme.js';
import {
  useAnchor,
  useAnchorTracking,
  useDismissOnWindowBlur,
} from './anchor.js';
import { CALENDAR_HEIGHT, CALENDAR_WIDTH, Calendar } from './Calendar.js';
import { formatDay, formatDayRange, toDay } from './dates.js';
import { XK_DOWN, XK_ESCAPE, XK_RETURN, XK_UP } from './keys.js';

const h = React.createElement;

// A hairline round the sheet, as the menus and `Select` use: this border is
// where the popup meets the desktop, not a control's outline, so a theme that
// draws 2px borders on its buttons does not get a 2px frame here.
const SHEET_BORDER = 1;

const s = createStyles({
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 8,
    paddingLeft: 10,
    paddingRight: 10,
    cursor: 'pointer',
  },
  label: { flexGrow: 1 },
  icon: { width: 14, height: 14, flexShrink: 0 },
  sheet: { flexGrow: 1, flexShrink: 1, borderWidth: SHEET_BORDER },
});

/** A wall calendar, 14×14: the page, its two hangers and the ruled week. */
function CalendarGlyph({ color }) {
  return h('canvas', {
    style: s.icon,
    onDraw: (ctx, { width, height }) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, 2.5, width - 1, height - 3);
      ctx.beginPath();
      ctx.moveTo(0.5, 6.5);
      ctx.lineTo(width - 0.5, 6.5);
      ctx.moveTo(4.5, 0.5);
      ctx.lineTo(4.5, 3.5);
      ctx.moveTo(width - 4.5, 0.5);
      ctx.lineTo(width - 4.5, 3.5);
      ctx.stroke();
    },
  });
}

/** What the trigger says, when the app has not said it itself. */
function defaultFormat(mode, value, locale) {
  if (mode === 'range') {
    const start = toDay(value?.start);
    const end = toDay(value?.end);
    if (!start) return null;
    if (!end) return `${formatDay(start, locale)} → …`;
    return formatDayRange(start, end, locale);
  }
  const day = toDay(value);
  return day ? formatDay(day, locale) : null;
}

/**
 * <DatePicker value onChange …boxProps> — a `<Calendar>` on a `<popup>`, hung
 * off a field that shows the current date.
 *
 *   <DatePicker value={day} onChange={(ev) => setDay(ev.value)} />
 *   <DatePicker mode="range" value={span} onChange={…} max="2026-12-31" />
 *
 * Every calendar prop passes straight through — `mode`, `min`/`max`,
 * `isDateBlocked`, `spanBlocked`, `dayContent`, `locale`, `weekStartsOn` — and
 * the value has the same shape here as there: a `'YYYY-MM-DD'` day, or
 * `{ start, end }` in range mode.
 *
 * The calendar opens on the **press**, not the release, for the reason
 * `Select`'s menu does: a control whose whole purpose is to be looked at has
 * nothing to gain from waiting out the length of the click. It closes when the
 * value is complete — the day in single mode, the second end of a range — on
 * Escape, on a second press of the trigger, and when the window loses focus.
 *
 * The popup is override-redirect and never takes focus, so the **trigger keeps
 * the keyboard** and hands the calendar its keys: Down/Up/Enter/Space open it,
 * and once it is open everything the grid understands (arrows, Home/End,
 * PageUp/PageDown, Enter, Space) goes there. Escape and Tab stay here, which
 * is why `handleKey` reports whether it took the key.
 *
 * `format(value)` is the seam for the label: the default is the locale's
 * medium date, and `Intl`'s own range format when there are two of them, which
 * collapses the parts the ends share ("7 – 12 Aug 2026").
 */
export function DatePicker({
  mode = 'single',
  value,
  defaultValue,
  onChange,
  name,
  month,
  defaultMonth,
  onMonthChange,
  min,
  max,
  isDateBlocked,
  spanBlocked,
  dayContent,
  locale,
  weekStartsOn,
  format,
  placeholder,
  disabled = false,
  style,
  ...boxProps
}) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState(null);
  const [focused, setFocused] = useState(false);
  const [ownValue, setOwnValue] = useState(defaultValue ?? null);
  const triggerRef = useRef(null);
  const calendarRef = useRef(null);

  const measureAnchor = useAnchor(triggerRef);
  const current = value === undefined ? ownValue : value;

  const width = CALENDAR_WIDTH + SHEET_BORDER * 2;
  const height = CALENDAR_HEIGHT + SHEET_BORDER * 2;
  const anchorOptions = () => ({ placement: 'bottom', width, height });

  const close = () => setOpen(false);
  const openCalendar = () => {
    const rect = measureAnchor(anchorOptions());
    if (!rect) return;
    setAnchor(rect);
    setOpen(true);
  };
  const toggle = () => (open ? close() : openCalendar());

  // the same two the other popups take: keep the sheet under the trigger while
  // anything moves it, and shut it when the window itself loses focus (the
  // trigger keeps its focus, so its own onBlur never hears about that)
  useAnchorTracking(triggerRef, open, anchorOptions, setAnchor, close);
  useDismissOnWindowBlur(triggerRef, open, close);

  const handleChange = (ev) => {
    if (value === undefined) setOwnValue(ev.value);
    onChange?.(ev);
    // a half-picked range is the one selection that is not finished, and the
    // calendar has to stay up for the other end of it
    if (mode !== 'range' || ev.value?.end) close();
  };

  const onKeyDown = (ev) => {
    if (ev.keysym === XK_ESCAPE) {
      if (open) close();
      return;
    }
    if (open && calendarRef.current?.handleKey(ev)) return;
    if (
      ev.keysym === XK_DOWN ||
      ev.keysym === XK_UP ||
      ev.keysym === XK_RETURN ||
      ev.codepoint === 32
    ) {
      if (!open) openCalendar();
    }
  };

  const label = format ? format(current) : defaultFormat(mode, current, locale);
  const empty = label == null || label === '';
  const text = empty
    ? (placeholder ?? (mode === 'range' ? 'Pick dates…' : 'Pick a date…'))
    : label;

  return h(
    'box',
    {
      theme,
      role: 'combobox',
      'aria-expanded': Boolean(open),
      'aria-haspopup': 'dialog',
      disabled: disabled || undefined,
      ref: triggerRef,
      focusable: !disabled,
      onMouseDown: disabled ? undefined : toggle,
      onFocus: () => setFocused(true),
      onBlur: () => {
        setFocused(false);
        close();
      },
      onKeyDown: disabled ? undefined : onKeyDown,
      ...boxProps,
      style: [
        s.trigger,
        {
          cursor: disabled ? 'default' : 'pointer',
          borderWidth: theme.borderWidth,
          borderRadius: theme.radius,
          borderColor: focused || open ? theme.borderFocus : theme.border,
          backgroundColor: disabled ? theme.surfaceHover : theme.surface,
        },
        // hover and press say "this opens", so they belong to the trigger
        // while it is shut and are simply not declared once the calendar is
        // down — a state block always outranks the base style, so the only
        // way for the open look to win is for nothing to be competing
        !disabled &&
          !open && {
            ':hover': { backgroundColor: theme.surfaceHover },
            ':active': { backgroundColor: theme.surfaceActive },
          },
        style,
      ],
    },
    h(
      'text',
      {
        style: [
          capTrim,
          s.label,
          {
            color: disabled
              ? theme.textMuted
              : empty
                ? theme.textMuted
                : theme.text,
          },
        ],
      },
      text,
    ),
    h(CalendarGlyph, { color: disabled ? theme.border : theme.textMuted }),
    open &&
      anchor &&
      h(
        'popup',
        {
          theme,
          x: anchor.x,
          y: anchor.y,
          width,
          height,
          grab: true,
          onDismiss: close,
          // ARGB where the display has it, so the corners the sheet gives up
          // are the desktop rather than a colour. The window paints nothing
          // itself when it can be seen through — the box below is the whole
          // of the sheet, and a square fill under it would put the corners
          // straight back.
          transparent: true,
          style: {
            backgroundColor: theme.surface,
            '@supports transparency': { backgroundColor: 'transparent' },
          },
        },
        h(
          'box',
          {
            style: [
              s.sheet,
              {
                borderColor: theme.border,
                backgroundColor: theme.surface,
                '@supports transparency': { borderRadius: theme.radiusPopup },
              },
            ],
          },
          h(Calendar, {
            ref: calendarRef,
            mode,
            value: current,
            onChange: handleChange,
            name,
            month,
            defaultMonth,
            onMonthChange,
            min,
            max,
            isDateBlocked,
            spanBlocked,
            dayContent,
            locale,
            weekStartsOn,
            // The trigger owns the keyboard: the popup is override-redirect
            // and never takes focus, so a focusable grid inside it would take
            // focus on the press instead — blurring the trigger, whose onBlur
            // closes the sheet, unmounting the day under the pointer before
            // the release could turn into a click.
            focusable: false,
            // …and because it does not hold the focus, it would not draw the
            // day cursor either, leaving the arrow keys moving something
            // invisible.
            focusVisible: true,
          }),
        ),
      ),
  );
}

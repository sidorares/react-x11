// Widget components built purely on the host primitives — no reconciler
// support needed. Plain createElement (no JSX) so the library stays
// build-step-free for consumers.

import React, { useImperativeHandle, useMemo, useState } from 'react';
import { createStyles, tint } from '../styles.js';
import { useTheme } from './theme.js';
import { changeEvent } from './change.js';
import {
  XK_DOWN,
  XK_END,
  XK_HOME,
  XK_LEFT,
  XK_PAGE_DOWN,
  XK_PAGE_UP,
  XK_RETURN,
  XK_RIGHT,
  XK_UP,
} from './keys.js';
import {
  addDays,
  addMonths,
  clampDay,
  dayParts,
  firstOfMonth,
  formatMonth,
  localeWeekStart,
  monthGrid,
  monthOf,
  toDay,
  toMonth,
  today,
  weekdayLabels,
} from './dates.js';

const h = React.createElement;

// The grid's geometry. A cell is the square the pointer aims at and the band
// runs through; the pill inside it is what gets filled, rounded and hovered,
// which is what leaves the band visible on either side of a selected end.
const CELL_W = 36;
const CELL_H = 32;
const PILL_W = 32;
const PILL_H = 28;
// Reserved under the number when `dayContent` is given — and only then, so a
// plain calendar is not 6×8 pixels taller for a feature it is not using.
const MARKER_H = 8;
const NAV = 26;
const PAD = 8;
const GAP = 4;
const WEEKDAY_H = 20;

/**
 * How big a `<Calendar>` lays out — exported because `DatePicker` has to size
 * a real X window around one *before* it is laid out, and a popup that
 * guesses is a popup that clips the last week of the month. Everything the
 * sum reads is a constant above it, so the two cannot drift apart.
 *
 * Eight rows in the column (the header, the weekday names, six weeks), so
 * seven gaps between them.
 */
export const CALENDAR_WIDTH = CELL_W * 7 + PAD * 2;
export const CALENDAR_HEIGHT = PAD * 2 + NAV + WEEKDAY_H + CELL_H * 6 + GAP * 7;

const s = createStyles({
  root: { alignItems: 'flex-start', padding: PAD, gap: GAP },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    width: CELL_W * 7,
    height: NAV,
    flexShrink: 0,
  },
  title: { flexGrow: 1, textAlign: 'center', fontWeight: 'bold' },
  nav: {
    width: NAV,
    height: NAV,
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    transition: { backgroundColor: 80 },
  },
  chevron: { width: 7, height: 12 },
  week: { flexDirection: 'row', flexShrink: 0 },
  weekdayCell: {
    width: CELL_W,
    height: WEEKDAY_H,
    alignItems: 'center',
    justifyContent: 'center',
  },
  weekdayLabel: { fontSize: 11 },
  cell: {
    width: CELL_W,
    height: CELL_H,
    alignItems: 'center',
    justifyContent: 'center',
  },
  band: { position: 'absolute', top: 2, bottom: 2 },
  pill: {
    width: PILL_W,
    height: PILL_H,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    // the 2px the pill gives up on each side of the cell are still part of
    // its target, so the whole square is clickable and the gap between two
    // days is not a dead strip
    hitSlop: 2,
    transition: { backgroundColor: 80 },
  },
  number: { fontSize: 13 },
  markers: {
    flexDirection: 'row',
    height: MARKER_H,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
});

const TRANSPARENT = 'transparent';

/** The selection, with every day normalized — and with the two shapes told
 *  apart loudly, since passing a range to a single-date calendar otherwise
 *  shows up as an empty calendar rather than as the mistake it is. */
function normalizeValue(mode, value) {
  if (mode === 'range') {
    if (value == null) return { start: null, end: null };
    if (typeof value !== 'object' || value instanceof Date) {
      throw new TypeError(
        "react-x11: a range calendar's value is { start, end }, got " +
          `${JSON.stringify(value)}. Drop mode="range" for a single date.`,
      );
    }
    return { start: toDay(value.start), end: toDay(value.end) };
  }
  if (value != null && typeof value === 'object' && !(value instanceof Date)) {
    throw new TypeError(
      "react-x11: a single-date calendar's value is one day, got " +
        `${JSON.stringify(value)}. Pass mode="range" to select a span.`,
    );
  }
  return toDay(value);
}

/**
 * The first blocked day after `start`, up to `last` — where a range that may
 * not contain a blocked day has to stop.
 *
 * Scanned over the days the grid can show rather than per candidate end:
 * nothing off the grid is clickable, and the keyboard's focus is always on it.
 * With no half-picked start there is nothing to scan for.
 */
function firstBlockedAfter(start, last, blocked) {
  if (!start) return null;
  for (let d = addDays(start, 1); d <= last; d = addDays(d, 1)) {
    if (blocked(d)) return d;
  }
  return null;
}

/** The day in `month` with the same day-of-month as `day`, or the last one
 *  the month has — so paging from the 31st does not skip February. */
function sameDayIn(month, day) {
  const wanted = Number(day.slice(8));
  const last = Number(addDays(firstOfMonth(addMonths(month, 1)), -1).slice(8));
  return `${month}-${String(Math.min(wanted, last)).padStart(2, '0')}`;
}

function Chevron({ direction, color }) {
  return h('canvas', {
    style: s.chevron,
    onDraw: (ctx, { width, height }) => {
      const mid = height / 2;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      if (direction === 'left') {
        ctx.moveTo(width - 1, 1);
        ctx.lineTo(1, mid);
        ctx.lineTo(width - 1, height - 1);
      } else {
        ctx.moveTo(1, 1);
        ctx.lineTo(width - 1, mid);
        ctx.lineTo(1, height - 1);
      }
      ctx.stroke();
    },
  });
}

function NavButton({ direction, disabled, onPress, theme }) {
  return h(
    'box',
    {
      role: 'button',
      onClick: disabled ? undefined : onPress,
      style: [
        s.nav,
        {
          borderRadius: theme.radius,
          cursor: disabled ? 'default' : 'pointer',
        },
        !disabled && {
          ':hover': { backgroundColor: theme.surfaceHover },
          ':active': { backgroundColor: theme.surfaceActive },
        },
      ],
    },
    h(Chevron, { direction, color: disabled ? theme.border : theme.dim }),
  );
}

function DayCell({ day, state, theme, band, onPick, onHover, dayContent }) {
  const { blocked, outside, selected, focused } = state;
  const color = selected
    ? theme.accentText
    : blocked || outside
      ? theme.dim
      : theme.text;
  const markers = dayContent?.(day, { ...state, color });

  return h(
    'box',
    { role: 'gridcell', style: s.cell },
    // Behind the pill and out of flow, so an end of the range keeps its own
    // fill while the band still runs out of it towards the next day. Half a
    // cell at each end is what joins one pill to the next without drawing
    // over either.
    band &&
      h('box', {
        style: [
          s.band,
          {
            left: band.opensRight ? CELL_W / 2 : 0,
            right: band.opensLeft ? CELL_W / 2 : 0,
            backgroundColor: tint(theme.accent, 0.18),
          },
        ],
      }),
    h(
      'box',
      {
        onClick: blocked ? undefined : () => onPick(day),
        onMouseEnter: onHover ? () => onHover(day) : undefined,
        style: [
          s.pill,
          {
            cursor: blocked ? 'default' : 'pointer',
            borderRadius: theme.radius,
            backgroundColor: selected ? theme.accent : TRANSPARENT,
            // today keeps its outline whatever else is going on, and every
            // other cell carries the same border in nothing — a border that
            // appears would inset the number by a pixel as the day turns
            borderColor: focused
              ? theme.borderFocus
              : state.today
                ? theme.accent
                : TRANSPARENT,
          },
          !blocked && {
            ':hover': {
              backgroundColor: selected
                ? theme.accentHover
                : theme.surfaceHover,
            },
            ':active': {
              backgroundColor: selected
                ? theme.accentActive
                : theme.surfaceActive,
            },
          },
        ],
      },
      h('text', { style: [s.number, { color }] }, String(Number(day.slice(8)))),
      markers ? h('box', { style: s.markers }, markers) : null,
    ),
  );
}

/**
 * <Calendar value onChange …/> — a month grid: one date, or a range, with any
 * day blockable.
 *
 *   <Calendar value={day} onChange={(ev) => setDay(ev.value)} />
 *   <Calendar mode="range" value={{ start, end }} onChange={…} />
 *
 * **A day is a `'YYYY-MM-DD'` string** in and out (a `Date` is accepted on the
 * way in and read as its local calendar day). See `dates.js` for why: a square
 * on a wall calendar is not an instant, and comparing two of them should not
 * depend on which constructor built them.
 *
 * Blocking is `min`/`max` for the usual bounds and `isDateBlocked(day, parts)`
 * for everything else — weekends, holidays, whatever the server said is taken.
 * `parts` is `{ year, month, day, weekday, date }` so the common cases do not
 * have to parse the string back apart.
 *
 * In `range` mode the first click sets the start and reports
 * `{ start, end: null }`, the second completes it. Clicking before the start
 * re-anchors rather than selecting backwards. **A range may not contain a
 * blocked day**: the preview stops at the first one, because an app that
 * blocked a date did not mean "unless it is in the middle", and a selection
 * that quietly included it would have to be validated all over again on the
 * way out. `spanBlocked` is the other reading — only the ends must be free —
 * for holidays a booking is allowed to run across.
 *
 * `dayContent(day, state)` renders under the number, in a strip the grid
 * reserves only when the prop is there. It is the seam for anything drawn per
 * day — an event dot, a price, an availability count — and `state` carries
 * `{ selected, inRange, blocked, outside, today, focused, color }` so a marker
 * can stay legible on the filled ends of the range.
 *
 * The grid is a **single tab stop**. Arrows move a day at a time and a week at
 * a time, Home/End go to the ends of the week, PageUp/PageDown change month
 * (with Shift, year), Enter and Space select. Moving off the edge of the month
 * turns the page.
 *
 * A calendar inside a popup does not hold the keyboard — the trigger does, on
 * its behalf, because an override-redirect window never takes focus. That is
 * what `focusable: false` plus `focusVisible: true` say together: someone else
 * is feeding this grid its keys through the `handleKey` on its ref, and the
 * day cursor still has to be drawn or the arrows move something invisible.
 */
export function Calendar({
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
  spanBlocked = false,
  dayContent,
  locale,
  weekStartsOn,
  focusable = true,
  focusVisible,
  ref,
  style,
  ...boxProps
}) {
  const theme = useTheme();
  const minDay = toDay(min);
  const maxDay = toDay(max);
  const todayKey = today();

  const [ownValue, setOwnValue] = useState(() =>
    normalizeValue(mode, defaultValue ?? null),
  );
  const selection =
    value === undefined ? ownValue : normalizeValue(mode, value);
  const anchor = mode === 'range' ? selection.start : selection;

  const [ownMonth, setOwnMonth] = useState(
    () =>
      toMonth(defaultMonth) ??
      monthOf(anchor ?? clampDay(todayKey, minDay, maxDay)),
  );
  const visibleMonth = month == null ? ownMonth : toMonth(month);

  const [focusedDay, setFocusedDay] = useState(() =>
    clampDay(anchor ?? todayKey, minDay, maxDay),
  );
  const [focused, setFocused] = useState(false);
  // Only ever set while a range is half-picked, which is the only time the
  // grid repaints on pointer movement: with nothing pending the highlight is
  // a `:hover` block on one cell and React hears nothing about it.
  const [hovered, setHovered] = useState(null);

  const weekStart = weekStartsOn ?? localeWeekStart(locale);
  const weeks = useMemo(
    () => monthGrid(visibleMonth, weekStart),
    [visibleMonth, weekStart],
  );
  const weekdays = useMemo(
    () => weekdayLabels(locale, weekStart),
    [locale, weekStart],
  );

  const isBlocked = (day) => {
    if (minDay && day < minDay) return true;
    if (maxDay && day > maxDay) return true;
    return isDateBlocked ? Boolean(isDateBlocked(day, dayParts(day))) : false;
  };

  const pending =
    mode === 'range' && Boolean(selection.start && !selection.end);

  // The first blocked day after a half-picked start, which is where the range
  // has to stop. Scanned once per render over the days the grid can actually
  // show, rather than per candidate end: nothing outside the grid is clickable
  // and the keyboard's focus is always on it.
  const wall = firstBlockedAfter(
    pending && !spanBlocked ? selection.start : null,
    weeks[5][6],
    isBlocked,
  );

  const canEndAt = (day) =>
    pending &&
    day >= selection.start &&
    !isBlocked(day) &&
    (!wall || day < wall);

  const preview = pending && hovered && canEndAt(hovered) ? hovered : null;
  const bandStart = mode === 'range' ? selection.start : null;
  const bandEnd = mode === 'range' ? (selection.end ?? preview) : null;

  const setMonth = (next) => {
    if (month == null) setOwnMonth(next);
    onMonthChange?.(next);
  };

  const commit = (next) => {
    if (value === undefined) setOwnValue(next);
    onChange?.(
      changeEvent(mode === 'range' ? 'date-range' : 'date', name, next),
    );
  };

  const show = (day) => {
    setFocusedDay(day);
    if (monthOf(day) !== visibleMonth) setMonth(monthOf(day));
  };

  const pick = (day) => {
    if (isBlocked(day)) return;
    if (mode === 'range') {
      if (!pending || day < selection.start) commit({ start: day, end: null });
      else if (canEndAt(day)) commit({ start: selection.start, end: day });
      else return;
    } else {
      commit(day);
    }
    show(day);
  };

  const moveFocus = (delta) =>
    show(clampDay(addDays(focusedDay, delta), minDay, maxDay));

  const stepMonth = (delta) => {
    const next = addMonths(visibleMonth, delta);
    setMonth(next);
    setFocusedDay(clampDay(sameDayIn(next, focusedDay), minDay, maxDay));
  };

  /** Returns whether the key was the calendar's — a picker wrapping this one
   *  still owns Escape and Tab, and has no other way to tell. */
  const handleKey = (ev) => {
    switch (ev.keysym) {
      case XK_LEFT:
        moveFocus(-1);
        return true;
      case XK_RIGHT:
        moveFocus(1);
        return true;
      case XK_UP:
        moveFocus(-7);
        return true;
      case XK_DOWN:
        moveFocus(7);
        return true;
      case XK_HOME:
        moveFocus(-((dayParts(focusedDay).weekday - weekStart + 7) % 7));
        return true;
      case XK_END:
        moveFocus(6 - ((dayParts(focusedDay).weekday - weekStart + 7) % 7));
        return true;
      case XK_PAGE_UP:
        stepMonth(ev.shiftKey ? -12 : -1);
        return true;
      case XK_PAGE_DOWN:
        stepMonth(ev.shiftKey ? 12 : 1);
        return true;
      case XK_RETURN:
        pick(focusedDay);
        return true;
      default:
        break;
    }
    if (ev.codepoint === 32) {
      pick(focusedDay);
      return true;
    }
    return false;
  };

  useImperativeHandle(ref, () => ({ handleKey }));

  const canGoBack = !minDay || firstOfMonth(visibleMonth) > minDay;
  const canGoOn = !maxDay || firstOfMonth(addMonths(visibleMonth, 1)) <= maxDay;

  return h(
    'box',
    {
      theme,
      role: 'grid',
      focusable,
      onKeyDown: handleKey,
      onFocus: () => setFocused(true),
      onBlur: () => setFocused(false),
      // the preview belongs to the pointer, and the pointer has left
      onMouseLeave: pending ? () => setHovered(null) : undefined,
      ...boxProps,
      style: [s.root, style],
    },
    h(
      'box',
      { style: s.header },
      h(NavButton, {
        direction: 'left',
        disabled: !canGoBack,
        theme,
        onPress: () => stepMonth(-1),
      }),
      h(
        'text',
        { style: [s.title, { color: theme.text, fontSize: theme.fontSize }] },
        formatMonth(visibleMonth, locale),
      ),
      h(NavButton, {
        direction: 'right',
        disabled: !canGoOn,
        theme,
        onPress: () => stepMonth(1),
      }),
    ),
    h(
      'box',
      { style: s.week },
      weekdays.map((label, i) =>
        h(
          'box',
          { key: i, style: s.weekdayCell },
          h('text', { style: [s.weekdayLabel, { color: theme.dim }] }, label),
        ),
      ),
    ),
    weeks.map((days, w) =>
      h(
        'box',
        { key: w, style: s.week },
        days.map((day) => {
          const inBand =
            bandStart != null &&
            bandEnd != null &&
            bandStart !== bandEnd &&
            day >= bandStart &&
            day <= bandEnd;
          return h(DayCell, {
            key: day,
            day,
            theme,
            dayContent,
            onPick: pick,
            onHover: pending ? setHovered : undefined,
            band: inBand
              ? { opensRight: day === bandStart, opensLeft: day === bandEnd }
              : null,
            state: {
              blocked: isBlocked(day),
              outside: monthOf(day) !== visibleMonth,
              today: day === todayKey,
              selected:
                mode === 'range'
                  ? day === selection.start || day === bandEnd
                  : day === selection,
              inRange: inBand,
              preview: inBand && selection.end == null,
              focused: (focusVisible ?? focused) && day === focusedDay,
            },
          });
        }),
      ),
    ),
  );
}

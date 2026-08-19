// Widget components built purely on the host primitives — no reconciler
// support needed. Plain createElement (no JSX) so the library stays
// build-step-free for consumers.

import React from 'react';
import { useDesktopSettings } from '../desktopsettingshooks.js';
import { useTheme } from './theme.js';

const h = React.createElement;

// How wide the travelling block is, as a share of the track, and how long it
// takes to cross. 40% is wide enough to read as a thing rather than a tick
// at any bar width, and a little over a second is the cadence GTK, Qt and
// the web all landed near — fast enough to say "working", slow enough not to
// be the loudest thing on the screen.
const BLOCK = '40%';
const CROSSING_MS = 1100;

/**
 * <ProgressBar value/> — determinate progress, value in [0, 1].
 *
 * <ProgressBar indeterminate/> — working, with no idea how far along. A
 * block slides across the track forever, and the bar says `aria-busy` with
 * no value, which is what tells a screen reader that "42%" is not coming.
 *
 * The slide is a **loop** in the style (`animation`,
 * [styling.md](../../docs/styling.md#loops)), not a timer here: it runs on
 * the window's own frame clock, claims the track as its damage every frame
 * instead of invalidating the window, and stops itself when the window is
 * unmapped, minimized or buried. A `setInterval` calling `setState` would
 * do none of those three, and would re-render this component sixty times a
 * second to move a rectangle.
 *
 * The travel is in **percentages of the track**, so nothing here measures
 * anything: the bar is right at whatever width its container gives it and
 * stays right across a resize, with no layout read and no re-render. It is
 * on the logical `start` edge, so the block travels the way the text does.
 *
 * **Reduced motion is honoured twice over.** Core refuses to start the loop
 * when the desktop asks for less motion (`useDesktopSettings().animations`),
 * which is what makes every loop in every app obey it. That leaves the
 * resting look, and it is this component's to choose: the block parks in the
 * middle of the track rather than at its off-screen starting point, so a bar
 * that cannot move still shows something in progress — and not a full track,
 * which is what "finished" looks like.
 */
export function ProgressBar({
  value = 0,
  indeterminate = false,
  color,
  trackColor,
  height = 8,
  style,
  ...boxProps
}) {
  const theme = useTheme();
  const { animations } = useDesktopSettings();
  const clamped = Math.min(1, Math.max(0, value));
  const track = [
    {
      height: height,
      borderRadius: height / 2,
      backgroundColor: trackColor ?? theme.track,
      overflow: 'hidden',
      flexDirection: 'row',
      minWidth: 0,
    },
    style,
  ];
  const aria = indeterminate
    ? { 'aria-busy': true }
    : { 'aria-valuenow': clamped, 'aria-valuemin': 0, 'aria-valuemax': 1 };

  if (indeterminate) {
    const moving = animations !== false;
    return h(
      'box',
      { theme, role: 'progressbar', ...aria, ...boxProps, style: track },
      h('box', {
        style: {
          position: 'absolute',
          top: 0,
          height,
          width: BLOCK,
          // `from` is left off the loop below on purpose: it defaults to
          // what the style declares, so this one value is both where the
          // block rests and where each crossing begins.
          start: moving ? `-${BLOCK}` : '30%',
          borderRadius: height / 2,
          backgroundColor: color ?? theme.accent,
          ...(moving && {
            animation: { start: { to: '100%', duration: CROSSING_MS } },
          }),
        },
      }),
    );
  }

  // The fill is expressed as flex ratios rather than a percentage width: a
  // percentage child resolves against the space available while the parent
  // is still being measured, so it fed back into the track's intrinsic
  // width and made whatever contained the bar grow — a dashboard card with
  // a fuller bar came out wider than one with an empty bar, and overflowed
  // the window. Two flexible boxes with a zero basis contribute nothing.
  // (The indeterminate block above is out of flow, so it is measured by
  // nobody and the same trap does not reach it.)
  return h(
    'box',
    {
      theme,
      role: 'progressbar',
      ...aria,
      ...boxProps,
      style: track,
    },
    h('box', {
      style: {
        flexGrow: clamped,
        flexShrink: 0,
        flexBasis: 0,
        borderRadius: height / 2,
        backgroundColor: color ?? theme.accent,
      },
    }),
    h('box', { style: { flexGrow: 1 - clamped, flexShrink: 0, flexBasis: 0 } }),
  );
}

// Widget components built purely on the host primitives — no reconciler
// support needed. Plain createElement (no JSX) so the library stays
// build-step-free for consumers.

import React from 'react';
import { createStyles } from '../styles.js';
import { changeEvent } from './change.js';
import { useControl, useTheme } from './theme.js';

const h = React.createElement;

const TRACK_WIDTH = 36;
const THUMB = 16;
const INSET = 2;

const TRACK_HEIGHT = 20;
// WCAG 2.2 SC 2.5.8 wants 24px in both directions and the pill is 20 tall.
// Growing the pill would be a redesign of a control whose proportions are
// the point, so the *target* grows instead: `hitSlop` is hit testing only,
// so nothing about the drawing or the layout moves.
const TRACK_SLOP = (24 - TRACK_HEIGHT) / 2;

const s = createStyles({
  track: {
    width: TRACK_WIDTH,
    height: TRACK_HEIGHT,
    borderRadius: 10,
    justifyContent: 'center',
    hitSlop: TRACK_SLOP,
    transition: { backgroundColor: 120 },
  },
  // absolutely positioned so the thumb slides on `start`: `justifyContent`
  // would flip it between the ends with nothing in between to animate. The
  // *logical* inset, so an off switch has its thumb on the side its label
  // starts at and the slide runs the way the text does.
  thumb: {
    position: 'absolute',
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    transition: { start: 120 },
  },
});

const THUMB_OFF = INSET;
const THUMB_ON = TRACK_WIDTH - THUMB - INSET;

/**
 * <Switch checked onChange disabled style/> — Checkbox semantics in a
 * sliding pill; the thumb slides to the end matching the state.
 * `onChange(ev)`, as `Checkbox`.
 *
 * The hover, press and focus tints are `:hover`/`:active`/`:focus` blocks
 * rather than React state: the renderer already knows which node the pointer
 * is over, which one is held and which one has focus, so lighting the track
 * up is a repaint of one node instead of a re-render of this component and
 * everything under it.
 *
 * The thumb only slides once the switch has actually flipped, which is on
 * the release — so the press is the whole of the feedback in between, and a
 * click held for half a second is half a second of a control that has not
 * answered without it. `:active` marks the press chain rather than the one
 * node under the pointer, which is what lets the track answer a press that
 * landed on the thumb.
 *
 * The slide is a `transition` on `start`, so the animation is the renderer's
 * frame clock rather than a requestAnimationFrame loop written here — and
 * the same declaration animates the track colour with it. It runs on the
 * press tint too: 120ms of fade that *starts* on the press frame, which is
 * the part perception is actually measuring.
 */
export function Switch({
  checked = false,
  onChange,
  name,
  disabled = false,
  style,
  ...boxProps
}) {
  const theme = useTheme();
  const control = useControl(
    disabled,
    () => onChange?.(changeEvent('checkbox', name, !checked)),
    { styled: true },
  );
  return h(
    'box',
    {
      theme,
      role: 'switch',
      'aria-checked': checked,
      ...control.props,
      ...boxProps,
      style: [
        control.style,
        s.track,
        {
          backgroundColor: disabled
            ? theme.track
            : checked
              ? theme.accent
              : theme.border,
        },
        !disabled && {
          ':hover': {
            backgroundColor: checked ? theme.accentHover : theme.textMuted,
          },
          ':active': {
            backgroundColor: checked
              ? theme.accentActive
              : theme.textMutedActive,
          },
        },
        style,
      ],
    },
    h('box', {
      style: [
        s.thumb,
        {
          start: checked ? THUMB_ON : THUMB_OFF,
          backgroundColor: theme.surface,
        },
      ],
    }),
  );
}

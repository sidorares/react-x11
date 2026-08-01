// Widget components built purely on the host primitives — no reconciler
// support needed. Plain createElement (no JSX) so the library stays
// build-step-free for consumers.

import React, { useRef, useState } from 'react';
import { useTheme } from './theme.js';
import { changeEvent } from './change.js';
import {
  XK_DOWN,
  XK_END,
  XK_HOME,
  XK_LEFT,
  XK_PAGE_DOWN,
  XK_PAGE_UP,
  XK_RIGHT,
  XK_UP,
} from './keys.js';

const h = React.createElement;

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
  name,
  disabled = false,
  height = 4,
  style,
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
    if (next !== value) onChange?.(changeEvent('range', name, next));
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
      theme,
      role: 'slider',
      ref: trackRef,
      ...controlProps,
      ...boxProps,
      style: [
        disabled || { cursor: 'pointer' },
        {
          height: SLIDER_THUMB,
          minWidth: 0,
          justifyContent: 'center',
        },
        style,
      ],
    },
    // track
    h(
      'box',
      {
        style: {
          height: height,
          borderRadius: height / 2,
          backgroundColor: theme.track,
          flexDirection: 'row',
          alignItems: 'center',
          pointerEvents: 'none',
        },
      },
      // flex ratios, not a percentage width: a percentage child resolves
      // against the space available while the track is still being
      // measured, so it fed back into the slider's own intrinsic width —
      // at value = max the control grew, which moved the handle, which
      // changed the value, and a drag turned into an oscillation
      h('box', {
        style: {
          flexGrow: fraction,
          flexShrink: 0,
          flexBasis: 0,
          height: height,
          borderRadius: height / 2,
          backgroundColor: disabled ? theme.dim : theme.accent,
        },
      }),
      h('box', {
        style: { flexGrow: 1 - fraction, flexShrink: 0, flexBasis: 0 },
      }),
    ),
    // thumb, centred on the value within the same travel the math uses
    h('box', {
      style: {
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
      },
    }),
  );
}

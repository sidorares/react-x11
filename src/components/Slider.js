// Widget components built purely on the host primitives — no reconciler
// support needed. Plain createElement (no JSX) so the library stays
// build-step-free for consumers.

import React, { useRef, useState } from 'react';
import { useAppOrNull } from '../appcontext.js';
import { Bezel, bezelNatural, useNativeControls } from './native.js';
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
const SLIDER_SLOP = (24 - SLIDER_THUMB) / 2;

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
  native,
  style,
  ...boxProps
}) {
  const theme = useTheme();
  const app = useAppOrNull();
  const nativeControls = useNativeControls(native);
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

  /**
   * Pointer x -> value, using the track's laid-out rect.
   *
   * The direction is read off the **node** rather than the theme: it is the
   * one the track was actually laid out in, which is what the pointer
   * coordinate has to be measured against — a slider inside a `<box
   * style={{ direction: 'rtl' }}>` mirrors without a provider anywhere.
   */
  const valueAt = (ev) => {
    const node = trackRef.current;
    // getClientRects rather than raw `abs`: the event, the thumb constant
    // and this rect must share a unit, and the public rect is logical like
    // they are — `abs` is device (src/scale.js)
    const rect = node?.getClientRects?.()[0];
    if (!rect?.width) return value;
    // the thumb is centred on the value, so the usable travel is the track
    // minus one thumb width — otherwise min/max are unreachable at the ends
    const travel = Math.max(1, rect.width - SLIDER_THUMB);
    const x =
      node.direction === 'rtl'
        ? rect.x + rect.width - ev.x - SLIDER_THUMB / 2
        : ev.x - rect.x - SLIDER_THUMB / 2;
    return quantize(min + (Math.min(travel, Math.max(0, x)) / travel) * span);
  };

  const controlProps = disabled
    ? { disabled: true }
    : {
        focusable: true,
        // the AT-SPI Value interface writes land here (Orca adjusting the
        // slider): same clamp/quantize/emit as every other input route
        onAccessibilityAction: ({ action, value: next }) => {
          if (action === 'setValue' && typeof next === 'number') {
            emit(quantize(clamp(next)));
          }
        },
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
          // Left and Right name what the *thumb* should do on the screen, so
          // in a mirrored slider Left is the one that raises the value —
          // WAI-ARIA's rule for a horizontal slider, and the only one that
          // matches what the hand sees. Up and Down never mirror, which is
          // why they are not folded in with them.
          const along = trackRef.current?.direction === 'rtl' ? -1 : 1;
          switch (ev.keysym) {
            case XK_LEFT:
              emit(quantize(clamp(value - along * (step || 1))));
              return;
            case XK_RIGHT:
              emit(quantize(clamp(value + along * (step || 1))));
              return;
            case XK_DOWN:
              emit(quantize(clamp(value - (step || 1))));
              return;
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

  // The whole control as one NSSlider render, keyed by the value so a drag
  // is a sequence of cached-or-rendered bezels. Pointer math, keyboard and
  // a11y are the shared implementation above — the bezel is presentation.
  //
  // The *small* control size on purpose: its 16pt knob is exactly the
  // drawn thumb's footprint, so rows laid out for the drawn slider fit,
  // and the pointer math shares one thumb constant across both modes —
  // the regular size's 20pt knob overflowed every compact row it met.
  if (nativeControls) {
    const nat = bezelNatural(app, 'slider', 'small');
    return h(
      'box',
      {
        theme,
        role: 'slider',
        'aria-valuenow': clamp(value),
        'aria-valuemin': min,
        'aria-valuemax': max,
        'aria-orientation': 'horizontal',
        ref: trackRef,
        ...controlProps,
        ...boxProps,
        style: [
          disabled || { cursor: 'pointer' },
          {
            height: nat.height,
            minWidth: 0,
            hitSlop: {
              top: Math.max(0, (24 - nat.height) / 2),
              bottom: Math.max(0, (24 - nat.height) / 2),
            },
          },
          style,
        ],
      },
      h(Bezel, {
        kind: 'slider',
        controlSize: 'small',
        // quantized so a drag reuses cache entries instead of minting one
        // per sub-pixel float; 400 steps is finer than any track is wide
        value: Math.round(fraction * 400) / 400,
        enabled: !disabled,
        style: {
          position: 'absolute',
          top: 0,
          right: 0,
          bottom: 0,
          left: 0,
          pointerEvents: 'none',
        },
      }),
    );
  }

  return h(
    'box',
    {
      theme,
      role: 'slider',
      'aria-valuenow': clamp(value),
      'aria-valuemin': min,
      'aria-valuemax': max,
      'aria-orientation': 'horizontal',
      ref: trackRef,
      ...controlProps,
      ...boxProps,
      style: [
        disabled || { cursor: 'pointer' },
        {
          height: SLIDER_THUMB,
          minWidth: 0,
          justifyContent: 'center',
          // the control is as tall as its thumb and the track inside it sets
          // `pointerEvents: 'none'`, so 16px was the whole target. Grown to
          // WCAG 2.2 SC 2.5.8's 24 on the axis that is short, without moving
          // a pixel of the drawing — a taller slider would misalign every row
          // it sits in.
          hitSlop: { top: SLIDER_SLOP, bottom: SLIDER_SLOP },
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
          backgroundColor: disabled ? theme.textMuted : theme.accent,
        },
      }),
      h('box', {
        style: { flexGrow: 1 - fraction, flexShrink: 0, flexBasis: 0 },
      }),
    ),
    // thumb, centred on the value within the same travel the math uses.
    // Logical inset and logical margin: the track's two flex ratios already
    // mirror on their own — a `row` runs the other way under `direction:
    // 'rtl'` — and these are what keep the thumb on top of the join.
    h('box', {
      style: {
        position: 'absolute',
        start: `${fraction * 100}%`,
        marginStart: -SLIDER_THUMB * fraction,
        width: SLIDER_THUMB,
        height: SLIDER_THUMB,
        borderRadius: SLIDER_THUMB / 2,
        borderWidth: 1,
        borderColor: disabled
          ? theme.border
          : focused || dragging
            ? theme.accentHover
            : theme.border,
        backgroundColor: disabled ? theme.surfaceHover : theme.surface,
        pointerEvents: 'none',
      },
    }),
  );
}

// The native half of the widget set (docs/macos.md §Native controls).
//
// House rule: **default native, seam out.** On a backend that renders the
// platform's own control bezels — today the Cocoa backend — the core
// controls wear AppKit's pixels while interaction, focus, keyboard and
// a11y stay the shared implementation. The mechanism is a bezel *image*
// drawn through the ordinary paint path, never an embedded platform view:
// the press model, the focus rules and the event routing are behaviour this
// project considers part of its identity, and a real NSControl would take
// them over wholesale.
//
// The policy lives in the theme (`controls: 'auto' | 'native' | 'drawn'`),
// because whether an app looks native is an app-identity decision, not a
// per-node style. The per-instance escape hatch is `native={false}` on the
// one custom-branded control — a themed `style` override is ignored by a
// native bezel, so a control that names its own colours should also name
// `native={false}` (the widgets keep today's drawn rendering everywhere the
// bezel is off, so custom-designed apps lose nothing).

import React, { useCallback } from 'react';
import { useAppOrNull } from '../appcontext.js';
import { useTheme } from './theme.js';

const h = React.createElement;

let warnedUnsupported = false;

/**
 * Should this control render the platform bezel? Combines the per-instance
 * `native` prop, the theme's `controls` policy and the backend capability.
 * An explicit `controls: 'native'` on a backend without the capability
 * warns once and draws — erroring would make the same app code illegal on
 * X11, which is the opposite of what a cross-backend widget set is for.
 */
export function useNativeControls(native) {
  const app = useAppOrNull();
  const theme = useTheme();
  const capable = Boolean(app?.nativeBezels);
  if (native === false) return false;
  const mode = native === true ? 'native' : (theme.controls ?? 'auto');
  if (mode === 'drawn') return false;
  if (mode === 'native' && !capable && !warnedUnsupported) {
    warnedUnsupported = true;
    console.warn(
      "react-x11: controls: 'native' — this backend has no native control " +
        'rendering; the themed drawn controls are used instead.',
    );
  }
  return capable;
}

/**
 * The control's natural size in logical px — AppKit's own metrics, which
 * native-mode layout adopts (a stretched checkbox is a wrong checkbox).
 * `null` where there is no bezel store, so callers can guard in one step.
 */
export function bezelNatural(app, kind, controlSize = 'regular') {
  return app?.nativeBezels?.natural(kind, controlSize) ?? null;
}

/**
 * The translucent rows above and below the bezel's solid body — a push
 * button's shadow — as padding, so a label centred in the box is centred in
 * the control rather than in its footprint. Zero where there is no store.
 */
export function bezelShadow(app, kind, controlSize = 'regular') {
  return (
    app?.nativeBezels?.shadow?.(kind, controlSize) ?? { top: 0, bottom: 0 }
  );
}

/** Absolute fill inside the control's box — where every bezel layer goes. */
export const ABS_FILL = Object.freeze({
  position: 'absolute',
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
});

/**
 * The press wash — the one hover/press affordance native mode keeps.
 * AppKit's controls have no hover state, so hover tints are deliberately
 * absent here; the press is answered with a translucent wash over the
 * bezel, dark on light and light on dark, the direction macOS itself steps
 * a pressed control.
 */
export const pressWash = (theme) =>
  theme.scheme === 'dark' ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.07)';

/**
 * `<Bezel kind …states style>` — one AppKit bezel, rendered at exactly the
 * box layout gives it. A `<canvas>` under the hood: the bezel comes out of
 * the app's `BezelStore` (cached by every parameter that changes the
 * pixels) and is blitted with the 9-arg `drawImage`, so a state change is a
 * cache lookup and one blit, bounded to this node's damage.
 */
export function Bezel({
  kind,
  state = 0,
  pressed = false,
  enabled = true,
  isDefault = false,
  value,
  controlSize = 'regular',
  style,
}) {
  const app = useAppOrNull();
  const theme = useTheme();
  // The theme in force decides the bezel's appearance, not the desktop: a
  // pinned-light app on a dark desktop gets light bezels beside its light
  // surfaces. `scheme` is the palette's own statement of which it is.
  const appearance = theme.scheme === 'dark' ? 'dark' : 'light';
  const params = {
    kind,
    controlSize,
    state: state ? 1 : 0,
    pressed: Boolean(pressed),
    enabled: Boolean(enabled),
    isDefault: Boolean(isDefault),
    appearance,
  };
  if (value !== undefined) params.value = value;
  const sig = JSON.stringify(params);
  const store = app?.nativeBezels;
  // Keyed on the parameter signature so an unchanged bezel keeps its
  // `onDraw` identity — CanvasNode invalidates when the closure changes,
  // and a Button re-rendered by its parent must not repaint its bezel.
  const onDraw = useCallback(
    (ctx, info) => {
      if (!store || !info.width || !info.height) return;
      const bezel = store.get(
        JSON.parse(sig),
        info.width,
        info.height,
        info.scale,
      );
      ctx.drawImage(
        { _surfaceHandle: bezel.surface },
        bezel.sx,
        bezel.sy,
        bezel.sw,
        bezel.sh,
        0,
        0,
        info.width,
        info.height,
      );
    },
    [store, sig],
  );
  return h('canvas', { onDraw, style });
}

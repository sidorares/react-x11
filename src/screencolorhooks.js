// `useEyedropper()` — the screen colour pick as a component sees it.
//
// The bare `pickScreenColor()` is complete; what a component wants on top of
// it is *binding*, not another rung (there is no rung to draw — the screen
// is the one thing an application cannot draw itself). The hook binds the
// tree's connection and owner window once, exposes `supported` for the
// button's existence and `picking` for its pressed state, and hands a
// second click the pick that is already in flight instead of a second grab.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useApp } from './appcontext.js';
import { pickScreenColor, screenColorBackend } from './screencolor.js';
import { useTopLevelWindow } from './windowid.js';

/**
 * An eyedropper for a component.
 *
 * ```jsx
 * const eyedropper = useEyedropper();
 *
 * {eyedropper.supported && (
 *   <Button
 *     label="Pick from screen"
 *     disabled={eyedropper.picking}
 *     onPress={async () => {
 *       const hex = await eyedropper.pick();
 *       if (hex) onChange(hex);     // '#rrggbb'; null means cancelled
 *     }}
 *   />
 * )}
 * ```
 *
 * `pick()` resolves to `'#rrggbb'`, or `null` when the user cancelled. It
 * never rejects for lack of a backend on an X11 tree — the connection this
 * tree renders through *is* the fallback rung — so `supported` is about the
 * forced-backend and future-platform cases, not a check most apps must make.
 *
 * The portal dialog is parented to the window this component is in, the
 * `useFileDialog()` way: resolved at the moment the pick starts, with
 * `parentWindow` as the override for a tree with several top-level windows.
 *
 * While a pick is in flight, `picking` is true and another `pick()` returns
 * **the same promise** — a double-clicked button must not queue a second
 * grab behind the first.
 */
export function useEyedropper(defaults = {}) {
  const app = useApp();
  const owner = useTopLevelWindow();
  const [picking, setPicking] = useState(false);
  const [supported, setSupported] = useState(false);
  const inflight = useRef(null);

  const backend = defaults.backend;
  useEffect(() => {
    let alive = true;
    screenColorBackend({ app, backend }).then(
      (rung) => {
        if (alive) setSupported(rung !== null);
      },
      () => {
        if (alive) setSupported(false);
      },
    );
    return () => {
      alive = false;
    };
  }, [app, backend]);

  const pick = useCallback(
    (options = {}) => {
      if (inflight.current) return inflight.current;
      // `app` last: the tree's connection is what this hook exists to bind,
      // not an override surface.
      const opts = { parentWindow: owner, ...defaults, ...options, app };
      setPicking(true);
      const run = pickScreenColor(opts).finally(() => {
        inflight.current = null;
        setPicking(false);
      });
      inflight.current = run;
      return run;
    },
    // `defaults` is deliberately not a dependency — the useFileDialog rule:
    // an app writes it inline, and a new object every render would rebuild
    // the callback every render.
    [app, owner],
  );

  return useMemo(
    () => ({
      /** @returns {Promise<string | null>} `'#rrggbb'`, or null if cancelled */
      pick,
      /** `screenColorBackend()` resolved — false until it answers. */
      supported,
      /** A pick is in flight — the button's pressed/disabled state. */
      picking,
    }),
    [pick, supported, picking],
  );
}

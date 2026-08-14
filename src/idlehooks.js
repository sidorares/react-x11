// `useIdle()` and `useKeepAwake()` — the two halves of "is the user still
// there", as things a component declares rather than manages.
//
// The machinery lives in `idle.js`, keyed by connection: idleness is a fact
// about one display's input devices, and the inhibition is held for as long
// as the component that asked for it is mounted.

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';

import { useApp } from './appcontext.js';
import { idleSnapshot, keepAwake, watchIdle } from './idle.js';

/**
 * Whether the user has been away from the keyboard for `timeout`
 * milliseconds.
 *
 * ```jsx
 * const away = useIdle(5 * 60_000);
 *
 * <Avatar status={away ? 'away' : 'online'} />
 * ```
 *
 * Idleness is the **whole display's**, not this window's: it counts input on
 * every device, whichever application it went to. That is the right meaning
 * for a presence indicator, an auto-save, or a dashboard that stops
 * refreshing when the desk is empty, and the wrong one for "has the user
 * ignored *my* window" — which is `useWindowState().focused`.
 *
 * Where the X server carries a `IDLETIME` counter — Xorg does — this costs
 * **no timer at all**: a SYNC alarm fires when the counter crosses `timeout`
 * and again when input pulls it back down. On a server without one (XQuartz)
 * it falls back to polling MIT-SCREEN-SAVER, scheduled against the remaining
 * time rather than on a tick. On a display with neither it stays `false`,
 * which is the honest answer for a display that cannot be asked.
 *
 * `timeout` is a dependency: passing a computed value re-arms on every change,
 * so hold it in a constant or a `useMemo` rather than building it inline from
 * state that moves.
 */
export function useIdle(timeout) {
  const app = useApp();
  const subscribe = useCallback(
    (onChange) => watchIdle(app, timeout, onChange),
    [app, timeout],
  );
  const snapshot = useCallback(
    () => idleSnapshot(app, timeout),
    [app, timeout],
  );
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/**
 * Keep the screen awake while `active` is true.
 *
 * ```jsx
 * useKeepAwake(playing, 'Playing a video');
 * ```
 *
 * Held for as long as the flag is true and the component is mounted, and
 * released on either — including on an unmount mid-playback, which is the
 * case that leaves a desktop permanently un-blanking when it is done by hand.
 *
 * Three rungs, and **all three inhibit screen blanking only**: the settings
 * portal's `Inhibit`, the older `org.freedesktop.ScreenSaver` service, and
 * `ScreenSaverSuspend`, which is a plain X request and needs no session bus.
 * Nothing here stops a **suspend** — only the portal rung could, and a seam
 * that works on one desktop in three is worse than not offering it.
 *
 * `reason` is shown to the user by desktops that list what is holding the
 * screen on, so it reads best as a sentence about the app's state rather than
 * the app's name, which they already show.
 *
 * Failure is silent by design. A machine with no portal, no screensaver
 * service and no MIT-SCREEN-SAVER cannot be asked, and a video player is not
 * a place to surface that.
 */
export function useKeepAwake(active, reason = 'Busy') {
  const app = useApp();
  // Read through a ref so that editing the reason mid-playback does not drop
  // the inhibition and take out a new one — a gap the screen can blank in.
  const latest = useRef(reason);
  latest.current = reason;

  useEffect(() => {
    if (!active) return undefined;
    let release = null;
    let cancelled = false;
    keepAwake({ reason: latest.current, app }).then((fn) => {
      // Unmounted while the bus round trip was in flight: take it out and
      // give it straight back rather than leaking it for the process's life.
      if (cancelled) fn();
      else release = fn;
    });
    return () => {
      cancelled = true;
      release?.();
    };
  }, [active, app]);
}

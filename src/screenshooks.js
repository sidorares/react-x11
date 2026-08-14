// `useScreens()` — the monitor layout as something a component re-renders on.
//
// The store lives in `screens.js`, keyed by connection rather than shared
// across the process the way `appearance.js` is: the screen layout is a fact
// about one X display, and a process driving two of them is exactly what the
// test suite does routinely.

import { useCallback, useSyncExternalStore } from 'react';

import { useApp } from './appcontext.js';
import { screensSnapshot, watchScreens } from './screens.js';

/**
 * The monitors this display has, live.
 *
 * ```jsx
 * const { screens, primary } = useScreens();
 *
 * <Select
 *   value={monitor}
 *   onChange={setMonitor}
 *   options={screens.map((s) => ({
 *     value: s.name,
 *     label: `${s.name} — ${s.width}×${s.height}`,
 *   }))}
 * />
 * ```
 *
 * Each entry is:
 *
 * | | |
 * | --- | --- |
 * | `name` | `'HDMI-1'`, `'eDP-1'` — **null** where the server has no RandR |
 * | `x` `y` `width` `height` | the monitor's rect in virtual-screen coordinates |
 * | `available` | that rect minus the panels — where a window can go |
 * | `primary` | the desktop's main monitor, where panels and new windows land |
 * | `widthMM` `heightMM` | physical size, or null |
 * | `refreshRate` | Hz to two decimals (`59.99`), or null |
 * | `rotation` | `0`, `90`, `180` or `270` |
 * | `outputs` | every output on this monitor — two names means it is mirrored |
 *
 * and the object around them carries `primary` (the entry, or null), the
 * desktop-wide `workArea`, the whole `virtual` screen, and `source`.
 *
 * **`name` is null before RandR answers, and on a server without it.** The
 * geometry resolves during `createRoot()` from Xinerama, which is one round
 * trip; the names, the primary flag and the physical sizes take a ten-round-
 * trip RandR walk that deliberately does not hold startup up, so they appear
 * a moment later. The rects do not move when they land — Xinerama on a
 * modern server *is* RandR's emulation of it — so a component that rendered
 * against the early answer sees fields fill in, not values change. Where a
 * name is what gets persisted, treat null as "not known yet" and keep the
 * last one, rather than writing it.
 *
 * `source` says which tier answered: `'randr'`, `'xinerama'`, `'screen'`
 * (one entry covering the whole display, for a server with neither
 * extension), `'test'`, or null on a headless mock with no display at all.
 *
 * **`available` is an approximation and the only one here.** `_NET_WORKAREA`
 * is published for the whole virtual desktop rather than per monitor, so it
 * is applied as a per-axis bound: exact on one head, and on several it still
 * takes a top or bottom panel off the height. Deriving a true per-monitor
 * work area means reading `_NET_WM_STRUT_PARTIAL` off every window on the
 * screen — see the note in `screens.js`.
 *
 * Re-renders when a monitor is plugged in or unplugged, when the arrangement
 * changes, and when a panel appears, moves or auto-hides.
 */
export function useScreens() {
  const app = useApp();
  const subscribe = useCallback(
    (onChange) => watchScreens(app, onChange),
    [app],
  );
  const snapshot = useCallback(() => screensSnapshot(app), [app]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

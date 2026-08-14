// `useDesktopSettings()` — the desktop's interaction timings, as something a
// component re-renders on.
//
// The store lives in `desktopsettings.js`, which the renderer reads
// synchronously on the caret, click and drag paths. This is the same values,
// for an app drawing something the renderer does not.

import { useCallback, useSyncExternalStore } from 'react';

import { useApp } from './appcontext.js';
import { desktopSettings, watchDesktopSettings } from './desktopsettings.js';

/**
 * How this desktop wants an application to feel, live.
 *
 * ```jsx
 * const { doubleClickMs, dragThreshold } = useDesktopSettings();
 *
 * // a <canvas> implementing its own gestures matches the rest of the desktop
 * const onPointerDown = (e) => {
 *   const now = e.timeStamp;
 *   if (now - last.current < doubleClickMs) openItem();
 *   last.current = now;
 * };
 * ```
 *
 * | | |
 * | --- | --- |
 * | `caretBlink` | **false means do not blink at all** — an accessibility setting |
 * | `caretBlinkMs` | how long a caret stays in each state (530) |
 * | `doubleClickMs` | how long a second click has to arrive in (400) |
 * | `doubleClickDistance` | and how far it may land from the first (4px) |
 * | `dragThreshold` | how far a press moves before it is a drag, not a click (4px) |
 * | `source` | `'xsettings'`, or null where no settings daemon answered |
 *
 * **The built-in controls already follow these** — `<textinput>`'s caret,
 * the click counting behind `ev.detail`, and the XDND drag threshold all
 * read the same values. This hook is for an app drawing its own: a `<canvas>`
 * with a text cursor in it, a custom gesture, a diagram editor with its own
 * drag. Reach for it so that one widget on the screen does not feel unlike
 * every other.
 *
 * `caretBlink` deserves the callout. A caret that ignores it is not a
 * cosmetic miss: a moving thing on screen is what some people cannot read
 * past, which is why the desktop offers the switch. Draw the caret solid
 * rather than not at all.
 *
 * XSETTINGS is the only source — there is no portal interface for any of
 * this — so on a desktop with no settings daemon `source` is null and the
 * numbers above are this renderer's own defaults. They are not GTK's: the
 * point of this hook is to follow a desktop that expressed a preference, not
 * to change what happens on one that did not.
 */
export function useDesktopSettings() {
  const app = useApp();
  const subscribe = useCallback(
    (onChange) => watchDesktopSettings(app, onChange),
    [app],
  );
  const snapshot = useCallback(() => desktopSettings(app), [app]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

// `useSystemAppearance()` — the desktop's appearance as something a component
// re-renders on.
//
// The store lives in `appearance.js` and is process-global, because that is
// what it describes: one desktop, one set of preferences, shared by every
// root in the process the way the D-Bus connection under it is.

import { useCallback, useSyncExternalStore } from 'react';

import {
  appearanceSnapshot,
  systemAppearance,
  watchAppearance,
} from './appearance.js';
import { useAppOrNull } from './appcontext.js';

/**
 * Read the store, and start the ladder if `enabled`.
 *
 * The flag exists for `<ThemeProvider>`, which calls this on every render and
 * must not open a D-Bus connection for an app that gave it a single palette
 * and no `dark`. Hooks cannot be conditional, so the condition goes in here
 * rather than into which hooks run.
 */
function useAppearance(enabled) {
  const app = useAppOrNull();
  const subscribe = useCallback(
    (onChange) => {
      if (!enabled) return () => {};
      // Subscribe, *then* ask — the same ordering the portal rung uses
      // internally, and for the same reason. React's own re-check after
      // subscribing would cover a value that landed in between, but not a
      // change that arrived and left.
      const stop = watchAppearance(onChange);
      systemAppearance({ app }).catch(() => {
        // `systemAppearance` does not reject; this is belt and braces so a
        // future rung cannot turn a desktop probe into an unhandled rejection
      });
      return stop;
    },
    [app, enabled],
  );
  // The same frozen object until something changes — `getSnapshot` returning
  // a fresh `{ colorScheme, … }` per call is what makes React loop.
  return useSyncExternalStore(
    subscribe,
    appearanceSnapshot,
    appearanceSnapshot,
  );
}

/** Not public: `<ThemeProvider>`'s seam, so following the desktop is opt-in. */
export function useAppearanceWhen(enabled) {
  return useAppearance(enabled);
}

/**
 * What the desktop looks like, live.
 *
 * ```jsx
 * const { colorScheme, accent, contrast, reducedMotion } = useSystemAppearance();
 *
 * <box style={{ backgroundColor: colorScheme === 'dark' ? '#1e1e1e' : 'white' }}>
 *   <Button style={{ backgroundColor: accent ?? '#2980b9' }} label="Save" />
 * </box>
 * ```
 *
 * | | |
 * | --- | --- |
 * | `colorScheme` | `'light'`, `'dark'` or `'no-preference'` |
 * | `accent` | `'#ed5b00'`, or **null** — most backends do not implement it |
 * | `contrast` | `'normal'` or `'high'` |
 * | `reducedMotion` | `true` when the user asked for less animation |
 * | `source` | `'portal'`, `'xsettings'`, `'macos'`, `'cache'`, or null |
 *
 * **`'no-preference'` means use your own default**, not "use light". And
 * `accent` is null far more often than not, so fall back to your own brand
 * colour rather than to grey — an app that goes colourless on a desktop that
 * simply did not answer the question looks broken.
 *
 * The **first** render is served from what this machine answered last time
 * (`source: 'cache'`), so it starts in the right colours rather than in the
 * defaults, and a real rung replaces it a frame or two later. An app that
 * needs a verified answer before it draws anything at all — the first launch
 * on a machine — waits for one:
 *
 * ```jsx
 * const [root] = await Promise.all([createRoot(), systemAppearance()]);
 * ```
 *
 * See `docs/appearance.md`, and `<ThemeProvider dark={…}>` for the case where
 * all you want is for the app to follow the desktop.
 */
export function useSystemAppearance() {
  return useAppearance(true);
}

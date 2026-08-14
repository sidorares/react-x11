// `useKeyboardState()` — the locks and the active layout, as something a
// component re-renders on.
//
// The store lives in `keyboardstate.js`, keyed by connection: there is one
// keyboard per display, and its state is the same for every window on it.

import { useCallback, useSyncExternalStore } from 'react';

import { useApp } from './appcontext.js';
import { keyboardStateSnapshot, watchKeyboardState } from './keyboardstate.js';

/**
 * The keyboard's locks and layout, live.
 *
 * ```jsx
 * const { capsLock, layout } = useKeyboardState();
 *
 * <PasswordInput value={password} onChange={setPassword} />
 * {capsLock && <text style={{ color: theme.warning }}>Caps Lock is on</text>}
 * ```
 *
 * | | |
 * | --- | --- |
 * | `capsLock` `numLock` | on or off, **now** — not "was on for the last key" |
 * | `group` | the active XKB group, `0`–`3` |
 * | `layout` | that group's layout code, `'ru'` — or null |
 * | `layouts` | every configured layout, `['us', 'ru']` — `[]` where unknown |
 *
 * The point of the first row is that it is true of the keyboard rather than
 * of an event: a password field can warn about Caps Lock **before** the first
 * character is typed, which is the only time the warning is worth anything.
 * A key event's own modifier state cannot do that, because it needs a key.
 *
 * The second is for a status-bar indicator, and for the case that costs
 * people real time — a password typed in the wrong script, which looks
 * identical to a wrong password. `layout` is a code rather than a
 * description (`'ru'`, not `'Russian'`) because that is what an indicator
 * shows and what a lookup key wants; uppercase it for display.
 *
 * Everything here needs **XKB**, which Xorg and XQuartz both have. Where it
 * is missing the locks read false and `layouts` is empty, and an app that
 * renders a warning only when `capsLock` is true degrades to not warning.
 * `layouts` is the field to check when the difference between "off" and "not
 * known" matters.
 *
 * Nothing is asked of the server until a component calls this, and the change
 * is delivered by `XkbStateNotify` — no polling, and it arrives even while
 * another application has the keyboard.
 */
export function useKeyboardState() {
  const app = useApp();
  const subscribe = useCallback(
    (onChange) => watchKeyboardState(app, onChange),
    [app],
  );
  const snapshot = useCallback(() => keyboardStateSnapshot(app), [app]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

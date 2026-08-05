// `useSessionBus()` / `useSystemBus()` — the surface almost everyone uses.
//
// ## No provider, and why that is not the trick `useApp()` uses
//
// The requirement is the same: a component that talks to the desktop works in
// any tree with *nothing for the app author to wrap*. `useApp()` gets there
// with a provider `Reconciler.js` injects, because the X connection is
// genuinely per-tree — `createRoot()` opens one per root and a process can
// drive several.
//
// A D-Bus connection is **process** identity. Every consumer shares one socket
// and one unique name on purpose, so that an app's exported service, its menu
// and its tray are visibly one application. There is therefore nothing to
// provide: these hooks read the module-global in `bus.js` and manage their own
// acquire/release. Putting a process-global on a tree-scoped context would
// assert a scoping relationship that does not exist — two roots on two X
// displays share one session bus.
//
// ## The terse path has to be correct on its own
//
//     const { bus } = useSessionBus();
//     if (!bus) return null;              // right, with no reference to status
//
// If reading `status` were *required* to avoid a bug, the shape would be
// wrong. `status` and `cause` are there for the cases that need more —
// diagnostics ("why is my tray icon missing") and the app-author persona —
// not as a step every consumer has to remember.

import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  busGeneration,
  busIsDead,
  sessionBus,
  systemBus,
  watchBus,
} from './bus.js';

/** @typedef {'connecting'|'ready'|'unavailable'|'closed'} BusStatus */

const CONNECTING = { bus: null, uniqueName: null, status: 'connecting' };

function useBus(kind, acquire) {
  const [attempt, setAttempt] = useState(0);
  // The attempt each answer belongs to, so a `retry()` shows 'connecting'
  // immediately instead of leaving the stale answer up until the new dial
  // settles — and without an extra render to reset it.
  const [answer, setAnswer] = useState({ attempt: -1, handle: CONNECTING });

  // The way back from `'closed'`. Deliberately not automatic: silently
  // re-acquiring would hand the consumer a fresh `bus` under the same
  // variable and hide the unique-name change that disabling reconnect exists
  // to expose. A feature-level hook that knows how to rebuild its bus-side
  // state can call this; a generic one cannot.
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    let acquired = null;
    let acquiredGeneration = null;
    let unwatch = null;
    const settle = (handle) => setAnswer({ attempt, handle });

    // `required: true` purely to obtain the reason. The imperative default
    // stays never-rejecting; the hook is that option's first consumer,
    // converting the rejection into rendering state.
    acquire({ required: true }).then(
      (ref) => {
        if (!live) return void ref.release();
        acquired = ref;
        acquiredGeneration = busGeneration(kind);
        settle({
          bus: ref.bus,
          uniqueName: ref.uniqueName,
          status: 'ready',
        });
        // The connection can die under a live ref. When it does the
        // generation is retired, which is what distinguishes "the daemon went
        // away" from "there was never a bus here".
        unwatch = watchBus(kind, () => {
          if (!live) return;
          if (!busIsDead(kind) && busGeneration(kind) === acquiredGeneration) {
            return;
          }
          settle({ bus: null, uniqueName: null, status: 'closed' });
        });
      },
      (cause) => {
        if (!live) return;
        settle({ bus: null, uniqueName: null, status: 'unavailable', cause });
      },
    );

    return () => {
      live = false;
      unwatch?.();
      acquired?.release();
    };
  }, [kind, acquire, attempt]);

  const handle = answer.attempt === attempt ? answer.handle : CONNECTING;
  // Memoized so the handle is stable between renders and safe in a dependency
  // array — a fresh object every render would restart any effect keyed on it.
  return useMemo(() => ({ ...handle, retry }), [handle, retry]);
}

/**
 * The session bus, as rendering state.
 *
 * ```jsx
 * function ThemeWatcher() {
 *   const { bus } = useSessionBus();
 *   if (!bus) return null;          // no bus here: no desktop theme to read
 *   ...
 * }
 * ```
 *
 * | `status`       |                                                        |
 * | -------------- | ------------------------------------------------------ |
 * | `'connecting'` | the handshake is in flight — also the first render     |
 * | `'ready'`      | `bus` and `uniqueName` are set                         |
 * | `'unavailable'` | no daemon, socket or permission here; `cause` says why |
 * | `'closed'`     | the connection died; call `retry()` to dial a new one   |
 *
 * **`'unavailable'` is a snapshot, not a verdict.** Failure is not cached, so
 * a session bus that appears later will be found — do not permanently disable
 * a feature on seeing it.
 */
export function useSessionBus() {
  return useBus('session', sessionBus);
}

/** The system bus, as rendering state. Same shape as {@link useSessionBus}. */
export function useSystemBus() {
  return useBus('system', systemBus);
}

// `useNotifier()` — notifications as a component sees them: `notify` bound
// to the tree's connection, and `available` for whether this machine can
// show one at all.
//
// The bare `notify()` is complete; what a component wants on top is the
// binding and the answer to "should I show the toggle". There is no rung
// to draw — a banner outside the window is the one thing the app cannot
// draw itself — so unlike `useFileDialog()` this adds nothing to the ladder.

import { useCallback, useEffect, useMemo, useState } from 'react';

import { useAppOrNull } from './appcontext.js';
import { notificationBackend, notify } from './notifications.js';

/**
 * ```jsx
 * const notifier = useNotifier();
 *
 * onExportDone(async (file) => {
 *   if (!notifier.available) return;
 *   await notifier.notify({ summary: 'Export finished', body: file });
 * });
 * ```
 *
 * `available` settles once the ladder has been probed (one bus round trip,
 * or one read of the app's centre) and is false where `notify()` would
 * reject; `backend` says which rung — useful for saying "actions are not
 * supported here" on the shell-out ones.
 */
export function useNotifier(defaults = {}) {
  const app = useAppOrNull();
  const [backend, setBackend] = useState(null);
  const forced = defaults.backend;

  useEffect(() => {
    let alive = true;
    notificationBackend({ app, backend: forced }).then(
      (rung) => alive && setBackend(rung),
      () => alive && setBackend(null),
    );
    return () => {
      alive = false;
    };
  }, [app, forced]);

  const send = useCallback(
    (options = {}) => notify({ ...defaults, ...options, app }),
    // `defaults` is read at call time on purpose, the useFileDialog rule
    [app],
  );

  return useMemo(
    () => ({ notify: send, available: backend !== null, backend }),
    [send, backend],
  );
}

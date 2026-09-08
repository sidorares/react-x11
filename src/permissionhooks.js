// `usePermission()` — a permission as a component sees it: the status as
// render state, a request that updates it, and whether this backend can
// answer at all.
//
// The bare functions in `permissions.js` are complete; what a component
// wants on top is binding — the tree's connection, the status re-read after
// a request — not another rung. There is no change notification behind a
// status on any platform, so the status is what was last read: on mount,
// and after each `request()`. An app that wants it fresher re-reads with
// `refresh()` on its own cue (a window coming back to the front, say).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useAppOrNull } from './appcontext.js';
import {
  openPrivacySettings,
  permissionBackend,
  permissionStatus,
  requestPermission,
} from './permissions.js';

/**
 * ```jsx
 * const camera = usePermission('camera');
 *
 * {camera.available && camera.status !== 'granted' && (
 *   <Button
 *     label={camera.status === 'prompt' ? 'Allow camera' : 'Open Settings'}
 *     onPress={() =>
 *       camera.status === 'prompt' ? camera.request() : camera.openSettings()
 *     }
 *   />
 * )}
 * ```
 *
 * `status` starts `'unknown'` and settles once read. `request()` resolves
 * with the status after the user answered and updates `status` with it;
 * while one is in flight a second call returns the same promise.
 * `available` is whether this backend has an authorization API — false on
 * X11 today — and the honest branch to keep a feature behind.
 */
export function usePermission(kind, options = {}) {
  const app = useAppOrNull();
  const target = options.target;
  // `calendars` only: which level to ask for. Part of the effect keys
  // because asking for a narrower grant is asking a different question.
  const access = options.access;
  const available = permissionBackend({ app }) !== null;
  const [status, setStatus] = useState('unknown');
  const inflight = useRef(null);

  const refresh = useCallback(async () => {
    const next = await permissionStatus(kind, { app, target, access });
    setStatus(next);
    return next;
  }, [kind, app, target, access]);

  useEffect(() => {
    let alive = true;
    permissionStatus(kind, { app, target, access }).then(
      (next) => alive && setStatus(next),
      () => alive && setStatus('unknown'),
    );
    return () => {
      alive = false;
    };
  }, [kind, app, target, access]);

  const request = useCallback(() => {
    if (inflight.current) return inflight.current;
    const run = requestPermission(kind, { app, target, access })
      .then((next) => {
        setStatus(next);
        return next;
      })
      .finally(() => {
        inflight.current = null;
      });
    inflight.current = run;
    return run;
  }, [kind, app, target, access]);

  const openSettings = useCallback(
    () => openPrivacySettings(kind, { app }),
    [kind, app],
  );

  return useMemo(
    () => ({ status, available, request, refresh, openSettings }),
    [status, available, request, refresh, openSettings],
  );
}

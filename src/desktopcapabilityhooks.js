// `useDesktopCapability()` — what this desktop can do, as render state.
//
// The vocabulary and the probes are `capabilities.js`; this is the part that
// makes them safe to branch on inside a component. Three things it has to get
// right, and each is a bug an app would otherwise hit:
//
//   1. **The first frame has no answer.** Probing takes a bus round trip, so
//      the hook returns `NO_CAPABILITY` — available false, empty features —
//      until one arrives. An app therefore renders its fallback first and
//      upgrades, which is the right way round: the opposite order flashes a
//      feature that turns out not to exist.
//
//   2. **The answer changes.** A panel restarts, an AppIndicator extension is
//      toggled, a notification daemon is installed. The hook follows
//      `NameOwnerChanged` for the whole session rather than sampling once, for
//      the same reason `globalmenu.js` does: a cached "no" outlives the fix.
//
//   3. **The object identity must be stable.** A probe that returned a fresh
//      object every time would re-render every consumer on every bus event,
//      and a `features` object in a dependency array would never compare
//      equal. Results are frozen and replaced only when they differ by value.

import { useEffect, useState } from 'react';

import { sessionBus } from './bus.js';
import { NO_CAPABILITY, desktopCapability } from './capabilities.js';

/** Value equality over the two levels a capability result has. */
function same(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.available !== b.available || a.backend !== b.backend) return false;
  if (a.reason !== b.reason) return false;
  const ka = Object.keys(a.features);
  const kb = Object.keys(b.features);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => a.features[k] === b.features[k]);
}

/**
 * What this desktop can do for one feature, as a value a component branches
 * on.
 *
 * ```jsx
 * const notifications = useDesktopCapability('notifications');
 *
 * // The portable question is about the feature, never about the platform.
 * if (notifications.features.actions) {
 *   return <ReplyFromBanner />;
 * }
 * return <OpenAppToReply available={notifications.available} />;
 * ```
 *
 * `{ available, backend, features }`, starting at
 * {@link NO_CAPABILITY} and settling a tick later — see the header for why
 * that order is deliberate. It re-probes whenever a name appears or vanishes
 * on the session bus, so a panel that starts after the app does is picked up.
 *
 * Capability names: `'notifications'`, `'tray'`, `'launcher'`.
 */
export function useDesktopCapability(name) {
  const [state, setState] = useState(NO_CAPABILITY);

  useEffect(() => {
    let cancelled = false;
    let subscription = null;
    let ref = null;
    let onChanged = null;

    const probe = () => {
      desktopCapability(name)
        .then((next) => {
          if (cancelled) return;
          // Replaced only when it differs by value: see the header.
          setState((prev) => (same(prev, next) ? prev : next));
        })
        .catch(() => {});
    };

    probe();

    // Follow the session for anything appearing or going away. Deliberately
    // *not* narrowed by `arg0`: one capability can depend on several names
    // (the tray watcher, the notification daemon, a launcher), and the set is
    // a detail of `capabilities.js` rather than of this hook. The handler is
    // a re-probe, so the cost of a wide match is a bus round trip on an event
    // that is rare in a settled session.
    void (async () => {
      ref = await sessionBus();
      if (!ref || cancelled) {
        await ref?.release();
        ref = null;
        return;
      }
      try {
        subscription = await ref.bus.watch(
          "type='signal',sender='org.freedesktop.DBus'," +
            "interface='org.freedesktop.DBus',member='NameOwnerChanged'",
        );
      } catch {
        return;
      }
      // The mount/unmount race `AddMatch` always has — see
      // `GlobalMenuExport.watchRegistrar` for the long version.
      if (cancelled) {
        await subscription.remove().catch(() => {});
        subscription = null;
        return;
      }
      const key = ref.bus.mangle(
        '/org/freedesktop/DBus',
        'org.freedesktop.DBus',
        'NameOwnerChanged',
      );
      onChanged = () => probe();
      ref.bus.signals.on(key, onChanged);
    })();

    return () => {
      cancelled = true;
      void (async () => {
        if (ref && onChanged) {
          const key = ref.bus.mangle(
            '/org/freedesktop/DBus',
            'org.freedesktop.DBus',
            'NameOwnerChanged',
          );
          ref.bus.signals.removeListener(key, onChanged);
        }
        await subscription?.remove().catch(() => {});
        await ref?.release();
      })();
    };
  }, [name]);

  return state;
}

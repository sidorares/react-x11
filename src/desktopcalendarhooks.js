// `useDesktopCalendarEvents()` — the desktop's calendar as rendering state:
// the occurrences in a range, grouped the way a calendar grid asks for them,
// re-read when the store moves.
//
// The imperative half in `desktopcalendar.js` is complete; what a component
// wants on top is binding — the tree's connection, a handle that is closed
// when the view goes away, the grant asked for on the first read rather than
// at start-up — not another rung.
//
// ```jsx
// const { byDay } = useDesktopCalendarEvents({ from, to, watch: true });
//
// <Calendar
//   dayContent={(day) =>
//     byDay.get(day)?.slice(0, 3).map((ev) => (
//       <box key={ev.uid} style={{ width: 4, height: 4, borderRadius: 2,
//                                  backgroundColor: ev.calendar.color ?? '$accent' }} />
//     ))
//   }
// />
// ```
//
// `<Calendar>` is `@react-x11/components`; the `'YYYY-MM-DD'` keys are the
// one contract between the two packages, which is why `byDay` is here and
// the grid is there.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useAppOrNull } from './appcontext.js';
import {
  CalendarAccessError,
  byDay as groupByDay,
  desktopCalendar,
} from './desktopcalendar.js';
import { openPrivacySettings } from './permissions.js';

const NO_EVENTS = [];
const NO_CALENDARS = [];
const NO_ERRORS = [];

/** The calendars a caller asked for by uid, or every enabled one. `onlyKey`
 *  is the comma-joined list, because an array prop is a new identity every
 *  render and these effects are keyed on it. */
function pickCalendars(all, onlyKey) {
  if (!onlyKey) return all.filter((c) => c.enabled);
  const wanted = new Set(onlyKey.split(','));
  return all.filter((c) => wanted.has(c.uid));
}

/**
 * The user's desktop calendar events, as rendering state.
 *
 * **`from` and `to` are read by their timestamps, not their identity**, so
 * `new Date(...)` inline in the render body is fine and will not re-query on
 * every paint. That is the mistake this hook would otherwise invite, and it
 * costs a round trip per frame.
 *
 * `status` is the whole answer:
 *
 * - `'idle'` — `enabled: false`, nothing asked yet.
 * - `'loading'` — a read is in flight. The first one may be showing the
 *   system's permission prompt: the first read is what asks, so that a
 *   picker the user never opens never prompts.
 * - `'ready'` — `events` is this range.
 * - `'denied'` — the **user's** answer. `openSettings()` puts them in front
 *   of the switch; do not show that button on any other status.
 * - `'unavailable'` — the **machine's** answer: no bridge, not a Mac, no
 *   Evolution Data Server on the bus. An ordinary state, not a failure —
 *   hide the feature rather than reporting it.
 *
 * `errors` is different from all of them: calendars that would not answer
 * while others did, which is one unreachable CalDAV server rather than a
 * failed read.
 */
export function useDesktopCalendarEvents(options) {
  const { from, to, calendars: only, watch = false, enabled = true } = options;
  const app = useAppOrNull();

  const [cal, setCal] = useState(null);
  const [backend, setBackend] = useState(null);
  const [events, setEvents] = useState(NO_EVENTS);
  const [found, setFound] = useState(NO_CALENDARS);
  const [errors, setErrors] = useState(NO_ERRORS);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState(null);
  const [nonce, setNonce] = useState(0);
  const live = useRef(true);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  const openSettings = useCallback(() => openPrivacySettings('calendars'), []);

  // Timestamps, not the `Date` objects: a caller writing
  // `from={new Date(y, m, 1)}` in the render body hands us a new identity
  // every paint, and an effect keyed on that would re-query every frame.
  const fromMs = from.getTime();
  const toMs = to.getTime();
  const onlyKey = only ? only.join(',') : '';

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  // The handle, opened once per connection: the `osascript` child and the
  // bus reference behind it are shared, and one hook must not open a second
  // of either every time the month changes.
  useEffect(() => {
    if (!enabled) {
      setCal(null);
      setBackend(null);
      setStatus('idle');
      return undefined;
    }

    let alive = true;
    let handle = null;
    setStatus('loading');
    desktopCalendar({ app }).then(
      (opened) => {
        if (!alive) {
          void opened?.close();
          return;
        }
        handle = opened;
        setCal(opened);
        setBackend(opened ? opened.backend : null);
        if (!opened) {
          setEvents(NO_EVENTS);
          setStatus('unavailable');
        }
      },
      (err) => {
        if (!alive) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setStatus('unavailable');
      },
    );

    return () => {
      alive = false;
      setCal(null);
      void handle?.close();
    };
  }, [app, enabled]);

  // The query.
  useEffect(() => {
    if (!cal) return undefined;

    let alive = true;
    void (async () => {
      setStatus('loading');
      setError(null);
      try {
        const all = await cal.listCalendars();
        if (!alive) return;
        setFound(all);

        const result = await cal.eventsBetween(
          new Date(fromMs),
          new Date(toMs),
          {
            calendars: pickCalendars(all, onlyKey),
          },
        );
        if (!alive) return;
        setEvents(result.events);
        setErrors(result.errors);
        setStatus('ready');
      } catch (err) {
        if (!alive) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setEvents(NO_EVENTS);
        // The user's refusal and the machine's silence are different words:
        // one has a Settings switch behind it and the other does not.
        setStatus(
          err instanceof CalendarAccessError ? 'denied' : 'unavailable',
        );
      }
    })();

    return () => {
      alive = false;
    };
    // `refresh` is stable; `nonce` is what a manual refresh moves.
  }, [cal, fromMs, toMs, onlyKey, nonce]);

  // The subscription is a **separate** effect, and deliberately not keyed on
  // `nonce`: a change has to re-run the query, and only the query. Watching
  // from inside the effect the change re-runs means every notification tears
  // the views down and starts new ones — which is a loop as soon as anything
  // is delivered while a view is starting, and was one for as long as EDS's
  // `Start()` reported the range's existing contents as a change.
  useEffect(() => {
    if (!cal || !watch) return undefined;

    let alive = true;
    let stopWatching = null;
    void (async () => {
      try {
        const all = await cal.listCalendars();
        if (!alive) return;
        stopWatching = await cal.watch(
          new Date(fromMs),
          new Date(toMs),
          () => {
            // Re-query rather than patch: a recurrence master edited months
            // away changes what this range looks like.
            if (alive && live.current) refresh();
          },
          { calendars: pickCalendars(all, onlyKey) },
        );
        if (!alive) await stopWatching();
      } catch {
        // No grant, no service, nothing to watch. The query effect above is
        // what reports that to the caller; a second copy would only race.
      }
    })();

    return () => {
      alive = false;
      void (async () => {
        if (stopWatching) await stopWatching();
      })();
    };
  }, [cal, watch, fromMs, toMs, onlyKey, refresh]);

  const grouped = useMemo(() => groupByDay(events), [events]);

  return useMemo(
    () => ({
      events,
      byDay: grouped,
      calendars: found,
      errors,
      status,
      backend,
      error,
      refresh,
      openSettings,
    }),
    [
      events,
      grouped,
      found,
      errors,
      status,
      backend,
      error,
      refresh,
      openSettings,
    ],
  );
}

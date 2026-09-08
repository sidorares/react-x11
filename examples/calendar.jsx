// This week, out of the calendars the desktop already has.
//
//   REACT_X11_BACKEND=cocoa npm run examples:calendar   # EventKit, through the bridge
//   npm run examples:calendar                           # XQuartz: an osascript child
//                                                       # Linux: Evolution Data Server
//
// The point is that this app has no accounts, no tokens and no OAuth flow,
// and still shows the user's real Google/iCloud/Exchange/CalDAV events: the
// desktop did all of that, and `useDesktopCalendarEvents()` reads what it
// holds (docs/desktop-calendar.md).
//
// ## What to try
//
//   Run it        the first read raises the system's permission prompt on a
//                 Mac — once, and only because a read asked. Allow it and
//                 the week fills in; refuse and the app says so and offers
//                 the Settings pane, because `'denied'` is the user's answer
//                 and it is one they can change.
//
//   ← / →         another week. The dates are new `Date`s every render and
//                 the hook reads them by value, so paging is one query, not
//                 one per frame.
//
//   Move an event in Calendar (or GNOME Calendar) while this is open: the
//                 store posts a change, `watch` reports it, and the week
//                 re-queries itself. Nothing here patches an event — a
//                 recurrence master edited months away can change today.
//
// ## The footer is the interesting line
//
// It says which rung answered. On one machine that is the bridge, on the
// next the same app is talking to an `osascript` child holding the same
// framework, and on a Linux box it is D-Bus — with the same events in the
// same shape, an exclusive `end` on all three.
import React, { useMemo, useState } from 'react';

import {
  Button,
  createRoot,
  dayKey,
  useDesktopCalendarEvents,
} from '../src/index.js';

const DIM = '$textMuted';
const DAY_MS = 24 * 60 * 60 * 1000;

/** Midnight on the Monday of the week `offset` weeks from `today`'s. */
function weekStart(today, offset) {
  const monday = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  );
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7) + offset * 7);
  return monday;
}

const time = (date) =>
  date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

function Day({ date, events }) {
  const heading = date.toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'short',
  });
  return (
    <box style={{ flexDirection: 'column', gap: 2 }}>
      <text style={{ fontWeight: 'bold', fontSize: 12 }}>{heading}</text>
      {events.length === 0 && (
        <text style={{ color: DIM, fontSize: 11, marginLeft: 8 }}>—</text>
      )}
      {events.map((ev) => (
        <box
          key={`${ev.uid}-${ev.start.getTime()}`}
          style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}
        >
          <box
            style={{
              width: 6,
              height: 6,
              borderRadius: 3,
              backgroundColor: ev.calendar.color ?? '$accent',
            }}
          />
          <text style={{ color: DIM, fontSize: 11, width: 90 }}>
            {ev.allDay ? 'all day' : `${time(ev.start)}–${time(ev.end)}`}
          </text>
          <text style={{ fontSize: 12 }}>{ev.summary || '(no title)'}</text>
        </box>
      ))}
    </box>
  );
}

/** `today` is a seam, not a prop an app would pass: the week on screen is
 *  this week, and a test needs one that does not move (AGENTS.md's sensible
 *  default with a seam). */
export default function App({ today = new Date() }) {
  const [offset, setOffset] = useState(0);
  const from = weekStart(today, offset);
  const to = new Date(from.getTime() + 7 * DAY_MS);

  const { byDay, calendars, errors, status, backend, openSettings, refresh } =
    useDesktopCalendarEvents({ from, to, watch: true });

  const days = useMemo(
    () =>
      Array.from({ length: 7 }, (_, i) => {
        const date = new Date(
          from.getFullYear(),
          from.getMonth(),
          from.getDate() + i,
        );
        return { date, events: byDay.get(dayKey(date)) ?? [] };
      }),
    [byDay, from],
  );

  return (
    <window title="This week" width={460} height={520}>
      <box
        style={{ flexDirection: 'column', gap: 10, padding: 14, flexGrow: 1 }}
      >
        <box style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <Button
            label="◀"
            size="small"
            onPress={() => setOffset((n) => n - 1)}
          />
          <Button
            label="▶"
            size="small"
            onPress={() => setOffset((n) => n + 1)}
          />
          <text style={{ fontSize: 13, fontWeight: 'bold' }}>
            {from.toLocaleDateString(undefined, {
              day: 'numeric',
              month: 'long',
            })}
          </text>
          <box style={{ flexGrow: 1 }} />
          <Button label="Refresh" size="small" onPress={refresh} />
        </box>

        {status === 'unavailable' && (
          <text style={{ color: DIM, fontSize: 12 }}>
            No calendar service on this machine — no EventKit bridge, not a Mac,
            and no Evolution Data Server on the session bus.
          </text>
        )}

        {status === 'denied' && (
          <box style={{ flexDirection: 'column', gap: 6 }}>
            <text style={{ fontSize: 12 }}>
              This app may not read your calendars.
            </text>
            <Button label="Open Settings" primary onPress={openSettings} />
          </box>
        )}

        {status === 'loading' && (
          <text style={{ color: DIM, fontSize: 12 }}>Reading…</text>
        )}

        {status === 'ready' &&
          days.map((day) => (
            <Day key={dayKey(day.date)} date={day.date} events={day.events} />
          ))}

        {errors.map((err) => (
          <text
            key={err.calendar.uid}
            style={{ color: '$warning', fontSize: 11 }}
          >
            {err.calendar.name} did not answer: {err.message}
          </text>
        ))}

        <box style={{ flexGrow: 1 }} />
        <text style={{ color: DIM, fontSize: 11 }}>
          {backend
            ? `${backend} — ${calendars.length} calendar${calendars.length === 1 ? '' : 's'}`
            : 'no calendar backend here'}
        </text>
      </box>
    </window>
  );
}

if (!process.env.REACT_X11_NO_AUTORUN && !import.meta.hot) {
  const root = await createRoot({ cocoa: { appName: 'This week' } });
  root.render(<App />);
}

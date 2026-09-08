# The desktop's calendar

The user's real events — iCloud, Google, Microsoft, CalDAV, a subscribed
feed, the local one — without asking for a single credential and without an
OAuth flow, because the desktop already did all of that. Every account in
System Settings › Internet Accounts, every account in GNOME's Online
Accounts, is in a store this can read.

```jsx
import { useDesktopCalendarEvents } from 'react-x11';

function Month({ from, to }) {
  const { byDay, status, openSettings } = useDesktopCalendarEvents({
    from,
    to,
    watch: true,
  });

  if (status === 'unavailable') return null; // no calendar on this machine
  if (status === 'denied')
    return <Button label="Open Settings" onPress={openSettings} />;

  return (
    <Calendar
      dayContent={(day) =>
        byDay
          .get(day)
          ?.slice(0, 3)
          .map((ev) => (
            <box
              key={ev.uid}
              style={{
                width: 4,
                height: 4,
                borderRadius: 2,
                backgroundColor: ev.calendar.color ?? '$accent',
              }}
            />
          ))
      }
    />
  );
}
```

`<Calendar>` is the grid from
[`@react-x11/components`](ecosystem.md); the `'YYYY-MM-DD'` keys are the one
contract between the two packages, which is why `byDay` is here and the grid
is there. Nothing here draws anything.

## The ladder

The [file dialog](filedialog.md)'s shape again, chosen in order and never by
naming a backend:

|     |                                  |                                                                                                                                                                                                                                           |
| --- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **EventKit through the bridge**  | The [cocoa backend](macos.md), where the app the tree renders through carries `calendars` (`@windowkit/appkit` >= 0.8). One `EKEventStore` for every account, recurrences expanded by the framework, and one notification for any change. |
| 2   | **EventKit through `osascript`** | A Mac with no bridge — every XQuartz install, and a cocoa app over an older bridge. A long-lived `osascript -l JavaScript` child holds the same store and answers JSON lines. Same framework, slower transport.                           |
| 3   | **EDS over the session bus**     | `org.gnome.evolution.dataserver.Sources5` / `Calendar8` — the store every GNOME calendar UI reads, and the one GNOME Online Accounts feeds. Recurrences are expanded here, with `ical.js`.                                                |
| 4   | **nothing**                      | `desktopCalendar()` answers `null` and the hook says `'unavailable'`. An ordinary answer about a machine, not a failure.                                                                                                                  |

```ts
await calendarBackend(); // 'cocoa' | 'osascript' | 'eds' | null
```

`calendarBackend()` reads nothing, spawns nothing and prompts nothing, so it
is safe on a settings screen that wants to say where the events come from.

**Rung 2 outranks rung 3 on a Mac**, which is deliberate: EventKit is that
machine's real store, and an Evolution Data Server installed beside it would
be a second, emptier one.

## The imperative half

```ts
import { desktopCalendar } from 'react-x11';

const cal = await desktopCalendar(); //  DesktopCalendar | null, never rejects
if (!cal) return; //  nothing on this machine
try {
  const calendars = await cal.listCalendars();
  const { events, errors } = await cal.eventsBetween(from, to, { calendars });
  const stop = await cal.watch(from, to, () => reload());
} finally {
  await cal.close();
}
```

`close()` matters on every rung: it stops the views EDS handed out, drops
this handle's share of the `osascript` child, and releases the bus reference.
`useDesktopCalendarEvents` does it for you.

`{ required: true }` turns the `null` into a typed `NoCalendarServiceError`
for a caller who would rather branch in a `catch`, and `{ backend }` pins one
rung and fails rather than falling past it — which is what a test and a "why
is this slow" investigation both want.

## One shape, whichever rung answered

```ts
interface DesktopCalendarInfo {
  uid: string;
  name: string;
  enabled: boolean; //  always true on macOS: no such state to report
  color?: string; //  '#3584e4'
  backend?: string; //  'caldav' | 'local' | 'exchange' | 'subscription' | …
  readOnly: boolean;
  account?: string; //  the Online Accounts / EKSource entry it came from
}

interface DesktopEvent {
  uid: string;
  summary: string;
  location?: string;
  description?: string;
  start: Date;
  end: Date; //  exclusive
  allDay: boolean;
  recurring: boolean;
  calendar: { uid: string; name: string; color?: string };
}
```

Three things the rungs had to agree on, and they are the whole of why this is
one module rather than three:

- **`end` is exclusive.** EventKit reports an all-day event as ending at
  23:59:59 of its last day; iCalendar (so EDS) ends it at the next midnight.
  An app cannot branch on which store it happens to be reading, so the macOS
  rungs normalise on the way out and `byDay` may assume it.
- **A change is "something moved", not a patch.** EDS names the objects that
  changed and EventKit's notification names nothing at all — and neither can
  say what a recurrence master edited three months away did to the range on
  screen. So `watch` reports a change and the only correct answer is to query
  again.
- **"Not allowed to look" is not "no events".** Without the grant EventKit
  answers an empty list, which is a lie an app would draw.

## `byDay`

```ts
const days = byDay(events); //  Map<'YYYY-MM-DD', DesktopEvent[]>
days.get(dayKey(new Date())); //  today's
```

Keyed by **local** day, because a grid draws the user's days. An event lands
under every day it touches, not only under its start — an all-day span
crosses several and a timed one can cross midnight. The hook returns the same
map as `byDay` on its result, already memoised.

## The grant

Only the macOS rungs have one; EDS is reachable or it is not.

```ts
await cal.access(); //  the permission vocabulary; never prompts
await cal.requestAccess(); //  the system's prompt, once
await cal.openSettings(); //  System Settings › Privacy & Security › Calendars
```

**The first read asks.** `listCalendars()` and `eventsBetween()` raise the
prompt when the status is `'prompt'`, the way the notification centre's first
post asks — so a picker the user never opens never prompts, and
`enabled: false` on the hook is how a button defers it. A refusal is a typed
`CalendarAccessError` carrying the status, never an empty list.

`'denied'` is the **user's** answer and `'unavailable'` is the **machine's**.
They are separate words because only one of them has a switch behind it: show
an Open Settings button on `'denied'` and on nothing else
([permissions.md](permissions.md) has the same rule for `'unknown'`).

`'write-only'` — macOS 14's partial grant — is a refusal to a reader, so it
rejects like a denial, but by its own name: an app that also saves events can
tell the two apart.

### Attribution, and what raises the prompt

**The grant does not belong to `osascript`.** It belongs to whatever owns the
process tree. Measured on macOS 15.2 by raising the prompt for real through
the second rung and reading `tccd`'s own record of it
(`log show --predicate 'subsystem == "com.apple.TCC"'`), the attribution is
three processes, not one:

```
AUTHREQ_ATTRIBUTION: service=kTCCServiceCalendar
  responsible = the app that owns the tree   (Terminal, iTerm, the IDE — here
                                              com.anthropic.claude-code)
  accessing   = com.apple.osascript          (/usr/bin/osascript — the child)
  requesting  = com.apple.calaccessd         (CalendarDaemon, doing the check)
```

`responsible` is what TCC keys the decision on and what the dialog names, so:

- The second rung's grant is **shared with everything that terminal or IDE
  runs** — not with every `osascript` on the Mac, and not with this app
  alone. Two react-x11 apps started from the same terminal share one answer;
  the same app launched from Finder asks again.
- A bare `node` on the bridge rung lands in the same place: attributed to its
  responsible process, or to `node` itself where it has none.
- **A bundled app is its own responsible process**, which is the only way to
  get a prompt that names the app and a grant that is the app's — and it must
  carry `NSCalendarsFullAccessUsageDescription` (plus
  `NSCalendarsWriteOnlyAccessUsageDescription` where it asks for the narrower
  grant) or the request never prompts. See [packaging.md](packaging.md).

Also measured on macOS 15.2, with the grant undecided:

- `EKEventStore.authorizationStatusForEntityType` answers from an unbundled
  process with **no prompt** — a status read is always safe.
- Creating the store never prompts either; only a request does.
- Without the grant, `calendarsForEntityType` answers an **empty array** and
  `eventsMatchingPredicate` an empty one — no error. That is the whole reason
  the ladder checks the status first rather than reporting "no events".
- The `osascript` child starts and answers its first line in ~130 ms.

## `useDesktopCalendarEvents()`

```ts
const {
  events,
  byDay,
  calendars,
  errors,
  status,
  backend,
  error,
  refresh,
  openSettings,
} = useDesktopCalendarEvents({ from, to, calendars?, watch?, enabled? });
```

| `status`        |                                                                                                                        |
| --------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `'idle'`        | `enabled: false` — nothing has been asked, including the grant                                                         |
| `'loading'`     | a read is in flight; the first one may be showing the system's prompt                                                  |
| `'ready'`       | `events` is this range                                                                                                 |
| `'denied'`      | the user's answer. `openSettings()` is the way back                                                                    |
| `'unavailable'` | the machine's answer: no rung — or a request TCC would not even ask (above). Hide the feature rather than reporting it |

`errors` is none of those: calendars that would not answer while others did.
One unreachable CalDAV server must not blank a whole month of the user's own
local calendar, so it is reported beside the events rather than instead of
them. It is always empty on the macOS rungs, where there is one store.

**`from` and `to` are read by their timestamps, not their identity**, so
`from={new Date(y, m, 1)}` inline in the render body is fine and does not
re-query every paint. That is the mistake this hook is shaped to survive.

## What differs between the rungs

- **Recurrences.** EventKit expands them; EDS answers with unexpanded masters
  and `ical.js` expands them here. A malformed `RRULE` with no `UNTIL` is
  guarded at 2000 occurrences on that rung.
- **`enabled`.** EDS reports whether the user switched a calendar off;
  EventKit has no such state — a calendar unchecked in Calendar.app is still
  in the store — so it is always `true` there.
- **The change signal.** EDS names the calendar, the kind (`ObjectsAdded`,
  `ObjectsModified`, `ObjectsRemoved`) and a count; EventKit's is one
  `'changed'` with a null calendar and no count, because its notification
  names nothing and a rung must not invent one.
- **The range.** EventKit's predicate spans at most four years, so a longer
  one is asked for in pieces and merged (an occurrence on a seam is reported
  once). EDS takes any range.
- **What the app is on the bus.** The EDS rung borrows react-x11's shared
  session bus ([dbus.md](dbus.md)), so an app is one name on the bus however
  many features it turns on.

## `ical.js`

A regular dependency, loaded behind one lazy `import('ical.js')` with a
static specifier: it is 268 KB of a 1.2 MB package, has no dependencies of
its own, no native code and no install script (MPL-2.0, file-level copyleft).
The `import()` keeps it off the startup path — an app that never opens a
calendar never parses it — while a static specifier is something a bundler
or a single-executable build can still follow, which the run-time-built
specifier an optional dependency needs is not. Neither macOS rung loads it.

## Writing

Not yet — [#504](https://github.com/sidorares/react-x11/issues/504)'s third
milestone. The bridge has `saveEvent`/`removeEvent` with the recurrence span
(`@windowkit/appkit` >= 0.8) and EDS has `CreateObjects`/`ModifyObjects`/
`RemoveObjects`, so the shape is known; what is here reads.

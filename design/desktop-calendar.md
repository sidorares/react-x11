# The desktop's calendar: design notes

Contributor-only, not shipped and not on the website. These sections were
moved out of [docs/desktop-calendar.md](../docs/desktop-calendar.md), the reference, and keep
their original headings so code comments that cite them still resolve.

## The ladder

|     |                                  |                                                                                                                                                                                                                                                   |
| --- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **EventKit through the bridge**  | The [cocoa backend](../docs/macos.md), where the app the tree renders through carries `calendars` (`@windowkit/appkit` >= 0.8). One `EKEventStore` for every account, recurrences expanded by the framework, and one notification for any change. |
| 2   | **EventKit through `osascript`** | A Mac with no bridge — every XQuartz install, and a cocoa app over an older bridge. A long-lived `osascript -l JavaScript` child holds the same store and answers JSON lines. Same framework, slower transport.                                   |
| 3   | **EDS over the session bus**     | `org.gnome.evolution.dataserver.Sources5` / `Calendar8` — the store every GNOME calendar UI reads, and the one GNOME Online Accounts feeds. Recurrences are expanded here, with `ical.js`.                                                        |
| 4   | **nothing**                      | `desktopCalendar()` answers `null` and the hook says `'unavailable'`. An ordinary answer about a machine, not a failure.                                                                                                                          |

## One shape, whichever rung answered

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

## The grant

**The first read asks.** `listCalendars()` and `eventsBetween()` raise the
prompt when the status is `'prompt'`, the way the notification centre's first
post asks — so a picker the user never opens never prompts, and
`enabled: false` on the hook is how a button defers it. A refusal is a typed
`CalendarAccessError` carrying the status, never an empty list.

`'denied'` is the **user's** answer and `'unavailable'` is the **machine's**.
They are separate words because only one of them has a switch behind it: show
an Open Settings button on `'denied'` and on nothing else
([permissions.md](../docs/permissions.md) has the same rule for `'unknown'`).

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
  grant) or the request never prompts. See [packaging.md](../docs/packaging.md).

Also measured on macOS 15.2, with the grant undecided:

- `EKEventStore.authorizationStatusForEntityType` answers from an unbundled
  process with **no prompt** — a status read is always safe.
- Creating the store never prompts either; only a request does.
- Without the grant, `calendarsForEntityType` answers an **empty array** and
  `eventsMatchingPredicate` an empty one — no error. That is the whole reason
  the ladder checks the status first rather than reporting "no events".
- The `osascript` child starts and answers its first line in ~130 ms.

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

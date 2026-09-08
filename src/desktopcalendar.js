// The calendars the user's desktop already has — read, not owned.
//
// The point of this module is that an app gets the user's real events —
// iCloud, Google, Microsoft, CalDAV, local — without asking for a single
// credential and without an OAuth flow, because the desktop already did all
// of that. Every account in System Settings > Internet Accounts, every
// account in GNOME's Online Accounts, is already in a store this can read.
//
// docs/filedialog.md's ladder again, chosen in order and never by name:
//
//   1. **EventKit through the bridge** — the cocoa backend, where the app
//      the tree renders through carries `calendars` (src/cocoa/calendar.js).
//      One framework for every account, recurrences expanded by it, and one
//      notification for any change.
//   2. **EventKit through `osascript`** — macOS with no bridge, which is
//      every XQuartz install and every cocoa app over a bridge older than
//      0.8. A long-lived `osascript -l JavaScript` child holds an
//      `EKEventStore` and answers JSON lines: the same framework, a slower
//      transport, and the rung that shipped before the bridge did.
//   3. **EDS over the session bus** — `org.gnome.evolution.dataserver.*`,
//      the store every GNOME calendar UI reads and the one GNOME Online
//      Accounts feeds. Recurrences are expanded here with `ical.js`,
//      because EDS answers with unexpanded masters.
//   4. **nothing** — `desktopCalendar()` answers `null`, which is an
//      ordinary answer about a machine rather than a failure. Only
//      `{ required: true }` turns it into a typed rejection.
//
// ## What the ladder had to agree on
//
// - **`end` is exclusive.** EventKit reports an all-day event ending at the
//   last second of its last day and iCalendar ends it at the next midnight;
//   an app cannot branch on which store it happens to be reading, so the
//   macOS rungs normalise (`withExclusiveEnd`) and `byDay` may assume it.
// - **A change is "something moved", not a patch.** EDS names the objects,
//   EventKit's notification names nothing at all, and a recurrence master
//   edited three months away changes what today looks like either way. So
//   `watch` reports a change and the answer is always to query again.
// - **"Not allowed to look" is not "no events".** The macOS rungs need the
//   TCC grant; without it a read would answer an empty list, which is a lie.
//   They ask on the first read and reject with {@link CalendarAccessError}
//   when the answer is no, and `'denied'` (the user's answer) stays apart
//   from `null` (the machine's).
//
// Nothing here opens a D-Bus connection of its own: `sessionBus()` hands
// over react-x11's shared one, so an app is one name on the bus however many
// features it turns on. Nothing here writes, either — issue #504's third
// milestone.

import { hasService } from './portal.js';
import { openPrivacySettings } from './permissions.js';
import { sessionBus } from './bus.js';
import { liveApps } from './trace-registry.js';

const SOURCES_NAME = 'org.gnome.evolution.dataserver.Sources5';
const SOURCES_PATH = '/org/gnome/evolution/dataserver/SourceManager';
const OBJECT_MANAGER = 'org.freedesktop.DBus.ObjectManager';
const FACTORY_NAME = 'org.gnome.evolution.dataserver.Calendar8';
const FACTORY_PATH = '/org/gnome/evolution/dataserver/CalendarFactory';
const FACTORY_IFACE = 'org.gnome.evolution.dataserver.CalendarFactory';
const CAL_IFACE = 'org.gnome.evolution.dataserver.Calendar';
const VIEW_IFACE = 'org.gnome.evolution.dataserver.CalendarView';

// --------------------------------------------------------------------------
// What "nothing here can answer" looks like
// --------------------------------------------------------------------------

/**
 * No calendar service on this machine: no bridge, not a Mac, and no
 * Evolution Data Server on the session bus.
 *
 * A **typed** rejection, the {@link NoFileDialogError} rule — a caller keeps
 * the feature behind it rather than crashing. Only `{ required: true }`
 * raises it; by default `desktopCalendar()` answers `null`, because a
 * machine with no calendar service is an ordinary machine.
 */
export class NoCalendarServiceError extends Error {
  constructor(cause) {
    super(
      'react-x11: no desktop calendar here — this backend has no EventKit ' +
        'bridge, this is not macOS, and there is no Evolution Data Server ' +
        'on the session bus. Call desktopCalendar() without `required` and ' +
        'branch on null, or calendarBackend() to ask first.',
      { cause },
    );
    this.name = 'NoCalendarServiceError';
  }
}

/**
 * The user has not allowed this app to read their calendars.
 *
 * `status` is the permission vocabulary (docs/permissions.md): `'denied'`,
 * `'restricted'` (MDM or parental controls), `'write-only'` (macOS 14's
 * partial grant — a real grant to a writer, a refusal to a reader), or
 * `'prompt'` where the request was made and nothing came back, which is TCC
 * declining to ask rather than the user declining to allow. `'unknown'` is
 * not among them: where nothing can say, the read is allowed to try and
 * whatever it hits is the answer.
 *
 * Separate from {@link NoCalendarServiceError} on purpose: this one is
 * about a decision, and a decision can be changed —
 * `openPrivacySettings('calendars')` puts the user in front of the switch.
 */
export class CalendarAccessError extends Error {
  constructor(status, cause) {
    super(
      `react-x11: this app may not read the desktop's calendars (${status}). ` +
        'On macOS that is the Calendars privacy setting: openPrivacySettings' +
        "('calendars') opens the pane. Read cal.access() to branch before " +
        'asking.',
      { cause },
    );
    this.name = 'CalendarAccessError';
    this.status = status;
  }
}

// --------------------------------------------------------------------------
// One shape, whichever rung answered
// --------------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');

/**
 * The local calendar day a `Date` falls on, as `'YYYY-MM-DD'`.
 *
 * The **format** is the contract between this and a calendar grid — these
 * keys index straight into `<Calendar dayContent>` in
 * `@react-x11/components` — so it is local time, not UTC: a grid draws the
 * user's days.
 */
export function dayKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Occurrences grouped by the local day they appear on — which is what a
 * calendar grid actually renders.
 *
 * ```js
 * const days = byDay(events);
 * days.get(dayKey(new Date()));      // today's
 * ```
 *
 * An all-day event spans `[start, end)` across possibly several days and a
 * timed one can cross midnight, so an event lands under **every** day it
 * touches rather than only under its start.
 */
export function byDay(events) {
  const days = new Map();
  for (const event of events) {
    // `end` is exclusive, so a one-day all-day event ending at the next
    // midnight must not also mark the next day.
    const lastMs = Math.max(event.start.getTime(), event.end.getTime() - 1);
    const last = new Date(lastMs);
    const cursor = new Date(
      event.start.getFullYear(),
      event.start.getMonth(),
      event.start.getDate(),
    );
    while (cursor <= last) {
      const key = dayKey(cursor);
      const list = days.get(key);
      if (list) list.push(event);
      else days.set(key, [event]);
      cursor.setDate(cursor.getDate() + 1);
    }
  }
  return days;
}

/** By start, ascending. Every rung answers sorted, across its calendars. */
export function sortEvents(events) {
  return events.sort((a, b) => a.start.getTime() - b.start.getTime());
}

/**
 * An all-day end as the exclusive one the rest of the ladder means.
 *
 * EventKit reports an all-day event as ending at 23:59:59 of its last day;
 * iCalendar (so EDS) ends it at the next midnight. `byDay` and every caller
 * that subtracts to get a duration read `end` as exclusive, so the macOS
 * rungs round the reported end up to the next local midnight — and an end
 * that is *already* midnight is already exclusive and must not gain a day.
 */
export function withExclusiveEnd(end, allDay) {
  if (!allDay || !(end instanceof Date) || Number.isNaN(end.getTime())) {
    return end;
  }
  const atMidnight =
    end.getHours() === 0 &&
    end.getMinutes() === 0 &&
    end.getSeconds() === 0 &&
    end.getMilliseconds() === 0;
  if (atMidnight) return end;
  return new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1);
}

/** `[r, g, b, a]` in 0..1, as EventKit gives a calendar's colour, to the
 *  `'#rrggbb'` the EDS rung reads out of a keyfile. Alpha is dropped: a
 *  calendar colour is opaque, and a marker drawn in it should be too. */
export function hexFromComponents(color) {
  if (!Array.isArray(color) || color.length < 3) return undefined;
  const channel = (v) =>
    Math.max(0, Math.min(255, Math.round(Number(v) * 255)))
      .toString(16)
      .padStart(2, '0');
  return `#${channel(color[0])}${channel(color[1])}${channel(color[2])}`;
}

/** EventKit's `EKCalendarType` word as the lower-case one EDS's keyfile
 *  uses for the same thing — `caldav`, `local`, `exchange`. */
export function calendarBackendName(type) {
  return typeof type === 'string' && type ? type.toLowerCase() : undefined;
}

/**
 * EventKit's event predicate spans at most four years, so a longer range is
 * asked for in pieces. 1400 days is comfortably inside that limit and a
 * whole number of days, so a chunk boundary never lands mid-event for an
 * all-day one.
 */
const MAX_SPAN_MS = 1400 * 24 * 60 * 60 * 1000;

/** `[[startMs, endMs], …]`, each at most {@link MAX_SPAN_MS}. */
export function chunkSpan(from, to) {
  const start = from instanceof Date ? from.getTime() : Number(from);
  const end = to instanceof Date ? to.getTime() : Number(to);
  if (!(end > start)) return [[start, end]];
  const chunks = [];
  for (let at = start; at < end; at += MAX_SPAN_MS) {
    chunks.push([at, Math.min(at + MAX_SPAN_MS, end)]);
  }
  return chunks;
}

// --------------------------------------------------------------------------
// Rung 3: Evolution Data Server, over the session bus
// --------------------------------------------------------------------------

/**
 * `E_CAL_CLIENT_VIEW_FLAGS_NONE`. A view is created with `NOTIFY_INITIAL`
 * instead, which makes `Start()` replay everything already matching the
 * query as `ObjectsAdded` — the current contents, announced as if they had
 * just changed.
 *
 * That is the wrong signal for a watcher whose answer to a change is to run
 * the query again: the re-query tears the view down, starts a new one, and
 * is told the same thing again, for as long as the app is open. Flags of
 * NONE is the whole of "only tell me what changes from here".
 */
const VIEW_FLAGS_NONE = 0;

/** `20260807T113000Z` — what the S-expression query wants. */
function icalStamp(d) {
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

/** The query EDS understands for "anything happening between these two". */
function rangeQuery(from, to) {
  return `(occur-in-time-range? (make-time "${icalStamp(from)}") (make-time "${icalStamp(to)}"))`;
}

/**
 * A source's whole configuration is an ini-style keyfile carried in one
 * D-Bus property, so it has to be parsed to find out whether a source is
 * even a calendar (as opposed to an address book, a mail account or a task
 * list).
 */
export function parseKeyFile(text) {
  const out = {};
  let section = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      section = line.slice(1, -1);
      out[section] = out[section] ?? {};
      continue;
    }
    if (!section) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (key.includes('[')) continue; // a DisplayName[ru] translation
    out[section][key] = line.slice(eq + 1).trim();
  }
  return out;
}

/**
 * `ical.js`, loaded once and lazily.
 *
 * A **regular dependency** behind a static specifier: 268 KB of the 1.2 MB
 * package is what loads, it has no dependencies of its own and no native
 * code, and a bundler or a single-executable build can follow a static
 * specifier where it cannot follow the run-time-built one an optional
 * dependency needs. The `import()` keeps it off the startup path — an app
 * that never opens a calendar never parses it — and this rung is the only
 * caller: EventKit expands its own recurrences.
 */
let icalModule = null;
async function loadIcal() {
  if (!icalModule) {
    icalModule = import('ical.js').then((mod) => {
      // CJS-with-a-default under some resolutions, a namespace under others.
      const resolved = typeof mod.parse === 'function' ? mod : mod.default;
      if (!resolved || typeof resolved.parse !== 'function') {
        icalModule = null;
        throw new TypeError('ical.js did not export what was expected');
      }
      return resolved;
    });
  }
  return icalModule;
}

/**
 * The desktop's calendars, over a bus someone else owns.
 *
 * Two services are involved: `Sources5` is the registry (which calendars
 * exist, their names and colours) and `Calendar8` the store (open a
 * calendar, query a range, watch it). Nothing here closes the connection,
 * because nothing here opened it.
 */
export class EdsCalendars {
  constructor(bus) {
    this.backend = 'eds';
    this._bus = bus;
    this._open = new Map();
    this._views = [];
    this._timezones = new Set();
  }

  /** EDS is reachable or it is not; there is no grant to ask for. */
  async access() {
    return 'granted';
  }

  async requestAccess() {
    return 'granted';
  }

  /** Every calendar the desktop knows about, colour included. */
  async listCalendars() {
    const om = await this._bus
      .getService(SOURCES_NAME)
      .getInterface(SOURCES_PATH, OBJECT_MANAGER);
    const managed = await om.GetManagedObjects();

    const calendars = [];
    for (const interfaces of Object.values(managed)) {
      const src = interfaces['org.gnome.evolution.dataserver.Source'];
      if (!src) continue;
      const cfg = parseKeyFile(String(src.Data ?? ''));
      // no [Calendar] section means an address book, a task list or mail
      if (!cfg.Calendar) continue;
      const ds = cfg['Data Source'] ?? {};
      calendars.push({
        uid: String(src.UID ?? ''),
        name: ds.DisplayName ?? '',
        enabled: ds.Enabled !== 'false',
        color: cfg.Calendar.Color,
        backend: cfg.Calendar.BackendName,
        readOnly: !interfaces['org.gnome.evolution.dataserver.Source.Writable'],
        account: cfg['GNOME Online Accounts']?.Account,
      });
    }
    return calendars;
  }

  async _openCalendar(uid) {
    const existing = this._open.get(uid);
    if (existing) return existing;

    const factory = await this._bus
      .getService(FACTORY_NAME)
      .getInterface(FACTORY_PATH, FACTORY_IFACE);
    const [path, busName] = await factory.OpenCalendar(uid);
    const cal = await this._bus
      .getService(busName)
      .getInterface(path, CAL_IFACE);
    await cal.Open();

    const entry = { cal, busName };
    this._open.set(uid, entry);
    return entry;
  }

  /**
   * Events reference timezones by id, but the payload rarely carries the
   * matching VTIMEZONE — so definitions are fetched on demand and registered
   * with ical.js. A backend that has none leaves the time floating, which is
   * ical.js's own fallback and better than refusing the event.
   */
  async _ensureTimezone(ICAL, cal, tzid) {
    if (!tzid || this._timezones.has(tzid) || ICAL.TimezoneService.has(tzid)) {
      return;
    }
    this._timezones.add(tzid);
    try {
      const vtz = await cal.GetTimezone(tzid);
      const comp = new ICAL.Component(ICAL.parse(vtz));
      const sub =
        comp.name === 'vtimezone'
          ? comp
          : comp.getFirstSubcomponent('vtimezone');
      if (sub) ICAL.TimezoneService.register(tzid, new ICAL.Timezone(sub));
    } catch {
      /* no definition for it; ical.js falls back to floating time */
    }
  }

  /**
   * Expanded occurrences between two `Date`s, across the calendars given (or
   * every enabled one). Sorted by start.
   *
   * A backend that is offline or broken contributes an entry in `errors`
   * rather than throwing: one unreachable CalDAV server must not blank a
   * whole month of the user's own local calendar.
   */
  async eventsBetween(from, to, options = {}) {
    const ICAL = await loadIcal();
    const list =
      options.calendars ??
      (await this.listCalendars()).filter((c) => c.enabled);
    const query = rangeQuery(from, to);

    const perCalendar = await Promise.all(
      list.map(async (meta) => {
        try {
          const { cal } = await this._openCalendar(meta.uid);
          const objects = await cal.GetObjectList(query);
          return {
            events: await this._expand(ICAL, cal, objects, from, to, meta),
            error: null,
          };
        } catch (err) {
          return {
            events: [],
            error: {
              calendar: meta,
              message: err instanceof Error ? err.message : String(err),
            },
          };
        }
      }),
    );

    const events = [];
    const errors = [];
    for (const chunk of perCalendar) {
      events.push(...chunk.events);
      if (chunk.error) errors.push(chunk.error);
    }
    return { events: sortEvents(events), errors };
  }

  async _expand(ICAL, cal, objects, from, to, meta) {
    const out = [];
    for (const ics of objects) {
      let comp;
      try {
        comp = new ICAL.Component(ICAL.parse(ics));
      } catch {
        continue; // one unparseable object is not the range's problem
      }

      // Register any VTIMEZONE shipped inline, then any referenced by id.
      for (const vtz of comp.getAllSubcomponents('vtimezone')) {
        const tz = new ICAL.Timezone(vtz);
        if (!ICAL.TimezoneService.has(tz.tzid)) {
          ICAL.TimezoneService.register(tz.tzid, tz);
        }
      }

      const vevents =
        comp.name === 'vevent' ? [comp] : comp.getAllSubcomponents('vevent');
      for (const ve of vevents) {
        for (const prop of ['dtstart', 'dtend']) {
          const p = ve.getFirstProperty(prop);
          if (p) await this._ensureTimezone(ICAL, cal, p.getParameter('tzid'));
        }
        const event = new ICAL.Event(ve);
        // folded in by the recurrence iterator below
        if (event.isRecurrenceException()) continue;

        const push = (startTime, endTime) => {
          const start = startTime.toJSDate();
          const end = endTime ? endTime.toJSDate() : start;
          if (end < from || start >= to) return;
          out.push({
            uid: event.uid,
            summary: event.summary || '',
            location: event.location || undefined,
            description: event.description || undefined,
            start,
            end,
            allDay: event.startDate.isDate,
            recurring: event.isRecurring(),
            calendar: { uid: meta.uid, name: meta.name, color: meta.color },
          });
        };

        if (!event.isRecurring()) {
          push(event.startDate, event.endDate);
          continue;
        }

        const duration = event.duration;
        const it = event.iterator();
        let next;
        // A malformed RRULE with no UNTIL and a tiny interval can iterate
        // forever; the range check below normally ends it, and this is the
        // backstop for the case where it cannot.
        let guard = 0;
        while ((next = it.next()) && guard++ < 2000) {
          if (next.toJSDate() >= to) break;
          const end = next.clone();
          end.addDuration(duration);
          if (end.toJSDate() < from) continue;
          const details = event.getOccurrenceDetails(next);
          push(details.startDate, details.endDate);
        }
      }
    }
    return out;
  }

  /**
   * Live updates: `onChange` fires whenever anything in the range moves.
   *
   * **Changes only.** What is in the range already is what `eventsBetween`
   * answered; `onChange` fires for what happens after that. See
   * {@link VIEW_FLAGS_NONE} for the loop that reporting the initial contents
   * as a change costs a caller who re-queries on one.
   */
  async watch(from, to, onChange, options = {}) {
    const list =
      options.calendars ??
      (await this.listCalendars()).filter((c) => c.enabled);
    const query = rangeQuery(from, to);
    const started = [];

    for (const meta of list) {
      try {
        const { cal, busName } = await this._openCalendar(meta.uid);
        const viewPath = await cal.GetView(query);
        const view = await this._bus
          .getService(busName)
          .getInterface(viewPath, VIEW_IFACE);

        // Belt to `VIEW_FLAGS_NONE`'s braces, for a backend that would not
        // take the flags: `Complete` closes the initial delivery, so anything
        // before it is the replay rather than a change. Only armed when
        // `SetFlags` failed — a view that never reports `Complete` would
        // otherwise be watched in silence, and losing live updates is the
        // worse half of the trade.
        let replaying = false;
        try {
          await view.SetFlags(VIEW_FLAGS_NONE);
        } catch {
          replaying = true;
        }
        await view.$subscribe('Complete', () => {
          replaying = false;
        });

        for (const signal of [
          'ObjectsAdded',
          'ObjectsModified',
          'ObjectsRemoved',
        ]) {
          await view.$subscribe(signal, (objects) => {
            if (replaying) return;
            onChange({
              calendar: meta,
              kind: signal,
              count: Array.isArray(objects) ? objects.length : 0,
            });
          });
        }
        await view.Start();
        started.push(view);
        this._views.push(view);
      } catch {
        /* skip a calendar that will not open; the others still update */
      }
    }

    return async () => {
      for (const view of started) {
        this._views = this._views.filter((v) => v !== view);
        await stopView(view);
      }
    };
  }

  /** Stop every view this instance started. Does **not** touch the bus. */
  async close() {
    const views = this._views;
    this._views = [];
    for (const view of views) await stopView(view);
    this._open.clear();
  }
}

async function stopView(view) {
  try {
    await view.Stop();
    await view.Dispose();
  } catch {
    /* already gone */
  }
}

// --------------------------------------------------------------------------
// Rung 2: EventKit through an `osascript` child
// --------------------------------------------------------------------------

/**
 * One JXA program: hold an `EKEventStore`, answer JSON lines on stdin with
 * JSON lines on stdout, and push one more whenever macOS says the store
 * changed.
 *
 * **Why a child at all.** EventKit is a framework, not a service: there is
 * no bus to call and no command-line tool that answers this. `osascript -l
 * JavaScript` is the interpreter every Mac has that can hold framework
 * objects, and JXA passes a JS function where the framework wants a block —
 * which is what makes the completion handler and the change observer
 * possible at all.
 *
 * **Why long-lived.** A process per query would pay ~450 ms of interpreter
 * and framework start-up each time, and — more to the point — could not
 * observe a change, because the observer only fires while a run loop is
 * running. One child per process, ref-counted, is the same bargain
 * `sessionBus()` makes.
 *
 * **What it writes and where.** `console.log` in JXA has gone to stderr in
 * some macOS releases and stdout in others, so replies are written to
 * stdout's file handle directly and stderr is left for the noise AppKit
 * prints into every process that touches it.
 *
 * **It leaves when its parent has.** Eight orphaned appearance watchers were
 * once found on one machine, days old, reparented to launchd by apps that
 * died without running an exit handler; the same 5-second `getppid()` check
 * is here for the same reason.
 *
 * Exported so a test can pin the source; it cannot be executed off a Mac.
 */
export const MACOS_CALENDAR_PROGRAM = `
ObjC.import('EventKit');
ObjC.import('AppKit');
ObjC.import('stdlib');
ObjC.import('unistd');

var stdout = $.NSFileHandle.fileHandleWithStandardOutput;
function emit(o) {
  var s = JSON.stringify(o) + '\\n';
  stdout.writeData($.NSString.alloc.initWithUTF8String(s)
    .dataUsingEncoding($.NSUTF8StringEncoding));
}
// A nil ObjC object is callable in JXA rather than null, and an unset
// property on an unsaved object is a plain undefined, so both are checked.
function str(v) {
  try {
    if (v === undefined || v === null) return null;
    if (typeof v === 'string') return v;
    if (typeof v.isNil === 'function' && v.isNil()) return null;
    var s = ObjC.unwrap(v);
    return typeof s === 'string' ? s : null;
  } catch (e) { return null; }
}
function ms(d) {
  try {
    if (!d || (typeof d.isNil === 'function' && d.isNil())) return null;
    return Math.round(Number(d.timeIntervalSince1970) * 1000);
  } catch (e) { return null; }
}

// EKAuthorizationStatus, as react-x11's permission vocabulary. 3 is
// authorized before macOS 14 and fullAccess after it; 4 is the write-only
// grant macOS 14 added, which is a refusal to a reader and its own word.
var STATUS = ['prompt', 'restricted', 'denied', 'granted', 'write-only'];
function statusWord() {
  var n = Number($.EKEventStore.authorizationStatusForEntityType($.EKEntityTypeEvent));
  return STATUS[n] || 'unknown';
}

var store = null;
function eventStore() {
  // Creating the store never prompts; only a request does.
  if (store === null) store = $.EKEventStore.alloc.init;
  return store;
}

var TYPES = ['local', 'calDAV', 'exchange', 'subscription', 'birthday'];
function colorOf(cal) {
  try {
    var c = cal.color;
    if (!c || (typeof c.isNil === 'function' && c.isNil())) return null;
    var s = c.colorUsingColorSpace($.NSColorSpace.sRGBColorSpace);
    if (!s || (typeof s.isNil === 'function' && s.isNil())) return null;
    return [Number(s.redComponent), Number(s.greenComponent),
            Number(s.blueComponent), Number(s.alphaComponent)];
  } catch (e) { return null; }
}
function calendarObjects() {
  return eventStore().calendarsForEntityType($.EKEntityTypeEvent);
}
function listCalendars() {
  var cals = calendarObjects();
  var out = [];
  for (var i = 0; i < Number(cals.count); i++) {
    var c = cals.objectAtIndex(i);
    var source = null;
    try {
      if (c.source && !(typeof c.source.isNil === 'function' && c.source.isNil())) {
        source = { id: str(c.source.sourceIdentifier), title: str(c.source.title) };
      }
    } catch (e) {}
    out.push({
      id: str(c.calendarIdentifier),
      title: str(c.title),
      color: colorOf(c),
      type: TYPES[Number(c.type)] || null,
      source: source,
      allowsModifications: !!c.allowsContentModifications,
      immutable: !!c.immutable,
      subscribed: !!c.subscribed
    });
  }
  return out;
}
function eventsBetween(startMs, endMs, ids) {
  var filter = $();
  if (ids && ids.length) {
    var wanted = {};
    for (var k = 0; k < ids.length; k++) wanted[ids[k]] = true;
    var all = calendarObjects();
    var picked = $.NSMutableArray.alloc.init;
    for (var i = 0; i < Number(all.count); i++) {
      var c = all.objectAtIndex(i);
      if (wanted[str(c.calendarIdentifier)]) picked.addObject(c);
    }
    // An empty selection means "these calendars, of which none are here" —
    // not "every calendar", which is what a nil filter means.
    if (Number(picked.count) === 0) return [];
    filter = picked;
  }
  var pred = eventStore().predicateForEventsWithStartDateEndDateCalendars(
    $.NSDate.dateWithTimeIntervalSince1970(startMs / 1000),
    $.NSDate.dateWithTimeIntervalSince1970(endMs / 1000), filter);
  var evs = eventStore().eventsMatchingPredicate(pred);
  var out = [];
  if (!evs || (typeof evs.isNil === 'function' && evs.isNil())) return out;
  for (var j = 0; j < Number(evs.count); j++) {
    var e = evs.objectAtIndex(j);
    var cal = null;
    try { cal = str(e.calendar.calendarIdentifier); } catch (err) {}
    out.push({
      id: str(e.eventIdentifier),
      calendar: cal,
      title: str(e.title),
      location: str(e.location),
      notes: str(e.notes),
      start: ms(e.startDate),
      end: ms(e.endDate),
      allDay: !!e.allDay,
      recurring: !!e.hasRecurrenceRules
    });
  }
  return out;
}

var watching = false;
function watch() {
  if (watching) return true;
  watching = true;
  $.NSNotificationCenter.defaultCenter.addObserverForNameObjectQueueUsingBlock(
    'EKEventStoreChangedNotification', eventStore(),
    $.NSOperationQueue.mainQueue, function () { emit({ event: 'changed' }); });
  return true;
}

function request(id) {
  var s = eventStore();
  var answered = false;
  var reply = function () {
    if (answered) return;
    answered = true;
    emit({ id: id, ok: statusWord() });
  };
  // The completion is asked for and answered on if it ever comes — but it is
  // never waited on. **Measured on macOS 15.2: an osascript process is never
  // called back**, not even when the grant is already held, so a rung that
  // waited for it would hang forever on its first read. The status is what
  // the caller wanted anyway, and it is the one thing that cannot be lost.
  try {
    // macOS 14 split the one request in two; before it there was only the
    // entity-type form.
    if (typeof s.requestFullAccessToEventsWithCompletion === 'function') {
      s.requestFullAccessToEventsWithCompletion(reply);
    } else {
      s.requestAccessToEntityTypeCompletion($.EKEntityTypeEvent, reply);
    }
  } catch (e) {
    // whatever the framework refused, the poll below still answers
  }
  // So the answer is the status, watched until it stops being undecided.
  // The deadline is for the case that has no dialog at all: TCC declines to
  // ask for a platform binary, and for a responsible app whose hardened
  // runtime lacks com.apple.security.personal-information.calendars — and
  // then nothing will ever change. 'prompt' is the honest answer there, and
  // the JS side does not remember it, so a later read asks again.
  var waited = 0;
  $.NSTimer.scheduledTimerWithTimeIntervalRepeatsBlock(0.25, true,
    function (timer) {
      waited += 0.25;
      if (answered) { timer.invalidate; return; }
      if (statusWord() !== 'prompt' || waited >= 30) {
        timer.invalidate;
        reply();
      }
    });
}

function handle(msg) {
  switch (msg.op) {
    case 'status': return statusWord();
    case 'calendars': return listCalendars();
    case 'events': return eventsBetween(msg.start, msg.end, msg.calendars);
    case 'watch': return watch();
    case 'ping': return 'pong';
    default: throw new Error('unknown op ' + msg.op);
  }
}

var stdin = $.NSFileHandle.fileHandleWithStandardInput;
var buffered = '';
$.NSNotificationCenter.defaultCenter.addObserverForNameObjectQueueUsingBlock(
  $.NSFileHandleDataAvailableNotification, stdin, $.NSOperationQueue.mainQueue,
  function () {
    var data = stdin.availableData;
    // Zero bytes is end of file: the parent closed the pipe, or died.
    if (!data || Number(data.length) === 0) $.exit(0);
    buffered += ObjC.unwrap($.NSString.alloc.initWithDataEncoding(
      data, $.NSUTF8StringEncoding));
    var at;
    while ((at = buffered.indexOf('\\n')) !== -1) {
      var line = buffered.slice(0, at);
      buffered = buffered.slice(at + 1);
      if (!line.trim()) continue;
      var msg;
      try { msg = JSON.parse(line); } catch (e) { continue; }
      if (msg.op === 'quit') $.exit(0);
      if (msg.op === 'request') { request(msg.id); continue; }
      try {
        emit({ id: msg.id, ok: handle(msg) });
      } catch (e) {
        emit({ id: msg.id, error: String(e && e.message ? e.message : e) });
      }
    }
    stdin.waitForDataInBackgroundAndNotify;
  });
stdin.waitForDataInBackgroundAndNotify;

emit({ ready: true, status: statusWord() });

// An app that dies without its exit handler (a signal, a crash) leaves this
// process behind, reparented to launchd, for as long as the machine is up.
$.NSTimer.scheduledTimerWithTimeIntervalRepeatsBlock(5, true, function () {
  if ($.getppid() === 1) $.exit(0);
});
$.NSRunLoop.currentRunLoop.run();
`;

/** How long to wait for the child's first line before giving up on it. */
const CHILD_READY_TIMEOUT_MS = 10_000;

/**
 * Test seam, not public: what spawns the child. A fake here also lets the
 * rung run off a Mac, where the real one cannot, so the protocol is tested
 * on CI rather than on whoever has a Mac.
 */
let spawnChild = null;
export function _setCalendarSpawnForTests(fn) {
  _closeCalendarChild();
  spawnChild = fn;
}

/**
 * The `osascript` child, and the request/reply protocol over its pipes.
 *
 * One per process, ref-counted: several hooks in one app share a store the
 * way they share a bus connection. A reply is matched by id; a line with no
 * id is a push (the store changed).
 */
class CalendarChild {
  constructor(proc) {
    this.proc = proc;
    this.seq = 0;
    this.refs = 0;
    this.pending = new Map();
    this.watchers = new Set();
    this.exited = null;
    this._buffered = '';
    this._hello = null;

    // The program's first line is `{ ready: true, status }`, so "it started"
    // and "the framework answered" are the same event: a child that spawns
    // and then fails inside osascript never says hello, and this rung stands
    // down rather than hanging on a pipe.
    this.ready = new Promise((resolve, reject) => {
      this._hello = { resolve, reject };
    });
    // Nothing may await this before `acquireChild` does; an unhandled
    // rejection here would be reported against a promise nobody asked for.
    this.ready.catch(() => {});

    proc.stdout?.setEncoding?.('utf8');
    proc.stdout?.on('data', (chunk) => this._onData(chunk));
    proc.on('error', (err) => this._die(err));
    proc.on('exit', () => this._die(new Error('the calendar helper exited')));
  }

  _onData(chunk) {
    this._buffered += chunk;
    let at;
    while ((at = this._buffered.indexOf('\n')) !== -1) {
      const line = this._buffered.slice(0, at).trim();
      this._buffered = this._buffered.slice(at + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // noise from a framework that logs into every process
      }
      if (msg.ready) {
        this._hello.resolve(msg);
        continue;
      }
      if (msg.event === 'changed') {
        for (const fn of [...this.watchers]) {
          try {
            fn();
          } catch {
            /* one watcher's failure is not another's */
          }
        }
        continue;
      }
      const entry = this.pending.get(msg.id);
      if (!entry) continue;
      this.pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error));
      else entry.resolve(msg.ok);
    }
  }

  _die(err) {
    if (this.exited) return;
    this.exited = err;
    this._hello.reject(err);
    for (const entry of this.pending.values()) entry.reject(err);
    this.pending.clear();
    this.watchers.clear();
    if (shared === this) shared = null;
    // A child that never said hello is still running; a child that exited
    // does not mind being killed again.
    this.proc.kill?.();
  }

  send(message) {
    if (this.exited) return Promise.reject(this.exited);
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.proc.stdin.write(`${JSON.stringify({ ...message, id })}\n`);
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  release() {
    if (--this.refs > 0) return;
    if (shared === this) shared = null;
    try {
      this.proc.stdin?.end();
    } catch {
      /* already gone */
    }
    this.proc.kill?.();
  }
}

let shared = null;

/** The shared child, started if it is not running. Rejects if it will not
 *  start or does not say hello, which is this Mac saying it cannot answer. */
async function acquireChild() {
  if (shared && !shared.exited) {
    shared.refs++;
    return shared;
  }
  let proc;
  if (spawnChild) {
    proc = await spawnChild();
  } else {
    const { spawn } = await import('node:child_process');
    // stderr is ignored on purpose: AppKit logs into every process that
    // touches it, and none of it is an answer to anything asked here.
    proc = spawn(
      'osascript',
      ['-l', 'JavaScript', '-e', MACOS_CALENDAR_PROGRAM],
      { stdio: ['pipe', 'pipe', 'ignore'] },
    );
  }
  // Deliberately **not** `unref`'d, unlike the appearance watcher: this one
  // is asked questions and answers them, so a process that let the loop
  // drain while a read was in flight would exit in the middle of it. It is
  // an open resource, like the bus connection — `close()` ends it, and the
  // exit handler below is the backstop for an app that forgot to.
  const child = new CalendarChild(proc);
  const timer = setTimeout(() => {
    child._die(new Error('the calendar helper did not start'));
  }, CHILD_READY_TIMEOUT_MS);
  timer.unref?.();
  try {
    await child.ready;
  } finally {
    clearTimeout(timer);
  }

  child.refs = 1;
  shared = child;
  return child;
}

/** Kill the shared child, if any. Called on exit, and by the tests. */
export function _closeCalendarChild() {
  const child = shared;
  shared = null;
  if (!child) return;
  child.refs = 0;
  try {
    child.proc.stdin?.end();
  } catch {
    /* already gone */
  }
  child.proc.kill?.();
}

process.on('exit', () => {
  _closeCalendarChild();
});

/** EventKit over the child: the same answers as the bridge, a slower way. */
export class OsascriptCalendars {
  constructor(child) {
    this.backend = 'osascript';
    this._child = child;
  }

  access() {
    return this._child.send({ op: 'status' });
  }

  requestAccess() {
    return this._child.send({ op: 'request' });
  }

  async listCalendars() {
    const list = await this._child.send({ op: 'calendars' });
    return (list ?? []).map((cal) => ({
      uid: String(cal.id),
      name: cal.title ?? '',
      enabled: true,
      color: hexFromComponents(cal.color),
      backend: calendarBackendName(cal.type),
      readOnly: cal.allowsModifications === false || cal.immutable === true,
      account: cal.source?.title ?? undefined,
    }));
  }

  async eventsBetween(from, to, options = {}) {
    const metas = options.calendars ?? (await this.listCalendars());
    // The same rule as the bridge rung: a filter that matched nothing means
    // nothing, not everything.
    if (options.calendars && metas.length === 0) {
      return { events: [], errors: [] };
    }
    const byId = new Map(metas.map((meta) => [meta.uid, meta]));
    const ids = options.calendars ? metas.map((meta) => meta.uid) : undefined;

    const events = [];
    const seen = new Set();
    for (const [start, end] of chunkSpan(from, to)) {
      const raw = await this._child.send({
        op: 'events',
        start,
        end,
        calendars: ids,
      });
      for (const one of raw ?? []) {
        const key = `${one.id} ${one.start}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const at = new Date(one.start);
        const meta = byId.get(String(one.calendar));
        events.push({
          uid: String(one.id ?? `${one.calendar}:${one.start}`),
          summary: one.title ?? '',
          location: one.location ?? undefined,
          description: one.notes ?? undefined,
          start: at,
          end: withExclusiveEnd(new Date(one.end), Boolean(one.allDay)),
          allDay: Boolean(one.allDay),
          recurring: Boolean(one.recurring),
          calendar: meta
            ? { uid: meta.uid, name: meta.name, color: meta.color }
            : { uid: String(one.calendar ?? ''), name: '' },
        });
      }
    }
    return { events: sortEvents(events), errors: [] };
  }

  /** The store's own notification, which names nothing: see
   *  `CocoaCalendars.watch` for why a change carries no calendar. */
  async watch(from, to, onChange) {
    await this._child.send({ op: 'watch' });
    const fn = () => onChange({ calendar: null, kind: 'changed', count: null });
    this._child.watchers.add(fn);
    return async () => {
      this._child.watchers.delete(fn);
    };
  }

  /** Nothing: the child is shared and ref-counted, and the handle's own
   *  `close()` is what releases this share of it. Releasing here too would
   *  count one handle twice and kill a child another is still using. */
  async close() {}
}

// --------------------------------------------------------------------------
// Choosing a rung
// --------------------------------------------------------------------------

/**
 * The app whose EventKit bridge to read, or null.
 *
 * Never a backend check: an app that can read calendars says so by carrying
 * `calendars` (src/cocoa/app.js), and this asks the connections the renderer
 * is drawing through — the rule `permissions` and `filePanels` follow.
 */
function calendarsApp(app) {
  if (app) return app.calendars ? app : null;
  const apps = liveApps().filter((one) => one.calendars);
  if (apps.length <= 1) return apps[0] ?? null;
  const showing = apps.filter((one) => (one._rootChildren ?? []).length > 0);
  return showing.length === 1 ? showing[0] : null;
}

/** `osascript` on this machine's PATH, without running it. */
async function haveOsascript() {
  if (spawnChild) return true;
  if (process.platform !== 'darwin') return false;
  const { access } = await import('node:fs/promises');
  const dirs = (process.env.PATH ?? '/usr/bin:/bin').split(':');
  for (const dir of dirs) {
    if (!dir) continue;
    try {
      await access(`${dir}/osascript`);
      return true;
    } catch {
      /* not in this one */
    }
  }
  return false;
}

/**
 * Which rung this machine lands on, without reading anything.
 *
 * ```js
 * switch (await calendarBackend()) {
 *   case null: return <NoCalendarHere />;
 * }
 * ```
 *
 * Useful for a settings screen that wants to say where the events come from,
 * and for the tests. It acquires a bus ref and releases it, so it is cheap
 * but not free — and it never spawns the `osascript` child or raises a
 * permission prompt.
 *
 * @returns {Promise<'cocoa'|'osascript'|'eds'|null>}
 */
export async function calendarBackend(options = {}) {
  if (calendarsApp(options.app)) return 'cocoa';
  if (await haveOsascript()) return 'osascript';
  const ref = await sessionBus();
  if (ref) {
    try {
      if (await hasService(SOURCES_NAME, ref)) return 'eds';
    } finally {
      await ref.release();
    }
  }
  return null;
}

/**
 * The desktop's calendars, on the best rung this machine has.
 *
 * ```js
 * const cal = await desktopCalendar();
 * if (!cal) return;                              // no calendars here
 * try {
 *   const { events } = await cal.eventsBetween(from, to);
 * } finally {
 *   await cal.close();
 * }
 * ```
 *
 * **Never rejects for anything about the machine** — `null` is the answer
 * where nothing can read a calendar, the way `permissionStatus()` answers
 * `'unknown'`. `{ required: true }` turns that into a
 * {@link NoCalendarServiceError} for a caller who would rather branch on a
 * `catch`, and `{ backend }` pins one rung and fails rather than falling
 * through it, which is what a test and a "why is it slow" investigation
 * both want.
 *
 * The handle owns something on every rung — a bus reference, a watcher, a
 * share of the `osascript` child — so `close()` it. `useDesktopCalendarEvents`
 * does that for you.
 *
 * @returns {Promise<DesktopCalendar | null>}
 */
export async function desktopCalendar(options = {}) {
  const { app, backend, required = false } = options;

  if (!backend || backend === 'cocoa') {
    const found = calendarsApp(app);
    if (found) return new DesktopCalendar(found.calendars, async () => {});
  }

  if (!backend || backend === 'osascript') {
    if (await haveOsascript()) {
      try {
        const child = await acquireChild();
        return new DesktopCalendar(new OsascriptCalendars(child), async () => {
          child.release();
        });
      } catch (err) {
        // osascript is there but would not run the program: a machine
        // answering "no", not a reason to crash the app.
        if (backend === 'osascript') {
          if (required) throw new NoCalendarServiceError(err);
          return null;
        }
      }
    }
  }

  if (!backend || backend === 'eds') {
    const ref = await sessionBus();
    if (ref) {
      let found = false;
      try {
        found = await hasService(SOURCES_NAME, ref);
      } catch {
        found = false;
      }
      if (found) {
        return new DesktopCalendar(new EdsCalendars(ref.bus), () =>
          ref.release(),
        );
      }
      await ref.release();
    }
  }

  if (required) throw new NoCalendarServiceError();
  return null;
}

// --------------------------------------------------------------------------
// The handle: one shape, and the grant asked for once
// --------------------------------------------------------------------------

/**
 * What `desktopCalendar()` hands back: one API over whichever rung answered.
 *
 * The rungs are mechanism — a bridge call, a JSON line, a D-Bus view — and
 * the policy is here, in one place, because it is the same policy on all of
 * them: **the first read asks for the grant** (the notification centre's
 * rule: the first post asks), a refusal is a typed rejection rather than an
 * empty list, and the handle's own watches are the ones `close()` stops.
 */
export class DesktopCalendar {
  constructor(rung, release) {
    this._rung = rung;
    this._release = release;
    this._stops = new Set();
    this._closed = false;
    this._asked = null;
  }

  /** `'cocoa'`, `'osascript'` or `'eds'` — which rung answered. */
  get backend() {
    return this._rung.backend;
  }

  /**
   * May this app read the calendars, as far as anything can say without
   * asking the user: the permission vocabulary, `'granted'` on a rung with
   * no such gate (EDS).
   */
  access() {
    return this._rung.access();
  }

  /** Raise the system's prompt where there is one; the status after the
   *  user answered. Reads do this for you on the first one. */
  requestAccess() {
    this._asked = null;
    return this._rung.requestAccess();
  }

  /** System Settings > Privacy & Security > Calendars, for a refusal the
   *  user can still change their mind about. `false` off macOS. */
  openSettings() {
    return openPrivacySettings('calendars');
  }

  async _ensureAccess() {
    if (this._closed) throw new Error('react-x11: this calendar is closed');
    if (!this._asked) {
      this._asked = (async () => {
        let status = await this._rung.access();
        // "Not decided yet" is the one state where reading means asking.
        if (status === 'prompt') status = await this._rung.requestAccess();
        return status;
      })().catch((err) => {
        this._asked = null;
        throw err;
      });
    }
    const status = await this._asked;
    // An undecided answer is not an answer: it means the request was made
    // and nothing came back — TCC declining to ask (see the JXA program's
    // `request`). Remembering it would keep a whole session behind a
    // decision the user may make in Settings a moment later.
    if (status === 'prompt') this._asked = null;
    if (status !== 'granted' && status !== 'unknown') {
      throw new CalendarAccessError(status);
    }
  }

  /** Every calendar the desktop knows about. */
  async listCalendars() {
    await this._ensureAccess();
    return this._rung.listCalendars();
  }

  /**
   * The occurrences between two `Date`s, expanded, sorted by start, each
   * tagged with the calendar it came from.
   *
   * `end` is **exclusive** on every rung. `errors` names the calendars that
   * would not answer — one unreachable CalDAV server is not a failure of
   * the month — and is empty on the macOS rungs, where there is one store.
   */
  async eventsBetween(from, to, options = {}) {
    await this._ensureAccess();
    return this._rung.eventsBetween(from, to, options);
  }

  /**
   * Call `onChange` when something in the store moves, and return the
   * function that stops watching.
   *
   * Deliberately thin: **re-query rather than patch**. EDS names what
   * changed and EventKit does not, and neither can say what a recurrence
   * master edited months away did to this range.
   */
  async watch(from, to, onChange, options = {}) {
    await this._ensureAccess();
    const stop = await this._rung.watch(from, to, onChange, options);
    const once = async () => {
      if (!this._stops.delete(once)) return;
      await stop();
    };
    this._stops.add(once);
    return once;
  }

  /** Stop this handle's watches and release what it holds. Idempotent. */
  async close() {
    if (this._closed) return;
    this._closed = true;
    for (const stop of [...this._stops]) await stop();
    this._stops.clear();
    await this._rung.close?.();
    await this._release();
  }
}

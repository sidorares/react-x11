// The user's calendars on the cocoa backend — EventKit (`EKEventStore`)
// through @windowkit/appkit (>= 0.8), the top rung of
// src/desktopcalendar.js's ladder. `CocoaApp.calendars` is this object and
// its *presence* is the capability, the rule `filePanels`, `permissions` and
// `notifications` follow, so the ladder never names a backend.
//
// EventKit is the macOS counterpart of Evolution Data Server plus GNOME
// Online Accounts in one framework: every account the user added in System
// Settings > Internet Accounts — iCloud, Google, Exchange, CalDAV, a
// subscribed feed — is served by one store, the desktop did the OAuth, and
// the app never sees a credential.
//
// Three things about the framework shape the code here:
//
// - **It expands recurrences itself.** `predicateForEventsWithStartDate…`
//   answers occurrences, so there is no `ical.js` on this rung and no
//   recurrence arithmetic to get wrong. The EDS rung pays for that
//   client-side; this one does not.
// - **The predicate spans at most four years** (the framework's own limit),
//   so a longer range is asked for in chunks and the pieces are merged —
//   `chunkSpan` in ../desktopcalendar.js, shared with the `osascript` rung
//   because it is the same framework underneath.
// - **An all-day event ends at the last second of its last day.** Every
//   other rung, and `byDay`, read `end` as exclusive, so it is normalised
//   here — at the edge, once, rather than in every consumer.
//
// A change to anything in the store arrives as one `calendar-store-changed`
// backend event that names nothing, so `watch` reports `kind: 'changed'`
// with a null calendar and no count. Re-query; do not try to patch.

import {
  calendarBackendName,
  chunkSpan,
  hexFromComponents,
  sortEvents,
  withExclusiveEnd,
} from '../desktopcalendar.js';

/** `EKCalendar` as the shape every rung answers with. */
export function calendarInfo(cal) {
  return {
    uid: String(cal.id),
    name: cal.title ?? '',
    // EventKit has no "unchecked in the sidebar" state to report — a
    // calendar hidden in Calendar.app is still in the store — so every
    // calendar here is enabled, which is what `enabled` means to a caller
    // filtering the list.
    enabled: true,
    color: hexFromComponents(cal.color),
    backend: calendarBackendName(cal.type),
    readOnly: cal.allowsModifications === false || cal.immutable === true,
    // The account the calendar came from, which is what the EDS rung's
    // `account` is too: an `EKSource` is the Internet Accounts entry.
    account: cal.source?.title ?? undefined,
  };
}

/** One occurrence from the bridge as the shape every rung answers with. */
export function desktopEvent(ev, byId) {
  const meta = byId.get(String(ev.calendar));
  const start = new Date(ev.start);
  return {
    uid: String(ev.id ?? ev.itemId ?? `${ev.calendar}:${ev.start}`),
    summary: ev.title ?? '',
    location: ev.location ?? undefined,
    description: ev.notes ?? undefined,
    start,
    end: withExclusiveEnd(new Date(ev.end), Boolean(ev.allDay)),
    allDay: Boolean(ev.allDay),
    recurring: Boolean(ev.recurring),
    calendar: meta
      ? { uid: meta.uid, name: meta.name, color: meta.color }
      : { uid: String(ev.calendar), name: '' },
  };
}

export class CocoaCalendars {
  constructor(app) {
    this.app = app;
    this._native = app._native;
    this.backend = 'cocoa';
    this._watchers = new Set();
  }

  /**
   * The TCC grant, read without prompting. `'write-only'` is macOS 14's
   * partial grant, which is a refusal to a reader — but its own word, so a
   * caller that only saves events can tell it from a denial.
   */
  async access() {
    return this.app.permissions
      ? this.app.permissions.status('calendars')
      : 'unknown';
  }

  /** The system prompt, once per app; the status after the user answered. */
  async requestAccess() {
    return this.app.permissions
      ? this.app.permissions.request('calendars')
      : 'unknown';
  }

  listCalendars() {
    return new Promise((resolve, reject) => {
      this._native.calendars((err, list) =>
        err ? reject(err) : resolve((list ?? []).map(calendarInfo)),
      );
    });
  }

  _events(range) {
    return new Promise((resolve, reject) => {
      this._native.eventsBetween(range, (err, events) =>
        err ? reject(err) : resolve(events ?? []),
      );
    });
  }

  /**
   * The occurrences in a range, already expanded by the framework.
   *
   * `errors` is always empty here: there is one store, and a failure in it
   * is a failure of the whole read rather than of one account. The EDS rung
   * is the one where a single unreachable CalDAV server must not blank the
   * month.
   */
  async eventsBetween(from, to, options = {}) {
    const metas = options.calendars ?? (await this.listCalendars());
    // "These calendars, of which there are none" is not "every calendar",
    // which is what an empty filter means to the predicate underneath. A
    // caller whose filter matched nothing must get nothing.
    if (options.calendars && metas.length === 0) {
      return { events: [], errors: [] };
    }
    const byId = new Map(metas.map((meta) => [meta.uid, meta]));
    const ids = options.calendars ? metas.map((meta) => meta.uid) : undefined;

    const events = [];
    const seen = new Set();
    for (const [start, end] of chunkSpan(from, to)) {
      const raw = await this._events({ start, end, calendars: ids });
      for (const one of raw) {
        // An occurrence that straddles a chunk boundary is reported by both
        // predicates; the caller must not see it twice.
        const key = `${one.id} ${one.start}`;
        if (seen.has(key)) continue;
        seen.add(key);
        events.push(desktopEvent(one, byId));
      }
    }
    return { events: sortEvents(events), errors: [] };
  }

  /**
   * `EKEventStoreChangedNotification`, as the ladder's change signal.
   *
   * The notification names neither the calendar nor what happened — a
   * detail EventKit does not have — so the change carries a null calendar
   * and no count, and re-querying is the only correct answer. Every watcher
   * hears every change, whatever range it asked for, because a change
   * outside a range can still move what is inside it (a recurrence master
   * edited months away).
   */
  async watch(from, to, onChange) {
    const entry = { onChange };
    this._watchers.add(entry);
    return async () => {
      this._watchers.delete(entry);
    };
  }

  /** `calendar-store-changed`, routed from the app's backend callback. */
  route() {
    for (const entry of [...this._watchers]) {
      try {
        entry.onChange({ calendar: null, kind: 'changed', count: null });
      } catch {
        // a watcher that throws is not the other watchers' problem
      }
    }
  }

  /** Nothing to release: the store belongs to the process, and a handle's
   *  own watchers are dropped by the stop function `watch` returned. */
  async close() {}
}

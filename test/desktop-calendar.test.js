// The desktop's calendars (src/desktopcalendar.js, docs/desktop-calendar.md):
// the shape every rung agrees on, the EDS rung over an in-process broker, the
// EventKit rung over a recording fake bridge, the `osascript` rung over a fake
// child speaking the same JSON lines, and the ladder that picks between them.
//
// Three things are deliberately not here, and none of them can be:
//
// - **The real EventKit.** The bridge's own tests own the framework; what is
//   tested here is the translation into one shape and the policy above it.
// - **The system's permission prompt.** A test that raised one would wait for
//   a human, and on a developer's own Mac it would record a TCC decision for
//   whatever process happened to be running the suite. Every test here either
//   pins a rung with a fake behind it or forces the platform, so nothing on
//   this machine is ever asked. See docs/desktop-calendar.md for the prompt
//   measured by hand.
// - **Service activation.** EDS is D-Bus-activatable; the broker is not.
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, test } from 'node:test';
import React from 'react';

import { CocoaApp } from '../src/cocoa/app.js';
import { calendarInfo, desktopEvent } from '../src/cocoa/calendar.js';
import {
  CalendarAccessError,
  MACOS_CALENDAR_PROGRAM,
  NoCalendarServiceError,
  _closeCalendarChild,
  _setCalendarSpawnForTests,
  byDay,
  calendarBackend,
  chunkSpan,
  dayKey,
  desktopCalendar,
  hexFromComponents,
  parseKeyFile,
  withExclusiveEnd,
} from '../src/desktopcalendar.js';
import { useDesktopCalendarEvents } from '../src/desktopcalendarhooks.js';
import { createRoot } from '../src/index.js';
import { PERMISSION_KINDS, privacySettingsUrl } from '../src/permissions.js';
import { setCompositingForTests } from '../src/compositing.js';
import { setScaleForTests } from '../src/scale.js';
import { setScreensForTests } from '../src/screens.js';
import { fakeEds, NOTIFY_INITIAL } from './helpers/fake-eds.js';
import { transportAvailable, withBus } from './helpers/with-bus.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setTimeout(resolve, 2));

const haveTransport = await transportAvailable();
const needsBroker = haveTransport
  ? {}
  : { skip: 'dbus-native is not installed (expected on Node < 22.12)' };

/** Poll until `check` answers, flushing timers and microtasks between tries.
 *  Every rung here settles across ticks — a bus round trip, a pipe, a
 *  promise chain — so a single `await` would be reading the first frame. */
async function until(check, message, timeout = 5000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${message}`);
    }
    await tick();
  }
}

/** Run `fn` on a machine that is not a Mac, so the ladder cannot reach the
 *  `osascript` rung — which on the machine writing this would spawn a real
 *  child and ask the user for their calendar. */
async function asLinux(fn) {
  const saved = process.platform;
  Object.defineProperty(process, 'platform', { value: 'linux' });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'platform', { value: saved });
  }
}

// ---------------------------------------------------------------------------
// The shape every rung agrees on
// ---------------------------------------------------------------------------

/** A minimal event, built in *local* time so the assertions below do not
 *  depend on the machine's timezone. */
function event(uid, start, end, allDay = false) {
  return {
    uid,
    summary: uid,
    start,
    end,
    allDay,
    recurring: false,
    calendar: { uid: 'cal', name: 'Cal' },
  };
}

describe('one shape, whichever rung answered', () => {
  test('a source keyfile parses into sections', () => {
    const cfg = parseKeyFile(
      [
        '[Data Source]',
        'DisplayName=Work',
        'DisplayName[ru]=Работа',
        'Enabled=true',
        '',
        '# a comment',
        '[Calendar]',
        'BackendName=caldav',
        'Color=#3584e4',
      ].join('\n'),
    );
    assert.equal(cfg['Data Source'].DisplayName, 'Work');
    assert.equal(cfg.Calendar.Color, '#3584e4');
    assert.equal(cfg.Calendar.BackendName, 'caldav');
    // a translated key is not the key
    assert.equal(cfg['Data Source']['DisplayName[ru]'], undefined);
  });

  test('an event lands on the day it happens', () => {
    const days = byDay([
      event('standup', new Date(2026, 7, 7, 9, 0), new Date(2026, 7, 7, 9, 15)),
    ]);
    assert.deepEqual([...days.keys()], ['2026-08-07']);
    assert.equal(days.get('2026-08-07').length, 1);
    assert.equal(dayKey(new Date(2026, 7, 7, 23, 59)), '2026-08-07');
  });

  test('a multi-day event lands on every day it touches', () => {
    // an all-day span is [start, end): the 10th, 11th and 12th, not the 13th
    const days = byDay([
      event('conf', new Date(2026, 7, 10), new Date(2026, 7, 13), true),
    ]);
    assert.deepEqual(
      [...days.keys()].sort(),
      ['2026-08-10', '2026-08-11', '2026-08-12'],
      'the exclusive end does not mark a fourth day',
    );
  });

  test('an event crossing midnight lands on both days', () => {
    const days = byDay([
      event('party', new Date(2026, 7, 7, 22, 0), new Date(2026, 7, 8, 2, 0)),
    ]);
    assert.deepEqual([...days.keys()].sort(), ['2026-08-07', '2026-08-08']);
  });

  test("EventKit's last-second end becomes the exclusive one", () => {
    // what the store reports for a one-day all-day event on the 10th
    const reported = new Date(2026, 7, 10, 23, 59, 59);
    const end = withExclusiveEnd(reported, true);
    assert.equal(end.getTime(), new Date(2026, 7, 11).getTime());
    // and one that is already exclusive must not gain a day
    const midnight = new Date(2026, 7, 11);
    assert.equal(
      withExclusiveEnd(midnight, true).getTime(),
      midnight.getTime(),
    );
    // a timed event is never touched, whatever the clock says
    assert.equal(withExclusiveEnd(reported, false), reported);

    const days = byDay([event('holiday', new Date(2026, 7, 10), end, true)]);
    assert.deepEqual([...days.keys()], ['2026-08-10'], 'one day, not two');
  });

  test('a span longer than EventKit allows is asked for in pieces', () => {
    const from = new Date(2020, 0, 1);
    const to = new Date(2030, 0, 1);
    const chunks = chunkSpan(from, to);
    assert.ok(chunks.length > 2, 'a decade is more than one predicate');
    assert.equal(chunks[0][0], from.getTime());
    assert.equal(chunks.at(-1)[1], to.getTime());
    for (const [start, end] of chunks) {
      assert.ok(
        end - start <= 1400 * 24 * 60 * 60 * 1000,
        'each piece is inside the four-year limit',
      );
    }
    // and the pieces join up, so nothing between them is lost
    for (let i = 1; i < chunks.length; i++) {
      assert.equal(chunks[i][0], chunks[i - 1][1]);
    }
    // a month is one query
    assert.equal(
      chunkSpan(new Date(2026, 7, 1), new Date(2026, 8, 1)).length,
      1,
    );
  });

  test("EventKit's colour components become the EDS rung's hex", () => {
    assert.equal(hexFromComponents([0.2078, 0.5176, 0.894, 1]), '#3584e4');
    assert.equal(hexFromComponents(null), undefined);
    assert.equal(hexFromComponents([1, 1]), undefined);
  });

  test('a calendar and an event from the bridge take the common shape', () => {
    const info = calendarInfo({
      id: 'ABC',
      title: 'Work',
      color: [0.878, 0.105, 0.141, 1],
      type: 'calDAV',
      source: { id: 'S1', title: 'Google' },
      allowsModifications: false,
      immutable: false,
      subscribed: false,
    });
    assert.deepEqual(info, {
      uid: 'ABC',
      name: 'Work',
      enabled: true,
      color: '#e01b24',
      backend: 'caldav',
      readOnly: true,
      account: 'Google',
    });

    const one = desktopEvent(
      {
        id: 'E1',
        calendar: 'ABC',
        title: 'Standup',
        location: 'Kitchen',
        notes: null,
        start: new Date(2026, 7, 7, 9).getTime(),
        end: new Date(2026, 7, 7, 9, 15).getTime(),
        allDay: false,
        recurring: true,
      },
      new Map([[info.uid, info]]),
    );
    assert.equal(one.summary, 'Standup');
    assert.equal(one.location, 'Kitchen');
    assert.equal(one.description, undefined, 'no notes is absent, not ""');
    assert.equal(one.recurring, true);
    assert.equal(one.calendar.color, '#e01b24');
  });
});

// ---------------------------------------------------------------------------
// The permission vocabulary the calendar needs
// ---------------------------------------------------------------------------

describe('the two new permission kinds', () => {
  test('calendars and reminders are kinds, with panes of their own', () => {
    assert.ok(PERMISSION_KINDS.includes('calendars'));
    assert.ok(PERMISSION_KINDS.includes('reminders'));
    assert.match(privacySettingsUrl('calendars'), /Privacy_Calendars$/);
    assert.match(privacySettingsUrl('reminders'), /Privacy_Reminders$/);
  });
});

// ---------------------------------------------------------------------------
// Rung 1: EventKit through the bridge
// ---------------------------------------------------------------------------

const CAL_PERSONAL = {
  id: 'personal',
  title: 'Personal',
  color: [0.2078, 0.5176, 0.894, 1],
  type: 'local',
  source: { id: 'local', title: 'On My Mac' },
  allowsModifications: true,
  immutable: false,
  subscribed: false,
};
const CAL_WORK = {
  id: 'work',
  title: 'Work',
  color: [0.878, 0.105, 0.141, 1],
  type: 'calDAV',
  source: { id: 'goog', title: 'Google' },
  allowsModifications: false,
  immutable: false,
  subscribed: false,
};

/** A bridge that records what it was asked, with EventKit's verbs on it.
 *  `calendars: false` is a bridge older than 0.8 — the capability is absent
 *  and the ladder must step past it rather than fail. */
function fakeNative({
  status = 'authorized',
  answer = null,
  calendars = [CAL_PERSONAL, CAL_WORK],
  events = [],
  hasCalendars = true,
} = {}) {
  let seq = 0;
  const base = {
    calls: [],
    backendEvents: null,
    of: (name) =>
      base.calls.filter((c) => c[0] === name).map((c) => c.slice(1)),
    authorizationStatus(kind, opts) {
      base.calls.push(['authorizationStatus', kind, opts]);
      return status;
    },
    requestAuthorization(kind, ...rest) {
      const cb = rest.pop();
      base.calls.push(['requestAuthorization', kind, rest[0]]);
      const settled = answer ?? status;
      setImmediate(() => cb(settled === 'authorized', settled));
    },
    openPrivacySettings(kind) {
      base.calls.push(['openPrivacySettings', kind]);
    },
    calendars(cb) {
      base.calls.push(['calendars']);
      setImmediate(() => cb(null, calendars));
    },
    eventsBetween(range, cb) {
      base.calls.push(['eventsBetween', range]);
      setImmediate(() =>
        cb(null, typeof events === 'function' ? events(range) : events),
      );
    },
    setBackendEventCallback(fn) {
      base.backendEvents = fn;
    },
    initApp() {},
    listScreens: () => [
      { x: 0, y: 0, width: 1440, height: 900, scale: 2, fps: 60 },
    ],
    createWindow2: (o) => ({ id: ++seq, options: { ...o } }),
    windowNumber: (handle) => handle.id,
    windowRootLayer: (handle) => ({ root: handle.id }),
    getWindowFrame: (handle) => ({
      x: 0,
      y: 0,
      width: handle.options.width,
      height: handle.options.height,
    }),
    windowIsVisible: () => true,
    createSurfaceIOSurface: (width, height, scale) => ({
      handle: { id: ++seq, width, height, scale },
      iosurfaceId: seq,
    }),
    createSurface: (width, height, scale) => ({
      id: ++seq,
      width,
      height,
      scale,
    }),
    surfaceSize: (handle) => ({
      width: handle.width,
      height: handle.height,
      scale: handle.scale,
    }),
  };
  return new Proxy(base, {
    get: (target, key) => {
      // An older bridge has neither verb, and `typeof … === 'function'` on
      // the app is the whole capability test.
      if (!hasCalendars && (key === 'calendars' || key === 'eventsBetween')) {
        return undefined;
      }
      return key in target ? target[key] : () => undefined;
    },
  });
}

function appOver(native) {
  const app = new CocoaApp(native);
  setScaleForTests(app, 2, 'cocoa');
  setScreensForTests(app, {
    monitors: [{ x: 0, y: 0, width: 2880, height: 1800 }],
    workArea: { x: 0, y: 0, width: 2880, height: 1750 },
  });
  setCompositingForTests(app, true);
  return app;
}

const AUGUST = [new Date(2026, 7, 1), new Date(2026, 8, 1)];

/** One occurrence as the bridge reports it: epoch ms, all-day ending at the
 *  last second of its last day. */
function bridgeEvent(over = {}) {
  return {
    id: 'E1',
    calendar: 'personal',
    title: 'Standup',
    location: null,
    notes: null,
    start: new Date(2026, 7, 7, 9).getTime(),
    end: new Date(2026, 7, 7, 9, 15).getTime(),
    allDay: false,
    recurring: false,
    ...over,
  };
}

const handles = [];
const roots = [];
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
  for (const root of roots.splice(0)) await root.unmount();
  _setCalendarSpawnForTests(null);
  _closeCalendarChild();
});

async function open(options) {
  const cal = await desktopCalendar(options);
  if (cal) handles.push(cal);
  return cal;
}

describe('the cocoa rung', () => {
  test('the app carrying the bridge is the rung, and it is found by that', async () => {
    const app = appOver(fakeNative());
    assert.equal(await calendarBackend({ app }), 'cocoa');
    const cal = await open({ app });
    assert.equal(cal.backend, 'cocoa');

    const older = appOver(fakeNative({ hasCalendars: false }));
    assert.equal(older.calendars, null, 'a bridge before 0.8 has no rung');
  });

  test('calendars and events come back in the common shape', async () => {
    const native = fakeNative({ events: [bridgeEvent()] });
    const app = appOver(native);
    const cal = await open({ app });

    const list = await cal.listCalendars();
    assert.deepEqual(
      list.map((c) => [c.uid, c.name, c.color, c.readOnly]),
      [
        ['personal', 'Personal', '#3584e4', false],
        ['work', 'Work', '#e01b24', true],
      ],
    );

    const { events, errors } = await cal.eventsBetween(AUGUST[0], AUGUST[1]);
    assert.deepEqual(errors, [], 'one store: a failure is the whole read');
    assert.equal(events.length, 1);
    assert.equal(events[0].summary, 'Standup');
    assert.equal(events[0].calendar.name, 'Personal');
    assert.equal(events[0].calendar.color, '#3584e4');

    // the range crossed as epoch ms, and every calendar meant no filter
    const [range] = native.of('eventsBetween').at(-1);
    assert.equal(range.start, AUGUST[0].getTime());
    assert.equal(range.end, AUGUST[1].getTime());
    assert.equal(range.calendars, undefined);
  });

  test('an all-day event ends where every other rung ends it', async () => {
    const native = fakeNative({
      events: [
        bridgeEvent({
          id: 'holiday',
          allDay: true,
          start: new Date(2026, 7, 10).getTime(),
          end: new Date(2026, 7, 12, 23, 59, 59).getTime(),
        }),
      ],
    });
    const cal = await open({ app: appOver(native) });
    const { events } = await cal.eventsBetween(AUGUST[0], AUGUST[1]);
    assert.equal(
      events[0].end.getTime(),
      new Date(2026, 7, 13).getTime(),
      'exclusive, so byDay marks the 10th to the 12th',
    );
    assert.deepEqual(
      [...byDay(events).keys()],
      ['2026-08-10', '2026-08-11', '2026-08-12'],
    );
  });

  test('a decade is chunked, and an occurrence on a seam is not doubled', async () => {
    const seam = chunkSpan(new Date(2020, 0, 1), new Date(2030, 0, 1));
    const onSeam = seam[1][0];
    const native = fakeNative({
      // every chunk answers with the event that sits on the first seam
      events: () => [bridgeEvent({ id: 'seam', start: onSeam, end: onSeam })],
    });
    const cal = await open({ app: appOver(native) });
    const { events } = await cal.eventsBetween(
      new Date(2020, 0, 1),
      new Date(2030, 0, 1),
    );
    assert.equal(native.of('eventsBetween').length, seam.length);
    assert.equal(events.length, 1, 'the same occurrence, reported once');
  });

  test('a filter names the calendars it wants, and nothing else', async () => {
    const native = fakeNative({ events: [] });
    const cal = await open({ app: appOver(native) });
    const list = await cal.listCalendars();
    await cal.eventsBetween(AUGUST[0], AUGUST[1], {
      calendars: list.filter((c) => c.uid === 'work'),
    });
    const [range] = native.of('eventsBetween').at(-1);
    assert.deepEqual(range.calendars, ['work']);
  });

  test('a filter that matched nothing means nothing, not everything', async () => {
    // an empty calendar list is what a nil predicate means to EventKit —
    // every calendar — so the rung must not send one
    const native = fakeNative({ events: [bridgeEvent()] });
    const cal = await open({ app: appOver(native) });
    const { events } = await cal.eventsBetween(AUGUST[0], AUGUST[1], {
      calendars: [],
    });
    assert.deepEqual(events, []);
    assert.equal(native.of('eventsBetween').length, 0, 'and asked nothing');
  });

  test('the store’s notification is a change with nothing named', async () => {
    const native = fakeNative();
    const app = appOver(native);
    const cal = await open({ app });
    const seen = [];
    const stop = await cal.watch(AUGUST[0], AUGUST[1], (c) => seen.push(c));

    // exactly what the bridge's own callback does with the event
    app._route({ type: 'calendar-store-changed' });
    assert.deepEqual(seen, [{ calendar: null, kind: 'changed', count: null }]);

    await stop();
    app._route({ type: 'calendar-store-changed' });
    assert.equal(seen.length, 1, 'stopped means stopped');
  });

  test('close() drops this handle’s watches and leaves the app’s alone', async () => {
    const native = fakeNative();
    const app = appOver(native);
    const first = await desktopCalendar({ app });
    const second = await desktopCalendar({ app });
    const seen = [];
    await first.watch(AUGUST[0], AUGUST[1], () => seen.push('first'));
    await second.watch(AUGUST[0], AUGUST[1], () => seen.push('second'));

    await first.close();
    app._route({ type: 'calendar-store-changed' });
    assert.deepEqual(seen, ['second']);
    await second.close();
  });
});

describe('the grant, on a rung that has one', () => {
  test('the first read asks, and only the first', async () => {
    const native = fakeNative({
      status: 'notDetermined',
      answer: 'authorized',
    });
    const cal = await open({ app: appOver(native) });

    assert.equal(await cal.access(), 'prompt', 'reading a status never asks');
    assert.equal(native.of('requestAuthorization').length, 0);

    await cal.listCalendars();
    await cal.eventsBetween(AUGUST[0], AUGUST[1]);
    assert.deepEqual(
      native.of('requestAuthorization'),
      [['calendars', undefined]],
      'two reads, one prompt',
    );
  });

  test('a refusal is a typed rejection, not an empty list', async () => {
    const native = fakeNative({ status: 'denied' });
    const cal = await open({ app: appOver(native) });
    assert.equal(await cal.access(), 'denied');
    await assert.rejects(
      () => cal.eventsBetween(AUGUST[0], AUGUST[1]),
      (err) => {
        assert.ok(err instanceof CalendarAccessError);
        assert.equal(err.status, 'denied');
        return true;
      },
    );
    assert.equal(native.of('calendars').length, 0, 'and nothing was read');
  });

  test("macOS 14's write-only grant is a refusal to a reader, by its own name", async () => {
    const native = fakeNative({ status: 'writeOnly' });
    const cal = await open({ app: appOver(native) });
    assert.equal(await cal.access(), 'write-only');
    await assert.rejects(
      () => cal.listCalendars(),
      (err) => err.status === 'write-only',
    );
  });
});

// ---------------------------------------------------------------------------
// Rung 2: EventKit through an `osascript` child
// ---------------------------------------------------------------------------

/**
 * A child that speaks the program's protocol without being it.
 *
 * The program itself cannot run off a Mac, and running it on one would ask
 * the user for their calendar — so what is pinned here is the protocol and
 * the plumbing around it: one child shared and ref-counted, a reply matched
 * by id, a push that is not a reply, and a death that fails what was in
 * flight. `MACOS_CALENDAR_PROGRAM` is asserted as source, and measured by
 * hand (docs/desktop-calendar.md).
 */
function fakeOsascript({
  status = 'granted',
  calendars = [],
  events = [],
  hello = true,
} = {}) {
  const child = new EventEmitter();
  const out = new PassThrough({ encoding: 'utf8' });
  child.stdout = out;
  child.asked = [];
  child.watching = false;
  child.alive = true;
  child.status = status;

  const emit = (obj) => out.write(`${JSON.stringify(obj)}\n`);
  child.change = () => emit({ event: 'changed' });

  let buffered = '';
  child.stdin = {
    write(chunk) {
      buffered += chunk;
      let at;
      while ((at = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, at);
        buffered = buffered.slice(at + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        child.asked.push(msg);
        // Answering on a later tick is not decoration: a rung that read its
        // own reply synchronously would be a different program.
        setImmediate(() => {
          if (!child.alive) return;
          switch (msg.op) {
            case 'status':
              return emit({ id: msg.id, ok: child.status });
            case 'request':
              child.status =
                child.status === 'prompt' ? 'granted' : child.status;
              return emit({ id: msg.id, ok: child.status });
            case 'calendars':
              return emit({ id: msg.id, ok: calendars });
            case 'events':
              return emit({
                id: msg.id,
                ok: typeof events === 'function' ? events(msg) : events,
              });
            case 'watch':
              child.watching = true;
              return emit({ id: msg.id, ok: true });
            default:
              return emit({ id: msg.id, error: `unknown op ${msg.op}` });
          }
        });
      }
      return true;
    },
    end() {
      child.kill();
    },
  };
  child.kill = () => {
    if (!child.alive) return;
    child.alive = false;
    child.emit('exit', 0, null);
  };
  child.unref = () => {};
  if (hello) {
    setImmediate(() => emit({ ready: true, status: child.status }));
  }
  return child;
}

describe('the osascript rung', () => {
  test('the program is a JXA program that answers lines', () => {
    // Pinned as source because it cannot be executed here: it is the rung's
    // whole implementation, and a silent edit to it is a silent regression.
    assert.match(MACOS_CALENDAR_PROGRAM, /ObjC\.import\('EventKit'\)/);
    assert.match(MACOS_CALENDAR_PROGRAM, /EKEventStoreChangedNotification/);
    assert.match(
      MACOS_CALENDAR_PROGRAM,
      /requestFullAccessToEventsWithCompletion/,
      'macOS 14+ asks with the new selector',
    );
    assert.match(
      MACOS_CALENDAR_PROGRAM,
      /requestAccessToEntityTypeCompletion/,
      'and the old one is still there for macOS 13',
    );
    assert.match(
      MACOS_CALENDAR_PROGRAM,
      /getppid/,
      'and it leaves when its parent has',
    );
  });

  test('one child answers, in the common shape', async () => {
    let child = null;
    _setCalendarSpawnForTests(() => {
      child = fakeOsascript({
        calendars: [
          {
            id: 'personal',
            title: 'Personal',
            color: [0.2078, 0.5176, 0.894, 1],
            type: 'local',
            source: { title: 'On My Mac' },
            allowsModifications: true,
          },
        ],
        events: [
          {
            id: 'E1',
            calendar: 'personal',
            title: 'Standup',
            location: 'Kitchen',
            notes: null,
            start: new Date(2026, 7, 7, 9).getTime(),
            end: new Date(2026, 7, 7, 9, 15).getTime(),
            allDay: false,
            recurring: false,
          },
        ],
      });
      return child;
    });

    assert.equal(await calendarBackend(), 'osascript');
    const cal = await open({});
    assert.equal(cal.backend, 'osascript');

    const list = await cal.listCalendars();
    assert.deepEqual(
      list.map((c) => [c.uid, c.name, c.color]),
      [['personal', 'Personal', '#3584e4']],
    );
    const { events } = await cal.eventsBetween(AUGUST[0], AUGUST[1]);
    assert.equal(events[0].summary, 'Standup');
    assert.equal(events[0].location, 'Kitchen');
    assert.equal(events[0].calendar.name, 'Personal');

    // epoch ms on the wire, and the range as asked
    const asked = child.asked.find((m) => m.op === 'events');
    assert.equal(asked.start, AUGUST[0].getTime());
    assert.equal(asked.end, AUGUST[1].getTime());
  });

  test('two handles share one child, and the last one out closes it', async () => {
    const spawned = [];
    _setCalendarSpawnForTests(() => {
      const child = fakeOsascript();
      spawned.push(child);
      return child;
    });

    const first = await desktopCalendar({});
    const second = await desktopCalendar({});
    assert.equal(spawned.length, 1, 'one process, however many handles');

    await first.close();
    assert.equal(spawned[0].alive, true, 'the other handle is still using it');
    await second.close();
    assert.equal(spawned[0].alive, false);

    // and the next handle starts a new one rather than talking to a corpse
    const third = await desktopCalendar({});
    assert.equal(spawned.length, 2);
    await third.close();
  });

  test('the change push is not a reply, and stops when the watch does', async () => {
    let child = null;
    _setCalendarSpawnForTests(() => (child = fakeOsascript()));
    const cal = await open({});
    const seen = [];
    const stop = await cal.watch(AUGUST[0], AUGUST[1], (c) => seen.push(c));
    assert.equal(child.watching, true, 'the observer was armed once');

    child.change();
    await tick();
    assert.deepEqual(seen, [{ calendar: null, kind: 'changed', count: null }]);

    await stop();
    child.change();
    await tick();
    assert.equal(seen.length, 1);
  });

  test('a child that dies fails what was in flight rather than hanging', async () => {
    let child = null;
    _setCalendarSpawnForTests(() => (child = fakeOsascript()));
    const cal = await open({});
    const pending = cal.listCalendars();
    child.kill();
    await assert.rejects(() => pending, /exited/);
  });

  test('a child that never says hello is this Mac saying no', async () => {
    _setCalendarSpawnForTests(() => {
      const child = fakeOsascript({ hello: false });
      // osascript itself failing: it starts and leaves without a word
      setImmediate(() => child.kill());
      return child;
    });
    assert.equal(await desktopCalendar({}), null);
    await assert.rejects(
      () => desktopCalendar({ required: true }),
      NoCalendarServiceError,
    );
  });
});

// ---------------------------------------------------------------------------
// Rung 3: Evolution Data Server, over an in-process broker
// ---------------------------------------------------------------------------

const ICS_ONE = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:standup',
  'SUMMARY:Standup',
  'LOCATION:Kitchen',
  'DTSTART:20260807T090000Z',
  'DTEND:20260807T091500Z',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

const ICS_WEEKLY = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:sync',
  'SUMMARY:Weekly sync',
  'DTSTART:20260803T100000Z',
  'DTEND:20260803T110000Z',
  'RRULE:FREQ=WEEKLY;COUNT=4',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

const UTC_AUGUST = [
  new Date(Date.UTC(2026, 7, 1)),
  new Date(Date.UTC(2026, 8, 1)),
];

/** A broker, a fake EDS on it, and a handle pinned to that rung. */
async function withEds(options, fn) {
  await withBus(async (address) => {
    const eds = await fakeEds(address, options);
    await asLinux(async () => {
      const cal = await desktopCalendar({ backend: 'eds' });
      try {
        await fn(cal, eds);
      } finally {
        await cal?.close();
      }
    });
    eds.stop();
  });
}

describe('the EDS rung', { ...needsBroker, concurrency: 1 }, () => {
  test('it is found on the bus, and lists what is a calendar', async () => {
    await withEds({}, async (cal) => {
      assert.equal(cal.backend, 'eds');
      const list = await cal.listCalendars();
      assert.deepEqual(
        list.map((c) => c.name).sort(),
        ['Personal', 'Work'],
        'the address book is not a calendar',
      );
      const work = list.find((c) => c.uid === 'work');
      assert.equal(work.color, '#e01b24');
      assert.equal(work.backend, 'caldav');
      assert.equal(work.readOnly, true, 'no Writable interface');
      assert.equal(list.find((c) => c.uid === 'personal').readOnly, false);
    });
  });

  test('it reads events through the bus name the factory gave it', async () => {
    await withEds({ objects: { personal: [ICS_ONE] } }, async (cal, eds) => {
      const { events, errors } = await cal.eventsBetween(...UTC_AUGUST);
      assert.deepEqual(errors, []);
      assert.equal(events.length, 1);
      assert.equal(events[0].summary, 'Standup');
      assert.equal(events[0].location, 'Kitchen');
      assert.equal(events[0].calendar.color, '#3584e4');
      // the calendar was opened before it was queried, as EDS requires
      const members = eds.calls.map((c) => c[0]);
      assert.ok(members.indexOf('Open') < members.indexOf('GetObjectList'));
    });
  });

  test('a recurring event is expanded client-side by ical.js', async () => {
    await withEds({ objects: { personal: [ICS_WEEKLY] } }, async (cal) => {
      const { events } = await cal.eventsBetween(...UTC_AUGUST);
      // COUNT=4 from 3 August, weekly: the 3rd, 10th, 17th and 24th
      assert.equal(events.length, 4, 'the RRULE was expanded');
      assert.ok(events.every((e) => e.recurring));
      assert.deepEqual(
        events.map((e) => e.start.toISOString().slice(0, 10)),
        ['2026-08-03', '2026-08-10', '2026-08-17', '2026-08-24'],
      );

      const narrow = await cal.eventsBetween(
        new Date(Date.UTC(2026, 7, 9)),
        new Date(Date.UTC(2026, 7, 18)),
      );
      assert.deepEqual(
        narrow.events.map((e) => e.start.toISOString().slice(0, 10)),
        ['2026-08-10', '2026-08-17'],
        'occurrences outside the window are not returned',
      );
    });
  });

  test('one broken backend does not sink the others', async () => {
    // the failure this is written against: an offline CalDAV server blanking
    // a whole month of the user's own local calendar
    await withEds(
      { objects: { personal: [ICS_ONE] }, broken: ['work'] },
      async (cal) => {
        const { events, errors } = await cal.eventsBetween(...UTC_AUGUST);
        assert.equal(events.length, 1, 'the working calendar still loaded');
        assert.equal(errors.length, 1);
        assert.equal(errors[0].calendar.uid, 'work');
        assert.match(errors[0].message, /cannot open work/);
      },
    );
  });

  test('watch does not report the contents the range already had', async () => {
    await withEds(
      { objects: { personal: [ICS_ONE], work: [ICS_WEEKLY] } },
      async (cal, eds) => {
        const changes = [];
        await cal.watch(...UTC_AUGUST, (c) => changes.push(c));

        // The replay, if there were one, is already on the wire; a change
        // made after it is what proves the watch is live at all.
        eds.views.get('personal').emit('ObjectsModified', [ICS_ONE]);
        await until(() => changes.length > 0, 'a change to arrive');

        assert.equal(changes.length, 1, 'Start() replayed nothing at us');
        assert.equal(changes[0].kind, 'ObjectsModified');
        assert.equal(changes[0].count, 1);
        assert.equal(changes[0].calendar.uid, 'personal');
        // and this is why: the views were told to notify changes only
        assert.equal(eds.views.get('personal').flags, 0);
        assert.equal(eds.views.get('work').flags, 0);
      },
    );
  });

  test('a backend that refuses the flags still replays into silence', async () => {
    await withEds(
      { objects: { personal: [ICS_ONE] }, refusesFlags: ['personal'] },
      async (cal, eds) => {
        const changes = [];
        await cal.watch(...UTC_AUGUST, (c) => changes.push(c));
        const view = eds.views.get('personal');
        assert.equal(view.flags, NOTIFY_INITIAL, 'it replayed');

        // `Complete` closed the delivery, so this one gets through — and its
        // arrival is what says the replay before it did not.
        view.emit('ObjectsAdded', [ICS_ONE]);
        await until(() => changes.length > 0, 'a change after the replay');
        assert.equal(changes.length, 1);
        assert.equal(changes[0].kind, 'ObjectsAdded');
      },
    );
  });

  test('the stop function stops and disposes the views it started', async () => {
    // what the hook's subscription effect runs on cleanup — a month the user
    // paged away from must not leave a live view behind
    await withEds({ objects: { personal: [ICS_ONE] } }, async (cal, eds) => {
      const stop = await cal.watch(...UTC_AUGUST, () => {});
      await stop();
      assert.ok(eds.views.get('personal').stopped, 'the view was stopped');
      assert.ok(eds.views.get('personal').disposed, 'and disposed');
    });
  });

  test('there is no grant to ask for, so nothing is asked', async () => {
    await withEds({}, async (cal) => {
      assert.equal(await cal.access(), 'granted');
      assert.equal(await cal.requestAccess(), 'granted');
    });
  });
});

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------

describe('the ladder', () => {
  test('the bridge outranks the child, and a pinned rung does not fall through', async () => {
    const app = appOver(fakeNative());
    let spawned = 0;
    _setCalendarSpawnForTests(() => {
      spawned++;
      return fakeOsascript();
    });

    const cal = await open({ app });
    assert.equal(cal.backend, 'cocoa');
    assert.equal(spawned, 0, 'the child is never started when the bridge is');

    const pinned = await open({ app, backend: 'osascript' });
    assert.equal(pinned.backend, 'osascript', 'and can still be asked for');
  });

  test('a machine with nothing answers null, and only asks to throw', async () => {
    await asLinux(async () => {
      // no bridge in the tree, not a Mac, and no EDS on the bus
      const saved = process.env.DBUS_SESSION_BUS_ADDRESS;
      process.env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/nonexistent/no-bus';
      try {
        assert.equal(await calendarBackend(), null);
        assert.equal(await desktopCalendar(), null);
        await assert.rejects(
          () => desktopCalendar({ required: true }),
          (err) => {
            assert.ok(err instanceof NoCalendarServiceError);
            assert.match(err.message, /calendarBackend/);
            return true;
          },
        );
      } finally {
        if (saved === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS;
        else process.env.DBUS_SESSION_BUS_ADDRESS = saved;
      }
    });
  });
});

// ---------------------------------------------------------------------------
// useDesktopCalendarEvents
// ---------------------------------------------------------------------------

describe('useDesktopCalendarEvents', () => {
  function probe(app, options) {
    let seen = null;
    function Probe() {
      seen = useDesktopCalendarEvents(options);
      return h('box');
    }
    return { Probe, read: () => seen };
  }

  async function mount(app, options) {
    const { Probe, read } = probe(app, options);
    const root = await createRoot({ app });
    roots.push(root);
    root.render(h('window', { width: 200, height: 200 }, h(Probe)));
    await tick();
    return read;
  }

  test('it settles on ready, grouped the way a grid asks', async () => {
    const native = fakeNative({
      events: [
        bridgeEvent(),
        bridgeEvent({
          id: 'E2',
          title: 'Retro',
          start: new Date(2026, 7, 7, 15).getTime(),
          end: new Date(2026, 7, 7, 16).getTime(),
        }),
      ],
    });
    const read = await mount(appOver(native), {
      from: AUGUST[0],
      to: AUGUST[1],
    });

    await until(() => read().status === 'ready', 'the first read');
    assert.equal(read().backend, 'cocoa');
    assert.equal(read().events.length, 2);
    assert.equal(read().calendars.length, 2);
    assert.deepEqual([...read().byDay.keys()], ['2026-08-07']);
    assert.deepEqual(
      read()
        .byDay.get('2026-08-07')
        .map((e) => e.summary),
      ['Standup', 'Retro'],
      'in time order, which is what a day cell renders',
    );
    for (const key of read().byDay.keys()) {
      assert.match(key, /^\d{4}-\d{2}-\d{2}$/);
    }
  });

  test("the user's refusal and the machine's silence are different words", async () => {
    const denied = await mount(appOver(fakeNative({ status: 'denied' })), {
      from: AUGUST[0],
      to: AUGUST[1],
    });
    await until(() => denied().status === 'denied', 'a refusal');
    assert.ok(denied().error instanceof CalendarAccessError);
    assert.equal(denied().backend, 'cocoa', 'there is a rung; it said no');

    await asLinux(async () => {
      const saved = process.env.DBUS_SESSION_BUS_ADDRESS;
      process.env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/nonexistent/no-bus';
      try {
        const none = await mount(appOver(fakeNative({ hasCalendars: false })), {
          from: AUGUST[0],
          to: AUGUST[1],
        });
        await until(() => none().status === 'unavailable', 'no rung at all');
        assert.equal(none().backend, null);
        assert.deepEqual(none().events, []);
      } finally {
        if (saved === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS;
        else process.env.DBUS_SESSION_BUS_ADDRESS = saved;
      }
    });
  });

  test('enabled: false asks nothing at all — not even the grant', async () => {
    const native = fakeNative({ status: 'notDetermined' });
    const read = await mount(appOver(native), {
      from: AUGUST[0],
      to: AUGUST[1],
      enabled: false,
    });
    await tick();
    await tick();
    assert.equal(read().status, 'idle');
    assert.equal(native.of('requestAuthorization').length, 0);
    assert.equal(native.of('calendars').length, 0);
  });

  test('a change re-queries, and unmounting stops the watch', async () => {
    let round = 0;
    const native = fakeNative({
      events: () => (round++ === 0 ? [bridgeEvent()] : []),
    });
    const app = appOver(native);
    const read = await mount(app, {
      from: AUGUST[0],
      to: AUGUST[1],
      watch: true,
    });
    await until(() => read().status === 'ready', 'the first read');
    assert.equal(read().events.length, 1);

    app._route({ type: 'calendar-store-changed' });
    await until(() => read().events.length === 0, 'the re-query');

    const root = roots.pop();
    await root.unmount();
    // nothing left listening: the app's capability has no watchers, so a
    // change after the unmount reaches nobody and cannot re-render
    assert.equal(app.calendars._watchers.size, 0);
  });

  test('the two dates are read by value, so a fresh Date is not a re-query', async () => {
    const native = fakeNative({ events: [] });
    const app = appOver(native);
    let seen = null;
    let renders = 0;
    function Probe() {
      renders++;
      // exactly the mistake the hook is written to survive
      seen = useDesktopCalendarEvents({
        from: new Date(2026, 7, 1),
        to: new Date(2026, 8, 1),
      });
      return h('box');
    }
    const root = await createRoot({ app });
    roots.push(root);
    root.render(h('window', { width: 200, height: 200 }, h(Probe)));
    await until(() => seen?.status === 'ready', 'the first read');

    const before = native.of('eventsBetween').length;
    root.render(h('window', { width: 200, height: 200 }, h(Probe)));
    await tick();
    await tick();
    assert.ok(renders > 1, 'it did render again');
    assert.equal(
      native.of('eventsBetween').length,
      before,
      'and did not query again',
    );
  });
});

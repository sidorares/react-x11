// examples/calendar.jsx carries its own test (AGENTS.md, "every app carries
// its own tests"): the week app driven over a calendar rung attached to the
// mock backend, asserting the two things the example exists to show — the
// user's real events landing on the right days, and the app changing what it
// draws with the rung rather than with the platform.
//
// The rung here is an object with the four verbs `desktopCalendar()` looks
// for, hung on the app the tree renders through. That is the whole capability
// test (src/desktopcalendar.js `calendarsApp`), so this also pins that the
// ladder finds a capability on *an app*, not on a backend it recognises.
import assert from 'node:assert';
import { afterEach, test } from 'node:test';
import React from 'react';

import {
  act,
  cleanup,
  createMockApp,
  renderX11,
  textOf,
} from '../src/testing/index.js';

process.env.REACT_X11_NO_AUTORUN = '1';
const { default: App } = await import('../examples/calendar.jsx');

const h = React.createElement;
const FONTS = { '': { ascent: 12, descent: 3, widths: { '': 7 } } };

// A Wednesday, so the week on screen is Monday the 7th to Sunday the 13th.
const TODAY = new Date(2026, 8, 9, 10, 0);

const CALENDARS = [
  {
    uid: 'home',
    name: 'Home',
    enabled: true,
    color: '#34aadc',
    backend: 'caldav',
    readOnly: false,
    account: 'iCloud',
  },
  {
    uid: 'holidays',
    name: 'Australian Holidays',
    enabled: true,
    color: '#1badf8',
    backend: 'subscription',
    readOnly: true,
    account: 'Subscribed Calendars',
  },
];

function occurrence(over) {
  return {
    uid: 'e1',
    summary: 'Standup',
    start: new Date(2026, 8, 9, 9, 0),
    end: new Date(2026, 8, 9, 9, 15),
    allDay: false,
    recurring: false,
    calendar: { uid: 'home', name: 'Home', color: '#34aadc' },
    ...over,
  };
}

/** A rung with the four verbs the ladder asks for, and a change it can
 *  announce. `access` is what decides which of the app's three faces the
 *  test sees. */
function fakeRung({ access = 'granted', events = [], calendars = CALENDARS }) {
  const watchers = new Set();
  return {
    backend: 'cocoa',
    reads: 0,
    watchers,
    access: async () => access,
    requestAccess: async () => access,
    listCalendars: async () => calendars,
    async eventsBetween() {
      this.reads++;
      return { events, errors: [] };
    },
    async watch(from, to, onChange) {
      watchers.add(onChange);
      return async () => watchers.delete(onChange);
    },
    change: () =>
      watchers.forEach((fn) =>
        fn({ calendar: null, kind: 'changed', count: null }),
      ),
    close: async () => {},
  };
}

async function mount(rung) {
  const app = createMockApp({ fonts: FONTS });
  app.calendars = rung;
  const tree = await renderX11(h(App, { today: TODAY }), { app });
  // the handle opens, the grant is read, the events arrive
  for (let i = 0; i < 6; i++) await act(async () => {});
  return tree;
}

afterEach(cleanup);

const HOLIDAYS = {
  uid: 'holidays',
  name: 'Australian Holidays',
  color: '#1badf8',
};

test('the week shows the events, on the days they happen', async () => {
  const rung = fakeRung({
    events: [
      occurrence(), //  Wednesday the 9th, inside
      occurrence({
        uid: 'e2',
        summary: 'Labour Day',
        allDay: true,
        start: new Date(2026, 8, 7),
        end: new Date(2026, 8, 8), //  exclusive: Monday the 7th only
        calendar: HOLIDAYS,
      }),
      occurrence({
        uid: 'e3',
        summary: 'Father’s Day',
        allDay: true,
        start: new Date(2026, 8, 6),
        end: new Date(2026, 8, 7), //  the Sunday *before* this week
        calendar: HOLIDAYS,
      }),
    ],
  });
  const tree = await mount(rung);
  const text = textOf(tree.windowNode);

  assert.match(text, /Standup/);
  assert.match(text, /09:00.*09:15/, 'a timed event shows its span');
  assert.match(text, /Labour Day/);
  assert.match(text, /all day/, 'and an all-day one says so instead');
  // The week is what is drawn, not the whole result: an exclusive end means
  // the 6th's all-day event belongs to the previous week and to no day here.
  assert.doesNotMatch(text, /Father’s Day/);
  // the footer says which rung answered, which is the point of the app
  assert.match(text, /cocoa — 2 calendars/);
  // The headings are the user's locale, so they are not asserted as strings.
  // What is structural: Monday's event is drawn before Wednesday's, which is
  // the grouping working rather than the list being printed in order.
  assert.ok(
    text.indexOf('Labour Day') < text.indexOf('Standup'),
    'Monday before Wednesday',
  );
});

test('a refusal offers the Settings pane; nothing else does', async () => {
  const denied = fakeRung({ access: 'denied' });
  const tree = await mount(denied);
  const text = textOf(tree.windowNode);
  assert.match(text, /may not read your calendars/);
  assert.match(text, /Open Settings/);
  assert.equal(denied.reads, 0, 'and it did not read anything');

  await cleanup();
  const fine = await mount(fakeRung({ events: [occurrence()] }));
  assert.doesNotMatch(textOf(fine.windowNode), /Open Settings/);
});

test('a change in the store re-queries the week', async () => {
  const rung = fakeRung({ events: [occurrence()] });
  const tree = await mount(rung);
  const before = rung.reads;
  assert.ok(before > 0);

  await act(async () => rung.change());
  for (let i = 0; i < 4; i++) await act(async () => {});
  assert.ok(rung.reads > before, 'the week read itself again');
  assert.match(textOf(tree.windowNode), /Standup/);
});

// examples/schedule.jsx — a timetable held together by `position: 'sticky'`.
//
// The schedule is a seam, so these run over a small programme of their own.
// What they pin is what the example is for: the day's header holds the top
// of the pane and is pushed off by the next day, the times and the corner
// hold the start edge, and a press on a held header is the header's — plus
// the parts that make it a program, starring and jumping to a day.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import React from 'react';

import {
  renderX11,
  cleanup,
  screen,
  act,
  waitFor,
  userEvent,
  fireEvent,
  pixelAt,
  XK_SPACE,
} from '../src/testing/index.js';

process.env.REACT_X11_NO_AUTORUN = '1';

const { SchedulePanel, buildSchedule, timeOf } =
  await import('../examples/schedule.jsx');

const require = createRequire(import.meta.url);
const FONT = join(
  dirname(require.resolve('katex/package.json')),
  'dist',
  'fonts',
  'KaTeX_Main-Regular.ttf',
);
const fonts = { 'sans-serif': FONT };

afterEach(cleanup);

const h = React.createElement;

/** Two days, three rooms, a handful of talks — small enough to reason
 *  about in pixels. The first talk in each room starts at 09:00. */
const SMALL = {
  days: [
    { id: 'thu', short: 'Thu', name: 'Thursday', date: '12 November' },
    { id: 'fri', short: 'Fri', name: 'Friday', date: '13 November' },
  ],
  rooms: [
    { id: 'hall', name: 'Main Hall', seats: 900 },
    { id: 'harbour', name: 'Harbour', seats: 320 },
    { id: 'loft', name: 'The Loft', seats: 140 },
  ],
  talks: ['thu', 'fri'].flatMap((day) =>
    ['hall', 'harbour', 'loft'].flatMap((room) => [
      {
        id: `${day}-${room}-0`,
        day,
        room,
        start: 0,
        length: 2,
        title: `First in ${room}`,
        speaker: 'Ada Okafor',
        track: 'rendering',
      },
      {
        id: `${day}-${room}-3`,
        day,
        room,
        start: 3,
        length: 1,
        title: `Later in ${room}`,
        speaker: 'Kenji Sato',
        track: 'protocol',
      },
    ]),
  ),
};

async function mount(props = {}) {
  const handle = await renderX11(
    h(SchedulePanel, { schedule: SMALL, ...props }),
    {
      fonts,
      width: 520,
      height: 360,
    },
  );
  await waitFor(() => {
    assert.ok(screen.getByTestName('pane').abs.height > 0, 'not laid out yet');
  });
  return handle;
}

const byName = (name) => screen.getByTestName(name);
const topIn = (node, pane) => node.abs.y - pane.abs.y;
const startIn = (node, pane) => node.abs.x - pane.abs.x;
const scroll = (pane, to) => act(() => pane.scrollTo(to));

test('the programme is the same on every run, and never double-books a room', () => {
  const a = buildSchedule();
  assert.deepEqual(buildSchedule(), a);
  for (const day of a.days) {
    for (const room of a.rooms) {
      const talks = a.talks
        .filter((t) => t.day === day.id && t.room === room.id)
        .sort((x, y) => x.start - y.start);
      for (let i = 1; i < talks.length; i++) {
        const before = talks[i - 1];
        assert.ok(
          before.start + before.length <= talks[i].start,
          `${before.id} runs into ${talks[i].id}`,
        );
      }
      // lunch is 12:30 to 13:30 for everyone
      for (const t of talks) {
        const ends = t.start + t.length;
        assert.ok(ends <= 7 || t.start >= 9, `${t.id} runs through lunch`);
      }
    }
  }
  assert.equal(timeOf(0), '09:00');
  assert.equal(timeOf(7), '12:30');
});

test('scrolling down holds the day’s header at the top until the next day pushes it off', async () => {
  await mount();
  const pane = byName('pane');
  const thu = byName('header-thu');
  const fri = byName('header-fri');
  // the wheel, through the server: three notches
  await userEvent.wheel(pane, { deltaY: 3 });
  assert.ok(pane.scrollY > 0, 'it scrolled');
  assert.equal(topIn(thu, pane), 0, 'Thursday is held at the top');

  // Friday's chip scrolls to where layout put Friday, and its header is
  // at the top — Thursday's has been pushed off above it
  await userEvent.click(byName('jump-fri'));
  assert.equal(topIn(fri, pane), 0, 'Friday is held at the top');
  assert.ok(
    thu.abs.y + thu.abs.height <= pane.abs.y,
    'Thursday was pushed off',
  );

  // back up one notch: Thursday's last 48 pixels are on screen, and its
  // header is being shoved off by Friday's, bottom edge to top edge
  await userEvent.wheel(pane, { deltaY: -1 });
  const friTop = topIn(fri, pane);
  assert.ok(friTop > 0, 'Friday is back in flow');
  assert.equal(topIn(thu, pane) + thu.abs.height, friTop);
});

test('scrolling across holds the times, the corner and the day’s name at the start edge', async () => {
  await mount();
  const pane = byName('pane');
  const times = byName('times-thu');
  const corner = byName('corner-thu');
  const label = byName('label-thu');
  const talk = byName('talk-thu-hall-0');
  const before = startIn(talk, pane);
  // three rooms of 200 beside 64 of times: 144 to scroll in a 520 window
  await scroll(pane, { x: 100, y: 60 });
  assert.equal(pane.scrollX, 100);
  assert.equal(startIn(talk, pane), before - 100, 'the talks scroll across');
  assert.equal(startIn(times, pane), 0, 'the times are held');
  assert.equal(startIn(corner, pane), 0, 'the corner is held across…');
  assert.equal(topIn(corner.parent.parent, pane), 0, '…and down');
  assert.equal(startIn(label, pane), 0, 'the day’s name is held in its banner');
});

test('a press on the held header is the header’s, not the talk’s under it', async () => {
  await mount();
  const pane = byName('pane');
  const talk = byName('talk-thu-hall-0');
  // scrolled so that the first talk sits under the held header
  await scroll(pane, { y: 60 });
  const header = byName('header-thu');
  const x = talk.abs.x + talk.abs.width / 2;
  const y = header.abs.y + header.abs.height - 4;
  assert.ok(talk.containsPoint(x, y), 'the talk is under the header there');
  await act(() =>
    fireEvent.click(header, {
      dx: x - (header.abs.x + header.abs.width / 2),
      dy: y - (header.abs.y + header.abs.height / 2),
    }),
  );
  assert.equal(talk.props['aria-pressed'], false, 'the talk was not starred');
});

test('a talk stars with a click or with Space, and "Starred" keeps just those', async () => {
  await mount();
  const talk = () => byName('talk-thu-harbour-3');
  await userEvent.click(talk());
  assert.equal(talk().props['aria-pressed'], true);
  // …and Space on the focused talk takes it back
  await userEvent.key(XK_SPACE);
  assert.equal(talk().props['aria-pressed'], false);

  await userEvent.click(talk());
  await userEvent.click(byName('starred-only'));
  const left = screen.all((n) =>
    String(n.props?.['data-testname'] ?? '').startsWith('talk-'),
  );
  assert.deepEqual(
    left.map((n) => n.props['data-testname']),
    ['talk-thu-harbour-3'],
  );
});

test('the held header is what the pixels show', async () => {
  const { ctx } = await mount();
  const pane = byName('pane');
  const header = byName('header-thu');
  // a point on the banner, clear of its label
  const x = pane.abs.x + pane.abs.width - 20;
  const y = header.abs.y + 10;
  const before = await pixelAt(ctx, x, y);
  await scroll(pane, { y: 120 });
  assert.deepEqual(await pixelAt(ctx, x, y), before);
});

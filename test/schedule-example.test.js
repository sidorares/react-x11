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

async function mount(
  props = {},
  { width = 520, height = 360, direction } = {},
) {
  const panel = h(SchedulePanel, { schedule: SMALL, ...props });
  const handle = await renderX11(
    direction ? h('box', { style: { flexGrow: 1, direction } }, panel) : panel,
    { fonts, width, height },
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

/** Every pixel of the window, straight RGBA. */
const pixelsOf = (ctx, width, height) =>
  new Promise((resolve, reject) =>
    ctx.getImageData(0, 0, width, height, (err, image) =>
      err ? reject(err) : resolve(image.data),
    ),
  );

/** How many pixels two reads disagree on, and the box they lie in. */
function disagreement(a, b, width) {
  let count = 0;
  let box = null;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2]) {
      continue;
    }
    const x = (i / 4) % width;
    const y = Math.floor(i / 4 / width);
    count++;
    box = box
      ? {
          x0: Math.min(box.x0, x),
          y0: Math.min(box.y0, y),
          x1: Math.max(box.x1, x),
          y1: Math.max(box.y1, y),
        }
      : { x0: x, y0: y, x1: x, y1: y };
  }
  return { count, box };
}

// The scroll blit copies the frame it has and repaints only what the copy
// got wrong, so a notch it serves has to come out as the frame a full
// repaint paints. The grid scrolls both ways, which gives the pane a bar
// across whichever axis a notch does not move, and the blit drags that bar's
// pixels along with the talks: a notch across left a copy of the vertical
// thumb 48 pixels in from its track, a 6 by 44 sliver at the top of the
// pane, at the other edge in RTL. The shipped programme at 640 by 400,
// because in the small one's window the blit declines every notch, and a
// declined notch compares nothing. Each pass sets its direction rather than
// taking the locale's, so it knows which way the pixels go.
for (const direction of ['ltr', 'rtl']) {
  test(`a notch the scroll blit serves paints what a full repaint does, ${direction}`, async () => {
    const width = 640;
    const height = 400;
    const {
      window: wnd,
      windowNode,
      ctx,
    } = await mount(
      { schedule: buildSchedule() },
      { width, height, direction },
    );
    const pane = byName('pane');
    const shifts = [];
    const scrollRegion = wnd.scrollRegion.bind(wnd);
    wnd.scrollRegion = (region, dx, dy) => {
      const ok = scrollRegion(region, dx, dy);
      if (ok) shifts.push([dx, dy]);
      return ok;
    };
    const notch = async (to, shift) => {
      shifts.length = 0;
      await scroll(pane, to);
      const where = JSON.stringify(to);
      assert.deepEqual(shifts, [shift], `the notch to ${where} blitted`);
      const blitted = await pixelsOf(ctx, width, height);
      await act(() => windowNode.invalidate(false));
      const repainted = await pixelsOf(ctx, width, height);
      const { count, box } = disagreement(blitted, repainted, width);
      assert.equal(
        count,
        0,
        `the notch to ${where} differs from a full repaint in ${count} pixels,` +
          ` x ${box?.x0} to ${box?.x1}, y ${box?.y0} to ${box?.y1}`,
      );
    };
    // across, with the times, the corner and the day's name held at the
    // start edge: the vertical bar is the one dragged. Scrolling on carries
    // the content toward the start edge, left in LTR and right in RTL.
    const across = direction === 'rtl' ? 48 : -48;
    await notch({ x: 48 }, [across, 0]);
    await notch({ x: 96 }, [across, 0]);
    // down, through Thursday's header being pushed off by Friday's: the
    // horizontal bar is dragged up off its track
    await scroll(pane, { y: 801 });
    await notch({ y: 849 }, [0, -48]);
    await notch({ y: 801 }, [0, 48]);
  });
}

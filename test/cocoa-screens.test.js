// The screen layout on cocoa, after startup (#617).
//
// The bridge keeps its `NSScreen` copy current — it republishes on
// `NSApplicationDidChangeScreenParametersNotification` — but emits no event
// for it, and `CocoaApp` read `listScreens()` once, in its constructor. So a
// monitor plugged in, unplugged, rearranged, woken or made primary was
// invisible: `useScreens()` never changed, and every `availableArea()` clamp
// picked a monitor from a desk that no longer existed.
//
// The answer is to ask, at the three moments that matter: before a placement
// reads the layout, when a window reports that it moved, and on a clock
// while something is subscribed. These pin all three, plus the fields
// `screenLayout` used to drop on the way through.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sameScreens } from '../src/cocoa/app.js';
import { anchorScreenRect } from '../src/index.js';
import {
  availableArea,
  screensSnapshot,
  watchScreens,
} from '../src/screens.js';
import { fakeCocoaApp, fakeCocoaBridge } from './helpers/cocoa-bridge.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait for `fn` to hold, or fail the test rather than hang the runner. */
async function until(fn, what, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!fn()) {
    assert.ok(Date.now() < deadline, `timed out waiting: ${what}`);
    await delay(5);
  }
}

// The three-monitor desk the issue was probed on, in points: a 2x laptop
// with the menu bar, and two 1x displays above it — one to the left, one to
// the right. `listScreens()` reports them in `NSScreen.screens` order, the
// primary first.
const LID = {
  x: 0,
  y: 0,
  width: 1728,
  height: 1117,
  scale: 2,
  fps: 120,
  visible: { x: 0, y: 25, width: 1728, height: 1092 },
  primary: true,
};
const RIGHT = {
  x: 937,
  y: -1440,
  width: 2560,
  height: 1440,
  scale: 1,
  fps: 60,
  visible: { x: 937, y: -1440, width: 2560, height: 1440 },
  primary: false,
};
const LEFT = { ...RIGHT, x: -1623, visible: { ...RIGHT.visible, x: -1623 } };

/** An app over a bridge that reports `screens`, with the clock off unless a
 *  test asks for one — most of these are about the paths that do not poll. */
function deskOf(t, screens, cocoa = { screenPoll: 0 }) {
  const native = fakeCocoaBridge({ screens });
  const { app } = fakeCocoaApp(cocoa, { native });
  t.after(() => app.close());
  return { app, native };
}

// --- what the bridge said and the layout dropped -----------------------------

test('the menu-bar screen is the primary one, and every panel keeps its rate', (t) => {
  const { app } = deskOf(t, [LID, LEFT, RIGHT]);
  const { screens, primary } = screensSnapshot(app);

  assert.equal(screens.length, 3);
  // `primary` was dropped by `screenLayout`, so every entry read false and
  // `useScreens().primary` was null on macOS however many displays there
  // were. `NSScreen.screens[0]` is the screen with the menu bar.
  assert.deepEqual(
    screens.map((s) => s.primary),
    [true, false, false],
  );
  assert.equal(primary, screens[0], 'the entry itself, not a copy of it');
  // …and `fps`, which the frame clock was already pacing windows on while
  // `useScreens()` reported no rate at all
  assert.deepEqual(
    screens.map((s) => s.refreshRate),
    [120, 60, 60],
  );
});

test('what counts as a different desk', () => {
  assert.equal(sameScreens([LID, RIGHT], [LID, RIGHT]), true);
  assert.equal(sameScreens([LID, RIGHT], [LID]), false, 'one unplugged');
  // The order is `NSScreen.screens`, which is the arrangement and which
  // screen is primary, so swapping two is a change even at the same rects.
  assert.equal(sameScreens([LID, RIGHT], [RIGHT, LID]), false);
  assert.equal(
    sameScreens([LID], [{ ...LID, fps: 60 }]),
    false,
    'a mode switch is a change: a window paces itself on the rate',
  );
  const whole = { x: 0, y: 0, width: LID.width, height: LID.height };
  assert.equal(
    sameScreens([LID], [{ ...LID, visible: whole }]),
    false,
    'the menu bar hiding gives the screen back, and nothing else moves',
  );
});

// --- the placement asks for itself -------------------------------------------

test('a popup is placed on the monitor the desk has now, with no clock at all', (t) => {
  // Startup: the second display is to the RIGHT of the laptop.
  const { app, native } = deskOf(t, [LID, RIGHT]);
  // …and then it is moved to the left of it, which is a rearrangement no
  // event reports.
  native.setScreens([LID, LEFT]);

  // A tray item near the middle of that display, in points.
  const item = { x: -500, y: -1440, width: 30, height: 22 };
  const at = anchorScreenRect(app, item, {
    width: 280,
    height: 400,
    scale: 2,
    placement: 'bottom',
    align: 'center',
    offset: 6,
  });

  // Against the startup layout the item is on no monitor at all, so
  // `monitorAt()` falls back to the nearest one — which, the desk having
  // been rearranged under it, is the display that used to be on the right
  // — and the popover is clamped into it, 1437 points from the icon that
  // opened it. Against the layout the desk has, it simply hangs under the
  // item.
  assert.deepEqual(at, {
    x: -625,
    y: -1412,
    width: 280,
    height: 400,
    placement: 'bottom',
  });
});

test('the usable area answers for the desk as it is, not as it was', (t) => {
  const { app, native } = deskOf(t, [LID]);
  native.setScreens([LID, LEFT]);

  // Device pixels, which is the unit `<window width="auto">`'s cap and the
  // anchor math both read it in. A point on the display that has just
  // arrived answers with that display — before, there was one monitor to
  // pick from and every auto-sized window was capped by the laptop.
  assert.deepEqual(availableArea(app, { x: -1000, y: -2880 }), {
    x: -3246,
    y: -2880,
    width: 5120,
    height: 2880,
  });
  // …and what the hook reads was published on the way through
  assert.equal(screensSnapshot(app).screens.length, 2);
});

// --- the clock, while something is watching ----------------------------------

test('a monitor plugged in re-renders what is watching the layout', async (t) => {
  const { app, native } = deskOf(t, [LID], { screenPoll: 10 });
  const seen = [];
  const off = watchScreens(app, () =>
    seen.push(screensSnapshot(app).screens.length),
  );
  t.after(off);

  native.setScreens([LID, RIGHT]);
  await until(() => seen.length > 0, 'the plugged-in monitor to arrive');
  assert.deepEqual(seen, [2]);

  // …and a desk that stands still publishes nothing, however often it is
  // asked: a poll that re-published would re-render every subscriber twice
  // a second for ever.
  await delay(50);
  assert.deepEqual(seen, [2], 'nothing changed, so nothing was published');

  native.setScreens([LID]);
  await until(() => seen.length > 1, 'the unplug to arrive');
  assert.deepEqual(seen, [2, 1]);
});

test('nothing polls until something watches, and the clock stops with it', async (t) => {
  const { app, native } = deskOf(t, [LID], { screenPoll: 10 });
  const reads = () => native.of('listScreens').length;

  const idle = reads();
  await delay(50);
  assert.equal(reads(), idle, 'an app that never asks never re-reads');

  const off = watchScreens(app, () => {});
  await until(() => reads() > idle, 'the clock to start');

  off();
  // The unsubscribe clears the interval synchronously, so nothing can fire
  // between these two lines.
  const stopped = reads();
  await delay(50);
  assert.equal(reads(), stopped, 'the clock went with the last watcher');
});

test('cocoa.screenPoll: 0 is an app that keeps its own clock', async (t) => {
  const { app, native } = deskOf(t, [LID], { screenPoll: 0 });
  const reads = () => native.of('listScreens').length;
  const off = watchScreens(app, () => {});
  t.after(off);

  const idle = reads();
  await delay(50);
  assert.equal(reads(), idle, 'watched, and still no clock');
  // and the seam is still there for whoever turned it off
  native.setScreens([LID, RIGHT]);
  assert.equal(app.refreshScreens(), true);
  assert.equal(screensSnapshot(app).screens.length, 2);
});

test('a bad screenPoll is said at once, not run with', () => {
  assert.throws(
    () => fakeCocoaApp({ screenPoll: 'often' }),
    /cocoa\.screenPoll is a number of milliseconds/,
  );
});

// --- the window that reports it moved ----------------------------------------

test('a window reporting a move rechecks the desk, at most once a second', (t) => {
  const { app, native } = deskOf(t, [LID]);
  const wnd = app.createWindow({ width: 400, height: 300 });
  const reads = () => native.of('listScreens').length;

  native.setScreens([LID, RIGHT]);
  // A move a second after the last read — which is what a display change
  // looks like from here: the windows that were on it are moved.
  app._screensAt -= 2000;
  const before = reads();
  native.emit({
    type: 'window-move',
    windowNumber: wnd.windowNumber,
    x: 10,
    y: 10,
    width: 200,
    height: 150,
  });
  assert.equal(reads(), before + 1);
  assert.equal(screensSnapshot(app).screens.length, 2);

  // …and the next sixty, which is what a drag looks like, cost nothing.
  const after = reads();
  for (let i = 0; i < 5; i++) {
    native.emit({
      type: 'window-move',
      windowNumber: wnd.windowNumber,
      x: 10 + i,
      y: 10,
      width: 200,
      height: 150,
    });
  }
  assert.equal(reads(), after, 'the throttle held');
});

test('a window paces itself on the rate its display has now', (t) => {
  const { app, native } = deskOf(t, [{ ...LID, fps: 60 }]);
  // the helper pins every window to the test's own clock; this one is about
  // the clock itself
  app._frameInterval = null;
  const wnd = app.createWindow({ width: 400, height: 300 });
  assert.equal(wnd._frameInterval, 1000 / 60);

  native.setScreens([{ ...LID, fps: 120 }]);
  assert.equal(app.refreshScreens(), true);
  assert.equal(wnd._frameInterval, 1000 / 120, 'a mode switch under a window');
});

// --- degrading -----------------------------------------------------------

test('a bridge that cannot answer keeps the layout it published', (t) => {
  const { app, native } = deskOf(t, [LID, RIGHT]);

  native.setScreens([]);
  assert.equal(app.refreshScreens(), false, 'an empty answer is not a desk');
  assert.equal(screensSnapshot(app).screens.length, 2);

  native.setScreens(null);
  native.listScreens = undefined;
  assert.equal(app.refreshScreens(), false);
  assert.equal(screensSnapshot(app).screens.length, 2);
});

test('a closed app answers nothing and keeps no clock', async (t) => {
  const { app, native } = deskOf(t, [LID], { screenPoll: 10 });
  const off = watchScreens(app, () => {});
  t.after(off);
  await until(() => native.of('listScreens').length > 1, 'the clock to start');

  await app.close();
  const stopped = native.of('listScreens').length;
  native.setScreens([LID, RIGHT]);
  assert.equal(app.refreshScreens(), false);
  await delay(50);
  assert.equal(native.of('listScreens').length, stopped);
});

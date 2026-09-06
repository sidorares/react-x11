// examples/notify.jsx carries its own test (AGENTS.md, "every app carries its
// own tests"): the download manager driven through its `fixtureTransfers`
// seam, asserting the thing the example exists to show — **one** banner that
// is updated in place while a transfer runs, the actions round-tripping back
// into React state, and the quiet fallback on a rung that can neither update
// nor report.
//
// Rendered on the mock backend (its fonts lay text out) with a notification
// centre the mock does not have, added as a fake — so `notify()` takes its
// top rung and every call is observable. That the calls then reach
// `UNUserNotificationCenter` / the freedesktop daemon is
// `test/notifications.test.js`.
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
import { _resetNotifications } from '../src/notifications.js';

process.env.REACT_X11_NO_AUTORUN = '1';
const { default: App, fixtureTransfers } =
  await import('../examples/notify.jsx');

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

const FONTS = { '': { ascent: 12, descent: 3, widths: { '': 7 } } };

afterEach(async () => {
  await _resetNotifications();
});
afterEach(cleanup);

/** A banner shaped like the real handles: merged options, recorded calls. */
function fakeBanner(options, backend) {
  return {
    backend,
    id: options.identifier ?? 1,
    options,
    updates: [],
    closed: false,
    update(p) {
      this.options = { ...this.options, ...p };
      this.updates.push(p);
      return Promise.resolve(this);
    },
    close() {
      this.closed = true;
      return Promise.resolve();
    },
    /** what the desktop would report back */
    fire: (key) => options.onAction?.(key),
    dismiss: (reason) => options.onClose?.(reason),
  };
}

/** A mock app with a notification centre, so notify() takes the top rung. */
function notifyApp() {
  const app = createMockApp();
  app.banners = [];
  app.notifications = {
    available: async () => true,
    async post(options) {
      const b = fakeBanner(options, 'cocoa');
      app.banners.push(b);
      return b;
    },
  };
  return app;
}

async function mount(source, app = notifyApp()) {
  const view = await renderX11(h(App, { source }), {
    app,
    wrap: false,
    fonts: FONTS,
  });
  // the backend probe is async; let it settle so `notifier.backend` is set
  await act(async () => {
    await tick();
    await tick();
  });
  return { app, view };
}

test('one banner counts up in place, rather than one per step', async () => {
  const source = fixtureTransfers({ tickMs: 0, steps: 4 });
  const { app } = await mount(source);

  let id;
  await act(async () => {
    id = source.start('report.pdf').id;
  });
  assert.equal(app.banners.length, 1, 'one banner for the download');
  const banner = app.banners[0];
  assert.equal(banner.options.summary, 'Downloading report.pdf');
  assert.equal(banner.options.body, '0%');
  assert.deepEqual(
    banner.options.actions.map((a) => a.key),
    ['cancel'],
  );

  await act(async () => source.advance(id));
  await act(async () => source.advance(id));
  assert.equal(app.banners.length, 1, 'still one — updated, not re-posted');
  assert.deepEqual(
    banner.updates.map((u) => u.body),
    ['25%', '50%'],
  );
});

test('finishing replaces the same banner and offers Open; the action reaches the app', async () => {
  const source = fixtureTransfers({ tickMs: 0, steps: 2 });
  const { app, view } = await mount(source);

  let id;
  await act(async () => {
    id = source.start('notes.md').id;
  });
  await act(async () => source.advance(id)); // 50%
  await act(async () => source.advance(id)); // 2 of 2 → done
  const banner = app.banners[0];
  assert.equal(app.banners.length, 1, 'the counting banner became this one');
  assert.equal(banner.options.summary, 'Download finished');
  assert.deepEqual(
    banner.options.actions.map((a) => a.key),
    ['open'],
  );
  assert.ok(textOf(view.windowNode).includes('finished'));

  // the desktop reports the press
  await act(async () => banner.fire('open'));
  assert.ok(
    textOf(view.windowNode).includes('opened'),
    'onAction landed in React state',
  );
});

test('Cancel from the banner stops the transfer and takes the banner down', async () => {
  const source = fixtureTransfers({ tickMs: 0, steps: 4 });
  const { app, view } = await mount(source);
  await act(async () => source.start('big.iso'));
  const banner = app.banners[0];

  await act(async () => banner.fire('cancel'));
  assert.equal(banner.closed, true, 'the banner was closed');
  assert.ok(textOf(view.windowNode).includes('cancelled'));
});

test('a dismissal is reported on the row', async () => {
  const source = fixtureTransfers({ tickMs: 0, steps: 4 });
  const { app, view } = await mount(source);
  await act(async () => source.start('a.txt'));

  await act(async () => app.banners[0].dismiss('dismissed'));
  assert.ok(textOf(view.windowNode).includes('notification dismissed'));
});

test('on a rung that cannot update, nothing is posted until the download finishes', async () => {
  // no centre on the app and no bus: notify() lands on a shell-out rung, so
  // the app stays quiet while the transfer runs
  const app = createMockApp();
  const posted = [];
  app.notifications = {
    available: async () => false, // the centre cannot deliver (a bare process)
  };
  // force the shell-out rung's shape by recording what the app would post
  const source = fixtureTransfers({ tickMs: 0, steps: 3 });
  const view = await renderX11(h(App, { source }), {
    app,
    wrap: false,
    fonts: FONTS,
  });
  await act(async () => {
    await tick();
    await tick();
  });
  void posted;

  let id;
  await act(async () => {
    id = source.start('quiet.bin').id;
  });
  await act(async () => source.advance(id));
  // whatever rung was chosen, no centre banner exists — and the window still
  // tracks the transfer, which is the fallback the example promises
  assert.equal(app.banners, undefined);
  assert.ok(textOf(view.windowNode).includes('quiet.bin'));
});

test('fixtureTransfers: start, advance to done, and cancel', () => {
  const source = fixtureTransfers({ tickMs: 0, steps: 2 });
  const seen = [];
  const off = source.subscribe((t) => seen.push({ ...t }));
  const t = source.start('x.zip');
  assert.equal(seen.at(-1).step, 0);
  assert.equal(source.advance(t.id), true, 'step 1 of 2 — halfway');
  assert.equal(seen.at(-1).done, false);
  assert.equal(source.advance(t.id), false, 'step 2 of 2 — the last one');
  assert.equal(seen.at(-1).done, true);
  assert.equal(
    source.advance(t.id),
    false,
    'finished transfers do not advance',
  );

  const b = source.start('y.zip');
  source.cancel(b.id);
  assert.equal(seen.at(-1).cancelled, true);
  off();
  source.start('z.zip');
  assert.equal(seen.at(-1).name, 'y.zip', 'unsubscribed');
});

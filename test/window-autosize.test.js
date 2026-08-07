// `<window>` sizing itself from its content — CSS's `width: auto`, which is
// also what leaving the prop out means.
//
// Headless, so there are no fonts and text measures 0x0 (see AGENTS.md): the
// content here is sized boxes, and the height-for-width case is built out of
// `flexWrap` rather than out of a wrapping paragraph. `test/integration.test.js`
// is where the same thing is asserted against real glyphs.
import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import { createRoot } from '../src/index.js';
import { createMockApp } from './helpers/mock-app.js';
import { setScreensForTests } from '../src/screens.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Render one tree and hand back the mock window it created. */
async function mount(element, { screens } = {}) {
  const app = createMockApp();
  if (screens !== undefined) setScreensForTests(app, screens);
  const root = await createRoot({ app });
  root.render(element);
  await tick();
  return { app, root, wnd: app.windows[0] };
}

const box = (style, key) => h('box', { key, style });

test('a window with no size is as big as its content', async () => {
  const { wnd, root } = await mount(
    h(
      'window',
      { title: 'natural' },
      h(
        'box',
        { style: { padding: 10, flexDirection: 'row', gap: 8 } },
        box({ width: 120, height: 40 }, 'a'),
        box({ width: 300, height: 80 }, 'b'),
      ),
    ),
  );
  // 10 + 120 + 8 + 300 + 10 across, 10 + 80 + 10 down
  assert.strictEqual(wnd.width, 448);
  assert.strictEqual(wnd.height, 100);
  await root.unmount();
});

test("width='auto' is the same request as leaving width out", async () => {
  const content = box({ width: 210, height: 90 }, 'only');
  const omitted = await mount(h('window', null, content));
  const spelled = await mount(
    h('window', { width: 'auto', height: 'auto' }, content),
  );
  assert.deepStrictEqual(
    [omitted.wnd.width, omitted.wnd.height],
    [spelled.wnd.width, spelled.wnd.height],
  );
  assert.strictEqual(spelled.wnd.width, 210);
  await omitted.root.unmount();
  await spelled.root.unmount();
});

test('the size is settled before the window is mapped', async () => {
  // The whole point of measuring in realize() rather than after the first
  // layout: the window is *created* at its natural size, so nothing is ever
  // on screen at the wrong one. A resize before or after the map would both
  // be a visible jump.
  const { wnd, root } = await mount(
    h('window', null, box({ width: 240, height: 160 })),
  );
  assert.strictEqual(wnd.attributes.width, 240, 'sized at CreateWindow');
  assert.strictEqual(wnd.attributes.height, 160);
  assert.deepStrictEqual(
    wnd.calls.filter(([name]) => name === 'resize'),
    [],
    'and never resized into place afterwards',
  );
  assert.ok(
    wnd.calls.some(([name]) => name === 'map'),
    'the window really did map',
  );
  await root.unmount();
});

test('a window is never bigger than the monitor it opens on', async () => {
  const { wnd, root } = await mount(
    h('window', null, box({ width: 5000, height: 5000 })),
    { screens: { monitors: [{ x: 0, y: 0, width: 400, height: 300 }] } },
  );
  assert.strictEqual(wnd.width, 400);
  assert.strictEqual(wnd.height, 300);
  await root.unmount();
});

test('the work area takes a panel off the monitor', async () => {
  const { wnd, root } = await mount(
    h('window', null, box({ width: 5000, height: 5000 })),
    {
      screens: {
        monitors: [{ x: 0, y: 0, width: 1280, height: 800 }],
        workArea: { x: 0, y: 28, width: 1280, height: 744 },
      },
    },
  );
  assert.strictEqual(wnd.width, 1280);
  assert.strictEqual(wnd.height, 744, 'the panel is not space to grow into');
  await root.unmount();
});

test('with several monitors, a dialog is sized against its owner’s', async () => {
  const app = createMockApp();
  setScreensForTests(app, {
    monitors: [
      { x: 0, y: 0, width: 1920, height: 1080 },
      { x: 1920, y: 0, width: 800, height: 600 },
    ],
  });
  const root = await createRoot({ app });
  const owner = { current: null };
  root.render(
    h(
      'window',
      { ref: owner, width: 300, height: 200 },
      h('popup', {
        transientFor: owner,
        overrideRedirect: false,
        children: box({ width: 4000, height: 4000 }),
      }),
    ),
  );
  await tick();
  // the owner is on the small right-hand monitor
  app.windows[0]._screenOrigin = { x: 2000, y: 100 };
  const dialog = app.windows[1];
  dialog._reactX11Node._refit();
  assert.strictEqual(dialog.width, 800, 'the monitor it will open on');
  assert.strictEqual(dialog.height, 600);
  await root.unmount();
});

test('with no screen to ask, nothing is capped', async () => {
  const { wnd, root } = await mount(
    h('window', null, box({ width: 4000, height: 40 })),
    { screens: {} },
  );
  assert.strictEqual(wnd.width, 4000);
  await root.unmount();
});

test('minWidth and maxHeight bound the natural size, min winning', async () => {
  const { wnd, root } = await mount(
    h(
      'window',
      { maxWidth: 200, minWidth: 260, minHeight: 500, maxHeight: 600 },
      box({ width: 900, height: 20 }),
    ),
  );
  // CSS's order: max applies, then min wins over it
  assert.strictEqual(wnd.width, 260);
  assert.strictEqual(wnd.height, 500);
  await root.unmount();
});

test('a fixed width with an auto height is height-for-width', async () => {
  // Three 100-wide chips wrapping in a 250-wide window is two rows, not one
  // — the height has to come from a layout run at the width the window will
  // actually be, which is the pass it is tempting to skip.
  const { wnd, root } = await mount(
    h(
      'window',
      { width: 250 },
      h(
        'box',
        { style: { flexDirection: 'row', flexWrap: 'wrap' } },
        box({ width: 100, height: 30 }, 'a'),
        box({ width: 100, height: 30 }, 'b'),
        box({ width: 100, height: 30 }, 'c'),
      ),
    ),
  );
  assert.strictEqual(wnd.width, 250, 'the width was the app’s to say');
  assert.strictEqual(wnd.height, 60, 'two rows, measured at 250');
  await root.unmount();
});

test('an empty window is 1x1 rather than a BadValue', async () => {
  const { wnd, root } = await mount(h('window', { title: 'nothing' }));
  assert.strictEqual(wnd.width, 1);
  assert.strictEqual(wnd.height, 1);
  await root.unmount();
});

test('an explicit size is passed through untouched', async () => {
  const { wnd, root } = await mount(
    h('window', { width: 640, height: 480 }, box({ width: 20, height: 20 })),
  );
  assert.strictEqual(wnd.width, 640);
  assert.strictEqual(wnd.height, 480);
  await root.unmount();
});

test('a size that is neither a number nor auto says what to write', async () => {
  const app = createMockApp();
  const errors = [];
  const root = await createRoot({
    app,
    onUncaughtError: (e) => errors.push(e),
  });
  root.render(h('window', { width: '100%' }));
  await tick();
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0].message, /width=\{"100%"\}/);
  assert.match(errors[0].message, /a number of pixels or 'auto'/);
  await root.unmount();
});

// --- keeping up with the content -------------------------------------------

function Rows({ n, ...props }) {
  return h(
    'window',
    { title: 'rows', ...props },
    ...Array.from({ length: n }, (_, i) => box({ width: 100, height: 30 }, i)),
  );
}

test('an auto window grows with its content', async () => {
  const app = createMockApp();
  const root = await createRoot({ app });
  root.render(h(Rows, { n: 2 }));
  await tick();
  const wnd = app.windows[0];
  assert.strictEqual(wnd.height, 60);

  root.render(h(Rows, { n: 5 }));
  await tick();
  assert.strictEqual(wnd.height, 150, 'three more rows, three more times 30');
  await root.unmount();
});

test('…until the user resizes it, and then it is theirs', async () => {
  const app = createMockApp();
  const root = await createRoot({ app });
  root.render(h(Rows, { n: 2 }));
  await tick();
  const wnd = app.windows[0];

  // what a resize drag delivers: a ConfigureNotify for a size we never asked
  // for
  wnd.width = 400;
  wnd.height = 400;
  wnd.emit('resize', { width: 400, height: 400, resized: true, moved: false });
  await tick();

  root.render(h(Rows, { n: 8 }));
  await tick();
  assert.strictEqual(wnd.width, 400, 'the size the user chose stands');
  assert.strictEqual(wnd.height, 400);
  await root.unmount();
});

test('a window manager that overrides the size keeps it', async () => {
  // Same rule from the other side: a tiling WM answers the natural size with
  // one of its own, and re-asking every frame would be a fight it wins.
  const app = createMockApp();
  const root = await createRoot({ app });
  root.render(h(Rows, { n: 2 }));
  await tick();
  const wnd = app.windows[0];
  wnd.width = 960;
  wnd.height = 540;
  wnd.emit('resize', { width: 960, height: 540, resized: true, moved: false });
  await tick();

  root.render(h(Rows, { n: 6 }));
  await tick();
  assert.strictEqual(wnd.height, 540);
  await root.unmount();
});

test('the echo of our own configure is not the user taking over', async () => {
  const app = createMockApp();
  const root = await createRoot({ app });
  root.render(h(Rows, { n: 2 }));
  await tick();
  const wnd = app.windows[0];
  // the server confirming the size we asked for
  wnd.emit('resize', { width: 100, height: 60, resized: true, moved: false });
  await tick();

  root.render(h(Rows, { n: 4 }));
  await tick();
  assert.strictEqual(wnd.height, 120, 'still tracking');
  await root.unmount();
});

test('handing the size back to auto starts it fitting again', async () => {
  const app = createMockApp();
  const root = await createRoot({ app });
  root.render(h(Rows, { n: 2, width: 500, height: 500 }));
  await tick();
  const wnd = app.windows[0];
  assert.strictEqual(wnd.height, 500);

  root.render(h(Rows, { n: 2 }));
  await tick();
  assert.strictEqual(wnd.height, 60, 'back to the content');
  await root.unmount();
});

test('a size query is answered against the size the window ends up', async () => {
  // The circular case: the block only applies below 600, and whether it does
  // decides how wide the content is. One extra look settles it.
  const { wnd, root } = await mount(
    h(
      'window',
      null,
      h(
        'box',
        {
          style: {
            flexDirection: 'row',
            '@width >= 600': { flexDirection: 'column' },
          },
        },
        box({ width: 120, height: 40 }, 'a'),
        box({ width: 120, height: 40 }, 'b'),
      ),
    ),
  );
  assert.strictEqual(wnd.width, 240, 'a row: 240 wide, which is under 600');
  assert.strictEqual(wnd.height, 40);
  await root.unmount();
});

test('an app changing one axis does not lock the other', async () => {
  // A one-axis configure comes back as a ConfigureNotify covering *both*, so
  // the record of what was asked for has to cover both too — otherwise the
  // app's own update reads as somebody else setting the size, and the auto
  // axis stops tracking on the first `width` change.
  //
  // The order is the point, and it is the real one: on a live connection the
  // configure goes out during the commit and the echo can land before the
  // frame that would have re-measured. So the echo is delivered here between
  // the render and the flush, not after both.
  const app = createMockApp();
  const root = await createRoot({ app });
  root.render(h(Rows, { n: 2, width: 300 }));
  await tick();
  const wnd = app.windows[0];
  assert.strictEqual(wnd.height, 60, 'the auto axis fitted its two rows');

  root.render(h(Rows, { n: 2, width: 420 }));
  wnd.width = 420;
  wnd.emit('resize', { width: 420, height: 60, resized: true, moved: false });
  await tick();

  root.render(h(Rows, { n: 5, width: 420 }));
  await tick();
  assert.strictEqual(wnd.width, 420, 'the width is still the app’s');
  assert.strictEqual(wnd.height, 150, 'and the height is still tracking');
  await root.unmount();
});

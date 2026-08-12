// A `<window>` bound the *content* decides: `minWidth="auto"` and friends.
//
// The floor is measured by laying the tree out with no room at all and
// reading how far it still reached — so what a node contributes is whatever
// its own style lets it shrink to, and a node that named a floor of its own
// (`minWidth: 0`, `overflow: 'scroll'`) contributes that instead of its
// content. That is the escape hatch Qt spells `QScrollArea` and GTK spells
// `min-content-width`, and most of what is asserted here is which side of it
// a node falls on.
//
// Headless, so there are no fonts and text measures 0x0 (see AGENTS.md): the
// content is sized boxes throughout, and the height-for-width case is built
// out of `flexWrap` rather than out of a wrapping paragraph.
import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import { createRoot } from '../src/index.js';
import { createMockApp } from './helpers/mock-app.js';
import { setScreensForTests } from '../src/screens.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function mount(element, { screens } = {}) {
  const app = createMockApp();
  if (screens !== undefined) setScreensForTests(app, screens);
  const root = await createRoot({ app });
  root.render(element);
  await tick();
  return { app, root, wnd: app.windows[0] };
}

const box = (style, key) => h('box', { key, style });

/** The hints the window was created with, or the last ones written to it. */
const hintsOf = (wnd) => {
  const sent = wnd.calls.filter(([name]) => name === 'setSizeHints');
  return sent.length ? sent[sent.length - 1][1] : wnd.attributes.sizeHints;
};

/** A window whose content is a row of rigid boxes, floored by that row. */
const rigidRow = (props, widths = [120, 90]) =>
  h(
    'window',
    { title: 'floor', minWidth: 'auto', ...props },
    h(
      'box',
      { style: { flexDirection: 'row' } },
      ...widths.map((w, i) => box({ width: w, height: 40 }, i)),
    ),
  );

// --- what the floor is ------------------------------------------------------

test('minWidth="auto" is the width the content cannot go below', async () => {
  const { wnd, root } = await mount(rigidRow());
  assert.strictEqual(hintsOf(wnd).minWidth, 210);
  await root.unmount();
});

test('the floor counts the padding and border around the content', async () => {
  const { wnd, root } = await mount(
    h(
      'window',
      { minWidth: 'auto', style: { padding: 10, borderWidth: 2 } },
      box({ width: 100, height: 20 }),
    ),
  );
  assert.strictEqual(hintsOf(wnd).minWidth, 124);
  await root.unmount();
});

test('a row that overflows both ways is still measured whole', async () => {
  // With less room than it needs, a centered row overflows to the left as
  // well as the right — CSS says so — and its first child's edge lands at a
  // negative offset. Read as a rightmost edge the floor would be half the
  // truth; read as a span it is the whole row.
  const { wnd, root } = await mount(
    h(
      'window',
      { minWidth: 'auto' },
      h(
        'box',
        { style: { flexDirection: 'row', justifyContent: 'center' } },
        box({ width: 120, height: 20 }, 'a'),
        box({ width: 120, height: 20 }, 'b'),
      ),
    ),
  );
  assert.strictEqual(hintsOf(wnd).minWidth, 240);
  await root.unmount();
});

test('the gap between items is part of the floor', async () => {
  const { wnd, root } = await mount(
    h(
      'window',
      { minWidth: 'auto' },
      h(
        'box',
        { style: { flexDirection: 'row', gap: 8 } },
        box({ width: 100, height: 20 }, 'a'),
        box({ width: 100, height: 20 }, 'b'),
      ),
    ),
  );
  assert.strictEqual(hintsOf(wnd).minWidth, 208);
  await root.unmount();
});

test('a column is floored by its widest row, not by their sum', async () => {
  const { wnd, root } = await mount(
    h(
      'window',
      { minWidth: 'auto' },
      box({ width: 100, height: 20 }, 'a'),
      box({ width: 300, height: 20 }, 'b'),
      box({ width: 80, height: 20 }, 'c'),
    ),
  );
  assert.strictEqual(hintsOf(wnd).minWidth, 300);
  await root.unmount();
});

// --- what does not floor it -------------------------------------------------

test('a scroll container contributes nothing to the floor', async () => {
  // The escape hatch, and it costs the author nothing to reach: `overflow:
  // 'scroll'` already resolves to `minWidth: 0, minHeight: 0`, so the pass
  // that measures the floor finds a pane that can give everything. What is
  // left is the rigid sidebar beside it.
  const { wnd, root } = await mount(
    h(
      'window',
      { minWidth: 'auto', width: 900, height: 400 },
      h(
        'box',
        { style: { flexDirection: 'row' } },
        box({ width: 160, height: 40, flexShrink: 0 }, 'sidebar'),
        h(
          'box',
          { key: 'pane', style: { overflow: 'scroll', flexGrow: 1 } },
          box({ width: 2000, height: 40 }, 'wide'),
        ),
      ),
    ),
  );
  assert.strictEqual(hintsOf(wnd).minWidth, 160);
  await root.unmount();
});

test('a box that says minWidth: 0 is taken at its word', async () => {
  const { wnd, root } = await mount(
    h(
      'window',
      { minWidth: 'auto', width: 600, height: 200 },
      h(
        'box',
        { style: { flexDirection: 'row' } },
        h(
          'box',
          { key: 'giving', style: { minWidth: 0 } },
          box({ width: 400, height: 20 }, 'inside'),
        ),
        box({ width: 100, height: 20 }, 'rigid'),
      ),
    ),
  );
  assert.strictEqual(hintsOf(wnd).minWidth, 100);
  await root.unmount();
});

test('flexShrink alone gives up no content (#249)', async () => {
  // The same tree with the escape hatch spelled the way it used to be. Back
  // when yoga's `flexShrink: 0` was the default, asking for `1` was a
  // statement — "this one can give" — and the floor read it as one. Every
  // node may shrink now, so it says nothing about how far, and the 400px
  // box inside still has to fit.
  const { wnd, root } = await mount(
    h(
      'window',
      { minWidth: 'auto', width: 600, height: 200 },
      h(
        'box',
        { style: { flexDirection: 'row' } },
        h(
          'box',
          { key: 'giving', style: { flexShrink: 1 } },
          box({ width: 400, height: 20 }, 'inside'),
        ),
        box({ width: 100, height: 20 }, 'rigid'),
      ),
    ),
  );
  assert.strictEqual(hintsOf(wnd).minWidth, 500);
  await root.unmount();
});

test('an absolutely positioned node does not floor its container', async () => {
  const { wnd, root } = await mount(
    h(
      'window',
      { minWidth: 'auto' },
      box({ width: 120, height: 20 }, 'flow'),
      box({ position: 'absolute', width: 900, height: 20 }, 'badge'),
    ),
  );
  assert.strictEqual(hintsOf(wnd).minWidth, 120);
  await root.unmount();
});

// --- the bounds around the bound --------------------------------------------

test('the floor is capped at the space the window can have', async () => {
  // A floor past the screen is a window that cannot be put on it.
  const { wnd, root } = await mount(
    h('window', { minWidth: 'auto' }, box({ width: 5000, height: 40 })),
    { screens: { monitors: [{ x: 0, y: 0, width: 1280, height: 800 }] } },
  );
  assert.strictEqual(hintsOf(wnd).minWidth, 1280);
  await root.unmount();
});

test('a floor never comes out above a maxWidth beside it', async () => {
  const { wnd, root } = await mount(
    h(
      'window',
      { minWidth: 'auto', maxWidth: 300 },
      box({ width: 800, height: 40 }),
    ),
  );
  const hints = hintsOf(wnd);
  assert.strictEqual(hints.minWidth, 300, 'clamped, not contradictory');
  assert.ok(hints.minWidth <= hints.maxWidth);
  await root.unmount();
});

test('maxWidth="auto" is the size the content wanted', async () => {
  // The other half of the pair: `'auto'` means "ask the content", and the
  // content's answer to *how big* is its natural size, not its minimum.
  const { wnd, root } = await mount(
    h(
      'window',
      { width: 400, height: 200, maxWidth: 'auto' },
      h(
        'box',
        { style: { flexDirection: 'row' } },
        box({ width: 260, height: 20, flexShrink: 1 }, 'a'),
        box({ width: 100, height: 20, flexShrink: 0 }, 'b'),
      ),
    ),
  );
  assert.strictEqual(hintsOf(wnd).maxWidth, 360, 'unshrunk, unwrapped');
  await root.unmount();
});

test('a rigid window pinned both ways is its natural size, once', async () => {
  // Where nothing can give, the minimum and the natural size are the same
  // number — which is what makes `minWidth="auto" maxWidth="auto"` the
  // fixed-size dialog on such a tree, the same thing `resizable={false}`
  // says a shorter way.
  const { wnd, root } = await mount(
    rigidRow({ maxWidth: 'auto', minWidth: 'auto' }),
  );
  const hints = hintsOf(wnd);
  assert.strictEqual(hints.minWidth, 210);
  assert.strictEqual(hints.maxWidth, 210);
  assert.strictEqual(wnd.width, 210, 'and the window opened there');
  await root.unmount();
});

test('minHeight="auto" is measured for the width the window has', async () => {
  // Height-for-width, and the reason the floor cannot be one number: three
  // 100-wide chips are one row at 320 and two rows at 250, so the height
  // the window must not go below depends on the width it is at.
  const chips = (width) =>
    h(
      'window',
      { width, minHeight: 'auto' },
      h(
        'box',
        { style: { flexDirection: 'row', flexWrap: 'wrap' } },
        box({ width: 100, height: 30 }, 'a'),
        box({ width: 100, height: 30 }, 'b'),
        box({ width: 100, height: 30 }, 'c'),
      ),
    );
  const wide = await mount(chips(320));
  assert.strictEqual(hintsOf(wide.wnd).minHeight, 30, 'one row at 320');
  await wide.root.unmount();

  const narrow = await mount(chips(250));
  assert.strictEqual(hintsOf(narrow.wnd).minHeight, 60, 'two rows at 250');
  await narrow.root.unmount();
});

// --- when it is written -----------------------------------------------------

test('the floor is in place before the window is mapped', async () => {
  // Same rule the natural size follows: the window manager reads
  // WM_NORMAL_HINTS when it frames the window, so a floor that arrives after
  // the map is a floor the frame was not built with.
  const { wnd, root } = await mount(rigidRow());
  assert.strictEqual(wnd.attributes.sizeHints.minWidth, 210, 'at CreateWindow');
  assert.deepStrictEqual(
    wnd.calls.filter(([name]) => name === 'setSizeHints'),
    [],
    'and not re-sent behind the map',
  );
  await root.unmount();
});

test("'auto' never reaches the wire", async () => {
  // It is a measurement, not a value: as a CARD32 it is 0, which is a floor
  // of nothing wearing the flag that says one was declared.
  const { wnd, root } = await mount(
    rigidRow({ minHeight: 'auto', maxWidth: 'auto', maxHeight: 'auto' }),
  );
  for (const [key, value] of Object.entries(hintsOf(wnd))) {
    assert.strictEqual(typeof value, 'number', `${key} is a number`);
  }
  await root.unmount();
});

function Rows({ n, ...props }) {
  return h(
    'window',
    { title: 'rows', minWidth: 'auto', minHeight: 'auto', ...props },
    ...Array.from({ length: n }, (_, i) =>
      box({ width: 100 + i * 10, height: 30 }, i),
    ),
  );
}

test('the floor follows the content', async () => {
  const app = createMockApp();
  const root = await createRoot({ app });
  root.render(h(Rows, { n: 2 }));
  await tick();
  const wnd = app.windows[0];
  assert.strictEqual(hintsOf(wnd).minHeight, 60);

  root.render(h(Rows, { n: 5 }));
  await tick();
  assert.strictEqual(hintsOf(wnd).minHeight, 150, 'three more rows');
  assert.strictEqual(hintsOf(wnd).minWidth, 140, 'and the widest of them');
  await root.unmount();
});

test('a floor that did not move is not sent again', async () => {
  // Measured every frame that lays out; written only when it changes. A
  // ChangeProperty per frame restating a number the window manager already
  // has is the cost this has to not have.
  const app = createMockApp();
  const root = await createRoot({ app });
  root.render(h(Rows, { n: 2 }));
  await tick();
  const wnd = app.windows[0];
  const before = wnd.calls.filter(([name]) => name === 'setSizeHints').length;

  root.render(h(Rows, { n: 2, title: 'renamed' }));
  await tick();
  wnd.flushFrame?.();
  await tick();
  assert.strictEqual(
    wnd.calls.filter(([name]) => name === 'setSizeHints').length,
    before,
  );
  await root.unmount();
});

test('the floor outlives the user taking the size over', async () => {
  // The size stops tracking once the user drags an edge; the floor is what
  // stops them dragging it too far, so it goes on being measured.
  const app = createMockApp();
  const root = await createRoot({ app });
  root.render(h(Rows, { n: 2 }));
  await tick();
  const wnd = app.windows[0];

  wnd.width = 400;
  wnd.height = 400;
  wnd.emit('resize', { width: 400, height: 400, resized: true, moved: false });
  await tick();

  root.render(h(Rows, { n: 6 }));
  await tick();
  assert.strictEqual(wnd.width, 400, 'the size the user chose stands');
  assert.strictEqual(hintsOf(wnd).minHeight, 180, 'the floor kept up');
  await root.unmount();
});

test('a window that never tracked its size still gets a floor', async () => {
  const app = createMockApp();
  const root = await createRoot({ app });
  root.render(h(Rows, { n: 2, width: 500, height: 500 }));
  await tick();
  const wnd = app.windows[0];
  assert.strictEqual(wnd.height, 500, 'the app said so');
  assert.strictEqual(hintsOf(wnd).minHeight, 60, 'the content said so');

  root.render(h(Rows, { n: 4, width: 500, height: 500 }));
  await tick();
  assert.strictEqual(hintsOf(wnd).minHeight, 120);
  await root.unmount();
});

test('handing a bound over to the content measures it', async () => {
  // A bound that becomes `'auto'` changes no layout by itself, so the commit
  // has to ask for the frame that resolves it.
  const app = createMockApp();
  const root = await createRoot({ app });
  root.render(h(Rows, { n: 3, minWidth: 40 }));
  await tick();
  const wnd = app.windows[0];
  assert.strictEqual(hintsOf(wnd).minWidth, 40);

  root.render(h(Rows, { n: 3, minWidth: 'auto' }));
  await tick();
  assert.strictEqual(hintsOf(wnd).minWidth, 120, 'measured from the content');

  root.render(h(Rows, { n: 3, minWidth: 40 }));
  await tick();
  assert.strictEqual(hintsOf(wnd).minWidth, 40, 'and handed back');
  await root.unmount();
});

test('the other hints survive a floor being re-sent', async () => {
  // `setSizeHints` writes the whole struct and carries nothing over, so a
  // floor sent on its own would drop the increment beside it.
  const app = createMockApp();
  const root = await createRoot({ app });
  root.render(h(Rows, { n: 2, widthInc: 8, gravity: 1 }));
  await tick();
  const wnd = app.windows[0];

  root.render(h(Rows, { n: 4, widthInc: 8, gravity: 1 }));
  await tick();
  const hints = hintsOf(wnd);
  assert.strictEqual(hints.minHeight, 120, 'the floor moved');
  assert.strictEqual(hints.widthInc, 8, 'and took the rest with it');
  assert.strictEqual(hints.gravity, 1);
  await root.unmount();
});

test('a bound that is neither a number nor auto says what to write', async () => {
  const app = createMockApp();
  const errors = [];
  const root = await createRoot({
    app,
    onUncaughtError: (e) => errors.push(e),
  });
  root.render(h('window', { minWidth: 'min-content' }));
  await tick();
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0].message, /minWidth=\{"min-content"\}/);
  assert.match(errors[0].message, /a number of pixels or 'auto'/);
  await root.unmount();
});

test('a window that pins itself re-pins at the size it grew to', async () => {
  // `resizable={false}` pins min and max to the size the window has when the
  // hints are written, so the same struct means a different thing once the
  // content has moved — the one hint that cannot be diffed on its keys.
  const app = createMockApp();
  const root = await createRoot({ app });
  root.render(h(Rows, { n: 2, resizable: false }));
  await tick();
  const wnd = app.windows[0];
  const pinnedAt = [];
  const record = () => {
    for (const [name, hints] of wnd.calls) {
      if (name === 'setSizeHints' && hints.resizable === false) {
        pinnedAt.push(wnd.height);
      }
    }
  };

  root.render(h(Rows, { n: 5, resizable: false }));
  await tick();
  wnd.flushFrame?.();
  await tick();
  record();
  assert.ok(pinnedAt.length > 0, 'the pin was re-sent after the window grew');
  await root.unmount();
});

test('a row of containers is floored by the sum of what they hold', async () => {
  // The pass that measures the floor offers nothing, so a container with no
  // size of its own comes out at nothing and the ones after it are packed
  // in behind it. Recovering what each holds without moving the rest along
  // would measure the two boxes below as if they overlapped.
  const { wnd, root } = await mount(
    h(
      'window',
      { minWidth: 'auto' },
      h(
        'box',
        { style: { flexDirection: 'row', gap: 10 } },
        h(
          'box',
          { key: 'a', style: { padding: 4 } },
          box({ width: 90, height: 20 }, 'inner'),
        ),
        h(
          'box',
          { key: 'b', style: { padding: 4 } },
          box({ width: 70, height: 20 }, 'inner'),
        ),
      ),
    ),
  );
  // (90 + 8) + 10 + (70 + 8)
  assert.strictEqual(hintsOf(wnd).minWidth, 186);
  await root.unmount();
});

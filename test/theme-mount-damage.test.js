// What the theme walk claims, on the two occasions it runs (issue #402).
//
// `insertBefore` restyles every freshly attached subtree — the nodes can see
// their ancestors now, so a `$token` that resolved provisionally resolves
// for real. That walk used to claim full-window damage for every node whose
// style mentions a token, which turned any commit that mounts one into a
// full repaint: a virtualized list whose rows follow the palette — exactly
// what docs/styling.md recommends — degraded every re-slice, and the scroll
// ledger above it (issue #398) never saw an eligible frame. A node that has
// never painted has no stale pixels, and the rect it is about to occupy is
// already claimed by the child-list/layout-diff protocol; so a mount now
// resolves without claiming, and these tests pin both halves: the commit
// stays bounded, and the tokens still resolve.
//
// A live theme *swap* is the other caller of the same walk and is the
// counter-case: it moves pixels that are already on screen, at any depth,
// so it keeps the unbounded claim. The last test is what keeps the mount
// flag from ever leaking into it.
import assert from 'node:assert';
import { test } from 'node:test';
import React from 'react';

import { createRoot } from '../src/index.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => {
  for (let i = 0; i < 6; i++) await tick();
};

const THEME = {
  panel: '#dbe4ee',
  accent: '#c03030',
};

const contains = (outer, inner) =>
  outer.x <= inner.x &&
  outer.y <= inner.y &&
  outer.x + outer.width >= inner.x + inner.width &&
  outer.y + outer.height >= inner.y + inner.height;

test('mounting a token-styled node keeps the commit bounded', async () => {
  const app = createMockApp({ width: 300, height: 200 });
  const x11Root = await createRoot({ app });
  const ref = React.createRef();
  let reveal;
  function App() {
    const [extra, set] = React.useState(false);
    reveal = set;
    return h(
      'window',
      { width: 300, height: 200, theme: THEME },
      // The pane the insert lands in is smaller than the window on purpose:
      // the child-list protocol claims the pane, so what would prove the
      // theme walk claimed nothing is the strip below staying out of the
      // damage. A pane that filled the window would make every claim look
      // unbounded.
      h(
        'box',
        { style: { height: 80, flexDirection: 'column' } },
        h('box', { style: { height: 40, backgroundColor: '#ffffff' } }),
        extra &&
          h('box', {
            ref,
            style: { height: 40, backgroundColor: '$panel' },
          }),
      ),
      h('box', { style: { flexGrow: 1, backgroundColor: '#f5f6fa' } }),
    );
  }
  await new Promise((resolve) => x11Root.render(h(App), resolve));
  await settle();
  const root = app.windows[0]._reactX11Node;

  reveal(true);
  await settle();

  // resolution is not what was traded away: the walk still ran, it just
  // claimed nothing
  assert.strictEqual(ref.current.style.backgroundColor, THEME.panel);
  assert.ok(
    root._lastDamage,
    'a commit that mounts a token-styled node repainted the window',
  );
  assert.ok(
    contains(root._lastDamage, ref.current.abs),
    `damage ${JSON.stringify(root._lastDamage)} misses the mounted node at ` +
      JSON.stringify(ref.current.abs),
  );
  assert.ok(
    root._lastDamage.y + root._lastDamage.height < 200,
    `damage ${JSON.stringify(root._lastDamage)} reaches the strip below ` +
      'the pane',
  );
  assert.ok(
    !root._lastReasons.includes('theme'),
    `a mount is not a theme change (reasons: ${root._lastReasons.join('+')})`,
  );

  await x11Root.unmount();
});

test('a live theme swap still repaints the window', async () => {
  const app = createMockApp({ width: 300, height: 200 });
  const x11Root = await createRoot({ app });
  const ref = React.createRef();
  const render = (theme) =>
    x11Root.render(
      h(
        'window',
        { width: 300, height: 200, theme },
        h('box', {
          ref,
          style: { flexGrow: 1, backgroundColor: '$panel' },
        }),
      ),
    );
  render(THEME);
  await settle();
  const root = app.windows[0]._reactX11Node;

  render({ ...THEME, panel: '#1e272e' });
  await settle();

  assert.strictEqual(ref.current.style.backgroundColor, '#1e272e');
  assert.strictEqual(
    root._lastDamage,
    null,
    'a swap moves pixels already on screen, at any depth — nothing narrower ' +
      'than the window is safe',
  );
  assert.ok(
    root._lastReasons.includes('theme'),
    `the frame knows why it ran (reasons: ${root._lastReasons.join('+')})`,
  );

  await x11Root.unmount();
});

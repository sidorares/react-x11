// The root window's event mask is shared bookkeeping. react-x11 selects
// PropertyChange on it to hear about `_NET_WORKAREA` (src/screens.js), and
// ntk adopts the same window for its own reasons — the shared-glyph
// directory watches for MANAGER announcements there, and simply *adopting* a
// window selects StructureNotify on it. X event masks are absolute per
// client, not additive, so whoever writes last wins outright unless every
// writer goes through one accumulator. ntk's Window is that accumulator (it
// caches per id and ORs into a tracked mask); a raw ChangeWindowAttributes
// is outside it, and is silently overwritten by the next adopter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import xserver from 'x11/lib/xserver/index.js';
import { createClient } from 'ntk';

import { createRoot } from '../src/index.js';
import { screensSnapshot } from '../src/screens.js';
import { renderX11, cleanup, settle, waitFor } from '../src/testing/index.js';

const h = React.createElement;

const PROPERTY_CHANGE = 1 << 22;
const SUBSTRUCTURE_REDIRECT = 1 << 20;
const CARDINAL = 6;

const rootMask = (app) =>
  new Promise((resolve, reject) => {
    // `your-event-mask`: what *this* connection selected, not the union
    app.X.GetWindowAttributes(app.X.display.screen[0].root, (err, attrs) =>
      err ? reject(err) : resolve(attrs.myEventMasks),
    );
  });

// The text matters: drawing a glyph is what brings ntk's shared-glyph client
// up, and that is what adopts the root.
const mountWithText = () =>
  renderX11(h('window', { width: 320, height: 240 }, h('text', null, 'hi')));

test('the work-area watch survives ntk adopting the root window', async (t) => {
  t.after(cleanup);
  const { app } = await mountWithText();
  await settle(app, 4);
  const mask = await rootMask(app);
  assert.ok(
    mask & PROPERTY_CHANGE,
    `root event mask is 0x${mask.toString(16)}: PropertyChange is not ` +
      'selected, so a panel appearing or resizing will never reach useScreens()',
  );
  // The other half of the same bug, and the half nothing else would notice:
  // an absolute write leaves ntk's accumulator believing a mask the server
  // does not hold, and nothing ever reconciles the two. Every later
  // `selectInput` on the root then ORs into a fiction.
  assert.strictEqual(
    app.rootWindow().eventMask,
    mask,
    "ntk's tracked mask for the root and the server's disagree",
  );
});

test('a _NET_WORKAREA change reaches the screen layout', async (t) => {
  t.after(cleanup);
  const { app } = await mountWithText();
  await settle(app, 4);

  // what a panel does when it reserves space along the top edge
  const X = app.X;
  const root = X.display.screen[0].root;
  const atom = await new Promise((resolve, reject) =>
    X.InternAtom(false, '_NET_WORKAREA', (err, a) =>
      err ? reject(err) : resolve(a),
    ),
  );
  const area = Buffer.alloc(16);
  for (const [i, v] of [0, 28, 900, 500].entries())
    area.writeUInt32LE(v, i * 4);
  X.ChangeProperty(0 /* Replace */, root, atom, CARDINAL, 32, area);

  await waitFor(() =>
    assert.deepStrictEqual(
      screensSnapshot(app).workArea,
      { x: 0, y: 28, width: 900, height: 500 },
      'the work area published by useScreens() did not follow the property',
    ),
  );
});

test('a window manager on this connection keeps its redirect', async (t) => {
  // The same collision from the other side. A client already holding
  // SubstructureRedirect on the root is a window manager, and an absolute
  // write over that mask stops MapRequest reaching it — it silently stops
  // managing windows. Neither bit is "the one that should win": the raw
  // write leaves ntk's accumulator holding a mask the server does not, and
  // from there the two ping-pong, so which of the two selections is alive
  // depends on who wrote last. Only holding both is correct.
  const server = xserver.createServer({ width: 800, height: 600 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  // system fonts, like `renderX11` above: this window paints, and an empty
  // font source has nothing for the first frame to measure with
  const app = await createClient({ stream: clientEnd });
  t.after(() => app.X.terminate());

  await app.rootWindow().selectInput(SUBSTRUCTURE_REDIRECT);
  const root = await createRoot({ app });
  t.after(() => root.unmount?.());
  await React.act(async () => {
    root.render(
      h('window', { width: 200, height: 100 }, h('text', null, 'hi')),
    );
  });
  await settle(app, 4);

  const mask = await rootMask(app);
  assert.ok(
    mask & SUBSTRUCTURE_REDIRECT,
    `root event mask is 0x${mask.toString(16)}: react-x11 wrote over the ` +
      'window manager’s SubstructureRedirect — MapRequest stops arriving',
  );
  assert.ok(
    mask & PROPERTY_CHANGE,
    `root event mask is 0x${mask.toString(16)}: the window manager's ` +
      'selection went over the work-area watch',
  );
  assert.strictEqual(
    app.rootWindow().eventMask,
    mask,
    "ntk's tracked mask for the root and the server's disagree",
  );
});

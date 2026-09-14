// The Wayland 2d context's glyph-run seam (src/wayland/context2d.js): the
// public trio a caller that positions its own glyphs draws through —
// `Render.PictOp`, `createSolidPicture` and `drawGlyphs`, ntk's documented
// contract, the same one the Cocoa backend answers
// (test/cocoa-glyph-runs.test.js). No compositor and no GPU: `drawTextRuns`
// is the seam directly under `drawGlyphs`, so the runs it is handed are what
// the frame would have carried.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { WaylandContext2D, parseColor } from '../../src/wayland/context2d.js';

/** A context with no GL behind it — nothing below `drawTextRuns` runs. */
function makeContext() {
  const ctx = new WaylandContext2D(null, {});
  const drawn = [];
  ctx.drawTextRuns = (runs) => drawn.push(...runs);
  return { ctx, drawn };
}

const FACE = { key: 'test-face' };
const run = (glyphs) => ({ font: FACE, size: 16, glyphs });
const one = () => [{ run: run([{ id: 1, ax: 8 }]), x: 0, y: 0 }];
const ink = (r) => [...parseColor(r.color)];

test('Render.PictOp and createSolidPicture are there, in XRender numbering', () => {
  const { ctx } = makeContext();
  assert.equal(typeof ctx.createSolidPicture, 'function');
  assert.equal(typeof ctx.drawGlyphs, 'function');
  assert.equal(ctx.Render.PictOp.Src, 1);
  assert.equal(ctx.Render.PictOp.Over, 3);
  assert.equal(
    ctx.window.app.display.Render,
    ctx.Render,
    'the table TextLayout.draw reads is the one a caller reads',
  );
});

test('createSolidPicture answers premultiplied ink, as XRender solids are', () => {
  const { ctx } = makeContext();
  assert.deepEqual(
    [...ctx.createSolidPicture(1, 0, 0, 1).color],
    [...parseColor('#ff0000')],
    'an opaque solid is the colour string spelled out',
  );
  assert.deepEqual(
    [...ctx.createSolidPicture(0.5, 0, 0, 0.5).color],
    [0.5, 0, 0, 0.5],
    'premultiplied in, premultiplied out — no round trip through straight',
  );
  assert.deepEqual(
    [...ctx.createSolidPicture(2, -1, 0, 5).color],
    [1, 0, 0, 1],
    'out of range in, in range out',
  );
  assert.deepEqual(
    [...ctx.createSolidPicture(1, 0, 0, 0.5).color],
    [0.5, 0, 0, 0.5],
    'a channel brighter than its alpha is not premultiplied; clamped to it',
  );
});

test('the documented spelling walks the pen and inks with the solid', () => {
  const { ctx, drawn } = makeContext();
  ctx.fillStyle = '#00ff00'; // not the ink: the source names it
  ctx.drawGlyphs(ctx.Render.PictOp.Over, ctx.createSolidPicture(0, 0, 1, 1), [
    {
      run: run([
        { id: 7, ax: 10 },
        { id: 8, ax: 10, dx: 2 },
      ]),
      x: 100,
      y: 50,
    },
  ]);
  assert.equal(drawn.length, 1);
  assert.equal(drawn[0].font, FACE);
  assert.equal(drawn[0].size, 16);
  assert.deepEqual(
    drawn[0].glyphs,
    [
      { id: 7, x: 100, y: 50 },
      { id: 8, x: 112, y: 50 },
    ],
    'the pen starts at x and each glyph inks at pen + dx, then advances',
  );
  assert.deepEqual(ink(drawn[0]), [0, 0, 1, 1], 'the solid, not the fillStyle');
});

test('the ink forms the Cocoa backend takes draw here too', () => {
  const { ctx, drawn } = makeContext();
  ctx.fillStyle = '#00ff00';
  ctx.drawGlyphs(3, '#ff0000', one());
  ctx.drawGlyphs(3, [0, 0, 1, 1], one());
  ctx.drawGlyphs(3, ctx._stylePicture('#ff0000'), one());
  ctx.drawGlyphs(3, null, one());
  assert.deepEqual(drawn.map(ink), [
    [1, 0, 0, 1], // a CSS colour
    [0, 0, 1, 1], // a premultiplied [r, g, b, a]
    [1, 0, 0, 1], // the stand-in TextLayout.draw builds
    [0, 1, 0, 1], // nothing: the fill style in force
  ]);
});

test('a source glyph runs cannot be painted with falls back to the fill style', () => {
  const { ctx, drawn } = makeContext();
  ctx.fillStyle = '#ff0000';
  ctx.drawGlyphs(3, ctx.createLinearGradient(0, 0, 10, 0), one());
  assert.deepEqual(drawn.map(ink), [[1, 0, 0, 1]]);
});

test('nothing to draw is not a throw', () => {
  const { ctx, drawn } = makeContext();
  const src = ctx.createSolidPicture(1, 1, 1, 1);
  ctx.drawGlyphs(3, src, []);
  ctx.drawGlyphs(3, src, undefined);
  ctx.drawGlyphs(3, src, [{ run: run([]), x: 0, y: 0 }]);
  ctx.drawGlyphs(3, src, [{ x: 0, y: 0 }]);
  assert.deepEqual(drawn, []);
});

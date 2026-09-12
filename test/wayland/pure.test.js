// The Wayland backend's pure pieces: colour and font parsing, damage
// merging, the decorations' geometry and hit-testing. No compositor, no GPU.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseColor, parseFont } from '../../src/wayland/context2d.js';
import { unionDamage } from '../../src/wayland/swapchain.js';
import {
  Decorations,
  TITLEBAR_HEIGHT,
  BORDER,
  RESIZE_MARGIN,
} from '../../src/wayland/decorations.js';
import { RESIZE_EDGE, TOPLEVEL_STATE } from '../../src/wayland/window.js';

const close = (a, b, eps = 1 / 255) => Math.abs(a - b) <= eps;

test('parseColor: hex, rgba, names, premultiplied', () => {
  assert.deepEqual([...parseColor('#ff0000')], [1, 0, 0, 1]);
  assert.deepEqual([...parseColor('#f00')], [1, 0, 0, 1]);
  const half = parseColor('#00ff0080');
  assert.ok(
    close(half[1], 128 / 255) && close(half[3], 128 / 255),
    'alpha premultiplies the channels',
  );
  assert.ok(close(half[0], 0));
  const rgba = parseColor('rgba(0, 0, 255, 0.5)');
  assert.ok(close(rgba[2], 0.5) && close(rgba[3], 0.5));
  assert.deepEqual([...parseColor('rgb(255 128 0)')], [1, 128 / 255, 0, 1]);
  assert.deepEqual([...parseColor('transparent')], [0, 0, 0, 0]);
  assert.deepEqual([...parseColor('white')], [1, 1, 1, 1]);
  assert.deepEqual(
    [...parseColor('nonsense')],
    [0, 0, 0, 1],
    'unknown colours are opaque black, not a throw',
  );
  assert.equal(
    parseColor('#abcdef'),
    parseColor('#abcdef'),
    'memoised: the same string is the same frozen array',
  );
});

test('parseFont: the CSS shorthand a UI writes', () => {
  assert.deepEqual(parseFont('16px sans-serif'), {
    italic: false,
    weight: 400,
    size: 16,
    family: 'sans-serif',
  });
  assert.deepEqual(parseFont('bold 14px "Inter", sans-serif'), {
    italic: false,
    weight: 700,
    size: 14,
    family: 'Inter',
  });
  assert.deepEqual(parseFont('italic 600 12.5px monospace'), {
    italic: true,
    weight: 600,
    size: 12.5,
    family: 'monospace',
  });
  assert.equal(parseFont('12pt serif').size, 16, 'points convert to pixels');
  assert.deepEqual(parseFont('garbage'), {
    italic: false,
    weight: 400,
    size: 16,
    family: 'sans-serif',
  });
});

test('unionDamage: all wins, null is nothing, sets stay small', () => {
  const r = (x) => ({ x, y: 0, width: 1, height: 1 });
  assert.equal(unionDamage('all', [r(1)]), 'all');
  assert.equal(unionDamage(null, null), null);
  assert.deepEqual(unionDamage(null, [r(1)]), [r(1)]);
  assert.deepEqual(unionDamage([r(1)], [r(2)]), [r(1), r(2)]);
  const many = Array.from({ length: 6 }, (_, i) => r(i));
  assert.equal(
    unionDamage(many, many),
    'all',
    'past a handful of rectangles the whole buffer is cheaper',
  );
});

test('decorations: insets, geometry and hit-testing', () => {
  const d = new Decorations();
  assert.deepEqual(d.insets(), {
    top: TITLEBAR_HEIGHT + BORDER,
    left: BORDER,
    right: BORDER,
    bottom: BORDER,
  });
  d.setState(new Set([TOPLEVEL_STATE.MAXIMIZED]));
  assert.equal(d.insets().left, 0, 'maximised windows drop the border');
  assert.equal(d.insets().top, TITLEBAR_HEIGHT);
  d.setState(new Set([TOPLEVEL_STATE.FULLSCREEN]));
  assert.deepEqual(
    d.insets(),
    { top: 0, left: 0, right: 0, bottom: 0 },
    'fullscreen has no frame at all',
  );
  d.setState(new Set([TOPLEVEL_STATE.ACTIVATED]));

  const W = 400;
  const H = 300;
  assert.deepEqual(d.hitTest(2, 2, W, H), {
    kind: 'resize',
    edges: RESIZE_EDGE.TOP_LEFT,
  });
  assert.deepEqual(d.hitTest(W - 2, H - 2, W, H), {
    kind: 'resize',
    edges: RESIZE_EDGE.BOTTOM_RIGHT,
  });
  assert.deepEqual(d.hitTest(200, 2, W, H), {
    kind: 'resize',
    edges: RESIZE_EDGE.TOP,
  });
  assert.deepEqual(d.hitTest(RESIZE_MARGIN + 30, 18, W, H), {
    kind: 'titlebar',
  });
  assert.deepEqual(d.hitTest(200, 150, W, H), { kind: 'content' });
  const close = d.hitTest(W - 20, 18, W, H);
  assert.equal(close.kind, 'button');
  assert.equal(close.id, 'close', 'the rightmost button closes');
  assert.equal(
    Decorations.cursorFor({ kind: 'resize', edges: RESIZE_EDGE.LEFT }),
    'ew-resize',
  );
  assert.equal(
    Decorations.cursorFor({ kind: 'resize', edges: RESIZE_EDGE.TOP_RIGHT }),
    'nesw-resize',
  );
  assert.equal(Decorations.cursorFor({ kind: 'titlebar' }), 'default');

  const off = new Decorations({ enabled: false });
  assert.deepEqual(off.insets(), { top: 0, left: 0, right: 0, bottom: 0 });
  assert.deepEqual(off.hitTest(1, 1, W, H), { kind: 'content' });
});

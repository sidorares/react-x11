// The grammar and the geometry behind `backgroundImage` and `boxShadow`
// (issue #345). Pure: no server, no node tree.
//
// Two of these assertions are here because a pixel test cannot make them.
// The gradient's *padding* — the stops pinned at 0 and 1 that stand in for
// `RepeatPad` — is invisible against node-x11's in-process server, whose
// RENDER clamps to the edge stops by construction where a real one leaves
// everything past the last stop transparent (sidorares/ntk#271). And the
// blur kernel's mapping from a CSS blur radius to a gaussian is a number
// that has to match a browser's, which no readback of ours can check.
import assert from 'node:assert';
import { test } from 'node:test';

import { DEFAULT_SHADOW_POLICY, shadowReach } from 'ntk';
import {
  blurKernel,
  linearGradientGeometry,
  parseBoxShadow,
  parseLinearGradient,
  shadowExtent,
} from '../src/decorations.js';

const BOX = { x: 0, y: 0, width: 100, height: 50 };
const line = (value, rect = BOX, pad) =>
  linearGradientGeometry(parseLinearGradient(value), rect, pad);
const near = (actual, expected, tolerance = 0.001) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${expected}, got ${actual}`,
  );

// --- direction -------------------------------------------------------------

test('no direction means to bottom, CSS’s default', () => {
  const spec = parseLinearGradient('linear-gradient(#000, #fff)');
  assert.equal(spec.angle, 180);
  const g = line('linear-gradient(#000, #fff)', BOX, 0);
  assert.deepEqual(
    [g.x0, g.y0, g.x1, g.y1].map(Math.round),
    [50, 0, 50, 50],
    'runs down the middle of the box, top to bottom',
  );
});

test('an angle is degrees clockwise from up', () => {
  const g = line('linear-gradient(90deg, #000, #fff)', BOX, 0);
  assert.deepEqual([g.x0, g.y0, g.x1, g.y1].map(Math.round), [0, 25, 100, 25]);
  const up = line('linear-gradient(0deg, #000, #fff)', BOX, 0);
  assert.deepEqual(
    [up.x0, up.y0, up.x1, up.y1].map(Math.round),
    [50, 50, 50, 0],
  );
});

test('turn, rad and grad are the same angle in other units', () => {
  assert.equal(
    parseLinearGradient('linear-gradient(0.25turn, #a, #b)').angle,
    90,
  );
  near(
    parseLinearGradient('linear-gradient(1.5708rad, #a, #b)').angle,
    90,
    0.01,
  );
  assert.equal(
    parseLinearGradient('linear-gradient(100grad, #a, #b)').angle,
    90,
  );
});

test('to top / right / bottom / left', () => {
  const angle = (side) =>
    parseLinearGradient(`linear-gradient(to ${side}, #a, #b)`).angle;
  assert.deepEqual(
    ['top', 'right', 'bottom', 'left'].map(angle),
    [0, 90, 180, 270],
  );
});

test('a corner keyword is resolved against the box, not fixed at 45°', () => {
  const spec = parseLinearGradient('linear-gradient(to top right, #a, #b)');
  assert.equal(spec.corner, 'top right');
  assert.equal(spec.angle, null, 'the angle needs the box to exist');
  // a square gives 45°; a wide box leans towards `to right`, which is what
  // makes the end colours land on the corners rather than near them
  const square = line('linear-gradient(to top right, #a, #b)', {
    x: 0,
    y: 0,
    width: 100,
    height: 100,
  });
  near(Math.atan2(square.x1 - square.x0, square.y0 - square.y1), Math.PI / 4);
  const wide = line('linear-gradient(to top right, #a, #b)', {
    x: 0,
    y: 0,
    width: 400,
    height: 20,
  });
  assert.ok(
    Math.atan2(wide.x1 - wide.x0, wide.y0 - wide.y1) > Math.PI / 4,
    'a wide box turns the line towards the horizontal',
  );
});

test('the gradient line is the box’s projection onto it', () => {
  // 90° over a 100x50 box: the line is the width. A diagonal is longer than
  // either side, which is the whole reason CSS defines it this way.
  const across = line('linear-gradient(90deg, #a, #b)', BOX, 0);
  near(Math.hypot(across.x1 - across.x0, across.y1 - across.y0), 100);
  const diagonal = line('linear-gradient(45deg, #a, #b)', BOX, 0);
  near(
    Math.hypot(diagonal.x1 - diagonal.x0, diagonal.y1 - diagonal.y0),
    (100 + 50) / Math.SQRT2,
  );
});

// --- stops -----------------------------------------------------------------

test('stops with no position are spread evenly between the ones that have one', () => {
  const g = line('linear-gradient(#a, #b, #c, #d)', BOX, 0);
  assert.deepEqual(
    g.stops.map(([offset]) => Number(offset.toFixed(4))),
    [0, 0.3333, 0.6667, 1],
  );
});

test('percentages and pixels both place a stop on the line', () => {
  const g = line('linear-gradient(180deg, #a, #b 25%, #c)', BOX, 0);
  assert.equal(g.stops[1][0], 0.25);
  // the line is the box height here, so 10px is a fifth of it
  const px = line('linear-gradient(180deg, #a, #b 10px, #c)', BOX, 0);
  near(px.stops[1][0], 0.2);
});

test('a stop that goes backwards is pulled up to the one before it', () => {
  // which is what keeps a hard colour break — two stops at one offset —
  // expressible, and what stops a typo inverting the ramp
  const g = line('linear-gradient(#a 60%, #b 20%, #c)', BOX, 0);
  assert.deepEqual(
    g.stops.map(([offset]) => offset),
    [0.6, 0.6, 1],
  );
});

test('a colour with spaces in it is one stop, not several', () => {
  const spec = parseLinearGradient(
    'linear-gradient(rgba(0, 0, 0, .4), rgb(255 255 255 / 50%) 80%)',
  );
  assert.deepEqual(
    spec.stops.map((s) => s.color),
    ['rgba(0, 0, 0, .4)', 'rgb(255 255 255 / 50%)'],
  );
  assert.deepEqual(spec.stops[1].position, { value: 80, unit: '%' });
});

// --- the pad that stands in for RepeatPad ---------------------------------

test('the line is extended past the box and the end colours pinned to it', () => {
  const g = line('linear-gradient(180deg, #a, #b)', BOX, 4);
  // 4px beyond each end of a 50px line
  near(g.y0, -4);
  near(g.y1, 54);
  assert.equal(g.stops.length, 4, 'two authored stops plus the two clamps');
  assert.deepEqual(g.stops[0], [0, '#a']);
  assert.deepEqual(g.stops[g.stops.length - 1], [1, '#b']);
  // and the authored stops sit where the box is, not where the line now ends
  near(g.stops[1][0], 4 / 58);
  near(g.stops[2][0], 54 / 58);
});

test('a box with no area has no gradient line', () => {
  assert.equal(
    line('linear-gradient(#a, #b)', { x: 0, y: 0, width: 0, height: 10 }),
    null,
  );
});

// --- what the grammar refuses ---------------------------------------------

test('an unusable backgroundImage names itself and the fix', () => {
  const bad = (value, expected) =>
    assert.throws(() => parseLinearGradient(value), expected, value);
  bad('radial-gradient(#a, #b)', /not supported.*linear-gradient/s);
  bad('url(bg.png)', /<image src>/);
  bad('linear-gradient(#a)', /at least two colour stops/);
  bad('linear-gradient(to nowhere, #a, #b)', /unusable direction/);
  bad('linear-gradient(#a, 40%, #b)', /colour hint/);
  bad('linear-gradient(#a, #b', /closing parenthesis/);
});

test('none and a missing value are simply no gradient', () => {
  assert.equal(parseLinearGradient('none'), null);
  assert.equal(parseLinearGradient(undefined), null);
});

// --- shadows ---------------------------------------------------------------

test('offsets, blur, spread and colour, in CSS order', () => {
  assert.deepEqual(parseBoxShadow('0 2px 8px rgba(0, 0, 0, .4)'), [
    { dx: 0, dy: 2, blur: 8, spread: 0, color: 'rgba(0, 0, 0, .4)' },
  ]);
  assert.deepEqual(parseBoxShadow('1px -2px 6px 3px #123'), [
    { dx: 1, dy: -2, blur: 6, spread: 3, color: '#123' },
  ]);
});

test('a colour may be left out, which is CSS’s currentColor', () => {
  assert.equal(parseBoxShadow('0 1px 2px')[0].color, null);
});

test('a list is a list, commas inside a colour and all', () => {
  const list = parseBoxShadow('0 1px 2px rgba(0, 0, 0, .2), 0 8px 24px #0006');
  assert.equal(list.length, 2);
  assert.equal(list[0].dy, 1);
  assert.equal(list[1].blur, 24);
});

test('an unusable boxShadow names itself and the fix', () => {
  assert.throws(() => parseBoxShadow('4px'), /needs an x and a y offset/);
  assert.throws(
    () => parseBoxShadow('0 0 4px #fff #000'),
    /more than one colour/,
  );
  assert.throws(() => parseBoxShadow('0 0 -4px #000'), /negative blur/);
  // rejected rather than quietly painted as an outer shadow, which is a bug
  // whose cause is invisible from the style
  assert.throws(() => parseBoxShadow('inset 0 2px 4px #000'), /inset/);
});

// --- the blur, and what it costs in damage --------------------------------

test('a CSS blur radius is twice the gaussian’s sigma', () => {
  assert.equal(blurKernel(8).sigma, 4);
  // The padding has to hold the kernel ntk will run, or the blur clips
  // square against the edge of the surface it was rendered into — and both
  // numbers come from ntk's `shadowReach` so they cannot drift apart.
  assert.ok(
    blurKernel(8).pad >= shadowReach(4),
    'the surface holds the whole kernel',
  );
});

test('a huge blur is capped rather than convolving forever', () => {
  // The cap is ntk's shadow policy (maxSigma), applied by `shadowSigma`:
  // past it the blur stops widening rather than becoming a kernel no frame
  // finishes. It is a sigma cap now, not a kernel-width one — the passes are
  // separable, so width costs 2k rather than k squared.
  assert.equal(blurKernel(4000).sigma, DEFAULT_SHADOW_POLICY.maxSigma);
  assert.ok(
    blurKernel(4000).pad <= shadowReach(DEFAULT_SHADOW_POLICY.maxSigma) + 1,
  );
});

test('the extent a shadow claims covers offset, spread and the blur’s tail', () => {
  assert.equal(shadowExtent(parseBoxShadow('0 0 0 #000')), 0);
  assert.equal(shadowExtent(parseBoxShadow('0 0 0 5px #000')), 5);
  // 4px down + 12px of blur reach
  assert.equal(
    shadowExtent(parseBoxShadow('0 4px 8px #000')),
    4 + blurKernel(8).pad,
  );
  // the largest of the list wins
  assert.equal(
    shadowExtent(parseBoxShadow('0 1px 1px #000, 0 20px 0 #000')),
    20,
  );
});

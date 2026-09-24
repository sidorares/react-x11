// The damage cap: a frame paints at most MAX_DAMAGE_RECTS rects, and the
// merges that keep it there decide how much of the window a frame repaints.
import { test } from 'node:test';
import assert from 'node:assert';

import {
  MAX_DAMAGE_RECTS,
  addDamageRect,
  addDamageRects,
} from '../src/nodes/damage.js';

const area = (rects) => rects.reduce((sum, r) => sum + r.width * r.height, 0);

const overlaps = (a, b) =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;

// A graph pane, 2156×1396 at 2x, panned left by four pixels inside a
// rounded box, with zoom controls bottom-left and a minimap bottom-right —
// the damage one frame of it claimed on react-x11 2.22 (issue #691).
const PANE = { x: 22, y: 22, width: 2156, height: 1396 };
const CLAIMS = [
  { x: 22, y: 22, width: 2156, height: 10 }, // the rows the top corners reach
  { x: 22, y: 1408, width: 2156, height: 10 }, // …and the bottom ones
  { x: 2174, y: 32, width: 4, height: 1376 }, // the strip the pan exposed
  { x: 1773, y: 1137, width: 386, height: 262 }, // the minimap, both places
  { x: 37, y: 1241, width: 58, height: 158 }, // the controls, both places
];

test('a merge the cap forces is priced by what it swallows (#691)', () => {
  // Priced by the box around the pair alone, the cheapest merge was the
  // controls with the bottom row — a box that overlapped the minimap and
  // the strip, swallowed both, and ended up the whole pane.
  let rects = null;
  for (const claim of CLAIMS) rects = addDamageRect(rects, claim);
  assert.ok(rects.length <= MAX_DAMAGE_RECTS);
  assert.ok(
    area(rects) < area([PANE]) * 0.25,
    `repaints ${area(rects)}px² of ${area([PANE])}`,
  );
  for (const claim of CLAIMS) {
    assert.ok(
      rects.some((r) => overlaps(r, claim)),
      `${JSON.stringify(claim)} is still claimed`,
    );
  }
});

test('the rects stay disjoint and cover every claim', () => {
  // disjoint, because a node inside two rects is painted twice — wrong for
  // anything translucent
  const rects = addDamageRects(null, CLAIMS);
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      assert.ok(!overlaps(rects[i], rects[j]), 'the list is disjoint');
    }
  }
  for (const claim of CLAIMS) {
    for (const [x, y] of [
      [claim.x, claim.y],
      [claim.x + claim.width - 1, claim.y + claim.height - 1],
    ]) {
      assert.ok(
        rects.some(
          (r) =>
            x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height,
        ),
        `${x},${y} of ${JSON.stringify(claim)} is covered`,
      );
    }
  }
});

test('small rects offered together merge with their neighbours first', () => {
  // A diagonal pan's pieces in a rounded 400×400 pane: the two strips, the
  // furniture in both bottom corners, and the four corners' repairs. One at
  // a time, each is squeezed under the cap as it arrives and the corners,
  // arriving last, joined boxes earlier merges had grown — half the pane.
  // Together, a third.
  const pieces = [
    { x: 40, y: 40, width: 400, height: 16 },
    { x: 428, y: 56, width: 12, height: 384 },
    { x: 40, y: 336, width: 48, height: 104 },
    { x: 300, y: 352, width: 128, height: 88 },
    { x: 40, y: 56, width: 8, height: 8 },
    { x: 420, y: 56, width: 8, height: 8 },
    { x: 40, y: 432, width: 8, height: 8 },
    { x: 420, y: 432, width: 8, height: 8 },
  ];
  let oneAtATime = null;
  for (const piece of pieces) oneAtATime = addDamageRect(oneAtATime, piece);
  const together = addDamageRects(null, pieces);
  assert.ok(together.length <= MAX_DAMAGE_RECTS);
  assert.ok(
    area(together) < 400 * 400 * 0.4,
    `repaints ${area(together)}px² of ${400 * 400}`,
  );
  assert.ok(area(together) < area(oneAtATime));
});

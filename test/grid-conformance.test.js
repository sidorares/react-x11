// The grid held to Chrome: a seeded corpus of grids that Chrome laid out once
// (scripts/grid-fixture.mjs), its rects checked in as
// test/fixtures/grid-chrome.json, and every case laid out here and compared
// item by item. Within a pixel, because Chrome lays a track out at a fraction
// of one and a grid here snaps its lines to whole ones (src/grid.js,
// `trackLines`). The grids hold boxes, never text, so the two engines agree
// on every content size; where they part ways anyway, KNOWN says why.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import React from 'react';

import { createRoot } from '../src/index.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const frame = () => tick().then(tick);

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/grid-chrome.json', import.meta.url), 'utf8'),
);

/**
 * The cases where this grid and Chrome part ways on purpose, with why. A
 * pixel of snapping can land either side of the width a row of chips wraps
 * at — Chrome lays a track out at a fraction of one — and a case where it
 * does belongs here too, with that for its reason.
 */
const KNOWN = new Map([
  [
    47,
    'an auto-placed item spanning more columns than the explicit grid has, ' +
      'in column flow: Chrome puts it after everything placed, where the ' +
      "spec's cursor — which this grid keeps to — finds it room across the " +
      "grid's edge",
  ],
]);

// CSS's keywords, as this renderer spells them
const SELF = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  stretch: 'stretch',
};
const CONTENT = {
  ...SELF,
  'space-between': 'space-between',
  'space-around': 'space-around',
  'space-evenly': 'space-evenly',
};

function styleOf(grid) {
  const style = {
    display: 'grid',
    columnGap: grid.columnGap ?? 0,
    rowGap: grid.rowGap ?? 0,
    flexShrink: 0,
  };
  if (grid.columns) style.gridTemplateColumns = grid.columns;
  if (grid.rows) style.gridTemplateRows = grid.rows;
  if (grid.autoRows) style.gridAutoRows = grid.autoRows;
  if (grid.autoFlow) style.gridAutoFlow = grid.autoFlow;
  if (grid.areas) style.gridTemplateAreas = grid.areas;
  if (grid.justifyItems) style.justifyItems = SELF[grid.justifyItems];
  if (grid.alignItems) style.alignItems = SELF[grid.alignItems];
  if (grid.justifyContent) style.justifyContent = CONTENT[grid.justifyContent];
  if (grid.alignContent) style.alignContent = CONTENT[grid.alignContent];
  if (grid.height != null) style.height = grid.height;
  return style;
}

function itemOf(spec, ref, key) {
  const style = {};
  if (spec.column != null) style.gridColumn = spec.column;
  if (spec.row != null) style.gridRow = spec.row;
  if (spec.area) style.gridArea = spec.area;
  if (spec.justifySelf) style.justifySelf = SELF[spec.justifySelf];
  if (spec.alignSelf) style.alignSelf = SELF[spec.alignSelf];
  const c = spec.content;
  let inside = null;
  if (c.type === 'fixed') {
    style.width = c.w;
    style.height = c.h;
  } else if (c.type === 'block') {
    inside = h('box', { style: { width: c.w, height: c.h, flexShrink: 0 } });
  } else {
    inside = h(
      'box',
      {
        style: {
          flexDirection: 'row',
          flexWrap: 'wrap',
          columnGap: 4,
          rowGap: 4,
        },
      },
      c.chips.map((w, k) =>
        h('box', { key: k, style: { width: w, height: 10, flexShrink: 0 } }),
      ),
    );
  }
  return h('box', { key, ref, style }, inside);
}

async function layOut(c) {
  const app = createMockApp();
  const root = await createRoot({ app });
  const box = React.createRef();
  const refs = c.items.map(() => React.createRef());
  root.render(
    h(
      'window',
      { width: c.width, height: 1200 },
      h(
        'box',
        { ref: box, style: styleOf(c.grid) },
        c.items.map((spec, i) => itemOf(spec, refs[i], i)),
      ),
    ),
  );
  await frame();
  const g = box.current.abs;
  const got = {
    size: [g.width, g.height],
    rects: refs.map((r) => {
      const a = r.current.abs;
      return [a.x - g.x, a.y - g.y, a.width, a.height];
    }),
  };
  root.unmount();
  return got;
}

const within = (a, b) => Math.abs(a - b) <= 1.01;

test('a corpus of grids lays out as Chrome laid it out, to the pixel', async () => {
  const wrong = [];
  for (const c of fixture.cases) {
    const got = await layOut(c);
    const diffs = [];
    if (!got.size.every((v, k) => within(v, c.size[k]))) {
      diffs.push(`size [${got.size}] where Chrome has [${c.size}]`);
    }
    c.rects.forEach((want, i) => {
      if (!got.rects[i].every((v, k) => within(v, want[k]))) {
        diffs.push(`item ${i} [${got.rects[i]}] where Chrome has [${want}]`);
      }
    });
    if (diffs.length > 0 && !KNOWN.has(c.id)) {
      wrong.push(`#${c.id} (${c.tags.join(' ')}): ${diffs.join('; ')}`);
    } else if (diffs.length === 0 && KNOWN.has(c.id)) {
      wrong.push(`#${c.id} matches Chrome now: take it off KNOWN`);
    }
  }
  assert.deepStrictEqual(
    wrong,
    [],
    `${wrong.length} of ${fixture.cases.length} grids differ from Chrome`,
  );
});

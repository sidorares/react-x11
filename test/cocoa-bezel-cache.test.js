// The native bezel cache across a desktop appearance change.
//
// A bezel's pixels depend on the desktop's accent, which is not one of the
// parameters `BezelStore.get` is keyed on: AppKit reads it for itself when
// it draws the cell. So after the user picked another accent, a bezel whose
// state happened to change came up in the new colour while the ones beside
// it — same key, cached — kept the old, until something else redrew them.
// The appearance change now forgets the cache before the repaint.
import assert from 'node:assert';
import { test } from 'node:test';

import { BezelStore } from '../src/cocoa/bezels.js';
import { appearanceChanged } from '../src/nodes.js';

/** The slice of the bridge the store touches, counting the cell renders. */
function fakeNative() {
  const native = {
    draws: 0,
    measureControl: () => ({ width: 20, height: 20 }),
    createSurface: (w, h) => ({ w, h }),
    drawControlIntoSurface() {
      native.draws++;
    },
    // every pixel inked, so the scan finds the whole frame
    ctxGetImageData: (surface, x, y, w, h) =>
      new Uint8Array(w * h * 4).fill(255),
  };
  return native;
}

test('a cleared store renders the bezel again; the geometry it measured stays', () => {
  const native = fakeNative();
  const store = new BezelStore(native);
  const params = { kind: 'checkbox', state: 1, appearance: 'dark' };
  const first = store.get(params, 20, 20, 2);
  // one render for the canonical scan, one for the bezel itself
  assert.equal(native.draws, 2);
  assert.equal(store.get(params, 20, 20, 2), first, 'cached by its key');
  assert.equal(native.draws, 2);

  store.clear();
  const again = store.get(params, 20, 20, 2);
  assert.notEqual(again, first, 'rendered afresh');
  assert.equal(native.draws, 3, 'and the scan was not repeated');
  assert.deepEqual(store.natural('checkbox'), { width: 44, height: 20 });
});

// The natural box is every inked pixel, shadow included; the title is placed
// against the solid body. So the rows that are only shadow are measured
// too, and a label can be padded off them.
test('the shadow rows under the body are measured apart from it', () => {
  const native = fakeNative();
  // a 20-row frame: row 0 a faint highlight, rows 1..17 solid, 18..19 shadow
  native.ctxGetImageData = (surface, x, y, w, h) => {
    const buf = new Uint8Array(w * h * 4);
    for (let row = 0; row < h; row++) {
      const alpha = row === 0 ? 40 : row >= h - 2 ? 60 : 255;
      for (let col = 0; col < w; col++) buf[(row * w + col) * 4 + 3] = alpha;
    }
    return buf;
  };
  native.measureControl = () => ({ width: 20, height: 10 });
  const store = new BezelStore(native);
  // scanned at 2×: one faint row and two shadow rows are 0.5pt and 1pt
  assert.deepEqual(store.shadow('push'), { top: 1, bottom: 1 });
  assert.deepEqual(store.natural('push'), { width: 44, height: 10 });
});

test('an appearance change forgets the bezels before it repaints', () => {
  let cleared = 0;
  const repainted = [];
  const node = {
    destroyed: false,
    _themeChanged: () => repainted.push('theme'),
    root: { invalidate: (full) => repainted.push(full ? 'full' : 'part') },
  };
  const app = {
    X: {},
    _rootChildren: [node],
    nativeBezels: { clear: () => cleared++ },
  };
  appearanceChanged(app);
  assert.equal(cleared, 1);
  assert.deepEqual(repainted, ['theme', 'full']);

  // a backend with no bezel store — X11, the mock — has nothing to forget
  appearanceChanged({ X: {}, _rootChildren: [node] });
  assert.equal(cleared, 1);
});

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

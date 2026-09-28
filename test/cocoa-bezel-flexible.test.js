// A push bezel taller than one line is AppKit's flexible push.
//
// A push bezel is one height: asked to fill a taller frame, AppKit draws its
// own 22pt bezel centred in it. A `<Button>` whose label wrapped is that
// frame (test/native-button-wrap.test.js), and a push bezel there left the
// first line of the label hanging over its top edge. So the store draws a
// push box taller than a push bezel as `flexiblePush` — the same button
// stretched to its frame — padded by *that* bezel's insets, which are not
// the push's; and a bridge that predates the kind keeps the push and says
// so once.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { BezelStore } from '../src/cocoa/bezels.js';
import { loadNative } from '../src/cocoa/native.js';

/**
 * A bridge with AppKit's geometry for the two push kinds, at 2x: a push
 * cell is 30x32pt and inks 22pt of it, 4.5pt down; a flexible push cell is
 * 23x27pt and inks everything but 2.5pt top and bottom, 2pt each side —
 * whatever the frame's height, since it stretches. A surface remembers what
 * was drawn into it; `kinds` is what the bridge knows.
 */
const KINDS = ['push', 'checkbox', 'radio', 'popup', 'slider', 'switch'];

function fakeNative({
  kinds = [...KINDS, 'flexiblePush'],
  worker = false,
} = {}) {
  const cells = {
    push: { width: 30, height: 32 },
    flexiblePush: { width: 23, height: 27 },
    checkbox: { width: 20, height: 20 },
    radio: { width: 20, height: 20 },
    popup: { width: 40, height: 26 },
    slider: { width: 100, height: 22 },
    switch: { width: 40, height: 22 },
  };
  const native = {
    draws: [],
    measureControl(params, cb) {
      if (!kinds.includes(params.kind)) throw new Error('unknown control kind');
      const size = { ...cells[params.kind] };
      if (!worker) return size;
      setImmediate(() => cb(size));
      return undefined;
    },
    createSurface: (w, h, scale) => ({ w, h, scale, drawn: null }),
    drawControlIntoSurface(surface, params, cb) {
      surface.drawn = params;
      native.draws.push({ surface, params });
      if (worker) setImmediate(cb);
    },
    ctxGetImageData(surface, x, y, w, h) {
      const buf = new Uint8Array(w * h * 4);
      const kind = surface.drawn?.kind;
      // device px of ink: the push keeps its 44 rows centred a pixel high,
      // as AppKit does (its shadow is under it), and the flexible push fills
      // its frame to within 5px of each edge
      const ink =
        kind === 'push'
          ? { x0: 12, x1: w - 12, y0: Math.floor((h - 44) / 2) - 1, y1: 0 }
          : { x0: 4, x1: w - 4, y0: 5, y1: h - 5 };
      if (kind === 'push') ink.y1 = ink.y0 + 44;
      for (let row = ink.y0; row < ink.y1; row++) {
        for (let col = ink.x0; col < ink.x1; col++) {
          buf[(row * w + col) * 4 + 3] = 255;
        }
      }
      return buf;
    },
  };
  return native;
}

/** The warnings `fn` printed. */
function warnings(fn) {
  const said = [];
  const warn = console.warn;
  console.warn = (...args) => said.push(args.join(' '));
  try {
    fn();
  } finally {
    console.warn = warn;
  }
  return said;
}

const drawnKind = (native, surface) =>
  native.draws.findLast((d) => d.surface === surface).params.kind;

test('one line tall, a push is a push', () => {
  const native = fakeNative();
  const store = new BezelStore(native);
  assert.equal(store.natural('push').height, 22);
  const bezel = store.get({ kind: 'push' }, 200, 44, 2);
  assert.equal(drawnKind(native, bezel.surface), 'push');
  // padded by the push's own insets, 4.5pt over the ink and 5.5 under it
  assert.equal(bezel.surface.h, 64);
  assert.equal(bezel.sy, 9);
});

test('taller, it is the flexible push, padded by its own insets', () => {
  const native = fakeNative();
  const store = new BezelStore(native);
  const bezel = store.get(
    { kind: 'push', isDefault: true, pressed: true, appearance: 'dark' },
    200,
    76,
    2,
  );
  const { params } = native.draws.findLast((d) => d.surface === bezel.surface);
  assert.equal(params.kind, 'flexiblePush');
  // every state goes with it: the accent, the press, the appearance
  assert.equal(params.isDefault, true);
  assert.equal(params.pressed, true);
  assert.equal(params.appearance, 'dark');
  // 38pt of box and 2.5pt either side: the blit region is the box exactly,
  // where the push's 4.5 and 5.5 would have cut the flexible bezel's ends off
  assert.equal(bezel.surface.h, 86);
  assert.deepEqual(
    { sx: bezel.sx, sy: bezel.sy, sw: bezel.sw, sh: bezel.sh },
    { sx: 4, sy: 5, sw: 200, sh: 76 },
  );
  // and it is cached by the kind it was drawn as, so the same box asks once
  const draws = native.draws.length;
  assert.equal(
    store.get(
      { kind: 'push', isDefault: true, pressed: true, appearance: 'dark' },
      200,
      76,
      2,
    ),
    bezel,
  );
  assert.equal(native.draws.length, draws);
});

test('only a push has a taller kind', () => {
  const native = fakeNative();
  const store = new BezelStore(native);
  const bezel = store.get({ kind: 'checkbox' }, 40, 76, 2);
  assert.equal(drawnKind(native, bezel.surface), 'checkbox');
});

test('a bridge without the flexible push keeps the push, and says so once', () => {
  const native = fakeNative({ kinds: KINDS });
  const store = new BezelStore(native);
  let bezel;
  const said = warnings(() => {
    bezel = store.get({ kind: 'push' }, 200, 76, 2);
    store.get({ kind: 'push', pressed: true }, 200, 76, 2);
    store.get({ kind: 'push' }, 200, 108, 2);
  });
  assert.equal(drawnKind(native, bezel.surface), 'push');
  assert.equal(said.length, 1, said.join('\n'));
  assert.match(said[0], /no 'flexiblePush' bezel/);
  assert.match(said[0], /Update @windowkit\/appkit/);
  // one line tall asks nothing of it, and warns about nothing
  const quiet = fakeNative({ kinds: KINDS });
  assert.deepEqual(
    warnings(() => new BezelStore(quiet).get({ kind: 'push' }, 200, 44, 2)),
    [],
  );
});

/** Resolves once `fn()` is truthy, polling the event loop. */
async function until(fn, what) {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`timed out waiting for ${what}`);
}

test('on a worker: prefetched with the rest, drawn later, its pressed twin too', async () => {
  const native = fakeNative({ worker: true });
  const store = new BezelStore(native, { answersLater: () => true });
  await store.prefetch(2);
  const scanned = new Set(
    native.draws.map((d) => `${d.params.kind}|${d.params.controlSize}`),
  );
  assert.ok(scanned.has('flexiblePush|regular'), [...scanned].join(', '));
  assert.ok(scanned.has('flexiblePush|small'));

  let ready = 0;
  assert.equal(
    store.get({ kind: 'push' }, 200, 76, 2, () => ready++),
    null,
  );
  await until(() => ready === 1, 'the bezel');
  const bezel = store.get({ kind: 'push' }, 200, 76, 2);
  assert.equal(drawnKind(native, bezel.surface), 'flexiblePush');
  // the twin the press will ask for is drawn as the same kind, under the
  // key the press asks with
  await until(
    () =>
      native.draws.some(
        (d) => d.params.kind === 'flexiblePush' && d.params.pressed === true,
      ),
    'the pressed twin',
  );
  // landed a tick after it was drawn, and found by the first ask — which
  // is the press's, and must not wait for a draw of its own
  await new Promise((resolve) => setImmediate(resolve));
  const drawn = native.draws.length;
  const pressed = store.get({ kind: 'push', pressed: true }, 200, 76, 2);
  assert.ok(pressed, 'the press finds its bezel');
  assert.equal(drawnKind(native, pressed.surface), 'flexiblePush');
  assert.equal(native.draws.length, drawn, 'nothing drawn for it');
});

test('on a worker, a bridge without it prefetches what it has', async () => {
  const native = fakeNative({ worker: true, kinds: KINDS });
  const store = new BezelStore(native, { answersLater: () => true });
  let said;
  await new Promise((resolve, reject) => {
    said = warnings(() => store.prefetch(2).then(resolve, reject));
  });
  assert.ok(
    native.draws.every((d) => d.params.kind !== 'flexiblePush'),
    'nothing asked of a kind the bridge refuses',
  );
  assert.equal(said.length, 1);
  let ready = 0;
  assert.equal(
    store.get({ kind: 'push' }, 200, 76, 2, () => ready++),
    null,
  );
  await until(() => ready === 1, 'the bezel');
  const bezel = store.get({ kind: 'push' }, 200, 76, 2);
  assert.equal(drawnKind(native, bezel.surface), 'push');
});

// --- over the real bridge -----------------------------------------------------

let bridge = null;
let flexible = false;
if (process.platform === 'darwin') {
  try {
    bridge = loadNative();
    bridge.measureControl({ kind: 'flexiblePush' });
    flexible = true;
  } catch {
    flexible = false;
  }
}

describe(
  'over the real bridge',
  {
    skip: !bridge
      ? 'the @windowkit/appkit bridge is not loadable here'
      : !flexible
        ? 'this @windowkit/appkit predates the flexible push'
        : false,
  },
  () => {
    /** The first and last rows of the blit region that carry ink. */
    function inkedRows(bezel) {
      const { surface, sx, sy, sw, sh } = bezel;
      const buf = bridge.ctxGetImageData(surface, sx, sy, sw, sh);
      let first = -1;
      let last = -1;
      for (let row = 0; row < sh; row++) {
        let inked = false;
        for (let col = 0; col < sw && !inked; col++) {
          inked = buf[(row * sw + col) * 4 + 3] > 8;
        }
        if (inked) {
          if (first < 0) first = row;
          last = row;
        }
      }
      return { first, last };
    }

    for (const controlSize of ['regular', 'small']) {
      test(`a ${controlSize} push two lines tall is inked to the box it was asked for`, () => {
        const store = new BezelStore(bridge);
        const one = store.natural('push', controlSize).height;
        // a box of two lines of 13px text, at 2x
        const h = (one + 16) * 2;
        const bezel = store.get({ kind: 'push', controlSize }, 240, h, 2);
        assert.deepEqual(inkedRows(bezel), { first: 0, last: h - 1 });
        // one line tall, the push fills its box the same way
        const line = store.get({ kind: 'push', controlSize }, 240, one * 2, 2);
        assert.deepEqual(inkedRows(line), { first: 0, last: one * 2 - 1 });
      });
    }
  },
);

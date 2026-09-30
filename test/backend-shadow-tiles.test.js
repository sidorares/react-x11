// Blurred shadows from tiles, on the Windows and macOS context
// (`BackendContext2D`, src/backend/shadowtiles.js).
//
// CoreGraphics blurs a shadow on every fill that has one set — a header's
// inset shadow was 130 to 380 ms of a scroll frame at 2x — and Direct2D
// draws none. A shadowed fill of a rect, a rounded rect, or a rect less a
// rounded rect filled evenodd is drawn instead from a tile made once, in
// nine pieces: these pin that the tile is made once whatever the shape's
// size and place, that the pieces cover the shadow once, that the shape is
// then filled with no shadow of its own, and that everything a tile cannot
// draw is left to the bridge exactly as before.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { planShadowTiles, rasterShadowTile } from 'ntk/shadow-tiles';

import { BackendContext2D } from '../src/backend/context2d.js';
import { ShadowTileCache } from '../src/backend/shadowtiles.js';
import { loadNative } from '../src/cocoa/native.js';

/** A bridge that records what the tile path asks of it, and no-ops the
 *  rest. Surfaces are objects with an id, and keep the pixels put in them. */
function recording() {
  const calls = [];
  const surfaces = [];
  let seq = 0;
  const verbs = {
    createSurface: (width, height) => {
      calls.push(['createSurface', width, height]);
      const made = { id: ++seq, width, height };
      surfaces.push(made);
      return made;
    },
    releaseSurface: (s) => calls.push(['releaseSurface', s.id]),
    ctxPutImageData: (s, buf, w, h) => {
      s.pixels = Uint8Array.from(buf);
      calls.push(['putImageData', s.id, w, h]);
    },
    ctxDrawSurface: (dst, src, ...rect) =>
      calls.push(['drawSurface', src.id, ...rect]),
    ctxSetShadow: (s, blur) => calls.push(['setShadow', blur]),
    ctxSave: () => calls.push(['save']),
    ctxRestore: () => calls.push(['restore']),
    ctxFill: (s, evenodd) => calls.push(['fill', evenodd]),
    ctxFillRect: () => calls.push(['fillRect']),
  };
  const native = new Proxy(verbs, {
    get: (t, k) => (k in t ? t[k] : () => undefined),
  });
  const surface = { window: true };
  const ctx = new BackendContext2D(
    native,
    () => surface,
    () => 1,
  );
  ctx.lineWidth = 1; // the first call on a fresh surface syncs its state
  calls.length = 0;
  const of = (name) => calls.filter((c) => c[0] === name);
  return { ctx, calls, of, native, surfaces };
}

/** A shadow set as `<Html>` and `<box>` set one. */
function shadow(ctx, blur = 20, color = 'rgba(0, 0, 0, 0.5)') {
  ctx.shadowColor = color;
  ctx.shadowBlur = blur;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  ctx.fillStyle = '#ffffff';
}

/** Every piece's destination, `[x, y, w, h]`. */
const drawn = (of) => of('drawSurface').map((c) => c.slice(6, 10));

/** How many pieces cover each pixel of `box`, as a map of count to area. */
function coverage(pieces, box) {
  const counts = new Map();
  for (let y = box.y; y < box.y + box.height; y++) {
    for (let x = box.x; x < box.x + box.width; x++) {
      let n = 0;
      for (const [px, py, pw, ph] of pieces) {
        if (x >= px && x < px + pw && y >= py && y < py + ph) n++;
      }
      counts.set(n, (counts.get(n) ?? 0) + 1);
    }
  }
  return counts;
}

describe('a shadowed fill of a shape a tile draws', () => {
  test('makes the tile once, whatever the size and place of the shape', () => {
    const { ctx, of } = recording();
    shadow(ctx);
    ctx.beginPath();
    ctx.roundRect(10, 10, 300, 200, 12);
    ctx.fill();
    assert.equal(of('createSurface').length, 1, 'one tile');
    assert.equal(of('putImageData').length, 1, 'its pixels, once');
    assert.equal(of('drawSurface').length, 9, 'nine pieces');

    ctx.beginPath();
    ctx.roundRect(400, 60, 900, 100, 12);
    ctx.fill();
    ctx.fillStyle = '#eeeeee';
    ctx.beginPath();
    ctx.roundRect(-50, 700, 120, 3000, 12);
    ctx.fill();
    assert.equal(of('createSurface').length, 1, 'the same tile for all three');
    assert.equal(of('drawSurface').length, 27);

    // one too short to have a straight part on an axis — twice the blur's
    // reach and its corners — is its own tile on that axis
    ctx.beginPath();
    ctx.roundRect(0, 0, 400, 40, 12);
    ctx.fill();
    assert.equal(of('createSurface').length, 2);
  });

  test('covers the shadow once: the shape and the blur past it', () => {
    const { ctx, of } = recording();
    shadow(ctx, 20);
    ctx.shadowOffsetY = 4;
    ctx.beginPath();
    ctx.roundRect(40, 30, 160, 90, 10);
    ctx.fill();
    // σ 10, made at half size: three σ of the half-size tile, doubled
    const reach = 30;
    const box = {
      x: 40 - reach,
      y: 34 - reach,
      width: 160 + 2 * reach,
      height: 90 + 2 * reach,
    };
    const counts = coverage(drawn(of), box);
    assert.deepEqual(
      [...counts.keys()],
      [1],
      'every pixel of the reach is drawn, and drawn once',
    );
    for (const [x, y, w, h] of drawn(of)) {
      assert.ok(
        x >= box.x &&
          y >= box.y &&
          x + w <= box.x + box.width &&
          y + h <= box.y + box.height,
        `a piece at ${[x, y, w, h]} inside the reach`,
      );
    }
  });

  test('then fills the shape itself with no shadow of its own', () => {
    const { ctx, calls } = recording();
    shadow(ctx);
    ctx.beginPath();
    ctx.rect(10, 10, 100, 60);
    ctx.fill();
    const names = calls.map((c) => c[0]);
    const fill = names.lastIndexOf('fill');
    const lastPiece = names.lastIndexOf('drawSurface');
    assert.ok(lastPiece < fill, 'the shadow under the shape');
    const cleared = calls.findLastIndex(
      (c, i) => i < fill && c[0] === 'setShadow',
    );
    assert.equal(calls[cleared][1], 0, 'the shape fills with the shadow off');
    assert.equal(names[cleared - 1], 'save', 'saved before it is cleared');
    assert.equal(names[fill + 1], 'restore', 'and put back after the fill');
  });

  test('fillRect is one', () => {
    const { ctx, of } = recording();
    shadow(ctx);
    ctx.fillRect(10, 10, 100, 60);
    assert.equal(of('createSurface').length, 1);
    assert.ok(of('drawSurface').length > 0);
    assert.equal(of('fillRect').length, 1);
  });

  test('a rect less a rounded rect, filled evenodd, is an inset shadow: its middle is not drawn', () => {
    const { ctx, of } = recording();
    shadow(ctx, 20);
    ctx.beginPath();
    ctx.rect(0, 0, 500, 400);
    ctx.roundRect(40, 40, 420, 320, 10);
    ctx.fill('evenodd');
    assert.equal(of('createSurface').length, 1);
    assert.equal(of('drawSurface').length, 8, 'no middle piece');
    // Deep in the hole — further in than the blur reaches past its edges
    // and corners, and a tile pixel more — the frame casts nothing, and no
    // piece is drawn there.
    const deep = 30 + 10 + 4;
    const counts = coverage(drawn(of), {
      x: 40 + deep,
      y: 40 + deep,
      width: 420 - 2 * deep,
      height: 320 - 2 * deep,
    });
    assert.deepEqual([...counts.keys()], [0]);
  });

  test('a tile is the same for the same corners and blur, and different in another colour', () => {
    const { ctx, of } = recording();
    shadow(ctx, 20, 'rgba(0, 0, 0, 0.5)');
    ctx.fillRect(0, 0, 200, 100);
    shadow(ctx, 20, 'rgba(0, 0, 255, 0.5)');
    ctx.fillRect(0, 0, 200, 100);
    shadow(ctx, 30, 'rgba(0, 0, 255, 0.5)');
    ctx.fillRect(0, 0, 200, 100);
    assert.equal(of('createSurface').length, 3, 'one per colour and blur');
  });

  test('a clip it misses draws none of it, and the shape is still filled', () => {
    const { ctx, of } = recording();
    shadow(ctx);
    ctx.save();
    ctx.beginPath();
    ctx.rect(1000, 1000, 10, 10);
    ctx.clip();
    ctx.fillRect(0, 0, 100, 100);
    ctx.restore();
    assert.equal(of('drawSurface').length, 0);
    assert.equal(of('createSurface').length, 0, 'nor is a tile made for it');
    assert.equal(of('fillRect').length, 1);
  });

  test('a clip draws only the pieces it meets: a scroll strip is a strip of the shadow', () => {
    const { ctx, of } = recording();
    shadow(ctx, 40);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 300, 2000, 40);
    ctx.clip();
    ctx.fillRect(100, 100, 1600, 600);
    ctx.restore();
    const pieces = drawn(of);
    assert.equal(
      pieces.length,
      3,
      'the left edge, the stretched middle, the right edge',
    );
    for (const [, y, , h] of pieces) {
      assert.ok(y < 340 && y + h > 300, 'each one meets the strip');
    }
  });
});

describe('what a tile does not draw is left to the bridge', () => {
  /** the shadow went to the bridge: no tile, and the fill with it set */
  const live = ({ of, calls }) => {
    assert.equal(of('createSurface').length, 0, 'no tile');
    assert.equal(of('drawSurface').length, 0);
    const fill = calls.findLastIndex(
      (c) => c[0] === 'fill' || c[0] === 'fillRect',
    );
    const last = calls.findLastIndex(
      (c, i) => i < fill && c[0] === 'setShadow',
    );
    assert.notEqual(calls[last]?.[1], 0, 'filled with its shadow');
  };

  test('two shapes filled nonzero: their union, not a frame', () => {
    const r = recording();
    shadow(r.ctx);
    r.ctx.beginPath();
    r.ctx.rect(0, 0, 100, 100);
    r.ctx.roundRect(10, 10, 50, 50, 5);
    r.ctx.fill();
    live(r);
  });

  test('two shapes neither of which holds the other', () => {
    const r = recording();
    shadow(r.ctx);
    r.ctx.beginPath();
    r.ctx.rect(0, 0, 100, 100);
    r.ctx.rect(50, 50, 100, 100);
    r.ctx.fill('evenodd');
    live(r);
  });

  test('a path of lines and curves', () => {
    const r = recording();
    shadow(r.ctx);
    r.ctx.beginPath();
    r.ctx.moveTo(0, 0);
    r.ctx.lineTo(100, 0);
    r.ctx.lineTo(50, 80);
    r.ctx.closePath();
    r.ctx.fill();
    live(r);
  });

  test('a transform that rotates', () => {
    const r = recording();
    shadow(r.ctx);
    r.ctx.rotate(0.1);
    r.ctx.fillRect(10, 10, 100, 60);
    live(r);
  });

  test('a composite that is not source-over', () => {
    const r = recording();
    shadow(r.ctx);
    r.ctx._state.gco = 'multiply';
    r.ctx.fillRect(10, 10, 100, 60);
    live(r);
  });

  test('the switch off', () => {
    const r = recording();
    r.ctx._shadowTiles = false;
    shadow(r.ctx);
    r.ctx.fillRect(10, 10, 100, 60);
    live(r);
  });

  test('a bridge that makes no surface', () => {
    const r = recording();
    r.native.createSurface = () => undefined;
    shadow(r.ctx);
    r.ctx.fillRect(10, 10, 100, 60);
    assert.equal(r.of('drawSurface').length, 0);
  });
});

test('a scaled transform draws the tile in device pixels, where the shadow is', () => {
  const { ctx, of } = recording();
  shadow(ctx, 20);
  ctx.scale(2, 2);
  ctx.translate(5, 5);
  ctx.fillRect(10, 10, 100, 60);
  // the shape is (30, 30) to (230, 150) on the surface; the pieces are
  // handed over in the context's own units, so undo the transform
  const device = drawn(of).map(([x, y, w, h]) => [
    2 * x + 10,
    2 * y + 10,
    2 * w,
    2 * h,
  ]);
  const left = Math.min(...device.map((p) => p[0]));
  const right = Math.max(...device.map((p) => p[0] + p[2]));
  assert.equal(left, 30 - 30, 'the reach left of the shape, unscaled');
  assert.equal(right, 230 + 30);
});

test('the tile cache lets the least recently drawn tile go past its budget', () => {
  const { native, of } = recording();
  const plan = (w) =>
    planShadowTiles(
      {
        x0: 0,
        y0: 0,
        x1: w,
        y1: 20,
        corners: [0, 0, 0, 0].map(() => ({ x: 0, y: 0 })),
      },
      null,
      8,
    );
  // too narrow to stretch, so each width is a tile of its own
  const one = plan(12);
  const cache = new ShadowTileCache(native, one.width * one.height * 4 * 2);
  const a = cache.get(plan(10), [0, 0, 0, 1]);
  cache.get(plan(11), [0, 0, 0, 1]);
  cache.get(plan(10), [0, 0, 0, 1]); // a is recent again
  cache.get(plan(12), [0, 0, 0, 1]);
  const released = of('releaseSurface').map((c) => c[1]);
  assert.equal(released.length, 1);
  assert.notEqual(released[0], a.id, 'not the one drawn last but one');
});

test('the tile is the shadow in its colour: full inside the shape, nothing at the reach', () => {
  const { ctx, of, surfaces } = recording();
  shadow(ctx, 12, 'rgba(255, 0, 0, 0.5)');
  ctx.fillRect(20, 20, 200, 100);
  assert.equal(of('createSurface').length, 1);
  const tile = surfaces[0];
  const at = (x, y) => [
    ...tile.pixels.subarray(
      (y * tile.width + x) * 4,
      (y * tile.width + x) * 4 + 4,
    ),
  ];
  const middle = at(tile.width >> 1, tile.height >> 1);
  assert.deepEqual(
    middle.slice(0, 3),
    [255, 0, 0],
    'straight RGBA, in the colour',
  );
  assert.ok(
    Math.abs(middle[3] - 128) <= 1,
    `half strength in the middle, was ${middle[3]}`,
  );
  assert.equal(at(0, 0)[3], 0, 'nothing where the blur runs out');
});

// --- over the real bridge -----------------------------------------------------

let bridge = null;
if (process.platform === 'darwin') {
  try {
    bridge = loadNative();
  } catch {
    bridge = null;
  }
}

describe(
  'over the real bridge',
  {
    skip: !bridge ? 'the @windowkit/appkit bridge is not loadable here' : false,
  },
  () => {
    /** a surface, its context, and its alpha channel read back */
    const surface = (w, h) => {
      const handle = bridge.createSurface(w, h, 1);
      const ctx = new BackendContext2D(
        bridge,
        () => handle,
        () => 0,
      );
      const alpha = () => {
        const rgba = bridge.ctxGetImageData(handle, 0, 0, w, h);
        const out = new Uint8Array(w * h);
        for (let i = 0; i < out.length; i++) out[i] = rgba[i * 4 + 3];
        return out;
      };
      return { ctx, alpha };
    };

    /** the whole shadow at full resolution, no tile and no stretch */
    const exact = (w, h, outer, inner, blur) => {
      const sigma = blur / 2;
      const reach = Math.ceil(3 * sigma);
      const pad = (r) => ({
        ...r,
        x0: r.x0 + reach,
        y0: r.y0 + reach,
        x1: r.x1 + reach,
        y1: r.y1 + reach,
      });
      const W = w + 2 * reach;
      const H = h + 2 * reach;
      const plan = {
        width: W,
        height: H,
        sigma,
        reach,
        shape: { outer: pad(outer), inner: inner && pad(inner) },
      };
      const rgba = rasterShadowTile(plan, [0, 0, 0, 1]);
      const out = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          out[y * w + x] = rgba[((y + reach) * W + x + reach) * 4 + 3];
        }
      }
      return out;
    };

    const corners = (r) => [0, 0, 0, 0].map(() => ({ x: r, y: r }));
    const cases = [
      [
        'a rounded rect, blur 12',
        { x0: 80, y0: 60, x1: 380, y1: 260, corners: corners(16) },
        null,
        12,
      ],
      [
        'a rounded rect, blur 40, made at half size',
        { x0: 120, y0: 90, x1: 380, y1: 250, corners: corners(16) },
        null,
        40,
      ],
      [
        'an inset frame, blur 30',
        { x0: 20, y0: 20, x1: 440, y1: 300 - 20, corners: corners(0) },
        { x0: 66, y0: 66, x1: 394, y1: 234, corners: corners(12) },
        30,
      ],
    ];
    for (const [name, outer, inner, blur] of cases) {
      test(`${name}: within a few levels of the exact shadow`, () => {
        const W = 460;
        const H = 320;
        const { ctx, alpha } = surface(W, H);
        // the shadow alone, the shape thrown clear of the surface
        const away = 10000;
        ctx.shadowColor = '#000000';
        ctx.shadowBlur = blur;
        ctx.shadowOffsetX = away;
        ctx.fillStyle = '#000000';
        ctx.beginPath();
        ctx.roundRect(
          outer.x0 - away,
          outer.y0,
          outer.x1 - outer.x0,
          outer.y1 - outer.y0,
          outer.corners[0].x,
        );
        if (inner) {
          ctx.roundRect(
            inner.x0 - away,
            inner.y0,
            inner.x1 - inner.x0,
            inner.y1 - inner.y0,
            inner.corners[0].x,
          );
        }
        ctx.fill(inner ? 'evenodd' : 'nonzero');
        const got = alpha();
        const want = exact(W, H, outer, inner, blur);
        let worst = 0;
        for (let i = 0; i < got.length; i++) {
          worst = Math.max(worst, Math.abs(got[i] - want[i]));
        }
        assert.ok(worst <= 6, `off by at most 6 levels of 255, was ${worst}`);
      });
    }
  },
);

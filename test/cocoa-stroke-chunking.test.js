// `CGContextStrokePath` is quadratic in the number of subpaths in the path
// it is handed (issue #456): two thousand 13-vertex rings at a 2px line
// cost 202ms in one call where five hundred cost 20ms. The Cocoa context
// splits such a stroke into several calls, and this is what that split
// promises — the same geometry, in the same order, cut only where a
// subpath starts, and only where the split cannot change what lands.
//
// Two layers, as elsewhere in the Cocoa tests. The first runs everywhere:
// a fake bridge records what reaches the natives, which is the whole of
// what the JS decides. The second runs where @windowkit/appkit loads and
// ends in pixels.
import assert from 'node:assert';
import { describe, test } from 'node:test';

import { CocoaContext2D } from '../src/cocoa/context2d.js';
import { loadNative } from '../src/cocoa/native.js';

/** a bridge that records the path and paint calls, and no-ops the rest */
function fakeNative() {
  const calls = [];
  const native = {
    calls,
    ctxBeginPath: () => calls.push(['begin']),
    ctxMoveTo: (s, x, y) => calls.push(['M', x, y]),
    ctxLineTo: (s, x, y) => calls.push(['L', x, y]),
    ctxRect: (s, x, y, w, h) => calls.push(['rect', x, y, w, h]),
    ctxArc: (s, x, y, r, a0, a1, ccw) =>
      calls.push(['arc', x, y, r, a0, a1, ccw]),
    ctxEllipse: (s, x, y, rx, ry) => calls.push(['ellipse', x, y, rx, ry]),
    ctxRoundRect: (s, ...a) => calls.push(['round', ...a]),
    ctxCurveTo: (s, ...a) => calls.push(['C', ...a]),
    ctxQuadTo: (s, ...a) => calls.push(['Q', ...a]),
    ctxClosePath: () => calls.push(['Z']),
    ctxStroke: () => calls.push(['stroke']),
    ctxFill: (s, eo) => calls.push(['fill', !!eo]),
    ctxClip: () => calls.push(['clip']),
  };
  return new Proxy(native, {
    get: (t, k) => (k in t ? t[k] : () => undefined),
  });
}

function context() {
  const native = fakeNative();
  const surface = { fake: true };
  const ctx = new CocoaContext2D(
    native,
    () => surface,
    () => 1,
  );
  ctx.lineWidth = 2; // above the hairline, so chunking is on the table
  native.calls.length = 0;
  return { ctx, native };
}

/** `count` closed rings of `verts` points each, drawn into `ctx` */
function rings(ctx, count, verts) {
  ctx.beginPath();
  for (let i = 0; i < count; i++) {
    ctx.moveTo(i, 0);
    for (let v = 1; v < verts; v++) ctx.lineTo(i + v, v);
    ctx.closePath();
  }
}

const strokes = (calls) => calls.filter((c) => c[0] === 'stroke').length;
/** the path calls of the nth stroke, the `begin` that opened it dropped */
function chunk(calls, n) {
  const out = [];
  let seen = 0;
  let current = [];
  for (const call of calls) {
    if (call[0] === 'begin') current = [];
    else if (call[0] === 'stroke') {
      if (seen++ === n) return current;
    } else current.push(call);
  }
  return out;
}
// the path calls, in order, as one string — a mismatch prints a diff a
// person can read rather than six thousand tuples
const PAINT = new Set(['begin', 'stroke', 'fill', 'clip']);
const geometry = (calls) =>
  calls
    .filter((c) => !PAINT.has(c[0]))
    .map((c) => c.join(' '))
    .join('|');
const geometryCount = (calls) => calls.filter((c) => !PAINT.has(c[0])).length;

// --- what gets split ----------------------------------------------------------

test('a path small enough is one stroke, and nothing is replayed', () => {
  const { ctx, native } = context();
  rings(ctx, 20, 13); // 260 points, 20 subpaths — under both budgets
  ctx.stroke();
  assert.equal(strokes(native.calls), 1);
  assert.equal(native.calls.filter((c) => c[0] === 'begin').length, 1);
});

test('thousands of subpaths go out in chunks, each opened by its own moveTo', () => {
  const { ctx, native } = context();
  rings(ctx, 2000, 13); // 26,000 points
  const built = geometryCount(native.calls);
  native.calls.length = 0;
  ctx.stroke();
  const n = strokes(native.calls);
  // 512 points is 40 rings, so ~50 chunks — the point is that it is many
  // and bounded, not the exact number
  assert.ok(n > 30 && n < 80, `${n} chunks`);
  for (let i = 0; i < n; i++) {
    assert.equal(
      chunk(native.calls, i)[0][0],
      'M',
      `chunk ${i} starts at a moveTo`,
    );
  }
  // the geometry that reached the bridge is the path, once, in order
  assert.equal(geometryCount(native.calls), built);
});

test('the chunks are the path, in order, and nothing else', () => {
  const { ctx, native } = context();
  rings(ctx, 300, 9);
  const built = geometry(native.calls);
  native.calls.length = 0;
  ctx.stroke();
  assert.ok(strokes(native.calls) > 1);
  assert.equal(geometry(native.calls), built);

  // and the unsplit route issues the same geometry once, at build time
  const plain = context();
  plain.ctx.strokeChunking = false;
  rings(plain.ctx, 300, 9);
  assert.equal(geometry(plain.native.calls), built);
  plain.native.calls.length = 0;
  plain.ctx.stroke();
  assert.equal(strokes(plain.native.calls), 1);
  assert.equal(geometry(plain.native.calls), '');
});

test('a chunk closes on the subpath budget as well as the point one', () => {
  const { ctx, native } = context();
  rings(ctx, 400, 2); // 800 points: one chunk on points, four on subpaths
  native.calls.length = 0;
  ctx.stroke();
  assert.equal(strokes(native.calls), 4);
  assert.equal(chunk(native.calls, 0).filter((c) => c[0] === 'M').length, 128);
});

test('every path verb survives the round trip', () => {
  const { ctx, native } = context();
  ctx.beginPath();
  for (let i = 0; i < 200; i++) {
    ctx.moveTo(i, 0);
    ctx.lineTo(i, 1);
    ctx.bezierCurveTo(1, 2, 3, 4, 5, 6);
    ctx.quadraticCurveTo(7, 8, 9, 10);
    ctx.rect(i, i, 4, 5);
    ctx.roundRect(i, i, 10, 10, 2);
    ctx.arc(i, i, 3, 0, Math.PI, true);
    ctx.ellipse(i, i, 2, 3);
    ctx.closePath();
  }
  const built = geometry(native.calls);
  native.calls.length = 0;
  ctx.stroke();
  assert.ok(strokes(native.calls) > 1);
  assert.equal(geometry(native.calls), built);
});

// --- what is left whole -------------------------------------------------------

test('a hairline is never chunked — CoreGraphics is already linear there', () => {
  const { ctx, native } = context();
  ctx.lineWidth = 1;
  rings(ctx, 2000, 13);
  native.calls.length = 0;
  ctx.stroke();
  assert.equal(strokes(native.calls), 1);
});

test('the hairline is a device width: a transform decides it', () => {
  const under = context();
  under.ctx.lineWidth = 0.4;
  under.ctx.scale(2, 2); // 0.8 device
  rings(under.ctx, 2000, 13);
  under.native.calls.length = 0;
  under.ctx.stroke();
  assert.equal(strokes(under.native.calls), 1);

  const over = context();
  over.ctx.lineWidth = 0.6;
  over.ctx.scale(2, 2); // 1.2 device
  rings(over.ctx, 2000, 13);
  over.native.calls.length = 0;
  over.ctx.stroke();
  assert.ok(strokes(over.native.calls) > 1);
});

test('anything that composites is left whole — the seams would blend twice', () => {
  for (const paint of [
    (ctx) => (ctx.strokeStyle = 'rgba(0,0,0,0.5)'),
    (ctx) => (ctx.globalAlpha = 0.5),
    (ctx) => {
      ctx.shadowColor = '#000';
      ctx.shadowBlur = 4;
    },
  ]) {
    const { ctx, native } = context();
    paint(ctx);
    rings(ctx, 2000, 13);
    native.calls.length = 0;
    ctx.stroke();
    assert.equal(strokes(native.calls), 1);
  }
});

test('an opaque ink with a transparent shadow colour still chunks', () => {
  const { ctx, native } = context();
  ctx.shadowBlur = 4; // the default shadowColor is transparent
  rings(ctx, 2000, 13);
  native.calls.length = 0;
  ctx.stroke();
  assert.ok(strokes(native.calls) > 1);
});

test('strokeChunking = false is the way out, and it round-trips', () => {
  const { ctx, native } = context();
  assert.equal(ctx.strokeChunking, true);
  ctx.strokeChunking = false;
  assert.equal(ctx.strokeChunking, false);
  rings(ctx, 2000, 13);
  native.calls.length = 0;
  ctx.stroke();
  assert.equal(strokes(native.calls), 1);
});

// --- the path the caller still has -------------------------------------------

test('a fill after a chunked stroke fills the whole path, not the last chunk', () => {
  const { ctx, native } = context();
  rings(ctx, 300, 9);
  const built = geometry(native.calls);
  native.calls.length = 0;
  ctx.stroke();
  const afterStroke = native.calls.length;
  ctx.fill();
  const rebuilt = native.calls.slice(afterStroke);
  assert.equal(rebuilt[0][0], 'begin');
  assert.equal(geometry(rebuilt), built);
  assert.deepEqual(rebuilt[rebuilt.length - 1], ['fill', false]);
});

test('a clip after a chunked stroke clips to the whole path', () => {
  const { ctx, native } = context();
  rings(ctx, 300, 9);
  const built = geometry(native.calls);
  native.calls.length = 0;
  ctx.stroke();
  const afterStroke = native.calls.length;
  ctx.clip();
  const rebuilt = native.calls.slice(afterStroke);
  assert.equal(geometry(rebuilt), built);
  assert.deepEqual(rebuilt[rebuilt.length - 1], ['clip']);
});

test('more path building after a chunked stroke extends the whole path', () => {
  const { ctx, native } = context();
  rings(ctx, 300, 9);
  const built = geometry(native.calls);
  native.calls.length = 0;
  ctx.stroke();
  const afterStroke = native.calls.length;
  ctx.lineTo(999, 999);
  const rebuilt = native.calls.slice(afterStroke);
  assert.equal(geometry(rebuilt), `${built}|L 999 999`);
});

test('a second stroke of the same path draws it whole again', () => {
  const { ctx, native } = context();
  rings(ctx, 300, 9);
  const built = geometry(native.calls);
  native.calls.length = 0;
  ctx.stroke();
  const first = geometry(native.calls);
  native.calls.length = 0;
  ctx.stroke();
  assert.equal(geometry(native.calls), first);
  assert.equal(first, built);
});

test('beginPath forgets the record — a small path after a big one is one stroke', () => {
  const { ctx, native } = context();
  rings(ctx, 2000, 13);
  ctx.stroke();
  rings(ctx, 5, 4);
  native.calls.length = 0;
  ctx.stroke();
  assert.equal(strokes(native.calls), 1);
  assert.equal(geometry(native.calls), '', 'nothing replayed');
});

test('a replaced surface drops the record with the path it was built on', () => {
  const native = fakeNative();
  let gen = 1;
  const ctx = new CocoaContext2D(
    native,
    () => ({ fake: true }),
    () => gen,
  );
  ctx.lineWidth = 2;
  rings(ctx, 300, 9);
  ctx.stroke();
  gen = 2;
  native.calls.length = 0;
  ctx.fill();
  assert.equal(geometry(native.calls), '');
});

test('a Path2D handed to stroke chunks the same way', () => {
  const { ctx, native } = context();
  const cmds = [];
  for (let i = 0; i < 300; i++) {
    cmds.push({ type: 'M', x: i, y: 0 });
    for (let v = 1; v < 9; v++) cmds.push({ type: 'L', x: i + v, y: v });
    cmds.push({ type: 'Z' });
  }
  native.calls.length = 0;
  ctx.stroke({ _cmds: cmds });
  assert.ok(strokes(native.calls) > 1);
  // built once, then replayed as chunks
  assert.equal(geometryCount(native.calls), cmds.length * 2);
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
    skip: bridge ? false : 'the @windowkit/appkit bridge is not loadable here',
  },
  () => {
    const W = 512;
    const H = 512;

    /** 256 closed rings on a grid, far enough apart that no two strokes meet */
    const grid = (radius) => {
      const out = [];
      for (let gy = 0; gy < 16; gy++) {
        for (let gx = 0; gx < 16; gx++) {
          const cx = (gx + 0.5) * (W / 16);
          const cy = (gy + 0.5) * (H / 16);
          const ring = [];
          for (let v = 0; v < 12; v++) {
            const a = (v / 12) * Math.PI * 2;
            ring.push(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius);
          }
          out.push(ring);
        }
      }
      return out;
    };

    const paint = (data, chunking) => {
      const surface = bridge.createSurface(W, H, 1);
      const ctx = new CocoaContext2D(
        bridge,
        () => surface,
        () => 1,
      );
      ctx.strokeChunking = chunking;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = '#204060';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (const ring of data) {
        ctx.moveTo(ring[0], ring[1]);
        for (let i = 2; i < ring.length; i += 2)
          ctx.lineTo(ring[i], ring[i + 1]);
        ctx.closePath();
      }
      ctx.stroke();
      return Buffer.from(bridge.ctxGetImageData(surface, 0, 0, W, H));
    };

    test('chunked and whole draw the same picture where subpaths do not overlap', () => {
      const data = grid(8);
      const chunked = paint(data, true);
      const whole = paint(data, false);
      let ink = 0;
      let differing = 0;
      for (let i = 0; i < whole.length; i += 4) {
        if (whole[i] !== 255 || whole[i + 1] !== 255) ink++;
        for (let c = 0; c < 4; c++) {
          if (chunked[i + c] !== whole[i + c]) {
            differing++;
            break;
          }
        }
      }
      assert.ok(ink > 5000, `the rings drew: ${ink} inked pixels`);
      assert.equal(differing, 0, `${differing} pixels differ`);
    });

    test('a chunked stroke inks the pixels a whole one does', () => {
      // the geometry above, at a size where the rings touch: chunking is
      // allowed to differ at the seams and nowhere else, and never by much
      const data = grid(18);
      const chunked = paint(data, true);
      const whole = paint(data, false);
      let worst = 0;
      let differing = 0;
      for (let i = 0; i < whole.length; i++) {
        const d = Math.abs(chunked[i] - whole[i]);
        if (d) {
          differing++;
          worst = Math.max(worst, d);
        }
      }
      assert.ok(
        differing < whole.length / 20,
        `${((100 * differing) / whole.length).toFixed(1)}% of channels differ`,
      );
      assert.ok(worst < 96, `worst channel delta ${worst}`);
    });
  },
);

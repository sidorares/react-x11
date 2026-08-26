// The protocol-efficiency analyzer behind `npm run bench`: stalls (blocking
// round trips), repeated identical queries, short-lived resource churn, the
// named request histogram, and the .x11cap export.
//
// Two layers on purpose. The synthetic tests feed hand-built wire bytes
// through `countStream`, so every rule is pinned against a stream whose
// ground truth is written next to it — including the negative cases (a
// pipelined reply is NOT a stall, a differing query is NOT a dup), which is
// what catches a broken rule that flags everything or nothing. The
// integration test then runs the real client against the in-process server,
// so the encodings the analyzer parses are the ones node-x11 actually
// writes (BIG-REQUESTS framing, extension init, id allocation).
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import xserver from 'x11/lib/xserver/index.js';
import { createClient, StaticFontSource, Surface } from 'ntk';

import {
  analysisMark,
  captureLines,
  compositePixels,
  convolvedPixels,
  countStream,
  windowAnalysis,
} from '../scripts/bench/xcount.js';

// --- synthetic wire builders -------------------------------------------

function fakeStream() {
  const stream = new EventEmitter();
  stream.write = () => true;
  return stream;
}

/** A counted stream with the connection handshake already consumed. */
function started(options) {
  const { stream, stats } = countStream(fakeStream(), options);
  stream.write(Buffer.alloc(12)); // setup request, no auth strings
  const setupReply = Buffer.alloc(8);
  setupReply[0] = 1; // success, zero extra words
  stream.emit('data', setupReply);
  return { stream, stats };
}

/** A request: 4-byte header plus 32-bit argument words. */
function req(op, minor = 0, words = []) {
  const b = Buffer.alloc(4 + words.length * 4);
  b[0] = op;
  b[1] = minor;
  b.writeUInt16LE(1 + words.length, 2);
  words.forEach((w, i) => b.writeUInt32LE(w >>> 0, 4 + i * 4));
  return b;
}

/** A reply to sequence number `seq`, with `extra` trailing words. */
function reply(seq, extra = 0, patch = null) {
  const b = Buffer.alloc(32 + extra * 4);
  b[0] = 1;
  b.writeUInt16LE(seq & 0xffff, 2);
  b.writeUInt32LE(extra, 4);
  patch?.(b);
  return b;
}

const GET_INPUT_FOCUS = 43;
const GET_PROPERTY = 20;

// --- stalls -------------------------------------------------------------

test('a reply to the last-sent request is a stall; a pipelined one is not', () => {
  const { stream, stats } = started();
  // nothing pipelined: the client sent one request and its reply lands
  stream.write(req(GET_INPUT_FOCUS));
  stream.emit('data', reply(1));
  assert.strictEqual(stats.analysis.stalls, 1);
  // two requests in flight: the first reply arrives with #3 already sent,
  // so the client was never blocked on it — not a stall. The second IS the
  // last thing sent when its reply lands, so it stalls.
  stream.write(req(GET_INPUT_FOCUS));
  stream.write(req(GET_INPUT_FOCUS));
  stream.emit('data', reply(2));
  assert.strictEqual(stats.analysis.stalls, 1);
  stream.emit('data', reply(3));
  assert.strictEqual(stats.analysis.stalls, 2);
  assert.deepStrictEqual(
    stats.analysis.stallList.map((s) => s.seq),
    [1, 3],
  );
});

// --- repeated identical queries ----------------------------------------

test('an identical answered query repeats; different bytes do not', () => {
  const { stream, stats } = started();
  stream.write(req(GET_PROPERTY, 0, [7, 42, 0, 0, 0]));
  stream.emit('data', reply(1));
  stream.write(req(GET_PROPERTY, 0, [7, 42, 0, 0, 0])); // same bytes
  stream.emit('data', reply(2));
  stream.write(req(GET_PROPERTY, 0, [7, 43, 0, 0, 0])); // different property
  stream.emit('data', reply(3));
  assert.strictEqual(stats.analysis.dupQueries, 1);
  assert.strictEqual(stats.analysis.dupList[0].name, 'GetProperty');
});

test('a delete-on-read GetProperty repeat is a mailbox poll, not a duplicate', () => {
  const { stream, stats } = started();
  // delete=1: ntk's shared-glyph directory polls a property mailbox this
  // way, so the same bytes legitimately answer differently every time
  const consuming = req(GET_PROPERTY, 1, [7, 42, 0, 0, 0]);
  for (const seq of [1, 2, 3]) {
    stream.write(consuming);
    stream.emit('data', reply(seq));
  }
  assert.strictEqual(stats.analysis.dupQueries, 0);
  // the same property read *without* the delete flag still counts
  const plain = req(GET_PROPERTY, 0, [7, 42, 0, 0, 0]);
  stream.write(plain);
  stream.emit('data', reply(4));
  stream.write(plain);
  stream.emit('data', reply(5));
  assert.strictEqual(stats.analysis.dupQueries, 1);
});

test('GetInputFocus repeats are sync traffic, never duplicate queries', () => {
  const { stream, stats } = started();
  for (let seq = 1; seq <= 3; seq++) {
    stream.write(req(GET_INPUT_FOCUS));
    stream.emit('data', reply(seq));
  }
  assert.strictEqual(stats.analysis.dupQueries, 0);
  assert.strictEqual(stats.analysis.stalls, 3);
});

// --- resource churn -----------------------------------------------------

/** CreatePixmap pid on drawable, sized w x h at `depth`. */
function createPixmap(pid, w, h, depth) {
  const b = req(53, depth, [pid, 1, 0]);
  b.writeUInt16LE(w, 12);
  b.writeUInt16LE(h, 14);
  return b;
}

test('created-then-freed resources churn, keyed by their parameters', () => {
  const { stream, stats } = started();
  stream.write(createPixmap(0x2001, 420, 380, 8));
  stream.write(req(54, 0, [0x2001])); // FreePixmap
  stream.write(createPixmap(0x2001, 420, 380, 8)); // the recycled-id rebuild
  stream.write(req(54, 0, [0x2001]));
  stream.write(createPixmap(0x2002, 16, 16, 24)); // still live: not churn
  assert.strictEqual(stats.analysis.churnPairs, 2);
  const windowed = windowAnalysis(stats, {
    seq: 0,
    stalls: 0,
    dupQueries: 0,
    churnPairs: 0,
  });
  assert.deepStrictEqual(windowed.churnBy, [['pixmap 420x380x8', 2]]);
});

test('freeing a pre-window resource is teardown, not window churn', () => {
  const { stream, stats } = started();
  stream.write(createPixmap(0x2001, 420, 380, 8)); // created before the mark
  const mark = analysisMark(stats);
  stream.write(req(54, 0, [0x2001])); // freed inside the window
  stream.write(createPixmap(0x2002, 8, 8, 24)); // a real in-window cycle
  stream.write(req(54, 0, [0x2002]));
  const windowed = windowAnalysis(stats, mark);
  assert.strictEqual(windowed.churn, 1);
  assert.deepStrictEqual(windowed.churnBy, [['pixmap 8x8x24', 1]]);
});

test('stall and dup detail lists respect the measurement window', () => {
  const { stream, stats } = started();
  stream.write(req(GET_PROPERTY, 0, [7, 42, 0, 0, 0]));
  stream.emit('data', reply(1)); // pre-mark stall and first sighting
  const mark = analysisMark(stats);
  stream.write(req(GET_PROPERTY, 0, [7, 42, 0, 0, 0]));
  stream.emit('data', reply(2)); // in-window: stall + duplicate of #1
  const windowed = windowAnalysis(stats, mark);
  assert.strictEqual(windowed.stalls, 1);
  assert.strictEqual(windowed.dupQueries, 1);
  assert.deepStrictEqual(windowed.stallsBy, [['GetProperty', 1]]);
  assert.deepStrictEqual(windowed.dupsBy, [['GetProperty', 1]]);
});

test('BIG-REQUESTS framing shifts argument offsets by one word', () => {
  const { stream, stats } = started();
  // CreatePixmap in extended framing: 16-bit length 0, real length at
  // [4..8), every argument 4 bytes later than in the classic frame
  const b = Buffer.alloc(20);
  b[0] = 53;
  b[1] = 24; // depth
  b.writeUInt16LE(0, 2);
  b.writeUInt32LE(5, 4); // 20 bytes in 4-byte units
  b.writeUInt32LE(0x2001, 8); // pid
  b.writeUInt32LE(1, 12); // drawable
  b.writeUInt16LE(64, 16); // width
  b.writeUInt16LE(32, 18); // height
  stream.write(b);
  stream.write(req(54, 0, [0x2001]));
  assert.strictEqual(stats.analysis.churned[0].key, 'pixmap 64x32x24');
});

// --- extension learning and naming --------------------------------------

/** QueryExtension by name, and the reply granting it `major`. */
function queryExtension(stream, seq, name, major) {
  const padded = (name.length + 3) & ~3;
  const b = Buffer.alloc(8 + padded);
  b[0] = 98;
  b.writeUInt16LE((8 + padded) / 4, 2);
  b.writeUInt16LE(name.length, 4);
  b.write(name, 8, 'latin1');
  stream.write(b);
  stream.emit(
    'data',
    reply(seq, 0, (r) => {
      r[8] = 1; // present
      r[9] = major;
    }),
  );
}

test('extension majors are learned from QueryExtension and name requests', () => {
  const { stream, stats } = started();
  queryExtension(stream, 1, 'RENDER', 130);
  stream.write(req(130, 26, [1, 2, 3])); // RENDER FillRectangles
  stream.write(req(130, 99, [1])); // unnamed minor
  const windowed = windowAnalysis(stats, {
    seq: 0,
    stalls: 0,
    dupQueries: 0,
    churnPairs: 0,
  });
  const names = new Map(windowed.byName);
  assert.strictEqual(names.get('RENDER:FillRectangles'), 1);
  assert.strictEqual(names.get('RENDER:minor99'), 1);
});

test('RENDER create/free cycles churn as pictures', () => {
  const { stream, stats } = started();
  queryExtension(stream, 1, 'RENDER', 130);
  stream.write(req(130, 4, [0x3001, 0x2001, 0x11, 0])); // CreatePicture
  stream.write(req(130, 7, [0x3001])); // FreePicture
  assert.strictEqual(stats.analysis.churnPairs, 1);
  assert.strictEqual(stats.analysis.churned[0].key, 'picture');
});

// --- filtered composites ------------------------------------------------

const RENDER = 130;

/** RENDER SetPictureFilter, packed the way node-x11 packs it. */
function setPictureFilter(pid, name, params = []) {
  const padded = (name.length + 3) & ~3;
  const b = Buffer.alloc(12 + padded + params.length * 4);
  b[0] = RENDER;
  b[1] = 30;
  b.writeUInt16LE(b.length / 4, 2);
  b.writeUInt32LE(pid, 4);
  b.writeUInt16LE(name.length, 8);
  b.write(name, 12, 'latin1');
  params.forEach((v, i) =>
    b.writeInt32LE(Math.round(v * 65536), 12 + padded + i * 4),
  );
  return b;
}

/** RENDER Composite of `src` through `mask` onto `dst`, `w` x `h`. */
function composite(src, mask, dst, w, h) {
  const b = Buffer.alloc(36);
  b[0] = RENDER;
  b[1] = 8;
  b.writeUInt16LE(9, 2);
  b.writeUInt32LE(src, 8);
  b.writeUInt32LE(mask, 12);
  b.writeUInt32LE(dst, 16);
  b.writeUInt16LE(w, 32);
  b.writeUInt16LE(h, 34);
  return b;
}

/** A 19x19 gaussian's worth of parameters — only the extent is read. */
const kernel19 = [19, 19, ...Array(361).fill(1 / 361)];

test('a convolution prices a composite by its kernel, not by its area', () => {
  const { stream, stats } = started();
  queryExtension(stream, 1, 'RENDER', RENDER);
  stream.write(setPictureFilter(0x3001, 'convolution', kernel19));
  stream.write(composite(0x3002, 0x3001, 0x3003, 40, 20)); // filtered mask
  stream.write(composite(0x3002, 0, 0x3003, 40, 20)); // nothing filtered
  // area cannot tell the two apart: same request, same rectangle
  assert.deepStrictEqual(compositePixels(stats, RENDER), {
    composites: 2,
    pixels: 2 * 800,
  });
  const conv = convolvedPixels(stats, RENDER);
  assert.strictEqual(conv.composites, 1);
  assert.strictEqual(conv.pixels, 361 * 800);
  assert.deepStrictEqual(conv.byKernel, [['mask 19x19', 1]]);
});

test('a filter on the source counts too, and both roles add up', () => {
  const { stream, stats } = started();
  queryExtension(stream, 1, 'RENDER', RENDER);
  stream.write(setPictureFilter(0x3001, 'convolution', [3, 3, ...Array(9)]));
  stream.write(composite(0x3001, 0, 0x3003, 10, 10));
  stream.write(setPictureFilter(0x3002, 'convolution', [5, 5, ...Array(25)]));
  stream.write(composite(0x3001, 0x3002, 0x3003, 10, 10));
  const conv = convolvedPixels(stats, RENDER);
  assert.strictEqual(conv.composites, 2);
  assert.strictEqual(conv.pixels, 9 * 100 + (9 + 25) * 100);
  assert.deepStrictEqual(conv.byKernel, [
    ['src 3x3', 1],
    ['src 3x3 + mask 5x5', 1],
  ]);
});

test('the filter is picture state: it stops counting when it goes away', () => {
  const { stream, stats } = started();
  queryExtension(stream, 1, 'RENDER', RENDER);
  const filtered = setPictureFilter(0x3001, 'convolution', kernel19);
  const draw = () => stream.write(composite(0x3002, 0x3001, 0x3003, 40, 20));

  stream.write(filtered);
  draw();
  // a plain resampling filter is one tap a pixel — already priced by area
  stream.write(setPictureFilter(0x3001, 'bilinear'));
  draw();
  // FreePicture, then the recycled XID handed to a fresh unfiltered picture:
  // node-x11 reuses ids, so a stale kernel would price the wrong surface
  stream.write(filtered);
  stream.write(req(RENDER, 7, [0x3001]));
  draw();
  stream.write(filtered);
  stream.write(req(RENDER, 4, [0x3001, 0x2001, 0x11, 0])); // CreatePicture
  draw();

  const conv = convolvedPixels(stats, RENDER);
  assert.strictEqual(conv.composites, 1);
  assert.strictEqual(conv.pixels, 361 * 800);
});

test('a 1x1 convolution is one tap a pixel: filtered, but not costly', () => {
  const { stream, stats } = started();
  queryExtension(stream, 1, 'RENDER', RENDER);
  // ntk sends this for a zero-radius blur — a filter, so the server's
  // unfiltered fast path is off, but the same work per pixel as no filter
  stream.write(setPictureFilter(0x3001, 'convolution', [1, 1, 1]));
  stream.write(composite(0x3002, 0x3001, 0x3003, 40, 20));
  const conv = convolvedPixels(stats, RENDER);
  assert.strictEqual(conv.composites, 1);
  assert.strictEqual(conv.pixels, compositePixels(stats, RENDER).pixels);
});

// --- GenericEvent framing ----------------------------------------------

test('a long GenericEvent does not desync the reply parser', () => {
  const { stream, stats } = started();
  stream.write(req(GET_INPUT_FOCUS));
  // XGE (e.g. Present CompleteNotify) with 2 extra words, then the reply.
  // Without the extended-length read the parser would treat the event as 32
  // bytes and misparse its tail as the next message.
  const xge = Buffer.alloc(40);
  xge[0] = 35;
  xge.writeUInt32LE(2, 4);
  stream.emit('data', Buffer.concat([xge, reply(1)]));
  assert.strictEqual(stats.events, 1);
  assert.strictEqual(stats.replies, 1);
  assert.strictEqual(stats.analysis.stalls, 1);
});

// --- .x11cap export -----------------------------------------------------

test('captureLines round-trips the wire bytes in x11vis line-JSON', () => {
  const { stream, stats } = started({ record: true });
  const request = req(GET_INPUT_FOCUS);
  stream.write(request);
  stream.emit('data', reply(1));
  const lines = captureLines(stats, 'test').trim().split('\n');
  const header = JSON.parse(lines[0]);
  assert.strictEqual(header.x11cap, 1);
  const records = lines.slice(1).map((line) => JSON.parse(line));
  // setup out, setup reply, request, reply — in order, with directions
  assert.deepStrictEqual(
    records.map((r) => r.d),
    ['c2s', 's2c', 'c2s', 's2c'],
  );
  assert.strictEqual(records[2].b, request.toString('hex'));
  for (const r of records) {
    assert.strictEqual(r.c, 0);
    assert.strictEqual(typeof r.m, 'number');
    assert.strictEqual(typeof r.w, 'number');
  }
});

// --- against the real client and server ---------------------------------

const require = createRequire(import.meta.url);
const fontDir = join(
  dirname(require.resolve('katex/package.json')),
  'dist',
  'fonts',
);

test('the analyzer prices real node-x11 traffic', async () => {
  const server = xserver.createServer({ width: 200, height: 200 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const { stats } = countStream(clientEnd);
  const source = new StaticFontSource();
  source.add(readFileSync(join(fontDir, 'KaTeX_Main-Regular.ttf')), {
    family: 'Bench',
  });
  const app = await createClient({ stream: clientEnd, fontSource: source });
  try {
    const X = app.X;
    await new Promise((resolve) => X.GetInputFocus(resolve));
    const mark = analysisMark(stats);

    // an awaited sync with nothing pipelined behind it is a blocking RT
    await new Promise((resolve) => X.GetInputFocus(resolve));

    // two interns of one name in the same tick: node-x11 only caches after
    // the reply, so both hit the wire — the duplicate the analyzer flags
    await Promise.all([
      new Promise((resolve) => X.InternAtom(false, 'BENCH_DUP_ATOM', resolve)),
      new Promise((resolve) => X.InternAtom(false, 'BENCH_DUP_ATOM', resolve)),
    ]);

    // a pixmap created and freed inside the window is churn, keyed by size
    const pixmap = app.createPixmap({ width: 32, height: 16, depth: 24 });
    pixmap.destroy();
    await new Promise((resolve) => X.GetInputFocus(resolve));

    const windowed = windowAnalysis(stats, mark);
    assert.ok(windowed.stalls >= 1, `stalls: ${windowed.stalls}`);
    assert.strictEqual(windowed.dupQueries, 1);
    assert.deepStrictEqual(windowed.dupsBy, [['InternAtom', 1]]);
    const churn = new Map(windowed.churnBy);
    assert.strictEqual(churn.get('pixmap 32x16x24'), 1);
  } finally {
    await app.close();
  }
});

test('a real blurred shadow is priced by its kernel, not by its box', async () => {
  const server = xserver.createServer({ width: 200, height: 200 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const { stats } = countStream(clientEnd);
  const app = await createClient({
    stream: clientEnd,
    fontSource: new StaticFontSource(),
  });
  try {
    const render = app.display.Render.majorOpcode;
    // exactly what a blurred `boxShadow` did (src/nodes.js): coverage in an
    // a8 surface, the blur set on its *picture*, painted through a colour.
    // The parse has to survive node-x11's own SetPictureFilter packing —
    // padded name, 16.16 FIXED parameters — which is why this runs against
    // the real client rather than hand-built bytes.
    const shadow = new Surface(app, { width: 32, height: 16, format: 'a8' });
    shadow.render((ctx) => {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 32, 16);
    });
    shadow.picture().setBlurFilter(19, 9.5);
    const dst = new Surface(app, { width: 64, height: 64 });
    const mark = { composites: stats.composites.length };
    dst.render((ctx) => {
      ctx.fillStyle = '#000000';
      ctx.drawImage(shadow, 0, 0);
    });
    await new Promise((resolve) => app.X.GetInputFocus(resolve));

    const drawn = { composites: stats.composites.slice(mark.composites) };
    const area = compositePixels(drawn, render);
    const conv = convolvedPixels(drawn, render);
    // ntk stages the tinted coverage, so the shadow is two composites of the
    // surface — one of which reads it through the convolution
    assert.strictEqual(area.pixels, area.composites * 32 * 16);
    assert.strictEqual(conv.composites, 1);
    assert.deepStrictEqual(conv.byKernel, [['mask 19x19', 1]]);
    // the whole point: 36 bytes and 512 pixels on the wire either way, and
    // 361 multiply-accumulates per pixel behind them
    assert.strictEqual(conv.pixels, 361 * 32 * 16);
    shadow.destroy();
    dst.destroy();
  } finally {
    await app.close();
  }
});

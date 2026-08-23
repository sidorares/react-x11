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
import { createClient, StaticFontSource } from 'ntk';

import {
  analysisMark,
  captureLines,
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

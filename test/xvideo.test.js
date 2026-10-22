// The X11 frame writer's decisions (src/xvideo.js), with a port that records
// rather than draws: which sinks go through Xv and which the JavaScript way,
// what `preferredFormats` answers while the port is being asked for and
// after, and a target's life beside the `<video>`'s surface. What a real
// adaptor makes of a frame is test/video-xv-live.test.js.
import assert from 'node:assert';
import { test } from 'node:test';

import { createVideoFrames } from '../src/videoframes.js';
import { videoBackendOf } from '../src/videobackend.js';
import { xvVideoFor } from '../src/xvideo.js';

/** A port that takes `formats`, knows every layout, and records. */
function fakePort({
  formats = ['NV12', 'YV12', 'AR24'],
  colorSpaces = ['bt601', 'bt709'],
} = {}) {
  const port = {
    formats,
    colorSpaces,
    closed: false,
    targets: [],
    known: true,
    layout() {
      return port.known ? { width: 0, height: 0 } : null;
    },
    createTarget(window, size) {
      const target = {
        window,
        size,
        puts: [],
        copies: [],
        destroyed: false,
        viewable: true,
        put(frame) {
          if (!target.viewable) return false;
          target.puts.push(frame);
          return true;
        },
        copyTo(surface) {
          target.copies.push(surface);
        },
        destroy() {
          target.destroyed = true;
        },
      };
      port.targets.push(target);
      return target;
    },
  };
  return port;
}

/** An X11-shaped app, its writer, and the port put straight in. */
function x11(port) {
  const app = { xv: async () => null };
  const writer = xvVideoFor(app);
  writer.port = port;
  return { app, writer };
}

const nodeIn = (window) => ({ root: { window } });

function pushed(app, options) {
  const sink = createVideoFrames(app, { width: 4, height: 2, ...options });
  const sizes = { NV12: [8, 4], I420: [8, 2, 2], BGRA: [32] }[sink.format];
  sink.push(sizes.map((n, i) => new Uint8Array(n).fill(i + 1)));
  return sink;
}

test('the app answers for itself where it writes frames; an ntk app gets the Xv writer', () => {
  const cocoa = { writeVideoFrame() {}, xv() {} };
  assert.strictEqual(videoBackendOf(cocoa), cocoa);
  const ntk = { xv: async () => null };
  assert.strictEqual(
    videoBackendOf(ntk),
    xvVideoFor(ntk),
    'one writer per connection',
  );
  assert.strictEqual(
    videoBackendOf({}),
    null,
    'win32: nothing native, JavaScript',
  );
  assert.strictEqual(videoBackendOf(null), null);
});

test('preferredFormats is BGRA, unkept, while the port is asked for — then the port’s', () => {
  const app = { xv: async () => null };
  const writer = xvVideoFor(app);
  const sink = createVideoFrames(app, { width: 2, height: 2 });
  assert.strictEqual(writer.port, undefined, 'asked for, not yet answered');
  assert.deepStrictEqual(sink.preferredFormats, ['BGRA']);
  writer.port = fakePort({ formats: ['YV12', 'AR24'] });
  assert.deepStrictEqual(
    sink.preferredFormats,
    ['I420', 'BGRA'],
    'I420 through a port with YV12 alone, its chroma planes swapped',
  );
  writer.port = null;
  assert.deepStrictEqual(
    sink.preferredFormats,
    ['I420', 'BGRA'],
    'and kept once known',
  );
  const after = createVideoFrames(app, { width: 2, height: 2 });
  assert.deepStrictEqual(
    after.preferredFormats,
    ['BGRA'],
    'no port: JavaScript, where BGRA costs least',
  );
});

test('a frame goes through the port into a target, and is copied into the surface', () => {
  const port = fakePort();
  const { app, writer } = x11(port);
  const sink = pushed(app, { format: 'NV12' });
  const surface = {};
  const window = { id: 7 };
  assert.strictEqual(
    writer.writeVideoFrame(surface, sink, sink.frame, nodeIn(window)),
    true,
  );
  const [target] = port.targets;
  assert.deepStrictEqual(
    [target.window, target.size],
    [window, { width: 4, height: 2 }],
  );
  assert.deepStrictEqual(
    target.puts.map((f) => [f.format, f.colorSpace, f.planes.length]),
    [['NV12', 'bt709', 2]],
  );
  assert.deepStrictEqual(target.copies, [surface]);
  // the next frame, the same target
  writer.writeVideoFrame(surface, sink, sink.frame, nodeIn(window));
  assert.strictEqual(port.targets.length, 1);
});

test('I420 through YV12 hands the port its planes Y, Cr, Cb', () => {
  const port = fakePort({ formats: ['YV12'] });
  const { app, writer } = x11(port);
  const sink = pushed(app, { format: 'I420' });
  writer.writeVideoFrame({}, sink, sink.frame, nodeIn({ id: 7 }));
  const [put] = port.targets[0].puts;
  assert.strictEqual(put.format, 'YV12');
  assert.deepStrictEqual(
    put.planes.map((p) => p[0]),
    [1, 3, 2],
  );
});

test('declined, and drawn the JavaScript way: full range, a matrix the port cannot read, no window, a size not yet laid out', () => {
  const port = fakePort({ colorSpaces: ['bt601'] });
  const { app, writer } = x11(port);
  const window = { id: 7 };
  const full = pushed(app, {
    format: 'NV12',
    colorSpace: 'bt601',
    range: 'full',
  });
  assert.strictEqual(
    writer.writeVideoFrame({}, full, full.frame, nodeIn(window)),
    false,
    'every adaptor reads video range',
  );
  const hd = pushed(app, { format: 'NV12', colorSpace: 'bt709' });
  assert.strictEqual(
    writer.writeVideoFrame({}, hd, hd.frame, nodeIn(window)),
    false,
    'no XV_COLORSPACE: BT.601 only',
  );
  const sd = pushed(app, { format: 'NV12', colorSpace: 'bt601' });
  assert.strictEqual(
    writer.writeVideoFrame({}, sd, sd.frame, { root: null }),
    false,
    'not in a window',
  );
  port.known = false;
  assert.strictEqual(
    writer.writeVideoFrame({}, sd, sd.frame, nodeIn(window)),
    false,
    'the layout is being asked for',
  );
  assert.strictEqual(
    port.targets.length,
    0,
    'and no target made for any of them',
  );
  // BGRA has no matrix and no range to get wrong
  port.known = true;
  const bgra = pushed(app, {
    format: 'BGRA',
    range: 'full',
    colorSpace: 'bt2020',
  });
  assert.strictEqual(
    writer.writeVideoFrame({}, bgra, bgra.frame, nodeIn(window)),
    true,
  );
  assert.strictEqual(port.targets[0].puts[0].format, 'AR24');
});

test('off screen, a frame is declined and the target kept; gone, or in another window, it is made again', () => {
  const port = fakePort();
  const { app, writer } = x11(port);
  const sink = pushed(app, { format: 'NV12' });
  const surface = {};
  const first = { id: 7 };
  writer.writeVideoFrame(surface, sink, sink.frame, nodeIn(first));
  const [target] = port.targets;
  target.viewable = false;
  assert.strictEqual(
    writer.writeVideoFrame(surface, sink, sink.frame, nodeIn(first)),
    false,
    'minimized',
  );
  assert.strictEqual(port.targets.length, 1, 'the target waits for the window');
  target.viewable = true;
  target.destroyed = true; // its window went, and took it
  writer.writeVideoFrame(surface, sink, sink.frame, nodeIn(first));
  assert.strictEqual(port.targets.length, 2);
  const second = { id: 9 };
  writer.writeVideoFrame(surface, sink, sink.frame, nodeIn(second));
  assert.strictEqual(port.targets.length, 3);
  assert.strictEqual(
    port.targets[1].destroyed,
    true,
    'the one in the old window let go',
  );
  writer.releaseVideoFrame(surface);
  assert.strictEqual(
    port.targets[2].destroyed,
    true,
    'and the last with the surface',
  );
});

test('a closed port, or none, writes nothing', () => {
  const closed = fakePort();
  closed.closed = true;
  const { app, writer } = x11(closed);
  const sink = pushed(app, { format: 'NV12' });
  assert.strictEqual(
    writer.writeVideoFrame({}, sink, sink.frame, nodeIn({ id: 7 })),
    false,
  );
  writer.port = null;
  assert.strictEqual(
    writer.writeVideoFrame({}, sink, sink.frame, nodeIn({ id: 7 })),
    false,
  );
});

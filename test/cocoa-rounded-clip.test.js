// A rounded box that clips its children, on the Cocoa backend (issue #693).
//
// On X11 such a box has drawn its children under its rectangle and put its
// corners back since #685 (test/rounded-clip.test.js holds the pixels). On
// Cocoa `readback()` had nothing to read, so every child was drawn through a
// path clip — and CoreGraphics draws through a path clip by masking all of
// it: a pane-sized picture took 22 ms where 8 would do, a graph's zoom half
// the frame rate. The Cocoa owners of a context now say their bitmap reads
// back cheaply (a CPU bitmap; a `copy` of it is a memcpy), and the corners
// are kept the same way.
//
// Over the recording AppKit fake, which rasterizes nothing: what is held
// here is the mechanism — the corners read back and put back, and no path
// clip under them — and that a context whose owner said nothing stays as it
// was. The pixels were compared against the path clip on a real display:
// equal away from the arc, and within the ring tolerance
// test/rounded-clip.test.js allows X11 on it.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import React from 'react';

import { BackendContext2D } from '../src/backend/context2d.js';
import { cleanupCocoa, mountCocoa } from './helpers/cocoa-bridge.js';

const h = React.createElement;

afterEach(cleanupCocoa);

/** A card that clips a child reaching all four of its corners. */
function card() {
  return h(
    'box',
    {
      style: {
        margin: 10,
        width: 120,
        height: 80,
        overflow: 'hidden',
        borderRadius: 12,
        backgroundColor: '#ffffff',
      },
    },
    h('box', { style: { flexGrow: 1, backgroundColor: '#3d7eff' } }),
  );
}

test('a rounded box that clips its children keeps its corners on Cocoa', async () => {
  const mounted = await mountCocoa(card(), {
    width: 160,
    height: 120,
    promote: false,
  });
  mounted.native.calls.length = 0;
  mounted.node.invalidate(false);
  mounted.frame();
  const modes = mounted.native.of('ctxSetBlendMode').map(([, mode]) => mode);
  // each corner is read back into a spare with a `copy`, cut to the arc's
  // outside with `destination-in`, and put back after the children with
  // `destination-out` and `lighter`
  for (const mode of ['copy', 'destination-in', 'destination-out', 'lighter']) {
    assert.ok(modes.includes(mode), `the corners went through ${mode}`);
  }
  assert.ok(
    mounted.native.of('blitSurface').length >= 4,
    'the window bitmap was read back by memcpy, a corner at a time',
  );
});

test('the corners are read back from the bitmap being drawn into', async () => {
  const mounted = await mountCocoa(card(), {
    width: 160,
    height: 120,
    promote: false,
  });
  mounted.native.calls.length = 0;
  mounted.node.invalidate(false);
  mounted.frame();
  // every read-back copies out of one surface — the one the frame draws
  // into — and never into it
  const sources = new Set(
    mounted.native.of('blitSurface').map(([source]) => source?.id),
  );
  const targets = new Set(
    mounted.native.of('blitSurface').map(([, target]) => target?.id),
  );
  assert.equal(sources.size, 1, 'one bitmap is read back');
  assert.ok(![...targets].some((id) => sources.has(id)));
});

test('a context whose owner said nothing reads nothing back', () => {
  const surface = { id: 1, width: 40, height: 30 };
  const native = {
    surfaceSize: (handle) => ({ width: handle.width, height: handle.height }),
  };
  const silent = new BackendContext2D(
    native,
    () => surface,
    () => 1,
  );
  assert.equal(silent.readbackSource(), null, 'a GPU target, say: no');
  const cpu = new BackendContext2D(
    native,
    () => surface,
    () => 1,
    { readback: true },
  );
  cpu._gen = 1; // its surface is current; nothing to push back into it
  const source = cpu.readbackSource();
  assert.ok(source, 'a CPU bitmap: yes');
  assert.equal(source._surfaceHandle, surface);
  assert.equal(source.width, 40);
  assert.equal(source.height, 30);
});

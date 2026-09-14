// Which DRM node the Wayland backend's GPU context is made on: a named
// device, the render node, or — on a machine with none, like a GitHub-hosted
// runner or a Hyper-V guest — each card node in turn. A fake x11-dri stands
// in for the addon; no GPU, no compositor.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  gpuCandidates,
  listCardNodes,
  sharedGpu,
} from '../../src/wayland/glcontext.js';

const FORMAT = { format: 1, depthSize: 16, stencilSize: 8 };

/**
 * An x11-dri with these render nodes whose `Gpu` fails on the paths in
 * `failOn`, recording every device it was asked for.
 */
function fakeDri({ renderNodes = [], failOn = [] } = {}) {
  const opened = [];
  return {
    opened,
    listRenderNodes: () => renderNodes,
    Gpu: class {
      constructor(opts) {
        opened.push(opts.devicePath);
        if (failOn.includes(opts.devicePath ?? 'default'))
          throw new Error(`no EGL on ${opts.devicePath ?? 'default'}`);
        this.devicePath = opts.devicePath ?? null;
      }
    },
  };
}

const seams = (cards, env = {}) => ({ env, cardNodes: () => cards });

test('gpuCandidates: a named device alone, else the render node, else the card nodes', () => {
  const cards = ['/dev/dri/card0', '/dev/dri/card1'];
  assert.deepEqual(
    gpuCandidates({
      requested: '/dev/dri/card1',
      renderNodes: ['/dev/dri/renderD128'],
      cardNodes: cards,
    }),
    ['/dev/dri/card1'],
  );
  assert.deepEqual(
    gpuCandidates({
      requested: null,
      renderNodes: ['/dev/dri/renderD128'],
      cardNodes: cards,
    }),
    [undefined],
    "x11-dri's own choice, the first render node",
  );
  assert.deepEqual(
    gpuCandidates({ requested: null, renderNodes: [], cardNodes: cards }),
    cards,
  );
  assert.deepEqual(
    gpuCandidates({ requested: null, renderNodes: [], cardNodes: [] }),
    [undefined],
    'nothing at all: the default once, for its own error',
  );
});

test('listCardNodes: card nodes only, in numeric order', () => {
  const readdir = () => [
    'renderD128',
    'card10',
    'card1',
    'by-path',
    'card0',
    'controlD64',
  ];
  assert.deepEqual(listCardNodes(readdir), [
    '/dev/dri/card0',
    '/dev/dri/card1',
    '/dev/dri/card10',
  ]);
  const missing = () => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };
  assert.deepEqual(listCardNodes(missing), [], 'no /dev/dri at all');
});

test('sharedGpu: with no render node, the first card node that opens', () => {
  const dri = fakeDri({ failOn: ['/dev/dri/card0'] });
  const gpu = sharedGpu(
    dri,
    FORMAT,
    seams(['/dev/dri/card0', '/dev/dri/card1']),
  );
  assert.equal(gpu.devicePath, '/dev/dri/card1');
  assert.deepEqual(dri.opened, ['/dev/dri/card0', '/dev/dri/card1']);
});

test('sharedGpu: a render node keeps the old behaviour — the cards are never tried', () => {
  const dri = fakeDri({ renderNodes: ['/dev/dri/renderD128'] });
  const gpu = sharedGpu(dri, FORMAT, seams(['/dev/dri/card0']));
  assert.equal(gpu.devicePath, null, "x11-dri's default");
  assert.deepEqual(dri.opened, [undefined]);
});

test('sharedGpu: a named device is the only one tried, and its failure is the error', () => {
  const dri = fakeDri({ failOn: ['/dev/dri/card9'] });
  assert.throws(
    () =>
      sharedGpu(
        dri,
        { ...FORMAT, devicePath: '/dev/dri/card9' },
        seams(['/dev/dri/card0']),
      ),
    /could not create a GPU context on \/dev\/dri\/card9: no EGL/,
  );
  assert.deepEqual(dri.opened, ['/dev/dri/card9'], 'no fallback to card0');
});

test('sharedGpu: REACT_X11_GL_DEVICE names the device, and glPolicy.devicePath beats it', () => {
  const env = { REACT_X11_GL_DEVICE: '/dev/dri/card3' };
  const fromEnv = fakeDri();
  assert.equal(
    sharedGpu(fromEnv, FORMAT, seams(['/dev/dri/card0'], env)).devicePath,
    '/dev/dri/card3',
  );
  const fromOption = fakeDri();
  assert.equal(
    sharedGpu(
      fromOption,
      { ...FORMAT, devicePath: '/dev/dri/card5' },
      seams(['/dev/dri/card0'], env),
    ).devicePath,
    '/dev/dri/card5',
  );
});

test('sharedGpu: every device tried is named when none opens', () => {
  const dri = fakeDri({ failOn: ['/dev/dri/card0', '/dev/dri/card1'] });
  assert.throws(
    () => sharedGpu(dri, FORMAT, seams(['/dev/dri/card0', '/dev/dri/card1'])),
    (err) =>
      /\/dev\/dri\/card0: no EGL on \/dev\/dri\/card0; \/dev\/dri\/card1: no EGL/.test(
        err.message,
      ) && err.cause instanceof Error,
  );
});

test('sharedGpu: one context per format and request — the app and its windows share it', () => {
  const dri = fakeDri();
  const cards = seams(['/dev/dri/card0']);
  const app = sharedGpu(dri, FORMAT, cards);
  const window = sharedGpu(dri, FORMAT, cards);
  assert.equal(window, app);
  assert.equal(dri.opened.length, 1, 'made once');
  const other = sharedGpu(dri, { ...FORMAT, format: 2 }, cards);
  assert.notEqual(other, app, 'another pixel format is another context');
});

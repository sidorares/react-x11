// The layout engine is compiled from the bytes yoga-layout embeds
// (src/yoga.js, `embeddedAssembly`), rather than by its loader fetching them
// from a data URL — which had Node load undici, its `fetch`, at every app's
// startup. What has to hold: the engine loads, it lays out, and nothing
// asked for `fetch`. A file of its own, since the engine loads once a process.
import { test } from 'node:test';
import assert from 'node:assert';

let fetched = 0;
globalThis.fetch = () => {
  fetched++;
  throw new Error('the layout engine fetched');
};

const { loadLayout, Yoga } = await import('../src/yoga.js');

test('the layout engine loads from its own bytes, and fetches nothing', async () => {
  await loadLayout();
  const node = Yoga.Node.create();
  node.setWidth(40);
  node.setHeight(10);
  node.calculateLayout(100, 100, Yoga.DIRECTION_LTR);
  assert.strictEqual(node.getComputedWidth(), 40);
  assert.strictEqual(node.getComputedHeight(), 10);
  node.free();
  assert.strictEqual(fetched, 0, 'fetch was called');
});

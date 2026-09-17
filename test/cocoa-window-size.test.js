// A window on the point grid (#586).
//
// AppKit puts a window on whole points, so at scale 2 a window cannot be 201
// device pixels tall: asked for 201, it is 202. The renderer used to record
// the 201 it asked for, and the resize echo compares against that record —
// a size nobody asked for is somebody else's decision, the user dragging an
// edge — so the echo of 202 ended an `'auto'` window's authority over its
// own size for good, and it stopped following its content. A popover whose
// natural height came out at 487.5 points was the case that found it.
//
// Now the window says what it will take (`CocoaWindow.snapSize`), and that is
// what is recorded (`WindowNode._snapSize`): at creation, on a re-fit and on
// a size the app sets. Over the fake bridge, which echoes a frame the way
// AppKit does — in points, as a `window-resize`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';

import { createRoot } from '../src/index.js';
import { fakeCocoaApp, fakeCocoaBridge, tick } from './helpers/cocoa-bridge.js';

const h = React.createElement;

/** Render, then run the frame the commit asked for. */
async function commit(root, app, tree) {
  root.render(tree);
  await tick();
  app._tickFrames();
}

test('a half-point natural size is the whole point AppKit gives, and the window keeps tracking', async (t) => {
  const { app, native } = fakeCocoaApp();
  const root = await createRoot({ app });
  t.after(() => root.unmount());
  const tree = (height, width = 200) =>
    h('window', { width: 200 }, h('box', { style: { width, height } }));

  // No frame yet: AppKit can confirm the frame before the first one runs,
  // and the re-fit that frame does would otherwise cover for the record
  root.render(tree(100.5));
  await tick();
  const wnd = [...app._windows.values()][0];
  const node = wnd._reactX11Node;
  assert.deepEqual([wnd.width, wnd.height], [400, 202], 'up to 101 points');
  assert.deepEqual(node._requestedSize, { width: 400, height: 202 });
  // AppKit confirming the frame it gave the window
  app._route({
    type: 'window-resize',
    windowNumber: wnd.windowNumber,
    x: 0,
    y: 0,
    width: 200,
    height: 101,
    live: false,
  });
  assert.equal(node._userSized, false, 'its own size is not the user’s');
  app._tickFrames();

  // a layout that leaves the natural size where it was asks for nothing:
  // 201 and the 202 on record are one window size
  const frames = () => native.of('setWindowFrame').length;
  const before = frames();
  await commit(root, app, tree(100.5, 150));
  assert.equal(frames(), before, 'no configure for a size that cannot change');

  // a re-fit to another half point: asked for as 121 points, and the fake
  // echoes that frame back straight away
  await commit(root, app, tree(120.5));
  assert.equal(wnd.height, 242);
  assert.equal(node._userSized, false);
  await commit(root, app, tree(50));
  assert.equal(wnd.height, 100, 'still following its content, down as well');
});

test('a size the window cannot take is rounded up, so the content is never cut', async () => {
  // At scale 2 rounding up and rounding to the nearest agree on every whole
  // device pixel; at 3 they do not, and a window a pixel short clips.
  const native = fakeCocoaBridge({
    screens: [
      {
        x: 0,
        y: 0,
        width: 1440,
        height: 900,
        scale: 3,
        visible: { x: 0, y: 0, width: 1440, height: 875 },
        primary: true,
      },
    ],
  });
  const { app } = fakeCocoaApp({}, { native });
  const wnd = app.createWindow({ width: 301, height: 300 });
  assert.deepEqual([wnd.width, wnd.height], [303, 300]);
  assert.deepEqual(wnd.snapSize(604, 1), { width: 606, height: 3 });
  wnd.resize(299, 298);
  assert.deepEqual([wnd.width, wnd.height], [300, 300]);
  wnd.destroy();
});

test('a size the app sets is recorded as the one the window takes', async (t) => {
  const { app } = fakeCocoaApp();
  const root = await createRoot({ app });
  t.after(() => root.unmount());
  const tree = (height) =>
    h('window', { width: 200, height }, h('box', { style: { flexGrow: 1 } }));
  await commit(root, app, tree(100));
  const wnd = [...app._windows.values()][0];
  const node = wnd._reactX11Node;
  await commit(root, app, tree(80.5));
  assert.equal(wnd.height, 162);
  assert.deepEqual(node._requestedSize, { width: 400, height: 162 });
  assert.equal(node._userSized, false);
});

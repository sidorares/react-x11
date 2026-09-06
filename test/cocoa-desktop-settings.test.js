// The desktop's "reduce motion" on the Cocoa backend (src/desktopsettings.js
// over CocoaApp's accessibility seam, @windowkit/appkit >= 0.5): read
// synchronously from the bridge, live through the backend event, and what a
// looping animation does about it. Headless: a recording fake bridge, so
// this runs everywhere and says nothing about System Settings itself — only
// that what the bridge reports reaches `desktopSettings()` and the loops.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import React from 'react';

import { createRoot } from '../src/index.js';
import { CocoaApp } from '../src/cocoa/app.js';
import {
  beginDesktopSettings,
  desktopSettings,
  endDesktopSettings,
  fromMacOS,
  watchDesktopSettings,
} from '../src/desktopsettings.js';
import { setScaleForTests } from '../src/scale.js';
import { setScreensForTests } from '../src/screens.js';
import { setCompositingForTests } from '../src/compositing.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

const OPTIONS = {
  reduceMotion: false,
  reduceTransparency: false,
  increaseContrast: false,
  differentiateWithoutColor: false,
  invertColors: false,
};

/** A bridge shaped like @windowkit/appkit's, answering what a window's
 *  construction and the accessibility seam ask, and delivering events. */
function fakeNative(options = {}) {
  let cb = null;
  let seq = 0;
  const base = {
    options: { ...OPTIONS, ...options },
    /** Tell the app the options changed, the way the bridge does. */
    change(next) {
      Object.assign(base.options, next);
      cb?.({ type: 'accessibility-display-changed', ...base.options });
    },
    accessibilityDisplayOptions: () => ({ ...base.options }),
    setBackendEventCallback(fn) {
      cb = fn;
    },
    initApp() {},
    listScreens: () => [
      {
        x: 0,
        y: 0,
        width: 1440,
        height: 900,
        scale: 2,
        fps: 60,
        visible: { x: 0, y: 0, width: 1440, height: 875 },
        primary: true,
      },
    ],
    createWindow2: (o) => ({ id: ++seq, options: { ...o } }),
    windowNumber: (handle) => handle.id,
    windowRootLayer: (handle) => ({ root: handle.id }),
    getWindowFrame: (handle) => ({
      x: 0,
      y: 0,
      width: handle.options.width,
      height: handle.options.height,
    }),
    windowIsVisible: () => true,
    createSurfaceIOSurface: (width, height, scale) => ({
      handle: { id: ++seq, width, height, scale },
      iosurfaceId: seq,
    }),
    createSurface: (width, height, scale) => ({
      id: ++seq,
      width,
      height,
      scale,
    }),
    surfaceSize: (handle) => ({
      width: handle.width,
      height: handle.height,
      scale: handle.scale,
    }),
  };
  return new Proxy(base, {
    get: (target, key) => (key in target ? target[key] : () => undefined),
  });
}

function appOver(native) {
  const app = new CocoaApp(native);
  setScaleForTests(app, 2, 'cocoa');
  setScreensForTests(app, {
    monitors: [{ x: 0, y: 0, width: 2880, height: 1800 }],
    workArea: { x: 0, y: 0, width: 2880, height: 1750 },
  });
  setCompositingForTests(app, true);
  native.setBackendEventCallback((ev) => app._route(ev));
  return app;
}

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await root.unmount();
});

test('fromMacOS: reduce motion is the one field the system answers', () => {
  const still = fromMacOS({ ...OPTIONS, reduceMotion: true });
  assert.strictEqual(still.animations, false);
  assert.strictEqual(still.source, 'macos');
  assert.strictEqual(still.caretBlinkMs, fromMacOS(null).caretBlinkMs);
  assert.strictEqual(fromMacOS({ ...OPTIONS }).animations, true);
  // a bridge that does not answer is a desktop that said nothing
  assert.strictEqual(fromMacOS(null).animations, true);
  assert.strictEqual(fromMacOS(null).source, 'macos');
});

test('the Cocoa app answers synchronously, and a change reaches the subscribers', () => {
  const native = fakeNative({ reduceMotion: true });
  const app = appOver(native);
  beginDesktopSettings(app);
  assert.strictEqual(desktopSettings(app).animations, false);
  assert.strictEqual(desktopSettings(app).source, 'macos');

  let heard = 0;
  const off = watchDesktopSettings(app, () => heard++);
  native.change({ reduceMotion: false });
  assert.strictEqual(heard, 1);
  assert.strictEqual(desktopSettings(app).animations, true);
  native.change({ increaseContrast: true });
  assert.strictEqual(heard, 2, 'every change notifies; the reader decides');
  assert.strictEqual(desktopSettings(app).animations, true);

  off();
  native.change({ reduceMotion: true });
  assert.strictEqual(heard, 2);
  assert.strictEqual(desktopSettings(app).animations, false, 'still read');
  endDesktopSettings(app);
  native.change({ reduceMotion: false });
  assert.strictEqual(heard, 2, 'nothing after the end');
});

test('a loop never starts under reduce motion, and starts when the switch flips', async () => {
  const native = fakeNative({ reduceMotion: true });
  const app = appOver(native);
  const root = await createRoot({ app });
  roots.push(root);
  root.render(
    h(
      'window',
      { width: 200, height: 100 },
      h('box', {
        style: {
          width: 80,
          height: 20,
          backgroundColor: '#ff0000',
          animation: {
            backgroundColor: { to: '#00ff00', duration: 900, alternate: true },
          },
        },
      }),
    ),
  );
  await tick();
  const wnd = [...app._windows.values()][0];
  const windowNode = wnd._reactX11Node;
  app._tickFrames(); // the first flush arms the loop's watch
  const box = windowNode.children[0];
  assert.ok(windowNode._loopNodes.has(box), 'the loop is registered');
  assert.ok(!box._anim?.size, 'and not running');
  assert.strictEqual(box.style.backgroundColor, '#ff0000', 'resting');

  native.change({ reduceMotion: false });
  assert.ok(box._anim?.get('backgroundColor')?.loop, 'running now');

  native.change({ reduceMotion: true });
  assert.ok(!box._anim?.size, 'and stopped again');
});

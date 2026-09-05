// `activateWindow()` on the cocoa backend (docs/macos.md §"Windowing
// semantics", the `activateWindow` row).
//
// There is no window manager and no `_NET_ACTIVE_WINDOW` here: the raise is
// `NSApp.activate` + `makeKeyAndOrderFront:`, which `CocoaApp.raiseWindow`
// performs against the bridge. The whole of this runs over a recording fake
// bridge — the shape of cocoa-surface.test.js — so it says nothing about
// glass, only that the right native calls go out and that the return value
// is the honest "did a window get raised" the X11 path promises.
//
// The regression it pins: before this wiring, `activateWindow(cocoaWindow)`
// returned `true` while doing nothing, because `app.X` is a shim whose
// `SendClientMessage` is a no-op — the exact "every layer reports success"
// failure the activate.js header warns about.
import assert from 'node:assert';
import { test } from 'node:test';

import { CocoaApp } from '../src/cocoa/app.js';
import { activateWindow } from '../src/activate.js';

/** A bridge shaped like @windowkit/appkit's, recording every call and
 * answering the few a window's construction needs a handle for. */
function fakeNative() {
  const calls = [];
  let seq = 0;
  return new Proxy(
    { calls, of: (name) => calls.filter((c) => c[0] === name) },
    {
      get(base, name) {
        if (name in base) return base[name];
        if (typeof name !== 'string') return undefined;
        return (...args) => {
          calls.push([name, ...args]);
          if (name === 'listScreens') {
            return [
              { x: 0, y: 0, width: 1440, height: 900, scale: 2, fps: 60 },
            ];
          }
          if (name === 'createWindow2') return { h: ++seq };
          if (name === 'windowNumber') return args[0].h;
          if (name === 'windowRootLayer') return { layer: args[0].h };
          if (name === 'getWindowFrame') {
            return { x: 0, y: 0, width: 640, height: 480 };
          }
          return undefined;
        };
      },
    },
  );
}

test('activateWindow raises the named window: NSApp.activate, then order front', () => {
  const native = fakeNative();
  const app = new CocoaApp(native);
  const wnd = app.createWindow({ width: 640, height: 480, title: 'x' });

  native.calls.length = 0; // ignore construction traffic
  assert.equal(activateWindow(wnd), true);

  // activateApp comes before showWindow, and showWindow asks to make the
  // window key (the `true` second argument) — an actual raise, not a
  // background order-front.
  const raise = native.calls.map((c) => c[0]);
  assert.ok(
    raise.indexOf('activateApp') >= 0 &&
      raise.indexOf('showWindow') > raise.indexOf('activateApp'),
    `activateApp then showWindow, got ${raise.join(', ')}`,
  );
  const [show] = native.of('showWindow');
  assert.equal(show[1], wnd._h, 'the named window');
  assert.equal(show[2], true, 'made key — a real raise');
});

test('a destroyed window raises nothing and says so', () => {
  const native = fakeNative();
  const app = new CocoaApp(native);
  const wnd = app.createWindow({ width: 200, height: 100 });
  wnd.destroy();

  native.calls.length = 0;
  assert.equal(activateWindow(wnd), false);
  assert.equal(native.of('activateApp').length, 0, 'no app activation either');
});

test('raiseWindow accepts the WindowNode that owns the window', () => {
  const native = fakeNative();
  const app = new CocoaApp(native);
  const wnd = app.createWindow({ width: 200, height: 100 });

  native.calls.length = 0;
  // the shape activate.js hands over when it infers the window: a node whose
  // `.window` is the CocoaWindow
  assert.equal(app.raiseWindow({ window: wnd }), true);
  assert.equal(native.of('showWindow')[0][1], wnd._h);
});

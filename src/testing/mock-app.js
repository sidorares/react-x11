// The mock ntk application used by the headless tests: enough of a window,
// a 2d context and an X connection for the renderer to run with no server.
import React from 'react';

import { setAppearanceForTests } from '../appearance.js';
import { setCompositingForTests } from '../compositing.js';
import { setScreensForTests } from '../screens.js';
import { loadLayout } from '../yoga.js';

// As in harness.js: a mock-app test must not register with a live AT-SPI
// registry on the machine running it.
process.env.NO_AT_BRIDGE ??= '1';

// The layout engine's WebAssembly loads in createRoot() rather than at import
// time — that is what keeps top-level await out of the bundle, and so lets an
// app ship as a single executable (see docs/packaging.md). A mock app never
// goes through createRoot, so the nodes built here would find no Yoga.Node.
await loadLayout();

export { React };

// A minimal stand-in for an ntk application object, so the renderer can be
// exercised without a running X server.
export function createMockApp() {
  // enough of an emitter for the connection watch in createRoot
  const listeners = {};
  const app = {
    X: {
      display: { screen: [{ root: 1 }] },
      keycode2keysyms: {},
      InternAtom(onlyIfExists, name, cb) {
        // unique ids, so per-name atom tables (src/dnd.js) work on the mock
        if (!app._atoms.has(name)) app._atoms.set(name, 1000 + app._atoms.size);
        cb(null, app._atoms.get(name));
      },
      ConfigureWindow(id, options) {
        app.configureCalls.push([id, options]);
      },
      // Startup notification broadcasts through this (src/startup.js), and
      // it is the only way to see the message: it goes to the root window,
      // which the mock does not model as a window with properties.
      SendClientMessage(destination, wid, type, format, data, eventMask) {
        app.clientMessages.push({
          destination,
          wid,
          type,
          format,
          data,
          eventMask,
        });
      },
      on(event, fn) {
        (listeners[event] ??= []).push(fn);
      },
      emit(event, ...args) {
        for (const fn of listeners[event] ?? []) fn(...args);
      },
    },
    configureCalls: [],
    clientMessages: [],
    _atoms: new Map([['WM_DELETE_WINDOW', 999]]),
    closed: 0,
    close() {
      app.closed++;
      return Promise.resolve();
    },
    // A clipboard that behaves like ntk's without a server: selections are
    // owned in this process, so a write is visible to the next read. Enough
    // for anything that copies or pastes — the ICCCM machinery itself is
    // tested against the real thing in test/clipboard.test.js.
    clipboard: {
      /** every write, in order: `{ data, selection, time }` */
      writes: [],
      /** selection name -> the target map currently owned */
      owned: new Map(),
      _watchers: new Map(),
      write(data, { selection = 'CLIPBOARD', time } = {}) {
        app.clipboard.writes.push({ data, selection, time });
        const map =
          typeof data === 'string'
            ? { UTF8_STRING: data, STRING: data }
            : { ...data };
        app.clipboard.owned.set(selection, map);
        for (const fn of app.clipboard._watchers.get(selection) ?? []) {
          fn({ selection, owner: 1, reason: 'new-owner' });
        }
        return Promise.resolve();
      },
      clear(selection = 'CLIPBOARD') {
        app.clipboard.owned.delete(selection);
        for (const fn of app.clipboard._watchers.get(selection) ?? []) {
          fn({ selection, owner: 0, reason: 'new-owner' });
        }
        return Promise.resolve();
      },
      targets({ selection = 'CLIPBOARD' } = {}) {
        return Promise.resolve([
          ...Object.keys(app.clipboard.owned.get(selection) ?? {}),
        ]);
      },
      read({ selection = 'CLIPBOARD', target } = {}) {
        const map = app.clipboard.owned.get(selection);
        if (!map) {
          return Promise.reject(
            new Error(
              `clipboard: nothing to paste — ${selection} has no owner`,
            ),
          );
        }
        if (target === undefined) {
          const text = map.UTF8_STRING ?? map.STRING;
          return text === undefined
            ? Promise.reject(
                new Error('clipboard: owner refused both text targets'),
              )
            : Promise.resolve(text);
        }
        if (!(target in map)) {
          return Promise.reject(
            new Error(`clipboard: owner cannot convert to ${target}`),
          );
        }
        const value = map[target];
        return Promise.resolve(
          typeof value === 'string' ? Buffer.from(value, 'utf8') : value,
        );
      },
      watch(selection, handler) {
        const list = app.clipboard._watchers.get(selection) ?? [];
        list.push(handler);
        app.clipboard._watchers.set(selection, list);
        return Promise.resolve(() => {
          const at = list.indexOf(handler);
          if (at !== -1) list.splice(at, 1);
        });
      },
    },
    windows: [],
    // A display that does have a 32-bit TrueColor visual, so `<window
    // transparent>` takes its real path here. Delete it from the app to
    // model the displays that do not (XQuartz), where the renderer falls
    // back to an opaque window.
    findArgbVisual() {
      return { visual: 0x21, depth: 32 };
    },
    // …and one with a compositor running — see the bottom of this function,
    // where that half is seeded.
    createWindow(attributes) {
      const handlers = {};
      const ops = [];
      const ctx = {
        ops,
        fillStyle: null,
        strokeStyle: null,
        lineWidth: 1,
        fillRect(x, y, w, h) {
          ops.push(['fillRect', x, y, w, h, ctx.fillStyle]);
        },
        // A batch is `fillRect` per rectangle — that is what ntk's own
        // `fillRects` promises, and the only difference there is the request
        // count, which a mock with no server does not have. So it records
        // the fills themselves: an assertion on what was drawn holds whether
        // the drawing batched or not, and `[x, y, w, h]` quadruples and one
        // flat list are the same drawing too.
        fillRects(rects) {
          const flat = Array.isArray(rects?.[0]) ? rects.flat() : (rects ?? []);
          for (let i = 0; i + 3 < flat.length; i += 4) {
            if (flat[i + 2] > 0 && flat[i + 3] > 0) {
              ctx.fillRect(flat[i], flat[i + 1], flat[i + 2], flat[i + 3]);
            }
          }
        },
        // ntk's context has this beside `fillRect`, so an `onDraw` that
        // outlines a box paints on a real server and used to crash on the
        // mock — a missing method here is an app's headless test failing at
        // something that works
        strokeRect(x, y, w, h) {
          ops.push(['strokeRect', x, y, w, h, ctx.strokeStyle, ctx.lineWidth]);
        },
        beginPath() {},
        clearRect(x, y, w, h) {
          ops.push(['clearRect', x, y, w, h]);
        },
        rect(x, y, w, h) {
          ops.push(['rect', x, y, w, h]);
        },
        roundRect(x, y, w, h, r) {
          ops.push(['roundRect', x, y, w, h, r]);
        },
        fill() {
          ops.push(['fill', ctx.fillStyle]);
        },
        stroke() {
          ops.push(['stroke', ctx.strokeStyle, ctx.lineWidth]);
        },
        clip() {
          ops.push(['clip']);
        },
        save() {
          ops.push(['save']);
        },
        restore() {
          ops.push(['restore']);
        },
        translate(x, y) {
          ops.push(['translate', x, y]);
        },
        setLineDash(segments) {
          ops.push(['setLineDash', segments]);
        },
        moveTo(x, y) {
          ops.push(['moveTo', x, y]);
        },
        lineTo(x, y) {
          ops.push(['lineTo', x, y]);
        },
        closePath() {
          ops.push(['closePath']);
        },
        drawImage(...args) {
          ops.push(['drawImage']);
        },
        // enough of the canvas surface for SvgView.draw to run headlessly
        scale(sx, sy) {
          ops.push(['scale', sx, sy]);
        },
        transform() {},
        setTransform() {},
        getTransform() {
          return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
        },
        arc() {},
        ellipse() {},
        bezierCurveTo() {},
        quadraticCurveTo() {},
        createLinearGradient() {
          return { addColorStop() {} };
        },
        createRadialGradient() {
          return { addColorStop() {} };
        },
      };
      const wnd = {
        id: app.windows.length + 100,
        X: app.X,
        attributes,
        x: attributes.x,
        y: attributes.y,
        width: attributes.width,
        height: attributes.height,
        title: attributes.title,
        mapped: false,
        destroyed: false,
        parent: null,
        calls: [],
        ctx,
        map() {
          wnd.mapped = true;
          wnd.calls.push(['map']);
        },
        unmap() {
          wnd.mapped = false;
          wnd.calls.push(['unmap']);
        },
        reparentTo(parent, x, y) {
          wnd.parent = parent;
          wnd.calls.push(['reparentTo', parent.id, x, y]);
        },
        destroy() {
          wnd.destroyed = true;
          wnd.calls.push(['destroy']);
        },
        // ntk >= 3.7.0: menus hold a pointer grab while they are up
        grabPointer(options, cb) {
          wnd.grabbed = true;
          wnd.calls.push(['grabPointer']);
          cb?.(null, 0);
        },
        ungrabPointer() {
          wnd.grabbed = false;
          wnd.calls.push(['ungrabPointer']);
        },
        resize(width, height) {
          wnd.width = width;
          wnd.height = height;
          wnd.calls.push(['resize', width, height]);
        },
        move(x, y) {
          wnd.x = x;
          wnd.y = y;
          wnd.calls.push(['move', x, y]);
        },
        setTitle(title) {
          wnd.title = title;
          wnd.calls.push(['setTitle', title]);
        },
        setSizeHints(hints) {
          wnd.calls.push(['setSizeHints', hints]);
        },
        setClass(instance, className) {
          wnd.calls.push(['setClass', instance, className]);
        },
        setWindowType(type) {
          wnd.calls.push(['setWindowType', type]);
        },
        // ntk >= 4.3: ICCCM WM_TRANSIENT_FOR
        setTransientFor(owner) {
          wnd.transientFor = owner;
          wnd.calls.push(['setTransientFor', owner]);
        },
        setAlwaysOnTop(on) {
          wnd.calls.push(['setAlwaysOnTop', on]);
        },
        // ntk >= 4.1: the general _NET_WM_STATE surface. Resolves to whether
        // the WM advertises the state; the mock says yes.
        setWmState(names, action = 'add') {
          wnd.calls.push(['setWmState', names, action]);
          return Promise.resolve(true);
        },
        getWmStates() {
          return Promise.resolve(wnd.wmStates ?? []);
        },
        setProperty(name, value, options) {
          wnd.calls.push(['setProperty', name, value, options]);
          return Promise.resolve(wnd);
        },
        deleteProperty(name) {
          wnd.calls.push(['deleteProperty', name]);
          return Promise.resolve(wnd);
        },
        setActions() {
          wnd.calls.push(['setActions']);
        },
        setCursor(name) {
          wnd.cursor = name;
          wnd.calls.push(['setCursor', name]);
        },
        getContext() {
          return ctx;
        },
        // ntk >= 4.3 (sidorares/ntk#139): the scroll-blit fast path. Records
        // and accepts; a test wanting the fallback deletes the method or
        // replaces it with one returning false.
        scrollRegion(rect, dx, dy) {
          wnd.calls.push(['scrollRegion', rect, dx, dy]);
          return true;
        },
        // ntk >= 5.2 (sidorares/ntk#148): the frame-clock gate a discrete
        // input's paint goes through (issue #141). No server here to fall
        // behind, so
        // it is open unless a test closes it — set `wnd.frameInFlight` to a
        // function of your own, or flip `wnd._frameInFlight`, to model a
        // connection that has not acknowledged the last frame.
        frameInFlight() {
          return Boolean(wnd._frameInFlight);
        },
        on(name, fn) {
          (handlers[name] ??= []).push(fn);
        },
        emit(name, ev) {
          for (const fn of handlers[name] ?? []) fn(ev);
        },
      };
      app.windows.push(wnd);
      return wnd;
    },
  };
  // The mock display composites. Seeded here rather than probed, because
  // there is no X connection to ask — and seeding it means `createRoot`
  // finds a session already open and leaves it alone. Tests that want the
  // other half of the matrix — ARGB visuals with nothing blending them,
  // where a transparent corner would render black — call
  // `setCompositingForTests(app, false)` before rendering.
  setCompositingForTests(app, true);
  // And the desktop's appearance, for the same reason and a sharper one: the
  // built-in palette follows the system, so an unpinned test renders in
  // whatever colours the developer's own desktop happens to be in. Pinned to
  // "no desktop said anything", which is the truth here and resolves to the
  // light palette. `setAppearanceForTests({ colorScheme: 'dark' })` is the
  // other half of the matrix.
  setAppearanceForTests({});
  // And a monitor, for the third reason of the same kind: a `<window>` with
  // no size is sized from its content and capped at the screen, and a mock
  // with no screen to cap against would let a headless test grow a window to
  // a size no desktop would ever have given it. One 1280x800 output, which
  // is a modest laptop — big enough not to be in the way of a test that is
  // about something else, small enough that a test about the cap can reach
  // it. `setScreensForTests(app, {})` takes it away again.
  setScreensForTests(app, {
    monitors: [{ x: 0, y: 0, width: 1280, height: 800 }],
  });
  return app;
}

/** Move the pointer inside a window, in window coordinates. */
export function moveMouse(wnd, x, y) {
  wnd.emit('mousemove', { x, y });
}

/** Press and release button 1 at a point; pass {release:false} to hold. */
export function pressButton(wnd, x, y, { press = true, release = true } = {}) {
  if (press) wnd.emit('mousedown', { x, y, keycode: 1 });
  if (release) wnd.emit('mouseup', { x, y, keycode: 1 });
}

/**
 * A scroll at a point, in **notches** — ntk's `wheel` event, which is what
 * the renderer reads whether the connection had XI2 or only the wheel
 * buttons behind it.
 *
 * A notch is one click of a wheel, and a fraction of one is what a touchpad
 * measures, so `{ deltaY: 0.25, smooth: true }` is a quarter of a notch from
 * a device that can do that — the case the emulated buttons cannot express
 * and a test of smooth scrolling is about. `buttons` takes the X modifier
 * mask, for the Shift that turns a vertical wheel sideways.
 */
export function spinWheel(
  wnd,
  x,
  y,
  { deltaX = 0, deltaY = 1, smooth = false, buttons = 0 } = {},
) {
  wnd.emit('wheel', {
    name: 'wheel',
    x,
    y,
    rootx: x,
    rooty: y,
    buttons,
    deltaX,
    deltaY,
    deltaMode: 'line',
    smooth,
    source: smooth ? 'valuator' : 'button',
  });
}

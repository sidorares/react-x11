// The mock ntk application used by the headless tests: enough of a window,
// a 2d context and an X connection for the renderer to run with no server.
import React from 'react';
import { loadLayout } from 'ntk';

// ntk 5 loads the layout engine's WebAssembly in createClient() rather than
// at import time — that is what keeps top-level await out of the bundle, and
// so lets an app ship as a single executable (see docs/packaging.md). A mock
// app never connects, so the nodes built here would find no Yoga.Node.
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
        cb(null, name === 'WM_DELETE_WINDOW' ? 999 : 1);
      },
      ConfigureWindow(id, options) {
        app.configureCalls.push([id, options]);
      },
      on(event, fn) {
        (listeners[event] ??= []).push(fn);
      },
      emit(event, ...args) {
        for (const fn of listeners[event] ?? []) fn(...args);
      },
    },
    configureCalls: [],
    closed: 0,
    close() {
      app.closed++;
      return Promise.resolve();
    },
    windows: [],
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
        beginPath() {},
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

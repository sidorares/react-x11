// Drag and drop on the cocoa backend (src/cocoa/dnd.js, @windowkit/appkit
// >= 0.5): AppKit's destination questions driving the same DropSession the
// XDND wire drives, the answer set inside the callback, the payload read at
// the drop; and a DragSession handing its gesture to a native session,
// with a drop on our own window keeping the live payload. Headless over a
// recording fake bridge — what reaches AppKit and what comes back, never
// the pasteboard itself.
import assert from 'node:assert';
import { afterEach, describe, test } from 'node:test';
import React from 'react';

import { createRoot } from '../src/index.js';
import { CocoaApp } from '../src/cocoa/app.js';
import {
  BASE_DROP_UTIS,
  mimeFromUti,
  offeredTypes,
  readPayload,
  requestedAction,
  utiFromMime,
} from '../src/cocoa/dnd.js';
import { setScaleForTests } from '../src/scale.js';
import { setScreensForTests } from '../src/screens.js';
import { setCompositingForTests } from '../src/compositing.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Let the commit land and the first frame lay the tree out — the fake
 * app has no pump, so its frame clock is ticked by hand. */
async function settle(app) {
  await tick();
  app._tickFrames();
  await tick();
}

/** The OS type database, as far as these tests need one. */
const DYN = (mime) => `dyn.${Buffer.from(mime).toString('hex')}`;

function fakeNative() {
  let cb = null;
  let seq = 0;
  const base = {
    calls: [],
    of: (name) =>
      base.calls.filter((c) => c[0] === name).map((c) => c.slice(1)),
    /** the pasteboard a drop reads: [{ [uti]: value }] */
    pasteboard: [],
    emit(ev) {
      cb?.(ev);
    },
    setBackendEventCallback(fn) {
      cb = fn;
    },
    initApp() {},
    registerDropTypes(win, types) {
      base.calls.push(['registerDropTypes', win.id, types]);
    },
    setDropResponse(win, response) {
      base.calls.push(['setDropResponse', win.id, response]);
    },
    dragItems: () =>
      base.pasteboard.map((item) => ({ types: Object.keys(item) })),
    dragItemString: (i, type) => {
      const v = base.pasteboard[i]?.[type];
      return typeof v === 'string' ? v : null;
    },
    dragItemData: (i, type) => {
      const v = base.pasteboard[i]?.[type];
      return v == null ? null : Buffer.isBuffer(v) ? v : Buffer.from(String(v));
    },
    beginDrag(win, spec) {
      base.calls.push(['beginDrag', win.id, spec]);
      return { session: ++seq };
    },
    pasteboardTypeForMIME: (mime) => DYN(mime),
    pasteboardTypeInfo: (uti) =>
      uti.startsWith('dyn.')
        ? { identifier: uti, mime: Buffer.from(uti.slice(4), 'hex').toString() }
        : null,
    listScreens: () => [
      { x: 0, y: 0, width: 1440, height: 900, scale: 2, fps: 60 },
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

/** A destination event in the bridge's shape; the window's origin is 0,0
 * and the scale 2, so a content point (x, y) is device (2x, 2y). */
function dragEvent(type, windowNumber, x, y, extra = {}) {
  return {
    type,
    windowNumber,
    x,
    y,
    gx: x,
    gy: y,
    types: ['public.file-url', 'NSFilenamesPboardType'],
    itemCount: 1,
    sourceMask: 1,
    operations: ['copy', 'generic'],
    local: false,
    sequence: 1,
    ...extra,
  };
}

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await root.unmount();
});

// --- the translation ------------------------------------------------------------

describe('types', () => {
  test('UTIs and MIME map both ways, through the table and the OS database', () => {
    const native = fakeNative();
    assert.equal(mimeFromUti('public.file-url', native), 'text/uri-list');
    assert.equal(mimeFromUti('public.png', native), 'image/png');
    assert.equal(
      mimeFromUti(DYN('application/x-myapp-row'), native),
      'application/x-myapp-row',
    );
    assert.equal(mimeFromUti('NSFilenamesPboardType', native), null);
    assert.equal(utiFromMime('text/plain', native), 'public.utf8-plain-text');
    assert.equal(utiFromMime('UTF8_STRING', native), 'public.utf8-plain-text');
    assert.equal(
      utiFromMime('application/x-myapp-row', native),
      DYN('application/x-myapp-row'),
    );
    assert.equal(utiFromMime('_NETSCAPE_URL', native), null, 'not a MIME type');
  });

  test('what a pasteboard offers, in react-x11 words, plain text beside the charset one', () => {
    const native = fakeNative();
    assert.deepEqual(
      offeredTypes(
        ['public.utf8-plain-text', 'NSStringPboardType', 'public.file-url'],
        native,
      ),
      ['text/plain;charset=utf-8', 'text/plain', 'text/uri-list'],
    );
    assert.equal(requestedAction(['move', 'copy']), 'copy');
    assert.equal(requestedAction(['generic', 'move']), 'move');
    assert.equal(requestedAction(undefined), 'copy');
  });

  test('the payload read at the drop: three Finder files become one uri-list', () => {
    const native = fakeNative();
    native.pasteboard = [
      { 'public.file-url': 'file:///tmp/a%20b.txt' },
      { 'public.file-url': 'file:///tmp/c.txt' },
      { 'public.file-url': 'file:///tmp/d.txt', 'public.utf8-plain-text': 'd' },
    ];
    const extras = readPayload(native, ['text/uri-list', 'text/plain']);
    assert.deepEqual(
      extras.files.map((f) => f.path),
      ['/tmp/a b.txt', '/tmp/c.txt', '/tmp/d.txt'],
    );
    assert.equal(extras.text, 'd');
    assert.equal(extras.items['text/plain'], 'd');
  });
});

// --- the destination -------------------------------------------------------------

describe('the drop side', () => {
  test('a window registers the base types, and the concrete ones its targets ask for', async () => {
    const native = fakeNative();
    const app = appOver(native);
    const root = await createRoot({ app });
    roots.push(root);
    root.render(h('window', { width: 300, height: 200 }, h('box')));
    await tick();
    assert.deepEqual(native.of('registerDropTypes')[0][1], BASE_DROP_UTIS);

    root.render(
      h(
        'window',
        { width: 300, height: 200 },
        h('box', {
          dropAccept: ['files', 'application/x-myapp-row'],
          onDrop: () => {},
        }),
      ),
    );
    await tick();
    const last = native.of('registerDropTypes').at(-1)[1];
    assert.ok(last.includes(DYN('application/x-myapp-row')), 'the app type');
    assert.equal(last.length, BASE_DROP_UTIS.length + 1, 'groups add none');
  });

  test('enter/over answer inside the callback from dropAccept; :drag-over follows; the drop delivers files', async () => {
    const native = fakeNative();
    const app = appOver(native);
    const root = await createRoot({ app });
    roots.push(root);
    const log = [];
    const zone = React.createRef();
    root.render(
      h(
        'window',
        { width: 300, height: 200 },
        h('box', {
          ref: zone,
          dropAccept: ['files'],
          onDragEnter: (e) => log.push(['enter', e.source, e.types.join(',')]),
          onDragOver: (e) => e.accept('copy'),
          onDragLeave: () => log.push(['leave']),
          onDrop: (e) =>
            log.push(['drop', e.files.map((f) => f.path), e.text, e.action]),
          style: {
            position: 'absolute',
            left: 0,
            top: 0,
            width: 100,
            height: 100,
          },
        }),
        h('box', {
          style: {
            position: 'absolute',
            left: 100,
            top: 0,
            width: 100,
            height: 100,
          },
        }),
      ),
    );
    await settle(app);
    const wnd = [...app._windows.values()][0];
    const n = wnd.windowNumber;

    // over the zone (content point 20,20 → device 40,40)
    native.emit(dragEvent('drag-enter', n, 20, 20));
    let response = native.of('setDropResponse').at(-1)[1];
    assert.deepEqual(response, { accept: true, operation: 'copy' });
    assert.deepEqual(log[0], ['enter', 'external', 'text/uri-list']);
    assert.equal(zone.current.states[':drag-over'], true);

    // over the other box (points 100..200): refused, the zone left
    native.emit(dragEvent('drag-over', n, 150, 20));
    response = native.of('setDropResponse').at(-1)[1];
    assert.deepEqual(response, { accept: false });
    assert.deepEqual(log[1], ['leave']);
    assert.equal(zone.current.states[':drag-over'], false);

    // back, and dropped
    native.emit(dragEvent('drag-over', n, 20, 30));
    native.pasteboard = [{ 'public.file-url': 'file:///tmp/one.txt' }];
    native.emit(dragEvent('drag-perform', n, 20, 30));
    await tick();
    const drop = log.find((l) => l[0] === 'drop');
    assert.deepEqual(drop, ['drop', ['/tmp/one.txt'], undefined, 'copy']);
    assert.deepEqual(native.of('setDropResponse').at(-1)[1], {
      accept: true,
      operation: 'copy',
    });
    assert.equal(zone.current.states[':drag-over'], false, 'the path cleared');
  });

  test('a type nothing accepts is refused from dropAccept data alone, and exit clears', async () => {
    const native = fakeNative();
    const app = appOver(native);
    const root = await createRoot({ app });
    roots.push(root);
    const zone = React.createRef();
    root.render(
      h(
        'window',
        { width: 300, height: 200 },
        h('box', {
          ref: zone,
          dropAccept: ['files'],
          onDrop: () => {},
          style: { width: 300, height: 200 },
        }),
      ),
    );
    await settle(app);
    const n = [...app._windows.values()][0].windowNumber;
    native.emit(dragEvent('drag-enter', n, 10, 10, { types: ['public.png'] }));
    assert.deepEqual(native.of('setDropResponse').at(-1)[1], { accept: false });
    native.emit(
      dragEvent('drag-enter', n, 10, 10, { types: ['public.file-url'] }),
    );
    assert.equal(zone.current.states[':drag-over'], true);
    native.emit({ type: 'drag-exit', windowNumber: n });
    assert.equal(zone.current.states[':drag-over'], false);
  });
});

// --- the source ------------------------------------------------------------------

describe('the drag side', () => {
  const press = (wnd, x, y) =>
    wnd.emit('mousedown', {
      x,
      y,
      rootx: x,
      rooty: y,
      keycode: 1,
      buttons: 0,
      time: 1,
    });
  const move = (wnd, x, y) =>
    wnd.emit('mousemove', {
      x,
      y,
      rootx: x,
      rooty: y,
      buttons: 256,
      time: 2,
    });

  test('crossing the threshold hands the gesture to AppKit with the payload as pasteboard items', async () => {
    const native = fakeNative();
    const app = appOver(native);
    const root = await createRoot({ app });
    roots.push(root);
    const log = [];
    const source = React.createRef();
    const row = { id: 7 };
    root.render(
      h(
        'window',
        { width: 300, height: 200 },
        h('box', {
          ref: source,
          draggable: true,
          dragData: {
            'application/x-myapp-row': row,
            'text/uri-list': () => 'file:///tmp/a.txt\r\nfile:///tmp/b.txt\r\n',
            'text/plain': 'plain',
          },
          dragActions: ['move', 'copy'],
          onDragStart: (e) => log.push(['start', e.source]),
          onDrag: (e) => log.push(['drag', e.screenX, e.accepted]),
          onDragEnd: (e) => log.push(['end', e.action, e.dropped]),
          onClick: () => log.push(['click']),
          style: {
            position: 'absolute',
            left: 0,
            top: 0,
            width: 100,
            height: 100,
          },
        }),
      ),
    );
    await settle(app);
    const wnd = [...app._windows.values()][0];
    press(wnd, 50, 50);
    move(wnd, 70, 50); // past the threshold
    await tick();
    assert.deepEqual(log[0], ['start', 'internal']);
    assert.equal(source.current.states[':dragging'], true);
    assert.equal(app._activeDrag?.source, source.current, 'AppKit has it');

    const [[, spec]] = native.of('beginDrag');
    assert.deepEqual([spec.x, spec.y], [25, 25], 'the press, in points');
    assert.deepEqual(spec.operations, ['move', 'copy']);
    // one item per file, the rest on the first
    assert.equal(spec.items.length, 2);
    assert.equal(spec.items[0]['public.file-url'], 'file:///tmp/a.txt');
    assert.equal(spec.items[1]['public.file-url'], 'file:///tmp/b.txt');
    assert.equal(spec.items[0]['public.utf8-plain-text'], 'plain');
    assert.equal(
      spec.items[0][DYN('application/x-myapp-row')],
      JSON.stringify(row),
      'a live object is JSON on the wire',
    );
    // motion no longer feeds the session; AppKit reports it
    move(wnd, 90, 50);
    native.emit({ type: 'drag-session-moved', x: 200, y: 60 });
    assert.deepEqual(log.at(-1), ['drag', 200, false]);

    native.emit({
      type: 'drag-session-ended',
      x: 200,
      y: 60,
      operation: 'copy',
      dropped: true,
    });
    await tick();
    assert.deepEqual(log.at(-1), ['end', 'copy', true]);
    assert.equal(source.current.states[':dragging'], false);
    assert.equal(app._activeDrag, null);
    assert.ok(!log.some((l) => l[0] === 'click'));
  });

  test('a drop on our own window keeps the payload by reference', async () => {
    const native = fakeNative();
    const app = appOver(native);
    const root = await createRoot({ app });
    roots.push(root);
    const log = [];
    const row = { id: 42 };
    root.render(
      h(
        'window',
        { width: 400, height: 200 },
        h('box', {
          draggable: true,
          dragData: { 'application/x-demo-row': row, 'text/plain': 'p' },
          dragActions: ['move', 'copy'],
          onDragEnd: (e) => log.push(['end', e.action, e.dropped]),
          style: {
            position: 'absolute',
            left: 0,
            top: 0,
            width: 100,
            height: 100,
          },
        }),
        h('box', {
          dropAccept: ['application/x-demo-row'],
          onDragOver: (e) => e.accept('move'),
          onDrop: (e) =>
            log.push([
              'drop',
              e.source,
              e.items['application/x-demo-row'],
              e.text,
            ]),
          style: {
            position: 'absolute',
            left: 200,
            top: 0,
            width: 150,
            height: 150,
          },
        }),
      ),
    );
    await settle(app);
    const wnd = [...app._windows.values()][0];
    const n = wnd.windowNumber;
    press(wnd, 50, 50);
    move(wnd, 70, 50);
    await tick();
    assert.equal(native.of('beginDrag').length, 1);

    // AppKit brings the drag back over our own window: local, our payload,
    // and the source's own operation mask (dragActions: move, copy)
    const local = {
      local: true,
      sourceWindowNumber: n,
      types: [],
      operations: ['move', 'copy'],
    };
    native.emit(dragEvent('drag-enter', n, 250, 30, local));
    assert.deepEqual(native.of('setDropResponse').at(-1)[1], {
      accept: true,
      operation: 'move',
    });
    native.emit(dragEvent('drag-perform', n, 250, 30, local));
    await tick();
    assert.deepEqual(log[0], ['drop', 'internal', row, 'p']);
    native.emit({
      type: 'drag-session-ended',
      x: 250,
      y: 30,
      operation: 'move',
      dropped: true,
    });
    await tick();
    assert.deepEqual(log[1], ['end', 'move', true]);
  });

  test('a thunk is a promise the bridge asks provide() to keep', async () => {
    const native = fakeNative();
    const app = appOver(native);
    const root = await createRoot({ app });
    roots.push(root);
    let asked = 0;
    root.render(
      h(
        'window',
        { width: 300, height: 200 },
        h('box', {
          draggable: true,
          dragData: {
            'image/png': () => {
              asked++;
              return Buffer.from([1, 2, 3]);
            },
          },
          style: { width: 100, height: 100 },
        }),
      ),
    );
    await settle(app);
    const wnd = [...app._windows.values()][0];
    press(wnd, 50, 50);
    move(wnd, 70, 50);
    await tick();
    const [[, spec]] = native.of('beginDrag');
    assert.equal(spec.items[0]['public.png'], null, 'promised, not built');
    assert.equal(asked, 0);
    const bytes = spec.provide('public.png', 0);
    assert.ok(Buffer.isBuffer(bytes));
    assert.equal(asked, 1);
    spec.provide('public.png', 0);
    assert.equal(asked, 1, 'resolved once per drag');
  });
});

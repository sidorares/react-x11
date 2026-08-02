// The drag source, both transports.
//
// In-app drags run against the mock app: the whole local transport —
// threshold, DragStart cancellation, :dragging/:drag-over, live e.items,
// click suppression — needs no X server at all. The external half runs
// against node-x11's in-process JS server with a *fake XDND target* on a
// second connection: it advertises XdndAware, receives the real
// Enter/Position/Drop ClientMessages, converts the selection through ntk's
// clipboard, and answers Status/Finished — wire bytes, not internals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import xserver from 'x11/lib/xserver/index.js';
import { createClient, StaticFontSource } from 'ntk';

import { createRoot } from '../src/index.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

// ntk events as the mock (and a real server) would deliver them; rootx
// defaults to window-relative because the mock's windows sit at 0,0
const down = (wnd, x, y, extra) =>
  wnd.emit('mousedown', {
    x,
    y,
    rootx: x,
    rooty: y,
    keycode: 1,
    buttons: 0,
    time: 100,
    ...extra,
  });
const move = (wnd, x, y, extra) =>
  wnd.emit('mousemove', {
    x,
    y,
    rootx: x,
    rooty: y,
    buttons: 256,
    time: 101,
    ...extra,
  });
const up = (wnd, x, y, extra) =>
  wnd.emit('mouseup', {
    x,
    y,
    rootx: x,
    rooty: y,
    keycode: 1,
    buttons: 0,
    time: 102,
    ...extra,
  });

async function renderMock(app, element) {
  const x11Root = await createRoot({ app });
  await new Promise((resolve) => x11Root.render(element, resolve));
  // layout runs on the frame after the commit; events before it hit nothing
  await tick();
  await tick();
  return x11Root;
}

// --- the in-app transport ---------------------------------------------------

test('below the threshold a draggable is still a click', async () => {
  const app = createMockApp();
  const log = [];
  const x11Root = await renderMock(
    app,
    h(
      'window',
      { width: 300, height: 200 },
      h('box', {
        draggable: true,
        dragData: { 'text/plain': 'hi' },
        onDragStart: () => log.push('dragstart'),
        onClick: () => log.push('click'),
        style: { width: 100, height: 100 },
      }),
    ),
  );
  const wnd = app.windows[0];
  down(wnd, 10, 10);
  move(wnd, 12, 11); // 3px: under the threshold
  up(wnd, 12, 11);
  await tick();
  assert.deepEqual(log, ['click'], 'no drag, and the click still fires');
  await x11Root.unmount();
});

test('an in-app drag: threshold, :dragging, live items, click suppression', async () => {
  const app = createMockApp();
  const log = [];
  const rowPayload = { id: 42, label: 'live' };
  const sourceRef = React.createRef();
  const targetRef = React.createRef();
  const x11Root = await renderMock(
    app,
    h(
      'window',
      { width: 400, height: 200 },
      h('box', {
        ref: sourceRef,
        draggable: true,
        dragData: {
          'application/x-demo-row': rowPayload,
          'text/uri-list': () => 'file:///tmp/a%20b.txt\r\n',
          'text/plain': 'plain fallback',
        },
        dragActions: ['move', 'copy'],
        onDragStart: (e) => log.push(['dragstart', e.types.length, e.source]),
        onDragEnd: (e) => log.push(['dragend', e.action, e.dropped]),
        onClick: () => log.push(['click']),
        style: {
          position: 'absolute',
          left: 0,
          top: 0,
          width: 100,
          height: 100,
        },
      }),
      h('box', {
        ref: targetRef,
        dropAccept: ['application/x-demo-row'],
        onDragEnter: (e) => log.push(['enter', e.source]),
        onDragOver: (e) => e.accept('move'),
        onDrop: (e) =>
          log.push([
            'drop',
            e.items['application/x-demo-row'],
            e.files,
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
  const wnd = app.windows[0];

  down(wnd, 50, 50);
  move(wnd, 60, 50); // past the threshold: the drag starts
  await tick();
  assert.deepEqual(log[0], ['dragstart', 3, 'internal']);
  assert.equal(sourceRef.current.states[':dragging'], true);

  move(wnd, 250, 60); // over the dropzone
  await tick();
  assert.deepEqual(log[1], ['enter', 'internal']);
  assert.equal(targetRef.current.states[':drag-over'], true);

  up(wnd, 250, 60);
  await tick();
  const dropEntry = log.find((l) => l[0] === 'drop');
  assert.ok(dropEntry, 'the drop dispatched');
  assert.equal(
    dropEntry[1],
    rowPayload,
    'e.items carries the value by reference',
  );
  assert.deepEqual(
    dropEntry[2],
    [{ uri: 'file:///tmp/a%20b.txt', path: '/tmp/a b.txt' }],
    'the uri-list thunk resolved and parsed, same shape as an external drop',
  );
  assert.equal(dropEntry[3], 'plain fallback', 'e.text from the text flavour');
  assert.deepEqual(
    log.at(-1),
    ['dragend', 'move', true],
    'onDragOver accept(move) won',
  );
  assert.equal(sourceRef.current.states[':dragging'], false);
  assert.equal(targetRef.current.states[':drag-over'], false);
  assert.ok(
    !log.some((l) => l[0] === 'click'),
    'a completed drag is not a click',
  );
  await x11Root.unmount();
});

test('a drag released over nothing ends with action null; mismatched accept rejects', async () => {
  const app = createMockApp();
  const log = [];
  const x11Root = await renderMock(
    app,
    h(
      'window',
      { width: 400, height: 200 },
      h('box', {
        draggable: true,
        dragData: { 'text/plain': 'x' },
        onDragEnd: (e) => log.push(['dragend', e.action, e.dropped]),
        style: {
          position: 'absolute',
          left: 0,
          top: 0,
          width: 100,
          height: 100,
        },
      }),
      h('box', {
        dropAccept: ['image/png'], // never matches text/plain
        onDrop: () => log.push(['drop']),
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
  const wnd = app.windows[0];
  down(wnd, 50, 50);
  move(wnd, 70, 50);
  move(wnd, 250, 60); // over the rejecting zone
  up(wnd, 250, 60);
  await tick();
  assert.deepEqual(log, [['dragend', null, false]], 'no drop, no action');
  await x11Root.unmount();
});

test('preventDefault in onDragStart cancels: the gesture stays a click', async () => {
  const app = createMockApp();
  const log = [];
  const x11Root = await renderMock(
    app,
    h(
      'window',
      { width: 300, height: 200 },
      h('box', {
        draggable: true,
        dragData: { 'text/plain': 'x' },
        onDragStart: (e) => {
          log.push('dragstart');
          e.preventDefault();
        },
        onDrag: () => log.push('drag'),
        onClick: () => log.push('click'),
        style: { width: 100, height: 100 },
      }),
    ),
  );
  const wnd = app.windows[0];
  down(wnd, 10, 10);
  move(wnd, 40, 40);
  move(wnd, 60, 60);
  up(wnd, 60, 60);
  await tick();
  assert.deepEqual(
    log,
    ['dragstart', 'click'],
    'cancelled: no onDrag, click intact',
  );
  await x11Root.unmount();
});

// --- the external transport (XDND out) --------------------------------------

const SCREEN = { width: 800, height: 600 };

async function headlessPair() {
  const server = xserver.createServer(SCREEN);
  const connect = async (onXError) => {
    const [serverEnd, clientEnd] = xserver.createStreamPair();
    server.addClientStream(serverEnd);
    return createClient({
      stream: clientEnd,
      fontSource: new StaticFontSource(),
      ...(onXError ? { onXError } : {}),
    });
  };
  // our app swallows X errors: cursor-font glyph loads on the bare JS
  // server are best-effort
  return { server, app: await connect(() => {}), targetApp: await connect() };
}

const settle = (app) =>
  new Promise((resolve) => app.X.GetInputFocus(() => setImmediate(resolve)));

/** Drain round trips on every involved connection until `predicate` holds —
 * a drag is a conversation, and both sides need the event loop. */
async function until(apps, predicate, what) {
  const list = Array.isArray(apps) ? apps : [apps];
  for (let i = 0; i < 300; i++) {
    if (predicate()) return;
    for (const app of list) await settle(app);
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** The other application: one window, XdndAware, answering the real
 * protocol from the target side. */
class FakeTarget {
  constructor(app, { x, y, width, height, accept = true }) {
    this.app = app;
    this.X = app.X;
    this.accept = accept;
    this.received = [];
    this.wnd = app.createWindow({ x, y, width, height });
    this.wnd.map?.();
  }

  async init() {
    const names = [
      'XdndAware',
      'XdndEnter',
      'XdndPosition',
      'XdndStatus',
      'XdndLeave',
      'XdndDrop',
      'XdndFinished',
      'XdndActionCopy',
      'XdndActionMove',
    ];
    this.atoms = {};
    await Promise.all(
      names.map(
        (name) =>
          new Promise((resolve, reject) =>
            this.X.InternAtom(false, name, (err, atom) => {
              if (err) return reject(err);
              this.atoms[name] = atom;
              resolve();
            }),
          ),
      ),
    );
    await this.wnd.setProperty('XdndAware', [5], { type: 'ATOM' });
    this.X.on('event', (ev) => {
      if (ev.type !== 33) return;
      this.received.push(ev);
      if (ev.message_type === this.atoms.XdndPosition) {
        // accept (or refuse) with the requested action, no suppression
        const source = ev.data[0];
        this.X.SendClientMessage(
          source,
          source,
          this.atoms.XdndStatus,
          32,
          [
            this.wnd.id,
            this.accept ? 1 | 2 : 0,
            0,
            0,
            this.accept ? ev.data[4] : 0,
          ],
          0,
        );
      }
      if (ev.message_type === this.atoms.XdndDrop) {
        const source = ev.data[0];
        // convert the selection like a real target, then confirm v5-style
        this.app.clipboard
          .read({ selection: 'XdndSelection', target: 'text/uri-list' })
          .then((data) => {
            this.converted = String(data);
          })
          .catch((err) => {
            this.convertError = err;
          })
          .then(() => {
            this.X.SendClientMessage(
              source,
              source,
              this.atoms.XdndFinished,
              32,
              [this.wnd.id, 1, this.atoms.XdndActionCopy, 0, 0],
              0,
            );
          });
      }
    });
  }

  ofType(name) {
    return this.received.filter((ev) => ev.message_type === this.atoms[name]);
  }
}

test('a drag out of the app speaks XDND: Enter, Position, Drop, Finished', async () => {
  const { app, targetApp } = await headlessPair();
  const x11Root = await createRoot({ app });
  try {
    const log = [];
    let dragged;
    const instance = await new Promise((resolve) =>
      x11Root.render(
        h(
          'window',
          { width: 300, height: 200 },
          h('box', {
            draggable: true,
            dragData: {
              'text/uri-list': () => {
                dragged = true;
                return 'file:///tmp/dragged.txt\r\n';
              },
              'text/plain': '/tmp/dragged.txt',
            },
            onDrag: (e) => log.push(['drag', e.source, e.accepted]),
            onDragEnd: (e) => log.push(['dragend', e.action, e.dropped]),
            style: { width: 100, height: 100 },
          }),
        ),
        resolve,
      ),
    );
    const target = new FakeTarget(targetApp, {
      x: 400,
      y: 0,
      width: 150,
      height: 150,
    });
    await target.init();
    await settle(app);
    await settle(app); // XdndAware + _screenOrigin land

    const wnd = instance; // the ntk window (render hands back the public instance)
    wnd.emit('mousedown', {
      x: 50,
      y: 50,
      rootx: 50,
      rooty: 50,
      keycode: 1,
      buttons: 0,
      time: 10,
    });
    wnd.emit('mousemove', {
      x: 70,
      y: 50,
      rootx: 70,
      rooty: 50,
      buttons: 256,
      time: 11,
    });
    assert.equal(dragged, undefined, 'thunks are not resolved at drag start');

    // leave our window (300 wide) for the fake target at x=400
    wnd.emit('mousemove', {
      x: 450,
      y: 60,
      rootx: 450,
      rooty: 60,
      buttons: 256,
      time: 12,
    });
    await until(
      [app, targetApp],
      () => target.ofType('XdndEnter').length > 0,
      'XdndEnter',
    );
    const enter = target.ofType('XdndEnter')[0];
    assert.equal(enter.data[1] >>> 24, 5, 'version 5, two types inline');
    assert.equal(enter.data[1] & 1, 0, 'no XdndTypeList needed for two types');
    assert.equal(dragged, true, 'promotion resolved the thunk for publication');

    await until(
      [app, targetApp],
      () => target.ofType('XdndPosition').length > 0,
      'XdndPosition',
    );
    const pos = target.ofType('XdndPosition')[0];
    assert.equal(pos.data[2] >>> 16, 450, 'root x');
    assert.equal(pos.data[2] & 0xffff, 60, 'root y');

    // the accepting XdndStatus surfaces on the *next* motion's onDrag —
    // keep the pointer twitching, as a real drag would
    await until(
      [app, targetApp],
      () => {
        wnd.emit('mousemove', {
          x: 451,
          y: 60,
          rootx: 451,
          rooty: 60,
          buttons: 256,
          time: 12,
        });
        return log.some((l) => l[0] === 'drag' && l[2] === true);
      },
      'accepted status reaching onDrag',
    );

    wnd.emit('mouseup', {
      x: 451,
      y: 60,
      rootx: 451,
      rooty: 60,
      keycode: 1,
      buttons: 0,
      time: 13,
    });
    await until(
      [app, targetApp],
      () => target.ofType('XdndDrop').length > 0,
      'XdndDrop',
    );
    await until(
      [app, targetApp],
      () => target.converted != null || target.convertError,
      'the conversion',
    );
    assert.equal(target.convertError, undefined, 'the selection converted');
    assert.equal(target.converted, 'file:///tmp/dragged.txt\r\n');

    await until(
      [app, targetApp],
      () => log.some((l) => l[0] === 'dragend'),
      'onDragEnd',
    );
    assert.deepEqual(log.at(-1), ['dragend', 'copy', true]);
    await x11Root.unmount();
  } finally {
    await app.close();
    await targetApp.close();
  }
});

test('a refusing target: Leave on release, dragend with no action', async () => {
  const { app, targetApp } = await headlessPair();
  const x11Root = await createRoot({ app });
  try {
    const log = [];
    const instance = await new Promise((resolve) =>
      x11Root.render(
        h(
          'window',
          { width: 300, height: 200 },
          h('box', {
            draggable: true,
            dragData: { 'text/plain': 'nope' },
            onDragEnd: (e) => log.push(['dragend', e.action, e.dropped]),
            style: { width: 100, height: 100 },
          }),
        ),
        resolve,
      ),
    );
    const target = new FakeTarget(targetApp, {
      x: 400,
      y: 0,
      width: 150,
      height: 150,
      accept: false,
    });
    await target.init();
    await settle(app);
    await settle(app);

    instance.emit('mousedown', {
      x: 50,
      y: 50,
      rootx: 50,
      rooty: 50,
      keycode: 1,
      buttons: 0,
      time: 10,
    });
    instance.emit('mousemove', {
      x: 70,
      y: 50,
      rootx: 70,
      rooty: 50,
      buttons: 256,
      time: 11,
    });
    instance.emit('mousemove', {
      x: 450,
      y: 60,
      rootx: 450,
      rooty: 60,
      buttons: 256,
      time: 12,
    });
    await until(
      [app, targetApp],
      () => target.ofType('XdndPosition').length > 0,
      'a position',
    );
    await settle(app); // let the refusing status arrive back

    instance.emit('mouseup', {
      x: 450,
      y: 60,
      rootx: 450,
      rooty: 60,
      keycode: 1,
      buttons: 0,
      time: 13,
    });
    await until([app, targetApp], () => log.length > 0, 'onDragEnd');
    assert.deepEqual(log, [['dragend', null, false]]);
    await until(
      [app, targetApp],
      () => target.ofType('XdndLeave').length > 0,
      'the refused target getting its XdndLeave',
    );
    assert.equal(target.ofType('XdndDrop').length, 0, 'and never a drop');
    await x11Root.unmount();
  } finally {
    await app.close();
    await targetApp.close();
  }
});

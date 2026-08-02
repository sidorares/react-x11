// XDND drop target, end to end and hermetic: react-x11 on one connection to
// node-x11's in-process X server, a fake drag source on a second — the
// test/wm.test.js pattern. The fake source speaks the wire protocol
// (ClientMessages, XdndSelection ownership via ntk's clipboard), so what is
// asserted here is byte-level interop, not internal calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import xserver from 'x11/lib/xserver/index.js';
import { createClient, StaticFontSource } from 'ntk';

import { createRoot } from '../src/index.js';
import { parseUriList, matchAccept, typeMatches } from '../src/dnd.js';

const SCREEN = { width: 800, height: 600 };
const XDND_VERSION = 5;

async function headlessPair() {
  const server = xserver.createServer(SCREEN);
  const connect = async () => {
    const [serverEnd, clientEnd] = xserver.createStreamPair();
    server.addClientStream(serverEnd);
    return createClient({
      stream: clientEnd,
      fontSource: new StaticFontSource(),
    });
  };
  return { server, app: await connect(), srcApp: await connect() };
}

const settle = (app) =>
  new Promise((resolve) => app.X.GetInputFocus(() => setImmediate(resolve)));

async function until(app, predicate, what) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await settle(app);
  }
  assert.fail(`timed out waiting for ${what}`);
}

function render(element, x11Root) {
  return new Promise((resolve) => {
    x11Root.render(element, (instance) => resolve(instance));
  });
}

/**
 * The other application: owns a window, owns XdndSelection through ntk's
 * clipboard (which answers TARGETS and serves the payload, INCR included),
 * and drives the drag with raw ClientMessages.
 */
class FakeSource {
  constructor(app) {
    this.app = app;
    this.X = app.X;
    this.wnd = app.createWindow({ width: 10, height: 10 });
    this.received = []; // ClientMessages sent back to us
    // SelectionRequests ntk's clipboard answers on our behalf. Observing
    // them is how the conversion timestamp is checked: XDND says a drop
    // must convert with the timestamp from XdndDrop, never CurrentTime.
    this.conversions = [];
    this.X.on('event', (ev) => {
      if (ev.type === 33) this.received.push(ev);
      if (ev.type === 30)
        this.conversions.push({ target: ev.target, time: ev.time });
    });
  }

  async init(payload) {
    const names = [
      'XdndAware',
      'XdndEnter',
      'XdndPosition',
      'XdndStatus',
      'XdndLeave',
      'XdndDrop',
      'XdndFinished',
      'XdndTypeList',
      'XdndActionCopy',
      'XdndActionMove',
      'XdndActionLink',
      'XdndActionAsk',
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
    if (payload) {
      await this.app.clipboard.write(payload, { selection: 'XdndSelection' });
    }
  }

  /** What a source that asks publishes on its own window: the actions it
   * will accept, and its own words for them, NUL-separated. */
  async offerAsk(actions, descriptions) {
    await this.wnd.setProperty(
      'XdndActionList',
      actions.map((a) => this.atoms[a]),
      { type: 'ATOM' },
    );
    const prop = await this.typeAtom('XdndActionDescription');
    const text = descriptions.length ? `${descriptions.join('\0')}\0` : '';
    this.X.ChangeProperty(
      0,
      this.wnd.id,
      prop,
      this.X.atoms.STRING,
      8,
      Buffer.from(text, 'utf8'),
    );
  }

  async typeAtom(name) {
    return new Promise((resolve, reject) =>
      this.X.InternAtom(false, name, (err, atom) =>
        err ? reject(err) : resolve(atom),
      ),
    );
  }

  _send(targetWid, type, data) {
    this.X.SendClientMessage(
      targetWid,
      targetWid,
      this.atoms[type],
      32,
      data,
      0,
    );
  }

  async enter(targetWid, typeNames, { version = XDND_VERSION } = {}) {
    const atoms = await Promise.all(typeNames.map((n) => this.typeAtom(n)));
    const flags = (version << 24) >>> 0;
    this._send(targetWid, 'XdndEnter', [
      this.wnd.id,
      flags,
      atoms[0] ?? 0,
      atoms[1] ?? 0,
      atoms[2] ?? 0,
    ]);
  }

  position(targetWid, rootX, rootY, { action = 'XdndActionCopy' } = {}) {
    this._send(targetWid, 'XdndPosition', [
      this.wnd.id,
      0,
      ((rootX << 16) | rootY) >>> 0,
      42, // timestamp
      this.atoms[action],
    ]);
  }

  leave(targetWid) {
    this._send(targetWid, 'XdndLeave', [this.wnd.id, 0, 0, 0, 0]);
  }

  drop(targetWid) {
    this._send(targetWid, 'XdndDrop', [this.wnd.id, 0, 43, 0, 0]);
  }

  statuses() {
    return this.received.filter(
      (ev) => ev.message_type === this.atoms.XdndStatus,
    );
  }

  finished() {
    return this.received.filter(
      (ev) => ev.message_type === this.atoms.XdndFinished,
    );
  }
}

const getProperty = (X, wid, atom, type) =>
  new Promise((resolve, reject) =>
    X.GetProperty(0, wid, atom, type, 0, 0x1000, (err, prop) =>
      err ? reject(err) : resolve(prop),
    ),
  );

// --- pure helpers -----------------------------------------------------------

test('parseUriList: CRLF, comments, percent-decoding, remote hosts', () => {
  const files = parseUriList(
    'file:///tmp/a%20b.txt\r\n' +
      '# comment line\r\n' +
      'file://otherhost/nfs/c.txt\r\n' +
      'https://example.com/d\r\n' +
      '\r\n' +
      'file://localhost/tmp/e.txt',
  );
  assert.deepEqual(files, [
    { uri: 'file:///tmp/a%20b.txt', path: '/tmp/a b.txt' },
    { uri: 'file://otherhost/nfs/c.txt' }, // remote: no local path
    { uri: 'https://example.com/d' },
    { uri: 'file://localhost/tmp/e.txt', path: '/tmp/e.txt' },
  ]);
});

test('matchAccept: groups, exact types, predicates, absent', () => {
  const gtkText = ['text/plain;charset=utf-8', 'UTF8_STRING', 'STRING'];
  const fileDrag = ['text/uri-list', 'text/plain'];
  assert.equal(matchAccept(['files'], fileDrag), true);
  assert.equal(matchAccept(['files'], gtkText), false);
  assert.equal(matchAccept(['text'], gtkText), true, 'GTK text is text');
  assert.equal(matchAccept('image/png', fileDrag), false);
  assert.equal(
    matchAccept('TEXT/PLAIN', fileDrag),
    true,
    'MIME is case-insensitive',
  );
  assert.equal(
    matchAccept((types) => types.includes('text/uri-list'), fileDrag),
    true,
  );
  assert.equal(matchAccept(null, fileDrag), true, 'absent accepts anything');
  assert.equal(
    typeMatches(['text/x-moz-url'], 'uris'),
    true,
    'Firefox links are uris',
  );
});

// --- the wire ---------------------------------------------------------------

test('top-level windows advertise XdndAware = 5; child windows do not', async () => {
  const { app, srcApp } = await headlessPair();
  const x11Root = await createRoot({ app });
  try {
    const instance = await render(
      React.createElement(
        'window',
        { width: 300, height: 200 },
        React.createElement('window', { width: 50, height: 50, x: 10, y: 10 }),
      ),
      x11Root,
    );
    const src = new FakeSource(srcApp);
    await src.init(null);

    // the property write is async on the app connection; drain both
    let prop = null;
    for (let i = 0; i < 50 && !prop?.data?.length; i++) {
      await settle(app);
      prop = await getProperty(srcApp.X, instance.id, src.atoms.XdndAware, 0);
    }
    assert.ok(prop?.data?.length >= 4, 'XdndAware present on the top-level');
    assert.equal(prop.data.readUInt32LE(0), XDND_VERSION);

    // the nested <window> never advertises: XDND v3+ is top-levels only
    const children = await new Promise((resolve, reject) =>
      srcApp.X.QueryTree(instance.id, (err, tree) =>
        err ? reject(err) : resolve(tree.children),
      ),
    );
    assert.equal(children.length, 1, 'one child X window');
    const childProp = await getProperty(
      srcApp.X,
      children[0],
      src.atoms.XdndAware,
      0,
    );
    assert.ok(!childProp?.data?.length, 'the child window stays bare');
    await x11Root.unmount();
  } finally {
    await app.close();
    await srcApp.close();
  }
});

test('a foreign drag resting near a scrollview edge scrolls it, silently', async () => {
  // The timer scrolls and re-routes, but sends nothing: an XdndStatus is the
  // answer to an XdndPosition, and an unsolicited one is not in the
  // protocol. The source hears the new answer on its next real position.
  const { app, srcApp } = await headlessPair();
  const x11Root = await createRoot({ app });
  try {
    const rows = Array.from({ length: 40 }, (_, i) =>
      React.createElement('box', {
        key: i,
        dropAccept: ['files'],
        onDrop: () => {},
        style: { height: 20 },
      }),
    );
    const instance = await render(
      React.createElement(
        'window',
        { width: 300, height: 200 },
        React.createElement('scrollview', { style: { height: 100 } }, ...rows),
      ),
      x11Root,
    );
    const scroller = instance._reactX11Node.children.find(
      (n) => n.kind === 'scrollview',
    );
    const src = new FakeSource(srcApp);
    await src.init({ 'text/uri-list': 'file:///tmp/x\r\n' });
    await settle(app);
    await settle(app);
    assert.ok(
      scroller.contentHeight > scroller.abs.height,
      'content overflows',
    );

    await src.enter(instance.id, ['text/uri-list']);
    // one position, parked inside the viewport's bottom edge band
    src.position(instance.id, 150, 95);
    await until(
      srcApp,
      () => src.statuses().length > 0,
      'the first XdndStatus',
    );

    for (let i = 0; i < 200 && scroller.scrollY === 0; i++) {
      await settle(app);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(scroller.scrollY > 0, 'the list scrolled with no further motion');
    assert.equal(
      src.statuses().length,
      1,
      'still exactly one status: one position was sent, one was answered',
    );

    src.leave(instance.id);
    await settle(app);
    const stopped = scroller.scrollY;
    await new Promise((resolve) => setTimeout(resolve, 90));
    assert.equal(scroller.scrollY, stopped, 'the leave stopped the scrolling');
    await x11Root.unmount();
  } finally {
    await app.close();
    await srcApp.close();
  }
});

test('zero drop targets: one refusal with a whole-window suppression rect', async () => {
  const { app, srcApp } = await headlessPair();
  const x11Root = await createRoot({ app });
  try {
    const instance = await render(
      React.createElement('window', { width: 300, height: 200 }),
      x11Root,
    );
    const src = new FakeSource(srcApp);
    await src.init(null);
    await settle(app);

    await src.enter(instance.id, ['text/uri-list']);
    src.position(instance.id, 40, 40);
    await until(srcApp, () => src.statuses().length > 0, 'an XdndStatus');

    const status = src.statuses()[0].data;
    assert.equal(status[0], instance.id, 'l[0] is the target window');
    assert.equal(status[1] & 1, 0, 'accept bit clear');
    assert.equal(status[1] & 2, 0, 'bit 1 clear: suppression rect in force');
    assert.equal(status[3] >>> 16, 300, 'rect width covers the window');
    assert.equal(status[3] & 0xffff, 200, 'rect height covers the window');
    await x11Root.unmount();
  } finally {
    await app.close();
    await srcApp.close();
  }
});

test('dropAccept answers XdndStatus; :drag-over follows the drag path', async () => {
  const { app, srcApp } = await headlessPair();
  const x11Root = await createRoot({ app });
  try {
    const boxRef = React.createRef();
    const entered = [];
    const left = [];
    const instance = await render(
      React.createElement(
        'window',
        { width: 300, height: 200 },
        React.createElement('box', {
          ref: boxRef,
          dropAccept: ['files'],
          onDragEnter: (e) => entered.push(e.types.slice()),
          onDragLeave: () => left.push(true),
          style: {
            position: 'absolute',
            left: 100,
            top: 50,
            width: 100,
            height: 80,
          },
        }),
      ),
      x11Root,
    );
    const src = new FakeSource(srcApp);
    await src.init(null);
    await settle(app);
    await settle(app); // let XdndAware + _screenOrigin land

    await src.enter(instance.id, ['text/uri-list', 'text/plain']);
    // over the box (window is at 0,0 on the unmanaged server)
    src.position(instance.id, 150, 90, { action: 'XdndActionMove' });
    await until(srcApp, () => src.statuses().length >= 1, 'status for the box');

    let status = src.statuses()[0].data;
    assert.equal(status[1] & 1, 1, 'accepted');
    assert.equal(status[1] & 2, 2, 'no suppression: keep positions coming');
    assert.equal(
      status[4],
      src.atoms.XdndActionMove,
      'the requested action is echoed',
    );
    assert.deepEqual(entered, [['text/uri-list', 'text/plain']]);
    assert.equal(boxRef.current.states[':drag-over'], true);

    // outside the box, still in the window: rejected, box un-highlights
    src.position(instance.id, 20, 20);
    await until(srcApp, () => src.statuses().length >= 2, 'second status');
    status = src.statuses()[1].data;
    assert.equal(status[1] & 1, 0, 'rejected outside the dropzone');
    assert.equal(boxRef.current.states[':drag-over'], false);
    assert.equal(left.length, 1, 'onDragLeave fired');

    src.leave(instance.id);
    await settle(app);
    await x11Root.unmount();
  } finally {
    await app.close();
    await srcApp.close();
  }
});

test('a mismatched offer is refused by dropAccept data alone', async () => {
  const { app, srcApp } = await headlessPair();
  const x11Root = await createRoot({ app });
  try {
    const instance = await render(
      React.createElement(
        'window',
        { width: 300, height: 200 },
        React.createElement('box', {
          dropAccept: ['image/png'],
          onDrop: () => {},
          style: { flexGrow: 1 },
        }),
      ),
      x11Root,
    );
    const src = new FakeSource(srcApp);
    await src.init(null);
    await settle(app);
    await settle(app);

    await src.enter(instance.id, ['text/uri-list']);
    src.position(instance.id, 150, 100);
    await until(srcApp, () => src.statuses().length > 0, 'a status');
    assert.equal(src.statuses()[0].data[1] & 1, 0, 'file drag refused');
    await x11Root.unmount();
  } finally {
    await app.close();
    await srcApp.close();
  }
});

test('drop: uri-list arrives parsed, XdndFinished confirms with the action', async () => {
  const { app, srcApp } = await headlessPair();
  const x11Root = await createRoot({ app });
  try {
    const drops = [];
    const instance = await render(
      React.createElement(
        'window',
        { width: 300, height: 200 },
        React.createElement('box', {
          dropAccept: ['files'],
          onDrop: async (e) => {
            drops.push({ files: e.files, text: e.text, action: e.action });
          },
          style: { flexGrow: 1 },
        }),
      ),
      x11Root,
    );
    const src = new FakeSource(srcApp);
    await src.init({
      'text/uri-list':
        'file:///home/u/My%20Doc.pdf\r\n# a comment\r\nfile:///tmp/x.png\r\n',
      'text/plain': '/home/u/My Doc.pdf\n/tmp/x.png',
    });
    await settle(app);
    await settle(app);

    await src.enter(instance.id, ['text/uri-list', 'text/plain']);
    src.position(instance.id, 150, 100);
    await until(srcApp, () => src.statuses().length > 0, 'accept status');
    assert.equal(src.statuses()[0].data[1] & 1, 1, 'accepted');

    src.drop(instance.id);
    await until(srcApp, () => src.finished().length > 0, 'XdndFinished');

    assert.equal(drops.length, 1, 'one drop dispatched');
    assert.deepEqual(drops[0].files, [
      { uri: 'file:///home/u/My%20Doc.pdf', path: '/home/u/My Doc.pdf' },
      { uri: 'file:///tmp/x.png', path: '/tmp/x.png' },
    ]);

    const fin = src.finished()[0].data;
    assert.equal(fin[0], instance.id, 'l[0] is the target window');
    assert.equal(fin[1] & 1, 1, 'v5: accepted bit set');
    assert.equal(fin[2], src.atoms.XdndActionCopy, 'v5: performed action');

    // The conversion carried XdndDrop's timestamp, l[2] = 43, rather than
    // CurrentTime. Mainstream sources serve whatever they hold and never
    // notice; one that validates the timestamp refuses, and that is the
    // failure this pins.
    const uriList = await src.typeAtom('text/uri-list');
    const converted = src.conversions.filter((c) => c.target === uriList);
    assert.ok(converted.length > 0, 'the target converted text/uri-list');
    assert.deepEqual(
      [...new Set(converted.map((c) => c.time))],
      [43],
      "every conversion used XdndDrop's timestamp",
    );
    await x11Root.unmount();
  } finally {
    await app.close();
    await srcApp.close();
  }
});

test('a source that asks: the choices reach the handler, and its answer reaches XdndFinished', async () => {
  const { app, srcApp } = await headlessPair();
  const x11Root = await createRoot({ app });
  try {
    const drops = [];
    const instance = await render(
      React.createElement(
        'window',
        { width: 300, height: 200 },
        React.createElement('box', {
          dropAccept: ['files'],
          onDrop: (e) => {
            drops.push({
              action: e.action,
              actions: e.actions,
              descriptions: e.actionDescriptions,
            });
            // what a menu built from those choices would come back with
            e.accept('move');
          },
          style: { flexGrow: 1 },
        }),
      ),
      x11Root,
    );
    const src = new FakeSource(srcApp);
    await src.init({ 'text/uri-list': 'file:///tmp/x\r\n' });
    // Link is offered but left undescribed, so the gap is positional
    await src.offerAsk(
      ['XdndActionCopy', 'XdndActionMove', 'XdndActionLink'],
      ['Copy here', 'Move here'],
    );
    await settle(app);

    await src.enter(instance.id, ['text/uri-list']);
    src.position(instance.id, 150, 100, { action: 'XdndActionAsk' });
    await until(srcApp, () => src.statuses().length > 0, 'an XdndStatus');

    src.drop(instance.id);
    await until(srcApp, () => src.finished().length > 0, 'XdndFinished');

    assert.equal(drops.length, 1);
    assert.equal(drops[0].action, 'ask', 'the source asked');
    assert.deepEqual(drops[0].actions, ['copy', 'move', 'link']);
    assert.deepEqual(drops[0].descriptions, ['Copy here', 'Move here', null]);

    const fin = src.finished()[0].data;
    assert.equal(fin[1] & 1, 1, 'accepted');
    assert.equal(
      fin[2],
      src.atoms.XdndActionMove,
      "the handler's choice is what the source is told",
    );
    await x11Root.unmount();
  } finally {
    await app.close();
    await srcApp.close();
  }
});

test('a drop handler can refuse at the last moment, and a plain drag asks for nothing', async () => {
  const { app, srcApp } = await headlessPair();
  const x11Root = await createRoot({ app });
  try {
    let seen = null;
    const instance = await render(
      React.createElement(
        'window',
        { width: 300, height: 200 },
        React.createElement('box', {
          dropAccept: ['files'],
          onDrop: (e) => {
            seen = { actions: e.actions, descriptions: e.actionDescriptions };
            e.reject(); // decided against it after looking at the payload
          },
          style: { flexGrow: 1 },
        }),
      ),
      x11Root,
    );
    const src = new FakeSource(srcApp);
    await src.init({ 'text/uri-list': 'file:///tmp/x\r\n' });
    await settle(app);

    await src.enter(instance.id, ['text/uri-list']);
    src.position(instance.id, 150, 100); // a plain copy, no asking
    await until(srcApp, () => src.statuses().length > 0, 'an XdndStatus');
    src.drop(instance.id);
    await until(srcApp, () => src.finished().length > 0, 'XdndFinished');

    // nothing was asked, so nothing was read off the source window
    assert.deepEqual(seen, { actions: [], descriptions: [] });
    assert.equal(
      src.finished()[0].data[1] & 1,
      0,
      'the refusal reaches the source',
    );
    await x11Root.unmount();
  } finally {
    await app.close();
    await srcApp.close();
  }
});

test('more than three types: the offer is read from XdndTypeList', async () => {
  const { app, srcApp } = await headlessPair();
  const x11Root = await createRoot({ app });
  try {
    const seen = [];
    const instance = await render(
      React.createElement(
        'window',
        { width: 300, height: 200 },
        React.createElement('box', {
          dropAccept: ['image/png'],
          onDragEnter: (e) => seen.push(e.types.slice()),
          style: { flexGrow: 1 },
        }),
      ),
      x11Root,
    );
    const src = new FakeSource(srcApp);
    await src.init(null);
    await settle(app);
    await settle(app);

    const names = [
      'image/bmp',
      'image/tiff',
      'image/gif',
      'image/png',
      'text/plain',
    ];
    const atoms = await Promise.all(names.map((n) => src.typeAtom(n)));
    srcApp.X.ChangeProperty(
      0,
      src.wnd.id,
      src.atoms.XdndTypeList,
      srcApp.X.atoms.ATOM,
      32,
      atoms,
    );
    await settle(srcApp); // ChangeProperty is void; sync via a round trip

    // bit 0 of l[1]: more than three types, read XdndTypeList
    src._send(instance.id, 'XdndEnter', [
      src.wnd.id,
      ((XDND_VERSION << 24) | 1) >>> 0,
      0,
      0,
      0,
    ]);
    src.position(instance.id, 150, 100);
    await until(srcApp, () => src.statuses().length > 0, 'a status');
    assert.equal(
      src.statuses()[0].data[1] & 1,
      1,
      'image/png accepted via the full type list',
    );
    assert.deepEqual(seen[0], names, 'all five types visible to the app');
    await x11Root.unmount();
  } finally {
    await app.close();
    await srcApp.close();
  }
});

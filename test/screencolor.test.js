// The eyedropper (issue #360): pickScreenColor() / useEyedropper(), and the
// portalRequest generalization underneath the portal rung.
//
// Organised by rung, the filedialog.test.js way: the portal against a fake
// Screenshot interface on the broker (this is also where the version gate —
// the reason `portalVersion()` exists — is pinned), and the X11 rung against
// node-x11's in-process server, whose grab and GetImage machinery are real.
// The last group is the hook.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert';
import React from 'react';

import { XK_ESCAPE, XK_RETURN } from '../src/keysyms.js';
import {
  _resetServiceCache,
  portalRequest,
  portalVersion,
} from '../src/portal.js';
import {
  NoScreenColorError,
  pickScreenColor,
  screenColorBackend,
} from '../src/screencolor.js';
import { useEyedropper } from '../src/screencolorhooks.js';
import { act, cleanup, fireEvent, renderX11 } from '../src/testing/index.js';
import { fakePortal } from './helpers/fake-portal.js';
import {
  transportAvailable,
  until,
  withBus,
  withNoBus,
} from './helpers/with-bus.js';

const haveTransport = await transportAvailable();
const needsBroker = haveTransport
  ? {}
  : { skip: 'dbus-native is not installed (expected on Node < 22.12)' };

afterEach(() => {
  _resetServiceCache();
});

// ---------------------------------------------------------------------------

describe('portalRequest with a signature of its own', () => {
  // The validation runs before anything touches the bus, so no broker is
  // needed to pin the two mistakes it exists to catch.
  test('signature and args travel as a pair', async () => {
    const ref = { bus: null, uniqueName: ':1.1' };
    await assert.rejects(
      () =>
        portalRequest(ref, {
          iface: 'org.freedesktop.portal.Screenshot',
          member: 'PickColor',
          signature: 'sa{sv}',
        }),
      /`signature` without `args`/,
    );
    await assert.rejects(
      () =>
        portalRequest(ref, {
          iface: 'org.freedesktop.portal.Screenshot',
          member: 'PickColor',
          args: [''],
        }),
      /`args` without `signature`/,
    );
  });

  test('a signature not ending in the options dict is refused', async () => {
    // handle_token rides in the trailing a{sv}; a method without one does not
    // answer through a Request, so the helper cannot serve it.
    await assert.rejects(
      () =>
        portalRequest(
          { bus: null, uniqueName: ':1.1' },
          {
            iface: 'org.freedesktop.portal.Inhibit',
            member: 'Inhibit',
            signature: 'su',
            args: ['', 8],
          },
        ),
      /does not end in the options dict/,
    );
  });
});

describe('the portal rung', { ...needsBroker }, () => {
  test('portalVersion reads the interface version, and 0 means not there', async () => {
    await withBus(async (address) => {
      // No Screenshot interface at all — XFCE's portal, as found on the
      // machine this feature was built on.
      const bare = await fakePortal(address);
      try {
        assert.equal(
          await portalVersion('org.freedesktop.portal.Screenshot'),
          0,
        );
      } finally {
        await bare.stop();
      }

      _resetServiceCache();
      const versioned = await fakePortal(address, {}, { screenshotVersion: 3 });
      try {
        assert.equal(
          await portalVersion('org.freedesktop.portal.Screenshot'),
          3,
        );
      } finally {
        await versioned.stop();
      }
    });
  });

  test('PickColor: its own argument shape, and (ddd) becomes #rrggbb', async () => {
    await withBus(async (address) => {
      const portal = await fakePortal(
        address,
        {
          PickColor: () => ({
            response: 0,
            // a{sv} as (key, [signature, value]) pairs; the struct arrives
            // at the client as a plain [r, g, b] array.
            results: [['color', ['(ddd)', [1, 0.5, 0]]]],
          }),
        },
        { screenshotVersion: 2 },
      );
      try {
        const hex = await pickScreenColor({ parentWindow: 0x1a00007 });
        assert.equal(hex, '#ff8000');
        assert.equal(portal.calls.length, 1);
        assert.equal(portal.calls[0].member, 'PickColor');
        // PickColor is (s parent_window, a{sv} options) — no title anywhere,
        // which is exactly what the hardcoded FileChooser shape could not say.
        assert.equal(portal.calls[0].parentWindow, 'x11:1a00007');
        assert.equal(portal.calls[0].title, undefined);
        assert.match(
          portal.calls[0].options.handle_token,
          /^rx11_[0-9a-f]{16}$/,
        );
      } finally {
        await portal.stop();
      }
    });
  });

  test('the portal cancel resolves to null, not a throw', async () => {
    await withBus(async (address) => {
      const portal = await fakePortal(
        address,
        { PickColor: () => ({ response: 1, results: {} }) },
        { screenshotVersion: 2 },
      );
      try {
        assert.equal(await pickScreenColor(), null);
      } finally {
        await portal.stop();
      }
    });
  });

  test('abort closes the request rather than walking away', async () => {
    await withBus(async (address) => {
      const portal = await fakePortal(
        address,
        { PickColor: () => ({ silent: true }) },
        { screenshotVersion: 2 },
      );
      try {
        const ac = new AbortController();
        const pending = pickScreenColor({ signal: ac.signal });
        await until(() => portal.calls.length === 1, 'the call to arrive');
        ac.abort();
        await assert.rejects(pending, /aborted/i);
        await until(
          () => portal.closed.length === 1,
          'the portal to see Close()',
        );
      } finally {
        await portal.stop();
      }
    });
  });

  test('Screenshot v1 is not a rung: PickColor is version 2', async () => {
    await withBus(async (address) => {
      // The interface exists — hasService() and even an introspection would
      // say yes — but PickColor arrived in version 2, so calling it would
      // error at the far end. The version property is the honest gate.
      const portal = await fakePortal(
        address,
        { PickColor: () => ({ response: 0, results: {} }) },
        { screenshotVersion: 1 },
      );
      try {
        await assert.rejects(
          () => pickScreenColor(),
          (err) => err instanceof NoScreenColorError,
        );
        assert.equal(portal.calls.length, 0, 'PickColor was never called');
      } finally {
        await portal.stop();
      }
    });
  });

  test("backend: 'portal' with no Screenshot is a typed rejection", async () => {
    await withBus(async (address) => {
      const portal = await fakePortal(address); // no Screenshot interface
      try {
        await assert.rejects(
          () => pickScreenColor({ backend: 'portal' }),
          (err) => {
            assert.ok(err instanceof NoScreenColorError);
            assert.match(err.message, /version 2/);
            return true;
          },
        );
      } finally {
        await portal.stop();
      }
    });
  });
});

describe('screenColorBackend', () => {
  test('no bus and no connection is null; a connection is the x11 rung', async () => {
    await withNoBus(async () => {
      assert.equal(await screenColorBackend(), null);
      // Reachability, not validity: any connection object makes the fallback
      // answerable. The pick itself is what exercises it.
      assert.equal(await screenColorBackend({ app: { X: {} } }), 'x11');
      assert.equal(
        await screenColorBackend({ app: { X: {} }, backend: 'portal' }),
        null,
      );
    });
  });

  test(
    'a Screenshot portal at version 2 answers portal',
    { ...needsBroker },
    async () => {
      await withBus(async (address) => {
        const portal = await fakePortal(address, {}, { screenshotVersion: 2 });
        try {
          assert.equal(await screenColorBackend(), 'portal');
          // Forcing the rung skips the probe entirely.
          assert.equal(
            await screenColorBackend({ app: { X: {} }, backend: 'x11' }),
            'x11',
          );
        } finally {
          await portal.stop();
        }
      });
    },
  );

  test(
    'a portal without Screenshot falls to x11 — the XFCE case',
    { ...needsBroker },
    async () => {
      await withBus(async (address) => {
        const portal = await fakePortal(address); // FileChooser only
        try {
          assert.equal(await screenColorBackend({ app: { X: {} } }), 'x11');
          assert.equal(await screenColorBackend(), null);
        } finally {
          await portal.stop();
        }
      });
    },
  );

  test('no rung at all: pickScreenColor names the way out', async () => {
    await withNoBus(async () => {
      await assert.rejects(
        () => pickScreenColor(),
        (err) => {
          assert.ok(err instanceof NoScreenColorError);
          assert.match(err.message, /useEyedropper|`app`/);
          return true;
        },
      );
    });
  });
});

// ---------------------------------------------------------------------------
// The X11 rung, against the in-process server's real grab machinery.
// ---------------------------------------------------------------------------

/** Fill a rect of the ROOT window with a colour, so a pick has a known
 * answer. GetImage on the root is what the rung reads. */
function paintRoot(app, x, y, pixel) {
  const X = app.X;
  const root = X.display.screen[0].root;
  const gc = X.AllocID();
  X.CreateGC(gc, root, { foreground: pixel });
  X.PolyFillRectangle(root, gc, [x, y, 20, 20]);
  X.FreeGC(gc);
  X.ReleaseID(gc);
}

/** The grab window is nothing the tree owns — assert that, and hand back
 * its id so the test can talk about it. */
function grabWindowOf(view) {
  const grab = view.server.grabs.pointer;
  assert.ok(grab, 'a pointer grab is active');
  assert.notEqual(grab.wid, view.windowNode.window.id);
  return grab.wid;
}

describe('the X11 rung', () => {
  afterEach(cleanup);

  test('grab, crosshair, click: the pixel under the pointer, then everything released', async () => {
    const view = await renderX11(
      React.createElement('window', { width: 200, height: 120 }),
      { wrap: false },
    );
    paintRoot(view.app, 300, 300, 0x336699);

    const pending = pickScreenColor({ app: view.app, backend: 'x11' });
    await until(() => view.server.grabs.pointer, 'the grab to activate');
    const wid = grabWindowOf(view);
    assert.notEqual(
      view.server.grabs.pointer.cursor,
      0,
      'the grab carries the crosshair',
    );

    view.server.injectPointerMove(310, 310);
    view.server.injectButton(1, true);
    view.server.injectButton(1, false);

    assert.equal(await pending, '#336699');
    assert.equal(view.server.grabs.pointer, null, 'pointer grab released');
    assert.equal(view.server.grabs.keyboard, null, 'keyboard grab released');
    // The InputOnly grab window went with it.
    assert.equal(view.server.resources?.get?.(wid) ?? null, null);
  });

  test('Escape cancels: null, with the grab released first', async () => {
    const view = await renderX11(
      React.createElement('window', { width: 200, height: 120 }),
      { wrap: false },
    );
    const pending = pickScreenColor({ app: view.app, backend: 'x11' });
    await until(() => view.server.grabs.keyboard, 'the keyboard grab');

    // fireEvent resolves the keysym and injects at the server; the active
    // keyboard grab is what routes it to the eyedropper rather than to the
    // window the event nominally targets — which is the mechanism under test.
    fireEvent.key(XK_ESCAPE, { target: view.windowNode });

    assert.equal(await pending, null);
    // The cancel resolves the moment it is decided; the ungrab requests are
    // on the wire ahead of it and land a round trip later.
    await until(() => !view.server.grabs.pointer, 'the pointer grab release');
    await until(() => !view.server.grabs.keyboard, 'the keyboard grab release');
  });

  test('Return picks at the pointer without a click', async () => {
    const view = await renderX11(
      React.createElement('window', { width: 200, height: 120 }),
      { wrap: false },
    );
    paintRoot(view.app, 340, 200, 0xaa00ff);
    view.server.injectPointerMove(345, 205);

    const pending = pickScreenColor({ app: view.app, backend: 'x11' });
    await until(() => view.server.grabs.keyboard, 'the keyboard grab');
    fireEvent.key(XK_RETURN, { target: view.windowNode });

    assert.equal(await pending, '#aa00ff');
    assert.equal(view.server.grabs.pointer, null);
  });

  test('other buttons neither pick nor cancel', async () => {
    const view = await renderX11(
      React.createElement('window', { width: 200, height: 120 }),
      { wrap: false },
    );
    paintRoot(view.app, 300, 300, 0x00ff00);
    const pending = pickScreenColor({ app: view.app, backend: 'x11' });
    await until(() => view.server.grabs.pointer, 'the grab to activate');

    view.server.injectPointerMove(310, 310);
    // A middle-click paste reflex must not eat the pick.
    view.server.injectButton(2, true);
    view.server.injectButton(2, false);
    assert.ok(view.server.grabs.pointer, 'still picking');

    view.server.injectButton(1, true);
    view.server.injectButton(1, false);
    assert.equal(await pending, '#00ff00');
  });

  test('abort releases the grab before the rejection reports', async () => {
    const view = await renderX11(
      React.createElement('window', { width: 200, height: 120 }),
      { wrap: false },
    );
    const ac = new AbortController();
    const reason = new Error('changed my mind');
    const pending = pickScreenColor({
      app: view.app,
      backend: 'x11',
      signal: ac.signal,
    });
    await until(() => view.server.grabs.pointer, 'the grab to activate');
    ac.abort(reason);
    await assert.rejects(pending, (err) => err === reason);
    // The cleanup ran synchronously on the abort; the requests are on the
    // wire before the rejection was reported. One round trip proves them.
    await until(() => !view.server.grabs.pointer, 'the grab to be released');
    assert.equal(view.server.grabs.keyboard, null);
  });

  test('a second pick on the same connection is refused, loudly', async () => {
    const view = await renderX11(
      React.createElement('window', { width: 200, height: 120 }),
      { wrap: false },
    );
    const first = pickScreenColor({ app: view.app, backend: 'x11' });
    await until(() => view.server.grabs.pointer, 'the grab to activate');
    // A second GrabPointer from the same client would silently *replace* the
    // first — one pick would settle with the other's click.
    await assert.rejects(
      () => pickScreenColor({ app: view.app, backend: 'x11' }),
      /already waiting for a click/,
    );
    fireEvent.key(XK_ESCAPE, { target: view.windowNode });
    assert.equal(await first, null);
  });

  test('a <popup grab> gets its grab back after the pick', async () => {
    const view = await renderX11(
      React.createElement(
        'window',
        { width: 200, height: 120 },
        React.createElement(
          'box',
          null,
          React.createElement('popup', {
            grab: true,
            x: 10,
            y: 10,
            width: 60,
            height: 40,
          }),
        ),
      ),
      { wrap: false },
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    await until(() => view.server.grabs.pointer, "the popup's own grab");
    const popupWid = view.server.grabs.pointer.wid;

    paintRoot(view.app, 300, 300, 0xdd2200);
    const pending = pickScreenColor({ app: view.app, backend: 'x11' });
    // Same client, so the pick *replaces* the popup's grab rather than
    // failing AlreadyGrabbed — and the popup is never told.
    await until(
      () => view.server.grabs.pointer?.wid !== popupWid,
      'the pick to take the grab over',
    );

    view.server.injectPointerMove(310, 310);
    view.server.injectButton(1, true);
    view.server.injectButton(1, false);
    assert.equal(await pending, '#dd2200');

    // The renderer is the only party that knew both grabs existed, so it is
    // the one that hands the popup its dismiss-on-outside-click back.
    await until(
      () => view.server.grabs.pointer?.wid === popupWid,
      "the popup's grab to be restored",
    );
  });

  test('a grab released out from under the pick is taken back', async () => {
    const view = await renderX11(
      React.createElement('window', { width: 200, height: 120 }),
      { wrap: false },
    );
    paintRoot(view.app, 300, 300, 0x112233);
    const pending = pickScreenColor({ app: view.app, backend: 'x11' });
    await until(() => view.server.grabs.pointer, 'the grab to activate');
    const wid = view.server.grabs.pointer.wid;

    // What a closing popup's teardown does: UngrabPointer on the shared
    // connection, releasing whatever the client's active grab is — ours. A
    // real server announces it with LeaveNotify mode Ungrab on the grab
    // window; the in-process one does not synthesise crossing events, so the
    // announcement is replayed here.
    view.app.X.UngrabPointer(0);
    await until(() => !view.server.grabs.pointer, 'the grab to be lost');
    view.app.X.emit('event', { type: 8, wid, mode: 2 });

    await until(
      () => view.server.grabs.pointer?.wid === wid,
      'the pick to take the grab back',
    );

    view.server.injectPointerMove(310, 310);
    view.server.injectButton(1, true);
    view.server.injectButton(1, false);
    assert.equal(await pending, '#112233');
  });
});

// ---------------------------------------------------------------------------

describe('useEyedropper', () => {
  afterEach(cleanup);

  test('supported resolves, picking tracks the pick, one grab per double click', async () => {
    let eyedropper;
    function Probe() {
      eyedropper = useEyedropper({ backend: 'x11' });
      return React.createElement('box', { style: { flex: 1 } });
    }
    const view = await renderX11(
      React.createElement(
        'window',
        { width: 200, height: 120 },
        React.createElement(Probe),
      ),
      { wrap: false },
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    assert.equal(eyedropper.supported, true);
    assert.equal(eyedropper.picking, false);

    paintRoot(view.app, 300, 300, 0x123456);
    let pending;
    let second;
    await act(async () => {
      pending = eyedropper.pick();
      // The double click: the in-flight promise is handed back, not queued
      // behind a second grab.
      second = eyedropper.pick();
      await new Promise((r) => setTimeout(r, 30));
    });
    assert.equal(second, pending);
    assert.equal(eyedropper.picking, true);

    await until(() => view.server.grabs.pointer, 'the grab to activate');
    view.server.injectPointerMove(310, 310);
    view.server.injectButton(1, true);
    view.server.injectButton(1, false);
    assert.equal(await pending, '#123456');

    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    assert.equal(eyedropper.picking, false);
  });
});

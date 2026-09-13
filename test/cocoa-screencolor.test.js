// The system colour sampler on the cocoa backend (src/cocoa/screencolor.js,
// `@windowkit/appkit` >= 0.9): the top rung of the eyedropper's ladder, and
// the one that makes `useEyedropper()` answer at all on macOS.
//
// Three layers, headless, over a recording fake bridge — the shape
// test/cocoa-file-panels.test.js uses for the file dialog's cocoa rung:
//
//   1. the **wrapper** — what `CocoaColorSampler.sample()` makes of the
//      bridge's one verb: a triple, a dismissal, an error;
//   2. the **rung** — the conversion into `'#rrggbb'` (the portal's, shared
//      on purpose), a cancel as `null`, and what an abort can and cannot do
//      when nothing in AppKit dismisses a sampler;
//   3. the **ladder** — that `pickScreenColor` and `useEyedropper` reach
//      this rung through the app they name and never by naming a backend,
//      that it outranks the portal, and that a bridge without the verb
//      leaves the ladder exactly where #518 left it.
//
// A real loupe on glass is not something this file can show: nothing can end
// that session but a person, so a test that raised one would sit under it
// until the job timed out. The bridge's own suite owns that half, by hand
// (windowkit/appkit#47).
import assert from 'node:assert';
import { afterEach, describe, test } from 'node:test';
import React from 'react';

import { CocoaApp } from '../src/cocoa/app.js';
import { CocoaColorSampler } from '../src/cocoa/screencolor.js';
import { createRoot } from '../src/index.js';
import { _resetServiceCache } from '../src/portal.js';
import {
  NoScreenColorError,
  pickScreenColor,
  screenColorBackend,
} from '../src/screencolor.js';
import { useEyedropper } from '../src/screencolorhooks.js';
import { setCompositingForTests } from '../src/compositing.js';
import { setScaleForTests } from '../src/scale.js';
import { setScreensForTests } from '../src/screens.js';
import { fakePortal } from './helpers/fake-portal.js';
import {
  offTheDesktopBus,
  transportAvailable,
  until,
  withBus,
  withNoBus,
} from './helpers/with-bus.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

const haveTransport = await transportAvailable();
const needsBroker = haveTransport
  ? {}
  : { skip: 'dbus-native is not installed (expected on Node < 22.12)' };

// **Nothing here may reach the developer's own desktop.** A root built with
// `createRoot()` rather than through `react-x11/test` starts the AT-SPI
// bridge as an app's would, climbing toward the desktop's accessibility
// registry — so it is off here, as the harness has it. And the whole file
// runs with no session bus, as CI does: under the sampler is the portal
// rung, a real PickColor wherever the portal has Screenshot v2, and a bare
// `pickScreenColor()` falls through to it if the cocoa rung stops answering.
process.env.NO_AT_BRIDGE ??= '1';
offTheDesktopBus();

/** The loupe is up and the user has not answered it — the state AppKit gives
 *  no way out of from code, and the one an abort has to survive. */
const HOLD = Symbol('the sampler is still showing');

/** sRGB, 0–1 floats: what the bridge answers with, the portal's units. */
const ORANGE = { r: 1, g: 0.5, b: 0 };

/**
 * A bridge shaped like @windowkit/appkit's, with the sampler: every
 * `sampleScreenColor` callback is recorded, `answer(session)` decides what
 * the user did, and a sample asked for while one is showing **joins that
 * session** rather than raising a second loupe — which is `NSColorSampler`'s
 * own contract and the reason this rung needs no "one at a time" refusal.
 */
function fakeNative({ answer = () => ORANGE } = {}) {
  let seq = 0;
  const base = {
    /** every callback the bridge was handed, in order */
    samples: [],
    /** callbacks still waiting on the loupe */
    pending: [],
    /** how many loupes were actually raised */
    sessions: 0,
    sampleScreenColor(cb) {
      if (base.pending.length === 0) base.sessions++;
      base.samples.push(cb);
      base.pending.push(cb);
      const result = answer(base.sessions);
      if (result !== HOLD) setImmediate(() => base.settle(result));
    },
    /** What the user did, once, to everyone waiting on the session. */
    settle(result) {
      for (const cb of base.pending.splice(0)) {
        if (result instanceof Error) cb(result);
        else cb(null, result);
      }
    },

    setBackendEventCallback() {},
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
  return app;
}

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await root.unmount();
  _resetServiceCache();
});

// --- the wrapper -------------------------------------------------------------

describe('CocoaColorSampler', () => {
  test('the triple comes back untouched, and a dismissal is null', async () => {
    const native = fakeNative();
    const sampler = new CocoaColorSampler(native);
    assert.deepEqual(await sampler.sample(), ORANGE);
    assert.equal(native.sessions, 1);

    // The bridge's cancel: `cb(null, null)`, an ordinary outcome.
    const dismissed = new CocoaColorSampler(fakeNative({ answer: () => null }));
    assert.equal(await dismissed.sample(), null);
  });

  test('a colour that could not be read, and a bridge that throws', async () => {
    const failing = new CocoaColorSampler(
      fakeNative({ answer: () => new Error('no sRGB form: pattern colour') }),
    );
    await assert.rejects(() => failing.sample(), /pattern colour/);

    // A bad argument shape is a TypeError out of the bridge before anything
    // is shown; it belongs on the same channel as everything else here.
    const native = fakeNative();
    native.sampleScreenColor = () => {
      throw new TypeError('sampleScreenColor(cb): cb is not a function');
    };
    await assert.rejects(
      () => new CocoaColorSampler(native).sample(),
      TypeError,
    );
  });
});

// --- the rung ----------------------------------------------------------------

describe('the cocoa rung', () => {
  test('sRGB floats become #rrggbb — the portal rung’s own conversion', async () => {
    const native = fakeNative();
    assert.equal(await pickScreenColor({ app: appOver(native) }), '#ff8000');
    assert.equal(native.sessions, 1, 'the loupe was raised once');

    // Out of range is clamped rather than wrapped: a display that reports a
    // component outside 0–1 must not turn white into black.
    const wide = fakeNative({ answer: () => ({ r: 1.02, g: -0.01, b: 0.5 }) });
    assert.equal(await pickScreenColor({ app: appOver(wide) }), '#ff0080');
  });

  test('a dismissed sampler is null, not a throw', async () => {
    const app = appOver(fakeNative({ answer: () => null }));
    assert.equal(await pickScreenColor({ app }), null);
  });

  test('a colour that is not a colour says what arrived', async () => {
    const app = appOver(fakeNative({ answer: () => ({ r: 1, g: 0.5 }) }));
    await assert.rejects(
      () => pickScreenColor({ app }),
      (err) => {
        assert.ok(!(err instanceof NoScreenColorError), 'a bug, not a floor');
        assert.match(err.message, /system colour sampler answered without/);
        assert.match(err.message, /"g":0\.5/);
        return true;
      },
    );
  });

  test('an abort ends the wait, and the answer that lands after it is dropped', async () => {
    // The loupe stays up: AppKit has no verb to dismiss it, so unlike the
    // portal's Close() and the X11 rung's UngrabPointer, all an abort can do
    // here is stop listening. What it must not do is settle twice.
    const native = fakeNative({ answer: () => HOLD });
    const app = appOver(native);
    const ac = new AbortController();
    const pending = pickScreenColor({ app, signal: ac.signal });
    await tick();
    assert.equal(native.sessions, 1);

    ac.abort();
    await assert.rejects(pending, /abort/i);

    // The user answers the loupe a moment later; nothing throws, and the
    // colour goes nowhere.
    native.settle({ r: 0, g: 0, b: 1 });
    await tick();
  });

  test('a signal that has already fired never raises a loupe', async () => {
    const native = fakeNative();
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(
      () => pickScreenColor({ app: appOver(native), signal: ac.signal }),
      /abort/i,
    );
    assert.equal(native.samples.length, 0);
  });

  test('two picks join one session — the loud refusal is the X11 rung’s', async () => {
    // On X11 a second concurrent pick is refused, because a second
    // GrabPointer from the same client silently replaces the first. Here the
    // framework already answers both from one session, so refusing would be
    // this file inventing a rule the platform does not have.
    const native = fakeNative({ answer: () => HOLD });
    const app = appOver(native);
    const first = pickScreenColor({ app });
    const second = pickScreenColor({ app });
    await tick();
    assert.equal(native.sessions, 1, 'one loupe, two callers');
    assert.equal(native.samples.length, 2);

    native.settle(ORANGE);
    assert.deepEqual(await Promise.all([first, second]), [
      '#ff8000',
      '#ff8000',
    ]);
  });
});

// --- the ladder --------------------------------------------------------------

describe('the ladder reaches the system sampler', () => {
  test('the app carrying the sampler is the rung, and it is found by that', async () => {
    const app = appOver(fakeNative());
    assert.equal(await screenColorBackend({ app }), 'cocoa');
    assert.equal(await screenColorBackend({ app, backend: 'cocoa' }), 'cocoa');
  });

  test('a bridge before 0.9 puts no rung on the ladder', async () => {
    const native = fakeNative();
    native.sampleScreenColor = undefined;
    const app = appOver(native);
    assert.equal(app.colorSampler, null);

    await withNoBus(async () => {
      // The floor #518 built: no sampler, no portal, and an `X` that is a
      // stub — typed, so a picker hides its button instead of crashing.
      assert.equal(await screenColorBackend({ app }), null);
      await assert.rejects(
        () => pickScreenColor({ app }),
        (err) => {
          assert.ok(err instanceof NoScreenColorError);
          assert.match(err.message, /older than 0\.9/);
          return true;
        },
      );
    });
  });

  test("backend: 'cocoa' off the cocoa backend is a typed rejection", async () => {
    await withNoBus(async () => {
      assert.equal(await screenColorBackend({ backend: 'cocoa' }), null);
      await assert.rejects(
        () => pickScreenColor({ backend: 'cocoa', app: { X: {} } }),
        (err) => {
          assert.ok(err instanceof NoScreenColorError);
          assert.match(err.message, /no system colour sampler here/);
          return true;
        },
      );
    });
  });

  test(
    'the sampler outranks the portal, and a pinned rung does not fall through',
    { ...needsBroker },
    async () => {
      await withBus(async (address) => {
        const portal = await fakePortal(
          address,
          {
            PickColor: () => ({
              response: 0,
              results: [['color', ['(ddd)', [0, 1, 0]]]],
            }),
          },
          { screenshotVersion: 2 },
        );
        const native = fakeNative();
        const app = appOver(native);
        try {
          // A Mac with a portal on the bus — a react-x11 tree under XQuartz
          // could have one — still gets the system sampler.
          assert.equal(await screenColorBackend({ app }), 'cocoa');
          assert.equal(await pickScreenColor({ app }), '#ff8000');
          assert.equal(portal.calls.length, 0, 'PickColor was never called');

          // And the portal is still reachable when it is asked for.
          assert.equal(
            await screenColorBackend({ app, backend: 'portal' }),
            'portal',
          );
          assert.equal(
            await pickScreenColor({ app, backend: 'portal' }),
            '#00ff00',
          );
          assert.equal(native.sessions, 1, 'no second loupe for the portal');
        } finally {
          await portal.stop();
        }
      });
    },
  );

  test('a showing cocoa root answers a bare pickScreenColor()', async () => {
    // No app named: the ladder asks the connections the renderer is drawing
    // through, the rule `filePanels` and `calendars` follow.
    const native = fakeNative();
    const root = await createRoot({ app: appOver(native) });
    roots.push(root);
    root.render(h('window', { width: 300, height: 200 }, h('box')));
    await tick();

    assert.equal(await screenColorBackend(), 'cocoa');
    assert.equal(await pickScreenColor(), '#ff8000');
  });

  test('useEyedropper on a cocoa tree draws its button and picks', async () => {
    const native = fakeNative();
    const app = appOver(native);
    const root = await createRoot({ app });
    roots.push(root);
    let eyedropper;
    function Probe() {
      eyedropper = useEyedropper();
      return h('box');
    }
    root.render(h('window', { width: 300, height: 200 }, h(Probe)));
    await tick();

    await until(() => eyedropper.supported, '`supported` to resolve');
    assert.equal(await eyedropper.pick(), '#ff8000');
    assert.equal(native.sessions, 1);
    await until(() => eyedropper.picking === false, 'the pick to finish');
  });
});

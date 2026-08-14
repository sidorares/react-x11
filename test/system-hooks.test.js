// The system hooks: the machine around the app.
//
// `useScreens`, `useWindowState`, `useIdle`/`useKeepAwake`,
// `useKeyboardState`, `useDesktopSettings` and `useLocale`, plus the three
// renderer paths that now read the desktop's interaction settings instead of
// a constant.
//
// **The in-process X server has RENDER, BIG-REQUESTS and XC-MISC and nothing
// else** — no RandR, no Xinerama, no XKB, no SYNC, no MIT-SCREEN-SAVER, no
// XFixes. So the protocol walks cannot be driven end to end here, and what is
// pinned instead is the two things that can be:
//
//   1. the **pure** half of each one — the reply decoders and the derivations
//      — against the shapes the extensions really answer with;
//   2. the **store and the hook** through each module's test seam, which is
//      the same seam `setCompositingForTests` and `setAppearanceForTests`
//      already are.
//
// The degradation paths get the real thing, because a server with none of the
// extensions is exactly what this one is.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert';
import React from 'react';

import {
  degreesOf,
  monitorsFromRandR,
  refreshRateOf,
  screensSnapshot,
  setScreensForTests,
} from '../src/screens.js';
import { useScreens } from '../src/screenshooks.js';
import {
  setWindowStateForTests,
  useWindowState,
  watchWindowState,
  windowStateSnapshot,
} from '../src/windowstate.js';
import { idleSnapshot, setIdleForTests } from '../src/idle.js';
import { useIdle } from '../src/idlehooks.js';
import {
  keyboardStateSnapshot,
  layoutsFromRules,
  locksFromMods,
  setKeyboardStateForTests,
} from '../src/keyboardstate.js';
import { useKeyboardState } from '../src/keyboardstatehooks.js';
import {
  DEFAULTS,
  desktopSettings,
  fromXSettings,
  setDesktopSettingsForTests,
} from '../src/desktopsettings.js';
import { useDesktopSettings } from '../src/desktopsettingshooks.js';
import {
  directionOf,
  localeWeekStart,
  resolveLocale,
  setLocaleForTests,
  systemLocale,
  toLanguageTag,
} from '../src/locale.js';
import { useLocale } from '../src/localehooks.js';
import { CARET_BLINK_MS } from '../src/nodes.js';
import { act, cleanup, renderX11, settle } from '../src/testing/index.js';

const h = React.createElement;

// ---------------------------------------------------------------------------
// useScreens — the RandR walk
// ---------------------------------------------------------------------------

describe('monitorsFromRandR', () => {
  // The shapes node-x11 really hands back: `GetOutputInfo` gives mm_width,
  // connection and a name; `GetCrtcInfo` gives the rect and the mode id;
  // `GetScreenResourcesCurrent` gives the mode lines.
  const MODE_1080 = {
    id: 70,
    width: 1920,
    height: 1080,
    dot_clock: 148500000,
    h_total: 2200,
    v_total: 1125,
  };
  const MODE_1440 = {
    id: 71,
    width: 2560,
    height: 1440,
    dot_clock: 241500000,
    h_total: 2720,
    v_total: 1481,
  };

  const laptop = {
    id: 66,
    name: 'eDP-1',
    crtc: 63,
    connection: 0,
    widthMM: 340,
    heightMM: 190,
  };
  const external = {
    id: 68,
    name: 'HDMI-1',
    crtc: 64,
    connection: 0,
    widthMM: 600,
    heightMM: 340,
  };

  test('one entry per active CRTC, left to right', () => {
    const monitors = monitorsFromRandR({
      // deliberately not in layout order: the server enumerates resources
      // however it likes, and a replug changes it
      outputs: [external, laptop],
      crtcs: new Map([
        [63, { x: 0, y: 0, width: 1920, height: 1080, mode: 70, rotation: 1 }],
        [
          64,
          { x: 1920, y: 0, width: 2560, height: 1440, mode: 71, rotation: 1 },
        ],
      ]),
      modes: [MODE_1080, MODE_1440],
      primary: 68,
    });

    assert.deepEqual(
      monitors.map((m) => [m.name, m.x, m.width, m.primary]),
      [
        ['eDP-1', 0, 1920, false],
        ['HDMI-1', 1920, 2560, true],
      ],
    );
    assert.deepEqual(monitors[0].outputs, ['eDP-1']);
    assert.equal(monitors[0].widthMM, 340);
    assert.equal(monitors[1].heightMM, 340);
  });

  test('a disconnected output is a port, not a monitor', () => {
    const monitors = monitorsFromRandR({
      outputs: [
        laptop,
        // nothing plugged in
        { id: 69, name: 'DP-2', crtc: 0, connection: 1 },
        // plugged in, but the user turned it off: connected with no CRTC
        { id: 70, name: 'DP-3', crtc: 0, connection: 0 },
      ],
      crtcs: new Map([
        [63, { x: 0, y: 0, width: 1920, height: 1080, mode: 70, rotation: 1 }],
      ]),
      modes: [MODE_1080],
      primary: 0,
    });
    assert.deepEqual(
      monitors.map((m) => m.name),
      ['eDP-1'],
    );
  });

  // The case that makes this keyed by CRTC rather than by output. Two cables
  // showing the same pixels are one monitor, and a `screens.length` of 2 for
  // a laptop mirroring to a projector is a wrong answer an app would act on.
  test('mirrored outputs share a CRTC and are one monitor', () => {
    const monitors = monitorsFromRandR({
      outputs: [
        { ...laptop, crtc: 63 },
        { ...external, crtc: 63 },
      ],
      crtcs: new Map([
        [63, { x: 0, y: 0, width: 1920, height: 1080, mode: 70, rotation: 1 }],
      ]),
      modes: [MODE_1080],
      primary: 68,
    });
    assert.equal(monitors.length, 1);
    assert.deepEqual(monitors[0].outputs, ['eDP-1', 'HDMI-1']);
    // and the primary output is the one that names it, even though the other
    // was reached first
    assert.equal(monitors[0].name, 'HDMI-1');
  });

  test('a CRTC with no geometry is skipped rather than reported as 0x0', () => {
    const monitors = monitorsFromRandR({
      outputs: [laptop],
      crtcs: new Map([[63, { x: 0, y: 0, width: 0, height: 0, mode: 0 }]]),
      modes: [],
      primary: 0,
    });
    assert.deepEqual(monitors, []);
  });

  test('refresh rate is dot clock over the total, to two decimals', () => {
    // 148500000 / (2200 * 1125) = 60 exactly
    assert.equal(refreshRateOf(MODE_1080), 60);
    // 241500000 / (2720 * 1481) = 59.951…
    assert.equal(refreshRateOf(MODE_1440), 59.95);
    // a mode line with no timing cannot answer, and must not answer Infinity
    assert.equal(refreshRateOf({ dot_clock: 0, h_total: 0, v_total: 0 }), null);
    assert.equal(refreshRateOf(undefined), null);
  });

  // A server that does not drive real hardware fills the timing fields in
  // rather than leaving them out. This is **XQuartz's own active mode**, read
  // off a running one: dot_clock is exactly h_total * v_total, so the
  // arithmetic is a blameless 1 Hz. "1 Hz" beside a monitor name looks broken
  // in a way that showing nothing does not.
  test('an implausible rate is null, not the number', () => {
    assert.equal(
      refreshRateOf({
        id: 248,
        width: 1728,
        height: 1080,
        dot_clock: 1866240,
        h_total: 1728,
        v_total: 1080,
      }),
      null,
    );
    // and the real modes the same server lists still answer
    assert.equal(
      refreshRateOf({ dot_clock: 155520000, h_total: 1920, v_total: 1080 }),
      75,
    );
  });

  test('rotation is degrees, and the reflection bits are not rotation', () => {
    assert.equal(degreesOf(1), 0); // Rotate_0
    assert.equal(degreesOf(2), 90);
    assert.equal(degreesOf(4), 180);
    assert.equal(degreesOf(8), 270);
    // Rotate_0 | Reflect_X — mirrored, not turned
    assert.equal(degreesOf(1 | 16), 0);
    // Rotate_90 | Reflect_Y
    assert.equal(degreesOf(2 | 32), 90);
  });
});

describe('useScreens', () => {
  afterEach(cleanup);

  // What a server with neither Xinerama nor RandR answers — which is what the
  // in-process one is, so this runs against it rather than against the mock
  // (whose `createMockApp` pins a monitor of its own). One entry covering the
  // display beats an empty list: an app that maps over `screens` should draw
  // one monitor, not none.
  test('a display with no extensions is still one screen', async () => {
    const { app } = await renderX11(h('box'));
    const { screens, primary, source, virtual } = screensSnapshot(app);
    assert.equal(screens.length, 1);
    assert.equal(screens[0].name, null, 'no RandR means no name');
    assert.equal(screens[0].primary, true);
    assert.equal(primary, screens[0]);
    assert.equal(source, 'screen');
    assert.equal(screens[0].width, virtual.width);
    // and it is the whole display, which is the only thing there was to say
    assert.equal(screens[0].width, app.display.screen[0].pixel_width);
  });

  test('renders the layout and re-renders when a monitor arrives', async () => {
    const seen = [];
    function Probe() {
      const { screens, primary } = useScreens();
      seen.push(
        `${screens.map((s) => `${s.name}@${s.x}`).join(',')}|${primary?.name ?? '-'}`,
      );
      return h('text', null, String(screens.length));
    }
    const { app } = await renderX11(h(Probe), { backend: 'mock' });

    await act(async () => {
      setScreensForTests(app, {
        monitors: [
          { name: 'eDP-1', x: 0, y: 0, width: 1920, height: 1080 },
          {
            name: 'HDMI-1',
            x: 1920,
            y: 0,
            width: 2560,
            height: 1440,
            primary: true,
          },
        ],
      });
    });
    await settle();
    assert.equal(seen.at(-1), 'eDP-1@0,HDMI-1@1920|HDMI-1');

    // unplugged
    await act(async () => {
      setScreensForTests(app, {
        monitors: [{ name: 'eDP-1', x: 0, y: 0, width: 1920, height: 1080 }],
      });
    });
    await settle();
    // one monitor and nothing flagged primary: the one monitor is it
    assert.equal(seen.at(-1), 'eDP-1@0|eDP-1');
  });

  // `_NET_WORKAREA` is one rect for the whole virtual desktop, so it is a
  // per-axis bound rather than an intersection — the note this is pinning is
  // that a 40px top panel comes off *both* heads' height and neither head's
  // width, which is the honest reading of a desktop-wide value.
  test('available is the monitor clamped per axis by the work area', async () => {
    const { app } = await renderX11(h('box'), { backend: 'mock' });
    setScreensForTests(app, {
      monitors: [
        { name: 'a', x: 0, y: 0, width: 1920, height: 1080 },
        { name: 'b', x: 1920, y: 0, width: 2560, height: 1440 },
      ],
      workArea: { x: 0, y: 40, width: 4480, height: 1400 },
    });
    const { screens } = screensSnapshot(app);
    assert.deepEqual(
      screens.map((s) => [s.available.width, s.available.height]),
      [
        [1920, 1080], // narrower and shorter than the work area already
        [2560, 1400], // the panel comes off the tall head
      ],
    );
    // and it is a rect and nothing else. A monitor record carries a name and
    // a primary flag too, and spreading it here put both inside `available`.
    assert.deepEqual(Object.keys(screens[0].available).sort(), [
      'height',
      'width',
      'x',
      'y',
    ]);
  });

  // The no-work-area branch is the one that had the bug, so it gets its own
  // case: with nothing to clamp against, `available` is still only a rect.
  test('available is a rect with no work area either', async () => {
    const { app } = await renderX11(h('box'), { backend: 'mock' });
    setScreensForTests(app, {
      monitors: [
        { name: 'a', x: 0, y: 0, width: 1920, height: 1080, primary: true },
      ],
    });
    const [screen] = screensSnapshot(app).screens;
    assert.deepEqual(screen.available, {
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
    });
  });

  test('the snapshot is stable until something changes', async () => {
    const { app } = await renderX11(h('box'), { backend: 'mock' });
    setScreensForTests(app, {
      monitors: [{ name: 'a', x: 0, y: 0, width: 800, height: 600 }],
    });
    // The invariant `useSyncExternalStore` needs: a fresh object per call is
    // what makes React re-render forever.
    assert.strictEqual(screensSnapshot(app), screensSnapshot(app));
  });
});

// ---------------------------------------------------------------------------
// useWindowState
// ---------------------------------------------------------------------------

describe('useWindowState', () => {
  afterEach(cleanup);

  // Focused and visible, not a pile of falses: a window opens focused far
  // more often than not, and a title bar that renders dimmed on frame one
  // and un-dims on frame two is a flash on every launch.
  test('starts focused and visible rather than unknown', async () => {
    const seen = [];
    function Probe() {
      const { focused, visible, fullscreen, states } = useWindowState();
      seen.push(`${focused}:${visible}:${fullscreen}:${states.length}`);
      return h('text', null, 'hi');
    }
    await renderX11(h(Probe), { backend: 'mock' });
    assert.equal(seen[0], 'true:true:false:0');
  });

  test('derives minimized, maximized and fullscreen from _NET_WM_STATE', async () => {
    const { app } = await renderX11(h('box'), { backend: 'mock' });
    const node = app._rootChildren[0];
    let renders = 0;
    watchWindowState(app, node, () => renders++);

    let state = setWindowStateForTests(app, node, {
      states: ['maximized_vert', 'maximized_horz'],
    });
    assert.equal(state.maximized, true);
    assert.equal(state.fullscreen, false);

    state = setWindowStateForTests(app, node, { states: ['fullscreen'] });
    assert.equal(state.fullscreen, true);
    assert.equal(
      state.maximized,
      false,
      'one axis gone is not still maximized',
    );

    // `hidden` is EWMH for iconified, and it is what `visible` folds in —
    // the signal that survives a compositor, unlike VisibilityNotify.
    state = setWindowStateForTests(app, node, { states: ['hidden'] });
    assert.equal(state.minimized, true);
    assert.equal(state.visible, false);
    assert.equal(windowStateSnapshot(app, node), state);
    assert.ok(renders > 0, 'subscribers heard about it');
  });

  test('obscured folds into visible, and a compositor never sets it', async () => {
    const { app } = await renderX11(h('box'), { backend: 'mock' });
    const node = app._rootChildren[0];

    assert.equal(
      setWindowStateForTests(app, node, { obscured: true }).visible,
      false,
    );
    assert.equal(
      setWindowStateForTests(app, node, { obscured: false }).visible,
      true,
    );
  });

  test('a state rewrite that changes nothing notifies nobody', async () => {
    const { app } = await renderX11(h('box'), { backend: 'mock' });
    const node = app._rootChildren[0];
    let renders = 0;
    watchWindowState(app, node, () => renders++);

    setWindowStateForTests(app, node, { states: ['focused'] });
    const after = renders;
    // window managers rewrite `_NET_WM_STATE` with the same contents more
    // often than they change it
    setWindowStateForTests(app, node, { states: ['focused'] });
    setWindowStateForTests(app, node, { states: ['focused'] });
    assert.equal(renders, after);
  });

  test('the hook re-renders on what the window manager did', async () => {
    const seen = [];
    function Probe() {
      const { maximized, visible } = useWindowState();
      seen.push(`${maximized}:${visible}`);
      return h('text', null, 'x');
    }
    const { app } = await renderX11(h(Probe), { backend: 'mock' });
    const node = app._rootChildren[0];
    assert.equal(seen[0], 'false:true');

    await act(async () => {
      setWindowStateForTests(app, node, {
        states: ['maximized_vert', 'maximized_horz'],
      });
    });
    await settle();
    assert.equal(seen.at(-1), 'true:true');
  });
});

// ---------------------------------------------------------------------------
// useIdle
// ---------------------------------------------------------------------------

describe('useIdle', () => {
  afterEach(cleanup);

  test('a display that cannot be asked is never idle', async () => {
    const seen = [];
    function Probe() {
      seen.push(useIdle(60_000));
      return h('text', null, 'x');
    }
    await renderX11(h(Probe), { backend: 'mock' });
    await settle();
    // No SYNC and no MIT-SCREEN-SAVER: false for good, which is the honest
    // answer for a display with no idle counter — not a hang, and not true.
    assert.deepEqual([...new Set(seen)], [false]);
  });

  test('re-renders on the crossing, in both directions', async () => {
    const seen = [];
    function Probe() {
      seen.push(useIdle(60_000));
      return h('text', null, 'x');
    }
    const { app } = await renderX11(h(Probe), { backend: 'mock' });

    await act(async () => setIdleForTests(app, 60_000, true));
    await settle();
    assert.equal(seen.at(-1), true);

    await act(async () => setIdleForTests(app, 60_000, false));
    await settle();
    assert.equal(seen.at(-1), false);
  });

  test('two timeouts are two watchers', async () => {
    const { app } = await renderX11(h('box'), { backend: 'mock' });
    setIdleForTests(app, 10_000, true);
    setIdleForTests(app, 300_000, false);
    assert.equal(idleSnapshot(app, 10_000), true);
    assert.equal(idleSnapshot(app, 300_000), false);
    assert.equal(idleSnapshot(app, 999), false, 'one nobody asked for');
  });
});

// ---------------------------------------------------------------------------
// useKeyboardState
// ---------------------------------------------------------------------------

describe('useKeyboardState', () => {
  afterEach(cleanup);

  test('the lock bits', () => {
    assert.deepEqual(locksFromMods(0), { capsLock: false, numLock: false });
    // LockMask, fixed by the core protocol
    assert.deepEqual(locksFromMods(2), { capsLock: true, numLock: false });
    // Mod2, by universal convention
    assert.deepEqual(locksFromMods(16), { capsLock: false, numLock: true });
    assert.deepEqual(locksFromMods(2 | 16), { capsLock: true, numLock: true });
    // Shift and Control held is not a lock
    assert.deepEqual(locksFromMods(1 | 4), { capsLock: false, numLock: false });
  });

  test('the layouts come out of _XKB_RULES_NAMES', () => {
    // rules, model, layouts, variants, options — NUL-separated, as setxkbmap
    // writes it
    const property = Buffer.from(
      'evdev\0pc105\0us,ru\0,phonetic\0grp:alt_shift_toggle\0',
      'latin1',
    );
    assert.deepEqual(layoutsFromRules(property), ['us', 'ru']);
    // one layout, and the trailing NUL must not become a sixth empty entry
    assert.deepEqual(
      layoutsFromRules(Buffer.from('evdev\0pc105\0gb\0\0\0', 'latin1')),
      ['gb'],
    );
    // no property at all, and a property with an empty layout field
    assert.deepEqual(layoutsFromRules(undefined), []);
    assert.deepEqual(layoutsFromRules(Buffer.from('evdev\0pc105\0\0\0\0')), []);

    // **XQuartz's own property**, read off a running one. `empty` is a real
    // xkeyboard-config layout and what it is defined as is a layout with no
    // symbols — so reporting it would put "EMPTY" in a layout indicator,
    // where the empty list already means "this display cannot say".
    assert.deepEqual(
      layoutsFromRules(Buffer.from('base\0empty\0empty\0\0\0', 'latin1')),
      [],
    );
    // …but a real layout beside it is still a real layout
    assert.deepEqual(
      layoutsFromRules(Buffer.from('base\0pc105\0empty,us\0\0\0', 'latin1')),
      ['empty', 'us'],
    );
  });

  test('layout is the active group indexed into the list', async () => {
    const seen = [];
    function Probe() {
      const { capsLock, group, layout } = useKeyboardState();
      seen.push(`${capsLock ? 'CAPS' : '-'}:${group}:${layout}`);
      return h('text', null, 'x');
    }
    const { app } = await renderX11(h(Probe), { backend: 'mock' });

    await act(async () =>
      setKeyboardStateForTests(app, { group: 0, layouts: ['us', 'ru'] }),
    );
    await settle();
    assert.equal(seen.at(-1), '-:0:us');

    // Alt+Shift, and the lock goes on
    await act(async () =>
      setKeyboardStateForTests(app, {
        group: 1,
        layouts: ['us', 'ru'],
        capsLock: true,
      }),
    );
    await settle();
    assert.equal(seen.at(-1), 'CAPS:1:ru');
  });

  test('a group past the end of the list is null, not undefined', async () => {
    const { app } = await renderX11(h('box'), { backend: 'mock' });
    setKeyboardStateForTests(app, { group: 3, layouts: ['us'] });
    assert.equal(keyboardStateSnapshot(app).layout, null);
  });

  test('no XKB reads as off with an empty layout list', async () => {
    const { app } = await renderX11(h('box'), { backend: 'mock' });
    await settle();
    const state = keyboardStateSnapshot(app);
    assert.equal(state.capsLock, false);
    // the field that tells "off" apart from "could not be asked"
    assert.deepEqual(state.layouts, []);
  });
});

// ---------------------------------------------------------------------------
// useDesktopSettings, and the three renderer paths that read it
// ---------------------------------------------------------------------------

describe('desktop interaction settings', () => {
  afterEach(cleanup);

  test('the XSETTINGS keys, and the full-cycle conversion', () => {
    const map = new Map([
      ['Net/CursorBlinkTime', 1200],
      ['Net/DoubleClickTime', 250],
      ['Net/DoubleClickDistance', 7],
      ['Net/DndDragThreshold', 8],
    ]);
    const values = fromXSettings(map);
    // The one that is easy to get wrong: the key is a **full cycle**, on and
    // off together, and what goes into a timer is half of it. Forgetting the
    // halving is a caret that blinks at half speed.
    assert.equal(values.caretBlinkMs, 600);
    assert.equal(values.doubleClickMs, 250);
    assert.equal(values.doubleClickDistance, 7);
    assert.equal(values.dragThreshold, 8);
    assert.equal(values.source, 'xsettings');
  });

  test('an absent key keeps the default, and 0 turns blinking off', () => {
    // A daemon that exports nothing this cares about still answers.
    const empty = fromXSettings(new Map());
    assert.equal(empty.caretBlink, true);
    assert.equal(empty.caretBlinkMs, DEFAULTS.caretBlinkMs);
    assert.equal(empty.dragThreshold, DEFAULTS.dragThreshold);

    // `Net/CursorBlink: 0` is an accessibility setting, not a preference.
    assert.equal(
      fromXSettings(new Map([['Net/CursorBlink', 0]])).caretBlink,
      false,
    );
    assert.equal(
      fromXSettings(new Map([['Net/CursorBlink', 1]])).caretBlink,
      true,
    );

    // A daemon can export a key with a value of the wrong type or a nonsense
    // one; a caret whose period is `'fast'` never comes back on.
    const junk = fromXSettings(
      new Map([
        ['Net/CursorBlinkTime', 'fast'],
        ['Net/DndDragThreshold', -3],
        ['Net/DoubleClickTime', 0],
      ]),
    );
    assert.equal(junk.caretBlinkMs, DEFAULTS.caretBlinkMs);
    assert.equal(junk.dragThreshold, DEFAULTS.dragThreshold);
    assert.equal(junk.doubleClickMs, DEFAULTS.doubleClickMs);
  });

  test('no settings daemon answers the defaults with a null source', async () => {
    const { app } = await renderX11(h('box'), { backend: 'mock' });
    const values = desktopSettings(app);
    assert.equal(values.source, null);
    assert.equal(values.caretBlinkMs, CARET_BLINK_MS);
  });

  test('the hook re-renders when the desktop changes them', async () => {
    const seen = [];
    function Probe() {
      const { doubleClickMs, dragThreshold } = useDesktopSettings();
      seen.push(`${doubleClickMs}/${dragThreshold}`);
      return h('text', null, 'x');
    }
    const { app } = await renderX11(h(Probe), { backend: 'mock' });
    assert.equal(seen[0], '400/4');

    await act(async () =>
      setDesktopSettingsForTests(app, { doubleClickMs: 250, dragThreshold: 8 }),
    );
    await settle();
    assert.equal(seen.at(-1), '250/8');
  });

  // The three renderer paths. Each one used to be a constant, and each one is
  // the reason this module exists rather than the hook.
  test('the caret takes its cadence from the desktop', async () => {
    const { app } = await renderX11(
      h('textinput', { value: 'x', style: { width: 80 } }),
      { backend: 'mock' },
    );
    setDesktopSettingsForTests(app, { caretBlinkMs: 999 });
    const input = app.windows[0]._reactX11Node.children[0];
    input.defaultFocus();
    // node's timers carry the interval they were armed with
    assert.equal(input._blinkTimer._idleTimeout, 999);
    input.defaultBlur();
  });

  test('`Net/CursorBlink: 0` arms no timer at all', async () => {
    const { app } = await renderX11(
      h('textinput', { value: 'x', style: { width: 80 } }),
      { backend: 'mock' },
    );
    setDesktopSettingsForTests(app, { caretBlink: false });
    const input = app.windows[0]._reactX11Node.children[0];
    input.defaultFocus();
    // Not a timer that fires and draws the same thing twice: a person who
    // asked for no blinking asked for nothing on screen to move.
    assert.equal(input._blinkTimer, undefined);
    assert.equal(input._caretOn, true, 'and the caret is still drawn');
    input.defaultBlur();
  });

  // The third path. 6px drags at the built-in 4px threshold and does not at a
  // desktop that asked for 12 — a drag that starts sooner here than in every
  // other application is one people begin by accident.
  test('the drag threshold is the desktop’s', async () => {
    const started = [];
    const { app } = await renderX11(
      h(
        'box',
        {
          draggable: true,
          dragData: { 'text/plain': 'hi' },
          onDragStart: () => started.push('drag'),
          style: { width: 100, height: 100 },
        },
        null,
      ),
      { backend: 'mock' },
    );
    const wnd = app.windows[0];
    const at = (x, y) => ({
      x,
      y,
      rootx: x,
      rooty: y,
      keycode: 1,
      buttons: 0,
      time: 100,
    });

    setDesktopSettingsForTests(app, { dragThreshold: 12 });
    wnd.emit('mousedown', at(10, 10));
    wnd.emit('mousemove', { ...at(14, 12), buttons: 256 });
    wnd.emit('mouseup', at(14, 12));
    await settle();
    assert.deepEqual(started, [], '6px is under this desktop’s 12');

    setDesktopSettingsForTests(app, { dragThreshold: 4 });
    wnd.emit('mousedown', at(10, 10));
    wnd.emit('mousemove', { ...at(14, 12), buttons: 256 });
    await settle();
    assert.deepEqual(started, ['drag'], '…and over the built-in 4');
    wnd.emit('mouseup', at(14, 12));
    await settle();
  });

  test('the double-click window is the desktop’s', async () => {
    const { app } = await renderX11(h('box'), { backend: 'mock' });
    const events = app.windows[0]._reactX11Node.events;
    setDesktopSettingsForTests(app, {
      doubleClickMs: 1,
      doubleClickDistance: 0,
    });
    const at = (x, y) => ({ x, y });
    // Distance rather than time, because the clock cannot be held still here
    // and two calls in one tick are 0ms apart whatever the window is. A
    // desktop that demands the second click land on the same pixel makes one
    // 3px away a fresh click.
    assert.equal(events._clickDetail(at(10, 10)), 1);
    assert.equal(events._clickDetail(at(13, 10)), 1);
    // …and on the same pixel, still a double
    assert.equal(events._clickDetail(at(13, 10)), 2);

    setDesktopSettingsForTests(app, {
      doubleClickMs: 5_000,
      doubleClickDistance: 20,
    });
    // 15px apart is outside the 4px default and inside this desktop's 20
    assert.equal(events._clickDetail(at(28, 10)), 3);
  });
});

// ---------------------------------------------------------------------------
// useLocale
// ---------------------------------------------------------------------------

describe('useLocale', () => {
  afterEach(async () => {
    setLocaleForTests(null);
    await cleanup();
  });

  test('POSIX locale strings become BCP-47 tags', () => {
    assert.equal(toLanguageTag('ru_RU.UTF-8'), 'ru-RU');
    assert.equal(toLanguageTag('en_GB'), 'en-GB');
    assert.equal(toLanguageTag('de_DE.UTF-8@euro'), 'de-DE');
    assert.equal(toLanguageTag('fr'), 'fr');
    // `C` and `POSIX` are the *absence* of a locale spelled as a value, and
    // passing either to Intl gets a RangeError or a plausible-looking lie
    assert.equal(toLanguageTag('C'), null);
    assert.equal(toLanguageTag('POSIX'), null);
    assert.equal(toLanguageTag(''), null);
    assert.equal(toLanguageTag(undefined), null);
    // a malformed tag falls through to ICU rather than reaching a formatter
    assert.equal(toLanguageTag('not a locale at all'), null);
  });

  test('the environment wins over ICU’s own resolution', () => {
    // ICU answers what it has compiled in — a small build says en-US for
    // every environment there is — where LANG is what the user asked for.
    assert.equal(resolveLocale({ LANG: 'ru_RU.UTF-8' }).locale, 'ru-RU');
    assert.equal(resolveLocale({ LANG: 'ru_RU.UTF-8' }).source, 'env');
    // and the more specific variables win over LANG
    assert.equal(
      resolveLocale({ LC_ALL: 'ja_JP.UTF-8', LANG: 'en_US.UTF-8' }).locale,
      'ja-JP',
    );
    assert.equal(
      resolveLocale({ LC_MESSAGES: 'he_IL', LANG: 'en_US' }).locale,
      'he-IL',
    );
    // nothing set at all still answers, from ICU
    const fallback = resolveLocale({});
    assert.ok(fallback.locale.length > 0);
    assert.equal(fallback.source, 'intl');
    // `C` is not a locale, so it falls through rather than becoming a tag
    assert.equal(resolveLocale({ LANG: 'C' }).source, 'intl');
  });

  test('direction and week start come off the resolved tag', () => {
    assert.equal(directionOf('en-GB'), 'ltr');
    assert.equal(directionOf('ar-EG'), 'rtl');
    assert.equal(directionOf('he-IL'), 'rtl');
    assert.equal(directionOf('fa-IR'), 'rtl');
    assert.equal(resolveLocale({ LANG: 'ar_EG.UTF-8' }).direction, 'rtl');

    // CLDR: Monday in most of the world, Sunday in the US — and the count is
    // JS's (0 Sunday) rather than CLDR's (7 Sunday), which is the conversion
    // worth pinning
    assert.equal(localeWeekStart('en-GB'), 1);
    assert.equal(localeWeekStart('en-US'), 0);
    // and Monday — ISO 8601's answer — where there is no week info to be had,
    // which is a tag `Intl.Locale` will not take, or a build without CLDR
    assert.equal(localeWeekStart('not a locale'), 1);
  });

  test('renders the locale, and the seam re-derives from it', async () => {
    const seen = [];
    function Probe() {
      const { locale, direction, weekStartsOn } = useLocale();
      seen.push(`${locale}:${direction}:${weekStartsOn}`);
      return h('text', null, locale);
    }
    // Pinning a locale re-derives the direction: `he-IL` and left-to-right
    // is not a locale anybody has.
    setLocaleForTests({ locale: 'he-IL' });
    await renderX11(h(Probe), { backend: 'mock' });
    assert.equal(seen.at(-1), 'he-IL:rtl:0');
    assert.equal(systemLocale().source, 'test');
  });
});

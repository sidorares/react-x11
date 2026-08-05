// What the desktop looks like (issue #110), and the three rungs under it.
//
// Grouped by rung: the settings portal against a fake one on the broker,
// XSETTINGS against the in-process X server over the real protocol, and macOS
// by the values it parses out of its watcher's output — that rung spawns
// `osascript` and cannot run here at all. Then the two consumers, the hook
// and `<ThemeProvider>`, and the ladder itself.
import { test, describe, afterEach, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import React from 'react';

import {
  MACOS_PROGRAM,
  _resetAppearance,
  appearanceSnapshot,
  fromMacOS,
  fromPortal,
  fromXSettings,
  systemAppearance,
} from '../src/appearance.js';
import {
  beginXSettings,
  endXSettings,
  parseXSettings,
  setXSettingsForTests,
  xsettings,
} from '../src/xsettings.js';
import { useSystemAppearance } from '../src/appearancehooks.js';
import { ThemeProvider, useTheme } from '../src/components/theme.js';
import { DarkTheme, DefaultTheme } from '../src/palette.js';
import { tint } from '../src/styles.js';
import { _resetBusState, busRefs, closeBus } from '../src/bus.js';
import {
  act,
  cleanup,
  countPixels,
  expectPixel,
  renderX11,
  screen,
  settle,
} from '../src/testing/index.js';
import { transportAvailable, until, withBus } from './helpers/with-bus.js';
import { fakeSettingsPortal } from './helpers/fake-settings.js';

const haveTransport = await transportAvailable();
const needsBroker = haveTransport
  ? {}
  : { skip: 'dbus-native is not installed (expected on Node < 22.12)' };

const require = createRequire(import.meta.url);
const FONTS = {
  'sans-serif': path.join(
    path.dirname(require.resolve('katex/package.json')),
    'dist',
    'fonts',
    'KaTeX_Main-Regular.ttf',
  ),
};

// **The remembered answer lives in $XDG_CACHE_HOME.** Point it at a scratch
// directory for the whole suite: without this, every test would read the
// developer's own desktop out of ~/.cache and write over it, and a green run
// on a light desktop would be a red one on a dark.
let cacheHome;
const savedCacheHome = process.env.XDG_CACHE_HOME;

before(async () => {
  cacheHome = await fs.mkdtemp(path.join(os.tmpdir(), 'rx11-appearance-'));
  process.env.XDG_CACHE_HOME = cacheHome;
});

after(async () => {
  if (savedCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = savedCacheHome;
  await fs.rm(cacheHome, { recursive: true, force: true });
});

const cachedFile = () =>
  path.join(process.env.XDG_CACHE_HOME, 'react-x11', 'appearance.json');

/** Forget both the in-memory store and what a previous test wrote to disk. */
async function forget() {
  _resetAppearance();
  await fs.rm(path.join(cacheHome, 'react-x11'), {
    recursive: true,
    force: true,
  });
}

afterEach(forget);

/**
 * Run with no session bus reachable, so the portal rung fails the way it does
 * on a bare startx or over ssh.
 *
 * The address has to be swapped *and* the shared connection closed: a live
 * one from an earlier test would otherwise be handed straight back, and the
 * test would quietly exercise the real desktop's portal.
 */
async function withNoBus(fn) {
  const saved = process.env.DBUS_SESSION_BUS_ADDRESS;
  await closeBus('session').catch(() => {});
  _resetBusState();
  process.env.DBUS_SESSION_BUS_ADDRESS =
    'unix:path=/nonexistent-rx11-appearance';
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS;
    else process.env.DBUS_SESSION_BUS_ADDRESS = saved;
    await closeBus('session').catch(() => {});
    _resetBusState();
  }
}

// ---------------------------------------------------------------------------

describe('the XSETTINGS payload', () => {
  /**
   * An encoder written from the spec, so the parser is checked against an
   * independent reading of it rather than against itself. Verified against a
   * real gnome-settings-daemon separately: its 2060-byte property decodes to
   * all 53 settings, `Net/ThemeName` included.
   */
  function encode(entries, { bigEndian = false } = {}) {
    const chunks = [];
    const head = Buffer.alloc(12);
    head[0] = bigEndian ? 1 : 0;
    const w32 = (b, o, v) =>
      bigEndian ? b.writeUInt32BE(v, o) : b.writeUInt32LE(v, o);
    const w16 = (b, o, v) =>
      bigEndian ? b.writeUInt16BE(v, o) : b.writeUInt16LE(v, o);
    w32(head, 4, 1); // serial
    w32(head, 8, entries.length);
    chunks.push(head);

    for (const [name, value] of entries) {
      const nameBytes = Buffer.from(name, 'latin1');
      const namePad = (4 - (nameBytes.length % 4)) % 4;
      const header = Buffer.alloc(4 + nameBytes.length + namePad + 4);
      header[0] =
        typeof value === 'number' ? 0 : typeof value === 'string' ? 1 : 2;
      w16(header, 2, nameBytes.length);
      nameBytes.copy(header, 4);
      w32(header, 4 + nameBytes.length + namePad, 1); // last-change serial
      chunks.push(header);

      if (typeof value === 'number') {
        const b = Buffer.alloc(4);
        if (bigEndian) b.writeInt32BE(value);
        else b.writeInt32LE(value);
        chunks.push(b);
      } else if (typeof value === 'string') {
        const s = Buffer.from(value, 'utf8');
        const pad = (4 - ((4 + s.length) % 4)) % 4;
        const b = Buffer.alloc(4 + s.length + pad);
        w32(b, 0, s.length);
        s.copy(b, 4);
        chunks.push(b);
      } else {
        const b = Buffer.alloc(8);
        value.forEach((c, i) => w16(b, i * 2, c));
        chunks.push(b);
      }
    }
    return Buffer.concat(chunks);
  }

  // The name padding is the trap: `Xft/DPI` is 7 bytes, so everything after
  // it is misaligned by one unless the reader rounds up — and a misaligned
  // reader does not fail, it reads a plausible length out of the middle of a
  // string and desynchronises silently.
  test('ints, strings and colours, with the padding right', () => {
    const map = parseXSettings(
      encode([
        ['Xft/DPI', 98304],
        ['Net/ThemeName', 'Yaru-dark'],
        ['Gtk/FontName', 'Ubuntu Sans 11'],
        ['Net/SelectionColor', [65535, 0, 32768, 65535]],
        ['Gtk/RecentFilesMaxAge', -1],
      ]),
    );
    assert.equal(map.size, 5);
    assert.equal(map.get('Xft/DPI'), 98304);
    assert.equal(map.get('Net/ThemeName'), 'Yaru-dark');
    assert.equal(map.get('Gtk/FontName'), 'Ubuntu Sans 11');
    assert.deepEqual(map.get('Net/SelectionColor'), [65535, 0, 32768, 65535]);
    // signed, and the daemon here really does publish -1 for this key
    assert.equal(map.get('Gtk/RecentFilesMaxAge'), -1);
  });

  test('the byte-order byte is the daemon’s, not the platform’s', () => {
    const map = parseXSettings(
      encode(
        [
          ['Xft/DPI', 98304],
          ['Net/ThemeName', 'Adwaita'],
        ],
        {
          bigEndian: true,
        },
      ),
    );
    assert.equal(map.get('Xft/DPI'), 98304);
    assert.equal(map.get('Net/ThemeName'), 'Adwaita');
  });

  test('a truncated payload answers with what it read, not a throw', () => {
    const full = encode([
      ['Net/ThemeName', 'Yaru-dark'],
      ['Xft/DPI', 98304],
    ]);
    const map = parseXSettings(full.subarray(0, full.length - 3));
    assert.equal(map.get('Net/ThemeName'), 'Yaru-dark');
    assert.equal(map.has('Xft/DPI'), false);
  });

  test('a value type from a future version stops the walk', () => {
    const buf = encode([
      ['Net/ThemeName', 'Yaru-dark'],
      ['Xft/DPI', 98304],
    ]);
    // Retype the second setting to something the spec does not define. Its
    // length is unknowable, so nothing after it can be trusted either.
    buf[buf.indexOf(Buffer.from('Xft/DPI')) - 4] = 9;
    const map = parseXSettings(buf);
    assert.deepEqual([...map.keys()], ['Net/ThemeName']);
  });

  test('an empty or absent property is a Map, not a crash', () => {
    assert.equal(parseXSettings(null).size, 0);
    assert.equal(parseXSettings(Buffer.alloc(0)).size, 0);
    assert.equal(parseXSettings(Buffer.alloc(4)).size, 0);
  });

  // The whole point of the rung: read a real manager window over the real
  // protocol, on the in-process X server.
  test('reads the manager window the selection points at', async () => {
    const { app } = await renderX11(React.createElement('box'), {
      fonts: FONTS,
    });
    const X = app.X;
    const intern = (name) =>
      new Promise((res, rej) =>
        X.InternAtom(false, name, (e, a) => (e ? rej(e) : res(a))),
      );

    // A settings daemon, in miniature: a window that owns the selection and
    // carries the property.
    const manager = X.AllocID();
    X.CreateWindow(manager, app.display.screen[0].root, -10, -10, 1, 1);
    const selection = await intern('_XSETTINGS_S0');
    const property = await intern('_XSETTINGS_SETTINGS');
    X.SetSelectionOwner(manager, selection);
    X.ChangeProperty(
      0,
      manager,
      property,
      property,
      8,
      encode([
        ['Net/ThemeName', 'Yaru-dark'],
        ['Xft/DPI', 98304],
      ]),
    );

    await beginXSettings(app);
    assert.equal(xsettings(app).get('Net/ThemeName'), 'Yaru-dark');
    assert.equal(xsettings(app).get('Xft/DPI'), 98304);

    // Live: a settings change rewrites the same property, which arrives as a
    // PropertyNotify on a window this connection does not own.
    X.ChangeProperty(
      0,
      manager,
      property,
      property,
      8,
      encode([['Net/ThemeName', 'Yaru']]),
    );
    await until(
      () => xsettings(app)?.get('Net/ThemeName') === 'Yaru',
      'the settings property to be re-read',
    );

    endXSettings(app);
    await cleanup();
  });

  test('no settings daemon is null, not an error', async () => {
    const { app } = await renderX11(React.createElement('box'), {
      fonts: FONTS,
    });
    await beginXSettings(app);
    assert.equal(xsettings(app), null);
    endXSettings(app);
    await cleanup();
  });
});

// ---------------------------------------------------------------------------

describe('reading the portal’s values', () => {
  // 1 is dark and 2 is light. Written the other way round — which is the way
  // it reads — every desktop that expressed a preference gets the opposite of
  // it, and only those.
  test('1 is dark, 2 is light, anything else is no preference', () => {
    assert.equal(fromPortal({ 'color-scheme': 1 }).colorScheme, 'dark');
    assert.equal(fromPortal({ 'color-scheme': 2 }).colorScheme, 'light');
    assert.equal(
      fromPortal({ 'color-scheme': 0 }).colorScheme,
      'no-preference',
    );
    assert.equal(
      fromPortal({ 'color-scheme': 7 }).colorScheme,
      'no-preference',
    );
    assert.equal(fromPortal({}).colorScheme, 'no-preference');
  });

  // The floats are sRGB in [0,1]; this is the exact triple this machine's
  // portal reports for Ubuntu's orange.
  test('the accent triple becomes a colour a style can use', () => {
    assert.equal(
      fromPortal({
        'accent-color': [0.929411768913269, 0.35686275362968445, 0],
      }).accent,
      '#ed5b00',
    );
    assert.equal(fromPortal({ 'accent-color': [0, 0, 0] }).accent, '#000000');
    assert.equal(fromPortal({ 'accent-color': [1, 1, 1] }).accent, '#ffffff');
  });

  test('out of range means unset, and unset means null', () => {
    // what GNOME sends when no accent colour is chosen
    assert.equal(fromPortal({ 'accent-color': [-1, -1, -1] }).accent, null);
    assert.equal(fromPortal({ 'accent-color': [0.5, 2, 0.5] }).accent, null);
    assert.equal(fromPortal({ 'accent-color': [0.5, 0.5] }).accent, null);
    assert.equal(fromPortal({ 'accent-color': 'orange' }).accent, null);
    assert.equal(fromPortal({}).accent, null);
  });

  test('contrast and reduced motion', () => {
    assert.equal(fromPortal({ contrast: 1 }).contrast, 'high');
    assert.equal(fromPortal({ contrast: 0 }).contrast, 'normal');
    assert.equal(fromPortal({}).contrast, 'normal');
    assert.equal(fromPortal({ 'reduced-motion': 1 }).reducedMotion, true);
    // absent on version 1 of the interface, where "no" is the right answer
    assert.equal(fromPortal({}).reducedMotion, false);
  });
});

// ---------------------------------------------------------------------------

describe('reading XSETTINGS as appearance', () => {
  const of = (entries) => fromXSettings(new Map(Object.entries(entries)));

  test('the -dark suffix is the convention, and only the suffix', () => {
    assert.equal(of({ 'Net/ThemeName': 'Yaru-dark' }).colorScheme, 'dark');
    assert.equal(of({ 'Net/ThemeName': 'Breeze-Dark' }).colorScheme, 'dark');
    assert.equal(of({ 'Net/ThemeName': 'Adwaita' }).colorScheme, 'light');
    // the reason it is anchored: these are light themes with `dark` in the
    // name, and a substring match calls both of them dark
    assert.equal(of({ 'Net/ThemeName': 'Darkly' }).colorScheme, 'light');
    assert.equal(
      of({ 'Net/ThemeName': 'Darkmatter-Light' }).colorScheme,
      'light',
    );
  });

  test('an explicit preference beats the name', () => {
    assert.equal(
      of({ 'Net/ThemeName': 'Adwaita', 'Gtk/ApplicationPreferDarkTheme': 1 })
        .colorScheme,
      'dark',
    );
    assert.equal(
      of({ 'Net/ThemeName': 'Yaru-dark', 'Gtk/ApplicationPreferDarkTheme': 0 })
        .colorScheme,
      'light',
    );
  });

  test('no theme name at all is no preference', () => {
    assert.equal(of({ 'Xft/DPI': 98304 }).colorScheme, 'no-preference');
  });

  test('high contrast, and the separators people write it with', () => {
    assert.equal(of({ 'Net/ThemeName': 'HighContrast' }).contrast, 'high');
    assert.equal(of({ 'Net/ThemeName': 'High-Contrast' }).contrast, 'high');
    assert.equal(of({ 'Net/ThemeName': 'Adwaita' }).contrast, 'normal');
  });

  test('there is no accent colour in XSETTINGS at all', () => {
    assert.equal(of({ 'Net/ThemeName': 'Yaru-dark' }).accent, null);
  });

  // gnome-settings-daemon does not export this key — 53 settings on the
  // session this was written against, and it is not among them — so the rung
  // reports no reduced motion rather than inventing an answer.
  test('reduced motion only when the daemon actually says so', () => {
    assert.equal(of({ 'Gtk/EnableAnimations': 0 }).reducedMotion, true);
    assert.equal(of({ 'Gtk/EnableAnimations': 1 }).reducedMotion, false);
    assert.equal(of({ 'Net/ThemeName': 'Yaru-dark' }).reducedMotion, false);
  });
});

// ---------------------------------------------------------------------------

describe('the macOS rung', () => {
  test('a line from the watcher becomes the four values', () => {
    assert.deepEqual(
      fromMacOS(
        '{"dark":true,"accent":[1,0.35,0],"reducedMotion":false,"contrast":true}',
      ),
      {
        colorScheme: 'dark',
        accent: '#ff5900',
        contrast: 'high',
        reducedMotion: false,
      },
    );
  });

  // On a Mac an unset AppleInterfaceStyle is *light* — the system always has
  // a definite appearance, unlike a Linux desktop that can decline to say.
  test('no AppleInterfaceStyle is light, not no-preference', () => {
    const values = fromMacOS('{"dark":false,"accent":null}');
    assert.equal(values.colorScheme, 'light');
    assert.equal(values.accent, null);
    assert.equal(values.contrast, 'normal');
    assert.equal(values.reducedMotion, false);
  });

  test('noise on the stream is skipped, not fatal', () => {
    assert.equal(fromMacOS('execution error: something'), null);
    assert.equal(fromMacOS(''), null);
    assert.equal(fromMacOS('null'), null);
    assert.equal(fromMacOS('[1,2,3]').colorScheme, 'light');
  });

  // The program cannot be executed here, so what it *says* is pinned. The
  // frameworks are the point: three of the four `defaults` keys do not exist
  // until the user changes that setting, and AppleAccentColor is an index
  // into a table that has to be maintained by hand.
  test('the watcher reads the frameworks, not defaults', () => {
    assert.match(MACOS_PROGRAM, /NSColor\.controlAccentColor/);
    assert.match(MACOS_PROGRAM, /accessibilityDisplayShouldReduceMotion/);
    assert.match(MACOS_PROGRAM, /accessibilityDisplayShouldIncreaseContrast/);
    assert.match(MACOS_PROGRAM, /AppleInterfaceStyle/);
    assert.doesNotMatch(MACOS_PROGRAM, /AppleAccentColor|AppleHighlightColor/);
    // one line per change, on a run loop that does not return
    assert.match(MACOS_PROGRAM, /AppleInterfaceThemeChangedNotification/);
    assert.match(MACOS_PROGRAM, /NSRunLoop\.currentRunLoop\.run\(\)/);
  });
});

// ---------------------------------------------------------------------------

describe('the settings portal', { concurrency: 1, ...needsBroker }, () => {
  test('reads all four values off the portal', async () => {
    await withBus(async (address) => {
      const portal = await fakeSettingsPortal(address, {
        'color-scheme': 1,
        'accent-color': [0.929411768913269, 0.35686275362968445, 0],
        contrast: 1,
        'reduced-motion': 1,
      });
      try {
        const values = await systemAppearance();
        assert.deepEqual(values, {
          colorScheme: 'dark',
          accent: '#ed5b00',
          contrast: 'high',
          reducedMotion: true,
          source: 'portal',
        });
      } finally {
        await portal.stop();
      }
    });
  });

  // **The race the whole design is arranged around.** This portal flips its
  // own state and emits SettingChanged *while it is answering ReadAll*, then
  // replies with the old values. A client that subscribed first sees the
  // change; one that subscribed after the read keeps the stale answer for the
  // rest of its life, with nothing to correct it.
  test('subscribes before it reads', async () => {
    await withBus(async (address) => {
      const portal = await fakeSettingsPortal(address, { 'color-scheme': 2 });
      portal.onRead = () => {
        portal.change({ 'color-scheme': 1 });
      };
      try {
        const first = await systemAppearance();
        assert.equal(
          first.colorScheme,
          'light',
          'the reply carried the old value',
        );
        await until(
          () => appearanceSnapshot().colorScheme === 'dark',
          'the change emitted during the read to arrive',
        );
      } finally {
        await portal.stop();
      }
    });
  });

  test('a later change re-reads and republishes', async () => {
    await withBus(async (address) => {
      const portal = await fakeSettingsPortal(address, { 'color-scheme': 2 });
      try {
        assert.equal((await systemAppearance()).colorScheme, 'light');
        portal.change({ 'color-scheme': 1, 'accent-color': [0, 0.5, 1] });
        await until(
          () => appearanceSnapshot().accent === '#0080ff',
          'the accent colour to change',
        );
        assert.equal(appearanceSnapshot().colorScheme, 'dark');
      } finally {
        await portal.stop();
      }
    });
  });

  test('a change in another namespace is ignored', async () => {
    await withBus(async (address) => {
      const portal = await fakeSettingsPortal(address, { 'color-scheme': 1 });
      try {
        await systemAppearance();
        const before = appearanceSnapshot();
        portal.changeNamespace('org.gnome.desktop.interface', 'icon-theme');
        await new Promise((r) => setTimeout(r, 60));
        // identity, not equality: a re-render per unrelated announcement is
        // exactly what the store exists to avoid
        assert.equal(appearanceSnapshot(), before);
      } finally {
        await portal.stop();
      }
    });
  });

  // Nothing may keep the socket ref()'d: an app that asked what colour the
  // desktop is must still be able to exit when its windows close.
  test('the subscription does not hold a bus reference', async () => {
    await withBus(async (address) => {
      const portal = await fakeSettingsPortal(address, { 'color-scheme': 1 });
      try {
        await systemAppearance();
        assert.equal(appearanceSnapshot().source, 'portal');
        assert.equal(busRefs('session'), 0);
      } finally {
        await portal.stop();
      }
    });
  });
});

// ---------------------------------------------------------------------------

describe('the ladder', () => {
  test('nothing at all is a real answer, not a failure', async () => {
    await withNoBus(async () => {
      const values = await systemAppearance();
      assert.deepEqual(values, {
        colorScheme: 'no-preference',
        accent: null,
        contrast: 'normal',
        reducedMotion: false,
        source: null,
      });
    });
  });

  test('XSETTINGS answers when the portal does not', async () => {
    await withNoBus(async () => {
      const app = {};
      setXSettingsForTests(app, new Map([['Net/ThemeName', 'Yaru-dark']]));
      const values = await systemAppearance({ app });
      assert.equal(values.source, 'xsettings');
      assert.equal(values.colorScheme, 'dark');
      // the rung has no accent colour to give, and says so rather than
      // inventing grey
      assert.equal(values.accent, null);
      endXSettings(app);
    });
  });

  // The rungs disagree in the field: on one GNOME session the portal reports
  // reduced-motion 0 while GNOME's own enable-animations is false. Taking the
  // best-answered field from each would describe a desktop that does not
  // exist, so the first rung to answer owns all four.
  test(
    'the rung that answers owns every field',
    { concurrency: 1, ...needsBroker },
    async () => {
      await withBus(async (address) => {
        const portal = await fakeSettingsPortal(address, { 'color-scheme': 2 });
        const app = {};
        setXSettingsForTests(
          app,
          new Map([
            ['Net/ThemeName', 'Yaru-dark'],
            ['Gtk/EnableAnimations', 0],
          ]),
        );
        try {
          const values = await systemAppearance({ app });
          assert.equal(values.source, 'portal');
          assert.equal(values.colorScheme, 'light');
          // XSETTINGS would have said true; the portal did not, and the
          // portal is the rung that answered
          assert.equal(values.reducedMotion, false);
        } finally {
          endXSettings(app);
          await portal.stop();
        }
      });
    },
  );

  test('the answer is one frozen object, shared by every caller', async () => {
    await withNoBus(async () => {
      const a = await systemAppearance();
      const b = await systemAppearance();
      assert.equal(a, b);
      assert.equal(a, appearanceSnapshot());
      assert.ok(Object.isFrozen(a));
    });
  });
});

// ---------------------------------------------------------------------------

describe('the remembered answer', () => {
  const write = async (body) => {
    await fs.mkdir(path.dirname(cachedFile()), { recursive: true });
    await fs.writeFile(cachedFile(), body);
  };

  test('a rung’s answer is written for the next process to start with', async () => {
    await withNoBus(async () => {
      const app = {};
      setXSettingsForTests(app, new Map([['Net/ThemeName', 'Yaru-dark']]));
      await systemAppearance({ app });
      endXSettings(app);

      assert.deepEqual(JSON.parse(await fs.readFile(cachedFile(), 'utf8')), {
        v: 1,
        colorScheme: 'dark',
        accent: null,
        contrast: 'normal',
        reducedMotion: false,
      });
    });
  });

  // The point of the whole thing: the very first read, before any rung has
  // been asked, is the answer this machine gave last time rather than the
  // defaults — which is what the first frame is drawn from.
  test('the first read is served from disk, before anything is asked', async () => {
    await write(
      JSON.stringify({
        v: 1,
        colorScheme: 'dark',
        accent: '#ed5b00',
        contrast: 'normal',
        reducedMotion: true,
      }),
    );
    _resetAppearance();
    assert.deepEqual(appearanceSnapshot(), {
      colorScheme: 'dark',
      accent: '#ed5b00',
      contrast: 'normal',
      reducedMotion: true,
      // not 'xsettings': nothing has been asked, and saying otherwise would
      // make `source` useless for telling remembered from verified
      source: 'cache',
    });
  });

  test('a remembered answer does not stop the ladder', async () => {
    await write(JSON.stringify({ v: 1, colorScheme: 'dark' }));
    _resetAppearance();
    await withNoBus(async () => {
      assert.equal(appearanceSnapshot().colorScheme, 'dark');
      const app = {};
      setXSettingsForTests(app, new Map([['Net/ThemeName', 'Adwaita']]));
      const values = await systemAppearance({ app });
      // revalidated, and the live answer wins
      assert.equal(values.source, 'xsettings');
      assert.equal(values.colorScheme, 'light');
      endXSettings(app);
    });
  });

  // The file is ordinary user-writable JSON that has been on a disk since
  // some previous run. `accent` in particular goes straight into a style.
  test('a corrupt or hand-edited file is ignored field by field', async () => {
    await write(
      JSON.stringify({
        v: 1,
        colorScheme: 'DARK MODE PLEASE',
        accent: 'url(http://example.com)',
        contrast: 42,
        reducedMotion: 'yes',
      }),
    );
    _resetAppearance();
    assert.deepEqual(appearanceSnapshot(), {
      colorScheme: 'no-preference',
      accent: null,
      contrast: 'normal',
      reducedMotion: false,
      source: 'cache',
    });
  });

  test('unparseable, absent, and from a future version all fall back', async () => {
    for (const body of [
      '{{{',
      '',
      JSON.stringify({ v: 99, colorScheme: 'dark' }),
    ]) {
      await write(body);
      _resetAppearance();
      assert.equal(appearanceSnapshot().colorScheme, 'no-preference');
      assert.equal(appearanceSnapshot().source, null);
    }
    await fs.rm(cachedFile(), { force: true });
    _resetAppearance();
    assert.equal(appearanceSnapshot().source, null);
  });

  test('REACT_X11_NO_APPEARANCE_CACHE touches no disk at all', async () => {
    process.env.REACT_X11_NO_APPEARANCE_CACHE = '1';
    try {
      await withNoBus(async () => {
        const app = {};
        setXSettingsForTests(app, new Map([['Net/ThemeName', 'Yaru-dark']]));
        await systemAppearance({ app });
        endXSettings(app);
      });
      await assert.rejects(() => fs.stat(cachedFile()), { code: 'ENOENT' });
    } finally {
      delete process.env.REACT_X11_NO_APPEARANCE_CACHE;
    }
  });

  test('nothing answering writes nothing — a failure is not remembered', async () => {
    await withNoBus(async () => {
      await systemAppearance();
    });
    await assert.rejects(() => fs.stat(cachedFile()), { code: 'ENOENT' });
  });
});

// ---------------------------------------------------------------------------

describe('the palette reaches what has no style of its own', () => {
  afterEach(cleanup);

  // The bug this guards: the selection highlight was a fixed `#b3d4fc`, and
  // the ink drawn on top of it is `style.color`, which the highlight does not
  // control. On the dark palette that is near-white text on a light blue fill
  // — about 1.3:1, which is not a contrast, it is a blank.
  //
  // The fix is to tint the *surface* rather than pick an opaque colour that
  // has to contrast with an ink it does not own, so the ink keeps whatever
  // contrast it already had. That property is what is asserted here; the
  // paint itself needs a font, which the mock backend has not got.
  test('a translucent fill can never hide the ink on top of it', () => {
    for (const palette of [DefaultTheme, DarkTheme]) {
      const fill = tint(palette.accent, 0.35);
      assert.match(fill, /^rgba\(/, 'translucent, not an opaque colour');
      const alpha = Number(fill.slice(5, -1).split(',')[3]);
      assert.ok(alpha > 0 && alpha < 1, `alpha ${alpha} is between 0 and 1`);
    }
    // and it is the accent, so it follows a theme that moves it
    assert.equal(tint('#3d8bd4', 0.35), 'rgba(61, 139, 212, 0.35)');
    assert.equal(tint('#ffffff', 1), 'rgba(255, 255, 255, 1)');
    // never throws on something it cannot parse — a paint path is no place
    // to discover that a colour was misspelled
    assert.equal(tint('not a colour', 0.5), 'not a colour');
  });

  // Both of the defaults that used to be fixed now come off the node's
  // palette, so they move with the desktop rather than being chosen once
  // against white.
  test('the selection and placeholder defaults come off the palette', async () => {
    const seen = [];
    for (const scheme of ['light', 'dark']) {
      const { app } = await renderX11(
        React.createElement('textinput', {
          value: 'selected',
          placeholder: 'type here',
          style: { width: 120 },
        }),
        { backend: 'mock', colorScheme: scheme },
      );
      await settle();
      const input = app.windows[0]._reactX11Node.children[0];
      seen.push([input.theme.accent, input.theme.dim]);
      await cleanup();
    }
    assert.deepEqual(seen, [
      [DefaultTheme.accent, DefaultTheme.dim],
      [DarkTheme.accent, DarkTheme.dim],
    ]);
  });
});

// ---------------------------------------------------------------------------

describe('useSystemAppearance', () => {
  afterEach(cleanup);

  test('renders what is known, and re-renders when it changes', async () => {
    await withNoBus(async () => {
      const seen = [];
      function Probe() {
        const { colorScheme, accent, source } = useSystemAppearance();
        seen.push(`${source}:${colorScheme}:${accent}`);
        return React.createElement('text', null, colorScheme);
      }
      const app = {};
      // `colorScheme: 'system'` releases the harness pin: every other test in
      // the repo wants a deterministic palette, and this one is about what the
      // ladder reports.
      await renderX11(React.createElement(Probe), {
        fonts: FONTS,
        colorScheme: 'system',
      });
      // The first render happens before anything can have answered — which is
      // the whole reason `systemAppearance()` exists as an imperative call.
      assert.equal(seen[0], 'null:no-preference:null');

      setXSettingsForTests(app, new Map([['Net/ThemeName', 'Yaru-dark']]));
      await act(async () => {
        await systemAppearance({ app });
      });
      await settle();
      assert.equal(seen.at(-1), 'xsettings:dark:null');
      endXSettings(app);
    });
  });
});

// ---------------------------------------------------------------------------

describe('ThemeProvider following the desktop', () => {
  afterEach(cleanup);

  const Swatch = () => {
    const theme = useTheme();
    return React.createElement(
      'text',
      null,
      `${theme.background}|${theme.radius}`,
    );
  };
  /** The palette `useTheme()` handed the widget, as the swatch printed it. */
  const shown = () => screen.getByText(/\|/).props.children;

  test('a dark palette layers over the light one', async () => {
    await withNoBus(async () => {
      const app = {};
      setXSettingsForTests(app, new Map([['Net/ThemeName', 'Yaru-dark']]));
      await systemAppearance({ app });

      const { ctx } = await renderX11(
        React.createElement(
          ThemeProvider,
          {
            value: { background: 'white', radius: 12 },
            dark: { background: '#1e1e1e' },
          },
          // Both routes at once: the widget reads the palette through
          // `useTheme()`, and the box resolves a `$token` against the `theme`
          // prop the provider plants in the *node* tree. They are separate
          // mechanisms (#119), so a provider that switched only the first
          // would paint the light background under dark widgets.
          React.createElement(
            'box',
            { style: { flexGrow: 1, backgroundColor: '$background' } },
            React.createElement(Swatch),
          ),
        ),
        { fonts: FONTS, colorScheme: 'system' },
      );
      await settle();
      // radius came from `value`: `dark` names only what changes
      assert.equal(shown(), '#1e1e1e|12');
      await expectPixel(ctx, 4, 4, '#1e1e1e', { tolerance: 2 });
      endXSettings(app);
    });
  });

  test('colorScheme pins it, whatever the desktop says', async () => {
    await withNoBus(async () => {
      const app = {};
      setXSettingsForTests(app, new Map([['Net/ThemeName', 'Yaru-dark']]));
      await systemAppearance({ app });

      await renderX11(
        React.createElement(
          ThemeProvider,
          {
            value: { background: 'white', radius: 12 },
            dark: { background: '#1e1e1e' },
            colorScheme: 'light',
          },
          React.createElement(Swatch),
        ),
        { fonts: FONTS, colorScheme: 'system' },
      );
      await settle();
      assert.equal(shown(), 'white|12');
      endXSettings(app);
    });
  });

  // **Pinning is the opt-out**, and it has to be a complete one: an app that
  // says which scheme it is in should not have react-x11 opening a D-Bus
  // connection behind it to ask a question whose answer it will ignore.
  test(
    'a pinned provider probes nothing at all',
    { concurrency: 1, ...needsBroker },
    async () => {
      await withBus(async (address, broker) => {
        const portal = await fakeSettingsPortal(address, { 'color-scheme': 1 });
        const clientsBefore = broker.liveClients;
        try {
          await renderX11(
            React.createElement(
              ThemeProvider,
              {
                value: { background: 'white', radius: 12 },
                colorScheme: 'light',
              },
              React.createElement(Swatch),
            ),
            { fonts: FONTS, colorScheme: 'system' },
          );
          await settle();
          await new Promise((r) => setTimeout(r, 60));
          assert.equal(
            broker.liveClients,
            clientsBefore,
            'no connection opened',
          );
          assert.equal(appearanceSnapshot().source, null, 'nothing was probed');
          assert.equal(shown(), 'white|12');
        } finally {
          await portal.stop();
        }
      });
    },
  );

  // The headline of the whole change: no provider, no props, nothing said —
  // and the app is dark because the desktop is.
  test('with no provider at all, the widgets follow the desktop', async () => {
    const { ctx } = await renderX11(
      React.createElement(
        'box',
        { style: { flexGrow: 1 } },
        React.createElement(Swatch),
      ),
      { fonts: FONTS, colorScheme: 'dark' },
    );
    await settle();
    assert.equal(
      shown(),
      `${DarkTheme.background}|${DarkTheme.radius}`,
      'useTheme() answers with the built-in dark palette',
    );
    // And the window fill under them, which is the other route and the one
    // that would otherwise leave a white rectangle behind dark widgets.
    await expectPixel(ctx, 2, 2, DarkTheme.background, { tolerance: 2 });
  });

  // The ink a `<text>` or a `<textinput>` inherits is not in any style object,
  // so nothing else in the theme machinery notices it move. It used to be a
  // fixed `'black'`, which on the dark palette's #1e2228 is invisible — and
  // invisible only for text that never named a colour, which is why a
  // placeholder (a fixed grey) read fine while the value beside it did not.
  test('unstyled text takes the palette’s ink, not black', async () => {
    const { ctx } = await renderX11(
      React.createElement(
        'box',
        { style: { flexGrow: 1, padding: 10, gap: 8 } },
        React.createElement('text', { style: { fontSize: 30 } }, 'PLAIN'),
        React.createElement('textinput', {
          value: 'TYPED',
          style: { fontSize: 30, padding: 4 },
        }),
      ),
      { fonts: FONTS, colorScheme: 'dark' },
    );
    await settle();

    for (const [what, y] of [
      ['<text>', 12],
      ['<textinput>', 55],
    ]) {
      const band = { x: 8, y, width: 200, height: 40 };
      const ink = await countPixels(ctx, band, DarkTheme.text, 6);
      const black = await countPixels(ctx, band, '#000000', 6);
      assert.ok(ink > 40, `${what} drew ${ink}px of the palette's ink`);
      assert.equal(black, 0, `${what} drew no black`);
    }
  });

  // **What the server fills a resize with.** Enlarging a window exposes area
  // before the app can possibly have drawn it, and X paints that area with
  // the window's background attribute in the meantime — so on a dark palette
  // a window with no attribute set flashes a bright rectangle on every drag
  // of the corner. The attribute is the colour that is about to be painted
  // there, so the flash is the same colour as the result.
  test('the X background attribute follows the palette', async () => {
    const { createMockApp } = await import('../src/testing/mock-app.js');
    const { createRoot } = await import('../src/index.js');
    const { setAppearanceForTests } = await import('../src/appearance.js');

    for (const [scheme, expected] of [
      ['light', DefaultTheme.background],
      ['dark', DarkTheme.background],
    ]) {
      const app = createMockApp();
      setAppearanceForTests(scheme === 'dark' ? { colorScheme: 'dark' } : {});
      const root = await createRoot({ app });
      root.render(React.createElement('window', { width: 100, height: 100 }));
      await new Promise((r) => setImmediate(r));
      const hex =
        '#' +
        app.windows[0].attributes.backgroundPixel.toString(16).padStart(6, '0');
      // 'white' is #ffffff; the dark palette names its own
      const want = expected === 'white' ? '#ffffff' : expected;
      assert.equal(hex, want, `${scheme} window background attribute`);
      await root.unmount();
    }
    setAppearanceForTests(null);
  });

  // **The strip a resize exposes**, measured where it actually comes from.
  // The X window's background attribute is not what is on screen: ntk
  // double-buffers, and it is the backing pixmap's newly grown area that a
  // drag of the corner shows until the next frame. It used to be cleared to
  // the screen's white whatever the window said — `setBackgroundPixel` sets
  // both halves at once now.
  test('a resize does not expose white', async () => {
    const { app } = await renderX11(
      React.createElement('box', { style: { flexGrow: 1 } }),
      { width: 200, height: 150, colorScheme: 'dark' },
    );
    await settle();
    const wnd = app._rootChildren[0].window;
    const X = app.X;
    // The pixmap is what is on screen, so it is what has to be inspected;
    // nothing here depends on it any more, ntk owns the clearing (ntk#209).
    assert.ok(wnd._backing != null, 'ntk still double-buffers');

    // Past the 128px backing granularity, so this is a *reallocation* and not
    // spare headroom being used up.
    X.ResizeWindow(wnd.id, 400, 400);
    await settle(app, 3);

    const image = await new Promise((res, rej) =>
      X.GetImage(2, wnd._backing.id, 250, 250, 8, 8, 0xffffffff, (e, i) =>
        e ? rej(e) : res(i),
      ),
    );
    const [b, g, r] = [image.data[0], image.data[1], image.data[2]];
    const hex =
      '#' + [r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('');
    assert.equal(hex, DarkTheme.background, 'the grown area, before any frame');
  });

  test('a window that names its own background keeps it', async () => {
    const { createMockApp } = await import('../src/testing/mock-app.js');
    const { createRoot } = await import('../src/index.js');
    const app = createMockApp();
    const root = await createRoot({ app });
    root.render(
      React.createElement('window', {
        width: 100,
        height: 100,
        style: { backgroundColor: '#123456' },
      }),
    );
    await new Promise((r) => setImmediate(r));
    assert.equal(app.windows[0].attributes.backgroundPixel, 0x123456);
    await root.unmount();
  });

  test('and light on a light desktop, with the same tree', async () => {
    const { ctx } = await renderX11(
      React.createElement(
        'box',
        { style: { flexGrow: 1 } },
        React.createElement(Swatch),
      ),
      { fonts: FONTS, colorScheme: 'light' },
    );
    await settle();
    assert.equal(shown(), `${DefaultTheme.background}|${DefaultTheme.radius}`);
    await expectPixel(ctx, 2, 2, '#ffffff', { tolerance: 2 });
  });
});

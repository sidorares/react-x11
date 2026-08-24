// The scale ladder's judgement calls, each pinned to the machine or lie it
// was designed against (src/scale.js). Everything here is a pure function of
// bytes and numbers — the one integration below runs the ladder against a
// mock app to prove the headless default stays exactly 1.
//
// The QEMU EDID is not synthetic: it is the block a UTM guest on a 16"
// MacBook actually serves, captured with `xrandr --verbose`. It claims
// 870x550mm — a 40" panel — for a screen that is physically 16 inches,
// which is the fabrication the whole `virtual` branch exists to catch.
import { test } from 'node:test';
import assert from 'node:assert';

import {
  parseResourceManager,
  parseEdid,
  classifyMm,
  isUnionOutput,
  monitorScaleFromMetadata,
  snapScale,
  desktopScaleFromXSettings,
  desktopScaleFromResources,
  beginScale,
  scaleOf,
  scaleSourceOf,
} from '../src/scale.js';

// -------------------------------------------------------------- fixtures

const QEMU_EDID = Buffer.from(
  '00ffffffffffff004914341200000000' +
    '2a180104a557377806ee91a3544c9926' +
    '0f5054210800e1c0d1c0d100a940b300' +
    '950081808140000000f7000a00408200' +
    '2820000000000000000000fd00327d1e' +
    'a0ff010a202020202020000000fc0051' +
    '454d55204d6f6e69746f720a00000010' +
    '00000000000000000000000000000281',
  'hex',
);

/** A believable panel EDID: vendor + size in cm + a product-name block. */
function panelEdid({ vendor = 0x0610 /* APP */, cmW = 34, cmH = 22 } = {}) {
  const b = Buffer.alloc(128);
  b.set([0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00], 0);
  b.writeUInt16BE(vendor, 8);
  b[21] = cmW;
  b[22] = cmH;
  b.set([0x00, 0x00, 0x00, 0xfc, 0x00], 54);
  b.write('Color LCD\n', 59, 'latin1');
  return b;
}

// --------------------------------------------------- RESOURCE_MANAGER text

test('parseResourceManager reads xrdb lines and skips junk', () => {
  const map = parseResourceManager(
    '*customization:\t-color\n' +
      'Xft.dpi:\t96\n' +
      'Xcursor.size:\t0\n' +
      '! a comment\n' +
      'broken-line-no-colon\n' +
      'Xft.rgba: none\n',
  );
  assert.strictEqual(map.get('Xft.dpi'), '96');
  assert.strictEqual(map.get('Xft.rgba'), 'none');
  assert.strictEqual(map.get('*customization'), '-color');
  assert.strictEqual(map.size, 4);
});

// ------------------------------------------------------------------ EDID

test('parseEdid reads the QEMU block: vendor RHT, fabricated size, virtual', () => {
  const edid = parseEdid(QEMU_EDID);
  assert.strictEqual(edid.vendor, 'RHT');
  assert.strictEqual(edid.model, 'QEMU Monitor');
  assert.strictEqual(edid.mmWidth, 870);
  assert.strictEqual(edid.mmHeight, 550);
  assert.strictEqual(edid.virtual, true);
});

test('parseEdid reads a real panel as not virtual', () => {
  const edid = parseEdid(panelEdid());
  assert.strictEqual(edid.vendor, 'APP');
  assert.strictEqual(edid.model, 'Color LCD');
  assert.strictEqual(edid.mmWidth, 340);
  assert.strictEqual(edid.mmHeight, 220);
  assert.strictEqual(edid.virtual, false);
});

test('parseEdid rejects short and headerless buffers', () => {
  assert.strictEqual(parseEdid(Buffer.alloc(64)), null);
  assert.strictEqual(parseEdid(Buffer.alloc(128)), null);
  assert.strictEqual(parseEdid(null), null);
});

// ----------------------------------------------------------- millimetres

test('classifyMm: honest panels are credible, including rotated ones', () => {
  assert.strictEqual(
    classifyMm(
      { name: 'eDP-1', widthMM: 344, heightMM: 215 },
      { width: 3456, height: 2234 },
    ),
    'credible',
  );
  // portrait CRTC on a landscape panel — a desk arrangement, not a lie
  assert.strictEqual(
    classifyMm(
      { name: 'DP-1', widthMM: 597, heightMM: 336 },
      { width: 1440, height: 2560 },
    ),
    'credible',
  );
});

test('classifyMm: the well-known lies each get their name', () => {
  assert.strictEqual(
    classifyMm({ name: 'HDMI-1', widthMM: 0, heightMM: 0 }, null),
    'absent',
  );
  assert.strictEqual(
    classifyMm(
      { name: 'HDMI-1', widthMM: 16, heightMM: 9 },
      { width: 1920, height: 1080 },
    ),
    'aspect-as-size',
  );
  assert.strictEqual(
    classifyMm(
      { name: 'HDMI-1', widthMM: 160, heightMM: 90 },
      { width: 1920, height: 1080 },
    ),
    'aspect-as-size',
  );
  // 4:3 millimetres against a 16:10 grid — one of them is wrong
  assert.strictEqual(
    classifyMm(
      { name: 'DP-2', widthMM: 400, heightMM: 300 },
      { width: 1920, height: 1200 },
    ),
    'aspect-mismatch',
  );
  assert.strictEqual(
    classifyMm(
      { name: 'Virtual-1', widthMM: 870, heightMM: 550 },
      { width: 3456, height: 2168 },
    ),
    'virtual',
  );
  assert.strictEqual(
    classifyMm(
      { name: 'XWAYLAND0', widthMM: 597, heightMM: 336 },
      { width: 1920, height: 1080 },
    ),
    'virtual',
  );
  assert.strictEqual(
    classifyMm(
      {
        name: 'HDMI-1',
        widthMM: 870,
        heightMM: 550,
        edid: parseEdid(QEMU_EDID),
      },
      { width: 3456, height: 2168 },
    ),
    'virtual',
  );
});

// --------------------------------------------------- per-monitor verdicts

const verdict = (m) => monitorScaleFromMetadata(m);

test('credible millimetres follow the viewing-distance model', () => {
  // the 16" MacBook panel itself: 255dpi in your lap → 2x, matching macOS
  assert.strictEqual(
    verdict({
      name: 'eDP-1',
      width: 3456,
      height: 2234,
      widthMM: 344,
      heightMM: 215,
    }).scale,
    2,
  );
  // 27" QHD desk monitor: the canonical 1x
  assert.strictEqual(
    verdict({
      name: 'DP-1',
      width: 2560,
      height: 1440,
      widthMM: 597,
      heightMM: 336,
    }).scale,
    1,
  );
  // 27" 4K: the canonical fractional
  assert.strictEqual(
    verdict({
      name: 'DP-1',
      width: 3840,
      height: 2160,
      widthMM: 597,
      heightMM: 336,
    }).scale,
    1.5,
  );
  // 13" 1080p laptop: dense but readable → 1.25
  assert.strictEqual(
    verdict({
      name: 'eDP-1',
      width: 1920,
      height: 1080,
      widthMM: 294,
      heightMM: 166,
    }).scale,
    1.25,
  );
  // a 55" TV is far away; its low density is correct, not small
  assert.strictEqual(
    verdict({
      name: 'HDMI-1',
      width: 3840,
      height: 2160,
      widthMM: 1218,
      heightMM: 685,
    }).scale,
    1,
  );
  // portrait 4K measures like its landscape neighbour
  assert.strictEqual(
    verdict({
      name: 'DP-2',
      width: 2160,
      height: 3840,
      widthMM: 336,
      heightMM: 597,
    }).scale,
    1.5,
  );
});

test('the machine this was built on: QEMU lies, the resolution class answers', () => {
  const v = verdict({
    name: 'Virtual-1',
    width: 3456,
    height: 2168,
    widthMM: 870,
    heightMM: 550,
    edid: parseEdid(QEMU_EDID),
  });
  assert.strictEqual(v.scale, 2);
  assert.strictEqual(v.source, 'resolution');
});

test('without physical data only the confident retina call is made', () => {
  // a VM window on an ordinary panel
  assert.strictEqual(
    verdict({
      name: 'Virtual-1',
      width: 1280,
      height: 800,
      widthMM: 338,
      heightMM: 211,
    }).scale,
    1,
  );
  // a projector reports no size and hangs on a wall — 1x
  assert.strictEqual(
    verdict({
      name: 'HDMI-1',
      width: 1920,
      height: 1080,
      widthMM: 0,
      heightMM: 0,
    }).scale,
    1,
  );
  // a 4K panel behind a KVM that stripped the EDID: still unmistakably dense
  const kvm = verdict({
    name: 'DP-1',
    width: 3840,
    height: 2160,
    widthMM: 0,
    heightMM: 0,
  });
  assert.strictEqual(kvm.scale, 2);
  assert.strictEqual(kvm.source, 'resolution');
  // 2560x1440 without millimetres could be a 27" desk monitor or a 13"
  // retina lid; the desk monitor is the common case and gets the call
  assert.strictEqual(
    verdict({
      name: 'DP-1',
      width: 2560,
      height: 1440,
      widthMM: 0,
      heightMM: 0,
    }).scale,
    1,
  );
});

// ---------------------------------------------------------------- snapping

test('snapScale lands on quarters inside [1, 3]', () => {
  assert.strictEqual(snapScale(1.89), 2);
  assert.strictEqual(snapScale(0.99), 1);
  assert.strictEqual(snapScale(1.48), 1.5);
  assert.strictEqual(snapScale(1.13), 1.25);
  assert.strictEqual(snapScale(5), 3);
  assert.strictEqual(snapScale(0.2), 1);
  assert.strictEqual(snapScale(NaN), 1);
});

// -------------------------------------------------- desktop-configured rungs

test('XSETTINGS: a configured factor answers, the untouched default does not', () => {
  assert.deepStrictEqual(
    desktopScaleFromXSettings(new Map([['Gdk/WindowScalingFactor', 2]])).scale,
    2,
  );
  // what xfsettingsd publishes before anyone opens the dialog — no answer
  assert.strictEqual(
    desktopScaleFromXSettings(
      new Map([
        ['Gdk/WindowScalingFactor', 1],
        ['Xft/DPI', 98304], // 96 x 1024, the wire's units
      ]),
    ),
    null,
  );
  // a configured HiDPI desktop publishes 1024ths...
  assert.strictEqual(
    desktopScaleFromXSettings(new Map([['Xft/DPI', 196608]])).scale,
    2,
  );
  // ...but a daemon writing plain dpi is read right too
  assert.strictEqual(
    desktopScaleFromXSettings(new Map([['Xft/DPI', 192]])).scale,
    2,
  );
  assert.strictEqual(
    desktopScaleFromXSettings(new Map([['Xft/DPI', 120 * 1024]])).scale,
    1.25,
  );
  assert.strictEqual(desktopScaleFromXSettings(new Map()), null);
  assert.strictEqual(desktopScaleFromXSettings(null), null);
});

test('RESOURCE_MANAGER: Xft.dpi answers except at the 96 default', () => {
  assert.strictEqual(
    desktopScaleFromResources(new Map([['Xft.dpi', '192']])).scale,
    2,
  );
  assert.strictEqual(
    desktopScaleFromResources(new Map([['Xft.dpi', '144']])).scale,
    1.5,
  );
  assert.strictEqual(
    desktopScaleFromResources(new Map([['Xft.dpi', '96']])),
    null,
  );
  assert.strictEqual(desktopScaleFromResources(new Map()), null);
});

// ------------------------------------------------------------- the ladder

test('a mock app resolves to exactly 1 — tests mean their numbers literally', async () => {
  const app = {};
  const session = await beginScale(app, 'auto');
  assert.strictEqual(session.scale, 1);
  assert.strictEqual(scaleOf(app), 1);
});

test('an explicit number pins the scale without a connection', async () => {
  const app = {};
  await beginScale(app, 1.5);
  assert.strictEqual(scaleOf(app), 1.5);
});

test('REACT_X11_SCALE outranks even the explicit option', async () => {
  process.env.REACT_X11_SCALE = '2';
  try {
    const app = {};
    await beginScale(app, 1);
    assert.strictEqual(scaleOf(app), 2);
  } finally {
    delete process.env.REACT_X11_SCALE;
  }
});

test('scaleOf answers 1 for an app the ladder never ran on', () => {
  assert.strictEqual(scaleOf({}), 1);
});

// --------------------------------------- servers that are not describing hardware

test('isUnionOutput: fewer outputs than heads means the list is not per-panel', () => {
  const one = [{ name: 'default' }];
  // XQuartz, Xvfb, VNC: one synthetic output, several real monitors
  assert.strictEqual(isUnionOutput(one, 3), true);
  assert.strictEqual(isUnionOutput(one, 2), true);
  // an ordinary desktop: RandR names every panel it drives
  assert.strictEqual(isUnionOutput([{}, {}], 2), false);
  assert.strictEqual(isUnionOutput(one, 1), false);
  // a mirrored pair is one head on two outputs — the disagreement that
  // fires this check only ever runs the other way
  assert.strictEqual(isUnionOutput([{}, {}], 1), false);
  // no Xinerama answer is not evidence of anything
  assert.strictEqual(isUnionOutput(one, null), false);
  assert.strictEqual(isUnionOutput(null, 3), false);
  assert.strictEqual(isUnionOutput([], 3), false);
});

test('a union output retires the resolution class but not the millimetres', () => {
  // the desktop this was found on: XQuartz over a retina lid and two 1x
  // monitors, unioned into 5120x2520 with no millimetres at all
  const union = { name: 'default', width: 5120, height: 2520 };
  assert.strictEqual(verdict(union).scale, 2); // what it used to answer
  const guarded = monitorScaleFromMetadata(union, { perPanel: false });
  assert.strictEqual(guarded.scale, 1);
  assert.strictEqual(guarded.source, 'default');
  assert.match(guarded.reason, /spans several monitors/);

  // rung 4 is untouched: an ultrawide split by `xrandr --setmonitor` is one
  // real panel with real millimetres, however its pixels were divided
  const ultrawide = monitorScaleFromMetadata(
    { name: 'DP-1', width: 5120, height: 2160, widthMM: 600, heightMM: 253 },
    { perPanel: false },
  );
  assert.strictEqual(ultrawide.source, 'randr-mm');
  assert.strictEqual(ultrawide.scale, 2);
});

/**
 * Enough of a connection for the ladder to climb: no XSETTINGS daemon (no
 * `GetSelectionOwner`, which is how `beginXSettings` says "nothing here"),
 * an empty `RESOURCE_MANAGER`, and a RandR walk that answers with whatever
 * outputs the test hands it. The methods are arrows because `readOutputs`
 * calls them unbound.
 */
function fakeConnection({ appleWM = false, outputs = [], heads = null } = {}) {
  const ids = outputs.map((_, i) => i + 1);
  const byId = new Map(ids.map((id, i) => [id, outputs[i]]));
  const randr = {
    GetScreenResourcesCurrent: (root, cb) =>
      cb(null, { outputs: ids, config_timestamp: 1 }),
    GetOutputPrimary: (root, cb) => cb(null, ids[0] ?? 0),
    GetOutputInfo: (id, ts, cb) => {
      const o = byId.get(id);
      cb(null, {
        name: o.name,
        connection: 0,
        crtc: id, // non-zero: readOutputs drops an output with no CRTC
        mm_width: o.widthMM ?? 0,
        mm_height: o.heightMM ?? 0,
      });
    },
    GetCrtcInfo: (crtc, ts, cb) => {
      const o = byId.get(crtc);
      cb(null, { x: 0, y: 0, width: o.width, height: o.height });
    },
    GetOutputProperty: (id, atom, a, b, c, d, e, cb) =>
      cb(null, { data: null }),
  };
  const xinerama = {
    QueryScreens: (cb) =>
      heads === null
        ? cb(new Error('no xinerama'))
        : cb(
            null,
            Array.from({ length: heads }, () => ({
              x: 0,
              y: 0,
              width: 1,
              height: 1,
            })),
          ),
  };
  const X = {
    display: { screen: [{ root: 1 }] },
    GetProperty: (del, wid, atom, type, long0, longN, cb) =>
      cb(null, { data: Buffer.alloc(0) }),
    InternAtom: (onlyIfExists, name, cb) => cb(null, 7),
    QueryExtension: (name, cb) =>
      cb(null, { present: name === 'Apple-WM' ? appleWM : false }),
    require: (name, cb) =>
      name === 'randr'
        ? cb(null, randr)
        : name === 'xinerama'
          ? cb(null, xinerama)
          : cb(new Error(`no ${name}`)),
  };
  return { X };
}

test('the hardware rungs read a retina panel on an ordinary server', async () => {
  // the control for the two guards below: same pixels, honest server
  const app = fakeConnection({
    outputs: [{ name: 'eDP-1', width: 3456, height: 2168 }],
    heads: 1,
  });
  await beginScale(app, 'auto');
  assert.strictEqual(scaleOf(app), 2);
  assert.strictEqual(scaleSourceOf(app), 'resolution');
});

test('XQuartz answers 1x: macOS handed X a point space it already scaled', async () => {
  const app = fakeConnection({
    appleWM: true,
    // the union XQuartz really reports for a retina lid + two 1x monitors
    outputs: [{ name: 'default', width: 5120, height: 2520 }],
    heads: 3,
  });
  await beginScale(app, 'auto');
  assert.strictEqual(scaleOf(app), 1);
  assert.strictEqual(scaleSourceOf(app), 'xquartz');
});

test('a single output covering several heads never reaches the resolution class', async () => {
  // not a Mac: Xvfb, a VNC server, an old driver — one `default` output
  // whose CRTC is two 2560x1440 monitors side by side
  const app = fakeConnection({
    outputs: [{ name: 'default', width: 5120, height: 1440 }],
    heads: 2,
  });
  await beginScale(app, 'auto');
  assert.strictEqual(scaleOf(app), 1);
  assert.strictEqual(scaleSourceOf(app), 'default');
});

test('a configured desktop still outranks both guards', async () => {
  process.env.GDK_SCALE = '2';
  try {
    const app = fakeConnection({ appleWM: true, heads: 3 });
    await beginScale(app, 'auto');
    assert.strictEqual(scaleOf(app), 2);
    assert.strictEqual(scaleSourceOf(app), 'GDK_SCALE');
  } finally {
    delete process.env.GDK_SCALE;
  }
});

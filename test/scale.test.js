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
  monitorScaleFromMetadata,
  snapScale,
  desktopScaleFromXSettings,
  desktopScaleFromResources,
  beginScale,
  scaleOf,
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

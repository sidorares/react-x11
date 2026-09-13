// The frame as the desktop describes it (framestyle.js) and as it is laid
// out (decorations.js): button layouts and Pango font names parsed the way
// GTK reads them, the shadow's margin by state, where the buttons are, what
// a point hits — and, against the mock compositor, window geometry and the
// input region excluding the shadow.
import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';

import {
  DEFAULTS,
  fromPortal,
  parseButtonLayout,
  parseFontName,
  titleFont,
} from '../../src/wayland/framestyle.js';
import {
  Decorations,
  RESIZE_MARGIN,
  SHADOW_MARGINS,
} from '../../src/wayland/decorations.js';
import {
  RESIZE_EDGE,
  TOPLEVEL_STATE,
  WaylandWindow,
} from '../../src/wayland/window.js';
import { WaylandConnection } from '../../src/wayland/connection.js';
import { MockCompositor, waylandClientAvailable } from './mock-compositor.js';

const SKIP = waylandClientAvailable
  ? false
  : 'wayland-client (the fork) is not installed';

test('button layouts: sides, unknown names dropped, each button once', () => {
  assert.deepEqual(parseButtonLayout('appmenu:close'), {
    left: [],
    right: ['close'],
  });
  assert.deepEqual(parseButtonLayout('icon,menu:minimize,maximize,close'), {
    left: [],
    right: ['minimize', 'maximize', 'close'],
  });
  assert.deepEqual(parseButtonLayout('close,minimize,maximize:'), {
    left: ['close', 'minimize', 'maximize'],
    right: [],
  });
  assert.deepEqual(parseButtonLayout('close'), { left: ['close'], right: [] });
  assert.deepEqual(parseButtonLayout('close:close,spacer,maximize'), {
    left: ['close'],
    right: ['maximize'],
  });
});

test('Pango font names: family, style words, size and unit', () => {
  assert.deepEqual(parseFontName('Sans 23'), {
    family: 'Sans',
    size: 23,
    unit: 'pt',
    weight: 400,
    italic: false,
  });
  const bold = parseFontName('Adwaita Sans Bold 11');
  assert.equal(bold.family, 'Adwaita Sans');
  assert.equal(bold.weight, 700);
  const px = parseFontName('DejaVu Sans Condensed Italic 12px');
  assert.equal(px.family, 'DejaVu Sans');
  assert.equal(px.italic, true);
  assert.equal(px.unit, 'px');
  assert.equal(parseFontName('Cantarell, Sans 11').family, 'Cantarell');
});

test('the title is the interface font, bold, at 96dpi times the scaling', () => {
  const t = titleFont({ ...DEFAULTS, fontName: 'Sans 23', textScaling: 1 });
  assert.equal(t.family, 'Sans');
  assert.equal(t.weight, 700);
  assert.ok(Math.abs(t.size - 30.667) < 0.01);
  assert.ok(
    Math.abs(titleFont({ ...DEFAULTS, textScaling: 1.25 }).size - 18.333) <
      0.01,
  );
});

test('the portal answer, with defaults for what it leaves out', () => {
  const s = fromPortal({
    'org.gnome.desktop.wm.preferences': {
      'button-layout': 'icon,menu:minimize,maximize,close',
    },
    'org.gnome.desktop.interface': { 'font-name': 'Sans 23' },
  });
  assert.equal(s.buttonLayout, 'icon,menu:minimize,maximize,close');
  assert.equal(s.fontName, 'Sans 23');
  assert.equal(s.doubleClick, 'toggle-maximize');
  assert.equal(fromPortal(null).fontName, DEFAULTS.fontName);
});

test('the shadow margin: a floating window has one, a maximised or tiled one not', () => {
  assert.deepEqual(Decorations.marginsFor(new Set()), SHADOW_MARGINS);
  for (const s of [
    TOPLEVEL_STATE.MAXIMIZED,
    TOPLEVEL_STATE.FULLSCREEN,
    TOPLEVEL_STATE.TILED_LEFT,
  ]) {
    assert.deepEqual(Decorations.marginsFor(new Set([s])), {
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
    });
  }
  assert.equal(Decorations.marginsFor(new Set(), false).left, 0);
});

function frame(style = DEFAULTS) {
  const d = new Decorations();
  d.setStyle(style, { colorScheme: 'dark' });
  d.marginsOf = () => Decorations.marginsFor(new Set(), true);
  return d;
}

test('insets: margin, then the headerbar and its hairline', () => {
  const d = frame();
  const i = d.insets();
  assert.equal(i.left, SHADOW_MARGINS.left);
  assert.equal(i.bottom, SHADOW_MARGINS.bottom);
  assert.equal(i.top, SHADOW_MARGINS.top + 47 + 1, '47px for an 11pt title');
  const big = frame({ ...DEFAULTS, fontName: 'Sans 23' });
  assert.equal(big.barHeight, 48, 'a 23pt title needs 48, as measured');
});

test('buttons where libadwaita puts them, and what points hit', () => {
  const d = frame({ ...DEFAULTS, buttonLayout: ':minimize,maximize,close' });
  const m = SHADOW_MARGINS;
  const gw = 640;
  const sw = gw + m.left + m.right;
  const sh = 300 + m.top + m.bottom;
  // centres 37px apart, the outermost 24px from the window's edge
  const at = (id) => d._buttons(gw).find((b) => b.id === id);
  assert.equal(at('close').cx, 616);
  assert.equal(at('maximize').cx, 579);
  assert.equal(at('minimize').cx, 542);
  const hit = (gx, gy) => d.hitTest(gx + m.left, gy + m.top, sw, sh);
  assert.deepEqual(hit(616, at('close').cy), { kind: 'button', id: 'close' });
  assert.deepEqual(hit(300, 20), { kind: 'titlebar' });
  assert.deepEqual(hit(300, 200), { kind: 'content' });
  assert.deepEqual(hit(-RESIZE_MARGIN + 1, 150), {
    kind: 'resize',
    edges: RESIZE_EDGE.LEFT,
  });
  assert.deepEqual(hit(-2, -2), {
    kind: 'resize',
    edges: RESIZE_EDGE.TOP_LEFT,
  });
  assert.deepEqual(hit(gw + 3, 300 - 5), {
    kind: 'resize',
    edges: RESIZE_EDGE.BOTTOM_RIGHT,
  });
  d.setState(new Set([TOPLEVEL_STATE.MAXIMIZED]));
  assert.equal(d.radius, 0, 'square once maximised');
});

test(
  'window geometry and the input region leave the shadow out',
  { skip: SKIP },
  async () => {
    const mock = new MockCompositor({ width: 800, height: 600 });
    const path = await mock.listen();
    const sock = net.createConnection(path);
    await new Promise((r) => sock.once('connect', r));
    const conn = await WaylandConnection.open({ socket: sock });
    try {
      const compositor = await conn.require('wl_compositor');
      const wmBase = await conn.require('xdg_wm_base');
      const m = SHADOW_MARGINS;
      const win = WaylandWindow.createSync({
        conn,
        compositor,
        wmBase,
        title: 'G',
        width: 400 + m.left + m.right,
        height: 300 + m.top + m.bottom,
      });
      win.compositor = compositor;
      win.marginsFor = (states) => Decorations.marginsFor(states, true);
      win.margins = win.marginsFor(win.states);
      await win.whenConfigured;
      win.ackPending();
      await conn.roundtrip();
      // the mock configures its own size; the surface is that plus the margin
      assert.equal(win.width, 800 + m.left + m.right);
      assert.equal(win.height, 600 + m.top + m.bottom);
      const geom = mock.sent('xdg_surface', 'set_window_geometry').at(-1);
      assert.deepEqual(geom.args, [m.left, m.top, 800, 600]);
      const add = mock.sent('wl_region', 'add').at(-1);
      assert.deepEqual(add.args, [m.left - 8, m.top - 8, 800 + 16, 600 + 16]);
      assert.equal(mock.sent('wl_surface', 'set_input_region').length, 1);
      win.destroy();
    } finally {
      conn.destroy();
      mock.close();
    }
  },
);

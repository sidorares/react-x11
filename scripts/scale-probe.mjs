#!/usr/bin/env node
// What can this display connection tell us about pixel density?
//
// Everything a react-x11 process could use to pick a scale factor, read the
// way the renderer itself would read it — over the X connection, no
// subprocesses, no xrdb, no gsettings. Point it at a display and it prints
// each source, what it says, and what scale each detection rung would
// conclude. The last line is the ladder's verdict, which is what
// `createRoot({ scale: 'auto' })` resolves.
//
//   node scripts/scale-probe.mjs             # $DISPLAY
//   DISPLAY=:1 node scripts/scale-probe.mjs  # another server
//
// The sources, in the order the ladder consults them (docs/scale.md):
//
//   1. environment      REACT_X11_SCALE, GDK_SCALE, QT_SCALE_FACTOR
//   2. XSETTINGS        Gdk/WindowScalingFactor, Gdk/UnscaledDPI, Xft/DPI
//   3. RESOURCE_MANAGER Xft.dpi (what `xrdb -query` shows)
//   4. RandR            per-output pixel and millimetre geometry + EDID
//   5. resolution class the retina-panel guess, when the mm are not credible
//
// Between 3 and 4 it also prints what kind of *server* this is, because two
// kinds retire the hardware rungs: XQuartz (macOS already composed in
// points) and any server whose single RandR output is really the union of
// several Xinerama heads.
//
// This is the probe that shaped the ladder: on the machine it was written
// against (a 16" MacBook panel handed 1:1 to a UTM Linux guest), sources
// 1-4 all answer "1x" — the VM's EDID invents 870x550mm to make the maths
// come out at ~100dpi — and only the resolution class knows the panel is
// retina. See docs/scale.md for why each rung outranks the next.

import x11 from 'x11';
import { parseXSettings } from '../src/xsettings.js';
import {
  parseEdid,
  parseResourceManager,
  monitorScaleFromMetadata,
  classifyMm,
  isUnionOutput,
} from '../src/scale.js';

const out = (...args) => console.log(...args);
const section = (title) => out(`\n=== ${title} ===`);

function connect() {
  return new Promise((resolve, reject) => {
    x11.createClient((err, display) => (err ? reject(err) : resolve(display)));
  });
}

const req =
  (X) =>
  (fn, ...args) =>
    new Promise((resolve) => {
      try {
        fn.call(X, ...args, (err, value) => resolve(err ? null : value));
      } catch {
        resolve(null);
      }
    });

function requireExt(X, display, name) {
  return new Promise((resolve) => {
    try {
      X.require(name, (err, ext) => resolve(err ? null : ext));
    } catch {
      resolve(null);
    }
  });
}

function getProperty(X, wid, atom, type = 0) {
  return new Promise((resolve) => {
    X.GetProperty(0, wid, atom, type, 0, 0x1fffffff, (err, prop) =>
      resolve(err ? null : prop),
    );
  });
}

const display = await connect().catch((e) => {
  console.error(
    `cannot connect to ${process.env.DISPLAY ?? '(unset)'}: ${e.message}`,
  );
  process.exit(1);
});
const X = display.client;
const call = req(X);
const screen = display.screen[0];
const root = screen.root;

// ---------------------------------------------------------------- 1. env
section('environment');
for (const name of [
  'REACT_X11_SCALE',
  'GDK_SCALE',
  'GDK_DPI_SCALE',
  'QT_SCALE_FACTOR',
  'QT_SCREEN_SCALE_FACTORS',
  'QT_AUTO_SCREEN_SCALE_FACTOR',
]) {
  out(`  ${name} = ${process.env[name] ?? '(unset)'}`);
}

// ------------------------------------------------------- 2. core screen
section('core protocol screen');
out(`  pixels      ${screen.pixel_width} x ${screen.pixel_height}`);
out(`  millimetres ${screen.mm_width} x ${screen.mm_height}`);
const coreDpi = (screen.pixel_width / (screen.mm_width / 25.4)).toFixed(1);
out(
  `  -> ${coreDpi} dpi  (servers synthesise mm to land near 96 — never trust this)`,
);

// -------------------------------------------------------- 3. XSETTINGS
section('XSETTINGS');
{
  const selection = await new Promise((resolve) =>
    X.InternAtom(false, '_XSETTINGS_S0', (err, atom) =>
      resolve(err ? null : atom),
    ),
  );
  const owner = selection
    ? await new Promise((resolve) =>
        X.GetSelectionOwner(selection, (err, wid) => resolve(err ? null : wid)),
      )
    : null;
  if (!owner) {
    out('  no settings daemon owns _XSETTINGS_S0');
  } else {
    out(`  manager window 0x${owner.toString(16)}`);
    const propAtom = await new Promise((resolve) =>
      X.InternAtom(false, '_XSETTINGS_SETTINGS', (err, atom) =>
        resolve(err ? null : atom),
      ),
    );
    const prop = propAtom ? await getProperty(X, owner, propAtom) : null;
    const map = prop?.data?.length ? parseXSettings(prop.data) : null;
    if (!map) {
      out('  _XSETTINGS_SETTINGS unreadable');
    } else {
      for (const key of [
        'Gdk/WindowScalingFactor',
        'Gdk/UnscaledDPI',
        'Xft/DPI',
        'Gtk/CursorThemeSize',
      ]) {
        if (map.has(key)) out(`  ${key} = ${map.get(key)}`);
        else out(`  ${key}   (absent)`);
      }
      const xftDpi = map.get('Xft/DPI');
      if (typeof xftDpi === 'number' && xftDpi > 0) {
        // In XSETTINGS the value is 1024ths of a dpi (GNOME, XFCE publish it
        // that way); a daemon writing plain dpi is legal too, so say both.
        const scaled = xftDpi > 1024 ? xftDpi / 1024 : xftDpi;
        out(
          `  -> Xft/DPI reads as ${scaled} dpi (${(scaled / 96).toFixed(2)}x)`,
        );
      }
    }
  }
}

// ------------------------------------------------ 4. RESOURCE_MANAGER
section('RESOURCE_MANAGER (xrdb)');
{
  const prop = await getProperty(X, root, 23 /* RESOURCE_MANAGER */, 31);
  if (!prop?.data?.length) {
    out('  property empty (nothing ever ran xrdb)');
  } else {
    const resources = parseResourceManager(prop.data.toString('latin1'));
    const interesting = ['Xft.dpi', 'Xcursor.size', 'Xft.rgba'];
    for (const key of interesting) {
      out(`  ${key}: ${resources.get(key) ?? '(absent)'}`);
    }
    const dpi = Number(resources.get('Xft.dpi'));
    if (Number.isFinite(dpi)) {
      out(`  -> Xft.dpi says ${(dpi / 96).toFixed(2)}x`);
    }
  }
}

// ------------------------------------------------- 5. the server itself
// Two facts about the *server* decide whether the hardware rungs below get
// to speak at all: XQuartz hands X macOS's point space (already scaled),
// and a server with no real output model answers RandR with one output
// covering every monitor, which Xinerama contradicts.
section('server');
const quartz = await new Promise((resolve) =>
  X.QueryExtension('Apple-WM', (err, reply) =>
    resolve(!err && !!reply?.present),
  ),
);
const heads = await (async () => {
  const xin = await requireExt(X, display, 'xinerama');
  if (!xin?.QueryScreens) return null;
  const screens = await call(xin.QueryScreens);
  return screens?.length ? screens.length : null;
})();
out(`  Apple-WM extension: ${quartz ? 'present — this is XQuartz' : 'absent'}`);
out(`  Xinerama heads: ${heads ?? '(no answer)'}`);
if (quartz) {
  out(
    '  -> the hardware rungs are skipped: macOS composes in points and\n' +
      '     scales onto the panel itself, so the ladder answers 1x',
  );
}

// --------------------------------------------------------- 6. RandR
section('RandR outputs');
const randr = await requireExt(X, display, 'randr');
if (!randr) {
  out('  extension not present');
} else {
  const res = await call(randr.GetScreenResourcesCurrent, root);
  const primary = await call(randr.GetOutputPrimary, root);
  const edidAtom = await new Promise((resolve) =>
    X.InternAtom(true, 'EDID', (err, atom) => resolve(err ? null : atom)),
  );
  // Collected before anything is judged: whether the resolution class gets
  // a vote depends on how many outputs there turn out to be (isUnionOutput).
  const connected = [];
  for (const id of res?.outputs ?? []) {
    const info = await call(randr.GetOutputInfo, id, res.config_timestamp);
    if (!info || info.connection !== 0) continue; // not connected
    const crtc = info.crtc
      ? await call(randr.GetCrtcInfo, info.crtc, res.config_timestamp)
      : null;
    connected.push({ id, info, crtc });
  }
  const perPanel = !isUnionOutput(connected, heads);
  if (!perPanel) {
    out(
      `  ${connected.length} connected output against ${heads} Xinerama heads —\n` +
        '  this output is the union of the desktop, not a panel, so its pixel\n' +
        '  count is not evidence of density (the resolution class is skipped)',
    );
  }
  for (const { id, info, crtc } of connected) {
    out(`  ${info.name}${id === primary ? ' (primary)' : ''}`);
    out(`    reported physical ${info.mm_width} x ${info.mm_height} mm`);
    if (crtc)
      out(`    pixels ${crtc.width} x ${crtc.height} at +${crtc.x}+${crtc.y}`);
    if (crtc && info.mm_width > 0) {
      const dpi = crtc.width / (info.mm_width / 25.4);
      const diag = Math.hypot(info.mm_width, info.mm_height) / 25.4;
      out(`    -> ${dpi.toFixed(1)} dpi across a ${diag.toFixed(1)}" diagonal`);
    }
    out(`    mm plausibility: ${classifyMm(info, crtc)}`);
    let edid = null;
    if (edidAtom) {
      const prop = await new Promise((resolve) =>
        randr.GetOutputProperty(id, edidAtom, 0, 0, 64, 0, 0, (err, p) =>
          resolve(err ? null : p),
        ),
      );
      if (prop?.data?.length >= 128) edid = parseEdid(prop.data);
    }
    if (!edid) {
      out('    EDID: none readable');
    } else {
      out(
        `    EDID: vendor ${edid.vendor}, model "${edid.model ?? '(unnamed)'}", ` +
          `${edid.mmWidth ?? '?'} x ${edid.mmHeight ?? '?'} mm` +
          (edid.virtual ? '  ** virtual machine display **' : ''),
      );
    }
    const verdict = monitorScaleFromMetadata(
      {
        name: info.name,
        width: crtc?.width ?? 0,
        height: crtc?.height ?? 0,
        widthMM: info.mm_width,
        heightMM: info.mm_height,
        edid,
      },
      { perPanel },
    );
    out(`    -> metadata verdict: ${verdict.scale}x (${verdict.reason})`);
  }
}

// ------------------------------------------------------ 7. Xinerama
section('Xinerama');
{
  const xin = await requireExt(X, display, 'xinerama');
  if (!xin?.QueryScreens) out('  extension not present');
  else {
    const screens = await call(xin.QueryScreens);
    if (!screens?.length) out('  inactive');
    else
      for (const s of screens)
        out(
          `  head ${s.width} x ${s.height} at +${s.x}+${s.y}  (geometry only — no density data)`,
        );
  }
}

section('verdict');
out(
  '  what createRoot({ scale: "auto" }) would resolve on this display is the\n' +
    '  first rung above that answered: env, then XSETTINGS/Xft.dpi when they\n' +
    '  say more than the 96dpi default, then credible RandR millimetres, then\n' +
    '  the resolution class of the panel. Run with REACT_X11_DEBUG_SCALE=1 in\n' +
    '  a real app to watch the same ladder resolve.',
);

X.close?.();
process.exit(0);

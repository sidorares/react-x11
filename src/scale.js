// The display scale: how many device pixels one logical pixel is worth.
//
// Every length an app writes — `width: 200`, `fontSize: 14`, the theme's
// spacing — is meant in *visible* pixels: units sized so that "14px text" is
// comfortably readable at the distance this kind of display is actually
// viewed from. On the panels the last decade shipped, one visible pixel is
// two device pixels (or 1.5, or 1.25), and a renderer that treats the two as
// the same unit draws every widget at half size. This module answers the one
// question that fixes that: **what is the factor, and how sure are we?**
//
// ## Where the answer can come from, and why this order
//
// X11 never grew a scale protocol, so the answer is scattered across four
// generations of convention. Each rung below is consulted only when the ones
// above it said nothing, and the order is "who is closest to a human having
// decided", not "who is most precise":
//
//   1. **Environment** — `REACT_X11_SCALE` (ours), then `GDK_SCALE` and
//      `QT_SCALE_FACTOR` (the user already told their other toolkits; an app
//      of ours on the same desktop should agree). A person typed these.
//   2. **XSETTINGS** — `Gdk/WindowScalingFactor` when it is 2 or more, then
//      `Xft/DPI`. This is what the desktop's own settings dialog writes, and
//      it is what every GTK app on the screen is already obeying — matching
//      it is what makes us look native. `WindowScalingFactor: 1` is *not* an
//      answer: it is the value daemons publish when nobody ever touched the
//      dialog, and treating it as "the user chose 1x" is how a toolkit ends
//      up microscopic on an unconfigured 4K laptop.
//   3. **`RESOURCE_MANAGER`** — `Xft.dpi`, the `xrdb` convention winit,
//      Chromium and every terminal emulator read. Same caveat, sharper: 96
//      exactly is the value of *never configured* (xfsettingsd writes it
//      unconditionally — the machine this was developed on says `Xft.dpi:
//      96` while driving a 254dpi panel), so 96 falls through to the
//      hardware and anything else is a person's decision.
//   4. **RandR millimetres** — the panel's physical size against its pixel
//      size, the only rung that needs no configuration at all. This is
//      mutter's model, constants and all: perceived size is angular, and a
//      laptop is read at half the distance of a desk monitor, so the DPI
//      that counts as "1x" is 135 under a 20" diagonal and 110 over it.
//      The catch is that the millimetres are self-reported EDID data, and
//      EDIDs lie in well-known ways — a projector reports zero, a KVM
//      strips the block, cheap panels report their *aspect ratio* as a
//      size, and **every virtual machine invents dimensions that make the
//      maths land on ~96dpi** (QEMU hands a 16" MacBook panel to the guest
//      as "870x550mm"). So the millimetres are audited before they are
//      believed — see `classifyMm` — and the EDID vendor is read precisely
//      to catch the VMs at it.
//   5. **The resolution class** — when the millimetres are absent or
//      caught lying, the pixel grid itself is the last signal standing.
//      Nobody makes a 1x panel 3456 pixels wide; a mode that size *is* a
//      retina panel (or a VM window covering one, which wants the same
//      answer). Only the confident call is made here — 2 for
//      unmistakably-retina grids, 1 for everything else — because
//      fractional guesses without physical data are how a UI ends up a
//      subtly wrong size everywhere.
//   6. **1**, the answer X11 shipped with in 1987.
//
// A machine can defeat every rung above the last two — the one this was
// written against does: UTM in retina mode hands the guest the MacBook's
// full 3456x2168 grid, QEMU's EDID invents millimetres that read as 100dpi,
// and XFCE publishes the 96 it was never asked to change. Rungs 1-4 all say
// "1x" on that box and are all wrong. Rung 5 is why the ladder still lands
// on 2.
//
// ## Per monitor, then one for the root
//
// Rungs 4 and 5 are computed for every connected output, because a desktop
// with a retina laptop lid and an office monitor genuinely has two answers.
// The *root's* scale — the one layout and paint use — is the primary
// output's, matching what GNOME does on X11: one scale for the session,
// chosen for the display you called primary. The per-output answers ride on
// `useScreens()` so an app that places windows can do better, and a window
// can be pinned with `<window scale={n}>`. What this deliberately does not
// do is re-scale a window as it is dragged between mismatched monitors:
// X11 has one coordinate space and no per-window scale protocol, so that
// move is a resize the WM fights; Qt is the one toolkit that tries, and
// "static per window, chosen at creation" is the behaviour of everything
// else on this window system.
//
// Resolution happens once, inside `createRoot`, before the first window
// realizes — the scale multiplies CreateWindow geometry, so it cannot
// arrive later. The cost is honest: the environment is free, XSETTINGS is
// already being read for other reasons, and the RandR walk (three batched
// round trips) is only paid on desktops where nothing cheaper answered.
//
// `REACT_X11_DEBUG_SCALE=1` prints every rung's evidence and verdict.

import { beginXSettings } from './xsettings.js';

import { requireExtension } from './extensions.js';

const sessions = new WeakMap();

const debugScale = process.env.REACT_X11_DEBUG_SCALE === '1';
const trace = (...args) => {
  if (debugScale) console.error('react-x11 scale:', ...args);
};

// --------------------------------------------------------------------------
// Small parsers, exported for the probe (`scripts/scale-probe.mjs`) and the
// tests — everything here is a pure function of bytes it was handed.
// --------------------------------------------------------------------------

/**
 * `RESOURCE_MANAGER` is the text `xrdb` loaded, one `name: value` per line.
 * Only the flat, fully-qualified names matter here (`Xft.dpi: 192`); the
 * wildcard grammar (`*dpi`, `?`) is for matching against widget paths, which
 * is a lookup this module never does.
 */
export function parseResourceManager(text) {
  const out = new Map();
  if (typeof text !== 'string') return out;
  for (const line of text.split('\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim();
    if (!name || name.startsWith('!')) continue;
    out.set(name, line.slice(colon + 1).trim());
  }
  return out;
}

/** PNP vendor id: three letters, five bits each, packed big-endian into
 *  bytes 8-9 of the EDID block. `A` is 1. */
function edidVendor(buffer) {
  const raw = (buffer[8] << 8) | buffer[9];
  const letter = (n) => String.fromCharCode(64 + ((raw >> n) & 0x1f));
  const vendor = letter(10) + letter(5) + letter(0);
  return /^[A-Z]{3}$/.test(vendor) ? vendor : null;
}

/**
 * The EDID vendors and model strings that mean "this display is software".
 *
 * QEMU registered `RHT` (Red Hat); VMware, VirtualBox, Parallels and
 * Hyper-V each have their own. The model-name check backs the vendor list
 * up because nested and forked hypervisors ship EDIDs with the name kept
 * and the vendor changed. Matching one of these does not make the *pixels*
 * less real — it makes the *millimetres* fiction, because a VM's EDID
 * describes a window, not a panel, and every hypervisor fills the size in
 * with whatever makes ~96dpi come out.
 */
const VIRTUAL_EDID_VENDORS = new Set([
  'RHT',
  'VMW',
  'VBX',
  'PRL',
  'MSF',
  'XEN',
]);
const VIRTUAL_MODEL = /qemu|virtual|vbox|vmware|parallels|bochs|bhyve/i;

/**
 * The 128-byte EDID base block → what the scale ladder wants from it:
 * vendor, model name, the physical size, and the one derived judgement —
 * `virtual` — that says the size is invented.
 *
 * Not a general EDID parser on purpose. Detailed timing descriptors carry a
 * second, finer physical size, but a lying EDID lies in both places, so
 * reading it would add code and no information.
 */
export function parseEdid(buffer) {
  if (!buffer || buffer.length < 128) return null;
  // the fixed 8-byte header; anything else is not an EDID
  if (
    buffer[0] !== 0x00 ||
    buffer[1] !== 0xff ||
    buffer[6] !== 0xff ||
    buffer[7] !== 0x00
  ) {
    return null;
  }
  const vendor = edidVendor(buffer);
  // bytes 21/22: maximum image size in whole centimetres; 0 means "unknown
  // or variable", which projectors use honestly and KVMs use lazily
  const mmWidth = buffer[21] ? buffer[21] * 10 : null;
  const mmHeight = buffer[22] ? buffer[22] * 10 : null;
  let model = null;
  // four 18-byte descriptors; 0xFC is the display product name
  for (let at = 54; at + 18 <= 126; at += 18) {
    if (buffer[at] === 0 && buffer[at + 1] === 0 && buffer[at + 3] === 0xfc) {
      model = buffer
        .toString('latin1', at + 5, at + 18)
        .split('\n')[0]
        .trim();
      break;
    }
  }
  const virtual =
    (vendor !== null && VIRTUAL_EDID_VENDORS.has(vendor)) ||
    (model !== null && VIRTUAL_MODEL.test(model));
  return { vendor, model, mmWidth, mmHeight, virtual };
}

// --------------------------------------------------------------------------
// Judging a monitor's metadata
// --------------------------------------------------------------------------

/** Output names that mean the display is software even when no EDID says so:
 *  QEMU's virtio connector, VirtualBox's, VMware's, qxl. `XWAYLAND` is here
 *  for a different reason — those millimetres are usually *true*, but the
 *  compositor owns scaling on that path and publishes its decision through
 *  XSETTINGS, so hardware inference would double what rung 2 already knows. */
const VIRTUAL_OUTPUT_NAME =
  /^(Virtual|VIRTUAL|VBOX|VMWARE|qxl|hyperv|XWAYLAND)/i;

/**
 * Can these millimetres be trusted to compute a density?  Returns
 * `'credible'` or the reason they cannot be:
 *
 *   'absent'          zero or missing — projectors, stripped EDIDs
 *   'virtual'         a VM's EDID or connector; the size is invented
 *   'aspect-as-size'  the panel wrote its aspect ratio where the size goes
 *                     (16x9 "millimetres" — a real panel the size of a
 *                     matchbook does not exist)
 *   'aspect-mismatch' the physical and pixel aspect ratios disagree by more
 *                     than a quarter — one of them is wrong and there is no
 *                     way to know which
 *
 * A *huge* diagonal is deliberately not a reason: a 60" panel is a real
 * thing with real millimetres, and the viewing-distance model below already
 * answers it with 1x. The audit here is only about lies.
 */
export function classifyMm(output, crtc) {
  const mmW = output?.mm_width ?? output?.widthMM ?? 0;
  const mmH = output?.mm_height ?? output?.heightMM ?? 0;
  const name = output?.name ?? '';
  const edid = output?.edid ?? null;
  if (edid?.virtual || VIRTUAL_OUTPUT_NAME.test(name)) return 'virtual';
  if (!(mmW > 0) || !(mmH > 0)) return 'absent';
  // the classic junk values: an aspect ratio in a size's clothing
  if (mmW <= 16 && mmH <= 16) return 'aspect-as-size';
  if ((mmW === 160 && mmH === 90) || (mmW === 160 && mmH === 100))
    return 'aspect-as-size';
  const pxW = crtc?.width ?? output?.width ?? 0;
  const pxH = crtc?.height ?? output?.height ?? 0;
  if (pxW > 0 && pxH > 0) {
    // compare in a rotation-proof way: a portrait CRTC on a landscape panel
    // is a real desk arrangement, not a lie
    // 0.15 is picked to pass a panel whose EDID measured the module with
    // its bezel (16:9 pixels on 16:10-ish glass is ~0.11 off) and fail the
    // classic lie of 4:3 millimetres on a 16:10 grid (~0.2 off).
    const pxAspect = Math.max(pxW, pxH) / Math.min(pxW, pxH);
    const mmAspect = Math.max(mmW, mmH) / Math.min(mmW, mmH);
    if (Math.abs(pxAspect - mmAspect) / mmAspect > 0.15)
      return 'aspect-mismatch';
  }
  return 'credible';
}

/**
 * mutter's perceptual model, constants and all: the DPI that reads as "1x"
 * depends on viewing distance, and diagonal size is the proxy for distance
 * that actually ships. Under 20 inches the panel is in your lap at ~50cm
 * and 135dpi is the baseline; over it the panel is across a desk and 110
 * is. (For calibration: a 27" 2560x1440 desk monitor computes 109dpi → 1x;
 * a 16" MacBook panel computes 255dpi → 1.9 → 2x; a 13" 1920x1080 laptop
 * computes 169dpi → 1.25.)
 */
const TARGET_DPI_MOBILE = 135;
const TARGET_DPI_LARGE = 110;
const MOBILE_DIAGONAL_INCHES = 20;

/** Snap to the quarter steps every desktop offers, inside [1, 3]. Quarters
 *  are what the plumbing downstream can draw crisply — layout snaps to the
 *  device grid through yoga's point scale — and three doubles the largest
 *  factor any shipping desktop configures. */
export function snapScale(value) {
  if (!Number.isFinite(value)) return 1;
  return Math.min(3, Math.max(1, Math.round(value * 4) / 4));
}

/**
 * One monitor's metadata → `{ scale, source, reason }`, using only what the
 * connection reported: pixel geometry, claimed millimetres, EDID. This is
 * rungs 4 and 5 of the ladder for one output; the caller stacks the
 * desktop-configuration rungs above it.
 */
export function monitorScaleFromMetadata(monitor) {
  const mm = classifyMm(monitor, monitor);
  const pxW = monitor.width ?? 0;
  const pxH = monitor.height ?? 0;
  const mmW = monitor.widthMM ?? monitor.mm_width ?? 0;
  const mmH = monitor.heightMM ?? monitor.mm_height ?? 0;

  if (mm === 'credible' && pxW > 0) {
    const diagonalInches = Math.hypot(mmW, mmH) / 25.4;
    // long pixel axis over long physical axis, so a portrait CRTC on a
    // landscape panel measures the same density as its neighbour
    const dpi = Math.max(pxW, pxH) / (Math.max(mmW, mmH) / 25.4);
    const target =
      diagonalInches < MOBILE_DIAGONAL_INCHES
        ? TARGET_DPI_MOBILE
        : TARGET_DPI_LARGE;
    const scale = snapScale(dpi / target);
    return {
      scale,
      source: 'randr-mm',
      reason: `${Math.round(dpi)}dpi across ${diagonalInches.toFixed(1)}" (target ${target})`,
    };
  }

  // No physical truth to reason from. The pixel grid alone still separates
  // "unmistakably a retina panel" from everything else: the smallest grids
  // this matches are 2880x1800 and 3024x1964, both shipped only as 2x
  // panels, and every VM window covering one lands here too. 2560-wide
  // grids stay at 1 on purpose — 2560x1440 is the commonest *1x* desk
  // monitor there is, and only millimetres could tell it from a 13" retina
  // lid, which is exactly the data this branch does not have.
  if (Math.min(pxW, pxH) >= 1800 || Math.max(pxW, pxH) >= 3000) {
    return {
      scale: 2,
      source: 'resolution',
      reason: `${pxW}x${pxH} is a retina-class grid (mm ${mm})`,
    };
  }
  return {
    scale: 1,
    source: 'default',
    reason: `no credible density data (mm ${mm}, ${pxW}x${pxH})`,
  };
}

// --------------------------------------------------------------------------
// The desktop-configuration rungs
// --------------------------------------------------------------------------

function envScale() {
  const own = Number(process.env.REACT_X11_SCALE);
  // wider bounds than `snapScale` on purpose: an explicit override is a
  // person telling us, and 0.5 ("shrink it, my panel is dense and my eyes
  // are good") is a thing people legitimately ask toolkits for
  if (Number.isFinite(own) && own >= 0.5 && own <= 8) {
    return { scale: own, source: 'REACT_X11_SCALE' };
  }
  const gdk = Number(process.env.GDK_SCALE);
  if (Number.isInteger(gdk) && gdk >= 1 && gdk <= 8 && gdk !== 1) {
    return { scale: gdk, source: 'GDK_SCALE' };
  }
  const qt = Number(process.env.QT_SCALE_FACTOR);
  if (Number.isFinite(qt) && qt > 0 && qt <= 8 && qt !== 1) {
    return { scale: qt, source: 'QT_SCALE_FACTOR' };
  }
  return null;
}

/**
 * `Xft/DPI` on the wire is 1024ths of a dot per inch — the machine this
 * was written on publishes 98304, which is 96 — but daemons writing plain
 * DPI exist too, and no plausible density is over 1024, so the magnitude
 * itself says which convention the daemon used.
 */
function dpiFromXftValue(value) {
  if (typeof value !== 'number' || value <= 0) return null;
  return value > 1024 ? value / 1024 : value;
}

/** Rung 2 as a pure function of the XSETTINGS map — exported for the tests. */
export function desktopScaleFromXSettings(map) {
  if (!map) return null;
  const factor = map.get('Gdk/WindowScalingFactor');
  // 2 and up is a decision; 1 is what the dialog says before anyone opens it
  if (Number.isInteger(factor) && factor >= 2) {
    return { scale: Math.min(factor, 8), source: 'Gdk/WindowScalingFactor' };
  }
  const dpi = dpiFromXftValue(map.get('Xft/DPI'));
  if (dpi !== null && Math.round(dpi) !== 96) {
    return {
      scale: snapScale(dpi / 96),
      source: `Xft/DPI (${Math.round(dpi)})`,
    };
  }
  return null;
}

/** Rung 3 as a pure function of the parsed resource map — for the tests. */
export function desktopScaleFromResources(resources) {
  const dpi = Number(resources.get('Xft.dpi'));
  if (Number.isFinite(dpi) && dpi > 0 && Math.round(dpi) !== 96) {
    return {
      scale: snapScale(dpi / 96),
      source: `Xft.dpi (${Math.round(dpi)})`,
    };
  }
  return null;
}

// --------------------------------------------------------------------------
// Reading the connection
// --------------------------------------------------------------------------

/** A node-x11 request as a promise that resolves null on error, because
 *  every read here is a rung that is allowed to answer nothing. */
function call(fn, ...args) {
  return new Promise((resolve) => {
    try {
      fn(...args, (err, value) => resolve(err ? null : value));
    } catch {
      resolve(null);
    }
  });
}

const RESOURCE_MANAGER_ATOM = 23; // predefined, like the STRING type it holds

async function readResourceManager(X, root) {
  const prop = await call(
    X.GetProperty.bind(X),
    0,
    root,
    RESOURCE_MANAGER_ATOM,
    0,
    0,
    0x1fffffff,
  );
  if (!prop?.data?.length) return new Map();
  return parseResourceManager(prop.data.toString('latin1'));
}

/**
 * The hardware walk: every connected output's pixel geometry, claimed
 * millimetres and EDID, in three batched round trips (resources, then all
 * output infos at once, then all CRTCs and EDIDs at once). Only run when
 * every configured rung came up empty.
 */
async function readOutputs(app) {
  const randr = await requireExtension(app, 'randr');
  const X = app.X;
  const root = X.display?.screen?.[0]?.root;
  if (!randr || root == null) return null;
  const resources = await call(randr.GetScreenResourcesCurrent, root);
  if (!resources) return null;
  const primary = await call(randr.GetOutputPrimary, root);
  const edidAtom = await new Promise((resolve) =>
    X.InternAtom(false, 'EDID', (err, atom) => resolve(err ? null : atom)),
  );
  const infos = (
    await Promise.all(
      (resources.outputs ?? []).map((id) =>
        call(randr.GetOutputInfo, id, resources.config_timestamp).then(
          (info) => (info ? { ...info, id } : null),
        ),
      ),
    )
  ).filter((info) => info && info.connection === 0 && info.crtc);
  const monitors = await Promise.all(
    infos.map(async (info) => {
      const [crtc, edidProp] = await Promise.all([
        call(randr.GetCrtcInfo, info.crtc, resources.config_timestamp),
        edidAtom
          ? call(randr.GetOutputProperty, info.id, edidAtom, 0, 0, 64, 0, 0)
          : null,
      ]);
      if (!crtc || !(crtc.width > 0)) return null;
      return {
        name: info.name,
        primary: info.id === primary,
        x: crtc.x,
        y: crtc.y,
        width: crtc.width,
        height: crtc.height,
        widthMM: info.mm_width,
        heightMM: info.mm_height,
        edid: edidProp?.data?.length >= 128 ? parseEdid(edidProp.data) : null,
      };
    }),
  );
  const connected = monitors.filter(Boolean);
  return connected.length ? connected : null;
}

// --------------------------------------------------------------------------
// The session
// --------------------------------------------------------------------------

class ScaleSession {
  constructor() {
    /** The root's factor — what layout, fonts and paint multiply by. */
    this.scale = 1;
    /** Which rung answered, for `REACT_X11_DEBUG_SCALE` and the tests. */
    this.source = 'default';
    /** Per-output verdicts, keyed by RandR output name, for `useScreens`
     *  and for windows placed by an app that knows better than "primary". */
    this.monitors = new Map();
  }
}

/**
 * Resolve the scale for this connection. Called from `createRoot`, awaited,
 * before any window realizes — the factor multiplies CreateWindow geometry,
 * so it has to be settled first and stay settled (see the header for why it
 * is static).
 *
 * `option` is `createRoot`'s `scale`: a number pins it (clamped to [0.5, 8]
 * — past those bounds it is a typo, not a preference), `'auto'` or
 * `undefined` climbs the ladder. `REACT_X11_SCALE` outranks even the
 * explicit number, because the person running the app outranks the person
 * who wrote it — that is the accessibility escape hatch when a hardcoded
 * `scale: 1` meets a screen it is wrong on.
 */
export async function beginScale(app, option) {
  let session = sessions.get(app);
  if (session) return session;
  session = new ScaleSession();
  sessions.set(app, session);

  const own = Number(process.env.REACT_X11_SCALE);
  if (Number.isFinite(own) && own >= 0.5 && own <= 8) {
    session.scale = own;
    session.source = 'REACT_X11_SCALE';
    trace(`${session.scale}x from REACT_X11_SCALE`);
    return session;
  }

  if (typeof option === 'number' && Number.isFinite(option)) {
    session.scale = Math.min(8, Math.max(0.5, option));
    session.source = 'option';
    trace(`${session.scale}x from createRoot({ scale })`);
    return session;
  }

  const X = app?.X;
  const root = X?.display?.screen?.[0]?.root;
  if (!X || typeof X.GetProperty !== 'function' || root == null) {
    // the headless mock: tests mean their numbers literally
    return session;
  }

  const env = envScale();
  if (env) {
    session.scale = env.scale;
    session.source = env.source;
    trace(`${env.scale}x from ${env.source}`);
    return session;
  }

  // Rung 2: the desktop's own channel. `beginXSettings` is idempotent and
  // shared with appearance/desktopsettings; awaiting it here costs the one
  // selection-owner round trip this path needed anyway.
  const xsettings = await beginXSettings(app);
  const fromDaemon = desktopScaleFromXSettings(xsettings?.values);
  if (fromDaemon) {
    session.scale = fromDaemon.scale;
    session.source = fromDaemon.source;
    trace(`${fromDaemon.scale}x from XSETTINGS ${fromDaemon.source}`);
    return session;
  }

  // Rung 3: xrdb.
  const resources = await readResourceManager(X, root);
  const fromXrdb = desktopScaleFromResources(resources);
  if (fromXrdb) {
    session.scale = fromXrdb.scale;
    session.source = fromXrdb.source;
    trace(`${fromXrdb.scale}x from RESOURCE_MANAGER ${fromXrdb.source}`);
    return session;
  }

  // Rungs 4-5: the hardware, one verdict per output.
  const outputs = await readOutputs(app);
  if (outputs) {
    for (const monitor of outputs) {
      const verdict = monitorScaleFromMetadata(monitor);
      session.monitors.set(monitor.name, {
        scale: verdict.scale,
        source: verdict.source,
        primary: monitor.primary,
        x: monitor.x,
        y: monitor.y,
        width: monitor.width,
        height: monitor.height,
      });
      trace(
        `  ${monitor.name}${monitor.primary ? ' (primary)' : ''}: ` +
          `${verdict.scale}x via ${verdict.source} — ${verdict.reason}`,
      );
    }
    // The root's answer: the primary output's, like GNOME on X11. No
    // primary flag is a desktop that never ran `xrandr --primary`; the
    // largest output is the best stand-in for "the one you look at".
    const chosen =
      [...session.monitors.values()].find((m) => m.primary) ??
      [...session.monitors.values()].sort(
        (a, b) => b.width * b.height - a.width * a.height,
      )[0];
    if (chosen) {
      session.scale = chosen.scale;
      session.source = chosen.source;
    }
  }
  trace(`${session.scale}x from ${session.source}`);
  return session;
}

/**
 * The resolved factor for this connection — 1 until `beginScale` settles,
 * which `createRoot` guarantees happened before anything renders.
 * Synchronous because its callers are: styles apply inside React's commit,
 * paint runs inside the frame clock, and neither has a round trip to spend.
 */
export function scaleOf(app) {
  return sessions.get(app)?.scale ?? 1;
}

/** Which rung answered, for tests and the debug overlay. */
export function scaleSourceOf(app) {
  return sessions.get(app)?.source ?? 'default';
}

/** Per-output verdicts (name → {scale, source, primary, geometry}), for
 *  `useScreens` to join onto its monitor list. Empty on desktops where a
 *  configured rung answered — one factor is the whole story there. */
export function monitorScalesOf(app) {
  return sessions.get(app)?.monitors ?? new Map();
}

/** Tests pin the factor without a connection. */
export function setScaleForTests(app, scale, source = 'test') {
  let session = sessions.get(app);
  if (!session) {
    session = new ScaleSession();
    sessions.set(app, session);
  }
  session.scale = scale;
  session.source = source;
  return session;
}

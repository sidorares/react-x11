// Capture examples WITH their window-manager frame, against a real X server.
//
//   npm run screenshots:framed              # all scenes
//   npm run screenshots:framed widgets form # just these
//
// Unlike `npm run screenshots` (which renders into node-x11's in-process X
// server and therefore has no window manager and no frames), this needs a
// real DISPLAY with a *reparenting* WM: quartz-wm on XQuartz, mutter/openbox
// /etc. on Linux. Such a WM puts the client window inside a frame window
// that is a child of root, and draws the decoration into it — on XQuartz via
// the Apple-WM extension's FrameDraw, so the Aqua titlebar is real X pixels
// that GetImage can read.
//
// GetImage on a window returns the current *screen* contents of that region,
// so anything overlapping the window would be captured instead of it. To
// avoid that the window is floated above everything else: Apple-WM's
// SetWindowLevel(Floating) where available, plus a plain RaiseWindow.
import { createClient } from 'ntk';
import { PNG } from 'pngjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import React from 'react';

process.env.REACT_X11_NO_AUTORUN = '1';
const { createRoot } = await import('../src/index.js');

const outDir =
  process.env.SHOT_DIR ??
  join(
    dirname(new URL(import.meta.url).pathname),
    '..',
    'docs',
    'img',
    'framed',
  );

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- scenes ----------------------------------------------------------------

const SCENES = {
  widgets: () => import('../examples/widgets.jsx'),
  dashboard: () => import('../examples/dashboard.jsx'),
  tasks: () => import('../examples/tasks.jsx'),
  form: () => import('../examples/form.jsx'),
};

const wanted = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const scenes = wanted.length ? wanted : Object.keys(SCENES);
for (const name of scenes) {
  if (!SCENES[name]) {
    console.error(
      `unknown scene "${name}" (have: ${Object.keys(SCENES).join(', ')})`,
    );
    process.exit(2);
  }
}

// --- X helpers -------------------------------------------------------------

const cb2p =
  (fn) =>
  (...args) =>
    new Promise((res, rej) => fn(...args, (e, v) => (e ? rej(e) : res(v))));

/** Float the window above everything so GetImage cannot capture an
 *  overlapping window instead. Apple-WM window levels are the only
 *  always-on-top mechanism on XQuartz — quartz-wm does not advertise
 *  _NET_WM_STATE_ABOVE.
 *
 *  Pass the FRAME, not the client: once a WM has reparented us the client
 *  is no longer a child of root, and SetWindowLevel answers BadWindow for
 *  it (opcode 130). The level belongs on the window the WM manages. */
async function floatOnTop(app, wid) {
  const X = app.X;
  let via = 'RaiseWindow';
  const appleWM = await new Promise((res) =>
    X.require('apple-wm', (err, ext) => res(err ? null : ext)),
  ).catch(() => null);
  if (appleWM) {
    appleWM.SetWindowLevel(wid, appleWM.WindowLevel.Floating);
    via = 'Apple-WM SetWindowLevel(Floating)';
  }
  X.RaiseWindow(wid);
  return via;
}

/** Walk up from the client window to the frame the WM reparented it into:
 *  the ancestor whose parent is root. Returns the client itself when no
 *  reparenting WM is running (nothing to capture but the client). */
async function findFrame(app, wid) {
  const X = app.X;
  const queryTree = cb2p(X.QueryTree.bind(X));
  const root = app.display.screen[0].root;
  let frame = wid;
  for (let hops = 0; hops < 8; hops++) {
    const { parent } = await queryTree(frame);
    if (!parent || parent === root) break;
    frame = parent;
  }
  return { frame, reparented: frame !== wid };
}

async function capture(app, drawable, file) {
  const X = app.X;
  const geom = await cb2p(X.GetGeometry.bind(X))(drawable);
  const img = await cb2p(X.GetImage.bind(X))(
    2 /* ZPixmap */,
    drawable,
    0,
    0,
    geom.width,
    geom.height,
    0xffffffff,
  );
  const png = new PNG({ width: geom.width, height: geom.height });
  for (let i = 0; i < geom.width * geom.height; i++) {
    png.data[i * 4 + 0] = img.data[i * 4 + 2]; // BGRA -> RGBA
    png.data[i * 4 + 1] = img.data[i * 4 + 1];
    png.data[i * 4 + 2] = img.data[i * 4 + 0];
    png.data[i * 4 + 3] = 255;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, PNG.sync.write(png));
  return geom;
}

// --- run -------------------------------------------------------------------

if (!process.env.DISPLAY) {
  console.error(
    'no DISPLAY — this script needs a real X server with a reparenting window\n' +
      'manager (XQuartz on macOS, any normal WM on Linux). For headless,\n' +
      'frameless screenshots use `npm run screenshots`.',
  );
  process.exit(1);
}

// One connection for every scene: closing an ntk app while property round
// trips are still in flight can hang (see AGENTS.md), and reconnecting per
// scene is slower for no benefit.
const app = await createClient();
const x11Root = await createRoot({ app });
const created = [];
const origCreate = app.createWindow.bind(app);
app.createWindow = (attrs) => {
  const w = origCreate(attrs);
  created.push(w);
  return w;
};

/** Drain pending round trips so a following close() cannot race them. */
const settle = () =>
  cb2p(app.X.GetGeometry.bind(app.X))(app.display.screen[0].root);

for (const name of scenes) {
  const { default: App } = await SCENES[name]();
  created.length = 0;

  await new Promise((resolve) =>
    x11Root.render(React.createElement(App), resolve),
  );
  await sleep(400); // map + WM reparent + first paint

  const wnd = created[0];
  const { frame, reparented } = await findFrame(app, wnd.id);
  const via = await floatOnTop(app, frame);
  await sleep(500); // let the WM restack and redraw the frame

  const geom = await capture(app, frame, join(outDir, `${name}.png`));
  console.log(
    `${name}: ${geom.width}x${geom.height} ` +
      (reparented
        ? `(framed, raised via ${via})`
        : '(NO frame — no reparenting WM running?)'),
  );

  await x11Root.unmount();
  await settle();
  await sleep(150);
}

await settle();
await app.close();
process.exit(0);

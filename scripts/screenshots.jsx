// Regenerates the README screenshots (docs/img/*.png) headlessly: renders
// the real examples into node-x11's in-process pure-JS X server, drives
// them through the real event pipeline (clicks, typing, opening the Select
// popup), reads pixels back with GetImage and writes PNGs. No $DISPLAY.
//
//   npm run screenshots
//
// Text is set in a system sans-serif (UI text in a small serif looks like
// a LaTeX document, not a UI): Arial on macOS, Liberation Sans / DejaVu
// Sans on Linux, with ntk's bundled KaTeX fonts as a last resort.
// `dashboard` renders a live clock and this process's heap usage, so
// without pinning both its PNG differs on every run and `npm run
// screenshots` leaves the tree dirty whether or not anything changed —
// which makes the diff useless as a signal that a change was visible.
process.env.TZ = 'UTC';
const realMemoryUsage = process.memoryUsage.bind(process);
process.memoryUsage = () => ({
  ...realMemoryUsage(),
  heapUsed: 42 * 1024 * 1024,
  heapTotal: 64 * 1024 * 1024,
});
const FROZEN_MS = Date.UTC(2026, 0, 1, 9, 41, 0);
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) {
    super(...(args.length ? args : [FROZEN_MS]));
  }
  static now() {
    return FROZEN_MS;
  }
};

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import React from 'react';
import { PNG } from 'pngjs';
import xserver from 'x11/lib/xserver/index.js';
import { createClient, StaticFontSource } from 'ntk';

process.env.REACT_X11_NO_AUTORUN = '1';
const ReactX11 = (await import('../src/index.js')).default;
const { editMenuGeometry } = await import('../src/editmenu.js');
const Dashboard = (await import('../examples/dashboard.jsx')).default;
const Tasks = (await import('../examples/tasks.jsx')).default;
const Form = (await import('../examples/form.jsx')).default;

const require = createRequire(import.meta.url);
const katexFontDir = join(
  dirname(require.resolve('katex/package.json')),
  'dist',
  'fonts',
);
const outDir = join(
  dirname(new URL(import.meta.url).pathname),
  '..',
  'docs',
  'img',
);

// --- fonts -----------------------------------------------------------------

const SANS_CANDIDATES = [
  {
    regular: '/System/Library/Fonts/Supplemental/Arial.ttf',
    bold: '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
    italic: '/System/Library/Fonts/Supplemental/Arial Italic.ttf',
  },
  {
    regular: '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
    bold: '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
    italic: '/usr/share/fonts/truetype/liberation/LiberationSans-Italic.ttf',
  },
  {
    regular: '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    bold: '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  },
];

const MONO_CANDIDATES = [
  {
    regular: '/System/Library/Fonts/Supplemental/Courier New.ttf',
    bold: '/System/Library/Fonts/Supplemental/Courier New Bold.ttf',
  },
  {
    regular: '/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf',
  },
  { regular: '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf' },
];

function addFamily(source, family, candidates, katexFallback) {
  const found = candidates.find((c) => existsSync(c.regular));
  if (!found) {
    source.add(readFileSync(join(katexFontDir, katexFallback)), { family });
    return katexFallback;
  }
  source.add(readFileSync(found.regular), { family });
  if (found.bold && existsSync(found.bold)) {
    source.add(readFileSync(found.bold), { family, weight: 700 });
  }
  if (found.italic && existsSync(found.italic)) {
    source.add(readFileSync(found.italic), { family, style: 'italic' });
  }
  return found.regular;
}

function makeFontSource() {
  const source = new StaticFontSource();
  const sans = addFamily(
    source,
    'UI Sans',
    SANS_CANDIDATES,
    'KaTeX_Main-Regular.ttf',
  );
  const mono = addFamily(
    source,
    'UI Mono',
    MONO_CANDIDATES,
    'KaTeX_Typewriter-Regular.ttf',
  );
  source.alias('sans-serif', 'UI Sans');
  source.alias('monospace', 'UI Mono');
  return { source, sans, mono };
}

// --- harness ---------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function makeApp() {
  const server = xserver.createServer({ width: 800, height: 600 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const app = await createClient({
    stream: clientEnd,
    fontSource: makeFontSource().source,
  });
  // Record created windows: scenes read the main window from here (the
  // render callback's public instance is null for function-component
  // roots) and capture / click into Select's popup windows.
  const created = [];
  const popups = [];
  const orig = app.createWindow.bind(app);
  app.createWindow = (attributes) => {
    const wnd = orig(attributes);
    created.push(wnd);
    if (attributes?.overrideRedirect) popups.push(wnd);
    return wnd;
  };
  app.created = created;
  app.popups = popups;
  return app;
}

const render = (element, app) =>
  new Promise((resolve) =>
    ReactX11.render(element, () => resolve(app.created[0]), app),
  );

/** Depth-first search over the retained node tree of a realized window. */
function findNode(node, pred) {
  if (pred(node)) return node;
  for (const child of node.children) {
    if (child.isWindow) continue;
    const found = findNode(child, pred);
    if (found) return found;
  }
  return null;
}

/** The drawn node whose <text> content is exactly `label`. */
function labeled(wnd, label) {
  const text = findNode(
    wnd._reactX11Node,
    (n) =>
      n.kind === 'text' &&
      n.children.some((c) => c.kind === 'textchunk' && c.text === label),
  );
  if (!text) throw new Error(`no <text> "${label}" in the tree`);
  return text;
}

function click(wnd, x, y) {
  wnd.emit('mousedown', { x, y, keycode: 1 });
  wnd.emit('mouseup', { x, y, keycode: 1 });
}

const clickNode = (wnd, node) =>
  click(wnd, node.abs.x + node.abs.width / 2, node.abs.y + node.abs.height / 2);

/** Type through the real key pipeline: EventManager reads the keysym from
 * the client keymap, so register one synthetic keycode per keystroke.
 * Controlled inputs re-render between keystrokes — yield so React flushes
 * each onChange before the next key computes from the current value. */
async function typeText(app, wnd, text) {
  for (const ch of text) {
    const codepoint = ch.codePointAt(0);
    app.X.keycode2keysyms[254] = [codepoint];
    wnd.emit('keydown', { keycode: 254, codepoint, buttons: 0 });
    wnd.emit('keyup', { keycode: 254, codepoint, buttons: 0 });
    await sleep(0);
  }
}

async function capture(wnd) {
  const { width, height } = wnd;
  const ctx = wnd.getContext('2d');
  const data = await new Promise((resolve, reject) =>
    ctx.getImageData(0, 0, width, height, (err, d) =>
      err ? reject(err) : resolve(d),
    ),
  );
  return { data: data.data, width, height };
}

/** Blit a capture into a PNG at (ox, oy), converting BGRA to RGBA. */
function blit(png, src, ox, oy) {
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const dx = ox + x;
      const dy = oy + y;
      if (dx < 0 || dy < 0 || dx >= png.width || dy >= png.height) continue;
      const s = (y * src.width + x) * 4;
      const d = (dy * png.width + dx) * 4;
      png.data[d + 0] = src.data[s + 2];
      png.data[d + 1] = src.data[s + 1];
      png.data[d + 2] = src.data[s + 0];
      png.data[d + 3] = 255;
    }
  }
}

function write(png, name) {
  const file = join(outDir, `${name}.png`);
  writeFileSync(file, PNG.sync.write(png));
  console.log(`wrote ${file} (${png.width}x${png.height})`);
}

async function shot(wnd, name) {
  await sleep(250); // let the frame clock paint
  const base = await capture(wnd);
  const png = new PNG({ width: base.width, height: base.height });
  blit(png, base, 0, 0);
  write(png, name);
}

/**
 * A popup over the window it belongs to. A popup is its own X window, so
 * `GetImage` on the owner never contains it — the two are read separately
 * and composited at the popup's position.
 */
async function shotOver(wnd, popup, x, y, name) {
  await sleep(250);
  const base = await capture(wnd);
  const over = await capture(popup);
  const png = new PNG({ width: base.width, height: base.height });
  blit(png, base, 0, 0);
  blit(png, over, x, y);
  write(png, name);
}

async function scene(fn) {
  const app = await makeApp();
  try {
    await fn(app);
    ReactX11.unmountComponentAtNode(app);
  } finally {
    await app.close();
  }
}

// --- scenes ----------------------------------------------------------------

await scene(async (app) => {
  const wnd = await render(React.createElement(Dashboard), app);
  await sleep(100);
  const plus = labeled(wnd, '+1');
  clickNode(wnd, plus);
  clickNode(wnd, plus);
  clickNode(wnd, labeled(wnd, 'Dark')); // the dark theme photographs better
  await sleep(500);
  await shot(wnd, 'dashboard');
});

await scene(async (app) => {
  const wnd = await render(React.createElement(Tasks), app);
  await sleep(100);
  const input = findNode(wnd._reactX11Node, (n) => n.kind === 'textinput');
  clickNode(wnd, input);
  await typeText(app, wnd, 'Buy milk');
  await shot(wnd, 'tasks');
});

await scene(async (app) => {
  const wnd = await render(React.createElement(Form), app);
  await sleep(100);
  const input = findNode(wnd._reactX11Node, (n) => n.kind === 'textinput');
  clickNode(wnd, input);
  await typeText(app, wnd, 'Andrey');

  // pick "Red" in the first Select: open it, click the option in the popup
  clickNode(wnd, labeled(wnd, 'Blue'));
  await sleep(150);
  const menu = app.popups.at(-1);
  clickNode(menu, labeled(menu, 'Red'));
  await sleep(150);

  clickNode(wnd, labeled(wnd, 'Sign'));
  await shot(wnd, 'form');

  // reopen the Select and capture the popup window itself, with the
  // pointer hovering the selected option
  clickNode(wnd, labeled(wnd, 'Red'));
  await sleep(150);
  const reopened = app.popups.at(-1);
  const red = labeled(reopened, 'Red');
  reopened.emit('mousemove', {
    x: red.abs.x + 5,
    y: red.abs.y + red.abs.height / 2,
  });
  await sleep(50);
  await shot(reopened, 'select-menu');
});

await scene(async (app) => {
  const wnd = await render(
    <window width={420} height={260} style={{ backgroundColor: '#f5f6fa' }}>
      <box style={{ flexGrow: 1, padding: 16, gap: 12 }}>
        <text style={{ fontSize: 18, color: '#2d3436' }}>textinput</text>
        <textinput
          defaultValue="Hello, X11 world"
          style={{
            padding: 8,
            borderRadius: 4,
            borderWidth: 1,
            borderColor: '#b2bec3',
            backgroundColor: 'white',
          }}
        />
        <textinput
          placeholder="placeholder text..."
          style={{
            padding: 8,
            borderRadius: 4,
            borderWidth: 1,
            borderColor: '#b2bec3',
            backgroundColor: 'white',
          }}
        />
        <box
          style={{
            padding: 12,
            borderWidth: 2,
            borderColor: '#2980b9',
            borderStyle: 'dashed',
            borderRadius: 4,
            alignItems: 'center',
          }}
        >
          <text style={{ color: '#2980b9' }}>
            dashed border (ntk 3.2 setLineDash)
          </text>
        </box>
      </box>
    </window>,
    app,
  );
  await sleep(100);
  // click right after "Hello," so the caret shows mid-text
  const input = findNode(wnd._reactX11Node, (n) => n.kind === 'textinput');
  const content = input.contentBox();
  click(wnd, content.x + input._prefixWidth(6), content.y + 5);
  await shot(wnd, 'textinput');
});

// The built-in edit menu, over the field it belongs to — the point being
// that the selection survives the right-click and the menu acts on it.
await scene(async (app) => {
  const wnd = await render(
    <window width={420} height={230} style={{ backgroundColor: '#f5f6fa' }}>
      <box style={{ flexGrow: 1, padding: 16, gap: 10 }}>
        <text style={{ fontSize: 13, color: '#57606f' }}>
          right-click a &lt;textinput&gt; — no wiring
        </text>
        <textinput
          defaultValue="select me and right-click"
          style={{
            padding: 8,
            fontSize: 15,
            borderRadius: 4,
            borderWidth: 1,
            borderColor: '#b2bec3',
            backgroundColor: 'white',
          }}
        />
      </box>
    </window>,
    app,
  );
  await sleep(100);
  const input = findNode(wnd._reactX11Node, (n) => n.kind === 'textinput');
  clickNode(wnd, input);

  app.X.keycode2keysyms[254] = [0x61];
  wnd.emit('keydown', { keycode: 254, codepoint: 0x61, buttons: 4 }); // ctrl+a
  await sleep(50);

  // right-click *inside* the selection: it has to survive
  const x = input.abs.x + 60;
  const y = input.abs.y + input.abs.height / 2;
  wnd.emit('mousedown', { x, y, keycode: 3, rootx: x, rooty: y });
  await sleep(150);

  // hover Copy, found by geometry rather than a guessed offset
  const menu = app.popups.at(-1);
  const geometry = editMenuGeometry(
    input._editMenuItems(),
    (text) => input._layoutOf(text)?.width,
  );
  const copy = geometry.rows.find((r) => r.id === 'copy');
  menu.emit('mousemove', { x: 20, y: copy.y + copy.height / 2 });
  await sleep(50);

  await shotOver(wnd, menu, x, y, 'textinput-menu');
});

process.exit(0);

// Headless smoke check for examples/stress: mount the app into node-x11's
// in-process X server, walk the tab strip, and fail on anything thrown or
// logged. No $DISPLAY.
//
//   npm run stress:check
//   npm run stress:check -- --png   also write a PNG per panel to /tmp
//
// The stress app is a manual rig, but it is also the widest single use of the
// element set in the repo — six panels covering text, tables, SVG, documents,
// popups and menus. Left unexercised it rots quietly, and the way it rots is a
// throw inside one panel that nobody notices until they open that tab: React
// swallows a render error and the renderer reports it through console.error,
// so a broken panel looks like an empty panel.
//
// The last two checks are the ones with teeth. The Damage panel exists to
// demonstrate that a commit touching one cell of several hundred repaints one
// cell; that is checkable here rather than by eye. And "every cell" is checked
// too, because if *that* also came back bounded the one-cell result would
// prove nothing.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import React from 'react';
import { PNG } from 'pngjs';
import xserver from 'x11/lib/xserver/index.js';
import { createClient, StaticFontSource } from 'ntk';

process.env.REACT_X11_NO_AUTORUN = '1';
const ReactX11 = (await import('../src/index.js')).default;
const App = (await import('../examples/stress/index.jsx')).default;
const { watchFrames } = await import('../examples/stress/perf.js');

const require = createRequire(import.meta.url);
const fontDir = join(
  dirname(require.resolve('katex/package.json')),
  'dist',
  'fonts',
);

const W = 1000;
const H = 700;
const WRITE_PNG = process.argv.includes('--png');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- failure collection ----------------------------------------------------

const failures = [];
process.on('uncaughtException', (err) => failures.push(err.message));
process.on('unhandledRejection', (err) => failures.push(String(err)));
const realError = console.error;
console.error = (...args) => failures.push(args.map(String).join(' '));

// --- harness ---------------------------------------------------------------

// `--wide` sets the UI face to a monospace one, which is far wider per
// character than the default. A desktop app cannot know its font's metrics in
// advance — the user's `sans-serif` is whatever fontconfig says — so a layout
// that only survives the metrics it was written against is a latent bug. Three
// buttons that sat comfortably in a 250px card here ran off the edge of it on
// a real system font, and this pass is what would have caught that.
const WIDE = process.argv.includes('--wide');

function fontSource() {
  const source = new StaticFontSource();
  // Bold, italic and monospace all resolve to distinct faces, because the
  // typography panel sets all three and a single-face source would hide a
  // regression in font selection.
  const add = (file, attrs) =>
    source.add(readFileSync(join(fontDir, file)), attrs);
  const ui = WIDE ? 'KaTeX_Typewriter-Regular.ttf' : 'KaTeX_Main-Regular.ttf';
  add(ui, { family: 'Check Sans' });
  add(WIDE ? ui : 'KaTeX_Main-Bold.ttf', { family: 'Check Sans', weight: 700 });
  add(WIDE ? ui : 'KaTeX_Main-Italic.ttf', {
    family: 'Check Sans',
    style: 'italic',
  });
  add('KaTeX_Typewriter-Regular.ttf', { family: 'Check Mono' });
  source.alias('sans-serif', 'Check Sans');
  source.alias('monospace', 'Check Mono');
  return source;
}

const server = xserver.createServer({ width: W, height: H });
const [serverEnd, clientEnd] = xserver.createStreamPair();
server.addClientStream(serverEnd);
const app = await createClient({ stream: clientEnd, fontSource: fontSource() });

const created = [];
const createWindow = app.createWindow.bind(app);
app.createWindow = (attributes) => {
  const wnd = createWindow(attributes);
  created.push(wnd);
  return wnd;
};

const wnd = await new Promise((resolve) =>
  ReactX11.render(<App width={W} height={H} />, () => resolve(created[0]), app),
);
await sleep(400);
const root = wnd._reactX11Node;

// --- tree helpers ----------------------------------------------------------

function findNode(node, pred) {
  if (pred(node)) return node;
  for (const child of node.children ?? []) {
    if (child.isWindow) continue;
    const found = findNode(child, pred);
    if (found) return found;
  }
  return null;
}

const textOf = (node) =>
  (node.children ?? [])
    .filter((c) => c.kind === 'textchunk')
    .map((c) => c.text)
    .join('');

/** The drawn `<text>` whose content is exactly `label`. */
const labeled = (label) =>
  findNode(root, (n) => n.kind === 'text' && textOf(n) === label);

/** Every short text label on screen — what a failed lookup should report,
 * because "the button is missing" is useless without knowing what is there
 * instead (usually: the wrong panel is mounted). */
function labelsOnScreen() {
  const out = [];
  const walk = (n) => {
    if (n.kind === 'text') {
      const t = textOf(n);
      if (t && t.length < 24) out.push(t);
    }
    for (const child of n.children ?? []) if (!child.isWindow) walk(child);
  };
  walk(root);
  return out;
}

function click(node) {
  const r = node.abs;
  const x = Math.round(r.x + r.width / 2);
  const y = Math.round(r.y + r.height / 2);
  wnd.emit('mousedown', { x, y, rootx: x, rooty: y, button: 1, buttons: 1 });
  wnd.emit('mouseup', { x, y, rootx: x, rooty: y, button: 1, buttons: 0 });
}

function countNodes(node) {
  let n = 1;
  for (const child of node.children ?? []) {
    if (!child.isWindow) n += countNodes(child);
  }
  return n;
}

async function readback() {
  const data = await new Promise((resolve, reject) =>
    app.display.client.GetImage(
      2,
      wnd.id,
      0,
      0,
      W,
      H,
      0xffffffff,
      (err, img) => (err ? reject(err) : resolve(img.data)),
    ),
  );
  // Ink = pixels that are not the window background, a crude "did anything
  // render at all" signal that catches a panel laid out to zero height.
  let ink = 0;
  for (let i = 0; i < W * H; i++) {
    const b = data[i * 4];
    const g = data[i * 4 + 1];
    const r = data[i * 4 + 2];
    if (r !== 245 || g !== 246 || b !== 250) ink += 1;
  }
  return { data, ink };
}

function writePng(name, data) {
  const png = new PNG({ width: W, height: H });
  for (let i = 0; i < W * H; i++) {
    png.data[i * 4] = data[i * 4 + 2]; // GetImage gives BGRA
    png.data[i * 4 + 1] = data[i * 4 + 1];
    png.data[i * 4 + 2] = data[i * 4];
    png.data[i * 4 + 3] = 255;
  }
  const out = join(tmpdir(), `stress-${name}.png`);
  writeFileSync(out, PNG.sync.write(png));
  return out;
}

/**
 * Every node that overflows an ancestor whose width was pinned explicitly.
 *
 * A child spilling out of an auto-sized box is normal — the box grows. A child
 * spilling out of a box the author gave a fixed `width` is the bug: Yoga
 * defaults `flexShrink` to 0, so a row of things sized by their own text does
 * not compress to fit, it runs off the edge and gets clipped. That is
 * invisible until the font changes, which is why it took a screenshot from a
 * real desktop to find.
 */
function overflows() {
  const out = [];
  const walk = (node, pinned) => {
    const style = node.style ?? {};
    const box = node.abs;
    if (pinned && box && box.width > 0) {
      const right = pinned.abs.x + pinned.abs.width;
      const over = box.x + box.width - right;
      // a pixel of slop: borders and rounding land on half pixels
      if (over > 1) {
        out.push({
          kind: node.kind,
          text: textOf(node) || (node.props?.label ?? ''),
          over: Math.round(over),
          box: `${Math.round(box.width)}x${Math.round(box.height)}`,
          within: Math.round(pinned.abs.width),
        });
      }
    }
    // a node with its own pinned width becomes the frame for its subtree
    const next = typeof style.width === 'number' ? node : pinned;
    for (const child of node.children ?? []) {
      if (!child.isWindow) walk(child, next);
    }
  };
  walk(root, null);
  return out;
}

const check = (ok, what) => {
  if (!ok) failures.push(what);
  return ok;
};

/**
 * Advance the renderer deterministically.
 *
 * ntk paces `requestAnimationFrame` behind a fence — a GetInputFocus whose
 * reply confirms the server consumed the last frame — and under synthetic
 * `wnd.emit()` input that pump can sit with a frame scheduled and never run
 * it, so a fixed sleep leaves the tree committed but unlaid-out (every node's
 * `abs` still 0,0,0,0, which makes a click land at the window origin and hit
 * whatever is in the corner). `flush()` is the same frame the scheduler would
 * have called, so driving it directly measures the same thing without racing
 * the clock — the approach test/dirty-rect.test.js already takes.
 *
 * The sleep before it is for React, not for the frame: a click's setState
 * commits on a task, so the tree has to exist before there is anything to lay
 * out. Async content (a mermaid model, an HTML image) invalidates again later,
 * hence more than one round.
 */
async function settle(rounds = 4) {
  for (let i = 0; i < rounds; i++) {
    await sleep(30);
    if (root.needsLayout || root.needsPaint) {
      root._scheduled = false; // the stalled frame is ours to run now
      root.flush();
    }
  }
}

/** Click, let React commit, then paint exactly one frame and report the
 * region it repainted. This is the damage measurement. */
async function frameAfter(node) {
  click(node);
  await sleep(30);
  root._scheduled = false;
  root.flush();
  return root._lastDamage;
}

// --- walk the panels -------------------------------------------------------

const TABS = ['Typography', 'Charts', 'Data', 'Controls', 'Damage', 'Mixed'];

realError(
  `\n  panel         nodes     ink${WRITE_PNG ? '   png' : ''}${WIDE ? '   [wide font]' : ''}`,
);
realError(`  ${'-'.repeat(WRITE_PNG ? 52 : 30)}`);

await settle();

const nodeCounts = {};
for (const tab of TABS) {
  if (tab !== TABS[0]) {
    const strip = labeled(tab);
    if (!check(strip, `the "${tab}" tab is not in the tree`)) continue;
    click(strip);
    await settle();
  }
  const nodes = countNodes(root);
  nodeCounts[tab] = nodes;
  const { data, ink } = await readback();
  const png = WRITE_PNG ? `  ${writePng(tab.toLowerCase(), data)}` : '';
  realError(
    `  ${tab.padEnd(12)} ${String(nodes).padStart(6)} ${((ink / (W * H)) * 100).toFixed(1).padStart(6)}%${png}`,
  );
  check(nodes > 40, `"${tab}" built only ${nodes} nodes`);
  check(
    ink > W * H * 0.02,
    `"${tab}" rendered almost nothing (${ink}px of ink)`,
  );
  const spills = overflows();
  check(
    spills.length === 0,
    `"${tab}" has ${spills.length} node(s) overflowing a fixed-width box: ` +
      spills
        .slice(0, 4)
        .map(
          (o) =>
            `${o.kind}${o.text ? ` "${o.text}"` : ''} ${o.box} is ${o.over}px ` +
            `past its ${o.within}px container`,
        )
        .join('; '),
  );
}

// The damage grid is 24x16 boxes by default, so it should dwarf every other
// panel; a collapsed grid would still pass the >40 check above.
check(
  nodeCounts.Damage > 300,
  `the damage grid built only ${nodeCounts.Damage} nodes`,
);

// --- the damage claims -----------------------------------------------------

click(labeled('Damage'));
await settle();

const step = labeled('step');
if (
  check(
    step,
    `the step button is not reachable; on screen: ${JSON.stringify(
      labelsOnScreen().slice(0, 20),
    )}`,
  )
) {
  // "one cell" is the default mode. The *first* click on the button is not the
  // measurement: pressing it also changes the button's own hover and active
  // styling, so that frame legitimately covers the button as well as the cell
  // — a tall union from the control row down into the grid. One warm-up click
  // leaves the button in its settled state, and the next frame carries the
  // cell change alone.
  await frameAfter(step);
  const one = await frameAfter(step);
  const oneArea = one ? one.width * one.height : W * H;
  realError(
    `\n  one cell    ${one ? `${one.width}x${one.height}` : 'FULL WINDOW'} — ${(oneArea / 1000).toFixed(1)}kpx`,
  );
  check(
    one && oneArea < (W * H) / 8,
    `a one-cell change should bound its damage, got ${
      one ? `${one.width}x${one.height}` : 'FULL WINDOW'
    } of a ${W}x${H} window`,
  );

  const all = labeled('every cell');
  if (
    check(
      all,
      `the "every cell" button is missing; on screen: ${JSON.stringify(
        labelsOnScreen().slice(0, 20),
      )}`,
    )
  ) {
    click(all);
    await settle();
    const every = await frameAfter(labeled('step'));
    const everyArea = every ? every.width * every.height : W * H;
    realError(
      `  every cell  ${every ? `${every.width}x${every.height}` : 'FULL WINDOW'} — ${(everyArea / 1000).toFixed(1)}kpx`,
    );
    // The counterpart assertion: if recolouring all 384 cells also came back
    // small, the one-cell number would prove nothing about narrowing.
    check(
      everyArea > oneArea * 20,
      `recolouring every cell should cost far more than one cell, got ` +
        `${(everyArea / 1000).toFixed(1)}kpx vs ${(oneArea / 1000).toFixed(1)}kpx`,
    );
  }
}

// --- the frame log itself --------------------------------------------------

// perf.js is what the app prints its frame log with, and it wraps `flush()` —
// so a mistake in it breaks the app's *rendering*, not just its output. Cheap
// to cover here: attach it, paint a couple of frames, check it counted them
// and put the method back.
{
  const before = root.flush;
  const watcher = watchFrames(root, { label: 'check ', quiet: Infinity });
  check(root.flush !== before, 'watchFrames did not wrap flush()');

  await frameAfter(labeled('one cell'));
  await frameAfter(labeled('step'));

  check(
    watcher.frames >= 2,
    `watchFrames counted ${watcher.frames} frames, expected at least 2`,
  );
  const report = watcher.report();
  check(
    /\d+ frames, \d+ bounded/.test(report),
    `watchFrames report looks wrong: ${JSON.stringify(report)}`,
  );
  realError(`\n  frame log   ${report}`);

  watcher.stop();
  check(root.flush === before, 'watchFrames.stop() did not restore flush()');
}

// --- report ---------------------------------------------------------------

console.error = realError;
if (failures.length) {
  realError(`\n  FAILED — ${failures.length} problem(s):`);
  for (const f of failures.slice(0, 20)) realError(`    - ${f}`);
  process.exit(1);
}
realError('\n  all panels rendered, damage bounded\n');
process.exit(0);

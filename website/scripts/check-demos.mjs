// Correctness gate for the playground demos: runs every demo from
// website/src/demos against node-x11's pure-JS X server in node, the same
// way the browser runner does — JSX through the same sucrase transform, the
// same `require` shim, the same DISPLAY protocol, the same DejaVu font
// source — injects input where it matters, and asserts nothing threw and
// pixels changed.
//
// This is what keeps the site honest: a demo that stops matching the API
// fails `npm test` here instead of sitting broken on the playground.
//
//   node scripts/build-demo-bundles.mjs && node scripts/check-demos.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const websiteDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const demosDir = path.join(websiteDir, 'src', 'demos');
const bundle = path.join(websiteDir, 'static', 'demo', 'react-x11-runtime.js');

if (!fs.existsSync(bundle)) {
  console.error('bundle missing — run: node scripts/build-demo-bundles.mjs');
  process.exit(1);
}

// Same reason as check-bundle.mjs: the bundle ships its own Buffer and only
// installs it when there is no global one, which is the browser's situation.
delete globalThis.Buffer;
const RX = await import(pathToFileURL(bundle));

const fontDir = path.join(path.dirname(bundle), 'fonts');
await RX.setupFonts({
  read: async (file) =>
    new Uint8Array(fs.readFileSync(path.join(fontDir, file))),
});

// Same wiring as static/demo/runner/index.html, including the part that
// matters most: **one** server and one connection for the whole run, with
// demos unmounted in between rather than the server being rebuilt.
// react-x11 caches its ntk App at module scope, so a fresh server per demo
// would leave every demo after the first holding a dead socket — which is
// exactly the trap the browser runner is built around.
process.env.DISPLAY = 'demo/local:0';

const server = RX.xserver.createServer({ width: 640, height: 480 });
const streams = [];
RX.x11.registerDisplayProtocol('demo', () => {
  const [clientSide, serverSide] = RX.createStreamPair();
  server.addClientStream(serverSide);
  streams.push(clientSide);
  return clientSide;
});

// Demo modules are browser ESM ({ export default {...} }, no imports);
// evaluate them in node with a one-line transform.
function loadDemo(file) {
  const src = fs.readFileSync(file, 'utf8');
  return new Function(`${src.replace(/^export default/m, 'return')}`)();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function checksum(server) {
  server.compose();
  const data = server.root.raster.data;
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum = (sum * 31 + data[i]) >>> 0;
  return sum;
}

/**
 * Centre of the largest solid patch of `color` on screen. Targets are found
 * by the colour they are painted in rather than by hard-coded coordinates,
 * so tweaking a demo's layout does not silently turn its exercise into a
 * click on empty background — the pixels the assertion looks at and the
 * pixels the click aims at come from the same place.
 */
function findButton(server, color) {
  server.compose();
  const { width, height } = server;
  const data = server.root.raster.data;
  const seen = new Uint8Array(width * height);
  let best = null;
  for (let start = 0; start < data.length; start++) {
    if (seen[start] || (data[start] & 0xffffff) !== color) continue;
    // flood fill this patch, tracking its extent
    let sumX = 0,
      sumY = 0,
      n = 0;
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop();
      const x = i % width;
      const y = (i / width) | 0;
      sumX += x;
      sumY += y;
      n++;
      const neighbours = [
        x > 0 ? i - 1 : -1,
        x < width - 1 ? i + 1 : -1,
        y > 0 ? i - width : -1,
        y < height - 1 ? i + width : -1,
      ];
      for (const j of neighbours) {
        if (j < 0 || seen[j] || (data[j] & 0xffffff) !== color) continue;
        seen[j] = 1;
        stack.push(j);
      }
    }
    if (!best || n > best.n)
      best = { n, x: Math.round(sumX / n), y: Math.round(sumY / n) };
  }
  if (!best)
    throw new Error(
      `nothing on screen is #${color.toString(16).padStart(6, '0')}`,
    );
  return best;
}

function click(server, color, button = 1) {
  const { x, y } = findButton(server, color);
  server.injectPointerMove(x, y);
  server.injectButton(button, true);
  server.injectButton(button, false);
}

function type(server, text) {
  for (const ch of text) {
    const keycode = server.keymap.keycodeForKeysym(ch.codePointAt(0));
    if (!keycode) continue;
    server.injectKey(keycode, true);
    server.injectKey(keycode, false);
  }
}

// Per-demo input exercise, mirroring what a visitor would actually do. The
// point is to walk the interactive paths — hover restyling, click handlers,
// popup windows, keyboard — not just the first paint.
const exercises = {
  counter: (server) => click(server, 0x2980b9), // the +1 button
  layout: (server) => click(server, 0x1c4e80), // toggle direction
  styling: (server) => click(server, 0x2980b9), // switch theme
  'size-queries': (server) => click(server, 0x2980b9), // resize the window
  widgets: (server) => click(server, 0x0a84ff), // the primary "Mute" button
  events: (server) => click(server, 0x2980b9), // the inner box
  dates: (server) => click(server, 0x2980b9), // the primary Clear button
  password(server) {
    click(server, 0xeef4fb); // the field, which is the one thing painted in it
    type(server, 'hunter2');
  },
  tasks(server) {
    click(server, 0x27ae60); // the done task's checkbox
    // and the editor: click into the input, then type
    const add = findButton(server, 0x2980b9); // the Add button, same row
    server.injectPointerMove(add.x - 200, add.y);
    server.injectButton(1, true);
    server.injectButton(1, false);
    type(server, 'hi');
  },
  canvas(server) {
    for (let i = 0; i < 8; i++)
      server.injectPointerMove(120 + i * 20, 100 + i * 8);
  },
  menu(server) {
    server.injectPointerMove(300, 220); // right-click for the context menu
    server.injectButton(3, true);
    server.injectButton(3, false);
  },
};

// The GLX emulator only has a WebGL backend, so <glarea> cannot draw
// headlessly. The 3D demo is still checked for everything up to that point:
// it must mount, lay out and open its window without throwing.
const noPaintExpected = new Set(['three']);

async function runDemo(demo) {
  const problems = [];
  const timers = { intervals: [], timeouts: [] };
  const roots = new Set();

  const demoConsole = {
    log: () => {},
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: (...args) =>
      problems.push(new Error(`console.error: ${args.join(' ')}`)),
  };
  const trackInterval = (fn, ms, ...a) => {
    const id = setInterval(fn, ms, ...a);
    timers.intervals.push(id);
    return id;
  };
  const trackTimeout = (fn, ms, ...a) => {
    const id = setTimeout(fn, ms, ...a);
    timers.timeouts.push(id);
    return id;
  };
  const modules = {
    react: RX.React,
    ntk: RX.ntk,
    x11: RX.x11,
    'react-x11': new Proxy(RX.reactX11, {
      get(target, prop) {
        if (prop === 'createRoot')
          return (...args) =>
            target.createRoot(...args).then((root) => (roots.add(root), root));
        return target[prop];
      },
    }),
  };
  const demoRequire = (name) => {
    if (Object.hasOwn(modules, name)) return modules[name];
    throw new Error(`module not available in the playground: ${name}`);
  };
  const onUncaught = (err) => problems.push(err);
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUncaught);

  const before = checksum(server);
  try {
    const code = RX.transformJsx(demo.code);
    const fn = new Function(
      'require',
      'React',
      'process',
      'console',
      'setInterval',
      'setTimeout',
      'clearInterval',
      'clearTimeout',
      `return (async () => {\n${code}\n})();`,
    );
    await fn(
      demoRequire,
      RX.React,
      process,
      demoConsole,
      trackInterval,
      trackTimeout,
      clearInterval,
      clearTimeout,
    );
    await sleep(500); // connect, map, first paint
    const afterMount = checksum(server);

    if (!noPaintExpected.has(demo.id) && afterMount === before)
      problems.push(new Error('nothing was painted on the server raster'));

    if (exercises[demo.id]) {
      exercises[demo.id](server);
      await sleep(400);
      if (!noPaintExpected.has(demo.id) && checksum(server) === afterMount)
        problems.push(new Error('injected input changed nothing on screen'));
    }
  } catch (err) {
    problems.push(err);
  } finally {
    timers.intervals.forEach(clearInterval);
    timers.timeouts.forEach(clearTimeout);
    for (const root of roots) {
      try {
        // async since #114: the tree comes down synchronously, the socket
        // closes after. Handle the promise — an unhandled rejection here
        // would be reported as a demo failure by the uncaught handler above
        await root.unmount();
      } catch {
        /* already gone */
      }
    }
    await sleep(120); // let the unmount's DestroyWindow land, and in-flight
    // callbacks drain, while they are still monitored
    process.removeListener('uncaughtException', onUncaught);
    process.removeListener('unhandledRejection', onUncaught);
  }
  return problems;
}

// tear the shared connection down when everything has run
function closeStreams() {
  streams.forEach((s) => {
    try {
      s.destroy();
    } catch {
      /* gone */
    }
  });
}

const files = fs
  .readdirSync(demosDir)
  .filter((f) => f.endsWith('.js') && f !== 'index.js')
  .sort();
if (files.length === 0) {
  console.error('no demos found in', demosDir);
  process.exit(1);
}

let failed = 0;
for (const file of files) {
  const demo = loadDemo(path.join(demosDir, file));
  const problems = await runDemo(demo);
  if (problems.length === 0) {
    console.log(`ok   ${demo.id}`);
  } else {
    failed++;
    console.error(`FAIL ${demo.id}`);
    for (const p of problems)
      console.error(`     ${p && p.stack ? p.stack.split('\n')[0] : p}`);
  }
}

console.log(
  failed === 0 ? `all ${files.length} demos green` : `${failed} demo(s) failed`,
);
closeStreams();
process.exit(failed === 0 ? 0 : 1);

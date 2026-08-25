import { test } from 'node:test';
import assert from 'node:assert';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { createRoot } from '../src/index.js';
import xserver from 'x11/lib/xserver/index.js';
import { createClient, StaticFontSource } from 'ntk';

// vim exercises the direct-CLI-spawn path (as opposed to the GUI editors'
// URI-scheme navigation via `open`/`xdg-open`) without any OS-level
// side effect: with stdio ignored there is no tty, so vim exits immediately.
process.env.REACT_X11_EDITOR = 'vim';

const require = createRequire(import.meta.url);
const fontDir = join(
  dirname(require.resolve('katex/package.json')),
  'dist',
  'fonts',
);

async function createHeadlessApp() {
  const server = xserver.createServer({ width: 640, height: 480 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const fontSource = new StaticFontSource();
  fontSource.add(readFileSync(join(fontDir, 'KaTeX_Main-Regular.ttf')), {
    family: 'Test Main',
  });
  fontSource.alias('sans-serif', 'Test Main');
  const app = await createClient({ stream: clientEnd, fontSource });
  return { server, app };
}

function Leaf() {
  return React.createElement('box', {
    id: 'leaf',
    style: { width: 50, height: 50, backgroundColor: 'red' },
  });
}

test('Alt+Click resolves the fiber to its JSX call site and logs it', async () => {
  const clickToComponent = await import('../src/ClickToComponent.js');
  clickToComponent.install();

  const { app } = await createHeadlessApp();
  const x11Root = await createRoot({ app });
  const instance = await new Promise((resolve) => {
    x11Root.render(
      React.createElement(
        'window',
        { width: 200, height: 200 },
        React.createElement(Leaf),
      ),
      (i) => resolve(i),
    );
  });

  const windowNode = instance._reactX11Node;
  // layout/paint run off the initial commit; give it a tick before hit-testing
  await new Promise((resolve) => setTimeout(resolve, 50));
  const target = windowNode.hitTest(10, 10);
  assert.strictEqual(target?.kind, 'box');
  assert.strictEqual(target._reactFiber?._debugOwner?.type?.name, 'Leaf');

  let resolved = null;
  const originalLog = console.log;
  console.log = (...args) => {
    const msg = args.join(' ');
    if (msg.startsWith('[click-to-component]') && msg.includes('→')) {
      resolved = msg;
    }
    originalLog(...args);
  };
  try {
    // buttons: 8 = X11 Mod1Mask (Alt)
    windowNode.events._onMouseDown({ x: 10, y: 10, keycode: 1, buttons: 8 });
  } finally {
    console.log = originalLog;
  }

  assert.ok(resolved, 'expected a resolved-location log line');
  assert.match(resolved, /Leaf/);
  assert.match(resolved, /click-to-component\.test\.js:\d+:\d+$/);
});

// An element rendered by an installed component has its JSX call site inside
// that package — the click means the `<Toolbar />` line in the application's
// own file. The fixture is written under a real `node_modules/` path (in a
// temp dir, so the repo's own tree stays clean) because that path segment is
// exactly what the resolver reads.
async function installedToolbar() {
  const root = mkdtempSync(join(tmpdir(), 'react-x11-c2c-'));
  const dir = join(root, 'node_modules', '@fake', 'ui');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'index.mjs');
  // `createElement` is passed in rather than imported: nothing resolves
  // `react` from a temp directory, and the point is only that the call site
  // is inside node_modules.
  writeFileSync(
    file,
    'export function makeToolbar(createElement) {\n' +
      '  return function Toolbar() {\n' +
      "    return createElement('box', {\n" +
      "      id: 'from-lib',\n" +
      "      style: { width: 50, height: 50, backgroundColor: 'blue' },\n" +
      '    });\n' +
      '  };\n' +
      '}\n',
  );
  const { makeToolbar } = await import(pathToFileURL(file).href);
  return { root, Toolbar: makeToolbar(React.createElement) };
}

test('a click inside an installed component resolves to its owner in your code', async () => {
  const clickToComponent = await import('../src/ClickToComponent.js');
  clickToComponent.install();

  const { root: fixtureRoot, Toolbar } = await installedToolbar();
  const { app } = await createHeadlessApp();
  const x11Root = await createRoot({ app });
  function App() {
    return React.createElement(Toolbar);
  }
  const instance = await new Promise((resolve) => {
    x11Root.render(
      React.createElement(
        'window',
        { width: 200, height: 200 },
        React.createElement(App),
      ),
      (i) => resolve(i),
    );
  });

  const windowNode = instance._reactX11Node;
  await new Promise((resolve) => setTimeout(resolve, 50));
  const target = windowNode.hitTest(10, 10);
  assert.strictEqual(target?.kind, 'box');
  assert.strictEqual(target?.props?.id, 'from-lib');

  // the element's own call site is the package's file — not what a click means
  const own = clickToComponent.resolveLocation(target._reactFiber._debugStack);
  assert.strictEqual(own.installed, true);
  assert.match(own.file, /node_modules/);

  const owned = clickToComponent.resolveOwnedLocation(target._reactFiber);
  assert.strictEqual(owned.depth, 1, 'resolved one owner up');
  assert.strictEqual(owned.location.installed, false);
  assert.match(owned.location.file, /click-to-component\.test\.js$/);

  let resolved = null;
  const originalLog = console.log;
  console.log = (...args) => {
    const msg = args.join(' ');
    if (msg.startsWith('[click-to-component]') && msg.includes('→')) {
      resolved = msg;
    }
    originalLog(...args);
  };
  try {
    windowNode.events._onMouseDown({ x: 10, y: 10, keycode: 1, buttons: 8 });
  } finally {
    console.log = originalLog;
  }

  assert.ok(resolved, 'expected a resolved-location log line');
  assert.match(resolved, /click-to-component\.test\.js:\d+:\d+/);
  assert.match(resolved, /1 owner up from the clicked <box>/);
  rmSync(fixtureRoot, { recursive: true, force: true });
});

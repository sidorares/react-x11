import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
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

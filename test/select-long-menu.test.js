// A `Select` whose menu is long enough to scroll must still be clickable.
//
// It was not, and the mechanism is worth writing down because every step of
// it is something a component is supposed to do:
//
//   1. a `<scrollview>` becomes focusable the moment its content overflows —
//      that is what makes a pane of unfocusable content keyboard-reachable
//   2. so a press inside a menu tall enough to scroll moves focus to the
//      menu's own scrollview
//   3. which blurs the trigger, back in the owner window
//   4. whose `onBlur` closes the menu — correct, and how a click elsewhere
//      dismisses it
//   5. so React unmounts the row under the pointer during the *mousedown*
//      commit, and the release has nothing left to pair with: `onClick` is
//      the nearest common ancestor of press and release, and the press node
//      is gone
//
// The result was a dropdown that opened, highlighted, scrolled and answered
// the keyboard — and silently ignored every click. Only past the scroll
// threshold, which is why it survived: the menus in the examples are short.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import React from 'react';

import xserver from 'x11/lib/xserver/index.js';
import { StaticFontSource, createClient } from 'ntk';

import { Select, createRoot } from '../src/index.js';

const require = createRequire(import.meta.url);
const fontDir = join(
  dirname(require.resolve('katex/package.json')),
  'dist',
  'fonts',
);

// 28px an item, 220px of menu: seven fit, eight scroll.
const FITS = 7;
const SCROLLS = 8;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function headlessApp() {
  const server = xserver.createServer({ width: 500, height: 500 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const fontSource = new StaticFontSource();
  fontSource.add(readFileSync(join(fontDir, 'KaTeX_Main-Regular.ttf')), {
    family: 'Test Main',
  });
  fontSource.alias('sans-serif', 'Test Main');
  return createClient({ stream: clientEnd, fontSource });
}

const find = (node, pred, out = []) => {
  if (pred(node)) out.push(node);
  for (const child of node.children)
    if (!child.isWindow) find(child, pred, out);
  return out;
};

const click = (wnd, node) => {
  const x = node.abs.x + node.abs.width / 2;
  const y = node.abs.y + node.abs.height / 2;
  wnd.emit('mousedown', { x, y, keycode: 1 });
  wnd.emit('mouseup', { x, y, keycode: 1 });
};

/**
 * Open a Select of `count` options, click the first one, and report what
 * `onChange` saw. That is the whole assertion: a successful pick closes the
 * menu itself, so the menu being gone afterwards says nothing — only whether
 * the press ever became a click does.
 */
async function pickFirstOption(count) {
  const app = await headlessApp();
  const root = await createRoot({ app });
  try {
    const popups = [];
    const create = app.createWindow.bind(app);
    app.createWindow = (attrs) => {
      const wnd = create(attrs);
      if (attrs?.overrideRedirect) popups.push(wnd);
      return wnd;
    };

    const options = Array.from({ length: count }, (_, i) => `opt${i}`);
    let picked = null;
    function App() {
      const [value, setValue] = React.useState(null);
      return React.createElement(
        'window',
        { width: 500, height: 500 },
        React.createElement(
          'box',
          { style: { padding: 20 } },
          React.createElement(Select, {
            style: { width: 200 },
            value,
            options,
            placeholder: 'pick…',
            onChange: (ev) => {
              picked = ev.value;
              setValue(ev.value);
            },
          }),
        ),
      );
    }

    const created = [];
    const create2 = app.createWindow;
    app.createWindow = (attrs) => {
      const wnd = create2(attrs);
      created.push(wnd);
      return wnd;
    };

    await new Promise((resolve) =>
      root.render(React.createElement(App), resolve),
    );
    await sleep(300);
    const wnd = created[0];

    const trigger = find(
      wnd._reactX11Node,
      (n) => n.props?.role === 'combobox',
    )[0];
    assert.ok(trigger, 'the trigger renders');
    click(wnd, trigger);
    await sleep(300);

    const menu = popups.at(-1);
    assert.ok(menu, 'the menu opens');
    const rows = find(menu._reactX11Node, (n) => n.props?.role === 'option');
    assert.equal(rows.length, count, 'every option is in the menu');

    click(menu, rows[0]);
    await sleep(300);
    return picked;
  } finally {
    await app.close();
  }
}

test('a menu that fits is clickable', async () => {
  assert.equal(await pickFirstOption(FITS), 'opt0');
});

// The regression. One option more than fits, and every click was swallowed.
test('a menu one option past the scroll threshold is clickable', async () => {
  assert.equal(await pickFirstOption(SCROLLS), 'opt0');
});

test('a much longer menu is clickable', async () => {
  assert.equal(await pickFirstOption(30), 'opt0');
});

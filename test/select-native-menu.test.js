// A `<Select>`'s list as the platform's own menu (`nativeMenu`, the
// backend's `popUpMenu` seam — on macOS an NSMenu dropped from the trigger,
// src/cocoa/app.js). Driven here over the mock app with the seam stubbed, so
// what is pinned is the widget's half: when it asks for the platform's
// menu, what it asks for, and what it does with the answer. The Cocoa half,
// the bridge call and a pane's way to it, is cocoa-pane-windows.test.js.
//
// The menu follows the trigger by default: the native bezel's select gets
// the native menu and a drawn one the drawn menu. `nativeMenu` says so on
// its own — `true` under a drawn trigger is a browser's `<select>` a page
// styled — and a backend without the seam draws whatever it says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import { Select, createRoot } from '../src/index.js';
import { XK_DOWN } from '../src/keysyms.js';
import { createMockApp, pressButton } from '../src/testing/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => {
  await tick();
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await tick();
};

/**
 * The mock app, with the platform's menu stubbed in (`menus`: each request,
 * its spec, and `answer(id)` to end it as a pick or a dismissal), and —
 * with `bezels` — AppKit's metrics, so a select left alone takes the native
 * bezel as it does on macOS.
 */
function appWith({ bezels = false, menus = true } = {}) {
  const app = createMockApp();
  if (bezels) {
    app.nativeBezels = {
      natural: () => ({ width: 60, height: 22 }),
      shadow: () => ({ top: 1, bottom: 2 }),
      get: () => ({ surface: {}, sx: 0, sy: 0, sw: 1, sh: 1 }),
    };
  }
  app.menus = [];
  if (menus) {
    app.nativePopUpMenus = true;
    app.popUpMenu = (wnd, spec, onAnswer) => {
      const request = {
        wnd,
        spec,
        cancelled: false,
        answer: (id) => onAnswer(id),
      };
      app.menus.push(request);
      return () => {
        request.cancelled = true;
      };
    };
  }
  return app;
}

function find(node, pred) {
  if (pred(node)) return node;
  for (const c of node.children ?? []) {
    const hit = find(c, pred);
    if (hit) return hit;
  }
  return null;
}

async function mount(props, appOptions) {
  const app = appWith(appOptions);
  const root = await createRoot({ app });
  const changes = [];
  const render = (more = {}) =>
    root.render(
      h(
        'window',
        { width: 400, height: 300 },
        h(
          'box',
          { style: { padding: 20, alignItems: 'flex-start' } },
          more.gone
            ? null
            : h(Select, {
                options: [
                  { value: 'a', label: 'alpha' },
                  { value: 'b', label: 'beta' },
                  { value: 'c', label: 'gamma' },
                ],
                value: 'b',
                onChange: (ev) => changes.push(ev.value),
                ...props,
              }),
        ),
      ),
    );
  render();
  await settle();
  const tree = app.windows[0]._reactX11Node;
  const trigger = find(tree, (n) => n.props?.role === 'combobox');
  assert.ok(trigger, 'the trigger mounted');
  const press = async () => {
    pressButton(
      app.windows[0],
      trigger.abs.x + trigger.abs.width / 2,
      trigger.abs.y + trigger.abs.height / 2,
    );
    await settle();
  };
  /** a drawn menu is a `<popup>` under the trigger */
  const drawnMenu = () => trigger.children.find((c) => c.isWindow) ?? null;
  return { app, root, tree, trigger, press, drawnMenu, changes, render };
}

test("a select under the native bezel drops the platform's menu, the chosen option over the trigger", async () => {
  const m = await mount({}, { bezels: true });
  assert.ok(
    m.trigger.children.some((c) => c.kind === 'canvas'),
    'the native bezel',
  );
  await m.press();
  assert.equal(m.app.menus.length, 1, "the platform's menu was asked for");
  assert.equal(m.drawnMenu(), null, 'and no drawn one');
  const { spec, wnd } = m.app.menus[0];
  assert.ok(wnd === m.app.windows[0], 'in the window the trigger is in');
  assert.deepEqual(spec.items, [
    { id: 1, title: 'alpha' },
    { id: 2, title: 'beta' },
    { id: 3, title: 'gamma' },
  ]);
  assert.equal(spec.selected, 2, 'the current option, placed over the trigger');
  assert.deepEqual(
    spec.frame,
    [
      m.trigger.abs.x,
      m.trigger.abs.y,
      m.trigger.abs.width,
      m.trigger.abs.height,
    ],
    "dropped from the trigger's box, in the window's device pixels",
  );
  assert.equal(
    spec.fontSize,
    undefined,
    "the bezel's menu is at the menu font's size",
  );
  assert.equal(spec.appearance, 'light');
  assert.equal(spec.rtl, false);
  assert.equal(
    m.trigger.props['aria-expanded'],
    true,
    'expanded while it is down',
  );

  m.app.menus[0].answer(3);
  await settle();
  assert.deepEqual(m.changes, ['c'], 'a pick is a change');
  assert.equal(m.trigger.props['aria-expanded'], false);

  await m.press();
  assert.equal(m.app.menus.length, 2, 'and it opens again');
  m.app.menus[1].answer(null);
  await settle();
  assert.deepEqual(m.changes, ['c'], 'a dismissal changes nothing');
  m.app.menus[1].answer(2);
  await settle();
  assert.deepEqual(m.changes, ['c'], 'and a menu answers once');
});

test("a drawn select keeps the drawn menu unless it asks for the platform's", async () => {
  let m = await mount({});
  await m.press();
  assert.equal(m.app.menus.length, 0, 'the drawn trigger, the drawn menu');
  assert.ok(m.drawnMenu(), 'a <popup>');

  m = await mount({ nativeMenu: true });
  await m.press();
  assert.equal(
    m.app.menus.length,
    1,
    "nativeMenu: the platform's menu under a drawn trigger",
  );
  assert.equal(m.drawnMenu(), null);
  assert.equal(
    typeof m.app.menus[0].spec.fontSize,
    'number',
    "at the caption's size, the palette's here",
  );

  m = await mount({ nativeMenu: false }, { bezels: true });
  await m.press();
  assert.equal(
    m.app.menus.length,
    0,
    'nativeMenu={false} under the bezel: drawn',
  );
  assert.ok(m.drawnMenu());
});

test("a styled select's menu is set at its caption's size, in the family it names", async () => {
  let m = await mount({
    nativeMenu: true,
    labelStyle: {
      fontSize: 19,
      fontFamily: '"Avenir Next", Helvetica, sans-serif',
    },
  });
  await m.press();
  assert.equal(m.app.menus[0].spec.fontSize, 19);
  assert.equal(
    m.app.menus[0].spec.fontFamily,
    'Avenir Next',
    'the first of the list, unquoted',
  );

  m = await mount({
    nativeMenu: true,
    labelStyle: { fontFamily: 'system-ui, sans-serif' },
  });
  await m.press();
  assert.equal(
    m.app.menus[0].spec.fontFamily,
    undefined,
    "a generic family is the menu font's own",
  );
});

test("the keyboard opens the platform's menu, and a select that goes takes it with it", async () => {
  const m = await mount({ nativeMenu: true });
  m.trigger.focus();
  await settle();
  // the keysym is decoded from the keycode, as ntk's events are
  m.app.X.keycode2keysyms[116] = [XK_DOWN];
  m.app.windows[0].emit('keydown', { keycode: 116, keysym: XK_DOWN });
  await settle();
  assert.equal(m.app.menus.length, 1, 'Down opens it');
  assert.equal(m.app.menus[0].cancelled, false);
  m.render({ gone: true });
  await settle();
  assert.equal(
    m.app.menus[0].cancelled,
    true,
    'the menu is cancelled on unmount',
  );
});

test('a backend with no platform menu draws it, whatever the select asks for', async () => {
  const m = await mount({ nativeMenu: true }, { bezels: true, menus: false });
  await m.press();
  assert.ok(m.drawnMenu(), 'the drawn menu');
});

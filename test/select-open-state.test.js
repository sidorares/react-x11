// Whether a `<Select>`'s menu is down, told to its owner (`onOpenChange`)
// and, with `open`, held by it — what a browser's `<select>` answers
// `showPicker()` and `:open` with, which `@react-x11/components`' `<Html>`
// mounts this widget for. Driven over the mock app, the drawn menu a
// `<popup>` under the trigger and the platform's stubbed, as in
// select-native-menu.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import { Select, createRoot } from '../src/index.js';
import { XK_DOWN, XK_ESCAPE } from '../src/keysyms.js';
import { createMockApp, pressButton } from '../src/testing/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => {
  await tick();
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await tick();
};

/** The mock app, with the platform's menu stubbed in where `menus`. */
function appWith({ menus = false } = {}) {
  const app = createMockApp();
  app.menus = [];
  if (menus) {
    app.nativePopUpMenus = true;
    app.popUpMenu = (wnd, spec, onAnswer) => {
      const request = { spec, cancelled: false, answer: (id) => onAnswer(id) };
      app.menus.push(request);
      return () => {
        request.cancelled = true;
        onAnswer(null);
      };
    };
  }
  app.X.keycode2keysyms[9] = [XK_ESCAPE];
  app.X.keycode2keysyms[116] = [XK_DOWN];
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
  const told = [];
  const changes = [];
  const render = (more = {}) =>
    root.render(
      h(
        'window',
        { width: 400, height: 300 },
        h(
          'box',
          { style: { padding: 20, alignItems: 'flex-start' } },
          h(Select, {
            options: [
              { value: 'a', label: 'alpha' },
              { value: 'b', label: 'beta' },
              { value: 'c', label: 'gamma' },
            ],
            value: 'b',
            onChange: (ev) => changes.push(ev.value),
            onOpenChange: (open) => told.push(open),
            ...props,
            ...more,
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
  const key = async (keycode, keysym) => {
    trigger.focus();
    app.windows[0].emit('keydown', { keycode, keysym });
    await settle();
  };
  const rerender = async (more) => {
    render(more);
    await settle();
  };
  /** a drawn menu is a `<popup>` under the trigger */
  const drawnMenu = () => trigger.children.find((c) => c.isWindow) ?? null;
  return { app, trigger, press, key, rerender, drawnMenu, told, changes };
}

test('a select tells its owner as its menu goes down and comes up', async () => {
  const m = await mount({});
  await m.press();
  assert.ok(m.drawnMenu(), 'the press drops the menu');
  assert.deepEqual(m.told, [true], 'and says so');
  await m.key(9, XK_ESCAPE);
  assert.equal(m.drawnMenu(), null, 'Escape takes it up');
  assert.deepEqual(m.told, [true, false]);
  await m.key(116, XK_DOWN);
  assert.ok(m.drawnMenu(), 'Down drops it');
  assert.deepEqual(m.told, [true, false, true], 'each change told once');
  assert.equal(
    m.trigger.props.onOpenChange,
    undefined,
    "the select's own prop, not the trigger box's",
  );
});

test("the platform's menu is told, and so is its going by itself", async () => {
  const m = await mount({ nativeMenu: true }, { menus: true });
  await m.press();
  assert.equal(m.app.menus.length, 1);
  assert.deepEqual(m.told, [true]);
  m.app.menus[0].answer(3);
  await settle();
  assert.deepEqual(m.changes, ['c'], 'a pick is a change');
  assert.deepEqual(m.told, [true, false], 'and the menu went with it');
});

test("with `open` the menu is the owner's, and the user asks", async () => {
  const m = await mount({ open: false });
  await m.press();
  assert.deepEqual(m.told, [true], 'a press asks for the menu');
  assert.equal(m.drawnMenu(), null, 'and drops none of itself');

  await m.rerender({ open: true });
  assert.ok(m.drawnMenu(), 'the owner drops it');
  assert.equal(m.trigger.props['aria-expanded'], true);
  assert.deepEqual(m.told, [true], 'and is not told what it did');

  await m.key(9, XK_ESCAPE);
  assert.deepEqual(m.told, [true, false], 'Escape asks for it to go');
  assert.ok(m.drawnMenu(), 'and the owner keeps it');

  await m.rerender({ open: false });
  assert.equal(m.drawnMenu(), null, 'until it takes it up');
  assert.equal(m.trigger.props['aria-expanded'], false);
  assert.deepEqual(m.told, [true, false]);
  assert.equal(m.trigger.props.open, undefined, 'nor is `open` the box’s');
});

test('an owner that keeps what it is told keeps what is on screen', async () => {
  // the shape an owner that mirrors the menu takes: `showPicker()` sets
  // `open`, and what the select says sets it back
  const app = appWith({ menus: true });
  const root = await createRoot({ app });
  let show;
  const said = [];
  function Owner() {
    const [open, setOpen] = React.useState(false);
    show = () => setOpen(true);
    return h(
      'window',
      { width: 400, height: 300 },
      h(Select, {
        options: ['a', 'b'],
        value: 'a',
        nativeMenu: true,
        open,
        onOpenChange: (next) => {
          said.push(next);
          setOpen(next);
        },
      }),
    );
  }
  root.render(h(Owner));
  await settle();
  show();
  await settle();
  assert.equal(app.menus.length, 1, 'the owner dropped the menu');
  assert.deepEqual(said, [], 'and was told nothing it did not know');
  app.menus[0].answer(null);
  await settle();
  assert.deepEqual(said, [false], 'the menu dismissed itself, and said so');
  await settle();
  assert.equal(app.menus.length, 1, 'and was not dropped again');
  show();
  await settle();
  assert.equal(app.menus.length, 2, 'the owner drops it again');
});

test('a select mounted open drops its menu', async () => {
  const m = await mount({ open: true });
  assert.ok(m.drawnMenu(), 'down from the first commit it can be');
  assert.deepEqual(m.told, [], 'which the owner knows');
});

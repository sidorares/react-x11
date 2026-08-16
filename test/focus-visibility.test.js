// Focus follows visibility (#202).
//
// A `<Suspense>` boundary showing its fallback, an `<Activity mode="hidden">`
// and a `display: 'none'` all take a subtree off the screen. Every other
// route already read that: `hitTest` returns null, `paintOrder` drops the
// node, Tab does not visit it. Focus was the one left open — the focused
// control kept the keyboard, so keys landed on something the user could not
// see and the application's state advanced from them.
//
// The trap these tests exist for is in the *shape* of the fix: React calls
// `hideInstance` on the topmost host instance of a hidden branch, so in any
// tree deeper than one node the focused control still has `hidden === false`
// itself. Every hide here is therefore at least one level above the field,
// which is what a fix asking "am I the focused node?" would pass while
// leaving the bug in place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import { createRoot } from '../src/index.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** React first: a hidden `<Activity>` mounts its children at a deferred lane,
 * and a boundary that re-suspends commits its fallback on one too, so the
 * commit under test is not the one `render()` returns from. The flag goes
 * back afterwards, since the input below is emitted outside `act`. */
async function flush(fn) {
  const previous = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    await React.act(async () => {
      await fn?.();
    });
  } finally {
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous;
  }
  await tick();
}

async function mount(element, options) {
  const app = createMockApp();
  const root = await createRoot({ app, ...options });
  await flush(() => root.render(element));
  const tree = app.windows[0]._reactX11Node;
  return { app, root, wnd: app.windows[0], tree, events: tree.events };
}

/** Every node under `node`, its `<popup>` windows included. */
function all(node, out = []) {
  out.push(node);
  for (const child of node.children) all(child, out);
  return out;
}

/** Everything here is named, and every assertion about focus is about a
 * name: `assert.equal` on two nodes inspects the whole retained tree when it
 * fails, which is twenty seconds and a diff nobody can read. */
const byName = (tree, name) =>
  all(tree).find((n) => n.props.name === name) ?? null;
const focusedName = (events) => events.focused?.props.name ?? null;

/** A click on a node, which is the focus that lights no ring. */
function press(wnd, node) {
  const at = {
    x: node.abs.x + node.abs.width / 2,
    y: node.abs.y + node.abs.height / 2,
  };
  wnd.emit('mousedown', { ...at, keycode: 1 });
  wnd.emit('mouseup', { ...at, keycode: 1 });
}

/** Simulate an ntk keydown: bind the keysym to a synthetic keycode and emit
 * the raw event shape the EventManager consumes. */
function type(app, wnd, text) {
  for (const ch of text) {
    const codepoint = ch.codePointAt(0);
    const keycode = (codepoint % 248) + 8;
    app.X.keycode2keysyms[keycode] = [codepoint];
    wnd.emit('keydown', { keycode, keysym: codepoint, codepoint, buttons: 0 });
  }
}

// Text measures 0x0 against the mock, which has no fonts, so a field a press
// can land on is sized by hand.
const FIELD = { width: 100, height: 20 };

/** A boundary whose primary tree suspends on demand, around a field that is
 * two levels below the `<box>` React will hide. */
function suspendable() {
  const state = { setSuspend: null, changes: [], blurs: 0, focuses: 0 };
  const Suspender = ({ suspend }) => {
    if (suspend) throw new Promise(() => {});
    return null;
  };
  const App = () => {
    const [suspend, setSuspend] = React.useState(false);
    state.setSuspend = setSuspend;
    return h(
      'window',
      { width: 200, height: 100 },
      h('textinput', { name: 'outside', style: FIELD }),
      h(
        React.Suspense,
        { fallback: h('box', { style: { width: 10, height: 10 } }) },
        h(
          'box',
          null,
          h(
            'box',
            null,
            h('textinput', {
              name: 'inside',
              autoFocus: true,
              defaultValue: 'hi',
              style: FIELD,
              onChange: (ev) => state.changes.push(ev.target.value),
              onBlur: () => state.blurs++,
              onFocus: () => state.focuses++,
            }),
          ),
        ),
        h(Suspender, { suspend }),
      ),
    );
  };
  return { state, element: h(App) };
}

test('a boundary that re-suspends takes the keyboard with it', async () => {
  const { state, element } = suspendable();
  const { app, root, wnd, tree, events } = await mount(element);
  assert.equal(focusedName(events), 'inside', 'autoFocus took the keyboard');
  const input = byName(tree, 'inside');

  await flush(() => state.setSuspend(true));

  // the premise: this is the deep case, where the field itself was never
  // hidden and only collapsed because a yoga ancestor did
  assert.equal(input.hidden, false, 'React hid the branch, not the field');
  assert.equal(input.parent.parent.hidden, true, 'the branch above it');
  assert.equal(input.destroyed, false, 'and it is still mounted');

  assert.equal(focusedName(events), null, 'nothing invisible holds it');
  assert.equal(state.blurs, 1, 'the field heard about it');
  assert.equal(events.focusWithinPath.length, 0, ':focus-within went too');

  type(app, wnd, 'XY');
  assert.deepEqual(state.changes, [], 'and the keys land nowhere');

  await root.unmount();
});

test('…and hands it back, ring and all, when the boundary resolves', async () => {
  const { state, element } = suspendable();
  const { app, root, wnd, tree, events } = await mount(element);
  const input = byName(tree, 'inside');
  assert.equal(
    input.states[':focus-visible'],
    true,
    'autoFocus is not a press, so the ring was on',
  );

  await flush(() => state.setSuspend(true));
  await flush(() => state.setSuspend(false));

  assert.equal(focusedName(events), 'inside', 'back where the user left it');
  assert.equal(state.focuses, 2, 'and the field was told, not just marked');
  assert.equal(
    input.states[':focus-visible'],
    true,
    'a restore puts back the state hiding took, ring included',
  );

  type(app, wnd, 'Z');
  assert.deepEqual(state.changes, ['hiZ'], 'typing carries on');

  await root.unmount();
});

test('…and a field the user clicked comes back without one', async () => {
  // The other half of "put the state back": a press lights no ring, so a
  // reveal that lit one would be announcing focus the user never lost.
  const { state, element } = suspendable();
  const { root, wnd, tree, events } = await mount(element);
  press(wnd, byName(tree, 'outside')); // off the autoFocus, ring and all
  const input = byName(tree, 'inside');
  press(wnd, input);
  assert.equal(focusedName(events), 'inside', 'the press focused it');
  assert.equal(input.states[':focus-visible'], false, '…without a ring');

  await flush(() => state.setSuspend(true));
  await flush(() => state.setSuspend(false));

  assert.equal(focusedName(events), 'inside');
  assert.equal(input.states[':focus-visible'], false, 'and still without one');

  await root.unmount();
});

test('a reveal never takes the keyboard from wherever it went', async () => {
  const { state, element } = suspendable();
  const { root, tree, events } = await mount(element);

  await flush(() => state.setSuspend(true));
  // the user moved on while the boundary was away — nothing about the
  // content coming back is a reason to interrupt what they are doing now
  byName(tree, 'outside').focus();
  await flush(() => state.setSuspend(false));

  assert.equal(
    focusedName(events),
    'outside',
    'the field they are in keeps it',
  );
  assert.equal(state.focuses, 1, 'the revealed field was not re-focused');

  await root.unmount();
});

test('a restore does not pull the X input focus', async () => {
  // A window that is not the one the server sends keys to still has a focused
  // node (docs/events.md, "Window focus"). Taking the keyboard back for it
  // would be taking it off another application because something in the
  // background finished loading — and SetInputFocus on a window a reveal has
  // not mapped yet is a BadMatch.
  const { state, element } = suspendable();
  const { root, wnd, events } = await mount(element);
  const asked = [];
  wnd.focus = () => asked.push('focus'); // ntk >= 3.7.0; the mock has none

  wnd.emit('blur', {});
  assert.equal(events.windowFocused, false, 'the window manager took it away');

  await flush(() => state.setSuspend(true));
  await flush(() => state.setSuspend(false));

  assert.equal(focusedName(events), 'inside', 'the node is focused again');
  assert.deepEqual(asked, [], 'without asking the server for the keyboard');

  await root.unmount();
});

test('createRoot({ restoreFocusOnReveal: false }) leaves focus where the hide dropped it', async () => {
  const { state, element } = suspendable();
  const { root, tree, events } = await mount(element, {
    restoreFocusOnReveal: false,
  });
  assert.equal(focusedName(events), 'inside');

  await flush(() => state.setSuspend(true));
  await flush(() => state.setSuspend(false));

  assert.equal(focusedName(events), null, 'the browser answer: it stays lost');
  assert.equal(
    byName(tree, 'inside').states[':focus'],
    false,
    'and nothing is drawn focused',
  );

  await root.unmount();
});

test('<Activity mode="hidden"> releases the keyboard and gives it back', async () => {
  let setMode;
  const App = () => {
    const [mode, set] = React.useState('visible');
    setMode = set;
    return h(
      'window',
      { width: 200, height: 100 },
      h(
        React.Activity,
        { mode },
        h(
          'box',
          null,
          h('textinput', { name: 'field', autoFocus: true, style: FIELD }),
        ),
      ),
    );
  };
  const { root, events } = await mount(h(App));
  assert.equal(focusedName(events), 'field');

  await flush(() => setMode('hidden'));
  assert.equal(focusedName(events), null, 'a hidden tab holds no keyboard');

  await flush(() => setMode('visible'));
  assert.equal(
    focusedName(events),
    'field',
    'the state it kept includes focus',
  );

  await root.unmount();
});

test("a style that turns display: 'none' releases the keyboard too", async () => {
  // The same defect through an application's own hands rather than React's:
  // `hideInstance` is not involved, the node is invisible because a style
  // took its subtree out of the layout.
  let setShown;
  const App = () => {
    const [shown, set] = React.useState(true);
    setShown = set;
    return h(
      'window',
      { width: 200, height: 100 },
      h(
        'box',
        { style: { display: shown ? 'flex' : 'none' } },
        h(
          'box',
          null,
          h('textinput', { name: 'field', autoFocus: true, style: FIELD }),
        ),
      ),
    );
  };
  const { root, tree, events } = await mount(h(App));
  assert.equal(focusedName(events), 'field');

  await flush(() => setShown(false));
  assert.equal(
    byName(tree, 'field').hidden,
    false,
    'nothing set the flag React sets',
  );
  assert.equal(focusedName(events), null, 'and it lost the keyboard anyway');

  await flush(() => setShown(true));
  assert.equal(focusedName(events), 'field', 'back when the panel comes back');

  await root.unmount();
});

test("Tab does not visit a display: 'none' node", async () => {
  const { root, events } = await mount(
    h(
      'window',
      { width: 200, height: 100 },
      h('box', { name: 'gone', focusable: true, style: { display: 'none' } }),
      h('box', { name: 'here', focusable: true, style: FIELD }),
    ),
  );

  assert.deepEqual(
    events._tabbables().map((n) => n.props.name),
    ['here'],
    'invisible either way is invisible',
  );
  events._cycleFocus(false);
  assert.equal(focusedName(events), 'here');

  await root.unmount();
});

test('a hidden <popup> gives the owner window its keyboard back', async () => {
  // A popup shares the owner window's focus — an override-redirect window
  // never gets the X input focus itself — so a node inside one that is no
  // longer on screen would go on taking keys the owner window still receives.
  let setMode;
  const App = () => {
    const [mode, set] = React.useState('visible');
    setMode = set;
    return h(
      'window',
      { width: 200, height: 100 },
      h(
        React.Activity,
        { mode },
        h(
          'popup',
          { x: 10, y: 10, width: 120, height: 60 },
          h('textinput', { name: 'in-popup', autoFocus: true, style: FIELD }),
        ),
      ),
    );
  };
  const { app, root, events } = await mount(h(App));
  assert.equal(focusedName(events), 'in-popup', 'the owner window holds it');

  await flush(() => setMode('hidden'));
  assert.equal(app.windows[1].mapped, false, 'the premise: it was unmapped');
  assert.equal(focusedName(events), null, 'so the keyboard is not in it');

  await flush(() => setMode('visible'));
  assert.equal(focusedName(events), 'in-popup', 'and comes back with it');

  await root.unmount();
});

test('a popup that is still on screen keeps the keyboard', async () => {
  // The other half of the containment question, and the reason it is asked
  // as "is the focused node still visible" rather than "is it in there". A
  // `<popup>` is written as a child in the JSX but is its own X window:
  // hiding the `<box>` it hangs off unmaps nothing, so it is still in front
  // of the user and still where their keys should go.
  let setMode;
  const App = () => {
    const [mode, set] = React.useState('visible');
    setMode = set;
    return h(
      'window',
      { width: 200, height: 100 },
      h(
        React.Activity,
        { mode },
        h(
          'box',
          { name: 'branch' },
          h(
            'popup',
            { x: 10, y: 10, width: 120, height: 60 },
            h('textinput', { name: 'in-popup', autoFocus: true, style: FIELD }),
          ),
        ),
      ),
    );
  };
  const { app, root, tree, events } = await mount(h(App));

  await flush(() => setMode('hidden'));
  assert.equal(byName(tree, 'branch').hidden, true, 'the box around it went');
  assert.equal(app.windows[1].mapped, true, 'the premise: the popup did not');
  assert.equal(focusedName(events), 'in-popup', 'so it keeps the keyboard');

  await root.unmount();
});

test('a field unmounted while hidden is not focused when the tree comes back', async () => {
  let setState;
  const App = () => {
    const [{ mode, field }, set] = React.useState({
      mode: 'visible',
      field: true,
    });
    setState = set;
    return h(
      'window',
      { width: 200, height: 100 },
      h(
        React.Activity,
        { mode },
        h(
          'box',
          null,
          field
            ? h('textinput', { name: 'field', autoFocus: true, style: FIELD })
            : null,
        ),
      ),
    );
  };
  const { root, tree, events } = await mount(h(App));
  const input = byName(tree, 'field');

  await flush(() => setState({ mode: 'hidden', field: true }));
  await flush(() => setState({ mode: 'hidden', field: false }));
  assert.equal(input.destroyed, true, 'the premise: it went away while away');

  await flush(() => setState({ mode: 'visible', field: false }));
  assert.equal(focusedName(events), null, 'nothing is focused, nothing threw');

  await root.unmount();
});

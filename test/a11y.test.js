// The accessibility model, with no bus anywhere: roles, names, states and
// the tree projection are pure functions over the retained node tree
// (src/a11y.js), so they are tested the way the style resolver is — build a
// tree on the mock app, ask, compare. The AT-SPI bridge that serves this
// model over D-Bus is test/atspi.test.js; everything asserted here holds
// whether or not that bridge ever connects.
import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';

import {
  createRoot,
  Button,
  Checkbox,
  Slider,
  Tabs,
  announce,
} from '../src/index.js';
import {
  ATSPI_ROLE,
  ATSPI_STATE,
  a11yRole,
  roleNameOf,
  a11yChildren,
  a11yParent,
  a11yIndexIn,
  a11yName,
  a11yStates,
  a11yValue,
  a11yAttributes,
  a11yActivatable,
  hooks,
  isFocusable,
} from '../src/a11y.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => {
  await tick();
  await tick();
};

const mount = async (element, { width = 300, height = 200, title } = {}) => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(h('window', { width, height, title }, element));
  await settle();
  const wnd = app.windows[0];
  return { app, wnd, root: wnd._reactX11Node, x11Root };
};

const find = (node, pred) =>
  pred(node)
    ? node
    : node.children.reduce(
        (a, c) => a || (c.isWindow ? null : find(c, pred)),
        null,
      );

const byRole = (root, role) => find(root, (n) => n.props?.role === role);

const hasState = (states, bit) =>
  bit < 32
    ? Boolean(states[0] & (1 << bit))
    : Boolean(states[1] & (1 << (bit - 32)));

// ---------------------------------------------------------------------------

test('kind defaults: an unlabelled tree is boring, not wrong', async () => {
  const { root } = await mount(
    h(
      'box',
      null,
      h('text', null, 'plain words'),
      h('textinput', { defaultValue: 'x' }),
      h('box', { style: { overflow: 'scroll' } }, h('box')),
    ),
  );
  assert.equal(a11yRole(root), ATSPI_ROLE.FRAME);
  const box = find(root, (n) => n.kind === 'box');
  assert.equal(a11yRole(box), ATSPI_ROLE.FILLER);
  assert.equal(
    a11yRole(find(root, (n) => n.kind === 'text')),
    ATSPI_ROLE.LABEL,
  );
  assert.equal(
    a11yRole(find(root, (n) => n.kind === 'textinput')),
    ATSPI_ROLE.ENTRY,
  );
  assert.equal(
    a11yRole(find(root, (n) => n.isScroller?.())),
    ATSPI_ROLE.SCROLL_PANE,
  );
});

test('the role prop maps to AT-SPI, and an unknown one falls back', async () => {
  const { root } = await mount(
    h(
      'box',
      null,
      h('box', { role: 'button' }),
      h('box', { role: 'switch' }),
      h('box', { role: 'no-such-role' }),
    ),
  );
  assert.equal(a11yRole(byRole(root, 'button')), ATSPI_ROLE.BUTTON);
  assert.equal(a11yRole(byRole(root, 'switch')), ATSPI_ROLE.SWITCH);
  // unknown: reads as the element default rather than vanishing
  assert.equal(a11yRole(byRole(root, 'no-such-role')), ATSPI_ROLE.FILLER);
  assert.equal(roleNameOf(byRole(root, 'button')), 'button');
});

test('the projection: hidden subtrees gone, presentation erased, text opaque', async () => {
  const { root } = await mount(
    h(
      'box',
      null,
      h('box', { 'aria-hidden': true }, h('box', { role: 'button' })),
      h(
        'box',
        { role: 'none' },
        h('box', { role: 'checkbox' }),
        h('box', { role: 'radio' }),
      ),
      h('text', null, 'one ', h('text', null, 'run')),
    ),
  );
  const outer = root.children[0];
  const projected = a11yChildren(outer);
  // aria-hidden subtree contributes nothing; the presentation box is
  // replaced by its two children; the text is one leaf despite its spans
  assert.deepEqual(
    projected.map((n) => roleNameOf(n) ?? n.kind),
    ['checkbox', 'radio', 'text'],
  );
  const checkbox = projected[0];
  // the erased wrapper is skipped walking up too
  assert.equal(a11yParent(checkbox), outer);
  assert.equal(a11yIndexIn(outer, checkbox), 0);
  const text = projected[2];
  assert.equal(a11yChildren(text).length, 0);
});

test('names: aria-label, then what the element carries, then contents', async () => {
  const { root } = await mount(
    h(
      'box',
      null,
      h('box', { role: 'button', 'aria-label': 'Close' }, h('text', null, 'X')),
      h(
        'box',
        { role: 'button' },
        h('text', null, 'Save ', h('text', null, 'now')),
      ),
      h('textinput', { placeholder: 'Search…' }),
      h('image', { src: '/dev/null/nothing.png', alt: 'A chart' }),
    ),
    { title: 'Named' },
  );
  assert.equal(a11yName(root), 'Named');
  const [labelled, contents] = [
    byRole(root, 'button'),
    find(root, (n) => n.props?.role === 'button' && !n.props['aria-label']),
  ];
  assert.equal(a11yName(labelled), 'Close');
  assert.equal(a11yName(contents), 'Save now');
  assert.equal(a11yName(find(root, (n) => n.kind === 'textinput')), 'Search…');
  assert.equal(a11yName(find(root, (n) => n.kind === 'image')), 'A chart');
});

test('states derive from the same facts the widgets draw from', async () => {
  const { root } = await mount(
    h(
      'box',
      null,
      h('box', { role: 'checkbox', 'aria-checked': true, focusable: true }),
      h('box', { role: 'checkbox', 'aria-checked': 'mixed' }),
      h('box', { role: 'button', disabled: true }),
      h('textarea', { defaultValue: 'a\nb' }),
      h('box', { role: 'tab', 'aria-selected': true }),
      h('box', {
        role: 'menuitem',
        'aria-haspopup': 'menu',
        'aria-expanded': false,
      }),
    ),
  );
  const S = ATSPI_STATE;

  const checked = byRole(root, 'checkbox');
  let s = a11yStates(checked);
  for (const bit of [
    S.CHECKABLE,
    S.CHECKED,
    S.ENABLED,
    S.SENSITIVE,
    S.FOCUSABLE,
    S.VISIBLE,
    S.SHOWING,
  ]) {
    assert.ok(hasState(s, bit), `expected state ${bit}`);
  }

  const mixed = find(root, (n) => n.props?.['aria-checked'] === 'mixed');
  s = a11yStates(mixed);
  assert.ok(hasState(s, S.INDETERMINATE));
  assert.ok(!hasState(s, S.CHECKED));

  const disabled = byRole(root, 'button');
  s = a11yStates(disabled);
  assert.ok(!hasState(s, S.ENABLED));
  assert.ok(!hasState(s, S.SENSITIVE));
  assert.ok(!hasState(s, S.FOCUSABLE));
  assert.ok(!isFocusable(disabled));

  const area = find(root, (n) => n.kind === 'textarea');
  s = a11yStates(area);
  assert.ok(hasState(s, S.MULTI_LINE));
  assert.ok(hasState(s, S.EDITABLE));
  assert.ok(hasState(s, S.FOCUSABLE), 'textarea is focusable by default');

  s = a11yStates(byRole(root, 'tab'));
  assert.ok(hasState(s, S.SELECTABLE));
  assert.ok(hasState(s, S.SELECTED));

  const item = byRole(root, 'menuitem');
  s = a11yStates(item);
  assert.ok(hasState(s, S.HAS_POPUP));
  assert.ok(hasState(s, S.EXPANDABLE));
  assert.ok(!hasState(s, S.EXPANDED));
  assert.ok(hasState(s, S.COLLAPSED));
});

test('focus is one fact: the manager, the ring and the state agree', async () => {
  const { root } = await mount(h('textinput', { defaultValue: '' }));
  const input = find(root, (n) => n.kind === 'textinput');
  assert.ok(!hasState(a11yStates(input), ATSPI_STATE.FOCUSED));
  input.focus();
  assert.ok(hasState(a11yStates(input), ATSPI_STATE.FOCUSED));
  assert.equal(root.events.focused, input);
});

test('aria-valuenow is the Value interface, and widgets carry it', async () => {
  const changes = [];
  const { root } = await mount(
    h(
      'box',
      null,
      h(Slider, {
        value: 30,
        min: 0,
        max: 50,
        onChange: (ev) => changes.push(ev.value),
      }),
      h(Checkbox, { checked: true, onChange: () => {} }, 'Ticked'),
      h(Button, { onPress: () => {} }, 'Go'),
    ),
  );
  const slider = byRole(root, 'slider');
  assert.deepEqual(a11yValue(slider), { now: 30, min: 0, max: 50, text: '' });
  assert.ok(a11yActivatable(byRole(root, 'button')));

  // the AT-side write route a widget wires through onAccessibilityAction
  slider.props.onAccessibilityAction({ action: 'setValue', value: 12 });
  assert.deepEqual(changes, [12]);

  const checkbox = byRole(root, 'checkbox');
  assert.ok(hasState(a11yStates(checkbox), ATSPI_STATE.CHECKED));
  assert.equal(a11yName(checkbox), 'Ticked');
});

test('widget wiring: Tabs speak the tab pattern', async () => {
  const { root } = await mount(
    h(Tabs, {
      items: [
        { id: 'a', label: 'First', content: h('text', null, 'A') },
        { id: 'b', label: 'Second', content: h('text', null, 'B') },
      ],
    }),
  );
  const tablist = byRole(root, 'tablist');
  assert.ok(tablist, 'the strip carries role=tablist');
  const tabs = a11yChildren(tablist).filter((n) => n.props?.role === 'tab');
  assert.equal(tabs.length, 2);
  assert.equal(a11yName(tabs[0]), 'First');
  assert.ok(hasState(a11yStates(tabs[0]), ATSPI_STATE.SELECTED));
  assert.ok(!hasState(a11yStates(tabs[1]), ATSPI_STATE.SELECTED));
  assert.ok(byRole(root, 'tabpanel'));
});

test('attributes carry the ordinal leftovers', async () => {
  const { root } = await mount(
    h('box', {
      role: 'treeitem',
      'aria-level': 2,
      'aria-posinset': 3,
      'aria-setsize': 7,
    }),
  );
  const item = byRole(root, 'treeitem');
  assert.deepEqual(a11yAttributes(item), [
    ['xml-roles', 'treeitem'],
    ['level', '2'],
    ['posinset', '3'],
    ['setsize', '7'],
  ]);
});

test('with no bridge, the hooks stay null and announce says so', async () => {
  await mount(h('box', { role: 'button' }, h('text', null, 'Quiet')));
  // NO_AT_BRIDGE is set by the test harness, so the climb never started
  for (const [name, slot] of Object.entries(hooks)) {
    assert.equal(slot, null, `hook ${name} must stay unset`);
  }
  assert.equal(announce('nobody is listening'), false);
});

// The seam where the global menu meets the accessibility tree, and it is one
// that has already broken once: the a11y pass was written against the old
// item vocabulary (`item.checked`, a `shortcut` that was a display string),
// and the dbusmenu vocabulary landed in the same release. Both merged
// cleanly and both are wrong afterwards — a screen reader silently loses the
// checkbox role, the checked state and every shortcut. Nothing else here
// renders a real `MenuBar`, so nothing else would notice.
test('a menu row announces its toggle, its shortcut and its submenu', async () => {
  const { MenuBar } = await import('../src/index.js');
  const { root } = await mount(
    h(MenuBar, {
      globalMenu: false, // the drawn bar is what has an a11y tree
      menus: [
        {
          label: 'View',
          items: [
            { label: 'Wrap', toggleType: 'checkmark', toggleState: 1 },
            { label: 'Layout', toggleType: 'radio', toggleState: 0 },
            { label: 'Bold', toggleType: 'checkmark', toggleState: -1 },
            { label: 'Save', shortcut: [['Control', 'S']] },
            { label: 'Alt', shortcut: [['Super', 'plus'], ['F2']] },
            { label: 'Plain' },
          ],
        },
      ],
    }),
  );

  // open the bar menu, so the rows exist
  const bar = byRole(root, 'menubar');
  assert.ok(bar, 'the bar has a role');
  const trigger = find(bar, (n) => n.props?.role === 'menuitem');
  trigger.props.onMouseDown?.({});
  await settle();

  const rows = [];
  for (const app of [root.app]) {
    for (const wnd of app.windows) {
      const node = wnd._reactX11Node;
      if (node && node !== root) {
        find(node, (n) => {
          if (String(n.props?.role ?? '').startsWith('menuitem')) rows.push(n);
          return false;
        });
      }
    }
  }
  const byLabel = (label) => rows.find((n) => n.props['aria-label'] === label);

  assert.equal(byLabel('Wrap').props.role, 'menuitemcheckbox');
  assert.equal(byLabel('Wrap').props['aria-checked'], true);
  assert.equal(byLabel('Layout').props.role, 'menuitemradio');
  assert.equal(byLabel('Layout').props['aria-checked'], false);
  // dbusmenu's indeterminate is ARIA's `mixed`, and it is the whole reason
  // the third toggle state is carried rather than flattened to off.
  assert.equal(byLabel('Bold').props['aria-checked'], 'mixed');

  assert.equal(byLabel('Save').props['aria-keyshortcuts'], 'Control+S');
  // Super is Meta in UI Events, and every alternative is announced — a reader
  // is reading them out, not fitting them in a column.
  assert.equal(byLabel('Alt').props['aria-keyshortcuts'], 'Meta++ F2');

  // A plain row is not a checkbox and claims no popup: `hasSubmenu` is an
  // imported function, so a truthiness test on it would make every row say
  // it has one.
  assert.equal(byLabel('Plain').props.role, 'menuitem');
  assert.equal(byLabel('Plain').props['aria-checked'], undefined);
  assert.equal(byLabel('Plain').props['aria-haspopup'], undefined);
  assert.equal(byLabel('Plain').props['aria-keyshortcuts'], undefined);
});

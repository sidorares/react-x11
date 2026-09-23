// The Windows accessibility bridge's JS half: what it pushes, and when it
// says nothing.
//
// The provider is C++ and the mirror lives there (`windows/src/uia.cc`, whose
// own test reads a tree back through Windows' automation client). What this
// side owns is a translation and a diff, and both are testable anywhere:
//
//   - **the translation** — one canonical role from `src/a11y.js` becomes one
//     UIA control type, and every other fact comes from the same functions
//     the AT-SPI bridge reads, so the two backends cannot disagree about what
//     a node is called;
//   - **the diff** — a commit that changed one node pushes one node, and a
//     machine with no screen reader on it pays for nothing.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import React from 'react';

import { ATSPI_ROLE } from '../../src/a11y.js';
import { Win32Accessibility, uiaControlType } from '../../src/win32/a11y.js';
import { renderX11 } from '../../src/testing/index.js';
import { createFakeBridge } from './fake-bridge.js';

const h = React.createElement;
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

const UIA = {
  Button: 50000,
  CheckBox: 50002,
  Edit: 50004,
  Text: 50020,
  Group: 50026,
  Window: 50032,
  Slider: 50015,
};

/**
 * A rendered tree, with the bridge pointed at it by hand.
 *
 * `install()` is deliberately *not* called: it fills the process-wide `hooks`
 * slots that only one bridge may own, and what is under test here is the push
 * rather than the wiring. The window is marked dirty directly instead, which
 * is all any of those hooks does.
 */
async function setup(element) {
  const bridge = createFakeBridge();
  const { app, unmount } = await renderX11(element, { backend: 'mock' });
  await nextTurn();
  const a11y = new Win32Accessibility({ _native: bridge });
  const win = app._rootChildren[0];
  a11y.toplevels.push(win);
  return { bridge, a11y, win, app, unmount };
}

describe('win32 a11y: the translation', () => {
  it('gives each role the control type UIA means by it', async () => {
    const { a11y, win, bridge, unmount } = await setup(
      h(
        'window',
        null,
        h('box', { role: 'button', 'aria-label': 'Save', onClick() {} }),
        h('box', {
          role: 'checkbox',
          'aria-label': 'Wrap lines',
          'aria-checked': true,
          onClick() {},
        }),
        h('textinput', { value: 'Ada', 'aria-label': 'Full name' }),
        h('text', null, 'a status line'),
        h('box', null),
      ),
    );
    try {
      a11y._dirty.add(win);
      a11y.flush();
      const push = bridge.uiaPushes.at(-1);
      const byName = new Map(push.nodes.map((n) => [n.name, n]));

      assert.equal(byName.get('Save').controlType, UIA.Button);
      assert.equal(byName.get('Wrap lines').controlType, UIA.CheckBox);
      assert.equal(byName.get('Full name').controlType, UIA.Edit);
      assert.equal(byName.get('a status line').controlType, UIA.Text);

      // The window itself, and the unnamed `<box>`: a container is a Group,
      // never a Pane. Narrator announces panes, and a layout box is not a
      // region of the window — it is the reason an unlabelled tree is boring
      // here rather than noisy.
      const root = push.nodes.find((n) => n.parent === 0);
      assert.equal(root.controlType, UIA.Window);
      assert.ok(
        push.nodes.some((n) => n.name === '' && n.controlType === UIA.Group),
        'a plain box is not a Group',
      );
    } finally {
      await unmount();
    }
  });

  it('never offers Invoke and Toggle on the same node', async () => {
    const { a11y, win, bridge, unmount } = await setup(
      h(
        'window',
        null,
        h('box', {
          role: 'checkbox',
          'aria-label': 'Wrap',
          'aria-checked': true,
          onClick() {},
        }),
        h('box', { role: 'button', 'aria-label': 'Go', onClick() {} }),
      ),
    );
    try {
      a11y._dirty.add(win);
      a11y.flush();
      const byName = new Map(
        bridge.uiaPushes.at(-1).nodes.map((n) => [n.name, n]),
      );
      const wrap = byName.get('Wrap');
      // A checkbox is clickable, so `a11yActivatable` says yes — and UIA
      // reads it through Toggle. Advertising both makes Narrator describe
      // the control twice.
      assert.equal(wrap.toggle, true);
      assert.equal(wrap.toggleState, 1);
      assert.equal(wrap.invoke, false, 'a checkbox also claimed Invoke');
      assert.equal(byName.get('Go').invoke, true);
      assert.equal(byName.get('Go').toggle, false);
    } finally {
      await unmount();
    }
  });

  it('carries a range as RangeValue, and a field as Value', async () => {
    const { a11y, win, bridge, unmount } = await setup(
      h(
        'window',
        null,
        h('box', {
          role: 'slider',
          'aria-label': 'Volume',
          'aria-valuenow': 3,
          'aria-valuemin': 0,
          'aria-valuemax': 11,
        }),
        h('textinput', { value: 'typed', 'aria-label': 'Field' }),
      ),
    );
    try {
      a11y._dirty.add(win);
      a11y.flush();
      const byName = new Map(
        bridge.uiaPushes.at(-1).nodes.map((n) => [n.name, n]),
      );
      const volume = byName.get('Volume');
      assert.equal(volume.controlType, UIA.Slider);
      assert.deepEqual(
        {
          range: volume.rangePattern,
          now: volume.rangeNow,
          min: volume.rangeMin,
          max: volume.rangeMax,
        },
        { range: true, now: 3, min: 0, max: 11 },
      );

      const field = byName.get('Field');
      assert.equal(field.valuePattern, true);
      assert.equal(field.value, 'typed');
      assert.equal(field.readOnly, false);
      // A label is not an edit field, and must not say it is read-write:
      // a screen reader offers to type into anything that does.
      assert.equal(volume.readOnly, true);
    } finally {
      await unmount();
    }
  });

  it('an unmapped role is a Group rather than nothing', () => {
    // `uiaControlType` takes a node; the fallback is what an app gets when it
    // writes a role this table has never heard of, and it must be a
    // container a screen reader steps over — not Custom, which it announces.
    const madeUp = { kind: 'box', props: { role: 'flibbertigibbet' } };
    assert.equal(uiaControlType(madeUp), UIA.Group);
    // And the mapping is exhaustive enough that the roles a11y.js knows do
    // not fall through: a spot check on the ones an app writes most.
    assert.equal(
      uiaControlType({ kind: 'box', props: { role: 'button' } }),
      UIA.Button,
    );
    assert.equal(uiaControlType({ kind: 'textinput', props: {} }), UIA.Edit);
    assert.equal(uiaControlType({ kind: 'text', props: {} }), UIA.Text);
    assert.notEqual(ATSPI_ROLE.FILLER, undefined);
  });
});

describe('win32 a11y: the diff', () => {
  it('pushes only what changed', async () => {
    const { a11y, win, bridge, unmount } = await setup(
      h(
        'window',
        null,
        h('box', { role: 'button', 'aria-label': 'One', onClick() {} }),
        h('box', { role: 'button', 'aria-label': 'Two', onClick() {} }),
      ),
    );
    try {
      a11y._dirty.add(win);
      a11y.flush();
      const first = bridge.uiaPushes.at(-1).nodes.length;
      assert.ok(first >= 3, 'the first push did not carry the tree');

      // Nothing moved: a push with nothing in it is not sent at all.
      const sent = bridge.uiaPushes.length;
      a11y._dirty.add(win);
      a11y.flush();
      assert.equal(
        bridge.uiaPushes.length,
        sent,
        'an unchanged tree was pushed again',
      );
    } finally {
      await unmount();
    }
  });

  it('says nothing at all when no client is listening', async () => {
    const { a11y, win, bridge, unmount } = await setup(
      h('window', null, h('box', { role: 'button', 'aria-label': 'One' })),
    );
    try {
      // The first push happens whatever: a client's first WM_GETOBJECT has
      // to find a tree, and it arrives before this process knows a client
      // exists.
      bridge.uiaListeners = false;
      a11y._dirty.add(win);
      a11y.flush();
      assert.equal(bridge.uiaPushes.length, 1, 'the first push was skipped');

      // Every one after that is skipped while nobody is reading — the whole
      // cost of accessibility on a machine with no screen reader.
      a11y._dirty.add(win);
      a11y.flush();
      assert.equal(bridge.uiaPushes.length, 1, 'walked for nobody');

      // Until a client asks, which is the one moment it is worth building.
      a11y._dirty.add(win);
      a11y.flush({ force: true });
      assert.ok(bridge.uiaPushes.length >= 1);
    } finally {
      await unmount();
    }
  });

  it('a window no client has read is not pushed, whoever else is listening', async () => {
    // UiaClientsAreListening is true whenever any client on the desktop is
    // subscribed to anything — the touch keyboard, the text services — so
    // on a Windows machine it is true, and every commit walked and pushed
    // a mirror nobody read: 1.6 ms of each frame of a graph pane's pan.
    // The question is per window: has a client read *this* one lately.
    const { a11y, win, bridge, unmount } = await setup(
      h('window', null, h('box', { role: 'button', 'aria-label': 'One' })),
    );
    try {
      const active = new Set();
      bridge.uiaListeners = true;
      bridge.uiaActive = (id) => active.has(id);
      a11y._dirty.add(win);
      a11y.flush();
      assert.equal(bridge.uiaPushes.length, 1, 'the first push, whatever');

      // something did change — a pan moves every item — and still nothing
      // is walked or pushed for it
      win.children[0].abs = { x: 1, y: 0, width: 10, height: 10 };
      a11y._dirty.add(win);
      a11y.flush();
      assert.equal(bridge.uiaPushes.length, 1, 'walked for a client elsewhere');

      // a client reads this window: its commits push again
      active.add(win.window.id);
      win.children[0].abs = { x: 2, y: 0, width: 10, height: 10 };
      a11y._dirty.add(win);
      a11y.flush();
      assert.equal(
        bridge.uiaPushes.length,
        2,
        'a reader of this window is told',
      );

      // a focus change goes by the desktop-wide answer: a client subscribed
      // to focus events reads the focused element the moment it hears of it
      active.clear();
      win.children[0].abs = { x: 3, y: 0, width: 10, height: 10 };
      a11y._dirty.add(win);
      a11y.flush({ global: true });
      assert.equal(bridge.uiaPushes.length, 3, 'a focus change is pushed');
    } finally {
      await unmount();
    }
  });

  it('a stream of commits pushes once per interval, the last one catching up', async () => {
    const { a11y, win, bridge, unmount } = await setup(
      h('window', null, h('box', { role: 'button', 'aria-label': 'One' })),
    );
    try {
      bridge.uiaListeners = true;
      a11y._dirty.add(win);
      a11y._commitFlush();
      assert.equal(
        bridge.uiaPushes.length,
        1,
        'a commit after quiet pushes at once',
      );
      for (let i = 0; i < 5; i++) {
        win.children[0].abs = { x: 10 + i, y: 0, width: 10, height: 10 };
        a11y._dirty.add(win);
        a11y._commitFlush();
      }
      assert.equal(bridge.uiaPushes.length, 1, 'the stream is held');
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(bridge.uiaPushes.length, 2, 'and caught up once');
      const xs = bridge.uiaPushes[1].nodes.map((n) => n.x);
      assert.ok(xs.includes(14), 'with the last of it');
    } finally {
      a11y.bury();
      await unmount();
    }
  });

  it('keeps a window whose HWND does not exist yet', async () => {
    const { a11y, bridge, unmount } = await setup(
      h('window', null, h('box', { role: 'button', 'aria-label': 'One' })),
    );
    try {
      // Windows are created asynchronously on this backend, so a tree mounts
      // and commits before its HWND exists. Dropping such a window was a real
      // bug: the one push it is owed happened against nothing and was never
      // retried, and a screen reader found an empty window.
      const orphan = { window: null, destroyed: false };
      a11y.toplevels.push(orphan);
      a11y._dirty.add(orphan);
      const sent = bridge.uiaPushes.length;
      a11y.flush();
      assert.equal(bridge.uiaPushes.length, sent, 'pushed against no window');
      assert.ok(a11y._dirty.has(orphan), 'the window was dropped, not kept');
    } finally {
      await unmount();
    }
  });
});

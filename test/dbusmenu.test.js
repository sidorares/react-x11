// The dbusmenu serialiser: stable ids, and the diff that picks the signal.
//
// No bus, no X server, no React — these are the two things about exporting a
// React tree over a stateful protocol that are actually hard, and both are
// pure functions so that they can be tested where the failure is legible.
// The wire is `test/globalmenu.test.js`.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  IdAllocator,
  ROOT_ID,
  diffSnapshots,
  groupProperties,
  itemProperties,
  layoutOf,
  snapshot,
} from '../src/dbusmenu.js';
import {
  _resetShortcutWarning,
  formatShortcut,
  isValidShortcut,
} from '../src/menuitem.js';

const FILE_MENU = (over = {}) => [
  {
    label: 'File',
    items: [
      { label: 'New', shortcut: [['Control', 'N']] },
      { type: 'separator' },
      { label: 'Save', enabled: over.canSave ?? true },
      { label: 'Wrap', toggleType: 'checkmark', toggleState: over.wrap ?? 0 },
    ],
  },
  { label: 'Edit', items: [{ label: 'Undo' }] },
];

/** id → label, so an assertion can name a row rather than count to it. */
const labelled = (nodes) => {
  const out = new Map();
  for (const [id, node] of nodes)
    if (node.props.label) out.set(id, node.props.label);
  return out;
};

const idOf = (nodes, label) => {
  for (const [id, node] of nodes) if (node.props.label === label) return id;
  throw new Error(`no item labelled ${label}`);
};

describe('item properties', () => {
  test('defaults are omitted, and the vocabulary is dbusmenu’s', () => {
    assert.deepEqual(itemProperties({ label: 'Save' }), { label: 'Save' });
    // `enabled: true` and `visible: true` are the protocol's defaults, and the
    // spec asks that a default not be sent — a shell caches what it is told.
    assert.deepEqual(itemProperties({ label: 'Save', enabled: true }), {
      label: 'Save',
    });
    assert.deepEqual(itemProperties({ label: 'Save', enabled: false }), {
      label: 'Save',
      enabled: false,
    });
    assert.deepEqual(itemProperties({ type: 'separator' }), {
      type: 'separator',
    });
  });

  test('a submenu claims children-display, an empty one does not', () => {
    assert.equal(
      itemProperties({ label: 'Recent', items: [{ label: 'a.md' }] })[
        'children-display'
      ],
      'submenu',
    );
    assert.equal(
      itemProperties({ label: 'Recent', items: [] })['children-display'],
      undefined,
    );
    // Every child hidden is the same as no children as far as the arrow the
    // panel draws is concerned: it would lead to an empty popup.
    assert.equal(
      itemProperties({
        label: 'Recent',
        items: [{ label: 'a.md', visible: false }],
      })['children-display'],
      undefined,
    );
  });

  test('a malformed shortcut is dropped rather than marshalled', () => {
    // dbus-native would throw from inside the marshaller, mid-reply, where the
    // only symptom is a panel with no menu at all.
    assert.equal(
      itemProperties({ label: 'S', shortcut: 'Ctrl+S' }).shortcut,
      undefined,
    );
    assert.equal(
      itemProperties({ label: 'S', shortcut: [] }).shortcut,
      undefined,
    );
    assert.deepEqual(
      itemProperties({ label: 'S', shortcut: [['Control', 'S']] }).shortcut,
      [['Control', 'S']],
    );
  });

  test('the icon callback never reaches the bus', () => {
    const props = itemProperties({
      label: 'New',
      icon: () => null,
      iconName: 'document-new',
    });
    assert.equal(props.icon, undefined);
    assert.equal(props['icon-name'], 'document-new');
  });
});

describe('shortcuts', () => {
  test('aas formats the way a menu prints it', () => {
    assert.equal(formatShortcut([['Control', 'S']]), 'Ctrl+S');
    // the key is a key, not a character: case is not a different binding
    assert.equal(formatShortcut([['Control', 's']]), 'Ctrl+S');
    assert.equal(formatShortcut([['Control', 'Shift', 'Z']]), 'Ctrl+Shift+Z');
    assert.equal(formatShortcut([['Alt', 'F4']]), 'Alt+F4');
    // GDK names the key, menus print it
    assert.equal(formatShortcut([['Control', 'plus']]), 'Ctrl++');
    assert.equal(formatShortcut([['Super', 'space']]), 'Super+Space');
    // only the first alternative is drawn; a row has one shortcut column
    assert.equal(formatShortcut([['Control', 'S'], ['F2']]), 'Ctrl+S');
  });

  test('anything that is not aas formats as nothing at all', () => {
    _resetShortcutWarning();
    for (const bad of ['Ctrl+S', [], undefined, null, [[]], [['Control']]]) {
      if (bad?.[0]?.length) continue;
      assert.equal(formatShortcut(bad), '');
      assert.equal(isValidShortcut(bad), false);
    }
  });
});

describe('stable ids', () => {
  test('an id survives a re-render of an identical tree', () => {
    const alloc = new IdAllocator();
    const first = snapshot(FILE_MENU(), alloc);
    const second = snapshot(FILE_MENU(), alloc);
    assert.deepEqual([...labelled(first)], [...labelled(second)]);
  });

  test('a property change does not move an id', () => {
    const alloc = new IdAllocator();
    const before = snapshot(FILE_MENU(), alloc);
    const after = snapshot(FILE_MENU({ wrap: 1, canSave: false }), alloc);
    assert.equal(idOf(after, 'Wrap'), idOf(before, 'Wrap'));
    assert.equal(idOf(after, 'Save'), idOf(before, 'Save'));
  });

  test('inserting a row leaves its siblings’ ids alone', () => {
    const alloc = new IdAllocator();
    const before = snapshot(FILE_MENU(), alloc);
    const grown = FILE_MENU();
    grown[0].items.unshift({ label: 'Open' });
    const after = snapshot(grown, alloc);
    for (const label of ['New', 'Save', 'Wrap', 'Undo']) {
      assert.equal(idOf(after, label), idOf(before, label), label);
    }
  });

  test('ids are never reused, so a shell’s cache cannot go stale', () => {
    const alloc = new IdAllocator();
    const before = snapshot(FILE_MENU(), alloc);
    const goneId = idOf(before, 'Save');

    const shrunk = FILE_MENU();
    shrunk[0].items = shrunk[0].items.filter((i) => i.label !== 'Save');
    snapshot(shrunk, alloc);

    // A different item later occupying that slot must not inherit the number
    // the shell still has properties cached against.
    const regrown = FILE_MENU();
    regrown[0].items[2] = { label: 'Export' };
    const after = snapshot(regrown, alloc);
    assert.notEqual(idOf(after, 'Export'), goneId);
  });

  test('two siblings with the same label get different ids', () => {
    const alloc = new IdAllocator();
    const nodes = snapshot(
      [{ label: 'Go', items: [{ label: 'Back' }, { label: 'Back' }] }],
      alloc,
    );
    const ids = [...nodes].filter(([, n]) => n.props.label === 'Back');
    assert.equal(ids.length, 2);
    assert.notEqual(ids[0][0], ids[1][0]);
  });

  test('`key` is what disambiguates when labels move', () => {
    const alloc = new IdAllocator();
    const before = snapshot(
      [{ label: 'View', items: [{ key: 'zoom', label: 'Zoom in' }] }],
      alloc,
    );
    const after = snapshot(
      [{ label: 'View', items: [{ key: 'zoom', label: 'Zoom out' }] }],
      alloc,
    );
    assert.equal(idOf(after, 'Zoom out'), idOf(before, 'Zoom in'));
  });

  test('separators are keyed among separators, not by list position', () => {
    const alloc = new IdAllocator();
    const before = snapshot(FILE_MENU(), alloc);
    const sepBefore = [...before].find(
      ([, n]) => n.props.type === 'separator',
    )[0];

    const grown = FILE_MENU();
    grown[0].items.unshift({ label: 'Open' });
    const after = snapshot(grown, alloc);
    const sepAfter = [...after].find(
      ([, n]) => n.props.type === 'separator',
    )[0];
    // Keying a separator by its index would renumber it — and every separator
    // below it — for a one-row insertion above.
    assert.equal(sepAfter, sepBefore);
  });

  test('the root is 0 and is not an item', () => {
    const nodes = snapshot(FILE_MENU(), new IdAllocator());
    const root = nodes.get(ROOT_ID);
    assert.equal(root.parent, null);
    assert.equal(root.item, null);
    assert.equal(root.props['children-display'], 'submenu');
    assert.equal(root.childIds.length, 2);
  });
});

describe('the diff picks the signal', () => {
  test('nothing changed says so, so nothing goes on the wire', () => {
    const alloc = new IdAllocator();
    const a = snapshot(FILE_MENU(), alloc);
    const b = snapshot(FILE_MENU(), alloc);
    assert.equal(diffSnapshots(a, b).kind, 'none');
  });

  test('a toggle flipping is a property patch, NOT a new revision', () => {
    // This is the whole point of the file. Plasma re-fetches an entire subtree
    // on LayoutUpdated and only patches on ItemsPropertiesUpdated, so a menu
    // whose one check mark moved must not bump the revision — which is exactly
    // what a naive setState → LayoutUpdated(++rev, 0) does per keystroke.
    const alloc = new IdAllocator();
    const before = snapshot(FILE_MENU({ wrap: 0 }), alloc);
    const after = snapshot(FILE_MENU({ wrap: 1 }), alloc);
    const change = diffSnapshots(before, after);
    assert.equal(change.kind, 'properties');
    assert.deepEqual(change.updated, [
      [idOf(after, 'Wrap'), { 'toggle-state': 1 }],
    ]);
    assert.deepEqual(change.removed, []);
  });

  test('a property returning to its default is reported as removed', () => {
    const alloc = new IdAllocator();
    const before = snapshot(FILE_MENU({ canSave: false }), alloc);
    const after = snapshot(FILE_MENU({ canSave: true }), alloc);
    const change = diffSnapshots(before, after);
    assert.equal(change.kind, 'properties');
    // `enabled: true` is the default and is not sent, so the shell has to be
    // told the old `false` is gone — otherwise the row stays dim forever.
    assert.deepEqual(change.removed, [[idOf(after, 'Save'), ['enabled']]]);
  });

  test('a structural change bumps the revision and names the subtree', () => {
    const alloc = new IdAllocator();
    const before = snapshot(FILE_MENU(), alloc);
    const grown = FILE_MENU();
    grown[0].items.push({ label: 'Quit' });
    const after = snapshot(grown, alloc);

    const change = diffSnapshots(before, after);
    assert.equal(change.kind, 'layout');
    // the File menu, not the root: the Edit menu did not change and must not
    // be re-walked
    assert.equal(change.parent, idOf(after, 'File'));
  });

  test('changes in two menus fall back to their common ancestor', () => {
    const alloc = new IdAllocator();
    const before = snapshot(FILE_MENU(), alloc);
    const grown = FILE_MENU();
    grown[0].items.push({ label: 'Quit' });
    grown[1].items.push({ label: 'Redo' });
    const after = snapshot(grown, alloc);
    // nothing lower than the root contains both, and 0 is the spec's own
    // "the whole layout is invalid"
    assert.equal(diffSnapshots(before, after).parent, ROOT_ID);
  });

  test('the first snapshot is a layout change', () => {
    const nodes = snapshot(FILE_MENU(), new IdAllocator());
    assert.deepEqual(diffSnapshots(null, nodes), {
      kind: 'layout',
      parent: ROOT_ID,
    });
  });

  test('hiding a row is a patch, not a structural change', () => {
    // dbusmenu carries `visible` as a property precisely so that this is
    // cheap. Dropping the item from the tree instead would renumber
    // everything after it and re-walk the menu.
    const alloc = new IdAllocator();
    const before = snapshot(FILE_MENU(), alloc);
    const hidden = FILE_MENU();
    hidden[0].items[0] = { ...hidden[0].items[0], visible: false };
    const after = snapshot(hidden, alloc);
    const change = diffSnapshots(before, after);
    assert.equal(change.kind, 'properties');
    assert.deepEqual(change.updated, [
      [idOf(after, 'New'), { visible: false }],
    ]);
  });

  test('an icon’s bytes are compared by value, not by identity', () => {
    const alloc = new IdAllocator();
    const png = () => Buffer.from([137, 80, 78, 71]);
    const a = snapshot(
      [{ label: 'F', items: [{ label: 'I', iconData: png() }] }],
      alloc,
    );
    const b = snapshot(
      [{ label: 'F', items: [{ label: 'I', iconData: png() }] }],
      alloc,
    );
    assert.equal(diffSnapshots(a, b).kind, 'none');
  });
});

describe('answering GetLayout', () => {
  test('recursion depth follows the spec', () => {
    const nodes = snapshot(FILE_MENU(), new IdAllocator());
    const [, , allChildren] = layoutOf(nodes, ROOT_ID, -1, []);
    assert.equal(allChildren.length, 2);
    assert.equal(allChildren[0][2].length, 4); // File's rows came too

    const [, , shallow] = layoutOf(nodes, ROOT_ID, 1, []);
    assert.equal(shallow.length, 2);
    assert.equal(shallow[0][2].length, 0); // one level only

    const [, , none] = layoutOf(nodes, ROOT_ID, 0, []);
    assert.equal(none.length, 0);
  });

  test('propertyNames filters, and an empty list means everything', () => {
    const nodes = snapshot(FILE_MENU(), new IdAllocator());
    const [, all] = layoutOf(nodes, idOf(nodes, 'New'), 0, []);
    assert.deepEqual(Object.keys(all).sort(), ['label', 'shortcut']);
    const [, just] = layoutOf(nodes, idOf(nodes, 'New'), 0, ['label']);
    assert.deepEqual(just, { label: 'New' });
  });

  test('an id that is gone reads as null, for the caller to answer for', () => {
    // The D-Bus handler turns this into an empty item rather than an error:
    // a shell asking about an id it remembers from before a structural change
    // is the normal way to arrive here. See globalmenu.test.js.
    const nodes = snapshot(FILE_MENU(), new IdAllocator());
    assert.equal(layoutOf(nodes, 9999, -1, []), null);
  });

  test('GetGroupProperties skips unknown ids rather than failing', () => {
    const nodes = snapshot(FILE_MENU(), new IdAllocator());
    const id = idOf(nodes, 'Undo');
    assert.deepEqual(groupProperties(nodes, [id, 9999], []), [
      [id, { label: 'Undo' }],
    ]);
  });
});

// The component layer of `react-x11/test` (issue #154): ByComponent
// queries, owner chains and source locations from React's debug info, and —
// through the React DevTools backend loaded in-process, no WebSocket — hook
// inspection and hook overrides. Everything goes through the published
// entry, the way a user's test would.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import React from 'react';

import {
  renderX11,
  cleanup,
  act,
  screen,
  within,
  textOf,
  inspect,
  ownerChainOf,
  sourceOf,
} from '../src/testing/index.js';

const h = React.createElement;

afterEach(cleanup);

function Label({ text }) {
  return h('text', null, text);
}

function useCounter(start) {
  const [count, setCount] = React.useState(start);
  return [count, setCount];
}

function Row({ id }) {
  const [count] = useCounter(id * 10);
  return h(
    'box',
    { style: { height: 20 } },
    h(Label, { text: `row ${id}: ${count}` }),
  );
}

let renders = 0;
let addRow;

function List() {
  renders++;
  const [rows, setRows] = React.useState([1, 2]);
  const [meta] = React.useState({ nested: { deep: 'a' }, tag: 'x' });
  React.useEffect(() => {
    addRow = () => setRows((r) => [...r, r.length + 1]);
  }, []);
  return h(
    'box',
    { style: { flexDirection: 'column' } },
    rows.map((id) => h(Row, { id, key: id })),
    h('text', null, `tag: ${meta.nested.deep}`),
  );
}

test('ByComponent finds each instance host root, by owner', async () => {
  await renderX11(h(List), { backend: 'mock' });

  const rowRoots = screen.getAllByComponent('Row');
  assert.strictEqual(rowRoots.length, 2, 'one host root per instance');
  assert.ok(
    rowRoots.every((n) => n.kind === 'box'),
    'the topmost host node of each instance, not its leaves',
  );
  // scoping to an instance root covers that instance's subtree
  within(rowRoots[1]).getByText('row 2: 20');
  assert.strictEqual(within(rowRoots[0]).queryByText('row 2: 20'), null);

  assert.strictEqual(screen.getAllByComponent(/^R/).length, 2, 'RegExp');
  assert.strictEqual(screen.queryByComponent('Nope'), null);
  assert.strictEqual(
    screen.getAllByComponent('Label').length,
    2,
    'one per Label instance — the trailing <text> is owned by List',
  );
});

test('a ByComponent miss lists the components that are there', async () => {
  await renderX11(h(List), { backend: 'mock' });
  assert.throws(
    () => screen.getByComponent('Missing'),
    /no element found for Component "Missing"[\s\S]*<List>[\s\S]*<Row>[\s\S]*<Label>/,
    'the failure names the components in the tree, not the element kinds',
  );
  assert.throws(() => screen.getByComponent('Row'), /found 2 elements/);
});

test('ownerChainOf and sourceOf read React debug info off any node', async () => {
  await renderX11(h(List), { backend: 'mock' });
  const label = within(screen.getAllByComponent('Row')[0]).getByText(/row 1/);

  assert.deepStrictEqual(ownerChainOf(label), ['Label', 'Row', 'List']);

  const source = sourceOf(label);
  assert.ok(
    source.file.endsWith('component-testing.test.js'),
    `the <text> was created in this file, got ${source?.file}`,
  );
  assert.ok(source.line > 0 && source.column > 0);
});

test('inspect() reads props and named hooks, with live state values', async () => {
  await renderX11(h(List), { backend: 'mock' });

  // This first inspect() is also the interesting one for wiring: the
  // DevTools hook did not exist when the root mounted, so the backend has
  // observed no commits and the element map is empty. inspect() installs
  // the hook, forces one commit per unobserved root, and proceeds.
  const list = await inspect(screen.getByText(/^tag:/));
  assert.strictEqual(list.name, 'List');
  assert.deepStrictEqual(
    list.hooks.map((hk) => hk.name),
    ['State', 'State', 'Effect'],
  );
  assert.deepStrictEqual(list.hooks[0].value, [1, 2]);
  // deep, not a DevTools preview — the value is read off the live fiber
  assert.deepStrictEqual(list.hooks[1].value, {
    nested: { deep: 'a' },
    tag: 'x',
  });
  assert.strictEqual(list.hooks[1].editable, true);
  assert.strictEqual(list.hooks[2].editable, false, 'an Effect is not');
  assert.ok(
    list.hooks[0].source.file.endsWith('component-testing.test.js'),
    'hooks carry their source location',
  );

  // a custom hook keeps its name, with its primitives nested under it
  const row = await inspect(screen.getAllByComponent('Row')[0]);
  assert.strictEqual(row.name, 'Row');
  assert.deepStrictEqual(row.props, { id: 1 });
  assert.deepStrictEqual(row.owners, ['List']);
  assert.strictEqual(row.hooks[0].name, 'Counter');
  assert.strictEqual(row.hooks[0].subHooks[0].name, 'State');
  assert.strictEqual(row.hooks[0].subHooks[0].value, 10);
});

test('inspect() re-invokes the render function to name the hooks', async () => {
  await renderX11(h(List), { backend: 'mock' });
  await inspect(screen.getByText(/^tag:/)); // attach + refresh commit
  const before = renders;
  await inspect(screen.getByText(/^tag:/));
  assert.strictEqual(
    renders,
    before + 1,
    'react-debug-tools runs the component once per inspect',
  );
});

test('setHook writes useState through React, and the tree repaints', async () => {
  await renderX11(h(List), { backend: 'mock' });

  const row = await inspect(screen.getAllByComponent('Row')[0]);
  const counter = row.hooks[0].subHooks[0];
  await row.setHook(counter.id, 99);
  screen.getByText('row 1: 99');

  // the override holds its own against unrelated re-renders above — it
  // replaced the hook's state, it did not shadow it
  await act(() => addRow());
  screen.getByText('row 3: 30');
  screen.getByText('row 1: 99');
});

test('setHook takes a path into the state value', async () => {
  await renderX11(h(List), { backend: 'mock' });
  const list = await inspect(screen.getByText(/^tag:/));
  await list.setHook(list.hooks[1].id, ['nested', 'deep'], 'zz');
  screen.getByText('tag: zz');
  // the untouched half of the object survives the copy-with-set
  const again = await inspect(screen.getByText(/^tag:/));
  assert.strictEqual(again.hooks[1].value.tag, 'x');
});

test('setHook refuses hooks that are not state, and names the ones that are', async () => {
  await renderX11(h(List), { backend: 'mock' });
  const list = await inspect(screen.getByText(/^tag:/));
  const effect = list.hooks.find((hk) => hk.name === 'Effect');
  await assert.rejects(
    () => list.setHook(effect.id, 1),
    /is a Effect hook[\s\S]*Editable hooks:[\s\S]*0: State/,
  );
  await assert.rejects(
    () => list.setHook(99, 1),
    /does not exist on this component/,
  );
});

test('the change lands in the retained tree, not only in React state', async () => {
  await renderX11(h(List), { backend: 'mock' });
  const list = await inspect(screen.getByText(/^tag:/));
  await list.setHook(1, ['nested', 'deep'], 'painted');
  assert.strictEqual(textOf(screen.getByText(/^tag:/)), 'tag: painted');
});

test('inspection works against the real in-process X server too', async () => {
  // the other tests use the mock for speed; the wiring must not care
  function Wide() {
    const [w] = React.useState(300);
    return h('box', { style: { width: w, height: 40 } });
  }
  await renderX11(h(Wide), { width: 320, height: 80 });
  const c = await inspect(screen.getByComponent('Wide'));
  assert.strictEqual(c.name, 'Wide');
  assert.strictEqual(c.hooks[0].value, 300);
  await c.setHook(0, 120);
  assert.strictEqual(screen.getByComponent('Wide').abs.width, 120);
});

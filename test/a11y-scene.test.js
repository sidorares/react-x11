// The scene an element draws, as accessible children (#304): a registered
// element that paints N interactive things into one node describes them, and
// an assistive technology meets each one — named, placed, selectable,
// activatable — instead of meeting a single "group" with nothing in it.
//
// The element under test is a miniature graph pane, which is the shape the
// issue came from: nodes it draws itself, a selection and a keyboard cursor
// of its own, and no retained children at all. Everything goes through
// `react-x11/host` and `react-x11/node`, because the point is that a sibling
// package can do this without reaching into src/.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import React from 'react';

import { registerElement, unregisterElement } from '../src/host.js';
import { Node } from '../src/node.js';
import {
  ATSPI_ROLE,
  ATSPI_STATE,
  atspiRoleOf,
  a11yChildren,
  a11yIndexIn,
  a11yName,
  a11yParent,
  a11yStates,
  a11yActivatable,
  a11ySceneItems,
  isSceneItem,
} from '../src/a11y.js';
import { cleanup, renderX11, screen } from '../src/testing/index.js';

const h = React.createElement;

const hasState = (states, bit) =>
  bit < 32
    ? Boolean(states[0] & (1 << bit))
    : Boolean(states[1] & (1 << (bit - 32)));

/**
 * A graph pane: it draws its nodes into its own rectangle, keeps the
 * selection and the keyboard cursor itself, and has no children in the
 * retained tree. `a11yScene()` is the whole of what it says about them —
 * everything below it is the element's own behaviour, which is what makes
 * the point that the seam reports state rather than owning it.
 */
class GraphNode extends Node {
  constructor(props, app) {
    super('minigraph', props, app);
    this.focusableByDefault = true;
    this.selected = null;
    this.cursor = null;
    /** what an AT asked this element to do, for the assertions */
    this.acted = [];
    this.handles = null;
  }

  a11yScene() {
    return (this.props.nodes ?? []).map((node) => ({
      id: node.id,
      role: 'listitem',
      name: node.label,
      rect: { x: node.x, y: node.y, width: 60, height: 20 },
      states: {
        selected: this.selected === node.id,
        focused: this.cursor === node.id,
        disabled: node.disabled === true,
      },
      props: { 'aria-setsize': this.props.nodes.length },
      children: node.ports?.map((port) => ({
        id: port,
        role: 'option',
        name: port,
        rect: { x: node.x, y: node.y + 20, width: 12, height: 12 },
      })),
    }));
  }

  a11ySceneAction(id, action) {
    this.acted.push([id, action]);
    if (this.handles && !this.handles.includes(action)) return false;
    if (action === 'focus') this.cursor = id;
    if (action === 'activate') this.select(id);
    return true;
  }

  select(id) {
    this.selected = id;
    this.notifyA11ySceneChanged();
  }

  moveCursor(id) {
    this.cursor = id;
    this.notifyA11ySceneChanged();
  }
}

/** An element that draws things and says nothing else about them. */
class BareSceneNode extends Node {
  constructor(props, app) {
    super('minibare-scene', props, app);
  }

  a11yScene() {
    return this.props.items ?? [];
  }
}

const registered = new Set();
function registerAll() {
  for (const [type, create] of [
    ['minigraph', (props, app) => new GraphNode(props, app)],
    ['minibare-scene', (props, app) => new BareSceneNode(props, app)],
  ]) {
    registerElement(type, {
      create,
      semanticNames: ['nodes', 'items'],
      childrenAllowed: false,
    });
    registered.add(type);
  }
}

afterEach(async () => {
  await cleanup();
  for (const type of registered) unregisterElement(type);
  registered.clear();
});

const NODES = [
  { id: 'a', label: 'Fetch', x: 10, y: 10 },
  { id: 'b', label: 'Parse', x: 10, y: 50 },
  { id: 'c', label: 'Render', x: 10, y: 90 },
];

const graphOf = () => screen.all((n) => n.kind === 'minigraph')[0];

async function renderGraph(nodes = NODES, props = {}) {
  registerAll();
  await renderX11(
    h('minigraph', { nodes, style: { width: 200, height: 140 }, ...props }),
    { backend: 'mock' },
  );
  return graphOf();
}

// ---------------------------------------------------------------------------
// The projection: what an element that drew a scene is, to the model
// ---------------------------------------------------------------------------

test('a drawn scene is children, where the tree has none', async () => {
  const graph = await renderGraph();
  assert.equal(graph.children.length, 0, 'nothing retained under it');

  const children = a11yChildren(graph);
  assert.equal(children.length, 3);
  assert.deepEqual(
    children.map((item) => [a11yName(item), atspiRoleOf(item)]),
    [
      ['Fetch', ATSPI_ROLE.LIST_ITEM],
      ['Parse', ATSPI_ROLE.LIST_ITEM],
      ['Render', ATSPI_ROLE.LIST_ITEM],
    ],
  );
  // and they are children in the full sense: the walk back up lands on the
  // element, which is what an AT's Parent/GetIndexInParent answer with
  assert.ok(a11yParent(children[1]) === graph, 'the element is the parent');
  assert.equal(a11yIndexIn(graph, children[1]), 1);
  assert.equal(isSceneItem(children[0]), true);
});

test('an item is placed where it was drawn, in window coordinates', async () => {
  const graph = await renderGraph();
  const [first] = a11yChildren(graph);
  assert.deepEqual(first.abs, { x: 10, y: 10, width: 60, height: 20 });
  assert.ok(first.root === graph.root, 'the same window as the element');
});

test('an item with no role is audible and promises nothing', async () => {
  registerAll();
  await renderX11(
    h('minibare-scene', {
      items: [{ id: 'x', name: 'Slice', rect: { x: 0, y: 0, w: 1 } }],
    }),
    { backend: 'mock' },
  );
  const [item] = a11yChildren(
    screen.all((n) => n.kind === 'minibare-scene')[0],
  );
  assert.equal(atspiRoleOf(item), ATSPI_ROLE.GROUPING);
  assert.equal(a11yName(item), 'Slice');
  // a rect written in some other vocabulary is zeroes, never NaN on the wire
  assert.deepEqual(item.abs, { x: 0, y: 0, width: 0, height: 0 });
  assert.equal(a11yActivatable(item), false, 'group promises no action');
});

test('states come from the same facts the element draws from', async () => {
  const graph = await renderGraph([
    ...NODES,
    { id: 'd', label: 'Off', x: 10, y: 130, disabled: true },
  ]);
  graph.selected = 'b';
  graph.cursor = 'c';

  const [a, b, c, d] = a11yChildren(graph);
  const S = ATSPI_STATE;
  assert.ok(hasState(a11yStates(b), S.SELECTED), 'the selected one');
  assert.ok(!hasState(a11yStates(a), S.SELECTED));
  // declaring the state at all is what makes every item selectable
  assert.ok(hasState(a11yStates(a), S.SELECTABLE));
  // the element's own cursor, which never reaches the window's focus manager
  assert.ok(hasState(a11yStates(c), S.FOCUSED), "the element's own cursor");
  assert.ok(!hasState(a11yStates(b), S.FOCUSED));
  assert.ok(hasState(a11yStates(a), S.FOCUSABLE), 'focusable by default');
  assert.ok(hasState(a11yStates(a), S.SHOWING), 'the window is on screen');
  assert.ok(!hasState(a11yStates(d), S.ENABLED), 'a disabled item');
  assert.ok(!hasState(a11yStates(d), S.FOCUSABLE));
  assert.ok(hasState(a11yStates(a), S.ENABLED));
});

test('the props escape hatch is read as it would be on a box', async () => {
  const graph = await renderGraph();
  const [first] = a11yChildren(graph);
  const { a11yAttributes } = await import('../src/a11y.js');
  assert.deepEqual(a11yAttributes(first), [
    ['xml-roles', 'listitem'],
    ['setsize', '3'],
  ]);
});

test('a scene with structure nests', async () => {
  const graph = await renderGraph([
    { id: 'a', label: 'Fetch', x: 10, y: 10, ports: ['in', 'out'] },
  ]);
  const [node] = a11yChildren(graph);
  const ports = a11yChildren(node);
  assert.deepEqual(
    ports.map((p) => a11yName(p)),
    ['in', 'out'],
  );
  assert.ok(
    a11yParent(ports[0]) === node,
    'nested under the item, not the element',
  );
  assert.equal(atspiRoleOf(ports[1]), ATSPI_ROLE.LIST_ITEM);
});

test('an element with a scene keeps whatever it holds in the tree', async () => {
  registerAll();
  await renderX11(
    h(
      'box',
      { role: 'group' },
      h('text', null, 'Legend'),
      h('minigraph', { nodes: NODES.slice(0, 1) }),
    ),
    { backend: 'mock' },
  );
  const box = screen.all((n) => n.props?.role === 'group')[0];
  const children = a11yChildren(box);
  // the retained child first, then what its sibling drew — under it
  assert.equal(children.length, 2);
  assert.equal(children[0].kind, 'text');
  assert.equal(a11yChildren(children[1]).length, 1);
});

// ---------------------------------------------------------------------------
// Identity: the half that decides whether an AT's refs survive a frame
// ---------------------------------------------------------------------------

test('an id keeps its object across frames, so a ref stays alive', async () => {
  const graph = await renderGraph();
  const before = a11yChildren(graph);
  // the same scene, described again — the element rebuilt every descriptor
  const again = a11yChildren(graph);
  // identity asserted as a boolean on purpose: a failing object comparison
  // walks the whole retained tree through `a11yOwner` before it reports
  assert.ok(
    again.every((item, i) => item === before[i]),
    'the same objects, not equal copies of them',
  );

  graph.select('b');
  const selected = a11yChildren(graph);
  assert.ok(selected[1] === before[1], 'a state change is not a new child');
  assert.ok(hasState(a11yStates(selected[1]), ATSPI_STATE.SELECTED));
});

test('an item that leaves the scene is defunct, not forgotten', async () => {
  const graph = await renderGraph();
  const [, parse] = a11yChildren(graph);
  graph.props = { ...graph.props, nodes: [NODES[0], NODES[2]] };

  const after = a11yChildren(graph);
  assert.deepEqual(
    after.map((item) => a11yName(item)),
    ['Fetch', 'Render'],
  );
  assert.equal(parse.destroyed, true, 'an AT still holding it hears defunct');
  assert.ok(hasState(a11yStates(parse), ATSPI_STATE.DEFUNCT));
  // and it does not come back as itself when the id returns
  graph.props = { ...graph.props, nodes: NODES };
  assert.ok(
    a11yChildren(graph)[1] !== parse,
    'a fresh object for a fresh child',
  );
});

test('an item without an id is dropped, loudly', async () => {
  registerAll();
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    await renderX11(
      h('minibare-scene', {
        items: [
          { id: 'one', name: 'One', rect: { x: 0, y: 0 } },
          { name: 'nameless', rect: { x: 0, y: 0 } },
          { id: 'one', name: 'again', rect: { x: 0, y: 0 } },
        ],
      }),
      { backend: 'mock' },
    );
    const owner = screen.all((n) => n.kind === 'minibare-scene')[0];
    const items = a11yChildren(owner);
    assert.deepEqual(
      items.map((item) => a11yName(item)),
      ['One'],
      'the id-less one and the duplicate are dropped',
    );
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /<minibare-scene> reported an accessible child/);
    assert.match(warnings[1], /two accessible children with the id "one"/);
  } finally {
    console.warn = warn;
  }
});

test('an element that draws nothing costs nothing', async () => {
  await renderGraph();
  const plain = screen.all((n) => n.kind === 'minigraph')[0].root;
  // the shared empty list, so walking an ordinary tree allocates none
  assert.ok(
    a11ySceneItems(plain) === a11ySceneItems(plain),
    'one list, shared',
  );
  assert.equal(a11ySceneItems(plain).length, 0);
});

// ---------------------------------------------------------------------------
// The feed: what an assistive technology is told, through the same spy an
// application's own suite uses
// ---------------------------------------------------------------------------

test('selecting a drawn node reaches the AT as that node changing', async () => {
  registerAll();
  const { at } = await renderX11(
    h('minigraph', { nodes: NODES, style: { width: 200, height: 140 } }),
    { a11y: true },
  );
  const graph = graphOf();
  at.since();

  graph.select('b');
  const entries = at.since();
  assert.deepEqual(
    entries.map((e) => e.summary),
    ['state: selected'],
  );
  assert.equal(a11yName(entries[0].node), 'Parse', 'the item, not the pane');

  graph.moveCursor('c');
  assert.deepEqual(
    at.since().map((e) => e.summary),
    ['state: focused'],
  );
});

test('a scene that is a function of the props needs no notification', async () => {
  registerAll();
  const { at, rerender } = await renderX11(
    h('minigraph', { nodes: NODES, style: { width: 200, height: 140 } }),
    { a11y: true },
  );
  at.since();
  await rerender(
    h('minigraph', {
      nodes: [{ ...NODES[0], label: 'Fetching…' }, ...NODES.slice(1)],
      style: { width: 200, height: 140 },
    }),
  );
  assert.deepEqual(
    at.since().map((e) => e.summary),
    ['name: Fetching…'],
    'the commit re-read the scene on its own',
  );
});

// ---------------------------------------------------------------------------
// Actions: the write half
// ---------------------------------------------------------------------------

test('an element answers the actions it has an answer for', async () => {
  const graph = await renderGraph();
  graph.handles = ['focus'];
  const [, parse] = a11yChildren(graph);
  // the routing the bridge performs, without a bus in the way
  assert.equal(graph.a11ySceneAction(parse.a11yId, 'focus'), true);
  assert.equal(graph.cursor, 'b');
  assert.equal(graph.a11ySceneAction(parse.a11yId, 'activate'), false);
  assert.deepEqual(graph.acted, [
    ['b', 'focus'],
    ['b', 'activate'],
  ]);
});

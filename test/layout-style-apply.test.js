// `applyLayoutStyle` walks the keys two styles carry rather than every
// property yoga knows (src/styles.js). What has to hold is that a style
// applied over the one before leaves yoga exactly where the same style
// applied to a fresh node does — whatever the two named, changed or
// dropped, a placed position and its insets included — and that it says
// whether anything moved.
import { test } from 'node:test';
import assert from 'node:assert';
import { loadLayout, Yoga } from '../src/yoga.js';
import {
  applyLayoutDefaults,
  applyLayoutStyle,
  createLayoutNode,
} from '../src/styles.js';

await loadLayout();

const EDGES = [
  Yoga.EDGE_LEFT,
  Yoga.EDGE_TOP,
  Yoga.EDGE_RIGHT,
  Yoga.EDGE_BOTTOM,
  Yoga.EDGE_START,
  Yoga.EDGE_END,
  Yoga.EDGE_ALL,
];

/**
 * Everything yoga holds of a node's style, as plain values — with the two
 * spellings of one value that a reset and a fresh node differ in made one:
 * a size yoga was handed `undefined` for is `auto` to layout, and a gap or
 * border on every side that is `0` is the `0` nothing falls back past. A
 * row or column gap is not among them: yoga takes a set one over `gap`.
 */
function styleOf(n) {
  const v = (x) =>
    x !== null && typeof x === 'object' ? `${x.unit}:${x.value}` : String(x);
  const size = (x) =>
    x.unit === Yoga.UNIT_UNDEFINED || x.unit === Yoga.UNIT_AUTO ? 'auto' : v(x);
  const zeroIfUnset = (x) => (x == null || Number.isNaN(x) ? 0 : x);
  return {
    sizes: [n.getWidth(), n.getHeight(), n.getFlexBasis()].map(size),
    limits: [
      n.getMinWidth(),
      n.getMinHeight(),
      n.getMaxWidth(),
      n.getMaxHeight(),
    ].map(v),
    enums: [
      n.getFlexDirection(),
      n.getJustifyContent(),
      n.getAlignItems(),
      n.getAlignSelf(),
      n.getAlignContent(),
      n.getFlexWrap(),
      n.getPositionType(),
      n.getDirection(),
      n.getDisplay(),
      n.getOverflow(),
    ],
    flex: [n.getFlexGrow(), n.getFlexShrink(), n.getAspectRatio()].map(v),
    insets: EDGES.map((e) => v(n.getPosition(e))),
    margins: EDGES.map((e) => v(n.getMargin(e))),
    paddings: EDGES.map((e) => v(n.getPadding(e))),
    borders: EDGES.map((e) =>
      v(e === Yoga.EDGE_ALL ? zeroIfUnset(n.getBorder(e)) : n.getBorder(e)),
    ),
    gaps: [
      v(zeroIfUnset(n.getGap(Yoga.GUTTER_ALL))),
      v(n.getGap(Yoga.GUTTER_ROW)),
      v(n.getGap(Yoga.GUTTER_COLUMN)),
    ],
  };
}

const fresh = (style) => {
  const n = createLayoutNode();
  applyLayoutDefaults(n);
  applyLayoutStyle(n, style);
  return n;
};

// what a style can say, layout and not: lengths, percentages, `auto`,
// keywords, a placed position (sticky, or a registered one as an object)
const LENGTH = [0, 7, 24.5, '10%', 'auto', undefined];
const VALUES = {
  width: LENGTH,
  height: LENGTH,
  minWidth: [0, 12, '5%', undefined],
  maxHeight: [40, '50%', undefined],
  flexBasis: [0, 30, '25%', 'auto', undefined],
  flexDirection: ['row', 'column', 'row-reverse', undefined],
  justifyContent: ['center', 'space-between', undefined],
  alignItems: ['center', 'flex-end', 'stretch', undefined],
  alignSelf: ['center', 'auto', undefined],
  flexWrap: ['wrap', 'nowrap', undefined],
  flexGrow: [0, 1, 2.5, undefined],
  flexShrink: [0, 1, undefined],
  position: [
    'relative',
    'absolute',
    'sticky',
    { name: 'test-anchor', side: 'below' },
    undefined,
  ],
  direction: ['ltr', 'rtl', undefined],
  top: [0, 5, '10%', undefined],
  left: [3, 'auto', undefined],
  end: [4, undefined],
  margin: [2, 'auto', undefined],
  marginTop: [6, '3%', undefined],
  marginStart: [1, undefined],
  padding: [4, '2%', undefined],
  paddingLeft: [9, undefined],
  paddingEnd: [3, undefined],
  gap: [0, 8, undefined],
  rowGap: [2, undefined],
  columnGap: [5, undefined],
  aspectRatio: [1.5, undefined],
  display: ['flex', 'none', undefined],
  overflow: ['hidden', 'scroll', undefined],
  borderWidth: [1, 0, undefined],
  borderTopWidth: [3, undefined],
  borderStartWidth: [2, undefined],
  // what layout ignores, and must go on ignoring
  backgroundColor: ['#fff', '#eee'],
  color: ['red'],
  transition: [{ backgroundColor: 80 }],
  toString: [5],
};
const KEYS = Object.keys(VALUES);

function styles(seed, count) {
  let s = seed;
  const r = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  return Array.from({ length: count }, () => {
    const style = {};
    const n = Math.floor(r() * 9);
    for (let i = 0; i < n; i++) {
      const key = KEYS[Math.floor(r() * KEYS.length)];
      const values = VALUES[key];
      style[key] = values[Math.floor(r() * values.length)];
    }
    return style;
  });
}

test('a style applied over another leaves yoga where a fresh node would be', () => {
  for (const seed of [1, 7, 42, 99, 1234]) {
    const list = styles(seed, 60);
    const node = fresh(list[0]);
    for (let i = 1; i < list.length; i++) {
      applyLayoutStyle(node, list[i], list[i - 1]);
      assert.deepStrictEqual(
        styleOf(node),
        styleOf(fresh(list[i])),
        `seed ${seed}: ${JSON.stringify(list[i - 1])} -> ${JSON.stringify(list[i])}`,
      );
    }
  }
});

test('it says a style changed exactly when yoga holds something else', () => {
  for (const seed of [3, 11, 58]) {
    const list = styles(seed, 80);
    for (let i = 1; i < list.length; i++) {
      const node = fresh(list[i - 1]);
      const before = styleOf(node);
      const changed = applyLayoutStyle(node, list[i], list[i - 1]);
      const after = styleOf(node);
      const flipped =
        (list[i].position === 'sticky' ||
          typeof list[i].position === 'object') !==
        (list[i - 1].position === 'sticky' ||
          typeof list[i - 1].position === 'object');
      // a flip is a change even where yoga holds the same insets: the pass
      // it asks for is what places the node
      if (flipped) assert.ok(changed, 'a flip is a change');
      else if (JSON.stringify(before) !== JSON.stringify(after)) {
        assert.ok(changed, `${JSON.stringify(list[i])}: said nothing moved`);
      }
    }
  }
});

test('a node that becomes placed hands yoga its insets back, and takes them again', () => {
  // the insets that do not change across the flip are the ones only the
  // flip re-sends: a placed node's are its placement's, never offsets
  for (const placed of ['sticky', { name: 'test-anchor', side: 'below' }]) {
    const offset = { position: 'absolute', top: 5, left: 3, end: 4 };
    const held = { ...offset, position: placed };
    const node = fresh(offset);
    assert.ok(applyLayoutStyle(node, held, offset), 'the flip is a change');
    assert.deepStrictEqual(styleOf(node), styleOf(fresh(held)), 'placed');
    assert.deepStrictEqual(
      styleOf(node).insets,
      styleOf(fresh({ position: placed })).insets,
      'a placed node holds no offsets',
    );
    assert.ok(applyLayoutStyle(node, offset, held), 'and back');
    assert.deepStrictEqual(styleOf(node), styleOf(fresh(offset)), 'offset');
  }
});

test('the same style, or one that differs only in paint, changes nothing', () => {
  const style = { flexDirection: 'row', padding: 4, width: 20, top: 3 };
  const node = fresh(style);
  assert.strictEqual(applyLayoutStyle(node, { ...style }, style), false);
  assert.strictEqual(
    applyLayoutStyle(node, { ...style, backgroundColor: '#eee' }, style),
    false,
  );
});

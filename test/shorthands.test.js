// CSS's shorthands and the length grammar (src/shorthands.js).
//
// Three things are pinned here. A shorthand means what CSS says it means —
// the one-to-four rule, `margin: '0 auto'`, `flex: '0 0 240px'`. The more
// specific property wins wherever it is written, which is not CSS's rule
// (CSS goes by order) and is the one a flattened style can keep. And a length
// is the number it names however it is written: `'12px'` used to reach yoga
// as a string, which the display scale never multiplied, yoga's border setter
// read as NaN, and the layout's fast paths took for a percentage.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';

import xserver from 'x11/lib/xserver/index.js';
import { createClient } from 'ntk';

import { createRoot } from '../src/index.js';
import {
  flattenStyle,
  resolveComputedStyle,
  resolveStyleStates,
  scaleResolvedStyle,
  transitionFor,
  validateStyle,
  SCALED_LENGTH_PROPS,
  isStyleProp,
} from '../src/styles.js';
import {
  LENGTH_FORMS,
  expandShorthand,
  readLength,
} from '../src/shorthands.js';
import { loadLayout } from '../src/yoga.js';
import { createMockApp, flushFrames } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

await loadLayout();

const expand = (style) => resolveComputedStyle(flattenStyle(style));
const problem = (style) => {
  try {
    validateStyle(flattenStyle(style), '<box style>');
    return null;
  } catch (err) {
    return err.message;
  }
};

test('a length is the number it names, however it is written', () => {
  assert.equal(readLength('width', 12), 12);
  assert.equal(readLength('width', '12'), 12);
  assert.equal(readLength('width', '12px'), 12);
  assert.equal(readLength('width', ' 12.5PX '), 12.5);
  assert.equal(readLength('width', '-4px'), -4);
  assert.equal(readLength('width', '50%'), '50%');
  assert.equal(readLength('width', 'auto'), 'auto');
  assert.equal(readLength('borderWidth', 'thin'), 1);
  assert.equal(readLength('borderWidth', 'medium'), 3);
  assert.equal(readLength('outlineWidth', 'thick'), 5);
  // what each property does not take, said by name
  assert.throws(() => readLength('padding', 'auto'), /expected .*'50%'\)$/);
  assert.throws(
    () => readLength('borderWidth', '10%'),
    /does not take a percentage/,
  );
  assert.throws(
    () => readLength('width', 'thin'),
    /invalid width "thin" \(expected/,
  );
});

test('a unit no length reads is an error naming it, not parseFloat’s guess', () => {
  // yoga's own setters read every one of these as a number of pixels
  for (const [value, says] of [
    ['2em', /em is not a unit react-x11 resolves yet/],
    ['1.5rem', /rem is not a unit/],
    ['10vw', /vw is not a unit/],
    ['50cqw', /cqw is not a unit/],
    ['12pt', /pt is a print unit/],
    ['3furlongs', /"furlongs" is not a unit/],
    ['calc(100% - 8px)', /calc\(\) is not supported/],
    ['min(10px, 5%)', /min\(\) is not supported/],
    ['10px 20px', /width takes one value/],
  ]) {
    const message = problem({ width: value });
    assert.match(message ?? '(none)', says, value);
    assert.match(
      message,
      /^react-x11: invalid width "[^"]*" in <box style>/,
      value,
    );
  }
  assert.match(
    problem({ borderRadius: '50%' }),
    /a percentage radius is not supported yet/,
  );
  assert.match(
    problem({ borderRadius: '4px 8px' }),
    /a radius per corner is not supported/,
  );
  // and the paint lengths and the text ones read the same grammar
  assert.equal(problem({ borderRadius: '6px', outlineOffset: '-2px' }), null);
  assert.equal(problem({ fontSize: '15px', letterSpacing: '0.5px' }), null);
});

test('the funnel reads every length into a number, so the display scale reaches it', () => {
  const style = expand({
    width: '120px',
    borderWidth: '2px',
    fontSize: '15px',
  });
  assert.deepEqual(style, { width: 120, borderWidth: 2, fontSize: 15 });
  // the failure this fixes: a string passed through the scale unmultiplied
  assert.deepEqual(scaleResolvedStyle(style, 2), {
    width: 240,
    borderWidth: 4,
    fontSize: 30,
  });
  // a percentage and 'auto' mean the same at any density, and stay strings
  assert.deepEqual(expand({ width: '50%', height: 'auto', margin: '10%' }), {
    width: '50%',
    height: 'auto',
    margin: '10%',
  });
});

test('a style written in numbers is handed on as it is', () => {
  // identity is what tells the node its style did not change
  const style = { width: 10, padding: 8, borderColor: 'rgba(0, 0, 0, 0.5)' };
  assert.equal(resolveComputedStyle(style), style);
});

test('padding, margin, inset and borderWidth follow CSS’s one-to-four rule', () => {
  assert.deepEqual(expand({ padding: '10px 20px' }), {
    paddingTop: 10,
    paddingRight: 20,
    paddingBottom: 10,
    paddingLeft: 20,
  });
  assert.deepEqual(expand({ padding: '1 2 3' }), {
    paddingTop: 1,
    paddingRight: 2,
    paddingBottom: 3,
    paddingLeft: 2,
  });
  assert.deepEqual(expand({ margin: '0 auto' }), {
    marginTop: 0,
    marginRight: 'auto',
    marginBottom: 0,
    marginLeft: 'auto',
  });
  assert.deepEqual(expand({ inset: 0 }), {
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  });
  assert.deepEqual(expand({ borderWidth: '1px 2px 3px 4px' }), {
    borderTopWidth: 1,
    borderRightWidth: 2,
    borderBottomWidth: 3,
    borderLeftWidth: 4,
  });
  assert.deepEqual(expand({ borderColor: 'red rgba(0, 0, 0, 0.5)' }), {
    borderTopColor: 'red',
    borderRightColor: 'rgba(0, 0, 0, 0.5)',
    borderBottomColor: 'red',
    borderLeftColor: 'rgba(0, 0, 0, 0.5)',
  });
  // one value stays the one property it always was
  assert.deepEqual(expand({ padding: '8px' }), { padding: 8 });
  assert.match(problem({ padding: '1 2 3 4 5' }), /5 values/);
  assert.match(problem({ padding: '1 2 auto' }), /invalid padding "auto"/);
});

test('the pairs: gap is row then column, the logical ones start then end', () => {
  assert.deepEqual(expand({ gap: '4px 8px' }), { rowGap: 4, columnGap: 8 });
  assert.deepEqual(expand({ paddingInline: 16 }), {
    paddingStart: 16,
    paddingEnd: 16,
  });
  assert.deepEqual(expand({ paddingBlock: '4 8', marginInline: '0 auto' }), {
    paddingTop: 4,
    paddingBottom: 8,
    marginStart: 0,
    marginEnd: 'auto',
  });
  assert.deepEqual(expand({ marginBlock: '12px' }), {
    marginTop: 12,
    marginBottom: 12,
  });
});

test('border and its sides: a width, a style and a colour, in any order', () => {
  assert.deepEqual(expand({ border: 'solid red 2px' }), {
    borderWidth: 2,
    borderStyle: 'solid',
    borderColor: 'red',
  });
  assert.deepEqual(expand({ border: '1px dashed rgba(0, 0, 0, 0.2)' }), {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: 'rgba(0, 0, 0, 0.2)',
  });
  assert.deepEqual(expand({ borderBottom: '1px solid #ccc' }), {
    borderBottomWidth: 1,
    borderBottomColor: '#ccc',
    borderStyle: 'solid',
  });
  assert.deepEqual(expand({ borderStart: 'thick #000' }), {
    borderStartWidth: 5,
    borderStartColor: '#000',
  });
  // CSS's `medium` when no width is named, and `none` is a width of 0
  assert.deepEqual(expand({ border: 'solid #000' }), {
    borderWidth: 3,
    borderStyle: 'solid',
    borderColor: '#000',
  });
  assert.deepEqual(expand({ border: 'none' }), { borderWidth: 0 });
  assert.deepEqual(expand({ border: 0 }), { borderWidth: 0 });
  assert.deepEqual(expand({ borderTop: 'none' }), { borderTopWidth: 0 });
});

test('what a border cannot be is said where it is written', () => {
  assert.match(
    problem({ border: '1px dotted red' }),
    /dotted lines are not drawn here — solid and dashed are/,
  );
  assert.match(problem({ border: '1px 2px red' }), /names two widths/);
  assert.match(problem({ border: '1px red blue' }), /names two colours/);
  assert.match(
    problem({ border: '1px solid nonsense' }),
    /"nonsense" is neither/,
  );
  assert.match(problem({ border: '1em solid red' }), /em is not a unit/);
  // a line with no colour is drawn in currentColor, as in CSS
  assert.equal(problem({ border: '1px solid' }), null);
  assert.equal(problem({ outline: '2px' }), null);
  assert.equal(problem({ border: '1px solid currentColor' }), null);
  assert.equal(problem({ border: '1px solid $border' }), null);
  // one box, one line style
  assert.match(
    problem({ border: '1px solid red', borderTop: '2px dashed blue' }),
    /border and borderTop name different line styles/,
  );
  assert.equal(
    problem({
      border: '1px solid red',
      borderTop: '2px dashed blue',
      borderStyle: 'dashed',
    }),
    null,
  );
  assert.match(
    problem({ borderStyle: 'none' }),
    /expected 'solid' or 'dashed' — a box with no border is borderWidth: 0/,
  );
});

test('a line with no colour is currentColor, unless the style names one for it', () => {
  // CSS's reset, for the one part a line cannot be drawn without
  assert.deepEqual(expand({ border: '1px solid' }), {
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'currentColor',
  });
  assert.deepEqual(expand({ borderBottom: '2px' }), {
    borderBottomWidth: 2,
    borderBottomColor: 'currentColor',
  });
  assert.deepEqual(expand({ outline: 'thin' }), {
    outlineWidth: 1,
    outlineColor: 'currentColor',
  });
  // the keyword written out is a colour like any other, in any case
  assert.deepEqual(expand({ border: 'CurrentColor 1px' }), {
    borderWidth: 1,
    borderColor: 'CurrentColor',
  });
  assert.deepEqual(expand({ background: 'currentcolor' }), {
    backgroundColor: 'currentcolor',
  });
  // …and is the weakest thing in the style: a colour named for the side —
  // the four-side longhand a side falls back to, a list, a state block —
  // is the one the line takes, which is what such a style meant before
  assert.deepEqual(expand({ borderBottom: '1px solid', borderColor: 'red' }), {
    borderBottomWidth: 1,
    borderStyle: 'solid',
    borderColor: 'red',
  });
  assert.deepEqual(
    expand({ borderBottom: '1px', borderColor: 'red blue' }).borderBottomColor,
    'red',
  );
  assert.deepEqual(expand({ border: '2px', borderTopColor: 'blue' }), {
    borderWidth: 2,
    borderTopColor: 'blue',
    borderColor: 'currentColor',
  });
  assert.equal(
    expand({ outline: '2px', outlineColor: '$accent' }).outlineColor,
    '$accent',
  );
  const hover = { border: '1px solid', ':hover': { borderColor: 'red' } };
  assert.equal(
    resolveComputedStyle(resolveStyleStates(hover, { ':hover': true }))
      .borderColor,
    'red',
  );
  assert.equal(expand(hover).borderColor, 'currentColor');
  // no line, no colour to need
  assert.deepEqual(expand({ border: 'none' }), { borderWidth: 0 });
  assert.deepEqual(expand({ border: 0 }), { borderWidth: 0 });
  assert.deepEqual(expand({ outline: '0 solid' }), { outlineWidth: 0 });
  // the shorthand alone says what it means alone
  assert.deepEqual(expandShorthand('borderTop', '1px dashed'), {
    borderTopWidth: 1,
    borderTopColor: 'currentColor',
    borderStyle: 'dashed',
  });
});

test('outline and background', () => {
  assert.deepEqual(expand({ outline: 'none' }), { outlineWidth: 0 });
  assert.deepEqual(expand({ outline: '2px solid #4c8bf5' }), {
    outlineWidth: 2,
    outlineColor: '#4c8bf5',
  });
  assert.match(problem({ outline: '1px dashed red' }), /drawn solid/);
  assert.deepEqual(expand({ background: '#eee' }), {
    backgroundColor: '#eee',
  });
  assert.deepEqual(expand({ background: 'linear-gradient(red, blue) white' }), {
    backgroundColor: 'white',
    backgroundImage: 'linear-gradient(red, blue)',
  });
  // `none` takes the colour away with the image, the way a state block
  // says "no fill here"
  assert.deepEqual(expand({ background: 'none' }), {
    backgroundColor: 'transparent',
    backgroundImage: 'none',
  });
  assert.match(problem({ background: 'url(a.png)' }), /an <image src> element/);
  assert.match(problem({ background: 'red, blue' }), /one layer/);
  assert.match(problem({ background: 'radial-gradient(red, blue)' }), /radial/);
  // both are paint all the way down, so a state block may set them
  assert.equal(
    problem({ ':hover': { background: '#eee', outline: '1px solid red' } }),
    null,
  );
  assert.match(
    problem({ ':hover': { border: '1px solid red' } }),
    /"border" is not allowed inside ":hover"/,
  );
});

test('flex reads CSS’s grammar, and a number is still <grow> 1 0', () => {
  const flex = (value) => expand({ flex: value });
  assert.deepEqual(flex(1), { flexGrow: 1, flexShrink: 1, flexBasis: 0 });
  assert.deepEqual(flex('1'), { flexGrow: 1, flexShrink: 1, flexBasis: 0 });
  assert.deepEqual(flex('2 3'), { flexGrow: 2, flexShrink: 3, flexBasis: 0 });
  assert.deepEqual(flex('1 1 0'), { flexGrow: 1, flexShrink: 1, flexBasis: 0 });
  assert.deepEqual(flex('0 0 240px'), {
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 240,
  });
  assert.deepEqual(flex('2 200px'), {
    flexGrow: 2,
    flexShrink: 1,
    flexBasis: 200,
  });
  assert.deepEqual(flex('240px'), {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 240,
  });
  assert.deepEqual(flex('30% 2'), {
    flexGrow: 2,
    flexShrink: 1,
    flexBasis: '30%',
  });
  assert.deepEqual(flex('none'), {
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 'auto',
  });
  assert.deepEqual(flex('initial'), {
    flexGrow: 0,
    flexShrink: 1,
    flexBasis: 'auto',
  });
  assert.match(problem({ flex: -1 }), /cannot be negative/);
  assert.match(problem({ flex: '1 2 3 4' }), /three at most/);
  assert.match(problem({ flex: '1 10px 1' }), /the basis splits the factors/);
  assert.match(
    problem({ flex: 'content' }),
    /invalid flex "content" in <box style>: "content" is neither a factor nor a basis/,
  );
  assert.match(
    problem({ flex: '1 2em' }),
    /invalid flex basis "2em".*em is not/,
  );
});

test('the more specific property wins, wherever it is written', () => {
  for (const order of [
    [{ padding: '10px 20px' }, { paddingTop: 0 }],
    [{ paddingTop: 0 }, { padding: '10px 20px' }],
  ]) {
    assert.deepEqual(expand(order), {
      paddingTop: 0,
      paddingRight: 20,
      paddingBottom: 10,
      paddingLeft: 20,
    });
  }
  // a longhand beats the shorthand that would set it
  assert.deepEqual(expand({ border: '1px solid red', borderColor: 'blue' }), {
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'blue',
  });
  assert.deepEqual(expand({ flex: 1, flexBasis: 'auto' }), {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 'auto',
  });
  // a side beats all four, a pair beats all four
  assert.deepEqual(
    expand({ borderWidth: '1px 3px', borderTop: '5px solid red' }),
    {
      borderTopWidth: 5,
      borderTopColor: 'red',
      borderStyle: 'solid',
      borderRightWidth: 3,
      borderBottomWidth: 1,
      borderLeftWidth: 3,
    },
  );
  assert.deepEqual(expand({ padding: '1 2 3 4', paddingBlock: 9 }), {
    paddingTop: 9,
    paddingBottom: 9,
    paddingRight: 2,
    paddingLeft: 4,
  });
  // border's line style is the box's; a side's only speaks when it did not
  assert.equal(
    expand({ border: '1px dashed red', borderTop: '2px solid red' })
      .borderStyle,
    'dashed',
  );
  // and a several-value colour beats the one `border` names, side by side
  assert.deepEqual(
    expand({ border: '1px solid red', borderColor: 'blue green' }),
    {
      borderWidth: 1,
      borderStyle: 'solid',
      borderColor: 'red',
      borderTopColor: 'blue',
      borderRightColor: 'green',
      borderBottomColor: 'blue',
      borderLeftColor: 'green',
    },
  );
});

test('a transition keyed by a shorthand reaches its longhands', () => {
  const style = { transition: { border: 150, padding: 200, flex: 90 } };
  assert.equal(transitionFor(style, 'borderColor'), 150);
  assert.equal(transitionFor(style, 'borderTopWidth'), 150);
  assert.equal(transitionFor(style, 'paddingTop'), 200);
  assert.equal(transitionFor(style, 'flexGrow'), 90);
  assert.equal(transitionFor(style, 'marginTop'), 0);
  // the nearest shorthand, then the longhand's own entry over all of them
  assert.equal(
    transitionFor(
      { transition: { border: 150, borderColor: 60 } },
      'borderTopColor',
    ),
    60,
  );
  assert.equal(
    transitionFor(
      { transition: { border: 150, borderColor: 60, borderTopColor: 30 } },
      'borderTopColor',
    ),
    30,
  );
});

test('a loop between two px strings travels between the numbers', () => {
  const style = expand({
    width: '10px',
    animation: { width: { to: '100px', duration: 100 } },
  });
  assert.equal(style.width, 10);
  assert.equal(
    problem({
      animation: { width: { from: '10px', to: '100px', duration: 100 } },
    }),
    null,
  );
});

test('an unknown property says what to write instead', () => {
  for (const [key, says] of [
    ['border-radius', /style names are camelCase: borderRadius/],
    ['background-color', /camelCase: backgroundColor/],
    ['font', /fontSize, fontFamily, fontWeight, fontStyle and lineHeight/],
    ['paddingHorizontal', /React Native's name; write paddingInline/],
    ['borderTopLeftRadius', /borderRadius rounds all four/],
    ['whiteSpace', /textWrap: 'nowrap'/],
    ['bordr', /did you mean border\?/],
    ['backgroundColour', /did you mean backgroundColor\?/],
  ]) {
    assert.match(problem({ [key]: 1 }) ?? '(none)', says, key);
  }
  // nothing near is better unanswered than guessed at
  assert.equal(
    problem({ frobnicate: 1 }),
    'react-x11: unknown style property "frobnicate" in <box style>',
  );
});

test('every length the grammar reads is one the display scale multiplies', () => {
  assert.deepEqual([...SCALED_LENGTH_PROPS], [...LENGTH_FORMS.keys()]);
  for (const key of LENGTH_FORMS.keys()) assert.ok(isStyleProp(key), key);
});

async function mount(element, { scale = 1 } = {}) {
  const app = createMockApp();
  const root = await createRoot({ app, scale });
  root.render(element);
  await tick();
  const wnd = app.windows[0];
  flushFrames(wnd);
  await tick();
  return { root, node: wnd._reactX11Node };
}

const rect = (r) => [r.x, r.y, r.width, r.height];

test('a shorthand lays out as its longhands do, and a px string as its number at 2x', async () => {
  const tree = (style) =>
    h(
      'window',
      { title: 't', width: 400, height: 300 },
      h(
        'box',
        { style: { ...style, width: 200, height: 100 } },
        h('box', { style: { flexGrow: 1 } }),
      ),
    );
  for (const scale of [1, 2]) {
    const inner = async (style) => {
      const { root, node } = await mount(tree(style), { scale });
      const r = rect(node.children[0].children[0].abs);
      await root.unmount();
      return r;
    };
    const longhand = await inner({
      paddingTop: 10,
      paddingRight: 20,
      paddingBottom: 10,
      paddingLeft: 20,
      borderWidth: 2,
      borderColor: '#000',
      marginTop: 4,
      marginLeft: 6,
    });
    assert.deepEqual(
      await inner({
        padding: '10px 20px',
        border: '2px solid #000',
        marginBlock: '4px 0',
        // one value, read by the funnel rather than a shorthand's reader
        marginLeft: '6px',
      }),
      longhand,
      `at ${scale}x`,
    );
    const s = scale;
    assert.deepEqual(longhand, [28 * s, 16 * s, 156 * s, 76 * s], `at ${s}x`);
  }
});

test('a token inside a shorthand resolves before it expands', async () => {
  const { root, node } = await mount(
    h(
      'window',
      {
        title: 't',
        width: 200,
        height: 100,
        theme: { line: '#123456', gutter: 6 },
      },
      h('box', { style: { border: '1px solid $line', padding: '$gutter 0' } }),
    ),
  );
  const style = node.children[0].style;
  assert.equal(style.borderColor, '#123456');
  assert.equal(style.borderWidth, 1);
  assert.equal(style.paddingTop, 6);
  assert.equal(style.paddingLeft, 0);
  await root.unmount();
});

test('border: … paints the pixels its longhands paint', async (t) => {
  const W = 120;
  const H = 80;
  const server = xserver.createServer({ width: 400, height: 400 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const app = await createClient({ stream: clientEnd });
  const x11Root = await createRoot({ app });
  t.after(async () => {
    await x11Root.unmount();
    await app.close();
  });
  const settle = () =>
    new Promise((resolve, reject) =>
      app.X.GetInputFocus((err) => (err ? reject(err) : resolve())),
    );
  const paint = async (style) => {
    const wnd = await new Promise((resolve) =>
      x11Root.render(
        h(
          'window',
          { width: W, height: H, style: { backgroundColor: '#ffffff' } },
          h('box', {
            style: { ...style, margin: 10, width: 80, height: 50 },
          }),
        ),
        resolve,
      ),
    );
    const root = wnd._reactX11Node;
    root.invalidate(false);
    root._scheduled = false;
    root.flush();
    await settle();
    return new Promise((resolve, reject) =>
      root._ctx.getImageData(0, 0, W, H, (err, data) =>
        err ? reject(err) : resolve(Buffer.from(data.data)),
      ),
    );
  };
  const longhand = await paint({
    borderWidth: 3,
    borderStyle: 'dashed',
    borderColor: '#d03030',
    borderBottomWidth: 6,
    borderBottomColor: '#3050d0',
    backgroundColor: '#f0e0a0',
  });
  const shorthand = await paint({
    border: '3px dashed #d03030',
    borderBottom: '6px #3050d0',
    background: '#f0e0a0',
  });
  // the premise: something was drawn
  assert.ok(longhand.some((v, i) => i % 4 !== 3 && v !== 255));
  assert.ok(shorthand.equals(longhand));
});

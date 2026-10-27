// `<textinput mask>`: a field that draws its text as one character per
// character of its own, as a browser's password field does.
//
// Against node-x11's in-process server with a real face, because the mask
// is something drawn: the mock connection has no fonts, every layout is
// null, and a field that drew its secret would pass there.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import React from 'react';

import {
  act,
  cleanup,
  fireEvent,
  renderX11,
  userEvent,
} from '../src/testing/index.js';
import { XK_BACKSPACE, XK_LEFT } from '../src/keysyms.js';
import { textStateOf } from '../src/a11y.js';

const h = React.createElement;
const require = createRequire(import.meta.url);
const katex = join(
  dirname(require.resolve('katex/package.json')),
  'dist',
  'fonts',
);
const FONTS = { 'Test Main': join(katex, 'KaTeX_Main-Regular.ttf') };

const W = 320;
const H = 200;
const DOT = '•';

afterEach(cleanup);

const scene = (...children) =>
  h(
    'window',
    {
      title: 'masked field',
      width: W,
      height: H,
      theme: { fontFamily: 'Test Main', fontSize: 16, text: '#000000' },
      style: { backgroundColor: '#ffffff', padding: 10, gap: 10 },
    },
    ...children,
  );

const mount = (element) =>
  renderX11(element, { fonts: FONTS, wrap: false, width: W, height: H });

const field = (ref, props) =>
  h('textinput', { ref, style: { width: 260 }, ...props });

/** The RGBA bytes inside a node's box. */
function pixelsOf(ctx, node) {
  const { x, y, width, height } = node.abs;
  return new Promise((resolve, reject) =>
    ctx.getImageData(
      Math.round(x),
      Math.round(y),
      Math.round(width),
      Math.round(height),
      (err, image) => (err ? reject(err) : resolve(Buffer.from(image.data))),
    ),
  );
}

async function press(node, keysym, modifiers) {
  fireEvent.key(keysym, { target: node, ...(modifiers && { modifiers }) });
  await act();
}

test('a masked field draws what a field of the mask draws', async () => {
  const masked = React.createRef();
  const plain = React.createRef();
  const { ctx } = await mount(
    scene(
      field(masked, { defaultValue: 'pa ss', mask: DOT }),
      field(plain, { defaultValue: DOT.repeat(5) }),
    ),
  );
  assert.equal(masked.current.value, 'pa ss', 'the value is the field’s');
  assert.deepEqual(
    await pixelsOf(ctx, masked.current),
    await pixelsOf(ctx, plain.current),
  );
});

test('the mask is one code point a code point, whatever the prop holds', async () => {
  const input = React.createRef();
  await mount(scene(field(input, { defaultValue: 'a😀b', mask: '*#' })));
  const node = input.current;
  assert.equal(node._displayValue(), '***');
  // the indices of the two strings are one space: the caret at the end of
  // the value is at the end of what is drawn
  assert.equal(
    node.textCaretRect(3).x,
    node.textCaretRect(node._chars().length).x,
  );
  assert.ok(node.textCaretRect(3).x > node.textCaretRect(0).x);
});

test('what is typed is the value, and is never laid out', async () => {
  const input = React.createRef();
  const seen = [];
  const result = await mount(
    scene(
      field(input, {
        mask: DOT,
        onChange: (ev) => seen.push(ev.value),
      }),
    ),
  );
  const fonts = result.app.fonts;
  const layout = fonts.layout;
  const laidOut = [];
  fonts.layout = function (text, ...rest) {
    laidOut.push(
      typeof text === 'string' ? text : text.map((run) => run.text).join(''),
    );
    return layout.call(this, text, ...rest);
  };
  try {
    await userEvent.type(input.current, 'Qz9');
  } finally {
    fonts.layout = layout;
  }
  assert.equal(input.current.value, 'Qz9');
  assert.deepEqual(seen, ['Q', 'Qz', 'Qz9']);
  assert.ok(laidOut.length > 0, 'the field was drawn as it was typed into');
  for (const text of laidOut) {
    assert.ok(!/[Qz9]/.test(text), `laid out ${text}`);
  }
});

test('an assistive technology reads the mask', async () => {
  const input = React.createRef();
  await mount(scene(field(input, { defaultValue: 'hunter2', mask: DOT })));
  const state = textStateOf(input.current);
  assert.equal(state.chars.join(''), DOT.repeat(7));
  assert.equal(state.caret, 7);
});

test('the word keys and a double click take a masked field as one word', async () => {
  const input = React.createRef();
  await mount(scene(field(input, { defaultValue: 'ab cd ef', mask: DOT })));
  const node = input.current;
  await userEvent.click(node);
  node.setSelectionRange(8, 8);

  await press(node, XK_LEFT, ['Control']);
  assert.equal(node.selectionStart, 0, 'Ctrl+Left goes to the start');

  fireEvent.doubleClick(node);
  await act();
  assert.deepEqual([node.selectionStart, node.selectionEnd], [0, 8]);

  node.setSelectionRange(5, 5);
  await press(node, XK_BACKSPACE, ['Control']);
  assert.equal(node.value, ' ef', 'Ctrl+Backspace takes all before it');
});

test('an undo takes back what was typed, spaces and all', async () => {
  const input = React.createRef();
  await mount(scene(field(input, { mask: DOT })));
  const node = input.current;
  await userEvent.type(node, 'ab cd');
  await press(node, 0x7a /* z */, ['Control']);
  assert.equal(node.value, '', 'one run, where the words would be two');
});

test('a field unmasked draws its text', async () => {
  const input = React.createRef();
  const plain = React.createRef();
  const tree = (mask) =>
    scene(
      field(input, { value: 'pass', mask }),
      field(plain, { value: 'pass' }),
    );
  const result = await mount(tree(DOT));
  assert.notDeepEqual(
    await pixelsOf(result.ctx, input.current),
    await pixelsOf(result.ctx, plain.current),
  );
  await act(() => result.rerender(tree(undefined)));
  assert.deepEqual(
    await pixelsOf(result.ctx, input.current),
    await pixelsOf(result.ctx, plain.current),
  );
});

test('a <textarea> takes no mask', async () => {
  const area = React.createRef();
  await mount(
    scene(h('textarea', { ref: area, defaultValue: 'a\nb', mask: DOT })),
  );
  assert.equal(area.current._displayValue(), 'a\nb');
});

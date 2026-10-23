// A field's selection, read and set from outside it (src/nodes/
// fieldselection.js): the DOM's `selectionStart`, `selectionEnd`,
// `selectionDirection`, `setSelectionRange()` and `select()` on
// <textinput> and <textarea>.
//
// Against node-x11's in-process server with a real face, because the
// selection is something drawn: the mock connection has no fonts, every
// layout is null, and a highlight that never reached the screen would pass
// there.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import React from 'react';

import {
  act,
  cleanup,
  countPixels,
  fireEvent,
  renderX11,
} from '../src/testing/index.js';
import { XK_BACKSPACE, XK_LEFT, XK_UP } from '../src/keysyms.js';

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
/** An opaque highlight, so what is lit can be counted. */
const LIT = '#ff0000';

afterEach(cleanup);

const scene = (...children) =>
  h(
    'window',
    {
      title: 'field selection',
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
  h('textinput', {
    ref,
    selectionColor: LIT,
    style: { width: 260 },
    ...props,
  });

/** The pixels of the highlight inside a node's box. */
const litIn = (ctx, node) =>
  countPixels(
    ctx,
    {
      x: Math.round(node.abs.x),
      y: Math.round(node.abs.y),
      width: Math.round(node.abs.width),
      height: Math.round(node.abs.height),
    },
    LIT,
    24,
  );

/** Press a key at the focused node, through the server. */
async function press(node, keysym, modifiers) {
  fireEvent.key(keysym, { target: node, ...(modifiers && { modifiers }) });
  await act();
}

test('setSelectionRange sets what the getters read, in UTF-16 code units', async () => {
  const input = React.createRef();
  await mount(scene(field(input, { defaultValue: 'a😀b cd' })));
  const node = input.current;

  // a field starts with its caret at the end of its value
  assert.equal(node.selectionStart, node.value.length);
  assert.equal(node.selectionEnd, node.value.length);
  assert.equal(node.selectionDirection, 'none');

  node.setSelectionRange(1, 3);
  assert.equal(node.selectionStart, 1);
  assert.equal(node.selectionEnd, 3);
  assert.equal(
    node.value.slice(node.selectionStart, node.selectionEnd),
    '😀',
    'the offsets slice the value, as a DOM input’s do',
  );

  // between the halves of a surrogate pair is the character's start
  node.setSelectionRange(2, 4);
  assert.deepEqual([node.selectionStart, node.selectionEnd], [1, 4]);

  // clamped to the value, and a start past the end moved back to it
  node.setSelectionRange(-5, 99);
  assert.deepEqual([node.selectionStart, node.selectionEnd], [0, 7]);
  node.setSelectionRange(6, 4);
  assert.deepEqual([node.selectionStart, node.selectionEnd], [4, 4]);
  node.setSelectionRange(NaN, 1.9);
  assert.deepEqual([node.selectionStart, node.selectionEnd], [0, 1]);
});

test('the setters are the DOM’s', async () => {
  const input = React.createRef();
  await mount(scene(field(input, { defaultValue: 'abcdefgh' })));
  const node = input.current;

  node.setSelectionRange(2, 4);
  node.selectionStart = 6;
  assert.deepEqual(
    [node.selectionStart, node.selectionEnd],
    [6, 6],
    'a start past the end takes the end with it',
  );
  node.selectionEnd = 3;
  assert.deepEqual(
    [node.selectionStart, node.selectionEnd],
    [3, 3],
    'an end before the start takes the start back to it',
  );
  node.selectionStart = 1;
  node.selectionEnd = 5;
  node.selectionDirection = 'backward';
  assert.deepEqual(
    [node.selectionStart, node.selectionEnd, node.selectionDirection],
    [1, 5, 'backward'],
  );
  node.select();
  assert.deepEqual(
    [node.selectionStart, node.selectionEnd, node.selectionDirection],
    [0, 8, 'none'],
  );
});

test('the direction is where the caret is, and the user moves it on from there', async () => {
  const input = React.createRef();
  await mount(scene(field(input, { defaultValue: 'abcdefgh' })));
  const node = input.current;
  node.focus();
  await act();

  node.setSelectionRange(2, 5, 'backward');
  assert.equal(node.selectionDirection, 'backward');
  // Shift+Left extends from the start, where a backward selection's caret is
  await press(node, XK_LEFT, ['Shift']);
  assert.deepEqual(
    [node.selectionStart, node.selectionEnd, node.selectionDirection],
    [1, 5, 'backward'],
  );

  node.setSelectionRange(2, 5, 'forward');
  await press(node, XK_LEFT, ['Shift']);
  assert.deepEqual(
    [node.selectionStart, node.selectionEnd, node.selectionDirection],
    [2, 4, 'forward'],
    'and from the end, where a forward one’s is',
  );

  // 'none' reads back until the user moves an end
  node.setSelectionRange(2, 5);
  assert.equal(node.selectionDirection, 'none');
  await press(node, XK_LEFT, ['Shift']);
  assert.equal(node.selectionDirection, 'forward');
});

test('a selection set from outside is the one an edit acts on', async () => {
  const input = React.createRef();
  const changes = [];
  await mount(
    scene(
      field(input, {
        defaultValue: 'copy this link',
        onChange: (ev) => changes.push(ev.value),
      }),
    ),
  );
  const node = input.current;
  node.focus();
  await act();

  node.setSelectionRange(5, 10);
  await press(node, XK_BACKSPACE);
  assert.equal(node.value, 'copy link');
  assert.deepEqual(changes, ['copy link']);
  assert.deepEqual([node.selectionStart, node.selectionEnd], [5, 5]);

  // and the caret the user left is what is read back
  await press(node, XK_LEFT);
  assert.deepEqual([node.selectionStart, node.selectionEnd], [4, 4]);
  assert.equal(node.selectionDirection, 'none');

  // Ctrl+Z puts the text back; the selection set from outside started a
  // new undo step, so the deletion is undone alone
  assert.equal(node.undo(), true);
  assert.equal(node.value, 'copy this link');
});

test('it is drawn while the field has the focus', async () => {
  const input = React.createRef();
  const { ctx } = await mount(
    scene(field(input, { defaultValue: 'https://example.com/a' })),
  );
  const node = input.current;

  node.select();
  await act();
  assert.equal(
    await litIn(ctx, node),
    0,
    'a field with no focus draws no selection, as a browser’s does',
  );

  node.focus();
  await act();
  const lit = await litIn(ctx, node);
  assert.ok(lit > 200, `focused, the selection is drawn (${lit} px)`);

  node.setSelectionRange(0, 0);
  await act();
  assert.equal(await litIn(ctx, node), 0, 'and a bare caret lights nothing');
});

test('it takes the visible selection, and never PRIMARY', async () => {
  const input = React.createRef();
  const surface = React.createRef();
  const { app } = await mount(
    scene(
      field(input, { defaultValue: 'in the field' }),
      h(
        'box',
        { ref: surface, selectable: true, style: { width: 300 } },
        h('text', null, 'in the document'),
      ),
    ),
  );
  const writes = [];
  const write = app.clipboard.write.bind(app.clipboard);
  app.clipboard.write = (data, options) => {
    writes.push(options?.selection);
    return write(data, options);
  };

  surface.current.selectAll();
  await act();
  writes.length = 0;
  assert.equal(surface.current.textSelection.isCollapsed, false);

  // set while the field has no focus: nothing of it is drawn, so the
  // document keeps its selection
  input.current.select();
  await act();
  assert.equal(surface.current.textSelection.isCollapsed, false);

  // and once it is focused it is the one lit range
  input.current.focus();
  await act();
  assert.equal(
    surface.current.textSelection.isCollapsed,
    true,
    'the document goes dark when the field’s selection is drawn',
  );

  input.current.setSelectionRange(3, 6);
  await act();
  assert.deepEqual(
    writes,
    [],
    'a selection the user did not make leaves PRIMARY as the user left it',
  );
});

test('a <textarea> takes it too, across lines', async () => {
  const area = React.createRef();
  const { ctx } = await mount(
    scene(
      h('textarea', {
        ref: area,
        rows: 3,
        selectionColor: LIT,
        defaultValue: 'first line\nsecond line\nthird',
        style: { width: 260 },
      }),
    ),
  );
  const node = area.current;
  node.focus();
  await act();

  node.setSelectionRange(6, 17);
  assert.equal(
    node.value.slice(node.selectionStart, node.selectionEnd),
    'line\nsecond',
  );
  await act();
  assert.ok((await litIn(ctx, node)) > 200, 'drawn on both lines');

  // a caret put somewhere is where Up goes on from: no goal column is kept
  // from before it
  node.setSelectionRange(26, 26);
  await press(node, XK_UP);
  const up = node.selectionStart;
  assert.ok(
    up > 11 && up < 23,
    `Up from the third line lands on the second (${up})`,
  );
});

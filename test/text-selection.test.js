// Selection over read-only text (#259): the geometry a `<text>` answers, and
// the document selection built on it.
//
// Everything here runs against node-x11's in-process X server with a real
// font, because there is no cheaper way to be right. The mock connection has
// no font manager, so a `<text>` measures 0×0, every layout is null and every
// accessor answers its fallback — a suite written there would pass against an
// implementation that returns zeroes.
//
// The three acceptance criteria in the issue are the three groups below:
// character geometry is public, a surface selects across elements, and two
// surfaces cannot both be showing a selection.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import React from 'react';

import { act, cleanup, fireEvent, renderX11 } from '../src/testing/index.js';
import { keysymOf } from '../src/keysyms.js';
import {
  hooks as a11yHooks,
  hasTextInterface,
  textStateOf,
} from '../src/a11y.js';

const h = React.createElement;
const require = createRequire(import.meta.url);
const katex = join(
  dirname(require.resolve('katex/package.json')),
  'dist',
  'fonts',
);
const FONTS = {
  'Test Main': join(katex, 'KaTeX_Main-Regular.ttf'),
  'Test Bold': join(katex, 'KaTeX_Main-Bold.ttf'),
};

const W = 320;
const H = 240;

afterEach(cleanup);

/** A window whose text is set in the one face this server has. */
const scene = (...children) =>
  h(
    'window',
    {
      title: 'selection',
      width: W,
      height: H,
      theme: { fontFamily: 'Test Main', fontSize: 16, text: '#000000' },
      style: { backgroundColor: '#ffffff' },
    },
    ...children,
  );

const mount = (element) =>
  renderX11(element, { fonts: FONTS, wrap: false, width: W, height: H });

/**
 * Drag the pointer, and wait for the motion to arrive.
 *
 * ntk coalesces `mousemove` onto its frame clock — a burst of pointer steps
 * is one event per frame — and the harness's `act()` runs react-x11's paint
 * frame rather than ntk's, so a move injected between two `act()`s is still
 * sitting in the coalescing buffer when the assertions run. The timer is
 * what lets ntk's own frame fire.
 */
async function dragTo(node, options) {
  fireEvent.mouseMove(node, options);
  await new Promise((resolve) => setTimeout(resolve, 30));
  await act();
}

const find = (node, kind, out = []) => {
  if (node.kind === kind) out.push(node);
  for (const child of node.children) find(child, kind, out);
  return out;
};

// --- gap 1: the geometry is public -----------------------------------------

test('a <text> answers for its own characters', async () => {
  const ref = React.createRef();
  const { windowNode } = await mount(
    scene(h('text', { ref, style: { width: 300 } }, 'Handgloves')),
  );
  const text = ref.current;
  assert.equal(windowNode.kind, 'window');

  assert.equal(text.textContent(), 'Handgloves');

  // the caret before the first character stands at the left of the content
  // box; the one after the last is a whole word further along
  const first = text.textCaretRect(0);
  const last = text.textCaretRect(10);
  assert.equal(first.x, text.contentBox().x);
  assert.ok(last.x > first.x + 40, `the word is ${last.x - first.x}px wide`);
  assert.ok(
    first.height > 8,
    `a caret has the height of the line: ${first.height}`,
  );
  assert.equal(first.width, 0);

  // and the hit test is its inverse, to the character
  assert.equal(text.textIndexAt(first.x, first.y + 1), 0);
  assert.equal(text.textIndexAt(last.x, first.y + 1), 10);
  const middle = text.textCaretRect(5);
  assert.equal(text.textIndexAt(middle.x, middle.y + 1), 5);
});

test('a point past the end of the text answers with the end of it', async () => {
  const ref = React.createRef();
  await mount(scene(h('text', { ref, style: { width: 300 } }, 'Handgloves')));
  const text = ref.current;
  assert.equal(text.textIndexAt(text.abs.x + 10_000, text.abs.y), 10);
  assert.equal(text.textIndexAt(text.abs.x - 10_000, text.abs.y), 0);
});

test('the index space is code points, not UTF-16 units', async () => {
  const ref = React.createRef();
  await mount(scene(h('text', { ref, style: { width: 300 } }, 'ab\u{1d400}c')));
  const text = ref.current;
  // 'ab' + one astral character + 'c' — four positions, five code units
  assert.equal(text.textContent().length, 5);
  assert.ok(text.textCaretRect(4).x > text.textCaretRect(3).x);
  assert.equal(text.textCaretRect(5).x, text.textCaretRect(4).x, 'clamped');
});

test('a highlight over a wrapped range is one band per line', async () => {
  const ref = React.createRef();
  await mount(
    scene(
      h(
        'text',
        { ref, style: { width: 90, fontSize: 16 } },
        'Handgloves and mittens',
      ),
    ),
  );
  const text = ref.current;
  const rects = text.textRangeRects(0, text.textContent().length);
  assert.ok(rects.length >= 2, `wrapped to ${rects.length} bands`);
  const box = text.contentBox();
  for (const rect of rects) {
    assert.ok(rect.width > 0 && rect.height > 0);
    assert.ok(rect.x >= box.x - 1, 'inside the content box');
  }
  // the bands stack: each one starts where the last ended, so a selection
  // across a wrap has no gap in it
  for (let i = 1; i < rects.length; i++) {
    assert.ok(
      rects[i].y >= rects[i - 1].y + rects[i - 1].height - 1,
      'the next line is below the one before it',
    );
  }
  assert.deepStrictEqual(text.textRangeRects(3, 3), [], 'an empty range');
});

// The case a single caret-x-to-caret-x rectangle gets wrong. Inside an RTL
// run the later character is the one further *left*, so a highlight that
// interpolates between two caret positions covers the characters nobody
// selected — and a run boundary is where a logical index stops being a
// visual one.
test('a bidi line highlights the characters, not the span between them', async () => {
  const ref = React.createRef();
  await mount(scene(h('text', { ref, style: { width: 300 } }, 'ab אבג cd')));
  const text = ref.current;
  //           0123456789 — the Hebrew is [3, 6)
  const whole = text.textRangeRects(0, 9);
  assert.equal(whole.length, 1, 'everything selected is one band');

  const firstLetter = text.textRangeRects(3, 4);
  const lastLetter = text.textRangeRects(5, 6);
  assert.equal(firstLetter.length, 1);
  assert.equal(lastLetter.length, 1);
  assert.ok(
    lastLetter[0].x + lastLetter[0].width <= firstLetter[0].x + 0.5,
    `the third letter (x=${lastLetter[0].x}) sits left of the first ` +
      `(x=${firstLetter[0].x}): the run reads right to left`,
  );
  // and neither of them has spilled over the rest of the word
  const hebrew = text.textRangeRects(3, 6)[0];
  for (const band of [firstLetter[0], lastLetter[0]]) {
    assert.ok(band.width < hebrew.width * 0.75, 'one letter, not three');
    assert.ok(band.x >= hebrew.x - 0.5, 'inside the run');
    assert.ok(band.x + band.width <= hebrew.x + hebrew.width + 0.5);
  }
});

test('a <textinput> answers the same four questions', async () => {
  const ref = React.createRef();
  await mount(
    scene(
      h('textinput', {
        ref,
        defaultValue: 'Handgloves',
        style: { width: 200 },
      }),
    ),
  );
  const input = ref.current;
  assert.equal(input.textContent(), 'Handgloves');
  const caret = input.textCaretRect(4);
  assert.ok(caret.x > input.contentBox().x);
  assert.equal(input.textIndexAt(caret.x, caret.y + 1), 4);
  assert.equal(input.textRangeRects(0, 10).length, 1);
});

// --- gap 2: the selection model --------------------------------------------

test('a drag selects across the elements of a document', async () => {
  const surface = React.createRef();
  const { windowNode } = await mount(
    scene(
      h(
        'box',
        { ref: surface, selectable: true, style: { padding: 8, width: 300 } },
        h('text', null, 'First paragraph'),
        h('text', null, 'Second paragraph'),
      ),
    ),
  );
  const [first, second] = find(windowNode, 'text');

  fireEvent.mouseDown(first, { dx: -60 });
  await act();
  await dragTo(second, { dx: 60 });

  assert.ok(first.selectionRange, 'the first paragraph is lit');
  assert.ok(second.selectionRange, 'and so is the second');
  assert.equal(first.selectionRange.end, 15, 'to the end of the first');
  assert.equal(second.selectionRange.start, 0, 'from the start of the second');

  const text = surface.current.selectedText();
  assert.ok(
    'First paragraph'.endsWith(text.split('\n')[0]),
    `the tail of the first paragraph: ${JSON.stringify(text)}`,
  );
  assert.ok(text.endsWith('Second paragraph'), 'and all of the second');
  assert.ok(text.includes('\n'), 'two blocks are joined by a newline');

  fireEvent.mouseUp(second, { dx: 60 });
  await act();
  assert.equal(surface.current.textSelection.isCollapsed, false);
});

test('a click collapses it and a second document takes over', async () => {
  const a = React.createRef();
  const b = React.createRef();
  const { windowNode } = await mount(
    scene(
      h(
        'box',
        { ref: a, selectable: true, style: { width: 300 } },
        h('text', null, 'First document'),
      ),
      h(
        'box',
        { ref: b, selectable: true, style: { width: 300 } },
        h('text', null, 'Second document'),
      ),
    ),
  );
  const [first, second] = find(windowNode, 'text');

  a.current.selectAll();
  await act();
  assert.ok(first.selectionRange, 'the first document is lit');

  b.current.selectAll();
  await act();
  assert.ok(second.selectionRange, 'the second is lit');
  assert.equal(first.selectionRange, null, 'and the first is not');
  assert.equal(a.current.textSelection.isCollapsed, true);
});

test('a double click takes the word under it, a triple the block', async () => {
  const surface = React.createRef();
  const { windowNode } = await mount(
    scene(
      h(
        'box',
        { ref: surface, selectable: true, style: { width: 300 } },
        h('text', null, 'alpha beta gamma'),
      ),
    ),
  );
  const [text] = find(windowNode, 'text');
  const point = text.textCaretRect(8); // inside "beta"

  fireEvent.mouseDown(text, {
    dx: point.x - (text.abs.x + text.abs.width / 2),
  });
  fireEvent.mouseUp(text);
  fireEvent.mouseDown(text, {
    dx: point.x - (text.abs.x + text.abs.width / 2),
  });
  await act();
  assert.deepStrictEqual(
    text.selectionRange,
    { start: 6, end: 10 },
    `"${surface.current.selectedText()}" is the word`,
  );
  fireEvent.mouseUp(text);
  fireEvent.mouseDown(text, {
    dx: point.x - (text.abs.x + text.abs.width / 2),
  });
  await act();
  assert.deepStrictEqual(
    text.selectionRange,
    { start: 0, end: 16 },
    'a third click takes the whole block',
  );
  fireEvent.mouseUp(text);
  await act();
});

test('cells are joined with tabs and rows with newlines', async () => {
  const surface = React.createRef();
  const row = (...cells) =>
    h('box', { style: { flexDirection: 'row' } }, ...cells);
  await mount(
    scene(
      h(
        'box',
        { ref: surface, selectable: true, style: { width: 300 } },
        row(
          h('text', { style: { width: 100 } }, 'name'),
          h('text', { style: { width: 100 } }, 'size'),
        ),
        row(
          h('text', { style: { width: 100 } }, 'notes'),
          h('text', { style: { width: 100 } }, '4kB'),
        ),
      ),
    ),
  );
  surface.current.selectAll();
  await act();
  assert.equal(surface.current.selectedText(), 'name\tsize\nnotes\t4kB');
});

test('selectable={false} keeps a subtree out of the text and the gestures', async () => {
  const surface = React.createRef();
  const { windowNode } = await mount(
    scene(
      h(
        'box',
        { ref: surface, selectable: true, style: { width: 300 } },
        h('box', { style: { flexDirection: 'row' } }, [
          h('text', { key: 'marker', selectable: false }, '1. '),
          h('text', { key: 'item' }, 'the item'),
        ]),
      ),
    ),
  );
  surface.current.selectAll();
  await act();
  assert.equal(surface.current.selectedText(), 'the item');
  const [marker] = find(windowNode, 'text');
  assert.equal(marker.selectionRange, null, 'the marker is never lit');

  // and a press that lands on it starts nothing — the selection made above
  // is still the one on screen after a drag across the marker
  surface.current.clearSelection();
  await act();
  fireEvent.mouseDown(marker);
  await dragTo(marker, { dx: 40 });
  assert.equal(surface.current.textSelection.isCollapsed, true);
  fireEvent.mouseUp(marker);
});

test('Ctrl+A selects the surface and Ctrl+C copies it', async () => {
  const surface = React.createRef();
  const copied = [];
  const { app } = await mount(
    scene(
      h(
        'box',
        { ref: surface, selectable: true, style: { width: 300 } },
        h('text', null, 'copy me'),
      ),
    ),
  );
  app.clipboard.write = (data, options) => {
    copied.push([options.selection, data]);
    return Promise.resolve();
  };

  surface.current.focus();
  await act();
  fireEvent.key(keysymOf('a'), { modifiers: ['Control'] });
  await act();
  assert.equal(surface.current.selectedText(), 'copy me');
  assert.deepStrictEqual(copied.at(-1), ['PRIMARY', 'copy me'], 'and PRIMARY');

  fireEvent.key(keysymOf('c'), { modifiers: ['Control'] });
  await act();
  assert.deepStrictEqual(copied.at(-1), ['CLIPBOARD', 'copy me']);
});

test('onSelectionChange reports what is selected', async () => {
  const surface = React.createRef();
  const seen = [];
  await mount(
    scene(
      h(
        'box',
        {
          ref: surface,
          selectable: true,
          onSelectionChange: (ev) => seen.push(ev.text),
          style: { width: 300 },
        },
        h('text', null, 'watch this'),
      ),
    ),
  );
  surface.current.selectAll();
  await act();
  assert.deepStrictEqual(seen, ['watch this']);
  surface.current.clearSelection();
  await act();
  assert.deepStrictEqual(seen, ['watch this', '']);
});

// --- gap 3: one visible selection ------------------------------------------

test('a document taking the selection collapses the field beside it', async () => {
  const surface = React.createRef();
  const input = React.createRef();
  await mount(
    scene(
      h('textinput', { ref: input, defaultValue: 'in the field' }),
      h(
        'box',
        { ref: surface, selectable: true, style: { width: 300 } },
        h('text', null, 'in the document'),
      ),
    ),
  );
  input.current.focus();
  input.current._selectAll();
  await act();
  assert.notEqual(
    input.current._selection()[0],
    input.current._selection()[1],
    'the field has a selection',
  );

  surface.current.selectAll();
  await act();
  assert.equal(
    input.current._selection()[0],
    input.current._selection()[1],
    'and gives it up when the document takes one',
  );
});

test('a field taking the selection clears the document', async () => {
  const surface = React.createRef();
  const input = React.createRef();
  const { windowNode } = await mount(
    scene(
      h('textinput', { ref: input, defaultValue: 'in the field' }),
      h(
        'box',
        { ref: surface, selectable: true, style: { width: 300 } },
        h('text', null, 'in the document'),
      ),
    ),
  );
  surface.current.selectAll();
  await act();
  const [text] = find(windowNode, 'text');
  assert.ok(text.selectionRange, 'the document is lit');

  input.current.focus();
  input.current._selectAll();
  await act();
  assert.equal(
    text.selectionRange,
    null,
    'and goes dark when the field takes one',
  );
  assert.equal(surface.current.textSelection.isCollapsed, true);
});

test('a <textinput> inside a document keeps its own selection', async () => {
  const surface = React.createRef();
  const input = React.createRef();
  await mount(
    scene(
      h(
        'box',
        { ref: surface, selectable: true, style: { width: 300 } },
        h('text', null, 'around it'),
        h('textinput', { ref: input, defaultValue: 'inside it' }),
      ),
    ),
  );
  surface.current.selectAll();
  await act();
  assert.equal(
    surface.current.selectedText(),
    'around it',
    'the field is not part of the document',
  );

  // and a press in the field is the field's, not the document's
  surface.current.clearSelection();
  await act();
  fireEvent.mouseDown(input.current);
  await dragTo(input.current, { dx: 20 });
  assert.equal(surface.current.textSelection.isCollapsed, true);
  fireEvent.mouseUp(input.current);
});

// --- what an assistive technology hears -------------------------------------

test('the selection a document shows is the one a screen reader reads', async () => {
  const surface = React.createRef();
  const heard = [];
  const { windowNode } = await mount(
    scene(
      h(
        'box',
        { ref: surface, selectable: true, style: { width: 300 } },
        h('text', null, 'alpha beta'),
      ),
    ),
  );
  const [text] = find(windowNode, 'text');
  // a `<text>` has always had the AT-SPI text interface; what it never had
  // was a selection to report through it
  assert.equal(hasTextInterface(text), true);
  assert.deepStrictEqual(textStateOf(text).selection, [0, 0]);

  a11yHooks.textState = (node) => heard.push(node);
  try {
    surface.current.setSelection(
      { node: text, index: 6 },
      { node: text, index: 10 },
    );
    await act();
    assert.deepStrictEqual(textStateOf(text).selection, [6, 10]);
    assert.equal(textStateOf(text).caret, 10, 'the caret follows the focus');
    assert.ok(heard.includes(text), 'and the change was pushed, not polled');

    heard.length = 0;
    surface.current.clearSelection();
    await act();
    assert.deepStrictEqual(textStateOf(text).selection, [0, 0]);
    assert.ok(heard.includes(text), 'unlighting is a change too');
  } finally {
    a11yHooks.textState = undefined;
  }
});

// --- what it looks like ------------------------------------------------------

const readPixels = (ctx, w, h) =>
  new Promise((resolve, reject) =>
    ctx.getImageData(0, 0, w, h, (err, image) =>
      err ? reject(err) : resolve(image),
    ),
  );

/** Pixels that are neither the white background nor the black ink: the
 * highlight is a tint of the accent, so it is the only other colour. */
function tinted(image) {
  let count = 0;
  for (let i = 0; i < image.data.length; i += 4) {
    const [r, g, b] = [image.data[i], image.data[i + 1], image.data[i + 2]];
    const white = r > 250 && g > 250 && b > 250;
    const dark = r < 100 && g < 100 && b < 100;
    if (!white && !dark && b > r) count++;
  }
  return count;
}

test('the selection is painted under the glyphs', async () => {
  const surface = React.createRef();
  const { ctx } = await mount(
    scene(
      h(
        'box',
        { ref: surface, selectable: true, style: { width: 300, padding: 8 } },
        h('text', { style: { fontSize: 24 } }, 'Handgloves'),
      ),
    ),
  );
  const before = tinted(await readPixels(ctx, W, H));
  assert.equal(before, 0, 'nothing is highlighted to begin with');

  surface.current.selectAll();
  await act();
  const after = tinted(await readPixels(ctx, W, H));
  assert.ok(after > 500, `the highlight is ${after} pixels`);

  surface.current.clearSelection();
  await act();
  assert.equal(tinted(await readPixels(ctx, W, H)), 0, 'and it goes away');
});

test('a press lands on the character the accessors name', async () => {
  const surface = React.createRef();
  const { windowNode } = await mount(
    scene(
      h(
        'box',
        { ref: surface, selectable: true, style: { width: 300 } },
        h('text', null, 'alpha beta gamma'),
      ),
    ),
  );
  const [text] = find(windowNode, 'text');
  // the coordinates a mouse event carries and the ones the accessors answer
  // in are the same space, so a press aimed at a caret rect selects from
  // exactly that index
  const centre = text.abs.x + text.abs.width / 2;
  const from = text.textCaretRect(6);
  const to = text.textCaretRect(10);
  fireEvent.mouseDown(text, { dx: from.x - centre });
  await act();
  await dragTo(text, { dx: to.x - centre });
  assert.deepStrictEqual(text.selectionRange, { start: 6, end: 10 });
  assert.equal(surface.current.selectedText(), 'beta');
  fireEvent.mouseUp(text, { dx: to.x - centre });
  await act();
});

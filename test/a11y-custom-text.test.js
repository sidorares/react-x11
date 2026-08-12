// Text hooks for custom editable elements (#257): a registered element that
// holds text — a code editor, a markdown viewer, a terminal — says so on
// public API and is read by exactly the paths `<textinput>` is read by.
//
// Two tiers, and both are here because they fail differently. An **editable**
// element reports a caret and takes edits; a **read-only** one reports a
// selection and nothing else, which is the whole of what a document viewer
// with Ctrl+C needs to stop being silent.
//
// Everything registers through `react-x11/host` and subclasses
// `react-x11/node`, because the point of the issue is that a sibling package
// can do this: a test reaching into src/nodes.js would prove nothing.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import React from 'react';

import { registerElement, unregisterElement } from '../src/host.js';
import { Node } from '../src/node.js';
import {
  ATSPI_ROLE,
  ATSPI_STATE,
  atspiRoleOf,
  a11yName,
  a11yStates,
  hasTextInterface,
  textStateOf,
} from '../src/a11y.js';
import {
  cleanup,
  renderX11,
  screen,
  userEvent,
  keysymOf,
  XK_DEAD_ACUTE,
  XK_LEFT,
} from '../src/testing/index.js';

const h = React.createElement;

const hasState = (states, bit) =>
  bit < 32
    ? Boolean(states[0] & (1 << bit))
    : Boolean(states[1] & (1 << (bit - 32)));

/**
 * A miniature editor: a string, a caret, a selection, and a composition it
 * draws but has not committed — the state any real editor already holds.
 * The accessibility seam is the four members at the top; everything below
 * them is the element's own editing, which is what makes the point that the
 * seam reports state rather than owning it.
 */
class EditorNode extends Node {
  constructor(props, app) {
    super('minieditor', props, app);
    this.focusableByDefault = true;
    this.text = String(props.defaultValue ?? '');
    this.caret = this.text.length;
    this.anchor = this.caret;
    this.preedit = '';
  }

  a11yTextState() {
    const chars = Array.from(this.text);
    const composing = Array.from(this.preedit).length;
    const caret = this.caret + composing;
    // a composition replaces whatever was selected, so there is nothing
    // selected while one is open
    const [start, end] = composing
      ? [caret, caret]
      : [Math.min(this.caret, this.anchor), Math.max(this.caret, this.anchor)];
    return {
      // what is drawn, the composition included — the offsets index it
      value:
        chars.slice(0, this.caret).join('') +
        this.preedit +
        chars.slice(this.caret).join(''),
      caret,
      selectionStart: start,
      selectionEnd: end,
      editable: true,
      multiline: true,
      preedit: this.preedit ? { offset: this.caret, text: this.preedit } : null,
    };
  }

  a11yReplaceText(start, end, text) {
    const chars = Array.from(this.text);
    chars.splice(start, end - start, ...Array.from(text));
    this.text = chars.join('');
    this.caret = start + Array.from(text).length;
    this.anchor = this.caret;
    this.notifyA11yTextChanged();
    return true;
  }

  a11ySetSelection(start, end) {
    this.anchor = start;
    this.caret = end;
    this.notifyA11yTextChanged();
    return true;
  }

  // --- the element's own editing ------------------------------------------

  insert(text) {
    this.a11yReplaceText(this.caret, this.caret, text);
  }

  moveCaret(to, extend) {
    this.caret = Math.max(0, Math.min(to, Array.from(this.text).length));
    if (!extend) this.anchor = this.caret;
    this.notifyA11yTextChanged();
  }

  defaultKeyDown(ev) {
    if (ev.keysym === XK_LEFT) {
      this.moveCaret(this.caret - 1, ev.shiftKey);
      return;
    }
    if (ev.codepoint >= 0x20) this.insert(ev.key);
  }

  defaultComposition(ev) {
    if (ev.type === 'compositionEnd') {
      this.preedit = '';
      if (ev.data) this.insert(ev.data);
      else this.notifyA11yTextChanged();
      return;
    }
    this.preedit = ev.data;
    this.notifyA11yTextChanged();
  }
}

/** The tier below: a rendered document that can be selected and copied but
 * never typed into — `<Markdown>`, a code block, a log view. */
class ViewerNode extends Node {
  constructor(props, app) {
    super('minidoc', props, app);
    this.focusableByDefault = true;
    this.selection = [0, 0];
  }

  a11yTextState() {
    return {
      value: String(this.props.text ?? ''),
      selectionStart: this.selection[0],
      selectionEnd: this.selection[1],
    };
  }

  a11ySetSelection(start, end) {
    this.selection = [start, end];
    this.notifyA11yTextChanged();
    return true;
  }

  selectAll() {
    this.a11ySetSelection(0, Array.from(String(this.props.text ?? '')).length);
  }
}

/** An element that reports text and declares nothing else about itself. */
class BareNode extends Node {
  constructor(props, app) {
    super('minibare', props, app);
    this.a11yRole = 'log';
  }

  a11yTextState() {
    return { value: String(this.props.text ?? '') };
  }
}

const registered = new Set();
function register(type, definition) {
  registerElement(type, definition);
  registered.add(type);
}

function registerAll() {
  register('minieditor', {
    create: (props, app) => new EditorNode(props, app),
    semanticNames: ['defaultValue'],
    childrenAllowed: false,
  });
  register('minidoc', {
    create: (props, app) => new ViewerNode(props, app),
    semanticNames: ['text'],
    childrenAllowed: false,
  });
  register('minibare', {
    create: (props, app) => new BareNode(props, app),
    semanticNames: ['text'],
    childrenAllowed: false,
  });
}

afterEach(async () => {
  await cleanup();
  for (const type of registered) unregisterElement(type);
  registered.clear();
});

const editorOf = () => screen.all((n) => n.kind === 'minieditor')[0];

// ---------------------------------------------------------------------------
// The model: what the element is, before any of it becomes an event
// ---------------------------------------------------------------------------

test('an element that reports editable text reads as an entry', async () => {
  registerAll();
  await renderX11(
    h('minieditor', { defaultValue: 'let x = 1', style: { width: 200 } }),
    { backend: 'mock' },
  );
  const editor = editorOf();

  assert.equal(atspiRoleOf(editor), ATSPI_ROLE.ENTRY, 'entry, not unknown');
  assert.equal(hasTextInterface(editor), true);
  const states = a11yStates(editor);
  assert.ok(hasState(states, ATSPI_STATE.EDITABLE), 'editable');
  assert.ok(hasState(states, ATSPI_STATE.MULTI_LINE), 'multi-line, as it said');
  assert.ok(!hasState(states, ATSPI_STATE.SINGLE_LINE));

  const { chars, caret, selection } = textStateOf(editor);
  assert.equal(chars.join(''), 'let x = 1');
  assert.equal(caret, 9);
  assert.deepEqual(selection, [9, 9]);
});

test('a viewer is readable text without being editable', async () => {
  registerAll();
  await renderX11(h('minidoc', { text: 'one two' }), { backend: 'mock' });
  const doc = screen.all((n) => n.kind === 'minidoc')[0];

  // no role declared and nothing to type into: a document, not an entry
  assert.equal(atspiRoleOf(doc), ATSPI_ROLE.DOCUMENT_FRAME);
  assert.equal(hasTextInterface(doc), true);
  const states = a11yStates(doc);
  assert.ok(!hasState(states, ATSPI_STATE.EDITABLE), 'nothing may type here');
  // it said nothing about its shape, so neither line state is claimed
  assert.ok(!hasState(states, ATSPI_STATE.MULTI_LINE));
  assert.ok(!hasState(states, ATSPI_STATE.SINGLE_LINE));
  assert.equal(textStateOf(doc).chars.join(''), 'one two');
});

test('a declared a11yRole wins over the text default, a prop over both', async () => {
  registerAll();
  await renderX11(
    h(
      'box',
      null,
      h('minibare', { text: 'log line' }),
      h('minibare', { text: 'log line', role: 'status' }),
    ),
    { backend: 'mock' },
  );
  const [bare, overridden] = screen.all((n) => n.kind === 'minibare');
  assert.equal(atspiRoleOf(bare), ATSPI_ROLE.LOG);
  assert.equal(atspiRoleOf(overridden), ATSPI_ROLE.STATUS_BAR);
});

test('the element is not read as a label for whatever contains it', async () => {
  registerAll();
  await renderX11(
    h(
      'box',
      { role: 'button', 'aria-label': undefined },
      h('text', null, 'Body'),
      h('minieditor', { defaultValue: 'secret draft' }),
    ),
    { backend: 'mock' },
  );
  const button = screen.all((n) => n.props?.role === 'button')[0];
  assert.equal(
    a11yName(button),
    'Body',
    "a nested control's value is its own text, never its parent's name",
  );
});

test('offsets an element hands over are clamped, not trusted', async () => {
  registerAll();
  await renderX11(h('minieditor', { defaultValue: 'abc' }), {
    backend: 'mock',
  });
  const editor = editorOf();
  // a stale caret is what an editor hands over between an edit and its own
  // bookkeeping; an out-of-range answer on the wire is an AT crash
  editor.caret = 99;
  editor.anchor = -4;
  const { caret, selection } = textStateOf(editor);
  assert.equal(caret, 3);
  assert.deepEqual(selection, [0, 3]);
});

test('notifying with nobody listening costs a property read', async () => {
  registerAll();
  await renderX11(h('minieditor', { defaultValue: '' }), { backend: 'mock' });
  // no bridge, no spy: the hook slots are null and this is a no-op rather
  // than a branch the element has to write itself
  assert.doesNotThrow(() => editorOf().notifyA11yTextChanged());
});

// ---------------------------------------------------------------------------
// The feed: what an assistive technology is told, through the same spy an
// application's own suite uses
// ---------------------------------------------------------------------------

test('typing into a registered element reaches the AT as a diff', async () => {
  registerAll();
  const { at } = await renderX11(
    h('minieditor', { defaultValue: '', style: { width: 200, height: 60 } }),
    { a11y: true },
  );
  const editor = editorOf();
  await userEvent.click(editor);
  at.since();

  await userEvent.type(editor, 'hi', { skipClick: true });
  assert.deepEqual(
    at.since().map((e) => e.summary),
    // an insert carries its own caret; a caret entry is for a move that
    // edited nothing
    ['insert: "h"', 'insert: "i"'],
  );
  assert.equal(editor.text, 'hi');
});

test('a caret move with no edit is a caret event', async () => {
  registerAll();
  const { at } = await renderX11(
    h('minieditor', {
      defaultValue: 'abc',
      style: { width: 200, height: 60 },
    }),
    { a11y: true },
  );
  const editor = editorOf();
  await userEvent.click(editor);
  at.since();

  await userEvent.key(XK_LEFT, { target: editor });
  assert.deepEqual(
    at.since().map((e) => e.summary),
    ['caret: 2'],
  );
});

test('a selection an element makes is spoken, editable or not', async () => {
  registerAll();
  const { at } = await renderX11(h('minidoc', { text: 'one two' }), {
    a11y: true,
  });
  const doc = screen.all((n) => n.kind === 'minidoc')[0];
  at.since();

  doc.selectAll();
  assert.deepEqual(
    at.since().map((e) => e.summary),
    // the caret rides the far end of the selection, the pair AT-SPI's
    // TextCaretMoved + TextSelectionChanged carry
    ['caret: 7', 'selection: 0..7'],
  );
});

test('a composition a registered element draws is not text the user typed', async () => {
  registerAll();
  const { at } = await renderX11(
    h('minieditor', { defaultValue: '', style: { width: 200, height: 60 } }),
    { a11y: true },
  );
  const editor = editorOf();
  await userEvent.click(editor);
  at.since();

  // the dead key: on the screen, in nobody's value
  await userEvent.key(XK_DEAD_ACUTE, { target: editor });
  assert.deepEqual(
    at.since().map((e) => e.summary),
    ['preedit: "´"'],
  );
  assert.equal(editor.text, '', 'the value did not move');

  // the letter: one insert, of the character the sequence made
  await userEvent.key(keysymOf('e'), { target: editor });
  assert.deepEqual(
    at.since().map((e) => e.summary),
    ['preedit: cleared', 'insert: "é"'],
  );
  assert.equal(editor.text, 'é');
});

test('the audit an application would write passes over a custom editor', async () => {
  registerAll();
  const { at } = await renderX11(
    h('minieditor', {
      'aria-label': 'Source',
      defaultValue: '',
      style: { width: 200, height: 60 },
    }),
    { a11y: true },
  );
  const [stop] = at.focusables();
  assert.equal(stop.utterance, 'Source, entry');
});

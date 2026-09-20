// The Windows input method's JS half, against a fake bridge — so it runs on
// every OS, and so the thing under test is the part that has semantics: which
// composition events a tree sees, in which order, with which cursor.
//
// The contract it has to keep is not Windows': it is the renderer's, and the
// reference is `src/wayland/textinput.js` `_apply`. A `<textinput>` composing
// through IMM32 must see exactly what one composing through a Wayland
// compositor sees, or an application has to know which desktop it is on to
// handle a composition — which is the whole thing this backend exists to
// avoid.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Win32InputMethod } from '../../src/win32/ime.js';
import { createFakeApp, createFakeBridge } from './fake-bridge.js';

/**
 * A focused text field, the way the input method finds one: through the
 * window's tree, by the duck type it tests for.
 */
function setup({
  sensitive = false,
  caret = { x: 40, y: 12, height: 18 },
} = {}) {
  const bridge = createFakeBridge();
  const app = createFakeApp(bridge);
  const composed = [];

  const events = {
    _composition(phase, target, data, native, extra) {
      composed.push({ phase, data, ...(extra ?? {}) });
    },
  };

  const node = {
    kind: 'textinput',
    destroyed: false,
    value: 'ab',
    _caret: 2,
    props: { sensitive },
    defaultComposition() {},
    textCaretRect() {
      return caret ? { ...caret, width: 0 } : null;
    },
    contentBox() {
      return { x: 0, y: 0, width: 100, height: 20 };
    },
  };

  const wnd = { id: 7 };
  node.root = { window: wnd, events };
  wnd._reactX11Node = { events: { focusManager: { focused: node } } };

  const ime = new Win32InputMethod(app);
  return { app, bridge, ime, wnd, node, composed, events };
}

/** The bridge's own events, as `_route` hands them over. */
const preedit = (text, begin, end) => ({
  type: 'ime-preedit',
  text,
  a: begin,
  b: end,
});
const commit = (text) => ({ type: 'ime-commit', text });

describe('win32 input method: which field', () => {
  it('takes the IME on a focused field and puts the list at the caret', () => {
    const { bridge, ime, wnd } = setup();
    ime.sync(wnd);
    assert.equal(bridge.imeEnabled.get(7), true);
    assert.deepEqual(bridge.imeCarets, [
      { windowId: 7, x: 40, y: 12, width: 1, height: 18 },
    ]);
  });

  it('does not re-send a caret that has not moved', () => {
    const { bridge, ime, wnd } = setup();
    ime.sync(wnd);
    ime.sync(wnd);
    ime.sync(wnd);
    // Every frame calls sync; only a caret that actually moved is worth a
    // trip to the UI thread.
    assert.equal(bridge.imeCarets.length, 1);
  });

  it('follows the caret when it moves', () => {
    const { bridge, ime, wnd, node } = setup();
    ime.sync(wnd);
    node.textCaretRect = () => ({ x: 61, y: 12, width: 0, height: 18 });
    ime.sync(wnd);
    assert.equal(bridge.imeCarets.length, 2);
    assert.equal(bridge.imeCarets[1].x, 61);
  });

  it('does not offer a sensitive field to the input method', () => {
    const { bridge, ime, wnd } = setup({ sensitive: true });
    ime.sync(wnd);
    // A password is not composed, and its text is not offered to a word
    // history. Nothing was enabled, so nothing has to be turned off.
    assert.equal(bridge.imeEnabled.get(7), undefined);
    assert.equal(bridge.imeCarets.length, 0);
  });

  it('falls back to the content box when the text has no layout yet', () => {
    const { bridge, ime, wnd } = setup({ caret: null });
    ime.sync(wnd);
    // Not nothing: a list under the field beats a list in the corner of the
    // screen, which is where an IME with no rectangle puts it.
    assert.deepEqual(bridge.imeCarets, [
      { windowId: 7, x: 0, y: 0, width: 1, height: 20 },
    ]);
  });

  it('takes the IME off when the field loses focus', () => {
    const { bridge, ime, wnd } = setup();
    ime.sync(wnd);
    wnd._reactX11Node.events.focusManager.focused = null;
    ime.sync(wnd);
    assert.equal(bridge.imeEnabled.get(7), false);
  });
});

describe('win32 input method: what the tree hears', () => {
  it('starts lazily, on the first text', () => {
    const { ime, wnd, composed } = setup();
    ime.sync(wnd);
    ime.handle(preedit('n', 1, 1), wnd);
    assert.deepEqual(
      composed.map((e) => e.phase),
      ['Start', 'Update'],
      'the start must come before the first update and only once',
    );
    assert.equal(composed[1].data, 'n');
  });

  it('updates in place while the composition grows', () => {
    const { ime, wnd, composed } = setup();
    ime.sync(wnd);
    ime.handle(preedit('n', 1, 1), wnd);
    ime.handle(preedit('に', 1, 1), wnd);
    ime.handle(preedit('にほん', 3, 3), wnd);
    assert.deepEqual(
      composed.map((e) => e.phase),
      ['Start', 'Update', 'Update', 'Update'],
    );
    assert.equal(composed.at(-1).data, 'にほん');
  });

  it('carries the clause being converted as the preedit cursor', () => {
    const { ime, wnd, composed } = setup();
    ime.sync(wnd);
    // The IME is converting the second clause: UTF-16 offsets 2..4 of
    // 'にほんご' — which the tree wants as code points.
    ime.handle(preedit('にほんご', 2, 4), wnd);
    assert.deepEqual(
      { begin: composed.at(-1).cursorBegin, end: composed.at(-1).cursorEnd },
      { begin: 2, end: 4 },
    );
  });

  it('counts the cursor in code points, not code units', () => {
    const { ime, wnd, composed } = setup();
    ime.sync(wnd);
    // Two emoji are four UTF-16 code units and two code points. A backend
    // that passed the bridge's own offsets through would put the cursor
    // twice as far along as the IME meant.
    ime.handle(preedit('🙂🙃x', 4, 5), wnd);
    assert.deepEqual(
      { begin: composed.at(-1).cursorBegin, end: composed.at(-1).cursorEnd },
      { begin: 2, end: 3 },
    );
  });

  it('ends with the text the IME settled on', () => {
    const { ime, wnd, composed } = setup();
    ime.sync(wnd);
    ime.handle(preedit('にほん', 3, 3), wnd);
    // The bridge sends the commit first and the cleared preedit after it,
    // which is one WM_IME_COMPOSITION carrying both (windows/src/ime.cc).
    ime.handle(commit('日本'), wnd);
    ime.handle(preedit('', 0, 0), wnd);
    assert.deepEqual(
      composed.map((e) => e.phase),
      ['Start', 'Update', 'End'],
    );
    assert.equal(composed.at(-1).data, '日本');
    assert.equal(ime.composing, false);
  });

  it('a direct commit is still a start and an end', () => {
    const { ime, wnd, composed } = setup();
    ime.sync(wnd);
    // An emoji picker, or an IME that converts without ever showing a
    // preedit. An application hears the same pair either way, which is what
    // lets it handle a composition without knowing what produced it.
    ime.handle(commit('🙂'), wnd);
    assert.deepEqual(
      composed.map((e) => e.phase),
      ['Start', 'End'],
    );
    assert.equal(composed.at(-1).data, '🙂');
  });

  it('an emptied preedit abandons the composition', () => {
    const { ime, wnd, composed } = setup();
    ime.sync(wnd);
    ime.handle(preedit('にほ', 2, 2), wnd);
    // Escape: the IME drops what it had, with no result string.
    ime.handle(preedit('', 0, 0), wnd);
    assert.deepEqual(
      composed.map((e) => e.phase),
      ['Start', 'Update', 'End'],
    );
    assert.equal(
      composed.at(-1).data,
      '',
      'an abandoned composition inserted text',
    );
  });

  it('ime-end closes a composition nothing else closed', () => {
    const { ime, wnd, composed } = setup();
    ime.sync(wnd);
    ime.handle(preedit('に', 1, 1), wnd);
    ime.handle({ type: 'ime-end' }, wnd);
    assert.deepEqual(
      composed.map((e) => e.phase),
      ['Start', 'Update', 'End'],
    );
    assert.equal(composed.at(-1).data, '');
  });

  it('ime-end after a commit says nothing twice', () => {
    const { ime, wnd, composed } = setup();
    ime.sync(wnd);
    ime.handle(preedit('に', 1, 1), wnd);
    ime.handle(commit('二'), wnd);
    ime.handle(preedit('', 0, 0), wnd);
    ime.handle({ type: 'ime-end' }, wnd);
    // The normal flow: the commit already ended it, and WM_IME_ENDCOMPOSITION
    // arrives after. A second End would clear a preedit the field no longer
    // has and look like an abandoned composition to an application.
    assert.equal(composed.filter((e) => e.phase === 'End').length, 1);
  });

  it('losing focus mid-composition ends it with nothing', () => {
    const { ime, wnd, composed } = setup();
    ime.sync(wnd);
    ime.handle(preedit('にほ', 2, 2), wnd);
    wnd._reactX11Node.events.focusManager.focused = null;
    ime.sync(wnd);
    assert.deepEqual(
      composed.map((e) => e.phase),
      ['Start', 'Update', 'End'],
    );
    assert.equal(
      composed.at(-1).data,
      '',
      'the composition committed into a field the user had left',
    );
  });

  it('says nothing about a window with no field taken', () => {
    const { ime, wnd, composed } = setup();
    // No sync: the IME was never enabled here, so an event for it is one the
    // window has no business acting on.
    ime.handle(preedit('に', 1, 1), wnd);
    assert.deepEqual(composed, []);
  });
});

// The clipboard on the cocoa backend (src/cocoa/app.js): one pasteboard,
// `NSPasteboard.general`, and it is CLIPBOARD's.
//
// X has two selections in everyday use (docs/clipboard.md, "Two
// clipboards"): CLIPBOARD, filled by a Copy, and PRIMARY, filled by
// _selecting text at all_ and pasted with a middle click. Core takes PRIMARY
// on every selection gesture — a drag across a `selectable` surface, a
// select-all, shift+arrows in a field — because that is what selecting means
// on X11. macOS has no PRIMARY, and a shim that sent every selection name to
// the general pasteboard turned each of those gestures into a Copy: the user
// copies a link in another app, drags across a paragraph here without
// copying anything, and ⌘V pastes the paragraph.
//
// Headless, over test/helpers/cocoa-bridge.js's recording fake with a
// pasteboard modelled on it, so a test can say both what reached the native
// and what the user would find there. Input goes through the bridge's own
// event shape (`app._route`), the route a real NSEvent takes.
import assert from 'node:assert';
import { afterEach, describe, test } from 'node:test';
import React from 'react';

import { useClipboard } from '../src/index.js';
import {
  cleanupCocoa,
  fakeCocoaApp,
  mountCocoa,
  tick,
} from './helpers/cocoa-bridge.js';

const h = React.createElement;

afterEach(cleanupCocoa);

/** What the user copied in some other application, before touching ours. */
const ELSEWHERE = 'https://example.com/copied-in-another-app';

/**
 * `NSPasteboard.general` as far as the shim reaches it — one text slot —
 * installed on the fake bridge, which records every call made through it.
 */
function pasteboardOn(native, text = null) {
  const pb = { text };
  native.pasteboardWriteText = (value) => {
    pb.text = value;
  };
  native.pasteboardReadText = () => pb.text;
  native.pasteboardClear = () => {
    pb.text = null;
  };
  return pb;
}

/** Every call the shim made to the pasteboard natives, by name. */
const pasteboardCalls = (native) =>
  native.calls
    .filter((c) => c.name.startsWith('pasteboard'))
    .map((c) => c.name);

/** A bridge pointer event at the centre of `node`: points, window-relative. */
function pointerAt(node, type, extra = {}) {
  const wnd = node.root.window;
  const s = wnd.scale;
  const x = (node.abs.x + node.abs.width / 2) / s;
  const y = (node.abs.y + node.abs.height / 2) / s;
  return {
    type,
    windowNumber: wnd.windowNumber,
    x,
    y,
    gx: wnd.x / s + x,
    gy: wnd.y / s + y,
    time: performance.now(),
    ...extra,
  };
}

/** A bridge key press: `keyCode` is the kVK_* code, `chars` what it types. */
function press(app, wnd, { keyCode, chars, ...modifiers }) {
  const ev = {
    windowNumber: wnd.windowNumber,
    keyCode,
    charsBase: chars,
    charsShifted: chars,
    time: performance.now(),
    ...modifiers,
  };
  app._route({ type: 'keydown', ...ev });
  app._route({ type: 'keyup', ...ev });
}

const END = { keyCode: 119 };
const LEFT = { keyCode: 123 };
const KEY_A = { keyCode: 0, chars: 'a' };
const KEY_C = { keyCode: 8, chars: 'c' };

// --- selecting is not copying -----------------------------------------------

describe('selecting text leaves the pasteboard alone', () => {
  async function mountDocument() {
    const doc = React.createRef();
    const heading = React.createRef();
    const body = React.createRef();
    const mounted = await mountCocoa(
      h(
        'box',
        { ref: doc, selectable: true, style: { padding: 8 } },
        h('text', { ref: heading }, 'Release notes'),
        h('text', { ref: body }, 'Everything below this can be copied.'),
      ),
      { width: 400, height: 160 },
    );
    return { ...mounted, doc, heading, body };
  }

  test('a drag across a document', async () => {
    const { native, app, doc, heading, body } = await mountDocument();
    const pb = pasteboardOn(native, ELSEWHERE);

    app._route(pointerAt(heading.current, 'mousedown', { button: 1 }));
    app._route(pointerAt(body.current, 'mousemove'));
    app._route(pointerAt(body.current, 'mouseup', { button: 1 }));
    await tick();

    // the premise: the release had a selection to take PRIMARY with
    assert.equal(doc.current.textSelection.isCollapsed, false);
    assert.equal(doc.current.selectedText(), 'Release notes');

    assert.deepEqual(pasteboardCalls(native), []);
    assert.equal(pb.text, ELSEWHERE);
  });

  test('select-all, by call and by Ctrl+A — and Ctrl+C still copies', async () => {
    const { native, app, wnd, doc } = await mountDocument();
    const pb = pasteboardOn(native, ELSEWHERE);
    const everything = 'Release notes\nEverything below this can be copied.';

    doc.current.selectAll();
    await tick();
    assert.equal(doc.current.selectedText(), everything);
    assert.deepEqual(pasteboardCalls(native), []);

    doc.current.clearSelection();
    doc.current.focus();
    press(app, wnd, { ...KEY_A, control: true });
    await tick();
    assert.equal(doc.current.selectedText(), everything);
    assert.deepEqual(pasteboardCalls(native), []);
    assert.equal(pb.text, ELSEWHERE);

    // The same `copy()` the selection's own() goes through, asked for
    // CLIPBOARD this time: the one write the pasteboard should see.
    press(app, wnd, { ...KEY_C, control: true });
    await tick();
    assert.deepEqual(native.of('pasteboardWriteText'), [[everything]]);
    assert.equal(pb.text, everything);
  });

  test('shift+arrows and select-all in a field — and Ctrl+C still copies', async () => {
    const input = React.createRef();
    const { native, app, wnd } = await mountCocoa(
      h('textinput', { ref: input, defaultValue: 'hello world' }),
      { width: 300, height: 80 },
    );
    const pb = pasteboardOn(native, ELSEWHERE);
    input.current.focus();

    press(app, wnd, END);
    press(app, wnd, { ...LEFT, shift: true });
    press(app, wnd, { ...LEFT, shift: true });
    await tick();
    assert.equal(input.current._selectedText(), 'ld', 'the premise');
    assert.deepEqual(pasteboardCalls(native), []);

    press(app, wnd, { ...KEY_A, control: true });
    await tick();
    assert.equal(input.current._selectedText(), 'hello world');
    assert.deepEqual(pasteboardCalls(native), []);
    assert.equal(pb.text, ELSEWHERE);

    press(app, wnd, { ...KEY_C, control: true });
    await tick();
    assert.deepEqual(native.of('pasteboardWriteText'), [['hello world']]);
    assert.equal(pb.text, 'hello world');
  });
});

// --- and a middle click is not a paste ----------------------------------------

test('a middle click in a field pastes nothing — there is no PRIMARY to paste', async () => {
  // X11's other half of select-to-copy. Reading PRIMARY from the general
  // pasteboard made a middle click paste whatever the user last copied,
  // which no Mac text field does with one.
  const input = React.createRef();
  const changes = [];
  const { native, app } = await mountCocoa(
    h('textinput', {
      ref: input,
      defaultValue: 'abc',
      onChange: (ev) => changes.push(ev.value),
    }),
    { width: 300, height: 80 },
  );
  pasteboardOn(native, ELSEWHERE);

  app._route(pointerAt(input.current, 'mousedown', { button: 2 }));
  app._route(pointerAt(input.current, 'mouseup', { button: 2 }));
  await tick();
  await tick();

  assert.equal(input.current.value, 'abc');
  assert.deepEqual(changes, []);
});

// --- the shim itself ------------------------------------------------------------

describe('app.clipboard on cocoa', () => {
  test('PRIMARY and SECONDARY: writes resolve, reads find nothing, the pasteboard is untouched', async () => {
    const { native, app } = fakeCocoaApp();
    const pb = pasteboardOn(native, ELSEWHERE);

    for (const selection of ['PRIMARY', 'SECONDARY']) {
      await app.clipboard.write('selected here', { selection });
      await app.clipboard.write(
        { UTF8_STRING: 'selected here' },
        { selection },
      );
      assert.deepEqual(await app.clipboard.targets({ selection }), []);
      await assert.rejects(
        app.clipboard.read({ selection }),
        new RegExp(`${selection} is an X11 selection`),
      );
      await assert.rejects(
        app.clipboard.read({ selection, target: 'UTF8_STRING' }),
        new RegExp(`${selection} is an X11 selection`),
      );
      await app.clipboard.clear(selection);
    }

    assert.deepEqual(pasteboardCalls(native), []);
    assert.equal(pb.text, ELSEWHERE);
  });

  test('CLIPBOARD, named or by default, is the general pasteboard', async () => {
    const { native, app } = fakeCocoaApp();
    const pb = pasteboardOn(native, ELSEWHERE);

    assert.deepEqual(await app.clipboard.targets(), ['UTF8_STRING', 'STRING']);
    assert.equal(await app.clipboard.read(), ELSEWHERE);

    await app.clipboard.write('one');
    assert.equal(pb.text, 'one');
    await app.clipboard.write('two', { selection: 'CLIPBOARD' });
    assert.equal(pb.text, 'two');
    assert.equal(await app.clipboard.read({ selection: 'CLIPBOARD' }), 'two');
    assert.deepEqual(
      await app.clipboard.read({ target: 'UTF8_STRING' }),
      Buffer.from('two'),
    );

    await app.clipboard.clear('CLIPBOARD');
    assert.equal(pb.text, null);
    await app.clipboard.write('three');
    await app.clipboard.clear();
    assert.equal(pb.text, null);
    assert.deepEqual(await app.clipboard.targets(), []);
  });

  test('useClipboard(): a PRIMARY write from app code resolves and changes nothing', async () => {
    // Cross-platform code that follows the X11 convention — write PRIMARY
    // whenever the selection changes — needs no platform check: on macOS
    // the write is a write to a selection nobody can paste from.
    let clipboard = null;
    function Probe() {
      clipboard = useClipboard();
      return h('box');
    }
    const { native } = await mountCocoa(h(Probe));
    const pb = pasteboardOn(native, ELSEWHERE);

    await clipboard.write('mine', { selection: 'PRIMARY' });
    await clipboard.writeText('mine', { selection: 'PRIMARY' });
    assert.equal(await clipboard.read('text', { selection: 'PRIMARY' }), null);
    await assert.rejects(
      clipboard.readText({ selection: 'PRIMARY' }),
      /PRIMARY is an X11 selection/,
    );
    assert.deepEqual(await clipboard.targets({ selection: 'PRIMARY' }), []);
    await clipboard.clear('PRIMARY');
    assert.equal(pb.text, ELSEWHERE);

    await clipboard.writeText('copied here');
    assert.equal(pb.text, 'copied here');
    assert.equal(await clipboard.read('text'), 'copied here');
  });
});

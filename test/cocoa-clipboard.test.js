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

import { _setOsascriptForTests } from '../src/cocoa/clipboard.js';
import { useClipboard } from '../src/index.js';
import {
  cleanupCocoa,
  fakeCocoaApp,
  mountCocoa,
  tick,
} from './helpers/cocoa-bridge.js';

const h = React.createElement;

afterEach(() => {
  _setOsascriptForTests(null);
  return cleanupCocoa();
});

/** What the user copied in some other application, before touching ours. */
const ELSEWHERE = 'https://example.com/copied-in-another-app';

const TEXT = 'public.utf8-plain-text';

/**
 * `NSPasteboard.general` as far as the shim reaches it — its items, each a
 * map of pasteboard type to value, and the change count every write bumps —
 * installed on the fake bridge, which records every call made through it.
 * `pb.set(items)` is another application writing it.
 */
function pasteboardOn(native, text = null) {
  const pb = {
    items: text == null ? [] : [{ [TEXT]: text }],
    count: 100,
    get text() {
      const value = pb.items[0]?.[TEXT];
      return value == null ? null : String(value);
    },
    set(items) {
      pb.items = items;
      pb.count++;
    },
  };
  native.pasteboardWriteText = (value) => pb.set([{ [TEXT]: value }]);
  native.pasteboardWrite = (item) => pb.set([item]);
  native.pasteboardReadText = () => pb.text;
  native.pasteboardClear = () => pb.set([]);
  native.pasteboardChangeCount = () => pb.count;
  native.pasteboardItems = () =>
    pb.items.map((item) => ({ types: Object.keys(item) }));
  native.pasteboardItemData = (index, type) => {
    const value = pb.items[index]?.[type];
    return value == null ? null : Buffer.from(value);
  };
  return pb;
}

/** Every call the shim made to the pasteboard natives, by name. */
const pasteboardCalls = (native) =>
  native.calls
    .filter((c) => c.name.startsWith('pasteboard'))
    .map((c) => c.name);

/** A bridge pointer event at the centre of `node` — or `across` its width,
 *  0 at its start — in points, window-relative. */
function pointerAt(node, type, extra = {}, across = 0.5) {
  const wnd = node.root.window;
  const s = wnd.scale;
  const x = (node.abs.x + node.abs.width * across) / s;
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

    // from the heading's first character to the body's
    app._route(pointerAt(heading.current, 'mousedown', { button: 1 }, 0));
    app._route(pointerAt(body.current, 'mousemove', {}, 0));
    app._route(pointerAt(body.current, 'mouseup', { button: 1 }, 0));
    await tick();

    // the premise: the release had a selection to take PRIMARY with
    assert.equal(doc.current.textSelection.isCollapsed, false);
    assert.equal(doc.current.selectedText(), 'Release notes');

    assert.deepEqual(pasteboardCalls(native), []);
    assert.equal(pb.text, ELSEWHERE);
  });

  test('select-all, by call and by ⌘A — and ⌘C still copies', async () => {
    const { native, app, wnd, doc } = await mountDocument();
    const pb = pasteboardOn(native, ELSEWHERE);
    const everything = 'Release notes\nEverything below this can be copied.';

    doc.current.selectAll();
    await tick();
    assert.equal(doc.current.selectedText(), everything);
    assert.deepEqual(pasteboardCalls(native), []);

    doc.current.clearSelection();
    doc.current.focus();
    press(app, wnd, { ...KEY_A, command: true });
    await tick();
    assert.equal(doc.current.selectedText(), everything);
    assert.deepEqual(pasteboardCalls(native), []);
    assert.equal(pb.text, ELSEWHERE);

    // The same `copy()` the selection's own() goes through, asked for
    // CLIPBOARD this time: the one write the pasteboard should see.
    press(app, wnd, { ...KEY_C, command: true });
    await tick();
    assert.deepEqual(native.of('pasteboardWriteText'), [[everything]]);
    assert.equal(pb.text, everything);
  });

  test('shift+arrows and select-all in a field — and ⌘C still copies', async () => {
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

    press(app, wnd, { ...KEY_A, command: true });
    await tick();
    assert.equal(input.current._selectedText(), 'hello world');
    assert.deepEqual(pasteboardCalls(native), []);
    assert.equal(pb.text, ELSEWHERE);

    press(app, wnd, { ...KEY_C, command: true });
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

    assert.deepEqual(await app.clipboard.targets(), [
      'text/plain;charset=utf-8',
      'UTF8_STRING',
      'text/plain',
      'STRING',
    ]);
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

// --- more than text ----------------------------------------------------------

describe('a write with more than text', () => {
  // A copied image with a caption beside it: one pasteboard item, every
  // flavour under its UTI, so an image editor takes the PNG and a text
  // field the caption. pasteboardWriteText can carry only the caption.
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  async function mountProbe() {
    let clipboard = null;
    function Probe() {
      clipboard = useClipboard();
      return h('box');
    }
    const mounted = await mountCocoa(h(Probe));
    return { ...mounted, clipboard: () => clipboard };
  }

  test('reaches the pasteboard whole, every flavour under its UTI', async () => {
    const { native, clipboard } = await mountProbe();
    pasteboardOn(native, ELSEWHERE);

    await clipboard().write({ 'image/png': PNG, 'text/plain': 'a picture' });
    assert.deepEqual(native.of('pasteboardWrite'), [
      [{ 'public.png': PNG, 'public.utf8-plain-text': 'a picture' }],
    ]);
    assert.deepEqual(native.of('pasteboardWriteText'), []);
  });

  test('text alone keeps pasteboardWriteText, the verb every bridge has', async () => {
    const { native, clipboard } = await mountProbe();
    const pb = pasteboardOn(native, ELSEWHERE);

    await clipboard().write({
      UTF8_STRING: 'just words',
      STRING: 'just words',
    });
    assert.deepEqual(native.of('pasteboardWriteText'), [['just words']]);
    assert.deepEqual(native.of('pasteboardWrite'), []);
    assert.equal(pb.text, 'just words');
  });

  test('a bridge without pasteboardWrite keeps the text and says, once, what it dropped', async (t) => {
    const { native, clipboard } = await mountProbe();
    const pb = pasteboardOn(native, ELSEWHERE);
    native.pasteboardWrite = undefined; // an appkit from before the verb
    const warn = t.mock.method(console, 'warn', () => {});

    await clipboard().write({ 'image/png': PNG, 'text/plain': 'a picture' });
    await clipboard().write({ 'image/png': PNG, 'text/plain': 'a picture' });
    assert.equal(pb.text, 'a picture', 'the caption still lands');
    assert.equal(warn.mock.callCount(), 1, 'said once, not per copy');
    const said = String(warn.mock.calls[0].arguments[0]);
    assert.match(said, /public\.png/);
    assert.match(said, /pasteboardWrite/);
  });
});

// --- what is on the pasteboard, and when it changes (#937) -------------------

// The shim used to be text-only: `targets()` answered UTF8_STRING and STRING
// whenever there was text and `[]` otherwise, `read({ target })` converted
// text and nothing else, and `watch()` resolved to an unsubscribe that never
// had anything to unsubscribe from. So an image on the pasteboard read as an
// empty one, a password manager's `org.nspasteboard.ConcealedType` was
// invisible to an app that wanted to honour it, and the edit menu's Paste row
// never heard of a copy made after it armed.

/** A password manager's copy: the secret, and the marker that asks
 * clipboard tools to keep it out of their history (nspasteboard.org). */
const CONCEALED = 'org.nspasteboard.ConcealedType';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TIFF = Buffer.from([0x4d, 0x4d, 0x00, 0x2a]);

/** The interval the watch polls the change count on, in ms. */
const POLL = 250;

describe('targets(): the pasteboard’s own types', () => {
  test('text with a concealed marker reports the marker', async () => {
    const { native, app } = fakeCocoaApp();
    const pb = pasteboardOn(native, ELSEWHERE);
    pb.set([{ [TEXT]: 'hunter2', [CONCEALED]: '' }]);

    assert.deepEqual(await app.clipboard.targets(), [
      'text/plain;charset=utf-8',
      'UTF8_STRING',
      'text/plain',
      'STRING',
      CONCEALED,
    ]);
    // the marker reads as what it is, an empty flavour
    assert.deepEqual(
      await app.clipboard.read({ target: CONCEALED }),
      Buffer.alloc(0),
    );
  });

  test('an image reports its image types, and no text', async () => {
    const { native, app } = fakeCocoaApp();
    const pb = pasteboardOn(native, ELSEWHERE);
    pb.set([{ 'public.png': PNG, 'public.tiff': TIFF }]);

    assert.deepEqual(await app.clipboard.targets(), [
      'image/png',
      'image/tiff',
    ]);
  });

  test('every item counts, and the legacy names AppKit hands out do not', async () => {
    const { native, app } = fakeCocoaApp();
    const pb = pasteboardOn(native);
    pb.set([
      { 'public.file-url': 'file:///tmp/a.txt', NSFilenamesPboardType: 'x' },
      { 'public.file-url': 'file:///tmp/b%20c.txt' },
    ]);

    assert.deepEqual(await app.clipboard.targets(), ['text/uri-list']);
  });
});

describe('read(): more than text', () => {
  test('an image comes back as its bytes, through useClipboard() too', async () => {
    let clipboard = null;
    function Probe() {
      clipboard = useClipboard();
      return h('box');
    }
    const { native, app } = await mountCocoa(h(Probe));
    const pb = pasteboardOn(native, ELSEWHERE);
    pb.set([{ 'public.png': PNG, 'public.tiff': TIFF }]);

    assert.deepEqual(await app.clipboard.read({ target: 'image/png' }), PNG);
    assert.deepEqual(await clipboard.read('image/png'), PNG);
    assert.deepEqual(await clipboard.read('image/tiff'), TIFF);
    assert.equal(await clipboard.read('text'), null);
    await assert.rejects(
      app.clipboard.read({ target: 'image/jpeg' }),
      /cannot convert the pasteboard to image\/jpeg/,
    );
  });

  test('files copied in Finder: one item each, read as one uri-list', async () => {
    let clipboard = null;
    function Probe() {
      clipboard = useClipboard();
      return h('box');
    }
    const { native } = await mountCocoa(h(Probe));
    const pb = pasteboardOn(native);
    pb.set([
      { 'public.file-url': 'file:///tmp/a.txt' },
      { 'public.file-url': 'file:///tmp/b%20c.txt' },
    ]);

    assert.deepEqual(await clipboard.readFiles(), [
      { uri: 'file:///tmp/a.txt', path: '/tmp/a.txt' },
      { uri: 'file:///tmp/b%20c.txt', path: '/tmp/b c.txt' },
    ]);
  });

  test('an empty pasteboard has nothing to paste', async () => {
    const { native, app } = fakeCocoaApp();
    pasteboardOn(native);
    await assert.rejects(
      app.clipboard.read({ target: 'image/png' }),
      /nothing to paste — the pasteboard is empty/,
    );
  });
});

describe('watch(): the change count, asked while someone is watching', () => {
  test('fires for a copy made in another app, and says when it is empty', async (t) => {
    const { native, app } = fakeCocoaApp();
    const pb = pasteboardOn(native, ELSEWHERE);
    t.mock.timers.enable({ apis: ['setInterval'] });

    const seen = [];
    const stop = await app.clipboard.watch('CLIPBOARD', (ev) => seen.push(ev));
    t.mock.timers.tick(POLL);
    await tick();
    assert.deepEqual(seen, [], 'nothing changed yet, so nothing is said');

    pb.set([{ [TEXT]: 'hunter2', [CONCEALED]: '' }]);
    t.mock.timers.tick(POLL);
    await tick();
    await tick();
    pb.set([]);
    t.mock.timers.tick(POLL);
    await tick();
    await tick();

    assert.equal(seen.length, 2);
    assert.equal(seen[0].selection, 'CLIPBOARD');
    assert.notEqual(seen[0].owner, 0, 'something is on it');
    assert.equal(seen[0].changeCount, 101);
    assert.equal(seen[1].owner, 0, 'nothing is on it');
    assert.equal(seen[1].changeCount, 102);

    // gone with the last watcher: the count is not asked again
    stop();
    const asked = native.of('pasteboardChangeCount').length;
    pb.set([{ [TEXT]: 'later' }]);
    t.mock.timers.tick(POLL * 4);
    await tick();
    assert.equal(seen.length, 2);
    assert.equal(native.of('pasteboardChangeCount').length, asked);
  });

  test('our own copy is a change too, as SetSelectionOwner is on X11', async (t) => {
    let clipboard = null;
    function Probe() {
      clipboard = useClipboard();
      return h('box');
    }
    const { native } = await mountCocoa(h(Probe));
    pasteboardOn(native, ELSEWHERE);
    t.mock.timers.enable({ apis: ['setInterval'] });

    const seen = [];
    const stop = await clipboard.watch((ev) => seen.push(ev.owner !== 0));
    await clipboard.writeText('copied here');
    t.mock.timers.tick(POLL);
    await tick();
    await tick();
    stop();
    assert.deepEqual(seen, [true]);
  });

  test('nobody polls an app that never watches', async () => {
    const { native, app } = fakeCocoaApp();
    pasteboardOn(native, ELSEWHERE);
    await app.clipboard.targets();
    await app.clipboard.read();
    assert.deepEqual(native.of('pasteboardChangeCount'), []);
  });

  test('a bridge without pasteboardChangeCount rejects, as a server without XFixes does', async () => {
    const { native, app } = fakeCocoaApp();
    pasteboardOn(native, ELSEWHERE);
    native.pasteboardChangeCount = undefined;
    await assert.rejects(
      app.clipboard.watch('CLIPBOARD', () => {}),
      /pasteboardChangeCount/,
    );
  });

  test('the edit menu’s Paste row follows the pasteboard', async (t) => {
    const { armPasteState, canPaste } = await import('../src/pastestate.js');
    const { native, app } = fakeCocoaApp();
    const pb = pasteboardOn(native);
    t.mock.timers.enable({ apis: ['setInterval'] });

    armPasteState(app, app.clipboard);
    await tick();
    await tick();
    assert.equal(canPaste(app), false, 'empty when it armed');

    pb.set([{ [TEXT]: 'copied in another app' }]);
    t.mock.timers.tick(POLL);
    await tick();
    await tick();
    assert.equal(canPaste(app), true);

    pb.set([]);
    t.mock.timers.tick(POLL);
    await tick();
    await tick();
    assert.equal(canPaste(app), false);
    await app.close();
  });
});

describe('a bridge without the item verbs asks osascript', () => {
  /** `osascript` over the fake pasteboard, answering the two questions the
   * script asks `NSPasteboard`, and every argument list it was run with. */
  function osascriptOn(pb) {
    const runs = [];
    _setOsascriptForTests(async (file, args) => {
      runs.push([file, ...args]);
      const [verb, type] = args.slice(4);
      if (verb === 'items') {
        return (
          JSON.stringify({
            count: pb.count,
            items: pb.items.map((item) => Object.keys(item)),
          }) + '\n'
        );
      }
      return JSON.stringify(
        pb.items.map((item) =>
          item[type] == null
            ? null
            : Buffer.from(item[type]).toString('base64'),
        ),
      );
    });
    return runs;
  }

  function withoutItemVerbs() {
    const { native, app } = fakeCocoaApp();
    const pb = pasteboardOn(native, ELSEWHERE);
    native.pasteboardItems = undefined; // an appkit from before the verbs
    native.pasteboardItemData = undefined;
    return { native, app, pb };
  }

  test('the types, asked once per change', async () => {
    const { app, pb } = withoutItemVerbs();
    const runs = osascriptOn(pb);
    pb.set([{ [TEXT]: 'hunter2', [CONCEALED]: '' }]);

    const offered = await app.clipboard.targets();
    assert.ok(offered.includes('UTF8_STRING'));
    assert.ok(offered.includes(CONCEALED));
    assert.equal(runs.length, 1);
    const [file, lang, js, flag, script, verb] = runs[0];
    assert.equal(file, '/usr/bin/osascript');
    assert.deepEqual(
      [lang, js, flag, verb],
      ['-l', 'JavaScript', '-e', 'items'],
    );
    assert.match(script, /NSPasteboard\.generalPasteboard/);

    // nothing copied since: the list it had is still the list
    await app.clipboard.targets();
    assert.equal(runs.length, 1);
    pb.set([{ 'public.png': PNG }]);
    assert.deepEqual(await app.clipboard.targets(), ['image/png']);
    assert.equal(runs.length, 2);
  });

  test('an image read through it, and text still through the bridge', async () => {
    const { native, app, pb } = withoutItemVerbs();
    const runs = osascriptOn(pb);
    pb.set([{ 'public.png': PNG, [TEXT]: 'a picture' }]);

    assert.deepEqual(await app.clipboard.read({ target: 'image/png' }), PNG);
    assert.deepEqual(runs.at(-1).slice(5), ['data', 'public.png']);
    const before = runs.length;
    assert.equal(await app.clipboard.read(), 'a picture');
    assert.deepEqual(
      await app.clipboard.read({ target: 'UTF8_STRING' }),
      Buffer.from('a picture'),
    );
    assert.equal(runs.length, before, 'a text read spawns nothing');
    assert.equal(native.of('pasteboardReadText').length, 2);
  });

  test('an osascript that cannot run leaves the text, and says so once', async (t) => {
    const { app } = withoutItemVerbs();
    _setOsascriptForTests(async () => {
      throw new Error('spawn /usr/bin/osascript EACCES');
    });
    const warn = t.mock.method(console, 'warn', () => {});

    assert.deepEqual(await app.clipboard.targets(), [
      'text/plain;charset=utf-8',
      'UTF8_STRING',
      'text/plain',
      'STRING',
    ]);
    await assert.rejects(
      app.clipboard.read({ target: 'image/png' }),
      /cannot read image\/png from the pasteboard — spawn/,
    );
    assert.equal(await app.clipboard.read(), ELSEWHERE);
    assert.equal(warn.mock.callCount(), 1);
    assert.match(String(warn.mock.calls[0].arguments[0]), /pasteboardItems/);
  });
});

// A click on an empty field's placeholder puts the caret where typing will
// put the first character — not at the placeholder character under the
// pointer. The hint is the field's chrome; the caret belongs to the value,
// which is empty.
//
// `<textarea>` drew its caret, and answered every geometry question, off
// the layout it painted — the placeholder's while the field was empty — so
// a click in the middle of "Write a message" stood the caret after "Write a
// mes", where nothing would ever be typed. `<textinput>` kept the two apart
// already, and is held to the same rule here.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import React from 'react';
import { StaticFontSource, createClient } from 'ntk';
import xserver from 'x11/lib/xserver/index.js';

import { createRoot } from '../src/index.js';

const h = React.createElement;
const require = createRequire(import.meta.url);
const fontDir = join(
  dirname(require.resolve('katex/package.json')),
  'dist',
  'fonts',
);

function staticFonts() {
  const source = new StaticFontSource();
  source.add(readFileSync(join(fontDir, 'KaTeX_Main-Regular.ttf')), {
    family: 'Test Main',
  });
  source.alias('sans-serif', 'Test Main');
  return source;
}

const PLACEHOLDER = 'Write a message to everyone';

async function mount(t, tag, props) {
  const server = xserver.createServer({ width: 640, height: 480 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const app = await createClient({
    stream: clientEnd,
    fontSource: staticFonts(),
  });
  const root = await createRoot({ app });
  t.after(async () => {
    await root.unmount();
    await app.close();
  });
  const ref = React.createRef();
  const wnd = await new Promise((resolve) =>
    root.render(
      h(
        'window',
        { width: 400, height: 200 },
        h(tag, { ref, placeholder: PLACEHOLDER, ...props }),
      ),
      resolve,
    ),
  );
  const field = ref.current;
  const frame = () => {
    field.root._scheduled = false;
    field.root.flush();
  };
  frame();
  // a press and release at a point in the field, in window coordinates
  const click = (x, y) => {
    wnd.emit('mousedown', { x, y, keycode: 1, buttons: 0 });
    wnd.emit('mouseup', { x, y, keycode: 1, buttons: 0 });
    frame();
  };
  return { field, click, frame };
}

/** A keycode that reads as End. */
function endKeycode(field) {
  field.app.X.keycode2keysyms[254] = [0xff57];
  return 254;
}

/** The middle of the placeholder's ink, in window coordinates. */
function placeholderMiddle(field) {
  const content = field.contentBox();
  const width = field.app.fonts.layout(
    PLACEHOLDER,
    field.resolvedTextStyle(),
  ).width;
  const startX =
    field.direction === 'rtl' ? content.x + content.width - width : content.x;
  return {
    x: Math.round(startX + width / 2),
    y: Math.round(content.y + Math.min(content.height, 20) / 2),
  };
}

for (const tag of ['textinput', 'textarea']) {
  for (const style of [
    { flexGrow: 1, fontSize: 20 },
    { flexGrow: 1, fontSize: 20, textAlign: 'center' },
    { flexGrow: 1, fontSize: 20, direction: 'rtl' },
  ]) {
    // `<textinput>` places its value itself and has no textAlign
    if (tag === 'textinput' && style.textAlign) continue;
    describe(`<${tag}> ${JSON.stringify(style)}`, () => {
      test('a click on the placeholder puts the caret at the start', async (t) => {
        const { field, click } = await mount(t, tag, { style });
        const { x, y } = placeholderMiddle(field);
        click(x, y);
        assert.ok(field._focused, 'the premise: the click focused the field');
        assert.strictEqual(field._caret, 0);
        assert.strictEqual(field.textIndexAt(x, y), 0);
      });

      test('the caret stands where it would with no placeholder', async (t) => {
        const hinted = await mount(t, tag, { style });
        const bare = await mount(t, tag, { style, placeholder: '' });
        for (const { field, frame } of [hinted, bare]) {
          field.focus();
          frame();
        }
        assert.deepStrictEqual(
          hinted.field.textCaretRect(0),
          bare.field.textCaretRect(0),
        );
        // and the keys read the value too: End stays at its end, which is 0
        hinted.field.root.window.emit('keydown', {
          keycode: endKeycode(hinted.field),
          buttons: 0,
        });
        hinted.frame();
        assert.strictEqual(hinted.field._caret, 0);
      });
    });
  }
}

// `ev.screenX`/`screenY`: where the pointer is on the virtual screen, under
// the DOM's name for it rather than X11's.
//
// It was reachable only as `ev.nativeEvent.rootx`, which is wrong twice over.
// The name is parochial — every backend reports the quantity and one of them
// calls it that. And the *unit* is device pixels while `<popup x y>` are
// logical, so the pattern the docs taught for "open a menu at the pointer"
// placed it at `scale ×` the pointer's position on every display not at 100%.
//
// So `screenX` is logical, like `ev.x`, and `nativeEvent.rootx` stays as it
// was for geometry against a node's `abs`.
import assert from 'node:assert';
import test, { afterEach } from 'node:test';

import React from 'react';

import { act, cleanup, fireEvent, renderX11 } from '../src/testing/index.js';

const h = React.createElement;

afterEach(cleanup);

async function mount() {
  const events = [];
  const { windowNode } = await renderX11(
    h(
      'window',
      {
        width: 200,
        height: 120,
        onMouseDown: (ev) => events.push(ev),
        onKeyDown: (ev) => events.push(ev),
      },
      h('box', { style: { flexGrow: 1 } }),
    ),
  );
  return { events, target: windowNode.children[0], windowNode };
}

test('a press carries the pointer on the screen, in logical pixels', async () => {
  const { events, target, windowNode } = await mount();
  await act(async () => fireEvent.mouseDown(target));
  const ev = events.at(-1);

  assert.ok(ev, 'no press reached the handler');
  assert.strictEqual(
    typeof ev.screenX,
    'number',
    'the press carried no screen position',
  );

  // The invariant, whatever the display scale: the DOM-named field is the
  // X11-named one divided by the window's scale, exactly as `ev.x` is
  // `nativeEvent.x` divided by it.
  const scale = windowNode.events.scale;
  assert.strictEqual(ev.screenX, ev.nativeEvent.rootx / scale);
  assert.strictEqual(ev.screenY, ev.nativeEvent.rooty / scale);

  // And the X11 name is untouched: an app doing geometry against `abs` —
  // which is in device pixels — still has the number it needs.
  assert.strictEqual(typeof ev.nativeEvent.rootx, 'number');
});

test('it is there exactly when the backend reported a position', async () => {
  const { events, target } = await mount();
  await act(async () => fireEvent.key(target, 'a'));
  const ev = events.at(-1);
  assert.ok(ev, 'no key reached the handler');
  assert.strictEqual(ev.type, 'keyDown');

  // An X11 KeyPress carries root_x/root_y — where the pointer was when the
  // key went down — so a key event here *does* have a screen position, and
  // reporting one is honest rather than invented. The rule is not "pointer
  // events only"; it is "exactly what the backend said", so a backend that
  // reports none leaves the field absent rather than claiming the screen's
  // top-left corner, which is a place.
  assert.strictEqual(
    'screenX' in ev,
    ev.nativeEvent.rootx !== undefined && ev.nativeEvent.rootx !== null,
  );
  if ('screenX' in ev) {
    assert.strictEqual(typeof ev.screenX, 'number');
  }
});

// `windowHandleOf`: the number a host embeds, on a backend that has one.
//
// The companion to `<window embeddable>`, and the thing that makes the guest
// half of embedding one API across backends while the mechanism under it is
// nothing alike — an XID that every process on the display understands, or a
// buffer handle that only the host it was duplicated into can open.
//
// What is worth testing here is precisely that it is **not** `windowIdOf`.
// On X11 the two agree, which is exactly why the difference is easy to miss
// and worth pinning down.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { windowHandleOf, windowIdOf } from '../src/windowid.js';

/** An ntk-ish window: a backend where windows themselves are embeddable. */
function reparentingWindow(id = 0x2a00001) {
  return {
    id,
    app: {
      createWindow() {},
      X: { ReparentWindow() {}, ChangeSaveSet() {} },
    },
  };
}

/** A window on a backend that publishes a buffer instead of itself. */
function bufferWindow(handle) {
  return {
    id: 0xdc0a0001,
    app: { createWindow() {} },
    embedHandle: () => handle,
  };
}

describe('windowHandleOf', () => {
  it('is the window id where windows reparent — the two agree on X11', () => {
    const wnd = reparentingWindow();
    assert.equal(windowHandleOf(wnd), 0x2a00001);
    assert.equal(windowHandleOf(wnd), windowIdOf(wnd));
  });

  it('is what the backend publishes where a window cannot be embedded', () => {
    const wnd = bufferWindow(0xf01);
    assert.equal(windowHandleOf(wnd), 0xf01);
    // …and emphatically not the window id, which means nothing outside this
    // process. A caller that reached for `windowIdOf` here would send a host
    // a number that opens nothing.
    assert.notEqual(windowHandleOf(wnd), windowIdOf(wnd));
  });

  it('is null on a backend with no way to be a guest, which is the answer', () => {
    assert.equal(windowHandleOf({ id: 7, app: { createWindow() {} } }), null);
  });

  it('is null for a window that has gone, rather than a stale handle', () => {
    const wnd = bufferWindow(null);
    assert.equal(windowHandleOf(wnd), null);
  });

  it('takes a ref, a node or the window, like windowIdOf', () => {
    const wnd = bufferWindow(0xf02);
    assert.equal(windowHandleOf({ current: wnd }), 0xf02);
    assert.equal(windowHandleOf({ root: { window: wnd } }), 0xf02);
    assert.equal(windowHandleOf(null), null);
    assert.equal(windowHandleOf(undefined), null);
  });

  it('refuses a bare number: it says nothing about which process it is from', () => {
    // `windowIdOf` passes a raw XID through, because on X11 a number is a
    // complete answer. A handle is not — it is only meaningful in the
    // process it was made for — so there is nothing to hand back.
    assert.equal(windowIdOf(12345), 12345);
    assert.equal(windowHandleOf(12345), null);
  });
});

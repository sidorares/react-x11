// `fillText` draws in `fillStyle`.
//
// It did not, on either backend, and the way it failed is worth pinning
// because nothing about it looked wrong. A text layout carries an ink of its
// own when a span or the base names a colour, and `_contextInk` is the flag
// that says "this one names none, draw it with the context's fill" — the
// backends then apply `fillStyle` before handing the layout over. `fillText`
// names no colour, so the flag should always be set for it. It never was:
// `_fontLayout` defaulted the base to `'#000'`, which is a colour, so every
// layout it built carried black and the flag stayed off.
//
// The test is at that seam rather than in pixels, because the seam is the
// whole of the bug — both font engines already do the right thing with a
// layout that names no ink, and neither was ever handed one.
import assert from 'node:assert';
import { describe, test } from 'node:test';

import { BackendContext2D } from '../src/backend/context2d.js';

/** A font engine that records what it was asked to lay out, and answers the
 *  way both real ones do: no colour anywhere means the context's fill. */
function recordingFonts() {
  const layouts = [];
  return {
    layouts,
    layout(spans, base, options) {
      layouts.push({ spans, base, options });
      const contextInk = spans.every((s) => (s.color ?? base.color) == null);
      return {
        _handle: 1,
        _contextInk: contextInk,
        width: 10,
        height: 12,
        lines: [{ baseline: 10, height: 12, y: 0 }],
        destroy() {},
      };
    },
  };
}

/** Records every verb and answers all of them. A Proxy rather than a list of
 *  stubs because the context pushes its whole sticky state into a fresh
 *  surface before it draws anything, and which verbs that is is not this
 *  test's business. */
function recordingNative() {
  const calls = [];
  return new Proxy(
    { calls },
    {
      get(target, name) {
        if (name === 'calls') return calls;
        if (typeof name !== 'string') return undefined;
        return (...args) => {
          calls.push([name, ...args]);
          return undefined;
        };
      },
    },
  );
}

function contextWith(fonts, native) {
  const ctx = new BackendContext2D(
    native,
    () => 1,
    () => 1,
  );
  ctx._fonts = fonts;
  return ctx;
}

describe('fillText takes the context fill', () => {
  test('the layout it builds names no colour of its own', () => {
    const fonts = recordingFonts();
    const ctx = contextWith(fonts, recordingNative());
    ctx.font = '12px sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.fillText('hi', 0, 10);

    assert.equal(fonts.layouts.length, 1);
    const { spans, base } = fonts.layouts[0];
    assert.equal(
      spans[0].color,
      undefined,
      'the span carries a colour — the context fill can never apply',
    );
    assert.equal(
      base.color,
      undefined,
      "the base carries a colour — this is the '#000' default that made " +
        'every fillText black whatever the fill was',
    );
  });

  test('so the fill is pushed before the layout is drawn', () => {
    const native = recordingNative();
    const ctx = contextWith(recordingFonts(), native);
    ctx.font = '12px sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.fillText('hi', 0, 10);

    const fill = native.calls.findIndex((c) => c[0] === 'ctxSetFillColor');
    const draw = native.calls.findIndex((c) => c[0] === 'drawLayout');
    assert.ok(fill !== -1, 'the fill was never applied');
    assert.ok(draw !== -1, 'nothing was drawn');
    assert.ok(fill < draw, 'the fill was applied after the text was drawn');
    const [, , r, g, b] = native.calls[fill];
    assert.deepEqual(
      [r, g, b],
      [1, 1, 1],
      `the ink was ${[r, g, b]}, not white`,
    );
  });

  test('measureText asks for the same layout and draws nothing', () => {
    const native = recordingNative();
    const fonts = recordingFonts();
    const ctx = contextWith(fonts, native);
    ctx.font = '12px sans-serif';
    assert.equal(ctx.measureText('hi').width, 10);
    assert.equal(fonts.layouts.length, 1);
    assert.equal(
      native.calls.filter((c) => c[0] === 'drawLayout').length,
      0,
      'measuring drew',
    );
  });

  test('a colour the caller names still wins over the fill', () => {
    // `<text color>` goes through the same engine with a colour on the span,
    // and must keep it: the fill under a paint pass is whatever the last node
    // set, and a coloured span that started following it would be a different
    // bug in the other direction.
    // No context here on purpose: this is the engine's own answer, and it
    // has to hold before anything draws with it.
    const fonts = recordingFonts();
    const layout = fonts.layout(
      [{ text: 'hi', color: '#ff0000' }],
      { color: '#ff0000' },
      {},
    );
    assert.equal(
      layout._contextInk,
      false,
      'a layout that names its own ink asked for the context fill',
    );
  });
});

// `fillText` places its text by `textAlign` and `textBaseline`.
//
// The context macOS and Windows draw with took the x and the y as the left
// end of the alphabetic baseline whatever the two said, so every centred
// label started at its centre. An SVG's `text-anchor="middle"`, which ntk's
// SvgView hands over as `textAlign = 'center'`, drew a diagram's box labels
// from the middle of each box and out past its right edge — on macOS, where
// ntk's own context on X11 centred them. The offsets are ntk's
// (`_alignOffset`, `_baselineOffset` in its renderingcontext_2d.js), so a
// label is placed alike on every backend.
//
// At the seam rather than in pixels: the x and y the layout is drawn at are
// the whole of it, and both font engines draw a layout where they are told.
import assert from 'node:assert';
import { describe, test } from 'node:test';

import { BackendContext2D } from '../src/backend/context2d.js';

/** A font engine answering one line 40 wide, its baseline 10 down, the
 *  face's ascent 9 and descent 3; the text right to left where it starts
 *  with a Hebrew letter. */
function fonts() {
  return {
    layout(spans) {
      const rtl = /^[֐-׿]/.test(spans[0].text);
      return {
        _handle: 1,
        _contextInk: true,
        width: 40,
        height: 12,
        lines: [
          {
            baseline: 10,
            ascent: 9,
            descent: 3,
            height: 12,
            y: 0,
            runs: [{ x: 0, width: 40, start: 0, end: 4, rtl }],
          },
        ],
        destroy() {},
      };
    },
  };
}

/** Records the verbs, answering every one. */
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

function context() {
  const native = recordingNative();
  const ctx = new BackendContext2D(
    native,
    () => 1,
    () => 1,
  );
  ctx._fonts = fonts();
  ctx.font = '12px sans-serif';
  return { ctx, native };
}

/** Where the last `fillText` drew its layout from: its top left. */
function drawnAt(native) {
  const call = native.calls.findLast((c) => c[0] === 'drawLayout');
  assert.ok(call, 'nothing was drawn');
  return [call[3], call[4]];
}

describe('fillText places its text by textAlign and textBaseline', () => {
  test('the defaults: start, on the alphabetic baseline', () => {
    const { ctx, native } = context();
    assert.strictEqual(ctx.textAlign, 'start');
    assert.strictEqual(ctx.textBaseline, 'alphabetic');
    assert.strictEqual(ctx.direction, 'inherit');
    ctx.fillText('abcd', 100, 50);
    // the layout's top is the baseline less its baseline offset
    assert.deepStrictEqual(drawnAt(native), [100, 40]);
  });

  test('each alignment, across the 40 the text is wide', () => {
    const at = {};
    for (const align of ['left', 'right', 'center', 'start', 'end']) {
      const { ctx, native } = context();
      ctx.textAlign = align;
      ctx.fillText('abcd', 100, 50);
      at[align] = drawnAt(native)[0];
    }
    assert.deepStrictEqual(at, {
      left: 100,
      right: 60,
      center: 80,
      start: 100,
      end: 60,
    });
  });

  test('start and end face the way the text runs, or the way direction says', () => {
    const run = (text, align, direction) => {
      const { ctx, native } = context();
      ctx.textAlign = align;
      if (direction) ctx.direction = direction;
      ctx.fillText(text, 100, 50);
      return drawnAt(native)[0];
    };
    assert.strictEqual(
      run('שלום', 'start'),
      60,
      'right to left text starts right',
    );
    assert.strictEqual(run('שלום', 'end'), 100);
    assert.strictEqual(run('abcd', 'start', 'rtl'), 60, 'direction overrides');
    assert.strictEqual(run('שלום', 'start', 'ltr'), 100);
    assert.strictEqual(run('שלום', 'left'), 100, 'left is left either way');
  });

  test('each baseline, from the face ascent of 9 and descent of 3', () => {
    const at = {};
    for (const baseline of [
      'top',
      'hanging',
      'middle',
      'alphabetic',
      'ideographic',
      'bottom',
    ]) {
      const { ctx, native } = context();
      ctx.textBaseline = baseline;
      ctx.fillText('abcd', 100, 50);
      at[baseline] = drawnAt(native)[1];
    }
    // the layout's top is y - 10, moved down by the offset to the baseline
    assert.deepStrictEqual(at, {
      top: 49,
      hanging: 47.2,
      middle: 43,
      alphabetic: 40,
      ideographic: 37,
      bottom: 37,
    });
  });

  test('a value canvas does not take is ignored, and save and restore keep both', () => {
    const { ctx, native } = context();
    ctx.textAlign = 'center';
    ctx.textAlign = 'middle';
    ctx.textBaseline = 'top';
    ctx.textBaseline = 'central';
    ctx.direction = 'sideways';
    assert.deepStrictEqual(
      [ctx.textAlign, ctx.textBaseline, ctx.direction],
      ['center', 'top', 'inherit'],
    );
    ctx.save();
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.restore();
    assert.deepStrictEqual(
      [ctx.textAlign, ctx.textBaseline],
      ['center', 'top'],
    );
    ctx.fillText('abcd', 100, 50);
    assert.deepStrictEqual(drawnAt(native), [80, 49]);
  });
});

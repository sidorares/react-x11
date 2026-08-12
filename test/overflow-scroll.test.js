// Scrolling as a style rather than as an element (`<box overflow="scroll">`).
//
// The behaviour `<scrollview>` used to have is covered by the suites that
// were written against it and now render a box — scrollbar.test.js,
// scroll-blit.test.js, hit-test.test.js and the rest. What is tested here is
// only what the move *added*: the gate that keeps an ordinary box ordinary,
// the same gate coming back off, a `<window>` that scrolls its own content,
// and the wheel chaining that a world of cheap scroll containers needs.
import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import { createRoot } from '../src/index.js';
import { a11yRole, ATSPI_ROLE } from '../src/a11y.js';
import { createMockApp, spinWheel } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** A window with `children`, settled through one frame. */
async function mount(children, windowProps = {}) {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    h('window', { width: 200, height: 100, ...windowProps }, children),
  );
  await tick();
  const wnd = app.windows[0];
  wnd.flushFrame?.();
  await tick();
  return { app, wnd, node: wnd._reactX11Node };
}

/** 10 rows of 40 = 400 of content. */
const rows = (n = 10, height = 40) =>
  Array.from({ length: n }, (_, i) =>
    h('box', { key: i, style: { height, flexShrink: 0 } }),
  );

// ntk delivers a scroll as `wheel`, in notches — positive down and right,
// whether the connection measured it with XI2 or counted button 4-7 presses.
const wheel = (wnd, x, y, delta) => spinWheel(wnd, x, y, delta);

// --- the gate ---------------------------------------------------------------

test('a box only scrolls when overflow says scroll', async () => {
  const ref = React.createRef();
  const { node } = await mount(
    h('box', { ref, style: { overflow: 'hidden', flexGrow: 1 } }, ...rows()),
  );
  const box = ref.current;
  assert.equal(box.isScroller(), false);
  assert.equal(box.clipsChildren(), true, 'overflow: hidden still clips');

  // every part of the surface is inert, not merely unused
  box.scrollTo({ y: 200 });
  assert.equal(box.scrollY, 0, 'scrollTo has nowhere to go');
  assert.equal(box._maxScroll('y'), 0);
  assert.deepEqual(box._scrollbars(), []);
  assert.equal(box.focusableByDefault, false, 'not a tab stop');
  assert.equal(a11yRole(box), ATSPI_ROLE.FILLER, 'not a scroll pane');

  // ...and the content is still where it was laid out
  assert.equal(node.children[0].children[0].abs.y, 0);
});

test('overflow: scroll turns the same box into a scroll pane', async () => {
  const ref = React.createRef();
  await mount(
    h('box', { ref, style: { overflow: 'scroll', flexGrow: 1 } }, ...rows()),
  );
  const box = ref.current;
  assert.equal(box.isScroller(), true);
  assert.equal(box.contentHeight, 400);
  assert.equal(box._maxScroll('y'), 300, '400 of content in 100 of viewport');
  assert.equal(
    box.focusableByDefault,
    true,
    'a tab stop, having somewhere to go',
  );
  assert.equal(a11yRole(box), ATSPI_ROLE.SCROLL_PANE);
  assert.equal(box._scrollbars().length, 1, 'a vertical thumb, no horizontal');
});

test('the scroll-container layout defaults come off the style, not a constructor', async () => {
  // `flex: 1` semantics: grown, unsized, so flex-basis is zeroed and the
  // viewport takes what is left instead of being sized by 400 of content
  const grown = React.createRef();
  // ...and a box that names its own size keeps it
  const sized = React.createRef();
  await mount(
    h(
      'box',
      { style: { flexDirection: 'column' } },
      h(
        'box',
        { ref: grown, style: { overflow: 'scroll', flexGrow: 1 } },
        ...rows(),
      ),
      h(
        'box',
        { ref: sized, style: { overflow: 'scroll', height: 50 } },
        ...rows(),
      ),
    ),
  );
  assert.equal(grown.current.style.flexBasis, 0, 'flex-basis: 0 injected');
  assert.equal(grown.current.style.minHeight, 0, 'min-height: 0 injected');
  assert.equal(grown.current.style.minWidth, 0, 'min-width: 0 injected');
  assert.equal(sized.current.style.flexBasis, undefined, 'sized: left alone');
  assert.equal(sized.current.abs.height, 50);
});

test('an explicit layout style wins over the scroll-container default', async () => {
  const ref = React.createRef();
  await mount(
    h(
      'box',
      {
        ref,
        style: {
          overflow: 'scroll',
          flexGrow: 1,
          flexShrink: 0,
          minHeight: 20,
        },
      },
      ...rows(),
    ),
  );
  assert.equal(ref.current.style.flexShrink, 0);
  assert.equal(ref.current.style.minHeight, 20);
});

// --- the gate coming back off ----------------------------------------------

test('a box that stops scrolling drops the offset it can no longer clamp', async () => {
  const ref = React.createRef();
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const render = (overflow) =>
    x11Root.render(
      h(
        'window',
        { width: 200, height: 100 },
        h('box', { ref, style: { overflow, flexGrow: 1 } }, ...rows()),
      ),
    );
  render('scroll');
  await tick();
  app.windows[0].flushFrame?.();
  await tick();

  const box = ref.current;
  box.scrollTo({ y: 120 });
  assert.equal(box.scrollY, 120);

  // the same node — no remount, which is the whole point of the style being
  // the switch: a swap of elements would have taken the children with it
  render('hidden');
  await tick();
  app.windows[0].flushFrame?.();
  await tick();
  assert.equal(ref.current, box, 'the node survived the change');
  assert.equal(box.scrollY, 0, 'the content is not left shifted forever');
  assert.equal(box.isScroller(), false);
});

// --- a scrolling window -----------------------------------------------------

test('a window scrolls its own content', async () => {
  const { wnd, node } = await mount(rows(), {
    style: { overflow: 'scroll' },
  });
  assert.equal(node.isScroller(), true);
  assert.equal(node.contentHeight, 400);
  assert.equal(node._maxScroll('y'), 300);

  node.scrollTo({ y: 80 });
  wnd.flushFrame?.();
  await tick();
  assert.equal(node.children[0].abs.y, -80, 'the children moved under it');

  // a window is a frame to a screen reader whatever its overflow says
  assert.equal(a11yRole(node), ATSPI_ROLE.FRAME);
});

test('the wheel scrolls the window when nothing inner takes it', async () => {
  const { wnd, node } = await mount(rows(), { style: { overflow: 'scroll' } });
  wheel(wnd, 50, 50);
  assert.equal(node.scrollY, 48, 'one notch');
});

// --- wheel chaining ---------------------------------------------------------

/**
 * An inner pane over a tall sibling, so the *window* always has somewhere to
 * go and only the inner pane's own content decides whether it takes the
 * wheel. `innerRows` of 1 fits its 60px pane; 10 overflows it.
 */
const nested = (inner, innerRows) => [
  h(
    'box',
    {
      key: 'pane',
      ref: inner,
      style: { overflow: 'scroll', height: 60, flexShrink: 0 },
    },
    ...rows(innerRows),
  ),
  h('box', { key: 'tail', style: { height: 400, flexShrink: 0 } }),
];

test('the wheel chains past a scroll box that fits its own content', async () => {
  const inner = React.createRef();
  const { wnd, node } = await mount(nested(inner, 1), {
    style: { overflow: 'scroll' },
  });
  assert.equal(inner.current.isScroller(), true);
  assert.equal(inner.current._maxScroll('y'), 0, 'nothing to scroll inside');
  assert.ok(node._maxScroll('y') > 0, 'but the window has somewhere to go');

  wheel(wnd, 50, 20); // over the inner pane
  assert.equal(inner.current.scrollY, 0);
  assert.equal(node.scrollY, 48, 'the window answered it instead');
});

test('a scroll box with somewhere to go keeps the wheel to itself', async () => {
  const inner = React.createRef();
  const { wnd, node } = await mount(nested(inner, 10), {
    style: { overflow: 'scroll' },
  });
  assert.ok(inner.current._maxScroll('y') > 0);

  wheel(wnd, 50, 20);
  assert.equal(inner.current.scrollY, 48);
  assert.equal(node.scrollY, 0, 'the window did not also move');
});

// --- keys -------------------------------------------------------------------

test('a plain box does not swallow the keys a scroll pane answers', async () => {
  const ref = React.createRef();
  await mount(
    h('box', { ref, style: { overflow: 'hidden', flexGrow: 1 } }, ...rows()),
  );
  // XK_Down. A scroll pane consumes it; a box with nothing to scroll must
  // leave it for whatever else would answer.
  assert.equal(ref.current.defaultKeyDown({ keysym: 0xff54 }), undefined);
  assert.equal(ref.current.scrollY, 0);
});

// Local accessibility: what a keyboard, a trackball or a shaky hand needs
// from the renderer itself, with no AT-SPI and no D-Bus anywhere (#117).
//
// Three gaps, one theme: the renderer already *knew* everything needed and
// simply did not act on it. It knew which node had focus but drew nothing;
// it knew a scroll box had somewhere to scroll but answered no keys; it
// knew where a node's box was but had no way to say the target was bigger
// than the box.
import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';

import { createRoot, Slider, Switch, ThemeProvider } from '../src/index.js';
import { createMockApp, pressButton } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => {
  await tick();
  await tick();
};

const XK_TAB = 0xff09;
const XK_DOWN = 0xff54;
const XK_UP = 0xff52;
const XK_HOME = 0xff50;
const XK_END = 0xff57;
const XK_PAGE_DOWN = 0xff56;
const XK_SPACE = 0x0020;

function press(app, wnd, keysym, { shift = false } = {}) {
  const keycode = (keysym % 248) + 8;
  app.X.keycode2keysyms[keycode] = [keysym];
  wnd.emit('keydown', { keycode, buttons: shift ? 1 : 0 });
}

const mount = async (element, { width = 200, height = 200 } = {}) => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(h('window', { width, height }, element));
  await settle();
  const wnd = app.windows[0];
  return { app, wnd, root: wnd._reactX11Node };
};

const find = (node, pred) =>
  pred(node)
    ? node
    : node.children.reduce(
        (a, c) => a || (c.isWindow ? null : find(c, pred)),
        null,
      );

/** Every stroked path in the last frame, as `{ rect, color, width }`. The
 * mock context records the path op and the stroke separately. */
function strokes(wnd) {
  const out = [];
  let last = null;
  for (const op of wnd.ctx.ops) {
    if (op[0] === 'rect' || op[0] === 'roundRect') last = op;
    else if (op[0] === 'stroke' && last) {
      out.push({
        rect: { x: last[1], y: last[2], width: last[3], height: last[4] },
        color: op[1],
        width: op[2],
      });
    }
  }
  return out;
}

const repaint = async (wnd) => {
  wnd.ctx.ops.length = 0;
  const root = wnd._reactX11Node;
  root._scheduled = false;
  root.needsPaint = true;
  root._damage = null; // whole window, so nothing is culled out of the readout
  root.flush();
};

// --- 1. the focus ring ------------------------------------------------------

test('Tab lights a focus ring; a press does not', async () => {
  const { app, wnd, root } = await mount(
    h('box', { focusable: true, style: { width: 40, height: 20 } }),
  );
  const box = root.children[0];

  pressButton(wnd, box.abs.x + 5, box.abs.y + 5);
  await settle();
  assert.strictEqual(box.states[':focus'], true, 'a press focuses');
  assert.strictEqual(
    box.states[':focus-visible'],
    false,
    'and does not make it visible — the user knows where they clicked',
  );
  await repaint(wnd);
  assert.deepStrictEqual(strokes(wnd), [], 'so nothing is drawn around it');

  // blur, then arrive by keyboard instead
  box.blur();
  press(app, wnd, XK_TAB);
  await settle();
  assert.strictEqual(
    box.states[':focus-visible'],
    true,
    'Tab makes it visible',
  );

  await repaint(wnd);
  const ring = strokes(wnd).find((s) => s.width === 2);
  assert.ok(ring, `a ring is drawn: ${JSON.stringify(strokes(wnd))}`);
  assert.ok(
    ring.rect.x < box.abs.x && ring.rect.y < box.abs.y,
    'outside the border box, not on it',
  );
  assert.ok(
    ring.rect.width > box.abs.width && ring.rect.height > box.abs.height,
    'on every side',
  );
});

test('the ring costs no layout — it is why `outline` is not `border`', async () => {
  const { app, wnd, root } = await mount(
    h(
      'box',
      { style: { flexDirection: 'row' } },
      h('box', { focusable: true, style: { width: 40, height: 20 } }),
      h('box', { style: { width: 40, height: 20 } }),
    ),
  );
  const [first, second] = root.children[0].children;
  const before = { ...first.abs };
  const beside = { ...second.abs };

  press(app, wnd, XK_TAB);
  await settle();
  assert.strictEqual(first.states[':focus-visible'], true);
  assert.deepStrictEqual(first.abs, before, 'the focused node has not moved');
  assert.deepStrictEqual(second.abs, beside, 'nor has its neighbour');
});

test('a theme restyles every ring in the app', async () => {
  const { app, wnd, root } = await mount(
    h(
      ThemeProvider,
      { value: { focusRing: '#ff0000', focusRingWidth: 4 } },
      h('box', { focusable: true, style: { width: 40, height: 20 } }),
    ),
  );
  press(app, wnd, XK_TAB);
  await settle();
  await repaint(wnd);
  const ring = strokes(wnd).find((s) => s.color === '#ff0000');
  assert.ok(ring, 'the theme colour is used');
  assert.strictEqual(ring.width, 4, 'and the theme width');
  const box = find(root, (n) => n.props.focusable === true);
  assert.strictEqual(box.states[':focus-visible'], true);
});

test('outlineWidth: 0 opts out, and a style block overrides', async () => {
  const { app, wnd, root } = await mount(
    h(
      'box',
      { style: { flexDirection: 'row' } },
      h('box', {
        focusable: true,
        style: { width: 40, height: 20, outlineWidth: 0 },
      }),
      h('box', {
        focusable: true,
        style: {
          width: 40,
          height: 20,
          ':focus-visible': { outlineWidth: 6, outlineColor: '#00ff00' },
        },
      }),
    ),
  );
  const [opted, styled] = root.children[0].children;

  press(app, wnd, XK_TAB);
  await settle();
  assert.strictEqual(opted.states[':focus-visible'], true);
  await repaint(wnd);
  assert.deepStrictEqual(strokes(wnd), [], 'nothing drawn for the opt-out');

  press(app, wnd, XK_TAB);
  await settle();
  assert.strictEqual(styled.states[':focus-visible'], true);
  await repaint(wnd);
  const ring = strokes(wnd).find((s) => s.color === '#00ff00');
  assert.ok(ring, 'the state block wins');
  assert.strictEqual(ring.width, 6);
});

test('the claim that erases a ring is taken while the ring is still on', async () => {
  // A node's damage bound only reaches outside its box *while* it is drawing
  // an outline — inflating every focusable node's rect for a ring that is not
  // there would widen every claim in the tree. That makes the ordering load
  // bearing: blur has to claim before it clears the state, or the ring's
  // pixels are left behind.
  const { app, wnd, root } = await mount(
    h(
      'box',
      { style: { flexDirection: 'row', gap: 20 } },
      h('box', { focusable: true, style: { width: 40, height: 20 } }),
      h('box', { focusable: true, style: { width: 40, height: 20 } }),
    ),
  );
  const [first] = root.children[0].children;
  press(app, wnd, XK_TAB);
  await settle();
  assert.ok(first._outlineExtent() > 0, 'the ring is on');

  // record how far each claim about `first` reached at the moment it was made
  const claims = [];
  const real = root.invalidate.bind(root);
  root.invalidate = (layout, node, reason) => {
    if (node === first) claims.push(node.paintBounds());
    return real(layout, node, reason);
  };
  press(app, wnd, XK_TAB); // focus moves on; the first node's ring is erased
  root.invalidate = real;

  assert.ok(claims.length > 0, 'blur claimed a region for it');
  const ring = 3; // the default 2px ring, 1px off the box
  const covers = claims.some(
    (r) =>
      r.x <= first.abs.x - ring &&
      r.y <= first.abs.y - ring &&
      r.x + r.width >= first.abs.x + first.abs.width + ring &&
      r.y + r.height >= first.abs.y + first.abs.height + ring,
  );
  assert.ok(
    covers,
    `a claim covers where the ring was: ${JSON.stringify(claims)}`,
  );
});

// --- 2. a keyboard-operable scroll box ------------------------------------

const scroller = (contentHeight, props) =>
  h(
    'box',
    { style: { overflow: 'scroll', width: 100, height: 100 }, ...props },
    h('box', { style: { height: contentHeight } }),
  );

test('a scroll box is a tab stop only when it has somewhere to scroll', async () => {
  const { root } = await mount(h('box', null, scroller(400), scroller(20)));
  const [overflowing, fits] = root.children[0].children;
  assert.strictEqual(overflowing.focusableByDefault, true);
  assert.strictEqual(
    fits.focusableByDefault,
    false,
    'a scroll box that fits its content is a box with a clip',
  );
});

test('Tab reaches a pane of unfocusable content, and the keys scroll it', async () => {
  const { app, wnd, root } = await mount(scroller(400));
  const view = root.children[0];

  press(app, wnd, XK_TAB);
  await settle();
  assert.strictEqual(view.focused, true, 'Tab stops on it');
  assert.strictEqual(view.states[':focus-visible'], true, 'and indicates it');

  press(app, wnd, XK_DOWN);
  assert.strictEqual(view.scrollY, 48, 'an arrow is a wheel notch');
  press(app, wnd, XK_UP);
  assert.strictEqual(view.scrollY, 0);

  press(app, wnd, XK_PAGE_DOWN);
  assert.strictEqual(view.scrollY, 76, 'a page keeps a sliver on screen');
  press(app, wnd, XK_HOME);
  assert.strictEqual(view.scrollY, 0);
  press(app, wnd, XK_END);
  assert.strictEqual(view.scrollY, 300, 'End is the bottom of the content');

  press(app, wnd, XK_SPACE, { shift: true });
  assert.strictEqual(view.scrollY, 224, 'Shift+Space pages back');
  press(app, wnd, XK_SPACE);
  assert.strictEqual(view.scrollY, 300);
});

test('an app onKeyDown runs first and can preventDefault the scroll', async () => {
  const seen = [];
  const { app, wnd, root } = await mount(
    scroller(400, {
      onKeyDown: (ev) => {
        seen.push(ev.keysym);
        ev.preventDefault();
      },
    }),
  );
  const view = root.children[0];
  press(app, wnd, XK_TAB);
  await settle();
  press(app, wnd, XK_DOWN);
  assert.deepStrictEqual(seen, [XK_DOWN], 'the handler ran');
  assert.strictEqual(view.scrollY, 0, 'and the default action did not');
});

// --- 3. hit targets ---------------------------------------------------------

test('hitSlop grows the target and nothing else', async () => {
  const { root } = await mount(
    h(
      'box',
      { style: { padding: 20, gap: 20 } },
      h('box', {
        style: { width: 40, height: 16, hitSlop: { top: 4, bottom: 4 } },
      }),
      h('box', { style: { width: 40, height: 16 } }),
    ),
  );
  const [box, plain] = root.children[0].children;
  assert.strictEqual(box.abs.height, 16, 'the box is the size it was');
  assert.strictEqual(
    plain.abs.height,
    16,
    'and so is the one beside it — no reflow',
  );
  assert.strictEqual(
    box.paintBounds().height,
    plain.paintBounds().height,
    'and it claims no more ink — slop is not paint',
  );

  // node objects are compared with `ok`: a failed strictEqual would try to
  // diff two whole retained trees
  const midX = box.abs.x + 10;
  const hit = (x, y) => root.hitTest(x, y);
  assert.ok(
    hit(midX, box.abs.y + box.abs.height + 3) === box,
    '3px below still hits',
  );
  assert.ok(hit(midX, box.abs.y - 3) === box, 'and 3px above');
  assert.ok(
    hit(midX, box.abs.y + box.abs.height + 5) !== box,
    'past the slop it misses',
  );
  assert.ok(
    hit(box.abs.x - 3, box.abs.y + 8) !== box,
    'and a side that was not grown is not grown',
  );
});

test('Switch and Slider clear the 24px minimum', async () => {
  let switched = null;
  const { wnd, root } = await mount(
    h(
      'box',
      { style: { gap: 40, padding: 20 } },
      h(Switch, { checked: false, onChange: (ev) => (switched = ev.value) }),
      h(Slider, { value: 50 }),
    ),
    { width: 300, height: 300 },
  );
  const track = find(root, (n) => n.props.role === 'switch');
  const slider = find(root, (n) => n.props.role === 'slider');

  const targetHeight = (node) => {
    let top = node.abs.y;
    let bottom = node.abs.y + node.abs.height;
    while (root.hitTest(node.abs.x + 2, top - 1) === node) top -= 1;
    while (root.hitTest(node.abs.x + 2, bottom) === node) bottom += 1;
    return bottom - top;
  };

  assert.strictEqual(track.abs.height, 20, 'the pill still draws 20 tall');
  assert.strictEqual(
    targetHeight(track),
    24,
    'and answers the pointer over 24',
  );
  assert.strictEqual(slider.abs.height, 16, 'the slider still draws 16 tall');
  assert.strictEqual(targetHeight(slider), 24, 'and answers over 24');

  // and the slop is a live target, not just a bigger rect
  pressButton(wnd, track.abs.x + 4, track.abs.y + track.abs.height + 1);
  await settle();
  assert.strictEqual(switched, true, 'a press in the slop toggles the switch');
});

// --- 4. Space and Enter are a click ----------------------------------------
//
// The same complaint as section 1, one rung out (#329). The ring arrived and
// the activation did not: a focusable `<box onClick>` took focus, drew a
// ring, was reachable by Tab and was activatable by Orca — the AT-SPI bridge
// dispatches a synthetic click for anything with an `onClick` — and did
// nothing at all when a keyboard-only user pressed Space or Enter. It is one
// click now, `synthesizeClick`, and all three routes go through it.

const XK_RETURN = 0xff0d;
const XK_KP_ENTER = 0xff8d;
const XK_A = 0x0061;

/** A press that carries a code point as well as a keysym, the way ntk's
 *  decoded event does — `press` above sends only the keysym. */
function type(app, wnd, keysym, codepoint, { shift = false } = {}) {
  const keycode = (keysym % 248) + 8;
  app.X.keycode2keysyms[keycode] = [keysym];
  wnd.emit('keydown', { keycode, keysym, codepoint, buttons: shift ? 1 : 0 });
}

/** A `<box focusable onClick>` that records the whole gesture, so a test can
 *  compare what the keyboard sent with what the pointer sends. */
const recorder = (log, props) =>
  h('box', {
    focusable: true,
    style: { width: 60, height: 20 },
    onMouseDown: () => log.push('down'),
    onMouseUp: () => log.push('up'),
    onClick: () => log.push('click'),
    ...props,
  });

test('a focusable box with an onClick answers Space and Enter', async () => {
  const log = [];
  const { app, wnd, root } = await mount(recorder(log));
  const box = root.children[0];
  box.focus();

  press(app, wnd, XK_SPACE);
  assert.deepStrictEqual(log, ['down', 'up', 'click'], 'Space presses it');

  log.length = 0;
  press(app, wnd, XK_RETURN);
  assert.deepStrictEqual(log, ['down', 'up', 'click'], 'and so does Enter');

  log.length = 0;
  press(app, wnd, XK_KP_ENTER);
  assert.deepStrictEqual(log, ['down', 'up', 'click'], 'and the keypad one');

  // ntk decodes a key into keysym *and* code point; a widget's hand-rolled
  // mapping always read the code point, so the rule that replaced them has
  // to answer both spellings of the same key
  log.length = 0;
  type(app, wnd, XK_SPACE, 32);
  assert.deepStrictEqual(log, ['down', 'up', 'click'], 'a decoded Space too');

  log.length = 0;
  press(app, wnd, XK_A);
  assert.deepStrictEqual(log, [], 'an ordinary letter is not an activation');
});

test('the keyboard sends the gesture the pointer sends', async () => {
  const keyboard = [];
  const pointer = [];
  const { app, wnd, root } = await mount(
    h('box', { style: { gap: 10, padding: 10 } }, [
      h('box', { key: 'k' }, recorder(keyboard)),
      h('box', { key: 'p' }, recorder(pointer)),
    ]),
  );
  const [byKey, byPointer] = root.children[0].children.map(
    (n) => n.children[0],
  );

  byKey.focus();
  press(app, wnd, XK_RETURN);
  pressButton(wnd, byPointer.abs.x + 5, byPointer.abs.y + 5);
  await settle();
  assert.deepStrictEqual(
    keyboard,
    pointer,
    'press, release, click — a control acting on the press hears it either way',
  );
});

test('a press on the keyboard carries the modifiers it was made with', async () => {
  let ev = null;
  const { app, wnd, root } = await mount(
    h('box', {
      focusable: true,
      style: { width: 60, height: 20 },
      onClick: (e) => (ev = e),
    }),
  );
  root.children[0].focus();

  type(app, wnd, XK_RETURN, undefined, { shift: true });
  assert.ok(ev, 'the click arrived');
  assert.strictEqual(ev.shiftKey, true, 'Shift+Enter reads as a shift-click');
  assert.strictEqual(ev.detail, 1, 'and as a single click');
});

test('preventDefault in the element’s own onKeyDown suppresses it', async () => {
  const log = [];
  const { app, wnd, root } = await mount(
    recorder(log, {
      onKeyDown: (ev) => {
        log.push(`key:${ev.keysym}`);
        ev.preventDefault();
      },
    }),
  );
  root.children[0].focus();

  press(app, wnd, XK_RETURN);
  assert.deepStrictEqual(
    log,
    [`key:${XK_RETURN}`],
    'the handler ran and the click did not',
  );
});

test('a role is not a click: nothing with no onClick is activated', async () => {
  const log = [];
  const { app, wnd, root } = await mount(
    h('box', {
      focusable: true,
      role: 'button',
      style: { width: 60, height: 20 },
      onMouseDown: () => log.push('down'),
      onKeyDown: () => log.push('key'),
    }),
  );
  root.children[0].focus();

  press(app, wnd, XK_SPACE);
  assert.deepStrictEqual(
    log,
    ['key'],
    'a role advertises an action to an AT; it is not one',
  );
});

test('a text input types a space rather than pressing itself', async () => {
  const log = [];
  const { app, wnd, root } = await mount(
    h('textinput', {
      defaultValue: 'a',
      style: { width: 80 },
      onClick: () => log.push('click'),
    }),
  );
  const input = find(root, (n) => n.kind === 'textinput');
  input.focus();

  type(app, wnd, XK_SPACE, 32);
  await settle();
  assert.strictEqual(input.value, 'a ', 'the space was typed');
  assert.deepStrictEqual(log, [], 'and nothing was activated');
});

// The one place two default actions want the same key, and the answer the
// scroll pane's own `defaultKeyDown` already gives: it takes Space before
// the base class ever sees it.
test('a scrolling box keeps Space for paging and activates on Enter', async () => {
  const log = [];
  const { app, wnd, root } = await mount(
    h(
      'box',
      {
        style: { overflow: 'scroll', width: 100, height: 100 },
        onClick: () => log.push('click'),
      },
      h('box', { style: { height: 400 } }),
    ),
  );
  const view = root.children[0];
  view.focus();

  press(app, wnd, XK_SPACE);
  assert.strictEqual(view.scrollY, 76, 'Space still pages the pane');
  assert.deepStrictEqual(log, [], 'and does not press it');

  press(app, wnd, XK_RETURN);
  assert.deepStrictEqual(log, ['click'], 'Enter, which pages nothing, does');
});

test('a focusable row inside a scroll pane takes the keys, and always did', async () => {
  const log = [];
  const { app, wnd, root } = await mount(
    h(
      'box',
      { style: { overflow: 'scroll', width: 100, height: 100 } },
      h('box', { style: { height: 400 } }, recorder(log, { role: 'option' })),
    ),
  );
  const view = root.children[0];
  const row = find(root, (n) => n.props.role === 'option');
  row.focus();

  press(app, wnd, XK_SPACE);
  assert.deepStrictEqual(log, ['down', 'up', 'click'], 'the row is pressed');
  assert.strictEqual(
    view.scrollY,
    0,
    'and the pane does not page — it never did with a row focused, ' +
      'because a default action runs on the focused node',
  );
});

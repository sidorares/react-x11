// The scroll chain as a documented protocol (#253): an element that scrolls
// pixels it painted — an editor, a terminal, a canvas-backed table, and
// core's own `<textarea>` — joins the wheel's default action on public API
// instead of being named by kind inside it.
//
// Two ways in, both exercised here: `Scrollable(Node)` with
// `measureScrollContent()` overridden, which brings the bars, the keys and
// the scroll-pane role with it; and `canScroll` + `scrollBy` implemented
// directly, which is the whole of chain membership.
//
// Everything registers its element through `react-x11/host` and imports from
// `react-x11/node`, because the point is that a package outside react-x11
// can do this — a test reaching into src/nodes.js would prove nothing about
// the published surface.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import React from 'react';

import xserver from 'x11/lib/xserver/index.js';
import { createClient, StaticFontSource } from 'ntk';

import { createRoot } from '../src/index.js';
import { registerElement, unregisterElement } from '../src/host.js';
import { Node, Scrollable } from '../src/node.js';
import { atspiRoleOf, ATSPI_ROLE } from '../src/a11y.js';
import { XK_PAGE_DOWN } from '../src/keysyms.js';
import { createMockApp, spinWheel } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

// ntk delivers a scroll as `wheel`, in notches — positive down and right,
// whether the connection measured it with XI2 or counted button 4-7 presses.
const wheel = (wnd, x, y, delta) => spinWheel(wnd, x, y, delta);

function pressKey(app, wnd, keysym) {
  const keycode = (keysym % 248) + 8;
  app.X.keycode2keysyms[keycode] = [keysym];
  wnd.emit('keydown', { keycode, keysym, codepoint: 0, buttons: 0 });
}

/**
 * A miniature code editor: `lines` of painted text, no child nodes at all.
 * The content extent is a fact about the drawing, which is exactly what
 * `measureScrollContent` is for.
 */
const LINE = 16;

class EditorNode extends Scrollable(Node) {
  constructor(props, app) {
    super('miniedit', props, app);
    // no `this.focusableByDefault = true` here: the mixin answers that one
    // itself, off whether there is anything to scroll
    this.painted = [];
  }

  /** Scrolling is what this element *is*, rather than a style an app opts
   * into — the same call `<box>` answers off `overflow`. */
  isScroller() {
    return true;
  }

  measureScrollContent() {
    return {
      width: 40 * (this.props.columns ?? 1),
      height: LINE * (this.props.lines ?? 0),
    };
  }

  paintContent(ctx) {
    // under the scrollbars, over the background — and offset by the scroll
    // this element owns, since it has no children for absolutize to move
    this.painted.push({ x: this.scrollX, y: this.scrollY });
    void ctx;
  }
}

/** The other half of the protocol on its own: no mixin, two methods. */
class TerminalNode extends Node {
  constructor(props, app) {
    super('miniterm', props, app);
    this.scrolled = 0;
  }

  _max() {
    return Math.max(0, LINE * (this.props.lines ?? 0) - this.abs.height);
  }

  canScroll(dx, dy) {
    return Boolean(dy) && this._max() > 0;
  }

  scrollBy(by) {
    const dy = typeof by === 'number' ? by : (by?.y ?? 0);
    this.scrolled = Math.min(Math.max(0, this.scrolled + dy), this._max());
  }
}

const registered = new Set();
function register(type, definition) {
  registerElement(type, { override: true, ...definition });
  registered.add(type);
}

afterEach(() => {
  for (const type of registered) unregisterElement(type);
  registered.clear();
});

async function mount(children, windowProps = {}) {
  register('miniedit', {
    create: (p, app) => new EditorNode(p, app),
    childrenAllowed: false,
    semanticNames: ['lines', 'columns'],
  });
  register('miniterm', {
    create: (p, app) => new TerminalNode(p, app),
    childrenAllowed: false,
    semanticNames: ['lines'],
  });
  const app = createMockApp();
  const root = await createRoot({ app });
  root.render(
    h('window', { width: 200, height: 100, ...windowProps }, children),
  );
  await tick();
  const wnd = app.windows[0];
  wnd.flushFrame?.();
  await tick();
  return { app, root, wnd, node: wnd._reactX11Node };
}

// --- a self-painting element in the chain -----------------------------------

test('a painted element scrolls on the wheel with no prop handler', async () => {
  const ref = React.createRef();
  const { wnd } = await mount(
    h('miniedit', { ref, lines: 40, style: { width: 200, height: 100 } }),
  );
  const editor = ref.current;

  assert.equal(editor.contentHeight, 40 * LINE, 'the override was asked');
  assert.ok(editor.canScroll(0, 1), 'and it has somewhere to go');

  wheel(wnd, 50, 50);
  await tick();
  assert.equal(editor.scrollY, 48, 'one notch, through the default action');

  wnd.flushFrame?.();
  await tick();
  assert.ok(
    editor.painted.some((p) => p.y === 48),
    'and the element painted at the offset it was scrolled to',
  );
});

test('the two methods on their own are enough to join the chain', async () => {
  const ref = React.createRef();
  const { wnd } = await mount(
    h('miniterm', { ref, lines: 40, style: { width: 200, height: 100 } }),
  );
  wheel(wnd, 50, 50);
  await tick();
  assert.equal(ref.current.scrolled, 48);
});

test('an app handler still gets the wheel first, and can veto it', async () => {
  const ref = React.createRef();
  const seen = [];
  const { wnd } = await mount(
    h('miniedit', {
      ref,
      lines: 40,
      onWheel: (ev) => {
        seen.push(ev.deltaY);
        ev.preventDefault();
      },
      style: { width: 200, height: 100 },
    }),
  );
  wheel(wnd, 50, 50);
  await tick();
  assert.deepEqual(seen, [48], 'the handler ran');
  assert.equal(ref.current.scrollY, 0, 'preventDefault kept the default off');
});

// --- chaining ---------------------------------------------------------------

/** The editor over a tall sibling, so the window always has somewhere to go
 * and only the editor's own content decides who takes the wheel. */
const nested = (ref, lines) => [
  h('miniedit', {
    key: 'edit',
    ref,
    lines,
    style: { width: 200, height: 60, flexShrink: 0 },
  }),
  h('box', { key: 'tail', style: { height: 400, flexShrink: 0 } }),
];

test('a painted element with nothing to scroll passes the wheel outward', async () => {
  const ref = React.createRef();
  const { wnd, node } = await mount(nested(ref, 2), {
    style: { overflow: 'scroll' },
  });
  assert.equal(ref.current.canScroll(0, 1), false, 'two lines fit');

  wheel(wnd, 50, 20); // over the editor
  await tick();
  assert.equal(ref.current.scrollY, 0);
  assert.equal(node.scrollY, 48, 'the window answered it instead');
});

test('…and keeps it while it has somewhere to go', async () => {
  const ref = React.createRef();
  const { wnd, node } = await mount(nested(ref, 40), {
    style: { overflow: 'scroll' },
  });
  wheel(wnd, 50, 20);
  await tick();
  assert.equal(ref.current.scrollY, 48);
  assert.equal(node.scrollY, 0, 'the window did not also move');
});

// --- what the mixin brings with it ------------------------------------------

test('painted content gets the bars, the keys and the scroll-pane role', async () => {
  const ref = React.createRef();
  const { app, wnd } = await mount(
    h('miniedit', { ref, lines: 40, style: { width: 200, height: 100 } }),
  );
  const editor = ref.current;

  const bar = editor._scrollbar('y');
  assert.ok(bar, 'a vertical bar');
  assert.ok(
    bar.thumbLength < bar.trackLength,
    'a thumb sized from the painted extent',
  );

  assert.equal(editor.focusableByDefault, true, 'a tab stop, being scrollable');
  assert.equal(atspiRoleOf(editor), ATSPI_ROLE.SCROLL_PANE);

  editor.focus();
  await tick();
  pressKey(app, wnd, XK_PAGE_DOWN);
  await tick();
  assert.ok(editor.scrollY > 0, 'PageDown paged the painted content');
});

test('a horizontal extent it reports is one the wheel can reach', async () => {
  const ref = React.createRef();
  const { wnd } = await mount(
    h('miniedit', {
      ref,
      lines: 1,
      columns: 20,
      style: { width: 200, height: 100 },
    }),
  );
  assert.equal(ref.current.canScroll(0, 1), false, 'nothing vertical');
  wheel(wnd, 50, 50, { deltaX: 1, deltaY: 0 }); // a notch to the right
  await tick();
  assert.ok(ref.current.scrollX > 0);
});

test('a nonsense measurement names the element instead of spreading NaNs', async () => {
  const ref = React.createRef();
  const { node, root } = await mount(
    h('miniedit', { ref, lines: 40, style: { width: 200, height: 100 } }),
  );
  const honest = ref.current.measureScrollContent;
  // A NaN content extent does not throw on its own: it becomes a NaN max
  // scroll, a NaN offset and a subtree laid out at NaN, with nothing saying
  // which element produced it.
  ref.current.measureScrollContent = () => ({ width: 0, height: undefined });
  ref.current.invalidate(true, ref.current, 'scroll');
  assert.throws(
    () => node.flush(),
    /<miniedit>\.measureScrollContent\(\) must return \{ width, height \}/,
  );

  // …and the frame the throw abandoned is still queued: put the honest
  // measurement back before it runs, or it takes the process with it.
  ref.current.measureScrollContent = honest;
  await root.unmount();
});

// --- core's own self-painting scroller --------------------------------------
//
// `<textarea>` was the `kind === 'textarea'` branch in the wheel's default
// action, which is what said the protocol was missing a member. It is a
// member now, and these two tests are the halves of that: it takes the
// wheel through `canScroll`/`scrollBy`, and it lets go of it when there is
// nothing left to take — which the old branch never did.

/** A real (in-process) X server, because a textarea's scroll extent comes
 * out of shaped text and the mock connection has no fonts. */
async function headlessApp() {
  const require = createRequire(import.meta.url);
  const fontDir = join(
    dirname(require.resolve('katex/package.json')),
    'dist',
    'fonts',
  );
  const server = xserver.createServer({ width: 400, height: 400 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const fontSource = new StaticFontSource();
  fontSource.add(readFileSync(join(fontDir, 'KaTeX_Main-Regular.ttf')), {
    family: 'Test Main',
  });
  fontSource.alias('sans-serif', 'Test Main');
  return createClient({ stream: clientEnd, fontSource });
}

test('the wheel scrolls a <textarea> with no branch naming it', async () => {
  const app = await headlessApp();
  const root = await createRoot({ app });
  try {
    const ref = React.createRef();
    root.render(
      h(
        'window',
        { width: 240, height: 200 },
        h('textarea', {
          ref,
          rows: 3,
          defaultValue: Array.from({ length: 30 }, (_, i) => `line ${i}`).join(
            '\n',
          ),
        }),
      ),
    );
    await tick();
    const wnd = app.windows?.[0] ?? ref.current.root.window;
    ref.current.root.flush();

    assert.equal(ref.current.canScroll(0, 48), true, 'it says so itself');
    assert.equal(ref.current.canScroll(48, 0), false, 'and only vertically');

    wheel(wnd, 20, 20);
    await tick();
    assert.ok(ref.current._scrollY > 0, 'the wheel reached it');
  } finally {
    await root.unmount();
    await app.close();
  }
});

test('a <textarea> whose text fits hands the wheel to the pane behind it', async () => {
  const app = await headlessApp();
  const root = await createRoot({ app });
  try {
    const ref = React.createRef();
    const area = React.createRef();
    root.render(
      h(
        'window',
        { width: 240, height: 120, style: { overflow: 'scroll' } },
        h('textarea', { ref: area, rows: 3, defaultValue: 'one line' }),
        h('box', { ref, style: { height: 400, flexShrink: 0 } }),
      ),
    );
    await tick();
    const node = area.current.root;
    node.flush();
    const wnd = app.windows?.[0] ?? node.window;

    assert.equal(area.current.canScroll(0, 48), false, 'one line fits');
    wheel(wnd, 20, 20); // over the field
    await tick();
    assert.equal(area.current._scrollY, 0);
    assert.equal(node.scrollY, 48, 'the window answered it instead');
  } finally {
    await root.unmount();
    await app.close();
  }
});

// `Node.anchorScrollBy()` — an element whose content moved under the
// viewport of the scroll pane it is in, in the layout pass running now, has
// the pane's offsets follow it, so what the viewport showed stays where it
// is on screen (CSS Scroll Anchoring 1): a document laid out again at
// another width, whose text above the fold broke into more lines or fewer.
// On the mock app.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import React from 'react';

import { registerElement, unregisterElement } from '../src/host.js';
import { createRoot } from '../src/index.js';
import { Node } from '../src/node.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** A document as tall as `length` and as wide as `across`, which says from inside its measure that
 *  its content moved by `shift` device pixels — once, for the pass that
 *  measures it next. */
class AnchorDocNode extends Node {
  constructor(props, app) {
    super('anchordoc', props, app);
    this.shift = null;
    this.took = null;
  }

  applyProps(next, prev) {
    super.applyProps(next, prev);
    if (next.length !== prev?.length || next.across !== prev?.across) {
      this.invalidateMeasure('content');
    }
  }

  measureContent() {
    if (this.shift) {
      const { x, y } = this.shift;
      this.shift = null;
      this.took = this.anchorScrollBy(x, y);
    }
    return { width: this.props.across ?? 300, height: this.props.length };
  }
}

registerElement('anchordoc', {
  create: (props, app) => new AnchorDocNode(props, app),
});
process.on('exit', () => unregisterElement('anchordoc'));

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await root.unmount();
});

async function mount({ scrolls = true, direction, wide = false } = {}) {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  roots.push(x11Root);
  const pane = React.createRef();
  const doc = React.createRef();
  const scrolled = [];
  const render = (length, across) =>
    x11Root.render(
      h(
        'window',
        { width: 400, height: 400 },
        h(
          'box',
          {
            ref: pane,
            style: {
              overflow: scrolls ? 'scroll' : 'hidden',
              flexGrow: 1,
              ...(direction ? { direction } : null),
              ...(wide ? { flexDirection: 'row' } : null),
            },
            onScroll: (ev) => scrolled.push({ x: ev.scrollX, y: ev.scrollY }),
          },
          h('anchordoc', {
            ref: doc,
            length,
            across,
            style: { flexShrink: 0 },
          }),
        ),
      ),
    );
  render(2000, wide ? 1500 : undefined);
  const wnd = app.windows[0];
  await tick();
  return { wnd, render, pane, doc, scrolled };
}

test('a shift asked from inside the layout pass moves the offsets in that pass', async () => {
  const { wnd, render, pane, doc, scrolled } = await mount();
  pane.current.scrollTo(300);
  wnd._reactX11Node.flush();
  await tick();
  assert.equal(pane.current.scrollY, 300);
  scrolled.length = 0;
  // 120 more pixels above the fold, laid out in the pass the length
  // changes in: the offsets follow them, before anything is placed
  doc.current.shift = { x: 0, y: 120 };
  render(2120);
  await tick();
  wnd._reactX11Node.flush();
  assert.equal(doc.current.took, true, 'a pane took it');
  assert.equal(pane.current.scrollY, 420);
  // and the document is placed where that offset puts it, in the same pass
  assert.equal(doc.current.abs.y, -420);
  await tick();
  assert.deepEqual(scrolled.at(-1), { x: 0, y: 420 }, 'onScroll hears of it');
});

test('a shift is clamped to what the pane holds, and a scrollTo in the same frame lands after it', async () => {
  const { wnd, render, pane, doc } = await mount();
  pane.current.scrollTo(1500);
  wnd._reactX11Node.flush();
  await tick();
  // the content shrank under the offset as it moved: clamped to the end
  doc.current.shift = { x: 0, y: 400 };
  render(1800);
  await tick();
  wnd._reactX11Node.flush();
  assert.equal(pane.current.scrollY, 1800 - 400);
  // an application's scroll in the frame is the one that stands
  doc.current.shift = { x: 0, y: -200 };
  render(1900);
  pane.current.scrollTo(100);
  await tick();
  wnd._reactX11Node.flush();
  assert.equal(pane.current.scrollY, 100);
});

test('a shift asked outside a pass waits for the next, and asks for it', async () => {
  const { wnd, pane, doc } = await mount();
  pane.current.scrollTo(200);
  wnd._reactX11Node.flush();
  await tick();
  assert.equal(doc.current.anchorScrollBy(0, 30), true);
  assert.equal(doc.current.anchorScrollBy(0, 12), true, 'shifts add up');
  assert.equal(pane.current.scrollY, 200, 'not before a pass');
  assert.equal(wnd._reactX11Node.needsLayout, true, 'one is owed');
  wnd._reactX11Node.flush();
  assert.equal(pane.current.scrollY, 242);
});

test('nothing takes a shift where nothing scrolls the element', async () => {
  const { wnd, render, doc } = await mount({ scrolls: false });
  doc.current.shift = { x: 0, y: 50 };
  render(2050);
  await tick();
  wnd._reactX11Node.flush();
  assert.equal(doc.current.took, false);
  assert.equal(doc.current.anchorScrollBy(0, 10), false);
  assert.equal(doc.current.anchorScrollBy(NaN, 10), false);
});

test('across a right-to-left pane the offset follows the content the other way', async () => {
  const { wnd, render, pane, doc } = await mount({
    direction: 'rtl',
    wide: true,
  });
  pane.current.scrollTo({ x: 300 });
  wnd._reactX11Node.flush();
  await tick();
  assert.equal(pane.current.scrollX, 300);
  // the content moved 40 to the left under the viewport, towards its end:
  // `scrollX` is a distance from the start, which is the right edge here
  doc.current.shift = { x: -40, y: 0 };
  render(2000, 1540);
  await tick();
  wnd._reactX11Node.flush();
  assert.equal(pane.current.scrollX, 340);
});

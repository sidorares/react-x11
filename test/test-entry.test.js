// The published test surface, tested through itself (issue #123).
//
// Everything here goes through `react-x11/test` the way a user's test would
// — no reaching into `src/nodes.js`, no hand-built harness — which is the
// point: if this file needs an internal, the entry point is missing
// something.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import React from 'react';

import {
  renderX11,
  cleanup,
  act,
  screen,
  within,
  fireEvent,
  userEvent,
  pixelAt,
  expectPixel,
  waitFor,
  waitForPixel,
  countPixels,
  withFrameClock,
  createMockApp,
  XK_RETURN,
  XK_ESCAPE,
  XK_DOWN,
  keysymOf,
} from '../src/testing/index.js';
import { Button, Select, Dialog } from '../src/index.js';

const h = React.createElement;
const require = createRequire(import.meta.url);
const FONT = join(
  dirname(require.resolve('katex/package.json')),
  'dist',
  'fonts',
  'KaTeX_Main-Regular.ttf',
);
const fonts = { 'sans-serif': FONT };

afterEach(cleanup);

test('renderX11 mounts against a real X server with no display', async () => {
  const { app, server, ctx, window } = await renderX11(
    h('box', { style: { flexGrow: 1, backgroundColor: '#2980b9' } }),
    { width: 200, height: 120, fonts },
  );
  assert.ok(server, 'an in-process X server');
  assert.ok(app.X, 'a real protocol connection');
  assert.strictEqual(window.width, 200);
  // the pixels are pixels the server composited, not a mock's op log
  await expectPixel(ctx, 100, 60, '#2980b9');
  await expectPixel(ctx, 5, 5, '#2980b9');
});

test('queries find nodes by text, role, placeholder and test name', async () => {
  const { getByText, queryByText, getByRole, getAllByRole, getByTestName } =
    await renderX11(
      h(
        'box',
        { style: { flexGrow: 1, padding: 8, gap: 6 } },
        h('text', null, 'Sign the guestbook'),
        h('textinput', {
          placeholder: 'Your name',
          'data-testname': 'name-field',
        }),
        h(Button, { label: 'Save' }),
        h(Button, { label: 'Cancel' }),
      ),
      { fonts },
    );

  assert.strictEqual(getByText('sign the guestbook').kind, 'text');
  assert.strictEqual(getByText(/guestbook/).kind, 'text');
  assert.strictEqual(queryByText('nothing here'), null);
  assert.strictEqual(getByRole('textbox').kind, 'textinput');
  assert.strictEqual(getByTestName('name-field').kind, 'textinput');
  assert.strictEqual(getAllByRole('button').length, 2);
  // and `screen` is the same queries bound to the last render
  assert.strictEqual(screen.getByRole('textbox').kind, 'textinput');

  // a miss says what was there instead of "undefined is not an object"
  assert.throws(
    () => getByText('Submit'),
    /no element found[\s\S]*The tree holds/,
    'the failure message shows the tree',
  );
  assert.throws(() => getByRole('button'), /found 2 elements/);
});

test('fireEvent injects through the server, so the real event path runs', async () => {
  const presses = [];
  const { getByRole, ctx } = await renderX11(
    h(
      'box',
      { style: { flexGrow: 1, padding: 10 } },
      h(Button, {
        primary: true,
        label: 'Go',
        onPress: (ev) => presses.push([ev.type, ev.button, ev.shiftKey]),
      }),
    ),
    { fonts, width: 240, height: 90 },
  );
  const button = getByRole('button');

  // hovering repaints, and it is a repaint rather than a render: the pointer
  // starts at the middle of the screen, well away from the button
  const at = { x: button.abs.x + 6, y: button.abs.y + 6 };
  const away = await pixelAt(ctx, at.x, at.y);
  await userEvent.hover(button);
  // `waitFor`, not a bare read: a hover on `Button` is React state, so the
  // repaint is a motion event off the wire, a re-render, and a frame — and
  // `waitFor` advances between attempts rather than sleeping through them
  await waitFor(async () =>
    assert.notDeepStrictEqual(
      await pixelAt(ctx, at.x, at.y),
      away,
      'the hover repainted',
    ),
  );

  // a click is delivered with a real button number
  await userEvent.click(button);
  assert.deepStrictEqual(presses, [['click', 1, false]]);

  // and a modifier arrives as a real X modifier mask bit, which is what
  // proves the press went through src/events.js rather than around it
  await userEvent.click(button, { modifiers: ['Shift'] });
  assert.deepStrictEqual(presses.at(-1), ['click', 1, true]);
});

test('userEvent.type sends real keys, including ones the layout lacks', async () => {
  let submits = 0;
  const { getByRole } = await renderX11(
    h('textinput', {
      defaultValue: '',
      onSubmit: () => submits++,
      style: { flexGrow: 1 },
    }),
    { fonts, height: 60 },
  );

  // 'é' is not on the server's default US layout — the harness binds a spare
  // keycode for it on both sides, so a test can type real text
  await userEvent.type(getByRole('textbox'), 'héllo\n');
  assert.strictEqual(getByRole('textbox').value, 'héllo');
  assert.strictEqual(submits, 1, '\\n is Return, so it submitted');

  // capitals go through a real Shift press, not a different keysym
  await userEvent.type(getByRole('textbox'), 'X', { skipClick: true });
  assert.strictEqual(getByRole('textbox').value, 'hélloX');
});

test('keys reach the focused node, and Tab moves focus', async () => {
  const { getAllByRole } = await renderX11(
    h(
      'box',
      { style: { flexGrow: 1, gap: 4 } },
      h('textinput', { autoFocus: true, style: { height: 24 } }),
      h('textinput', { style: { height: 24 } }),
    ),
    { fonts },
  );
  const [first, second] = getAllByRole('textbox');
  assert.strictEqual(first.focused, true, 'autoFocus won');

  await userEvent.tab();
  assert.strictEqual(second.focused, true);
  await userEvent.tab({ shift: true });
  assert.strictEqual(first.focused, true);
});

// The capability the old harness could not reach at all: input that goes
// through the server exercises grabs and focus traps, so a popup dismisses
// the way it does for a user.
test('a press outside a grabbing popup dismisses it', async () => {
  const Menu = () => {
    const [open, setOpen] = React.useState(true);
    return h(
      'box',
      { style: { flexGrow: 1 } },
      h('text', { 'data-testname': 'backdrop' }, 'behind'),
      open &&
        h(
          'popup',
          {
            x: 20,
            y: 20,
            width: 100,
            height: 60,
            grab: true,
            onDismiss: () => setOpen(false),
            style: { backgroundColor: '#ffffff' },
          },
          h('text', { 'data-testname': 'in-popup' }, 'menu'),
        ),
    );
  };
  const { queryByTestName, getByTestName } = await renderX11(h(Menu), {
    fonts,
    width: 300,
    height: 200,
  });
  assert.ok(queryByTestName('in-popup'), 'the popup is up');

  // A press on one of the client's *own* windows is delivered normally —
  // the grab uses owner-events, which is what keeps submenus working. Only a
  // press the client does not own reaches the grab holder, so that is what
  // dismisses, and `clickOutside` is how a test says it.
  await userEvent.click(getByTestName('backdrop'));
  assert.ok(queryByTestName('in-popup'), 'a press inside the app does not');

  await userEvent.clickOutside();
  assert.strictEqual(queryByTestName('in-popup'), null, 'onDismiss closed it');
});

test('Select opens a real popup window and picking closes it', async () => {
  const picked = [];
  const Wrapper = () => {
    const [value, setValue] = React.useState(null);
    return h(Select, {
      value,
      options: ['alpha', 'beta'],
      onChange: (ev) => {
        picked.push(ev.value);
        setValue(ev.value);
      },
      style: { width: 160 },
    });
  };
  const { getByRole, windowNode } = await renderX11(h(Wrapper), {
    fonts,
    width: 300,
    height: 200,
  });

  await userEvent.click(getByRole('combobox'));
  // the menu is a <popup>, a child node of the window, so the queries reach
  // into it without any special casing
  const options = within(windowNode).getAllByRole('option');
  assert.strictEqual(options.length, 2, 'the menu is open and queryable');

  await userEvent.click(options[1]);
  assert.deepStrictEqual(picked, ['beta']);
  assert.strictEqual(
    within(windowNode).queryAllByRole('option').length,
    0,
    'picking closed the popup',
  );
});

test('Escape closes a Dialog, through the focus trap', async () => {
  const Wrapper = () => {
    const [open, setOpen] = React.useState(true);
    return h(
      'box',
      { style: { flexGrow: 1 } },
      h(
        Dialog,
        {
          open,
          title: 'Really?',
          managed: false,
          onClose: () => setOpen(false),
        },
        h('text', { 'data-testname': 'dialog-body' }, 'body'),
      ),
    );
  };
  const { queryByTestName } = await renderX11(h(Wrapper), {
    fonts,
    width: 400,
    height: 300,
  });
  assert.ok(queryByTestName('dialog-body'));
  await userEvent.key(XK_ESCAPE);
  assert.strictEqual(queryByTestName('dialog-body'), null);
});

test('withFrameClock drives a transition instead of sleeping through it', async () => {
  // Installed *before* the render, so every timestamp in this tree comes from
  // the same clock — mixing a real start time with a fake `now` gives a
  // transition that never progresses.
  const clock = withFrameClock();
  const Fading = ({ on }) =>
    h('box', {
      role: 'target',
      style: {
        width: 60,
        height: 30,
        backgroundColor: on ? '#000000' : '#ffffff',
        transition: { backgroundColor: 200 },
      },
    });
  const { getByRole, ctx, rerender } = await renderX11(
    h(Fading, { on: false }),
    {
      fonts,
      width: 200,
      height: 100,
    },
  );
  const target = getByRole('target');
  const at = { x: target.abs.x + 5, y: target.abs.y + 5 };
  const grey = async () => (await pixelAt(ctx, at.x, at.y))[0];

  assert.strictEqual(await grey(), 255, 'white before the change');

  await rerender(h(Fading, { on: true }));
  assert.strictEqual(await grey(), 255, 'and still white at t=0');

  clock.advance(100);
  await act();
  const half = await grey();
  assert.ok(half < 255 && half > 0, `part way through the fade, got ${half}`);

  clock.advance(200);
  await act();
  await expectPixel(ctx, at.x, at.y, '#000000', { tolerance: 4 });

  // and nothing moves on its own: real time passing changes nothing while
  // the clock is held, which is the whole guarantee
  const frozen = await grey();
  await new Promise((r) => setTimeout(r, 60));
  await act();
  assert.strictEqual(await grey(), frozen);

  clock.restore();
});

test('pixel helpers: waitForPixel, countPixels and toPNG', async () => {
  const Late = () => {
    const [on, setOn] = React.useState(false);
    React.useEffect(() => {
      const id = setTimeout(() => setOn(true), 30);
      return () => clearTimeout(id);
    }, []);
    return h('box', {
      style: {
        flexGrow: 1,
        backgroundColor: on ? '#c0392b' : '#ffffff',
      },
    });
  };
  const { ctx } = await renderX11(h(Late), { fonts, width: 80, height: 40 });

  // the state change lands on its own schedule; `act` after the timer fires
  // runs the frame it scheduled, and waitForPixel confirms it reached the
  // server rather than only the tree
  await new Promise((r) => setTimeout(r, 60));
  await act();
  await waitForPixel(ctx, 40, 20, '#c0392b', { timeout: 2000 });

  const red = await countPixels(ctx, { width: 80, height: 40 }, '#c0392b');
  assert.strictEqual(red, 80 * 40, 'the whole window is the fill colour');

  const png = await toPNGBuffer(ctx);
  assert.strictEqual(png.subarray(1, 4).toString('latin1'), 'PNG');
});

async function toPNGBuffer(ctx) {
  const { toPNG } = await import('../src/testing/index.js');
  return toPNG(ctx, null, { width: 80, height: 40 });
}

test("the 'mock' backend needs no server, and says so if you inject", async () => {
  const { app, server, getByText } = await renderX11(
    h('box', { style: { flexGrow: 1 } }, h('text', null, 'headless')),
    { backend: 'mock' },
  );
  assert.strictEqual(server, null);
  assert.ok(app.windows.length >= 1, 'the mock app recorded the window');
  assert.ok(getByText('headless'));
  assert.throws(
    () => fireEvent.click(getByText('headless')),
    /needs the in-process X server/,
  );
});

test('createMockApp is exported, so the op-log harness is reachable too', () => {
  const app = createMockApp();
  assert.strictEqual(typeof app.createWindow, 'function');
});

test('keysymOf follows the Latin-1 and Unicode rules', () => {
  assert.strictEqual(keysymOf('a'), 0x61);
  assert.strictEqual(keysymOf('é'), 0xe9, 'Latin-1 is identity');
  assert.strictEqual(keysymOf('я'), 0x0100044f, 'Unicode keysyms are offset');
  assert.strictEqual(XK_RETURN, 0xff0d);
  assert.strictEqual(XK_DOWN, 0xff54);
});

test('cleanup closes every server, so a suite does not leak them', async () => {
  const a = await renderX11(h('box', { style: { flexGrow: 1 } }), { fonts });
  const b = await renderX11(h('box', { style: { flexGrow: 1 } }), { fonts });
  assert.notStrictEqual(a.server, b.server);
  await cleanup();
  // a closed connection refuses new work rather than hanging
  assert.strictEqual(a.windowNode.destroyed, true);
  assert.strictEqual(b.windowNode.destroyed, true);
});

test('a drag and drop gesture is drivable through the published surface', async () => {
  // The pattern documented in docs/drag-and-drop.md and docs/testing.md:
  // three real pointer events, with the 4px threshold honoured. Pinned here
  // so the documented snippet cannot rot silently.
  const log = [];
  const item = { id: 7 };
  const { windowNode } = await renderX11(
    h(
      'box',
      { style: { flexGrow: 1 } },
      h('box', {
        draggable: true,
        dragData: { 'application/x-row': item },
        onDragStart: () => log.push('start'),
        onDragEnd: (ev) => log.push(['end', ev.action, ev.dropped]),
        style: {
          position: 'absolute',
          left: 0,
          top: 0,
          width: 100,
          height: 100,
        },
      }),
      h('box', {
        dropAccept: ['application/x-row'],
        onDrop: (ev) => log.push(['drop', ev.items['application/x-row']]),
        style: {
          position: 'absolute',
          left: 200,
          top: 0,
          width: 150,
          height: 150,
        },
      }),
    ),
    { fonts },
  );
  const nodes = [];
  const walk = (node) => {
    nodes.push(node);
    for (const child of node.children ?? []) walk(child);
  };
  walk(windowNode);
  const card = nodes.find((n) => n.props?.draggable);
  const bin = nodes.find((n) => n.props?.dropAccept);

  await act(async () => {
    fireEvent.mouseDown(card);
    fireEvent.mouseMove(card, { dx: 8 }); // past the threshold, still on the card
    fireEvent.mouseMove(bin);
    fireEvent.mouseUp(bin);
  });
  await waitFor(() => log.some((entry) => entry[0] === 'end'));

  assert.strictEqual(log[0], 'start');
  assert.deepStrictEqual(
    log.find((entry) => entry[0] === 'drop'),
    ['drop', item],
    'the in-app payload arrives by reference',
  );
  assert.deepStrictEqual(log.at(-1), ['end', 'copy', true]);
});

test('the wheel is drivable both ways: notches, and a touchpad', async () => {
  const deltas = [];
  const { windowNode } = await renderX11(
    h(
      'box',
      {
        style: { overflow: 'scroll', flexGrow: 1 },
        onWheel: (ev) => deltas.push([ev.deltaY, ev.smooth]),
      },
      ...Array.from({ length: 20 }, (_, i) =>
        h('box', { key: i, style: { height: 40, flexShrink: 0 } }),
      ),
    ),
    { fonts, width: 200, height: 200 },
  );
  const pane = windowNode.children[0];

  // whole notches go through the server as the button presses X has
  await userEvent.wheel(pane, { deltaY: 2 });
  assert.deepStrictEqual(deltas, [
    [48, false],
    [48, false],
  ]);
  assert.strictEqual(pane.scrollY, 96);

  // and a touchpad reports a fraction of one, which no button could
  await userEvent.wheel(pane, { deltaY: 0.5, smooth: true });
  assert.deepStrictEqual(deltas.at(-1), [24, true]);
  assert.strictEqual(pane.scrollY, 120);
});

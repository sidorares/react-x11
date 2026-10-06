// The published test surface, tested through itself (issue #123).
//
// Everything here goes through `react-x11/test` the way a user's test would
// — no reaching into `src/nodes/`, no hand-built harness — which is the
// point: if this file needs an internal, the entry point is missing
// something.
import { test, afterEach, describe } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  settle,
  waitFor,
  waitForPixel,
  countPixels,
  withFrameClock,
  setAppearance,
  createMockApp,
  XK_RETURN,
  XK_ESCAPE,
  XK_DOWN,
  keysymOf,
} from '../src/testing/index.js';
import { Button, Select, Dialog, useSystemAppearance } from '../src/index.js';

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

// A dialog in an application that opens its **own** `<window>`, which is
// every application there is — and, through `renderX11`, the harness's
// window with the app's one inside it. That second window is the whole of
// what issue #331 was: the field focused, drew its ring, and typed nothing,
// because the keys the server handed to the outer window were dispatched
// against a manager that had no focused node in it.
//
// Everything here fails on the commit before this one, and the reason each
// one is here is that the failure is not narrow: a `<textinput>`, a
// `<textarea>` and a `Button`'s Space are three different default actions
// off the same missing route.
describe('keys reach a Dialog opened by an app with its own <window>', () => {
  const JoinApp = ({ open = true, onClose = () => {}, onJoin = () => {} }) => {
    const [channel, setChannel] = React.useState('');
    const [topic, setTopic] = React.useState('');
    return h(
      'window',
      { width: 480, height: 340, title: 'app' },
      h('textinput', {
        placeholder: 'composer',
        style: { height: 28 },
      }),
      h(
        Dialog,
        {
          open,
          title: 'Join a channel',
          onClose,
          actions: h(Button, { label: 'Join', onPress: () => onJoin(channel) }),
        },
        h('textinput', {
          autoFocus: true,
          placeholder: '#channel',
          value: channel,
          onChange: (ev) => setChannel(ev.value),
          style: { height: 28 },
        }),
        h('textarea', {
          placeholder: 'why',
          value: topic,
          onChange: (ev) => setTopic(ev.value),
          style: { height: 48 },
        }),
      ),
    );
  };

  const mount = (props) => renderX11(h(JoinApp, props), { fonts });

  test('a <textinput> inside it types, and reports what was typed', async () => {
    const { getByPlaceholder } = await mount();
    const field = getByPlaceholder('#channel');
    assert.strictEqual(field.focused, true, 'autoFocus took focus');
    await userEvent.type(field, '#x11');
    assert.strictEqual(field.value, '#x11');
  });

  test('so does a <textarea>', async () => {
    const { getByPlaceholder } = await mount();
    const area = getByPlaceholder('why');
    await userEvent.type(area, 'hi');
    assert.strictEqual(area.value, 'hi');
  });

  test("and Space activates a Button's default action", async () => {
    const joined = [];
    const { getByPlaceholder, getByRole } = await mount({
      onJoin: (name) => joined.push(name),
    });
    await userEvent.type(getByPlaceholder('#channel'), '#x11');
    getByRole('button', { name: 'Join' }).focus();
    await userEvent.key(keysymOf(' '));
    assert.deepStrictEqual(joined, ['#x11']);
  });

  test('Tab moves between the fields and stays in the dialog', async () => {
    const { getByPlaceholder, getByRole } = await mount();
    const field = getByPlaceholder('#channel');
    const area = getByPlaceholder('why');
    const composer = getByPlaceholder('composer');
    await userEvent.tab();
    assert.strictEqual(area.focused, true, 'Tab reached the second field');
    await userEvent.tab();
    assert.strictEqual(
      getByRole('button', { name: 'Join' }).focused,
      true,
      'then the action button',
    );
    await userEvent.tab();
    assert.strictEqual(field.focused, true, 'and wrapped back to the first');
    assert.strictEqual(
      composer.focused,
      false,
      'the trap held — Tab never left the dialog',
    );
  });

  test('and Escape still closes it', async () => {
    const closed = [];
    await mount({ onClose: () => closed.push('close') });
    await userEvent.key(XK_ESCAPE);
    assert.deepStrictEqual(closed, ['close']);
  });
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

// **What `waitFor` and `findBy*` resolve with is laid out.** A row that
// arrives on its own schedule — an fs read, a socket, here a timer — commits
// outside any act(), on React's own scheduler, and the frame that lays it
// out runs on the window's clock after that. An attempt in between found the
// row before it had a rect, so the click that came next threw "has no
// laid-out rect yet": with its directory read held back 0-40 ms, 6 of 82
// waits for a `<FileDialog>`'s listing came back that way (#904).
describe('what waitFor and findBy* resolve with is laid out', () => {
  // A listing fed from outside React, which says when React has committed
  // what it was handed
  function lateListing() {
    let setRows = null;
    const committed = [];
    function Listing({ onPick }) {
      const [rows, set] = React.useState([]);
      React.useEffect(() => {
        setRows = set;
      }, []);
      // inside the commit, so a test resumed from here is ahead of any frame
      React.useLayoutEffect(() => {
        for (const resolve of committed.splice(0)) resolve();
      }, [rows]);
      return h(
        'box',
        { style: { flexGrow: 1, padding: 8, gap: 4 } },
        rows.map((name) =>
          h(
            'box',
            { key: name, onClick: () => onPick(name) },
            h('text', null, name),
          ),
        ),
      );
    }
    return {
      Listing,
      /** Hand it `rows` in `ms`, from a timer; resolves once committed. */
      deliverIn: (ms, rows) =>
        new Promise((resolve) => {
          setTimeout(() => {
            committed.push(resolve);
            setRows(rows);
          }, ms);
        }),
    };
  }

  async function mount(options = {}) {
    const feed = lateListing();
    const picked = [];
    await renderX11(h(feed.Listing, { onPick: (name) => picked.push(name) }), {
      fonts,
      ...options,
    });
    return { feed, picked };
  }

  test('when the row lands between two attempts', async () => {
    // Two frames a second: a display slower than waitFor polls — a remote
    // one, a runner under load — so no frame lays the row out by luck
    // between its commit and the attempt that finds it
    const { feed, picked } = await mount({ frameRate: 2 });
    feed.deliverIn(20, ['late row']);
    // and a long interval, so the row lands in the sleep between two
    // attempts rather than in the act() before it, which would lay it out
    const row = await waitFor(() => screen.getByText('late row'), {
      interval: 50,
    });
    assert.ok(row.abs.width > 0, 'waitFor resolved with a row not laid out');
    await userEvent.click(row);
    assert.deepStrictEqual(picked, ['late row']);
  });

  test('when it committed before the first attempt', async () => {
    const { feed, picked } = await mount();
    // The test resumes inside the task that committed the row, ahead of the
    // frame that commit asked for, so the first attempt finds it unlaid —
    // with no slow clock needed. An app's read that finished while the test
    // was busy elsewhere is the same state.
    await feed.deliverIn(5, ['late row']);
    const row = await waitFor(() => screen.getByText('late row'));
    assert.ok(row.abs.width > 0, 'waitFor resolved with a row not laid out');
    await userEvent.click(row);
    assert.deepStrictEqual(picked, ['late row']);
  });

  test('findBy* is getBy* under waitFor, so it holds there too', async () => {
    const { feed, picked } = await mount({ frameRate: 2 });
    feed.deliverIn(20, ['late row']);
    const row = await screen.findByText('late row', { interval: 50 });
    assert.ok(row.abs.width > 0, 'findByText resolved with a row not laid out');
    await userEvent.click(row);
    assert.deepStrictEqual(picked, ['late row']);
  });
});

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

// **A test can end its connection and still finish.** `act()`, `waitFor` and
// `cleanup()` all drain the connection with a round trip, and the last runs
// from an afterEach — so a test that ended it, the way a test of
// `onDisconnect` has to, failed in its teardown: a round trip on a connection
// the app closed rejected with "client is in closing state", and one on a
// connection the server ended waited for a reply that never came.
describe('a connection that has gone', () => {
  // a step that hangs fails here, by name, rather than at the suite's
  // timeout a minute later
  function settles(promise, step) {
    let timer;
    const late = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${step} hung`)), 5000);
    });
    return Promise.race([promise, late]).finally(() => clearTimeout(timer));
  }

  async function finish(api) {
    await settles(act(), 'act()');
    await settles(
      waitFor(() => true),
      'waitFor(), which acts after the attempt that passes',
    );
    let attempts = 0;
    await settles(
      waitFor(() => assert.ok(++attempts > 1)),
      'waitFor(), which acts between attempts',
    );
    await settles(cleanup(), 'cleanup()');
    assert.strictEqual(api.windowNode.destroyed, true, 'cleanup unmounted');
  }

  test('closed by the test', async () => {
    const api = await renderX11(h('box', { style: { flexGrow: 1 } }));
    await api.app.close();
    await finish(api);
  });

  test('closing, its close still in flight', async () => {
    const api = await renderX11(h('box', { style: { flexGrow: 1 } }));
    const closed = api.app.close();
    // in the task that began the close, so its round trip is not back yet
    // and the stream is still open
    await settles(settle(api.app), 'settle()');
    await finish(api);
    await closed;
  });

  test('disposed of, which ends the stream without closing', async () => {
    const api = await renderX11(h('box', { style: { flexGrow: 1 } }));
    api.app[Symbol.dispose]();
    await finish(api);
  });

  test('ended by the server, the disconnect an app is told of', async () => {
    const seen = [];
    const api = await renderX11(h('box', { style: { flexGrow: 1 } }), {
      onDisconnect: (reason) => seen.push(reason),
    });
    // what xkill does: the server drops the client that owns the window, and
    // answers nothing that client had in flight
    api.app.X.KillClient(api.window.id);
    // as docs/testing.md has it: the end has been heard once act() returns
    await settles(act(), 'act()');
    assert.deepStrictEqual(seen, ['closed'], 'the connection really ended');
    await finish(api);
  });

  test('settle() resolves on a connection that refuses the round trip', async () => {
    // for a reason settle() does not check for, which it need not know
    const refusing = {
      X: {
        GetInputFocus() {
          throw new Error('refused');
        },
      },
    };
    await settles(settle(refusing), 'settle()');
  });
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

// **The desktop's appearance, pinned and changed.** An app's component that
// follows reduced motion, contrast or the accent has to be testable the way
// one that follows the scheme is — first render and live change both — or
// its tests inject the value through a prop and test a different component.
describe("the desktop's appearance", () => {
  const seen = [];
  function Motion() {
    const { reducedMotion, colorScheme, source } = useSystemAppearance();
    seen.push(`${source}:${colorScheme}:${reducedMotion}`);
    return h('text', null, reducedMotion ? 'still' : 'moving');
  }

  test('a component reading reducedMotion re-renders when the pin changes', async () => {
    seen.length = 0;
    const { getByText, queryByText } = await renderX11(h(Motion), {
      fonts,
      colorScheme: 'dark',
      appearance: { reducedMotion: true },
    });
    // pinned from the very first render, not corrected a frame later
    assert.strictEqual(seen[0], 'test:dark:true');
    assert.ok(getByText('still'));

    await setAppearance({ reducedMotion: false });
    assert.ok(getByText('moving'));
    assert.strictEqual(queryByText('still'), null);
    // merged over the pin: naming one value kept the scheme
    assert.strictEqual(seen.at(-1), 'test:dark:false');

    await setAppearance({ reducedMotion: true });
    assert.ok(getByText('still'));
    assert.strictEqual(seen.at(-1), 'test:dark:true');
  });

  // The flush reaches the screen, not only React: the accent goes through
  // the palette into a `$token` the node tree resolves, and a pixel is the
  // only thing that proves the frame was painted.
  test('the change is painted by the time setAppearance resolves', async () => {
    const { ctx } = await renderX11(
      h('box', {
        style: { width: 40, height: 40, backgroundColor: '$accent' },
      }),
      { fonts, appearance: { accent: '#f7821b', contrast: 'high' } },
    );
    await expectPixel(ctx, 5, 5, '#f7821b', { tolerance: 2 });
    await setAppearance({ accent: '#1f9ede' });
    await expectPixel(ctx, 5, 5, '#1f9ede', { tolerance: 2 });
  });

  // A pinned value is the test's, and the remembered answer is the
  // developer's: running a suite must leave the file their next app starts
  // from as it found it.
  test('a pin never reaches the cache a real app starts from', async () => {
    const savedHome = process.env.XDG_CACHE_HOME;
    const savedOff = process.env.REACT_X11_NO_APPEARANCE_CACHE;
    const home = mkdtempSync(join(tmpdir(), 'rx11-test-pin-'));
    process.env.XDG_CACHE_HOME = home;
    delete process.env.REACT_X11_NO_APPEARANCE_CACHE;
    try {
      await renderX11(h(Motion), {
        fonts,
        colorScheme: 'dark',
        appearance: { reducedMotion: true, accent: '#f7821b' },
      });
      await setAppearance({ contrast: 'high' });
      await cleanup();
      assert.strictEqual(
        existsSync(join(home, 'react-x11', 'appearance.json')),
        false,
      );
    } finally {
      if (savedHome === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = savedHome;
      if (savedOff !== undefined) {
        process.env.REACT_X11_NO_APPEARANCE_CACHE = savedOff;
      }
      rmSync(home, { recursive: true, force: true });
    }
  });

  // Each of these would otherwise pass a test that proved nothing.
  test('a pin that would pin nothing, or be lost, throws', async () => {
    const box = h('box', { style: { flexGrow: 1 } });
    await assert.rejects(
      () => renderX11(box, { appearance: { reduceMotion: true } }),
      /no appearance value `reduceMotion`.*reducedMotion/s,
    );
    await assert.rejects(
      () => renderX11(box, { appearance: { reducedMotion: 'yes' } }),
      /`reducedMotion` is true or false/,
    );
    await assert.rejects(
      () => renderX11(box, { appearance: { source: 'portal' } }),
      /cannot set `source`/,
    );
    await assert.rejects(
      () =>
        renderX11(box, {
          colorScheme: 'system',
          appearance: { reducedMotion: true },
        }),
      /colorScheme: 'system'.*`appearance`/s,
    );
    await assert.rejects(
      () => renderX11(box, { colorScheme: 'Dark' }),
      /'light' \(the default\), 'dark' or 'system', not "Dark"/,
    );

    await renderX11(box, { fonts });
    await assert.rejects(
      () => setAppearance({ contrast: 'more' }),
      /`contrast` is 'normal' or 'high'/,
    );
    await cleanup();

    // Before a render, the render's own pin would replace it in silence
    await setAppearance({ reducedMotion: true });
    const err = await renderX11(box, { fonts }).then(
      () => assert.fail('the render should refuse'),
      (e) => e,
    );
    assert.match(err.message, /setAppearance\(\) was called before renderX11/);
    assert.match(err.message, /appearance: \{"reducedMotion":true\}/);
    // and the anchor it sends the developer to is there
    assert.match(err.message, /docs\/testing\.md#the-desktops-appearance/);
    const doc = readFileSync(
      fileURLToPath(new URL('../docs/testing.md', import.meta.url)),
      'utf8',
    );
    assert.match(doc, /^## The desktop's appearance$/m);
    // the refusal is spent: the next render is a plain one
    await renderX11(box, { fonts });
  });
});

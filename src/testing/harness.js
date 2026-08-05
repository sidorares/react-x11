// renderX11 / act / cleanup — the harness this repo's own tests kept
// rebuilding by hand, made supported.
//
// The unusual capability it publishes: a UI test here runs a **real X11
// protocol connection to a real X server**, in-process, in pure JavaScript,
// with no $DISPLAY and no xvfb — so it reads pixels back with GetImage and
// injects input through the server's own grab and focus machinery. That is
// node-x11's `lib/xserver`, and nothing about it is specific to CI.

import React from 'react';
import { createRoot } from '../Reconciler.js';
import { setAnimationClock } from '../nodes.js';
import { setAppearanceForTests } from '../appearance.js';

// x11 and pngjs arrive through ntk rather than as direct dependencies, so
// they are imported lazily: an app that never runs a pixel test should not
// pay for them, and a hoisting layout that hides them should say so clearly
// rather than fail with MODULE_NOT_FOUND from inside our code.
async function optional(specifier, why) {
  try {
    return await import(specifier);
  } catch (err) {
    throw new Error(
      `react-x11/test: could not load "${specifier}", which ${why}. It ships ` +
        `inside ntk's dependency tree, so this usually means a package ` +
        `manager that does not hoist — add "${specifier.split('/')[0]}" to ` +
        `your own devDependencies.\n${err.message}`,
      { cause: err },
    );
  }
}

/** Everything renderX11 created, so cleanup() can take it all down. */
const mounted = new Set();

const DEFAULT_WIDTH = 640;
const DEFAULT_HEIGHT = 480;
// The screen is deliberately bigger than the window, because on a real
// display it is: a press "outside the application" — what dismisses a menu —
// has nowhere to land otherwise.
const DEFAULT_SCREEN = { width: 1280, height: 800 };

/**
 * Drain in-flight request/reply chains. A GetInputFocus round trip is the
 * cheapest request with a reply, and its reply cannot arrive before every
 * request queued ahead of it has been processed — which is what makes it a
 * barrier rather than a sleep.
 */
export function settle(app, roundTrips = 2) {
  const X = app?.X;
  if (typeof X?.GetInputFocus !== 'function') return Promise.resolve();
  let chain = Promise.resolve();
  for (let i = 0; i < roundTrips; i++) {
    chain = chain.then(
      () =>
        new Promise((resolve) => {
          // resolve either way: a closing connection must not hang a test
          X.GetInputFocus(() => resolve());
        }),
    );
  }
  return chain;
}

async function createXServerApp({ screen, fonts }) {
  const [{ default: xserver }, ntk] = await Promise.all([
    optional('x11/lib/xserver/index.js', 'is the in-process X server'),
    import('ntk'),
  ]);
  const server = xserver.createServer({
    width: screen.width,
    height: screen.height,
  });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);

  let fontSource;
  if (fonts) {
    const { readFileSync } = await import('node:fs');
    fontSource = new ntk.StaticFontSource();
    for (const [family, file] of Object.entries(fonts)) {
      // `sans-serif: '/path/Inter.ttf'` reads as "this family is that file",
      // which is both the registration and the alias
      const registered = `react-x11-test:${family}`;
      fontSource.add(readFileSync(file), { family: registered });
      fontSource.alias(family, registered);
    }
  }
  const app = await ntk.createClient({ stream: clientEnd, fontSource });
  // fireEvent injects through the server, and all it is handed is a node —
  // so the connection carries the way back to the server that owns it
  app._reactX11TestServer = server;
  return { server, app };
}

/**
 * Mount a tree against a real in-process X server (or, with
 * `backend: 'mock'`, against a fake 2d context that logs draw operations
 * and needs no server at all).
 *
 * The element is wrapped in a `<window>` of the given size unless it *is* a
 * `<window>`, the same way Testing Library's `render` puts your component in
 * a container div. Pass `wrap: false` when a component of yours renders the
 * window itself.
 *
 * ```js
 * const { app, server, ctx, getByText, unmount } = await renderX11(<App />, {
 *   fonts: { 'sans-serif': '/usr/share/fonts/.../DejaVuSans.ttf' },
 * });
 * ```
 *
 * Pixel assertions need `fonts`: font-family resolution otherwise shells out
 * to `fc-match`, which is a different answer on every machine and no answer
 * at all in a container.
 */
export async function renderX11(element, options = {}) {
  const {
    width = DEFAULT_WIDTH,
    height = DEFAULT_HEIGHT,
    backend = 'xserver',
    screen: screenSize = {
      width: Math.max(
        DEFAULT_SCREEN.width,
        (options.width ?? DEFAULT_WIDTH) + 200,
      ),
      height: Math.max(
        DEFAULT_SCREEN.height,
        (options.height ?? DEFAULT_HEIGHT) + 200,
      ),
    },
    fonts = null,
    wrap = element?.type !== 'window',
    title = 'react-x11 test',
    colorScheme = 'light',
    ...rootOptions
  } = options;

  let server = null;
  let app = options.app ?? null;
  if (!app) {
    if (backend === 'mock') {
      const { createMockApp } = await import('./mock-app.js');
      app = createMockApp();
    } else {
      ({ server, app } = await createXServerApp({ screen: screenSize, fonts }));
    }
  }

  // **Pinned, and light by default.** react-x11's built-in palette follows
  // the desktop, so without this every pixel assertion in this suite and in
  // every application's would be a function of whose machine ran it — green
  // on a light desktop, red on a dark one, with nothing in the test saying
  // so. After the app exists, so it wins over `createMockApp`'s own pin.
  // `colorScheme: 'dark'` renders the other palette; `'system'` releases the
  // pin, for a test that is *about* what the desktop reports.
  setAppearanceForTests(
    colorScheme === 'system'
      ? null
      : colorScheme === 'dark'
        ? { colorScheme: 'dark' }
        : {},
  );

  const root = await createRoot({ app, ...rootOptions });
  const tree = wrap
    ? React.createElement('window', { width, height, title }, element)
    : element;

  const entry = {
    root,
    app,
    server,
    ownsApp: !options.app,
    unmounted: false,
    windowNode: null,
  };
  mounted.add(entry);

  await act(() => {
    // the render callback hands back the root child's public instance, which
    // for a `<window>` is the live ntk window — the only supported way in
    root.render(tree, (instance) => {
      entry.windowNode = instance?._reactX11Node ?? null;
    });
  }, entry);

  const windowNode = entry.windowNode;
  if (!windowNode?.isWindow) {
    throw new Error(
      'react-x11/test: renderX11 found no <window> at the root of the tree. ' +
        'Pass `wrap: false` only when your component renders one itself.',
    );
  }

  // **The harness plays the window manager**, because there is not one.
  //
  // Deciding which window gets the keyboard is a window manager's job, and
  // the in-process server has no WM — so the input focus stays wherever the
  // server started it (PointerRoot), and a key press goes to whatever the
  // pointer happens to be over. That makes `fireEvent.key` work only after
  // something moved the pointer, which is a rule nobody should have to
  // learn. One SetInputFocus at mount makes keyboard delivery deterministic
  // and matches what every real session does.
  if (server && typeof app.X?.SetInputFocus === 'function') {
    app.X.SetInputFocus(windowNode.window.id, 2 /* RevertToParent */);
    // And **wait for the event mask to reach the server before any input can
    // be injected.** ntk grows a window's mask lazily, from a `newListener`
    // hook: subscribing to `mousemove` is what selects PointerMotion. That
    // ChangeWindowAttributes is queued like any other request, but injection
    // is not a request — `server.injectPointerMove` runs *inside* the server
    // against whatever state it has right now. Get that ordering wrong and
    // the first hover of a test silently delivers nothing, which is a
    // miserable thing to debug. A macrotask plus a round trip is the barrier.
    await new Promise((resolve) => setImmediate(resolve));
    await settle(app);
  }

  const api = {
    root,
    app,
    server,
    /** The `WindowNode` the tree mounted into — the paint and event root. */
    windowNode,
    /** The live ntk `Window`. */
    window: windowNode?.window ?? null,
    /** Its 2d context, which is what pixel assertions read from. */
    get ctx() {
      return windowNode?.window?.getContext?.('2d') ?? null;
    },
    /** Re-render into the same root, then settle. */
    rerender: (next) =>
      act(() => {
        root.render(
          wrap
            ? React.createElement('window', { width, height, title }, next)
            : next,
        );
      }, entry),
    unmount: () => unmountEntry(entry),
  };
  return api;
}

/**
 * Every window node in a tree: the root one, plus nested `<window>`s and
 * every `<popup>` — a menu or a dialog is its own paint root and schedules
 * its own frames, so a flush that skipped them would leave a popup blank.
 */
export function windowNodesOf(node, out = []) {
  if (!node || node.destroyed) return out;
  if (node.isWindow) out.push(node);
  for (const child of node.children ?? []) windowNodesOf(child, out);
  return out;
}

/**
 * Flush everything that stands between a state update and a pixel.
 *
 * Three separate clocks, and a wrapper that drives only the first stays
 * flaky on pixel assertions:
 *
 * 1. **React's** — `React.act`, with `IS_REACT_ACT_ENVIRONMENT` set, so
 *    effects and passive work run before this returns.
 * 2. **ntk's frame clock** — painting is scheduled through
 *    `requestAnimationFrame`, which is paced behind a server fence. Driving
 *    events synthetically can leave a frame scheduled and never run, so the
 *    frame is run directly instead of waited for.
 * 3. **The X connection** — a round trip, so the server has actually
 *    processed the drawing before anything reads pixels back.
 */
export async function act(fn, only = null) {
  const entries = only ? [only] : [...mounted];
  const previous = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    await React.act(async () => {
      await fn?.();
    });
    // Anything just injected is **on the wire, not yet in the tree**: the
    // server writes events asynchronously, so a round trip on its own can
    // overtake them and `act` would return before the pointer move had been
    // dispatched at all — which looks exactly like a hover that does not
    // work. A macrotask lets those writes flush, the round trip confirms the
    // server consumed them, and the empty `act` afterwards flushes whatever
    // React work the dispatch produced.
    // Twice, because the path is two stages: the first round gets the event
    // off the wire and dispatched, the second lets the React update that
    // dispatch produced — `Button`'s hover state is React state, not a style
    // block — commit and settle. One round leaves that update in flight, and
    // React says so out loud ("An update to Button inside a test was not
    // wrapped in act(...)"), which is how this was found.
    for (let round = 0; round < 2; round++) {
      await React.act(async () => {
        await new Promise((resolve) => setImmediate(resolve));
        for (const entry of entries) await settle(entry.app);
      });
    }
  } finally {
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous;
  }
  for (const entry of entries) flushFrames(entry);
  for (const entry of entries) await settle(entry.app);
}

/** Run the frame the scheduler would have run, for every window in a root. */
function flushFrames(entry) {
  for (const node of windowNodesOf(entry.windowNode)) {
    if (!node.window) continue;
    // clearing `_scheduled` first: the scheduler treats it as "a frame is
    // already coming", and a frame run out of band has to hand that back or
    // the next invalidate schedules nothing
    node._scheduled = false;
    node.flush();
  }
}

async function unmountEntry(entry) {
  if (entry.unmounted) return;
  entry.unmounted = true;
  mounted.delete(entry);
  try {
    entry.root.unmount?.();
  } catch {
    // a root whose connection already died: nothing left to unmount
  }
  await settle(entry.app);
  if (entry.ownsApp) {
    try {
      await entry.app.close?.();
    } catch {
      // likewise
    }
  }
  entry.server?.close?.();
}

/**
 * Unmount everything `renderX11` mounted, restore the animation clock, and
 * close the connections and servers. Call it from an `afterEach`.
 *
 * Servers leaking is survivable at fifteen test files and is not at a
 * hundred and fifty — each one holds a socket pair and a paint surface.
 */
export async function cleanup() {
  restoreFrameClock();
  for (const entry of [...mounted]) await unmountEntry(entry);
  // Released **after** the roots are down, not before: releasing publishes a
  // change, every mounted root repaints on one, and a repaint scheduled onto
  // a connection that is about to close lands after it has.
  setAppearanceForTests(null);
}

// --- the animation clock ---------------------------------------------------

let clockInstalled = false;

/**
 * Drive transitions from a number you control instead of from wall-clock
 * time. `setAnimationClock` exists for exactly this; it was reachable only
 * through a deep import into `src/nodes.js`.
 *
 * ```js
 * const clock = withFrameClock();
 * fireEvent.mouseEnter(button);        // starts a 120ms hover transition
 * clock.advance(60);  await act();     // half way
 * clock.advance(60);  await act();     // arrived
 * clock.restore();
 * ```
 */
export function withFrameClock(startAt = 0) {
  let time = startAt;
  setAnimationClock(() => time);
  clockInstalled = true;
  return {
    get now() {
      return time;
    },
    advance(ms) {
      time += ms;
      return time;
    },
    set(ms) {
      time = ms;
      return time;
    },
    restore: restoreFrameClock,
  };
}

function restoreFrameClock() {
  if (!clockInstalled) return;
  clockInstalled = false;
  setAnimationClock(() => Date.now());
}

/**
 * Retry `fn` until it stops throwing, flushing between attempts.
 *
 * The tool for anything whose arrival is not a single deterministic step:
 * an async rich-content reflow, an image decode, a timer, or a repaint whose
 * cause travelled through the X connection and back. Each attempt is
 * preceded by an `act()`, so waiting also *advances* — this is not a sleep
 * with a condition on it.
 *
 * ```js
 * await waitFor(async () => {
 *   assert.notDeepStrictEqual(await pixelAt(ctx, x, y), before);
 * });
 * ```
 */
export async function waitFor(fn, { timeout = 2000, interval = 10 } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      last = err;
    }
    if (Date.now() >= deadline) throw last;
    await act();
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

/** Internal: the entries `fireEvent` and the queries resolve against. */
export function mountedEntries() {
  return [...mounted];
}

// fireEvent / userEvent — input injected through the **X server**, not
// emitted on the ntk window.
//
// This is the part the repo's own tests never had. Driving `wnd.emit(...)`
// skips `src/events.js` entirely: keycode→keysym resolution, modifier masks,
// wheel-from-buttons, click detail, pointer capture — and, on the server
// side, the grab and focus machinery that decides which window an event even
// reaches. Going through `server.injectButton` means a `<popup grab>` is
// dismissed by a real press outside it, `trapFocus` is exercised by real
// focus changes, and a test that passes has actually proved the path a user
// takes.
//
// Everything here is synchronous injection; the caller wraps it in `act()`
// to flush what it caused. `userEvent` does that itself, which is why it is
// async and `fireEvent` is not.

import { act } from './harness.js';
import { keysymOf, MOD, XK_RETURN } from '../keysyms.js';

/** The window node that owns a drawn node (a node, or a window itself). */
function rootWindow(node) {
  return node?.isWindow ? node : (node?.root ?? null);
}

/** A node's centre in **screen** coordinates, which is what injection takes. */
export function screenPointOf(node, { dx = 0, dy = 0 } = {}) {
  const win = rootWindow(node);
  if (!win?.window) {
    throw new Error(
      'react-x11/test: the target is not inside a realized window — did you ' +
        'await renderX11(), or has it unmounted?',
    );
  }
  const origin = win.window._screenOrigin ?? {
    x: win.window.x ?? 0,
    y: win.window.y ?? 0,
  };
  if (node.isWindow) {
    return {
      x: origin.x + (node.window.width ?? 0) / 2 + dx,
      y: origin.y + (node.window.height ?? 0) / 2 + dy,
      server: serverOf(node),
    };
  }
  const abs = node.abs;
  if (!abs || (abs.width === 0 && abs.height === 0)) {
    throw new Error(
      `react-x11/test: <${node.kind}> has no laid-out rect yet. Layout runs ` +
        'on the frame clock, so `await act()` before pointing at it.',
    );
  }
  return {
    x: Math.round(origin.x + abs.x + abs.width / 2 + dx),
    y: Math.round(origin.y + abs.y + abs.height / 2 + dy),
    server: serverOf(node),
  };
}

function serverOf(node) {
  const server = rootWindow(node)?.app?._reactX11TestServer;
  if (!server) {
    throw new Error(
      'react-x11/test: fireEvent needs the in-process X server, so it needs a ' +
        "root created by renderX11() with the default backend ('xserver'). " +
        "The 'mock' backend has no server to inject into.",
    );
  }
  return server;
}

/** Press the keycodes for a modifier mask, innermost last. */
function modifierKeycodes(server, mask) {
  const codes = [];
  for (let row = 0; row < 8; row++) {
    if (!(mask & (1 << row))) continue;
    const keycode = server.keymap.modifiers[row]?.find(Boolean);
    if (keycode) codes.push(keycode);
  }
  return codes;
}

function maskOf(modifiers) {
  if (typeof modifiers === 'number') return modifiers;
  let mask = 0;
  for (const name of modifiers ?? []) {
    const bit = MOD[name];
    if (bit === undefined) {
      throw new Error(
        `react-x11/test: unknown modifier "${name}". Known: ${Object.keys(MOD).join(', ')}.`,
      );
    }
    mask |= bit;
  }
  return mask;
}

/**
 * The keycode that produces a keysym, and whether Shift is needed to reach
 * it. Anything the server's default US layout does not carry is bound to a
 * spare keycode on the spot — that is how a test types `é` without the test
 * author having to own a keymap. Both sides are updated together: the
 * server's `keymap.syms` and the client's `keycode2keysyms` cache, which is
 * what ntk decodes the event against.
 */
function resolveKeysym(server, app, keysym) {
  const km = server.keymap;
  for (let kc = km.minKeycode; kc <= km.maxKeycode; kc++) {
    const syms = km.syms[kc];
    if (syms[0] === keysym) return { keycode: kc, shift: false };
    if (syms[1] === keysym) return { keycode: kc, shift: true };
  }
  // a spare keycode, counting down from the top so the standard layout and
  // anything bound earlier are left alone
  for (let kc = km.maxKeycode; kc >= km.minKeycode; kc--) {
    if (km.syms[kc][0] || km.syms[kc][1]) continue;
    km.syms[kc] = [keysym, keysym];
    if (app?.X?.keycode2keysyms) app.X.keycode2keysyms[kc] = [keysym, keysym];
    return { keycode: kc, shift: false };
  }
  throw new Error(
    `react-x11/test: no keycode left to bind keysym 0x${keysym.toString(16)}.`,
  );
}

/**
 * Synchronous input injection. Each call is one user action; wrap it in
 * `await act()` to see what it caused.
 *
 * ```js
 * fireEvent.click(getByRole('button'));
 * await act();
 * ```
 */
export const fireEvent = {
  /** Move the pointer over a node — real EnterNotify/LeaveNotify follow. */
  mouseMove(node, options = {}) {
    const { x, y, server } = screenPointOf(node, options);
    server.injectPointerMove(x, y);
  },

  mouseEnter(node, options = {}) {
    fireEvent.mouseMove(node, options);
  },

  /** Move the pointer off the node, which is what produces a leave. */
  mouseLeave(node, options = {}) {
    const { server } = screenPointOf(node, options);
    server.injectPointerMove(0, 0);
  },

  mouseDown(node, options = {}) {
    const { x, y, server } = screenPointOf(node, options);
    const modifiers = modifierKeycodes(server, maskOf(options.modifiers));
    for (const kc of modifiers) server.injectKey(kc, true);
    server.injectPointerMove(x, y);
    server.injectButton(options.button ?? 1, true);
    for (const kc of modifiers.reverse()) server.injectKey(kc, false);
  },

  mouseUp(node, options = {}) {
    const { server } = screenPointOf(node, options);
    server.injectButton(options.button ?? 1, false);
  },

  /** Press and release — the renderer synthesises the click from the pair. */
  click(node, options = {}) {
    const { x, y, server } = screenPointOf(node, options);
    const modifiers = modifierKeycodes(server, maskOf(options.modifiers));
    for (const kc of modifiers) server.injectKey(kc, true);
    server.injectPointerMove(x, y);
    const button = options.button ?? 1;
    server.injectButton(button, true);
    server.injectButton(button, false);
    for (const kc of modifiers.reverse()) server.injectKey(kc, false);
  },

  /** Two clicks close enough in time and space to count as a double. */
  doubleClick(node, options = {}) {
    fireEvent.click(node, options);
    fireEvent.click(node, options);
  },

  contextMenu(node, options = {}) {
    fireEvent.click(node, { ...options, button: 3 });
  },

  /**
   * A scroll, in **notches** — one click of a wheel, which the renderer
   * turns into the 48 pixels a notch is worth. The core protocol has no
   * wheel, so a whole notch is injected as the press of button 4/5
   * (vertical) or 6/7 (horizontal) it really is.
   *
   * `{ smooth: true }` is a touchpad instead, and takes fractions:
   * `fireEvent.wheel(list, { deltaY: 0.25, smooth: true })` is a quarter of
   * a notch. That one does **not** go through the server — the in-process X
   * server has no XInput extension, so there are no valuators to inject —
   * and is delivered as the `wheel` event ntk would have derived from them.
   * The only thing in this module that skips the server, and it skips it
   * because nothing below the toolkit can express the gesture.
   */
  wheel(node, { deltaY = 1, deltaX = 0, smooth = false, ...options } = {}) {
    const { x, y, server } = screenPointOf(node, options);
    if (smooth) {
      const wnd = rootWindow(node).window;
      const origin = wnd._screenOrigin ?? { x: wnd.x ?? 0, y: wnd.y ?? 0 };
      wnd.emit('wheel', {
        name: 'wheel',
        x: x - origin.x,
        y: y - origin.y,
        rootx: x,
        rooty: y,
        buttons: maskOf(options.modifiers),
        deltaX,
        deltaY,
        deltaMode: 'line',
        smooth: true,
        source: 'valuator',
      });
      return;
    }
    server.injectPointerMove(x, y);
    const button = deltaX ? (deltaX > 0 ? 7 : 6) : deltaY > 0 ? 5 : 4;
    const notches = Math.max(1, Math.abs(deltaX || deltaY));
    for (let i = 0; i < notches; i++) {
      server.injectButton(button, true);
      server.injectButton(button, false);
    }
  },

  /**
   * A key, by keysym — `fireEvent.key(XK_RETURN)` or
   * `fireEvent.key(XK_TAB, { target, modifiers: ['Shift'] })`. Keys go to
   * whatever holds the X input focus, so `target` is only needed to say
   * *which* connection when a test holds more than one root.
   */
  key(
    keysym,
    { target = null, modifiers = [], press = true, release = true } = {},
  ) {
    const node = target ?? currentTarget();
    const server = serverOf(node);
    const app = rootWindow(node)?.app;
    const { keycode, shift } = resolveKeysym(server, app, keysym);
    const mask = maskOf(modifiers) | (shift ? MOD.Shift : 0);
    const mods = modifierKeycodes(server, mask);
    if (press) {
      for (const kc of mods) server.injectKey(kc, true);
      server.injectKey(keycode, true);
    }
    if (release) {
      server.injectKey(keycode, false);
      for (const kc of [...mods].reverse()) server.injectKey(kc, false);
    }
  },

  /** A single character, resolved to a keysym by the Latin-1/Unicode rule. */
  char(char, options = {}) {
    fireEvent.key(keysymOf(char), options);
  },

  /** A press at a raw **screen** coordinate — see `userEvent.clickOutside`. */
  screenClick(x, y, { target = null, button = 1 } = {}) {
    const server = serverOf(target ?? currentTarget());
    server.injectPointerMove(x, y);
    server.injectButton(button, true);
    server.injectButton(button, false);
  },
};

/**
 * A screen point that is inside none of this root's windows — the root
 * window, in other words, which is where a press has to land for a
 * `<popup grab>` to hear about it.
 *
 * The reason is X's, not ours: react-x11's popups grab with **owner
 * events**, so a press on one of the client's *own* windows is delivered
 * normally (that is what keeps submenus and the owner window working). Only
 * a press somewhere the client does not own is redirected to the grab
 * holder, and that is what `onDismiss` reports. A test that clicks another
 * widget expecting the menu to close is testing the wrong thing.
 */
export function pointOutsideWindows(node) {
  const win = rootWindow(node);
  const server = serverOf(node);
  const boxes = [];
  for (let n = win; n; n = null) {
    collectWindowBoxes(n, boxes);
  }
  const clear = (x, y) =>
    !boxes.some(
      (b) => x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height,
    );
  // walk in from the bottom-right corner, which is where a window is least
  // likely to be
  for (let i = 0; i < 64; i++) {
    const x = server.width - 2 - i * 8;
    const y = server.height - 2 - i * 8;
    if (x < 0 || y < 0) break;
    if (clear(x, y)) return { x, y };
  }
  throw new Error(
    'react-x11/test: every screen point is covered by a window of this root, ' +
      'so there is nowhere "outside" to press. Give renderX11 a bigger ' +
      '`screen`, or a smaller window.',
  );
}

function collectWindowBoxes(node, out) {
  if (!node || node.destroyed) return;
  if (node.isWindow && node.window) {
    const origin = node.window._screenOrigin ?? {
      x: node.window.x ?? 0,
      y: node.window.y ?? 0,
    };
    out.push({
      x: origin.x,
      y: origin.y,
      width: node.window.width ?? 0,
      height: node.window.height ?? 0,
    });
  }
  for (const child of node.children ?? []) collectWindowBoxes(child, out);
}

// `fireEvent.key` with no explicit target still needs a connection; the most
// recent render is the only sensible default and matches `screen`.
let defaultTarget = null;
export function setDefaultTarget(node) {
  defaultTarget = node;
}
function currentTarget() {
  if (!defaultTarget) {
    throw new Error(
      'react-x11/test: fireEvent.key has no target — call renderX11() first, ' +
        'or pass { target: node }.',
    );
  }
  return defaultTarget;
}

/**
 * Higher-level interactions, each one `act`-wrapped so the tree has caught
 * up when they resolve. This is the layer to reach for by default;
 * `fireEvent` is there for when a test needs one half of a gesture.
 */
export const userEvent = {
  async click(node, options) {
    await act(() => fireEvent.click(node, options));
  },

  async doubleClick(node, options) {
    await act(() => fireEvent.doubleClick(node, options));
  },

  async hover(node, options) {
    await act(() => fireEvent.mouseMove(node, options));
  },

  /**
   * Press somewhere outside every window of this root — how a user dismisses
   * a menu, a `Select` or a tooltip. See {@link pointOutsideWindows} for why
   * clicking another widget does not do it.
   */
  async clickOutside({ target = null, button = 1 } = {}) {
    const node = target ?? currentTarget();
    const { x, y } = pointOutsideWindows(node);
    await act(() => fireEvent.screenClick(x, y, { target: node, button }));
  },

  async unhover(node, options) {
    await act(() => fireEvent.mouseLeave(node, options));
  },

  async wheel(node, options) {
    await act(() => fireEvent.wheel(node, options));
  },

  /**
   * Type into a control: click it to take focus, then send each character as
   * a real key. `\n` is Return, so `type(input, 'hello\n')` submits.
   *
   * Characters outside the server's US layout are bound to a spare keycode
   * on the fly, so accented and non-Latin text works without a keymap.
   */
  async type(node, text, { skipClick = false } = {}) {
    if (!skipClick) await userEvent.click(node);
    for (const char of String(text)) {
      const keysym = char === '\n' ? XK_RETURN : keysymOf(char);
      await act(() => fireEvent.key(keysym, { target: node }));
    }
  },

  /** Tab to the next focusable node (Shift+Tab for the previous). */
  async tab({ shift = false, target = null } = {}) {
    await act(() =>
      fireEvent.key(0xff09 /* XK_Tab */, {
        target,
        modifiers: shift ? ['Shift'] : [],
      }),
    );
  },

  /** A key by keysym, flushed. */
  async key(keysym, options) {
    await act(() => fireEvent.key(keysym, options));
  },
};

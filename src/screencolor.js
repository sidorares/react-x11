// Sample one pixel from the screen — the eyedropper, through whatever this
// machine actually has.
//
// The file dialog's ladder again (docs/filedialog.md), two rungs this time:
//
//   1. **the portal** — `org.freedesktop.portal.Screenshot.PickColor`. The
//      desktop draws its own magnifier and hands back the colour, which is
//      also the only route that works under a compositor that would refuse a
//      root read, and the only route Wayland has at all. Needs version 2 of
//      the Screenshot interface — XFCE ships none, GNOME and KDE ship 2 —
//      so the gate is the interface's `version` property, not `hasService()`.
//   2. **X11** — grab the pointer with a crosshair, wait for the click,
//      `GetImage` a 1×1 at it, decode by the server's own pixel layout.
//      Reached under a bare WM, over ssh, on XQuartz: everywhere there is a
//      display and nothing else, which is the case react-x11 exists for.
//
// There is no third rung to draw, because the thing being read — the whole
// screen — is precisely what an application cannot draw itself. So unlike
// `useFileDialog()`, `useEyedropper()` adds no rung; it adds the binding a
// component wants (`picking`, `supported`, the owner window) over the same
// two.
//
// ## The grab is the dangerous part
//
// An application that leaks a pointer grab leaves a desktop that has stopped
// answering clicks. Everything in the X11 rung is shaped by that: one
// `settle()` gate owns the cleanup, the abort listener goes on before the
// first request goes out, cancellation releases the grab before it reports,
// and losing the grab to someone else is detected (the server says so, with
// a LeaveNotify of mode Ungrab) rather than waited out.

import { pixelLayout, toStraightRgba } from 'ntk';

import { sessionBus } from './bus.js';
import { XK_ESCAPE, XK_KP_ENTER, XK_RETURN, XK_SPACE } from './keysyms.js';
import {
  PORTAL_NAME,
  PortalCancelledError,
  RESPONSE_OK,
  hasService,
  parentWindowHandle,
  portalRequest,
  portalVersion,
} from './portal.js';
import { windowIdOf } from './windowid.js';

export const SCREENSHOT_IFACE = 'org.freedesktop.portal.Screenshot';
/** `PickColor` arrived in version 2 of the Screenshot interface. */
const PICK_COLOR_VERSION = 2;

/**
 * Nothing here can sample the screen, and nothing can be drawn instead.
 *
 * A **typed** rejection, the `NoFileDialogError` rule: a caller hides or
 * disables its eyedropper button rather than crashing — which is what
 * `useEyedropper().supported` does for you.
 */
export class NoScreenColorError extends Error {
  constructor(message, cause) {
    super(
      `react-x11: ${
        message ??
        'no way to sample a colour from the screen — there is no ' +
          'Screenshot portal with PickColor (interface version 2) on the ' +
          'session bus, and no X connection was given for the fallback. ' +
          'Pass `app` (from createRoot() or useApp()), or use useEyedropper().'
      }`,
      { cause },
    );
    this.name = 'NoScreenColorError';
  }
}

// --------------------------------------------------------------------------
// Rung 1: the portal
// --------------------------------------------------------------------------

/**
 * The portal's `(ddd)` — sRGB in [0, 1] — as `'#rrggbb'`, or null when the
 * triple is not one. A string because every consumer wants to paint with it;
 * the same reasoning as the appearance portal's accent colour.
 */
function hexFromPortalColor(triple) {
  if (!Array.isArray(triple) || triple.length < 3) return null;
  const channels = triple.slice(0, 3);
  if (!channels.every((c) => typeof c === 'number' && Number.isFinite(c))) {
    return null;
  }
  return (
    '#' +
    channels
      .map((c) =>
        Math.round(Math.min(1, Math.max(0, c)) * 255)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}

async function portalPick(opts, ref) {
  const { response, results } = await portalRequest(ref, {
    iface: SCREENSHOT_IFACE,
    member: 'PickColor',
    // Not FileChooser's shape: PickColor is `(s parent_window, a{sv}
    // options)` — no title — which is the whole reason portalRequest takes a
    // signature now.
    signature: 'sa{sv}',
    args: [parentWindowHandle(windowIdOf(opts.parentWindow))],
    options: {},
    signal: opts.signal,
  });
  if (response !== RESPONSE_OK) throw new PortalCancelledError(response);
  const hex = hexFromPortalColor(results?.color);
  if (!hex) {
    throw new Error(
      'react-x11: the Screenshot portal answered PickColor without a ' +
        'colour — expected a (ddd) triple in `results.color`, got ' +
        `${JSON.stringify(results?.color)}.`,
    );
  }
  return hex;
}

/** Portal reachable *and* recent enough for PickColor, on this ref. */
async function portalCanPick(ref) {
  return (
    (await hasService(PORTAL_NAME, ref)) &&
    (await portalVersion(SCREENSHOT_IFACE, ref)) >= PICK_COLOR_VERSION
  );
}

// --------------------------------------------------------------------------
// Rung 2: X11
// --------------------------------------------------------------------------

// x11.eventMask bits, spelled out the way xsettings.js spells its one. No
// key mask anywhere: GrabKeyboard has no event-mask argument — a keyboard
// grab delivers every key event to the grab window unconditionally.
const BUTTON_MASK = 4 | 8; // ButtonPress | ButtonRelease
const CROSSING_MASK = 0x10 | 0x20; // EnterWindow | LeaveWindow

// Core event types.
const KEY_PRESS = 2;
const BUTTON_PRESS = 4;
const LEAVE_NOTIFY = 8;

/** LeaveNotify `mode` when a grab this client held was released. */
const NOTIFY_UNGRAB = 2;

const GRAB_STATUS = {
  1:
    'another application is holding a pointer grab (a menu or a drag is ' +
    'probably open) — try again once it closes',
  2: 'the grab was refused for an out-of-order timestamp (InvalidTime)',
  3: 'the grab window is not viewable, which is a react-x11 bug',
  4: 'the pointer is frozen by another grab (GrabFrozen)',
};

/**
 * One pick per connection at a time. A second `GrabPointer` from the same
 * client silently *replaces* the first — two concurrent picks would settle
 * one of them with the other's click, so the second is refused loudly
 * instead. `useEyedropper()` never gets here: it hands the in-flight promise
 * back.
 */
const inflight = new WeakSet();

/**
 * The keysyms a keycode can produce, from the map ntk keeps current. An
 * unfilled map — possible in the first moments of a connection — answers
 * `[]`, which quietly costs the keyboard shortcuts and nothing else: the
 * click and the abort signal never depend on it.
 */
function keysymsOf(X, keycode) {
  return X.keycode2keysyms?.[keycode] ?? [];
}

/**
 * GrabKeyboard, marshalled by hand — **do not use `X.GrabKeyboard` here.**
 *
 * node-x11 writes pointer-mode and keyboard-mode at request offsets 10/11,
 * which the protocol says are the top half of the *time* field; the real
 * offsets, 12/13, stay zero. So every `X.GrabKeyboard` with CurrentTime and
 * asynchronous modes reaches a real server as a garbage timestamp with
 * **synchronous** modes: Xorg answers InvalidTime, and a time that survived
 * would freeze the keyboard. The pure-JS test server never reads those
 * bytes, which is how the bug stays green headlessly — this was found by
 * running the pick on a live display. Marshalled the way node-x11's own
 * extension modules marshal what the core tables lack; delete when the fix
 * lands upstream.
 */
function grabKeyboard(X, wid, cb) {
  X.seq_num++;
  const b = Buffer.alloc(16);
  b[0] = 31; // GrabKeyboard
  b[1] = 0; // owner-events: false
  b.writeUInt16LE(4, 2);
  b.writeUInt32LE(wid >>> 0, 4);
  b.writeUInt32LE(0, 8); // CurrentTime
  b[12] = 1; // pointer-mode: Asynchronous
  b[13] = 1; // keyboard-mode: Asynchronous
  X.pack_stream.put(b);
  // The status rides byte 1 of the reply header, which the reply dispatcher
  // hands over as the unpack's second argument.
  X.replies[X.seq_num] = [(buf, status) => status, cb];
  X.pack_stream.submit(true);
}

/**
 * Restore the grab of a `<popup grab>` the pick displaced.
 *
 * A grabbing popup — an open Menu, Select, or the colour panel the
 * eyedropper button itself sits in — holds this client's pointer grab, and
 * our `GrabPointer` **replaced** it (same client, so no AlreadyGrabbed).
 * The popup is never told; nothing in X says "your grab moved". After the
 * pick releases, the popup would be left open with dismiss-on-outside-click
 * silently dead — so the grab is handed back here, by the renderer, which is
 * the one party that can know both grabs existed.
 */
function regrabPopup(app) {
  let found = null;
  const walk = (node) => {
    if (!node) return;
    if (
      node.isPopup &&
      node.props?.grab &&
      node.window &&
      !node.destroyed &&
      !node._anchorLost
    ) {
      // Later in tree order approximates higher in the stack; with the
      // renderer's own rule of one grabbing popup at a time (submenus ride
      // the root menu's grab) there is at most one anyway.
      found = node;
    }
    for (const child of node.children ?? []) walk(child);
  };
  for (const root of app._rootChildren ?? []) walk(root);
  found?.window?.grabPointer?.({}, () => {});
}

/**
 * The classic route: grab, crosshair, click, Escape cancels.
 *
 * Resolves `'#rrggbb'` on a click (or Return/space/KP_Enter, which pick at
 * the pointer, GTK's shape), `null` on Escape, rejects on abort — with the
 * grab released on every one of those paths before the promise settles.
 *
 * No magnifier and no live preview, deliberately: the desktops whose users
 * expect a loupe have a portal that draws one.
 */
function x11Pick(opts, app) {
  const X = app.X;
  if (inflight.has(app)) {
    return Promise.reject(
      new Error(
        'react-x11: pickScreenColor() is already waiting for a click on ' +
          'this connection. One eyedropper at a time — disable the button ' +
          'while `useEyedropper().picking` is true.',
      ),
    );
  }
  inflight.add(app);

  return new Promise((resolve, reject) => {
    const root = X.display.screen[0].root;
    // The crosshair is feedback, not mechanism: an app whose ntk predates
    // cursors still picks, with the arrow.
    let cursor = 0;
    try {
      cursor = app.cursors?.get?.('crosshair') ?? 0;
    } catch {
      cursor = 0;
    }

    // The grab window. Invisible twice over — InputOnly, and offscreen —
    // because a mapped InputOnly window *does* intercept input wherever it
    // sits, and (0, 0) is somebody's hot corner. It exists so that grabbed
    // events land on an id nothing else owns: delivering them through a real
    // window of the tree would put every pick click through the renderer's
    // own dispatcher, and the app would see itself being clicked.
    const wid = X.AllocID();
    X.CreateWindow(wid, root, -100, -100, 1, 1, 0, 0, 2 /* InputOnly */, 0, {
      overrideRedirect: true,
      // The grab's own event mask governs delivery of the grabbed events;
      // this attribute mask is for the crossing events the *server* sends
      // about the grab itself — LeaveNotify mode Ungrab is how we learn the
      // grab was taken from us (see below).
      eventMask: CROSSING_MASK,
    });
    X.MapWindow(wid);

    let settled = false;
    let grabSent = false;
    let keyboardGrabbed = false;
    let regrabs = 0;

    const cleanup = () => {
      X.removeListener('event', onEvent);
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      try {
        if (grabSent) X.UngrabPointer(0);
        if (keyboardGrabbed) X.UngrabKeyboard(0);
        X.DestroyWindow(wid);
        X.ReleaseID(wid);
      } catch {
        // The connection died mid-pick. The server released the grab with
        // it, which is the outcome cleanup exists to guarantee.
      }
      inflight.delete(app);
      // After our ungrab, never before: X holds one active grab per client,
      // so handing the popup its grab back first would only have ours
      // replace it again on the next line.
      if (grabSent) {
        try {
          regrabPopup(app);
        } catch {
          // A half-torn-down tree mid-unmount. The popup this would have
          // served is on its way out with it.
        }
      }
    };

    /** Every way out funnels through here, so the grab cannot outlive us. */
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const fail = (message, cause) =>
      settle(() => reject(new Error(`react-x11: ${message}`, { cause })));

    // `'#rrggbb'` from a 1×1 GetImage at root coordinates. The reply is raw
    // server words; `pixelLayout`/`toStraightRgba` are the "what do these
    // bytes mean" answer, asked of the display rather than assumed — the
    // lesson scripts/capture.js already learned the hard way.
    const sample = (drawable, x, y) => {
      X.GetImage(
        2 /* ZPixmap */,
        drawable,
        x,
        y,
        1,
        1,
        0xffffffff,
        (err, img) => {
          if (err) {
            return reject(
              new Error(
                'react-x11: could not read the picked pixel back ' +
                  `(GetImage at ${x},${y})`,
                { cause: err },
              ),
            );
          }
          try {
            const layout = pixelLayout(X.display, img.depth);
            const [r, g, b] = toStraightRgba(img.data, layout, 1, 1);
            resolve(
              '#' +
                [r, g, b].map((c) => c.toString(16).padStart(2, '0')).join(''),
            );
          } catch (cause) {
            // A 16-bit display, in practice. Rare enough to report rather
            // than unpack by hand.
            reject(
              new Error(
                `react-x11: could not decode the picked pixel — ${cause.message}`,
                { cause },
              ),
            );
          }
        },
      );
    };

    // Ungrab first, then read: the crosshair reverts on the very click, and
    // a failed read can no longer strand the grab. Safe against repaints
    // because the grabbed click reached no application — nothing gained
    // focus, nothing redrew.
    const pickAt = (drawable, x, y) => settle(() => sample(drawable, x, y));

    const onEvent = (ev) => {
      if (settled || ev.wid !== wid) return;
      if (ev.type === BUTTON_PRESS) {
        // Button 1 picks. The rest are ignored rather than treated as
        // cancel: a stray middle-click paste reflex should not silently eat
        // the pick, and Escape is one key away.
        if (ev.keycode === 1) pickAt(ev.root || root, ev.rootx, ev.rooty);
        return;
      }
      if (ev.type === KEY_PRESS) {
        const syms = keysymsOf(X, ev.keycode);
        if (syms.includes(XK_ESCAPE)) {
          settle(() => resolve(null));
        } else if (
          syms.includes(XK_RETURN) ||
          syms.includes(XK_KP_ENTER) ||
          syms.includes(XK_SPACE)
        ) {
          // Pick at the pointer without a click — the keyboard's half of the
          // gesture, same as GTK's dropper.
          X.QueryPointer(root, (err, pointer) => {
            if (settled) return;
            if (err || !pointer)
              return fail('could not locate the pointer', err);
            pickAt(pointer.root || root, pointer.rootX, pointer.rootY);
          });
        }
        return;
      }
      // The grab was taken from us — LeaveNotify with mode Ungrab on the
      // grab window is the one signal X gives. Not hypothetical: this
      // client's own popups release the active grab in their teardown, so a
      // pick started from a closing menu loses its grab a tick later. Take
      // it back; the alternative is a pick that silently never resolves
      // while the app answers clicks as if nothing were happening.
      if (ev.type === LEAVE_NOTIFY && ev.mode === NOTIFY_UNGRAB && grabSent) {
        if (++regrabs > 5) {
          return fail(
            'the pointer grab kept being released out from under the ' +
              'eyedropper — something on this connection is calling ' +
              'UngrabPointer repeatedly',
          );
        }
        X.GrabPointer(
          wid,
          false,
          BUTTON_MASK,
          1 /* async */,
          1 /* async */,
          0,
          cursor,
          0,
          (err, status) => {
            if (settled) return;
            if (err || status !== 0) {
              fail(
                `lost the pointer grab and could not take it back — ${
                  GRAB_STATUS[status] ?? `status ${status}`
                }`,
                err ?? undefined,
              );
            }
          },
        );
      }
    };

    const onAbort = () =>
      settle(() => reject(opts.signal.reason ?? new PortalCancelledError()));

    // Abort wiring before the first request goes out, the portalRequest
    // lesson: an abort landing while the grab replies are in flight must
    // still release everything.
    if (opts.signal) {
      if (opts.signal.aborted) {
        // Nothing sent yet; unwind what this function itself created.
        X.removeListener?.('event', onEvent);
        try {
          X.DestroyWindow(wid);
          X.ReleaseID(wid);
        } catch {
          // never mind — the reject below is the answer
        }
        inflight.delete(app);
        settled = true;
        return reject(opts.signal.reason ?? new PortalCancelledError());
      }
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    // The listener goes on before the grab request: events start the moment
    // the grab activates, and the reply races them on a busy connection.
    X.on('event', onEvent);

    // ownerEvents: **false**. Every pointer event during the pick reports to
    // the grab window and only there — with true, a click over the app's own
    // windows would flow through the renderer's dispatcher and the app would
    // handle a press that was meant for the eyedropper.
    grabSent = true;
    X.GrabPointer(
      wid,
      false,
      BUTTON_MASK,
      1 /* async */,
      1 /* async */,
      0 /* no confineTo: the whole screen is the target */,
      cursor,
      0 /* CurrentTime */,
      (err, status) => {
        if (settled) return;
        if (err || status !== 0) {
          return fail(
            `could not grab the pointer to pick a colour — ${
              GRAB_STATUS[status] ?? `status ${status}`
            }`,
            err ?? undefined,
          );
        }
        // The keyboard grab is what makes Escape work wherever the focus
        // happens to be. Refusal is survivable — the click and the abort
        // signal still end the pick — so a failure here degrades instead of
        // failing the pick.
        grabKeyboard(X, wid, (kbErr, kbStatus) => {
          if (!kbErr && kbStatus === 0) {
            keyboardGrabbed = true;
            // The pick may have settled while this reply was in flight; the
            // grab it just took has to go with it.
            if (settled) {
              try {
                X.UngrabKeyboard(0);
              } catch {
                // connection gone, grab gone with it
              }
            }
          }
        });
      },
    );
  });
}

// --------------------------------------------------------------------------
// The ladder
// --------------------------------------------------------------------------

/**
 * The connection behind a `parentWindow`, when it points at a live node —
 * so `pickScreenColor({ parentWindow: winRef })` reaches the X11 rung
 * without the caller repeating the app it is already naming a window of.
 */
function appOf(target) {
  if (!target || typeof target !== 'object') return null;
  if ('current' in target && !target.isWindow) return appOf(target.current);
  return target.app ?? target.window?.app ?? target.root?.window?.app ?? null;
}

/** The connection a pick would use, or null. */
function appFor(opts) {
  return opts.app ?? appOf(opts.parentWindow);
}

/**
 * Which rung this machine lands on, without grabbing anything.
 *
 * `'portal'` needs the Screenshot interface at version 2 — the probe reads
 * the interface's `version` property, because `hasService()` cannot see
 * which interfaces a portal's backends actually provide (XFCE's provides no
 * Screenshot at all). `'x11'` needs a connection to answer with, so pass
 * `app` (or a `parentWindow` that resolves to one); without either the
 * fallback is unreachable and the honest answer is `null`.
 *
 * Acquires a bus reference and releases it, so it is cheap but not free —
 * `useEyedropper().supported` caches it for you.
 *
 * @returns {Promise<'portal'|'x11'|null>}
 */
export async function screenColorBackend(options = {}) {
  const backend = options.backend;
  if (!backend || backend === 'portal') {
    const ref = await sessionBus();
    if (ref) {
      try {
        if (await portalCanPick(ref)) return 'portal';
      } finally {
        await ref.release();
      }
    }
    if (backend === 'portal') return null;
  }
  return appFor(options) ? 'x11' : null;
}

async function runPick(opts) {
  const wantPortal = !opts.backend || opts.backend === 'portal';
  if (wantPortal) {
    const ref = await sessionBus();
    if (ref) {
      try {
        if (await portalCanPick(ref)) {
          return await portalPick(opts, ref);
        }
      } finally {
        await ref.release();
      }
    }
    if (opts.backend === 'portal') {
      throw new NoScreenColorError(
        'no Screenshot portal with PickColor here — the session bus has no ' +
          `${SCREENSHOT_IFACE} at version ${PICK_COLOR_VERSION} or newer — ` +
          "and backend: 'portal' rules out the X11 fallback.",
      );
    }
  }

  const app = appFor(opts);
  if (app) return x11Pick(opts, app);
  throw new NoScreenColorError(
    opts.backend === 'x11'
      ? "backend: 'x11' needs a connection to grab on. Pass `app` (from " +
          'createRoot() or useApp()), or a `parentWindow` that points at a ' +
          'mounted window.'
      : undefined,
  );
}

/**
 * Sample one pixel from the screen: the desktop's own picker where there is
 * one, a crosshair grab on plain X11 everywhere else.
 *
 * ```js
 * const hex = await pickScreenColor({ app });
 * if (hex) setFill(hex);            // '#rrggbb'; null means cancelled
 * ```
 *
 * Resolves to **`'#rrggbb'`**, or `null` when the user cancelled (Escape, or
 * the portal dialog's own cancel) — cancelling is an ordinary outcome and
 * should not need a `try`. Rejects with {@link NoScreenColorError} when
 * neither rung is reachable, which is the signal to hide the button;
 * `signal` aborts the pick and releases the grab before the rejection is
 * reported.
 *
 * In a component, reach for {@link useEyedropper} instead — it binds the
 * connection and the owner window, and exposes `picking`/`supported` as
 * render state.
 *
 * @returns {Promise<string | null>}
 */
export async function pickScreenColor(options = {}) {
  try {
    return await runPick(options);
  } catch (err) {
    if (err instanceof PortalCancelledError) return null;
    throw err;
  }
}

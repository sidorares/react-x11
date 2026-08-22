// A portal on the test bus.
//
// `withBus()` gives a broker and a client; this owns
// `org.freedesktop.portal.Desktop` on it and answers `FileChooser` calls the
// way xdg-desktop-portal does — return the Request path immediately, emit
// `Response` on it afterwards. That second half is the whole point: it is the
// only way to test that `portalRequest()` subscribed *before* it called, since
// a harness that answered synchronously would pass either way.
//
// **What the broker cannot do**, from its own docs: no security policy, no
// service activation, no fd passing. Activation is the one that matters here —
// a fake portal has to own its name up front, so `hasService()`'s
// `ListActivatableNames` branch is exercised against a real daemon or not at
// all. Do not read a green suite as covering it.

import { PORTAL_NAME, PORTAL_PATH, senderPath } from '../../src/portal.js';

const FILE_CHOOSER = 'org.freedesktop.portal.FileChooser';
const SCREENSHOT = 'org.freedesktop.portal.Screenshot';
const REQUEST_IFACE = 'org.freedesktop.portal.Request';

/**
 * Start a fake portal against `address`.
 *
 * `handlers` is `{ OpenFile, SaveFile, PickColor }`, each `(call) =>
 * ({ response, results })` or a promise of one, where `call` is
 * `{ parentWindow, title, options, path }`. The default answers with one file.
 *
 * The returned object records every call in `calls`, so a test can assert on
 * what was actually marshalled — which is where the option translation is
 * pinned.
 *
 * `holdReply` delays the *reply to the method call* — not the Response signal —
 * by that many milliseconds, while still recording the call and exporting
 * `Request.Close` up front, exactly as a real portal does. It makes the window
 * between "the portal has a dialog up" and "the client knows the handle"
 * wide enough to test deliberately, instead of waiting for a loaded CI runner
 * to land in it by accident.
 *
 * `screenshotVersion` exports the `Screenshot` interface — `PickColor`, whose
 * argument list is `(s parent_window, a{sv} options)`, **not** FileChooser's —
 * with its `version` property answering that number, the way the capability
 * probe reads it. Unset, the interface is absent entirely, which is what
 * XFCE's real portal looks like.
 */
export async function fakePortal(
  address,
  handlers = {},
  { holdReply = 0, screenshotVersion } = {},
) {
  const dbus = (await import('dbus-native')).default;
  const bus = dbus.createClient({ busAddress: address });
  const portal = {
    bus,
    calls: [],
    /** Requests that are still open, by path — what Close() ends. */
    open: new Map(),
    closed: [],
    stop: () => bus.close(),
  };

  await new Promise((resolve, reject) => {
    bus.connection.once('connect', resolve);
    bus.connection.once('error', reject);
  });
  await bus.listNames();
  await bus.requestName(PORTAL_NAME, 0);

  const answer = async (member, [parentWindow, title, options], { sender }) => {
    const token = options?.handle_token ?? 't';
    const path = `${PORTAL_PATH}/request/${senderPath(sender)}/${token}`;
    const call = { member, parentWindow, title, options, path, sender };
    portal.calls.push(call);

    // Export Request.Close at the path *before* returning it, the way a real
    // portal does — a client that cancels immediately must find something
    // there.
    bus.exportInterface({ Close: () => closeRequest(path) }, path, {
      name: REQUEST_IFACE,
      methods: { Close: ['', '', [], []] },
      signals: { Response: ['ua{sv}', 'response', 'results'] },
      properties: {},
    });
    portal.open.set(path, true);

    // Answer on a later tick: the call has to return the handle first, and a
    // Response that arrived before it would not prove anything about ordering.
    // A held reply holds the Response behind it too, for the same reason.
    const held = holdReply
      ? new Promise((r) => setTimeout(r, holdReply))
      : Promise.resolve();
    const handler = handlers[member];
    held
      .then(() => (handler ? handler(call) : { response: 0, results: {} }))
      .then((result) => {
        if (!portal.open.has(path) || result?.silent) return;
        portal.open.delete(path);
        bus.sendSignal(path, REQUEST_IFACE, 'Response', 'ua{sv}', [
          result?.response ?? 0,
          result?.results ?? {},
        ]);
      })
      .catch(() => {});

    await held;
    return path;
  };

  const closeRequest = (path) => {
    // Per the spec, Close() means **no Response is emitted** — which is
    // exactly the case a client that waits for one hangs on.
    portal.open.delete(path);
    portal.closed.push(path);
    bus.unexportInterface(path, REQUEST_IFACE);
  };

  const method = (member) => ({
    in: { parent_window: 's', title: 's', options: 'a{sv}' },
    out: { handle: 'o' },
    handler: (args, ctx) =>
      answer(member, [args.parent_window, args.title, args.options], ctx),
  });

  const iface = dbus.defineInterface({
    name: FILE_CHOOSER,
    methods: {
      OpenFile: method('OpenFile'),
      SaveFile: method('SaveFile'),
    },
  });
  await bus.export(PORTAL_PATH, iface);

  if (screenshotVersion !== undefined) {
    const screenshot = dbus.defineInterface({
      name: SCREENSHOT,
      methods: {
        PickColor: {
          in: { parent_window: 's', options: 'a{sv}' },
          out: { handle: 'o' },
          handler: (args, ctx) =>
            answer(
              'PickColor',
              [args.parent_window, undefined, args.options],
              ctx,
            ),
        },
      },
      properties: {
        version: { type: 'u', access: 'read', value: screenshotVersion },
      },
    });
    await bus.export(PORTAL_PATH, screenshot);
  }

  return portal;
}

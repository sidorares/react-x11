// `useTray()` — an icon in the system tray for as long as a component is
// mounted, on the backends that have one.
//
// Two rungs, found by capability and never by naming a platform:
//
//   1. **the app's own status bar** — the cocoa backend's menu-bar extra
//      (`NSStatusItem`, src/cocoa/statusitem.js), found by the app carrying
//      `createStatusItem`.
//   2. **`org.kde.StatusNotifierItem`** over the session bus
//      (`statusnotifier.js`) — the freedesktop tray, and the same protocol
//      under X11, XWayland and Wayland. Used when a **live**
//      `org.kde.StatusNotifierWatcher` is hosting one.
//
// Where neither answers there is no tray, and `available` is `false` — a
// stock GNOME session with no AppIndicator extension is the common case, and
// it is a configuration rather than a fault. An app reads `available` and
// keeps its tray feature behind it; nothing is logged, because "this desktop
// has no tray" is not news.
//
// ## What the hook returns, and why it is not just a boolean
//
// `{ available, backend, features, error }` — the same shape
// `useDesktopCapability('tray')` resolves to, and built from the same probe so the
// two can never disagree. The difference is which question they answer:
//
//   - **this hook measures.** `available` is whether *this item* was taken by
//     a host. It tried; it knows.
//   - **`useDesktopCapability` predicts.** It answers "would a tray icon be taken if
//     one were asked for", which is what a settings screen needs — a "Show
//     tray icon" checkbox must render correctly *without* putting an icon in
//     the tray to find out.
//
// Prefer this one wherever the feature is actually mounted. `features` is the
// portable vocabulary from `capabilities.js` — `features.clickModifiers` is
// false on the freedesktop rung, because the protocol carries no modifier
// state, and an app that dims a shift-click affordance reads it here rather
// than testing the platform.
//
// `error` is the fourth field because "no tray on this desktop" and "there is
// a tray and it refused me" are different facts with different fixes, and
// collapsing them into `available: false` loses the one an app could act on.
//
// ## `available` settles, it does not start true
//
// The cocoa rung can be answered synchronously — the method is either on the
// app object or it is not. The freedesktop one cannot: it takes a bus
// connection and a `NameHasOwner` round trip. So `available` is **render
// state that settles**, false on the first frame and true a tick later if a
// watcher is there, and it follows the watcher for the life of the item —
// a panel that exits takes the icon with it and flips this back to false.
//
// That is the shape every capability in this family should have, and
// docs/desktop.md says so: a synchronous "can I?" that is honest on the first
// frame is not available for anything that has to ask the desktop.

import { useEffect, useRef, useState } from 'react';
import { decodeImage } from 'ntk/image';

import { useAppOrNull } from './appcontext.js';
import { currentRegistration } from './application.js';
import { NO_CAPABILITY, desktopCapability } from './capabilities.js';
import { StatusNotifierItem, allocateItemSlot } from './statusnotifier.js';

/**
 * An icon in the system tray while this component is mounted.
 *
 * ```jsx
 * const { available } = useTray({
 *   icon: 'bell.badge',              // a themed icon name (an SF Symbol on macOS), or PNG bytes
 *   tooltip: 'Notifications',
 *   menu: [{ label: 'Open', onSelect: open }, { label: 'Quit', onSelect: quit }],
 * });
 * ```
 *
 * With `menu`, a click opens it — the same `items` vocabulary `MenuBar` and
 * `useLauncherMenu` take, an item's `onSelect` firing when picked. Without one,
 * `onClick` is called with the button and where the click was, in logical
 * screen pixels — with the item's rect, where the backend knows it. `null`
 * means no item. Every field follows its value while mounted; the item is
 * removed on unmount.
 *
 * `available` is whether this backend has a tray at all, and it **settles**:
 * false on the first frame, true once a tray has been found. Branch on it for
 * a "show tray icon" setting; do not branch on it to decide whether to call
 * the hook, which would break the rules of hooks the moment it changed.
 */
export function useTray(options) {
  const app = useAppOrNull();
  const native = typeof app?.createStatusItem === 'function';
  const itemRef = useRef(null);
  const [rect] = useState(null);
  const [remote, setRemote] = useState(false);
  // whether the freedesktop registration has answered, either way
  const [answered, setAnswered] = useState(false);
  const [error, setError] = useState(null);
  // The feature vocabulary for whichever rung answered. Probed once per
  // backend rather than per render — it describes the mechanism, not the
  // item — and for *both* rungs: the cocoa one is synchronous about whether
  // it has a tray, but not about what that tray can do, and an app reading
  // `features.clickModifiers` to dim a shift-click affordance would
  // otherwise be told `undefined` on the one backend that has modifiers.
  const [caps, setCaps] = useState(NO_CAPABILITY);

  useEffect(() => {
    if (!options) return undefined;
    let cancelled = false;
    // `app` explicitly rather than letting the probe find the sole one: a
    // process with several connections has several trays, and this hook
    // belongs to one of them.
    void desktopCapability('tray', { app }).then((c) => {
      if (!cancelled) setCaps(c);
    });
    return () => {
      cancelled = true;
    };
  }, [app, native, options == null]);

  // the options a click or a pick reads are the current render's, not the
  // ones the item was created with three minutes ago
  const live = useRef(options);
  live.current = options;

  // ------------------------------------------------------- rung 1: the app's
  useEffect(() => {
    if (!native || !options) return undefined;
    const item = app.createStatusItem({
      ...options,
      onClick: (ev) => live.current?.onClick?.(ev),
    });
    itemRef.current = item;
    return () => {
      itemRef.current = null;
      item.remove();
    };
    // Recreated only when the item comes or goes: the fields patch in
    // place below, and an `options` object rebuilt every render must not
    // rebuild the item every render.
  }, [app, native, options == null]);

  useEffect(() => {
    const item = itemRef.current;
    if (!item || !options) return;
    item.update({ ...options, onClick: (ev) => live.current?.onClick?.(ev) });
  }, [
    options?.icon,
    options?.title,
    options?.tooltip,
    options?.visible,
    options?.template,
    options?.length,
    options?.menu,
  ]);

  // ------------------------------------------- rung 2: the freedesktop tray
  const sniRef = useRef(null);
  const previous = useRef(options ?? {});
  // One slot for the life of this hook, **not** per item object. Passing
  // `null` and then options again is the same tray icon going away and coming
  // back; on a fresh path the host has no way to know that and draws a second
  // one beside the first. See `StatusNotifierItem.announcePassive`.
  const slotRef = useRef(null);
  slotRef.current ??= allocateItemSlot();

  useEffect(() => {
    if (native || !options) return undefined;
    let cancelled = false;
    // The id hosts key their hidden-icons setting on. The app's registered id
    // when it has one, so the choice survives a restart.
    const appId = currentRegistration()?.appId ?? 'react-x11';
    const item = new StatusNotifierItem({
      getOptions: () => live.current,
      // The display a click's position is read against: the host sends it in
      // a unit of its own choosing — see "The position has no unit" in
      // statusnotifier.js.
      app,
      appId,
      slot: slotRef.current,
      decodeIcon: decodeIconBytes,
      // A host that answered the bus and then refused the registration is a
      // fact worth reporting; a desktop with no tray at all is not, and does
      // not come through here.
      onError: (err) => {
        if (!cancelled)
          setError(err instanceof Error ? err : new Error(String(err)));
      },
    });
    sniRef.current = item;
    previous.current = { ...live.current };
    void item.start().then((ok) => {
      if (cancelled) return;
      setRemote(ok);
      setAnswered(true);
    });
    return () => {
      cancelled = true;
      sniRef.current = null;
      setRemote(false);
      setAnswered(false);
      setError(null);
      void item.stop();
    };
  }, [app, native, options == null]);

  // The item reads its fields through `getOptions`, so a render only has to
  // say *which* of them moved — see `StatusNotifierItem.update`.
  useEffect(() => {
    const item = sniRef.current;
    if (!item) return;
    item.update(previous.current);
    previous.current = { ...live.current };
  }, [
    options?.icon,
    options?.overlayIcon,
    options?.attentionIcon,
    options?.title,
    options?.tooltip,
    options?.visible,
    options?.attention,
    options?.menu,
  ]);

  // The cocoa rung is synchronous and always itself; the freedesktop one
  // reports whatever the probe found. `features` is empty until one settles,
  // which is the same "render the fallback first" order `available` has.
  const backend = native ? 'cocoa' : remote ? caps.backend : null;
  return {
    available: native || remote,
    // Whether `available` is an answer yet: at once on the Cocoa rung and for
    // no item at all, and on the freedesktop one once the host has taken or
    // refused the registration — so an app whose whole UI is its tray can
    // render nothing until then, rather than a fallback window that flashes
    // up and away on every start.
    settled: native || !options || answered,
    backend,
    features: native || remote ? caps.features : NO_CAPABILITY.features,
    error,
    rect,
  };
}

/**
 * PNG/JPEG bytes → raw RGBA, through ntk's decoder.
 *
 * Defensive: a corrupt or unsupported image should cost the tray its *icon*,
 * not its tray. The pixmap ends up empty and the item still registers with
 * its name, tooltip and menu intact.
 */
function decodeIconBytes(bytes) {
  try {
    return decodeImage(bytes);
  } catch {
    return null;
  }
}

// `org.kde.StatusNotifierItem` — the freedesktop tray, from the app's side.
//
// The Linux rung of `useTray()` (react-x11#353). The other rung is the cocoa
// backend's `NSStatusItem`; `trayhooks.js` is the ladder and this is the
// climb it could not make until now.
//
// ## Why this and not XEmbed
//
// The old tray — `_NET_SYSTEM_TRAY_S<n>`, a real X window reparented into the
// panel — is what `@react-x11/components`' `<TrayHost>` *hosts*. It is not
// what an app should *speak* any more: GNOME removed the XEmbed tray in 3.26,
// Plasma treats it as legacy, and on Wayland there is no window to hand over
// at all. StatusNotifierItem is D-Bus only, so it works identically under X11,
// XWayland and Wayland — which is the whole reason the tray is the one desktop
// feature that gets *simpler* as the display server gets stricter.
//
// ## The registration is sender-attributed, on purpose
//
// `RegisterStatusNotifierItem` takes one string, and hosts read it two ways:
// KDE apps pass a **bus name**, Ayatana-patched GNOME apps pass an **object
// path**. Every host in the wild handles both (gnome-shell's appindicator
// extension has a comment about it that is funnier than this one).
//
// We pass the **path**, for two reasons that both matter:
//
//   - **No extra name.** The bus is shared — `sessionBus()` hands every
//     consumer the same socket and the same unique name, so the app's tray,
//     its menu and its exported service are visibly one application. The
//     bus-name form would need `org.kde.StatusNotifierItem-<pid>-<n>`
//     requested on top, which is a second identity for no gain.
//   - **Several items coexist.** `useTray()` promises that each mount is its
//     own item. Paths are per-item (`/StatusNotifierItem/1`, `/2`, …); a
//     well-known name is per-process, so the name form caps an app at one
//     tray icon.
//
// ## What the desktop cannot tell us, and what we say instead
//
// The protocol carries far less about a click than AppKit does. There is no
// click count, no modifier state, and no item rectangle — `Activate(x, y)`
// gives the pointer position and nothing else. Those fields are reported as
// `0`/`false` rather than guessed at, and `docs/desktop.md` says so, because a
// tray menu that only opens on shift-click is an app built on a field this
// rung cannot fill. The menu is the portable interaction; `onClick` is the
// one that degrades.

import { loadTransport, sessionBus } from './bus.js';
import { DbusMenuExport } from './dbusmenuexport.js';

export const WATCHER_NAME = 'org.kde.StatusNotifierWatcher';
export const WATCHER_PATH = '/StatusNotifierWatcher';
export const WATCHER_IFACE = 'org.kde.StatusNotifierWatcher';
export const ITEM_IFACE = 'org.kde.StatusNotifierItem';

/** dbusmenu's own struct, repeated here so the tooltip signature reads. */
const PIXMAP_SIGNATURE = 'a(iiay)';

/** One process, many trays: the path counter behind `/StatusNotifierItem/<n>`.
 *
 *  A **slot**, not a mount counter. A hook that is toggled off and on again is
 *  the *same* tray icon and must come back on the same path — see `stop()`. */
let nextItemIndex = 1;

/** Claim a tray slot. `useTray()` takes one per hook instance, for its life. */
export function allocateItemSlot() {
  return nextItemIndex++;
}

/**
 * Straight RGBA pixels → the ARGB32 pixmap array the spec wants.
 *
 * Pure, and exported for the test: the byte order is the single most
 * get-wrong-able thing in this file. The spec says ARGB32 in **network byte
 * order**, i.e. big-endian, so a pixel is the bytes `A R G B` in that order —
 * *not* the little-endian `B G R A` that a Cairo/`getImageData` buffer holds
 * when read as a 32-bit word. Getting it backwards produces an icon that is
 * recognisably the right shape in the wrong colours, which is why it is worth
 * a test rather than a squint.
 */
export function toPixmapArray(image) {
  if (!image) return [];
  const { width, height, data } = image;
  if (!width || !height || !data) return [];
  const out = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const s = i * 4;
    out[s] = data[s + 3]; // A
    out[s + 1] = data[s]; // R
    out[s + 2] = data[s + 1]; // G
    out[s + 3] = data[s + 2]; // B
  }
  return [[width, height, out]];
}

/** `visible: false` is `Passive`, which is how the spec spells "hidden". */
function statusOf(options) {
  if (options?.visible === false) return 'Passive';
  return options?.attention ? 'NeedsAttention' : 'Active';
}

/**
 * The icon fields, resolved once per update.
 *
 * A string is a **themed icon name**, which is what the desktop wants and
 * what scales: the panel picks the size and the theme picks light or dark.
 * Bytes are decoded and sent as a pixmap — correct, but a fixed size, so the
 * name is the better answer wherever the app can ship an icon in a theme.
 * (On the cocoa rung the same string is an SF Symbol name. One field, two
 * vocabularies, and no app has to branch — which is the point.)
 */
function iconOf(icon, decode) {
  if (typeof icon === 'string' && icon) return { name: icon, pixmap: [] };
  if (icon && typeof icon === 'object') {
    try {
      return { name: '', pixmap: toPixmapArray(decode(icon)) };
    } catch {
      // Corrupt bytes are a content failure, not a reason to have no tray.
      return { name: '', pixmap: [] };
    }
  }
  return { name: '', pixmap: [] };
}

/**
 * One tray icon on the session bus, for as long as it is started.
 *
 * Shaped like `GlobalMenuExport`, and for the same reasons: the watcher is a
 * thing that restarts, so ownership is followed rather than sampled, and
 * publish/withdraw are serialised behind one promise so two ownership changes
 * in quick succession cannot put two registrations in flight.
 */
export class StatusNotifierItem {
  constructor({ getOptions, appId, decodeIcon, onError, slot } = {}) {
    this.getOptions = getOptions ?? (() => null);
    this.appId = appId ?? 'react-x11';
    this.decodeIcon = decodeIcon ?? (() => null);
    this.onError = onError ?? (() => {});

    // The caller's slot when it has one. A hook that is switched off and on
    // again must re-register the **same** `sender@path`, because that string
    // is the host's identity for the icon: a fresh path reads as a second,
    // additional tray icon rather than as the first one coming back.
    this.index = slot ?? nextItemIndex++;
    this.path = `/StatusNotifierItem/${this.index}`;
    this.menuPath = `${this.path}/Menu`;

    this.stopped = false;
    this.exported = false;
    this.syncing = null;
    /** Set while withdrawing, so `Status` reads `Passive` on the way out —
     *  see `announcePassive()`. */
    this.withdrawing = false;

    this.ref = null;
    this.dbus = null;
    this.iface = null;
    this.registration = null;
    this.menuRegistration = null;
    this.subscription = null;
    this.onOwnerChanged = undefined;

    this.menu = null;
  }

  /** The options the *current* render supplied — never the mounting one's. */
  get options() {
    return this.getOptions() ?? {};
  }

  // ------------------------------------------------------------------ setup

  async start() {
    const ref = await sessionBus();
    // No bus is a first-class configuration, not a degraded one: ssh, a bare
    // startx, CI, Node 20 without the transport. There is simply no tray.
    if (!ref) return false;
    if (this.stopped) {
      await ref.release();
      return false;
    }
    this.ref = ref;
    try {
      await this.watchWatcher();
      await this.sync();
      return this.exported;
    } catch (err) {
      // A desktop that answers the bus but not this protocol is not an error
      // for an app whose tray is a convenience. Reported, not thrown.
      this.onError(err);
      await this.teardown();
      return false;
    }
  }

  /**
   * Follow the watcher's ownership for the life of the item.
   *
   * Unlike the global menu's registrar, a watcher **is** the feature rather
   * than a directory something else reads — but the same restart problem
   * applies, and the same `arg0` narrowing keeps the daemon from waking this
   * process for every name on the session.
   */
  async watchWatcher() {
    const { bus } = this.ref;
    const subscription = await bus.watch(
      "type='signal',sender='org.freedesktop.DBus'," +
        "interface='org.freedesktop.DBus',member='NameOwnerChanged'," +
        `arg0='${WATCHER_NAME}'`,
    );
    // `AddMatch` is a round trip, and an item that mounts and unmounts inside
    // one — StrictMode, a fast remount — leaves `teardown()` already finished
    // by the time it lands. See `GlobalMenuExport.watchRegistrar`, which has
    // the long version of why installing it anyway leaks for the life of the
    // process.
    if (this.stopped) {
      await subscription.remove().catch(() => {});
      return;
    }
    this.subscription = subscription;
    const key = bus.mangle(
      '/org/freedesktop/DBus',
      'org.freedesktop.DBus',
      'NameOwnerChanged',
    );
    this.onOwnerChanged = () => {
      if (!this.stopped) this.sync().catch(() => {});
    };
    bus.signals.on(key, this.onOwnerChanged);
  }

  /** Serialised publish/withdraw. See `GlobalMenuExport.sync`. */
  sync() {
    const done = (this.syncing ?? Promise.resolve()).then(
      () => this._sync(),
      () => this._sync(),
    );
    this.syncing = done.catch(() => {});
    return done;
  }

  async _sync() {
    if (this.stopped || !this.ref) return;
    const live = await this.watcherIsLive();
    if (this.stopped) return;
    if (live && !this.exported) await this.publish();
    else if (!live && this.exported) await this.withdraw();
  }

  /**
   * A **live owner**, not an activatable name — the `globalmenu.js` rule, for
   * the same reason. `org.kde.StatusNotifierWatcher` ships as an activatable
   * service on some desktops (this box has `org.x.StatusNotifierWatcher` as
   * one), and starting a watcher nobody is hosting would register the icon
   * into a directory no panel reads: an icon that exists and is drawn nowhere.
   */
  async watcherIsLive() {
    try {
      return await this.ref.bus.nameHasOwner(WATCHER_NAME);
    } catch {
      return false;
    }
  }

  async publish() {
    const { bus } = this.ref;
    this.dbus ??= await loadTransport();
    if (this.stopped) return;

    // The menu is exported **before** the item, because the item's `Menu`
    // property names it: a host that reads the property the instant the item
    // registers would otherwise be told about a path that is not there yet.
    const options = this.options;
    if (options.menu) await this.publishMenu();

    this.iface = this.defineItem(this.dbus);
    this.registration = await bus.export(this.path, this.iface);
    if (this.stopped) return void (await this.teardownExports());

    const watcher = await bus.getInterface(
      WATCHER_NAME,
      WATCHER_PATH,
      WATCHER_IFACE,
    );
    // The path form, sender-attributed — see the header.
    await new Promise((resolve, reject) => {
      watcher.RegisterStatusNotifierItem(this.path, (err) =>
        err ? reject(err) : resolve(),
      );
    });
    if (this.stopped) return void (await this.teardownExports());
    this.withdrawing = false;
    this.exported = true;
    this.announceAll();
  }

  /**
   * Say everything once, immediately after registering.
   *
   * A host that already knew this `sender@path` — the icon was switched off
   * and on again, so the id is the same by design — does **not** re-read us
   * on the way back. gnome-shell's watcher answers a repeat registration with
   * `item.reset()`, which is one event and no property fetch, and its
   * `Status` is a cached proxy property. So the `Passive` that
   * `announcePassive()` correctly told it on the way out is still what it
   * believes, and the icon stays hidden however healthy the object is.
   *
   * `update()` is right to emit only the field that moved — that path runs on
   * every render and a host re-reads per signal. This one runs once per
   * publish, where the opposite is true: nothing about the host's cache can
   * be assumed, so every field is announced and the cost is one burst.
   */
  announceAll() {
    if (!this.exported || !this.iface) return;
    const emit = this.iface.emit;
    try {
      emit.NewStatus(statusOf(this.options));
      emit.NewIcon();
      emit.NewAttentionIcon();
      emit.NewOverlayIcon();
      emit.NewTitle();
      emit.NewToolTip();
    } catch {
      // A connection on its way down owes us nothing.
    }
  }

  async publishMenu() {
    if (this.menuRegistration) return;
    const menu = new DbusMenuExport({
      getMenus: () => this.options.menu ?? [],
      onSelect: (item) => item.onSelect?.(),
      onAboutToShow: (item) => item.onAboutToShow?.(),
    });
    const iface = menu.defineMenu(this.dbus);
    this.menuRegistration = await this.ref.bus.export(this.menuPath, iface);
    menu.iface = iface;
    menu.exported = true;
    this.menu = menu;
  }

  async withdraw() {
    await this.announcePassive();
    this.exported = false;
    await this.teardownExports();
  }

  /**
   * Tell the host the icon is going before the object stops answering.
   *
   * **This is the whole of taking a tray icon down**, and it is not obvious.
   * There is no `UnregisterStatusNotifierItem`: the spec's removal signal is
   * the item's *bus name* losing its owner, and a host watches exactly that.
   * Our name is the app's shared connection (see the header), which outlives
   * any one icon — so simply un-exporting the object removes nothing. The
   * host keeps drawing an icon backed by a dead path, and the next mount adds
   * a *second* one beside it.
   *
   * gnome-shell's appindicator names this failure in a comment on its own
   * workaround: "some applications just remove the indicator object from bus
   * after hiding it, without closing its bus name, so we are not able to
   * understand when they're gone". That workaround is a ten-second liveness
   * probe, and it only runs for an item that is already `Passive`.
   *
   * So: go `Passive` first and say so. `Passive` is the spec's own word for
   * "do not show this", every host honours it immediately, and on this one it
   * is also what arms the reaper. The export is then held for one settle so
   * the re-read the signal provokes finds `Passive` rather than an error.
   *
   * The pair to this is the **stable path** (`slot`): coming back re-registers
   * the same id, which a host dedupes to a reset rather than a second icon.
   */
  async announcePassive() {
    if (!this.exported || !this.iface) return;
    this.withdrawing = true;
    try {
      this.iface.emit.NewStatus('Passive');
    } catch {
      // A connection already on its way down owes us nothing here.
      return;
    }
    // One turn for the signal to reach the socket, and a short window for the
    // host's `Get('Status')` to come back before the object goes away. Cheap,
    // and the difference between an icon that disappears and one that lingers
    // until the process exits.
    await new Promise((resolve) => setTimeout(resolve, 60));
  }

  async teardownExports() {
    const item = this.registration;
    const menu = this.menuRegistration;
    this.registration = null;
    this.menuRegistration = null;
    this.iface = null;
    this.menu = null;
    await item?.remove?.().catch(() => {});
    await menu?.remove?.().catch(() => {});
  }

  async stop() {
    // Announced **before** `stopped`, which gates `_sync()` and every other
    // path that could tear the export out from under the signal.
    await this.announcePassive();
    this.stopped = true;
    await this.syncing;
    await this.teardown();
  }

  async teardown() {
    this.exported = false;
    await this.teardownExports();
    if (this.subscription) {
      const key = this.ref?.bus.mangle(
        '/org/freedesktop/DBus',
        'org.freedesktop.DBus',
        'NameOwnerChanged',
      );
      if (key && this.onOwnerChanged) {
        this.ref.bus.signals.removeListener(key, this.onOwnerChanged);
      }
      await this.subscription.remove().catch(() => {});
      this.subscription = null;
    }
    // Dropped as well as removed: it closes over this item, so leaving it on
    // the instance keeps every handler reachable.
    this.onOwnerChanged = undefined;
    await this.ref?.release();
    this.ref = null;
  }

  // ----------------------------------------------------------------- update

  /**
   * New options. The protocol has **no general property-changed signal** —
   * each field has its own `New*` signal and hosts re-read the property when
   * they see one, so an update is "emit the signals whose fields moved".
   *
   * Emitting all of them on every render would make a host re-read six
   * properties for a tooltip change, which on Plasma is six round trips per
   * keystroke of whatever produced it. Hence the comparison.
   */
  update(prev) {
    if (!this.exported || !this.iface) return;
    const next = this.options;
    const emit = this.iface.emit;

    if (prev.icon !== next.icon) emit.NewIcon();
    if (prev.attentionIcon !== next.attentionIcon) emit.NewAttentionIcon();
    if (prev.overlayIcon !== next.overlayIcon) emit.NewOverlayIcon();
    if (prev.title !== next.title) emit.NewTitle();
    if (prev.tooltip !== next.tooltip) emit.NewToolTip();
    if (statusOf(prev) !== statusOf(next)) emit.NewStatus(statusOf(next));

    // The menu is its own protocol and diffs itself — see `DbusMenuExport`.
    if (this.menu) this.menu.update(next.menu ?? []);
  }

  // --------------------------------------------------------------- protocol

  defineItem(dbus) {
    const opts = () => this.options;
    const icon = () => iconOf(opts().icon, this.decodeIcon);
    const click = (button) => (args) => {
      // No click count, no modifiers, no item rect: the protocol has none of
      // them. Reported as zero rather than invented — see the header.
      opts().onClick?.({
        button,
        x: args?.x ?? 0,
        y: args?.y ?? 0,
        width: 0,
        height: 0,
        clickCount: 1,
        shift: false,
        control: false,
        option: false,
        command: false,
      });
    };

    return dbus.defineInterface({
      name: ITEM_IFACE,
      methods: {
        Activate: { in: { x: 'i', y: 'i' }, out: {}, handler: click('left') },
        SecondaryActivate: {
          in: { x: 'i', y: 'i' },
          out: {},
          handler: click('middle'),
        },
        // A host that renders the menu itself never calls this; one that does
        // not (or an item with no menu) does, and it is the right-click.
        ContextMenu: {
          in: { x: 'i', y: 'i' },
          out: {},
          handler: click('right'),
        },
        Scroll: {
          in: { delta: 'i', orientation: 's' },
          out: {},
          handler: ({ delta, orientation }) =>
            opts().onScroll?.({ delta, orientation }),
        },
        // Wayland's "this click is why you may take focus" token. Accepted and
        // ignored: nothing here raises a window, and refusing the call makes
        // some hosts log an error on every activation.
        ProvideXdgActivationToken: {
          in: { token: 's' },
          out: {},
          handler: () => {},
        },
      },
      properties: {
        Category: {
          type: 's',
          access: 'read',
          get: () => opts().category ?? 'ApplicationStatus',
        },
        // Stable for the life of the item and unique within the app: hosts key
        // their "which icons has the user hidden" setting on it, so an id that
        // changed between runs would forget the user's choice.
        Id: { type: 's', access: 'read', get: () => this.appId },
        Title: {
          type: 's',
          access: 'read',
          get: () => opts().title ?? opts().tooltip ?? this.appId,
        },
        Status: {
          type: 's',
          access: 'read',
          // `withdrawing` wins: the icon is on its way out, whatever the
          // last render asked for.
          get: () => (this.withdrawing ? 'Passive' : statusOf(opts())),
        },
        // 0, always: the item is not tied to a window, and on Wayland there is
        // no X id to give even when it is.
        WindowId: { type: 'i', access: 'read', get: () => 0 },
        IconName: { type: 's', access: 'read', get: () => icon().name },
        IconPixmap: {
          type: PIXMAP_SIGNATURE,
          access: 'read',
          get: () => icon().pixmap,
        },
        OverlayIconName: {
          type: 's',
          access: 'read',
          get: () => iconOf(opts().overlayIcon, this.decodeIcon).name,
        },
        OverlayIconPixmap: {
          type: PIXMAP_SIGNATURE,
          access: 'read',
          get: () => iconOf(opts().overlayIcon, this.decodeIcon).pixmap,
        },
        AttentionIconName: {
          type: 's',
          access: 'read',
          get: () => iconOf(opts().attentionIcon, this.decodeIcon).name,
        },
        AttentionIconPixmap: {
          type: PIXMAP_SIGNATURE,
          access: 'read',
          get: () => iconOf(opts().attentionIcon, this.decodeIcon).pixmap,
        },
        AttentionMovieName: { type: 's', access: 'read', get: () => '' },
        // `(name, pixmap, title, description)`. The title is the bold line.
        ToolTip: {
          type: `(s${PIXMAP_SIGNATURE}ss)`,
          access: 'read',
          get: () => ['', [], opts().tooltip ?? '', ''],
        },
        IconThemePath: {
          type: 's',
          access: 'read',
          get: () => opts().iconThemePath ?? '',
        },
        Menu: {
          type: 'o',
          access: 'read',
          // A path is always advertised, even with no menu: the property is
          // not optional in several hosts' proxies, and an item that answers
          // an error here fails to appear at all on them.
          get: () => this.menuPath,
        },
        // "A click *is* the menu" — true when the app gave a menu and no
        // click handler, and it is what stops a host sending `Activate` into
        // a void on a left click.
        ItemIsMenu: {
          type: 'b',
          access: 'read',
          get: () =>
            Boolean(opts().menu) && typeof opts().onClick !== 'function',
        },
      },
      signals: {
        NewIcon: { args: {} },
        NewAttentionIcon: { args: {} },
        NewOverlayIcon: { args: {} },
        NewTitle: { args: {} },
        NewToolTip: { args: {} },
        NewStatus: { args: { status: 's' } },
      },
    });
  }
}

/** Test seam, not public: make paths predictable across test files. */
export function _resetItemIndex() {
  nextItemIndex = 1;
}

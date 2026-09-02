// The global menu: handing a window's menu bar to the desktop's panel.
//
// On a desktop that shows application menus in its own panel — Unity's
// heritage, KDE Plasma's Application Menu widget, `vala-panel-appmenu`,
// several GNOME extensions — an app that draws its own menu bar is drawing a
// second one. This module notices, exports the menu over
// `com.canonical.dbusmenu` (`dbusmenu.js`), and tells `MenuBar` to stop
// drawing. **Nothing is asked of the app author**: `<MenuBar menus={…}/>` is
// the whole of the integration, and it is the same line either way.
//
// ## Detection is "is a panel running", not "could one be started"
//
// This is the one place where the rule `hasService()` follows is exactly
// wrong, and the mistake is silent and total — an app with no menu at all.
//
// `hasService()` counts an **activatable** name as present, and it is right to:
// `org.freedesktop.portal.Desktop` ships a `.service` file, so on a healthy
// GNOME session where nothing has opened a file dialog yet the name has no
// owner, and a feature gated on ownership would take the fallback path
// forever. Activation is what makes it appear.
//
// The registrar is the mirror image. Ubuntu ships
// `com.canonical.AppMenu.Registrar` as an activatable service too, but a
// registrar is not the feature — it is a *directory* the panel reads. Nothing
// activates it except a panel starting up, and starting one ourselves would
// leave the menu registered with a registrar that no panel is reading. The bar
// would vanish from the window and appear nowhere else.
//
// So: **a live owner, and only a live owner.** Which is also why the answer is
// not cached — a panel is exactly the kind of thing that gets restarted, and
// `NameOwnerChanged` moves the menu back into the window and out again with
// it.
//
// ## Why the KDE properties are set *as well*, not instead
//
// Plasma's applet reads `_KDE_NET_WM_APPMENU_SERVICE_NAME` and
// `_KDE_NET_WM_APPMENU_OBJECT_PATH` off the window rather than asking a
// registrar. They are not an alternative route for desktops without a
// registrar: Plasma runs one *and* reads the properties, and which of the two
// a given version prefers is not something to bet a menu on. They cost two
// `ChangeProperty` round trips.
//
// ## Where it deliberately does nothing
//
// Stock GNOME has no global menu bar, so nothing owns the registrar name,
// `exported` stays false and the in-window bar stays. That is not a
// degradation and it needs no code — but it does need saying, or
// "my global menu doesn't show under GNOME" is the first issue filed.
//
// We also do **not** export `org.gtk.Menus`/`org.gtk.Actions`. Handling both
// serialisations is right for a *host* and wrong for an app: traffic flows
// towards dbusmenu, not away from it — Plasma ships `gmenu-dbusmenu-proxy` to
// convert GTK's menus *into* dbusmenu, and the GNOME extensions that render
// third-party menus consume dbusmenu. A second exporter is roughly double the
// work for no consumer that the first one does not already reach.

import { useEffect, useRef, useState } from 'react';

import { loadTransport, sessionBus } from './bus.js';
import { desktopIntegrationEnabled } from './desktopintegration.js';
import {
  DBUSMENU_IFACE,
  PROPERTY_TYPES,
  diffSnapshots,
  groupProperties,
  layoutOf,
  snapshot,
  IdAllocator,
} from './dbusmenu.js';
import { useAppOrNull } from './appcontext.js';
import { useTopLevelWindow, windowIdOf } from './windowid.js';

export const REGISTRAR_NAME = 'com.canonical.AppMenu.Registrar';
export const REGISTRAR_PATH = '/com/canonical/AppMenu/Registrar';

const KDE_SERVICE_PROPERTY = '_KDE_NET_WM_APPMENU_SERVICE_NAME';
const KDE_PATH_PROPERTY = '_KDE_NET_WM_APPMENU_OBJECT_PATH';

/** dbusmenu's recursive layout struct: `(id, properties, children)`. */
const LAYOUT_SIGNATURE = '(ia{sv}av)';

/**
 * How long the registrar gets to answer.
 *
 * Short, and explicit, because dbus-native's default is 25 seconds and the
 * reply timer is **not** unref'd: a panel that dies between our `ListNames`
 * and our `RegisterWindow` — or one whose name we still hold when the window
 * closes — would otherwise hold the event loop open long enough that an app
 * quitting looks hung. There is nothing useful to do with a slow answer here
 * either; the bar is drawn in the meantime and stays drawn.
 */
const REGISTRAR_TIMEOUT = 4000;

/**
 * `NO_AUTO_START`, D-Bus's own message flag, on every call we make to the
 * registrar.
 *
 * Without it this feature starts the very thing it is careful never to start.
 * `com.canonical.AppMenu.Registrar` is activatable on Ubuntu, and a method
 * call to an unowned activatable name **launches the service** — so a panel
 * that exits while a window is registered turns our tidy-up `UnregisterWindow`
 * into `exec /usr/libexec/vala-panel/appmenu-registrar`. The name then has an
 * owner again, every app on the session hands its menu over, and nothing is
 * drawing any of them.
 *
 * Observed, not theorised: killing the host in `scripts/globalmenu-host.mjs`
 * spawned Ubuntu's registrar from exactly this call.
 *
 * The liveness check below is the first line of defence and this is the
 * second, because between the two there is a window in which the panel can
 * die. A call that fails because nothing is there is the outcome we want:
 * `exported` stays false and the menu stays in the window.
 */
const NO_AUTO_START = 2;

/**
 * D-Bus object paths are `[A-Za-z0-9_/]`, so the package's own name cannot
 * appear in one — `react-x11` has a hyphen. Hence the underscore.
 */
const menuPathFor = (xid) => `/com/react_x11/menus/${xid}`;

/**
 * The feature's off switch.
 *
 * An embedder that owns the toplevel, or an app that exports its own menu on
 * its own terms, needs the renderer to keep its hands off. `MenuBar` also
 * takes `globalMenu={false}` for one bar; this is the process-wide form, and
 * it is the one that works without touching application code.
 */
function globalMenuEnabled() {
  // `createRoot({ desktop: false })` first: handing the menu to a panel is
  // one of the three things core turns on for you, and that is the switch
  // that turns the group off (src/desktopintegration.js, #417).
  if (!desktopIntegrationEnabled('globalMenu')) return false;
  const flag = process.env.REACT_X11_NO_GLOBAL_MENU;
  return !flag || flag === '0';
}

/** Is a panel listening *right now*? See the header for why not `hasService`. */
async function registrarIsLive(bus) {
  try {
    const names = await bus.listNames();
    return names.includes(REGISTRAR_NAME);
  } catch {
    return false;
  }
}

/** The ntk window behind whatever `useTopLevelWindow()`/a ref is holding. */
function ntkWindowOf(target) {
  const node = target && 'current' in target ? target.current : target;
  if (!node) return null;
  if (typeof node.setProperty === 'function') return node;
  return node.window ?? node.root?.window ?? null;
}

/**
 * One window's menu on the bus: the exported object, the registration, and the
 * two X properties.
 *
 * Imperative and framework-free on purpose — `useGlobalMenu` is a thin lid on
 * it, and the parts that are awkward (a panel restarting, a window closing
 * mid-call, no bus at all) are awkward in ways React has nothing to say about.
 */
export class GlobalMenuExport {
  constructor({ getMenus, onSelect, onAboutToShow, target, onChange }) {
    this.getMenus = getMenus;
    this.onSelect = onSelect;
    this.onAboutToShow = onAboutToShow;
    this.target = target;
    this.onChange = onChange ?? (() => {});

    this.alloc = new IdAllocator();
    this.nodes = snapshot(getMenus(), this.alloc);
    this.revision = 1;

    this.stopped = false;
    this.exported = false;
    /** The in-flight `sync()`, which the next one queues behind. */
    this.syncing = null;
    this.ref = null;
    this.registration = null;
    this.subscription = null;
    this.iface = null;
    this.path = null;
    this.xid = null;
    this.window = null;
  }

  // ------------------------------------------------------------------ setup

  async start() {
    if (!globalMenuEnabled()) return;
    const ref = await sessionBus();
    // No bus is a first-class configuration, not a degraded one: ssh, a bare
    // startx, CI, Node 20 without the transport. The bar draws itself and
    // nothing is logged.
    if (!ref) return;
    if (this.stopped) return void ref.release();
    this.ref = ref;

    try {
      await this.watchRegistrar();
      await this.sync();
    } catch {
      // A desktop that answers the bus but not this protocol is not an error
      // condition for an app that has a menu bar it can draw itself.
      await this.teardown();
    }
  }

  /**
   * Follow the registrar's ownership for as long as this menu exists.
   *
   * `arg0` narrows the match to the one name, so the daemon does not wake this
   * process for every service on the session appearing and disappearing.
   */
  async watchRegistrar() {
    const { bus } = this.ref;
    const subscription = await bus.watch(
      "type='signal',sender='org.freedesktop.DBus'," +
        "interface='org.freedesktop.DBus',member='NameOwnerChanged'," +
        `arg0='${REGISTRAR_NAME}'`,
    );
    // `AddMatch` is a round trip, and a window that opens and closes inside
    // one — an unmount, a StrictMode remount — leaves `teardown()` already
    // finished by the time it lands. Installing the rule and the listener now
    // would leave both behind for good, since `stop()` is idempotent and has
    // nothing left to run: the daemon would keep waking the process, and the
    // listener would keep this exporter, its snapshot and every item's
    // `onSelect` closure alive for the life of it.
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

  /**
   * Bring the export into line with whether a panel is currently listening,
   * **one at a time**.
   *
   * `exported` only turns true at the *end* of `publish()`, which is several
   * awaits long — the transport import, the export, the registrar round trip.
   * A panel that restarts quickly, or any two `NameOwnerChanged` signals close
   * together, would otherwise put two `publish()` runs in flight against the
   * same window: two `RegisterWindow` calls, and the first `iface` and
   * registration orphaned by the second. `withdraw()` has the mirror version
   * of it. Serialising is the whole fix, and it costs a promise.
   */
  sync() {
    // Two promises, deliberately. `syncing` is the queue and must never
    // reject, or one failed sync would poison every later one; the returned
    // promise is the caller's and must, or `start()` cannot tell that
    // publishing failed and would leave a bus ref, a match rule and an orphan
    // `com.canonical.dbusmenu` object behind for a registration that did not
    // happen. The signal handler discards its own.
    const done = (this.syncing ?? Promise.resolve()).then(
      () => this._sync(),
      () => this._sync(),
    );
    this.syncing = done.catch(() => {});
    return done;
  }

  async _sync() {
    if (this.stopped || !this.ref) return;
    const live = await registrarIsLive(this.ref.bus);
    if (this.stopped) return;
    if (live && !this.exported) await this.publish();
    else if (!live && this.exported) await this.withdraw();
  }

  async publish() {
    const { bus } = this.ref;
    // Resolved **once**, and both answers taken from the same read.
    // `useTopLevelWindow()` is a live getter — it recomputes from the app's
    // window list and the X focus every time — so asking again after the
    // registrar round trip can name a different window than the xid just
    // registered, and the KDE properties would land on the wrong one.
    const node =
      this.target && 'current' in this.target
        ? this.target.current
        : this.target;
    const xid = windowIdOf(node);
    const wnd = ntkWindowOf(node);
    // A window that is not realized yet has no id to register. `sync()` runs
    // again on the next ownership change, and the effect that owns this runs
    // after the commit that creates the window, so this is the "closed mid
    // call" case rather than the "too early" one.
    if (!xid) return;

    const dbus = await loadTransport();
    const path = menuPathFor(xid);
    if (!dbus.isValidObjectPath(path)) return;

    this.iface = this.defineMenu(dbus);
    this.registration = await bus.export(path, this.iface);
    this.path = path;
    this.xid = xid;

    // `exported` becomes true only once the registrar has *answered*, so the
    // in-window bar disappears on evidence rather than on a guess. A registrar
    // that refuses the call — or one that never answers — leaves the menu
    // drawn where the user can reach it.
    await bus.invoke(
      {
        destination: REGISTRAR_NAME,
        path: REGISTRAR_PATH,
        interface: REGISTRAR_NAME,
        member: 'RegisterWindow',
        signature: 'uo',
        body: [xid, path],
        flags: NO_AUTO_START,
      },
      { timeout: REGISTRAR_TIMEOUT },
    );

    // The window can close, or the panel exit, while that call is in flight.
    // Bailing *before* the properties are written is what keeps a torn-down
    // window from being left advertising an object path that is about to be
    // unexported — Plasma prefers those properties to the registrar, so it
    // would show that window an empty menu for as long as it lives.
    if (this.stopped) return void (await this.unpublish());

    await this.setWindowProperties(wnd, bus.name, path);
    if (this.stopped) return void (await this.unpublish());
    this.exported = true;
    this.onChange(true);
  }

  /**
   * Plasma reads these instead of asking the registrar.
   *
   * Written as `STRING`/format 8 explicitly: ntk defaults a string property to
   * `UTF8_STRING`, and KDE writes and expects `STRING`. A bus name and an
   * object path are both ASCII by construction, so nothing is lost.
   *
   * The window is **remembered**, not looked up again when it is time to
   * clear: `useTopLevelWindow()` answers from the tree's live window list, and
   * by the time an unmount runs this module's cleanup the window it is asking
   * about is already off it. Properties are cleared on the window they were
   * set on or not at all.
   */
  async setWindowProperties(wnd, serviceName, path) {
    if (!wnd?.setProperty) return;
    this.window = wnd;
    const opts = { type: 'STRING', format: 8 };
    await wnd.setProperty(KDE_SERVICE_PROPERTY, serviceName, opts);
    await wnd.setProperty(KDE_PATH_PROPERTY, path, opts);
  }

  async clearWindowProperties() {
    const wnd = this.window;
    this.window = null;
    if (!wnd?.deleteProperty) return;
    // A window on its way out takes its properties with it, and asking the
    // server about a dead one is an X error rather than an exception.
    await wnd.deleteProperty(KDE_SERVICE_PROPERTY).catch(() => {});
    await wnd.deleteProperty(KDE_PATH_PROPERTY).catch(() => {});
  }

  /** The panel went away: take the menu back into the window. */
  async withdraw() {
    this.exported = false;
    this.onChange(false);
    await this.unpublish();
  }

  async unpublish() {
    const bus = this.ref?.bus;
    // Ask only a registrar that is still there. Half the time the reason we
    // are unpublishing is that it went away, and a call to a name nobody owns
    // would start one — see NO_AUTO_START.
    if (bus && this.xid != null && (await registrarIsLive(bus))) {
      await bus
        .invoke(
          {
            destination: REGISTRAR_NAME,
            path: REGISTRAR_PATH,
            interface: REGISTRAR_NAME,
            member: 'UnregisterWindow',
            signature: 'u',
            body: [this.xid],
            flags: NO_AUTO_START,
          },
          { timeout: REGISTRAR_TIMEOUT },
        )
        .catch(() => {});
    }
    await this.clearWindowProperties();
    await this.registration?.remove().catch(() => {});
    this.registration = null;
    this.iface = null;
    this.path = null;
    this.xid = null;
  }

  async stop() {
    if (this.stopped) return;
    // Set first, so a publish already in flight sees it and undoes itself at
    // its next checkpoint rather than finishing.
    this.stopped = true;
    // Then wait for it. `teardown()` reads `registration`, `xid` and `window`
    // across several awaits of its own, so running it *beside* a publish lets
    // each undo the other's work: the classic end state is `exported === true`
    // with the object unexported and the window unregistered — no bar in the
    // window, nothing in the panel, and no event left that could recover it.
    await this.syncing?.catch(() => {});
    await this.teardown();
  }

  async teardown() {
    if (this.exported) {
      this.exported = false;
      this.onChange(false);
    }
    await this.unpublish();
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
    // Dropped as well as removed: it closes over this exporter, so leaving it
    // on the instance keeps the snapshot and every item's handler reachable.
    this.onOwnerChanged = undefined;
    await this.ref?.release();
    this.ref = null;
  }

  // ----------------------------------------------------------------- update

  /**
   * A new `menus` array. Serialise, diff, and send the *narrower* of the two
   * signals the protocol has — see `diffSnapshots`, where the choice is made
   * and why it matters.
   */
  update(menus) {
    const next = snapshot(menus, this.alloc);
    const change = diffSnapshots(this.nodes, next);
    this.nodes = next;
    if (!this.exported || change.kind === 'none') return;

    if (change.kind === 'properties') {
      this.iface?.emit.ItemsPropertiesUpdated(
        change.updated.map(([id, props]) => [id, this.wrap(props)]),
        change.removed,
      );
      return;
    }
    this.revision += 1;
    this.iface?.emit.LayoutUpdated(this.revision, change.parent);
  }

  /** Plain property values → the `a{sv}` the wire wants. */
  wrap(props) {
    const out = {};
    for (const [name, value] of Object.entries(props)) {
      const type = PROPERTY_TYPES[name];
      if (type) out[name] = new this.dbus.Variant(type, value);
    }
    return out;
  }

  /** `layoutOf`'s plain tree → the recursive `(ia{sv}av)`. */
  wrapLayout(node) {
    const [id, props, children] = node;
    return [
      id,
      this.wrap(props),
      children.map(
        (child) =>
          new this.dbus.Variant(LAYOUT_SIGNATURE, this.wrapLayout(child)),
      ),
    ];
  }

  // --------------------------------------------------------------- protocol

  itemFor(id) {
    return this.nodes.get(id)?.item ?? null;
  }

  defineMenu(dbus) {
    this.dbus = dbus;
    const fire = (id, eventId) => {
      const item = this.itemFor(id);
      if (!item) return;
      if (eventId === 'clicked') this.onSelect?.(item);
      else if (eventId === 'opened') this.onAboutToShow?.(item);
    };

    return dbus.defineInterface({
      name: DBUSMENU_IFACE,
      methods: {
        GetLayout: {
          in: { parentId: 'i', recursionDepth: 'i', propertyNames: 'as' },
          out: { revision: 'u', layout: LAYOUT_SIGNATURE },
          handler: ({ parentId, recursionDepth, propertyNames }) => {
            const tree = layoutOf(
              this.nodes,
              parentId,
              recursionDepth ?? -1,
              propertyNames,
            );
            // An id the shell remembers from before a structural change is the
            // normal way to arrive here, not a protocol violation: answer with
            // an empty item rather than an error, and let the LayoutUpdated it
            // has already been sent bring it back for the real tree.
            return {
              revision: this.revision,
              layout: this.wrapLayout(tree ?? [parentId, {}, []]),
            };
          },
        },
        GetGroupProperties: {
          in: { ids: 'ai', propertyNames: 'as' },
          out: { properties: 'a(ia{sv})' },
          handler: ({ ids, propertyNames }) =>
            groupProperties(this.nodes, ids, propertyNames).map(
              ([id, props]) => [id, this.wrap(props)],
            ),
        },
        GetProperty: {
          in: { id: 'i', name: 's' },
          out: { value: 'v' },
          handler: ({ id, name }) => {
            const props = this.nodes.get(id)?.props;
            // `hasOwn` on both, so a name like `constructor` reads as absent
            // rather than as a function that then fails to marshal.
            const known = Object.hasOwn(PROPERTY_TYPES, name);
            const value =
              props && Object.hasOwn(props, name) ? props[name] : undefined;
            // A property this item does not carry is at its default, and the
            // spec's own advice is to answer with it rather than to error.
            if (value === undefined || !known) return new dbus.Variant('s', '');
            return new dbus.Variant(PROPERTY_TYPES[name], value);
          },
        },
        Event: {
          in: { id: 'i', eventId: 's', data: 'v', timestamp: 'u' },
          out: {},
          handler: ({ id, eventId }) => fire(id, eventId),
        },
        EventGroup: {
          in: { events: 'a(isvu)' },
          out: { idErrors: 'ai' },
          handler: ({ events }) => {
            const errors = [];
            for (const [id, eventId] of events ?? []) {
              if (this.itemFor(id)) fire(id, eventId);
              else errors.push(id);
            }
            return errors;
          },
        },
        AboutToShow: {
          in: { id: 'i' },
          out: { needUpdate: 'b' },
          handler: ({ id }) => this.aboutToShow(id),
        },
        AboutToShowGroup: {
          in: { ids: 'ai' },
          out: { updatesNeeded: 'ai', idErrors: 'ai' },
          handler: ({ ids }) => {
            const errors = [];
            for (const id of ids ?? []) {
              if (this.itemFor(id)) this.aboutToShow(id);
              else errors.push(id);
            }
            return { updatesNeeded: [], idErrors: errors };
          },
        },
      },
      properties: {
        Version: { type: 'u', access: 'read', get: () => 3 },
        Status: { type: 's', access: 'read', get: () => 'normal' },
        TextDirection: { type: 's', access: 'read', get: () => 'ltr' },
        // Empty, and not a placeholder: `icon-name` is looked up in the
        // desktop's own theme, which is where an app's icons should come from.
        // A path here would be for icons shipped beside the app.
        IconThemePath: { type: 'as', access: 'read', get: () => [] },
      },
      signals: {
        LayoutUpdated: { args: { revision: 'u', parent: 'i' } },
        ItemsPropertiesUpdated: {
          args: { updated: 'a(ia{sv})', removed: 'a(ias)' },
        },
        ItemActivationRequested: { args: { id: 'i', timestamp: 'u' } },
      },
    });
  }

  /**
   * The reply has to go out **now**, and React has not rendered yet.
   *
   * `setState` from here does not produce a new tree before this function
   * returns, so there is no honest way to answer `true` — and answering `true`
   * dishonestly is worse than answering `false`: the shell then blocks on a
   * `GetLayout` for a subtree that has not been built, gets the old one, and
   * caches it.
   *
   * So: answer `false`, let the handler run, and let the ordinary update path
   * emit `LayoutUpdated` when the new items actually serialise. Shells listen
   * for that unconditionally — it is the same signal a menu changing while
   * open produces — so a lazily-built submenu still fills in, one round trip
   * later than a synchronous toolkit would manage.
   */
  aboutToShow(id) {
    const item = this.itemFor(id);
    if (item) this.onAboutToShow?.(item);
    return false;
  }
}

/**
 * Is this window's menu bar being drawn by the desktop?
 *
 * `false` until proven otherwise, and proof is the registrar answering
 * `RegisterWindow` — so a machine with no bus, no panel, or a panel that
 * refuses the registration all render the menu where the app put it.
 *
 * ```jsx
 * const exported = useGlobalMenu(menus, { onSelect });
 * if (exported) return null;   // the panel has it
 * ```
 *
 * `MenuBar` calls this itself, which is why an app needs no code for any of
 * it. It is exported for a component that draws its own bar and wants the
 * same behaviour.
 */
export function useGlobalMenu(
  menus,
  { onSelect, onAboutToShow, enabled = true } = {},
) {
  const target = useTopLevelWindow();
  const app = useAppOrNull();
  const [exported, setExported] = useState(false);
  const exportRef = useRef(null);

  // The handlers a D-Bus reply reaches for are read at call time, not captured
  // at export time: a click on the panel three minutes from now must run the
  // handler from the *current* render, not the one that happened to be current
  // when the registrar answered.
  const live = useRef({ menus, onSelect, onAboutToShow });
  live.current = { menus, onSelect, onAboutToShow };

  useEffect(() => {
    if (!enabled) return undefined;
    const config = {
      getMenus: () => live.current.menus ?? [],
      onSelect: (item) => {
        item.onSelect?.(item);
        live.current.onSelect?.(item);
      },
      onAboutToShow: (item) => live.current.onAboutToShow?.(item),
      target,
      onChange: setExported,
    };
    // The transport is the backend's where it has one — the Cocoa backend
    // owns the macOS menu bar and answers immediately — and D-Bus with the
    // registrar dance everywhere else. Same owner contract either way.
    const owner = app?.createGlobalMenuExport
      ? app.createGlobalMenuExport(config)
      : new GlobalMenuExport(config);
    exportRef.current = owner;
    owner.start().catch(() => {});
    return () => {
      exportRef.current = null;
      setExported(false);
      owner.stop().catch(() => {});
    };
  }, [enabled, target, app]);

  useEffect(() => {
    exportRef.current?.update(menus ?? []);
  }, [menus]);

  return enabled && exported;
}

// Serving `com.canonical.dbusmenu`: the half of the protocol that is the same
// wherever the menu is hung.
//
// `dbusmenu.js` is the pure part — ids, snapshots, the diff — and says why
// each of those is hard. This is the object that answers for it on a bus:
// `GetLayout`, the property reads, `Event`, `AboutToShow`, and the two update
// signals. Nothing here knows *why* a menu is exported, and that is the point.
//
// It was extracted from `GlobalMenuExport` when the tray arrived
// (react-x11#353), because a panel menu and a tray menu differ only in how the
// desktop is told where the menu is:
//
//   - a **global menu** registers a *window* with `AppMenu.Registrar`, and
//     follows the registrar's ownership so the bar moves back into the window
//     when the panel exits (`globalmenu.js`);
//   - a **tray menu** is named by the `Menu` property of a StatusNotifierItem
//     and has no window at all (`statusnotifier.js`).
//
// Both serve the identical tree. Subclasses own the bus lifecycle — when to
// export, what to register, when to withdraw — and inherit everything below.

import {
  DBUSMENU_IFACE,
  PROPERTY_TYPES,
  diffSnapshots,
  groupProperties,
  layoutOf,
  snapshot,
  IdAllocator,
} from './dbusmenu.js';

/** dbusmenu's recursive layout struct: `(id, properties, children)`. */
export const LAYOUT_SIGNATURE = '(ia{sv}av)';

/**
 * A menu tree, serialised and served.
 *
 * `getMenus()` is read at construction and on every `update()`; `onSelect` and
 * `onAboutToShow` receive the *item object* the app authored, not an id, so a
 * caller never deals in dbusmenu's numbering.
 */
export class DbusMenuExport {
  constructor({ getMenus, onSelect, onAboutToShow }) {
    this.getMenus = getMenus;
    this.onSelect = onSelect;
    this.onAboutToShow = onAboutToShow;

    this.alloc = new IdAllocator();
    this.nodes = snapshot(getMenus(), this.alloc);
    this.revision = 1;

    /** Set by the subclass once the object is actually on a bus: until then
     *  `update()` must not emit, because nobody is listening and the
     *  revision would run ahead of the first `GetLayout`. */
    this.exported = false;
    this.iface = null;
    this.dbus = null;
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

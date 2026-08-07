// `com.canonical.dbusmenu`, the exporter half.
//
// The protocol is a **stateful, id-addressed, revision-numbered tree**. React
// hands us a fresh immutable array every render. Everything in this file is
// the join between those two facts, and it is three problems that a C toolkit
// holding a mutable `GtkMenuBar` simply does not have.
//
// **1. Ids must survive a re-render.** The shell caches properties against
// integer ids, so an id that moved to a different row makes the panel draw
// yesterday's label on today's item. `IdAllocator` keys on the path of
// `key ?? label` segments — the same identity `MenuRow` already uses for its
// React key — and never reuses a number within a process.
//
// **2. The diff picks the signal, and that choice is a performance decision.**
// Plasma re-fetches a whole subtree on `LayoutUpdated` and only patches on
// `ItemsPropertiesUpdated`. So a menu whose single `toggleState` flipped must
// **not** bump the revision — which is exactly what a naive
// `setState` → `LayoutUpdated(++rev, 0)` does on every keystroke, and it turns
// one property write into a full re-walk of every menu in the app.
//
// **3. `AboutToShow` wants a synchronous boolean React cannot give.** See
// `aboutToShow` below.
//
// Nothing here touches D-Bus. `snapshot()` and `diffSnapshots()` are pure, so
// the parts that are easy to get wrong are testable with no bus, no X server
// and no React — which is what `test/dbusmenu.test.js` does. The wire lives in
// `globalmenu.js`.

import {
  hasSubmenu,
  isSeparator,
  isValidShortcut,
  isVisible,
} from './menuitem.js';

export const DBUSMENU_IFACE = 'com.canonical.dbusmenu';

/** The root of a dbusmenu tree is always id 0, and is never an item. */
export const ROOT_ID = 0;

/**
 * The D-Bus type of every item property we emit.
 *
 * A table rather than inline variants because two places need to agree on it:
 * the layout serialiser and `ItemsPropertiesUpdated`. It is also the list of
 * properties `GetLayout(…, propertyNames)` can filter on, so a shell asking
 * for `['label']` gets exactly the labels.
 */
export const PROPERTY_TYPES = {
  type: 's',
  label: 's',
  enabled: 'b',
  visible: 'b',
  'icon-name': 's',
  'icon-data': 'ay',
  shortcut: 'aas',
  'toggle-type': 's',
  'toggle-state': 'i',
  'children-display': 's',
  disposition: 's',
};

// dbusmenu defines a default for these, and the spec is explicit that a
// property at its default **should not be sent**. It is not only traffic: a
// shell diffing properties it was told about will happily store `enabled:true`
// on ten thousand items that never said anything of the sort.
const DEFAULTS = {
  type: 'standard',
  enabled: true,
  visible: true,
  'toggle-state': 0,
  disposition: 'normal',
};

/**
 * The dbusmenu properties for one item, defaults omitted.
 *
 * `icon` is deliberately absent: it is a react-x11 drawing callback, and the
 * desktop cannot call a function. An item that wants an icon in *both* menus
 * carries `icon` for ours and `iconName`/`iconData` for the panel's.
 */
export function itemProperties(item) {
  const props = {};
  const set = (name, value) => {
    if (value === undefined || value === null) return;
    if (DEFAULTS[name] === value) return;
    props[name] = value;
  };

  if (isSeparator(item)) {
    // A separator has nothing else to say, and a label on one is a shell bug
    // waiting to happen — some panels draw it.
    set('type', 'separator');
    set('visible', isVisible(item));
    return props;
  }

  set('label', item.label);
  set('enabled', item.enabled);
  set('visible', item.visible);
  set('icon-name', item.iconName);
  set('icon-data', item.iconData);
  set('toggle-type', item.toggleType);
  set('toggle-state', item.toggleState);
  set('disposition', item.disposition);
  // Only ever a claim about children that exist. A parent that promises a
  // submenu and then answers `GetLayout` with none leaves an arrow pointing
  // at an empty popup.
  if (hasSubmenu(item)) props['children-display'] = 'submenu';
  // A malformed shortcut is dropped rather than sent. dbus-native would throw
  // from inside the marshaller — that is mid-reply, on the bus thread, where
  // the only symptom is a panel with no menu at all. `checkShortcut` is what
  // tells the developer, in development, at the item that is wrong.
  if (isValidShortcut(item.shortcut)) props.shortcut = item.shortcut;

  return props;
}

// --------------------------------------------------------------------------
// Stable ids
// --------------------------------------------------------------------------

/**
 * Integer ids that survive re-renders.
 *
 * An item is identified by its `key ?? label` within its parent — the same
 * identity `MenuRow` keys its React element on, so an app that already gave
 * its items stable keys gets stable ids for free and one that did not gets
 * exactly the same answer both places.
 *
 * Three rules that are not obvious:
 *
 * - **Ids are never reused.** A menu that loses an item and later grows a
 *   different one at the same path must not hand the shell an id it already
 *   has properties cached against. So the counter only ever goes up, and a
 *   forgotten path is forgotten for good.
 * - **Separators are keyed among separators**, not by their index in the
 *   list. Keying them by list position renumbers every separator below an
 *   inserted item, which turns a one-row insertion into a structural change
 *   across the whole menu.
 * - **Identity is scoped to the parent's id, not to a joined string path.**
 *   See `idFor`.
 */
export class IdAllocator {
  constructor() {
    this.ids = new Map();
    this.next = ROOT_ID + 1;
  }

  /**
   * The id for `segment` under `parentId`, allocated on first sight.
   *
   * Keyed against the parent's **id** rather than against a joined string
   * path, because labels are arbitrary text and any character chosen to join
   * a path is one a label can contain — with `/`, an item called `a/b` under
   * `p` collides with `b` under `p/a`. A parent's id is already a unique
   * integer, so there is nothing to escape.
   */
  idFor(parentId, segment) {
    const key = `${parentId}\u0000${segment}`;
    let id = this.ids.get(key);
    if (id === undefined) {
      id = this.next++;
      this.ids.set(key, id);
    }
    return id;
  }
}

/**
 * Sibling path segments, each unique within its list.
 *
 * The delimiter is a NUL, written as a `\u0000` **escape** rather than as
 * a literal byte: a NUL in the source makes git treat the file as binary
 * — no diff, no blame, no three-way merge, on the file holding the
 * trickiest logic in the feature — and any tool that normalises it would
 * silently change the disambiguator.
 *
 * The occurrence count goes on **every** segment rather than only on the
 * duplicates, which is what makes a collision impossible rather than merely
 * unlikely. Appending only to the duplicates looks equivalent and is not:
 * three siblings labelled `A`, `A` and `A 1` produce `A`, `A 1`, `A 1`, so
 * the last two share an id — one row overwrites the other and the panel is
 * handed a tree with the same id in it twice. With the count always present
 * the delimiter splits base from count unambiguously, and two distinct items
 * cannot agree.
 */
function segmentsFor(items) {
  const seen = new Map();
  let separators = 0;
  return items.map((item, index) => {
    const base = isSeparator(item)
      ? `\u0000sep${separators++}`
      : String(item.key ?? item.label ?? `\u0000at${index}`);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return `${base}\u0000${n}`;
  });
}

// --------------------------------------------------------------------------
// Snapshots
// --------------------------------------------------------------------------

/**
 * The whole menu as `Map<id, { id, parent, props, childIds, item }>`, which is
 * both what the D-Bus methods answer from and what the next render is diffed
 * against.
 *
 * `menus` is `MenuBar`'s own prop — `[{ label, items }]` — so a bar menu is
 * just an item with children, which is exactly what dbusmenu's root is.
 */
export function snapshot(menus, alloc) {
  const nodes = new Map();

  const walk = (items, parentId) => {
    const segments = segmentsFor(items);
    const childIds = [];
    items.forEach((item, index) => {
      const id = alloc.idFor(parentId, segments[index]);
      childIds.push(id);
      nodes.set(id, {
        id,
        parent: parentId,
        props: itemProperties(item),
        childIds: walk(item.items ?? [], id),
        item,
      });
    });
    return childIds;
  };

  nodes.set(ROOT_ID, {
    id: ROOT_ID,
    parent: null,
    props: { 'children-display': 'submenu' },
    childIds: walk(menus ?? [], ROOT_ID),
    item: null,
  });
  return nodes;
}

const sameIds = (a, b) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/** Property equality, deep enough for the values dbusmenu carries. */
function sameValue(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
  }
  // Buffers, for icon-data
  if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b)) {
    return Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(
      Buffer.from(b.buffer, b.byteOffset, b.byteLength),
    );
  }
  return false;
}

/** The lowest node that has every one of `ids` beneath it (or at it). */
function nearestCommonAncestor(nodes, ids) {
  if (ids.length === 0) return ROOT_ID;
  const chainOf = (id) => {
    const out = [];
    for (let cur = id; cur != null; cur = nodes.get(cur)?.parent)
      out.unshift(cur);
    return out;
  };
  let common = chainOf(ids[0]);
  for (const id of ids.slice(1)) {
    const chain = chainOf(id);
    let i = 0;
    while (i < common.length && i < chain.length && common[i] === chain[i]) i++;
    common = common.slice(0, i);
    if (common.length === 0) break;
  }
  return common.length ? common[common.length - 1] : ROOT_ID;
}

/**
 * What to tell the shell about the step from `prev` to `next`.
 *
 * ```
 * { kind: 'none' }
 * { kind: 'properties', updated: [[id, props]], removed: [[id, names]] }
 * { kind: 'layout', parent: id }
 * ```
 *
 * **The whole point is that `'properties'` does not bump the revision.**
 * Structure — an item appearing, disappearing or moving — is the only thing
 * that invalidates a cached layout; a label, a check mark or an `enabled`
 * flag is a patch, and sending `LayoutUpdated` for one costs a full re-walk
 * of the subtree in every shell that implements the protocol properly.
 *
 * `parent` is the nearest common ancestor of the subtrees that actually
 * changed, so a change inside one menu does not invalidate the other five.
 * `0` is the spec's "the whole layout is invalid" and stays available as the
 * honest answer when changes are scattered.
 */
export function diffSnapshots(prev, next) {
  if (!prev) return { kind: 'layout', parent: ROOT_ID };

  const structural = [];
  for (const [id, node] of next) {
    const before = prev.get(id);
    if (!before) continue; // its parent's childIds changed; that is the signal
    if (!sameIds(before.childIds, node.childIds)) structural.push(id);
  }
  // A node that vanished entirely and whose parent also vanished is covered by
  // the surviving ancestor above. One whose parent survived is covered by that
  // parent's childIds. So `structural` is empty only if the shape is identical.
  if (structural.length > 0) {
    return { kind: 'layout', parent: nearestCommonAncestor(next, structural) };
  }

  const updated = [];
  const removed = [];
  for (const [id, node] of next) {
    const before = prev.get(id);
    if (!before) continue;
    const changed = {};
    const gone = [];
    for (const [name, value] of Object.entries(node.props)) {
      if (!sameValue(before.props[name], value)) changed[name] = value;
    }
    for (const name of Object.keys(before.props)) {
      if (!(name in node.props)) gone.push(name);
    }
    if (Object.keys(changed).length > 0) updated.push([id, changed]);
    if (gone.length > 0) removed.push([id, gone]);
  }

  if (updated.length === 0 && removed.length === 0) return { kind: 'none' };
  return { kind: 'properties', updated, removed };
}

// --------------------------------------------------------------------------
// Answering the protocol
// --------------------------------------------------------------------------

/** `props` filtered to `names`, or all of them when the shell asked for none. */
function filterProps(props, names) {
  if (!names || names.length === 0) return props;
  const out = {};
  // `hasOwn`, not `in`: a shell asking for `constructor` or `toString` would
  // otherwise be answered with a function, which fails to marshal and turns
  // one nonsense property name into an error reply for the whole call.
  for (const name of names)
    if (Object.hasOwn(props, name)) out[name] = props[name];
  return out;
}

/**
 * `GetLayout`'s recursive `(ia{sv}av)`, as plain values — the caller wraps
 * them for the wire.
 *
 * `depth` follows the spec: `-1` recurses all the way, `0` stops at this item,
 * `n` takes n levels of children.
 */
export function layoutOf(nodes, id, depth, names) {
  const node = nodes.get(id);
  if (!node) return null;
  const children =
    depth === 0
      ? []
      : node.childIds
          .map((child) =>
            layoutOf(nodes, child, depth < 0 ? -1 : depth - 1, names),
          )
          .filter(Boolean);
  return [node.id, filterProps(node.props, names), children];
}

/** `GetGroupProperties`' `a(ia{sv})`. Unknown ids are skipped, not an error. */
export function groupProperties(nodes, ids, names) {
  const wanted = ids && ids.length > 0 ? ids : [...nodes.keys()];
  const out = [];
  for (const id of wanted) {
    const node = nodes.get(id);
    if (node) out.push([id, filterProps(node.props, names)]);
  }
  return out;
}

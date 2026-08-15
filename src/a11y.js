// The accessibility model: standard `role` / `aria-*` props resolved against
// the retained node tree, plus the hook slots the renderer polls.
//
// This file is the cheap half. It is imported unconditionally by nodes.js,
// events.js and Reconciler.js, so it must cost nothing when accessibility is
// off: no D-Bus, no node builtins, no side effects — the hot paths pay one
// property read per hook (`hooks.focus?.(…)`), exactly the trace-registry
// pattern. The expensive half — the AT-SPI2 bridge that mirrors this model
// onto the accessibility bus — lives in atspi.js and is only imported once a
// root exists (and never with REACT_X11_A11Y=0).
//
// ## The vocabulary is the web's, deliberately
//
// `role` takes ARIA role names ('button', 'checkbox', 'tablist', …) and the
// states are `aria-*` props (`aria-checked`, `aria-expanded`,
// `aria-valuenow`, …) — the same names react-dom accepts and React Native
// adopted in 0.71. NEXT_STEPS §11.3 originally suggested the older RN
// vocabulary (`accessibilityRole`, `accessibilityState`); the widgets were
// then built carrying web-style `role` strings years before anything read
// them, which settled the question: the standard names are the ones this
// codebase already speaks. A component library that sets `role="option"` and
// `aria-selected` on a `<box>` is accessible here with no react-x11-specific
// knowledge at all.
//
// What there is NOT: `aria-labelledby`/`aria-describedby` (no id registry to
// resolve them against — `aria-label` and name-from-contents cover the
// widgets; relations are a later addition), `aria-live` regions (announce()
// is the explicit version), and no `aria-disabled` — `disabled` is already a
// host prop with real behaviour (it blocks focus), and a parallel prop that
// only *said* disabled would let the two disagree.
//
// ## Roles and states are AT-SPI's, numerically
//
// The tables below are the AT-SPI2 enums, generated from the installed
// introspection data (at-spi2-core 2.60.4, gi.repository.Atspi — the same
// tables Orca reads) and checked against at-spi2-core's xml/. They are
// append-only upstream, so the numbers are stable forever; regenerate with:
//
//   python3 -c "import gi; gi.require_version('Atspi','2.0'); \
//     from gi.repository import Atspi; \
//     print({k: int(getattr(Atspi.Role, k)) for k in dir(Atspi.Role) if not k.startswith('_')})"

/** AT-SPI role numbers (AtspiRole). */
export const ATSPI_ROLE = Object.freeze({
  INVALID: 0,
  ALERT: 2,
  CANVAS: 6,
  CHECK_BOX: 7,
  CHECK_MENU_ITEM: 8,
  COLUMN_HEADER: 10,
  COMBO_BOX: 11,
  DIAL: 15,
  DIALOG: 16,
  DRAWING_AREA: 18,
  FILE_CHOOSER: 19,
  FILLER: 20,
  FRAME: 23,
  ICON: 26,
  IMAGE: 27,
  LABEL: 29,
  LIST: 31,
  LIST_ITEM: 32,
  MENU: 33,
  MENU_BAR: 34,
  MENU_ITEM: 35,
  PAGE_TAB: 37,
  PAGE_TAB_LIST: 38,
  PANEL: 39,
  PASSWORD_TEXT: 40,
  POPUP_MENU: 41,
  PROGRESS_BAR: 42,
  BUTTON: 43,
  RADIO_BUTTON: 44,
  RADIO_MENU_ITEM: 45,
  ROW_HEADER: 47,
  SCROLL_BAR: 48,
  SCROLL_PANE: 49,
  SEPARATOR: 50,
  SLIDER: 51,
  SPIN_BUTTON: 52,
  SPLIT_PANE: 53,
  STATUS_BAR: 54,
  TABLE: 55,
  TABLE_CELL: 56,
  TABLE_COLUMN_HEADER: 57,
  TABLE_ROW_HEADER: 58,
  TEXT: 61,
  TOGGLE_BUTTON: 62,
  TOOL_BAR: 63,
  TOOL_TIP: 64,
  TREE: 65,
  TREE_TABLE: 66,
  UNKNOWN: 67,
  VIEWPORT: 68,
  WINDOW: 69,
  HEADER: 71,
  FOOTER: 72,
  PARAGRAPH: 73,
  APPLICATION: 75,
  AUTOCOMPLETE: 76,
  // another toolkit's widget hierarchy inside ours — AT-SPI's own word for
  // what `<foreign>` holds. The AT walks into the client's tree, not ours.
  EMBEDDED: 78,
  ENTRY: 79,
  CAPTION: 81,
  DOCUMENT_FRAME: 82,
  HEADING: 83,
  SECTION: 85,
  FORM: 87,
  LINK: 88,
  TABLE_ROW: 90,
  TREE_ITEM: 91,
  DOCUMENT_TEXT: 94,
  DOCUMENT_WEB: 95,
  COMMENT: 97,
  LIST_BOX: 98,
  GROUPING: 99,
  NOTIFICATION: 101,
  INFO_BAR: 102,
  LEVEL_BAR: 103,
  BLOCK_QUOTE: 105,
  ARTICLE: 109,
  LANDMARK: 110,
  LOG: 111,
  MARQUEE: 112,
  MATH: 113,
  RATING: 114,
  TIMER: 115,
  STATIC: 116,
  DESCRIPTION_LIST: 121,
  DESCRIPTION_TERM: 122,
  DESCRIPTION_VALUE: 123,
  SWITCH: 130,
});

/** AT-SPI state numbers (AtspiStateType). A state set is a 64-bit field
 * carried as two uint32s. */
export const ATSPI_STATE = Object.freeze({
  ACTIVE: 1,
  BUSY: 3,
  CHECKED: 4,
  COLLAPSED: 5,
  DEFUNCT: 6,
  EDITABLE: 7,
  ENABLED: 8,
  EXPANDABLE: 9,
  EXPANDED: 10,
  FOCUSABLE: 11,
  FOCUSED: 12,
  HORIZONTAL: 14,
  MODAL: 16,
  MULTI_LINE: 17,
  PRESSED: 20,
  RESIZABLE: 21,
  SELECTABLE: 22,
  SELECTED: 23,
  SENSITIVE: 24,
  SHOWING: 25,
  SINGLE_LINE: 26,
  VERTICAL: 29,
  VISIBLE: 30,
  INDETERMINATE: 32,
  REQUIRED: 33,
  CHECKABLE: 41,
  HAS_POPUP: 42,
  READ_ONLY: 43,
});

/**
 * The state-changed event's detail string for each state: the GLib enum
 * nick, which is the constant name lowercased with dashes. Orca matches on
 * these ("object:state-changed:focused").
 */
export const ATSPI_STATE_NICK = Object.freeze(
  Object.fromEntries(
    Object.entries(ATSPI_STATE).map(([name, bit]) => [
      bit,
      name.toLowerCase().replaceAll('_', '-'),
    ]),
  ),
);

/**
 * The AT-SPI role *name* for each role number — the constant lowercased
 * with spaces ("check box", "page tab list"), which is what
 * `atspi_role_get_name` produces and therefore what every AT means by a
 * role name.
 *
 * This is deliberately **not** the ARIA role the app wrote. libatspi
 * derives role names locally from the number, so a bridge that answered
 * `GetRoleName` with its own vocabulary would be inconsistent with its own
 * `GetRole` and nobody would notice until an AT asked over the wire. The
 * app's ARIA role travels as the `xml-roles` attribute instead, which is
 * where Chromium and Firefox put it and where Orca looks for it.
 */
export const ATSPI_ROLE_NICK = Object.freeze(
  Object.fromEntries(
    Object.entries(ATSPI_ROLE).map(([name, role]) => [
      role,
      name.toLowerCase().replaceAll('_', ' '),
    ]),
  ),
);

/**
 * ARIA role name → AT-SPI role. The mapping follows what the web engines
 * send to AT-SPI on Linux (Chromium's ax_platform_node_auralinux, Firefox's
 * nsRoleMap), so Orca sees from a react-x11 app exactly what it sees from a
 * browser. Roles with no AT-SPI counterpart borrow the engines' choices
 * ('option' → LIST_ITEM, 'meter' → LEVEL_BAR).
 */
const ROLE_TO_ATSPI = new Map(
  Object.entries({
    alert: ATSPI_ROLE.ALERT,
    alertdialog: ATSPI_ROLE.DIALOG,
    article: ATSPI_ROLE.ARTICLE,
    banner: ATSPI_ROLE.LANDMARK,
    blockquote: ATSPI_ROLE.BLOCK_QUOTE,
    button: ATSPI_ROLE.BUTTON,
    caption: ATSPI_ROLE.CAPTION,
    cell: ATSPI_ROLE.TABLE_CELL,
    checkbox: ATSPI_ROLE.CHECK_BOX,
    columnheader: ATSPI_ROLE.COLUMN_HEADER,
    combobox: ATSPI_ROLE.COMBO_BOX,
    comment: ATSPI_ROLE.COMMENT,
    complementary: ATSPI_ROLE.LANDMARK,
    contentinfo: ATSPI_ROLE.LANDMARK,
    dialog: ATSPI_ROLE.DIALOG,
    document: ATSPI_ROLE.DOCUMENT_FRAME,
    form: ATSPI_ROLE.FORM,
    grid: ATSPI_ROLE.TABLE,
    gridcell: ATSPI_ROLE.TABLE_CELL,
    group: ATSPI_ROLE.GROUPING,
    heading: ATSPI_ROLE.HEADING,
    img: ATSPI_ROLE.IMAGE,
    link: ATSPI_ROLE.LINK,
    list: ATSPI_ROLE.LIST,
    listbox: ATSPI_ROLE.LIST_BOX,
    listitem: ATSPI_ROLE.LIST_ITEM,
    log: ATSPI_ROLE.LOG,
    main: ATSPI_ROLE.LANDMARK,
    marquee: ATSPI_ROLE.MARQUEE,
    math: ATSPI_ROLE.MATH,
    menu: ATSPI_ROLE.MENU,
    menubar: ATSPI_ROLE.MENU_BAR,
    menuitem: ATSPI_ROLE.MENU_ITEM,
    menuitemcheckbox: ATSPI_ROLE.CHECK_MENU_ITEM,
    menuitemradio: ATSPI_ROLE.RADIO_MENU_ITEM,
    meter: ATSPI_ROLE.LEVEL_BAR,
    navigation: ATSPI_ROLE.LANDMARK,
    note: ATSPI_ROLE.COMMENT,
    option: ATSPI_ROLE.LIST_ITEM,
    paragraph: ATSPI_ROLE.PARAGRAPH,
    progressbar: ATSPI_ROLE.PROGRESS_BAR,
    radio: ATSPI_ROLE.RADIO_BUTTON,
    radiogroup: ATSPI_ROLE.PANEL,
    region: ATSPI_ROLE.LANDMARK,
    row: ATSPI_ROLE.TABLE_ROW,
    rowheader: ATSPI_ROLE.ROW_HEADER,
    scrollbar: ATSPI_ROLE.SCROLL_BAR,
    search: ATSPI_ROLE.LANDMARK,
    searchbox: ATSPI_ROLE.ENTRY,
    separator: ATSPI_ROLE.SEPARATOR,
    slider: ATSPI_ROLE.SLIDER,
    spinbutton: ATSPI_ROLE.SPIN_BUTTON,
    status: ATSPI_ROLE.STATUS_BAR,
    switch: ATSPI_ROLE.SWITCH,
    tab: ATSPI_ROLE.PAGE_TAB,
    table: ATSPI_ROLE.TABLE,
    tablist: ATSPI_ROLE.PAGE_TAB_LIST,
    tabpanel: ATSPI_ROLE.PANEL,
    term: ATSPI_ROLE.DESCRIPTION_TERM,
    textbox: ATSPI_ROLE.ENTRY,
    timer: ATSPI_ROLE.TIMER,
    toolbar: ATSPI_ROLE.TOOL_BAR,
    tooltip: ATSPI_ROLE.TOOL_TIP,
    tree: ATSPI_ROLE.TREE,
    treegrid: ATSPI_ROLE.TREE_TABLE,
    treeitem: ATSPI_ROLE.TREE_ITEM,
    window: ATSPI_ROLE.WINDOW,
  }),
);

/** The web role names this renderer understands. Exported for the DEV
 * warning's message and for tests. */
export const KNOWN_ROLES = Object.freeze([
  ...ROLE_TO_ATSPI.keys(),
  'none',
  'presentation',
]);

/**
 * What an element is when nothing says otherwise. `<box>` is FILLER — the
 * role GTK gives its own layout containers, which screen readers know to
 * step over silently — so an unlabelled tree is *boring* to a screen reader
 * rather than noisy. Everything with real semantics gets them here, so an
 * app that never writes a `role` still reads: windows are frames, text is a
 * label, an input is an entry.
 */
const KIND_ROLES = {
  window: ATSPI_ROLE.FRAME,
  popup: ATSPI_ROLE.WINDOW,
  box: ATSPI_ROLE.FILLER,
  text: ATSPI_ROLE.LABEL,
  image: ATSPI_ROLE.IMAGE,
  canvas: ATSPI_ROLE.DRAWING_AREA,
  textinput: ATSPI_ROLE.ENTRY,
  textarea: ATSPI_ROLE.ENTRY,
  svg: ATSPI_ROLE.IMAGE,
  glarea: ATSPI_ROLE.CANVAS,
  foreign: ATSPI_ROLE.EMBEDDED,
};

/** The kind → web-role-name table `roleOf()` in the test queries also
 * reads, kept here so the queries and the bridge cannot disagree. */
export const KIND_ROLE_NAMES = Object.freeze({
  window: 'window',
  popup: 'window',
  text: 'text',
  image: 'img',
  canvas: 'canvas',
  textinput: 'textbox',
  textarea: 'textbox',
});

/**
 * Roles whose accessible name comes from their contents when no
 * `aria-label` names them — ARIA's name-from-content set, which is how
 * `<Button>OK</Button>` gets the name "OK" from the `<text>` inside it.
 */
const NAME_FROM_CONTENTS = new Set([
  'button',
  'cell',
  'checkbox',
  'columnheader',
  'combobox',
  'gridcell',
  'heading',
  'link',
  'listitem',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'row',
  'rowheader',
  'switch',
  'tab',
  'tooltip',
  'treeitem',
]);

/** Roles that promise activation, so the bridge exposes an AT-SPI action
 * for them even when the click handler lives on an ancestor. */
const ACTIVATABLE_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'switch',
  'tab',
  'treeitem',
]);

/** Kinds that are internal structure, never accessibility objects: chunks
 * and spans are the *content* of their `<text>`, SVG children belong to
 * their `<svg>`'s raster. */
const INTERNAL_KINDS = new Set(['textchunk', 'svgchild']);

// --------------------------------------------------------------------------
// The tree projection
// --------------------------------------------------------------------------

/**
 * A scroll pane is now a *style* on an ordinary container rather than an
 * element of its own, so the role comes off `overflow` where it used to come
 * off the kind. Deliberately `isScroller()` and not "is there anything to
 * scroll right now": the role is what the node *is*, and a pane flickering
 * between `scroll pane` and `filler` as its content grows would be reported
 * to a screen reader as the object being replaced.
 */
const scrolls = (node) => !node.isWindow && node.isScroller?.() === true;

/**
 * The web role name in force on a node, in the order the answers get less
 * specific: what the application wrote, what the element says it is
 * (`node.a11yRole` — a registered element's own default, see
 * docs/extending.md), what it holds, whether it scrolls, and finally the
 * kind's default name (only the kinds with real semantics have one).
 *
 * A registered element's declaration sits **above** the scroller rule on
 * purpose: an editor that scrolls its own painted text is a text box that
 * happens to scroll, and reading it as a scroll pane would lose the only
 * part a screen reader cares about.
 */
export function roleNameOf(node) {
  const role = node.props?.role;
  if (typeof role === 'string' && role !== '') return role;
  const own = node.a11yRole;
  if (typeof own === 'string' && own !== '') return own;
  const text = textRoleName(node);
  if (text !== null) return text;
  if (scrolls(node)) return 'scrollable';
  return KIND_ROLE_NAMES[node.kind] ?? null;
}

/** The AT-SPI role number for a node, by the same order. An unknown role
 * string falls back to the next answer rather than to nothing — a typo
 * should not turn a button into a filler silently, but it must not crash
 * either; the DEV check below is what reports it. */
export function atspiRoleOf(node) {
  for (const name of [node.props?.role, node.a11yRole, textRoleName(node)]) {
    if (typeof name !== 'string') continue;
    const mapped = ROLE_TO_ATSPI.get(name);
    if (mapped !== undefined) return mapped;
  }
  if (scrolls(node)) return ATSPI_ROLE.SCROLL_PANE;
  return KIND_ROLES[node.kind] ?? ATSPI_ROLE.UNKNOWN;
}

/** `role="none"`/`"presentation"`: the node is layout, its children are
 * not. It disappears from the accessible tree and its children take its
 * place — ARIA's semantics, and what keeps a wrapper `<box>` from adding a
 * level of "filler" around every widget that needs one for styling. */
export function a11yErased(node) {
  const role = node.props?.role;
  return role === 'none' || role === 'presentation';
}

/** Whole-subtree removal: `aria-hidden`, the internal content kinds, and
 * `<text>` spans (the outer `<text>` speaks for the whole run). */
export function a11yPruned(node) {
  if (node.props?.['aria-hidden'] === true) return true;
  if (INTERNAL_KINDS.has(node.kind)) return true;
  if (node.kind === 'text' && node.isSpan) return true;
  return false;
}

/**
 * A node's children as assistive technology sees them: pruned subtrees
 * gone, erased nodes replaced by their children, and — for an element that
 * draws its own scene — the items it says are in it (see below).
 * `<glarea>` children are 3D scene nodes with their own vocabulary and no
 * rectangles — a glarea is a leaf up here.
 */
export function a11yChildren(node) {
  if (node.kind === 'glarea') return [];
  const out = [];
  for (const child of node.children ?? []) accessibleInto(out, child);
  // What an element drew comes after what it holds: both are its children,
  // and only the retained ones have an order React gave them.
  for (const item of a11ySceneItems(node)) accessibleInto(out, item);
  return out;
}

function accessibleInto(out, child) {
  if (child.destroyed || a11yPruned(child)) return;
  if (a11yErased(child)) out.push(...a11yChildren(child));
  else out.push(child);
}

/** The accessible parent: the nearest ancestor that is itself in the
 * accessible tree (skipping erased wrappers). Null for a toplevel window —
 * the bridge parents those on the application. */
export function a11yParent(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (!a11yErased(p) && !a11yPruned(p)) return p;
  }
  return null;
}

/** Index of `node` among its accessible siblings, -1 when detached. */
export function a11yIndexIn(parent, node) {
  return a11yChildren(parent).indexOf(node);
}

// --------------------------------------------------------------------------
// The scene an element draws (issue #304)
// --------------------------------------------------------------------------
//
// A registered element that draws N interactive things — a graph, a chart, a
// timeline, a seating plan — is one retained node, so it is one accessible:
// "Flow graph, group", and nothing inside it exists. The way out is the same
// one every canvas-scene toolkit ends up at (the web's fallback DOM, Qt's
// QAccessibleInterface children): the element *describes* what it drew, and
// those descriptions become accessible children.
//
// They are objects rather than plain descriptors because the bridge exports
// one accessible per child and keys it on the object — a list rebuilt every
// frame would otherwise be a tree that replaces itself between two reads,
// with every ref an AT is holding dead. `id` is what survives the frame;
// everything else is re-read from the element each time.
//
// Everything below is written so that a scene item is read by the same
// functions a `<box>` is read by: it carries `props` in the same `role` /
// `aria-*` vocabulary, an `abs` rect in the same window coordinates, and a
// `parent`. There is no second model here, only a second way of producing
// the one there is.

/** The shared empty list, so a node with no scene allocates nothing. */
const NO_ITEMS = Object.freeze([]);

/** The states a scene item declares, and the prop each is read as. The
 * element writes `selected`; the model reads `aria-selected` — the same
 * props the element itself would have carried, so states are derived by
 * `a11yStates` rather than by a table of their own. */
const ITEM_STATE_PROPS = Object.entries({
  selected: 'aria-selected',
  checked: 'aria-checked',
  expanded: 'aria-expanded',
  busy: 'aria-busy',
  disabled: 'disabled',
});

const finite = (value) => (Number.isFinite(value) ? value : 0);

/**
 * One thing an element drew, as an accessibility object. Data and identity
 * only: what an assistive technology *does* to it is routed back to the
 * element by the bridge, which is where every other AT-initiated behaviour
 * lives.
 */
class SceneItem {
  constructor(owner, parent, id) {
    /** The element that drew this and the id it knows it by — the two
     * halves of an action's address. */
    this.a11yOwner = owner;
    this.a11yId = id;
    // The owner's element name on purpose: an item is part of that element,
    // so a DEV warning about a role names the tag its author wrote rather
    // than a word from in here. The role never falls through to the kind
    // table anyway — `a11yRole` below is always set.
    this.kind = owner.kind;
    this.parent = parent;
    this.children = NO_ITEMS;
    this.props = {};
    this.abs = { x: 0, y: 0, width: 0, height: 0 };
    this.destroyed = false;
    this.hidden = false;
    /** What an item is when it names no role: audible, and promising
     * nothing the element has not said. A real role — `listitem`,
     * `button`, `treeitem` — is what makes it activatable. */
    this.a11yRole = 'group';
    /** The element's own keyboard cursor. It never reaches the window's
     * focus manager, which is still holding the element itself. */
    this.a11yFocused = false;
    this.focusableByDefault = true;
    /** id -> SceneItem for the nested scene, built only if there is one. */
    this._a11ySceneCache = null;
  }

  /** The owning window, for the states and the coordinate systems. */
  get root() {
    return this.a11yOwner.root;
  }

  get isWindow() {
    return false;
  }

  /** Re-read one frame's description. Same object, new facts. */
  _read(desc) {
    const props = { ...desc.props };
    if (desc.role != null) props.role = desc.role;
    if (desc.name != null) props['aria-label'] = String(desc.name);
    if (desc.description != null) {
      props['aria-description'] = String(desc.description);
    }
    const states = desc.states;
    if (states) {
      for (const [name, prop] of ITEM_STATE_PROPS) {
        if (states[name] !== undefined) props[prop] = states[name];
      }
    }
    this.props = props;
    this.a11yFocused = states?.focused === true;
    this.focusableByDefault = desc.focusable !== false;
    const rect = desc.rect;
    this.abs = {
      x: finite(rect?.x),
      y: finite(rect?.y),
      width: finite(rect?.width),
      height: finite(rect?.height),
    };
    const children = desc.children;
    if (Array.isArray(children) && children.length > 0) {
      this._a11ySceneCache ??= new Map();
      this.children = reconcileScene(
        this.a11yOwner,
        this,
        children,
        this._a11ySceneCache,
      );
    } else {
      if (this._a11ySceneCache?.size > 0) dropScene(this._a11ySceneCache);
      this.children = NO_ITEMS;
    }
  }
}

/** An item that left the scene is defunct rather than forgotten: an AT may
 * still be holding it, and the bridge has to walk the subtree it is losing
 * to release the paths under it. */
function markGone(item) {
  item.destroyed = true;
  for (const child of item.children) markGone(child);
}

function dropScene(cache) {
  for (const item of cache.values()) markGone(item);
  cache.clear();
}

const badIds = new Set();

function devCheckItemId(owner, id, duplicate) {
  if (process.env.NODE_ENV === 'production') return;
  const key = `${owner.kind}:${id}:${duplicate}`;
  if (badIds.has(key)) return;
  badIds.add(key);
  console.warn(
    duplicate
      ? `react-x11: <${owner.kind}> reported two accessible children with ` +
          `the id "${id}" — ids address an item for the whole time it is on ` +
          'screen, so the second one is dropped.'
      : `react-x11: <${owner.kind}> reported an accessible child with no ` +
          'id. An id is what keeps a child the same object across frames, ' +
          'so this one is dropped.',
  );
}

/**
 * Match one frame's descriptions against the objects the last frame left:
 * an id that is still there keeps its object — and with it its D-Bus path,
 * its snapshot and every ref an AT is holding — a new one gets one, and one
 * that is gone is marked defunct and dropped.
 */
function reconcileScene(owner, parent, declared, cache) {
  if (!Array.isArray(declared) || declared.length === 0) {
    if (cache.size > 0) dropScene(cache);
    return NO_ITEMS;
  }
  const items = [];
  const seen = new Set();
  for (const desc of declared) {
    const id = desc == null ? '' : String(desc.id ?? '');
    if (id === '' || seen.has(id)) {
      devCheckItemId(owner, id, id !== '');
      continue;
    }
    seen.add(id);
    let item = cache.get(id);
    if (!item) {
      item = new SceneItem(owner, parent, id);
      cache.set(id, item);
    }
    item._read(desc);
    items.push(item);
  }
  for (const [id, item] of cache) {
    if (seen.has(id)) continue;
    markGone(item);
    cache.delete(id);
  }
  return items;
}

/**
 * What an element says it drew, as accessibility objects with an identity
 * that survives the frame. Empty — and free — for everything that draws no
 * scene, which is every element core ships.
 *
 * Called once per question the bridge answers about the element's children,
 * so `a11yScene()` has to be a cheap read of what the element already
 * holds, exactly as `a11yTextState()` is.
 */
export function a11ySceneItems(node) {
  if (typeof node.a11yScene !== 'function') return NO_ITEMS;
  node._a11ySceneCache ??= new Map();
  return reconcileScene(node, node, node.a11yScene(), node._a11ySceneCache);
}

/** The accessible children of a node that are drawn rather than retained:
 * an element's own scene, or a scene item's nested one. */
export function sceneChildrenOf(node) {
  if (typeof node.a11yScene === 'function') return a11ySceneItems(node);
  return node.a11yOwner ? node.children : NO_ITEMS;
}

/** The scene items a node last reported, without asking it again — for
 * teardown, where the element is going away and its answer is moot. */
export function knownSceneItems(node) {
  if (typeof node.a11yScene !== 'function') return NO_ITEMS;
  const cache = node._a11ySceneCache;
  return cache && cache.size > 0 ? [...cache.values()] : NO_ITEMS;
}

/** Whether this object is one of an element's drawn children. */
export const isSceneItem = (node) => node instanceof SceneItem;

// --------------------------------------------------------------------------
// Name, description, states, value
// --------------------------------------------------------------------------

/** Visible text of a subtree, for name-from-contents: every chunk under the
 * node, in tree order, hidden branches skipped. */
export function subtreeText(node) {
  const parts = [];
  const walk = (n) => {
    if (n.props?.['aria-hidden'] === true || n.hidden) return;
    if (n.kind === 'textchunk' && typeof n.text === 'string') {
      parts.push(n.text);
      return;
    }
    // do not read a nested control's own text as its parent's label — its
    // value is its Text interface, not a name for whatever contains it
    if (n !== node && textShapeOf(n) !== null) return;
    for (const child of n.children ?? []) {
      if (!child.isWindow) walk(child);
    }
  };
  walk(node);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * The accessible name, by the ARIA precedence that fits what exists here:
 * `aria-label` above everything; then what the element itself carries (a
 * window's `title`, an image's `alt`, an input's `placeholder` as the
 * fallback the web engines also use); then contents, for the roles whose
 * contents are their label.
 */
export function a11yName(node) {
  const label = node.props?.['aria-label'];
  if (typeof label === 'string' && label !== '') return label;
  if (node.isWindow) return node.props?.title ?? '';
  if (node.kind === 'image' || node.kind === 'svg') {
    return node.props?.alt ?? '';
  }
  if (node.kind === 'textinput' || node.kind === 'textarea') {
    return node.props?.placeholder ?? '';
  }
  const role = roleNameOf(node);
  if (role !== null && NAME_FROM_CONTENTS.has(role)) return subtreeText(node);
  if (node.kind === 'text') return subtreeText(node);
  return '';
}

export function a11yDescription(node) {
  const description = node.props?.['aria-description'];
  return typeof description === 'string' ? description : '';
}

/**
 * Whether the event manager would let this node take focus — the same rule
 * as `EventManager._isFocusable`, which now delegates here so the answer
 * the keyboard gives and the answer the screen reader hears cannot drift.
 */
export function isFocusable(node) {
  if (node.props.disabled) return false;
  // A `selectable` surface is a focus target for the same reason a scroll
  // pane is: the keys that operate it — Ctrl+A, Ctrl+C — have to arrive
  // somewhere, and a document nobody can copy from with the keyboard is a
  // WCAG 2.1.1 failure on the one feature it exists for. `tabIndex={-1}`
  // keeps it clickable and takes it back out of the Tab cycle.
  const byDefault =
    (node.focusableByDefault ?? false) || node.props.selectable === true;
  return (
    node.props.focusable ?? (node.props.tabIndex != null ? true : byDefault)
  );
}

const bit = (states, state) => {
  if (state < 32) states[0] |= 1 << state;
  else states[1] |= 1 << (state - 32);
};

/** True when the node and every ancestor up to its window is neither
 * `hidden` nor `display: 'none'`. */
function effectivelyVisible(node) {
  for (let n = node; n; n = n.parent) {
    if (n.destroyed || n.hidden || n.style?.display === 'none') return false;
    if (n.isWindow) break;
  }
  return true;
}

/**
 * The AT-SPI state set, as the two uint32s the wire carries. Everything is
 * derived — from the props, the kind, and the same live state the widgets
 * draw from — so it cannot disagree with the screen.
 */
export function a11yStates(node) {
  const states = [0, 0];
  const props = node.props ?? {};
  const S = ATSPI_STATE;
  if (node.destroyed) {
    bit(states, S.DEFUNCT);
    return states;
  }
  const role = roleNameOf(node);

  if (!props.disabled) {
    bit(states, S.ENABLED);
    bit(states, S.SENSITIVE);
  }
  if (isFocusable(node)) bit(states, S.FOCUSABLE);
  // A scene item's focus is the element's own answer: a cursor inside a
  // drawn scene never reaches the window's focus manager, which is still
  // holding the element itself.
  const focused = node.a11yFocused ?? node._focusManager?.()?.focused === node;
  if (focused) bit(states, S.FOCUSED);

  if (effectivelyVisible(node)) {
    bit(states, S.VISIBLE);
    // SHOWING additionally wants the pixels to be reachable: the owning
    // window has to actually exist on the server
    const owner = node.isWindow ? node : node.root;
    if (owner?.window) bit(states, S.SHOWING);
  }

  const checked = props['aria-checked'];
  if (
    checked != null ||
    role === 'checkbox' ||
    role === 'radio' ||
    role === 'switch' ||
    role === 'menuitemcheckbox' ||
    role === 'menuitemradio'
  ) {
    bit(states, S.CHECKABLE);
  }
  if (checked === true || checked === 'true') bit(states, S.CHECKED);
  if (checked === 'mixed') bit(states, S.INDETERMINATE);

  const pressed = props['aria-pressed'];
  if (pressed === true || pressed === 'true') bit(states, S.PRESSED);

  const expanded = props['aria-expanded'];
  if (expanded != null) {
    bit(states, S.EXPANDABLE);
    if (expanded === true || expanded === 'true') bit(states, S.EXPANDED);
    else bit(states, S.COLLAPSED);
  }

  const selected = props['aria-selected'];
  if (selected != null) bit(states, S.SELECTABLE);
  if (selected === true || selected === 'true') bit(states, S.SELECTED);

  if (props['aria-busy'] === true) bit(states, S.BUSY);
  if (props['aria-required'] === true) bit(states, S.REQUIRED);
  if (props['aria-haspopup']) bit(states, S.HAS_POPUP);
  if (props['aria-modal'] === true || (role === 'dialog' && props.trapFocus)) {
    bit(states, S.MODAL);
  }

  const orientation = props['aria-orientation'];
  if (orientation === 'horizontal') bit(states, S.HORIZONTAL);
  if (orientation === 'vertical') bit(states, S.VERTICAL);

  const readOnly = props['aria-readonly'] === true;
  if (readOnly) bit(states, S.READ_ONLY);
  const text = textShapeOf(node);
  if (text) {
    // `multiline` is a claim about the element's shape, so a registered
    // element that makes none gets neither state rather than a guess read
    // off its current value — which would report the shape *changing* the
    // first time somebody pressed Enter.
    if (text.multiline === true) bit(states, S.MULTI_LINE);
    else if (text.multiline === false) bit(states, S.SINGLE_LINE);
    if (text.editable && !props.disabled && !readOnly) bit(states, S.EDITABLE);
  }

  if (node.isWindow) {
    if (node.props?.resizable !== false && !node.isPopup) {
      bit(states, S.RESIZABLE);
    }
    if (node.events?.windowFocused && node.window) bit(states, S.ACTIVE);
  }

  return states;
}

/**
 * The AT-SPI value triple for anything that declares `aria-valuenow` —
 * which is how a slider or progress bar built out of boxes gets a real
 * Value interface. Null when the node has none.
 */
export function a11yValue(node) {
  const now = node.props?.['aria-valuenow'];
  if (typeof now !== 'number' || Number.isNaN(now)) return null;
  const min = numberOr(node.props['aria-valuemin'], 0);
  const max = numberOr(node.props['aria-valuemax'], 100);
  const text = node.props['aria-valuetext'];
  return {
    now,
    min,
    max,
    text: typeof text === 'string' ? text : '',
  };
}

function numberOr(value, fallback) {
  return typeof value === 'number' && !Number.isNaN(value) ? value : fallback;
}

/** Object attributes (`Accessible.GetAttributes`): the ARIA leftovers that
 * are neither role nor state. Orca reads `level` for "level 2", and
 * `posinset`/`setsize` for "3 of 7". */
export function a11yAttributes(node) {
  const attrs = [];
  const props = node.props ?? {};
  const role = props.role;
  if (typeof role === 'string' && role !== '') attrs.push(['xml-roles', role]);
  const level = props['aria-level'];
  if (typeof level === 'number') attrs.push(['level', String(level)]);
  const posinset = props['aria-posinset'];
  if (typeof posinset === 'number') attrs.push(['posinset', String(posinset)]);
  const setsize = props['aria-setsize'];
  if (typeof setsize === 'number') attrs.push(['setsize', String(setsize)]);
  const shortcuts = props['aria-keyshortcuts'];
  if (typeof shortcuts === 'string' && shortcuts !== '') {
    // the core-aam mapping ARIA gives it; Orca announces it with the item
    attrs.push(['keyshortcuts', shortcuts]);
  }
  return attrs;
}

/** Whether the bridge should offer an "activate" action: an explicit
 * handler, or a role that promises one (widgets often keep the handler on
 * an ancestor of the role-carrying node — activation is dispatched through
 * the tree, so the promise still holds). */
export function a11yActivatable(node) {
  if (typeof node.props?.onClick === 'function') return true;
  // A drawn item whose element answers actions is activatable whatever it
  // is called: implementing the seam is the same promise a handler is, and
  // the roles a scene reaches for — `listitem` for a graph node — are
  // mostly ones ARIA does not make that promise about.
  if (typeof node.a11yOwner?.a11ySceneAction === 'function') return true;
  const role = roleNameOf(node);
  return role !== null && ACTIVATABLE_ROLES.has(role);
}

// --------------------------------------------------------------------------
// Text state — shared by the AT-SPI bridge's Text interface and the test
// spy, because both answer the same question: what would an assistive
// technology read out of this control right now?
// --------------------------------------------------------------------------

/** The built-in editable controls, which report through their own
 * internals rather than through the seam below. */
export const isNativeTextControl = (node) =>
  node.kind === 'textinput' || node.kind === 'textarea';

/**
 * A registered element's own answer to "what text am I holding, and where
 * is the caret" (issue #257), normalized into the shape the bridge and the
 * spy already speak — or null for an element that holds none.
 *
 * The element writes `{ value, caret, selectionStart, selectionEnd,
 * editable, multiline, preedit }` and every field but `value` is optional;
 * offsets are code points (`Array.from`), clamped here so a stale caret an
 * element hands over cannot become an out-of-range answer on the wire.
 * Everything downstream — character counts, word and line granularity,
 * attribute runs, the text-changed diff — is then the same code that
 * serves `<textinput>`, which is the point: a third-party editor is
 * readable by the same paths, not by a parallel set of them.
 *
 * This is called several times per change (role, states, the diff), so an
 * element's implementation has to be a cheap read of what it already
 * holds — never a shaping pass or a copy of its buffer.
 */
export function customTextState(node) {
  if (typeof node.a11yTextState !== 'function') return null;
  const state = node.a11yTextState();
  if (state == null) return null;
  const chars = Array.from(String(state.value ?? ''));
  const at = (value, fallback) => {
    const index = Math.trunc(Number(value));
    return Number.isFinite(index)
      ? Math.max(0, Math.min(index, chars.length))
      : fallback;
  };
  const start = at(state.selectionStart, 0);
  const end = at(state.selectionEnd, start);
  const composing = state.preedit ? String(state.preedit.text ?? '') : '';
  return {
    chars,
    caret: at(state.caret, end),
    selection: [Math.min(start, end), Math.max(start, end)],
    preedit: composing
      ? {
          offset: at(state.preedit.offset, 0),
          length: Array.from(composing).length,
          text: composing,
        }
      : null,
    editable: state.editable === true,
    multiline: typeof state.multiline === 'boolean' ? state.multiline : null,
  };
}

/**
 * What kind of text an element holds — whether it is editable, and whether
 * it is one line or many (`null` for an element that has not said). Null
 * when it holds none.
 */
export function textShapeOf(node) {
  if (isNativeTextControl(node)) {
    return { editable: true, multiline: node.kind === 'textarea' };
  }
  const custom = customTextState(node);
  if (!custom) return null;
  return { editable: custom.editable, multiline: custom.multiline };
}

/** The role an element reporting text falls back to when it declares
 * none: an entry when an assistive technology may type into it, a
 * document when it may only read. */
function textRoleName(node) {
  const shape = textShapeOf(node);
  if (!shape) return null;
  return shape.editable ? 'textbox' : 'document';
}

/** Whether the value is editable text with a caret — what the EDITABLE
 * state and the AT-SPI EditableText interface are about. */
export const isTextControl = (node) => textShapeOf(node)?.editable === true;

/** Everything that exposes the AT-SPI Text interface at all — the editable
 * controls, `<text>` labels (readable but caret-less), and any registered
 * element reporting a text state, editable or not. The read-only tier is
 * what makes a document viewer with a selection speak: markdown, a code
 * block, a terminal. */
export const hasTextInterface = (node) =>
  isNativeTextControl(node) ||
  node.kind === 'text' ||
  customTextState(node) !== null;

/** Whether an assistive technology can write to this element's text: the
 * built-ins always can, a registered element when it implements the write
 * half of the seam. */
export const acceptsTextEdits = (node) =>
  isNativeTextControl(node) || typeof node.a11yReplaceText === 'function';

/**
 * The code points and caret/selection of anything with a Text interface —
 * offsets in AT-SPI are code points, which is also exactly what
 * TextInputNode's `_chars()`/`_caret` already count.
 *
 * The string is the one the control **draws**, an open composition
 * included, and the offsets are indices into it. That is not a detail of
 * wording: every geometric answer the Text interface gives — the extents of
 * character *n*, the offset under a point, where the caret is — is read off
 * the layout of the displayed string (`_valueLayout`), so reporting the
 * committed value while a preedit is showing would put a magnifier's
 * highlight and a braille cursor a preedit's width to the left of the
 * glyphs they are tracking.
 *
 * `preedit` is which part of it is uncommitted — `{ offset, length, text }`
 * in the same code-point space, or null. It is what lets a reader tell a
 * composition from the character it commits: the bridge marks the
 * composition's own churn `:system` and leaves the commit a plain insert
 * (see `_diffText` in atspi.js).
 */
export function textStateOf(node) {
  if (isNativeTextControl(node)) {
    const shown = node._displayValue ? node._displayValue() : null;
    const toDisplay = (index) => node._displayIndex?.(index) ?? index;
    const [start, end] = node._selection?.() ?? [0, 0];
    const preedit = node._preedit ?? '';
    return {
      chars: shown === null ? node._chars() : Array.from(shown),
      caret: toDisplay(node._caret ?? 0),
      selection: [toDisplay(start), toDisplay(end)],
      preedit: preedit
        ? {
            offset: node._preeditStart?.() ?? 0,
            length: Array.from(preedit).length,
            text: preedit,
          }
        : null,
    };
  }
  const custom = customTextState(node);
  if (custom) return custom;
  const spans = node.collectSpans?.([]) ?? [];
  const chars = Array.from(spans.map((s) => s.text).join(''));
  // A label has no caret, but it can have a **selection**: a `<text>` inside
  // a `selectable` surface is part of a document the user drags across
  // (#259), and that range is the one thing about a label that moves at
  // runtime. Reporting it is what puts a magnifier's highlight and a braille
  // display's cursor on the same characters the highlight is painted over.
  const range = node.selectionRange;
  const selection = range ? [range.start, range.end] : [0, 0];
  return { chars, caret: selection[1], selection, preedit: null };
}

/**
 * Whether a `[offset, offset + length)` code-point range lies inside the
 * composition of a `textStateOf` state — the question that separates a
 * preedit's own churn from an edit the user made.
 */
export function inPreedit(state, offset, length) {
  const pre = state?.preedit;
  if (!pre) return false;
  return offset >= pre.offset && offset + length <= pre.offset + pre.length;
}

/** Common-prefix/suffix diff of two code-point arrays →
 * `{ offset, removed, inserted }`, the exact shape AT-SPI text-changed
 * events want. Null when equal. */
export function diffChars(before, after) {
  const bn = before.length;
  const an = after.length;
  let prefix = 0;
  const max = Math.min(bn, an);
  while (prefix < max && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < max - prefix &&
    before[bn - 1 - suffix] === after[an - 1 - suffix]
  ) {
    suffix++;
  }
  if (prefix === bn && prefix === an) return null;
  return {
    offset: prefix,
    removed: before.slice(prefix, bn - suffix),
    inserted: after.slice(prefix, an - suffix),
  };
}

// --------------------------------------------------------------------------
// DEV validation
// --------------------------------------------------------------------------

const warned = new Set();

/**
 * Report an unknown `role` once per name, in development only. Unknown
 * `aria-*` props are deliberately not swept: the set grows with ARIA and a
 * warning list that lags the spec teaches people to stop trusting it.
 */
export function devCheckA11yProps(node) {
  // the element's own default is checked too: a registered element that
  // misspells its `a11yRole` is silently the kind default forever, and it
  // is written once in a constructor rather than visibly at a call site
  for (const role of [node.props?.role, node.a11yRole]) {
    if (role == null) continue;
    if (typeof role !== 'string' || ROLE_TO_ATSPI.has(role)) continue;
    if (role === 'none' || role === 'presentation') continue;
    if (warned.has(role)) continue;
    warned.add(role);
    console.warn(
      `react-x11: unknown role "${role}" on <${node.kind}> — it will read ` +
        `as the element default. Known roles: ${KNOWN_ROLES.join(', ')}.`,
    );
  }
}

// --------------------------------------------------------------------------
// The hook slots, and turning the bridge on
// --------------------------------------------------------------------------

/**
 * Slots the renderer's hot paths poll, all null until the AT-SPI bridge is
 * live — the cost of accessibility being off is one property read per
 * event, same design as trace-registry. atspi.js fills them; nothing else
 * may.
 *
 *  - `rootMounted(windowNode)` / `rootUnmounted(windowNode)` — a toplevel
 *    `<window>` entered or left a container.
 *  - `attached(parent, child)` — a node joined a live tree (also popups).
 *  - `detach(parent, child)` — about to leave; called while still wired.
 *  - `propsChanged(node)` — after applyProps landed new props, and through
 *    `Node.notifyA11ySceneChanged()` when what an element drew moved
 *    without any prop doing so. Both mean the same thing to a listener:
 *    re-read this node's accessible facts and announce the difference.
 *  - `textContent(node)` — a text chunk's string changed.
 *  - `textState(node)` — a text control's value/caret/selection may have
 *    moved (funnelled through `_repaint`, which every edit path calls, and
 *    through `Node.notifyA11yTextChanged()` for a registered element).
 *  - `focus(previous, next)` — the owning manager moved focus.
 *  - `windowFocus(windowNode, focused)` — the WM moved input focus.
 *  - `commit()` — a React commit finished (resetAfterCommit).
 *  - `announce(text, opts)` — announce() below, when a bridge is live.
 */
export const hooks = {
  rootMounted: null,
  rootUnmounted: null,
  attached: null,
  detach: null,
  propsChanged: null,
  textContent: null,
  textState: null,
  focus: null,
  windowFocus: null,
  commit: null,
  announce: null,
};

let startPromise = null;

/**
 * Whether to climb toward the accessibility bus at all, resolved from two
 * environment variables:
 *
 *  - `REACT_X11_A11Y` — this renderer's own switch. `0` is off; any other
 *    value is an explicit "on" that also makes the climb loud, and wins
 *    over `NO_AT_BRIDGE`.
 *  - `NO_AT_BRIDGE` — the ecosystem's switch, honoured because it already
 *    means "do not register with AT-SPI" to every toolkit (at-spi2-atk
 *    checks it, GTK's own test suite sets it). react-x11's test harness
 *    sets it too, so a test run on a desktop does not parade phantom
 *    applications through the live screen reader.
 *
 * An explicit `AT_SPI_BUS_ADDRESS` is intent — whoever set it wants a
 * bridge on that bus — so it overrides `NO_AT_BRIDGE`; the hermetic bridge
 * tests are exactly this case.
 */
function a11yEnabled() {
  const own = process.env.REACT_X11_A11Y;
  if (own === '0') return false;
  if (own) return true;
  if (process.env.AT_SPI_BUS_ADDRESS) return true;
  const noBridge = process.env.NO_AT_BRIDGE;
  if (noBridge && noBridge !== '0') return false;
  return true;
}

/**
 * Kick off the AT-SPI bridge, once per process. Called from `createRoot()`
 * and deliberately not awaited there: the ladder this climbs — transport
 * installed? session bus? accessibility bus? — ends in "no" on most
 * machines this renderer targets (ssh, CI, macOS/Windows X servers, bare
 * startx), and every "no" is a normal, silent outcome that must cost the
 * app nothing. See docs/accessibility.md for the ladder.
 *
 * `REACT_X11_A11Y=0` (or the ecosystem's `NO_AT_BRIDGE=1`) skips even the
 * import; `REACT_X11_A11Y=1` makes the climb *loud* — each rung says why
 * it stopped — which is the debugging story for "why does Orca not see my
 * app".
 */
export function startA11y() {
  if (startPromise) return startPromise;
  if (!a11yEnabled()) {
    startPromise = Promise.resolve(null);
    return startPromise;
  }
  startPromise = import('./atspi.js')
    .then((atspi) => atspi.start())
    .catch((err) => {
      if (process.env.REACT_X11_A11Y) {
        console.warn('react-x11: accessibility bridge failed to start:', err);
      }
      return null;
    });
  return startPromise;
}

/**
 * Say something through the screen reader without moving focus — the
 * explicit counterpart of an ARIA live region ("saved", "3 results",
 * "connection lost"). Returns true when a bridge was there to carry it;
 * false means nobody is listening (no accessibility bus, or it has not
 * connected yet) and the app may want a visible fallback.
 *
 *   announce('Form saved');
 *   announce('Connection lost', { assertive: true });
 */
export function announce(text, opts) {
  return hooks.announce?.(String(text), opts) ?? false;
}

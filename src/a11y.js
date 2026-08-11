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
  markdown: ATSPI_ROLE.DOCUMENT_TEXT,
  html: ATSPI_ROLE.DOCUMENT_WEB,
  tex: ATSPI_ROLE.MATH,
  svg: ATSPI_ROLE.IMAGE,
  glarea: ATSPI_ROLE.CANVAS,
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

/** The web role name in force on a node: the `role` prop, else the kind's
 * default name (only the kinds with real semantics have one). */
export function roleNameOf(node) {
  const role = node.props?.role;
  if (typeof role === 'string' && role !== '') return role;
  if (scrolls(node)) return 'scrollable';
  return KIND_ROLE_NAMES[node.kind] ?? null;
}

/** The AT-SPI role number for a node. An unknown `role` string falls back
 * to the kind default rather than to nothing — a typo should not turn a
 * button into a filler silently, but it must not crash either; the DEV
 * check below is what reports it. */
export function a11yRole(node) {
  const role = node.props?.role;
  if (typeof role === 'string') {
    const mapped = ROLE_TO_ATSPI.get(role);
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
 * gone, erased nodes replaced by their children. `<glarea>` children are 3D
 * scene nodes with their own vocabulary and no rectangles — a glarea is a
 * leaf up here.
 */
export function a11yChildren(node) {
  if (node.kind === 'glarea') return [];
  const out = [];
  for (const child of node.children ?? []) {
    if (child.destroyed || a11yPruned(child)) continue;
    if (a11yErased(child)) out.push(...a11yChildren(child));
    else out.push(child);
  }
  return out;
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
    // do not read a nested widget's editable content as its parent's label
    if (n.kind === 'textinput' || n.kind === 'textarea') return;
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
  return (
    node.props.focusable ??
    (node.props.tabIndex != null ? true : (node.focusableByDefault ?? false))
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
  const manager = node._focusManager?.();
  if (manager?.focused === node) bit(states, S.FOCUSED);

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
  if (node.kind === 'textinput' || node.kind === 'textarea') {
    bit(states, node.kind === 'textarea' ? S.MULTI_LINE : S.SINGLE_LINE);
    if (!props.disabled && !readOnly) bit(states, S.EDITABLE);
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
  const role = roleNameOf(node);
  return role !== null && ACTIVATABLE_ROLES.has(role);
}

// --------------------------------------------------------------------------
// Text state — shared by the AT-SPI bridge's Text interface and the test
// spy, because both answer the same question: what would an assistive
// technology read out of this control right now?
// --------------------------------------------------------------------------

/** Kinds whose value is editable text with a caret. */
export const isTextControl = (node) =>
  node.kind === 'textinput' || node.kind === 'textarea';

/** Kinds that expose the AT-SPI Text interface at all — the editable
 * controls plus `<text>` labels, which are readable but caret-less. */
export const hasTextInterface = (node) =>
  isTextControl(node) || node.kind === 'text';

/**
 * The code points and caret/selection of anything with a Text interface —
 * offsets in AT-SPI are code points, which is also exactly what
 * TextInputNode's `_chars()`/`_caret` already count.
 */
export function textStateOf(node) {
  if (isTextControl(node)) {
    return {
      chars: node._chars(),
      caret: node._caret ?? 0,
      selection: node._selection?.() ?? [0, 0],
    };
  }
  const spans = node.collectSpans?.([]) ?? [];
  const chars = Array.from(spans.map((s) => s.text).join(''));
  return { chars, caret: 0, selection: [0, 0] };
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
  const role = node.props?.role;
  if (role == null) return;
  if (typeof role !== 'string' || ROLE_TO_ATSPI.has(role)) return;
  if (role === 'none' || role === 'presentation') return;
  if (warned.has(role)) return;
  warned.add(role);
  console.warn(
    `react-x11: unknown role "${role}" on <${node.kind}> — it will read as ` +
      `the element default. Known roles: ${KNOWN_ROLES.join(', ')}.`,
  );
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
 *  - `propsChanged(node)` — after applyProps landed new props.
 *  - `textContent(node)` — a text chunk's string changed.
 *  - `textState(node)` — a text control's value/caret/selection may have
 *    moved (funnelled through `_repaint`, which every edit path calls).
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

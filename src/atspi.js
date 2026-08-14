// The AT-SPI2 bridge: the accessible tree, live on the accessibility bus.
//
// Linux accessibility does not go over the X protocol at all. An application
// exposes a tree of objects on a separate D-Bus instance — the *accessibility
// bus* — implementing the org.a11y.atspi.* interfaces (at-spi2-core's xml/ is
// the wire spec), and registers itself with the AT-SPI registry daemon.
// Assistive technology (Orca, Accerciser, magnifiers) walks that tree and
// listens for its signals. Toolkit-less applications are expected to drive
// this themselves rather than inherit it from GTK — which is exactly what
// this file is.
//
// ## No mirror
//
// There is no shadow tree to keep in sync. Every method call is answered
// from the live node tree through the model in a11y.js (`a11yChildren`,
// `a11yStates`, `node.abs`, …), so the answer cannot be stale. The bridge
// keeps only three things per exported node: its object path, which
// interfaces it was exported with, and the last name/states/text it *told*
// the bus about — the snapshot that turns "something changed" from the
// renderer's hooks into the precise AT-SPI event diff.
//
// ## The ladder (docs/accessibility.md)
//
// start() climbs: transport installed → session bus → org.a11y.Bus knows an
// address → connect → Embed with the registry. Every rung ends in a silent
// "off" on machines with no accessibility stack — ssh, CI, containers,
// macOS/Windows X servers — and the renderer's hook slots stay null, so the
// app pays one property read per event for a bridge that is not there.
// AT_SPI_BUS_ADDRESS overrides the discovery, which is also the test seam.
//
// Like the rest of the D-Bus layer, a dead accessibility bus is not
// resurrected: the slots are cleared and the app simply stops being
// accessible until restarted, the same contract bus.js documents.

import { addressFor, loadTransport } from './bus.js';
import {
  hooks,
  ATSPI_ROLE,
  ATSPI_STATE,
  ATSPI_STATE_NICK,
  ATSPI_ROLE_NICK,
  atspiRoleOf,
  a11yErased,
  a11yPruned,
  a11yChildren,
  a11yParent,
  a11yIndexIn,
  sceneChildrenOf,
  knownSceneItems,
  a11yName,
  a11yDescription,
  a11yStates,
  a11yValue,
  a11yAttributes,
  a11yActivatable,
  isTextControl,
  isNativeTextControl,
  acceptsTextEdits,
  hasTextInterface,
  textStateOf,
  inPreedit,
  diffChars,
} from './a11y.js';
import { onApp } from './trace-registry.js';
import { discrete } from './events.js';
import { callHandler } from './errors.js';

const ROOT_PATH = '/org/a11y/atspi/accessible/root';
const NODE_PATH = '/org/a11y/atspi/accessible/';
const NULL_PATH = '/org/a11y/atspi/null';
const CACHE_PATH = '/org/a11y/atspi/cache';
const REGISTRY_NAME = 'org.a11y.atspi.Registry';

const IFACE = {
  ACCESSIBLE: 'org.a11y.atspi.Accessible',
  APPLICATION: 'org.a11y.atspi.Application',
  COMPONENT: 'org.a11y.atspi.Component',
  ACTION: 'org.a11y.atspi.Action',
  VALUE: 'org.a11y.atspi.Value',
  TEXT: 'org.a11y.atspi.Text',
  EDITABLE_TEXT: 'org.a11y.atspi.EditableText',
  SOCKET: 'org.a11y.atspi.Socket',
  CACHE: 'org.a11y.atspi.Cache',
  EVENT_OBJECT: 'org.a11y.atspi.Event.Object',
  EVENT_WINDOW: 'org.a11y.atspi.Event.Window',
  EVENT_FOCUS: 'org.a11y.atspi.Event.Focus',
};

// AtspiCoordType / AtspiComponentLayer, from the same enums as a11y.js's
// tables.
const COORD_SCREEN = 0;
const COORD_WINDOW = 1;
const COORD_PARENT = 2;
const LAYER_WIDGET = 3;
const LAYER_POPUP = 5;
const LAYER_WINDOW = 7;

/** The version at-spi2-core reports for current releases; ATs use it only
 * to gate features far newer than anything here. */
const ATSPI_VERSION = '2.1';

const EVENT_SIGNATURE = 'siiva{sv}';
const CACHE_ITEM_SIGNATURE = '((so)(so)(so)iiassusau)';

// --------------------------------------------------------------------------
// Interface descriptors (dbus-native shape). Signatures are copied from
// at-spi2-core's xml/, which is the authoritative wire spec.
// --------------------------------------------------------------------------

const readOnly = (type) => ({ type, access: 'read' });

const ACCESSIBLE_DESC = {
  name: IFACE.ACCESSIBLE,
  methods: {
    GetChildAtIndex: ['i', '(so)'],
    GetChildren: ['', 'a(so)'],
    GetIndexInParent: ['', 'i'],
    GetRelationSet: ['', 'a(ua(so))'],
    GetRole: ['', 'u'],
    GetRoleName: ['', 's'],
    GetLocalizedRoleName: ['', 's'],
    GetState: ['', 'au'],
    GetAttributes: ['', 'a{ss}'],
    GetApplication: ['', '(so)'],
    GetInterfaces: ['', 'as'],
  },
  properties: {
    Name: readOnly('s'),
    Description: readOnly('s'),
    Parent: readOnly('(so)'),
    ChildCount: readOnly('i'),
    Locale: readOnly('s'),
    AccessibleId: readOnly('s'),
  },
};

const APPLICATION_DESC = {
  name: IFACE.APPLICATION,
  methods: {
    GetLocale: ['u', 's'],
    GetApplicationBusAddress: ['', 's'],
  },
  properties: {
    ToolkitName: readOnly('s'),
    Version: readOnly('s'),
    AtspiVersion: readOnly('s'),
    Id: 'i',
  },
};

const SOCKET_DESC = {
  name: IFACE.SOCKET,
  methods: {
    Embedded: ['s', ''],
    Unembed: ['(so)', ''],
  },
};

const COMPONENT_DESC = {
  name: IFACE.COMPONENT,
  methods: {
    Contains: ['iiu', 'b'],
    GetAccessibleAtPoint: ['iiu', '(so)'],
    GetExtents: ['u', '(iiii)'],
    GetPosition: ['u', 'ii'],
    GetSize: ['', 'ii'],
    GetLayer: ['', 'u'],
    GrabFocus: ['', 'b'],
    GetAlpha: ['', 'd'],
    ScrollTo: ['u', 'b'],
    ScrollToPoint: ['uii', 'b'],
  },
};

const ACTION_DESC = {
  name: IFACE.ACTION,
  methods: {
    GetDescription: ['i', 's'],
    GetName: ['i', 's'],
    GetLocalizedName: ['i', 's'],
    GetKeyBinding: ['i', 's'],
    GetActions: ['', 'a(sss)'],
    DoAction: ['i', 'b'],
  },
  properties: { NActions: readOnly('i') },
};

const VALUE_DESC = {
  name: IFACE.VALUE,
  properties: {
    MinimumValue: readOnly('d'),
    MaximumValue: readOnly('d'),
    MinimumIncrement: readOnly('d'),
    CurrentValue: 'd',
    Text: readOnly('s'),
  },
};

const TEXT_DESC = {
  name: IFACE.TEXT,
  methods: {
    GetText: ['ii', 's'],
    GetStringAtOffset: ['iu', 'sii'],
    GetTextAtOffset: ['iu', 'sii'],
    GetTextBeforeOffset: ['iu', 'sii'],
    GetTextAfterOffset: ['iu', 'sii'],
    GetCharacterAtOffset: ['i', 'i'],
    SetCaretOffset: ['i', 'b'],
    GetAttributes: ['i', 'a{ss}ii'],
    GetDefaultAttributes: ['', 'a{ss}'],
    GetAttributeValue: ['is', 's'],
    GetCharacterExtents: ['iu', 'iiii'],
    GetRangeExtents: ['iiu', 'iiii'],
    GetOffsetAtPoint: ['iiu', 'i'],
    GetNSelections: ['', 'i'],
    GetSelection: ['i', 'ii'],
    AddSelection: ['ii', 'b'],
    RemoveSelection: ['i', 'b'],
    SetSelection: ['iii', 'b'],
  },
  properties: {
    CharacterCount: readOnly('i'),
    CaretOffset: readOnly('i'),
  },
};

const EDITABLE_TEXT_DESC = {
  name: IFACE.EDITABLE_TEXT,
  methods: {
    SetTextContents: ['s', 'b'],
    InsertText: ['isi', 'b'],
    CopyText: ['ii', ''],
    CutText: ['ii', 'b'],
    DeleteText: ['ii', 'b'],
    PasteText: ['i', 'b'],
  },
};

const CACHE_DESC = {
  name: IFACE.CACHE,
  methods: {
    GetItems: ['', `a${CACHE_ITEM_SIGNATURE}`],
  },
  signals: {
    AddAccessible: [CACHE_ITEM_SIGNATURE, 'nodeAdded'],
    RemoveAccessible: ['(so)', 'nodeRemoved'],
  },
};

// --------------------------------------------------------------------------
// Helpers over the node tree. `textStateOf`/`diffChars` live in a11y.js —
// they answer "what would an AT read here", which the test spy asks too.
// --------------------------------------------------------------------------

function clampOffset(offset, length) {
  return Math.max(0, Math.min(offset | 0, length));
}

/**
 * The attribute run around an offset, `[attributes, start, end)`.
 *
 * A composition is drawn underlined and `underline` is the only registered
 * AT-SPI attribute that says so, so that is what the preedit run carries.
 * `composition` beside it is this renderer's own: AT-SPI registers nothing
 * for a preedit, and an attribute a reader does not know is one it ignores,
 * which is a better failure than a run claiming to be nothing special.
 * Everything outside the composition is one unattributed run, bounded by
 * the composition's edges so an AT walking runs finds them.
 */
function attributeRun(state, offset) {
  const total = state.chars.length;
  const at = clampOffset(offset, total);
  const pre = state.preedit;
  if (!pre) return [[], 0, total];
  const start = pre.offset;
  const end = pre.offset + pre.length;
  if (at >= start && at < end) {
    return [
      [
        ['underline', 'single'],
        ['composition', 'true'],
      ],
      start,
      end,
    ];
  }
  return at < start ? [[], 0, start] : [[], end, total];
}

/**
 * An offset an AT handed back, in the node's **value** space — what it was
 * told is the displayed string, composition included. An offset inside the
 * composition answers where the composition starts: a preedit is one thing,
 * not a run of characters to put a caret between or edit around.
 */
function valueOffset(node, offset) {
  const { chars } = textStateOf(node);
  const at = clampOffset(offset, chars.length);
  return node._valueIndex ? node._valueIndex(at) : at;
}

const isWordChar = (ch) => /\S/.test(ch);

/** [start, end) of the word containing (or after) `offset`. */
function wordRange(chars, offset) {
  const n = chars.length;
  let i = clampOffset(offset, n);
  if (i >= n) i = n - 1;
  if (i < 0) return [0, 0];
  if (!isWordChar(chars[i])) {
    // between words: the range is the whitespace run, as GTK reports it
    let s = i;
    while (s > 0 && !isWordChar(chars[s - 1])) s--;
    let e = i;
    while (e < n && !isWordChar(chars[e])) e++;
    return [s, e];
  }
  let s = i;
  while (s > 0 && isWordChar(chars[s - 1])) s--;
  let e = i;
  while (e < n && isWordChar(chars[e])) e++;
  return [s, e];
}

/** Hard-line ranges [start, end) with the newline included in its line —
 * what GtkTextView reports for LINE_START. Soft wraps are not lines here;
 * see docs/accessibility.md. */
function lineRanges(chars) {
  const ranges = [];
  let start = 0;
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === '\n') {
      ranges.push([start, i + 1]);
      start = i + 1;
    }
  }
  ranges.push([start, chars.length]);
  return ranges;
}

function lineRangeAt(chars, offset) {
  const ranges = lineRanges(chars);
  for (const range of ranges) {
    if (offset < range[1]) return range;
  }
  return ranges[ranges.length - 1];
}

/**
 * A granular range around `offset`. `granularity` follows AtspiTextGranularity
 * (0 char, 1 word, 2 sentence, 3 line, 4 paragraph); the legacy
 * AtspiTextBoundaryType values GetTextAtOffset carries are translated by the
 * caller. Sentences and paragraphs answer as lines — hard lines are the only
 * paragraph structure a `<textarea>` has.
 */
function granularRange(chars, offset, granularity) {
  const n = chars.length;
  const at = clampOffset(offset, n);
  switch (granularity) {
    case 0:
      return at >= n ? [n, n] : [at, at + 1];
    case 1:
      return wordRange(chars, at);
    default:
      return lineRangeAt(chars, at);
  }
}

/** Legacy AtspiTextBoundaryType → granularity (start/end variants collapse:
 * the range is the same, only legacy iteration order differed). */
function boundaryToGranularity(type) {
  if (type === 0) return 0; // CHAR
  if (type === 1 || type === 2) return 1; // WORD_START / WORD_END
  return 3; // SENTENCE_* and LINE_* answer as lines
}

/** The best guess at what the desktop calls this program. */
function programName() {
  const scriptPath = process.argv?.[1];
  if (typeof scriptPath === 'string' && scriptPath !== '') {
    const base = scriptPath.split(/[\\/]/).pop();
    if (base) return base.replace(/\.[cm]?jsx?$/, '');
  }
  return process.title || 'node';
}

function localeString() {
  return (
    process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || 'C'
  );
}

// --------------------------------------------------------------------------
// Per-interface implementation prototypes. One tiny `{ b, n }` object per
// (node, interface) is created at export time; everything else lives here.
// dbus-native reads properties straight off the object (prototype getters
// included) and calls methods with the message appended, which none of
// these need — the node is bound at export.
// --------------------------------------------------------------------------

const AccessibleImpl = {
  get Name() {
    return a11yName(this.n);
  },
  get Description() {
    return a11yDescription(this.n);
  },
  get Parent() {
    return this.b.parentRef(this.n);
  },
  get ChildCount() {
    return a11yChildren(this.n).length;
  },
  get Locale() {
    return localeString();
  },
  get AccessibleId() {
    return '';
  },
  GetChildAtIndex(index) {
    const child = a11yChildren(this.n)[index];
    return child ? this.b.refFor(child) : this.b.nullRef();
  },
  GetChildren() {
    return a11yChildren(this.n).map((child) => this.b.refFor(child));
  },
  GetIndexInParent() {
    const parent = a11yParent(this.n);
    if (!parent) return this.b.toplevels.indexOf(this.n);
    return a11yIndexIn(parent, this.n);
  },
  GetRelationSet() {
    return [];
  },
  GetRole() {
    return atspiRoleOf(this.n);
  },
  // The AT-SPI role name, not the ARIA one the app wrote — see
  // ATSPI_ROLE_NICK. The ARIA role is reported through `xml-roles` in
  // GetAttributes, as the browsers do.
  GetRoleName() {
    return ATSPI_ROLE_NICK[atspiRoleOf(this.n)] ?? 'unknown';
  },
  GetLocalizedRoleName() {
    // No localisation here: answering the untranslated name is what a
    // toolkit with no message catalogue should do, and libatspi falls back
    // to its own translations anyway.
    return ATSPI_ROLE_NICK[atspiRoleOf(this.n)] ?? 'unknown';
  },
  GetState() {
    return a11yStates(this.n);
  },
  GetAttributes() {
    return a11yAttributes(this.n);
  },
  GetApplication() {
    return this.b.rootRef();
  },
  GetInterfaces() {
    return this.b.interfacesOf(this.n);
  },
};

/** The innermost scene item covering a window-coordinate point, or the node
 * itself. Last one wins: items are declared in the order they were drawn,
 * so the one on top is the one the user sees. */
function deepestItemAt(node, x, y) {
  let found = node;
  for (const item of sceneChildrenOf(node)) {
    if (item.destroyed || a11yPruned(item)) continue;
    const r = item.abs;
    if (x < r.x || y < r.y || x >= r.x + r.width || y >= r.y + r.height) {
      continue;
    }
    found = deepestItemAt(item, x, y);
  }
  return found;
}

const ComponentImpl = {
  Contains(x, y) {
    const r = this.b.extentsOf(this.n, COORD_SCREEN);
    return x >= r[0] && y >= r[1] && x < r[0] + r[2] && y < r[1] + r[3];
  },
  GetAccessibleAtPoint(x, y, coordType) {
    const node = this.n;
    const win = node.isWindow ? node : node.root;
    if (!win) return this.b.nullRef();
    let wx = x;
    let wy = y;
    if (coordType !== COORD_WINDOW) {
      const origin = this.b.screenOriginOf(win);
      wx -= origin.x;
      wy -= origin.y;
    }
    let hit = win.hitTest?.(wx, wy) ?? null;
    while (hit && (a11yErased(hit) || a11yPruned(hit))) hit = hit.parent;
    // Hit testing stops at the retained tree, so an element that draws a
    // scene answers with itself; the item under the point is what a
    // magnifier following the pointer is actually over.
    if (hit) hit = deepestItemAt(hit, wx, wy);
    return hit ? this.b.refFor(hit) : this.b.nullRef();
  },
  GetExtents(coordType) {
    return this.b.extentsOf(this.n, coordType);
  },
  GetPosition(coordType) {
    const r = this.b.extentsOf(this.n, coordType);
    return [r[0], r[1]];
  },
  GetSize() {
    const r = this.b.extentsOf(this.n, COORD_WINDOW);
    return [r[2], r[3]];
  },
  GetLayer() {
    if (this.n.isPopup) return LAYER_POPUP;
    if (this.n.isWindow) return LAYER_WINDOW;
    return LAYER_WIDGET;
  },
  GrabFocus() {
    return this.b.grabFocus(this.n);
  },
  GetAlpha() {
    return 1.0;
  },
  ScrollTo() {
    if (this.b.sceneAction(this.n, 'scroll')) return true;
    // A scene item has no layout of its own, so the most core can reveal is
    // the element that drew it — an element that can do better says so
    // through the action above.
    const target = this.n.a11yOwner ?? this.n;
    // `isScroller()`, not "has the method": every `<box>` carries
    // `scrollIntoView` now, and one that is not a scroll container would end
    // the walk having revealed nothing
    for (let p = target.parent; p; p = p.parent) {
      if (p.isScroller?.()) {
        p.scrollIntoView(target);
        return true;
      }
    }
    return false;
  },
  ScrollToPoint() {
    return false;
  },
};

const ACTIVATE = 'activate';

const ActionImpl = {
  get NActions() {
    return 1;
  },
  GetName(index) {
    return index === 0 ? ACTIVATE : '';
  },
  GetLocalizedName(index) {
    return index === 0 ? ACTIVATE : '';
  },
  GetDescription() {
    return '';
  },
  GetKeyBinding() {
    return '';
  },
  GetActions() {
    return [[ACTIVATE, '', '']];
  },
  DoAction(index) {
    if (index !== 0) return false;
    return this.b.activate(this.n);
  },
};

const ValueImpl = {
  get MinimumValue() {
    return a11yValue(this.n)?.min ?? 0;
  },
  get MaximumValue() {
    return a11yValue(this.n)?.max ?? 0;
  },
  get MinimumIncrement() {
    return 0;
  },
  get CurrentValue() {
    return a11yValue(this.n)?.now ?? 0;
  },
  /** An AT writing the value — Orca adjusting a slider. Routed to the
   * component through `onAccessibilityAction`, the seam a widget wires its
   * own state setter into. */
  set CurrentValue(next) {
    const node = this.n;
    const handler = node.props?.onAccessibilityAction;
    if (typeof handler !== 'function') return;
    callHandler(node, 'onAccessibilityAction', handler, {
      action: 'setValue',
      value: Number(next),
    });
  },
  get Text() {
    return a11yValue(this.n)?.text ?? '';
  },
};

const TextImpl = {
  get CharacterCount() {
    return textStateOf(this.n).chars.length;
  },
  get CaretOffset() {
    return textStateOf(this.n).caret;
  },
  GetText(start, end) {
    const { chars } = textStateOf(this.n);
    const s = clampOffset(start, chars.length);
    const e = end < 0 ? chars.length : clampOffset(end, chars.length);
    return chars.slice(s, e).join('');
  },
  GetStringAtOffset(offset, granularity) {
    const { chars } = textStateOf(this.n);
    const [s, e] = granularRange(chars, offset, granularity);
    return [chars.slice(s, e).join(''), s, e];
  },
  GetTextAtOffset(offset, type) {
    return TextImpl.GetStringAtOffset.call(
      this,
      offset,
      boundaryToGranularity(type),
    );
  },
  GetTextBeforeOffset(offset, type) {
    const { chars } = textStateOf(this.n);
    const granularity = boundaryToGranularity(type);
    const [s] = granularRange(chars, offset, granularity);
    if (s <= 0) return ['', 0, 0];
    const [ps, pe] = granularRange(chars, s - 1, granularity);
    return [chars.slice(ps, pe).join(''), ps, pe];
  },
  GetTextAfterOffset(offset, type) {
    const { chars } = textStateOf(this.n);
    const granularity = boundaryToGranularity(type);
    const [, e] = granularRange(chars, offset, granularity);
    if (e >= chars.length) return ['', chars.length, chars.length];
    const [ns, ne] = granularRange(chars, e, granularity);
    return [chars.slice(ns, ne).join(''), ns, ne];
  },
  GetCharacterAtOffset(offset) {
    const { chars } = textStateOf(this.n);
    if (offset < 0 || offset >= chars.length) return 0;
    return chars[offset].codePointAt(0);
  },
  SetCaretOffset(offset) {
    return this.b.setCaret(this.n, offset);
  },
  GetAttributes(offset) {
    return attributeRun(textStateOf(this.n), offset);
  },
  GetDefaultAttributes() {
    return [];
  },
  GetAttributeValue(offset, name) {
    const [attrs] = attributeRun(textStateOf(this.n), offset);
    for (const [key, value] of attrs) {
      if (key === name) return value;
    }
    return '';
  },
  GetCharacterExtents(offset, coordType) {
    return this.b.characterExtents(this.n, offset, coordType);
  },
  GetRangeExtents(start, end, coordType) {
    const a = this.b.characterExtents(this.n, start, coordType);
    const z = this.b.characterExtents(
      this.n,
      Math.max(start, end - 1),
      coordType,
    );
    const x = Math.min(a[0], z[0]);
    const y = Math.min(a[1], z[1]);
    return [
      x,
      y,
      Math.max(a[0] + a[2], z[0] + z[2]) - x,
      Math.max(a[1] + a[3], z[1] + z[3]) - y,
    ];
  },
  GetOffsetAtPoint(x, y, coordType) {
    return this.b.offsetAtPoint(this.n, x, y, coordType);
  },
  GetNSelections() {
    const [s, e] = textStateOf(this.n).selection;
    return s !== e ? 1 : 0;
  },
  GetSelection(index) {
    if (index !== 0) return [0, 0];
    return textStateOf(this.n).selection;
  },
  AddSelection(start, end) {
    return this.b.setTextSelection(this.n, start, end);
  },
  SetSelection(index, start, end) {
    if (index !== 0) return false;
    return this.b.setTextSelection(this.n, start, end);
  },
  RemoveSelection(index) {
    if (index !== 0) return false;
    return this.b.setCaret(this.n, textStateOf(this.n).caret);
  },
};

/**
 * Every write is one replacement — `editText(node, start, end, text)` —
 * because that is the one primitive both sides can implement: the
 * built-ins have `_commit`, and a registered element implements
 * `a11yReplaceText`, which it needs anyway for its own editing.
 */
const EditableTextImpl = {
  SetTextContents(newContents) {
    const { chars } = textStateOf(this.n);
    return this.b.editText(this.n, 0, chars.length, newContents);
  },
  InsertText(position, text, length) {
    const insert = Array.from(String(text))
      .slice(0, length < 0 ? undefined : length)
      .join('');
    return this.b.editText(this.n, position, position, insert);
  },
  DeleteText(start, end) {
    return this.b.editText(this.n, start, end, '');
  },
  CopyText(start, end) {
    this.b.copyTextRange(this.n, start, end);
    return null;
  },
  CutText(start, end) {
    this.b.copyTextRange(this.n, start, end);
    return EditableTextImpl.DeleteText.call(this, start, end);
  },
  PasteText(position) {
    const node = this.n;
    if (!this.b.editable(node)) return false;
    // the clipboard round trip is the built-ins' own: an element with a
    // seam of its own is handed the text, not asked to fetch it
    if (typeof node._pasteFrom !== 'function') return false;
    node._moveCaret?.(valueOffset(node, position), false);
    node._pasteFrom('CLIPBOARD');
    return true;
  },
};

// --------------------------------------------------------------------------
// The bridge
// --------------------------------------------------------------------------

class AtspiBridge {
  constructor(bus, toolkitVersion) {
    this.bus = bus;
    this.toolkitVersion = toolkitVersion;
    this.dead = false;
    /** @type {Map<object, {id: number, ifaces: string[], snapshot: object}>} */
    this.exported = new Map();
    this.nextId = 1;
    /** Toplevel `<window>` nodes across every root, in mount order — the
     * application's accessible children. */
    this.toplevels = [];
    this.desktop = [REGISTRY_NAME, ROOT_PATH];
    this.appId = -1;
    this._unsubscribes = [];
    // batched renderer notifications, flushed per commit / microtask
    this._pending = {
      attach: new Set(),
      remove: [],
      props: new Set(),
      text: new Set(),
      focus: [],
      window: [],
    };
    this._flushScheduled = false;
  }

  // ---- refs and export -------------------------------------------------

  nullRef() {
    return [this.bus.name, NULL_PATH];
  }

  rootRef() {
    return [this.bus.name, ROOT_PATH];
  }

  pathOf(node) {
    const entry = this.exported.get(node);
    return entry ? NODE_PATH + entry.id : NULL_PATH;
  }

  /** The ref for a node, exporting it on the way if the bus has never seen
   * it. Everything that hands a node to the bus goes through here, so an AT
   * can call back on any ref it was ever given. */
  refFor(node) {
    this.ensureExported(node);
    return [this.bus.name, this.pathOf(node)];
  }

  parentRef(node) {
    const parent = a11yParent(node);
    return parent ? this.refFor(parent) : this.rootRef();
  }

  interfacesOf(node) {
    return this.exported.get(node)?.ifaces ?? this._ifaceSetFor(node);
  }

  _ifaceSetFor(node) {
    const ifaces = [IFACE.ACCESSIBLE, IFACE.COMPONENT];
    if (a11yActivatable(node)) ifaces.push(IFACE.ACTION);
    if (a11yValue(node) !== null) ifaces.push(IFACE.VALUE);
    if (hasTextInterface(node)) ifaces.push(IFACE.TEXT);
    // EditableText only where an edit would actually land: a registered
    // element that reports editable text but implements no write seam is
    // readable and reports its own edits, and an interface whose every
    // method answered false would be a lie an AT cannot see through
    if (isTextControl(node) && acceptsTextEdits(node)) {
      ifaces.push(IFACE.EDITABLE_TEXT);
    }
    return ifaces;
  }

  _implFor(proto, node) {
    return { __proto__: proto, b: this, n: node };
  }

  _descriptorFor(name) {
    switch (name) {
      case IFACE.ACCESSIBLE:
        return [ACCESSIBLE_DESC, AccessibleImpl];
      case IFACE.COMPONENT:
        return [COMPONENT_DESC, ComponentImpl];
      case IFACE.ACTION:
        return [ACTION_DESC, ActionImpl];
      case IFACE.VALUE:
        return [VALUE_DESC, ValueImpl];
      case IFACE.TEXT:
        return [TEXT_DESC, TextImpl];
      case IFACE.EDITABLE_TEXT:
        return [EDITABLE_TEXT_DESC, EditableTextImpl];
      default:
        return null;
    }
  }

  ensureExported(node) {
    if (this.dead || this.exported.has(node)) return;
    const id = this.nextId++;
    const ifaces = this._ifaceSetFor(node);
    const path = NODE_PATH + id;
    const entry = { id, ifaces, snapshot: null };
    // registered before the interfaces export, so a getter that recurses
    // through refFor (Parent, GetChildren) sees the entry and terminates
    this.exported.set(node, entry);
    for (const name of ifaces) {
      const [desc, proto] = this._descriptorFor(name);
      this.bus.exportInterface(this._implFor(proto, node), path, desc);
    }
    entry.snapshot = this._snapshot(node);
  }

  _unexport(node) {
    const entry = this.exported.get(node);
    if (!entry) return;
    this.exported.delete(node);
    const path = NODE_PATH + entry.id;
    this.emitCacheRemove([this.bus.name, path]);
    this.bus.unexportInterface(path);
  }

  _snapshot(node) {
    const snapshot = {
      name: a11yName(node),
      description: a11yDescription(node),
      states: a11yStates(node),
      value: a11yValue(node)?.now ?? null,
      ifaces: this.exported.get(node)?.ifaces ?? [],
      text: null,
      // the drawn children, which arrive and leave without a mount to
      // notice them; the shared empty list for everything that draws none
      scene: sceneChildrenOf(node),
    };
    if (hasTextInterface(node)) {
      const { chars, caret, selection, preedit } = textStateOf(node);
      snapshot.text = { chars, caret, selection, preedit };
    }
    return snapshot;
  }

  // ---- geometry --------------------------------------------------------

  screenOriginOf(win) {
    const wnd = win?.window;
    if (!wnd) return { x: 0, y: 0 };
    return wnd._screenOrigin ?? { x: wnd.x ?? 0, y: wnd.y ?? 0 };
  }

  /** [x, y, width, height] in the asked-for coordinate system. A window is
   * its whole surface; a drawn node is its layout rect. */
  extentsOf(node, coordType) {
    let rect;
    const win = node.isWindow ? node : node.root;
    if (node.isWindow) {
      const wnd = node.window;
      rect = { x: 0, y: 0, width: wnd?.width ?? 0, height: wnd?.height ?? 0 };
    } else {
      rect = node.abs ?? { x: 0, y: 0, width: 0, height: 0 };
    }
    let { x, y } = rect;
    if (coordType === COORD_SCREEN) {
      const origin = this.screenOriginOf(win);
      x += origin.x;
      y += origin.y;
    } else if (coordType === COORD_PARENT && !node.isWindow) {
      const parent = a11yParent(node);
      if (parent && !parent.isWindow && parent.abs) {
        x -= parent.abs.x;
        y -= parent.abs.y;
      }
    }
    return [x, y, rect.width, rect.height];
  }

  /** Where the text control paints its characters: the content box, minus
   * the horizontal scroll a long value has been dragged by. */
  _textOrigin(node) {
    const content = node.contentBox?.() ?? node.abs;
    return {
      x: content.x - (node._scrollX ?? 0),
      y: content.y - (node._scrollY ?? 0),
    };
  }

  characterExtents(node, offset, coordType) {
    const layout = node._valueLayout?.();
    if (!layout || typeof layout.caretPosition !== 'function') {
      return this.extentsOf(node, coordType);
    }
    const { chars } = textStateOf(node);
    const at = clampOffset(offset, chars.length);
    const pos = layout.caretPosition(at);
    const next = layout.caretPosition(Math.min(at + 1, chars.length));
    const origin = this._textOrigin(node);
    let x = origin.x + pos.x;
    let y = origin.y + pos.y;
    const width = next.line === pos.line && next.x > pos.x ? next.x - pos.x : 0;
    if (coordType === COORD_SCREEN) {
      const screen = this.screenOriginOf(node.isWindow ? node : node.root);
      x += screen.x;
      y += screen.y;
    }
    return [
      Math.round(x),
      Math.round(y),
      Math.round(width),
      Math.round(pos.height),
    ];
  }

  offsetAtPoint(node, x, y, coordType) {
    const layout = node._valueLayout?.();
    if (!layout || typeof layout.indexAt !== 'function') return -1;
    let wx = x;
    let wy = y;
    if (coordType === COORD_SCREEN) {
      const screen = this.screenOriginOf(node.isWindow ? node : node.root);
      wx -= screen.x;
      wy -= screen.y;
    }
    const origin = this._textOrigin(node);
    return layout.indexAt(wx - origin.x, wy - origin.y);
  }

  // ---- AT-initiated behaviour -----------------------------------------

  /**
   * Offer an action on a scene item to the element that drew it. `true`
   * means the element handled it; anything else — including not
   * implementing the seam — falls through to core's default, which is why
   * an element may answer only the actions it has an answer for.
   */
  sceneAction(node, action) {
    const owner = node.a11yOwner;
    if (!owner || owner.destroyed) return false;
    return owner.a11ySceneAction?.(node.a11yId, action) === true;
  }

  /** GrabFocus. An element owns the keyboard among the items it drew — the
   * window's focus manager only ever holds the element — so the item asks
   * it first and otherwise focuses the element itself, which is where the
   * keys that move between items go anyway. */
  grabFocus(node) {
    if (this.sceneAction(node, 'focus')) return true;
    const target = node.a11yOwner ?? node;
    if (typeof target.focus !== 'function') return false;
    target.focus();
    return true;
  }

  /** DoAction("activate"): a synthetic click through the same dispatch a
   * real press uses — capture, bubble, default actions, discrete-priority
   * commit and paint — so an AT's activation is indistinguishable from the
   * user's. On a scene item it is the click a mouse user would make on
   * what was drawn there: the element hit-tests its own scene already, so
   * the item's rect is the whole address, and an element whose activation
   * is not a click says so through `a11ySceneAction`. */
  activate(node) {
    if (node.a11yOwner) {
      if (this.sceneAction(node, 'activate')) return true;
      if (node.destroyed) return false;
      return this._click(node.a11yOwner, node.abs);
    }
    return this._click(node, node.abs);
  }

  _click(node, rect) {
    const manager = node.root?.events;
    if (!manager || node.destroyed) return false;
    const abs = rect ?? { x: 0, y: 0, width: 0, height: 0 };
    const native = {
      x: Math.round(abs.x + abs.width / 2),
      y: Math.round(abs.y + abs.height / 2),
      buttons: 0,
      keycode: 1,
    };
    // The whole press gesture, not just the click: several controls act on
    // the *press* — `Select` and `MenuBar` drop their menus on mousedown,
    // the way real menus do — and an AT activation has to reach those too.
    // Handlers only; the coordinate-driven defaults (caret placement, drag
    // arming) stay out, because a synthesized centre point is not a place
    // the user chose.
    discrete(() => {
      manager.dispatch('MouseDown', node, native, { button: 1, detail: 1 });
      if (!node.destroyed) {
        manager.dispatch('MouseUp', node, native, { button: 1 });
      }
      if (!node.destroyed) {
        manager.dispatch('Click', node, native, { button: 1, detail: 1 });
      }
    })(native);
    return true;
  }

  editable(node) {
    if (!isTextControl(node) || node.destroyed) return false;
    if (node.props?.disabled || node.props?.['aria-readonly'] === true) {
      return false;
    }
    return acceptsTextEdits(node);
  }

  /**
   * Replace `[start, end)` — in the displayed string, which is what the AT
   * was told — with `text`. Insert, delete and set-the-lot are all this
   * with one end moved, and a registered element answers it whole through
   * `a11yReplaceText` rather than through five methods it would have to
   * keep consistent with each other.
   */
  editText(node, start, end, text) {
    if (!this.editable(node)) return false;
    const { chars: shown } = textStateOf(node);
    const from = clampOffset(Math.min(start, end), shown.length);
    const to = clampOffset(Math.max(start, end), shown.length);
    if (!isNativeTextControl(node)) {
      return node.a11yReplaceText(from, to, String(text)) !== false;
    }
    if (typeof node._commit !== 'function') return false;
    const a = valueOffset(node, from);
    const b = valueOffset(node, to);
    const chars = node._chars();
    const insert = Array.from(String(text));
    chars.splice(a, b - a, ...insert);
    node._commit(chars, a + insert.length);
    return true;
  }

  /** Put the caret at an offset, selecting nothing. Legitimate on a
   * read-only element too — caret browsing through a document is a read,
   * not an edit. */
  setCaret(node, offset) {
    return this.setTextSelection(node, offset, offset);
  }

  setTextSelection(node, start, end) {
    if (node.destroyed) return false;
    if (typeof node.a11ySetSelection === 'function') {
      const { chars } = textStateOf(node);
      return (
        node.a11ySetSelection(
          clampOffset(start, chars.length),
          clampOffset(end, chars.length),
        ) !== false
      );
    }
    if (!isNativeTextControl(node)) return false;
    node._anchor = valueOffset(node, start);
    node._caret = valueOffset(node, end);
    node._repaint?.();
    return true;
  }

  copyTextRange(node, start, end) {
    if (!isNativeTextControl(node) || node.destroyed) return;
    if (typeof node._copySelection !== 'function') return;
    const caret = node._caret;
    const anchor = node._anchor;
    const a = valueOffset(node, start);
    const b = valueOffset(node, end);
    node._anchor = Math.min(a, b);
    node._caret = Math.max(a, b);
    try {
      node._copySelection('CLIPBOARD');
    } finally {
      node._caret = caret;
      node._anchor = anchor;
    }
  }

  // ---- signals ---------------------------------------------------------

  _signal(path, iface, member, detail, detail1, detail2, anyData) {
    if (this.dead) return;
    try {
      this.bus.sendSignal(path, iface, member, EVENT_SIGNATURE, [
        detail,
        detail1 | 0,
        detail2 | 0,
        anyData ?? ['i', 0],
        [],
      ]);
    } catch {
      // a marshalling failure on one event must not take down dispatch;
      // the tree itself stays queryable
    }
  }

  emitObject(node, member, detail = '', d1 = 0, d2 = 0, anyData = null) {
    this._signal(
      this.pathOf(node),
      IFACE.EVENT_OBJECT,
      member,
      detail,
      d1,
      d2,
      anyData,
    );
  }

  emitWindow(node, member) {
    this._signal(this.pathOf(node), IFACE.EVENT_WINDOW, member, '', 0, 0, [
      's',
      a11yName(node),
    ]);
  }

  emitStateChanged(node, stateBit, on) {
    const nick = ATSPI_STATE_NICK[stateBit];
    if (!nick) return;
    this.emitObject(node, 'StateChanged', nick, on ? 1 : 0, 0, ['i', 0]);
  }

  _cacheItemFor(node) {
    return [
      this.refFor(node),
      this.rootRef(),
      this.parentRef(node),
      AccessibleImpl.GetIndexInParent.call({ b: this, n: node }),
      a11yChildren(node).length,
      this.interfacesOf(node),
      a11yName(node),
      atspiRoleOf(node),
      a11yDescription(node),
      a11yStates(node),
    ];
  }

  emitCacheAdd(node) {
    if (this.dead) return;
    try {
      this.bus.sendSignal(
        CACHE_PATH,
        IFACE.CACHE,
        'AddAccessible',
        CACHE_ITEM_SIGNATURE,
        [this._cacheItemFor(node)],
      );
    } catch {
      // as _signal
    }
  }

  emitCacheRemove(ref) {
    if (this.dead) return;
    try {
      this.bus.sendSignal(CACHE_PATH, IFACE.CACHE, 'RemoveAccessible', '(so)', [
        ref,
      ]);
    } catch {
      // as _signal
    }
  }

  // ---- the queue -------------------------------------------------------

  _schedule() {
    if (this._flushScheduled || this.dead) return;
    this._flushScheduled = true;
    queueMicrotask(() => this.flush());
  }

  /** Is this node under a toplevel the bridge is presenting? Detached
   * subtrees under construction are not, which is what keeps the initial
   * bottom-up build of a tree from queueing one event per node. */
  _live(node) {
    let n = node;
    while (n) {
      if (!n.parent) return this.toplevels.includes(n);
      n = n.parent;
    }
    return false;
  }

  queueAttach(node) {
    this._pending.attach.add(node);
    this._schedule();
  }

  queueRemove(parent, child, index) {
    this._pending.remove.push({ parent, child, index });
    this._schedule();
  }

  queueProps(node) {
    this._pending.props.add(node);
    this._schedule();
  }

  queueText(node) {
    this._pending.text.add(node);
    this._schedule();
  }

  queueFocus(previous, next) {
    this._pending.focus.push({ previous, next });
    this._schedule();
  }

  queueWindowFocus(win, focused) {
    this._pending.window.push({ win, focused });
    this._schedule();
  }

  flush() {
    if (this.dead) return;
    this._flushScheduled = false;
    const p = this._pending;
    if (
      p.attach.size === 0 &&
      p.remove.length === 0 &&
      p.props.size === 0 &&
      p.text.size === 0 &&
      p.focus.length === 0 &&
      p.window.length === 0
    ) {
      return;
    }
    this._pending = {
      attach: new Set(),
      remove: [],
      props: new Set(),
      text: new Set(),
      focus: [],
      window: [],
    };

    // Removals first: a node that left and came back in one batch reads as
    // its add, never as a stale remove.
    for (const { parent, child, index } of p.remove) {
      const stillIn =
        parent === null
          ? this.toplevels.includes(child)
          : child.parent === parent;
      if (stillIn) continue;
      const wasExported = this.exported.has(child);
      const childPath = this.pathOf(child);
      const childRef = [this.bus.name, childPath];
      // unexport the whole subtree the AT may hold refs into — the drawn
      // children included, read from what the element last said rather than
      // by asking one that is being torn down; each exported node also
      // tells the client caches it is gone
      const walk = (n) => {
        for (const c of n.children ?? []) walk(c);
        for (const item of knownSceneItems(n)) walk(item);
        this._unexport(n);
      };
      walk(child);
      // Whatever the AT never saw, it does not need to hear about.
      if (!wasExported) continue;
      if (child.isWindow && !child.parent) {
        this._signal(childPath, IFACE.EVENT_WINDOW, 'Destroy', '', 0, 0, [
          's',
          '',
        ]);
      }
      if (parent === null || this.exported.has(parent)) {
        this._signal(
          parent === null ? ROOT_PATH : this.pathOf(parent),
          IFACE.EVENT_OBJECT,
          'ChildrenChanged',
          'remove',
          index,
          0,
          ['(so)', childRef],
        );
      }
    }

    // Attaches, collapsed to the topmost node per subtree: the AT descends
    // from there on its own.
    for (const node of p.attach) {
      if (node.destroyed || !this._live(node)) continue;
      let covered = false;
      for (let a = node.parent; a; a = a.parent) {
        if (p.attach.has(a)) {
          covered = true;
          break;
        }
      }
      if (covered) continue;
      const wasExported = this.exported.has(node);
      const parent = a11yParent(node);
      const index = parent
        ? a11yIndexIn(parent, node)
        : this.toplevels.indexOf(node);
      if (!wasExported) this.emitCacheAdd(node);
      this._signal(
        parent ? this.pathOf(parent) : ROOT_PATH,
        IFACE.EVENT_OBJECT,
        'ChildrenChanged',
        'add',
        index,
        0,
        ['(so)', this.refFor(node)],
      );
      if (node.isWindow && !node.parent) this.emitWindow(node, 'Create');
    }

    for (const node of p.props) this.syncNode(node);
    for (const node of p.text) this.syncText(node);

    for (const { previous, next } of p.focus) {
      if (previous && this.exported.has(previous) && !previous.destroyed) {
        this.emitStateChanged(previous, ATSPI_STATE.FOCUSED, false);
        this._refreshSnapshotStates(previous);
      }
      if (next && !next.destroyed && this._live(next)) {
        this.ensureExported(next);
        this.emitStateChanged(next, ATSPI_STATE.FOCUSED, true);
        this._signal(this.pathOf(next), IFACE.EVENT_FOCUS, 'Focus', '', 0, 0, [
          'i',
          0,
        ]);
        this._refreshSnapshotStates(next);
      }
    }

    const lastWindow = new Map();
    for (const { win, focused } of p.window) lastWindow.set(win, focused);
    for (const [win, focused] of lastWindow) {
      if (win.destroyed || !this.exported.has(win)) continue;
      this.emitWindow(win, focused ? 'Activate' : 'Deactivate');
      this.emitStateChanged(win, ATSPI_STATE.ACTIVE, focused);
      this._refreshSnapshotStates(win);
    }
  }

  _refreshSnapshotStates(node) {
    const entry = this.exported.get(node);
    if (entry?.snapshot) entry.snapshot.states = a11yStates(node);
  }

  /** Recompute what the bus was last told about a node and emit the exact
   * difference. Every "some prop changed" notification lands here, which is
   * what makes the wiring correct without per-prop plumbing. */
  syncNode(node) {
    const entry = this.exported.get(node);
    if (!entry || node.destroyed) return;
    const before = entry.snapshot;
    // interface set can change (a value appearing, a handler added)
    const wanted = this._ifaceSetFor(node);
    if (wanted.join() !== entry.ifaces.join()) {
      const path = NODE_PATH + entry.id;
      for (const name of entry.ifaces) {
        if (!wanted.includes(name)) this.bus.unexportInterface(path, name);
      }
      for (const name of wanted) {
        if (!entry.ifaces.includes(name)) {
          const [desc, proto] = this._descriptorFor(name);
          this.bus.exportInterface(this._implFor(proto, node), path, desc);
        }
      }
      entry.ifaces = wanted;
    }
    const now = this._snapshot(node);
    now.ifaces = entry.ifaces;
    entry.snapshot = now;
    if (now.name !== before.name) {
      this.emitObject(node, 'PropertyChange', 'accessible-name', 0, 0, [
        's',
        now.name,
      ]);
    }
    if (now.description !== before.description) {
      this.emitObject(node, 'PropertyChange', 'accessible-description', 0, 0, [
        's',
        now.description,
      ]);
    }
    if (now.value !== before.value && now.value !== null) {
      this.emitObject(node, 'PropertyChange', 'accessible-value', 0, 0, [
        'd',
        now.value,
      ]);
    }
    for (const half of [0, 1]) {
      let changed = (before.states[half] ^ now.states[half]) >>> 0;
      while (changed !== 0) {
        const low = changed & -changed;
        const stateBit = 31 - Math.clz32(low) + half * 32;
        this.emitStateChanged(node, stateBit, Boolean(now.states[half] & low));
        changed = (changed ^ low) >>> 0;
      }
    }
    if (before.text && now.text) this._diffText(node, before.text, now.text);
    if (before.scene.length > 0 || now.scene.length > 0) {
      this._diffScene(node, before.scene, now.scene);
    }
  }

  /**
   * The items an element drew, as children arriving and leaving. Identity
   * is the element's own id, resolved in a11y.js, so a scene rebuilt every
   * frame produces events only where something actually changed — and a
   * surviving item is re-diffed through `syncNode`, the same path a
   * `<box>`'s props take, which is what gets its name and its selected
   * state onto the bus without a second diff living here.
   */
  _diffScene(parent, before, now) {
    const kept = new Set(now);
    for (const item of before) {
      if (kept.has(item)) continue;
      if (!this.exported.has(item)) continue;
      const ref = [this.bus.name, this.pathOf(item)];
      const walk = (n) => {
        for (const c of n.children ?? []) walk(c);
        this._unexport(n);
      };
      walk(item);
      this._signal(
        this.pathOf(parent),
        IFACE.EVENT_OBJECT,
        'ChildrenChanged',
        'remove',
        // where it was: the retained children it sat behind, then its own
        // place in the scene it has just left
        a11yChildren(parent).length - now.length + before.indexOf(item),
        0,
        ['(so)', ref],
      );
    }
    const gone = new Set(before);
    for (const item of now) {
      if (gone.has(item)) {
        this.syncNode(item);
        continue;
      }
      this.emitCacheAdd(item);
      this._signal(
        this.pathOf(parent),
        IFACE.EVENT_OBJECT,
        'ChildrenChanged',
        'add',
        a11yIndexIn(parent, item),
        0,
        ['(so)', this.refFor(item)],
      );
    }
  }

  syncText(node) {
    const entry = this.exported.get(node);
    if (!entry || node.destroyed || !entry.snapshot?.text) return;
    const before = entry.snapshot.text;
    const now = textStateOf(node);
    entry.snapshot.text = now;
    this._diffText(node, before, now);
  }

  /**
   * The difference as AT-SPI events, with the composition's own churn
   * marked `:system` — the detail suffix Gecko established for a change the
   * user did not type, and which at-spi2-core's event dispatch already
   * parses. A preedit appearing, growing or being abandoned is exactly
   * that: nothing was typed, a decoration is on the screen.
   *
   * The **commit** stays a plain `insert`. `dead_acute` then `e` deletes
   * the `´` — inside the old preedit, so `delete:system` — and inserts `é`,
   * which is in no preedit and is what the user actually typed. A reader
   * that suppresses system text says "é" and nothing else, which is the
   * distinction this path exists to draw.
   */
  _diffText(node, before, now) {
    const diff = diffChars(before.chars, now.chars);
    if (diff) {
      if (diff.removed.length > 0) {
        // what it replaced belonged to the *previous* state's composition
        const system = inPreedit(before, diff.offset, diff.removed.length);
        this.emitObject(
          node,
          'TextChanged',
          system ? 'delete:system' : 'delete',
          diff.offset,
          diff.removed.length,
          ['s', diff.removed.join('')],
        );
      }
      if (diff.inserted.length > 0) {
        const system = inPreedit(now, diff.offset, diff.inserted.length);
        this.emitObject(
          node,
          'TextChanged',
          system ? 'insert:system' : 'insert',
          diff.offset,
          diff.inserted.length,
          ['s', diff.inserted.join('')],
        );
      }
    }
    if (now.caret !== before.caret) {
      this.emitObject(node, 'TextCaretMoved', '', now.caret, 0, ['i', 0]);
    }
    const selectionChanged =
      now.selection[0] !== before.selection[0] ||
      now.selection[1] !== before.selection[1];
    if (selectionChanged) {
      this.emitObject(node, 'TextSelectionChanged', '', 0, 0, ['i', 0]);
    }
  }

  // ---- the application root -------------------------------------------

  exportRoot() {
    const bridge = this;
    const rootAccessible = {
      get Name() {
        return programName();
      },
      get Description() {
        return '';
      },
      get Parent() {
        return bridge.desktop;
      },
      get ChildCount() {
        return bridge.toplevels.length;
      },
      get Locale() {
        return localeString();
      },
      get AccessibleId() {
        return '';
      },
      GetChildAtIndex(index) {
        const win = bridge.toplevels[index];
        return win ? bridge.refFor(win) : bridge.nullRef();
      },
      GetChildren() {
        return bridge.toplevels.map((win) => bridge.refFor(win));
      },
      GetIndexInParent() {
        return -1;
      },
      GetRelationSet() {
        return [];
      },
      GetRole() {
        return ATSPI_ROLE.APPLICATION;
      },
      GetRoleName() {
        return 'application';
      },
      GetLocalizedRoleName() {
        return 'application';
      },
      GetState() {
        return [0, 0];
      },
      GetAttributes() {
        return [['toolkit', 'react-x11']];
      },
      GetApplication() {
        return bridge.rootRef();
      },
      GetInterfaces() {
        return [IFACE.ACCESSIBLE, IFACE.APPLICATION, IFACE.SOCKET];
      },
    };
    const application = {
      ToolkitName: 'react-x11',
      get Version() {
        return bridge.toolkitVersion;
      },
      AtspiVersion: ATSPI_VERSION,
      get Id() {
        return bridge.appId;
      },
      set Id(value) {
        bridge.appId = value | 0;
      },
      GetLocale() {
        return localeString();
      },
      GetApplicationBusAddress() {
        return '';
      },
    };
    const socket = {
      Embedded() {
        return null;
      },
      Unembed() {
        return null;
      },
    };
    const cache = {
      GetItems() {
        const items = [bridge._rootCacheItem(rootAccessible)];
        const walk = (node) => {
          items.push(bridge._cacheItemFor(node));
          for (const child of a11yChildren(node)) walk(child);
        };
        for (const win of bridge.toplevels) walk(win);
        return items;
      },
    };
    this.bus.exportInterface(rootAccessible, ROOT_PATH, ACCESSIBLE_DESC);
    this.bus.exportInterface(application, ROOT_PATH, APPLICATION_DESC);
    this.bus.exportInterface(socket, ROOT_PATH, SOCKET_DESC);
    this.bus.exportInterface(cache, CACHE_PATH, CACHE_DESC);
  }

  /** The cache item for the application root itself, which is not a node. */
  _rootCacheItem(rootAccessible) {
    return [
      this.rootRef(),
      this.rootRef(),
      this.desktop,
      -1,
      this.toplevels.length,
      rootAccessible.GetInterfaces(),
      rootAccessible.Name,
      ATSPI_ROLE.APPLICATION,
      '',
      [0, 0],
    ];
  }

  // ---- registration ----------------------------------------------------

  async embed() {
    const reply = await this.bus.invoke({
      destination: REGISTRY_NAME,
      path: ROOT_PATH,
      interface: IFACE.SOCKET,
      member: 'Embed',
      signature: '(so)',
      body: [[this.bus.name, ROOT_PATH]],
    });
    if (Array.isArray(reply) && reply.length === 2) this.desktop = reply;
  }

  /** The registry restarting is survivable: watch its name and re-embed
   * under the new owner, exactly as the GTK bridge does. */
  async watchRegistry() {
    const rule =
      "type='signal',sender='org.freedesktop.DBus'," +
      "interface='org.freedesktop.DBus',member='NameOwnerChanged'," +
      `arg0='${REGISTRY_NAME}'`;
    await this.bus.addMatch(rule);
    const key = this.bus.mangle(
      '/org/freedesktop/DBus',
      'org.freedesktop.DBus',
      'NameOwnerChanged',
    );
    this.bus.signals.on(key, (body) => {
      const newOwner = body?.[2];
      if (newOwner) this.embed().catch(() => {});
    });
  }

  // ---- wiring into the renderer ---------------------------------------

  install() {
    hooks.rootMounted = (win) => {
      if (this.toplevels.includes(win)) return;
      this.toplevels.push(win);
      this.queueAttach(win);
    };
    hooks.rootUnmounted = (win) => {
      const index = this.toplevels.indexOf(win);
      if (index === -1) return;
      this.toplevels.splice(index, 1);
      this.queueRemove(null, win, index);
    };
    hooks.attached = (parent, child) => {
      if (!this._live(parent)) return;
      this.queueAttach(child);
    };
    hooks.detach = (parent, child) => {
      if (!this.exported.has(child) && !this._live(parent)) return;
      this.queueRemove(parent, child, a11yIndexIn(parent, child));
    };
    hooks.propsChanged = (node) => {
      if (this.exported.has(node)) this.queueProps(node);
    };
    hooks.textContent = (chunk) => {
      let text = chunk.parent;
      while (text && text.kind === 'text' && text.isSpan) text = text.parent;
      if (!text) return;
      if (this.exported.has(text)) this.queueText(text);
      // labels feed names-from-contents anywhere above them
      for (let a = text; a; a = a11yParent(a)) {
        if (this.exported.has(a)) this.queueProps(a);
        if (a.isWindow) break;
      }
    };
    hooks.textState = (node) => {
      if (this.exported.has(node)) this.queueText(node);
    };
    hooks.focus = (previous, next) => {
      this.queueFocus(previous, next);
    };
    hooks.windowFocus = (win, focused) => {
      this.queueWindowFocus(win, focused);
    };
    hooks.commit = () => this.flush();
    hooks.announce = (text, opts) => {
      // spoken from the active window, which is the context the user is in
      const target =
        this.toplevels.find((win) => win.events?.windowFocused) ??
        this.toplevels[0] ??
        null;
      if (target) this.ensureExported(target);
      this._signal(
        target ? this.pathOf(target) : ROOT_PATH,
        IFACE.EVENT_OBJECT,
        'Announcement',
        '',
        opts?.assertive ? 2 : 1, // AtspiLive: 1 polite, 2 assertive
        0,
        ['s', String(text)],
      );
      return true;
    };

    // toplevels that mounted before the bridge finished connecting
    this._unsubscribes.push(
      onApp((app) => {
        for (const win of app._rootChildren ?? []) {
          hooks.rootMounted(win);
        }
      }),
    );
  }

  bury() {
    if (this.dead) return;
    this.dead = true;
    for (const key of Object.keys(hooks)) hooks[key] = null;
    for (const unsubscribe of this._unsubscribes) unsubscribe();
    this._unsubscribes = [];
  }
}

// --------------------------------------------------------------------------
// The ladder
// --------------------------------------------------------------------------

let bridge = null;

/** Wait for a fresh dbus-native client to finish its handshake and its
 * Hello, or throw with the reason it could not. */
async function connected(bus) {
  await new Promise((resolve, reject) => {
    const conn = bus.connection;
    const cleanup = () => {
      conn.removeListener('connect', onConnect);
      conn.removeListener('error', onError);
      conn.removeListener('close', onClose);
    };
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('the bus closed during the handshake'));
    };
    conn.once('connect', onConnect);
    conn.on('error', onError);
    conn.once('close', onClose);
  });
  // one round trip so bus.name (the Hello reply) is settled
  await bus.listNames();
  if (bus.name == null) {
    throw new Error('the peer answered but never assigned a unique name');
  }
}

/**
 * Ask the session bus where the accessibility bus is. `org.a11y.Bus` is
 * D-Bus-activatable, so this also starts the launcher on desktops where it
 * is not already running.
 *
 * Deliberately **not** the shared `sessionBus()` connection. Discovery is
 * one call at process startup; riding the shared machinery would leave the
 * warm shared socket open as the side effect of a probe, and would race
 * anything that swaps `DBUS_SESSION_BUS_ADDRESS` and resets the shared
 * state under an in-flight climb — which is exactly what a test harness
 * (this repo's own included) does between cases. A private connection,
 * closed before this returns, cannot interfere with anyone.
 */
async function accessibilityBusAddress(dbus) {
  if (process.env.AT_SPI_BUS_ADDRESS) return process.env.AT_SPI_BUS_ADDRESS;
  const busAddress = addressFor('session');
  if (!busAddress && process.platform !== 'darwin') return null;
  let sbus = null;
  try {
    sbus = dbus.createClient({ busAddress });
    await connected(sbus);
    const address = await sbus.invoke({
      destination: 'org.a11y.Bus',
      path: '/org/a11y/bus',
      interface: 'org.a11y.Bus',
      member: 'GetAddress',
    });
    return typeof address === 'string' && address !== '' ? address : null;
  } catch {
    return null;
  } finally {
    if (sbus) {
      silenceAndEnd(sbus);
    }
  }
}

function silenceAndEnd(abus) {
  try {
    abus.connection.removeAllListeners('error');
    abus.connection.on('error', () => {});
    abus.connection.end?.();
  } catch {
    // it was never usable; nothing to say
  }
}

/**
 * Climb the ladder and return the live bridge, or null. Called once per
 * process through `startA11y()`; every rung that fails reports why when
 * REACT_X11_A11Y is set and stays silent otherwise — "no accessibility
 * stack here" is a normal configuration, not an error.
 */
export async function start() {
  if (bridge) return bridge.dead ? null : bridge;
  const loud = Boolean(process.env.REACT_X11_A11Y);
  const off = (why, cause) => {
    if (loud) {
      console.warn(
        `react-x11: accessibility off — ${why}` +
          (cause ? ` (${cause.message ?? cause})` : ''),
      );
    }
    return null;
  };

  let dbus;
  try {
    dbus = await loadTransport();
  } catch (cause) {
    return off('dbus-native is not installed (npm i dbus-native)', cause);
  }

  const address = await accessibilityBusAddress(dbus);
  if (!address) {
    return off(
      'no accessibility bus (no session bus, or no at-spi on this desktop)',
    );
  }

  let abus;
  try {
    abus = dbus.createClient({ busAddress: address });
  } catch (cause) {
    return off(`could not parse the accessibility bus address`, cause);
  }

  try {
    await connected(abus);
  } catch (cause) {
    silenceAndEnd(abus);
    return off('could not connect to the accessibility bus', cause);
  }

  // Never hold the process open: the bridge is a passenger, not cargo. If
  // the app has no other work, exiting is correct and the registry sees the
  // name drop.
  abus.connection.stream?.unref?.();

  let version = '0.0.0';
  try {
    const { createRequire } = await import('node:module');
    version = createRequire(import.meta.url)('../package.json').version;
  } catch {
    // bundled; the toolkit version is cosmetic
  }

  const b = new AtspiBridge(abus, version);
  abus.connection.on('error', () => b.bury());
  abus.connection.once('close', () => b.bury());

  b.exportRoot();
  try {
    await b.embed();
  } catch (cause) {
    // A bus with no registry is unusual but not fatal: the watch below
    // embeds the moment one appears.
    if (loud) {
      console.warn(
        'react-x11: accessibility registry not reachable yet:',
        cause?.message ?? cause,
      );
    }
  }
  b.watchRegistry().catch(() => {});
  b.install();
  bridge = b;
  if (loud) {
    console.warn(
      `react-x11: accessibility bridge live on ${abus.name} (${address})`,
    );
  }
  return b;
}

/** Test seam: tear the bridge down and forget it, so the next start() can
 * climb the ladder again against a different bus. */
export async function _stopForTests() {
  if (!bridge) return;
  const b = bridge;
  bridge = null;
  b.bury();
  try {
    await b.bus.close();
  } catch {
    // already gone
  }
}

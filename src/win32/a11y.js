// The accessibility bridge for Windows: the same tree, pushed to UI
// Automation.
//
// `src/atspi.js` answers AT-SPI's questions from the **live** tree, because
// AT-SPI asks over a bus, asynchronously, and JS answers when it gets to
// them. UIA asks synchronously and often — one focus change is dozens of
// property reads — so answering from JS would pace the screen reader by the
// application's busiest moment. The bridge therefore *pushes*, and
// `windows/src/uia.cc` answers from its copy. The reasoning is
// docs/windows.md §"Accessibility: UI Automation"; what matters here is the
// consequence: **this file's job is a diff, not an answer.**
//
// Everything it pushes comes from `src/a11y.js`, which is pure functions over
// the live tree and is what the AT-SPI bridge reads too. Nothing about roles,
// names, states or values is decided twice — the only thing that is Windows'
// own is the last translation, from the one canonical role to UIA's control
// type, and that table is below where it can be read and tested.
//
// It fills the same `hooks` slots `atspi.js` fills, and only one bridge is
// ever installed in a process (`startA11y()`).
import {
  ATSPI_ROLE,
  ATSPI_STATE,
  a11yChildren,
  a11yDescription,
  a11yName,
  a11yStates,
  a11yValue,
  a11yActivatable,
  atspiRoleOf,
  hooks,
  isNativeTextControl,
} from '../a11y.js';
import { synthesizeClick } from '../events.js';
import { onApp } from '../trace-registry.js';

const TRACE = process.env.REACT_X11_TRACE_A11Y === '1';

/**
 * How often commits may push the mirror, in ms. A commit that follows a
 * quiet spell pushes at once; a stream of them — a pan, a drag, a value
 * ticking — pushes once per interval, the last of them catching up.
 *
 * UIA's clients are almost always listening on a desktop Windows (the
 * touch keyboard, the text services and others ask for the tree), so the
 * push is not the rare case the listening gate makes it elsewhere: a walk
 * of the window and a marshalled diff, on every commit. For a graph pane
 * whose every item moves on every step of a pan that was 1.6 ms of each
 * frame. A screen reader reads positions on demand and does not need
 * sixty of them a second; a focus change, which it is waiting on, still
 * pushes at once (`hooks.focus`), as does an announcement.
 */
const COMMIT_PUSH_MS = 100;

// --------------------------------------------------------------------------
// The one translation that is Windows' own
// --------------------------------------------------------------------------

/**
 * UIA's control type ids. Spelled out rather than imported because the bridge
 * is the only thing that needs them and a table of forty numbers is easier to
 * check against Microsoft's list when it is one table.
 */
const UIA = Object.freeze({
  Button: 50000,
  Calendar: 50001,
  CheckBox: 50002,
  ComboBox: 50003,
  Edit: 50004,
  Hyperlink: 50005,
  Image: 50006,
  ListItem: 50007,
  List: 50008,
  Menu: 50009,
  MenuBar: 50010,
  MenuItem: 50011,
  ProgressBar: 50012,
  RadioButton: 50013,
  ScrollBar: 50014,
  Slider: 50015,
  Spinner: 50016,
  StatusBar: 50017,
  Tab: 50018,
  TabItem: 50019,
  Text: 50020,
  ToolBar: 50021,
  ToolTip: 50022,
  Tree: 50023,
  TreeItem: 50024,
  Custom: 50025,
  Group: 50026,
  Thumb: 50027,
  DataGrid: 50028,
  DataItem: 50029,
  Document: 50030,
  SplitButton: 50031,
  Window: 50032,
  Pane: 50033,
  Header: 50034,
  HeaderItem: 50035,
  Table: 50036,
  TitleBar: 50037,
  Separator: 50038,
});

/**
 * AT-SPI role → UIA control type.
 *
 * The AT-SPI number is the tree's *one* canonical role (`atspiRoleOf`), so
 * this is the whole of what Windows adds. Two rules decide the awkward cases:
 *
 *   - **Group, not Pane, for a container.** A UIA Pane is a top-level region
 *     of a window (a document pane, a preview pane); a `<box>` is not one,
 *     and Narrator announces panes.
 *   - **Text, not Edit, for a label.** UIA's Edit *means editable*; a
 *     read-only `<text>` announced as an edit field is one a screen reader
 *     offers to type into.
 *
 * Anything missing falls to Group, which is a container a screen reader steps
 * through silently — the same behaviour AT-SPI's FILLER gets, and the reason
 * an unlabelled tree is boring here rather than noisy.
 */
const ROLE_TO_UIA = new Map([
  [ATSPI_ROLE.ALERT, UIA.Pane],
  [ATSPI_ROLE.CANVAS, UIA.Image],
  [ATSPI_ROLE.CHECK_BOX, UIA.CheckBox],
  [ATSPI_ROLE.CHECK_MENU_ITEM, UIA.MenuItem],
  [ATSPI_ROLE.COLUMN_HEADER, UIA.HeaderItem],
  [ATSPI_ROLE.COMBO_BOX, UIA.ComboBox],
  [ATSPI_ROLE.DIAL, UIA.Slider],
  [ATSPI_ROLE.DIALOG, UIA.Window],
  [ATSPI_ROLE.DRAWING_AREA, UIA.Image],
  [ATSPI_ROLE.FILLER, UIA.Group],
  [ATSPI_ROLE.FRAME, UIA.Window],
  [ATSPI_ROLE.ICON, UIA.Image],
  [ATSPI_ROLE.IMAGE, UIA.Image],
  [ATSPI_ROLE.LABEL, UIA.Text],
  [ATSPI_ROLE.LIST, UIA.List],
  [ATSPI_ROLE.LIST_BOX, UIA.List],
  [ATSPI_ROLE.LIST_ITEM, UIA.ListItem],
  [ATSPI_ROLE.MENU, UIA.Menu],
  [ATSPI_ROLE.MENU_BAR, UIA.MenuBar],
  [ATSPI_ROLE.MENU_ITEM, UIA.MenuItem],
  [ATSPI_ROLE.PAGE_TAB, UIA.TabItem],
  [ATSPI_ROLE.PAGE_TAB_LIST, UIA.Tab],
  [ATSPI_ROLE.PANEL, UIA.Group],
  [ATSPI_ROLE.PASSWORD_TEXT, UIA.Edit],
  [ATSPI_ROLE.POPUP_MENU, UIA.Menu],
  [ATSPI_ROLE.PROGRESS_BAR, UIA.ProgressBar],
  [ATSPI_ROLE.BUTTON, UIA.Button],
  [ATSPI_ROLE.RADIO_BUTTON, UIA.RadioButton],
  [ATSPI_ROLE.RADIO_MENU_ITEM, UIA.MenuItem],
  [ATSPI_ROLE.ROW_HEADER, UIA.HeaderItem],
  [ATSPI_ROLE.SCROLL_BAR, UIA.ScrollBar],
  [ATSPI_ROLE.SCROLL_PANE, UIA.Pane],
  [ATSPI_ROLE.SEPARATOR, UIA.Separator],
  [ATSPI_ROLE.SLIDER, UIA.Slider],
  [ATSPI_ROLE.SPIN_BUTTON, UIA.Spinner],
  [ATSPI_ROLE.SPLIT_PANE, UIA.Pane],
  [ATSPI_ROLE.STATUS_BAR, UIA.StatusBar],
  [ATSPI_ROLE.TABLE, UIA.Table],
  [ATSPI_ROLE.TABLE_CELL, UIA.DataItem],
  [ATSPI_ROLE.TABLE_COLUMN_HEADER, UIA.HeaderItem],
  [ATSPI_ROLE.TABLE_ROW, UIA.DataItem],
  [ATSPI_ROLE.TABLE_ROW_HEADER, UIA.HeaderItem],
  [ATSPI_ROLE.TEXT, UIA.Edit],
  [ATSPI_ROLE.TOGGLE_BUTTON, UIA.Button],
  [ATSPI_ROLE.TOOL_BAR, UIA.ToolBar],
  [ATSPI_ROLE.TOOL_TIP, UIA.ToolTip],
  [ATSPI_ROLE.TREE, UIA.Tree],
  [ATSPI_ROLE.TREE_ITEM, UIA.TreeItem],
  [ATSPI_ROLE.TREE_TABLE, UIA.Tree],
  [ATSPI_ROLE.VIEWPORT, UIA.Pane],
  [ATSPI_ROLE.WINDOW, UIA.Window],
  [ATSPI_ROLE.HEADER, UIA.Header],
  [ATSPI_ROLE.FOOTER, UIA.Group],
  [ATSPI_ROLE.PARAGRAPH, UIA.Text],
  [ATSPI_ROLE.EMBEDDED, UIA.Pane],
  [ATSPI_ROLE.ENTRY, UIA.Edit],
  [ATSPI_ROLE.CAPTION, UIA.Text],
  [ATSPI_ROLE.HEADING, UIA.Text],
  [ATSPI_ROLE.SECTION, UIA.Group],
  [ATSPI_ROLE.FORM, UIA.Group],
  [ATSPI_ROLE.LINK, UIA.Hyperlink],
  [ATSPI_ROLE.DOCUMENT_TEXT, UIA.Document],
  [ATSPI_ROLE.DOCUMENT_WEB, UIA.Document],
  [ATSPI_ROLE.DOCUMENT_FRAME, UIA.Document],
  [ATSPI_ROLE.GROUPING, UIA.Group],
  [ATSPI_ROLE.NOTIFICATION, UIA.Group],
  [ATSPI_ROLE.INFO_BAR, UIA.Group],
  [ATSPI_ROLE.LEVEL_BAR, UIA.ProgressBar],
  [ATSPI_ROLE.ARTICLE, UIA.Group],
  [ATSPI_ROLE.LANDMARK, UIA.Group],
  [ATSPI_ROLE.LOG, UIA.Group],
  [ATSPI_ROLE.MATH, UIA.Group],
  [ATSPI_ROLE.RATING, UIA.Slider],
  [ATSPI_ROLE.TIMER, UIA.Text],
  [ATSPI_ROLE.STATIC, UIA.Text],
  [ATSPI_ROLE.SWITCH, UIA.Button],
  [ATSPI_ROLE.SEPARATOR, UIA.Separator],
]);

/** What UIA should call this node. Exported for the test that checks the
 *  table against the roles an app can actually write. */
export function uiaControlType(node) {
  return ROLE_TO_UIA.get(atspiRoleOf(node)) ?? UIA.Group;
}

/** One state out of the pair of uint32s `a11yStates` returns. */
function hasState(states, state) {
  return state < 32
    ? (states[0] & (1 << state)) !== 0
    : (states[1] & (1 << (state - 32))) !== 0;
}

// --------------------------------------------------------------------------
// The snapshot
// --------------------------------------------------------------------------

/** The roles whose checked state UIA reads through Toggle rather than a
 *  state flag. A radio button is *not* one: UIA gives it SelectionItem, and
 *  reporting it as a toggle makes a screen reader say "checkbox". */
const TOGGLES = new Set([
  ATSPI_ROLE.CHECK_BOX,
  ATSPI_ROLE.CHECK_MENU_ITEM,
  ATSPI_ROLE.TOGGLE_BUTTON,
  ATSPI_ROLE.SWITCH,
]);

/**
 * What the mirror is told about one node.
 *
 * Every field comes from `a11y.js`, so this is a *translation* and never a
 * second opinion — the bug a second copy of the truth invites is exactly the
 * one where the two disagree about what a node is called.
 */
function snapshotOf(node, id, parentId, childIds) {
  const states = a11yStates(node);
  const role = atspiRoleOf(node);
  const value = a11yValue(node);
  const box = node.abs ?? { x: 0, y: 0, width: 0, height: 0 };
  const editable = hasState(states, ATSPI_STATE.EDITABLE);
  const text = isNativeTextControl(node) ? (node.value ?? '') : '';

  return {
    id,
    parent: parentId,
    children: childIds,
    controlType: ROLE_TO_UIA.get(role) ?? UIA.Group,
    name: a11yName(node) ?? '',
    description: a11yDescription(node) ?? '',
    // `<textinput>`'s text, or a valuetext where a range has one. A node
    // with neither offers no Value pattern at all rather than an empty one.
    value: editable ? text : (value?.text ?? ''),
    automationId: typeof node.props?.id === 'string' ? node.props.id : '',
    enabled: hasState(states, ATSPI_STATE.ENABLED),
    focusable: hasState(states, ATSPI_STATE.FOCUSABLE),
    focused: hasState(states, ATSPI_STATE.FOCUSED),
    // UIA's "offscreen" is "not currently displayed", which is what SHOWING
    // says the other way round.
    offscreen: !hasState(states, ATSPI_STATE.SHOWING),
    readOnly: !editable,
    // Never both: UIA reads a checkbox through Toggle, and a control that
    // also advertised Invoke is one Narrator describes twice over. Toggle
    // wins, because it carries the state as well as the action.
    invoke: a11yActivatable(node) && !TOGGLES.has(role),
    toggle: TOGGLES.has(role),
    toggleState: hasState(states, ATSPI_STATE.INDETERMINATE)
      ? 2
      : hasState(states, ATSPI_STATE.CHECKED)
        ? 1
        : 0,
    valuePattern: editable || Boolean(value?.text),
    rangePattern: Boolean(value),
    rangeNow: value?.now ?? 0,
    rangeMin: value?.min ?? 0,
    rangeMax: value?.max ?? 0,
    x: Math.round(box.x ?? 0),
    y: Math.round(box.y ?? 0),
    width: Math.round(box.width ?? 0),
    height: Math.round(box.height ?? 0),
  };
}

/** Whether two snapshots say the same thing. Compared field by field rather
 *  than by JSON, which would allocate a string per node per commit. */
function same(a, b) {
  if (!a || !b) return false;
  for (const key of Object.keys(a)) {
    if (key === 'children') continue;
    if (a[key] !== b[key]) return false;
  }
  return (
    a.children.length === b.children.length &&
    a.children.every((id, at) => id === b.children[at])
  );
}

// --------------------------------------------------------------------------
// The bridge
// --------------------------------------------------------------------------

export class Win32Accessibility {
  constructor(app) {
    this.app = app;
    this._native = app._native;
    this.toplevels = [];
    /** Stable ids, which is what UIA's runtime ids are made of. */
    this._ids = new WeakMap();
    this._nextId = 1;
    /** What the mirror was last told, by id. */
    this._sent = new Map();
    /** Which windows to re-walk on the next commit. */
    this._dirty = new Set();
    /** Windows the mirror has ever been told about. */
    this._pushed = new Set();
    this._unsubscribes = [];
    this.dead = false;
    /** When a commit last pushed, and the push a stream of commits owes. */
    this._lastCommitPush = -Infinity;
    this._trailing = null;
  }

  _idOf(node) {
    let id = this._ids.get(node);
    if (id === undefined) {
      id = this._nextId++;
      this._ids.set(node, id);
    }
    return id;
  }

  /** The backend window a toplevel is on, or null before it is realized. */
  _windowOf(win) {
    const wnd = win?.window;
    return wnd && typeof wnd.id === 'number' ? wnd : null;
  }

  // ---- the walk ---------------------------------------------------------

  /**
   * Walk one toplevel and push what changed.
   *
   * The whole window is walked rather than a subtree, deliberately: the walk
   * is `a11yChildren` over nodes that are already in memory, the comparison
   * that follows drops everything unchanged, and the alternative — tracking
   * which subtree a prop change belongs to — is where the AT-SPI bridge's
   * own complexity lives. What crosses to the bridge is the diff either way.
   */
  _push(win) {
    const wnd = this._windowOf(win);
    if (!wnd || win.destroyed) return;

    const nodes = [];
    const seen = new Set();
    const rootId = this._idOf(win);

    const visit = (node, parentId) => {
      const id = this._idOf(node);
      seen.add(id);
      const kids = a11yChildren(node);
      const childIds = kids.map((kid) => this._idOf(kid));
      const snapshot = snapshotOf(node, id, parentId, childIds);
      if (!same(this._sent.get(id), snapshot)) {
        this._sent.set(id, snapshot);
        nodes.push(snapshot);
      }
      for (const kid of kids) visit(kid, id);
    };
    visit(win, 0);

    // Nodes this window used to have and no longer does. Tracked per window
    // so one window's unmount cannot drop another's ids.
    const removed = [];
    const was = this._windowIds ?? (this._windowIds = new Map());
    const before = was.get(wnd.id);
    if (before) {
      for (const id of before) {
        if (!seen.has(id)) {
          removed.push(id);
          this._sent.delete(id);
        }
      }
    }
    was.set(wnd.id, seen);

    if (nodes.length === 0 && removed.length === 0) return;
    const focused = win.events?.focusManager?.focused ?? null;
    this._native.uiaUpdate(wnd.id, {
      root: rootId,
      focused: focused ? this._idOf(focused) : rootId,
      nodes,
      removed,
    });
    if (TRACE) {
      trace(
        `window ${wnd.id}: ${nodes.length} changed, ${removed.length} gone`,
      );
    }
  }

  /**
   * Push what changed, for the windows that changed.
   *
   * Nobody listening means nobody to tell, and the check is the difference
   * between a machine with no screen reader paying for a tree walk on every
   * commit and paying nothing — the same shape as the AT-SPI bridge's "no
   * bus, no work".
   *
   * *Nobody* is asked per window where the bridge can say (`uiaActive`):
   * whether a client has read this window's tree in the last few seconds.
   * UIA's own answer, `UiaClientsAreListening`, is whether any client on
   * the desktop is subscribed to anything, and on a Windows running the
   * touch keyboard or the text services that is always yes — so every
   * commit walked and diffed the window for a mirror nobody read. A client
   * that comes back after a quiet spell is noticed on its first read and
   * asks for a fresh push (`wanted`). `global` keeps the desktop-wide answer
   * for a focus change and an announcement: a client subscribed to focus
   * events reads the focused element the moment it hears of it, before
   * any read of ours could say it was there.
   *
   * With one exception, which is what makes the gate safe: **every window is
   * pushed once regardless.** A client's first `WM_GETOBJECT` has to find a
   * tree, and it arrives before anything in this process knows a client
   * exists. After that first push the mirror is live, and a client attaching
   * later asks for a fresh one (`uia-wanted`).
   */
  flush({ force = false, global = false } = {}) {
    if (this.dead || this._dirty.size === 0) return;
    const perWindow =
      !force && !global && typeof this._native.uiaActive === 'function';
    const listening = force || (!perWindow && this._native.uiaListening());
    const windows = [...this._dirty];
    this._dirty.clear();
    for (const win of windows) {
      const wnd = this._windowOf(win);
      if (!wnd) {
        // Windows are created asynchronously here, so the tree mounts and
        // commits before its HWND exists. Kept dirty rather than dropped —
        // dropping it was a real bug: the one push a window is owed happened
        // against nothing and was never retried.
        this._dirty.add(win);
        continue;
      }
      if (
        !listening &&
        this._pushed.has(wnd.id) &&
        !(perWindow && this._native.uiaActive(wnd.id))
      ) {
        continue;
      }
      this._pushed.add(wnd.id);
      this._push(win);
    }
  }

  /** A commit's push, at most once per `COMMIT_PUSH_MS`. */
  _commitFlush() {
    if (this.dead || this._dirty.size === 0) return;
    const now = performance.now();
    const wait = this._lastCommitPush + COMMIT_PUSH_MS - now;
    if (wait <= 0) {
      this._lastCommitPush = now;
      this.flush();
      return;
    }
    if (this._trailing) return;
    this._trailing = setTimeout(() => {
      this._trailing = null;
      this._lastCommitPush = performance.now();
      this.flush();
    }, wait);
    this._trailing.unref?.();
  }

  /** A window's HWND exists now, so what is owed for it can be pushed. */
  windowReady(wnd) {
    const win = this.toplevels.find((w) => w.window === wnd);
    if (!win) return;
    this._dirty.add(win);
    this.flush();
  }

  /**
   * A client just asked this window for its automation tree.
   *
   * It is the one moment worth building one on: the client is attaching now,
   * and whatever the mirror holds is from the last commit, which for an idle
   * application may be minutes old.
   */
  wanted(windowId) {
    const win = this.toplevels.find((w) => this._windowOf(w)?.id === windowId);
    if (!win) return;
    this._dirty.add(win);
    this.flush({ force: true });
  }

  /** The toplevel a node is under, or null. */
  _toplevelOf(node) {
    const root = node?.isWindow ? node : node?.root;
    return root && this.toplevels.includes(root) ? root : null;
  }

  _touch(node) {
    const win = this._toplevelOf(node);
    if (win) this._dirty.add(win);
  }

  // ---- what the shell asks for ------------------------------------------

  /**
   * A screen reader asked for something to happen: a button invoked, a
   * checkbox toggled, a value set, focus moved.
   *
   * These are *requests*. The tree owns the state, so each one goes through
   * the same path a click or a keystroke goes through — `_activate` is what
   * `events.js` runs for an AT's `DoAction` on the other backend, and the
   * comment there says the two must not drift.
   */
  action(event) {
    const id = Number(event.a ?? 0);
    const what = String(event.text ?? '');
    const node = this._nodeById(id);
    if (!node || node.destroyed) return;
    if (TRACE) trace(`action ${what} on ${id}`);

    if (what === 'focus') {
      node.root?.events?.focus?.(node, 'script');
      return;
    }
    if (what === 'invoke' || what === 'toggle') {
      // The same synthetic click the AT-SPI bridge's `DoAction("activate")`
      // runs, from the same helper on purpose: `events.js` says the two must
      // not drift, and a second activation path is exactly how they would.
      if (node.a11yOwner) {
        synthesizeClick(node.a11yOwner, node.abs);
      } else {
        synthesizeClick(node, node.abs);
      }
      return;
    }
    if (what.startsWith('value:')) {
      const text = what.slice('value:'.length);
      if (typeof node._setValueFromA11y === 'function') {
        node._setValueFromA11y(text);
      } else if (isNativeTextControl(node)) {
        node.props?.onChange?.({ target: node, value: text });
      }
      return;
    }
    if (what.startsWith('range:')) {
      const value = Number(event.b ?? NaN);
      if (Number.isFinite(value)) {
        node.props?.onValueChange?.(value) ?? node.props?.onChange?.(value);
      }
    }
  }

  _nodeById(id) {
    // Ids are handed out from a WeakMap, so there is no reverse index to
    // keep: the snapshot map has every id the mirror knows, and the tree is
    // walked to find the node it belongs to. Actions are rare — a person
    // clicking through a screen reader — and a reverse map of strong
    // references would keep unmounted nodes alive.
    for (const win of this.toplevels) {
      const found = this._find(win, id);
      if (found) return found;
    }
    return null;
  }

  _find(node, id) {
    if (this._ids.get(node) === id) return node;
    for (const kid of a11yChildren(node)) {
      const found = this._find(kid, id);
      if (found) return found;
    }
    return null;
  }

  // ---- wiring into the renderer -----------------------------------------

  install() {
    hooks.rootMounted = (win) => {
      if (this.toplevels.includes(win)) return;
      this.toplevels.push(win);
      this._dirty.add(win);
    };
    hooks.rootUnmounted = (win) => {
      const at = this.toplevels.indexOf(win);
      if (at === -1) return;
      this.toplevels.splice(at, 1);
      this._dirty.delete(win);
    };
    hooks.attached = (parent) => this._touch(parent);
    hooks.detach = (parent) => this._touch(parent);
    hooks.propsChanged = (node) => this._touch(node);
    hooks.textContent = (chunk) => this._touch(chunk.parent ?? chunk);
    hooks.textState = (node) => this._touch(node);
    hooks.focus = (previous, next) => {
      const win = this._toplevelOf(next ?? previous);
      if (!win) return;
      this._dirty.add(win);
      // Pushed now rather than at the next commit: a focus change is what a
      // screen reader is waiting for, and the event has to follow an update
      // that already carries the new state or the client reads the old one.
      this.flush({ global: true });
      const wnd = this._windowOf(win);
      if (wnd && next) this._native.uiaFocusChanged(wnd.id, this._idOf(next));
    };
    hooks.windowFocus = (win) => this._dirty.add(win);
    hooks.commit = () => this._commitFlush();
    hooks.announce = (text, opts) => {
      const win =
        this.toplevels.find((w) => w.events?.windowFocused) ??
        this.toplevels[0] ??
        null;
      const wnd = this._windowOf(win);
      if (!wnd) return false;
      // The window must be in the mirror before anything can be announced
      // from it, which on the first announcement of a session it may not be.
      this._dirty.add(win);
      this.flush({ global: true });
      return Boolean(
        this._native.uiaAnnounce(wnd.id, String(text), !opts?.assertive),
      );
    };

    // Toplevels that mounted before this was installed.
    this._unsubscribes.push(
      onApp((app) => {
        for (const win of app._rootChildren ?? []) hooks.rootMounted(win);
      }),
    );
  }

  bury() {
    if (this.dead) return;
    this.dead = true;
    if (this._trailing) clearTimeout(this._trailing);
    this._trailing = null;
    for (const key of Object.keys(hooks)) hooks[key] = null;
    for (const unsubscribe of this._unsubscribes) unsubscribe();
    this._unsubscribes = [];
  }
}

function trace(line) {
  process.stderr.write(`react-x11 win32: a11y ${line}\n`);
}

/**
 * Start the bridge for an app whose backend has a UIA provider.
 *
 * Returns null where the bridge cannot be used, which `startA11y()` reads as
 * "climb no further" — the same contract `atspi.js`'s `start()` keeps.
 */
export function startWin32Accessibility(app) {
  if (typeof app?._native?.uiaUpdate !== 'function') return null;
  const bridge = new Win32Accessibility(app);
  bridge.install();
  app._a11y = bridge;
  return bridge;
}

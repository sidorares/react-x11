// Where a `<ThemeProvider>` meets the windows. At the root of the tree: what
// the container holds — top-level windows and popups — and the node a
// provider written above them becomes. And directly inside a window: the box
// a provider becomes there, which passes a nested window on to that window.

import { hooks as a11yHooks } from '../a11y.js';
import { baseTheme } from '../palette.js';
import { BoxNode } from './box.js';
import { THEME_SCOPE } from './kinds.js';
import { Node } from './node.js';

/**
 * Put `node` at the top of the tree: realize a window against the screen
 * root, and record it among the container's top-level windows — the list
 * every "which windows does this app have" question reads
 * (`app._rootChildren`). A theme scope puts its windows there instead of
 * itself, so the list stays one of windows.
 *
 * Idempotent, because React reorders a keyed list at the root by inserting
 * a child that is already mounted: a second entry for the same window would
 * be a window counted twice, and announced to assistive technology twice.
 */
export function attachTopLevel(app, node) {
  if (node.isThemeScope) {
    node._attach();
    return;
  }
  // realize the whole subtree top-down against the screen root
  if (!node.window) node.realize(null);
  // React's getPublicRootInstance answers from the root fiber's first
  // child, and only when that child is a host component. `render()` wraps
  // the tree in a context provider, which is not one, so it would answer
  // null — the container keeps the list instead.
  const roots = (app._rootChildren ??= []);
  if (roots.includes(node)) return;
  roots.push(node);
  a11yHooks.rootMounted?.(node);
}

/** Take `node` back off the top of the tree, before its subtree is
 * destroyed — the bridge reads the subtree to say what went. */
export function detachTopLevel(app, node) {
  if (node.isThemeScope) {
    node._detach();
    return;
  }
  const roots = app._rootChildren;
  const at = roots ? roots.indexOf(node) : -1;
  if (at !== -1) roots.splice(at, 1);
  a11yHooks.rootUnmounted?.(node);
}

/**
 * `<ThemeProvider>` above the windows (#584).
 *
 * A provider has to put its palette on a node, because a `$token` resolves by
 * walking the node tree and knows nothing about React context. Inside a window
 * that node is a `<box>`. At the root it cannot be — nothing drawn can be
 * there, and a window cannot be inside a box — so the provider used to put
 * the palette on the windows it could see among its children instead. It
 * could only see literal `<window>` elements: a component that renders one,
 * a window that is closed, a fragment of two, all planted a box at the root.
 *
 * This is the node for that position. It draws nothing, lays nothing out and
 * holds only windows, popups and other scopes, and the windows under it take
 * their palette from it: a top-level window keeps **no parent** — a window
 * with a parent is a nested one to everything that asks, the accessibility
 * bridge first — and reads the scope through `_scope` instead
 * (`Node.theme`).
 *
 * The scope itself is never in `app._rootChildren`; its windows are, from
 * the moment it is attached to the container (`attachTopLevel`).
 */
export class ThemeScopeNode extends Node {
  constructor(props, app) {
    super(THEME_SCOPE, props, app, { yoga: false });
    this.isThemeScope = true;
    // the scope this one is written inside, when providers nest at the root
    this._scope = null;
    // in the container: its windows are realized and on the root list
    this._attached = false;
    // React's hide (`<Suspense>`, `<Activity>`), which lands on the topmost
    // host instance under the boundary — this, when the provider is there
    this._reactHidden = false;
  }

  /**
   * The palette the windows under this scope inherit: this scope's own
   * `theme` over the scope around it, or over the desktop's palette.
   *
   * Not cached, unlike `Node.theme`. Nothing tells a scope that the
   * desktop's palette moved — `appearanceChanged` walks the windows — and a
   * cached merge would hand them the old base. Each window caches what it
   * read, so this runs once per window per theme change.
   */
  get theme() {
    const inherited = this._scope ? this._scope.theme : baseTheme();
    const own = this.props.theme;
    return own ? { ...inherited, ...own } : inherited;
  }

  insertBefore(child, beforeChild) {
    const from = this.children.indexOf(child);
    if (from !== -1) this.children.splice(from, 1);
    const before =
      beforeChild == null ? -1 : this.children.indexOf(beforeChild);
    this.children.splice(
      before === -1 ? this.children.length : before,
      0,
      child,
    );
    // a keyed reorder: the child is already linked, themed and attached
    if (from !== -1) return;
    child._scope = this;
    // Built while detached, the subtree resolved its tokens against the
    // desktop's palette; this is the attach walk that re-resolves them, the
    // same one `Node.insertBefore` runs — a mount, so it claims no damage.
    child._themeChanged(true);
    if (this._hiddenByReact()) child._applyHidden();
    if (this._attached) attachTopLevel(this.app, child);
  }

  removeChild(child) {
    const at = this.children.indexOf(child);
    if (at === -1) return;
    this.children.splice(at, 1);
    if (this._attached) detachTopLevel(this.app, child);
    child._scope = null;
    child.destroySubtree();
  }

  applyProps(newProps, oldProps) {
    const before = oldProps ?? this.props;
    this.props = newProps;
    // A swap walks the windows as a live change, which repaints them. The
    // `style` a provider passes lays out a box inside a window and means
    // nothing here: a direction it names is in the palette as well, which
    // is what a window reads its direction from.
    if (newProps.theme !== before.theme) this._themeChanged();
  }

  setHidden(hidden) {
    this._reactHidden = hidden;
    this._applyHidden();
  }

  /** The hidden state above the windows moved: each one re-derives its own. */
  _applyHidden() {
    for (const child of this.children) child._applyHidden();
  }

  /** Whether React hides this scope, here or at a scope around it. */
  _hiddenByReact() {
    return this._reactHidden || (this._scope?._hiddenByReact() ?? false);
  }

  _attach() {
    this._attached = true;
    for (const child of this.children) attachTopLevel(this.app, child);
  }

  _detach() {
    this._attached = false;
    for (const child of this.children) detachTopLevel(this.app, child);
  }
}

/**
 * `<ThemeProvider>` written directly inside a `<window>` (or a `<popup>`).
 *
 * There it is a box that fills its parent, like a provider anywhere else in
 * a window — but a window may nest windows, and a provider wrapped around one
 * has to hand it on, since a window cannot live inside a box. So a nested
 * window put under this box is **passed through** to the window the box is
 * in: that window holds it, realizes and stacks it the way it does any
 * nested window, and the window reads its palette from here through
 * `_scope`, which a palette lookup asks before the parent (`Node.theme`).
 *
 * React still sees the window as this box's child, so the calls it makes on
 * the box for that window — a move, a removal — are forwarded as well, and
 * the box answers for the passed windows in the three things it owns over its
 * subtree: a theme swap, a hide, and its own removal.
 *
 * Only here. Under a provider that is inside a `<box>` there is no window to
 * pass a window to, and `Node.insertBefore` says so.
 */
export class ThemeBoxNode extends BoxNode {
  constructor(props, app) {
    super(props, app);
    // the nested windows React put under this box, in the order it did
    this._windows = [];
  }

  insertBefore(child, beforeChild) {
    if (!child.isWindow || child.isPopup) {
      super.insertBefore(child, beforeChild);
      return;
    }
    if (!this._windows.includes(child)) {
      this._windows.push(child);
      child._scope = this;
    }
    // Before the box is in its window the window waits here, and `_setRoot`
    // passes it on at the attach. A move is re-inserted at the end: nested
    // windows stack among themselves, not among the box's drawn children.
    if (this.parent) this.parent.insertBefore(child, null);
  }

  removeChild(child) {
    const at = this._windows.indexOf(child);
    if (at === -1) {
      super.removeChild(child);
      return;
    }
    this._windows.splice(at, 1);
    // the window destroys it, and takes it off its stacking list
    if (child.parent) child.parent.removeChild(child);
    else child.destroySubtree();
    child._scope = null;
  }

  _setRoot(root) {
    const attaching = this.root !== root;
    super._setRoot(root);
    if (!attaching || !this.parent) return;
    for (const win of this._windows) {
      if (win.parent !== this.parent) this.parent.insertBefore(win, null);
    }
  }

  _themeChanged(mounting = false) {
    super._themeChanged(mounting);
    for (const win of this._windows) win._themeChanged(mounting);
  }

  setHidden(hidden) {
    super.setHidden(hidden);
    for (const win of this._windows) win._applyHidden();
  }

  /** React hid this box — the hide a `<Suspense>` around the provider
   * lands on, which the windows passed on from here have to follow. */
  _hiddenByReact() {
    return this.hidden;
  }

  destroySubtree() {
    super.destroySubtree();
    // React removes the box alone, never the windows under it, so they go
    // with it — out of the window that holds them, which is each one's
    // parent (the box's own is already cleared by now), unless that window
    // is being destroyed itself and is walking its children as it does.
    for (const win of this._windows) {
      const holder = win.parent;
      if (holder && !holder.destroyed) holder.removeChild(win);
      else if (!win.destroyed) win.destroySubtree();
    }
  }
}

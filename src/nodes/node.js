// The retained node tree's base class: one lightweight JS node per host
// element, one yoga node per drawn element, painted into the owning
// <window>'s single 2d context on ntk's frame clock. Only <window> owns a
// real X11 window (see NEXT_STEPS.md §4 for the rationale).
//
// This file is what every node is: construction, props, the child list and
// its yoga tree, focus and the default actions. The rest of Node lives with
// the concern each method serves — styling.js, cascade.js, layout.js,
// paint.js and the others beside this file — and installMethods() at the
// bottom puts it on the prototype. install.js explains the arrangement.

import {
  applyLayoutStyle,
  applyLayoutDefaults,
  createLayoutNode,
  paintPropsChanged,
  isEventProp,
} from '../styles.js';
import { Yoga } from '../yoga.js';
import { isPlaced } from '../layouts.js';
import { synthesizeClick } from '../events.js';
import { hasDropProps } from '../dnd.js';
import {
  hooks as a11yHooks,
  devCheckA11yProps,
  hasClickHandler,
} from '../a11y.js';
import { XK_RETURN, XK_KP_ENTER, XK_SPACE } from '../keysyms.js';
import { dropVisibleSelection, selectionSurfaceOf } from '../textselection.js';
import { NodeAnimation } from './animation.js';
import { NodeBoxPaint } from './boxpaint.js';
import { NodeCascade } from './cascade.js';
import { NO_DAMAGE } from './damage.js';
import { NodeHitTest } from './hittest.js';
import { installMethods } from './install.js';
import { NodeInvalidate } from './invalidate.js';
import { CUSTOM_SELF_DAMAGED } from './kinds.js';
import { NodeLayout } from './layout.js';
import { NodeLayoutHost } from './layouthost.js';
import { NodePaint } from './paint.js';
import { NodePosition } from './position.js';
import { NodeQueries } from './queries.js';
import { NodeScrollBlit } from './scrollblit.js';
import { NodeSelectable } from './selectable.js';
import { NodeStyling } from './styling.js';
import { DEV } from './util.js';

// DevTools' measureHostInstance dereferences instance.ownerDocument
// unconditionally once getClientRects exists; a null documentElement and
// defaultView give it zero scroll offsets and no crash.
export const DEVTOOLS_FAKE_DOCUMENT = {
  documentElement: null,
  defaultView: null,
};

// And the default for the other declaration: an element that has not said
// otherwise claims nothing for itself, so every prop it holds is core's to
// be conservative about.
const NO_SELF_DAMAGED = new Set();

/** The half of `Node._joinsYoga` that is about the child alone — a real X
 * window (`<window>`, `<popup>`) or a node built without a box at all (a text
 * chunk) sits outside whatever parent it lands in. This is what
 * `_nonYogaKids` counts, so the count stays right for a parent that has no
 * box of its own either. */
const outsideYoga = (child) => !child.yoga || child.isWindow;

export class Node {
  get ownerDocument() {
    return DEVTOOLS_FAKE_DOCUMENT;
  }

  constructor(kind, props, app, { yoga = true } = {}) {
    this.kind = kind;
    this.props = props;
    this.app = app;
    this.parent = null;
    this.children = [];
    // Where this node sits in `parent.children`, and how many of *this*
    // node's children sit outside its yoga tree. Both are bookkeeping that
    // turns the scans `insertBefore` used to do over the whole child list
    // into constant work, which is what stops a commit that mounts a
    // virtualized list's window from costing O(rows x pane) (issue #397).
    // The index is a hint — `_indexOfChild` proves it before using it — and
    // the count is exact, maintained by the three places `children` is
    // spliced.
    this._childIndex = -1;
    this._nonYogaKids = 0;
    // The pre-mutation bounds this frame already claimed for this node, so
    // that a second mutation reuses the rect instead of walking the subtree
    // again. Lives exactly as long as membership in `root._reflowed`.
    this._reflowBefore = null;
    // The automatic minimum size (#249), cached per node: what this node
    // contributes to the box around it on each axis (`contentSpan`), the
    // width the height was measured for (`probeHeightFloors`), and the
    // floor yoga currently holds from us on each axis (`writeFloors`).
    // `undefined` on an extent means it has to be measured again; `null`
    // on a written floor means yoga's minimum may not be ours any more.
    this._floorW = undefined;
    this._floorH = undefined;
    this._floorAtW = undefined;
    this._floorMinW = undefined;
    this._floorMinH = undefined;
    // the width mode yoga last measured this leaf in with no height on
    // offer — the question `_heightForWidth` repeats
    this._floorMeasureMode = null;
    this.root = null; // owning WindowNode once attached
    this.hidden = false;
    // Composited on a layer of its own above the window's bitmap, by a
    // presenter that can (src/cocoa/promotion.js): the paint walk leaves a
    // hole where it is, and the presenter draws it — the `<glarea>` idiom.
    this._promoted = false;
    this.destroyed = false;
    // absolute rect within the owning window, filled by absolutize()
    this.abs = { x: 0, y: 0, width: 0, height: 0 };
    // node states that style blocks can react to, owned by EventManager
    this.states = {
      ':hover': false,
      ':focus-within': false,
      ':focus': false,
      ':focus-visible': false,
      ':active': false,
      ':drag-over': false,
      ':dragging': false,
    };
    // in-flight animations: prop -> {from, to, start, duration}. Transitions
    // delete themselves as they land; a loop entry (`loop: true`) is removed
    // by `_updateLoops` and by nothing else
    this._anim = null;
    // False until the first frame places this node (`absolutize`). Read by
    // `_retarget`: a style can be re-resolved several times between
    // construction and that first frame — the attach-time theme merge is the
    // common one, replacing a detached resolution against the desktop
    // palette with one against the app's own — and none of those is a
    // *change* the user saw, so no transition may start from it.
    this._placed = false;
    // the loops this node's style declares, whether or not they are running
    this._loops = null;
    // `resolvedTextStyle()`'s cache: this node's own text style over what it
    // inherits. Undefined means "never asked", which is load-bearing — see
    // `_retext`
    this._resolvedText = undefined;
    // `inheritedTextStyle`'s cache at a *scale boundary* — a node whose
    // `scale` prop puts it in a different unit from its parent, so the
    // device size it inherits has to be re-expressed. Null everywhere else,
    // which is every node in a tree with no `scale` prop in it.
    this._textScaled = null;
    // `direction`'s cache, same contract as `_resolvedText`'s: undefined means
    // "never asked", which is what lets `_redirectSubtree` stop at a node
    // nothing below has resolved through
    this._direction = undefined;
    // hot pointer-path caches (issue #188): the children in paint order,
    // re-verified against the live children on every read, and the
    // subtree's hit reach, invalidated through _clearHitBounds()
    this._paintOrderCache = null;
    this._hitBoundsCache = null;
    // a `$token` the theme does not define, held for `commitMount` to throw
    // on this node's own fiber — see `_tokenProblem`. Strict mode only.
    // `null` is "commitMount is still to come", `false` is "it has been and
    // gone", and an Error is one waiting for it
    this._tokenError = null;
    // `'@container …'` blocks (styles.js), on the nodes that carry them and
    // null on every other node: the style the record was built for, the
    // container names it asks about (`''` for the unnamed ones), the sizes
    // and answers the blocks last resolved to, and the pin an oscillating
    // design is held at — see WindowNode._resolveContainerQueries. Before
    // `_syncStyle`, which reads and writes it.
    this._cq = null;
    // A position placed after layout (`sticky`, or one registered with
    // `registerPosition`): the paint reach this node was left at by the last
    // pass that placed it — where its pixels are, which the next placement
    // claims when it moves them (WindowNode._placeNodes) — the request its
    // style resolved to, cached per style, and the definition that threw,
    // which is not asked again until the style names another. Null on every
    // node without one.
    this._placedShown = null;
    this._placementCache = null;
    this._placementFailed = null;
    // A layout algorithm (`layout`, docs/styling.md "Custom layouts"): the
    // host state on a node that arranges its children with one — its
    // children are yoga trees of their own then, and it a measured leaf —
    // and, on each of those children, where the last placement put its
    // margin box from the host's border box, whether it is one of the
    // absolutely positioned ones, the handle the algorithm is given for it
    // and its `layoutItem` resolved. Null everywhere else.
    this._host = null;
    this._hostSlot = null;
    this._hostAbsolute = false;
    this._handle = null;
    this._itemCache = null;
    // …and the sizes the algorithm was told it takes, for as long as nothing
    // inside it changes — it asks the same questions every run, several runs
    // a frame — and whether a placement ever gave it less height than its
    // content, which from then on keeps its height floors measured
    this._hostSizes = null;
    this._hostSqueezed = false;
    // the rect its tree was last laid out at by a placement, while nothing
    // has laid it out since — the next placement at the same rect has
    // nothing to do
    this._hostLaidAt = null;
    // the layout that threw, with the style value that named it: flexbox
    // until the style names a different one
    this._layoutAbandoned = null;
    this._syncStyle(props);
    this.yoga = yoga ? createLayoutNode() : null;
    if (this.yoga) {
      applyLayoutDefaults(this.yoga);
      applyLayoutStyle(this.yoga, this.style);
      // An element with a size of its own says so by implementing
      // `measureContent`, and the base class is what wires it to layout —
      // so a third-party element reaches everything that asks a leaf for its
      // size, including the content floor `minWidth: 'auto'` is measured
      // with (#248), without knowing either of them exists.
      if (typeof this.measureContent === 'function') this._useMeasureContent();
      if (this.style.layout != null || this.style.display === 'grid') {
        this._syncLayoutHost();
      }
    }
    // the document selection: the state when this element is a `selectable`
    // surface, and the part of somebody else's that lands on this one
    this._textSelection = null;
    this._selRange = null;
    // an element with a selection of its own — `<textinput>` — whose subtree
    // a document around it skips whole rather than lighting up half of what
    // the user is editing
    this.hasOwnSelection = false;
    this._syncSelectable(props);
    if (DEV) devCheckA11yProps(this);
  }

  get isWindow() {
    return this.kind === 'window';
  }

  /**
   * Prop names whose damage this element's own `applyProps` claims, and
   * which `paintChanged` therefore does not claim the whole node for.
   *
   * Empty for everything that has not said otherwise, which is what keeps
   * the default conservative. Registered elements declare theirs to
   * `registerElement`, so the common case needs no subclass; an element
   * whose answer depends on the *values* rather than the names overrides
   * `paintChanged` instead.
   */
  get selfDamagedProps() {
    return CUSTOM_SELF_DAMAGED.get(this.kind) ?? NO_SELF_DAMAGED;
  }

  /** Number of yoga-bearing children before `index` (window children and
   * text spans/chunks do not join the parent's yoga tree). */
  _yogaIndexAt(index) {
    // A list of ordinary boxes — a scroll pane's rows, which is the list
    // this is asked about a hundred times in one commit — has every child in
    // the yoga tree, and then the yoga index *is* the child index. Counting
    // the exceptions as they arrive turns that answer into a read instead of
    // a walk of every sibling in front of the new row (issue #397).
    if (this._nonYogaKids === 0) return index;
    let n = 0;
    for (let i = 0; i < index; i++) {
      if (this._joinsYoga(this.children[i])) n++;
    }
    return n;
  }

  _joinsYoga(child) {
    return Boolean(
      this.yoga && child.yoga && !child.isWindow && this._host === null,
    );
  }

  /**
   * Where `child` sits in `this.children`.
   *
   * The cached slot is checked rather than trusted: a node appears in the
   * list once, so `children[i] === child` *is* the proof that `i` is its
   * index, and a cache that has gone stale costs a scan rather than a wrong
   * answer. `_spliceChild` refreshes the two slots it knows — the child it
   * placed and the sibling it pushed along — which is what keeps a run of
   * inserts in front of the same trailing sibling (every virtualized list's
   * commit) off the scan entirely.
   */
  _indexOfChild(child) {
    if (this.children[child._childIndex] === child) return child._childIndex;
    const i = this.children.indexOf(child);
    child._childIndex = i;
    return i;
  }

  appendChild(child) {
    this.insertBefore(child, null);
  }

  /** Splice `child` in front of `beforeChild` (end of the list when that is
   * null), first taking it out of its old slot: React reorders a keyed list
   * by calling insertBefore with a child that is *already* mounted here, and
   * without the removal it would appear twice. Returns the new index. */
  _spliceChild(child, beforeChild) {
    // `parent === this` is the cheap form of "already in this list" — the
    // two are set and cleared together — so a child arriving for the first
    // time, which is every node of a freshly mounted subtree, pays no scan
    // at all for the question.
    const from = child.parent === this ? this._indexOfChild(child) : -1;
    if (from !== -1) this.children.splice(from, 1);
    else if (outsideYoga(child)) this._nonYogaKids++;
    const before = beforeChild == null ? -1 : this._indexOfChild(beforeChild);
    const index = before === -1 ? this.children.length : before;
    this.children.splice(index, 0, child);
    // The two slots this splice knows. Every other cached index at or after
    // `index` has shifted by one and will be caught by the check in
    // `_indexOfChild`; these two are the ones a run of inserts in front of
    // the same sibling asks about again on the very next call.
    child._childIndex = index;
    if (beforeChild != null) beforeChild._childIndex = index + 1;
    return index;
  }

  insertBefore(child, beforeChild) {
    if (child.isPopup) {
      // popups live anywhere in the JSX tree but are independent
      // override-redirect windows: bookkeeping only, no yoga, no paint —
      // but they do inherit the theme of where they are written
      const mounting = child.parent == null;
      this._spliceChild(child, beforeChild);
      child.parent = this;
      if (this.theme || child.props.theme) child._themeChanged(mounting);
      a11yHooks.attached?.(this, child);
      return;
    }
    if (child.isWindow) {
      throw new Error(
        `react-x11: <window> cannot be nested inside <${this.kind}>; ` +
          'windows may only appear at the root or inside another <window>.',
      );
    }
    // A registered element that declared childrenAllowed: false says so
    // here, rather than laying out a child that will never paint. The flag
    // is set on the instance by the registry, so this stays one property
    // read and src/nodes/ keeps not importing it.
    if (this._childrenAllowed === false) {
      throw new Error(
        `react-x11: <${this.kind}> takes no children (registered with ` +
          `childrenAllowed: false), but <${child.kind}> is inside it.`,
      );
    }
    // A node's size comes from its measure function or from its children,
    // never both — and yoga does not merely refuse the second one, it aborts
    // the WebAssembly module, which takes the process down naming nothing
    // the developer wrote. The built-ins reach it too: `<text>` is turned
    // away earlier by `createInstance`, which knows what its content is, but
    // `<image>`, `<svg>`, `<textinput>` and `<textarea>` arrive here.
    if (this._measureFn && this._joinsYoga(child)) {
      throw new Error(
        `react-x11: <${this.kind}> measures its own content, so it cannot ` +
          `contain <${child.kind}> — layout sizes such an element from its ` +
          `measure function and gives its children no say. Render <${child.kind}> ` +
          `beside it rather than inside it; or, if <${this.kind}> is meant to ` +
          'arrange children, remove its measureContent() and let flexbox size ' +
          'it from what is inside it.',
      );
    }
    // captured before the child joins, so it covers the arrangement that is
    // about to be replaced (see _childListChanged). A viewport mid-blit has
    // nothing vacating — the child being added had no pixels — and the
    // layout diff claims where it lands, so it names no region at all.
    const before = this._blitLedgerOpen() ? null : this._childListBefore();
    // a move has to leave the yoga tree too — yoga aborts on insertChild of
    // a node that still has a parent
    if (child.parent === this && this._joinsYoga(child)) {
      this.yoga.removeChild(child.yoga);
    }
    // no parent means never attached: this insert is a mount, and the theme
    // walk resolves without claiming — a keyed reorder arrives here too, with
    // its parent still set, and that one keeps the claims (issue #402)
    const mounting = child.parent == null;
    const index = this._spliceChild(child, beforeChild);
    child.parent = this;
    if (this._joinsYoga(child)) {
      this.yoga.insertChild(child.yoga, this._yogaIndexAt(index));
    } else if (this._host !== null && child.yoga && !child.isWindow) {
      // a layout's child is a tree of its own; a keyed reorder only moves
      // it in the list, which is the algorithm's to read
      if (mounting) this._adoptHostChild(child);
      this._markHostDirty();
    }
    child._setRoot(this.root);
    child._registerSizeQueries();
    // it can see its ancestors now, so any token in its style can resolve.
    // With no theme anywhere there is nothing to resolve and nothing to walk
    if (this.theme || child.props.theme) child._themeChanged(mounting);
    // …and the same for the scale: a subtree styled while detached resolved
    // against the app's, and only now can see the `scale` props above it.
    child._rescaleSubtree(mounting);
    this._textContentChanged();
    this._childListChanged(before);
    a11yHooks.attached?.(this, child);
  }

  /**
   * This node's paint bounds from before a child-list mutation — the `before`
   * half of `_childListChanged`'s protocol, captured while a departing child
   * is still attached.
   *
   * Walked once per node per frame rather than once per mutation. A commit
   * that mounts a virtualized list's window inserts a hundred rows into one
   * pane, one `insertBefore` at a time, and a walk of the whole pane per row
   * is what made that commit O(rows x pane) (issue #397).
   *
   * Reusing the first walk's answer is not an approximation. Nothing is laid
   * out or painted between two mutations in the same frame, so every child
   * still carries the rect it was last painted at, and a child that leaves
   * later in the frame was in the list — and so inside the rect — when the
   * first walk ran. `root._reflowed` is the marker for "this frame already
   * has one", which is exactly its lifetime: joined at the first claim,
   * cleared by `flush()`.
   */
  _childListBefore() {
    const root = this.root;
    // A subtree still being built off-tree claims nothing — this is the
    // `appendInitialChild` path, which is most of a mount, and where the
    // walk used to be thrown away by `_childListChanged`'s `!root` return.
    if (!root) return null;
    if (root._reflowed.has(this) && this._reflowBefore) {
      return this._reflowBefore;
    }
    // NO_DAMAGE, not null, when a blitting viewport above clips this node
    // away entirely (issue #398): null here would read as "somewhere" and
    // repaint the window.
    return (this._reflowBefore = this._claimBounds() ?? NO_DAMAGE);
  }

  /**
   * A child was inserted or removed. `before` is this node's paint bounds from
   * *before* the mutation, which the caller has to capture while the departing
   * child is still attached.
   *
   * The damage is this subtree before the mutation unioned with the same
   * subtree after layout. The second half is not measurable yet — an
   * inserted child has no rect until layout runs — so the node is queued
   * for the root to re-measure once it has. Siblings the reflow displaces
   * outside this subtree (this node growing taller, say) claim themselves
   * through the layout diff in flush(), which is what lets this claim stay
   * bounded without requiring the node's own size to be pinned.
   */
  _childListChanged(before) {
    // belt for a subtree attached imperatively with its rect already laid
    // out — nothing then re-runs _assignAbs to notice the reach grew
    this._clearHitBounds();
    const root = this.root;
    if (!root) return;
    // A viewport keeping a ledger this frame (issue #398) says both halves
    // of the protocol finer: `before` is the departing child's own rect
    // rather than this node's box, and the "after" half comes from the
    // shifted layout diff, which claims an entering child where it lands
    // and says nothing about the ones that only rode the scroll. Joining
    // `_reflowed` would undo both — its post-layout claim is this node's
    // box, the whole band the blit is about to move.
    if (this._blitLedgerOpen()) {
      root.invalidate(true, before ?? NO_DAMAGE, 'child-list');
      return;
    }
    root.invalidate(true, before, 'child-list');
    root._reflowed.add(this);
  }

  removeChild(child) {
    const index = this._indexOfChild(child);
    if (index === -1) return;
    // told while the child is still wired, so the bridge can compute the
    // index the AT will see the removal at
    a11yHooks.detach?.(this, child);
    // captured while the child is still attached, so it covers the rect the
    // child is about to stop occupying — the child's own, for a viewport
    // mid-blit, where this node's box is the whole scrolled band
    const before = this._blitLedgerOpen()
      ? (child._claimBounds() ?? NO_DAMAGE)
      : this._childListBefore();
    this.children.splice(index, 1);
    if (outsideYoga(child)) this._nonYogaKids--;
    if (this._joinsYoga(child)) {
      this.yoga.removeChild(child.yoga);
    } else if (this._host !== null && child.yoga && !child.isWindow) {
      if (child._hostAbsolute) {
        this._host.absolute.removeChild(child.yoga);
        child._hostAbsolute = false;
      }
      this._markHostDirty();
    }
    child.parent = null;
    child.destroySubtree();
    if (child.yoga && !child.isWindow) {
      child.yoga.freeRecursive();
      child.yoga = null;
    }
    this._textContentChanged();
    this._childListChanged(before);
  }

  /** Destroy real resources (X windows) in this subtree. Yoga nodes are
   * freed by the caller via freeRecursive on the subtree top. */
  destroySubtree() {
    this.destroyed = true;
    // a loop outlives nothing: the window drops it from the set that keeps
    // its frame clock alive, and stops watching visibility with the last one
    this.root?._forgetLoopNode(this);
    // …and out of the animating set in the same breath rather than on the
    // next tick, so a spinner that unmounts leaves the clock idle even if
    // nothing else ever asks for a frame
    this.root?._animating.delete(this);
    this.root?._opaqueNodes?.delete(this);
    // a surface that goes away takes its selection with it, and the app-wide
    // claim on being the one showing one goes with it too
    this._textSelection?.destroy();
    if (this.hasOwnSelection) dropVisibleSelection(this);
    for (const child of this.children) child.destroySubtree();
    // A layout host's children's trees are roots of their own, which the
    // `freeRecursive` that takes this node's box does not reach.
    if (this._host !== null) this._freeHostTrees();
  }

  _setRoot(root) {
    if (this.root === root) return;
    // a layout host is found through its window's registry, like a placed
    // node
    if (this._host !== null) {
      this.root?._layoutHosts?.delete(this);
      root?._layoutHosts?.add(this);
    }
    // an element answering `opaqueRect()` is one the window asks per pass
    const opaque = this.opaqueRect !== Node.prototype.opaqueRect;
    if (opaque) this.root?._opaqueNodes?.delete(this);
    this.root = root;
    if (opaque) root?._opaqueNodes?.add(this);
    // styled before it had a window, so this is where a placed node is
    // first registered (WindowNode._placeNodes)
    if (this.style && isPlaced(this.style)) root?._placedNodes?.add(this);
    // A node is styled in its constructor, before it has a window — so this
    // is where a loop declared by the very first style finds a frame clock
    // to run on.
    if (this._loops) this._updateLoops();
    for (const child of this.children) {
      if (!child.isWindow) child._setRoot(root);
    }
  }

  /** Called when descendant text content may have changed; overridden by
   * TextNode, forwarded upward by spans/chunks. */
  _textContentChanged() {}

  applyProps(newProps, oldProps) {
    const prev = this.props;
    const prevStyle = this.style;
    const themeChanged = newProps.theme !== prev.theme;
    this.props = newProps;
    if (themeChanged) this._themeChanged();
    // Ahead of the `_syncStyle` below, because the funnel that runs
    // multiplies by `this.scale` and this is what makes it read the new
    // factor. The walk restyles this node too, so the call after it hits
    // the identity check and costs nothing twice.
    if (newProps.scale !== prev.scale) this._rescaleSubtree();
    const style = this._syncStyle(newProps);
    let layoutChanged = false;
    // hoisted styles hit the identity check and skip the whole update
    if (this.yoga && style !== prevStyle) {
      layoutChanged = applyLayoutStyle(this.yoga, style, prevStyle);
    }
    if (Boolean(newProps.trapFocus) !== Boolean((oldProps ?? prev).trapFocus)) {
      this._syncFocusScope();
    }
    // and so does being a selection surface
    this._syncSelectable(newProps);
    // drop-target registration follows the props edge, like trapFocus
    if (hasDropProps(newProps) !== hasDropProps(oldProps ?? prev)) {
      const root = this.root;
      if (root?._registerDropTarget) {
        if (hasDropProps(newProps)) root._registerDropTarget(this);
        else root._forgetDropTarget(this);
      }
    }
    // This is how every React update arrives, so it is where partial
    // painting pays for itself. `applyLayoutStyle` has just told us whether
    // anything can have *moved*: if so, this subtree's before/after rects
    // plus the layout diff bound the frame; if not, this node's own region
    // bounds what changed — a new colour, a new label, a different border.
    // And if nothing it draws changed at all, it contributes no damage,
    // which is what keeps a commit from widening the region to every node
    // it touched.
    if (layoutChanged) {
      this._invalidateLayout('props');
    } else {
      // The style half is asked here rather than inside `paintChanged`, and
      // stays core's answer: what a style change moves is the background,
      // the border and the clip that `Node.paint` draws, so an element is
      // not in a position to excuse one.
      const styleChanged =
        style !== prevStyle && paintPropsChanged(style, prevStyle);
      this.root?.invalidate(
        false,
        styleChanged || this.paintChanged(newProps, prev) ? this : NO_DAMAGE,
        'props',
      );
    }
    if (DEV) devCheckA11yProps(this);
    a11yHooks.propsChanged?.(this);
  }

  /**
   * Did anything this node *draws* change? Answering true damages the whole
   * node; answering false contributes no damage at all.
   *
   * Deliberately conservative, because the cost of a wrong "no" is a stale
   * pixel that nothing will come back to fix. A prop that is not equal to
   * the one it replaced is "yes it changed", which is what makes the default
   * safe without knowing about subclasses: `<image src>`, `<canvas onDraw>`,
   * a `value`, a `placeholder`, a `caretColor` — any prop a subclass paints
   * from is a prop, so a change to it lands here as an inequality and damages
   * the node. Three kinds are skipped because they cannot affect this node's
   * own drawing:
   *
   *  - `children`, which the reconciler mutates through appendChild /
   *    removeChild / commitTextUpdate, each of which invalidates on its own;
   *  - event handlers, rebuilt every render and never painted;
   *  - `style`, compared by value by the caller — so a style object React
   *    rebuilt with the same contents costs nothing, which is the whole
   *    point, since React rebuilds sibling styles on every render and a
   *    commit would otherwise damage every node it walked.
   *
   * **The seam (issue #301).** "The node" is the wrong granularity for an
   * element that draws a *scene*: a graph view handed a new `nodes` array
   * every drag step has already claimed the box the dragged node moved
   * through, and this answering "yes" over the top widens that to the whole
   * pane and throws the scoped work away. Such an element either names those
   * props in `selfDamagedProps` — the declarative form, and what
   * `registerElement({ selfDamagedProps })` fills — or overrides this method
   * when the answer depends on the values rather than the names:
   *
   * ```js
   * paintChanged(next, prev) {
   *   // my own applyProps diffed these and claimed exactly what moved
   *   if (onlyPositionsMoved(next.nodes, prev.nodes)) return false;
   *   return super.paintChanged(next, prev);   // everything else is core's
   * }
   * ```
   *
   * An override that answers wrong shows stale pixels, so the part it does
   * not know about has to reach `super` — a new `aria-label`, a prop the
   * element grows next year.
   */
  paintChanged(newProps, prev) {
    const claimed = this.selfDamagedProps;
    const keys = new Set([...Object.keys(newProps), ...Object.keys(prev)]);
    for (const key of keys) {
      if (key === 'children' || key === 'style' || isEventProp(key)) continue;
      if (claimed.has(key)) continue;
      if (newProps[key] !== prev[key]) return true;
    }
    return false;
  }

  setHidden(hidden) {
    // claimed before the yoga flip so the bound covers the arrangement
    // being vacated; the reveal is the after-layout re-claim
    this._invalidateLayout('props');
    this.hidden = hidden;
    if (this.yoga) {
      this.yoga.setDisplay(
        hidden || this.style.display === 'none'
          ? Yoga.DISPLAY_NONE
          : Yoga.DISPLAY_FLEX,
      );
    }
    this._visibilityChanged(!hidden);
  }

  /**
   * Whether this subtree is on screen just changed, so focus has to follow
   * it — released when it goes, handed back when it returns. The rule and
   * the reasoning live on the focus manager (`subtreeHidden`, events.js);
   * this is the funnel every route to it comes through: the `hidden` flag
   * React sets for `<Suspense>`/`<Activity>`, and `display: 'none'` from a
   * style, a state block or a size query (`_retarget`).
   */
  _visibilityChanged(visible) {
    // Same rule, and the reason it shares this funnel: a loop inside a
    // subtree that just went off the screen is drawing frames for nobody,
    // whichever of the three routes hid it. Re-evaluated for the whole
    // window rather than for this subtree — the set is the handful of nodes
    // that declare an `animation`, and each one answers for itself.
    if (this.root?._loopNodes?.size) this.root._refreshLoops();
    const events = this._focusManager();
    if (!events) return;
    if (visible) events.subtreeRevealed(this);
    else events.subtreeHidden(this);
  }

  /**
   * Focus this node, as clicking it would: the owning window's focus moves
   * here, `onBlur` fires on whatever had it, `onFocus` here. Also pulls the
   * X input focus to the window if the window manager gave it away.
   */
  focus() {
    this._focusManager()?.focus(this);
    return this;
  }

  /** Give up focus, leaving the window with nothing focused. */
  blur() {
    const events = this._focusManager();
    if (events?.focused === this) events.focus(null);
    return this;
  }

  /** Whether this node has the owning window's focus. */
  get focused() {
    return this._focusManager()?.focused === this;
  }

  /** Whether focus is on this node or inside it — CSS `:focus-within`. A
   * `<popup>` counts as inside the node it hangs off in the JSX tree, which
   * is what a modal needs to know before taking focus itself. */
  get focusWithin() {
    const focused = this._focusManager()?.focused;
    return Boolean(focused) && this.contains(focused);
  }

  /** Whether `node` is this node or a descendant of it (DOM `contains`). */
  contains(node) {
    for (let n = node; n; n = n.parent) {
      if (n === this) return true;
    }
    return false;
  }

  /**
   * The text this element reports through `a11yTextState()` may have moved
   * — an edit, a caret move, a selection change, a composition (#257). The
   * same notification `<textinput>`'s `_repaint` makes, and the reason an
   * assistive technology hears a third-party editor at all: the state is
   * *pulled* when this says it is worth pulling.
   *
   * Free when nobody is listening — one property read, the hook slots being
   * null until a bridge or the test spy fills them — so an element may call
   * it on every edit without asking whether accessibility is on.
   */
  notifyA11yTextChanged() {
    a11yHooks.textState?.(this);
  }

  /**
   * The scene this element reports through `a11yScene()` has changed — an
   * item added or removed, one selected, the element's own cursor moved
   * onto another one (#304). The children an assistive technology is
   * holding are re-read and the difference announced.
   *
   * A scene that is a function of the props needs no call: a commit already
   * re-reads it. This is for everything the element does on its own —
   * a drag, an animation, its own arrow keys.
   *
   * Free when nobody is listening, the same one property read
   * `notifyA11yTextChanged()` costs.
   */
  notifyA11ySceneChanged() {
    a11yHooks.propsChanged?.(this);
  }

  /** Where focus for this node lives: its own window's EventManager, or —
   * inside a `<popup>`, which never receives the X input focus — the owner
   * window's (see EventManager.focusManager). */
  _focusManager() {
    return this.root?.events?.focusManager ?? null;
  }

  /** Register or drop this node's focus scope to match the `trapFocus` prop.
   * Idempotent: called at mount (commitMount) and on every prop update. */
  _syncFocusScope() {
    const events = this._focusManager();
    if (!events) return;
    if (this.props.trapFocus) events.pushScope(this);
    else events.popScope(this);
  }

  // The pointer and the keys a selection is made with. They are default
  // actions on the *base* class because the press lands on whatever is under
  // the pointer — a `<text>`, an `<image>`, the gap between two paragraphs —
  // and every one of them has to reach the surface above it. An element that
  // takes presses of its own overrides these and is, by that alone, not part
  // of a document; one that wants both calls `super`.
  defaultMouseDown(ev) {
    selectionSurfaceOf(this)?.press(ev);
  }

  defaultMouseDrag(ev) {
    selectionSurfaceOf(this)?.drag(ev);
  }

  defaultMouseUp(ev) {
    selectionSurfaceOf(this)?.release(ev);
  }

  /**
   * The selection keys, and then **Space or Enter on anything clickable**.
   *
   * A focusable node with an `onClick` used to take focus, draw a ring, be
   * reachable by Tab and be activatable by a screen reader — and do nothing
   * at all when the keyboard pressed it (issue #329). It looked operable and
   * was not, which is the failure mode a focus ring makes *worse*: the ring
   * is a promise. Every control an application builds out of a `<box>`
   * rather than out of `Button` had it, silently.
   *
   * It is the click itself, not a second definition of one: `synthesizeClick`
   * is the function an AT's `DoAction("activate")` already went through, so
   * a control that acts on the press hears the press either way and the two
   * paths cannot drift. The rule for *what* is activatable is the same one
   * the bridge writes down — there is an `onClick` here — minus the bridge's
   * role clause, which advertises an action to something that cannot press a
   * key (a11y.js, `hasClickHandler`).
   *
   * **One key rule, no role table.** The web gives `checkbox` Space and not
   * Enter, and a link Enter and not Space, because on the web those keys are
   * already spoken for — Space scrolls the page, Enter submits the form.
   * Neither is true here: a default action runs on the focused node, so the
   * scroll pane a row sits in never sees the row's Space, and there is no
   * implicit submit. All a role table could buy, then, is *fewer* keys
   * working on a control that draws a focus ring — which is the bug.
   *
   * The two ways out, both ordinary: `preventDefault()` in the element's own
   * `onKeyDown` (the seam an application uses — a `<box>` that wants Enter
   * for something else), and overriding this method (the seam an element
   * uses). A scroll pane that is *itself* clickable takes the third: its
   * `defaultKeyDown` answers Space with a page and never reaches here, so
   * paging keeps the key it has always had and Enter activates.
   */
  defaultKeyDown(ev) {
    this._textSelection?.keyDown(ev);
    if (ev.defaultPrevented) return;
    const enter = ev.keysym === XK_RETURN || ev.keysym === XK_KP_ENTER;
    // Space by either name: `XK_space` *is* code point 32 — a Latin-1 keysym
    // and its character are the same number — and both fields are read
    // because a synthetic event may carry only one of them, the way the
    // scroll keys next door read the keysym and every widget read the code
    // point. A key an open composition took reaches no default action at all.
    const space = ev.keysym === XK_SPACE || ev.codepoint === 32;
    if (!enter && !space) return;
    if (!hasClickHandler(this)) return;
    // consumed, said the way every default action says it: what it prevents
    // is the default action after this one
    ev.preventDefault();
    synthesizeClick(this, this.abs, ev.nativeEvent);
  }
}

// The rest of Node's methods live with the concern they serve, one file
// per concern; install.js explains the arrangement.
installMethods(
  Node,
  NodeStyling,
  NodeCascade,
  NodeQueries,
  NodeAnimation,
  NodeLayout,
  NodeLayoutHost,
  NodePosition,
  NodeHitTest,
  NodeInvalidate,
  NodeScrollBlit,
  NodePaint,
  NodeBoxPaint,
  NodeSelectable,
);

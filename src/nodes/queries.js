// Size and container queries (#470): the blocks a node's style declares,
// the container sizes they are answered against, and the passes a window
// spends settling them.

import {
  applyLayoutStyle,
  localTextStyleChanged,
  containerAnswers,
} from '../styles.js';
import { DEV } from './util.js';

/** How many extra layout passes a flush spends settling `@container` blocks
 *  before it takes the layout it has — see `_settleContainerQueries`. */
const CONTAINER_QUERY_PASSES = 3;

/** The sizes a node's container blocks were resolved against, as one
 *  comparable string — what a pinned node is held at. */
function containersKey(containers) {
  if (!containers) return '';
  let key = '';
  for (const name of Object.keys(containers)) {
    const c = containers[name];
    key += `${name}:${c.width}x${c.height};`;
  }
  return key;
}

/** Node's half of size and container queries, installed onto `Node.prototype` by node.js. */
export class NodeQueries {
  /** Join the owning window's size-query registry, and take the current
   * size into account — a node mounted after a resize has to match against
   * the size the window is now, not the one it started at. */
  _registerSizeQueries() {
    if (this._queried && this.root?._sizeQueryNodes) {
      this.root._sizeQueryNodes.add(this);
      if (this.root.querySize) this._sizeQueriesChanged();
    }
    if (this._supportsQueried && this.root?._supportsQueryNodes) {
      this.root._supportsQueryNodes.add(this);
      // a node mounted into a window that already knows its capabilities
      // has to match against those, not against the startup default
      this._sizeQueriesChanged();
    }
    if (this._wantsAttention && this.root?._attentionNodes) {
      this.root._attentionNodes.add(this);
    }
    if (this._cq !== null && this.root?._containerQueryNodes) {
      this.root._containerQueryNodes.add(this);
      // it can see the containers above it now — the constructor's
      // resolution had no ancestors to find one in
      this._sizeQueriesChanged();
    }
    for (const child of this.children) {
      if (!child.isWindow) child._registerSizeQueries();
    }
  }

  /**
   * The sizes this node's `@container` blocks resolve against: for each name
   * the style asks about, the nearest ancestor declaring it, in this node's
   * **logical** pixels — the unit the threshold beside `width: 400` was
   * written in, so the two numbers mean the same thing. Yoga's computed
   * size rather than `abs`: inside a flush, `abs` is still the previous
   * frame's.
   *
   * A container that has not been laid out yet contributes nothing, so its
   * blocks do not apply — the way a capability block does not before the
   * window exists: the fallback design is the one that works everywhere.
   * "Laid out" is `_placed` between frames and every attached node while
   * the window is settling a pass it just ran (`_cqFresh`); a fresh yoga
   * node answers NaN. Null when no container is known, which is the
   * identity `resolveQueries` keeps.
   */
  _containerSizes() {
    const names = this._cq?.names;
    if (!names) return null;
    let sizes = null;
    const s = this.scale || 1;
    const fresh = Boolean(this.root?._cqFresh);
    for (const name of names) {
      const c = this._containerFor(name);
      if (!c) {
        // In a window and nothing above declares one: a forgotten
        // declaration, not a component rendered outside its context — that
        // is what the *named* form is for, and a missing name applies
        // nothing quietly. `root` rather than `parent`: React builds a
        // subtree bottom-up, so a node can have a parent and no window yet,
        // and the container it will find is further up.
        if (DEV && name === '' && this.root) this._noContainer();
        continue;
      }
      if (!c.yoga || !(fresh || c._placed)) continue;
      const width = c.yoga.getComputedWidth() / s;
      const height = c.yoga.getComputedHeight() / s;
      if (!Number.isFinite(width) || !Number.isFinite(height)) continue;
      (sizes ??= {})[name] = { width, height };
    }
    return sizes;
  }

  /** `_containerSizes()`, unless this node is pinned at the sizes it is
   *  looking at — then the sizes its held answer came from, so a restyle
   *  arriving from React does not undo what the layout pass decided. */
  _pinnedContainerSizes() {
    const live = this._containerSizes();
    const cq = this._cq;
    const pin = cq.pin;
    if (!pin) return live;
    if (pin.key === containersKey(live)) return pin.containers;
    cq.pin = null;
    return live;
  }

  /**
   * The nearest ancestor whose style declares `container` — any container
   * for the unnamed query (`''`), the one carrying `name` otherwise, however
   * many nearer containers that reaches past. A window ends the walk after
   * offering itself, and a window asks nothing: a `<popup>` inside a
   * container is a root of its own and asks its own window with `@width`.
   *
   * Walked rather than cached: it is a dozen property reads per dependent
   * per layout pass, and a cache would have to follow every insert, every
   * reorder and every `container` value that changes above.
   */
  _containerFor(name) {
    if (this.isWindow) return null;
    for (let n = this.parent; n; n = n.parent) {
      const c = n.style?.container;
      if (name === '' ? c === true || typeof c === 'string' : c === name) {
        return n;
      }
      if (n.isWindow) break;
    }
    return null;
  }

  _noContainer() {
    this._tokenProblem(
      [
        `react-x11: <${this.kind}> has an "@container" block and no ` +
          'container above it — declare one with `container: true` in an ' +
          "ancestor's style (or name it and ask for it by name), or ask " +
          'the window with "@width"',
      ],
      true,
      'The block does not apply and the app carries on',
    );
  }

  /** Said once per node, in development: a design that cannot settle looks
   *  like a layout bug, and the frame it is pinned at is the only clue. */
  _warnContainerOscillation() {
    const cq = this._cq;
    if (cq.warned) return;
    cq.warned = true;
    const asked = [...(cq.names ?? [])]
      .map((n) => (n === '' ? 'its container' : `"${n}"`))
      .join(', ');
    console.warn(
      `react-x11: the "@container" blocks on <${this.kind}> cannot settle: ` +
        `a block that matches at one size of ${asked} changes that size to ` +
        'one where it no longer matches, and back. A container query must ' +
        'not move the size it asks about — give the container a size of its ' +
        'own, or minWidth: 0 and a flexBasis so its content cannot grow it. ' +
        'The current answer is held until the container moves for another ' +
        'reason (docs/styling.md#container-queries).',
    );
  }

  /** The owning window resized, the server's answer moved, or a layout pass
   * moved a container this node asks about: re-resolve, since a query block
   * may now match that did not, or the other way round. */
  _sizeQueriesChanged() {
    if (
      !(this._queried || this._supportsQueried || this._cq !== null) ||
      this.destroyed
    ) {
      return;
    }
    const before = this.style;
    // a query block may name `fontSize`, and `_syncStyle` → `_retarget` is
    // what pushes that into the subtree; only the node-local text props are
    // left to notice here
    this._syncStyle(this.props);
    if (localTextStyleChanged(this.style, before)) this._textContentChanged();
    if (this.yoga && this.style !== before) {
      // A block that moved a layout property changed the tree the content
      // floors were measured from — the debt a style change from React
      // leaves too (`invalidate`, reason 'props'). It has to be marked as a
      // *content* change: the live-resize deferral takes a plain
      // `_floorsDirty` for the drag itself and lays out against the floors
      // in hand, which are the old arrangement's, and by the time the
      // catch-up looks the dirty flags are spent and no leaf's height moved
      // — so the floor of a card that turned from a row into a column would
      // stay the row's, and yoga would squeeze the column down to it.
      if (applyLayoutStyle(this.yoga, this.style, before) && this.root) {
        this.root._floorsDirty = true;
        this.root._floorsContentDirty = true;
      }
    }
  }
}

/** WindowNode's half of size and container queries, installed onto `WindowNode.prototype` by window/window.js. */
export class WindowQueries {
  /**
   * Re-evaluate the size-query blocks for this window's current size, just
   * before laying out. This is the whole reason a size query may carry
   * layout properties while a state block may not: it only ever runs inside
   * a layout pass the resize already required.
   *
   * Callers pass the size in device pixels — it comes off the window or out
   * of yoga, and both live on the device grid — but `querySize` is stored
   * in **logical** pixels, because that is the unit the thresholds were
   * written in: `'@width >= 620'` sits in a style block next to `width:
   * 620`, and the same number must mean the same thing. At scale 1 the two
   * coincide, which is how comparing device pixels survived every 1x
   * display it was ever run on and broke on the first retina one (every
   * query read double, so none of them ever changed answer under a drag).
   */
  _resolveSizeQueries(deviceWidth, deviceHeight) {
    const s = this.scale || 1;
    const width = deviceWidth / s;
    const height = deviceHeight / s;
    if (this._sizeQueryNodes.size === 0) {
      this.querySize = this.querySize ?? { width, height };
      return false;
    }
    if (this.querySize?.width === width && this.querySize?.height === height) {
      return false;
    }
    this.querySize = { width, height };
    // a query block may carry layout properties, so the floors measured from
    // the styles it is replacing are not the answer any more
    this._floorsDirty = true;
    for (const node of [...this._sizeQueryNodes]) {
      if (node.destroyed) this._sizeQueryNodes.delete(node);
      else node._sizeQueriesChanged();
    }
    // Whether the layout may have moved under this, which is what an
    // auto-sizing pass needs to know: it resolves these against a size it is
    // still working out, and has to look again if the answer changed.
    return true;
  }

  /**
   * Resolve the `@container` blocks against the layout just produced, and
   * lay out again while an answer moves — a container's size is what a pass
   * *produces*, so it can only be asked about afterwards, and a block that
   * changed may carry layout properties. `relayout` is whatever pass the
   * caller runs: `_layoutStep` in a flush, `measure()` while an auto-sized
   * window is working out how big to be.
   *
   * Bounded. Two passes settle the common case (a block that matches at the
   * width the content took), and nested containers can honestly need a
   * third — an outer answer moving an inner container past one of its own
   * thresholds — so the cap is a small fixed number rather than "once".
   * What it must not do is chase a design no size satisfies; that is
   * detected per node inside `_resolveContainerQueries`, and pinned.
   */
  _settleContainerQueries(relayout) {
    if (this._containerQueryNodes.size === 0) return;
    const held = new Map();
    this._cqFresh = true;
    try {
      for (let pass = 0; pass < CONTAINER_QUERY_PASSES; pass++) {
        if (!this._resolveContainerQueries(held)) return;
        relayout();
      }
      if (DEV && this._resolveContainerQueries(held, false)) {
        console.warn(
          'react-x11: "@container" blocks did not settle in ' +
            `${CONTAINER_QUERY_PASSES} layout passes; the last one stands. ` +
            'More than two nested containers, each changing the next, is ' +
            'the shape that gets here (docs/styling.md#container-queries).',
        );
      }
    } finally {
      this._cqFresh = false;
    }
  }

  /**
   * One round of the above: every dependent whose blocks answer differently
   * against the containers as they are now is re-resolved, and the caller
   * hears whether any was. With `apply` false it only answers.
   *
   * `held` is what each node has answered so far this frame. A node that
   * comes back to an answer it already held is a design that oscillates —
   * the block moves the size it asks about, which CSS forbids by
   * construction (size containment) and yoga cannot — so it is **pinned**:
   * the answer it has stands, and stays until the container's size moves
   * for some other reason. Without the pin the next frame would find the
   * other answer, apply it, get the other size, and strobe on every layout.
   */
  _resolveContainerQueries(held, apply = true) {
    let changed = false;
    for (const node of [...this._containerQueryNodes]) {
      if (node.destroyed) {
        this._containerQueryNodes.delete(node);
        continue;
      }
      const cq = node._cq;
      const containers = node._containerSizes();
      const key = containersKey(containers);
      if (cq.pin) {
        if (cq.pin.key === key) continue;
        cq.pin = null;
      }
      const answers = containerAnswers(node._baseStyle, containers);
      if (answers === cq.answers) continue;
      if (!apply) return true;
      let seen = held.get(node);
      if (seen?.includes(answers)) {
        cq.pin = { key, containers: cq.containers };
        if (DEV) node._warnContainerOscillation();
        continue;
      }
      if (!seen) held.set(node, (seen = [cq.answers]));
      seen.push(answers);
      node._sizeQueriesChanged();
      changed = true;
    }
    // a block may carry layout properties, so the floors measured from the
    // styles it is replacing are not the answer any more — the same debt a
    // window query leaves (`_resolveSizeQueries`)
    if (changed) this._floorsDirty = true;
    return changed;
  }
}

// Transitions and loops: a style change retargeted into an animation, ticked
// on the window's frame clock or offloaded to the presenter, and the clock
// itself, which tests replace (setAnimationClock).

import {
  animationValueAt,
  animationsOf,
  sameAnimation,
  applyLayoutStyle,
  inheritedTextChanged,
  transitionFor,
  interpolate,
  ease,
  isLayoutProp,
  TEXT_LAYOUT_PROPS,
} from '../styles.js';
import { GRID_CONTAINER_PROPS, GRID_ITEM_PROPS } from '../grid.js';
import { isPlaced } from '../layouts.js';
import { desktopSettings, watchDesktopSettings } from '../desktopsettings.js';
import { watchWindowState, windowStateSnapshot } from '../windowstate.js';
import { shadowExtentOf } from './boxpaint.js';
import { inThemeWalk } from './cascade.js';
import { insetRect, intersectRects, outerPixels } from './rects.js';
import { shallowEqual } from './util.js';

/** How often a loop the clock runs is offered to a presenter again, at
 *  most (`_recheckLoops`): a check is a walk up the node's ancestors and
 *  along what is painted after it, and the loop is a frame every refresh
 *  for as long as it waits. */
const REOFFER_MS = 250;

/** The loopable properties that reach past the node's box without moving
 *  anything: a ring that grows draws further out than the node did. */
const REACH_PROPS = new Set(['outlineWidth', 'outlineOffset']);

/** Two values of a grid property that lay out the same: an inline
 *  `gridTemplateAreas` array is a new array every render. */
const sameGridValue = (a, b) =>
  a === b ||
  (Array.isArray(a) &&
    Array.isArray(b) &&
    a.length === b.length &&
    a.every((row, i) => row === b[i]));

/** Whether what a grid reads off its own style moved — the properties yoga
 *  never sees, so nothing else would ask the layout again. */
const gridContainerMoved = (was, now) =>
  GRID_CONTAINER_PROPS.some((prop) => !sameGridValue(was[prop], now[prop]));

/** …and off one of its children. */
const gridItemMoved = (was, now) =>
  GRID_ITEM_PROPS.some((prop) => was[prop] !== now[prop]);

// Frame timestamps for transitions. Indirected so tests can drive the clock
// instead of sleeping through real animations.
export let now = () => Date.now();
export function setAnimationClock(fn) {
  now = fn;
}

/** Node's half of transitions and loops, installed onto `Node.prototype` by node.js. */
export class NodeAnimation {
  /**
   * Point the node at a new resolved style. Properties with a `transition`
   * animate there from whatever is on screen right now — which is what makes
   * an interrupted transition reverse from where it got to, rather than
   * jumping to the end first. Everything else takes effect immediately.
   */
  _retarget(target) {
    const displayed = this.style;
    this._targetStyle = target;
    if (displayed === undefined || this.destroyed) {
      this.style = target;
      this._syncLoops(target);
      if (this._anim?.size) {
        this.style = { ...target, ...this._animatedValues() };
      }
      return this.style;
    }
    // Only for a node the user has seen (`_placed`): between construction
    // and the first frame a style is re-resolved several times — attach
    // merges the real theme over the detached resolution's desktop palette,
    // queries settle — and animating any of those would travel from a value
    // that was never on screen. An inserted element *appears* at its style;
    // transitions start on later changes, which is CSS's rule too.
    if (this._placed) {
      for (const prop of Object.keys(target)) {
        const to = target[prop];
        const from = displayed[prop];
        if (from === to || from === undefined) continue;
        const duration = transitionFor(target, prop);
        if (duration <= 0) continue;
        if (interpolate(from, to, 0.5) === null) continue; // no midpoint: snap
        const entry = {
          from,
          to,
          duration,
          // *now*, not the last frame's timestamp: between two user actions
          // the window is idle and draws nothing, so the previous frame can
          // be seconds old — and the first tick would then find the
          // transition already over and jump straight to the end
          start: now(),
        };
        const previous = this._anim?.get(prop);
        (this._anim ??= new Map()).set(prop, entry);
        // A presenter that can run it in the render server takes it here:
        // the node's style then goes straight to the target — the layer's
        // model value — and the one frame that sends it carries the
        // animation with it (src/cocoa/presenter.js). Declined, or with no
        // such presenter, the window's frame clock runs it as it always has.
        if (this._offload(prop, entry)) {
          entry.offloaded = true;
          this.root?.invalidate(false, this, 'animation');
        } else {
          // …and one the presenter had must not keep running underneath the
          // values the clock is about to write
          if (previous?.offloaded) this._cancelOffload(prop, previous);
          this.root?._startAnimating(this);
        }
      }
    }
    // After the transitions, before the style is assembled: a loop that just
    // arrived contributes a value to this very swap, so the first frame the
    // bar is on screen already has it where the animation says rather than
    // where the resting style does.
    this._syncLoops(target);
    this.style = this._anim?.size
      ? { ...target, ...this._animatedValues() }
      : target;
    // Placing is done by the window after each layout pass, which finds the
    // nodes through this registry. One that stops asking stays in it until
    // that pass has put it back where layout has it — and `position` being a
    // layout property, the change that stops it brings that pass along.
    if (isPlaced(this.style)) this.root?._placedNodes?.add(this);
    // A layout arrives, leaves or changes by the same funnel — a commit, a
    // size or container query, a token — so this is where the children are
    // handed to it or taken back. Before the node has a box (the constructor
    // styles it first) there is nothing to hand them from.
    // `display: 'grid'` is the same request under CSS's name for it.
    if (
      this.yoga &&
      (displayed.layout !== this.style.layout ||
        displayed.display !== this.style.display ||
        (this._host !== null && this._host.scale !== this.scale) ||
        ((this.style.layout != null || this.style.display === 'grid') &&
          displayed.overflow !== this.style.overflow))
    ) {
      this._syncLayoutHost();
    }
    // A grid reads its tracks off the style, where yoga never sees them, so
    // a change to one asks the algorithm again — and gives one that threw
    // another go. Asked of a layout host alone, the only node it acts on:
    // seven properties read off two styles of every shape is a scan every
    // node paid on each of the several swaps a mount makes, 3% of it.
    if (
      this.yoga &&
      (this._host !== null || this._layoutAbandoned !== null) &&
      gridContainerMoved(displayed, this.style)
    ) {
      if (this._host !== null) this._hostChanged();
      else if (this._layoutAbandoned !== null) {
        this._layoutAbandoned = null;
        this._syncLayoutHost();
      }
    }
    // …and a child of one tells it when what the algorithm reads of it moved
    const host = this.parent?._host;
    if (host != null) {
      if (
        !shallowEqual(displayed.layoutItem, this.style.layoutItem) ||
        gridItemMoved(displayed, this.style)
      ) {
        this.parent._hostChanged();
      }
      if (
        (displayed.position === 'absolute') !==
        (this.style.position === 'absolute')
      ) {
        this.parent._rehomeHostChild(this);
      }
    }
    // The paint reach reads the style now in force — a shadow's spread, an
    // outline's width — so it is dropped on every swap, here, before the
    // old-extent claims below measure the new reach against the old one.
    this._clearPaintBounds();
    // `hitSlop` feeds the cached hit reach and `overflow` decides where its
    // invalidation walks stop, so a swap that changes either clears here —
    // the one funnel every style path goes through. Animation ticks never
    // change them: neither interpolates, so both land on the target value
    // in this very swap, before any tick runs.
    if (
      displayed.hitSlop !== this.style.hitSlop ||
      displayed.overflow !== this.style.overflow
    ) {
      this._clearHitBounds();
    }
    // …and a node that just stopped being a scroll container has an offset
    // nothing will ever clamp again (see Scrollable._overflowChanged)
    if (displayed.overflow !== this.style.overflow) {
      this._overflowChanged?.(displayed.overflow);
    }
    // The same funnel is what keeps the text cascade honest: every route a
    // new style arrives by — a commit, a `:hover`, a size query, a token —
    // comes through here, so this is the one place that has to notice the
    // ink or the face moving and push it into the subtree.
    if (!inThemeWalk && inheritedTextChanged(this.style, displayed)) {
      this._retextSubtree();
    }
    // …and the same funnel is the only place a `direction` can arrive by. The
    // *layout* half of it went to yoga through `applyLayoutStyle`; this is
    // everything else that reads a side.
    if (!inThemeWalk && displayed.direction !== this.style.direction) {
      this._redirectSubtree();
    }
    // `display: 'none'` hides a subtree as completely as React's own flag
    // does, whether it arrived from a prop, a state block or a size query —
    // so focus leaves it by the same rule (`_visibilityChanged`).
    if ((displayed.display === 'none') !== (this.style.display === 'none')) {
      this._visibilityChanged(this.style.display !== 'none');
    }
    // A shadow that just got smaller — or went away — has to claim where it
    // *was*. Every claim downstream of here is bounded by `paintBounds()`,
    // which is computed from the style now in force, so a node that drops a
    // `:hover` shadow would repaint its own box and leave the shadow printed
    // around it. This is the only place both extents exist at once.
    if (displayed.boxShadow !== this.style.boxShadow) {
      const shrank =
        shadowExtentOf(displayed, this.scale) -
        shadowExtentOf(this.style, this.scale);
      if (shrank > 0) {
        this.root?.invalidate(
          false,
          insetRect(this.paintBounds(), -shrank),
          'shadow',
          this,
        );
      }
    }
    // An outline that just got smaller — or went away — owes the same debt,
    // and it is only ever owed here. Core's own ring rides `:focus-visible`,
    // where `EventManager.focus` claims the region while the ring is still
    // on; what arrives through a style swap is the `outlineWidth` escape
    // hatch (see `_outline`) — an application outlining a node for a reason
    // of its own, or a widget ringing one *part* of itself, the way
    // `<Checkbox>` rings its checked well and drops the ring again on blur.
    if (
      displayed.outlineWidth !== this.style.outlineWidth ||
      displayed.outlineOffset !== this.style.outlineOffset
    ) {
      const shrank = this._outlineExtent(displayed) - this._outlineExtent();
      if (shrank > 0) {
        this.root?.invalidate(
          false,
          insetRect(this.paintBounds(), -shrank),
          'outline',
          this,
        );
      }
    }
    return this.style;
  }

  _animatedValues() {
    const values = {};
    for (const [prop, a] of this._anim) {
      // an offloaded property shows its target: the render server draws the
      // motion over the model value, and the model is the style
      if (!a.offloaded) values[prop] = a.value ?? a.from;
    }
    return values;
  }

  // --- the presenter's half of an animation ---------------------------------
  //
  // Two feature-detected hooks on the window (src/cocoa/window.js: the
  // layer presenter, and the surface presenter's layer promotion —
  // src/cocoa/promotion.js): `animateNode(node, prop, entry)` answers true
  // when the presenter will run the entry itself, `cancelNodeAnimation(node,
  // prop)` stops what it runs for the property, and the presenter calls back
  // through `_offloadEnded` / `_offloadDeclined` below. An entry the
  // presenter took is `offloaded`: it stays in `_anim` — so a retarget, a
  // loop-stop rule and `sameAnimation` all see it — but it contributes no
  // value to the style, is skipped by the tick, and keeps the node out of the
  // window's animating set. The X11 path has none of these hooks and is
  // byte-identical (docs/architecture/animation.md §4).

  _offload(prop, entry) {
    const wnd = this.root?.window;
    if (typeof wnd?.animateNode !== 'function') return false;
    return wnd.animateNode(this, prop, entry) === true;
  }

  _cancelOffload(prop, entry) {
    if (!entry?.offloaded) return;
    this.root?.window?.cancelNodeAnimation?.(this, prop);
  }

  /** The presenter is done with `entry` — it ran out, or its layer went.
   *  A transition is over either way (the model is the target). A loop
   *  never ends on its own, so a loop that comes back this way lost its
   *  layer, and the frame clock takes it over rather than letting it stop. */
  _offloadEnded(prop, entry) {
    if (this._anim?.get(prop) !== entry) return;
    if (entry.loop && !this.destroyed) {
      this._offloadDeclined(prop, entry);
      return;
    }
    this._anim.delete(prop);
    if (!this._anim.size) this.root?._animating.delete(this);
  }

  /** The presenter could not run `entry` after all — the node turned into a
   *  raster between the swap and the frame, or its layer went. A transition
   *  starts again from the top, since the property's declared start is
   *  where its pixels still are. A loop goes on where it is in its cycle:
   *  the render server ran it from `start` (`LayerAnimations.apply`), or it
   *  never left the clock, so a spinner given back does not jump. */
  _offloadDeclined(prop, entry) {
    if (this._anim?.get(prop) !== entry || this.destroyed) return;
    entry.offloaded = false;
    entry.headStart = undefined;
    if (entry.loop) entry.value = animationValueAt(entry, now() - entry.start);
    else entry.start = now();
    this.style = { ...this._targetStyle, ...this._animatedValues() };
    this.root?._startAnimating(this);
  }

  /**
   * Loops the frame clock runs that the presenter would take now: turned
   * down by a frame, or given back, by a scene that has changed since — an
   * ancestor done fading, a sibling gone, a thumb scrolled away. Nothing
   * about a loop would ever ask again, so the window asks (`_recheckLoops`),
   * and only where the presenter says a frame would take it
   * (`wouldAnimateNode`), so a loop it would turn down again costs no swap.
   * Handed over where it is in its cycle (`headStart`).
   */
  _offerLoopsAgain() {
    const wnd = this.root?.window;
    let asked = false;
    let moved = false;
    for (const [prop, a] of this._anim ?? []) {
      if (!a.loop || a.offloaded) continue;
      if (!asked) {
        if (!wnd.wouldAnimateNode(this)) return;
        asked = true;
      }
      a.headStart = now() - a.start;
      if (this._offload(prop, a)) {
        a.offloaded = true;
        moved = true;
      } else {
        a.headStart = undefined;
      }
    }
    if (!moved) return;
    this.style = { ...this._targetStyle, ...this._animatedValues() };
    this._scheduleAnimationFrames();
  }

  /** Keep the frame clock running only for what the clock itself animates;
   *  an offloaded-only node needs one frame — the one that sends the model
   *  and the animation — and not a loop of them. */
  _scheduleAnimationFrames() {
    for (const a of this._anim?.values() ?? []) {
      if (!a.offloaded) {
        this.root?._startAnimating(this);
        return;
      }
    }
    this.root?._animating.delete(this);
    this.root?.invalidate(false, this, 'animation');
  }

  /**
   * The style declared a set of loops (`animation`, styles.js): remember
   * them and reconcile what is running against them.
   *
   * Called from `_retarget`, so from every route a style arrives by — and
   * only from there, because a loop is a property of the *style*. Whether it
   * is allowed to run is a property of everything else, which is
   * `_updateLoops`.
   */
  _syncLoops(target) {
    // `target` is device pixels by now, so the declared ends of a loop have
    // to arrive in the same unit — the scale rides in rather than being
    // applied after, because a `from` defaulted off the style is already
    // device and must not double (see animationsOf).
    const specs =
      target.animation == null
        ? null
        : animationsOf(target, 'a style', this.scale);
    if (!specs && !this._loops) return false;
    this._loops = specs;
    if (!specs) this.root?._forgetLoopNode(this);
    return this._updateLoops(false);
  }

  /**
   * Start, keep or stop this node's loops, and answer whether anything
   * changed. The one funnel: a style swap comes here, and so does every
   * reason a loop must *stop* that has nothing to do with the style — the
   * window unmapping, the desktop asking for less motion, a `display: none`
   * three levels up.
   *
   * `write` is false when `_retarget` is going to assemble the style itself
   * a line later; every other caller owns the repaint.
   */
  _updateLoops(write = true) {
    const specs = this._loops;
    if (specs) this.root?._registerLoopNode(this);
    const running = Boolean(specs) && this._loopsAllowed();
    const anim = this._anim;
    let changed = false;
    let layoutTouched = false;
    if (anim) {
      for (const [prop, a] of anim) {
        if (!a.loop) continue;
        if (running && specs.some((spec) => spec.prop === prop)) continue;
        anim.delete(prop);
        this._cancelOffload(prop, a);
        changed = true;
        if (isLayoutProp(prop)) layoutTouched = true;
      }
    }
    if (running) {
      for (const spec of specs) {
        const current = this._anim?.get(spec.prop);
        // An equal declaration keeps its phase. React hands a fresh object
        // down on every render, so restarting on identity would mean a
        // spinner that jumps back to the start whenever anything above it
        // re-rendered — which is the frame after every state change in the
        // app.
        if (current?.loop && sameAnimation(current, spec)) {
          // A loop the clock runs moves over the first time a presenter
          // takes it: one declared at mount runs from `_setRoot`, before
          // `realize`, and one a frame turned down runs until the next swap
          // offers it again (or `_offerLoopsAgain` does). It goes where it
          // has got to in its cycle (`headStart`), so nothing jumps.
          if (!current.offloaded) {
            current.headStart = now() - current.start;
            if (this._offload(spec.prop, current)) {
              current.offloaded = true;
              changed = true;
            } else {
              current.headStart = undefined;
            }
          }
          continue;
        }
        // a changed declaration, or a transition the loop takes over from:
        // whatever the presenter ran for the property stops first
        if (current?.offloaded) this._cancelOffload(spec.prop, current);
        const entry = {
          ...spec,
          loop: true,
          start: now(),
          value: animationValueAt(spec, 0),
        };
        (this._anim ??= new Map()).set(spec.prop, entry);
        if (this._offload(spec.prop, entry)) entry.offloaded = true;
        changed = true;
        if (isLayoutProp(spec.prop)) layoutTouched = true;
      }
    }
    if (!changed) return false;
    const before = this.style;
    this.style = this._anim?.size
      ? { ...this._targetStyle, ...this._animatedValues() }
      : this._targetStyle;
    // Out of the window's animating set here rather than on the next tick:
    // a stop has to leave the frame clock idle, and a tick is exactly what
    // there may never be another of.
    if (!this._anim?.size) this.root?._animating.delete(this);
    if (running) this._scheduleAnimationFrames();
    if (!write) return true;
    if (layoutTouched && this.yoga) {
      applyLayoutStyle(this.yoga, this.style, before);
      this._invalidateLayout('animation');
    } else {
      this.root?.invalidate(false, this, 'animation');
    }
    return true;
  }

  /**
   * Whether this node's loops may run at all.
   *
   * A transition stops because it arrives; a loop never does, so every one
   * of these is load-bearing rather than an optimisation. A window keeping
   * its frame clock alive for a spinner nobody can see is a laptop battery
   * going down for nothing, and it is invisible by construction — the only
   * way to notice is to look for it.
   */
  _loopsAllowed() {
    const root = this.root;
    if (this.destroyed || !root || root.destroyed || root._loopsPaused) {
      return false;
    }
    if (desktopSettings(root.app).animations === false) return false;
    if (this._hiddenInTree()) return false;
    // last, since it is the one that measures — and a hidden subtree's
    // rects are wherever it was when it went
    this._outOfSight = this._loopsOutOfSight();
    return !this._outOfSight;
  }

  /**
   * Whether nothing this node's loops draw can be seen: all of it is cut
   * away by the boxes that clip it, or lies outside the window — a spinner
   * in a row scrolled out of its list, a bar in a panel scrolled away.
   * Judged against the arrangement the last layout pass left, and again
   * after every pass that moved anything (`_recheckLoops`).
   *
   * Never from where a frame of the loop has the node *now*: a block that
   * slides across a track is off it at the start of every crossing, and a
   * loop stopped there would rest there, unseen, for good. What is judged is
   * what holds every frame (`_loopReach`), and a loop whose frames can move
   * what is around it is never judged out of sight at all.
   */
  _loopsOutOfSight() {
    const window = this.root?.abs;
    if (!this._placed || !window) return false;
    const reach = this._loopReach();
    if (!reach) return false;
    let out = reach.rect;
    for (let n = reach.from.parent; n && out; n = n.parent) {
      if (n.isWindow) break;
      if (n.clipsChildren()) out = intersectRects(out, outerPixels(n.abs));
    }
    return (
      !out ||
      !intersectRects(out, {
        x: 0,
        y: 0,
        width: window.width,
        height: window.height,
      })
    );
  }

  /**
   * What every frame of this node's loops stays inside, as `{ rect, from }`
   * — `from` is the node whose clipping ancestors cut `rect` — or null when
   * nothing short of the window holds it.
   *
   * A loop on a colour, an opacity or a radius moves nothing and grows
   * nothing, so it draws where the node and what it holds already reach.
   * One that grows the node's outline, or moves or sizes a node out of the
   * flow, can put it anywhere in the nearest box that clips it — and nowhere
   * else, since a node out of the flow sizes nothing around it; with no such
   * box, anywhere in the window. One that moves or sizes a node in the flow
   * moves its siblings and can resize every box above it, the clipping ones
   * among them, so no box holds it.
   */
  _loopReach() {
    let inPlace = true;
    for (const { prop } of this._loops ?? []) {
      if (REACH_PROPS.has(prop)) {
        inPlace = false;
      } else if (isLayoutProp(prop) || TEXT_LAYOUT_PROPS.has(prop)) {
        if (this.style?.position !== 'absolute') return null;
        inPlace = false;
      }
    }
    if (inPlace) return { rect: this.paintBounds(), from: this };
    for (let n = this.parent; n && !n.isWindow; n = n.parent) {
      if (n.clipsChildren()) return { rect: outerPixels(n.abs), from: n };
    }
    return null;
  }

  /** Whether anything between this node and its window has taken it off the
   *  screen — React's own `hidden` flag for `<Suspense>`/`<Activity>`, or a
   *  `display: 'none'` from a style, a state block or a size query. */
  _hiddenInTree() {
    for (let n = this; n; n = n.parent) {
      if (n.hidden || n.style?.display === 'none') return true;
      if (n.isWindow) break;
    }
    return false;
  }

  /**
   * Advance every in-flight transition to `now`. Returns true while any is
   * still running, so the window keeps asking for frames.
   */
  _tickAnimations(now) {
    if (!this._anim?.size) return false;
    let layoutChanged = false;
    let ticking = 0; // entries the clock runs, as against the presenter's
    const before = this.style;
    for (const [prop, a] of this._anim) {
      if (a.offloaded) continue;
      if (a.loop) {
        // No end to test for and no rounding to accumulate: the phase is a
        // modulo of the elapsed time, so a bar that has been going for an
        // hour is exactly where the clock says.
        a.value = animationValueAt(a, now - a.start);
        if (isLayoutProp(prop)) layoutChanged = true;
        ticking++;
        continue;
      }
      const t = a.duration > 0 ? Math.min(1, (now - a.start) / a.duration) : 1;
      a.value = t >= 1 ? a.to : (interpolate(a.from, a.to, ease(t)) ?? a.to);
      if (t >= 1) this._anim.delete(prop);
      else ticking++;
      if (isLayoutProp(prop)) layoutChanged = true;
    }
    this.style = this._anim.size
      ? { ...this._targetStyle, ...this._animatedValues() }
      : this._targetStyle;
    if (layoutChanged && this.yoga) {
      applyLayoutStyle(this.yoga, this.style, before);
      // a transition on a layout property costs a layout pass per frame —
      // the author asked for that by transitioning one (docs/styling.md) —
      // and a fresh set of content floors with it, since one of the
      // properties it can be animating is a padding the floors were measured
      // through
      if (this.root) {
        this.root.needsLayout = true;
        this.root._floorsDirty = true;
        this.root._floorsSources.add(this);
        this.root._floorsOtherSources.add(this);
      }
    }
    // A tick writes `this.style` without going through `_retarget`, so it
    // owes the cascade the same notice — and it is the only thing that owes
    // it *per frame*: a transitioned `color` is a new ink every frame, for
    // this node and for everything inheriting from it.
    if (inheritedTextChanged(this.style, before)) this._retextSubtree();
    return ticking > 0;
  }
}

/** WindowNode's half of transitions and loops, installed onto `WindowNode.prototype` by window/window.js. */
export class WindowAnimation {
  /**
   * A node in this window has a loop declared on it. Registration is what
   * makes the window watch its own visibility — and only then: a
   * VisibilityNotify mask bit and a `_NET_WM_STATE` selection are a real
   * cost, and an app with no looping animation must not pay it (the same
   * rule `useWindowState()` follows, for the same reason).
   */
  _registerLoopNode(node) {
    if (this._loopNodes.has(node)) return;
    this._loopNodes.add(node);
    this._watchLoops();
  }

  _forgetLoopNode(node) {
    if (!this._loopNodes.delete(node)) return;
    if (this._loopNodes.size === 0) this._unwatchLoops();
  }

  _watchLoops() {
    // Before realize() there is no window to select events on, and
    // `watchWindowState` would arm a session against nothing. `flush()`
    // retries, which costs one boolean per frame of an animation that is
    // running anyway.
    if (this._loopWatch || !this.window || this.destroyed) return;
    this._loopWatch = [
      watchWindowState(this.app, this, () => this._loopVisibilityChanged()),
      // Reduce motion is a live setting, not a startup one: turning it on in
      // the accessibility panel has to stop the spinner that is already
      // going round.
      watchDesktopSettings(this.app, () => this._refreshLoops()),
    ];
    this._loopVisibilityChanged();
    // The window has a presenter now, which it did not when a loop declared
    // at mount started on the clock (`_setRoot` runs before `realize`):
    // every loop is asked again here, so one a presenter can take moves
    // over on the window's first frame rather than at the next swap that
    // happens to re-resolve its style. Where nothing can take it, the
    // second look at an unchanged declaration is a no-op.
    this._refreshLoops();
  }

  _unwatchLoops() {
    for (const off of this._loopWatch ?? []) {
      try {
        off();
      } catch {
        // a window already destroyed takes its subscriptions with it
      }
    }
    this._loopWatch = null;
  }

  /** Minimized, fully obscured under a bare window manager, or unmapped —
   *  see the compositor caveat at the top of windowstate.js for why
   *  `visible` is the field to branch on rather than `obscured`. */
  _loopVisibilityChanged() {
    const { visible } = windowStateSnapshot(this.app, this);
    const paused = this.hidden || !visible;
    if (this._loopsPaused === paused) return;
    this._loopsPaused = paused;
    this._refreshLoops();
  }

  /** Re-ask every loop in this window whether it may run. */
  _refreshLoops() {
    for (const node of [...this._loopNodes]) node._updateLoops();
  }

  /**
   * After the frame's layout and placements, before the presenter's word.
   *
   * Where a pass moved things (`moved`), a loop it put out of sight stops,
   * and one it brought back runs again (`_loopsOutOfSight`) — from the top,
   * as every stop here resumes, since nobody saw where it had got to. Only
   * the loops whose answer changed are asked again, so a pass that moved
   * nothing of theirs costs a walk up from each.
   *
   * And where a presenter can run a loop in the render server, a loop in
   * sight that the clock runs is offered to it again (`_offerLoopsAgain`),
   * each at most every `REOFFER_MS`: what turned it down can go without a
   * layout pass — an ancestor's fade arriving is a paint — and the loop is
   * a frame every refresh until it is taken.
   */
  _recheckLoops(moved) {
    const offer = typeof this.window?.wouldAnimateNode === 'function';
    if (!moved && !offer) return;
    const t = offer ? now() : 0;
    for (const node of [...this._loopNodes]) {
      if (moved) {
        const out = node._loopsOutOfSight();
        if (out !== (node._outOfSight === true)) {
          node._outOfSight = out;
          node._updateLoops();
          continue;
        }
      }
      if (!offer || node._outOfSight === true || node.destroyed) continue;
      if (!(t - (node._offeredAt ?? -Infinity) >= REOFFER_MS)) continue;
      if (!node.root?._animating.has(node)) continue; // the clock runs none
      node._offeredAt = t;
      node._offerLoopsAgain();
    }
  }

  /** A node in this window started a transition. */
  _startAnimating(node) {
    this._animating.add(node);
    // The transition has to schedule its own first frame: it starts at the
    // *old* value, so to whoever caused it the displayed style hasn't changed
    // and their damage test contributes nothing. `setStyleState` happens to
    // invalidate anyway, but a React prop change does not — and a transition
    // no one schedules only runs when something else dirties the window,
    // by which time its start is stale and it snaps to the end.
    this.invalidate(false, node, 'animation');
  }

  /**
   * Step every in-flight transition to `now`, then keep the frame clock
   * running while any is unfinished — the animation *is* the repaint loop,
   * and it stops on its own the frame the last one lands.
   */
  _advanceAnimations(now) {
    if (this._animating.size === 0) return;
    for (const node of [...this._animating]) {
      if (node.destroyed) {
        this._animating.delete(node);
        continue;
      }
      // The node where it stands, which is where it *was*: nothing has been
      // laid out yet, so its rect is the one the last pass gave it. Where it
      // goes is the layout pass's to claim. A tick on a layout property asks
      // for one, and that pass claims the old and new rect of every node it
      // moves (`_assignAbs`) — this one, and whatever this one pushed, in
      // flow or out of it. A paint-only property moves nothing, and this
      // claim is the whole frame.
      //
      // Claimed rather than left unbounded because an animation repaints
      // every frame for as long as it runs: eight height loops in a menu-bar
      // popover were a full-window repaint per frame at 120Hz (#603). A node
      // that *finishes* on this tick is claimed too — it just landed on its
      // final value, and this last frame still has to paint it there.
      this.invalidate(false, node, 'animation');
      if (!node._tickAnimations(now)) this._animating.delete(node);
    }
    this.needsPaint = true;
  }
}

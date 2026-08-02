// Synthetic event system: ntk window events → capture/target/bubble dispatch
// over the drawn node tree, with hit testing, click synthesis, hover
// enter/leave, wheel mapping (X buttons 4-7) and focus/Tab traversal.
// Handlers always read from current props, so updates never go stale.
import {
  runWithPriority,
  DiscreteEventPriority,
  ContinuousEventPriority,
  flushSyncWork,
} from './priority.js';
import { flushPendingFrames } from './frames.js';
import { callHandler } from './errors.js';
import { armDrag } from './dnd.js';
import { noteInputTime } from './inputtime.js';

const XK_TAB = 0xff09;
const WHEEL_BUTTONS = { 4: [0, -48], 5: [0, 48], 6: [-48, 0], 7: [48, 0] };
const RIGHT_BUTTON = 3;
// X11 KeyButMask bit for Mod1 (Alt on virtually every layout), same bitmask
// `shiftKey`/`ctrlKey` above already read `buttons` from.
const MOD1_MASK = 8;

/** How many leading entries two node paths share. */
function sharedPrefix(a, b) {
  const limit = Math.min(a.length, b.length);
  let n = 0;
  while (n < limit && a[n] === b[n]) n++;
  return n;
}

// Click-to-component hook (see ClickToComponent.js). At most one handler is
// installed, gated by REACT_X11_CLICK_TO_COMPONENT — checked ahead of the
// normal press handling so an Alt+Click never also starts a drag or moves
// focus.
let clickToComponentHandler = null;
export function setClickToComponentHandler(fn) {
  clickToComponentHandler = fn;
}

/**
 * Wrap an ntk event callback for a *discrete* event — one whose response is
 * a single visual state, so there is nothing a frame's wait could coalesce
 * it with. That is everything ntk does not coalesce: mousedown/mouseup,
 * keydown/keyup, the wheel (X delivers notches as button 4-7 presses),
 * focus/blur and WM messages. Motion, and the hover diffing it drives, are
 * the opposite case and stay on the paced frame.
 *
 * The response is painted once the *whole* dispatch has unwound — default
 * actions, React's discrete-priority commit, and every invalidation the two
 * produced — rather than after each handler. That ordering is what makes it
 * one paint rather than two: paint after the `:active` flip but before the
 * state update lands, and the frame shows half the response with the other
 * half still waiting on the frame clock.
 *
 * ntk presents a window's dirty backing rects when its event handler
 * returns, so the blit goes out in the same event-loop turn as the press
 * that caused it. `flushPendingFrames` decides *whether* to paint now; see
 * frames.js for the fence gate that keeps a burst from painting ten times.
 */
export function discrete(fn) {
  return (ev) => {
    fn(ev);
    flushSyncWork();
    flushPendingFrames();
  };
}

export class EventManager {
  constructor(windowNode) {
    this.node = windowNode;
    this.hoverPath = [];
    this.downNode = null;
    // where a press landed, and how much of that chain still draws `:active`
    // — the second shrinks and grows again as the pointer leaves and returns
    this.downPath = [];
    this.pressPath = [];
    this.capturedNode = null;
    this.focused = null;
    // what had focus before `focused`, so a focus scope opened by something
    // that focuses itself still knows where to hand focus back
    this._previousFocus = null;
    // focus scopes, innermost last: [{ node, restore }]
    this.scopes = [];
    // resolved lazily for popups: the manager that owns focus (focusManager)
    this._focusOwner = null;
    // whether the X server sends keys to this window at all. Assume yes
    // until told otherwise: ntk < 3.7 never reports focus changes, and a
    // toolkit that believed it was unfocused would blink no caret at all.
    this.windowFocused = true;
    this._lastClick = { time: 0, x: 0, y: 0, detail: 0 };
    // the window's DragSession while a press has armed it (src/dnd.js)
    this._dragArmed = null;
  }

  /**
   * The manager that owns focus for this window — normally itself, but for a
   * `<popup>` the nearest enclosing real window's manager. Override-redirect
   * windows never receive the X input focus, so a popup cannot hold it: keys
   * arrive at the owner window, and routing them into the popup's subtree is
   * only possible if both windows share one notion of "the focused node".
   * Nodes inside a popup are still ordinary tree nodes, so capture/bubble
   * from them reaches the owner window's handlers.
   */
  get focusManager() {
    if (!this.node.isPopup) return this;
    // a popup's parent is a node in the owner window (or an outer popup,
    // whose own delegate resolves recursively). Remember it: the parent link
    // is cut before the deletion bookkeeping runs, and unmounting a modal is
    // exactly when the owner has to hear about it (focus restore).
    const manager = this.node.parent?.root?.events;
    if (manager && manager !== this) this._focusOwner = manager.focusManager;
    return this._focusOwner ?? this;
  }

  /** DOM-style click counting: repeated presses within 400ms / 4px bump
   * `detail` (2 = double click, 3 = triple …). */
  _clickDetail(native) {
    const now = Date.now();
    const last = this._lastClick;
    const detail =
      now - last.time < 400 &&
      Math.abs(native.x - last.x) <= 4 &&
      Math.abs(native.y - last.y) <= 4
        ? last.detail + 1
        : 1;
    this._lastClick = { time: now, x: native.x, y: native.y, detail };
    return detail;
  }

  attach() {
    const wnd = this.node.window;
    if (typeof wnd.on !== 'function') return;
    // `onDiscrete` paints the response from the handler; plain `wnd.on`
    // leaves it to the paced frame. Which is which is not a judgement call:
    // it is ntk's coalesce table (lib/events_map.js), and motion is the
    // whole reason that table exists.
    // Every X input event carries a server timestamp, and the selection
    // operations further down need one (inputtime.js). Noting it here, on
    // the way past, is what keeps `write()`/`read()` from having to ask the
    // server for the time they should already know.
    const onDiscrete = (name, fn) =>
      wnd.on(
        name,
        discrete((ev) => {
          noteInputTime(this.node.app, name, ev);
          return fn(ev);
        }),
      );
    onDiscrete('mousedown', (ev) => this._onMouseDown(ev));
    onDiscrete('mouseup', (ev) => this._onMouseUp(ev));
    wnd.on('mousemove', (ev) => this._onMouseMove(ev));
    wnd.on('mouseout', (ev) => this._onMouseOut(ev));
    onDiscrete('keydown', (ev) => this._onKey('KeyDown', ev));
    onDiscrete('keyup', (ev) => this._onKey('KeyUp', ev));
    // window-level focus (ntk >= 3.7.0): the window manager decides which
    // window gets keys, and the focused node's caret/ring has to follow
    onDiscrete('focus', (ev) => this._onWindowFocus(true, ev));
    onDiscrete('blur', (ev) => this._onWindowFocus(false, ev));
  }

  /**
   * The DOM keeps `document.activeElement` across a window blur — the
   * element stays focused, it just stops looking active — and so do we: the
   * node keeps focus, its default focus behaviour (a blinking caret) is
   * suspended, and `<window onFocus/onBlur>` gets told.
   */
  _onWindowFocus(focused, native) {
    if (this.windowFocused === focused) return;
    this.windowFocused = focused;
    const node = this.focused;
    if (node && !node.destroyed) {
      if (focused) node._defaultFocus?.();
      else node._defaultBlur?.();
    }
    runWithPriority(DiscreteEventPriority, () => {
      const prop = focused ? 'onFocus' : 'onBlur';
      this.node.props[prop]?.(
        this._makeEvent(focused ? 'focus' : 'blur', native, this.node),
      );
    });
    this.node.invalidate(false, null, 'focus');
  }

  _public(node) {
    return node.isWindow ? node.window : node;
  }

  _hit(ev) {
    return this.node.hitTest(ev.x, ev.y) ?? this.node;
  }

  _path(target) {
    const path = [];
    for (
      let n = target;
      n;
      n = n === this.node ? null : (n.parent ?? this.node)
    ) {
      path.unshift(n);
      if (n === this.node) break;
    }
    return path;
  }

  _makeEvent(type, native, target, extra) {
    const ev = {
      type,
      x: native?.x ?? 0,
      y: native?.y ?? 0,
      target: this._public(target),
      currentTarget: null,
      nativeEvent: native,
      // X11 modifier mask: bit 0 Shift, bit 2 Control. Carried on every
      // event, not just keys — shift+click needs it too.
      shiftKey: Boolean(native?.buttons & 1),
      ctrlKey: Boolean(native?.buttons & 4),
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() {
        ev.defaultPrevented = true;
      },
      stopPropagation() {
        ev.propagationStopped = true;
      },
      // Pointer capture, DOM-like: while captured, mousemove/mouseup go to
      // the capturing node instead of whatever is under the pointer, so a
      // drag keeps working past the widget's own bounds. Released
      // automatically on mouseup and when the node unmounts.
      capturePointer: () => {
        this.capturedNode = target;
      },
      releasePointer: () => {
        if (this.capturedNode === target) this.capturedNode = null;
      },
      ...extra,
    };
    if (target.abs) {
      ev.localX = ev.x - target.abs.x;
      ev.localY = ev.y - target.abs.y;
    }
    return ev;
  }

  /** Capture → target → bubble along the ancestor path. Returns the event. */
  dispatch(name, target, native, extra) {
    const path = this._path(target);
    const ev = this._makeEvent(
      name[0].toLowerCase() + name.slice(1),
      native,
      target,
      extra,
    );
    // Each handler is called inside callHandler: a throw here has no React
    // on the stack to catch it, so bare it would unwind into ntk's socket
    // handler and take the process. Reported and stepped over instead —
    // one bad handler must not stop the ones after it, or the frame loop.
    for (const n of path) {
      const handler = n.props[`on${name}Capture`];
      if (handler) {
        ev.currentTarget = this._public(n);
        callHandler(n, `on${name}Capture`, handler, ev);
        if (ev.propagationStopped) return ev;
      }
    }
    for (let i = path.length - 1; i >= 0; i--) {
      const handler = path[i].props[`on${name}`];
      if (handler) {
        ev.currentTarget = this._public(path[i]);
        callHandler(path[i], `on${name}`, handler, ev);
        if (ev.propagationStopped) return ev;
      }
    }
    return ev;
  }

  /** A press the X server sent us only because we hold a pointer grab:
   *  it landed outside this window, so it is a dismissal, not a click. */
  _pressOutside(native) {
    const wnd = this.node.window;
    if (!wnd || typeof this.node.props.onDismiss !== 'function') return false;
    return (
      native.x < 0 ||
      native.y < 0 ||
      native.x >= (wnd.width ?? 0) ||
      native.y >= (wnd.height ?? 0)
    );
  }

  _onMouseDown(native) {
    if (clickToComponentHandler && Boolean(native.buttons & MOD1_MASK)) {
      clickToComponentHandler(this._hit(native), native);
      return;
    }
    if (this._pressOutside(native)) {
      runWithPriority(DiscreteEventPriority, () => {
        const onDismiss = this.node.props.onDismiss;
        if (onDismiss) {
          callHandler(
            this.node,
            'onDismiss',
            onDismiss,
            this._makeEvent('dismiss', native, this.node),
          );
        }
      });
      return;
    }
    runWithPriority(DiscreteEventPriority, () => {
      const wheel = WHEEL_BUTTONS[native.keycode];
      const target = this._hit(native);
      if (wheel) {
        const shift = Boolean(native.buttons & 1);
        // X sends buttons 6/7 for a horizontal wheel; Shift+vertical is the
        // convention for mice and touchpads that have none
        const [dx, dy] =
          shift && wheel[0] === 0 ? [wheel[1], 0] : [wheel[0], wheel[1]];
        const ev = this.dispatch('Wheel', target, native, {
          deltaX: dx,
          deltaY: dy,
        });
        if (!ev.defaultPrevented) {
          // default action: scroll the nearest enclosing <scrollview>
          for (let n = target; n; n = n.parent) {
            if (n.kind === 'scrollview') {
              n.scrollBy({ x: ev.deltaX, y: ev.deltaY });
              break;
            }
            if (n.kind === 'textarea') {
              n.scrollBy(ev.deltaY); // one axis only: it wraps
              break;
            }
            if (n === this.node) break;
          }
        }
        return;
      }
      this.downNode = target;
      this.downPath = target ? this._path(target) : [];
      this._setPressed(this.downPath);
      this._focusFromPress(target);
      const ev = this.dispatch('MouseDown', target, native, {
        button: native.keycode,
        detail: this._clickDetail(native),
      });
      if (!ev.defaultPrevented) {
        target._defaultMouseDown?.(ev);
      }
      // a left press on (or inside) a `draggable` arms a drag; below the
      // threshold the gesture is still a click (src/dnd.js)
      if (native.keycode === 1 && !ev.defaultPrevented) {
        this._dragArmed = armDrag(this.node, target, native);
      }
      // Right-click is two events, as in the DOM: mousedown, then a
      // separate contextmenu whose default action opens the element's own
      // menu. Handlers that only want to suppress the menu can do it
      // without also giving up the caret placement mousedown just did.
      if (native.keycode === RIGHT_BUTTON) {
        const menuEv = this.dispatch('ContextMenu', target, native, {
          button: native.keycode,
        });
        if (!menuEv.defaultPrevented) {
          target?._defaultContextMenu?.(menuEv);
        }
      }
    });
  }

  _onMouseUp(native) {
    if (WHEEL_BUTTONS[native.keycode]) return; // wheel release
    runWithPriority(DiscreteEventPriority, () => {
      // a completed drag ends the gesture: no mouseup, no click — as in
      // the DOM, where dragend replaces them
      const drag = this._dragArmed;
      if (drag) {
        this._dragArmed = null;
        if (drag.release(native)) {
          this._clearPress();
          this.downNode = null;
          this.capturedNode = null;
          return;
        }
      }
      const captured = this._captured();
      const target = captured ?? this._hit(native);
      const ev = this.dispatch('MouseUp', target, native, {
        button: native.keycode,
      });
      // capture ends with the gesture, like implicit DOM pointer capture
      this.capturedNode = null;
      this._clearPress();
      if (this.downNode && !this.downNode.destroyed) {
        this.downNode._defaultMouseUp?.(ev);
      }
      if (this.downNode) {
        // click fires on the nearest common ancestor of press and release
        const downPath = new Set(this._path(this.downNode));
        let clickTarget = target;
        while (clickTarget && !downPath.has(clickTarget)) {
          clickTarget =
            clickTarget.parent ??
            (clickTarget === this.node ? null : this.node);
        }
        if (clickTarget) {
          this.dispatch('Click', clickTarget, native, {
            button: native.keycode,
          });
        }
        this.downNode = null;
      }
    });
  }

  _onMouseMove(native) {
    runWithPriority(ContinuousEventPriority, () => {
      // an active drag owns the pointer: drag-path diffing replaces hover,
      // onDrag replaces mousemove. Below the threshold this falls through.
      const drag = this._dragArmed;
      if (drag && drag.motion(native)) return;
      const captured = this._captured();
      const target = captured ?? this._hit(native);
      const path = this._path(target);
      // while captured, hover stays put: dragging a slider must not light
      // up every widget the pointer crosses
      this._updateHover(captured ? this.hoverPath : path, native);
      // and neither does the press — the gesture owns the pointer, so a
      // captured control stays pressed wherever the pointer wandered off to
      if (this.downNode && !captured)
        this._setPressed(this._pressedAlong(path));
      const ev = this.dispatch('MouseMove', target, native);
      // drags deliver to the pressed node even when the pointer leaves it
      if (this.downNode && !this.downNode.destroyed) {
        this.downNode._defaultMouseDrag?.(ev);
      }
    });
  }

  /** The capturing node, dropping it if it has gone away. */
  _captured() {
    if (this.capturedNode?.destroyed) this.capturedNode = null;
    return this.capturedNode;
  }

  /**
   * DOM-like: mousedown moves focus to the nearest focusable ancestor of the
   * hit node. A press outside an open focus scope leaves focus where it is —
   * a modal keeps focus even when the user pokes at what is behind it.
   */
  _focusFromPress(target) {
    const manager = this.focusManager;
    const scope = manager._scopeRoot();
    if (scope !== manager.node && !this._within(target, scope)) return;
    const focusable = this._path(target)
      .reverse()
      .find((n) => this._isFocusable(n));
    // a press inside a popup on nothing focusable leaves the owner window's
    // focus alone: the press never reached that window, and menus rely on it
    // (their rows are not focusable, the trigger keeps the keys)
    if (!focusable && manager !== this) return;
    manager.focus(focusable ?? null, 'pointer');
  }

  /** Focusable: `focusable`, an explicit `tabIndex` (including a negative
   * one, focusable but not tabbable), or a kind that is focusable by default
   * (`<textinput>`). `focusable={false}` and `disabled` opt back out. */
  _isFocusable(node) {
    if (node.props.disabled) return false;
    return (
      node.props.focusable ??
      (node.props.tabIndex != null ? true : (node.focusableByDefault ?? false))
    );
  }

  _onMouseOut(native) {
    runWithPriority(ContinuousEventPriority, () => {
      this._updateHover([], native);
      // the pointer left the window with a button still down: a release out
      // there synthesizes its click on the window, so that is as much of the
      // press chain as may still look pressed
      if (this.downNode) this._setPressed(this._pressedAlong([this.node]));
      this.node.props.onMouseOut?.(
        this._makeEvent('mouseOut', native, this.node),
      );
    });
  }

  /**
   * The chain of the press that is still live, as far along it as the
   * pointer has stayed. `downPath` is where the press landed and does not
   * move; this is the part of it a release would still deliver a click to.
   */
  _pressedAlong(path) {
    return this.downPath.slice(0, sharedPrefix(this.downPath, path));
  }

  /** The gesture is over: nothing is pressed, and there is no chain left to
   *  come back to. */
  _clearPress() {
    this._setPressed([]);
    this.downPath = [];
  }

  /**
   * Flip `:active` over a press chain, diffed the way hover is.
   *
   * Two things this is not. It is **not one node**: a press marks the whole
   * ancestor chain, because the node actually hit is whatever the control
   * happens to be built out of — a `<Button>`'s label, a `<Switch>`'s thumb —
   * and a control that draws its own pressed state has no other way to hear
   * about a press that landed on its own child.
   *
   * And it is **not fixed for the gesture**: it narrows as the pointer leaves
   * the chain and grows back as it returns, so `:active` says "releasing now
   * activates this" rather than "this is where the press started". That is
   * the same nearest-common-ancestor rule `_onMouseUp` synthesizes the click
   * on, which is what keeps the drawing from promising an activation the
   * release will not deliver.
   */
  _setPressed(path) {
    const oldPath = this.pressPath;
    const common = sharedPrefix(oldPath, path);
    for (let i = oldPath.length - 1; i >= common; i--) {
      if (!oldPath[i].destroyed) oldPath[i].setStyleState(':active', false);
    }
    for (let i = common; i < path.length; i++) {
      if (!path[i].destroyed) path[i].setStyleState(':active', true);
    }
    this.pressPath = path;
  }

  /** enter/leave do not propagate: each node on the diff gets its own call. */
  _updateHover(newPath, native) {
    const oldPath = this.hoverPath;
    const common = sharedPrefix(oldPath, newPath);
    for (let i = oldPath.length - 1; i >= common; i--) {
      const n = oldPath[i];
      if (!n.destroyed) {
        // the hover path is the ancestor chain, so a `:hover` block on a
        // parent lights up while a child is hovered — CSS semantics, for
        // free, because the path is already computed for enter/leave
        n.setStyleState(':hover', false);
        n.props.onMouseLeave?.(this._makeEvent('mouseLeave', native, n));
      }
    }
    for (let i = common; i < newPath.length; i++) {
      const n = newPath[i];
      n.setStyleState(':hover', true);
      n.props.onMouseEnter?.(this._makeEvent('mouseEnter', native, n));
    }
    this.hoverPath = newPath;
    this._updateCursor(newPath);
  }

  /** Apply the deepest hovered node's `cursor` prop to the window.
   * Feature-detected: needs ntk with Window.setCursor (> 3.1.0). */
  _updateCursor(path) {
    const wnd = this.node.window;
    if (typeof wnd.setCursor !== 'function') return;
    let cursor = null;
    for (let i = path.length - 1; i >= 0; i--) {
      const c = path[i].style.cursor ?? path[i].defaultCursor;
      if (c != null) {
        cursor = c;
        break;
      }
    }
    if (cursor !== this._appliedCursor) {
      this._appliedCursor = cursor;
      wnd.setCursor(cursor);
    }
  }

  _onKey(name, native) {
    runWithPriority(DiscreteEventPriority, () => {
      const wnd = this.node.window;
      const syms = wnd.X?.keycode2keysyms?.[native.keycode];
      const keysym = syms?.[0];
      // the focused node may live inside a <popup> of this window: focus is
      // shared with the popup (see focusManager), key delivery follows it
      const focused = this.focusManager.focused;
      const target = focused && !focused.destroyed ? focused : this.node;
      const ev = this.dispatch(name, target, native, {
        keycode: native.keycode,
        keysym,
        codepoint: native.codepoint,
        key:
          native.codepoint && native.codepoint >= 0x20
            ? String.fromCodePoint(native.codepoint)
            : undefined,
        shiftKey: Boolean(native.buttons & 1),
        ctrlKey: Boolean(native.buttons & 4),
      });
      if (name === 'KeyDown' && keysym === XK_TAB && !ev.defaultPrevented) {
        this._cycleFocus(Boolean(native.buttons & 1));
        return;
      }
      if (name === 'KeyDown' && !ev.defaultPrevented) {
        target._defaultKeyDown?.(ev);
      }
    });
  }

  /**
   * Move focus, and record *how* it moved.
   *
   * `reason` is what separates `:focus` from `:focus-visible`. A press is
   * `'pointer'` and lights no ring: the user knows where they clicked, and a
   * ring on every click is the noise CSS grew `:focus-visible` to remove.
   * Everything else — Tab, an arrow inside a widget, `autoFocus`, a modal
   * handing focus back as it closes, `node.focus()` from an application —
   * lights one, because none of those tell the user where focus went.
   */
  focus(node, reason = 'script') {
    const manager = this.focusManager;
    if (manager !== this) return manager.focus(node, reason);
    if (node === this.focused) return;
    const old = this.focused;
    this._previousFocus = old;
    this.focused = node;
    if (old && !old.destroyed) {
      // Claimed *first*, while the ring is still on: a node's damage bound
      // only reaches outside its box while it is actually drawing an
      // outline, so a claim taken after the state flipped back would leave
      // the ring's pixels behind.
      old.root?.invalidate(false, old, 'focus');
      old.setStyleState(':focus', false);
      old.setStyleState(':focus-visible', false);
      old._defaultBlur?.();
      old.props.onBlur?.(this._makeEvent('blur', null, old));
      // it may be in another window than the new focus — owner window ↔ its
      // popup — and the caret it was drawing has to go too
      old.root?.invalidate(false, old, 'focus');
    }
    if (node) {
      // keys only reach a node whose window has the X focus
      if (!this.windowFocused) this.node.window?.focus?.();
      node.setStyleState(':focus', true);
      node.setStyleState(':focus-visible', reason !== 'pointer');
      this._scrollIntoView(node);
      if (this.windowFocused) node._defaultFocus?.();
      node.props.onFocus?.(this._makeEvent('focus', null, node));
      node.root?.invalidate(false, node, 'focus');
    }
  }

  /**
   * Focus scopes. A node with `trapFocus` — a modal `<popup>`, typically —
   * pushes one: while it is the innermost scope Tab only visits focusables
   * inside it, and presses outside it leave focus alone. Popping the scope
   * (usually when the modal unmounts) hands focus back to whatever had it
   * before the scope opened, which is what makes a dialog feel finished
   * rather than abandoned.
   */
  pushScope(node) {
    const manager = this.focusManager;
    if (manager !== this) return manager.pushScope(node);
    if (this.scopes.some((s) => s.node === node)) return;
    // commitMount runs children before parents, so a scope's own autoFocus
    // may already have taken focus by the time the scope registers — then
    // the node to come back to is the one focused before that.
    const focused = this.focused;
    const restore =
      focused && this._within(focused, node) ? this._previousFocus : focused;
    this.scopes.push({ node, restore });
  }

  popScope(node) {
    const manager = this.focusManager;
    if (manager !== this) return manager.popScope(node);
    const index = this.scopes.findIndex((s) => s.node === node);
    if (index === -1) return;
    const [scope] = this.scopes.splice(index, 1);
    const focused = this.focused;
    // focus only comes back if it was inside the scope that just closed
    if (focused && !this._within(focused, node)) return;
    const restore = scope.restore;
    const alive = restore && !restore.destroyed && this._isFocusable(restore);
    this.focus(alive ? restore : null);
  }

  /** The innermost live focus scope, or the window node when there is none.
   * Destroyed scopes are dropped; a hidden one is skipped but kept, since
   * unhiding it puts the trap back. */
  _scopeRoot() {
    while (this.scopes.length > 0 && this.scopes.at(-1).node.destroyed) {
      this.scopes.pop();
    }
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (!this.scopes[i].node.hidden) return this.scopes[i].node;
    }
    return this.node;
  }

  _within(node, root) {
    for (let n = node; n; n = n.parent) {
      if (n === root) return true;
    }
    return false;
  }

  /** Tab to something inside a scrollview and it should be on screen. */
  _scrollIntoView(node) {
    for (let n = node.parent; n; n = n.parent) {
      if (typeof n.scrollIntoView === 'function') {
        n.scrollIntoView(node);
        return;
      }
    }
  }

  /** Focusable nodes in tree order, from `root` down. Windows are their own
   * focus roots, so a nested `<window>` or `<popup>` is not walked into —
   * except when it _is_ the root, which is how a modal popup's own
   * focusables are reached. */
  _focusables(root = this._scopeRoot()) {
    const out = [];
    const walk = (node) => {
      if (node.hidden) return;
      if (this._isFocusable(node)) out.push(node);
      for (const child of node.children) {
        if (!child.isWindow) walk(child);
      }
    };
    walk(root);
    return out;
  }

  /** Tab order, following the DOM's sequential focus navigation: positive
   * `tabIndex` first in ascending order, then the implicit-zero group in tree
   * order. `tabIndex={-1}` is focusable by press and `focus()` but never
   * tabbable. Ties keep tree order (the sort is made stable by index). */
  _tabbables(root) {
    return this._focusables(root)
      .map((node, i) => ({ node, i, order: node.props.tabIndex ?? 0 }))
      .filter((e) => e.order >= 0)
      .sort((a, b) => {
        if (a.order === b.order) return a.i - b.i;
        if (a.order === 0) return 1;
        if (b.order === 0) return -1;
        return a.order - b.order;
      })
      .map((e) => e.node);
  }

  _cycleFocus(backwards) {
    const manager = this.focusManager;
    if (manager !== this) return manager._cycleFocus(backwards);
    const list = this._tabbables();
    if (list.length === 0) return;
    const index = list.indexOf(this.focused);
    if (index === -1) {
      // nothing focused, or focus sits outside the current scope: Tab enters
      this.focus(backwards ? list[list.length - 1] : list[0], 'key');
      return;
    }
    this.focus(
      backwards
        ? list[(index || list.length) - 1]
        : list[(index + 1) % list.length],
      'key',
    );
  }

  /** Called when a node leaves the tree so stale references don't linger. */
  forget(node) {
    if (this.downNode === node) this.downNode = null;
    if (this.capturedNode === node) this.capturedNode = null;
    this.node._dragSession?.forget(node);
    this.hoverPath = this.hoverPath.filter((n) => n !== node);
    const manager = this.focusManager;
    // a scope closing restores focus, so pop before the focus reference goes
    manager.popScope(node);
    if (manager.focused === node) manager.focused = null;
    if (manager._previousFocus === node) manager._previousFocus = null;
  }
}

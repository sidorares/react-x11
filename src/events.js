// Synthetic event system: ntk window events → capture/target/bubble dispatch
// over the drawn node tree, with hit testing, click synthesis, hover
// enter/leave, the wheel and focus/Tab traversal.
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
import { hooks as a11yHooks, isFocusable } from './a11y.js';
import { Composer, composeTableFor } from './compose.js';

const XK_TAB = 0xff09;
// The core protocol has no wheel: it is a click of button 4/5 (vertical) or
// 6/7 (horizontal). ntk derives its `wheel` event from those presses — or,
// where the connection has XI2, from the scroll valuators that carry the real
// distance — so the presses themselves are noise on the button path, the way
// a wheel release always was.
const WHEEL_BUTTONS = new Set([4, 5, 6, 7]);
/**
 * How far one notch of the wheel scrolls, in pixels.
 *
 * ntk reports a scroll in **notches**: a mouse wheel's click, or the fraction
 * of one a touchpad measured, `increment` being what the device says makes a
 * whole one. That is the only unit a device agrees on — how far a notch
 * *travels* is a toolkit's decision, and this is ours. Everything downstream
 * of the dispatch is in pixels (`canScroll`/`scrollBy` take them, so does
 * every registered element that answers the wheel), so the conversion happens
 * here, once, and `deltaX`/`deltaY` mean pixels wherever they are read.
 *
 * The same step an arrow key takes (`SCROLL_KEY_STEP`, nodes.js), so a notch
 * and an arrow press move a list by the same amount.
 */
export const WHEEL_NOTCH_PX = 48;
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

// 'MouseDown' → 'mouseDown', memoized — the set of names is small and
// closed, and dispatch runs at motion rate
const TYPE_NAMES = Object.create(null);
function eventType(name) {
  return (TYPE_NAMES[name] ??= name[0].toLowerCase() + name.slice(1));
}

/**
 * One synthetic event, methods on the prototype: they used to be built as
 * four fresh closures on every event object, which at motion rate was
 * steady allocation for the GC to chew on (issue #188). Handlers only ever
 * call them as methods (`ev.capturePointer()`), the same contract DOM
 * events have.
 */
class SyntheticEvent {
  constructor(manager, type, native, target, extra) {
    this._manager = manager;
    this._targetNode = target;
    this.type = type;
    this.x = native?.x ?? 0;
    this.y = native?.y ?? 0;
    this.target = manager._public(target);
    this.currentTarget = null;
    this.nativeEvent = native;
    // X11 modifier mask: bit 0 Shift, bit 2 Control. Carried on every
    // event, not just keys — shift+click needs it too.
    this.shiftKey = Boolean(native?.buttons & 1);
    this.ctrlKey = Boolean(native?.buttons & 4);
    this.defaultPrevented = false;
    this.propagationStopped = false;
    if (extra) Object.assign(this, extra);
    if (target.abs) {
      this.localX = this.x - target.abs.x;
      this.localY = this.y - target.abs.y;
    }
  }

  preventDefault() {
    this.defaultPrevented = true;
  }

  stopPropagation() {
    this.propagationStopped = true;
  }

  // Pointer capture, DOM-like: while captured, mousemove/mouseup go to the
  // capturing node instead of whatever is under the pointer, so a drag
  // keeps working past the widget's own bounds. Released automatically on
  // mouseup and when the node unmounts.
  capturePointer() {
    this._manager.capturedNode = this._targetNode;
  }

  releasePointer() {
    if (this._manager.capturedNode === this._targetNode) {
      this._manager.capturedNode = null;
    }
  }
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
 * keydown/keyup, focus/blur and WM messages. Motion and the wheel are the
 * opposite case and stay on the paced frame — the hover diffing motion
 * drives, and a scroll whose distance ntk sums over the frame.
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
 * frames.js for the frame gate that keeps a burst from painting ten times.
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
    // whether the press's default action ran, which is what the drag and the
    // release that continue the same gesture follow
    this._downDefaulted = false;
    this.capturedNode = null;
    this.focused = null;
    // the focused node and its ancestors, which is what draws `:focus-within`
    this.focusWithinPath = [];
    // what had focus before `focused`, so a focus scope opened by something
    // that focuses itself still knows where to hand focus back
    this._previousFocus = null;
    // focus scopes, innermost last: [{ node, restore }]
    this.scopes = [];
    // resolved lazily for popups: the manager that owns focus (focusManager)
    this._focusOwner = null;
    // the dead-key/Compose state machine, built on the first key (undefined
    // until then, null when the app turned composition off)
    this._composerInstance = undefined;
    // whether the X server sends keys to this window at all. Assume yes
    // until told otherwise: ntk < 3.7 never reports focus changes, and a
    // toolkit that believed it was unfocused would blink no caret at all.
    this.windowFocused = true;
    this._lastClick = { time: 0, x: 0, y: 0, detail: 0 };
    // the sub-pixel part of a smooth scroll the default action has not spent
    // yet — see `_onWheel`, which moves whole pixels so the scroll blit stays
    // available
    this._wheelOwed = { x: 0, y: 0 };
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
    // ntk's own event, derived from the wheel buttons or from XI2's scroll
    // valuators (ntk >= 7.5.0) — one shape whichever the connection turned
    // out to have. Paced rather than discrete because ntk coalesces it, and
    // it coalesces by *adding up*: a touchpad reports a scroll dozens of
    // times a frame, and the frame's event carries the sum of them rather
    // than the last one, so pacing costs distance nothing.
    wnd.on('wheel', (ev) => this._onWheel(ev));
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
    // a half-typed accent does not wait for the user to come back: the keys
    // that would finish it are going somewhere else now
    if (!focused) this._endComposition(native);
    const node = this.focused;
    if (node && !node.destroyed) {
      if (focused) node.defaultFocus?.();
      else node.defaultBlur?.();
    }
    // …and the things that keep a window of their own open on the strength
    // of this one having focus — a menu, a dropdown — which the focused node
    // keeping its focus would otherwise never tell (`WindowNode`, nodes.js)
    this.node._notifyWindowFocus?.(focused);
    a11yHooks.windowFocus?.(this.node, focused);
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
      path.push(n);
      if (n === this.node) break;
    }
    return path.reverse();
  }

  _makeEvent(type, native, target, extra) {
    return new SyntheticEvent(this, type, native, target, extra);
  }

  /**
   * Capture → target → bubble along the ancestor path. A caller that
   * already built the target's path for its own bookkeeping passes it in;
   * everyone else lets the default build it. Returns the event.
   */
  dispatch(name, target, native, extra, path = this._path(target)) {
    const ev = this._makeEvent(eventType(name), native, target, extra);
    // the two handler keys are per dispatch, not per node visited
    const bubbleKey = 'on' + name;
    const captureKey = bubbleKey + 'Capture';
    // Each handler is called inside callHandler: a throw here has no React
    // on the stack to catch it, so bare it would unwind into ntk's socket
    // handler and take the process. Reported and stepped over instead —
    // one bad handler must not stop the ones after it, or the frame loop.
    for (const n of path) {
      const handler = n.props[captureKey];
      if (handler) {
        ev.currentTarget = this._public(n);
        callHandler(n, captureKey, handler, ev);
        if (ev.propagationStopped) return ev;
      }
    }
    for (let i = path.length - 1; i >= 0; i--) {
      const handler = path[i].props[bubbleKey];
      if (handler) {
        ev.currentTarget = this._public(path[i]);
        callHandler(path[i], bubbleKey, handler, ev);
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

  /**
   * Answer an input the grab brought in from outside the window with the
   * dismissal it is, and say so. Both the press and the wheel end here: a
   * menu is anchored to something, and scrolling that something away is as
   * much "I am doing something else now" as clicking beside it.
   */
  _dismissOutside(native) {
    if (!this._pressOutside(native)) return false;
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
    return true;
  }

  /**
   * A scroll: ntk's `wheel`, in notches, whatever measured it.
   *
   * On a connection with XI2 that is the scroll valuators of the device the
   * user actually touched, so a touchpad's two-finger scroll arrives as the
   * fractions of a notch it really was — and arrives at all, where the
   * emulated button 4/5 it also sends could only ever say "one notch, again".
   * Everywhere else it is that button, worth exactly one notch, which is the
   * most a press can carry. Neither is named below: the difference is the
   * value of `deltaY`, and `ev.smooth` for a handler that wants to know
   * whether the device it is reading can do better than whole notches.
   *
   * Continuous priority, as in the DOM: a scroll is a stream of states on the
   * way somewhere rather than one, and React must be free to interrupt the
   * render it started for the notch before.
   */
  _onWheel(native) {
    // A scroll somewhere else is an interaction somewhere else: the pointer
    // grab an open menu holds brings it here, and the menu is anchored to
    // content that is about to move out from under it. Same answer the press
    // outside gets, and for the same reason (`_pressOutside`).
    if (this._dismissOutside(native)) return;
    runWithPriority(ContinuousEventPriority, () => {
      const target = this._hit(native);
      // Shift turns a vertical wheel sideways — the convention for the mouse
      // and the touchpad that have no horizontal axis. Read off the delta
      // rather than off the source: a plain wheel mouse on an XI2 connection
      // reports through the valuators too, and it still has only one axis.
      const sideways = Boolean(native.buttons & 1) && !native.deltaX;
      const notchX = sideways ? native.deltaY : native.deltaX;
      const notchY = sideways ? 0 : native.deltaY;
      const ev = this.dispatch('Wheel', target, native, {
        deltaX: notchX * WHEEL_NOTCH_PX,
        deltaY: notchY * WHEEL_NOTCH_PX,
        // whether the delta can be a fraction of a notch, not whether this
        // one is: a touchpad that happens to have travelled exactly one
        // notch this frame is still the device that can travel a third
        smooth: Boolean(native.smooth),
      });
      if (ev.defaultPrevented) return;
      // **The default action moves whole pixels and keeps the change.** A
      // scroll offset that is not an integer costs the scroll blit — the
      // server-side copy that makes a scroll cheap can only shift by whole
      // pixels, so `_applyScrollBlits` (nodes.js) declines a fractional one
      // and repaints the viewport instead. A touchpad reporting a third of a
      // notch would therefore turn every frame of the smoothest gesture the
      // renderer has into a full repaint, which is the opposite of the
      // trade. The fraction is not dropped, it is carried to the next event,
      // so a slow scroll still moves — it moves a pixel at a time.
      const owedX = this._wheelOwed.x + ev.deltaX;
      const owedY = this._wheelOwed.y + ev.deltaY;
      const dx = Math.trunc(owedX);
      const dy = Math.trunc(owedY);
      this._wheelOwed = { x: owedX - dx, y: owedY - dy };
      if (dx === 0 && dy === 0) return;
      // The nearest node out from the target that says it has somewhere to
      // go on this axis scrolls. Chaining past one that fits its own content
      // is what a browser does, and it matters now that any `<box>` can be a
      // scroll container — a pane that happens to fit must not swallow the
      // wheel the window would have answered. The `<window>` is the last
      // candidate, then the walk stops.
      //
      // Two methods and no kinds: `<textarea>` scrolls pixels it painted
      // rather than children it laid out, and so does a registered
      // element that draws its own content, and neither of them should
      // have to be named here to be reachable (issue #253).
      for (let n = target; n; n = n.parent) {
        if (n.canScroll?.(dx, dy)) {
          n.scrollBy({ x: dx, y: dy });
          break;
        }
        if (n === this.node) break;
      }
    });
  }

  _onMouseDown(native) {
    // the wheel arrived as `wheel`, with a distance the press cannot carry
    if (WHEEL_BUTTONS.has(native.keycode)) return;
    if (clickToComponentHandler && Boolean(native.buttons & MOD1_MASK)) {
      clickToComponentHandler(this._hit(native), native);
      return;
    }
    if (this._dismissOutside(native)) return;
    runWithPriority(DiscreteEventPriority, () => {
      const target = this._hit(native);
      this.downNode = target;
      this.downPath = target ? this._path(target) : [];
      // the caret is about to move, and the accent was aimed at where it was
      this._endComposition(native);
      this._setPressed(this.downPath);
      this._focusFromPress(target);
      const ev = this.dispatch(
        'MouseDown',
        target,
        native,
        {
          button: native.keycode,
          detail: this._clickDetail(native),
        },
        this.downPath,
      );
      // A gesture is vetoed at its press, once: the drag and the release
      // that continue it are the same gesture, so an element whose
      // `defaultMouseDown` never ran does not then get told about motion it
      // has no press behind. `<textinput>` guarded that itself with a
      // `_dragging` flag; a registered element should not have to rediscover
      // the need for one (issue #251).
      this._downDefaulted = !ev.defaultPrevented;
      if (this._downDefaulted) {
        target.defaultMouseDown?.(ev);
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
          target?.defaultContextMenu?.(menuEv);
        }
      }
    });
  }

  _onMouseUp(native) {
    if (WHEEL_BUTTONS.has(native.keycode)) return; // wheel release
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
        // the count the press was given: a release and the click synthesized
        // from it are the *same* multi-click as the mousedown that opened it,
        // and `onClick` is where a double click is actually handled
        detail: this._lastClick.detail,
      });
      // capture ends with the gesture, like implicit DOM pointer capture
      this.capturedNode = null;
      this._clearPress();
      if (this._downDefaulted && this.downNode && !this.downNode.destroyed) {
        this.downNode.defaultMouseUp?.(ev);
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
            detail: this._lastClick.detail,
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
      const ev = this.dispatch('MouseMove', target, native, undefined, path);
      // drags deliver to the pressed node even when the pointer leaves it —
      // unless the press that started them was vetoed, see `_downDefaulted`
      if (this._downDefaulted && this.downNode && !this.downNode.destroyed) {
        this.downNode.defaultMouseDrag?.(ev);
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
   * (`<textinput>`). `focusable={false}` and `disabled` opt back out. The
   * rule itself lives in a11y.js, shared with the focus ring and the
   * AT-SPI FOCUSABLE state. */
  _isFocusable(node) {
    return isFocusable(node);
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

  /**
   * The composition state machine for this keyboard focus, or null when the
   * app turned composition off. On the focus manager, because a composition
   * belongs to *the* keyboard: a `<popup>` shares the owner window's focus,
   * and a half-typed accent has to survive a dropdown opening under it.
   *
   * Built lazily from the root's table (`createRoot({ compose })`), which is
   * also why an app object that never went through `createRoot` — a mock, a
   * unit test — still composes: `composeTableFor` falls back to the
   * built-ins rather than to nothing.
   */
  _composer() {
    const manager = this.focusManager;
    if (manager !== this) return manager._composer();
    if (this._composerInstance === undefined) {
      const table = composeTableFor(this.node.app);
      this._composerInstance = table ? new Composer(table) : null;
    }
    return this._composerInstance;
  }

  /**
   * One composition event, defaultable like any other: the application's
   * `onCompositionStart` / `onCompositionUpdate` / `onCompositionEnd` first,
   * then the element's own `defaultComposition` unless one of them called
   * `preventDefault()`. Same seam, same order as `defaultKeyDown`.
   */
  _composition(phase, target, data, native) {
    const ev = this.dispatch('Composition' + phase, target, native, { data });
    if (!ev.defaultPrevented) target.defaultComposition?.(ev);
    return ev;
  }

  /** Run a composer step that has already been probed, as the events an
   * element and an application see. */
  _compose(composer, step, target, native) {
    const was = composer.composing;
    composer.apply(step);
    if (!was) this._composition('Start', target, '', native);
    if (composer.composing) {
      this._composition('Update', target, step.preedit, native);
    } else {
      this._composition('End', target, step.text ?? '', native);
    }
  }

  /**
   * Abandon an open composition, discarding what it had so far.
   *
   * Focus moving, the window losing the keyboard, a press putting the caret
   * somewhere else: in all three the accent was aimed at a place the user
   * has left, and committing it there would put a character where nobody
   * was looking. The element hears an `End` with no data, which is what
   * clears its preedit.
   */
  _endComposition(native = null) {
    const manager = this.focusManager;
    if (manager !== this) return manager._endComposition(native);
    const composer = this._composerInstance;
    if (!composer?.composing) return;
    composer.reset();
    const focused = this.focused;
    const target = focused && !focused.destroyed ? focused : this.node;
    this._composition('End', target, '', native);
  }

  _onKey(name, native) {
    runWithPriority(DiscreteEventPriority, () => {
      const wnd = this.node.window;
      // ntk decodes the key on the way in (window.js decorates the event
      // with keysym/baseKeysym/codepoint), so re-deriving it from the
      // keymap here was redundant. `baseKeysym` — group 1, level 1 — is
      // what shortcut comparisons want (XK_TAB even under Shift), which is
      // exactly what the old level-0 read gave. The keymap lookup stays as
      // the fallback for synthetic events that skip ntk's decoration.
      const keysym =
        native.baseKeysym ?? wnd.X?.keycode2keysyms?.[native.keycode]?.[0];
      // the focused node may live inside a <popup> of this window: focus is
      // shared with the popup (see focusManager), key delivery follows it
      const focused = this.focusManager.focused;
      const target = focused && !focused.destroyed ? focused : this.node;
      // Composition reads the keysym the key *typed*, not the base one:
      // a dead key is routinely a shifted or AltGr level of a key whose
      // level 1 is an ordinary character, and `baseKeysym` is that
      // character. Shortcuts want the base — the reason it is on the event
      // at all — and composition wants what was actually produced.
      // …and it does not run at all for an element that forwards raw key
      // events to something with an input method of its own: composing here
      // would eat the dead key on its way to an embedded client, which then
      // receives neither the key nor the character (`<foreign>`).
      const composer =
        name === 'KeyDown' && target.composes !== false
          ? this._composer()
          : null;
      const step = composer?.probe(native.keysym ?? keysym) ?? null;
      const composing = Boolean(step?.consumed);
      const ev = this.dispatch(name, target, native, {
        keycode: native.keycode,
        keysym,
        // A key the composition is going to take types nothing on its own:
        // its text arrives on the composition event instead. Reporting the
        // code point as well is what would make `Compose o c` insert `oc©`
        // in any application that types from `onKeyDown` — the renderer's
        // own elements included.
        codepoint: composing ? undefined : native.codepoint,
        key:
          !composing && native.codepoint && native.codepoint >= 0x20
            ? String.fromCodePoint(native.codepoint)
            : undefined,
        composing,
      });
      if (ev.defaultPrevented) return;
      // A release has no traversal after it, but it does have a default
      // action: an element that answers the whole keystroke rather than the
      // press — one forwarding into an embedded client (`<foreign>`) — needs
      // the other half of the pair, or the client sees a key that never
      // comes up.
      if (name !== 'KeyDown') {
        target.defaultKeyUp?.(ev);
        return;
      }
      // App chords, then composition, then the element, then focus
      // traversal. Composition sits above the element so that a dead key
      // cannot also trigger an editing action, and below the application so
      // that an `onKeyDown` chord still wins — `preventDefault()` above
      // returned already, with the composer's state untouched, which is why
      // `probe` and `apply` are separate.
      if (step && (step.consumed || step.text != null)) {
        this._compose(composer, step, target, native);
        // A key that ended a sequence without belonging to it — an arrow
        // after a pending accent — has committed the accent and now takes
        // its ordinary turn.
        if (step.consumed) return;
      }
      // The element's own behaviour first, focus traversal after it — Tab is
      // an ordinary defaultable key rather than one the focus manager eats on
      // the way past. Cycling first meant an editor could only keep Tab as an
      // indent key through a *user-level* handler, which is a wiring an
      // element cannot ship with itself (issue #251).
      //
      // A default action that consumed the key says so by calling
      // `preventDefault()` — the same word, one layer down: what it prevents
      // now is the default action left after it, which for Tab is the focus
      // cycle. Nothing in core consumes Tab, so `<textinput>` and friends
      // still hand it straight to traversal.
      target.defaultKeyDown?.(ev);
      if (keysym === XK_TAB && !ev.defaultPrevented) {
        this._cycleFocus(Boolean(native.buttons & 1));
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
   *
   * `backwards` is only meaningful for `reason: 'key'`, and only one element
   * has ever needed it: XEmbed distinguishes a Tab arriving forwards from a
   * back-Tab, because that is what tells an embedded client whether to focus
   * its first widget or its last (`<foreign>`, src/foreignnodes.js). It
   * reaches the node through `defaultFocus({ reason, backwards })`.
   */
  focus(node, reason = 'script', backwards = false) {
    const manager = this.focusManager;
    if (manager !== this) return manager.focus(node, reason, backwards);
    if (node === this.focused) return;
    // before `focused` moves, so the element that was collecting the
    // sequence is the one told to drop it
    this._endComposition();
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
      old.defaultBlur?.();
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
      if (this.windowFocused) node.defaultFocus?.({ reason, backwards });
      node.props.onFocus?.(this._makeEvent('focus', null, node));
      node.root?.invalidate(false, node, 'focus');
    }
    this._updateFocusWithin(node);
    a11yHooks.focus?.(old, node);
  }

  /**
   * Flip `:focus-within` over the focused node's ancestor chain, diffed the
   * way hover and the press chain are.
   *
   * It is the answer to "this row should light up while the field inside it
   * has focus", which is otherwise the one thing a state block cannot say —
   * the field is a descendant, and the row has no state of its own to react
   * to. Nothing relational is added by it: the chain is a walk up `parent`,
   * the same one `Node.focusWithin` already reports, and a `<popup>` counts
   * as inside the node it hangs off in the JSX tree, so a `Select` with its
   * menu open still reads as focused.
   */
  _updateFocusWithin(node) {
    const path = [];
    for (let n = node; n; n = n.parent) path.push(n);
    path.reverse();
    const old = this.focusWithinPath;
    const common = sharedPrefix(old, path);
    for (let i = old.length - 1; i >= common; i--) {
      if (!old[i].destroyed) old[i].setStyleState(':focus-within', false);
    }
    for (let i = common; i < path.length; i++) {
      path[i].setStyleState(':focus-within', true);
    }
    this.focusWithinPath = path;
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

  /**
   * Tab to something inside a scrolling box and it should be on screen.
   *
   * Asks `isScroller()` rather than whether the method exists: every `<box>`
   * carries `scrollIntoView` now, and one that is not a scroll container
   * would end the walk without revealing anything.
   */
  _scrollIntoView(node) {
    for (let n = node.parent; n; n = n.parent) {
      if (n.isScroller?.()) {
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
      this.focus(backwards ? list[list.length - 1] : list[0], 'key', backwards);
      return;
    }
    this.focus(
      backwards
        ? list[(index || list.length) - 1]
        : list[(index + 1) % list.length],
      'key',
      backwards,
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
    // the ancestors above a departing node keep `:focus-within` until focus
    // actually moves, which is right — what must not survive is the node
    manager.focusWithinPath = manager.focusWithinPath.filter((n) => n !== node);
  }
}

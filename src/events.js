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
import { callHandler, reportHandlerError } from './errors.js';
import { armDrag } from './dnd.js';
import { desktopSettings } from './desktopsettings.js';
import { noteInputTime } from './inputtime.js';
import {
  hooks as a11yHooks,
  isFocusable,
  isTextControl,
  effectivelyVisible,
} from './a11y.js';
import { Composer, composeTableFor } from './compose.js';
import { acceleratorKeysym } from './keyboard.js';
import { MOD } from './keysyms.js';

const XK_TAB = 0xff09;
const XK_ESCAPE = 0xff1b;
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
    // Native coordinates are device pixels off the wire; handlers are
    // application code, which thinks in the logical pixels it wrote its
    // styles in — so the divide happens here, at the one door events leave
    // by, and `localX` below subtracts an `abs` divided the same way
    // (src/scale.js). Everything *internal* — hit testing, drag
    // thresholds, the scroll accumulator — keeps reading `native`.
    const s = manager.scale;
    this._manager = manager;
    this._targetNode = target;
    this.type = type;
    this.x = (native?.x ?? 0) / s;
    this.y = (native?.y ?? 0) / s;
    this.target = manager._public(target);
    this.currentTarget = null;
    this.nativeEvent = native;
    // X11 modifier mask, DOM names: bit 0 Shift, bit 2 Control, bit 3 Mod1,
    // bit 6 Mod4. Carried on every event, not just keys — shift+click needs
    // it too, and so does Alt+drag.
    //
    // Mod1 is Alt and Mod4 is Super by *convention*: the protocol says only
    // that there are eight modifier rows, and which keys sit in them is
    // whatever the keymap says. Every toolkit ships the convention anyway
    // (GTK and Qt decode exactly these two), and the setup that remaps them
    // still has the raw mask on `nativeEvent.buttons`.
    this.shiftKey = Boolean(native?.buttons & MOD.Shift);
    this.ctrlKey = Boolean(native?.buttons & MOD.Control);
    this.altKey = Boolean(native?.buttons & MOD.Alt);
    this.metaKey = Boolean(native?.buttons & MOD.Super);
    this.defaultPrevented = false;
    this.propagationStopped = false;
    if (extra) Object.assign(this, extra);
    if (target.abs) {
      this.localX = this.x - target.abs.x / s;
      this.localY = this.y - target.abs.y / s;
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

// DevTools' element picker (see DevToolsIntegration.js). While a handler is
// installed the pointer belongs to DevTools, not to the app: motion, press
// and release are answered with the node under the pointer and go no
// further, so picking an element cannot also hover a row, press a button or
// start a drag. `Escape` cancels. Installed only while the user is actually
// picking — the crosshair in the DevTools toolbar — so the cost outside
// that is one null check per event.
let inspectHandler = null;
export function setInspectHandler(fn) {
  inspectHandler = fn;
}

/**
 * `createRoot({ restoreFocusOnReveal })`: whether a subtree coming back
 * brings the keyboard back with it (`EventManager.subtreeRevealed`).
 */
export function beginFocus(app, option) {
  if (app) app._reactX11RestoreFocus = option !== false;
}

/** Defaults to on for an app that never went through `createRoot` — a mock,
 * a unit test — the way `composeTableFor` falls back to the built-ins. */
function restoresFocusOnReveal(app) {
  return app?._reactX11RestoreFocus ?? true;
}

/* --- attention (ntk#37) ------------------------------------------------- *
 *
 * Every other event here is *routed*: hit test the pointer, build the
 * ancestor path, walk it. Attention cannot work that way, because the whole
 * point is to reach a node the pointer has **not** arrived at. So it is
 * *matched* instead: each motion event updates a velocity estimate, and every
 * registered candidate is asked "does this trajectory enter you, and how
 * soon". The nearest answer wins. There is no capture, no bubble and no
 * ancestor chain — an ancestor is not on the way to its child in any sense
 * the pointer knows about, and a handler that fired for a descendant it never
 * named would be guessing.
 *
 * Cost is the reason the candidates are a registry rather than a tree walk.
 * A window whose tree contains no `unstable_onAttention` and no
 * `:attention` block
 * runs one `Set.size` read per motion event and nothing else — see
 * `_onMouseMove`.
 *
 * **Deliberately absent from `docs/`.** This is a prototype and the shape may
 * not survive: nothing here has been calibrated against real pointer traces,
 * and the case for the handler rests on there being work worth starting
 * early, which the interaction paths measured so far mostly do not have. It
 * stays out of the documentation so that nothing comes to depend on it before
 * that is settled — `examples/attention.jsx` is the only prose, and it says
 * the same. Removing the feature is a `git revert` of the commit that added
 * it; keep it that way.
 */

/** How many pointer samples the velocity is averaged over. Two is a
 *  difference and jitters; a handful smooths a hand without adding lag
 *  anything at this timescale can feel. */
const ATTENTION_SAMPLES = 5;

/** Samples older than this are stale — a pointer that stopped and started
 *  again must not inherit the direction it had before the pause. */
const ATTENTION_SAMPLE_MS = 120;

/** Below this the pointer is settling rather than travelling (device px per
 *  ms; ~50 px/s). Extrapolating a direction from noise this small points
 *  attention at whatever happens to be off to one side, so the slow case
 *  falls back to "what is under the pointer" instead. */
const ATTENTION_MIN_SPEED = 0.05;

/** How far ahead to look, in milliseconds of travel at the current speed.
 *  This is the honest unit for it: the question a warm-up wants answered is
 *  "will the user be here soon enough for the work to have paid off", and
 *  that is a time, not a distance. Long enough to be worth acting on, short
 *  enough that a flick across the window does not nominate everything on the
 *  line. */
const ATTENTION_HORIZON_MS = 250;

/**
 * When the ray from `px,py` along `vx,vy` (device px per ms) first enters
 * `rect`, in milliseconds — 0 if it starts inside, null if it never does.
 *
 * Slab method, the standard ray/AABB test. Because the velocity is per
 * millisecond, the parameter that falls out *is* the time to arrival, which
 * is what both the horizon test and `ev.eta` want.
 */
function attentionEta(px, py, vx, vy, rect) {
  const x1 = rect.x;
  const x2 = rect.x + rect.width;
  const y1 = rect.y;
  const y2 = rect.y + rect.height;
  if (px >= x1 && px < x2 && py >= y1 && py < y2) return 0;
  let tmin = 0;
  let tmax = Infinity;
  // x slab, then y slab; a zero component means the ray never crosses that
  // axis, so it has to already be within the slab or it misses entirely
  if (vx === 0) {
    if (px < x1 || px >= x2) return null;
  } else {
    const a = (x1 - px) / vx;
    const b = (x2 - px) / vx;
    tmin = Math.max(tmin, Math.min(a, b));
    tmax = Math.min(tmax, Math.max(a, b));
  }
  if (vy === 0) {
    if (py < y1 || py >= y2) return null;
  } else {
    const a = (y1 - py) / vy;
    const b = (y2 - py) / vy;
    tmin = Math.max(tmin, Math.min(a, b));
    tmax = Math.min(tmax, Math.max(a, b));
  }
  if (tmin > tmax) return null;
  return tmin >= 0 ? tmin : null;
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

/**
 * Activate a node the way a finger would: the **whole press gesture**
 * through the normal dispatch — capture, bubble, handlers, the
 * discrete-priority commit and the paint that follows it.
 *
 * One function, because there is more than one way to ask for it and they
 * must not drift: an AT's `DoAction("activate")` (atspi.js) and the
 * keyboard's Space/Enter on a focused control (`Node.defaultKeyDown`,
 * nodes.js) both land here, so a control that acts on the *press* — `Select`
 * and `MenuBar` drop their menus on mousedown, the way real menus do — is
 * reached by either, and neither can be the one input route a widget forgot.
 *
 * Handlers only: the coordinate-driven default actions (caret placement,
 * drag arming) stay out, because the centre of a rect is not a place the
 * user chose.
 *
 * `source` is the native event that asked, when there was one — a key press.
 * It carries the modifier mask and the X timestamp across, so Shift+Enter on
 * a control reads as a shift-click and a handler that raises a window has a
 * real time to do it with. An AT activation has neither and passes nothing.
 */
export function synthesizeClick(node, rect, source = null) {
  const manager = node?.root?.events;
  if (!manager || node.destroyed) return false;
  const abs = rect ?? { x: 0, y: 0, width: 0, height: 0 };
  const native = {
    x: Math.round(abs.x + abs.width / 2),
    y: Math.round(abs.y + abs.height / 2),
    // the X `state` mask, which is where SyntheticEvent reads shift/ctrl/
    // alt/super from on *every* event, not just keys
    buttons: source?.buttons ?? 0,
    keycode: 1,
    time: source?.time,
  };
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

export class EventManager {
  constructor(windowNode) {
    this.node = windowNode;
    // resolved before any window realizes, constant after (src/scale.js)
    this.scale = windowNode?.scale ?? 1;
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
    // The cursor the window is already wearing. `null` rather than
    // undefined on purpose: `null` *is* a cursor — X None, "inherit the
    // parent's" — and it is the one a window starts with, so the first
    // hover over a subtree that names no cursor has nothing to change.
    this._appliedCursor = null;
    // Attention (ntk#37): the one node the pointer looks like it is heading
    // for, the recent pointer samples the trajectory is estimated from, and
    // the window's candidate registry held directly so the motion path costs
    // one property read to find out there is nothing to do.
    this.attentionNode = null;
    this._attentionSamples = [];
    this._attentionNodes = windowNode?._attentionNodes ?? new Set();
    this.focused = null;
    // the focused node and its ancestors, which is what draws `:focus-within`
    this.focusWithinPath = [];
    // what had focus before `focused`, so a focus scope opened by something
    // that focuses itself still knows where to hand focus back
    this._previousFocus = null;
    // focus scopes, innermost last: [{ node, restore }]
    this.scopes = [];
    // what focus to hand back to a subtree that comes out of hiding, keyed by
    // the node that hid: hidden node → { node, visible } (subtreeHidden)
    this._hiddenFocus = new WeakMap();
    // resolved lazily for popups: the manager that owns focus (focusManager)
    this._focusOwner = null;
    // on a *top-level* window's manager: which of this window's managers
    // took node focus last, and so answers keys addressed to any of them
    // (`_keyManager`). Its own, until a nested `<window>` says otherwise.
    this._focusHolder = null;
    // the dead-key/Compose state machine, built on the first key (undefined
    // until then, null when the app turned composition off)
    this._composerInstance = undefined;
    // whether the X server sends keys to this window at all. Assume yes
    // until told otherwise: ntk < 3.7 never reports focus changes, and a
    // toolkit that believed it was unfocused would blink no caret at all.
    this.windowFocused = true;
    // on a *focus* manager: which of the windows sharing this focus holds
    // the X input focus, when it is not this one — a managed `<popup>` is a
    // window the WM focuses in its own right (`keyboardFocused`). Null until
    // one of them says so, which leaves the answer this window's own.
    this._keyboardWindow = null;
    // what the focused node was last told about the keyboard, so the two
    // windows' focus events settle it once rather than twice
    // (`_syncDefaultFocus`)
    this._defaultFocusOn = false;
    this._lastClick = { time: 0, x: 0, y: 0, detail: 0 };
    // the sub-pixel part of a smooth scroll the default action has not spent
    // yet — see `_onWheel`, which moves whole pixels so the scroll blit stays
    // available
    this._wheelOwed = { x: 0, y: 0 };
    // the window's DragSession while a press has armed it (src/dnd.js)
    this._dragArmed = null;
    // on a *top-level* window's manager: the chords bound anywhere in its
    // tree, newest last (`registerAccelerator`). Null until one is bound,
    // which is the common case and costs one null check per key.
    this._accelerators = null;
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

  /**
   * Whether the keyboard is on this focus — which is not the same question
   * as whether it is on this *window*.
   *
   * One node is focused per focus manager, and a manager can span more than
   * one X window: a `<popup>` shares its owner's focus, and a managed one —
   * a `<Dialog>` — is a real window the window manager focuses in its own
   * right. Opening one moves the X focus off the owner and onto the popup,
   * so the owner's `windowFocused` goes false at the very moment the field
   * inside the dialog starts receiving keys. Asking the owner alone is how
   * a focused field ends up with a `:focus` ring and no caret (issue #333).
   *
   * So the answer is the group's: whichever of its windows last took the X
   * focus, or this one while none has said otherwise.
   */
  get keyboardFocused() {
    const manager = this.focusManager;
    if (manager !== this) return manager.keyboardFocused;
    // a dialog that closed while it held the keyboard leaves a record of a
    // window that is not there any more, and the answer is this one's again
    if (manager._keyboardWindow?.node.destroyed) manager._keyboardWindow = null;
    return (manager._keyboardWindow ?? manager).windowFocused;
  }

  /**
   * Tell the focused node whether the keyboard is actually on it — the
   * `_focused` flag, the caret and its blink timer, which is everything
   * `:focus` does not cover.
   *
   * Driven from here rather than from either window's focus event, because
   * the two arrive in an order nobody chooses: opening a `<Dialog>` blurs
   * the owner *before* it focuses the popup, and only one of those two
   * managers has the focused node. Running it on both, against the group's
   * answer, settles them the same way whichever lands last — and the record
   * of what the node was last told is what keeps a `defaultFocus` from
   * arming a second blink timer over the first.
   */
  _syncDefaultFocus() {
    const on = this.keyboardFocused;
    if (on === this._defaultFocusOn) return;
    this._defaultFocusOn = on;
    const node = this.focused;
    if (!node || node.destroyed) return;
    if (on) node.defaultFocus?.();
    else node.defaultBlur?.();
  }

  /**
   * The manager of the top-level window this one belongs to.
   *
   * A nested `<window>` is a child X window *inside* a top-level one, and a
   * `<popup>` hangs off it; the X input focus only ever lands on the
   * top-level (or, for a managed popup, on the popup itself, whose keys the
   * owner already answers). So the top-level is the one place where "which
   * of our windows is the keyboard's" can be recorded — see `_keyManager`.
   */
  get topLevelManager() {
    const manager = this.focusManager;
    const owner = manager.node.parent?.root?.events;
    return owner && owner !== manager ? owner.topLevelManager : manager;
  }

  /**
   * The manager a key that arrived *here* should be dispatched through.
   *
   * Focus is per `<window>` (docs/events.md), but delivery is not ours to
   * choose: X sends a key to the focus window, or to the descendant of it
   * the pointer happens to be over. With a nested `<window>` those come
   * apart — the field is focused in the inner window's manager while the
   * keyboard belongs to the outer one — and the key used to be dispatched
   * against a manager with no focused node at all, which is a key that
   * types nothing. It also meant *the pointer* decided whether typing
   * worked: park it over the inner window and the same keystroke arrived
   * somewhere else.
   *
   * So the window that holds the focused node answers, whichever of this
   * top-level's windows the key was addressed to. `focus()` records it
   * because only it knows the order they were focused in; a record whose
   * node has since gone is no better than none (issue #331).
   */
  _keyManager() {
    const manager = this.focusManager;
    const holder = manager.topLevelManager._focusHolder;
    // The record wins over this window's own `focused`, which is not the
    // same question: focus is per window, so a nested `<window>` the user
    // has since left still has a focused node in it. One of them is where
    // the user is typing, and that is the one that took focus last.
    if (
      holder &&
      !holder.node.destroyed &&
      holder.focused &&
      !holder.focused.destroyed
    ) {
      return holder;
    }
    return manager;
  }

  /**
   * DOM-style click counting: repeated presses close enough together in time
   * and space bump `detail` (2 = double click, 3 = triple …).
   *
   * The window and the distance are the desktop's — `Net/DoubleClickTime`
   * and `Net/DoubleClickDistance` — falling back to 400ms/4px where no
   * settings daemon answered. A double click that needs to be faster here
   * than everywhere else on the desktop is a double click people miss.
   */
  _clickDetail(native) {
    const now = Date.now();
    const last = this._lastClick;
    const { doubleClickMs, doubleClickDistance } = desktopSettings(
      this.node?.app,
    );
    // the desktop's slop is logical pixels; the coordinates are device
    const slop = doubleClickDistance * this.scale;
    const detail =
      now - last.time < doubleClickMs &&
      Math.abs(native.x - last.x) <= slop &&
      Math.abs(native.y - last.y) <= slop
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
    const changed = this.windowFocused !== focused;
    this.windowFocused = focused;
    // Recorded even when nothing changed here. A window assumes it has the
    // keyboard until told otherwise (`windowFocused`), so the FocusIn that
    // actually hands a managed `<popup>` the keyboard is a no-op *for the
    // popup* — while the manager holding the focused node is another one
    // again, and has just been told the keyboard left (`keyboardFocused`).
    const manager = this.focusManager;
    if (focused) manager._keyboardWindow = this;
    else if (manager._keyboardWindow === this) manager._keyboardWindow = null;
    // a half-typed accent does not wait for the user to come back: the keys
    // that would finish it are going somewhere else now
    if (changed && !focused) this._endComposition(native);
    // …and the focused node hears the focus group's answer, not this
    // window's, whichever of them the X focus just moved between
    manager._syncDefaultFocus();
    if (!changed) return;
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
    // The first wheel is what says this window wants smooth scrolling. It was
    // created on core events — an XI2 selection costs four times as many
    // bytes per *pointer move*, which a window that is never scrolled would
    // pay for nothing — and takes the selection here, once (nodes.js,
    // `upgradeToXI2`). Ahead of the dismiss check, because a scroll this
    // window heard is a scroll this window heard whatever it does with it.
    this.node.upgradeToXI2?.();
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
      // The element's own wheel, ahead of the scroll chain and in its own
      // shape: the whole event, at the node the pointer is over. A graph
      // pane's wheel is a zoom about the pointer, which needs the point that
      // must not move (`ev.x`/`ev.y`) and the modifiers that say zoom from
      // pan — neither of which a protocol handing out deltas can carry — and
      // it answers the gesture whether or not anything "can scroll". An
      // element whose wheel *is* a scroll stays on `canScroll`/`scrollBy`
      // below; this is for the ones whose wheel is not (issue #302).
      //
      // It reads the delta before the truncation, fractions and all: whole
      // pixels are the scroll blit's business, and a zoom factor is
      // continuous.
      target.defaultWheel?.(ev);
      // …and consuming it ends the event here, so the chain never runs. Same
      // word one layer down as everywhere else in the seam: what it prevents
      // is the default action left after this one.
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
      // `ev.deltaX/Y` are logical (what handlers read); the scroll they
      // become moves device pixels, and truncating *after* the multiply is
      // what keeps the blit on whole device pixels at fractional scales.
      const owedX = this._wheelOwed.x + ev.deltaX * this.scale;
      const owedY = this._wheelOwed.y + ev.deltaY * this.scale;
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
          // built-in scrollers take the device delta whole; a registered
          // element's own scrollBy speaks the public (logical) unit
          if (n._scrollByDevice) n._scrollByDevice(dx, dy);
          else n.scrollBy({ x: dx / this.scale, y: dy / this.scale });
          break;
        }
        if (n === this.node) break;
      }
    });
  }

  _onMouseDown(native) {
    // the wheel arrived as `wheel`, with a distance the press cannot carry
    if (WHEEL_BUTTONS.has(native.keycode)) return;
    if (inspectHandler) {
      inspectHandler('select', this._hit(native), native);
      return;
    }
    if (clickToComponentHandler && Boolean(native.buttons & MOD.Alt)) {
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
    // the press that picked an element never reached the app; its release
    // must not either, or a control sees a mouseup it was never pressed for
    if (inspectHandler) return;
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
    if (inspectHandler) {
      inspectHandler('move', this._hit(native), native);
      return;
    }
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
      // Hover motion, for an element that paints its own hover state — the
      // node, the edge or the handle under the pointer lights up. Core
      // already computes the path this needs, once per motion, for `:hover`
      // and `onMouseEnter`/`Leave`; the element could not hear it (#302).
      //
      // Not while a capture holds the pointer: hover is deliberately frozen
      // for the length of a gesture (see `_updateHover` above), and the
      // motion of a gesture is `defaultMouseDrag`'s to deliver.
      if (!captured && !ev.defaultPrevented) target.defaultMouseMove?.(ev);
      // drags deliver to the pressed node even when the pointer leaves it —
      // unless the press that started them was vetoed, see `_downDefaulted`
      if (this._downDefaulted && this.downNode && !this.downNode.destroyed) {
        this.downNode.defaultMouseDrag?.(ev);
      }
      // Attention, last (ntk#37). Two reasons for the position. It is
      // speculative work, and "answer the input, not the outcome" says the
      // real response to this motion — the hover repaint, the drag — goes out
      // before anything done on a guess about the next one. And this line is
      // the whole cost of the feature for a tree that never asked for it: one
      // `size` read on a set the window built empty, no walk, no allocation.
      if (this._attentionNodes.size !== 0) this._updateAttention(native);
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
      // the pointer is somewhere else entirely: whatever it was heading for
      // in here, it is not heading for it now
      if (this._attentionNodes.size !== 0) {
        this._attentionSamples.length = 0;
        this._setAttention(null, native);
      }
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
      if (n.destroyed) continue;
      // the hover path is the ancestor chain, so a `:hover` block on a
      // parent lights up while a child is hovered — CSS semantics, for
      // free, because the path is already computed for enter/leave
      n.setStyleState(':hover', false);
      const handler = n.props.onMouseLeave;
      // the event is built only for a node with somewhere to deliver it:
      // this loop runs per motion, over a whole ancestor chain (issue #188)
      if (!handler && !n.defaultMouseLeave) continue;
      const ev = this._makeEvent('mouseLeave', native, n);
      handler?.(ev);
      // …and the element clears the hover state it painted itself, after
      // the application handler and vetoed by it, like the rest of the seam
      if (!ev.defaultPrevented) n.defaultMouseLeave?.(ev);
    }
    for (let i = common; i < newPath.length; i++) {
      const n = newPath[i];
      n.setStyleState(':hover', true);
      n.props.onMouseEnter?.(this._makeEvent('mouseEnter', native, n));
    }
    this.hoverPath = newPath;
    this._updateCursor(newPath);
  }

  /**
   * Who is the pointer heading for? Runs only when the window has
   * candidates — see the guard in `_onMouseMove`.
   *
   * Three steps, and the middle one is the whole idea. Sample the pointer to
   * get a velocity; ask every candidate when this trajectory would enter it;
   * give attention to the soonest answer inside the horizon. Nothing is hit
   * tested and nothing is walked: a candidate wins by being *ahead*, which is
   * exactly the thing a hit test cannot tell you.
   *
   * Below `ATTENTION_MIN_SPEED` there is no trajectory worth extrapolating —
   * a resting hand jitters a pixel or two and its "direction" is noise — so
   * the slow case degrades to the candidate under the pointer, which is both
   * the honest answer and the one that keeps attention from flickering around
   * the room while somebody reads.
   */
  _updateAttention(native) {
    const now = native?.time ?? Date.now();
    const samples = this._attentionSamples;
    samples.push({ x: native.x, y: native.y, t: now });
    // drop what is too old to describe the movement happening now, and cap
    // the window: this array is touched at motion rate and must not grow
    while (
      samples.length > ATTENTION_SAMPLES ||
      (samples.length > 1 && now - samples[0].t > ATTENTION_SAMPLE_MS)
    ) {
      samples.shift();
    }

    const first = samples[0];
    const dt = now - first.t;
    let vx = 0;
    let vy = 0;
    if (samples.length > 1 && dt > 0) {
      vx = (native.x - first.x) / dt;
      vy = (native.y - first.y) / dt;
    }
    const speed = Math.hypot(vx, vy);

    let best = null;
    let bestEta = Infinity;
    for (const node of this._attentionNodes) {
      // the registry is swept lazily, like `_sizeQueryNodes`: an unmount has
      // more urgent things to do than reach into every window registry
      if (node.destroyed || !node.root) {
        this._attentionNodes.delete(node);
        continue;
      }
      const rect = node.abs;
      // a node that has never been laid out has no rectangle to aim at, and
      // one that is hidden or untargetable is not somewhere the pointer can
      // arrive
      if (!rect?.width || !rect.height) continue;
      if (node.hidden || node.style.display === 'none') continue;
      if (node.style.pointerEvents === 'none') continue;
      const eta =
        speed < ATTENTION_MIN_SPEED
          ? attentionEta(native.x, native.y, 0, 0, rect)
          : attentionEta(native.x, native.y, vx, vy, rect);
      if (eta === null || eta > ATTENTION_HORIZON_MS) continue;
      if (eta < bestEta) {
        bestEta = eta;
        best = node;
      }
    }
    this._setAttention(best, native, bestEta);
  }

  /**
   * Move attention, which only one node in a window can hold.
   *
   * **The handler fires on arrival only.** Losing attention is deliberately
   * not an event: the thing the handler is for is starting work early — a
   * cache warmed, an image decoded, a query sent — and none of that wants
   * undoing because the pointer changed its mind. What *is* visual is handled
   * by `:attention`, which is cleared here like any other state, so the
   * common case needs no handler at all. If a real use for the loss turns up,
   * the seam is a second prop rather than a `null` argument every
   * handler would have to null-check.
   *
   * No capture, no bubble: see the note at the top of this file. Attention is
   * matched against a registry, so the node that matched is the only node
   * that could meaningfully hear about it.
   */
  _setAttention(node, native, eta = 0) {
    const previous = this.attentionNode;
    if (previous === node) return;
    if (previous && !previous.destroyed) {
      previous.setStyleState(':attention', false);
    }
    this.attentionNode = node;
    if (!node) return;
    node.setStyleState(':attention', true);
    const handler = node.props.unstable_onAttention;
    if (!handler) return;
    // `eta` is the point of the event rather than decoration: "the pointer
    // arrives here in about 40ms" and "in about 200ms" justify very different
    // amounts of speculative work, and only the renderer knows which it is.
    const ev = this._makeEvent('attention', native, node, {
      eta: Math.round(eta),
    });
    callHandler(node, 'unstable_onAttention', handler, ev);
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
    if (inspectHandler) {
      // Escape is the way out of a picker the user changed their mind
      // about; every other key is swallowed with the pointer.
      const wnd = this.node.window;
      const keysym = acceleratorKeysym(
        this.node.app,
        native.keycode,
        native.baseKeysym ?? wnd?.X?.keycode2keysyms?.[native.keycode]?.[0],
      );
      if (name === 'KeyDown' && keysym === XK_ESCAPE) {
        inspectHandler('cancel', null, native);
      }
      return;
    }
    // The key is this application's; which of its windows the server
    // addressed it to is not the same question as which window is holding
    // the keyboard (`_keyManager`). Redirected whole rather than target by
    // target, so composition, the focus scope Tab cycles inside and the
    // handlers the event bubbles through are all that window's.
    const manager = this._keyManager();
    if (manager !== this) return manager._onKey(name, native);
    runWithPriority(DiscreteEventPriority, () => {
      const wnd = this.node.window;
      // ntk decodes the key on the way in (window.js decorates the event
      // with keysym/baseKeysym/codepoint), so re-deriving it from the
      // keymap here was redundant. `baseKeysym` — group 1, level 1 — is
      // what shortcut comparisons want (XK_TAB even under Shift), which is
      // exactly what the old level-0 read gave. The keymap lookup stays as
      // the fallback for synthetic events that skip ntk's decoration.
      //
      // …and group 1 is Latin only until somebody puts a Cyrillic layout
      // first, or runs under XQuartz, where a layout switch rewrites the
      // keymap and leaves no Latin group at all. `acceleratorKeysym` is the
      // rest of the rule: `ev.keysym` is the Latin keysym for the key, so a
      // chord keeps matching while `ev.codepoint` types Russian (#85).
      const keysym = acceleratorKeysym(
        this.node.app,
        native.keycode,
        native.baseKeysym ?? wnd.X?.keycode2keysyms?.[native.keycode]?.[0],
      );
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
        // Which layout typed this, 0-3 — the XKB group, from bits 13-14 of
        // the event's state field. The one thing that says a layout switch
        // happened at all: switching sends no MappingNotify, because on
        // Linux the keymap did not change, only which part of it is live.
        group: native.group ?? 0,
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
      // Then the accelerators — a menu item's `shortcut`, a `useAccelerator`
      // — on that same rule, which is the whole of what keeps Ctrl+C in a
      // focused field: the element answered it and said so, and an
      // application-wide binding does not get to take it back (#351).
      if (!ev.defaultPrevented) this._runAccelerators(ev);
      if (keysym === XK_TAB && !ev.defaultPrevented) {
        this._cycleFocus(Boolean(native.buttons & 1));
      }
    });
  }

  /**
   * Bind a chord for as long as the caller is mounted. Returns the release.
   *
   * `entry.anchor()` is the node the binding belongs to, read at dispatch
   * time rather than captured: a `MenuBar` that the desktop's panel takes
   * over stops drawing a bar and still has to deliver the key, so what the
   * binding hangs off changes under it.
   *
   * `entry.handle(ev)` answers whether it took the key.
   *
   * Registrations live on the **top-level** manager, which is the one thing
   * a `<popup>`, a nested `<window>` and the window itself all share — the
   * same grouping `_keyManager` resolves keys through. So a chord reaches
   * the whole of one window's tree and none of another's.
   */
  registerAccelerator(entry) {
    const owner = this.topLevelManager;
    (owner._accelerators ??= new Set()).add(entry);
    return () => {
      owner._accelerators?.delete(entry);
    };
  }

  /**
   * Offer a key to the bindings, most recently mounted first, and stop at
   * the first that takes it.
   *
   * Two things gate a binding, and both are questions the menu already knows
   * the answer to and an `onKeyDown` does not:
   *
   * - **it is on the screen.** A binding whose node has unmounted or gone
   *   behind a `display: 'none'`, a collapsed `<Suspense>` or an unmapped
   *   `<popup>` is a menu the user cannot open, so it is not a chord they
   *   can press either. Same question `focus` asks of a hidden subtree.
   * - **it is inside the innermost focus scope.** A modal `<popup>`
   *   (`trapFocus`) takes the keyboard from everything behind it, and that
   *   has to include the application's shortcuts — Ctrl+S while a
   *   confirmation is up saves nothing. A menu declared *inside* the modal
   *   is inside the scope and still works, which is the same containment
   *   rule Tab traversal follows. With no modal open the scope root is the
   *   window itself and every binding in it qualifies.
   *
   * A menu that is *open* suppresses them by another route entirely: it
   * `preventDefault()`s the keys it is being driven with, one layer above
   * this (`components/Menu.js`).
   */
  _runAccelerators(ev) {
    const owner = this.topLevelManager;
    const entries = owner._accelerators;
    if (!entries?.size) return;
    const scopeRoot = owner._scopeRoot();
    const trapped = scopeRoot !== owner.node;
    for (const entry of [...entries].reverse()) {
      const anchor = entry.anchor();
      if (!anchor || anchor.destroyed || !effectivelyVisible(anchor)) continue;
      if (trapped && !owner._within(anchor, scopeRoot)) continue;
      // A handler that threw still *took* the key: the chord matched, and
      // offering it to the next binding would run a second command because
      // the first one failed. Reported and carried on, like every other
      // throw out of an X event (`errors.js`).
      let took = true;
      try {
        took = Boolean(entry.handle(ev));
      } catch (error) {
        reportHandlerError(anchor, 'an accelerator', error);
      }
      if (took) {
        // consumed, said the way every default action says it
        ev.preventDefault();
        return;
      }
    }
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
   * With one exception, which is CSS's too: a **text control** clicked into
   * lights a ring anyway (`_ringsOnPress`). What the pointer user knows is
   * where they clicked, not that the next keystroke will land there, and a
   * clicked field is about to swallow the keyboard — so the one thing the
   * ring says that the click did not is exactly the thing worth saying.
   *
   * `backwards` is only meaningful for `reason: 'key'`, and only one element
   * has ever needed it: XEmbed distinguishes a Tab arriving forwards from a
   * back-Tab, because that is what tells an embedded client whether to focus
   * its first widget or its last (`<foreign>`, src/foreignnodes.js). It
   * reaches the node through `defaultFocus({ reason, backwards })`.
   *
   * `restoring` says this is a subtree coming back out of hiding rather than
   * focus going somewhere new (`subtreeRevealed`), and it turns off the two
   * things that move the world to meet the node.
   */
  focus(node, reason = 'script', options = {}) {
    const manager = this.focusManager;
    if (manager !== this) return manager.focus(node, reason, options);
    const { backwards = false, restoring = false } = options;
    if (node === this.focused) return;
    // before `focused` moves, so the element that was collecting the
    // sequence is the one told to drop it
    this._endComposition();
    const old = this.focused;
    this._previousFocus = old;
    this.focused = node;
    // nothing has been told anything about the keyboard yet, whatever the
    // node that just gave up focus was told (`_syncDefaultFocus`)
    this._defaultFocusOn = false;
    // …and this window is now the one the top-level's keys belong to,
    // whichever of its windows they are addressed to (`_keyManager`)
    if (node) this.topLevelManager._focusHolder = this;
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
      // Keys only reach a node whose window has the X focus — but a restore
      // must not *take* it: a window revealing something in the background
      // would pull the keyboard off another application, and SetInputFocus
      // on a window the reveal has not mapped yet is a BadMatch. Asked of
      // the focus group rather than of this window, or focusing something
      // inside an open `<Dialog>` would drag the keyboard off the dialog
      // and back onto the window that owns it.
      if (!this.keyboardFocused && !restoring) this.node.window?.focus?.();
      node.setStyleState(':focus', true);
      node.setStyleState(
        ':focus-visible',
        reason !== 'pointer' || this._ringsOnPress(node),
      );
      // …and nothing scrolls to meet it either: the node is coming back to
      // the arrangement it left, and this reveal's layout has not run, so a
      // scroll here would be computed from a rect that does not exist yet.
      if (!restoring) this._scrollIntoView(node);
      if (this.keyboardFocused) {
        this._defaultFocusOn = true;
        node.defaultFocus?.({ reason, backwards });
      }
      node.props.onFocus?.(this._makeEvent('focus', null, node));
      node.root?.invalidate(false, node, 'focus');
    }
    this._updateFocusWithin(node);
    a11yHooks.focus?.(old, node);
  }

  /**
   * Whether a press lands `:focus-visible` on this node as well as `:focus`.
   *
   * The UA rule browsers settled on, and for the reason they settled on it:
   * a control the keyboard is about to talk to has to show that it holds the
   * keyboard, whichever way focus arrived. Clicking into a field puts the
   * caret somewhere the user chose and then makes every keystroke go there —
   * a state a button, a checkbox or a tab does not enter on a click, which
   * is why those still stay dark until Tab.
   *
   * Asked as "does this element hold editable text", not as "is its kind
   * `<textinput>`": `isTextControl` is the same predicate the AT-SPI
   * EDITABLE state is built on (src/a11y.js), so `<textarea>` and a
   * third-party editor reporting an editable text state answer yes on their
   * own — the two routes that make a node take the keyboard cannot drift.
   */
  _ringsOnPress(node) {
    return isTextControl(node);
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
    this.focus(this._canRestoreTo(scope.restore) ? scope.restore : null);
  }

  /**
   * Somewhere focus can be handed *back* to: still in the tree, still
   * focusable, and still on screen.
   *
   * Three callers ask it — a focus scope closing, an edit menu closing
   * (`closeEditMenu`, nodes.js) and a subtree coming out of hiding — and the
   * third is why the question includes visibility. Whatever a modal was
   * opened from may have suspended while it was up, and handing the keyboard
   * back to it would put keys on an invisible control by the other route.
   *
   * "Still in the tree" is part of the same answer rather than a check of its
   * own: `effectivelyVisible` starts at `destroyed`, since a node that has
   * left is not on screen either.
   */
  _canRestoreTo(node) {
    return Boolean(node && this._isFocusable(node) && effectivelyVisible(node));
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
   * focusables are reached.
   *
   * Invisible either way is invisible: `display: 'none'` takes a subtree out
   * of the layout, the paint and the hit test, so Tab has no business
   * landing in it either. */
  _focusables(root = this._scopeRoot()) {
    const out = [];
    const walk = (node) => {
      if (node.hidden || node.style.display === 'none') return;
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
      this.focus(backwards ? list[list.length - 1] : list[0], 'key', {
        backwards,
      });
      return;
    }
    this.focus(
      backwards
        ? list[(index || list.length) - 1]
        : list[(index + 1) % list.length],
      'key',
      { backwards },
    );
  }

  /**
   * A subtree just stopped being visible: `<Suspense>` showing its fallback,
   * `<Activity mode="hidden">`, or a style that turned `display: 'none'`.
   *
   * **Focus follows visibility.** Every other route already read it that way
   * — `hitTest` and `paintOrder` skip the node, `_focusables` will not Tab
   * into it — and focus was the one left open, so keys kept landing on a
   * control the user could no longer see and the application's state kept
   * advancing from them (issue #202). In a browser the browser plays this
   * part; here nobody did.
   *
   * The question is **containment**, not identity. React calls `hideInstance`
   * on the topmost host instance of a hidden branch, so in any tree deeper
   * than one node the focused control still has `hidden === false` itself and
   * is invisible only because a yoga ancestor is `DISPLAY_NONE` — the same
   * question `popScope` asks on the way out of a modal. `effectivelyVisible`
   * is the second half of it, and it is what tells a `<box>` inside the
   * hidden node from a `<popup>` hanging off it: a popup is its own X window,
   * nothing unmapped it, and it is still on screen holding the keyboard.
   */
  subtreeHidden(node) {
    const manager = this.focusManager;
    if (manager !== this) return manager.subtreeHidden(node);
    const focused = this.focused;
    if (!focused || !node.contains(focused)) return;
    if (effectivelyVisible(focused)) return;
    // Ring included: a restore puts back the state hiding took away rather
    // than making a new focus, and whether the user could see where focus
    // was is part of that state.
    this._hiddenFocus.set(node, {
      node: focused,
      visible: focused.states[':focus-visible'] === true,
    });
    this.focus(null);
  }

  /**
   * …and the way back, which is the half that is a decision rather than a
   * bug fix.
   *
   * It restores. `<Activity>` exists to keep what a hidden subtree had, and a
   * boundary re-suspending is not something the user did — so a field they
   * were typing in comes back focused and they carry on, instead of being
   * silently dropped out of it by a fallback that flashed.
   *
   * Two rules keep that from being focus stealing, and they are what make the
   * restore safe enough to be the default. It only happens when **nothing
   * else has the keyboard**: anything focused while the subtree was away
   * keeps focus, so a reveal somewhere the user is not looking can never take
   * over what they are doing. And it is a *restore* rather than a navigation
   * — no scroll, no pull on the X input focus (see `focus`).
   *
   * `createRoot({ restoreFocusOnReveal: false })` is the way out, for an app
   * that wants the browser's answer: focus that fell to the body stays there,
   * and coming back is the user's own Tab.
   */
  subtreeRevealed(node) {
    const manager = this.focusManager;
    if (manager !== this) return manager.subtreeRevealed(node);
    const was = this._hiddenFocus.get(node);
    if (!was) return;
    this._hiddenFocus.delete(node);
    if (this.focused) return;
    if (!restoresFocusOnReveal(this.node.app)) return;
    // it may have been unmounted, or hidden again by something inside the
    // subtree, while it was away
    if (!this._canRestoreTo(was.node)) return;
    this.focus(was.node, was.visible ? 'script' : 'pointer', {
      restoring: true,
    });
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

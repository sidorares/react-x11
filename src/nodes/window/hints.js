// What the window manager is told: the window's size props and their clamps,
// the CreateWindow attributes, _NET_WM_STATE, Motif decorations,
// WM_NORMAL_HINTS and transientFor.

import { flattenStyle, isEventProp } from '../../styles.js';
import { windowIdOf } from '../../windowid.js';
import { DEV, shallowEqual } from '../util.js';

// X window geometry is CARD16 and coordinates are INT16, so a window wider
// than this cannot be positioned or damaged coherently even where the server
// accepts it. Nothing sized from content should get near it; it is the
// backstop for a measure function that answered Infinity.
export const MAX_WINDOW_EXTENT = 32767;

/** One axis of an auto size, bounded the way CSS bounds `width: auto`. */
export function clampExtent(value, min, max) {
  const v = Math.ceil(Number.isFinite(value) ? value : 0);
  // CSS's resolution order: the max bound applies first and the min wins
  // over it, so `minWidth` beats `maxWidth` where an app sets both and they
  // disagree.
  const bounded = Math.max(min ?? 0, Math.min(v, max ?? Infinity));
  // A zero-dimension window is a BadValue outright, so a `<window>` with
  // nothing in it is 1x1 rather than a protocol error.
  return Math.max(1, Math.min(bounded, MAX_WINDOW_EXTENT));
}

/**
 * A bound measured from the content, held inside the space there is. Unlike
 * a size it may legitimately be 0 — a window whose every part can give has
 * no floor to speak of — and a bound the window cannot satisfy is worse than
 * none: a `minWidth` past the screen is a window that cannot be put on it.
 */
export function clampBound(value, max) {
  return Math.max(
    0,
    Math.min(Math.ceil(value), max ?? Infinity, MAX_WINDOW_EXTENT),
  );
}

/**
 * Where a `transientFor` owner sits on screen, for picking the monitor a
 * dialog should be sized against. Accepts everything `windowIdOf` does — a
 * window ref, a node, a drawn node's ref — and answers null for a raw XID,
 * which carries no geometry with it.
 */
export function screenOriginOf(target) {
  if (target == null || typeof target !== 'object') return null;
  if ('current' in target && !target.isWindow) {
    return screenOriginOf(target.current);
  }
  return (
    target._screenOrigin ??
    target.window?._screenOrigin ??
    target.root?.window?._screenOrigin ??
    null
  );
}

// Everything a <window> owns: the real geometry, and the WM size hints that
// constrain it. On a <window> these are never style.
export const WINDOW_HINT_PROPS = [
  'minWidth',
  'minHeight',
  'maxWidth',
  'maxHeight',
  'widthInc',
  'heightInc',
  'baseWidth',
  'baseHeight',
  'minAspect',
  'maxAspect',
  'gravity',
];

/**
 * The bounds that can be spelled `'auto'` — asked of the content rather than
 * named as a number. The increments and the aspect ratios cannot: there is
 * no content answer to what a resize step is.
 */
export const CONTENT_BOUND_PROPS = [
  'minWidth',
  'minHeight',
  'maxWidth',
  'maxHeight',
];

/** A bound that asks the content instead of naming a number. */
export const isContentBound = (value) => value === 'auto';

/** A bound as a number, or nothing where it is the content's to answer. */
export const numericBound = (value) =>
  isContentBound(value) ? undefined : value;

/**
 * A `<window width>`/`<height>` that is not a number: sized from its own
 * content instead. CSS's initial value for `width`, and the same meaning —
 * for a box whose containing block is the viewport but which is not in flow
 * (a float, an abspos, an inline-block) `auto` is shrink-to-fit, and a
 * top-level window is exactly that shape. It has no container to stretch
 * into; stretching into the screen is what `fullscreen` means.
 *
 * Omitting the prop is the same thing, which is why this is a `??` rather
 * than an `===`: leaving a size out cannot sensibly mean "some number
 * somebody picked", and it used to mean ntk's 800x800.
 */
export const isAutoSize = (value) => (value ?? 'auto') === 'auto';

/** A size prop reduced to what it means, so the two spellings of auto — the
 *  keyword and the missing prop — compare equal. */
export const canonicalSize = (value) => (isAutoSize(value) ? 'auto' : value);

/**
 * A `<window>` size is a number of pixels or `'auto'`, and nothing else.
 *
 * Worth its own error because the near misses all come from CSS and all look
 * reasonable: `'100%'` has no containing block to be a percentage of,
 * `'fit-content'` is what `'auto'` already means here, and `'600px'` is the
 * unit X11 works in anyway. Left to itself each of them reaches ntk as a
 * string and comes back as a `BadValue` on CreateWindow with a sequence
 * number and nothing else — an X protocol error for what is a typo in JSX.
 */
export function assertWindowSize(props, kind) {
  if (!DEV) return;
  for (const axis of ['width', 'height']) {
    const value = props[axis];
    if (value === undefined || value === 'auto') continue;
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      continue;
    }
    throw new Error(
      `react-x11: <${kind} ${axis}={${JSON.stringify(value)}}> — a window ` +
        `size is a number of pixels or 'auto' (sized to its content, ` +
        `capped at the screen), which is also what leaving ${axis} out ` +
        'means. See docs/elements.md, "Natural size".',
    );
  }
  for (const bound of CONTENT_BOUND_PROPS) {
    const value = props[bound];
    if (value === undefined || value === 'auto') continue;
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      continue;
    }
    throw new Error(
      `react-x11: <${kind} ${bound}={${JSON.stringify(value)}}> — a window ` +
        `bound is a number of pixels or 'auto' (measured from the content), ` +
        'and leaving it out means no bound at all. ' +
        'See docs/elements.md, "A floor the content decides".',
    );
  }
}

/**
 * ntk's Window constructor takes every creation attribute up front. The
 * user-facing shape and ntk's differ in three places: size hints are flat
 * props here and a `sizeHints` object there, the window background is a
 * style property here and a creation attribute there, and an `'auto'`
 * width or height is resolved to a number by `realize()` — ntk is handed
 * pixels or nothing, never the keyword.
 *
 * Event props never travel this way. ntk reads `onKeyDown` & co. off its
 * creation args and registers them as raw listeners (events_map.toSnake),
 * which would hand the application the native X event instead of the
 * synthetic one the EventManager dispatches — and hold the first render's
 * closure forever. Handlers are read from current props at dispatch time
 * instead, so they can never go stale. `children` is the tree's,
 * `transientFor` holds a React ref that only the commit phase can resolve
 * (WindowNode._applyTransientFor), `anchor` is a position `realize()` works
 * out from the size it just measured (WindowNode._anchorPlacement), and
 * `transparent` names a visual that has to be looked up on the connection
 * (WindowNode._argbAttributes) rather than a value ntk takes.
 */
// The WM hints that are distances. The aspect pair are ratios — the same in
// any unit — and `gravity` is an enum; scaling either would be wrong.
const LENGTH_HINT_PROPS = new Set([
  'minWidth',
  'minHeight',
  'maxWidth',
  'maxHeight',
  'widthInc',
  'heightInc',
  'baseWidth',
  'baseHeight',
]);

/**
 * A window's geometry props, converted to the device pixels every consumer
 * — `_measure`'s yoga math, `setState`, the WM hints — works in. Numbers
 * multiply; `'auto'` and the content bounds pass through; the identity
 * fast path keeps the 1x world allocation-free.
 */
export function scaleWindowGeometry(props, scale) {
  if (scale === 1) return props;
  const out = { ...props };
  for (const key of ['width', 'height', 'x', 'y']) {
    if (typeof out[key] === 'number') out[key] = Math.round(out[key] * scale);
  }
  for (const key of LENGTH_HINT_PROPS) {
    if (typeof out[key] === 'number') out[key] = Math.round(out[key] * scale);
  }
  return out;
}

export function windowAttributes(props, scale = 1) {
  const attributes = {};
  const hints = {};
  // Geometry props are logical pixels like everything an app writes, and
  // this is their one door into device pixels: X windows are device-pixel
  // rectangles, so the multiply happens where CreateWindow's numbers are
  // assembled, and `abs`/`_requestedSize`/ConfigureNotify all stay in one
  // unit downstream (src/scale.js). Rounded because the wire is integers.
  const device = (v) => (typeof v === 'number' ? Math.round(v * scale) : v);
  for (const key of Object.keys(props)) {
    if (key === 'children' || key === 'style' || isEventProp(key)) continue;
    if (key === 'transientFor' || key === 'transparent') continue;
    if (key === 'anchor' || key === 'hidden') continue;
    if ((key === 'width' || key === 'height') && isAutoSize(props[key])) {
      continue;
    }
    if (WINDOW_HINT_PROPS.includes(key)) {
      // An `'auto'` bound is not a number ntk can be given; `realize()`
      // measures it and merges the answer in before CreateWindow.
      if (!isContentBound(props[key])) {
        hints[key] = LENGTH_HINT_PROPS.has(key)
          ? device(props[key])
          : props[key];
      }
      continue;
    }
    attributes[key] =
      key === 'width' || key === 'height' || key === 'x' || key === 'y'
        ? device(props[key])
        : props[key];
  }
  if (Object.keys(hints).length > 0) attributes.sizeHints = hints;
  if (props.style !== undefined) {
    const style = flattenStyle(props.style);
    if (style.backgroundColor !== undefined) {
      attributes.backgroundColor = style.backgroundColor;
    }
  }
  return attributes;
}
/**
 * The `_NET_WM_STATE` names these props ask for. `states` is the general
 * mechanism; `fullscreen` and `alwaysOnTop` are sugar for the two everyone
 * reaches for, and they union rather than compete with `states`.
 */
export function windowStates(props) {
  const states = new Set(props.states ?? []);
  if (props.fullscreen) states.add('fullscreen');
  if (props.alwaysOnTop) states.add('above');
  return states;
}

/**
 * One state per message. EWMH gives a `_NET_WM_STATE` ClientMessage two
 * state slots — which is what `'maximized'` uses, expanding to the
 * vert/horz pair — so anything longer has to be several messages, and
 * splitting by name is the only chunking that cannot land a pair across a
 * boundary. These are rare, deliberate calls; the round trips do not matter.
 */
export function applyWindowStates(wnd, names, action) {
  if (typeof wnd?.setWmState !== 'function') return;
  for (const name of names) {
    // an unsupported state resolves false rather than throwing; a window
    // that went away mid-flight is not worth an unhandled rejection
    Promise.resolve(wnd.setWmState(name, action)).catch(() => {});
  }
}

// _MOTIF_WM_HINTS: flags, functions, decorations, input_mode, status.
// flags = 2 is MWM_HINTS_DECORATIONS, i.e. "only the decorations field
// here means anything". The property's type atom is the property's own
// name, not CARDINAL — the one thing that is easy to get wrong, and a WM
// that reads the type will ignore the hint if it is.
const MOTIF_HINTS = '_MOTIF_WM_HINTS';
const MOTIF_DECORATIONS = (on) => [2, 0, on ? 1 : 0, 0, 0];

export function applyDecorations(wnd, on) {
  if (typeof wnd?.setProperty !== 'function') return;
  Promise.resolve(
    wnd.setProperty(MOTIF_HINTS, MOTIF_DECORATIONS(on), {
      type: MOTIF_HINTS,
      format: 32,
    }),
  ).catch(() => {});
}

export const WINDOW_SEMANTIC_NAMES = new Set([
  'width',
  'height',
  ...WINDOW_HINT_PROPS,
]);

/** Window manager hints, installed onto `WindowNode.prototype` by window.js. */
export class WindowHints {
  /**
   * Window-manager hints that changed since the last render (ntk >= 3.5.0).
   * Creation is handled by ntk's Window constructor — every non-event prop
   * is forwarded there as a creation attribute — so this only has to cover
   * updates.
   *
   * Size hints are flat props — `minWidth`, `maxHeight`, `widthInc`… — and
   * so is the geometry they constrain. They only had to hide inside a
   * `sizeHints` object while yoga style shared this namespace; with style
   * in its own channel the names are free, and `<window minWidth={360}>`
   * means the one thing it can mean.
   */
  _applyWindowHints(next, prev) {
    const wnd = this.window;

    const hints = this._sizeHints(next);
    if (
      next.resizable !== prev.resizable ||
      !shallowEqual(hints, this._sizeHints(prev))
    ) {
      if (CONTENT_BOUND_PROPS.some((key) => isContentBound(next[key]))) {
        // A bound this commit cannot resolve: `'auto'` is a measurement, and
        // measuring leaves the tree laid out at a size that is nobody's
        // arrangement. Asking for the layout this frame owes anyway is what
        // makes it safe — `flush()` measures, sends the hints and lays the
        // tree back out, in that order.
        this.invalidate(true, null, 'props');
      } else {
        this._sendSizeHints(next);
      }
    }
    if (!shallowEqual(next.wmClass, prev.wmClass) && next.wmClass) {
      const c = next.wmClass;
      if (Array.isArray(c)) wnd.setClass?.(c[0], c[1]);
      else if (typeof c === 'object') wnd.setClass?.(c.instance, c.class);
      else wnd.setClass?.(c);
    }
    if (!shallowEqual(next.windowType, prev.windowType) && next.windowType) {
      wnd.setWindowType?.(next.windowType);
    }
    // Diffed against the *previous props*, never against what the window
    // manager currently has. That is what makes these controlled: on X the
    // WM changes state behind the app's back all the time — the user hits
    // maximize, a hotkey leaves fullscreen — and a prop re-asserted every
    // commit would fight it. React only hears about reality through
    // `onStatesChange`, and only re-asks when the app itself changes its
    // mind.
    const before = windowStates(prev);
    const now = windowStates(next);
    applyWindowStates(
      wnd,
      [...now].filter((s) => !before.has(s)),
      'add',
    );
    applyWindowStates(
      wnd,
      [...before].filter((s) => !now.has(s)),
      'remove',
    );
    if (next.decorations !== prev.decorations) {
      applyDecorations(wnd, next.decorations !== false);
    }
    if (next.transientFor !== prev.transientFor) {
      this._pendingTransientFor = undefined;
      this._applyTransientFor(next.transientFor);
    } else if (this._pendingTransientFor !== undefined) {
      // the owner was not realized last time round; every commit is another
      // chance, and a sibling window earlier in the tree is realized by now
      this._applyTransientFor(this._pendingTransientFor);
    }
  }

  /**
   * Write `WM_TRANSIENT_FOR`, resolving whatever the prop holds — a ref to a
   * `<window>`/`<popup>`, a ref to any drawn node (resolved to the window
   * that owns it), a raw XID, `'root'` for the client's whole window group,
   * or `null` to clear.
   *
   * Resolution has to happen here rather than in `windowAttributes`, which
   * copies every non-event prop straight into ntk's creation attributes: a
   * React ref is not something ntk should be asked to understand.
   *
   * **Refs attach in the layout phase, after every mutation.** So on the
   * commit that mounts two sibling `<window>`s, the second one realizes
   * while the first one's ref is still null — the owner is unresolvable
   * exactly when a single-tree multi-window app needs it. That is what
   * `_pendingTransientFor` is for: an unresolved owner is retried on the
   * next commit rather than dropped, and the frame this window schedules on
   * mount gives it one without waiting for an unrelated re-render.
   */
  _applyTransientFor(owner) {
    const wnd = this.window;
    if (!wnd || typeof wnd.setTransientFor !== 'function') return;
    if (owner == null) {
      this._pendingTransientFor = undefined;
      // only clear a property we actually wrote; a bare `undefined` on mount
      // must not cost a DeleteProperty on every window in the app
      if (this._transientForId != null) {
        this._transientForId = null;
        wnd.setTransientFor(null);
      }
      return;
    }
    const id = owner === 'root' ? 'root' : windowIdOf(owner);
    if (id == null) {
      this._pendingTransientFor = owner;
      return;
    }
    this._pendingTransientFor = undefined;
    if (id === this._transientForId) return;
    if (id === wnd.id) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn(
          'react-x11: transientFor points at the window itself. A window ' +
            'cannot own itself; the property is ignored.',
        );
      }
      return;
    }
    this._transientForId = id;
    wnd.setTransientFor(id);
  }

  /** The WM size hints among these props, as the author wrote them. */
  _sizeHints(props) {
    // WM_NORMAL_HINTS reach the window manager, which measures the real
    // window — device pixels, like every geometry prop's destination.
    const scaled = scaleWindowGeometry(props, this.scale);
    const hints = {};
    for (const key of WINDOW_HINT_PROPS) {
      if (scaled[key] !== undefined) hints[key] = scaled[key];
    }
    return hints;
  }

  /**
   * The whole `WM_NORMAL_HINTS` struct to write: what the author named, with
   * every `'auto'` replaced by the number `_measure()` resolved for it.
   *
   * Whole, because `setSizeHints` writes the property outright and carries
   * nothing over from the last call — a floor sent on its own would drop the
   * `widthInc` beside it. A bound left unresolved (a torn-down window with
   * nothing to measure) is dropped rather than sent: `'auto'` reaches the
   * wire as a CARD32 of 0, which is a floor of nothing dressed up as a
   * declaration.
   */
  _hintsToSend(props, resolved) {
    const hints = { ...this._sizeHints(props), ...resolved };
    for (const key of CONTENT_BOUND_PROPS) {
      if (isContentBound(hints[key])) delete hints[key];
    }
    if (props.resizable === false) hints.resizable = false;
    return hints;
  }

  /**
   * Write the hints, if they are not the ones already written.
   *
   * Diffed against what actually went out rather than against props: a
   * content-measured bound is recomputed on every frame that lays out, and
   * most frames move nothing. Without the check, a window with
   * `minWidth="auto"` would spend a `ChangeProperty` per frame restating a
   * number the window manager already has.
   *
   * `resizable: false` is the one hint whose meaning is not in its keys — it
   * pins min and max to the size the window has *at the call* — so the size
   * is part of what is compared, and a window that pins itself and then
   * grows re-pins at the size it grew to.
   */
  _sendSizeHints(props = this.props, resolved = null) {
    const wnd = this.window;
    if (!wnd || typeof wnd.setSizeHints !== 'function') return;
    const hints = this._hintsToSend(props, resolved);
    if (Object.keys(hints).length === 0) return;
    const at = `${wnd.width}x${wnd.height}`;
    if (
      shallowEqual(hints, this._sentHints) &&
      (hints.resizable !== false || at === this._sentHintsAt)
    ) {
      return;
    }
    this._sentHints = hints;
    this._sentHintsAt = at;
    wnd.setSizeHints(hints);
  }
}

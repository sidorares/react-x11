// Retained node tree: one lightweight JS node per host element, one yoga node
// per drawn element, painted into the owning <window>'s single 2d context on
// ntk's frame clock. Only <window> owns a real X11 window (see NEXT_STEPS.md
// §4 for the rationale).
import {
  Yoga,
  applyLayoutStyle,
  paintPropsChanged,
  textStyleFrom,
  DEFAULT_TEXT_STYLE,
  TEXT_LAYOUT_PROPS,
  flattenStyle,
  validateStyle,
  resolveStyleStates,
  hasStateStyles,
  isStyleProp,
  isEventProp,
  EMPTY_STYLE,
  transitionFor,
  interpolate,
  ease,
  isLayoutProp,
  styleUsesTokens,
  resolveTokens,
  styleHasSizeQueries,
  styleHasSupportsQueries,
  resolveQueries,
  DEFAULT_FOCUS_RING,
  resolveHitSlop,
  tint,
} from './styles.js';
import { cssColorStraight } from 'ntk';
import { EventManager, discrete } from './events.js';
import {
  DropSession,
  dndAtoms,
  forgetTopLevel,
  hasDropProps,
  registerTopLevel,
  XDND_VERSION,
} from './dnd.js';
import { addPendingFrame, clearPendingFrame } from './frames.js';
import {
  argbVisual,
  compositingActive,
  transparencyDisabled,
  watchCompositing,
} from './compositing.js';
import { baseTheme } from './palette.js';
import { callHandler } from './errors.js';
import { windowIdOf } from './windowid.js';
import { paintCacheFor } from './paintcache.js';
import { hooks as traceHooks } from './trace-registry.js';
import { runWithPriority, DiscreteEventPriority } from './priority.js';
import { inputTime } from './inputtime.js';
import { armPasteState, canPaste } from './pastestate.js';
import {
  editMenuColors,
  editMenuGeometry,
  editMenuIndexAt,
  editMenuStep,
  paintEditMenu,
} from './editmenu.js';

/**
 * Kinds that lay out with yoga and paint into the owning window —
 * `paintOrder` filters on this, so a kind missing from it lays out and
 * never paints. Mutable because `registerElement` (registry.js) adds to it;
 * that direction, rather than nodes.js importing the registry, is what
 * keeps the two files acyclic.
 */
export const DRAWN_KINDS = new Set([
  'box',
  'text',
  'image',
  'canvas',
  'scrollview',
  'textinput',
  'textarea',
  'markdown',
  'html',
  'svg',
  'tex',
]);

/** kind -> style names a registered element claims as its own semantics.
 * Filled by registry.js; read by `Node.semanticNames`, so a registered
 * element gets the exemption without subclassing the getter. */
export const CUSTOM_SEMANTIC_NAMES = new Map();

// X ConfigureWindow stack-mode: Below places the window directly under the
// named sibling (X11 protocol, ConfigureWindow).
const STACK_BELOW = 1;

// Windows whose child stacking order may have gone stale during the commit
// in progress; drained by flushWindowRestacks from resetAfterCommit.
const pendingRestack = new Set();

// --- damage -------------------------------------------------------------
//
// A frame either repaints the whole window or a bounded region of it. The
// sentinel is deliberately not a rect: "the whole window" has to stay
// distinguishable from "a rect that happens to cover it", because the
// window can be resized between the invalidation and the paint.
const FULL_DAMAGE = Symbol('full-damage');

// "I need a frame, but nothing I own changed appearance." Distinct from
// passing no node, which means "something changed and I cannot say where" —
// the safe reading, and the one that repaints everything.
const NO_DAMAGE = Symbol('no-damage');

// Painting is not perfectly bounded by a node's rect — an antialiased
// rounded corner or glyph edge puts coverage a fraction of a pixel outside
// it — so damage grows by a pixel on each side before anything is culled
// against it.
const DAMAGE_SLOP = 1;

// While a bounded frame's layout pass runs, every node whose absolute rect
// comes out different reports its old and new rects here (each already
// inflated by that node's own paint reach) — which is what lets a layout
// change stay a handful of rects instead of degrading the frame to
// FULL_DAMAGE. Module state rather than a parameter because absolutize is
// a hot recursive walk with overrides in three classes; null outside the
// pass, and always restored through `finally`.
let layoutDiffSink = null;

// What an invalidate() may name as its reason — a small closed set, so the
// frame log, the tracer and the full-repaint warning can print "why" next
// to "where". A typo'd reason would silently vanish from every report, so
// DEV validates against this list.
const INVALIDATE_REASONS = new Set([
  'props', // a React commit changed what a node draws
  'style-state', // :hover/:focus/:active/:disabled restyle
  'theme', // a theme/token change restyled a subtree
  'animation', // a transition frame
  'scroll', // scrollTo/scrollBy/scrollIntoView, textarea/textinput panning
  'text', // text content, input value or caret editing
  'content', // async content arrived (image decode, rich-content reflow)
  'child-list', // children were added, removed or reordered
  'focus', // focus moved: ring/caret handover between nodes
  'caret', // the caret blink timer
  'resize', // the window changed size
  'mount', // the window was just realized; its first frame
  'expose', // ntk asked for a redraw (backing store invalidated)
  'highlight', // DevTools hover highlight
  'capabilities', // a compositor started or stopped: what the window may paint
]);

// A frame with no recorded reasons shares one frozen empty list, so the
// per-frame cost of the reason machinery when nothing is reading it is a
// property write.
const EMPTY_REASONS = Object.freeze([]);

// --- scroll blitting (issue #138) ---------------------------------------
//
// A pure-scroll frame does not have to repaint the viewport: the band that
// stays visible is already in ntk's backing pixmap, one CopyArea away from
// its new position (ntk >= 4.3, Window.scrollRegion). The frame then only
// repaints the strip the scroll exposed, plus the scrollbar tracks. The
// gates below decide when that is safe *and* worth it; every failure falls
// back to today's full-viewport repaint, so the fast path can cost
// correctness nothing — the worst mistake it can make is not firing.

// Below this viewport area a repaint is one cheap pass and the blit's
// bookkeeping (a safety walk over the tree, extra damage rects, an extra
// request) costs more than it saves.
const SCROLL_BLIT_MIN_AREA = 48 * 1024;

// Escape hatch, read once like the other switches: for measuring the blit
// against the plain path on the same build, and as first aid if a scroll
// ever misrenders in the field. `=== '1'` like REACT_X11_NO_PAINT_CACHE —
// a truthy check would read NO_SCROLL_BLIT=0 as "disable the blit", and a
// stale export like that is exactly the kind of thing a cross-machine
// performance comparison trips over.
const NO_SCROLL_BLIT = process.env.REACT_X11_NO_SCROLL_BLIT === '1';

// If less than this fraction of the viewport survives the shift, the
// exposed strip is most of a repaint anyway.
const SCROLL_BLIT_MIN_KEEP = 0.5;

const rectContains = (outer, inner) =>
  outer.x <= inner.x &&
  outer.y <= inner.y &&
  outer.x + outer.width >= inner.x + inner.width &&
  outer.y + outer.height >= inner.y + inner.height;

const isIntegerRect = (r) =>
  Number.isInteger(r.x) &&
  Number.isInteger(r.y) &&
  Number.isInteger(r.width) &&
  Number.isInteger(r.height);

/** `rect` shrunk by `by` on every side. */
function insetRect(rect, by) {
  return {
    x: rect.x + by,
    y: rect.y + by,
    width: rect.width - 2 * by,
    height: rect.height - 2 * by,
  };
}

/** The overlap of two rects, or null when they have none. */
function intersectRects(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

/** The full track strip a scrollbar occupies (thumb travel included), with
 * a pixel of slop for the thumb's antialiased corners. */
function scrollbarTrackRect(bar) {
  const rect =
    bar.axis === 'x'
      ? {
          x: bar.trackStart,
          y: bar.crossStart,
          width: bar.trackLength,
          height: SCROLLBAR_WIDTH,
        }
      : {
          x: bar.crossStart,
          y: bar.trackStart,
          width: SCROLLBAR_WIDTH,
          height: bar.trackLength,
        };
  return insetRect(rect, -1);
}

// REACT_X11_DEBUG_PAINT: each frame strokes its damage rects in the next of
// these, so a region repainting every frame strobes visibly.
const FLASH_COLORS = [
  '#e6194b',
  '#3cb44b',
  '#ffe119',
  '#4363d8',
  '#f58231',
  '#911eb4',
];

// How many rectangles a frame's damage is allowed to hold.
//
// Kept much smaller than the equivalent cap in ntk, because a rectangle costs
// more here: ntk pays one extra CopyArea per rectangle, while this pays a whole
// extra pass over the tree — `paintOrder()` allocates and sorts per node — plus
// a clip. Four is enough for the shapes that actually occur (a ticker and a
// table row; a control and the status line it updates) and cheap enough that
// the worst case is not worth avoiding.
const MAX_DAMAGE_RECTS = 4;

// How much of the box around them several rectangles have to save to be worth
// painting separately. Two adjacent tab headers describe nearly the same area
// either way and are better off as one pass; two corners of the window are not.
const SPLIT_SAVING = 0.75;

function unionRect(a, b) {
  if (!b) return a ?? null;
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

function rectArea(r) {
  return Math.max(0, r.width) * Math.max(0, r.height);
}

/** The box around a non-empty list of rects. */
function rectsBounds(rects) {
  let out = rects[0];
  for (let i = 1; i < rects.length; i++) out = unionRect(out, rects[i]);
  return out;
}

/** Do two rects share any area? Touching edges do not count. */
function rectsOverlap(a, b) {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

/**
 * Merge overlapping rects until none of them overlap.
 *
 * Disjointness is not tidiness here, it is correctness. Each rect gets its own
 * pass over the tree, and a node inside two of them would be painted twice —
 * harmless for opaque drawing, wrong for anything translucent, which would
 * blend over itself. Merging removes the question and saves the duplicated
 * pass at the same time.
 */
function coalesceRects(rects) {
  const out = [];
  for (const rect of rects) {
    let merged = rect;
    for (let i = out.length - 1; i >= 0; i--) {
      if (!rectsOverlap(out[i], merged)) continue;
      merged = unionRect(merged, out[i]);
      out.splice(i, 1);
      // start the scan again: having grown, the rect can now reach ones
      // already passed over
      i = out.length;
    }
    out.push(merged);
  }
  return out;
}

/**
 * Add one rect to a capped, disjoint damage list, returning a new list.
 *
 * Over the cap, the pair whose merge wastes the least area is merged — waste
 * being the area the merged rect covers that neither of the two did, so
 * neighbours go first and far-apart rects last. That merge can itself overlap a
 * third rect, so the result is coalesced again.
 */
function addDamageRect(rects, add) {
  let out = coalesceRects(
    (rects ?? []).concat([
      { x: add.x, y: add.y, width: add.width, height: add.height },
    ]),
  );
  while (out.length > MAX_DAMAGE_RECTS) {
    let bestI = 0;
    let bestJ = 1;
    let bestWaste = Infinity;
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const waste =
          rectArea(unionRect(out[i], out[j])) -
          rectArea(out[i]) -
          rectArea(out[j]);
        if (waste < bestWaste) {
          bestWaste = waste;
          bestI = i;
          bestJ = j;
        }
      }
    }
    const merged = unionRect(out[bestI], out[bestJ]);
    out = coalesceRects(
      out.filter((_, k) => k !== bestI && k !== bestJ).concat([merged]),
    );
  }
  return out;
}

/**
 * The rects a frame actually paints, given the ones that were claimed.
 *
 * Each one costs a pass over the tree and a clip, so a list whose pieces nearly
 * fill the box around them is better served by one pass over that box. Both
 * answers cover every claimed pixel, so this is a cost decision and never a
 * correctness one.
 */
function damageToPaint(rects) {
  if (rects.length < 2) return rects;
  const box = rectsBounds(rects);
  let sum = 0;
  for (const r of rects) sum += rectArea(r);
  return sum > rectArea(box) * SPLIT_SAVING ? [box] : rects;
}

/**
 * The node whose bounds cover where an animating node will be next frame, or
 * `null` when that cannot be known and the frame has to repaint everything.
 *
 * Three cases, and the middle one is the interesting one:
 *
 *  - **paint-only** (a colour, an opacity): the node stays put, so its own
 *    bounds are the damage.
 *  - **a layout property on an out-of-flow node** (`position: absolute`, the
 *    arrangement a sliding thumb uses): the node moves, so its own bounds
 *    cover where it is going but not where it has been. Its *parent* covers
 *    both — an absolute child is laid out inside its parent and, being out of
 *    flow, moves nothing else when it shifts. This is what keeps a `Switch`
 *    from repainting the window on every frame of its 120ms slide.
 *  - **a layout property in flow**: a reflow can move any node in the tree,
 *    including ones that leave stale pixels outside every bound we could name
 *    here. Nothing to do but repaint in full.
 */
function damageForAnimation(node) {
  let movesInLayout = false;
  for (const prop of node._anim?.keys() ?? []) {
    if (isLayoutProp(prop)) movesInLayout = true;
  }
  if (!movesInLayout) return node;
  if (node.style?.position !== 'absolute') return null;
  // A window parent bounds nothing useful — its own rect is the whole surface.
  const parent = node.parent;
  return parent && !parent.isWindow ? parent : null;
}

/** Apply any child-window stacking changes the commit produced, once. */
export function flushWindowRestacks() {
  const nodes = [...pendingRestack];
  pendingRestack.clear();
  for (const node of nodes) node._restackWindowChildren();
}

/**
 * A CSS colour as an X pixel value.
 *
 * The 24-bit TrueColor layout, which is what `redMask`/`greenMask`/`blueMask`
 * say on every server a client meets today and what ntk's own ARGB visual
 * uses. Alpha is dropped: this is the *window background attribute*, a single
 * opaque pixel the server repeats, not something composited.
 */
function pixelFor(color) {
  const rgba = cssColorStraight(color);
  if (!rgba) return null;
  const [r, g, b] = rgba;
  const byte = (c) => Math.max(0, Math.min(255, Math.round(c * 255)));
  return ((byte(r) << 16) | (byte(g) << 8) | byte(b)) >>> 0;
}

/**
 * The desktop switched between light and dark: every node that inherited its
 * palette rather than being given one has a different one now.
 *
 * `_themeChanged()` drops the cached theme and restyles the tokens; the
 * invalidate is for everything else, above all the window background, which
 * is read from the palette at paint time and belongs to no style object.
 *
 * Widgets do not need this — they read the palette through `useTheme()` and
 * React re-renders them. This is the other route: an app's own
 * `backgroundColor: '$background'`, and the window fill under it.
 */
export function appearanceChanged(app) {
  // A desktop change arrives whenever the user makes it, which can be while
  // the app is shutting down. An invalidate *schedules* a frame, so a repaint
  // started here would reach the connection a tick after it closed and throw
  // out of the frame clock, where nothing is waiting to catch it.
  if (!app || app.X?._closing) return;
  for (const node of app._rootChildren ?? []) {
    if (node.destroyed) continue;
    node._themeChanged();
    node.root?.invalidate(true, null, 'theme');
  }
}

// DevTools' measureHostInstance dereferences instance.ownerDocument
// unconditionally once getClientRects exists; a null documentElement and
// defaultView give it zero scroll offsets and no crash.
export const DEVTOOLS_FAKE_DOCUMENT = {
  documentElement: null,
  defaultView: null,
};

/** CSS's `transparent` keyword means "paint nothing". ntk's colour parser
 *  does not know it and throws deep inside the 2d context, taking the whole
 *  frame with it, so filter it out at the source alongside null/''. */
function isPaintedColor(color) {
  return Boolean(color) && color !== 'transparent';
}

const DEV = process.env.NODE_ENV !== 'production';

// Connections already told they have no 32-bit visual (`_argbAttributes`).
const warnedNoArgb = new WeakSet();

// Frame timestamps for transitions. Indirected so tests can drive the clock
// instead of sleeping through real animations.
let now = () => Date.now();
export function setAnimationClock(fn) {
  now = fn;
}

// REACT_X11_DEBUG_PAINT, read once: a process.env read is a real
// environment lookup, and this switch sits on invalidate() and the paint
// loop — the diagnostics must cost nothing when they are off. Indirected
// like the animation clock so tests can flip it without a subprocess.
let debugPaint = process.env.REACT_X11_DEBUG_PAINT || '';
export function setDebugPaint(mode) {
  debugPaint = mode || '';
}

/** Did anything the text stack measures or paints with change? */
function textStyleChanged(style, before) {
  if (style === before) return false;
  if (style.color !== before.color) return true;
  for (const key of TEXT_LAYOUT_PROPS) {
    if (style[key] !== before[key]) return true;
  }
  return false;
}

/**
 * A style property passed flat used to be silently dropped — it was neither
 * a layout prop, a paint prop nor an `on*` handler, so nothing looked at it
 * and nothing said so. Now that style has its own channel there is exactly
 * one place it can go, and the wrong place is an error that names the fix.
 */
function assertNoFlatStyleProps(props, kind, semantic) {
  if (!DEV) return;
  for (const key of Object.keys(props)) {
    if (!isStyleProp(key) || semantic.has(key)) continue;
    throw new Error(
      `react-x11: <${kind} ${key}=…> is a style property — pass it in ` +
        `style: <${kind} style={{ ${key}: … }} />`,
    );
  }
}

// Names an element owns as semantics, which therefore never mean style on
// it. `<window width>` is the X window's width; `<box width>` would be yoga
// style, and there is no element where a name means both.
const NO_SEMANTIC_NAMES = new Set();

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
 * ntk's Window constructor takes every creation attribute up front. The
 * user-facing shape and ntk's differ in two places: size hints are flat
 * props here and a `sizeHints` object there, and the window background is
 * a style property here and a creation attribute there.
 *
 * Event props never travel this way. ntk reads `onKeyDown` & co. off its
 * creation args and registers them as raw listeners (events_map.toSnake),
 * which would hand the application the native X event instead of the
 * synthetic one the EventManager dispatches — and hold the first render's
 * closure forever. Handlers are read from current props at dispatch time
 * instead, so they can never go stale. `children` is the tree's,
 * `transientFor` holds a React ref that only the commit phase can resolve
 * (WindowNode._applyTransientFor), and `transparent` names a visual that has
 * to be looked up on the connection (WindowNode._argbAttributes) rather than
 * a value ntk takes.
 */
export function windowAttributes(props) {
  const attributes = {};
  const hints = {};
  for (const key of Object.keys(props)) {
    if (key === 'children' || key === 'style' || isEventProp(key)) continue;
    if (key === 'transientFor' || key === 'transparent') continue;
    if (WINDOW_HINT_PROPS.includes(key)) {
      hints[key] = props[key];
      continue;
    }
    attributes[key] = props[key];
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
function applyWindowStates(wnd, names, action) {
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

function applyDecorations(wnd, on) {
  if (typeof wnd?.setProperty !== 'function') return;
  Promise.resolve(
    wnd.setProperty(MOTIF_HINTS, MOTIF_DECORATIONS(on), {
      type: MOTIF_HINTS,
      format: 32,
    }),
  ).catch(() => {});
}

const WINDOW_SEMANTIC_NAMES = new Set([
  'width',
  'height',
  ...WINDOW_HINT_PROPS,
]);

/** Equality for props that may be a scalar, an array or a plain object
 *  (window hints are all three shapes), so an unchanged inline object
 *  literal does not re-send the property every render. */
function shallowEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
}

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
    this.root = null; // owning WindowNode once attached
    this.hidden = false;
    this.destroyed = false;
    // absolute rect within the owning window, filled by absolutize()
    this.abs = { x: 0, y: 0, width: 0, height: 0 };
    // node states that style blocks can react to, owned by EventManager
    this.states = {
      ':hover': false,
      ':focus': false,
      ':focus-visible': false,
      ':active': false,
      ':drag-over': false,
      ':dragging': false,
    };
    // in-flight transitions: prop -> {from, to, start, duration}
    this._anim = null;
    // hot pointer-path caches (issue #188): the children in paint order,
    // re-verified against the live children on every read, and the
    // subtree's hit reach, invalidated through _clearHitBounds()
    this._paintOrderCache = null;
    this._hitBoundsCache = null;
    this._syncStyle(props);
    this.yoga = yoga ? Yoga.Node.create() : null;
    if (this.yoga) {
      applyLayoutStyle(this.yoga, this.style);
    }
  }

  /**
   * Everything that paints or lays out reads `this.style`, never `this.props`
   * — props carry element semantics (`title`, `value`, geometry, handlers)
   * and style carries the CSS-like vocabulary, with no name shared between
   * them. `baseStyle` is the flattened `style` prop; `style` is that with
   * the active state blocks overlaid.
   */
  _syncStyle(props) {
    if (DEV && this.stylable) {
      assertNoFlatStyleProps(props, this.kind, this.semanticNames);
      validateStyle(flattenStyle(props.style), `<${this.kind} style>`);
    }
    this._baseStyle = this.stylable ? flattenStyle(props.style) : EMPTY_STYLE;
    this._usesTokens = this.stylable && styleUsesTokens(this._baseStyle);
    if (this._usesTokens) {
      const theme = this.theme;
      this._baseStyle = resolveTokens(
        this._baseStyle,
        theme,
        `<${this.kind} style>`,
        this.placed,
      );
    }
    // `disabled` is a prop, not something the pointer does, so it is read
    // straight off props rather than driven by the event manager
    this.states[':disabled'] = Boolean(props.disabled);
    // window size queries fold into the base before state blocks, so a
    // `:hover` inside the wide layout still wins over the wide layout
    const queried = styleHasSizeQueries(this._baseStyle);
    if (queried !== this._queried) {
      this._queried = queried;
      const root = this.root;
      if (root?._sizeQueryNodes) {
        if (queried) root._sizeQueryNodes.add(this);
        else root._sizeQueryNodes.delete(this);
      }
    }
    // `@supports` blocks keep their own registry: what re-resolves them is
    // the server's answer changing, not a resize
    // Registered unconditionally rather than on change: a `<window>`'s own
    // style is resolved by the Node constructor, before `root` is even
    // assigned, so the first pass has nowhere to register and a "did it
    // change" guard would keep it unregistered forever. Set.add is
    // idempotent and these blocks are rare.
    const asks = styleHasSupportsQueries(this._baseStyle);
    this._supportsQueried = asks;
    if (this.root?._supportsQueryNodes) {
      if (asks) this.root._supportsQueryNodes.add(this);
      else this.root._supportsQueryNodes.delete(this);
    }
    if (queried || asks) {
      this._baseStyle = resolveQueries(this._baseStyle, {
        size: this.root?.querySize ?? null,
        // null before the window is realized, which reads as "not
        // supported" — the fallback design is the one that works everywhere
        supports: this.root?.capabilities ?? null,
      });
    }
    this._stateful = hasStateStyles(this._baseStyle);
    return this._retarget(
      this._stateful
        ? resolveStyleStates(this._baseStyle, this.states)
        : this._baseStyle,
    );
  }

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
      return this.style;
    }
    for (const prop of Object.keys(target)) {
      const to = target[prop];
      const from = displayed[prop];
      if (from === to || from === undefined) continue;
      const duration = transitionFor(target, prop);
      if (duration <= 0) continue;
      if (interpolate(from, to, 0.5) === null) continue; // no midpoint: snap
      (this._anim ??= new Map()).set(prop, {
        from,
        to,
        duration,
        // *now*, not the last frame's timestamp: between two user actions
        // the window is idle and draws nothing, so the previous frame can
        // be seconds old — and the first tick would then find the
        // transition already over and jump straight to the end
        start: now(),
      });
      this.root?._startAnimating(this);
    }
    this.style = this._anim?.size
      ? { ...target, ...this._animatedValues() }
      : target;
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
    return this.style;
  }

  _animatedValues() {
    const values = {};
    for (const [prop, a] of this._anim) values[prop] = a.value ?? a.from;
    return values;
  }

  /**
   * Advance every in-flight transition to `now`. Returns true while any is
   * still running, so the window keeps asking for frames.
   */
  _tickAnimations(now) {
    if (!this._anim?.size) return false;
    let layoutChanged = false;
    const before = this.style;
    for (const [prop, a] of this._anim) {
      const t = a.duration > 0 ? Math.min(1, (now - a.start) / a.duration) : 1;
      a.value = t >= 1 ? a.to : (interpolate(a.from, a.to, ease(t)) ?? a.to);
      if (t >= 1) this._anim.delete(prop);
      if (isLayoutProp(prop)) layoutChanged = true;
    }
    this.style = this._anim.size
      ? { ...this._targetStyle, ...this._animatedValues() }
      : this._targetStyle;
    if (layoutChanged && this.yoga) {
      applyLayoutStyle(this.yoga, this.style, before);
      // a transition on a layout property costs a layout pass per frame —
      // the author asked for that by transitioning one (docs/styling.md)
      if (this.root) this.root.needsLayout = true;
    }
    return this._anim.size > 0;
  }

  /**
   * A node state changed (hover, focus, press). Only nodes that actually
   * declare a block for it do anything, and what they do is a repaint —
   * no React render, no reflow, since state blocks cannot touch layout.
   */
  setStyleState(name, on) {
    if (this.states[name] === on) return;
    this.states[name] = on;
    if (!this._stateful || this.destroyed) return;
    const next = resolveStyleStates(this._baseStyle, this.states);
    if (shallowEqual(next, this._targetStyle)) return;
    this._retarget(next);
    // a state block may only set paint properties, so the node's own region
    // is the whole of what changed
    this.root?.invalidate(false, this, 'style-state');
  }

  get isWindow() {
    return this.kind === 'window';
  }

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
    for (const child of this.children) {
      if (!child.isWindow) child._registerSizeQueries();
    }
  }

  /** Style names this element claims as its own semantics (see WindowNode).
   * Registered elements declare theirs to `registerElement`, so the common
   * case needs no subclass. */
  get semanticNames() {
    return CUSTOM_SEMANTIC_NAMES.get(this.kind) ?? NO_SEMANTIC_NAMES;
  }

  /**
   * The theme in force here: the nearest `theme` prop at or above this node,
   * with an inner one merged over the outer so a panel can restate a colour
   * or two without repeating a palette. Popups resolve through their place
   * in the *tree*, not their window, so a menu inherits the theme of the UI
   * that opened it even though it is a separate X window.
   *
   * **With no `theme` prop anywhere above, it is the desktop's palette.** So
   * `backgroundColor: '$background'` works in an app that never wrote a
   * `<ThemeProvider>`, and means "whatever this desktop's is" — which is the
   * same answer `useTheme()` gives the widgets, by the other route.
   *
   * A detached node has no ancestors yet and so cannot see a provider two
   * levels up; it still resolves, against the base, and `_themeChanged()` on
   * attach re-resolves it against the real one.
   */
  get theme() {
    if (this._theme !== undefined) return this._theme;
    const inherited = this.parent ? this.parent.theme : baseTheme();
    const own = this.props.theme;
    this._theme = own ? { ...inherited, ...own } : inherited;
    return this._theme;
  }

  /**
   * The text style a node inherits when nothing named one.
   *
   * The ink is the **palette's**, not a fixed black: a `<text>` or a
   * `<textinput>` that never mentions a colour has to be readable on the
   * surface it is drawn on, and that surface follows the desktop now. Black
   * on `#1e2228` is invisible, which is the whole bug.
   *
   * Cached per node so the object identity is stable while the palette is —
   * the layouts below are keyed on style and a fresh base each call would
   * miss the cache every time.
   */
  get inheritedTextStyle() {
    const color = this.theme.text;
    if (this._textBase?.color !== color) {
      this._textBase = { ...DEFAULT_TEXT_STYLE, color };
    }
    return this._textBase;
  }

  /**
   * Whether this node's ancestry is complete, so a `$token` that does not
   * resolve is a mistake rather than a node that has not been placed yet.
   *
   * For a drawn node that is `root` — set by `_setRoot` when the subtree is
   * attached to the window that owns it, which is exactly when no further
   * `theme` prop can appear above it. React builds bottom-up, so having a
   * *parent* proves nothing: the parent may itself be floating.
   *
   * The exception is a `<popup>`, which is its own root from the moment it is
   * created and only learns where in the tree it was written when it is
   * attached. Until then its subtree would be judged against the base palette
   * alone, and a `$panel` from the provider two levels up would throw. Those
   * resolve provisionally instead, and `_themeChanged()` on attach re-resolves
   * them. Known tokens resolve either way, so only the *error* is ever
   * deferred, never the value.
   */
  get placed() {
    const owner = this.isWindow ? this : this.root;
    if (!owner) return false;
    return owner.isPopup ? owner.parent != null : true;
  }

  /** The owning window resized: re-resolve, since a query block may now
   * match that did not, or the other way round. */
  _sizeQueriesChanged() {
    if (!(this._queried || this._supportsQueried) || this.destroyed) return;
    const before = this.style;
    this._syncStyle(this.props);
    if (textStyleChanged(this.style, before)) this._textContentChanged();
    if (this.yoga && this.style !== before) {
      applyLayoutStyle(this.yoga, this.style, before);
    }
  }

  /** The theme above or on this node changed: drop the caches and restyle
   * the subtree, since a token can appear at any depth. */
  _themeChanged() {
    const wasInk = this._theme?.text;
    this._theme = undefined;
    // A `<window>` with no `backgroundColor` of its own follows the palette,
    // and the server's copy of that colour has to follow with it — otherwise
    // the next resize fills the new area in the old scheme.
    if (this.isWindow) this._syncWindowBackground();
    // The inherited ink is not in any style object, so `_usesTokens` does not
    // see it move — but a cached layout carries the colour it was shaped
    // with, and would keep painting the old one.
    if (wasInk !== undefined && wasInk !== this.theme.text) {
      this._textContentChanged();
      this.root?.invalidate(true, null, 'theme');
    }
    if (this._usesTokens) {
      const before = this.style;
      this._syncStyle(this.props);
      // a token change reaches the node without React re-rendering it, so
      // the invalidation TextNode.applyProps would have done has to happen
      // here too — otherwise the cached layout keeps painting the old colour
      if (textStyleChanged(this.style, before)) this._textContentChanged();
      this.root?.invalidate(true, null, 'theme');
    }
    for (const child of this.children) child._themeChanged();
  }

  /**
   * Whether this element is styled at all. The 3D scene elements and the
   * declarative SVG children are not: they carry their own vocabularies —
   * `position`, `color`, `width` mean a transform, a material and a radius
   * there — so the style channel does not apply to them, the same way it
   * does not apply to an `<input type>` in the DOM.
   */
  get stylable() {
    return true;
  }

  /** Number of yoga-bearing children before `index` (window children and
   * text spans/chunks do not join the parent's yoga tree). */
  _yogaIndexAt(index) {
    let n = 0;
    for (let i = 0; i < index; i++) {
      if (this._joinsYoga(this.children[i])) n++;
    }
    return n;
  }

  _joinsYoga(child) {
    return Boolean(this.yoga && child.yoga && !child.isWindow);
  }

  appendChild(child) {
    this.insertBefore(child, null);
  }

  /** Splice `child` in front of `beforeChild` (end of the list when that is
   * null), first taking it out of its old slot: React reorders a keyed list
   * by calling insertBefore with a child that is *already* mounted here, and
   * without the removal it would appear twice. Returns the new index. */
  _spliceChild(child, beforeChild) {
    const from = this.children.indexOf(child);
    if (from !== -1) this.children.splice(from, 1);
    const before =
      beforeChild == null ? -1 : this.children.indexOf(beforeChild);
    const index = before === -1 ? this.children.length : before;
    this.children.splice(index, 0, child);
    return index;
  }

  insertBefore(child, beforeChild) {
    if (child.isPopup) {
      // popups live anywhere in the JSX tree but are independent
      // override-redirect windows: bookkeeping only, no yoga, no paint —
      // but they do inherit the theme of where they are written
      this._spliceChild(child, beforeChild);
      child.parent = this;
      if (this.theme || child.props.theme) child._themeChanged();
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
    // read and nodes.js keeps not importing it.
    if (this._childrenAllowed === false) {
      throw new Error(
        `react-x11: <${this.kind}> takes no children (registered with ` +
          `childrenAllowed: false), but <${child.kind}> is inside it.`,
      );
    }
    // captured before the child joins, so it covers the arrangement that is
    // about to be replaced (see _childListChanged)
    const before = this.paintBounds();
    // a move has to leave the yoga tree too — yoga aborts on insertChild of
    // a node that still has a parent
    if (this.children.includes(child) && this._joinsYoga(child)) {
      this.yoga.removeChild(child.yoga);
    }
    const index = this._spliceChild(child, beforeChild);
    child.parent = this;
    if (this._joinsYoga(child)) {
      this.yoga.insertChild(child.yoga, this._yogaIndexAt(index));
    }
    child._setRoot(this.root);
    child._registerSizeQueries();
    // it can see its ancestors now, so any token in its style can resolve.
    // With no theme anywhere there is nothing to resolve and nothing to walk
    if (this.theme || child.props.theme) child._themeChanged();
    this._textContentChanged();
    this._childListChanged(before);
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
    root.invalidate(true, before, 'child-list');
    root._reflowed.add(this);
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index === -1) return;
    // captured while the child is still attached, so it covers the rect the
    // child is about to stop occupying
    const before = this.paintBounds();
    this.children.splice(index, 1);
    if (this._joinsYoga(child)) {
      this.yoga.removeChild(child.yoga);
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
    for (const child of this.children) child.destroySubtree();
  }

  _setRoot(root) {
    if (this.root === root) return;
    this.root = root;
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
    const style = this._syncStyle(newProps);
    let layoutChanged = false;
    // hoisted styles hit the identity check and skip the whole update
    if (this.yoga && style !== prevStyle) {
      layoutChanged = applyLayoutStyle(this.yoga, style, prevStyle);
    }
    if (Boolean(newProps.trapFocus) !== Boolean((oldProps ?? prev).trapFocus)) {
      this._syncFocusScope();
    }
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
      this.root?.invalidate(
        false,
        this._paintChanged(newProps, prev, style, prevStyle) ? this : NO_DAMAGE,
        'props',
      );
    }
  }

  /**
   * Did anything this node *draws* change?
   *
   * Deliberately conservative, because the cost of a wrong "no" is a stale
   * pixel that nothing will come back to fix. Paint-relevant style is asked
   * about by value, so a style object React rebuilt with the same contents
   * costs nothing — that is the whole point, since React rebuilds sibling
   * styles on every render and a commit would otherwise damage every node it
   * walked.
   *
   * Everything else falls back to "yes it changed", which is what makes this
   * safe without knowing about subclasses: `<image src>`, `<canvas onDraw>`,
   * a `value`, a `placeholder`, a `caretColor` — any prop a subclass paints
   * from is a prop, so a change to it lands here as an inequality and damages
   * the node. Three kinds are skipped because they cannot affect this node's
   * own drawing:
   *
   *  - `children`, which the reconciler mutates through appendChild /
   *    removeChild / commitTextUpdate, each of which invalidates on its own;
   *  - event handlers, rebuilt every render and never painted;
   *  - `style`, already compared by value above.
   */
  _paintChanged(newProps, prev, style, prevStyle) {
    if (style !== prevStyle && paintPropsChanged(style, prevStyle)) return true;
    const keys = new Set([...Object.keys(newProps), ...Object.keys(prev)]);
    for (const key of keys) {
      if (key === 'children' || key === 'style' || isEventProp(key)) continue;
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

  /** Drawn, visible children in paint order (stable sort by zIndex). */
  paintOrder() {
    // Hit testing asks at every node it visits and painting at every node
    // it draws, so the filter-map-sort-map here was steady per-event
    // allocation (issue #188). Cached — and verified against the live
    // children on every read rather than invalidated: membership and
    // z-keys are the same reads the filter always did, so a fresh cache
    // costs no allocation and a stale one is impossible, whatever mutates
    // children, styles, visibility or DRAWN_KINDS.
    const cache = this._paintOrderCache;
    if (cache && this._paintOrderFresh(cache)) return cache.order;
    // `display: 'none'` takes a node out of the layout, and it has to leave
    // the paint with it. They were separate before because the only way to
    // hide something was the `hidden` flag, which does both — until a size
    // query started setting `display` from a style block, and the hidden
    // node carried on painting at the position it no longer had.
    const drawn = [];
    const z = [];
    for (const c of this.children) {
      if (
        DRAWN_KINDS.has(c.kind) &&
        c.yoga &&
        !c.hidden &&
        c.style.display !== 'none'
      ) {
        drawn.push(c);
        z.push(c.style.zIndex ?? 0);
      }
    }
    // document order already answers the usual no-zIndex case; the sort is
    // only paid when some z actually disagrees with it
    let order = drawn;
    for (let i = 1; i < z.length; i++) {
      if (z[i] < z[i - 1]) {
        order = drawn
          .map((node, j) => ({ node, z: z[j], j }))
          .sort((a, b) => a.z - b.z || a.j - b.j)
          .map((e) => e.node);
        break;
      }
    }
    this._paintOrderCache = { order, drawn, z };
    return order;
  }

  /** Do the cached drawn children and their z-keys still match the tree? */
  _paintOrderFresh({ drawn, z }) {
    let j = 0;
    for (const c of this.children) {
      if (
        !DRAWN_KINDS.has(c.kind) ||
        !c.yoga ||
        c.hidden ||
        c.style.display === 'none'
      ) {
        continue;
      }
      if (
        j >= drawn.length ||
        drawn[j] !== c ||
        z[j] !== (c.style.zIndex ?? 0)
      ) {
        return false;
      }
      j++;
    }
    return j === drawn.length;
  }

  clipsChildren() {
    return this.style.overflow === 'hidden' || this.style.overflow === 'scroll';
  }

  containsPoint(x, y) {
    return (
      x >= this.abs.x &&
      y >= this.abs.y &&
      x < this.abs.x + this.abs.width &&
      y < this.abs.y + this.abs.height
    );
  }

  /**
   * The same test grown by `hitSlop`. Deliberately separate from
   * `containsPoint`: slop belongs to *this* node's target and nothing else,
   * so it must not widen the rect that clips this node's children, must not
   * reach `paintBounds`, and must never touch yoga. A 16px slider with 4px
   * of slop top and bottom is a 24px target that still draws 16px tall,
   * which is the whole point — WCAG 2.2 SC 2.5.8 without a redesign.
   *
   * The slop can overlap a sibling's box. Hit testing is front-to-back over
   * paint order, so the sibling on top keeps its own pixels either way.
   */
  containsPointWithSlop(x, y) {
    if (this.containsPoint(x, y)) return true;
    const slop = resolveHitSlop(this.style.hitSlop);
    if (!slop) return false;
    return (
      x >= this.abs.x - slop.left &&
      y >= this.abs.y - slop.top &&
      x < this.abs.x + this.abs.width + slop.right &&
      y < this.abs.y + this.abs.height + slop.bottom
    );
  }

  /** DOM-ish rect accessor. React DevTools' Highlighter requires host
   * instances to expose getClientRects() with a non-empty rect before it
   * emits showNativeHighlight — without this, hovering the tree silently
   * no-ops. Anything with getClientRects is also measured at mount via
   * `instance.ownerDocument.documentElement` (see ownerDocument below). */
  getClientRects() {
    const r = this.abs;
    if (!(r.width > 0 || r.height > 0)) return [];
    return [
      {
        x: r.x,
        y: r.y,
        left: r.x,
        top: r.y,
        width: r.width,
        height: r.height,
        right: r.x + r.width,
        bottom: r.y + r.height,
      },
    ];
  }

  /**
   * The rect a hit anywhere in this subtree must fall inside: this node's
   * rect grown by its own hitSlop, unioned with every child's reach —
   * except under a clipping node, whose children can only be hit while the
   * point is inside its rect (hitTest never descends from outside one).
   *
   * A conservative superset, and only ever that: hidden and
   * pointerEvents-none subtrees are counted anyway, and nothing shrinks a
   * cached bound before the next invalidation. A bound too big costs a
   * walk; one too small would drop real input. Every change that can
   * *grow* the true reach funnels through `_clearHitBounds`: `_assignAbs`
   * for whatever layout moves (mounts, reveals and scrolls all change
   * `abs`), `_retarget` for `hitSlop` and `overflow`, `_childListChanged`
   * for a subtree attached with its rect already laid out, and `flush`
   * for the root's own rect, which is written without `_assignAbs`.
   */
  _hitBounds() {
    let b = this._hitBoundsCache;
    if (b) return b;
    const abs = this.abs;
    const slop = resolveHitSlop(this.style.hitSlop);
    let left = abs.x;
    let top = abs.y;
    let right = abs.x + abs.width;
    let bottom = abs.y + abs.height;
    if (slop) {
      left -= slop.left;
      top -= slop.top;
      right += slop.right;
      bottom += slop.bottom;
    }
    if (!this.clipsChildren()) {
      for (const child of this.children) {
        if (child.isWindow || !child.yoga) continue;
        const cb = child._hitBounds();
        if (cb.left < left) left = cb.left;
        if (cb.top < top) top = cb.top;
        if (cb.right > right) right = cb.right;
        if (cb.bottom > bottom) bottom = cb.bottom;
      }
    }
    b = { left, top, right, bottom };
    this._hitBoundsCache = b;
    return b;
  }

  /**
   * This node's reach changed: drop the cached bounds here and up the
   * chain of ancestors whose unions embed them. The walk stops at a
   * clipping ancestor — its reach is its own rect, so nothing below it
   * changes what it or anything above it reports — or at one already
   * invalid, whose own clear walked the rest of the way up.
   */
  _clearHitBounds() {
    this._hitBoundsCache = null;
    for (let n = this.parent; n; n = n.parent) {
      if (n.clipsChildren() || n._hitBoundsCache === null) return;
      n._hitBoundsCache = null;
    }
  }

  /** Front-to-back hit test. Returns the deepest hit node or null. */
  hitTest(x, y) {
    if (
      this.hidden ||
      this.style.display === 'none' ||
      this.style.pointerEvents === 'none'
    ) {
      return null;
    }
    // nothing in this subtree reaches the point: skip it whole, children
    // and all — this is what keeps a motion event from walking every node
    // in the window (issue #188)
    const b = this._hitBounds();
    if (x < b.left || y < b.top || x >= b.right || y >= b.bottom) {
      return null;
    }
    const inside = this.containsPoint(x, y);
    // the children are culled on the strict rect — slop grows this node's
    // target, not the region its clip lets through
    if (!inside && this.clipsChildren()) {
      return this.containsPointWithSlop(x, y) ? this : null;
    }
    const order = this.paintOrder();
    for (let i = order.length - 1; i >= 0; i--) {
      const hit = order[i].hitTest(x, y);
      if (hit) return hit;
    }
    return inside || this.containsPointWithSlop(x, y) ? this : null;
  }

  absolutize(originX, originY) {
    if (!this.yoga) return;
    this._assignAbs(
      originX + this.yoga.getComputedLeft(),
      originY + this.yoga.getComputedTop(),
      this.yoga.getComputedWidth(),
      this.yoga.getComputedHeight(),
    );
    for (const child of this.children) {
      if (!child.isWindow) child.absolutize(this.abs.x, this.abs.y);
    }
  }

  /**
   * absolutize's write to `abs`, funneled through one place so a bounded
   * frame's layout diff sees every node the pass actually moved or resized.
   * The old and new rects are claimed separately (not their union box —
   * a node crossing the window would drag everything between them along),
   * each grown by this node's own paint reach. A rect that was or became
   * zero-area claims nothing: there were, or will be, no pixels there.
   */
  _assignAbs(x, y, width, height) {
    const old = this.abs;
    if (
      old.x === x &&
      old.y === y &&
      old.width === width &&
      old.height === height
    ) {
      return;
    }
    this.abs = { x, y, width, height };
    // moving or resizing changes where this subtree can be hit, and the
    // cached unions all the way up with it
    this._clearHitBounds();
    if (layoutDiffSink) {
      const grow = this._outlineExtent() + DAMAGE_SLOP;
      if (old.width > 0 && old.height > 0) {
        layoutDiffSink(insetRect(old, -grow));
      }
      if (width > 0 && height > 0) {
        layoutDiffSink(insetRect(this.abs, -grow));
      }
    }
  }

  /**
   * A layout-affecting change confined to this node: claim the subtree as
   * it stands now, and queue it for a second claim once layout has run —
   * the same before/after protocol `_childListChanged` uses. Anything
   * *else* the reflow displaces claims itself through the layout diff in
   * `flush()`, so the frame stays bounded instead of collapsing to
   * FULL_DAMAGE the way a bare `invalidate(true, null)` would.
   */
  _invalidateLayout(reason) {
    const root = this.root;
    if (!root) return;
    root.invalidate(true, this.paintBounds(), reason);
    root._reflowed.add(this);
  }

  /**
   * The region this node can put ink in: its own rect unioned with every
   * descendant's. Not the same as `abs` — a child of a node that does not
   * clip may stick out of it (absolute positioning, a negative margin), and
   * culling a subtree by the parent's rect alone would drop that child's
   * paint. Recomputed on demand rather than cached in `absolutize`, because
   * it is only ever asked for on the handful of nodes that invalidate.
   */
  paintBounds() {
    const bounds = this._subtreeBounds();
    // inflated once, here — doing it inside the recursion would compound the
    // slop by one pixel per level of nesting
    return {
      x: bounds.x - DAMAGE_SLOP,
      y: bounds.y - DAMAGE_SLOP,
      width: bounds.width + DAMAGE_SLOP * 2,
      height: bounds.height + DAMAGE_SLOP * 2,
    };
  }

  /**
   * How far this node's drawing actually reaches, itself and its descendants.
   *
   * A node that clips its children ends the walk at its own rect: whatever
   * they do beyond it never reaches the surface, so counting it would inflate
   * every bound built from here. That matters most for `<scrollview>`, whose
   * content is routinely thousands of pixels taller than the viewport — and
   * can be ninety thousand pixels away mid-scroll (see `_offscreen`). Without
   * this, damage claimed for a scrolled subtree covers the content extent
   * instead of the viewport, and culling tests against a rect that misses
   * almost nothing.
   */
  _subtreeBounds() {
    let bounds = this._ownPaintBounds();
    if (this.clipsChildren()) return bounds;
    for (const child of this.children) {
      if (child.isWindow || !child.yoga || child.hidden) continue;
      if (child.style?.display === 'none') continue;
      bounds = unionRect(bounds, child._subtreeBounds());
    }
    return bounds;
  }

  /**
   * This node's own rect, grown by anything it draws outside it — which is
   * the outline and nothing else. Per node rather than once at the top,
   * because the ring belongs to whichever node has focus and the bound has
   * to cover it wherever that is; and grown even when the ring is currently
   * *off*, because the frame that erases it is claimed after the state has
   * already flipped back.
   */
  _ownPaintBounds() {
    const extent = this._outlineExtent();
    if (extent <= 0) return this.abs;
    return {
      x: this.abs.x - extent,
      y: this.abs.y - extent,
      width: this.abs.width + extent * 2,
      height: this.abs.height + extent * 2,
    };
  }

  /**
   * The focus ring this node would draw: its own `outline*` style, falling
   * back to the theme's focus-ring tokens for anything it leaves out. Null
   * when the node is not focusable and set no outline of its own, and when
   * `outlineWidth: 0` opts out.
   *
   * Resolved here rather than folded into the style so that the default
   * costs nothing until it is asked for — which is once per focused node
   * per frame, not once per node per commit.
   */
  _outline() {
    const style = this.style;
    const explicit = style.outlineWidth !== undefined;
    if (!explicit && !this._focusableForRing()) return null;
    const theme = this.theme;
    const width = style.outlineWidth ?? theme?.focusRingWidth;
    const resolved = width ?? DEFAULT_FOCUS_RING.width;
    if (!(resolved > 0)) return null;
    return {
      width: resolved,
      color: style.outlineColor ?? theme?.focusRing ?? DEFAULT_FOCUS_RING.color,
      offset:
        style.outlineOffset ??
        theme?.focusRingOffset ??
        DEFAULT_FOCUS_RING.offset,
    };
  }

  /**
   * How far outside `abs` this node's ink currently reaches. Zero unless
   * the outline is actually being drawn — every focusable node is a
   * candidate for the default ring, and inflating all of their damage
   * rects for a ring that is not there would widen every claim in the tree
   * and cost the scroll-blit fast path its containment test. The frame that
   * *erases* a ring is the one case where the state has already flipped
   * back, and `EventManager.focus` claims the region before it does.
   */
  _outlineExtent() {
    if (this.style.outlineWidth === undefined && !this.states[':focus-visible'])
      return 0;
    const outline = this._outline();
    return outline ? outline.width + Math.max(0, outline.offset) : 0;
  }

  /** Would a keyboard focus land here? Mirrors `EventManager._isFocusable`;
   * kept as its own method because the ring is decided during paint, where
   * the event manager is not in hand. */
  _focusableForRing() {
    if (this.props.disabled) return false;
    return Boolean(
      this.props.focusable ??
      (this.props.tabIndex != null ? true : (this.focusableByDefault ?? false)),
    );
  }

  contentBox() {
    const padL =
      this.yoga.getComputedPadding(Yoga.EDGE_LEFT) +
      this.yoga.getComputedBorder(Yoga.EDGE_LEFT);
    const padT =
      this.yoga.getComputedPadding(Yoga.EDGE_TOP) +
      this.yoga.getComputedBorder(Yoga.EDGE_TOP);
    const padR =
      this.yoga.getComputedPadding(Yoga.EDGE_RIGHT) +
      this.yoga.getComputedBorder(Yoga.EDGE_RIGHT);
    const padB =
      this.yoga.getComputedPadding(Yoga.EDGE_BOTTOM) +
      this.yoga.getComputedBorder(Yoga.EDGE_BOTTOM);
    return {
      x: this.abs.x + padL,
      y: this.abs.y + padT,
      width: Math.max(0, this.abs.width - padL - padR),
      height: Math.max(0, this.abs.height - padT - padB),
    };
  }

  paint(ctx) {
    if (this.hidden) return;
    this._paintBackground(ctx);
    // The paint cache covers a node's *content* — the expensive part — and
    // not its box: background and border are one composite each, and keeping
    // them out keeps their styles out of the key. A node that does not
    // implement the protocol has no `paintCachePlan` and pays one property
    // lookup for the privilege.
    const cache = this.paintCachePlan && this.root?._paintCache;
    if (cache) cache.paint(this, ctx);
    else this._paintContent(ctx);
    this._paintChildren(ctx);
    this._paintBorder(ctx);
    // last, and outside the border box: a ring drawn under the border would
    // be half-hidden by it on a control whose border is thicker than the gap
    this._paintOutline(ctx);
  }

  /**
   * The focus ring. Drawn on `:focus-visible` — keyboard focus — so a press
   * moves focus without lighting a ring the pointer user did not ask for,
   * and Tab always lights one.
   *
   * A node that sets `outlineWidth` outside a state block gets the ring
   * whenever it is styled to, focused or not; that is the escape hatch for
   * anything wanting an outline for a reason of its own.
   */
  _paintOutline(ctx) {
    const always = this.style.outlineWidth !== undefined;
    if (!always && !this.states[':focus-visible']) return;
    const outline = this._outline();
    if (!outline || !isPaintedColor(outline.color)) return;
    const { width, offset } = outline;
    // stroked centred on the path, like the border, so half the width sits
    // inside the offset gap and half outside it
    const grow = offset + width / 2;
    const radius = this.style.borderRadius ?? 0;
    ctx.strokeStyle = outline.color;
    ctx.lineWidth = width;
    ctx.beginPath();
    const x = this.abs.x - grow;
    const y = this.abs.y - grow;
    const w = this.abs.width + grow * 2;
    const h = this.abs.height + grow * 2;
    if (radius > 0 && typeof ctx.roundRect === 'function') {
      ctx.roundRect(x, y, w, h, radius + grow);
    } else {
      ctx.rect(x, y, w, h);
    }
    ctx.stroke();
  }

  _roundedPath(ctx, radius) {
    ctx.beginPath();
    if (radius > 0 && typeof ctx.roundRect === 'function') {
      ctx.roundRect(
        this.abs.x,
        this.abs.y,
        this.abs.width,
        this.abs.height,
        radius,
      );
    } else {
      ctx.rect(this.abs.x, this.abs.y, this.abs.width, this.abs.height);
    }
  }

  _paintBackground(ctx) {
    const { backgroundColor, borderRadius = 0 } = this.style;
    if (!isPaintedColor(backgroundColor)) return;
    ctx.fillStyle = backgroundColor;
    if (borderRadius > 0) {
      this._roundedPath(ctx, borderRadius);
      ctx.fill();
    } else {
      ctx.fillRect(this.abs.x, this.abs.y, this.abs.width, this.abs.height);
    }
  }

  _paintBorder(ctx) {
    const { borderWidth = 0, borderColor, borderRadius = 0 } = this.style;
    if (!(borderWidth > 0) || !isPaintedColor(borderColor)) return;
    // dashed borders need ntk >= 3.2.0 (setLineDash); solid fallback below
    const dashed =
      this.style.borderStyle === 'dashed' &&
      typeof ctx.setLineDash === 'function';
    if (dashed) {
      ctx.setLineDash([borderWidth * 2 + 2, borderWidth + 2]);
    }
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = borderWidth;
    // stroke centered on the box edge inset by half the border width
    const inset = borderWidth / 2;
    ctx.beginPath();
    if (borderRadius > 0 && typeof ctx.roundRect === 'function') {
      ctx.roundRect(
        this.abs.x + inset,
        this.abs.y + inset,
        this.abs.width - borderWidth,
        this.abs.height - borderWidth,
        Math.max(0, borderRadius - inset),
      );
    } else {
      ctx.rect(
        this.abs.x + inset,
        this.abs.y + inset,
        this.abs.width - borderWidth,
        this.abs.height - borderWidth,
      );
    }
    ctx.stroke();
    if (dashed) {
      ctx.setLineDash([]);
    }
  }

  _paintContent(ctx) {}

  /**
   * The paint-cache protocol (issue #149). A node implements both methods or
   * neither; the base class has neither, so nothing is cached until it opts
   * in, and no existing or future node changes behaviour by default.
   *
   *   paintCachePlan(ctx) -> null | {
   *     key,             // identity: same key must mean same pixels
   *     x, y,            // where the surface goes, in device pixels
   *     width, height,   // its size, in device pixels
   *     format,          // 'argb32', or 'a8' for coverage that gets tinted
   *     tint,            // the colour an 'a8' surface is painted through
   *   }
   *   paintCached(ctx, box) -> void   // draw at the origin of `box`
   *
   * Returning null opts out for this frame, which is the right answer
   * whenever the paint depends on something the key cannot see.
   *
   * **The key is the entire correctness surface.** It must name every input
   * `paintCached` reads, derived from the same values `applyProps` compares
   * so the two cannot drift. Never cache a paint that depends on state
   * outside the key — a focus ring, a hover, a caret blink, anything
   * animating. Run with `REACT_X11_PAINT_CACHE=verify` to have a key that
   * misses something fail loudly instead of showing a stale pixel.
   *
   * `paintCached` draws in *surface-local* coordinates: `box` is at the
   * origin, not at `this.abs`. Reaching for `this.abs.x` inside it is the
   * mistake to look for first when a cached node draws in the wrong place.
   */

  /**
   * Whether anything in this subtree actually reaches outside the clip box.
   *
   * A clip that clips nothing is far from free: each one rebuilds an a8 mask
   * server-side, which is a FillRectangles plus trapezoid rasterization, and
   * ntk brackets every glyph run under a clip with a SetPictureClipRectangles
   * pair. A table sets `overflow: hidden` on every cell so that *long* text
   * truncates, and then almost every cell's text fits — 191 clips a frame, of
   * which a handful do anything.
   *
   * Rounded corners are never skipped: the clip is not a rectangle then, and
   * the rounding can cut a child that a rect test says fits. The one-pixel
   * inset is for antialiasing, which can put ink just outside a glyph's box.
   */
  _childrenCanOverflow() {
    if (this.style?.borderRadius) return true;
    const box = this.abs;
    for (const child of this.children) {
      if (child.isWindow || !child.yoga || child.hidden) continue;
      if (child.style?.display === 'none') continue;
      const b = child._subtreeBounds();
      if (
        b.x < box.x + 1 ||
        b.y < box.y + 1 ||
        b.x + b.width > box.x + box.width - 1 ||
        b.y + b.height > box.y + box.height - 1
      ) {
        return true;
      }
    }
    return false;
  }

  _paintChildren(ctx) {
    const order = this.paintOrder();
    if (order.length === 0) return;
    const clip = this.clipsChildren() && this._childrenCanOverflow();
    if (clip) {
      ctx.save();
      this._roundedPath(ctx, this.style.borderRadius ?? 0);
      ctx.clip();
    }
    for (const child of order) {
      if (child._offscreen()) continue;
      if (child._outsideDamage()) continue;
      child.paint(ctx);
    }
    if (clip) ctx.restore();
  }

  /**
   * Nothing this subtree draws lands in the region being repainted, so its
   * drawing does not need to be sent at all. This is where the protocol
   * saving comes from — the clip alone would still put every request on the
   * wire for the server to throw away.
   *
   * Tested against the subtree's bounds, not `abs`: see `paintBounds`.
   */
  _outsideDamage() {
    const damage = this.root?._paintDamage;
    if (!damage) return false;
    return !rectsOverlap(this._subtreeBounds(), damage);
  }

  /**
   * Entirely outside the window, or entirely outside some nearer ancestor
   * that clips its children — either way there is nothing to draw. Worth
   * doing for its own sake, but it is also a correctness fix: X's render
   * traps are 16.16 fixed point, so a coordinate past ±32767 overflows the
   * request. A scrolled list is exactly how you get there — the frame
   * between a scroll and the re-render that follows it can hold rows
   * ninety thousand pixels above the viewport.
   *
   * The ancestor walk matters on its own (issue #211): a `<scrollview>`'s
   * own box is often much smaller than the window around it, and its
   * `ctx.clip()` in `_paintChildren` only keeps the *pixels* off the visible
   * surface — every child below the fold still ran its full paint (canvas
   * `onDraw`, text/tex layout, the XRender/PutImage requests that go with
   * them) for the server to then discard. Checking the window alone missed
   * that: a node can sit well inside the window and still be entirely past
   * a `<scrollview>` ancestor whose own bounds are the real limit.
   */
  _offscreen() {
    const window = this.root?.abs;
    if (!window) return false;
    const { x, y, width, height } = this.abs;
    if (
      x + width <= 0 ||
      y + height <= 0 ||
      x >= window.width ||
      y >= window.height
    ) {
      return true;
    }
    for (let n = this.parent; n && n !== this.root; n = n.parent) {
      if (n.clipsChildren() && !rectsOverlap(this.abs, n.abs)) return true;
    }
    return false;
  }
}

export class BoxNode extends Node {
  constructor(props, app) {
    super('box', props, app);
  }
}

/**
 * Downward shift that recreates CSS "half-leading". ntk's TextLayout puts
 * the first baseline at exactly `ascent` and packs each line's leading
 * (font line gap + any lineHeight surplus) entirely *below* the glyphs, so
 * a layout drawn at the top of its measured box rides visually high —
 * most noticeable centered in buttons/inputs (fonts like Helvetica carry a
 * 0.5em line gap). CSS instead splits that leading evenly above and below
 * the ink (see seek-oss capsize for the metrics background).
 */
function halfLeading(layout) {
  const last = layout.lines?.[layout.lines.length - 1];
  if (!last) return 0;
  return Math.max(0, (layout.height - (last.baseline + last.descent)) / 2);
}

/** Raw string/number children of <text>. */
export class TextChunkNode extends Node {
  constructor(text, app) {
    super('textchunk', {}, app, { yoga: false });
    this.text = String(text);
  }

  setText(text) {
    this.text = String(text);
    this.parent?._textContentChanged();
    // the chunk has no geometry of its own — the ancestor that owns a yoga
    // node is the box that rewraps, and its before/after rects are the
    // bound on what a new string can repaint
    let owner = this.parent;
    while (owner && !owner.yoga) owner = owner.parent;
    if (owner) owner._invalidateLayout('text');
    else this.root?.invalidate(true, null, 'text');
  }

  _textContentChanged() {
    this.parent?._textContentChanged();
  }
}

/**
 * <text>. The outermost <text> owns a yoga node with a measure function;
 * nested <text> elements are style spans (no yoga node) — the paragraph is
 * laid out as one run list so wrapping spans the whole content
 * (ntk TextLayout accepts [{ text, ...style overrides, color }] spans).
 */
export class TextNode extends Node {
  constructor(props, app, { span = false } = {}) {
    super('text', props, app, { yoga: !span });
    this.isSpan = span;
    this._layouts = new Map();
    if (this.yoga) {
      this.yoga.setMeasureFunc((width, widthMode) => {
        const maxWidth =
          widthMode === Yoga.MEASURE_MODE_UNDEFINED ? Infinity : width;
        const layout = this._layoutFor(maxWidth);
        if (!layout) return { width: 0, height: 0 };
        const trim = this._trim(layout);
        return {
          width: Math.ceil(layout.width),
          height: Math.max(
            0,
            Math.ceil(layout.height) - (trim ? trim.top + trim.bottom : 0),
          ),
        };
      });
    }
  }

  _textContentChanged() {
    if (this.isSpan) {
      this.parent?._textContentChanged();
      return;
    }
    this._layouts.clear();
    if (this.yoga) this.yoga.markDirty();
  }

  applyProps(newProps, oldProps) {
    const before = this.style;
    super.applyProps(newProps, oldProps);
    if (!textStyleChanged(this.style, before)) return;
    this._textContentChanged();
    // `super.applyProps` has already committed this frame, and it decided
    // there was nothing to re-lay-out: none of `fontSize`, `fontWeight`,
    // `fontFamily`, `fontStyle`, `lineHeight` or `textAlign` is a yoga
    // property, so `applyLayoutStyle` saw nothing move, and none of them is
    // a paint prop either, so the node contributed no damage. They are all
    // inputs to the *measure function*, though — the dirty flag
    // `_textContentChanged` just set is only read by a layout pass, and
    // without asking for one the cleared layout is never rebuilt and the
    // old glyphs stay on screen. A new string reaches the same conclusion
    // through `TextChunkNode.setText`; this is that path for a new style.
    let owner = this;
    while (owner && !owner.yoga) owner = owner.parent;
    if (owner) owner._invalidateLayout('text');
    else this.root?.invalidate(true, null, 'text');
  }

  collectSpans(inherited, out) {
    const style = textStyleFrom(this.style, inherited);
    for (const child of this.children) {
      if (child.kind === 'textchunk') {
        out.push({
          text: child.text,
          family: style.family,
          size: style.size,
          weight: style.weight,
          style: style.style,
          color: style.color,
        });
      } else if (child.kind === 'text') {
        child.collectSpans(style, out);
      }
    }
    return out;
  }

  _layoutFor(maxWidth) {
    const fonts = this.app?.fonts;
    if (!fonts) return null; // mock container in tests: no text metrics
    const key = String(maxWidth);
    let layout = this._layouts.get(key);
    if (!layout) {
      const inherited = this.inheritedTextStyle;
      const spans = this.collectSpans(inherited, []);
      const base = textStyleFrom(this.style, inherited);
      layout = fonts.layout(spans, base, {
        maxWidth: Number.isFinite(maxWidth) ? maxWidth : undefined,
        align: this.style.textAlign,
        lineHeight: this.style.lineHeight,
      });
      if (this._layouts.size > 32) this._layouts.clear();
      this._layouts.set(key, layout);
    }
    return layout;
  }

  /**
   * `textBoxTrim: 'cap-alphabetic'` — CSS's `text-box-trim: trim-both` with
   * `text-box-edge: cap alphabetic`. How much of the line box to take off
   * the top and the bottom so the box *is* the letters: from the capitals
   * down to the last baseline.
   *
   * A line box is not the text you can see. It is the font's ascent plus
   * descent plus line gap, and the space over a capital differs from the
   * space under a baseline by `(ascent - capHeight) - descent` — a property
   * of the typeface, which is why padding around an untrimmed label is only
   * ever optically even by luck. `lineHeight` cannot fix it: it scales the
   * box and the leading still splits evenly, so it moves both edges alike.
   *
   * Measured in the coordinates the layout is **drawn** in, not the ones it
   * reports: `halfLeading` shifts it, and deriving the baseline from the
   * metrics again would silently disagree the day that shift changes.
   */
  _trim(layout) {
    if (this.style.textBoxTrim !== 'cap-alphabetic') return null;
    const lines = layout?.lines;
    if (!lines?.length) return null;
    const base = textStyleFrom(this.style, this.inheritedTextStyle);
    const font = this.app?.fonts?.match?.(base.family, {
      weight: base.weight,
      style: base.style,
    });
    const capHeight = font?.metrics?.(base.size)?.capHeight;
    if (!capHeight) return null; // no metrics: leave the box alone
    const shift = halfLeading(layout);
    const firstBaseline = shift + lines[0].baseline;
    const lastBaseline = shift + lines[lines.length - 1].baseline;
    return {
      top: Math.max(0, firstBaseline - capHeight),
      bottom: Math.max(0, Math.ceil(layout.height) - lastBaseline),
    };
  }

  _paintContent(ctx) {
    const content = this.contentBox();
    const layout = this._layoutFor(content.width || Infinity);
    if (!layout) return;
    // the box was shortened from the top, so the glyphs come up with it
    const trim = this._trim(layout);
    const y = content.y + halfLeading(layout) - (trim ? trim.top : 0);
    layout.draw(ctx, content.x, y);
  }
}

/**
 * The measure function the intrinsically-sized elements share — the ones
 * with a natural width and height that scale together (`<image>`, `<svg>`).
 * `natural()` returns that size; it is called per measure because it
 * arrives late (a decoded file, a parsed document).
 *
 * **Which dimensions the style fixed is something yoga already knows**, and
 * says in the measure modes: `EXACTLY` on an axis means the style made it
 * definite. Working it out a second time by reading style back would be
 * duplication; working it out by reading *props* was issue #118 — `width`
 * is a style name, so `<image width={40}>` throws in development and only
 * ever reached this branch in production.
 *
 * - Both fixed: yoga skips the measure function outright, so there is no
 *   fixed-size case to write here.
 * - Height fixed alone: scale the width with it, the way an `<img>` with
 *   only a height set does, rather than stretching to the container.
 * - Otherwise: natural size, shrunk to the width on offer, height
 *   following the aspect ratio.
 */
export function intrinsicMeasure(natural) {
  return (width, widthMode, height, heightMode) => {
    const { width: natW, height: natH } = natural();
    if (
      heightMode === Yoga.MEASURE_MODE_EXACTLY &&
      widthMode !== Yoga.MEASURE_MODE_EXACTLY &&
      natH > 0
    ) {
      return { width: (height * natW) / natH, height };
    }
    let w = natW;
    if (
      widthMode !== Yoga.MEASURE_MODE_UNDEFINED &&
      Number.isFinite(width) &&
      width < w
    ) {
      w = width;
    }
    return { width: w, height: natW > 0 ? (w * natH) / natW : natH };
  };
}

export class ImageNode extends Node {
  constructor(props, app) {
    super('image', props, app);
    this.image = null;
    this._loadToken = 0;
    this.yoga.setMeasureFunc(
      intrinsicMeasure(() => ({
        width: this.image?.width ?? 0,
        height: this.image?.height ?? 0,
      })),
    );
    this._load(props.src);
  }

  async _load(src) {
    if (!src) return;
    const token = ++this._loadToken;
    try {
      const { loadImage } = await import('ntk');
      const image = await loadImage(src);
      if (token !== this._loadToken || this.destroyed) return;
      this.image = image;
      if (this.yoga) {
        this.yoga.markDirty?.();
        this._invalidateLayout('content');
      }
    } catch (err) {
      console.error(`react-x11: failed to load image ${src}:`, err.message);
    }
  }

  applyProps(newProps, oldProps) {
    const before = oldProps ?? this.props;
    super.applyProps(newProps, oldProps);
    if (newProps.src !== before.src) {
      this.image = null;
      this._load(newProps.src);
    }
  }

  _paintContent(ctx) {
    if (!this.image) return;
    const content = this.contentBox();
    ctx.drawImage(
      this.image,
      content.x,
      content.y,
      content.width,
      content.height,
    );
  }
}

const SCROLLBAR_WIDTH = 6;
const SCROLLBAR_MIN_THUMB = 20;
// the visible bar is thin; the pointer target is not
const SCROLLBAR_SLOP = 4;

const clampScroll = (v, max) => Math.min(Math.max(0, v), max);

/**
 * Geometry of a scrollbar on either axis, or null when there is nothing to
 * scroll along it. Shared by `<scrollview>` and `<textarea>` so what is
 * painted and what the pointer hits cannot drift apart — and written once
 * for both axes so the two cannot drift from each other either.
 *
 * `viewport`/`content`/`scroll` are along the axis; `across`/`crossSize`
 * place the bar on the other one. `shorten` keeps the two bars out of each
 * other's corner when both are showing.
 */
function scrollbarGeometry({
  axis = 'y',
  start,
  viewport,
  content,
  across: crossStart0,
  crossSize,
  scroll,
  inset = 0,
  shorten = 0,
}) {
  const length = viewport - shorten;
  if (length <= 0 || !(content > viewport)) return null;
  const thumbLength = Math.max(
    SCROLLBAR_MIN_THUMB,
    (length * length) / content,
  );
  const range = content - viewport;
  const travel = Math.max(0, length - thumbLength);
  const thumbStart = start + (range > 0 ? (scroll / range) * travel : 0);
  const crossStart = crossStart0 + crossSize - SCROLLBAR_WIDTH - inset;
  return {
    axis,
    trackStart: start,
    trackLength: length,
    thumbStart,
    thumbLength,
    crossStart,
    range,
    travel,
    // the thumb as a rect, for painting
    x: axis === 'x' ? thumbStart : crossStart,
    y: axis === 'x' ? crossStart : thumbStart,
    width: axis === 'x' ? thumbLength : SCROLLBAR_WIDTH,
    height: axis === 'x' ? SCROLLBAR_WIDTH : thumbLength,
  };
}

/** The coordinate along a bar's own axis, and across it. */
const along = (bar, x, y) => (bar.axis === 'x' ? x : y);
const across = (bar, x, y) => (bar.axis === 'x' ? y : x);

/** Is this point on the bar (with slop), and if so, on the thumb? */
function scrollbarHit(bar, x, y) {
  if (!bar) return null;
  const c = across(bar, x, y);
  if (
    c < bar.crossStart - SCROLLBAR_SLOP ||
    c > bar.crossStart + SCROLLBAR_WIDTH + SCROLLBAR_SLOP
  ) {
    return null;
  }
  const a = along(bar, x, y);
  if (a < bar.trackStart || a > bar.trackStart + bar.trackLength) return null;
  return a >= bar.thumbStart && a <= bar.thumbStart + bar.thumbLength
    ? 'thumb'
    : 'track';
}

function paintScrollbarThumb(ctx, bar, color) {
  ctx.fillStyle = color || 'rgba(0, 0, 0, 0.25)';
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(bar.x, bar.y, bar.width, bar.height, 3);
  } else {
    ctx.rect(bar.x, bar.y, bar.width, bar.height);
  }
  ctx.fill();
}

/**
 * <scrollview>: a clipped viewport over its (overflowing) children. The
 * scroll offset is applied during absolutize, so painting and hit testing
 * see already-shifted rects. Wheel events scroll it by default (see
 * EventManager); scrollTo/scrollBy are available on the ref.
 */
export class ScrollViewNode extends Node {
  constructor(props, app) {
    super('scrollview', props, app);
    this.scrollY = 0;
    this.scrollX = 0;
    this.contentHeight = 0;
    this.contentWidth = 0;
    // these defaults fill in for style the author did not set, so they read
    // the resolved style, not the props
    const style = this.style;
    if (style.overflow === undefined) {
      this.yoga.setOverflow(Yoga.OVERFLOW_SCROLL);
    }
    // yoga's default flexShrink is 0, which would size the viewport to its
    // content; a scroll container must yield to the outer layout instead
    if (style.flexShrink === undefined) {
      this.yoga.setFlexShrink(1);
    }
    // …and flexShrink alone is not enough. A flex item's base size is its
    // content, and yoga (unlike CSS) does not shrink items by default — so
    // a window whose scrollview holds more rows than fit grew *past* the
    // window, pushing the footer out of view, however small the window got.
    // `flex-basis: 0` is what CSS's `flex: 1` means, and for a scroll
    // container it is always what is wanted: take the space that is left,
    // and let the content overflow into a scroll. It also fixes the whole
    // ancestor chain at once, since the content no longer counts towards
    // any of their heights.
    const sized = style.height !== undefined || style.width !== undefined;
    if (style.flexBasis === undefined && !sized && (style.flexGrow ?? 0) > 0) {
      this.yoga.setFlexBasis(0);
    }
    // the CSS `min-height: 0` idiom, for the layouts flex-basis cannot save
    if (style.minHeight === undefined) this.yoga.setMinHeight(0);
    if (style.minWidth === undefined) this.yoga.setMinWidth(0);
  }

  clipsChildren() {
    return true;
  }

  absolutize(originX, originY) {
    if (!this.yoga) return;
    this._assignAbs(
      originX + this.yoga.getComputedLeft(),
      originY + this.yoga.getComputedTop(),
      this.yoga.getComputedWidth(),
      this.yoga.getComputedHeight(),
    );
    const { right, bottom } = this._measureContent();
    this.contentHeight =
      bottom + this.yoga.getComputedPadding(Yoga.EDGE_BOTTOM);
    this.contentWidth = right + this.yoga.getComputedPadding(Yoga.EDGE_RIGHT);
    this._resolveScrollIntoView();
    this.scrollY = Math.min(Math.max(0, this.scrollY), this._maxScroll('y'));
    this.scrollX = Math.min(Math.max(0, this.scrollX), this._maxScroll('x'));
    this._reportViewport();
    const ox = this.abs.x - this.scrollX;
    const oy = this.abs.y - this.scrollY;
    // The layout diff and a scroll would double-report each other: a scroll
    // is a uniform shift of everything below this viewport, already claimed
    // as the viewport itself (or narrowed to the exposed strip by the blit),
    // and per-child old/new claims would re-widen the very frame the blit
    // narrows. So when the children's origin moved, the walk below runs
    // with the diff off. When it did not move, a child that moved did so by
    // real layout — claim it, but clipped to the viewport: ink below the
    // fold never reaches the surface, and an unclipped claim would repaint
    // whatever unrelated UI sits under this node's off-viewport extent.
    const shifted =
      this._childOrigin &&
      (this._childOrigin.x !== ox || this._childOrigin.y !== oy);
    this._childOrigin = { x: ox, y: oy };
    const outer = layoutDiffSink;
    if (outer) {
      if (shifted) {
        layoutDiffSink = null;
      } else {
        const vp = insetRect(this.abs, -DAMAGE_SLOP);
        layoutDiffSink = (rect) => {
          const clipped = intersectRects(rect, vp);
          if (clipped) outer(clipped);
        };
      }
    }
    try {
      for (const child of this.children) {
        if (!child.isWindow) {
          child.absolutize(ox, oy);
        }
      }
    } finally {
      layoutDiffSink = outer;
    }
  }

  /**
   * Tell the owner how big the viewport and the content turned out, when
   * either changes. Layout happens on the frame clock, *after* the commit
   * that mounted the node, so an effect cannot read this off the ref —
   * which is exactly what a list needs before it can decide how many rows
   * are worth building. Fired from layout rather than from scrolling, so
   * it also arrives for a list nobody has scrolled yet.
   */
  _reportViewport() {
    const next = {
      width: this.abs.width,
      height: this.abs.height,
      contentWidth: this.contentWidth,
      contentHeight: this.contentHeight,
    };
    const last = this._lastViewport;
    if (
      last &&
      last.width === next.width &&
      last.height === next.height &&
      last.contentWidth === next.contentWidth &&
      last.contentHeight === next.contentHeight
    ) {
      return;
    }
    this._lastViewport = next;
    // during layout: defer, or a setState from the handler would re-enter
    // the pass that is still running
    const notify = this.props.onViewport;
    if (notify) setImmediate(() => !this.destroyed && notify(next));
  }

  /**
   * How far the content actually reaches, measured through the subtree
   * rather than off the direct children. A row that stretches to the
   * viewport while its own cells overflow it — a table, in other words —
   * reports the viewport width at the top level and says nothing about the
   * cells, so a shallow measurement would find nothing to scroll. This is
   * what `scrollWidth`/`scrollHeight` mean in a browser.
   *
   * Anything that clips its own children ends the walk: their overflow is
   * that node's business, not ours.
   */
  _measureContent() {
    let right = 0;
    let bottom = 0;
    const walk = (node, dx, dy) => {
      for (const child of node.children) {
        if (child.isWindow || !child.yoga || child.hidden) continue;
        const x = dx + child.yoga.getComputedLeft();
        const y = dy + child.yoga.getComputedTop();
        right = Math.max(right, x + child.yoga.getComputedWidth());
        bottom = Math.max(bottom, y + child.yoga.getComputedHeight());
        if (!child.clipsChildren()) walk(child, x, y);
      }
    };
    walk(this, 0, 0);
    return { right, bottom };
  }

  _maxScroll(axis) {
    return axis === 'x'
      ? Math.max(0, this.contentWidth - this.abs.width)
      : Math.max(0, this.contentHeight - this.abs.height);
  }

  /**
   * `scrollTo(y)` scrolls vertically, as it always has; `scrollTo({x, y})`
   * moves either axis, leaving out whichever is omitted.
   */
  scrollTo(to) {
    const want = typeof to === 'number' ? { y: to } : { x: to?.x, y: to?.y };
    const next = {
      x:
        want.x == null
          ? this.scrollX
          : clampScroll(want.x, this._maxScroll('x')),
      y:
        want.y == null
          ? this.scrollY
          : clampScroll(want.y, this._maxScroll('y')),
    };
    if (next.x === this.scrollX && next.y === this.scrollY) return;
    const root = this.root;
    if (root) {
      // The offsets whose pixels are on screen, captured before the first
      // change of the frame: the frame's blit fast path (issue #138) shifts
      // from *these* to wherever layout settles, however many scrollTo
      // calls land in between.
      this._pendingBlitFrom ??= { x: this.scrollX, y: this.scrollY };
      (root._pendingScrolls ??= new Set()).add(this);
      // ... and the claim about to be recorded is the scroll itself, not a
      // reason to un-blit it
      root._scrollClaim = this;
    }
    this.scrollX = next.x;
    this.scrollY = next.y;
    this.props.onScroll?.({
      scrollX: next.x,
      scrollY: next.y,
      contentWidth: this.contentWidth,
      contentHeight: this.contentHeight,
      viewportWidth: this.abs.width,
      viewportHeight: this.abs.height,
    });
    // A scroll reflows this viewport's contents and nothing else, and the
    // viewport clips them, so the damage is this node's own rect. It is a
    // layout change all the same — children's absolute positions move — hence
    // both arguments. Unbounded, every wheel notch repainted the whole window,
    // which is the whole cost of scrolling: the client work is negligible next
    // to what the server then has to redraw. (When the frame turns out to be
    // a *pure* scroll, _applyScrollBlits later narrows this claim to the
    // exposed strip and blits the rest — see WindowNode.)
    this.root?.invalidate(true, this, 'scroll');
    if (root) root._scrollClaim = null;
  }

  /** `scrollBy(dy)`, or `scrollBy({x, y})` for either axis. */
  scrollBy(by) {
    if (typeof by === 'number') return this.scrollTo(this.scrollY + by);
    this.scrollTo({
      x: by?.x == null ? undefined : this.scrollX + by.x,
      y: by?.y == null ? undefined : this.scrollY + by.y,
    });
  }

  /**
   * A scrollview with something to scroll is a tab stop, so a pane of
   * *unfocusable* content — a log, a long `<text>`, a `<markdown>` — can be
   * read without a pointer. Before this the only way to scroll one was the
   * wheel, which is a WCAG 2.1.1 failure on the most ordinary layout the
   * library has.
   *
   * Conditional on purpose: a scrollview that fits its content is a `<box>`
   * with a clip, and stopping Tab on it would be a tab stop that does
   * nothing. It is answered from the current layout, so a pane that grows
   * past its viewport becomes reachable the moment it does.
   */
  get focusableByDefault() {
    return this._maxScroll('y') > 0 || this._maxScroll('x') > 0;
  }

  /**
   * The keys a scroll pane answers, matching what every desktop toolkit
   * does: arrows by a wheel notch, PageUp/PageDown by a viewport, Home/End
   * to the ends, Space and Shift+Space as a second pair of page keys
   * because that is what a reader's hand is already on.
   *
   * Runs after the application's own `onKeyDown`, and not at all if that
   * called `preventDefault` — the same contract `<textinput>` editing has.
   */
  _defaultKeyDown(ev) {
    const page = Math.max(1, this.abs.height - SCROLL_KEY_PAGE_OVERLAP);
    switch (ev.keysym) {
      case XK_DOWN:
        return this.scrollBy({ y: SCROLL_KEY_STEP });
      case XK_UP:
        return this.scrollBy({ y: -SCROLL_KEY_STEP });
      case XK_RIGHT:
        return this.scrollBy({ x: SCROLL_KEY_STEP });
      case XK_LEFT:
        return this.scrollBy({ x: -SCROLL_KEY_STEP });
      case XK_PAGE_DOWN:
        return this.scrollBy({ y: page });
      case XK_PAGE_UP:
        return this.scrollBy({ y: -page });
      case XK_HOME:
        return this.scrollTo({ y: 0 });
      case XK_END:
        return this.scrollTo({ y: this._maxScroll('y') });
      case XK_SPACE:
        return this.scrollBy({ y: ev.shiftKey ? -page : page });
      default:
        return undefined;
    }
  }

  /**
   * Scroll the minimum amount that brings a descendant fully into view.
   * The request is queued rather than applied immediately: absolute rects
   * only exist after a layout pass, so a caller reacting to a mount (a
   * list widget moving its selection, say) would otherwise measure a node
   * that has no geometry yet. `absolutize` resolves it against freshly
   * computed yoga positions.
   */
  scrollIntoView(node) {
    if (!node) return;
    this._scrollIntoViewTarget = node;
    // whatever the resolved scroll moves is inside this clipped viewport,
    // so the viewport's own before/after rects bound the frame
    this._invalidateLayout('scroll');
  }

  _resolveScrollIntoView() {
    const target = this._scrollIntoViewTarget;
    if (!target) return;
    this._scrollIntoViewTarget = null;
    if (target.destroyed || !target.yoga) return;
    // offset of the target within our content box, summed up the chain so
    // targets nested below a direct child work too
    let top = 0;
    let left = 0;
    for (let n = target; n && n !== this; n = n.parent) {
      if (!n.yoga) return; // not (or no longer) inside this scrollview
      top += n.yoga.getComputedTop();
      left += n.yoga.getComputedLeft();
      if (!n.parent) return;
    }
    const bottom = top + target.yoga.getComputedHeight();
    const rightEdge = left + target.yoga.getComputedWidth();
    if (bottom > this.scrollY + this.abs.height) {
      this.scrollY = bottom - this.abs.height;
    }
    if (top < this.scrollY) this.scrollY = top;
    if (rightEdge > this.scrollX + this.abs.width) {
      this.scrollX = rightEdge - this.abs.width;
    }
    if (left < this.scrollX) this.scrollX = left;
  }

  paint(ctx) {
    super.paint(ctx);
    for (const bar of this._scrollbars()) {
      paintScrollbarThumb(ctx, bar, this.props.scrollbarColor);
    }
  }

  /** null when the bar is switched off or there is nothing to scroll on
   * that axis. */
  _scrollbar(axis = 'y') {
    if (this.props.scrollbar === false) return null;
    const horizontal = axis === 'x';
    // when both bars show, each stops short of the other's corner
    const other = horizontal
      ? this.contentHeight > this.abs.height
      : this.contentWidth > this.abs.width;
    return scrollbarGeometry({
      axis,
      start: horizontal ? this.abs.x : this.abs.y,
      viewport: horizontal ? this.abs.width : this.abs.height,
      content: horizontal ? this.contentWidth : this.contentHeight,
      across: horizontal ? this.abs.y : this.abs.x,
      crossSize: horizontal ? this.abs.height : this.abs.width,
      scroll: horizontal ? this.scrollX : this.scrollY,
      inset: 2,
      shorten: other ? SCROLLBAR_WIDTH + 2 : 0,
    });
  }

  _scrollbars() {
    return [this._scrollbar('y'), this._scrollbar('x')].filter(Boolean);
  }

  /**
   * The bar belongs to the scroller, not to the content under it — the same
   * rule a browser applies. Without this a press on the thumb would be
   * delivered to whatever child happens to be painted beneath it.
   */
  hitTest(x, y) {
    for (const bar of this._scrollbars()) {
      if (scrollbarHit(bar, x, y)) return this;
    }
    return super.hitTest(x, y);
  }

  _defaultMouseDown(ev) {
    for (const bar of this._scrollbars()) {
      const hit = scrollbarHit(bar, ev.x, ev.y);
      if (!hit) continue;
      const at = along(bar, ev.x, ev.y);
      if (hit === 'thumb') {
        // remember where in the thumb it was grabbed, so it does not jump
        this._barGrab = { axis: bar.axis, offset: at - bar.thumbStart };
        ev.capturePointer();
        return;
      }
      // a press on the track pages towards it, like PageUp/PageDown
      const page = bar.axis === 'x' ? this.abs.width : this.abs.height;
      const delta = at < bar.thumbStart ? -page : page;
      this.scrollBy(bar.axis === 'x' ? { x: delta } : { y: delta });
      return;
    }
  }

  _defaultMouseDrag(ev) {
    if (this._barGrab == null) return;
    const bar = this._scrollbar(this._barGrab.axis);
    if (!bar || bar.travel <= 0) return;
    const at = along(bar, ev.x, ev.y) - this._barGrab.offset - bar.trackStart;
    const to = (at / bar.travel) * bar.range;
    this.scrollTo(bar.axis === 'x' ? { x: to } : { y: to });
  }

  _defaultMouseUp() {
    this._barGrab = null;
  }
}

/** Escape hatch: a retained node whose content is painted by props.onDraw. */
export class CanvasNode extends Node {
  constructor(props, app) {
    super('canvas', props, app);
  }

  applyProps(newProps, oldProps) {
    const before = oldProps ?? this.props;
    super.applyProps(newProps, oldProps);
    // onDraw is read at paint time, so a new closure means new content — but
    // it also matches /^on[A-Z]/, which is how the base class recognises an
    // event handler, so `_paintChanged` skips it and this is the only place
    // that notices. Damage is bounded to this canvas: an unbounded call here
    // made every re-render of a component that draws through <canvas> repaint
    // the whole window, which is what a Checkbox's tick and a Select's chevron
    // both do.
    if (newProps.onDraw !== before.onDraw) {
      this.root?.invalidate(false, this, 'props');
    }
  }

  _paintContent(ctx) {
    const onDraw = this.props.onDraw;
    if (typeof onDraw !== 'function') return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(this.abs.x, this.abs.y, this.abs.width, this.abs.height);
    ctx.clip();
    ctx.translate(this.abs.x, this.abs.y);
    try {
      onDraw(ctx, {
        width: this.abs.width,
        height: this.abs.height,
        node: this,
      });
    } finally {
      ctx.restore();
    }
  }

  /**
   * `<canvas cacheKey>` opts a drawing into the paint cache.
   *
   * This one has to be opt-in, and the reason is worth stating: `onDraw` is
   * an opaque closure. Nothing here can know what it reads — a prop, a ref, a
   * clock, a module variable — and its identity changes on every render
   * unless the app memoizes it, so it is not a key either. Only the author
   * knows, so the author says:
   *
   *   <canvas cacheKey={`spark:${series.id}:${w}x${h}`} onDraw={draw} />
   *
   * The rule is the protocol's rule: the key must name every input the
   * drawing reads. A `cacheKey` that leaves one out shows stale pixels, so
   * develop with `REACT_X11_PAINT_CACHE=verify`, which turns exactly that
   * mistake into a loud complaint.
   *
   * `<canvas>` needs no `paintCached`: it already draws origin-relative, so
   * the cached render and the live one are the same code.
   */
  paintCachePlan() {
    const { cacheKey, onDraw } = this.props;
    if (cacheKey == null || typeof onDraw !== 'function') return null;
    const width = Math.ceil(this.abs.width);
    const height = Math.ceil(this.abs.height);
    if (width <= 0 || height <= 0) return null;
    return {
      key: `canvas|${width}x${height}@1|${cacheKey}`,
      x: Math.round(this.abs.x),
      y: Math.round(this.abs.y),
      width,
      height,
      format: 'argb32',
      tint: null,
    };
  }

  paintCached(ctx, box) {
    const onDraw = this.props.onDraw;
    if (typeof onDraw !== 'function') return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(box.x, box.y, box.width, box.height);
    ctx.clip();
    ctx.translate(box.x, box.y);
    try {
      onDraw(ctx, { width: box.width, height: box.height, node: this });
    } finally {
      ctx.restore();
    }
  }
}

const XK_BACKSPACE = 0xff08;
const XK_RETURN = 0xff0d;
const XK_KP_ENTER = 0xff8d;
const XK_HOME = 0xff50;
const XK_LEFT = 0xff51;
const XK_UP = 0xff52;
const XK_RIGHT = 0xff53;
const XK_DOWN = 0xff54;
const XK_PAGE_UP = 0xff55;
const XK_PAGE_DOWN = 0xff56;
const XK_END = 0xff57;
const XK_DELETE = 0xffff;
const XK_ESCAPE = 0xff1b;
const XK_SPACE = 0x0020;

// An arrow key scrolls by a wheel notch — the same 48px `WHEEL_BUTTONS`
// moves in events.js, so the two input routes agree about what one step is.
const SCROLL_KEY_STEP = 48;
// A page keeps a sliver of the previous one on screen, so the eye has
// somewhere to land. Toolkits all keep a line or two; this is about that.
const SCROLL_KEY_PAGE_OVERLAP = 24;

/** Undo entries kept per input. Snapshots of a single field are small; the
 * cap is what stops a long-lived form from growing without bound. */
const UNDO_LIMIT = 200;

/**
 * The letter of a Ctrl chord, independent of Shift. ntk derives `codepoint`
 * from the *shifted* keysym, so Ctrl+Shift+Z arrives as `Z` while Ctrl+Z
 * arrives as `z` — the keysym does not shift, so match on that and fall
 * back to the codepoint when the keymap has not been read yet.
 */
function ctrlChordLetter(ev) {
  const code = ev.keysym ?? ev.codepoint;
  if (code == null) return null;
  return code >= 0x41 && code <= 0x5a ? code + 0x20 : code;
}

/**
 * <textinput>: single-line editable text. Caret/selection via ntk TextLayout
 * prefix measurement, editing via the EventManager default-action hooks
 * (user onKeyDown/onMouseDown handlers run first and can preventDefault).
 * Clipboard: Ctrl+C/X/V on CLIPBOARD, X11-style middle-click paste and
 * select-to-own on PRIMARY (needs ntk >= 5.4.0 app.clipboard; degrades
 * gracefully without it). Controlled (`value` + `onChange`) or uncontrolled
 * (`defaultValue`). Caret indices are in code points, not UTF-16 units.
 */
export class TextInputNode extends Node {
  constructor(props, app, kind = 'textinput') {
    super(kind, props, app);
    this.focusableByDefault = true;
    this.defaultCursor = 'text';
    this._value =
      props.defaultValue != null ? String(props.defaultValue) : null;
    // set only while an onChange/onSubmit handler is on the stack — see
    // `get value()` and `_fireValueEvent`
    this._pendingValue = null;
    // the X key event driving the current edit, for `ev.nativeEvent`
    this._keyNative = null;
    this._caret = this._chars().length;
    this._anchor = this._caret;
    this._scrollX = 0;
    this._focused = false;
    this._caretOn = false;
    this._blinkTimer = null;
    this._dragging = false;
    // undo/redo: snapshots of every state this input has shown, oldest
    // first, with _historyIndex on the current one
    this._history = [
      { value: this.value, caret: this._caret, anchor: this._anchor },
    ];
    this._historyIndex = 0;
    this._historyValue = this.value;
    this._undoRun = null;
    // the open built-in edit menu, if any (see _openEditMenu)
    this._editMenu = null;
    this.yoga.setMeasureFunc((width, widthMode) => {
      const preferred = 150;
      const w =
        widthMode === Yoga.MEASURE_MODE_UNDEFINED
          ? preferred
          : Math.min(preferred, width);
      return { width: w, height: Math.ceil(this._lineHeight()) };
    });
  }

  get value() {
    // While an onChange handler is running, the control's value is the one
    // the edit produced — the DOM behaves the same way, and it is what makes
    // `ev.target.value` right in *controlled* mode, where `props.value` is
    // still the old string until the parent re-renders.
    if (this._pendingValue !== null) return this._pendingValue;
    if (this.props.value != null) return String(this.props.value);
    return this._value ?? '';
  }

  /**
   * Writing `node.value = 'x'` sets the text the way typing would, minus the
   * `onChange` — assigning to a DOM input's `value` does not fire one
   * either. It exists because form libraries reset a field through the ref:
   * react-hook-form's `register()` does `ref.value = ''` on mount and on
   * `reset()`, and a getter-only `value` made that a TypeError during commit.
   *
   * On a **controlled** input `props.value` still wins the next time the
   * parent renders, exactly as in the DOM.
   */
  set value(next) {
    const text = next == null ? '' : String(next);
    if (text === this._value) return;
    this._value = text;
    const len = Array.from(text).length;
    this._caret = Math.min(this._caret, len);
    this._anchor = Math.min(this._anchor, len);
    // same bookkeeping a value arriving through props gets: its own undo
    // entry, so Ctrl+Z steps back through a programmatic reset too
    this._noteExternalValue();
    this._repaint();
  }

  /** The `name` prop, so `ev.target.name` reads the way the DOM does. */
  get name() {
    return this.props.name;
  }

  /**
   * The synthetic event `onChange` and `onSubmit` are handed. Same shape
   * every other handler in the system gets — `_makeEvent` builds it — with
   * the value on both `ev.value` and `ev.target.value`, and `name` mirrored
   * the same way, because that is what every DOM form library reads.
   *
   * `_makeEvent` lives on the owning window's EventManager; a node that is
   * not attached to one (a unit test, an edit that outlives its window) gets
   * an equivalent object rather than nothing.
   */
  _makeValueEvent(type, native) {
    // not dispatched through the tree, so currentTarget is the target —
    // exactly what the DOM reports for a handler on the element itself
    const extra = {
      value: this.value,
      name: this.props.name,
      currentTarget: this,
    };
    const events = this.root?.events;
    if (events) return events._makeEvent(type, native, this, extra);
    const ev = {
      type,
      x: native?.x ?? 0,
      y: native?.y ?? 0,
      target: this,
      nativeEvent: native ?? null,
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
      capturePointer() {},
      releasePointer() {},
      ...extra,
    };
    return ev;
  }

  /**
   * Call `onChange`/`onSubmit` with `value` as the control's current value,
   * whatever `props.value` still says. Restored in a `finally` so a throwing
   * handler cannot leave the control reporting a value it never took.
   */
  _fireValueEvent(prop, value, native = null) {
    const handler = this.props[prop];
    if (!handler) return;
    native ??= this._keyNative;
    const previous = this._pendingValue;
    this._pendingValue = value;
    const type = prop === 'onSubmit' ? 'submit' : 'change';
    try {
      callHandler(this, prop, handler, this._makeValueEvent(type, native));
    } finally {
      this._pendingValue = previous;
    }
  }

  _chars() {
    return Array.from(this.value);
  }

  _textStyle() {
    return textStyleFrom(this.style, this.inheritedTextStyle);
  }

  _layoutOf(text) {
    const fonts = this.app?.fonts;
    if (!fonts) return null;
    const style = this._textStyle();
    return fonts.layout(text, style);
  }

  _lineHeight() {
    const layout = this._layoutOf('Mg');
    if (layout) return layout.height;
    return (this.style.fontSize ?? DEFAULT_TEXT_STYLE.size) * 1.4;
  }

  /** Shaped layout of the current value, cached per (value, style).
   * Caret math rides ntk >= 3.3.0's TextLayout caret API, which is exact
   * across kerning/shaping boundaries, bidi runs and trailing whitespace
   * (replaces the prefix-width measurement this used before). */
  _valueLayout() {
    const fonts = this.app?.fonts;
    if (!fonts) return null;
    const text = this.value;
    const s = this._textStyle();
    const key = `${text}|${s.family}|${s.size}|${s.weight}|${s.style}`;
    if (this._valueLayoutKey !== key) {
      this._valueLayoutKey = key;
      this._valueLayoutCache = fonts.layout(text, s);
    }
    return this._valueLayoutCache;
  }

  /** Visual caret x for a logical code-point index. */
  _prefixWidth(count) {
    const layout = this._valueLayout();
    if (!layout) return 0;
    return layout.caretPosition(count).x;
  }

  _selection() {
    return [
      Math.min(this._caret, this._anchor),
      Math.max(this._caret, this._anchor),
    ];
  }

  _selectedText() {
    const [a, b] = this._selection();
    return this._chars().slice(a, b).join('');
  }

  _repaint() {
    this._caretOn = true;
    this.root?.invalidate(false, this, 'text');
  }

  /**
   * The one place the value changes. `kind` names the edit for undo
   * coalescing (`type`, `delete-back`, `delete-forward`); anything left
   * unnamed — a paste, a cut, a replaced selection, a newline — is its own
   * undo step.
   */
  _commit(nextChars, caret, kind = null) {
    const next = nextChars.join('');
    const previous = this.value;
    const beforeCaret = this._caret;
    const beforeAnchor = this._anchor;
    this._caret = caret;
    this._anchor = caret;
    if (this.props.value == null) this._value = next;
    if (next !== previous) {
      // `this.value` is still the old one in controlled mode — the parent
      // has not answered onChange yet — so record what we computed
      this._recordEdit(kind, {
        value: next,
        caret,
        anchor: caret,
        beforeCaret,
        beforeAnchor,
      });
      this._fireValueEvent('onChange', next);
    }
    this._repaint();
  }

  // --- undo/redo ------------------------------------------------------
  //
  // Full-value snapshots rather than a diff log: a single field is small,
  // and a snapshot is the only representation that stays right when the
  // value is controlled and the parent rewrites what we send it. Each
  // entry also carries the caret from *before* the edit that produced it,
  // so undoing puts the caret back where the typing happened rather than
  // where the run ended.

  /** True while there is an earlier state to go back to. */
  get canUndo() {
    return this._historyIndex > 0;
  }

  /** True while an undone state is still ahead. */
  get canRedo() {
    return this._historyIndex < this._history.length - 1;
  }

  /** Step back one edit. Returns false when there is nothing to undo. */
  undo() {
    if (!this.canUndo) return false;
    const undone = this._history[this._historyIndex];
    const target = this._history[--this._historyIndex];
    // the caret goes where the undone edit started, not where it ended
    this._applyHistory(target.value, undone.beforeCaret, undone.beforeAnchor);
    return true;
  }

  /** Step forward one undone edit. False when there is nothing to redo. */
  redo() {
    if (!this.canRedo) return false;
    const target = this._history[++this._historyIndex];
    this._applyHistory(target.value, target.caret, target.anchor);
    return true;
  }

  /** End the coalescing run: the next edit starts a fresh undo entry. */
  _breakUndoRun() {
    this._undoRun = null;
  }

  _applyHistory(value, caret, anchor) {
    this._breakUndoRun();
    const previous = this.value;
    if (this.props.value == null) this._value = value;
    this._historyValue = value;
    const len = Array.from(value).length;
    this._caret = Math.min(Math.max(0, caret), len);
    this._anchor = Math.min(Math.max(0, anchor), len);
    if (value !== previous) this._fireValueEvent('onChange', value);
    this._repaint();
  }

  /**
   * Fold the edit into the open run, or start a new entry. A run continues
   * while the same kind of edit keeps happening at the caret it left off
   * at, so a word of typing — or a run of backspaces — undoes as one step.
   */
  _recordEdit(kind, entry) {
    const top = this._history[this._historyIndex];
    const continues =
      kind != null &&
      kind === this._undoRun &&
      // a replaced selection is a distinct edit, however it was typed
      entry.beforeCaret === entry.beforeAnchor &&
      top?.caret === entry.beforeCaret;
    if (continues) {
      top.value = entry.value;
      top.caret = entry.caret;
      top.anchor = entry.anchor;
    } else {
      this._pushHistory(kind, entry);
    }
    this._historyValue = entry.value;
  }

  _pushHistory(kind, entry) {
    // a fresh edit after an undo drops whatever was ahead
    this._history.length = this._historyIndex + 1;
    this._history.push(entry);
    if (this._history.length > UNDO_LIMIT) this._history.shift();
    this._historyIndex = this._history.length - 1;
    this._undoRun = kind;
  }

  /**
   * A controlled `value` that changed to something we did not commit was
   * edited outside the control — a form reset, or an onChange that filters
   * what it is given. It becomes its own history entry, so undo walks back
   * through states that really existed. The neighbour checks catch the
   * parent echoing an undo back at us, or refusing one: that moves through
   * the history instead of appending to it, which is what keeps a filtering
   * onChange from growing the stack on every keystroke.
   */
  _noteExternalValue() {
    const value = this.value;
    if (value === this._historyValue) return;
    this._breakUndoRun();
    if (this._history[this._historyIndex + 1]?.value === value) {
      this._historyIndex++;
    } else if (this._history[this._historyIndex - 1]?.value === value) {
      this._historyIndex--;
    } else {
      this._pushHistory(null, {
        value,
        caret: this._caret,
        anchor: this._anchor,
        beforeCaret: this._caret,
        beforeAnchor: this._anchor,
      });
    }
    this._historyValue = value;
  }

  /** Single-line: newlines collapse to spaces (textarea overrides). */
  _normalizeInsert(text) {
    return String(text).replace(/[\r\n]+/g, ' ');
  }

  _insert(text, kind = null) {
    const insert = Array.from(this._normalizeInsert(text));
    if (this.props.maxLength != null) {
      const room =
        this.props.maxLength -
        (this._chars().length - (this._selection()[1] - this._selection()[0]));
      if (insert.length > room) insert.length = Math.max(0, room);
    }
    const chars = this._chars();
    const [a, b] = this._selection();
    this._commit(
      [...chars.slice(0, a), ...insert, ...chars.slice(b)],
      a + insert.length,
      kind,
    );
  }

  _deleteRange(from, to, kind = null) {
    const chars = this._chars();
    this._commit([...chars.slice(0, from), ...chars.slice(to)], from, kind);
  }

  _moveCaret(index, extend) {
    const len = this._chars().length;
    this._caret = Math.min(Math.max(0, index), len);
    if (!extend) this._anchor = this._caret;
    // typing that resumes somewhere else is a new edit, not the old one
    this._breakUndoRun();
    this._repaint();
  }

  _clipboardApi() {
    return this.app?.clipboard ?? null;
  }

  _copySelection(selection = 'CLIPBOARD') {
    const text = this._selectedText();
    if (!text) return;
    this._clipboardApi()
      // ICCCM 2.1: the timestamp of the event that triggered the copy is
      // what arbitrates a race with another app copying at the same moment.
      // It also saves ntk a round trip asking the server for one, which on
      // PRIMARY is a round trip per selection-extending keystroke.
      ?.write(text, { selection, time: inputTime(this.app) })
      .catch((err) => {
        // Losing the race is now possible rather than theoretical: a real
        // event timestamp can be older than another client's, where the
        // server-time fallback never was. A cut that deleted the text
        // without acquiring the selection should not be silent.
        //
        // `err?.message ?? err` because a throw in here would be an
        // unhandled rejection, which ends the process — the exact failure
        // errors.js exists to keep away from a GUI event path.
        console.warn(
          `react-x11: could not take the ${selection} selection: ${err?.message ?? err}`,
        );
      });
  }

  _pasteFrom(selection = 'CLIPBOARD') {
    this._clipboardApi()
      // ICCCM 2.4: convert with the timestamp of the event that asked for
      // the paste, so an owner that has replaced its data since can tell
      // which value was wanted (ntk >= 5.4.0)
      ?.read({ selection, time: inputTime(this.app) })
      .then((text) => {
        if (!this.destroyed && text) this._insert(text);
      })
      .catch(() => {});
  }

  // --- default actions (run after user handlers unless preventDefault) ---

  /**
   * Remember the X event driving the edit so the `onChange` it produces can
   * carry it on `nativeEvent`. Subclasses override `_editKeyDown`, not this,
   * so the bookkeeping cannot be forgotten in one of them.
   *
   * Only keystrokes get this far. A paste resolves a promise, an undo is not
   * an input event at all, and a value pushed from a parent has no X event
   * behind it — those report `nativeEvent: null`, which is the truth.
   */
  _defaultKeyDown(ev) {
    const previous = this._keyNative;
    this._keyNative = ev.nativeEvent ?? null;
    try {
      this._editKeyDown(ev);
    } finally {
      this._keyNative = previous;
    }
  }

  _editKeyDown(ev) {
    const [a, b] = this._selection();
    const hasSelection = a !== b;
    const k = ev.keysym;

    if (k === XK_RETURN || k === XK_KP_ENTER) {
      this._fireValueEvent('onSubmit', this.value, ev.nativeEvent);
      return;
    }
    if (k === XK_BACKSPACE) {
      if (hasSelection) this._deleteRange(a, b);
      else if (ev.ctrlKey) this._deleteRange(this._wordBoundary(a, -1), a);
      else if (a > 0) this._deleteRange(a - 1, a, 'delete-back');
      return;
    }
    if (k === XK_DELETE) {
      if (hasSelection) this._deleteRange(a, b);
      else if (ev.ctrlKey) this._deleteRange(a, this._wordBoundary(a, 1));
      else {
        this._deleteRange(
          a,
          Math.min(a + 1, this._chars().length),
          'delete-forward',
        );
      }
      return;
    }
    if (k === XK_LEFT) {
      if (ev.ctrlKey) {
        this._moveCaret(this._wordBoundary(this._caret, -1), ev.shiftKey);
      } else if (!ev.shiftKey && hasSelection) {
        this._moveCaret(a, false);
      } else {
        this._moveCaret(this._caret - 1, ev.shiftKey);
      }
      if (ev.shiftKey) this._copySelection('PRIMARY');
      return;
    }
    if (k === XK_RIGHT) {
      if (ev.ctrlKey) {
        this._moveCaret(this._wordBoundary(this._caret, 1), ev.shiftKey);
      } else if (!ev.shiftKey && hasSelection) {
        this._moveCaret(b, false);
      } else {
        this._moveCaret(this._caret + 1, ev.shiftKey);
      }
      if (ev.shiftKey) this._copySelection('PRIMARY');
      return;
    }
    if (k === XK_HOME) {
      this._moveCaret(0, ev.shiftKey);
      return;
    }
    if (k === XK_END) {
      this._moveCaret(this._chars().length, ev.shiftKey);
      return;
    }
    if (ev.ctrlKey) {
      const letter = ctrlChordLetter(ev);
      if (letter === 0x61 /* a */) {
        this._selectAll();
      } else if (letter === 0x63 /* c */) {
        this._copySelection();
      } else if (letter === 0x78 /* x */) {
        this._copySelection();
        if (hasSelection) this._deleteRange(a, b);
      } else if (letter === 0x76 /* v */) {
        this._pasteFrom();
      } else if (letter === 0x7a /* z */) {
        // Ctrl+Shift+Z redoes, the way it does in GTK and Qt
        if (ev.shiftKey) this.redo();
        else this.undo();
      } else if (letter === 0x79 /* y */) {
        this.redo();
      }
      return;
    }
    if (ev.codepoint != null && ev.codepoint >= 0x20 && ev.codepoint !== 0x7f) {
      const ch = String.fromCodePoint(ev.codepoint);
      this._insert(ch, 'type');
      // undo a word at a time: the space that ends a word joins the run it
      // ends, and the next word starts a fresh one
      if (/\s/.test(ch)) this._breakUndoRun();
    }
  }

  /** Click-to-caret: logical code-point index for a window x coordinate. */
  _indexAtX(x) {
    const layout = this._valueLayout();
    if (!layout) return this._chars().length;
    const content = this.contentBox();
    return layout.indexAt(x - content.x + this._scrollX, 0);
  }

  /** Click-to-caret for a mouse event (textarea also uses ev.y). */
  _indexAtPoint(ev) {
    return this._indexAtX(ev.x);
  }

  /** Word range around a code-point index (whitespace-delimited). */
  _wordRangeAt(index) {
    const chars = this._chars();
    if (chars.length === 0) return [0, 0];
    let i = Math.min(index, chars.length - 1);
    const isSpace = (c) => /\s/.test(c);
    if (isSpace(chars[i]) && i > 0) i--;
    let a = i;
    let b = i;
    while (a > 0 && !isSpace(chars[a - 1])) a--;
    while (b < chars.length && !isSpace(chars[b])) b++;
    return [a, b];
  }

  /**
   * Caret index one word away, the way Ctrl+arrow moves in a text editor:
   * skip any run of non-word characters, then the word itself. Word
   * characters are letters, digits and underscore, so "foo-bar" is two
   * words and "foo_bar" is one.
   */
  _wordBoundary(from, dir) {
    const chars = this._chars();
    const isWord = (c) => /[\p{L}\p{N}_]/u.test(c);
    let i = Math.max(0, Math.min(from, chars.length));
    if (dir > 0) {
      while (i < chars.length && !isWord(chars[i])) i++;
      while (i < chars.length && isWord(chars[i])) i++;
    } else {
      while (i > 0 && !isWord(chars[i - 1])) i--;
      while (i > 0 && isWord(chars[i - 1])) i--;
    }
    return i;
  }

  _defaultMouseDown(ev) {
    // wherever the caret lands, editing resumes as a new undo entry
    this._breakUndoRun();
    if (ev.button === 3) {
      // A right-click is about to open a menu that acts on the selection,
      // so it must not be the thing that throws the selection away: a click
      // inside one keeps it, and only a click outside moves the caret. Both
      // GTK and Qt behave this way, and it is why this cannot fall through
      // to the caret placement below — that also started a drag nobody
      // asked for.
      const i = this._indexAtPoint(ev);
      const [a, b] = this._selection();
      if (i < a || i > b) {
        this._caret = i;
        this._anchor = i;
        this._repaint();
      }
      return;
    }
    if (ev.button === 2) {
      // X11 middle-click: paste the PRIMARY selection at the click position
      const i = this._indexAtPoint(ev);
      this._caret = i;
      this._anchor = i;
      this._pasteFrom('PRIMARY');
      return;
    }
    const i = this._indexAtPoint(ev);
    if (ev.detail >= 3) {
      this._anchor = 0;
      this._caret = this._chars().length;
      this._ownSelection();
      return;
    }
    if (ev.detail === 2) {
      const [a, b] = this._wordRangeAt(i);
      this._anchor = a;
      this._caret = b;
      this._ownSelection();
      return;
    }
    // shift+click extends from the existing anchor rather than starting a
    // fresh selection, and keeps dragging from there
    if (ev.shiftKey) {
      this._caret = i;
      this._dragging = true;
      this._ownSelection();
      return;
    }
    this._caret = i;
    this._anchor = i;
    this._dragging = true;
    this._repaint();
  }

  /** Select everything, and take PRIMARY with it. Both ways in — Ctrl+A and
   * the menu row — come through here: every other selection gesture owns
   * PRIMARY, and GTK and Qt both do it for select-all too, so a middle-click
   * paste after Ctrl+A pastes what is on screen rather than whatever was
   * selected before it. */
  _selectAll() {
    this._anchor = 0;
    this._caret = this._chars().length;
    this._breakUndoRun();
    this._ownSelection();
  }

  _ownSelection() {
    this._repaint();
    if (this._caret !== this._anchor) this._copySelection('PRIMARY');
  }

  /** The selection stays lit while its own menu is up: the popup holds the
   * keyboard, so `_focused` is false, but the text the menu is about to act
   * on has to stay visibly selected. */
  _showsSelection() {
    return this._focused || Boolean(this._editMenu);
  }

  _defaultMouseDrag(ev) {
    if (!this._dragging) return;
    this._caret = this._indexAtPoint(ev);
    this._repaint();
  }

  _defaultMouseUp() {
    if (!this._dragging) return;
    this._dragging = false;
    if (this._caret !== this._anchor) this._copySelection('PRIMARY');
  }

  // --- the built-in edit menu -----------------------------------------
  //
  // Right-click gets Undo/Cut/Copy/Paste with no wiring, the way a browser
  // gives `<input>` one. The rows cannot be `Menu` components — those are
  // React over the nodes, and a node cannot mount one — so the menu is a
  // `<popup>` built here with a `<canvas>` child that paints the rows
  // (src/editmenu.js) and handles its own pointer and key events. That
  // reuses the popup's pointer grab, dismissal and focus rather than
  // reinventing them. `contextMenu={false}` opts out, as does
  // `preventDefault()` in an `onContextMenu` handler.

  /** The rows, with each one enabled only when it would do something. */
  _editMenuItems() {
    const [a, b] = this._selection();
    const hasSelection = a !== b;
    const length = this._chars().length;
    return [
      { id: 'undo', label: 'Undo', shortcut: 'Ctrl+Z', enabled: this.canUndo },
      {
        id: 'redo',
        label: 'Redo',
        shortcut: 'Ctrl+Shift+Z',
        enabled: this.canRedo,
      },
      { separator: true },
      { id: 'cut', label: 'Cut', shortcut: 'Ctrl+X', enabled: hasSelection },
      { id: 'copy', label: 'Copy', shortcut: 'Ctrl+C', enabled: hasSelection },
      {
        id: 'paste',
        label: 'Paste',
        shortcut: 'Ctrl+V',
        // greyed only when the server has told us the selection is unowned
        // (pastestate.js). Never a round trip on the way to opening a menu.
        enabled: Boolean(this._clipboardApi()) && canPaste(this.app),
      },
      { separator: true },
      {
        id: 'selectAll',
        label: 'Select All',
        shortcut: 'Ctrl+A',
        enabled: length > 0 && !(a === 0 && b === length),
      },
    ];
  }

  /** Run a row. Everything here is the keyboard path's own entry point, so
   * the menu can never drift from what the shortcuts do. */
  _runEditAction(id) {
    const [a, b] = this._selection();
    if (id === 'undo') this.undo();
    else if (id === 'redo') this.redo();
    else if (id === 'copy') this._copySelection();
    else if (id === 'cut') {
      this._copySelection();
      if (a !== b) this._deleteRange(a, b);
    } else if (id === 'paste') this._pasteFrom();
    else if (id === 'selectAll') this._selectAll();
  }

  _defaultContextMenu(ev) {
    if (this.props.contextMenu === false) return;
    this._openEditMenu(ev);
  }

  /** Where the popup goes: at the pointer in root coordinates, pulled back
   * inside the screen when it would hang off the right or bottom edge. */
  _editMenuOrigin(ev, size) {
    const owner = this.root;
    const native = ev.nativeEvent;
    let x = native?.rootx;
    let y = native?.rooty;
    if (x == null || y == null) {
      // no native event (synthesized, or a test): fall back to the node's
      // own position within its window plus wherever that window is
      const origin = owner?.window?._screenOrigin ?? { x: 0, y: 0 };
      x = origin.x + (ev.x ?? this.abs.x);
      y = origin.y + (ev.y ?? this.abs.y);
    }
    const screen = this.app?.X?.display?.screen?.[0];
    if (screen?.pixel_width) {
      x = Math.max(0, Math.min(x, screen.pixel_width - size.width));
      y = Math.max(0, Math.min(y, screen.pixel_height - size.height));
    }
    return { x, y };
  }

  _openEditMenu(ev) {
    this._closeEditMenu();
    // From here on the menu knows whether there is anything to paste. This
    // first open still shows the row enabled — the answer arrives after it
    // is drawn — which is the pre-tracking behaviour, and correct far more
    // often than not.
    armPasteState(this.app, this._clipboardApi());
    const items = this._editMenuItems();
    const geometry = editMenuGeometry(
      items,
      (text) => this._layoutOf(text)?.width,
    );
    const { x, y } = this._editMenuOrigin(ev, geometry);
    const colors = editMenuColors(this.theme);
    const style = this._textStyle();
    const state = { active: -1 };

    const canvas = new CanvasNode(
      {
        focusable: true,
        style: { flexGrow: 1 },
        onDraw: (ctx) =>
          paintEditMenu(ctx, {
            geometry,
            active: state.active,
            colors,
            radius: this.theme?.radius ?? 4,
            layoutOf: (text, color) =>
              this.app?.fonts?.layout([{ text, ...style, color }], style),
          }),
        onMouseMove: (mv) => {
          const next = editMenuIndexAt(geometry, mv.y);
          if (next === state.active) return;
          state.active = next;
          popup.invalidate(false, null, 'style-state');
        },
        onMouseUp: (mv) => {
          const i = editMenuIndexAt(geometry, mv.y);
          if (i !== -1) this._chooseEditMenu(geometry.rows[i].id);
          else this._closeEditMenu();
        },
        onKeyDown: (k) => {
          if (k.keysym === XK_ESCAPE) return this._closeEditMenu();
          if (k.keysym === XK_UP || k.keysym === XK_DOWN) {
            state.active = editMenuStep(
              geometry,
              state.active,
              k.keysym === XK_DOWN ? 1 : -1,
            );
            popup.invalidate(false, null, 'style-state');
            return;
          }
          if (k.keysym === XK_RETURN || k.keysym === XK_KP_ENTER) {
            const row = geometry.rows[state.active];
            if (row && !row.separator) this._chooseEditMenu(row.id);
          }
        },
      },
      this.app,
    );

    const popup = new PopupNode(
      this.app,
      {
        x,
        y,
        width: geometry.width,
        height: geometry.height,
        windowType: 'popup_menu',
      },
      {
        grab: true,
        // a press outside the menu closes it and goes no further, which is
        // what the grab is for
        onDismiss: () => this._closeEditMenu(),
      },
    );
    popup.insertBefore(canvas, null);
    this.insertBefore(popup, null);
    popup.realize(null);
    this._editMenu = popup;
    // the menu takes the keyboard so arrows and Escape reach it rather than
    // editing the text behind it
    popup.events?.focus?.(canvas);
  }

  _chooseEditMenu(id) {
    this._closeEditMenu();
    if (id) this._runEditAction(id);
  }

  _closeEditMenu() {
    const popup = this._editMenu;
    if (!popup) return;
    this._editMenu = null;
    this.removeChild(popup);
    // focus goes back to the field, so typing carries on where it left off —
    // as a pointer focus, since a right-click is what opened the menu and a
    // ring appearing on the way back would be news to nobody
    if (!this.destroyed) this._focusManager()?.focus(this, 'pointer');
  }

  _defaultFocus() {
    this._focused = true;
    this._caretOn = true;
    this._blinkTimer = setInterval(() => {
      this._caretOn = !this._caretOn;
      // twice a second, forever, for as long as a field has focus: the one
      // repaint that most wants to cost only the field it happens in
      this.root?.invalidate(false, this, 'caret');
    }, 530);
    this._blinkTimer.unref?.();
    this.root?.invalidate(false, this, 'focus');
  }

  _defaultBlur() {
    this._focused = false;
    this._caretOn = false;
    // coming back to a field later is a new edit, not more of the old one
    this._breakUndoRun();
    clearInterval(this._blinkTimer);
    this._blinkTimer = null;
    this.root?.invalidate(false, this, 'focus');
  }

  destroySubtree() {
    clearInterval(this._blinkTimer);
    this._blinkTimer = null;
    // the popup is a child, so the walk below destroys it — just drop the
    // handle so a later close does not try to remove it twice
    this._editMenu = null;
    super.destroySubtree();
  }

  applyProps(newProps, oldProps) {
    const before = oldProps ?? this.props;
    const beforeStyle = this.style;
    super.applyProps(newProps, oldProps);
    const len = Array.from(
      newProps.value != null ? String(newProps.value) : (this._value ?? ''),
    ).length;
    this._caret = Math.min(this._caret, len);
    this._anchor = Math.min(this._anchor, len);
    this._noteExternalValue();
    let metricsChanged = false;
    for (const key of TEXT_LAYOUT_PROPS) {
      if (this.style[key] !== beforeStyle[key]) metricsChanged = true;
    }
    if (metricsChanged) {
      this.yoga.markDirty();
      this._invalidateLayout('props');
    } else if (newProps.value !== before.value) {
      // painting clips to the content box and the measure function reads
      // only font metrics, so a value change is confined to the field —
      // the same claim applyProps makes for any paint-only prop
      this.root?.invalidate(false, this, 'text');
    }
  }

  _paintContent(ctx) {
    const fonts = this.app?.fonts;
    if (!fonts) return;
    const content = this.contentBox();
    if (content.width <= 0 || content.height <= 0) return;

    const style = this._textStyle();
    const text = this.value;
    const isEmpty = text.length === 0;
    const shown = isEmpty ? (this.props.placeholder ?? '') : text;
    const color = isEmpty
      ? (this.props.placeholderColor ?? this.theme.dim)
      : style.color;
    const layout = fonts.layout([{ text: shown, ...style, color }], style);
    // Center the glyph ink (ascent + descent) rather than layout.height:
    // the layout box carries the line's leading entirely below the glyphs,
    // which would push the text visually upward (see halfLeading above).
    const line = layout.lines?.[0];
    const inkHeight = line ? line.ascent + line.descent : layout.height;
    const textY = content.y + Math.max(0, (content.height - inkHeight) / 2);
    // selection/caret read better with breathing room around the glyphs
    // (a DOM input highlights the whole line box, not just the ink)
    const markPad = Math.min(3, Math.max(0, textY - content.y));
    const markY = textY - markPad;
    const markHeight = inkHeight + markPad * 2;

    // Keep the caret inside the viewport — but only while the field is being
    // edited. The caret starts at the *end* of the value, so chasing it
    // unconditionally meant a field whose text is wider than its box rendered
    // scrolled to the end before anyone had touched it: the first characters
    // were simply missing, which reads as a rendering bug rather than as a
    // scroll position. An unfocused field shows the beginning of its value,
    // the way a DOM input does.
    const caretX = this._prefixWidth(this._caret);
    const textWidth = isEmpty ? 0 : layout.width;
    if (!this._focused) this._scrollX = 0;
    else {
      if (caretX - this._scrollX > content.width - 2) {
        this._scrollX = caretX - content.width + 2;
      }
      if (caretX - this._scrollX < 0) {
        this._scrollX = caretX;
      }
    }
    this._scrollX = Math.min(
      this._scrollX,
      Math.max(0, textWidth - content.width + 2),
    );

    ctx.save();
    ctx.beginPath();
    ctx.rect(content.x, content.y, content.width, content.height);
    ctx.clip();
    const originX = content.x - this._scrollX;

    const [a, b] = this._selection();
    if (this._showsSelection() && a !== b && !isEmpty) {
      const selStart = this._prefixWidth(a);
      const selEnd = this._prefixWidth(b);
      // A **translucent** accent rather than an opaque light blue. The ink
      // on top is `style.color`, which this fill does not control, so an
      // opaque highlight has to be picked to contrast with it — and no one
      // colour does that on both a light and a dark palette. `#b3d4fc`
      // under the dark palette's near-white ink is 1.3:1, which is nothing.
      // Tinting the surface instead leaves the ink's own contrast intact.
      ctx.fillStyle =
        this.props.selectionColor ?? tint(this.theme.accent, 0.35);
      ctx.fillRect(originX + selStart, markY, selEnd - selStart, markHeight);
    }

    layout.draw(ctx, originX, textY);

    if (this._focused && this._caretOn && a === b) {
      ctx.fillStyle = this.props.caretColor ?? style.color;
      ctx.fillRect(originX + caretX, markY, 1.5, markHeight);
    }
    ctx.restore();
  }
}

/**
 * <textarea>: multi-line editable text on the same editing core as
 * <textinput>. Word-wraps at the content width (ntk TextLayout), Enter
 * inserts a newline (Ctrl+Enter fires onSubmit), Up/Down move the caret
 * between visual lines keeping a goal column, Home/End are wrap-aware,
 * selection spans lines, and the view scrolls vertically to follow the
 * caret (wheel scrolls too). `rows` (default 3) sets the preferred height.
 */
export class TextAreaNode extends TextInputNode {
  /**
   * The bar takes the press before the caret does — otherwise grabbing the
   * thumb would drop the caret into whatever text sits behind it and start
   * a selection drag.
   */
  _defaultMouseDown(ev) {
    const bar = this._scrollbar();
    const hit = scrollbarHit(bar, ev.x, ev.y);
    if (!hit) return super._defaultMouseDown(ev);
    if (hit === 'thumb') {
      this._barGrab = ev.y - bar.thumbStart;
      ev.capturePointer();
      return;
    }
    const page = this.contentBox().height;
    this._scrollTo(this._scrollY + (ev.y < bar.thumbStart ? -page : page), bar);
  }

  _defaultMouseDrag(ev) {
    if (this._barGrab == null) return super._defaultMouseDrag(ev);
    const bar = this._scrollbar();
    if (!bar || bar.travel <= 0) return;
    this._scrollTo(
      ((ev.y - this._barGrab - bar.trackStart) / bar.travel) * bar.range,
      bar,
    );
  }

  _defaultMouseUp(ev) {
    if (this._barGrab != null) {
      this._barGrab = null;
      return;
    }
    super._defaultMouseUp(ev);
  }

  _scrollTo(y, bar) {
    const next = Math.min(Math.max(0, y), bar.range);
    if (next === this._scrollY) return;
    this._scrollY = next;
    // an inner scroll moves pixels only inside the field's own clip
    this.root?.invalidate(false, this, 'scroll');
  }

  constructor(props, app) {
    super(props, app, 'textarea');
    this._scrollY = 0;
    this._goalX = null;
    this.yoga.setMeasureFunc((width, widthMode) => {
      const preferred = 220;
      const w =
        widthMode === Yoga.MEASURE_MODE_UNDEFINED
          ? preferred
          : Math.min(preferred, width);
      const rows = Math.max(1, this.props.rows ?? 3);
      return { width: w, height: Math.ceil(this._lineHeight() * rows) };
    });
  }

  /** Multi-line: preserve newlines (normalize CRLF). */
  _normalizeInsert(text) {
    return String(text).replace(/\r\n?/g, '\n');
  }

  /** Undo moves the caret, so the Up/Down goal column no longer applies. */
  _applyHistory(value, caret, anchor) {
    this._goalX = null;
    super._applyHistory(value, caret, anchor);
  }

  /** Wrapped, styled layout of the value (or placeholder), cached per
   * (text, style, width). Used for painting and all caret geometry, so
   * caret math always agrees with what is on screen. */
  _valueLayout() {
    const fonts = this.app?.fonts;
    if (!fonts) return null;
    const text = this.value;
    const isEmpty = text.length === 0;
    const shown = isEmpty ? (this.props.placeholder ?? '') : text;
    const s = this._textStyle();
    const color = isEmpty
      ? (this.props.placeholderColor ?? this.theme.dim)
      : s.color;
    const width = this.contentBox().width || undefined;
    const key = `${width}|${color}|${shown}|${s.family}|${s.size}|${s.weight}|${s.style}`;
    if (this._valueLayoutKey !== key) {
      this._valueLayoutKey = key;
      this._valueLayoutCache = fonts.layout([{ text: shown, ...s, color }], s, {
        maxWidth: width,
      });
    }
    return this._valueLayoutCache;
  }

  applyProps(newProps, oldProps) {
    const before = oldProps ?? this.props;
    super.applyProps(newProps, oldProps);
    if (newProps.rows !== before.rows) {
      this.yoga.markDirty();
      this._invalidateLayout('props');
    }
  }

  _indexAtPoint(ev) {
    const layout = this._valueLayout();
    if (!layout) return this._chars().length;
    const content = this.contentBox();
    return layout.indexAt(ev.x - content.x, ev.y - content.y + this._scrollY);
  }

  scrollBy(dy) {
    const layout = this._valueLayout();
    const content = this.contentBox();
    const max = layout ? Math.max(0, layout.height - content.height) : 0;
    const next = Math.min(Math.max(0, this._scrollY + dy), max);
    if (next === this._scrollY) return;
    this._scrollY = next;
    // an inner scroll moves pixels only inside the field's own clip
    this.root?.invalidate(false, this, 'scroll');
  }

  /** Visual lines that fit in the viewport — one Page keypress worth. */
  _pageLines() {
    const height = this.contentBox().height;
    const line = this._lineHeight() || 1;
    return Math.max(1, Math.floor(height / line));
  }

  /** Caret index on an adjacent visual line, keeping the goal column. */
  _verticalMove(layout, delta) {
    const pos = layout.caretPosition(this._caret);
    const li = pos.line + delta;
    if (li < 0) {
      this._goalX = null;
      return 0;
    }
    if (li >= layout.lines.length) {
      this._goalX = null;
      return this._chars().length;
    }
    const x = this._goalX ?? pos.x;
    this._goalX = x;
    const line = layout.lines[li];
    return layout.indexAt(x, line.y + (line.ascent + line.descent) / 2);
  }

  _editKeyDown(ev) {
    const k = ev.keysym;
    const layout = this._valueLayout();

    if (k === XK_RETURN || k === XK_KP_ENTER) {
      if (ev.ctrlKey) {
        this._fireValueEvent('onSubmit', this.value, ev.nativeEvent);
        return;
      }
      this._goalX = null;
      this._insert('\n');
      return;
    }
    if ((k === XK_UP || k === XK_DOWN) && layout && this.value.length > 0) {
      const i = this._verticalMove(layout, k === XK_UP ? -1 : 1);
      this._moveCaret(i, ev.shiftKey);
      if (ev.shiftKey) this._copySelection('PRIMARY');
      return;
    }
    if (
      (k === XK_PAGE_UP || k === XK_PAGE_DOWN) &&
      layout &&
      this.value.length > 0
    ) {
      const i = this._verticalMove(
        layout,
        this._pageLines() * (k === XK_PAGE_UP ? -1 : 1),
      );
      this._moveCaret(i, ev.shiftKey);
      if (ev.shiftKey) this._copySelection('PRIMARY');
      return;
    }
    if ((k === XK_HOME || k === XK_END) && layout && this.value.length > 0) {
      const pos = layout.caretPosition(this._caret);
      const line = layout.lines[pos.line];
      const y = line.y + (line.ascent + line.descent) / 2;
      // indexAt clamps into the line: far left = line start; just past the
      // right edge = end of visible content (before the newline)
      const i =
        k === XK_HOME
          ? layout.indexAt(-1e6, y)
          : layout.indexAt(line.x + line.width + 0.01, y);
      this._goalX = null;
      this._moveCaret(i, ev.shiftKey);
      return;
    }
    this._goalX = null;
    super._editKeyDown(ev);
  }

  /** Thumb for the vertical overflow, same look as <scrollview>'s. */
  _paintScrollbar(ctx, layout) {
    const bar = this._scrollbar(layout);
    if (bar) paintScrollbarThumb(ctx, bar, this.props.scrollbarColor);
  }

  _scrollbar(layout = this._valueLayout()) {
    if (this.props.scrollbar === false || !layout) return null;
    const box = this.contentBox();
    return scrollbarGeometry({
      axis: 'y',
      start: box.y,
      viewport: box.height,
      content: layout.height,
      across: box.x,
      crossSize: box.width,
      scroll: this._scrollY,
    });
  }

  _paintContent(ctx) {
    const layout = this._valueLayout();
    if (!layout) return;
    const content = this.contentBox();
    if (content.width <= 0 || content.height <= 0) return;
    const isEmpty = this.value.length === 0;

    // Keep the caret line inside the viewport, and only while focused — the
    // caret starts at the end of the value, so chasing it unconditionally
    // opened a textarea already scrolled past its first lines. Unlike
    // <textinput> this does not reset the offset when focus leaves: a
    // textarea scrolls on the wheel and has a scrollbar, so where an
    // unfocused one is scrolled to is the reader's business.
    const pos = layout.caretPosition(this._caret);
    if (this._focused) {
      if (pos.y + pos.height - this._scrollY > content.height) {
        this._scrollY = pos.y + pos.height - content.height;
      }
      if (pos.y - this._scrollY < 0) {
        this._scrollY = pos.y;
      }
    }
    this._scrollY = Math.min(
      this._scrollY,
      Math.max(0, layout.height - content.height),
    );
    this._scrollY = Math.max(0, this._scrollY);

    ctx.save();
    ctx.beginPath();
    ctx.rect(content.x, content.y, content.width, content.height);
    ctx.clip();
    const originX = content.x;
    const originY = content.y - this._scrollY;

    const [a, b] = this._selection();
    if (this._showsSelection() && a !== b && !isEmpty) {
      const posA = layout.caretPosition(a);
      const posB = layout.caretPosition(b);
      // A **translucent** accent rather than an opaque light blue. The ink
      // on top is `style.color`, which this fill does not control, so an
      // opaque highlight has to be picked to contrast with it — and no one
      // colour does that on both a light and a dark palette. `#b3d4fc`
      // under the dark palette's near-white ink is 1.3:1, which is nothing.
      // Tinting the surface instead leaves the ink's own contrast intact.
      ctx.fillStyle =
        this.props.selectionColor ?? tint(this.theme.accent, 0.35);
      for (let li = posA.line; li <= posB.line; li++) {
        const line = layout.lines[li];
        const x0 = li === posA.line ? posA.x : line.x;
        const x1 = li === posB.line ? posB.x : line.x + line.width;
        // a selected bare newline still shows as a sliver
        const w = Math.max(x1 - x0, 4);
        ctx.fillRect(
          originX + x0,
          originY + line.y,
          w,
          line.ascent + line.descent,
        );
      }
    }

    layout.draw(ctx, originX, originY);

    if (this._focused && this._caretOn && a === b) {
      ctx.fillStyle = this.props.caretColor ?? this._textStyle().color;
      ctx.fillRect(originX + pos.x, originY + pos.y, 1.5, pos.height);
    }
    // inside the clip, so the thumb is bounded by the content box
    this._paintScrollbar(ctx, layout);
    ctx.restore();
  }
}

/**
 * <window>: backed by a real X11 window. Acts as the flex root and
 * paint/event root for its drawn subtree. The node is a lightweight handle
 * during the render phase — the real window is created top-down in the
 * commit phase by realize(), so every CreateWindow names its actual parent
 * from the start (no ReparentWindow, no override-redirect staging;
 * issue #4).
 */
export class WindowNode extends Node {
  constructor(app, attributes, props) {
    super('window', props, app, { yoga: true });
    this.root = this;
    this.attributes = attributes;
    this.window = null;
    // set by realize() only once the ARGB visual is actually there, so the
    // paint path never assumes an alpha channel the window does not have
    this._transparent = false;
    // What `@supports` blocks are answered from, and what the paint path
    // reads. `transparency` needs *both* halves — an alpha channel to write
    // and a compositor to blend it — and starts false so a window that has
    // not resolved either yet paints the design that works everywhere.
    this._capabilities = { transparency: false };
    this._unwatchCompositing = null;
    this.needsLayout = true;
    this.needsPaint = true;
    this._scheduled = false;
    this.events = new EventManager(this);
    // ids of the child windows in the order the *server* stacks them,
    // bottom to top — see _restackWindowChildren
    this._xStack = [];
    // nodes with a transition in flight
    this._animating = new Set();
    // nodes with `@width`/`@height` blocks, and the size they last matched
    // against
    this._sizeQueryNodes = new Set();
    // nodes with `@supports` blocks, re-resolved when the server's answer
    // changes rather than on every layout
    this._supportsQueryNodes = new Set();
    // nodes whose child list changed and whose own size is pinned: their new
    // arrangement is only measurable once layout has run (see
    // Node._childListChanged)
    this._reflowed = new Set();
    this.querySize = null;
  }

  /** Create the real X11 window (commit phase only). Children windows are
   * realized against this window, then mapped before it so the whole
   * subtree appears at once when the outermost window maps. */
  realize(parentWindow) {
    if (this.window || this.destroyed) return;
    const attributes = { ...this.attributes };
    if (parentWindow) {
      attributes.parent = parentWindow;
    }
    // **What the server paints into newly exposed area.** A resize enlarges
    // the window before the app can possibly have drawn the new part, and X
    // fills it with this attribute in the meantime — so without one, growing
    // a window flashes whatever the server's default is, which on a dark
    // palette is a bright rectangle. Setting it to the colour that is about
    // to be painted there makes the flash the same colour as the result.
    const pixel = pixelFor(this._windowBackground());
    if (pixel !== null) {
      attributes.backgroundPixel = pixel;
      this._backgroundPixel = pixel;
    }
    // Before the window exists, because a visual is a CreateWindow field: a
    // window cannot become transparent later, which is also why `transparent`
    // is read here and never in the update path. It overrides the pixel above
    // with 0 — transparent black — when the ARGB visual is really there.
    if (this.props.transparent)
      Object.assign(attributes, this._argbAttributes());
    const wnd = this.app.createWindow(attributes);
    this.window = wnd;
    // Now that the visual is known: settle the capabilities, re-resolve any
    // `@supports` block against them, and start following the compositor.
    // Before the first paint, and before children realize against it.
    this._watchCapabilities();
    wnd._reactX11Node = this;
    wnd._reactFiber = this._reactFiber;
    // windows are DevTools public instances too — see Node.getClientRects
    wnd.getClientRects ??= () => [
      { x: 0, y: 0, left: 0, top: 0, width: wnd.width, height: wnd.height },
    ];
    wnd.ownerDocument ??= DEVTOOLS_FAKE_DOCUMENT;
    this._attachWindowListeners();
    for (const child of this.children) {
      if (child.isWindow && !child.isPopup) {
        child.realize(wnd);
        if (child.window) this._xStack.push(child.window.id);
      }
    }
    this._restackWindowChildren();
    // <glarea>s mounted before the window existed own a child X window too
    this._realizeGlAreas(this);
    // Before the map, deliberately. EWMH 7.7 gives an unmapped window a
    // different mechanism — it *declares* its initial state by writing the
    // property, where a mapped one has to *ask* the window manager — and
    // declaring is the only way to open already fullscreen rather than
    // flashing at the normal size first. Same for the Motif hint: a WM
    // reads decorations when it frames the window, which is at map time.
    if (this.props.decorations === false) applyDecorations(wnd, false);
    applyWindowStates(wnd, [...windowStates(this.props)], 'add');
    // ICCCM 4.1.2.6 has the window manager read WM_TRANSIENT_FOR when the
    // transient is mapped, so this belongs before the map too. ntk writes it
    // with predefined atoms and no round trip, so "before" is free.
    this._applyTransientFor(this.props.transientFor);
    // Top-level windows advertise XDND before the map, like the EWMH
    // properties above: a declaration, made before anyone can look. Child
    // <window>s never advertise (XDND v3 puts XdndAware on top-levels
    // only); drags over them arrive here and are routed down in JS.
    if (!parentWindow) this._initDnd();
    // The launch's own properties, and the same "before the map" rule as
    // everything above it: EWMH's guarantee about `_NET_WM_USER_TIME` is
    // about the window's state at the moment it is mapped. First toplevel
    // only — a later `<window>` is not the launch (src/startup.js).
    if (!parentWindow && !this.isPopup) {
      this.app._reactX11Startup?.decorate(wnd);
    }
    wnd.map?.();
    if (!parentWindow && !this.isPopup) {
      this.app._reactX11Startup?.mapped(wnd);
    }
    // ask before anything can be anchored to it, so the first popup is
    // placed as well as the second
    this._refreshScreenOrigin();
    this.invalidate(true, null, 'mount');
  }

  /**
   * What this window can actually do, for `@supports` blocks to read and for
   * the paint path to obey. Read-only to callers; recomputed by
   * `_refreshCapabilities`.
   */
  get capabilities() {
    return this._capabilities;
  }

  /**
   * Will transparency actually be *seen*? Both halves have to hold: the
   * window needs an alpha channel to write, and something has to be
   * compositing it. Miss either and a cleared corner is a black corner, so
   * the paint path fills opaque instead.
   *
   * This is deliberately not the same question as "was `transparent` asked
   * for". A visual is fixed at CreateWindow and cannot follow a compositor
   * that starts or stops mid-session; what it paints can, and does.
   */
  get transparencyEffective() {
    return this._capabilities.transparency;
  }

  /**
   * Recompute, and if the answer moved, re-resolve every `@supports` block
   * under this window and repaint. Returns whether anything changed.
   */
  _refreshCapabilities() {
    const transparency = this._transparent && compositingActive(this.app);
    if (transparency === this._capabilities.transparency) return false;
    // a new object rather than a mutation: `resolveQueries` may have handed
    // this map to a memoized style, and identity is how that stays honest
    this._capabilities = { ...this._capabilities, transparency };
    // The window's own style first, and separately: it resolves its style
    // in the Node constructor, before `root` exists to register against, so
    // it is not in its own registry on the pass that matters — the one
    // realize() triggers once the visual is known.
    if (this._supportsQueried) this._sizeQueriesChanged();
    for (const node of [...this._supportsQueryNodes]) {
      if (node.destroyed) this._supportsQueryNodes.delete(node);
      else if (node !== this) node._sizeQueriesChanged();
    }
    // The window's own background is not a styled node and has no query
    // block to re-resolve — it reads `transparencyEffective` directly, so
    // it just needs the repaint.
    this.invalidate(true, null, 'capabilities');
    return true;
  }

  /**
   * Follow the compositor for the life of the window. A menu that was opaque
   * because nothing was compositing becomes a rounded translucent one the
   * moment something is, with no remount — which is the whole reason the
   * ARGB visual is taken even when no compositor is running yet.
   */
  _watchCapabilities() {
    this._refreshCapabilities();
    this._unwatchCompositing ??= watchCompositing(this.app, () => {
      if (!this.destroyed) this._refreshCapabilities();
    });
  }

  /**
   * Creation attributes for a per-pixel transparent window: a 32-bit
   * TrueColor visual, and a background of transparent black rather than the
   * server's white, so nothing flashes before the first paint. ntk gives the
   * window its own colormap and border pixel to go with the visual —
   * inheriting either from a parent of a different depth is a BadMatch.
   *
   * Empty when the display has no such visual (XQuartz has none) or ntk is
   * too old to find one, and then `_transparent` stays false and the window
   * paints its background opaque, exactly as it did before. A transparent
   * window that cannot be transparent is a square opaque one, not a broken
   * one — and the alternative, black corners, is worse than square.
   */
  /** What this window paints as its background — its own, or the palette's. */
  _windowBackground() {
    return this.style.backgroundColor || this.theme.background;
  }

  /**
   * Keep the server's idea of the background in step with ours. Called when
   * the palette moves under an unstyled window and when the style names a new
   * colour; a `transparent` window keeps its 0, which means transparent.
   */
  _syncWindowBackground() {
    if (this._transparent || !this.window || this.destroyed) return;
    const pixel = pixelFor(this._windowBackground());
    if (pixel === null || pixel === this._backgroundPixel) return;
    if (this.app?.X?._closing) return;
    this._backgroundPixel = pixel;
    // One call for both halves, because a double-buffered window has two
    // backgrounds: the X window attribute the server paints into exposed
    // area, and the colour ntk's backing store clears the part a resize
    // grows into. They used to be free to disagree — the backing store
    // cleared to the screen's white whatever the window said — which is why
    // enlarging a dark window flashed a white strip that survived until
    // something damaged it (ntk#209, 6.6.1).
    this.window.setBackgroundPixel?.(pixel);
  }

  _argbAttributes() {
    const argb = argbVisual(this.app);
    if (!argb) {
      // Once per connection. The answer is a property of the display (or of
      // an environment switch) and cannot change while it is open, and since
      // the widgets ask for a transparent popup every time a menu or a
      // tooltip opens, warning per window would turn one piece of news into
      // a running commentary.
      if (DEV && this.app && !warnedNoArgb.has(this.app)) {
        warnedNoArgb.add(this.app);
        const what = this.isPopup ? 'popup' : 'window';
        if (transparencyDisabled()) {
          console.warn(
            'react-x11: REACT_X11_NO_TRANSPARENCY=1 — <%s transparent> ' +
              'ignored, this run is opaque',
            what,
          );
        } else {
          console.warn(
            'react-x11: <%s transparent> — no 32-bit TrueColor visual on ' +
              'this display, falling back to an opaque window',
            what,
          );
        }
      }
      return null;
    }
    // What the paint path keys off: the window really does have an alpha
    // channel, so clearing it means transparent rather than white.
    this._transparent = true;
    return { ...argb, backgroundPixel: 0 };
  }

  /**
   * XDND drop-target wiring (src/dnd.js): write `XdndAware = 5`, start the
   * atom interning, and route incoming ClientMessages to the session.
   * Unconditional — the property is 4 bytes on a window that exists anyway,
   * and advertising lazily would race sources that cache the window list
   * at drag start. A window with no registered drop targets answers "not
   * accepting" once per entry instead (DropSession).
   */
  _initDnd() {
    const wnd = this.window;
    const X = this.app?.X;
    if (
      !X ||
      typeof X.InternAtom !== 'function' ||
      typeof wnd.on !== 'function' ||
      typeof wnd.setProperty !== 'function'
    ) {
      return; // mock app, or an ntk too old to write raw properties
    }
    this._dnd = new DropSession(this);
    registerTopLevel(this);
    void dndAtoms(X).catch(() => {});
    wnd
      .setProperty('XdndAware', [XDND_VERSION], { type: 'ATOM' })
      .catch(() => {});
    wnd.on('message', (ev) => {
      this._dnd.handleMessage(ev);
      // a drag *out* of this window gets its XdndStatus/XdndFinished back
      // on the same channel
      this._dragSession?.handleMessage(ev);
    });
  }

  /** Nodes with drop props register with their root; the count gates the
   * whole-window "not accepting" fast path. Child <window>s roll up into
   * their top-level's count, since that is where the messages arrive. */
  _registerDropTarget(node) {
    (this._dropTargets ??= new Set()).add(node);
  }

  _forgetDropTarget(node) {
    this._dropTargets?.delete(node);
    this._dndOwner()?.forget(node);
  }

  _dndTargetCount() {
    let count = this._dropTargets?.size ?? 0;
    for (const child of this.children) {
      if (child.isWindow && !child.isPopup) count += child._dndTargetCount();
    }
    return count;
  }

  /** The session that owns drags over this window: its own for a
   * top-level, the enclosing top-level's for a nested <window>. */
  _dndOwner() {
    let node = this;
    while (node && !node._dnd) node = node.parent?.root;
    return node?._dnd ?? null;
  }

  /**
   * Where this window's top-left corner actually is on the screen, cached
   * on the ntk window for `anchorRect` to read.
   *
   * It cannot be taken from `window.x`/`y`. Those come from ConfigureNotify,
   * and once a reparenting window manager has put the window inside its
   * frame — which is every WM worth the name — those coordinates are
   * relative to the *frame*, not the root. A popup anchored with them lands
   * near the corner of the screen instead of under its trigger. The server
   * will translate for us, and its answer is right whatever the WM did.
   */
  _refreshScreenOrigin() {
    const wnd = this.window;
    const X = this.app?.X;
    const root = X?.display?.screen?.[0]?.root;
    if (!wnd || root == null || typeof X.TranslateCoordinates !== 'function') {
      return;
    }
    X.TranslateCoordinates(wnd.id, root, 0, 0, (err, res) => {
      if (err || this.destroyed || !this.window) return;
      this.window._screenOrigin = { x: res.destX, y: res.destY };
      this._notifyAnchorChange();
    });
  }

  /**
   * Subscribe to "something this window's popups might be anchored to just
   * moved" — a real layout pass (a trigger's own position changing: text
   * wrapping, a sibling growing, an ancestor scrollview scrolling — scroll
   * offset is applied during absolutize, so it is a layout change too) or a
   * fresh `_screenOrigin` (the window manager or a script moving this window).
   * Returns an unsubscribe function.
   *
   * Event-driven off the same signals `flush()` and `_refreshScreenOrigin()`
   * already track internally, rather than a polling loop: costs nothing
   * between real changes, and `useAnchor`'s tracking hook (`anchor.js`) is
   * what turns this into a popup that follows its trigger instead of hanging
   * over stale ground once opened.
   */
  onAnchorChange(cb) {
    (this._anchorListeners ??= new Set()).add(cb);
    return () => this._anchorListeners?.delete(cb);
  }

  _notifyAnchorChange() {
    if (!this._anchorListeners?.size) return;
    for (const cb of this._anchorListeners) cb();
  }

  /**
   * Subscribe to this window gaining or losing the **window manager's**
   * focus. Returns an unsubscribe function.
   *
   * Deliberately not the same thing as a node's `onBlur`: a window losing
   * focus does not blur the node inside it — the node keeps focus and stops
   * looking active, which is what the DOM does with `document.activeElement`
   * and what a caret coming back where you left it depends on. So nothing in
   * the tree hears about it, and the things that must — a menu holding a
   * pointer grab, most of all — have nowhere else to ask.
   */
  onWindowFocusChange(cb) {
    (this._windowFocusListeners ??= new Set()).add(cb);
    return () => this._windowFocusListeners?.delete(cb);
  }

  _notifyWindowFocus(focused) {
    if (!this._windowFocusListeners?.size) return;
    for (const cb of [...this._windowFocusListeners]) cb(focused);
  }

  /** Walk the drawn subtree and give every <glarea> its child X window. */
  _realizeGlAreas(node) {
    for (const child of node.children) {
      if (child.isWindow) continue;
      if (child.isGlArea) child.realize();
      else this._realizeGlAreas(child);
    }
  }

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
      wnd.setSizeHints?.({
        ...hints,
        ...(next.resizable === false && { resizable: false }),
      });
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

  /** The WM size hints among these props. */
  _sizeHints(props) {
    const hints = {};
    for (const key of WINDOW_HINT_PROPS) {
      if (props[key] !== undefined) hints[key] = props[key];
    }
    return hints;
  }

  get semanticNames() {
    return WINDOW_SEMANTIC_NAMES;
  }

  _attachWindowListeners() {
    const wnd = this.window;
    if (typeof wnd.on !== 'function') return;
    wnd.on('resize', (ev) => {
      // ConfigureNotify also fires for pure moves and reparents; only a real
      // size change dirties layout or pixels.
      //
      // Compared against the laid-out rect rather than ntk's `ev.resized`
      // (which is "differs from the last delivered event"), because the two
      // answer different questions and this is the one that matters here: a
      // React-driven resize configures the window and lays out in the same
      // commit, and the server's echo comes back a moment later saying the
      // size changed — true, but already accounted for. `ev.resized` would
      // relayout and fully repaint a second time for every controlled
      // resize.
      if (ev.width !== this.abs.width || ev.height !== this.abs.height) {
        this.needsLayout = true;
        this.invalidate(true, null, 'resize');
      }
      // Where the window sits on screen decides where popups anchored to it
      // belong — and finding that out is a server round trip
      // (TranslateCoordinates), so it is worth not making one per frame of a
      // resize drag that never moved the window. `ev.moved` is ntk >= 6.2
      // (sidorares/ntk#184), which is the floor; the `?? true` is for a mock
      // window or a deduped older copy, which then keep the unconditional
      // refresh rather than losing the anchor.
      if (ev.moved ?? true) this._refreshScreenOrigin();
      this.props.onResize?.(ev);
    });
    // A reparent is the other way the origin moves: the window manager puts
    // the window inside its frame, and ConfigureNotify coordinates become
    // frame-relative from then on. It usually arrives with a ConfigureNotify
    // whose coordinates changed, but "usually" is not a guarantee — a frame
    // whose client offset happens to match the old root position reports no
    // move at all. StructureNotify is already selected for 'resize', so
    // listening costs nothing.
    wnd.on('reparent', () => this._refreshScreenOrigin());
    // the frame clock emits 'draw' when the backing store content is invalid
    wnd.on('draw', () => {
      (this._frameReasons ??= new Set()).add('expose');
      this.needsPaint = true;
      this.flush();
    });
    wnd.on('expose', (ev) => {
      this.props.onExpose?.(ev);
    });
    // What the window manager actually did, which is the other half of the
    // controlled pair — the props say what to ask for, this says what is
    // true. Subscribing is what makes ntk select PropertyChange and watch
    // `_NET_WM_STATE`, so it is opt-in: a window with no handler pays
    // nothing. Read at realize time like onCloseRequest, since the
    // subscription is a property of the X window, not of a render.
    if (this.props.onStatesChange && typeof wnd.getWmStates === 'function') {
      wnd.on('statechange', (states) => {
        // a WM state change is something the user did to the window, so it
        // carries the same priority a click would
        runWithPriority(DiscreteEventPriority, () => {
          this.props.onStatesChange?.(states);
        });
      });
    }
    // WM close button: with an onCloseRequest prop the window opts into the
    // WM_DELETE_WINDOW protocol and the handler decides what happens
    // (unmount, hide, quit). Without it the WM default stands (the server
    // kills the connection). Opt-in is decided at realize time.
    //
    // ntk >= 5.3 owns the protocol: listening for 'close' self-arms
    // WM_PROTOCOLS and decodes the ClientMessage (#160). Its default action
    // — destroy the window — is always prevented, because what happens next
    // is this handler's decision, and usually a React unmount: ntk tearing
    // the window down underneath the reconciler is exactly what the prop
    // exists to avoid. This also leaves the raw 'message' stream free for
    // protocols react-x11 speaks itself (XDND, src/dnd.js).
    if (this.props.onCloseRequest) {
      wnd.on(
        'close',
        // a WM close is a user action: discrete priority and a discrete
        // paint, like a click. An onCloseRequest that answers with a
        // "save your work?" dialog rather than an unmount is the case that
        // notices — the dialog is the response to the press on the WM's
        // close button, and it is one paint away.
        discrete((ev) => {
          ev.preventDefault();
          runWithPriority(DiscreteEventPriority, () => {
            const handler = this.props.onCloseRequest;
            if (handler) callHandler(this, 'onCloseRequest', handler, ev);
          });
        }),
      );
    }
    this.events.attach();
  }

  /** Child <window>s in the order they should stack, bottom to top: the same
   * rule drawn children paint by (later sibling on top, `zIndex` first). */
  _windowStackOrder() {
    return this.children
      .filter((c) => c.isWindow && !c.isPopup && c.window)
      .map((node, i) => ({ node, i }))
      .sort(
        (a, b) =>
          (a.node.style.zIndex ?? 0) - (b.node.style.zIndex ?? 0) || a.i - b.i,
      )
      .map((e) => e.node);
  }

  /**
   * Make the server's stacking order match the JSX order. X stacks a new
   * window on top of its siblings, so plain mount order already comes out
   * right and this sends nothing; it costs requests only when React moves a
   * child window or a `zIndex` changes. Walking top-down and putting each
   * window directly below the one above it fixes any permutation in one
   * pass — after step i, everything from i upwards is a contiguous run in
   * the right order. Top-level windows are excluded on purpose: they are
   * the window manager's to stack, and it redirects the request anyway;
   * so are popups, which are children of the screen root wherever they sit
   * in the tree. Only `<window>` children are ordered against each other —
   * a `<glarea>`'s X window is a sibling at the server, but it belongs to
   * the drawn tree, which has no stacking relationship with them.
   */
  _restackWindowChildren() {
    const X = this.app?.X;
    if (!this.window || typeof X?.ConfigureWindow !== 'function') return;
    const stack = this._windowStackOrder();
    const ids = stack.map((c) => c.window.id);
    if (
      ids.length === this._xStack.length &&
      ids.every((id, i) => id === this._xStack[i])
    ) {
      return;
    }
    for (let i = stack.length - 2; i >= 0; i--) {
      X.ConfigureWindow(ids[i], {
        sibling: ids[i + 1],
        stackMode: STACK_BELOW,
      });
    }
    this._xStack = ids;
  }

  insertBefore(child, beforeChild) {
    if (child.isPopup) {
      Node.prototype.insertBefore.call(this, child, beforeChild);
      return;
    }
    if (child.isWindow) {
      this._spliceChild(child, beforeChild);
      child.parent = this;
      // Initial children are realized when this window realizes; a child
      // appended to an already-realized window is created immediately,
      // top-down against its real parent — and lands on top of its
      // siblings, which _restackWindowChildren then corrects if the JSX
      // order says otherwise.
      if (this.window && !child.window) {
        child.realize(this.window);
        if (child.window) this._xStack.push(child.window.id);
      }
      if (this.theme || child.props.theme) child._themeChanged();
      // React reorders a keyed list with one insertBefore per moved child;
      // restacking once at the end of the commit skips the intermediate
      // orders, which nobody ever sees.
      pendingRestack.add(this);
      return;
    }
    Node.prototype.insertBefore.call(this, child, beforeChild);
  }

  removeChild(child) {
    if (child.isWindow) {
      const index = this.children.indexOf(child);
      if (index !== -1) this.children.splice(index, 1);
      const id = child.window?.id;
      child.parent = null;
      child.destroySubtree();
      if (id != null) this._xStack = this._xStack.filter((w) => w !== id);
      return;
    }
    Node.prototype.removeChild.call(this, child);
  }

  destroySubtree() {
    if (this.destroyed) return;
    this.destroyed = true;
    clearPendingFrame(this);
    this._unwatchCompositing?.();
    this._unwatchCompositing = null;
    // out of the drag registries before the window goes: a drag routed to
    // a dead window would translate against a null _screenOrigin
    forgetTopLevel(this);
    this._dragSession?.cancel();
    for (const child of this.children) child.destroySubtree();
    if (this.window && typeof this.window.destroy === 'function') {
      this.window.destroy();
    }
    this.window = null;
    if (this.yoga) {
      this.yoga.freeRecursive();
      this.yoga = null;
    }
  }

  applyProps(newProps, oldProps) {
    const before = oldProps ?? this.props;
    const beforeStyle = this.style;
    const themeChanged = newProps.theme !== before.theme;
    this.props = newProps;
    if (themeChanged) this._themeChanged();
    const style = this._syncStyle(newProps);
    if (Boolean(newProps.trapFocus) !== Boolean(before.trapFocus)) {
      this._syncFocusScope();
    }
    // a <window onDrop> is a whole-window dropzone; same edge as Node
    if (hasDropProps(newProps) !== hasDropProps(before)) {
      if (hasDropProps(newProps)) this._registerDropTarget(this);
      else this._forgetDropTarget(this);
    }
    const wnd = this.window;
    if (!wnd) {
      // Not realized yet: refresh creation attributes instead — through the
      // same filter createInstance used, since these are the arguments ntk's
      // constructor will see. Spreading raw props here was the bug behind
      // `ev.preventDefault is not a function` in a <popup>'s onKeyDown: ntk
      // registers any `onFoo` in its creation args as a raw listener, so the
      // handler was called a second time with the native X event.
      this.attributes = { ...this.attributes, ...windowAttributes(newProps) };
      return;
    }

    if (newProps.title !== before.title) {
      wnd.setTitle?.(newProps.title || '');
    }
    // The colour the server fills a resize with, kept in step with the one
    // the app paints.
    this._syncWindowBackground();
    // a popup is a child of the screen root, not of the node it is written
    // under, so its zIndex means nothing — and its parent here may well be
    // a drawn node with no children to stack
    if (
      (style.zIndex ?? 0) !== (beforeStyle.zIndex ?? 0) &&
      !this.isPopup &&
      this.parent?._restackWindowChildren
    ) {
      pendingRestack.add(this.parent);
    }
    this._applyWindowHints(newProps, before);
    // Position and size part ways below: both are sent to the server, but
    // only a size change re-lays-out — the window's own coordinate space is
    // untouched by where the window sits on screen, so a pointer-tracking
    // popup does not repaint itself per motion.
    const sizeChanged =
      newProps.width !== before.width || newProps.height !== before.height;
    const geometryChanged =
      sizeChanged || newProps.x !== before.x || newProps.y !== before.y;
    if (geometryChanged) {
      if (typeof wnd.setState === 'function') {
        wnd.setState({
          x: newProps.x,
          y: newProps.y,
          width: newProps.width,
          height: newProps.height,
        });
      } else {
        if (
          newProps.width !== before.width ||
          newProps.height !== before.height
        ) {
          wnd.resize?.(newProps.width, newProps.height);
        }
        if (newProps.x !== before.x || newProps.y !== before.y) {
          wnd.move?.(newProps.x, newProps.y);
        }
      }
    }

    const layoutChanged =
      style !== beforeStyle && applyLayoutStyle(this.yoga, style, beforeStyle);
    // The window's own paint is its background, which covers the whole
    // window — so a change to it is unbounded, and `this` is the right
    // damage. A commit that only changed children reaches here too, though
    // (React updates the parent whenever its child list is rebuilt), and
    // that must not widen the damage those children just recorded.
    const ownPaintChanged = paintPropsChanged(style, beforeStyle);
    // A size change is unbounded — the window's old bounds do not cover the
    // grown area. A style-driven relayout at the same size is bounded by the
    // window itself (its paint covers all of it; NO_DAMAGE alongside a
    // layout change would fall through invalidate's bounds bookkeeping with
    // no rect at all). An x/y-only commit contributes nothing.
    this.invalidate(
      layoutChanged || sizeChanged,
      sizeChanged ? null : ownPaintChanged || layoutChanged ? this : NO_DAMAGE,
      'props',
    );
  }

  /**
   * Re-evaluate the size-query blocks for this window's current size, just
   * before laying out. This is the whole reason a size query may carry
   * layout properties while a state block may not: it only ever runs inside
   * a layout pass the resize already required.
   */
  _resolveSizeQueries(width, height) {
    if (this._sizeQueryNodes.size === 0) {
      this.querySize = this.querySize ?? { width, height };
      return;
    }
    if (this.querySize?.width === width && this.querySize?.height === height) {
      return;
    }
    this.querySize = { width, height };
    for (const node of [...this._sizeQueryNodes]) {
      if (node.destroyed) this._sizeQueryNodes.delete(node);
      else node._sizeQueriesChanged();
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
    this.invalidate(false, damageForAnimation(node), 'animation');
  }

  /**
   * Step every in-flight transition to `now`, then keep the frame clock
   * running while any is unfinished — the animation *is* the repaint loop,
   * and it stops on its own the frame the last one lands.
   */
  _advanceAnimations(now) {
    if (this._animating.size === 0) return;
    const claims = [];
    for (const node of [...this._animating]) {
      if (node.destroyed) {
        this._animating.delete(node);
        continue;
      }
      // Decided *before* the tick, deliberately: a tick that finishes deletes
      // the property from `_anim`, and after that there is no way to tell a
      // layout animation from a paint-only one — the node's own bounds would
      // be claimed for something that just moved, leaving a trail behind it.
      claims.push(damageForAnimation(node));
      if (!node._tickAnimations(now)) this._animating.delete(node);
    }
    this.needsPaint = true;
    // Claim a region rather than leaving the frame unbounded: an animation is
    // a repaint every frame for its whole duration, so this is the difference
    // between a 120ms transition costing eight full-window repaints and eight
    // repaints of the thing that moved. Nodes that *finished* on this tick are
    // claimed too — one just landed on its final value and that last frame
    // still has to paint it, which is why every transition used to end with a
    // full-window repaint.
    for (const claim of claims) this.invalidate(false, claim, 'animation');
  }

  setHidden(hidden) {
    if (hidden) this.window?.unmap?.();
    else this.window?.map?.();
  }

  /**
   * Mark the window as needing work before the next frame.
   *
   * `damage` is an optional node whose *appearance* changed, and it is what
   * turns a full-window repaint into a partial one: the frame then repaints
   * only the region that node covers, and skips emitting drawing for
   * everything outside it. Two rules keep that safe:
   *
   *  - a layout change gets no damage bound. Layout can move anything, and
   *    a node that moved leaves stale pixels behind at its old rect, which
   *    the new rect does not cover;
   *  - a caller that names no node means "something, somewhere", so it also
   *    repaints in full. Partial painting is therefore opt-in per call
   *    site, and forgetting to pass a node costs speed rather than
   *    correctness.
   *
   * `reason` is one word from INVALIDATE_REASONS saying *why* — purely
   * diagnostic, collected per frame into `_lastReasons` so the frame log,
   * REACT_X11_DEBUG_PAINT=full and the tracer can attribute a repaint.
   * Omitting it costs nothing but attribution.
   */
  invalidate(layoutChanged, damage = null, reason = null) {
    if (this.destroyed || !this.window) return;
    if (!layoutChanged && damage === NO_DAMAGE) {
      // Nothing this node draws changed, so it contributes no region — and
      // contributing *nothing* is not the same as contributing "unknown".
      // Returning before `needsPaint` is what makes the difference: a commit
      // in which every node says this schedules no frame at all, where
      // falling through would have marked the window dirty with no region
      // recorded and so repainted all of it. That is the common case for a
      // React re-render whose output is identical — hovering a control whose
      // hover state it does not actually use, for instance. Whoever did
      // change records its own region and schedules its own frame.
      return;
    }
    if (reason) {
      if (DEV && !INVALIDATE_REASONS.has(reason)) {
        console.warn(
          `react-x11: invalidate() got unknown reason ${JSON.stringify(reason)}`,
        );
      }
      (this._frameReasons ??= new Set()).add(reason);
    }
    if (layoutChanged) this.needsLayout = true;
    // A layout change with no bound named repaints everything, because a
    // reflow can move any node and one that moved leaves stale pixels at a
    // rect its new position does not cover. Naming a node alongside
    // `layoutChanged` is an assertion by the caller that the change is
    // confined to that node's subtree *and* that the node clips its children,
    // so both the old and the new position of anything that moved are inside
    // the bound. Scrolling is the case that matters: it reflows a viewport's
    // contents and nothing else, and it happens at input rate.
    if (!damage && this._damage !== FULL_DAMAGE && debugPaint === 'full') {
      // This call is what makes the coming frame unbounded, so this stack —
      // not flush's — is the one that answers "who repainted the window".
      // Captured only under the debug switch: stacks are not free.
      this._fullRepaintCause = {
        reason: reason ?? '(no reason given)',
        stack: new Error('invalidated here').stack,
      };
    }
    // A claim near a viewport that is waiting to blit makes that frame no
    // longer a pure scroll — checked here, at claim time, because once the
    // rects coalesce a change inside the viewport is indistinguishable from
    // the scroll's own claim. (Unbounded claims need no check: FULL_DAMAGE
    // fails the blit's damage gate by itself.)
    const pendingScrolls = this._pendingScrolls;
    if (
      pendingScrolls?.size &&
      damage &&
      damage !== NO_DAMAGE &&
      this._scrollClaim !== damage
    ) {
      const rect = damage.paintBounds ? damage.paintBounds() : damage;
      for (const sv of [...pendingScrolls]) {
        if (
          !sv.abs ||
          rectsOverlap(rect, insetRect(sv.abs, -(DAMAGE_SLOP * 2 + 1)))
        ) {
          pendingScrolls.delete(sv);
          sv._pendingBlitFrom = null;
        }
      }
    }
    if (layoutChanged && !damage) this._damage = FULL_DAMAGE;
    else if (!layoutChanged && !damage) this._damage = FULL_DAMAGE;
    else if (this._damage !== FULL_DAMAGE) {
      // a node, or a bare rect for a caller that has a region rather than a
      // node — a subtree that is about to be removed, say. Claims accumulate
      // as a list of rects rather than one box around them all, so two changes
      // at opposite corners of the window no longer repaint everything
      // between them.
      this._damage = addDamageRect(
        this._damage,
        damage.paintBounds ? damage.paintBounds() : damage,
      );
    }
    this.needsPaint = true;
    // Recorded before the `_scheduled` gate, not inside it: the debt is
    // "this window has damage", which a discrete event may pay off early
    // (see frames.js). Tying it to whether a callback is outstanding would
    // hide the second of two clicks a few milliseconds apart — the first
    // one's frame is still scheduled, so this returns here, and the early
    // flush would find nothing to paint.
    addPendingFrame(this);
    if (this._scheduled) return;
    this._scheduled = true;
    const schedule =
      typeof this.window.requestAnimationFrame === 'function'
        ? (cb) => this.window.requestAnimationFrame(cb)
        : (cb) => setImmediate(cb);
    schedule(() => {
      this._scheduled = false;
      this.flush();
    });
  }

  flush() {
    // Whatever this frame turns out to owe, it is this call's to pay — and
    // a window that returns below because it is destroyed or unrealized
    // owes nothing at all.
    clearPendingFrame(this);
    if (this.destroyed || !this.yoga || !this.window) return;
    // a transientFor whose owner was not realized yet at commit time. The
    // frame after the mount is the first moment refs have attached, so the
    // common "two <window>s in one tree" case resolves here rather than
    // waiting for the app to re-render for some unrelated reason.
    if (this._pendingTransientFor !== undefined) {
      this._applyTransientFor(this._pendingTransientFor);
    }
    this._advanceAnimations(now());
    const width = this.window.width ?? this.props.width ?? 0;
    const height = this.window.height ?? this.props.height ?? 0;
    let layoutMoved = false;
    // captured before the branch clears it: whether *this* flush ran a
    // layout pass is what decides whether an anchored popup needs a look,
    // not the flag's post-pass value
    const layoutRan = this.needsLayout;
    if (this.needsLayout) {
      this._resolveSizeQueries(width, height);
      this.yoga.setWidth(width);
      this.yoga.setHeight(height);
      this.yoga.calculateLayout(width, height, Yoga.DIRECTION_LTR);
      this.abs = { x: 0, y: 0, width, height };
      // the root's rect is written here, not through _assignAbs, so its
      // cached hit reach is dropped here too (children bubble their own)
      this._hitBoundsCache = null;
      // A bounded frame watches the walk: whatever this pass actually moved
      // claims its old and new rects through the sink, and the frame stays
      // a few rects instead of the whole window. An unbounded frame skips
      // the bookkeeping — it repaints everything anyway.
      if (this._damage !== FULL_DAMAGE) {
        layoutDiffSink = (rect) => {
          if (this._damage === FULL_DAMAGE) return;
          layoutMoved = true;
          this._damage = addDamageRect(this._damage, rect);
        };
      }
      try {
        for (const child of this.children) {
          if (!child.isWindow) child.absolutize(0, 0);
        }
      } finally {
        layoutDiffSink = null;
      }
      this.needsLayout = false;
      this.needsPaint = true;
      // The other half of a contained reflow: the pre-mutation arrangement was
      // claimed when the child list changed, and this is the arrangement that
      // replaced it. Claimed after layout because an inserted child has no
      // rect before it.
      for (const node of this._reflowed) {
        if (!node.destroyed)
          this._damage =
            this._damage === FULL_DAMAGE
              ? FULL_DAMAGE
              : addDamageRect(this._damage, node.paintBounds());
      }
      this._reflowed.clear();
    } else if (this._reflowed.size) {
      this._reflowed.clear();
    }
    // any node this pass laid out may be what an open popup is anchored to
    if (layoutRan) this._notifyAnchorChange();
    // after layout (the claims above included), before the damage is taken:
    // a frame that turns out to be a pure scroll blits the surviving band
    // and narrows its claim to the exposed strip
    this._applyScrollBlits(width, height, layoutMoved);
    if (!this.needsPaint) return;
    this.needsPaint = false;
    const damage = this._takeDamage(width, height);
    if (debugPaint === 'full' && !damage && width > 0 && height > 0) {
      // Silent full-window repaints are the perf bug class this renderer
      // actually has (see AGENTS.md); this is what surfaces them. The stack
      // is the invalidate() call that made the frame unbounded, not this
      // flush — flush is always the same place.
      const cause = this._fullRepaintCause;
      console.warn(
        `react-x11: full-window repaint (${width}x${height}) ` +
          `reasons=${this._lastReasons?.join('+') || '(none)'}` +
          (cause ? `\n${cause.stack}` : ''),
      );
    }
    this._fullRepaintCause = null;
    if (typeof this.window.getContext !== 'function') return; // headless mock
    // ntk getContext creates a fresh context (with window-event
    // subscriptions) on every call — cache one per window
    const ctx = (this._ctx ??= this.window.getContext('2d'));
    const frameHook = traceHooks.frame;
    const started = frameHook ? performance.now() : 0;
    if (debugPaint) this._flashTick = (this._flashTick ?? 0) + 1;
    // One pass per damage rect, and a single pass over the whole window when
    // there is no bound. Each pass clips to one rect rather than to all of
    // them at once, which is what keeps ntk's server-side rectangular-clip
    // fast path: a clip path holding several rects is not a rectangle, and
    // falls back to rasterizing a full-surface mask.
    this._paintCache ??= paintCacheFor(this.app);
    this._paintCache?.beginFrame();
    for (const rect of damage ?? [null]) {
      this._paintRegion(ctx, rect, width, height);
    }
    // after every region: an entry drawn in one damage rect must not be
    // evicted before the next rect of the same frame asks for it
    this._paintCache?.endFrame();
    if (frameHook) {
      frameHook({
        root: this,
        rects: damage,
        reasons: this._lastReasons,
        start: started,
        end: performance.now(),
        // ntk's last measured frame fence (GetInputFocus round trip after a
        // frame's requests): how long the server took to drain them. Client
        // work and server drain separate cleanly in a trace only when both
        // are in it — a slow virtualized GPU shows up here, not in `end`.
        fence: this.window.frameLatency,
      });
    }
    // A frame that actually painted, which is the moment the app is up
    // (src/startup.js). One property read once the sequence is over — the
    // session clears itself off the app — which is the same bargain the
    // trace hook above makes with the frame loop.
    this.app._reactX11Startup?.painted();
  }

  /**
   * The scroll-blit fast path (issue #138): when the frame is a *pure*
   * scroll of one viewport, ask ntk to CopyArea the band that stays visible
   * into its new place inside the backing store, and narrow this frame's
   * damage from the whole viewport to the strip the scroll exposed (plus
   * the scrollbar tracks, whose pixels the blit dragged along).
   *
   * Everything here is a gate, cheapest first, and every gate falls back to
   * the claim scrollTo already recorded — the full-viewport repaint that
   * has always been the behavior. The fast path can therefore cost
   * correctness nothing: the worst mistake it can make is not firing.
   */
  _applyScrollBlits(width, height, layoutMoved = false) {
    const pending = this._pendingScrolls;
    if (!pending?.size) return;
    const nodes = [...pending];
    pending.clear();
    const from = nodes[0]._pendingBlitFrom;
    for (const n of nodes) n._pendingBlitFrom = null;
    // two viewports scrolling in one frame is rare enough that sorting out
    // whether their regions interact is not worth it
    if (nodes.length !== 1) return;
    const node = nodes[0];
    if (NO_SCROLL_BLIT || !from || node.destroyed || node.root !== this) return;
    const wnd = this.window;
    if (typeof wnd?.scrollRegion !== 'function') return; // ntk without #139
    // the debug overlays and the DevTools highlight draw over the whole
    // window; a blit would drag shifted copies of them along
    if (debugPaint || process.env.REACT_X11_DEBUG_LAYOUT || this._highlight) {
      return;
    }
    if (!Array.isArray(this._damage)) return; // unbounded frame already
    // the layout diff claimed real movement this pass — the frame is not a
    // pure scroll, and a blit under rearranged content would shift stale
    // pixels into place the repaint no longer covers
    if (layoutMoved) return;
    // children clip to the border box, so a border ring or rounded corner
    // would be shifted like content
    if (node.style.borderWidth > 0 || node.style.borderRadius > 0) return;
    const vp = node.abs;
    // fractional geometry or offsets change every pixel; only a whole-pixel
    // shift is a copy
    if (!isIntegerRect(vp)) return;
    if (!Number.isInteger(from.x) || !Number.isInteger(from.y)) return;
    const dx = node.scrollX - from.x;
    const dy = node.scrollY - from.y;
    if (!Number.isInteger(dx) || !Number.isInteger(dy)) return;
    if (dx === 0 && dy === 0) return;
    // one axis at a time: a diagonal scroll needs an L of strips whose
    // pieces overlap the bar rects, and overlapping damage rects merge into
    // their box (translucent paint must not run twice) — the merges balloon
    // toward the whole viewport and the blit stops paying. Wheels scroll
    // one axis per event, so this costs almost nothing real.
    if (dx !== 0 && dy !== 0) return;
    if (Math.abs(dx) >= vp.width || Math.abs(dy) >= vp.height) return;
    // the worth-it heuristics: below these, the plain repaint is one cheap
    // pass and the blit's bookkeeping outweighs it
    const area = vp.width * vp.height;
    if (area < SCROLL_BLIT_MIN_AREA) return;
    const kept = (vp.width - Math.abs(dx)) * (vp.height - Math.abs(dy));
    if (kept < area * SCROLL_BLIT_MIN_KEEP) return;
    // the band shifts in from inside the window; a viewport poking out of
    // it has nothing there to shift
    if (
      vp.x < 0 ||
      vp.y < 0 ||
      vp.x + vp.width > width ||
      vp.y + vp.height > height
    ) {
      return;
    }
    // A pure scroll and nothing else: the frame's only claim touching the
    // viewport must be the viewport claim itself (scrollTo's, with its
    // slop). Any other rect reaching in — a virtualized table's row swap, a
    // hover restyle mid-scroll — means content changed, and changed pixels
    // must not be blitted around.
    const keep = [];
    let sawClaim = false;
    const slopped = insetRect(vp, -(DAMAGE_SLOP + 1));
    for (const rect of this._damage) {
      if (!rectsOverlap(rect, vp)) {
        keep.push(rect);
        continue;
      }
      if (rectContains(rect, vp) && rectContains(slopped, rect)) {
        sawClaim = true;
        continue;
      }
      return;
    }
    if (!sawClaim) return;
    if (!this._scrollBlitSafe(node, vp)) return;
    // scroll offsets grow down/right; the pixels move the other way
    // (0 - x rather than -x: negating +0 yields -0, which survives into
    // request buffers and test comparisons)
    if (!wnd.scrollRegion({ ...vp }, 0 - dx, 0 - dy)) return;
    let rects = keep;
    // the strip the shift exposed, full breadth — it also covers the corner
    // gutter beside the bars, whose old pixels the blit did not overwrite
    const axis = dy !== 0 ? 'y' : 'x';
    const delta = dy !== 0 ? dy : dx;
    rects = addDamageRect(
      rects,
      axis === 'y'
        ? {
            x: vp.x,
            y: delta > 0 ? vp.y + vp.height - delta : vp.y,
            width: vp.width,
            height: Math.abs(delta),
          }
        : {
            x: delta > 0 ? vp.x + vp.width - delta : vp.x,
            y: vp.y,
            width: Math.abs(delta),
            height: vp.height,
          },
    );
    // Scrollbar repair. The scrolled axis's thumb moved *and* the blit
    // dragged a copy of the old thumb along: repaint the dragged copy's
    // rect and the new thumb's rect — small rects, where the full track
    // would run the viewport's whole length and merge with the strip into
    // most of the viewport. The cross-axis bar did not move, but its band's
    // pixels were shifted like everything else, so its track repaints
    // whole; it lies along the strip, so their merge stays a band.
    const scrolledBar = node._scrollbar(axis);
    if (scrolledBar) {
      const savedX = node.scrollX;
      const savedY = node.scrollY;
      node.scrollX = from.x;
      node.scrollY = from.y;
      const oldBar = node._scrollbar(axis);
      node.scrollX = savedX;
      node.scrollY = savedY;
      if (oldBar) {
        rects = addDamageRect(rects, {
          x: oldBar.x - 1 - dx,
          y: oldBar.y - 1 - dy,
          width: oldBar.width + 2,
          height: oldBar.height + 2,
        });
      }
      rects = addDamageRect(rects, {
        x: scrolledBar.x - 1,
        y: scrolledBar.y - 1,
        width: scrolledBar.width + 2,
        height: scrolledBar.height + 2,
      });
    }
    const crossBar = node._scrollbar(axis === 'y' ? 'x' : 'y');
    if (crossBar) rects = addDamageRect(rects, scrollbarTrackRect(crossBar));
    this._damage = rects;
  }

  /**
   * May the viewport's pixels be moved wholesale? Only if every pixel in it
   * belongs to the scrolled content (or to a plain solid fill behind it):
   * any node outside the scrollview's subtree whose drawing reaches into
   * the viewport — an overlapping sibling, an ancestor's border ring or
   * rounded corner, an enclosing scrollview's scrollbar — would have its
   * pixels dragged along by the blit, so any of them is a no.
   */
  _scrollBlitSafe(scrollview, vp) {
    const ancestors = new Set();
    for (let n = scrollview.parent; n && n !== this; n = n.parent) {
      ancestors.add(n);
    }
    const check = (parent) => {
      for (const child of parent.children) {
        if (child === scrollview) continue; // the scrolled content itself
        if (child.isWindow || !child.yoga || child.hidden) continue;
        if (child.style?.display === 'none') continue;
        if (ancestors.has(child)) {
          // on the path down: its solid background under the viewport is
          // translation-invariant, its border ring and corners are not
          const inset = Math.max(
            child.style?.borderWidth ?? 0,
            child.style?.borderRadius ?? 0,
          );
          if (inset > 0 && !rectContains(insetRect(child.abs, inset), vp)) {
            return false;
          }
          if (typeof child._scrollbars === 'function') {
            for (const bar of child._scrollbars()) {
              if (rectsOverlap(scrollbarTrackRect(bar), vp)) return false;
            }
          }
          if (!check(child)) return false;
          continue;
        }
        if (rectsOverlap(child._subtreeBounds(), vp)) return false;
      }
      return true;
    };
    return check(this);
  }

  /** Repaint one damage rect, or the whole window when `damage` is null. */
  _paintRegion(ctx, damage, width, height) {
    // A transparent window erases where an opaque one paints over. Its
    // backing store holds premultiplied ARGB, and compositing a translucent
    // background onto the previous frame would compound towards opaque
    // instead of replacing it — a popup that fades in would stick.
    //
    // Before the clip below, deliberately: clearing exactly the damage rect
    // covers the same pixels, and an unclipped clearRect is one server-side
    // FillRectangles where a clipped one has to rasterize a coverage mask.
    //
    // `transparencyEffective`, not `_transparent`: an ARGB window with
    // nothing compositing it must not clear, because the server would show
    // those zeroed pixels as black rather than as the desktop.
    if (this.transparencyEffective) {
      if (damage) {
        ctx.clearRect(damage.x, damage.y, damage.width, damage.height);
      } else {
        ctx.clearRect(0, 0, width, height);
      }
    }
    if (damage) {
      // The clip is belt to the culling's braces: it bounds the server-side
      // mask work for whatever *does* paint, and it contains any node that
      // inks slightly outside its own rect. Rectangular clips take ntk's
      // server-side fast path, so this is cheap. The unbounded pass stays
      // unclipped on purpose: a clip would only re-report what ntk already
      // does — its fallback present is clamped to min(window, backing)
      // (ntk >= 5.3, window.js _presentNow) — at two SetPictureClipRectangles
      // per composite, which the protocol bench prices at +207 requests for
      // a hundred-icon full repaint.
      ctx.save();
      ctx.beginPath();
      ctx.rect(damage.x, damage.y, damage.width, damage.height);
      ctx.clip();
    }
    this._paintWindowBackground(ctx, damage, width, height);
    this._paintDamage = damage;
    try {
      this._paintChildren(ctx);
      if (process.env.REACT_X11_DEBUG_LAYOUT) {
        this._paintDebugOverlay(ctx, this, 0);
      }
      const highlight = this._highlight;
      if (highlight && !highlight.destroyed) {
        const r = highlight.abs?.width
          ? highlight.abs
          : { x: 0, y: 0, width, height };
        ctx.fillStyle = 'rgba(41, 128, 185, 0.35)';
        ctx.fillRect(r.x, r.y, r.width, r.height);
      }
      if (debugPaint) {
        // Stroke the pass's rect in this frame's colour ("repaint rainbow"):
        // a region repainting every frame strobes, one that repaints once
        // leaves a single outline behind. Inset a pixel so the stroke
        // survives the clip on all four sides.
        const r = damage ?? { x: 0, y: 0, width, height };
        ctx.strokeStyle =
          FLASH_COLORS[(this._flashTick ?? 0) % FLASH_COLORS.length];
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.rect(r.x + 1, r.y + 1, r.width - 2, r.height - 2);
        ctx.stroke();
      }
    } finally {
      this._paintDamage = null;
      if (damage) ctx.restore();
    }
  }

  /**
   * The window's own background, painted under the whole tree.
   *
   * An opaque window falls back to white, because "no background" is not
   * something X can show. A transparent one has no fallback and needs none:
   * the clear in `_paintRegion` already left it empty, and empty is the
   * point — a `<popup transparent>` with no `backgroundColor` is a floating
   * tree with nothing behind it.
   *
   * `borderRadius` only means anything here, and only on a transparent
   * window. This fill is the bottom-most thing in the window, so rounding it
   * rounds the window itself, and the corners it gives up are the corners
   * the compositor then shows the desktop through — antialiased, without the
   * Shape extension's hard 1-bit edge.
   */
  _paintWindowBackground(ctx, damage, width, height) {
    const { backgroundColor, borderRadius = 0 } = this.style;
    if (this.transparencyEffective) {
      if (!isPaintedColor(backgroundColor)) return;
      ctx.fillStyle = backgroundColor;
      if (borderRadius > 0 && typeof ctx.roundRect === 'function') {
        // The path is the whole window however small the damage rect is —
        // the clip bounds it — so repainting one corner still draws that
        // corner's curve rather than a square patch of background.
        ctx.beginPath();
        ctx.roundRect(0, 0, width, height, borderRadius);
        ctx.fill();
        return;
      }
    } else {
      // An ARGB window that nothing is compositing has an alpha channel it
      // must not use. It gets filled edge to edge and square — `borderRadius`
      // is ignored, because giving up the corners here would expose the
      // black those pixels really are. A translucent colour is flattened
      // over white rather than composited onto the last frame, which on a
      // window with alpha would otherwise creep towards opaque a frame at a
      // time and never settle anywhere predictable.
      if (this._transparent) {
        ctx.fillStyle = 'white';
        if (damage) {
          ctx.fillRect(damage.x, damage.y, damage.width, damage.height);
        } else {
          ctx.fillRect(0, 0, width, height);
        }
      }
      // No `backgroundColor` means the desktop's, not white: a window whose
      // widgets went dark on a dark desktop must not leave a white rectangle
      // behind them. An app that named a colour gets the colour it named.
      ctx.fillStyle = backgroundColor || this.theme.background;
    }
    // repainting the background only where it is about to be drawn over is
    // the other half of the win: a full-window fill is a full-window
    // composite however little changed
    if (damage) ctx.fillRect(damage.x, damage.y, damage.width, damage.height);
    else ctx.fillRect(0, 0, width, height);
  }

  /**
   * The rects this frame will repaint, or null for the whole window.
   *
   * Clamped to the window: damage is recorded when a node invalidates, and
   * the window may have been resized since. A region that no longer
   * intersects the window means there is nothing to do, but the frame still
   * has to clear the flag, so it degrades to a full repaint rather than
   * painting nothing.
   */
  _takeDamage(width, height) {
    const damage = this._damage;
    this._damage = null;
    // what the frame about to run settled on, for the tests and for
    // REACT_X11_DEBUG_LAYOUT to report; null means it repainted everything.
    // `_lastDamage` is the box around the rects, which is what a caller
    // wanting one number for "where did this frame paint" means by it.
    // `_lastReasons` is why: every reason invalidate() was given since the
    // previous frame, for the frame log and the full-repaint warning.
    this._lastDamage = null;
    this._lastDamageRects = null;
    const reasons = this._frameReasons;
    if (reasons?.size) {
      this._lastReasons = [...reasons];
      reasons.clear();
    } else {
      this._lastReasons = EMPTY_REASONS;
    }
    if (damage === FULL_DAMAGE || !damage) return null;
    const rects = [];
    for (const claimed of damage) {
      const clamped = this._clampDamage(claimed, width, height);
      // one claim covering the window makes the whole frame unbounded, so
      // there is nothing to learn from the rest of the list
      if (clamped === FULL_DAMAGE) return null;
      if (clamped) rects.push(clamped);
    }
    if (!rects.length) return null;
    this._lastDamageRects = damageToPaint(rects);
    this._lastDamage = rectsBounds(this._lastDamageRects);
    return this._lastDamageRects;
  }

  /**
   * One claimed rect snapped to whole pixels inside the window: null when
   * nothing of it is left, `FULL_DAMAGE` when it covers the window.
   */
  _clampDamage(damage, width, height) {
    const x = Math.max(0, Math.floor(damage.x));
    const y = Math.max(0, Math.floor(damage.y));
    const right = Math.min(width, Math.ceil(damage.x + damage.width));
    const bottom = Math.min(height, Math.ceil(damage.y + damage.height));
    if (right <= x || bottom <= y) return null;
    // covering the window is the same as not being bounded at all, and the
    // full path is one fill instead of a clip plus a fill
    if (x === 0 && y === 0 && right >= width && bottom >= height) {
      return FULL_DAMAGE;
    }
    return { x, y, width: right - x, height: bottom - y };
  }

  /** DevTools hover highlight: tint a node's rect on the next paint. */
  setHighlight(node) {
    if (this._highlight === node) return;
    const prev = this._highlight;
    this._highlight = node;
    // The tint leaves one rect and lands on another, and both are already
    // known, so the claim is their union rather than the window. A side
    // with no laid-out rect tints (or tinted) the whole window — the same
    // fallback _paintRegion paints — so only that case stays unbounded.
    const rects = [];
    for (const n of [prev, node]) {
      if (!n) continue;
      if (!n.abs?.width) {
        this.invalidate(false, null, 'highlight');
        return;
      }
      rects.push(n.abs);
    }
    for (const rect of rects) this.invalidate(false, rect, 'highlight');
  }

  /** REACT_X11_DEBUG_LAYOUT=1: outline every drawn node, color by depth. */
  _paintDebugOverlay(ctx, node, depth) {
    const colors = ['#e74c3c', '#27ae60', '#2980b9', '#8e44ad', '#f39c12'];
    for (const child of node.paintOrder()) {
      ctx.strokeStyle = colors[depth % colors.length];
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.rect(
        child.abs.x + 0.5,
        child.abs.y + 0.5,
        child.abs.width - 1,
        child.abs.height - 1,
      );
      ctx.stroke();
      this._paintDebugOverlay(ctx, child, depth + 1);
    }
  }
}

/**
 * <popup>: an override-redirect top-level window (needs ntk >= 3.1.0, which
 * forwards the attribute — sidorares/ntk#55). The window manager ignores it:
 * no decorations, no focus stealing — menus, tooltips, dropdowns. `x`/`y`
 * are screen coordinates (anchor with ev.nativeEvent.rootx/rooty or a ref's
 * abs rect + owner window position). It may appear anywhere in the JSX tree
 * but is always its own paint/event root, realized against the screen root
 * in commitMount.
 */
export class PopupNode extends WindowNode {
  /**
   * `grab`: hold a pointer grab while this popup is up. That is how menus
   * work on X — without it a press that lands anywhere else (another app,
   * the root, or this app's own window *frame*, which belongs to the window
   * manager) never reaches us, so the menu stays open behind whatever the
   * user clicked. With the grab, that press arrives here instead, outside
   * our bounds, and `onDismiss` fires. Needs ntk >= 3.7.0; without it the
   * popup simply behaves as before.
   */
  realize(parentWindow) {
    super.realize(parentWindow);
    if (this.props.grab && !this.destroyed) {
      this.window?.grabPointer?.({}, () => {});
    }
  }

  destroySubtree() {
    if (this.props.grab) this.window?.ungrabPointer?.();
    super.destroySubtree();
  }

  constructor(app, attributes, props) {
    // Override-redirect is the default and is what keeps the window manager
    // from repositioning or decorating a menu — but it is now a default
    // rather than a fact, because it is the one bit standing between
    // `<popup>` and a real, WM-managed dialog: `overrideRedirect={false}`
    // gives a decorated, movable window the WM will stack above its owner
    // and iconify with it. Menus, tooltips and `Select` keep the default.
    //
    // The EWMH type hint is additive — the spec asks for it on
    // override-redirect windows too, so compositing managers can give menus
    // and tooltips consistent shadows/animations. `windowType` overrides the
    // default (e.g. "tooltip", "popup_menu").
    super(
      app,
      {
        ...attributes,
        overrideRedirect: attributes.overrideRedirect ?? true,
        windowType: attributes.windowType ?? 'dropdown_menu',
      },
      props,
    );
    this.isPopup = true;
  }
}

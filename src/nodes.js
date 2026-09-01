// Retained node tree: one lightweight JS node per host element, one yoga node
// per drawn element, painted into the owning <window>'s single 2d context on
// ntk's frame clock. Only <window> owns a real X11 window (see NEXT_STEPS.md
// §4 for the rationale).
import {
  animationValueAt,
  animationsOf,
  sameAnimation,
  applyLayoutStyle,
  applyLayoutDefaults,
  createLayoutNode,
  measuringExactly,
  paintPropsChanged,
  textStyleFrom,
  DEFAULT_TEXT_STYLE,
  inheritedTextChanged,
  localTextStyleChanged,
  resolvedTextDelta,
  TEXT_REMEASURE,
  flattenStyle,
  validateStyle,
  resolveStyleStates,
  resolveComputedStyle,
  scaleResolvedStyle,
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
  resolveBorderWidths,
  resolveBorderColors,
  tint,
} from './styles.js';
import {
  blurKernel,
  gradientSpec,
  linearGradientGeometry,
  shadowExtent,
  shadowSpecs,
} from './decorations.js';
import {
  DrawableSource,
  PictureSource,
  acquireImageSource,
  decodeImageSource,
  imageSourceChanged,
  isDirectImageSource,
  isPathImageSource,
  isRawImageSource,
  releaseImageSource,
  toLoadablePath,
  validateImageProps,
} from './imagesource.js';
import { Yoga } from './yoga.js';
import { scaleOf } from './scale.js';
// Namespace import for `Surface`, the same shape and the same reason as
// `paintcache.js`: a named import of something an older ntk does not export
// is a *load-time* SyntaxError, which would take the renderer down rather
// than the one feature that needs it.
import * as ntk from 'ntk';
import { cssColorStraight } from 'ntk';
import {
  EventManager,
  discrete,
  synthesizeClick,
  WHEEL_NOTCH_PX,
} from './events.js';
import {
  DropSession,
  dndAtoms,
  forgetTopLevel,
  hasDropProps,
  registerTopLevel,
  XDND_VERSION,
} from './dnd.js';
import { addPendingFrame, clearPendingFrame } from './frames.js';
import { createClientMessages } from './clientmessage.js';
import {
  argbVisual,
  compositingActive,
  transparencyDisabled,
  watchCompositing,
} from './compositing.js';
import { availableArea } from './screens.js';
import {
  DEFAULTS as DESKTOP_DEFAULTS,
  desktopSettings,
  watchDesktopSettings,
} from './desktopsettings.js';
import {
  endWindowState,
  watchWindowState,
  windowStateSnapshot,
} from './windowstate.js';
import {
  deviceAnchorArea,
  anchorOffscreen,
  anchorRect,
  windowOrigin,
} from './anchor.js';
import { baseTheme } from './palette.js';
import {
  callHandler,
  ownerName,
  reportStyleError,
  STRICT_TOKENS,
} from './errors.js';
import {
  hooks as a11yHooks,
  isFocusable as a11yFocusable,
  devCheckA11yProps,
  hasClickHandler,
} from './a11y.js';
import { topLevelWindows, windowIdOf } from './windowid.js';
import { paintCacheFor } from './paintcache.js';
import { hooks as traceHooks } from './trace-registry.js';
import { runWithPriority, DiscreteEventPriority } from './priority.js';
import { lastInputTime } from './inputtime.js';
import { armPasteState, canPaste } from './pastestate.js';
import { ctrlChordLetter, MOD } from './keysyms.js';
import {
  codePointAtOffset,
  codePoints,
  codeUnitOffsets,
  wordBoundary,
  wordRangeAt,
} from './textrange.js';
import {
  TextSelection,
  dropVisibleSelection,
  selectionSurfaceOf,
  takeVisibleSelection,
} from './textselection.js';
import {
  editMenuColors,
  editMenuGeometry,
  editMenuIndexAt,
  editMenuItems,
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
  'textinput',
  'textarea',
  'svg',
]);

/** kind -> style names a registered element claims as its own semantics.
 * Filled by registry.js; read by `Node.semanticNames`, so a registered
 * element gets the exemption without subclassing the getter. */
export const CUSTOM_SEMANTIC_NAMES = new Map();

/** kind -> prop names a registered element claims the damage for itself.
 * Filled by registry.js, read by `Node.selfDamagedProps` — the same
 * arrangement as above, for the other declaration a scene-drawing element
 * makes (issue #301). */
export const CUSTOM_SELF_DAMAGED = new Map();

// X ConfigureWindow stack-mode: Below places the window directly under the
// named sibling (X11 protocol, ConfigureWindow).
const STACK_BELOW = 1;

// Windows whose child stacking order may have gone stale during the commit
// in progress; drained by flushWindowRestacks from resetAfterCommit.
const pendingRestack = new Set();

// Windows realized during the commit in progress, waiting to be mapped;
// drained by flushWindowMaps from resetAfterCommit. See beginWindowMaps.
const pendingMaps = new Set();
let inCommit = false;

/**
 * A window maps at the *end* of the commit that realized it, not when
 * `realize()` runs.
 *
 * React inserts a host instance before it hides it: `hideInstance` runs
 * after the whole mutation phase, so a `<window>` born inside a hidden
 * `<Activity>` — or inside a `<Suspense>` that suspends on its first render
 * — used to be mapped and unmapped back to back. That pair is only safe
 * when nothing redirects the map. Under a window manager holding
 * SubstructureRedirect on the root the MapWindow is **not performed**: the
 * server turns it into a MapRequest and leaves the window unmapped, so the
 * UnmapWindow that follows lands on an already-unmapped window and is
 * discarded. The window manager then services its MapRequest and the
 * "hidden" window is on screen for good (issue #201).
 *
 * Deferring costs nothing — `resetAfterCommit` runs inside the same
 * synchronous `render()` — and it means the map is decided at the one
 * moment when whether the window is hidden is already known.
 *
 * Outside a commit (a `<popup>` realized from `commitMount`, which runs in
 * the layout phase, or one built imperatively like the text controls' edit
 * menu) there is no such phase to wait for, and no hiding on the way
 * either: those map immediately.
 */
export function beginWindowMaps() {
  // A commit that never reached `resetAfterCommit` left its queue behind,
  // and a window that is owed a map had better get one late rather than
  // never — that failure mode is an application with no windows in it.
  flushWindowMaps();
  inCommit = true;
}

/** Map every window this commit realized and did not then hide. */
export function flushWindowMaps() {
  inCommit = false;
  const nodes = [...pendingMaps];
  pendingMaps.clear();
  for (const node of nodes) node._mapNow();
}

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

// The uniform translation the subtree currently being walked is riding: set
// while a scroll container whose blit is armed lays its children out, so the
// diff can tell "moved" from "scrolled" (issue #398). Every child of such a
// container lands at its old rect plus this shift, which is precisely what
// the blit is about to do to those pixels — so it is not a change, and the
// diff reports only the children that landed somewhere else. Null everywhere
// else, and restored through `finally` like the sink beside it.
let layoutDiffShift = null;

// What an invalidate() may name as its reason — a small closed set, so the
// frame log, the tracer and the full-repaint warning can print "why" next
// to "where". A typo'd reason would silently vanish from every report, so
// DEV validates against this list.
const INVALIDATE_REASONS = new Set([
  'props', // a React commit changed what a node draws
  'style-state', // :hover/:focus/:active/:disabled restyle
  'shadow', // a boxShadow got smaller: where it *was* still owes a repaint
  'outline', // …and the same for an outline a style swap took away
  'theme', // a theme/token change restyled a subtree
  'direction', // the reading direction moved: sides, glyph order, bar edge
  'animation', // a transition frame
  'scroll', // scrollTo/scrollBy/scrollIntoView, textarea/textinput panning
  'text', // text content, input value or caret editing
  'selection', // the document selection lit or unlit a range of text
  'content', // async content arrived (image decode, rich-content reflow)
  'measure', // an element said its own size changed (invalidateMeasure)
  'child-list', // children were added, removed or reordered
  'focus', // focus moved: ring/caret handover between nodes
  'caret', // the caret blink timer
  'resize', // the window changed size
  'mount', // the window was just realized; its first frame
  'expose', // ntk asked for a redraw (backing store invalidated)
  'highlight', // DevTools hover highlight
  'trace-updates', // DevTools' outline of what just re-rendered
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

// …and how much of it the frame may end up repainting anyway. The strip and
// the scrollbar repair sit under this by a wide margin; what can push past
// it is a ledger repair (issue #398) that the damage cap had to merge with
// the scrollbar column, whose box then reaches back across the viewport.
// Past this the blit is buying a shift and paying for the viewport anyway.
const SCROLL_BLIT_MAX_REPAINT = 0.75;

// The server-side event mask every realized window ends up with. The
// subscriptions are a constant — the EventManager's pointer/key/focus
// listeners, the window's own resize/draw/expose pair, the backing store's
// Exposure — but ntk grows the mask lazily, one ChangeWindowAttributes per
// first listener of each kind: nine requests per window for a value known
// before the window exists. Declaring the union in CreateWindow makes every
// one of those a detected no-op (ntk ORs `eventMask` into what it derives,
// and `newListener` only issues the request for bits still missing).
//
// The values are core-protocol SETofEVENT bits, fixed since X11R1 — the
// same numbers ntk's own table maps event names to, written out because ntk
// does not export them. EnterWindow is deliberately absent: hover tracking
// reads `mousemove`/`mouseout` only, and parity with the lazily-grown mask
// is what keeps this a request-count change and nothing else.
const WINDOW_EVENT_MASK =
  (1 << 0) | // KeyPress        — keydown
  (1 << 1) | // KeyRelease      — keyup
  (1 << 2) | // ButtonPress     — mousedown, and the core half of wheel
  (1 << 3) | // ButtonRelease   — mouseup
  (1 << 5) | // LeaveWindow     — mouseout
  (1 << 6) | // PointerMotion   — mousemove (hover, drag)
  (1 << 15) | // Exposure       — draw/expose, and the backing store's redraws
  (1 << 17) | // StructureNotify — resize/map/destroy (ntk's own baseline)
  (1 << 21); // FocusChange    — focus/blur

// A scroll that must not blit this frame: content inside the viewport
// already changed (see the arming check in scrollTo, and the claim-time
// cancel in WindowNode.invalidate — react-x11#295). Truthy on purpose, so
// scrollTo's `??=` cannot re-arm over it, and reset by _applyScrollBlits'
// up-front clear like any real origin, so it lives exactly one frame.
const BLIT_POISONED = Object.freeze({ poisoned: true });

// A frame armed by `Node.scrollContents` rather than by a scroll offset
// (issue #303): there is no origin to record, because the element handed
// over the shift itself. Truthy for the same reason as the poison — so the
// `??=` in both arming paths reads "already armed" — with the rect and the
// net delta in `_pendingBlitContents` beside it.
const BLIT_CONTENTS = Object.freeze({ contents: true });

// How much of what changed inside a blitting viewport the ledger will carry
// before the frame gives up and repaints the viewport instead (issue #398).
// A virtualized list's scroll frame changes a handful of regions — the two
// spacers and the entering rows — and past that the blit plus a scatter of
// repaints stops being cheaper than the one pass it replaced.
const BLIT_MAX_CLAIMS = 8;
const BLIT_MAX_CLAIM_AREA = 0.25;

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
  const width = SCROLLBAR_WIDTH * (bar.scale ?? 1);
  const rect =
    bar.axis === 'x'
      ? {
          x: bar.trackStart,
          y: bar.crossStart,
          width: bar.trackLength,
          height: width,
        }
      : {
          x: bar.crossStart,
          y: bar.trackStart,
          width,
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
export function pixelFor(color) {
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

/**
 * `rect`, rounded, as a path — the one shape the drawn layer is made of.
 * `roundRect` needs ntk >= 3.2.0 and the square fallback is what an older
 * one gets, which is the same degradation `_paintBorder` has always made.
 */
function roundedPath(ctx, rect, radius) {
  ctx.beginPath();
  if (radius > 0 && typeof ctx.roundRect === 'function') {
    ctx.roundRect(rect.x, rect.y, rect.width, rect.height, radius);
  } else {
    ctx.rect(rect.x, rect.y, rect.width, rect.height);
  }
}

/** A style's shadow reach, for the callers that have a style rather than
 *  a node (`_retarget`'s before/after pair). `scale` because the value is a
 *  string the style funnel could not convert (see decorations.js). */
function shadowExtentOf(style, scale = 1) {
  const value = style?.boxShadow;
  if (!value || value === 'none') return 0;
  return shadowExtent(shadowSpecs(value, scale));
}

const DEV = process.env.NODE_ENV !== 'production';

// Connections already told they have no 32-bit visual (`_argbAttributes`).
const warnedNoArgb = new WeakSet();

/**
 * `boxShadow` on a `<window>`/`<popup>`, warned about once.
 *
 * A shadow falls *outside* the box, and outside a toplevel there is nothing
 * of ours to paint on — the pixels belong to the desktop. Doing it properly
 * means the window asking for a translucent margin it does not otherwise
 * want (an ARGB visual, a bigger X window, and hit testing that knows the
 * difference), which is a feature of its own rather than a line in the
 * painter. Said out loud because the alternative is a style that reads as
 * ignored for no reason.
 */
let warnedWindowShadow = false;
function devWarnWindowShadow(kind) {
  if (warnedWindowShadow) return;
  warnedWindowShadow = true;
  console.warn(
    `react-x11: boxShadow on <${kind}> is ignored — a shadow is painted ` +
      'outside the box, and a toplevel window owns no pixels there. Put the ' +
      'shadow on a <box> inside it, or draw the window with a translucent ' +
      'margin of its own (docs/styling.md).',
  );
}

// `borderRadius` on a non-uniform border warned about once (`_paintBorderSides`).
let warnedSideRadius = false;

/**
 * Depth of the `_themeChanged` walk in progress, if any.
 *
 * That walk already visits every node in the subtree and re-resolves each
 * one, so a style swap it performs on the way down must not kick off a
 * second walk of the nodes it is about to reach anyway. Without the guard a
 * theme change over a tree of token-using nodes is quadratic in its depth.
 */
let inThemeWalk = 0;

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

// And the default for the other declaration: an element that has not said
// otherwise claims nothing for itself, so every prop it holds is core's to
// be conservative about.
const NO_SELF_DAMAGED = new Set();

// X window geometry is CARD16 and coordinates are INT16, so a window wider
// than this cannot be positioned or damaged coherently even where the server
// accepts it. Nothing sized from content should get near it; it is the
// backstop for a measure function that answered Infinity.
const MAX_WINDOW_EXTENT = 32767;

/** One axis of an auto size, bounded the way CSS bounds `width: auto`. */
function clampExtent(value, min, max) {
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
function clampBound(value, max) {
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
function screenOriginOf(target) {
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
const isContentBound = (value) => value === 'auto';

/** A bound as a number, or nothing where it is the content's to answer. */
const numericBound = (value) => (isContentBound(value) ? undefined : value);

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
const canonicalSize = (value) => (isAutoSize(value) ? 'auto' : value);

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
function assertWindowSize(props, kind) {
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
 * Record how tall every leaf in this subtree currently is, keyed by node.
 *
 * A leaf's height at a given width is not something it can give: a
 * paragraph wrapped to 300px is as tall as it is. But `align-items` defaults
 * to `stretch`, so a leaf inside a `row` takes the row's height — and in a
 * pass run with no height on offer the row came out at nothing, taking its
 * leaves down with it. A container in that position is recovered by looking
 * inside it; a leaf has nothing inside, which is what this is for.
 */
function captureLeafHeights(node, out) {
  let leaf = true;
  for (const child of node.children) {
    if (!child.yoga || child.isWindow) continue;
    if (child.style.display === 'none') continue;
    if (child.style.position !== 'absolute') leaf = false;
    captureLeafHeights(child, out);
  }
  if (leaf) out.set(node, node.yoga.getComputedHeight());
}

/**
 * Whether this node has **named a floor of its own** on `axis` — the cases
 * where CSS's `min-*: auto` is not the content-based minimum, so the node may
 * give way to whatever squeezes it and its contents stop counting:
 *
 * - it clips, so what overflows it is not something to make room for. CSS
 *   computes `min-*: auto` to `0` on anything whose overflow is not
 *   `visible`, and it is the escape hatch Qt spells `QScrollArea` and GTK
 *   spells `min-content-width`;
 * - the author wrote a number in `minWidth`/`minHeight`. `0` — "I can be any
 *   size" — is the one that matters and the one a scroll container gets
 *   given.
 *
 * This used to read "it was told it may shrink", back when `flexShrink`
 * defaulted to yoga's `0` and asking for `1` was therefore a statement. Every
 * node may shrink now (#249), so the clause carried no information and had to
 * go: `minWidth: 0` is how a style says "down to nothing", and `flexShrink`
 * is back to meaning only how eagerly the space *above* the floor is given
 * up.
 */
function namesOwnFloor(node, axis) {
  const style = node.style;
  if (style.overflow === 'scroll' || style.overflow === 'hidden') return true;
  return (
    typeof (axis === 'width' ? style.minWidth : style.minHeight) === 'number'
  );
}

/**
 * Whether this node's laid-out extent in a min-content pass is already the
 * answer, so there is no need to look inside it. Everything that names a
 * floor, plus the two other ways a style can bound itself: a **size**, which
 * a min-content measurement here keeps rather than shrinking past (see
 * `writeContentFloors`), and a **ceiling**, since CSS clamps the content
 * suggestion by the specified `max-*` too.
 */
function declaresOwnMinimum(node, axis) {
  if (namesOwnFloor(node, axis)) return true;
  const style = node.style;
  const [size, max] =
    axis === 'width'
      ? [style.width, style.maxWidth]
      : [style.height, style.maxHeight];
  return typeof size === 'number' || typeof max === 'number';
}

/** In this node's parent's flow at all: an absolute or `display: 'none'`
 *  child is not a flex item and contributes nothing to what contains it —
 *  CSS says the same about both. */
function inFlow(node) {
  return (
    node.yoga &&
    !node.isWindow &&
    node.style.position !== 'absolute' &&
    node.style.display !== 'none'
  );
}

/** Which axis this node lays its children out along. */
const mainAxisOf = (node) => {
  const direction = node.style.flexDirection ?? 'column';
  return direction === 'row' || direction === 'row-reverse'
    ? 'width'
    : 'height';
};

/**
 * Put the tree in the state a **min-content** measurement means: a node that
 * has said how small it can be is let go all the way down to it, and a node
 * that has not cannot give at all, because what it needs is the thing being
 * measured.
 *
 * This is what the layout pass with no room on offer used to get from yoga's
 * own `flexShrink: 0` default. Now that the default is CSS's `1` (#249) the
 * pass has to be told, or every node would shrink to nothing and answer that
 * the content needs no room — which is true of no content anywhere.
 */
function setMeasuringShrink(node, axis) {
  for (const child of node.children) {
    if (!child.yoga || child.isWindow) continue;
    child.yoga.setFlexShrink(namesOwnFloor(child, axis) ? 1 : 0);
    // …and not into a `display: 'none'` subtree, which the measurement does
    // not read and `writeContentFloors` therefore does not walk back through
    if (child.style.display === 'none') continue;
    setMeasuringShrink(child, axis);
  }
}

/** …and back to the layout everything else is run from. */
function restoreShrink(node) {
  for (const child of node.children) {
    if (!child.yoga || child.isWindow) continue;
    child.yoga.setFlexShrink(child.style.flexShrink ?? 1);
    restoreShrink(child);
  }
}

/**
 * Pin every box under `node` at the width the pass just settled it at, so
 * that the collapse which follows can only take **height** away.
 *
 * A minimum height is always a height *for a width* (`_applyContentFloors`),
 * and the width it is for is the one the first pass settled — the tree at the
 * size it is really about to be laid out at. The collapsing pass is asked
 * only how much of that height the tree can give back, and it has no business
 * re-deciding the widths on the way. Left to itself it does, because offering
 * no height at all is not a small layout but a degenerate one: yoga answers a
 * box measured against a zero cross size out of its bounds, without laying
 * its children out at all, and where the width on offer was *also* undefined
 * that bound is the node's `min-width` — the min-content floor this same
 * routine wrote a moment earlier. Under a horizontally scrolling box the
 * width is exactly what is undefined, a scroll container withholding its
 * main-axis size from a child's flex basis the way browsers do. So the
 * subtree was laid out at min-content **width**, where a label takes two
 * lines, and the two-line height became the floor of the row around it: one
 * line of text in a box that reserved two (issue #311).
 *
 * Pinning is enough because that answer is only wrong where there was no
 * width to answer with — a box that names its own is measured at it whatever
 * else the pass is doing, and its children are laid out inside that. It costs
 * nothing either: every leaf is offered the width it was already measured at,
 * so the paragraphs the first pass shaped come back out of the layout cache.
 */
function freezeWidths(node) {
  for (const child of node.children) {
    if (!child.yoga || child.isWindow) continue;
    // as in `setMeasuringShrink`: a `display: 'none'` subtree was not laid
    // out, so there is no width in there to keep
    if (child.style.display === 'none') continue;
    child.yoga.setWidth(child.yoga.getComputedWidth());
    freezeWidths(child);
  }
}

/** …and back to the width the style asks for. Walks what `freezeWidths`
 *  walked, so a box it never pinned is never written to either. */
function restoreWidths(node) {
  for (const child of node.children) {
    if (!child.yoga || child.isWindow) continue;
    if (child.style.display === 'none') continue;
    child.yoga.setWidth(child.style.width);
    restoreWidths(child);
  }
}

/**
 * How far this node's content actually reaches along one axis, in its own
 * coordinate space — the reading of a layout the root was given no room for,
 * where `getComputedWidth()` says nothing (a root offered 0 is clamped to 0)
 * but the children still sit where their own styles put them.
 *
 * A **span** rather than a rightmost edge, because a `center` or
 * `space-around` row given less room than it needs overflows *both* sides —
 * exactly as CSS says it should — and its first child's edge lands at a
 * negative offset. The padding and border are added back on both sides
 * because the span is measured between the children, inside them.
 *
 * Out-of-flow children are skipped, as they are in CSS: an absolutely
 * positioned node contributes nothing to what contains it, and a
 * `display: 'none'` one is not there at all.
 *
 * `intrinsic` carries what the leaves measured to before the pass being read
 * squashed them — see `_measureContentSpans`, which is the only caller that
 * needs it. A container that came out at nothing is recovered by looking
 * inside it; a leaf has nothing inside, so it has to be remembered.
 *
 * `out` collects, for every node on the way, **the extent it contributes to
 * the box around it** — which is exactly that node's automatic minimum size,
 * so one pass and one walk give the whole tree its floors (#249) instead of
 * a measurement per node. The recursion is therefore over all the children,
 * even the ones whose own content does not count towards this one's: a
 * scroll pane contributes nothing to the floor above it and still needs
 * floors written *inside* it, or the column of rows it holds would shrink to
 * the viewport and there would be nothing left to scroll.
 */
function contentSpan(node, axis, intrinsic, out) {
  const yoga = node.yoga;
  const horizontal = axis === 'width';
  const own = horizontal ? yoga.getComputedWidth() : yoga.getComputedHeight();
  const [startEdge, endEdge] = horizontal
    ? [Yoga.EDGE_LEFT, Yoga.EDGE_RIGHT]
    : [Yoga.EDGE_TOP, Yoga.EDGE_BOTTOM];
  const axisIsMain = mainAxisOf(node) === axis;
  let start = Infinity;
  let end = -Infinity;
  // What the children after this one were laid out too early by. A node the
  // pass squashed is one its siblings were packed in behind, so recovering
  // its extent without moving them along would lose exactly what was
  // recovered — the span would come out the same as before.
  let shift = 0;
  for (const child of node.children) {
    // the same set that joins the flex tree: a nested <window> is laid out
    // by itself, and a <text> span has no box of its own
    if (!child.yoga || child.isWindow) continue;
    if (child.style.display === 'none') continue;
    const span = contentSpan(child, axis, intrinsic, out);
    const laidOut = horizontal
      ? child.yoga.getComputedWidth()
      : child.yoga.getComputedHeight();
    // What the child needs from this box. A node that has said how small it
    // can be is taken at its word — the measuring pass already let it shrink
    // to exactly that — and anything else is asked what is inside it. Its
    // laid-out size is deliberately *not* a floor under that answer: nothing
    // shrank in this pass, so a box that measures its own content is sitting
    // at its **max**-content size, which is the width a label would like to
    // be rather than the width it can be squeezed to.
    const extent = declaresOwnMinimum(child, axis) ? laidOut : span;
    out?.set(child, extent);
    if (child.style.position === 'absolute') continue;
    const at =
      (horizontal
        ? child.yoga.getComputedLeft()
        : child.yoga.getComputedTop()) + shift;
    // Only along the axis the children are packed on: on the other one they
    // all start from the same edge, so nothing follows anything.
    if (axisIsMain) shift += extent - laidOut;
    start = Math.min(start, at);
    end = Math.max(end, at + extent);
  }
  if (start === Infinity) {
    // A leaf: nothing inside to look at, and what the pass did to it may
    // have been a stretch rather than a measurement. So it is asked again.
    //
    // **Across**, a leaf that measures itself answers outright: the width it
    // gives when offered none is its min-content width, which for a
    // paragraph is its longest word. That *replaces* the laid-out width
    // rather than joining it in a `max`, because a measured leaf's base size
    // is its max-content width — the whole line, unwrapped — and taking the
    // larger of the two would floor every label at the width it would like
    // to be. A leaf that measures nothing has only its own box to report.
    //
    // **Down**, it is what the leaf measured before the collapse squashed
    // it: a height at a settled width is not a leaf's to give.
    if (horizontal) {
      const measured = node._measureFn?.(
        0,
        Yoga.MEASURE_MODE_AT_MOST,
        undefined,
        Yoga.MEASURE_MODE_UNDEFINED,
      )?.width;
      return measured ?? own;
    }
    return Math.max(own, intrinsic?.get(node) ?? 0);
  }
  const edges =
    yoga.getComputedPadding(startEdge) +
    yoga.getComputedPadding(endEdge) +
    yoga.getComputedBorder(startEdge) +
    yoga.getComputedBorder(endEdge);
  return end - start + edges;
}

/**
 * Write CSS's **automatic minimum size** onto every flex item under `node`:
 * a floor of the extent it needs, along the axis its container lays out on,
 * and restore the `flexShrink` the measurement borrowed on the way past.
 *
 * This is the other half of `flexShrink` defaulting to `1` (#249), and
 * neither half is any good without the other. Yoga implements the shrink and
 * not the floor, so a default of `1` on its own shrinks everything to
 * nothing — a scroll pane's content collapses into its viewport and there is
 * nothing left to scroll — while a default of `0` never squeezes a row into
 * the space it has. CSS has both, and what makes its `flex-shrink: 1` safe is
 * that `min-width: auto` on a flex item resolves to the item's min-content
 * size. That is what this writes.
 *
 * Only the **main** axis, as in CSS: shrinking happens along the axis the
 * container packs on, and on the other one an item is stretched or fits its
 * content either way.
 *
 * Where this deliberately parts company with CSS is a node that named a
 * size: CSS floors that at `min(the size, the content)`, so a `height: 40`
 * box with nothing in it still squashes to nothing in a column too short for
 * it. That rule is survivable on the web because a `<div>` is a *block*
 * container and its children are not flex items at all; here every box lays
 * its children out with flex, so it would apply to the whole tree — and a
 * row of 40px cells silently 8px tall is not what anyone wrote. **A size
 * that was named is a size that is kept**, and `minHeight: 0` is how an
 * author says otherwise.
 *
 * `mins` is what every node contributes to the box around it, measured in
 * one pass by `contentSpan`. `floored` collects what was written so the next
 * measurement can take it back off — a floor left in place would be read
 * back as content that cannot give, and could then only ratchet upwards.
 *
 * A floor is written **unrounded**, and the measurement it came from ran
 * with the pixel grid off (`measuringExactly`) for the reason given there:
 * rounding a floor grows the tree a pixel per nesting level. What that
 * leaves is a sharp edge in yoga worth knowing about before writing a
 * measure function. A line whose items are all held at their floors is one
 * yoga freezes item by item, subtracting each item's shrink factor from the
 * line's total as it goes; the total only cancels to zero if the sizes add
 * up exactly in binary. Three items of, say, 239.28 in a column that
 * overflows do not, and yoga divides the overflow by the rounding residue
 * instead of skipping the division — the items come back a billion pixels
 * tall (issue #411). Whole pixels cancel exactly, which is why the text
 * measures here answer in them (`TextNode._trim`).
 */
function writeContentFloors(node, axis, mins, floored) {
  const axisIsMain = mainAxisOf(node) === axis;
  const own = axis === 'width' ? 'minWidth' : 'minHeight';
  for (const child of node.children) {
    if (!child.yoga || child.isWindow) continue;
    child.yoga.setFlexShrink(child.style.flexShrink ?? 1);
    if (child.style.display === 'none') continue;
    // A floor of 0 is what yoga does anyway, and an author who named their
    // own `minWidth`/`minHeight` has already answered — overwriting it would
    // put a measurement of ours above a number they wrote.
    const floor = mins.get(child) ?? 0;
    if (
      axisIsMain &&
      inFlow(child) &&
      floor > 0 &&
      typeof child.style[own] !== 'number'
    ) {
      if (axis === 'width') child.yoga.setMinWidth(floor);
      else child.yoga.setMinHeight(floor);
      floored.add(child);
    }
    writeContentFloors(child, axis, mins, floored);
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
function scaleWindowGeometry(props, scale) {
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

/**
 * Yoga's measure modes, in words. Indexed by the integer yoga hands a
 * measure function, so `MEASURE_MODES[widthMode]` is the name.
 *
 * The names are the public vocabulary (`measureContent`) and the integers
 * are not: an element that wrote `widthMode === 0` would be pinned to
 * yoga's ABI through us, which is exactly what the seam exists to stop.
 */
const MEASURE_MODES = [];
MEASURE_MODES[Yoga.MEASURE_MODE_UNDEFINED] = 'unconstrained';
MEASURE_MODES[Yoga.MEASURE_MODE_EXACTLY] = 'exactly';
MEASURE_MODES[Yoga.MEASURE_MODE_AT_MOST] = 'at-most';

/**
 * The pixels on offer on one axis, as a number an element can do arithmetic
 * with. Yoga says "no bound" with a null, so `Math.min(preferred, width)`
 * would answer 0 to the one question where the honest answer is `preferred`;
 * `Infinity` is what "no bound" means in that expression, and it makes the
 * mode something an element consults only when it has a reason to.
 */
function measureOffer(value, mode) {
  return mode === Yoga.MEASURE_MODE_UNDEFINED || !Number.isFinite(value)
    ? Infinity
    : value;
}

/** What a measure function answered, for the error that rejects it. */
function describeSize(size) {
  if (size === null || typeof size !== 'object') return String(size);
  return `{ width: ${size.width}, height: ${size.height} }`;
}

/**
 * Fit a natural size into what layout offered — the shape `<image>`, `<svg>`
 * and any other element whose content has a size of its own and an aspect
 * ratio to keep.
 *
 * **Which axes the style fixed is something layout already knows**, and says
 * in the measure modes: `'exactly'` on an axis means the style made it
 * definite. Working it out a second time by reading style back would be
 * duplication; working it out by reading *props* was issue #118 — `width` is
 * a style name, so `<image width={40}>` throws in development and only ever
 * reached that branch in production.
 *
 * - Both fixed: layout skips the measure entirely, so there is no
 *   fixed-size case to write here.
 * - Height fixed alone: scale the width with it, the way an `<img>` with
 *   only a height set does, rather than stretching to the container.
 * - Otherwise: natural size, shrunk to the width on offer, height following
 *   the aspect ratio.
 *
 * @param {{width: number, height: number}} natural the content's own size
 * @param {MeasureConstraints} constraints the argument of `measureContent`
 */
export function intrinsicSize(
  natural,
  { width, height, widthMode, heightMode },
) {
  const { width: natW, height: natH } = natural;
  if (heightMode === 'exactly' && widthMode !== 'exactly' && natH > 0) {
    return { width: (height * natW) / natH, height };
  }
  const w = width < natW ? width : natW;
  return { width: w, height: natW > 0 ? (w * natH) / natW : natH };
}

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

  /**
   * Device pixels per logical pixel for this node's connection — resolved
   * once by `createRoot` (src/scale.js) and constant for the node's life,
   * which is what makes the instance cache below sound. `this.style` and
   * `this.abs` are already device pixels; this is for the values that never
   * pass through a style — a paint constant like the caret's width, or an
   * event coordinate on its way back to logical. A registered element that
   * draws with its own constants multiplies them by this.
   */
  get scale() {
    return (this._scaleCache ??= scaleOf(this.app));
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
    this.root = null; // owning WindowNode once attached
    this.hidden = false;
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

  /**
   * Everything that paints or lays out reads `this.style`, never `this.props`
   * — props carry element semantics (`title`, `value`, geometry, handlers)
   * and style carries the CSS-like vocabulary, with no name shared between
   * them. `baseStyle` is the flattened `style` prop; `style` is that with
   * the active state blocks overlaid.
   */
  _syncStyle(props, mounting = false) {
    if (DEV && this.stylable) {
      assertNoFlatStyleProps(props, this.kind, this.semanticNames);
      validateStyle(flattenStyle(props.style), `<${this.kind} style>`);
    }
    this._baseStyle = this.stylable ? flattenStyle(props.style) : EMPTY_STYLE;
    this._usesTokens = this.stylable && styleUsesTokens(this._baseStyle);
    if (this._usesTokens) {
      const theme = this.theme;
      const strict = this.placed;
      const problems = strict ? [] : null;
      this._baseStyle = resolveTokens(
        this._baseStyle,
        theme,
        `<${this.kind} style>`,
        strict,
        problems,
      );
      if (problems?.length) this._tokenProblem(problems, mounting);
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
    // Attention candidates keep a registry for the same reason and are
    // registered the same unconditional way — a `<window>`'s own style is
    // resolved before `root` is assigned, so a "did it change" guard would
    // leave it unregistered forever. Unlike hover, attention is *matched*
    // against this set rather than hit-tested, so a node that is not in it
    // is not a candidate at all.
    const wantsAttention = Boolean(
      props.unstable_onAttention || this._baseStyle[':attention'],
    );
    this._wantsAttention = wantsAttention;
    if (this.root?._attentionNodes) {
      if (wantsAttention) this.root._attentionNodes.add(this);
      else this.root._attentionNodes.delete(this);
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
    // The scale multiplies *after* every merge — state blocks, queries,
    // the flex shorthand — so each of those keeps thinking in the logical
    // pixels the app wrote, and device pixels exist only downstream of
    // this line (src/scale.js).
    return this._retarget(
      scaleResolvedStyle(
        resolveComputedStyle(
          this._stateful
            ? resolveStyleStates(this._baseStyle, this.states)
            : this._baseStyle,
        ),
        this.scale,
      ),
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
    }
    // After the transitions, before the style is assembled: a loop that just
    // arrived contributes a value to this very swap, so the first frame the
    // bar is on screen already has it where the animation says rather than
    // where the resting style does.
    this._syncLoops(target);
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
    if (displayed.display !== this.style.display) {
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
        );
      }
    }
    return this.style;
  }

  _animatedValues() {
    const values = {};
    for (const [prop, a] of this._anim) values[prop] = a.value ?? a.from;
    return values;
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
        if (current?.loop && sameAnimation(current, spec)) continue;
        (this._anim ??= new Map()).set(spec.prop, {
          ...spec,
          loop: true,
          start: now(),
          value: animationValueAt(spec, 0),
        });
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
    if (running) this.root?._startAnimating(this);
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
    return !this._hiddenInTree();
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
    const before = this.style;
    for (const [prop, a] of this._anim) {
      if (a.loop) {
        // No end to test for and no rounding to accumulate: the phase is a
        // modulo of the elapsed time, so a bar that has been going for an
        // hour is exactly where the clock says.
        a.value = animationValueAt(a, now - a.start);
        if (isLayoutProp(prop)) layoutChanged = true;
        continue;
      }
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
      // the author asked for that by transitioning one (docs/styling.md) —
      // and a fresh set of content floors with it, since one of the
      // properties it can be animating is a padding the floors were measured
      // through
      if (this.root) {
        this.root.needsLayout = true;
        this.root._floorsDirty = true;
      }
    }
    // A tick writes `this.style` without going through `_retarget`, so it
    // owes the cascade the same notice — and it is the only thing that owes
    // it *per frame*: a transitioned `color` is a new ink every frame, for
    // this node and for everything inheriting from it.
    if (inheritedTextChanged(this.style, before)) this._retextSubtree();
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
    const next = scaleResolvedStyle(
      resolveComputedStyle(resolveStyleStates(this._baseStyle, this.states)),
      this.scale,
    );
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
    if (this._wantsAttention && this.root?._attentionNodes) {
      this.root._attentionNodes.add(this);
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
   * Which way this node reads: `'ltr'` or `'rtl'`, never `'inherit'` — this
   * is the *resolved* answer, which is what everything outside yoga needs.
   *
   * Yoga resolves the same question for the layout on its own, and does it
   * inside WASM where nothing can read it back (the binding has no
   * `getComputedDirection`). So it is resolved a second time here, over the
   * same rule, for everything the box tree does not answer: which side a
   * scrollbar sits on, which physical edge a `borderStartWidth` paints, which
   * way a popup flips, and the base direction a paragraph of neutral
   * characters resolves against.
   *
   * The rule, nearest first:
   *
   * 1. `direction` in this node's own style — CSS's property, and the one
   *    thing that means "this subtree, whatever is around it".
   * 2. otherwise the enclosing element's, which is what makes it inherit.
   * 3. otherwise the palette's, which is seeded from the locale — so an app
   *    started in an RTL locale is mirrored without being asked, and
   *    `<ThemeProvider value={{ direction }}>` is how one with a language
   *    menu says otherwise. The provider plants the matching style property
   *    as it goes, so rule 1 is what actually carries a mid-tree swap and
   *    this clause is only ever read at the top of the tree.
   *
   * Cached like `theme` and dropped by the same walk, since the two now move
   * together.
   */
  get direction() {
    if (this._direction !== undefined) return this._direction;
    const own = this.style.direction;
    return (this._direction =
      own === 'ltr' || own === 'rtl'
        ? own
        : this.parent
          ? this.parent.direction
          : this.theme.direction === 'rtl'
            ? 'rtl'
            : 'ltr');
  }

  /**
   * The resolved direction moved — because this node's style named a new one,
   * or because the palette under the whole tree did. Everything below
   * inherits it, so the caches go with it, and the walk stops where a
   * subtree states a direction of its own: nothing under that node can have
   * changed.
   *
   * A node that never resolved one has nothing cached below it either —
   * `direction` fills every ancestor on the way up — which is the same
   * early-out the text cascade takes.
   */
  _redirectSubtree() {
    if (this._direction === undefined) return;
    const before = this._direction;
    this._direction = undefined;
    if (this.direction === before) return;
    this._directionMoved();
    for (const child of this.children) child._redirectSubtree();
  }

  /**
   * What a direction change costs this node. The default is a repaint: the
   * *layout* has already been dealt with by yoga, which was told about the
   * style property directly, so what is left here is everything painted from
   * the resolved side — the scrollbar, a logical border, an icon.
   *
   * `TextNode` overrides it: a paragraph's base direction is part of how it
   * is shaped, so its cached layouts have to go.
   */
  _directionMoved() {
    this.root?.invalidate(false, this, 'direction');
  }

  /**
   * The text style this node inherits — **the enclosing element's**, and at
   * the top of the tree the palette's.
   *
   * The ink, the face and the size travel down the tree the way they do in
   * CSS: `<box style={{ color: theme.textMuted, fontSize: 12 }}>` is how a caption
   * block, a disabled row or a code panel is written, and it is what makes
   * `color` on a row reach the row's label without the row handing it over.
   * Only the properties in `INHERITED_TEXT_PROPS` travel; a style property on
   * the node itself still wins, the way it always has.
   *
   * Under the last element is the palette, and that floor is not a set of
   * constants either. The ink first: a `<text>` that never mentions a colour
   * has to be readable on the surface it is drawn on, and that surface
   * follows the desktop now. Black on `#1e2228` is invisible, which is the
   * whole bug. The face and the size for the same reason one step out — a
   * theme names `fontFamily` and `fontSize` because it is describing the type
   * this app sets, and the only way that can be true is if the text nobody
   * styled follows them.
   *
   * A detached node has no parent yet and so resolves against the floor;
   * `insertBefore` re-resolves the subtree against the real one.
   */
  get inheritedTextStyle() {
    if (this.parent) return this.parent.resolvedTextStyle();
    const theme = this.theme;
    const color = theme.text;
    // A palette can reach a node as a bare `theme` **prop** rather than a
    // resolved one — `<box theme={{ text: 'red' }}>` merges and derives
    // nothing (styling.md) — so neither of these is guaranteed to be there.
    const family = theme.fontFamily ?? DEFAULT_TEXT_STYLE.family;
    // The theme thinks in logical pixels like every style does, and this is
    // the one door its font size enters the cascade by: a node's own
    // `fontSize` was scaled at the style funnel, and every descendant
    // inherits an already-resolved (device) size — so multiplying here,
    // exactly once at the root of the cascade, is what keeps text and
    // layout in the same unit without ever double-scaling (src/scale.js).
    const size = (theme.fontSize ?? DEFAULT_TEXT_STYLE.size) * this.scale;
    const base = this._textBase;
    if (base?.color !== color || base.family !== family || base.size !== size) {
      this._textBase = { ...DEFAULT_TEXT_STYLE, color, family, size };
    }
    return this._textBase;
  }

  /**
   * Re-resolve this node's text style and pay for what moved.
   *
   * The cache is dropped rather than patched, and the *values* decide what
   * happens next: a node that names its own `color` and face absorbs an
   * ancestor's change entirely, which is what lets `_retextSubtree` stop
   * walking there. Returns the cost so it can.
   *
   * A node with no cached resolution has never been asked, and neither has
   * anything below it — `inheritedTextStyle` fills every ancestor on the way
   * up, so an empty cache here proves an empty cache in the whole subtree.
   * That is the early-out that keeps a hover on one row from touching a
   * window's worth of nodes.
   */
  _retext() {
    const before = this._resolvedText;
    if (before === undefined) return 0;
    this._resolvedText = undefined;
    const cost = resolvedTextDelta(before, this.resolvedTextStyle());
    if (cost !== 0) this._textStyleMoved(cost);
    return cost;
  }

  /** …and everything under it, stopping wherever the answer did not change. */
  _retextSubtree() {
    if (this._retext() === 0) return;
    for (const child of this.children) child._retextSubtree();
  }

  /**
   * This node's resolved text style moved — because its own style did, or
   * because an ancestor's did and it inherited the change.
   *
   * `TEXT_REMEASURE` means a glyph can have moved and the box has to be
   * measured again; `TEXT_REPAINT` means only the ink or the glyph rounding
   * did, so the cached layout still has to go — the value rides on the spans
   * inside it — but nothing reflows. Keeping those apart is the whole reason
   * a `:hover { color }` costs a repaint rather than a layout pass.
   *
   * The default serves any element that draws text: re-measure if it has a
   * size of its own, repaint otherwise. Elements that draw no text override
   * it away.
   */
  _textStyleMoved(cost) {
    if (cost === TEXT_REMEASURE && this._measureFn) {
      this.invalidateMeasure('text');
    } else {
      this.root?.invalidate(false, this, 'text');
    }
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

  /**
   * A `$token` this node's completed ancestry does not define.
   *
   * The default is `reportStyleError`: say so loudly, set `process.exitCode`,
   * and keep the property dropped. `REACT_X11_STRICT_TOKENS=1` makes it fatal
   * again, and then *where* the throw lands is the whole question — an error
   * boundary only catches what React invoked, on the fiber React thinks it
   * is working on.
   *
   * `mounting` is the attach walk, which runs inside `appendInitialChild`
   * while React is completing the nearest host *ancestor* — the `<window>`,
   * for a whole tree rendered at once. A throw there is attributed to the
   * window and sails past every boundary the app wrote inside it, which is
   * the bug this deferral exists for (#420). Stashed instead, and thrown
   * from `commitMount` on this node's own fiber, where the walk up finds a
   * boundary at any depth.
   *
   * Every other caller already has the right fiber (`commitUpdate`) or has
   * no React on the stack at all (`appearanceChanged`, from an X event) —
   * for those, throwing here is both the earliest and the only option, and
   * the second is the crash strict mode asked for.
   *
   * `commitMount` happens once per instance, so a node re-attached after it
   * has been and gone has nothing left to defer *to*; stashing there would
   * swallow the error instead of raising it late. Those throw at once, like
   * the keyed reorder they resemble.
   */
  _tokenProblem(problems, mounting) {
    if (!STRICT_TOKENS) {
      // every one of them: two misspellings in a style are two things to
      // fix, and a report that named only the first would send someone back
      // for a second run to find the second
      for (const message of problems) reportStyleError(this, message);
      return;
    }
    const error = new Error(problems[0]);
    if (mounting && this._tokenError === null) this._tokenError = error;
    else throw error;
  }

  /** The owning window resized: re-resolve, since a query block may now
   * match that did not, or the other way round. */
  _sizeQueriesChanged() {
    if (!(this._queried || this._supportsQueried) || this.destroyed) return;
    const before = this.style;
    // a query block may name `fontSize`, and `_syncStyle` → `_retarget` is
    // what pushes that into the subtree; only the node-local text props are
    // left to notice here
    this._syncStyle(this.props);
    if (localTextStyleChanged(this.style, before)) this._textContentChanged();
    if (this.yoga && this.style !== before) {
      applyLayoutStyle(this.yoga, this.style, before);
    }
  }

  /** The theme above or on this node changed: drop the caches and restyle
   * the subtree, since a token can appear at any depth.
   *
   * `mounting` is `insertBefore` attaching a subtree that has never been in
   * the tree: the walk still resolves every token — the nodes can see their
   * ancestors now — but it claims no damage (issue #402). A node that has
   * never painted has no stale pixels to cover, and the rect it is about to
   * occupy is claimed by the child-list/layout-diff protocol like any other
   * inserted child's; the unbounded claims below would turn every commit
   * that mounts a token-styled node into a full-window repaint — which is
   * every re-slice of a virtualized list whose rows follow the palette. A
   * live theme *swap* is the other caller and keeps them: it moves pixels
   * that are already on screen, anywhere in the subtree. */
  _themeChanged(mounting = false) {
    // This walk visits every node itself, so the per-node re-resolution below
    // is enough — a style swap it causes must not start a second walk of the
    // same subtree from halfway down.
    inThemeWalk++;
    try {
      this._theme = undefined;
      // The palette is the floor under the direction too, and this walk
      // already visits every node — so the cache is dropped here rather than
      // through `_redirectSubtree`, which would walk the same subtree again.
      const wasDirection = this._direction;
      this._direction = undefined;
      // A `<window>` with no `backgroundColor` of its own follows the palette,
      // and the server's copy of that colour has to follow with it — otherwise
      // the next resize fills the new area in the old scheme.
      if (this.isWindow) this._syncWindowBackground();
      if (this._usesTokens) {
        const before = this.style;
        this._syncStyle(this.props, mounting);
        // a token change reaches the node without React re-rendering it, so
        // the invalidation a commit would have done has to happen here too
        if (localTextStyleChanged(this.style, before)) {
          this._textContentChanged();
        }
        if (!mounting) this.root?.invalidate(true, null, 'theme');
      }
      // The palette is the floor under the cascade, so a theme swap moves the
      // resolved style of every node that named none of its own — and none of
      // that is in a style object, so nothing above would have noticed. A
      // swap that only changes `fontFamily` is the case that made this worth
      // having: nothing else about the node changes, and a cached layout
      // carries the face it was shaped with. `_retext` runs on a mount too —
      // its own claims are bounded — but cannot answer non-zero there: a
      // node that was never attached has never resolved a text style.
      if (this._retext() !== 0 && !mounting) {
        this.root?.invalidate(true, null, 'theme');
      }
      if (wasDirection !== undefined && this.direction !== wasDirection) {
        this._directionMoved();
      }
      for (const child of this.children) child._themeChanged(mounting);
    } finally {
      inThemeWalk--;
    }
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
    return Boolean(this.yoga && child.yoga && !child.isWindow);
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

  /**
   * Give this node's box a measure function, keeping a reference that can be
   * asked again later.
   *
   * A leaf's content is recorded nowhere but in its measure function, and
   * the size yoga keeps for it is not always what that function said:
   * `align-items` defaults to `stretch`, so in a pass run with no room on
   * offer — which is how a content floor is measured, see `contentSpan` —
   * the cross size a leaf ends up at is the container's, not its own. A
   * container in that position is recovered by looking inside it. A leaf
   * has nothing inside, so it is asked again instead.
   */
  _setMeasureFunc(measure) {
    this._measureFn = measure;
    this.yoga.setMeasureFunc(measure);
  }

  /**
   * Hand `measureContent` to layout, translated: the modes arrive as words,
   * an axis with no bound arrives as `Infinity` rather than as yoga's null,
   * and what comes back is checked before it can turn a whole tree into
   * NaNs. Called by the constructor, so an element only writes the method.
   */
  _useMeasureContent() {
    this._setMeasureFunc((width, widthMode, height, heightMode) => {
      const size = this.measureContent({
        width: measureOffer(width, widthMode),
        height: measureOffer(height, heightMode),
        widthMode: MEASURE_MODES[widthMode],
        heightMode: MEASURE_MODES[heightMode],
      });
      if (!Number.isFinite(size?.width) || !Number.isFinite(size?.height)) {
        // Left to itself this is a destructuring TypeError from inside
        // yoga's wrapper, or — worse, because it does not throw at all — a
        // NaN that spreads through every ancestor's rect.
        throw new Error(
          `react-x11: <${this.kind}>.measureContent() must return ` +
            '{ width, height } as finite numbers; it returned ' +
            `${describeSize(size)}. Return { width: 0, height: 0 } for ` +
            'content that has not arrived yet.',
        );
      }
      return size;
    });
  }

  /**
   * The inputs to `measureContent` changed — a prop it reads, data that
   * loaded — so the next layout has to ask again instead of reusing the
   * answer it cached.
   *
   * `reason` joins the closed set the diagnostics print (docs/debugging.md);
   * the default says the measurement itself moved.
   */
  invalidateMeasure(reason = 'measure') {
    // Nothing to re-ask, and both halves matter: layout aborts the process
    // on a node that never had a measure function, and a destroyed node's
    // box has already been freed under it.
    if (this.destroyed || !this._measureFn) {
      // Said once, in development: an element that asks for a re-measure and
      // silently gets none looks broken rather than degraded, and there is
      // nothing in the frame to pull on.
      if (DEV && !this.destroyed && !this._measureNagged) {
        this._measureNagged = true;
        console.warn(
          `react-x11: <${this.kind}>.invalidateMeasure() has nothing to ` +
            're-measure — this element implements no measureContent(). ' +
            'Note it has to be a method on the class: assigning it in the ' +
            'constructor is too late, since the base Node constructor is ' +
            'what wires it to layout.',
        );
      }
      return;
    }
    this.yoga.markDirty();
    this._invalidateLayout(reason);
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
    // read and nodes.js keeps not importing it.
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
    }
    child._setRoot(this.root);
    child._registerSizeQueries();
    // it can see its ancestors now, so any token in its style can resolve.
    // With no theme anywhere there is nothing to resolve and nothing to walk
    if (this.theme || child.props.theme) child._themeChanged(mounting);
    this._textContentChanged();
    this._childListChanged(before);
    a11yHooks.attached?.(this, child);
  }

  /**
   * Is this node a scroll container that has a blit armed and still clean
   * this frame (issue #398)?
   *
   * While it is, the window keeps a *ledger* of the regions that actually
   * changed inside the viewport instead of cancelling the blit at the first
   * sign of one. The coarse claims this node would otherwise make — its own
   * box, which is all `paintBounds()` can say for a node that clips — would
   * cover the whole band the blit is about to move and throw that ledger
   * away, so the paths that make them take a finer route while this is true.
   *
   * `scrollContents` is out: an element blit already tests foreign claims
   * against the rect it handed over (issue #309), and its region is not a
   * viewport whose children *are* the scrolled content.
   */
  _blitLedgerOpen() {
    const from = this._pendingBlitFrom;
    return (
      from != null &&
      from !== BLIT_POISONED &&
      !this._pendingBlitContents &&
      this._blitLedger != null
    );
  }

  /**
   * Write one changed region into this viewport's ledger, in the coordinates
   * it was named in. Returns false when the frame is better off repainting
   * the viewport — too many regions to be worth the bookkeeping, or one big
   * enough that there is nothing left for the blit to keep — which the
   * caller turns into the poison the gate used to apply unconditionally.
   *
   * Which side of the frame's layout pass the rect came from decides
   * whether it moves with the blit: a claim made during the commit names
   * where the content sits *now*, and the blit is about to shift it, so
   * `_applyScrollBlits` shifts the rect too. A claim raised once layout has
   * run — the diff's, the reflow queue's — already names where it landed.
   * Read off the window rather than passed in, so a claim from application
   * code reached during the layout pass is filed on the right side of it.
   */
  _recordBlitClaim(rect) {
    const ledger = this._blitLedger;
    if (!ledger || ledger.length >= BLIT_MAX_CLAIMS) return false;
    const inside = intersectRects(rect, this.abs);
    // beside the band the blit moves: those pixels are painted the ordinary
    // way, out of the frame's own damage
    if (!inside) return true;
    // …and a claim that covers the viewport leaves the blit nothing to keep
    if (rectContains(inside, this.abs)) return false;
    ledger.push({ ...inside, pre: !this.root?._laidOut });
    return true;
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
    // a surface that goes away takes its selection with it, and the app-wide
    // claim on being the one showing one goes with it too
    this._textSelection?.destroy();
    if (this.hasOwnSelection) dropVisibleSelection(this);
    for (const child of this.children) child.destroySubtree();
  }

  _setRoot(root) {
    if (this.root === root) return;
    this.root = root;
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
    // `abs` is device pixels; this is public API, which is logical — the
    // same conversion events make on the way out (src/scale.js)
    const s = this.scale;
    return [
      {
        x: r.x / s,
        y: r.y / s,
        left: r.x / s,
        top: r.y / s,
        width: r.width / s,
        height: r.height / s,
        right: (r.x + r.width) / s,
        bottom: (r.y + r.height) / s,
      },
    ];
  }

  /**
   * React Native's measure contract, which is what DevTools' style editor
   * calls to draw the box model beside the style it is editing:
   * `(x, y, width, height, left, top)` — position within the parent, size,
   * then position within the window. A node with no laid-out rect calls
   * back with nothing, the "unmeasurable" answer the editor checks for.
   */
  measure(callback) {
    if (typeof callback !== 'function') return;
    const r = this.abs;
    if (!(r.width > 0 || r.height > 0)) {
      callback();
      return;
    }
    const s = this.scale;
    const parent = this.parent?.abs;
    callback(
      (parent ? r.x - parent.x : r.x) / s,
      (parent ? r.y - parent.y : r.y) / s,
      r.width / s,
      r.height / s,
      r.x / s,
      r.y / s,
    );
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
    // before the yoga check, so a span — placed by its paragraph, no box of
    // its own — counts as on screen too
    this._placed = true;
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
      const shift = layoutDiffShift;
      const had = old.width > 0 && old.height > 0;
      if (shift) {
        // Riding a blit (issue #398): the rect this node *would* have had if
        // nothing but the scroll had happened. Landing there is the blit's
        // own translation and claims nothing — claiming it would repaint the
        // band the blit exists to keep. Landing anywhere else is a real move,
        // and both ends of it are claimed in post-blit coordinates, which is
        // where the frame will paint them.
        const was = {
          x: old.x + shift.x,
          y: old.y + shift.y,
          width: old.width,
          height: old.height,
        };
        if (
          had &&
          was.x === x &&
          was.y === y &&
          old.width === width &&
          old.height === height
        ) {
          return;
        }
        if (had) layoutDiffSink(insetRect(was, -grow));
        if (width > 0 && height > 0) {
          layoutDiffSink(insetRect(this.abs, -grow));
        }
        return;
      }
      if (had) {
        layoutDiffSink(insetRect(old, -grow));
      }
      if (width > 0 && height > 0) {
        layoutDiffSink(insetRect(this.abs, -grow));
      }
    }
  }

  /**
   * Move an already-laid-out subtree by a constant, without asking yoga
   * anything — the scroll fast path's walk (issue #405).
   *
   * A pure-scroll frame changes nothing about the arrangement inside a
   * viewport: every descendant sits exactly where the last pass put it,
   * shifted by the scroll delta. `absolutize` would re-derive each rect
   * through four wasm-boundary getters to learn what one addition already
   * says, so the scroller calls this instead — only after proving nothing
   * inside was laid out this pass (see `_absolutizeChildren`).
   *
   * `abs` is adjusted in place rather than replaced: its identity is
   * already long-lived (`_assignAbs` keeps the object whenever a rect is
   * unchanged), and everything that records a rect for later copies it.
   * The cached hit bounds ride along instead of being dropped — a uniform
   * translation is the one change a cached union survives — which keeps a
   * wheel flick from rebuilding the pane's whole hit-bounds tree per notch.
   *
   * No layout diff runs here, and none is owed: under a blit ledger the
   * shifted diff's claims are the *deviations* from exactly this
   * translation, and a subtree nothing laid out again has none.
   */
  _shiftAbs(dx, dy) {
    if (!this.yoga) return;
    const abs = this.abs;
    abs.x += dx;
    abs.y += dy;
    const b = this._hitBoundsCache;
    if (b) {
      b.left += dx;
      b.right += dx;
      b.top += dy;
      b.bottom += dy;
    }
    this._shiftChildren(dx, dy);
  }

  /** Split from `_shiftAbs` so a scroller can reroute its children through
   * its own offset bookkeeping — the box moves rigidly, but the children's
   * origin also carries scroll offsets that may have changed again this
   * same frame (`Scrollable._shiftChildren`). */
  _shiftChildren(dx, dy) {
    for (const child of this.children) {
      if (!child.isWindow) child._shiftAbs(dx, dy);
    }
  }

  /**
   * A layout-affecting change at this node may change how far the content
   * of an enclosing scroll pane reaches through a route yoga never
   * witnesses — an element that paints its own content growing its extent
   * announces it with `invalidate(true, this, 'scroll')`
   * (docs/extending.md), and no yoga node is dirtied by that. Mark every
   * scroller whose measurement can see this node, so the next pass asks
   * `measureScrollContent` again instead of reusing the cached reach
   * (issue #405). The walk stops where the measurement does: at the first
   * ancestor that clips its children, whose overflow is its own business.
   */
  _markScrollMeasureDirty() {
    for (let n = this; n; n = n.parent) {
      // only a Scrollable carries the flag; a stale `true` on a box that is
      // not currently a scroller costs nothing and re-measures correctly if
      // its style later makes it one
      if (n._scrollMeasureDirty === false) n._scrollMeasureDirty = true;
      if (n !== this && n.clipsChildren()) return;
    }
  }

  /**
   * Ask the owning window to repaint. The damage lives on the window node,
   * which is the only node with a frame clock — this forwards there, so an
   * element says `this.invalidate(false, this, 'props')` and never has to
   * know that. Overridden by WindowNode, which *is* the collector.
   *
   * `damage` is the node or rect that changed. Passing one is the difference
   * between repainting a control and repainting the window, and `this` is
   * almost always the right answer (docs/extending.md). Before the node is
   * attached there is no window and nothing on screen, so this is a no-op —
   * the mount invalidates in full anyway.
   */
  invalidate(layoutChanged = false, damage = null, reason = null) {
    // a layout change may grow what an enclosing scroll pane has to scroll,
    // through a route yoga never sees (issue #405)
    if (layoutChanged) this._markScrollMeasureDirty();
    this.root?.invalidate(layoutChanged, damage, reason);
  }

  /**
   * The rect this paint pass is repainting, or null when it is repainting
   * the whole window — and null outside a paint, which reads the same way:
   * nothing is bounding you, so draw everything (issue #301).
   *
   * The other end of `invalidate`. A frame repaints one damage rect per
   * pass, clipped to it and with whole subtrees outside it culled, so an
   * element whose node *is* one node — a `<box>`, a `<text>` — never needs
   * this: being painted at all already means it is inside. An element that
   * draws a **scene** into one node does: without it, a `<flow>` handed a
   * pass over the 80×40 box a dragged node moved through redraws all three
   * hundred nodes, all seven hundred edges, the grid and the minimap into a
   * clip that throws almost all of it away. With it, the element culls the
   * same way core culls the tree.
   *
   * Window coordinates, the same space as `abs`, `contentBox()` and an
   * event's `x`/`y`. Read-only, like `abs`: it is this frame's own rect and
   * the clip is already set from it.
   *
   * Never inside `paintCached`, which draws into a surface in its own
   * coordinates: a cached copy culled against the window's damage is stored
   * half-drawn under a key claiming it is whole, and every later frame that
   * hits the key gets the hole.
   */
  paintDamage() {
    return this.root?._paintDamage ?? null;
  }

  /**
   * "The pixels in `rect` moved by (dx, dy); the rest of it is new" — the
   * public form of the dance `<box overflow="scroll">` has been doing since
   * issue #138, for an element with a viewport of its own (issue #303).
   *
   * A pan is a scroll in every way but the bookkeeping: it translates every
   * pixel of the pane, so an element that can only say "everything changed"
   * repaints the lot, sixty times a second, for a frame whose content is
   * already on screen one shift away. This claims `rect` — the conservative
   * answer, and the one that stands if anything below declines — and arms
   * the frame to blit instead: at frame time core asks ntk to move the
   * surviving band inside the backing store (`Window.scrollRegion`) and
   * **narrows this claim to the band the shift exposed**, which is what
   * `paintDamage()` then hands the paint. So the element draws the strip and
   * nothing else, without ever asking whether the blit happened.
   *
   * `dx`/`dy` are **how far the pixels moved**, the sense `Surface.copyWithin`
   * and `Window.scrollRegion` use rather than a scroll offset's — panning a
   * graph right by 10 is `dx: 10`, and the exposed band is down the left
   * edge. Whole pixels, both of them, and `rect` in window coordinates
   * (`abs`, `contentBox()`, an event's `x`/`y`) and inside this node.
   *
   * The element promises one thing in return: that inside `rect` the frame
   * really is that translation and nothing else. Every other way it could be
   * false is core's to check — a claim from anywhere else reaching into the
   * rect, a sibling drawing over it, a child of this node laid out on top of
   * it, an ancestor's border ring or rounded corner, a layout pass that
   * moved something — and each of them falls back to repainting the rect,
   * which is the behaviour without this call at all.
   *
   * All of those are about `rect`, not about this node (issue #309). An
   * element with furniture pinned to a corner of its pane — a minimap, zoom
   * controls, a HUD strip that has to repaint on a pan frame and whose
   * pixels must not ride the blit — carves it out of the region it shifts
   * and claims it as ordinary damage. Those claims land beside the rect and
   * the frame stays a blit.
   *
   * Returns whether the frame is still a blit candidate. The real answer
   * arrives as `paintDamage()`, because most of the gates cannot be decided
   * until the frame closes; a `false` here is only the ones that can.
   */
  scrollContents(rect, dx, dy) {
    const root = this.root;
    if (
      !root ||
      this.destroyed ||
      !rect ||
      !(rect.width > 0) ||
      !(rect.height > 0)
    ) {
      return false;
    }
    // Nothing moved, so there is nothing to claim either — an element
    // rounding a gesture to whole pixels lands here on most events.
    if (!dx && !dy) return true;
    const pending = this._pendingBlitContents;
    // The rect has to be the same one all frame: two different regions of
    // one node shifting by different deltas is not one CopyArea, and the
    // second claim would coalesce into the first past the point either can
    // be told apart. Same for a Scrollable element that also scrolls its
    // offsets this frame — two shifts of the same pixels, and a frame can
    // only have one.
    if (
      this._pendingBlitFrom != null &&
      (!pending ||
        pending.rect.x !== rect.x ||
        pending.rect.y !== rect.y ||
        pending.rect.width !== rect.width ||
        pending.rect.height !== rect.height)
    ) {
      this._pendingBlitFrom = BLIT_POISONED;
    } else if (this._pendingBlitFrom == null && Array.isArray(root._damage)) {
      // Arming is the one moment the evidence still exists — the claim
      // below coalesces earlier ones into itself, after which a change
      // inside the rect is indistinguishable from this call's own claim.
      // The same reasoning, and the same poison rather than a disarm, as
      // scrollTo (react-x11#295).
      //
      // The zone is `rect` itself, where scrollTo's is the viewport plus
      // slop (issue #309): the claim recorded below *is* this rect, so a
      // claim it could swallow has to overlap it, and every claim carries
      // its own slop already — `paintBounds` inflates a node's region by
      // `DAMAGE_SLOP` on every side, so ink that bleeds into `rect` is
      // claimed overlapping it. Furniture *beside* the rect — a minimap in
      // a corner the element carved out and repaints itself — is not a
      // change to the pixels about to move.
      for (const claimed of root._damage) {
        if (rectsOverlap(claimed, rect)) {
          this._pendingBlitFrom = BLIT_POISONED;
          break;
        }
      }
    }
    const state = (this._pendingBlitContents ??= {
      // our own copy: the caller's rect is very often the live
      // `contentBox()` of a node that is about to be laid out again
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      dx: 0,
      dy: 0,
    });
    // several pans in one frame blit once, by the net shift — the same
    // coalescing scrollTo gets from recording an origin
    state.dx += dx;
    state.dy += dy;
    this._pendingBlitFrom ??= BLIT_CONTENTS;
    (root._pendingScrolls ??= new Set()).add(this);
    // ...and the claim about to be recorded is the shift itself, not a
    // reason to un-blit it. `state.rect` by identity, so a second call this
    // frame is recognised as the same claim rather than as foreign damage.
    root._scrollClaim = state.rect;
    root.invalidate(false, state.rect, 'scroll');
    root._scrollClaim = null;
    return this._pendingBlitFrom !== BLIT_POISONED;
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
    this._markScrollMeasureDirty();
    const root = this.root;
    if (!root) return;
    // Same walk, same frame, same answer — see `_childListBefore`, whose
    // record this shares so that a reflow and a child-list change on one
    // node in one frame walk the subtree once between them.
    root.invalidate(true, this._childListBefore(), reason);
    root._reflowed.add(this);
  }

  /**
   * `paintBounds()` with the one clip a damage claim must respect: a scroll
   * container above this node that is waiting to blit (issue #398).
   *
   * A viewport clips its children, so the part of a claim outside its box is
   * pixels that cannot appear — and leaving it in costs the blit the frame.
   * A virtualized list is the shape that makes this concrete: its spacers
   * are boxes thousands of pixels tall whose visible extent is a sliver or
   * nothing at all, and their unclipped claims, coalesced into the scroll's
   * own, leave `_blitKeptDamage` a damage rect many times the viewport to
   * refuse. Null when the clip left nothing.
   *
   * Only while a blit is pending — outside that this is `paintBounds()` and
   * one property read. Clipping every claim to every clipping ancestor
   * would be correct too, and is a bigger change than the frame this is
   * about.
   */
  _claimBounds() {
    const bounds = this.paintBounds();
    const sv = this._blitViewport();
    return sv ? intersectRects(bounds, sv.paintBounds()) : bounds;
  }

  /** The scroll container above this node that is waiting to blit, if there
   *  is one — the viewport whose ledger this node's claims belong in, and
   *  whose box clips them (issue #398). One property read when no blit is
   *  pending, which is every frame that is not a scroll. */
  _blitViewport() {
    if (!this.root?._pendingScrolls?.size) return null;
    for (let n = this.parent; n; n = n.parent) {
      if (n._blitLedgerOpen()) return n;
    }
    return null;
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
   * every bound built from here. That matters most for a scrolling box, whose
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
   * This node's own rect, grown by anything it draws outside it — the
   * outline and the shadow, the only two. Per node rather than once at the
   * top, because either can belong to any node and the bound has to cover it
   * wherever it is; and the outline is counted even when the ring is
   * currently *off*, because the frame that erases it is claimed after the
   * state has already flipped back.
   *
   * A shadow cannot afford that trick — its extent is whatever the style
   * says rather than a theme constant, so inflating for one that is not
   * there would widen the claim of every node that has ever hovered. The
   * frame that *removes* a shadow claims the old extent from `_retarget`
   * instead, where both the old style and the new one are in hand.
   */
  _ownPaintBounds() {
    const extent = Math.max(this._outlineExtent(), this._shadowExtent());
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
  _outline(style = this.style) {
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
  _outlineExtent(style = this.style) {
    if (style.outlineWidth === undefined && !this.states[':focus-visible'])
      return 0;
    const outline = this._outline(style);
    return outline ? outline.width + Math.max(0, outline.offset) : 0;
  }

  /**
   * How far outside `abs` this node's `boxShadow` reaches — the offset, the
   * spread and the blur's tail, symmetrically (see `shadowExtent`).
   */
  _shadowExtent() {
    return shadowExtentOf(this.style, this.scale);
  }

  /** Would a keyboard focus land here? The one rule lives in a11y.js —
   * `EventManager._isFocusable` and the AT-SPI FOCUSABLE state read the
   * same function, so the ring, the keyboard and the screen reader cannot
   * disagree. */
  _focusableForRing() {
    return Boolean(a11yFocusable(this));
  }

  /**
   * The rectangle this node's **content** goes in — `abs` inset by the
   * border and the padding, in the owning window's coordinates. Every text
   * element in core paints inside it, and so should anything a registered
   * element draws that the padding is meant to hold off.
   *
   * Public (docs/extending.md) because the arithmetic is not reproducible
   * from `this.style`: the insets come off the yoga node, which is where
   * percentages, the per-side overrides and the border widths have already
   * been resolved against this frame's size. An element deriving them from
   * the style bag instead re-implements a resolution order it cannot see,
   * and silently disagrees with `<text>` the day the vocabulary grows
   * another edge — the per-side border widths (#262) were the last one.
   */
  contentBox() {
    // A node with no yoga node (`{ yoga: false }`) has no resolved insets,
    // so its box is its content box.
    if (!this.yoga) return { ...this.abs };
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

  /**
   * The text style this node resolves to, in the shape `app.fonts.layout`
   * takes as its base: `{ family, size, weight, style, variations,
   * textRendering, color }`. `<text>`, `<textinput>` and the document views
   * draw with exactly this, and an element that draws text of its own is
   * asking the same question they are.
   *
   * Two things are folded in that `this.style` does not carry. The palette
   * is under it — `text`, `fontFamily` and `fontSize` are the ink, the face
   * and the size of everything that named none of its own (styling.md) — so
   * an element reading its own style alone is one whose app can say
   * `<ThemeProvider value={{ fontFamily: 'Inter' }}>` and watch it reach
   * every built-in label and stop at this one. And the bag is spelled ntk's
   * way rather than the style vocabulary's (`family`, not `fontFamily`;
   * `variations`, not `fontVariationSettings`), which is a mapping worth
   * having in one place instead of vendored per element.
   *
   * **Cached**, and the cache is the cascade's spine: asking here fills every
   * ancestor's on the way up, which is what lets an invalidation walk stop at
   * a node that never resolved (`_retext`). Everything that can move the
   * answer drops it — a style swap (`_retarget`), an animation tick, a theme
   * change, an attach — so an element may keep reading it at paint time.
   */
  resolvedTextStyle() {
    return (this._resolvedText ??= textStyleFrom(
      this.style,
      this.inheritedTextStyle,
    ));
  }

  // --- the text an element answers for (issue #259) ------------------------
  //
  // Four questions, in one index space and one coordinate space: characters
  // are **code points** (an emoji is one position, not two — the space ntk's
  // caret API speaks), and rectangles are in the owning window's coordinates,
  // the same ones `abs`, `contentBox()` and a mouse event's `x`/`y` are in.
  //
  // They are what a selection is made of, and the reason they are on `Node`
  // rather than on `<text>`: the selection service walks a subtree and asks,
  // so an element that answers them joins a document without core knowing it
  // exists. The defaults are the honest answers for an element with no text
  // — a `<box>` has none, and `null` says so rather than claiming an empty
  // string sits somewhere inside it.

  /** This element's text, or null when it has none — the string the three
   * accessors below index into. */
  textContent() {
    return null;
  }

  /** The character boundary nearest a point, in window coordinates. Clamps,
   * so a point past the end of the text answers with the end of it. */
  textIndexAt(x, y) {
    return 0;
  }

  /** Where a caret at this index would stand, in window coordinates — a
   * zero-width rect from the top of the glyphs to the bottom of them. */
  textCaretRect(index) {
    return null;
  }

  /**
   * The bands a highlight over `[start, end)` fills, in window coordinates:
   * one per line, and more than one on a line whose text changes direction
   * halfway across it. Empty when the range is empty or off the end.
   */
  textRangeRects(start, end) {
    return [];
  }

  /**
   * The part of this element's text the document selection covers, as
   * `{ start, end }` in code points, or null. An element that paints its own
   * text paints a band under it while this is set — `textRangeRects` gives
   * the rectangles and `selectionColor` the fill — and that is the whole of
   * taking part in a selection. `<text>` keeps no more state than this.
   */
  get selectionRange() {
    return this._selRange
      ? { start: this._selRange.start, end: this._selRange.end }
      : null;
  }

  /** What to fill `textRangeRects` with while `selectionRange` is set: the
   * surface's `selectionColor`, or the theme's accent tinted. */
  get selectionColor() {
    return this._selRange?.color ?? null;
  }

  // --- being a selection surface -------------------------------------------

  /** `selectable` arrived or left. `true` makes this element the surface a
   * drag inside it selects across; `false` opts its subtree out of the one
   * above it, and is read where the surface is looked up. */
  _syncSelectable(props) {
    const wanted = props.selectable === true;
    if (wanted === Boolean(this._textSelection)) return;
    if (wanted) {
      this._textSelection = new TextSelection(this);
      // The I-beam is what says the text here can be taken. A surface is
      // also a focus target — a11y.js reads the same prop — because Ctrl+C
      // is a keystroke and a keystroke has to arrive somewhere.
      this.defaultCursor ??= 'text';
    } else {
      this._textSelection.destroy();
      this._textSelection = null;
      if (this.defaultCursor === 'text') this.defaultCursor = undefined;
    }
  }

  /**
   * The document selection this element owns, or null: a snapshot of
   * `{ isCollapsed, text, ranges }`, not a live object.
   *
   * Named for the text rather than called `selection`, because a base class
   * that claims a plain noun claims it from every element built on it — and
   * `this.selection = ...` in a subclass constructor is then a TypeError
   * against a getter, which is a bad way to find out.
   */
  get textSelection() {
    const selection = this._textSelection;
    if (!selection) return null;
    return {
      isCollapsed: selection.isCollapsed,
      text: selection.text(),
      ranges: [...selection.ranges].map(([node, [start, end]]) => ({
        node,
        start,
        end,
      })),
    };
  }

  /** Select everything in this surface, and take PRIMARY with it. */
  selectAll() {
    this._textSelection?.selectAll();
    return this;
  }

  /** Drop the selection in this surface. PRIMARY is left where it is: the
   * text stays pasteable, which is what every other X client does. */
  clearSelection() {
    this._textSelection?.clear();
    return this;
  }

  /** What a copy would put on the clipboard. */
  selectedText() {
    return this._textSelection?.text() ?? '';
  }

  /** Set both ends by hand — `{ node, index }` each, indices in code points.
   * `setSelection(null)` is `clearSelection()`. */
  setSelection(anchor, focus = anchor) {
    this._textSelection?.setSelection(anchor, focus);
    return this;
  }

  /** Another surface is showing the app's selection now. */
  _selectionLost() {
    this._textSelection?.lost();
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

  paint(ctx) {
    if (this.hidden) return;
    // Outside the box and under everything, which is the whole of what makes
    // a shadow different from a colour: it is drawn before this node's own
    // background so a translucent background does not sit on top of it, and
    // it inks pixels this node does not own — see `_ownPaintBounds`.
    this._paintShadow(ctx);
    this._paintBackground(ctx);
    // The paint cache covers a node's *content* — the expensive part — and
    // not its box: background and border are one composite each, and keeping
    // them out keeps their styles out of the key. A node that does not
    // implement the protocol has no `paintCachePlan` and pays one property
    // lookup for the privilege.
    const cache = this.paintCachePlan && this.root?._paintCache;
    if (cache) cache.paint(this, ctx);
    else this.paintContent(ctx);
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
    roundedPath(ctx, this.abs, radius);
  }

  _paintBackground(ctx) {
    const { backgroundColor, borderRadius = 0 } = this.style;
    const fill = (style) => {
      ctx.fillStyle = style;
      if (borderRadius > 0) {
        this._roundedPath(ctx, borderRadius);
        ctx.fill();
      } else {
        ctx.fillRect(this.abs.x, this.abs.y, this.abs.width, this.abs.height);
      }
    };
    if (isPaintedColor(backgroundColor)) fill(backgroundColor);
    // …and the gradient over it, which is CSS's order and not a detail: a
    // translucent gradient over a solid colour is how a tint is written, and
    // a node that sets only the gradient pays one composite either way.
    const gradient = this._backgroundGradient(ctx);
    if (gradient) fill(gradient);
  }

  /**
   * The `backgroundImage` gradient for this node's current box, as the ntk
   * `CanvasGradient` a fill style takes — or null when there is none, when
   * the box has no area, or when the context cannot make one (the headless
   * mock).
   *
   * Cached on the node and keyed by the value *and the rect*, because the
   * coordinates are absolute. They have to be: a gradient created after a
   * `translate()` ignores the transform (sidorares/ntk#271), and the drawn
   * layer paints in window coordinates anyway, so there is no translation to
   * be wrong about — the cost is that a node which moves rebuilds its
   * gradient, which is one small request and a picture the GC reclaims
   * through ntk's finalizer. Headers, cards and rows are the customers here
   * and they move on layout, not on input.
   */
  _backgroundGradient(ctx, rect = this.abs) {
    const value = this.style.backgroundImage;
    if (!value || value === 'none') return null;
    if (typeof ctx.createLinearGradient !== 'function') return null;
    const spec = gradientSpec(value, this.scale);
    if (!spec) return null;
    const { x, y, width, height } = rect;
    const key = `${value}|${x},${y},${width},${height}`;
    if (this._gradient?.key === key) return this._gradient.value;
    const line = linearGradientGeometry(spec, rect);
    if (!line) return null;
    const gradient = ctx.createLinearGradient(
      line.x0,
      line.y0,
      line.x1,
      line.y1,
    );
    for (const [offset, color] of line.stops)
      gradient.addColorStop(offset, color);
    this._gradient = { key, value: gradient };
    return gradient;
  }

  /**
   * `boxShadow`. Back to front, like CSS: the first shadow in the list is
   * the nearest the viewer, so the list is walked in reverse.
   *
   * A shadow with no blur is a rounded rectangle and costs one composite. A
   * blurred one is coverage — an a8 surface holding the rectangle, blurred
   * server-side by RENDER's convolution filter and then painted *through*
   * the shadow colour, which is the same trick the glyph cache and `<canvas
   * mono>` run on. That is what keeps the colour out of the cache key, so a
   * `:hover` that only darkens the shadow reuses the surface it already
   * rendered.
   */
  _paintShadow(ctx) {
    const value = this.style.boxShadow;
    if (!value || value === 'none') return;
    const shadows = shadowSpecs(value, this.scale);
    if (!shadows?.length) return;
    const radius = this.style.borderRadius ?? 0;
    for (let i = shadows.length - 1; i >= 0; i--) {
      const shadow = shadows[i];
      // CSS's `currentColor`: this node's *resolved* ink, its own `color`
      // over what it inherits — so a shadow written without a colour follows
      // the text it sits under, including down a `:hover` that dims both
      const color = shadow.color ?? this.resolvedTextStyle().color;
      if (!isPaintedColor(color)) continue;
      const rect = {
        x: this.abs.x + shadow.dx - shadow.spread,
        y: this.abs.y + shadow.dy - shadow.spread,
        width: this.abs.width + shadow.spread * 2,
        height: this.abs.height + shadow.spread * 2,
      };
      if (!(rect.width > 0) || !(rect.height > 0)) continue;
      // the spread grows the corner with the box, the way CSS's does
      const r = Math.max(0, radius + shadow.spread);
      if (!(shadow.blur > 0)) {
        ctx.fillStyle = color;
        roundedPath(ctx, rect, r);
        ctx.fill();
        continue;
      }
      this._paintBlurredShadow(ctx, rect, r, shadow.blur, color);
    }
  }

  /**
   * One blurred shadow, through the paint cache when there is one.
   *
   * The surface is the shadow's rectangle plus `pad` on every side, and the
   * padding is load-bearing: a convolution reads outside the picture as
   * transparent, so a kernel that runs off the edge ends the shadow in a
   * straight line. `blurKernel` takes that reach from the same function
   * ntk builds the kernel with, so the two cannot drift apart.
   *
   * The blur is **baked into the pixels** by `blurCoverage` (ntk 8.6,
   * ntk#335) rather than set as a filter on the picture. That is the
   * difference between a cached shadow and a cached shadow that costs
   * nothing to draw: a picture's filter is re-applied by the server on every
   * composite, so the entry would hit, re-render nothing, and still pay its
   * whole kernel every frame — 244M multiply-accumulates for one card-sized
   * shadow, which was 1.6s per `:hover` on XQuartz. Baked, what the cache
   * holds composites as an ordinary mask however wide the blur was, and the
   * two separable passes run once per distinct geometry.
   *
   * `maxPixels` is raised well above the cache's default: a card's shadow is
   * as big as the card, an entry for one is a8 (a byte a pixel), and the
   * thing being avoided is exactly the cost the default cap bounds
   * elsewhere.
   */
  _paintBlurredShadow(ctx, rect, radius, blur, color) {
    const { sigma, pad } = blurKernel(blur);
    // integral, because the surface is pixels; the blur is far wider than
    // the rounding, so nothing about the result is visibly quantized
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);
    const plan = {
      key: `shadow|${width}x${height}|r${radius}|b${blur}`,
      x: Math.round(rect.x) - pad,
      y: Math.round(rect.y) - pad,
      width: width + pad * 2,
      height: height + pad * 2,
      format: 'a8',
      tint: color,
      maxPixels: 1024 * 1024,
      // Cache on the first sighting rather than the second: what the gate
      // saves elsewhere is a cheap redraw, and what it costs here is a whole
      // gaussian — the one thing this entry exists to avoid running twice.
      eager: true,
      draw: (sctx, box) => {
        // full coverage: the colour arrives at composite time
        sctx.fillStyle = '#ffffff';
        roundedPath(
          sctx,
          { x: box.x + pad, y: box.y + pad, width, height },
          radius,
        );
        sctx.fill();
      },
      after: (surface) => ntk.blurCoverage(surface, sigma),
      live: () => this._paintShadowLive(ctx, plan),
    };
    const cache = this.root?._paintCache;
    if (cache) cache.drawing(ctx, plan);
    else this._paintShadowLive(ctx, plan);
  }

  /**
   * The same drawing with no cache behind it — the paint-cache-disabled
   * build, an entry too big for the budget, and the first frame of a shadow
   * the cache has only seen once. A surface per frame is what a shadow costs
   * without a cache; it is still one composite on the wire, and the
   * alternative is not painting it. The blur is baked here too: two
   * separable passes and a plain composite still beat one composite through
   * a k x k kernel, by the ratio of 2k to k squared.
   */
  _paintShadowLive(ctx, plan) {
    if (typeof ntk.Surface !== 'function' || !this.app?.display?.Render) return;
    let surface = null;
    try {
      surface = new ntk.Surface(this.app, {
        width: plan.width,
        height: plan.height,
        format: 'a8',
      });
      surface.render((sctx) =>
        plan.draw(sctx, { x: 0, y: 0, width: plan.width, height: plan.height }),
      );
      // `after` may hand back a *different* surface — the blur is baked into
      // a second one and the sharp copy destroyed — so both the drawing and
      // the cleanup below follow what it returned.
      surface = plan.after(surface) ?? surface;
      const before = ctx.fillStyle;
      ctx.fillStyle = plan.tint;
      ctx.drawImage(surface, plan.x, plan.y);
      ctx.fillStyle = before;
    } catch {
      // A server that will not give us a pixmap: the frame is still owed
      // everything else in it, and a missing shadow is a cosmetic loss.
    } finally {
      surface?.destroy();
    }
  }

  _paintBorder(ctx) {
    const { borderRadius = 0 } = this.style;
    // Both through the node's resolved direction: a `borderStartWidth` lays
    // out on one side and has to paint on the same one.
    const w = resolveBorderWidths(this.style, this.direction);
    const colors = resolveBorderColors(this.style, this.direction);
    const uniform =
      w.top === w.right &&
      w.top === w.bottom &&
      w.top === w.left &&
      colors.top === colors.right &&
      colors.top === colors.bottom &&
      colors.top === colors.left;
    if (!uniform) {
      this._paintBorderSides(ctx, w, colors);
      return;
    }
    const borderWidth = w.top;
    if (!(borderWidth > 0) || !isPaintedColor(colors.top)) return;
    // dashed borders need ntk >= 3.2.0 (setLineDash); solid fallback below
    const dashed =
      this.style.borderStyle === 'dashed' &&
      typeof ctx.setLineDash === 'function';
    if (dashed) {
      ctx.setLineDash([borderWidth * 2 + 2, borderWidth + 2]);
    }
    ctx.strokeStyle = colors.top;
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

  /**
   * Non-uniform borders: four independent strokes, square corners. The join
   * rule is CSS-adjacent and deterministic — top and bottom span the full
   * width of the box, left and right run between them — which every square
   * case (bars, rules, accent edges) never notices, because it only has one
   * painted side to begin with.
   *
   * `borderRadius` requires uniform borders in v1: a rounded corner between
   * two sides of different width or colour has no honest square answer, so
   * the radius is ignored here and DEV says so once rather than bending the
   * strokes halfway.
   */
  _paintBorderSides(ctx, w, colors) {
    if (DEV && (this.style.borderRadius ?? 0) > 0 && !warnedSideRadius) {
      warnedSideRadius = true;
      console.warn(
        'react-x11: borderRadius needs uniform borders — same width and ' +
          'colour on all four sides. This border is painted square. Round ' +
          'the corners with a uniform border, or drop the radius.',
      );
    }
    const dashable = typeof ctx.setLineDash === 'function';
    const dashed = this.style.borderStyle === 'dashed' && dashable;
    const { x, y, width, height } = this.abs;
    const side = (sw, color, x1, y1, x2, y2) => {
      if (!(sw > 0) || !isPaintedColor(color)) return;
      if (dashed) ctx.setLineDash([sw * 2 + 2, sw + 2]);
      ctx.strokeStyle = color;
      ctx.lineWidth = sw;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    };
    side(w.top, colors.top, x, y + w.top / 2, x + width, y + w.top / 2);
    side(
      w.bottom,
      colors.bottom,
      x,
      y + height - w.bottom / 2,
      x + width,
      y + height - w.bottom / 2,
    );
    side(
      w.left,
      colors.left,
      x + w.left / 2,
      y + w.top,
      x + w.left / 2,
      y + height - w.bottom,
    );
    side(
      w.right,
      colors.right,
      x + width - w.right / 2,
      y + w.top,
      x + width - w.right / 2,
      y + height - w.bottom,
    );
    if (dashed) ctx.setLineDash([]);
  }

  /**
   * What this element draws of its own, between its background and its
   * children — where every built-in that draws anything draws it, and the
   * seam an element that draws over its own scroll offset needs, since the
   * scrollbars go on after the children and `paint` returning is too late
   * to be underneath them.
   */
  paintContent(ctx) {}

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
   * The ancestor walk matters on its own (issue #211): a scrolling box's
   * own box is often much smaller than the window around it, and its
   * `ctx.clip()` in `_paintChildren` only keeps the *pixels* off the visible
   * surface — every child below the fold still ran its full paint (canvas
   * `onDraw`, text/tex layout, the XRender/PutImage requests that go with
   * them) for the server to then discard. Checking the window alone missed
   * that: a node can sit well inside the window and still be entirely past
   * a scrolling ancestor whose own bounds are the real limit.
   *
   * `rect` asks the same question about part of the node instead — window
   * coordinates, the node's own rect by default. What wants it is anchoring
   * (`src/anchor.js`): a popup pointed at a caret has to know when *the
   * caret* has scrolled out of the editor, which happens many screens before
   * the editor itself goes anywhere.
   */
  _offscreen(rect = this.abs) {
    const window = this.root?.abs;
    if (!window) return false;
    const { x, y, width, height } = rect;
    if (
      x + width <= 0 ||
      y + height <= 0 ||
      x >= window.width ||
      y >= window.height
    ) {
      return true;
    }
    for (let n = this.parent; n && n !== this.root; n = n.parent) {
      if (n.clipsChildren() && !rectsOverlap(rect, n.abs)) return true;
    }
    return false;
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

/** A selected line with nothing on it still shows, so a blank line inside a
 * selection does not read as the highlight having stopped. */
const EMPTY_LINE_BAND = 4;

/**
 * The rectangles a highlight over `[start, end)` code points fills, in the
 * layout's own coordinates — one per line, and one per **direction run**
 * inside a line.
 *
 * The per-run walk is the whole reason this is not four lines of caret
 * arithmetic. A selection is contiguous in *logical* order and a line is
 * laid out in *visual* order, so in "the file مرحبا here" a range that
 * crosses into the Arabic covers two disjoint stretches of pixels, and a
 * single rect from one caret x to the other paints over text nobody
 * selected. Each run is intersected with the range in code units — the space
 * ntk reports run extents in — and only a boundary falling *inside* a run
 * costs a `caretPosition`; a fully covered run is its own two edges, which
 * with the merge below is what keeps a plain paragraph at one rect per line.
 *
 * It belongs in ntk's `TextLayout`, beside the private offset table it
 * rebuilds here. It is here because the selection needs it now.
 */
function rangeBands(layout, text, start, end) {
  const lines = layout.lines;
  if (!lines?.length || end <= start) return [];
  const offsets = codeUnitOffsets(text);
  const last = offsets.length - 1;
  const from = offsets[Math.max(0, Math.min(start, last))];
  const to = offsets[Math.max(0, Math.min(end, last))];
  if (to <= from) return [];
  const bands = [];
  for (const line of lines) {
    if (line.end <= from || line.start >= to) continue;
    const spans = [];
    for (const positioned of line.runs) {
      const a = Math.max(from, positioned.start);
      const b = Math.min(to, positioned.end);
      if (b <= a) continue;
      const rtl = positioned.run?.direction === 'rtl';
      const near = line.x + positioned.x;
      const far = near + positioned.width;
      // a boundary at the run's own logical edge is that edge — which side
      // of the pixels it is on is what the run's direction decides
      const edgeAt = (cu, logicalStart) => {
        if (logicalStart ? cu <= positioned.start : cu >= positioned.end) {
          return rtl === logicalStart ? far : near;
        }
        return layout.caretPosition(codePointAtOffset(offsets, cu)).x;
      };
      const x1 = edgeAt(a, true);
      const x2 = edgeAt(b, false);
      spans.push([Math.min(x1, x2), Math.max(x1, x2)]);
    }
    if (!spans.length) {
      bands.push({
        x: line.x,
        y: line.y,
        width: EMPTY_LINE_BAND,
        height: line.height,
      });
      continue;
    }
    // Runs also split at every style span, so an ordinary line with a bold
    // word in it is three rectangles that touch. Merging keeps the common
    // case at one per line.
    spans.sort((p, q) => p[0] - q[0]);
    let [left, right] = spans[0];
    for (let i = 1; i <= spans.length; i++) {
      const next = spans[i];
      if (next && next[0] <= right + 0.5) {
        right = Math.max(right, next[1]);
        continue;
      }
      if (right > left) {
        bands.push({
          x: left,
          y: line.y,
          width: right - left,
          height: line.height,
        });
      }
      if (next) [left, right] = next;
    }
  }
  return bands;
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
    a11yHooks.textContent?.(this);
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
  }

  /** Height for a width: the paragraph shaped into whatever is on offer.
   * The offer is `Infinity` when nothing bounds it, which is also what
   * `textWrap: 'nowrap'` asks for, so neither needs a mode.
   *
   * Both answers are **whole pixels**, the trimmed one included — see
   * `_trim` for why the rounding is not cosmetic. The glyphs are placed
   * from the unrounded trim (`_placedLayout`), so what the rounding moves
   * is the bottom edge of the box, by less than half a pixel. */
  measureContent({ width }) {
    const layout = this._layoutFor(this._wrapWidth(width));
    if (!layout) return { width: 0, height: 0 };
    const trim = this._trim(layout);
    return {
      width: Math.ceil(layout.width),
      height: Math.max(
        0,
        trim
          ? Math.round(Math.ceil(layout.height) - (trim.top + trim.bottom))
          : Math.ceil(layout.height),
      ),
    };
  }

  _textContentChanged() {
    if (this.isSpan) {
      this.parent?._textContentChanged();
      return;
    }
    this._layouts.clear();
    if (this.yoga) this.yoga.markDirty();
  }

  /**
   * The cached layout is stale, but the box it reported cannot have moved.
   *
   * `textRendering` rides on the spans inside a layout, so a cached one keeps
   * answering with the old value and has to go — but it decides only how
   * glyph origins are rounded at draw time, and ntk's layout measures
   * byte-identically whichever way it is set. So the layout is dropped
   * without marking yoga dirty: the next paint calls `_layoutFor` and
   * rebuilds it, and nothing reflows on the way.
   */
  _textPaintChanged() {
    if (this.isSpan) {
      this.parent?._textPaintChanged();
      return;
    }
    this._layouts.clear();
  }

  /**
   * The base direction is an input to shaping, not just to painting: it sets
   * the level every neutral character resolves against and the edge
   * `textAlign: 'start'` means. So a paragraph whose direction moved is a
   * paragraph that has to be laid out again, at the same cost as a font
   * change.
   */
  _directionMoved() {
    this._textContentChanged();
    const owner = this._textBoxOwner();
    if (owner) owner._invalidateLayout('direction');
    else this.root?.invalidate(true, null, 'direction');
  }

  /** The node that owns the box this text flows in. A span has none of its
   * own, so its geometry — and its damage — belong to the nearest ancestor
   * with a yoga node. */
  _textBoxOwner() {
    let owner = this;
    while (owner && !owner.yoga) owner = owner.parent;
    return owner;
  }

  /**
   * The type this text is set in moved, from its own style or from an
   * ancestor's. The two costs differ by a layout pass.
   *
   * A re-measure has to *ask* for one. None of `fontSize`, `fontWeight`,
   * `fontFamily` or `fontStyle` is a yoga property, so `applyLayoutStyle`
   * sees nothing move, and none is a paint prop either, so the node
   * contributes no damage — the frame is already decided by the time the
   * layout is dropped. They are all inputs to the *measure function*, and the
   * dirty flag `_textContentChanged` sets is only read by a layout pass:
   * without asking for one the cleared layout is never rebuilt and the old
   * glyphs stay on screen with nothing reporting an error.
   */
  _textStyleMoved(cost) {
    const owner = this._textBoxOwner();
    if (cost === TEXT_REMEASURE) {
      this._textContentChanged();
      if (owner) owner._invalidateLayout('text');
      else this.root?.invalidate(true, null, 'text');
      return;
    }
    // Only the ink or the glyph rounding. Both ride on the spans inside the
    // cached layout, so it still has to go — but the box cannot have moved,
    // and `false` here is the whole point: this is the path a `:hover`
    // arrives by, once per pointer move, and a transitioned colour by, once
    // per frame.
    this._textPaintChanged();
    this.root?.invalidate(false, owner ?? NO_DAMAGE, 'text');
  }

  applyProps(newProps, oldProps) {
    const before = this.style;
    super.applyProps(newProps, oldProps);
    // The inherited half of the text style — the face, the size, the ink —
    // travels through `_retarget` and lands in `_textStyleMoved`, whichever
    // route it arrived by. What is left here is what only this node's own box
    // cares about: how its lines are aligned, how tall they are, whether they
    // wrap at all.
    if (!localTextStyleChanged(this.style, before)) return;
    this._textContentChanged();
    const owner = this._textBoxOwner();
    if (owner) owner._invalidateLayout('text');
    else this.root?.invalidate(true, null, 'text');
  }

  /**
   * The paragraph as a flat run list: one entry per chunk of text, carrying
   * the style resolved where that chunk is written.
   *
   * A nested `<text>` is a span, and it inherits from the `<text>` around it
   * by the same mechanism a `<text>` inherits from the `<box>` around it —
   * `resolvedTextStyle()` walks the parents either way, so a span needs no
   * inheritance rule of its own. It also has to *ask*, rather than be handed
   * the answer: filling the cache here is what makes `:hover` on a span work,
   * since an unresolved node is one `_retext` skips.
   */
  collectSpans(out) {
    const style = this.resolvedTextStyle();
    for (const child of this.children) {
      if (child.kind === 'textchunk') {
        out.push({
          text: child.text,
          family: style.family,
          size: style.size,
          weight: style.weight,
          style: style.style,
          variations: style.variations,
          textRendering: style.textRendering,
          color: style.color,
        });
      } else if (child.kind === 'text') {
        child.collectSpans(out);
      }
    }
    return out;
  }

  /**
   * `textOverflow: 'ellipsis'` — is this paragraph one that ends in a `…`
   * when it does not fit, rather than one that is sliced?
   *
   * Read in four places, because eliding is not only a drawing decision: it
   * changes how many lines there are, which width the paragraph is shaped
   * against, and therefore what the node reports to layout.
   */
  _elides() {
    return this.style.textOverflow === 'ellipsis';
  }

  /**
   * How many lines are kept — CSS's `-webkit-line-clamp` under the name the
   * platforms that got a clean shot at it chose. Unlimited by default.
   *
   * **`textOverflow: 'ellipsis'` on its own means one line.** ntk elides off
   * a line *count* (`truncated = lineTokens.length > maxLines`), so an
   * ellipsis with no cap can never fire: there is nothing over the cap to
   * stand for. Leaving it inert would make `textOverflow: 'ellipsis'` a
   * property that silently does nothing in the case it is most often
   * written for — a name, a path, a status line — so the cap an author
   * almost certainly meant is the default, and `maxLines` is how they say
   * two or three instead.
   *
   * A cap below one keeps one: a `<text>` that renders nothing at all is
   * conditional rendering, not a truncation setting, and it would look like
   * a missing label rather than like a number.
   */
  _maxLines() {
    const { maxLines } = this.style;
    if (Number.isFinite(maxLines)) return Math.max(1, Math.floor(maxLines));
    return this._elides() ? 1 : Infinity;
  }

  /**
   * `textWrap: 'nowrap'` — CSS's, and the reason a table cell is a table cell
   * rather than a paragraph.
   *
   * A `<text>` measures height-for-width: hand it a narrow box and it wraps
   * to fit, which is right for prose and wrong for a row of a list. A cell is
   * a fixed height, so a date that wraps to two lines is not a taller row —
   * it is a line and a half of date with the rest sliced off, top and bottom,
   * and the same is true of any name longer than its column. Measuring at
   * unbounded width makes the overflow horizontal instead, which is what
   * `overflow: 'hidden'` on the cell already knows how to deal with.
   *
   * **Unless it elides.** Then the unbounded measurement is exactly what has
   * to go: at `maxWidth: Infinity` there is one line, one line is never over
   * the cap, and nothing is ever cut — the single-line ellipsis, which is by
   * a distance the common case, could not be spelled at all. So an eliding
   * `nowrap` is shaped against the width on offer, and the two properties
   * divide up cleanly: `textWrap` says the text does not wrap, `maxLines`
   * says how much of it is kept, and the width is the box's either way.
   *
   * The visible consequence is in what the node reports back to layout. A
   * clipping `nowrap` `<text>` measures its whole string at any offer, so
   * its min-content floor is the full width and the box around it is pushed
   * out to fit (and then clips). An eliding one measures inside the offer,
   * so its floor is small and it gives way instead — which is the point: a
   * column that cannot show a file name should show `Applicati…`, not force
   * every other column narrower to avoid saying so.
   */
  _wrapWidth(maxWidth) {
    if (this.style.textWrap !== 'nowrap') return maxWidth;
    return this._elides() ? maxWidth : Infinity;
  }

  _layoutFor(maxWidth) {
    const fonts = this.app?.fonts;
    if (!fonts) return null; // mock container in tests: no text metrics
    const maxLines = this._maxLines();
    const overflow = this.style.textOverflow;
    // Both truncation options are inputs to the shaping, so both belong in
    // the key. They can only change with the style, which clears the whole
    // map on its way past — but a cache keyed on less than it depends on is
    // one refactor away from answering with the wrong paragraph, and the
    // wrong paragraph here is glyphs on screen that no error mentions.
    const key = `${maxWidth}|${maxLines}|${overflow ?? ''}`;
    let layout = this._layouts.get(key);
    if (!layout) {
      const spans = this.collectSpans([]);
      const base = this.resolvedTextStyle();
      layout = fonts.layout(spans, base, {
        maxWidth: Number.isFinite(maxWidth) ? maxWidth : undefined,
        align: this.style.textAlign,
        lineHeight: this.style.lineHeight,
        maxLines: Number.isFinite(maxLines) ? maxLines : undefined,
        // 'clip' is ntk's default, so an unset property and the CSS default
        // are the same request rather than two paths through the layout.
        overflow,
        // The paragraph's **base** direction, which is not the same question
        // as which script the characters are in. UAX#9 resolves a run of
        // neutrals — `"(1) 12:30"`, a filename, a lone bracket — against the
        // paragraph level, and the first-strong-character rule is only what
        // to do when nobody said. So handing the box's direction down is what
        // makes an Arabic paragraph parenthesise and punctuate correctly, and
        // it is also what `textAlign: 'start'` resolves against: ntk aligns
        // `start`/`end` to the base level, so a `<text>` with no strong
        // characters at all lands on the right side of an RTL box.
        direction: this.direction,
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
   *
   * The amounts are fractions of a pixel and stay that way — the glyphs are
   * placed from them (`_placedLayout`). What must not stay fractional is the
   * **box** they leave behind, which is why `measureContent` rounds the
   * height it reports and this does not (issue #411).
   *
   * A trimmed label measures to the cap band, and a cap height is a fraction
   * of the em — so before the rounding, a column of trimmed titles handed
   * yoga three or four flex items whose main size had a fraction in it and
   * whose content floors (#249) were that same fraction. Yoga freezes a line
   * like that item by item and divides the overflow by a total shrink factor
   * that should have cancelled to zero; a fraction that is not exact in
   * binary leaves a rounding residue there instead, and dividing by it laid
   * the section titles of `examples/configurator` out 5.6 billion pixels
   * tall. See `writeContentFloors`, which is the other end of it.
   */
  _trim(layout) {
    if (this.style.textBoxTrim !== 'cap-alphabetic') return null;
    const lines = layout?.lines;
    if (!lines?.length) return null;
    const base = this.resolvedTextStyle();
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

  /**
   * The layout as it is on screen: the shaped paragraph, and where its box
   * sits in the window. One place, because painting and every geometry
   * question have to agree about it down to the trim — a caret answered from
   * a differently-placed layout is a caret in the wrong place, and nothing
   * about it would look like a bug in this function.
   */
  _placedLayout() {
    const content = this.contentBox();
    const layout = this._layoutFor(this._wrapWidth(content.width || Infinity));
    if (!layout) return null;
    // the box was shortened from the top, so the glyphs come up with it
    const trim = this._trim(layout);
    return {
      layout,
      x: content.x,
      y: content.y + halfLeading(layout) - (trim ? trim.top : 0),
    };
  }

  /** The paragraph as one string — what the indices below index into. A
   * nested `<text>` is a span of this one, so its characters are in here too,
   * at the position they are written at. */
  textContent() {
    return this.collectSpans([])
      .map((span) => span.text)
      .join('');
  }

  textIndexAt(x, y) {
    const placed = this._placedLayout();
    if (!placed) return 0;
    return placed.layout.indexAt(x - placed.x, y - placed.y);
  }

  textCaretRect(index) {
    const placed = this._placedLayout();
    if (!placed) return null;
    const caret = placed.layout.caretPosition(index);
    return {
      x: placed.x + caret.x,
      y: placed.y + caret.y,
      width: 0,
      height: caret.height,
    };
  }

  textRangeRects(start, end) {
    const placed = this._placedLayout();
    if (!placed) return [];
    return rangeBands(placed.layout, this.textContent(), start, end).map(
      (band) => ({
        x: placed.x + band.x,
        y: placed.y + band.y,
        width: band.width,
        height: band.height,
      }),
    );
  }

  paintContent(ctx) {
    const placed = this._placedLayout();
    if (!placed) return;
    this._paintSelection(ctx);
    placed.layout.draw(ctx, placed.x, placed.y);
  }

  /** The band under the glyphs, when a document selection reaches this
   * paragraph. Drawn from the same accessors a registered element would use,
   * so the built-in and the custom surface cannot drift apart. */
  _paintSelection(ctx) {
    const range = this._selRange;
    if (!range || range.end <= range.start) return;
    const rects = [];
    for (const r of this.textRangeRects(range.start, range.end)) {
      rects.push(r.x, r.y, r.width, r.height);
    }
    if (!rects.length) return;
    ctx.fillStyle = range.color;
    // one Render.FillRectangles for the whole highlight, however many lines
    // and however many direction changes it took (ntk >= 7.6)
    ctx.fillRects(rects);
  }
}

/** The props `ImageNode.applyProps` diffs by value itself, kept out of the
 * base class's identity walk — a buffer rebuilt under an unchanged
 * `cacheKey` and a `{ id, … }` descriptor rebuilt with the same numbers are
 * both "nothing changed". */
const IMAGE_SOURCE_PROPS = new Set(['src', 'picture', 'drawable', 'cacheKey']);

export class ImageNode extends Node {
  constructor(props, app) {
    super('image', props, app);
    validateImageProps(props);
    this.image = null;
    this._loadToken = 0;
    /** hold on the `cacheKey` cache entry, when one is held */
    this._hold = null;
    /** an Image decoded for this node alone (no cacheKey), freed on release */
    this._ownedImage = null;
    /** PictureSource/DrawableSource, when the source is server-side */
    this._serverSource = null;
    // Resolution waits for the first layout/paint: the constructor runs in
    // the render phase, which React may discard, and resolving here would
    // start file reads and take cache holds nothing would ever release.
    this._sourceDirty = true;
  }

  get selfDamagedProps() {
    return IMAGE_SOURCE_PROPS;
  }

  paintChanged(next, prev) {
    return imageSourceChanged(next, prev) || super.paintChanged(next, prev);
  }

  /** The source's size, kept to its aspect ratio. Read per measure rather
   * than once, because a decode can arrive late.
   *
   * Source pixels are *logical* pixels, the browser's rule: a 100px-wide
   * PNG occupies 100 logical px at any display scale (upscaled onto the
   * device grid at 2x, the way an `<img>` without `srcset` is), rather
   * than shrinking to half its neighbours' size. The constraints are
   * already device, so only the natural size converts (src/scale.js). */
  measureContent(constraints) {
    this._ensureSource();
    const s = this.scale;
    return intrinsicSize(
      {
        width: (this.image?.width ?? 0) * s,
        height: (this.image?.height ?? 0) * s,
      },
      constraints,
    );
  }

  /** First layout or paint after a mount or a source change — both run
   * after commit, so an instance a concurrent render threw away never
   * resolves anything. */
  _ensureSource() {
    if (!this._sourceDirty || this.destroyed) return;
    this._sourceDirty = false;
    this._resolveSource();
  }

  _resolveSource() {
    const { src, picture, drawable, cacheKey } = this.props;
    if (picture != null || drawable != null) {
      this._serverSource =
        picture != null
          ? new PictureSource(this.app, picture)
          : new DrawableSource(this.app, drawable);
      this.image = this._serverSource;
      return;
    }
    if (src == null) return;
    if (isDirectImageSource(src)) {
      // the caller's object — its upload cache is the dedupe, and it is
      // never destroyed here
      this.image = src;
      return;
    }
    if (cacheKey != null) {
      const entry = acquireImageSource(this.app, cacheKey, () =>
        this._loadEntry(src),
      );
      this._hold = entry;
      if (entry.image) {
        this.image = entry.image;
        if (DEV) this._devCheckCacheKey(src, entry.image, cacheKey);
      } else {
        entry.promise?.then((image) => {
          if (image && this._hold === entry && !this.destroyed) {
            this._setImage(image);
          }
        });
      }
      return;
    }
    if (isPathImageSource(src)) {
      this._loadFile(src);
      return;
    }
    const image = this._decode(src);
    if (image) {
      this._ownedImage = image;
      this.image = image;
    }
  }

  /** `{ image }` or `{ promise }` for the cache. Failures resolve to null
   * and are reported once, here — not per node holding the key. */
  _loadEntry(src) {
    if (isPathImageSource(src)) {
      return {
        promise: ntk.loadImage(toLoadablePath(src)).then(
          (image) => image,
          (err) => {
            console.error(
              `react-x11: failed to load image ${src}:`,
              err.message,
            );
            return null;
          },
        ),
      };
    }
    return { image: this._decode(src) };
  }

  _decode(src) {
    try {
      return decodeImageSource(src);
    } catch (err) {
      // corrupt or unrecognized bytes are a content failure, not a
      // programming error: log and show nothing, like a missing file
      console.error(
        'react-x11: <image src> bytes did not decode:',
        err.message,
      );
      return null;
    }
  }

  async _loadFile(src) {
    const token = ++this._loadToken;
    try {
      const image = await ntk.loadImage(toLoadablePath(src));
      if (token !== this._loadToken || this.destroyed) return;
      this._ownedImage = image;
      this._setImage(image);
    } catch (err) {
      if (token === this._loadToken && !this.destroyed) {
        console.error(`react-x11: failed to load image ${src}:`, err.message);
      }
    }
  }

  /** Adopt pixels that arrived after the frame that asked for them. A size
   * change reflows; same-size new pixels claim only this node's box. */
  _setImage(image) {
    const prev = this.image;
    this.image = image;
    if (
      (prev?.width ?? 0) !== (image?.width ?? 0) ||
      (prev?.height ?? 0) !== (image?.height ?? 0)
    ) {
      this.invalidateMeasure('content');
    } else {
      this.root?.invalidate(false, this, 'content');
    }
  }

  /** Two different pictures sharing one cacheKey is the one mistake this
   * design can make show stale pixels; the raw form carries enough to catch
   * the common case cheaply. */
  _devCheckCacheKey(src, image, key) {
    if (!isRawImageSource(src)) return;
    if (src.width === image.width && src.height === image.height) return;
    console.error(
      `react-x11: <image cacheKey=${JSON.stringify(key)}> is ` +
        `${image.width}x${image.height} in the cache, but this src says ` +
        `${src.width}x${src.height}. Two different pictures are sharing one ` +
        'cacheKey — the key must name the content, so include whatever ' +
        'distinguishes them.',
    );
  }

  _releaseSource() {
    this._loadToken++; // orphan any in-flight file read
    if (this._hold) {
      releaseImageSource(this.app, this._hold);
      this._hold = null;
    }
    if (this._ownedImage) {
      // frees the per-app upload; the caller's own Images are never here
      this._ownedImage.destroy();
      this._ownedImage = null;
    }
    if (this._serverSource) {
      this._serverSource.destroy?.();
      this._serverSource = null;
    }
    this.image = null;
  }

  applyProps(newProps, oldProps) {
    const before = oldProps ?? this.props;
    const sourceChanged = imageSourceChanged(newProps, before);
    // before super touches anything, so a bad update leaves the node whole
    if (sourceChanged) validateImageProps(newProps);
    super.applyProps(newProps, oldProps);
    if (!sourceChanged) return;
    const prev = this.image;
    this._releaseSource();
    this._sourceDirty = false;
    this._resolveSource();
    // paintChanged already claimed this node's box through super; only a
    // new intrinsic size needs more than that
    if (
      (prev?.width ?? 0) !== (this.image?.width ?? 0) ||
      (prev?.height ?? 0) !== (this.image?.height ?? 0)
    ) {
      this.invalidateMeasure('content');
    }
  }

  destroySubtree() {
    this._releaseSource();
    super.destroySubtree();
  }

  paintContent(ctx) {
    this._ensureSource();
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

// Every box and every window now answers `_scrollbars()`, and almost none of
// them has any: the shared empty keeps that answer allocation-free on a path
// walked per node per hit test.
const EMPTY_SCROLLBARS = Object.freeze([]);

/**
 * Geometry of a scrollbar on either axis, or null when there is nothing to
 * scroll along it. Shared by scrolling boxes and `<textarea>` so what is
 * painted and what the pointer hits cannot drift apart — and written once
 * for both axes so the two cannot drift from each other either.
 *
 * `viewport`/`content`/`scroll` are along the axis; `across`/`crossSize`
 * place the bar on the other one. `shorten` keeps the two bars out of each
 * other's corner when both are showing.
 *
 * `direction` mirrors both of those. A vertical bar sits on the **left** in
 * an RTL viewport — every desktop does this, and it is not decoration: the
 * bar belongs on the edge the eye finishes a line at. And a horizontal bar's
 * thumb starts at the right, because `scroll` is measured from the start of
 * the content and the start of RTL content is its right-hand edge.
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
  direction = 'ltr',
  scale = 1,
}) {
  const length = viewport - shorten;
  if (length <= 0 || !(content > viewport)) return null;
  // The strip's own dimensions are logical constants; everything the caller
  // passed — rects, content extents, offsets — is already device. The bar
  // carries `scale` so the track, the hit slop and the thumb's corner
  // radius downstream draw from the same number.
  const barWidth = SCROLLBAR_WIDTH * scale;
  const rtl = direction === 'rtl';
  const thumbLength = Math.max(
    SCROLLBAR_MIN_THUMB * scale,
    (length * length) / content,
  );
  const range = content - viewport;
  const travel = Math.max(0, length - thumbLength);
  const offset = range > 0 ? (scroll / range) * travel : 0;
  // a vertical bar always fills from the top; only the horizontal one runs
  // the way the text does
  const thumbStart =
    rtl && axis === 'x' ? start + travel - offset : start + offset;
  const crossStart =
    rtl && axis === 'y'
      ? crossStart0 + inset
      : crossStart0 + crossSize - barWidth - inset;
  return {
    axis,
    scale,
    trackStart: start,
    trackLength: length,
    thumbStart,
    thumbLength,
    crossStart,
    range,
    travel,
    // does a larger `scroll` move the thumb *towards* trackStart? The one
    // place the mirroring is written down, so the drag and the track-page
    // below read it rather than asking about the direction again
    reversed: rtl && axis === 'x',
    // the thumb as a rect, for painting
    x: axis === 'x' ? thumbStart : crossStart,
    y: axis === 'x' ? crossStart : thumbStart,
    width: axis === 'x' ? thumbLength : barWidth,
    height: axis === 'x' ? barWidth : thumbLength,
  };
}

/** The coordinate along a bar's own axis, and across it. */
const along = (bar, x, y) => (bar.axis === 'x' ? x : y);
const across = (bar, x, y) => (bar.axis === 'x' ? y : x);

/** Is this point on the bar (with slop), and if so, on the thumb? */
function scrollbarHit(bar, x, y) {
  if (!bar) return null;
  const c = across(bar, x, y);
  const s = bar.scale ?? 1;
  if (
    c < bar.crossStart - SCROLLBAR_SLOP * s ||
    c > bar.crossStart + (SCROLLBAR_WIDTH + SCROLLBAR_SLOP) * s
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
    ctx.roundRect(bar.x, bar.y, bar.width, bar.height, 3 * (bar.scale ?? 1));
  } else {
    ctx.rect(bar.x, bar.y, bar.width, bar.height);
  }
  ctx.fill();
}

/**
 * Scrolling, as a style rather than as a species of node.
 *
 * `overflow: 'scroll'` turns a `<box>` — or a `<window>` — into a clipped
 * viewport over its own overflowing content: the offset is applied during
 * absolutize, so painting and hit testing see already-shifted rects. Wheel
 * events scroll the nearest one by default (see EventManager), and
 * `scrollTo`/`scrollBy`/`scrollIntoView` are on the ref.
 *
 * Everything here is **inert until the style says scroll**, which is what
 * lets it live on the ordinary container instead of behind an element of its
 * own: `_maxScroll` answers 0, so `scrollTo` is a no-op, no bar has geometry,
 * nothing is a tab stop, and `absolutize` takes the plain path. A second gate
 * sits behind the first — most of the visible behaviour also asks whether
 * there is anything to scroll *right now* — so a viewport whose content fits
 * really is an ordinary clipped box, and grows a thumb and a tab stop the
 * moment its content outgrows it.
 *
 * A mixin rather than a base class because the two elements that scroll do
 * not share one: `<box>` extends Node directly and `<window>` is its own
 * world. Deliberately not on Node itself — `<textinput>`/`<textarea>` carry
 * their own `_scrollbar` and `focusableByDefault` with different meanings,
 * and inheriting these would collide with both.
 */
export const Scrollable = (Base) =>
  class extends Base {
    constructor(...args) {
      super(...args);
      this.scrollY = 0;
      this.scrollX = 0;
      this.contentHeight = 0;
      this.contentWidth = 0;
      // `measureScrollContent` owed a fresh answer — true until the first
      // layout pass measures, and re-raised by any change yoga cannot see
      // (`_markScrollMeasureDirty`, issue #405)
      this._scrollMeasureDirty = true;
    }

    /**
     * Does this node scroll what overflows it? The one gate everything below
     * reads, and the reason `overflow: 'scroll'` and `overflow: 'hidden'`
     * are now genuinely different things: both clip, only this one scrolls.
     *
     * The layout defaults that go with it — `flex-basis: 0`, `min-width: 0`,
     * `min-height: 0` — are folded into the resolved style by
     * `resolveComputedStyle` (styles.js), so they travel through the same
     * diff as any other style and come back off when the overflow does.
     */
    isScroller() {
      return this.style.overflow === 'scroll';
    }

    /**
     * Stopped being a scroll container: an offset nothing will clamp again
     * would otherwise keep the content shifted forever. CSS loses the scroll
     * position the same way when a box stops scrolling.
     */
    _overflowChanged() {
      // whichever way the style flipped, the next scrolling pass starts
      // from a fresh measurement
      this._scrollMeasureDirty = true;
      if (this.isScroller()) return;
      this._scrollIntoViewTarget = null;
      this._childOrigin = null;
      if (this.scrollX === 0 && this.scrollY === 0) return;
      this.scrollX = 0;
      this.scrollY = 0;
      this._invalidateLayout('scroll');
    }

    absolutize(originX, originY) {
      this._placed = true;
      if (!this.yoga) return;
      this._assignAbs(
        originX + this.yoga.getComputedLeft(),
        originY + this.yoga.getComputedTop(),
        this.yoga.getComputedWidth(),
        this.yoga.getComputedHeight(),
      );
      this._absolutizeChildren(this.abs.x, this.abs.y);
    }

    /**
     * Place the children, shifted by the scroll offset when there is one.
     * Split out of `absolutize` because a `<window>` writes its own `abs`
     * during flush and then walks its children from (0, 0) — the same walk,
     * reached by a different route.
     */
    _absolutizeChildren(originX, originY) {
      if (!this.isScroller()) {
        for (const child of this.children) {
          if (!child.isWindow) child.absolutize(originX, originY);
        }
        return;
      }
      const rtl = this.direction === 'rtl';
      // A pure-scroll pass re-learns nothing by walking (issue #405): the
      // content reach and every child's place *inside* the pane only change
      // when layout inside the pane changes. Yoga's own has-new-layout flag
      // is the witness — consumed here and nowhere else — set by any pass
      // that laid this node or anything under it out again, and left clear
      // by one that merely scrolled. `_scrollMeasureDirty` covers the one
      // route yoga cannot see: an element that paints its own content
      // growing its extent (docs/extending.md), announced through
      // `invalidate(true, this, 'scroll')`. The root's yoga node re-flags
      // on every pass, so a `<window overflow='scroll'>` always takes the
      // full walk — the pane that holds an app's long list is a box.
      const clean =
        this._childOrigin != null &&
        !this._scrollMeasureDirty &&
        !this.yoga.hasNewLayout();
      if (!clean) {
        const size = this.measureScrollContent();
        if (!Number.isFinite(size?.width) || !Number.isFinite(size?.height)) {
          // A NaN here does not throw on its own: it becomes a NaN max
          // scroll, a NaN offset, and every child laid out at NaN — a whole
          // tree gone with nothing naming the element that did it.
          throw new Error(
            `react-x11: <${this.kind}>.measureScrollContent() must return ` +
              '{ width, height } as finite numbers; it returned ' +
              `${describeSize(size)}. Return { width: 0, height: 0 } for ` +
              'content that has not arrived yet.',
          );
        }
        this.contentWidth = size.width;
        this.contentHeight = size.height;
        this._scrollMeasureDirty = false;
        this.yoga.markLayoutSeen();
      }
      this._resolveScrollIntoView();
      this.scrollY = clampScroll(this.scrollY, this._maxScroll('y'));
      this.scrollX = clampScroll(this.scrollX, this._maxScroll('x'));
      this._reportViewport();
      // `scrollX` is how far the content has moved **from its start**, which
      // is the right-hand edge in RTL — so scrolling shifts the children the
      // other way. Keeping it a distance rather than a coordinate is what
      // makes `scrollTo({x: 0})` mean "back to the beginning" in both
      // directions, and keeps every clamp, every max and the blit's arithmetic
      // in one sign.
      const ox = rtl ? originX + this.scrollX : originX - this.scrollX;
      const oy = originY - this.scrollY;
      // The layout diff and a scroll would double-report each other: a scroll
      // is a uniform shift of everything below this viewport, already claimed
      // as the viewport itself (or narrowed to the exposed strip by the blit),
      // and per-child old/new claims would re-widen the very frame the blit
      // narrows. So when the children's origin moved, the walk below runs
      // with the diff off. When it did not move, a child that moved did so by
      // real layout — claim it, but clipped to the viewport: ink below the
      // fold never reaches the surface, and an unclipped claim would repaint
      // whatever unrelated UI sits under this node's off-viewport extent.
      const wasOrigin = this._childOrigin;
      const shifted = wasOrigin && (wasOrigin.x !== ox || wasOrigin.y !== oy);
      this._childOrigin = { x: ox, y: oy };
      if (clean) {
        // The fast path (issue #405): nothing inside was laid out, so every
        // child sits exactly where the last pass put it, shifted by however
        // far the origin moved — one uniform translation instead of a
        // per-node yoga re-derivation. The layout diff is owed nothing by
        // construction: under a blit ledger the shifted diff's claims are
        // the deviations from this very translation, and a clean pane has
        // none — the walk below lands every node where the diff would have
        // reported silence.
        if (!shifted) return;
        const dx = ox - wasOrigin.x;
        const dy = oy - wasOrigin.y;
        for (const child of this.children) {
          if (!child.isWindow) child._shiftAbs(dx, dy);
        }
        return;
      }
      const outer = layoutDiffSink;
      const outerShift = layoutDiffShift;
      const ledger = shifted && this._blitLedgerOpen();
      if (outer) {
        if (ledger) {
          // The blit's own ledger takes this walk (issue #398). The shift
          // below is what makes the diff worth running under a scroll at
          // all: without it every child reports the move the blit is about
          // to make for them, and the claims add up to the viewport. What
          // is left is the virtualized list's real frame — the rows that
          // entered, the ones that left, a spacer that resized — and it
          // goes to the ledger rather than to `outer`, whose claims are
          // what `layoutMoved` reads as "this frame is not a pure scroll".
          const vp = insetRect(this.abs, -DAMAGE_SLOP);
          layoutDiffSink = (rect) => {
            const clipped = intersectRects(rect, vp);
            if (clipped && !this._recordBlitClaim(clipped)) {
              this._pendingBlitFrom = BLIT_POISONED;
            }
          };
          layoutDiffShift = { x: ox - wasOrigin.x, y: oy - wasOrigin.y };
        } else if (shifted) {
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
        layoutDiffShift = outerShift;
      }
    }

    /**
     * A scroller inside a shifting subtree does not ride the translation
     * blindly: its box moves rigidly, but its children's origin also
     * carries the scroll offsets, which may have changed again this very
     * frame — a wheel on a nested pane while an outer one scrolls.
     * Re-entering `_absolutizeChildren` folds both into one delta, and
     * re-runs the gate, so a nested pane that is not clean still walks
     * properly. (Reached only under an outer pane's fast path, which
     * proved nothing in here was laid out — the nested gate can only
     * decline over its own `_scrollMeasureDirty`.)
     */
    _shiftChildren(dx, dy) {
      if (!this.isScroller()) return super._shiftChildren(dx, dy);
      this._absolutizeChildren(this.abs.x, this.abs.y);
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
      // logical, like onScroll's payload: finder.jsx divides this height by
      // a row height it wrote in a style
      const s = this.scale;
      const next = {
        width: this.abs.width / s,
        height: this.abs.height / s,
        contentWidth: this.contentWidth / s,
        contentHeight: this.contentHeight / s,
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
     * How far the content reaches — `scrollWidth`/`scrollHeight`, and what
     * everything below scrolls against: the maxima, the bars, the keys.
     *
     * The default measures the **children**, through the subtree rather than
     * off the direct ones. A row that stretches to the viewport while its own
     * cells overflow it — a table, in other words — reports the viewport
     * width at the top level and says nothing about the cells, so a shallow
     * measurement would find nothing to scroll. Anything that clips its own
     * children ends the walk: their overflow is that node's business.
     *
     * `width` is how far the content reaches from the edge it *starts* at,
     * which is the right-hand one under `direction: 'rtl'` — yoga lays an
     * overflowing RTL row out at negative offsets, so the reach that matters
     * there is how far left of zero it got, not how far right. An element
     * measuring its own drawing answers the same question and never has to
     * ask which direction it is in.
     *
     * **Override it when the content is pixels rather than nodes.** An
     * element that paints its own content — an editor drawing lines of text,
     * a terminal, a canvas-backed table — has no children to walk, so the
     * default measures 0 and the viewport clamps to nothing however far the
     * drawing actually goes. Answering here is the whole of joining in: the
     * wheel, the scrollbars, the scroll keys and the AT-SPI scroll pane all
     * read the numbers this returns (docs/extending.md).
     *
     * Called at most once per layout pass, from `absolutize`, so it may
     * read yoga geometry but must not invalidate or paint — and cached
     * across passes that laid nothing inside the pane out again (issue
     * #405): a pass that merely scrolled reuses the last answer, since a
     * scroll cannot change how far the content reaches. An element whose
     * extent changed by a route layout never saw — rows arrived, a line
     * was typed — announces it with `invalidate(true, this, 'scroll')`,
     * and the next pass asks again.
     */
    measureScrollContent() {
      const rtl = this.direction === 'rtl';
      const width = this.yoga.getComputedWidth();
      let start = 0;
      let bottom = 0;
      const walk = (node, dx, dy) => {
        for (const child of node.children) {
          if (child.isWindow || !child.yoga || child.hidden) continue;
          const x = dx + child.yoga.getComputedLeft();
          const y = dy + child.yoga.getComputedTop();
          const w = child.yoga.getComputedWidth();
          start = Math.max(start, rtl ? width - x : x + w);
          bottom = Math.max(bottom, y + child.yoga.getComputedHeight());
          if (!child.clipsChildren()) walk(child, x, y);
        }
      };
      walk(this, 0, 0);
      // the end padding is part of the content box a browser scrolls to, and
      // it is the one part of it yoga has already resolved for us — on the
      // left in RTL, since that is the end there
      return {
        width:
          start +
          this.yoga.getComputedPadding(rtl ? Yoga.EDGE_LEFT : Yoga.EDGE_RIGHT),
        height: bottom + this.yoga.getComputedPadding(Yoga.EDGE_BOTTOM),
      };
    }

    /**
     * How far this axis can scroll — 0 for a node the style does not make a
     * scroll container, which is the gate the whole public surface rests on:
     * `scrollTo` clamps to nothing, no bar has geometry, and nothing is a
     * tab stop, without any of them testing the style themselves.
     */
    _maxScroll(axis) {
      if (!this.isScroller()) return 0;
      return axis === 'x'
        ? Math.max(0, this.contentWidth - this.abs.width)
        : Math.max(0, this.contentHeight - this.abs.height);
    }

    /**
     * `scrollTo(y)` scrolls vertically, as it always has; `scrollTo({x, y})`
     * moves either axis, leaving out whichever is omitted.
     */
    /** Public entry, logical pixels — application code writes `scrollTo(120)`
     * in the same unit as its styles. Internal callers hold device offsets
     * and use `_scrollToDevice`/`_scrollByDevice` instead (src/scale.js). */
    scrollTo(to) {
      const s = this.scale;
      this._scrollToDevice(
        typeof to === 'number'
          ? { y: to * s }
          : {
              x: to?.x == null ? undefined : to.x * s,
              y: to?.y == null ? undefined : to.y * s,
            },
      );
    }

    _scrollToDevice(want) {
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
        // Arming is the one moment the evidence still exists: the viewport
        // claim recorded below coalesces earlier claims into itself
        // (addDamageRect keeps the list disjoint), after which a change
        // inside the viewport is indistinguishable from the scroll's own
        // claim — the blind spot the claim-time cancel in
        // WindowNode.invalidate cannot cover (react-x11#295). The scroll
        // has not claimed yet, so damage already overlapping this viewport
        // is foreign by construction: poison the frame instead of arming,
        // and the full-viewport repaint below stays in force.
        const arming = this._pendingBlitFrom == null;
        // The ledger this frame's changes inside the viewport are written
        // to (issue #398). Opened with the blit and read by
        // _applyScrollBlits, which clears it beside the origin.
        if (arming) this._blitLedger = [];
        if (arming && Array.isArray(root._damage)) {
          const zone = insetRect(this.abs, -(DAMAGE_SLOP * 2 + 1));
          for (const rect of root._damage) {
            // Already coalesced, so these rects are as coarse as the frame
            // has made them — which the ledger reads conservatively: a blob
            // that swallowed the viewport says so and poisons, exactly as
            // this gate used to for every claim it saw.
            if (rectsOverlap(rect, zone) && !this._recordBlitClaim(rect)) {
              this._pendingBlitFrom = BLIT_POISONED;
              break;
            }
          }
        }
        // An element that also shifted its own drawing this frame
        // (`scrollContents`, issue #303) is two shifts of the same pixels,
        // and a frame can only have one.
        if (this._pendingBlitContents) this._pendingBlitFrom = BLIT_POISONED;
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
      // the handler is application code: logical, like every payload —
      // finder.jsx's row virtualisation divides scrollY by a row height it
      // wrote in a style, and those must be the same unit
      const s = this.scale;
      this.props.onScroll?.({
        scrollX: next.x / s,
        scrollY: next.y / s,
        contentWidth: this.contentWidth / s,
        contentHeight: this.contentHeight / s,
        viewportWidth: this.abs.width / s,
        viewportHeight: this.abs.height / s,
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

    /**
     * Is there room to move on the axis this delta names? The first half of
     * the wheel's chain protocol (`canScroll` then `scrollBy`, see
     * docs/extending.md): a scroll container that fits its content answers
     * no and hands the gesture to the next one out, the way a browser does.
     *
     * Position is deliberately not part of the answer — a viewport scrolled
     * to its bottom still owns the wheel, rather than passing the rest of a
     * flick to whatever is behind it.
     */
    canScroll(dx, dy) {
      if (dx && this._maxScroll('x') > 0) return true;
      if (dy && this._maxScroll('y') > 0) return true;
      return false;
    }

    /** `scrollBy(dy)`, or `scrollBy({x, y})` for either axis. Logical, like
     * `scrollTo`. */
    scrollBy(by) {
      const s = this.scale;
      if (typeof by === 'number')
        return this._scrollToDevice({ y: this.scrollY + by * s });
      this._scrollToDevice({
        x: by?.x == null ? undefined : this.scrollX + by.x * s,
        y: by?.y == null ? undefined : this.scrollY + by.y * s,
      });
    }

    /** The wheel's and the key handler's entry: whole device pixels, which
     * is what keeps the scroll blit on the pixel grid at any scale. */
    _scrollByDevice(dx, dy) {
      this._scrollToDevice({
        x: dx ? this.scrollX + dx : undefined,
        y: dy ? this.scrollY + dy : undefined,
      });
    }

    /**
     * A box with something to scroll is a tab stop, so a pane of
     * *unfocusable* content — a log, a long `<text>`, a rendered document —
     * can be read without a pointer. Before this the only way to scroll one was the
     * wheel, which is a WCAG 2.1.1 failure on the most ordinary layout the
     * library has.
     *
     * Conditional on purpose: a scroll box that fits its content is an
     * ordinary clipped box, and stopping Tab on it would be a tab stop that
     * does nothing. It is answered from the current layout, so a pane that
     * grows past its viewport becomes reachable the moment it does.
     */
    get focusableByDefault() {
      return this._scrollsWithKeys();
    }

    /** Is there anything here for the scroll keys to move? Separate from
     * `focusableByDefault` because a box can now be a focus target for
     * another reason — a `selectable` document is one (a11y.js) — and a
     * document that does not scroll must still leave the arrows alone. */
    _scrollsWithKeys() {
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
    defaultKeyDown(ev) {
      // nothing to scroll, nothing to swallow: a plain box must leave the
      // arrows and Page keys to whatever else would answer them
      if (!this._scrollsWithKeys()) return super.defaultKeyDown(ev);
      const step = SCROLL_KEY_STEP * this.scale;
      const page = Math.max(
        1,
        this.abs.height - SCROLL_KEY_PAGE_OVERLAP * this.scale,
      );
      // Left and Right are the directions on the *screen*, and `scrollX` runs
      // from the start of the content — so which of them moves it forward
      // depends on which way the content runs. Home/End and the Page keys
      // need no such rule: they already name the logical ends.
      const forward = this.direction === 'rtl' ? -step : step;
      switch (ev.keysym) {
        case XK_DOWN:
          return this._scrollByDevice(0, step);
        case XK_UP:
          return this._scrollByDevice(0, -step);
        case XK_RIGHT:
          return this._scrollByDevice(forward, 0);
        case XK_LEFT:
          return this._scrollByDevice(-forward, 0);
        case XK_PAGE_DOWN:
          return this._scrollByDevice(0, page);
        case XK_PAGE_UP:
          return this._scrollByDevice(0, -page);
        case XK_HOME:
          return this._scrollToDevice({ y: 0 });
        case XK_END:
          return this._scrollToDevice({ y: this._maxScroll('y') });
        case XK_SPACE:
          return this._scrollByDevice(0, ev.shiftKey ? -page : page);
        default:
          return super.defaultKeyDown(ev);
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
      if (!node || !this.isScroller()) return;
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
        if (!n.yoga) return; // not (or no longer) inside this viewport
        top += n.yoga.getComputedTop();
        left += n.yoga.getComputedLeft();
        if (!n.parent) return;
      }
      const bottom = top + target.yoga.getComputedHeight();
      // Horizontally the two edges are measured from the content's **start**,
      // the same units `scrollX` is in — so under RTL the target's near edge
      // is its right one and both are counted back from the viewport's width.
      const w = target.yoga.getComputedWidth();
      const near =
        this.direction === 'rtl'
          ? this.yoga.getComputedWidth() - left - w
          : left;
      const far = near + w;
      if (bottom > this.scrollY + this.abs.height) {
        this.scrollY = bottom - this.abs.height;
      }
      if (top < this.scrollY) this.scrollY = top;
      if (far > this.scrollX + this.abs.width) {
        this.scrollX = far - this.abs.width;
      }
      if (near < this.scrollX) this.scrollX = near;
    }

    paint(ctx) {
      super.paint(ctx);
      this._paintScrollbars(ctx);
    }

    /** Over the content and outside the clip — a `<window>` reaches this by
     * its own route, since it paints through `_paintRegion` and never
     * through `Node.paint`. */
    _paintScrollbars(ctx) {
      for (const bar of this._scrollbars()) {
        paintScrollbarThumb(ctx, bar, this.props.scrollbarColor);
      }
    }

    /** null when this is not a scroll container, when the bar is switched
     * off, or when there is nothing to scroll on that axis. */
    _scrollbar(axis = 'y') {
      if (!this.isScroller() || this.props.scrollbar === false) return null;
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
        inset: 2 * this.scale,
        shorten: other ? (SCROLLBAR_WIDTH + 2) * this.scale : 0,
        direction: this.direction,
        scale: this.scale,
      });
    }

    _scrollbars() {
      if (!this.isScroller()) return EMPTY_SCROLLBARS;
      return [this._scrollbar('y'), this._scrollbar('x')].filter(Boolean);
    }

    /**
     * The bar belongs to the scroller, not to the content under it — the same
     * rule a browser applies. Without this a press on the thumb would be
     * delivered to whatever child happens to be painted beneath it.
     */
    hitTest(x, y) {
      if (this.isScroller()) {
        for (const bar of this._scrollbars()) {
          if (scrollbarHit(bar, x, y)) return this;
        }
      }
      return super.hitTest(x, y);
    }

    defaultMouseDown(ev) {
      // bar geometry is device pixels; the synthetic event is logical, so
      // the hit tests here read the native coordinates
      const nx = ev.nativeEvent?.x ?? ev.x * this.scale;
      const ny = ev.nativeEvent?.y ?? ev.y * this.scale;
      for (const bar of this._scrollbars()) {
        const hit = scrollbarHit(bar, nx, ny);
        if (!hit) continue;
        const at = along(bar, nx, ny);
        if (hit === 'thumb') {
          // remember where in the thumb it was grabbed, so it does not jump
          this._barGrab = { axis: bar.axis, offset: at - bar.thumbStart };
          ev.capturePointer();
          return;
        }
        // a press on the track pages towards it, like PageUp/PageDown — and
        // "towards it" is a visual direction, so it flips with the bar
        const page = bar.axis === 'x' ? this.abs.width : this.abs.height;
        const back = at < bar.thumbStart ? !bar.reversed : bar.reversed;
        const delta = back ? -page : page;
        if (bar.axis === 'x') this._scrollByDevice(delta, 0);
        else this._scrollByDevice(0, delta);
        return;
      }
      // no bar under the press: it belongs to whatever is behind the bars,
      // which for a `selectable` pane is the selection (issue #259)
      super.defaultMouseDown(ev);
    }

    defaultMouseDrag(ev) {
      if (this._barGrab == null) return super.defaultMouseDrag(ev);
      const bar = this._scrollbar(this._barGrab.axis);
      if (!bar || bar.travel <= 0) return;
      const nx = ev.nativeEvent?.x ?? ev.x * this.scale;
      const ny = ev.nativeEvent?.y ?? ev.y * this.scale;
      const at = along(bar, nx, ny) - this._barGrab.offset - bar.trackStart;
      const from = bar.reversed ? bar.travel - at : at;
      const to = (from / bar.travel) * bar.range;
      this._scrollToDevice(bar.axis === 'x' ? { x: to } : { y: to });
    }

    defaultMouseUp(ev) {
      if (this._barGrab != null) {
        this._barGrab = null;
        return;
      }
      super.defaultMouseUp(ev);
    }
  };

/**
 * The flex container — and, with `overflow: 'scroll'`, the scroll container
 * too. There is no separate scrolling element: see `Scrollable`.
 */
export class BoxNode extends Scrollable(Node) {
  constructor(props, app) {
    super('box', props, app);
  }

  /** A box draws a fill and a border and no text at all, so a new ink or a
   * new face costs it nothing — it is only ever the *source* of one. The
   * nodes inside it claim their own damage as the walk reaches them, which
   * keeps hovering a long list bounded to the labels rather than to the
   * list. */
  _textStyleMoved() {}
}

/**
 * The one call `onDraw`'s translation cannot reach (#366).
 *
 * `putImageData` ignores the context's transform and clip — the HTML canvas
 * rule, kept by ntk — so inside `onDraw`, whose whole contract is "you are at
 * the node's origin", it is the one call whose coordinates are still the
 * drawable's own. Nothing errors; the pixels simply land at the window
 * origin instead of in the node. `DrawInfo.x`/`.y` is the way to say it
 * right, and development watches for the write that says it wrong: a
 * destination outside the node's box. Once per process — one thread to pull
 * is enough, and `onDraw` runs on every repaint.
 */
let warnedPutImageData = false;
export function resetPutImageDataWarningForTests() {
  warnedPutImageData = false;
}

/** The rect `putImageData(data, x, y, …dirty)` actually writes — the spec's
 *  dirty-rect normalisation, reproduced so the watch judges the write and
 *  not the whole source image (a correct call may blit a window of a bigger
 *  atlas). Null when the write is empty. */
function putImageDataDest(data, x, y, dx = 0, dy = 0, dw, dh) {
  const width = data?.width ?? 0;
  const height = data?.height ?? 0;
  dw ??= width;
  dh ??= height;
  if (dw < 0) {
    dx += dw;
    dw = -dw;
  }
  if (dh < 0) {
    dy += dh;
    dh = -dh;
  }
  const sx = Math.max(0, dx);
  const sy = Math.max(0, dy);
  const sw = Math.min(width, dx + dw) - sx;
  const sh = Math.min(height, dy + dh) - sy;
  if (!(sw > 0) || !(sh > 0)) return null;
  return { x: x + sx, y: y + sy, width: sw, height: sh };
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
    // event handler, so `paintChanged` skips it and this is the only place
    // that notices. Damage is bounded to this canvas: an unbounded call here
    // made every re-render of a component that draws through <canvas> repaint
    // the whole window, which is what a Checkbox's tick and a Select's chevron
    // both do.
    if (newProps.onDraw !== before.onDraw) {
      this.root?.invalidate(false, this, 'props');
    }
  }

  /**
   * The ink a `mono` drawing is painted in: the node's own `color`, then what
   * it inherits, then the palette's — exactly as `<text>` and `<svg>` resolve
   * theirs, because it is literally the same resolution. An `<Icon>` in a
   * row that dims itself dims with it, with nothing handed over at the call
   * site.
   */
  _monoColor() {
    return this.resolvedTextStyle().color;
  }

  /** Preset the ink a `mono` drawing inherits, so `onDraw` never names a
   *  colour of its own. Called inside the `save()`/`restore()` pair. */
  _presetMono(ctx, color) {
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
  }

  paintContent(ctx) {
    const onDraw = this.props.onDraw;
    if (typeof onDraw !== 'function') return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(this.abs.x, this.abs.y, this.abs.width, this.abs.height);
    ctx.clip();
    ctx.translate(this.abs.x, this.abs.y);
    if (this.props.mono) this._presetMono(ctx, this._monoColor());
    const unwatch = DEV ? this._watchPutImageData(ctx) : null;
    try {
      // Device pixels, the browser's own canvas contract: the backing
      // store is the panel's grid and `scale` says how many of its pixels
      // one logical pixel is worth. Deliberately NOT a ctx.scale() — ntk
      // positions glyphs through the transform but sizes them from the
      // font, so a scaled transform would move an app's fillText without
      // growing it (src/scale.js).
      onDraw(ctx, {
        width: this.abs.width,
        height: this.abs.height,
        // the translation above, said out loud: raw-pixel calls address the
        // drawable itself, so they are written at `info.x + x` (#366)
        x: this.abs.x,
        y: this.abs.y,
        scale: this.scale,
        node: this,
      });
    } finally {
      unwatch?.();
      ctx.restore();
    }
  }

  /**
   * Shadow `ctx.putImageData` for the length of one `onDraw`, and warn on a
   * write whose destination escapes the node's box — either coordinates
   * that were never offset by `info.x`/`info.y`, which is the trap the
   * watch exists for, or a drawing genuinely reaching outside bounds every
   * other call is clipped to. The box test has a pixel of slack per edge:
   * `abs` can sit on a fractional grid, and a rounded `info.x` must not
   * read as an escape. Development only, and the shadow is not installed
   * again once the warning has fired, so steady state costs nothing.
   */
  _watchPutImageData(ctx) {
    const original = ctx.putImageData;
    if (warnedPutImageData || typeof original !== 'function') return null;
    const hadOwn = Object.hasOwn(ctx, 'putImageData');
    const node = this;
    ctx.putImageData = function (data, x, y, ...dirty) {
      const dest = putImageDataDest(data, x, y, ...dirty);
      const box = node.abs;
      if (
        !warnedPutImageData &&
        dest &&
        (dest.x < box.x - 1 ||
          dest.y < box.y - 1 ||
          dest.x + dest.width > box.x + box.width + 1 ||
          dest.y + dest.height > box.y + box.height + 1)
      ) {
        warnedPutImageData = true;
        const owner = ownerName(node);
        console.warn(
          `react-x11: putImageData in <canvas onDraw>${owner ? ` (in ${owner})` : ''} ` +
            `wrote ${dest.width}x${dest.height} at ${dest.x},${dest.y} — outside the ` +
            `node, which is ${box.width}x${box.height} at ${box.x},${box.y}. ` +
            "putImageData ignores the context's transform (the HTML canvas rule), " +
            "so unlike every other call in onDraw its coordinates are the drawable's, " +
            "not the node's. Add the node's origin, which onDraw is handed: " +
            'ctx.putImageData(data, info.x + x, info.y + y). Better, draw through an ' +
            'image source — it honours the transform and the clip, and caches its ' +
            'upload server-side: ctx.drawImage(new Image({ width, height, data }), x, y), ' +
            'with Image from \'react-x11/ntk\'. See docs/elements.md, "<canvas>".',
        );
      }
      return original.call(ctx, data, x, y, ...dirty);
    };
    return () => {
      if (hadOwn) ctx.putImageData = original;
      else delete ctx.putImageData;
    };
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
   * `<canvas>` needs no `paintCached` of its own beyond the mono preset: it
   * already draws origin-relative, so the cached render and the live one are
   * the same code.
   *
   * ## `mono`: coverage, and the colour out of the key
   *
   * `<canvas mono>` is a promise about the drawing — *everything I paint is
   * one colour, and it is not mine to choose*. `onDraw` then names no colour
   * at all: `fillStyle` and `strokeStyle` arrive preset from `style.color`.
   *
   * That promise is what lets the entry be an **a8 coverage** surface with
   * the colour applied at blit time, so the colour leaves the key: one
   * rendered copy of a chevron serves the resting row, the highlighted row,
   * the disabled one and both schemes. Without it each colour is a separate
   * argb32 entry, which for an icon in four states is four rasterizations
   * and four pixmaps of the same shape. `SvgView.paintKind` decides the same
   * thing by scanning the document; a closure cannot be scanned, so here the
   * author says it.
   *
   * A drawing that sets its own `fillStyle` under `mono` is a bug the digest
   * catches: colour is out of the key, so two colours of one drawing collide
   * on one entry and `REACT_X11_PAINT_CACHE=verify` complains.
   *
   * Needs **ntk ≥ 7.3.3**, and the floor is not cosmetic. Coverage
   * composites through ntk's `_drawCoverage`, which routes a clip it cannot
   * express as a rectangle through a scratch mask — and before 7.3.3 that
   * path read the surface-sized mask from the origin rather than from the
   * destination, so anything not drawn at (0, 0) was masked out entirely
   * (sidorares/ntk#243). Nested rounded clips are the common case, not an
   * exotic one: `examples/tasks.jsx` puts a checkbox tick under a rounded
   * card, a scrolled list, a rounded row and a rounded well, and five of its
   * six ticks came out blank. `package.json` carries the floor.
   */
  paintCachePlan() {
    const { cacheKey, onDraw, mono } = this.props;
    if (cacheKey == null || typeof onDraw !== 'function') return null;
    const width = Math.ceil(this.abs.width);
    const height = Math.ceil(this.abs.height);
    if (width <= 0 || height <= 0) return null;
    const tint = mono ? this._monoColor() : null;
    // Nothing to composite through: an unpainted colour would blit the
    // coverage as-is, which is not what "invisible" looks like.
    if (mono && !isPaintedColor(tint)) return null;
    return {
      key: `canvas|${width}x${height}@1|${mono ? 'mono|' : ''}${cacheKey}`,
      x: Math.round(this.abs.x),
      y: Math.round(this.abs.y),
      width,
      height,
      format: mono ? 'a8' : 'argb32',
      tint,
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
    // Into a coverage surface only the alpha of a paint survives and the
    // tint arrives at blit time, so any opaque colour renders the same mask.
    if (this.props.mono) this._presetMono(ctx, '#ffffff');
    try {
      onDraw(ctx, {
        width: box.width,
        height: box.height,
        // the drawing goes into a surface of its own here, so the node's
        // origin in it *is* the origin — and a raw-pixel write offset by
        // `info.x`/`info.y` for the live path stays correct under a cacheKey
        x: box.x,
        y: box.y,
        node: this,
      });
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

// An arrow key scrolls by a wheel notch — literally the one events.js
// converts a notch into, so the two input routes agree about what one step
// is however far a notch turns out to be.
const SCROLL_KEY_STEP = WHEEL_NOTCH_PX;
// A page keeps a sliver of the previous one on screen, so the eye has
// somewhere to land. Toolkits all keep a line or two; this is about that.
const SCROLL_KEY_PAGE_OVERLAP = 24;

/** Undo entries kept per input. Snapshots of a single field are small; the
 * cap is what stops a long-lived form from growing without bound. */
const UNDO_LIMIT = 200;

/**
 * How long a caret stays in each of its two states, in milliseconds, on a
 * desktop that did not say.
 *
 * A desktop that *did* say — `Net/CursorBlinkTime`, and `Net/CursorBlink: 0`
 * for "do not blink at all" — is read through `desktopSettings(app)` at the
 * moment a field takes focus. This is the floor under that, and what a
 * connection with no settings daemon uses; it lives in `desktopsettings.js`
 * beside the rest of them so there is one number rather than two.
 *
 * Exported from `react-x11/node` because an element that edits text draws
 * its own caret and would otherwise hardcode a second cadence — two carets
 * on one screen blinking against each other (issue #251). An element with a
 * live connection to hand should prefer `useDesktopSettings().caretBlinkMs`,
 * which is this value already reconciled with the desktop.
 */
export const CARET_BLINK_MS = DESKTOP_DEFAULTS.caretBlinkMs;

// --- the standard edit menu ------------------------------------------------
//
// Right-click gets Undo/Cut/Copy/Paste with no wiring, the way a browser
// gives `<input>` one. The rows cannot be `Menu` components — those are
// React over the nodes, and a node cannot mount one — so the menu is a
// `<popup>` built here with a `<canvas>` child that paints the rows
// (src/editmenu.js) and handles its own pointer and key events. That reuses
// the popup's pointer grab, dismissal and focus rather than reinventing
// them.
//
// `<textinput>` is a *caller* of this, not its owner (issue #256): the
// enablement rules, the PRIMARY/CLIPBOARD subtleties and the menu's keyboard
// handling are the parts a second editable element would otherwise have to
// re-debug, so they live here, once, behind a verb interface anything can
// speak.

/** Where the popup goes: at `at`, which is in the owner window's coordinates
 * the way a synthetic event's `x`/`y` are, pulled back inside the monitor
 * when the menu would hang off an edge of it. */
function editMenuOrigin(node, at, size) {
  const origin = windowOrigin(node);
  let x = origin.x + (Number.isFinite(at?.x) ? at.x : (node.abs?.x ?? 0));
  let y = origin.y + (Number.isFinite(at?.y) ? at.y : (node.abs?.y ?? 0));
  // the monitor's work area rather than the whole virtual desktop, so a menu
  // near a seam flips back onto the screen it was opened on — the same
  // answer `<ContextMenu>` clamps a pointer-anchored menu into. Clamped, not
  // flipped: there is no anchor rect to flip around.
  const area = deviceAnchorArea(node);
  if (area) {
    x = Math.max(area.x, Math.min(x, area.x + area.width - size.width));
    y = Math.max(area.y, Math.min(y, area.y + area.height - size.height));
  }
  return { x, y };
}

/**
 * Open the standard edit menu on `node`, for a target that speaks a small
 * verb interface.
 *
 * This is what `<textinput>`'s own right-click menu is, and the reason it is
 * exported is that everything about it except the verbs is worth having
 * once: which rows are enabled, Paste watching selection ownership rather
 * than asking the server on the way to opening a menu, the arrow keys and
 * Escape, the pointer grab that dismisses it, and handing the keyboard back
 * where it came from afterwards.
 *
 * ```js
 * openEditMenu(node, { x: ev.x, y: ev.y }, {
 *   canUndo: this.canUndo,  undo: () => this.undo(),
 *   canRedo: this.canRedo,  redo: () => this.redo(),
 *   hasSelection: this.hasSelection(),
 *   cut: () => this.cut(),
 *   copy: () => this.copy(),
 *   paste: () => this.paste(),
 *   selectAll: () => this.selectAll(),
 * });
 * ```
 *
 * **A verb you leave out is a row that is not there**, rather than a greyed
 * one — see `editMenuItems`. A read-only surface passes `hasSelection`,
 * `copy` and `selectAll` and gets a two-row menu; a password field passes no
 * `copy` and no `cut` and gets a menu that offers neither. Leave out every
 * verb and nothing opens at all.
 *
 * @param {Node} node the element the menu belongs to. The popup hangs off it
 *   in the tree, so it goes away with the element and counts as inside it
 *   for `:focus-within`.
 * @param {{x: number, y: number}} at where the pointer was, in the owner
 *   window's coordinates — `ev.x`/`ev.y` from the event that asked for the
 *   menu. A surface with no caret has nothing else to offer, and this is
 *   what it already has.
 * @param {object} actions the verbs, and what each is worth right now:
 *   `hasSelection` (Cut and Copy follow it), `canUndo`, `canRedo`,
 *   `canSelectAll` (defaults to true), and the functions `undo`, `redo`,
 *   `cut`, `copy`, `paste`, `selectAll`.
 */
export function openEditMenu(node, at, actions = {}) {
  closeEditMenu(node);
  if (!node?.root || node.destroyed) return;
  const app = node.app;
  const clipboard = app?.clipboard ?? null;
  // From here on the menu knows whether there is anything to paste. This
  // first open still shows the row enabled — the answer arrives after it
  // is drawn — which is the pre-tracking behaviour, and correct far more
  // often than not.
  if (typeof actions.paste === 'function') armPasteState(app, clipboard);
  const items = editMenuItems(actions, {
    // greyed only when the server has told us the selection is unowned
    // (pastestate.js). Never a round trip on the way to opening a menu.
    canPaste: Boolean(clipboard) && canPaste(app),
  });
  if (items.length === 0) return;

  const style = node.resolvedTextStyle();
  const geometry = editMenuGeometry(
    items,
    (text) => app?.fonts?.layout(text, style)?.width,
  );
  // `at` is `{x: ev.x, y: ev.y}` per the doc above — logical, like every
  // coordinate a handler reads — and the origin math below is device.
  const s = node.scale;
  const deviceAt = at && {
    ...at,
    ...(Number.isFinite(at.x) && { x: at.x * s }),
    ...(Number.isFinite(at.y) && { y: at.y * s }),
  };
  const { x, y } = editMenuOrigin(node, deviceAt, geometry);
  const colors = editMenuColors(node.theme);
  const state = { active: -1 };
  const choose = (id) => {
    closeEditMenu(node);
    // the target's own entry point, so the row can never drift from what
    // the equivalent shortcut does
    if (id) actions[id]?.();
  };

  const canvas = new CanvasNode(
    {
      focusable: true,
      style: { flexGrow: 1 },
      onDraw: (ctx) =>
        paintEditMenu(ctx, {
          geometry,
          active: state.active,
          colors,
          radius: node.theme?.radius ?? 4,
          layoutOf: (text, color) =>
            app?.fonts?.layout([{ text, ...style, color }], style),
        }),
      onMouseMove: (mv) => {
        const next = editMenuIndexAt(geometry, mv.nativeEvent?.y ?? mv.y * s);
        if (next === state.active) return;
        state.active = next;
        popup.invalidate(false, null, 'style-state');
      },
      onMouseUp: (mv) => {
        const i = editMenuIndexAt(geometry, mv.nativeEvent?.y ?? mv.y * s);
        if (i !== -1) choose(geometry.rows[i].id);
        else closeEditMenu(node);
      },
      onKeyDown: (k) => {
        if (k.keysym === XK_ESCAPE) return closeEditMenu(node);
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
          if (row && !row.separator) choose(row.id);
        }
      },
    },
    app,
  );

  const popup = new PopupNode(
    app,
    {
      x,
      y,
      width: geometry.width,
      height: geometry.height,
      windowType: 'popup_menu',
    },
    {
      // **The size goes in the props, not only in the attributes.** A
      // `<window>`/`<popup>` size is `'auto'` when the props do not name one,
      // and `realize()` then *measures* the content and overwrites whatever
      // the attributes said (issue #248) — which for a canvas that only
      // `flexGrow`s is nothing at all, so this popup opened 1x1 and the menu
      // was invisible. Every other popup in the tree comes from React, where
      // one props object is both, so nothing else could reach it.
      // Props are the logical contract (`_measure` multiplies them back);
      // the attributes above carry the same size already in device pixels.
      width: geometry.width / s,
      height: geometry.height / s,
      grab: true,
      // a press outside the menu closes it and goes no further, which is
      // what the grab is for
      onDismiss: () => closeEditMenu(node),
    },
  );
  popup.insertBefore(canvas, null);
  node.insertBefore(popup, null);
  popup.realize(null);
  // the rows as they were built, for a test to read: they are painted into a
  // canvas, so there is no tree for `screen` to query them out of
  popup._editMenuRows = geometry.rows;
  node._editMenu = popup;
  // read *before* the menu takes the keyboard, and handed back on close
  node._editMenuRestore = node._focusManager()?.focused ?? null;
  // the menu takes the keyboard so arrows and Escape reach it rather than
  // the element behind it
  popup.events?.focus?.(canvas);
}

/** Whether `node` has the standard edit menu open. An element that paints a
 * selection asks: the popup holds the keyboard, so the element is not
 * focused, and the text the menu is about to act on has to stay visibly
 * selected. */
export function editMenuOpen(node) {
  return Boolean(node?._editMenu);
}

/** Close it, if it is open. The menu closes itself on a choice, a press
 * outside and Escape; this is for an element that has decided the menu no
 * longer applies — its content changed underneath it, or it scrolled. */
export function closeEditMenu(node) {
  const popup = node?._editMenu;
  if (!popup) return;
  node._editMenu = null;
  const restore = node._editMenuRestore;
  node._editMenuRestore = null;
  // the popup is a child, so a node destroyed while its menu was up took the
  // menu with it: there is nothing left to remove and nowhere to hand the
  // keyboard back to
  if (node.destroyed) return;
  node.removeChild(popup);
  const events = node._focusManager();
  if (!events) return;
  // focus goes back where the menu took it from, so typing carries on where
  // it left off — as a pointer focus, since a right-click is what opened the
  // menu and a ring appearing on the way back would be news to nobody. A
  // surface that was not focusable in the first place, or that stopped being
  // on screen while the menu was up, gets nothing back rather than the
  // destroyed menu canvas keeping the keyboard.
  events.focus(events._canRestoreTo(restore) ? restore : null, 'pointer');
}

/** The caret's own width, in *logical* pixels — it is a rectangle rather
 * than a line because a hairline disappears in a sea of dense pixels.
 * Multiplied by the node's scale where it is drawn and reserved for, like
 * every paint constant that never passes through a style (src/scale.js). */
const CARET_WIDTH = 1.5;

/** The room a line of a field's text leaves for the caret that follows it,
 * at the right-hand edge of the content box in both directions — see
 * `TextInputNode._lineOriginX`, which is where the asymmetry is explained.
 * Logical, like CARET_WIDTH. */
const CARET_RESERVE = 2;

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
    // a field's selection is its own: a `selectable` document around it does
    // not get to light up half of what is being typed, and the two take turns
    // being the one selection on screen (textselection.js)
    this.hasOwnSelection = true;
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
    // the uncommitted composition: what a pending dead key or an open
    // Compose sequence is showing, and where it sits in the value. Never
    // part of `value`, and never in the history — see `defaultComposition`
    this._preedit = '';
    this._preeditAt = 0;
    // the open edit menu, if any (see `openEditMenu`)
    this._editMenu = null;
  }

  /** A preferred width, capped to whatever is on offer — `Infinity` when
   * nothing is, which is what makes the `Math.min` the whole rule. */
  measureContent({ width }) {
    // `_capBand` rounds, and a trimmed `<text>` rounds the same band the
    // same way — rounding one of them and not the other is a pixel of
    // difference between a field and the button beside it.
    return { width: Math.min(150, width), height: this._capBand() };
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
      shiftKey: Boolean(native?.buttons & MOD.Shift),
      ctrlKey: Boolean(native?.buttons & MOD.Control),
      altKey: Boolean(native?.buttons & MOD.Alt),
      metaKey: Boolean(native?.buttons & MOD.Super),
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
    return codePoints(this.value);
  }

  // --- composition ---------------------------------------------------------
  //
  // A composition is text the user is still typing: a dead key that has not
  // met its letter yet, or a Compose sequence half entered (src/compose.js).
  // It is shown at the caret and underlined, and it is deliberately *not*
  // the value:
  //
  // - `value`, `onChange` and the undo history never see it, so a commit is
  //   one entry rather than one per keystroke, and Ctrl+Z after `dead_acute`
  //   + `e` steps over `é` rather than into it;
  // - a **controlled** field whose parent rewrites `value` mid-composition
  //   cannot corrupt the buffer, because the buffer is not in the value.
  //   That is the classic web bug, and it is structurally absent here;
  // - abandoning it — Escape, focus leaving, a press elsewhere — is
  //   dropping a string, not undoing an edit.
  //
  // The one thing it does change is the *displayed* string, which is what
  // `_displayValue` is: everything measuring or hit-testing goes through
  // that, and `_displayIndex` is the door between the two index spaces.

  /** Where the composition sits in the value — clamped, because a
   * controlled parent may have replaced the value under it. */
  _preeditStart() {
    return Math.min(this._preeditAt, this._chars().length);
  }

  /** The string the field draws — the value with any composition spliced in
   * where it will land. */
  _displayValue() {
    if (!this._preedit) return this.value;
    const chars = this._chars();
    const at = this._preeditStart();
    return (
      chars.slice(0, at).join('') + this._preedit + chars.slice(at).join('')
    );
  }

  /** A value index in the displayed string. The caret is at the composition
   * while it is open, so it maps to the *end* of the preedit — which is
   * where the next keystroke of the sequence appears. */
  _displayIndex(index) {
    if (!this._preedit) return index;
    return index >= this._preeditStart()
      ? index + Array.from(this._preedit).length
      : index;
  }

  /** The inverse, for indices that come back out of a layout. A hit inside
   * the preedit answers where the preedit starts: the composition is one
   * thing, not a run of characters to put a caret between. */
  _valueIndex(index) {
    if (!this._preedit) return index;
    const start = this._preeditStart();
    if (index <= start) return index;
    return Math.max(start, index - Array.from(this._preedit).length);
  }

  _setPreedit(text) {
    if (text === this._preedit) return;
    if (!this._preedit) this._preeditAt = this._selection()[0];
    this._preedit = text;
    this._repaint();
  }

  /**
   * The composition default action, after `onCompositionStart` /
   * `onCompositionUpdate` / `onCompositionEnd` have had their say.
   *
   * `compositionEnd` carries the text the sequence produced — empty when it
   * was abandoned — and inserting it is an ordinary edit, so it replaces the
   * selection, respects `maxLength`, fires `onChange` and joins the undo run
   * the surrounding typing is in. `é` undoes like the letter it is.
   */
  defaultComposition(ev) {
    if (ev.type !== 'compositionEnd') {
      this._setPreedit(ev.data);
      return;
    }
    this._setPreedit('');
    if (!ev.data) return;
    // the same bookkeeping `defaultKeyDown` does, so the `onChange` this
    // produces carries the keystroke that committed the sequence
    const previous = this._keyNative;
    this._keyNative = ev.nativeEvent ?? null;
    try {
      this._insert(ev.data, 'type');
    } finally {
      this._keyNative = previous;
    }
  }

  _layoutOf(text) {
    const fonts = this.app?.fonts;
    if (!fonts) return null;
    const style = this.resolvedTextStyle();
    return fonts.layout(text, style);
  }

  _lineHeight() {
    const layout = this._layoutOf('Mg');
    if (layout) return layout.height;
    // No fonts to measure with. `resolvedTextStyle()` rather than the style
    // prop alone, so the guess is made at the size this field inherits — the
    // palette's — and not at 14 whatever the theme said.
    return this.resolvedTextStyle().size * 1.4;
  }

  /**
   * What one line of this field is *worth* vertically: the capitals down to
   * the baseline, which is what its padding is measured from.
   *
   * The same rule every label follows — `textBoxTrim: 'cap-alphabetic'` in
   * styling.md — reached a different way, because a field cannot trim. Its
   * caret and its selection are measured against the full line box, and the
   * glyphs have to be able to hang out of the box for the descenders to be
   * there at all; so the *box* is the cap band and the drawing is clipped to
   * the padding box instead, one step out. A field and a `<Button>` with the
   * same padding are then the same height, which is the whole point: they sit
   * next to each other on every form there has ever been.
   */
  /**
   * The rectangle the text may draw in: the padding box horizontally
   * unchanged, vertically grown out to where the border starts. `<textarea>`
   * keeps the content box, because its box *is* line boxes and nothing hangs
   * out of it.
   */
  _inkClip(content) {
    const box = this.abs;
    const top = box.y + this.yoga.getComputedBorder(Yoga.EDGE_TOP);
    const bottom =
      box.y + box.height - this.yoga.getComputedBorder(Yoga.EDGE_BOTTOM);
    return {
      x: content.x,
      y: Math.min(content.y, top),
      width: content.width,
      height: Math.max(content.height, bottom - Math.min(content.y, top)),
    };
  }

  /** Whole pixels either way: a field's height is a flex item's main size,
   *  and a fractional one costs the tree its content floors (see
   *  `TextNode._trim`, issue #411). The face with no `capHeight` to round is
   *  the one that reaches the fallback. */
  _capBand() {
    const style = this.resolvedTextStyle();
    const cap = this.app?.fonts
      ?.match?.(style.family, { weight: style.weight, style: style.style })
      ?.metrics?.(style.size)?.capHeight;
    return Math.round(cap || this._lineHeight());
  }

  /** Shaped layout of the current value, cached per (value, style,
   * direction).
   * Caret math rides ntk >= 3.3.0's TextLayout caret API, which is exact
   * across kerning/shaping boundaries, bidi runs and trailing whitespace
   * (replaces the prefix-width measurement this used before).
   *
   * Laid out at its **natural width**, with no `maxWidth` and no `align`:
   * a single-line field never wraps, and a `maxWidth` is what makes ntk
   * break lines. So the alignment ntk would have applied inside the layout
   * box is applied to the box instead, by `_lineOriginX` — see there. */
  _valueLayout() {
    const fonts = this.app?.fonts;
    if (!fonts) return null;
    const text = this._displayValue();
    const s = this.resolvedTextStyle();
    const direction = this.direction;
    const key = `${text}|${s.family}|${s.size}|${s.weight}|${s.style}|${direction}`;
    if (this._valueLayoutKey !== key) {
      this._valueLayoutKey = key;
      this._valueLayoutCache = fonts.layout(text, s, { direction });
    }
    return this._valueLayoutCache;
  }

  /** Visual caret x for a logical code-point index **in the value**. */
  _prefixWidth(count) {
    return this._prefixWidthAt(this._displayIndex(count));
  }

  /** The same, for an index in the displayed string — which is the value
   * unless a composition is showing. */
  _prefixWidthAt(index) {
    const layout = this._valueLayout();
    if (!layout) return 0;
    return layout.caretPosition(index).x;
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
    // every edit, caret move and selection change funnels through here
    a11yHooks.textState?.(this);
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

  /**
   * Put the selection on a selection — unless this input is `sensitive`.
   *
   * Every route out of the field funnels through here: Ctrl+C, the copy half
   * of Ctrl+X, the right-click menu, and the select-to-own that hands PRIMARY
   * to a middle click in some other application. One gate covers them all,
   * which is the reason the field is the thing that knows it holds a secret
   * rather than each of the six callers.
   *
   * The reason a *revealed* password field still refuses: what is on screen
   * stops being on screen when the field is hidden again, and what is on the
   * clipboard does not. Any client on the display can ask for it, and a
   * clipboard manager will have written it down.
   */
  _copySelection(selection = 'CLIPBOARD') {
    if (this.props.sensitive) return;
    const text = this._selectedText();
    if (!text) return;
    this._clipboardApi()
      // ICCCM 2.1: the timestamp of the event that triggered the copy is
      // what arbitrates a race with another app copying at the same moment.
      // It also saves ntk a round trip asking the server for one, which on
      // PRIMARY is a round trip per selection-extending keystroke.
      ?.write(text, { selection, time: lastInputTime(this.app) })
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
      ?.read({ selection, time: lastInputTime(this.app) })
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
   *
   * `_editKeyDown` answers **whether it took the key**, and a key it took is
   * consumed the way every default action says so: `preventDefault()`, whose
   * meaning one layer down is "the default action after this one does not
   * run". That is what keeps Ctrl+C in a focused field rather than in the
   * menu's accelerator for it, on the same rule Tab and Space/Enter already
   * follow (#351) — and it is why the ctrl chord below returns false for the
   * letters it does *not* answer, instead of swallowing every chord in the
   * alphabet.
   */
  defaultKeyDown(ev) {
    const previous = this._keyNative;
    this._keyNative = ev.nativeEvent ?? null;
    try {
      if (this._editKeyDown(ev)) ev.preventDefault();
    } finally {
      this._keyNative = previous;
    }
  }

  /** @returns {boolean} whether the field answered this key. */
  _editKeyDown(ev) {
    const [a, b] = this._selection();
    const hasSelection = a !== b;
    const k = ev.keysym;

    if (k === XK_RETURN || k === XK_KP_ENTER) {
      this._fireValueEvent('onSubmit', this.value, ev.nativeEvent);
      return true;
    }
    if (k === XK_BACKSPACE) {
      if (hasSelection) this._deleteRange(a, b);
      else if (ev.ctrlKey) this._deleteRange(this._wordBoundary(a, -1), a);
      else if (a > 0) this._deleteRange(a - 1, a, 'delete-back');
      return true;
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
      return true;
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
      return true;
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
      return true;
    }
    if (k === XK_HOME) {
      this._moveCaret(0, ev.shiftKey);
      return true;
    }
    if (k === XK_END) {
      this._moveCaret(this._chars().length, ev.shiftKey);
      return true;
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
      } else {
        // A chord this field has no answer for is not the field's: Ctrl+S
        // belongs to whatever bound it, and a text control that swallowed
        // every chord would be a text control no application can put a
        // shortcut behind.
        return false;
      }
      return true;
    }
    if (ev.codepoint != null && ev.codepoint >= 0x20 && ev.codepoint !== 0x7f) {
      const ch = String.fromCodePoint(ev.codepoint);
      this._insert(ch, 'type');
      // undo a word at a time: the space that ends a word joins the run it
      // ends, and the next word starts a fresh one
      if (/\s/.test(ch)) this._breakUndoRun();
      return true;
    }
    return false;
  }

  /** Click-to-caret for a mouse event. Both kinds answer it the same way —
   * through the field's own geometry accessor, which is the one the caret
   * and the highlight are drawn from. */
  _indexAtPoint(ev) {
    // `textIndexAt` is the device-pixel geometry contract (it is also what
    // the a11y bridge calls with screen points); the synthetic event is
    // logical, so the click goes back through its native coordinates.
    const native = ev.nativeEvent;
    return this.textIndexAt(
      native?.x ?? ev.x * this.scale,
      native?.y ?? ev.y * this.scale,
    );
  }

  /** Word range around a code-point index (whitespace-delimited). */
  _wordRangeAt(index) {
    return wordRangeAt(this._chars(), index);
  }

  /** Caret index one word away, the way Ctrl+arrow moves in a text editor. */
  _wordBoundary(from, dir) {
    return wordBoundary(this._chars(), from, dir);
  }

  // --- geometry (the accessors every text-bearing element answers) --------

  /**
   * Where a single line of text sits in the field, and the band a mark over
   * it fills. Centred on the **capitals**, not on the line box and not on
   * the ink.
   *
   * The layout box carries the line's leading entirely below the glyphs, so
   * centring that pushes the text visually up (see `halfLeading`). Centring
   * ascent + descent — what this did — fixes the leading but not the
   * asymmetry underneath it: a font's ascent clears its capitals by
   * `ascent - capHeight`, which is not its descent, so a single line of
   * text sits off-centre by a number that belongs to the typeface. At 14px
   * that is 0.7px of extra space above the capitals in SF NS and 2.5px the
   * other way in Helvetica — visible in a field, where there is one short
   * line and a border close on both sides to measure it against.
   *
   * So: put the baseline where the space above the capitals equals the
   * space under it. A `<text>` says the same thing as `textBoxTrim`, but a
   * field cannot trim its box — the caret and the selection are measured
   * against the full line box — so it moves the line instead, and the marks
   * follow because they are derived from the same origin.
   */
  _lineMetrics(layout, content, style) {
    const line = layout.lines?.[0];
    const inkHeight = line ? line.ascent + line.descent : layout.height;
    const ascent = line?.ascent ?? 0;
    // Where the painter puts the first baseline inside the layout box. It is
    // **not** `ascent`: the line carries its leading above the glyphs too, so
    // on a face with a real line gap the two are pixels apart. Verdana's gap
    // is 0.03em and the error rounds away; Hiragino Sans — which is what
    // `sans-serif` resolves to on a macOS box with Homebrew's fontconfig
    // first on PATH (#86) — carries 0.5em, and every field drew its text
    // three pixels low. Positioning by `ascent` was the whole of that bug.
    const baseline = line?.baseline ?? ascent;
    const leading = baseline - ascent;
    const capHeight = this.app?.fonts
      ?.match?.(style.family, {
        weight: style.weight,
        style: style.style,
      })
      ?.metrics?.(style.size)?.capHeight;
    const textY =
      capHeight && line
        ? content.y + (content.height + capHeight) / 2 - baseline
        : content.y + Math.max(0, (content.height - inkHeight) / 2) - leading;
    // The glyphs start a leading below the box they are drawn in, and the
    // marks are measured against the glyphs rather than against the box.
    const inkTop = textY + leading;
    // selection/caret read better with breathing room around the glyphs
    // (a DOM input highlights the whole line box, not just the ink)
    const markPad = Math.min(3, Math.max(0, inkTop - content.y));
    return {
      textY,
      markY: inkTop - markPad,
      markHeight: inkHeight + markPad * 2,
      inkHeight,
    };
  }

  /**
   * Where a line of the field's text starts, in window coordinates, before
   * the scroll offset — the whole of the field's horizontal placement, and
   * the only place that knows which edge the text is against.
   *
   * The line is laid out at its natural width (`_valueLayout`), so ntk had
   * no container to align it in and `line.x` is 0. This is that alignment:
   * `textAlign` resolved against the base direction, which is what puts an
   * RTL field's value, placeholder and caret on the right-hand side without
   * anybody asking for it.
   *
   * **The caret is why the reserve is at the right in both directions.** A
   * caret is a rectangle drawn *rightwards* from the boundary it marks, so
   * the one position that can fall outside the content box is the rightmost
   * one: the end of the text in LTR — which is what the `+ 2` in the scroll
   * clamp has always been keeping room for — and the *start* of it in RTL,
   * where the text is flush against the right edge and index 0 sits on it.
   * Without the reserve an empty RTL field has no visible caret at all.
   *
   * Alignment only has a say while the text fits. An overflowing field
   * scrolls, and `_scrollX: 0` means "showing the start of the value", so
   * the start edge is where an overflowing line is pinned whatever the
   * alignment says.
   */
  _lineOriginX(layout, content) {
    const rtl = this.direction === 'rtl';
    const free = content.width - CARET_RESERVE * this.scale - layout.width;
    let align = this.style.textAlign ?? 'start';
    if (align === 'start') align = rtl ? 'right' : 'left';
    else if (align === 'end') align = rtl ? 'left' : 'right';
    const offset = align === 'right' ? free : align === 'center' ? free / 2 : 0;
    return content.x + (rtl ? Math.min(free, offset) : Math.max(0, offset));
  }

  /**
   * How far the text is displaced by the scroll, signed. `_scrollX` counts
   * from the start of the value in both directions — the rule
   * `ScrollableNode` follows for a scroll box — and the start is the
   * right-hand edge when the field reads right to left, so the text it
   * uncovers is to the *left* and the displacement is the other way.
   */
  _scrollShift() {
    return this.direction === 'rtl' ? this._scrollX : -this._scrollX;
  }

  /** How far a value wider than its box can be scrolled. The reserve is the
   * caret's, the same one `_lineOriginX` keeps: at full scroll the far end
   * of the text stops short of the edge by exactly the width of the caret
   * that sits there. */
  _maxScrollX(layout, content) {
    return Math.max(
      0,
      layout.width - (content.width - CARET_RESERVE * this.scale),
    );
  }

  /** The value's layout and where it is drawn, in window coordinates. The
   * placeholder is not in it: the accessors answer about the text the field
   * holds, and an empty field holds none. */
  _placedValue() {
    const layout = this._valueLayout();
    if (!layout) return null;
    const content = this.contentBox();
    const metrics = this._lineMetrics(
      layout,
      content,
      this.resolvedTextStyle(),
    );
    return {
      layout,
      x: this._lineOriginX(layout, content) + this._scrollShift(),
      y: metrics.textY,
    };
  }

  /** The value. The indices below are into this string, in code points — an
   * open composition is spliced into what is *drawn* and never into what the
   * field holds, so it is not in here either. */
  textContent() {
    return this.value;
  }

  textIndexAt(x, y) {
    const placed = this._placedValue();
    if (!placed) return this._chars().length;
    return this._valueIndex(placed.layout.indexAt(x - placed.x, y - placed.y));
  }

  textCaretRect(index) {
    const placed = this._placedValue();
    if (!placed) return null;
    const caret = placed.layout.caretPosition(this._displayIndex(index));
    return {
      x: placed.x + caret.x,
      y: placed.y + caret.y,
      width: 0,
      height: caret.height,
    };
  }

  textRangeRects(start, end) {
    const placed = this._placedValue();
    if (!placed) return [];
    return rangeBands(
      placed.layout,
      this._displayValue(),
      this._displayIndex(start),
      this._displayIndex(end),
    ).map((band) => ({
      x: placed.x + band.x,
      y: placed.y + band.y,
      width: band.width,
      height: band.height,
    }));
  }

  defaultMouseDown(ev) {
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
    if (this._caret === this._anchor) return;
    // Whatever else on screen was showing a selection stops: the highlight
    // is a single-owner thing across the whole app, the way PRIMARY is
    // across the whole display (issue #259).
    takeVisibleSelection(this);
    this._copySelection('PRIMARY');
  }

  /** Another surface took the visible selection. Collapse, rather than only
   * stop drawing: two lit ranges on one screen is the state this exists to
   * prevent, and a field that kept its own would light it up again the next
   * time it was focused. */
  _selectionLost() {
    if (this._caret === this._anchor) return;
    this._anchor = this._caret;
    this._repaint();
  }

  /** The selection stays lit while its own menu is up: the popup holds the
   * keyboard, so `_focused` is false, but the text the menu is about to act
   * on has to stay visibly selected. */
  _showsSelection() {
    return this._focused || editMenuOpen(this);
  }

  defaultMouseDrag(ev) {
    if (!this._dragging) return;
    this._caret = this._indexAtPoint(ev);
    this._repaint();
  }

  defaultMouseUp() {
    if (!this._dragging) return;
    this._dragging = false;
    this._ownSelection();
  }

  // --- the built-in edit menu -----------------------------------------
  //
  // The menu itself is `openEditMenu` (above): core's, exported, and shared
  // with anything else that edits or selects text (#256). What is left here
  // is the only part that is the field's — which verbs it offers, and what
  // each of them is worth right now. `contextMenu={false}` opts out, as does
  // `preventDefault()` in an `onContextMenu` handler.

  /** The verbs the standard menu is opened with. Every one of them is the
   * keyboard path's own entry point, so a row can never drift from what its
   * shortcut does. */
  _editActions() {
    const [a, b] = this._selection();
    const length = this._chars().length;
    return {
      canUndo: this.canUndo,
      undo: () => this.undo(),
      canRedo: this.canRedo,
      redo: () => this.redo(),
      hasSelection: a !== b,
      // A `sensitive` field offers neither Cut nor Copy: they are not
      // disabled rows, they are absent, because a greyed Copy over a
      // password reads as a bug in the application rather than as a
      // decision. Paste stays — a secret still has to be got in.
      ...(this.props.sensitive
        ? null
        : {
            cut: () => {
              const [from, to] = this._selection();
              this._copySelection();
              if (from !== to) this._deleteRange(from, to);
            },
            copy: () => this._copySelection(),
          }),
      paste: () => this._pasteFrom(),
      canSelectAll: length > 0 && !(a === 0 && b === length),
      selectAll: () => this._selectAll(),
    };
  }

  defaultContextMenu(ev) {
    if (this.props.contextMenu === false) return;
    openEditMenu(this, { x: ev.x, y: ev.y }, this._editActions());
  }

  defaultFocus() {
    this._focused = true;
    this._caretOn = true;
    // The desktop's cadence, read at focus rather than at import: XSETTINGS
    // is started but not awaited by createRoot, so this is the first moment
    // it is reliably in — and a field focused before that gets the default
    // and the desktop's answer from the next focus on.
    const { caretBlink, caretBlinkMs } = desktopSettings(this.root?.app);
    // `Net/CursorBlink: 0` is an accessibility setting, not a preference: a
    // solid caret is still a caret, so the field draws one and never arms a
    // timer for it.
    if (caretBlink) {
      this._blinkTimer = setInterval(() => {
        // A field can still hold focus when the connection goes — an app
        // closing its own client, a server exit, a test closing the app it
        // lent the root. Nothing blurs the field on that route, so this is
        // the timer's own exit: the next tick would paint a caret onto a
        // closing connection and throw out of the frame clock, where there
        // is nothing to catch it.
        if (this.destroyed || this.app?.X?._closing) {
          clearInterval(this._blinkTimer);
          this._blinkTimer = null;
          return;
        }
        this._caretOn = !this._caretOn;
        // twice a second, forever, for as long as a field has focus: the one
        // repaint that most wants to cost only the field it happens in
        this.root?.invalidate(false, this, 'caret');
      }, caretBlinkMs);
      this._blinkTimer.unref?.();
    }
    this.root?.invalidate(false, this, 'focus');
  }

  defaultBlur() {
    this._focused = false;
    this._caretOn = false;
    // the EventManager ends an open composition before focus moves, so this
    // is the belt to that braces: a field that lost focus by some other
    // route must not keep drawing an accent nobody can finish
    this._preedit = '';
    // coming back to a field later is a new edit, not more of the old one
    this._breakUndoRun();
    clearInterval(this._blinkTimer);
    this._blinkTimer = null;
    this.root?.invalidate(false, this, 'focus');
  }

  destroySubtree() {
    clearInterval(this._blinkTimer);
    this._blinkTimer = null;
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
    // The face and the size arrive through `_textStyleMoved`, whether they
    // came from this commit or from an ancestor; what is left here is the
    // node-local half of the text vocabulary.
    if (localTextStyleChanged(this.style, beforeStyle)) {
      this.invalidateMeasure('props');
    } else if (newProps.value !== before.value) {
      // painting clips to the content box and the measure function reads
      // only font metrics, so a value change is confined to the field —
      // the same claim applyProps makes for any paint-only prop
      this.root?.invalidate(false, this, 'text');
    }
  }

  paintContent(ctx) {
    const fonts = this.app?.fonts;
    if (!fonts) return;
    const content = this.contentBox();
    if (content.width <= 0 || content.height <= 0) return;

    const style = this.resolvedTextStyle();
    const text = this._displayValue();
    const isEmpty = text.length === 0;
    const shown = isEmpty ? (this.props.placeholder ?? '') : text;
    const color = isEmpty
      ? (this.props.placeholderColor ?? this.theme.textMuted)
      : style.color;
    // The placeholder is the *field's* chrome rather than the user's
    // content, so it is laid out and placed at the field's own direction —
    // an English hint in an Arabic form starts at the right-hand edge with
    // everything else in the window.
    const layout = fonts.layout([{ text: shown, ...style, color }], style, {
      direction: this.direction,
    });
    const { textY, markY, markHeight } = this._lineMetrics(
      layout,
      content,
      style,
    );

    // Keep the caret inside the viewport — but only while the field is being
    // edited. The caret starts at the *end* of the value, so chasing it
    // unconditionally meant a field whose text is wider than its box rendered
    // scrolled to the end before anyone had touched it: the first characters
    // were simply missing, which reads as a rendering bug rather than as a
    // scroll position. An unfocused field shows the beginning of its value,
    // the way a DOM input does.
    //
    // The chase is in *visual* coordinates — how far the caret is from the
    // left of the content box once the value has been placed and scrolled —
    // because that is the question the viewport asks, and it is the same
    // question in both directions. Which way the scroll displaces the text
    // is `_scrollShift`'s business.
    const valueLayout = this._valueLayout();
    const caretX = this._prefixWidth(this._caret);
    // where the caret sits before the scroll, relative to the content box
    const caretAt = valueLayout
      ? this._lineOriginX(valueLayout, content) + caretX - content.x
      : caretX;
    const limit = content.width - CARET_RESERVE * this.scale;
    if (!this._focused) this._scrollX = 0;
    else {
      let shift = this._scrollShift();
      if (caretAt + shift > limit) shift = limit - caretAt;
      if (caretAt + shift < 0) shift = -caretAt;
      this._scrollX = this.direction === 'rtl' ? shift : -shift;
    }
    // The extent is the *value*'s, never the placeholder's: a hint longer
    // than the box is clipped, not scrolled, since nothing can move the caret
    // through it.
    this._scrollX = Math.max(
      0,
      Math.min(
        this._scrollX,
        valueLayout ? this._maxScrollX(valueLayout, content) : 0,
      ),
    );

    ctx.save();
    ctx.beginPath();
    // Clipped to the **padding** box, not the content box: the content box is
    // the cap band, and an ascender or a descender is outside it by
    // construction. The padding is where a field's own border stops the text
    // anyway, so this is the edge that was always meant.
    const clip = this._inkClip(content);
    ctx.rect(clip.x, clip.y, clip.width, clip.height);
    ctx.clip();
    const shift = this._scrollShift();
    // Where the ink goes, and where the marks over the value go. They are
    // the same origin whenever there is a value to mark: the two differ only
    // for an empty field, where the ink is the placeholder — as wide as the
    // hint and placed for it — and the caret still belongs to the value,
    // which is empty and sits at the start edge.
    const originX = this._lineOriginX(layout, content) + shift;
    const valueX = valueLayout
      ? this._lineOriginX(valueLayout, content) + shift
      : originX;

    const [a, b] = this._selection();
    if (this._showsSelection() && a !== b && !isEmpty && valueLayout) {
      // A **translucent** accent rather than an opaque light blue. The ink
      // on top is `style.color`, which this fill does not control, so an
      // opaque highlight has to be picked to contrast with it — and no one
      // colour does that on both a light and a dark palette. `#b3d4fc`
      // under the dark palette's near-white ink is 1.3:1, which is nothing.
      // Tinting the surface instead leaves the ink's own contrast intact.
      ctx.fillStyle =
        this.props.selectionColor ?? tint(this.theme.accent, 0.35);
      // One band per direction run, not one rectangle between the two caret
      // positions: a range is contiguous in logical order and a line is laid
      // out in visual order, so a selection that crosses into an Arabic word
      // covers two disjoint stretches of pixels and the single rect this
      // used to draw painted over text nobody had selected. The bands are
      // `textRangeRects`'s, so the highlight is the geometry the accessors
      // report; only the vertical extent is the field's own — a field
      // highlights the cap band with breathing room rather than the line box.
      for (const band of rangeBands(
        valueLayout,
        this._displayValue(),
        this._displayIndex(a),
        this._displayIndex(b),
      )) {
        ctx.fillRect(valueX + band.x, markY, band.width, markHeight);
      }
    }

    layout.draw(ctx, originX, textY);
    this._paintPreedit(ctx, valueX, textY, style);

    if (this._focused && this._caretOn && a === b) {
      ctx.fillStyle = this.props.caretColor ?? style.color;
      ctx.fillRect(
        valueX + caretX,
        markY,
        CARET_WIDTH * this.scale,
        markHeight,
      );
    }
    ctx.restore();
  }

  /**
   * Underline the composition. The convention every toolkit shares, and the
   * reason it is worth having: the accent showing at the caret is text the
   * user has not typed yet, and nothing else about it says so — it is in the
   * field's own ink, in the field's own font, where the next character will
   * be. The line is what makes it provisional.
   */
  _paintPreedit(ctx, originX, originY, style) {
    if (!this._preedit) return;
    const layout = this._valueLayout();
    if (!layout?.lines?.length) return;
    const start = this._preeditStart();
    const from = layout.caretPosition(start);
    const to = layout.caretPosition(start + Array.from(this._preedit).length);
    ctx.fillStyle = style.color;
    // a span per line rather than one rectangle, because `<textarea>` shares
    // this and a composition at a wrap point is two spans — drawn as one
    // batch, so the underline costs one request however it wraps
    const rects = [];
    for (let li = from.line; li <= to.line; li++) {
      const line = layout.lines[li];
      if (!line) break;
      const x0 = li === from.line ? from.x : line.x;
      const x1 = li === to.line ? to.x : line.x + line.width;
      if (x1 <= x0) continue;
      rects.push(originX + x0, originY + line.y + line.ascent + 1, x1 - x0, 1);
    }
    if (rects.length) ctx.fillRects(rects);
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
  defaultMouseDown(ev) {
    const bar = this._scrollbar();
    // device coordinates against device bar geometry, as in Scrollable
    const nx = ev.nativeEvent?.x ?? ev.x * this.scale;
    const ny = ev.nativeEvent?.y ?? ev.y * this.scale;
    const hit = scrollbarHit(bar, nx, ny);
    if (!hit) return super.defaultMouseDown(ev);
    if (hit === 'thumb') {
      this._barGrab = ny - bar.thumbStart;
      ev.capturePointer();
      return;
    }
    const page = this.contentBox().height;
    this._scrollTo(this._scrollY + (ny < bar.thumbStart ? -page : page), bar);
  }

  defaultMouseDrag(ev) {
    if (this._barGrab == null) return super.defaultMouseDrag(ev);
    const bar = this._scrollbar();
    if (!bar || bar.travel <= 0) return;
    const ny = ev.nativeEvent?.y ?? ev.y * this.scale;
    this._scrollTo(
      ((ny - this._barGrab - bar.trackStart) / bar.travel) * bar.range,
      bar,
    );
  }

  defaultMouseUp(ev) {
    if (this._barGrab != null) {
      this._barGrab = null;
      return;
    }
    super.defaultMouseUp(ev);
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
  }

  /** Wider than a single-line field, and `rows` lines tall — a height that
   * comes from a prop rather than from the style, which is what makes
   * `invalidateMeasure` necessary below. */
  measureContent({ width }) {
    const rows = Math.max(1, this.props.rows ?? 3);
    return {
      width: Math.min(220, width),
      height: Math.ceil(this._lineHeight() * rows),
    };
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
    const text = this._displayValue();
    const isEmpty = text.length === 0;
    const shown = isEmpty ? (this.props.placeholder ?? '') : text;
    const s = this.resolvedTextStyle();
    const color = isEmpty
      ? (this.props.placeholderColor ?? this.theme.textMuted)
      : s.color;
    const direction = this.direction;
    const align = this.style.textAlign ?? 'start';
    // A wrapped field *has* a container, so — unlike `<textinput>` — the
    // alignment is ntk's to apply: every line is placed inside the box it
    // wrapped to, and `start` is resolved against the base direction, which
    // puts an RTL value against the right-hand edge.
    //
    // The container is the content box less the caret's own width, because
    // in RTL every line *starts* flush against that right edge — line 0,
    // column 0 of an empty field included — and a caret is drawn rightwards
    // from the boundary it marks, so with no reserve it lands entirely
    // outside the clip and an RTL textarea shows no caret at all. In LTR the
    // flush edge is the left one, where the caret has the whole box in front
    // of it, and only a line that fills its width exactly could reach the
    // other end — so nothing is taken off a direction that does not need it.
    const width = this.contentBox().width || undefined;
    const container =
      width === undefined || direction !== 'rtl'
        ? width
        : Math.max(0, width - CARET_RESERVE * this.scale);
    const key = `${width}|${color}|${shown}|${s.family}|${s.size}|${s.weight}|${s.style}|${direction}|${align}`;
    if (this._valueLayoutKey !== key) {
      this._valueLayoutKey = key;
      this._valueLayoutCache = fonts.layout([{ text: shown, ...s, color }], s, {
        maxWidth: container,
        align,
        direction,
      });
    }
    return this._valueLayoutCache;
  }

  applyProps(newProps, oldProps) {
    const before = oldProps ?? this.props;
    super.applyProps(newProps, oldProps);
    if (newProps.rows !== before.rows) this.invalidateMeasure('props');
  }

  /** The wrapped value flows from the top of the content box, scrolled —
   * there is no single line to centre, so none of `_lineMetrics` applies.
   * Everything written against this (`textIndexAt`, `textCaretRect`,
   * `textRangeRects`, click-to-caret) needs no override. */
  _placedValue() {
    const layout = this._valueLayout();
    if (!layout) return null;
    const content = this.contentBox();
    return { layout, x: content.x, y: content.y - this._scrollY };
  }

  /** How far the wrapped text reaches past the viewport. The measurement a
   * `Scrollable` takes off its children, taken off the layout that is
   * actually painted — which is what makes a self-painting element a member
   * of the scroll protocol rather than a special case in it. */
  _maxScrollY() {
    const layout = this._valueLayout();
    if (!layout) return 0;
    return Math.max(0, layout.height - this.contentBox().height);
  }

  /**
   * The chain protocol's first half (issue #253). Vertical only — the text
   * wraps, so there is never anything to the right — and false when the
   * value fits, which is what lets the wheel chain outward to the pane or
   * the window behind a short field instead of dying on it.
   */
  canScroll(dx, dy) {
    return Boolean(dy) && this._maxScrollY() > 0;
  }

  /** `scrollBy(dy)`, or `scrollBy({x, y})` — the shape `Scrollable` takes,
   * so the wheel's default action calls every scroller the same way. `x` is
   * accepted and ignored: wrapped text has no horizontal extent. */
  scrollBy(by) {
    // logical, like Scrollable's — the public unit
    const dy = typeof by === 'number' ? by : (by?.y ?? 0);
    this._scrollByDevice(0, dy * this.scale);
  }

  /** Device-pixel core, the wheel's entry (see Scrollable). */
  _scrollByDevice(dx, dy) {
    if (!dy) return;
    const next = Math.min(Math.max(0, this._scrollY + dy), this._maxScrollY());
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
        return true;
      }
      this._goalX = null;
      this._insert('\n');
      return true;
    }
    if ((k === XK_UP || k === XK_DOWN) && layout && this.value.length > 0) {
      const i = this._verticalMove(layout, k === XK_UP ? -1 : 1);
      this._moveCaret(i, ev.shiftKey);
      if (ev.shiftKey) this._copySelection('PRIMARY');
      return true;
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
      return true;
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
      return true;
    }
    this._goalX = null;
    return super._editKeyDown(ev);
  }

  /** Thumb for the vertical overflow, same look as a scroll box's. */
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
      scale: this.scale,
    });
  }

  paintContent(ctx) {
    const layout = this._valueLayout();
    if (!layout) return;
    const content = this.contentBox();
    if (content.width <= 0 || content.height <= 0) return;
    const isEmpty = this._displayValue().length === 0;

    // Keep the caret line inside the viewport, and only while focused — the
    // caret starts at the end of the value, so chasing it unconditionally
    // opened a textarea already scrolled past its first lines. Unlike
    // <textinput> this does not reset the offset when focus leaves: a
    // textarea scrolls on the wheel and has a scrollbar, so where an
    // unfocused one is scrolled to is the reader's business.
    const pos = layout.caretPosition(this._displayIndex(this._caret));
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
      // A **translucent** accent rather than an opaque light blue. The ink
      // on top is `style.color`, which this fill does not control, so an
      // opaque highlight has to be picked to contrast with it — and no one
      // colour does that on both a light and a dark palette. `#b3d4fc`
      // under the dark palette's near-white ink is 1.3:1, which is nothing.
      // Tinting the surface instead leaves the ink's own contrast intact.
      ctx.fillStyle =
        this.props.selectionColor ?? tint(this.theme.accent, 0.35);
      // The bands `textRangeRects` reports — one per line and one per
      // direction run inside a line, which is what a selection crossing into
      // an Arabic word actually covers. Two caret positions and a rectangle
      // between them, which is what this was, paints over text nobody
      // selected on a line that has runs going both ways.
      //
      // Only the lines on screen are *sent*, and all of them in one request.
      // Ctrl+A in a 5000-line value selects 5000 lines and shows twenty: the
      // clip throws the rest away *after* they have been sent, which is the
      // one cost a clip cannot save.
      const bottom = this._scrollY + content.height;
      const rects = [];
      for (const band of rangeBands(
        layout,
        this._displayValue(),
        this._displayIndex(a),
        this._displayIndex(b),
      )) {
        if (band.y > bottom) break;
        if (band.y + band.height < this._scrollY) continue;
        rects.push(originX + band.x, originY + band.y, band.width, band.height);
      }
      // one `Render.FillRectangles` for the whole highlight, where a fill per
      // line is a full-surface-masked composite per line (ntk >= 7.6)
      if (rects.length) ctx.fillRects(rects);
    }

    layout.draw(ctx, originX, originY);
    this._paintPreedit(ctx, originX, originY, this.resolvedTextStyle());

    if (this._focused && this._caretOn && a === b) {
      ctx.fillStyle = this.props.caretColor ?? this.resolvedTextStyle().color;
      ctx.fillRect(
        originX + pos.x,
        originY + pos.y,
        CARET_WIDTH * this.scale,
        pos.height,
      );
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
export class WindowNode extends Scrollable(Node) {
  constructor(app, attributes, props) {
    super('window', props, app, { yoga: true });
    assertWindowSize(props, this.kind);
    this.root = this;
    this.attributes = attributes;
    this.window = null;
    // `hidden` has two writers — the reconciler (React hiding a subtree for
    // `<Suspense>`/`<Activity>`) and the element's own `hidden` prop — and
    // the window is off screen while *either* says so. The reconciler's half
    // is remembered here so that a `<Suspense>` revealing its content does
    // not map a window whose prop still hides it. `this.hidden` stays the
    // one flag everything reads (`_mapNow`, painting, a11y, anchoring).
    this._reactHidden = false;
    this.hidden = Boolean(props.hidden);
    // whether this is the tree's own top-level window rather than a nested
    // one or a popup — decided by realize(), read when it maps
    this._topLevel = false;
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
    // Nodes that want the `attention` event (ntk#37) — an
    // `unstable_onAttention` prop,
    // an `:attention` block, or both. Built before the EventManager so the
    // manager can hold the reference itself: the whole feature has to be
    // behind one `size` read on the motion path, and a tree that never asked
    // for attention must not pay a property walk to find that out.
    this._attentionNodes = new Set();
    this.events = new EventManager(this);
    // ids of the child windows in the order the *server* stacks them,
    // bottom to top — see _restackWindowChildren
    this._xStack = [];
    // nodes with a transition in flight
    this._animating = new Set();
    // …and the nodes whose style declares a *loop*, running or not: the set
    // every stop condition is applied over, and what decides whether this
    // window is watching its own visibility at all
    this._loopNodes = new Set();
    this._loopsPaused = false;
    this._loopWatch = null;
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
    // The geometry we last asked the server for, and whether anything else
    // has since decided otherwise. Together they are the rule for `'auto'`:
    // it keeps up with the content until someone takes the size over, and
    // the only thing that ever does is the user dragging an edge.
    this._requestedSize = null;
    this._userSized = false;
    // the last `WM_NORMAL_HINTS` struct written and the size it was written
    // at, so that a bound measured every frame is only *sent* on the frames
    // it moves (see _sendSizeHints for why the size is part of it)
    this._sentHints = null;
    this._sentHintsAt = null;
    // The automatic minimum size (#249): the nodes carrying a floor this
    // window measured, whether the floors are still the answer, and the
    // width the height half of them was measured for.
    this._floored = new Set();
    this._floorsDirty = true;
    this._floorsWidth = null;
  }

  /**
   * The smallest size this window's content can be drawn at: GTK's
   * `minimum` to the `natural` below, and what an `'auto'` `minWidth` or
   * `minHeight` resolves to.
   *
   * One layout pass **with no space on offer at all**, which is the whole
   * trick — every node comes out at the smallest size its own style allows,
   * text measures at its longest word, and a wrapping row wraps at every
   * item. `contentSpan` then reads how far that reached, recovering a node
   * the pass squashed by looking inside it.
   *
   * What it deliberately does *not* do is second-guess that layout. A node
   * that said how small it can be — `minWidth: 0`, or an `overflow` that
   * clips — is taken at its word and its content stops counting. That is
   * CSS's `min-width: 0`, Qt's `QScrollArea` and GTK's `min-content-width`,
   * and a scroll container gets it here for free.
   *
   * `forWidth` is the width the height is measured for, and there has to be
   * one: a paragraph's minimum height is a height *for a width*. GTK asks
   * for its minimum height at its minimum width, which for a paragraph is
   * the width it is tallest at — an honest answer to a question nobody
   * asked, since the window is not at its minimum width. `WM_NORMAL_HINTS`
   * holds two independent numbers and cannot express the dependency either
   * way, so the floor is measured at the width the window will actually
   * have and re-sent as that changes.
   */
  /**
   * The direction to lay this window's tree out in, as yoga spells it.
   *
   * `calculateLayout`'s third argument is the direction the *owner* imposes,
   * and a window has no owner — so the root reads its own resolved value and
   * hands it down. A `direction` on a `<box>` inside is then yoga's business
   * rather than ours: it carries the property on its own node and everything
   * under it inherits from there.
   */
  get _rootDirection() {
    return this.direction === 'rtl' ? Yoga.DIRECTION_RTL : Yoga.DIRECTION_LTR;
  }

  /**
   * The root's direction is an argument to `calculateLayout` rather than a
   * property on a yoga node, so nothing in the box tree is dirty when it
   * moves and the layout pass has to be asked for. That is only reachable
   * from the palette — a `direction` written in the window's own style goes
   * through `applyLayoutStyle`, which dirties the node the ordinary way.
   */
  _directionMoved() {
    this.invalidate(true, null, 'direction');
  }

  _measureContentSpans(axis, forWidth, out) {
    const yoga = this.yoga;
    const dir = this._rootDirection;
    // The root carries whatever size the last pass pinned on it, and an
    // available size means nothing to a root that has one of its own.
    yoga.setWidth(undefined);
    yoga.setHeight(undefined);
    if (axis === 'width') {
      setMeasuringShrink(this, axis);
      yoga.calculateLayout(0, undefined, dir);
      return contentSpan(this, axis, undefined, out);
    }
    // Height takes two passes. The first is the tree at its real width with
    // no bound on the height, which is where every leaf reports the height
    // it actually needs there — a wrapped paragraph's is settled by the
    // width, and no leaf can give any of it back. It runs before the shrink
    // is borrowed, since the widths it settles are the real ones. The second
    // is the one that collapses, and it squashes a leaf that a `row`
    // stretches: those are the ones the map above puts back. The widths the
    // first pass settled are held across the second (`freezeWidths`), which
    // is the only thing keeping it a collapse rather than a second opinion.
    yoga.calculateLayout(forWidth, undefined, dir);
    const intrinsic = new Map();
    captureLeafHeights(this, intrinsic);
    freezeWidths(this);
    setMeasuringShrink(this, axis);
    yoga.calculateLayout(forWidth, 0, dir);
    const span = contentSpan(this, axis, intrinsic, out);
    restoreWidths(this);
    return span;
  }

  _measureMinimum(axis, forWidth) {
    // Measured from the styles alone, so the floors this window wrote itself
    // have to come off first: they were derived from this same measurement,
    // and left in place they would be read back as content the tree cannot
    // give up — a floor that could only ever ratchet upwards.
    this._resetContentFloors();
    const min = measuringExactly(() =>
      Math.ceil(this._measureContentSpans(axis, forWidth)),
    );
    restoreShrink(this);
    return min;
  }

  /**
   * Give every flex item in this window's tree the floor CSS calls its
   * automatic minimum size, so that `flexShrink`'s default of `1` squeezes a
   * row into the space it has without squeezing its contents out of
   * existence. See `writeContentFloors` for what that means and why both
   * halves are needed.
   *
   * Two measurements, in this order because they depend that way round: the
   * widths from a pass with no room on offer at all, then — with those floors
   * already applied — the heights at the width the window is about to be laid
   * out at, since a minimum height is always a height *for a width*.
   *
   * Nothing about this is per frame: the floors are content, so they survive
   * every frame that did not change any (`_floorsDirty`), which is what keeps
   * a wheel notch to the one layout pass it always was.
   */
  _applyContentFloors(width) {
    if (!this._floorsDirty && this._floorsWidth === width) return;
    this._resetContentFloors();
    measuringExactly(() => {
      const widths = new Map();
      this._measureContentSpans('width', undefined, widths);
      writeContentFloors(this, 'width', widths, this._floored);
      const heights = new Map();
      this._measureContentSpans('height', width, heights);
      writeContentFloors(this, 'height', heights, this._floored);
    });
    this._floorsDirty = false;
    this._floorsWidth = width;
  }

  /** Take the measured floors back off, leaving each node with whatever its
   *  own style says. */
  _resetContentFloors() {
    if (!this._floored.size) return;
    for (const node of this._floored) {
      if (node.destroyed || !node.yoga) continue;
      node.yoga.setMinWidth(node.style.minWidth);
      node.yoga.setMinHeight(node.style.minHeight);
    }
    this._floored.clear();
    this._floorsDirty = true;
  }

  /**
   * What the content has to say about this window's size: the size it wants
   * for whichever of `width`/`height` is `'auto'`, and the numbers an
   * `'auto'` bound resolves to.
   *
   * The **natural** size is CSS shrink-to-fit, then height-for-width:
   *
   * 1. Lay the tree out with **no available width**, which is what yoga's
   *    `undefined` means: every measure function is asked in
   *    `MEASURE_MODE_UNDEFINED`, text does not wrap, and the root reports
   *    its max-content width.
   * 2. Clamp that into `[minWidth, min(maxWidth, the screen)]`.
   * 3. **Lay out again at the clamped width.** This is the pass that
   *    matters and the one it is tempting to skip: a paragraph that had to
   *    wrap at the clamped width is taller than the max-content pass said,
   *    and a window sized from that first height would cut its own text off.
   *
   * Where CSS and X part ways: shrink-to-fit is
   * `min(max(min-content, available), max-content)`, and that `max(...)`
   * means a CSS box never goes below its min-content size even when it
   * overflows. A window cannot be wider than the screen, so the clamp wins
   * and the content is cut instead.
   *
   * The two answers are the pair Qt and GTK both hand their toplevels —
   * `sizeHint()`/`minimumSizeHint()`, `gtk_widget_measure`'s
   * `(minimum, natural)` — which is why `'auto'` reads as the natural size
   * on a cap and as the minimum on a floor: it means "ask the content",
   * and the content's answer to *how big* is not its answer to *how small*.
   *
   * Runs before `CreateWindow`, so it must not need one: text measures
   * through `app.fonts`, which is the connection's, and the clamp was
   * resolved during `createRoot`. That is the whole point — the window is
   * *created* at its natural size rather than resized into it after mapping,
   * so nothing is ever on screen at the wrong size.
   *
   * Leaves the tree laid out at a size that is nobody's arrangement, so it
   * may only be called on a frame that goes on to lay out — `realize()`,
   * which invalidates, and `_refit()`, which `flush()` only calls when it
   * owes a layout pass anyway.
   */
  _measure() {
    // Every number below — yoga's answers, the monitor rects, the window's
    // live size — is device pixels, so the geometry props convert on entry
    // and the rest of the function never thinks about units again.
    const props = scaleWindowGeometry(this.props, this.scale);
    const autoW = isAutoSize(props.width);
    const autoH = isAutoSize(props.height);
    const yoga = this.yoga;
    // Where the window will open, for picking a monitor: next to its owner
    // where it has one, and wherever the WM puts it otherwise.
    const area = availableArea(this.app, screenOriginOf(props.transientFor));
    // An `'auto'` cap never bounds the pass that resolves it: `maxWidth`
    // there *is* the natural width, so letting it in would be the answer
    // bounding the question.
    const limit = (max, screen) =>
      Math.min(
        numericBound(max) ?? Infinity,
        screen ?? Infinity,
        MAX_WINDOW_EXTENT,
      );
    const availW = limit(props.maxWidth, area?.width);
    const availH = limit(props.maxHeight, area?.height);
    const hints = {};
    if (!yoga) {
      // Only reachable on a torn-down window, and a size still has to be a
      // size: fall back to the space on offer rather than handing `'auto'`
      // through to CreateWindow. Nothing left to measure a bound against.
      return {
        width: autoW
          ? clampExtent(availW, numericBound(props.minWidth), availW)
          : props.width,
        height: autoH
          ? clampExtent(availH, numericBound(props.minHeight), availH)
          : props.height,
        hints,
      };
    }

    // A numeric floor applies to the natural size as it always has; an
    // `'auto'` one is measured below. The height's needs a width to be
    // measured for, and it can never exceed the natural height anyway —
    // same width, every node at or below the size it settled at — so
    // nothing is lost by clamping the height without it.
    const minH = numericBound(props.minHeight);

    // Also run for an axis that is not `'auto'` but whose cap is: a
    // `maxWidth="auto"` on a window with a `width` still has to find out
    // what the content wanted.
    const needW = autoW || isContentBound(props.maxWidth);
    const needH = autoH || isContentBound(props.maxHeight);
    if (!needW && !needH) {
      // Both sizes are the app's, so there is nothing to measure but the
      // bounds — and nothing re-resolves `@width` blocks here: the styles
      // are the ones the window's real size resolved on the last frame,
      // which is the size the floors are wanted for.
      if (isContentBound(props.minWidth)) {
        hints.minWidth = clampBound(this._measureMinimum('width'), availW);
      }
      this._finishHeightFloor(
        hints,
        props,
        this.window?.width ?? props.width,
        availH,
      );
      return { width: props.width, height: props.height, hints };
    }

    const dir = this._rootDirection;
    const measure = () => {
      // The root carries whatever size the last flush() pinned on it — and
      // whatever the floor pass below cleared — so this is re-stated per
      // call rather than hoisted: clearing an axis is what makes yoga
      // measure it rather than fill it.
      yoga.setWidth(needW ? undefined : props.width);
      yoga.setHeight(needH ? undefined : props.height);
      let naturalW;
      if (needW) {
        yoga.calculateLayout(undefined, needH ? undefined : props.height, dir);
        naturalW = clampExtent(yoga.getComputedWidth(), undefined, availW);
      }
      const width = autoW ? clampExtent(naturalW, minW, availW) : props.width;
      // The height-for-width pass. Run even when only the width is auto: it
      // is the layout the window is about to be created at, so leaving the
      // tree holding the max-content one would hand `flush()` a stale
      // arrangement.
      yoga.calculateLayout(width, needH ? undefined : props.height, dir);
      const naturalH = needH
        ? clampExtent(yoga.getComputedHeight(), undefined, availH)
        : undefined;
      const height = autoH ? clampExtent(naturalH, minH, availH) : props.height;
      return { width, height, naturalW, naturalH };
    };

    // `@width`/`@height` blocks and an auto size are mutually circular: the
    // query wants a size the measurement has not produced yet. Broken the way
    // CSS breaks the same cycle for container queries — measure against the
    // space on offer, then re-resolve against the answer, and measure once
    // more if that moved anything. **Once**: a second look settles the common
    // case (a block that turns on below the width the content would have
    // taken) and a third would only be chasing a layout that oscillates,
    // which no size can satisfy.
    this._resolveSizeQueries(
      autoW ? availW : props.width,
      autoH ? availH : props.height,
    );

    // The width floor, measured against the styles the pass below starts
    // from and before it, because it is what the natural width is clamped
    // into. Bounded by the same space the size is: a floor wider than the
    // screen is a window that cannot be put on it, and a floor past
    // `maxWidth` is a `WM_NORMAL_HINTS` that contradicts itself.
    const minW = isContentBound(props.minWidth)
      ? (hints.minWidth = clampBound(this._measureMinimum('width'), availW))
      : props.minWidth;

    let size = measure();
    if (this._resolveSizeQueries(size.width, size.height)) size = measure();

    // A cap the content decides is its natural size, never below a floor
    // that was named as a number: `WM_NORMAL_HINTS` with a min above its own
    // max is a struct no window manager can honour.
    if (isContentBound(props.maxWidth)) {
      hints.maxWidth = Math.max(size.naturalW, minW ?? 0);
    }
    if (isContentBound(props.maxHeight)) {
      hints.maxHeight = Math.max(size.naturalH, minH ?? 0);
    }
    // Last, because it is a height *for a width*: the width the window is
    // about to have where the width is still ours to choose, and the one it
    // has where it is not.
    const forWidth =
      autoW && !this._userSized
        ? size.width
        : (this.window?.width ?? size.width);
    this._finishHeightFloor(hints, props, forWidth, availH);
    return { width: size.width, height: size.height, hints };
  }

  /** The `minHeight="auto"` floor, measured for the width just settled. */
  _finishHeightFloor(hints, props, forWidth, availH) {
    if (!isContentBound(props.minHeight)) return;
    hints.minHeight = clampBound(
      this._measureMinimum('height', forWidth),
      availH,
    );
    if (isContentBound(props.maxHeight)) {
      hints.maxHeight = Math.max(hints.maxHeight ?? 0, hints.minHeight);
    }
  }

  /**
   * Keep an `'auto'` window the size of its content while it still owns its
   * own size. Called from `flush()` on any frame that lays out, which is
   * every frame where the natural size could have moved.
   *
   * One rule covers both kinds of window, which is why it is a rule and not
   * two behaviours: **auto tracks the content until something else sets the
   * size.** A `<window>` grows as rows are added to it and stops the moment
   * the user drags an edge — GTK's behaviour, and right for the same reason:
   * the size is the app's opinion until it is the user's. Nothing can ever
   * take a `<popup>`'s size over — it is override-redirect and has no
   * resize handles — so a menu tracks its items for good.
   *
   * The result is applied through the window rather than through props: an
   * auto size is not something React said, so nothing about it should read
   * as a prop change or wait for one.
   *
   * A **bound** the content decides is not covered by that rule and outlives
   * it: `minWidth="auto"` still means the same thing after the user has
   * taken the size over — it is what stops them taking it *too far* — and it
   * means it on a window with a `width` of its own, which never tracked
   * anything. So the floor is re-measured on every frame that lays out, and
   * the size only while it is still the window's to choose.
   */
  _refit() {
    if (this.destroyed) return;
    const wnd = this.window;
    if (!wnd) return;
    const props = this.props;
    const tracking =
      !this._userSized && (isAutoSize(props.width) || isAutoSize(props.height));
    const bounded = CONTENT_BOUND_PROPS.some((key) =>
      isContentBound(props[key]),
    );
    if (!tracking && !bounded) return;
    const asked = this._requestedSize;
    const next = this._measure();
    this._sendSizeHints(props, next.hints);
    if (!tracking) return;
    if (asked && next.width === asked.width && next.height === asked.height) {
      return;
    }
    this._requestedSize = { width: next.width, height: next.height };
    // Asked for, not assumed. `window.width` stays what the server last said
    // until the ConfigureNotify lands, and this frame lays out against that
    // — the echo brings `needsLayout` and an unbounded repaint with it (see
    // the 'resize' listener), which is the same one-frame settle a
    // controlled `width` prop change has always had. Writing the new size
    // onto the window here would be worse than the wait: ntk allocates the
    // backing pixmap from the resize event, so a frame painted at a size the
    // pixmap has not reached yet is a frame clipped to the old one.
    if (typeof wnd.setState === 'function') {
      wnd.setState({ width: next.width, height: next.height });
    } else {
      wnd.resize?.(next.width, next.height);
    }
    // A window that grew is a window whose *placement* moved with it, and
    // the anchored ones have to be told: a completion list that gains a row
    // near the bottom of the screen is one that now flips above the caret.
    // From `next` rather than from the window, which is still the size the
    // server last confirmed.
    this._followAnchor({ width: next.width, height: next.height });
  }

  // --- anchoring ----------------------------------------------------------
  //
  // A `<popup anchor={{to: ref, …}}>` works out its own position, because it
  // is the only thing that can: with `width="auto"` the size is settled
  // inside `realize()`, between `_measure()` and `CreateWindow`, which is
  // after the last moment React could have computed a rect for it — and the
  // placement *needs* the size, since which side it flips to and how far it
  // is pulled back from an edge are both functions of how big it is.
  //
  // So the same order the natural size already established: measure, place,
  // create. The popup is born the right size **and** in the right place,
  // rather than mapped somewhere provisional and corrected a frame later.
  // A widget that knows its own size has no such problem and stays on
  // `useAnchor` / `useAnchorTracking`; both call the same functions
  // (src/anchor.js), so the two agree by construction.

  /** A `to`/`alignTo` in an `anchor` prop: a ref, or the node itself. */
  _anchorTarget(target) {
    if (target == null || typeof target !== 'object') return null;
    const node = target.abs ? target : target.current;
    return node?.abs ? node : null;
  }

  /** Where this window goes at `size`, or null when there is nothing to
   *  anchor to yet — a ref whose node has not been laid out. */
  _anchorPlacement(size) {
    const anchor = this.props.anchor;
    const node = this._anchorTarget(anchor?.to);
    if (!node) return null;
    // `anchorRect` is public API and speaks logical pixels on both sides;
    // this caller's `size` came from `_measure` (device) and its result is
    // headed for CreateWindow (device), so both convert here.
    const s = this.scale;
    const rect = anchorRect(node, {
      ...anchor,
      alignTo: this._anchorTarget(anchor.alignTo) ?? undefined,
      width: size.width / s,
      height: size.height / s,
    });
    if (!rect || s === 1) return rect;
    return {
      ...rect,
      x: Math.round(rect.x * s),
      y: Math.round(rect.y * s),
      width: Math.round(rect.width * s),
      height: Math.round(rect.height * s),
    };
  }

  /**
   * Keep an anchored window over the thing it points at: the trigger's own
   * layout moving, an ancestor of it scrolling, the owner window being
   * dragged, or this window's content changing size under it.
   *
   * The first three arrive through the *owner* window's `onAnchorChange`
   * (`_watchAnchor`) — the same signal `useAnchorTracking` reads, since it
   * is the same set of things that can move a trigger. The fourth is
   * `_refit`, which knows the new size before the server does.
   *
   * **Out of view is not a position.** A popup is a real X window, not a
   * web element its ancestors clip, so a caret that has scrolled out of the
   * editor leaves a completion list floating over a document it no longer
   * points into. There is no placement that fixes that, so the window is
   * unmapped for as long as the anchor is gone and mapped again where it
   * belongs when it comes back — the one answer the renderer can give on
   * its own, since whether the popup should *close* is React state and
   * therefore the application's. (An app that would rather close it keeps
   * `useAnchorTracking`'s `onOutOfView`, which is exactly that seam.)
   */
  _followAnchor(size = this._requestedSize) {
    if (this.destroyed || !this.window || !this.props.anchor) return;
    const node = this._anchorTarget(this.props.anchor.to);
    // A ref that has not attached yet counts as gone, and for the same
    // reason: there is nowhere for the popup to be. Refs attach in the
    // commit phase a popup realizes in, so one written *above* its own
    // trigger in the JSX gets a frame of this — and waiting it out is
    // better than a frame in the corner of the screen.
    const lost = !node || anchorOffscreen(node, this.props.anchor.at);
    if (lost !== Boolean(this._anchorLost)) {
      this._anchorLost = lost;
      // The grab goes with it and comes back with it. X releases a pointer
      // grab whose window stops being viewable, so a menu that hid and
      // reappeared would be one no press outside could dismiss — the
      // `onDismiss` that reads as "click anywhere to close" would simply
      // stop happening. The re-take is `PopupNode._mapNow`'s, which is what
      // keeps it beside the map on every route back to the screen.
      if (lost) {
        if (this.props.grab) this.window.ungrabPointer?.();
        this.window.unmap?.();
      } else {
        this._mapNow();
      }
    }
    if (lost || !size) return;
    const rect = this._anchorPlacement(size);
    if (!rect) return;
    if (this._placedAt?.x === rect.x && this._placedAt?.y === rect.y) return;
    this._placedAt = { x: rect.x, y: rect.y };
    if (typeof this.window.setState === 'function') {
      this.window.setState({ x: rect.x, y: rect.y });
    } else {
      this.window.move?.(rect.x, rect.y);
    }
  }

  /**
   * Subscribe to whatever can move the anchor. On the **owner's** window,
   * not on this one: what moves is the trigger, and this window's own
   * layout passes say nothing about where it sits on screen.
   */
  _watchAnchor() {
    this._unwatchAnchor();
    if (!this.props.anchor) return;
    // The anchor's own window where the ref has attached, and the window
    // this popup was *written into* otherwise — which is the same one in
    // every case that matters, and is what makes an unattached ref a
    // one-frame wait rather than a popup nothing ever notifies again. The
    // notification is only ever a prompt to re-measure, so subscribing to a
    // window the anchor turns out not to be in costs a no-op.
    const root =
      this._anchorTarget(this.props.anchor.to)?.root ?? this.parent?.root;
    if (!root?.onAnchorChange || root === this) return;
    this._anchorWatch = root.onAnchorChange(() => this._followAnchor());
  }

  _unwatchAnchor() {
    this._anchorWatch?.();
    this._anchorWatch = null;
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
    // Before CreateWindow, so an auto-sized window is *born* the right size.
    // Doing it after would mean a window mapped at 800x800 and corrected a
    // frame later, which is the jump this exists to avoid.
    const natural = this._measure();
    attributes.width = natural.width;
    attributes.height = natural.height;
    this._requestedSize = { width: natural.width, height: natural.height };
    // And straight after it, for the same reason: the placement is a
    // function of the size, so this is the first moment it can be worked
    // out — and the last one before the window exists at a position.
    const placed = this._anchorPlacement(natural);
    if (placed) {
      attributes.x = placed.x;
      attributes.y = placed.y;
      this._placedAt = { x: placed.x, y: placed.y };
    }
    // A bound the content decides is a number by now, and the window manager
    // reads `WM_NORMAL_HINTS` when it frames the window — so it goes in with
    // the creation attributes rather than chasing the map with a second
    // property write.
    if (Object.keys(natural.hints).length > 0) {
      this._sentHints = this._hintsToSend(this.props, natural.hints);
      attributes.sizeHints = this._sentHints;
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
    // **Smooth scrolling, where the server can — and where the window turns
    // out to want it.** XI2 carries a scroll as the device's own valuators,
    // so a touchpad's two-finger scroll arrives as the fractions of a notch
    // it was rather than as the whole clicks of button 4/5 the server
    // emulates for clients that cannot read them. ntk translates the device
    // events back into the core-shaped ones the rest of this file reads, and
    // falls back to those buttons where there is no XI2 (issue #273).
    //
    // **It is not free, which is why it is no longer selected up front.** An
    // XI2 selection *replaces* the core one for the same event type, and an
    // XIMotion is 136 bytes on the wire against a core MotionNotify's 32
    // (`npm run xi2:probe`, Xorg 21.1). Motion is the one event that keeps
    // arriving at frame rate for as long as the pointer is over the window,
    // so an eager selection bills every window ~8 KB/s of pointer traffic
    // while the pointer crosses it — for a feature most windows never use. A
    // dialog, a toolbar, a form, a splash screen never see a wheel at all.
    //
    // So `'auto'` — the default — creates the window on core events and takes
    // the selection the first time the window is actually scrolled
    // (`upgradeToXI2`, from `EventManager._onWheel`). What that costs is the
    // opening event of the first gesture in a window's life, and it costs
    // less than it sounds: a mouse wheel reports whole notches whichever way
    // the scroll arrived, and ntk's `ScrollTracker` treats the first valuator
    // event as a seed with no distance to report — so under an eager
    // selection that same first event moves nothing at all. `xi2` selects at
    // creation for an app whose whole interaction is the touchpad; `false`
    // refuses the selection outright.
    //
    // Never on a `<popup>`, which is the window that holds a pointer grab: a
    // core grab delivers core events, and ntk drops the emulated wheel
    // buttons on a window whose valuators are flowing — a menu that had
    // selected XI2 would be a menu the wheel could not reach while it was
    // grabbing. An explicit `xi2` still wins there, because an app that says
    // so has said so.
    const wantsXI2 = this.props.xi2 ?? 'auto';
    // `'auto'` is ours and must not reach ntk, whose `args.xi2` is truthiness
    attributes.xi2 = wantsXI2 === true;
    this._xi2Pending = wantsXI2 === 'auto' && !this.isPopup;
    // The full event mask, declared at creation — see WINDOW_EVENT_MASK.
    attributes.eventMask = (attributes.eventMask ?? 0) | WINDOW_EVENT_MASK;
    const wnd = this.app.createWindow(attributes);
    this.window = wnd;
    // Now that the visual is known: settle the capabilities, re-resolve any
    // `@supports` block against them, and start following the compositor.
    // Before the first paint, and before children realize against it.
    this._watchCapabilities();
    wnd._reactX11Node = this;
    wnd._reactFiber = this._reactFiber;
    // windows are DevTools public instances too — see Node.getClientRects
    const s = this.scale;
    wnd.getClientRects ??= () => [
      {
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        width: wnd.width / s,
        height: wnd.height / s,
      },
    ];
    wnd.measure ??= (callback) =>
      callback?.(0, 0, wnd.width / s, wnd.height / s, 0, 0);
    wnd.ownerDocument ??= DEVTOOLS_FAKE_DOCUMENT;
    this._attachWindowListeners(parentWindow);
    for (const child of this.children) {
      if (child.isWindow && !child.isPopup) {
        child.realize(wnd);
        if (child.window) this._xStack.push(child.window.id);
      }
    }
    this._restackWindowChildren();
    // <glarea>s and <foreign>s mounted before the window existed own a
    // child X window too
    this._realizeChildWindows(this);
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
    this._topLevel = !parentWindow && !this.isPopup;
    if (this._topLevel) this.app._reactX11Startup?.decorate(wnd);
    // Before the map for the same reason the properties above are: a popup
    // whose anchor is already out of view — an editor scrolled between the
    // keystroke that opened the completion list and the commit that
    // realized it — should never be on screen at all, rather than appear
    // and vanish.
    if (this.props.anchor) {
      this._watchAnchor();
      const node = this._anchorTarget(this.props.anchor.to);
      this._anchorLost = !node || anchorOffscreen(node, this.props.anchor.at);
    }
    // Queued rather than mapped, when there is a commit to queue behind:
    // React hides a subtree only once it has inserted it (beginWindowMaps).
    if (inCommit) pendingMaps.add(this);
    else this._mapNow();
    // ask before anything can be anchored to it, so the first popup is
    // placed as well as the second
    this._refreshScreenOrigin();
    this.invalidate(true, null, 'mount');
  }

  /**
   * Put the window on screen, unless this commit went on to hide it.
   *
   * The only caller that maps a window for the first time is
   * `flushWindowMaps` (or `realize` itself outside a commit); `setHidden`
   * comes back through here so that a window born hidden and revealed later
   * still ends the startup sequence on its real first map.
   */
  _mapNow() {
    if (this.destroyed || !this.window || this.hidden) return false;
    // An `embeddable` window never maps itself: a window waiting to be
    // embedded is unmapped — that is what waiting looks like — and from the
    // reparent on, mapping is the embedder's decision (ntk's XEmbedSocket
    // maps a plain client the moment it takes it). Self-mapping here would
    // put a frame pane on the desktop as a top-level for the beat before
    // its <Frame> embeds it, long enough for a window manager to frame it.
    if (this.props.embeddable) return false;
    // An anchor that is not on screen is a popup that has nowhere to be
    // (`_followAnchor`); it maps from there, when the anchor comes back.
    if (this._anchorLost) return false;
    this.window.map?.();
    if (this._topLevel) this.app._reactX11Startup?.mapped(this.window);
    // whether the map went out, so `PopupNode` can hang its grab off it
    return true;
  }

  /**
   * Take the XI2 selection this window was deliberately created without —
   * see `realize()` for why `xi2: 'auto'` starts on core events. Called by
   * `EventManager._onWheel`, so the window that is scrolled is the window
   * that pays for smooth scrolling.
   *
   * **One-shot and one-way.** `_xi2Pending` is cleared before the request
   * goes out, so a burst of wheel events in one frame asks once. Coming back
   * down is not offered: the only signal that would justify it is "nothing in
   * here scrolls any more", which cannot be read without a per-node registry,
   * and getting it wrong drops a live gesture from valuators back to notches
   * mid-scroll — a visible regression, to save bytes on a window the user is
   * actively using.
   *
   * Silent where the server has no XInput2: `selectXI2()` resolves `false`
   * and the window keeps the emulated wheel buttons it already had, which is
   * exactly where an eager selection would have landed too. Feature-detected
   * on the method, for an ntk older than 7.5.0.
   */
  upgradeToXI2() {
    if (!this._xi2Pending || this.destroyed) return;
    this._xi2Pending = false;
    if (typeof this.window?.selectXI2 !== 'function') return;
    // fire and forget, like the eager selection in ntk's own createWindow:
    // until the extension answers the window is on core events, which is
    // where it would have been anyway
    this.window.selectXI2().catch((err) => {
      this.app?.options?.onXError?.(err);
    });
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

  /** Like a `<box>`: a window fills and never letters, so it is the top of
   * the cascade rather than a reader of it. */
  _textStyleMoved() {}

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
      // XDND is a *default action* on a ClientMessage, so it follows the same
      // rule every other one does: it runs after the application's handler
      // and is skipped when that handler called `preventDefault()`. That is
      // the seam for a window answering the drag protocol itself.
      //
      // `_attachWindowListeners` subscribed to this stream first, so normally
      // the flag is already decided by the time this runs. `pending()` is the
      // exception it cannot cover: a message whose type had to be named with
      // a round trip is dispatched a few turns later, and answering the drag
      // before the application has been asked would make `preventDefault()`
      // depend on whether an atom happened to be cached.
      const said = this._clientMessages?.pending();
      const route = () => {
        if (ev.defaultPrevented) return;
        this._dnd.handleMessage(ev);
        // a drag *out* of this window gets its XdndStatus/XdndFinished back
        // on the same channel
        this._dragSession?.handleMessage(ev);
      };
      if (said) said.then(route);
      else route();
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
   * wrapping, a sibling growing, an ancestor viewport scrolling — scroll
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

  /**
   * Walk the drawn subtree and give every element that owns a real child X
   * window one — `<glarea>` and `<foreign>`.
   *
   * Here rather than in `createInstance` because the render phase is
   * discardable: a CreateWindow from a render React throws away leaks a
   * server resource, and a ReparentWindow from one has moved another
   * client's window for real (docs/extending.md).
   */
  _realizeChildWindows(node) {
    for (const child of node.children) {
      if (child.isWindow) continue;
      if (child.isGlArea || child.isForeign) child.realize();
      else this._realizeChildWindows(child);
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

  get semanticNames() {
    return WINDOW_SEMANTIC_NAMES;
  }

  /**
   * `parentWindow` is realize()'s, and only the close handshake reads it:
   * whether the window manager frames this window decides whether
   * WM_DELETE_WINDOW means anything on it.
   */
  _attachWindowListeners(parentWindow) {
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
      // The end of an `'auto'` window's authority over its own size. A
      // ConfigureNotify that does not match what we last asked for is
      // somebody else's decision — the user dragging an edge, or a window
      // manager applying a policy of its own — and from here on the window
      // is theirs. Growing it back under a user who has just made it smaller
      // is the one behaviour worse than not fitting the content.
      //
      // Checked against `_requestedSize` rather than ntk's `ev.resized`
      // because our own configures come back as echoes, and every one of
      // them would otherwise read as the user taking over on the first
      // re-fit.
      const asked = this._requestedSize;
      if (asked && (ev.width !== asked.width || ev.height !== asked.height)) {
        this._userSized = true;
      }
      // Where the window sits on screen decides where popups anchored to it
      // belong — and finding that out is a server round trip
      // (TranslateCoordinates), so it is worth not making one per frame of a
      // resize drag that never moved the window. `ev.moved` is ntk >= 6.2
      // (sidorares/ntk#184), which is the floor; the `?? true` is for a mock
      // window or a deduped older copy, which then keep the unconditional
      // refresh rather than losing the anchor.
      if (ev.moved ?? true) this._refreshScreenOrigin();
      if (this.props.onResize) {
        // the payload is application-facing: an app that stores this size
        // and writes it back as `width`/`height` props must round-trip
        // through one unit, and props are logical
        const s = this.scale;
        this.props.onResize(
          s === 1
            ? ev
            : {
                ...ev,
                width: ev.width / s,
                height: ev.height / s,
                x: ev.x / s,
                y: ev.y / s,
              },
        );
      }
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
    // Every ClientMessage addressed to this window (src/clientmessage.js).
    // Unconditional, unlike the two opt-ins below it: a ClientMessage is
    // delivered to the window's owner whatever event mask it selected, so
    // there is nothing to arm and nothing a window without the prop pays.
    // That in turn means the handler can be read from `props` per message —
    // the rule every other event here follows — instead of being frozen at
    // realize time.
    //
    // Attached before `_initDnd`'s listener on the same stream, which is what
    // makes `preventDefault()` able to stop react-x11 answering XDND itself.
    //
    // Another client asking this one for something is a user action arriving
    // by another route, so it lands at the priority — and in the paint — a
    // click would get: `discrete`, like the WM close below.
    this._clientMessages = createClientMessages(
      this,
      discrete((ev) => {
        // Read here rather than where the message was taken, since a type the
        // server had to be asked to name puts a round trip in between and
        // React may have replaced the handler across it.
        const handler = this.props.onClientMessage;
        if (!handler) return;
        runWithPriority(DiscreteEventPriority, () => {
          callHandler(this, 'onClientMessage', handler, ev);
        });
      }),
    );
    wnd.on('message', (raw) => {
      // A window with no handler takes nothing on the queue and asks the
      // server for nothing, on a stream that carries every XDND step of a
      // drag passing over it.
      if (this.props.onClientMessage) this._clientMessages.handle(raw);
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
    // WM close button. Armed for every window the window manager actually
    // manages, prop or no prop, because the alternative is not "no close
    // handling" but a killed connection: a client with no WM_DELETE_WINDOW
    // in WM_PROTOCOLS cannot be *asked* to close, so XKillClient is the only
    // move the WM has left. Effects never clean up, and IceWM puts a "do you
    // want to kill this client?" dialog in front of the user first. Every
    // other toolkit arms this unconditionally for the same reason; making it
    // the prop's side effect only moved that trap one level up.
    //
    // Not armed where the property is dead weight, which is every window the
    // WM does not frame: a child <window> (a region inside another window)
    // and an override-redirect <popup>. A `<popup overrideRedirect={false}>`
    // is a real dialog and does get it.
    //
    // ntk >= 5.3 owns the protocol: listening for 'close' self-arms
    // WM_PROTOCOLS and decodes the ClientMessage (#160). Its default action
    // — destroy the window — is always prevented, because what happens next
    // is React's decision: ntk tearing the window down underneath the
    // reconciler is exactly what this handler exists to avoid. This also
    // leaves the raw 'message' stream free for protocols react-x11 speaks
    // itself (XDND, src/dnd.js).
    if (!parentWindow && this.attributes?.overrideRedirect !== true) {
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
            else this._defaultCloseRequest();
          });
        }),
      );
    }
    this.events.attach();
  }

  /**
   * A close request nobody handled — `onCloseRequest` is the override, this
   * is what happens without one.
   *
   * Closing the app's primary window closes the app, which is what the
   * button means everywhere else on the desktop. The tree unmounts and the
   * connection closes, so effects clean up and the process ends on a drained
   * loop rather than on a dead socket.
   *
   * Any other top-level window is a dialog or a satellite, and whether it
   * goes away is app state this renderer cannot write: a `{open && <window/>}`
   * was opened by a `setOpen(true)` somewhere, and unmapping it behind
   * React's back would leave a window the app still believes is open and can
   * never reopen. So the request is refused, and in dev it is said out loud —
   * an inert close button is a bug, but a recoverable one, where guessing at
   * the app's state is not.
   */
  _defaultCloseRequest() {
    if (this._isPrimaryWindow()) {
      // fire and forget: unmount() is async (it awaits the connection
      // closing) and a WM close request is answered synchronously or not at
      // all. Errors reach the app's own handler, never an unhandled rejection.
      Promise.resolve(this.app?._reactX11Root?.unmount?.()).catch((err) => {
        this.app?.options?.onXError?.(err);
      });
      return;
    }
    if (DEV && !this._warnedNoCloseHandler) {
      this._warnedNoCloseHandler = true;
      console.warn(
        'react-x11: the window manager asked <window%s> to close, and it has ' +
          "no onCloseRequest — so nothing happened. Only the app's primary " +
          'window closes the app by default; a second window is opened by ' +
          'app state and only app state can close it.',
        this.props.title ? ` title=${JSON.stringify(this.props.title)}` : '',
      );
    }
  }

  /**
   * Whether this is the window whose close button means "quit".
   *
   * Inferred, not declared, because the tree already says it. A window that
   * is somebody's `transientFor` is a dialog *of* that window, and one with
   * an EWMH type of its own (`dialog`, `utility`, `splash`, …) has already
   * announced it is not the main window; what is left, in creation order, is
   * the app. That is the same rule startup.js uses to decide which window
   * carries the launch id, and for one-window apps — nearly all of them — it
   * is not a heuristic at all.
   *
   * A lone window is the app whatever it calls itself: an app whose only
   * window is a `utility` still has to be closable. An app that disagrees
   * with any of this passes `onCloseRequest`, which never reaches here.
   */
  _isPrimaryWindow() {
    const tops = topLevelWindows(this.app);
    if (!tops.includes(this)) return false;
    const candidates = tops.filter((node) => node._isPrimaryCandidate());
    if (candidates.length === 0) return tops.length === 1;
    return candidates[0] === this;
  }

  /** Top-level, nobody's dialog, and of no special type: a main-window shape. */
  _isPrimaryCandidate() {
    if (this.props.transientFor != null) return false;
    const type = this.props.windowType;
    const plain = (t) => t == null || t === 'normal';
    return Array.isArray(type) ? plain(type[0]) : plain(type);
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
      const mounting = child.parent == null;
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
      if (this.theme || child.props.theme) child._themeChanged(mounting);
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
      const index = this._indexOfChild(child);
      if (index !== -1) {
        this.children.splice(index, 1);
        this._nonYogaKids--;
      }
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
    // before endWindowState below, which is the session this is subscribed to
    this._unwatchLoops();
    this._loopNodes.clear();
    this._animating.clear();
    // `useWindowState()`'s listeners, and the raw VisibilityNotify handler
    // it put on the shared connection, which nothing else would take off
    endWindowState(this);
    // Before the owner's next layout pass, which is this same commit: a
    // popup that has gone still holds a subscription to the window it was
    // anchored to, and answering that notification would configure a dead
    // window.
    this._unwatchAnchor();
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
    assertWindowSize(newProps, this.kind);
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
      this.attributes = {
        ...this.attributes,
        ...windowAttributes(newProps, this.scale),
      };
      // The flag `realize()`'s map will read — set directly, since there is
      // nothing on screen yet for the notification half of `_applyHidden`
      // to be about.
      this.hidden = this._reactHidden || Boolean(newProps.hidden);
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
    // Compared after normalising, so that an app switching between an
    // omitted size and a spelled-out `'auto'` — the same request written two
    // ways — is not a change and does not reset the state below.
    const sizeChanged =
      canonicalSize(newProps.width) !== canonicalSize(before.width) ||
      canonicalSize(newProps.height) !== canonicalSize(before.height);
    // An anchored window's position is the anchor's business, not the
    // app's: `x`/`y` are ignored while `anchor` is set (`_followAnchor`
    // sends the moves), so a commit that changed nothing else is not a
    // configure back to a stale prop.
    const anchored = Boolean(newProps.anchor);
    const movedByProps =
      !anchored && (newProps.x !== before.x || newProps.y !== before.y);
    const geometryChanged = sizeChanged || movedByProps;
    // A size that became a number is the app taking the size over, which is
    // exactly the state `_userSized` names — and one that became `'auto'` is
    // the app handing it back, so the window fits its content again on the
    // next layout even if the user had resized it before.
    //
    // The record moves with it, and an axis still on `'auto'` records the
    // size the window *has*, because that is the one this configure is not
    // about to change. Without that the echo of a one-axis configure would
    // disagree with the record on the other axis and read as somebody else
    // setting the size — locking the window on the app's own update.
    // The comparisons above ran on the raw props — logical against logical
    // — and everything below talks to the server, so it is device from here
    // (`wnd.width`, `_requestedSize` and the ConfigureNotify echo are all
    // device pixels; a logical number among them would misread every user
    // resize as `_userSized`).
    const geo = scaleWindowGeometry(newProps, this.scale);
    if (sizeChanged) {
      this._userSized = false;
      this._requestedSize = {
        width: isAutoSize(geo.width) ? wnd.width : geo.width,
        height: isAutoSize(geo.height) ? wnd.height : geo.height,
      };
    }
    if (geometryChanged) {
      if (typeof wnd.setState === 'function') {
        wnd.setState({
          x: anchored ? undefined : geo.x,
          y: anchored ? undefined : geo.y,
          // `'auto'` is not a geometry ntk can be given: an axis the app has
          // handed back is left alone here and resolved by `_refit()` on the
          // layout this same commit is about to schedule.
          width: isAutoSize(geo.width) ? undefined : geo.width,
          height: isAutoSize(geo.height) ? undefined : geo.height,
        });
      } else {
        if (sizeChanged && !isAutoSize(geo.width) && !isAutoSize(geo.height)) {
          wnd.resize?.(geo.width, geo.height);
        }
        if (movedByProps) {
          wnd.move?.(geo.x, geo.y);
        }
      }
    }

    // Re-read every commit: the options object is rebuilt by every render,
    // and a moving `at` — a caret — is the whole point of one. Only the
    // *subscription* is conditional, because only the node it hangs off can
    // make it stale.
    if (newProps.anchor?.to !== before.anchor?.to) this._watchAnchor();
    if (anchored) {
      this._followAnchor();
    } else if (before.anchor) {
      this._placedAt = null;
      // A popup that gives up its anchor gives up being hidden by one: it
      // is an ordinary `x`/`y` popup from here, and the configure above
      // has already put it where the app asked.
      const wasLost = this._anchorLost;
      this._anchorLost = false;
      if (wasLost) this._mapNow();
    }

    // After the geometry above on purpose: a window revealed and moved in
    // the same commit is configured first and mapped second, so it is never
    // on screen at the position it was hidden at.
    if (Boolean(newProps.hidden) !== Boolean(before.hidden)) {
      this._applyHidden();
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

  /**
   * A window is hidden by unmapping it, not by yoga's `display: none`: it is
   * its own layout root, so collapsing it would throw away the arrangement
   * it comes back to — and there is no parent flex line for it to leave.
   * The flag is still recorded, because it is what tells a map that has not
   * gone out yet not to bother.
   */
  setHidden(hidden) {
    this._reactHidden = hidden;
    this._applyHidden();
  }

  /**
   * Re-derive `this.hidden` from its two writers — the reconciler's flag and
   * the `hidden` prop — and make the window agree. Either saying "hidden"
   * wins, so a `<Suspense>` revealing its content does not map a window the
   * app is holding off screen, and clearing the prop does not map one React
   * still hides.
   */
  _applyHidden() {
    const hidden = this._reactHidden || Boolean(this.props.hidden);
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    // An unmapped window draws nothing, so a loop inside one is frames
    // nobody sees — the same stop the WM's own minimize gets, by the same
    // route, and the flag is kept true so a later VisibilityNotify agrees
    // with it.
    if (this._loopNodes.size) this._loopVisibilityChanged();
    // An unmapped window is off screen however focused the server thinks it
    // is, and a `<popup>` is worse than that: it shares the owner window's
    // keyboard, so a node inside one that is no longer on screen would go on
    // taking keys the owner window is still receiving.
    this._visibilityChanged(!hidden);
    // A map still queued for the end of this commit reads `hidden` when it
    // runs, so there is nothing to send here — and an unmap sent now would
    // do nothing anyway, the server not having mapped the window yet
    // (issue #201).
    if (pendingMaps.has(this)) return;
    if (hidden) {
      // release before the unmap, the order `_followAnchor` uses — X would
      // drop the grab with the viewability anyway, but not on the mock, and
      // an explicit release is one less state to reason about
      if (this.props.grab) this.window?.ungrabPointer?.();
      this.window?.unmap?.();
    } else if (inCommit) {
      // A reveal mid-commit waits for the end of it the way a fresh window's
      // first map does, so anything later in the same commit that hides the
      // window again (React hides a subtree only after mutating it) is
      // known before the map goes out — the same WM race as issue #201.
      pendingMaps.add(this);
    } else {
      this._mapNow();
    }
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
    // A retained presenter keeps a per-node diff instead of damage rects,
    // and this is the one channel every change already announces itself on
    // (docs/macos.md §"One renderer, two presenters"). Feature-detected: an
    // ntk window has no ear here and the X11 path is byte-identical.
    this.window?.noteInvalidate?.(damage, layoutChanged, reason);
    if (layoutChanged) {
      this.needsLayout = true;
      // The content floors are measured from the tree, so anything that
      // changed it has to give them up — and **scrolling does not**, which is
      // the whole reason this is not just `needsLayout`: a scroll moves an
      // offset applied during `absolutize` and leaves every yoga node exactly
      // as it was, at input rate, on the biggest trees in any app.
      if (reason !== 'scroll') this._floorsDirty = true;
    }
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
    // The region this claim actually covers — a node's paint reach, clipped
    // to a blitting viewport above it (issue #398), or the bare rect a
    // caller handed over. Null when the clip left nothing (the node draws
    // where nothing can be seen, so it owes no pixels), and null on a frame
    // that is already unbounded, which owes neither a rect nor the subtree
    // walk that measures one — a blit cannot fire there either.
    const bounds =
      damage && damage !== NO_DAMAGE && this._damage !== FULL_DAMAGE
        ? damage._claimBounds
          ? damage._claimBounds()
          : damage
        : null;
    const pendingScrolls = this._pendingScrolls;
    if (pendingScrolls?.size && bounds && this._scrollClaim !== damage) {
      const rect = bounds;
      for (const sv of pendingScrolls) {
        // An element blitting a region of its own drawing (issue #303) is
        // waiting on that region, not on the whole node it lives in — and
        // it is waiting on it *exactly* (issue #309). Its claim is the rect
        // itself, and `_blitKeptDamage` recognises it as the rect itself, so
        // a foreign claim that could be swallowed by it has to overlap it:
        // the ring outside is beyond reach. A scroll container's claim is
        // its viewport plus slop and is recognised to that tolerance, so a
        // claim in that ring *can* merge into it without ever touching the
        // viewport — and the wider zone is what keeps it out.
        //
        // The difference is what lets an element carve furniture out of the
        // rect it blits — a minimap pinned to a corner, a strip it repaints
        // itself — and keep the pan at blit cost while that furniture
        // claims beside it.
        const contents = sv._pendingBlitContents;
        const waiting = contents
          ? contents.rect
          : sv.abs && insetRect(sv.abs, -(DAMAGE_SLOP * 2 + 1));
        if (!waiting || rectsOverlap(rect, waiting)) {
          // …unless this viewport is keeping a ledger of what changed
          // inside it (issue #398): the region goes in the ledger and
          // `_applyScrollBlits` repaints it after the blit, which is the
          // same pixels on screen for a fraction of the drawing. The
          // ledger says no when the frame stops paying, and then this
          // falls through to the poison exactly as before.
          if (sv._blitLedgerOpen() && sv._recordBlitClaim(rect)) {
            continue;
          }
          // Poison rather than disarm (react-x11#295): a null here would
          // let a second scrollTo in the same frame re-arm from a
          // mid-frame origin, and the blit would then move pixels that
          // were never repainted at that origin — a band displaced by the
          // first scroll's delta. The node stays in pendingScrolls so the
          // up-front clear in _applyScrollBlits resets the poison exactly
          // like a real origin.
          sv._pendingBlitFrom = BLIT_POISONED;
        }
      }
    }
    if (layoutChanged && !damage) this._damage = FULL_DAMAGE;
    else if (!layoutChanged && !damage) this._damage = FULL_DAMAGE;
    else if (!bounds) {
      // A layout change that names no region: either NO_DAMAGE, from a
      // caller with a finer claim already in flight, or a node whose reach
      // a clipping ancestor left nothing of (issue #398). Unlike `!damage`
      // neither is "something, somewhere", so neither costs a full repaint.
    } else if (this._damage !== FULL_DAMAGE) {
      // a node, or a bare rect for a caller that has a region rather than a
      // node — a subtree that is about to be removed, say. Claims accumulate
      // as a list of rects rather than one box around them all, so two changes
      // at opposite corners of the window no longer repaint everything
      // between them.
      this._damage = addDamageRect(this._damage, bounds);
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
    // A frame is scheduled a tick before it is painted, and the connection
    // can go in between: an app closing its own client, a server exit, a
    // test closing the app it lent the root. Nothing unmounts the tree on
    // that route, so the frame arrives with a live window node and a dead
    // socket, and the first request it makes throws out of the frame clock
    // where there is nothing waiting to catch it. There is no screen left to
    // paint to, so this owes nothing either.
    if (this.app?.X?._closing) return;
    // a transientFor whose owner was not realized yet at commit time. The
    // frame after the mount is the first moment refs have attached, so the
    // common "two <window>s in one tree" case resolves here rather than
    // waiting for the app to re-render for some unrelated reason.
    if (this._pendingTransientFor !== undefined) {
      this._applyTransientFor(this._pendingTransientFor);
    }
    // A window that realized after a loop registered has one now
    if (this._loopNodes.size && !this._loopWatch) this._watchLoops();
    this._advanceAnimations(now());
    if (this.needsLayout) this._refit();
    const width = this.window.width ?? this._requestedSize?.width ?? 0;
    const height = this.window.height ?? this._requestedSize?.height ?? 0;
    let layoutMoved = false;
    // captured before the branch clears it: whether *this* flush ran a
    // layout pass is what decides whether an anchored popup needs a look,
    // not the flag's post-pass value
    const layoutRan = this.needsLayout;
    if (this.needsLayout) {
      // From here on a claim names where its content *landed*, not where it
      // sat before the scroll — which is what decides whether a blit
      // ledger's rect moves with the shift (issue #398).
      this._laidOut = true;
      this._resolveSizeQueries(width, height);
      this._applyContentFloors(width);
      this.yoga.setWidth(width);
      this.yoga.setHeight(height);
      this.yoga.calculateLayout(width, height, this._rootDirection);
      this.abs = { x: 0, y: 0, width, height };
      this._placed = true;
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
        // `_absolutizeChildren`, not the loop it wraps: a `<window
        // style={{overflow: 'scroll'}}>` is a scroll container like any box,
        // and this is where its offset gets applied to the children
        this._absolutizeChildren(0, 0);
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
        // …and the pre-mutation walk this frame reused goes with it
        node._reflowBefore = null;
        if (node.destroyed || this._damage === FULL_DAMAGE) continue;
        // clipped to a blitting viewport above it, like every other claim
        // this frame, and written to that viewport's ledger too (issue
        // #398): the claim would otherwise coalesce into the scroll's own
        // and be dropped with it, leaving the band the blit kept holding
        // this node's pixels from before the reflow.
        const after = node._claimBounds();
        if (!after) continue;
        const sv = node._blitViewport();
        if (sv && !sv._recordBlitClaim(after)) {
          sv._pendingBlitFrom = BLIT_POISONED;
        }
        this._damage = addDamageRect(this._damage, after);
      }
      this._reflowed.clear();
    } else if (this._reflowed.size) {
      for (const node of this._reflowed) node._reflowBefore = null;
      this._reflowed.clear();
    }
    // any node this pass laid out may be what an open popup is anchored to
    if (layoutRan) this._notifyAnchorChange();
    // after layout (the claims above included), before the damage is taken:
    // a frame that turns out to be a pure scroll blits the surviving band
    // and narrows its claim to the exposed strip
    this._applyScrollBlits(width, height, layoutMoved);
    // …and the next commit's claims name the arrangement this frame leaves
    // behind again, from before whatever scroll comes with them
    this._laidOut = false;
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
    // A retained presenter takes the frame from here: the model half above —
    // animations, layout, absolutize, the scroll offsets — is shared, and
    // what changes per backend is how a frame reaches the screen. The damage
    // list was still taken (its bookkeeping is what keeps the two paths one
    // code) and is simply not consumed; the presenter diffs at the layer.
    if (typeof this.window.presentFrame === 'function') {
      this.window.presentFrame(this, damage);
      this.app._reactX11Startup?.painted();
      return;
    }
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
        // ntk's `frameLatency`: how long the previous frame took to be
        // answered. On the vertical-blank clock that is time-to-display and
        // reads about a refresh period; on the fence clock it is the server
        // round trip that drained the frame's requests. Client work and
        // server work separate cleanly in a trace only when both are in it —
        // a slow virtualized GPU shows up here, not in `end`.
        landed: this.window.frameLatency,
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
    const contents = nodes[0]._pendingBlitContents;
    const ledger = nodes[0]._blitLedger;
    for (const n of nodes) {
      n._pendingBlitFrom = null;
      n._pendingBlitContents = null;
      n._blitLedger = null;
    }
    // two viewports scrolling in one frame is rare enough that sorting out
    // whether their regions interact is not worth it
    if (nodes.length !== 1) return;
    const node = nodes[0];
    // a poisoned frame (react-x11#295) falls back to the full-viewport
    // claim the scroll recorded, like every other declined gate here
    if (from === BLIT_POISONED) return;
    if (NO_SCROLL_BLIT || !from || node.destroyed || node.root !== this) return;
    const wnd = this.window;
    if (typeof wnd?.scrollRegion !== 'function') return; // ntk without #139
    // the debug overlays and the DevTools highlight draw over the whole
    // window; a blit would drag shifted copies of them along
    if (
      debugPaint ||
      process.env.REACT_X11_DEBUG_LAYOUT ||
      this._highlight ||
      this._traceUpdates
    ) {
      return;
    }
    if (!Array.isArray(this._damage)) return; // unbounded frame already
    // the layout diff claimed real movement this pass — the frame is not a
    // pure scroll, and a blit under rearranged content would shift stale
    // pixels into place the repaint no longer covers
    if (layoutMoved) return;
    // From here the two arming paths part company: an element handed us the
    // region and the shift itself (issue #303), where a scroll container is
    // its whole viewport shifted by the change in its offsets.
    if (contents) {
      this._applyContentsBlit(node, contents, width, height);
      return;
    }
    // children clip to the border box, so a border ring or rounded corner
    // would be shifted like content — any painted side counts
    const blitBorder = resolveBorderWidths(node.style, node.direction);
    if (
      blitBorder.top > 0 ||
      blitBorder.right > 0 ||
      blitBorder.bottom > 0 ||
      blitBorder.left > 0 ||
      node.style.borderRadius > 0
    ) {
      return;
    }
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
    const keep = this._blitKeptDamage(vp);
    if (!keep) return;
    // What changed inside the viewport while the blit was armed, in the
    // coordinates the frame is about to paint in (issue #398). A claim made
    // during the commit named where the content sat before the shift, and
    // the blit is about to move those pixels by the frame's delta, so it
    // moves with them; a claim from the layout diff already landed there.
    //
    // Repainting the result is what makes the blit honest about them: the
    // blit translates the previous frame's rendering, which is correct
    // everywhere the content did not change, and these are the places it
    // did. That is finer than the strip-only rule issue #398 asks for and
    // no more complicated, so a mid-viewport change — a row upgrading from
    // skeleton to content while the list scrolls — rides the fast path too
    // instead of falling back to the whole viewport.
    const repairs = [];
    let repairArea = 0;
    for (const claim of ledger ?? []) {
      const moved = claim.pre
        ? {
            x: claim.x - dx,
            y: claim.y - dy,
            width: claim.width,
            height: claim.height,
          }
        : claim;
      const inside = intersectRects(moved, vp);
      if (!inside) continue;
      repairs.push(inside);
      repairArea += inside.width * inside.height;
    }
    // past this the blit plus a scatter of repaints is no longer cheaper
    // than the one full-viewport pass it replaced
    if (repairArea > area * BLIT_MAX_CLAIM_AREA) return;
    if (!this._scrollBlitSafe(node, vp)) return;
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
    for (const repair of repairs) rects = addDamageRect(rects, repair);
    // The last gate, and the only one that has to wait until the rects are
    // assembled: the frame carries at most MAX_DAMAGE_RECTS of them, so a
    // repair that does not sit beside the strip is merged with whatever is
    // nearest — the scrollbar column, most often — and the box of that
    // merge can reach back across the viewport. When it does, the blit is
    // buying a shift and paying for the viewport anyway, so let the plain
    // repaint scrollTo already claimed have the frame.
    let painted = 0;
    for (const rect of rects) {
      const inside = intersectRects(rect, vp);
      if (inside) painted += inside.width * inside.height;
    }
    if (painted > area * SCROLL_BLIT_MAX_REPAINT) return;
    // scroll offsets grow down/right; the pixels move the other way
    // (0 - x rather than -x: negating +0 yields -0, which survives into
    // request buffers and test comparisons)
    if (!wnd.scrollRegion({ ...vp }, 0 - dx, 0 - dy)) return;
    this._damage = rects;
  }

  /**
   * The frame's damage with the shift's own claim taken out, or null if the
   * shift is not the only thing that happened inside `vp`.
   *
   * The claim recorded by `scrollTo` (with its slop) or by `scrollContents`
   * (exactly `vp`) is the one rect allowed to reach in. Anything else — a
   * virtualized table's row swap, a hover restyle mid-scroll, a coalesce
   * that swallowed the claim into a bigger box — means pixels in there
   * changed, and changed pixels must not be blitted around.
   *
   * `exact` is how an element blit asks for the strict form of that: the
   * claim has to still *be* `vp`, not merely cover it within the slop
   * (issue #309). The claim is dropped here in favour of the strips the
   * shift exposed, so anything merged into it is dropped with it — and the
   * damage cap merges neighbours on its own, without a claim-time gate to
   * poison first. Requiring the rect back unchanged is what lets the
   * claim-time gate narrow to `vp` itself and let furniture beside it live.
   */
  _blitKeptDamage(vp, exact = false) {
    const keep = [];
    let sawClaim = false;
    const slopped = insetRect(vp, -(DAMAGE_SLOP + 1));
    for (const rect of this._damage) {
      if (!rectsOverlap(rect, vp)) {
        keep.push(rect);
        continue;
      }
      if (
        exact
          ? rect.x === vp.x &&
            rect.y === vp.y &&
            rect.width === vp.width &&
            rect.height === vp.height
          : rectContains(rect, vp) && rectContains(slopped, rect)
      ) {
        sawClaim = true;
        continue;
      }
      return null;
    }
    return sawClaim ? keep : null;
  }

  /**
   * The other half of the blit: a region an element shifted itself
   * (`Node.scrollContents`, issue #303).
   *
   * The gates are the scroll path's, minus everything that was about a
   * scroll container — there are no offsets to be whole, no scrollbars to
   * repair, and no extent that decided the delta — and plus the two things
   * only an element-owned region raises: the region has to be inside what
   * the element itself draws, and this node's *children* are laid out over
   * that drawing rather than being it.
   *
   * Diagonal shifts are allowed here, unlike the scroll path, and that is
   * the point rather than an oversight: a pan is diagonal almost every
   * frame, and the reason the scroll path takes one axis at a time is that
   * the L of exposed strips overlaps the scrollbar rects and the merges
   * balloon back towards the whole viewport. With no bars the L is two
   * disjoint rects and stays two.
   */
  _applyContentsBlit(node, { rect: vp, dx, dy }, width, height) {
    // only a whole-pixel shift of a whole-pixel region is a copy
    if (!isIntegerRect(vp)) return;
    if (!Number.isInteger(dx) || !Number.isInteger(dy)) return;
    // the net shift of the frame, which several pans can cancel out of
    if (dx === 0 && dy === 0) return;
    if (Math.abs(dx) >= vp.width || Math.abs(dy) >= vp.height) return;
    // the worth-it heuristics, the scroll path's: below these the plain
    // repaint is one cheap pass and the bookkeeping outweighs it
    const area = vp.width * vp.height;
    if (area < SCROLL_BLIT_MIN_AREA) return;
    const kept = (vp.width - Math.abs(dx)) * (vp.height - Math.abs(dy));
    if (kept < area * SCROLL_BLIT_MIN_KEEP) return;
    // the band shifts in from inside the window; a region poking out of it
    // has nothing there to shift
    if (
      vp.x < 0 ||
      vp.y < 0 ||
      vp.x + vp.width > width ||
      vp.y + vp.height > height
    ) {
      return;
    }
    // Inside the element, and clear of its own border ring and rounded
    // corners: those are `Node.paint`'s, not the element's drawing, and
    // they do not translate. A solid background does, so the fill under the
    // region is not a reason to decline.
    const bw = resolveBorderWidths(node.style ?? EMPTY_STYLE, node.direction);
    const inset = Math.max(
      bw.top,
      bw.right,
      bw.bottom,
      bw.left,
      node.style?.borderRadius ?? 0,
    );
    if (!rectContains(insetRect(node.abs, inset), vp)) return;
    // A scroll container's children *are* the scrolled content, which is
    // why _scrollBlitSafe skips that subtree. An element's are not: it
    // draws the region in paintContent and its children are laid out on
    // top, so one reaching in would have its pixels dragged along.
    for (const child of node.children) {
      if (child.isWindow || !child.yoga || child.hidden) continue;
      if (child.style?.display === 'none') continue;
      if (rectsOverlap(child._subtreeBounds(), vp)) return;
    }
    const keep = this._blitKeptDamage(vp, true);
    if (!keep) return;
    if (!this._scrollBlitSafe(node, vp)) return;
    // the element's deltas are already how far the pixels moved, the sense
    // scrollRegion takes (0 + x rather than x: a caller's -0 would survive
    // into request buffers and test comparisons)
    if (!this.window.scrollRegion({ ...vp }, 0 + dx, 0 + dy)) return;
    let rects = keep;
    // The strips the shift exposed, on the sides the pixels came from. The
    // horizontal one takes the full width and the vertical one takes what
    // is left, so a diagonal shift claims two rects that do not overlap —
    // overlapping claims merge into their box, and the box of an L is the
    // whole region again.
    if (dy !== 0) {
      rects = addDamageRect(rects, {
        x: vp.x,
        y: dy > 0 ? vp.y : vp.y + vp.height + dy,
        width: vp.width,
        height: Math.abs(dy),
      });
    }
    if (dx !== 0) {
      rects = addDamageRect(rects, {
        x: dx > 0 ? vp.x : vp.x + vp.width + dx,
        y: dy > 0 ? vp.y + dy : vp.y,
        width: Math.abs(dx),
        height: vp.height - Math.abs(dy),
      });
    }
    this._damage = rects;
  }

  /**
   * May the viewport's pixels be moved wholesale? Only if every pixel in it
   * belongs to the scrolled content (or to a plain solid fill behind it):
   * any node outside the scroller's subtree whose drawing reaches into
   * the viewport — an overlapping sibling, an ancestor's border ring or
   * rounded corner, an enclosing viewport's scrollbar — would have its
   * pixels dragged along by the blit, so any of them is a no.
   */
  _scrollBlitSafe(scroller, vp) {
    // the window itself scrolls: everything inside it *is* the scrolled
    // content, so there is nothing that could be dragged along
    if (scroller === this) return true;
    const ancestors = new Set();
    for (let n = scroller.parent; n && n !== this; n = n.parent) {
      ancestors.add(n);
    }
    const check = (parent) => {
      for (const child of parent.children) {
        if (child === scroller) continue; // the scrolled content itself
        if (child.isWindow || !child.yoga || child.hidden) continue;
        if (child.style?.display === 'none') continue;
        if (ancestors.has(child)) {
          // on the path down: its solid background under the viewport is
          // translation-invariant, its border ring and corners are not.
          // The widest side is conservative for a non-uniform border
          const bw = resolveBorderWidths(
            child.style ?? EMPTY_STYLE,
            child.direction,
          );
          const inset = Math.max(
            bw.top,
            bw.right,
            bw.bottom,
            bw.left,
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
      // a scrolling window draws its own bars, which `Node.paint` would have
      // done for a box — the window never goes through it
      this._paintScrollbars(ctx);
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
      if (this._traceUpdates) {
        ctx.lineWidth = 2;
        for (const r of this._traceUpdates) {
          ctx.strokeStyle = r.color;
          ctx.beginPath();
          // inset by the stroke so an outline on a rect flush with the
          // window edge is not half-clipped away
          ctx.rect(r.x + 1, r.y + 1, r.width - 2, r.height - 2);
          ctx.stroke();
        }
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
    if (DEV && this.style.boxShadow) devWarnWindowShadow(this.kind);
    // A `backgroundImage` works wherever a `backgroundColor` does, which is
    // the rule worth having — over the whole window, in window coordinates,
    // and still filling only the damage rect: the gradient is a source
    // picture in device space, so a slice of it is the slice that belongs
    // there.
    const gradient = this._backgroundGradient(ctx, {
      x: 0,
      y: 0,
      width,
      height,
    });
    const fill = (style, rounded) => {
      ctx.fillStyle = style;
      if (rounded) {
        // The path is the whole window however small the damage rect is —
        // the clip bounds it — so repainting one corner still draws that
        // corner's curve rather than a square patch of background.
        ctx.beginPath();
        ctx.roundRect(0, 0, width, height, borderRadius);
        ctx.fill();
      } else if (damage) {
        ctx.fillRect(damage.x, damage.y, damage.width, damage.height);
      } else {
        ctx.fillRect(0, 0, width, height);
      }
    };
    if (this.transparencyEffective) {
      if (!isPaintedColor(backgroundColor) && !gradient) return;
      const rounded = borderRadius > 0 && typeof ctx.roundRect === 'function';
      if (isPaintedColor(backgroundColor)) fill(backgroundColor, rounded);
      if (gradient) fill(gradient, rounded);
      return;
    }
    // An ARGB window that nothing is compositing has an alpha channel it
    // must not use. It gets filled edge to edge and square — `borderRadius`
    // is ignored, because giving up the corners here would expose the
    // black those pixels really are. A translucent colour is flattened
    // over white rather than composited onto the last frame, which on a
    // window with alpha would otherwise creep towards opaque a frame at a
    // time and never settle anywhere predictable.
    if (this._transparent) fill('white', false);
    // No `backgroundColor` means the desktop's, not white: a window whose
    // widgets went dark on a dark desktop must not leave a white rectangle
    // behind them. An app that named a colour gets the colour it named.
    //
    // repainting the background only where it is about to be drawn over is
    // the other half of the win: a full-window fill is a full-window
    // composite however little changed
    fill(backgroundColor || this.theme.background, false);
    if (gradient) fill(gradient, false);
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

  /**
   * DevTools' "highlight updates when components render": outline the rects
   * that just re-rendered, in the colour the backend assigned each one (it
   * ramps with the update count and fades them out on its own clock, so
   * this is a dumb overlay — `rects` is the whole state, `null` clears it).
   */
  setTraceUpdates(rects) {
    const previous = this._traceUpdates;
    const next = rects?.length ? rects : null;
    if (!previous && !next) return;
    this._traceUpdates = next;
    // The stroke sits inside the rect, but a rect whose node has since
    // moved or gone claims where it *was*; both lists are claimed for the
    // same reason setHighlight claims both of its rects.
    for (const r of [...(previous ?? []), ...(next ?? [])]) {
      this.invalidate(false, r, 'trace-updates');
    }
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
   *
   * The grab rides the map, not `realize()`: X refuses a grab on an
   * unviewable window (`GrabNotViewable`) and silently drops one whose
   * window unmaps, so a popup born `hidden` — or one whose anchor is off
   * screen — takes the grab when it actually reaches the screen. Grabbing
   * from realize looked equivalent until `hidden` existed, and would have
   * left a revealed menu holding no grab: open forever behind the first
   * outside click, with nothing saying why.
   */
  _mapNow() {
    if (!super._mapNow()) return false;
    if (this.props.grab) this.window.grabPointer?.({}, () => {});
    return true;
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
    // default (e.g. "tooltip", "dropdown_menu"); `popup_menu` is the
    // least-wrong answer for a popup that declares nothing, and the widgets
    // that know better say so themselves — `Select`'s sheet is a
    // `dropdown_menu`, a `Tooltip` a `tooltip` (issue #298).
    super(
      app,
      {
        ...attributes,
        overrideRedirect: attributes.overrideRedirect ?? true,
        windowType: attributes.windowType ?? 'popup_menu',
      },
      props,
    );
    this.isPopup = true;
  }
}

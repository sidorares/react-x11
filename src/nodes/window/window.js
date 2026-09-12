// <window>: the node that owns a real X11 window. Realizing it, mapping it at
// the end of the commit that created it (#201), stacking its child windows,
// and the props and tree operations a window handles differently from a
// box. The rest of WindowNode lives with its concerns — the window-only ones
// beside this file, and its halves of the ones it shares with Node beside
// Node's — installed at the bottom (see install.js).

import { applyLayoutStyle, paintPropsChanged } from '../../styles.js';
import { EventManager } from '../../events.js';
import { forgetTopLevel, hasDropProps } from '../../dnd.js';
import { clearPendingFrame } from '../../frames.js';
import { FramePacer } from '../../pacing.js';
import { endWindowState } from '../../windowstate.js';
import { anchorOffscreen } from '../../anchor.js';
import { topLevelWindows } from '../../windowid.js';
import { WindowAnimation } from '../animation.js';
import { WindowCascade } from '../cascade.js';
import { NO_DAMAGE } from '../damage.js';
import { installMethods } from '../install.js';
import { WindowInvalidate } from '../invalidate.js';
import { WindowLayoutHost } from '../layouthost.js';
import { DEVTOOLS_FAKE_DOCUMENT, Node } from '../node.js';
import { WindowPaint } from '../paint.js';
import { WindowPosition } from '../position.js';
import { WindowQueries } from '../queries.js';
import { Scrollable } from '../scrollable.js';
import { WindowScrollBlit } from '../scrollblit.js';
import { WindowAnchoring } from './anchoring.js';
import { pixelFor, WindowCapabilities } from './capabilities.js';
import { WindowDebugPaint } from './debugpaint.js';
import { WindowDropTarget } from './droptarget.js';
import { WindowFlush } from './flush.js';
import {
  isAutoSize,
  canonicalSize,
  assertWindowSize,
  scaleWindowGeometry,
  windowAttributes,
  windowStates,
  applyWindowStates,
  applyDecorations,
  WINDOW_SEMANTIC_NAMES,
  WindowHints,
} from './hints.js';
import { WindowListeners } from './listeners.js';
import { WindowSize } from './size.js';

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

/** Apply any child-window stacking changes the commit produced, once. */
export function flushWindowRestacks() {
  const nodes = [...pendingRestack];
  pendingRestack.clear();
  for (const node of nodes) node._restackWindowChildren();
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
    // The frame pacer (src/pacing.js): whether a claim waits before its
    // frame is scheduled, priced by what the last frames cost. Off unless
    // the `frameRate` prop, the root's default or the environment says
    // otherwise — resolved again whenever the prop changes.
    this._pacer = new FramePacer();
    this._framePolicy = null;
    this._syncFramePolicy();
    // a claim raised by the frame on itself is scheduled once the frame is
    // over and its cost is known (`flush`)
    this._inFlush = false;
    this._claimAfterFlush = false;
    // the nodes answering `opaqueRect()`, and — during a paint pass one of
    // them covers — that node with its ancestors, whose fills are skipped
    // (`_coverFor`, `Node._paintBackground`)
    this._opaqueNodes = new Set();
    this._coverChain = null;
    // Nodes that want the `attention` event (ntk#37) — an
    // `unstable_onAttention` prop,
    // an `:attention` block, or both. Built before the EventManager so the
    // manager can hold the reference itself: the whole feature has to be
    // behind one `size` read on the motion path, and a tree that never asked
    // for attention must not pay a property walk to find that out.
    this._attentionNodes = new Set();
    // The GL surfaces in this window, bottom to top: `<glarea>`s, stacked
    // above everything 2D here, which the hit test therefore asks before the
    // tree (`EventManager._surfaceAt`). A surface joins when its window is
    // made and leaves when it goes (src/glnodes.js).
    this._surfaces = [];
    // …and the ones with children, whose panes each frame syncs after layout
    // and paints with its damage (nodes/window/flush.js, src/gloverlay.js).
    // Empty is one `size` read a frame.
    this._overlaid = new Set();
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
    // nodes with `@container` blocks, re-resolved after every layout pass
    // against the containers they ask about — see _resolveContainerQueries.
    // `_cqFresh` is true while a pass this window just ran is being settled,
    // when every attached node has a computed size to offer
    this._containerQueryNodes = new Set();
    this._cqFresh = false;
    // nodes whose `position` is placed after layout (sticky among them),
    // placed after every layout pass — see _placeNodes — and whether one
    // asked for a frame of its own, with nothing to lay out (an animated
    // position)
    this._placedNodes = new Set();
    this._placementsDue = false;
    // nodes arranging their children with a layout algorithm, placed at the
    // end of every layout step — see _placeLayoutHosts — and the ones whose
    // algorithm threw this pass, laid out as flexbox before the frame is done
    this._layoutHosts = new Set();
    this._failedHosts = new Set();
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
    // The automatic minimum size (#249): whether the floors are still the
    // answer, the width the height half of them was measured for, the nodes
    // this frame found stale (`collectFloorStale`), and two counters the
    // tests read — layout passes over the root and nodes measured.
    this._floorsDirty = true;
    this._floorsWidth = null;
    this._floorsStale = new Set();
    // whether the first floors pass has run (`collectFloorStale`'s sweep)
    this._floorsSwept = false;
    this._floorsMeasured = 0;
    this._layoutPasses = 0;
    // whether the tree's CONTENT moved since the floors were measured — a
    // resize alone does not, which is what lets a live resize defer them
    this._floorsContentDirty = true;
    this._floorsCatchUp = false;
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

  get semanticNames() {
    return WINDOW_SEMANTIC_NAMES;
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
    this._pacer.cancel();
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
    if (newProps.frameRate !== before.frameRate) this._syncFramePolicy();
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
}

// The rest of WindowNode's methods live with their concerns: the
// window-only ones beside this file, and its halves of the concerns it
// shares with Node beside Node's (see install.js).
installMethods(
  WindowNode,
  WindowCascade,
  WindowQueries,
  WindowAnimation,
  WindowLayoutHost,
  WindowPosition,
  WindowInvalidate,
  WindowScrollBlit,
  WindowPaint,
  WindowListeners,
  WindowHints,
  WindowSize,
  WindowFlush,
  WindowDebugPaint,
  WindowAnchoring,
  WindowCapabilities,
  WindowDropTarget,
);

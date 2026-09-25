// An ntk-window-shaped object over an NSWindow — the contract WindowNode
// realizes against (src/testing/mock-app.js is the reference shape; this
// file is that shape with real glass behind it).
//
// Units: everything crossing THIS object's boundary is device pixels, like
// an X window — attributes, reported width/height, event coordinates,
// _screenOrigin. The divide-by-scale into Cocoa points happens against the
// native layer and nowhere above it.
import { BackendContext2D } from '../backend/context2d.js';
import { CocoaDropTransport, dragSpec } from './dnd.js';
import { CocoaLayerPresenter } from './presenter.js';
import { CocoaPromotion } from './promotion.js';

let nextWindowId = 1;
// The slack a frame clock allows under its interval, in ms: a timer's drift
// and no more (`CocoaApp._frameDue`, `_frameWait`, `nextFrameAt`). It lives
// here because the window is the clock — `_rafLast` and `_frameInterval`
// are its fields — and the app imports it from this side.
export const FRAME_SLACK_MS = 1;
// How long a worker's flip may hold its window's next frame (`_armFence`).
// The release is reported once the replacing frame has committed, a
// fraction of a millisecond later, and a window must not freeze on a report
// that never came.
const FENCE_TIMEOUT_MS = 100;
// How many buffers a window's swapchain may hold, the one on glass included.
// A buffer leaves glass and the WindowServer lets go of it a refresh or so
// later — a median of about 9ms on a 120Hz panel, and under 40 at the 99th
// percentile on a loaded machine — so a frame on the next refresh often
// finds the buffer its flip replaced still held, and takes the one before
// (`_takeBack`). Three, a `CAMetalLayer`'s depth, is what an animation
// mostly needs; an input answered between two of its frames puts two flips
// inside one refresh, and four kept every write of a clicked 120Hz animation
// off a held buffer (docs/macos.md, "Measured: the swapchain and the
// WindowServer's hold").
const MAX_BUFFERS = 4;
// Past this many rects, what a buffer missed is copied whole: a buffer left
// out for a while owes a rect list per frame, and one memcpy of the window
// is cheaper than keeping them.
const OWED_RECTS_MAX = 64;
// How long a window goes without a frame before a chain that grew past two
// buffers gives the rest back (`_trimChain`).
const TRIM_AFTER_MS = 1000;

/** What a buffer owes once `damage` has been presented without it: the
 * rects it missed, or 'full'. */
function owe(owed, damage) {
  if (owed === 'full' || damage === 'full') return 'full';
  if (!owed) return damage;
  const rects = owed.concat(damage);
  return rects.length > OWED_RECTS_MAX ? 'full' : rects;
}

/** The band `scrollSurface` would write for a shift of `scroll` inside a
 * `width` x `height` bitmap, clamped the way the native clamps the rect:
 * rect ∩ (rect + delta), or null when nothing survives the shift. */
function survivingBand(scroll, width, height) {
  const { x, y, dx, dy } = scroll;
  if (!dx && !dy) return null;
  const clamp = (v, hi) => (v < 0 ? 0 : v > hi ? hi : v);
  const x0 = clamp(x, width);
  const y0 = clamp(y, height);
  const x1 = clamp(x + scroll.width, width);
  const y1 = clamp(y + scroll.height, height);
  const left = Math.max(x0, x0 + dx);
  const top = Math.max(y0, y0 + dy);
  const right = Math.min(x1, x1 + dx);
  const bottom = Math.min(y1, y1 + dy);
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Flat `[x, y, w, h, …]` rects less the `[x, y, w, h]` hole: the rows above
 * and below it full width, the pieces beside it its rows only. */
function aroundHole(rects, [hx, hy, hw, hh]) {
  const out = [];
  for (let i = 0; i + 3 < rects.length; i += 4) {
    const x = rects[i];
    const y = rects[i + 1];
    const right = x + rects[i + 2];
    const bottom = y + rects[i + 3];
    const top = Math.max(y, hy);
    const under = Math.min(bottom, hy + hh);
    const left = Math.max(x, hx);
    const beside = Math.min(right, hx + hw);
    if (beside <= left || under <= top) {
      out.push(x, y, right - x, bottom - y);
      continue;
    }
    if (top > y) out.push(x, y, right - x, top - y);
    if (bottom > under) out.push(x, under, right - x, bottom - under);
    if (left > x) out.push(x, top, left - x, under - top);
    if (right > beside) out.push(beside, top, right - beside, under - top);
  }
  return out;
}

export class CocoaWindow {
  constructor(app, attributes = {}) {
    this.app = app;
    this._native = app._native;
    this.attributes = attributes;
    this.scale = app.scale;
    this.id = nextWindowId++;
    this.X = app.X;
    this.destroyed = false;
    this.mapped = false;
    this._handlers = new Map();
    this._surface = null;
    this._surfaceGen = 0;
    this._ctx = null;
    this._dirty = false;
    // AppKit's occlusion state, as the delegate reports it (`_visible`).
    this._occluded = false;
    // This window's frame clock: when it last painted, and how often it may
    // — the period of the display it is on (`_refreshFrameInterval`).
    this._rafLast = 0;
    this._frameInterval = 0;
    // …and when a frame last reached glass, whoever painted it: the pump's
    // paced frame or an input answered on the spot (`frameInFlight`)
    this._presentedAt = -Infinity;

    const s = this.scale;
    const born = this.snapSize(
      attributes.width ?? 640,
      attributes.height ?? 480,
    );
    this.width = born.width;
    this.height = born.height;
    this.title = attributes.title ?? '';
    this._popup = attributes.overrideRedirect === true;
    // A popup that takes the keyboard (`<popup grabKeyboard>`): AppKit's
    // popup panel can never become key, so this one is a borderless window
    // that can, at the popup level, and it activates the app when it shows
    // — how NSPopover's own window behaves. It is decided here because the
    // kind of window is: a later change of the prop does not remake it.
    this._keyPopup = this._popup && attributes.grabKeyboard === true;

    const options = {
      width: this.width / s,
      height: this.height / s,
      title: this.title,
      kind: this._keyPopup
        ? 'borderless'
        : this._popup
          ? 'popup'
          : attributes.decorations === false
            ? 'borderless'
            : 'normal',
      resizable: attributes.resizable !== false,
    };
    if (this._keyPopup) options.level = 'popup';
    if (typeof attributes.x === 'number' && typeof attributes.y === 'number') {
      options.x = attributes.x / s;
      options.y = attributes.y / s;
    }
    // `transparent` arrives as a 32-bit visual request on X; here every
    // window can composite, so the flag simply makes the glass clear.
    const transparent =
      attributes.visual !== undefined || attributes.transparent;
    this._transparentWindow = Boolean(transparent);
    if (transparent) options.opaque = false;
    // A `<popup dragPreview>` follows the pointer, so for the whole gesture
    // it is the window the window server finds under it — and AppKit does
    // not look past a window that registered no dragged types: the drag
    // simply has no destination, and the window beneath never hears of it.
    // Transparent to the pointer, the preview is passed over and the hit
    // reaches what it covers (#488; @windowkit/appkit >= 0.6.0, an older
    // bridge ignores the option). The drop side is excluded separately:
    // nodes/window/droptarget.js `_initDnd` gives a preview no DropSession and registers
    // nothing.
    if (attributes.dragPreview) options.ignoresMouseEvents = true;
    // The root layer's background is the "what newly exposed area shows"
    // attribute an X window has — worth seeding on an opaque window so a
    // resize flashes the right colour. On a transparent one it would sit
    // OPAQUE behind the alpha the renderer paints (rounded corners went
    // square behind it), and the honest ground there is nothing at all.
    if (!transparent && attributes.backgroundColor !== undefined) {
      const parsed = app._parseColor(attributes.backgroundColor);
      if (parsed) options.backgroundColor = parsed;
    }
    // Where it was asked to go, until AppKit says where it went
    // (`_refreshOrigin`) — which on a worker is not before the window exists.
    this.x = Math.round(attributes.x ?? 0);
    this.y = Math.round(attributes.y ?? 0);
    this._screenOrigin = { x: this.x, y: this.y };
    // AppKit's content size in points, as the bridge last reported it
    // (`_frameSize`)
    this._points = null;
    // Threaded mode's swapchain fence (`frameInFlight`): the IOSurface id
    // the last flip is taking off glass, until the bridge says the flip has
    // been applied.
    this._awaiting = null;
    this._fenceTimer = null;
    this._trimTimer = null;
    this._shadowTimer = null;
    // AppKit's live resize, between the bridge's `window-live-resize` begin
    // and end (`CocoaApp._routeLiveResize`): a tick of it lays out with the
    // floors it has, and fresh ones are measured after the drag
    // (nodes/window/size.js, `_deferContentFloors`)
    this.liveResizing = false;
    this._h = this._native.createWindow2(options);
    // On a worker the bridge answers a handle at the call and makes the
    // window when its command runs: the number is null until then, and
    // `window-created` brings it (`_created`).
    this.windowNumber = this._native.windowNumber(this._h);
    // What the app's window map and the events name this window by: the
    // handle on a worker, where every window event carries it, and the
    // number in pump mode, where the events carry only that.
    this._key = app._threaded ? this._h : this.windowNumber;
    this._layer = this._native.windowRootLayer(this._h);
    // A worker's frame lands after AppKit has moved the window's edge, so
    // AppKit is asked to wait for it (`RESIZE_WAIT_MS`, src/cocoa/app.js).
    if (app._threaded && app._resizeWait > 0) {
      this._native.setResizeHandshake(this._h, { waitMs: app._resizeWait });
    }
    this._refreshOrigin();
    this._refreshFrameInterval();
    if (attributes.sizeHints) this.setSizeHints(attributes.sizeHints);

    // How many damage rects a frame may keep before merging them (nodes/damage.js,
    // MAX_DAMAGE_RECTS is the X11 answer). A pass here costs one CoreGraphics
    // clip and a culled walk, where an X pass costs the server a clip mask,
    // so a frame in which a clock, a graph and a status row all ticked keeps
    // the three small rects instead of the box around them — which on a
    // large tree was most of the window, painted for three cells' worth of
    // change.
    this.damageRectCap = 16;

    // The retained layer presenter (docs/macos.md Tier L), behind
    // REACT_X11_COCOA_PRESENTER=layers while the surface path is the
    // measured default. Its hooks exist only in this mode, so the feature
    // detection in src/nodes/ keeps the surface path byte-identical; the
    // scroll blit is shadowed off because a layer frame has no backing
    // bitmap to blit. The last two are the animation seam: a transition or
    // a loop the presenter takes runs in the render server and schedules no
    // frames here (docs/architecture/animation.md §4).
    if (app._presenterMode === 'layers') {
      this._presenter = new CocoaLayerPresenter(this);
      this.presentFrame = (windowNode) => this._presenter.frame(windowNode);
      this.noteInvalidate = (damage, layoutChanged) =>
        this._presenter.noteInvalidate(damage, layoutChanged);
      this.scrollRegion = null;
      this.animateNode = (node, prop, entry) =>
        this._presenter.animate(node, prop, entry);
      this.cancelNodeAnimation = (node, prop) =>
        this._presenter.cancel(node, prop);
    } else if (app._promote) {
      // Layer promotion (src/cocoa/promotion.js): the surface presenter
      // keeps the frame, and the nodes that animate get a layer of their
      // own above it. The same two animation hooks as layers mode; the
      // invalidate channel, for what the promoted rasters repaint; and the
      // frame's word in before the paint, where a node is moved onto or off
      // its layer and the bitmap under it claimed in the same frame.
      this._promotion = new CocoaPromotion(this);
      this.animateNode = (node, prop, entry) =>
        this._promotion.animate(node, prop, entry);
      this.cancelNodeAnimation = (node, prop) =>
        this._promotion.cancel(node, prop);
      this.noteInvalidate = (damage, layoutChanged) =>
        this._promotion.noteInvalidate(damage, layoutChanged);
      this.prepareFrame = (root, layoutRan) =>
        this._promotion.frame(root, layoutRan);
    }
    app._registerWindow(this);
  }

  // --- events --------------------------------------------------------------

  on(name, fn) {
    let list = this._handlers.get(name);
    if (!list) this._handlers.set(name, (list = []));
    list.push(fn);
  }

  emit(name, ev) {
    const list = this._handlers.get(name);
    if (!list) return;
    for (const fn of [...list]) fn(ev);
  }

  // --- geometry ------------------------------------------------------------

  _refreshOrigin() {
    const f = this._native.getWindowFrame(this._h);
    // a worker's window AppKit has not made yet: the asked-for origin stands
    if (!f) return;
    const s = this.scale;
    this.x = Math.round(f.x * s);
    this.y = Math.round(f.y * s);
    this._screenOrigin = { x: this.x, y: this.y };
  }

  /**
   * How often this window may paint: the period of the display it is on,
   * asked of the app (`frameIntervalFor`), which reads the screen list the
   * bridge reported. Re-read whenever the window moves, because a drag
   * from a 120Hz panel to a 60Hz monitor halves the rate it is worth
   * painting at — and a window that straddles two answers for the one
   * under its centre.
   */
  _refreshFrameInterval() {
    this._frameInterval = this.app.frameIntervalFor(this);
  }

  /** `window-created`: AppKit has made the window a worker asked for, and
   * published where it put it. */
  _created(ev) {
    this.windowNumber = ev.windowNumber;
    this._refreshOrigin();
    this._refreshFrameInterval();
  }

  /** Native geometry changed (delegate event, points). */
  _nativeResized(points) {
    this._points = { width: points.width, height: points.height };
    const s = this.scale;
    this.width = Math.max(1, Math.round(points.width * s));
    this.height = Math.max(1, Math.round(points.height * s));
    this.x = Math.round(points.x * s);
    this.y = Math.round(points.y * s);
    this._screenOrigin = { x: this.x, y: this.y };
    this._refreshFrameInterval();
  }

  /**
   * The size this window really takes for a request of `width` x `height`
   * device pixels — **whole POINTS**, because that is the grid AppKit puts a
   * window on. An odd device-pixel request at scale 2 comes back one short
   * in the resize echo, which churns the backing surface — each swap an
   * uninitialized canvas only the next damage rect repaints — and which the
   * renderer reads as somebody else having set the size, ending an
   * `'auto'` window's authority over its own for good (#586). So the
   * renderer asks this what it is going to get and records that instead
   * (`WindowNode._snapSize`).
   *
   * **Up**, not to the nearest: a window a device pixel taller than its
   * content shows all of it, and one a device pixel shorter clips it.
   */
  snapSize(width, height) {
    const s = this.scale;
    const up = (v) =>
      Math.max(1, Math.ceil(Math.max(1, Math.round(v)) / s) * s);
    return { width: up(width), height: up(height) };
  }

  resize(width, height) {
    const s = this.scale;
    const size = this.snapSize(width, height);
    this.width = size.width;
    this.height = size.height;
    this._native.setWindowFrame(
      this._h,
      null,
      null,
      this.width / s,
      this.height / s,
    );
  }

  move(x, y) {
    const s = this.scale;
    this.x = Math.round(x);
    this.y = Math.round(y);
    this._native.setWindowFrame(this._h, x / s, y / s, null, null);
    this._screenOrigin = { x: this.x, y: this.y };
    this._refreshFrameInterval();
  }

  // --- lifecycle -----------------------------------------------------------

  map() {
    if (this.destroyed) return;
    this.mapped = true;
    // Showing is a claim that the window is on glass; if it comes up behind
    // another application's window, AppKit's occlusion event says so on the
    // next pump and the frames wait from then. Reset here rather than kept,
    // so a window that was hidden behind one, unmapped and mapped again
    // does not wait on an event that may already have been delivered.
    this._occluded = false;
    // A popup must not take the keyboard from its owner, unless taking it
    // is what it is for; a toplevel's first map is the app coming up and
    // takes it.
    this._native.showWindow(this._h, !this._popup || this._keyPopup);
    this._refreshOrigin();
    this._refreshFrameInterval();
  }

  unmap() {
    if (this.destroyed) return;
    this.mapped = false;
    this._native.hideWindow(this._h);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.mapped = false;
    this.app._unregisterWindow(this);
    this._dropTransport = null;
    // a bounce nobody can answer any more
    if (this._attentionRequest != null) {
      this.app.cancelAttention(this._attentionRequest);
      this._attentionRequest = null;
    }
    clearTimeout(this._shadowTimer);
    this._shadowTimer = null;
    this._promotion?.destroy();
    this._native.destroyWindow2(this._h);
    this._releaseBacking();
  }

  // --- window-manager-ish surface (feature-detected by src/nodes/) ---------

  setTitle(title) {
    this.title = title;
    this._native.setWindowTitle(this._h, String(title ?? ''));
  }

  setSizeHints(hints = {}) {
    const s = this.scale;
    const box = {};
    if (typeof hints.minWidth === 'number') box.minWidth = hints.minWidth / s;
    if (typeof hints.minHeight === 'number')
      box.minHeight = hints.minHeight / s;
    if (typeof hints.maxWidth === 'number') box.maxWidth = hints.maxWidth / s;
    if (typeof hints.maxHeight === 'number')
      box.maxHeight = hints.maxHeight / s;
    if (Object.keys(box).length) this._native.setWindowMinMax(this._h, box);
  }

  setClass() {}

  setWindowType() {}

  setActions() {}

  /**
   * `_NET_WM_STATE` requests, as far as this backend has verbs for them:
   * `demands_attention` is the Dock bounce (`requestUserAttention`), held
   * until the state is removed or the window goes. Every other name resolves
   * `false` — ntk's own contract for a state the server cannot honour —
   * because the bridge has no zoom/miniaturize/fullscreen verbs yet
   * (windowkit/appkit#15 scoped them out); WindowNode swallows the false.
   */
  setWmState(names, action = 'add') {
    const list = Array.isArray(names) ? names : [names];
    let honoured = true;
    for (const name of list) {
      if (name !== 'demands_attention') {
        honoured = false;
        continue;
      }
      const held = this._attentionRequest != null;
      const wants = action === 'add' || (action === 'toggle' && !held);
      if (wants && !held && !this.destroyed) {
        this._attentionRequest = this.app.requestAttention();
      } else if (!wants && held) {
        this.app.cancelAttention(this._attentionRequest);
        this._attentionRequest = null;
      }
    }
    return Promise.resolve(honoured);
  }

  // --- drag and drop (src/cocoa/dnd.js) ------------------------------------

  /**
   * The drop side: WindowNode hands over the window's DropSession at realize
   * (`_initDnd`), and from then on the app routes this window's `drag-*`
   * events into it. Its presence on the window is what tells WindowNode the
   * backend has drop machinery of its own.
   */
  attachDropTransport(session, node) {
    this._dropTransport = new CocoaDropTransport(this, session, node);
  }

  /** A `dropAccept` came or went under this window: re-register the types. */
  dropTargetsChanged() {
    this._dropTransport?.refreshTypes();
  }

  registerDropTypes(types) {
    if (this.destroyed) return;
    this._native.registerDropTypes(this._h, types);
  }

  setDropResponse(response) {
    if (this.destroyed) return;
    this._native.setDropResponse(this._h, response);
  }

  /**
   * The source side: hand a DragSession's gesture to an NSDraggingSession
   * (see src/cocoa/dnd.js for what the spec carries). Returns at once; the
   * session reports back as `drag-session-*` events.
   *
   * And the pump stops here. AppKit tracks the gesture on this thread, so
   * `pump2` does not return until the drop and no timer of ours runs in
   * between — the frame that shows the drag has begun (a `<popup
   * dragPreview>` mounted by `onDragStart`, a source dimmed by
   * `:dragging`) has to go out on the way past. Motion is otherwise paced
   * on the frame clock and not flushed per event (`_routeMotion`); this is
   * the one motion whose answer has no next tick to wait for.
   */
  beginDrag(session) {
    if (this.destroyed) return null;
    const began = this._native.beginDrag(
      this._h,
      dragSpec(session, this._native, this.scale),
    );
    this.app._afterInput();
    return began;
  }

  setTransientFor() {
    // addChildWindow attachment comes with the layer presenter phase; a
    // managed dialog already floats via its own window today.
  }

  setCursor(name) {
    this._native.setCursor(String(name ?? 'default'));
  }

  grabPointer(options, cb) {
    this.app._grabWindow = this;
    cb?.(null, 0);
  }

  ungrabPointer() {
    if (this.app._grabWindow === this) this.app._grabWindow = null;
  }

  selectXI2() {
    // AppKit's precise scroll deltas are already flowing; nothing to select.
    return Promise.resolve(true);
  }

  // --- drawing -------------------------------------------------------------

  /**
   * The backing store is an IOSurface swapchain: painters draw into the
   * back buffer's CG bitmap, and presenting is `layer.contents = iosurface`
   * — zero-copy, where the plain-surface path paid a window-sized CGImage
   * copy per dirty frame (12ms at 900x700@2x — the presenter bench's whole
   * surface-vs-layers gap on bounded damage). A buffer that has been on
   * glass is behind by the frames presented since, so the frame that takes
   * it copies what it missed across first — a damage-sized memcpy
   * replacing a window-sized upload. Falls back to the single plain surface
   * where IOSurface creation fails.
   *
   * Which buffer that is, and when, is the WindowServer's to say (#602). It
   * composites out of the buffer it was handed, and lets go of one a
   * refresh or so after a flip replaced it — on a worker, not before the
   * flip has even been applied. A write into a buffer it still holds is a
   * write into what it may be compositing, and a composite caught mid-write
   * is half a frame on glass. So no buffer is chosen at the flip: the next
   * frame takes one at its first draw, from those the WindowServer has let
   * go of (`_takeBack`).
   *
   * A new size retires the chain, released on the spot (`_releaseBacking`):
   * left to the handles' finalizers, a forty-tick drag of the two-buffer
   * chain this used to be held 800MB until a collection happened to run —
   * the `rss +80MB` docs/macos.md measured. The layer keeps its own
   * reference to whichever IOSurface it is still showing, so the free is
   * safe while that frame is on glass. A new chain starts with the one
   * buffer its first frame paints: a live-resize tick paints its size once,
   * and the next tick's size needs a chain of its own. A chain that grew
   * past two gives the rest back once the window stops (`_armTrim`).
   */
  _ensureSurface() {
    const w = this.width;
    const h = this.height;
    if (
      !this._surface ||
      this._surfaceSize?.width !== w ||
      this._surfaceSize?.height !== h
    ) {
      const hadSurface = Boolean(this._surface);
      this._releaseBacking();
      try {
        const back = this._newBuffer(w, h);
        back.owed = null;
        this._chain = { buffers: [back], front: null, back };
        this._native.surfaceLock(back.handle);
        this._native.ctxClearRect(back.handle, 0, 0, w, h);
        this._surface = back.handle;
      } catch {
        this._surface = this._native.createSurface(w, h, this.scale);
        this._native.ctxClearRect(this._surface, 0, 0, w, h);
      }
      this._surfaceSize = { width: w, height: h };
      this._surfaceGen++;
      this._flushDamage = 'full';
      // A replaced backing surface holds nothing but what the flush now
      // painting puts on it. Whether that is enough is decided when the
      // flush reports its rects (`noteFrameDamage`) — not here, and not by
      // queueing a full frame behind this one. That used to be the answer,
      // and it made every tick of a live resize two full frames: the resize
      // event's own unbounded repaint, then this one, painting the same
      // pixels again. Worse, inside AppKit's resize loop no microtask runs
      // until the drag ends, so a drag of forty ticks queued forty full
      // frames that all ran on the mouse release — the freeze after a
      // resize, measured at seconds on a large tree.
      if (hadSurface) this._freshSurface = true;
    } else if (this._chain && !this._chain.back) {
      this._takeBack();
    }
    return this._surface;
  }

  /** A buffer for the chain, owing everything: nothing has been drawn in it. */
  _newBuffer(w, h) {
    const { handle, iosurfaceId } = this._native.createSurfaceIOSurface(
      w,
      h,
      this.scale,
    );
    return {
      handle,
      iosurfaceId,
      // what it missed while another buffer was on glass: rects, or 'full'
      owed: 'full',
      // when a flip last took it off glass
      offGlassAt: -Infinity,
      // false from a worker's flip that took it off glass until the bridge
      // reports that flip applied (`_surfaceReleased`)
      released: true,
    };
  }

  /**
   * The buffer the frame about to be drawn goes into, taken at its first
   * draw rather than at the flip before it — as late as the frame allows,
   * so the WindowServer has had as long as it can to let go.
   *
   * Of the buffers not on glass, one it has let go of: `surfaceIsInUse`
   * false, and on a worker the flip that retired it applied. Of those, the
   * one on glass most recently, which missed the fewest frames. When every
   * one is still held — the buffer the last flip replaced usually is, and a
   * burst of flips inside one refresh holds more — a new buffer, while the
   * chain has room for one. Past that, the one off glass longest: the
   * likeliest to have been let go of by now, and the one a two-buffer chain
   * always drew into.
   *
   * Then what it missed, copied across from the frame on glass.
   *
   * When the frame's first draw is a scroll blit (`scrollRegion`), the band
   * it moves comes across already moved: one copy from the frame on glass
   * at the shift, where catching up and then shifting in place wrote the
   * band twice — the catch-up owes it, since the frame before blitted too.
   * The catch-up copies the rest. Every pixel ends as the two passes left
   * it, the strips the shift exposes included, so what the frame repaints
   * does not change. Answers whether the band moved, or undefined when
   * there was no scroll to take or it has to move in place: a chain of
   * one, a buffer that owes nothing, a bridge without `blitSurface`.
   */
  _takeBack(scroll = null) {
    const chain = this._chain;
    let free = null;
    let oldest = null;
    for (const buffer of chain.buffers) {
      if (buffer === chain.front) continue;
      if (
        !oldest ||
        (buffer.released && !oldest.released) ||
        (buffer.released === oldest.released &&
          buffer.offGlassAt < oldest.offGlassAt)
      ) {
        oldest = buffer;
      }
      if (!buffer.released || this._held(buffer)) continue;
      if (!free || buffer.offGlassAt > free.offGlassAt) free = buffer;
    }
    let back = free;
    if (!back && chain.buffers.length < MAX_BUFFERS) {
      try {
        back = this._newBuffer(
          this._surfaceSize.width,
          this._surfaceSize.height,
        );
        chain.buffers.push(back);
        if (chain.buffers.length > 2) this._armTrim();
      } catch {
        // no memory for another: the chain draws with what it has
      }
    }
    // …and a chain of one, whose next buffer could not be made, draws where
    // it shows, as the plain surface does
    back ??= oldest ?? chain.front;
    chain.back = back;
    this._surface = back.handle;
    // a different native surface owns the graphics state now — the context
    // re-syncs its sticky state off the generation
    this._surfaceGen++;
    this._native.surfaceLock(back.handle);
    let moved;
    if (back.owed && back !== chain.front) {
      let owed =
        back.owed === 'full'
          ? null
          : back.owed.flatMap((r) => [
              Math.floor(r.x),
              Math.floor(r.y),
              Math.ceil(r.width) + 1,
              Math.ceil(r.height) + 1,
            ]);
      if (scroll && typeof this._native.blitSurface === 'function') {
        const { width, height } = this._surfaceSize;
        const band = survivingBand(scroll, width, height);
        // the band and where it comes from are both inside the bitmap, so
        // the copy is the whole band — anything else is a bridge that did
        // not copy, and the band moves in place after the plain catch-up
        const copied =
          band &&
          this._native.blitSurface(
            chain.front.handle,
            band.x - scroll.dx,
            band.y - scroll.dy,
            band.width,
            band.height,
            back.handle,
            band.x,
            band.y,
          );
        if (!band) {
          moved = false;
        } else if (Array.isArray(copied)) {
          moved = true;
          owed = aroundHole(owed ?? [0, 0, width, height], copied);
        }
      }
      // (an empty list is the whole bitmap to the native, not nothing)
      if (owed === null || owed.length > 0) {
        this._native.copySurfaceRegion(chain.front.handle, back.handle, owed);
      }
    }
    back.owed = null;
    return moved;
  }

  /**
   * A chain that grew past two buffers gives the rest back once the window
   * has gone `TRIM_AFTER_MS` without a frame. The extra buffers are what an
   * animation needs, a window-sized IOSurface each, and a window that has
   * stopped keeps the two a still window always had: the one on glass, and
   * the one on glass before it — which owes the least, so the next frame
   * takes it and makes nothing. A frame drawn and not yet presented keeps
   * its own buffer instead.
   */
  _armTrim() {
    if (this._trimTimer) return;
    this._trimTimer = setTimeout(() => {
      this._trimTimer = null;
      if (!this.destroyed && !this._trimChain()) this._armTrim();
    }, TRIM_AFTER_MS);
  }

  /** The trim, at `now`: false when the window is still painting, and the
   * trim has to look again later. */
  _trimChain(now = performance.now()) {
    const chain = this._chain;
    if (!chain || chain.buffers.length <= 2) return true;
    // a worker's flip not yet applied names a buffer the release will look for
    if (now - this._presentedAt < TRIM_AFTER_MS || this._awaiting != null) {
      return false;
    }
    let keep = chain.back;
    if (!keep) {
      for (const buffer of chain.buffers) {
        if (buffer === chain.front) continue;
        if (
          !keep ||
          (buffer.released && !keep.released) ||
          (buffer.released === keep.released &&
            buffer.offGlassAt > keep.offGlassAt)
        ) {
          keep = buffer;
        }
      }
    }
    const release = this._native.releaseSurface;
    const kept = [];
    for (const buffer of chain.buffers) {
      if (buffer === chain.front || buffer === keep) {
        kept.push(buffer);
      } else if (typeof release === 'function') {
        release.call(this._native, buffer.handle);
      }
    }
    chain.buffers = kept;
    return true;
  }

  /** Whether the WindowServer still holds `buffer`: `IOSurfaceIsInUse`. A
   * bridge that cannot say (before 0.10) is answered no, which is the
   * two-buffer chain this was. */
  _held(buffer) {
    const inUse = this._native.surfaceIsInUse;
    return (
      typeof inUse === 'function' &&
      inUse.call(this._native, buffer.handle) === true
    );
  }

  /**
   * Free the backing store now — the swapchain's buffers, or the plain
   * surface the fallback holds — rather than when V8 collects the handles.
   * Bridges before 0.4 have no `releaseSurface`; there the finalizer is
   * still the only owner, and this is the drop it always was.
   */
  _releaseBacking() {
    const release = this._native.releaseSurface;
    if (typeof release === 'function') {
      if (this._chain) {
        for (const buffer of this._chain.buffers) {
          release.call(this._native, buffer.handle);
        }
      } else if (this._surface) {
        release.call(this._native, this._surface);
      }
    }
    this._chain = null;
    this._surface = null;
    // a new chain owes nothing to what the old one was showing
    clearTimeout(this._fenceTimer);
    this._fenceTimer = null;
    this._awaiting = null;
    clearTimeout(this._trimTimer);
    this._trimTimer = null;
  }

  /**
   * The per-flush painted rects (WindowNode's swapchain seam), accumulated
   * until the next present: they are what the flip's catch-up copy covers.
   * `'full'`/null collapse the set — one full copy beats bookkeeping.
   */
  noteFrameDamage(rects) {
    if (this._presenter) return;
    if (this._freshSurface) {
      this._freshSurface = false;
      // A full flush painted every pixel of the new surface, and a resize
      // event's flush is one (nodes/window/listeners.js, the 'resize' listener). A bounded
      // one left garbage outside its rects: hold the present until the full
      // frame asked for here lands, so the garbage is never on glass.
      if (rects) {
        this._holdPresent = true;
        const node = this._reactX11Node;
        if (node && !node.destroyed) node.invalidate(false, null, 'resize');
      } else {
        this._holdPresent = false;
      }
    } else if (!rects) {
      this._holdPresent = false;
    }
    if (this._flushDamage === 'full') return;
    if (!rects) {
      this._flushDamage = 'full';
      return;
    }
    (this._flushDamage ??= []).push(...rects);
  }

  /**
   * Whether anyone can see this window: mapped by the renderer, and not
   * ordered out or miniaturized by the user. A window that fails this owes
   * no frames — its callbacks wait in the app's queue (`_tickFrames`) and
   * its last paint stays unpresented until it is back on glass, where one
   * catch-up frame covers everything that changed in between.
   *
   * Occlusion by another application's window counts too: a window that
   * is entirely behind one is visible by `isVisible`'s measure and still
   * costs every frame its tree produces, and AppKit knows the difference.
   * `windowDidChangeOcclusionState` arrives as the bridge's
   * `window-occlusion` event (`CocoaApp._routeOcclusion`), `visible` being
   * "some pixel of it is on glass"; `_occluded` is the last word of it.
   */
  _visible() {
    if (this.destroyed || !this.mapped || this._occluded) return false;
    return this._native.windowIsVisible(this._h) !== false;
  }

  getContext() {
    if (!this._ctx) {
      this._ctx = new BackendContext2D(
        this._native,
        () => this._ensureSurface(),
        () => {
          this._ensureSurface();
          return this._surfaceGen;
        },
        // a CPU bitmap: a rounded box keeps its corners by reading it back
        { readback: true },
      );
      this._ctx._fonts = this.app.fonts;
      this._ctx._onDirty = () => {
        this._dirty = true;
      };
    }
    return this._ctx;
  }

  /** The scroll-blit fast path: move pixels inside the backing surface,
   * with ntk Window.scrollRegion's contract — the shift happens WITHIN the
   * rect, and a delta that leaves no surviving band reports false so the
   * caller falls back to the plain repaint. */
  scrollRegion(rect, dx, dy) {
    // Nothing painted yet, or a size the next paint makes a new chain for:
    // there is no band to move.
    if (
      !this._surface ||
      this._surfaceSize?.width !== this.width ||
      this._surfaceSize?.height !== this.height
    ) {
      return false;
    }
    if (!Number.isInteger(dx) || !Number.isInteger(dy)) return false;
    const x = Math.round(rect.x);
    const y = Math.round(rect.y);
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);
    // The band moves in the buffer this frame draws into. When this is the
    // frame's first draw, taking that buffer moves it (`_takeBack`);
    // otherwise, or where that cannot, it is taken and caught up to the
    // frame on glass first, and the band moves in place.
    const chain = this._chain;
    let moved =
      chain && !chain.back
        ? this._takeBack({ x, y, width, height, dx, dy })
        : undefined;
    if (moved === undefined) {
      moved = this._native.scrollSurface(
        this._ensureSurface(),
        x,
        y,
        width,
        height,
        dx,
        dy,
      );
    }
    if (moved) {
      this._dirty = true;
      // The band moved inside the BACK buffer only. After the flip every
      // other buffer still holds the band where it was, and what a buffer
      // is owed only covers what the flush painted — the strips the shift
      // exposed — so the next frame would blit a band one frame stale.
      // Record the shifted rect as painted, and the catch-up carries it.
      this.noteFrameDamage([{ x, y, width, height }]);
    }
    return Boolean(moved);
  }

  /**
   * Whether this window's last flip has yet to reach the layer — the X11
   * contract's fence (src/frames.js). The pump never needs it: a pump-mode
   * flip is applied in the call. A worker's flip is a command the UI thread
   * applies later, and until the bridge reports the buffer it replaced as
   * released (`_surfaceReleased`), that buffer is still what is on glass,
   * and a frame painted now would be one the UI thread has not caught up
   * with. A new size is never in flight: it paints into a new chain that
   * nothing is showing.
   *
   * And while a batch is being routed (`CocoaApp._routeBatch`), its frame
   * is the one owed: it goes out when the batch is done, answering every
   * input in it at once. The early flush a discrete event asks for on its
   * way out (src/frames.js) waits those few microseconds, rather than
   * painting a state the next event in the same batch replaces.
   */
  frameInFlight() {
    if (this.app._batching) return true;
    return (
      this._awaiting != null &&
      this._surfaceSize?.width === this.width &&
      this._surfaceSize?.height === this.height
    );
  }

  /**
   * Whether this window flipped less than one of its frame intervals ago —
   * the wheel's gate (`CocoaApp._routeWheel`), and only the wheel's.
   *
   * A trackpad routinely lands two scroll events in one pump tick, and each
   * used to paint and flip on the spot: the second frame was drawn into the
   * buffer the first flip had taken off glass microseconds before, while the
   * WindowServer could still be compositing from it. A scroll's frame blits,
   * then repaints what the shift got wrong, so a composite caught between the
   * two showed the blit alone — a held sticky header dragged up a pixel for a
   * frame. The swapchain no longer draws into a buffer the WindowServer
   * holds (`_takeBack`), but one refresh still shows one frame: the rest of a
   * burst is work nobody sees, and each flip of it would hold a buffer. A
   * resize paints into a chain it has just made, and a press or a key does
   * not come in bursts inside a refresh — the one answered between two
   * frames of an animation is what the chain's fourth buffer is for.
   *
   * Off with the interval: `frameInterval: 0` asks for no pacing at all.
   */
  _flippedRecently(now = performance.now()) {
    return (
      this._frameInterval > 0 && now - this._presentedAt < this._frameInterval
    );
  }

  requestAnimationFrame(cb) {
    return this.app._requestFrame(cb, this);
  }

  /**
   * A `<glarea>`'s frame: on this window's clock, and after this window's
   * own frame in the tick that runs both, so the GL frame goes out after
   * the overlay its children were painted on (src/cocoa/glarea.js).
   */
  requestSurfaceFrame(cb) {
    return this.app._requestFrame(cb, this, true);
  }

  /**
   * The earliest moment this window's clock will hand out another frame,
   * for a gate of `interval` ms — the display's period by default, which
   * is the clock's own.
   *
   * It is the grid `_frameDue` decides on, not the wall clock: the anchor
   * is the slot the running frame was *due* at, so the answer does not
   * move with how long that frame took or how late its timer fired. A
   * second gate that wants to compose with this clock rather than be
   * rounded up by it has to land on this grid — which is what a
   * `<glarea>`'s swap gate reads it for (src/cocoa/glarea.js).
   */
  nextFrameAt(interval = this._frameInterval) {
    return this._rafLast + interval - FRAME_SLACK_MS;
  }

  /**
   * Push the backing surface at the WindowServer, if anything drew — and
   * tell the window node what it cost. The flip itself is cheap, and the
   * catch-up copy is the next frame's (`_takeBack`), inside its flush; the
   * present still reports in, since the frame pacer prices a frame by the
   * thread's time (src/pacing.js, `WindowNode._notePresentCost`).
   */
  present() {
    const started = performance.now();
    if (!this._presentNow()) return;
    this._reactX11Node?._notePresentCost?.(performance.now() - started);
  }

  /** The present itself: true when a frame reached the layer. */
  _presentNow() {
    if (this._presenter) return false; // layers upload as they sync
    if (!this._dirty || !this._surface || this.destroyed) return false;
    // …and if anyone would see it. `_dirty` stays set, so the pump asks
    // again next tick and the frame goes out the moment the window is back.
    if (this._holdPresent || !this._visible()) return false;
    this._dirty = false;
    this._presentedAt = performance.now();
    const chain = this._chain;
    if (chain) {
      const shown = chain.back;
      this._native.surfaceUnlock(shown.handle);
      this._flip(() =>
        this._native.setLayerContentsIOSurface(this._layer, shown.iosurfaceId),
      );
      // Every other buffer has missed this frame. Nothing is copied into
      // any of them now: the buffer this flip takes off glass is the one
      // the WindowServer is surest to be holding (`_takeBack`).
      const damage = this._flushDamage ?? 'full';
      this._flushDamage = null;
      for (const buffer of chain.buffers) {
        if (buffer !== shown) buffer.owed = owe(buffer.owed, damage);
      }
      const retired = chain.front;
      chain.front = shown;
      chain.back = null;
      // Until the next frame takes a buffer, the surface is the frame on
      // glass: a read gets the picture presented, and nothing here draws
      // into it — every draw asks `_ensureSurface` first.
      this._surface = shown.handle;
      // A new chain's first flip replaces a buffer of the old one, or
      // nothing, and a buffer flipped again takes nothing off glass.
      if (retired && retired !== shown) {
        retired.offGlassAt = this._presentedAt;
        // On a worker the flip has not happened yet: the next frame waits
        // for the bridge to say it has (`frameInFlight`).
        if (this.app._threaded) {
          retired.released = false;
          this._awaiting = retired.iosurfaceId;
          this._armFence();
        }
      }
      this._shadowAfterFlip();
      return true;
    }
    this._flip(() => this._native.surfaceToLayer(this._surface, this._layer));
    this._shadowAfterFlip();
    return true;
  }

  /**
   * Hand a frame to the layer. In pump mode that is the verb alone: the
   * bridge flips in a transaction of its own, in the call. On a worker the
   * flip is recorded and committed as one frame (windowkit/appkit#52), and
   * the commit says what size the frame was painted at, which is what a
   * resize waits for (`setResizeHandshake`, #53). Actions off, as the
   * bridge's own transaction has them.
   */
  _flip(apply) {
    if (!this.app._threaded) return apply();
    const native = this._native;
    native.txBegin({ disableActions: true });
    try {
      return apply();
    } finally {
      native.txCommit(this._frameSize());
    }
  }

  /**
   * The size this window's frames are painted at, in the points AppKit
   * measures a window by: the bridge's own figures when they describe the
   * current size, so that the handshake's comparison is exact.
   */
  _frameSize() {
    const p = this._points;
    const s = this.scale;
    if (
      p &&
      Math.max(1, Math.round(p.width * s)) === this.width &&
      Math.max(1, Math.round(p.height * s)) === this.height
    ) {
      return { width: p.width, height: p.height };
    }
    return { width: this.width / s, height: this.height / s };
  }

  /** Stop waiting on the fence. */
  _stopWaiting() {
    clearTimeout(this._fenceTimer);
    this._fenceTimer = null;
    this._awaiting = null;
  }

  /** `surface-released` for `id`: true when the buffer is this window's. It
   * may be drawn into again once the WindowServer lets go of it too. */
  _surfaceReleased(id) {
    const buffer = this._chain?.buffers.find((b) => b.iosurfaceId === id);
    if (!buffer) return false;
    buffer.released = true;
    if (this._awaiting === id) this._stopWaiting();
    return true;
  }

  /**
   * A release that never comes stops holding the window's frames after a
   * moment. It does not make the buffer free: a flip the UI thread has not
   * applied still has that buffer on glass, and the next frame takes
   * another (`_takeBack`) until the release does come.
   */
  _armFence() {
    clearTimeout(this._fenceTimer);
    this._fenceTimer = setTimeout(() => {
      this._fenceTimer = null;
      if (this._awaiting == null || this.destroyed) return;
      this._stopWaiting();
      this.app._tickFrames();
      this.app._presentAll();
    }, FENCE_TIMEOUT_MS);
  }

  /**
   * AppKit derives a transparent window's shadow from the content's opaque
   * shape and does not recompute it on repaints — a popup whose card lands
   * a frame after the map keeps the full-frame square AppKit guessed first.
   * Recompute — but only once this present's transaction has actually
   * flushed to the render server, or the recompute reads the frame BEFORE
   * this one and keeps the square rim for menus that paint once and are
   * only hovered after. In pump mode that is the next pump tick; on a
   * worker, where the flip is a command and the recompute would be another
   * one drained beside it, a frame interval later.
   */
  _shadowAfterFlip() {
    if (!this._transparentWindow) return;
    if (!this.app._threaded) {
      this.app._shadowStale.add(this);
      return;
    }
    if (this._shadowTimer) return;
    this._shadowTimer = setTimeout(
      () => {
        this._shadowTimer = null;
        if (!this.destroyed) this._native.invalidateWindowShadow(this._h);
      },
      Math.max(1, Math.round(this._frameInterval || 16)),
    );
  }

  /** The window's content as a PNG at `path`; resolves whether it was
   * written. A promise on either thread: on a worker AppKit answers later. */
  snapshot(path) {
    return this.app._ask('snapshotWindow', this._h, path);
  }
}

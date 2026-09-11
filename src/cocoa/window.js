// An ntk-window-shaped object over an NSWindow — the contract WindowNode
// realizes against (src/testing/mock-app.js is the reference shape; this
// file is that shape with real glass behind it).
//
// Units: everything crossing THIS object's boundary is device pixels, like
// an X window — attributes, reported width/height, event coordinates,
// _screenOrigin. The divide-by-scale into Cocoa points happens against the
// native layer and nowhere above it.
import { CocoaContext2D } from './context2d.js';
import { CocoaDropTransport, dragSpec } from './dnd.js';
import { CocoaLayerPresenter } from './presenter.js';
import { CocoaPromotion } from './promotion.js';

let nextWindowId = 1;
// How long a worker's flip may keep its window's back buffer before the
// window draws into it anyway (`_armFence`). The release is reported once
// the replacing frame has committed, a fraction of a millisecond later, and
// a window must not freeze on a report that never came.
const FENCE_TIMEOUT_MS = 100;

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
    // Snapped to whole POINTS: AppKit rounds window sizes to the point
    // grid, so an odd device-pixel request comes back one short in the
    // resize echo, the echo re-requests, and the backing surface churns —
    // each swap an uninitialized canvas only the next damage rect repaints.
    const snap = (v, fallback) =>
      Math.max(1, Math.round(Math.max(1, Math.round(v ?? fallback)) / s) * s);
    this.width = snap(attributes.width, 640);
    this.height = snap(attributes.height, 480);
    this.title = attributes.title ?? '';
    this._popup = attributes.overrideRedirect === true;

    const options = {
      width: this.width / s,
      height: this.height / s,
      title: this.title,
      kind: this._popup
        ? 'popup'
        : attributes.decorations === false
          ? 'borderless'
          : 'normal',
      resizable: attributes.resizable !== false,
    };
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
    // on the layer as far as this window has asked, the one the last flip
    // is taking off glass until the bridge says it is released, and the
    // catch-up copy the back buffer is owed once it is back.
    this._onGlass = null;
    this._awaiting = null;
    this._catchUp = null;
    this._fenceTimer = null;
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

  resize(width, height) {
    const s = this.scale;
    this.width = Math.max(1, Math.round(Math.round(width) / s) * s);
    this.height = Math.max(1, Math.round(Math.round(height) / s) * s);
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
    // A popup must not take the keyboard from its owner; a toplevel's first
    // map is the app coming up and takes it.
    this._native.showWindow(this._h, !this._popup);
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
   * The backing store is a two-buffer IOSurface swapchain: painters draw
   * into the back buffer's CG bitmap, and presenting is `layer.contents =
   * iosurface` — zero-copy, where the plain-surface path paid a
   * window-sized CGImage copy per dirty frame (12ms at 900x700@2x — the
   * presenter bench's whole surface-vs-layers gap on bounded damage).
   * After a flip the new back buffer is one frame stale, so present copies
   * the just-shown frame's damage across — a damage-sized memcpy replacing
   * a window-sized upload. Falls back to the single plain surface where
   * IOSurface creation fails.
   *
   * A new size retires the pair, and the retired pair is released on the
   * spot (`_releaseBacking`): a resize tick allocates two window-sized
   * IOSurfaces, 20MB at 900x700@2x, and left to the handles' finalizers a
   * forty-tick drag held 800MB until a collection happened to run — the
   * `rss +80MB` docs/macos.md measured. The layer keeps its own reference
   * to whichever IOSurface it is still showing, so the free is safe while
   * that frame is on glass.
   */
  _ensureSurface() {
    // a paint that did not wait for the fence: the back buffer gets its
    // catch-up now, so what it paints lands over the frame before it
    this._settleBack();
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
        const a = this._native.createSurfaceIOSurface(w, h, this.scale);
        const b = this._native.createSurfaceIOSurface(w, h, this.scale);
        this._chain = { back: a, front: b };
        this._native.surfaceLock(a.handle);
        this._native.ctxClearRect(a.handle, 0, 0, w, h);
        this._native.ctxClearRect(b.handle, 0, 0, w, h);
        this._surface = a.handle;
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
    }
    return this._surface;
  }

  /**
   * Free the backing store now — the swapchain pair, or the plain surface
   * the fallback holds — rather than when V8 collects the handles. Bridges
   * before 0.4 have no `releaseSurface`; there the finalizer is still the
   * only owner, and this is the drop it always was.
   */
  _releaseBacking() {
    const release = this._native.releaseSurface;
    if (typeof release === 'function') {
      if (this._chain) {
        release.call(this._native, this._chain.back.handle);
        release.call(this._native, this._chain.front.handle);
      } else if (this._surface) {
        release.call(this._native, this._surface);
      }
    }
    this._chain = null;
    this._surface = null;
    // a new pair owes nothing to what the old one was showing
    clearTimeout(this._fenceTimer);
    this._fenceTimer = null;
    this._awaiting = null;
    this._catchUp = null;
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
      this._ctx = new CocoaContext2D(
        this._native,
        () => this._ensureSurface(),
        () => {
          this._ensureSurface();
          return this._surfaceGen;
        },
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
    if (!this._surface) return false;
    // the band moves over the frame before this one, not over a buffer
    // still owed its catch-up
    this._settleBack();
    if (!Number.isInteger(dx) || !Number.isInteger(dy)) return false;
    const moved = this._native.scrollSurface(
      this._surface,
      Math.round(rect.x),
      Math.round(rect.y),
      Math.round(rect.width),
      Math.round(rect.height),
      dx,
      dy,
    );
    if (moved) {
      this._dirty = true;
      // The band moved inside the BACK buffer only. After the flip the
      // other buffer still holds the band where it was, and the catch-up
      // copy only covers what the flush painted — the strips the shift
      // exposed — so the next frame would blit a band one frame stale.
      // Record the shifted rect as painted, and the flip's copy carries it.
      this.noteFrameDamage([
        {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      ]);
    }
    return Boolean(moved);
  }

  /**
   * Whether this window's last frame still holds the buffer the next one
   * would be drawn into — the X11 contract's fence (src/frames.js). The
   * pump never needs it: a pump-mode flip is applied in the call, so the
   * other buffer is off glass before the next paint. A worker's flip is a
   * command the UI thread applies later, and until the bridge reports the
   * buffer it replaced as released (`_surfaceReleased`), drawing into that
   * buffer draws into what is on glass. A new size is never in flight: it
   * paints into a new pair that nothing is showing.
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
   * two shows the blit alone — a held sticky header dragged up a pixel for a
   * frame, or the rows under it painted over it, then corrected. No other
   * input has both halves of that: a resize paints into a pair it has just
   * made, and a press or a key does not come in bursts inside a refresh.
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
   * Push the backing surface at the WindowServer, if anything drew — and
   * tell the window node what it cost. The flip is cheap; the catch-up
   * copy behind it is a damage-sized memcpy, and on a window whose every
   * frame repaints most of itself that is a millisecond of the JS thread
   * per frame that the flush never saw. The frame pacer prices the frame
   * by the thread's time, so the present reports in (src/pacing.js,
   * `WindowNode._notePresentCost`).
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
    if (this._chain) {
      const shown = this._chain.back;
      this._native.surfaceUnlock(shown.handle);
      this._flip(() =>
        this._native.setLayerContentsIOSurface(this._layer, shown.iosurfaceId),
      );
      this._chain.back = this._chain.front;
      this._chain.front = shown;
      this._surface = this._chain.back.handle;
      // a different native surface owns the graphics state now — the
      // context re-syncs its sticky state off the generation
      this._surfaceGen++;
      const catchUp = { from: shown.handle, damage: this._flushDamage };
      this._flushDamage = null;
      // The buffer drawn into next is the one this flip takes off glass —
      // when it was on glass at all: a new pair's first flip replaces a
      // buffer of the old pair, or nothing. On a worker the flip has not
      // happened yet, so its catch-up and the next paint wait for the
      // bridge to say it has (`frameInFlight`).
      const previous = this._onGlass;
      this._onGlass = shown.iosurfaceId;
      if (this.app._threaded && previous === this._chain.back.iosurfaceId) {
        this._awaiting = previous;
        this._catchUp = catchUp;
        this._armFence();
      } else {
        this._settle(catchUp);
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

  /** The back buffer is off glass: lock it for drawing and copy across what
   * the frame now shown painted, so that the next frame starts from it. */
  _settle({ from, damage }) {
    this._native.surfaceLock(this._surface);
    this._native.copySurfaceRegion(
      from,
      this._surface,
      damage === 'full' || !damage
        ? null
        : damage.flatMap((r) => [
            Math.floor(r.x),
            Math.floor(r.y),
            Math.ceil(r.width) + 1,
            Math.ceil(r.height) + 1,
          ]),
    );
  }

  /** Stop waiting on the fence: the back buffer's catch-up, now. */
  _settleBack() {
    if (this._awaiting == null) return;
    clearTimeout(this._fenceTimer);
    this._fenceTimer = null;
    this._awaiting = null;
    const catchUp = this._catchUp;
    this._catchUp = null;
    if (catchUp && this._chain) this._settle(catchUp);
  }

  /** `surface-released` for `id`: true when it was the buffer this window
   * was waiting on. */
  _surfaceReleased(id) {
    if (this._awaiting == null || this._awaiting !== id) return false;
    this._settleBack();
    return true;
  }

  _armFence() {
    clearTimeout(this._fenceTimer);
    this._fenceTimer = setTimeout(() => {
      this._fenceTimer = null;
      if (this._awaiting == null || this.destroyed) return;
      this._settleBack();
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

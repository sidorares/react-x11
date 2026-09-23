// An ntk-window-shaped object over an HWND — the contract WindowNode realizes
// against (src/testing/mock-app.js is the reference shape; this file is that
// shape with DirectComposition behind it).
//
// Units: everything crossing this object's boundary is device pixels, like an
// X window. The window is per-monitor-v2 on the bridge's UI thread, so the
// HWND's own client area is already in device pixels and there is no divide.
//
// The frame is taken through `presentFrame` rather than through `getContext` +
// `present`, and that is the one structural difference from the Cocoa window.
// A DirectComposition surface is not a persistent bitmap that gets flipped: it
// hands back a drawing context per `BeginDraw`, valid until `EndDraw`, and
// every pixel inside the rect is repainted while every pixel outside it is
// kept. So the frame has to be *driven* from the damage list rather than
// painted into a surface that was already there — which `presentFrame` is
// exactly the hook for, and which makes one BeginDraw per damage rect fall out
// for free.
import { BackendContext2D } from '../backend/context2d.js';
import { Win32DropTransport, dragSpec } from './dnd.js';

// REACT_X11_WIN32_DEBUG=1 reports every frame and what it drew into. A window
// that stays blank on this backend has a short list of causes — no frame
// asked for, a BeginDraw refused, a damage rect outside the surface — and they
// are indistinguishable from the outside, because none of them throws.
const DEBUG = process.env.REACT_X11_WIN32_DEBUG === '1';

export class Win32Window {
  constructor(app, attributes = {}) {
    this.app = app;
    this._native = app._native;
    this.attributes = attributes;

    this.width = Math.max(1, Math.round(attributes.width ?? 800));
    this.height = Math.max(1, Math.round(attributes.height ?? 600));
    this.x = attributes.x ?? 0;
    this.y = attributes.y ?? 0;
    this.title = attributes.title ?? '';
    this.mapped = false;
    this.destroyed = false;
    this.parent = null;
    this.cursor = null;

    // The handle the verb table draws through, non-zero only inside a
    // BeginDraw/EndDraw pair, and the generation that tells BackendContext2D
    // its sticky state has to be pushed into a fresh one.
    this._surface = 0;
    this._gen = 0;
    this._ctx = null;

    this._handlers = {};
    this._ready = false;
    this._composed = false;
    this._pendingFrames = [];
    this._owesFullPaint = false;
    this._dirty = false;
    // a pane over a `<glarea>` here changed and its commit is this frame's
    // (src/win32/overlay.js)
    this._owesCommit = false;

    // `overrideRedirect` is how a `<popup>` says what it is — a menu, a
    // select's list, a tooltip. On X11 it means "the window manager does not
    // manage this"; here it means WS_POPUP: no frame, no taskbar button, and
    // no stealing activation from the window it belongs to.
    this.popup = attributes.overrideRedirect === true;

    this.id = this._native.createWindow({
      title: this.title,
      width: this.width,
      height: this.height,
      // A popup is placed by anchor.js against the monitor's work area, and
      // that placement *is* the contract — a menu created at the default
      // position is a menu in the wrong place.
      x: attributes.x,
      y: attributes.y,
      popup: this.popup,
      // A shaped window needs a surface with an alpha channel, or the pixels
      // outside its shape composite as a dark fringe — which on a rounded
      // popup is a dark edge along every corner.
      transparent: attributes.transparent === true,
      // A `<popup dragPreview>` follows the pointer, so it is **under** the
      // pointer for the whole gesture — and the window under the pointer is
      // the one the shell asks about when it looks for somewhere to drop.
      // Unanswered, the preview answers for itself, and it is not a drop
      // target: the list underneath never sees the drop. Cocoa spells the
      // same thing `ignoresMouseEvents` (src/cocoa/window.js).
      clickThrough: attributes.dragPreview === true,
    });
    app._register(this);
  }

  // --- events --------------------------------------------------------------

  on(name, fn) {
    (this._handlers[name] ??= []).push(fn);
  }

  /** The other half of `on`. Without it a component that subscribes for as
   *  long as it is mounted has no way to stop, and the handler outlives it. */
  off(name, fn) {
    const list = this._handlers[name];
    if (!list) return;
    const at = list.indexOf(fn);
    if (at >= 0) list.splice(at, 1);
  }

  emit(name, ev) {
    for (const fn of this._handlers[name] ?? []) fn(ev);
  }

  /**
   * The bridge says the HWND exists. Composition is set up here and not at
   * construction because there is no HWND to target until now — the command
   * queue is one way and a window is created asynchronously.
   *
   * Then `draw`, which is the frame clock's "the backing store is invalid,
   * repaint everything" and is what the window node listens to. It is not
   * optional: the tree mounts, lays out and paints in the same turn the window
   * is asked for, so the first frames land before there is anything to paint
   * into and are dropped. Without this the window stays whatever
   * WS_EX_NOREDIRECTIONBITMAP shows when nothing was ever committed, which is
   * black, and nothing else would ever ask again.
   */
  _onReady(originX, originY) {
    this._ready = true;
    // The HWND exists now, which is the first moment a drop target can be
    // registered on it — the tree mounted its `dropAccept`s before this.
    this._dropTransport?.reattach();
    // And the first moment there is a window for the accessibility mirror to
    // be keyed by. The tree mounted and committed before this, so without
    // this the first push would have had nowhere to go and a screen reader
    // attaching to an idle application would find an empty window.
    this.app._a11y?.windowReady(this);
    // The identity goes on **before `show`** below: the taskbar reads the
    // window's AppUserModelID when it makes the button, so an id arriving
    // afterwards leaves that button grouped where it already was.
    if (this.attributes?.appId != null) this.setClass(this.attributes.appId);
    if (Number.isFinite(originX)) this._noteOrigin(originX, originY);
    if (!this._composed) {
      this._native.compose(this.id);
      this._composed = true;
    }
    if (this.mapped) this._native.show(this.id, true);
    this.emit('draw', {});
  }

  // --- geometry ------------------------------------------------------------

  /**
   * Where the client area is on the virtual screen. `anchor.js` reads
   * `_screenOrigin` to turn a node's rect into the screen rect a `<popup>` is
   * placed against, and falls back to `x`/`y` — so a window that never reports
   * its position anchors every menu as though it were at the screen's origin,
   * which puts a select's list a whole window-offset away from the select.
   */
  _noteOrigin(x, y) {
    this.x = x;
    this.y = y;
    this._screenOrigin = { x, y };
  }

  map() {
    this.mapped = true;
    if (this._ready) this._native.show(this.id, true);
  }

  unmap() {
    this.mapped = false;
    if (this._ready) this._native.show(this.id, false);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this._native.destroyWindow?.(this.id);
    this.app._unregister(this);
  }

  resize(width, height) {
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    this._native.resizeWindow?.(this.id, this.width, this.height);
    // Unconditionally, not only once composed: an auto-sized window is
    // measured and resized before its HWND exists, and the surface compose()
    // makes later is made at whatever size the bridge last recorded.
    this._native.resize(this.id, this.width, this.height);
  }

  move(x, y) {
    this.x = x;
    this.y = y;
    this._native.moveWindow?.(this.id, x, y);
  }

  setTitle(title) {
    this.title = title;
    this._native.setTitle?.(this.id, String(title ?? ''));
  }

  /** The size limits Windows asks for synchronously in WM_GETMINMAXINFO, so
   * they are pushed ahead rather than answered on demand — docs/windows.md
   * "What Windows asks synchronously, and JS can know in advance". */
  setSizeHints(hints = {}) {
    this._native.setSizeHints?.(this.id, hints);
  }

  /**
   * `<window appId>`: the AppUserModelID, which is what Windows means by
   * "which application is this" — the taskbar groups buttons by it, pinning
   * pins it, and a jump list belongs to it.
   *
   * X11 carries an instance and a class; this takes the **class**, the half
   * that names the application rather than the window, which is the same
   * choice `windowAttributes` makes for every single-id backend
   * (src/nodes/window/hints.js).
   *
   * Set per window rather than per process:
   * `SetCurrentProcessExplicitAppUserModelID` has to be called before the
   * process creates any UI, which a library cannot promise of an embedder. A
   * window's own id overrides the process's anyway, so this is both the more
   * flexible form and the only one that can be guaranteed.
   */
  setClass(instance, className) {
    const id = className ?? instance;
    this._native.windowAppId?.(this.id, id == null ? null : String(id));
    this._setRelaunch(id == null ? null : String(id));
  }

  /**
   * What a **pinned** tile starts, and what it is called while pinned.
   *
   * An id on its own is half the story. It makes the taskbar group this
   * window under an identity of its own — and then a user who pins that
   * button gets a shortcut to whatever the shell can work out by itself,
   * which for `node app.js` is node.exe, under node's name and icon. The
   * relaunch properties are the other half, and Microsoft's guidance is that
   * an application setting the id sets these too.
   *
   * Derived rather than asked for, because every part of it is already known
   * and a second Windows-only prop to make the first one work is a bad trade:
   *
   * - **the command** is the one that started this process, quoted — argv as
   *   it was, so the relaunch is the launch;
   * - **the name** is the window's title, falling back to the id. It is what
   *   the pin menu and the button's tooltip show;
   * - **the icon** is the executable's own, which is what the shell would
   *   have used anyway — named explicitly so the pinned tile keeps it rather
   *   than resolving it again from a shortcut that may not exist.
   *
   * Clearing the id clears all three: a window with no identity of its own
   * should not keep claiming how to relaunch one.
   */
  _setRelaunch(id) {
    if (typeof this._native.windowRelaunch !== 'function') return;
    if (id == null) {
      this._native.windowRelaunch(this.id, {
        command: null,
        displayName: null,
        icon: null,
      });
      return;
    }
    const quote = (arg) =>
      /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
    const argv = process.argv.slice(1).map(quote).join(' ');
    this._native.windowRelaunch(this.id, {
      command: `${quote(process.execPath)}${argv ? ` ${argv}` : ''}`,
      displayName: this.title || id,
      icon: `${process.execPath},0`,
    });
  }

  // Still X11's names, still accepted and dropped: each is optional
  // decoration, and an app that sets one should not fail to open a window.
  setWindowType() {}
  setActions() {}
  setTransientFor() {}
  setAlwaysOnTop(on = true) {
    this._native.windowState(this.id, 'above', on !== false);
  }
  setProperty() {
    return Promise.resolve(this);
  }
  deleteProperty() {
    return Promise.resolve(this);
  }

  /**
   * One of `<window>`'s EWMH state names, applied with the Windows call that
   * means it: `ShowWindow` for maximized and minimized, a remembered frame
   * and the monitor's rect for fullscreen, `SetWindowPos` for `above`.
   *
   * Resolves false for a name this platform has no answer for, which is what
   * `useWindowState()` reads to know the request went nowhere — never for a
   * call that was made and did not take. `focused` is the one that can be
   * refused after the fact: the shell will not let a background process take
   * the foreground, and that refusal is the documented behaviour rather than
   * a failure, so it reports true and the state simply does not change.
   */
  setWmState(names, action = 'add') {
    // A name or a list of them, which is the contract the other backends
    // keep (src/cocoa/window.js) even though the renderer's own caller sends
    // them one at a time.
    const list = Array.isArray(names) ? names : [names];
    // A bridge too old to have the verb answers false for every name rather
    // than throwing: `useWindowState()` reads that false to know the request
    // went nowhere, and a throw from a state a window never had is not a
    // failure an application can do anything with.
    if (typeof this._native.windowState !== 'function') {
      return Promise.resolve(false);
    }
    const held = action === 'toggle' ? new Set(this.getWmStatesNow()) : null;
    let honoured = true;
    for (const name of list) {
      const on = held ? !held.has(name) : action !== 'remove';
      if (!this._native.windowState(this.id, name, on)) honoured = false;
    }
    return Promise.resolve(honoured);
  }

  /** The live states, synchronously — what a toggle has to read first. */
  getWmStatesNow() {
    if (typeof this._native.windowStates !== 'function') return [];
    return this._native.windowStates(this.id) ?? [];
  }

  getWmStates() {
    return Promise.resolve(this.getWmStatesNow());
  }

  // --- drag and drop -------------------------------------------------------

  /**
   * The window's drop side, which the tree installs when it first mounts a
   * `dropAccept` under this window (src/nodes/window/droptarget.js). Its
   * presence is what tells the tree this backend has drop machinery of its
   * own and no XDND property to write.
   */
  attachDropTransport(session, node) {
    this._dropTransport = new Win32DropTransport(this, session, node);
  }

  /** A `dropAccept` came or went under this window. The shell registers no
   *  types, so all this decides is whether the window is a target at all. */
  dropTargetsChanged() {
    this._dropTransport?.refreshTypes();
  }

  /** Backend events for the drag in progress, routed by the app. */
  _routeDrag(event) {
    this._dropTransport?.handle(event);
  }

  /**
   * The source side: hand a `DragSession`'s gesture to the shell. Returns at
   * once — `DoDragDrop` runs its modal loop on the bridge's UI thread, and
   * the gesture reports back as `drag-session-moved` and
   * `drag-session-ended`.
   *
   * And nothing stops here. That is the whole point of the thread split: the
   * frame clock keeps ticking, React keeps committing and a `<popup
   * dragPreview>` mounted by `onDragStart` is painted while the shell owns
   * the pointer — where the cocoa backend's pump does not return until the
   * drop.
   */
  beginDrag(session) {
    if (this.destroyed) return null;
    return this._native.beginDrag(this.id, dragSpec(session));
  }

  setCursor(name) {
    this.cursor = name;
    this._native.setCursor?.(this.id, name);
  }

  /**
   * What `<popup grab>` asks for, by the effect rather than the mechanism.
   *
   * There is no cross-application pointer grab on Windows: `SetCapture` sends
   * a window the mouse only while a button is already down, so a *press* that
   * starts over another window never arrives here. What the grab is actually
   * for is one thing — "tell me when the user pressed somewhere else, so the
   * menu can close" — and that is observable without it:
   *
   *   - a press delivered to **another window of this application**, which is
   *     a click in the owner behind the menu, or in a second window, or in a
   *     menu this one opened from;
   *   - this application **losing activation**, which is a press in another
   *     application or on the desktop. A popup is `WS_EX_NOACTIVATE`, so it
   *     never takes activation itself and opening one raises no blur —
   *     measured, because the whole rule rests on it.
   *
   * The app watches both and answers with the press the tree expects
   * (src/win32/app.js `_dismissOutsidePopups`), the way the Wayland backend
   * answers `xdg_popup.popup_done` with one (wayland/backendwindow.js).
   *
   * **What it does not catch**: a press on the *non-client* area of one of our
   * own windows — a title bar, a resize border. The bridge does not report
   * those, so a menu left open while the user drags the window behind it stays
   * open. X11's grab covers that case and this does not; it is the one gap,
   * and it is narrower than the one it replaces.
   *
   * The callback reports success because the behaviour it stands for is here
   * now. It used to say the same thing while nothing was watching, which is
   * the worst of both: a caller that checked was told a grab it did not have
   * had been taken.
   */
  grabPointer(options, cb) {
    this.app._dismissOnOutside?.add(this);
    cb?.(null, 0);
  }

  ungrabPointer() {
    this.app._dismissOnOutside?.delete(this);
  }

  /**
   * A press that landed outside this window, as the tree hears it.
   *
   * Negative coordinates are what make it a dismissal rather than a click:
   * `_pressOutside` in src/events.js compares against the window's own bounds,
   * and answers anything outside them with `onDismiss`. The same made-up press
   * the Wayland backend sends for `popup_done`, for the same reason — the
   * platform kept the real one.
   */
  _dismissFromOutside() {
    if (this.destroyed) return;
    this.emit('mousedown', {
      x: -1,
      y: -1,
      rootx: -1,
      rooty: -1,
      keycode: 1,
      buttons: 0,
      dismissed: true,
    });
  }

  // The keyboard's half has no Windows mechanism at all and nothing in the
  // tree reads its result, so it stays honest about doing nothing: a popup
  // that asked for keys gets them only while it is the foreground window.
  grabKeyboard(options, cb) {
    cb?.(null, 0);
  }
  ungrabKeyboard() {}

  selectXI2() {
    return Promise.resolve(false);
  }

  // --- painting ------------------------------------------------------------

  getContext() {
    if (this._ctx) return this._ctx;
    this._ctx = new BackendContext2D(
      this._native,
      () => this._surface,
      () => this._gen,
    );
    // Reading a *window* is not reading a surface. The surface handle the
    // context draws through belongs to one BeginDraw and is write-only
    // anyway; what a caller asking a window for its pixels means is "what is
    // on screen", and only DWM has that (`windowPixels`, src/win32.cc).
    //
    // The callback form is the contract — the X backend's read is a round
    // trip and every caller is written for one (examples/configurator reads
    // its own UI this way to put it on the laptop's screen). Here the answer
    // is already in hand, so it is delivered on a microtask rather than
    // pretended to be slower than it is.
    this._ctx.getImageData = (x, y, width, height, cb) => {
      const read = () => {
        const w = Math.round(width);
        const h = Math.round(height);
        const bytes = this._native.windowPixels(
          this.id,
          Math.round(x),
          Math.round(y),
          w,
          h,
        );
        if (!bytes) throw new Error('react-x11: the window could not be read');
        if (DEBUG) {
          let lit = 0;
          for (let i = 0; i < bytes.length; i += 4) {
            if (bytes[i] || bytes[i + 1] || bytes[i + 2]) lit++;
          }
          console.error(
            `[win32] getImageData ${x},${y} ${w}x${h} -> ${lit}/${bytes.length / 4} lit`,
          );
        }
        return {
          data: new Uint8ClampedArray(
            bytes.buffer,
            bytes.byteOffset,
            bytes.length,
          ),
          width: w,
          height: h,
        };
      };
      if (typeof cb !== 'function') return read();
      let result;
      let failure;
      try {
        result = read();
      } catch (err) {
        failure = err;
      }
      queueMicrotask(() => cb(failure ?? null, result));
      return undefined;
    };
    return this._ctx;
  }

  /**
   * The frame. One `BeginDraw` per damage rect, which is the X11 damage model
   * verbatim — every pixel inside the rect is repainted, every pixel outside
   * it is kept by DirectComposition — and one `Commit` for the lot, which is
   * the atomic frame the node model relies on.
   *
   * The generation is bumped per rect because each BeginDraw hands back a
   * *different* Direct2D context with none of the previous one's state: the
   * context wrapper reads the bump and pushes its sticky state back in.
   */
  presentFrame(node, damage) {
    if (DEBUG) {
      console.error(
        `[win32] presentFrame window=${this.id} composed=${this._composed} ` +
          `size=${this.width}x${this.height} rects=${damage ? damage.length : 'full'}` +
          (this._owesFullPaint ? ' (owes full)' : ''),
      );
    }
    if (this.destroyed) return;
    if (!this._composed) {
      // Nothing to paint into yet. The frame is not merely skipped: what it
      // would have covered is remembered, because the damage it carried is
      // gone once this returns and the next frame's bound is whatever has been
      // claimed since — which, on a tree with an animation in it, is a handful
      // of small rects. That is exactly how this window came up transparent
      // with a perfectly healthy-looking frame log.
      this._owesFullPaint = true;
      return;
    }
    const ctx = this.getContext();
    // REACT_X11_WIN32_FULL_REPAINT=1 throws the damage away and paints the
    // whole window every frame. Slow on purpose: it is the control for
    // "is this a damage bug", which no amount of reading the rects settles.
    if (process.env.REACT_X11_WIN32_FULL_REPAINT === '1') damage = null;
    if (this._owesFullPaint) {
      this._owesFullPaint = false;
      damage = null;
    }
    const rects = damage ?? [null];
    let painted = false;
    for (const rect of rects) {
      const r = rect ?? { x: 0, y: 0, width: this.width, height: this.height };
      const w = Math.min(this.width - Math.max(0, r.x), Math.ceil(r.width));
      const h = Math.min(this.height - Math.max(0, r.y), Math.ceil(r.height));
      if (!(w > 0 && h > 0)) continue;
      const handle = this._native.beginDraw(
        this.id,
        Math.max(0, Math.floor(r.x)),
        Math.max(0, Math.floor(r.y)),
        w,
        h,
      );
      if (DEBUG) {
        console.error(
          `[win32]   rect ${Math.floor(r.x)},${Math.floor(r.y)} ${w}x${h} ` +
            `-> surface ${handle}`,
        );
      }
      if (!handle) continue;
      this._surface = handle;
      this._gen++;
      try {
        node._paintRegion(ctx, rect, this.width, this.height);
        painted = true;
      } finally {
        this._surface = 0;
        this._native.endDraw(this.id);
      }
    }
    // …and the panes over a `<glarea>` in this window, painted before this
    // (src/win32/overlay.js), in the same commit: a frame whose only change
    // was theirs still owes one
    if (painted || this._owesCommit) {
      this._owesCommit = false;
      this._native.commit();
    }
  }

  /**
   * The scroll-blit fast path: `IDCompositionSurface::Scroll`, which moves the
   * surviving band inside the surface on the GPU. The exposed strip is
   * repainted by the frame's own damage, exactly as on X11.
   */
  scrollRegion(rect, dx, dy) {
    if (!this._composed || this.destroyed) return false;
    if (DEBUG) {
      console.error(
        `[win32] scrollRegion ${Math.round(rect.x)},${Math.round(rect.y)} ` +
          `${Math.round(rect.width)}x${Math.round(rect.height)} by ${dx},${dy}`,
      );
    }
    return this._native.scrollRegion(
      this.id,
      Math.round(rect.x),
      Math.round(rect.y),
      Math.round(rect.width),
      Math.round(rect.height),
      Math.round(dx),
      Math.round(dy),
    );
  }

  /** The frame is the ordinary paint walk, a pass per damage rect, so it
   * paints through core's paint cache (src/nodes/window/flush.js). */
  get usesPaintCache() {
    return true;
  }

  /** DirectComposition does not hold a frame back the way an X server's fence
   * or a WindowServer's buffer does: Commit is asynchronous and the surface
   * retains its own pixels. So there is never a frame in flight to wait for. */
  frameInFlight() {
    return false;
  }

  requestAnimationFrame(cb) {
    return this.app._requestFrame(cb, this);
  }

  present() {
    // Nothing to flip: presentFrame committed. Kept because the frame loop
    // calls it on every window it paced.
  }

  /** A DirectComposition surface is write-only, so a window's pixels are not
   * readable the way an IOSurface's or an X drawable's are. docs/windows.md
   * answers this with PrintWindow once the commit has completed; not bound
   * yet, and it says so rather than answering with something wrong. */
  /**
   * The window's pixels, as RGBA. PrintWindow is the door DWM opens on a
   * composed window — see `windowPixels` in src/win32.cc for which flags are
   * the ones that work and what the others answer instead.
   */
  snapshot() {
    const width = Math.round(this.width);
    const height = Math.round(this.height);
    const bytes = this._native.windowPixels(this.id, 0, 0, width, height);
    if (!bytes) {
      return Promise.reject(
        new Error(
          'react-x11: the window could not be read — PrintWindow refused it. ' +
            'A window that is minimised or not yet composed has nothing to ' +
            'read; draw into an offscreen surface and read that instead.',
        ),
      );
    }
    return Promise.resolve({
      data: new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.length),
      width,
      height,
    });
  }

  /** How many damage rects a frame may carry before it collapses to their
   * box. Each is a BeginDraw with a fixed cost, so the right number is a fact
   * about DirectComposition rather than a choice — 16 is Cocoa's, kept until
   * it is measured here. */
  get damageRectCap() {
    return 16;
  }
}

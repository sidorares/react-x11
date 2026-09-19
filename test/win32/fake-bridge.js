// A fake @windowkit/win32, so the Windows backend's JS half can be tested on
// any OS — the way test/wayland/mock-compositor.js and the cocoa suite's fake
// bridge do for theirs. It records what it was asked to do rather than
// drawing anything.
//
// It holds pixels for exactly one reason: a damage rect that is never painted
// and a damage rect painted into the wrong place look identical to a test that
// only counts calls, and the thing this backend gets wrong is *which* pixels a
// frame reached. The Cocoa scroll-blit test keeps a pixel-holding fake for the
// same reason.

export function createFakeBridge() {
  const calls = [];
  const record = (name, ...args) => calls.push([name, ...args]);

  let nextSurface = 1;
  let nextLayout = 1;

  const bridge = {
    calls,
    windows: new Map(),
    /** Surfaces currently open for drawing, by handle. */
    open: new Map(),
    /** Every beginDraw rect, in order: [x, y, w, h]. */
    drawn: [],
    committed: 0,
    onEvent: null,

    // --- app ---------------------------------------------------------------

    start(onEvent) {
      bridge.onEvent = onEvent;
      record('start');
    },
    stop() {
      record('stop');
    },
    listScreens() {
      return [
        { x: 0, y: 0, width: 1920, height: 1080, scale: 1, primary: true },
      ];
    },

    // --- windows -----------------------------------------------------------

    createWindow({ title, width, height }) {
      const id = bridge.windows.size + 1;
      bridge.windows.set(id, {
        id,
        title,
        width,
        height,
        shown: false,
        composed: false,
      });
      record('createWindow', id, width, height);
      return id;
    },
    compose(id) {
      bridge.windows.get(id).composed = true;
      record('compose', id);
    },
    show(id, on) {
      bridge.windows.get(id).shown = on;
      record('show', id, on);
    },
    resize(id, width, height) {
      const wnd = bridge.windows.get(id);
      if (wnd) {
        wnd.width = width;
        wnd.height = height;
      }
      record('resize', id, width, height);
    },
    resizeWindow(id, width, height) {
      record('resizeWindow', id, width, height);
    },
    moveWindow(id, x, y) {
      record('moveWindow', id, x, y);
    },
    setTitle(id, title) {
      bridge.windows.get(id).title = title;
      record('setTitle', id, title);
    },
    destroyWindow(id) {
      record('destroyWindow', id);
    },
    setCursor(id, name) {
      record('setCursor', id, name);
    },
    setSizeHints(id, hints) {
      record('setSizeHints', id, hints);
    },

    // --- frames ------------------------------------------------------------

    beginDraw(id, x, y, w, h) {
      const wnd = bridge.windows.get(id);
      if (!wnd?.composed) return 0;
      // The real surface refuses a rect outside its bounds, which is a whole
      // class of blank window, so the fake refuses it too.
      if (x < 0 || y < 0 || x + w > wnd.width || y + h > wnd.height) return 0;
      const handle = nextSurface++;
      bridge.open.set(handle, { id, x, y, w, h, ops: [] });
      bridge.drawn.push([x, y, w, h]);
      return handle;
    },
    endDraw(id) {
      for (const [handle, surface] of bridge.open) {
        if (surface.id === id) bridge.open.delete(handle);
      }
      record('endDraw', id);
    },
    commit() {
      bridge.committed++;
    },
    scrollRegion(id, x, y, w, h, dx, dy) {
      record('scrollRegion', id, x, y, w, h, dx, dy);
      return true;
    },

    // --- the verb table ----------------------------------------------------
    //
    // Only what a paint pass actually calls unconditionally. Anything the
    // context feature-detects is deliberately absent, so the tests also prove
    // the wrapper degrades rather than throwing.

    createSurface(width, height) {
      const handle = nextSurface++;
      bridge.open.set(handle, { offscreen: true, width, height, ops: [] });
      return handle;
    },
    releaseSurface(handle) {
      bridge.open.delete(handle);
    },
    surfaceSize(handle) {
      const surface = bridge.open.get(handle);
      return {
        width: surface?.width ?? surface?.w ?? 0,
        height: surface?.height ?? surface?.h ?? 0,
      };
    },

    // --- text --------------------------------------------------------------

    layoutCreate(text, options, spans) {
      const handle = nextLayout++;
      record('layoutCreate', text, options, spans);
      bridge.layouts ??= new Map();
      bridge.layouts.set(handle, { text, options, spans });
      return handle;
    },
    layoutMetrics(handle) {
      const { text } = bridge.layouts.get(handle);
      // A monospace-ish fiction: eight pixels a character, one line.
      return {
        width: text.length * 8,
        height: 16,
        minWidth: 8,
        lineCount: 1,
        lines: [{ start: 0, end: text.length, y: 0, height: 16, baseline: 12 }],
      };
    },
    layoutRelease(handle) {
      bridge.layouts.delete(handle);
      record('layoutRelease', handle);
    },
    layoutIndexAt(handle, x) {
      return Math.max(0, Math.round(x / 8));
    },
    layoutCaret(handle, unit) {
      return { x: unit * 8, y: 0, height: 16 };
    },
    drawLayout(surface, layout, x, y) {
      record('drawLayout', surface, layout, x, y);
    },
    fontMetrics(family, size) {
      return {
        ascent: size * 0.8,
        descent: size * 0.2,
        lineGap: 0,
        height: size,
        underlinePosition: -1,
        underlineThickness: 1,
      };
    },
    fontExists(name) {
      return name === 'Segoe UI' || name === 'Consolas';
    },
    listFonts() {
      return ['Segoe UI', 'Consolas'];
    },
    postMouseEvent() {
      return true;
    },
  };

  // Every ctx verb the wrapper calls unconditionally, recorded against the
  // surface it was aimed at — which is what makes "did this frame draw into
  // the rect it opened" an assertion rather than an inspection.
  const verbs = [
    'ctxSave',
    'ctxRestore',
    'ctxTranslate',
    'ctxScale',
    'ctxRotate',
    'ctxTransform',
    'ctxSetFillColor',
    'ctxSetStrokeColor',
    'ctxSetLineWidth',
    'ctxSetLineCap',
    'ctxSetLineJoin',
    'ctxSetGlobalAlpha',
    'ctxSetLineDash',
    'ctxSetShadow',
    'ctxBeginPath',
    'ctxMoveTo',
    'ctxLineTo',
    'ctxRect',
    'ctxRoundRect',
    'ctxArc',
    'ctxEllipse',
    'ctxCurveTo',
    'ctxQuadTo',
    'ctxClosePath',
    'ctxFill',
    'ctxStroke',
    'ctxClip',
    'ctxFillRect',
    'ctxFillRects',
    'ctxStrokeRect',
    'ctxClearRect',
    'ctxFillLinearGradient',
    'ctxDrawSurface',
    'ctxPutImageData',
  ];
  for (const verb of verbs) {
    bridge[verb] = (surface, ...args) => {
      bridge.open.get(surface)?.ops.push([verb, ...args]);
      record(verb, surface, ...args);
    };
  }

  // --- the input method ----------------------------------------------------
  //
  // Both are one-way commands to the UI thread, so recording them *is* the
  // observation: whether the IME was taken off a window, and where the
  // candidate list was told to sit.
  bridge.imeEnabled = new Map();
  bridge.imeCarets = [];
  bridge.imeEnable = (windowId, on) => {
    bridge.imeEnabled.set(windowId, on);
    record('imeEnable', windowId, on);
  };
  bridge.imeCaret = (windowId, x, y, width, height) => {
    bridge.imeCarets.push({ windowId, x, y, width, height });
    record('imeCaret', windowId, x, y, width, height);
  };

  return bridge;
}

/** The smallest app object Win32Window needs. */
export function createFakeApp(bridge) {
  return {
    _native: bridge,
    _windows: new Map(),
    _register(wnd) {
      this._windows.set(wnd.id, wnd);
    },
    _unregister(wnd) {
      this._windows.delete(wnd.id);
    },
    _requestFrame() {
      return 1;
    },
  };
}

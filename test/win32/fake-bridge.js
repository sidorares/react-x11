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

/** Where the fake breaks `text` into lines at a width of eight pixels a
 *  character: greedily at spaces, each line keeping the spaces it ends on,
 *  and a word longer than a line cut where the line ends, as DirectWrite
 *  cuts one. One line where no width is given. */
function fakeBreaks(text, maxWidth) {
  if (!(maxWidth > 0)) return [[0, text.length]];
  const room = Math.max(1, Math.floor(maxWidth / 8));
  const breaks = [];
  let start = 0;
  while (start < text.length) {
    let end = start;
    let fits = start;
    while (end < text.length) {
      let word = end;
      while (word < text.length && text[word] !== ' ') word++;
      if (word - start > room) break;
      while (word < text.length && text[word] === ' ') word++;
      end = word;
      fits = word;
    }
    if (fits === start) fits = Math.min(text.length, start + room);
    breaks.push([start, fits]);
    start = fits;
  }
  return breaks.length ? breaks : [[0, 0]];
}

export function createFakeBridge({ layers = true } = {}) {
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

    createWindow(options) {
      const { title, width, height } = options;
      const id = bridge.windows.size + 1;
      bridge.windows.set(id, {
        id,
        title,
        width,
        height,
        shown: false,
        composed: false,
        // What the window was asked for, kept whole: `popup`, `transparent`
        // and `clickThrough` are decided once at creation and never appear
        // again, so a test that wants to know what a `<popup dragPreview>`
        // asked for has nowhere else to look.
        options: { ...options },
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
      bridge.layouts.set(handle, {
        text,
        options,
        spans,
        breaks: fakeBreaks(text, options?.maxWidth),
      });
      return handle;
    },
    layoutMetrics(handle) {
      const { text, options, breaks } = bridge.layouts.get(handle);
      // A monospace-ish fiction: eight pixels a character, broken at spaces
      // where a width is given, as DirectWrite breaks: a line's runs and
      // width keep the space it ends on, and its baseline is from its own
      // top. A `lineHeight` sets the baseline at 0.8 of the face's, as the
      // bridge's proportional spacing does, where the ascent and descent it
      // measures off the face stay what they were.
      const baseline = options?.lineHeight ? 12 * 0.8 : 12;
      // A centred line is centred in the box, and with no width the box is
      // a million pixels wide, as the bridge builds an unbounded layout.
      const box = options?.maxWidth > 0 ? options.maxWidth : 1e6;
      const centred = options?.align === 'center';
      const lines = breaks.map(([start, end], i) => ({
        start,
        end,
        y: i * 16,
        height: 16,
        baseline,
        ...(bridge.measuresLines ? { ascent: 12, descent: 4 } : {}),
        x: centred
          ? (box - text.slice(start, end).trimEnd().length * 8) / 2
          : 0,
        width: (end - start) * 8,
        runs: [{ start, end, x: 0, width: (end - start) * 8, rtl: false }],
      }));
      const words = text.split(/\s+/).filter(Boolean);
      return {
        width: Math.max(
          0,
          ...lines.map((l) => text.slice(l.start, l.end).trimEnd().length * 8),
        ),
        height: 16 * lines.length,
        minWidth: Math.max(8, ...words.map((w) => w.length * 8)),
        lineCount: lines.length,
        lines,
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
      const breaks = bridge.layouts?.get(handle)?.breaks ?? [[0, Infinity]];
      const at = Math.max(
        0,
        breaks.findIndex(([start, end]) => unit >= start && unit <= end),
      );
      return { x: (unit - breaks[at][0]) * 8, y: at * 16, height: 16 };
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
      return (
        name === 'Segoe UI' || name === 'Consolas' || name === 'Times New Roman'
      );
    },
    // GDI's names for faces DirectWrite files under another family
    fontFamilyOf(name) {
      return (
        {
          'Segoe UI Light': {
            family: 'Segoe UI',
            weight: 300,
            stretch: 5,
            italic: false,
          },
          'Segoe UI Black': {
            family: 'Segoe UI',
            weight: 900,
            stretch: 5,
            italic: false,
          },
          'Consolas Narrow': {
            family: 'Consolas',
            weight: 400,
            stretch: 3,
            italic: false,
          },
        }[name] ?? null
      );
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

  // --- UI Automation -------------------------------------------------------
  //
  // The provider is C++ and the mirror lives there, so what the JS half can
  // be held to is exactly this: which nodes it pushed, which it removed, and
  // when it decided to say nothing at all.
  bridge.uiaListeners = true;
  bridge.uiaPushes = [];
  bridge.uiaFocus = [];
  bridge.uiaAnnounced = [];
  bridge.uiaProperties = [];
  bridge.uiaListening = () => bridge.uiaListeners;
  bridge.uiaUpdate = (windowId, update) => {
    bridge.uiaPushes.push({ windowId, ...update });
    record('uiaUpdate', windowId);
  };
  bridge.uiaFocusChanged = (windowId, nodeId) => {
    bridge.uiaFocus.push([windowId, nodeId]);
  };
  bridge.uiaAnnounce = (windowId, text, polite) => {
    bridge.uiaAnnounced.push([windowId, text, polite]);
    return true;
  };
  bridge.uiaPropertyChanged = (windowId, nodeId, which) => {
    bridge.uiaProperties.push([windowId, nodeId, which]);
  };

  // --- layers ------------------------------------------------------------
  //
  // What a `<glarea>`'s children are drawn on (src/win32/overlay.js): a
  // visual with a surface of its own over the window's swap chains. Drawn
  // like a window — one BeginDraw per pass, in the layer's own coordinates —
  // so each pass is an open surface here too, and its ops are kept per
  // layer. `layers: false` is a bridge from before them.

  if (layers) {
    let nextLayer = 1;
    bridge.layers = new Map();
    bridge.layerCreate = (windowId, x, y, width, height) => {
      if (!bridge.windows.get(windowId)?.composed) return 0;
      const id = nextLayer++;
      bridge.layers.set(id, {
        id,
        windowId,
        x,
        y,
        width,
        height,
        visible: true,
        passes: [],
        ops: [],
        scrolled: [],
      });
      record('layerCreate', windowId, x, y, width, height);
      return id;
    };
    bridge.layerSetRect = (id, x, y, width, height) => {
      const layer = bridge.layers.get(id);
      if (!layer) return false;
      Object.assign(layer, { x, y, width, height });
      record('layerSetRect', id, x, y, width, height);
      return true;
    };
    bridge.layerSetVisible = (id, on) => {
      const layer = bridge.layers.get(id);
      if (layer) layer.visible = on;
      record('layerSetVisible', id, on);
    };
    bridge.layerBeginDraw = (id, x, y, w, h) => {
      const layer = bridge.layers.get(id);
      // the real surface refuses a rect that leaves it, as a window's does
      if (
        !layer ||
        x < 0 ||
        y < 0 ||
        x + w > layer.width ||
        y + h > layer.height
      ) {
        return 0;
      }
      const handle = nextSurface++;
      bridge.open.set(handle, { layer: id, x, y, w, h, ops: layer.ops });
      layer.passes.push([x, y, w, h]);
      return handle;
    };
    bridge.layerEndDraw = (id) => {
      for (const [handle, surface] of bridge.open) {
        if (surface.layer === id) bridge.open.delete(handle);
      }
      record('layerEndDraw', id);
      return true;
    };
    bridge.layerScroll = (id, x, y, w, h, dx, dy) => {
      bridge.layers.get(id)?.scrolled.push([x, y, w, h, dx, dy]);
      record('layerScroll', id, x, y, w, h, dx, dy);
      return true;
    };
    bridge.layerDestroy = (id) => {
      bridge.layers.delete(id);
      record('layerDestroy', id);
    };
  }

  // --- panes -------------------------------------------------------------
  //
  // A `<Frame>`'s two halves. The real ones share a composition surface
  // handle between processes; here both ends are objects in a map, which is
  // enough for everything this side decides — which frames are bounded by
  // what, when the handle is published, and how often it is attached.

  bridge.panes = new Map();
  bridge.views = new Map();
  /** Set to refuse, the way paneCreate does when it cannot reach the host. */
  bridge.paneCreateFails = false;
  /** Every present, as the size the pane had when it happened. */
  bridge.presented = [];

  let nextPane = 1;
  let nextView = 1;

  bridge.paneCreate = (width, height, hostPid) => {
    record('paneCreate', width, height, hostPid);
    if (bridge.paneCreateFails) return null;
    const id = nextPane++;
    bridge.panes.set(id, { id, width, height, hostPid, handle: 0xf00 + id });
    return { id, handle: 0xf00 + id };
  };
  bridge.paneResize = (id, width, height) => {
    record('paneResize', id, width, height);
    const pane = bridge.panes.get(id);
    if (!pane) return false;
    pane.width = width;
    pane.height = height;
    return true;
  };
  bridge.paneBeginDraw = (id) => {
    const pane = bridge.panes.get(id);
    if (!pane) return 0;
    const handle = nextSurface++;
    bridge.open.set(handle, { pane: id });
    record('paneBeginDraw', id, handle);
    return handle;
  };
  bridge.paneEndDraw = (id) => {
    record('paneEndDraw', id);
    const pane = bridge.panes.get(id);
    if (pane) bridge.presented.push({ width: pane.width, height: pane.height });
    return true;
  };
  bridge.paneDestroy = (id) => {
    record('paneDestroy', id);
    bridge.panes.delete(id);
  };
  bridge.paneAttach = (windowId, handle) => {
    record('paneAttach', windowId, handle);
    const id = nextView++;
    bridge.views.set(id, { id, windowId, handle, rect: null });
    return id;
  };
  bridge.paneSetRect = (viewId, x, y, width, height) => {
    record('paneSetRect', viewId, x, y, width, height);
    const view = bridge.views.get(viewId);
    if (view) view.rect = { x, y, width, height };
  };
  bridge.paneDetach = (viewId) => {
    record('paneDetach', viewId);
    bridge.views.delete(viewId);
  };

  return bridge;
}

/** The smallest app object Win32Window needs. `sent` collects what a pane
 *  would have put on the frame channel, which is the only thing a pane says
 *  to its host. */
export function createFakeApp(bridge, options = {}) {
  const sent = [];
  return {
    _native: bridge,
    _windows: new Map(),
    options,
    scale: options.scale ?? 1,
    fonts: null,
    sent,
    _paneSend: (msg) => sent.push(msg),
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

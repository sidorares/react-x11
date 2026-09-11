// Native control bezels — AppKit's own pixels for the core controls, cached
// as surfaces the ordinary 2d paint path can blit (docs/macos.md §Native
// controls). The mechanism is offscreen NSCell/NSControl rendering, the
// WebKit/Gecko form-control technique: interaction, focus and keyboard stay
// the shared component implementation, and only the *bezel* — the pixels of
// the well, the track, the button face — is asked of the system.
//
// Everything here is measured in points at the native boundary and delivered
// in device pixels, the same split the rest of the backend keeps.
//
// ## The ink box
//
// AppKit cells draw inside margins of their own: a push button cell insets
// its bezel ~6pt each side, a checkbox floats its 16pt well in an 18pt
// frame. Component layout wants the *visible* control — a well that is 16px
// is 16px in the row it sits in — so the store scans each (kind, size)'s
// alpha bounding box once, and every bezel afterwards is rendered into a
// frame padded back out by those insets and blitted from the ink region.
// Scanned rather than hard-coded so a macOS release that redraws its
// controls moves the answer instead of breaking it.
//
// ## On a worker
//
// In threaded mode (src/cocoa/main.js) the bridge makes the control on the
// UI thread and answers a measure or a draw through a callback
// (windowkit/appkit#54) — a cell made on the worker drew correct pixels
// and then crashed the process at exit. So nothing here can ask and use
// the answer in one call. The metrics layout reads synchronously, `natural`
// and `shadow`, are fetched for every kind at startup (`prefetch`). A bezel
// `get` has not drawn yet answers null and calls back once it has, and the
// caller draws what it had meanwhile. A bezel drawn at rest brings its
// pressed twin along, so the press — the input whose answer is the bezel —
// never waits for one (AGENTS.md, "Answer the input").

const KINDS = ['push', 'checkbox', 'radio', 'popup', 'slider', 'switch'];
// the sizes the widget set lays its controls out at (components/native.js)
const SIZES = ['regular', 'small'];
// the fullest state, so the scan sees the whole footprint
const SCAN_STATE = Object.freeze({
  state: 1,
  value: 0.5,
  enabled: true,
  appearance: 'light',
});

export class BezelStore {
  /**
   * `answersLater` says whether the bridge answers through a callback —
   * asked at each call, since the app knows only once it has started.
   */
  constructor(native, { answersLater = () => false } = {}) {
    this._native = native;
    this._answersLater = answersLater;
    this._canonical = new Map(); // kind|size|scale → { insets, natural }
    this._scanning = new Map(); // kind|size|scale → the scan in flight
    this._cache = new Map(); // full param key → { surface, sx, sy, sw, sh }
    this._drawing = new Map(); // full param key → callbacks awaiting it
    this._gen = 0;
    this._MAX = 160;
  }

  /**
   * Forget every rendered bezel. The pixels depend on one thing that is not
   * a parameter of `get`: the desktop's accent, which AppKit reads for
   * itself when it draws the cell. After the user picks another accent a
   * cached bezel is the old colour, and its key still matches — so a bezel
   * whose state happened to change came up in the new accent while the
   * ones beside it kept the old, until something else redrew them. The
   * appearance change forgets them all; the next paint renders each again.
   *
   * The measured insets and natural sizes stay: geometry is not coloured.
   */
  clear() {
    // the surfaces are freed by their External finalizer
    this._cache.clear();
    // a draw still out is in the old accent: it goes to its callers, and
    // not into the cache
    this._gen++;
  }

  /**
   * The control's natural size in logical px — the size the bezel is
   * designed at, which layout adopts for the kinds that must not stretch
   * (checkbox, radio, switch). For the stretchable kinds only `height` is
   * meaningful: a push button is as wide as its label needs. Null on a
   * worker for a size `prefetch` did not cover, until its scan is in.
   */
  natural(kind, controlSize = 'regular') {
    const c = this._scan(kind, controlSize, 2);
    if (!c) return null;
    return {
      width: Math.round(c.natural.width),
      height: Math.round(c.natural.height),
    };
  }

  /**
   * The translucent rows above and below the bezel's solid body, in logical
   * px — a push button's drop shadow, mostly. They are part of the natural
   * box (`natural` measures every inked pixel, so the box is the footprint)
   * and not part of the control: AppKit centres a title in the cell's body,
   * and a label centred in the footprint sits half the shadow too low.
   */
  shadow(kind, controlSize = 'regular') {
    const c = this._scan(kind, controlSize, 2);
    if (!c) return { top: 0, bottom: 0 };
    return {
      top: Math.round(c.body.top),
      bottom: Math.round(c.body.bottom),
    };
  }

  /**
   * Scan every kind at the widget set's sizes, now: at scale 2 for the
   * metrics (`natural` measures there) and at `scale` for the bezels the
   * app will draw. Resolves once all are in. For a worker, where a scan is
   * two answers from the UI thread; on the main thread it is not needed,
   * each scan running the first time it is asked for.
   */
  prefetch(scale) {
    const jobs = [];
    for (const s of new Set([2, scale])) {
      for (const kind of KINDS) {
        for (const size of SIZES) jobs.push(this._scanLater(kind, size, s));
      }
    }
    return Promise.all(jobs).then(() => undefined);
  }

  /**
   * The bezel for one laid-out box: `w`/`h` in device px, blit-ready.
   * Returns `{ surface, sx, sy, sw, sh }` — draw with the 9-arg
   * `ctx.drawImage` so the ink region lands exactly on the box. On a worker
   * a bezel not drawn yet is null, and `onReady` is called once it is in.
   */
  get(params, w, h, scale, onReady = null) {
    const controlSize = params.controlSize ?? 'regular';
    const key = JSON.stringify([
      params.kind,
      controlSize,
      params.state ?? 0,
      params.pressed ?? false,
      params.enabled ?? true,
      params.isDefault ?? false,
      params.value,
      params.appearance,
      w,
      h,
      scale,
    ]);
    const entry = this._cache.get(key);
    if (entry) {
      // Map order is the recency order: re-inserting keeps the hot bezels
      // at the young end when the cache is over budget.
      this._cache.delete(key);
      this._cache.set(key, entry);
      return entry;
    }
    if (this._answersLater()) {
      this._drawLater(key, { ...params, controlSize }, w, h, scale, onReady);
      return null;
    }
    const c = this._scan(params.kind, controlSize, scale);
    const frame = this._frame(c, w, h, scale);
    this._native.drawControlIntoSurface(frame.surface, {
      ...params,
      controlSize,
    });
    this._store(key, frame.entry);
    return frame.entry;
  }

  /** A surface padded out by the kind's insets, and the region of it a box
   * `w` × `h` blits from. */
  _frame(c, w, h, scale) {
    const fw = w / scale + c.insets.left + c.insets.right;
    const fh = h / scale + c.insets.top + c.insets.bottom;
    const surface = this._native.createSurface(
      Math.max(1, Math.round(fw * scale)),
      Math.max(1, Math.round(fh * scale)),
      scale,
    );
    return {
      surface,
      entry: {
        surface,
        sx: Math.round(c.insets.left * scale),
        sy: Math.round(c.insets.top * scale),
        sw: w,
        sh: h,
      },
    };
  }

  _store(key, entry) {
    this._cache.set(key, entry);
    if (this._cache.size > this._MAX) {
      // eldest first; the surface itself is freed by its External finalizer
      const oldest = this._cache.keys().next().value;
      this._cache.delete(oldest);
    }
  }

  /** A worker's `get`: one draw per key however many ask, each asker called
   * back when it lands. The surface is left alone until then — the bridge
   * draws into its bitmap on the UI thread. */
  _drawLater(key, params, w, h, scale, onReady) {
    const waiting = this._drawing.get(key);
    if (waiting) {
      if (onReady) waiting.add(onReady);
      return;
    }
    const callbacks = new Set(onReady ? [onReady] : []);
    this._drawing.set(key, callbacks);
    const gen = this._gen;
    this._scanLater(params.kind, params.controlSize, scale).then((c) => {
      const frame = this._frame(c, w, h, scale);
      this._native.drawControlIntoSurface(frame.surface, params, () => {
        this._drawing.delete(key);
        if (gen === this._gen) this._store(key, frame.entry);
        for (const fn of callbacks) fn();
        // the twin a press will ask for, drawn before the press
        if (!params.pressed && params.enabled !== false) {
          this.get({ ...params, pressed: true }, w, h, scale);
        }
      });
    });
  }

  /**
   * One render + alpha scan per (kind, size, scale): where does this cell
   * actually put ink inside the frame it is given? The frame is the natural
   * cellSize widened by 24pt so a stretchable bezel's side margins are
   * visible as margins rather than crowding the ends. Null on a worker when
   * the scan is not in yet: it is asked for, and answers later.
   */
  _scan(kind, controlSize, scale) {
    const key = `${kind}|${controlSize}|${scale}`;
    const done = this._canonical.get(key);
    if (done) return done;
    if (this._answersLater()) {
      this._scanLater(kind, controlSize, scale);
      return null;
    }
    const m = this._native.measureControl({ kind, controlSize });
    const frame = this._scanFrame(m, scale);
    this._native.drawControlIntoSurface(frame.surface, {
      kind,
      controlSize,
      ...SCAN_STATE,
    });
    return this._inkBox(key, frame, scale);
  }

  /** `_scan` through the bridge's callbacks: once per key, however many
   * ask. */
  _scanLater(kind, controlSize, scale) {
    const key = `${kind}|${controlSize}|${scale}`;
    const done = this._canonical.get(key);
    if (done) return Promise.resolve(done);
    let job = this._scanning.get(key);
    if (job) return job;
    const native = this._native;
    job = new Promise((resolve) =>
      native.measureControl({ kind, controlSize }, resolve),
    )
      .then((m) => {
        const frame = this._scanFrame(m, scale);
        return new Promise((resolve) =>
          native.drawControlIntoSurface(
            frame.surface,
            { kind, controlSize, ...SCAN_STATE },
            () => resolve(frame),
          ),
        );
      })
      .then((frame) => {
        this._scanning.delete(key);
        return this._inkBox(key, frame, scale);
      });
    this._scanning.set(key, job);
    return job;
  }

  _scanFrame(m, scale) {
    const fw = m.width + 24;
    const fh = m.height;
    const pw = Math.max(1, Math.round(fw * scale));
    const ph = Math.max(1, Math.round(fh * scale));
    return {
      surface: this._native.createSurface(pw, ph, scale),
      fw,
      fh,
      pw,
      ph,
    };
  }

  _inkBox(key, { surface, fw, fh, pw, ph }, scale) {
    const buf = this._native.ctxGetImageData(surface, 0, 0, pw, ph);
    let x0 = pw;
    let y0 = ph;
    let x1 = -1;
    let y1 = -1;
    // and the solid body inside the footprint: where the bezel is opaque,
    // which is the control itself rather than its shadow
    let by0 = ph;
    let by1 = -1;
    for (let y = 0; y < ph; y++) {
      for (let x = 0; x < pw; x++) {
        const alpha = buf[(y * pw + x) * 4 + 3];
        if (alpha > 8) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
        if (alpha >= 250) {
          if (y < by0) by0 = y;
          if (y > by1) by1 = y;
        }
      }
    }
    if (x1 < 0) {
      // nothing painted (should not happen) — treat the frame as the ink
      x0 = 0;
      y0 = 0;
      x1 = pw - 1;
      y1 = ph - 1;
    }
    if (by1 < 0) {
      // no solid pixel at all (a fully translucent bezel): the body is the
      // footprint
      by0 = y0;
      by1 = y1;
    }
    const c = {
      insets: {
        left: x0 / scale,
        top: y0 / scale,
        right: fw - (x1 + 1) / scale,
        bottom: fh - (y1 + 1) / scale,
      },
      natural: {
        width: (x1 - x0 + 1) / scale,
        height: (y1 - y0 + 1) / scale,
      },
      body: {
        top: (by0 - y0) / scale,
        bottom: (y1 - by1) / scale,
      },
    };
    this._canonical.set(key, c);
    return c;
  }
}

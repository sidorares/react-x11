// Native control bezels — the visual styles engine's own pixels for the core
// controls, cached as surfaces the ordinary 2d paint path blits. This is the
// Windows counterpart of src/cocoa/bezels.js, and it answers the same
// `app.nativeBezels` contract: interaction, focus and keyboard stay the shared
// component implementation, and only the *bezel* is asked of the system.
//
// ## Light only, and why that is the honest answer
//
// Windows exposes the **dark** common controls through undocumented uxtheme
// ordinals. The public route is `SetWindowTheme(hwnd, 'DarkMode_CFD')`, and
// measured on Windows 11 build 26200 it reaches COMBOBOX and nothing else:
// BUTTON, the checkbox, the radio and the trackbar thumb all draw
// pixel-identical to their light selves (test/bezels.js in the bridge is that
// measurement, and it fails if a future build changes the answer).
//
// A light button on a dark window is worse than a drawn one, so this store is
// installed only while the desktop is light. In dark the widget set draws its
// own bezels — which still follow the system, because the palette's accent is
// the accent the appearance ladder read out of DWM.
//
// ## Nothing here is asked twice
//
// A bezel is a surface keyed by everything that changes its pixels. The Cocoa
// store has a `_drawLater` path because its bridge answers on another thread;
// here every draw is synchronous on the JS thread, so `get` always answers and
// the `onReady` callback is never needed.

/** The kinds the widget set asks for. `switch` is absent on purpose: the
 * theme engine has no toggle-switch part — the WinUI one is not in it — so
 * the component keeps drawing its own rather than being handed something that
 * is not a switch. */
const KINDS = ['push', 'checkbox', 'radio', 'popup', 'slider'];

/**
 * The heights a control is laid out at. A checkbox and a radio have a real
 * intrinsic size and the theme reports it (13x13 at 96 dpi), so those are
 * asked. A button and a combo box size to their content, and the theme's
 * answer for them is a *minimum* — 13x11 for a push button, which as a
 * footprint would be a button nobody could read — so the conventional Windows
 * metrics are used instead.
 */
const HEIGHTS = {
  push: { regular: 24, small: 20 },
  popup: { regular: 24, small: 20 },
  slider: { regular: 22, small: 18 },
};

export class Win32Bezels {
  constructor(native, scale = 1) {
    this._native = native;
    this._scale = scale;
    /** key -> { surface, sx, sy, sw, sh } */
    this._cache = new Map();
    /** `${kind}:${controlSize}` -> { width, height } | null */
    this._natural = new Map();
  }

  /** Dropped when the appearance changes, because every cached bezel was
   * drawn in the old one. `cascade.js` calls this. */
  clear() {
    for (const entry of this._cache.values()) {
      this._native.releaseSurface(entry.surface);
    }
    this._cache.clear();
    this._natural.clear();
  }

  natural(kind, controlSize = 'regular') {
    const key = `${kind}:${controlSize}`;
    if (this._natural.has(key)) return this._natural.get(key);

    let answer = null;
    if (KINDS.includes(kind)) {
      const themed = this._native.bezelNatural(kind, false);
      if (themed) {
        const height = HEIGHTS[kind]?.[controlSize];
        answer = height
          ? { width: themed.width, height }
          : { width: themed.width, height: themed.height };
      }
    }
    this._natural.set(key, answer);
    return answer;
  }

  /** Windows parts carry no translucent shadow band above or below the body,
   * the way an AppKit push button does — the bezel is its own footprint. */
  shadow() {
    return { top: 0, bottom: 0 };
  }

  /**
   * The bezel for these parameters at this size, as a surface and the rect
   * inside it. Answers null for a kind with no part, which the component reads
   * as "draw your own".
   */
  get(params, width, height) {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    if (!KINDS.includes(params.kind)) return null;
    // A dark request should never reach here — the store is uninstalled in
    // dark — but a palette pinned dark under a light desktop can ask, and a
    // light bezel is not the answer to it.
    if (params.appearance === 'dark') return null;

    const key = [
      params.kind,
      params.controlSize ?? 'regular',
      params.state ? 1 : 0,
      params.pressed ? 1 : 0,
      params.enabled === false ? 0 : 1,
      params.isDefault ? 1 : 0,
      w,
      h,
    ].join(':');
    const cached = this._cache.get(key);
    if (cached) return cached;

    const surface = this._native.createSurface(w, h, 1);
    const drawn = this._native.bezelDraw(
      surface,
      params.kind,
      {
        enabled: params.enabled !== false,
        pressed: Boolean(params.pressed),
        checked: Boolean(params.state),
        isDefault: Boolean(params.isDefault),
        dark: false,
      },
      0,
      0,
      w,
      h,
    );
    if (!drawn) {
      this._native.releaseSurface(surface);
      this._cache.set(key, null);
      return null;
    }

    const entry = { surface, sx: 0, sy: 0, sw: w, sh: h };
    this._cache.set(key, entry);
    return entry;
  }
}

/**
 * The store, or null where native bezels would be worse than drawn ones:
 * under a classic theme with no visual styles at all, and in dark, where the
 * parts this backend can reach are light-only (see the header).
 */
export function createBezels(native, { colorScheme, scale = 1 } = {}) {
  if (typeof native.themesActive !== 'function' || !native.themesActive()) {
    return null;
  }
  if (colorScheme === 'dark') return null;
  return new Win32Bezels(native, scale);
}

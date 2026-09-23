// Symbols by name: the platform's own icons, drawn in the text colour inside
// a window (#591) — the names `useTray`'s `icon` and a menu item's `iconName`
// already take, and nothing that draws in a window did.
//
// Two providers, one per icon system, behind the same two questions, how
// big and draw it here:
//
// - **SF Symbols** on the Cocoa backend, which brings its own
//   (`app.symbols`, src/cocoa/symbols.js): a symbol is a template, drawn in
//   the fill colour at the weight and point size of the text beside it.
// - **The freedesktop icon theme** everywhere else (src/icontheme.js): the
//   user's theme, looked up at the size the text calls for. A `-symbolic` icon
//   is preferred and drawn the same way, its shape in the text colour; an icon
//   that is only drawn in its own colours is shown as it is.
//
// A name one system does not have simply is not there, and takes no room —
// the same bargain a tray icon's name makes — so an app that runs on both
// picks its names by platform, as it does for the tray.

import { cssColorStraight } from 'ntk/color';
import { decodeImage } from 'ntk/image';
import SvgView from 'ntk/svg';
import * as nodeFs from 'node:fs';

import { IconTheme } from './icontheme.js';
import { Surface } from './offscreen.js';
import { xsettings } from './xsettings.js';

/** A `fontWeight` as the number both icon systems configure with. */
export function symbolWeight(weight) {
  if (typeof weight === 'number') return weight;
  if (weight === 'bold') return 700;
  return 400;
}

const warned = new Set();
/** A development warning, once per message. */
export function warnOnce(message) {
  if (process.env.NODE_ENV === 'production' || warned.has(message)) return;
  warned.add(message);
  console.warn(message);
}

// --- the freedesktop icon theme -----------------------------------------------

/**
 * The size a theme is asked for beside text of `pointSize`: 16 for 14px text,
 * which is the pairing every toolkit's menus and toolbars are drawn at, and in
 * proportion from there. An icon theme's icons are square.
 */
export const iconSizeFor = (pointSize) =>
  Math.max(1, Math.round((pointSize * 8) / 7));

/**
 * The user's icon theme on this connection: what the settings daemon says
 * (`Net/IconThemeName`, which GNOME and Xfce write), and failing that
 * Adwaita, which `hicolor` then backs up. An explicit `theme` from the test
 * seam wins.
 */
export function iconThemeName(app) {
  const named = xsettings(app)?.get?.('Net/IconThemeName');
  return typeof named === 'string' && named ? named : 'Adwaita';
}

class FreedesktopSymbols {
  constructor(app, { theme, baseDirs, pixmapDirs, fs = nodeFs } = {}) {
    this.app = app;
    this.fs = fs;
    this.theme = new IconTheme({
      theme: theme ?? iconThemeName(app),
      baseDirs,
      pixmapDirs,
      fs,
    });
    this.documents = new Map(); // path -> SvgView | Image | null
    // path|size|colour -> Surface, least recently drawn first
    this.rasters = new Map();
  }

  /** `{ path, symbolic }` for a name at a logical size, or null. A symbolic
   *  variant is preferred: it is the one that takes the text colour. */
  _resolve(name, pointSize, scale) {
    const size = iconSizeFor(pointSize);
    const whole = Math.max(1, Math.round(scale));
    const symbolic = name.endsWith('-symbolic');
    for (const candidate of symbolic ? [name] : [`${name}-symbolic`, name]) {
      const path = this.theme.find(candidate, size, whole);
      if (path) return { path, symbolic: candidate.endsWith('-symbolic') };
    }
    return null;
  }

  size(name, options) {
    if (!this._resolve(name, options.pointSize, options.displayScale)) {
      return null;
    }
    const side = iconSizeFor(options.pointSize);
    return { width: side, height: side };
  }

  draw(ctx, name, rect, options) {
    const found = this._resolve(name, options.pointSize, options.displayScale);
    if (!found) return false;
    // square, centred in the box, on whole device pixels
    const side = Math.max(1, Math.floor(Math.min(rect.width, rect.height)));
    const x = Math.round(rect.x + (rect.width - side) / 2);
    const y = Math.round(rect.y + (rect.height - side) / 2);
    const raster = this._raster(found, side, options.color);
    if (!raster) return false;
    ctx.drawImage(raster, x, y, side, side);
    return true;
  }

  /** The icon drawn at `side` device pixels — in `color` for a symbolic one —
   *  kept for the next paint. */
  _raster(found, side, color) {
    const ink = found.symbolic
      ? (cssColorStraight(color) ?? [0, 0, 0, 1])
      : null;
    const key = `${found.path}\u0000${side}\u0000${ink?.join(',') ?? ''}`;
    const kept = this.rasters.get(key);
    if (kept) {
      this.rasters.delete(key);
      this.rasters.set(key, kept);
      return kept;
    }
    const document = this._document(found.path);
    if (!document) return null;
    let surface;
    try {
      surface = new Surface(this.app, { width: side, height: side });
    } catch {
      return null; // no offscreen surfaces here: the headless mock
    }
    surface.render((sctx) => {
      sctx.clearRect(0, 0, side, side);
      if (document instanceof SvgView) document.draw(sctx, 0, 0, side, side);
      else sctx.drawImage(document, 0, 0, side, side);
      if (ink) {
        // the shape's coverage, in the text colour: what AppKit does with a
        // template, and what GTK does with a symbolic icon
        sctx.globalCompositeOperation = 'source-in';
        sctx.fillStyle = `rgba(${Math.round(ink[0] * 255)}, ${Math.round(ink[1] * 255)}, ${Math.round(ink[2] * 255)}, ${ink[3]})`;
        sctx.fillRect(0, 0, side, side);
      }
    });
    this.rasters.set(key, surface);
    if (this.rasters.size > 64) {
      const [oldest, evicted] = this.rasters.entries().next().value;
      this.rasters.delete(oldest);
      evicted.destroy?.();
    }
    return surface;
  }

  _document(path) {
    if (this.documents.has(path)) return this.documents.get(path);
    let document = null;
    try {
      const bytes = this.fs.readFileSync(path);
      if (path.endsWith('.svg')) {
        document = new SvgView(null);
        document.setSvg(bytes.toString('utf8'));
      } else {
        document = decodeImage(bytes);
      }
    } catch (err) {
      warnOnce(`react-x11: the icon ${path} did not load: ${err.message}`);
    }
    this.documents.set(path, document);
    return document;
  }

  destroy() {
    for (const surface of this.rasters.values()) surface.destroy?.();
    this.rasters.clear();
  }
}

// --- per app --------------------------------------------------------------------

const providers = new WeakMap();

/**
 * The symbol provider for a connection: the one the app brings, which is the
 * Cocoa app's SF Symbols, or the freedesktop icon theme, made on first use.
 */
export function symbolsFor(app) {
  let provider = providers.get(app);
  if (!provider) {
    provider = app?.symbols ?? new FreedesktopSymbols(app);
    providers.set(app, provider);
  }
  return provider;
}

/** Look icons up in a theme of the test's own, at base directories it names. */
export function setIconThemeForTests(app, options) {
  providers.get(app)?.destroy?.();
  if (options == null) providers.delete(app);
  else providers.set(app, new FreedesktopSymbols(app, options));
}

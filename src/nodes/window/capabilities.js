// What a window can paint: compositing and ARGB transparency, the window
// background, and the capabilities `@supports` blocks read.

import { cssColorStraight } from 'ntk';
import {
  argbVisual,
  compositingActive,
  transparencyDisabled,
  watchCompositing,
} from '../../compositing.js';
import { DEV } from '../util.js';

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
export function devWarnWindowShadow(kind) {
  if (warnedWindowShadow) return;
  warnedWindowShadow = true;
  console.warn(
    `react-x11: boxShadow on <${kind}> is ignored — a shadow is painted ` +
      'outside the box, and a toplevel window owns no pixels there. Put the ' +
      'shadow on a <box> inside it, or draw the window with a translucent ' +
      'margin of its own (docs/styling.md).',
  );
}

/** What the window can paint, installed onto `WindowNode.prototype` by window.js. */
export class WindowCapabilities {
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
}

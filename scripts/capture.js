// Reading pixels back off the X server and writing them to a PNG.
//
// One module because the alternative was three copies of the same wrong
// assumption. Every one of them said "GetImage gives BGRA" and swapped the
// red and blue channels on the way out — which was true of a bare
// `X.GetImage` on a little-endian server with the standard visual, and true
// of `getImageData` too until ntk 5.3.0 made it speak straight RGBA the way
// canvas does (sidorares/ntk#153, a `feat!`). After that bump
// `scripts/screenshots.jsx` was swapping channels that were already in
// order, so every regenerated screenshot came out with its blues gold and
// its reds blue. Nothing in CI compares those PNGs, so it was invisible.
//
// Two routes in, and the difference is whether we own the drawable:
//
// - **A window of ours** has an ntk 2d context, and `getImageData` is the
//   canvas contract — straight, non-premultiplied RGBA, byte order and
//   premultiplication already normalized away. Use this one.
// - **A drawable we do not own** — a window manager's frame, in
//   `screenshots-framed.jsx` — has no context, so it takes a raw
//   `X.GetImage`. Those bytes really are the server's own: `image_byte_order`
//   times the visual's masks, with the fourth byte of a depth-24 drawable
//   being undefined padding rather than alpha. ntk exports the layout
//   description and the conversion, so this asks rather than assumes.
//
// Either way what comes out of here is straight RGBA, and `blit` is the only
// thing that writes PNG bytes.
import { PNG } from 'pngjs';
import { pixelLayout, toStraightRgba } from 'ntk';

/** Promisify one of node-x11's callback methods. */
const cb2p =
  (fn) =>
  (...args) =>
    new Promise((resolve, reject) =>
      fn(...args, (err, value) => (err ? reject(err) : resolve(value))),
    );

/**
 * A window we rendered, read through its 2d context.
 *
 * Reads the backing pixmap on a double-buffered window, so it is valid even
 * where the window is occluded — which a raw `GetImage` on the window is
 * not.
 *
 * @returns {Promise<{data: Uint8ClampedArray, width: number, height: number}>}
 *   straight RGBA, rows top to bottom
 */
export async function captureWindow(wnd) {
  const { width, height } = wnd;
  const ctx = wnd.getContext('2d');
  const image = await new Promise((resolve, reject) =>
    ctx.getImageData(0, 0, width, height, (err, d) =>
      err ? reject(err) : resolve(d),
    ),
  );
  return { data: image.data, width, height };
}

/**
 * Any drawable, including one belonging to another client.
 *
 * `pixelLayout` reads the depth's TrueColor visual to find where each
 * channel sits inside a pixel word and which end of it the server writes
 * first; `toStraightRgba` then unpacks accordingly. That is the whole
 * reason to prefer it over a hand-written swap: the swap is right for one
 * server configuration and silently wrong for the others.
 *
 * @returns {Promise<{data: Uint8ClampedArray, width: number, height: number}>}
 */
export async function captureDrawable(app, drawable) {
  const X = app.X;
  const geom = await cb2p(X.GetGeometry.bind(X))(drawable);
  const { width, height } = geom;
  const img = await cb2p(X.GetImage.bind(X))(
    2 /* ZPixmap */,
    drawable,
    0,
    0,
    width,
    height,
    0xffffffff,
  );
  const layout = pixelLayout(app.X.display, geom.depth);
  return {
    data: toStraightRgba(img.data, layout, width, height),
    width,
    height,
  };
}

/**
 * Copy a straight-RGBA capture into a PNG at `(ox, oy)`, clipped to it.
 *
 * Alpha is forced opaque. A screenshot is a picture of what is on the
 * screen, and a window drawn at depth 24 has no alpha channel to report —
 * carrying through whatever the conversion produced for it would make the
 * PNG partly transparent for no reason a reader of the file could guess.
 *
 * **The offset is rounded**, because a pixel index is a whole number and
 * nothing here would have said otherwise: a half-pixel `oy` multiplies into
 * half a row, so the copy lands shifted by half the destination's width and
 * wraps around its right edge — a picture of the right menu, sheared and cut
 * in two, from a caller that only asked for the middle of a widget.
 */
export function blit(png, src, ox = 0, oy = 0) {
  ox = Math.round(ox);
  oy = Math.round(oy);
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const dx = ox + x;
      const dy = oy + y;
      if (dx < 0 || dy < 0 || dx >= png.width || dy >= png.height) continue;
      const s = (y * src.width + x) * 4;
      const d = (dy * png.width + dx) * 4;
      png.data[d + 0] = src.data[s + 0];
      png.data[d + 1] = src.data[s + 1];
      png.data[d + 2] = src.data[s + 2];
      png.data[d + 3] = 255;
    }
  }
  return png;
}

/** One capture, as a PNG buffer. */
export function toPng(capture) {
  const png = new PNG({ width: capture.width, height: capture.height });
  blit(png, capture);
  return png;
}

/** `[r, g, b]` at a pixel of a capture — what the guard test asserts on. */
export function rgbAt(capture, x, y) {
  const i = (y * capture.width + x) * 4;
  return [capture.data[i], capture.data[i + 1], capture.data[i + 2]];
}

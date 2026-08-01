// Pixel assertions: what the X server actually put on the surface, read
// back with GetImage.
//
// This is the assertion that cannot lie. A snapshot of a node tree proves
// the tree; a pixel proves the tree, the layout, the clip, the paint order,
// the colour parsing and the wire encoding all at once — and it is the only
// way to catch the class of bug where everything is committed correctly and
// nothing reaches the screen.
//
// Two details the readback demands:
//
// - **BGRA, not RGBA.** X hands back the server's native byte order, so
//   `[i+2], [i+1], [i]` is red, green, blue. Getting this wrong swaps red
//   and blue, which looks like a colour bug in the code under test.
// - **Antialiasing means tolerance.** A glyph edge or a rounded corner is
//   never exactly the fill colour, so every comparison here takes one.

const DEFAULT_TOLERANCE = 8;

/** `#rgb`, `#rrggbb` or `[r,g,b]` → `[r, g, b]`. */
export function toRgb(colour) {
  if (Array.isArray(colour)) return colour.slice(0, 3);
  const hex = String(colour).replace('#', '');
  const full =
    hex.length === 3
      ? hex
          .split('')
          .map((c) => c + c)
          .join('')
      : hex;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

function readImage(ctx, x, y, width, height) {
  return new Promise((resolve, reject) =>
    ctx.getImageData(x, y, width, height, (err, data) =>
      err ? reject(err) : resolve(data),
    ),
  );
}

/** `[r, g, b]` at a window coordinate. */
export async function pixelAt(ctx, x, y) {
  const image = await readImage(ctx, x, y, 1, 1);
  return [image.data[2], image.data[1], image.data[0]];
}

/** Whether two colours are the same within a tolerance. */
export function isNear(rgb, want, tolerance = DEFAULT_TOLERANCE) {
  const target = toRgb(want);
  return rgb.every((c, i) => Math.abs(c - target[i]) <= tolerance);
}

const hex = (rgb) =>
  '#' + rgb.map((c) => c.toString(16).padStart(2, '0')).join('');

/** Assert the pixel at `x,y`. Throws with both colours in hex on a miss. */
export async function expectPixel(ctx, x, y, want, options = {}) {
  const { tolerance = DEFAULT_TOLERANCE, message = null } = options;
  const got = await pixelAt(ctx, x, y);
  if (isNear(got, want, tolerance)) return got;
  throw new Error(
    `${message ? message + ': ' : ''}expected ${hex(toRgb(want))} at ${x},${y}` +
      ` (±${tolerance}), got ${hex(got)}`,
  );
}

/**
 * Poll until the pixel arrives, or fail. For anything that finishes on its
 * own schedule — a transition, an image decode, an async rich-content
 * reflow — where the alternative is a sleep long enough to be flaky anyway.
 */
export async function waitForPixel(ctx, x, y, want, options = {}) {
  const {
    timeout = 2000,
    interval = 20,
    tolerance = DEFAULT_TOLERANCE,
    message = null,
  } = options;
  const deadline = Date.now() + timeout;
  let got;
  for (;;) {
    got = await pixelAt(ctx, x, y);
    if (isNear(got, want, tolerance)) return got;
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(
    `${message ? message + ': ' : ''}timed out after ${timeout}ms waiting for ` +
      `${hex(toRgb(want))} at ${x},${y} (±${tolerance}); last read ${hex(got)}`,
  );
}

/** How many pixels in a region are near a colour — "did it draw anything?" */
export async function countPixels(
  ctx,
  region,
  want,
  tolerance = DEFAULT_TOLERANCE,
) {
  const { x = 0, y = 0, width, height } = region;
  const image = await readImage(ctx, x, y, width, height);
  const target = toRgb(want);
  let n = 0;
  for (let i = 0; i < width * height; i++) {
    const rgb = [
      image.data[i * 4 + 2],
      image.data[i * 4 + 1],
      image.data[i * 4],
    ];
    if (rgb.every((c, k) => Math.abs(c - target[k]) <= tolerance)) n++;
  }
  return n;
}

/**
 * Write a PNG of the window (or a region of it). Not an assertion — the
 * thing to reach for when a pixel assertion fails and the message is not
 * enough, and how a PR gets a screenshot rendered by its own code.
 */
export async function toPNG(ctx, file, region = {}) {
  const { PNG } = await import('pngjs');
  const { writeFileSync } = await import('node:fs');
  const { x = 0, y = 0, width, height } = region;
  if (!width || !height) {
    throw new Error(
      'react-x11/test: toPNG needs { width, height } — the context does not ' +
        'know how big the window is.',
    );
  }
  const image = await readImage(ctx, x, y, width, height);
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    png.data[i * 4 + 0] = image.data[i * 4 + 2]; // BGRA -> RGBA
    png.data[i * 4 + 1] = image.data[i * 4 + 1];
    png.data[i * 4 + 2] = image.data[i * 4 + 0];
    png.data[i * 4 + 3] = 255;
  }
  const buffer = PNG.sync.write(png);
  if (file) writeFileSync(file, buffer);
  return buffer;
}

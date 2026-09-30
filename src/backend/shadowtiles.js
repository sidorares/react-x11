// The tiles blurred shadows are drawn from, on a bridge's own surfaces.
//
// A gaussian over a shape costs its area times its width, and CoreGraphics
// pays it on every `fill` that has a shadow set — a header's
// `box-shadow: inset 0 0 100px` was 130 to 380 ms of each scroll frame on a
// 2x display, and a card's 200px hover shadow 110 ms, on every strip a
// scroll exposed across it. Direct2D draws no live shadow at all (the win32
// bridge records one and draws nothing). ntk's `ntk/shadow-tiles` plans
// the shadow of a rect, a rounded rect or a rect with a rounded hole as a
// small tile and nine pieces of it — the corners as they are, a straight
// pixel stretched between them — and makes the tile's pixels; this keeps
// the tiles, as surfaces of the bridge's, and `BackendContext2D` draws the
// pieces (src/backend/context2d.js, `_drawTiledShadow`).
//
// A surface here has no coverage format to composite through a colour, as
// X's `a8` does, so a tile is made in its colour and the colour is part of
// its name: one per shadow colour in use, rather than one per shadow.

import { rasterShadowTile } from 'ntk/shadow-tiles';

/** What the tiles of one bridge may hold, least recently drawn let go
 *  first. A card's tile is tens of kilobytes. */
export const TILE_BUDGET = 8 << 20;

/**
 * The tiles made for one bridge, least recently drawn let go first once
 * they hold more than `budget` bytes. There is one bridge in a process, so
 * every window of an app shares them.
 */
export class ShadowTileCache {
  constructor(native, budget = TILE_BUDGET) {
    this._native = native;
    this._budget = budget;
    this._tiles = new Map();
    this._bytes = 0;
    this.stats = { made: 0, hits: 0, released: 0 };
  }

  /** The tile for `plan` in `rgba` (0..1 each), made now if it is not
   *  held; null where the bridge made no surface. */
  get(plan, rgba) {
    const key = `${plan.key}|${rgba.join(',')}`;
    const held = this._tiles.get(key);
    if (held) {
      this._tiles.delete(key);
      this._tiles.set(key, held);
      this.stats.hits++;
      return held.handle;
    }
    const n = this._native;
    const handle = n.createSurface(plan.width, plan.height, 1);
    if (handle == null) return null;
    const pixels = rasterShadowTile(plan, rgba);
    n.ctxPutImageData(
      handle,
      Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength),
      plan.width,
      plan.height,
      0,
      0,
    );
    const bytes = plan.width * plan.height * 4;
    this._tiles.set(key, { handle, bytes });
    this._bytes += bytes;
    this.stats.made++;
    for (const [oldest, tile] of this._tiles) {
      if (this._bytes <= this._budget || tile.handle === handle) break;
      this._tiles.delete(oldest);
      this._bytes -= tile.bytes;
      this.stats.released++;
      n.releaseSurface?.(tile.handle);
    }
    return handle;
  }
}

const caches = new WeakMap();

/** The one tile cache for a bridge. */
export function shadowTilesFor(native) {
  let cache = caches.get(native);
  if (!cache) caches.set(native, (cache = new ShadowTileCache(native)));
  return cache;
}

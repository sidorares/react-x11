/**
 * A surface an element draws into and a layer shows as it is
 * (`createLayerSurface`, docs/extending.md).
 */

import type { NtkApp } from './nodes.js';
import type { Context2D } from '../node.js';

export interface LayerSurfaceOptions {
  /** The size in whole device pixels. */
  width: number;
  height: number;
}

export interface LayerSurfaceDrawOptions {
  /** The frame draws every pixel: nothing is carried over from the one
   * before it. */
  full?: boolean;
}

export declare class LayerSurface {
  constructor(app: NtkApp | null, options: LayerSurfaceOptions);
  readonly width: number;
  readonly height: number;
  /** Moves with every `draw()` and with `close()`. */
  readonly version: number;
  readonly closed: boolean;
  /** The newest frame, for `ctx.drawImage` where the part is not on a
   * layer: null before the first `draw()`. */
  readonly surface: unknown | null;
  /** Draw a frame into a surface that starts as the one before it. */
  draw(fn: (ctx: Context2D) => void, options?: LayerSurfaceDrawOptions): void;
  close(): void;
}

export declare function createLayerSurface(
  app: NtkApp | null,
  options: LayerSurfaceOptions,
): LayerSurface;

export declare function isLayerSurface(value: unknown): value is LayerSurface;

/**
 * Video: frames an application decodes into a sink, and the platform's own
 * player behind `<video src>` (docs/elements.md#video).
 */

import type { NtkApp } from './nodes.js';

/**
 * How a frame's bytes are laid out. `'NV12'`: a Y plane, then one plane of
 * Cb/Cr pairs at half the size each way — what a hardware decoder emits.
 * `'I420'`: Y, Cb, Cr, three planes, the chroma at half size — `yuv420p`,
 * most software decoders' default. `'BGRA'`: four bytes a pixel, blue first;
 * the fourth byte is ignored, since a frame is opaque.
 */
export type VideoFormat = 'NV12' | 'I420' | 'BGRA';

/** The formats, in the order they are listed in. */
export const VIDEO_FORMATS: readonly VideoFormat[];

/** What a YCbCr frame's numbers mean — the matrix and the primaries. SDR
 * only. */
export type VideoColorSpace = 'bt709' | 'bt601' | 'bt2020';

/** `'video'` puts black at 16 and white at 235; `'full'` at 0 and 255. */
export type VideoRange = 'video' | 'full';

export interface VideoFramesOptions {
  /** The frame size in whole pixels — source pixels, which `<video>` lays
   * out as logical pixels, as `<image>` does. */
  width: number;
  height: number;
  /** `'BGRA'` when left out. A decoder that can choose asks
   * `preferredFormats`. */
  format?: VideoFormat;
  /** `'bt709'` when left out. */
  colorSpace?: VideoColorSpace;
  /** `'video'` when left out. */
  range?: VideoRange;
}

/** One pushed frame, as a sink holds it. */
export interface VideoFrame {
  /** One view per plane, over the bytes `push` was handed — not copied. */
  readonly planes: readonly Uint8Array[];
  /** Each plane's bytes per row. */
  readonly strides: readonly number[];
  /** The presentation time `push` was given, in seconds, or null. */
  readonly time: number | null;
  /** Which push this was, counting from 1. */
  readonly version: number;
}

export interface VideoPushOptions {
  /** Each plane's bytes per row, when a decoder pads them; packed when left
   * out. */
  strides?: number[];
  /** The frame's presentation time in seconds, kept as `frame.time`. */
  time?: number;
}

/**
 * Where decoded frames go to be shown, and what `<video frames>` takes. The
 * newest frame is the frame: a push replaces the last, shown or not.
 */
export class VideoFrames {
  readonly width: number;
  readonly height: number;
  readonly format: VideoFormat;
  readonly colorSpace: VideoColorSpace;
  readonly range: VideoRange;
  /** This display's formats, cheapest first: what a decoder that can choose
   * should emit (`ffmpeg -pix_fmt nv12`). NV12 leads where a frame goes on
   * a layer as it is — macOS — and BGRA wherever a 2D context draws it. */
  readonly preferredFormats: readonly VideoFormat[];
  /** Frames pushed so far. */
  readonly version: number;
  /** The newest frame, or null before the first push and after `close()`. */
  readonly frame: VideoFrame | null;
  readonly closed: boolean;
  /**
   * One decoded frame: a Buffer per plane (`[y, uv]` for NV12, `[y, cb, cr]`
   * for I420, `[bgra]`), or one Buffer holding the planes back to back, the
   * way an `ffmpeg -f rawvideo` pipe delivers them. The planes are read
   * until the next push, not copied at the call. Throws a `TypeError` for
   * planes too small for the frame; does nothing after `close()`.
   */
  push(
    planes: ArrayBufferView | readonly ArrayBufferView[],
    options?: VideoPushOptions,
  ): void;
  /** Drop the frame and take no more: what shows the sink shows its poster
   * or its background from the next frame on. */
  close(): void;
}

/** A sink for frames of one size and format, on `app`. */
export function createVideoFrames(
  app: NtkApp,
  options: VideoFramesOptions,
): VideoFrames;

/**
 * A sink for a component: the same object across renders, a new one when the
 * size, the format or the colour changes. Nothing to close on unmount.
 */
export function useVideoFrames(options: VideoFramesOptions): VideoFrames;

/** `<video src>` on a backend with no platform player — what `onError` is
 * handed there. `useSupports('mediaPlayback')` asks first. */
export class NoMediaPlaybackError extends Error {
  readonly name: 'NoMediaPlaybackError';
  readonly code: 'ENOMEDIAPLAYBACK';
}

/** `onLoadedMetadata`: the stream's size, and how long it is. */
export interface VideoMetadataEvent {
  /** Source pixels. */
  width: number;
  height: number;
  /** Seconds; `Infinity` for a live source — a sink is one. */
  duration: number;
  node: unknown;
}

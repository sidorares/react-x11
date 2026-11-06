/**
 * Media capture: cameras, microphones, the screen, and audio out
 * (docs/media.md). The web's nouns — constraint dictionaries, `kind`
 * strings, error names, a minimal `MediaStream` — with React's verbs:
 * acquisition is hook state, frames come off a track by callback.
 */

import type { VideoColorSpace, VideoFormat, VideoRange } from './video.js';

/** What `enumerateDevices` lists a device as. */
export type MediaDeviceKind = 'videoinput' | 'audioinput' | 'audiooutput';

/** A range a setting can take, both ends known. */
export interface MediaRange {
  min: number;
  max: number;
}

/** What a device can run at: a range per number, a list per choice. A
 * field left out is a setting the device does not have. */
export interface MediaTrackCapabilities {
  deviceId?: string;
  groupId?: string;
  width?: MediaRange;
  height?: MediaRange;
  aspectRatio?: MediaRange;
  frameRate?: MediaRange;
  facingMode?: string[];
  resizeMode?: string[];
  sampleRate?: MediaRange;
  sampleSize?: MediaRange;
  channelCount?: MediaRange;
  latency?: MediaRange;
  echoCancellation?: boolean[];
  autoGainControl?: boolean[];
  noiseSuppression?: boolean[];
}

/** What a track runs at: the size and rate a camera actually delivers, the
 * rate samples arrive at, whether echo cancellation engaged. */
export interface MediaTrackSettings {
  deviceId?: string;
  groupId?: string;
  width?: number;
  height?: number;
  aspectRatio?: number;
  frameRate?: number;
  facingMode?: string;
  resizeMode?: string;
  sampleRate?: number;
  sampleSize?: number;
  channelCount?: number;
  latency?: number;
  echoCancellation?: boolean;
  autoGainControl?: boolean;
  noiseSuppression?: boolean;
  /** A screen track's: what it captures. */
  displaySurface?: 'monitor' | 'window';
  /** A screen track's: whether the pointer is drawn in. */
  cursor?: 'always' | 'never';
}

/** A preference (a bare value, `ideal`) or a requirement (`exact`, `min`,
 * `max`). */
export type ConstrainNumber =
  number | { exact?: number; ideal?: number; min?: number; max?: number };
export type ConstrainString =
  string | string[] | { exact?: string | string[]; ideal?: string | string[] };
export type ConstrainBoolean = boolean | { exact?: boolean; ideal?: boolean };

/** A camera's constraints: Media Capture and Streams' names and forms. */
export interface VideoTrackConstraints {
  deviceId?: ConstrainString;
  groupId?: ConstrainString;
  width?: ConstrainNumber;
  height?: ConstrainNumber;
  aspectRatio?: ConstrainNumber;
  frameRate?: ConstrainNumber;
  facingMode?: ConstrainString;
  resizeMode?: ConstrainString;
}

/** A microphone's constraints. `sampleRate` and `channelCount` are
 * delivered as asked where `audioInput`'s `resample` feature is true —
 * `{ sampleRate: 16000, channelCount: 1 }` for a speech model. */
export interface AudioTrackConstraints {
  deviceId?: ConstrainString;
  groupId?: ConstrainString;
  sampleRate?: ConstrainNumber;
  sampleSize?: ConstrainNumber;
  channelCount?: ConstrainNumber;
  latency?: ConstrainNumber;
  echoCancellation?: ConstrainBoolean;
  autoGainControl?: ConstrainBoolean;
  noiseSuppression?: ConstrainBoolean;
}

export type MediaTrackConstraints = VideoTrackConstraints &
  AudioTrackConstraints;

/** What `getUserMedia` asks for: `true` for a kind at its defaults. */
export interface MediaStreamConstraints {
  video?: boolean | VideoTrackConstraints;
  audio?: boolean | AudioTrackConstraints;
}

/** A device, as `enumerateDevices` and `useMediaDevices` list it. Names are
 * there before any permission, and ids are the same next launch. */
export interface MediaDeviceInfo {
  readonly deviceId: string;
  /** Shared by the devices of one piece of hardware, where the platform
   * says; `''` otherwise. */
  readonly groupId: string;
  readonly kind: MediaDeviceKind;
  readonly label: string;
  readonly isDefault: boolean;
  readonly capabilities: MediaTrackCapabilities;
}

/** One frame of video off a track: `VideoFrames.push`'s shape. The planes
 * are the source's until the next frame; what keeps one copies it. */
export interface MediaVideoFrame {
  format: VideoFormat;
  width: number;
  height: number;
  planes: Uint8Array[];
  strides: number[];
  /** Seconds, on the source's clock. */
  time: number;
  colorSpace: VideoColorSpace;
  range: VideoRange;
}

/** A chunk of audio off a track: planar floats from -1 to 1, a channel an
 * array. Read until the next chunk. */
export interface MediaAudioData {
  sampleRate: number;
  channels: Float32Array[];
  frames: number;
  /** Seconds, on the source's clock. */
  time: number;
}

/** One kind of media from one source. Made by `getUserMedia`,
 * `getDisplayMedia` and `clone()`, never constructed by an app. */
export class MediaStreamTrack {
  private constructor();
  readonly id: string;
  readonly kind: 'video' | 'audio';
  readonly label: string;
  readonly readyState: 'live' | 'ended';
  /** The source gives nothing for now — the camera taken by another app,
   * the lid closed. Not the app's to set. */
  readonly muted: boolean;
  /** False: no frames reach `onFrame`, and an element showing it shows
   * nothing. The source keeps running. */
  enabled: boolean;
  getSettings(): MediaTrackSettings;
  getCapabilities(): MediaTrackCapabilities;
  getConstraints(): MediaTrackConstraints;
  /** Moves the track to the source that runs at these settings. Rejects
   * with `OverconstrainedError` and changes nothing where a requirement
   * cannot be met. */
  applyConstraints(constraints?: MediaTrackConstraints): Promise<void>;
  /** Ends it, and the source with it where this was the last track over
   * it. */
  stop(): void;
  /** Another track over the same source. */
  clone(): MediaStreamTrack;
  /** Frames while it is live, enabled and not muted — the newest video
   * frame, every audio chunk. Answers the unsubscribe. */
  onFrame(fn: (frame: MediaVideoFrame & MediaAudioData) => void): () => void;
  /** `readyState`, `muted`, `enabled` or the settings changed. Answers the
   * unsubscribe. */
  onChange(fn: () => void): () => void;
}

/** A set of tracks: what `getUserMedia` resolves with, and what
 * `<video srcObject>` and `<audio srcObject>` take. */
export class MediaStream {
  constructor(tracks?: MediaStreamTrack[] | MediaStream);
  readonly id: string;
  /** Whether any track is live. */
  readonly active: boolean;
  getTracks(): MediaStreamTrack[];
  getVideoTracks(): MediaStreamTrack[];
  getAudioTracks(): MediaStreamTrack[];
  getTrackById(id: string): MediaStreamTrack | null;
  addTrack(track: MediaStreamTrack): void;
  removeTrack(track: MediaStreamTrack): void;
  clone(): MediaStream;
  /** A track added or removed, or one of them changed. Answers the
   * unsubscribe. */
  onChange(fn: () => void): () => void;
}

/** A required constraint no device can meet, named by `constraint`. A
 * `DOMException` at runtime, as a browser's is. */
export class OverconstrainedError extends Error {
  readonly name: 'OverconstrainedError';
  readonly constraint: string;
}

/** Which app to ask, where a process has more than one. */
export interface MediaCaptureOptions {
  app?: unknown;
  /** Aborts a request still waiting: it rejects with `AbortError`. */
  signal?: { readonly aborted: boolean };
}

/** The cameras, microphones and speakers there are now; `[]` where nothing
 * can list them. */
export declare function enumerateDevices(options?: {
  app?: unknown;
}): Promise<MediaDeviceInfo[]>;

/** `fn` whenever a device comes or goes; answers the unsubscribe. */
export declare function watchDevices(
  fn: () => void,
  options?: { app?: unknown },
): () => void;

/**
 * A camera, a microphone or both. Rejects with a `DOMException` named as a
 * browser's: `NotFoundError`, `NotAllowedError`, `NotReadableError`,
 * `AbortError` — or an {@link OverconstrainedError}.
 */
export declare function getUserMedia(
  constraints: MediaStreamConstraints,
  options?: MediaCaptureOptions,
): Promise<MediaStream>;

/** A screen or a window `displaySources` listed. */
export interface DisplaySource {
  id: string;
  kind: 'screen' | 'window';
  name: string;
  primary?: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Straight RGBA, no larger than asked; where `thumbnail` was asked and
   * `features.thumbnails` is true. */
  thumbnail?: { width: number; height: number; data: Uint8ClampedArray } | null;
}

/** The screens and windows there are to capture, where the display lets
 * them be listed (`features.enumerate`); `[]` otherwise. */
export declare function displaySources(options?: {
  app?: unknown;
  types?: ('screen' | 'window')[];
  thumbnail?: { width: number; height: number };
}): Promise<DisplaySource[]>;

/** What `getDisplayMedia` asks for. */
export interface DisplayMediaRequest {
  video?: true | { frameRate?: number; width?: number; height?: number };
  /** The system's sound, best effort: a stream without an audio track is
   * the answer where the display cannot give it. */
  audio?: false | 'system';
  /** A `displaySources()` id: no picker. */
  source?: string;
}

/** A screen or a window. Shows the system picker where there is one; a
 * user who chooses nothing rejects it with `NotAllowedError`. */
export declare function getDisplayMedia(
  request?: DisplayMediaRequest,
  options?: { app?: unknown },
): Promise<MediaStream>;

/** One picture of the screen. */
export interface Screenshot {
  width: number;
  height: number;
  /** Straight RGBA, `getImageData`'s shape. */
  data: Uint8ClampedArray;
  /** The same, as a PNG file's bytes (a `Buffer`). */
  png(): Uint8Array;
}

/** A screen, a window or a part of one, read once. */
export declare function captureScreenshot(options?: {
  app?: unknown;
  /** A `displaySources()` id; the primary screen when left out. */
  source?: string;
  /** Within the source, in its own pixels. */
  region?: { x: number; y: number; width: number; height: number };
  /** Draw the pointer in, where the display can. */
  cursor?: boolean;
}): Promise<Screenshot>;

/** Nothing on this display can play audio. */
export class NoAudioOutputError extends Error {
  readonly name: 'NoAudioOutputError';
  readonly code: 'ENOAUDIOOUTPUT';
}

export interface AudioFramesOptions {
  /** Samples a second; 48000 when left out. A sink does not resample. */
  sampleRate?: number;
  /** 2 when left out. */
  channels?: number;
  /** An `audiooutput` device's id; the default output when left out. */
  deviceId?: string;
}

/** Where audio goes to be heard: planar floats, queued, nothing dropped. */
export class AudioFrames {
  readonly sampleRate: number;
  readonly channels: number;
  readonly closed: boolean;
  /** Seconds the device has played, by its own clock. */
  readonly currentTime: number;
  /** Seconds from leaving the queue to being heard. */
  readonly latency: number;
  /** Seconds pushed and not yet played. */
  readonly queued: number;
  /** One `Float32Array` a channel, or `{ channels, frames, sampleRate }` as
   * a microphone's chunks arrive. Copied before it returns. */
  push(
    data:
      | Float32Array[]
      | { channels: Float32Array[]; frames?: number; sampleRate?: number },
  ): void;
  close(): void;
}

/** A sink on the system's output. Throws {@link NoAudioOutputError} where
 * there is none. */
export declare function createAudioFrames(
  app: unknown,
  options?: AudioFramesOptions,
): AudioFrames;

/** {@link useMediaDevices}' answer. */
export interface MediaDevicesState {
  readonly devices: readonly MediaDeviceInfo[];
  readonly cameras: readonly MediaDeviceInfo[];
  readonly microphones: readonly MediaDeviceInfo[];
  readonly speakers: readonly MediaDeviceInfo[];
  /** False on the first frame, until the list has been read. */
  readonly settled: boolean;
}

/** The devices there are, kept current as they come and go. */
export declare function useMediaDevices(): MediaDevicesState;

/** What a stream request is doing, as render state. */
export type MediaStatus =
  | 'idle'
  | 'prompt'
  | 'pending'
  | 'live'
  | 'denied'
  | 'unavailable'
  | 'error'
  | 'ended';

/** {@link useUserMedia}'s and {@link useDisplayMedia}'s answer. */
export interface MediaRequestState {
  readonly status: MediaStatus;
  /** While `'live'`, and `'ended'`. */
  readonly stream: MediaStream | null;
  /** While `'denied'`, `'unavailable'` or `'error'`. */
  readonly error: Error | null;
  start(): void;
  stop(): void;
}

/** A camera, a microphone or both, opened when the component mounts and
 * again when the constraints change; `{ start: false }` waits for
 * `start()`. The tracks stop when it unmounts. */
export declare function useUserMedia(
  constraints: MediaStreamConstraints,
  options?: { start?: boolean },
): MediaRequestState;

/** A screen or a window, opened on `start()` — or on mount with
 * `{ start: true }`. */
export declare function useDisplayMedia(
  request?: DisplayMediaRequest,
  options?: { start?: boolean },
): MediaRequestState;

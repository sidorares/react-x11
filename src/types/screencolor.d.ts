/**
 * Sampling a colour from the screen — the eyedropper. See docs/eyedropper.md.
 */

import type { AbortSignalLike, WindowTarget } from './filedialog.js';
import type { NtkApp } from './nodes.js';

/** Which rung of the ladder answered — or would. */
export type ScreenColorBackend = 'cocoa' | 'portal' | 'x11';

export interface PickScreenColorOptions {
  /**
   * The window the picker belongs to — `parent_window` for the portal, and
   * (when it points at a mounted node) the app the cocoa rung samples
   * through or the connection the X11 rung grabs on. `useEyedropper()`
   * infers it from the tree.
   */
  parentWindow?: WindowTarget;
  /** Abort the pick. Closes the portal request, or releases the X11 grab —
   * the grab is released **before** the rejection is reported. On the cocoa
   * rung it ends the wait only: `NSColorSampler` cannot be dismissed from
   * code, so the loupe stays up until the user answers it. */
  signal?: AbortSignalLike;
  /** Force a rung, for kiosks and for tests. */
  backend?: ScreenColorBackend;
  /**
   * The app a pick runs through: the cocoa rung's `colorSampler`, or the
   * connection the X11 rung grabs and reads on. Required for either rung
   * when `parentWindow` does not resolve to a mounted node — the hook passes
   * the tree's own.
   */
  app?: NtkApp;
}

/**
 * Nothing here can sample the screen, and nothing can be drawn instead. A
 * **typed** rejection — the `NoFileDialogError` rule — so a caller hides its
 * eyedropper button rather than crashing; `useEyedropper().supported` is
 * that branch made render state.
 */
export declare class NoScreenColorError extends Error {
  readonly name: 'NoScreenColorError';
  readonly cause?: unknown;
}

/**
 * Sample one pixel from the screen: the system's own picker where there is
 * one — `NSColorSampler` on the cocoa backend (`@windowkit/appkit` >= 0.9),
 * `org.freedesktop.portal.Screenshot.PickColor` (Screenshot interface
 * version 2) on a desktop that has it — and a crosshair pointer grab on
 * plain X11 everywhere else.
 *
 * Resolves to `'#rrggbb'`, or `null` when the user cancelled — Escape on the
 * X11 rung, the dialog's own cancel on the portal, a dismissed sampler on
 * cocoa. Rejects with {@link NoScreenColorError} when no rung is reachable.
 */
export declare function pickScreenColor(
  options?: PickScreenColorOptions,
): Promise<string | null>;

/**
 * Which rung this machine lands on, without showing or grabbing anything.
 * `'cocoa'` and `'x11'` both need an app to answer through — pass `app`, or
 * a `parentWindow` pointing at a mounted node — and `null` means
 * {@link pickScreenColor} would reject.
 */
export declare function screenColorBackend(
  options?: Pick<PickScreenColorOptions, 'app' | 'backend' | 'parentWindow'>,
): Promise<ScreenColorBackend | null>;

export interface Eyedropper {
  /**
   * Start a pick. `'#rrggbb'`, or `null` when cancelled. While one is in
   * flight, another call returns the **same promise** rather than queueing a
   * second grab.
   */
  pick(options?: Omit<PickScreenColorOptions, 'app'>): Promise<string | null>;
  /** `screenColorBackend()` resolved, for hiding or disabling the button. */
  supported: boolean;
  /** A pick is in flight — the button's pressed state. */
  picking: boolean;
}

/**
 * The eyedropper for a component: the tree's connection and owner window
 * bound once, `picking` and `supported` as render state.
 */
export declare function useEyedropper(
  defaults?: Omit<PickScreenColorOptions, 'app'>,
): Eyedropper;

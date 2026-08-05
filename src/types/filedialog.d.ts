/**
 * The file dialog and the portal machinery under it. See docs/filedialog.md.
 */

import type { ReactNode, RefObject } from 'react';
import type { MessageBus } from './dbus.js';
import type { DrawnNode, NtkWindow } from './nodes.js';

/**
 * The shape of `AbortSignal` this uses.
 *
 * Named structurally rather than reaching for the global: these declarations
 * compile with `types: []` and no `DOM` lib — adding `DOM` to get one name
 * would also make `<div>` legal JSX, which owning the element namespace exists
 * to prevent. A real `AbortSignal` satisfies this.
 */
export interface AbortSignalLike {
  readonly aborted: boolean;
  readonly reason?: unknown;
  addEventListener(
    type: 'abort',
    listener: () => void,
    options?: { once?: boolean },
  ): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

/** Which rung of the ladder answered — or would. */
export type FileDialogBackend = 'portal' | 'osascript' | 'builtin';

/**
 * One entry in a dialog's type filter.
 *
 * Give `extensions` where you can: they translate to every backend. MIME types
 * reach the portal exactly and macOS not at all — see docs/filedialog.md.
 */
export interface FileFilter {
  name: string;
  /** `['png', 'jpg']` — with or without the leading dot. */
  extensions?: string[];
  /** `['image/png']`. Portal only. */
  mimeTypes?: string[];
}

/** Anything a `<window>`/`<popup>` ref or XID can be given as. */
export type WindowTarget =
  | NtkWindow
  | DrawnNode
  | RefObject<NtkWindow | DrawnNode | null>
  | number
  | null;

export interface FileDialogOptions {
  title?: string;
  /** Several files at once. Ignored when saving — that is always one file. */
  multiple?: boolean;
  filters?: FileFilter[];
  /** Where the dialog opens. */
  defaultFolder?: string;
  /** The name a save dialog starts with. */
  defaultName?: string;
  /** The file a save dialog starts on, replacing `defaultName`. */
  defaultPath?: string;
  /** The confirm button's text — 'Import', 'Attach', … */
  acceptLabel?: string;
  /**
   * The window the dialog belongs to. `transientFor` for the built-in dialog,
   * `parent_window` for the portal; macOS has no cross-process equivalent and
   * ignores it. Worth the one line — without it the dialog floats.
   */
  parentWindow?: WindowTarget;
  /** Abort the dialog. Closes the portal request or kills `osascript`. */
  signal?: AbortSignalLike;
  /**
   * Force a rung instead of taking the best available one. The seam for a
   * kiosk that must never show the desktop's dialog, and for tests.
   */
  backend?: FileDialogBackend;
  /** `false` lets the portal dialog be non-modal. Default `true`. */
  modal?: boolean;
}

/**
 * Nothing on this machine can show a file dialog, and the caller cannot draw
 * one either. A **typed** rejection, so it reads as "fall back to your own UI"
 * rather than as a crash — {@link useFileDialog} never throws it, because it
 * has a tree to draw in.
 */
export declare class NoFileDialogError extends Error {
  readonly name: 'NoFileDialogError';
  readonly cause?: unknown;
}

/** There is no portal here — no bus, no service, or a version too old. */
export declare class NoPortalError extends Error {
  readonly name: 'NoPortalError';
  readonly cause?: unknown;
}

/** The user dismissed the dialog. Surfaced as `null`, not thrown, by the
 * functions below; exported for code driving {@link portalRequest} directly. */
export declare class PortalCancelledError extends Error {
  readonly name: 'PortalCancelledError';
  /** 1 when the user cancelled, 2 when it ended some other way. */
  readonly response: number;
}

/**
 * Which rung this machine lands on, without showing anything.
 *
 * Acquires a bus reference and releases it, so it is cheap but not free —
 * cache it rather than calling it on a render path.
 */
export declare function fileDialogBackend(): Promise<FileDialogBackend>;

/**
 * Ask for existing files. Resolves to absolute paths, or `null` when the user
 * cancelled.
 *
 * Rejects with {@link NoFileDialogError} where there is no portal and no
 * `osascript`; {@link useFileDialog} draws its own dialog instead.
 */
export declare function openFile(
  options?: FileDialogOptions,
): Promise<string[] | null>;

/** Ask where to write a file. One absolute path, which need not exist yet. */
export declare function saveFile(
  options?: FileDialogOptions,
): Promise<string | null>;

/** Ask for directories. Absolute paths, or `null` when cancelled. */
export declare function selectFolder(
  options?: FileDialogOptions,
): Promise<string[] | null>;

export interface FileDialogs {
  openFile(options?: FileDialogOptions): Promise<string[] | null>;
  saveFile(options?: FileDialogOptions): Promise<string | null>;
  selectFolder(options?: FileDialogOptions): Promise<string[] | null>;
}

/**
 * File dialogs that never run out of rungs: the desktop's own where there is
 * one, `osascript` on macOS, and a browser react-x11 draws itself everywhere
 * else. Cancelling resolves to `null` on all three.
 *
 * ```tsx
 * const { openFile } = useFileDialog({ parentWindow: windowRef });
 * const files = await openFile({ filters: [{ name: 'Text', extensions: ['txt'] }] });
 * if (files) load(files[0]);
 * ```
 */
export declare function useFileDialog(
  defaults?: FileDialogOptions,
): FileDialogs;

export interface FileDialogProps {
  kind?: 'open' | 'save' | 'folder';
  title?: string;
  startFolder?: string;
  defaultName?: string;
  filters?: FileFilter[];
  multiple?: boolean;
  acceptLabel?: string;
  /** An XID. Resolved for you when this is rendered by `useFileDialog()`. */
  parentWindow?: number;
  /** Called exactly once: the chosen paths, or `null` for cancel. */
  onDone?: (paths: string[] | null) => void;
  /** The palette, for when this is rendered on a root with no provider. */
  theme?: Record<string, unknown>;
  width?: number;
  height?: number;
}

/**
 * The built-in file browser, as a component. `useFileDialog()` renders this
 * for you; reach for it directly only when this dialog is the one you want
 * regardless of what the desktop offers.
 */
export declare function FileDialog(props: FileDialogProps): ReactNode;

// ---------------------------------------------------------------------------
// The portal floor
// ---------------------------------------------------------------------------

/**
 * Is `name` reachable — owned now, **or activatable on demand**?
 *
 * `NameHasOwner` is the wrong question: `org.freedesktop.portal.Desktop` is
 * D-Bus-activatable, so on a healthy desktop where no app has touched a portal
 * yet it has no owner, and a feature gated on that takes the fallback path
 * forever.
 */
export declare function hasService(
  name: string,
  busRef?: { bus: MessageBus; uniqueName: string },
): Promise<boolean>;

export interface PortalRequestOptions {
  iface: string;
  member: string;
  /** `'x11:1a00007'`, or `''` for none. */
  parentWindow?: string;
  title?: string;
  options?: Record<string, unknown>;
  signal?: AbortSignalLike;
}

/**
 * Call a portal method that answers through a `Request`, with the
 * subscription in place **before** the call goes out — which is the whole
 * reason this exists rather than each portal doing it slightly wrong.
 *
 * There is deliberately no timeout on the answer: a dialog can be open for an
 * hour. Only the initial call is deadlined.
 */
export declare function portalRequest(
  busRef: { bus: MessageBus; uniqueName: string },
  options: PortalRequestOptions,
): Promise<{ response: number; results: Record<string, unknown> }>;

/**
 * The Windows taskbar's own surfaces. See docs/windows-integrations.md.
 *
 * Three things the taskbar has that no other desktop does, so none of them is
 * a rung on an existing ladder. They are reported as features of the
 * **launcher** — `useDesktopCapability('launcher').features.thumbnailToolbar`
 * and its two siblings — because all of them hang off the one icon the
 * desktop shows for this app, beside the badge and the progress bar. The
 * hooks do nothing where the backend has none, so they are safe to call
 * unconditionally and an app needs no platform check.
 */

/**
 * An icon for a toolbar button: raw RGBA with its size, an ntk `Image`, or a
 * path to a file. The shell tints it for the theme, so the shape is the whole
 * of it and a white glyph on transparent is the usual choice.
 */
export type TaskbarIcon =
  | string
  | { data: Uint8Array; width: number; height: number }
  | { width: number; height: number };

export interface ThumbnailToolbarButton {
  /** What a click is reported as. Not the shell's index. */
  id: string;
  /** The hover tooltip; `label` is accepted as a synonym. */
  tooltip?: string;
  label?: string;
  icon?: TaskbarIcon | null;
  /** Default true. A disabled button is shown greyed rather than hidden. */
  enabled?: boolean;
  /** Close the hover preview when this one is clicked. */
  dismissOnClick?: boolean;
}

/**
 * Up to seven buttons under this window's taskbar hover preview — where a
 * media player puts play and skip. `null` hides them, which is as far down as
 * the shell allows: a window that has had a toolbar keeps one.
 *
 * The eighth button and beyond are dropped rather than refused, because the
 * shell refuses the whole call for an eighth.
 */
export declare function useThumbnailToolbar(
  buttons: readonly ThumbnailToolbarButton[] | null | undefined,
  onClick?: (id: string, event: unknown) => void,
): void;

export interface JumpListTask {
  title: string;
  /** Passed to a **new** process; nothing calls back into this one. */
  arguments?: string;
  description?: string;
}

/**
 * The Tasks category of this application's jump list — the menu on a right
 * click of its taskbar button. `null` deletes the category.
 *
 * Each entry **relaunches this executable** with the arguments given, which
 * is what a jump-list task is. That is why this is not `useLauncherMenu`, whose
 * items carry a callback: reported as `features.tasks` rather than
 * `features.menu`, so an app cannot mistake one for the other.
 */
export declare function useJumpList(
  tasks: readonly JumpListTask[] | null | undefined,
): void;

/** Notes `path` for the shell's Recent lists whenever it changes. */
export declare function useRecentDocument(path?: string | null): void;

/**
 * The imperative form of {@link useRecentDocument}. Returns false where the
 * backend has no Recent list, rather than throwing.
 */
export declare function noteRecentDocument(
  path: string | null,
  options?: { app?: unknown },
): boolean;

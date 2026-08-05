// Open, save, and pick a folder — through whatever this machine actually has.
//
// There is no one answer, so this is a ladder, tried in order:
//
//   1. **the portal** — `org.freedesktop.portal.FileChooser` over D-Bus. The
//      real desktop dialog, with the user's bookmarks and recent files, drawn
//      by GTK or KDE in another process. What a Linux desktop should get.
//   2. **`osascript`** — macOS with no portal, which is every XQuartz install
//      that has not gone out of its way. `choose file` is `NSOpenPanel`, so
//      the user gets the dialog they know.
//   3. **the built-in dialog** — a file browser drawn by react-x11 itself.
//      Reached over ssh, under a bare `startx`, in a container: everywhere
//      there is a display and nothing else. See `components/FileDialog.js`;
//      it needs a React tree, so `useFileDialog()` has it and the bare
//      functions here do not.
//
// The ladder is the whole design. A file dialog that only works on a full
// GNOME session would be useless to the person running this over ssh from a
// laptop, which is the case react-x11 exists for.
//
// ## What each rung cannot do
//
// - **The portal never embeds.** The dialog is a top-level window in another
//   process; all you get is logical parenting, through `parent_window`. That
//   is `transientFor` by another name, and it is why these calls want a window
//   to point at.
// - **macOS has no cross-process transient-for at all.** XQuartz windows are
//   `NSWindow`s owned by X11.app, and `addChildWindow` is same-process only.
//   So the panel appears over the app but is not attached to it. Application
//   modality still works, because the caller is awaiting the promise.
// - **The built-in dialog is ours**, so it is the only rung that can be
//   modal-and-parented properly — and the only one that has never seen the
//   user's bookmarks.

import {
  NoPortalError,
  PORTAL_NAME,
  PortalCancelledError,
  RESPONSE_CANCELLED,
  RESPONSE_OK,
  hasService,
  parentWindowHandle,
  pathBytes,
  portalRequest,
  variant,
} from './portal.js';
import { sessionBus } from './bus.js';
import { windowIdOf } from './windowid.js';

const FILE_CHOOSER = 'org.freedesktop.portal.FileChooser';

/**
 * Nothing on this machine can show a file dialog, and nothing here can draw
 * one either.
 *
 * Only the bare functions throw this — `useFileDialog()` has a tree to draw
 * in, so it never runs out of rungs. It is a **typed** rejection because it is
 * a fallback signal, not a crash: a caller that has its own UI branches on it.
 */
export class NoFileDialogError extends Error {
  constructor(cause) {
    super(
      'react-x11: no file dialog is available — there is no ' +
        'xdg-desktop-portal on the bus, and this is not macOS. Use ' +
        'useFileDialog() instead, which draws one, or supply `backend`.',
      { cause },
    );
    this.name = 'NoFileDialogError';
  }
}

export { PortalCancelledError };

// --------------------------------------------------------------------------
// Options, in one shape, translated per backend
// --------------------------------------------------------------------------

/**
 * `[{ name: 'Images', extensions: ['png', 'jpg'] }]` → the portal's
 * `a(sa(us))`: a list of (label, [(type, pattern)]) where type 0 is a glob and
 * 1 is a MIME type.
 *
 * Extensions are turned into globs here rather than asking callers for
 * `*.png`, because every other file-dialog API in the world takes extensions
 * and the glob is a portal implementation detail.
 */
function portalFilters(filters) {
  return filters.map((f) => [
    f.name ?? '',
    [
      ...(f.extensions ?? []).map((ext) => [
        0,
        `*.${String(ext).replace(/^[.*]*\.?/, '')}`,
      ]),
      ...(f.mimeTypes ?? []).map((type) => [1, type]),
    ],
  ]);
}

async function portalOptions(opts, { save, directory }) {
  const options = {};
  if (opts.acceptLabel) options.accept_label = opts.acceptLabel;
  if (opts.multiple && !save) options.multiple = true;
  if (directory) options.directory = true;
  if (opts.modal !== false) options.modal = true;
  if (opts.filters?.length) {
    options.filters = await variant('a(sa(us))', portalFilters(opts.filters));
  }
  // Paths are NUL-terminated byte arrays here, not strings. A string marshals
  // as `s` and the backend ignores it without saying so.
  if (opts.defaultFolder)
    options.current_folder = pathBytes(opts.defaultFolder);
  if (save && opts.defaultName) options.current_name = opts.defaultName;
  if (save && opts.defaultPath)
    options.current_file = pathBytes(opts.defaultPath);
  return options;
}

/** `file:///a/b%20c` → `/a/b c`. Anything not a file: URI is dropped. */
async function urisToPaths(uris) {
  const { fileURLToPath } = await import('node:url');
  const out = [];
  for (const uri of uris ?? []) {
    if (typeof uri !== 'string') continue;
    try {
      if (uri.startsWith('file://')) out.push(fileURLToPath(uri));
      else if (uri.startsWith('/')) out.push(uri);
    } catch {
      // a URI we cannot turn into a path is not one the caller can open
    }
  }
  return out;
}

// --------------------------------------------------------------------------
// Rung 1: the portal
// --------------------------------------------------------------------------

async function portalDialog(kind, opts, ref) {
  const member = kind === 'save' ? 'SaveFile' : 'OpenFile';
  const { response, results } = await portalRequest(ref, {
    iface: FILE_CHOOSER,
    member,
    parentWindow: parentWindowHandle(windowIdOf(opts.parentWindow)),
    title: opts.title ?? defaultTitle(kind),
    options: await portalOptions(opts, {
      save: kind === 'save',
      directory: kind === 'folder',
    }),
    signal: opts.signal,
  });
  if (response !== RESPONSE_OK) throw new PortalCancelledError(response);
  return urisToPaths(results?.uris);
}

// --------------------------------------------------------------------------
// Rung 2: osascript, on macOS
// --------------------------------------------------------------------------

/** AppleScript string literal. */
const as = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * The AppleScript for one dialog, as `-e` lines.
 *
 * Every branch normalises to newline-separated POSIX paths, so the caller
 * parses one shape. `choose file` hands back an alias and `choose file name` a
 * file reference that need not exist yet; `POSIX path of` works on both.
 */
export function osascriptLines(kind, opts = {}) {
  const title = opts.title ?? defaultTitle(kind);
  const parts = [];

  if (kind === 'save') {
    parts.push(`set theFiles to choose file name with prompt ${as(title)}`);
    if (opts.defaultName) parts.push(`default name ${as(opts.defaultName)}`);
    if (opts.defaultFolder) {
      parts.push(`default location POSIX file ${as(opts.defaultFolder)}`);
    }
  } else if (kind === 'folder') {
    parts.push(`set theFiles to choose folder with prompt ${as(title)}`);
    if (opts.defaultFolder) {
      parts.push(`default location POSIX file ${as(opts.defaultFolder)}`);
    }
    // `with …` flags go last: AppleScript is tolerant about the order of
    // labelled parameters and conventional about this one, and the failure
    // mode of getting it wrong is a syntax error at the far end of a pipe
    // where nobody is looking.
    if (opts.multiple) parts.push('with multiple selections allowed');
  } else {
    parts.push(`set theFiles to choose file with prompt ${as(title)}`);
    // Extensions map exactly; MIME types do not, and guessing a UTI wrong
    // hides the user's file with no way to get at it. So MIME-only filters
    // mean no type restriction here rather than the wrong one — noted in
    // docs/filedialog.md as the one place the backends genuinely differ.
    const extensions = (opts.filters ?? [])
      .flatMap((f) => f.extensions ?? [])
      .map((e) => String(e).replace(/^[.*]*\.?/, ''))
      .filter(Boolean);
    if (extensions.length) {
      parts.push(`of type {${[...new Set(extensions)].map(as).join(', ')}}`);
    }
    if (opts.defaultFolder) {
      parts.push(`default location POSIX file ${as(opts.defaultFolder)}`);
    }
    if (opts.multiple) parts.push('with multiple selections allowed');
  }

  return [
    parts.join(' '),
    'if class of theFiles is not list then set theFiles to {theFiles}',
    'set out to ""',
    'repeat with f in theFiles',
    'set out to out & POSIX path of f & linefeed',
    'end repeat',
    'return out',
  ].flatMap((line) => ['-e', line]);
}

async function osascriptDialog(kind, opts) {
  const { execFile } = await import('node:child_process');
  const args = osascriptLines(kind, opts);
  return new Promise((resolve, reject) => {
    const child = execFile(
      'osascript',
      args,
      { encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          if (error.code === 'ENOENT') {
            return reject(new NoFileDialogError(error));
          }
          // AppleScript reports a cancel as -128, which is an ordinary
          // outcome and must not read as a failure.
          if (/-128/.test(stderr) || /User canceled/i.test(stderr)) {
            return reject(new PortalCancelledError(RESPONSE_CANCELLED));
          }
          return reject(
            new Error(
              `react-x11: the macOS file dialog failed — ${stderr.trim() || error.message}`,
              { cause: error },
            ),
          );
        }
        resolve(
          stdout
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean),
        );
      },
    );
    // An abort has to reach the panel; killing osascript closes it.
    opts.signal?.addEventListener('abort', () => child.kill(), { once: true });
  });
}

// --------------------------------------------------------------------------
// Choosing a rung
// --------------------------------------------------------------------------

function defaultTitle(kind) {
  return kind === 'save'
    ? 'Save file'
    : kind === 'folder'
      ? 'Select folder'
      : 'Open file';
}

/**
 * Which rung this machine lands on, without showing anything.
 *
 * Useful for a menu that wants to say "Open…" versus "Open (built-in)…", and
 * for the tests. It acquires a bus ref and releases it, so it is cheap to call
 * but not free — cache it if it is on a render path.
 *
 * @returns {Promise<'portal'|'osascript'|'builtin'>}
 */
export async function fileDialogBackend() {
  const ref = await sessionBus();
  if (ref) {
    try {
      if (await hasService(PORTAL_NAME, ref)) return 'portal';
    } finally {
      await ref.release();
    }
  }
  if (process.platform === 'darwin') return 'osascript';
  return 'builtin';
}

/**
 * Run one dialog on the best rung that is not the built-in one.
 *
 * Split out so `useFileDialog()` can try exactly this and fall through to its
 * own dialog, without duplicating the ladder or the option translation.
 */
export async function runNativeDialog(kind, opts = {}) {
  if (opts.backend === 'builtin') throw new NoFileDialogError();

  const wantPortal = !opts.backend || opts.backend === 'portal';
  if (wantPortal) {
    const ref = await sessionBus();
    if (ref) {
      try {
        if (await hasService(PORTAL_NAME, ref)) {
          return await portalDialog(kind, opts, ref);
        }
      } finally {
        await ref.release();
      }
    }
    if (opts.backend === 'portal') {
      throw new NoPortalError('no xdg-desktop-portal on the session bus');
    }
  }

  const wantOsascript = !opts.backend || opts.backend === 'osascript';
  if (wantOsascript && (process.platform === 'darwin' || opts.backend)) {
    return await osascriptDialog(kind, opts);
  }

  throw new NoFileDialogError();
}

/**
 * Ask for one or more existing files.
 *
 * ```js
 * const files = await openFile({ multiple: true, filters: [
 *   { name: 'Images', extensions: ['png', 'jpg'] },
 * ]});
 * if (!files) return;              // cancelled
 * ```
 *
 * Resolves to **absolute paths**, or `null` when the user cancelled —
 * cancelling is an ordinary outcome and should not need a `try`. Rejects with
 * {@link NoFileDialogError} when there is no portal and no `osascript`, which
 * is the signal to draw your own; {@link useFileDialog} does that for you.
 *
 * @returns {Promise<string[] | null>}
 */
export function openFile(options) {
  return cancellable('open', options);
}

/**
 * Ask where to write a file. Resolves to one **absolute path** — which need
 * not exist yet — or `null` when the user cancelled.
 *
 * @returns {Promise<string | null>}
 */
export async function saveFile(options) {
  const paths = await cancellable('save', options);
  return paths ? (paths[0] ?? null) : null;
}

/**
 * Ask for a directory. Resolves to absolute paths, or `null` when cancelled.
 *
 * @returns {Promise<string[] | null>}
 */
export function selectFolder(options) {
  return cancellable('folder', options);
}

/** Cancellation is an answer, not an error. Everything else propagates. */
async function cancellable(kind, options = {}) {
  try {
    return await runNativeDialog(kind, options);
  } catch (err) {
    if (err instanceof PortalCancelledError) return null;
    throw err;
  }
}

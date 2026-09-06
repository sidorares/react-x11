// Native file panels on the cocoa backend — `NSOpenPanel` / `NSSavePanel`
// through @windowkit/appkit (>= 0.5), the top rung of src/filedialog.js's
// ladder on this backend.
//
// The panel belongs to this process's NSApplication, which is what the
// `osascript` rung could never be: it runs as a **sheet** on the window that
// asked, every filter the OS type database knows gets through (a MIME type
// as much as an extension), and a cancel is a cancel rather than a failed
// subprocess. `CocoaApp.filePanels` is this object, and its *presence* is
// the capability the ladder tests for — the same rule `nativeBezels` and
// `raiseWindow` follow, so the ladder itself never names a backend.
//
// Two things about the bridge's contract shape the code here:
//
// - **With a window handle the panel is a sheet** and the call returns at
//   once; the callback lands through the pump on a later tick, like a menu
//   activation. **Without one it is app-modal** — `runModal` parks the
//   thread inside AppKit's loop until the panel is dismissed, and the
//   callback runs before the call returns. Timers do not tick meanwhile.
//   That is the fallback, not the design: `useFileDialog()` always names
//   its window, and the bare functions want `parentWindow` for this reason.
// - **A destroyed owner ends its sheet with a cancel**, natively — the
//   bridge answers any panel still attached to a window `destroyWindow2`
//   takes down — so a promise here is never left pending by an unmount.
import path from 'node:path';

import { PortalCancelledError, RESPONSE_CANCELLED } from '../portal.js';

/** Extensions arrive with or without a dot, and sometimes as a glob. */
const bareExtension = (ext) => String(ext).replace(/^[.*]*\.?/, '');

/**
 * react-x11's dialog options as the bridge's panel spec.
 *
 * `contentTypeFor({ extension } | { mime })` is the bridge's lookup in the
 * OS's own type database — `'png'` → `'public.png'`, `'application/json'` →
 * `'public.json'`, an undeclared extension a dynamic type that matches
 * exactly it — injected so the translation is a pure function the tests can
 * pin. A lookup that answers nothing drops that entry; a filter list the OS
 * recognises nothing of means no filter, which is also what an absent one
 * means.
 *
 * Only a title the caller gave becomes the panel's `message` (the line
 * above the file list): the panel already says Open or Save on its own,
 * and the ladder's default title would be a second copy of it.
 */
export function panelSpec(kind, opts = {}, contentTypeFor = () => null) {
  const spec = {};
  if (opts.title) {
    spec.title = opts.title;
    spec.message = opts.title;
  }
  if (opts.acceptLabel) spec.prompt = opts.acceptLabel;
  if (opts.defaultFolder) spec.directoryURL = opts.defaultFolder;

  if (kind === 'save') {
    spec.canCreateDirectories = true;
    if (opts.defaultPath) {
      // `defaultPath` names a file that need not exist yet: the panel opens
      // in its directory with its name filled in, which is the portal's
      // `current_file` by other means
      spec.directoryURL = path.dirname(opts.defaultPath);
      spec.nameFieldStringValue = path.basename(opts.defaultPath);
    } else if (opts.defaultName) {
      spec.nameFieldStringValue = opts.defaultName;
    }
  } else {
    spec.multiple = Boolean(opts.multiple);
    if (kind === 'folder') {
      spec.directory = true;
      spec.canCreateDirectories = true;
    }
  }

  if (kind !== 'folder') {
    const types = [];
    for (const filter of opts.filters ?? []) {
      for (const ext of filter.extensions ?? []) {
        const extension = bareExtension(ext);
        if (extension) types.push(contentTypeFor({ extension }));
      }
      for (const mime of filter.mimeTypes ?? []) {
        types.push(contentTypeFor({ mime: String(mime) }));
      }
    }
    const known = [...new Set(types.filter((t) => typeof t === 'string' && t))];
    if (known.length) spec.allowedContentTypes = known;
  }
  return spec;
}

export class CocoaFilePanels {
  constructor(app) {
    this.app = app;
  }

  /**
   * Show one panel and resolve with what the user chose, in the ladder's own
   * shape: absolute paths (a save answers one, still in a list), a
   * `PortalCancelledError` for a cancel (which `openFile` and the hook turn
   * into `null`), and an abort's own reason when the caller's `signal` fired
   * — the same three outcomes the portal rung has, so nothing above this
   * can tell the rungs apart.
   *
   * `wnd` is the `CocoaWindow` the panel is a sheet on, or null for
   * app-modal (see the header).
   */
  show(kind, opts = {}, wnd = null) {
    const native = this.app._native;
    const signal = opts.signal;
    if (signal?.aborted) {
      return Promise.reject(
        signal.reason ?? new PortalCancelledError(RESPONSE_CANCELLED),
      );
    }
    const spec = panelSpec(kind, opts, (query) => native.contentTypeFor(query));
    if (wnd && !wnd.destroyed && wnd._h != null) spec.window = wnd._h;

    return new Promise((resolve, reject) => {
      let handle = null;
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        // dismissing the sheet makes the bridge answer the callback with
        // null, which `done` then ignores — the abort is the outcome
        if (handle != null) native.cancelPanel(handle);
        reject(signal.reason ?? new PortalCancelledError(RESPONSE_CANCELLED));
      };
      const done = (result) => {
        signal?.removeEventListener('abort', onAbort);
        if (settled) return;
        settled = true;
        if (result == null) {
          reject(new PortalCancelledError(RESPONSE_CANCELLED));
          return;
        }
        resolve(Array.isArray(result) ? result : [result]);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        // app-modal: this call blocks and `done` has already run by the
        // time it returns; a sheet: it returns at once with the handle
        handle = native[kind === 'save' ? 'savePanel' : 'openPanel'](
          spec,
          done,
        );
      } catch (err) {
        signal?.removeEventListener('abort', onAbort);
        settled = true;
        reject(err);
      }
    });
  }
}

// `useFileDialog()` — the file dialog with the bottom rung attached.
//
// The bare `openFile()` in `filedialog.js` can reach the portal and
// `osascript`, and rejects with `NoFileDialogError` when there is neither,
// because a function has nowhere to draw. A component does: this hook mounts
// the built-in browser on the connection the tree is already using, so the
// ladder never runs out and an app never needs a `catch` that renders a
// second dialog of its own.
//
// ## Why a second root rather than an element to render
//
// The obvious alternative is `const { open, dialog } = useFileDialog()` with
// `{dialog}` rendered somewhere — which is a documentation step for every app
// author, forever, and one that fails silently when forgotten: `open()` would
// resolve to nothing with no clue why.
//
// A file dialog is a **top-level window** on every other rung, so it is one
// here too: `createRoot({ app })` borrows the tree's own X connection (it
// never closes a borrowed one) and renders a real, window-manager-placed,
// `transientFor` dialog. Nothing to render, nothing to forget, and the same
// window on all three rungs.

import { useCallback, useMemo } from 'react';
import React from 'react';

import { FileDialog } from './components/FileDialog.js';
import { useTheme } from './components/theme.js';
import { NoFileDialogError, runNativeDialog } from './filedialog.js';
import { PortalCancelledError } from './portal.js';
import { useApp } from './appcontext.js';
import { createRoot } from './Reconciler.js';
import { windowIdOf } from './windowid.js';

/**
 * Show the built-in dialog on its own root, and resolve with what the user
 * chose. The root is torn down before the promise settles, so a caller that
 * opens a second dialog in the `.then()` never has two on screen.
 */
async function showBuiltin(app, theme, props) {
  const root = await createRoot({ app });
  try {
    return await new Promise((resolve) => {
      // `<FileDialog>` renders a `<window>`, and a window may only be a root
      // child or nested in another window — so the palette travels as a prop
      // and the dialog installs the provider *inside* its own window. Wrapping
      // it here in `<ThemeProvider>` would put a `<box>` between the root and
      // the window, which throws.
      root.render(
        React.createElement(FileDialog, { ...props, theme, onDone: resolve }),
      );
    });
  } finally {
    await root.unmount();
  }
}

/**
 * File dialogs, on the best rung this machine has.
 *
 * ```jsx
 * const { openFile, saveFile } = useFileDialog({ parentWindow: windowRef });
 *
 * <MenuBar onSelect={async (id) => {
 *   if (id === 'open') {
 *     const files = await openFile({ filters: [{ name: 'Text', extensions: ['txt', 'md'] }] });
 *     if (files) load(files[0]);       // null means the user cancelled
 *   }
 * }} />
 * ```
 *
 * `parentWindow` — a `<window>` ref or a raw XID — is what makes the dialog
 * behave like a dialog: `transientFor` for the built-in one, `parent_window`
 * for the portal. It is optional and worth the one line; without it the
 * dialog floats unparented, which is legal and looks careless.
 *
 * Every call resolves to `null` when the user cancels. That is an ordinary
 * outcome, not an exception, on all three rungs.
 */
export function useFileDialog(defaults = {}) {
  const app = useApp();
  const theme = useTheme();

  const run = useCallback(
    async (kind, options = {}) => {
      const opts = { ...defaults, ...options };
      try {
        return await runNativeDialog(kind, opts);
      } catch (err) {
        if (err instanceof PortalCancelledError) return null;
        if (!(err instanceof NoFileDialogError)) throw err;
        // The bottom rung. Reached over ssh, under startx, in a container —
        // and on any machine whose portal went away between calls.
        return showBuiltin(app, theme, {
          kind,
          title: opts.title,
          startFolder: opts.defaultFolder,
          defaultName: opts.defaultName,
          filters: opts.filters ?? [],
          multiple: !!opts.multiple && kind !== 'save',
          acceptLabel: opts.acceptLabel,
          parentWindow: windowIdOf(opts.parentWindow) ?? undefined,
        });
      }
    },
    // `defaults` is deliberately not a dependency: an app writes it inline, so
    // a new object every render would rebuild these callbacks every render and
    // defeat the memo below. It is read through the closure at call time,
    // which is when its values are actually wanted.
    [app, theme],
  );

  return useMemo(
    () => ({
      /** @returns {Promise<string[] | null>} absolute paths, or null if cancelled */
      openFile: (options) => run('open', options),
      /** @returns {Promise<string | null>} one absolute path, or null if cancelled */
      saveFile: async (options) => {
        const paths = await run('save', options);
        return paths ? (paths[0] ?? null) : null;
      },
      /** @returns {Promise<string[] | null>} absolute paths, or null if cancelled */
      selectFolder: (options) => run('folder', options),
    }),
    [run],
  );
}

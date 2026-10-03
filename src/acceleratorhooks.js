// The React lid on `accelerators.js`: `useAccelerator`, and the internal
// registration the menus are built on.
//
// Split from the matcher for the reason `fonthooks.js` is split from
// `fonts.js` — the half that has to be right about X11 and the half that has
// to be right about React have different failure modes, and only one of them
// can be tested without a tree.

import { useEffect, useMemo, useRef } from 'react';

import { matchesShortcut } from './accelerators.js';
import { useAppOrNull } from './appcontext.js';
import { primaryModifier } from './keysyms.js';
import { useTopLevelWindow } from './windowid.js';

/**
 * A binding whose anchor resolved to nothing binds nothing — there is no
 * event manager to register it with, and the effect runs once, so it will
 * not come back. Silent, that is a shortcut that simply never fires, with
 * the tree, the chord and the handler all looking correct (issue #616).
 *
 * Once per process, in development: the mistake is structural, and an app
 * that made it once made it for every chord it declares.
 */
let warnedAboutAnchor = false;
export function resetAcceleratorWarningForTests() {
  warnedAboutAnchor = false;
}

function warnUnanchored() {
  if (process.env.NODE_ENV === 'production' || warnedAboutAnchor) return;
  warnedAboutAnchor = true;
  console.warn(
    'react-x11: a shortcut was bound in a component with no window to hang ' +
      'it off, so it is bound to nothing and will never fire. By default a ' +
      "binding belongs to the tree's top-level <window> or, in an app with " +
      'none, the root-level <popup> holding the keyboard. Anchor it ' +
      'explicitly with `scope`:\n' +
      '  const here = useRef(null);\n' +
      "  useAccelerator([['space']], onToggle, { scope: here });\n" +
      '  return <box ref={here}>…</box>;',
  );
}

/**
 * Bind a chord for as long as this component is mounted, anchored at
 * `anchorRef` — the node the binding belongs to, which is what decides
 * whether it is on the screen and whether a modal has taken the keyboard
 * from it (`EventManager._runAccelerators`).
 *
 * `handle(ev)` returns whether it took the key.
 *
 * The handler is read from a ref rather than captured, and is deliberately
 * *not* a dependency: a chord pressed three minutes from now must run the
 * handler from the current render, and re-registering on every render would
 * also reorder the bindings under it.
 *
 * `reserves(ev)`, read the same way, says the key belongs to something
 * outside the window that answers it by itself — a delegated `MenuBar`'s
 * key equivalents on the Cocoa backend — so no binding gets it
 * (`EventManager._runAccelerators`).
 */
export function useAcceleratorEntry(
  anchorRef,
  handle,
  enabled = true,
  reserves = null,
) {
  const live = useRef({ handle, reserves });
  live.current = { handle, reserves };
  useEffect(() => {
    if (!enabled) return undefined;
    const manager = anchorRef.current?.root?.events;
    if (!manager) {
      warnUnanchored();
      return undefined;
    }
    return manager.registerAccelerator({
      anchor: () => anchorRef.current ?? null,
      handle: (ev) => live.current.handle?.(ev) ?? false,
      reserves: (ev) => live.current.reserves?.(ev) ?? false,
    });
  }, [anchorRef, enabled]);
}

/**
 * `useAccelerator([['Control', 'K']], () => openPalette())` — a shortcut that
 * is not in a menu.
 *
 * Same chord vocabulary as a menu item's `shortcut` and the same matching, so
 * a shortcut can be moved into or out of a menu without being rewritten, and
 * the same rules apply to it: exact on Control/Alt/Shift/Super, indifferent
 * to Caps Lock and Num Lock, matched against the Latin keysym so it survives
 * a layout switch, `Control` meaning ⌘ on the Cocoa backend
 * (`primaryModifier`), and behind whatever a focused element consumed with
 * `preventDefault()`.
 *
 * The handler is called with the key event, and the key is consumed.
 *
 * By default the binding belongs to the window the component is in, which is
 * what an application-wide shortcut wants — or, in an app with no `<window>`
 * at all, to the root-level `<popup>` that took the keyboard, which is the
 * whole of a tray popover's UI (`useTopLevelWindow`). Two options for when
 * that is not it: `enabled: false` unbinds it without unmounting anything,
 * and `scope` takes a ref to a node the binding hangs off instead — the way
 * to give a modal `<Dialog>` a shortcut of its own, since a binding on the
 * window behind it is one the modal has taken the keyboard from.
 */
export function useAccelerator(shortcut, handler, options = {}) {
  const { enabled = true, scope } = options;
  const owner = useTopLevelWindow();
  // `useTopLevelWindow` answers when it is read, so the fallback stays a
  // live getter rather than a node captured on the render that mounted.
  const anchorRef = useMemo(
    () =>
      scope ?? {
        get current() {
          return owner.current;
        },
      },
    [scope, owner],
  );
  const primary = primaryModifier(useAppOrNull());
  const live = useRef({ shortcut, handler, primary });
  live.current = { shortcut, handler, primary };
  useAcceleratorEntry(
    anchorRef,
    (ev) => {
      const { shortcut: chords, primary: mod } = live.current;
      if (!matchesShortcut(ev, chords, { primary: mod })) return false;
      live.current.handler?.(ev);
      return true;
    },
    enabled,
  );
}

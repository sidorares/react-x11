// The Windows taskbar's own surfaces, as hooks.
//
// Three things the taskbar has that no other desktop does, so none of them is
// a rung on an existing ladder and none of them pretends to be portable. What
// makes them safe to use anyway is that the answer to "is this here" is a
// value a component branches on — `useSupports('thumbnailToolbar')` — rather
// than a platform check, and the hooks below do nothing at all where the
// backend has not installed them. An app writes the same tree everywhere and
// gets the feature where it exists.
//
// ```jsx
// const canToolbar = useSupports('thumbnailToolbar');
// useThumbnailToolbar(
//   canToolbar ? [
//     { id: 'prev', tooltip: 'Previous', icon: prevIcon },
//     { id: 'play', tooltip: playing ? 'Pause' : 'Play', icon: playIcon },
//   ] : null,
//   (id) => transport(id),
// );
// ```
//
// The seam is one rule: the backend installs a method, and its presence is
// the capability (src/appcontext.js `FEATURES`). Nothing here knows what
// Windows is, and neither does anything in an app that uses it.
import { useEffect, useRef } from 'react';

import { useAppOrNull } from './appcontext.js';
import { liveApps } from './trace-registry.js';
import { useTopLevelWindow } from './windowid.js';

/** The app to act on when the caller did not say — the same rule the
 *  launcher's own imperative calls use. */
function soleApp() {
  const apps = liveApps();
  if (apps.length <= 1) return apps[0] ?? null;
  const showing = apps.filter((app) => (app._rootChildren ?? []).length > 0);
  return showing.length === 1 ? showing[0] : null;
}

/** The value a caller passed, read by an effect that must not re-run for it. */
function useLatest(value) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

/** A stable key for a button list, so an effect re-runs when one actually
 *  changed rather than on every render. Icons compare by identity — a caller
 *  holding its icons still is the fast path, and one that rebuilds them every
 *  render was going to re-upload them anyway. */
function signatureOf(buttons) {
  if (!buttons) return '';
  return buttons
    .map(
      (b) =>
        `${b.id ?? ''}\u0000${b.tooltip ?? b.label ?? ''}\u0000` +
        `${b.enabled === false ? 0 : 1}${b.dismissOnClick ? 1 : 0}`,
    )
    .join('\u0001');
}

/**
 * Up to seven buttons under this window's taskbar hover preview — where a
 * media player puts play and skip.
 *
 * `buttons` is `[{ id, tooltip, icon, enabled, dismissOnClick }]`, and `icon`
 * is whatever `useTray` takes: an ntk `Image`, raw RGBA with a size, or a
 * path. `null` takes the toolbar down as far as the shell allows, which is to
 * hide the buttons — a toolbar cannot be removed once the window has one, and
 * saying so is better than a call that looks like it worked.
 *
 * `onClick` is called with the button's own `id`.
 *
 * Does nothing where the backend has no toolbar. The eighth button and beyond
 * are dropped rather than refused, because the shell refuses the whole call
 * for an eighth and one silently missing button is a better outcome than a
 * toolbar that never appears.
 */
export function useThumbnailToolbar(buttons, onClick) {
  const app = useAppOrNull();
  const owner = useTopLevelWindow();
  const handler = useLatest(onClick);
  const latest = useLatest(buttons);
  const signature = signatureOf(buttons);

  useEffect(() => {
    if (typeof app?.thumbnailToolbar !== 'function') return;
    // Read inside the effect: `useTopLevelWindow` answers through a getter,
    // so the window a tree is in is whatever it is when the effect runs
    // rather than what it was at render.
    const wnd = owner?.current?.window;
    if (!wnd?.id) return;
    app.thumbnailToolbar(wnd.id, latest.current ?? []);

    const fire = (event) => handler.current?.(event.id, event);
    wnd.on?.('thumbbutton', fire);
    return () => {
      wnd.off?.('thumbbutton', fire);
      // Hidden rather than removed, which is all the shell offers.
      app.thumbnailToolbar(wnd.id, []);
    };
    // `signature` is the dependency; the buttons themselves are read through
    // a ref, so a new array holding the same buttons does not re-send them.
  }, [app, owner, signature, latest, handler]);
}

/**
 * The Tasks category of this application's jump list — the menu on a right
 * click of its taskbar button.
 *
 * `tasks` is `[{ title, arguments, description }]`. Each one **relaunches
 * this executable** with the arguments given, which is what a jump-list task
 * is: the shell starts the program, it does not call back into the running
 * one. An app that wants the running instance to answer needs the single
 * instance path, which is not built (docs/windows-integrations.md) — so until
 * then a task is for something the app can do from a cold start.
 *
 * `null` deletes the category.
 */
export function useJumpList(tasks) {
  const app = useAppOrNull();
  const signature = JSON.stringify(tasks ?? null);

  useEffect(() => {
    if (typeof app?.jumpList !== 'function') return;
    app.jumpList(tasks ?? []);
    return () => app.jumpList([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app, signature]);
}

/**
 * Note a document this app just opened, for the shell's Recent lists — the
 * jump list's own Recent section, and Explorer's quick access.
 *
 * The same act as macOS's `noteNewRecentDocumentURL:`; it lives here rather
 * than in a cross-platform hook because this is the only backend with one to
 * call today. Where the file type is not associated with this application the
 * shell may keep it and show it nowhere, which is its decision to make.
 *
 * `null` clears the list.
 */
export function noteRecentDocument(path, { app } = {}) {
  const target = app ?? soleApp();
  if (typeof target?.noteRecentDocument !== 'function') return false;
  target.noteRecentDocument(path);
  return true;
}

/** The hook form: notes `path` whenever it changes. */
export function useRecentDocument(path) {
  const app = useAppOrNull();
  useEffect(() => {
    if (typeof app?.noteRecentDocument !== 'function' || path == null) return;
    app.noteRecentDocument(path);
  }, [app, path]);
}
